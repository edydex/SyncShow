'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const {
  addProjectItem,
  addSongResource,
  parseSongDocument,
  serializeServiceHandoff
} = require('../src/services/project');
const { ServiceProjectStore } = require('../src/services/project/ServiceProjectStore');
const {
  ShowPackageError,
  ShowPackagePublisher,
  canonicalJson
} = require('../src/services/project/ShowPackagePublisher');

const FONT_PATH = path.resolve(__dirname, '../assets/fonts/NotoSans-Variable.ttf');
const NOW = '2026-07-22T18:30:00.000Z';

async function tempDirectory(t, prefix) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return directory;
}

function expectPackageCode(...codes) {
  return error => {
    assert.ok(error instanceof ShowPackageError, `expected ShowPackageError, got ${error?.constructor?.name}`);
    assert.ok(codes.includes(error.code), `expected ${codes.join(' or ')}, got ${error.code}`);
    return true;
  };
}

async function assertPrivateDirectoryTree(directoryPath) {
  const stats = await fs.lstat(directoryPath);
  assert.equal(stats.isDirectory(), true, `${directoryPath} must be a directory`);
  assert.equal(stats.isSymbolicLink(), false, `${directoryPath} must not be a symbolic link`);
  if (process.platform !== 'win32') {
    assert.equal(stats.mode & 0o777, 0o700, `${directoryPath} must be owner-only`);
  }
  for (const entry of await fs.readdir(directoryPath, { withFileTypes: true })) {
    assert.equal(entry.isSymbolicLink(), false, `${entry.name} must not be a symbolic link`);
    if (entry.isDirectory()) {
      await assertPrivateDirectoryTree(path.join(directoryPath, entry.name));
    }
  }
}

async function preparedProject(t) {
  const workspace = await tempDirectory(t, 'syncshow-show-package-');
  const projectsPath = path.join(workspace, 'projects');
  const packagesPath = path.join(workspace, 'packages');
  const clock = () => new Date(NOW);
  const store = new ServiceProjectStore({ rootPath: projectsPath, clock });
  const created = await store.create({
    id: 'project-sunday',
    title: 'Sunday Service',
    serviceDate: '2026-07-26',
    profileId: 'main-sanctuary'
  });
  const project = addProjectItem(created.project, {
    id: 'welcome',
    kind: 'notice',
    title: 'Welcome',
    textByChannel: {
      primary: 'Welcome <everyone> & friends',
      media: 'Welcome singers'
    },
    operatorNotes: 'Advance after the greeting',
    presetId: 'notice-text'
  }, { now: NOW });
  const saved = await store.save(project, {
    expectedRevisionId: created.revisionId,
    reason: 'test-prepare'
  });
  const publisher = new ShowPackagePublisher({
    projectStore: store,
    rootPath: packagesPath,
    fontPath: FONT_PATH,
    clock,
    randomUUID: () => '11111111-1111-4111-8111-111111111111'
  });
  const publishOptions = {
    projectId: saved.project.id,
    revisionId: saved.revisionId,
    roleMapping: { main: 'primary', singers: 'media' },
    width: 640,
    height: 360,
    thumbnailWidth: 100,
    jpegQuality: 88
  };
  return { packagesPath, publishOptions, publisher, saved, store, workspace };
}

