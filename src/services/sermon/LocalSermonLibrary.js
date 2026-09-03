'use strict';

const crypto = require('crypto');
const fs = require('fs/promises');
const path = require('path');
const { TextDecoder } = require('util');

const {
  MAX_SERMON_SOURCE_BYTES,
  parseSermonDocument,
  serializeSermonDocument
} = require('./SermonDocument');
const {
  atomicWriteFile,
  ensureConfinedDirectory,
  ensurePrivateDirectory,
  hashFileNoFollow,
  readFileNoFollow,
  withExclusiveFileLock
} = require('../project/StorageSafety');

const POINTER_SCHEMA_VERSION = 1;
const SERMON_DIRECTORY_PATTERN = /^sermon-[a-f0-9]{64}$/;
const REVISION_PATTERN = /^[a-f0-9]{64}$/;
const SERMON_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const MAX_LIBRARY_SERMONS = 10000;
const MAX_QUERY_LENGTH = 120;
const MAX_PAGE_SIZE = 100;
const MAX_POINTER_BYTES = 64 * 1024;
const MAX_REFERENCE_SCAN_FILES = 200_000;
const MAX_REFERENCE_SCAN_BYTES = 1024 * 1024 * 1024 * 1024;

class SermonLibraryError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'SermonLibraryError';
    this.code = code;
    this.details = details;
  }
}

function fail(code, message, details = {}) {
  throw new SermonLibraryError(code, message, details);
}

function sermonIdStorageKey(sermonId) {
  return `sermon-${crypto.createHash('sha256').update(String(sermonId)).digest('hex')}`;
}

function sourceRevision(source) {
  return crypto.createHash('sha256').update(source).digest('hex');
}

function referenceScanCapacity(value, fallback, maximum, label) {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new TypeError(`${label} must be an integer between 1 and ${maximum}`);
  }
  return value;
}

function isCanonicalTimestamp(value) {
  return typeof value === 'string'
    && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
    && Number.isFinite(Date.parse(value));
}

function decodeUtf8(source, label = 'Sermon source') {
  if (typeof source === 'string') return source;
  if (!Buffer.isBuffer(source)) {
    fail('INVALID_SERMON_SOURCE', `${label} must be JSON text.`);
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(source);
  } catch (_error) {
    fail('INVALID_UTF8', `${label} is not valid UTF-8 text.`);
  }
}

function summary(sermon, revision, updatedAt) {
  const primaryReferenceCount = sermon.references.filter(reference => reference.role === 'primary').length;
  const mentionedReferenceCount = sermon.references.length - primaryReferenceCount;
  return {
    id: sermon.id,
    title: sermon.titles[sermon.defaultLanguage],
    titles: { ...sermon.titles },
    languages: Object.keys(sermon.titles),
    defaultLanguage: sermon.defaultLanguage,
    speaker: { ...sermon.speaker },
    serviceDate: sermon.serviceDate,
    series: sermon.series
      ? {
          id: sermon.series.id,
          titles: { ...sermon.series.titles }
        }
      : null,
    primaryReferenceCount,
    mentionedReferenceCount,
    confirmedReferenceCount: sermon.references.filter(
      reference => reference.reviewStatus === 'confirmed'
    ).length,
    publication: { ...sermon.publication },
    revision,
    updatedAt
  };
}

function searchableText(sermon) {
  return [
    sermon.id,
    ...Object.keys(sermon.titles),
    ...Object.values(sermon.titles),
    sermon.defaultLanguage,
    sermon.speaker.id || '',
    sermon.speaker.name,
    sermon.serviceDate,
    sermon.series?.id || '',
    ...Object.values(sermon.series?.titles || {}),
    sermon.publication.status,
    sermon.publication.visibility,
    ...sermon.outline.flatMap(section => [
      section.id,
      section.kind,
      ...Object.values(section.titles)
    ]),
    ...sermon.references.flatMap(reference => [
      reference.range.bookId,
      reference.role,
      reference.enteredText
    ]),
    ...sermon.sources.flatMap(source => [
      source.kind,
      source.fileName,
      ...(source.languages || [source.language])
    ]),
    ...sermon.media.flatMap(item => [
      item.kind,
      item.title,
      item.language
    ])
  ].join(' ').toLowerCase();
}

