'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');

const {
  CommunityConnectionStore,
  CommunityConnectionStoreError
} = require('../src/services/community/CommunityConnectionStore');
const {
  CommunitySyncStateStore,
  CommunitySyncStateStoreError
} = require('../src/services/community/CommunitySyncStateStore');
const {
  songSharingReviewRevision
} = require('../src/services/community/CommunitySongSharingReview');
const memberSharingFixture =
  require('./fixtures/song-member-sharing-wire-v1.json');

const ACCESS_TOKEN = 'community-access-token-secret-000001';
const REFRESH_TOKEN = 'community-refresh-token-secret-0001';
const REVIEWED_FAMILY_REVISION = 'd'.repeat(64);

async function tempDirectory(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'syncshow-community-store-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return fs.realpath(directory);
}

function safeStorage({ available = true, backend = 'keychain' } = {}) {
  return {
    isEncryptionAvailable: () => available,
    getSelectedStorageBackend: () => backend,
    encryptString: value => Buffer.from(`protected:${Buffer.from(value).toString('base64')}`),
    decryptString: value => {
      const serialized = value.toString();
      if (!serialized.startsWith('protected:')) throw new Error('not encrypted');
      return Buffer.from(serialized.slice('protected:'.length), 'base64').toString();
    }
  };
}

function dualModeSafeStorage({ hangingOperation = null } = {}) {
  const calls = [];
  return {
    calls,
    isEncryptionAvailable: () => {
      calls.push('sync-available');
      return true;
    },
    encryptString: value => {
      calls.push('sync-encrypt');
      return Buffer.from(`protected:${Buffer.from(value).toString('base64')}`);
    },
    decryptString: value => {
      calls.push('sync-decrypt');
      const serialized = value.toString();
      if (!serialized.startsWith('protected:')) throw new Error('not encrypted');
      return Buffer.from(serialized.slice('protected:'.length), 'base64').toString();
    },
    isAsyncEncryptionAvailable: () => {
      calls.push('async-available');
      return hangingOperation === 'availability'
        ? new Promise(() => {})
        : Promise.resolve(true);
    },
    encryptStringAsync: async value => {
      calls.push('async-encrypt');
      if (hangingOperation === 'encrypt') return new Promise(() => {});
      return Buffer.from(`async-protected:${Buffer.from(value).toString('base64')}`);
    },
    decryptStringAsync: async value => {
      calls.push('async-decrypt');
      if (hangingOperation === 'decrypt') return new Promise(() => {});
      const serialized = value.toString();
      if (!serialized.startsWith('async-protected:')) throw new Error('not encrypted');
      return {
        result: Buffer.from(serialized.slice('async-protected:'.length), 'base64').toString(),
        shouldReEncrypt: false
      };
    }
  };
}

function manualTimers() {
  let nextId = 0;
  const active = new Map();
  let scheduledCount = 0;
  let clearedCount = 0;
  return {
    setTimeout(callback, delay) {
      const handle = {
        id: ++nextId,
        unref() {}
      };
      scheduledCount += 1;
      active.set(handle, { callback, delay });
      return handle;
    },
    clearTimeout(handle) {
      clearedCount += 1;
      active.delete(handle);
    },
    fireOnly() {
      assert.equal(active.size, 1, 'exactly one secure-storage timer should be active');
      const [{ callback }] = active.values();
      callback();
    },
    activeCount: () => active.size,
    scheduledCount: () => scheduledCount,
    clearedCount: () => clearedCount,
    delays: () => [...active.values()].map(value => value.delay)
  };
}

function nextTurn() {
  return new Promise(resolve => setImmediate(resolve));
}

function connectionInput(overrides = {}) {
  return {
    serverId: 'wotbc-community',
    serverName: 'WOTBC Community',
    baseUrl: 'https://community.example.test/',
    apiBaseUrl: 'https://community.example.test/api/community/syncshow/v1',
    account: {
      id: 'admin-1',
      email: 'admin@example.com',
      name: 'Church Admin'
    },
    scopes: ['syncshow:songs:read', 'syncshow:songs:write'],
    accessToken: ACCESS_TOKEN,
    refreshToken: REFRESH_TOKEN,
    expiresAt: '2026-07-25T13:00:00.000Z',
    ...overrides
  };
}