test('publishes an immutable equal-length package, returns the exact presentation contract, and reuses it', async t => {
  const fixture = await preparedProject(t);
  const progress = [];
  const first = await fixture.publisher.publish({
    ...fixture.publishOptions,
    onProgress: update => progress.push(update)
  });

  assert.match(first.manifest.id, /^show-[a-f0-9]{64}$/);
  assert.match(first.manifestSha256, /^[a-f0-9]{64}$/);
  assert.match(first.manifest.timelineSha256, /^[a-f0-9]{64}$/);
  assert.match(first.manifest.handoffSha256, /^[a-f0-9]{64}$/);
  assert.equal(first.manifest.handoffPath, 'handoff.json');
  assert.equal(first.packagePath, path.join(fixture.publisher.rootPath, first.manifest.id));
  assert.equal(first.manifest.kind, 'syncshow-show-package');
  assert.equal(first.manifest.schemaVersion, 3);
  assert.equal(first.manifest.cueCount, 1);
  assert.equal(first.manifest.cueIds.length, 1);
  assert.deepEqual(first.manifest.roleMapping, { main: 'primary', singers: 'media' });
  assert.equal(first.manifest.channels.length, 2);
  assert.equal(first.manifest.artifacts.length, 8);
  assert.deepEqual(first.serviceHandoff, first.manifest.serviceHandoff);
  assert.equal(first.serviceHandoff.project.id, fixture.saved.project.id);
  assert.equal(first.serviceHandoff.project.revisionId, fixture.saved.revisionId);
  assert.equal(first.serviceHandoff.planning, null);
  assert.equal(first.serviceHandoff.readiness.ready, false);
  assert.deepEqual(first.serviceHandoff.cueIds, first.manifest.cueIds);
  assert.equal(
    first.serviceHandoff.cues[first.manifest.cueIds[0]].operatorNotes,
    'Advance after the greeting'
  );
  assert.equal(
    await fs.readFile(path.join(first.packagePath, 'handoff.json'), 'utf8'),
    serializeServiceHandoff(first.serviceHandoff)
  );
  assert.equal(progress.length, 2);
  assert.deepEqual(progress.map(item => [item.completed, item.total, item.roleId]), [
    [1, 2, 'main'],
    [2, 2, 'singers']
  ]);

  assert.deepEqual(Object.keys(first.presentations), ['main', 'singers']);
  for (const [roleId, channelId] of Object.entries(fixture.publishOptions.roleMapping)) {
    const presentation = first.presentations[roleId];
    assert.deepEqual(Object.keys(presentation).sort(), [
      'assetPaths',
      'cacheDir',
      'metadata',
      'projectId',
      'projectRevisionId',
      'renderer',
      'scenes',
      'serviceHandoff',
      'showPackageId',
      'slideCount',
      'sourceType',
      'success'
    ]);
    assert.equal(presentation.success, true);
    assert.equal(presentation.sourceType, 'service-project');
    assert.equal(presentation.renderer, 'native-cue');
    assert.equal(presentation.projectId, fixture.saved.project.id);
    assert.equal(presentation.projectRevisionId, fixture.saved.revisionId);
    assert.equal(presentation.showPackageId, first.manifest.id);
    assert.deepEqual(presentation.serviceHandoff, first.serviceHandoff);
    assert.equal(presentation.slideCount, 1);
    assert.equal(presentation.cacheDir, path.join(first.packagePath, first.manifest.channels
      .find(channel => channel.roleId === roleId).directory));
    assert.deepEqual(presentation.assetPaths, {});
    assert.equal(presentation.scenes.length, 1);
    assert.equal(presentation.scenes[0].cueId, first.manifest.cueIds[0]);
    assert.equal(presentation.scenes[0].layout, 'text');
    assert.deepEqual(presentation.metadata, {
      schemaVersion: 1,
      sourceType: 'service-project',
      projectId: fixture.saved.project.id,
      projectRevisionId: fixture.saved.revisionId,
      channelId,
      roleId,
      slideCount: 1,
      slides: [{
        cueId: first.manifest.cueIds[0],
        title: 'Welcome',
        kind: 'notice',
        groupPath: [],
        text: channelId === 'primary' ? 'Welcome <everyone> & friends' : 'Welcome singers',
        firstLine: channelId === 'primary' ? 'Welcome <everyone> & friends' : 'Welcome singers'
      }]
    });
    assert.deepEqual((await fs.readdir(presentation.cacheDir)).sort(), [
      'metadata.json',
      'scene_001.json',
      'slide_001_thumb.jpg'
    ]);
  }

  const noReuseProgress = [];
  const second = await fixture.publisher.publish({
    ...fixture.publishOptions,
    onProgress: update => noReuseProgress.push(update)
  });
  assert.equal(second.packagePath, first.packagePath);
  assert.equal(second.manifestSha256, first.manifestSha256);
  assert.deepEqual(second.manifest, first.manifest);
  assert.deepEqual(second.presentations, first.presentations);
  assert.deepEqual(noReuseProgress, [], 'a verified immutable package should be reused without rerendering');

  const restartedPublisher = new ShowPackagePublisher({
    projectStore: fixture.store,
    rootPath: fixture.packagesPath,
    fontPath: FONT_PATH,
    clock: () => new Date(NOW)
  });
  const reopened = await restartedPublisher.open(first.manifest.id);
  assert.equal(reopened.packagePath, first.packagePath);
  assert.deepEqual(reopened.manifest, first.manifest);
  assert.deepEqual(reopened.presentations, first.presentations);
  assert.deepEqual(reopened.serviceHandoff, first.serviceHandoff);
});