class LocalSermonLibrary {
  constructor(options = {}) {
    if (typeof options.rootPath !== 'string' || !path.isAbsolute(options.rootPath)) {
      throw new TypeError('LocalSermonLibrary requires an absolute rootPath');
    }
    this.rootPath = path.resolve(options.rootPath);
    this.clock = options.clock || (() => new Date());
  }

  async initialize() {
    this.rootPath = await ensurePrivateDirectory(this.rootPath);
    return this;
  }

  _expectedSermonId(value) {
    if (typeof value !== 'string' || !SERMON_ID_PATTERN.test(value)) {
      fail('INVALID_SERMON_ID', 'The sermon identity being opened or edited is invalid.');
    }
    return value;
  }

  _sermonDirectory(sermonId) {
    return path.join(this.rootPath, sermonIdStorageKey(sermonId));
  }

  async _existingConfinedDirectory(directoryPath) {
    let stats;
    try {
      stats = await fs.lstat(directoryPath);
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw error;
    }
    if (!stats.isDirectory() || stats.isSymbolicLink()) {
      throw new Error(`Unsafe storage directory: ${directoryPath}`);
    }
    return ensureConfinedDirectory(this.rootPath, directoryPath);
  }

  async _readPointer(rawSermonId) {
    const sermonId = this._expectedSermonId(rawSermonId);
    const sermonDirectory = this._sermonDirectory(sermonId);
    try {
      if (!await this._existingConfinedDirectory(sermonDirectory)) return null;
    } catch (error) {
      fail('LIBRARY_POINTER_INVALID', `The saved pointer for ${sermonId} is unsafe.`, {
        sermonId,
        cause: error.message
      });
    }

    const pointerPath = path.join(sermonDirectory, 'current.json');
    let payload;
    try {
      const { buffer } = await readFileNoFollow(pointerPath, MAX_POINTER_BYTES);
      payload = JSON.parse(decodeUtf8(buffer, `The saved pointer for ${sermonId}`));
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      if (error instanceof SermonLibraryError && error.code === 'INVALID_UTF8') {
        fail('LIBRARY_POINTER_INVALID', `The saved pointer for ${sermonId} is unreadable.`, {
          sermonId,
          cause: error.message
        });
      }
      fail('LIBRARY_POINTER_INVALID', `The saved pointer for ${sermonId} is unreadable.`, {
        sermonId,
        cause: error.message
      });
    }

    if (
      !payload
      || payload.schemaVersion !== POINTER_SCHEMA_VERSION
      || payload.sermonId !== sermonId
      || !REVISION_PATTERN.test(payload.revision || '')
      || !isCanonicalTimestamp(payload.updatedAt)
    ) {
      fail('LIBRARY_POINTER_INVALID', `The saved pointer for ${sermonId} is invalid.`, {
        sermonId
      });
    }
    return payload;
  }

