'use strict';

const crypto = require('crypto');
const { TextDecoder } = require('util');
const JSZip = require('jszip');

const {
  MAX_PROJECT_JSON_BYTES,
  isPowerPointCompanionProject,
  normalizeServiceProject,
  serializeServiceProject
} = require('./ServiceProject');
const {
  MAX_IMAGE_BYTES,
  imageFormatFromMagic
} = require('./ServiceProjectStore');
const { readFileNoFollow } = require('./StorageSafety');
const {
  failedPortableSongImportSummary,
  importPortableProjectSongs
} = require('./PortableSongLibraryImport');
const {
  failedPortableSermonImportSummary,
  importPortableProjectSermons
} = require('../sermon/PortableSermonLibraryImport');

const BUNDLE_KIND = 'syncshow-service-project-bundle';
const BUNDLE_SCHEMA_VERSION = 1;
const BUNDLE_EXTENSION = '.syncshow-service';
// JSZip and the project store currently materialize the archive plus verified
// asset buffers in the Electron main process. Keep this conservative until the
// exchange path is streaming so a valid file cannot multiply into >1 GiB RAM.
const MAX_BUNDLE_BYTES = 128 * 1024 * 1024;
const MAX_MANIFEST_BYTES = 2 * 1024 * 1024;
const MAX_BUNDLE_ASSETS = 2000;
const MAX_BUNDLE_ENTRIES = MAX_BUNDLE_ASSETS + 2;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const ASSET_ID_PATTERN = /^sha256:[a-f0-9]{64}$/;
const STORED_NAME_PATTERN = /^[a-f0-9]{64}\.(?:png|jpe?g|webp)$/;
const IMAGE_FORMAT_BY_MIME = Object.freeze({
  'image/png': 'png',
  'image/jpeg': 'jpeg',
  'image/webp': 'webp'
});
const ZIP_LOCAL_FILE = 0x04034b50;
const ZIP_CENTRAL_FILE = 0x02014b50;
const ZIP_END = 0x06054b50;
const ZIP_UTF8_FLAG = 0x0800;
const ZIP_STORE_METHOD = 0;

class ProjectExchangeError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'ProjectExchangeError';
    this.code = code;
    this.details = details;
  }
}

function fail(code, message, details = {}) {
  throw new ProjectExchangeError(code, message, details);
}

function hashBuffer(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function exactKeys(value, expected, label) {
  if (!isRecord(value)) fail('INVALID_BUNDLE_MANIFEST', `${label} must be an object.`);
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    fail('INVALID_BUNDLE_MANIFEST', `${label} has unsupported or missing fields.`);
  }
}

function boundedString(value, label, maximum, pattern = null) {
  if (typeof value !== 'string' || value.length < 1 || value.length > maximum || (pattern && !pattern.test(value))) {
    fail('INVALID_BUNDLE_MANIFEST', `${label} is invalid.`);
  }
  return value;
}

function boundedInteger(value, label, minimum, maximum) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    fail('INVALID_BUNDLE_MANIFEST', `${label} is outside the supported range.`);
  }
  return value;
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!isRecord(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, stableValue(value[key])]));
}

function canonicalJson(value) {
  return `${JSON.stringify(stableValue(value))}\n`;
}

function manifestBase(manifest) {
  return {
    kind: manifest.kind,
    schemaVersion: manifest.schemaVersion,
    createdBy: manifest.createdBy,
    project: manifest.project,
    assets: manifest.assets
  };
}

function manifestWithId(base) {
  return {
    kind: base.kind,
    schemaVersion: base.schemaVersion,
    bundleId: hashBuffer(Buffer.from(canonicalJson(base), 'utf8')),
    createdBy: base.createdBy,
    project: base.project,
    assets: base.assets
  };
}

