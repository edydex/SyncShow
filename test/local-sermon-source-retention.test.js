'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');

const {
  LocalSermonExtractionStore,
  LocalSermonLibrary,
  LocalSermonSourceRetention,
  LocalSermonSourceRetentionError,
  LocalSermonSourceStore,
  LocalSermonSourceStoreError,
  SermonProjectCommitCoordinator,
  SERMON_KIND,
  SERMON_SCHEMA_VERSION,
  normalizeSermonDocument
} = require('../src/services/sermon');
const {
  ServiceProjectStore
} = require('../src/services/project/ServiceProjectStore');
const {
  addGroupItem,
  addSermonResource,
  removeProjectItemAndDescendants,
  setSermonSourceLink
} = require('../src/services/project/ServiceProject');

const BASE_SERMON_REVISION = 'b'.repeat(64);
const DAY_MS = 24 * 60 * 60 * 1000;

async function tempDirectory(t, prefix = 'syncshow-source-retention-') {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return fs.realpath(directory);
}

function adjustableClock(iso = '2026-01-01T00:00:00.000Z') {
  let value = new Date(iso);
  return {
    now: () => new Date(value),
    advanceDays(days) {
      value = new Date(value.getTime() + days * DAY_MS);
    }
  };
}

async function storesFor(t, options = {}) {
  const parent = await tempDirectory(t);
  const clock = options.clock || adjustableClock();
  const sourceStore = new LocalSermonSourceStore({
    rootPath: path.join(parent, 'source-objects'),
    ...(options.unlinkObject ? { unlinkObject: options.unlinkObject } : {})
  });
  const sermonLibrary = new LocalSermonLibrary({
    rootPath: path.join(parent, 'sermons'),
    clock: clock.now
  });
  const projectStore = new ServiceProjectStore({
    rootPath: path.join(parent, 'projects'),
    clock: clock.now
  });
  const extractionStore = new LocalSermonExtractionStore({
    rootPath: path.join(parent, 'extractions')
  });
  await Promise.all([
    sourceStore.initialize(),
    sermonLibrary.initialize(),
    projectStore.initialize(),
    extractionStore.initialize()
  ]);
  return {
    parent,
    clock,
    sourceStore,
    sermonLibrary,
    projectStore,
    extractionStore
  };
}

function coordinator(stores, options = {}) {
  return new LocalSermonSourceRetention({
    sourceStore: stores.sourceStore,
    sermonLibrary: stores.sermonLibrary,
    projectStore: stores.projectStore,
    extractionStore: stores.extractionStore,
    clock: stores.clock.now,
    ...options
  });
}

async function importTextSource(stores, name, text) {
  const incoming = path.join(stores.parent, 'incoming');
  await fs.mkdir(incoming, { recursive: true });
  const sourcePath = path.join(incoming, `${name}.txt`);
  await fs.writeFile(sourcePath, text, { mode: 0o600 });
  return stores.sourceStore.importFile({
    sourcePath,
    id: `source-${name}`,
    kind: 'manuscript',
    languages: ['en']
  });
}

function sermonDocument(id, sources = []) {
  return normalizeSermonDocument({
    schemaVersion: SERMON_SCHEMA_VERSION,
    kind: SERMON_KIND,
    id,
    titles: { en: `Sermon ${id}` },
    defaultLanguage: 'en',
    speaker: { id: null, name: 'Pastor' },
    serviceDate: '2026-01-04',
    series: null,
    outline: [],
    sources,
    references: [],
    media: [],
    publication: {
      status: 'draft',
      visibility: 'private',
      publishedAt: null,
      canonicalUrl: null
    }
  });
}

function extractionProposal(source) {
  return {
    schemaVersion: 1,
    kind: 'syncshow-sermon-source-extraction-proposal',
    extractor: {
      id: 'syncshow-retention-test-extractor',
      version: 1
    },
    source: {
      id: source.id,
      sha256: source.sha256,
      kind: source.kind,
      languages: source.languages,
      mediaType: source.mediaType
    },
    units: [{
      id: 'document-1',
      kind: 'document',
      ordinal: 1,
      label: 'Document section 1',
      text: 'Retained extraction evidence',
      truncated: false
    }],
    textPreview: 'Retained extraction evidence',
    suggestionScope: {
      strategy: 'whole-source',
      startUnitId: 'document-1',
      endUnitId: 'document-1',
      startOrdinal: 1,
      endOrdinal: 1
    },
    outlineSuggestions: [],
    scriptureReferenceSuggestions: [],
    truncated: {
      units: false,
      text: false,
      preview: false,
      outlineSuggestions: false,
      scriptureReferences: false
    }
  };
}

