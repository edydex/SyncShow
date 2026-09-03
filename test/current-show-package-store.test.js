'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');

const {
  CURRENT_SHOW_PACKAGE_POINTER_KIND,
  CURRENT_SHOW_PACKAGE_POINTER_SCHEMA_VERSION,
  CurrentShowPackageError,
  CurrentShowPackageStore,
  normalizeCurrentShowPackagePointer,
  serializeCurrentShowPackagePointer
} = require('../src/services/project/CurrentShowPackageStore');
const {
  atomicWriteFile,
  fsyncDirectory
} = require('../src/services/project/StorageSafety');

const NOW = '2026-07-28T18:30:00.000Z';
const PACKAGE_A = `show-${'a'.repeat(64)}`;
const PACKAGE_B = `show-${'b'.repeat(64)}`;
const REVISION_A = 'c'.repeat(64);
const MANIFEST_A = 'e'.repeat(64);
const PROFILE_REVISION_A = 'f'.repeat(64);
const ACTIVATION_A = '11111111-1111-4111-8111-111111111111';
const ACTIVATION_B = '22222222-2222-4222-8222-222222222222';

async function tempDirectory(t, prefix) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return directory;
}

function activation(overrides = {}) {
  return {
    packageId: PACKAGE_A,
    packageManifestSha256: MANIFEST_A,
    projectId: 'service-2026-08-02',
    projectRevisionId: REVISION_A,
    projectRevision: 7,
    serviceDate: '2026-08-02',
    venueProfileId: 'main-sanctuary',
    venueProfileRevisionId: PROFILE_REVISION_A,
    ...overrides
  };
}

function uuidSequence(...values) {
  let index = 0;
  return () => values[Math.min(index++, values.length - 1)];
}

function expectStoreCode(...codes) {
  return error => {
    assert.ok(
      error instanceof CurrentShowPackageError,
      `expected CurrentShowPackageError, got ${error?.constructor?.name}`
    );
    assert.ok(codes.includes(error.code), `expected ${codes.join(' or ')}, got ${error.code}`);
    return true;
  };
}

test('activates one exact path-free pointer and reopens it across store instances', async t => {
  const workspace = await tempDirectory(t, 'syncshow-current-show-package-');
  const rootPath = path.join(workspace, 'prepared-service');
  const firstStore = new CurrentShowPackageStore({
    rootPath,
    clock: () => new Date(NOW),
    randomUUID: () => ACTIVATION_A
  });

  const activated = await firstStore.activate(activation());
  assert.deepEqual(activated, {
    schemaVersion: CURRENT_SHOW_PACKAGE_POINTER_SCHEMA_VERSION,
    kind: CURRENT_SHOW_PACKAGE_POINTER_KIND,
    ...activation(),
    activationId: ACTIVATION_A,
    activatedAt: NOW
  });
  assert.equal(Object.isFrozen(activated), true);

  const pointerSource = await fs.readFile(path.join(rootPath, 'current.json'), 'utf8');
  assert.equal(pointerSource, serializeCurrentShowPackagePointer(activated));
  assert.equal(pointerSource.includes(workspace), false);
  assert.deepEqual(
    Object.keys(JSON.parse(pointerSource)),
    [
      'schemaVersion',
      'kind',
      'packageId',
      'packageManifestSha256',
      'projectId',
      'projectRevisionId',
      'projectRevision',
      'serviceDate',
      'venueProfileId',
      'venueProfileRevisionId',
      'activationId',
      'activatedAt'
    ]
  );

  const reopenedStore = new CurrentShowPackageStore({ rootPath });
  const reopened = await reopenedStore.read();
  assert.deepEqual(reopened, activated);
  assert.equal(Object.isFrozen(reopened), true);
});

