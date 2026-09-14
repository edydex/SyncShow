'use strict';

const crypto = require('crypto');
const nativeFs = require('fs');
const fs = require('fs/promises');
const path = require('path');
const { TextDecoder } = require('util');

const {
  MAX_IMAGE_PIXELS,
  MAX_PROJECT_JSON_BYTES,
  attachLocalServicePlanning,
  createServiceProject,
  deriveSermonServiceRelationship,
  normalizeServiceProject,
  planNextServiceProject,
  serializeServiceProject
} = require('./ServiceProject');
const {
  NOFOLLOW_READ_FLAGS,
  atomicWriteFile,
  ensureConfinedDirectory,
  ensurePrivateDirectory,
  fsyncDirectory,
  hashFileNoFollow,
  readFileNoFollow,
  statIdentityMatches,
  withExclusiveFileLock
} = require('./StorageSafety');

const POINTER_SCHEMA_VERSION = 1;
const REVISION_PATTERN = /^[a-f0-9]{64}$/;
const PROJECT_DIRECTORY_PATTERN = /^project-[a-f0-9]{64}$/;
const MAX_POINTER_BYTES = 64 * 1024;
const MAX_REVISIONS_PER_PROJECT = 1000;
const MAX_PROJECTS = 5000;
const MAX_SERMON_REFERENCE_SCAN_FILES = 200_000;
const MAX_SERMON_REFERENCE_SCAN_BYTES = 1024 * 1024 * 1024 * 1024;
const MAX_SERMON_RELATIONSHIP_PAGE_SIZE = 100;
const MAX_IMAGE_BYTES = 75 * 1024 * 1024;
const MAX_VIDEO_BYTES = 1024 * 1024 * 1024;
const ASSET_COPY_BUFFER_BYTES = 1024 * 1024;
const SERMON_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const IMAGE_MIME_BY_FORMAT = Object.freeze({ png: 'image/png', jpeg: 'image/jpeg', webp: 'image/webp' });
const IMAGE_EXTENSION_BY_FORMAT = Object.freeze({ png: 'png', jpeg: 'jpg', webp: 'webp' });
const IMAGE_FORMAT_BY_MIME = Object.freeze({ 'image/png': 'png', 'image/jpeg': 'jpeg', 'image/webp': 'webp' });
const VIDEO_MIME_BY_FORMAT = Object.freeze({ mp4: 'video/mp4', webm: 'video/webm' });
const VIDEO_EXTENSION_BY_FORMAT = Object.freeze({ mp4: 'mp4', webm: 'webm' });
const VIDEO_FORMAT_BY_MIME = Object.freeze({ 'video/mp4': 'mp4', 'video/webm': 'webm' });

class ProjectStoreError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'ProjectStoreError';
    this.code = code;
    this.details = details;
  }
}

function fail(code, message, details = {}) {
  throw new ProjectStoreError(code, message, details);
}

function projectStorageKey(projectId) {
  return `project-${crypto.createHash('sha256').update(String(projectId)).digest('hex')}`;
}

function contentHash(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function isDirectChildPath(parentPath, childPath) {
  return path.dirname(childPath) === parentPath
    && path.basename(childPath) !== '.'
    && path.basename(childPath) !== '..';
}

function isCanonicalTimestamp(value) {
  return typeof value === 'string'
    && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
    && Number.isFinite(Date.parse(value))
    && new Date(value).toISOString() === value;
}

function referenceScanCapacity(value, fallback, maximum, label) {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new TypeError(`${label} must be an integer between 1 and ${maximum}`);
  }
  return value;
}

function semanticProjectHash(project) {
  const raw = JSON.parse(serializeServiceProject(project));
  raw.revision = 0;
  raw.updatedAt = raw.createdAt;
  return contentHash(`${JSON.stringify(raw)}\n`);
}

function imageFormatFromMagic(buffer) {
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return 'png';
  }
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'jpeg';
  if (buffer.length >= 12
    && buffer.subarray(0, 4).toString('ascii') === 'RIFF'
    && buffer.subarray(8, 12).toString('ascii') === 'WEBP') return 'webp';
  return null;
}

function videoFormatFromMagic(buffer) {
  if (buffer.length >= 12 && buffer.subarray(4, 8).toString('ascii') === 'ftyp') return 'mp4';
  if (buffer.length >= 4
    && buffer[0] === 0x1a
    && buffer[1] === 0x45
    && buffer[2] === 0xdf
    && buffer[3] === 0xa3) return 'webm';
  return null;
}

async function withExclusiveFileLocks(lockPaths, operation) {
  const orderedLockPaths = [...new Set(lockPaths.map(lockPath => path.resolve(lockPath)))]
    .sort();
  const acquire = index => {
    if (index >= orderedLockPaths.length) return operation();
    return withExclusiveFileLock(
      orderedLockPaths[index],
      () => acquire(index + 1)
    );
  };
  return acquire(0);
}

class ServiceProjectStore {
  constructor(options = {}) {
    if (typeof options.rootPath !== 'string' || !path.isAbsolute(options.rootPath)) {
      throw new TypeError('ServiceProjectStore requires an absolute rootPath');
    }
    this.rootPath = path.resolve(options.rootPath);
    this.clock = options.clock || (() => new Date());
    this.randomUUID = options.randomUUID || crypto.randomUUID;
    this.imageInspector = options.imageInspector || null;
  }

  async initialize() {
    this.rootPath = await ensurePrivateDirectory(this.rootPath);
    return this;
  }

  _projectDirectory(projectId) {
    return path.join(this.rootPath, projectStorageKey(projectId));
  }

  async _ensureProjectDirectories(projectId) {
    const projectDirectory = this._projectDirectory(projectId);
    await ensureConfinedDirectory(this.rootPath, path.join(projectDirectory, 'revisions'));
    await ensureConfinedDirectory(this.rootPath, path.join(projectDirectory, 'assets'));
    return projectDirectory;
  }

  async _readPointerFile(projectId, fileName) {
    const pointerPath = path.join(this._projectDirectory(projectId), fileName);
    const { buffer } = await readFileNoFollow(pointerPath, MAX_POINTER_BYTES);
    const pointer = JSON.parse(buffer.toString('utf8'));
    if (!pointer
      || pointer.schemaVersion !== POINTER_SCHEMA_VERSION
      || pointer.projectId !== projectId
      || !REVISION_PATTERN.test(pointer.revisionId || '')
      || !Number.isSafeInteger(pointer.projectRevision)
      || pointer.projectRevision < 1) {
      throw new Error('Invalid project pointer');
    }
    return pointer;
  }

  async _readRevision(projectId, revisionId) {
    if (!REVISION_PATTERN.test(revisionId || '')) fail('INVALID_REVISION', 'Project revision id is invalid.');
    const revisionPath = path.join(this._projectDirectory(projectId), 'revisions', `${revisionId}.json`);
    let buffer;
    try {
      ({ buffer } = await readFileNoFollow(revisionPath, MAX_PROJECT_JSON_BYTES));
    } catch (error) {
      fail('PROJECT_REVISION_MISSING', 'The selected project revision is unavailable.', {
        projectId,
        revisionId,
        cause: error.message
      });
    }
    if (contentHash(buffer) !== revisionId) {
      fail('PROJECT_REVISION_CORRUPT', 'The project revision no longer matches its checksum.', { projectId, revisionId });
    }
    let project;
    try {
      project = normalizeServiceProject(JSON.parse(buffer.toString('utf8')));
    } catch (error) {
      fail('PROJECT_REVISION_INVALID', `The project revision is invalid: ${error.message}`, { projectId, revisionId });
    }
    if (project.id !== projectId) fail('PROJECT_ID_MISMATCH', 'The project revision belongs to another project.');
    return project;
  }

  async _recoverPointer(projectId) {
    const revisionsPath = path.join(this._projectDirectory(projectId), 'revisions');
    let entries;
    try {
      entries = await fs.readdir(revisionsPath, { withFileTypes: true });
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw error;
    }
    if (entries.length > MAX_REVISIONS_PER_PROJECT) fail('TOO_MANY_REVISIONS', 'This project has too many saved revisions to recover automatically.');
    const candidates = [];
    for (const entry of entries) {
      const match = /^([a-f0-9]{64})\.json$/.exec(entry.name);
      if (!entry.isFile() || !match) continue;
      try {
        const project = await this._readRevision(projectId, match[1]);
        candidates.push({ revisionId: match[1], project });
      } catch (_error) {
        // Preserve invalid revisions for diagnostics; recovery selects only a
        // complete checksum-valid document.
      }
    }
    candidates.sort((a, b) => b.project.revision - a.project.revision
      || b.project.updatedAt.localeCompare(a.project.updatedAt));
    const recovered = candidates[0];
    if (!recovered) return null;
    return {
      schemaVersion: POINTER_SCHEMA_VERSION,
      projectId,
      revisionId: recovered.revisionId,
      projectRevision: recovered.project.revision,
      updatedAt: recovered.project.updatedAt,
      recoveredFrom: 'revision-scan'
    };
  }

  async _readCurrentPointer(projectId) {
    try {
      return await this._readPointerFile(projectId, 'current.json');
    } catch (currentError) {
      if (currentError.code === 'ENOENT') {
        const recovered = await this._recoverPointer(projectId);
        if (recovered) return recovered;
        try {
          const backup = await this._readPointerFile(projectId, 'current.json.bak');
          return { ...backup, recoveredFrom: 'pointer-backup' };
        } catch (_backupError) {
          return null;
        }
      }
      // Revisions are written, fsynced, and checksum-verified before the
      // pointer is replaced. If the pointer itself is damaged, the newest
      // valid revision is therefore a more complete recovery source than the
      // deliberately older pointer backup.
      const recovered = await this._recoverPointer(projectId);
      if (recovered) return recovered;
      try {
        const backup = await this._readPointerFile(projectId, 'current.json.bak');
        return { ...backup, recoveredFrom: 'pointer-backup' };
      } catch (_backupError) {
        fail('PROJECT_POINTER_INVALID', 'The project’s current revision pointer is unreadable.', {
          projectId,
          cause: currentError.message
        });
      }
    }
  }

  async _writePointer(projectDirectory, pointer, previousPointer) {
    if (previousPointer) {
      await atomicWriteFile(
        path.join(projectDirectory, 'current.json.bak'),
        `${JSON.stringify(previousPointer, null, 2)}\n`,
        { maximumBytes: MAX_POINTER_BYTES, mode: 0o600, rootPath: this.rootPath }
      );
    }
    await atomicWriteFile(
      path.join(projectDirectory, 'current.json'),
      `${JSON.stringify(pointer, null, 2)}\n`,
      { maximumBytes: MAX_POINTER_BYTES, mode: 0o600, rootPath: this.rootPath }
    );
  }