test('macOS uses bounded async safeStorage and never invokes sync when both APIs exist', async t => {
  const root = await tempDirectory(t);
  const storage = dualModeSafeStorage();
  const timers = manualTimers();
  const store = new CommunityConnectionStore({
    storageRoot: path.join(root, 'connections'),
    platform: 'darwin',
    safeStorage: storage,
    secureStorageTimeoutMs: 1000,
    setTimeoutImpl: timers.setTimeout,
    clearTimeoutImpl: timers.clearTimeout
  });

  assert.equal(await store.assertSecureStorageAvailable(), true);
  assert.deepEqual(storage.calls, [
    'async-available',
    'async-encrypt',
    'async-decrypt'
  ]);
  assert.equal(timers.scheduledCount(), 3);
  assert.equal(timers.clearedCount(), 3);
  assert.equal(timers.activeCount(), 0);
});

test('macOS bounds hanging async safeStorage availability and clears its timer', async t => {
  const root = await tempDirectory(t);
  const storage = dualModeSafeStorage({ hangingOperation: 'availability' });
  const timers = manualTimers();
  const store = new CommunityConnectionStore({
    storageRoot: path.join(root, 'connections'),
    platform: 'darwin',
    safeStorage: storage,
    secureStorageTimeoutMs: 1000,
    setTimeoutImpl: timers.setTimeout,
    clearTimeoutImpl: timers.clearTimeout
  });

  const preflight = store.assertSecureStorageAvailable();
  await nextTurn();
  assert.deepEqual(timers.delays(), [1000]);
  timers.fireOnly();
  await assert.rejects(
    preflight,
    error => error instanceof CommunityConnectionStoreError
      && error.code === 'SECURE_STORAGE_UNAVAILABLE'
  );
  assert.deepEqual(storage.calls, ['async-available']);
  assert.equal(timers.activeCount(), 0);
  assert.equal(timers.scheduledCount(), timers.clearedCount());
});

test('macOS default secure-storage bound fails without directing users to Keychain', async t => {
  const root = await tempDirectory(t);
  const storage = dualModeSafeStorage({ hangingOperation: 'availability' });
  const timers = manualTimers();
  const store = new CommunityConnectionStore({
    storageRoot: path.join(root, 'connections'),
    platform: 'darwin',
    safeStorage: storage,
    setTimeoutImpl: timers.setTimeout,
    clearTimeoutImpl: timers.clearTimeout
  });

  const preflight = store.assertSecureStorageAvailable();
  await nextTurn();
  assert.deepEqual(timers.delays(), [15000]);
  timers.fireOnly();
  await assert.rejects(
    preflight,
    error => error instanceof CommunityConnectionStoreError
      && error.code === 'SECURE_STORAGE_UNAVAILABLE'
      && /Community credential storage is unavailable/.test(error.message)
      && !/Keychain|system password/i.test(error.message)
  );
  assert.equal(timers.activeCount(), 0);
});

test('macOS bounds hanging async safeStorage encryption and clears every timer', async t => {
  const root = await tempDirectory(t);
  const storage = dualModeSafeStorage({ hangingOperation: 'encrypt' });
  const timers = manualTimers();
  const store = new CommunityConnectionStore({
    storageRoot: path.join(root, 'connections'),
    platform: 'darwin',
    safeStorage: storage,
    secureStorageTimeoutMs: 1000,
    setTimeoutImpl: timers.setTimeout,
    clearTimeoutImpl: timers.clearTimeout
  });

  const preflight = store.assertSecureStorageAvailable();
  await nextTurn();
  timers.fireOnly();
  await assert.rejects(
    preflight,
    error => error instanceof CommunityConnectionStoreError
      && error.code === 'SECURE_STORAGE_UNAVAILABLE'
  );
  assert.deepEqual(storage.calls, ['async-available', 'async-encrypt']);
  assert.equal(timers.activeCount(), 0);
  assert.equal(timers.scheduledCount(), timers.clearedCount());
});

