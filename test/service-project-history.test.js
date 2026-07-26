'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');

const {
  ProjectStoreError,
  ServiceProjectStore
} = require('../src/services/project/ServiceProjectStore');
const {
  addGroupItem,
  addProjectItem,
  addSongResource,
  parseSongDocument,
  removeProjectItemAndDescendants
} = require('../src/services/project');

async function tempDirectory(t, prefix = 'syncshow-project-history-') {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return fs.realpath(directory);
}

function expectCode(code) {
  return error => {
    assert.ok(error instanceof ProjectStoreError, `expected ProjectStoreError, got ${error?.constructor?.name}`);
    assert.equal(error.code, code);
    return true;
  };
}

function changed(project, changes) {
  return { ...JSON.parse(JSON.stringify(project)), ...changes };
}

function clockAt(iso) {
  let value = new Date(iso);
  return {
    now: () => new Date(value),
    set: next => { value = new Date(next); }
  };
}

test('restoreRevision copies historical semantics into new monotonic CAS revisions for undo and redo', async t => {
  const rootPath = await tempDirectory(t);
  const clock = clockAt('2026-07-23T10:00:00.000Z');
  const store = new ServiceProjectStore({ rootPath, clock: clock.now });
  const first = await store.create({
    id: 'history-service',
    title: 'Original title',
    serviceDate: '2026-07-26',
    profileId: 'main-sanctuary'
  });
  clock.set('2026-07-23T10:01:00.000Z');
  const second = await store.save(changed(first.project, { title: 'Edited title' }), {
    expectedRevisionId: first.revisionId,
    reason: 'edit-title'
  });

  clock.set('2026-07-23T10:02:00.000Z');
  const undone = await store.restoreRevision(first.project.id, {
    expectedRevisionId: second.revisionId,
    targetRevisionId: first.revisionId,
    reason: 'undo'
  });
  assert.equal(undone.project.title, 'Original title');
  assert.equal(undone.project.revision, 3);
  assert.notEqual(undone.revisionId, first.revisionId);
  assert.notEqual(undone.revisionId, second.revisionId);
  assert.equal((await store.read(first.project.id)).revisionId, undone.revisionId);

  clock.set('2026-07-23T10:03:00.000Z');
  const redone = await store.restoreRevision(first.project.id, {
    expectedRevisionId: undone.revisionId,
    targetRevisionId: second.revisionId,
    reason: 'redo'
  });
  assert.equal(redone.project.title, 'Edited title');
  assert.equal(redone.project.revision, 4);
  assert.notEqual(redone.revisionId, second.revisionId);
  assert.equal((await store.read(first.project.id, { revisionId: first.revisionId })).project.title, 'Original title');
  assert.equal((await store.read(first.project.id, { revisionId: second.revisionId })).project.title, 'Edited title');

  const restarted = await new ServiceProjectStore({ rootPath }).read(first.project.id);
  assert.equal(restarted.revisionId, redone.revisionId);
  assert.equal(restarted.project.revision, 4);
  assert.equal(restarted.project.title, 'Edited title');
});

test('listRevisions exposes newest valid history without leaking corrupt revision files', async t => {
  const rootPath = await tempDirectory(t);
  const store = new ServiceProjectStore({ rootPath });
  const first = await store.create({
    id: 'history-list',
    title: 'First title',
    serviceDate: '2026-07-26',
    profileId: 'main-sanctuary'
  });
  const second = await store.save(changed(first.project, { title: 'Second title' }), {
    expectedRevisionId: first.revisionId,
    reason: 'edit-title'
  });
  const projectDirectory = store._projectDirectory(first.project.id);
  await fs.writeFile(path.join(projectDirectory, 'revisions', `${'f'.repeat(64)}.json`), '{"damaged":true}\n');

  const listed = await store.listRevisions(first.project.id, { limit: 10 });
  assert.equal(listed.total, 2);
  assert.equal(listed.currentRevisionId, second.revisionId);
  assert.deepEqual(listed.items.map(item => item.revisionId), [second.revisionId, first.revisionId]);
  assert.deepEqual(listed.items.map(item => item.projectRevision), [2, 1]);
  assert.equal(listed.items[0].current, true);
  assert.equal(listed.items[1].current, false);
});

