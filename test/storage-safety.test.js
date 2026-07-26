'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');

const {
  assertInside,
  atomicWriteFile,
  ensureConfinedDirectory,
  ensurePrivateDirectory,
  hashFileNoFollow,
  pathIsInside,
  readFileNoFollow,
  statIdentityMatches,
  withExclusiveFileLock
} = require('../src/services/project/StorageSafety');

async function tempDirectory(t, prefix = 'syncshow-storage-safety-') {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return fs.realpath(directory);
}

async function replacePathDuringFirstRead(filePath, replacementPath, operation) {
  const originalOpen = fs.open;
  const resolvedTarget = path.resolve(filePath);
  let swapped = false;
  fs.open = async function patchedOpen(candidate, ...args) {
    const handle = await originalOpen.call(fs, candidate, ...args);
    if (path.resolve(String(candidate)) !== resolvedTarget) return handle;
    return {
      stat: (...statArgs) => handle.stat(...statArgs),
      read: async (...readArgs) => {
        const result = await handle.read(...readArgs);
        if (!swapped) {
          swapped = true;
          await fs.rename(replacementPath, filePath);
        }
        return result;
      },
      close: (...closeArgs) => handle.close(...closeArgs)
    };
  };
  try {
    return await operation();
  } finally {
    fs.open = originalOpen;
  }
}

test('path confinement distinguishes descendants from equality, siblings, prefixes, and traversal', () => {
  const root = path.resolve(os.tmpdir(), 'syncshow-root');
  assert.equal(pathIsInside(root, root), false);
  assert.equal(pathIsInside(root, path.join(root, 'child')), true);
  assert.equal(pathIsInside(root, path.join(root, 'nested', '..', 'child')), true);
  assert.equal(pathIsInside(root, `${root}-prefix`), false);
  assert.equal(pathIsInside(root, path.join(root, '..', 'outside')), false);
  assert.equal(assertInside(root, path.join(root, 'child')), path.join(root, 'child'));
  assert.throws(() => assertInside(root, root), /escaped its storage root/);
  assert.throws(() => assertInside(root, path.join(root, '..', 'outside'), 'Asset'), /Asset escaped its storage root/);
});

test('private directories are canonical directories with owner-only permissions', async t => {
  const parent = await tempDirectory(t);
  const directory = path.join(parent, 'private');
  await fs.mkdir(directory, { mode: 0o777 });
  if (process.platform !== 'win32') await fs.chmod(directory, 0o777);

  const resolved = await ensurePrivateDirectory(directory);
  assert.equal(resolved, await fs.realpath(directory));
  assert.equal((await fs.lstat(directory)).isDirectory(), true);
  if (process.platform !== 'win32') {
    assert.equal((await fs.stat(directory)).mode & 0o077, 0, 'group/other permissions must be removed');
  }
});

test('private and confined directory creation rejects symbolic roots and intermediate links', async t => {
  if (process.platform === 'win32') {
    t.skip('Creating symlinks is not reliably permitted on Windows CI.');
    return;
  }
  const parent = await tempDirectory(t);
  const outside = await tempDirectory(t, 'syncshow-storage-outside-');
  const rootLink = path.join(parent, 'root-link');
  await fs.symlink(outside, rootLink);
  await assert.rejects(ensurePrivateDirectory(rootLink), /Unsafe storage directory/);

  const root = path.join(parent, 'real-root');
  await ensurePrivateDirectory(root);
  await fs.symlink(outside, path.join(root, 'linked'));
  await assert.rejects(
    ensureConfinedDirectory(root, path.join(root, 'linked', 'nested')),
    /Unsafe storage directory/
  );
  assert.deepEqual(await fs.readdir(outside), []);
});

test('confined directories reject lexical traversal before creating anything outside the root', async t => {
  const parent = await tempDirectory(t);
  const root = path.join(parent, 'root');
  await ensurePrivateDirectory(root);
  const outside = path.join(parent, 'outside', 'nested');

  await assert.rejects(
    ensureConfinedDirectory(root, path.join(root, '..', 'outside', 'nested')),
    /escaped its storage root/
  );
  await assert.rejects(fs.lstat(path.join(parent, 'outside')), error => error.code === 'ENOENT');
  assert.equal(await ensureConfinedDirectory(root, root), await fs.realpath(root));
});

