'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');

const {
  LocalSermonLibrary
} = require('../src/services/sermon/LocalSermonLibrary');
const {
  SermonProjectCommitCoordinator
} = require('../src/services/sermon/SermonProjectCommitCoordinator');
const {
  addGroupItem,
  addSermonResource,
  setSermonSourceLink
} = require('../src/services/project/ServiceProject');
const {
  ServiceProjectStore
} = require('../src/services/project/ServiceProjectStore');

async function tempDirectory(t, prefix = 'syncshow-sermon-commit-') {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return fs.realpath(directory);
}

function sermonDocument(
  title = 'The Prayer That Transforms the Church',
  { bodyText = null } = {}
) {
  const document = {
    schemaVersion: bodyText === null ? 2 : 3,
    kind: 'syncshow-sermon',
    id: 'sermon-prayer',
    titles: { en: title },
    defaultLanguage: 'en',
    speaker: { id: null, name: 'Pastor Example' },
    serviceDate: '2026-07-26',
    series: null,
    outline: [],
    sources: [],
    references: [{
      id: 'primary-eph-3-14-21',
      range: {
        schemaVersion: 1,
        bookId: 'Eph',
        start: { chapter: 3, verse: 14 },
        end: { chapter: 3, verse: 21 }
      },
      role: 'primary',
      source: 'pastor',
      reviewStatus: 'confirmed',
      enteredText: 'Ephesians 3:14-21',
      sourceId: null,
      sectionId: null,
      startOffset: null,
      endOffset: null
    }],
    media: [],
    publication: {
      status: 'draft',
      visibility: 'private',
      publishedAt: null,
      canonicalUrl: null
    }
  };
  if (bodyText !== null) {
    document.body = [{
      id: 'reviewed-manuscript-en',
      kind: 'manuscript',
      language: 'en',
      sourceId: null,
      sectionId: null,
      text: bodyText
    }];
  }
  return document;
}

async function fixture(t) {
  const root = await tempDirectory(t);
  const sermonLibrary = new LocalSermonLibrary({
    rootPath: path.join(root, 'sermons')
  });
  const projectStore = new ServiceProjectStore({
    rootPath: path.join(root, 'projects'),
    randomUUID: () => 'fixture-project'
  });
  const originalSermon = await sermonLibrary.saveDocument(sermonDocument(
    'The Prayer That Transforms the Church',
    { bodyText: 'Original reviewed manuscript body.' }
  ), {
    expectedRevision: null
  });
  const created = await projectStore.create({
    id: 'service-july-26',
    title: 'July 26 Service',
    serviceDate: '2026-07-26',
    profileId: 'main-sanctuary'
  });
  let project = addGroupItem(created.project, {
    id: 'sermon-owner',
    title: 'Sermon',
    groupKind: 'sermon'
  });
  const originalResource = addSermonResource(project, originalSermon.sermon, {
    provider: 'local-sermon-library',
    itemId: originalSermon.sermon.id,
    revision: originalSermon.revision
  });
  project = setSermonSourceLink(originalResource.project, {
    itemId: 'sermon-owner',
    sermonResourceId: originalResource.resourceId
  });
  const linked = await projectStore.save(project, {
    expectedRevisionId: created.revisionId,
    reason: 'link-sermon'
  });
  const reviewedDocument = sermonDocument(
    'Reviewed Prayer That Transforms the Church',
    { bodyText: 'Final reviewed manuscript body committed with the service.' }
  );
  const reviewedResource = addSermonResource(linked.project, reviewedDocument, {
    provider: 'local-sermon-library',
    itemId: reviewedDocument.id
  });
  const repinned = setSermonSourceLink(reviewedResource.project, {
    itemId: 'sermon-owner',
    sermonResourceId: reviewedResource.resourceId
  });
  return {
    root,
    sermonLibrary,
    projectStore,
    originalSermon,
    linked,
    reviewedDocument,
    reviewedResource,
    repinned
  };
}

