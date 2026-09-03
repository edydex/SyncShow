'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');

const {
  LOCAL_SERVICE_PLAN_ORIGIN,
  LOCAL_SERVICE_PLAN_SCHEMA_VERSION,
  addGroupItem,
  bindProjectAsPowerPointCompanion,
  bindProjectToServiceSet
} = require('../src/services/project/ServiceProject');
const {
  MAX_IMAGE_BYTES,
  ProjectStoreError,
  ServiceProjectStore,
  imageFormatFromMagic,
  projectStorageKey,
  semanticProjectHash
} = require('../src/services/project/ServiceProjectStore');

async function tempDirectory(t, prefix = 'syncshow-project-store-') {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return fs.realpath(directory);
}

function expectStoreCode(code) {
  return error => {
    assert.ok(error instanceof ProjectStoreError, `expected ProjectStoreError, got ${error?.constructor?.name}`);
    assert.equal(error.code, code);
    return true;
  };
}

function clockAt(iso) {
  let value = new Date(iso);
  return {
    now: () => new Date(value),
    set: next => { value = new Date(next); }
  };
}

async function createProject(store, options = {}) {
  return store.create({
    id: options.id || 'project-sunday',
    title: options.title || 'Sunday Service',
    serviceDate: options.serviceDate || '2026-07-26',
    profileId: options.profileId || 'main-sanctuary'
  });
}

function changedProject(project, changes = {}) {
  return {
    ...JSON.parse(JSON.stringify(project)),
    ...changes
  };
}

function pngBytes(label = 'image') {
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.from(label)
  ]);
}

function jpegBytes(label = 'image') {
  return Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from(label)]);
}

function webpBytes(label = 'image') {
  const buffer = Buffer.alloc(12 + Buffer.byteLength(label));
  buffer.write('RIFF', 0, 'ascii');
  buffer.writeUInt32LE(Math.max(4, buffer.length - 8), 4);
  buffer.write('WEBP', 8, 'ascii');
  buffer.write(label, 12, 'utf8');
  return buffer;
}

test('constructor requires an absolute root and project storage keys confine arbitrary ids', () => {
  assert.throws(() => new ServiceProjectStore({ rootPath: 'relative/projects' }), TypeError);
  const key = projectStorageKey('../../outside/project');
  assert.match(key, /^project-[a-f0-9]{64}$/);
  assert.equal(key.includes('..'), false);
  assert.notEqual(projectStorageKey('project-a'), projectStorageKey('project-b'));
});

test('create, read, direct revision read, list, checksum, and restart form a durable round trip', async t => {
  const rootPath = await tempDirectory(t);
  const clock = clockAt('2026-07-22T12:00:00.000Z');
  const store = new ServiceProjectStore({
    rootPath,
    clock: clock.now,
    randomUUID: () => '11111111-1111-4111-8111-111111111111'
  });
  const created = await createProject(store);

  assert.equal(created.unchanged, false);
  assert.equal(created.project.revision, 1);
  assert.equal(created.project.createdAt, '2026-07-22T12:00:00.000Z');
  assert.equal(created.project.updatedAt, '2026-07-22T12:00:00.000Z');
  assert.match(created.revisionId, /^[a-f0-9]{64}$/);

  const projectDirectory = path.join(rootPath, projectStorageKey(created.project.id));
  const revisionPath = path.join(projectDirectory, 'revisions', `${created.revisionId}.json`);
  const serialized = await fs.readFile(revisionPath);
  assert.equal(crypto.createHash('sha256').update(serialized).digest('hex'), created.revisionId);

  const direct = await store.read(created.project.id, { revisionId: created.revisionId });
  assert.deepEqual(direct.project, created.project);
  assert.equal(direct.recovery, null);

  const restarted = new ServiceProjectStore({ rootPath });
  const current = await restarted.read(created.project.id);
  assert.deepEqual(current.project, created.project);
  assert.equal(current.revisionId, created.revisionId);
  assert.equal(current.recovery, null);

  const listed = await restarted.list();
  assert.equal(listed.total, 1);
  assert.deepEqual(listed.items[0], {
    id: created.project.id,
    title: created.project.title,
    serviceDate: created.project.serviceDate,
    updatedAt: created.project.updatedAt,
    revision: 1,
    revisionId: created.revisionId,
    itemCount: 0
  });
});

