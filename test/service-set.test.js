'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');

const {
  DEFAULT_MAX_PINNED_GENERATIONS,
  ServiceSetError,
  checkSourceChanges,
  matchFileToRoles,
  parseServiceDate,
  pinServiceSet,
  prunePinnedServiceSets,
  readCurrentServiceSet,
  resolveServiceSets,
  scanServiceFolder,
  serviceDateForTimeZone,
  validatePinnedManifest,
  verifyPinnedServiceSet
} = require('../src/services/service-set');

const inputRoles = [
  { id: 'russian', label: 'Russian', filenameMatchers: ['rus', 'russian', 'рус'] },
  { id: 'english', label: 'English', filenameMatchers: ['eng', 'english'] },
  { id: 'media', label: 'Media', filenameMatchers: ['media', 'singer', 'stage'] }
];

function candidate(name, serviceDate, roleId, options = {}) {
  return {
    id: `${serviceDate || 'undated'}-${roleId}-${name}`,
    name,
    path: `/service/${name}`,
    relativePath: name,
    extension: '.pptx',
    size: options.size || 100,
    modifiedTime: new Date(options.modifiedTimeMs || 1000).toISOString(),
    modifiedTimeMs: options.modifiedTimeMs || 1000,
    serviceDate,
    available: options.available !== false,
    availability: options.available === false ? 'unavailable' : 'local-or-streamable',
    versionRank: options.versionRank || 0,
    matchedRoleIds: options.matchedRoleIds || [roleId],
    roleMatchScore: 1000,
    ambiguousRoleMatch: Boolean(options.ambiguousRoleMatch)
  };
}

async function tempDirectory(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'syncshow-service-set-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return directory;
}

test('service dates come from titles, never modified time', () => {
  assert.equal(parseServiceDate('07-19-2026 Service ENG.pptx'), '2026-07-19');
  assert.equal(parseServiceDate('2026_07_19 Media.pptx'), '2026-07-19');
  assert.equal(parseServiceDate('19 July 2026 RUS.pptx'), '2026-07-19');
  assert.equal(parseServiceDate('Service 7.19.26.pptx'), '2026-07-19');
  assert.equal(parseServiceDate('Service 7.8.26.pptx', { dateOrder: 'dmy' }), '2026-08-07');
  assert.equal(parseServiceDate('Service copied today.pptx'), null);
  assert.equal(parseServiceDate('Service_07_19_2026_ENG.pptx'), '2026-07-19');
  assert.equal(parseServiceDate('Service_July_19_2026_ENG.pptx'), '2026-07-19');
  assert.equal(
    parseServiceDate('Archive 07-12-2026 replaced 2026-07-19.pptx'),
    '2026-07-12'
  );
  assert.equal(serviceDateForTimeZone(new Date('2026-07-20T01:00:00Z'), 'America/Los_Angeles'), '2026-07-19');
});

test('filename matchers select one role and surface genuine ambiguity', () => {
  assert.deepEqual(matchFileToRoles('07-19-2026 Service ENG.pptx', inputRoles).roleIds, ['english']);
  assert.deepEqual(matchFileToRoles('07-19-2026 Служение RUS.pptx', inputRoles).roleIds, ['russian']);
  assert.deepEqual(matchFileToRoles('07-19-2026 Media.pptx', inputRoles).roleIds, ['media']);

  const ambiguous = matchFileToRoles('Service Main.pptx', [
    { id: 'one', filenameMatchers: ['main'] },
    { id: 'two', filenameMatchers: ['main'] }
  ]);
  assert.equal(ambiguous.ambiguous, true);
  assert.deepEqual(ambiguous.roleIds, ['one', 'two']);

  assert.deepEqual(matchFileToRoles('СЛУЖЕНИЕ РУССКИЙ.pptx', inputRoles).roleIds, ['russian']);
  assert.deepEqual(matchFileToRoles('Backstage notes.pptx', inputRoles).roleIds, []);
  assert.deepEqual(matchFileToRoles('SingerScreen.pptx', [
    { id: 'singers', filenameMatchers: ['singer screen'] }
  ]).roleIds, ['singers']);
});

test('resolver rejects impossible requested dates', () => {
  assert.throws(
    () => resolveServiceSets({
      files: [],
      inputRoles,
      requiredRoleIds: [],
      requestedDate: '2026-02-30'
    }),
    error => error instanceof ServiceSetError && error.code === 'INVALID_SERVICE_DATE'
  );
});

