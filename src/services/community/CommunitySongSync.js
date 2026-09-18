'use strict';

const crypto = require('crypto');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');

const { parseSongDocument } = require('../project/SongDocument');
const {
  LocalSongLibrary,
  familySnapshotHash
} = require('../project/LocalSongLibrary');
const {
  compareCanonicalText
} = require('../project/SongFamilyRevision');
const { CommunityClientError } = require('./CommunityClient');
const {
  CommunitySongSharingReviewError,
  songFamilyRevision,
  songSharingReviewRevision,
  songSharingReviewStatus
} = require('./CommunitySongSharingReview');

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
  const familyIds = new Set(
    parsed.map(document => document.song.translationOf || document.song.id)
  );
  if (familyIds.size !== 1) {
    fail(
      'INVALID_REMOTE_SONG',
      'Community returned song documents from more than one song family.'
    );
  }
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
    memberSharing: remote.memberSharing || null,
    effectiveVisibility: remote.effectiveVisibility ?? null,
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
    remoteSyncVersion: remote.syncVersion,
    remoteDocuments: (remote.syncDocuments || []).map(document => ({
      id: document.id,
      source: document.source,
      revision: document.revision
    }))
  };
}

function refreshedRemoteConflict(conflict, remote) {
  if (!conflict) return null;
  return remoteConflict(
    remote,
    conflict.code,
    conflict.localRevision,
    conflict.detectedAt
  );
}

function familyRevision(family) {
  return songFamilyRevision(family);
}

function familySnapshotVector(familyId, family = null) {
  const documents = family?.id === familyId
    ? family.documents.map(document => ({
      songId: document.song.id,
      revision: document.revision,
      translationOf: document.song.translationOf || null
    })).sort((left, right) =>
      Number(Boolean(left.translationOf))
        - Number(Boolean(right.translationOf))
      || compareCanonicalText(left.songId, right.songId))
    : [];
  return Object.freeze({
    familyId,
    snapshotHash: familySnapshotHash(familyId, documents),
    familyRevision: documents.length === 0
      ? null
      : familyRevision({ documents: family.documents }),
    documents: Object.freeze(
      documents.map(document => Object.freeze(document))
    )
  });
}

function isMemberVisible(visibility) {
  return visibility === 'public' || visibility === 'scheduled-public';
}

function reviewedSubmissionFields(review, visibility) {
  if (!review) return Object.freeze({});
  const rightsStatus = {
    'church-managed': 'metadata-only',
    'public-domain': 'public-domain',
    'original-work': 'permission-granted',
    'church-license': 'licensed',
    'specific-web-license': 'licensed',
    'direct-permission': 'permission-granted',
    'other-reviewed': 'mixed'
  }[review.basis] || 'needs-review';
  const access = visibility === 'private'
    ? 'Community admins only'
    : visibility === 'scheduled-public'
      ? 'signed-in Community members on schedule'
      : 'signed-in Community members';
  const evidence = review.evidence
    ? `Evidence: ${review.evidence}`
    : review.basis === 'church-managed'
      ? 'Licenses and permissions are managed by the hosting church outside SyncShow.'
      : `Basis confirmed: ${review.basis}`;
  return Object.freeze({
    rightsStatus,
    rightsNotes: [
      `SyncShow reviewed submission for ${access}.`,
      evidence,
      `Exact family revision: ${review.familyRevision}`,
      `Reviewed at: ${review.reviewedAt}`
    ].join(' ')
  });
}

function currentSharingReviewStatus(review, family, {
  now,
  publishAt = null
} = {}) {
  try {
    return songSharingReviewStatus(review, {
      familyRevision: family.revision,
      now,
      publishAt
    });
  } catch (error) {
    if (error instanceof CommunitySongSharingReviewError) {
      fail(error.code, error.message);
    }
    throw error;
  }
}

function addRightsReviewWarning(result, syncId, status) {
  result.status = 'needs-review';
  result.reviewRequired += 1;
  result.warnings.push({
    code: 'SONG_SHARING_REVIEW_REQUIRED',
    syncId,
    message: status === 'expired'
      ? 'The song-family sharing review expired. Community kept its current member-visible revision unchanged.'
      : status === 'schedule-after-expiry'
        ? 'The scheduled member-access time falls after this song family must be reviewed again. Community kept its current revision unchanged.'
      : status === 'stale'
        ? 'The song family changed after its sharing review. Community kept its current member-visible revision unchanged.'
        : 'Review the complete song family before making it visible to Community members.'
  });
}

function assertRemoteSongIdentity(remote, syncId) {
  if (remote?.syncId !== syncId) {
    fail(
      'REMOTE_ID_MISMATCH',
      'Heritage Community returned a different song identity, so SyncShow did not use it.'
    );
  }
  return remote;
}

function assertRemoteSongContinuity(previous, remote) {
  if (previous?.syncVersion === null || previous?.syncVersion === undefined) return remote;
  if (remote.syncVersion < previous.syncVersion) {
    fail(
      'REMOTE_VERSION_REGRESSION',
      'Heritage Community moved the song version backwards, so SyncShow did not use it.'
    );
  }
  if (remote.syncVersion !== previous.syncVersion) return remote;

  let priorDocuments = new Map();
  let documentBaselineKnown = false;
  if (previous.conflict?.remoteSyncVersion === previous.syncVersion
    && previous.conflict?.remoteRevision === previous.remoteRevision) {
    priorDocuments = new Map(
      (previous.conflict.remoteDocuments || [])
        .map(document => [document.id, document.revision])
    );
    documentBaselineKnown = true;
  } else if (!previous.conflict) {
    priorDocuments = new Map(
      Object.entries(previous.documents || {})
        .filter(([, document]) => document?.remoteRevision)
        .map(([id, document]) => [id, document.remoteRevision])
    );
    documentBaselineKnown = previous.metadataOnly === true
      || priorDocuments.size > 0;
  }
  const currentDocuments = Array.isArray(remote.syncDocuments)
    ? remote.syncDocuments
    : [];
  const currentById = new Map(
    currentDocuments.map(document => [document.id, document.revision])
  );
  const documentsChanged = documentBaselineKnown
    && (currentDocuments.length !== priorDocuments.size
      || [...priorDocuments].some(([id, revision]) =>
        currentById.get(id) !== revision));

  if ((previous.remoteRevision
      && remote.revision !== previous.remoteRevision)
    || documentsChanged) {
    fail(
      'REMOTE_VERSION_REUSE',
      'Heritage Community reused a song version for different content, so SyncShow did not use it.'
    );
  }
  return remote;
}

