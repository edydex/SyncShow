'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');

const {
  addGroupItem,
  addProjectItem,
  addSermonResource,
  bindProjectAsPowerPointCompanion,
  createServiceProject,
  deriveSermonServiceRelationship,
  resolveSermonSourceLink,
  setSermonSourceLink
} = require('../src/services/project/ServiceProject');
const {
  MAX_SERMON_RELATIONSHIP_PAGE_SIZE,
  ProjectStoreError,
  ServiceProjectStore,
  projectStorageKey
} = require('../src/services/project/ServiceProjectStore');

const NOW = '2026-07-26T16:00:00.000Z';
const SERMON_ID = 'sermon-2026-07-26-prayer';

async function tempDirectory(t, prefix = 'syncshow-sermon-services-') {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return fs.realpath(directory);
}

function sermon(overrides = {}) {
  return {
    schemaVersion: 2,
    kind: 'syncshow-sermon',
    id: SERMON_ID,
    titles: { en: 'The Prayer That Transforms the Church' },
    defaultLanguage: 'en',
    speaker: { id: null, name: 'Pastor Example' },
    serviceDate: '2026-07-26',
    series: null,
    outline: [{
      id: 'foundation',
      parentId: null,
      kind: 'section',
      titles: { en: 'The Foundation of the Prayer' }
    }],
    sources: [{
      id: 'private-manuscript',
      kind: 'manuscript',
      fileName: 'pastor-private-manuscript.pdf',
      mediaType: 'application/pdf',
      languages: ['en'],
      sha256: 'a'.repeat(64),
      sizeBytes: 4096,
      provenance: {
        providedBy: 'Pastor Example',
        receivedAt: '2026-07-25T18:00:00.000Z',
        sourceSystem: 'operator',
        externalId: ''
      }
    }],
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
      sourceId: 'private-manuscript',
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
    },
    ...overrides
  };
}

function project(options = {}) {
  return createServiceProject({
    id: options.id || 'service-2026-07-26',
    title: options.title || 'Sunday Service',
    serviceDate: options.serviceDate || '2026-07-26',
    profileId: options.profileId || 'main-sanctuary',
    now: options.now || NOW
  });
}

function addNativeSermonRelationship(rawProject, document = sermon(), options = {}) {
  const pinned = addSermonResource(rawProject, document, {
    provider: 'local-sermon-library',
    itemId: document.id,
    revision: 'local-current'
  });
  let next = addGroupItem(pinned.project, {
    id: options.outerId || 'sermon-outer',
    title: options.outerTitle || 'Sermon',
    groupKind: 'sermon',
    now: options.now || NOW
  });
  next = addGroupItem(next, {
    id: options.ownerId || 'sermon-owner',
    title: options.ownerTitle || 'Sermon source',
    groupKind: 'point',
    sermonResourceId: pinned.resourceId,
    parentId: options.outerId || 'sermon-outer',
    now: options.now || NOW
  });
  next = addGroupItem(next, {
    id: options.sectionId || 'sermon-section',
    title: 'Foundation',
    groupKind: 'section',
    parentId: options.ownerId || 'sermon-owner',
    now: options.now || NOW
  });
  next = addProjectItem(next, {
    id: options.leafId || 'sermon-leaf',
    kind: 'sermon',
    title: 'Foundation',
    textByChannel: { primary: 'For this reason I bow my knees…' },
    presetId: 'sermon-point',
    operatorNotes: ''
  }, {
    parentId: options.sectionId || 'sermon-section',
    now: options.now || NOW
  });
  return { project: next, resourceId: pinned.resourceId };
}

function serviceSetBinding(serviceDate = '2026-07-26') {
  return {
    id: `set-${serviceDate}`,
    fingerprint: 'b'.repeat(64),
    serviceDate,
    profileId: 'main-sanctuary'
  };
}