test('macOS bounds hanging async safeStorage decryption and clears every timer', async t => {
  const root = await tempDirectory(t);
  const storage = dualModeSafeStorage({ hangingOperation: 'decrypt' });
  const timers = manualTimers();
  const store = new CommunityConnectionStore({
    storageRoot: path.join(root, 'connections'),
    platform: 'darwin',
    safeStorage: storage,
    secureStorageTimeoutMs: 1000,
    setTimeoutImpl: timers.setTimeout,
    clearTimeoutImpl: timers.clearTimeout
  });

  const preflight = store.assertSecureStorageAvailable();
  await nextTurn();
  timers.fireOnly();
  await assert.rejects(
    preflight,
    error => error instanceof CommunityConnectionStoreError
      && error.code === 'SECURE_STORAGE_UNAVAILABLE'
  );
  assert.deepEqual(storage.calls, [
    'async-available',
    'async-encrypt',
    'async-decrypt'
  ]);
  assert.equal(timers.activeCount(), 0);
  assert.equal(timers.scheduledCount(), timers.clearedCount());
});

test('macOS uses synchronous safeStorage only when the complete async API is absent', async t => {
  const root = await tempDirectory(t);
  const calls = [];
  const storage = safeStorage();
  const store = new CommunityConnectionStore({
    storageRoot: path.join(root, 'connections'),
    platform: 'darwin',
    safeStorage: {
      ...storage,
      isEncryptionAvailable: () => {
        calls.push('sync-available');
        return storage.isEncryptionAvailable();
      },
      encryptString: value => {
        calls.push('sync-encrypt');
        return storage.encryptString(value);
      },
      decryptString: value => {
        calls.push('sync-decrypt');
        return storage.decryptString(value);
      }
    }
  });

  assert.equal(await store.assertSecureStorageAvailable(), true);
  assert.deepEqual(calls, ['sync-available', 'sync-encrypt', 'sync-decrypt']);
});

test('community credentials are OS-encrypted and never appear in summaries or plaintext storage', async t => {
  const root = await tempDirectory(t);
  const store = new CommunityConnectionStore({
    storageRoot: path.join(root, 'connections'),
    safeStorage: safeStorage(),
    randomUUID: () => 'connection-00000001',
    now: () => new Date('2026-07-25T12:00:00.000Z')
  });
  const summary = await store.saveConnection(connectionInput());

  assert.equal(summary.id, 'connection-00000001');
  assert.equal(summary.canReadSongs, true);
  assert.equal(summary.canWriteSongs, true);
  assert.equal(Object.hasOwn(summary, 'accessToken'), false);
  assert.equal(Object.hasOwn(summary, 'refreshToken'), false);
  assert.equal(JSON.stringify(await store.listConnections()).includes(ACCESS_TOKEN), false);

  const serialized = await fs.readFile(
    path.join(root, 'connections', 'connections.json'),
    'utf8'
  );
  assert.equal(serialized.includes(ACCESS_TOKEN), false);
  assert.equal(serialized.includes(REFRESH_TOKEN), false);
  assert.equal(serialized.includes('protected:'), false);
  if (process.platform !== 'win32') {
    assert.equal((await fs.stat(path.join(root, 'connections'))).mode & 0o077, 0);
    assert.equal(
      (await fs.stat(path.join(root, 'connections', 'connections.json'))).mode & 0o077,
      0
    );
  }

  const privateConnection = await store.getConnection(summary.id);
  assert.equal(privateConnection.accessToken, ACCESS_TOKEN);
  assert.equal(privateConnection.refreshToken, REFRESH_TOKEN);
  assert.equal(privateConnection.apiBaseUrl, connectionInput().apiBaseUrl);
});

test('community connection storage fails closed without a secure OS credential backend', async t => {
  const root = await tempDirectory(t);
  const unavailable = new CommunityConnectionStore({
    storageRoot: path.join(root, 'unavailable'),
    platform: 'darwin',
    safeStorage: safeStorage({ available: false })
  });
  await assert.rejects(
    unavailable.saveConnection(connectionInput()),
    error => error instanceof CommunityConnectionStoreError
      && error.code === 'SECURE_STORAGE_UNAVAILABLE'
      && !error.message.includes(ACCESS_TOKEN)
  );

  const basicText = new CommunityConnectionStore({
    storageRoot: path.join(root, 'basic'),
    platform: 'linux',
    safeStorage: safeStorage({ backend: 'basic_text' })
  });
  await assert.rejects(
    basicText.assertSecureStorageAvailable(),
    error => error.code === 'INSECURE_SECRET_STORAGE'
  );
});

