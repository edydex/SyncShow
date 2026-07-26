'use strict';

const crypto = require('crypto');
const path = require('path');

const { parseServiceDate } = require('../service-set/ServiceDate');
const {
  MAX_RESOLVER_FILES,
  ServiceSetError,
  extractVersionRank,
  isTemporaryFileName,
  matchFileToRoles,
  resolveServiceSets,
  validateInputRoles
} = require('../service-set/ServiceSetResolver');

const DRIVE_FOLDER_MIME_TYPE = 'application/vnd.google-apps.folder';
const DRIVE_SHORTCUT_MIME_TYPE = 'application/vnd.google-apps.shortcut';
const GOOGLE_SLIDES_MIME_TYPE = 'application/vnd.google-apps.presentation';
const PPT_MIME_TYPE = 'application/vnd.ms-powerpoint';
const PPTX_MIME_TYPE = 'application/vnd.openxmlformats-officedocument.presentationml.presentation';
const PPTX_EXPORT_MIME_TYPE = PPTX_MIME_TYPE;
const DRIVE_SOURCE_TYPES = Object.freeze(['google-drive-private', 'google-drive-public']);
const DEFAULT_MAX_DRIVE_FILES = 1000;
const DRIVE_ID_PATTERN = /^[A-Za-z0-9_-]{10,200}$/;
const RESOURCE_KEY_PATTERN = /^[A-Za-z0-9_-]{1,200}$/;
const MAX_DRIVE_NAME_LENGTH = 1024;
const MAX_REMOTE_PATH_LENGTH = 4096;
const MAX_VERSION_LENGTH = 128;

function fail(code, message, details = {}) {
  throw new ServiceSetError(code, message, details);
}

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function requireDriveSourceType(value) {
  if (!DRIVE_SOURCE_TYPES.includes(value)) {
    fail('INVALID_DRIVE_SOURCE', 'Choose a supported Google Drive connection.');
  }
  return value;
}

function boundedString(value, maximumLength) {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= maximumLength
    && !value.includes('\0');
}

function normalizeRemotePath(value, fallbackName) {
  const candidate = typeof value === 'string' && value.trim()
    ? value
    : fallbackName;
  if (!boundedString(candidate, MAX_REMOTE_PATH_LENGTH)) return null;
  const segments = candidate
    .replace(/\\/g, '/')
    .split('/')
    .filter(segment => segment && segment !== '.');
  if (segments.some(segment => segment === '..')) return null;
  return segments.join('/');
}

function normalizedResourceKey(value) {
  if (value === undefined || value === null || value === '') return null;
  return typeof value === 'string' && RESOURCE_KEY_PATTERN.test(value) ? value : null;
}

function normalizedVersion(value) {
  if (value === undefined || value === null || value === '') return null;
  const result = String(value);
  return boundedString(result, MAX_VERSION_LENGTH) ? result : null;
}

function parseRemoteSize(value) {
  if (value === undefined || value === null || value === '') return null;
  const result = typeof value === 'number' ? value : Number(value);
  return Number.isSafeInteger(result) && result >= 0 ? result : null;
}

function parseModifiedTime(value) {
  if (typeof value !== 'string') return null;
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) return null;
  return {
    modifiedTime: new Date(milliseconds).toISOString(),
    modifiedTimeMs: Math.trunc(milliseconds)
  };
}