function addCompanionSermonRelationship(rawProject, document = sermon()) {
  let next = addGroupItem(rawProject, {
    id: 'sermon-anchor',
    title: 'Sermon',
    groupKind: 'sermon',
    now: NOW
  });
  next = bindProjectAsPowerPointCompanion(
    next,
    serviceSetBinding(rawProject.serviceDate)
  );
  const pinned = addSermonResource(next, document, {
    provider: 'local-sermon-library',
    itemId: document.id,
    revision: 'local-current'
  });
  next = setSermonSourceLink(pinned.project, {
    itemId: 'sermon-anchor',
    sermonResourceId: pinned.resourceId,
    now: NOW
  });
  return { project: next, resourceId: pinned.resourceId };
}

async function createLinkedProject(store, options = {}) {
  const document = sermon({
    id: options.sermonId || SERMON_ID,
    titles: { en: options.sermonTitle || 'The Prayer That Transforms the Church' },
    serviceDate: options.serviceDate || '2026-07-26'
  });
  let resourceId = null;
  const created = await store.create({
    id: options.id,
    title: options.title,
    serviceDate: options.serviceDate,
    profileId: 'main-sanctuary'
  }, {
    prepareProject(draft) {
      const linked = options.companion
        ? addCompanionSermonRelationship(draft, document)
        : addNativeSermonRelationship(draft, document);
      resourceId = linked.resourceId;
      return linked.project;
    }
  });
  return { ...created, resourceId };
}

test('domain projection deduplicates inherited links and selects a resolvable resource-owner anchor', () => {
  const linked = addNativeSermonRelationship(project());
  const relationship = deriveSermonServiceRelationship(
    linked.project,
    SERMON_ID
  );

  assert.deepEqual(relationship, {
    schemaVersion: 1,
    sermonId: SERMON_ID,
    sermonRevisionId: linked.resourceId.slice('sha256:'.length),
    pinnedSermonRevisionIds: [linked.resourceId.slice('sha256:'.length)],
    projectId: 'service-2026-07-26',
    projectRevision: 0,
    projectTitle: 'Sunday Service',
    serviceDate: '2026-07-26',
    updatedAt: NOW,
    profileId: 'main-sanctuary',
    workflowMode: 'native',
    anchorItemId: 'sermon-owner',
    resourceOwnerId: 'sermon-owner',
    sourceServiceSet: null,
    linkedItemCount: 3,
    resourceOwnerCount: 1
  });
  const resolvedAnchor = resolveSermonSourceLink(
    linked.project,
    linked.project.items[relationship.anchorItemId]
  );
  assert.equal(resolvedAnchor.resourceOwnerId, relationship.resourceOwnerId);
  assert.equal(resolvedAnchor.resourceId, linked.resourceId);
  assert.equal(
    resolvedAnchor.resource.sha256,
    relationship.sermonRevisionId
  );
  assert.equal(
    JSON.stringify(relationship).includes('pastor-private-manuscript.pdf'),
    false
  );
  assert.equal(
    deriveSermonServiceRelationship(linked.project, 'another-sermon'),
    null
  );
});

test('domain projection exposes exact PowerPoint binding without presentation or source data', () => {
  const linked = addCompanionSermonRelationship(project());
  const relationship = deriveSermonServiceRelationship(
    linked.project,
    SERMON_ID
  );

  assert.equal(relationship.workflowMode, 'pptx-companion');
  assert.equal(relationship.anchorItemId, 'sermon-anchor');
  assert.equal(relationship.resourceOwnerId, 'sermon-anchor');
  assert.equal(relationship.sermonRevisionId, linked.resourceId.slice(7));
  assert.deepEqual(
    relationship.sourceServiceSet,
    serviceSetBinding()
  );
  for (const forbiddenKey of [
    'path',
    'filePath',
    'sourcePath',
    'fileName',
    'sources',
    'document',
    'resource'
  ]) {
    assert.equal(Object.hasOwn(relationship, forbiddenKey), false);
  }
  assert.equal(
    JSON.stringify(relationship).includes('pastor-private-manuscript.pdf'),
    false
  );
});

