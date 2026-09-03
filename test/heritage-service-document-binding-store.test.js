'use strict';

const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  HeritageServiceDocumentBindingStore
} = require('../src/services/community/HeritageServiceDocumentBindingStore');

const REVISION = 'a'.repeat(64);
const LOCAL_REVISION = 'b'.repeat(64);

async function withStore(callback) {
  const temporaryRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), 'syncshow-service-binding-')
  );
  const rootPath = await fs.realpath(temporaryRoot);
  try {
    await callback(new HeritageServiceDocumentBindingStore({ rootPath }), rootPath);
  } finally {
    await fs.rm(rootPath, { recursive: true, force: true });
  }
}

test('persists the exact Community base associated with a local project revision', async () => {
  await withStore(async (store, rootPath) => {
    const saved = await store.save({
      projectId: 'service-2026-08-16',
      serverId: 'wotbc-community',
      syncId: 'service-2026-08-16',
      syncVersion: 7,
      documentRevision: REVISION,
      localRevisionId: LOCAL_REVISION,
      status: 'planning',
      changedAt: '2026-08-13T19:00:00.000Z'
    });
    const recovered = await new HeritageServiceDocumentBindingStore({
      rootPath
    }).get('service-2026-08-16');

    assert.deepEqual(recovered, saved);
    assert.equal(recovered.syncVersion, 7);
    assert.equal(recovered.documentRevision, REVISION);
  });
});

test('allows a durable pending-create binding without inventing a remote revision', async () => {
  await withStore(async store => {
    const saved = await store.save({
      projectId: 'service-2026-08-16',
      serverId: 'wotbc-community',
      syncId: 'service-2026-08-16',
      syncVersion: 0,
      documentRevision: null,
      localRevisionId: LOCAL_REVISION,
      status: 'planning',
      changedAt: null
    });

    assert.equal(saved.syncVersion, 0);
    assert.equal(saved.documentRevision, null);
    assert.equal(saved.changedAt, null);
  });
});

test('rejects a pending-create binding that claims a Community revision', async () => {
  await withStore(async store => {
    await assert.rejects(
      store.save({
        projectId: 'service-2026-08-16',
        serverId: 'wotbc-community',
        syncId: 'service-2026-08-16',
        syncVersion: 0,
        documentRevision: REVISION,
        localRevisionId: LOCAL_REVISION,
        status: 'planning',
        changedAt: null
      }),
      /binding is invalid/u
    );
  });
});