test('activation rejects paths, unknown fields, invalid dates, and invalid clock values before writing', async t => {
  const workspace = await tempDirectory(t, 'syncshow-current-show-package-invalid-');
  const rootPath = path.join(workspace, 'prepared-service');
  const store = new CurrentShowPackageStore({
    rootPath,
    clock: () => new Date(NOW),
    randomUUID: () => ACTIVATION_A
  });
  const cases = [
    { ...activation(), packageId: '../show-package' },
    { ...activation(), packageManifestSha256: 'E'.repeat(64) },
    { ...activation(), projectId: 'service/escaped' },
    { ...activation(), projectRevisionId: 'A'.repeat(64) },
    { ...activation(), projectRevision: -1 },
    { ...activation(), serviceDate: '2026-02-30' },
    { ...activation(), venueProfileId: 'constructor' },
    { ...activation(), venueProfileRevisionId: 'F'.repeat(64) },
    { ...activation(), extra: true }
  ];
  for (const candidate of cases) {
    await assert.rejects(
      store.activate(candidate),
      expectStoreCode('INVALID_CURRENT_SHOW_PACKAGE_ACTIVATION')
    );
  }
  await assert.rejects(
    new CurrentShowPackageStore({
      rootPath,
      clock: () => new Date('invalid'),
      randomUUID: () => ACTIVATION_A
    }).activate(activation()),
    expectStoreCode('INVALID_CURRENT_SHOW_PACKAGE_ACTIVATION')
  );
  await assert.rejects(fs.lstat(path.join(rootPath, 'current.json')), { code: 'ENOENT' });
});

test('read fails closed for pointer tampering, legacy schemas, and malformed JSON', async t => {
  const workspace = await tempDirectory(t, 'syncshow-current-show-package-tamper-');
  const rootPath = path.join(workspace, 'prepared-service');
  const store = new CurrentShowPackageStore({
    rootPath,
    clock: () => new Date(NOW),
    randomUUID: () => ACTIVATION_A
  });
  const valid = await store.activate(activation());
  const pointerPath = path.join(rootPath, 'current.json');
  const tamperedPointers = [
    { ...valid, schemaVersion: 0 },
    { ...valid, kind: 'legacy-current-package' },
    { ...valid, packageId: '../../outside' },
    { ...valid, packageManifestSha256: '0'.repeat(63) },
    { ...valid, projectRevisionId: '0'.repeat(63) },
    { ...valid, projectRevision: 1.5 },
    { ...valid, serviceDate: '2026-13-01' },
    { ...valid, venueProfileRevisionId: '0'.repeat(63) },
    { ...valid, activationId: 'not-a-uuid' },
    { ...valid, activatedAt: 'yesterday' },
    { ...valid, unexpected: 'field' }
  ];

  for (const tampered of tamperedPointers) {
    await fs.writeFile(pointerPath, `${JSON.stringify(tampered)}\n`);
    await assert.rejects(
      store.read(),
      expectStoreCode('CURRENT_SHOW_PACKAGE_POINTER_INVALID')
    );
  }

  await fs.writeFile(pointerPath, '{not-json}\n');
  await assert.rejects(
    store.read(),
    expectStoreCode('CURRENT_SHOW_PACKAGE_POINTER_INVALID')
  );
});

test('read rejects a symlink pointer instead of following it', async t => {
  const workspace = await tempDirectory(t, 'syncshow-current-show-package-symlink-');
  const rootPath = path.join(workspace, 'prepared-service');
  const store = new CurrentShowPackageStore({ rootPath });
  await store.initialize();

  const targetPath = path.join(workspace, 'outside-pointer.json');
  const pointer = normalizeCurrentShowPackagePointer({
    schemaVersion: CURRENT_SHOW_PACKAGE_POINTER_SCHEMA_VERSION,
    kind: CURRENT_SHOW_PACKAGE_POINTER_KIND,
    ...activation(),
    activationId: ACTIVATION_A,
    activatedAt: NOW
  });
  await fs.writeFile(targetPath, serializeCurrentShowPackagePointer(pointer));
  try {
    await fs.symlink(targetPath, path.join(rootPath, 'current.json'), 'file');
  } catch (error) {
    if (['EPERM', 'EACCES', 'ENOSYS'].includes(error.code)) {
      t.skip(`symbolic links are unavailable: ${error.code}`);
      return;
    }
    throw error;
  }

  await assert.rejects(
    store.read(),
    expectStoreCode('CURRENT_SHOW_PACKAGE_POINTER_UNSAFE')
  );
});

