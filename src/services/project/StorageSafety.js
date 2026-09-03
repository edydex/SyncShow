'use strict';

const crypto = require('crypto');
const nativeFs = require('fs');
const fs = require('fs/promises');
const path = require('path');

const NOFOLLOW_READ_FLAGS = nativeFs.constants.O_RDONLY | (nativeFs.constants.O_NOFOLLOW || 0);

function pathIsInside(root, candidate) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function assertInside(root, candidate, label = 'Storage path') {
  if (!pathIsInside(root, candidate)) throw new Error(`${label} escaped its storage root.`);
  return path.resolve(candidate);
}

function statIdentityMatches(first, second) {
  if (!first || !second || first.size !== second.size || first.mtimeMs !== second.mtimeMs) {
    return false;
  }
  if (first.dev && first.ino && second.dev && second.ino) return first.dev === second.dev && first.ino === second.ino;
  return true;
}

async function ensurePrivateDirectory(directoryPath) {
  await fs.mkdir(directoryPath, { recursive: true, mode: 0o700 });
  const stats = await fs.lstat(directoryPath);
  if (!stats.isDirectory() || stats.isSymbolicLink()) throw new Error(`Unsafe storage directory: ${directoryPath}`);
  if (process.platform !== 'win32' && (stats.mode & 0o077) !== 0) {
    await fs.chmod(directoryPath, 0o700);
  }
  return fs.realpath(directoryPath);
}

async function ensureConfinedDirectory(rootPath, directoryPath) {
  const root = await ensurePrivateDirectory(rootPath);
  const target = path.resolve(directoryPath);
  if (target !== root) assertInside(root, target, 'Storage directory');
  const relative = path.relative(root, target);
  let current = root;
  for (const component of relative ? relative.split(path.sep) : []) {
    if (!component || component === '.' || component === '..') throw new Error('Unsafe storage directory component.');
    current = path.join(current, component);
    let created = false;
    try {
      await fs.mkdir(current, { mode: 0o700 });
      created = true;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
    const stats = await fs.lstat(current);
    if (!stats.isDirectory() || stats.isSymbolicLink()) throw new Error(`Unsafe storage directory: ${current}`);
    if (created) {
      try {
        await fsyncDirectory(path.dirname(current));
      } catch (error) {
        if (
          process.platform !== 'win32'
          || !['EINVAL', 'EPERM', 'EBADF', 'EACCES'].includes(error.code)
        ) {
          throw error;
        }
      }
    }
  }
  const realTarget = await fs.realpath(target);
  if (realTarget !== target || (realTarget !== root && !pathIsInside(root, realTarget))) {
    throw new Error('Storage directory escaped its canonical root.');
  }
  return realTarget;
}

async function fsyncDirectory(directoryPath) {
  let handle;
  try {
    handle = await fs.open(directoryPath, nativeFs.constants.O_RDONLY);
    await handle.sync();
  } finally {
    await handle?.close().catch(() => {});
  }
}

async function flushPublishedFile(filePath, expectedBuffer) {
  const beforePath = await fs.lstat(filePath);
  if (
    !beforePath.isFile()
    || beforePath.isSymbolicLink()
    || beforePath.size !== expectedBuffer.length
  ) {
    throw new Error('The published storage target is not the expected regular file.');
  }
  const beforeRealPath = await fs.realpath(filePath);
  let handle;
  try {
    handle = await fs.open(
      filePath,
      nativeFs.constants.O_RDWR | (nativeFs.constants.O_NOFOLLOW || 0)
    );
    const opened = await handle.stat();
    if (!opened.isFile() || !statIdentityMatches(beforePath, opened)) {
      throw new Error('The published storage target changed while opening.');
    }
    const observed = await handle.readFile();
    if (!observed.equals(expectedBuffer)) {
      throw new Error('The published storage target does not contain the expected bytes.');
    }
    await handle.sync();
    const after = await handle.stat();
    const afterPath = await fs.lstat(filePath);
    const afterRealPath = await fs.realpath(filePath);
    if (
      !statIdentityMatches(opened, after)
      || !statIdentityMatches(opened, afterPath)
      || afterPath.isSymbolicLink()
      || beforeRealPath !== afterRealPath
    ) {
      throw new Error('The published storage target changed while being flushed.');
    }
  } finally {
    await handle?.close().catch(() => {});
  }
}

async function readFileNoFollow(filePath, maximumBytes) {
  const beforePath = await fs.lstat(filePath);
  if (!beforePath.isFile() || beforePath.isSymbolicLink()) throw new Error('The selected file is not a safe regular file.');
  if (beforePath.size > maximumBytes) throw new Error(`The selected file is larger than ${maximumBytes} bytes.`);
  const beforeRealPath = await fs.realpath(filePath);
  let handle;
  try {
    handle = await fs.open(filePath, NOFOLLOW_READ_FLAGS);
    const opened = await handle.stat();
    if (!opened.isFile() || !statIdentityMatches(beforePath, opened)) throw new Error('The selected file changed while opening.');
    const buffer = Buffer.alloc(opened.size);
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
      if (bytesRead === 0) throw new Error('The selected file ended before it was fully read.');
      offset += bytesRead;
    }
    const after = await handle.stat();
    const afterPath = await fs.lstat(filePath);
    const afterRealPath = await fs.realpath(filePath);
    if (!statIdentityMatches(opened, after)
      || !statIdentityMatches(opened, afterPath)
      || afterPath.isSymbolicLink()
      || beforeRealPath !== afterRealPath) {
      throw new Error('The selected file changed while it was being read.');
    }
    return { buffer, stats: opened, realPath: beforeRealPath };
  } finally {
    await handle?.close().catch(() => {});
  }
}

