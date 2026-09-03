'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsPromises = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');

const {
  LocalSermonLibrary,
  SERMON_EXTRACTION_PROPOSAL_KIND,
  SERMON_EXTRACTION_PROPOSAL_SCHEMA_VERSION,
  SERMON_KIND,
  SERMON_SCHEMA_VERSION,
  SermonProjectCommitCoordinator,
  SermonSourceExtractionCoordinator,
  ServiceProjectStore,
  addBibleItem,
  addGroupItem,
  addSermonResource,
  applySermonExtractionReview,
  compileServiceProject,
  createServiceProject,
  isSermonSourceTarget,
  normalizeSermonDocument,
  repinSermonRevision,
  resolveSermonSourceLink,
  sermonDocumentSha256,
  setSermonSourceLink
} = require('../src/services/project');

const root = path.join(__dirname, '..');
const mainSource = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
const preloadSource = fs.readFileSync(path.join(root, 'preload.js'), 'utf8');
const prepareControllerSource = fs.readFileSync(
  path.join(root, 'src', 'renderer', 'prepare-controller.js'),
  'utf8'
);
const PROJECT_REVISION = 'a'.repeat(64);
const NEXT_PROJECT_REVISION = 'b'.repeat(64);
const PROPOSAL_TOKEN = 't'.repeat(32);

function plain(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function handlerSource(channel) {
  const marker = `ipcMain.handle('${channel}'`;
  const start = mainSource.indexOf(marker);
  assert.notEqual(start, -1, `${channel} must be implemented`);
  const next = mainSource.indexOf("ipcMain.handle('", start + marker.length);
  return mainSource.slice(start, next === -1 ? mainSource.length : next);
}

function namedFunctionSource(name) {
  const marker = `function ${name}(`;
  const start = mainSource.indexOf(marker);
  assert.notEqual(start, -1, `${name} must be implemented`);
  const next = mainSource.indexOf('\nfunction ', start + marker.length);
  return mainSource.slice(start, next === -1 ? mainSource.length : next);
}

function loadNamedFunction(name, dependencies = {}) {
  const context = {
    failMainOperation,
    ...dependencies
  };
  vm.runInNewContext(
    `${namedFunctionSource(name)}\nthis.loadedFunction = ${name};`,
    context,
    { filename: `${name}.js` }
  );
  assert.equal(typeof context.loadedFunction, 'function');
  return context.loadedFunction;
}

function loadPreloadBridge() {
  const calls = [];
  let api = null;
  const ipcRenderer = {
    invoke(channel, payload) {
      calls.push({ channel, payload: plain(payload) });
      return Promise.resolve({ ok: true });
    },
    send() {},
    on() {},
    removeListener() {},
    removeAllListeners() {}
  };
  vm.runInNewContext(preloadSource, {
    require(moduleId) {
      if (moduleId === 'electron') {
        return {
          contextBridge: {
            exposeInMainWorld(name, value) {
              if (name === 'api') api = value;
            }
          },
          ipcRenderer
        };
      }
      throw new Error(`Unexpected preload dependency: ${moduleId}`);
    },
    console
  }, { filename: path.join(root, 'preload.js') });
  assert.ok(api);
  return { api, calls };
}

function failMainOperation(code, message, details = {}) {
  const error = new Error(message);
  error.code = code;
  error.details = details;
  throw error;
}

function loadHandler(channel, dependencies) {
  let handler = null;
  vm.runInNewContext(handlerSource(channel), {
    ipcMain: {
      handle(actualChannel, candidate) {
        assert.equal(actualChannel, channel);
        handler = candidate;
      }
    },
    requireControlSender() {},
    requirePrepareRequest() {},
    failMainOperation,
    console,
    prepareSermonDomainId:
      dependencies.prepareSermonDomainId || dependencies.prepareId || prepareId,
    ...dependencies
  }, { filename: `${channel}.js` });
  assert.equal(typeof handler, 'function');
  return handler;
}

function prepareId(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)) {
    failMainOperation('INVALID_PREPARE_ID', 'invalid id');
  }
  return value;
}

function prepareRevision(value) {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) {
    failMainOperation('INVALID_PREPARE_REVISION', 'invalid revision');
  }
  return value;
}

function prepareSermonSuggestionIds(value) {
  if (!Array.isArray(value) || value.length > 500) {
    failMainOperation('INVALID_SERMON_EXTRACTION_SELECTION', 'invalid selection');
  }
  return value.map(prepareId);
}

function sermonFixture() {
  return normalizeSermonDocument({
    schemaVersion: SERMON_SCHEMA_VERSION,
    kind: SERMON_KIND,
    id: 'sermon-prayer',
    titles: { en: 'The Prayer That Transforms the Church' },
    defaultLanguage: 'en',
    speaker: { id: null, name: 'Pastor Example' },
    serviceDate: '2026-07-26',
    series: null,
    outline: [{
      id: 'foundation',
      parentId: null,
      kind: 'section',
      titles: { en: 'Foundation' }
    }],
    sources: [{
      id: 'source-manuscript',
      kind: 'manuscript',
      fileName: 'sermon.pdf',
      mediaType: 'application/pdf',
      sha256: 'c'.repeat(64),
      sizeBytes: 4096,
      languages: ['en', 'ru'],
      provenance: {
        providedBy: 'Pastor Example',
        receivedAt: '2026-07-26T18:00:00.000Z',
        sourceSystem: 'manual-file-picker',
        externalId: ''
      }
    }],
    references: [{
      id: 'primary-eph-3-14-21',
      range: {
        schemaVersion: 1,
        bookId: 'Eph',
        start: { chapter: 3, verse: 14 },
        end: { chapter: 3, verse: 21 }
      },
      role: 'primary',
      source: 'pastor',
      reviewStatus: 'confirmed',
      enteredText: 'Ephesians 3:14-21',
      sourceId: null,
      sectionId: null,
      startOffset: null,
      endOffset: null
    }],
    media: [],
    publication: {
      status: 'draft',
      visibility: 'private',
      publishedAt: null,
      canonicalUrl: null
    }
  });
}