function serializeManifest(manifest) {
  return `${JSON.stringify({
    kind: manifest.kind,
    schemaVersion: manifest.schemaVersion,
    bundleId: manifest.bundleId,
    createdBy: {
      application: manifest.createdBy.application,
      version: manifest.createdBy.version
    },
    project: {
      path: manifest.project.path,
      id: manifest.project.id,
      schemaVersion: manifest.project.schemaVersion,
      revisionId: manifest.project.revisionId,
      sha256: manifest.project.sha256,
      size: manifest.project.size
    },
    assets: manifest.assets.map(asset => ({
      id: asset.id,
      path: asset.path,
      kind: asset.kind,
      storedName: asset.storedName,
      mediaType: asset.mediaType,
      sha256: asset.sha256,
      size: asset.size
    }))
  }, null, 2)}\n`;
}

function decodeUtf8(buffer, label) {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  } catch (_error) {
    fail('INVALID_BUNDLE_TEXT', `${label} must be valid UTF-8.`);
  }
}

function normalizeManifest(raw) {
  exactKeys(raw, ['kind', 'schemaVersion', 'bundleId', 'createdBy', 'project', 'assets'], 'Bundle manifest');
  if (raw.kind !== BUNDLE_KIND || raw.schemaVersion !== BUNDLE_SCHEMA_VERSION) {
    fail('UNSUPPORTED_BUNDLE', `This bundle is not a supported ${BUNDLE_KIND} schema v${BUNDLE_SCHEMA_VERSION} file.`);
  }
  const bundleId = boundedString(raw.bundleId, 'Bundle id', 64, SHA256_PATTERN);

  exactKeys(raw.createdBy, ['application', 'version'], 'Bundle creator');
  const createdBy = {
    application: boundedString(raw.createdBy.application, 'Bundle creator application', 80),
    version: boundedString(raw.createdBy.version, 'Bundle creator version', 120)
  };

  exactKeys(raw.project, ['path', 'id', 'schemaVersion', 'revisionId', 'sha256', 'size'], 'Bundle project');
  if (raw.project.path !== 'project.json') fail('INVALID_BUNDLE_MANIFEST', 'The project entry must be project.json.');
  const project = {
    path: 'project.json',
    id: boundedString(raw.project.id, 'Bundle project id', 128),
    schemaVersion: boundedInteger(raw.project.schemaVersion, 'Bundle project schema version', 1, 1000000),
    revisionId: boundedString(raw.project.revisionId, 'Bundle project revision', 64, SHA256_PATTERN),
    sha256: boundedString(raw.project.sha256, 'Bundle project checksum', 64, SHA256_PATTERN),
    size: boundedInteger(raw.project.size, 'Bundle project size', 1, MAX_PROJECT_JSON_BYTES)
  };
  if (project.revisionId !== project.sha256) {
    fail('INVALID_BUNDLE_MANIFEST', 'The project revision and checksum must match.');
  }

  if (!Array.isArray(raw.assets) || raw.assets.length > MAX_BUNDLE_ASSETS) {
    fail('INVALID_BUNDLE_MANIFEST', `A portable service can contain at most ${MAX_BUNDLE_ASSETS} assets.`);
  }
  const ids = new Set();
  const paths = new Set();
  const assets = raw.assets.map((rawAsset, index) => {
    exactKeys(rawAsset, ['id', 'path', 'kind', 'storedName', 'mediaType', 'sha256', 'size'], `Bundle asset ${index + 1}`);
    const id = boundedString(rawAsset.id, `Bundle asset ${index + 1} id`, 71, ASSET_ID_PATTERN);
    const storedName = boundedString(rawAsset.storedName, `Bundle asset ${index + 1} stored name`, 75, STORED_NAME_PATTERN);
    const assetPath = boundedString(rawAsset.path, `Bundle asset ${index + 1} path`, 90);
    const sha256 = boundedString(rawAsset.sha256, `Bundle asset ${index + 1} checksum`, 64, SHA256_PATTERN);
    const mediaType = boundedString(rawAsset.mediaType, `Bundle asset ${index + 1} media type`, 100);
    if (rawAsset.kind !== 'image'
      || id !== `sha256:${sha256}`
      || storedName.split('.')[0] !== sha256
      || assetPath !== `assets/${storedName}`
      || !IMAGE_FORMAT_BY_MIME[mediaType]) {
      fail('INVALID_BUNDLE_MANIFEST', `Bundle asset ${index + 1} has inconsistent content metadata.`);
    }
    if (ids.has(id) || paths.has(assetPath)) {
      fail('INVALID_BUNDLE_MANIFEST', 'The bundle manifest contains a duplicate asset.');
    }
    ids.add(id);
    paths.add(assetPath);
    return {
      id,
      path: assetPath,
      kind: 'image',
      storedName,
      mediaType,
      sha256,
      size: boundedInteger(rawAsset.size, `Bundle asset ${index + 1} size`, 1, MAX_IMAGE_BYTES)
    };
  });
  assets.sort((a, b) => a.id.localeCompare(b.id));

  const normalized = {
    kind: BUNDLE_KIND,
    schemaVersion: BUNDLE_SCHEMA_VERSION,
    bundleId,
    createdBy,
    project,
    assets
  };
  const expectedBundleId = hashBuffer(Buffer.from(canonicalJson(manifestBase(normalized)), 'utf8'));
  if (bundleId !== expectedBundleId) fail('BUNDLE_MANIFEST_HASH_MISMATCH', 'The bundle manifest failed its checksum.');
  return normalized;
}