test('create can prepare one complete initial project before publishing its first revision', async t => {
  const rootPath = await tempDirectory(t);
  const store = new ServiceProjectStore({ rootPath });
  const created = await store.create({
    id: 'project-prepared',
    title: 'Prepared service',
    serviceDate: '2026-07-26',
    profileId: 'main-sanctuary'
  }, {
    prepareProject(project) {
      return addGroupItem(project, {
        id: 'sermon',
        title: 'Sermon',
        groupKind: 'sermon'
      });
    }
  });

  assert.equal(created.project.revision, 1);
  assert.deepEqual(created.project.rootItemIds, ['sermon']);
  assert.equal(created.project.items.sermon.kind, 'group');
  const revisions = await store.listRevisions(created.project.id);
  assert.equal(revisions.total, 1);

  await assert.rejects(
    store.create({
      id: 'project-invalid-preparer',
      title: 'Invalid preparer',
      serviceDate: '2026-07-26',
      profileId: 'main-sanctuary'
    }, { prepareProject: true }),
    TypeError
  );
  await assert.rejects(
    store.read('project-invalid-preparer'),
    expectStoreCode('PROJECT_NOT_FOUND')
  );
});

test('create can persist one local-created plan in its first revision without changing legacy unplanned creates', async t => {
  const rootPath = await tempDirectory(t);
  const store = new ServiceProjectStore({
    rootPath,
    clock: () => new Date('2026-07-30T17:00:00.000Z')
  });
  const created = await store.create({
    id: 'project-first-planned-service',
    title: 'First planned service',
    serviceDate: '2026-08-02',
    startTime: '10:30',
    teamNotes: 'Sound check at 09:45.',
    profileId: 'main-sanctuary'
  }, {
    prepareProject(project) {
      return addGroupItem(project, {
        id: 'opening',
        title: 'Opening',
        groupKind: 'section'
      });
    }
  });

  assert.equal(created.project.revision, 1);
  assert.deepEqual(created.project.planning, {
    schemaVersion: LOCAL_SERVICE_PLAN_SCHEMA_VERSION,
    status: 'planning',
    startTime: '10:30',
    origin: LOCAL_SERVICE_PLAN_ORIGIN,
    teamNotes: 'Sound check at 09:45.'
  });
  assert.deepEqual(created.project.rootItemIds, ['opening']);
  assert.equal((await store.listRevisions(created.project.id)).total, 1);

  const restarted = new ServiceProjectStore({ rootPath });
  const reopened = await restarted.read(created.project.id);
  assert.deepEqual(reopened.project, created.project);
  assert.equal(reopened.revisionId, created.revisionId);

  const legacy = await store.create({
    id: 'project-still-unplanned',
    title: 'Existing create contract',
    serviceDate: '2026-08-02',
    profileId: 'main-sanctuary'
  });
  assert.equal(legacy.project.planning, undefined);

  await assert.rejects(
    store.create({
      id: 'project-notes-without-time',
      title: 'Invalid local plan',
      serviceDate: '2026-08-02',
      teamNotes: 'Missing its required start time.',
      profileId: 'main-sanctuary'
    }),
    error => {
      assert.equal(error?.code, 'INVALID_SERVICE_PLAN_START_TIME');
      return true;
    }
  );
});