test('Fontconfig cache stays private and repairs legacy modes on reuse and restart open', async t => {
  const fixture = await preparedProject(t);
  const cachePath = path.join(fixture.packagesPath, '.font-cache');
  const fontConfigCachePath = path.join(cachePath, 'fontconfig');
  await fs.mkdir(fontConfigCachePath, { recursive: true, mode: 0o755 });
  if (process.platform !== 'win32') {
    await fs.chmod(cachePath, 0o755);
    await fs.chmod(fontConfigCachePath, 0o755);
  }

  const first = await fixture.publisher.publish(fixture.publishOptions);
  await assertPrivateDirectoryTree(fixture.packagesPath);
  const manifestSource = await fs.readFile(path.join(first.packagePath, 'manifest.json'));

  if (process.platform !== 'win32') {
    await fs.chmod(cachePath, 0o755);
    await fs.chmod(fontConfigCachePath, 0o755);
  }
  const reused = await fixture.publisher.publish(fixture.publishOptions);
  assert.equal(reused.packagePath, first.packagePath);
  assert.equal(reused.manifestSha256, first.manifestSha256);
  assert.deepEqual(await fs.readFile(path.join(first.packagePath, 'manifest.json')), manifestSource);
  await assertPrivateDirectoryTree(fixture.packagesPath);

  if (process.platform !== 'win32') {
    await fs.chmod(cachePath, 0o755);
    await fs.chmod(fontConfigCachePath, 0o755);
  }
  const restartedPublisher = new ShowPackagePublisher({
    projectStore: fixture.store,
    rootPath: fixture.packagesPath,
    fontPath: FONT_PATH,
    clock: () => new Date(NOW)
  });
  const reopened = await restartedPublisher.open(first.manifest.id);
  assert.equal(reopened.packagePath, first.packagePath);
  assert.equal(reopened.manifestSha256, first.manifestSha256);
  assert.deepEqual(await fs.readFile(path.join(first.packagePath, 'manifest.json')), manifestSource);
  await assertPrivateDirectoryTree(fixture.packagesPath);
});

test('Fontconfig cache rejects linked and non-directory children without publish residue', async t => {
  const fixture = await preparedProject(t);
  const cachePath = path.join(fixture.packagesPath, '.font-cache');
  const fontConfigCachePath = path.join(cachePath, 'fontconfig');
  await fs.mkdir(cachePath, { recursive: true, mode: 0o700 });

  await fs.writeFile(fontConfigCachePath, 'not a cache directory');
  await assert.rejects(
    fixture.publisher.publish(fixture.publishOptions),
    /Unsafe storage directory/
  );
  assert.equal(await fs.readFile(fontConfigCachePath, 'utf8'), 'not a cache directory');
  assert.deepEqual(await fs.readdir(fixture.packagesPath), ['.font-cache']);

  if (process.platform === 'win32') return;
  await fs.rm(fontConfigCachePath);
  const outside = await tempDirectory(t, 'syncshow-fontconfig-outside-');
  await fs.symlink(outside, fontConfigCachePath);
  await assert.rejects(
    fixture.publisher.publish(fixture.publishOptions),
    /Unsafe storage directory/
  );
  assert.deepEqual(await fs.readdir(outside), []);
  assert.deepEqual(await fs.readdir(fixture.packagesPath), ['.font-cache']);
});