async function expectObjectMissing(sourceStore, imported) {
  await assert.rejects(
    sourceStore.checkObject(imported.objectId, { sizeBytes: imported.source.sizeBytes }),
    error => {
      assert.ok(error instanceof LocalSermonSourceStoreError);
      assert.equal(error.code, 'OBJECT_NOT_FOUND');
      return true;
    }
  );
}

function expectRetentionAbort(error) {
  assert.ok(error instanceof LocalSermonSourceRetentionError);
  assert.match(error.code, /^RETENTION_(?:AUDIT|APPLY)_ABORTED$/);
  return true;
}

function assertPathFree(report, stores, imported) {
  const serialized = JSON.stringify(report);
  assert.equal(serialized.includes(stores.parent), false);
  assert.equal(serialized.includes('incoming'), false);
  assert.equal(serialized.includes(imported.source.fileName), false);
  assert.equal(serialized.includes(imported.objectId), false);
  assert.equal(serialized.includes(imported.source.sha256), false);
}

test('historical sermon and project revisions retain sources while aged orphans are deleted after restart', async t => {
  const stores = await storesFor(t);
  const librarySource = await importTextSource(stores, 'library-history', 'library history');
  const projectSource = await importTextSource(stores, 'project-history', 'project history');
  const orphan = await importTextSource(stores, 'aged-orphan', 'aged orphan');

  const firstSermon = await stores.sermonLibrary.saveDocument(
    sermonDocument('retention-library-history', [librarySource.source])
  );
  await stores.sermonLibrary.saveDocument(
    sermonDocument('retention-library-history', []),
    {
      expectedSermonId: 'retention-library-history',
      expectedRevision: firstSermon.revision
    }
  );

  const embedded = sermonDocument('retention-project-history', [projectSource.source]);
  const firstProject = await stores.projectStore.create({
    id: 'retention-project',
    title: 'Retention project',
    serviceDate: '2026-01-04',
    profileId: 'main'
  }, {
    prepareProject(project) {
      const pinned = addSermonResource(project, embedded);
      return addGroupItem(pinned.project, {
        id: 'sermon-group',
        title: 'Sermon',
        groupKind: 'sermon',
        sermonResourceId: pinned.resourceId
      });
    }
  });
  await stores.projectStore.save(
    removeProjectItemAndDescendants(firstProject.project, 'sermon-group'),
    { expectedRevisionId: firstProject.revisionId }
  );

  const firstAudit = await coordinator(stores).audit();
  assert.equal(firstAudit.referencedObjectCount, 2);
  assert.equal(firstAudit.unreferencedObjectCount, 1);
  assert.equal(firstAudit.eligibleObjectCount, 0);
  stores.clock.advanceDays(89);
  assert.equal((await coordinator(stores).audit()).eligibleObjectCount, 0);
  stores.clock.advanceDays(2);
  const aged = await coordinator(stores).audit();
  assert.equal(aged.referencedObjectCount, 2);
  assert.equal(aged.eligibleObjectCount, 1);
  assertPathFree(aged, stores, orphan);

  const scheduled = await coordinator(stores).persistRestartPlan(aged.candidateHash);
  assert.equal(scheduled.requiresRestart, true);
  assertPathFree(scheduled, stores, orphan);
  const restarted = coordinator(stores);
  const applied = await restarted.applyConfirmedStartupPlan();
  assert.equal(applied.applied, true);
  assert.equal(applied.deletedObjectCount, 1);
  assertPathFree(applied, stores, orphan);
  await stores.sourceStore.checkObject(librarySource.objectId);
  await stores.sourceStore.checkObject(projectSource.objectId);
  await expectObjectMissing(stores.sourceStore, orphan);
});

