'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const { BibleLibrary } = require('../src/services/bible');
const {
  addBibleItem,
  addGroupItem,
  addSermonResource,
  analyzeSermonPrimaryReading,
  bindProjectAsPowerPointCompanion,
  bindProjectToServiceSet,
  createServiceProject,
  isPowerPointCompanionProject,
  isSermonSourceTarget,
  placeBibleReadingItemsBefore,
  repinSermonRevision,
  resolveBookId,
  resolveSermonSourceLink,
  SERMON_SCHEMA_VERSION,
  sermonDocumentSha256,
  setSermonSourceLink,
  upgradeSermonDocument
} = require('../src/services/project');
const {
  buildServiceSermonPacketSourcePlan,
  importedSourceMatchesPlan,
  serviceSermonPacketSourceDispositions,
  serviceSetFingerprint
} = require('../src/services/sermon/ServiceSermonPacket');

const root = path.join(__dirname, '..');
const mainSource = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
const preloadSource = fs.readFileSync(path.join(root, 'preload.js'), 'utf8');
const controllerPath = path.join(root, 'src', 'renderer', 'prepare-controller.js');
const controllerSource = fs.readFileSync(controllerPath, 'utf8');
const htmlSource = fs.readFileSync(path.join(root, 'src', 'renderer', 'index.html'), 'utf8');
const stylesSource = fs.readFileSync(path.join(root, 'src', 'renderer', 'styles.css'), 'utf8');
const PROJECT_REVISION = 'a'.repeat(64);

function plain(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function loadPreloadBridge() {
  const calls = [];
  let api = null;
  vm.runInNewContext(preloadSource, {
    require(moduleId) {
      if (moduleId === 'electron') {
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
            send() {}, on() {}, removeListener() {}, removeAllListeners() {}
          }
        };
      }
      throw new Error(`Unexpected preload dependency: ${moduleId}`);
    },
    console
  }, { filename: path.join(root, 'preload.js') });
  return { api, calls };
}

function rendererExports() {
  const window = {};
  vm.runInNewContext(controllerSource, { console, window }, { filename: controllerPath });
  return window.SyncShowPrepare;
}