function coordinator(values, overrides = {}) {
  return new SermonProjectCommitCoordinator({
    rootPath: path.join(values.root, 'transactions'),
    projectStore: values.projectStore,
    sermonLibrary: values.sermonLibrary,
    clock: () => new Date('2026-07-27T23:00:00.000Z'),
    ...overrides
  });
}

function commitRequest(values) {
  return {
    project: values.repinned,
    expectedProjectRevisionId: values.linked.revisionId,
    sermonDocument: values.reviewedDocument,
    expectedSermonRevision: values.originalSermon.revision,
    resourceId: values.reviewedResource.resourceId,
    resourceOwnerId: 'sermon-owner',
    reason: 'apply-sermon-extraction'
  };
}

test('commit saves the exact service pin before promoting the sermon pointer', async t => {
  const values = await fixture(t);
  const result = await coordinator(values).commit(commitRequest(values));

  assert.equal(result.project.project.items['sermon-owner'].sermonResourceId,
    values.reviewedResource.resourceId);
  assert.equal(result.sermon.revision, values.reviewedResource.resourceId.slice(7));
  assert.deepEqual(result.sermon.sermon.body, values.reviewedDocument.body);
  assert.deepEqual(
    result.project.project.resources[values.reviewedResource.resourceId].document.body,
    values.reviewedDocument.body
  );
  assert.equal(
    (await values.sermonLibrary.readCurrent(values.originalSermon.sermon.id)).revision,
    result.sermon.revision
  );
  assert.deepEqual(
    (await values.sermonLibrary.readCurrent(values.originalSermon.sermon.id)).sermon.body,
    values.reviewedDocument.body
  );
  await assert.rejects(
    fs.stat(path.join(values.root, 'transactions', 'pending-sermon-project.json')),
    error => error.code === 'ENOENT'
  );
});

test('commit can atomically create a new sermon packet and its first service pin', async t => {
  const root = await tempDirectory(t, 'syncshow-new-sermon-commit-');
  const sermonLibrary = new LocalSermonLibrary({
    rootPath: path.join(root, 'sermons')
  });
  const projectStore = new ServiceProjectStore({
    rootPath: path.join(root, 'projects'),
    randomUUID: () => 'new-sermon-project'
  });
  const created = await projectStore.create({
    id: 'service-new-sermon',
    title: 'Sunday Service',
    serviceDate: '2026-07-26',
    profileId: 'main-sanctuary'
  });
  let project = addGroupItem(created.project, {
    id: 'sermon-owner',
    title: 'Sermon',
    groupKind: 'sermon'
  });
  const document = sermonDocument('A Newly Created Packet');
  const pinned = addSermonResource(project, document, {
    provider: 'local-sermon-library',
    itemId: document.id
  });
  project = setSermonSourceLink(pinned.project, {
    itemId: 'sermon-owner',
    sermonResourceId: pinned.resourceId
  });
  const instance = new SermonProjectCommitCoordinator({
    rootPath: path.join(root, 'transactions'),
    projectStore,
    sermonLibrary
  });

  const result = await instance.commit({
    project,
    expectedProjectRevisionId: created.revisionId,
    sermonDocument: document,
    expectedSermonRevision: null,
    resourceId: pinned.resourceId,
    resourceOwnerId: 'sermon-owner',
    reason: 'create-sermon-packet'
  });

  assert.equal(
    result.project.project.items['sermon-owner'].sermonResourceId,
    pinned.resourceId
  );
  assert.equal(result.sermon.revision, pinned.resourceId.slice(7));
  assert.equal(
    (await sermonLibrary.readCurrent(document.id)).revision,
    pinned.resourceId.slice(7)
  );
});