  async create(input = {}, options = {}) {
    await this.initialize();
    const {
      startTime,
      teamNotes,
      ...projectInput
    } = input;
    let draft = createServiceProject({
      ...projectInput,
      id: projectInput.id || `project-${this.randomUUID()}`,
      now: this.clock()
    });
    if (options.prepareProject !== undefined) {
      if (typeof options.prepareProject !== 'function') {
        throw new TypeError('prepareProject must be a function');
      }
      draft = options.prepareProject(draft);
    }
    if (startTime !== undefined || teamNotes !== undefined) {
      draft = attachLocalServicePlanning(draft, {
        startTime,
        ...(teamNotes !== undefined ? { teamNotes } : {})
      });
    }
    return this.save(draft, { expectedRevisionId: null, reason: 'create' });
  }

  async read(projectId, options = {}) {
    await this.initialize();
    const revisionId = options.revisionId && options.revisionId !== 'current'
      ? options.revisionId
      : null;
    if (revisionId) {
      const project = await this._readRevision(projectId, revisionId);
      return { project, revisionId, recovery: null };
    }
    const pointer = await this._readCurrentPointer(projectId);
    if (!pointer) fail('PROJECT_NOT_FOUND', 'That service project does not exist.', { projectId });
    let selectedPointer = pointer;
    let project;
    try {
      project = await this._readRevision(projectId, pointer.revisionId);
    } catch (currentRevisionError) {
      const recovered = await this._recoverPointer(projectId);
      if (recovered && recovered.revisionId !== pointer.revisionId) {
        project = await this._readRevision(projectId, recovered.revisionId);
        selectedPointer = recovered;
      } else {
        try {
          const backup = await this._readPointerFile(projectId, 'current.json.bak');
          if (backup.revisionId === pointer.revisionId) throw currentRevisionError;
          project = await this._readRevision(projectId, backup.revisionId);
          selectedPointer = { ...backup, recoveredFrom: 'pointer-backup' };
        } catch (_backupError) {
          throw currentRevisionError;
        }
      }
    }
    const recovery = selectedPointer.recoveredFrom
      ? {
          source: selectedPointer.recoveredFrom,
          message: selectedPointer.recoveredFrom === 'revision-scan'
            ? 'SyncShow recovered the newest checksum-valid saved revision.'
            : 'SyncShow opened the last known-good pointer backup.'
        }
      : null;
    return {
      project,
      revisionId: selectedPointer.revisionId,
      recovery
    };
  }

  async _saveUnderLock(rawProject, options = {}) {
    let incoming = normalizeServiceProject(rawProject, { now: this.clock() });
    const preserveSharedSnapshot = options.preserveSharedSnapshot === true;
    if (preserveSharedSnapshot && incoming.revision < 1) {
      fail(
        'INVALID_SHARED_SNAPSHOT',
        'A shared service snapshot must already have a saved revision.'
      );
    }
    const projectDirectory = await this._ensureProjectDirectories(incoming.id);
    const currentPointer = await this._readCurrentPointer(incoming.id);
    const expected = options.expectedRevisionId === undefined ? null : options.expectedRevisionId;
    const actual = currentPointer?.revisionId || null;
    if (expected !== actual) {
      fail('PROJECT_CONFLICT', 'This service changed since it was opened. Reload it before saving again.', {
        projectId: incoming.id,
        expectedRevisionId: expected,
        currentRevisionId: actual
      });
    }
    let currentProject = null;
    if (currentPointer) currentProject = await this._readRevision(incoming.id, currentPointer.revisionId);
    const unchanged = currentProject && (preserveSharedSnapshot
      ? serializeServiceProject(currentProject) === serializeServiceProject(incoming)
      : semanticProjectHash(currentProject) === semanticProjectHash(incoming));
    if (unchanged) {
      return { project: currentProject, revisionId: currentPointer.revisionId, unchanged: true, recovery: null };
    }

    if (!preserveSharedSnapshot) {
      const raw = JSON.parse(serializeServiceProject(incoming));
      raw.createdAt = currentProject?.createdAt || incoming.createdAt;
      raw.updatedAt = this.clock().toISOString();
      raw.revision = (currentProject?.revision || 0) + 1;
      incoming = normalizeServiceProject(raw);
    }
    const serialized = serializeServiceProject(incoming);
    const revisionId = contentHash(serialized);
    const revisionPath = path.join(projectDirectory, 'revisions', `${revisionId}.json`);
    let createdRevision = false;
    try {
      const existingHash = await hashFileNoFollow(revisionPath, MAX_PROJECT_JSON_BYTES);
      if (existingHash !== revisionId) fail('PROJECT_REVISION_CORRUPT', 'An immutable project revision has changed.');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      await atomicWriteFile(revisionPath, serialized, {
        maximumBytes: MAX_PROJECT_JSON_BYTES,
        mode: 0o600,
        rootPath: this.rootPath
      });
      createdRevision = true;
    }
    if (await hashFileNoFollow(revisionPath, MAX_PROJECT_JSON_BYTES) !== revisionId) {
      fail('PROJECT_REVISION_CORRUPT', 'The new project revision failed its publication check.');
    }
    const pointer = {
      schemaVersion: POINTER_SCHEMA_VERSION,
      projectId: incoming.id,
      revisionId,
      projectRevision: incoming.revision,
      updatedAt: incoming.updatedAt,
      reason: String(options.reason || 'manual').slice(0, 40)
    };
    const rollbackCreatedRevision = async () => {
      if (!createdRevision) return false;
      try {
        await fs.unlink(revisionPath);
      } catch (error) {
        if (error.code !== 'ENOENT') return false;
      }
      try {
        await fsyncDirectory(path.dirname(revisionPath));
      } catch (error) {
        if (process.platform !== 'win32') return false;
      }
      return true;
    };
    if (options.beforePointerWrite !== undefined) {
      if (typeof options.beforePointerWrite !== 'function') {
        throw new TypeError('beforePointerWrite must be a function');
      }
      try {
        await options.beforePointerWrite({
          project: incoming,
          revisionId,
          pointer
        });
      } catch (error) {
        error.targetRevisionRolledBack = await rollbackCreatedRevision();
        error.targetPointerNotPublished = true;
        throw error;
      }
    }
    try {
      await this._writePointer(projectDirectory, pointer, currentPointer && {
        schemaVersion: POINTER_SCHEMA_VERSION,
        projectId: currentPointer.projectId,
        revisionId: currentPointer.revisionId,
        projectRevision: currentPointer.projectRevision,
        updatedAt: currentPointer.updatedAt,
        reason: currentPointer.reason || 'previous'
      });
    } catch (error) {
      let publishedPointer = null;
      try {
        publishedPointer = await this._readPointerFile(incoming.id, 'current.json');
      } catch (_readError) {
        publishedPointer = null;
      }
      if (publishedPointer?.revisionId !== revisionId) {
        if (options.rollbackCreatedRevisionOnPointerFailure === true) {
          error.targetRevisionRolledBack = await rollbackCreatedRevision();
          error.targetPointerNotPublished = true;
        }
        throw error;
      }
    }
    return { project: incoming, revisionId, unchanged: false, recovery: null };
  }

  async save(project, options = {}) {
    await this.initialize();
    const normalized = normalizeServiceProject(project, { now: this.clock() });
    const projectDirectory = await this._ensureProjectDirectories(normalized.id);
    return withExclusiveFileLock(path.join(projectDirectory, '.write-lock'), () =>
      this._saveUnderLock(normalized, options));
  }

  async installSharedSnapshot(project, options = {}) {
    await this.initialize();
    const normalized = normalizeServiceProject(project, { now: this.clock() });
    const assetBuffers = this._validatePortableAssetBuffers(
      normalized,
      options.assetBuffers || new Map()
    );
    const projectDirectory = await this._ensureProjectDirectories(normalized.id);
    return withExclusiveFileLock(path.join(projectDirectory, '.write-lock'), async () => {
      // A Community document is not usable offline until every declared image
      // has been installed and verified beside the local project revision.
      // Install content-addressed files before publishing the revision pointer.
      await this._installPortableAssets(normalized, assetBuffers);
      return this._saveUnderLock(normalized, {
        expectedRevisionId: options.expectedRevisionId,
        reason: options.reason || 'community-snapshot',
        preserveSharedSnapshot: true
      });
    });
  }

  async _readExactCurrentPlanSource(projectId, expectedRevisionId) {
    if (!REVISION_PATTERN.test(expectedRevisionId || '')) {
      fail('INVALID_REVISION', 'The source project revision id is invalid.');
    }
    const pointer = await this._readCurrentPointer(projectId);
    if (!pointer) {
      fail('PROJECT_NOT_FOUND', 'The source service project does not exist.', { projectId });
    }
    if (pointer.recoveredFrom) {
      fail(
        'SERVICE_PLAN_SOURCE_RECOVERY_REQUIRED',
        'Open and explicitly save the recovered source service before planning from it.',
        { projectId, source: pointer.recoveredFrom }
      );
    }
    if (pointer.revisionId !== expectedRevisionId) {
      fail(
        'PROJECT_CONFLICT',
        'The source service changed before the next service could be planned.',
        {
          projectId,
          expectedRevisionId,
          currentRevisionId: pointer.revisionId
        }
      );
    }
    const project = await this._readRevision(projectId, expectedRevisionId);
    const canonicalRevisionId = contentHash(serializeServiceProject(project));
    if (canonicalRevisionId !== expectedRevisionId) {
      fail(
        'PROJECT_REVISION_NONCANONICAL',
        'The source revision does not reproduce its canonical saved checksum.',
        { projectId, expectedRevisionId, canonicalRevisionId }
      );
    }
    return { project, revisionId: expectedRevisionId };
  }

