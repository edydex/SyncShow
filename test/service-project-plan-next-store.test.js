'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');

const {
  addGroupItem,
  addProjectItem,
  bindProjectAsPowerPointCompanion,
  normalizeServiceProject,
  serializeServiceProject
} = require('../src/services/project/ServiceProject');
const {
  ServiceProjectStore,
  projectStorageKey
} = require('../src/services/project/ServiceProjectStore');
const {
  withExclusiveFileLock
} = require('../src/services/project/StorageSafety');

const NOW = '2026-07-28T17:00:00.000Z';

async function tempDirectory(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'syncshow-plan-next-store-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return fs.realpath(directory);
}

function idGenerator() {
  let value = 0;
  return () => `00000000-0000-4000-8000-${String(++value).padStart(12, '0')}`;
}

function expectCode(code) {
  return error => {
    assert.equal(error?.code, code, error?.stack);
    return true;
  };
}

function planOptions(sourceRevisionId, overrides = {}) {
  return {
    sourceRevisionId,
    id: 'service-2026-08-02',
    title: 'Sunday Service — August 2',
    serviceDate: '2026-08-02',
    startTime: '10:30',
    teamNotes: 'Communion this week.',
    ...overrides
  };
}

function projectDirectory(rootPath, projectId) {
  return path.join(rootPath, projectStorageKey(projectId));
}

function pngBytes(label = 'image') {
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.from(label)
  ]);
}

async function createStore(t, options = {}) {
  const rootPath = await tempDirectory(t);
  const imageState = options.imageState || {
    format: 'png',
    width: 64,
    height: 36,
    orientation: 1,
    pages: 1
  };
  const store = new ServiceProjectStore({
    rootPath,
    clock: () => new Date(NOW),
    randomUUID: idGenerator(),
    imageInspector: async () => ({ ...imageState })
  });
  return { rootPath, store, imageState };
}

async function createSource(store, options = {}) {
  return store.create({
    id: options.id || 'service-2026-07-26',
    title: 'Sunday Service — July 26',
    serviceDate: '2026-07-26',
    profileId: 'main-sanctuary',
    channels: [
      { id: 'primary', label: 'Main', language: 'en' },
      { id: 'media', label: 'Singers', language: 'en' }
    ]
  }, options.prepareProject ? { prepareProject: options.prepareProject } : {});
}

async function addRetainedImage(store, rootPath, current) {
  const selectedPath = path.join(rootPath, 'selected-welcome.png');
  await fs.writeFile(selectedPath, pngBytes('welcome'));
  return store.importImageAndUpdateProject(current.project.id, {
    sourcePath: selectedPath,
    expectedRevisionId: current.revisionId,
    altText: 'Welcome',
    attribution: ''
  }, (project, asset) => addProjectItem(project, {
    id: 'welcome-picture',
    kind: 'picture',
    title: 'Welcome',
    assetId: asset.id,
    channelIds: ['primary'],
    fit: 'fit',
    focalPoint: { x: 0.5, y: 0.5 },
    altText: asset.altText,
    attribution: asset.attribution,
    presetId: 'picture-fullscreen',
    operatorNotes: ''
  }, { now: NOW }));
}