test('exact service-set binding lookup is bounded and never adopts a date-only match', async t => {
  const rootPath = await tempDirectory(t);
  const store = new ServiceProjectStore({ rootPath });
  const binding = {
    id: 'service-set-july-26',
    fingerprint: 'a'.repeat(64),
    serviceDate: '2026-07-26',
    profileId: 'main-sanctuary'
  };
  await store.create({
    id: 'project-date-only',
    title: 'Unbound date match',
    serviceDate: binding.serviceDate,
    profileId: binding.profileId
  });
  for (const projectId of ['project-bound-a', 'project-bound-b']) {
    await store.create({
      id: projectId,
      title: projectId,
      serviceDate: binding.serviceDate,
      profileId: binding.profileId
    }, {
      prepareProject(project) {
        return bindProjectToServiceSet(project, binding);
      }
    });
  }
  await store.create({
    id: 'project-companion',
    title: 'PowerPoint service record',
    serviceDate: binding.serviceDate,
    profileId: binding.profileId
  }, {
    prepareProject(project) {
      return bindProjectAsPowerPointCompanion(
        addGroupItem(project, {
          id: 'sermon-anchor',
          title: 'Sermon',
          groupKind: 'sermon'
        }),
        binding
      );
    }
  });

  const exact = await store.findByServiceSetBinding(binding, { limit: 2 });
  assert.equal(exact.length, 2);
  assert.equal(exact.every(result =>
    result.project.sourceServiceSet?.id === binding.id
      && result.project.sourceServiceSet?.fingerprint === binding.fingerprint
  ), true);
  assert.equal(exact.every(result => result.project.id !== 'project-date-only'), true);
  const companions = await store.findByServiceSetBinding(binding, {
    limit: 2,
    workflowMode: 'pptx-companion'
  });
  assert.deepEqual(
    companions.map(result => result.project.id),
    ['project-companion']
  );
  await assert.rejects(
    Promise.resolve().then(() => store.findByServiceSetBinding({
      id: binding.id,
      fingerprint: 'not-a-checksum'
    })),
    TypeError
  );
});

test('exact service-set binding lookup never adopts a revision recovered from a damaged pointer', async t => {
  const rootPath = await tempDirectory(t);
  const clock = clockAt('2026-07-22T12:00:00.000Z');
  const store = new ServiceProjectStore({ rootPath, clock: clock.now });
  const binding = {
    id: 'service-set-recovery-boundary',
    fingerprint: 'b'.repeat(64),
    serviceDate: '2026-07-26',
    profileId: 'main-sanctuary'
  };
  const created = await store.create({
    id: 'project-recovered-companion',
    title: 'PowerPoint service record',
    serviceDate: binding.serviceDate,
    profileId: binding.profileId
  }, {
    prepareProject(project) {
      return bindProjectAsPowerPointCompanion(
        addGroupItem(project, {
          id: 'sermon-anchor',
          title: 'Sermon',
          groupKind: 'sermon'
        }),
        binding
      );
    }
  });
  clock.set('2026-07-22T13:00:00.000Z');
  const saved = await store.save(changedProject(created.project, {
    title: 'Current PowerPoint service record'
  }), {
    expectedRevisionId: created.revisionId
  });
  const pointerPath = path.join(
    rootPath,
    projectStorageKey(saved.project.id),
    'current.json'
  );
  const validPointer = await fs.readFile(pointerPath, 'utf8');

  await fs.writeFile(pointerPath, '{ malformed pointer }\n');
  const malformedStore = new ServiceProjectStore({ rootPath });
  const malformedRecovery = await malformedStore.read(saved.project.id);
  assert.equal(malformedRecovery.revisionId, saved.revisionId);
  assert.equal(malformedRecovery.recovery?.source, 'revision-scan');
  assert.deepEqual(
    await malformedStore.findByServiceSetBinding(binding, {
      workflowMode: 'pptx-companion'
    }),
    []
  );
  assert.equal(await fs.readFile(pointerPath, 'utf8'), '{ malformed pointer }\n');

  await fs.writeFile(pointerPath, validPointer);
  assert.deepEqual(
    (await new ServiceProjectStore({ rootPath }).findByServiceSetBinding(
      binding,
      { workflowMode: 'pptx-companion' }
    )).map(result => result.project.id),
    [saved.project.id]
  );

  await fs.unlink(pointerPath);
  const missingStore = new ServiceProjectStore({ rootPath });
  const missingRecovery = await missingStore.read(saved.project.id);
  assert.equal(missingRecovery.revisionId, saved.revisionId);
  assert.equal(missingRecovery.recovery?.source, 'revision-scan');
  assert.deepEqual(
    await missingStore.findByServiceSetBinding(binding, {
      workflowMode: 'pptx-companion'
    }),
    []
  );
});

test('semantic no-op saves ignore editor timestamps and revisions without publishing another file', async t => {
  const rootPath = await tempDirectory(t);
  const clock = clockAt('2026-07-22T12:00:00.000Z');
  const store = new ServiceProjectStore({ rootPath, clock: clock.now });
  const created = await createProject(store);
  const revisionsPath = path.join(rootPath, projectStorageKey(created.project.id), 'revisions');
  clock.set('2026-07-22T13:00:00.000Z');

  const editorCopy = changedProject(created.project, {
    revision: 999,
    updatedAt: '2030-01-01T00:00:00.000Z'
  });
  const result = await store.save(editorCopy, { expectedRevisionId: created.revisionId });

  assert.equal(result.unchanged, true);
  assert.equal(result.revisionId, created.revisionId);
  assert.deepEqual(result.project, created.project);
  assert.deepEqual(await fs.readdir(revisionsPath), [`${created.revisionId}.json`]);
});