  async _readRevision(rawSermonId, revision, updatedAt = null) {
    const sermonId = this._expectedSermonId(rawSermonId);
    if (!REVISION_PATTERN.test(revision || '')) {
      fail('INVALID_LIBRARY_REVISION', 'Sermon revision is invalid.');
    }

    const versionsDirectory = path.join(this._sermonDirectory(sermonId), 'versions');
    try {
      if (!await this._existingConfinedDirectory(versionsDirectory)) {
        fail(
          'LIBRARY_REVISION_MISSING',
          `${sermonId} revision ${revision.slice(0, 8)} is unavailable.`,
          { sermonId, revision }
        );
      }
    } catch (error) {
      if (error instanceof SermonLibraryError) throw error;
      fail(
        'LIBRARY_REVISION_MISSING',
        `${sermonId} revision ${revision.slice(0, 8)} is unavailable.`,
        { sermonId, revision, cause: error.message }
      );
    }

    const filePath = path.join(versionsDirectory, `${revision}.json`);
    let buffer;
    try {
      ({ buffer } = await readFileNoFollow(filePath, MAX_SERMON_SOURCE_BYTES));
    } catch (error) {
      fail(
        'LIBRARY_REVISION_MISSING',
        `${sermonId} revision ${revision.slice(0, 8)} is unavailable.`,
        { sermonId, revision, cause: error.message }
      );
    }

    const actualRevision = crypto.createHash('sha256').update(buffer).digest('hex');
    if (actualRevision !== revision) {
      fail(
        'LIBRARY_REVISION_CORRUPT',
        `${sermonId} no longer matches its saved checksum.`,
        { sermonId, revision, actualRevision }
      );
    }

    const source = decodeUtf8(buffer, `${sermonId} revision ${revision.slice(0, 8)}`);
    let sermon;
    try {
      sermon = parseSermonDocument(source);
    } catch (error) {
      fail(
        'LIBRARY_REVISION_INVALID',
        `${sermonId} revision ${revision.slice(0, 8)} is not a valid sermon document.`,
        { sermonId, revision, cause: error.message }
      );
    }
    if (sermon.id !== sermonId) {
      fail(
        'LIBRARY_ID_MISMATCH',
        `Stored sermon ${sermonId} contains id ${sermon.id}.`,
        { sermonId, actualSermonId: sermon.id }
      );
    }

    return {
      sermon,
      document: sermon,
      source,
      documentSource: source,
      revision,
      updatedAt: updatedAt || null,
      summary: summary(sermon, revision, updatedAt || null)
    };
  }

  async validateSource(source, options = {}) {
    const decoded = decodeUtf8(source);
    let sermon = parseSermonDocument(decoded);
    if (options.expectedSermonId !== undefined && options.expectedSermonId !== null) {
      const expectedSermonId = this._expectedSermonId(options.expectedSermonId);
      if (sermon.id !== expectedSermonId) {
        fail(
          'SERMON_ID_CHANGED',
          `This edit belongs to ${expectedSermonId}; its saved sermon id cannot be changed to ${sermon.id}.`,
          { expectedSermonId, actualSermonId: sermon.id }
        );
      }
    }
    const documentSource = serializeSermonDocument(sermon);
    sermon = parseSermonDocument(documentSource);
    const revision = sourceRevision(documentSource);
    return {
      sermon,
      document: sermon,
      source: documentSource,
      documentSource,
      revision,
      updatedAt: null,
      summary: summary(sermon, revision, null)
    };
  }

  async validateDocument(document, options = {}) {
    return this.validateSource(serializeSermonDocument(document), options);
  }

  async validate(value, options = {}) {
    if (typeof value === 'string' || Buffer.isBuffer(value)) {
      return this.validateSource(value, options);
    }
    return this.validateDocument(value, options);
  }

  async read(rawSermonId, options = {}) {
    await this.initialize();
    const sermonId = this._expectedSermonId(rawSermonId);
    if (options.revision !== undefined && options.revision !== null) {
      return this._readRevision(sermonId, options.revision);
    }
    const pointer = await this._readPointer(sermonId);
    if (!pointer) {
      fail('SERMON_NOT_FOUND', `Sermon ${sermonId} is not in the local library.`, {
        sermonId
      });
    }
    return this._readRevision(sermonId, pointer.revision, pointer.updatedAt);
  }

  async readCurrent(sermonId) {
    return this.read(sermonId);
  }

  async readRevision(sermonId, revision) {
    return this.read(sermonId, { revision });
  }

  async saveSource(source, options = {}) {
    await this.initialize();
    return withExclusiveFileLock(path.join(this.rootPath, '.library-write-lock'), () =>
      this._saveSourceUnderLibraryLock(source, options));
  }