test('restoreRevision rejects stale editors and invalid or foreign targets without moving current', async t => {
  const rootPath = await tempDirectory(t);
  const store = new ServiceProjectStore({ rootPath });
  const first = await store.create({
    id: 'history-one',
    title: 'One',
    serviceDate: '2026-07-26',
    profileId: 'main-sanctuary'
  });
  const second = await store.save(changed(first.project, { title: 'Two' }), {
    expectedRevisionId: first.revisionId
  });
  const foreign = await store.create({
    id: 'history-foreign',
    title: 'Foreign',
    serviceDate: '2026-07-27',
    profileId: 'main-sanctuary'
  });

  await assert.rejects(
    store.restoreRevision(first.project.id, {
      expectedRevisionId: first.revisionId,
      targetRevisionId: first.revisionId
    }),
    expectCode('PROJECT_CONFLICT')
  );
  await assert.rejects(
    store.restoreRevision(first.project.id, {
      expectedRevisionId: second.revisionId,
      targetRevisionId: foreign.revisionId
    }),
    expectCode('PROJECT_REVISION_MISSING')
  );
  await assert.rejects(
    store.restoreRevision(first.project.id, {
      expectedRevisionId: second.revisionId,
      targetRevisionId: '../outside'
    }),
    expectCode('INVALID_REVISION')
  );
  assert.equal((await store.read(first.project.id)).revisionId, second.revisionId);

  const noOp = await store.restoreRevision(first.project.id, {
    expectedRevisionId: second.revisionId,
    targetRevisionId: second.revisionId
  });
  assert.equal(noOp.unchanged, true);
  assert.equal(noOp.revisionId, second.revisionId);
});

test('picture blobs remain available across undo, redo, and restart', async t => {
  const rootPath = await tempDirectory(t);
  const sourcePath = path.join(await tempDirectory(t, 'syncshow-history-image-'), 'picture.png');
  const bytes = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.from('history-picture')
  ]);
  await fs.writeFile(sourcePath, bytes);
  const store = new ServiceProjectStore({
    rootPath,
    imageInspector: async () => ({ format: 'png', width: 640, height: 360, pages: 1, orientation: 1 })
  });
  const empty = await store.create({
    id: 'history-picture',
    title: 'Picture history',
    serviceDate: '2026-07-26',
    profileId: 'main-sanctuary'
  });
  const withPicture = await store.importImage(empty.project.id, {
    sourcePath,
    expectedRevisionId: empty.revisionId,
    altText: 'A history fixture'
  });
  const undone = await store.restoreRevision(empty.project.id, {
    expectedRevisionId: withPicture.revisionId,
    targetRevisionId: empty.revisionId,
    reason: 'undo'
  });
  assert.deepEqual(undone.project.assets, {});

  const redone = await store.restoreRevision(empty.project.id, {
    expectedRevisionId: undone.revisionId,
    targetRevisionId: withPicture.revisionId,
    reason: 'redo'
  });
  const assetId = withPicture.asset.id;
  assert.ok(redone.project.assets[assetId]);

  const restarted = new ServiceProjectStore({ rootPath });
  const resolved = await restarted.resolveAssetPath(empty.project.id, redone.revisionId, assetId);
  assert.deepEqual(await fs.readFile(resolved.assetPath), bytes);
});