async function hashFileNoFollow(filePath, maximumBytes = Number.MAX_SAFE_INTEGER) {
  const beforePath = await fs.lstat(filePath);
  if (!beforePath.isFile() || beforePath.isSymbolicLink() || beforePath.size > maximumBytes) {
    throw new Error('The file is not a safe regular file within the allowed size.');
  }
  const beforeRealPath = await fs.realpath(filePath);
  const hash = crypto.createHash('sha256');
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  let handle;
  try {
    handle = await fs.open(filePath, NOFOLLOW_READ_FLAGS);
    const opened = await handle.stat();
    if (!opened.isFile() || !statIdentityMatches(beforePath, opened)) throw new Error('The file changed while opening.');
    let position = 0;
    while (position < opened.size) {
      const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, opened.size - position), position);
      if (bytesRead === 0) throw new Error('The file ended before it was fully hashed.');
      hash.update(buffer.subarray(0, bytesRead));
      position += bytesRead;
    }
    const after = await handle.stat();
    const afterPath = await fs.lstat(filePath);
    const afterRealPath = await fs.realpath(filePath);
    if (!statIdentityMatches(opened, after)
      || !statIdentityMatches(opened, afterPath)
      || afterPath.isSymbolicLink()
      || beforeRealPath !== afterRealPath) {
      throw new Error('The file changed while it was being hashed.');
    }
    return hash.digest('hex');
  } finally {
    await handle?.close().catch(() => {});
  }
}

