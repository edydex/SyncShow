'use strict';

const crypto = require('crypto');
const nativeFs = require('fs');
const fs = require('fs/promises');
const path = require('path');

const {
  MAX_IMAGE_PIXELS,
  MAX_PROJECT_JSON_BYTES,
  createServiceProject,
  normalizeServiceProject,
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
const MAX_IMAGE_BYTES = 75 * 1024 * 1024;
const IMAGE_MIME_BY_FORMAT = Object.freeze({ png: 'image/png', jpeg: 'image/jpeg', webp: 'image/webp' });
const IMAGE_EXTENSION_BY_FORMAT = Object.freeze({ png: 'png', jpeg: 'jpg', webp: 'webp' });
const IMAGE_FORMAT_BY_MIME = Object.freeze({ 'image/png': 'png', 'image/jpeg': 'jpeg', 'image/webp': 'webp' });

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

  async create(input = {}) {
    await this.initialize();
    const draft = createServiceProject({
      ...input,
      id: input.id || `project-${this.randomUUID()}`,
      now: this.clock()
    });
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
    if (currentProject && semanticProjectHash(currentProject) === semanticProjectHash(incoming)) {
      return { project: currentProject, revisionId: currentPointer.revisionId, unchanged: true, recovery: null };
    }

    const raw = JSON.parse(serializeServiceProject(incoming));
    raw.createdAt = currentProject?.createdAt || incoming.createdAt;
    raw.updatedAt = this.clock().toISOString();
    raw.revision = (currentProject?.revision || 0) + 1;
    incoming = normalizeServiceProject(raw);
    const serialized = serializeServiceProject(incoming);
    const revisionId = contentHash(serialized);
    const revisionPath = path.join(projectDirectory, 'revisions', `${revisionId}.json`);
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
    await this._writePointer(projectDirectory, pointer, currentPointer && {
      schemaVersion: POINTER_SCHEMA_VERSION,
      projectId: currentPointer.projectId,
      revisionId: currentPointer.revisionId,
      projectRevision: currentPointer.projectRevision,
      updatedAt: currentPointer.updatedAt,
      reason: currentPointer.reason || 'previous'
    });
    return { project: incoming, revisionId, unchanged: false, recovery: null };
  }

  async save(project, options = {}) {
    await this.initialize();
    const normalized = normalizeServiceProject(project, { now: this.clock() });
    const projectDirectory = await this._ensureProjectDirectories(normalized.id);
    return withExclusiveFileLock(path.join(projectDirectory, '.write-lock'), () =>
      this._saveUnderLock(normalized, options));
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
            itemCount: Object.keys(project.items).length
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
      if (asset.kind !== 'image') {
        fail('UNSUPPORTED_PORTABLE_ASSET', `Portable ${asset.kind} assets are not supported yet.`, { assetId });
      }
      if (buffer.length !== asset.size || buffer.length < 1 || buffer.length > MAX_IMAGE_BYTES) {
        fail('PORTABLE_ASSET_SIZE_MISMATCH', `Portable asset ${assetId} has the wrong size.`);
      }
      const digest = contentHash(buffer);
      if (digest !== asset.sha256 || assetId !== `sha256:${digest}`) {
        fail('PORTABLE_ASSET_HASH_MISMATCH', `Portable asset ${assetId} failed its checksum.`);
      }
      const expectedFormat = IMAGE_FORMAT_BY_MIME[asset.mediaType];
      if (!expectedFormat || imageFormatFromMagic(buffer) !== expectedFormat) {
        fail('PORTABLE_ASSET_TYPE_MISMATCH', `Portable asset ${assetId} does not match its declared image type.`);
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
      const expectedFormat = IMAGE_FORMAT_BY_MIME[asset.mediaType];
      const finalPath = path.join(assetsPath, asset.storedName);
      let candidatePath = finalPath;
      let temporaryPath = null;
      try {
        try {
          const existingHash = await hashFileNoFollow(finalPath, MAX_IMAGE_BYTES);
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
            maximumBytes: MAX_IMAGE_BYTES,
            mode: 0o600,
            rootPath: this.rootPath
          });
          candidatePath = temporaryPath;
        }

        const metadata = await this._inspectImage(candidatePath, expectedFormat);
        const orientation = Number.isSafeInteger(metadata.orientation) ? metadata.orientation : 1;
        if (metadata.width !== asset.width
          || metadata.height !== asset.height
          || orientation !== asset.orientation) {
          fail('PORTABLE_ASSET_METADATA_MISMATCH', `Portable asset ${assetId} has inconsistent image metadata.`);
        }
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
}

module.exports = {
  MAX_IMAGE_BYTES,
  ProjectStoreError,
  ServiceProjectStore,
  imageFormatFromMagic,
  projectStorageKey,
  semanticProjectHash
};
