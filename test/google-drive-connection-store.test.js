'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');

const {
  DriveConnectionStore,
  DriveConnectionStoreError
} = require('../src/services/google-drive/DriveConnectionStore');

const PRIVATE_FOLDER_ID = 'privateFolder123456789';
const PUBLIC_FOLDER_ID = 'publicFolder1234567890';
const REFRESH_TOKEN = 'super-secret-google-refresh-token';

async function tempDirectory(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'syncshow-drive-store-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return fs.realpath(directory);
}

function encryptedSafeStorage({ backend = 'keychain', available = true } = {}) {
  return {
    isEncryptionAvailable: () => available,
    getSelectedStorageBackend: () => backend,
    encryptString: value => Buffer.from(`encrypted:${Buffer.from(value).toString('base64')}`),
    decryptString: value => {
      const serialized = value.toString();
      if (!serialized.startsWith('encrypted:')) throw new Error('not encrypted');
      return Buffer.from(serialized.slice('encrypted:'.length), 'base64').toString();
    }
  };
}

function encryptedAsyncSafeStorage({
  available = true,
  failEncryption = false,
  synchronousAvailable = false
} = {}) {
  const calls = [];
  return {
    calls,
    isAsyncEncryptionAvailable: async () => {
      calls.push('async-available');
      return available;
    },
    encryptStringAsync: async value => {
      calls.push('async-encrypt');
      if (failEncryption) throw new Error('credential store locked');
      return Buffer.from(`async-encrypted:${Buffer.from(value).toString('base64')}`);
    },
    decryptStringAsync: async value => {
      calls.push('async-decrypt');
      const serialized = value.toString();
      if (!serialized.startsWith('async-encrypted:')) throw new Error('not encrypted');
      return {
        result: Buffer.from(serialized.slice('async-encrypted:'.length), 'base64').toString(),
        shouldReEncrypt: false
      };
    },
    isEncryptionAvailable: () => {
      calls.push('sync-available');
      return synchronousAvailable;
    },
    encryptString: () => {
      calls.push('sync-encrypt');
      throw new Error('synchronous encryption must not be used');
    },
    decryptString: () => {
      calls.push('sync-decrypt');
      throw new Error('synchronous decryption must not be used');
    }
  };
}

function writableCapabilities() {
  return {
    canListChildren: true,
    canAddChildren: true,
    canDownload: true,
    canEdit: true,
    canModifyContent: true
  };
}

test('async OS credential storage is preferred and passes a real preflight round trip', async t => {
  const root = await tempDirectory(t);
  const safeStorage = encryptedAsyncSafeStorage();
  const store = new DriveConnectionStore({
    storageRoot: path.join(root, 'google-drive'),
    platform: 'darwin',
    safeStorage,
    randomUUID: () => 'private-async-connection'
  });

  assert.equal(await store.assertSecureStorageAvailable(), true);
  const summary = await store.savePrivateConnection({
    folderId: PRIVATE_FOLDER_ID,
    folderName: 'Async private folder',
    refreshToken: REFRESH_TOKEN
  });
  assert.equal((await store.getConnection(summary.id)).refreshToken, REFRESH_TOKEN);
  assert.ok(safeStorage.calls.includes('async-encrypt'));
  assert.ok(safeStorage.calls.includes('async-decrypt'));
  assert.equal(safeStorage.calls.includes('sync-encrypt'), false);
  assert.equal(safeStorage.calls.includes('sync-decrypt'), false);
});

test('preflight refuses OAuth when availability claims succeed but encryption fails', async t => {
  const root = await tempDirectory(t);
  const store = new DriveConnectionStore({
    storageRoot: path.join(root, 'google-drive'),
    platform: 'darwin',
    safeStorage: encryptedAsyncSafeStorage({ failEncryption: true })
  });

  await assert.rejects(
    store.assertSecureStorageAvailable(),
    error => error instanceof DriveConnectionStoreError
      && error.code === 'SECURE_STORAGE_UNAVAILABLE'
      && /Mac login keychain/.test(error.message)
      && !/credential store locked/.test(error.message)
  );
  await assert.rejects(
    fs.access(path.join(root, 'google-drive', 'connections.json')),
    error => error.code === 'ENOENT'
  );
});

