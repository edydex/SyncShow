'use strict';

const crypto = require('crypto');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');

const { parseSongDocument } = require('../project/SongDocument');
const {
  LocalSongLibrary,
  idStorageKey
} = require('../project/LocalSongLibrary');
const {
  fsyncDirectory,
  readFileNoFollow,
  withExclusiveFileLock
} = require('../project/StorageSafety');
const { CommunityClientError } = require('./CommunityClient');

const MAX_REMOTE_PAGES = 100;
const MAX_REMOTE_ITEMS = 10000;

class CommunitySongSyncError extends Error {
  constructor(code, message, { cause = null } = {}) {
    super(message);
    this.name = 'CommunitySongSyncError';
    this.code = code;
    this.cause = cause;
  }
}

function fail(code, message, cause = null) {
  throw new CommunitySongSyncError(code, message, { cause });
}

function assertNotAborted(signal) {
  if (!signal?.aborted) return;
  const error = new CommunitySongSyncError('SYNC_CANCELLED', 'Community song sync was cancelled.');
  error.name = 'AbortError';
  throw error;
}

function ownValue(object, key, fallback = null) {
  return object && Object.prototype.hasOwnProperty.call(object, key)
    ? object[key]
    : fallback;
}

function normalizeIdentity(value) {
  return String(value || '')
    .normalize('NFKD')
    .toLocaleLowerCase('en')
    .match(/[\p{L}\p{N}]+/gu)
    ?.join('') || '';
}

function identityKeys(values) {
  return new Set(values.map(normalizeIdentity).filter(key => key.length >= 3));
}

function parseRemoteDocuments(record) {
  if (!record.syncDocuments?.length) return [];
  const parsed = record.syncDocuments.map(document => {
    let song;
    try {
      song = parseSongDocument(document.source, { fileName: `${document.id}.md` });
    } catch (error) {
      fail('INVALID_REMOTE_SONG', 'Community returned an invalid song document.', error?.code);
    }
    if (song.id !== document.id) {
      fail('INVALID_REMOTE_SONG', 'Community song document identity does not match its source.');
    }
    return { ...document, song };
  });
  return parsed.sort((left, right) =>
    Number(Boolean(left.song.translationOf)) - Number(Boolean(right.song.translationOf))
    || left.id.localeCompare(right.id));
}

function localFamilyKeys(family) {
  return identityKeys([
    family.id,
    ...family.documents.map(document => document.song.id),
    ...family.documents.map(document => document.song.title)
  ]);
}

function remoteRecordKeys(record, parsedDocuments = []) {
  return identityKeys([
    record.syncId,
    record.title,
    ...(record.alternateTitles || []),
    ...parsedDocuments.map(document => document.song.id),
    ...parsedDocuments.map(document => document.song.title)
  ]);
}

function keysIntersect(left, right) {
  for (const key of left) if (right.has(key)) return true;
  return false;
}

function documentsState(localDocuments, remoteDocuments) {
  const remoteById = new Map((remoteDocuments || []).map(document => [document.id, document]));
  const result = Object.create(null);
  for (const document of localDocuments) {
    result[document.song.id] = {
      localRevision: document.revision,
      remoteRevision: remoteById.get(document.song.id)?.revision || null
    };
  }
  return result;
}

function missingTrackedDocumentIds(family, trackedDocuments = {}) {
  if (!family) return [];
  return Object.keys(trackedDocuments).filter(id =>
    !family.documents.some(document => document.song.id === id));
}

function stateFromRemote(previous, remote, {
  localFamilyId = previous.localFamilyId,
  documents = previous.documents,
  conflict = previous.conflict,
  pendingVisibility = previous.pendingVisibility,
  syncedAt
} = {}) {
  return {
    ...previous,
    syncId: remote.syncId,
    localFamilyId,
    remoteTitle: remote.title,
    alternateTitles: [...remote.alternateTitles],
    syncVersion: remote.syncVersion,
    remoteRevision: remote.revision,
    documents,
    visibility: remote.visibility,
    publishAt: remote.publishAt,
    pendingVisibility,
    archived: remote.archived,
    metadataOnly: remote.metadataOnly,
    lastSyncedAt: syncedAt,
    conflict
  };
}

function remoteConflict(remote, code, localRevision, detectedAt) {
  return {
    code,
    detectedAt,
    localRevision: localRevision || null,
    remoteRevision: remote.revision,
    remoteDocuments: (remote.syncDocuments || []).map(document => ({
      id: document.id,
      source: document.source,
      revision: document.revision
    }))
  };
}

function familyRevision(family) {
  return crypto.createHash('sha256')
    .update(family.documents.map(document => `${document.song.id}:${document.revision}`).join('\n'))
    .digest('hex');
}