test('project listing preserves a one-shot transaction recovery notice through startup', async () => {
  const handler = loadHandler('prepare:projects:list', {
    prepareText(value) {
      return String(value || '').trim();
    },
    getPrepareServices() {
      return {
        sermonProjectCommitCoordinator: {
          async recover() {
            return {
              recovered: true,
              projectCommitted: true,
              sermonCurrent: false,
              project: { private: 'must-not-cross-ipc' },
              message: 'The service kept its exact reviewed sermon revision.'
            };
          }
        },
        serviceProjectStore: {
          async list(options) {
            assert.deepEqual(plain(options), {
              query: 'July',
              pageSize: 25,
              offset: 0
            });
            return {
              items: [{ id: 'service-july' }],
              total: 1,
              pageSize: 25,
              offset: 0,
              nextOffset: null
            };
          }
        }
      };
    }
  });

  const result = plain(await handler({ trusted: true }, {
    query: ' July ',
    pageSize: 25,
    offset: 0
  }));
  assert.deepEqual(result, {
    items: [{ id: 'service-july' }],
    total: 1,
    pageSize: 25,
    offset: 0,
    nextOffset: null,
    recovery: {
      source: 'sermon-project-transaction',
      message: 'The service kept its exact reviewed sermon revision.'
    }
  });

  const loadProjectsStart = prepareControllerSource.indexOf(
    'async function loadProjects({ openFirst = false } = {})'
  );
  const loadProjectsEnd = prepareControllerSource.indexOf(
    'async function loadProjectHistory',
    loadProjectsStart
  );
  assert.ok(loadProjectsStart >= 0 && loadProjectsEnd > loadProjectsStart);
  const loadProjects = prepareControllerSource.slice(loadProjectsStart, loadProjectsEnd);
  assert.match(loadProjects, /const recoveryMessage = payload\?\.recovery\?\.message \|\| null/);
  assert.match(loadProjects, /setNotice\('warning', recoveryMessage, \{ global: true \}\)/);
  assert.ok(
    loadProjects.indexOf('await openProject(')
      < loadProjects.indexOf("setNotice('warning', recoveryMessage"),
    'opening the first service must not overwrite the recovery notice'
  );

  const activateStart = prepareControllerSource.indexOf('async function activate()');
  const activateEnd = prepareControllerSource.indexOf(
    'function initialize()',
    activateStart
  );
  const activate = prepareControllerSource.slice(activateStart, activateEnd);
  assert.match(
    activate,
    /\['error', 'warning'\]\.includes\(elements\.notice\.dataset\.kind\)/
  );
});

function linkedFixture() {
  const sermon = sermonFixture();
  const sermonRevision = sermonDocumentSha256(sermon);
  let project = addGroupItem(createServiceProject({
    id: 'service-july-26',
    title: 'July 26 Service',
    serviceDate: '2026-07-26',
    profileId: 'main-sanctuary'
  }), {
    id: 'sermon-owner',
    title: 'Sermon',
    groupKind: 'sermon'
  });
  const pinned = addSermonResource(project, sermon, {
    provider: 'local-sermon-library',
    itemId: sermon.id,
    revision: sermonRevision
  });
  project = setSermonSourceLink(pinned.project, {
    itemId: 'sermon-owner',
    sermonResourceId: pinned.resourceId
  });
  project = addGroupItem(project, {
    id: 'sermon-foundation',
    title: 'Foundation',
    groupKind: 'point',
    sermonSectionId: 'foundation',
    parentId: 'sermon-owner'
  });
  return { sermon, sermonRevision, project, resourceId: pinned.resourceId };
}

async function persistentLinkedFixture(t) {
  const temporaryRoot = await fsPromises.mkdtemp(
    path.join(os.tmpdir(), 'syncshow-main-sermon-extraction-')
  );
  t.after(() => fsPromises.rm(temporaryRoot, { recursive: true, force: true }));
  const rootPath = await fsPromises.realpath(temporaryRoot);
  const sermonLibrary = new LocalSermonLibrary({
    rootPath: path.join(rootPath, 'sermons')
  });
  const projectStore = new ServiceProjectStore({
    rootPath: path.join(rootPath, 'projects'),
    randomUUID: () => 'main-contract-project'
  });
  const savedSermon = await sermonLibrary.saveDocument(sermonFixture(), {
    expectedRevision: null
  });
  const created = await projectStore.create({
    id: 'service-july-26',
    title: 'July 26 Service',
    serviceDate: '2026-07-26',
    profileId: 'main-sanctuary'
  });
  let project = addGroupItem(created.project, {
    id: 'sermon-owner',
    title: 'Sermon',
    groupKind: 'sermon'
  });
  const pinned = addSermonResource(project, savedSermon.sermon, {
    provider: 'local-sermon-library',
    itemId: savedSermon.sermon.id,
    revision: savedSermon.revision
  });
  project = setSermonSourceLink(pinned.project, {
    itemId: 'sermon-owner',
    sermonResourceId: pinned.resourceId
  });
  project = addGroupItem(project, {
    id: 'sermon-foundation',
    title: 'Foundation',
    groupKind: 'point',
    sermonSectionId: 'foundation',
    parentId: 'sermon-owner'
  });
  project = addBibleItem(project, {
    id: 'sermon-primary-reading',
    title: 'Ephesians 3:14–21',
    range: savedSermon.sermon.references[0].range,
    passagesByChannel: {
      primary: {
        reference: 'Ephesians 3:14–21',
        translationId: 'BSB',
        attribution: 'Berean Standard Bible',
        verses: Array.from({ length: 8 }, (_, index) => ({
          number: index + 14,
          text: `Pinned Ephesians 3:${index + 14} text`
        }))
      }
    },
    sermonReading: {
      sermonResourceId: pinned.resourceId,
      referenceId: 'primary-eph-3-14-21',
      translationId: 'BSB',
      chunkIndex: 0,
      chunkCount: 1
    },
    index: 0
  });
  const linked = await projectStore.save(project, {
    expectedRevisionId: created.revisionId,
    reason: 'link-sermon'
  });
  return {
    rootPath,
    sermonLibrary,
    projectStore,
    sermon: savedSermon.sermon,
    sermonRevision: savedSermon.revision,
    project: linked.project,
    projectRevision: linked.revisionId,
    resourceId: pinned.resourceId
  };
}

function mentionedReferenceProposal(sermon, sermonRevision) {
  return {
    schemaVersion: SERMON_EXTRACTION_PROPOSAL_SCHEMA_VERSION,
    kind: SERMON_EXTRACTION_PROPOSAL_KIND,
    id: 'proposal-retry',
    sermonId: sermon.id,
    sermonRevision,
    sourceId: sermon.sources[0].id,
    sourceKind: sermon.sources[0].kind,
    sourceRevision: sermon.sources[0].sha256,
    outlineSuggestions: [],
    referenceSuggestions: [{
      id: 'reference:romans-5-5-8',
      canonical: {
        id: 'mentioned-romans-5-5-8',
        range: {
          schemaVersion: 1,
          bookId: 'Rom',
          start: { chapter: 5, verse: 5 },
          end: { chapter: 5, verse: 8 }
        },
        enteredText: 'Romans 5:5-8',
        sectionId: null,
        startOffset: null,
        endOffset: null
      }
    }]
  };
}