async function addDeckAndOrphan(store, rootPath, current) {
  const deckBytes = Buffer.alloc((2 * 1024 * 1024) + 17, 0x5a);
  const deckSha256 = crypto.createHash('sha256').update(deckBytes).digest('hex');
  const deckId = `sha256:${deckSha256}`;
  const orphanBytes = Buffer.from('private orphan from last week');
  const orphanSha256 = crypto.createHash('sha256').update(orphanBytes).digest('hex');
  const orphanId = `sha256:${orphanSha256}`;
  const assetsPath = path.join(
    projectDirectory(rootPath, current.project.id),
    'assets'
  );
  await fs.writeFile(path.join(assetsPath, `${deckSha256}.pptx`), deckBytes);
  await fs.writeFile(path.join(assetsPath, `${orphanSha256}.pdf`), orphanBytes);

  const raw = JSON.parse(serializeServiceProject(current.project));
  raw.assets[deckId] = {
    id: deckId,
    kind: 'deck',
    sha256: deckSha256,
    fileName: 'service-slides.pptx',
    storedName: `${deckSha256}.pptx`,
    mediaType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    size: deckBytes.length,
    createdAt: NOW,
    attribution: '',
    altText: ''
  };
  raw.assets[orphanId] = {
    id: orphanId,
    kind: 'document',
    sha256: orphanSha256,
    fileName: 'private-notes.pdf',
    storedName: `${orphanSha256}.pdf`,
    mediaType: 'application/pdf',
    size: orphanBytes.length,
    createdAt: NOW,
    attribution: '',
    altText: ''
  };
  let project = normalizeServiceProject(raw, { now: NOW });
  project = addProjectItem(project, {
    id: 'retained-deck',
    kind: 'imported-deck',
    title: 'Announcements',
    assetIdsByChannel: { primary: deckId },
    slides: [{ id: 'deck-slide-1', sourceIndexes: { primary: 0 } }],
    presetId: 'legacy-slide',
    operatorNotes: ''
  }, { now: NOW });
  const saved = await store.save(project, {
    expectedRevisionId: current.revisionId,
    reason: 'test-add-deck'
  });
  return {
    saved,
    deckBytes,
    deckId,
    deckStoredName: `${deckSha256}.pptx`,
    orphanId,
    orphanStoredName: `${orphanSha256}.pdf`
  };
}

test('planNextService publishes revision 1 with independent retained image/deck blobs and safe summaries', async t => {
  const { rootPath, store } = await createStore(t);
  let source = await createSource(store);
  source = await addRetainedImage(store, rootPath, source);
  const imageAsset = Object.values(source.project.assets)[0];
  const withDeck = await addDeckAndOrphan(store, rootPath, source);
  source = withDeck.saved;

  const planned = await store.planNextService(
    source.project.id,
    planOptions(source.revisionId)
  );
  assert.equal(planned.project.revision, 1);
  assert.equal(planned.unchanged, false);
  assert.equal(planned.sourceProjectId, source.project.id);
  assert.equal(planned.sourceRevisionId, source.revisionId);
  assert.deepEqual(planned.project.planning.templateSource, {
    projectId: source.project.id,
    sourceRevisionId: source.revisionId
  });
  assert.equal(planned.project.planning.teamNotes, 'Communion this week.');
  assert.deepEqual(
    Object.keys(planned.project.assets).sort(),
    [imageAsset.id, withDeck.deckId].sort()
  );
  assert.equal(planned.project.assets[withDeck.orphanId], undefined);

  const targetAssetsPath = path.join(
    projectDirectory(rootPath, planned.project.id),
    'assets'
  );
  assert.deepEqual(
    (await fs.readdir(targetAssetsPath)).filter(name => !name.startsWith('.')).sort(),
    [imageAsset.storedName, withDeck.deckStoredName].sort()
  );
  assert.deepEqual(
    await fs.readFile(path.join(targetAssetsPath, withDeck.deckStoredName)),
    withDeck.deckBytes
  );
  await fs.unlink(path.join(
    projectDirectory(rootPath, source.project.id),
    'assets',
    imageAsset.storedName
  ));
  await fs.unlink(path.join(
    projectDirectory(rootPath, source.project.id),
    'assets',
    withDeck.deckStoredName
  ));
  const restarted = new ServiceProjectStore({
    rootPath,
    imageInspector: async () => ({
      format: 'png',
      width: 64,
      height: 36,
      orientation: 1,
      pages: 1
    })
  });
  assert.equal(
    (await restarted.resolveAssetPath(planned.project.id, planned.revisionId, imageAsset.id))
      .asset.sha256,
    imageAsset.sha256
  );
  assert.equal(
    (await restarted.resolveAssetPath(planned.project.id, planned.revisionId, withDeck.deckId))
      .asset.sha256,
    withDeck.deckId.slice('sha256:'.length)
  );

  const summary = (await restarted.list()).items.find(item =>
    item.id === planned.project.id);
  assert.deepEqual(summary.planning, { status: 'planning', startTime: '10:30' });
  assert.equal(Object.hasOwn(summary.planning, 'teamNotes'), false);
});

