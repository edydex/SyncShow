'use strict';

const fs = require('fs/promises');
const path = require('path');

const {
  atomicWriteFile,
  ensurePrivateDirectory,
  readFileNoFollow
} = require('../project/StorageSafety');
const {
  createSongSharingReview,
  normalizeSongSharingReview,
  songSharingReviewRevision
} = require('./CommunitySongSharingReview');
const {
  createSongPublicLinkReview,
  normalizeSongPublicLinkReview,
  songPublicLinkReviewRevision
} = require('./CommunitySongPublicLinkReview');
const {
  CommunitySongMemberSharingError,
  normalizeSongMemberSharingReceipt
} = require('./CommunitySongMemberSharing');

const LEGACY_STATE_SCHEMA_VERSION = 1;
const INLINE_SERMON_CONFLICT_STATE_SCHEMA_VERSION = 2;
const PRE_SHARING_REVIEW_STATE_SCHEMA_VERSION = 3;
const PRE_PUBLIC_LINK_REVIEW_STATE_SCHEMA_VERSION = 4;
const PRE_MEMBER_SHARING_RECEIPT_STATE_SCHEMA_VERSION = 5;
const STATE_SCHEMA_VERSION = 6;
const MAX_STORE_BYTES = 16 * 1024 * 1024;
const MAX_CONNECTIONS = 64;
const MAX_SONGS_PER_CONNECTION = 10000;
const MAX_SONG_SHARING_REVIEWS_PER_CONNECTION = 10000;
const MAX_SONG_PUBLIC_LINK_REVIEWS_PER_CONNECTION = 10000;
const MAX_SERMONS_PER_CONNECTION = 10000;
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const CONNECTION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{7,99}$/;
const REVISION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:"/-]{0,255}$/;
const SERMON_REVISION_PATTERN = /^[a-f0-9]{64}$/;
const VISIBILITIES = new Set(['private', 'public', 'scheduled-public']);

class CommunitySyncStateStoreError extends Error {
  constructor(code, message, { cause = null } = {}) {
    super(message);
    this.name = 'CommunitySyncStateStoreError';
    this.code = code;
    this.cause = cause;
  }
}

function fail(code, message, cause = null) {
  throw new CommunitySyncStateStoreError(code, message, { cause });
}

function dictionary() {
  return Object.create(null);
}

function ownValue(object, key, fallback = null) {
  return object && Object.prototype.hasOwnProperty.call(object, key)
    ? object[key]
    : fallback;
}

function boundedText(value, label, maximum, {
  required = false,
  pattern = null,
  fallback = null
} = {}) {
  if (value === undefined || value === null || value === '') {
    if (required) fail('INVALID_STATE', `${label} is required.`);
    return fallback;
  }
  if (typeof value !== 'string') fail('INVALID_STATE', `${label} must be text.`);
  const normalized = value.trim();
  if (!normalized
    || normalized.length > maximum
    || /[\u0000-\u001f\u007f]/.test(normalized)
    || (pattern && !pattern.test(normalized))) {
    fail('INVALID_STATE', `${label} is invalid.`);
  }
  return normalized;
}

function opaqueCursor(value, label) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string'
    || Buffer.byteLength(value, 'utf8') > 2048
    || /[\u0000-\u001f\u007f]/.test(value)) {
    fail('INVALID_STATE', `${label} is invalid.`);
  }
  return value;
}

function timestamp(value, label, { required = false } = {}) {
  if (value === undefined || value === null || value === '') {
    if (required) fail('INVALID_STATE', `${label} is required.`);
    return null;
  }
  if (typeof value !== 'string' || value.length > 40 || Number.isNaN(Date.parse(value))) {
    fail('INVALID_STATE', `${label} is invalid.`);
  }
  return new Date(value).toISOString();
}

function syncVersion(value, { optional = true } = {}) {
  if ((value === undefined || value === null) && optional) return null;
  if (!Number.isSafeInteger(value) || value < 1) fail('INVALID_STATE', 'Sync version is invalid.');
  return value;
}

function visibility(value, publishAt = null) {
  const normalized = value || 'private';
  if (!VISIBILITIES.has(normalized)) fail('INVALID_VISIBILITY', 'Song visibility is invalid.');
  const normalizedPublishAt = timestamp(publishAt, 'Scheduled publication time');
  if (normalized === 'scheduled-public' && !normalizedPublishAt) {
    fail('INVALID_VISIBILITY', 'Scheduled-public songs require a publication time.');
  }
  if (normalized !== 'scheduled-public' && normalizedPublishAt) {
    fail('INVALID_VISIBILITY', 'Only scheduled-public songs may have a publication time.');
  }
  return { visibility: normalized, publishAt: normalizedPublishAt };
}