function functionSource(source, name) {
  const markers = [`function ${name}(`, `async function ${name}(`];
  const start = markers
    .map(marker => source.indexOf(marker))
    .filter(index => index >= 0)
    .sort((left, right) => left - right)[0];
  assert.notEqual(start, undefined, `${name} must exist`);
  const tail = source.slice(start + 1);
  const next = tail.match(/\n\s*(?:async\s+)?function\s+[A-Za-z_$][\w$]*\s*\(/u);
  return source.slice(
    start,
    next ? start + 1 + next.index : source.length
  );
}

function executeFunctions(source, names, context, exports) {
  const declarations = names.map(name => functionSource(source, name)).join('\n');
  const exportSource = exports
    .map(name => `${JSON.stringify(name)}: ${name}`)
    .join(',');
  vm.runInNewContext(
    `${declarations}\nglobalThis.testExports = {${exportSource}};`,
    context,
    { filename: 'linked-sermon-service-sources-ui-test.js' }
  );
  return context.testExports;
}

class FakeRendererElement {
  constructor(document, tagName = 'div') {
    this.ownerDocument = document;
    this.tagName = String(tagName).toUpperCase();
    this.attributes = new Map();
    this.children = [];
    this.dataset = {};
    this.hidden = false;
    this.checked = false;
    this.disabled = false;
    this.open = false;
    this.value = '';
    this._textContent = '';
  }

  get textContent() {
    return this._textContent;
  }

  set textContent(value) {
    this._textContent = String(value);
    this.children = [];
  }

  setAttribute(name, value) {
    this.attributes.set(name, String(value));
  }

  removeAttribute(name) {
    this.attributes.delete(name);
  }

  append(...children) {
    this.children.push(...children);
  }

  appendChild(child) {
    this.children.push(child);
    return child;
  }

  replaceChildren(...children) {
    this.children = [...children];
    this._textContent = '';
  }

  contains(target) {
    return this === target || this.children.some(child =>
      typeof child?.contains === 'function' && child.contains(target));
  }

  focus() {
    this.ownerDocument.activeElement = this;
  }

  showModal() {
    this.open = true;
  }

  close() {
    this.open = false;
  }

  reset() {}
}

function fakeRendererDocument() {
  const document = {
    activeElement: null,
    createElement(tagName) {
      return new FakeRendererElement(document, tagName);
    }
  };
  return document;
}

function fakeRendererTimers() {
  const callbacks = new Map();
  let nextId = 1;
  return {
    window: {
      setTimeout(callback, delay = 0) {
        const id = nextId++;
        callbacks.set(id, { callback, delay });
        return id;
      },
      clearTimeout(id) {
        callbacks.delete(id);
      }
    },
    runNext() {
      const first = callbacks.entries().next().value;
      if (!first) return false;
      const [id, timer] = first;
      callbacks.delete(id);
      timer.callback();
      return true;
    },
    pending() {
      return [...callbacks.values()];
    }
  };
}

function visibleFakeText(element) {
  return [
    element?._textContent || '',
    ...(element?.children || []).map(visibleFakeText)
  ].filter(Boolean).join(' ');
}

function sourceBetween(startMarker, endMarker) {
  const start = mainSource.indexOf(startMarker);
  assert.notEqual(start, -1, `${startMarker} must be implemented`);
  const end = mainSource.indexOf(endMarker, start + startMarker.length);
  assert.notEqual(end, -1, `${endMarker} must follow ${startMarker}`);
  return mainSource.slice(start, end);
}

function packetManifest(overrides = {}) {
  return {
    schemaVersion: 1,
    id: '2026-07-26-main',
    name: 'Sunday Service',
    profileId: 'main-sanctuary',
    serviceDate: '2026-07-26',
    createdAt: '2026-07-26T14:00:00.000Z',
    inputs: {
      english: {
        roleId: 'english', assetId: 'asset-eng', sourceName: '07-26 ENG.pptx',
        pinnedPath: '/private/pinned/english.pptx', size: 1001, sha256: 'a'.repeat(64)
      },
      russian: {
        roleId: 'russian', assetId: 'asset-rus', sourceName: '07-26 RUS.pptx',
        pinnedPath: '/private/pinned/russian.pptx', size: 1002, sha256: 'b'.repeat(64)
      },
      media: {
        roleId: 'media', assetId: 'asset-media', sourceName: '07-26 Media.pptx',
        pinnedPath: '/private/pinned/media.pptx', size: 1003, sha256: 'c'.repeat(64)
      }
    },
    ...overrides
  };
}

function manuscript(overrides = {}) {
  return {
    fileName: 'Prayer Notes.pdf', mediaType: 'application/pdf',
    sha256: 'd'.repeat(64), sizeBytes: 4096, defaultKind: 'manuscript', ...overrides
  };
}

function hasLocalPath(value) {
  if (typeof value === 'string') return value.includes('/private/') || value.includes('\\\\');
  if (!value || typeof value !== 'object') return false;
  return Object.values(value).some(hasLocalPath);
}

function linkedSermonDocument(overrides = {}) {
  return {
    schemaVersion: SERMON_SCHEMA_VERSION,
    kind: 'syncshow-sermon',
    id: 'sermon-community',
    titles: { en: 'The Prayer That Transforms the Church' },
    defaultLanguage: 'en',
    speaker: { id: null, name: 'Paul Lvutin' },
    serviceDate: '2026-07-26',
    series: null,
    outline: [],
    sources: [],
    references: [{
      id: 'primary-ephesians-3',
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
    },
    body: [],
    ...overrides
  };
}

function linkedSermonProject({
  sermon = linkedSermonDocument(),
  sourceServiceSet = null
} = {}) {
  const base = addGroupItem(createServiceProject({
    id: 'service-2026-07-26',
    title: 'Sunday Service',
    serviceDate: '2026-07-26',
    profileId: 'main-sanctuary'
  }), {
    id: 'sermon',
    title: 'Sermon',
    groupKind: 'sermon'
  });
  const added = addSermonResource(base, sermon, {
    provider: 'local-sermon-library',
    itemId: sermon.id,
    revision: sermonDocumentSha256(sermon)
  });
  let project = setSermonSourceLink(added.project, {
    itemId: 'sermon',
    sermonResourceId: added.resourceId,
    sermonSectionId: null
  });
  if (sourceServiceSet) {
    project = bindProjectToServiceSet(project, sourceServiceSet);
  }
  return project;
}

function reviewedPacketSources() {
  let generated = 0;
  const plan = buildServiceSermonPacketSourcePlan({
    manifest: packetManifest(),
    manuscript: manuscript(),
    manuscriptPath: '/private/reviewed/Prayer Notes.pdf',
    manuscriptLanguages: ['en'],
    manuscriptProvidedBy: 'Paul Lvutin',
    receivedAt: '2026-07-26T15:00:00.000Z',
    createSourceId: () => `reviewed-source-${++generated}`
  });
  return plan.importPlans.map(entry => ({
    id: entry.importOptions.id,
    kind: entry.importOptions.kind,
    fileName: entry.expected.fileName,
    mediaType: entry.expected.mediaType,
    sha256: entry.expected.sha256,
    sizeBytes: entry.expected.sizeBytes,
    languages: [...entry.importOptions.languages],
    provenance: { ...entry.importOptions.provenance }
  }));
}

function loadServicePacketHandlers({
  currentManifest = packetManifest(),
  inspectedManuscript = manuscript(),
  onImport = () => {},
  transformImported = imported => imported,
  onCommit = () => {},
  onProjectSave = () => {},
  proposalLimit = 20,
  project = addGroupItem(createServiceProject({
    id: 'service-2026-07-26', title: 'Sunday Service',
    serviceDate: '2026-07-26', profileId: 'main-sanctuary'
  }), { id: 'sermon', title: 'Sermon', groupKind: 'sermon' })
} = {}) {
  const handlers = new Map();
  const proposals = new Map();
  const linkedSourceProposals = new Map();
  const events = [];
  let generated = 0;
  const failMainOperation = (code, message, details = {}) => {
    const error = new Error(message);
    error.code = code;
    error.details = details;
    throw error;
  };
  const prepareText = (value, _label, maximum, { required = false } = {}) => {
    if (value === undefined || value === null) value = '';
    if (typeof value !== 'string') failMainOperation('INVALID_PREPARE_TEXT', 'not text');
    const normalized = value.trim();
    if (required && !normalized) failMainOperation('MISSING_PREPARE_TEXT', 'missing');
    if (normalized.length > maximum) failMainOperation('PREPARE_TEXT_TOO_LONG', 'long');
    return normalized;
  };
  const serviceSource = sourceBetween(
    'function serviceSermonPacketReadingMode',
    "ipcMain.handle('prepare:projects:createSermonPacket'"
  );
  const bibleOutputHelpers = sourceBetween(
    'function prepareBibleOutputSelections',
    "\nipcMain.handle('prepare:projects:addBible'"
  );
  const projectedBibleLibrary = new BibleLibrary({ maxVerses: 8 });
  vm.runInNewContext(`${bibleOutputHelpers}\n${serviceSource}`, {
    ipcMain: { handle(channel, handler) { handlers.set(channel, handler); } },
    serviceSermonPacketProposals: proposals,
    linkedServiceSermonSourceProposals: linkedSourceProposals,
    SERVICE_SERMON_PACKET_PROPOSAL_LIMIT: proposalLimit,
    SERVICE_SERMON_PACKET_PROPOSAL_TTL_MS: 15 * 60 * 1000,
    LINKED_SERVICE_SERMON_SOURCE_PROPOSAL_LIMIT: proposalLimit,
    LINKED_SERVICE_SERMON_SOURCE_PROPOSAL_TTL_MS: 15 * 60 * 1000,
    crypto: require('node:crypto'),
    requireControlSender(event) {
      if (event?.trusted !== true) failMainOperation('UNTRUSTED_SENDER', 'untrusted');
    },
    requirePrepareRequest() {},
    requireExactPrepareKeys(request, keys) {
      const unknown = Object.keys(request).filter(key => !keys.includes(key));
      if (unknown.length) failMainOperation('INVALID_PREPARE_REQUEST', 'unknown keys');
    },
    async readExpectedProject(request) {
      if (request.projectId !== project.id || request.expectedRevisionId !== PROJECT_REVISION) {
        failMainOperation('STALE_PROJECT', 'stale');
      }
      return {
        project, projectId: project.id, expectedRevisionId: PROJECT_REVISION,
        services: {
          localSermonLibrary: {
            async readCurrent(sermonId) {
              const resource = Object.values(project.resources).find(candidate =>
                candidate.kind === 'sermon'
                && candidate.document.id === sermonId);
              if (!resource) {
                const error = new Error('missing sermon');
                error.code = 'SERMON_NOT_FOUND';
                throw error;
              }
              return {
                sermon: resource.document,
                revision: resource.sha256
              };
            }
          },
          localSermonSourceStore: {
            async inspectFile() { events.push('inspect'); return inspectedManuscript; },
            async importFile(options) {
              events.push(`import:${options.id}`);
              await onImport(options);
              const serviceInput = options.kind === 'slide-notes'
                ? Object.values(currentManifest.inputs).find(input => input.pinnedPath === options.sourcePath)
                : null;
              const expectedSha = serviceInput?.sha256 || inspectedManuscript.sha256;
              const expectedSize = serviceInput?.size || inspectedManuscript.sizeBytes;
              return transformImported({
                objectId: `sha256:${expectedSha}`,
                source: {
                  id: options.id,
                  kind: options.kind,
                  fileName: options.fileName || serviceInput?.sourceName || inspectedManuscript.fileName,
                  mediaType: options.kind === 'slide-notes'
                    ? 'application/vnd.openxmlformats-officedocument.presentationml.presentation'
                    : inspectedManuscript.mediaType,
                  sha256: expectedSha,
                  sizeBytes: expectedSize,
                  languages: [...options.languages], provenance: { ...options.provenance }
                }
              }, options);
            }
          },
          sermonProjectCommitCoordinator: {
            async commit(options) {
              events.push('commit'); onCommit(options);
              return {
                project: {
                  project: options.project,
                  revisionId: 'f'.repeat(64),
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
          },
          serviceProjectStore: {
            async save(nextProject, options) {
              events.push('project-save');
              onProjectSave(nextProject, options);
              return {
                project: nextProject,
                revisionId: 'e'.repeat(64),
                unchanged: false,
                recovery: null
              };
            }
          }
        }
      };
    },
    prepareId(value) { return String(value); },
    prepareText,
    prepareLanguageTags(value) {
      if (!Array.isArray(value) || !value.length) failMainOperation('INVALID_LANGUAGE', 'languages');
      return [...new Set(value.map(item => String(item).trim().toLowerCase()))].sort();
    },
    async resolveSermonPrimaryReferenceLookupRequest(request) {
      if (request.query !== 'Ephesians 3:14-21') return { status: 'error', message: 'bad' };
      return new BibleLibrary({ maxVerses: 100 }).lookup(request.query, { translationId: 'BSB' });
    },
    async resolveBibleLookupRequest(request) {
      return projectedBibleLibrary.lookup(request.query, {
        translationId: request.translationId,
        ...(request.selectedBook ? { selectedBook: request.selectedBook } : {})
      });
    },
    resolveBookId,
    failMainOperation,
    failServiceSermonPacket(error) { failMainOperation('SERVICE_SERMON_PACKET_UNAVAILABLE', error.message); },
    failSermonSourceImport(error) { failMainOperation('SERMON_SOURCE_IMPORT_FAILED', error.code || 'unknown'); },
    readCurrentServiceSet: async () => currentManifest,
    getServiceSetRoot() { return '/private/service-root'; },
    dialog: { async showOpenDialog() { return { canceled: false, filePaths: ['/private/reviewed/Prayer Notes.pdf'] }; } },
    controlWindow: {},
    buildServiceSermonPacketSourcePlan,
    importedSourceMatchesPlan,
    serviceSermonPacketSourceDispositions,
    serviceSetFingerprint,
    projectItemId(prefix) { generated += 1; return `${prefix}-${generated}`; },
    isSermonSourceTarget,
    resolveSermonSourceLink,
    SERMON_SCHEMA_VERSION,
    sermonDocumentSha256,
    addSermonResource,
    setSermonSourceLink,
    analyzeSermonPrimaryReading,
    addBibleItem,
    placeBibleReadingItemsBefore,
    bindProjectToServiceSet,
    isPowerPointCompanionProject,
    upgradeSermonDocument,
    repinSermonRevision,
    bibleLibrary: {
      maxVerses: projectedBibleLibrary.maxVerses,
      lookupCanonicalRange(range, options) {
        return projectedBibleLibrary.lookupCanonicalRange(
          plain(range),
          plain(options)
        );
      }
    },
    projectResult(result) {
      return {
        project: result.project,
        revisionId: result.revisionId,
        unchanged: result.unchanged === true,
        recovery: null
      };
    },
    Date,
    console
  }, { filename: 'service-sermon-packet-handlers.js' });
  return {
    handlers,
    events,
    proposals,
    linkedSourceProposals,
    project
  };
}

test('service sermon-packet preload forwards only reviewed proposal and commit fields', async () => {
  const { api, calls } = loadPreloadBridge();
  await api.proposeServiceSermonPacket({
    projectId: 'service-2026-07-26',
    expectedRevisionId: PROJECT_REVISION,
    itemId: 'sermon',
    title: 'The Prayer That Transforms the Church',
    speakerName: 'Paul Lvutin',
    defaultLanguage: 'en',
    primaryReference: 'Ephesians 3:14-21',
    selectedBook: 'Ephesians',
    manuscriptLanguages: ['en', 'ru'],
    readingMode: 'insert-native',
    readingOutputs: [
      { channelId: 'primary', mode: 'translation', translationId: 'BSB' },
      { channelId: 'secondary', mode: 'translation', translationId: 'LSV' },
      { channelId: 'media', mode: 'hidden', passage: { hostile: true } }
    ],
    path: '/private/sermon.pdf',
    filePath: '/private/sermon.docx',
    sources: [{ path: '/private/deck.pptx' }]
  });
  await api.commitServiceSermonPacket({
    proposalToken: 'opaque-proposal',
    confirmed: true,
    projectId: 'renderer-owned',
    sourcePath: '/private/sermon.pdf'
  });
  await api.proposeLinkedSermonServiceSources({
    projectId: 'service-2026-07-26',
    expectedRevisionId: PROJECT_REVISION,
    itemId: 'sermon',
    manuscriptLanguages: ['en', 'ru'],
    sermonId: 'renderer-owned',
    sourcePath: '/private/sermon.pdf'
  });
  await api.commitLinkedSermonServiceSources({
    proposalToken: 'opaque-linked-proposal',
    confirmed: true,
    projectId: 'renderer-owned',
    sourcePath: '/private/sermon.pdf'
  });
  assert.deepEqual(calls, [
    {
      channel: 'prepare:projects:proposeServiceSermonPacket',
      payload: {
        projectId: 'service-2026-07-26',
        expectedRevisionId: PROJECT_REVISION,
        itemId: 'sermon',
        title: 'The Prayer That Transforms the Church',
        speakerName: 'Paul Lvutin',
        defaultLanguage: 'en',
        primaryReference: 'Ephesians 3:14-21',
        selectedBook: 'Ephesians',
        manuscriptLanguages: ['en', 'ru'],
        readingMode: 'insert-native',
        readingOutputs: [
          { channelId: 'primary', mode: 'translation', translationId: 'BSB' },
          { channelId: 'secondary', mode: 'translation', translationId: 'LSV' },
          { channelId: 'media', mode: 'hidden' }
        ]
      }
    },
    {
      channel: 'prepare:projects:commitServiceSermonPacket',
      payload: { proposalToken: 'opaque-proposal', confirmed: true }
    },
    {
      channel: 'prepare:projects:proposeLinkedSermonServiceSources',
      payload: {
        projectId: 'service-2026-07-26',
        expectedRevisionId: PROJECT_REVISION,
        itemId: 'sermon',
        manuscriptLanguages: ['en', 'ru']
      }
    },
    {
      channel: 'prepare:projects:commitLinkedSermonServiceSources',
      payload: {
        proposalToken: 'opaque-linked-proposal',
        confirmed: true
      }
    }
  ]);
});

test('service sermon-packet review is path-free and keeps a safe source-less fallback', () => {
  for (const id of [
    'createSermonPacketManuscriptLanguages',
    'btnReviewServiceSermonPacket',
    'createSermonPacketSourcesStatus',
    'createSermonPacketSources'
  ]) {
    assert.match(htmlSource, new RegExp(`id="${id}"`));
  }
  assert.match(htmlSource, /Files are copied, never moved, and slide wording is not changed\./);
  assert.match(htmlSource, /id="createSermonPacketAddReading" type="checkbox"/);
  assert.doesNotMatch(htmlSource, /id="createSermonPacketAddReading" type="checkbox" checked/);
  assert.match(controllerSource, /source\?\.fileName/);
  assert.doesNotMatch(controllerSource, /source\?\.(?:path|filePath|sourcePath)/);
  assert.match(controllerSource, /serviceSermonPacketProposalExpired/);
  assert.match(controllerSource, /invalidateSermonPacketProposal/);
  assert.match(controllerSource, /clearSermonPacketProposal/);
  assert.match(controllerSource, /if \(reviewed === null\) return false;/);
  assert.match(controllerSource, /proposal\s*\? async \(\) => checkedResult\(await api\.commitServiceSermonPacket/);
  assert.match(controllerSource, /: \(\) => api\.createSermonPacketForServiceItem/);
  assert.match(
    controllerSource,
    /readingMode: addPrimaryReading\s*\? 'insert-native'\s*: 'already-in-service'/
  );
  assert.match(
    controllerSource,
    /readingOutputs:\s*cloneBibleOutputSelections\(readingOutputs\)/
  );
  assert.doesNotMatch(mainSource, /inserted as native BSB cues/);
  assert.match(
    mainSource,
    /inserted as native Bible cues using the reviewed output treatments/
  );
});

test('reviewed sermon-packet confirmation preserves and displays the exact dense Bible output plan', () => {
  const project = {
    channelIds: ['primary', 'secondary', 'media'],
    channels: {
      primary: { label: 'Sanctuary Wall' },
      secondary: { label: 'Livestream English' },
      media: { label: 'Confidence North' }
    }
  };
  const expected = [
    { channelId: 'primary', mode: 'translation', translationId: 'BSB' },
    { channelId: 'secondary', mode: 'translation', translationId: 'LSV' },
    { channelId: 'media', mode: 'hidden' }
  ];
  const payload = {
    proposalToken: 'x'.repeat(32),
    expiresAt: '2026-07-26T16:00:00.000Z',
    serviceSet: {
      id: 'service-set',
      name: 'Sunday Service',
      serviceDate: '2026-07-26'
    },
    sermon: {
      title: 'Prayer',
      speakerName: 'Paul',
      defaultLanguage: 'en',
      primaryReference: 'Ephesians 3:14-21',
      readingMode: 'insert-native',
      readingOutputs: expected
    },
    sources: []
  };
  const {
    normalizeServiceSermonPacketProposal
  } = rendererExports();
  const normalized = normalizeServiceSermonPacketProposal(
    payload,
    project,
    expected
  );
  assert.deepEqual(
    plain(normalized.sermon.readingOutputs),
    expected
  );

  const document = fakeRendererDocument();
  const elements = {
    sermonPacketSources: document.createElement('ul'),
    sermonPacketSourcesStatus: document.createElement('p')
  };
  const state = {
    currentProject: project,
    sermonPacketProposal: normalized
  };
  const { renderSermonPacketProposal } = executeFunctions(
    controllerSource,
    [
      'normalizeSermonReadingOutputs',
      'sermonReadingOutputReviewText',
      'renderSermonPacketProposal'
    ],
    { state, elements },
    ['renderSermonPacketProposal']
  );
  renderSermonPacketProposal();
  assert.match(
    elements.sermonPacketSourcesStatus.textContent,
    /exact output plan: Sanctuary Wall — BSB; Livestream English — LSV; Confidence North — Hidden/
  );
});

test('reviewed sermon-packet confirmation fails closed on malformed or mismatched Bible output plans', () => {
  const project = {
    channelIds: ['primary', 'secondary', 'media'],
    channels: {
      primary: { label: 'Primary' },
      secondary: { label: 'Secondary' },
      media: { label: 'Media' }
    }
  };
  const expected = [
    { channelId: 'primary', mode: 'translation', translationId: 'BSB' },
    { channelId: 'secondary', mode: 'translation', translationId: 'LSV' },
    { channelId: 'media', mode: 'hidden' }
  ];
  const base = {
    proposalToken: 'x'.repeat(32),
    expiresAt: '2026-07-26T16:00:00.000Z',
    serviceSet: {
      id: 'service-set',
      name: 'Sunday Service',
      serviceDate: '2026-07-26'
    },
    sermon: {
      title: 'Prayer',
      speakerName: 'Paul',
      defaultLanguage: 'en',
      primaryReference: 'Ephesians 3:14-21',
      readingMode: 'insert-native',
      readingOutputs: expected
    },
    sources: []
  };
  const {
    normalizeServiceSermonPacketProposal
  } = rendererExports();
  const rejectOutputPlan = readingOutputs => assert.throws(
    () => normalizeServiceSermonPacketProposal(
      {
        ...base,
        sermon: {
          ...base.sermon,
          readingOutputs
        }
      },
      project,
      expected
    ),
    /did not preserve the exact Bible output plan/
  );

  rejectOutputPlan([
    expected[0],
    { ...expected[1], translationId: 'BSB' },
    expected[2]
  ]);
  rejectOutputPlan([
    { ...expected[0], passage: { hostile: true } },
    expected[1],
    expected[2]
  ]);
  rejectOutputPlan([
    { ...expected[0], translationId: 'bsb' },
    expected[1],
    expected[2]
  ]);
  rejectOutputPlan(undefined);

  const allHidden = project.channelIds.map(channelId => ({
    channelId,
    mode: 'hidden'
  }));
  assert.throws(
    () => normalizeServiceSermonPacketProposal(
      {
        ...base,
        sermon: {
          ...base.sermon,
          readingOutputs: allHidden
        }
      },
      project,
      allHidden
    ),
    /did not preserve the exact Bible output plan/
  );
  assert.throws(
    () => normalizeServiceSermonPacketProposal(
      {
        ...base,
        sermon: {
          ...base.sermon,
          readingMode: 'already-in-service'
        }
      },
      project,
      null
    ),
    /invalid Bible reading choice/
  );

  const existingReading = normalizeServiceSermonPacketProposal(
    {
      ...base,
      sermon: {
        ...base.sermon,
        readingMode: 'already-in-service',
        readingOutputs: undefined
      }
    },
    project,
    null
  );
  assert.equal(existingReading.sermon.readingMode, 'already-in-service');
  assert.equal(existingReading.sermon.readingOutputs, undefined);
});

test('linked-sermon weekly source review has a dedicated path-free human confirmation surface', () => {
  for (const id of [
    'btnReviewLinkedSermonServiceSources',
    'linkedSermonServiceSourcesDialog',
    'linkedSermonServiceSourcesLanguages',
    'btnProposeLinkedSermonServiceSources',
    'linkedSermonServiceSourcesList',
    'linkedSermonServiceSourcesConfirmed',
    'btnCommitLinkedSermonServiceSources'
  ]) {
    assert.match(htmlSource, new RegExp(`id="${id}"`));
  }
  assert.match(
    htmlSource,
    /it will not create another sermon, change the reading, build slides, or contact Community/
  );
  assert.match(
    htmlSource,
    /id="linkedSermonServiceSourcesDialog" class="prepare-dialog prepare-dialog-wide linked-sermon-service-sources-dialog"/
  );
  assert.match(
    htmlSource,
    /id="linkedSermonServiceSourcesList" class="prepare-linked-sermon-source-list"[^>]+tabindex="0"/
  );
  assert.match(htmlSource, /SHA-256 prefix, and add or reuse decision/);
  assert.match(
    stylesSource,
    /\.prepare-linked-sermon-source-list\s*\{[^}]*max-height:[^}]*overflow: auto;/s
  );
  const linkedReviewDisabledSource = controllerSource.slice(
    controllerSource.indexOf(
      'elements.btnProposeLinkedSermonServiceSources.disabled ='
    ),
    controllerSource.indexOf(
      'elements.btnProposeLinkedSermonServiceSources.textContent ='
    )
  );
  assert.doesNotMatch(
    linkedReviewDisabledSource,
    /parseSermonSourceLanguages/,
    'invalid language input must remain actionable so its visible validation can run'
  );
  assert.match(
    controllerSource,
    /api\.proposeLinkedSermonServiceSources\(\{\s*projectId: context\.projectId,\s*expectedRevisionId: context\.revisionId,\s*itemId: context\.itemId,\s*manuscriptLanguages/s
  );
  assert.match(
    controllerSource,
    /api\.commitLinkedSermonServiceSources\(\{\s*proposalToken: proposal\.proposalToken,\s*confirmed: true/s
  );
  assert.doesNotMatch(
    controllerSource,
    /api\.proposeLinkedSermonServiceSources\(\{[\s\S]{0,500}(?:path|filePath|sourcePath|sermonId|sermonRevisionId)\s*:/
  );

  const { normalizeLinkedSermonServiceSourcesProposal } = rendererExports();
  const normalized = normalizeLinkedSermonServiceSourcesProposal({
    proposalToken: 'x'.repeat(32),
    expiresAt: '2026-07-26T16:00:00.000Z',
    serviceSet: {
      id: 'service-set',
      name: 'Sunday Service',
      serviceDate: '2026-07-26',
      path: '/private/service'
    },
    sermon: {
      title: 'Prayer',
      speakerName: 'Paul',
      sourcePath: '/private/sermon'
    },
    sources: [{
      key: 'service:english',
      disposition: 'add',
      roleId: 'english',
      roleLabel: 'English',
      fileName: 'service.pptx',
      kind: 'slide-notes',
      languages: ['en'],
      sha256: 'a'.repeat(64),
      sizeBytes: 1024,
      sourcePath: '/private/service.pptx'
    }]
  });
  assert.equal(hasLocalPath(normalized), false);
  assert.equal(normalized.sources[0].disposition, 'add');
  assert.throws(
    () => normalizeLinkedSermonServiceSourcesProposal({
      ...normalized,
      sources: [{ ...normalized.sources[0], disposition: 'replace' }]
    }),
    /invalid action/
  );
  assert.throws(
    () => normalizeLinkedSermonServiceSourcesProposal({
      ...normalized,
      sources: [{ ...normalized.sources[0], sha256: 'not-a-checksum' }]
    }),
    /invalid metadata/
  );
});

test('linked-sermon source dialog preserves runtime safety copy and validates language input live', () => {
  const document = fakeRendererDocument();
  const timers = fakeRendererTimers();
  const elements = {
    linkedSermonServiceSourcesList: document.createElement('ul'),
    linkedSermonServiceSourcesConfirmationField: document.createElement('label'),
    linkedSermonServiceSourcesConfirmed: document.createElement('input'),
    linkedSermonServiceSourcesStatus: document.createElement('p'),
    linkedSermonServiceSourcesForm: document.createElement('form'),
    linkedSermonServiceSourcesError: document.createElement('p'),
    linkedSermonServiceSourcesLanguages: document.createElement('input'),
    linkedSermonServiceSourcesSermonSummary: document.createElement('p'),
    linkedSermonServiceSourcesDescription: document.createElement('p'),
    linkedSermonServiceSourcesDialog: document.createElement('dialog')
  };
  const state = {
    mutationBusy: false,
    publishBusy: false,
    linkedSermonServiceSourcesProposalBusy: false,
    linkedSermonServiceSourcesCommitBusy: false,
    linkedSermonServiceSourcesExpiryTimer: null,
    linkedSermonServiceSourcesProposal: null,
    linkedSermonServiceSourcesContext: null
  };
  let controlUpdates = 0;
  const context = {
    document,
    window: timers.window,
    state,
    elements,
    selectedLinkedSermonServiceSourcesContext: () => ({
      projectId: 'service',
      revisionId: 'a'.repeat(64),
      itemId: 'sermon',
      resourceId: 'resource',
      resourceOwnerId: 'owner',
      sermonId: 'sermon-id',
      sermonRevisionId: 'b'.repeat(64),
      title: 'The Prayer That Transforms the Church',
      speakerName: 'Paul',
      defaultLanguage: 'en'
    }),
    updateControlStates() {
      controlUpdates += 1;
    }
  };
  const {
    openLinkedSermonServiceSourcesDialog,
    updateLinkedSermonServiceSourcesDraft
  } = executeFunctions(
    controllerSource,
    [
      'parseSermonSourceLanguages',
      'setDialogError',
      'clearLinkedSermonServiceSourcesExpiryTimer',
      'setLinkedSermonServiceSourcesStatus',
      'clearLinkedSermonServiceSourcesProposal',
      'resetLinkedSermonServiceSourcesReview',
      'openLinkedSermonServiceSourcesDialog',
      'updateLinkedSermonServiceSourcesDraft'
    ],
    context,
    [
      'openLinkedSermonServiceSourcesDialog',
      'updateLinkedSermonServiceSourcesDraft'
    ]
  );

  openLinkedSermonServiceSourcesDialog();
  assert.equal(elements.linkedSermonServiceSourcesDialog.open, true);
  assert.match(
    elements.linkedSermonServiceSourcesDescription.textContent,
    /will not create another sermon, change the reading, build slides, or contact Community/
  );
  assert.equal(elements.linkedSermonServiceSourcesLanguages.value, 'en');
  assert.equal(timers.runNext(), true);
  assert.equal(document.activeElement, elements.linkedSermonServiceSourcesLanguages);

  elements.linkedSermonServiceSourcesLanguages.value = 'english';
  updateLinkedSermonServiceSourcesDraft();
  assert.equal(
    elements.linkedSermonServiceSourcesLanguages.attributes.get('aria-invalid'),
    'true'
  );
  assert.equal(elements.linkedSermonServiceSourcesError.hidden, false);
  assert.match(elements.linkedSermonServiceSourcesError.textContent, /BCP-47/);

  elements.linkedSermonServiceSourcesLanguages.value = 'en, ru';
  updateLinkedSermonServiceSourcesDraft();
  assert.equal(
    elements.linkedSermonServiceSourcesLanguages.attributes.get('aria-invalid'),
    'false'
  );
  assert.equal(elements.linkedSermonServiceSourcesError.hidden, true);
  assert.ok(controlUpdates >= 3);
});

test('linked-sermon source review renders leading add and reuse evidence without overclaiming its checksum', () => {
  const document = fakeRendererDocument();
  const elements = {
    linkedSermonServiceSourcesList: document.createElement('ul'),
    linkedSermonServiceSourcesConfirmationField: document.createElement('label'),
    linkedSermonServiceSourcesStatus: document.createElement('p')
  };
  const state = {
    linkedSermonServiceSourcesProposal: {
      expiresAt: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
      serviceSet: { name: 'Sunday Service' },
      sources: [
        {
          disposition: 'add',
          roleLabel: 'English slides',
          fileName: 'a-very-long-reviewed-service-file-name.pptx',
          languages: ['en'],
          sha256: 'a'.repeat(64),
          sizeBytes: 1536
        },
        {
          disposition: 'reuse',
          roleLabel: 'Pastor manuscript',
          fileName: 'sermon-notes.pdf',
          languages: ['en', 'ru'],
          sha256: 'b'.repeat(64),
          sizeBytes: 2 * 1024 * 1024
        }
      ]
    }
  };
  const { renderLinkedSermonServiceSourcesProposal } = executeFunctions(
    controllerSource,
    [
      'createElement',
      'serviceSermonPacketSourceSize',
      'setLinkedSermonServiceSourcesStatus',
      'renderLinkedSermonServiceSourcesProposal'
    ],
    { document, state, elements },
    ['renderLinkedSermonServiceSourcesProposal']
  );

  renderLinkedSermonServiceSourcesProposal();
  assert.equal(elements.linkedSermonServiceSourcesList.hidden, false);
  assert.equal(elements.linkedSermonServiceSourcesConfirmationField.hidden, false);
  assert.equal(elements.linkedSermonServiceSourcesList.children.length, 2);
  const [addRow, reuseRow] = elements.linkedSermonServiceSourcesList.children;
  assert.equal(addRow.children[0].dataset.disposition, 'add');
  assert.equal(reuseRow.children[0].dataset.disposition, 'reuse');
  assert.match(
    visibleFakeText(addRow),
    /^ADD .*English slides.*a-very-long-reviewed-service-file-name\.pptx.*en.*1\.5 KB.*SHA-256 prefix a{12}/s
  );
  assert.match(
    visibleFakeText(reuseRow),
    /^REUSE .*Pastor manuscript.*sermon-notes\.pdf.*en, ru.*2\.0 MB.*SHA-256 prefix b{12}/s
  );
  assert.match(
    elements.linkedSermonServiceSourcesStatus.textContent,
    /1 will be added; 1 compatible copy will be reused/
  );
  assert.match(
    elements.linkedSermonServiceSourcesStatus.textContent,
    /15-minute review expires at/
  );
});

test('linked-sermon source review expiry warns, clears authority, and repairs removed-control focus', () => {
  const document = fakeRendererDocument();
  const timers = fakeRendererTimers();
  const nativeDate = Date;
  let now = Date.parse('2026-07-26T15:00:00.000Z');
  class FakeDate extends nativeDate {
    static now() {
      return now;
    }
  }
  const confirmation = document.createElement('input');
  const confirmationField = document.createElement('label');
  confirmationField.appendChild(confirmation);
  const elements = {
    linkedSermonServiceSourcesList: document.createElement('ul'),
    linkedSermonServiceSourcesConfirmationField: confirmationField,
    linkedSermonServiceSourcesConfirmed: confirmation,
    linkedSermonServiceSourcesStatus: document.createElement('p'),
    linkedSermonServiceSourcesDialog: document.createElement('dialog'),
    btnCommitLinkedSermonServiceSources: document.createElement('button'),
    btnProposeLinkedSermonServiceSources: document.createElement('button')
  };
  elements.linkedSermonServiceSourcesDialog.open = true;
  elements.linkedSermonServiceSourcesList.hidden = false;
  elements.linkedSermonServiceSourcesConfirmationField.hidden = false;
  elements.linkedSermonServiceSourcesConfirmed.checked = true;
  const state = {
    linkedSermonServiceSourcesExpiryTimer: null,
    linkedSermonServiceSourcesProposal: {
      expiresAt: new FakeDate(now + 100).toISOString()
    }
  };
  let controlUpdates = 0;
  const { scheduleLinkedSermonServiceSourcesExpiry } = executeFunctions(
    controllerSource,
    [
      'serviceSermonPacketProposalExpired',
      'clearLinkedSermonServiceSourcesExpiryTimer',
      'setLinkedSermonServiceSourcesStatus',
      'clearLinkedSermonServiceSourcesProposal',
      'linkedSermonServiceSourcesReviewContainsFocus',
      'focusLinkedSermonServiceSourcesReviewAgain',
      'scheduleLinkedSermonServiceSourcesExpiry'
    ],
    {
      Date: FakeDate,
      document,
      window: timers.window,
      state,
      elements,
      updateControlStates() {
        controlUpdates += 1;
        elements.btnCommitLinkedSermonServiceSources.disabled =
          !state.linkedSermonServiceSourcesProposal;
      }
    },
    ['scheduleLinkedSermonServiceSourcesExpiry']
  );

  confirmation.focus();
  scheduleLinkedSermonServiceSourcesExpiry();
  assert.equal(timers.pending().length, 1);
  now += 200;
  assert.equal(timers.runNext(), true);
  assert.equal(state.linkedSermonServiceSourcesProposal, null);
  assert.equal(elements.linkedSermonServiceSourcesList.hidden, true);
  assert.equal(elements.linkedSermonServiceSourcesConfirmationField.hidden, true);
  assert.equal(elements.linkedSermonServiceSourcesConfirmed.checked, false);
  assert.equal(elements.linkedSermonServiceSourcesStatus.dataset.kind, 'warning');
  assert.match(
    elements.linkedSermonServiceSourcesStatus.textContent,
    /expired before anything was copied/
  );
  assert.equal(elements.btnCommitLinkedSermonServiceSources.disabled, true);
  assert.equal(controlUpdates, 1);
  assert.equal(timers.runNext(), true);
  assert.equal(
    document.activeElement,
    elements.btnProposeLinkedSermonServiceSources
  );
});

test('service sermon-packet expiry and filename projection cannot reveal a local source location', () => {
  const { serviceSermonPacketProposalExpired, serviceSermonPacketSourceFileName } = rendererExports();
  assert.equal(serviceSermonPacketProposalExpired({ expiresAt: '2026-07-26T09:00:00.000Z' }, Date.parse('2026-07-26T10:00:00.000Z')), true);
  assert.equal(serviceSermonPacketProposalExpired({ expiresAt: '2026-07-26T11:00:00.000Z' }, Date.parse('2026-07-26T10:00:00.000Z')), false);
  assert.equal(serviceSermonPacketSourceFileName('/private/church/sermon.pdf'), 'sermon.pdf');
  assert.equal(serviceSermonPacketSourceFileName('C:\\Church\\sermon.docx'), 'sermon.docx');
});

test('proposal and commit handlers accept only their reviewed protocol, trusted sender, and explicit confirmation', async () => {
  const { handlers } = loadServicePacketHandlers();
  const propose = handlers.get('prepare:projects:proposeServiceSermonPacket');
  const commit = handlers.get('prepare:projects:commitServiceSermonPacket');
  assert.equal(typeof propose, 'function');
  assert.equal(typeof commit, 'function');

  await assert.rejects(
    propose({ trusted: false }, {}),
    error => error.code === 'UNTRUSTED_SENDER'
  );
  await assert.rejects(
    propose({ trusted: true }, {
      projectId: 'service-2026-07-26', expectedRevisionId: PROJECT_REVISION, itemId: 'sermon',
      title: 'Prayer', speakerName: 'Paul', defaultLanguage: 'en',
      primaryReference: 'Ephesians 3:14-21', manuscriptLanguages: ['en'],
      readingMode: 'already-in-service', path: '/private/renderer-supplied.pdf'
    }),
    error => error.code === 'INVALID_PREPARE_REQUEST'
  );
  await assert.rejects(
    commit({ trusted: true }, { proposalToken: 'x'.repeat(32), confirmed: false }),
    error => error.code === 'SERVICE_SERMON_PACKET_CONFIRMATION_REQUIRED'
  );
  await assert.rejects(
    commit({ trusted: true }, {
      proposalToken: 'x'.repeat(32), confirmed: true, projectId: 'renderer-controlled'
    }),
    error => error.code === 'INVALID_PREPARE_REQUEST'
  );
});

test('linked-sermon current-service review is main-owned, path-free, and requires explicit confirmation', async () => {
  const harness = loadServicePacketHandlers({
    project: linkedSermonProject()
  });
  const propose = harness.handlers.get(
    'prepare:projects:proposeLinkedSermonServiceSources'
  );
  const commit = harness.handlers.get(
    'prepare:projects:commitLinkedSermonServiceSources'
  );
  assert.equal(typeof propose, 'function');
  assert.equal(typeof commit, 'function');

  await assert.rejects(
    propose({ trusted: false }, {}),
    error => error.code === 'UNTRUSTED_SENDER'
  );
  await assert.rejects(
    propose({ trusted: true }, {
      projectId: 'service-2026-07-26',
      expectedRevisionId: PROJECT_REVISION,
      itemId: 'sermon',
      manuscriptLanguages: ['en'],
      sourcePath: '/private/renderer-supplied.pdf'
    }),
    error => error.code === 'INVALID_PREPARE_REQUEST'
  );
  await assert.rejects(
    commit({ trusted: true }, {
      proposalToken: 'x'.repeat(32),
      confirmed: false
    }),
    error => error.code
      === 'LINKED_SERVICE_SERMON_SOURCE_CONFIRMATION_REQUIRED'
  );

  const proposal = await propose({ trusted: true }, {
    projectId: 'service-2026-07-26',
    expectedRevisionId: PROJECT_REVISION,
    itemId: 'sermon',
    manuscriptLanguages: ['en', 'ru']
  });
  assert.equal(hasLocalPath(proposal), false);
  assert.equal(proposal.sermon.title, 'The Prayer That Transforms the Church');
  assert.deepEqual(
    plain(proposal.sources.map(source => source.disposition)),
    ['add', 'add', 'add', 'add']
  );
});

test('linked-sermon current-service commit preserves sermon and reading identities while atomically repinning the exact packet', async () => {
  let project = linkedSermonProject();
  const linkedBefore = resolveSermonSourceLink(
    project,
    project.items.sermon
  );
  const passage = (await new BibleLibrary({ maxVerses: 100 }).lookup(
    'Ephesians 3:14-21',
    { translationId: 'BSB' }
  )).passage;
  const pinnedPassage = {
    ...passage,
    bookId: 'Eph'
  };
  project = addBibleItem(project, {
    id: 'sermon-reading',
    title: 'Ephesians 3:14-21',
    range: {
      schemaVersion: 1,
      bookId: 'Eph',
      start: { chapter: 3, verse: 14 },
      end: { chapter: 3, verse: 21 }
    },
    passagesByChannel: Object.fromEntries(
      project.channelIds.map(channelId => [channelId, pinnedPassage])
    ),
    sermonReading: {
      sermonResourceId: linkedBefore.resourceId,
      referenceId: 'primary-ephesians-3',
      translationId: 'BSB',
      chunkIndex: 0,
      chunkCount: 1
    }
  });

  let committed = null;
  const harness = loadServicePacketHandlers({
    project,
    onCommit(options) {
      committed = options;
    }
  });
  const proposal = await harness.handlers.get(
    'prepare:projects:proposeLinkedSermonServiceSources'
  )({ trusted: true }, {
    projectId: project.id,
    expectedRevisionId: PROJECT_REVISION,
    itemId: 'sermon',
    manuscriptLanguages: ['en']
  });
  const result = await harness.handlers.get(
    'prepare:projects:commitLinkedSermonServiceSources'
  )({ trusted: true }, {
    proposalToken: proposal.proposalToken,
    confirmed: true
  });

  assert.ok(committed);
  assert.equal(committed.reason, 'attach-linked-sermon-service-sources');
  assert.equal(committed.sermonDocument.id, 'sermon-community');
  assert.equal(
    committed.sermonDocument.references[0].id,
    'primary-ephesians-3'
  );
  assert.equal(committed.sermonDocument.sources.length, 4);
  assert.equal(
    new Set(committed.sermonDocument.sources.map(source => source.sha256)).size,
    4
  );
  assert.equal(
    committed.project.sourceServiceSet.id,
    packetManifest().id
  );
  const linkedAfter = resolveSermonSourceLink(
    committed.project,
    committed.project.items.sermon
  );
  assert.notEqual(linkedAfter.resourceId, linkedBefore.resourceId);
  assert.equal(
    committed.project.items['sermon-reading'].sermonReading.sermonResourceId,
    linkedAfter.resourceId
  );
  assert.equal(
    committed.project.items['sermon-reading'].sermonReading.referenceId,
    'primary-ephesians-3'
  );
  assert.equal(result.addedSourceCount, 4);
  assert.equal(result.reusedSourceCount, 0);
  assert.equal(result.sourceCount, 4);
  assert.equal(result.sermonId, 'sermon-community');
  assert.equal(
    harness.events.filter(event => event.startsWith('import:')).length,
    4
  );
  assert.equal(harness.events.at(-1), 'commit');
});

test('linked-sermon current-service commit reuses exact sources and saves only a missing service-set binding', async () => {
  const sermon = linkedSermonDocument({
    sources: reviewedPacketSources()
  });
  let savedBinding = null;
  const harness = loadServicePacketHandlers({
    project: linkedSermonProject({ sermon }),
    onProjectSave(project, options) {
      savedBinding = { project, options };
    }
  });
  const proposal = await harness.handlers.get(
    'prepare:projects:proposeLinkedSermonServiceSources'
  )({ trusted: true }, {
    projectId: 'service-2026-07-26',
    expectedRevisionId: PROJECT_REVISION,
    itemId: 'sermon',
    manuscriptLanguages: ['en']
  });
  assert.deepEqual(
    plain(proposal.sources.map(source => source.disposition)),
    ['reuse', 'reuse', 'reuse', 'reuse']
  );
  const result = await harness.handlers.get(
    'prepare:projects:commitLinkedSermonServiceSources'
  )({ trusted: true }, {
    proposalToken: proposal.proposalToken,
    confirmed: true
  });

  assert.ok(savedBinding);
  assert.equal(
    savedBinding.options.reason,
    'bind-linked-sermon-service-sources'
  );
  assert.equal(savedBinding.project.sourceServiceSet.id, packetManifest().id);
  assert.equal(
    harness.events.filter(event => event.startsWith('import:')).length,
    0
  );
  assert.equal(harness.events.includes('commit'), false);
  assert.equal(result.addedSourceCount, 0);
  assert.equal(result.reusedSourceCount, 4);
  assert.equal(result.sourceCount, 4);

  const fingerprint = serviceSetFingerprint(packetManifest());
  const alreadyBound = loadServicePacketHandlers({
    project: linkedSermonProject({
      sermon,
      sourceServiceSet: {
        id: packetManifest().id,
        fingerprint,
        serviceDate: '2026-07-26',
        profileId: 'main-sanctuary'
      }
    })
  });
  const alreadyProposal = await alreadyBound.handlers.get(
    'prepare:projects:proposeLinkedSermonServiceSources'
  )({ trusted: true }, {
    projectId: 'service-2026-07-26',
    expectedRevisionId: PROJECT_REVISION,
    itemId: 'sermon',
    manuscriptLanguages: ['en']
  });
  const unchanged = await alreadyBound.handlers.get(
    'prepare:projects:commitLinkedSermonServiceSources'
  )({ trusted: true }, {
    proposalToken: alreadyProposal.proposalToken,
    confirmed: true
  });
  assert.equal(unchanged.unchanged, true);
  assert.equal(alreadyBound.events.includes('project-save'), false);
  assert.equal(alreadyBound.events.includes('commit'), false);
});

test('reviewed proposal is bound to service date and profile and returns no local source path', async () => {
  const good = loadServicePacketHandlers();
  const proposal = await good.handlers.get('prepare:projects:proposeServiceSermonPacket')({ trusted: true }, {
    projectId: 'service-2026-07-26', expectedRevisionId: PROJECT_REVISION, itemId: 'sermon',
    title: 'The Prayer That Transforms the Church', speakerName: 'Paul Lvutin',
    defaultLanguage: 'en', primaryReference: 'Ephesians 3:14-21', selectedBook: 'Ephesians',
    manuscriptLanguages: ['en', 'ru'], readingMode: 'already-in-service'
  });
  assert.equal(hasLocalPath(proposal), false);
  assert.deepEqual(proposal.sources.map(source => source.fileName), [
    '07-26 ENG.pptx', '07-26 Media.pptx', '07-26 RUS.pptx', 'Prayer Notes.pdf'
  ]);
  assert.equal(proposal.serviceSet.serviceDate, '2026-07-26');
  assert.equal(proposal.sermon.readingMode, 'already-in-service');

  const unspecified = loadServicePacketHandlers();
  const unspecifiedProposal = await unspecified.handlers.get(
    'prepare:projects:proposeServiceSermonPacket'
  )({ trusted: true }, {
    projectId: 'service-2026-07-26',
    expectedRevisionId: PROJECT_REVISION,
    itemId: 'sermon',
    title: 'Prayer',
    speakerName: 'Paul',
    defaultLanguage: 'en',
    primaryReference: 'Ephesians 3:14-21',
    readingMode: 'already-in-service'
  });
  assert.deepEqual(
    plain(unspecifiedProposal.sources.at(-1).languages),
    ['und']
  );

  const wrongDate = loadServicePacketHandlers({
    currentManifest: packetManifest({ serviceDate: '2026-08-02' })
  });
  await assert.rejects(
    wrongDate.handlers.get('prepare:projects:proposeServiceSermonPacket')({ trusted: true }, {
      projectId: 'service-2026-07-26', expectedRevisionId: PROJECT_REVISION, itemId: 'sermon',
      title: 'Prayer', speakerName: 'Paul', defaultLanguage: 'en',
      primaryReference: 'Ephesians 3:14-21', manuscriptLanguages: ['en'], readingMode: 'already-in-service'
    }),
    error => error.code === 'SERVICE_SET_PROJECT_MISMATCH'
  );
  const wrongProfile = loadServicePacketHandlers({
    currentManifest: packetManifest({ profileId: 'chapel' })
  });
  await assert.rejects(
    wrongProfile.handlers.get('prepare:projects:proposeServiceSermonPacket')({ trusted: true }, {
      projectId: 'service-2026-07-26', expectedRevisionId: PROJECT_REVISION, itemId: 'sermon',
      title: 'Prayer', speakerName: 'Paul', defaultLanguage: 'en',
      primaryReference: 'Ephesians 3:14-21', manuscriptLanguages: ['en'], readingMode: 'already-in-service'
    }),
    error => error.code === 'SERVICE_SET_PROJECT_MISMATCH'
  );
});

test('commit re-verifies reviewed sources, imports each source before one sermon/project transaction, and honors reading mode', async () => {
  let committed = null;
  const harness = loadServicePacketHandlers({ onCommit(options) { committed = options; } });
  const proposal = await harness.handlers.get('prepare:projects:proposeServiceSermonPacket')({ trusted: true }, {
    projectId: 'service-2026-07-26', expectedRevisionId: PROJECT_REVISION, itemId: 'sermon',
    title: 'The Prayer That Transforms the Church', speakerName: 'Paul Lvutin',
    defaultLanguage: 'en', primaryReference: 'Ephesians 3:14-21', manuscriptLanguages: ['en'],
    readingMode: 'already-in-service'
  });
  const result = await harness.handlers.get('prepare:projects:commitServiceSermonPacket')({ trusted: true }, {
    proposalToken: proposal.proposalToken, confirmed: true
  });
  assert.equal(result.sourceCount, 4);
  assert.deepEqual(harness.events.slice(0, 2), ['inspect', 'inspect']);
  assert.equal(harness.events.filter(event => event.startsWith('import:')).length, 4);
  assert.equal(harness.events.at(-1), 'commit');
  assert.equal(committed.reason, 'create-service-sermon-packet');
  assert.equal(committed.sermonDocument.sources.length, 4);
  assert.equal(Object.values(committed.project.items).filter(item => item.kind === 'bible').length, 0);

  let withReading = null;
  const inserted = loadServicePacketHandlers({ onCommit(options) { withReading = options; } });
  const insertedProposal = await inserted.handlers.get('prepare:projects:proposeServiceSermonPacket')({ trusted: true }, {
    projectId: 'service-2026-07-26', expectedRevisionId: PROJECT_REVISION, itemId: 'sermon',
    title: 'The Prayer That Transforms the Church', speakerName: 'Paul Lvutin',
    defaultLanguage: 'en', primaryReference: 'Ephesians 3:14-21', manuscriptLanguages: ['en'],
    readingMode: 'insert-native',
    readingOutputs: [
      { channelId: 'primary', mode: 'translation', translationId: 'BSB' },
      { channelId: 'secondary', mode: 'translation', translationId: 'LSV' },
      { channelId: 'media', mode: 'hidden' }
    ]
  });
  assert.deepEqual(plain(insertedProposal.sermon.readingOutputs), [
    { channelId: 'primary', mode: 'translation', translationId: 'BSB' },
    { channelId: 'secondary', mode: 'translation', translationId: 'LSV' },
    { channelId: 'media', mode: 'hidden' }
  ]);
  const insertedResult = await inserted.handlers.get('prepare:projects:commitServiceSermonPacket')({ trusted: true }, {
    proposalToken: insertedProposal.proposalToken, confirmed: true
  });
  assert.equal(insertedResult.reading.cueCount, 1);
  const reading = Object.values(withReading.project.items)
    .find(item => item.kind === 'bible');
  assert.ok(reading);
  assert.deepEqual(plain(reading.sermonReading.outputs), [
    { channelId: 'primary', mode: 'translation', translationId: 'BSB' },
    { channelId: 'secondary', mode: 'translation', translationId: 'LSV' },
    { channelId: 'media', mode: 'hidden' }
  ]);
  assert.equal(reading.passagesByChannel.primary.translationId, 'BSB');
  assert.equal(reading.passagesByChannel.secondary.translationId, 'LSV');
  assert.equal(reading.passagesByChannel.media, undefined);
});

test('PowerPoint companions preserve the in-deck reading and commit only nonprojected sermon resources', async () => {
  const manifest = packetManifest();
  const companion = bindProjectAsPowerPointCompanion(
    addGroupItem(createServiceProject({
      id: 'service-2026-07-26',
      title: 'PowerPoint service record',
      serviceDate: '2026-07-26',
      profileId: 'main-sanctuary'
    }), {
      id: 'sermon',
      title: 'Sermon',
      groupKind: 'sermon'
    }),
    {
      id: manifest.id,
      fingerprint: serviceSetFingerprint(manifest),
      serviceDate: manifest.serviceDate,
      profileId: manifest.profileId
    }
  );
  const harness = loadServicePacketHandlers({
    currentManifest: manifest,
    project: companion
  });
  const request = {
    projectId: companion.id,
    expectedRevisionId: PROJECT_REVISION,
    itemId: 'sermon',
    title: 'The Prayer That Transforms the Church',
    speakerName: 'Paul Lvutin',
    defaultLanguage: 'en',
    primaryReference: 'Ephesians 3:14-21',
    manuscriptLanguages: ['und']
  };
  await assert.rejects(
    harness.handlers.get('prepare:projects:proposeServiceSermonPacket')(
      { trusted: true },
      { ...request, readingMode: 'insert-native' }
    ),
    error => error.code === 'CURRENT_SERVICE_READING_ALREADY_PRESENT'
  );
  const proposal = await harness.handlers.get(
    'prepare:projects:proposeServiceSermonPacket'
  )(
    { trusted: true },
    { ...request, readingMode: 'already-in-service' }
  );
  const result = await harness.handlers.get(
    'prepare:projects:commitServiceSermonPacket'
  )(
    { trusted: true },
    { proposalToken: proposal.proposalToken, confirmed: true }
  );
  assert.equal(result.readingMode, 'already-in-service');
  assert.equal(result.project.workflowMode, 'pptx-companion');
  assert.equal(
    Object.values(result.project.items).every(item => item.kind === 'group'),
    true
  );
  assert.equal(Object.keys(result.project.assets).length, 0);
  assert.equal(Object.values(result.project.resources).some(resource =>
    resource.kind === 'sermon'
  ), true);
});

test('proposal tokens expire, serialize application, reject replay, retry safely, and evict at capacity', async () => {
  const request = {
    projectId: 'service-2026-07-26', expectedRevisionId: PROJECT_REVISION, itemId: 'sermon',
    title: 'Prayer', speakerName: 'Paul', defaultLanguage: 'en',
    primaryReference: 'Ephesians 3:14-21', manuscriptLanguages: ['en'],
    readingMode: 'already-in-service'
  };

  const expired = loadServicePacketHandlers();
  const expiredProposal = await expired.handlers.get(
    'prepare:projects:proposeServiceSermonPacket'
  )({ trusted: true }, request);
  expired.proposals.get(expiredProposal.proposalToken).expiresAt = Date.now() - 1;
  await assert.rejects(
    expired.handlers.get('prepare:projects:commitServiceSermonPacket')(
      { trusted: true },
      { proposalToken: expiredProposal.proposalToken, confirmed: true }
    ),
    error => error.code === 'EXPIRED_SERVICE_SERMON_PACKET_PROPOSAL'
  );
  assert.equal(expired.proposals.has(expiredProposal.proposalToken), false);

  let releaseImport;
  let importStarted;
  const importGate = new Promise(resolve => { releaseImport = resolve; });
  const importStart = new Promise(resolve => { importStarted = resolve; });
  let blockedOnce = false;
  const concurrent = loadServicePacketHandlers({
    async onImport() {
      if (blockedOnce) return;
      blockedOnce = true;
      importStarted();
      await importGate;
    }
  });
  const concurrentProposal = await concurrent.handlers.get(
    'prepare:projects:proposeServiceSermonPacket'
  )({ trusted: true }, request);
  const firstCommit = concurrent.handlers.get(
    'prepare:projects:commitServiceSermonPacket'
  )(
    { trusted: true },
    { proposalToken: concurrentProposal.proposalToken, confirmed: true }
  );
  await importStart;
  await assert.rejects(
    concurrent.handlers.get('prepare:projects:commitServiceSermonPacket')(
      { trusted: true },
      { proposalToken: concurrentProposal.proposalToken, confirmed: true }
    ),
    error => error.code === 'SERVICE_SERMON_PACKET_APPLY_IN_PROGRESS'
  );
  releaseImport();
  await firstCommit;
  await assert.rejects(
    concurrent.handlers.get('prepare:projects:commitServiceSermonPacket')(
      { trusted: true },
      { proposalToken: concurrentProposal.proposalToken, confirmed: true }
    ),
    error => error.code === 'EXPIRED_SERVICE_SERMON_PACKET_PROPOSAL'
  );

  let retryImportCount = 0;
  let retryCommitCount = 0;
  const retry = loadServicePacketHandlers({
    onImport() {
      retryImportCount += 1;
      if (retryImportCount === 2) {
        const error = new Error('temporary write contention');
        error.code = 'WRITE_LOCKED';
        throw error;
      }
    },
    onCommit() { retryCommitCount += 1; }
  });
  const retryProposal = await retry.handlers.get(
    'prepare:projects:proposeServiceSermonPacket'
  )({ trusted: true }, request);
  await assert.rejects(
    retry.handlers.get('prepare:projects:commitServiceSermonPacket')(
      { trusted: true },
      { proposalToken: retryProposal.proposalToken, confirmed: true }
    ),
    error => error.code === 'SERMON_SOURCE_IMPORT_FAILED'
  );
  assert.equal(retry.proposals.has(retryProposal.proposalToken), true);
  await retry.handlers.get('prepare:projects:commitServiceSermonPacket')(
    { trusted: true },
    { proposalToken: retryProposal.proposalToken, confirmed: true }
  );
  assert.equal(retryCommitCount, 1);
  assert.equal(retry.proposals.has(retryProposal.proposalToken), false);

  const bounded = loadServicePacketHandlers({ proposalLimit: 2 });
  const first = await bounded.handlers.get(
    'prepare:projects:proposeServiceSermonPacket'
  )({ trusted: true }, request);
  await bounded.handlers.get('prepare:projects:proposeServiceSermonPacket')(
    { trusted: true },
    request
  );
  await bounded.handlers.get('prepare:projects:proposeServiceSermonPacket')(
    { trusted: true },
    request
  );
  assert.equal(bounded.proposals.size, 2);
  assert.equal(bounded.proposals.has(first.proposalToken), false);
});

test('linked-sermon source-review tokens expire, serialize, retry safely, reject replay, and stay bounded', async () => {
  const request = {
    projectId: 'service-2026-07-26',
    expectedRevisionId: PROJECT_REVISION,
    itemId: 'sermon',
    manuscriptLanguages: ['en']
  };
  const linkedProject = linkedSermonProject();

  const expired = loadServicePacketHandlers({ project: linkedProject });
  const expiredProposal = await expired.handlers.get(
    'prepare:projects:proposeLinkedSermonServiceSources'
  )({ trusted: true }, request);
  expired.linkedSourceProposals
    .get(expiredProposal.proposalToken).expiresAt = Date.now() - 1;
  await assert.rejects(
    expired.handlers.get(
      'prepare:projects:commitLinkedSermonServiceSources'
    )(
      { trusted: true },
      { proposalToken: expiredProposal.proposalToken, confirmed: true }
    ),
    error => error.code
      === 'EXPIRED_LINKED_SERVICE_SERMON_SOURCE_PROPOSAL'
  );
  assert.equal(
    expired.linkedSourceProposals.has(expiredProposal.proposalToken),
    false
  );

  let releaseImport;
  let importStarted;
  const importGate = new Promise(resolve => { releaseImport = resolve; });
  const importStart = new Promise(resolve => { importStarted = resolve; });
  let heldOnce = false;
  const concurrent = loadServicePacketHandlers({
    project: linkedProject,
    async onImport() {
      if (heldOnce) return;
      heldOnce = true;
      importStarted();
      await importGate;
    }
  });
  const concurrentProposal = await concurrent.handlers.get(
    'prepare:projects:proposeLinkedSermonServiceSources'
  )({ trusted: true }, request);
  const firstCommit = concurrent.handlers.get(
    'prepare:projects:commitLinkedSermonServiceSources'
  )(
    { trusted: true },
    { proposalToken: concurrentProposal.proposalToken, confirmed: true }
  );
  await importStart;
  await assert.rejects(
    concurrent.handlers.get(
      'prepare:projects:commitLinkedSermonServiceSources'
    )(
      { trusted: true },
      { proposalToken: concurrentProposal.proposalToken, confirmed: true }
    ),
    error => error.code
      === 'LINKED_SERVICE_SERMON_SOURCE_APPLY_IN_PROGRESS'
  );
  releaseImport();
  await firstCommit;
  await assert.rejects(
    concurrent.handlers.get(
      'prepare:projects:commitLinkedSermonServiceSources'
    )(
      { trusted: true },
      { proposalToken: concurrentProposal.proposalToken, confirmed: true }
    ),
    error => error.code
      === 'EXPIRED_LINKED_SERVICE_SERMON_SOURCE_PROPOSAL'
  );

  let retryImportCount = 0;
  const retry = loadServicePacketHandlers({
    project: linkedProject,
    onImport() {
      retryImportCount += 1;
      if (retryImportCount === 1) {
        const error = new Error('temporary write contention');
        error.code = 'WRITE_LOCKED';
        throw error;
      }
    }
  });
  const retryProposal = await retry.handlers.get(
    'prepare:projects:proposeLinkedSermonServiceSources'
  )({ trusted: true }, request);
  await assert.rejects(
    retry.handlers.get(
      'prepare:projects:commitLinkedSermonServiceSources'
    )(
      { trusted: true },
      { proposalToken: retryProposal.proposalToken, confirmed: true }
    ),
    error => error.code === 'SERMON_SOURCE_IMPORT_FAILED'
  );
  assert.equal(
    retry.linkedSourceProposals.has(retryProposal.proposalToken),
    true
  );
  await retry.handlers.get(
    'prepare:projects:commitLinkedSermonServiceSources'
  )(
    { trusted: true },
    { proposalToken: retryProposal.proposalToken, confirmed: true }
  );
  assert.equal(
    retry.linkedSourceProposals.has(retryProposal.proposalToken),
    false
  );

  const bounded = loadServicePacketHandlers({
    project: linkedProject,
    proposalLimit: 2
  });
  const first = await bounded.handlers.get(
    'prepare:projects:proposeLinkedSermonServiceSources'
  )({ trusted: true }, request);
  await bounded.handlers.get(
    'prepare:projects:proposeLinkedSermonServiceSources'
  )({ trusted: true }, request);
  await bounded.handlers.get(
    'prepare:projects:proposeLinkedSermonServiceSources'
  )({ trusted: true }, request);
  assert.equal(bounded.linkedSourceProposals.size, 2);
  assert.equal(
    bounded.linkedSourceProposals.has(first.proposalToken),
    false
  );
});

test('commit stops before the sermon/project transaction if the service, manuscript, or any copied source differs from review', async () => {
  const request = {
    projectId: 'service-2026-07-26', expectedRevisionId: PROJECT_REVISION, itemId: 'sermon',
    title: 'Prayer', speakerName: 'Paul', defaultLanguage: 'en',
    primaryReference: 'Ephesians 3:14-21', manuscriptLanguages: ['en'], readingMode: 'already-in-service'
  };

  const changedManifest = packetManifest();
  let manifestCommitCount = 0;
  const manifestHarness = loadServicePacketHandlers({
    currentManifest: changedManifest, onCommit() { manifestCommitCount += 1; }
  });
  const manifestProposal = await manifestHarness.handlers.get('prepare:projects:proposeServiceSermonPacket')({ trusted: true }, request);
  changedManifest.inputs.english.sha256 = 'e'.repeat(64);
  await assert.rejects(
    manifestHarness.handlers.get('prepare:projects:commitServiceSermonPacket')({ trusted: true }, {
      proposalToken: manifestProposal.proposalToken, confirmed: true
    }),
    error => error.code === 'SERVICE_SERMON_PACKET_SET_CHANGED'
  );
  assert.equal(manifestCommitCount, 0);
  assert.equal(manifestHarness.events.filter(event => event.startsWith('import:')).length, 0);

  const changedManuscript = manuscript();
  let manuscriptCommitCount = 0;
  const manuscriptHarness = loadServicePacketHandlers({
    inspectedManuscript: changedManuscript, onCommit() { manuscriptCommitCount += 1; }
  });
  const manuscriptProposal = await manuscriptHarness.handlers.get('prepare:projects:proposeServiceSermonPacket')({ trusted: true }, request);
  changedManuscript.sha256 = 'e'.repeat(64);
  await assert.rejects(
    manuscriptHarness.handlers.get('prepare:projects:commitServiceSermonPacket')({ trusted: true }, {
      proposalToken: manuscriptProposal.proposalToken, confirmed: true
    }),
    error => error.code === 'SERVICE_SERMON_PACKET_MANUSCRIPT_CHANGED'
  );
  assert.equal(manuscriptCommitCount, 0);

  let partialCommitCount = 0;
  let partialImports = 0;
  const partial = loadServicePacketHandlers({
    onImport(options) {
      partialImports += 1;
      if (partialImports === 2) {
        const error = new Error('disk full');
        error.code = 'WRITE_LOCKED';
        throw error;
      }
    },
    onCommit() { partialCommitCount += 1; }
  });
  const partialProposal = await partial.handlers.get('prepare:projects:proposeServiceSermonPacket')({ trusted: true }, request);
  await assert.rejects(
    partial.handlers.get('prepare:projects:commitServiceSermonPacket')({ trusted: true }, {
      proposalToken: partialProposal.proposalToken, confirmed: true
    }),
    error => error.code === 'SERMON_SOURCE_IMPORT_FAILED'
  );
  assert.equal(partialCommitCount, 0);
  assert.equal(partial.events.filter(event => event.startsWith('import:')).length, 2);

  let mismatchCommitCount = 0;
  let mismatchImports = 0;
  const mismatch = loadServicePacketHandlers({
    transformImported(imported, options) {
      mismatchImports += 1;
      return mismatchImports === 3
        ? { ...imported, objectId: 'sha256:not-the-reviewed-object' }
        : imported;
    },
    onCommit() { mismatchCommitCount += 1; }
  });
  const mismatchProposal = await mismatch.handlers.get('prepare:projects:proposeServiceSermonPacket')({ trusted: true }, request);
  await assert.rejects(
    mismatch.handlers.get('prepare:projects:commitServiceSermonPacket')({ trusted: true }, {
      proposalToken: mismatchProposal.proposalToken, confirmed: true
    }),
    error => error.code === 'SERVICE_SERMON_PACKET_SOURCE_CHANGED'
  );
  assert.equal(mismatchCommitCount, 0);

  let provenanceCommitCount = 0;
  const provenanceMismatch = loadServicePacketHandlers({
    transformImported(imported) {
      return {
        ...imported,
        source: {
          ...imported.source,
          provenance: {
            ...imported.source.provenance,
            sourceSystem: 'unexpected-source-system'
          }
        }
      };
    },
    onCommit() { provenanceCommitCount += 1; }
  });
  const provenanceProposal = await provenanceMismatch.handlers.get(
    'prepare:projects:proposeServiceSermonPacket'
  )({ trusted: true }, request);
  await assert.rejects(
    provenanceMismatch.handlers.get('prepare:projects:commitServiceSermonPacket')(
      { trusted: true },
      { proposalToken: provenanceProposal.proposalToken, confirmed: true }
    ),
    error => error.code === 'SERVICE_SERMON_PACKET_SOURCE_CHANGED'
  );
  assert.equal(provenanceCommitCount, 0);

  const conflictingProject = bindProjectToServiceSet(
    addGroupItem(createServiceProject({
      id: 'service-2026-07-26', title: 'Sunday Service',
      serviceDate: '2026-07-26', profileId: 'main-sanctuary'
    }), { id: 'sermon', title: 'Sermon', groupKind: 'sermon' }),
    {
      id: '2026-07-26-earlier-review', fingerprint: 'e'.repeat(64),
      serviceDate: '2026-07-26', profileId: 'main-sanctuary'
    }
  );
  let bindingCommitCount = 0;
  const binding = loadServicePacketHandlers({
    project: conflictingProject, onCommit() { bindingCommitCount += 1; }
  });
  await assert.rejects(
    binding.handlers.get('prepare:projects:proposeServiceSermonPacket')({ trusted: true }, request),
    error => error.code === 'SERVICE_SET_PROJECT_MISMATCH'
  );
  assert.equal(bindingCommitCount, 0);
});
