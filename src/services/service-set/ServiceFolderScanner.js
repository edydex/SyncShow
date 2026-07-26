'use strict';

const crypto = require('crypto');
const fs = require('fs/promises');
const path = require('path');

const { parseServiceDate } = require('./ServiceDate');
const {
  MAX_RESOLVER_FILES,
  SUPPORTED_EXTENSIONS,
  ServiceSetError,
  extractVersionRank,
  isTemporaryFileName,
  matchFileToRoles,
  resolveServiceSets,
  validateInputRoles
} = require('./ServiceSetResolver');

const DEFAULT_MAX_DEPTH = 2;
const DEFAULT_MAX_FILES = 1000;
const DEFAULT_MAX_ENTRIES = 10000;
const MAX_SCAN_DEPTH = 8;
const MAX_SCAN_ENTRIES = 50000;
const FILE_INSPECTION_CONCURRENCY = 32;

function fail(code, message, details = {}) {
  throw new ServiceSetError(code, message, details);
}

function requireAbsoluteFolder(folderPath) {
  if (typeof folderPath !== 'string' || folderPath.trim().length === 0 || folderPath.includes('\0')) {
    fail('INVALID_FOLDER', 'Choose a service folder first.');
  }
  if (!path.isAbsolute(folderPath)) fail('INVALID_FOLDER', 'The service folder must be an absolute path.');
  const resolved = path.resolve(folderPath);
  return resolved;
}

function pathIsInside(parent, child) {
  const relative = path.relative(parent, child);
  return relative === '' || (
    relative !== '..'
    && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative)
  );
}

function validateScanLimit(value, fallback, maximum, code, label) {
  const resolved = value === undefined ? fallback : value;
  if (!Number.isInteger(resolved) || resolved < 0 || resolved > maximum) {
    fail(code, `${label} must be a whole number from 0 through ${maximum}.`);
  }
  return resolved;
}

async function walkFolder(folderPath, {
  maxDepth = DEFAULT_MAX_DEPTH,
  maxFiles = DEFAULT_MAX_FILES,
  maxEntries = DEFAULT_MAX_ENTRIES
} = {}) {
  const rootPath = requireAbsoluteFolder(folderPath);
  const depthLimit = validateScanLimit(maxDepth, DEFAULT_MAX_DEPTH, MAX_SCAN_DEPTH, 'INVALID_SCAN_DEPTH', 'Scan depth');
  const fileLimit = validateScanLimit(maxFiles, DEFAULT_MAX_FILES, MAX_RESOLVER_FILES, 'INVALID_SCAN_FILE_LIMIT', 'File limit');
  const entryLimit = validateScanLimit(maxEntries, DEFAULT_MAX_ENTRIES, MAX_SCAN_ENTRIES, 'INVALID_SCAN_ENTRY_LIMIT', 'Entry limit');
  const files = [];
  const ignored = [];
  let entriesSeen = 0;

  async function walk(currentPath, depth, relativeDirectory = '') {
    let currentRealPath;
    try {
      const currentStats = await fs.lstat(currentPath);
      if (currentStats.isSymbolicLink()) {
        ignored.push({ relativePath: relativeDirectory, reason: 'symbolic-link' });
        return;
      }
      currentRealPath = await fs.realpath(currentPath);
      if (!currentStats.isDirectory() || !pathIsInside(rootPath, currentRealPath)) {
        fail('SCAN_PATH_CHANGED', 'A folder changed or escaped the selected service folder during the scan.', {
          relativePath: relativeDirectory
        });
      }
    } catch (error) {
      if (error instanceof ServiceSetError) throw error;
      if (depth === 0) {
        fail('FOLDER_UNAVAILABLE', `SyncShow cannot read the service folder: ${error.message}`, {
          folderPath: rootPath,
          cause: error.code || null
        });
      }
      ignored.push({
        relativePath: relativeDirectory,
        reason: 'unavailable-directory',
        cause: error.code || null
      });
      return;
    }

    let entries;
    try {
      entries = await fs.readdir(currentRealPath, { withFileTypes: true });
    } catch (error) {
      if (depth === 0) {
        fail('FOLDER_UNAVAILABLE', `SyncShow cannot read the service folder: ${error.message}`, {
          folderPath: rootPath,
          cause: error.code || null
        });
      }
      ignored.push({
        relativePath: relativeDirectory,
        reason: 'unavailable-directory',
        cause: error.code || null
      });
      return;
    }

    entries.sort((a, b) => a.name.localeCompare(b.name, 'en', { numeric: true, sensitivity: 'base' }));
    for (const entry of entries) {
      entriesSeen += 1;
      if (entriesSeen > entryLimit) {
        fail('SCAN_ENTRY_LIMIT', `The service folder contains more than ${entryLimit} entries. Choose a smaller folder.`, {
          maxEntries: entryLimit
        });
      }
      const entryPath = path.join(currentRealPath, entry.name);
      const relativePath = path.relative(rootPath, entryPath);
      if (!pathIsInside(rootPath, entryPath)) {
        fail('SCAN_PATH_CHANGED', 'A scanned path escaped the selected service folder.');
      }
      if (entry.isSymbolicLink()) {
        ignored.push({ relativePath, reason: 'symbolic-link' });
        continue;
      }
      if (entry.isDirectory()) {
        if (entry.name.startsWith('.')) continue;
        if (depth >= depthLimit) {
          ignored.push({ relativePath, reason: 'depth-limit' });
          continue;
        }
        await walk(entryPath, depth + 1, relativePath);
        continue;
      }
      if (!entry.isFile()) continue;
      if (isTemporaryFileName(entry.name)) {
        ignored.push({ relativePath, reason: 'temporary' });
        continue;
      }
      const extension = path.extname(entry.name).toLowerCase();
      if (!SUPPORTED_EXTENSIONS.includes(extension)) continue;
      if (files.length >= fileLimit) {
        fail('SCAN_FILE_LIMIT', `The service folder contains more than ${fileLimit} supported slide files. Choose a smaller folder.`, {
          maxFiles: fileLimit
        });
      }
      files.push({ path: entryPath, relativePath, name: entry.name, extension });
    }
  }

  await walk(rootPath, 0);
  return { files, ignored, entriesSeen };
}