function normalizeDocuments(value = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail('INVALID_STATE', 'Song document state is invalid.');
  }
  const entries = Object.entries(value);
  if (entries.length > 32) fail('INVALID_STATE', 'A song family has too many documents.');
  const result = dictionary();
  for (const [key, document] of entries) {
    const id = boundedText(key, 'Song document ID', 128, {
      required: true,
      pattern: ID_PATTERN
    });
    if (!document || typeof document !== 'object' || Array.isArray(document)) {
      fail('INVALID_STATE', 'Song document state is invalid.');
    }
    result[id] = {
      localRevision: boundedText(document.localRevision, 'Local revision', 256, {
        pattern: REVISION_PATTERN
      }),
      remoteRevision: boundedText(document.remoteRevision, 'Remote revision', 256, {
        pattern: REVISION_PATTERN
      })
    };
  }
  return result;
}

function normalizeConflict(value) {
  if (value === undefined || value === null) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail('INVALID_STATE', 'Song conflict state is invalid.');
  }
  const documents = Array.isArray(value.remoteDocuments) ? value.remoteDocuments : [];
  if (documents.length > 32) fail('INVALID_STATE', 'A song conflict has too many documents.');
  let totalBytes = 0;
  const remoteDocuments = documents.map(document => {
    if (!document || typeof document !== 'object' || Array.isArray(document)) {
      fail('INVALID_STATE', 'A song conflict document is invalid.');
    }
    const source = typeof document.source === 'string' ? document.source : '';
    const sourceBytes = Buffer.byteLength(source, 'utf8');
    totalBytes += sourceBytes;
    if (sourceBytes > 512 * 1024 || totalBytes > 2 * 1024 * 1024) {
      fail('INVALID_STATE', 'A song conflict is too large to preserve safely.');
    }
    return {
      id: boundedText(document.id, 'Conflict document ID', 128, {
        required: true,
        pattern: ID_PATTERN
      }),
      source,
      revision: boundedText(document.revision, 'Conflict document revision', 256, {
        pattern: REVISION_PATTERN
      })
    };
  });
  const remoteSyncVersion = syncVersion(value.remoteSyncVersion);
  return {
    code: boundedText(value.code, 'Conflict code', 80, {
      required: true,
      pattern: /^[A-Z][A-Z0-9_]{2,79}$/
    }),
    detectedAt: timestamp(value.detectedAt, 'Conflict time', { required: true }),
    localRevision: boundedText(value.localRevision, 'Conflict local revision', 256, {
      pattern: REVISION_PATTERN
    }),
    remoteRevision: boundedText(value.remoteRevision, 'Conflict remote revision', 256, {
      pattern: REVISION_PATTERN
    }),
    ...(remoteSyncVersion === null ? {} : { remoteSyncVersion }),
    remoteDocuments
  };
}

function normalizeSharingReview(value) {
  try {
    // Keep pre-transaction CCLI/SongSelect review records as local audit
    // evidence. The sharing-review status marks that retired basis unusable,
    // so it cannot authorize the new Community-owned member-share transaction.
    return normalizeSongSharingReview(value, {
      required: true,
      allowLegacyBasis: true
    });
  } catch (error) {
    fail('INVALID_STATE', error?.message || 'Song sharing review is invalid.');
  }
}

function normalizeSongSharingReviews(value = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail('INVALID_STATE', 'Saved song sharing reviews are invalid.');
  }
  const entries = Object.entries(value);
  if (entries.length > MAX_SONG_SHARING_REVIEWS_PER_CONNECTION) {
    fail('INVALID_STATE', 'Saved community sync state contains too many song sharing reviews.');
  }
  const reviews = dictionary();
  for (const [familyId, review] of entries) {
    const id = boundedText(familyId, 'Local song family ID', 128, {
      required: true,
      pattern: ID_PATTERN
    });
    reviews[id] = normalizeSharingReview(review);
  }
  return reviews;
}

