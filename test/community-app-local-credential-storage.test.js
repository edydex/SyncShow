'use strict';

const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  AppLocalCredentialStorage,
  KEY_BYTES,
  PAYLOAD_MAGIC
} = require('../src/services/community/AppLocalCredentialStorage');
const {
  CommunityConnectionStore,
  CommunityConnectionStoreError
} = require('../src/services/community/CommunityConnectionStore');

const ACCESS_TOKEN = 'community-access-token-secret-000001';

function connectionInput() {
  return {
    id: 'connection-local-vault-0001',
    serverId: 'wotbc-community',
    serverName: 'WOTBC Community',
    baseUrl: 'https://community.example.test/',
    apiBaseUrl: 'https://community.example.test/api/community/syncshow/v1',
    account: {
      id: 'admin-1',
      email: 'admin@example.test',
      name: 'Church Admin'
    },
    scopes: ['syncshow:service-documents:read'],
    advertisedScopes: ['syncshow:service-documents:read'],
    accessToken: ACCESS_TOKEN,
    refreshToken: null,
    expiresAt: '2099-08-23T20:00:00.000Z'
  };
}

async function tempDirectory(t) {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), 'syncshow-community-local-vault-')
  );
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return fs.realpath(directory);
}

test('Community local vault encrypts credentials and survives app restart', async t => {
  const root = await tempDirectory(t);
  const storageRoot = path.join(root, 'credentials');
  const storage = new AppLocalCredentialStorage({ storageRoot });
  const payload = await storage.encryptStringAsync(ACCESS_TOKEN);

  assert.equal(payload.subarray(0, PAYLOAD_MAGIC.length).equals(PAYLOAD_MAGIC), true);
  assert.equal(payload.includes(Buffer.from(ACCESS_TOKEN)), false);
  assert.deepEqual(await storage.decryptStringAsync(payload), {
    result: ACCESS_TOKEN
  });

  const keyPath = path.join(storageRoot, 'device.key');
  const key = await fs.readFile(keyPath);
  const directoryStats = await fs.stat(storageRoot);
  const keyStats = await fs.stat(keyPath);
  assert.equal(key.length, KEY_BYTES);
  if (process.platform !== 'win32') {
    assert.equal(directoryStats.mode & 0o077, 0);
    assert.equal(keyStats.mode & 0o077, 0);
  }

  const restarted = new AppLocalCredentialStorage({ storageRoot });
  assert.deepEqual(await restarted.decryptStringAsync(payload), {
    result: ACCESS_TOKEN
  });
});

test('Community local vault requires reconnect for legacy or tampered ciphertext', async t => {
  const root = await tempDirectory(t);
  const storage = new AppLocalCredentialStorage({
    storageRoot: path.join(root, 'credentials')
  });
  const payload = await storage.encryptStringAsync(ACCESS_TOKEN);
  const tampered = Buffer.from(payload);
  tampered[tampered.length - 1] ^= 0xff;

  for (const ciphertext of [tampered, Buffer.from('legacy-electron-safe-storage')]) {
    await assert.rejects(
      storage.decryptStringAsync(ciphertext),
      error => error.code === 'CREDENTIAL_RECONNECT_REQUIRED'
    );
  }
});

test('Community connection remains approved across app restarts', async t => {
  const root = await tempDirectory(t);
  const connectionRoot = path.join(root, 'community');
  const credentialRoot = path.join(connectionRoot, 'credentials');
  const firstRun = new CommunityConnectionStore({
    storageRoot: connectionRoot,
    safeStorage: new AppLocalCredentialStorage({ storageRoot: credentialRoot })
  });
  const saved = await firstRun.saveConnection(connectionInput());

  const serialized = await fs.readFile(
    path.join(connectionRoot, 'connections.json'),
    'utf8'
  );
  assert.equal(serialized.includes(ACCESS_TOKEN), false);

  const restarted = new CommunityConnectionStore({
    storageRoot: connectionRoot,
    safeStorage: new AppLocalCredentialStorage({ storageRoot: credentialRoot })
  });
  assert.equal((await restarted.listConnections()).length, 1);
  assert.equal((await restarted.getConnection(saved.id)).accessToken, ACCESS_TOKEN);
});

test('legacy Keychain ciphertext becomes a one-time Community reapproval', async t => {
  const root = await tempDirectory(t);
  const connectionRoot = path.join(root, 'community');
  const legacyStore = new CommunityConnectionStore({
    storageRoot: connectionRoot,
    safeStorage: {
      isEncryptionAvailable: () => true,
      encryptString: () => Buffer.from('legacy-electron-safe-storage'),
      decryptString: () => {
        throw new Error('Legacy storage should not be opened');
      }
    }
  });
  const saved = await legacyStore.saveConnection(connectionInput());
  const storePath = path.join(connectionRoot, 'connections.json');
  const legacyRecords = JSON.parse(await fs.readFile(storePath, 'utf8'));
  legacyRecords.connections[0].secret.format = 'electron-safe-storage-v1';
  await fs.writeFile(storePath, `${JSON.stringify(legacyRecords)}\n`, {
    encoding: 'utf8',
    mode: 0o600
  });

  const updatedStore = new CommunityConnectionStore({
    storageRoot: connectionRoot,
    safeStorage: new AppLocalCredentialStorage({
      storageRoot: path.join(connectionRoot, 'credentials')
    })
  });
  await assert.rejects(
    updatedStore.getConnection(saved.id),
    error => error instanceof CommunityConnectionStoreError
      && error.code === 'CREDENTIAL_RECONNECT_REQUIRED'
      && /Community admin account/.test(error.message)
      && /No computer password/.test(error.message)
  );
});