function assertSongMutationResponse(remote, {
  syncId,
  expectedSyncVersion = null,
  syncDocuments = null,
  visibility,
  publishAt = null,
  rightsStatus = null,
  rightsNotes = null
} = {}) {
  assertRemoteSongIdentity(remote, syncId);
  if (!Number.isSafeInteger(remote.syncVersion)
    || remote.syncVersion < 1
    || (expectedSyncVersion !== null
      && remote.syncVersion <= expectedSyncVersion)) {
    fail(
      'REMOTE_VERSION_REUSE',
      'Heritage Community did not advance the song version, so SyncShow did not checkpoint the write.'
    );
  }
  if (remote.archived) {
    fail(
      'REMOTE_ARCHIVED',
      'Heritage Community returned an archived song after the write, so SyncShow did not checkpoint it.'
    );
  }
  if (syncDocuments !== null) {
    const actual = Array.isArray(remote.syncDocuments)
      ? remote.syncDocuments
      : [];
    const actualById = new Map(actual.map(document => [document.id, document]));
    if (actual.length !== syncDocuments.length
      || syncDocuments.some(document => {
        const returned = actualById.get(document.id);
        return !returned
          || returned.revision !== document.revision
          || returned.source !== document.source;
      })) {
      fail(
        'REMOTE_CONTENT_MISMATCH',
        'Heritage Community did not confirm the exact song documents, so SyncShow did not checkpoint the write.'
      );
    }
  }
  if (remote.visibility !== visibility || remote.publishAt !== publishAt) {
    fail(
      'COMMUNITY_VISIBILITY_NOT_APPLIED',
      'Heritage Community did not confirm the requested song access, so SyncShow did not checkpoint the write.'
    );
  }
  if ((rightsStatus !== null
      && Object.prototype.hasOwnProperty.call(remote, 'rightsStatus')
      && remote.rightsStatus !== rightsStatus)
    || (rightsNotes !== null
      && Object.prototype.hasOwnProperty.call(remote, 'rightsNotes')
      && remote.rightsNotes !== rightsNotes)) {
    fail(
      'REMOTE_RIGHTS_REVIEW_MISMATCH',
      'Heritage Community did not confirm the reviewed song rights evidence, so SyncShow did not checkpoint the write.'
    );
  }
  return remote;
}

function assertPrivateDemotion(remote, {
  syncId,
  expectedSyncVersion,
  syncDocuments = null,
  trackedDocuments = null
} = {}) {
  const validated = assertSongMutationResponse(remote, {
    syncId,
    expectedSyncVersion,
    syncDocuments,
    visibility: 'private',
    publishAt: null
  });
  if (trackedDocuments !== null) {
    const expected = new Map(
      Object.entries(trackedDocuments)
        .filter(([, document]) => document?.remoteRevision)
        .map(([id, document]) => [id, document.remoteRevision])
    );
    const actual = Array.isArray(validated.syncDocuments)
      ? validated.syncDocuments
      : [];
    const actualById = new Map(
      actual.map(document => [document.id, document.revision])
    );
    if (actual.length !== expected.size
      || [...expected].some(([id, revision]) =>
        actualById.get(id) !== revision)) {
      fail(
        'REMOTE_CONTENT_MISMATCH',
        'Heritage Community changed song documents while restricting access, so SyncShow did not checkpoint the write.'
      );
    }
  }
  return validated;
}

function hasRemoteIdentity(song) {
  return (song?.syncVersion !== null && song?.syncVersion !== undefined)
    || (song?.remoteRevision !== null && song?.remoteRevision !== undefined);
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
  const expectedFamilyRevision = value.expectedFamilyRevision ?? null;
  if (expectedFamilyRevision !== null
    && (typeof expectedFamilyRevision !== 'string'
      || !/^[a-f0-9]{64}$/.test(expectedFamilyRevision))) {
    fail(
      'SONG_SHARING_REVIEW_STALE',
      'Reload the complete song family before reviewing Community sharing.'
    );
  }
  return {
    visibility,
    publishAt,
    expectedSyncVersion: value.expectedSyncVersion ?? null,
    expectedFamilyRevision,
    sharingReview: value.sharingReview ?? null
  };
}