test('resolver groups coherent dates and never fills today from an older service', () => {
  const files = [
    candidate('07-19-2026 RUS.pptx', '2026-07-19', 'russian'),
    candidate('07-19-2026 ENG.pptx', '2026-07-19', 'english'),
    candidate('07-19-2026 Media.pptx', '2026-07-19', 'media'),
    candidate('07-26-2026 RUS.pptx', '2026-07-26', 'russian')
  ];
  const result = resolveServiceSets({
    files,
    inputRoles,
    requiredRoleIds: ['russian', 'english', 'media'],
    requestedDate: '2026-07-26'
  });

  assert.equal(result.recommendedSetId, '2026-07-26');
  const today = result.sets.find(set => set.id === '2026-07-26');
  assert.equal(today.complete, false);
  assert.deepEqual(today.missingRoleIds, ['english', 'media']);
  assert.equal(today.inputs.english, null);
  const older = result.sets.find(set => set.id === '2026-07-19');
  assert.equal(older.complete, true);
});

test('resolver uses explicit version then modified time only within one role and date', () => {
  const files = [
    candidate('07-19-2026 ENG v1.pptx', '2026-07-19', 'english', { versionRank: 1, modifiedTimeMs: 3000 }),
    candidate('07-19-2026 ENG v2.pptx', '2026-07-19', 'english', { versionRank: 2, modifiedTimeMs: 1000 }),
    candidate('07-19-2026 ENG old copy.pptx', '2026-07-19', 'english', { modifiedTimeMs: 9000 })
  ];
  const result = resolveServiceSets({
    files,
    inputRoles,
    requiredRoleIds: ['english'],
    requestedDate: '2026-07-19'
  });
  assert.equal(result.sets[0].inputs.english.name, '07-19-2026 ENG v2.pptx');
  assert.equal(result.sets[0].alternates.english.length, 2);
});

test('folder scan ignores lock files, supports nested service folders, and reports unmatched decks', async t => {
  const folder = await tempDirectory(t);
  const week = path.join(folder, '2026-07-19');
  await fs.mkdir(week);
  await fs.writeFile(path.join(week, '07-19-2026 Service ENG.pptx'), 'english');
  await fs.writeFile(path.join(week, '07-19-2026 Служение RUS.pptx'), 'russian');
  await fs.writeFile(path.join(week, '07-19-2026 Media.pptx'), 'media');
  await fs.writeFile(path.join(week, '07-19-2026 Announcements.pptx'), 'other');
  await fs.writeFile(path.join(week, '~$07-19-2026 Media.pptx'), 'lock');

  const scan = await scanServiceFolder({
    folderPath: folder,
    inputRoles,
    requiredRoleIds: ['russian', 'english', 'media'],
    requestedDate: '2026-07-19'
  });
  assert.equal(scan.sets.length, 1);
  assert.equal(scan.sets[0].complete, true);
  assert.equal(scan.unmatchedFiles.length, 1);
  assert.equal(scan.ignoredFiles.length, 1);
  assert.equal(scan.recommendedSetId, '2026-07-19');
});

test('folder names can supply the date and date-neutral roles are reused intentionally', async t => {
  const folder = await tempDirectory(t);
  const week = path.join(folder, '2026-07-19');
  await fs.mkdir(week);
  await fs.writeFile(path.join(week, 'English.pptx'), 'english');
  await fs.writeFile(path.join(folder, '07-12-2026 Logo.pptx'), 'evergreen');
  const roles = [
    { id: 'english', label: 'English', filenameMatchers: ['english'], datePolicy: 'service-date' },
    { id: 'logo', label: 'Logo', filenameMatchers: ['logo'], datePolicy: 'none' }
  ];

  const scan = await scanServiceFolder({
    folderPath: folder,
    inputRoles: roles,
    requiredRoleIds: ['english', 'logo'],
    requestedDate: '2026-07-19'
  });
  const selected = scan.sets.find(set => set.id === '2026-07-19');
  assert.equal(selected.complete, true);
  assert.equal(selected.inputs.english.serviceDateSource, 'folder-name');
  assert.equal(selected.inputs.logo.dateStatus, 'not-applicable');
  assert.equal(selected.inputs.logo.parsedServiceDate, '2026-07-12');
  assert.equal(selected.inputs.logo.serviceDate, null);
});

test('folder scanning rejects relative paths and enforces deterministic file caps', async t => {
  await assert.rejects(
    scanServiceFolder({
      folderPath: 'relative/service-folder',
      inputRoles,
      requiredRoleIds: [],
      requestedDate: '2026-07-19'
    }),
    error => error instanceof ServiceSetError && error.code === 'INVALID_FOLDER'
  );

  const folder = await tempDirectory(t);
  await fs.writeFile(path.join(folder, '07-19-2026 ENG.pptx'), 'one');
  await fs.writeFile(path.join(folder, '07-19-2026 RUS.pptx'), 'two');
  await assert.rejects(
    scanServiceFolder({
      folderPath: folder,
      inputRoles,
      requiredRoleIds: [],
      requestedDate: '2026-07-19',
      maxFiles: 1
    }),
    error => error instanceof ServiceSetError && error.code === 'SCAN_FILE_LIMIT'
  );
});