  async _storeImmutableRevision(sermonId, revision, canonical) {
    const sermonDirectory = this._sermonDirectory(sermonId);
    const revisionPath = path.join(sermonDirectory, 'versions', `${revision}.json`);
    try {
      const existingHash = await hashFileNoFollow(revisionPath, MAX_SERMON_SOURCE_BYTES);
      if (existingHash !== revision) {
        fail(
          'LIBRARY_REVISION_CORRUPT',
          'An immutable sermon revision has changed.',
          { sermonId, revision, actualRevision: existingHash }
        );
      }
    } catch (error) {
      if (error.code === 'ENOENT') {
        await atomicWriteFile(revisionPath, canonical, {
          maximumBytes: MAX_SERMON_SOURCE_BYTES,
          mode: 0o600,
          rootPath: this.rootPath
        });
      } else if (error instanceof SermonLibraryError) {
        throw error;
      } else {
        fail(
          'LIBRARY_REVISION_CORRUPT',
          'An immutable sermon revision is unsafe.',
          { sermonId, revision, cause: error.message }
        );
      }
    }
  }

  async _saveSourceUnderLibraryLock(source, options = {}) {
    let expectedRevision;
    if (options.expectedRevision !== undefined) {
      expectedRevision = options.expectedRevision;
      if (
        expectedRevision !== null
        && (typeof expectedRevision !== 'string' || !REVISION_PATTERN.test(expectedRevision))
      ) {
        fail('INVALID_LIBRARY_REVISION', 'Expected sermon revision is invalid.');
      }
    }
    const validated = await this.validateSource(source, {
      expectedSermonId: options.expectedSermonId
    });
    const sermon = validated.sermon;
    const canonical = validated.documentSource;
    const revision = validated.revision;
    const sermonId = sermon.id;

    const existing = await this._readPointer(sermonId);
    if (existing && existing.revision !== revision && expectedRevision === undefined) {
      fail(
        'SERMON_CONFLICT',
        `${validated.summary.title} already exists. Open it before replacing it.`,
        { sermonId, currentRevision: existing.revision }
      );
    }

    const sermonDirectory = this._sermonDirectory(sermonId);
    await ensureConfinedDirectory(this.rootPath, path.join(sermonDirectory, 'versions'));
    return withExclusiveFileLock(path.join(sermonDirectory, '.write-lock'), async () => {
      const current = await this._readPointer(sermonId);
      if (expectedRevision !== undefined) {
        const expected = expectedRevision;
        const actual = current?.revision || null;
        if (expected !== actual) {
          fail('SERMON_CONFLICT', `${validated.summary.title} changed since it was opened.`, {
            sermonId,
            expectedRevision: expected,
            currentRevision: actual
          });
        }
      }

      if (current?.revision === revision) {
        return {
          ...(await this._readRevision(sermonId, revision, current.updatedAt)),
          unchanged: true
        };
      }

      await this._storeImmutableRevision(sermonId, revision, canonical);

      const updatedAt = this.clock().toISOString();
      const pointer = {
        schemaVersion: POINTER_SCHEMA_VERSION,
        sermonId,
        revision,
        updatedAt
      };
      await atomicWriteFile(
        path.join(sermonDirectory, 'current.json'),
        `${JSON.stringify(pointer, null, 2)}\n`,
        {
          maximumBytes: MAX_POINTER_BYTES,
          mode: 0o600,
          rootPath: this.rootPath
        }
      );
      return {
        ...(await this._readRevision(sermonId, revision, updatedAt)),
        unchanged: false
      };
    });
  }

  async saveDocument(document, options = {}) {
    return this.saveSource(serializeSermonDocument(document), options);
  }

