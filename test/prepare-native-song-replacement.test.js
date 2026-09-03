'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const mainSource = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
const preloadSource = fs.readFileSync(path.join(root, 'preload.js'), 'utf8');
const prepareSource = fs.readFileSync(
  path.join(root, 'src', 'renderer', 'prepare-controller.js'),
  'utf8'
);
const stylesSource = fs.readFileSync(
  path.join(root, 'src', 'renderer', 'styles.css'),
  'utf8'
);

const PROJECT_REVISION = 'a'.repeat(64);
const SONG_REVISION = 'b'.repeat(64);

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

function namedFunctionSource(source, marker, nextMarker) {
  const start = source.indexOf(marker);
  assert.notEqual(start, -1, `${marker} must be implemented`);
  const end = source.indexOf(nextMarker, start + marker.length);
  assert.notEqual(end, -1, `${marker} must have a bounded source region`);
  return source.slice(start, end);
}

test('native song replacement is one trusted exact-revision project mutation', () => {
  const source = handlerSource('prepare:projects:replaceSong');

  assert.match(source, /requireControlSender\(event\)/);
  assert.match(source, /requirePrepareRequest\(request,\s*32\s*\*\s*1024\)/);
  assert.match(source, /const current = await readExpectedProject\(request\)/);
  assert.match(source, /projectSongItem\(current\.project,\s*itemId\)/);
  assert.match(
    source,
    /localSongLibrary\.read\(songId,\s*\{\s*revision:\s*songRevisionId\s*\}\)/
  );
  assert.match(
    source,
    /prepareServiceSongItem\(current\.project,\s*songRead\)/
  );
  assert.match(
    source,
    /replaceSongItem\(\s*prepared\.project,\s*itemId,\s*prepared\.item\s*\)/
  );
  assert.equal(
    (source.match(/serviceProjectStore\.save\(/g) || []).length,
    1,
    'replacement must create one saved project revision'
  );
  assert.match(source, /expectedRevisionId:\s*current\.expectedRevisionId/);
  assert.match(source, /reason:\s*'replace-song'/);
  assert.match(source, /replacementItemId/);
  assert.doesNotMatch(
    source,
    /request\.(?:project|resources|resourceId|arrangement|variants|parentId|index|sourcePath|filePath|packagePath|cacheDir)\b/,
    'renderer input cannot choose project bytes, placement, arrangement, routing, or paths'
  );
});

test('Add and Replace share the trusted fresh song-item builder', () => {
  const builder = namedFunctionSource(
    mainSource,
    'function prepareServiceSongItem(',
    'function requestedArrangement('
  );
  const addHandler = handlerSource('prepare:projects:addSong');
  const replaceHandler = handlerSource('prepare:projects:replaceSong');

  assert.match(builder, /addSongResource\(project,\s*songRead\.song/);
  assert.match(builder, /revision:\s*songRead\.revision/);
  assert.match(builder, /id:\s*projectItemId\('song'\)/);
  assert.match(builder, /id:\s*projectItemId\('arr'\)/);
  assert.match(builder, /titlePresetId:\s*'song-title'/);
  assert.match(builder, /lyricsPresetId:\s*'song-lyrics'/);
  assert.match(addHandler, /prepareServiceSongItem\(/);
  assert.match(replaceHandler, /prepareServiceSongItem\(/);
});

test('replacement preload forwards only exact semantic identities', async () => {
  const { api, calls } = loadPreloadBridge();
  assert.equal(typeof api.replaceSongInService, 'function');

  await api.replaceSongInService({
    projectId: 'service-sunday',
    expectedRevisionId: PROJECT_REVISION,
    itemId: 'song-old',
    songId: 'song-new',
    songRevisionId: SONG_REVISION,
    arrangement: [{ id: 'renderer-arrangement', sectionId: 'hostile' }],
    variants: { primary: { mode: 'hide' } },
    parentId: 'different-parent',
    index: 999,
    project: { hostile: true },
    resources: { hostile: true },
    sourcePath: '/private/hostile'
  });

  assert.deepEqual(calls, [{
    channel: 'prepare:projects:replaceSong',
    payload: {
      projectId: 'service-sunday',
      expectedRevisionId: PROJECT_REVISION,
      itemId: 'song-old',
      songId: 'song-new',
      songRevisionId: SONG_REVISION
    }
  }]);
});

test('native replacement UI confirms the exact change and records one Undo step', () => {
  const source = namedFunctionSource(
    prepareSource,
    'async function replaceSelectedSong(',
    'function openTextDialog('
  );

  assert.match(source, /row\?\.item\?\.kind !== 'song'/);
  assert.match(source, /isPowerPointCompanionProject\(state\.currentProject\)/);
  assert.match(
    source,
    /Replace “\$\{previousTitle\}” with “\$\{replacementTitle\}” in this exact service position/
  );
  assert.match(source, /default section order and output behavior/);
  assert.match(source, /Undo restores the previous song/);
  assert.match(source, /const result = await mutateProject\(/);
  assert.doesNotMatch(source, /trackHistory:\s*false/);
  assert.match(source, /api\.replaceSongInService\(\{/);
  assert.match(source, /expectedRevisionId:\s*state\.revisionId/);
  assert.match(source, /const replacementItemId = result\.replacementItemId/);
  assert.match(source, /state\.selectedItemId = replacementItemId/);
  assert.match(source, /button\.dataset\.itemId === replacementItemId/);
  assert.match(source, /target\?\.scrollIntoView/);
});

test('replacement action is native-only and keeps failure beside its exact library choice', () => {
  const songListSource = namedFunctionSource(
    prepareSource,
    'function renderSongList(',
    'function readinessSummaryText('
  );
  const replaceSource = namedFunctionSource(
    prepareSource,
    'async function replaceSelectedSong(',
    'function openTextDialog('
  );

  assert.match(
    prepareSource,
    /const ENABLE_LEGACY_POWERPOINT_SONG_RANGE_REPLACEMENT = false/
  );
  assert.match(
    songListSource,
    /!isPowerPointCompanionProject\(\s*state\.currentProject\s*\)[\s\S]*?item\?\.kind === 'song'/
  );
  assert.match(songListSource, /'Replace selected'/);
  assert.match(songListSource, /dataset\.nativeSongReplacement = 'true'/);
  assert.match(songListSource, /dataset\.replacementTargetItemId/);
  assert.match(
    songListSource,
    /if\s*\(\s*replacementError\s*&&\s*replacementError\.targetItemId === selectedNativeSong\?\.id/,
    'an empty replacement error and an unselected song must not enter the inline-error branch'
  );
  assert.match(songListSource, /class="prepare-song-replacement-error"|prepare-song-replacement-error/);
  assert.match(songListSource, /inlineError\.setAttribute\('role', 'alert'\)/);
  assert.match(songListSource, /setAttribute\('aria-describedby', errorId\)/);
  assert.match(replaceSource, /onError\(message\)/);
  assert.match(replaceSource, /state\.songReplacementError = \{/);
  assert.match(replaceSource, /focusReplacementAction\(\)/);
  assert.match(stylesSource, /\.prepare-song-replacement-error\s*\{/);
  assert.match(stylesSource, /grid-column:\s*1\s*\/\s*-1/);
});