test('open requires one exact package id and rejects absent or symlink package directories', async t => {
  const fixture = await preparedProject(t);
  const first = await fixture.publisher.publish(fixture.publishOptions);
  const restartedPublisher = new ShowPackagePublisher({
    projectStore: fixture.store,
    rootPath: fixture.packagesPath,
    fontPath: FONT_PATH
  });

  for (const packageId of [
    '',
    '../outside',
    `show-${'A'.repeat(64)}`,
    `show-${'a'.repeat(63)}`,
    `${first.manifest.id}/manifest.json`
  ]) {
    await assert.rejects(
      restartedPublisher.open(packageId),
      expectPackageCode('INVALID_SHOW_PACKAGE_ID')
    );
  }
  await assert.rejects(
    restartedPublisher.open(`show-${'f'.repeat(64)}`),
    expectPackageCode('SHOW_PACKAGE_NOT_FOUND')
  );

  const linkId = `show-${'e'.repeat(64)}`;
  try {
    await fs.symlink(
      first.packagePath,
      path.join(fixture.packagesPath, linkId),
      process.platform === 'win32' ? 'junction' : 'dir'
    );
  } catch (error) {
    if (['EPERM', 'EACCES', 'ENOSYS'].includes(error.code)) {
      t.skip(`symbolic links are unavailable: ${error.code}`);
      return;
    }
    throw error;
  }
  await assert.rejects(
    restartedPublisher.open(linkId),
    expectPackageCode('SHOW_PACKAGE_INVALID')
  );
});

test('open rejects a legacy package manifest instead of guessing a migration', async t => {
  const fixture = await preparedProject(t);
  const first = await fixture.publisher.publish(fixture.publishOptions);
  const manifestPath = path.join(first.packagePath, 'manifest.json');
  const legacy = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
  legacy.schemaVersion = 1;
  delete legacy.handoffPath;
  delete legacy.handoffSha256;
  await fs.writeFile(manifestPath, canonicalJson(legacy));

  const restartedPublisher = new ShowPackagePublisher({
    projectStore: fixture.store,
    rootPath: fixture.packagesPath,
    fontPath: FONT_PATH
  });
  await assert.rejects(
    restartedPublisher.open(first.manifest.id),
    expectPackageCode('SHOW_PACKAGE_INVALID')
  );
});

test('published Singer channels render every current line plus the next cue first line', async t => {
  const workspace = await tempDirectory(t, 'syncshow-show-package-singer-');
  const store = new ServiceProjectStore({
    rootPath: path.join(workspace, 'projects'),
    clock: () => new Date(NOW)
  });
  const created = await store.create({
    id: 'project-singer-preview',
    title: 'Singer preview service',
    serviceDate: '2026-07-26',
    profileId: 'main-sanctuary'
  });
  const song = parseSongDocument([
    '---',
    'id: singer-preview-song',
    'title: Singer Preview Song',
    'language: en',
    '---',
    '^1',
    'Current line one',
    'Current line two',
    'Current line three',
    '^chorus',
    'Next cue first line',
    'Next cue second line'
  ].join('\n'));
  const pinned = addSongResource(created.project, song, {
    provider: 'local',
    itemId: song.id,
    revision: 'singer-preview-revision'
  });
  const project = addProjectItem(pinned.project, {
    id: 'song-singer-preview',
    kind: 'song',
    title: song.title,
    primaryChannelId: 'primary',
    variants: {
      primary: { mode: 'content', resourceId: pinned.resourceId },
      secondary: { mode: 'inherit', from: 'primary' },
      media: {
        mode: 'derive',
        from: 'primary',
        transform: { id: 'first-lines', version: 1, maxLines: 2 }
      }
    },
    arrangement: [
      { id: 'arr-singer-verse', sectionId: 'verse-1' },
      { id: 'arr-singer-chorus', sectionId: 'chorus' }
    ],
    titlePresetId: 'song-title',
    lyricsPresetId: 'song-lyrics',
    operatorNotes: ''
  }, { now: NOW });
  const saved = await store.save(project, {
    expectedRevisionId: created.revisionId,
    reason: 'test-singer-preview'
  });
  const publisher = new ShowPackagePublisher({
    projectStore: store,
    rootPath: path.join(workspace, 'packages'),
    fontPath: FONT_PATH,
    clock: () => new Date(NOW)
  });
  const published = await publisher.publish({
    projectId: saved.project.id,
    revisionId: saved.revisionId,
    roleMapping: { singers: 'media' },
    width: 640,
    height: 360,
    thumbnailWidth: 100,
    jpegQuality: 88
  });

  assert.equal(published.presentations.singers.metadata.slides[1].layout, 'singer-current-next');
  assert.equal(
    published.presentations.singers.metadata.slides[1].text,
    'Current line one\nCurrent line two\nCurrent line three'
  );
  assert.deepEqual(
    published.presentations.singers.metadata.slides[1].next,
    { state: 'text', text: 'Next cue first line' }
  );
});