test('compare-and-swap rejects duplicate creation and stale saves without changing current', async t => {
  const rootPath = await tempDirectory(t);
  const clock = clockAt('2026-07-22T12:00:00.000Z');
  const store = new ServiceProjectStore({ rootPath, clock: clock.now });
  const first = await createProject(store);

  await assert.rejects(createProject(store), expectStoreCode('PROJECT_CONFLICT'));

  clock.set('2026-07-22T13:00:00.000Z');
  const second = await store.save(changedProject(first.project, { title: 'Updated Service' }), {
    expectedRevisionId: first.revisionId,
    reason: 'manual'
  });
  assert.equal(second.project.revision, 2);
  assert.notEqual(second.revisionId, first.revisionId);

  await assert.rejects(
    store.save(changedProject(first.project, { title: 'Stale Service' }), {
      expectedRevisionId: first.revisionId
    }),
    error => {
      expectStoreCode('PROJECT_CONFLICT')(error);
      assert.equal(error.details.expectedRevisionId, first.revisionId);
      assert.equal(error.details.currentRevisionId, second.revisionId);
      return true;
    }
  );
  assert.equal((await store.read(first.project.id)).project.title, 'Updated Service');
});

test('missing current pointer recovers the newest checksum-valid revision after restart', async t => {
  const rootPath = await tempDirectory(t);
  const clock = clockAt('2026-07-22T12:00:00.000Z');
  const store = new ServiceProjectStore({ rootPath, clock: clock.now });
  const first = await createProject(store);
  clock.set('2026-07-22T13:00:00.000Z');
  const second = await store.save(changedProject(first.project, { title: 'Newest Complete Service' }), {
    expectedRevisionId: first.revisionId
  });
  const projectDirectory = path.join(rootPath, projectStorageKey(first.project.id));
  await fs.unlink(path.join(projectDirectory, 'current.json'));

  const recovered = await new ServiceProjectStore({ rootPath }).read(first.project.id);
  assert.equal(recovered.revisionId, second.revisionId);
  assert.equal(recovered.project.title, 'Newest Complete Service');
  assert.equal(recovered.recovery?.source, 'revision-scan');
});

test('malformed current pointer recovers the newest checksum-valid revision without rewriting evidence', async t => {
  const rootPath = await tempDirectory(t);
  const clock = clockAt('2026-07-22T12:00:00.000Z');
  const store = new ServiceProjectStore({ rootPath, clock: clock.now });
  const first = await createProject(store);
  clock.set('2026-07-22T13:00:00.000Z');
  const second = await store.save(changedProject(first.project, { title: 'Second Revision' }), {
    expectedRevisionId: first.revisionId
  });
  const pointerPath = path.join(rootPath, projectStorageKey(first.project.id), 'current.json');
  await fs.writeFile(pointerPath, '{ malformed pointer }\n');
  const evidence = await fs.readFile(pointerPath, 'utf8');

  const recovered = await new ServiceProjectStore({ rootPath }).read(first.project.id);
  assert.equal(recovered.revisionId, second.revisionId);
  assert.equal(recovered.project.title, 'Second Revision');
  assert.equal(recovered.recovery?.source, 'revision-scan');
  assert.match(recovered.recovery?.message || '', /newest checksum-valid/i);
  assert.equal(await fs.readFile(pointerPath, 'utf8'), evidence);
});

