'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');

const {
  MAX_SHOW_REHEARSAL_RECEIPT_BYTES,
  SHOW_REHEARSAL_RECEIPT_FILE,
  SHOW_REHEARSAL_RECEIPT_KIND,
  SHOW_REHEARSAL_RECEIPT_SCHEMA_VERSION,
  ShowRehearsalReceiptError,
  ShowRehearsalReceiptStore,
  ShowRehearsalReceiptStoreError,
  serializeShowRehearsalReceipt
} = require('../src/services/show');
const {
  atomicWriteFile,
  fsyncDirectory
} = require('../src/services/project/StorageSafety');

const HASHES = Object.freeze({
  package: 'a'.repeat(64),
  manifest: 'b'.repeat(64),
  asset: 'c'.repeat(64),
  venue: 'd'.repeat(64)
});

async function tempDirectory(t, prefix) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return directory;
}

function receipt(overrides = {}) {
  return {
    schemaVersion: SHOW_REHEARSAL_RECEIPT_SCHEMA_VERSION,
    kind: SHOW_REHEARSAL_RECEIPT_KIND,
    show: {
      kind: 'show-package',
      packageId: `show-${HASHES.package}`,
      manifestRevisionId: HASHES.manifest,
      assets: [{
        assetId: 'channel-primary',
        revisionId: HASHES.asset
      }]
    },
    venueProfile: {
      id: 'main-sanctuary',
      revisionId: HASHES.venue
    },
    routing: [{
      outputId: 'front',
      displayId: 2,
      decision: 'direct',
      sourceRoleId: 'primary',
      sourceAssetId: 'channel-primary',
      renderer: 'native-cue',
      nativeVariant: null,
      operatorPreview: false
    }],
    cueCount: 1,
    cueIds: ['cue-0123456789abcdef01234567'],
    acknowledgements: [{
      cueId: 'cue-0123456789abcdef01234567',
      outputIds: ['front']
    }],
    ...overrides
  };
}

function expectStoreCode(...codes) {
  return error => {
    assert.ok(
      error instanceof ShowRehearsalReceiptStoreError,
      `expected ShowRehearsalReceiptStoreError, got ${error?.constructor?.name}`
    );
    assert.ok(
      codes.includes(error.code),
      `expected ${codes.join(' or ')}, got ${error.code}`
    );
    return true;
  };
}

test('requires an absolute root and initializes a private empty store', async t => {
  assert.throws(
    () => new ShowRehearsalReceiptStore({ rootPath: 'relative' }),
    /absolute rootPath/
  );
  assert.throws(
    () => new ShowRehearsalReceiptStore({
      rootPath: path.resolve('/tmp/receipt-store'),
      atomicWrite: true
    }),
    /atomicWrite must be a function/
  );
  assert.throws(
    () => new ShowRehearsalReceiptStore({
      rootPath: path.resolve('/tmp/receipt-store'),
      syncDirectory: true
    }),
    /syncDirectory must be a function/
  );

  const workspace = await tempDirectory(
    t,
    'syncshow-rehearsal-store-init-'
  );
  const rootPath = path.join(workspace, 'receipts');
  const store = new ShowRehearsalReceiptStore({ rootPath });

  assert.equal(await store.read(), null);
  const stats = await fs.lstat(rootPath);
  assert.equal(stats.isDirectory(), true);
  assert.equal(stats.isSymbolicLink(), false);
  if (process.platform !== 'win32') {
    assert.equal(stats.mode & 0o777, 0o700);
  }
  assert.deepEqual(await fs.readdir(rootPath), []);
});