function visibilityRequest(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail('INVALID_VISIBILITY', 'Song visibility selection is invalid.');
  }
  const visibility = value.visibility || 'private';
  if (!['private', 'public', 'scheduled-public'].includes(visibility)) {
    fail('INVALID_VISIBILITY', 'Song visibility selection is invalid.');
  }
  let publishAt = null;
  if (value.publishAt !== undefined && value.publishAt !== null && value.publishAt !== '') {
    if (typeof value.publishAt !== 'string' || Number.isNaN(Date.parse(value.publishAt))) {
      fail('INVALID_VISIBILITY', 'Scheduled publication time is invalid.');
    }
    publishAt = new Date(value.publishAt).toISOString();
  }
  if (visibility === 'scheduled-public' && !publishAt) {
    fail('INVALID_VISIBILITY', 'Scheduled-public songs require a publication time.');
  }
  if (visibility !== 'scheduled-public' && publishAt) {
    fail('INVALID_VISIBILITY', 'Only scheduled-public songs may have a publication time.');
  }
  return {
    visibility,
    publishAt,
    expectedSyncVersion: value.expectedSyncVersion ?? null
  };
}

class CommunitySongSync {
  constructor({
    client,
    localLibrary,
    stateStore,
    connectionId,
    accessTokenProvider,
    now = () => new Date()
  } = {}) {
    if (!client
      || typeof client.listSongChanges !== 'function'
      || typeof client.createSong !== 'function'
      || typeof client.updateSong !== 'function') {
      throw new TypeError('CommunitySongSync requires a CommunityClient-compatible client');
    }
    if (!localLibrary
      || typeof localLibrary.list !== 'function'
      || typeof localLibrary.read !== 'function'
      || typeof localLibrary.saveSource !== 'function') {
      throw new TypeError('CommunitySongSync requires a LocalSongLibrary-compatible library');
    }
    if (!stateStore
      || typeof stateStore.getConnectionState !== 'function'
      || typeof stateStore.saveConnectionState !== 'function') {
      throw new TypeError('CommunitySongSync requires a CommunitySyncStateStore-compatible store');
    }
    if (typeof connectionId !== 'string' || connectionId.length < 8) {
      throw new TypeError('CommunitySongSync connection ID is invalid');
    }
    if (typeof accessTokenProvider !== 'function' || typeof now !== 'function') {
      throw new TypeError('CommunitySongSync dependencies are invalid');
    }
    this.client = client;
    this.localLibrary = localLibrary;
    this.stateStore = stateStore;
    this.connectionId = connectionId;
    this.accessTokenProvider = accessTokenProvider;
    this.now = now;
  }

  _timestamp() {
    const current = this.now();
    const parsed = current instanceof Date ? current : new Date(current);
    if (Number.isNaN(parsed.getTime())) throw new TypeError('Community song sync clock is invalid');
    return parsed.toISOString();
  }

  async _localFamilies(signal) {
    const summaries = [];
    let offset = 0;
    while (true) {
      assertNotAborted(signal);
      const page = await this.localLibrary.list({ pageSize: 100, offset });
      summaries.push(...page.items);
      if (page.nextOffset === null) break;
      offset = page.nextOffset;
    }
    const documents = [];
    for (const summary of summaries) {
      assertNotAborted(signal);
      const item = await this.localLibrary.read(summary.id);
      documents.push(item);
    }
    const families = new Map();
    for (const document of documents) {
      const familyId = document.song.translationOf || document.song.id;
      if (!families.has(familyId)) families.set(familyId, { id: familyId, documents: [] });
      families.get(familyId).documents.push(document);
    }
    for (const family of families.values()) {
      family.documents.sort((left, right) =>
        Number(Boolean(left.song.translationOf)) - Number(Boolean(right.song.translationOf))
        || left.song.id.localeCompare(right.song.id));
      family.revision = familyRevision(family);
      family.keys = localFamilyKeys(family);
    }
    return families;
  }

