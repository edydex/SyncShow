'use strict';

const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createHeritageServiceDocument,
  serializeHeritageServiceDocument
} = require('../src/services/community/HeritageServiceDocument');
const {
  HeritageServiceDocumentOutbox,
  HeritageServiceDocumentOutboxError
} = require('../src/services/community/HeritageServiceDocumentOutbox');
const { createServiceProject } = require('../src/services/project');

const NOW = '2026-08-13T19:00:00.000Z';
const BASE_REVISION = '1'.repeat(64);

function documentSource(title = 'Sunday Service') {
  const project = createServiceProject({
    id: 'service-2026-08-16',
    title,
    serviceDate: '2026-08-16',
    profileId: 'main-sanctuary',
    now: NOW,
    channels: [
      { id: 'english', label: 'English', language: 'en' },
      { id: 'russian', label: 'Russian', language: 'ru' },
      { id: 'media', label: 'Media', language: 'und' }
    ]
  });
  return serializeHeritageServiceDocument(createHeritageServiceDocument(project));
}

async function withOutbox(callback) {
  const temporaryRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), 'syncshow-service-outbox-')
  );
  const rootPath = await fs.realpath(temporaryRoot);
  let uuid = 0;
  const create = () => new HeritageServiceDocumentOutbox({
    rootPath,
    now: () => new Date(NOW),
    randomUUID: () => `00000000-0000-4000-8000-${String(++uuid).padStart(12, '0')}`
  });
  try {
    await callback(create, rootPath);
  } finally {
    await fs.rm(rootPath, { recursive: true, force: true });
  }
}

test('persists an exact offline edit and recovers it after restart', async () => {
  await withOutbox(async create => {
    const first = create();
    const queued = await first.queue({
      serverId: 'wotbc-community',
      syncId: 'service-2026-08-16',
      mode: 'update',
      baseSyncVersion: 3,
      baseRevision: BASE_REVISION,
      documentSource: documentSource()
    });

    const recovered = await create().get(
      'wotbc-community',
      'service-2026-08-16'
    );
    assert.deepEqual(recovered, queued);
    assert.equal(recovered.baseSyncVersion, 3);
    assert.equal(recovered.baseRevision, BASE_REVISION);
  });
});

test('new offline edits replace content but retain the oldest remote base', async () => {
  await withOutbox(async create => {
    const outbox = create();
    const first = await outbox.queue({
      serverId: 'wotbc-community',
      syncId: 'service-2026-08-16',
      mode: 'update',
      baseSyncVersion: 3,
      baseRevision: BASE_REVISION,
      documentSource: documentSource('First offline edit')
    });
    const second = await outbox.queue({
      serverId: 'wotbc-community',
      syncId: 'service-2026-08-16',
      mode: 'update',
      baseSyncVersion: 99,
      baseRevision: '9'.repeat(64),
      documentSource: documentSource('Second offline edit')
    });

    assert.equal(second.baseSyncVersion, 3);
    assert.equal(second.baseRevision, BASE_REVISION);
    assert.notEqual(second.documentRevision, first.documentRevision);
    assert.notEqual(second.idempotencyKey, first.idempotencyKey);
  });
});

test('a stale acknowledgement cannot erase a newer queued edit', async () => {
  await withOutbox(async create => {
    const outbox = create();
    const first = await outbox.queue({
      serverId: 'wotbc-community',
      syncId: 'service-2026-08-16',
      mode: 'create',
      documentSource: documentSource('First offline edit')
    });
    const second = await outbox.queue({
      serverId: 'wotbc-community',
      syncId: 'service-2026-08-16',
      mode: 'update',
      baseSyncVersion: 4,
      baseRevision: BASE_REVISION,
      documentSource: documentSource('Second offline edit')
    });

    assert.equal(second.mode, 'create');
    assert.equal(second.baseSyncVersion, 0);
    assert.equal(
      await outbox.remove('wotbc-community', 'service-2026-08-16', {
        documentRevision: first.documentRevision
      }),
      false
    );
    assert.equal(
      (await outbox.get('wotbc-community', 'service-2026-08-16')).documentRevision,
      second.documentRevision
    );
    assert.equal(
      await outbox.remove('wotbc-community', 'service-2026-08-16', {
        documentRevision: second.documentRevision
      }),
      true
    );
    assert.deepEqual(await outbox.list(), []);
  });
});

test('rejects an update that has no exact Community base', async () => {
  await withOutbox(async create => {
    await assert.rejects(
      create().queue({
        serverId: 'wotbc-community',
        syncId: 'service-2026-08-16',
        mode: 'update',
        documentSource: documentSource()
      }),
      error => {
        assert.ok(error instanceof HeritageServiceDocumentOutboxError);
        assert.equal(error.code, 'INVALID_OUTBOX_ENTRY');
        return true;
      }
    );
  });
});