function safeEntryName(name) {
  if (typeof name !== 'string'
    || name.length < 1
    || name.length > 160
    || name.includes('\\')
    || name.includes('\0')
    || name.startsWith('/')
    || !/^[\x20-\x7e]+$/.test(name)) {
    return false;
  }
  const parts = name.split('/');
  return parts.every(part => part && part !== '.' && part !== '..');
}

function assertReadable(buffer, offset, length, label) {
  if (!Number.isSafeInteger(offset)
    || !Number.isSafeInteger(length)
    || offset < 0
    || length < 0
    || offset + length > buffer.length) {
    fail('INVALID_BUNDLE_ZIP', `${label} is truncated.`);
  }
}

function inspectZipStructure(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 22 || buffer.length > MAX_BUNDLE_BYTES) {
    fail('INVALID_BUNDLE_SIZE', `Portable services must be between 22 bytes and ${MAX_BUNDLE_BYTES} bytes.`);
  }
  let endOffset = -1;
  const minimumOffset = Math.max(0, buffer.length - 22 - 0xffff);
  for (let offset = buffer.length - 22; offset >= minimumOffset; offset -= 1) {
    if (buffer.readUInt32LE(offset) === ZIP_END) {
      const commentLength = buffer.readUInt16LE(offset + 20);
      if (offset + 22 + commentLength === buffer.length) {
        endOffset = offset;
        break;
      }
    }
  }
  if (endOffset < 0) fail('INVALID_BUNDLE_ZIP', 'The bundle ZIP directory is missing.');

  assertReadable(buffer, endOffset, 22, 'ZIP end record');
  const diskNumber = buffer.readUInt16LE(endOffset + 4);
  const centralDisk = buffer.readUInt16LE(endOffset + 6);
  const entriesOnDisk = buffer.readUInt16LE(endOffset + 8);
  const entryCount = buffer.readUInt16LE(endOffset + 10);
  const centralSize = buffer.readUInt32LE(endOffset + 12);
  const centralOffset = buffer.readUInt32LE(endOffset + 16);
  const commentLength = buffer.readUInt16LE(endOffset + 20);
  if (diskNumber !== 0
    || centralDisk !== 0
    || entriesOnDisk !== entryCount
    || entryCount < 2
    || entryCount > MAX_BUNDLE_ENTRIES
    || entryCount === 0xffff
    || centralSize === 0xffffffff
    || centralOffset === 0xffffffff
    || commentLength !== 0
    || centralOffset + centralSize !== endOffset) {
    fail('INVALID_BUNDLE_ZIP', 'The bundle must be a single-disk, non-Zip64 ZIP with no archive comment.');
  }

  const entries = new Map();
  let cursor = centralOffset;
  let totalUncompressed = 0;
  for (let index = 0; index < entryCount; index += 1) {
    assertReadable(buffer, cursor, 46, `ZIP directory entry ${index + 1}`);
    if (buffer.readUInt32LE(cursor) !== ZIP_CENTRAL_FILE) {
      fail('INVALID_BUNDLE_ZIP', `ZIP directory entry ${index + 1} is invalid.`);
    }
    const versionMadeBy = buffer.readUInt16LE(cursor + 4);
    const flags = buffer.readUInt16LE(cursor + 8);
    const method = buffer.readUInt16LE(cursor + 10);
    const crc32 = buffer.readUInt32LE(cursor + 16);
    const compressedSize = buffer.readUInt32LE(cursor + 20);
    const uncompressedSize = buffer.readUInt32LE(cursor + 24);
    const nameLength = buffer.readUInt16LE(cursor + 28);
    const extraLength = buffer.readUInt16LE(cursor + 30);
    const entryCommentLength = buffer.readUInt16LE(cursor + 32);
    const diskStart = buffer.readUInt16LE(cursor + 34);
    const externalAttributes = buffer.readUInt32LE(cursor + 38);
    const localOffset = buffer.readUInt32LE(cursor + 42);
    const recordLength = 46 + nameLength + extraLength + entryCommentLength;
    assertReadable(buffer, cursor, recordLength, `ZIP directory entry ${index + 1}`);
    const nameBuffer = buffer.subarray(cursor + 46, cursor + 46 + nameLength);
    const name = nameBuffer.toString('utf8');
    const hostSystem = versionMadeBy >>> 8;
    const unixFileType = hostSystem === 3 ? ((externalAttributes >>> 16) & 0o170000) : 0;
    const dosDirectory = (externalAttributes & 0x10) !== 0;
    if (!safeEntryName(name)
      || !Buffer.from(name, 'utf8').equals(nameBuffer)
      || entries.has(name)
      || diskStart !== 0
      || dosDirectory
      || (unixFileType !== 0 && unixFileType !== 0o100000)
      || method !== ZIP_STORE_METHOD
      || (flags & ~ZIP_UTF8_FLAG) !== 0
      || compressedSize !== uncompressedSize
      || compressedSize === 0xffffffff
      || localOffset === 0xffffffff) {
      fail('INVALID_BUNDLE_ZIP', `ZIP entry ${index + 1} is unsafe or unsupported.`);
    }
    totalUncompressed += uncompressedSize;
    if (!Number.isSafeInteger(totalUncompressed) || totalUncompressed > MAX_BUNDLE_BYTES) {
      fail('INVALID_BUNDLE_SIZE', 'The bundle expands beyond the supported size.');
    }

    assertReadable(buffer, localOffset, 30, `ZIP local entry ${name}`);
    if (buffer.readUInt32LE(localOffset) !== ZIP_LOCAL_FILE) {
      fail('INVALID_BUNDLE_ZIP', `ZIP local entry ${name} is invalid.`);
    }
    const localFlags = buffer.readUInt16LE(localOffset + 6);
    const localMethod = buffer.readUInt16LE(localOffset + 8);
    const localCrc32 = buffer.readUInt32LE(localOffset + 14);
    const localCompressedSize = buffer.readUInt32LE(localOffset + 18);
    const localUncompressedSize = buffer.readUInt32LE(localOffset + 22);
    const localNameLength = buffer.readUInt16LE(localOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localOffset + 28);
    const localRecordLength = 30 + localNameLength + localExtraLength;
    assertReadable(buffer, localOffset, localRecordLength, `ZIP local entry ${name}`);
    const localName = buffer.subarray(localOffset + 30, localOffset + 30 + localNameLength);
    const dataOffset = localOffset + localRecordLength;
    const dataEnd = dataOffset + compressedSize;
    assertReadable(buffer, dataOffset, compressedSize, `ZIP data ${name}`);
    if (localFlags !== flags
      || localMethod !== method
      || localCrc32 !== crc32
      || localCompressedSize !== compressedSize
      || localUncompressedSize !== uncompressedSize
      || !localName.equals(nameBuffer)
      || dataEnd > centralOffset) {
      fail('INVALID_BUNDLE_ZIP', `ZIP local metadata for ${name} does not match its directory entry.`);
    }
    entries.set(name, {
      name,
      compressedSize,
      uncompressedSize,
      localOffset,
      dataOffset,
      dataEnd
    });
    cursor += recordLength;
  }
  if (cursor !== endOffset) fail('INVALID_BUNDLE_ZIP', 'The ZIP directory has trailing or hidden records.');

  const byOffset = [...entries.values()].sort((a, b) => a.localOffset - b.localOffset);
  let expectedOffset = 0;
  for (const entry of byOffset) {
    if (entry.localOffset !== expectedOffset) {
      fail('INVALID_BUNDLE_ZIP', 'The ZIP contains hidden or overlapping local data.');
    }
    expectedOffset = entry.dataEnd;
  }
  if (expectedOffset !== centralOffset) {
    fail('INVALID_BUNDLE_ZIP', 'The ZIP contains data outside its declared entries.');
  }
  return entries;
}

