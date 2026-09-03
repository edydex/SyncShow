'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const {
  MAX_SERMON_BODY_ENTRY_BYTES,
  SERMON_KIND,
  SERMON_SCHEMA_VERSION,
  addGroupItem,
  addProjectItem,
  addSermonResource,
  applySermonBodyReview,
  bindProjectAsPowerPointCompanion,
  buildSermonBodyReviewProposal,
  createServiceProject,
  isPowerPointCompanionProject,
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
const PROJECT_REVISION = 'a'.repeat(64);
const NEXT_PROJECT_REVISION = 'b'.repeat(64);
const SNAPSHOT_HASH = 'e'.repeat(64);
const PROPOSAL_TOKEN = 't'.repeat(32);

function plain(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function failMainOperation(code, message, details = {}) {
  const error = new Error(message);
  error.code = code;
  error.details = details;
  throw error;
}

function requireExactPrepareKeys(value, allowedKeys) {
  const allowed = new Set(allowedKeys);
  if (Object.keys(value).some(key => !allowed.has(key))) {
    failMainOperation('UNSUPPORTED_PREPARE_FIELDS', 'unsupported fields');
  }
  return value;
}

function prepareText(value, label, maximum, { required = false } = {}) {
  if (value === undefined || value === null) value = '';
  if (typeof value !== 'string') {
    failMainOperation('INVALID_PREPARE_TEXT', `${label} must be text`);
  }
  const normalized = value.trim();
  if (required && !normalized) {
    failMainOperation('MISSING_PREPARE_TEXT', `${label} is required`);
  }
  if (normalized.length > maximum) {
    failMainOperation('PREPARE_TEXT_TOO_LONG', `${label} is too long`);
  }
  return normalized;
}

function prepareId(value) {
  const result = prepareText(value, 'id', 128, { required: true });
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(result)) {
    failMainOperation('INVALID_PREPARE_ID', 'invalid id');
  }
  return result;
}

function prepareRevision(value) {
  const result = prepareText(value, 'revision', 64, { required: true });
  if (!/^[a-f0-9]{64}$/.test(result)) {
    failMainOperation('INVALID_PREPARE_REVISION', 'invalid revision');
  }
  return result;
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
  return context.loadedFunction;
}

function loadHandler(channel, dependencies = {}) {
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
    requireExactPrepareKeys,
    failMainOperation,
    console,
    JSON,
    ...dependencies
  }, { filename: `${channel}.js` });
  assert.equal(typeof handler, 'function');
  return handler;
}

function loadPreloadBridge() {
  const calls = [];
  let api = null;
  vm.runInNewContext(preloadSource, {
    require(moduleId) {
      if (moduleId !== 'electron') {
        throw new Error(`Unexpected preload dependency: ${moduleId}`);
      }
      return {
        contextBridge: {
          exposeInMainWorld(name, value) {
            if (name === 'api') api = value;
          }
        },
        ipcRenderer: {
          invoke(channel, payload) {
            calls.push({ channel, payload: plain(payload) });
            return Promise.resolve({ ok: true });
          },
          send() {},
          on() {},
          removeListener() {},
          removeAllListeners() {}
        }
      };
    },
    TextEncoder,
    console
  }, { filename: path.join(root, 'preload.js') });
  assert.ok(api);
  return { api, calls };
}

