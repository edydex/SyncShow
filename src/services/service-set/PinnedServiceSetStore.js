'use strict';

const crypto = require('crypto');
const nativeFs = require('fs');
const fs = require('fs/promises');
const path = require('path');

const { isValidIsoDate } = require('./ServiceDate');
const { SUPPORTED_EXTENSIONS, ServiceSetError } = require('./ServiceSetResolver');
const { pathIsInside, requireAbsoluteFolder } = require('./ServiceFolderScanner');

const CURRENT_SERVICE_SET_SCHEMA_VERSION = 1;
const DEFAULT_MAX_PINNED_GENERATIONS = 4;
const MIN_PINNED_GENERATIONS = 2;
const MAX_PINNED_GENERATIONS = 100;
const DEFAULT_REMOTE_MAX_FILE_BYTES = 256 * 1024 * 1024;
const DEFAULT_REMOTE_MAX_TOTAL_BYTES = 512 * 1024 * 1024;
const MAX_REMOTE_MAX_FILE_BYTES = 1024 * 1024 * 1024;
const MAX_REMOTE_MAX_TOTAL_BYTES = 4 * 1024 * 1024 * 1024;
const REMOTE_SOURCE_TYPES = Object.freeze(['google-drive-private', 'google-drive-public']);
const ROLE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const GENERATION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const REMOTE_ID_PATTERN = /^[A-Za-z0-9_-]{10,200}$/;
const RESOURCE_KEY_PATTERN = /^[A-Za-z0-9_-]{1,200}$/;
const REMOTE_VERSION_PATTERN = /^[^\0\r\n]{1,128}$/;
const CREDENTIAL_FIELD_PATTERN = /(?:access|refresh|bearer|auth|id)?token|authorization|api[_-]?key|client[_-]?secret|credential/i;
const SOURCE_OPEN_FLAGS = nativeFs.constants.O_RDONLY | (nativeFs.constants.O_NOFOLLOW || 0);
let snapshotPublicationQueue = Promise.resolve();

function fail(code, message, details = {}) {
  throw new ServiceSetError(code, message, details);
}

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function safeSegment(value, fallback = 'item') {
  const result = String(value || '')
    .normalize('NFKD')
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
  return !result || result === '.' || result === '..' ? fallback : result;
}

async function hashFileWithAlgorithm(filePath, algorithm) {
  const handle = await fs.open(filePath, SOURCE_OPEN_FLAGS);
  const hash = crypto.createHash(algorithm);
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    let position = 0;
    while (true) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
      if (bytesRead === 0) break;
      hash.update(buffer.subarray(0, bytesRead));
      position += bytesRead;
    }
  } finally {
    await handle.close();
  }
  return hash.digest('hex');
}

async function hashFile(filePath) {
  return hashFileWithAlgorithm(filePath, 'sha256');
}