  async _validatePlannedAssetFile(filePath, asset) {
    let before;
    try {
      before = await fs.lstat(filePath);
    } catch (error) {
      fail('ASSET_CORRUPT', `Asset ${asset.id} is unavailable.`, {
        assetId: asset.id,
        cause: error.message
      });
    }
    if (!before.isFile() || before.isSymbolicLink() || before.size !== asset.size) {
      fail('ASSET_CORRUPT', `Asset ${asset.id} is unavailable or changed.`, {
        assetId: asset.id
      });
    }
    let digest;
    try {
      digest = await hashFileNoFollow(filePath, asset.size);
    } catch (error) {
      fail('ASSET_CORRUPT', `Asset ${asset.id} could not be verified safely.`, {
        assetId: asset.id,
        cause: error.message
      });
    }
    if (digest !== asset.sha256 || asset.id !== `sha256:${digest}`) {
      fail('ASSET_CORRUPT', `Asset ${asset.id} failed its checksum.`, {
        assetId: asset.id
      });
    }
    if (asset.kind === 'video') {
      if (asset.size > MAX_VIDEO_BYTES) {
        fail('ASSET_CORRUPT', `Video asset ${asset.id} exceeds the safe video size limit.`);
      }
      const expectedFormat = VIDEO_FORMAT_BY_MIME[asset.mediaType];
      let handle;
      let magic;
      try {
        handle = await fs.open(filePath, NOFOLLOW_READ_FLAGS);
        const opened = await handle.stat();
        if (!opened.isFile() || !statIdentityMatches(before, opened)) {
          fail('ASSET_CORRUPT', `Video asset ${asset.id} changed while opening.`);
        }
        const header = Buffer.alloc(Math.min(32, opened.size));
        const { bytesRead } = await handle.read(header, 0, header.length, 0);
        magic = videoFormatFromMagic(header.subarray(0, bytesRead));
        const after = await handle.stat();
        if (!statIdentityMatches(opened, after)) {
          fail('ASSET_CORRUPT', `Video asset ${asset.id} changed while checking its type.`);
        }
      } finally {
        await handle?.close().catch(() => {});
      }
      if (!expectedFormat || magic !== expectedFormat) {
        fail('ASSET_CORRUPT', `Video asset ${asset.id} does not match its declared type.`);
      }
      return;
    }
    if (asset.kind !== 'image') return;
    if (asset.size > MAX_IMAGE_BYTES) {
      fail('ASSET_CORRUPT', `Image asset ${asset.id} exceeds the safe image size limit.`);
    }
    const expectedFormat = IMAGE_FORMAT_BY_MIME[asset.mediaType];
    let handle;
    let magic;
    try {
      handle = await fs.open(filePath, NOFOLLOW_READ_FLAGS);
      const opened = await handle.stat();
      if (!opened.isFile() || !statIdentityMatches(before, opened)) {
        fail('ASSET_CORRUPT', `Image asset ${asset.id} changed while opening.`);
      }
      const header = Buffer.alloc(Math.min(12, opened.size));
      const { bytesRead } = await handle.read(header, 0, header.length, 0);
      magic = imageFormatFromMagic(header.subarray(0, bytesRead));
      const after = await handle.stat();
      if (!statIdentityMatches(opened, after)) {
        fail('ASSET_CORRUPT', `Image asset ${asset.id} changed while checking its type.`);
      }
    } finally {
      await handle?.close().catch(() => {});
    }
    if (!expectedFormat || magic !== expectedFormat) {
      fail('ASSET_CORRUPT', `Image asset ${asset.id} does not match its declared type.`);
    }
    const metadata = await this._inspectImage(filePath, expectedFormat);
    const orientation = Number.isSafeInteger(metadata.orientation) ? metadata.orientation : 1;
    const afterInspection = await fs.lstat(filePath);
    if (!statIdentityMatches(before, afterInspection)
      || afterInspection.isSymbolicLink()
      || metadata.width !== asset.width
      || metadata.height !== asset.height
      || orientation !== asset.orientation) {
      fail('ASSET_CORRUPT', `Image asset ${asset.id} has inconsistent verified metadata.`);
    }
  }

  async _copyPlannedAsset(sourceProjectId, targetProjectId, asset) {
    const sourcePath = path.join(
      this._projectDirectory(sourceProjectId),
      'assets',
      asset.storedName
    );
    const targetAssetsPath = path.join(this._projectDirectory(targetProjectId), 'assets');
    const finalPath = path.join(targetAssetsPath, asset.storedName);
    try {
      await this._validatePlannedAssetFile(finalPath, asset);
      return { installed: false, assetPath: finalPath };
    } catch (error) {
      let targetExists = true;
      try {
        await fs.lstat(finalPath);
      } catch (statError) {
        if (statError.code === 'ENOENT') targetExists = false;
        else throw statError;
      }
      if (targetExists) throw error;
    }

    let before;
    let sourceRealPath;
    try {
      before = await fs.lstat(sourcePath);
      sourceRealPath = await fs.realpath(sourcePath);
    } catch (error) {
      fail('ASSET_CORRUPT', `Source asset ${asset.id} is unavailable.`, {
        assetId: asset.id,
        cause: error.message
      });
    }
    if (!before.isFile()
      || before.isSymbolicLink()
      || before.size !== asset.size
      || (asset.kind === 'image' && asset.size > MAX_IMAGE_BYTES)
      || (asset.kind === 'video' && asset.size > MAX_VIDEO_BYTES)) {
      fail('ASSET_CORRUPT', `Source asset ${asset.id} is unavailable or changed.`, {
        assetId: asset.id
      });
    }

    const temporaryPath = path.join(
      targetAssetsPath,
      `.plan-${process.pid}-${this.randomUUID()}.tmp`
    );
    let sourceHandle;
    let destinationHandle;
    let temporaryExists = false;
    try {
      sourceHandle = await fs.open(sourcePath, NOFOLLOW_READ_FLAGS);
      const opened = await sourceHandle.stat();
      if (!opened.isFile() || !statIdentityMatches(before, opened)) {
        fail('ASSET_CORRUPT', `Source asset ${asset.id} changed while opening.`);
      }
      destinationHandle = await fs.open(temporaryPath, 'wx', 0o600);
      temporaryExists = true;
      const hash = crypto.createHash('sha256');
      const buffer = Buffer.allocUnsafe(ASSET_COPY_BUFFER_BYTES);
      let position = 0;
      let detectedFormat = null;
      while (position < opened.size) {
        const { bytesRead } = await sourceHandle.read(
          buffer,
          0,
          Math.min(buffer.length, opened.size - position),
          position
        );
        if (bytesRead === 0) {
          fail('ASSET_CORRUPT', `Source asset ${asset.id} ended during its copy.`);
        }
        if (position === 0 && ['image', 'video'].includes(asset.kind)) {
          detectedFormat = asset.kind === 'image'
            ? imageFormatFromMagic(buffer.subarray(0, bytesRead))
            : videoFormatFromMagic(buffer.subarray(0, bytesRead));
        }
        hash.update(buffer.subarray(0, bytesRead));
        let written = 0;
        while (written < bytesRead) {
          const result = await destinationHandle.write(
            buffer,
            written,
            bytesRead - written,
            position + written
          );
          if (result.bytesWritten === 0) {
            throw new Error(`Asset ${asset.id} stopped accepting copied data.`);
          }
          written += result.bytesWritten;
        }
        position += bytesRead;
      }
      await destinationHandle.sync();
      const afterOpen = await sourceHandle.stat();
      const afterPath = await fs.lstat(sourcePath);
      const afterRealPath = await fs.realpath(sourcePath);
      if (!statIdentityMatches(opened, afterOpen)
        || !statIdentityMatches(opened, afterPath)
        || afterPath.isSymbolicLink()
        || sourceRealPath !== afterRealPath) {
        fail('ASSET_CORRUPT', `Source asset ${asset.id} changed during its copy.`);
      }
      const digest = hash.digest('hex');
      if (digest !== asset.sha256 || asset.id !== `sha256:${digest}`) {
        fail('ASSET_CORRUPT', `Source asset ${asset.id} failed its checksum.`);
      }
      if (asset.kind === 'image') {
        const expectedFormat = IMAGE_FORMAT_BY_MIME[asset.mediaType];
        if (!expectedFormat || detectedFormat !== expectedFormat) {
          fail('ASSET_CORRUPT', `Source image ${asset.id} does not match its declared type.`);
        }
      } else if (asset.kind === 'video') {
        const expectedFormat = VIDEO_FORMAT_BY_MIME[asset.mediaType];
        if (!expectedFormat || detectedFormat !== expectedFormat) {
          fail('ASSET_CORRUPT', `Source video ${asset.id} does not match its declared type.`);
        }
      }
      await destinationHandle.close();
      destinationHandle = null;
      await sourceHandle.close();
      sourceHandle = null;

      if (asset.kind === 'image') {
        const expectedFormat = IMAGE_FORMAT_BY_MIME[asset.mediaType];
        const metadata = await this._inspectImage(temporaryPath, expectedFormat);
        const orientation = Number.isSafeInteger(metadata.orientation) ? metadata.orientation : 1;
        if (metadata.width !== asset.width
          || metadata.height !== asset.height
          || orientation !== asset.orientation) {
          fail('ASSET_CORRUPT', `Source image ${asset.id} has inconsistent verified metadata.`);
        }
      }

      try {
        await fs.link(temporaryPath, finalPath);
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
        await this._validatePlannedAssetFile(finalPath, asset);
        return { installed: false, assetPath: finalPath };
      }
      await fs.unlink(temporaryPath);
      temporaryExists = false;
      await fsyncDirectory(targetAssetsPath).catch(error => {
        if (process.platform !== 'win32') throw error;
      });
      return { installed: true, assetPath: finalPath };
    } finally {
      await destinationHandle?.close().catch(() => {});
      await sourceHandle?.close().catch(() => {});
      if (temporaryExists) await fs.unlink(temporaryPath).catch(() => {});
    }
  }

  async _installPlannedAssets(sourceProjectId, plannedProject) {
    const installedPaths = [];
    try {
      for (const assetId of Object.keys(plannedProject.assets).sort()) {
        const copied = await this._copyPlannedAsset(
          sourceProjectId,
          plannedProject.id,
          plannedProject.assets[assetId]
        );
        if (copied.installed) installedPaths.push(copied.assetPath);
      }
      return installedPaths;
    } catch (error) {
      await Promise.all(installedPaths.map(assetPath =>
        fs.unlink(assetPath).catch(() => {})));
      throw error;
    }
  }