test('no-follow reads return exact bytes and reject oversize, directories, and symlinks', async t => {
  const root = await tempDirectory(t);
  const filePath = path.join(root, 'payload.bin');
  const payload = Buffer.from('exact storage payload');
  await fs.writeFile(filePath, payload);

  const read = await readFileNoFollow(filePath, payload.length);
  assert.deepEqual(read.buffer, payload);
  assert.equal(read.stats.size, payload.length);
  assert.equal(read.realPath, await fs.realpath(filePath));
  await assert.rejects(readFileNoFollow(filePath, payload.length - 1), /larger than/);
  await assert.rejects(readFileNoFollow(root, 1024), /not a safe regular file/);

  if (process.platform !== 'win32') {
    const linkPath = path.join(root, 'payload-link.bin');
    await fs.symlink(filePath, linkPath);
    await assert.rejects(readFileNoFollow(linkPath, 1024), /not a safe regular file/);
  }
});

test('no-follow hashing is exact and applies size and symlink boundaries', async t => {
  const root = await tempDirectory(t);
  const filePath = path.join(root, 'payload.bin');
  const payload = crypto.randomBytes(1024 * 1024 + 37);
  await fs.writeFile(filePath, payload);
  const expected = crypto.createHash('sha256').update(payload).digest('hex');

  assert.equal(await hashFileNoFollow(filePath, payload.length), expected);
  await assert.rejects(hashFileNoFollow(filePath, payload.length - 1), /not a safe regular file/);
  if (process.platform !== 'win32') {
    const linkPath = path.join(root, 'payload-link.bin');
    await fs.symlink(filePath, linkPath);
    await assert.rejects(hashFileNoFollow(linkPath), /not a safe regular file/);
  }
});

test('readFileNoFollow detects atomic source replacement during the read', async t => {
  if (process.platform === 'win32') {
    t.skip('Replacing an open file is not portable to Windows.');
    return;
  }
  const root = await tempDirectory(t);
  const filePath = path.join(root, 'source.bin');
  const replacementPath = path.join(root, 'replacement.bin');
  await fs.writeFile(filePath, Buffer.from('original-content'));
  await fs.writeFile(replacementPath, Buffer.from('replaced-content'));

  await assert.rejects(
    replacePathDuringFirstRead(
      filePath,
      replacementPath,
      () => readFileNoFollow(filePath, 1024)
    ),
    /changed while it was being read/
  );
  assert.equal(await fs.readFile(filePath, 'utf8'), 'replaced-content');
});

test('hashFileNoFollow detects atomic source replacement during hashing', async t => {
  if (process.platform === 'win32') {
    t.skip('Replacing an open file is not portable to Windows.');
    return;
  }
  const root = await tempDirectory(t);
  const filePath = path.join(root, 'source.bin');
  const replacementPath = path.join(root, 'replacement.bin');
  await fs.writeFile(filePath, Buffer.alloc(2 * 1024 * 1024, 0x11));
  await fs.writeFile(replacementPath, Buffer.alloc(2 * 1024 * 1024, 0x22));

  await assert.rejects(
    replacePathDuringFirstRead(
      filePath,
      replacementPath,
      () => hashFileNoFollow(filePath)
    ),
    /changed while it was being hashed/
  );
});

test('identity comparison rejects size, precise timestamp, device, and inode changes', () => {
  const base = { size: 10, mtimeMs: 1000.1, dev: 2, ino: 3 };
  assert.equal(statIdentityMatches(base, { ...base }), true);
  assert.equal(statIdentityMatches(base, { ...base, size: 11 }), false);
  assert.equal(statIdentityMatches(base, { ...base, mtimeMs: 1000.9 }), false);
  assert.equal(statIdentityMatches(base, { ...base, dev: 4 }), false);
  assert.equal(statIdentityMatches(base, { ...base, ino: 4 }), false);
  assert.equal(statIdentityMatches(null, base), false);
});

test('atomic writes publish complete files, replace regular targets, and clean staging files', async t => {
  const root = await tempDirectory(t);
  const filePath = path.join(root, 'nested', 'current.json');
  await atomicWriteFile(filePath, 'first\n', { rootPath: root, maximumBytes: 100, mode: 0o600 });
  assert.equal(await fs.readFile(filePath, 'utf8'), 'first\n');
  await atomicWriteFile(filePath, 'second\n', { rootPath: root, maximumBytes: 100, mode: 0o600 });
  assert.equal(await fs.readFile(filePath, 'utf8'), 'second\n');
  assert.equal((await fs.readdir(path.dirname(filePath))).some(name => name.endsWith('.tmp')), false);
  if (process.platform !== 'win32') {
    assert.equal((await fs.stat(filePath)).mode & 0o077, 0);
  }
});