async function atomicWriteFile(filePath, data, options = {}) {
  const buffer = Buffer.isBuffer(data) ? data : Buffer.from(String(data), options.encoding || 'utf8');
  if (options.maximumBytes && buffer.length > options.maximumBytes) {
    throw new Error(`Refusing to write more than ${options.maximumBytes} bytes.`);
  }
  const directoryPath = path.dirname(filePath);
  if (options.rootPath) await ensureConfinedDirectory(options.rootPath, directoryPath);
  else await ensurePrivateDirectory(directoryPath);
  const temporaryPath = path.join(directoryPath, `.${path.basename(filePath)}.${process.pid}.${crypto.randomUUID()}.tmp`);
  let handle;
  let published = false;
  try {
    try {
      const targetStats = await fs.lstat(filePath);
      if (targetStats.isSymbolicLink() || !targetStats.isFile()) throw new Error('The storage target is not a safe regular file.');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    handle = await fs.open(temporaryPath, 'wx', options.mode || 0o600);
    await handle.writeFile(buffer);
    await handle.sync();
    await handle.close();
    handle = null;
    await fs.rename(temporaryPath, filePath);
    published = true;
    // A temp-file fsync followed by rename is not, by itself, a documented
    // metadata durability barrier on Windows. Reopen the published name with
    // write access, verify that it is still our exact file, and flush it before
    // callers are allowed to advance a journal or clear recovery evidence.
    await flushPublishedFile(filePath, buffer);
    try {
      await fsyncDirectory(directoryPath);
    } catch (error) {
      if (process.platform !== 'win32' || !['EINVAL', 'EPERM', 'EBADF', 'EACCES'].includes(error.code)) throw error;
    }
  } finally {
    await handle?.close().catch(() => {});
    if (!published) await fs.unlink(temporaryPath).catch(() => {});
  }
}

async function lockOwnerStatus(ownerPath) {
  let owner;
  try {
    const { buffer } = await readFileNoFollow(ownerPath, 16 * 1024);
    owner = JSON.parse(buffer.toString('utf8'));
  } catch (_error) {
    return 'unverifiable';
  }
  if (
    !owner
    || !Number.isSafeInteger(owner.pid)
    || owner.pid < 1
  ) {
    return 'unverifiable';
  }
  if (owner.pid === process.pid) return 'alive';
  try {
    process.kill(owner.pid, 0);
    return 'alive';
  } catch (error) {
    if (error.code === 'ESRCH') return 'dead';
    if (error.code === 'EPERM') return 'alive';
    return 'unverifiable';
  }
}

async function verifiedDeadLockOwner(ownerPath) {
  return await lockOwnerStatus(ownerPath) === 'dead';
}

async function withExclusiveFileLock(lockPath, operation, options = {}) {
  if (
    !options
    || typeof options !== 'object'
    || Array.isArray(options)
    || Object.keys(options).some(key => key !== 'reclaimDeadOwner')
    || (
      options.reclaimDeadOwner !== undefined
      && typeof options.reclaimDeadOwner !== 'boolean'
    )
  ) {
    throw new TypeError('Write lock options are invalid.');
  }
  const parent = await ensurePrivateDirectory(path.dirname(lockPath));
  const resolvedLockPath = assertInside(parent, lockPath, 'Write lock');
  const ownerPath = path.join(resolvedLockPath, 'owner.json');
  const token = crypto.randomUUID();
  const staleAfterMs = 5 * 60 * 1000;
  let acquired = false;
  for (let attempt = 0; attempt < 2 && !acquired; attempt += 1) {
    try {
      await fs.mkdir(resolvedLockPath, { mode: 0o700 });
      await fs.writeFile(ownerPath, `${JSON.stringify({ token, pid: process.pid, createdAt: Date.now() })}\n`, {
        encoding: 'utf8',
        mode: 0o600,
        flag: 'wx'
      });
      acquired = true;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const stats = await fs.lstat(resolvedLockPath);
      if (!stats.isDirectory() || stats.isSymbolicLink()) throw new Error('The write lock path is unsafe.');
      const ownerStatus = options.reclaimDeadOwner === true
        ? await lockOwnerStatus(ownerPath)
        : null;
      const lockIsStale = Date.now() - stats.mtimeMs > staleAfterMs;
      const mayReclaim = options.reclaimDeadOwner === true
        ? ownerStatus === 'dead'
          || (ownerStatus === 'unverifiable' && lockIsStale)
        : lockIsStale;
      if (
        !mayReclaim
        || attempt > 0
      ) {
        const conflict = new Error('This item is already being saved by another SyncShow process.');
        conflict.code = 'WRITE_LOCKED';
        throw conflict;
      }
      const quarantine = `${resolvedLockPath}.stale-${crypto.randomUUID()}`;
      try {
        await fs.rename(resolvedLockPath, quarantine);
        await fs.rm(quarantine, { recursive: true, force: true });
      } catch (staleError) {
        if (staleError.code !== 'ENOENT') throw staleError;
      }
    }
  }
  if (!acquired) throw new Error('Could not acquire the write lock.');
  try {
    return await operation();
  } finally {
    let owner = null;
    try {
      owner = JSON.parse(await fs.readFile(ownerPath, 'utf8'));
    } catch (_error) {
      owner = null;
    }
    if (owner?.token === token) {
      const releasePath = `${resolvedLockPath}.release-${token}`;
      try {
        await fs.rename(resolvedLockPath, releasePath);
        await fs.rm(releasePath, { recursive: true, force: true });
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
      await fsyncDirectory(parent).catch(() => {});
    }
  }
}

module.exports = {
  NOFOLLOW_READ_FLAGS,
  assertInside,
  atomicWriteFile,
  ensureConfinedDirectory,
  ensurePrivateDirectory,
  flushPublishedFile,
  fsyncDirectory,
  hashFileNoFollow,
  pathIsInside,
  readFileNoFollow,
  statIdentityMatches,
  verifiedDeadLockOwner,
  withExclusiveFileLock
};