test('scanner ignores symbolic links instead of following files outside the folder', async t => {
  if (process.platform === 'win32') {
    t.skip('Creating symlinks is not reliably permitted on Windows CI.');
    return;
  }
  const folder = await tempDirectory(t);
  const outside = await tempDirectory(t);
  const outsideFile = path.join(outside, '07-19-2026 ENG.pptx');
  await fs.writeFile(outsideFile, 'outside');
  await fs.symlink(outsideFile, path.join(folder, '07-19-2026 ENG.pptx'));

  const scan = await scanServiceFolder({
    folderPath: folder,
    inputRoles,
    requiredRoleIds: ['english'],
    requestedDate: '2026-07-19'
  });
  assert.equal(scan.files.length, 0);
  assert.deepEqual(scan.ignoredFiles.map(item => item.reason), ['symbolic-link']);
});

test('pinning creates an immutable local snapshot with hashes and source-change diagnostics', async t => {
  const folder = await tempDirectory(t);
  const store = await tempDirectory(t);
  const sourcePath = path.join(folder, '07-19-2026 Service ENG.pptx');
  await fs.writeFile(sourcePath, 'pretend PowerPoint bytes');
  const scan = await scanServiceFolder({
    folderPath: folder,
    inputRoles,
    requiredRoleIds: ['english'],
    requestedDate: '2026-07-19'
  });

  const pinned = await pinServiceSet({
    scan,
    setId: '2026-07-19',
    destinationRoot: store,
    profileId: 'main',
    profileName: 'Main Sanctuary',
    timeZone: 'America/Los_Angeles'
  });
  assert.equal(pinned.schemaVersion, 1);
  assert.equal(pinned.serviceDate, '2026-07-19');
  assert.equal(
    pinned.inputs.english.sha256,
    crypto.createHash('sha256').update('pretend PowerPoint bytes').digest('hex')
  );
  assert.equal(await fs.readFile(pinned.inputs.english.pinnedPath, 'utf8'), 'pretend PowerPoint bytes');
  assert.equal((await readCurrentServiceSet(store)).id, pinned.id);
  assert.equal((await readCurrentServiceSet(store, { verifyAssets: true })).id, pinned.id);
  assert.equal((await verifyPinnedServiceSet(pinned, store)).id, pinned.id);
  assert.deepEqual(await checkSourceChanges(pinned), []);

  const escapedManifest = structuredClone(pinned);
  escapedManifest.inputs.english.pinnedPath = sourcePath;
  assert.throws(
    () => validatePinnedManifest(escapedManifest, store),
    error => error instanceof ServiceSetError && error.code === 'INVALID_PINNED_SET'
  );

  await fs.writeFile(sourcePath, 'changed bytes with another size');
  assert.deepEqual(await checkSourceChanges(pinned), [{
    roleId: 'english',
    sourceName: '07-19-2026 Service ENG.pptx',
    status: 'changed'
  }]);
});

test('pinning rejects a source that changed after the scan', async t => {
  const folder = await tempDirectory(t);
  const store = await tempDirectory(t);
  const sourcePath = path.join(folder, '07-19-2026 Service ENG.pptx');
  await fs.writeFile(sourcePath, 'first');
  const scan = await scanServiceFolder({
    folderPath: folder,
    inputRoles,
    requiredRoleIds: ['english'],
    requestedDate: '2026-07-19'
  });
  await fs.writeFile(sourcePath, 'second version');

  await assert.rejects(
    pinServiceSet({
      scan,
      setId: '2026-07-19',
      destinationRoot: store,
      profileId: 'main',
      profileName: 'Main',
      timeZone: null
    }),
    error => error instanceof ServiceSetError && error.code === 'SOURCE_CHANGED'
  );
  assert.deepEqual(await fs.readdir(store), []);
});

test('pinned snapshot integrity checks detect later local corruption', async t => {
  const folder = await tempDirectory(t);
  const store = await tempDirectory(t);
  await fs.writeFile(path.join(folder, '07-19-2026 Service ENG.pptx'), 'original');
  const scan = await scanServiceFolder({
    folderPath: folder,
    inputRoles,
    requiredRoleIds: ['english'],
    requestedDate: '2026-07-19'
  });
  const pinned = await pinServiceSet({
    scan,
    setId: '2026-07-19',
    destinationRoot: store,
    profileId: 'main',
    profileName: 'Main',
    timeZone: null
  });
  await fs.writeFile(pinned.inputs.english.pinnedPath, 'tampered');
  await assert.rejects(
    verifyPinnedServiceSet(pinned, store),
    error => error instanceof ServiceSetError && error.code === 'PINNED_ASSET_CHANGED'
  );
});