function sermonFixture() {
  return normalizeSermonDocument({
    schemaVersion: SERMON_SCHEMA_VERSION,
    kind: SERMON_KIND,
    id: 'sermon-body-main',
    titles: { en: 'A Reviewed Sermon' },
    defaultLanguage: 'en',
    speaker: { id: null, name: 'Pastor Example' },
    serviceDate: '2026-07-26',
    series: null,
    outline: [],
    sources: [{
      id: 'pastor-manuscript',
      kind: 'manuscript',
      fileName: 'sermon.pdf',
      mediaType: 'application/pdf',
      languages: ['en'],
      sha256: 'c'.repeat(64),
      sizeBytes: 4096,
      provenance: {
        providedBy: 'Pastor Example',
        receivedAt: '2026-07-25T18:00:00.000Z',
        sourceSystem: 'manual-file-picker',
        externalId: ''
      }
    }, {
      id: 'older-transcript',
      kind: 'transcript',
      fileName: 'older.txt',
      mediaType: 'text/plain',
      languages: ['ru'],
      sha256: 'd'.repeat(64),
      sizeBytes: 100,
      provenance: {
        providedBy: '',
        receivedAt: null,
        sourceSystem: 'manual-file-picker',
        externalId: ''
      }
    }],
    references: [{
      id: 'primary-romans',
      range: {
        schemaVersion: 1,
        bookId: 'Rom',
        start: { chapter: 5, verse: 1 },
        end: { chapter: 5, verse: 5 }
      },
      role: 'primary',
      source: 'pastor',
      reviewStatus: 'confirmed',
      enteredText: 'Romans 5:1-5',
      sourceId: 'pastor-manuscript',
      sectionId: null,
      startOffset: null,
      endOffset: null
    }],
    media: [],
    publication: {
      status: 'ready',
      visibility: 'members',
      publishedAt: null,
      canonicalUrl: 'https://church.example/sermons/reviewed'
    },
    body: [{
      id: 'unrelated-body',
      kind: 'transcript',
      language: 'ru',
      sourceId: 'older-transcript',
      sectionId: null,
      text: 'Сохранить этот проверенный текст.'
    }]
  });
}

function extractionFixture(overrides = {}) {
  return {
    schemaVersion: 1,
    kind: 'syncshow-sermon-source-extraction-proposal',
    extractor: {
      id: 'syncshow-deterministic-source-extractor',
      version: 1
    },
    source: {
      id: 'pastor-manuscript',
      sha256: 'c'.repeat(64),
      kind: 'manuscript',
      languages: ['en'],
      mediaType: 'application/pdf'
    },
    units: [{
      id: 'pdf-page-1',
      kind: 'page',
      ordinal: 1,
      label: 'Page 1',
      text: 'Complete first page.',
      truncated: false
    }, {
      id: 'pdf-page-2',
      kind: 'page',
      ordinal: 2,
      label: 'Page 2',
      text: 'Complete second page.',
      truncated: false
    }],
    textPreview: 'PREVIEW MUST NEVER BECOME THE BODY',
    suggestionScope: {
      strategy: 'whole-source',
      startUnitId: 'pdf-page-1',
      endUnitId: 'pdf-page-2',
      startOrdinal: 1,
      endOrdinal: 2
    },
    outlineSuggestions: [],
    scriptureReferenceSuggestions: [],
    truncated: {
      units: false,
      text: false,
      preview: true,
      outlineSuggestions: false,
      scriptureReferences: false
    },
    ...overrides
  };
}