  async stageSource(source, options = {}) {
    await this.initialize();
    return withExclusiveFileLock(path.join(this.rootPath, '.library-write-lock'), async () => {
      const validated = await this.validateSource(source, {
        expectedSermonId: options.expectedSermonId
      });
      const expectedRevision = options.expectedRevision;
      if (
        expectedRevision !== null
        && (typeof expectedRevision !== 'string' || !REVISION_PATTERN.test(expectedRevision || ''))
      ) {
        fail('INVALID_LIBRARY_REVISION', 'Expected sermon revision is invalid.');
      }
      if (expectedRevision === undefined) {
        fail(
          'INVALID_LIBRARY_REVISION',
          'Staging a sermon revision requires its current expected revision.'
        );
      }

      const { sermon, revision, documentSource: canonical } = validated;
      const sermonDirectory = this._sermonDirectory(sermon.id);
      await ensureConfinedDirectory(this.rootPath, path.join(sermonDirectory, 'versions'));
      return withExclusiveFileLock(path.join(sermonDirectory, '.write-lock'), async () => {
        const current = await this._readPointer(sermon.id);
        const actualRevision = current?.revision || null;
        if (actualRevision !== expectedRevision) {
          fail('SERMON_CONFLICT', `${validated.summary.title} changed since it was opened.`, {
            sermonId: sermon.id,
            expectedRevision,
            currentRevision: actualRevision
          });
        }
        await this._storeImmutableRevision(sermon.id, revision, canonical);
        return {
          ...(await this._readRevision(
            sermon.id,
            revision,
            current?.revision === revision ? current.updatedAt : null
          )),
          unchanged: current?.revision === revision,
          staged: current?.revision !== revision
        };
      });
    });
  }

  async stageDocument(document, options = {}) {
    return this.stageSource(serializeSermonDocument(document), options);
  }

  async promoteRevision(rawSermonId, revision, options = {}) {
    await this.initialize();
    const sermonId = this._expectedSermonId(rawSermonId);
    if (!REVISION_PATTERN.test(revision || '')) {
      fail('INVALID_LIBRARY_REVISION', 'Sermon revision is invalid.');
    }
    if (
      options.expectedRevision !== null
      && (
        options.expectedRevision === undefined
        || typeof options.expectedRevision !== 'string'
        || !REVISION_PATTERN.test(options.expectedRevision || '')
      )
    ) {
      fail(
        'INVALID_LIBRARY_REVISION',
        'Promoting a sermon revision requires its current expected revision.'
      );
    }

    return withExclusiveFileLock(path.join(this.rootPath, '.library-write-lock'), async () => {
      const sermonDirectory = this._sermonDirectory(sermonId);
      if (!await this._existingConfinedDirectory(sermonDirectory)) {
        fail('SERMON_NOT_FOUND', `Sermon ${sermonId} is not in the local library.`, {
          sermonId
        });
      }
      return withExclusiveFileLock(path.join(sermonDirectory, '.write-lock'), async () => {
        const current = await this._readPointer(sermonId);
        const actualRevision = current?.revision || null;
        if (actualRevision !== options.expectedRevision) {
          fail('SERMON_CONFLICT', `Sermon ${sermonId} changed before promotion.`, {
            sermonId,
            expectedRevision: options.expectedRevision,
            currentRevision: actualRevision
          });
        }
        if (actualRevision === revision) {
          return {
            ...(await this._readRevision(sermonId, revision, current.updatedAt)),
            unchanged: true
          };
        }

        await this._readRevision(sermonId, revision);
        const updatedAt = this.clock().toISOString();
        await atomicWriteFile(
          path.join(sermonDirectory, 'current.json'),
          `${JSON.stringify({
            schemaVersion: POINTER_SCHEMA_VERSION,
            sermonId,
            revision,
            updatedAt
          }, null, 2)}\n`,
          {
            maximumBytes: MAX_POINTER_BYTES,
            mode: 0o600,
            rootPath: this.rootPath
          }
        );
        return {
          ...(await this._readRevision(sermonId, revision, updatedAt)),
          unchanged: false
        };
      });
    });
  }

  async save(value, options = {}) {
    if (typeof value === 'string' || Buffer.isBuffer(value)) {
      return this.saveSource(value, options);
    }
    return this.saveDocument(value, options);
  }