function inferServiceDate(file, dateOrder) {
  const fromFileName = parseServiceDate(file.name, { dateOrder });
  if (fromFileName) return { serviceDate: fromFileName, serviceDateSource: 'filename' };
  const parentSegments = path.dirname(file.relativePath)
    .split(path.sep)
    .filter(segment => segment && segment !== '.')
    .reverse();
  for (const segment of parentSegments) {
    const fromFolderName = parseServiceDate(segment, { dateOrder });
    if (fromFolderName) return { serviceDate: fromFolderName, serviceDateSource: 'folder-name' };
  }
  return { serviceDate: null, serviceDateSource: null };
}

function fileDateStatus(serviceDate, requestedDate, datePolicy) {
  if (datePolicy === 'none') return 'not-applicable';
  if (!serviceDate) return 'unknown';
  return serviceDate === requestedDate ? 'matches' : 'different';
}

function unavailableFile(file, fields, error) {
  return {
    ...file,
    ...fields,
    id: crypto.createHash('sha256').update(file.relativePath).digest('hex').slice(0, 24),
    size: 0,
    modifiedTime: null,
    modifiedTimeMs: 0,
    device: null,
    inode: null,
    realPath: null,
    available: false,
    availability: 'unavailable',
    availabilityError: error?.code || error?.message || String(error || 'unavailable')
  };
}

async function inspectFile(file, inputRoles, dateOrder, requestedDate, folderPath) {
  const roleMatch = matchFileToRoles(file.name, inputRoles);
  const matchedRole = roleMatch.roleIds.length === 1
    ? inputRoles.find(role => role.id === roleMatch.roleIds[0])
    : null;
  const datePolicy = matchedRole?.datePolicy || 'service-date';
  const parsedDate = inferServiceDate(file, dateOrder);
  const serviceDate = datePolicy === 'none' ? null : parsedDate.serviceDate;
  const sharedFields = {
    serviceDate,
    parsedServiceDate: parsedDate.serviceDate,
    serviceDateSource: parsedDate.serviceDateSource,
    datePolicy,
    dateStatus: fileDateStatus(serviceDate, requestedDate, datePolicy),
    dateNeutral: datePolicy === 'none',
    versionRank: extractVersionRank(file.name),
    matchedRoleIds: roleMatch.roleIds,
    roleMatchScore: roleMatch.score,
    ambiguousRoleMatch: roleMatch.ambiguous
  };

  let stats;
  let realPath;
  try {
    stats = await fs.lstat(file.path);
    if (stats.isSymbolicLink()) return unavailableFile(file, sharedFields, 'symbolic-link');
    realPath = await fs.realpath(file.path);
    if (!pathIsInside(folderPath, realPath)) return unavailableFile(file, sharedFields, 'path-escaped-folder');
  } catch (error) {
    return unavailableFile(file, sharedFields, error);
  }

  const available = stats.isFile() && stats.size > 0;
  return {
    ...file,
    id: crypto.createHash('sha256')
      .update(`${file.relativePath}\0${stats.size}\0${stats.mtimeMs}`)
      .digest('hex')
      .slice(0, 24),
    size: stats.size,
    modifiedTime: stats.mtime.toISOString(),
    modifiedTimeMs: Math.trunc(stats.mtimeMs),
    device: Number.isSafeInteger(stats.dev) ? stats.dev : null,
    inode: Number.isSafeInteger(stats.ino) ? stats.ino : null,
    realPath,
    ...sharedFields,
    available,
    availability: available ? 'local-or-streamable' : 'unavailable',
    availabilityError: available ? null : (stats.isFile() ? 'empty-file' : 'not-regular-file')
  };
}