test('preflight fails closed on a malformed secure-storage round trip', async t => {
  const root = await tempDirectory(t);
  const safeStorage = encryptedAsyncSafeStorage();
  safeStorage.decryptStringAsync = async () => ({
    result: 'wrong-probe-result',
    shouldReEncrypt: false
  });
  const store = new DriveConnectionStore({
    storageRoot: path.join(root, 'google-drive'),
    platform: 'darwin',
    safeStorage
  });

  await assert.rejects(
    store.assertSecureStorageAvailable(),
    error => error.code === 'SECURE_STORAGE_UNAVAILABLE'
  );
});

test('an incomplete async API falls back only to a complete secure sync API', async t => {
  const root = await tempDirectory(t);
  const safeStorage = {
    ...encryptedSafeStorage(),
    isAsyncEncryptionAvailable: async () => true
  };
  const store = new DriveConnectionStore({
    storageRoot: path.join(root, 'google-drive'),
    safeStorage
  });
  assert.equal(await store.assertSecureStorageAvailable(), true);

  assert.throws(
    () => new DriveConnectionStore({
      storageRoot: path.join(root, 'invalid'),
      safeStorage: {
        isAsyncEncryptionAvailable: async () => true,
        encryptStringAsync: async value => Buffer.from(value)
      }
    }),
    /requires Electron safeStorage/
  );
});

test('private connections persist only encrypted refresh tokens with owner-only permissions', async t => {
  const root = await tempDirectory(t);
  const store = new DriveConnectionStore({
    storageRoot: path.join(root, 'google-drive'),
    safeStorage: encryptedSafeStorage(),
    randomUUID: () => 'private-connection-one',
    now: () => new Date('2026-07-23T12:00:00.000Z')
  });
  const summary = await store.savePrivateConnection({
    folderId: PRIVATE_FOLDER_ID,
    folderName: 'Sunday Services',
    resourceKey: 'private_key',
    accountEmail: 'operator@example.com',
    accountName: 'Church Operator',
    capabilities: writableCapabilities(),
    refreshToken: REFRESH_TOKEN,
    writeEnabled: false
  });

  assert.deepEqual(summary, {
    id: 'private-connection-one',
    kind: 'private',
    folderName: 'Sunday Services',
    accountEmail: 'operator@example.com',
    accountName: 'Church Operator',
    canWrite: true,
    writeEnabled: false,
    access: 'read-only',
    createdAt: '2026-07-23T12:00:00.000Z',
    updatedAt: '2026-07-23T12:00:00.000Z'
  });
  assert.equal(Object.hasOwn(summary, 'folderId'), false);
  assert.equal(Object.hasOwn(summary, 'resourceKey'), false);
  assert.equal(Object.hasOwn(summary, 'refreshToken'), false);

  const storePath = path.join(root, 'google-drive', 'connections.json');
  const serialized = await fs.readFile(storePath, 'utf8');
  assert.equal(serialized.includes(REFRESH_TOKEN), false);
  assert.equal(serialized.includes('encrypted:'), false, 'ciphertext itself is base64 encoded');
  if (process.platform !== 'win32') {
    assert.equal((await fs.stat(storePath)).mode & 0o077, 0);
    assert.equal((await fs.stat(path.dirname(storePath))).mode & 0o077, 0);
  }

  const connection = await store.getConnection('private-connection-one');
  assert.equal(connection.folderId, PRIVATE_FOLDER_ID);
  assert.equal(connection.resourceKey, 'private_key');
  assert.equal(connection.refreshToken, REFRESH_TOKEN);
  assert.equal(connection.writeEnabled, false);
  assert.equal(JSON.stringify(await store.listConnections()).includes(REFRESH_TOKEN), false);
});