  async _copyExternalImageAsset(
    sourcePath,
    sourceRoot,
    targetProjectId,
    asset
  ) {
    if (typeof sourcePath !== 'string'
      || !path.isAbsolute(sourcePath)
      || typeof sourceRoot !== 'string'
      || !path.isAbsolute(sourceRoot)
      || asset.kind !== 'image'
      || asset.size > MAX_IMAGE_BYTES) {
      fail(
        'INVALID_EXTERNAL_IMAGE_SOURCE',
        'A reviewed PowerPoint slide image is invalid.'
      );
    }
    const extension = path.extname(sourcePath).toLowerCase();
    if (
      !['.jpg', '.jpeg'].includes(extension)
      || asset.mediaType !== 'image/jpeg'
      || !['.jpg', '.jpeg'].includes(
        path.extname(asset.storedName).toLowerCase()
      )
    ) {
      fail(
        'INVALID_EXTERNAL_IMAGE_SOURCE',
        `PowerPoint slide image ${asset.id} has inconsistent file metadata.`
      );
    }

    let rootStats;
    let realSourceRoot;
    try {
      rootStats = await fs.lstat(sourceRoot);
      realSourceRoot = await fs.realpath(sourceRoot);
    } catch (error) {
      fail(
        'EXTERNAL_IMAGE_SOURCE_UNAVAILABLE',
        'The reviewed PowerPoint render folder is unavailable.',
        { cause: error.code || error.message }
      );
    }
    if (!rootStats.isDirectory()
      || rootStats.isSymbolicLink()) {
      fail(
        'INVALID_EXTERNAL_IMAGE_SOURCE',
        'The reviewed PowerPoint render folder is unsafe.'
      );
    }

    const targetAssetsPath = path.join(
      this._projectDirectory(targetProjectId),
      'assets'
    );
    const finalPath = path.join(targetAssetsPath, asset.storedName);
    try {
      await this._validatePlannedAssetFile(finalPath, asset);
      return { installed: false, assetPath: finalPath };
    } catch (error) {
      let targetExists = true;
      try {
        await fs.lstat(finalPath);
      } catch (statError) {
        if (statError.code === 'ENOENT') targetExists = false;
        else throw statError;
      }
      if (targetExists) throw error;
    }

    let before;
    let sourceRealPath;
    try {
      before = await fs.lstat(sourcePath);
      sourceRealPath = await fs.realpath(sourcePath);
    } catch (error) {
      fail(
        'EXTERNAL_IMAGE_SOURCE_UNAVAILABLE',
        `PowerPoint slide image ${asset.id} is unavailable.`,
        { assetId: asset.id, cause: error.code || error.message }
      );
    }
    if (!before.isFile()
      || before.isSymbolicLink()
      || before.size !== asset.size
      || !isDirectChildPath(realSourceRoot, sourceRealPath)) {
      fail(
        'EXTERNAL_IMAGE_SOURCE_CHANGED',
        `PowerPoint slide image ${asset.id} is unavailable or changed.`,
        { assetId: asset.id }
      );
    }

    const temporaryPath = path.join(
      targetAssetsPath,
      `.external-image-${process.pid}-${this.randomUUID()}.tmp`
    );
    let sourceHandle;
    let destinationHandle;
    let temporaryExists = false;
    try {
      sourceHandle = await fs.open(sourcePath, NOFOLLOW_READ_FLAGS);
      const opened = await sourceHandle.stat();
      if (!opened.isFile() || !statIdentityMatches(before, opened)) {
        fail(
          'EXTERNAL_IMAGE_SOURCE_CHANGED',
          `PowerPoint slide image ${asset.id} changed while opening.`
        );
      }
      destinationHandle = await fs.open(temporaryPath, 'wx', 0o600);
      temporaryExists = true;
      const hash = crypto.createHash('sha256');
      const buffer = Buffer.allocUnsafe(ASSET_COPY_BUFFER_BYTES);
      let position = 0;
      let detectedFormat = null;
      while (position < opened.size) {
        const { bytesRead } = await sourceHandle.read(
          buffer,
          0,
          Math.min(buffer.length, opened.size - position),
          position
        );
        if (bytesRead === 0) {
          fail(
            'EXTERNAL_IMAGE_SOURCE_CHANGED',
            `PowerPoint slide image ${asset.id} ended during its copy.`
          );
        }
        if (position === 0) {
          detectedFormat = imageFormatFromMagic(
            buffer.subarray(0, bytesRead)
          );
        }
        hash.update(buffer.subarray(0, bytesRead));
        let written = 0;
        while (written < bytesRead) {
          const result = await destinationHandle.write(
            buffer,
            written,
            bytesRead - written,
            position + written
          );
          if (result.bytesWritten === 0) {
            throw new Error(
              `PowerPoint slide image ${asset.id} stopped accepting copied data.`
            );
          }
          written += result.bytesWritten;
        }
        position += bytesRead;
      }
      await destinationHandle.sync();
      const afterOpen = await sourceHandle.stat();
      const afterPath = await fs.lstat(sourcePath);
      const afterRealPath = await fs.realpath(sourcePath);
      const afterRealRoot = await fs.realpath(sourceRoot);
      if (!statIdentityMatches(opened, afterOpen)
        || !statIdentityMatches(opened, afterPath)
        || afterPath.isSymbolicLink()
        || sourceRealPath !== afterRealPath
        || realSourceRoot !== afterRealRoot
        || !isDirectChildPath(realSourceRoot, afterRealPath)) {
        fail(
          'EXTERNAL_IMAGE_SOURCE_CHANGED',
          `PowerPoint slide image ${asset.id} changed during its copy.`
        );
      }
      const digest = hash.digest('hex');
      if (digest !== asset.sha256 || asset.id !== `sha256:${digest}`) {
        fail(
          'EXTERNAL_IMAGE_SOURCE_CHANGED',
          `PowerPoint slide image ${asset.id} failed its checksum.`
        );
      }
      if (detectedFormat !== 'jpeg') {
        fail(
          'EXTERNAL_IMAGE_TYPE_MISMATCH',
          `PowerPoint slide image ${asset.id} is not a JPEG.`
        );
      }
      await destinationHandle.close();
      destinationHandle = null;
      await sourceHandle.close();
      sourceHandle = null;

      const metadata = await this._inspectImage(temporaryPath, 'jpeg');
      const orientation = Number.isSafeInteger(metadata.orientation)
        ? metadata.orientation
        : 1;
      if (metadata.width !== asset.width
        || metadata.height !== asset.height
        || orientation !== asset.orientation) {
        fail(
          'EXTERNAL_IMAGE_METADATA_MISMATCH',
          `PowerPoint slide image ${asset.id} has inconsistent dimensions.`
        );
      }

      try {
        await fs.link(temporaryPath, finalPath);
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
        await this._validatePlannedAssetFile(finalPath, asset);
        return { installed: false, assetPath: finalPath };
      }
      await fs.unlink(temporaryPath);
      temporaryExists = false;
      await fsyncDirectory(targetAssetsPath).catch(error => {
        if (process.platform !== 'win32') throw error;
      });
      return { installed: true, assetPath: finalPath };
    } finally {
      await destinationHandle?.close().catch(() => {});
      await sourceHandle?.close().catch(() => {});
      if (temporaryExists) await fs.unlink(temporaryPath).catch(() => {});
    }
  }

  /**
   * Install exact, already-reviewed rendered PowerPoint images and publish the
   * runnable native project pointer as one fail-closed operation. Paths remain
   * main-owned and never cross renderer IPC.
   */
  async createWithExternalImageAssets(
    rawProject,
    rawSources,
    options = {}
  ) {
    await this.initialize();
    const project = normalizeServiceProject(rawProject, {
      now: this.clock()
    });
    const assetIds = Object.keys(project.assets).sort();
    if (assetIds.length < 1
      || assetIds.some(assetId => project.assets[assetId].kind !== 'image')
      || !Array.isArray(rawSources)) {
      fail(
        'INVALID_EXTERNAL_IMAGE_PROJECT',
        'A PowerPoint native draft needs only reviewed rendered images.'
      );
    }
    const sources = new Map();
    for (const rawSource of rawSources) {
      const assetId = rawSource?.assetId;
      if (typeof assetId !== 'string'
        || sources.has(assetId)
        || !project.assets[assetId]
        || typeof rawSource.sourcePath !== 'string'
        || typeof rawSource.sourceRoot !== 'string'
        || !path.isAbsolute(rawSource.sourceRoot)) {
        fail(
          'INVALID_EXTERNAL_IMAGE_SOURCE',
          'Reviewed PowerPoint slide images must exactly match the native draft.'
        );
      }
      sources.set(assetId, {
        sourcePath: path.resolve(rawSource.sourcePath),
        sourceRoot: path.resolve(rawSource.sourceRoot)
      });
    }
    if (sources.size !== assetIds.length
      || assetIds.some(assetId => !sources.has(assetId))) {
      fail(
        'INVALID_EXTERNAL_IMAGE_SOURCE',
        'Reviewed PowerPoint slide images must exactly match the native draft.'
      );
    }

    const projectDirectory = await this._ensureProjectDirectories(project.id);
    return withExclusiveFileLock(
      path.join(projectDirectory, '.write-lock'),
      async () => {
        let currentPointer;
        try {
          currentPointer = await this._readCurrentPointer(project.id);
        } catch (error) {
          fail(
            'PROJECT_CONFLICT',
            'The native-draft target contains unreadable project data.',
            { projectId: project.id, cause: error.message }
          );
        }
        if (currentPointer) {
          fail(
            'PROJECT_CONFLICT',
            'A service project already uses the native-draft project id.',
            {
              projectId: project.id,
              currentRevisionId: currentPointer.revisionId
            }
          );
        }

        const installedPaths = [];
        let published = false;
        try {
          for (const assetId of assetIds) {
            const source = sources.get(assetId);
            const copied = await this._copyExternalImageAsset(
              source.sourcePath,
              source.sourceRoot,
              project.id,
              project.assets[assetId]
            );
            if (copied.installed) installedPaths.push(copied.assetPath);
          }
          const saved = await this._saveUnderLock(project, {
            expectedRevisionId: null,
            reason: options.reason || 'powerpoint-native-draft',
            beforePointerWrite: options.beforePointerWrite,
            rollbackCreatedRevisionOnPointerFailure: true
          });
          published = true;
          return saved;
        } finally {
          if (!published) {
            await Promise.all(installedPaths.map(assetPath =>
              fs.unlink(assetPath).catch(() => {})));
          }
        }
      }
    );
  }

  async planNextService(sourceProjectId, options = {}) {
    const request = Object.freeze({
      sourceRevisionId: options.sourceRevisionId,
      id: options.id,
      title: options.title,
      serviceDate: options.serviceDate,
      startTime: options.startTime,
      ...(options.teamNotes !== undefined ? { teamNotes: options.teamNotes } : {})
    });
    await this.initialize();
    const sourceRevisionId = request.sourceRevisionId;
    const initialSource = await this._readExactCurrentPlanSource(
      sourceProjectId,
      sourceRevisionId
    );
    const preflight = planNextServiceProject(initialSource.project, {
      id: request.id,
      title: request.title,
      serviceDate: request.serviceDate,
      startTime: request.startTime,
      ...(request.teamNotes !== undefined ? { teamNotes: request.teamNotes } : {}),
      now: this.clock()
    });
    if (preflight.planning.templateSource.sourceRevisionId !== sourceRevisionId) {
      fail(
        'PROJECT_REVISION_NONCANONICAL',
        'The source revision cannot be used as exact planning provenance.'
      );
    }

    const sourceProjectDirectory = await this._ensureProjectDirectories(sourceProjectId);
    const targetProjectDirectory = await this._ensureProjectDirectories(preflight.id);
    return withExclusiveFileLocks(
      [
        path.join(sourceProjectDirectory, '.write-lock'),
        path.join(targetProjectDirectory, '.write-lock')
      ],
      async () => {
        let targetPointer;
        try {
          targetPointer = await this._readCurrentPointer(preflight.id);
        } catch (error) {
          fail('PROJECT_CONFLICT', 'The planned service target already contains unreadable project data.', {
            projectId: preflight.id,
            cause: error.message
          });
        }
        if (targetPointer) {
          fail('PROJECT_CONFLICT', 'A service project already uses the planned project id.', {
            projectId: preflight.id,
            currentRevisionId: targetPointer.revisionId
          });
        }

        const source = await this._readExactCurrentPlanSource(
          sourceProjectId,
          sourceRevisionId
        );
        const plannedProject = planNextServiceProject(source.project, {
          id: request.id,
          title: request.title,
          serviceDate: request.serviceDate,
          startTime: request.startTime,
          ...(request.teamNotes !== undefined ? { teamNotes: request.teamNotes } : {}),
          now: this.clock()
        });
        const installedPaths = await this._installPlannedAssets(
          sourceProjectId,
          plannedProject
        );
        try {
          const saved = await this._saveUnderLock(plannedProject, {
            expectedRevisionId: null,
            reason: 'plan-next-service',
            rollbackCreatedRevisionOnPointerFailure: true,
            beforePointerWrite: async () => {
              try {
                await this._readExactCurrentPlanSource(
                  sourceProjectId,
                  sourceRevisionId
                );
              } catch (error) {
                throw error;
              }
            }
          });
          return {
            ...saved,
            sourceProjectId,
            sourceRevisionId
          };
        } catch (error) {
          if (error.targetPointerNotPublished === true) {
            await Promise.all(installedPaths.map(assetPath =>
              fs.unlink(assetPath).catch(() => {})));
          }
          throw error;
        }
      }
    );
  }

