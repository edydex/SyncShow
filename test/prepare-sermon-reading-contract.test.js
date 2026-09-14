'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const { BibleLibrary } = require('../src/services/bible');
const {
  SERMON_SCHEMA_VERSION,
  addBibleItem,
  addGroupItem,
  addSermonResource,
  analyzeSermonPrimaryReading,
  createServiceProject,
  isPowerPointCompanionProject,
  moveProjectItem,
  placeBibleReadingItemsBefore,
  resolveBookId,
  setSermonSourceLink
} = require('../src/services/project');

const root = path.join(__dirname, '..');
const mainSource = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
const preloadSource = fs.readFileSync(path.join(root, 'preload.js'), 'utf8');
const controllerSource = fs.readFileSync(
  path.join(root, 'src', 'renderer', 'prepare-controller.js'),
  'utf8'
);
const htmlSource = fs.readFileSync(path.join(root, 'src', 'renderer', 'index.html'), 'utf8');
const PROJECT_REVISION = 'a'.repeat(64);

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
  return { api, calls };
}

function rendererExports() {
  const window = {};
  vm.runInNewContext(controllerSource, { console, window }, {
    filename: path.join(root, 'src', 'renderer', 'prepare-controller.js')
  });
  return window.SyncShowPrepare;
}

function sermon() {
  return {
    schemaVersion: SERMON_SCHEMA_VERSION,
    kind: 'syncshow-sermon',
    id: 'sermon-exact-reading',
    titles: { en: 'The Word Before Us' },
    defaultLanguage: 'en',
    speaker: { id: null, name: 'Pastor' },
    serviceDate: '2026-07-27',
    series: null,
    outline: [],
    sources: [],
    references: [{
      id: 'primary-psalm',
      range: {
        schemaVersion: 1,
        bookId: 'Ps',
        start: { chapter: 119, verse: 1 },
        end: { chapter: 119, verse: 18 }
      },
      role: 'primary',
      source: 'operator',
      reviewStatus: 'confirmed',
      enteredText: 'Psalm 119:1-18',
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
  };
}

function linkedProject() {
  let project = createServiceProject({
    id: 'service-sermon-reading-contract',
    title: 'Sunday Service',
    serviceDate: '2026-07-27',
    profileId: 'main-sanctuary'
  });
  project = addGroupItem(project, {
    id: 'sermon-group',
    title: 'Sermon',
    groupKind: 'sermon'
  });
  const pinned = addSermonResource(project, sermon());
  project = setSermonSourceLink(pinned.project, {
    itemId: 'sermon-group',
    sermonResourceId: pinned.resourceId,
    sermonSectionId: null
  });
  return project;
}

function prepareText(value, label, maximum, { required = false } = {}) {
  if (value === undefined || value === null) value = '';
  if (typeof value !== 'string') throw new TypeError(`${label} must be text.`);
  const normalized = value.trim();
  if (required && !normalized) throw new TypeError(`${label} is required.`);
  if (normalized.length > maximum) throw new TypeError(`${label} is too long.`);
  return normalized;
}

test('sermon reading preload forwards intent only and drops renderer-owned content or position', async () => {
  const { api, calls } = loadPreloadBridge();
  await api.addSermonReadingToService({
    projectId: 'service-sermon-reading-contract',
    expectedRevisionId: PROJECT_REVISION,
    itemId: 'sermon-group',
    referenceId: 'primary-psalm',
    outputs: [
      {
        channelId: 'primary',
        mode: 'translation',
        translationId: 'BSB',
        verses: [{ hostile: true }]
      },
      {
        channelId: 'secondary',
        mode: 'translation',
        translationId: 'LSV',
        passage: { hostile: true }
      },
      { channelId: 'media', mode: 'hidden', translationId: 'BSB' }
    ],
    translationId: 'renderer-owned',
    range: { bookId: 'Rev' },
    passagesByChannel: { primary: { hostile: true } },
    sermonResourceId: `sha256:${'f'.repeat(64)}`,
    parentId: 'hostile-parent',
    index: 999,
    itemIds: ['hostile-reading']
  });

  assert.deepEqual(calls, [{
    channel: 'prepare:projects:addSermonReading',
    payload: {
      projectId: 'service-sermon-reading-contract',
      expectedRevisionId: PROJECT_REVISION,
      itemId: 'sermon-group',
      referenceId: 'primary-psalm',
      outputs: [
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

test('main resolves, chunks, pins, positions, CAS-saves, and idempotently reuses a sermon reading', async () => {
  const source = handlerSource('prepare:projects:addSermonReading');
  assert.match(source, /requireControlSender\(event\)/);
  assert.match(source, /readExpectedProject\(request\)/);
  assert.match(source, /requireExactPrepareKeys\(request,/);
  assert.match(source, /prepareBibleOutputSelections\(/);
  assert.match(source, /analyzeSermonPrimaryReading\(current\.project,/);
  assert.match(source, /maxVerses: bibleLibrary\.maxVerses/);
  assert.match(source, /resolvePreparedBibleOutputs\(\{/);
  assert.match(source, /placeBibleReadingItemsBefore\(next,/);
  assert.match(source, /reading\.reviewItemIds\.length/);
  assert.match(source, /expectedRevisionId: current\.expectedRevisionId/);
  assert.match(source, /reason: 'add-sermon-reading'/);
  assert.doesNotMatch(
    source,
    /request\.(?:translationId|range|passagesByChannel|sermonResourceId|parentId|index|itemIds)\b/
  );

  const helperStart = mainSource.indexOf('function prepareBibleOutputSelections');
  const helperEnd = mainSource.indexOf(
    "\nipcMain.handle('prepare:projects:addBible'",
    helperStart
  );
  assert.ok(helperStart >= 0 && helperEnd > helperStart);
  const bibleOutputHelpers = mainSource.slice(helperStart, helperEnd);
  let activeProject = linkedProject();
  let activeRevision = PROJECT_REVISION;
  let registeredHandler = null;
  let generatedId = 0;
  const saves = [];
  const bibleLibrary = new BibleLibrary({ maxVerses: 8 });
  const serviceProjectStore = {
    async save(project, options) {
      saves.push({ project, options: plain(options) });
      activeProject = project;
      activeRevision = String(saves.length + 1).repeat(64).slice(0, 64);
      return {
        project,
        revisionId: activeRevision,
        unchanged: false,
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
  vm.runInNewContext(`${bibleOutputHelpers}\n${source}`, {
    ipcMain: {
      handle(channel, handler) {
        assert.equal(channel, 'prepare:projects:addSermonReading');
        registeredHandler = handler;
      }
    },
    requireControlSender(event) {
      assert.equal(event.trusted, true);
    },
    requirePrepareRequest(request, maximumBytes) {
      assert.equal(maximumBytes, 32 * 1024);
      assert.equal(typeof request, 'object');
    },
    requireExactPrepareKeys(request, allowedKeys) {
      const unknownKeys = Object.keys(request)
        .filter(key => !allowedKeys.includes(key));
      if (unknownKeys.length > 0) {
        failMainOperation(
          'INVALID_PREPARE_REQUEST',
          'The request contains unsupported fields.',
          { fields: unknownKeys }
        );
      }
    },
    async readExpectedProject(request) {
      assert.equal(request.projectId, activeProject.id);
      assert.equal(request.expectedRevisionId, activeRevision);
      return {
        project: activeProject,
        revisionId: activeRevision,
        expectedRevisionId: activeRevision,
        recovery: null,
        services: { serviceProjectStore }
      };
    },
    prepareId(value) {
      return String(value);
    },
    prepareSermonDomainId(value) {
      return String(value);
    },
    prepareText,
    failMainOperation,
    isPowerPointCompanionProject,
    analyzeSermonPrimaryReading,
    bibleLibrary: {
      maxVerses: bibleLibrary.maxVerses,
      lookupCanonicalRange(range, options) {
        return bibleLibrary.lookupCanonicalRange(
          plain(range),
          plain(options)
        );
      }
    },
    resolveBookId,
    async resolveBibleLookupRequest(request) {
      return bibleLibrary.lookup(request.query, {
        translationId: request.translationId,
        ...(request.selectedBook ? { selectedBook: request.selectedBook } : {})
      });
    },
    projectItemId(prefix) {
      generatedId += 1;
      return `${prefix}-main-${generatedId}`;
    },
    addBibleItem,
    placeBibleReadingItemsBefore,
    projectResult(result) {
      return {
        project: result.project,
        revisionId: result.revisionId,
        unchanged: result.unchanged === true,
        recovery: result.recovery || null
      };
    }
  }, { filename: 'add-sermon-reading-handler.js' });

  const intent = {
    projectId: activeProject.id,
    expectedRevisionId: activeRevision,
    itemId: 'sermon-group',
    referenceId: 'primary-psalm',
    outputs: [
      { channelId: 'primary', mode: 'translation', translationId: 'BSB' },
      { channelId: 'secondary', mode: 'translation', translationId: 'LSV' },
      { channelId: 'media', mode: 'hidden' }
    ]
  };
  await assert.rejects(
    registeredHandler({ trusted: true }, {
      ...intent,
      range: { bookId: 'Rev' },
      passagesByChannel: { primary: { hostile: true } },
      parentId: 'hostile-parent',
      index: 999
    }),
    error => error.code === 'INVALID_PREPARE_REQUEST'
  );
  await assert.rejects(
    registeredHandler({ trusted: true }, {
      ...intent,
      outputs: activeProject.channelIds.map(channelId => ({
        channelId,
        mode: 'hidden'
      }))
    }),
    error => error.code === 'BIBLE_OUTPUTS_ALL_HIDDEN'
  );
  assert.equal(saves.length, 0, 'invalid output plans must fail before mutation');
  const first = await registeredHandler({ trusted: true }, intent);
  assert.equal(first.reading.cueCount, 3);
  assert.equal(first.reading.reference, 'Psalms 119:1-18');
  assert.equal(saves.length, 1);
  assert.deepEqual(activeProject.rootItemIds, [
    'bible-main-1',
    'bible-main-2',
    'bible-main-3',
    'sermon-group'
  ]);
  const generated = activeProject.rootItemIds.slice(0, 3).map(itemId =>
    activeProject.items[itemId]);
  assert.deepEqual(generated.map(item => [
    item.range.start.verse,
    item.range.end.verse
  ]), [[1, 8], [9, 16], [17, 18]]);
  assert.deepEqual(generated.map(item =>
    item.passagesByChannel.primary.verses.map(verse => verse.number)
  ), [
    [1, 2, 3, 4, 5, 6, 7, 8],
    [9, 10, 11, 12, 13, 14, 15, 16],
    [17, 18]
  ]);
  assert.ok(generated.every(item =>
    item.sermonReading.referenceId === 'primary-psalm'
    && item.sermonReading.translationId === undefined
    && item.sermonReading.sermonResourceId === activeProject.items['sermon-group'].sermonResourceId));
  assert.ok(generated.every(item =>
    item.passagesByChannel.primary.translationId === 'BSB'
    && item.passagesByChannel.secondary.translationId === 'LSV'
    && item.passagesByChannel.media === undefined));
  assert.deepEqual(
    plain(generated[0].sermonReading.outputs),
    intent.outputs
  );
  assert.deepEqual(saves[0].options, {
    expectedRevisionId: PROJECT_REVISION,
    reason: 'add-sermon-reading'
  });

  const second = await registeredHandler({ trusted: true }, {
    ...intent,
    expectedRevisionId: activeRevision
  });
  assert.equal(second.unchanged, true);
  assert.equal(second.reading.status, 'ready');
  assert.equal(saves.length, 1, 'an already-ready reading must not create another revision');

  activeProject = moveProjectItem(activeProject, {
    itemId: 'bible-main-1',
    targetParentId: null,
    targetIndex: activeProject.rootItemIds.length - 1
  });
  activeRevision = 'f'.repeat(64);
  const repaired = await registeredHandler({ trusted: true }, {
    ...intent,
    expectedRevisionId: activeRevision
  });
  assert.equal(repaired.reading.status, 'ready');
  assert.equal(saves.length, 2);
  assert.deepEqual(activeProject.rootItemIds.slice(0, 4), [
    'bible-main-1',
    'bible-main-2',
    'bible-main-3',
    'sermon-group'
  ]);
  assert.equal(generatedId, 3, 'position repair reuses the exact generated cues');
});

test('Prepare exposes reading status and action beside the linked sermon controls', () => {
  for (const id of [
    'prepareSermonReadingReference',
    'prepareSermonReadingOutputTreatments',
    'prepareSermonReadingOutputs',
    'prepareSermonReadingStatus',
    'btnAddSermonReading'
  ]) {
    assert.match(htmlSource, new RegExp(`id="${id}"`));
  }
  assert.match(controllerSource, /sermonPrimaryReadingState\(/);
  assert.match(controllerSource, /api\.addSermonReadingToService\(\{/);
  assert.match(
    controllerSource,
    /referenceId,\s*outputs:\s*cloneBibleOutputSelections\(outputs\)/
  );
  assert.match(controllerSource, /all-hidden congregational reading cannot be added/);
  assert.match(controllerSource, /immediately before the sermon/);
  assert.match(controllerSource, /status === 'out-of-position'/);
  assert.match(controllerSource, /status === 'wrong-passage'/);
  assert.match(controllerSource, /sermonReadingState\.reviewItemIds/);
});

test('Prepare reading status distinguishes ready, moved, and alternate-translation cues', () => {
  const { sermonPrimaryReadingState } = rendererExports();
  const resourceId = `sha256:${'b'.repeat(64)}`;
  const project = {
    rootItemIds: ['reading', 'sermon'],
    resources: {
      [resourceId]: {
        id: resourceId,
        kind: 'sermon',
        sha256: 'b'.repeat(64),
        document: sermon()
      }
    },
    items: {
      reading: {
        id: 'reading',
        kind: 'bible',
        title: 'Psalm 119:1-8',
        range: {
          bookId: 'Ps',
          start: { chapter: 119, verse: 1 },
          end: { chapter: 119, verse: 8 }
        },
        sermonReading: {
          sermonResourceId: resourceId,
          referenceId: 'primary-psalm',
          translationId: 'BSB',
          chunkIndex: 0,
          chunkCount: 3
        }
      },
      reading2: {
        id: 'reading2',
        kind: 'bible',
        title: 'Psalm 119:9-16',
        range: {
          bookId: 'Ps',
          start: { chapter: 119, verse: 9 },
          end: { chapter: 119, verse: 16 }
        },
        sermonReading: {
          sermonResourceId: resourceId,
          referenceId: 'primary-psalm',
          translationId: 'BSB',
          chunkIndex: 1,
          chunkCount: 3
        }
      },
      reading3: {
        id: 'reading3',
        kind: 'bible',
        title: 'Psalm 119:17-18',
        range: {
          bookId: 'Ps',
          start: { chapter: 119, verse: 17 },
          end: { chapter: 119, verse: 18 }
        },
        sermonReading: {
          sermonResourceId: resourceId,
          referenceId: 'primary-psalm',
          translationId: 'BSB',
          chunkIndex: 2,
          chunkCount: 3
        }
      },
      sermon: {
        id: 'sermon',
        kind: 'group',
        groupKind: 'sermon',
        title: 'Sermon',
        childIds: [],
        sermonResourceId: resourceId
      }
    }
  };
  project.rootItemIds = ['reading', 'reading2', 'reading3', 'sermon'];
  assert.equal(
    sermonPrimaryReadingState(
      project,
      'sermon',
      'primary-psalm',
      'BSB'
    ).status,
    'ready'
  );

  project.rootItemIds = ['reading2', 'reading3', 'sermon', 'reading'];
  assert.equal(
    sermonPrimaryReadingState(
      project,
      'sermon',
      'primary-psalm',
      'BSB'
    ).status,
    'out-of-position'
  );
  const alternateTranslation = sermonPrimaryReadingState(
    project,
    'sermon',
    'primary-psalm',
    'LSV'
  );
  assert.equal(alternateTranslation.status, 'wrong-passage');
  assert.deepEqual(
    Array.from(alternateTranslation.reviewItemIds).sort(),
    ['reading', 'reading2', 'reading3']
  );

  project.resources[resourceId].document.references.push({
    ...project.resources[resourceId].document.references[0],
    id: 'other-primary',
    enteredText: 'Psalm 119:9-16',
    range: {
      schemaVersion: 1,
      bookId: 'Ps',
      start: { chapter: 119, verse: 9 },
      end: { chapter: 119, verse: 16 }
    }
  });
  const alternatePrimary = sermonPrimaryReadingState(
    project,
    'sermon',
    'other-primary',
    'BSB'
  );
  assert.equal(alternatePrimary.status, 'wrong-passage');
  assert.deepEqual(
    Array.from(alternatePrimary.conflictingReferenceItemIds).sort(),
    ['reading', 'reading2', 'reading3']
  );
});