function linkedNativeFixture() {
  const sermon = sermonFixture();
  const sermonRevision = sermonDocumentSha256(sermon);
  let project = createServiceProject({
    id: 'native-service',
    title: 'Native Service',
    serviceDate: '2026-07-26',
    profileId: 'main-sanctuary'
  });
  project = addGroupItem(project, {
    id: 'sermon-owner',
    title: 'Sermon',
    groupKind: 'sermon'
  });
  project = addProjectItem(project, {
    id: 'sermon-cue',
    kind: 'sermon',
    title: 'Cue title must survive',
    textByChannel: {
      primary: 'Projected cue wording must survive.'
    },
    presetId: 'sermon-point',
    operatorNotes: 'Operator wording must survive.'
  }, {
    parentId: 'sermon-owner'
  });
  const pinned = addSermonResource(project, sermon, {
    provider: 'local-sermon-library',
    itemId: sermon.id,
    revision: sermonRevision
  });
  project = setSermonSourceLink(pinned.project, {
    itemId: 'sermon-cue',
    sermonResourceId: pinned.resourceId
  });
  return {
    sermon,
    sermonRevision,
    project,
    resourceId: pinned.resourceId,
    itemId: 'sermon-cue'
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

test('preload forwards only opaque body-review identities and rejects oversize text without truncating', async () => {
  const { api, calls } = loadPreloadBridge();
  await api.proposeSermonBodyForServiceItem({
    projectId: 'native-service',
    revisionId: PROJECT_REVISION,
    itemId: 'sermon-cue',
    sermonId: 'sermon-body-main',
    sermonRevisionId: 'c'.repeat(64),
    sourceId: 'pastor-manuscript',
    path: '/private/pastor/sermon.pdf',
    extraction: { hostile: true }
  });
  await api.applySermonBodyForServiceItem({
    proposalToken: PROPOSAL_TOKEN,
    projectId: 'native-service',
    expectedRevisionId: PROJECT_REVISION,
    itemId: 'sermon-cue',
    sermonId: 'sermon-body-main',
    expectedSermonRevisionId: 'c'.repeat(64),
    entry: {
      id: 'pastor-manuscript',
      kind: 'manuscript',
      language: 'en',
      text: 'Complete reviewed text.',
      sourceId: 'forged-source',
      sectionId: 'forged-section'
    },
    confirmed: true,
    publication: { status: 'published' },
    cueText: 'forged'
  });
  await api.applySermonBodyForServiceItem({
    entry: {
      id: 'pastor-manuscript',
      kind: 'manuscript',
      language: 'en',
      text: 'x'.repeat(MAX_SERMON_BODY_ENTRY_BYTES + 1)
    }
  });

  assert.deepEqual(calls[0], {
    channel: 'prepare:projects:proposeSermonBody',
    payload: {
      projectId: 'native-service',
      revisionId: PROJECT_REVISION,
      itemId: 'sermon-cue',
      sermonId: 'sermon-body-main',
      sermonRevisionId: 'c'.repeat(64),
      sourceId: 'pastor-manuscript'
    }
  });
  assert.deepEqual(calls[1], {
    channel: 'prepare:projects:applySermonBody',
    payload: {
      proposalToken: PROPOSAL_TOKEN,
      projectId: 'native-service',
      expectedRevisionId: PROJECT_REVISION,
      itemId: 'sermon-cue',
      sermonId: 'sermon-body-main',
      expectedSermonRevisionId: 'c'.repeat(64),
      entry: {
        id: 'pastor-manuscript',
        kind: 'manuscript',
        language: 'en',
        text: 'Complete reviewed text.'
      },
      confirmed: true
    }
  });
  assert.equal(calls[2].payload.entry.text, null);
  assert.notEqual(calls[2].payload.entry.text, 'x'.repeat(MAX_SERMON_BODY_ENTRY_BYTES));
});

test('main body handlers keep full extraction and canonical writes behind exact trusted boundaries', () => {
  assert.match(mainSource, /const sermonBodyReviewProposals = new Map\(\)/);
  assert.match(mainSource, /SERMON_BODY_REVIEW_PROPOSAL_LIMIT = 6/);
  assert.match(mainSource, /SERMON_BODY_REVIEW_PROPOSAL_TTL_MS = 15 \* 60 \* 1000/);

  const propose = handlerSource('prepare:projects:proposeSermonBody');
  assert.match(propose, /requireExactPrepareKeys\(request,/);
  assert.match(propose, /requireSermonBodyTarget\(/);
  assert.match(propose, /localSermonLibrary\.readCurrent/);
  assert.match(propose, /\.readExactSnapshot\(\{/);
  assert.match(propose, /localSermonSourceStore\s*\.readSource\(source\)/);
  assert.match(propose, /extractSermonSourceProposal\(buffer, source\)/);
  assert.match(propose, /\.saveSnapshot\(\{/);
  assert.match(propose, /buildSermonBodyReviewProposal\(\{/);
  assert.match(propose, /extraction: snapshot\.extraction/);
  assert.doesNotMatch(propose, /\.textPreview\b/);
  assert.doesNotMatch(
    propose,
    /request\.(?:path|filePath|sourcePath|bytes|buffer|document|body|publication)\b/
  );

  const apply = handlerSource('prepare:projects:applySermonBody');
  assert.match(apply, /request\.confirmed !== true/);
  assert.match(apply, /requireSermonBodyReviewProposal/);
  assert.match(apply, /requireSermonBodyTarget/);
  assert.match(apply, /\.readExactSnapshot\(\{/);
  assert.match(apply, /snapshot\.snapshotHash !== entry\.snapshotHash/);
  assert.match(apply, /buildSermonBodyReviewProposal\(\{/);
  assert.match(apply, /applySermonBodyReview\(/);
  assert.match(apply, /addSermonResource\(/);
  assert.match(apply, /repinSermonRevision\(withResource\.project/);
  assert.match(apply, /sermonProjectCommitCoordinator\s*\.commit\(\{/);
  assert.match(apply, /expectedProjectRevisionId: current\.expectedRevisionId/);
  assert.match(apply, /expectedSermonRevision: sermonRead\.revision/);
  assert.match(apply, /reason: 'apply-sermon-body-review'/);
  assert.ok(
    apply.indexOf('.readExactSnapshot({')
      < apply.indexOf('applySermonBodyReview(')
  );
  assert.ok(
    apply.indexOf('addSermonResource(')
      < apply.indexOf('repinSermonRevision(')
  );
  assert.ok(
    apply.indexOf('repinSermonRevision(')
      < apply.indexOf('.commit({')
  );
  assert.doesNotMatch(
    apply,
    /(?:Community|scheduleCommunity|pushCommunity|publishCommunity|updateTextItem|updateGroupItem)/
  );
});

test('native sermon targets are eligible while PowerPoint companions enforce their one exact anchor', () => {
  const requireTarget = loadNamedFunction('requireSermonBodyTarget', {
    isPowerPointCompanionProject,
    prepareId,
    currentServiceCompanionAnchor() {
      return 'sermon-owner';
    },
    isSermonSourceTarget,
    resolveSermonSourceLink
  });
  const native = linkedNativeFixture();
  assert.equal(
    requireTarget(native.project, native.itemId).linked.resourceId,
    native.resourceId
  );

  let companion = createServiceProject({
    id: 'pptx-companion',
    title: 'PowerPoint Companion',
    serviceDate: '2026-07-26',
    profileId: 'main-sanctuary'
  });
  companion = addGroupItem(companion, {
    id: 'sermon-owner',
    title: 'Sermon',
    groupKind: 'sermon'
  });
  const pinned = addSermonResource(companion, native.sermon);
  companion = setSermonSourceLink(pinned.project, {
    itemId: 'sermon-owner',
    sermonResourceId: pinned.resourceId
  });
  companion = bindProjectAsPowerPointCompanion(companion, {
    id: 'current-service-set',
    fingerprint: 'f'.repeat(64),
    serviceDate: '2026-07-26',
    profileId: 'main-sanctuary'
  });

  assert.equal(requireTarget(companion, 'sermon-owner').itemId, 'sermon-owner');
  assert.throws(
    () => requireTarget(companion, 'not-the-anchor'),
    error => error.code === 'INVALID_SERMON_BODY_ANCHOR'
  );
});

test('propose returns the strict path-free full-text shape and rejects truncated snapshots', async () => {
  const values = linkedNativeFixture();
  const failSermonBodyReview = loadNamedFunction('failSermonBodyReview');
  const publicSermonBodyReviewProposal = loadNamedFunction(
    'publicSermonBodyReviewProposal',
    {
      sermonBodyReviewSourceLanguages(source) {
        return [...source.languages];
      }
    }
  );
  const servicesFor = extraction => ({
    localSermonLibrary: {
      async readCurrent() {
        return {
          sermon: values.sermon,
          revision: values.sermonRevision
        };
      }
    },
    localSermonExtractionStore: {
      async readExactSnapshot() {
        return {
          snapshotHash: SNAPSHOT_HASH,
          extraction
        };
      }
    },
    localSermonSourceStore: {
      async readSource() {
        throw new Error('a saved exact snapshot must avoid source bytes');
      }
    }
  });
  const target = {
    itemId: values.itemId,
    linked: resolveSermonSourceLink(
      values.project,
      values.project.items[values.itemId]
    )
  };
  const makeHandler = extraction => loadHandler(
    'prepare:projects:proposeSermonBody',
    {
      async readExpectedProject() {
        return {
          project: values.project,
          projectId: values.project.id,
          revisionId: PROJECT_REVISION,
          expectedRevisionId: PROJECT_REVISION,
          services: servicesFor(extraction)
        };
      },
      requireSermonBodyTarget() {
        return target;
      },
      prepareSermonDomainId: prepareId,
      prepareRevision,
      sermonBodyReviewSourceLanguages(source) {
        return [...source.languages];
      },
      sermonExtractionProposalCoordinator: {
        run(_key, operation) {
          return operation();
        }
      },
      sermonBodyReviewCoordinatorKey() {
        return 'body-proposal';
      },
      sermonSourceExtractionCoordinator: {
        run() {
          throw new Error('not expected');
        }
      },
      sermonExtractionCoordinatorKey() {
        return 'source-extraction';
      },
      SERMON_SOURCE_EXTRACTOR_ID: 'syncshow-deterministic-source-extractor',
      SERMON_SOURCE_EXTRACTOR_VERSION: 1,
      extractSermonSourceProposal() {
        throw new Error('not expected');
      },
      buildSermonBodyReviewProposal,
      SERMON_SCHEMA_VERSION,
      publicSermonBodyReviewProposal,
      holdSermonBodyReviewProposal(entry, publicProposal) {
        assert.equal(entry.snapshotHash, SNAPSHOT_HASH);
        assert.equal(entry.internalProposal.entries.length, 2);
        return {
          proposalToken: PROPOSAL_TOKEN,
          expiresAt: '2026-07-26T19:00:00.000Z',
          ...plain(publicProposal)
        };
      },
      failSermonBodyReview
    }
  );
  const request = {
    projectId: values.project.id,
    revisionId: PROJECT_REVISION,
    itemId: values.itemId,
    sermonId: values.sermon.id,
    sermonRevisionId: values.sermonRevision,
    sourceId: 'pastor-manuscript'
  };

  const proposal = plain(await makeHandler(extractionFixture())({}, request));
  assert.deepEqual(Object.keys(proposal).sort(), [
    'bodyEntryCount',
    'entry',
    'expiresAt',
    'proposalToken',
    'replacesExisting',
    'sermon',
    'source'
  ]);
  assert.equal(
    proposal.entry.text,
    'Complete first page.\n\nComplete second page.'
  );
  assert.doesNotMatch(JSON.stringify(proposal), /PREVIEW MUST NEVER|private|sha256|provenance/i);
  assert.deepEqual(proposal.sermon, {
    id: 'sermon-body-main',
    title: 'A Reviewed Sermon',
    defaultLanguage: 'en',
    publicationStatus: 'ready',
    visibility: 'members'
  });
  assert.deepEqual(proposal.source, {
    id: 'pastor-manuscript',
    fileName: 'sermon.pdf',
    kind: 'manuscript',
    languages: ['en']
  });
  assert.equal(proposal.bodyEntryCount, 2);
  assert.equal(proposal.replacesExisting, false);

  const truncated = extractionFixture();
  truncated.truncated.text = true;
  await assert.rejects(
    makeHandler(truncated)({}, request),
    error => {
      assert.equal(error.code, 'SERMON_BODY_REVIEW_FAILED');
      assert.deepEqual(plain(error.details), { cause: 'INCOMPLETE_EXTRACTION' });
      assert.doesNotMatch(JSON.stringify(error), /\/private\//);
      return true;
    }
  );
});

function loadApplyHarness(values, held, {
  snapshotHash = SNAPSHOT_HASH,
  targetResourceId = values.resourceId,
  calls = []
} = {}) {
  const proposals = new Map([[PROPOSAL_TOKEN, held]]);
  const failSermonBodyReview = loadNamedFunction('failSermonBodyReview');
  const prepareSermonBodyReviewEntry = loadNamedFunction(
    'prepareSermonBodyReviewEntry',
    {
      requireExactPrepareKeys,
      Buffer,
      MAX_SERMON_BODY_ENTRY_BYTES,
      prepareText,
      prepareSermonDomainId: prepareId
    }
  );
  const originalLinked = resolveSermonSourceLink(
    values.project,
    values.project.items[values.itemId]
  );
  const services = {
    localSermonLibrary: {
      async readCurrent() {
        calls.push('sermon-read');
        return {
          sermon: values.sermon,
          revision: values.sermonRevision
        };
      }
    },
    localSermonExtractionStore: {
      async readExactSnapshot() {
        calls.push('snapshot-read');
        return {
          snapshotHash,
          extraction: extractionFixture()
        };
      }
    },
    sermonProjectCommitCoordinator: {
      async commit(options) {
        calls.push('commit');
        assert.equal(options.reason, 'apply-sermon-body-review');
        assert.equal(options.expectedProjectRevisionId, PROJECT_REVISION);
        assert.equal(options.expectedSermonRevision, values.sermonRevision);
        assert.equal(
          options.project.items[values.itemId].textByChannel.primary,
          'Projected cue wording must survive.'
        );
        assert.equal(
          options.project.items[values.itemId].operatorNotes,
          'Operator wording must survive.'
        );
        return {
          project: {
            project: options.project,
            revisionId: NEXT_PROJECT_REVISION,
            unchanged: false,
            recovery: null
          },
          sermon: {
            sermon: options.sermonDocument,
            revision: sermonDocumentSha256(options.sermonDocument)
          },
          recovery: null
        };
      }
    }
  };
  const handler = loadHandler('prepare:projects:applySermonBody', {
    MAX_SERMON_BODY_ENTRY_BYTES,
    prepareSermonBodyReviewEntry,
    requireSermonBodyReviewProposal(token) {
      const entry = proposals.get(token);
      if (!entry) {
        failMainOperation(
          'EXPIRED_SERMON_BODY_REVIEW_PROPOSAL',
          'proposal expired'
        );
      }
      return { proposalToken: token, entry };
    },
    async withSermonBodyReviewApplication(token, entry, operation) {
      entry.applying = true;
      let succeeded = false;
      try {
        const result = await operation();
        succeeded = true;
        return result;
      } finally {
        if (proposals.get(token) === entry) {
          if (succeeded) proposals.delete(token);
          else entry.applying = false;
        }
      }
    },
    async readExpectedProject(request) {
      assert.equal(request.expectedRevisionId, PROJECT_REVISION);
      return {
        project: values.project,
        projectId: values.project.id,
        revisionId: PROJECT_REVISION,
        expectedRevisionId: PROJECT_REVISION,
        services
      };
    },
    requireSermonBodyTarget() {
      return {
        itemId: values.itemId,
        linked: {
          ...originalLinked,
          resourceId: targetResourceId
        }
      };
    },
    prepareSermonDomainId: prepareId,
    prepareRevision,
    sermonBodyReviewSourceLanguages(source) {
      return [...source.languages];
    },
    SERMON_SOURCE_EXTRACTOR_ID: 'syncshow-deterministic-source-extractor',
    SERMON_SOURCE_EXTRACTOR_VERSION: 1,
    buildSermonBodyReviewProposal,
    applySermonBodyReview,
    addSermonResource(project, sermon, options) {
      calls.push('add-resource');
      return addSermonResource(project, sermon, options);
    },
    repinSermonRevision(project, options) {
      calls.push('repin');
      return repinSermonRevision(project, options);
    },
    failSermonBodyReview,
    projectResult
  });
  return { handler, proposals, calls };
}

function bodyApplyRequest(values, overrides = {}) {
  return {
    proposalToken: PROPOSAL_TOKEN,
    projectId: values.project.id,
    expectedRevisionId: PROJECT_REVISION,
    itemId: values.itemId,
    sermonId: values.sermon.id,
    expectedSermonRevisionId: values.sermonRevision,
    entry: {
      id: 'pastor-manuscript',
      kind: 'manuscript',
      language: 'en',
      text: 'Operator reviewed complete body.'
    },
    confirmed: true,
    ...overrides
  };
}

test('apply requires confirmation, rechecks exact bindings, preserves unrelated body and cue wording, then repins before commit', async () => {
  const values = linkedNativeFixture();
  const internalProposal = buildSermonBodyReviewProposal({
    sermon: values.sermon,
    baseSermonRevisionId: values.sermonRevision,
    sourceId: 'pastor-manuscript',
    snapshotHash: SNAPSHOT_HASH,
    extraction: extractionFixture()
  });
  const linked = resolveSermonSourceLink(
    values.project,
    values.project.items[values.itemId]
  );
  const held = {
    projectId: values.project.id,
    projectRevisionId: PROJECT_REVISION,
    itemId: values.itemId,
    resourceId: values.resourceId,
    resourceOwnerId: linked.resourceOwnerId,
    sermonId: values.sermon.id,
    sermonRevisionId: values.sermonRevision,
    sourceId: 'pastor-manuscript',
    sourceRevision: 'c'.repeat(64),
    sourceKind: 'manuscript',
    sourceMediaType: 'application/pdf',
    sourceLanguages: ['en'],
    snapshotHash: SNAPSHOT_HASH,
    bodyEntryId: 'pastor-manuscript',
    internalProposal,
    applying: false,
    expiresAt: Date.now() + 60_000
  };

  const unconfirmed = loadApplyHarness(values, { ...held });
  await assert.rejects(
    unconfirmed.handler({}, bodyApplyRequest(values, { confirmed: false })),
    error => error.code === 'SERMON_BODY_REVIEW_CONFIRMATION_REQUIRED'
  );
  assert.deepEqual(unconfirmed.calls, []);
  assert.equal(unconfirmed.proposals.has(PROPOSAL_TOKEN), true);

  const applied = loadApplyHarness(values, { ...held });
  const result = plain(await applied.handler({}, bodyApplyRequest(values)));
  assert.deepEqual(applied.calls, [
    'sermon-read',
    'snapshot-read',
    'add-resource',
    'repin',
    'commit'
  ]);
  assert.equal(applied.proposals.has(PROPOSAL_TOKEN), false);
  assert.equal(result.revisionId, NEXT_PROJECT_REVISION);
  assert.equal(result.body.entryId, 'pastor-manuscript');
  assert.equal(result.body.bodyEntryCount, 2);
  assert.equal(result.body.publicationStatus, 'draft');
  assert.equal(result.body.visibility, 'members');
  const savedSermon = resolveSermonSourceLink(
    result.project,
    result.project.items[values.itemId]
  ).resource.document;
  assert.equal(savedSermon.body[0].id, 'unrelated-body');
  assert.equal(savedSermon.body[0].text, 'Сохранить этот проверенный текст.');
  assert.equal(savedSermon.body[1].text, 'Operator reviewed complete body.');
  assert.equal(
    result.project.items[values.itemId].textByChannel.primary,
    'Projected cue wording must survive.'
  );
  assert.equal(
    result.project.items[values.itemId].operatorNotes,
    'Operator wording must survive.'
  );

  const staleResource = loadApplyHarness(values, { ...held }, {
    targetResourceId: `sha256:${'f'.repeat(64)}`
  });
  await assert.rejects(
    staleResource.handler({}, bodyApplyRequest(values)),
    error => error.code === 'SERMON_BODY_REVIEW_BINDING_CHANGED'
  );
  assert.deepEqual(staleResource.calls, []);
  assert.equal(staleResource.proposals.has(PROPOSAL_TOKEN), true);

  const staleSnapshot = loadApplyHarness(values, { ...held }, {
    snapshotHash: '9'.repeat(64)
  });
  await assert.rejects(
    staleSnapshot.handler({}, bodyApplyRequest(values)),
    error => error.code === 'SERMON_BODY_REVIEW_SNAPSHOT_CHANGED'
  );
  assert.deepEqual(staleSnapshot.calls, ['sermon-read', 'snapshot-read']);
  assert.equal(staleSnapshot.proposals.has(PROPOSAL_TOKEN), true);
});