function normalizePublicLinkReview(value) {
  try {
    // Schema 5 briefly stored dated reviews before the exact operator-local
    // boundary was part of the review digest. Preserve those audit records,
    // but the review contract marks them boundary-missing and they cannot
    // authorize a link until a manager reviews the family again.
    return normalizeSongPublicLinkReview(value, {
      required: true,
      allowLegacyBoundary: true
    });
  } catch (error) {
    fail('INVALID_STATE', error?.message || 'Song public-link review is invalid.');
  }
}

function normalizeSongPublicLinkReviews(value = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail('INVALID_STATE', 'Saved song public-link reviews are invalid.');
  }
  const entries = Object.entries(value);
  if (entries.length > MAX_SONG_PUBLIC_LINK_REVIEWS_PER_CONNECTION) {
    fail(
      'INVALID_STATE',
      'Saved community sync state contains too many song public-link reviews.'
    );
  }
  const reviews = dictionary();
  for (const [familyId, review] of entries) {
    const id = boundedText(familyId, 'Local song family ID', 128, {
      required: true,
      pattern: ID_PATTERN
    });
    reviews[id] = normalizePublicLinkReview(review);
  }
  return reviews;
}

function defaultSongState(syncId) {
  return {
    syncId,
    localFamilyId: null,
    remoteTitle: null,
    alternateTitles: [],
    syncVersion: null,
    remoteRevision: null,
    documents: dictionary(),
    visibility: 'private',
    publishAt: null,
    memberSharing: null,
    effectiveVisibility: null,
    pendingVisibility: null,
    archived: false,
    metadataOnly: false,
    lastSyncedAt: null,
    conflict: null
  };
}

function normalizeSongState(value, expectedId = null, {
  allowMemberSharing = true
} = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail('INVALID_STATE', 'Saved song sync state is invalid.');
  }
  const syncId = boundedText(value.syncId || expectedId, 'Song sync ID', 128, {
    required: true,
    pattern: ID_PATTERN
  });
  if (expectedId && expectedId !== syncId) fail('INVALID_STATE', 'Saved song sync IDs conflict.');
  const normalizedVisibility = visibility(value.visibility, value.publishAt);
  let memberSharing = null;
  if (allowMemberSharing
    && value.memberSharing !== undefined
    && value.memberSharing !== null) {
    try {
      memberSharing = normalizeSongMemberSharingReceipt(value.memberSharing);
    } catch (error) {
      if (error instanceof CommunitySongMemberSharingError) {
        fail('INVALID_STATE', error.message);
      }
      throw error;
    }
  }
  const effectiveVisibility = !allowMemberSharing
    || value.effectiveVisibility === undefined
    || value.effectiveVisibility === null
    ? null
    : value.effectiveVisibility;
  if (effectiveVisibility !== null
    && !['private', 'public'].includes(effectiveVisibility)) {
    fail('INVALID_STATE', 'Effective song visibility is invalid.');
  }
  const alternateTitles = value.alternateTitles === undefined ? [] : value.alternateTitles;
  if (!Array.isArray(alternateTitles) || alternateTitles.length > 32) {
    fail('INVALID_STATE', 'Saved alternate song titles are invalid.');
  }
  let pendingVisibility = null;
  if (value.pendingVisibility) {
    if (typeof value.pendingVisibility !== 'object' || Array.isArray(value.pendingVisibility)) {
      fail('INVALID_STATE', 'Pending song visibility is invalid.');
    }
    const pending = visibility(
      value.pendingVisibility.visibility,
      value.pendingVisibility.publishAt
    );
    pendingVisibility = {
      ...pending,
      expectedSyncVersion: syncVersion(value.pendingVisibility.expectedSyncVersion)
    };
  }
  return {
    syncId,
    localFamilyId: boundedText(value.localFamilyId, 'Local song family ID', 128, {
      pattern: ID_PATTERN
    }),
    remoteTitle: boundedText(value.remoteTitle, 'Remote song title', 240),
    alternateTitles: alternateTitles.map(title =>
      boundedText(title, 'Alternate song title', 240, { required: true })),
    syncVersion: syncVersion(value.syncVersion),
    remoteRevision: boundedText(value.remoteRevision, 'Remote song revision', 256, {
      pattern: REVISION_PATTERN
    }),
    documents: normalizeDocuments(value.documents),
    ...normalizedVisibility,
    memberSharing,
    effectiveVisibility,
    pendingVisibility,
    archived: value.archived === true,
    metadataOnly: value.metadataOnly === true,
    lastSyncedAt: timestamp(value.lastSyncedAt, 'Last sync time'),
    conflict: normalizeConflict(value.conflict)
  };
}

