'use strict';

const crypto = require('crypto');
const fs = require('fs/promises');
const path = require('path');
const { TextDecoder } = require('util');

const {
  MAX_SOURCE_BYTES,
  compareSongSections,
  parseSongDocument,
  serializeSongDocument
} = require('./SongDocument');
const {
  MAX_FAMILY_DOCUMENTS,
  compareCanonicalText,
  songFamilyRevision
} = require('./SongFamilyRevision');
const {
  FAMILY_JOURNAL_FILE,
  DurableFamilyJournal
} = require('./DurableFamilyJournal');
const {
  atomicWriteFile,
  ensureConfinedDirectory,
  ensurePrivateDirectory,
  hashFileNoFollow,
  readFileNoFollow,
  withExclusiveFileLock
} = require('./StorageSafety');

const POINTER_SCHEMA_VERSION = 1;
const MAX_POINTER_BYTES = 64 * 1024;
const PENDING_FAMILY_JOURNAL_FILE = FAMILY_JOURNAL_FILE;
const SONG_DIRECTORY_PATTERN = /^song-[a-f0-9]{64}$/;
const REVISION_PATTERN = /^[a-f0-9]{64}$/;
const MAX_LIBRARY_SONGS = 10000;
const MAX_QUERY_LENGTH = 120;
const MAX_PAGE_SIZE = 100;
const MAX_AUTHORED_ATTRIBUTION_LENGTH = 500;
const SONG_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const FAMILY_JOURNALS = new WeakMap();
const FAMILY_RECOVERY_AUTHORITIES = new WeakMap();

class SongLibraryError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'SongLibraryError';
    this.code = code;
    this.details = details;
  }
}

function fail(code, message, details = {}) {
  throw new SongLibraryError(code, message, details);
}

function idStorageKey(songId) {
  return `song-${crypto.createHash('sha256').update(String(songId)).digest('hex')}`;
}

function sourceRevision(source) {
  return crypto.createHash('sha256').update(source).digest('hex');
}

function familySnapshotHash(familyId, documents) {
  return crypto.createHash('sha256')
    .update(JSON.stringify([
      familyId,
      documents.map(document => [
        document.songId,
        document.revision,
        document.translationOf
      ])
    ]))
    .digest('hex');
}

function sameFamilySnapshot(left, right) {
  return left.familyId === right.familyId
    && left.snapshotHash === right.snapshotHash
    && left.familyRevision === right.familyRevision
    && left.documents.length === right.documents.length
    && left.documents.every((document, index) => {
      const candidate = right.documents[index];
      return document.songId === candidate.songId
        && document.revision === candidate.revision
        && document.translationOf === candidate.translationOf;
    });
}

function forkSongId(songId, number) {
  const ordinarySuffix = `-local-${number}`;
  if (songId.length + ordinarySuffix.length <= 128) return `${songId}${ordinarySuffix}`;
  const hash = crypto.createHash('sha256').update(songId).digest('hex').slice(0, 10);
  const boundedSuffix = `-${hash}-local-${number}`;
  const prefix = songId
    .slice(0, 128 - boundedSuffix.length)
    .replace(/[._:-]+$/g, '');
  return `${prefix || songId[0]}${boundedSuffix}`;
}

function summary(song, revision, updatedAt) {
  return {
    id: song.id,
    title: song.title,
    language: song.language,
    translationOf: song.translationOf,
    license: song.license,
    attribution: song.attribution,
    source: song.source,
    tags: [...song.tags],
    authors: [...song.authors],
    translators: [...song.translators],
    composers: [...song.composers],
    sectionCount: song.sections.length,
    sectionIds: song.sections.map(section => section.id),
    revision,
    updatedAt
  };
}

class LocalSongLibrary {
  constructor(options = {}) {
    if (typeof options.rootPath !== 'string' || !path.isAbsolute(options.rootPath)) {
      throw new TypeError('LocalSongLibrary requires an absolute rootPath');
    }
    this.rootPath = path.resolve(options.rootPath);
    this.clock = options.clock || (() => new Date());
    if (
      options.familyRecoveryAuthority !== undefined
      && typeof options.familyRecoveryAuthority !== 'symbol'
    ) {
      throw new TypeError(
        'LocalSongLibrary familyRecoveryAuthority must be a Symbol'
      );
    }
    FAMILY_RECOVERY_AUTHORITIES.set(
      this,
      options.familyRecoveryAuthority || null
    );
    FAMILY_JOURNALS.set(this, new DurableFamilyJournal({
      rootPath: this.rootPath
    }));
    this.operationTail = Promise.resolve();
  }

  async initialize() {
    this.rootPath = await ensurePrivateDirectory(this.rootPath);
    return this;
  }

  _songDirectory(songId) {
    return path.join(this.rootPath, idStorageKey(songId));
  }

  async _assertNoPendingFamilyJournal() {
    try {
      const active = await FAMILY_JOURNALS.get(this).read();
      if (active.clear) return;
    } catch (error) {
      if (error instanceof SongLibraryError) throw error;
      fail(
        'SONG_FAMILY_RECOVERY_REQUIRED',
        'The pending song-family transaction could not be checked safely.',
        { cause: error.code || error.name || 'journal-check-failed' }
      );
    }
    fail(
      'SONG_FAMILY_RECOVERY_REQUIRED',
      'Finish recovering the pending song-family transaction before using the current library.'
    );
  }