test('planNextService rejects stale/recovered sources and existing targets without changing them', async t => {
  const { rootPath, store } = await createStore(t);
  const source = await createSource(store);
  const oldRevisionId = source.revisionId;
  const changedRaw = JSON.parse(serializeServiceProject(source.project));
  changedRaw.title = 'Changed source';
  const changed = await store.save(changedRaw, {
    expectedRevisionId: source.revisionId,
    reason: 'source-change'
  });
  await assert.rejects(
    store.planNextService(source.project.id, planOptions(oldRevisionId)),
    expectCode('PROJECT_CONFLICT')
  );

  const existing = await store.create({
    id: 'service-2026-08-02',
    title: 'Existing target',
    serviceDate: '2026-08-02',
    profileId: 'main-sanctuary'
  });
  const existingBytes = serializeServiceProject(existing.project);
  await assert.rejects(
    store.planNextService(source.project.id, planOptions(changed.revisionId)),
    expectCode('PROJECT_CONFLICT')
  );
  assert.equal(
    serializeServiceProject((await store.read(existing.project.id)).project),
    existingBytes
  );

  await fs.unlink(path.join(
    projectDirectory(rootPath, changed.project.id),
    'current.json'
  ));
  await assert.rejects(
    store.planNextService(changed.project.id, planOptions(changed.revisionId, {
      id: 'service-2026-08-09',
      serviceDate: '2026-08-09'
    })),
    expectCode('SERVICE_PLAN_SOURCE_RECOVERY_REQUIRED')
  );
});

test('planNextService rejects missing, tampered, symlinked, and metadata-drifted images before publication', async t => {
  for (const failure of ['missing', 'tampered', 'symlink', 'metadata']) {
    await t.test(failure, async t => {
      const imageState = {
        format: 'png',
        width: 64,
        height: 36,
        orientation: 1,
        pages: 1
      };
      const { rootPath, store } = await createStore(t, { imageState });
      let source = await createSource(store, { id: `source-${failure}` });
      source = await addRetainedImage(store, rootPath, source);
      const asset = Object.values(source.project.assets)[0];
      const sourcePath = path.join(
        projectDirectory(rootPath, source.project.id),
        'assets',
        asset.storedName
      );
      if (failure === 'missing') {
        await fs.unlink(sourcePath);
      } else if (failure === 'tampered') {
        const bytes = await fs.readFile(sourcePath);
        bytes[bytes.length - 1] ^= 0xff;
        await fs.writeFile(sourcePath, bytes);
      } else if (failure === 'symlink') {
        const replacement = path.join(rootPath, 'replacement.png');
        await fs.writeFile(replacement, pngBytes('replacement'));
        await fs.unlink(sourcePath);
        await fs.symlink(replacement, sourcePath);
      } else {
        imageState.width = 65;
      }
      const targetId = `target-${failure}`;
      await assert.rejects(
        store.planNextService(source.project.id, planOptions(source.revisionId, {
          id: targetId
        })),
        error => {
          assert.ok(['ASSET_CORRUPT', 'INVALID_IMAGE'].includes(error?.code), error?.stack);
          return true;
        }
      );
      await assert.rejects(store.read(targetId), expectCode('PROJECT_NOT_FOUND'));
      const targetAssets = path.join(projectDirectory(rootPath, targetId), 'assets');
      assert.equal(
        (await fs.readdir(targetAssets)).some(name => name.startsWith('.plan-')),
        false
      );
    });
  }
});

test('planNextService reuses an exact target blob but never overwrites a conflicting one', async t => {
  const { rootPath, store } = await createStore(t);
  let source = await createSource(store);
  source = await addRetainedImage(store, rootPath, source);
  const asset = Object.values(source.project.assets)[0];
  const sourcePath = path.join(
    projectDirectory(rootPath, source.project.id),
    'assets',
    asset.storedName
  );
  const targetAssetsPath = path.join(
    projectDirectory(rootPath, 'service-2026-08-02'),
    'assets'
  );
  await fs.mkdir(targetAssetsPath, { recursive: true });
  const targetPath = path.join(targetAssetsPath, asset.storedName);
  await fs.copyFile(sourcePath, targetPath);
  const before = await fs.stat(targetPath);
  const planned = await store.planNextService(
    source.project.id,
    planOptions(source.revisionId)
  );
  const after = await fs.stat(targetPath);
  assert.equal(after.ino, before.ino);
  assert.equal(planned.project.assets[asset.id].sha256, asset.sha256);

  const secondTargetId = 'service-2026-08-09';
  const corruptAssetsPath = path.join(
    projectDirectory(rootPath, secondTargetId),
    'assets'
  );
  await fs.mkdir(corruptAssetsPath, { recursive: true });
  const corruptPath = path.join(corruptAssetsPath, asset.storedName);
  const corruptBytes = Buffer.alloc(asset.size, 0x41);
  await fs.writeFile(corruptPath, corruptBytes);
  await assert.rejects(
    store.planNextService(source.project.id, planOptions(source.revisionId, {
      id: secondTargetId,
      serviceDate: '2026-08-09'
    })),
    expectCode('ASSET_CORRUPT')
  );
  assert.deepEqual(await fs.readFile(corruptPath), corruptBytes);
  await assert.rejects(store.read(secondTargetId), expectCode('PROJECT_NOT_FOUND'));
});

