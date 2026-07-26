'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs/promises');
const fsSync = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');

const { LocalSongLibrary } = require('../src/services/project/LocalSongLibrary');
const {
  MAX_SONG_BATCH_IMPORT_FILES,
  importSongFilesSequentially
} = require('../src/services/project/SongBatchImport');

const root = path.join(__dirname, '..');
const controllerPath = path.join(root, 'src', 'renderer', 'prepare-controller.js');
const controllerSource = fsSync.readFileSync(controllerPath, 'utf8');
const html = fsSync.readFileSync(path.join(root, 'src', 'renderer', 'index.html'), 'utf8');
const mainSource = fsSync.readFileSync(path.join(root, 'main.js'), 'utf8');

function rendererExports() {
  const window = {};
  vm.runInNewContext(controllerSource, { console, window }, { filename: controllerPath });
  return window.SyncShowPrepare;
}

async function tempDirectory(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'syncshow-song-batch-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return fs.realpath(directory);
}

function songSource({ id, title, line, translationOf = null }) {
  const metadata = [
    '---',
    `id: ${id}`,
    `title: ${JSON.stringify(title)}`,
    'language: en'
  ];
  if (translationOf) metadata.push(`translationOf: ${translationOf}`);
  return [
    ...metadata,
    '---',
    '',
    '^1',
    line,
    ''
  ].join('\n');
}

function songSummary(index, overrides = {}) {
  return {
    id: `song-${String(index).padStart(3, '0')}`,
    title: `Song ${String(index).padStart(3, '0')}`,
    revision: `revision-${index}`,
    ...overrides
  };
}

function handlerSource(channel) {
  const marker = `ipcMain.handle('${channel}'`;
  const start = mainSource.indexOf(marker);
  assert.notEqual(start, -1, `${channel} must exist`);
  const next = mainSource.indexOf("ipcMain.handle('", start + marker.length);
  return mainSource.slice(start, next === -1 ? mainSource.length : next);
}

test('song pagination renders more than 100 songs and deduplicates shifted page identities', () => {
  const { applySongLibraryPage } = rendererExports();
  const state = {
    songs: [],
    songTotal: 0,
    songNextOffset: null,
    songQuery: '',
    songRequest: 1
  };
  const firstPage = Array.from({ length: 100 }, (_unused, index) => songSummary(index));

  assert.equal(applySongLibraryPage(state, {
    id: 1,
    query: '',
    offset: 0,
    append: false
  }, {
    items: firstPage,
    total: 101,
    offset: 0,
    nextOffset: 100
  }), true);
  assert.equal(state.songs.length, 100);
  assert.equal(state.songTotal, 101);
  assert.equal(state.songNextOffset, 100);

  state.songRequest = 2;
  assert.equal(applySongLibraryPage(state, {
    id: 2,
    query: '',
    offset: 100,
    append: true
  }, {
    items: [
      songSummary(99, { revision: 'updated-revision' }),
      songSummary(100)
    ],
    total: 101,
    offset: 100,
    nextOffset: null
  }), true);

  assert.equal(state.songs.length, 101);
  assert.equal(new Set(state.songs.map(song => song.id)).size, 101);
  assert.equal(state.songs.find(song => song.id === 'song-099').revision, 'updated-revision');
  assert.equal(state.songs.at(-1).id, 'song-100');
  assert.equal(state.songNextOffset, null);
});

test('superseded append and search responses cannot overwrite the current song query', () => {
  const { applySongLibraryPage, canApplySongLibraryPage } = rendererExports();
  const state = {
    songs: [songSummary(7)],
    songTotal: 1,
    songNextOffset: null,
    songQuery: 'hope',
    songRequest: 4
  };
  const before = JSON.stringify(state);
  const oldAppend = {
    id: 3,
    query: '',
    offset: 100,
    append: true
  };

  assert.equal(canApplySongLibraryPage(oldAppend, state), false);
  assert.equal(applySongLibraryPage(state, oldAppend, {
    items: [songSummary(100)],
    total: 101,
    nextOffset: null
  }), false);
  assert.equal(JSON.stringify(state), before);

  const staleSameQuery = {
    id: 3,
    query: 'hope',
    offset: 0,
    append: false
  };
  assert.equal(applySongLibraryPage(state, staleSameQuery, {
    items: [songSummary(8)],
    total: 1,
    nextOffset: null
  }), false);
  assert.equal(JSON.stringify(state), before);
});

