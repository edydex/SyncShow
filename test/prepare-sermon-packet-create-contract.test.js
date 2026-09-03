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
  createServiceProject,
  isPowerPointCompanionProject,
  isSermonSourceTarget,
  normalizeSermonDocument,
  placeBibleReadingItemsBefore,
  resolveBookId,
  resolveSermonSourceLink,
  SERMON_SCHEMA_VERSION,
  sermonDocumentSha256,
  setSermonSourceLink
} = require('../src/services/project');

const root = path.join(__dirname, '..');
const mainSource = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
const preloadSource = fs.readFileSync(path.join(root, 'preload.js'), 'utf8');
const PROJECT_REVISION = 'a'.repeat(64);

function plain(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
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
  const contextBridge = {
    exposeInMainWorld(name, value) {
      if (name === 'api') api = value;
    }
  };
  vm.runInNewContext(preloadSource, {
    require(moduleId) {
      if (moduleId === 'electron') return { contextBridge, ipcRenderer };
      throw new Error(`Unexpected preload dependency: ${moduleId}`);
    },
    console
  }, { filename: path.join(root, 'preload.js') });
  assert.ok(api, 'preload must expose the renderer API');
  return { api, calls };
}

function handlerSource(channel) {
  const marker = `ipcMain.handle('${channel}'`;
  const start = mainSource.indexOf(marker);
  assert.notEqual(start, -1, `${channel} must be implemented`);
  const next = mainSource.indexOf("ipcMain.handle('", start + marker.length);
  return mainSource.slice(start, next === -1 ? mainSource.length : next);
}

function sourceBetween(startMarker, endMarker) {
  const start = mainSource.indexOf(startMarker);
  assert.notEqual(start, -1, `${startMarker} must be implemented`);
  const end = mainSource.indexOf(endMarker, start + startMarker.length);
  assert.notEqual(end, -1, `${endMarker} must follow ${startMarker}`);
  return mainSource.slice(start, end);
}

test('sermon packet creation preload forwards only reviewed semantic fields', async () => {
  const { api, calls } = loadPreloadBridge();
  await api.createSermonPacketForServiceItem({
    projectId: 'service-2026-07-26',
    expectedRevisionId: PROJECT_REVISION,
    itemId: 'sermon-group',
    title: 'The Prayer That Transforms the Church',
    speakerName: 'Paul Lvutin',
    defaultLanguage: 'en',
    primaryReference: 'Ephesians 3:14-21',
    selectedBook: 'Ephesians',
    addPrimaryReading: true,
    readingOutputs: [
      {
        channelId: 'primary',
        mode: 'translation',
        translationId: 'BSB',
        passage: { hostile: true }
      },
      {
        channelId: 'secondary',
        mode: 'translation',
        translationId: 'LSV'
      },
      { channelId: 'media', mode: 'hidden', translationId: 'BSB' }
    ],
    sermonId: 'renderer-controlled-sermon',
    referenceId: 'renderer-controlled-reference',
    document: { publication: { status: 'published' } },
    range: { bookId: 'Rev' },
    source: { filePath: '/private/sermon.pdf' },
    sources: [{ path: '/private/sermon.docx' }],
    publication: { status: 'published', visibility: 'public' },
    path: '/private/sermon.json',
    filePath: '/private/sermon.pdf'
  });

  assert.deepEqual(calls, [{
    channel: 'prepare:projects:createSermonPacket',
    payload: {
      projectId: 'service-2026-07-26',
      expectedRevisionId: PROJECT_REVISION,
      itemId: 'sermon-group',
      title: 'The Prayer That Transforms the Church',
      speakerName: 'Paul Lvutin',
      defaultLanguage: 'en',
      primaryReference: 'Ephesians 3:14-21',
      selectedBook: 'Ephesians',
      addPrimaryReading: true,
      readingOutputs: [
        {
          channelId: 'primary',
          mode: 'translation',
          translationId: 'BSB'
        },
        {
          channelId: 'secondary',
          mode: 'translation',
          translationId: 'LSV'
        },
        { channelId: 'media', mode: 'hidden' }
      ]
    }
  }]);
});