  async _listPage(options = {}) {
    const query = String(options.query || '').trim();
    if (query.length > MAX_QUERY_LENGTH) {
      fail(
        'QUERY_TOO_LONG',
        `Library search must be ${MAX_QUERY_LENGTH} characters or fewer.`
      );
    }
    const pageSize = Math.max(
      1,
      Math.min(MAX_PAGE_SIZE, Number.isSafeInteger(options.pageSize) ? options.pageSize : 50)
    );
    const offset = Math.max(0, Number.isSafeInteger(options.offset) ? options.offset : 0);
    const tokens = query.toLowerCase().split(/\s+/).filter(Boolean);
    const entries = await fs.readdir(this.rootPath, { withFileTypes: true });
    const sermonEntries = entries.filter(entry =>
      entry.isDirectory()
      && !entry.isSymbolicLink?.()
      && SERMON_DIRECTORY_PATTERN.test(entry.name));
    if (sermonEntries.length > MAX_LIBRARY_SERMONS) {
      fail(
        'LIBRARY_TOO_LARGE',
        `The local library can contain at most ${MAX_LIBRARY_SERMONS} sermons.`
      );
    }

    const results = [];
    for (const entry of sermonEntries) {
      const sermonDirectory = path.join(this.rootPath, entry.name);
      const pointerPath = path.join(sermonDirectory, 'current.json');
      try {
        if (!await this._existingConfinedDirectory(sermonDirectory)) continue;
        const { buffer } = await readFileNoFollow(pointerPath, MAX_POINTER_BYTES);
        const pointer = JSON.parse(decodeUtf8(buffer, 'Sermon pointer'));
        if (
          pointer.schemaVersion !== POINTER_SCHEMA_VERSION
          || typeof pointer.sermonId !== 'string'
          || sermonIdStorageKey(pointer.sermonId) !== entry.name
          || !REVISION_PATTERN.test(pointer.revision || '')
          || !isCanonicalTimestamp(pointer.updatedAt)
        ) {
          continue;
        }
        const item = await this._readRevision(
          pointer.sermonId,
          pointer.revision,
          pointer.updatedAt
        );
        const sermon = item.sermon;
        if (
          tokens.every(token => searchableText(sermon).includes(token))
          && (!options.language || Object.hasOwn(sermon.titles, options.language))
          && (!options.speakerId || sermon.speaker.id === options.speakerId)
          && (!options.publicationStatus
            || sermon.publication.status === options.publicationStatus)
          && (!options.visibility || sermon.publication.visibility === options.visibility)
        ) {
          results.push(item.summary);
        }
      } catch (_error) {
        // Keep damaged entries untouched for an explicit diagnostics/recovery
        // flow. Browsing the rest of the library must remain available.
      }
    }

    results.sort((left, right) => (
      right.serviceDate.localeCompare(left.serviceDate)
      || left.title.localeCompare(right.title, 'en', { sensitivity: 'base' })
      || left.id.localeCompare(right.id)
    ));
    return {
      items: results.slice(offset, offset + pageSize),
      total: results.length,
      offset,
      nextOffset: offset + pageSize < results.length ? offset + pageSize : null
    };
  }

  async list(options = {}) {
    await this.initialize();
    return this._listPage(options);
  }