async function mapWithConcurrency(items, concurrency, worker) {
  const results = new Array(items.length);
  let nextIndex = 0;
  async function run() {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await worker(items[index], index);
    }
  }
  await Promise.all(Array.from(
    { length: Math.min(concurrency, items.length) },
    () => run()
  ));
  return results;
}

/** Scan and reconcile a local folder (including Drive Desktop folders). */
async function scanServiceFolder({
  folderPath,
  inputRoles,
  requiredRoleIds,
  requestedDate,
  dateOrder = 'mdy',
  maxDepth = DEFAULT_MAX_DEPTH,
  maxFiles = DEFAULT_MAX_FILES,
  maxEntries = DEFAULT_MAX_ENTRIES
}) {
  const selectedFolderPath = requireAbsoluteFolder(folderPath);
  if (!['mdy', 'dmy'].includes(dateOrder)) {
    fail('INVALID_DATE_ORDER', 'Date order must be either mdy or dmy.');
  }
  const normalizedRequiredRoleIds = requiredRoleIds === undefined ? [] : requiredRoleIds;
  validateInputRoles(inputRoles, normalizedRequiredRoleIds);
  // Resolve once before touching the filesystem so malformed dates receive a
  // stable ServiceSet error rather than a later filesystem-dependent failure.
  resolveServiceSets({ files: [], inputRoles, requiredRoleIds: normalizedRequiredRoleIds, requestedDate });

  let folderStats;
  let resolvedFolder;
  try {
    resolvedFolder = await fs.realpath(selectedFolderPath);
    folderStats = await fs.stat(resolvedFolder);
  } catch (error) {
    fail('FOLDER_UNAVAILABLE', `The service folder is not available: ${error.message}`, {
      folderPath: selectedFolderPath,
      cause: error.code || null
    });
  }
  if (!folderStats.isDirectory()) fail('NOT_A_FOLDER', 'The selected service location is not a folder.');

  const walked = await walkFolder(resolvedFolder, { maxDepth, maxFiles, maxEntries });
  const files = await mapWithConcurrency(
    walked.files,
    FILE_INSPECTION_CONCURRENCY,
    file => inspectFile(file, inputRoles, dateOrder, requestedDate, resolvedFolder)
  );
  const resolution = resolveServiceSets({
    files,
    inputRoles,
    requiredRoleIds: normalizedRequiredRoleIds,
    requestedDate
  });
  return {
    schemaVersion: 1,
    source: { type: 'local-folder', locator: resolvedFolder },
    folderPath: resolvedFolder,
    selectedFolderPath,
    scannedAt: new Date().toISOString(),
    inputRoles: inputRoles.map(role => ({
      id: role.id,
      label: role.label,
      required: normalizedRequiredRoleIds.includes(role.id),
      filenameMatchers: [...role.filenameMatchers],
      datePolicy: role.datePolicy || 'service-date'
    })),
    limits: { maxDepth, maxFiles, maxEntries },
    files,
    unmatchedFiles: files.filter(file => file.matchedRoleIds.length === 0),
    ignoredFiles: walked.ignored,
    ...resolution
  };
}

module.exports = {
  DEFAULT_MAX_DEPTH,
  DEFAULT_MAX_ENTRIES,
  DEFAULT_MAX_FILES,
  MAX_SCAN_DEPTH,
  MAX_SCAN_ENTRIES,
  fileDateStatus,
  inferServiceDate,
  pathIsInside,
  requireAbsoluteFolder,
  scanServiceFolder,
  walkFolder
};