test('a structurally valid current pointer to a missing revision recovers the newest valid revision', async t => {
  const rootPath = await tempDirectory(t);
  const clock = clockAt('2026-07-22T12:00:00.000Z');
  const store = new ServiceProjectStore({ rootPath, clock: clock.now });
  const first = await createProject(store);
  clock.set('2026-07-22T13:00:00.000Z');
  const second = await store.save(changedProject(first.project, { title: 'Second Revision' }), {
    expectedRevisionId: first.revisionId
  });
  const pointerPath = path.join(rootPath, projectStorageKey(first.project.id), 'current.json');
  const pointer = JSON.parse(await fs.readFile(pointerPath, 'utf8'));
  pointer.revisionId = 'f'.repeat(64);
  await fs.writeFile(pointerPath, `${JSON.stringify(pointer, null, 2)}\n`);

  const recovered = await new ServiceProjectStore({ rootPath }).read(first.project.id);
  assert.equal(recovered.revisionId, second.revisionId);
  assert.equal(recovered.recovery?.source, 'revision-scan');
});

test('listing uses recovery logic so pointer damage does not make a recoverable project disappear', async t => {
  const rootPath = await tempDirectory(t);
  const clock = clockAt('2026-07-22T12:00:00.000Z');
  const store = new ServiceProjectStore({ rootPath, clock: clock.now });
  const first = await createProject(store);
  clock.set('2026-07-22T13:00:00.000Z');
  const second = await store.save(changedProject(first.project, { title: 'Second Revision' }), {
    expectedRevisionId: first.revisionId
  });
  const pointerPath = path.join(rootPath, projectStorageKey(first.project.id), 'current.json');
  await fs.writeFile(pointerPath, '{ malformed pointer }\n');

  const listed = await new ServiceProjectStore({ rootPath }).list();
  assert.equal(listed.total, 1);
  assert.equal(listed.items[0].id, first.project.id);
  assert.equal(listed.items[0].revisionId, second.revisionId);
});

test('immutable revision tampering is surfaced and never treated as project data', async t => {
  const rootPath = await tempDirectory(t);
  const store = new ServiceProjectStore({ rootPath });
  const created = await createProject(store);
  const revisionPath = path.join(
    rootPath,
    projectStorageKey(created.project.id),
    'revisions',
    `${created.revisionId}.json`
  );
  const source = await fs.readFile(revisionPath, 'utf8');
  await fs.writeFile(revisionPath, source.replace('Sunday Service', 'Sunday Tampered'));

  await assert.rejects(
    store.read(created.project.id, { revisionId: created.revisionId }),
    expectStoreCode('PROJECT_REVISION_CORRUPT')
  );
  await assert.rejects(store.read(created.project.id), expectStoreCode('PROJECT_REVISION_CORRUPT'));
  assert.equal((await store.list()).total, 0);
});

test('project listing searches, sorts, clamps pages, and preserves broken entries for diagnostics', async t => {
  const rootPath = await tempDirectory(t);
  const clock = clockAt('2026-07-22T12:00:00.000Z');
  const store = new ServiceProjectStore({ rootPath, clock: clock.now });
  await createProject(store, { id: 'project-old', title: 'Midweek Prayer', serviceDate: '2026-07-22' });
  clock.set('2026-07-22T13:00:00.000Z');
  await createProject(store, { id: 'project-z', title: 'Zulu Service', serviceDate: '2026-07-26' });
  clock.set('2026-07-22T14:00:00.000Z');
  await createProject(store, { id: 'project-a', title: 'Alpha Service', serviceDate: '2026-07-26' });

  assert.deepEqual((await store.list()).items.map(item => item.id), ['project-a', 'project-z', 'project-old']);
  assert.deepEqual((await store.list({ query: 'midweek 2026-07-22' })).items.map(item => item.id), ['project-old']);
  const first = await store.list({ pageSize: 1 });
  assert.equal(first.nextOffset, 1);
  assert.deepEqual((await store.list({ pageSize: 1, offset: first.nextOffset })).items.map(item => item.id), ['project-z']);
  assert.equal((await store.list({ pageSize: 1000 })).items.length, 3);
  await assert.rejects(store.list({ query: 'x'.repeat(121) }), expectStoreCode('QUERY_TOO_LONG'));

  const brokenPointerPath = path.join(rootPath, projectStorageKey('project-old'), 'current.json');
  await fs.writeFile(brokenPointerPath, '{ broken and preserved }\n');
  const evidence = await fs.readFile(brokenPointerPath, 'utf8');
  assert.deepEqual((await store.list()).items.map(item => item.id), ['project-a', 'project-z']);
  assert.equal(await fs.readFile(brokenPointerPath, 'utf8'), evidence);
});

