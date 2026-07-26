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
  CommunitySyncStateStore
} = require('../src/services/community/CommunitySyncStateStore');

const ACCESS_TOKEN = 'community-access-token-secret-000001';
const REFRESH_TOKEN = 'community-refresh-token-secret-0001';

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
  for (const syncId of reservedIds) {
    assert.equal((await restarted.getSongState(connectionId, syncId)).syncId, syncId);
  }
  const documents = (await restarted.getSongState(connectionId, 'document-family')).documents;
  for (const id of reservedIds) {
    assert.equal(Object.hasOwn(documents, id), true);
    assert.equal(documents[id].localRevision.length, 64);
  }
});