test('restart recovery can promote a newly created sermon after its service commit', async t => {
  const root = await tempDirectory(t, 'syncshow-new-sermon-recovery-');
  const sermonLibrary = new LocalSermonLibrary({
    rootPath: path.join(root, 'sermons')
  });
  const projectStore = new ServiceProjectStore({
    rootPath: path.join(root, 'projects'),
    randomUUID: () => 'new-sermon-recovery-project'
  });
  const created = await projectStore.create({
    id: 'service-new-sermon-recovery',
    title: 'Sunday Service',
    serviceDate: '2026-07-26',
    profileId: 'main-sanctuary'
  });
  let project = addGroupItem(created.project, {
    id: 'sermon-owner',
    title: 'Sermon',
    groupKind: 'sermon'
  });
  const document = sermonDocument('A Newly Recovered Packet');
  const pinned = addSermonResource(project, document, {
    provider: 'local-sermon-library',
    itemId: document.id
  });
  project = setSermonSourceLink(pinned.project, {
    itemId: 'sermon-owner',
    sermonResourceId: pinned.resourceId
  });
  const interruptedLibrary = {
    readCurrent: (...args) => sermonLibrary.readCurrent(...args),
    readRevision: (...args) => sermonLibrary.readRevision(...args),
    stageDocument: (...args) => sermonLibrary.stageDocument(...args),
    promoteRevision() {
      const error = new Error('simulated process interruption');
      error.code = 'SIMULATED_CRASH';
      throw error;
    }
  };
  const transactionRoot = path.join(root, 'transactions');
  const interrupted = new SermonProjectCommitCoordinator({
    rootPath: transactionRoot,
    projectStore,
    sermonLibrary: interruptedLibrary
  });

  await assert.rejects(
    interrupted.commit({
      project,
      expectedProjectRevisionId: created.revisionId,
      sermonDocument: document,
      expectedSermonRevision: null,
      resourceId: pinned.resourceId,
      resourceOwnerId: 'sermon-owner',
      reason: 'create-sermon-packet'
    }),
    /simulated process interruption/
  );
  assert.equal(
    (await projectStore.read(project.id)).project.items['sermon-owner'].sermonResourceId,
    pinned.resourceId
  );
  await assert.rejects(
    sermonLibrary.readCurrent(document.id),
    error => error.code === 'SERMON_NOT_FOUND'
  );

  const recovered = await new SermonProjectCommitCoordinator({
    rootPath: transactionRoot,
    projectStore,
    sermonLibrary
  }).recover();
  assert.equal(recovered.projectCommitted, true);
  assert.equal(recovered.sermonCurrent, true);
  assert.equal(
    (await sermonLibrary.readCurrent(document.id)).revision,
    pinned.resourceId.slice('sha256:'.length)
  );
});

test('project CAS failure leaves the sermon pointer unchanged and a retry can commit', async t => {
  const values = await fixture(t);
  const advanced = addGroupItem(values.linked.project, {
    id: 'concurrent-note',
    title: 'Concurrent note',
    groupKind: 'section'
  });
  await values.projectStore.save(advanced, {
    expectedRevisionId: values.linked.revisionId,
    reason: 'concurrent-edit'
  });
  const instance = coordinator(values);

  await assert.rejects(
    instance.commit(commitRequest(values)),
    error => error.code === 'PROJECT_CONFLICT'
  );
  assert.equal(
    (await values.sermonLibrary.readCurrent(values.originalSermon.sermon.id)).revision,
    values.originalSermon.revision
  );
  assert.equal(
    (await values.sermonLibrary.readRevision(
      values.originalSermon.sermon.id,
      values.reviewedResource.resourceId.slice(7)
    )).sermon.titles.en,
    values.reviewedDocument.titles.en,
    'the immutable staged revision remains recoverable without becoming current'
  );

  const currentProject = await values.projectStore.read(values.linked.project.id);
  const retryResource = addSermonResource(
    currentProject.project,
    values.reviewedDocument,
    {
      provider: 'local-sermon-library',
      itemId: values.reviewedDocument.id
    }
  );
  const retryProject = setSermonSourceLink(retryResource.project, {
    itemId: 'sermon-owner',
    sermonResourceId: retryResource.resourceId
  });
  const retried = await instance.commit({
    project: retryProject,
    expectedProjectRevisionId: currentProject.revisionId,
    sermonDocument: values.reviewedDocument,
    expectedSermonRevision: values.originalSermon.revision,
    resourceId: retryResource.resourceId,
    resourceOwnerId: 'sermon-owner',
    reason: 'attach-sermon-source'
  });

  assert.ok(retried.project.project.items['concurrent-note']);
  assert.equal(
    retried.project.project.items['sermon-owner'].sermonResourceId,
    retryResource.resourceId
  );
  assert.equal(
    (await values.sermonLibrary.readCurrent(values.originalSermon.sermon.id)).revision,
    retryResource.resourceId.slice(7)
  );
});