test('project directories cannot be redirected through a symbolic link', async t => {
  if (process.platform === 'win32') {
    t.skip('Creating symlinks is not reliably permitted on Windows CI.');
    return;
  }
  const rootPath = await tempDirectory(t);
  const outsidePath = await tempDirectory(t, 'syncshow-project-outside-');
  const projectId = 'project-symlink';
  await fs.symlink(outsidePath, path.join(rootPath, projectStorageKey(projectId)));
  const store = new ServiceProjectStore({ rootPath });

  await assert.rejects(
    createProject(store, { id: projectId }),
    /Unsafe storage directory|escaped its canonical root/
  );
  assert.deepEqual(await fs.readdir(outsidePath), []);
});

test('image magic identifies supported formats and rejects extension-only impostors', () => {
  assert.equal(imageFormatFromMagic(pngBytes()), 'png');
  assert.equal(imageFormatFromMagic(jpegBytes()), 'jpeg');
  assert.equal(imageFormatFromMagic(webpBytes()), 'webp');
  assert.equal(imageFormatFromMagic(Buffer.from('pretend.png')), null);
  assert.equal(imageFormatFromMagic(Buffer.from([0x89, 0x50, 0x4e])), null);
});

test('image import pins a content-addressed asset that survives source deletion and restart', async t => {
  const rootPath = await tempDirectory(t);
  const sourceRoot = await tempDirectory(t, 'syncshow-picture-source-');
  const sourcePath = path.join(sourceRoot, 'cross.any-extension');
  const bytes = pngBytes('cross-image');
  await fs.writeFile(sourcePath, bytes);
  let inspectedPath = null;
  const store = new ServiceProjectStore({
    rootPath,
    clock: () => new Date('2026-07-22T12:00:00.000Z'),
    imageInspector: async filePath => {
      inspectedPath = filePath;
      return { format: 'png', width: 1920, height: 1080, pages: 1, orientation: 6 };
    }
  });
  const created = await createProject(store);
  const imported = await store.importImage(created.project.id, {
    sourcePath,
    expectedRevisionId: created.revisionId,
    altText: 'A wooden cross',
    attribution: 'Church archive'
  });

  const digest = crypto.createHash('sha256').update(bytes).digest('hex');
  assert.equal(imported.asset.id, `sha256:${digest}`);
  assert.equal(imported.asset.storedName, `${digest}.png`);
  assert.equal(imported.asset.mediaType, 'image/png');
  assert.equal(imported.asset.fileName, 'cross.any-extension');
  assert.equal(imported.asset.orientation, 6);
  assert.equal(imported.asset.width, 1920);
  assert.equal(imported.asset.height, 1080);
  assert.equal(imported.project.revision, 2);
  assert.equal(inspectedPath, path.join(store.rootPath, projectStorageKey(created.project.id), 'assets', `${digest}.png`));

  await fs.unlink(sourcePath);
  const resolved = await new ServiceProjectStore({ rootPath }).resolveAssetPath(
    created.project.id,
    imported.revisionId,
    imported.asset.id
  );
  assert.equal(resolved.assetPath, inspectedPath);
  assert.deepEqual(await fs.readFile(resolved.assetPath), bytes);
});

test('reimporting identical image content and metadata is a revision no-op and deduplicates the blob', async t => {
  const rootPath = await tempDirectory(t);
  const sourceRoot = await tempDirectory(t, 'syncshow-picture-dedupe-');
  const sourcePath = path.join(sourceRoot, 'same.png');
  await fs.writeFile(sourcePath, pngBytes('same-content'));
  const clock = clockAt('2026-07-22T12:00:00.000Z');
  const store = new ServiceProjectStore({
    rootPath,
    clock: clock.now,
    randomUUID: (() => {
      let next = 0;
      return () => `00000000-0000-4000-8000-${String(++next).padStart(12, '0')}`;
    })(),
    imageInspector: async () => ({ format: 'png', width: 100, height: 50, pages: 1 })
  });
  const created = await createProject(store);
  const first = await store.importImage(created.project.id, {
    sourcePath,
    expectedRevisionId: created.revisionId,
    altText: 'Same image'
  });
  clock.set('2026-07-22T13:00:00.000Z');
  const second = await store.importImage(created.project.id, {
    sourcePath,
    expectedRevisionId: first.revisionId,
    altText: 'Same image'
  });

  assert.equal(second.unchanged, true);
  assert.equal(second.revisionId, first.revisionId);
  assert.equal(Object.keys(second.project.assets).length, 1);
  const assetsPath = path.join(rootPath, projectStorageKey(created.project.id), 'assets');
  assert.deepEqual((await fs.readdir(assetsPath)).filter(name => !name.startsWith('.')), [first.asset.storedName]);
});