function inferRemoteServiceDate(name, relativePath, dateOrder) {
  const fromName = parseServiceDate(name, { dateOrder });
  if (fromName) return { serviceDate: fromName, serviceDateSource: 'filename' };
  const parentSegments = path.posix.dirname(relativePath)
    .split('/')
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

function sourceFormat(metadata) {
  const extension = path.extname(metadata.name).toLowerCase();
  if (metadata.mimeType === GOOGLE_SLIDES_MIME_TYPE) {
    return {
      extension: '.pptx',
      sourceExtension: null,
      exportMimeType: PPTX_EXPORT_MIME_TYPE,
      nativeGoogleSlides: true
    };
  }
  if (metadata.mimeType === PPTX_MIME_TYPE && extension === '.pptx') {
    return {
      extension: '.pptx',
      sourceExtension: '.pptx',
      exportMimeType: null,
      nativeGoogleSlides: false
    };
  }
  if (metadata.mimeType === PPT_MIME_TYPE && extension === '.ppt') {
    return {
      extension: '.ppt',
      sourceExtension: '.ppt',
      exportMimeType: null,
      nativeGoogleSlides: false
    };
  }
  return null;
}

function preferredDriveChecksum(metadata) {
  const options = [
    ['sha256', metadata.sha256Checksum, /^[a-fA-F0-9]{64}$/],
    ['sha1', metadata.sha1Checksum, /^[a-fA-F0-9]{40}$/],
    ['md5', metadata.md5Checksum, /^[a-fA-F0-9]{32}$/]
  ];
  for (const [algorithm, value, pattern] of options) {
    if (typeof value === 'string' && pattern.test(value)) {
      return { algorithm, value: value.toLowerCase() };
    }
  }
  return null;
}

function privateCandidateKey(fileId) {
  return crypto.createHash('sha256').update(fileId).digest('hex').slice(0, 16);
}

/**
 * Convert one sanitized Drive file resource into the same resolver candidate
 * shape used by local service folders. Unsupported or malformed resources
 * return an ignored reason rather than leaking provider response fields.
 */
function normalizeDriveFileCandidate(metadata, {
  inputRoles,
  requestedDate,
  dateOrder = 'mdy'
}) {
  if (!isRecord(metadata)) return { candidate: null, reason: 'invalid-metadata' };
  if (metadata.trashed === true) return { candidate: null, reason: 'trashed' };
  if (!boundedString(metadata.id, 256) || !DRIVE_ID_PATTERN.test(metadata.id)) {
    return { candidate: null, reason: 'invalid-file-id' };
  }
  if (!boundedString(metadata.name, MAX_DRIVE_NAME_LENGTH)) {
    return { candidate: null, reason: 'invalid-name' };
  }
  if (isTemporaryFileName(metadata.name)) return { candidate: null, reason: 'temporary' };
  if (metadata.mimeType === DRIVE_FOLDER_MIME_TYPE) return { candidate: null, reason: 'folder' };
  if (metadata.mimeType === DRIVE_SHORTCUT_MIME_TYPE) return { candidate: null, reason: 'shortcut' };

  const format = sourceFormat(metadata);
  if (!format) return { candidate: null, reason: 'unsupported-type' };
  const modified = parseModifiedTime(metadata.modifiedTime);
  if (!modified) return { candidate: null, reason: 'invalid-modified-time' };
  const displayRelativePath = normalizeRemotePath(metadata.relativePath, metadata.name);
  if (!displayRelativePath) return { candidate: null, reason: 'invalid-relative-path' };

  const resourceKey = normalizedResourceKey(metadata.resourceKey);
  if (metadata.resourceKey && !resourceKey) return { candidate: null, reason: 'invalid-resource-key' };
  const version = normalizedVersion(metadata.version);
  if (metadata.version !== undefined && metadata.version !== null && !version) {
    return { candidate: null, reason: 'invalid-version' };
  }
  const sourceSize = parseRemoteSize(metadata.size);
  if (!format.nativeGoogleSlides && (!Number.isSafeInteger(sourceSize) || sourceSize < 1)) {
    return { candidate: null, reason: 'invalid-size' };
  }

  const roleMatch = matchFileToRoles(metadata.name, inputRoles);
  const matchedRole = roleMatch.roleIds.length === 1
    ? inputRoles.find(role => role.id === roleMatch.roleIds[0])
    : null;
  const datePolicy = matchedRole?.datePolicy || 'service-date';
  const parsedDate = inferRemoteServiceDate(metadata.name, displayRelativePath, dateOrder);
  const serviceDate = datePolicy === 'none' ? null : parsedDate.serviceDate;
  const available = metadata.capabilities?.canDownload !== false;
  // Native Google Slides are exported to new PPTX bytes, so any provider-side
  // checksum describes the source document rather than the materialized file.
  const checksum = format.nativeGoogleSlides ? null : preferredDriveChecksum(metadata);

  return {
    candidate: {
      id: metadata.id,
      fileId: metadata.id,
      resourceKey,
      name: metadata.name,
      relativePath: `${displayRelativePath} [drive-${privateCandidateKey(metadata.id)}]`,
      displayRelativePath,
      extension: format.extension,
      sourceExtension: format.sourceExtension,
      sourceMimeType: metadata.mimeType,
      exportMimeType: format.exportMimeType,
      nativeGoogleSlides: format.nativeGoogleSlides,
      size: format.nativeGoogleSlides ? null : sourceSize,
      modifiedTime: modified.modifiedTime,
      modifiedTimeMs: modified.modifiedTimeMs,
      version,
      driveChecksumAlgorithm: checksum?.algorithm || null,
      driveChecksum: checksum?.value || null,
      serviceDate,
      parsedServiceDate: parsedDate.serviceDate,
      serviceDateSource: parsedDate.serviceDateSource,
      datePolicy,
      dateStatus: fileDateStatus(serviceDate, requestedDate, datePolicy),
      dateNeutral: datePolicy === 'none',
      available,
      availability: available ? 'remote-downloadable' : 'download-disabled',
      availabilityError: available ? null : 'download-disabled',
      versionRank: extractVersionRank(metadata.name),
      matchedRoleIds: roleMatch.roleIds,
      roleMatchScore: roleMatch.score,
      ambiguousRoleMatch: roleMatch.ambiguous
    },
    reason: null
  };
}

function driveScanFingerprint(files) {
  const canonical = files
    .map(file => [
      file.fileId,
      file.resourceKey,
      file.version,
      file.size,
      file.modifiedTimeMs,
      file.driveChecksumAlgorithm,
      file.driveChecksum,
      file.available
    ])
    .sort((first, second) => String(first[0]).localeCompare(String(second[0])))
    .map(value => JSON.stringify(value))
    .join('\n');
  return crypto.createHash('sha256').update(canonical).digest('hex');
}

/**
 * Resolve already-enumerated Drive metadata into coherent service sets.
 * Authentication, pagination, shortcut traversal, and API response limits stay
 * in the provider; this boundary accepts only the bounded metadata page result.
 */
function scanDriveServiceFiles({
  sourceType,
  folderId,
  folderResourceKey = null,
  files,
  inputRoles,
  requiredRoleIds = [],
  requestedDate,
  dateOrder = 'mdy',
  maxFiles = DEFAULT_MAX_DRIVE_FILES,
  scannedAt = new Date().toISOString()
}) {
  requireDriveSourceType(sourceType);
  if (!DRIVE_ID_PATTERN.test(folderId || '')) {
    fail('INVALID_DRIVE_FOLDER', 'The selected Google Drive folder ID is invalid.');
  }
  const normalizedFolderResourceKey = normalizedResourceKey(folderResourceKey);
  if (folderResourceKey && !normalizedFolderResourceKey) {
    fail('INVALID_DRIVE_FOLDER', 'The selected Google Drive folder resource key is invalid.');
  }
  if (!Array.isArray(files)
    || !Number.isInteger(maxFiles)
    || maxFiles < 1
    || maxFiles > MAX_RESOLVER_FILES
    || files.length > maxFiles) {
    fail('DRIVE_SCAN_FILE_LIMIT', `The Google Drive folder can contain at most ${maxFiles} scanned items.`);
  }
  if (!['mdy', 'dmy'].includes(dateOrder)) {
    fail('INVALID_DATE_ORDER', 'Date order must be either mdy or dmy.');
  }
  if (!Number.isFinite(Date.parse(scannedAt))) {
    fail('INVALID_SCAN_TIME', 'The Google Drive scan time is invalid.');
  }
  validateInputRoles(inputRoles, requiredRoleIds);
  // Let the authoritative resolver validate the service date before iterating
  // provider metadata, matching the local scanner's stable error behavior.
  resolveServiceSets({ files: [], inputRoles, requiredRoleIds, requestedDate });

  const candidates = [];
  const ignoredFiles = [];
  const seenIds = new Set();
  for (const metadata of files) {
    const result = normalizeDriveFileCandidate(metadata, {
      inputRoles,
      requestedDate,
      dateOrder
    });
    if (!result.candidate) {
      ignoredFiles.push({
        name: typeof metadata?.name === 'string' ? metadata.name : null,
        reason: result.reason
      });
      continue;
    }
    if (seenIds.has(result.candidate.fileId)) {
      fail('DUPLICATE_DRIVE_FILE', 'Google Drive returned the same file more than once.');
    }
    seenIds.add(result.candidate.fileId);
    candidates.push(result.candidate);
  }

  const resolution = resolveServiceSets({
    files: candidates,
    inputRoles,
    requiredRoleIds,
    requestedDate
  });
  return {
    schemaVersion: 1,
    source: {
      type: sourceType,
      folderId,
      resourceKey: normalizedFolderResourceKey
    },
    folderPath: null,
    scannedAt: new Date(scannedAt).toISOString(),
    inputRoles: inputRoles.map(role => ({
      id: role.id,
      label: role.label,
      required: requiredRoleIds.includes(role.id),
      filenameMatchers: [...role.filenameMatchers],
      datePolicy: role.datePolicy || 'service-date'
    })),
    files: candidates,
    unmatchedFiles: candidates.filter(file => file.matchedRoleIds.length === 0),
    ignoredFiles,
    limits: { maxFiles },
    ...resolution,
    scanFingerprint: driveScanFingerprint(candidates)
  };
}

module.exports = {
  DEFAULT_MAX_DRIVE_FILES,
  DRIVE_FOLDER_MIME_TYPE,
  DRIVE_SHORTCUT_MIME_TYPE,
  DRIVE_SOURCE_TYPES,
  GOOGLE_SLIDES_MIME_TYPE,
  PPT_MIME_TYPE,
  PPTX_EXPORT_MIME_TYPE,
  PPTX_MIME_TYPE,
  driveScanFingerprint,
  inferRemoteServiceDate,
  normalizeDriveFileCandidate,
  scanDriveServiceFiles
};