class CommunitySongSync {
  constructor({
    client,
    localLibrary,
    familyImportCoordinator,
    stateStore,
    connectionId,
    accessTokenProvider,
    now = () => new Date()
  } = {}) {
    if (!client
      || typeof client.listSongChanges !== 'function'
      || typeof client.getSong !== 'function'
      || typeof client.createSong !== 'function'
      || typeof client.updateSong !== 'function') {
      throw new TypeError('CommunitySongSync requires a CommunityClient-compatible client');
    }
    if (!localLibrary
      || typeof localLibrary.list !== 'function'
      || typeof localLibrary.read !== 'function'
      || typeof localLibrary.saveSource !== 'function'
      || typeof localLibrary.withCurrentSnapshot !== 'function') {
      throw new TypeError('CommunitySongSync requires a LocalSongLibrary-compatible library');
    }
    if (!familyImportCoordinator
      || typeof familyImportCoordinator.apply !== 'function'
      || typeof familyImportCoordinator.recover !== 'function') {
      throw new TypeError(
        'CommunitySongSync requires a Community song-family import coordinator'
      );
    }
    if (!stateStore
      || typeof stateStore.getConnectionState !== 'function'
      || typeof stateStore.saveConnectionState !== 'function'
      || typeof stateStore.getSongSharingReview !== 'function'
      || typeof stateStore.confirmSongSharingReview !== 'function') {
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
    this.familyImportCoordinator = familyImportCoordinator;
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

  async _sharingReviewStatus(family, {
    now,
    publishAt = null
  } = {}) {
    const review = await this.stateStore.getSongSharingReview(
      this.connectionId,
      family.id
    );
    return currentSharingReviewStatus(review, family, {
      now: now === undefined ? this.now() : now,
      publishAt
    });
  }

  async _memberSharingReview(family) {
    const review = await this.stateStore.getSongSharingReview(
      this.connectionId,
      family.id
    );
    const status = currentSharingReviewStatus(review, family, {
      now: this.now()
    });
    // Expiry and scheduling are finalized in the Community server's
    // configured IANA time zone. The workstation review remains recovery
    // input only; locally gate shape, supported basis, and exact family.
    if (['missing', 'stale', 'basis-unsupported'].includes(status)) {
      fail(
        'SONG_SHARING_REVIEW_REQUIRED',
        status === 'basis-unsupported'
          ? 'Review this exact family again with the current church-managed access policy.'
          : 'Review this exact song family before making it visible to Community members.'
      );
    }
    return Object.freeze({
      review,
      reviewRevision: songSharingReviewRevision(review)
    });
  }

  async _shareWithMembers({
    family,
    song,
    visibility,
    publishAt,
    accessToken,
    signal
  }) {
    if (typeof this.client.shareSongWithMembers !== 'function') {
      fail(
        'SONG_MEMBER_SHARING_UNSUPPORTED',
        'This Community server can stage songs privately but cannot accept the reviewed member-sharing transaction.'
      );
    }
    const { review, reviewRevision } =
      await this._memberSharingReview(family);
    assertNotAborted(signal);
    const applied = await this.client.shareSongWithMembers({
      syncId: song.syncId,
      expectedSyncVersion: song.syncVersion,
      familyRevision: family.revision,
      review,
      reviewRevision,
      visibility,
      publishAt,
      accessToken,
      signal
    });
    assertNotAborted(signal);
    if (!applied
      || applied.song?.syncId !== song.syncId
      || applied.song?.syncVersion !== applied.receipt?.songSyncVersion
      || applied.song?.memberSharing?.receiptRevision
        !== applied.receipt?.receiptRevision) {
      fail(
        'MEMBER_SHARING_NOT_CONFIRMED',
        'Heritage Community did not confirm the current reviewed member-sharing receipt.'
      );
    }
    return applied;
  }

  async _localFamilies(signal) {
    let documents;
    if (typeof this.localLibrary.snapshotAllCurrent === 'function') {
      assertNotAborted(signal);
      documents = await this.localLibrary.snapshotAllCurrent();
    } else {
      const summaries = [];
      let offset = 0;
      while (true) {
        assertNotAborted(signal);
        const page = await this.localLibrary.list({ pageSize: 100, offset });
        summaries.push(...page.items);
        if (page.nextOffset === null) break;
        offset = page.nextOffset;
      }
      documents = [];
      for (const summary of summaries) {
        assertNotAborted(signal);
        const item = await this.localLibrary.read(summary.id, {
          revision: summary.revision
        });
        documents.push(item);
      }
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

  async _applyRemoteDocumentsAtomically(
    remoteDocuments,
    signal,
    reconciledSnapshot = null
  ) {
    const familyId = remoteDocuments[0]?.song.translationOf
      || remoteDocuments[0]?.song.id;
    if (!familyId) {
      fail(
        'INVALID_REMOTE_DOCUMENTS',
        'Community song family identity is unavailable.'
      );
    }
    let expectedSnapshot = reconciledSnapshot;
    if (expectedSnapshot === null) {
      try {
        expectedSnapshot = await this.localLibrary.withCurrentSnapshot(
          session => session.snapshotFamily(familyId)
        );
      } catch (error) {
        if (error.code === 'SONG_FAMILY_RECOVERY_REQUIRED') {
          fail(
            'REMOTE_IMPORT_RECOVERY_REQUIRED',
            'A pending song-family transaction must be recovered before importing Community songs.',
            error.code
          );
        }
        throw error;
      }
    } else if (expectedSnapshot.familyId !== familyId) {
      fail(
        'INVALID_REMOTE_DOCUMENTS',
        'The reconciled local family does not match the Community documents.'
      );
    }
    await this._preflightRemoteDocuments(remoteDocuments);
    assertNotAborted(signal);
    try {
      const committed = await this.familyImportCoordinator.apply({
        familyId,
        expectedSnapshot,
        documents: remoteDocuments.map(document => ({
          expectedSongId: document.id,
          documentSource: document.source
        }))
      });
      const committedById = new Map(
        committed.documents.map(document => [document.song.id, document])
      );
      const saved = remoteDocuments.map(document =>
        committedById.get(document.id));
      if (saved.some(document => !document)) {
        fail(
          'REMOTE_IMPORT_RECOVERY_REQUIRED',
          'The durable Community family import did not return every requested document.'
        );
      }
      return saved;
    } catch (error) {
      if (error.code === 'COMMUNITY_FAMILY_IMPORT_RECOVERY_REQUIRED') {
        fail(
          'REMOTE_IMPORT_RECOVERY_REQUIRED',
          'A Community song family import was interrupted and must be recovered before current songs are used.',
          error.code
        );
      }
      throw error;
    }
  }

  async _remoteChanges(cursor, accessToken, signal) {
    const records = [];
    let nextCursor = cursor;
    const seenCursors = new Set(cursor == null ? [] : [cursor]);
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
        const unchangedEmptyPoll = pageNumber === 0
          && page.items.length === 0
          && page.nextCursor === cursor;
        if (!page.nextCursor
          || (seenCursors.has(page.nextCursor) && !unchangedEmptyPoll)) {
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
      seenCursors.add(page.nextCursor);
      nextCursor = page.nextCursor;
    }
    fail('REMOTE_PAGE_LIMIT', 'Community song synchronization returned too many pages.');
  }

  _catalog(state, remoteChanges) {
    const catalog = new Map();
    for (const song of Object.values(state.songs)) {
      // Pending intent for a never-created local family is not a remote
      // identity. Let the full remote snapshot match by immutable documents
      // or stable title keys before deciding that a new record is needed.
      if (!hasRemoteIdentity(song)) continue;
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

  _matchExactFamily(families, state, remoteId) {
    const familyToRemote = new Map();
    const remoteToFamily = new Map();
    const ambiguousFamilies = new Set();
    const ambiguousRemotes = new Set();
    const persisted = ownValue(state.songs, remoteId);
    const family = persisted?.localFamilyId
      ? families.get(persisted.localFamilyId)
      : families.get(remoteId)
        || [...families.values()].find(candidate =>
          candidate.documents.some(document => document.song.id === remoteId));
    if (family) {
      familyToRemote.set(family.id, remoteId);
      remoteToFamily.set(remoteId, family.id);
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
    allowWrites = true,
    signal = null,
    exactRemote = null
  } = {}) {
    assertNotAborted(signal);
    const result = {
      status: 'synced',
      pulled: 0,
      pushed: 0,
      archived: 0,
      conflicts: 0,
      reviewRequired: 0,
      warnings: []
    };
    const explicitMemberSharing = new Map();
    const explicitSubmissions = new Map();
    let requestedId = null;
    let exactRemoteRecord = null;
    let exactAccessToken = null;
    let exactState = null;
    if (exactRemote !== null) {
      requestedId = syncId === null
        ? null
        : String(syncId);
      if (typeof allowWrites !== 'boolean') {
        throw new TypeError('allowWrites must be a boolean');
      }
      if (!allowWrites && visibilityForSong !== null) {
        fail(
          'COMMUNITY_READ_ONLY',
          'This Community connection is read-only; song changes were not sent.'
        );
      }
      if (requestedId
        && !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(requestedId)) {
        fail('INVALID_SYNC_ID', 'Song sync ID is invalid.');
      }
      if (
        !requestedId
        || !exactRemote
        || typeof exactRemote !== 'object'
        || Array.isArray(exactRemote)
        || Object.keys(exactRemote).sort().join(',')
          !== 'expectedRevision,expectedSyncVersion'
        || !Number.isSafeInteger(exactRemote.expectedSyncVersion)
        || exactRemote.expectedSyncVersion < 1
        || typeof exactRemote.expectedRevision !== 'string'
        || !/^[A-Za-z0-9][A-Za-z0-9._:"/-]{0,255}$/.test(
          exactRemote.expectedRevision
        )
        || allowWrites !== false
        || visibilityForSong !== null
      ) {
        fail(
          'INVALID_REMOTE_PRECONDITION',
          'An exact Community song pull requires one read-only version and revision.'
        );
      }
      exactState = await this.stateStore.getConnectionState(this.connectionId);
      try {
        exactAccessToken = this._token(await this.accessTokenProvider());
        exactRemoteRecord = assertRemoteSongIdentity(
          await this.client.getSong({
            syncId: requestedId,
            accessToken: exactAccessToken,
            signal
          }),
          requestedId
        );
        if (
          exactRemoteRecord.syncVersion !== exactRemote.expectedSyncVersion
          || exactRemoteRecord.revision !== exactRemote.expectedRevision
        ) {
          fail(
            'REMOTE_PRECONDITION_FAILED',
            'The Community song no longer matches the exact reviewed version.',
            {
              syncId: requestedId,
              expectedSyncVersion: exactRemote.expectedSyncVersion,
              currentSyncVersion: exactRemoteRecord.syncVersion,
              expectedRevision: exactRemote.expectedRevision,
              currentRevision: exactRemoteRecord.revision
            }
          );
        }
      } catch (error) {
        assertNotAborted(signal);
        return this._offlineResult(error, result, exactState.cursor);
      }
    }

    await this.familyImportCoordinator.recover();
    if (typeof allowWrites !== 'boolean') {
      throw new TypeError('allowWrites must be a boolean');
    }
    if (!allowWrites && visibilityForSong !== null) {
      fail(
        'COMMUNITY_READ_ONLY',
        'This Community connection is read-only; song changes were not sent.'
      );
    }
    let families = await this._localFamilies(signal);
    let state = exactState
      || await this.stateStore.getConnectionState(this.connectionId);
    if (exactRemote === null) {
      requestedId = syncId === null
        ? null
        : String(syncId);
    }
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
        if (normalized.expectedFamilyRevision !== null
          && normalized.expectedFamilyRevision !== family.revision) {
          fail(
            'SONG_SHARING_REVIEW_STALE',
            'The song family changed after it was opened. Review every current language and version before sharing.'
          );
        }
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
        let confirmedReview = null;
        if (normalized.sharingReview !== null) {
          confirmedReview = await this.stateStore.confirmSongSharingReview(
            this.connectionId,
            family.id,
            {
              basis: normalized.sharingReview.basis,
              evidence: normalized.sharingReview.evidence,
              validUntil: normalized.sharingReview.validUntil,
              familyRevision: family.revision,
              expectedReviewRevision:
                normalized.sharingReview.expectedReviewRevision ?? null
            }
          );
          state.songSharingReviews[family.id] = confirmedReview;
          explicitSubmissions.set(family.id, Object.freeze({
            visibility: normalized.visibility,
            review: confirmedReview
          }));
        }
        if (isMemberVisible(normalized.visibility)) {
          await this._memberSharingReview(family);
        }
        if (isMemberVisible(normalized.visibility)) {
          explicitMemberSharing.set(family.id, Object.freeze({
            visibility: normalized.visibility,
            publishAt: normalized.publishAt
          }));
          // A local member-visible choice is review/recovery input, never a
          // durable authority or background queue. Only a receipt-backed
          // online transaction below may make it current.
          if (isMemberVisible(song.pendingVisibility?.visibility)) {
            song.pendingVisibility = null;
          }
        } else {
          song.pendingVisibility = normalized;
        }
        state.songs[targetId] = song;
      }
      assertNotAborted(signal);
      state = await this.stateStore.saveConnectionState(this.connectionId, state);
    }

    let accessToken;
    if (exactRemote) {
      accessToken = exactAccessToken;
    } else {
      try {
        accessToken = this._token(await this.accessTokenProvider());
      } catch (error) {
        return this._offlineResult(error, result, state.cursor);
      }
    }

    let remotePage;
    try {
      if (exactRemote) {
        remotePage = {
          records: [exactRemoteRecord],
          cursor: state.cursor
        };
      } else {
        remotePage = await this._remoteChanges(
          requestedFamilyId ? null : state.cursor,
          accessToken,
          signal
        );
      }
    } catch (error) {
      assertNotAborted(signal);
      return this._offlineResult(error, result, state.cursor);
    }
    assertNotAborted(signal);

    const catalog = this._catalog(state, remotePage.records);
    const matches = exactRemote
      ? this._matchExactFamily(families, state, requestedId)
      : this._matchFamilies(families, catalog, state);
    const requestedFamilyWasAmbiguous = Boolean(
      requestedFamilyId && matches.ambiguousFamilies.has(requestedFamilyId)
    );
    const remoteChanges = requestedFamilyId
      ? remotePage.records.filter(record =>
        record.syncId === requestedFamilyId
        || ownValue(state.songs, record.syncId)?.localFamilyId === requestedFamilyId
        || matches.remoteToFamily.get(record.syncId) === requestedFamilyId)
      : remotePage.records;
    const syncedAt = this._timestamp();

    const checkpoint = async () => {
      assertNotAborted(signal);
      state = await this.stateStore.saveConnectionState(this.connectionId, state);
    };
    const updateSongOrOffline = async input => {
      try {
        return { remote: await this.client.updateSong(input) };
      } catch (error) {
        assertNotAborted(signal);
        return { offline: this._offlineResult(error, result, state.cursor) };
      }
    };

    for (const remote of remoteChanges) {
      assertNotAborted(signal);
      const persisted = ownValue(state.songs, remote.syncId);
      const matchedFamilyId = matches.remoteToFamily.get(remote.syncId)
        || persisted?.localFamilyId;
      const synthetic = matchedFamilyId
        ? Object.values(state.songs).find(song =>
            song.syncId !== remote.syncId
            && !hasRemoteIdentity(song)
            && (song.localFamilyId === matchedFamilyId
              || song.syncId === matchedFamilyId))
        : null;
      const previous = persisted
        ? {
            ...persisted,
            pendingVisibility: persisted.pendingVisibility
              || synthetic?.pendingVisibility
              || null
          }
        : synthetic || {
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
      if (isMemberVisible(previous.pendingVisibility?.visibility)) {
        previous.pendingVisibility = null;
        result.status = 'needs-review';
        result.reviewRequired += 1;
        result.warnings.push({
          code: 'SONG_MEMBER_SHARING_REVIEW_REQUIRED',
          syncId: remote.syncId,
          message: 'An older queued member-sharing choice was cleared. Open Review and share to send the exact online transaction.'
        });
      }
      assertRemoteSongContinuity(previous, remote);
      if (synthetic) delete state.songs[synthetic.syncId];
      let family = matchedFamilyId ? families.get(matchedFamilyId) : null;
      const persistedClaim = family
        ? matches.familyToRemote.get(family.id)
        : null;
      if (persistedClaim && persistedClaim !== remote.syncId) {
        const conflict = previous.conflict
          ? refreshedRemoteConflict(previous.conflict, remote)
          : remoteConflict(
              remote,
              'AMBIGUOUS_REMOTE_MATCH',
              family.revision,
              syncedAt
            );
        state.songs[remote.syncId] = stateFromRemote(previous, remote, {
          localFamilyId: null,
          conflict,
          syncedAt
        });
        result.conflicts += 1;
        result.warnings.push({
          code: 'AMBIGUOUS_REMOTE_MATCH',
          syncId: remote.syncId,
          message: 'A different Community record is already paired with this local song family; the duplicate record was quarantined.'
        });
        await checkpoint();
        continue;
      }

      if (matches.ambiguousRemotes.has(remote.syncId)) {
        previous.conflict = previous.conflict
          ? refreshedRemoteConflict(previous.conflict, remote)
          : remoteConflict(
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
        const restrictionAlreadyApplied = previous.pendingVisibility.visibility === 'private'
          && remote.visibility === 'private'
          && remote.publishAt === null;
        let conflict = previous.conflict
          ? refreshedRemoteConflict(previous.conflict, remote)
          : remoteConflict(
              remote,
              'VISIBILITY_CAS_CONFLICT',
              family?.revision,
              syncedAt
            );
        if (allowWrites
          && previous.pendingVisibility.visibility === 'private'
          && !restrictionAlreadyApplied
          && !remote.archived) {
          assertNotAborted(signal);
          const restriction = await updateSongOrOffline({
            syncId: remote.syncId,
            visibility: 'private',
            publishAt: null,
            expectedSyncVersion: remote.syncVersion,
            accessToken,
            signal
          });
          if (restriction.offline) return restriction.offline;
          const restricted = restriction.remote;
          assertNotAborted(signal);
          assertPrivateDemotion(restricted, {
            syncId: remote.syncId,
            expectedSyncVersion: remote.syncVersion,
            syncDocuments: remote.syncDocuments || []
          });
          conflict = refreshedRemoteConflict(conflict, restricted);
          state.songs[remote.syncId] = stateFromRemote(previous, restricted, {
            localFamilyId: family?.id || previous.localFamilyId,
            documents: previous.documents,
            conflict,
            pendingVisibility: null,
            syncedAt
          });
          result.pushed += 1;
          result.conflicts += 1;
          result.warnings.push({
            code: 'CONFLICT_RETAINED',
            syncId: remote.syncId,
            message: 'Community changed before the request; member access was still restricted to admins and the content conflict remains for review.'
          });
          await checkpoint();
          continue;
        }
        state.songs[remote.syncId] = stateFromRemote(previous, remote, {
          localFamilyId: family?.id || previous.localFamilyId,
          conflict,
          pendingVisibility: restrictionAlreadyApplied
            ? null
            : previous.pendingVisibility,
          syncedAt
        });
        result.conflicts += 1;
        result.warnings.push({
          code: 'VISIBILITY_CAS_CONFLICT',
          syncId: remote.syncId,
          message: restrictionAlreadyApplied
            ? 'Community changed before the request, but the admin-only restriction is already confirmed; the content conflict remains.'
            : 'Community visibility changed before the scheduled update; nothing was overwritten.'
        });
        await checkpoint();
        continue;
      }

      if (remote.archived) {
        state.songs[remote.syncId] = stateFromRemote(previous, remote, {
          localFamilyId: family?.id || previous.localFamilyId,
          conflict: refreshedRemoteConflict(previous.conflict, remote),
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

      if (allowWrites
        && previous.conflict
        && previous.pendingVisibility?.visibility === 'private') {
        let restricted = remote;
        let restrictionWriteVersion = null;
        if (remote.visibility !== 'private' || remote.publishAt !== null) {
          assertNotAborted(signal);
          restrictionWriteVersion = remote.syncVersion;
          const restriction = await updateSongOrOffline({
            syncId: remote.syncId,
            visibility: 'private',
            publishAt: null,
            expectedSyncVersion: remote.syncVersion,
            accessToken,
            signal
          });
          if (restriction.offline) return restriction.offline;
          restricted = restriction.remote;
          assertNotAborted(signal);
          result.pushed += 1;
        }
        assertPrivateDemotion(restricted, {
          syncId: remote.syncId,
          expectedSyncVersion: restrictionWriteVersion,
          syncDocuments: remote.syncDocuments || []
        });
        state.songs[restricted.syncId] = stateFromRemote(previous, restricted, {
          localFamilyId: family?.id || previous.localFamilyId,
          documents: previous.documents,
          conflict: refreshedRemoteConflict(previous.conflict, restricted),
          pendingVisibility: null,
          syncedAt
        });
        result.conflicts += 1;
        result.warnings.push({
          code: 'CONFLICT_RETAINED',
          syncId: restricted.syncId,
          message: 'Member access was restricted to admins; the local and Community content conflict remains for review.'
        });
        await checkpoint();
        continue;
      }

      if (previous.conflict) {
        state.songs[remote.syncId] = stateFromRemote(previous, remote, {
          localFamilyId: family?.id || previous.localFamilyId,
          documents: previous.documents,
          conflict: refreshedRemoteConflict(previous.conflict, remote),
          syncedAt
        });
        result.conflicts += 1;
        result.warnings.push({
          code: 'CONFLICT_RETAINED',
          syncId: remote.syncId,
          message: 'The local and Community song conflict remains until an operator chooses which copy to keep.'
        });
        await checkpoint();
        continue;
      }

      if (!family
        && Object.keys(previous.documents || {}).length > 0
        && !remote.metadataOnly) {
        const conflict = remoteConflict(
          remote,
          'MISSING_LOCAL_DOCUMENTS',
          null,
          syncedAt
        );
        state.songs[remote.syncId] = stateFromRemote(previous, remote, {
          localFamilyId: previous.localFamilyId,
          documents: previous.documents,
          conflict,
          syncedAt
        });
        result.conflicts += 1;
        result.warnings.push({
          code: 'MISSING_LOCAL_DOCUMENTS',
          syncId: remote.syncId,
          message: 'Every previously synced local song document is unavailable. Community content was preserved unchanged for deliberate recovery.'
        });
        await checkpoint();
        continue;
      }

      if (remote.metadataOnly) {
        const priorRemoteDocuments = Object.values(previous.documents || {})
          .filter(document => document?.remoteRevision);
        const previouslyContentBearing = previous.syncVersion !== null
          && previous.syncVersion !== undefined
          && previous.metadataOnly === false
          && priorRemoteDocuments.length > 0;
        if (previouslyContentBearing) {
          const conflict = remoteConflict(
            remote,
            'REMOTE_DOCUMENTS_MISSING',
            family?.revision,
            syncedAt
          );
          state.songs[remote.syncId] = stateFromRemote(previous, remote, {
            localFamilyId: family?.id || previous.localFamilyId,
            documents: previous.documents,
            conflict,
            syncedAt
          });
          result.conflicts += 1;
          result.warnings.push({
            code: 'REMOTE_DOCUMENTS_MISSING',
            syncId: remote.syncId,
            message: 'Community stopped returning a previously synced song family. The local documents and prior baseline were preserved for review.'
          });
          await checkpoint();
          continue;
        }
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

      const claimedRemoteId = family
        ? matches.familyToRemote.get(family.id)
        : null;
      if (claimedRemoteId && claimedRemoteId !== remote.syncId) {
        const conflict = previous.conflict
          ? refreshedRemoteConflict(previous.conflict, remote)
          : remoteConflict(
              remote,
              'AMBIGUOUS_REMOTE_MATCH',
              family.revision,
              syncedAt
            );
        state.songs[remote.syncId] = stateFromRemote(previous, remote, {
          localFamilyId: null,
          conflict,
          syncedAt
        });
        result.conflicts += 1;
        result.warnings.push({
          code: 'AMBIGUOUS_REMOTE_MATCH',
          syncId: remote.syncId,
          message: 'A different Community record is already paired with this local song family; the duplicate record was quarantined.'
        });
        await checkpoint();
        continue;
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
          signal,
          familySnapshotVector(
            parsedRemote[0]?.song.translationOf
              || parsedRemote[0]?.song.id,
            families.get(
              parsedRemote[0]?.song.translationOf
                || parsedRemote[0]?.song.id
            ) || null
          )
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

    if (!allowWrites) {
      if (!requestedFamilyId) state.cursor = remotePage.cursor;
      if (!exactRemote) state.lastSyncAt = this._timestamp();
      await checkpoint();
      return Object.freeze({
        ...result,
        warnings: Object.freeze(result.warnings),
        cursor: state.cursor
      });
    }

    for (const family of families.values()) {
      assertNotAborted(signal);
      if (requestedFamilyId && family.id !== requestedFamilyId) continue;
      if ((requestedFamilyWasAmbiguous && family.id === requestedFamilyId)
        || currentMatches.ambiguousFamilies.has(family.id)) {
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
      if (!songState) {
        songState = Object.values(state.songs).find(song =>
          !hasRemoteIdentity(song)
          && (song.localFamilyId === family.id || song.syncId === family.id)
        ) || null;
      }
      const syncDocuments = family.documents.map(document => ({
        id: document.song.id,
        source: document.source,
        revision: document.revision
      }));

      try {
        if (!songState
          || (songState.syncVersion === null && songState.remoteRevision === null)) {
          const requestedSharing = explicitMemberSharing.get(family.id) || null;
          const requestedSubmission = explicitSubmissions.get(family.id) || null;
          if (!requestedSharing
            && isMemberVisible(songState?.pendingVisibility?.visibility)) {
            result.status = 'needs-review';
            result.reviewRequired += 1;
            result.warnings.push({
              code: 'SONG_MEMBER_SHARING_REVIEW_REQUIRED',
              syncId: family.id,
              message: 'An older queued member-sharing choice was cleared. The family was staged privately; open Review and share to send the exact online transaction.'
            });
          }
          assertNotAborted(signal);
          const submissionFields = reviewedSubmissionFields(
            requestedSubmission?.review,
            requestedSubmission?.visibility || 'private'
          );
          const created = await this.client.createSong({
            syncId: family.id,
            syncDocuments,
            visibility: 'private',
            publishAt: null,
            ...submissionFields,
            idempotencyKey: crypto.createHash('sha256')
              .update(`${this.connectionId}:${family.id}`)
              .digest('hex'),
            accessToken,
            signal
          });
          assertNotAborted(signal);
          assertSongMutationResponse(created, {
            syncId: family.id,
            syncDocuments,
            visibility: 'private',
            publishAt: null,
            rightsStatus: submissionFields.rightsStatus || null,
            rightsNotes: submissionFields.rightsNotes || null
          });
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
          await checkpoint();
          if (requestedSharing) {
            const applied = await this._shareWithMembers({
              family,
              song: created,
              ...requestedSharing,
              accessToken,
              signal
            });
            assertSongMutationResponse(applied.song, {
              syncId: family.id,
              expectedSyncVersion: created.syncVersion,
              syncDocuments,
              visibility: requestedSharing.visibility,
              publishAt: requestedSharing.publishAt
            });
            songState = stateFromRemote(songState, applied.song, {
              localFamilyId: family.id,
              documents: documentsState(
                family.documents,
                applied.song.syncDocuments
              ),
              conflict: null,
              pendingVisibility: null,
              syncedAt
            });
            state.songs[applied.song.syncId] = songState;
            await checkpoint();
          }
          result.pushed += 1;
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
        if (songState.conflict
          && songState.pendingVisibility?.visibility === 'private') {
          assertNotAborted(signal);
          const latest = assertRemoteSongIdentity(await this.client.getSong({
            syncId: songState.syncId,
            accessToken,
            signal
          }), songState.syncId);
          assertNotAborted(signal);
          assertRemoteSongContinuity(songState, latest);
          if (latest.archived) {
            state.songs[songState.syncId] = stateFromRemote(songState, latest, {
              localFamilyId: family.id,
              documents: songState.documents,
              conflict: refreshedRemoteConflict(songState.conflict, latest),
              pendingVisibility: null,
              syncedAt
            });
            result.archived += 1;
            result.conflicts += 1;
            await checkpoint();
            continue;
          }
          let restricted = latest;
          if (latest.visibility !== 'private' || latest.publishAt !== null) {
            restricted = await this.client.updateSong({
              syncId: songState.syncId,
              visibility: 'private',
              publishAt: null,
              expectedSyncVersion: latest.syncVersion,
              accessToken,
              signal
            });
            assertNotAborted(signal);
            assertPrivateDemotion(restricted, {
              syncId: songState.syncId,
              expectedSyncVersion: latest.syncVersion,
              syncDocuments: latest.syncDocuments || []
            });
            result.pushed += 1;
          } else {
            assertPrivateDemotion(restricted, {
              syncId: songState.syncId,
              expectedSyncVersion: null,
              syncDocuments: latest.syncDocuments || []
            });
          }
          state.songs[songState.syncId] = stateFromRemote(songState, restricted, {
            localFamilyId: family.id,
            documents: songState.documents,
            conflict: refreshedRemoteConflict(songState.conflict, restricted),
            pendingVisibility: null,
            syncedAt
          });
          result.conflicts += 1;
          result.warnings.push({
            code: 'CONFLICT_RETAINED',
            syncId: songState.syncId,
            message: 'Member access was restricted to admins; the local and Community content conflict remains for review.'
          });
          await checkpoint();
          continue;
        }
        if (songState.conflict) continue;
        const trackedDocuments = songState.documents || {};
        const missingDocumentIds = missingTrackedDocumentIds(family, trackedDocuments);
        if (missingDocumentIds.length > 0) {
          assertNotAborted(signal);
          const requestedSyncId = songState.syncId;
          const latest = assertRemoteSongIdentity(await this.client.getSong({
            syncId: requestedSyncId,
            accessToken,
            signal
          }), requestedSyncId);
          assertNotAborted(signal);
          assertRemoteSongContinuity(songState, latest);
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
        const requestedSharing = explicitMemberSharing.get(family.id) || null;
        const requestedSubmission = explicitSubmissions.get(family.id) || null;
        let pending = songState.pendingVisibility;
        if (isMemberVisible(pending?.visibility)) {
          // Schema-v5 and older builds could persist a local public queue.
          // It is not server authority and must never be promoted by a
          // background sync under the transaction contract.
          pending = null;
          songState = {
            ...songState,
            pendingVisibility: null
          };
          state.songs[songState.syncId] = songState;
          result.reviewRequired += 1;
          result.status = 'needs-review';
          result.warnings.push({
            code: 'SONG_MEMBER_SHARING_REVIEW_REQUIRED',
            syncId: songState.syncId,
            message: 'An older queued member-sharing choice was cleared. Open Review and share to send the exact online transaction.'
          });
          await checkpoint();
        }
        if (!localChanged && !pending && !requestedSharing) continue;
        if (!Number.isSafeInteger(songState.syncVersion)) {
          result.warnings.push({
            code: 'REMOTE_VERSION_MISSING',
            syncId: songState.syncId,
            message: 'Community song has no safe compare-and-swap version; it was not overwritten.'
          });
          continue;
        }
        const stagePrivateNeedsReview = localChanged
          && isMemberVisible(songState.visibility)
          && !requestedSharing
          && pending?.visibility !== 'private';
        if (localChanged
          && pending?.visibility === 'private'
          && isMemberVisible(songState.visibility)) {
          assertNotAborted(signal);
          const demoted = await this.client.updateSong({
            syncId: songState.syncId,
            visibility: 'private',
            publishAt: null,
            expectedSyncVersion: songState.syncVersion,
            accessToken,
            signal
          });
          assertNotAborted(signal);
          assertPrivateDemotion(demoted, {
            syncId: songState.syncId,
            expectedSyncVersion: songState.syncVersion,
            trackedDocuments
          });
          songState = stateFromRemote(songState, demoted, {
            localFamilyId: family.id,
            documents: trackedDocuments,
            conflict: null,
            pendingVisibility: null,
            syncedAt
          });
          state.songs[demoted.syncId] = songState;
          pending = null;
          result.pushed += 1;
          await checkpoint();
        }
        let current = songState;
        if (localChanged || pending?.visibility === 'private') {
          const mustDemote = isMemberVisible(current.visibility);
          assertNotAborted(signal);
          const submissionFields = reviewedSubmissionFields(
            requestedSubmission?.review,
            requestedSubmission?.visibility || current.visibility
          );
          const updated = await this.client.updateSong({
            syncId: current.syncId,
            syncDocuments: localChanged ? syncDocuments : undefined,
            ...submissionFields,
            ...(mustDemote || pending?.visibility === 'private'
              ? {
                  visibility: 'private',
                  publishAt: null
                }
              : {}),
            expectedSyncVersion: current.syncVersion,
            accessToken,
            signal
          });
          assertNotAborted(signal);
          assertSongMutationResponse(updated, {
            syncId: current.syncId,
            expectedSyncVersion: current.syncVersion,
            syncDocuments: localChanged ? syncDocuments : null,
            visibility: mustDemote || pending?.visibility === 'private'
              ? 'private'
              : current.visibility,
            publishAt: mustDemote || pending?.visibility === 'private'
              ? null
              : current.publishAt,
            rightsStatus: submissionFields.rightsStatus || null,
            rightsNotes: submissionFields.rightsNotes || null
          });
          current = stateFromRemote(current, updated, {
            localFamilyId: family.id,
            documents: localChanged
              ? documentsState(family.documents, updated.syncDocuments)
              : trackedDocuments,
            conflict: null,
            pendingVisibility: null,
            syncedAt
          });
          state.songs[updated.syncId] = current;
          await checkpoint();
          if (stagePrivateNeedsReview) {
            addRightsReviewWarning(result, songState.syncId, 'stale');
          }
        }
        if (requestedSharing) {
          const applied = await this._shareWithMembers({
            family,
            song: current,
            ...requestedSharing,
            accessToken,
            signal
          });
          assertSongMutationResponse(applied.song, {
            syncId: current.syncId,
            expectedSyncVersion: current.syncVersion,
            syncDocuments,
            visibility: requestedSharing.visibility,
            publishAt: requestedSharing.publishAt
          });
          current = stateFromRemote(current, applied.song, {
            localFamilyId: family.id,
            documents: documentsState(
              family.documents,
              applied.song.syncDocuments
            ),
            conflict: null,
            pendingVisibility: null,
            syncedAt
          });
          state.songs[applied.song.syncId] = current;
          await checkpoint();
        }
        result.pushed += 1;
      } catch (error) {
        assertNotAborted(signal);
        if (error instanceof CommunityClientError
          && error.code === 'REVISION_CONFLICT') {
          let latest = null;
          try {
            const requestedSyncId = songState?.syncId || family.id;
            latest = assertRemoteSongIdentity(await this.client.getSong({
              syncId: requestedSyncId,
              accessToken,
              signal
            }), requestedSyncId);
          } catch (getError) {
            return this._offlineResult(getError, result, state.cursor);
          }
          assertNotAborted(signal);
          assertRemoteSongContinuity(songState, latest);
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

  pullSong(syncId, {
    expectedSyncVersion,
    expectedRevision,
    signal = null
  } = {}) {
    return this.sync({
      syncId,
      allowWrites: false,
      signal,
      exactRemote: {
        expectedSyncVersion,
        expectedRevision
      }
    });
  }

  async resolveConflict(syncId, {
    strategy,
    expectedSyncVersion,
    expectedLocalRevision,
    signal = null
  } = {}) {
    await this.familyImportCoordinator.recover();
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
    const reconciledFamilySnapshots = new Map(
      [...families].map(([id, candidate]) => [
        id,
        familySnapshotVector(id, candidate)
      ])
    );
    const familyId = songState.localFamilyId || syncId;
    const family = families.get(familyId);
    if (!family) fail('LOCAL_FAMILY_NOT_FOUND', 'The local song family is unavailable.');
    if (family.revision !== expectedLocalRevision) {
      fail('RESOLUTION_STALE', 'The local song changed; reload the conflict before resolving it.');
    }
    if (strategy === 'keep-local'
      && missingTrackedDocumentIds(family, songState.documents).length > 0) {
      fail(
        'MISSING_LOCAL_DOCUMENTS',
        'Restore the missing local song documents, or keep the Community copy. SyncShow will not delete them from Community without a deliberate removal workflow.'
      );
    }
    const accessToken = this._token(await this.accessTokenProvider());
    assertNotAborted(signal);
    const latest = assertRemoteSongIdentity(
      await this.client.getSong({ syncId, accessToken, signal }),
      syncId
    );
    assertRemoteSongContinuity(songState, latest);
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
      let pendingVisibility = songState.pendingVisibility;
      if (isMemberVisible(pendingVisibility?.visibility)) {
        pendingVisibility = null;
      }
      let currentRemote = latest;
      if (pendingVisibility?.visibility === 'private'
        && isMemberVisible(currentRemote.visibility)) {
        assertNotAborted(signal);
        const demotionExpectedSyncVersion = currentRemote.syncVersion;
        const demotionDocuments = currentRemote.syncDocuments || [];
        currentRemote = await this.client.updateSong({
          syncId,
          visibility: 'private',
          publishAt: null,
          expectedSyncVersion: currentRemote.syncVersion,
          accessToken,
          signal
        });
        assertNotAborted(signal);
        assertPrivateDemotion(currentRemote, {
          syncId,
          expectedSyncVersion: demotionExpectedSyncVersion,
          syncDocuments: demotionDocuments
        });
        state.songs[syncId] = stateFromRemote(songState, currentRemote, {
          localFamilyId: family.id,
          documents: songState.documents,
          conflict: songState.conflict,
          pendingVisibility: null,
          syncedAt
        });
        await this.stateStore.saveConnectionState(this.connectionId, state);
        pendingVisibility = null;
      }
      const targetVisibility = pendingVisibility?.visibility
        || currentRemote.visibility;
      const targetPublishAt = pendingVisibility
        ? pendingVisibility.publishAt
        : currentRemote.publishAt;
      if (isMemberVisible(targetVisibility)) {
        await this._memberSharingReview(family);
      }
      assertNotAborted(signal);
      const updated = await this.client.updateSong({
        syncId,
        syncDocuments,
        ...(isMemberVisible(targetVisibility)
          || pendingVisibility?.visibility === 'private'
          ? {
              visibility: 'private',
              publishAt: null
            }
          : {}),
        expectedSyncVersion: currentRemote.syncVersion,
        accessToken,
        signal
      });
      assertNotAborted(signal);
      assertSongMutationResponse(updated, {
        syncId,
        expectedSyncVersion: currentRemote.syncVersion,
        syncDocuments,
        visibility: isMemberVisible(targetVisibility)
          || pendingVisibility?.visibility === 'private'
          ? 'private'
          : currentRemote.visibility,
        publishAt: isMemberVisible(targetVisibility)
          || pendingVisibility?.visibility === 'private'
          ? null
          : currentRemote.publishAt
      });
      let finalRemote = updated;
      state.songs[syncId] = stateFromRemote(songState, updated, {
        localFamilyId: family.id,
        documents: documentsState(family.documents, updated.syncDocuments),
        conflict: null,
        pendingVisibility: null,
        syncedAt
      });
      await this.stateStore.saveConnectionState(this.connectionId, state);
      if (isMemberVisible(targetVisibility)) {
        const applied = await this._shareWithMembers({
          family,
          song: updated,
          visibility: targetVisibility,
          publishAt: targetPublishAt,
          accessToken,
          signal
        });
        assertSongMutationResponse(applied.song, {
          syncId,
          expectedSyncVersion: updated.syncVersion,
          syncDocuments,
          visibility: targetVisibility,
          publishAt: targetPublishAt
        });
        finalRemote = applied.song;
        state.songs[syncId] = stateFromRemote(state.songs[syncId], finalRemote, {
          localFamilyId: family.id,
          documents: documentsState(
            family.documents,
            finalRemote.syncDocuments
          ),
          conflict: null,
          pendingVisibility: null,
          syncedAt
        });
        await this.stateStore.saveConnectionState(this.connectionId, state);
      }
      return Object.freeze({
        resolved: true,
        strategy,
        syncId,
        syncVersion: finalRemote.syncVersion
      });
    }

    if (latest.archived || latest.metadataOnly || !latest.syncDocuments?.length) {
      fail(
        'REMOTE_CONTENT_UNAVAILABLE',
        'The Community record has no active song documents to keep.'
      );
    }
    const remoteDocuments = parseRemoteDocuments(latest);
    const remoteFamilyId = remoteDocuments[0]?.song.translationOf
      || remoteDocuments[0]?.song.id;
    await this._applyRemoteDocumentsAtomically(
      remoteDocuments,
      signal,
      reconciledFamilySnapshots.get(remoteFamilyId)
        || familySnapshotVector(remoteFamilyId)
    );
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
