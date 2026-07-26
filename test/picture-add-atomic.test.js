'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const { addProjectItem } = require('../src/services/project/ServiceProject');
const {
  ServiceProjectStore,
  projectStorageKey
} = require('../src/services/project/ServiceProjectStore');

async function tempDirectory(t, prefix) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return fs.realpath(directory);
}

function pngBytes(label) {
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.from(label)
  ]);
}

function addPicture(project, asset, id = 'picture-cross') {
  return addProjectItem(project, {
    id,
    kind: 'picture',
    title: 'Wooden cross',
    assetId: asset.id,
    channelIds: [...project.channelIds],
    fit: 'fit',
    focalPoint: { x: 0.5, y: 0.5 },
    altText: 'A wooden cross',
    attribution: 'Church archive',
    presetId: 'picture-fullscreen',
    operatorNotes: ''
  });
}

function mainHandlerSource(source, channel) {
  const marker = `ipcMain.handle('${channel}'`;
  const start = source.indexOf(marker);
  assert.notEqual(start, -1, `${channel} must exist`);
  const next = source.indexOf("ipcMain.handle('", start + marker.length);
  return source.slice(start, next === -1 ? source.length : next);
}

test('image import and picture insertion publish exactly one combined revision', async t => {
  const rootPath = await tempDirectory(t, 'syncshow-picture-atomic-project-');
  const sourceRoot = await tempDirectory(t, 'syncshow-picture-atomic-source-');
  const sourcePath = path.join(sourceRoot, 'cross.png');
  const sourceBytes = pngBytes('atomic-picture');
  await fs.writeFile(sourcePath, sourceBytes);

  const store = new ServiceProjectStore({
    rootPath,
    clock: () => new Date('2026-07-23T12:00:00.000Z'),
    imageInspector: async () => ({
      format: 'png',
      width: 1920,
      height: 1080,
      pages: 1
    })
  });
  const created = await store.create({
    id: 'service-sunday',
    title: 'Sunday Service',
    serviceDate: '2026-07-26',
    profileId: 'main-sanctuary'
  });

  const added = await store.importImageAndUpdateProject(created.project.id, {
    sourcePath,
    expectedRevisionId: created.revisionId,
    altText: 'A wooden cross',
    attribution: 'Church archive',
    reason: 'add-picture'
  }, addPicture);

  const digest = crypto.createHash('sha256').update(sourceBytes).digest('hex');
  assert.equal(added.project.revision, 2);
  assert.equal(added.asset.id, `sha256:${digest}`);
  assert.equal(added.project.items['picture-cross'].assetId, added.asset.id);
  assert.deepEqual(added.project.rootItemIds, ['picture-cross']);
  assert.equal(Object.keys(added.project.assets).length, 1);

  const history = await store.listRevisions(created.project.id);
  assert.equal(history.total, 2, 'create plus atomic picture add must be the only revisions');
  assert.deepEqual(history.items.map(entry => entry.projectRevision), [2, 1]);

  const projectDirectory = path.join(rootPath, projectStorageKey(created.project.id));
  const revisions = (await fs.readdir(path.join(projectDirectory, 'revisions')))
    .filter(name => /^[a-f0-9]{64}\.json$/.test(name));
  assert.equal(revisions.length, 2, 'no asset-only revision may be written');
  const backupPointer = JSON.parse(await fs.readFile(
    path.join(projectDirectory, 'current.json.bak'),
    'utf8'
  ));
  assert.equal(backupPointer.revisionId, created.revisionId,
    'the combined picture revision must point directly back to the pre-import project');
});

test('failed picture insertion leaves no revision, pointer change, or newly copied asset', async t => {
  const rootPath = await tempDirectory(t, 'syncshow-picture-rollback-project-');
  const sourceRoot = await tempDirectory(t, 'syncshow-picture-rollback-source-');
  const sourcePath = path.join(sourceRoot, 'failed.png');
  await fs.writeFile(sourcePath, pngBytes('failed-picture'));

  const store = new ServiceProjectStore({
    rootPath,
    randomUUID: () => '11111111-1111-4111-8111-111111111111',
    imageInspector: async () => ({
      format: 'png',
      width: 800,
      height: 600,
      pages: 1
    })
  });
  const created = await store.create({
    id: 'service-failure',
    title: 'Failure Test',
    serviceDate: '2026-07-26',
    profileId: 'main-sanctuary'
  });

  await assert.rejects(
    store.importImageAndUpdateProject(created.project.id, {
      sourcePath,
      expectedRevisionId: created.revisionId,
      altText: 'A failed picture',
      reason: 'add-picture'
    }, (project, asset) => {
      assert.equal(Object.isFrozen(project), true);
      assert.equal(Object.isFrozen(asset), true);
      assert.equal(project.assets[asset.id].id, asset.id,
        'the update sees the verified asset before publication');
      throw new Error('simulated picture item failure');
    }),
    /simulated picture item failure/
  );

  const current = await store.read(created.project.id);
  assert.equal(current.revisionId, created.revisionId);
  assert.deepEqual(current.project.assets, {});
  assert.deepEqual(current.project.items, {});

  const projectDirectory = path.join(rootPath, projectStorageKey(created.project.id));
  const revisions = (await fs.readdir(path.join(projectDirectory, 'revisions')))
    .filter(name => /^[a-f0-9]{64}\.json$/.test(name));
  assert.deepEqual(revisions, [`${created.revisionId}.json`]);
  assert.deepEqual(await fs.readdir(path.join(projectDirectory, 'assets')), []);
});

test('addPicture main handler performs one trusted atomic store mutation', async () => {
  const mainSource = await fs.readFile(path.join(__dirname, '..', 'main.js'), 'utf8');
  const source = mainHandlerSource(mainSource, 'prepare:projects:addPicture');

  assert.match(source, /requireControlSender\(event\)/);
  assert.match(source, /readExpectedProject\(request\)/);
  assert.match(source, /dialog\.showOpenDialog\(/);
  assert.match(source, /importImageAndUpdateProject\(current\.projectId,/);
  assert.match(source, /expectedRevisionId:\s*current\.expectedRevisionId/);
  assert.match(source, /reason:\s*'add-picture'/);
  assert.match(source, /\(project,\s*asset\)\s*=>\s*addProjectItem\(project,/);
  assert.match(source, /assetId:\s*asset\.id/);
  assert.doesNotMatch(source, /serviceProjectStore\.save\(/,
    'main must not publish a second item-only revision after importing the asset');
});