test('sermon primary-reference preview preload forwards only query and selected book', async () => {
  const { api, calls } = loadPreloadBridge();
  await api.lookupSermonPrimaryReference({
    query: 'Psalm 119:1-100',
    selectedBook: 'Psalms',
    translationId: 'LSV',
    maxVerses: 1000,
    passage: { reference: 'renderer-controlled' },
    verses: [{ number: 1, text: 'renderer-controlled' }]
  });

  assert.deepEqual(calls, [{
    channel: 'prepare:sermons:lookupPrimaryReference',
    payload: {
      query: 'Psalm 119:1-100',
      selectedBook: 'Psalms'
    }
  }]);
});

test('sermon primary-reference lookup uses a trusted dedicated channel and fixed BSB resolver', async () => {
  const source = handlerSource('prepare:sermons:lookupPrimaryReference');
  assert.match(source, /requireControlSender\(event\)/);
  assert.match(source, /requirePrepareRequest\(request, 16 \* 1024\)/);
  assert.match(source, /resolveSermonPrimaryReferenceLookupRequest\(request\)/);

  const resolverStart = mainSource.indexOf(
    'async function resolveSermonPrimaryReferenceLookupRequest'
  );
  const resolverEnd = mainSource.indexOf('\nfunction createBibleOverlayWaiter', resolverStart);
  assert.ok(resolverStart >= 0 && resolverEnd > resolverStart);
  const resolverSource = mainSource.slice(resolverStart, resolverEnd);
  assert.match(resolverSource, /query: request\?\.query/);
  assert.match(resolverSource, /selectedBook: request\?\.selectedBook/);
  assert.match(resolverSource, /translationId: 'BSB'/);
  assert.match(resolverSource, /sermonReferenceBibleLibrary\.lookup/);
  assert.doesNotMatch(
    resolverSource,
    /request\?\.(?:translationId|maxVerses|passage|verses)\b/
  );

  const helperStart = mainSource.indexOf('function normalizeBibleLookupRequest');
  assert.ok(helperStart >= 0 && resolverEnd > helperStart);
  const helperSource = mainSource.slice(helperStart, resolverEnd);
  let resolver = null;
  vm.runInNewContext(`${helperSource}\ncapture(resolveSermonPrimaryReferenceLookupRequest);`, {
    bibleLibrary: new BibleLibrary({ maxVerses: 8 }),
    sermonReferenceBibleLibrary: new BibleLibrary({ maxVerses: 100 }),
    capture(candidate) {
      resolver = candidate;
    }
  }, { filename: 'sermon-primary-reference-resolver.js' });

  const exactHundred = await resolver({
    query: 'Psalm 119:1-100',
    selectedBook: 'Psalms',
    translationId: 'LSV',
    maxVerses: 1000,
    passage: { hostile: true },
    verses: [{ hostile: true }]
  });
  assert.equal(exactHundred.status, 'ok');
  assert.equal(exactHundred.passage.translation.id, 'BSB');
  assert.equal(exactHundred.passage.verses.length, 100);

  const hundredOne = await resolver({
    query: 'Psalm 119:1-101',
    translationId: 'LSV',
    maxVerses: 1000
  });
  assert.equal(hundredOne.status, 'error');
  assert.equal(hundredOne.code, 'range-too-large');
  assert.equal(hundredOne.maxVerses, 100);
});