test('role mapping and bounded render options fail before creating a package', async t => {
  const fixture = await preparedProject(t);

  await assert.rejects(
    fixture.publisher.publish({ ...fixture.publishOptions, roleMapping: null }),
    expectPackageCode('INVALID_ROLE_MAPPING')
  );
  await assert.rejects(
    fixture.publisher.publish({ ...fixture.publishOptions, roleMapping: { main: 'does-not-exist' } }),
    expectPackageCode('UNKNOWN_PROJECT_CHANNEL')
  );
  await assert.rejects(
    fixture.publisher.publish({ ...fixture.publishOptions, roleMapping: { constructor: 'primary' } }),
    expectPackageCode('INVALID_ROLE_MAPPING')
  );
  await assert.rejects(
    fixture.publisher.publish({
      ...fixture.publishOptions,
      roleMapping: Object.fromEntries(Array.from({ length: 17 }, (_, index) => [`role-${index}`, 'primary']))
    }),
    expectPackageCode('INVALID_ROLE_MAPPING')
  );
  await assert.rejects(
    fixture.publisher.publish({ ...fixture.publishOptions, thumbnailWidth: 99 }),
    expectPackageCode('INVALID_RENDER_OPTIONS')
  );
  await assert.rejects(
    fixture.publisher.publish({ ...fixture.publishOptions, width: 639 }),
    expectPackageCode('INVALID_RENDER_OPTIONS')
  );
  await assert.rejects(
    fixture.publisher.publish({ ...fixture.publishOptions, jpegQuality: 69 }),
    expectPackageCode('INVALID_RENDER_OPTIONS')
  );

  const packageEntries = await fs.readdir(fixture.packagesPath);
  assert.deepEqual(packageEntries, ['.font-cache']);
  assert.deepEqual(await fs.readdir(path.join(fixture.packagesPath, '.font-cache')), ['fontconfig']);
  await assertPrivateDirectoryTree(fixture.packagesPath);
});

test('open rejects artifact tampering while intentional publish quarantines and regenerates it', async t => {
  const fixture = await preparedProject(t);
  const first = await fixture.publisher.publish(fixture.publishOptions);
  const scene = first.manifest.artifacts.find(artifact => artifact.path.endsWith('/scene_001.json'));
  assert.ok(scene);
  const scenePath = path.join(first.packagePath, scene.path);
  const handle = await fs.open(scenePath, 'r+');
  try {
    const byte = Buffer.alloc(1);
    await handle.read(byte, 0, 1, 8);
    byte[0] ^= 0xff;
    await handle.write(byte, 0, 1, 8);
    await handle.sync();
  } finally {
    await handle.close();
  }

  const restartedPublisher = new ShowPackagePublisher({
    projectStore: fixture.store,
    rootPath: fixture.packagesPath,
    fontPath: FONT_PATH
  });
  await assert.rejects(
    restartedPublisher.open(first.manifest.id),
    expectPackageCode('SHOW_PACKAGE_CORRUPT')
  );
  const repaired = await fixture.publisher.publish(fixture.publishOptions);
  assert.equal(repaired.manifest.id, first.manifest.id);
  assert.equal(repaired.packagePath, first.packagePath);
  assert.deepEqual(repaired.manifest, first.manifest);
  await assert.doesNotReject(
    restartedPublisher.open(first.manifest.id)
  );

  const quarantineName =
    `.quarantine-${first.manifest.id}-11111111-1111-4111-8111-111111111111`;
  const quarantinePath = path.join(fixture.packagesPath, quarantineName);
  const quarantinedStats = await fs.lstat(quarantinePath);
  assert.equal(quarantinedStats.isDirectory(), true);
  assert.equal(quarantinedStats.isSymbolicLink(), false);
  assert.notDeepEqual(
    await fs.readFile(path.join(quarantinePath, scene.path)),
    await fs.readFile(path.join(repaired.packagePath, scene.path))
  );
});