test('a pre-write project failure cannot be mistaken for the complete requested commit', async t => {
  const values = await fixture(t);
  const alreadyPinned = await values.projectStore.save(values.repinned, {
    expectedRevisionId: values.linked.revisionId,
    reason: 'pin-before-transaction'
  });
  const desiredProject = addGroupItem(alreadyPinned.project, {
    id: 'desired-project-change',
    title: 'Must survive the transaction',
    groupKind: 'section'
  });
  const failingProjectStore = {
    read: (...args) => values.projectStore.read(...args),
    async save() {
      const error = new Error('simulated definite pre-write failure');
      error.code = 'SIMULATED_PREWRITE_FAILURE';
      throw error;
    }
  };
  const instance = coordinator(values, { projectStore: failingProjectStore });

  await assert.rejects(
    instance.commit({
      project: desiredProject,
      expectedProjectRevisionId: alreadyPinned.revisionId,
      sermonDocument: values.reviewedDocument,
      expectedSermonRevision: values.originalSermon.revision,
      resourceId: values.reviewedResource.resourceId,
      resourceOwnerId: 'sermon-owner',
      reason: 'project-hash-regression'
    }),
    error => error.code === 'SIMULATED_PREWRITE_FAILURE'
  );

  const currentProject = await values.projectStore.read(alreadyPinned.project.id);
  assert.equal(currentProject.project.items['desired-project-change'], undefined);
  assert.equal(
    (await values.sermonLibrary.readCurrent(values.originalSermon.sermon.id)).revision,
    values.originalSermon.revision,
    'the sermon pointer must not advance when the whole intended project was not saved'
  );
});

test('restart recovery promotes a staged revision after the project commit won', async t => {
  const values = await fixture(t);
  let interruptPromotion = true;
  const interruptedLibrary = {
    readCurrent: (...args) => values.sermonLibrary.readCurrent(...args),
    readRevision: (...args) => values.sermonLibrary.readRevision(...args),
    stageDocument: (...args) => values.sermonLibrary.stageDocument(...args),
    promoteRevision: (...args) => {
      if (interruptPromotion) {
        const error = new Error('simulated process interruption');
        error.code = 'SIMULATED_CRASH';
        throw error;
      }
      return values.sermonLibrary.promoteRevision(...args);
    }
  };
  const interrupted = coordinator(values, { sermonLibrary: interruptedLibrary });
  await assert.rejects(
    interrupted.commit(commitRequest(values)),
    /simulated process interruption/
  );
  assert.equal(
    (await values.sermonLibrary.readCurrent(values.originalSermon.sermon.id)).revision,
    values.originalSermon.revision
  );
  assert.equal(
    (await values.projectStore.read(values.linked.project.id)).project
      .items['sermon-owner'].sermonResourceId,
    values.reviewedResource.resourceId
  );

  interruptPromotion = false;
  const recovered = await coordinator(values).recover();
  assert.equal(recovered.recovered, true);
  assert.equal(recovered.projectCommitted, true);
  assert.equal(recovered.sermonCurrent, true);
  assert.match(recovered.message, /completed a sermon-library pointer update/);
  assert.equal(
    (await values.sermonLibrary.readCurrent(values.originalSermon.sermon.id)).revision,
    values.reviewedResource.resourceId.slice(7)
  );
});