test('main creates, stores, pins, and CAS-saves a private canonical sermon packet', async () => {
  const source = handlerSource('prepare:projects:createSermonPacket');
  const helpers = sourceBetween(
    'async function resolveNewSermonPacketMetadata',
    '\nfunction pruneServiceSermonPacketProposals'
  );
  const bibleOutputHelpers = sourceBetween(
    'function prepareBibleOutputSelections',
    "\nipcMain.handle('prepare:projects:addBible'"
  );
  assert.match(source, /requireControlSender\(event\)/);
  assert.match(source, /requirePrepareRequest\(request, 16 \* 1024\)/);
  assert.match(source, /requireExactPrepareKeys\(request,/);
  assert.match(source, /readExpectedProject\(request\)/);
  assert.match(source, /requireNewSermonPacketTarget\(current, request\.itemId\)/);
  assert.match(source, /isPowerPointCompanionProject\(current\.project\)/);
  assert.match(source, /resolveNewSermonPacketMetadata\(request\)/);
  assert.match(source, /commitNewSermonPacket\(\{/);
  assert.match(source, /readingOutputs/);
  assert.match(helpers, /isSermonSourceTarget\(current\.project, item\)/);
  assert.match(
    helpers,
    /isPowerPointCompanionProject\(current\.project\)[\s\S]*resolveSermonSourceLink\(current\.project, item\)[\s\S]*CURRENT_SERVICE_SERMON_ALREADY_LINKED/
  );
  assert.match(helpers, /resolveSermonPrimaryReferenceLookupRequest\(\{/);
  assert.doesNotMatch(helpers, /resolveBibleLookupRequest\(/);
  assert.match(helpers, /resolveBookId\(passage\.book\)/);
  assert.match(helpers, /serviceDate: current\.project\.serviceDate/);
  assert.match(helpers, /reviewStatus: 'confirmed'/);
  assert.match(helpers, /status: 'draft'/);
  assert.match(helpers, /visibility: 'private'/);
  assert.match(helpers, /sermonDocumentSha256\(sermonDocument\)/);
  assert.match(helpers, /addSermonResource\(current\.project, sermonDocument,/);
  assert.match(helpers, /revision: sermonRevision/);
  assert.match(helpers, /setSermonSourceLink\(withResource\.project,/);
  assert.match(helpers, /sermonSectionId: null/);
  assert.match(helpers, /sermonProjectCommitCoordinator\.commit\(\{/);
  assert.match(helpers, /expectedProjectRevisionId: current\.expectedRevisionId/);
  assert.match(helpers, /expectedSermonRevision: null/);
  assert.match(helpers, /resourceOwnerId: itemId/);
  assert.doesNotMatch(
    source,
    /request\.(?:sermonId|referenceId|document|range|source|sources|publication|path|filePath)\b/,
    'main must not accept renderer-owned identities, documents, ranges, sources, publication, or paths'
  );

  const project = addGroupItem(createServiceProject({
    id: 'service-2026-07-26',
    title: 'Sunday Service',
    serviceDate: '2026-07-26',
    profileId: 'main-sanctuary'
  }), {
    id: 'sermon-group',
    title: 'Sermon',
    groupKind: 'sermon'
  });
  let activeProject = project;
  const sermonReferenceLibrary = new BibleLibrary({ maxVerses: 100 });
  const projectedBibleLibrary = new BibleLibrary({ maxVerses: 8 });
  const calls = {
    lookup: null,
    sermonCommit: null
  };
  let registeredHandler = null;
  let generatedId = 0;
  const sermonProjectCommitCoordinator = {
    async commit(options) {
      const sermon = normalizeSermonDocument(options.sermonDocument);
      const revision = sermonDocumentSha256(sermon);
      calls.sermonCommit = {
        options: {
          ...plain(options),
          project: options.project,
          sermonDocument: sermon
        },
        sermon,
        revision
      };
      return {
        project: {
          project: options.project,
          revisionId: 'c'.repeat(64),
          unchanged: false,
          recovery: null
        },
        sermon: { sermon, revision },
        recovery: null
      };
    }
  };
  const failMainOperation = (code, message, details = {}) => {
    const error = new Error(message);
    error.code = code;
    error.details = details;
    throw error;
  };
  const prepareText = (value, label, maximum, { required = false } = {}) => {
    if (value === undefined || value === null) value = '';
    if (typeof value !== 'string') failMainOperation('INVALID_PREPARE_TEXT', `${label} must be text.`);
    const normalized = value.trim();
    if (required && !normalized) failMainOperation('MISSING_PREPARE_TEXT', `${label} is required.`);
    if (normalized.length > maximum) {
      failMainOperation('PREPARE_TEXT_TOO_LONG', `${label} is too long.`);
    }
    return normalized;
  };

  vm.runInNewContext(`${helpers}\n${bibleOutputHelpers}\n${source}`, {
    ipcMain: {
      handle(channel, handler) {
        assert.equal(channel, 'prepare:projects:createSermonPacket');
        registeredHandler = handler;
      }
    },
    requireControlSender(event) {
      assert.equal(event.trusted, true);
    },
    requirePrepareRequest(request, maximumBytes) {
      assert.equal(maximumBytes, 16 * 1024);
      assert.equal(typeof request, 'object');
    },
    requireExactPrepareKeys() {},
    async readExpectedProject(request) {
      assert.equal(request.projectId, project.id);
      assert.equal(request.expectedRevisionId, PROJECT_REVISION);
      return {
        project: activeProject,
        projectId: project.id,
        expectedRevisionId: PROJECT_REVISION,
        services: { sermonProjectCommitCoordinator }
      };
    },
    prepareId(value) {
      return String(value);
    },
    prepareText,
    async resolveSermonPrimaryReferenceLookupRequest(request) {
      calls.lookup = plain(request);
      return sermonReferenceLibrary.lookup(request.query, {
        translationId: 'BSB',
        ...(request.selectedBook ? { selectedBook: request.selectedBook } : {})
      });
    },
    async resolveBibleLookupRequest(request) {
      return projectedBibleLibrary.lookup(request.query, {
        translationId: request.translationId,
        ...(request.selectedBook ? { selectedBook: request.selectedBook } : {})
      });
    },
    failMainOperation,
    resolveBookId,
    SERMON_SCHEMA_VERSION,
    sermonDocumentSha256,
    analyzeSermonPrimaryReading,
    bibleLibrary: {
      maxVerses: projectedBibleLibrary.maxVerses,
      lookupCanonicalRange(range, options) {
        return projectedBibleLibrary.lookupCanonicalRange(
          plain(range),
          plain(options)
        );
      }
    },
    addBibleItem,
    placeBibleReadingItemsBefore,
    projectItemId(prefix) {
      generatedId += 1;
      return `${prefix}-main-owned-${generatedId}`;
    },
    isPowerPointCompanionProject,
    isSermonSourceTarget,
    resolveSermonSourceLink,
    addSermonResource,
    setSermonSourceLink,
    projectResult(result) {
      return {
        project: result.project,
        revisionId: result.revisionId,
        unchanged: result.unchanged === true,
        recovery: result.recovery || null
      };
    }
  }, { filename: 'create-sermon-packet-handler.js' });

  assert.equal(typeof registeredHandler, 'function');
  const result = await registeredHandler({ trusted: true }, {
    projectId: project.id,
    expectedRevisionId: PROJECT_REVISION,
    itemId: 'sermon-group',
    title: 'The Prayer That Transforms the Church',
    speakerName: 'Paul Lvutin',
    defaultLanguage: 'EN',
    primaryReference: 'Ephesians 3:14-21',
    selectedBook: 'Ephesians',
    sermonId: 'renderer-controlled-sermon',
    referenceId: 'renderer-controlled-reference',
    publication: { status: 'published', visibility: 'public' },
    document: { hostile: true },
    path: '/private/sermon.json'
  });

  assert.deepEqual(calls.lookup, {
    query: 'Ephesians 3:14-21',
    selectedBook: 'Ephesians'
  });
  const savedDocument = plain(calls.sermonCommit.sermon);
  assert.equal(savedDocument.schemaVersion, SERMON_SCHEMA_VERSION);
  assert.equal(savedDocument.id, 'sermon-main-owned-1');
  assert.equal(savedDocument.references[0].id, 'reference-main-owned-2');
  assert.deepEqual(savedDocument.titles, {
    en: 'The Prayer That Transforms the Church'
  });
  assert.equal(savedDocument.defaultLanguage, 'en');
  assert.equal(savedDocument.speaker.name, 'Paul Lvutin');
  assert.equal(savedDocument.serviceDate, '2026-07-26');
  assert.deepEqual(savedDocument.outline, []);
  assert.deepEqual(savedDocument.sources, []);
  assert.deepEqual(savedDocument.media, []);
  assert.deepEqual(savedDocument.references[0].range, {
    schemaVersion: 1,
    bookId: 'Eph',
    start: { chapter: 3, verse: 14 },
    end: { chapter: 3, verse: 21 }
  });
  assert.equal(savedDocument.references[0].role, 'primary');
  assert.equal(savedDocument.references[0].reviewStatus, 'confirmed');
  assert.deepEqual(savedDocument.publication, {
    status: 'draft',
    visibility: 'private',
    publishedAt: null,
    canonicalUrl: null
  });

  const pinnedResourceId = `sha256:${calls.sermonCommit.revision}`;
  assert.equal(
    calls.sermonCommit.options.project.items['sermon-group'].sermonResourceId,
    pinnedResourceId
  );
  assert.equal(
    calls.sermonCommit.options.project.items['sermon-group'].sermonSectionId ?? null,
    null
  );
  assert.equal(
    calls.sermonCommit.options.project.resources[pinnedResourceId].document.id,
    'sermon-main-owned-1'
  );
  assert.equal(calls.sermonCommit.options.expectedProjectRevisionId, PROJECT_REVISION);
  assert.equal(calls.sermonCommit.options.expectedSermonRevision, null);
  assert.equal(calls.sermonCommit.options.resourceId, pinnedResourceId);
  assert.equal(calls.sermonCommit.options.resourceOwnerId, 'sermon-group');
  assert.equal(calls.sermonCommit.options.reason, 'create-sermon-packet');
  assert.deepEqual({
    expectedProjectRevisionId: calls.sermonCommit.options.expectedProjectRevisionId,
    expectedSermonRevision: calls.sermonCommit.options.expectedSermonRevision,
    reason: calls.sermonCommit.options.reason
  }, {
    expectedProjectRevisionId: PROJECT_REVISION,
    expectedSermonRevision: null,
    reason: 'create-sermon-packet'
  });
  assert.deepEqual(Object.keys(result).sort(), [
    'project',
    'recovery',
    'revisionId',
    'unchanged'
  ]);
  assert.equal(result.revisionId, 'c'.repeat(64));

  activeProject = bindProjectAsPowerPointCompanion(
    calls.sermonCommit.options.project,
    {
      id: '2026-07-26-main',
      fingerprint: 'b'.repeat(64),
      serviceDate: '2026-07-26',
      profileId: 'main-sanctuary'
    }
  );
  await assert.rejects(
    registeredHandler({ trusted: true }, {
      projectId: project.id,
      expectedRevisionId: PROJECT_REVISION,
      itemId: 'sermon-group',
      title: 'Duplicate packet',
      speakerName: 'Paul Lvutin',
      defaultLanguage: 'en',
      primaryReference: 'Ephesians 3:14-21',
      selectedBook: 'Ephesians'
    }),
    error => error.code === 'CURRENT_SERVICE_SERMON_ALREADY_LINKED'
  );

  activeProject = project;
  const withReading = await registeredHandler({ trusted: true }, {
    projectId: project.id,
    expectedRevisionId: PROJECT_REVISION,
    itemId: 'sermon-group',
    title: 'Treasuring the Word',
    speakerName: 'Paul Lvutin',
    defaultLanguage: 'en',
    primaryReference: 'Psalm 119:1-18',
    selectedBook: 'Psalms',
    addPrimaryReading: true,
    readingOutputs: [
      { channelId: 'primary', mode: 'translation', translationId: 'BSB' },
      { channelId: 'secondary', mode: 'translation', translationId: 'LSV' },
      { channelId: 'media', mode: 'hidden' }
    ]
  });
  assert.equal(withReading.reading.status, 'ready');
  assert.equal(withReading.reading.cueCount, 3);
  const committedProject = calls.sermonCommit.options.project;
  assert.equal(committedProject.rootItemIds.at(-1), 'sermon-group');
  const readingIds = committedProject.rootItemIds.slice(0, -1);
  assert.equal(readingIds.length, 3);
  assert.deepEqual(
    readingIds.map(itemId => {
      const item = committedProject.items[itemId];
      return [
        item.range.start.verse,
        item.range.end.verse,
        item.passagesByChannel.primary.translationId,
        item.passagesByChannel.secondary.translationId,
        item.passagesByChannel.media,
        item.sermonReading.outputs
      ];
    }),
    [
      [1, 8, 'BSB', 'LSV', undefined, [
        { channelId: 'primary', mode: 'translation', translationId: 'BSB' },
        { channelId: 'secondary', mode: 'translation', translationId: 'LSV' },
        { channelId: 'media', mode: 'hidden' }
      ]],
      [9, 16, 'BSB', 'LSV', undefined, [
        { channelId: 'primary', mode: 'translation', translationId: 'BSB' },
        { channelId: 'secondary', mode: 'translation', translationId: 'LSV' },
        { channelId: 'media', mode: 'hidden' }
      ]],
      [17, 18, 'BSB', 'LSV', undefined, [
        { channelId: 'primary', mode: 'translation', translationId: 'BSB' },
        { channelId: 'secondary', mode: 'translation', translationId: 'LSV' },
        { channelId: 'media', mode: 'hidden' }
      ]]
    ]
  );
});