test('connection token updates use local compare-and-swap and disconnect deletes local secrets', async t => {
  const root = await tempDirectory(t);
  let now = new Date('2026-07-25T12:00:00.000Z');
  const store = new CommunityConnectionStore({
    storageRoot: path.join(root, 'connections'),
    safeStorage: safeStorage(),
    randomUUID: () => 'connection-00000002',
    now: () => now
  });
  const saved = await store.saveConnection(connectionInput());
  now = new Date('2026-07-25T12:15:00.000Z');

  await assert.rejects(
    store.updateTokens(saved.id, {
      accessToken: 'new-access-token-0000000000001',
      expiresAt: '2026-07-25T14:00:00.000Z',
      expectedUpdatedAt: '2026-07-25T11:00:00.000Z'
    }),
    error => error.code === 'CONNECTION_CONFLICT'
  );
  const updated = await store.updateTokens(saved.id, {
    accessToken: 'new-access-token-0000000000001',
    expiresAt: '2026-07-25T14:00:00.000Z',
    expectedUpdatedAt: saved.updatedAt
  });
  assert.equal(updated.updatedAt, now.toISOString());
  assert.equal(
    (await store.getConnection(saved.id)).refreshToken,
    REFRESH_TOKEN,
    'refresh token remains when a refresh response does not rotate it'
  );

  assert.deepEqual(await store.disconnect(saved.id), { disconnected: true });
  assert.equal(await store.getConnection(saved.id), null);
});

test('protocol-v1 long-lived device grants intentionally allow no refresh token', async t => {
  const root = await tempDirectory(t);
  const store = new CommunityConnectionStore({
    storageRoot: path.join(root, 'connections'),
    safeStorage: safeStorage(),
    randomUUID: () => 'connection-00000005'
  });
  const saved = await store.saveConnection(connectionInput({ refreshToken: null }));
  const connection = await store.getConnection(saved.id);
  assert.equal(connection.refreshToken, null);
  assert.equal(connection.accessToken, ACCESS_TOKEN);
});

test('sync state persists cursor, CAS metadata, scheduled visibility, and preserved conflicts', async t => {
  const root = await tempDirectory(t);
  const store = new CommunitySyncStateStore({
    storageRoot: path.join(root, 'state'),
    now: () => new Date('2026-07-25T12:00:00.000Z')
  });
  const connectionId = 'connection-00000003';
  await store.saveConnectionState(connectionId, {
    cursor: 'cursor-1',
    lastSyncAt: '2026-07-25T11:00:00.000Z',
    songs: {
      'amazing-grace': {
        syncId: 'amazing-grace',
        localFamilyId: 'amazing-grace',
        remoteTitle: 'Amazing Grace',
        alternateTitles: ['О благодать'],
        syncVersion: 4,
        remoteRevision: 'song:amazing-grace:4',
        documents: {
          'amazing-grace': {
            localRevision: 'a'.repeat(64),
            remoteRevision: 'a'.repeat(64)
          }
        },
        visibility: 'private',
        publishAt: null,
        pendingVisibility: null,
        archived: false,
        metadataOnly: false,
        lastSyncedAt: '2026-07-25T11:00:00.000Z',
        conflict: null
      }
    }
  });

  const scheduled = await store.setSongVisibility(connectionId, 'amazing-grace', {
    visibility: 'scheduled-public',
    publishAt: '2026-07-27T17:00:00.000Z',
    expectedSyncVersion: 4
  });
  assert.deepEqual(scheduled.pendingVisibility, {
    visibility: 'scheduled-public',
    publishAt: '2026-07-27T17:00:00.000Z',
    expectedSyncVersion: 4
  });
  await assert.rejects(
    store.setSongVisibility(connectionId, 'amazing-grace', {
      visibility: 'public'
    }),
    error => error.code === 'STATE_CONFLICT'
  );

  const remoteSource = '---\nid: amazing-grace\ntitle: "Remote"\nlanguage: en\n---\n\n^1\nRemote\n';
  await store.recordConflict(connectionId, 'amazing-grace', {
    code: 'BOTH_CHANGED',
    localRevision: 'b'.repeat(64),
    remoteRevision: 'song:amazing-grace:5',
    remoteDocuments: [{
      id: 'amazing-grace',
      source: remoteSource,
      revision: 'c'.repeat(64)
    }]
  });
  const restarted = new CommunitySyncStateStore({
    storageRoot: path.join(root, 'state')
  });
  const song = await restarted.getSongState(connectionId, 'amazing-grace');
  assert.equal(song.conflict.code, 'BOTH_CHANGED');
  assert.equal(song.conflict.remoteDocuments[0].source, remoteSource);
  assert.equal((await restarted.listConflicts(connectionId)).length, 1);
});