function extractionEntry(values, proposal, overrides = {}) {
  return {
    projectId: values.project.id,
    projectRevisionId: values.projectRevision,
    itemId: 'sermon-foundation',
    resourceId: values.resourceId,
    sermonId: values.sermon.id,
    sermonRevisionId: values.sermonRevision,
    sourceId: values.sermon.sources[0].id,
    sourceRevision: values.sermon.sources[0].sha256,
    snapshotHash: 'e'.repeat(64),
    internalProposal: proposal,
    publicProposal: {},
    applying: false,
    expiresAt: Date.now() + 60_000,
    appliedRevision: null,
    appliedSelectionSignature: null,
    appliedOutcome: null,
    ...overrides
  };
}

function projectResult(result) {
  return {
    project: result.project,
    revisionId: result.revisionId,
    unchanged: result.unchanged === true,
    recovery: result.recovery || null
  };
}

function applyRequest(values) {
  return {
    proposalToken: PROPOSAL_TOKEN,
    projectId: values.project.id,
    expectedRevisionId: values.projectRevision,
    itemId: 'sermon-foundation',
    sermonId: values.sermon.id,
    expectedSermonRevisionId: values.sermonRevision,
    outlineSuggestionIds: [],
    referenceSuggestionIds: ['reference:romans-5-5-8']
  };
}

function loadApplyHandler(values, proposals, services) {
  const boundServices = {
    ...services,
    localSermonExtractionStore: services.localSermonExtractionStore || {
      async saveReviewReceipt(receipt) {
        return {
          receiptHash: 'f'.repeat(64),
          receipt: plain(receipt),
          unchanged: false
        };
      }
    }
  };
  const withSermonExtractionProposalApplication = loadNamedFunction(
    'withSermonExtractionProposalApplication',
    { sermonExtractionProposals: proposals }
  );
  const publicSermonExtractionSavedReview = loadNamedFunction(
    'publicSermonExtractionSavedReview'
  );
  return loadHandler('prepare:projects:applySermonExtraction', {
    requireSermonExtractionProposal(token) {
      assert.equal(token, PROPOSAL_TOKEN);
      const entry = proposals.get(token);
      if (!entry) {
        failMainOperation(
          'EXPIRED_SERMON_EXTRACTION_PROPOSAL',
          'proposal no longer exists'
        );
      }
      return { proposalToken: token, entry };
    },
    async readExpectedProject(request) {
      const read = await values.projectStore.read(values.project.id);
      assert.equal(request.expectedRevisionId, values.projectRevision);
      assert.equal(read.revisionId, values.projectRevision);
      return {
        project: read.project,
        projectId: read.project.id,
        revisionId: read.revisionId,
        expectedRevisionId: request.expectedRevisionId,
        services: boundServices
      };
    },
    prepareId,
    prepareRevision,
    prepareSermonSuggestionIds,
    isSermonSourceTarget,
    resolveSermonSourceLink,
    applySermonExtractionReview,
    addSermonResource,
    repinSermonRevision,
    setSermonSourceLink,
    sermonExtractionProposals: proposals,
    withSermonExtractionProposalApplication,
    publicSermonExtractionSavedReview,
    projectResult
  });
}

test('preload forwards only opaque identities and bounded suggestion id lists', async () => {
  const { api, calls } = loadPreloadBridge();
  await api.proposeSermonExtractionForServiceItem({
    projectId: 'service-july-26',
    revisionId: PROJECT_REVISION,
    itemId: 'sermon-foundation',
    sermonId: 'sermon-prayer',
    sermonRevisionId: 'd'.repeat(64),
    sourceId: 'source-manuscript',
    path: '/private/manuscript.pdf',
    bytes: Buffer.from('hostile'),
    document: { hostile: true }
  });
  await api.applySermonExtractionForServiceItem({
    proposalToken: PROPOSAL_TOKEN,
    projectId: 'service-july-26',
    expectedRevisionId: PROJECT_REVISION,
    itemId: 'sermon-foundation',
    sermonId: 'sermon-prayer',
    expectedSermonRevisionId: 'd'.repeat(64),
    outlineSuggestionIds: ['outline:i', { path: '/private' }],
    referenceSuggestionIds: ['reference:romans'],
    document: { hostile: true },
    ranges: [{ hostile: true }],
    cueText: 'must not cross'
  });

  assert.deepEqual(calls, [{
    channel: 'prepare:projects:proposeSermonExtraction',
    payload: {
      projectId: 'service-july-26',
      revisionId: PROJECT_REVISION,
      itemId: 'sermon-foundation',
      sermonId: 'sermon-prayer',
      sermonRevisionId: 'd'.repeat(64),
      sourceId: 'source-manuscript'
    }
  }, {
    channel: 'prepare:projects:applySermonExtraction',
    payload: {
      proposalToken: PROPOSAL_TOKEN,
      projectId: 'service-july-26',
      expectedRevisionId: PROJECT_REVISION,
      itemId: 'sermon-foundation',
      sermonId: 'sermon-prayer',
      expectedSermonRevisionId: 'd'.repeat(64),
      outlineSuggestionIds: ['outline:i', null],
      referenceSuggestionIds: ['reference:romans']
    }
  }]);
});