test('service handoff tampering is rejected by open and repaired by intentional publish', async t => {
  const fixture = await preparedProject(t);
  const first = await fixture.publisher.publish(fixture.publishOptions);
  const handoffPath = path.join(first.packagePath, first.manifest.handoffPath);
  const handoff = JSON.parse(await fs.readFile(handoffPath, 'utf8'));
  handoff.cues[first.manifest.cueIds[0]].operatorNotes = 'Forged operator direction';
  await fs.writeFile(handoffPath, canonicalJson(handoff));

  await assert.rejects(
    fixture.publisher.open(first.manifest.id),
    expectPackageCode('SHOW_PACKAGE_CORRUPT')
  );
  const repaired = await fixture.publisher.publish(fixture.publishOptions);
  assert.equal(repaired.manifest.id, first.manifest.id);
  assert.equal(
    repaired.serviceHandoff.cues[first.manifest.cueIds[0]].operatorNotes,
    'Advance after the greeting'
  );
});

test('coordinated scene and artifact-record tampering is quarantined before regeneration', async t => {
  const fixture = await preparedProject(t);
  const first = await fixture.publisher.publish(fixture.publishOptions);
  const sceneArtifact = first.manifest.artifacts
    .find(artifact => artifact.path.endsWith('/scene_001.json'));
  assert.ok(sceneArtifact);
  const scenePath = path.join(first.packagePath, sceneArtifact.path);
  const scene = JSON.parse(await fs.readFile(scenePath, 'utf8'));
  scene.background = '#010101';
  const sceneSource = canonicalJson(scene);
  await fs.writeFile(scenePath, sceneSource);

  const manifestPath = path.join(first.packagePath, 'manifest.json');
  const forged = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
  const forgedArtifact = forged.artifacts.find(artifact => artifact.path === sceneArtifact.path);
  forgedArtifact.size = Buffer.byteLength(sceneSource);
  forgedArtifact.sha256 = crypto.createHash('sha256').update(sceneSource).digest('hex');
  await fs.writeFile(manifestPath, canonicalJson(forged));

  await assert.rejects(
    fixture.publisher.open(first.manifest.id),
    expectPackageCode('SHOW_PACKAGE_CORRUPT')
  );
  const repaired = await fixture.publisher.publish(fixture.publishOptions);
  assert.equal(repaired.manifest.id, first.manifest.id);
  assert.notEqual(repaired.presentations.main.scenes[0].background, '#010101');
});

test('manifest structural tampering is rejected by open and repaired by intentional publish', async t => {
  const fixture = await preparedProject(t);
  const first = await fixture.publisher.publish(fixture.publishOptions);
  const manifestPath = path.join(first.packagePath, 'manifest.json');
  const forged = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
  forged.cueCount += 1;
  await fs.writeFile(manifestPath, canonicalJson(forged));

  await assert.rejects(
    fixture.publisher.open(first.manifest.id),
    expectPackageCode('SHOW_PACKAGE_INVALID', 'SHOW_PACKAGE_CORRUPT')
  );
  const repaired = await fixture.publisher.publish(fixture.publishOptions);
  assert.equal(repaired.manifest.id, first.manifest.id);
  assert.equal(repaired.manifest.cueCount, first.manifest.cueCount);
});

test('publish never quarantines an unsafe exact package symlink', async t => {
  const fixture = await preparedProject(t);
  const first = await fixture.publisher.publish(fixture.publishOptions);
  const preservedPath = path.join(fixture.packagesPath, 'preserved-safe-package');
  await fs.rename(first.packagePath, preservedPath);
  try {
    await fs.symlink(
      preservedPath,
      first.packagePath,
      process.platform === 'win32' ? 'junction' : 'dir'
    );
  } catch (error) {
    if (['EPERM', 'EACCES', 'ENOSYS'].includes(error.code)) {
      t.skip(`symbolic links are unavailable: ${error.code}`);
      return;
    }
    throw error;
  }

  await assert.rejects(
    fixture.publisher.publish(fixture.publishOptions),
    expectPackageCode('SHOW_PACKAGE_INVALID')
  );
  assert.equal((await fs.lstat(first.packagePath)).isSymbolicLink(), true);
  assert.deepEqual(
    (await fs.readdir(fixture.packagesPath))
      .filter(name => name.startsWith(`.quarantine-${first.manifest.id}-`)),
    []
  );
});