test('private write access is explicit and public links remain read-only', async t => {
  const root = await tempDirectory(t);
  let id = 0;
  const store = new DriveConnectionStore({
    storageRoot: path.join(root, 'google-drive'),
    safeStorage: encryptedSafeStorage(),
    randomUUID: () => `connection-${String(++id).padStart(8, '0')}`
  });
  const privateSummary = await store.savePrivateConnection({
    folderId: PRIVATE_FOLDER_ID,
    folderName: 'Private',
    refreshToken: REFRESH_TOKEN,
    capabilities: writableCapabilities(),
    writeEnabled: false
  });
  const enabled = await store.setWriteEnabled(privateSummary.id, true);
  assert.equal(enabled.access, 'read-write');
  assert.equal((await store.getConnection(privateSummary.id)).writeEnabled, true);

  const publicSummary = await store.savePublicConnection({
    folderId: PUBLIC_FOLDER_ID,
    folderName: 'Public Services',
    resourceKey: 'public_key',
    capabilities: writableCapabilities(),
    writeEnabled: true
  });
  assert.equal(publicSummary.canWrite, false);
  assert.equal(publicSummary.writeEnabled, false);
  assert.equal(publicSummary.access, 'read-only');
  assert.equal((await store.getConnection(publicSummary.id)).refreshToken, null);
  await assert.rejects(
    store.setWriteEnabled(publicSummary.id, true),
    error => error instanceof DriveConnectionStoreError && error.code === 'PUBLIC_WRITE_FORBIDDEN'
  );
  await assert.rejects(
    store.savePublicConnection({
      folderId: PUBLIC_FOLDER_ID,
      refreshToken: 'forbidden'
    }),
    error => error.code === 'PUBLIC_CREDENTIAL_FORBIDDEN'
  );
});

test('Linux basic_text and unavailable encryption refuse refresh-token persistence', async t => {
  const root = await tempDirectory(t);
  const basicTextStore = new DriveConnectionStore({
    storageRoot: path.join(root, 'basic-text'),
    platform: 'linux',
    safeStorage: encryptedSafeStorage({ backend: 'basic_text' })
  });
  await assert.rejects(
    basicTextStore.savePrivateConnection({
      folderId: PRIVATE_FOLDER_ID,
      refreshToken: REFRESH_TOKEN
    }),
    error => error.code === 'INSECURE_SECRET_STORAGE'
  );
  const asyncBasicTextStore = new DriveConnectionStore({
    storageRoot: path.join(root, 'async-basic-text'),
    platform: 'linux',
    safeStorage: {
      ...encryptedAsyncSafeStorage(),
      getSelectedStorageBackend: () => 'basic_text'
    }
  });
  await assert.rejects(
    asyncBasicTextStore.assertSecureStorageAvailable(),
    error => error.code === 'INSECURE_SECRET_STORAGE'
  );

  const unavailableStore = new DriveConnectionStore({
    storageRoot: path.join(root, 'unavailable'),
    platform: 'darwin',
    safeStorage: encryptedSafeStorage({ available: false })
  });
  await assert.rejects(
    unavailableStore.savePrivateConnection({
      folderId: PRIVATE_FOLDER_ID,
      refreshToken: REFRESH_TOKEN
    }),
    error => error.code === 'SECURE_STORAGE_UNAVAILABLE'
  );
  const files = await fs.readdir(path.join(root, 'basic-text'));
  assert.equal(files.includes('connections.json'), false);
});

test('disconnect deletes local credentials even when remote revocation fails and runs hooks', async t => {
  const root = await tempDirectory(t);
  const revoked = [];
  const disconnected = [];
  const store = new DriveConnectionStore({
    storageRoot: path.join(root, 'google-drive'),
    safeStorage: encryptedSafeStorage(),
    randomUUID: () => 'private-connection-two',
    revokeToken: async (token, summary) => {
      revoked.push({ token, summary });
      throw new Error('offline');
    },
    onDisconnect: async (summary, result) => {
      disconnected.push({ summary, result });
    }
  });
  await store.savePrivateConnection({
    folderId: PRIVATE_FOLDER_ID,
    folderName: 'Private',
    refreshToken: REFRESH_TOKEN,
    capabilities: writableCapabilities()
  });

  const result = await store.disconnect('private-connection-two');
  assert.deepEqual(result, {
    disconnected: true,
    remoteRevoked: false,
    warningCode: 'REMOTE_REVOCATION_FAILED'
  });
  assert.equal(revoked[0].token, REFRESH_TOKEN);
  assert.equal(Object.hasOwn(revoked[0].summary, 'folderId'), false);
  assert.equal(disconnected.length, 1);
  assert.equal(await store.getConnection('private-connection-two'), null);
  assert.deepEqual(await store.listConnections(), []);
});