test('main extraction handlers keep bytes and canonical content behind trusted boundaries', () => {
  const prepareServices = mainSource.slice(
    mainSource.indexOf('function getPrepareServices()'),
    mainSource.indexOf('async function getCommunityServices()')
  );
  assert.match(
    prepareServices,
    /new LocalSermonExtractionStore\(\{\s*rootPath: path\.join\(userDataPath, 'sermon-extractions'\)/
  );
  assert.match(
    prepareServices,
    /return \{[\s\S]*?\blocalSermonExtractionStore,/
  );

  const propose = handlerSource('prepare:projects:proposeSermonExtraction');
  assert.match(propose, /requireControlSender\(event\)/);
  assert.match(propose, /readExpectedProject\(\{\s*\.\.\.request,\s*expectedRevisionId: request\.revisionId/);
  assert.match(propose, /resolveSermonSourceLink\(current\.project, item\)/);
  assert.match(propose, /localSermonLibrary\.readCurrent\(sermonId\)/);
  assert.match(propose, /\.findReviewedSnapshot\(\{/);
  assert.match(propose, /\.readExactSnapshot\(\{/);
  assert.match(propose, /localSermonSourceStore\.readSource\(source\)/);
  assert.match(propose, /extractSermonSourceProposal\(buffer, source\)/);
  assert.match(propose, /\.saveSnapshot\(\{/);
  assert.match(propose, /buildSermonExtractionReviewProposal\(\{/);
  assert.match(propose, /resolveReference: resolveSermonExtractionReference/);
  assert.match(
    propose,
    /sermonExtractionProposalCoordinator\.run\(\s*sermonExtractionProposalCoordinatorKey\(binding\)/
  );
  assert.match(propose, /holdSermonExtractionProposal\(\{/);
  assert.match(propose, /snapshotHash: snapshot\.snapshotHash/);
  assert.doesNotMatch(
    propose,
    /request\.(?:path|filePath|sourcePath|bytes|buffer|document|range|references|outline)\b/
  );

  const apply = handlerSource('prepare:projects:applySermonExtraction');
  assert.match(apply, /requireSermonExtractionProposal\(\s*request\.proposalToken/);
  assert.match(
    apply,
    /withSermonExtractionProposalApplication\(proposalToken, entry, async \(\) =>/
  );
  assert.match(apply, /prepareSermonSuggestionIds\(\s*request\.outlineSuggestionIds/);
  assert.match(apply, /prepareSermonSuggestionIds\(\s*request\.referenceSuggestionIds/);
  assert.match(apply, /applySermonExtractionReview\(\s*sermonRead\.sermon,\s*entry\.internalProposal/);
  assert.match(apply, /sermonProjectCommitCoordinator\.commit\(\{/);
  assert.match(apply, /expectedProjectRevisionId: current\.expectedRevisionId/);
  assert.match(apply, /expectedSermonRevision: sermonRead\.revision/);
  assert.match(apply, /resourceOwnerId: linked\.resourceOwnerId/);
  assert.match(apply, /reason: 'apply-sermon-extraction'/);
  assert.match(apply, /\.saveReviewReceipt\(\{/);
  assert.match(apply, /snapshotHash: entry\.snapshotHash/);
  assert.match(apply, /resultingSermonRevisionId: savedSermon\.revision/);
  assert.match(apply, /resultingProjectRevisionId: committed\.project\.revisionId/);
  assert.match(
    apply,
    /repinSermonRevision\(\s*withResource\.project/,
    'reviewed extraction must repin every live sermon revision reference atomically'
  );
  assert.match(apply, /entry\.appliedOutcome = applied/);
  assert.ok(
    apply.indexOf('sermonProjectCommitCoordinator.commit({')
      < apply.indexOf('.saveReviewReceipt({'),
    'private review evidence must not be recorded before the canonical commit succeeds'
  );
  assert.ok(
    apply.indexOf('.saveReviewReceipt({')
      < apply.indexOf('sermonExtractionProposals.delete(proposalToken)'),
    'opaque proposal is consumed only after the receipt attempt finishes'
  );
  assert.match(apply, /SERMON_EXTRACTION_REVIEW_NOT_SAVED/);
  assert.doesNotMatch(apply, /localSermonLibrary\.saveDocument\(/);
  assert.doesNotMatch(apply, /serviceProjectStore\.save\(/);
  assert.doesNotMatch(
    apply,
    /request\.(?:path|filePath|sourcePath|bytes|buffer|document|range|references|outline)\b/
  );
});

test('main projects extraction-store failures as actionable path-free errors', () => {
  const failExtraction = loadNamedFunction('failSermonSourceExtraction');
  const expectations = new Map([
    ['STORE_UNAVAILABLE', /not available on this computer/],
    ['WRITE_LOCKED', /still finishing/],
    ['SNAPSHOT_CAPACITY_REACHED', /evidence limit/],
    ['BINDING_CONFLICT', /preserved the earlier snapshot/],
    ['REVIEW_INDEX_CORRUPT', /index failed its integrity check/],
    ['REVIEW_RECEIPT_CORRUPT', /receipt failed its integrity check/],
    ['REVIEW_RECEIPT_SNAPSHOT_CAPACITY_REACHED', /private saved-review limit/],
    ['REVIEW_STATUS_CAPACITY_EXCEEDED', /too many saved review receipts/]
  ]);
  for (const [causeCode, messagePattern] of expectations) {
    assert.throws(
      () => failExtraction({
        code: causeCode,
        message: 'host detail',
        details: { path: '/private/sermon-extractions' }
      }),
      error => {
        assert.equal(error.code, 'SERMON_SOURCE_EXTRACTION_FAILED');
        assert.match(error.message, messagePattern);
        assert.deepEqual(plain(error.details), { cause: causeCode });
        assert.equal(JSON.stringify(error).includes('/private/'), false);
        return true;
      }
    );
  }
});

test('propose shares one exact bound extraction through build and opaque hold', async () => {
  const { sermon, sermonRevision, project, resourceId } = linkedFixture();
  const bytes = Buffer.from('verified private source');
  const calls = [];
  let releaseSourceRead;
  let markSourceReadStarted;
  let markSecondProposalKey;
  const sourceReadGate = new Promise(resolve => {
    releaseSourceRead = resolve;
  });
  const sourceReadStarted = new Promise(resolve => {
    markSourceReadStarted = resolve;
  });
  const secondProposalKey = new Promise(resolve => {
    markSecondProposalKey = resolve;
  });
  let proposalKeyCount = 0;
  const publicProposal = {
    source: {
      id: sermon.sources[0].id,
      fileName: sermon.sources[0].fileName,
      kind: sermon.sources[0].kind,
      languages: sermon.sources[0].languages
    },
    extraction: {
      unitLabel: 'pages',
      unitCount: 8,
      textPreview: 'bounded preview',
      textTruncated: false,
      extractor: 'deterministic v1'
    },
    outlineSuggestions: [],
    referenceSuggestions: []
  };
  const handler = loadHandler('prepare:projects:proposeSermonExtraction', {
    prepareId,
    prepareRevision,
    isSermonSourceTarget,
    resolveSermonSourceLink,
    async readExpectedProject(request) {
      assert.equal(request.expectedRevisionId, PROJECT_REVISION);
      return {
        project,
        projectId: project.id,
        revisionId: PROJECT_REVISION,
        expectedRevisionId: PROJECT_REVISION,
        services: {
          localSermonLibrary: {
            async readCurrent(id) {
              calls.push('sermon-read');
              assert.equal(id, sermon.id);
              return { sermon, revision: sermonRevision };
            }
          },
          localSermonSourceStore: {
            async readSource(source) {
              calls.push('private-source-read');
              assert.equal(source, sermon.sources[0]);
              markSourceReadStarted();
              await sourceReadGate;
              return bytes;
            }
          },
          localSermonExtractionStore: {
            async findReviewedSnapshot(options) {
              calls.push('reviewed-snapshot-find');
              assert.deepEqual(plain(options), {
                sermonId: sermon.id,
                resultingSermonRevisionId: sermonRevision,
                sourceId: sermon.sources[0].id,
                sourceSha256: sermon.sources[0].sha256,
                projectId: project.id
              });
              return null;
            },
            async readExactSnapshot(options) {
              calls.push('exact-snapshot-read');
              assert.equal(options.sermonId, sermon.id);
              assert.equal(options.baseSermonRevisionId, sermonRevision);
              assert.equal(options.sourceId, sermon.sources[0].id);
              assert.equal(options.sourceSha256, sermon.sources[0].sha256);
              assert.equal(options.sourceKind, sermon.sources[0].kind);
              assert.equal(options.extractorId, 'test-extractor');
              assert.equal(options.extractorVersion, 7);
              return null;
            },
            async saveSnapshot(options) {
              calls.push('snapshot-save');
              assert.equal(options.sermonId, sermon.id);
              assert.equal(options.baseSermonRevisionId, sermonRevision);
              assert.deepEqual(options.extraction, { raw: true });
              return {
                snapshotHash: 'e'.repeat(64),
                binding: {},
                extraction: options.extraction,
                unchanged: false
              };
            }
          }
        }
      };
    },
    sermonExtractionProposalCoordinator: new SermonSourceExtractionCoordinator({
      maxPendingDistinct: 2
    }),
    sermonSourceExtractionCoordinator: new SermonSourceExtractionCoordinator({
      maxPendingDistinct: 2
    }),
    sermonExtractionProposalCoordinatorKey(binding) {
      proposalKeyCount += 1;
      calls.push('proposal-key');
      assert.deepEqual(plain(binding), {
        projectId: project.id,
        projectRevisionId: PROJECT_REVISION,
        itemId: 'sermon-foundation',
        resourceId,
        sermonId: sermon.id,
        sermonRevisionId: sermonRevision,
        sourceId: sermon.sources[0].id,
        sourceRevision: sermon.sources[0].sha256
      });
      if (proposalKeyCount === 2) markSecondProposalKey();
      return 'proposal:exact-binding';
    },
    sermonExtractionCoordinatorKey(source) {
      calls.push('source-key');
      assert.equal(source, sermon.sources[0]);
      return `sha256:${source.sha256}:metadata`;
    },
    async extractSermonSourceProposal(buffer, source) {
      calls.push('extract');
      assert.equal(buffer, bytes);
      assert.equal(source, sermon.sources[0]);
      return { raw: true };
    },
    async buildSermonExtractionReviewProposal(options) {
      calls.push('build');
      assert.equal(options.sermon, sermon);
      assert.equal(options.sermonRevision, sermonRevision);
      assert.equal(options.source, sermon.sources[0]);
      assert.deepEqual(options.extraction, { raw: true });
      assert.equal(typeof options.resolveReference, 'function');
      return {
        internalProposal: { id: options.proposalId },
        publicProposal
      };
    },
    resolveSermonExtractionReference() {},
    SERMON_SOURCE_EXTRACTOR_ID: 'test-extractor',
    SERMON_SOURCE_EXTRACTOR_VERSION: 7,
    publicSermonExtractionSavedReview: loadNamedFunction(
      'publicSermonExtractionSavedReview'
    ),
    projectItemId() {
      return 'proposal-main-owned';
    },
    holdSermonExtractionProposal(entry) {
      calls.push('hold');
      assert.equal(entry.projectId, project.id);
      assert.equal(entry.projectRevisionId, PROJECT_REVISION);
      assert.equal(entry.itemId, 'sermon-foundation');
      assert.equal(entry.resourceId, resourceId);
      assert.equal(entry.sourceRevision, sermon.sources[0].sha256);
      assert.equal(entry.snapshotHash, 'e'.repeat(64));
      assert.deepEqual(plain(entry.publicProposal.savedReview), {
        snapshotStatus: 'saved',
        reviewStatus: 'unreviewed',
        reviewedAt: null,
        outlineSelectionCount: 0,
        referenceSelectionCount: 0
      });
      return {
        proposalToken: PROPOSAL_TOKEN,
        expiresAt: '2026-07-27T19:00:00.000Z',
        ...entry.publicProposal
      };
    },
    failSermonSourceExtraction(error) {
      throw error;
    }
  });

  const request = {
    projectId: project.id,
    revisionId: PROJECT_REVISION,
    itemId: 'sermon-foundation',
    sermonId: sermon.id,
    sermonRevisionId: sermonRevision,
    sourceId: sermon.sources[0].id,
    path: '/renderer/path.pdf',
    document: { hostile: true }
  };
  const first = handler({}, request);
  await sourceReadStarted;
  const second = handler({}, request);
  await secondProposalKey;
  releaseSourceRead();
  const [firstResult, secondResult] = await Promise.all([first, second]);

  assert.equal(firstResult, secondResult, 'exact bound requests share the held result');
  assert.equal(calls.filter(call => call === 'sermon-read').length, 2);
  assert.equal(calls.filter(call => call === 'proposal-key').length, 2);
  for (const singleCall of [
    'reviewed-snapshot-find',
    'exact-snapshot-read',
    'source-key',
    'private-source-read',
    'extract',
    'snapshot-save',
    'build',
    'hold'
  ]) {
    assert.equal(
      calls.filter(call => call === singleCall).length,
      1,
      `${singleCall} must run once for an exact in-flight binding`
    );
  }
  assert.equal(firstResult.proposalToken, PROPOSAL_TOKEN);
  assert.equal(firstResult.source.fileName, 'sermon.pdf');
  assert.equal(JSON.stringify(firstResult).includes('/renderer/path.pdf'), false);
  assert.equal(Object.hasOwn(firstResult, 'bytes'), false);
  assert.equal(Object.hasOwn(firstResult, 'document'), false);
});

test('propose reopens exact reviewed evidence after restart without reading source bytes', async () => {
  const { sermon, sermonRevision, project, resourceId } = linkedFixture();
  const extraction = { persisted: true };
  const reviewedAt = '2026-07-28T12:00:00.000Z';
  const calls = [];
  const handler = loadHandler('prepare:projects:proposeSermonExtraction', {
    prepareId,
    prepareRevision,
    isSermonSourceTarget,
    resolveSermonSourceLink,
    async readExpectedProject() {
      return {
        project,
        projectId: project.id,
        revisionId: PROJECT_REVISION,
        expectedRevisionId: PROJECT_REVISION,
        services: {
          localSermonLibrary: {
            async readCurrent() {
              return { sermon, revision: sermonRevision };
            }
          },
          localSermonSourceStore: {
            async readSource() {
              throw new Error('private source bytes must not be reread');
            }
          },
          localSermonExtractionStore: {
            async findReviewedSnapshot(options) {
              calls.push('find-reviewed');
              assert.deepEqual(plain(options), {
                sermonId: sermon.id,
                resultingSermonRevisionId: sermonRevision,
                sourceId: sermon.sources[0].id,
                sourceSha256: sermon.sources[0].sha256,
                projectId: project.id
              });
              return {
                snapshot: {
                  snapshotHash: 'e'.repeat(64),
                  binding: {},
                  extraction
                },
                receipt: {
                  receiptHash: 'f'.repeat(64),
                  reviewedAt,
                  outlineSuggestionIds: ['outline:saved-section'],
                  referenceSuggestionIds: ['reference:saved-reference']
                },
                reviewStatus: {
                  snapshotHash: 'e'.repeat(64),
                  reviewed: true,
                  receipts: [],
                  skippedCorruptReceipts: 0
                }
              };
            },
            async readExactSnapshot() {
              throw new Error('reviewed reverse lookup must win');
            },
            async saveSnapshot() {
              throw new Error('reviewed evidence must not be resaved');
            }
          }
        }
      };
    },
    sermonExtractionProposalCoordinator: new SermonSourceExtractionCoordinator(),
    sermonSourceExtractionCoordinator: new SermonSourceExtractionCoordinator(),
    sermonExtractionProposalCoordinatorKey() {
      return 'proposal:reviewed-restart';
    },
    sermonExtractionCoordinatorKey() {
      throw new Error('source extraction must not start');
    },
    async extractSermonSourceProposal() {
      throw new Error('source extraction must not run');
    },
    async buildSermonExtractionReviewProposal(options) {
      calls.push('build');
      assert.equal(options.extraction, extraction);
      return {
        internalProposal: { id: options.proposalId },
        publicProposal: {
          source: {
            id: sermon.sources[0].id,
            fileName: sermon.sources[0].fileName,
            kind: sermon.sources[0].kind,
            languages: sermon.sources[0].languages
          },
          extraction: {
            unitLabel: 'pages',
            unitCount: 8,
            textPreview: 'persisted preview',
            textTruncated: false,
            extractor: 'deterministic v1'
          },
          outlineSuggestions: [],
          referenceSuggestions: []
        }
      };
    },
    resolveSermonExtractionReference() {},
    SERMON_SOURCE_EXTRACTOR_ID: 'unused-extractor',
    SERMON_SOURCE_EXTRACTOR_VERSION: 1,
    publicSermonExtractionSavedReview: loadNamedFunction(
      'publicSermonExtractionSavedReview'
    ),
    projectItemId() {
      return 'proposal-reviewed-restart';
    },
    holdSermonExtractionProposal(entry) {
      calls.push('hold');
      assert.equal(entry.resourceId, resourceId);
      assert.equal(entry.snapshotHash, 'e'.repeat(64));
      return {
        ...entry.publicProposal,
        proposalToken: PROPOSAL_TOKEN,
        expiresAt: '2026-07-28T13:00:00.000Z'
      };
    },
    failSermonSourceExtraction(error) {
      throw error;
    }
  });

  const result = await handler({}, {
    projectId: project.id,
    revisionId: PROJECT_REVISION,
    itemId: 'sermon-foundation',
    sermonId: sermon.id,
    sermonRevisionId: sermonRevision,
    sourceId: sermon.sources[0].id
  });
  assert.deepEqual(calls, ['find-reviewed', 'build', 'hold']);
  assert.deepEqual(plain(result.savedReview), {
    snapshotStatus: 'reused',
    reviewStatus: 'reviewed',
    reviewedAt,
    outlineSelectionCount: 1,
    referenceSelectionCount: 1
  });
});

test('propose reuses an exact unreviewed snapshot without re-extracting source bytes', async () => {
  const { sermon, sermonRevision, project } = linkedFixture();
  const extraction = { persisted: 'unreviewed' };
  const calls = [];
  const handler = loadHandler('prepare:projects:proposeSermonExtraction', {
    prepareId,
    prepareRevision,
    isSermonSourceTarget,
    resolveSermonSourceLink,
    async readExpectedProject() {
      return {
        project,
        projectId: project.id,
        revisionId: PROJECT_REVISION,
        expectedRevisionId: PROJECT_REVISION,
        services: {
          localSermonLibrary: {
            async readCurrent() {
              return { sermon, revision: sermonRevision };
            }
          },
          localSermonSourceStore: {
            async readSource() {
              throw new Error('an exact saved snapshot must avoid source I/O');
            }
          },
          localSermonExtractionStore: {
            async findReviewedSnapshot() {
              calls.push('find-reviewed');
              return null;
            },
            async readExactSnapshot(options) {
              calls.push('read-exact');
              assert.equal(options.baseSermonRevisionId, sermonRevision);
              assert.equal(options.extractorId, 'test-extractor');
              assert.equal(options.extractorVersion, 7);
              return {
                snapshotHash: 'e'.repeat(64),
                binding: {},
                extraction
              };
            },
            async saveSnapshot() {
              throw new Error('an exact saved snapshot must not be rewritten');
            }
          }
        }
      };
    },
    sermonExtractionProposalCoordinator: new SermonSourceExtractionCoordinator(),
    sermonSourceExtractionCoordinator: new SermonSourceExtractionCoordinator(),
    sermonExtractionProposalCoordinatorKey() {
      return 'proposal:unreviewed-restart';
    },
    sermonExtractionCoordinatorKey() {
      throw new Error('source extraction must not start');
    },
    async extractSermonSourceProposal() {
      throw new Error('source extraction must not run');
    },
    async buildSermonExtractionReviewProposal(options) {
      calls.push('build');
      assert.equal(options.extraction, extraction);
      return {
        internalProposal: { id: options.proposalId },
        publicProposal: {
          source: {
            id: sermon.sources[0].id,
            fileName: sermon.sources[0].fileName,
            kind: sermon.sources[0].kind,
            languages: sermon.sources[0].languages
          },
          extraction: {
            unitLabel: 'pages',
            unitCount: 8,
            textPreview: 'persisted preview',
            textTruncated: false,
            extractor: 'deterministic v1'
          },
          outlineSuggestions: [],
          referenceSuggestions: []
        }
      };
    },
    resolveSermonExtractionReference() {},
    SERMON_SOURCE_EXTRACTOR_ID: 'test-extractor',
    SERMON_SOURCE_EXTRACTOR_VERSION: 7,
    publicSermonExtractionSavedReview: loadNamedFunction(
      'publicSermonExtractionSavedReview'
    ),
    projectItemId() {
      return 'proposal-unreviewed-restart';
    },
    holdSermonExtractionProposal(entry) {
      calls.push('hold');
      return {
        ...entry.publicProposal,
        proposalToken: PROPOSAL_TOKEN,
        expiresAt: '2026-07-28T13:00:00.000Z'
      };
    },
    failSermonSourceExtraction(error) {
      throw error;
    }
  });

  const result = await handler({}, {
    projectId: project.id,
    revisionId: PROJECT_REVISION,
    itemId: 'sermon-foundation',
    sermonId: sermon.id,
    sermonRevisionId: sermonRevision,
    sourceId: sermon.sources[0].id
  });
  assert.deepEqual(calls, ['find-reviewed', 'read-exact', 'build', 'hold']);
  assert.deepEqual(plain(result.savedReview), {
    snapshotStatus: 'reused',
    reviewStatus: 'unreviewed',
    reviewedAt: null,
    outlineSelectionCount: 0,
    referenceSelectionCount: 0
  });
});

test('apply keeps an applying token resident and rejects a concurrent use', async () => {
  const entry = {
    applying: false,
    expiresAt: Date.now() - 1
  };
  const proposals = new Map([[PROPOSAL_TOKEN, entry]]);
  const applyOnce = loadNamedFunction(
    'withSermonExtractionProposalApplication',
    { sermonExtractionProposals: proposals }
  );
  const prune = loadNamedFunction('pruneSermonExtractionProposals', {
    sermonExtractionProposals: proposals,
    SERMON_EXTRACTION_PROPOSAL_LIMIT: 1
  });
  const requireProposal = loadNamedFunction('requireSermonExtractionProposal', {
    sermonExtractionProposals: proposals,
    prepareText(value) {
      return value;
    }
  });
  let release;
  let markStarted;
  const gate = new Promise(resolve => {
    release = resolve;
  });
  const started = new Promise(resolve => {
    markStarted = resolve;
  });
  const first = applyOnce(PROPOSAL_TOKEN, entry, async () => {
    markStarted();
    await gate;
    return 'done';
  });
  await started;

  assert.equal(entry.applying, true);
  assert.equal(requireProposal(PROPOSAL_TOKEN).entry, entry);
  assert.equal(prune(Date.now()), false);
  assert.equal(proposals.get(PROPOSAL_TOKEN), entry);
  assert.throws(
    () => applyOnce(PROPOSAL_TOKEN, entry, async () => 'duplicate'),
    error => error.code === 'SERMON_EXTRACTION_APPLY_IN_PROGRESS'
  );

  release();
  assert.equal(await first, 'done');
  assert.equal(entry.applying, false);
  assert.equal(proposals.get(PROPOSAL_TOKEN), entry);
});

test('apply retries a transient project CAS failure with a staged revision and preserves owners', async t => {
  const values = await persistentLinkedFixture(t);
  const originalReading = values.project.items['sermon-primary-reading'];
  const originalReadingCue = Object.values(
    compileServiceProject(values.project).cues
  ).find(cue => cue.itemId === originalReading.id);
  assert.ok(originalReadingCue);
  assert.equal(
    originalReading.sermonReading.sermonResourceId,
    values.resourceId,
    'the generated reading begins pinned to the reviewed source revision'
  );
  const proposal = mentionedReferenceProposal(values.sermon, values.sermonRevision);
  const expectedReview = applySermonExtractionReview(values.sermon, proposal, {
    referenceSuggestionIds: ['reference:romans-5-5-8']
  });
  const entry = extractionEntry(values, proposal);
  const proposals = new Map([[PROPOSAL_TOKEN, entry]]);
  let projectSaveAttempts = 0;
  const transientProjectStore = {
    read: (...args) => values.projectStore.read(...args),
    async save(...args) {
      projectSaveAttempts += 1;
      if (projectSaveAttempts === 1) {
        const error = new Error('simulated project conflict');
        error.code = 'PROJECT_CONFLICT';
        throw error;
      }
      return values.projectStore.save(...args);
    }
  };
  const coordinator = new SermonProjectCommitCoordinator({
    rootPath: path.join(values.rootPath, 'transactions'),
    projectStore: transientProjectStore,
    sermonLibrary: values.sermonLibrary
  });
  const receiptWrites = [];
  const services = {
    localSermonLibrary: values.sermonLibrary,
    localSermonExtractionStore: {
      async saveReviewReceipt(receipt) {
        receiptWrites.push(plain(receipt));
        return {
          receiptHash: 'f'.repeat(64),
          receipt: plain(receipt),
          unchanged: false
        };
      }
    },
    sermonProjectCommitCoordinator: coordinator
  };
  const handler = loadApplyHandler(values, proposals, services);
  const request = applyRequest(values);

  await assert.rejects(handler({}, request), /simulated project conflict/);
  assert.equal(projectSaveAttempts, 1);
  assert.equal(receiptWrites.length, 0, 'failed canonical commits write no review receipt');
  assert.equal(proposals.get(PROPOSAL_TOKEN), entry);
  assert.equal(entry.applying, false);
  assert.equal(entry.appliedRevision, null);
  assert.equal(
    (await values.sermonLibrary.readCurrent(values.sermon.id)).revision,
    values.sermonRevision,
    'a failed project CAS must leave the sermon current pointer unchanged'
  );
  assert.equal(
    (await values.sermonLibrary.readRevision(
      values.sermon.id,
      expectedReview.revision
    )).sermon.references.at(-1).id,
    'mentioned-romans-5-5-8',
    'the immutable reviewed revision remains available for an exact retry'
  );

  const result = await handler({}, request);
  assert.equal(projectSaveAttempts, 2);
  assert.equal(proposals.has(PROPOSAL_TOKEN), false);
  assert.equal(result.sermonRevisionId, expectedReview.revision);
  assert.equal(receiptWrites.length, 1);
  assert.deepEqual(receiptWrites[0], {
    snapshotHash: 'e'.repeat(64),
    projectId: values.project.id,
    resultingSermonRevisionId: expectedReview.revision,
    resultingProjectRevisionId: result.revisionId,
    reviewedAt: receiptWrites[0].reviewedAt,
    outlineSuggestionIds: [],
    referenceSuggestionIds: ['reference:romans-5-5-8']
  });
  assert.match(
    receiptWrites[0].reviewedAt,
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/
  );
  assert.deepEqual(plain(result.applied), {
    outlineSuggestionIds: [],
    referenceSuggestionIds: ['reference:romans-5-5-8']
  });
  assert.equal(
    (await values.sermonLibrary.readCurrent(values.sermon.id)).revision,
    expectedReview.revision
  );

  const savedProject = (await values.projectStore.read(values.project.id)).project;
  const savedReading = savedProject.items['sermon-primary-reading'];
  const savedReadingCue = Object.values(
    compileServiceProject(savedProject).cues
  ).find(cue => cue.itemId === savedReading.id);
  const child = savedProject.items['sermon-foundation'];
  assert.equal(child.sermonSectionId, 'foundation');
  assert.equal(child.sermonResourceId, undefined);
  const resolved = resolveSermonSourceLink(savedProject, child);
  assert.equal(resolved.resourceOwnerId, 'sermon-owner');
  assert.equal(resolved.sectionOwnerId, 'sermon-foundation');
  assert.equal(resolved.resource.sha256, expectedReview.revision);
  assert.equal(
    savedReading.sermonReading.sermonResourceId,
    resolved.resourceId,
    'the generated reading and its sermon owner commit on the same resource'
  );
  assert.equal(
    savedProject.resources[savedReading.sermonReading.sermonResourceId].sha256,
    expectedReview.revision
  );
  assert.equal(savedReadingCue.sourceReference.revision, expectedReview.revision);
  assert.equal(savedProject.revision, values.project.revision + 1);
  assert.equal(
    Object.hasOwn(savedProject.resources, values.resourceId),
    false,
    'the superseded sermon resource is pruned once every live reference moves'
  );
  assert.deepEqual(
    savedReading.range,
    originalReading.range,
    'repinning provenance must not change the generated reading range'
  );
  assert.deepEqual(
    savedReadingCue.channels,
    originalReadingCue.channels,
    'repinning provenance must not change projected Scripture text'
  );
});

test('a no-op apply retry reports the original applied outcome while repinning the service', async t => {
  const values = await persistentLinkedFixture(t);
  const proposal = mentionedReferenceProposal(values.sermon, values.sermonRevision);
  const firstReview = applySermonExtractionReview(values.sermon, proposal, {
    referenceSuggestionIds: ['reference:romans-5-5-8']
  });
  await values.sermonLibrary.saveDocument(firstReview.document, {
    expectedSermonId: values.sermon.id,
    expectedRevision: values.sermonRevision
  });
  const selectionSignature = JSON.stringify({
    outlineSuggestionIds: [],
    referenceSuggestionIds: ['reference:romans-5-5-8']
  });
  const entry = extractionEntry(values, proposal, {
    appliedRevision: firstReview.revision,
    appliedSelectionSignature: selectionSignature,
    appliedOutcome: firstReview.applied
  });
  const proposals = new Map([[PROPOSAL_TOKEN, entry]]);
  const coordinator = new SermonProjectCommitCoordinator({
    rootPath: path.join(values.rootPath, 'transactions'),
    projectStore: values.projectStore,
    sermonLibrary: values.sermonLibrary
  });
  const services = {
    localSermonLibrary: values.sermonLibrary,
    sermonProjectCommitCoordinator: coordinator
  };
  const handler = loadApplyHandler(values, proposals, services);

  const result = await handler({}, applyRequest(values));
  assert.deepEqual(plain(result.applied), plain(firstReview.applied));
  assert.deepEqual(plain(result.applied), {
    outlineSuggestionIds: [],
    referenceSuggestionIds: ['reference:romans-5-5-8']
  });
  assert.equal(result.sermonRevisionId, firstReview.revision);
  assert.equal(proposals.has(PROPOSAL_TOKEN), false);
  const saved = await values.projectStore.read(values.project.id);
  assert.equal(
    resolveSermonSourceLink(
      saved.project,
      saved.project.items['sermon-foundation']
    ).resource.sha256,
    firstReview.revision
  );
});

test('receipt failure after commit returns canonical success with an honest warning', async t => {
  const values = await persistentLinkedFixture(t);
  const proposal = mentionedReferenceProposal(values.sermon, values.sermonRevision);
  const expectedReview = applySermonExtractionReview(values.sermon, proposal, {
    referenceSuggestionIds: ['reference:romans-5-5-8']
  });
  const entry = extractionEntry(values, proposal);
  const proposals = new Map([[PROPOSAL_TOKEN, entry]]);
  const coordinator = new SermonProjectCommitCoordinator({
    rootPath: path.join(values.rootPath, 'transactions-warning'),
    projectStore: values.projectStore,
    sermonLibrary: values.sermonLibrary
  });
  const handler = loadApplyHandler(values, proposals, {
    localSermonLibrary: values.sermonLibrary,
    localSermonExtractionStore: {
      async saveReviewReceipt() {
        const error = new Error('private path and storage details must not escape');
        error.code = 'REVIEW_RECEIPT_WRITE_FAILED';
        throw error;
      }
    },
    sermonProjectCommitCoordinator: coordinator
  });

  const result = await handler({}, applyRequest(values));
  assert.equal(result.sermonRevisionId, expectedReview.revision);
  assert.equal(proposals.has(PROPOSAL_TOKEN), false);
  assert.deepEqual(plain(result.reviewPersistenceWarning), {
    code: 'SERMON_EXTRACTION_REVIEW_NOT_SAVED',
    message: 'The sermon and service were saved, but the private extraction review record was not. This source may need review again after restarting SyncShow.'
  });
  assert.equal(
    JSON.stringify(result).includes('private path and storage details'),
    false
  );
  assert.equal(
    (await values.sermonLibrary.readCurrent(values.sermon.id)).revision,
    expectedReview.revision
  );
  const saved = await values.projectStore.read(values.project.id);
  assert.equal(saved.revisionId, result.revisionId);
  assert.equal(
    resolveSermonSourceLink(
      saved.project,
      saved.project.items['sermon-foundation']
    ).resource.sha256,
    expectedReview.revision
  );
});