test('restart recovery preserves a sermon edit that wins the promotion CAS race', async t => {
  const values = await fixture(t);
  const interruptedLibrary = {
    readCurrent: (...args) => values.sermonLibrary.readCurrent(...args),
    readRevision: (...args) => values.sermonLibrary.readRevision(...args),
    stageDocument: (...args) => values.sermonLibrary.stageDocument(...args),
    promoteRevision() {
      const error = new Error('simulated process interruption');
      error.code = 'SIMULATED_CRASH';
      throw error;
    }
  };
  await assert.rejects(
    coordinator(values, { sermonLibrary: interruptedLibrary })
      .commit(commitRequest(values)),
    /simulated process interruption/
  );

  let raced = false;
  const racingLibrary = {
    readCurrent: (...args) => values.sermonLibrary.readCurrent(...args),
    readRevision: (...args) => values.sermonLibrary.readRevision(...args),
    stageDocument: (...args) => values.sermonLibrary.stageDocument(...args),
    async promoteRevision(...args) {
      if (!raced) {
        raced = true;
        await values.sermonLibrary.saveDocument(
          sermonDocument('A Newer Edit During Restart Recovery'),
          {
            expectedSermonId: values.originalSermon.sermon.id,
            expectedRevision: values.originalSermon.revision
          }
        );
      }
      return values.sermonLibrary.promoteRevision(...args);
    }
  };
  const recovered = await coordinator(values, { sermonLibrary: racingLibrary })
    .recover();

  assert.equal(raced, true);
  assert.equal(recovered.recovered, true);
  assert.equal(recovered.projectCommitted, true);
  assert.equal(recovered.sermonCurrent, false);
  assert.match(recovered.message, /did not overwrite that edit/);
  assert.equal(
    (await values.sermonLibrary.readCurrent(values.originalSermon.sermon.id))
      .sermon.titles.en,
    'A Newer Edit During Restart Recovery'
  );
  assert.equal(
    (await values.projectStore.read(values.linked.project.id)).project
      .items['sermon-owner'].sermonResourceId,
    values.reviewedResource.resourceId
  );
  await assert.rejects(
    fs.stat(path.join(values.root, 'transactions', 'pending-sermon-project.json')),
    error => error.code === 'ENOENT'
  );
});

test('concurrent startup recovery requests serialize without surfacing a file-lock error', async t => {
  const values = await fixture(t);
  const instance = coordinator(values);
  const originalReadJournal = instance._readJournal.bind(instance);
  let readCount = 0;
  let releaseFirstRead;
  let markFirstReadStarted;
  const firstReadGate = new Promise(resolve => {
    releaseFirstRead = resolve;
  });
  const firstReadStarted = new Promise(resolve => {
    markFirstReadStarted = resolve;
  });
  instance._readJournal = async () => {
    readCount += 1;
    if (readCount === 1) {
      markFirstReadStarted();
      await firstReadGate;
    }
    return originalReadJournal();
  };

  const first = instance.recover();
  await firstReadStarted;
  const second = instance.recover();
  await Promise.resolve();
  releaseFirstRead();

  const results = await Promise.all([first, second]);
  assert.equal(readCount, 2);
  assert.deepEqual(
    results.map(result => result.recovered),
    [false, false]
  );
});

test('a newer concurrent sermon edit is preserved after the service pins the reviewed revision', async t => {
  const values = await fixture(t);
  const projectStore = {
    read: (...args) => values.projectStore.read(...args),
    async save(...args) {
      const saved = await values.projectStore.save(...args);
      const concurrent = sermonDocument('A Newer Independent Sermon Edit');
      await values.sermonLibrary.saveDocument(concurrent, {
        expectedSermonId: values.originalSermon.sermon.id,
        expectedRevision: values.originalSermon.revision
      });
      return saved;
    }
  };
  const result = await coordinator(values, { projectStore }).commit(commitRequest(values));

  assert.equal(result.recovery?.sermonCurrent, false);
  assert.match(result.recovery?.message, /preserved that newer edit/);
  assert.equal(
    (await values.sermonLibrary.readCurrent(values.originalSermon.sermon.id)).sermon.titles.en,
    'A Newer Independent Sermon Edit'
  );
  assert.equal(
    result.project.project.items['sermon-owner'].sermonResourceId,
    values.reviewedResource.resourceId
  );
});
