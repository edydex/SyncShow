'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const {
  addProjectItem,
  compileServiceProject
} = require('../src/services/project/ServiceProject');
const {
  ServiceProjectStore,
  videoFormatFromMagic
} = require('../src/services/project/ServiceProjectStore');
const { ShowPackagePublisher } = require('../src/services/project/ShowPackagePublisher');
const {
  compileNativeCueScene,
  deriveNativeSingerScene,
  sceneAssetIds
} = require('../src/services/show/NativeCueScene');

function mp4Bytes(label = 'video') {
  const payload = Buffer.from(label);
  const buffer = Buffer.alloc(24 + payload.length);
  buffer.writeUInt32BE(buffer.length, 0);
  buffer.write('ftyp', 4, 'ascii');
  buffer.write('isom', 8, 'ascii');
  buffer.writeUInt32BE(0, 12);
  buffer.write('isom', 16, 'ascii');
  buffer.write('mp42', 20, 'ascii');
  payload.copy(buffer, 24);
  return buffer;
}

async function workspace(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'syncshow-video-cue-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

test('video item compiles to one audio-owning video cue and native scene', async t => {
  const root = await workspace(t);
  const store = new ServiceProjectStore({
    rootPath: path.join(root, 'projects'),
    clock: () => new Date('2026-09-01T12:00:00.000Z'),
    randomUUID: () => '11111111-1111-4111-8111-111111111111'
  });
  const created = await store.create({
    id: 'project-video-service',
    title: 'Video Service',
    serviceDate: '2026-09-06',
    profileId: 'main-sanctuary'
  });
  const sourcePath = path.join(root, 'mission-update.mp4');
  await fs.writeFile(sourcePath, mp4Bytes('mission update'));

  const imported = await store.importVideoAndUpdateProject(created.project.id, {
    sourcePath,
    expectedRevisionId: created.revisionId
  }, (project, asset) => addProjectItem(project, {
    id: 'video-mission-update',
    kind: 'video',
    title: 'Mission update',
    assetId: asset.id,
    channelIds: ['primary', 'secondary'],
    audioChannelId: 'primary',
    fit: 'fit',
    presetId: 'video-fullscreen',
    operatorNotes: ''
  }));

  assert.equal(imported.asset.kind, 'video');
  assert.equal(imported.asset.mediaType, 'video/mp4');
  assert.equal(videoFormatFromMagic(mp4Bytes()), 'mp4');

  const timeline = compileServiceProject(imported.project);
  const cue = timeline.cues[timeline.cueIds[0]];
  assert.equal(cue.kind, 'video');
  assert.deepEqual(cue.channels.primary.blocks, [{
    type: 'video',
    assetId: imported.asset.id,
    fit: 'fit',
    muted: false
  }]);
  assert.equal(cue.channels.secondary.blocks[0].muted, true);
  assert.equal(cue.channels.media.mode, 'hide');

  const scene = compileNativeCueScene(cue, 'primary', {
    width: 1920,
    height: 1080
  });
  assert.equal(scene.layout, 'video');
  assert.equal(scene.video.muted, false);
  assert.deepEqual(sceneAssetIds(scene), [imported.asset.id]);

  const singer = deriveNativeSingerScene(scene, { state: 'end', text: '' });
  assert.equal(singer.current.layout, 'video');
  assert.deepEqual(sceneAssetIds(singer), [imported.asset.id]);

  const publisher = new ShowPackagePublisher({
    projectStore: store,
    rootPath: path.join(root, 'packages'),
    fontPath: path.resolve(__dirname, '../assets/fonts/NotoSans-Variable.ttf'),
    clock: () => new Date('2026-09-01T12:00:00.000Z'),
    randomUUID: () => '22222222-2222-4222-8222-222222222222'
  });
  const published = await publisher.publish({
    projectId: imported.project.id,
    revisionId: imported.revisionId,
    roleMapping: { main: 'primary', singers: 'secondary' },
    width: 640,
    height: 360,
    thumbnailWidth: 100,
    jpegQuality: 88
  });
  assert.equal(published.manifest.assets.length, 1);
  assert.equal(published.manifest.assets[0].id, imported.asset.id);
  assert.equal(published.manifest.assets[0].mediaType, 'video/mp4');
  await fs.access(published.presentations.main.assetPaths[imported.asset.id]);
  assert.equal(published.presentations.main.scenes[0].layout, 'video');
  assert.equal(published.presentations.main.scenes[0].video.muted, false);
  assert.equal(published.presentations.singers.scenes[0].video.muted, true);
});

test('video metadata rejects extension-only impostors', async t => {
  const root = await workspace(t);
  const store = new ServiceProjectStore({ rootPath: path.join(root, 'projects') });
  const created = await store.create({
    id: 'project-video-invalid',
    title: 'Invalid Video Service',
    serviceDate: '2026-09-06',
    profileId: 'main-sanctuary'
  });
  const sourcePath = path.join(root, 'fake.mp4');
  await fs.writeFile(sourcePath, Buffer.from('not a video'));
  await assert.rejects(
    store.importVideo(created.project.id, {
      sourcePath,
      expectedRevisionId: created.revisionId
    }),
    error => error?.code === 'INVALID_VIDEO'
  );
});