test('atomic writes enforce byte limits and confinement without partial targets', async t => {
  const parent = await tempDirectory(t);
  const root = path.join(parent, 'root');
  await ensurePrivateDirectory(root);
  const tooLargePath = path.join(root, 'too-large.txt');
  await assert.rejects(
    atomicWriteFile(tooLargePath, '12345', { rootPath: root, maximumBytes: 4 }),
    /Refusing to write more than 4 bytes/
  );
  await assert.rejects(fs.lstat(tooLargePath), error => error.code === 'ENOENT');

  const escapedPath = path.join(root, '..', 'escaped.txt');
  await assert.rejects(
    atomicWriteFile(escapedPath, 'escape', { rootPath: root }),
    /escaped its storage root/
  );
  await assert.rejects(fs.lstat(path.join(parent, 'escaped.txt')), error => error.code === 'ENOENT');
});

test('atomic writes never follow an existing target symlink', async t => {
  if (process.platform === 'win32') {
    t.skip('Creating symlinks is not reliably permitted on Windows CI.');
    return;
  }
  const root = await tempDirectory(t);
  const outside = path.join(root, 'outside.txt');
  const target = path.join(root, 'target.txt');
  await fs.writeFile(outside, 'outside remains');
  await fs.symlink(outside, target);

  await assert.rejects(
    atomicWriteFile(target, 'attacker controlled', { rootPath: root }),
    /storage target is not a safe regular file/
  );
  assert.equal(await fs.readFile(outside, 'utf8'), 'outside remains');
  assert.equal((await fs.lstat(target)).isSymbolicLink(), true);
});

test('exclusive file locks prevent overlap and are removed after success', async t => {
  const root = await tempDirectory(t);
  const lockPath = path.join(root, '.write-lock');
  let releaseFirst;
  let enteredFirst;
  const entered = new Promise(resolve => { enteredFirst = resolve; });
  const hold = new Promise(resolve => { releaseFirst = resolve; });
  const first = withExclusiveFileLock(lockPath, async () => {
    enteredFirst();
    await hold;
    return 'first result';
  });
  await entered;

  await assert.rejects(
    withExclusiveFileLock(lockPath, async () => 'overlap'),
    error => error.code === 'WRITE_LOCKED'
  );
  releaseFirst();
  assert.equal(await first, 'first result');
  await assert.rejects(fs.lstat(lockPath), error => error.code === 'ENOENT');
});

test('exclusive file locks release after operation errors and can then be reacquired', async t => {
  const root = await tempDirectory(t);
  const lockPath = path.join(root, '.write-lock');
  await assert.rejects(
    withExclusiveFileLock(lockPath, async () => { throw new Error('save failed'); }),
    /save failed/
  );
  assert.equal(await withExclusiveFileLock(lockPath, async () => 'recovered'), 'recovered');
  await assert.rejects(fs.lstat(lockPath), error => error.code === 'ENOENT');
});

test('abandoned stale locks are quarantined before a new owner proceeds', async t => {
  const root = await tempDirectory(t);
  const lockPath = path.join(root, '.write-lock');
  await fs.mkdir(lockPath);
  await fs.writeFile(path.join(lockPath, 'owner.json'), `${JSON.stringify({
    token: 'abandoned',
    pid: 999999,
    createdAt: Date.now() - 10 * 60 * 1000
  })}\n`);
  const old = new Date(Date.now() - 10 * 60 * 1000);
  await fs.utimes(lockPath, old, old);

  assert.equal(await withExclusiveFileLock(lockPath, async () => 'new owner'), 'new owner');
  assert.equal((await fs.readdir(root)).some(name => name.includes('.stale-')), false);
  await assert.rejects(fs.lstat(lockPath), error => error.code === 'ENOENT');
});

test('a symbolic-link lock path cannot redirect lock ownership', async t => {
  if (process.platform === 'win32') {
    t.skip('Creating symlinks is not reliably permitted on Windows CI.');
    return;
  }
  const root = await tempDirectory(t);
  const outside = await tempDirectory(t, 'syncshow-lock-outside-');
  const lockPath = path.join(root, '.write-lock');
  await fs.symlink(outside, lockPath);

  await assert.rejects(
    withExclusiveFileLock(lockPath, async () => 'unsafe'),
    /write lock path is unsafe/i
  );
  assert.deepEqual(await fs.readdir(outside), []);
});