test('writes one canonical owner-only receipt and reopens it exactly', async t => {
  const workspace = await tempDirectory(
    t,
    'syncshow-rehearsal-store-write-'
  );
  const rootPath = path.join(workspace, 'receipts');
  const atomicCalls = [];
  const store = new ShowRehearsalReceiptStore({
    rootPath,
    atomicWrite: async (...args) => {
      atomicCalls.push(args);
      return atomicWriteFile(...args);
    }
  });

  const saved = await store.write(receipt());
  assert.deepEqual(saved, receipt());
  assert.equal(Object.isFrozen(saved), true);
  assert.equal(Object.isFrozen(saved.acknowledgements[0].outputIds), true);
  assert.equal(atomicCalls.length, 1);
  assert.equal(
    atomicCalls[0][0],
    path.join(store.rootPath, SHOW_REHEARSAL_RECEIPT_FILE)
  );
  assert.deepEqual(atomicCalls[0][2], {
    maximumBytes: MAX_SHOW_REHEARSAL_RECEIPT_BYTES,
    mode: 0o600,
    rootPath: store.rootPath
  });

  const receiptPath = path.join(rootPath, SHOW_REHEARSAL_RECEIPT_FILE);
  assert.equal(
    await fs.readFile(receiptPath, 'utf8'),
    serializeShowRehearsalReceipt(saved)
  );
  const stats = await fs.lstat(receiptPath);
  assert.equal(stats.isFile(), true);
  assert.equal(stats.isSymbolicLink(), false);
  if (process.platform !== 'win32') {
    assert.equal(stats.mode & 0o777, 0o600);
  }
  assert.deepEqual(await fs.readdir(rootPath), [
    SHOW_REHEARSAL_RECEIPT_FILE
  ]);

  const reopened = await new ShowRehearsalReceiptStore({
    rootPath
  }).read();
  assert.deepEqual(reopened, saved);
  assert.equal(Object.isFrozen(reopened), true);
});

test('invalid input is rejected before the store creates or replaces files', async t => {
  const workspace = await tempDirectory(
    t,
    'syncshow-rehearsal-store-invalid-'
  );
  const rootPath = path.join(workspace, 'receipts');
  const store = new ShowRehearsalReceiptStore({ rootPath });
  const invalid = receipt({ extra: true });

  assert.throws(
    () => store.write(invalid),
    error => error instanceof ShowRehearsalReceiptError
  );
  await assert.rejects(fs.lstat(rootPath), { code: 'ENOENT' });

  const saved = await store.write(receipt());
  assert.throws(
    () => store.write(invalid),
    error => error instanceof ShowRehearsalReceiptError
  );
  assert.deepEqual(await store.read(), saved);
});

test('malformed, noncanonical, oversized, and publicly readable files never become ready', async t => {
  const workspace = await tempDirectory(
    t,
    'syncshow-rehearsal-store-corrupt-'
  );
  const rootPath = path.join(workspace, 'receipts');
  const store = new ShowRehearsalReceiptStore({ rootPath });
  await store.initialize();
  const receiptPath = path.join(rootPath, SHOW_REHEARSAL_RECEIPT_FILE);

  await fs.writeFile(receiptPath, '{not-json}\n', { mode: 0o600 });
  await assert.rejects(
    store.read(),
    expectStoreCode('SHOW_REHEARSAL_RECEIPT_STORE_CORRUPT')
  );

  const canonical = serializeShowRehearsalReceipt(receipt());
  await fs.writeFile(receiptPath, canonical.slice(0, -1), { mode: 0o600 });
  await assert.rejects(
    store.read(),
    expectStoreCode('SHOW_REHEARSAL_RECEIPT_STORE_CORRUPT')
  );

  await fs.truncate(receiptPath, MAX_SHOW_REHEARSAL_RECEIPT_BYTES + 1);
  await assert.rejects(
    store.read(),
    expectStoreCode('SHOW_REHEARSAL_RECEIPT_STORE_CORRUPT')
  );

  await fs.writeFile(receiptPath, canonical, { mode: 0o600 });
  if (process.platform !== 'win32') {
    await fs.chmod(receiptPath, 0o644);
    await assert.rejects(
      store.read(),
      expectStoreCode('SHOW_REHEARSAL_RECEIPT_STORE_UNSAFE')
    );
  }
});