  #withExclusiveSession(
    operation,
    { allowPendingFamily = false, familyCommit = false } = {}
  ) {
    const pending = this.operationTail.then(async () => {
      await this.initialize();
      return withExclusiveFileLock(
        path.join(this.rootPath, '.library-write-lock'),
        async () => {
          if (!allowPendingFamily) await this._assertNoPendingFamilyJournal();
          return operation(
            familyCommit
              ? this.#familyCommitSession()
              : this.#currentSnapshotSession()
          );
        },
        { reclaimDeadOwner: true }
      );
    });
    this.operationTail = pending.then(
      () => undefined,
      () => undefined
    );
    return pending;
  }

  async withCurrentSnapshot(operation) {
    if (typeof operation !== 'function') {
      throw new TypeError(
        'LocalSongLibrary current snapshot requires an operation'
      );
    }
    return this.#withExclusiveSession(operation);
  }

  async withFamilyCommitSession(
    operation,
    { recoveryAuthority } = {}
  ) {
    if (typeof operation !== 'function') {
      throw new TypeError(
        'LocalSongLibrary family commit session requires an operation'
      );
    }
    if (
      FAMILY_RECOVERY_AUTHORITIES.get(this) === null
      || typeof recoveryAuthority !== 'symbol'
      || recoveryAuthority !== FAMILY_RECOVERY_AUTHORITIES.get(this)
    ) {
      throw new TypeError(
        'LocalSongLibrary family commit recovery authority is invalid'
      );
    }
    return this.#withExclusiveSession(operation, {
      allowPendingFamily: true,
      familyCommit: true
    });
  }

  #currentSnapshotSession() {
    return Object.freeze({
      readCurrent: async rawSongId => {
        const songId = this._expectedSongId(rawSongId);
        const pointer = await this._readPointer(songId);
        return pointer
          ? this._readRevision(songId, pointer.revision, pointer.updatedAt)
          : null;
      },
      readRevision: async (rawSongId, revision) =>
        this._readRevision(this._expectedSongId(rawSongId), revision),
      listCurrent: async () => {
        const summaries = await this._listAll({}, { strict: true });
        const documents = [];
        for (const item of summaries) {
          documents.push(await this._readRevision(
            item.id,
            item.revision,
            item.updatedAt
          ));
        }
        return documents;
      },
      snapshotFamily: familyId =>
        this.#snapshotFamilyUnderLibraryLock(familyId)
    });
  }

  #familyCommitSession() {
    return Object.freeze({
      ...this.#currentSnapshotSession(),
      stageFamily: request =>
        this.#stageFamilyUnderLibraryLock(request),
      stageSource: (source, options = {}) =>
        this.#stageSourceUnderLibraryLock(source, options),
      promoteRevision: (songId, revision, options = {}) =>
        this.#promoteRevisionUnderLibraryLock(songId, revision, options)
    });
  }

  async _readPointer(songId) {
    const songDirectory = this._songDirectory(songId);
    const pointerPath = path.join(songDirectory, 'current.json');
    let payload;
    try {
      const { buffer } = await readFileNoFollow(pointerPath, MAX_POINTER_BYTES);
      payload = JSON.parse(buffer.toString('utf8'));
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      fail('LIBRARY_POINTER_INVALID', `The saved pointer for ${songId} is unreadable.`, { songId, cause: error.message });
    }
    if (!payload
      || payload.schemaVersion !== POINTER_SCHEMA_VERSION
      || payload.songId !== songId
      || !REVISION_PATTERN.test(payload.revision || '')
      || Object.keys(payload).sort().join(',') !==
        'revision,schemaVersion,songId,updatedAt'
      || typeof payload.updatedAt !== 'string'
      || payload.updatedAt.length > 40
      || Number.isNaN(Date.parse(payload.updatedAt))
      || new Date(payload.updatedAt).toISOString() !== payload.updatedAt) {
      fail('LIBRARY_POINTER_INVALID', `The saved pointer for ${songId} is invalid.`, { songId });
    }
    return payload;
  }

  async _readRevision(songId, revision, updatedAt = null) {
    if (!REVISION_PATTERN.test(revision || '')) fail('INVALID_LIBRARY_REVISION', 'Song revision is invalid.');
    const filePath = path.join(this._songDirectory(songId), 'versions', `${revision}.md`);
    let buffer;
    try {
      ({ buffer } = await readFileNoFollow(filePath, MAX_SOURCE_BYTES));
    } catch (error) {
      fail('LIBRARY_REVISION_MISSING', `${songId} revision ${revision.slice(0, 8)} is unavailable.`, {
        songId,
        revision,
        cause: error.message
      });
    }
    const actualRevision = crypto.createHash('sha256').update(buffer).digest('hex');
    if (actualRevision !== revision) fail('LIBRARY_REVISION_CORRUPT', `${songId} no longer matches its saved checksum.`);
    let source;
    try {
      source = new TextDecoder('utf-8', { fatal: true }).decode(buffer);
    } catch (_error) {
      fail('INVALID_UTF8', `${songId} is not valid UTF-8 text.`);
    }
    const song = parseSongDocument(source, { fileName: `${songId}.md` });
    if (song.id !== songId) fail('LIBRARY_ID_MISMATCH', `Stored song ${songId} contains id ${song.id}.`);
    return {
      song,
      source,
      documentSource: source,
      revision,
      updatedAt: updatedAt || null,
      summary: summary(song, revision, updatedAt)
    };
  }

  _expectedSongId(value) {
    if (typeof value !== 'string' || !SONG_ID_PATTERN.test(value)) {
      fail('INVALID_SONG_ID', 'The song identity being edited is invalid.');
    }
    return value;
  }

  async _listAll(options = {}, { strict = false } = {}) {
    const items = [];
    let offset = 0;
    while (true) {
      let page;
      try {
        page = await this._listPage({
          ...options,
          pageSize: MAX_PAGE_SIZE,
          offset
        }, { strict });
      } catch (error) {
        if (!strict && error.code === 'ENOENT') return items;
        throw error;
      }
      items.push(...page.items);
      if (page.nextOffset === null) return items;
      offset = page.nextOffset;
    }
  }

  async _directTranslations(songId) {
    return this._listAll({ translationOf: songId });
  }

  async _resolveTranslationRoot(song) {
    if (!song.translationOf) return null;
    if (song.translationOf === song.id) {
      fail('TRANSLATION_SELF_REFERENCE', `${song.title} cannot be a translation of itself.`, {
        songId: song.id
      });
    }

    const requestedTargetId = song.translationOf;
    const visited = new Set([song.id]);
    let targetId = requestedTargetId;
    let target = null;
    while (targetId) {
      if (visited.has(targetId)) {
        fail('TRANSLATION_CYCLE', `${song.title} has a circular translation relationship.`, {
          songId: song.id,
          targetId,
          chain: [...visited, targetId]
        });
      }
      visited.add(targetId);
      const pointer = await this._readPointer(targetId);
      if (!pointer) {
        fail(
          'TRANSLATION_TARGET_NOT_FOUND',
          `The original song “${targetId}” is not in the local library.`,
          { songId: song.id, targetId }
        );
      }
      try {
        target = await this._readRevision(targetId, pointer.revision, pointer.updatedAt);
      } catch (error) {
        if (error instanceof SongLibraryError) throw error;
        fail(
          'TRANSLATION_TARGET_UNAVAILABLE',
          `The original song “${targetId}” could not be opened.`,
          { songId: song.id, targetId, cause: error.message }
        );
      }
      targetId = target.song.translationOf;
    }
    return {
      requestedTargetId,
      root: target
    };
  }

  async _inspectRelationship(rawSong) {
    let song = rawSong;
    const warnings = [];
    if (!song.translationOf) {
      const translations = await this._directTranslations(song.id);
      const incompatibleTranslations = [];
      for (const candidate of translations) {
        try {
          const translated = await this._readRevision(candidate.id, candidate.revision, candidate.updatedAt);
          const alignment = compareSongSections(song, translated.song);
          if (!alignment.compatible) {
            incompatibleTranslations.push({
              id: translated.song.id,
              title: translated.song.title,
              revision: translated.revision,
              ...alignment
            });
          }
        } catch (_error) {
          // Listing already omits unreadable entries. If an entry changes
          // between listing and comparison, leave it for diagnostics rather
          // than making an unrelated original-song edit destructive.
        }
      }
      if (incompatibleTranslations.length > 0) {
        warnings.push({
          code: 'TRANSLATIONS_MAY_NEED_ALIGNMENT',
          message: `${incompatibleTranslations.length} current translation${incompatibleTranslations.length === 1 ? '' : 's'} no longer match this section and slide structure.`,
          translations: incompatibleTranslations
        });
      }
      return {
        song,
        relationship: {
          kind: 'original',
          familyId: song.id,
          compatible: incompatibleTranslations.length === 0,
          translationCount: translations.length,
          warnings
        }
      };
    }

    const children = await this._directTranslations(song.id);
    if (children.length > 0) {
      fail(
        'TRANSLATION_ROOT_HAS_CHILDREN',
        `${song.title} cannot become a translation while other songs use it as their original.`,
        {
          songId: song.id,
          translations: children.map(item => ({ id: item.id, title: item.title, revision: item.revision }))
        }
      );
    }

    const resolved = await this._resolveTranslationRoot(song);
    const root = resolved.root;
    if (song.translationOf !== root.song.id) {
      song = parseSongDocument(serializeSongDocument({
        ...song,
        translationOf: root.song.id
      }), { fileName: `${song.id}.md` });
    }
    const alignment = compareSongSections(root.song, song);
    if (!alignment.compatible) {
      warnings.push({
        code: 'TRANSLATION_STRUCTURE_MISMATCH',
        message: `${song.title} is saved as a draft, but it cannot be linked until its sections and slide breaks match ${root.song.title}.`,
        ...alignment
      });
    }
    return {
      song,
      relationship: {
        kind: 'translation',
        familyId: root.song.id,
        requestedTargetId: resolved.requestedTargetId,
        normalizedFrom: resolved.requestedTargetId === root.song.id
          ? null
          : resolved.requestedTargetId,
        target: root.summary,
        compatible: alignment.compatible,
        alignment,
        warnings
      }
    };
  }

  async _validateAuthoredAttribution(song, options = {}) {
    if (song.attribution.length <= MAX_AUTHORED_ATTRIBUTION_LENGTH) return;

    // Schema-v1 previously accepted attribution as 2,048-character custom
    // metadata. Let an editor preserve an unchanged legacy credit while
    // requiring every new or changed credit to use the focused authoring
    // bound.
    if (options.expectedSongId === song.id) {
      const pointer = await this._readPointer(song.id);
      if (pointer) {
        const current = await this._readRevision(song.id, pointer.revision, pointer.updatedAt);
        if (current.song.attribution === song.attribution) return;
      }
    }
    fail(
      'ATTRIBUTION_TOO_LONG',
      `Song attribution must be ${MAX_AUTHORED_ATTRIBUTION_LENGTH} characters or fewer.`,
      {
        maximum: MAX_AUTHORED_ATTRIBUTION_LENGTH,
        actual: song.attribution.length
      }
    );
  }

  async _validateSourceUnderLibraryLock(source, options = {}) {
    let song = parseSongDocument(source, { fileName: options.fileName || 'song.md' });
    if (options.expectedSongId !== undefined && options.expectedSongId !== null) {
      const expectedSongId = this._expectedSongId(options.expectedSongId);
      if (song.id !== expectedSongId) {
        fail(
          'SONG_ID_CHANGED',
          `This edit belongs to ${expectedSongId}; its saved song id cannot be changed to ${song.id}.`,
          { expectedSongId, actualSongId: song.id }
        );
      }
    }
    await this._validateAuthoredAttribution(song, options);

    const inspected = await this._inspectRelationship(song);
    const documentSource = serializeSongDocument(inspected.song);
    song = parseSongDocument(documentSource, { fileName: `${inspected.song.id}.md` });
    const revision = sourceRevision(documentSource);
    return {
      song,
      source: documentSource,
      documentSource,
      revision,
      updatedAt: null,
      summary: summary(song, revision, null),
      relationship: inspected.relationship
    };
  }

  async validateSource(source, options = {}) {
    // Keep validation read-only for a brand-new library. Once current
    // relationships exist, validation shares the same gate as mutations so it
    // cannot inspect a partially recovered multi-song family transaction.
    try {
      const stats = await fs.lstat(this.rootPath);
      if (!stats.isDirectory() || stats.isSymbolicLink()) {
        fail('LIBRARY_UNAVAILABLE', 'The local song library directory is unsafe.');
      }
    } catch (error) {
      if (error.code === 'ENOENT') {
        return this._validateSourceUnderLibraryLock(source, options);
      }
      throw error;
    }
    return this.#withExclusiveSession(() =>
      this._validateSourceUnderLibraryLock(source, options));
  }

  async read(songId, options = {}) {
    await this.initialize();
    if (options.revision !== undefined && options.revision !== null) {
      return this._readRevision(songId, options.revision);
    }
    return this.#withExclusiveSession(async session => {
      const current = await session.readCurrent(songId);
      if (!current) {
        fail('SONG_NOT_FOUND', `Song ${songId} is not in the local library.`, {
          songId
        });
      }
      return current;
    });
  }

  async saveSource(source, options = {}) {
    return this.#withExclusiveSession(() =>
      this.#saveSourceUnderLibraryLock(source, options));
  }

  async #saveSourceUnderLibraryLock(source, options = {}) {
    if (options.expectedSongId !== undefined
      && options.expectedSongId !== null
      && options.onConflict === 'fork') {
      fail(
        'INVALID_SAVE_MODE',
        'An opened song must be saved through revision checking; only an explicit import may fork automatically.'
      );
    }
    let validated = await this._validateSourceUnderLibraryLock(source, {
      fileName: options.fileName || 'song.md',
      expectedSongId: options.expectedSongId
    });
    let song = validated.song;
    let canonical = validated.documentSource;
    let revision = validated.revision;
    let relationship = validated.relationship;
    let songId = song.id;
    let forked = false;

    const existing = await this._readPointer(songId);
    if (existing && existing.revision !== revision && options.onConflict === 'fork') {
      let suffix = 2;
      while (await this._readPointer(forkSongId(song.id, suffix))) suffix += 1;
      songId = forkSongId(song.id, suffix);
      forked = true;
      validated = await this._validateSourceUnderLibraryLock(
        serializeSongDocument({ ...song, id: songId }), {
        fileName: `${songId}.md`,
        expectedSongId: songId
        }
      );
      song = validated.song;
      canonical = validated.documentSource;
      revision = validated.revision;
      relationship = validated.relationship;
    } else if (existing && existing.revision !== revision && options.expectedRevision === undefined) {
      fail(
        'SONG_CONFLICT',
        `${song.title} already exists. Open it before replacing it, or save this import as a new local version.`,
        { songId, currentRevision: existing.revision }
      );
    }

    const songDirectory = this._songDirectory(songId);
    await ensureConfinedDirectory(this.rootPath, path.join(songDirectory, 'versions'));
    return withExclusiveFileLock(path.join(songDirectory, '.write-lock'), async () => {
      const current = await this._readPointer(songId);
      if (forked && current) {
        fail(
          'SONG_FORK_CONFLICT',
          'Another import claimed the generated local song identity. Import the file again.',
          { songId, currentRevision: current.revision }
        );
      }
      if (options.expectedRevision !== undefined) {
        const expected = options.expectedRevision || null;
        const actual = current?.revision || null;
        if (expected !== actual) {
          fail('SONG_CONFLICT', `${song.title} changed since it was opened.`, {
            songId,
            expectedRevision: expected,
            currentRevision: actual
          });
        }
      }
      if (current?.revision === revision) {
        return {
          ...(await this._readRevision(songId, revision, current.updatedAt)),
          relationship,
          forked,
          unchanged: true
        };
      }

      const revisionPath = path.join(songDirectory, 'versions', `${revision}.md`);
      try {
        const existingHash = await hashFileNoFollow(revisionPath, MAX_SOURCE_BYTES);
        if (existingHash !== revision) fail('LIBRARY_REVISION_CORRUPT', 'An immutable song revision has changed.');
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
        await atomicWriteFile(revisionPath, canonical, {
          maximumBytes: MAX_SOURCE_BYTES,
          mode: 0o600,
          rootPath: this.rootPath
        });
      }

      const updatedAt = this.clock().toISOString();
      const pointer = {
        schemaVersion: POINTER_SCHEMA_VERSION,
        songId,
        revision,
        updatedAt
      };
      await atomicWriteFile(path.join(songDirectory, 'current.json'), `${JSON.stringify(pointer, null, 2)}\n`, {
        maximumBytes: MAX_POINTER_BYTES,
        mode: 0o600,
        rootPath: this.rootPath
      });
      return {
        ...(await this._readRevision(songId, revision, updatedAt)),
        relationship,
        forked,
        unchanged: false
      };
    }, { reclaimDeadOwner: true });
  }

  async #stageSourceUnderLibraryLock(source, options = {}) {
    const expectedSongId = this._expectedSongId(options.expectedSongId);
    let song = parseSongDocument(source, {
      fileName: options.fileName || `${expectedSongId}.md`
    });
    if (song.id !== expectedSongId) {
      fail(
        'SONG_ID_CHANGED',
        `This reviewed song belongs to ${expectedSongId}; its song id cannot change to ${song.id}.`,
        { expectedSongId, actualSongId: song.id }
      );
    }
    await this._validateAuthoredAttribution(song, {
      expectedSongId
    });
    const canonical = serializeSongDocument(song);
    song = parseSongDocument(canonical, { fileName: `${song.id}.md` });
    const revision = sourceRevision(canonical);
    const songDirectory = this._songDirectory(song.id);
    await ensureConfinedDirectory(
      this.rootPath,
      path.join(songDirectory, 'versions')
    );
    return withExclusiveFileLock(path.join(songDirectory, '.write-lock'), async () => {
      const revisionPath = path.join(
        songDirectory,
        'versions',
        `${revision}.md`
      );
      try {
        const existingHash = await hashFileNoFollow(
          revisionPath,
          MAX_SOURCE_BYTES
        );
        if (existingHash !== revision) {
          fail(
            'LIBRARY_REVISION_CORRUPT',
            'An immutable song revision has changed.'
          );
        }
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
        await atomicWriteFile(revisionPath, canonical, {
          maximumBytes: MAX_SOURCE_BYTES,
          mode: 0o600,
          rootPath: this.rootPath
        });
      }
      return {
        song,
        source: canonical,
        documentSource: canonical,
        revision,
        updatedAt: null,
        summary: summary(song, revision, null)
      };
    }, { reclaimDeadOwner: true });
  }

  async #promoteRevisionUnderLibraryLock(
    rawSongId,
    revision,
    options = {}
  ) {
    const songId = this._expectedSongId(rawSongId);
    if (!REVISION_PATTERN.test(revision || '')) {
      fail('INVALID_LIBRARY_REVISION', 'Song revision is invalid.');
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
        'Promoting a song revision requires its current expected revision.'
      );
    }
    const songDirectory = this._songDirectory(songId);
    await ensureConfinedDirectory(
      this.rootPath,
      path.join(songDirectory, 'versions')
    );
    return withExclusiveFileLock(path.join(songDirectory, '.write-lock'), async () => {
      const current = await this._readPointer(songId);
      const actualRevision = current?.revision || null;
      if (actualRevision !== options.expectedRevision) {
        fail('SONG_CONFLICT', `Song ${songId} changed before promotion.`, {
          songId,
          expectedRevision: options.expectedRevision,
          currentRevision: actualRevision
        });
      }
      if (actualRevision === revision) {
        return {
          ...(await this._readRevision(songId, revision, current.updatedAt)),
          unchanged: true
        };
      }
      await this._readRevision(songId, revision);
      const updatedAt = options.updatedAt || this.clock().toISOString();
      const pointer = {
        schemaVersion: POINTER_SCHEMA_VERSION,
        songId,
        revision,
        updatedAt
      };
      await atomicWriteFile(
        path.join(songDirectory, 'current.json'),
        `${JSON.stringify(pointer, null, 2)}\n`,
        {
          maximumBytes: MAX_POINTER_BYTES,
          mode: 0o600,
          rootPath: this.rootPath
        }
      );
      return {
        ...(await this._readRevision(songId, revision, updatedAt)),
        unchanged: false
      };
    }, { reclaimDeadOwner: true });
  }

  async #snapshotFamilyUnderLibraryLock(rawFamilyId) {
    const familyId = this._expectedSongId(rawFamilyId);
    const current = await this._listAll({}, { strict: true });
    const documents = current
      .filter(item =>
        (item.id === familyId && !item.translationOf)
        || item.translationOf === familyId)
      .map(item => ({
        songId: item.id,
        revision: item.revision,
        translationOf: item.translationOf || null
      }))
      .sort((left, right) =>
        Number(Boolean(left.translationOf))
          - Number(Boolean(right.translationOf))
        || compareCanonicalText(left.songId, right.songId));
    if (documents.length > MAX_FAMILY_DOCUMENTS) {
      fail(
        'SONG_FAMILY_TOO_LARGE',
        `A song family can contain at most ${MAX_FAMILY_DOCUMENTS} documents.`,
        { familyId, maximum: MAX_FAMILY_DOCUMENTS }
      );
    }
    const exactDocuments = [];
    for (const document of documents) {
      const read = await this._readRevision(
        document.songId,
        document.revision
      );
      exactDocuments.push(read);
    }
    return Object.freeze({
      familyId,
      snapshotHash: familySnapshotHash(familyId, documents),
      familyRevision: exactDocuments.length > 0
        ? songFamilyRevision(exactDocuments)
        : null,
      documents: Object.freeze(
        documents.map(document => Object.freeze({ ...document }))
      )
    });
  }

  _normalizeExpectedFamilySnapshot(raw, familyId) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      fail('INVALID_SONG_FAMILY', 'Expected song-family state is invalid.');
    }
    const actualKeys = Object.keys(raw).sort();
    const expectedKeys = [
      'documents',
      'familyId',
      'familyRevision',
      'snapshotHash'
    ].sort();
    if (
      actualKeys.length !== expectedKeys.length
      || actualKeys.some((key, index) => key !== expectedKeys[index])
      || raw.familyId !== familyId
      || typeof raw.snapshotHash !== 'string'
      || !REVISION_PATTERN.test(raw.snapshotHash)
      || (
        raw.familyRevision !== null
        && (
          typeof raw.familyRevision !== 'string'
          || !REVISION_PATTERN.test(raw.familyRevision)
        )
      )
      || !Array.isArray(raw.documents)
      || raw.documents.length > MAX_FAMILY_DOCUMENTS
    ) {
      fail('INVALID_SONG_FAMILY', 'Expected song-family state is invalid.');
    }
    const seen = new Set();
    const documents = raw.documents.map(document => {
      if (!document || typeof document !== 'object' || Array.isArray(document)) {
        fail('INVALID_SONG_FAMILY', 'Expected song-family state is invalid.');
      }
      const keys = Object.keys(document).sort();
      if (
        keys.length !== 3
        || keys[0] !== 'revision'
        || keys[1] !== 'songId'
        || keys[2] !== 'translationOf'
      ) {
        fail('INVALID_SONG_FAMILY', 'Expected song-family state is invalid.');
      }
      const songId = this._expectedSongId(document.songId);
      if (
        seen.has(songId)
        || typeof document.revision !== 'string'
        || !REVISION_PATTERN.test(document.revision)
        || (
          document.translationOf !== null
          && document.translationOf !== familyId
        )
      ) {
        fail('INVALID_SONG_FAMILY', 'Expected song-family state is invalid.');
      }
      seen.add(songId);
      return Object.freeze({
        songId,
        revision: document.revision,
        translationOf: document.translationOf
      });
    });
    const sorted = documents.slice().sort((left, right) =>
      Number(Boolean(left.translationOf))
        - Number(Boolean(right.translationOf))
      || compareCanonicalText(left.songId, right.songId));
    const normalized = Object.freeze({
      familyId,
      snapshotHash: raw.snapshotHash,
      familyRevision: raw.familyRevision,
      documents: Object.freeze(sorted)
    });
    let exactFamilyRevision = null;
    if (sorted.length > 0) {
      exactFamilyRevision = songFamilyRevision(sorted.map(document => ({
        song: {
          id: document.songId,
          translationOf: document.translationOf
        },
        revision: document.revision
      })));
    }
    if (
      familySnapshotHash(familyId, sorted) !== normalized.snapshotHash
      || normalized.familyRevision !== exactFamilyRevision
    ) {
      fail('INVALID_SONG_FAMILY', 'Expected song-family state is inconsistent.');
    }
    return normalized;
  }

  async #stageFamilyUnderLibraryLock(raw = {}) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      fail('INVALID_SONG_FAMILY', 'Reviewed song-family request is invalid.');
    }
    const keys = Object.keys(raw).sort();
    if (
      keys.length !== 3
      || keys[0] !== 'documents'
      || keys[1] !== 'expectedSnapshot'
      || keys[2] !== 'familyId'
    ) {
      fail('INVALID_SONG_FAMILY', 'Reviewed song-family request is invalid.');
    }
    const familyId = this._expectedSongId(raw.familyId);
    const expected = this._normalizeExpectedFamilySnapshot(
      raw.expectedSnapshot,
      familyId
    );
    const current = await this.#snapshotFamilyUnderLibraryLock(familyId);
    if (!sameFamilySnapshot(current, expected)) {
      fail(
        'SONG_FAMILY_CONFLICT',
        'This complete song family changed after it was reviewed.',
        {
          familyId,
          expectedSnapshotHash: expected.snapshotHash,
          currentSnapshotHash: current.snapshotHash,
          expectedFamilyRevision: expected.familyRevision,
          currentFamilyRevision: current.familyRevision
        }
      );
    }
    if (
      !Array.isArray(raw.documents)
      || raw.documents.length < 1
      || raw.documents.length > MAX_FAMILY_DOCUMENTS
    ) {
      fail(
        'INVALID_SONG_FAMILY',
        `A reviewed family must contain 1 to ${MAX_FAMILY_DOCUMENTS} documents.`
      );
    }

    const finalDocuments = [];
    const finalById = new Map();
    for (const rawDocument of raw.documents) {
      if (
        !rawDocument
        || typeof rawDocument !== 'object'
        || Array.isArray(rawDocument)
        || Object.keys(rawDocument).sort().join(',') !==
          'documentSource,expectedSongId'
      ) {
        fail('INVALID_SONG_FAMILY', 'A reviewed song document is invalid.');
      }
      const expectedSongId = this._expectedSongId(
        rawDocument.expectedSongId
      );
      let song = parseSongDocument(rawDocument.documentSource, {
        fileName: `${expectedSongId}.md`
      });
      if (song.id !== expectedSongId || finalById.has(song.id)) {
        fail(
          'INVALID_SONG_FAMILY',
          'Reviewed song-family identities are invalid or duplicated.'
        );
      }
      await this._validateAuthoredAttribution(song, {
        expectedSongId: song.id
      });
      const documentSource = serializeSongDocument(song);
      song = parseSongDocument(documentSource, {
        fileName: `${song.id}.md`
      });
      const document = {
        song,
        documentSource,
        source: documentSource,
        revision: sourceRevision(documentSource)
      };
      finalById.set(song.id, document);
      finalDocuments.push(document);
    }

    const root = finalById.get(familyId);
    if (!root || root.song.translationOf) {
      fail(
        'INVALID_SONG_FAMILY',
        'The reviewed family must contain exactly one original matching its family identity.'
      );
    }
    for (const document of finalDocuments) {
      if (
        document.song.id !== familyId
        && document.song.translationOf !== familyId
      ) {
        fail(
          'INVALID_SONG_FAMILY',
          'Every reviewed translation must point directly to the family original.'
        );
      }
      if (document.song.id === familyId) continue;
      const alignment = compareSongSections(root.song, document.song);
      if (!alignment.compatible) {
        fail(
          'SONG_FAMILY_STRUCTURE_MISMATCH',
          `${document.song.title} does not match the reviewed original's section and slide structure.`,
          {
            familyId,
            songId: document.song.id,
            ...alignment
          }
        );
      }
    }

    const expectedIds = new Set(
      expected.documents.map(document => document.songId)
    );
    for (const songId of expectedIds) {
      if (!finalById.has(songId)) {
        fail(
          'SONG_FAMILY_DELETE_UNSUPPORTED',
          'Reviewed family commits cannot delete an existing family member.',
          { familyId, songId }
        );
      }
    }
    const allCurrent = await this._listAll();
    const currentById = new Map(allCurrent.map(item => [item.id, item]));
    for (const document of finalDocuments) {
      const existing = currentById.get(document.song.id);
      if (
        existing
        && !expectedIds.has(document.song.id)
      ) {
        fail(
          'SONG_ID_BELONGS_TO_ANOTHER_FAMILY',
          `Song ${document.song.id} already belongs to another saved family.`,
          {
            songId: document.song.id,
            currentFamilyId: existing.translationOf || existing.id
          }
        );
      }
    }

    const staged = [];
    for (const document of finalDocuments) {
      staged.push(await this.#stageSourceUnderLibraryLock(
        document.documentSource,
        {
          expectedSongId: document.song.id,
          fileName: `${document.song.id}.md`
        }
      ));
    }
    staged.sort((left, right) =>
      Number(Boolean(left.song.translationOf))
        - Number(Boolean(right.song.translationOf))
      || compareCanonicalText(left.song.id, right.song.id));
    const beforeById = new Map(
      expected.documents.map(document => [document.songId, document])
    );
    const members = staged.map(document => Object.freeze({
      songId: document.song.id,
      language: document.song.language,
      translationOf: document.song.translationOf,
      beforeRevision: beforeById.get(document.song.id)?.revision || null,
      afterRevision: document.revision
    }));
    return Object.freeze({
      familyId,
      expectedSnapshot: expected,
      nextFamilyRevision: songFamilyRevision(staged),
      members: Object.freeze(members),
      documents: Object.freeze(staged)
    });
  }

  async importFile(filePath, options = {}) {
    if (typeof filePath !== 'string' || !path.isAbsolute(filePath)) {
      fail('INVALID_IMPORT', 'Choose a song file through SyncShow.');
    }
    const extension = path.extname(filePath).toLowerCase();
    if (!['.md', '.markdown', '.txt'].includes(extension)) fail('INVALID_IMPORT', 'Song imports must be Markdown or plain text.');
    let source;
    try {
      const { buffer } = await readFileNoFollow(filePath, MAX_SOURCE_BYTES);
      source = new TextDecoder('utf-8', { fatal: true }).decode(buffer);
    } catch (error) {
      fail('INVALID_IMPORT', `That song file could not be read safely: ${error.message}`);
    }
    return this.saveSource(source, {
      fileName: path.basename(filePath),
      onConflict: options.onConflict || 'fork'
    });
  }

  async _listPage(options = {}, { strict = false } = {}) {
    const query = String(options.query || '').trim();
    if (query.length > MAX_QUERY_LENGTH) fail('QUERY_TOO_LONG', `Library search must be ${MAX_QUERY_LENGTH} characters or fewer.`);
    const pageSize = Math.max(1, Math.min(MAX_PAGE_SIZE, Number.isSafeInteger(options.pageSize) ? options.pageSize : 50));
    const offset = Math.max(0, Number.isSafeInteger(options.offset) ? options.offset : 0);
    const tokens = query.toLowerCase().split(/\s+/).filter(Boolean);
    const entries = await fs.readdir(this.rootPath, { withFileTypes: true });
    const namedSongEntries = entries.filter(entry =>
      SONG_DIRECTORY_PATTERN.test(entry.name));
    if (
      strict
      && namedSongEntries.some(entry =>
        !entry.isDirectory() || entry.isSymbolicLink?.())
    ) {
      fail(
        'LIBRARY_POINTER_INVALID',
        'A saved song storage entry is unsafe.'
      );
    }
    const songEntries = namedSongEntries.filter(entry =>
      entry.isDirectory() && !entry.isSymbolicLink?.());
    if (namedSongEntries.length > MAX_LIBRARY_SONGS) {
      fail('LIBRARY_TOO_LARGE', `The local library can contain at most ${MAX_LIBRARY_SONGS} songs.`);
    }
    const results = [];
    for (const entry of songEntries) {
      const pointerPath = path.join(this.rootPath, entry.name, 'current.json');
      let pointer;
      try {
        const { buffer } = await readFileNoFollow(pointerPath, MAX_POINTER_BYTES);
        pointer = JSON.parse(buffer.toString('utf8'));
        if (pointer.schemaVersion !== POINTER_SCHEMA_VERSION
          || typeof pointer.songId !== 'string'
          || idStorageKey(pointer.songId) !== entry.name
          || !REVISION_PATTERN.test(pointer.revision || '')
          || Object.keys(pointer).sort().join(',') !==
            'revision,schemaVersion,songId,updatedAt'
          || typeof pointer.updatedAt !== 'string'
          || pointer.updatedAt.length > 40
          || Number.isNaN(Date.parse(pointer.updatedAt))
          || new Date(pointer.updatedAt).toISOString() !== pointer.updatedAt) {
          if (strict) {
            fail(
              'LIBRARY_POINTER_INVALID',
              'A saved song pointer is invalid.',
              { storageKey: entry.name }
            );
          }
          continue;
        }
        const item = await this._readRevision(pointer.songId, pointer.revision, pointer.updatedAt);
        const searchable = [
          item.song.id,
          item.song.title,
          item.song.language,
          item.song.translationOf || '',
          item.song.license,
          item.song.source,
          item.song.attribution,
          ...item.song.tags,
          ...item.song.authors,
          ...item.song.translators,
          ...item.song.composers
        ].join(' ').toLowerCase();
        if (tokens.every(token => searchable.includes(token))
          && (!options.language || item.song.language === options.language)
          && (!options.translationOf || item.song.translationOf === options.translationOf)) {
          results.push(item.summary);
        }
      } catch (error) {
        if (strict) {
          if (error instanceof SongLibraryError) throw error;
          fail(
            'LIBRARY_POINTER_INVALID',
            'A saved song pointer is unreadable.',
            {
              storageKey: entry.name,
              cause: error.code || error.name || 'pointer-read-failed'
            }
          );
        }
        // A broken entry is omitted from search but remains on disk for an
        // explicit recovery/diagnostics flow; listing must not rewrite it.
      }
    }
    results.sort((a, b) => a.title.localeCompare(b.title, 'en', { sensitivity: 'base' }) || a.id.localeCompare(b.id));
    return {
      items: results.slice(offset, offset + pageSize),
      total: results.length,
      offset,
      nextOffset: offset + pageSize < results.length ? offset + pageSize : null
    };
  }

  async list(options = {}) {
    return this.#withExclusiveSession(() => this._listPage(options));
  }

  async snapshotAllCurrent() {
    return this.#withExclusiveSession(session => session.listCurrent());
  }
}

module.exports = {
  LocalSongLibrary,
  MAX_PAGE_SIZE,
  PENDING_FAMILY_JOURNAL_FILE,
  SongLibraryError,
  familySnapshotHash,
  idStorageKey
};