function defaultSermonState(syncId) {
  return {
    syncId,
    localSermonId: null,
    syncVersion: null,
    localRevision: null,
    remoteRevision: null,
    lastSyncedAt: null,
    conflict: null
  };
}

function normalizeSermonConflict(value) {
  if (value === undefined || value === null) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail('INVALID_STATE', 'Sermon conflict state is invalid.');
  }
  return {
    code: boundedText(value.code, 'Sermon conflict code', 80, {
      required: true,
      pattern: /^[A-Z][A-Z0-9_]{2,79}$/
    }),
    detectedAt: timestamp(value.detectedAt, 'Sermon conflict time', { required: true }),
    localRevision: boundedText(value.localRevision, 'Sermon conflict local revision', 256, {
      pattern: SERMON_REVISION_PATTERN
    }),
    lastSyncedLocalRevision: boundedText(
      value.lastSyncedLocalRevision,
      'Sermon conflict last synced local revision',
      256,
      { pattern: SERMON_REVISION_PATTERN }
    ),
    remoteRevision: boundedText(
      value.remoteRevision,
      'Sermon conflict remote revision',
      256,
      {
        required: true,
        pattern: SERMON_REVISION_PATTERN
      }
    ),
    remoteSyncVersion: syncVersion(value.remoteSyncVersion, { optional: false })
  };
}

function normalizeSermonState(value, expectedId = null) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail('INVALID_STATE', 'Saved sermon sync state is invalid.');
  }
  const syncId = boundedText(
    value.syncId === undefined ? expectedId : value.syncId,
    'Sermon sync ID',
    128,
    {
      required: true,
      pattern: ID_PATTERN
    }
  );
  if (expectedId && expectedId !== syncId) {
    fail('INVALID_STATE', 'Saved sermon sync IDs conflict.');
  }
  const normalizedSyncVersion = syncVersion(value.syncVersion);
  const remoteRevision = boundedText(
    value.remoteRevision,
    'Remote sermon revision',
    256,
    { pattern: SERMON_REVISION_PATTERN }
  );
  if ((normalizedSyncVersion === null) !== (remoteRevision === null)) {
    fail(
      'INVALID_STATE',
      'Saved sermon sync version and remote revision must be recorded together.'
    );
  }
  return {
    syncId,
    localSermonId: boundedText(value.localSermonId, 'Local sermon ID', 128, {
      pattern: ID_PATTERN
    }),
    syncVersion: normalizedSyncVersion,
    localRevision: boundedText(value.localRevision, 'Local sermon revision', 256, {
      pattern: SERMON_REVISION_PATTERN
    }),
    remoteRevision,
    lastSyncedAt: timestamp(value.lastSyncedAt, 'Last sermon sync time'),
    conflict: normalizeSermonConflict(value.conflict)
  };
}

function normalizeConnectionState(value = {}, {
  schemaVersion = STATE_SCHEMA_VERSION
} = {}) {
  const legacy = schemaVersion === LEGACY_STATE_SCHEMA_VERSION;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail('INVALID_STATE', 'Saved community sync state is invalid.');
  }
  const songsValue = value.songs || {};
  if (!songsValue || typeof songsValue !== 'object' || Array.isArray(songsValue)) {
    fail('INVALID_STATE', 'Saved song sync states are invalid.');
  }
  const entries = Object.entries(songsValue);
  if (entries.length > MAX_SONGS_PER_CONNECTION) {
    fail('INVALID_STATE', 'Saved community sync state contains too many songs.');
  }
  const songs = dictionary();
  for (const [syncId, song] of entries) {
    songs[syncId] = normalizeSongState(song, syncId, {
      allowMemberSharing:
        schemaVersion >= STATE_SCHEMA_VERSION
    });
  }
  const sermonsValue = legacy
    ? {}
    : (value.sermons === undefined ? {} : value.sermons);
  if (!sermonsValue || typeof sermonsValue !== 'object' || Array.isArray(sermonsValue)) {
    fail('INVALID_STATE', 'Saved sermon sync states are invalid.');
  }
  const sermonEntries = Object.entries(sermonsValue);
  if (sermonEntries.length > MAX_SERMONS_PER_CONNECTION) {
    fail('INVALID_STATE', 'Saved community sync state contains too many sermons.');
  }
  const sermons = dictionary();
  for (const [syncId, sermon] of sermonEntries) {
    sermons[syncId] = normalizeSermonState(sermon, syncId);
  }
  return {
    cursor: boundedText(value.cursor, 'Sync cursor', 2048),
    lastSyncAt: timestamp(value.lastSyncAt, 'Last sync time'),
    songs,
    songSharingReviews: schemaVersion >= PRE_PUBLIC_LINK_REVIEW_STATE_SCHEMA_VERSION
      ? normalizeSongSharingReviews(value.songSharingReviews)
      : dictionary(),
    songPublicLinkReviews:
      schemaVersion >= PRE_MEMBER_SHARING_RECEIPT_STATE_SCHEMA_VERSION
      ? normalizeSongPublicLinkReviews(value.songPublicLinkReviews)
      : dictionary(),
    sermonCursor: legacy
      ? null
      : opaqueCursor(value.sermonCursor, 'Sermon sync cursor'),
    lastSermonSyncAt: legacy
      ? null
      : timestamp(value.lastSermonSyncAt, 'Last sermon sync time'),
    sermons
  };
}

