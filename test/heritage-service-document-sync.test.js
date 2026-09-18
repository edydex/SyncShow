'use strict';

const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  CommunityClientError
} = require('../src/services/community/CommunityClient');
const {
  createHeritageServiceDocument,
  serializeHeritageServiceDocument
} = require('../src/services/community/HeritageServiceDocument');
const {
  HeritageServiceDocumentOutbox
} = require('../src/services/community/HeritageServiceDocumentOutbox');
const {
  HeritageServiceDocumentSync
} = require('../src/services/community/HeritageServiceDocumentSync');
const { createServiceProject } = require('../src/services/project');

const NOW = '2026-08-13T21:00:00.000Z';
const BASE_REVISION = '2'.repeat(64);

function source(title = 'Sunday Service') {
  return serializeHeritageServiceDocument(createHeritageServiceDocument(
    createServiceProject({
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
    })
  ));
}

async function withSync(client, callback, { synchronizeAssets = async () => {} } = {}) {
  const temporaryRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), 'syncshow-service-sync-')
  );
  const rootPath = await fs.realpath(temporaryRoot);
  let uuid = 0;
  const randomUUID = () =>
    `00000000-0000-4000-8000-${String(++uuid).padStart(12, '0')}`;
  const outbox = new HeritageServiceDocumentOutbox({
    rootPath,
    now: () => new Date(NOW),
    randomUUID
  });
  const sync = new HeritageServiceDocumentSync({
    client,
    outbox,
    serverId: 'wotbc-community',
    synchronizeAssets,
    randomUUID
  });
  try {
    await callback(sync, outbox);
  } finally {
    await fs.rm(rootPath, { recursive: true, force: true });
  }
}

function client(overrides = {}) {
  return {
    async createServiceDocument(input) {
      return { syncId: input.syncId, syncVersion: 1 };
    },
    async updateServiceDocument(input) {
      return { syncId: input.syncId, syncVersion: input.baseSyncVersion + 1 };
    },
    async getServiceDocument() {
      return null;
    },
    ...overrides
  };
}

test('a retryable outage queues the complete edit for offline Show continuity', async () => {
  await withSync(client({
    async createServiceDocument() {
      throw new CommunityClientError('NETWORK_ERROR', 'offline', {
        retryable: true
      });
    }
  }), async (sync, outbox) => {
    const result = await sync.save({
      documentSource: source(),
      accessToken: 'community-access-token-0000000001'
    });

    assert.equal(result.state, 'queued');
    assert.equal(result.reason, 'NETWORK_ERROR');
    const pending = await outbox.list();
    assert.equal(pending.length, 1);
    assert.equal(pending[0].mode, 'create');
    assert.equal(pending[0].documentSource, source());
  });
});

test('reconnect sends the oldest exact base and clears only the acknowledged edit', async () => {
  let updateRequest = null;
  await withSync(client({
    async updateServiceDocument(input) {
      updateRequest = input;
      return { syncId: input.syncId, syncVersion: 4 };
    }
  }), async (sync, outbox) => {
    await outbox.queue({
      serverId: 'wotbc-community',
      syncId: 'service-2026-08-16',
      mode: 'update',
      baseSyncVersion: 3,
      baseRevision: BASE_REVISION,
      documentSource: source('First offline edit')
    });

    const result = await sync.save({
      documentSource: source('Morning-of offline edit'),
      base: { syncVersion: 99, revision: '9'.repeat(64) },
      accessToken: 'community-access-token-0000000001'
    });

    assert.equal(result.state, 'synced');
    assert.equal(updateRequest.baseSyncVersion, 3);
    assert.equal(updateRequest.baseRevision, BASE_REVISION);
    assert.equal(await outbox.get(
      'wotbc-community',
      'service-2026-08-16'
    ), null);
  });
});

test('a concurrent Community edit becomes an explicit review result', async () => {
  const remote = { syncId: 'service-2026-08-16', syncVersion: 5 };
  await withSync(client({
    async updateServiceDocument() {
      throw new CommunityClientError(
        'REVISION_CONFLICT',
        'changed remotely',
        { status: 409 }
      );
    },
    async getServiceDocument() {
      return remote;
    }
  }), async (sync, outbox) => {
    const result = await sync.save({
      documentSource: source('Local edit'),
      base: { syncVersion: 4, revision: BASE_REVISION },
      accessToken: 'community-access-token-0000000001'
    });

    assert.equal(result.state, 'conflict');
    assert.deepEqual(result.base, {
      syncVersion: 4,
      revision: BASE_REVISION
    });
    assert.equal(result.remote, remote);
    assert.match(result.local.documentSource, /Local edit/);
    assert.deepEqual(await outbox.list(), []);
  });
});

test('keeps the exact document queued until its private images synchronize', async () => {
  let assetAttempts = 0;
  await withSync(client(), async (sync, outbox) => {
    const first = await sync.save({
      documentSource: source('Service with picture'),
      accessToken: 'community-access-token-0000000001'
    });
    assert.equal(first.state, 'queued');
    assert.equal(first.reason, 'NETWORK_ERROR');
    assert.equal((await outbox.list()).length, 1);

    const flushed = await sync.flush({
      accessToken: 'community-access-token-0000000001'
    });
    assert.equal(flushed[0].state, 'synced');
    assert.equal(assetAttempts, 2);
    assert.deepEqual(await outbox.list(), []);
  }, {
    synchronizeAssets: async () => {
      assetAttempts += 1;
      if (assetAttempts === 1) {
        throw new CommunityClientError('NETWORK_ERROR', 'image upload offline', {
          retryable: true
        });
      }
    }
  });
});