test('one project relationship retains every unusual exact direct-owner revision', () => {
  const first = addNativeSermonRelationship(
    project(),
    sermon({ titles: { en: 'First reviewed revision' } }),
    {
      outerId: 'sermon-a',
      ownerId: 'owner-a',
      sectionId: 'section-a',
      leafId: 'leaf-a'
    }
  );
  const secondDocument = sermon({
    titles: { en: 'Second reviewed revision' }
  });
  const secondPinned = addSermonResource(first.project, secondDocument, {
    provider: 'local-sermon-library',
    itemId: SERMON_ID,
    revision: 'second-current'
  });
  let mixed = addGroupItem(secondPinned.project, {
    id: 'sermon-b',
    title: 'Second sermon segment',
    groupKind: 'sermon',
    sermonResourceId: secondPinned.resourceId,
    now: NOW
  });
  mixed = addProjectItem(mixed, {
    id: 'leaf-b',
    kind: 'sermon',
    title: 'Second segment',
    textByChannel: { primary: 'A second pinned segment.' },
    presetId: 'sermon-point',
    operatorNotes: ''
  }, {
    parentId: 'sermon-b',
    now: NOW
  });

  const relationship = deriveSermonServiceRelationship(mixed, SERMON_ID);
  assert.equal(relationship.resourceOwnerCount, 2);
  assert.equal(relationship.anchorItemId, 'owner-a');
  assert.equal(
    relationship.sermonRevisionId,
    first.resourceId.slice('sha256:'.length)
  );
  assert.deepEqual(relationship.pinnedSermonRevisionIds, [
    first.resourceId.slice('sha256:'.length),
    secondPinned.resourceId.slice('sha256:'.length)
  ]);
});

test('store lists current relationships with bounded stable pagination', async t => {
  const rootPath = await tempDirectory(t);
  const store = new ServiceProjectStore({ rootPath });
  await createLinkedProject(store, {
    id: 'service-july-19',
    title: 'July 19 Service',
    serviceDate: '2026-07-19'
  });
  await createLinkedProject(store, {
    id: 'service-july-26',
    title: 'July 26 Service',
    serviceDate: '2026-07-26',
    companion: true
  });
  await createLinkedProject(store, {
    id: 'service-august-02',
    title: 'August 2 Service',
    serviceDate: '2026-08-02'
  });
  await createLinkedProject(store, {
    id: 'service-other-sermon',
    title: 'Other sermon',
    serviceDate: '2026-08-09',
    sermonId: 'sermon-other'
  });

  const firstPage = await store.listSermonServiceRelationships(
    SERMON_ID,
    { pageSize: 1 }
  );
  assert.equal(firstPage.total, 3);
  assert.deepEqual(firstPage.items.map(item => item.projectId), [
    'service-august-02'
  ]);
  assert.equal(firstPage.offset, 0);
  assert.equal(firstPage.nextOffset, 1);
  assert.match(firstPage.items[0].projectRevisionId, /^[a-f0-9]{64}$/);

  const secondPage = await store.listSermonServiceRelationships(
    SERMON_ID,
    { pageSize: 1, offset: firstPage.nextOffset }
  );
  assert.deepEqual(secondPage.items.map(item => item.projectId), [
    'service-july-26'
  ]);
  assert.equal(secondPage.items[0].workflowMode, 'pptx-companion');
  assert.equal(secondPage.nextOffset, 2);

  const bounded = await store.listSermonServiceRelationships(
    SERMON_ID,
    { pageSize: Number.MAX_SAFE_INTEGER, offset: -100 }
  );
  assert.equal(MAX_SERMON_RELATIONSHIP_PAGE_SIZE, 100);
  assert.equal(bounded.offset, 0);
  assert.equal(bounded.items.length, 3);

  await assert.rejects(
    store.listSermonServiceRelationships('../private'),
    error => {
      assert.ok(error instanceof ProjectStoreError);
      assert.equal(error.code, 'INVALID_SERMON_ID');
      return true;
    }
  );
});