function assertCanonicalManifest(buffer, manifest) {
  const canonical = Buffer.from(serializeManifest(manifest), 'utf8');
  if (!buffer.equals(canonical)) {
    fail('NONCANONICAL_BUNDLE_MANIFEST', 'The bundle manifest is not canonical.');
  }
}

function assertCanonicalProject(buffer, project) {
  const canonical = Buffer.from(serializeServiceProject(project), 'utf8');
  if (!buffer.equals(canonical)) {
    fail('NONCANONICAL_BUNDLE_PROJECT', 'The bundled project is not canonical.');
  }
}

function assertPortablePresetPack(project) {
  if (project.presetPack?.sha256) {
    fail(
      'UNSUPPORTED_PORTABLE_PRESET_PACK',
      'This service uses a custom preset pack that is not portable yet.'
    );
  }
}

function manifestAssetFromProject(asset) {
  if (asset.kind !== 'image') {
    fail('UNSUPPORTED_PORTABLE_ASSET', `Portable ${asset.kind} assets are not supported yet.`, { assetId: asset.id });
  }
  return {
    id: asset.id,
    path: `assets/${asset.storedName}`,
    kind: 'image',
    storedName: asset.storedName,
    mediaType: asset.mediaType,
    sha256: asset.sha256,
    size: asset.size
  };
}