async function atomicWriteJson(filePath, value) {
  const serialized = `${JSON.stringify(value, null, 2)}\n`;
  const temporaryPath = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  const backupPath = `${filePath}.bak`;
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  let published = false;
  try {
    await fs.writeFile(temporaryPath, serialized, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    try {
      await fs.copyFile(filePath, backupPath);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    await fs.rename(temporaryPath, filePath);
    published = true;
  } finally {
    if (!published) await fs.unlink(temporaryPath).catch(() => {});
  }
}

function serializeSnapshotPublication(callback) {
  const result = snapshotPublicationQueue.then(callback, callback);
  snapshotPublicationQueue = result.then(() => undefined, () => undefined);
  return result;
}

function requireSelectedSet(scan, setId) {
  if (!scan || !Array.isArray(scan.sets)) fail('INVALID_SCAN', 'The service-folder scan is no longer available.');
  const selectedSet = scan.sets.find(set => set.id === setId);
  if (!selectedSet) fail('UNKNOWN_SERVICE_SET', 'Choose one of the discovered service dates.');
  return selectedSet;
}

function statMatchesScan(stats, candidate) {
  if (!stats.isFile()
    || stats.size !== candidate.size
    || Math.trunc(stats.mtimeMs) !== Math.trunc(candidate.modifiedTimeMs)) {
    return false;
  }
  if (Number.isSafeInteger(candidate.device)
    && candidate.device !== 0
    && stats.dev !== candidate.device) {
    return false;
  }
  if (Number.isSafeInteger(candidate.inode)
    && candidate.inode !== 0
    && stats.ino !== candidate.inode) {
    return false;
  }
  return true;
}

function statIdentityMatches(first, second) {
  if (first.size !== second.size || Math.trunc(first.mtimeMs) !== Math.trunc(second.mtimeMs)) return false;
  if (first.dev !== 0 && first.ino !== 0 && second.dev !== 0 && second.ino !== 0) {
    return first.dev === second.dev && first.ino === second.ino;
  }
  return true;
}

async function copyOpenFile(sourceHandle, destinationHandle) {
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  let position = 0;
  while (true) {
    const { bytesRead } = await sourceHandle.read(buffer, 0, buffer.length, position);
    if (bytesRead === 0) break;
    let written = 0;
    while (written < bytesRead) {
      const result = await destinationHandle.write(
        buffer,
        written,
        bytesRead - written,
        position + written
      );
      if (result.bytesWritten === 0) throw new Error('The local snapshot stopped accepting data.');
      written += result.bytesWritten;
    }
    position += bytesRead;
  }
}

async function copyPinnedInput({
  folderPath,
  stagingAssets,
  publishedAssets,
  roleId,
  candidate
}) {
  if (!candidate?.available) {
    fail('SOURCE_UNAVAILABLE', `${candidate?.name || roleId} is not available offline.`, {
      roleId,
      sourcePath: candidate?.path || null
    });
  }
  if (!ROLE_ID_PATTERN.test(roleId)
    || typeof candidate.path !== 'string'
    || !path.isAbsolute(candidate.path)
    || typeof candidate.relativePath !== 'string') {
    fail('INVALID_SCAN_SOURCE', 'A discovered service file has invalid path metadata.', { roleId });
  }
  const sourcePath = path.resolve(candidate.path);
  const expectedSourcePath = path.resolve(folderPath, candidate.relativePath);
  if (!pathIsInside(folderPath, sourcePath) || expectedSourcePath !== sourcePath) {
    fail('SOURCE_OUTSIDE_FOLDER', 'A discovered file escaped the selected service folder.', { roleId });
  }

  const extension = path.extname(candidate.name).toLowerCase();
  if (!SUPPORTED_EXTENSIONS.includes(extension) || path.extname(sourcePath).toLowerCase() !== extension) {
    fail('INVALID_SCAN_SOURCE', 'A discovered service file has an unsupported file type.', { roleId });
  }
  const destinationName = `${safeSegment(roleId, 'input')}${extension}`;
  const destinationPath = path.join(stagingAssets, destinationName);
  const publishedPath = path.join(publishedAssets, destinationName);
  let sourceHandle;
  let destinationHandle;
  let before;
  try {
    const pathStats = await fs.lstat(sourcePath);
    if (pathStats.isSymbolicLink()) {
      fail('SOURCE_CHANGED', `${candidate.name} became a symbolic link after the folder scan. Refresh and try again.`, {
        roleId,
        sourcePath
      });
    }
    const sourceRealPath = await fs.realpath(sourcePath);
    if (!pathIsInside(folderPath, sourceRealPath)
      || (candidate.realPath && path.resolve(candidate.realPath) !== sourceRealPath)) {
      fail('SOURCE_OUTSIDE_FOLDER', 'A discovered file escaped the selected service folder.', { roleId });
    }
    sourceHandle = await fs.open(sourcePath, SOURCE_OPEN_FLAGS);
    before = await sourceHandle.stat();
    if (!statMatchesScan(before, candidate)) {
      fail('SOURCE_CHANGED', `${candidate.name} changed while SyncShow was loading it. Refresh the folder and try again.`, {
        roleId,
        sourcePath
      });
    }
    // Re-resolve after opening to close the common replace-with-symlink race.
    const openedRealPath = await fs.realpath(sourcePath);
    if (!pathIsInside(folderPath, openedRealPath) || openedRealPath !== sourceRealPath) {
      fail('SOURCE_CHANGED', `${candidate.name} changed while SyncShow was opening it. Refresh and try again.`, {
        roleId,
        sourcePath
      });
    }

    destinationHandle = await fs.open(destinationPath, 'wx', 0o600);
    await copyOpenFile(sourceHandle, destinationHandle);
    await destinationHandle.sync();

    const afterOpenFile = await sourceHandle.stat();
    const afterPath = await fs.lstat(sourcePath);
    const afterRealPath = await fs.realpath(sourcePath);
    if (afterPath.isSymbolicLink()
      || afterRealPath !== openedRealPath
      || !statIdentityMatches(before, afterOpenFile)
      || !statIdentityMatches(before, afterPath)) {
      fail('SOURCE_CHANGED', `${candidate.name} changed during the local copy. Refresh and try again.`, {
        roleId,
        sourcePath
      });
    }
  } catch (error) {
    if (error instanceof ServiceSetError) throw error;
    fail(
      'SOURCE_COPY_FAILED',
      `${candidate.name} could not be copied locally. Make it available offline and try again.`,
      { roleId, sourcePath, cause: error.code || error.message }
    );
  } finally {
    await destinationHandle?.close().catch(() => {});
    await sourceHandle?.close().catch(() => {});
  }

  const pinnedStats = await fs.stat(destinationPath);
  if (pinnedStats.size !== before.size) {
    fail('SOURCE_COPY_FAILED', `${candidate.name} was not copied completely. Try again.`, { roleId, sourcePath });
  }
  const sha256 = await hashFile(destinationPath);
  return {
    assetId: `sha256:${sha256}`,
    roleId,
    sourceName: candidate.name,
    sourcePath,
    sourceRelativePath: candidate.relativePath,
    pinnedPath: publishedPath,
    fileDate: candidate.serviceDate,
    size: pinnedStats.size,
    sourceModifiedTime: before.mtime.toISOString(),
    sourceModifiedTimeMs: Math.trunc(before.mtimeMs),
    sourceDevice: Number.isSafeInteger(before.dev) ? before.dev : null,
    sourceInode: Number.isSafeInteger(before.ino) ? before.ino : null,
    sha256
  };
}

function isRemoteSourceType(sourceType) {
  return REMOTE_SOURCE_TYPES.includes(sourceType);
}

function validateRemoteByteLimit(value, fallback, maximum, code, label) {
  const result = value === undefined ? fallback : value;
  if (!Number.isSafeInteger(result) || result < 1 || result > maximum) {
    fail(code, `${label} must be a positive whole number no larger than ${maximum}.`);
  }
  return result;
}

function containsCredentialField(value, depth = 0) {
  if (!isRecord(value) || depth > 4) return false;
  return Object.entries(value).some(([key, child]) => (
    CREDENTIAL_FIELD_PATTERN.test(key)
    || (isRecord(child) && containsCredentialField(child, depth + 1))
  ));
}

function validateRemoteCandidate(roleId, candidate) {
  const extension = typeof candidate?.extension === 'string'
    ? candidate.extension.toLowerCase()
    : '';
  if (!ROLE_ID_PATTERN.test(roleId)
    || !isRecord(candidate)
    || candidate.available !== true
    || typeof candidate.name !== 'string'
    || candidate.name.length < 1
    || candidate.name.length > 1024
    || candidate.name.includes('\0')
    || typeof candidate.relativePath !== 'string'
    || candidate.relativePath.length < 1
    || candidate.relativePath.length > 4096
    || candidate.relativePath.includes('\0')
    || !REMOTE_ID_PATTERN.test(candidate.fileId || '')
    || (candidate.resourceKey !== null
      && candidate.resourceKey !== undefined
      && !RESOURCE_KEY_PATTERN.test(candidate.resourceKey))
    || (candidate.version !== null
      && candidate.version !== undefined
      && !REMOTE_VERSION_PATTERN.test(String(candidate.version)))
    || !SUPPORTED_EXTENSIONS.includes(extension)
    || (candidate.size !== null
      && candidate.size !== undefined
      && (!Number.isSafeInteger(candidate.size) || candidate.size < 1))
    || typeof candidate.modifiedTime !== 'string'
    || !Number.isFinite(Date.parse(candidate.modifiedTime))
    || containsCredentialField(candidate)) {
    fail('INVALID_REMOTE_SCAN_SOURCE', 'A discovered Google Drive file has invalid metadata.', {
      roleId
    });
  }
  const checksumAlgorithm = candidate.driveChecksumAlgorithm || null;
  const checksum = candidate.driveChecksum || null;
  const checksumPatterns = {
    md5: /^[a-f0-9]{32}$/,
    sha1: /^[a-f0-9]{40}$/,
    sha256: SHA256_PATTERN
  };
  if ((checksumAlgorithm === null) !== (checksum === null)
    || (checksumAlgorithm !== null
      && (!checksumPatterns[checksumAlgorithm] || !checksumPatterns[checksumAlgorithm].test(checksum)))) {
    fail('INVALID_REMOTE_SCAN_SOURCE', 'A discovered Google Drive file has an invalid checksum.', {
      roleId
    });
  }
  return extension;
}

async function requireRemoteCandidateUnchanged(checkCandidateUnchanged, candidate, phase) {
  if (typeof checkCandidateUnchanged !== 'function') return;
  let result;
  try {
    result = await checkCandidateUnchanged(candidate, { phase });
  } catch (error) {
    if (error instanceof ServiceSetError) throw error;
    fail(
      'REMOTE_SOURCE_CHECK_FAILED',
      `${candidate.name} could not be checked for changes. Try again.`,
      { fileId: candidate.fileId, cause: error.code || error.message }
    );
  }
  if (result === false || result?.unchanged === false) {
    fail(
      'SOURCE_CHANGED',
      `${candidate.name} changed while SyncShow was loading it. Refresh Google Drive and try again.`,
      { fileId: candidate.fileId }
    );
  }
}

async function materializeRemoteInput({
  stagingAssets,
  publishedAssets,
  roleId,
  candidate,
  materialize,
  checkCandidateUnchanged,
  maximumBytes
}) {
  const extension = validateRemoteCandidate(roleId, candidate);
  const destinationName = `${safeSegment(roleId, 'input')}${extension}`;
  const destinationPath = path.join(stagingAssets, destinationName);
  const publishedPath = path.join(publishedAssets, destinationName);

  await requireRemoteCandidateUnchanged(checkCandidateUnchanged, candidate, 'before');
  try {
    await materialize({
      candidate,
      destinationPath,
      maximumBytes
    });
  } catch (error) {
    if (error instanceof ServiceSetError) throw error;
    fail(
      'REMOTE_MATERIALIZE_FAILED',
      `${candidate.name} could not be downloaded from Google Drive.`,
      { roleId, fileId: candidate.fileId, cause: error.code || error.message }
    );
  }

  let stats;
  let realPath;
  let realAssetsPath;
  try {
    stats = await fs.lstat(destinationPath);
    realPath = await fs.realpath(destinationPath);
    realAssetsPath = await fs.realpath(stagingAssets);
  } catch (error) {
    fail(
      'REMOTE_MATERIALIZE_FAILED',
      `${candidate.name} was not downloaded completely.`,
      { roleId, fileId: candidate.fileId, cause: error.code || error.message }
    );
  }
  if (!stats.isFile()
    || stats.isSymbolicLink()
    || path.dirname(realPath) !== realAssetsPath
    || path.basename(realPath) !== destinationName
    || stats.size < 1) {
    fail('REMOTE_MATERIALIZE_INVALID', `${candidate.name} did not produce a safe local file.`, {
      roleId,
      fileId: candidate.fileId
    });
  }
  if (stats.size > maximumBytes) {
    fail('REMOTE_FILE_TOO_LARGE', `${candidate.name} exceeds the Google Drive download limit.`, {
      roleId,
      fileId: candidate.fileId,
      maximumBytes
    });
  }
  if (Number.isSafeInteger(candidate.size) && stats.size !== candidate.size) {
    fail('REMOTE_SIZE_MISMATCH', `${candidate.name} changed size while it was downloading.`, {
      roleId,
      fileId: candidate.fileId,
      expectedSize: candidate.size,
      actualSize: stats.size
    });
  }

  const sha256 = await hashFile(destinationPath);
  if (candidate.driveChecksumAlgorithm) {
    const materializedChecksum = candidate.driveChecksumAlgorithm === 'sha256'
      ? sha256
      : await hashFileWithAlgorithm(destinationPath, candidate.driveChecksumAlgorithm);
    if (materializedChecksum !== candidate.driveChecksum) {
      fail('REMOTE_CHECKSUM_MISMATCH', `${candidate.name} failed its Google Drive integrity check.`, {
        roleId,
        fileId: candidate.fileId
      });
    }
  }
  await requireRemoteCandidateUnchanged(checkCandidateUnchanged, candidate, 'after');

  return {
    assetId: `sha256:${sha256}`,
    roleId,
    sourceName: candidate.name,
    sourcePath: null,
    sourceRelativePath: candidate.displayRelativePath || candidate.relativePath,
    pinnedPath: publishedPath,
    fileDate: candidate.serviceDate ?? null,
    size: stats.size,
    sourceModifiedTime: new Date(candidate.modifiedTime).toISOString(),
    sourceModifiedTimeMs: Number.isSafeInteger(candidate.modifiedTimeMs)
      ? candidate.modifiedTimeMs
      : Math.trunc(Date.parse(candidate.modifiedTime)),
    sourceDevice: null,
    sourceInode: null,
    sha256,
    remote: {
      fileId: candidate.fileId,
      resourceKey: candidate.resourceKey || null,
      version: candidate.version === undefined || candidate.version === null
        ? null
        : String(candidate.version),
      mimeType: typeof candidate.sourceMimeType === 'string' ? candidate.sourceMimeType : null,
      exportMimeType: typeof candidate.exportMimeType === 'string' ? candidate.exportMimeType : null,
      sourceSize: Number.isSafeInteger(candidate.size) ? candidate.size : null,
      checksumAlgorithm: candidate.driveChecksumAlgorithm || null,
      checksum: candidate.driveChecksum || null
    }
  };
}

/** Copy the chosen coherent set into a versioned, offline-safe local snapshot. */
async function pinServiceSet({ scan, setId, destinationRoot, profileId, profileName, timeZone }) {
  const selectedSet = requireSelectedSet(scan, setId);
  const scannedFolderPath = requireAbsoluteFolder(scan.folderPath);
  let folderPath;
  try {
    folderPath = await fs.realpath(scannedFolderPath);
  } catch (error) {
    fail('FOLDER_UNAVAILABLE', 'The scanned service folder is no longer available.', {
      folderPath: scannedFolderPath,
      cause: error.code || null
    });
  }
  if (folderPath !== scannedFolderPath
    || (scan.source?.locator && path.resolve(scan.source.locator) !== folderPath)) {
    fail('SOURCE_FOLDER_CHANGED', 'The selected service folder changed after it was scanned. Refresh and try again.');
  }
  const root = requireAbsoluteFolder(destinationRoot);
  if (pathIsInside(folderPath, root) || pathIsInside(root, folderPath)) {
    fail('OVERLAPPING_SNAPSHOT_FOLDER', 'The local snapshot cache must be separate from the selected service folder.');
  }
  const generationId = `${safeSegment(selectedSet.serviceDate || 'undated')}-${safeSegment(profileId, 'profile')}-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
  const stagingPath = path.join(root, `.staging-${generationId}`);
  const stagingAssets = path.join(stagingPath, 'assets');
  const finalPath = path.join(root, generationId);
  const publishedAssets = path.join(finalPath, 'assets');

  await fs.mkdir(stagingAssets, { recursive: true });
  let published = false;
  try {
    const inputs = {};
    for (const role of scan.inputRoles) {
      const candidate = selectedSet.inputs[role.id];
      if (!candidate) continue;
      inputs[role.id] = await copyPinnedInput({
        folderPath,
        stagingAssets,
        publishedAssets,
        roleId: role.id,
        candidate
      });
    }
    if (Object.keys(inputs).length === 0) {
      fail('EMPTY_SERVICE_SET', 'None of the discovered files matched a configured input.');
    }

    const warnings = [...selectedSet.warnings];
    if (selectedSet.dateStatus !== 'not-applicable'
      && selectedSet.serviceDate !== scan.requestedDate
      && !warnings.some(warning => ['SERVICE_DATE_MISMATCH', 'SERVICE_DATE_UNKNOWN'].includes(warning.code))) {
      warnings.push({
        code: selectedSet.serviceDate ? 'SERVICE_DATE_MISMATCH' : 'SERVICE_DATE_UNKNOWN',
        requestedDate: scan.requestedDate,
        selectedDate: selectedSet.serviceDate
      });
    }
    const manifest = {
      schemaVersion: CURRENT_SERVICE_SET_SCHEMA_VERSION,
      id: generationId,
      name: `${profileName || 'Service'} — ${selectedSet.serviceDate || 'Undated'}`,
      profileId,
      serviceDate: selectedSet.serviceDate,
      requestedDate: scan.requestedDate,
      timeZone: timeZone || null,
      createdAt: new Date().toISOString(),
      source: {
        type: 'local-folder',
        locator: folderPath,
        scanFingerprint: scan.scanFingerprint,
        scannedAt: scan.scannedAt
      },
      inputs,
      warnings
    };
    await fs.writeFile(
      path.join(stagingPath, 'service-set.json'),
      `${JSON.stringify(manifest, null, 2)}\n`,
      { encoding: 'utf8', mode: 0o600 }
    );
    await fs.mkdir(root, { recursive: true });
    await serializeSnapshotPublication(async () => {
      await fs.rename(stagingPath, finalPath);
      published = true;
      try {
        await atomicWriteJson(path.join(root, 'current.json'), manifest);
      } catch (error) {
        await fs.rm(finalPath, { recursive: true, force: true }).catch(() => {});
        published = false;
        throw error;
      }

      // Cleanup is deliberately best effort after current.json is committed:
      // a full cache must never turn a successfully pinned current service into
      // a failed load or remove the generation that current.json points at.
      await prunePinnedServiceSetsUnlocked(root).catch(error => {
        console.warn(`[ServiceSet] Could not prune old snapshots: ${error.message}`);
      });
    });
    return manifest;
  } catch (error) {
    await fs.rm(published ? finalPath : stagingPath, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

/**
 * Materialize a coherent remote Drive set into the same immutable local
 * snapshot store used by local folders. The provider owns authenticated
 * network I/O; this boundary owns byte limits, integrity, and publication.
 */
async function pinRemoteServiceSet({
  scan,
  setId,
  destinationRoot,
  profileId,
  profileName,
  timeZone,
  materialize,
  checkCandidateUnchanged,
  maxFileBytes = DEFAULT_REMOTE_MAX_FILE_BYTES,
  maxTotalBytes = DEFAULT_REMOTE_MAX_TOTAL_BYTES
}) {
  const selectedSet = requireSelectedSet(scan, setId);
  const sourceType = scan?.source?.type;
  if (!isRemoteSourceType(sourceType)
    || containsCredentialField(scan.source)
    || !Array.isArray(scan.inputRoles)
    || typeof materialize !== 'function') {
    fail('INVALID_REMOTE_SCAN', 'The Google Drive scan is not valid for offline loading.');
  }
  const fileByteLimit = validateRemoteByteLimit(
    maxFileBytes,
    DEFAULT_REMOTE_MAX_FILE_BYTES,
    MAX_REMOTE_MAX_FILE_BYTES,
    'INVALID_REMOTE_FILE_LIMIT',
    'Remote file limit'
  );
  const totalByteLimit = validateRemoteByteLimit(
    maxTotalBytes,
    DEFAULT_REMOTE_MAX_TOTAL_BYTES,
    MAX_REMOTE_MAX_TOTAL_BYTES,
    'INVALID_REMOTE_TOTAL_LIMIT',
    'Remote service limit'
  );
  if (fileByteLimit > totalByteLimit) {
    fail('INVALID_REMOTE_LIMITS', 'The per-file Google Drive limit cannot exceed the total service limit.');
  }

  const root = requireAbsoluteFolder(destinationRoot);
  const generationId = `${safeSegment(selectedSet.serviceDate || 'undated')}-${safeSegment(profileId, 'profile')}-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
  const stagingPath = path.join(root, `.staging-${generationId}`);
  const stagingAssets = path.join(stagingPath, 'assets');
  const finalPath = path.join(root, generationId);
  const publishedAssets = path.join(finalPath, 'assets');

  await fs.mkdir(stagingAssets, { recursive: true, mode: 0o700 });
  let published = false;
  try {
    const inputs = {};
    let totalBytes = 0;
    for (const role of scan.inputRoles) {
      if (!ROLE_ID_PATTERN.test(role?.id || '')) {
        fail('INVALID_REMOTE_SCAN', 'The Google Drive scan contains an invalid input role.');
      }
      const candidate = selectedSet.inputs?.[role.id];
      if (!candidate) continue;
      const remainingBytes = totalByteLimit - totalBytes;
      if (remainingBytes < 1) {
        fail('REMOTE_SERVICE_TOO_LARGE', 'The Google Drive service exceeds the total download limit.', {
          maximumBytes: totalByteLimit
        });
      }
      const pinnedInput = await materializeRemoteInput({
        stagingAssets,
        publishedAssets,
        roleId: role.id,
        candidate,
        materialize,
        checkCandidateUnchanged,
        maximumBytes: Math.min(fileByteLimit, remainingBytes)
      });
      totalBytes += pinnedInput.size;
      if (totalBytes > totalByteLimit) {
        fail('REMOTE_SERVICE_TOO_LARGE', 'The Google Drive service exceeds the total download limit.', {
          maximumBytes: totalByteLimit
        });
      }
      inputs[role.id] = pinnedInput;
    }
    if (Object.keys(inputs).length === 0) {
      fail('EMPTY_SERVICE_SET', 'None of the discovered Google Drive files matched a configured input.');
    }

    const expectedAssetNames = new Set(Object.values(inputs).map(input => path.basename(input.pinnedPath)));
    const actualAssetEntries = await fs.readdir(stagingAssets, { withFileTypes: true });
    if (actualAssetEntries.length !== expectedAssetNames.size
      || actualAssetEntries.some(entry => !entry.isFile() || !expectedAssetNames.has(entry.name))) {
      fail('REMOTE_MATERIALIZE_INVALID', 'Google Drive materialization produced unexpected local files.');
    }

    const warnings = [...selectedSet.warnings];
    if (selectedSet.dateStatus !== 'not-applicable'
      && selectedSet.serviceDate !== scan.requestedDate
      && !warnings.some(warning => ['SERVICE_DATE_MISMATCH', 'SERVICE_DATE_UNKNOWN'].includes(warning.code))) {
      warnings.push({
        code: selectedSet.serviceDate ? 'SERVICE_DATE_MISMATCH' : 'SERVICE_DATE_UNKNOWN',
        requestedDate: scan.requestedDate,
        selectedDate: selectedSet.serviceDate
      });
    }
    const manifest = {
      schemaVersion: CURRENT_SERVICE_SET_SCHEMA_VERSION,
      id: generationId,
      name: `${profileName || 'Service'} — ${selectedSet.serviceDate || 'Undated'}`,
      profileId,
      serviceDate: selectedSet.serviceDate,
      requestedDate: scan.requestedDate,
      timeZone: timeZone || null,
      createdAt: new Date().toISOString(),
      source: {
        type: sourceType,
        locator: null,
        scanFingerprint: scan.scanFingerprint,
        scannedAt: scan.scannedAt
      },
      inputs,
      warnings
    };
    if (containsCredentialField(manifest.source)
      || Object.values(inputs).some(input => containsCredentialField(input.remote))) {
      fail('INVALID_REMOTE_CREDENTIAL_METADATA', 'Google Drive credentials cannot be stored in a service snapshot.');
    }
    await fs.writeFile(
      path.join(stagingPath, 'service-set.json'),
      `${JSON.stringify(manifest, null, 2)}\n`,
      { encoding: 'utf8', mode: 0o600 }
    );
    await fs.mkdir(root, { recursive: true });
    await serializeSnapshotPublication(async () => {
      await fs.rename(stagingPath, finalPath);
      published = true;
      try {
        await atomicWriteJson(path.join(root, 'current.json'), manifest);
      } catch (error) {
        await fs.rm(finalPath, { recursive: true, force: true }).catch(() => {});
        published = false;
        throw error;
      }
      await prunePinnedServiceSetsUnlocked(root).catch(error => {
        console.warn(`[ServiceSet] Could not prune old snapshots: ${error.message}`);
      });
    });
    return manifest;
  } catch (error) {
    await fs.rm(published ? finalPath : stagingPath, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

function validatePinnedManifest(manifest, destinationRoot) {
  const root = requireAbsoluteFolder(destinationRoot);
  const sourceType = manifest?.source?.type;
  const localSource = sourceType === 'local-folder';
  const remoteSource = isRemoteSourceType(sourceType);
  if (!isRecord(manifest)
    || manifest.schemaVersion !== CURRENT_SERVICE_SET_SCHEMA_VERSION
    || typeof manifest.id !== 'string'
    || !GENERATION_ID_PATTERN.test(manifest.id)
    || manifest.id === '.'
    || manifest.id === '..'
    || !isRecord(manifest.inputs)
    || !Array.isArray(manifest.warnings)
    || (manifest.serviceDate !== null && !isValidIsoDate(manifest.serviceDate))
    || !isValidIsoDate(manifest.requestedDate)
    || !isRecord(manifest.source)
    || (!localSource && !remoteSource)
    || (localSource
      && (typeof manifest.source.locator !== 'string'
        || !path.isAbsolute(manifest.source.locator)))
    || (remoteSource && manifest.source.locator !== null)
    || containsCredentialField(manifest.source)) {
    fail('INVALID_PINNED_SET', 'The saved service snapshot is not compatible with this SyncShow build.');
  }

  const assetsRoot = path.join(root, manifest.id, 'assets');
  for (const [roleId, input] of Object.entries(manifest.inputs)) {
    const commonInvalid = !ROLE_ID_PATTERN.test(roleId)
      || !isRecord(input)
      || input.roleId !== roleId
      || typeof input.pinnedPath !== 'string'
      || !path.isAbsolute(input.pinnedPath)
      || path.dirname(path.resolve(input.pinnedPath)) !== assetsRoot
      || !SUPPORTED_EXTENSIONS.includes(path.extname(input.pinnedPath).toLowerCase())
      || !Number.isSafeInteger(input.size)
      || input.size <= 0
      || typeof input.sha256 !== 'string'
      || !SHA256_PATTERN.test(input.sha256)
      || input.assetId !== `sha256:${input.sha256}`;
    const localInvalid = localSource && (
      typeof input.sourcePath !== 'string'
      || !path.isAbsolute(input.sourcePath)
      || input.remote !== undefined
    );
    const remote = input.remote;
    const remoteInvalid = remoteSource && (
      input.sourcePath !== null
      || typeof input.sourceRelativePath !== 'string'
      || input.sourceRelativePath.length < 1
      || !isRecord(remote)
      || !REMOTE_ID_PATTERN.test(remote?.fileId || '')
      || (remote.resourceKey !== null && !RESOURCE_KEY_PATTERN.test(remote.resourceKey || ''))
      || (remote.version !== null && !REMOTE_VERSION_PATTERN.test(remote.version || ''))
      || (remote.mimeType !== null && typeof remote.mimeType !== 'string')
      || (remote.exportMimeType !== null && typeof remote.exportMimeType !== 'string')
      || (remote.sourceSize !== null
        && (!Number.isSafeInteger(remote.sourceSize) || remote.sourceSize < 1))
      || ((remote.checksumAlgorithm === null) !== (remote.checksum === null))
      || (remote.checksumAlgorithm !== null
        && ![
          ['md5', /^[a-f0-9]{32}$/],
          ['sha1', /^[a-f0-9]{40}$/],
          ['sha256', SHA256_PATTERN]
        ].some(([algorithm, pattern]) => (
          remote.checksumAlgorithm === algorithm
          && pattern.test(remote.checksum || '')
        )))
      || containsCredentialField(remote)
    );
    if (commonInvalid || localInvalid || remoteInvalid) {
      fail('INVALID_PINNED_SET', `The saved input for role "${roleId}" is invalid.`);
    }
  }
  return manifest;
}

async function readValidPinnedManifestFile(root, fileName) {
  try {
    const manifest = JSON.parse(await fs.readFile(path.join(root, fileName), 'utf8'));
    validatePinnedManifest(manifest, root);
    return manifest;
  } catch (error) {
    return null;
  }
}

function validateRetentionLimit(maxGenerations) {
  if (!Number.isInteger(maxGenerations)
    || maxGenerations < MIN_PINNED_GENERATIONS
    || maxGenerations > MAX_PINNED_GENERATIONS) {
    fail(
      'INVALID_RETENTION_LIMIT',
      `Snapshot retention must be between ${MIN_PINNED_GENERATIONS} and ${MAX_PINNED_GENERATIONS} generations.`,
      { minimum: MIN_PINNED_GENERATIONS, maximum: MAX_PINNED_GENERATIONS }
    );
  }
  return maxGenerations;
}

async function restoreGarbageCollectionCandidate(tombstonePath, generationPath) {
  try {
    await fs.rename(tombstonePath, generationPath);
    return true;
  } catch (error) {
    return false;
  }
}

async function prunePinnedServiceSetsUnlocked(
  destinationRoot,
  { maxGenerations = DEFAULT_MAX_PINNED_GENERATIONS } = {}
) {
  const root = requireAbsoluteFolder(destinationRoot);
  const retentionLimit = validateRetentionLimit(maxGenerations);
  const current = await readValidPinnedManifestFile(root, 'current.json');
  if (!current) {
    return {
      deletedIds: [],
      retainedIds: [],
      failedIds: [],
      skippedReason: 'current-unavailable'
    };
  }

  let entries;
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') {
      return {
        deletedIds: [],
        retainedIds: [],
        failedIds: [],
        skippedReason: 'store-unavailable'
      };
    }
    throw error;
  }

  const generations = [];
  for (const entry of entries) {
    // Never follow links or delete unrecognized directories. Only a directory
    // with a self-consistent SyncShow manifest qualifies as a successful old
    // generation and is eligible for retention cleanup.
    if (!entry.isDirectory()
      || !GENERATION_ID_PATTERN.test(entry.name)
      || entry.name === '.'
      || entry.name === '..') {
      continue;
    }
    const manifest = await readValidPinnedManifestFile(
      root,
      path.join(entry.name, 'service-set.json')
    );
    const createdAtMs = Date.parse(manifest?.createdAt);
    if (!manifest || manifest.id !== entry.name || !Number.isFinite(createdAtMs)) continue;
    generations.push({ id: entry.name, createdAtMs });
  }

  const generationIds = new Set(generations.map(generation => generation.id));
  if (!generationIds.has(current.id)) {
    return {
      deletedIds: [],
      retainedIds: [],
      failedIds: [],
      skippedReason: 'current-generation-unavailable'
    };
  }

  generations.sort((first, second) => (
    second.createdAtMs - first.createdAtMs
    || second.id.localeCompare(first.id, 'en')
  ));

  const retainedIds = new Set([current.id]);
  const backup = await readValidPinnedManifestFile(root, 'current.json.bak');
  if (backup && generationIds.has(backup.id)) retainedIds.add(backup.id);
  for (const generation of generations) {
    if (retainedIds.size >= retentionLimit) break;
    retainedIds.add(generation.id);
  }

  const deletedIds = [];
  const failedIds = [];
  let skippedReason = null;
  for (const generation of generations) {
    if (retainedIds.has(generation.id)) continue;

    // Abort if another publication changed the active generation. Calls from
    // SyncShow are serialized, and this check also makes a direct maintenance
    // call fail closed if current.json changes unexpectedly.
    const currentBeforeDelete = await readValidPinnedManifestFile(root, 'current.json');
    if (!currentBeforeDelete || currentBeforeDelete.id !== current.id) {
      skippedReason = 'current-changed';
      break;
    }

    const generationPath = path.join(root, generation.id);
    const tombstonePath = path.join(
      root,
      `.gc-${generation.id}-${crypto.randomUUID().slice(0, 8)}`
    );
    try {
      const stats = await fs.lstat(generationPath);
      if (!stats.isDirectory() || stats.isSymbolicLink()) {
        failedIds.push(generation.id);
        continue;
      }
      await fs.rename(generationPath, tombstonePath);

      const currentAfterRename = await readValidPinnedManifestFile(root, 'current.json');
      if (!currentAfterRename
        || currentAfterRename.id !== current.id
        || currentAfterRename.id === generation.id) {
        await restoreGarbageCollectionCandidate(tombstonePath, generationPath);
        skippedReason = 'current-changed';
        break;
      }

      try {
        await fs.rm(tombstonePath, { recursive: true, force: true });
        deletedIds.push(generation.id);
      } catch (error) {
        await restoreGarbageCollectionCandidate(tombstonePath, generationPath);
        failedIds.push(generation.id);
      }
    } catch (error) {
      if (error.code !== 'ENOENT') failedIds.push(generation.id);
    }
  }

  return {
    deletedIds,
    retainedIds: generations
      .map(generation => generation.id)
      .filter(id => retainedIds.has(id)),
    failedIds,
    skippedReason
  };
}

/** Keep current plus recent verified fallback generations within a hard bound. */
async function prunePinnedServiceSets(destinationRoot, options) {
  return serializeSnapshotPublication(
    () => prunePinnedServiceSetsUnlocked(destinationRoot, options)
  );
}

async function verifyPinnedServiceSet(manifest, destinationRoot, { verifyHashes = true } = {}) {
  const root = requireAbsoluteFolder(destinationRoot);
  validatePinnedManifest(manifest, root);
  let realAssetsRoot;
  try {
    const realRoot = await fs.realpath(root);
    realAssetsRoot = path.join(realRoot, manifest.id, 'assets');
  } catch (error) {
    fail('PINNED_ASSET_UNAVAILABLE', 'The local service snapshot folder is unavailable.', {
      cause: error.code || null
    });
  }
  for (const input of Object.values(manifest.inputs)) {
    let stats;
    let realPinnedPath;
    try {
      stats = await fs.lstat(input.pinnedPath);
      realPinnedPath = await fs.realpath(input.pinnedPath);
    } catch (error) {
      fail('PINNED_ASSET_UNAVAILABLE', `${input.sourceName || input.roleId} is missing from the local snapshot.`, {
        roleId: input.roleId,
        cause: error.code || null
      });
    }
    if (!stats.isFile()
      || stats.isSymbolicLink()
      || stats.size !== input.size
      || path.dirname(realPinnedPath) !== realAssetsRoot) {
      fail('PINNED_ASSET_CHANGED', `${input.sourceName || input.roleId} changed in the local snapshot.`, {
        roleId: input.roleId
      });
    }
    if (verifyHashes && await hashFile(input.pinnedPath) !== input.sha256) {
      fail('PINNED_ASSET_CHANGED', `${input.sourceName || input.roleId} failed its local integrity check.`, {
        roleId: input.roleId
      });
    }
  }
  return manifest;
}

async function readCurrentServiceSet(destinationRoot, { verifyAssets = false } = {}) {
  try {
    const root = requireAbsoluteFolder(destinationRoot);
    const raw = JSON.parse(await fs.readFile(path.join(root, 'current.json'), 'utf8'));
    validatePinnedManifest(raw, root);
    if (verifyAssets) await verifyPinnedServiceSet(raw, root);
    return raw;
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    if (error instanceof ServiceSetError) throw error;
    fail('INVALID_PINNED_SET', `The saved service snapshot could not be read: ${error.message}`);
  }
}

async function checkSourceChanges(manifest) {
  if (!manifest?.inputs || typeof manifest.inputs !== 'object') return [];
  // Remote sources are checked through their provider using the private file
  // identity stored in each input. Network loss must not make a valid offline
  // snapshot appear corrupt or unavailable to the local-only checker.
  if (isRemoteSourceType(manifest.source?.type)) return [];
  const sourceRoot = typeof manifest.source?.locator === 'string'
    && path.isAbsolute(manifest.source.locator)
    ? path.resolve(manifest.source.locator)
    : null;
  let realSourceRoot = null;
  try {
    if (sourceRoot) realSourceRoot = await fs.realpath(sourceRoot);
  } catch (error) {
    realSourceRoot = null;
  }
  const changes = [];
  for (const input of Object.values(manifest.inputs)) {
    try {
      if (!sourceRoot
        || !realSourceRoot
        || typeof input.sourcePath !== 'string'
        || !path.isAbsolute(input.sourcePath)
        || !pathIsInside(sourceRoot, path.resolve(input.sourcePath))) {
        throw Object.assign(new Error('Source path escaped the service folder.'), { code: 'SOURCE_OUTSIDE_FOLDER' });
      }
      const stats = await fs.lstat(input.sourcePath);
      if (stats.isSymbolicLink()) {
        throw Object.assign(new Error('Source became a symbolic link.'), { code: 'SYMBOLIC_LINK' });
      }
      const realSourcePath = await fs.realpath(input.sourcePath);
      const expectedSourcePath = typeof input.sourceRelativePath === 'string'
        ? path.resolve(realSourceRoot, input.sourceRelativePath)
        : path.resolve(input.sourcePath);
      if (!pathIsInside(realSourceRoot, realSourcePath) || realSourcePath !== expectedSourcePath) {
        throw Object.assign(new Error('Source path escaped the service folder.'), { code: 'SOURCE_OUTSIDE_FOLDER' });
      }
      if (stats.size !== input.size
        || Math.trunc(stats.mtimeMs) !== Math.trunc(input.sourceModifiedTimeMs)
        || (Number.isSafeInteger(input.sourceDevice)
          && input.sourceDevice !== 0
          && stats.dev !== input.sourceDevice)
        || (Number.isSafeInteger(input.sourceInode)
          && input.sourceInode !== 0
          && stats.ino !== input.sourceInode)) {
        changes.push({ roleId: input.roleId, sourceName: input.sourceName, status: 'changed' });
      }
    } catch (error) {
      changes.push({
        roleId: input.roleId,
        sourceName: input.sourceName,
        status: 'unavailable',
        cause: error.code || null
      });
    }
  }
  return changes;
}

module.exports = {
  CURRENT_SERVICE_SET_SCHEMA_VERSION,
  DEFAULT_MAX_PINNED_GENERATIONS,
  DEFAULT_REMOTE_MAX_FILE_BYTES,
  DEFAULT_REMOTE_MAX_TOTAL_BYTES,
  MAX_PINNED_GENERATIONS,
  MAX_REMOTE_MAX_FILE_BYTES,
  MAX_REMOTE_MAX_TOTAL_BYTES,
  MIN_PINNED_GENERATIONS,
  REMOTE_SOURCE_TYPES,
  atomicWriteJson,
  checkSourceChanges,
  hashFile,
  pinServiceSet,
  pinRemoteServiceSet,
  prunePinnedServiceSets,
  readCurrentServiceSet,
  safeSegment,
  validatePinnedManifest,
  verifyPinnedServiceSet
};