test('store reads only current revisions and preserves corrupt project evidence', async t => {
  const rootPath = await tempDirectory(t);
  const store = new ServiceProjectStore({ rootPath });
  const currentOnly = await createLinkedProject(store, {
    id: 'service-current-only',
    title: 'Current only',
    serviceDate: '2026-07-26',
    sermonId: 'sermon-before-repin'
  });
  const replacement = sermon({
    id: 'sermon-after-repin',
    titles: { en: 'Replacement sermon' }
  });
  const pinned = addSermonResource(currentOnly.project, replacement, {
    provider: 'local-sermon-library',
    itemId: replacement.id,
    revision: 'replacement-current'
  });
  const repinned = setSermonSourceLink(pinned.project, {
    itemId: 'sermon-owner',
    sermonResourceId: pinned.resourceId,
    now: '2026-07-26T17:00:00.000Z'
  });
  const saved = await store.save(repinned, {
    expectedRevisionId: currentOnly.revisionId
  });

  assert.equal(
    (await store.listSermonServiceRelationships('sermon-before-repin')).total,
    0
  );
  const current = await store.listSermonServiceRelationships(
    'sermon-after-repin'
  );
  assert.equal(current.total, 1);
  assert.equal(current.items[0].projectRevisionId, saved.revisionId);
  assert.equal(
    current.items[0].sermonRevisionId,
    pinned.resourceId.slice('sha256:'.length)
  );

  const corrupt = await createLinkedProject(store, {
    id: 'service-corrupt',
    title: 'Corrupt evidence',
    serviceDate: '2026-08-02',
    sermonId: 'sermon-after-repin'
  });
  const corruptDirectory = path.join(
    rootPath,
    projectStorageKey(corrupt.project.id)
  );
  const pointerPath = path.join(corruptDirectory, 'current.json');
  const revisionPath = path.join(
    corruptDirectory,
    'revisions',
    `${corrupt.revisionId}.json`
  );
  const pointerBefore = await fs.readFile(pointerPath);
  const corruptBytes = Buffer.from('{"corrupt":true}\n');
  await fs.writeFile(revisionPath, corruptBytes);

  const afterCorruption = await store.listSermonServiceRelationships(
    'sermon-after-repin'
  );
  assert.deepEqual(afterCorruption.items.map(item => item.projectId), [
    'service-current-only'
  ]);
  assert.deepEqual(await fs.readFile(revisionPath), corruptBytes);
  assert.deepEqual(await fs.readFile(pointerPath), pointerBefore);
});

test('store does not resurrect a prior linked relationship when the current no-link revision is corrupt', async t => {
  const rootPath = await tempDirectory(t);
  const store = new ServiceProjectStore({ rootPath });
  const sermonId = 'sermon-recovered-history';
  const linked = await createLinkedProject(store, {
    id: 'service-recovered-history',
    title: 'Recovered history evidence',
    serviceDate: '2026-07-26',
    sermonId
  });
  const unlinkedProject = setSermonSourceLink(linked.project, {
    itemId: 'sermon-owner',
    sermonResourceId: null,
    now: '2026-07-26T17:00:00.000Z'
  });
  const unlinked = await store.save(unlinkedProject, {
    expectedRevisionId: linked.revisionId
  });
  assert.equal(
    (await store.listSermonServiceRelationships(sermonId)).total,
    0,
    'the checksum-valid current no-link revision must not list the prior relationship'
  );

  const projectDirectory = path.join(
    rootPath,
    projectStorageKey(linked.project.id)
  );
  const pointerPath = path.join(projectDirectory, 'current.json');
  const linkedRevisionPath = path.join(
    projectDirectory,
    'revisions',
    `${linked.revisionId}.json`
  );
  const unlinkedRevisionPath = path.join(
    projectDirectory,
    'revisions',
    `${unlinked.revisionId}.json`
  );
  const pointerBefore = await fs.readFile(pointerPath);
  const linkedRevisionBefore = await fs.readFile(linkedRevisionPath);
  const corruptCurrentBytes = Buffer.from('{"corrupt":true}\n');
  await fs.writeFile(unlinkedRevisionPath, corruptCurrentBytes);

  const afterCorruption = await store.listSermonServiceRelationships(sermonId);
  assert.equal(
    afterCorruption.total,
    0,
    'recovery to the prior linked revision must not become current history'
  );
  assert.deepEqual(await fs.readFile(pointerPath), pointerBefore);
  assert.deepEqual(await fs.readFile(linkedRevisionPath), linkedRevisionBefore);
  assert.deepEqual(
    await fs.readFile(unlinkedRevisionPath),
    corruptCurrentBytes
  );
});