  async restoreRevision(projectId, options = {}) {
    await this.initialize();
    if (!REVISION_PATTERN.test(options.expectedRevisionId || '')) {
      fail('INVALID_REVISION', 'The expected project revision id is invalid.');
    }
    if (!REVISION_PATTERN.test(options.targetRevisionId || '')) {
      fail('INVALID_REVISION', 'The revision to restore is invalid.');
    }

    // Confirm the project exists before creating any directories for a lock.
    await this.read(projectId);
    const projectDirectory = await this._ensureProjectDirectories(projectId);
    return withExclusiveFileLock(path.join(projectDirectory, '.write-lock'), async () => {
      const currentPointer = await this._readCurrentPointer(projectId);
      const actualRevisionId = currentPointer?.revisionId || null;
      if (actualRevisionId !== options.expectedRevisionId) {
        fail('PROJECT_CONFLICT', 'This service changed before its saved version could be restored.', {
          projectId,
          expectedRevisionId: options.expectedRevisionId,
          currentRevisionId: actualRevisionId
        });
      }
      const target = await this._readRevision(projectId, options.targetRevisionId);
      return this._saveUnderLock(target, {
        expectedRevisionId: options.expectedRevisionId,
        reason: options.reason || 'restore-revision'
      });
    });
  }

  async listRevisions(projectId, options = {}) {
    await this.initialize();
    const current = await this.read(projectId);
    const limit = Math.max(1, Math.min(
      100,
      Number.isSafeInteger(options.limit) ? options.limit : 100
    ));
    const revisionsPath = path.join(this._projectDirectory(projectId), 'revisions');
    const entries = await fs.readdir(revisionsPath, { withFileTypes: true });
    if (entries.length > MAX_REVISIONS_PER_PROJECT) {
      fail('TOO_MANY_REVISIONS', 'This project has too many saved revisions to list safely.');
    }
    const revisions = [];
    for (const entry of entries) {
      const match = /^([a-f0-9]{64})\.json$/.exec(entry.name);
      if (!entry.isFile() || !match) continue;
      try {
        const project = await this._readRevision(projectId, match[1]);
        revisions.push({
          revisionId: match[1],
          projectRevision: project.revision,
          updatedAt: project.updatedAt,
          title: project.title,
          itemCount: Object.keys(project.items).length,
          current: match[1] === current.revisionId
        });
      } catch (_error) {
        // Invalid immutable revisions remain untouched for diagnostics and are
        // intentionally omitted from the user-facing history.
      }
    }
    revisions.sort((a, b) => b.projectRevision - a.projectRevision
      || b.updatedAt.localeCompare(a.updatedAt)
      || a.revisionId.localeCompare(b.revisionId));
    return {
      items: revisions.slice(0, limit),
      total: revisions.length,
      currentRevisionId: current.revisionId
    };
  }