function clone(value) {
  if (Array.isArray(value)) return value.map(clone);
  if (value && typeof value === 'object') {
    const result = Object.getPrototypeOf(value) === null ? dictionary() : {};
    for (const [key, entry] of Object.entries(value)) result[key] = clone(entry);
    return result;
  }
  return value;
}

class CommunitySyncStateStore {
  constructor({ storageRoot, now = () => new Date() } = {}) {
    if (typeof storageRoot !== 'string' || !path.isAbsolute(storageRoot)) {
      throw new TypeError('Community sync state storage root must be absolute');
    }
    if (typeof now !== 'function') throw new TypeError('Community sync state clock must be a function');
    this.storageRoot = path.resolve(storageRoot);
    this.storePath = path.join(this.storageRoot, 'sync-state.json');
    this.now = now;
    this.writeQueue = Promise.resolve();
  }

  _timestamp() {
    const current = this.now();
    const parsed = current instanceof Date ? current : new Date(current);
    if (Number.isNaN(parsed.getTime())) throw new TypeError('Community sync state clock is invalid');
    return parsed.toISOString();
  }

  async _read() {
    await ensurePrivateDirectory(this.storageRoot);
    let buffer;
    try {
      ({ buffer } = await readFileNoFollow(this.storePath, MAX_STORE_BYTES));
    } catch (error) {
      if (error.code === 'ENOENT') return dictionary();
      fail('STORE_READ_FAILED', 'Saved community sync state could not be read.', error?.code);
    }
    let payload;
    try {
      payload = JSON.parse(buffer.toString('utf8'));
    } catch (_error) {
      fail('CORRUPT_STORE', 'Saved community sync state is corrupt.');
    }
    if (!payload
      || ![
        LEGACY_STATE_SCHEMA_VERSION,
        INLINE_SERMON_CONFLICT_STATE_SCHEMA_VERSION,
        PRE_SHARING_REVIEW_STATE_SCHEMA_VERSION,
        PRE_PUBLIC_LINK_REVIEW_STATE_SCHEMA_VERSION,
        PRE_MEMBER_SHARING_RECEIPT_STATE_SCHEMA_VERSION,
        STATE_SCHEMA_VERSION
      ].includes(payload.schemaVersion)
      || !payload.connections
      || typeof payload.connections !== 'object'
      || Array.isArray(payload.connections)
      || Object.keys(payload.connections).length > MAX_CONNECTIONS) {
      fail('CORRUPT_STORE', 'Saved community sync state is corrupt.');
    }
    const connections = dictionary();
    for (const [connectionId, state] of Object.entries(payload.connections)) {
      boundedText(connectionId, 'Connection ID', 100, {
        required: true,
        pattern: CONNECTION_ID_PATTERN
      });
      connections[connectionId] = normalizeConnectionState(state, {
        schemaVersion: payload.schemaVersion
      });
    }
    return connections;
  }

  async _write(connections) {
    const serialized = `${JSON.stringify({
      schemaVersion: STATE_SCHEMA_VERSION,
      connections
    }, null, 2)}\n`;
    if (Buffer.byteLength(serialized, 'utf8') > MAX_STORE_BYTES) {
      fail('STORE_TOO_LARGE', 'Community sync state is too large to save safely.');
    }
    try {
      await atomicWriteFile(this.storePath, serialized, {
        rootPath: this.storageRoot,
        maximumBytes: MAX_STORE_BYTES,
        mode: 0o600
      });
    } catch (error) {
      fail('STORE_WRITE_FAILED', 'Community sync state could not be saved.', error?.code);
    }
  }