test('partial import summary distinguishes added, unchanged, forked, and failed files', () => {
  const { summarizeSongImport } = rendererExports();
  const outcome = summarizeSongImport({
    summary: {
      selected: 5,
      added: 2,
      unchanged: 1,
      forked: 1,
      failed: 1
    },
    files: [
      { fileName: 'broken.md', status: 'failed' }
    ]
  });

  assert.equal(outcome.kind, 'warning');
  assert.match(outcome.message, /2 added/);
  assert.match(outcome.message, /1 saved as new copies/);
  assert.match(outcome.message, /1 unchanged/);
  assert.match(outcome.message, /1 failed/);
  assert.match(outcome.message, /Failed: broken\.md/);
});

test('batch import keeps successes around duplicate ids and partial failure', async t => {
  const directory = await tempDirectory(t);
  const library = new LocalSongLibrary({ rootPath: path.join(directory, 'library') });
  const selected = [
    ['first.md', songSource({ id: 'shared-song', title: 'Shared Song', line: 'First lyrics' })],
    ['same.txt', songSource({ id: 'shared-song', title: 'Shared Song', line: 'First lyrics' })],
    ['fork.markdown', songSource({ id: 'shared-song', title: 'Shared Song', line: 'Changed lyrics' })],
    ['broken.md', '---\nid: broken\n'],
    ['after-failure.md', songSource({ id: 'after-failure', title: 'After Failure', line: 'Still imported' })]
  ];
  const filePaths = [];
  for (const [fileName, source] of selected) {
    const filePath = path.join(directory, fileName);
    await fs.writeFile(filePath, source);
    filePaths.push(filePath);
  }

  const result = await importSongFilesSequentially(
    filePaths,
    filePath => library.importFile(filePath, { onConflict: 'fork' })
  );

  assert.deepEqual(result.summary, {
    selected: 5,
    added: 2,
    unchanged: 1,
    forked: 1,
    failed: 1
  });
  assert.deepEqual(result.files.map(file => file.status), [
    'added',
    'unchanged',
    'forked',
    'failed',
    'added'
  ]);
  assert.equal(result.files[2].songId, 'shared-song-local-2');
  assert.equal(result.files[3].error.code, 'UNCLOSED_FRONT_MATTER');
  assert.equal(result.files[3].error.message.includes(directory), false);
  assert.equal(JSON.stringify(result.files).includes(directory), false);
  assert.equal(result.files.some(file => 'filePath' in file || 'sourcePath' in file), false);

  const listed = await library.list({ pageSize: 100 });
  assert.deepEqual(listed.items.map(song => song.id), [
    'after-failure',
    'shared-song',
    'shared-song-local-2'
  ]);
});

test('batch import resolves translations selected before their original songs', async t => {
  const directory = await tempDirectory(t);
  const library = new LocalSongLibrary({ rootPath: path.join(directory, 'library') });
  const translationPath = path.join(directory, 'a-translation.md');
  const originalPath = path.join(directory, 'z-original.md');
  await fs.writeFile(translationPath, songSource({
    id: 'song-es',
    title: 'Song Spanish',
    line: 'Translated lyrics',
    translationOf: 'song-root'
  }));
  await fs.writeFile(originalPath, songSource({
    id: 'song-root',
    title: 'Song Original',
    line: 'Original lyrics'
  }));

  const result = await importSongFilesSequentially(
    [translationPath, originalPath],
    filePath => library.importFile(filePath, { onConflict: 'fork' })
  );

  assert.deepEqual(result.summary, {
    selected: 2,
    added: 2,
    unchanged: 0,
    forked: 0,
    failed: 0
  });
  assert.deepEqual(result.files.map(file => file.status), ['added', 'added']);
  assert.equal((await library.read('song-es')).song.translationOf, 'song-root');
});