test('sync state round-trips the exact Community member-sharing receipt and effective access', async t => {
  const root = await tempDirectory(t);
  const storageRoot = path.join(root, 'state');
  const connectionId = 'connection-00000012';
  const store = new CommunitySyncStateStore({ storageRoot });
  await store.saveConnectionState(connectionId, {
    cursor: 'receipt-cursor',
    songs: {
      [memberSharingFixture.songSyncId]: {
        syncId: memberSharingFixture.songSyncId,
        localFamilyId: memberSharingFixture.songSyncId,
        remoteTitle: 'Exact Song',
        syncVersion: memberSharingFixture.receipt.songSyncVersion,
        remoteRevision:
          `song:${memberSharingFixture.songSyncId}:${
            memberSharingFixture.receipt.songSyncVersion
          }`,
        documents: {},
        visibility: memberSharingFixture.receipt.visibility,
        publishAt: memberSharingFixture.receipt.publishAt,
        memberSharing: memberSharingFixture.receipt,
        effectiveVisibility: 'public',
        pendingVisibility: null,
        archived: false,
        metadataOnly: true
      }
    }
  });

  const restarted = new CommunitySyncStateStore({ storageRoot });
  const persisted = await restarted.getSongState(
    connectionId,
    memberSharingFixture.songSyncId
  );
  assert.deepEqual(persisted.memberSharing, memberSharingFixture.receipt);
  assert.equal(persisted.effectiveVisibility, 'public');
  persisted.memberSharing.timeZone = 'UTC';
  assert.equal(
    (await restarted.getSongState(
      connectionId,
      memberSharingFixture.songSyncId
    )).memberSharing.timeZone,
    'America/Los_Angeles'
  );
});

test('schema-v5 state cannot mint member access or receipts during migration', async t => {
  const root = await tempDirectory(t);
  const storageRoot = path.join(root, 'state');
  const connectionId = 'connection-00000013';
  await fs.mkdir(storageRoot, { recursive: true, mode: 0o700 });
  await fs.writeFile(
    path.join(storageRoot, 'sync-state.json'),
    `${JSON.stringify({
      schemaVersion: 5,
      connections: {
        [connectionId]: {
          cursor: null,
          lastSyncAt: null,
          songs: {
            'legacy-public': {
              syncId: 'legacy-public',
              syncVersion: 3,
              remoteRevision: 'song:legacy-public:3',
              documents: {},
              visibility: 'public',
              publishAt: null,
              memberSharing: {
                forged: true
              },
              effectiveVisibility: 'public',
              archived: false,
              metadataOnly: true
            }
          },
          songSharingReviews: {},
          songPublicLinkReviews: {},
          sermonCursor: null,
          lastSermonSyncAt: null,
          sermons: {}
        }
      }
    })}\n`,
    { mode: 0o600 }
  );

  const store = new CommunitySyncStateStore({ storageRoot });
  const migrated = await store.getSongState(connectionId, 'legacy-public');
  assert.equal(migrated.memberSharing, null);
  assert.equal(migrated.effectiveVisibility, null);
  assert.equal(
    migrated.visibility,
    'public',
    'legacy observed visibility remains data but is not treated as current member-access authority'
  );
});