  async collectSourceObjectReferences(options = {}) {
    const maximumFiles = referenceScanCapacity(
      options.maximumFiles,
      MAX_REFERENCE_SCAN_FILES,
      MAX_REFERENCE_SCAN_FILES,
      'maximumFiles'
    );
    const maximumBytes = referenceScanCapacity(
      options.maximumBytes,
      MAX_REFERENCE_SCAN_BYTES,
      MAX_REFERENCE_SCAN_BYTES,
      'maximumBytes'
    );
    await this.initialize();
    return withExclusiveFileLock(
      path.join(this.rootPath, '.library-write-lock'),
      async () => {
        let rootEntries;
        try {
          rootEntries = await fs.readdir(this.rootPath, { withFileTypes: true });
        } catch (_error) {
          fail('REFERENCE_SCAN_INCOMPLETE', 'The sermon library reference scan could not be completed.');
        }
        rootEntries.sort((left, right) => left.name.localeCompare(right.name));
        const sermonEntries = [];
        for (const entry of rootEntries) {
          if (entry.name === '.library-write-lock') {
            if (!entry.isDirectory() || entry.isSymbolicLink?.()) {
              fail('REFERENCE_SCAN_AMBIGUOUS', 'The sermon library contains unsafe maintenance state.');
            }
            continue;
          }
          if (
            !SERMON_DIRECTORY_PATTERN.test(entry.name)
            || !entry.isDirectory()
            || entry.isSymbolicLink?.()
          ) {
            fail('REFERENCE_SCAN_AMBIGUOUS', 'The sermon library contains an unsupported entry.');
          }
          sermonEntries.push(entry);
        }
        if (sermonEntries.length > MAX_LIBRARY_SERMONS) {
          fail('REFERENCE_SCAN_LIMIT', 'The sermon library exceeds the bounded reference scan.');
        }

        const digests = new Set();
        let filesScanned = 0;
        let bytesScanned = 0;
        let revisionsScanned = 0;
        const accountFile = stats => {
          if (!stats.isFile() || stats.isSymbolicLink()) {
            fail('REFERENCE_SCAN_AMBIGUOUS', 'The sermon library contains an unsafe reference file.');
          }
          if (
            filesScanned + 1 > maximumFiles
            || bytesScanned + stats.size > maximumBytes
          ) {
            fail('REFERENCE_SCAN_LIMIT', 'The sermon library exceeds the bounded reference scan.');
          }
          filesScanned += 1;
          bytesScanned += stats.size;
        };

        for (const entry of sermonEntries) {
          const sermonDirectory = path.join(this.rootPath, entry.name);
          try {
            await ensureConfinedDirectory(this.rootPath, sermonDirectory);
          } catch (_error) {
            fail('REFERENCE_SCAN_AMBIGUOUS', 'The sermon library contains an unsafe directory.');
          }
          let children;
          try {
            children = await fs.readdir(sermonDirectory, { withFileTypes: true });
          } catch (_error) {
            fail('REFERENCE_SCAN_INCOMPLETE', 'The sermon library reference scan could not be completed.');
          }
          let pointerEntry = null;
          let versionsEntry = null;
          for (const child of children) {
            if (child.name === 'current.json') {
              if (pointerEntry) fail('REFERENCE_SCAN_AMBIGUOUS', 'The sermon library pointer inventory is ambiguous.');
              pointerEntry = child;
            } else if (child.name === 'versions') {
              if (versionsEntry) fail('REFERENCE_SCAN_AMBIGUOUS', 'The sermon library version inventory is ambiguous.');
              versionsEntry = child;
            } else if (child.name === '.write-lock') {
              if (!child.isDirectory() || child.isSymbolicLink?.()) {
                fail('REFERENCE_SCAN_AMBIGUOUS', 'The sermon library contains unsafe maintenance state.');
              }
            } else {
              fail('REFERENCE_SCAN_AMBIGUOUS', 'The sermon library contains an unsupported entry.');
            }
          }
          if (
            !versionsEntry
            || !versionsEntry.isDirectory()
            || versionsEntry.isSymbolicLink?.()
          ) {
            fail('REFERENCE_SCAN_AMBIGUOUS', 'The sermon library version inventory is incomplete.');
          }
          const versionsDirectory = path.join(sermonDirectory, 'versions');
          try {
            await ensureConfinedDirectory(this.rootPath, versionsDirectory);
          } catch (_error) {
            fail('REFERENCE_SCAN_AMBIGUOUS', 'The sermon library version inventory is unsafe.');
          }
          let versionEntries;
          try {
            versionEntries = await fs.readdir(versionsDirectory, { withFileTypes: true });
          } catch (_error) {
            fail('REFERENCE_SCAN_INCOMPLETE', 'The sermon library reference scan could not be completed.');
          }
          versionEntries.sort((left, right) => left.name.localeCompare(right.name));
          if (versionEntries.length === 0) {
            fail('REFERENCE_SCAN_AMBIGUOUS', 'The sermon library contains an empty version inventory.');
          }
          if (versionEntries.length > maximumFiles - filesScanned) {
            fail('REFERENCE_SCAN_LIMIT', 'The sermon library exceeds the bounded reference scan.');
          }
          const revisionIds = new Set();
          let sermonId = null;
          for (const versionEntry of versionEntries) {
            const match = /^([a-f0-9]{64})\.json$/.exec(versionEntry.name);
            if (!match || !versionEntry.isFile() || versionEntry.isSymbolicLink?.()) {
              fail('REFERENCE_SCAN_AMBIGUOUS', 'The sermon library contains an unsupported revision entry.');
            }
            const revisionPath = path.join(versionsDirectory, versionEntry.name);
            let stats;
            let buffer;
            try {
              stats = await fs.lstat(revisionPath);
              accountFile(stats);
              ({ buffer } = await readFileNoFollow(revisionPath, MAX_SERMON_SOURCE_BYTES));
            } catch (error) {
              if (error instanceof SermonLibraryError) throw error;
              fail('REFERENCE_SCAN_INCOMPLETE', 'The sermon library revision scan could not be completed.');
            }
            if (sourceRevision(buffer) !== match[1]) {
              fail('REFERENCE_SCAN_CORRUPT', 'A sermon library revision failed its checksum.');
            }
            let sermon;
            try {
              sermon = parseSermonDocument(decodeUtf8(buffer, 'Stored sermon revision'));
            } catch (_error) {
              fail('REFERENCE_SCAN_CORRUPT', 'A sermon library revision failed validation.');
            }
            if (
              !Buffer.from(serializeSermonDocument(sermon), 'utf8').equals(buffer)
              || sermonIdStorageKey(sermon.id) !== entry.name
              || (sermonId !== null && sermon.id !== sermonId)
            ) {
              fail('REFERENCE_SCAN_CORRUPT', 'A sermon library revision is not canonical for its storage identity.');
            }
            sermonId = sermon.id;
            revisionIds.add(match[1]);
            revisionsScanned += 1;
            for (const source of sermon.sources) digests.add(source.sha256);
          }

          if (pointerEntry) {
            if (!pointerEntry.isFile() || pointerEntry.isSymbolicLink?.()) {
              fail('REFERENCE_SCAN_AMBIGUOUS', 'The sermon library pointer is unsafe.');
            }
            const pointerPath = path.join(sermonDirectory, 'current.json');
            let pointer;
            let pointerBuffer;
            try {
              const stats = await fs.lstat(pointerPath);
              accountFile(stats);
              ({ buffer: pointerBuffer } = await readFileNoFollow(
                pointerPath,
                MAX_POINTER_BYTES
              ));
              pointer = JSON.parse(decodeUtf8(pointerBuffer, 'Stored sermon pointer'));
            } catch (error) {
              if (error instanceof SermonLibraryError) throw error;
              fail('REFERENCE_SCAN_CORRUPT', 'A sermon library pointer failed validation.');
            }
            if (
              !pointer
              || Object.keys(pointer).length !== 4
              || pointer.schemaVersion !== POINTER_SCHEMA_VERSION
              || pointer.sermonId !== sermonId
              || !REVISION_PATTERN.test(pointer.revision || '')
              || !revisionIds.has(pointer.revision)
              || !isCanonicalTimestamp(pointer.updatedAt)
              || !pointerBuffer.equals(
                Buffer.from(`${JSON.stringify({
                  schemaVersion: pointer.schemaVersion,
                  sermonId: pointer.sermonId,
                  revision: pointer.revision,
                  updatedAt: pointer.updatedAt
                }, null, 2)}\n`, 'utf8')
              )
            ) {
              fail('REFERENCE_SCAN_CORRUPT', 'A sermon library pointer is inconsistent.');
            }
          }
        }

        return Object.freeze({
          digests: Object.freeze([...digests].sort()),
          sermonCount: sermonEntries.length,
          revisionCount: revisionsScanned,
          filesScanned,
          bytesScanned
        });
      }
    );
  }
}

module.exports = {
  LocalSermonLibrary,
  MAX_PAGE_SIZE,
  MAX_REFERENCE_SCAN_FILES,
  SermonLibraryError,
  sermonIdStorageKey
};