  _serialize(operation) {
    const result = this.writeQueue.then(operation, operation);
    this.writeQueue = result.then(() => undefined, () => undefined);
    return result;
  }

  _connectionId(value) {
    return boundedText(value, 'Connection ID', 100, {
      required: true,
      pattern: CONNECTION_ID_PATTERN
    });
  }

  async getConnectionState(connectionId) {
    const id = this._connectionId(connectionId);
    const connections = await this._read();
    const state = ownValue(connections, id, normalizeConnectionState());
    return clone(state);
  }

  async getSongState(connectionId, syncId) {
    const id = boundedText(syncId, 'Song sync ID', 128, {
      required: true,
      pattern: ID_PATTERN
    });
    const state = await this.getConnectionState(connectionId);
    return clone(ownValue(state.songs, id, defaultSongState(id)));
  }

  async getSongSharingReview(connectionId, familyId) {
    const id = boundedText(familyId, 'Local song family ID', 128, {
      required: true,
      pattern: ID_PATTERN
    });
    const state = await this.getConnectionState(connectionId);
    return clone(ownValue(state.songSharingReviews, id));
  }

  async getSongPublicLinkReview(connectionId, familyId) {
    const id = boundedText(familyId, 'Local song family ID', 128, {
      required: true,
      pattern: ID_PATTERN
    });
    const state = await this.getConnectionState(connectionId);
    return clone(ownValue(state.songPublicLinkReviews, id));
  }

  async getSermonState(connectionId, syncId) {
    const id = boundedText(syncId, 'Sermon sync ID', 128, {
      required: true,
      pattern: ID_PATTERN
    });
    const state = await this.getConnectionState(connectionId);
    return clone(ownValue(state.sermons, id, defaultSermonState(id)));
  }

  saveConnectionState(connectionId, state) {
    const id = this._connectionId(connectionId);
    const normalized = normalizeConnectionState(state);
    return this._serialize(async () => {
      const connections = await this._read();
      const latest = ownValue(connections, id, normalizeConnectionState());
      // Local sharing reviews are store-owned draft/recovery records. A stale
      // whole-state synchronization checkpoint may neither erase nor
      // resurrect them; only a Community receipt can confirm member access.
      normalized.songSharingReviews = latest.songSharingReviews;
      normalized.songPublicLinkReviews = latest.songPublicLinkReviews;
      connections[id] = normalized;
      await this._write(connections);
      return clone(normalized);
    });
  }

  confirmSongSharingReview(connectionId, familyId, requested = {}) {
    const connection = this._connectionId(connectionId);
    const songFamilyId = boundedText(familyId, 'Local song family ID', 128, {
      required: true,
      pattern: ID_PATTERN
    });
    if (!requested
      || typeof requested !== 'object'
      || Array.isArray(requested)
      || Object.keys(requested).some(key =>
        ![
          'basis',
          'evidence',
          'validUntil',
          'familyRevision',
          'expectedReviewRevision'
        ].includes(key))) {
      fail('INVALID_SHARING_REVIEW', 'Song sharing review request is invalid.');
    }
    const expectedReviewRevision = requested.expectedReviewRevision === undefined
      || requested.expectedReviewRevision === null
      ? null
      : boundedText(
          requested.expectedReviewRevision,
          'Expected song sharing review revision',
          64,
          { required: true, pattern: /^[a-f0-9]{64}$/ }
        );
    return this._serialize(async () => {
      const connections = await this._read();
      const state = ownValue(connections, connection, normalizeConnectionState());
      const current = ownValue(state.songSharingReviews, songFamilyId);
      if (songSharingReviewRevision(current) !== expectedReviewRevision) {
        fail('STATE_CONFLICT', 'Song sharing review changed since it was opened.');
      }
      let review;
      try {
        review = createSongSharingReview(requested, {
          familyRevision: requested.familyRevision,
          reviewedAt: this._timestamp()
        });
      } catch (error) {
        fail(
          'INVALID_SHARING_REVIEW',
          error?.message || 'Song sharing review is invalid.'
        );
      }
      if (!Object.prototype.hasOwnProperty.call(
        state.songSharingReviews,
        songFamilyId
      ) && Object.keys(state.songSharingReviews).length
        >= MAX_SONG_SHARING_REVIEWS_PER_CONNECTION) {
        fail(
          'INVALID_STATE',
          'Saved community sync state contains too many song sharing reviews.'
        );
      }
      state.songSharingReviews[songFamilyId] = review;
      connections[connection] = normalizeConnectionState(state);
      await this._write(connections);
      return clone(review);
    });
  }