  async _preflightRemoteDocuments(remoteDocuments) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'syncshow-community-preflight-'));
    try {
      const staged = new LocalSongLibrary({ rootPath: path.join(root, 'songs') });
      const remoteIds = new Set(remoteDocuments.map(document => document.id));
      const externalRoots = [...new Set(remoteDocuments
        .map(document => document.song.translationOf)
        .filter(id => id && !remoteIds.has(id)))];
      for (const rootId of externalRoots) {
        const localRoot = await this.localLibrary.read(rootId);
        await staged.saveSource(localRoot.source, { expectedRevision: null });
      }
      for (const document of remoteDocuments) {
        await staged.saveSource(document.source, {
          expectedSongId: document.id,
          expectedRevision: null
        });
      }
    } catch (error) {
      fail('INVALID_REMOTE_DOCUMENTS', 'Community song family failed local validation.', error?.code);
    } finally {
      await fs.rm(root, { recursive: true, force: true }).catch(() => {});
    }
  }

  async _withdrawNewDocument(songId, expectedRevision) {
    if (typeof this.localLibrary.rootPath !== 'string'
      || !path.isAbsolute(this.localLibrary.rootPath)) {
      fail('ROLLBACK_UNAVAILABLE', 'Local song rollback is unavailable.');
    }
    const rootPath = this.localLibrary.rootPath;
    const songDirectory = path.join(rootPath, idStorageKey(songId));
    const pointerPath = path.join(songDirectory, 'current.json');
    await withExclusiveFileLock(path.join(rootPath, '.library-write-lock'), () =>
      withExclusiveFileLock(path.join(songDirectory, '.write-lock'), async () => {
        const { buffer } = await readFileNoFollow(pointerPath, 64 * 1024);
        let pointer;
        try {
          pointer = JSON.parse(buffer.toString('utf8'));
        } catch (_error) {
          fail('ROLLBACK_CONFLICT', 'A newly imported song could not be rolled back safely.');
        }
        if (pointer?.songId !== songId || pointer?.revision !== expectedRevision) {
          fail('ROLLBACK_CONFLICT', 'A newly imported song changed before rollback.');
        }
        await fs.unlink(pointerPath);
        await fsyncDirectory(songDirectory).catch(() => {});
      }));
  }

  async _applyRemoteDocumentsAtomically(remoteDocuments, signal) {
    await this._preflightRemoteDocuments(remoteDocuments);
    assertNotAborted(signal);
    const snapshots = new Map();
    for (const document of remoteDocuments) {
      let existing = null;
      try {
        existing = await this.localLibrary.read(document.id);
      } catch (error) {
        if (error.code !== 'SONG_NOT_FOUND') throw error;
      }
      snapshots.set(document.id, existing);
    }

    const applied = [];
    try {
      for (const remoteDocument of remoteDocuments) {
        assertNotAborted(signal);
        const before = snapshots.get(remoteDocument.id);
        const saved = await this.localLibrary.saveSource(remoteDocument.source, {
          expectedSongId: remoteDocument.id,
          expectedRevision: before?.revision ?? null
        });
        applied.push({ before, saved });
      }
      return applied.map(entry => entry.saved);
    } catch (error) {
      const rollbackFailures = [];
      for (const entry of [...applied].reverse()) {
        try {
          if (entry.before) {
            await this.localLibrary.saveSource(entry.before.source, {
              expectedSongId: entry.before.song.id,
              expectedRevision: entry.saved.revision
            });
          } else {
            await this._withdrawNewDocument(entry.saved.song.id, entry.saved.revision);
          }
        } catch (rollbackError) {
          rollbackFailures.push(rollbackError?.code || rollbackError?.name || 'rollback-failed');
        }
      }
      if (rollbackFailures.length > 0) {
        fail(
          'REMOTE_IMPORT_RECOVERY_REQUIRED',
          'A Community song family could not be restored completely after an interrupted import.',
          rollbackFailures.join(',')
        );
      }
      throw error;
    }
  }

  async _remoteChanges(cursor, accessToken, signal) {
    const records = [];
    let nextCursor = cursor;
    const intermediateCursors = new Set();
    for (let pageNumber = 0; pageNumber < MAX_REMOTE_PAGES; pageNumber += 1) {
      assertNotAborted(signal);
      const page = await this.client.listSongChanges({
        cursor: nextCursor,
        limit: 100,
        accessToken,
        signal
      });
      records.push(...page.items);
      if (records.length > MAX_REMOTE_ITEMS) {
        fail('REMOTE_LIBRARY_TOO_LARGE', 'Community song library is too large to synchronize safely.');
      }
      if (!page.hasMore) {
        if (!page.nextCursor
          || (pageNumber > 0 && intermediateCursors.has(page.nextCursor))) {
          fail(
            'INVALID_REMOTE_CURSOR',
            'Community song synchronization did not return a durable final cursor.'
          );
        }
        return { records, cursor: page.nextCursor };
      }
      if (!page.nextCursor || page.nextCursor === nextCursor) {
        fail('INVALID_REMOTE_CURSOR', 'Community song synchronization cursor did not advance.');
      }
      intermediateCursors.add(page.nextCursor);
      nextCursor = page.nextCursor;
    }
    fail('REMOTE_PAGE_LIMIT', 'Community song synchronization returned too many pages.');
  }

  _catalog(state, remoteChanges) {
    const catalog = new Map();
    for (const song of Object.values(state.songs)) {
      catalog.set(song.syncId, {
        syncId: song.syncId,
        title: song.remoteTitle,
        alternateTitles: song.alternateTitles || [],
        syncVersion: song.syncVersion,
        revision: song.remoteRevision,
        visibility: song.visibility,
        publishAt: song.publishAt,
        archived: song.archived,
        metadataOnly: song.metadataOnly,
        syncDocuments: null,
        fromState: true
      });
    }
    for (const remote of remoteChanges) catalog.set(remote.syncId, remote);
    return catalog;
  }

  _matchFamilies(families, catalog, state) {
    const familyToRemote = new Map();
    const remoteToFamily = new Map();
    const ambiguousFamilies = new Set();
    const ambiguousRemotes = new Set();

    const claim = (familyId, remoteId) => {
      if (familyToRemote.has(familyId) || remoteToFamily.has(remoteId)) return false;
      familyToRemote.set(familyId, remoteId);
      remoteToFamily.set(remoteId, familyId);
      return true;
    };

    for (const family of families.values()) {
      if (catalog.has(family.id)) claim(family.id, family.id);
    }
    for (const song of Object.values(state.songs)) {
      if (song.localFamilyId
        && families.has(song.localFamilyId)
        && catalog.has(song.syncId)) {
        claim(song.localFamilyId, song.syncId);
      }
    }

    const familyCandidates = new Map();
    const remoteCandidateCounts = new Map();
    for (const family of families.values()) {
      if (familyToRemote.has(family.id)) continue;
      const candidates = [];
      for (const remote of catalog.values()) {
        if (remoteToFamily.has(remote.syncId)) continue;
        let parsed = [];
        if (remote.syncDocuments?.length) {
          try {
            parsed = parseRemoteDocuments(remote);
          } catch (_error) {
            parsed = [];
          }
        }
        if (keysIntersect(family.keys, remoteRecordKeys(remote, parsed))) {
          candidates.push(remote.syncId);
          remoteCandidateCounts.set(
            remote.syncId,
            (remoteCandidateCounts.get(remote.syncId) || 0) + 1
          );
        }
      }
      familyCandidates.set(family.id, candidates);
    }
    for (const [familyId, candidates] of familyCandidates) {
      if (candidates.length === 1 && remoteCandidateCounts.get(candidates[0]) === 1) {
        claim(familyId, candidates[0]);
      } else if (candidates.length > 0) {
        ambiguousFamilies.add(familyId);
        for (const remoteId of candidates) ambiguousRemotes.add(remoteId);
      }
    }
    return { familyToRemote, remoteToFamily, ambiguousFamilies, ambiguousRemotes };
  }

  _token(value) {
    const token = typeof value === 'string' ? value : value?.accessToken;
    if (typeof token !== 'string' || token.length < 16) {
      fail('AUTH_REQUIRED', 'Community authorization is unavailable.');
    }
    return token;
  }

  _offlineResult(error, result, cursor) {
    if (error instanceof CommunityClientError
      && (error.retryable
        || ['NETWORK_ERROR', 'REQUEST_TIMEOUT', 'SERVER_UNAVAILABLE', 'RATE_LIMITED']
          .includes(error.code))) {
      return Object.freeze({
        ...result,
        status: 'offline',
        cursor,
        warnings: Object.freeze([
          ...result.warnings,
          { code: error.code, message: 'Local songs remain available; Community sync will retry later.' }
        ])
      });
    }
    throw error;
  }

  async sync({
    syncId = null,
    visibilityForSong = null,
    signal = null
  } = {}) {
    assertNotAborted(signal);
    let families = await this._localFamilies(signal);
    let state = await this.stateStore.getConnectionState(this.connectionId);
    const result = {
      status: 'synced',
      pulled: 0,
      pushed: 0,
      archived: 0,
      conflicts: 0,
      warnings: []
    };
    const requestedId = syncId === null
      ? null
      : String(syncId);
    if (requestedId && !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(requestedId)) {
      fail('INVALID_SYNC_ID', 'Song sync ID is invalid.');
    }
    const requestedFamilyId = requestedId
      ? ([...families.values()].find(family =>
        family.id === requestedId
        || family.documents.some(document => document.song.id === requestedId))?.id || requestedId)
      : null;

    if (visibilityForSong !== null && typeof visibilityForSong !== 'function') {
      throw new TypeError('visibilityForSong must be a function');
    }
    if (visibilityForSong) {
      for (const family of families.values()) {
        if (requestedFamilyId && family.id !== requestedFamilyId) continue;
        const existing = Object.values(state.songs)
          .find(song => song.localFamilyId === family.id || song.syncId === family.id);
        const requested = await visibilityForSong(family, existing || null);
        if (!requested) continue;
        const normalized = visibilityRequest(requested);
        const remoteVersion = existing?.syncVersion ?? null;
        if (remoteVersion !== null
          && normalized.expectedSyncVersion !== remoteVersion) {
          fail('STATE_CONFLICT', 'Reload this song before changing its visibility.');
        }
        const targetId = existing?.syncId || family.id;
        const song = existing || {
          syncId: targetId,
          localFamilyId: family.id,
          remoteTitle: null,
          alternateTitles: [],
          syncVersion: null,
          remoteRevision: null,
          documents: {},
          visibility: 'private',
          publishAt: null,
          archived: false,
          metadataOnly: false,
          lastSyncedAt: null,
          conflict: null
        };
        song.pendingVisibility = normalized;
        state.songs[targetId] = song;
      }
      assertNotAborted(signal);
      state = await this.stateStore.saveConnectionState(this.connectionId, state);
    }

    let accessToken;
    try {
      accessToken = this._token(await this.accessTokenProvider());
    } catch (error) {
      return this._offlineResult(error, result, state.cursor);
    }

    let remotePage;
    try {
      remotePage = await this._remoteChanges(
        requestedFamilyId ? null : state.cursor,
        accessToken,
        signal
      );
    } catch (error) {
      assertNotAborted(signal);
      return this._offlineResult(error, result, state.cursor);
    }
    assertNotAborted(signal);

    const remoteChanges = requestedFamilyId
      ? remotePage.records.filter(record =>
        record.syncId === requestedFamilyId
        || ownValue(state.songs, record.syncId)?.localFamilyId === requestedFamilyId)
      : remotePage.records;
    const catalog = this._catalog(state, remotePage.records);
    const matches = this._matchFamilies(families, catalog, state);
    const syncedAt = this._timestamp();

    const checkpoint = async () => {
      assertNotAborted(signal);
      state = await this.stateStore.saveConnectionState(this.connectionId, state);
    };

    for (const remote of remoteChanges) {
      assertNotAborted(signal);
      const previous = ownValue(state.songs, remote.syncId) || {
        syncId: remote.syncId,
        localFamilyId: null,
        remoteTitle: null,
        alternateTitles: [],
        syncVersion: null,
        remoteRevision: null,
        documents: {},
        visibility: 'private',
        publishAt: null,
        pendingVisibility: null,
        archived: false,
        metadataOnly: false,
        lastSyncedAt: null,
        conflict: null
      };
      const matchedFamilyId = matches.remoteToFamily.get(remote.syncId)
        || previous.localFamilyId;
      let family = matchedFamilyId ? families.get(matchedFamilyId) : null;

      if (matches.ambiguousRemotes.has(remote.syncId)) {
        previous.conflict = remoteConflict(
          remote,
          'AMBIGUOUS_REMOTE_MATCH',
          family?.revision,
          syncedAt
        );
        state.songs[remote.syncId] = stateFromRemote(previous, remote, {
          conflict: previous.conflict,
          syncedAt
        });
        result.conflicts += 1;
        result.warnings.push({
          code: 'AMBIGUOUS_REMOTE_MATCH',
          syncId: remote.syncId,
          message: 'More than one local song could match this Community song; nothing was overwritten.'
        });
        await checkpoint();
        continue;
      }

      if (previous.pendingVisibility?.expectedSyncVersion !== null
        && previous.pendingVisibility?.expectedSyncVersion !== undefined
        && previous.pendingVisibility.expectedSyncVersion !== remote.syncVersion) {
        const conflict = remoteConflict(
          remote,
          'VISIBILITY_CAS_CONFLICT',
          family?.revision,
          syncedAt
        );
        state.songs[remote.syncId] = stateFromRemote(previous, remote, {
          localFamilyId: family?.id || previous.localFamilyId,
          conflict,
          syncedAt
        });
        result.conflicts += 1;
        result.warnings.push({
          code: 'VISIBILITY_CAS_CONFLICT',
          syncId: remote.syncId,
          message: 'Community visibility changed before the scheduled update; nothing was overwritten.'
        });
        await checkpoint();
        continue;
      }

      if (remote.archived) {
        state.songs[remote.syncId] = stateFromRemote(previous, remote, {
          localFamilyId: family?.id || previous.localFamilyId,
          syncedAt
        });
        result.archived += 1;
        result.warnings.push({
          code: 'REMOTE_ARCHIVED',
          syncId: remote.syncId,
          message: 'The Community song was archived; the local song was kept.'
        });
        await checkpoint();
        continue;
      }

      if (remote.metadataOnly) {
        state.songs[remote.syncId] = stateFromRemote(previous, remote, {
          localFamilyId: family?.id || previous.localFamilyId,
          syncedAt
        });
        if (!family) {
          result.warnings.push({
            code: 'REMOTE_METADATA_ONLY',
            syncId: remote.syncId,
            message: 'The Community record has no synced song documents, so no local song was changed.'
          });
        }
        await checkpoint();
        continue;
      }

      let parsedRemote;
      try {
        parsedRemote = parseRemoteDocuments(remote);
      } catch (error) {
        previous.conflict = remoteConflict(
          remote,
          'INVALID_REMOTE_DOCUMENTS',
          family?.revision,
          syncedAt
        );
        state.songs[remote.syncId] = stateFromRemote(previous, remote, {
          conflict: previous.conflict,
          syncedAt
        });
        result.conflicts += 1;
        result.warnings.push({
          code: 'INVALID_REMOTE_DOCUMENTS',
          syncId: remote.syncId,
          message: 'Invalid Community song documents were preserved for review and not imported.'
        });
        await checkpoint();
        continue;
      }

      if (!family) {
        const remoteRoot = parsedRemote.find(document => !document.song.translationOf);
        const possibleFamilyId = remoteRoot?.song.id
          || parsedRemote[0]?.song.translationOf
          || parsedRemote[0]?.song.id;
        family = families.get(possibleFamilyId) || null;
      }

      const sameContent = Boolean(family)
        && parsedRemote.length === family.documents.length
        && parsedRemote.every(remoteDocument => {
          const local = family.documents.find(document => document.song.id === remoteDocument.id);
          return local
            && (local.revision === remoteDocument.revision
              || local.source === remoteDocument.source
              || local.documentSource === remoteDocument.source);
        });
      const trackedDocuments = previous.documents || {};
      const missingDocumentIds = missingTrackedDocumentIds(family, trackedDocuments);
      const localChanged = Boolean(family) && (
        Object.keys(trackedDocuments).length === 0
        || family.documents.some(document =>
          ownValue(trackedDocuments, document.song.id)?.localRevision !== document.revision)
        || missingDocumentIds.length > 0
      );
      const remoteChanged = previous.syncVersion === null
        || previous.syncVersion !== remote.syncVersion;

      if (family && missingDocumentIds.length > 0) {
        const conflict = remoteConflict(
          remote,
          'MISSING_LOCAL_DOCUMENTS',
          family.revision,
          syncedAt
        );
        state.songs[remote.syncId] = stateFromRemote(previous, remote, {
          localFamilyId: family.id,
          documents: trackedDocuments,
          conflict,
          syncedAt
        });
        result.conflicts += 1;
        result.warnings.push({
          code: 'MISSING_LOCAL_DOCUMENTS',
          syncId: remote.syncId,
          message: 'A previously synced local song document is unavailable. The Community family was preserved unchanged for review.'
        });
        await checkpoint();
        continue;
      }

      if (sameContent) {
        state.songs[remote.syncId] = stateFromRemote(previous, remote, {
          localFamilyId: family.id,
          documents: documentsState(family.documents, remote.syncDocuments),
          conflict: null,
          syncedAt
        });
        await checkpoint();
        continue;
      }

      if (family && localChanged && remoteChanged) {
        const conflict = remoteConflict(
          remote,
          previous.syncVersion === null ? 'INDEPENDENT_FIRST_SYNC' : 'BOTH_CHANGED',
          family.revision,
          syncedAt
        );
        state.songs[remote.syncId] = stateFromRemote(previous, remote, {
          localFamilyId: family.id,
          conflict,
          syncedAt
        });
        result.conflicts += 1;
        result.warnings.push({
          code: conflict.code,
          syncId: remote.syncId,
          message: 'Local and Community versions differ; both were preserved for review.'
        });
        await checkpoint();
        continue;
      }

      if (family && localChanged && !remoteChanged) {
        state.songs[remote.syncId] = stateFromRemote(previous, remote, {
          localFamilyId: family.id,
          documents: previous.documents,
          conflict: null,
          syncedAt
        });
        await checkpoint();
        continue;
      }

      try {
        const savedDocuments = await this._applyRemoteDocumentsAtomically(
          parsedRemote,
          signal
        );
        const retainedDocuments = family?.documents.filter(document =>
          !savedDocuments.some(saved => saved.song.id === document.song.id)) || [];
        const familyId = savedDocuments.find(document => !document.song.translationOf)?.song.id
          || savedDocuments[0]?.song.translationOf
          || savedDocuments[0]?.song.id;
        const pulledFamily = {
          id: familyId,
          documents: [...savedDocuments, ...retainedDocuments].sort((left, right) =>
            Number(Boolean(left.song.translationOf)) - Number(Boolean(right.song.translationOf))
            || left.song.id.localeCompare(right.song.id))
        };
        pulledFamily.revision = familyRevision(pulledFamily);
        pulledFamily.keys = localFamilyKeys(pulledFamily);
        families.set(familyId, pulledFamily);
        let retainedConflict = null;
        if (retainedDocuments.length > 0) {
          retainedConflict = remoteConflict(
            remote,
            'RETAINED_LOCAL_DOCUMENTS',
            pulledFamily.revision,
            syncedAt
          );
          result.conflicts += 1;
          result.warnings.push({
            code: 'RETAINED_LOCAL_DOCUMENTS',
            syncId: remote.syncId,
            message: 'Local translations absent from the Community record were retained for review and not re-uploaded.'
          });
        }
        state.songs[remote.syncId] = stateFromRemote(previous, remote, {
          localFamilyId: familyId,
          documents: documentsState(pulledFamily.documents, remote.syncDocuments),
          conflict: retainedConflict,
          syncedAt
        });
        result.pulled += 1;
        await checkpoint();
      } catch (error) {
        if (error instanceof CommunitySongSyncError
          && error.code === 'REMOTE_IMPORT_RECOVERY_REQUIRED') {
          throw error;
        }
        const conflict = remoteConflict(
          remote,
          'LOCAL_IMPORT_CONFLICT',
          family?.revision,
          syncedAt
        );
        state.songs[remote.syncId] = stateFromRemote(previous, remote, {
          localFamilyId: family?.id || previous.localFamilyId,
          conflict,
          syncedAt
        });
        result.conflicts += 1;
        result.warnings.push({
          code: 'LOCAL_IMPORT_CONFLICT',
          syncId: remote.syncId,
          message: 'Community song documents could not replace local content; both were preserved.'
        });
        await checkpoint();
      }
    }

    families = await this._localFamilies(signal);
    const currentCatalog = this._catalog(state, []);
    const currentMatches = this._matchFamilies(families, currentCatalog, state);

    for (const family of families.values()) {
      assertNotAborted(signal);
      if (requestedFamilyId && family.id !== requestedFamilyId) continue;
      if (currentMatches.ambiguousFamilies.has(family.id)) {
        result.conflicts += 1;
        result.warnings.push({
          code: 'AMBIGUOUS_REMOTE_MATCH',
          syncId: family.id,
          message: 'This local song could match more than one Community record, so no duplicate was created.'
        });
        continue;
      }
      const remoteId = currentMatches.familyToRemote.get(family.id);
      let songState = remoteId ? ownValue(state.songs, remoteId) : null;
      const syncDocuments = family.documents.map(document => ({
        id: document.song.id,
        source: document.source,
        revision: document.revision
      }));

      try {
        if (!songState
          || (songState.syncVersion === null && songState.remoteRevision === null)) {
          const requestedVisibility = songState?.pendingVisibility || {
            visibility: 'private',
            publishAt: null
          };
          assertNotAborted(signal);
          const created = await this.client.createSong({
            syncId: family.id,
            syncDocuments,
            ...requestedVisibility,
            idempotencyKey: crypto.createHash('sha256')
              .update(`${this.connectionId}:${family.id}`)
              .digest('hex'),
            accessToken,
            signal
          });
          assertNotAborted(signal);
          songState = stateFromRemote({
            syncId: created.syncId,
            localFamilyId: family.id,
            remoteTitle: null,
            alternateTitles: [],
            documents: {},
            pendingVisibility: null,
            conflict: null
          }, created, {
            localFamilyId: family.id,
            documents: documentsState(family.documents, created.syncDocuments),
            conflict: null,
            pendingVisibility: null,
            syncedAt
          });
          state.songs[created.syncId] = songState;
          result.pushed += 1;
          await checkpoint();
          continue;
        }

        if (songState.archived) {
          result.warnings.push({
            code: 'REMOTE_ARCHIVED',
            syncId: songState.syncId,
            message: 'The Community song is archived; SyncShow did not silently restore it.'
          });
          continue;
        }
        if (songState.conflict) continue;
        const trackedDocuments = songState.documents || {};
        const missingDocumentIds = missingTrackedDocumentIds(family, trackedDocuments);
        if (missingDocumentIds.length > 0) {
          assertNotAborted(signal);
          const latest = await this.client.getSong({
            syncId: songState.syncId,
            accessToken,
            signal
          });
          assertNotAborted(signal);
          const conflict = remoteConflict(
            latest,
            'MISSING_LOCAL_DOCUMENTS',
            family.revision,
            syncedAt
          );
          state.songs[latest.syncId] = stateFromRemote(songState, latest, {
            localFamilyId: family.id,
            documents: trackedDocuments,
            conflict,
            syncedAt
          });
          result.conflicts += 1;
          result.warnings.push({
            code: 'MISSING_LOCAL_DOCUMENTS',
            syncId: latest.syncId,
            message: 'A previously synced local song document is unavailable. The Community family was preserved unchanged for review.'
          });
          await checkpoint();
          continue;
        }
        const localChanged = Object.keys(trackedDocuments).length === 0
          || family.documents.some(document =>
            ownValue(trackedDocuments, document.song.id)?.localRevision !== document.revision);
        const pending = songState.pendingVisibility;
        if (!localChanged && !pending) continue;
        if (!Number.isSafeInteger(songState.syncVersion)) {
          result.warnings.push({
            code: 'REMOTE_VERSION_MISSING',
            syncId: songState.syncId,
            message: 'Community song has no safe compare-and-swap version; it was not overwritten.'
          });
          continue;
        }
        assertNotAborted(signal);
        const updated = await this.client.updateSong({
          syncId: songState.syncId,
          syncDocuments: localChanged ? syncDocuments : undefined,
          visibility: pending?.visibility,
          publishAt: pending?.publishAt,
          expectedSyncVersion: songState.syncVersion,
          accessToken,
          signal
        });
        assertNotAborted(signal);
        state.songs[updated.syncId] = stateFromRemote(songState, updated, {
          localFamilyId: family.id,
          documents: documentsState(family.documents, updated.syncDocuments || syncDocuments),
          conflict: null,
          pendingVisibility: null,
          syncedAt
        });
        result.pushed += 1;
        await checkpoint();
      } catch (error) {
        assertNotAborted(signal);
        if (error instanceof CommunityClientError
          && error.code === 'REVISION_CONFLICT') {
          let latest = null;
          try {
            latest = await this.client.getSong({
              syncId: songState?.syncId || family.id,
              accessToken,
              signal
            });
          } catch (getError) {
            return this._offlineResult(getError, result, state.cursor);
          }
          assertNotAborted(signal);
          const targetId = latest.syncId;
          const previous = ownValue(state.songs, targetId) || songState;
          const conflict = remoteConflict(
            latest,
            'CAS_CONFLICT',
            family.revision,
            syncedAt
          );
          state.songs[targetId] = stateFromRemote(previous, latest, {
            localFamilyId: family.id,
            conflict,
            syncedAt
          });
          result.conflicts += 1;
          result.warnings.push({
            code: 'CAS_CONFLICT',
            syncId: targetId,
            message: 'Community song changed during sync; both versions were preserved.'
          });
          await checkpoint();
          continue;
        }
        return this._offlineResult(error, result, state.cursor);
      }
    }

    if (!requestedFamilyId) state.cursor = remotePage.cursor;
    state.lastSyncAt = syncedAt;
    await checkpoint();
    return Object.freeze({
      ...result,
      warnings: Object.freeze(result.warnings),
      cursor: state.cursor
    });
  }

  syncSong(syncId, options = {}) {
    return this.sync({ ...options, syncId });
  }

  async resolveConflict(syncId, {
    strategy,
    expectedSyncVersion,
    expectedLocalRevision,
    signal = null
  } = {}) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(String(syncId || ''))) {
      fail('INVALID_SYNC_ID', 'Song sync ID is invalid.');
    }
    if (!['keep-local', 'keep-remote'].includes(strategy)) {
      fail('INVALID_RESOLUTION', 'Choose whether to keep the local or Community song.');
    }
    if (!Number.isSafeInteger(expectedSyncVersion) || expectedSyncVersion < 1) {
      fail('INVALID_RESOLUTION', 'Reload the conflict before resolving it.');
    }
    if (typeof expectedLocalRevision !== 'string'
      || !/^[a-f0-9]{64}$/.test(expectedLocalRevision)) {
      fail('INVALID_RESOLUTION', 'Reload the local song before resolving the conflict.');
    }
    assertNotAborted(signal);
    const state = await this.stateStore.getConnectionState(this.connectionId);
    const songState = ownValue(state.songs, syncId);
    if (!songState?.conflict) fail('CONFLICT_NOT_FOUND', 'This song no longer has a saved conflict.');
    if (songState.syncVersion !== expectedSyncVersion) {
      fail('RESOLUTION_STALE', 'The Community song changed; reload the conflict before resolving it.');
    }
    const families = await this._localFamilies(signal);
    const familyId = songState.localFamilyId || syncId;
    const family = families.get(familyId);
    if (!family) fail('LOCAL_FAMILY_NOT_FOUND', 'The local song family is unavailable.');
    if (family.revision !== expectedLocalRevision) {
      fail('RESOLUTION_STALE', 'The local song changed; reload the conflict before resolving it.');
    }
    if (strategy === 'keep-local'
      && songState.conflict.code === 'MISSING_LOCAL_DOCUMENTS'
      && missingTrackedDocumentIds(family, songState.documents).length > 0) {
      fail(
        'MISSING_LOCAL_DOCUMENTS',
        'Restore the missing local song documents, or keep the Community copy. SyncShow will not delete them from Community without a deliberate removal workflow.'
      );
    }
    const accessToken = this._token(await this.accessTokenProvider());
    assertNotAborted(signal);
    const latest = await this.client.getSong({ syncId, accessToken, signal });
    if (latest.syncVersion !== expectedSyncVersion) {
      fail('RESOLUTION_STALE', 'The Community song changed; reload the conflict before resolving it.');
    }
    const syncedAt = this._timestamp();

    if (strategy === 'keep-local') {
      const syncDocuments = family.documents.map(document => ({
        id: document.song.id,
        source: document.source,
        revision: document.revision
      }));
      assertNotAborted(signal);
      const updated = await this.client.updateSong({
        syncId,
        syncDocuments,
        expectedSyncVersion,
        accessToken,
        signal
      });
      assertNotAborted(signal);
      state.songs[syncId] = stateFromRemote(songState, updated, {
        localFamilyId: family.id,
        documents: documentsState(family.documents, updated.syncDocuments || syncDocuments),
        conflict: null,
        pendingVisibility: songState.pendingVisibility,
        syncedAt
      });
      await this.stateStore.saveConnectionState(this.connectionId, state);
      return Object.freeze({
        resolved: true,
        strategy,
        syncId,
        syncVersion: updated.syncVersion
      });
    }

    if (latest.archived || latest.metadataOnly || !latest.syncDocuments?.length) {
      fail(
        'REMOTE_CONTENT_UNAVAILABLE',
        'The Community record has no active song documents to keep.'
      );
    }
    const remoteDocuments = parseRemoteDocuments(latest);
    await this._applyRemoteDocumentsAtomically(remoteDocuments, signal);
    const refreshedFamilies = await this._localFamilies(signal);
    const refreshedFamily = refreshedFamilies.get(familyId)
      || [...refreshedFamilies.values()].find(candidate =>
        candidate.documents.some(document =>
          latest.syncDocuments.some(remote => remote.id === document.song.id)));
    if (!refreshedFamily) fail('LOCAL_IMPORT_FAILED', 'Community song could not be imported locally.');
    assertNotAborted(signal);
    const retainedDocuments = refreshedFamily.documents.filter(document =>
      !latest.syncDocuments.some(remote => remote.id === document.song.id));
    const retainedConflict = retainedDocuments.length > 0
      ? remoteConflict(
          latest,
          'RETAINED_LOCAL_DOCUMENTS',
          refreshedFamily.revision,
          syncedAt
        )
      : null;
    state.songs[syncId] = stateFromRemote(songState, latest, {
      localFamilyId: refreshedFamily.id,
      documents: documentsState(refreshedFamily.documents, latest.syncDocuments),
      conflict: retainedConflict,
      pendingVisibility: songState.pendingVisibility,
      syncedAt
    });
    await this.stateStore.saveConnectionState(this.connectionId, state);
    return Object.freeze({
      resolved: retainedDocuments.length === 0,
      strategy,
      syncId,
      syncVersion: latest.syncVersion,
      retainedDocuments: Object.freeze(retainedDocuments.map(document => document.song.id)),
      warningCode: retainedDocuments.length > 0 ? 'RETAINED_LOCAL_DOCUMENTS' : null
    });
  }
}

module.exports = {
  CommunitySongSync,
  CommunitySongSyncError,
  normalizeIdentity
};