test('an observed remote song cannot change visibility without its expected sync version', async t => {
  const root = await tempDirectory(t);
  const store = new CommunitySyncStateStore({
    storageRoot: path.join(root, 'state')
  });
  const connectionId = 'connection-00000004';
  await store.saveConnectionState(connectionId, {
    cursor: null,
    lastSyncAt: null,
    songs: {
      song: {
        syncId: 'song',
        syncVersion: 2,
        remoteRevision: 'song:song:2',
        documents: {},
        visibility: 'private',
        publishAt: null,
        archived: false,
        metadataOnly: true
      }
    }
  });
  await assert.rejects(
    store.setSongVisibility(connectionId, 'song', { visibility: 'public' }),
    error => error.code === 'STATE_CONFLICT'
  );
});

test('sync state treats protocol-valid Object prototype names as ordinary song and document IDs', async t => {
  const root = await tempDirectory(t);
  const storageRoot = path.join(root, 'state');
  const store = new CommunitySyncStateStore({ storageRoot });
  const connectionId = 'connection-00000006';
  const reservedIds = ['constructor', 'toString', 'hasOwnProperty'];

  for (const syncId of reservedIds) {
    const initial = await store.getSongState(connectionId, syncId);
    assert.equal(initial.syncId, syncId);
    const pending = await store.setSongVisibility(connectionId, syncId, {
      visibility: 'private'
    });
    assert.equal(pending.syncId, syncId);
    assert.equal(pending.pendingVisibility.visibility, 'private');
  }

  const state = await store.getConnectionState(connectionId);
  state.songs['document-family'] = {
    syncId: 'document-family',
    localFamilyId: 'document-family',
    syncVersion: 1,
    remoteRevision: 'song:document-family:1',
    documents: Object.fromEntries(reservedIds.map((id, index) => [
      id,
      {
        localRevision: String(index + 1).repeat(64),
        remoteRevision: String(index + 1).repeat(64)
      }
    ])),
    visibility: 'private',
    publishAt: null,
    archived: false,
    metadataOnly: false
  };
  await store.saveConnectionState(connectionId, state);

  const restarted = new CommunitySyncStateStore({ storageRoot });
  const clonedState = await restarted.getConnectionState(connectionId);
  assert.equal(Object.getPrototypeOf(clonedState.songs), null);
  assert.equal(Object.getPrototypeOf(clonedState.songSharingReviews), null);
  assert.equal(clonedState.songSharingReviews.constructor, undefined);
  assert.equal(
    await restarted.getSongSharingReview(connectionId, 'constructor'),
    null
  );
  for (const syncId of reservedIds) {
    assert.equal((await restarted.getSongState(connectionId, syncId)).syncId, syncId);
  }
  const documents = (await restarted.getSongState(connectionId, 'document-family')).documents;
  for (const id of reservedIds) {
    assert.equal(Object.hasOwn(documents, id), true);
    assert.equal(documents[id].localRevision.length, 64);
  }
});

test('song sharing review uses the store clock and round-trips as an isolated audit record', async t => {
  const root = await tempDirectory(t);
  const storageRoot = path.join(root, 'state');
  const reviewedAt = '2026-07-27T19:45:00.000Z';
  const store = new CommunitySyncStateStore({
    storageRoot,
    now: () => new Date(reviewedAt)
  });
  const connectionId = 'connection-00000007';
  const familyId = 'reviewed-family';

  const review = await store.confirmSongSharingReview(connectionId, familyId, {
    basis: 'direct-permission',
    evidence: 'Email from the rights holder dated 2026-07-26.',
    validUntil: '2027-07-26',
    familyRevision: REVIEWED_FAMILY_REVISION
  });
  assert.deepEqual(review, {
    scope: 'community-members',
    basis: 'direct-permission',
    evidence: 'Email from the rights holder dated 2026-07-26.',
    validUntil: '2027-07-26',
    reviewedAt,
    familyRevision: REVIEWED_FAMILY_REVISION
  });

  assert.throws(
    () => store.confirmSongSharingReview(connectionId, familyId, {
      basis: 'public-domain',
      familyRevision: REVIEWED_FAMILY_REVISION,
      reviewedAt: '2000-01-01T00:00:00.000Z'
    }),
    error => error instanceof CommunitySyncStateStoreError
      && error.code === 'INVALID_SHARING_REVIEW'
  );

  const restarted = new CommunitySyncStateStore({ storageRoot });
  const persisted = await restarted.getSongSharingReview(connectionId, familyId);
  assert.deepEqual(persisted, review);
  persisted.evidence = 'caller mutation';
  assert.equal(
    (await restarted.getSongSharingReview(connectionId, familyId)).evidence,
    review.evidence
  );
});