  async list(options = {}) {
    await this.initialize();
    const pageSize = Math.max(1, Math.min(100, Number.isSafeInteger(options.pageSize) ? options.pageSize : 50));
    const offset = Math.max(0, Number.isSafeInteger(options.offset) ? options.offset : 0);
    const query = String(options.query || '').trim();
    if (query.length > 120) fail('QUERY_TOO_LONG', 'Project search must be 120 characters or fewer.');
    const tokens = query.toLowerCase().split(/\s+/).filter(Boolean);
    const entries = await fs.readdir(this.rootPath, { withFileTypes: true });
    if (entries.length > MAX_PROJECTS) fail('TOO_MANY_PROJECTS', `SyncShow can index at most ${MAX_PROJECTS} local projects.`);
    const results = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || !PROJECT_DIRECTORY_PATTERN.test(entry.name)) continue;
      const directoryPath = path.join(this.rootPath, entry.name);
      try {
        let projectId = null;
        for (const pointerName of ['current.json', 'current.json.bak']) {
          try {
            const { buffer } = await readFileNoFollow(path.join(directoryPath, pointerName), MAX_POINTER_BYTES);
            const candidate = JSON.parse(buffer.toString('utf8'));
            if (typeof candidate.projectId === 'string') {
              projectId = candidate.projectId;
              break;
            }
          } catch (_error) {
            // Try the backup pointer without modifying the damaged evidence.
          }
        }
        if (!projectId || projectStorageKey(projectId) !== entry.name) continue;
        const current = await this.read(projectId);
        const project = current.project;
        const searchable = `${project.title} ${project.serviceDate} ${project.id}`.toLowerCase();
        if (tokens.every(token => searchable.includes(token))) {
          results.push({
            id: project.id,
            title: project.title,
            serviceDate: project.serviceDate,
            updatedAt: project.updatedAt,
            revision: project.revision,
            revisionId: current.revisionId,
            itemCount: Object.keys(project.items).length,
            ...(project.planning
              ? {
                  planning: {
                    status: project.planning.status,
                    startTime: project.planning.startTime
                  }
                }
              : {})
          });
        }
      } catch (_error) {
        // Preserve unreadable projects for diagnostics/recovery; listing does
        // not mutate or silently discard them.
      }
    }
    results.sort((a, b) => b.serviceDate.localeCompare(a.serviceDate)
      || b.updatedAt.localeCompare(a.updatedAt)
      || a.title.localeCompare(b.title, 'en', { sensitivity: 'base' }));
    return {
      items: results.slice(offset, offset + pageSize),
      total: results.length,
      offset,
      nextOffset: offset + pageSize < results.length ? offset + pageSize : null
    };
  }

  async listSermonServiceRelationships(sermonId, options = {}) {
    await this.initialize();
    if (typeof sermonId !== 'string' || !SERMON_ID_PATTERN.test(sermonId)) {
      fail(
        'INVALID_SERMON_ID',
        'Choose one stable sermon identity before listing its saved services.'
      );
    }
    const pageSize = Math.max(1, Math.min(
      MAX_SERMON_RELATIONSHIP_PAGE_SIZE,
      Number.isSafeInteger(options.pageSize) ? options.pageSize : 50
    ));
    const offset = Math.max(0, Math.min(
      MAX_PROJECTS,
      Number.isSafeInteger(options.offset) ? options.offset : 0
    ));
    const entries = await fs.readdir(this.rootPath, { withFileTypes: true });
    if (entries.length > MAX_PROJECTS) {
      fail(
        'TOO_MANY_PROJECTS',
        `SyncShow can index at most ${MAX_PROJECTS} local projects.`
      );
    }

    const relationships = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || !PROJECT_DIRECTORY_PATTERN.test(entry.name)) continue;
      const directoryPath = path.join(this.rootPath, entry.name);
      try {
        let projectId = null;
        for (const pointerName of ['current.json', 'current.json.bak']) {
          try {
            const { buffer } = await readFileNoFollow(
              path.join(directoryPath, pointerName),
              MAX_POINTER_BYTES
            );
            const candidate = JSON.parse(buffer.toString('utf8'));
            if (typeof candidate.projectId === 'string') {
              projectId = candidate.projectId;
              break;
            }
          } catch (_error) {
            // Try the backup pointer without changing the damaged evidence.
          }
        }
        if (!projectId || projectStorageKey(projectId) !== entry.name) continue;
        const current = await this.read(projectId);
        if (current.recovery) {
          // A recovered revision is useful for explicit operator-led recovery,
          // but it is not evidence of the checksum-valid current relationship.
          // Do not resurrect an older service/sermon link in read-only history.
          continue;
        }
        const relationship = deriveSermonServiceRelationship(
          current.project,
          sermonId
        );
        if (relationship) {
          relationships.push({
            ...relationship,
            projectRevisionId: current.revisionId
          });
        }
      } catch (_error) {
        // Corrupt projects and pointers remain untouched for diagnostics. A
        // relationship query exposes only current checksum-valid revisions.
      }
    }

    relationships.sort((left, right) =>
      right.serviceDate.localeCompare(left.serviceDate)
      || right.updatedAt.localeCompare(left.updatedAt)
      || left.projectTitle.localeCompare(
        right.projectTitle,
        'en',
        { sensitivity: 'base' }
      )
      || left.projectId.localeCompare(right.projectId, 'en'));
    return {
      items: relationships.slice(offset, offset + pageSize),
      total: relationships.length,
      offset,
      nextOffset: offset + pageSize < relationships.length
        ? offset + pageSize
        : null
    };
  }

  async findByServiceSetBinding(binding = {}, options = {}) {
    await this.initialize();
    if (typeof binding.id !== 'string'
      || !binding.id
      || !REVISION_PATTERN.test(binding.fingerprint || '')) {
      throw new TypeError('A service-set id and SHA-256 fingerprint are required');
    }
    const limit = Math.max(
      1,
      Math.min(10, Number.isSafeInteger(options.limit) ? options.limit : 2)
    );
    const workflowMode = options.workflowMode === undefined
      ? null
      : String(options.workflowMode);
    const entries = await fs.readdir(this.rootPath, { withFileTypes: true });
    if (entries.length > MAX_PROJECTS) {
      fail('TOO_MANY_PROJECTS', `SyncShow can index at most ${MAX_PROJECTS} local projects.`);
    }
    const matches = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || !PROJECT_DIRECTORY_PATTERN.test(entry.name)) continue;
      const directoryPath = path.join(this.rootPath, entry.name);
      try {
        let projectId = null;
        for (const pointerName of ['current.json', 'current.json.bak']) {
          try {
            const { buffer } = await readFileNoFollow(
              path.join(directoryPath, pointerName),
              MAX_POINTER_BYTES
            );
            const candidate = JSON.parse(buffer.toString('utf8'));
            if (typeof candidate.projectId === 'string') {
              projectId = candidate.projectId;
              break;
            }
          } catch (_error) {
            // Try the backup pointer without modifying damaged evidence.
          }
        }
        if (!projectId || projectStorageKey(projectId) !== entry.name) continue;
        const current = await this.read(projectId);
        if (current.recovery) {
          // Exact companion lookup is an authority boundary, not an
          // operator-led recovery surface. A revision found by scanning or a
          // backup pointer must be reviewed and republished explicitly before
          // it can be adopted as the current ServiceSet companion.
          continue;
        }
        if (
          current.project.sourceServiceSet?.id === binding.id
          && current.project.sourceServiceSet?.fingerprint === binding.fingerprint
          && (workflowMode === null || current.project.workflowMode === workflowMode)
        ) {
          matches.push(current);
          if (matches.length >= limit) break;
        }
      } catch (_error) {
        // Preserve unreadable projects for diagnostics. A damaged project is
        // never adopted as the current service companion.
      }
    }
    return matches.sort((left, right) =>
      left.project.id.localeCompare(right.project.id, 'en'));
  }

  async _inspectImage(filePath, expectedFormat) {
    let metadata;
    if (this.imageInspector) {
      metadata = await this.imageInspector(filePath);
    } else {
      const sharp = require('sharp');
      metadata = await sharp(filePath, {
        animated: true,
        failOn: 'warning',
        limitInputPixels: MAX_IMAGE_PIXELS
      }).metadata();
    }
    if (!metadata
      || metadata.format !== expectedFormat
      || !Number.isSafeInteger(metadata.width)
      || !Number.isSafeInteger(metadata.height)
      || metadata.width < 1
      || metadata.height < 1
      || metadata.width > 32768
      || metadata.height > 32768
      || metadata.width * metadata.height > MAX_IMAGE_PIXELS
      || (metadata.orientation !== undefined
        && (!Number.isSafeInteger(metadata.orientation) || metadata.orientation < 1 || metadata.orientation > 8))
      || (metadata.pages !== undefined && metadata.pages !== 1)) {
      fail('INVALID_IMAGE', 'The selected file is not a supported single-frame PNG, JPEG, or WebP image.');
    }
    return metadata;
  }

  async importImage(projectId, options = {}) {
    return this._importImage(projectId, options, null);
  }

  async importImageAndUpdateProject(projectId, options = {}, updateProject) {
    if (typeof updateProject !== 'function') {
      throw new TypeError('importImageAndUpdateProject requires a synchronous project update');
    }
    return this._importImage(projectId, options, updateProject);
  }

  async _importImage(projectId, options = {}, updateProject = null) {
    await this.initialize();
    if (typeof options.sourcePath !== 'string' || !path.isAbsolute(options.sourcePath)) {
      fail('INVALID_IMAGE_IMPORT', 'Choose an image through SyncShow.');
    }
    const projectDirectory = await this._ensureProjectDirectories(projectId);
    return withExclusiveFileLock(path.join(projectDirectory, '.write-lock'), async () => {
      const current = await this.read(projectId);
      if (current.revisionId !== options.expectedRevisionId) {
        fail('PROJECT_CONFLICT', 'This service changed before the picture finished importing.', {
          currentRevisionId: current.revisionId
        });
      }
      const sourcePath = path.resolve(options.sourcePath);
      const beforePath = await fs.lstat(sourcePath);
      if (!beforePath.isFile() || beforePath.isSymbolicLink() || beforePath.size < 1 || beforePath.size > MAX_IMAGE_BYTES) {
        fail('INVALID_IMAGE_IMPORT', `Pictures must be regular files no larger than ${MAX_IMAGE_BYTES / (1024 * 1024)} MB.`);
      }
      const beforeRealPath = await fs.realpath(sourcePath);
      const assetsPath = path.join(projectDirectory, 'assets');
      const temporaryPath = path.join(assetsPath, `.import-${process.pid}-${this.randomUUID()}.tmp`);
      let sourceHandle;
      let destinationHandle;
      let copied = false;
      let format = null;
      let digest;
      try {
        sourceHandle = await fs.open(sourcePath, NOFOLLOW_READ_FLAGS);
        const opened = await sourceHandle.stat();
        if (!opened.isFile() || !statIdentityMatches(beforePath, opened)) fail('SOURCE_CHANGED', 'The selected image changed while opening.');
        destinationHandle = await fs.open(temporaryPath, 'wx', 0o600);
        const hash = crypto.createHash('sha256');
        const buffer = Buffer.allocUnsafe(1024 * 1024);
        let position = 0;
        while (position < opened.size) {
          const { bytesRead } = await sourceHandle.read(buffer, 0, Math.min(buffer.length, opened.size - position), position);
          if (bytesRead === 0) fail('SOURCE_CHANGED', 'The selected image ended during import.');
          if (position === 0) format = imageFormatFromMagic(buffer.subarray(0, bytesRead));
          hash.update(buffer.subarray(0, bytesRead));
          let written = 0;
          while (written < bytesRead) {
            const result = await destinationHandle.write(buffer, written, bytesRead - written, position + written);
            if (result.bytesWritten === 0) throw new Error('The image asset stopped accepting data.');
            written += result.bytesWritten;
          }
          position += bytesRead;
        }
        if (!format) fail('INVALID_IMAGE', 'Pictures must be PNG, JPEG, or WebP files.');
        await destinationHandle.sync();
        const afterOpen = await sourceHandle.stat();
        const afterPath = await fs.lstat(sourcePath);
        const afterRealPath = await fs.realpath(sourcePath);
        if (!statIdentityMatches(opened, afterOpen)
          || !statIdentityMatches(opened, afterPath)
          || afterPath.isSymbolicLink()
          || beforeRealPath !== afterRealPath) {
          fail('SOURCE_CHANGED', 'The selected image changed during import.');
        }
        digest = hash.digest('hex');
        copied = true;
      } finally {
        await destinationHandle?.close().catch(() => {});
        await sourceHandle?.close().catch(() => {});
        if (!copied) await fs.unlink(temporaryPath).catch(() => {});
      }

      const extension = IMAGE_EXTENSION_BY_FORMAT[format];
      const finalPath = path.join(assetsPath, `${digest}.${extension}`);
      let installedNewAsset = false;
      try {
        const existingHash = await hashFileNoFollow(finalPath, MAX_IMAGE_BYTES);
        if (existingHash !== digest) fail('ASSET_HASH_MISMATCH', 'An existing image asset failed its checksum.');
        await fs.unlink(temporaryPath);
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
        await fs.rename(temporaryPath, finalPath);
        installedNewAsset = true;
        await fsyncDirectory(assetsPath).catch(error => {
          if (process.platform !== 'win32') throw error;
        });
      }

      let candidate;
      let assetId;
      try {
        const stats = await fs.stat(finalPath);
        const metadata = await this._inspectImage(finalPath, format);
        assetId = `sha256:${digest}`;
        const previousAsset = current.project.assets[assetId];
        const next = JSON.parse(serializeServiceProject(current.project));
        next.assets[assetId] = {
          id: assetId,
          kind: 'image',
          sha256: digest,
          fileName: path.basename(sourcePath).slice(0, 255),
          storedName: `${digest}.${extension}`,
          mediaType: IMAGE_MIME_BY_FORMAT[format],
          size: stats.size,
          createdAt: previousAsset?.createdAt || this.clock().toISOString(),
          attribution: String(options.attribution || '').trim().slice(0, 500),
          altText: String(options.altText || '').trim().slice(0, 500),
          width: metadata.width,
          height: metadata.height,
          orientation: Number.isSafeInteger(metadata.orientation) ? metadata.orientation : 1
        };
        if (!next.assets[assetId].altText) {
          fail('MISSING_ALT_TEXT', 'Describe the picture so another operator knows what it contains.');
        }
        const mutationNow = this.clock();
        const withAsset = normalizeServiceProject(next, { now: mutationNow });
        const importedAsset = withAsset.assets[assetId];
        candidate = updateProject
          ? updateProject(withAsset, importedAsset)
          : withAsset;
        if (candidate && typeof candidate.then === 'function') {
          throw new TypeError('importImageAndUpdateProject requires a synchronous project update');
        }
        candidate = normalizeServiceProject(candidate, { now: mutationNow });
        if (candidate.id !== current.project.id) {
          fail('PROJECT_ID_MISMATCH', 'An image import cannot move content into another project.');
        }
        if (JSON.stringify(candidate.assets[assetId]) !== JSON.stringify(importedAsset)) {
          fail('IMPORTED_ASSET_CHANGED', 'The verified image asset changed during its project update.');
        }
      } catch (error) {
        if (installedNewAsset) await fs.unlink(finalPath).catch(() => {});
        throw error;
      }

      const saved = await this._saveUnderLock(candidate, {
        expectedRevisionId: current.revisionId,
        reason: options.reason || 'import-image'
      });
      return { ...saved, asset: saved.project.assets[assetId] };
    });
  }

  async importVideo(projectId, options = {}) {
    return this._importVideo(projectId, options, null);
  }

  async importVideoAndUpdateProject(projectId, options = {}, updateProject) {
    if (typeof updateProject !== 'function') {
      throw new TypeError('importVideoAndUpdateProject requires a synchronous project update');
    }
    return this._importVideo(projectId, options, updateProject);
  }

  async _importVideo(projectId, options = {}, updateProject = null) {
    await this.initialize();
    if (typeof options.sourcePath !== 'string' || !path.isAbsolute(options.sourcePath)) {
      fail('INVALID_VIDEO_IMPORT', 'Choose a video through SyncShow.');
    }
    const projectDirectory = await this._ensureProjectDirectories(projectId);
    return withExclusiveFileLock(path.join(projectDirectory, '.write-lock'), async () => {
      const current = await this.read(projectId);
      if (current.revisionId !== options.expectedRevisionId) {
        fail('PROJECT_CONFLICT', 'This service changed before the video finished importing.', {
          currentRevisionId: current.revisionId
        });
      }
      const sourcePath = path.resolve(options.sourcePath);
      const beforePath = await fs.lstat(sourcePath);
      if (!beforePath.isFile()
        || beforePath.isSymbolicLink()
        || beforePath.size < 1
        || beforePath.size > MAX_VIDEO_BYTES) {
        fail(
          'INVALID_VIDEO_IMPORT',
          `Videos must be regular MP4 or WebM files no larger than ${MAX_VIDEO_BYTES / (1024 * 1024)} MB.`
        );
      }
      const beforeRealPath = await fs.realpath(sourcePath);
      const assetsPath = path.join(projectDirectory, 'assets');
      const temporaryPath = path.join(assetsPath, `.video-import-${process.pid}-${this.randomUUID()}.tmp`);
      let sourceHandle;
      let destinationHandle;
      let copied = false;
      let format = null;
      let digest;
      try {
        sourceHandle = await fs.open(sourcePath, NOFOLLOW_READ_FLAGS);
        const opened = await sourceHandle.stat();
        if (!opened.isFile() || !statIdentityMatches(beforePath, opened)) {
          fail('SOURCE_CHANGED', 'The selected video changed while opening.');
        }
        destinationHandle = await fs.open(temporaryPath, 'wx', 0o600);
        const hash = crypto.createHash('sha256');
        const buffer = Buffer.allocUnsafe(ASSET_COPY_BUFFER_BYTES);
        let position = 0;
        while (position < opened.size) {
          const { bytesRead } = await sourceHandle.read(
            buffer,
            0,
            Math.min(buffer.length, opened.size - position),
            position
          );
          if (bytesRead === 0) fail('SOURCE_CHANGED', 'The selected video ended during import.');
          if (position === 0) format = videoFormatFromMagic(buffer.subarray(0, bytesRead));
          hash.update(buffer.subarray(0, bytesRead));
          let written = 0;
          while (written < bytesRead) {
            const result = await destinationHandle.write(
              buffer,
              written,
              bytesRead - written,
              position + written
            );
            if (result.bytesWritten === 0) throw new Error('The video asset stopped accepting data.');
            written += result.bytesWritten;
          }
          position += bytesRead;
        }
        if (!format) fail('INVALID_VIDEO', 'Videos must be MP4 or WebM files.');
        await destinationHandle.sync();
        const afterOpen = await sourceHandle.stat();
        const afterPath = await fs.lstat(sourcePath);
        const afterRealPath = await fs.realpath(sourcePath);
        if (!statIdentityMatches(opened, afterOpen)
          || !statIdentityMatches(opened, afterPath)
          || afterPath.isSymbolicLink()
          || beforeRealPath !== afterRealPath) {
          fail('SOURCE_CHANGED', 'The selected video changed during import.');
        }
        digest = hash.digest('hex');
        copied = true;
      } finally {
        await destinationHandle?.close().catch(() => {});
        await sourceHandle?.close().catch(() => {});
        if (!copied) await fs.unlink(temporaryPath).catch(() => {});
      }

      const extension = VIDEO_EXTENSION_BY_FORMAT[format];
      const finalPath = path.join(assetsPath, `${digest}.${extension}`);
      let installedNewAsset = false;
      try {
        const existingHash = await hashFileNoFollow(finalPath, MAX_VIDEO_BYTES);
        if (existingHash !== digest) fail('ASSET_HASH_MISMATCH', 'An existing video asset failed its checksum.');
        await fs.unlink(temporaryPath);
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
        await fs.rename(temporaryPath, finalPath);
        installedNewAsset = true;
        await fsyncDirectory(assetsPath).catch(error => {
          if (process.platform !== 'win32') throw error;
        });
      }

      let candidate;
      let assetId;
      try {
        const stats = await fs.stat(finalPath);
        assetId = `sha256:${digest}`;
        const previousAsset = current.project.assets[assetId];
        const next = JSON.parse(serializeServiceProject(current.project));
        next.assets[assetId] = {
          id: assetId,
          kind: 'video',
          sha256: digest,
          fileName: path.basename(sourcePath).slice(0, 255),
          storedName: `${digest}.${extension}`,
          mediaType: VIDEO_MIME_BY_FORMAT[format],
          size: stats.size,
          createdAt: previousAsset?.createdAt || this.clock().toISOString(),
          attribution: '',
          altText: ''
        };
        const mutationNow = this.clock();
        const withAsset = normalizeServiceProject(next, { now: mutationNow });
        const importedAsset = withAsset.assets[assetId];
        candidate = updateProject ? updateProject(withAsset, importedAsset) : withAsset;
        if (candidate && typeof candidate.then === 'function') {
          throw new TypeError('importVideoAndUpdateProject requires a synchronous project update');
        }
        candidate = normalizeServiceProject(candidate, { now: mutationNow });
        if (candidate.id !== current.project.id) {
          fail('PROJECT_ID_MISMATCH', 'A video import cannot move content into another project.');
        }
        if (JSON.stringify(candidate.assets[assetId]) !== JSON.stringify(importedAsset)) {
          fail('IMPORTED_ASSET_CHANGED', 'The verified video asset changed during its project update.');
        }
      } catch (error) {
        if (installedNewAsset) await fs.unlink(finalPath).catch(() => {});
        throw error;
      }

      const saved = await this._saveUnderLock(candidate, {
        expectedRevisionId: current.revisionId,
        reason: options.reason || 'import-video'
      });
      return { ...saved, asset: saved.project.assets[assetId] };
    });
  }

  async resolveAssetPath(projectId, revisionId, assetId) {
    const { project } = await this.read(projectId, { revisionId });
    const asset = project.assets[assetId];
    if (!asset) fail('ASSET_NOT_FOUND', 'That project asset does not exist.');
    const assetPath = path.join(this._projectDirectory(projectId), 'assets', asset.storedName);
    const stats = await fs.lstat(assetPath);
    if (!stats.isFile() || stats.isSymbolicLink() || stats.size !== asset.size) fail('ASSET_CORRUPT', 'That project asset is unavailable or changed.');
    if (await hashFileNoFollow(assetPath, asset.size) !== asset.sha256) fail('ASSET_CORRUPT', 'That project asset failed its checksum.');
    return { asset, assetPath };
  }

  _portableFork(project) {
    const raw = JSON.parse(serializeServiceProject(project));
    const suffix = ' (Imported copy)';
    raw.id = `project-${this.randomUUID()}`;
    raw.title = `${raw.title.slice(0, Math.max(1, 200 - suffix.length))}${suffix}`;
    raw.createdAt = this.clock().toISOString();
    raw.updatedAt = raw.createdAt;
    raw.revision = 0;
    return normalizeServiceProject(raw, { now: this.clock() });
  }

  _validatePortableAssetBuffers(project, rawAssetBuffers) {
    if (!(rawAssetBuffers instanceof Map)) {
      fail('INVALID_PORTABLE_ASSETS', 'Portable project assets must be supplied as a verified asset map.');
    }
    const expectedIds = Object.keys(project.assets).sort();
    const suppliedIds = [...rawAssetBuffers.keys()].sort();
    if (expectedIds.length !== suppliedIds.length
      || expectedIds.some((assetId, index) => assetId !== suppliedIds[index])) {
      fail('INVALID_PORTABLE_ASSETS', 'Portable project assets do not exactly match the project manifest.');
    }
    const assetBuffers = new Map();
    for (const assetId of expectedIds) {
      const asset = project.assets[assetId];
      const buffer = rawAssetBuffers.get(assetId);
      if (!Buffer.isBuffer(buffer)) {
        fail('INVALID_PORTABLE_ASSET', `Portable asset ${assetId} is not binary data.`);
      }
      if (!['image', 'video'].includes(asset.kind)) {
        fail('UNSUPPORTED_PORTABLE_ASSET', `Portable ${asset.kind} assets are not supported yet.`, { assetId });
      }
      const maximumBytes = asset.kind === 'video' ? MAX_VIDEO_BYTES : MAX_IMAGE_BYTES;
      if (buffer.length !== asset.size || buffer.length < 1 || buffer.length > maximumBytes) {
        fail('PORTABLE_ASSET_SIZE_MISMATCH', `Portable asset ${assetId} has the wrong size.`);
      }
      const digest = contentHash(buffer);
      if (digest !== asset.sha256 || assetId !== `sha256:${digest}`) {
        fail('PORTABLE_ASSET_HASH_MISMATCH', `Portable asset ${assetId} failed its checksum.`);
      }
      const expectedFormat = asset.kind === 'video'
        ? VIDEO_FORMAT_BY_MIME[asset.mediaType]
        : IMAGE_FORMAT_BY_MIME[asset.mediaType];
      const actualFormat = asset.kind === 'video'
        ? videoFormatFromMagic(buffer)
        : imageFormatFromMagic(buffer);
      if (!expectedFormat || actualFormat !== expectedFormat) {
        fail('PORTABLE_ASSET_TYPE_MISMATCH', `Portable asset ${assetId} does not match its declared media type.`);
      }
      assetBuffers.set(assetId, buffer);
    }
    return assetBuffers;
  }

  async _installPortableAssets(project, assetBuffers) {
    const projectDirectory = await this._ensureProjectDirectories(project.id);
    const assetsPath = path.join(projectDirectory, 'assets');
    for (const assetId of Object.keys(project.assets).sort()) {
      const asset = project.assets[assetId];
      const buffer = assetBuffers.get(assetId);
      const maximumBytes = asset.kind === 'video' ? MAX_VIDEO_BYTES : MAX_IMAGE_BYTES;
      const finalPath = path.join(assetsPath, asset.storedName);
      let candidatePath = finalPath;
      let temporaryPath = null;
      try {
        try {
          const existingHash = await hashFileNoFollow(finalPath, maximumBytes);
          if (existingHash !== asset.sha256) {
            fail('ASSET_HASH_MISMATCH', `Existing asset ${assetId} failed its checksum.`);
          }
          const stats = await fs.lstat(finalPath);
          if (!stats.isFile() || stats.isSymbolicLink() || stats.size !== asset.size) {
            fail('ASSET_CORRUPT', `Existing asset ${assetId} is unavailable or changed.`);
          }
        } catch (error) {
          if (error.code !== 'ENOENT') throw error;
          temporaryPath = path.join(assetsPath, `.portable-${process.pid}-${this.randomUUID()}.tmp`);
          await atomicWriteFile(temporaryPath, buffer, {
            maximumBytes,
            mode: 0o600,
            rootPath: this.rootPath
          });
          candidatePath = temporaryPath;
        }

        await this._validatePlannedAssetFile(candidatePath, asset);
        if (temporaryPath) {
          await fs.rename(temporaryPath, finalPath);
          temporaryPath = null;
          await fsyncDirectory(assetsPath).catch(error => {
            if (process.platform !== 'win32') throw error;
          });
        }
      } finally {
        if (temporaryPath) await fs.unlink(temporaryPath).catch(() => {});
      }
    }
  }

  async importPortableProject(rawProject, rawAssetBuffers, options = {}) {
    await this.initialize();
    const sourceProject = normalizeServiceProject(rawProject, { now: this.clock() });
    const assetBuffers = this._validatePortableAssetBuffers(sourceProject, rawAssetBuffers);
    let candidate = sourceProject;
    let forked = false;

    for (let attempt = 0; attempt < 8; attempt += 1) {
      let projectDirectory;
      try {
        projectDirectory = await this._ensureProjectDirectories(candidate.id);
      } catch (error) {
        if (!forked) {
          candidate = this._portableFork(sourceProject);
          forked = true;
          continue;
        }
        throw error;
      }

      const outcome = await withExclusiveFileLock(path.join(projectDirectory, '.write-lock'), async () => {
        let currentPointer;
        try {
          currentPointer = await this._readCurrentPointer(candidate.id);
        } catch (error) {
          return { collision: true, cause: error };
        }
        if (currentPointer) {
          let currentProject;
          try {
            currentProject = await this._readRevision(candidate.id, currentPointer.revisionId);
          } catch (error) {
            return { collision: true, cause: error };
          }
          if (!forked && semanticProjectHash(currentProject) === semanticProjectHash(sourceProject)) {
            await this._installPortableAssets(currentProject, assetBuffers);
            return {
              project: currentProject,
              revisionId: currentPointer.revisionId,
              unchanged: true,
              recovery: null,
              imported: false,
              forked: false,
              sourceProjectId: sourceProject.id,
              sourceRevisionId: options.sourceRevisionId || null
            };
          }
          return { collision: true };
        }

        await this._installPortableAssets(candidate, assetBuffers);
        const saved = await this._saveUnderLock(candidate, {
          expectedRevisionId: null,
          reason: options.reason || 'portable-import'
        });
        return {
          ...saved,
          imported: true,
          forked,
          sourceProjectId: sourceProject.id,
          sourceRevisionId: options.sourceRevisionId || null
        };
      });

      if (!outcome.collision) return outcome;
      candidate = this._portableFork(sourceProject);
      forked = true;
    }

    fail('PORTABLE_IMPORT_COLLISION', 'SyncShow could not allocate a safe local project id for this import.');
  }

  async collectSermonSourceObjectReferences(options = {}) {
    const maximumFiles = referenceScanCapacity(
      options.maximumFiles,
      MAX_SERMON_REFERENCE_SCAN_FILES,
      MAX_SERMON_REFERENCE_SCAN_FILES,
      'maximumFiles'
    );
    const maximumBytes = referenceScanCapacity(
      options.maximumBytes,
      MAX_SERMON_REFERENCE_SCAN_BYTES,
      MAX_SERMON_REFERENCE_SCAN_BYTES,
      'maximumBytes'
    );
    await this.initialize();
    let rootEntries;
    try {
      rootEntries = await fs.readdir(this.rootPath, { withFileTypes: true });
    } catch (_error) {
      fail('REFERENCE_SCAN_INCOMPLETE', 'The service project reference scan could not be completed.');
    }
    rootEntries.sort((left, right) => left.name.localeCompare(right.name));
    const projectEntries = [];
    for (const entry of rootEntries) {
      if (
        !PROJECT_DIRECTORY_PATTERN.test(entry.name)
        || !entry.isDirectory()
        || entry.isSymbolicLink?.()
      ) {
        fail('REFERENCE_SCAN_AMBIGUOUS', 'The service project store contains an unsupported entry.');
      }
      projectEntries.push(entry);
    }
    if (projectEntries.length > MAX_PROJECTS) {
      fail('REFERENCE_SCAN_LIMIT', 'The service project store exceeds the bounded reference scan.');
    }

    const digests = new Set();
    let filesScanned = 0;
    let bytesScanned = 0;
    let revisionsScanned = 0;
    const accountFile = stats => {
      if (!stats.isFile() || stats.isSymbolicLink()) {
        fail('REFERENCE_SCAN_AMBIGUOUS', 'The service project store contains an unsafe reference file.');
      }
      if (
        filesScanned + 1 > maximumFiles
        || bytesScanned + stats.size > maximumBytes
      ) {
        fail('REFERENCE_SCAN_LIMIT', 'The service project store exceeds the bounded reference scan.');
      }
      filesScanned += 1;
      bytesScanned += stats.size;
    };

    for (const entry of projectEntries) {
      const projectDirectory = path.join(this.rootPath, entry.name);
      try {
        await ensureConfinedDirectory(this.rootPath, projectDirectory);
      } catch (_error) {
        fail('REFERENCE_SCAN_AMBIGUOUS', 'The service project store contains an unsafe directory.');
      }
      let children;
      try {
        children = await fs.readdir(projectDirectory, { withFileTypes: true });
      } catch (_error) {
        fail('REFERENCE_SCAN_INCOMPLETE', 'The service project reference scan could not be completed.');
      }
      let revisionsEntry = null;
      let assetsEntry = null;
      const pointerNames = [];
      for (const child of children) {
        if (child.name === 'revisions') {
          revisionsEntry = child;
        } else if (child.name === 'assets') {
          assetsEntry = child;
        } else if (child.name === 'current.json' || child.name === 'current.json.bak') {
          pointerNames.push(child.name);
          if (!child.isFile() || child.isSymbolicLink?.()) {
            fail('REFERENCE_SCAN_AMBIGUOUS', 'The service project store contains an unsafe pointer.');
          }
        } else if (child.name === '.write-lock') {
          fail('REFERENCE_SCAN_BUSY', 'A service project is being updated; cleanup evidence is not stable.');
        } else {
          fail('REFERENCE_SCAN_AMBIGUOUS', 'The service project store contains an unsupported entry.');
        }
      }
      if (
        !revisionsEntry
        || !revisionsEntry.isDirectory()
        || revisionsEntry.isSymbolicLink?.()
        || !assetsEntry
        || !assetsEntry.isDirectory()
        || assetsEntry.isSymbolicLink?.()
      ) {
        fail('REFERENCE_SCAN_AMBIGUOUS', 'The service project inventory is incomplete or unsafe.');
      }
      const revisionsPath = path.join(projectDirectory, 'revisions');
      const assetsPath = path.join(projectDirectory, 'assets');
      try {
        await ensureConfinedDirectory(this.rootPath, revisionsPath);
        await ensureConfinedDirectory(this.rootPath, assetsPath);
      } catch (_error) {
        fail('REFERENCE_SCAN_AMBIGUOUS', 'The service project inventory is unsafe.');
      }
      let revisionEntries;
      try {
        revisionEntries = await fs.readdir(revisionsPath, { withFileTypes: true });
      } catch (_error) {
        fail('REFERENCE_SCAN_INCOMPLETE', 'The service project revision scan could not be completed.');
      }
      revisionEntries.sort((left, right) => left.name.localeCompare(right.name));
      if (revisionEntries.length < 1 || revisionEntries.length > MAX_REVISIONS_PER_PROJECT) {
        fail('REFERENCE_SCAN_AMBIGUOUS', 'The service project revision inventory is incomplete or excessive.');
      }
      if (revisionEntries.length + pointerNames.length > maximumFiles - filesScanned) {
        fail('REFERENCE_SCAN_LIMIT', 'The service project store exceeds the bounded reference scan.');
      }
      const revisionIds = new Map();
      let projectId = null;
      for (const revisionEntry of revisionEntries) {
        const match = /^([a-f0-9]{64})\.json$/.exec(revisionEntry.name);
        if (!match || !revisionEntry.isFile() || revisionEntry.isSymbolicLink?.()) {
          fail('REFERENCE_SCAN_AMBIGUOUS', 'The service project store contains an unsupported revision entry.');
        }
        const revisionPath = path.join(revisionsPath, revisionEntry.name);
        let buffer;
        try {
          const stats = await fs.lstat(revisionPath);
          accountFile(stats);
          ({ buffer } = await readFileNoFollow(revisionPath, MAX_PROJECT_JSON_BYTES));
        } catch (error) {
          if (error instanceof ProjectStoreError) throw error;
          fail('REFERENCE_SCAN_INCOMPLETE', 'The service project revision scan could not be completed.');
        }
        if (contentHash(buffer) !== match[1]) {
          fail('REFERENCE_SCAN_CORRUPT', 'A service project revision failed its checksum.');
        }
        let project;
        try {
          const source = new TextDecoder('utf-8', { fatal: true }).decode(buffer);
          project = normalizeServiceProject(JSON.parse(source));
        } catch (_error) {
          fail('REFERENCE_SCAN_CORRUPT', 'A service project revision failed validation.');
        }
        if (
          !Buffer.from(serializeServiceProject(project), 'utf8').equals(buffer)
          || projectStorageKey(project.id) !== entry.name
          || (projectId !== null && project.id !== projectId)
        ) {
          fail('REFERENCE_SCAN_CORRUPT', 'A service project revision is not canonical for its storage identity.');
        }
        projectId = project.id;
        revisionIds.set(match[1], {
          revision: project.revision,
          updatedAt: project.updatedAt
        });
        revisionsScanned += 1;
        for (const resource of Object.values(project.resources)) {
          if (resource.kind !== 'sermon') continue;
          for (const source of resource.document.sources) digests.add(source.sha256);
        }
      }

      for (const pointerName of pointerNames.sort()) {
        const pointerPath = path.join(projectDirectory, pointerName);
        let buffer;
        let pointer;
        try {
          const stats = await fs.lstat(pointerPath);
          accountFile(stats);
          ({ buffer } = await readFileNoFollow(pointerPath, MAX_POINTER_BYTES));
          pointer = JSON.parse(
            new TextDecoder('utf-8', { fatal: true }).decode(buffer)
          );
        } catch (error) {
          if (error instanceof ProjectStoreError) throw error;
          fail('REFERENCE_SCAN_CORRUPT', 'A service project pointer failed validation.');
        }
        if (
          !pointer
          || Object.keys(pointer).length !== 6
          || pointer.schemaVersion !== POINTER_SCHEMA_VERSION
          || pointer.projectId !== projectId
          || !REVISION_PATTERN.test(pointer.revisionId || '')
          || !Number.isSafeInteger(pointer.projectRevision)
          || pointer.projectRevision < 1
          || revisionIds.get(pointer.revisionId)?.revision !== pointer.projectRevision
          || !isCanonicalTimestamp(pointer.updatedAt)
          || revisionIds.get(pointer.revisionId)?.updatedAt !== pointer.updatedAt
          || typeof pointer.reason !== 'string'
          || pointer.reason.length > 40
          || !buffer.equals(Buffer.from(`${JSON.stringify({
            schemaVersion: pointer.schemaVersion,
            projectId: pointer.projectId,
            revisionId: pointer.revisionId,
            projectRevision: pointer.projectRevision,
            updatedAt: pointer.updatedAt,
            reason: pointer.reason
          }, null, 2)}\n`, 'utf8'))
        ) {
          fail('REFERENCE_SCAN_CORRUPT', 'A service project pointer references an unavailable revision.');
        }
      }
    }

    return Object.freeze({
      digests: Object.freeze([...digests].sort()),
      projectCount: projectEntries.length,
      revisionCount: revisionsScanned,
      filesScanned,
      bytesScanned
    });
  }
}

module.exports = {
  MAX_IMAGE_BYTES,
  MAX_VIDEO_BYTES,
  MAX_SERMON_REFERENCE_SCAN_FILES,
  MAX_SERMON_RELATIONSHIP_PAGE_SIZE,
  ProjectStoreError,
  ServiceProjectStore,
  imageFormatFromMagic,
  videoFormatFromMagic,
  projectStorageKey,
  semanticProjectHash
};