test('open rejects a package rendered with another bundled font and publish uses the new font identity', async t => {
  const fixture = await preparedProject(t);
  const first = await fixture.publisher.publish(fixture.publishOptions);
  const changedFontPath = path.join(fixture.workspace, 'NotoSans-Changed.ttf');
  await fs.copyFile(FONT_PATH, changedFontPath);
  await fs.appendFile(changedFontPath, Buffer.from([0]));

  const changedPublisher = new ShowPackagePublisher({
    projectStore: fixture.store,
    rootPath: fixture.packagesPath,
    fontPath: changedFontPath,
    fontConfigPath: path.resolve(__dirname, '../assets/fonts/fonts.conf'),
    clock: () => new Date(NOW),
    randomUUID: () => '22222222-2222-4222-8222-222222222222'
  });
  await assert.rejects(
    changedPublisher.open(first.manifest.id),
    expectPackageCode('SHOW_PACKAGE_FONT_INCOMPATIBLE')
  );

  const republished = await changedPublisher.publish(fixture.publishOptions);
  assert.notEqual(republished.manifest.id, first.manifest.id);
  assert.notEqual(republished.manifest.font.sha256, first.manifest.font.sha256);
  assert.equal(
    republished.manifest.font.sha256,
    crypto.createHash('sha256').update(await fs.readFile(changedFontPath)).digest('hex')
  );
  await assert.doesNotReject(changedPublisher.open(republished.manifest.id));
  await assert.rejects(
    fixture.publisher.open(republished.manifest.id),
    expectPackageCode('SHOW_PACKAGE_FONT_INCOMPATIBLE')
  );
});

test('live presentation metadata comes from the checksummed channel file, never an embedded manifest field', async t => {
  const fixture = await preparedProject(t);
  const first = await fixture.publisher.publish(fixture.publishOptions);
  const manifestPath = path.join(first.packagePath, 'manifest.json');
  const forged = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
  assert.equal(Object.hasOwn(forged.channels[0], 'metadata'), false);
  forged.channels[0].metadata = {
    slideCount: 999,
    slides: [{ text: 'forged operator text' }]
  };
  forged.serviceHandoff = {
    cues: {
      [first.manifest.cueIds[0]]: {
        operatorNotes: 'forged operator direction'
      }
    }
  };
  await fs.writeFile(manifestPath, canonicalJson(forged));

  const reused = await fixture.publisher.publish(fixture.publishOptions);
  assert.equal(reused.presentations.main.slideCount, 1);
  assert.equal(reused.presentations.main.metadata.slideCount, 1);
  assert.equal(reused.presentations.main.metadata.slides[0].text, 'Welcome <everyone> & friends');
  assert.notEqual(reused.presentations.main.metadata.slides[0].text, 'forged operator text');
  assert.equal(
    reused.presentations.main.serviceHandoff.cues[first.manifest.cueIds[0]].operatorNotes,
    'Advance after the greeting'
  );
});

test('coordinated metadata and manifest checksum tampering cannot forge operator text', async t => {
  const fixture = await preparedProject(t);
  const first = await fixture.publisher.publish(fixture.publishOptions);
  const channel = first.manifest.channels.find(item => item.roleId === 'main');
  const metadataPath = path.join(first.packagePath, channel.metadataPath);
  const manifestPath = path.join(first.packagePath, 'manifest.json');
  const metadata = JSON.parse(await fs.readFile(metadataPath, 'utf8'));
  metadata.slides[0].text = 'Forged operator-facing text';
  metadata.slides[0].firstLine = 'Forged operator-facing text';
  const metadataSource = canonicalJson(metadata);
  await fs.writeFile(metadataPath, metadataSource);

  const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
  const artifact = manifest.artifacts.find(item =>
    item.path === channel.metadataPath);
  artifact.size = Buffer.byteLength(metadataSource);
  artifact.sha256 = crypto
    .createHash('sha256')
    .update(metadataSource)
    .digest('hex');
  await fs.writeFile(manifestPath, canonicalJson(manifest));

  await assert.rejects(
    fixture.publisher.open(first.manifest.id),
    expectPackageCode('SHOW_PACKAGE_CORRUPT')
  );
  const repaired = await fixture.publisher.publish(fixture.publishOptions);
  assert.equal(
    repaired.presentations.main.metadata.slides[0].text,
    'Welcome <everyone> & friends'
  );
});