function assertAssetMatchesManifest(asset, manifestAsset) {
  if (!asset
    || asset.id !== manifestAsset.id
    || asset.kind !== manifestAsset.kind
    || asset.storedName !== manifestAsset.storedName
    || asset.mediaType !== manifestAsset.mediaType
    || asset.sha256 !== manifestAsset.sha256
    || asset.size !== manifestAsset.size) {
    fail('BUNDLE_ASSET_MANIFEST_MISMATCH', `Asset ${manifestAsset.id} does not match project.json.`);
  }
}

function assertImageContent(buffer, manifestAsset) {
  if (buffer.length !== manifestAsset.size) {
    fail('BUNDLE_ASSET_SIZE_MISMATCH', `Asset ${manifestAsset.id} has the wrong size.`);
  }
  const digest = hashBuffer(buffer);
  if (digest !== manifestAsset.sha256 || manifestAsset.id !== `sha256:${digest}`) {
    fail('BUNDLE_ASSET_HASH_MISMATCH', `Asset ${manifestAsset.id} failed its checksum.`);
  }
  const expectedFormat = IMAGE_FORMAT_BY_MIME[manifestAsset.mediaType];
  if (!expectedFormat || imageFormatFromMagic(buffer) !== expectedFormat) {
    fail('BUNDLE_ASSET_TYPE_MISMATCH', `Asset ${manifestAsset.id} does not match its declared image type.`);
  }
}