test('receipt symlinks and symlinked roots are rejected without following them', async t => {
  const workspace = await tempDirectory(
    t,
    'syncshow-rehearsal-store-symlink-'
  );
  const rootPath = path.join(workspace, 'receipts');
  const store = new ShowRehearsalReceiptStore({ rootPath });
  await store.initialize();

  const outsidePath = path.join(workspace, 'outside.json');
  const outsideSource = serializeShowRehearsalReceipt(receipt());
  await fs.writeFile(outsidePath, outsideSource, { mode: 0o600 });
  try {
    await fs.symlink(
      outsidePath,
      path.join(rootPath, SHOW_REHEARSAL_RECEIPT_FILE),
      'file'
    );
  } catch (error) {
    if (['EPERM', 'EACCES', 'ENOSYS'].includes(error.code)) {
      t.skip(`symbolic links are unavailable: ${error.code}`);
      return;
    }
    throw error;
  }

  await assert.rejects(
    store.read(),
    expectStoreCode('SHOW_REHEARSAL_RECEIPT_STORE_UNSAFE')
  );
  await assert.rejects(
    store.clear(),
    expectStoreCode('SHOW_REHEARSAL_RECEIPT_STORE_UNSAFE')
  );
  assert.equal(await fs.readFile(outsidePath, 'utf8'), outsideSource);

  const realRoot = path.join(workspace, 'real-root');
  const linkedRoot = path.join(workspace, 'linked-root');
  await fs.mkdir(realRoot, { mode: 0o700 });
  await fs.symlink(realRoot, linkedRoot, 'dir');
  await assert.rejects(
    new ShowRehearsalReceiptStore({
      rootPath: linkedRoot
    }).initialize(),
    expectStoreCode('SHOW_REHEARSAL_RECEIPT_STORE_UNSAFE')
  );
});

test('clear removes only the exact receipt and durably preserves unrelated files', async t => {
  const workspace = await tempDirectory(
    t,
    'syncshow-rehearsal-store-clear-'
  );
  const rootPath = path.join(workspace, 'receipts');
  const syncCalls = [];
  const store = new ShowRehearsalReceiptStore({
    rootPath,
    syncDirectory: async directoryPath => {
      syncCalls.push(directoryPath);
      await fsyncDirectory(directoryPath);
    }
  });
  await store.write(receipt());
  const sentinelPath = path.join(rootPath, 'keep-me.txt');
  await fs.writeFile(sentinelPath, 'preserve', { mode: 0o600 });

  assert.equal(await store.clear('../outside.json'), true);
  assert.equal(await store.read(), null);
  assert.equal(await fs.readFile(sentinelPath, 'utf8'), 'preserve');
  assert.deepEqual(syncCalls, [store.rootPath]);
  assert.equal(await store.clear(), false);
  assert.equal(await fs.readFile(sentinelPath, 'utf8'), 'preserve');
});

test('a post-publication error is reconciled only after another directory fsync', async t => {
  const workspace = await tempDirectory(
    t,
    'syncshow-rehearsal-store-reconcile-'
  );
  const rootPath = path.join(workspace, 'receipts');
  const syncCalls = [];
  const store = new ShowRehearsalReceiptStore({
    rootPath,
    atomicWrite: async (...args) => {
      await atomicWriteFile(...args);
      const error = new Error('simulated post-publication failure');
      error.code = 'POST_PUBLISH';
      throw error;
    },
    syncDirectory: async directoryPath => {
      syncCalls.push(directoryPath);
      await fsyncDirectory(directoryPath);
    }
  });

  const saved = await store.write(receipt());
  assert.deepEqual(await store.read(), saved);
  assert.deepEqual(syncCalls, [store.rootPath]);

  const failedRoot = path.join(workspace, 'failed-receipts');
  const failedStore = new ShowRehearsalReceiptStore({
    rootPath: failedRoot,
    atomicWrite: async () => {
      throw new Error('pre-publication failure');
    }
  });
  await assert.rejects(
    failedStore.write(receipt()),
    expectStoreCode('SHOW_REHEARSAL_RECEIPT_STORE_WRITE_FAILED')
  );
  assert.equal(await failedStore.read(), null);
});

test('corrupt regular receipt evidence can be deliberately cleared', async t => {
  const workspace = await tempDirectory(
    t,
    'syncshow-rehearsal-store-clear-corrupt-'
  );
  const rootPath = path.join(workspace, 'receipts');
  const store = new ShowRehearsalReceiptStore({ rootPath });
  await store.initialize();
  await fs.writeFile(
    path.join(rootPath, SHOW_REHEARSAL_RECEIPT_FILE),
    '{corrupt}\n',
    { mode: 0o600 }
  );

  await assert.rejects(
    store.read(),
    expectStoreCode('SHOW_REHEARSAL_RECEIPT_STORE_CORRUPT')
  );
  assert.equal(await store.clear(), true);
  assert.equal(await store.read(), null);
});