  clearSongSharingReview(connectionId, familyId, {
    expectedFamilyRevision,
    expectedReviewRevision
  } = {}) {
    const connection = this._connectionId(connectionId);
    const songFamilyId = boundedText(familyId, 'Local song family ID', 128, {
      required: true,
      pattern: ID_PATTERN
    });
    const expectedRevision = boundedText(
      expectedFamilyRevision,
      'Expected reviewed song-family revision',
      64,
      {
        required: true,
        pattern: /^[a-f0-9]{64}$/
      }
    );
    const expectedReview = boundedText(
      expectedReviewRevision,
      'Expected song sharing review revision',
      64,
      {
        required: true,
        pattern: /^[a-f0-9]{64}$/
      }
    );
    return this._serialize(async () => {
      const connections = await this._read();
      const state = ownValue(connections, connection, normalizeConnectionState());
      const current = ownValue(state.songSharingReviews, songFamilyId);
      if (current && current.familyRevision !== expectedRevision) {
        fail('STATE_CONFLICT', 'Song sharing review changed since it was opened.');
      }
      if (songSharingReviewRevision(current) !== expectedReview) {
        fail('STATE_CONFLICT', 'Song sharing review changed since it was opened.');
      }
      const removed = Object.prototype.hasOwnProperty.call(
        state.songSharingReviews,
        songFamilyId
      );
      delete state.songSharingReviews[songFamilyId];
      connections[connection] = state;
      await this._write(connections);
      return { removed };
    });
  }

  confirmSongPublicLinkReview(connectionId, familyId, requested = {}) {
    const connection = this._connectionId(connectionId);
    const songFamilyId = boundedText(familyId, 'Local song family ID', 128, {
      required: true,
      pattern: ID_PATTERN
    });
    if (!requested
      || typeof requested !== 'object'
      || Array.isArray(requested)
      || Object.keys(requested).some(key =>
        ![
          'basis',
          'evidence',
          'validUntil',
          'validThrough',
          'familyRevision',
          'expectedReviewRevision'
        ].includes(key))) {
      fail(
        'INVALID_PUBLIC_LINK_REVIEW',
        'Song public-link review request is invalid.'
      );
    }
    const expectedReviewRevision = requested.expectedReviewRevision === undefined
      || requested.expectedReviewRevision === null
      ? null
      : boundedText(
          requested.expectedReviewRevision,
          'Expected song public-link review revision',
          64,
          { required: true, pattern: /^[a-f0-9]{64}$/ }
        );
    return this._serialize(async () => {
      const connections = await this._read();
      const state = ownValue(connections, connection, normalizeConnectionState());
      const current = ownValue(state.songPublicLinkReviews, songFamilyId);
      if (songPublicLinkReviewRevision(current) !== expectedReviewRevision) {
        fail('STATE_CONFLICT', 'Song public-link review changed since it was opened.');
      }
      let review;
      try {
        review = createSongPublicLinkReview(requested, {
          familyRevision: requested.familyRevision,
          reviewedAt: this._timestamp()
        });
      } catch (error) {
        fail(
          'INVALID_PUBLIC_LINK_REVIEW',
          error?.message || 'Song public-link review is invalid.'
        );
      }
      if (!Object.prototype.hasOwnProperty.call(
        state.songPublicLinkReviews,
        songFamilyId
      ) && Object.keys(state.songPublicLinkReviews).length
        >= MAX_SONG_PUBLIC_LINK_REVIEWS_PER_CONNECTION) {
        fail(
          'INVALID_STATE',
          'Saved community sync state contains too many song public-link reviews.'
        );
      }
      state.songPublicLinkReviews[songFamilyId] = review;
      connections[connection] = normalizeConnectionState(state);
      await this._write(connections);
      return clone(review);
    });
  }