test('planNextService respects the target write lock and succeeds after its owner releases it', async t => {
  const { rootPath, store } = await createStore(t);
  const source = await createSource(store);
  const targetId = 'service-2026-08-02';
  const targetDirectory = path.join(rootPath, projectStorageKey(targetId));
  await fs.mkdir(targetDirectory, { recursive: true });
  await withExclusiveFileLock(path.join(targetDirectory, '.write-lock'), async () => {
    await assert.rejects(
      store.planNextService(
        source.project.id,
        planOptions(source.revisionId, { id: targetId })
      ),
      expectCode('WRITE_LOCKED')
    );
  });
  const planned = await store.planNextService(
    source.project.id,
    planOptions(source.revisionId, { id: targetId })
  );
  assert.equal(planned.project.revision, 1);
});

test('planNextService holds the source write lock through target pointer publication', async t => {
  const { store } = await createStore(t);
  const source = await createSource(store);
  const targetId = 'service-2026-08-02';
  const originalWritePointer = store._writePointer.bind(store);
  let releaseTargetPointer;
  let reachedTargetPointer;
  const targetPointerReached = new Promise(resolve => { reachedTargetPointer = resolve; });
  const targetPointerReleased = new Promise(resolve => { releaseTargetPointer = resolve; });
  store._writePointer = async (projectDirectory, pointer, previousPointer) => {
    if (pointer.projectId === targetId) {
      reachedTargetPointer();
      await targetPointerReleased;
    }
    return originalWritePointer(projectDirectory, pointer, previousPointer);
  };

  const planning = store.planNextService(
    source.project.id,
    planOptions(source.revisionId, { id: targetId })
  );
  await targetPointerReached;
  const changedSource = JSON.parse(serializeServiceProject(source.project));
  changedSource.title = 'Blocked concurrent source edit';
  try {
    await assert.rejects(
      store.save(changedSource, {
        expectedRevisionId: source.revisionId,
        reason: 'concurrent-source-edit'
      }),
      expectCode('WRITE_LOCKED')
    );
  } finally {
    releaseTargetPointer();
  }

  const planned = await planning;
  assert.equal(planned.project.id, targetId);
  assert.equal((await store.read(source.project.id)).revisionId, source.revisionId);
});

test('planNextService snapshots caller input before awaits and cannot escape its target lock', async t => {
  const { store } = await createStore(t);
  const source = await createSource(store);
  const request = planOptions(source.revisionId);
  const originalEnsure = store._ensureProjectDirectories.bind(store);
  let releaseTarget;
  let reachedTarget;
  let paused = false;
  const targetReached = new Promise(resolve => { reachedTarget = resolve; });
  const targetReleased = new Promise(resolve => { releaseTarget = resolve; });
  store._ensureProjectDirectories = async projectId => {
    const result = await originalEnsure(projectId);
    if (!paused && projectId === request.id) {
      paused = true;
      reachedTarget();
      await targetReleased;
    }
    return result;
  };

  const planning = store.planNextService(source.project.id, request);
  await targetReached;
  request.id = 'redirected-after-lock-selection';
  request.title = 'Redirected title';
  releaseTarget();
  const planned = await planning;
  assert.equal(planned.project.id, 'service-2026-08-02');
  assert.equal(planned.project.title, 'Sunday Service — August 2');
  await assert.rejects(
    store.read('redirected-after-lock-selection'),
    expectCode('PROJECT_NOT_FOUND')
  );
});