test('successful snapshots retain current and recent fallbacks within a safe bound', async t => {
  const folder = await tempDirectory(t);
  const store = await tempDirectory(t);
  await fs.writeFile(path.join(folder, '07-19-2026 Service ENG.pptx'), 'original');
  const scan = await scanServiceFolder({
    folderPath: folder,
    inputRoles,
    requiredRoleIds: ['english'],
    requestedDate: '2026-07-19'
  });
  const unrelatedDirectory = path.join(store, 'operator-notes');
  await fs.mkdir(unrelatedDirectory);

  const pinned = [];
  for (let index = 0; index < DEFAULT_MAX_PINNED_GENERATIONS + 3; index += 1) {
    pinned.push(await pinServiceSet({
      scan,
      setId: '2026-07-19',
      destinationRoot: store,
      profileId: 'main',
      profileName: 'Main',
      timeZone: null
    }));
  }

  const generationDirectories = (await fs.readdir(store, { withFileTypes: true }))
    .filter(entry => entry.isDirectory() && entry.name !== 'operator-notes')
    .map(entry => entry.name);
  const current = await readCurrentServiceSet(store, { verifyAssets: true });
  const backup = JSON.parse(await fs.readFile(path.join(store, 'current.json.bak'), 'utf8'));
  assert.equal(generationDirectories.length, DEFAULT_MAX_PINNED_GENERATIONS);
  assert.equal(current.id, pinned.at(-1).id);
  assert.equal(backup.id, pinned.at(-2).id);
  assert.ok(generationDirectories.includes(current.id));
  assert.ok(generationDirectories.includes(backup.id));
  assert.equal((await fs.stat(unrelatedDirectory)).isDirectory(), true);

  // Even if an operator deliberately restores an older retained manifest,
  // pruning must protect the generation named by current.json rather than
  // assuming the newest directory is active.
  const restoredId = generationDirectories.find(id => id !== current.id && id !== backup.id);
  const restoredManifest = JSON.parse(await fs.readFile(
    path.join(store, restoredId, 'service-set.json'),
    'utf8'
  ));
  await fs.writeFile(
    path.join(store, 'current.json'),
    `${JSON.stringify(restoredManifest, null, 2)}\n`,
    'utf8'
  );
  const cleanup = await prunePinnedServiceSets(store, { maxGenerations: 2 });
  const remainingGenerations = (await fs.readdir(store, { withFileTypes: true }))
    .filter(entry => entry.isDirectory() && entry.name !== 'operator-notes')
    .map(entry => entry.name);
  assert.equal(cleanup.skippedReason, null);
  assert.equal(remainingGenerations.length, 2);
  assert.ok(remainingGenerations.includes(restoredId));
  assert.equal((await readCurrentServiceSet(store, { verifyAssets: true })).id, restoredId);
  assert.equal((await fs.stat(unrelatedDirectory)).isDirectory(), true);
});

test('source and snapshot parent-directory symlinks cannot escape their roots', async t => {
  if (process.platform === 'win32') {
    t.skip('Creating directory symlinks is not reliably permitted on Windows CI.');
    return;
  }
  const folder = await tempDirectory(t);
  const week = path.join(folder, 'week');
  const store = await tempDirectory(t);
  const outsideSource = await tempDirectory(t);
  const outsideSnapshot = await tempDirectory(t);
  await fs.mkdir(week);
  await fs.writeFile(path.join(week, '07-19-2026 Service ENG.pptx'), 'original');
  const scan = await scanServiceFolder({
    folderPath: folder,
    inputRoles,
    requiredRoleIds: ['english'],
    requestedDate: '2026-07-19'
  });
  const pinned = await pinServiceSet({
    scan,
    setId: '2026-07-19',
    destinationRoot: store,
    profileId: 'main',
    profileName: 'Main',
    timeZone: null
  });

  await fs.rename(week, `${week}.original`);
  await fs.writeFile(path.join(outsideSource, '07-19-2026 Service ENG.pptx'), 'original');
  await fs.symlink(outsideSource, week, 'dir');
  assert.deepEqual(await checkSourceChanges(pinned), [{
    roleId: 'english',
    sourceName: '07-19-2026 Service ENG.pptx',
    status: 'unavailable',
    cause: 'SOURCE_OUTSIDE_FOLDER'
  }]);

  const assets = path.dirname(pinned.inputs.english.pinnedPath);
  await fs.rename(assets, `${assets}.original`);
  await fs.writeFile(path.join(outsideSnapshot, path.basename(pinned.inputs.english.pinnedPath)), 'original');
  await fs.symlink(outsideSnapshot, assets, 'dir');
  await assert.rejects(
    verifyPinnedServiceSet(pinned, store),
    error => error instanceof ServiceSetError && error.code === 'PINNED_ASSET_CHANGED'
  );
});