test('image import rejects stale revisions, relative paths, symlinks, empty files, and oversized files', async t => {
  const rootPath = await tempDirectory(t);
  const sourceRoot = await tempDirectory(t, 'syncshow-picture-invalid-source-');
  const store = new ServiceProjectStore({
    rootPath,
    imageInspector: async () => ({ format: 'png', width: 1, height: 1, pages: 1 })
  });
  const created = await createProject(store);
  await assert.rejects(
    store.importImage(created.project.id, {
      sourcePath: 'relative.png', expectedRevisionId: created.revisionId, altText: 'Relative'
    }),
    expectStoreCode('INVALID_IMAGE_IMPORT')
  );

  const regularPath = path.join(sourceRoot, 'regular.png');
  await fs.writeFile(regularPath, pngBytes());
  await assert.rejects(
    store.importImage(created.project.id, {
      sourcePath: regularPath, expectedRevisionId: '0'.repeat(64), altText: 'Stale'
    }),
    expectStoreCode('PROJECT_CONFLICT')
  );

  const emptyPath = path.join(sourceRoot, 'empty.png');
  await fs.writeFile(emptyPath, '');
  await assert.rejects(
    store.importImage(created.project.id, {
      sourcePath: emptyPath, expectedRevisionId: created.revisionId, altText: 'Empty'
    }),
    expectStoreCode('INVALID_IMAGE_IMPORT')
  );

  const oversizedPath = path.join(sourceRoot, 'oversized.png');
  const oversizedHandle = await fs.open(oversizedPath, 'w');
  await oversizedHandle.truncate(MAX_IMAGE_BYTES + 1);
  await oversizedHandle.close();
  await assert.rejects(
    store.importImage(created.project.id, {
      sourcePath: oversizedPath, expectedRevisionId: created.revisionId, altText: 'Oversized'
    }),
    expectStoreCode('INVALID_IMAGE_IMPORT')
  );

  if (process.platform !== 'win32') {
    const linkPath = path.join(sourceRoot, 'linked.png');
    await fs.symlink(regularPath, linkPath);
    await assert.rejects(
      store.importImage(created.project.id, {
        sourcePath: linkPath, expectedRevisionId: created.revisionId, altText: 'Linked'
      }),
      expectStoreCode('INVALID_IMAGE_IMPORT')
    );
  }
});

test('invalid magic and missing alt text leave the project pointer unchanged and clean temporary imports', async t => {
  const rootPath = await tempDirectory(t);
  const sourceRoot = await tempDirectory(t, 'syncshow-picture-validation-');
  const store = new ServiceProjectStore({
    rootPath,
    randomUUID: () => '11111111-1111-4111-8111-111111111111',
    imageInspector: async () => ({ format: 'png', width: 100, height: 100, pages: 1 })
  });
  const created = await createProject(store);

  const fakePath = path.join(sourceRoot, 'fake.png');
  await fs.writeFile(fakePath, 'not actually an image');
  await assert.rejects(
    store.importImage(created.project.id, {
      sourcePath: fakePath, expectedRevisionId: created.revisionId, altText: 'Fake'
    }),
    expectStoreCode('INVALID_IMAGE')
  );

  const validPath = path.join(sourceRoot, 'valid.png');
  await fs.writeFile(validPath, pngBytes('no-alt'));
  await assert.rejects(
    store.importImage(created.project.id, {
      sourcePath: validPath, expectedRevisionId: created.revisionId, altText: '   '
    }),
    expectStoreCode('MISSING_ALT_TEXT')
  );

  const current = await store.read(created.project.id);
  assert.equal(current.revisionId, created.revisionId);
  assert.deepEqual(current.project.assets, {});
  const assetsPath = path.join(rootPath, projectStorageKey(created.project.id), 'assets');
  assert.equal((await fs.readdir(assetsPath)).some(name => name.startsWith('.import-')), false);
});