test('whole-state checkpoints cannot erase, resurrect, or mint song sharing reviews', async t => {
  const root = await tempDirectory(t);
  const storageRoot = path.join(root, 'state');
  const store = new CommunitySyncStateStore({
    storageRoot,
    now: () => new Date('2026-07-27T20:00:00.000Z')
  });
  const connectionId = 'connection-00000008';
  const familyId = 'snapshot-family';
  const staleBeforeConfirmation = await store.getConnectionState(connectionId);

  const confirmed = await store.confirmSongSharingReview(connectionId, familyId, {
    basis: 'public-domain',
    familyRevision: REVIEWED_FAMILY_REVISION
  });
  staleBeforeConfirmation.cursor = 'checkpoint-after-confirmation';
  await store.saveConnectionState(connectionId, staleBeforeConfirmation);
  assert.equal(
    (await store.getSongSharingReview(connectionId, familyId)).familyRevision,
    REVIEWED_FAMILY_REVISION,
    'a stale sync snapshot must not erase a newer review'
  );

  const staleBeforeClear = await store.getConnectionState(connectionId);
  await store.clearSongSharingReview(connectionId, familyId, {
    expectedFamilyRevision: REVIEWED_FAMILY_REVISION,
    expectedReviewRevision: songSharingReviewRevision(confirmed)
  });
  staleBeforeClear.cursor = 'checkpoint-after-clear';
  await store.saveConnectionState(connectionId, staleBeforeClear);
  assert.equal(
    await store.getSongSharingReview(connectionId, familyId),
    null,
    'a stale sync snapshot must not resurrect a cleared review'
  );

  const forgedSnapshot = await store.getConnectionState(connectionId);
  forgedSnapshot.songSharingReviews[familyId] = {
    scope: 'community-members',
    basis: 'public-domain',
    evidence: null,
    validUntil: null,
    reviewedAt: '2000-01-01T00:00:00.000Z',
    familyRevision: REVIEWED_FAMILY_REVISION
  };
  await store.saveConnectionState(connectionId, forgedSnapshot);
  assert.equal(
    await store.getSongSharingReview(connectionId, familyId),
    null,
    'generic state persistence must not mint a store-owned review draft'
  );
});

test('song sharing review clearing is revision-CAS protected and connection removal deletes it', async t => {
  const root = await tempDirectory(t);
  const storageRoot = path.join(root, 'state');
  const store = new CommunitySyncStateStore({
    storageRoot,
    now: () => new Date('2026-07-27T20:15:00.000Z')
  });
  const connectionId = 'connection-00000009';
  const familyId = 'cas-family';
  const newerRevision = 'e'.repeat(64);

  const originalReview = await store.confirmSongSharingReview(connectionId, familyId, {
    basis: 'original-work',
    familyRevision: REVIEWED_FAMILY_REVISION
  });
  const newerReview = await store.confirmSongSharingReview(connectionId, familyId, {
    basis: 'original-work',
    familyRevision: newerRevision,
    expectedReviewRevision: songSharingReviewRevision(originalReview)
  });

  await assert.rejects(
    store.clearSongSharingReview(connectionId, familyId, {
      expectedFamilyRevision: REVIEWED_FAMILY_REVISION,
      expectedReviewRevision: songSharingReviewRevision(originalReview)
    }),
    error => error instanceof CommunitySyncStateStoreError
      && error.code === 'STATE_CONFLICT'
  );
  assert.equal(
    (await store.getSongSharingReview(connectionId, familyId)).familyRevision,
    newerRevision
  );

  assert.deepEqual(
    await store.clearSongSharingReview(connectionId, familyId, {
      expectedFamilyRevision: newerRevision,
      expectedReviewRevision: songSharingReviewRevision(newerReview)
    }),
    { removed: true }
  );
  await store.confirmSongSharingReview(connectionId, familyId, {
    basis: 'original-work',
    familyRevision: newerRevision
  });
  assert.deepEqual(await store.removeConnectionState(connectionId), { removed: true });
  assert.equal(await store.getSongSharingReview(connectionId, familyId), null);
});