test('subtree removal prunes current picture and song records while history restores their pinned content', async t => {
  const rootPath = await tempDirectory(t);
  const sourcePath = path.join(await tempDirectory(t, 'syncshow-pruned-image-'), 'picture.png');
  const bytes = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.from('pruned-current-revision-picture')
  ]);
  await fs.writeFile(sourcePath, bytes);
  const store = new ServiceProjectStore({
    rootPath,
    imageInspector: async () => ({ format: 'png', width: 1280, height: 720, pages: 1, orientation: 1 })
  });
  const created = await store.create({
    id: 'history-pruned-records',
    title: 'Pruned records',
    serviceDate: '2026-07-26',
    profileId: 'main-sanctuary',
    channels: [
      { id: 'primary', label: 'Main', language: 'en' },
      { id: 'secondary', label: 'Second language', language: 'uk' }
    ]
  });
  const grouped = await store.save(addGroupItem(created.project, {
    id: 'service-content',
    title: 'Service content',
    groupKind: 'section'
  }), {
    expectedRevisionId: created.revisionId,
    reason: 'add-group'
  });
  const pictured = await store.importImageAndUpdateProject(grouped.project.id, {
    sourcePath,
    expectedRevisionId: grouped.revisionId,
    altText: 'A picture retained for history',
    reason: 'add-picture'
  }, (project, asset) => addProjectItem(project, {
    id: 'picture-history',
    kind: 'picture',
    title: 'History picture',
    assetId: asset.id,
    channelIds: ['primary', 'secondary'],
    fit: 'fit',
    focalPoint: { x: 0.5, y: 0.5 },
    altText: 'A picture retained for history',
    attribution: '',
    presetId: 'picture-fullscreen',
    operatorNotes: ''
  }, { parentId: 'service-content' }));

  const song = parseSongDocument([
    '---',
    'id: history-song',
    'title: History Song',
    'language: en',
    '---',
    '^1',
    'The pinned words remain'
  ].join('\n'));
  const pinned = addSongResource(pictured.project, song, {
    provider: 'local',
    itemId: song.id,
    revision: 'history-song-revision'
  });
  const withSong = addProjectItem(pinned.project, {
    id: 'song-history',
    kind: 'song',
    title: song.title,
    primaryChannelId: 'primary',
    variants: {
      primary: { mode: 'content', resourceId: pinned.resourceId },
      secondary: { mode: 'inherit', from: 'primary' }
    },
    arrangement: [{ id: 'arr-history-verse', sectionId: 'verse-1' }],
    titlePresetId: 'song-title',
    lyricsPresetId: 'song-lyrics',
    operatorNotes: ''
  }, { parentId: 'service-content' });
  const complete = await store.save(withSong, {
    expectedRevisionId: pictured.revisionId,
    reason: 'add-song'
  });
  const assetId = pictured.asset.id;
  const assetPath = (await store.resolveAssetPath(complete.project.id, complete.revisionId, assetId)).assetPath;
  assert.ok(complete.project.assets[assetId]);
  assert.ok(complete.project.resources[pinned.resourceId]);

  const removed = await store.save(
    removeProjectItemAndDescendants(complete.project, 'service-content'),
    {
      expectedRevisionId: complete.revisionId,
      reason: 'remove-item'
    }
  );
  assert.deepEqual(removed.project.rootItemIds, []);
  assert.deepEqual(removed.project.items, {});
  assert.deepEqual(removed.project.resources, {});
  assert.deepEqual(removed.project.assets, {});
  assert.deepEqual(await fs.readFile(assetPath), bytes, 'semantic pruning must not delete the shared blob');

  const historical = await store.read(complete.project.id, { revisionId: complete.revisionId });
  assert.ok(historical.project.items['picture-history']);
  assert.ok(historical.project.items['song-history']);
  assert.ok(historical.project.assets[assetId]);
  assert.ok(historical.project.resources[pinned.resourceId]);
  assert.deepEqual(
    await fs.readFile((await store.resolveAssetPath(
      complete.project.id,
      complete.revisionId,
      assetId
    )).assetPath),
    bytes
  );

  const restored = await store.restoreRevision(complete.project.id, {
    expectedRevisionId: removed.revisionId,
    targetRevisionId: complete.revisionId,
    reason: 'undo'
  });
  assert.ok(restored.project.items['picture-history']);
  assert.ok(restored.project.items['song-history']);
  assert.ok(restored.project.assets[assetId]);
  assert.ok(restored.project.resources[pinned.resourceId]);
  assert.deepEqual(
    await fs.readFile((await store.resolveAssetPath(
      complete.project.id,
      restored.revisionId,
      assetId
    )).assetPath),
    bytes
  );
});