test('injected image inspection rejects format lies, malformed dimensions, pixel bombs, and animation', async () => {
  const invalidMetadata = [
    null,
    { format: 'jpeg', width: 100, height: 100, pages: 1 },
    { format: 'png', width: 0, height: 100, pages: 1 },
    { format: 'png', width: 1.5, height: 100, pages: 1 },
    { format: 'png', width: 32769, height: 1, pages: 1 },
    { format: 'png', width: 20000, height: 20000, pages: 1 },
    { format: 'png', width: 100, height: 100, pages: 2 }
  ];

  for (const metadata of invalidMetadata) {
    const store = new ServiceProjectStore({
      rootPath: path.resolve(os.tmpdir(), 'unused-syncshow-project-image-test'),
      imageInspector: async () => metadata
    });
    await assert.rejects(store._inspectImage('/not-opened-by-injected-inspector', 'png'), expectStoreCode('INVALID_IMAGE'));
  }
});

test('invalid EXIF orientation is rejected as image metadata before project publication', async t => {
  const rootPath = await tempDirectory(t);
  const sourceRoot = await tempDirectory(t, 'syncshow-picture-orientation-');
  const sourcePath = path.join(sourceRoot, 'orientation.png');
  await fs.writeFile(sourcePath, pngBytes('orientation'));
  const store = new ServiceProjectStore({
    rootPath,
    imageInspector: async () => ({ format: 'png', width: 100, height: 100, pages: 1, orientation: 99 })
  });
  const created = await createProject(store);

  await assert.rejects(
    store.importImage(created.project.id, {
      sourcePath,
      expectedRevisionId: created.revisionId,
      altText: 'Orientation test'
    }),
    expectStoreCode('INVALID_IMAGE')
  );
  assert.equal((await store.read(created.project.id)).revisionId, created.revisionId);
});

test('asset checksum tampering and symlink substitution fail closed', async t => {
  const rootPath = await tempDirectory(t);
  const sourceRoot = await tempDirectory(t, 'syncshow-picture-tamper-');
  const sourcePath = path.join(sourceRoot, 'asset.png');
  await fs.writeFile(sourcePath, pngBytes('original'));
  const store = new ServiceProjectStore({
    rootPath,
    imageInspector: async () => ({ format: 'png', width: 100, height: 100, pages: 1 })
  });
  const created = await createProject(store);
  const imported = await store.importImage(created.project.id, {
    sourcePath,
    expectedRevisionId: created.revisionId,
    altText: 'Checksum test'
  });
  const assetPath = path.join(rootPath, projectStorageKey(created.project.id), 'assets', imported.asset.storedName);
  const original = await fs.readFile(assetPath);
  const tampered = Buffer.from(original);
  tampered[tampered.length - 1] ^= 0xff;
  await fs.writeFile(assetPath, tampered);

  await assert.rejects(
    store.resolveAssetPath(created.project.id, imported.revisionId, imported.asset.id),
    expectStoreCode('ASSET_CORRUPT')
  );
  await assert.rejects(
    store.importImage(created.project.id, {
      sourcePath,
      expectedRevisionId: imported.revisionId,
      altText: 'Checksum test'
    }),
    expectStoreCode('ASSET_HASH_MISMATCH')
  );

  if (process.platform !== 'win32') {
    await fs.unlink(assetPath);
    const outsidePath = path.join(sourceRoot, 'outside.png');
    await fs.writeFile(outsidePath, original);
    await fs.symlink(outsidePath, assetPath);
    await assert.rejects(
      store.resolveAssetPath(created.project.id, imported.revisionId, imported.asset.id),
      expectStoreCode('ASSET_CORRUPT')
    );
  }
});

test('semantic hashes disregard publication metadata but include actual project changes', async t => {
  const rootPath = await tempDirectory(t);
  const store = new ServiceProjectStore({ rootPath });
  const created = await createProject(store);
  const metadataOnly = changedProject(created.project, {
    revision: created.project.revision + 50,
    updatedAt: '2035-01-01T00:00:00.000Z'
  });
  const changed = changedProject(created.project, { title: 'Meaningfully Changed' });

  assert.equal(semanticProjectHash(metadataOnly), semanticProjectHash(created.project));
  assert.notEqual(semanticProjectHash(changed), semanticProjectHash(created.project));
});