test('planNextService rolls back its revision and copied blobs when pointer publication fails', async t => {
  const { rootPath, store } = await createStore(t);
  let source = await createSource(store);
  source = await addRetainedImage(store, rootPath, source);
  const originalWritePointer = store._writePointer.bind(store);
  store._writePointer = async () => {
    throw new Error('injected pointer failure');
  };
  await assert.rejects(
    store.planNextService(source.project.id, planOptions(source.revisionId)),
    /injected pointer failure/
  );
  const targetDirectory = projectDirectory(rootPath, 'service-2026-08-02');
  assert.deepEqual(await fs.readdir(path.join(targetDirectory, 'revisions')), []);
  assert.deepEqual(
    (await fs.readdir(path.join(targetDirectory, 'assets')))
      .filter(name => !name.startsWith('.')),
    []
  );
  await assert.rejects(
    store.read('service-2026-08-02'),
    expectCode('PROJECT_NOT_FOUND')
  );

  store._writePointer = originalWritePointer;
  const retry = await store.planNextService(
    source.project.id,
    planOptions(source.revisionId)
  );
  assert.equal(retry.project.revision, 1);
});

test('planNextService revalidates current source immediately before target pointer publication', async t => {
  const { rootPath, store } = await createStore(t);
  let source = await createSource(store);
  source = await addRetainedImage(store, rootPath, source);
  const originalRead = store._readExactCurrentPlanSource.bind(store);
  let reads = 0;
  store._readExactCurrentPlanSource = async (...args) => {
    reads += 1;
    if (reads === 3) {
      const current = await store.read(source.project.id);
      const raw = JSON.parse(serializeServiceProject(current.project));
      raw.title = 'Source advanced during planning';
      await store._saveUnderLock(raw, {
        expectedRevisionId: current.revisionId,
        reason: 'race-source-forward'
      });
    }
    return originalRead(...args);
  };

  await assert.rejects(
    store.planNextService(source.project.id, planOptions(source.revisionId)),
    expectCode('PROJECT_CONFLICT')
  );
  const targetId = 'service-2026-08-02';
  await assert.rejects(store.read(targetId), expectCode('PROJECT_NOT_FOUND'));
  const targetDirectory = projectDirectory(rootPath, targetId);
  assert.deepEqual(await fs.readdir(path.join(targetDirectory, 'revisions')), []);
  assert.deepEqual(
    (await fs.readdir(path.join(targetDirectory, 'assets')))
      .filter(name => !name.startsWith('.')),
    []
  );
});

test('planNextService rejects noncanonical exact revisions and PowerPoint companions', async t => {
  const { rootPath, store } = await createStore(t);
  const source = await createSource(store);
  const sourceDirectory = projectDirectory(rootPath, source.project.id);
  const canonicalPath = path.join(sourceDirectory, 'revisions', `${source.revisionId}.json`);
  const noncanonical = (await fs.readFile(canonicalPath, 'utf8')).replace('{\n', '{  \n');
  const noncanonicalRevisionId = crypto.createHash('sha256')
    .update(noncanonical)
    .digest('hex');
  await fs.writeFile(
    path.join(sourceDirectory, 'revisions', `${noncanonicalRevisionId}.json`),
    noncanonical
  );
  const pointerPath = path.join(sourceDirectory, 'current.json');
  const pointer = JSON.parse(await fs.readFile(pointerPath, 'utf8'));
  pointer.revisionId = noncanonicalRevisionId;
  await fs.writeFile(pointerPath, `${JSON.stringify(pointer, null, 2)}\n`);
  await assert.rejects(
    store.planNextService(
      source.project.id,
      planOptions(noncanonicalRevisionId)
    ),
    expectCode('PROJECT_REVISION_NONCANONICAL')
  );

  const companion = await createSource(store, {
    id: 'powerpoint-companion',
    prepareProject(project) {
      return bindProjectAsPowerPointCompanion(
        addGroupItem(project, {
          id: 'sermon-anchor',
          title: 'Sermon',
          groupKind: 'sermon',
          now: NOW
        }),
        {
          id: 'service-set-2026-07-26',
          fingerprint: 'f'.repeat(64),
          serviceDate: '2026-07-26',
          profileId: 'main-sanctuary'
        }
      );
    }
  });
  await assert.rejects(
    store.planNextService(companion.project.id, planOptions(companion.revisionId, {
      id: 'companion-target'
    })),
    expectCode('SERVICE_PLAN_SOURCE_NOT_NATIVE')
  );
});
