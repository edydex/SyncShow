'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const mainSource = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
const preloadSource = fs.readFileSync(path.join(root, 'preload.js'), 'utf8');
const prepareSource = fs.readFileSync(path.join(root, 'src', 'renderer', 'prepare-controller.js'), 'utf8');
const rendererHtml = fs.readFileSync(path.join(root, 'src', 'renderer', 'index.html'), 'utf8');

const PROJECT_REVISION = 'a'.repeat(64);
const SONG_REVISION = 'b'.repeat(64);

const preview7Channels = Object.freeze([
  'prepare:projects:addGroup',
  'prepare:projects:updateSongArrangement',
  'prepare:projects:linkSongTranslation',
  'prepare:projects:resetSongTranslation',
  'prepare:projects:addBible'
]);

function plain(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function loadPreloadBridge() {
  const calls = [];
  let api = null;
  const ipcRenderer = {
    invoke(channel, payload) {
      calls.push({ kind: 'invoke', channel, payload: plain(payload) });
      return Promise.resolve({ ok: true });
    },
    send(channel, payload) {
      calls.push({ kind: 'send', channel, payload: plain(payload) });
    },
    on() {},
    removeListener() {}
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

function assertTrustedCasMutation(channel, maximumRequestBytes = 64 * 1024) {
  const source = handlerSource(channel);
  assert.match(source, /requireControlSender\(event\)/,
    `${channel} must accept only the trusted control main frame`);
  assert.match(source, /requirePrepareRequest\(request,\s*([0-9]+)\s*\*\s*1024\)/,
    `${channel} must bound and validate its request`);
  const sizeMatch = source.match(/requirePrepareRequest\(request,\s*([0-9]+)\s*\*\s*1024\)/);
  assert.ok(Number(sizeMatch[1]) * 1024 <= maximumRequestBytes,
    `${channel} must not accept an unnecessarily large request`);
  assert.match(source, /readExpectedProject\(request\)/,
    `${channel} must load the project through the stale-revision guard`);
  assert.match(source, /serviceProjectStore\.save\(/,
    `${channel} must commit through the immutable project store`);
  assert.match(source, /expectedRevisionId:\s*current\.expectedRevisionId/,
    `${channel} must use the revision checked at the start of the operation`);
  assert.doesNotMatch(source, /request\.(?:project|resources|resourceId|sourcePath|filePath|packagePath|cacheDir)\b/,
    `${channel} must not accept renderer-owned project blobs, resources, or native paths`);
  return source;
}

test('Preview 7 mutations exist as narrow, trusted, revision-checked IPC handlers', () => {
  for (const channel of preview7Channels) {
    assertTrustedCasMutation(channel);
  }
});

test('createServiceGroup forwards only semantic group fields and the expected project revision', async () => {
  const { api, calls } = loadPreloadBridge();
  assert.equal(typeof api.createServiceGroup, 'function');

  await api.createServiceGroup({
    projectId: 'service-sunday',
    expectedRevisionId: PROJECT_REVISION,
    title: 'Worship',
    groupKind: 'section',
    parentId: 'service-root',
    childIds: ['hostile-child'],
    project: { hostile: true },
    sourcePath: '/private/hostile'
  });

  assert.deepEqual(calls, [{
    kind: 'invoke',
    channel: 'prepare:projects:addGroup',
    payload: {
      projectId: 'service-sunday',
      expectedRevisionId: PROJECT_REVISION,
      title: 'Worship',
      groupKind: 'section',
      parentId: 'service-root'
    }
  }]);
});

test('updateSongArrangement carries stable entry identities but no editable project blob', async () => {
  const { api, calls } = loadPreloadBridge();
  assert.equal(typeof api.updateSongArrangement, 'function');
  const arrangement = [
    { id: 'arr-verse-1', sectionId: 'verse-1' },
    { id: 'arr-chorus-2', sectionId: 'chorus' },
    { id: 'arr-chorus-1', sectionId: 'chorus' }
  ];

  await api.updateSongArrangement({
    projectId: 'service-sunday',
    expectedRevisionId: PROJECT_REVISION,
    itemId: 'song-amazing-grace',
    arrangement,
    project: { hostile: true },
    resources: { hostile: true }
  });

  assert.deepEqual(calls, [{
    kind: 'invoke',
    channel: 'prepare:projects:updateSongArrangement',
    payload: {
      projectId: 'service-sunday',
      expectedRevisionId: PROJECT_REVISION,
      itemId: 'song-amazing-grace',
      arrangement
    }
  }]);
});

test('linkSongTranslation forwards a pinned library revision and chosen channel, never song content', async () => {
  const { api, calls } = loadPreloadBridge();
  assert.equal(typeof api.linkSongTranslation, 'function');

  await api.linkSongTranslation({
    projectId: 'service-sunday',
    expectedRevisionId: PROJECT_REVISION,
    itemId: 'song-amazing-grace',
    channelId: 'secondary',
    songId: 'amazing-grace-uk',
    songRevisionId: SONG_REVISION,
    song: { title: 'renderer-controlled content' },
    resourceId: `sha256:${'c'.repeat(64)}`,
    sourcePath: '/private/hostile'
  });

  assert.deepEqual(calls, [{
    kind: 'invoke',
    channel: 'prepare:projects:linkSongTranslation',
    payload: {
      projectId: 'service-sunday',
      expectedRevisionId: PROJECT_REVISION,
      itemId: 'song-amazing-grace',
      channelId: 'secondary',
      songId: 'amazing-grace-uk',
      songRevisionId: SONG_REVISION
    }
  }]);
});

test('song translation discovery and reset keep content authority in main', async () => {
  const { api, calls } = loadPreloadBridge();
  assert.equal(typeof api.listSongTranslationsForServiceItem, 'function');
  assert.equal(typeof api.resetSongTranslation, 'function');

  await api.listSongTranslationsForServiceItem({
    projectId: 'service-sunday',
    expectedRevisionId: PROJECT_REVISION,
    itemId: 'song-amazing-grace',
    query: 'renderer-controlled',
    sectionIds: ['renderer-controlled']
  });
  await api.resetSongTranslation({
    projectId: 'service-sunday',
    expectedRevisionId: PROJECT_REVISION,
    itemId: 'song-amazing-grace',
    channelId: 'media',
    mode: 'renderer-controlled',
    resourceId: `sha256:${'c'.repeat(64)}`
  });

  assert.deepEqual(calls, [
    {
      kind: 'invoke',
      channel: 'prepare:songs:translationsForItem',
      payload: {
        projectId: 'service-sunday',
        expectedRevisionId: PROJECT_REVISION,
        itemId: 'song-amazing-grace'
      }
    },
    {
      kind: 'invoke',
      channel: 'prepare:projects:resetSongTranslation',
      payload: {
        projectId: 'service-sunday',
        expectedRevisionId: PROJECT_REVISION,
        itemId: 'song-amazing-grace',
        channelId: 'media'
      }
    }
  ]);
});

test('addBiblePassageToService sends lookup intent only; main owns canonical resolution and verse text', async () => {
  const { api, calls } = loadPreloadBridge();
  assert.equal(typeof api.addBiblePassageToService, 'function');

  await api.addBiblePassageToService({
    projectId: 'service-sunday',
    expectedRevisionId: PROJECT_REVISION,
    reference: 'pet 1 4',
    translationId: 'BSB',
    selectedBookId: '2 Peter',
    parentId: 'scripture-readings',
    passage: { reference: '1 Peter 1:4' },
    verses: [{ number: 4, text: 'renderer-controlled text' }],
    attribution: 'renderer-controlled attribution'
  });

  assert.deepEqual(calls, [{
    kind: 'invoke',
    channel: 'prepare:projects:addBible',
    payload: {
      projectId: 'service-sunday',
      expectedRevisionId: PROJECT_REVISION,
      reference: 'pet 1 4',
      translationId: 'BSB',
      selectedBookId: '2 Peter',
      parentId: 'scripture-readings'
    }
  }]);
});

test('reorder, indent, and outdent all use the same revision-checked move primitive', async () => {
  const { api, calls } = loadPreloadBridge();
  assert.equal(typeof api.moveServiceItem, 'function');

  await api.moveServiceItem({
    projectId: 'service-sunday',
    expectedRevisionId: '1'.repeat(64),
    itemId: 'song-one',
    targetParentId: null,
    targetIndex: 0
  });
  await api.moveServiceItem({
    projectId: 'service-sunday',
    expectedRevisionId: '2'.repeat(64),
    itemId: 'song-one',
    targetParentId: 'worship',
    targetIndex: 0
  });
  await api.moveServiceItem({
    projectId: 'service-sunday',
    expectedRevisionId: '3'.repeat(64),
    itemId: 'song-one',
    targetParentId: null,
    targetIndex: 2
  });

  assert.deepEqual(calls, [
    {
      kind: 'invoke',
      channel: 'prepare:projects:moveItem',
      payload: {
        projectId: 'service-sunday',
        expectedRevisionId: '1'.repeat(64),
        itemId: 'song-one',
        targetParentId: null,
        targetIndex: 0
      }
    },
    {
      kind: 'invoke',
      channel: 'prepare:projects:moveItem',
      payload: {
        projectId: 'service-sunday',
        expectedRevisionId: '2'.repeat(64),
        itemId: 'song-one',
        targetParentId: 'worship',
        targetIndex: 0
      }
    },
    {
      kind: 'invoke',
      channel: 'prepare:projects:moveItem',
      payload: {
        projectId: 'service-sunday',
        expectedRevisionId: '3'.repeat(64),
        itemId: 'song-one',
        targetParentId: null,
        targetIndex: 2
      }
    }
  ]);

  assertTrustedCasMutation('prepare:projects:moveItem', 16 * 1024);
});

test('group and arrangement handlers construct validated semantic mutations in main', () => {
  const groupSource = assertTrustedCasMutation('prepare:projects:addGroup', 16 * 1024);
  assert.match(groupSource, /prepareText\(request\.title/);
  assert.match(groupSource, /addGroupItem\(/,
    'new groups must pass through the domain helper that always starts them empty');
  assert.doesNotMatch(groupSource, /request\.childIds/);

  const arrangementSource = assertTrustedCasMutation(
    'prepare:projects:updateSongArrangement',
    64 * 1024
  );
  assert.match(arrangementSource, /prepareId\(request\.itemId/);
  assert.match(arrangementSource, /updateSongArrangement\(/,
    'the main handler must use the domain mutation that preserves and validates arrangement IDs');
  assert.match(arrangementSource, /request\.arrangement/);
});

test('translation linking resolves an exact library revision in main before validating compatibility', () => {
  const source = assertTrustedCasMutation(
    'prepare:projects:linkSongTranslation',
    32 * 1024
  );
  assert.match(source, /prepareId\(request\.itemId/);
  assert.match(source, /prepareId\(request\.channelId/);
  assert.match(source, /prepareId\(request\.songId/);
  assert.match(source, /prepareRevision\([^)]*(?:songRevisionId|songRevision)/);
  assert.match(source, /localSongLibrary\.read\(/);
  assert.match(source, /linkSongTranslation\(/,
    'translation compatibility must be enforced by the validated domain mutation');
  assert.doesNotMatch(source, /request\.(?:song|document|resource|resourceId|origin)\b/);
});

test('translation candidates and reset use the same authoritative project model', () => {
  const discovery = handlerSource('prepare:songs:translationsForItem');
  assert.match(discovery, /requireControlSender\(event\)/);
  assert.match(discovery, /readExpectedProject\(request\)/);
  assert.match(discovery, /projectSongItem\(/);
  assert.match(discovery, /resolveAuthoritativeSongSource\(/);
  assert.match(discovery, /localSongLibrary\.read\(/);
  assert.match(discovery, /compareSongTranslations\(/);
  assert.doesNotMatch(discovery, /request\.(?:query|sectionIds|song|document|resourceId)\b/);

  const reset = assertTrustedCasMutation(
    'prepare:projects:resetSongTranslation',
    16 * 1024
  );
  assert.match(reset, /resetSongChannelVariant\(/);
  assert.match(reset, /\(media\|singer\|stage\)/);
  assert.doesNotMatch(reset, /request\.(?:mode|variant|resourceId|song)\b/);
});

test('Bible authoring rejects unresolved ambiguity before pinning main-owned canonical text', () => {
  const source = assertTrustedCasMutation('prepare:projects:addBible', 32 * 1024);
  const lookupIndex = Math.max(
    source.indexOf('resolveBibleLookupRequest('),
    source.indexOf('bibleLibrary.lookup(')
  );
  const ambiguityIndex = source.indexOf("'ambiguous'");
  const addIndex = source.indexOf('addBibleItem(');

  assert.ok(lookupIndex >= 0, 'main must resolve the local Bible lookup itself');
  assert.match(source, /const reference = prepareText\(request\.reference/);
  assert.match(source, /const translationId = prepareText\(request\.translationId/);
  assert.match(source, /const selectedBookId = request\.selectedBookId/);
  assert.match(source, /query:\s*reference/);
  assert.match(source, /translationId(?:,\s*|\s*:\s*translationId)/);
  assert.match(source, /selectedBook:\s*selectedBookId/);
  assert.ok(ambiguityIndex > lookupIndex && addIndex > ambiguityIndex,
    'an ambiguous shorthand must require a canonical book choice before any project mutation');
  assert.match(source, /(?:lookup|lookupResult)\.passage/);
  assert.match(source, /addBibleItem\(/,
    'resolved text must pass through the domain helper that pins range, text, attribution, and checksum');
  assert.doesNotMatch(source, /request\.(?:passage|verses|attribution|book|chapter|verseStart|verseEnd)\b/,
    'canonical range, verse text, and attribution must come from the trusted local Bible library');
});

test('Prepare keeps advanced song editing intentional while exposing the simple workflow actions', () => {
  for (const id of [
    'btnAddServiceGroup',
    'btnIndentPrepareItem',
    'btnOutdentPrepareItem',
    'prepareSongEditor',
    'prepareSongArrangementList',
    'prepareSongTranslationChannel',
    'prepareSongTranslationSong',
    'prepareBibleReference',
    'prepareBibleTranslation',
    'prepareBibleAmbiguity',
    'prepareBibleResult',
    'btnAddBiblePassage'
  ]) {
    assert.match(rendererHtml, new RegExp(`id="${id}"`), `${id} must be present in Prepare`);
  }
  assert.match(rendererHtml, /<details id="prepareSongEditor"[^>]*>/);
  assert.doesNotMatch(rendererHtml, /<details id="prepareSongEditor"[^>]*\sopen(?:\s|>)/,
    'advanced song controls must start collapsed');
  assert.match(rendererHtml, /<option value="BSB" selected>BSB<\/option>/);
  assert.match(rendererHtml, /<option value="LSV">LSV<\/option>/);
});

test('Prepare controller uses semantic mutations for arrangements, translations, nesting, and Bible pinning', () => {
  assert.match(prepareSource, /api\.createServiceGroup\(/);
  assert.match(prepareSource, /api\.updateSongArrangement\(/);
  assert.match(prepareSource, /api\.linkSongTranslation\(/);
  assert.match(prepareSource, /api\.resetSongTranslation\(/);
  assert.match(prepareSource, /api\.listSongTranslationsForServiceItem\(/);
  assert.match(prepareSource, /api\.addBiblePassageToService\(/);
  assert.match(prepareSource, /function indentDestination\(project, row\)/);
  assert.match(prepareSource, /function outdentDestination\(project, row\)/);
  assert.match(prepareSource, /targetParentId:\s*previous\.id/);
  assert.match(prepareSource, /targetIndex:\s*parentRow\.index \+ 1/);
  assert.match(prepareSource, /\{ sectionId \}/,
    'new repeated song sections must let main create a fresh stable arrangement identity');
  assert.match(prepareSource, /selectedBook:\s*selectedBookId/);
  const addBibleStart = prepareSource.indexOf('async function addPreparedBible()');
  const addBibleEnd = prepareSource.indexOf('async function saveSelectedSongArrangement', addBibleStart);
  const addBibleSource = prepareSource.slice(addBibleStart, addBibleEnd);
  assert.doesNotMatch(addBibleSource, /\bpassage\s*:/);
  assert.doesNotMatch(addBibleSource, /\bverses\s*:/);
});

test('new projects mirror configured venue roles and stale revisions cannot replace Load', () => {
  assert.match(mainSource, /function nativeProjectChannels\(profile = activeVenueProfile\)/);
  assert.match(mainSource, /\.filter\(role => role\.enabled && role\.kind === 'deck'\)/);
  assert.match(mainSource, /channels:\s*nativeProjectChannels\(\)/);
  assert.match(
    mainSource,
    /const sourceChannelId = withResource\.project\.channelIds\.includes\('primary'\)[\s\S]*\? 'primary'[\s\S]*:\s*withResource\.project\.channelIds\.find/
  );
  assert.match(mainSource, /!\s*\/\(media\|singer\|stage\)\//);

  const publish = handlerSource('prepare:projects:publish');
  const publication = publish.indexOf('showPackagePublisher.publish(');
  const finalRead = publish.indexOf('currentBeforeInstall');
  const install = publish.indexOf('installPresentation(roleId, presentation)');
  assert.match(publish, /const selected = await services\.serviceProjectStore\.read\(projectId\)/);
  assert.match(publish, /selected\.revisionId !== revisionId/);
  assert.match(publish, /currentBeforeInstall\.revisionId !== revisionId/);
  assert.ok(publication >= 0 && finalRead > publication && install > finalRead,
    'the current project pointer must be rechecked after rendering and before Load changes');

  assert.match(prepareSource, /const hasProjectedItems = flattenProject\(state\.currentProject\)\.some\(row => row\.item\.kind !== 'group'\)/,
    'collapsed editor sections must not make a publishable service appear empty');
  assert.match(prepareSource, /btnAddGroup\.addEventListener\('click', \(\) => openGroupDialog\(\)\)/,
    'the normal Add section action must continue to create a root sibling');
  assert.match(prepareSource, /btnAddInside\.addEventListener\('click'/);
  assert.match(prepareSource, /\.\.\.\(state\.groupParentId \? \{ parentId: state\.groupParentId \} : \{\}\)/,
    'nesting at creation time must require the explicit Add inside action');
});