test('activation replaces atomically and clear supports exact compare-and-clear', async t => {
  const workspace = await tempDirectory(t, 'syncshow-current-show-package-clear-');
  const rootPath = path.join(workspace, 'prepared-service');
  const store = new CurrentShowPackageStore({
    rootPath,
    clock: () => new Date(NOW),
    randomUUID: uuidSequence(ACTIVATION_A, ACTIVATION_B)
  });

  await store.activate(activation());
  const replacement = await store.activate(activation({
    packageId: PACKAGE_B,
    packageManifestSha256: '1'.repeat(64),
    projectRevisionId: 'd'.repeat(64),
    projectRevision: 8
  }));
  assert.deepEqual(await store.read(), replacement);
  assert.equal(await store.clear({ expectedPackageId: PACKAGE_A }), false);
  assert.deepEqual(await store.read(), replacement);
  assert.equal(await store.clear({
    expectedPackageId: PACKAGE_B,
    expectedActivationId: ACTIVATION_A
  }), false);
  assert.deepEqual(await store.read(), replacement);
  assert.equal(await store.clear({
    expectedPackageId: PACKAGE_B,
    expectedActivationId: replacement.activationId
  }), true);
  assert.equal(await store.read(), null);

  const entries = await fs.readdir(rootPath);
  assert.deepEqual(entries, []);
});

test('unconditional clear safely discards a malformed regular pointer', async t => {
  const workspace = await tempDirectory(t, 'syncshow-current-show-package-discard-');
  const rootPath = path.join(workspace, 'prepared-service');
  const store = new CurrentShowPackageStore({ rootPath });
  await store.initialize();
  await fs.writeFile(path.join(rootPath, 'current.json'), '{invalid}\n');

  assert.equal(await store.clear(), true);
  assert.equal(await store.read(), null);
  await assert.rejects(
    store.clear({ expectedActivationId: ACTIVATION_A }),
    expectStoreCode('INVALID_CURRENT_SHOW_PACKAGE_CLEAR')
  );
});

test('same-package same-millisecond activation receipts are unique and roll back exactly', async t => {
  const workspace = await tempDirectory(t, 'syncshow-current-show-package-race-');
  const rootPath = path.join(workspace, 'prepared-service');
  const store = new CurrentShowPackageStore({
    rootPath,
    clock: () => new Date(NOW),
    randomUUID: uuidSequence(ACTIVATION_A, ACTIVATION_B)
  });

  const first = await store.activateWithReceipt(activation());
  const second = await store.activateWithReceipt(activation());
  assert.equal(first.pointer.activatedAt, second.pointer.activatedAt);
  assert.notEqual(first.pointer.activationId, second.pointer.activationId);

  assert.equal(await store.rollbackActivation(first), false);
  assert.deepEqual(await store.read(), second.pointer);
  assert.equal(await store.rollbackActivation(second), true);
  assert.deepEqual(await store.read(), first.pointer);
});

test('rollback restores the previous exact pointer instead of clearing restart state', async t => {
  const workspace = await tempDirectory(t, 'syncshow-current-show-package-rollback-');
  const rootPath = path.join(workspace, 'prepared-service');
  const store = new CurrentShowPackageStore({
    rootPath,
    clock: () => new Date(NOW),
    randomUUID: uuidSequence(ACTIVATION_A, ACTIVATION_B)
  });
  const previous = await store.activate(activation());
  const replacement = await store.activateWithReceipt(activation({
    packageId: PACKAGE_B,
    packageManifestSha256: '1'.repeat(64),
    projectRevisionId: 'd'.repeat(64),
    projectRevision: 8
  }));

  assert.deepEqual(replacement.previousPointer, previous);
  assert.equal(await store.rollbackActivation(replacement), true);
  assert.deepEqual(await store.read(), previous);
});

test('a post-rename write error is reconciled as success after a fresh durability barrier', async t => {
  const workspace = await tempDirectory(t, 'syncshow-current-show-package-published-error-');
  const rootPath = path.join(workspace, 'prepared-service');
  let injected = false;
  const store = new CurrentShowPackageStore({
    rootPath,
    clock: () => new Date(NOW),
    randomUUID: () => ACTIVATION_A,
    atomicWrite: async (...args) => {
      await atomicWriteFile(...args);
      if (!injected) {
        injected = true;
        const error = new Error('simulated report after rename');
        error.code = 'EIO';
        throw error;
      }
    },
    syncDirectory: fsyncDirectory
  });

  const receipt = await store.activateWithReceipt(activation());
  assert.equal(injected, true);
  assert.deepEqual(await store.read(), receipt.pointer);
});