test('a truly missing translation original is retried once and reported safely', async () => {
  let attempts = 0;
  const result = await importSongFilesSequentially(
    ['/private/translation-without-original.md'],
    async () => {
      attempts += 1;
      const error = new Error('/private/original-secret.md does not exist');
      error.code = 'TRANSLATION_TARGET_NOT_FOUND';
      throw error;
    }
  );

  assert.equal(attempts, 2);
  assert.deepEqual(result.summary, {
    selected: 1,
    added: 0,
    unchanged: 0,
    forked: 0,
    failed: 1
  });
  assert.equal(result.files[0].error.code, 'TRANSLATION_TARGET_NOT_FOUND');
  assert.match(result.files[0].error.message, /original song/);
  assert.equal(JSON.stringify(result).includes('/private/original-secret.md'), false);
});

test('batch import rejects an oversized selection before importing any file', async () => {
  let imports = 0;
  const selected = Array.from(
    { length: MAX_SONG_BATCH_IMPORT_FILES + 1 },
    (_unused, index) => `/private/song-${index}.md`
  );
  await assert.rejects(
    importSongFilesSequentially(selected, async () => {
      imports += 1;
    }),
    error => error.code === 'TOO_MANY_SONG_IMPORT_FILES'
      && error.details.maximum === MAX_SONG_BATCH_IMPORT_FILES
  );
  assert.equal(imports, 0);
});

test('song import IPC is cancellable, multi-select, capped, sequential, and path-minimal', () => {
  const source = handlerSource('prepare:songs:import');
  assert.match(source, /properties: \['openFile', 'multiSelections'\]/);
  assert.match(source, /MAX_SONG_BATCH_IMPORT_FILES/);
  assert.match(source, /if \(result\.canceled \|\| result\.filePaths\.length === 0\) return null/);
  assert.match(source, /importSongFilesSequentially\(\s*result\.filePaths/);
  assert.match(source, /retrySongWrite\(\(\) => library\.importFile\(sourcePath/);
  assert.doesNotMatch(source, /filePaths\[0\]/);
});

test('Prepare exposes an accessible count and Load more control with one final import refresh', () => {
  assert.match(html, /id="prepareSongCount"[^>]+role="status"[^>]+aria-live="polite"/);
  assert.match(html, /id="prepareSongCount"[^>]*>0 families · 0 versions<\/p>/);
  assert.match(html, /id="btnLoadMoreSongs"[^>]+aria-controls="prepareSongList"[^>]+hidden[^>]+disabled/);
  assert.match(html, />\s*Load more songs\s*</);
  assert.match(
    controllerSource,
    /`Showing \$\{families\.length\} .*? \$\{shown\} of \$\{total\} versions`/
  );
  assert.match(
    controllerSource,
    /completeFamilyView = loadedAll && !state\.songQuery/
  );
  assert.match(controllerSource, /elements\.btnLoadMoreSongs\.addEventListener\('click', \(\) => loadSongs\(\{ append: true \}\)\)/);
  assert.match(controllerSource, /pageSize: SONG_PAGE_SIZE,\s*offset: request\.offset/);
  assert.match(controllerSource, /state\.songRequest \+= 1;\s*state\.songNextOffset = null;/);

  const start = controllerSource.indexOf('async function importSong()');
  const end = controllerSource.indexOf('function populateSongFamilyChoices', start);
  const importSource = controllerSource.slice(start, end);
  assert.equal((importSource.match(/await loadSongs\(\)/g) || []).length, 1);
  assert.match(importSource, /summarizeSongImport\(result\)/);
});