test('validated extraction evidence is a durable source reference by itself', async t => {
  const stores = await storesFor(t);
  const extractionOnly = await importTextSource(stores, 'extraction-only', 'extraction only');
  const orphan = await importTextSource(stores, 'extraction-orphan', 'delete this orphan');
  await stores.extractionStore.saveSnapshot({
    sermonId: 'retention-extraction',
    baseSermonRevisionId: BASE_SERMON_REVISION,
    extraction: extractionProposal(extractionOnly.source)
  });

  await coordinator(stores).audit();
  stores.clock.advanceDays(91);
  const aged = await coordinator(stores).audit();
  assert.equal(aged.referencedObjectCount, 1);
  assert.equal(aged.eligibleObjectCount, 1);
  await coordinator(stores).persistRestartPlan(aged.candidateHash);
  const applied = await coordinator(stores).applyConfirmedStartupPlan();
  assert.equal(applied.deletedObjectCount, 1);
  await stores.sourceStore.checkObject(extractionOnly.objectId);
  await expectObjectMissing(stores.sourceStore, orphan);
});

test('audit recovers a pending sermon-project transaction before collecting references', async t => {
  const stores = await storesFor(t);
  const recoveredSource = await importTextSource(
    stores,
    'pending-transaction',
    'pending transaction source'
  );
  const original = await stores.sermonLibrary.saveDocument(
    sermonDocument('pending-transaction-sermon', [])
  );
  const created = await stores.projectStore.create({
    id: 'pending-transaction-project',
    title: 'Pending transaction project',
    serviceDate: '2026-01-04',
    profileId: 'main'
  });
  let project = addGroupItem(created.project, {
    id: 'transaction-sermon-owner',
    title: 'Sermon',
    groupKind: 'sermon'
  });
  const originalResource = addSermonResource(project, original.sermon);
  project = setSermonSourceLink(originalResource.project, {
    itemId: 'transaction-sermon-owner',
    sermonResourceId: originalResource.resourceId
  });
  const linked = await stores.projectStore.save(project, {
    expectedRevisionId: created.revisionId
  });
  const reviewedDocument = sermonDocument(
    'pending-transaction-sermon',
    [recoveredSource.source]
  );
  const reviewedResource = addSermonResource(linked.project, reviewedDocument);
  const repinned = setSermonSourceLink(reviewedResource.project, {
    itemId: 'transaction-sermon-owner',
    sermonResourceId: reviewedResource.resourceId
  });
  const interruptedLibrary = {
    readCurrent: (...args) => stores.sermonLibrary.readCurrent(...args),
    readRevision: (...args) => stores.sermonLibrary.readRevision(...args),
    stageDocument: (...args) => stores.sermonLibrary.stageDocument(...args),
    promoteRevision() {
      const error = new Error('simulated transaction interruption');
      error.code = 'SIMULATED_CRASH';
      throw error;
    }
  };
  const transactionRoot = path.join(stores.parent, 'transactions');
  const interrupted = new SermonProjectCommitCoordinator({
    rootPath: transactionRoot,
    projectStore: stores.projectStore,
    sermonLibrary: interruptedLibrary,
    clock: stores.clock.now
  });
  await assert.rejects(
    interrupted.commit({
      project: repinned,
      expectedProjectRevisionId: linked.revisionId,
      sermonDocument: reviewedDocument,
      expectedSermonRevision: original.revision,
      resourceId: reviewedResource.resourceId,
      resourceOwnerId: 'transaction-sermon-owner'
    }),
    /simulated transaction interruption/
  );
  assert.equal(
    (await stores.sermonLibrary.readCurrent(original.sermon.id)).revision,
    original.revision
  );

  const recovering = new SermonProjectCommitCoordinator({
    rootPath: transactionRoot,
    projectStore: stores.projectStore,
    sermonLibrary: stores.sermonLibrary,
    clock: stores.clock.now
  });
  const audited = await coordinator(stores, {
    transactionCoordinator: recovering
  }).audit();
  assert.equal(audited.referencedObjectCount, 1);
  assert.equal(
    (await stores.sermonLibrary.readCurrent(original.sermon.id)).revision,
    reviewedResource.resourceId.slice('sha256:'.length)
  );
  await assert.rejects(
    fs.stat(path.join(transactionRoot, 'pending-sermon-project.json')),
    error => error.code === 'ENOENT'
  );
});

