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
  parseSongDocument
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
  assert.match(first.manifest.timelineSha256, /^[a-f0-9]{64}$/);
  assert.equal(first.packagePath, path.join(fixture.publisher.rootPath, first.manifest.id));
  assert.equal(first.manifest.kind, 'syncshow-show-package');
  assert.equal(first.manifest.cueCount, 1);
  assert.equal(first.manifest.cueIds.length, 1);
  assert.deepEqual(first.manifest.roleMapping, { main: 'primary', singers: 'media' });
  assert.equal(first.manifest.channels.length, 2);
  assert.equal(first.manifest.artifacts.length, 7);
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
  assert.deepEqual(second.manifest, first.manifest);
  assert.deepEqual(second.presentations, first.presentations);
  assert.deepEqual(noReuseProgress, [], 'a verified immutable package should be reused without rerendering');
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
  assert.equal(
    published.presentations.singers.metadata.slides[1].nextLine,
    'Next cue first line'
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
  assert.deepEqual(packageEntries, []);
});

test('artifact tampering is rejected instead of silently rerendering or reusing a package', async t => {
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

  await assert.rejects(
    fixture.publisher.publish(fixture.publishOptions),
    expectPackageCode('SHOW_PACKAGE_CORRUPT')
  );
});

test('coordinated scene and artifact-record tampering cannot replace semantic output', async t => {
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
    fixture.publisher.publish(fixture.publishOptions),
    expectPackageCode('SHOW_PACKAGE_CORRUPT')
  );
});

test('manifest structural tampering is rejected even when artifact files remain untouched', async t => {
  const fixture = await preparedProject(t);
  const first = await fixture.publisher.publish(fixture.publishOptions);
  const manifestPath = path.join(first.packagePath, 'manifest.json');
  const forged = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
  forged.cueCount += 1;
  await fs.writeFile(manifestPath, canonicalJson(forged));

  await assert.rejects(
    fixture.publisher.publish(fixture.publishOptions),
    expectPackageCode('SHOW_PACKAGE_INVALID', 'SHOW_PACKAGE_CORRUPT')
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
  await fs.writeFile(manifestPath, canonicalJson(forged));

  const reused = await fixture.publisher.publish(fixture.publishOptions);
  assert.equal(reused.presentations.main.slideCount, 1);
  assert.equal(reused.presentations.main.metadata.slideCount, 1);
  assert.equal(reused.presentations.main.metadata.slides[0].text, 'Welcome <everyone> & friends');
  assert.notEqual(reused.presentations.main.metadata.slides[0].text, 'forged operator text');
});