test('song sharing review confirmation and clearing use the exact saved review as CAS', async t => {
  const root = await tempDirectory(t);
  const storageRoot = path.join(root, 'state');
  let reviewedAt = '2026-07-27T20:20:00.000Z';
  const store = new CommunitySyncStateStore({
    storageRoot,
    now: () => new Date(reviewedAt)
  });
  const connectionId = 'connection-00000011';
  const familyId = 'same-family-review-cas';

  const first = await store.confirmSongSharingReview(connectionId, familyId, {
    basis: 'direct-permission',
    evidence: 'First permission record.',
    familyRevision: REVIEWED_FAMILY_REVISION
  });
  const firstRevision = songSharingReviewRevision(first);
  reviewedAt = '2026-07-27T20:21:00.000Z';
  const second = await store.confirmSongSharingReview(connectionId, familyId, {
    basis: 'direct-permission',
    evidence: 'Newer permission record.',
    familyRevision: REVIEWED_FAMILY_REVISION,
    expectedReviewRevision: firstRevision
  });

  await assert.rejects(
    store.confirmSongSharingReview(connectionId, familyId, {
      basis: 'public-domain',
      familyRevision: REVIEWED_FAMILY_REVISION,
      expectedReviewRevision: firstRevision
    }),
    error => error instanceof CommunitySyncStateStoreError
      && error.code === 'STATE_CONFLICT'
  );
  await assert.rejects(
    store.clearSongSharingReview(connectionId, familyId, {
      expectedFamilyRevision: REVIEWED_FAMILY_REVISION,
      expectedReviewRevision: firstRevision
    }),
    error => error instanceof CommunitySyncStateStoreError
      && error.code === 'STATE_CONFLICT'
  );
  assert.equal(
    (await store.getSongSharingReview(connectionId, familyId)).evidence,
    second.evidence
  );

  assert.deepEqual(
    await store.clearSongSharingReview(connectionId, familyId, {
      expectedFamilyRevision: REVIEWED_FAMILY_REVISION,
      expectedReviewRevision: songSharingReviewRevision(second)
    }),
    { removed: true }
  );
});

test('song sharing review capacity permits replacement but rejects a 10,001st family', async t => {
  const root = await tempDirectory(t);
  const storageRoot = path.join(root, 'state');
  const connectionId = 'connection-00000010';
  const reviewedAt = '2026-07-27T20:30:00.000Z';
  const reviews = Object.create(null);
  for (let index = 0; index < 10000; index += 1) {
    reviews[`family-${String(index).padStart(5, '0')}`] = {
      scope: 'community-members',
      basis: 'public-domain',
      evidence: null,
      validUntil: null,
      reviewedAt,
      familyRevision: REVIEWED_FAMILY_REVISION
    };
  }
  await fs.mkdir(storageRoot, { recursive: true, mode: 0o700 });
  await fs.writeFile(
    path.join(storageRoot, 'sync-state.json'),
    `${JSON.stringify({
      schemaVersion: 4,
      connections: {
        [connectionId]: {
          cursor: null,
          lastSyncAt: null,
          songs: {},
          songSharingReviews: reviews,
          sermonCursor: null,
          lastSermonSyncAt: null,
          sermons: {}
        }
      }
    })}\n`,
    { mode: 0o600 }
  );
  const store = new CommunitySyncStateStore({
    storageRoot,
    now: () => new Date('2026-07-27T20:31:00.000Z')
  });

  const replacement = await store.confirmSongSharingReview(
    connectionId,
    'family-09999',
    {
      basis: 'original-work',
      familyRevision: 'e'.repeat(64),
      expectedReviewRevision: songSharingReviewRevision(
        await store.getSongSharingReview(connectionId, 'family-09999')
      )
    }
  );
  assert.equal(replacement.basis, 'original-work');
  assert.equal(replacement.familyRevision, 'e'.repeat(64));

  await assert.rejects(
    store.confirmSongSharingReview(connectionId, 'family-over-cap', {
      basis: 'public-domain',
      familyRevision: 'f'.repeat(64)
    }),
    error => error instanceof CommunitySyncStateStoreError
      && error.code === 'INVALID_STATE'
  );
});