function suggestedFileName(project) {
  const slug = project.title
    .normalize('NFKD')
    .replace(/[^\x00-\x7f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'service';
  return `${project.serviceDate}-${slug}${BUNDLE_EXTENSION}`;
}

class ServiceProjectExchange {
  constructor(options = {}) {
    if (!options.projectStore
      || typeof options.projectStore.read !== 'function'
      || typeof options.projectStore.resolveAssetPath !== 'function'
      || typeof options.projectStore.importPortableProject !== 'function') {
      throw new TypeError('ServiceProjectExchange requires a ServiceProjectStore');
    }
    this.projectStore = options.projectStore;
    if (options.songLibrary !== undefined
      && options.songLibrary !== null
      && (typeof options.songLibrary.read !== 'function'
        || typeof options.songLibrary.validateSource !== 'function'
        || typeof options.songLibrary.saveSource !== 'function')) {
      throw new TypeError('ServiceProjectExchange songLibrary must be a LocalSongLibrary');
    }
    this.songLibrary = options.songLibrary || null;
    if (options.sermonLibrary !== undefined
      && options.sermonLibrary !== null
      && (typeof options.sermonLibrary.read !== 'function'
        || typeof options.sermonLibrary.validateSource !== 'function'
        || typeof options.sermonLibrary.saveSource !== 'function')) {
      throw new TypeError('ServiceProjectExchange sermonLibrary must be a LocalSermonLibrary');
    }
    this.sermonLibrary = options.sermonLibrary || null;
    this.appVersion = String(options.appVersion || 'unknown').slice(0, 120) || 'unknown';
  }

  async exportBundle(projectId, revisionId) {
    const selected = await this.projectStore.read(projectId, { revisionId });
    const project = selected.project;
    if (isPowerPointCompanionProject(project)) {
      fail(
        'COMPANION_PROJECT_NOT_EXPORTABLE',
        'A PowerPoint sermon handoff references one exact local service set and is not a portable native service.'
      );
    }
    assertPortablePresetPack(project);
    const projectBuffer = Buffer.from(serializeServiceProject(project), 'utf8');
    const projectSha256 = hashBuffer(projectBuffer);
    if (projectSha256 !== selected.revisionId) {
      fail('PROJECT_REVISION_HASH_MISMATCH', 'The selected project revision could not be reproduced exactly.');
    }

    const assets = [];
    const assetBuffers = new Map();
    for (const assetId of Object.keys(project.assets).sort()) {
      const projectAsset = project.assets[assetId];
      const manifestAsset = manifestAssetFromProject(projectAsset);
      const resolved = await this.projectStore.resolveAssetPath(project.id, selected.revisionId, assetId);
      const read = await readFileNoFollow(resolved.assetPath, MAX_IMAGE_BYTES);
      assertImageContent(read.buffer, manifestAsset);
      assets.push(manifestAsset);
      assetBuffers.set(assetId, read.buffer);
    }

    const base = {
      kind: BUNDLE_KIND,
      schemaVersion: BUNDLE_SCHEMA_VERSION,
      createdBy: {
        application: 'SyncShow',
        version: this.appVersion
      },
      project: {
        path: 'project.json',
        id: project.id,
        schemaVersion: project.schemaVersion,
        revisionId: selected.revisionId,
        sha256: projectSha256,
        size: projectBuffer.length
      },
      assets
    };
    const manifest = manifestWithId(base);
    const manifestBuffer = Buffer.from(serializeManifest(manifest), 'utf8');
    if (manifestBuffer.length > MAX_MANIFEST_BYTES) fail('BUNDLE_MANIFEST_TOO_LARGE', 'The bundle manifest is too large.');

    const zip = new JSZip();
    const fileOptions = {
      binary: true,
      compression: 'STORE',
      createFolders: false,
      date: new Date(Date.UTC(1980, 0, 1)),
      unixPermissions: 0o600
    };
    zip.file('manifest.json', manifestBuffer, fileOptions);
    zip.file('project.json', projectBuffer, fileOptions);
    for (const asset of assets) zip.file(asset.path, assetBuffers.get(asset.id), fileOptions);
    const buffer = await zip.generateAsync({
      type: 'nodebuffer',
      compression: 'STORE',
      platform: 'UNIX',
      streamFiles: false
    });
    if (buffer.length > MAX_BUNDLE_BYTES) fail('BUNDLE_TOO_LARGE', 'The portable service is too large to export.');
    inspectZipStructure(buffer);
    return {
      buffer,
      manifest,
      fileName: suggestedFileName(project),
      projectId: project.id,
      revisionId: selected.revisionId,
      assetCount: assets.length
    };
  }

  async importBundle(input) {
    const buffer = Buffer.isBuffer(input) ? input : Buffer.from(input || []);
    const zipEntries = inspectZipStructure(buffer);
    const manifestEntry = zipEntries.get('manifest.json');
    if (!manifestEntry || manifestEntry.uncompressedSize < 1 || manifestEntry.uncompressedSize > MAX_MANIFEST_BYTES) {
      fail('INVALID_BUNDLE_MANIFEST', 'The bundle needs one bounded manifest.json entry.');
    }

    let zip;
    try {
      zip = await JSZip.loadAsync(buffer, { createFolders: false, checkCRC32: false });
    } catch (error) {
      fail('INVALID_BUNDLE_ZIP', `The portable service ZIP could not be read: ${error.message}`);
    }
    const loadedNames = Object.keys(zip.files).sort();
    const parsedNames = [...zipEntries.keys()].sort();
    if (loadedNames.length !== parsedNames.length
      || loadedNames.some((name, index) => name !== parsedNames[index])) {
      fail('INVALID_BUNDLE_ZIP', 'The ZIP entry table is inconsistent.');
    }
    for (const name of loadedNames) {
      const entry = zip.files[name];
      if (entry.dir || (entry.unsafeOriginalName && entry.unsafeOriginalName !== name)) {
        fail('INVALID_BUNDLE_ZIP', `ZIP entry ${name} is unsafe.`);
      }
    }

    const manifestBuffer = await zip.file('manifest.json').async('nodebuffer');
    let manifestRaw;
    try {
      manifestRaw = JSON.parse(decodeUtf8(manifestBuffer, 'manifest.json'));
    } catch (error) {
      if (error instanceof ProjectExchangeError) throw error;
      fail('INVALID_BUNDLE_MANIFEST', `manifest.json is invalid JSON: ${error.message}`);
    }
    const manifest = normalizeManifest(manifestRaw);
    assertCanonicalManifest(manifestBuffer, manifest);

    const expectedPaths = new Set([
      'manifest.json',
      manifest.project.path,
      ...manifest.assets.map(asset => asset.path)
    ]);
    if (expectedPaths.size !== zipEntries.size
      || [...zipEntries.keys()].some(name => !expectedPaths.has(name))) {
      fail('UNEXPECTED_BUNDLE_ENTRY', 'The bundle contains a missing, duplicate, or undeclared entry.');
    }
    const projectEntry = zipEntries.get(manifest.project.path);
    if (!projectEntry || projectEntry.uncompressedSize !== manifest.project.size) {
      fail('BUNDLE_PROJECT_SIZE_MISMATCH', 'project.json does not match the bundle manifest.');
    }
    for (const asset of manifest.assets) {
      const entry = zipEntries.get(asset.path);
      if (!entry || entry.uncompressedSize !== asset.size) {
        fail('BUNDLE_ASSET_SIZE_MISMATCH', `Asset ${asset.id} does not match the bundle manifest.`);
      }
    }

    const projectBuffer = await zip.file(manifest.project.path).async('nodebuffer');
    if (hashBuffer(projectBuffer) !== manifest.project.sha256) {
      fail('BUNDLE_PROJECT_HASH_MISMATCH', 'project.json failed its checksum.');
    }
    let project;
    try {
      project = normalizeServiceProject(JSON.parse(decodeUtf8(projectBuffer, 'project.json')));
    } catch (error) {
      if (error instanceof ProjectExchangeError) throw error;
      fail('INVALID_BUNDLE_PROJECT', `project.json is invalid: ${error.message}`);
    }
    assertCanonicalProject(projectBuffer, project);
    if (isPowerPointCompanionProject(project)) {
      fail(
        'COMPANION_PROJECT_NOT_IMPORTABLE',
        'A PowerPoint sermon handoff is bound to one exact local service set and cannot be imported as a portable service.'
      );
    }
    assertPortablePresetPack(project);
    if (project.id !== manifest.project.id || project.schemaVersion !== manifest.project.schemaVersion) {
      fail('BUNDLE_PROJECT_MANIFEST_MISMATCH', 'project.json identity does not match the bundle manifest.');
    }

    const projectAssetIds = Object.keys(project.assets).sort();
    const manifestAssetIds = manifest.assets.map(asset => asset.id).sort();
    if (projectAssetIds.length !== manifestAssetIds.length
      || projectAssetIds.some((assetId, index) => assetId !== manifestAssetIds[index])) {
      fail('BUNDLE_ASSET_MANIFEST_MISMATCH', 'The manifest assets do not exactly match project.json.');
    }
    const assetBuffers = new Map();
    for (const manifestAsset of manifest.assets) {
      assertAssetMatchesManifest(project.assets[manifestAsset.id], manifestAsset);
      const assetBuffer = await zip.file(manifestAsset.path).async('nodebuffer');
      assertImageContent(assetBuffer, manifestAsset);
      assetBuffers.set(manifestAsset.id, assetBuffer);
    }

    const imported = await this.projectStore.importPortableProject(project, assetBuffers, {
      sourceRevisionId: manifest.project.revisionId,
      reason: 'portable-import'
    });
    let songLibrary;
    try {
      songLibrary = await importPortableProjectSongs(imported.project, this.songLibrary);
    } catch (_error) {
      // The explicit portable project import has already succeeded. Library
      // hydration is intentionally best-effort and must never roll back or
      // misreport that independently verified project.
      songLibrary = failedPortableSongImportSummary(imported.project);
    }
    let sermonLibrary;
    try {
      sermonLibrary = await importPortableProjectSermons(
        imported.project,
        this.sermonLibrary
      );
    } catch (_error) {
      // Sermon hydration has the same best-effort boundary as song hydration:
      // the verified project and its exact embedded sermon revisions remain
      // usable even when the editable local library cannot be updated.
      sermonLibrary = failedPortableSermonImportSummary(imported.project);
    }
    return {
      ...imported,
      songLibrary,
      sermonLibrary,
      bundle: {
        id: manifest.bundleId,
        sourceProjectId: manifest.project.id,
        sourceRevisionId: manifest.project.revisionId,
        assetCount: manifest.assets.length
      }
    };
  }
}

module.exports = {
  BUNDLE_EXTENSION,
  BUNDLE_KIND,
  BUNDLE_SCHEMA_VERSION,
  MAX_BUNDLE_BYTES,
  ProjectExchangeError,
  ServiceProjectExchange,
  inspectZipStructure,
  normalizeManifest,
  serializeManifest
};