test('corrupt reference evidence aborts an aged cleanup without deleting the object', async t => {
  const stores = await storesFor(t);
  const orphan = await importTextSource(stores, 'corrupt-evidence-orphan', 'preserve on corruption');
  const saved = await stores.sermonLibrary.saveDocument(
    sermonDocument('corrupt-reference-evidence', [])
  );
  await coordinator(stores).audit();
  stores.clock.advanceDays(91);
  const revisionPath = path.join(
    stores.sermonLibrary._sermonDirectory(saved.sermon.id),
    'versions',
    `${saved.revision}.json`
  );
  await fs.writeFile(revisionPath, '{"corrupt":true}\n', { mode: 0o600 });

  await assert.rejects(coordinator(stores).audit(), expectRetentionAbort);
  await stores.sourceStore.checkObject(orphan.objectId);
});

test('a bounded reference scan aborts before deleting any aged object', async t => {
  const stores = await storesFor(t);
  const orphan = await importTextSource(stores, 'scan-cap-orphan', 'preserve at scan cap');
  await stores.sermonLibrary.saveDocument(sermonDocument('scan-cap-sermon', []));
  assert.throws(
    () => coordinator(stores, { retentionMs: 30 * DAY_MS - 1 }),
    /retentionMs must be between/
  );
  await assert.rejects(
    coordinator(stores, { maximumReferenceFiles: 1 }).audit(),
    expectRetentionAbort
  );
  await stores.sourceStore.checkObject(orphan.objectId);
});

test('no plan is a no-op and an empty audit cannot be confirmed for deletion', async t => {
  const stores = await storesFor(t);
  const retention = coordinator(stores);
  assert.deepEqual(
    await retention.applyConfirmedStartupPlan(),
    {
      applied: false,
      skippedReason: 'no-confirmed-plan',
      deletedObjectCount: 0,
      deletedBytes: 0
    }
  );
  const empty = await retention.audit();
  assert.equal(empty.objectCount, 0);
  assert.equal(empty.eligibleObjectCount, 0);
  await assert.rejects(
    retention.persistRestartPlan(empty.candidateHash),
    error => {
      assert.ok(error instanceof LocalSermonSourceRetentionError);
      assert.equal(error.code, 'NO_CLEANUP_CANDIDATES');
      return true;
    }
  );
});

test('a missing referenced object invalidates a confirmed plan before any candidate deletion', async t => {
  const stores = await storesFor(t);
  const referenced = await importTextSource(stores, 'missing-reference', 'referenced object');
  const orphan = await importTextSource(stores, 'missing-reference-orphan', 'at risk orphan');
  await stores.sermonLibrary.saveDocument(
    sermonDocument('missing-reference-sermon', [referenced.source])
  );
  await coordinator(stores).audit();
  stores.clock.advanceDays(91);
  const aged = await coordinator(stores).audit();
  await coordinator(stores).persistRestartPlan(aged.candidateHash);
  await fs.unlink(stores.sourceStore._objectPath(referenced.source.sha256));

  await assert.rejects(
    coordinator(stores).applyConfirmedStartupPlan(),
    error => {
      assert.ok(error instanceof LocalSermonSourceRetentionError);
      assert.equal(error.code, 'REFERENCED_OBJECT_MISSING');
      return true;
    }
  );
  await stores.sourceStore.checkObject(orphan.objectId);
});