  clearSongPublicLinkReview(connectionId, familyId, {
    expectedFamilyRevision,
    expectedReviewRevision
  } = {}) {
    const connection = this._connectionId(connectionId);
    const songFamilyId = boundedText(familyId, 'Local song family ID', 128, {
      required: true,
      pattern: ID_PATTERN
    });
    const expectedRevision = boundedText(
      expectedFamilyRevision,
      'Expected reviewed song-family revision',
      64,
      {
        required: true,
        pattern: /^[a-f0-9]{64}$/
      }
    );
    const expectedReview = boundedText(
      expectedReviewRevision,
      'Expected song public-link review revision',
      64,
      {
        required: true,
        pattern: /^[a-f0-9]{64}$/
      }
    );
    return this._serialize(async () => {
      const connections = await this._read();
      const state = ownValue(connections, connection, normalizeConnectionState());
      const current = ownValue(state.songPublicLinkReviews, songFamilyId);
      if (current && current.familyRevision !== expectedRevision) {
        fail('STATE_CONFLICT', 'Song public-link review changed since it was opened.');
      }
      if (songPublicLinkReviewRevision(current) !== expectedReview) {
        fail('STATE_CONFLICT', 'Song public-link review changed since it was opened.');
      }
      const removed = Object.prototype.hasOwnProperty.call(
        state.songPublicLinkReviews,
        songFamilyId
      );
      delete state.songPublicLinkReviews[songFamilyId];
      connections[connection] = state;
      await this._write(connections);
      return { removed };
    });
  }

  setSongVisibility(connectionId, syncId, requested = {}) {
    const connection = this._connectionId(connectionId);
    const songId = boundedText(syncId, 'Song sync ID', 128, {
      required: true,
      pattern: ID_PATTERN
    });
    const requestedVisibility = visibility(requested.visibility, requested.publishAt);
    const expectedSyncVersion = syncVersion(requested.expectedSyncVersion);
    return this._serialize(async () => {
      const connections = await this._read();
      const state = ownValue(connections, connection, normalizeConnectionState());
      const song = ownValue(state.songs, songId, defaultSongState(songId));
      if (expectedSyncVersion !== null
        && song.syncVersion !== null
        && expectedSyncVersion !== song.syncVersion) {
        fail('STATE_CONFLICT', 'Song visibility changed since it was opened.');
      }
      if (song.syncVersion !== null && expectedSyncVersion === null) {
        fail(
          'STATE_CONFLICT',
          'Reload this song before changing its visibility so the server revision can be checked.'
        );
      }
      song.pendingVisibility = { ...requestedVisibility, expectedSyncVersion };
      state.songs[songId] = normalizeSongState(song, songId);
      connections[connection] = state;
      await this._write(connections);
      return clone(ownValue(state.songs, songId));
    });
  }

  recordConflict(connectionId, syncId, conflict) {
    const connection = this._connectionId(connectionId);
    const songId = boundedText(syncId, 'Song sync ID', 128, {
      required: true,
      pattern: ID_PATTERN
    });
    return this._serialize(async () => {
      const connections = await this._read();
      const state = ownValue(connections, connection, normalizeConnectionState());
      const song = ownValue(state.songs, songId, defaultSongState(songId));
      song.conflict = normalizeConflict({
        ...conflict,
        detectedAt: conflict?.detectedAt || this._timestamp()
      });
      state.songs[songId] = normalizeSongState(song, songId);
      connections[connection] = state;
      await this._write(connections);
      return clone(ownValue(state.songs, songId));
    });
  }

  async listConflicts(connectionId) {
    const state = await this.getConnectionState(connectionId);
    return Object.values(state.songs)
      .filter(song => song.conflict)
      .map(song => ({ syncId: song.syncId, ...clone(song.conflict) }));
  }

  removeConnectionState(connectionId) {
    const id = this._connectionId(connectionId);
    return this._serialize(async () => {
      const connections = await this._read();
      const removed = Object.prototype.hasOwnProperty.call(connections, id);
      delete connections[id];
      await this._write(connections);
      return { removed };
    });
  }
}

module.exports = {
  CommunitySyncStateStore,
  CommunitySyncStateStoreError,
  STATE_SCHEMA_VERSION,
  LEGACY_STATE_SCHEMA_VERSION,
  INLINE_SERMON_CONFLICT_STATE_SCHEMA_VERSION,
  PRE_SHARING_REVIEW_STATE_SCHEMA_VERSION,
  PRE_PUBLIC_LINK_REVIEW_STATE_SCHEMA_VERSION,
  PRE_MEMBER_SHARING_RECEIPT_STATE_SCHEMA_VERSION,
  VISIBILITIES,
  normalizeSermonConflict,
  normalizeSermonState,
  normalizeSongState
};