test('unknown, tombstoned, zero-byte, and symlinked object entries abort without cleanup', async t => {
  const cases = [
    {
      name: 'unexpected prefix',
      async contaminate(stores) {
        const target = path.join(stores.sourceStore.rootPath, 'objects', 'zz');
        await fs.mkdir(target);
        return target;
      }
    },
    {
      name: 'unexpected tombstone',
      async contaminate(stores, orphan) {
        const canonical = stores.sourceStore._objectPath(orphan.source.sha256);
        const target = path.join(
          path.dirname(canonical),
          `.gc-${orphan.source.sha256}-interrupted`
        );
        await fs.copyFile(canonical, target);
        return target;
      }
    },
    {
      name: 'zero-byte canonical entry',
      async contaminate(stores) {
        const digest = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
        const directory = path.join(
          stores.sourceStore.rootPath,
          'objects',
          digest.slice(0, 2)
        );
        await fs.mkdir(directory, { recursive: true });
        const target = path.join(directory, digest);
        await fs.writeFile(target, Buffer.alloc(0), { mode: 0o600 });
        return target;
      }
    }
  ];
  if (process.platform !== 'win32') {
    cases.push({
      name: 'symlinked object entry',
      async contaminate(stores, orphan) {
        const canonical = stores.sourceStore._objectPath(orphan.source.sha256);
        const target = path.join(path.dirname(canonical), `${'f'.repeat(64)}`);
        await fs.symlink(canonical, target);
        return target;
      }
    });
  }

  for (const scenario of cases) {
    await t.test(scenario.name, async child => {
      const stores = await storesFor(child);
      const orphan = await importTextSource(
        stores,
        `unsafe-${scenario.name.replaceAll(' ', '-')}`,
        `preserve ${scenario.name}`
      );
      await coordinator(stores).audit();
      stores.clock.advanceDays(91);
      const aged = await coordinator(stores).audit();
      await coordinator(stores).persistRestartPlan(aged.candidateHash);
      const contaminant = await scenario.contaminate(stores, orphan);

      await assert.rejects(
        coordinator(stores).applyConfirmedStartupPlan(),
        expectRetentionAbort
      );
      await stores.sourceStore.checkObject(orphan.objectId);
      await fs.lstat(contaminant);
    });
  }
});

test('corrupt or over-permission retention ledgers and plans preserve every object', async t => {
  await t.test('corrupt ledger', async child => {
    const stores = await storesFor(child);
    const orphan = await importTextSource(stores, 'corrupt-ledger', 'preserve corrupt ledger');
    const retention = coordinator(stores);
    await retention.audit();
    await fs.writeFile(retention.statePath, '{}\n');
    await assert.rejects(retention.audit(), error => {
      assert.ok(error instanceof LocalSermonSourceRetentionError);
      assert.equal(error.code, 'RETENTION_STATE_CORRUPT');
      return true;
    });
    await stores.sourceStore.checkObject(orphan.objectId);
  });

  await t.test('over-permission ledger', async child => {
    if (process.platform === 'win32') {
      child.skip('POSIX permission bits are unavailable on Windows');
      return;
    }
    const stores = await storesFor(child);
    const orphan = await importTextSource(stores, 'permission-ledger', 'preserve ledger mode');
    const retention = coordinator(stores);
    await retention.audit();
    await fs.chmod(retention.statePath, 0o644);
    await assert.rejects(retention.audit(), error => {
      assert.ok(error instanceof LocalSermonSourceRetentionError);
      assert.equal(error.code, 'RETENTION_EVIDENCE_UNSAFE');
      return true;
    });
    await stores.sourceStore.checkObject(orphan.objectId);
  });

  await t.test('corrupt plan', async child => {
    const stores = await storesFor(child);
    const orphan = await importTextSource(stores, 'corrupt-plan', 'preserve corrupt plan');
    const retention = coordinator(stores);
    await retention.audit();
    stores.clock.advanceDays(91);
    const aged = await retention.audit();
    await retention.persistRestartPlan(aged.candidateHash);
    await fs.writeFile(retention.planPath, '{}\n');
    await assert.rejects(retention.applyConfirmedStartupPlan(), error => {
      assert.ok(error instanceof LocalSermonSourceRetentionError);
      assert.equal(error.code, 'RETENTION_PLAN_CORRUPT');
      return true;
    });
    await stores.sourceStore.checkObject(orphan.objectId);
  });

  await t.test('over-permission plan', async child => {
    if (process.platform === 'win32') {
      child.skip('POSIX permission bits are unavailable on Windows');
      return;
    }
    const stores = await storesFor(child);
    const orphan = await importTextSource(stores, 'permission-plan', 'preserve plan mode');
    const retention = coordinator(stores);
    await retention.audit();
    stores.clock.advanceDays(91);
    const aged = await retention.audit();
    await retention.persistRestartPlan(aged.candidateHash);
    await fs.chmod(retention.planPath, 0o644);
    await assert.rejects(retention.applyConfirmedStartupPlan(), error => {
      assert.ok(error instanceof LocalSermonSourceRetentionError);
      assert.equal(error.code, 'RETENTION_EVIDENCE_UNSAFE');
      return true;
    });
    await stores.sourceStore.checkObject(orphan.objectId);
  });
});

test('a confirmed plan becomes stale when a canonical reference appears before restart', async t => {
  const stores = await storesFor(t);
  const formerlyOrphaned = await importTextSource(stores, 'stale-plan', 'referenced before apply');
  await coordinator(stores).audit();
  stores.clock.advanceDays(91);
  const aged = await coordinator(stores).audit();
  await coordinator(stores).persistRestartPlan(aged.candidateHash);
  await stores.sermonLibrary.saveDocument(
    sermonDocument('stale-plan-sermon', [formerlyOrphaned.source])
  );

  const applied = await coordinator(stores).applyConfirmedStartupPlan();
  assert.equal(applied.applied, false);
  assert.equal(applied.skippedReason, 'plan-stale');
  assert.equal(applied.deletedObjectCount, 0);
  await stores.sourceStore.checkObject(formerlyOrphaned.objectId);
  assert.deepEqual(
    await coordinator(stores).applyConfirmedStartupPlan(),
    {
      applied: false,
      skippedReason: 'no-confirmed-plan',
      deletedObjectCount: 0,
      deletedBytes: 0
    }
  );
});

test('a tombstone unlink failure rolls the verified object back to its canonical name', async t => {
  const stores = await storesFor(t, {
    unlinkObject: async filePath => {
      if (path.basename(filePath).startsWith('.gc-')) {
        const error = new Error('injected unlink failure');
        error.code = 'EIO';
        throw error;
      }
      return fs.unlink(filePath);
    }
  });
  const orphan = await importTextSource(stores, 'rollback-orphan', 'rollback this object');
  await coordinator(stores).audit();
  stores.clock.advanceDays(91);
  const aged = await coordinator(stores).audit();
  await coordinator(stores).persistRestartPlan(aged.candidateHash);

  await assert.rejects(
    coordinator(stores).applyConfirmedStartupPlan(),
    expectRetentionAbort
  );
  await stores.sourceStore.checkObject(orphan.objectId);
  const objectDirectory = path.dirname(
    stores.sourceStore._objectPath(orphan.source.sha256)
  );
  const entries = await fs.readdir(objectDirectory);
  assert.deepEqual(entries, [orphan.source.sha256]);
});

test('a partial apply preserves the failed object and requires a new confirmation', async t => {
  let unlinkCount = 0;
  let failedDigest = null;
  const stores = await storesFor(t, {
    unlinkObject: async filePath => {
      unlinkCount += 1;
      if (unlinkCount === 2) {
        failedDigest = path.basename(filePath).slice('.gc-'.length, '.gc-'.length + 64);
        const error = new Error('injected second unlink failure');
        error.code = 'EIO';
        throw error;
      }
      return fs.unlink(filePath);
    }
  });
  const first = await importTextSource(stores, 'partial-first', 'partial first');
  const second = await importTextSource(stores, 'partial-second', 'partial second');
  await coordinator(stores).audit();
  stores.clock.advanceDays(91);
  const aged = await coordinator(stores).audit();
  assert.equal(aged.eligibleObjectCount, 2);
  await coordinator(stores).persistRestartPlan(aged.candidateHash);
  await assert.rejects(
    coordinator(stores).applyConfirmedStartupPlan(),
    expectRetentionAbort
  );

  const failed = [first, second].find(item => item.source.sha256 === failedDigest);
  const completed = [first, second].find(item => item.source.sha256 !== failedDigest);
  assert.ok(failed);
  assert.ok(completed);
  await stores.sourceStore.checkObject(failed.objectId);
  await expectObjectMissing(stores.sourceStore, completed);
  const failedDirectoryEntries = await fs.readdir(path.dirname(
    stores.sourceStore._objectPath(failed.source.sha256)
  ));
  assert.equal(
    failedDirectoryEntries.some(name => name.startsWith('.gc-')),
    false
  );
  const retry = await coordinator(stores).applyConfirmedStartupPlan();
  assert.equal(retry.applied, false);
  assert.equal(retry.skippedReason, 'plan-stale');
  await stores.sourceStore.checkObject(failed.objectId);
});
