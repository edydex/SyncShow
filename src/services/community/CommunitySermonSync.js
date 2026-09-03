'use strict';

const crypto = require('crypto');

const { MAX_SERMON_SOURCE_BYTES } = require('../sermon/SermonDocument');

const MAX_REMOTE_PAGES = 100;
const MAX_REMOTE_ITEMS = 10000;
const MAX_PAGE_ITEMS = 100;
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const REVISION_PATTERN = /^[a-f0-9]{64}$/;
const OFFLINE_CODES = new Set([
  'NETWORK_ERROR',
  'REQUEST_TIMEOUT',
  'SERVER_UNAVAILABLE',
  'RATE_LIMITED'
]);

class CommunitySermonSyncError extends Error {
  constructor(code, message, { cause = null, details = {} } = {}) {
    super(message);
    this.name = 'CommunitySermonSyncError';
    this.code = code;
    this.cause = cause;
    this.details = details;
  }
}

function fail(code, message, cause = null, details = {}) {
  throw new CommunitySermonSyncError(code, message, { cause, details });
}

function ownValue(object, key, fallback = null) {
  return object && Object.prototype.hasOwnProperty.call(object, key)
    ? object[key]
    : fallback;
}

function assertNotAborted(signal) {
  if (!signal?.aborted) return;
  const error = new CommunitySermonSyncError(
    'SYNC_CANCELLED',
    'Community sermon synchronization was cancelled.'
  );
  error.name = 'AbortError';
  throw error;
}

function normalizeId(value, label = 'Sermon sync ID') {
  if (typeof value !== 'string' || !ID_PATTERN.test(value)) {
    fail('INVALID_SYNC_ID', `${label} is invalid.`);
  }
  return value;
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

function remoteObservation(previous, remote, {
  localRevision = previous.localRevision,
  conflict = previous.conflict,
  syncedAt
} = {}) {
  return {
    ...previous,
    syncId: remote.syncId,
    localSermonId: remote.syncId,
    syncVersion: remote.syncVersion,
    localRevision,
    remoteRevision: remote.revision,
    lastSyncedAt: syncedAt,
    conflict
  };
}

function conflictFor(previous, remote, localRevision, code, detectedAt) {
  return {
    code,
    detectedAt,
    localRevision: localRevision || null,
    lastSyncedLocalRevision: previous.localRevision || null,
    remoteRevision: remote.revision,
    remoteSyncVersion: remote.syncVersion
  };
}

function frozenResult(value) {
  return Object.freeze({
    ...value,
    warnings: Object.freeze(value.warnings || [])
  });
}

class CommunitySermonSync {
  constructor({
    client,
    localLibrary,
    stateStore,
    connectionId,
    accessTokenProvider,
    now = () => new Date()
  } = {}) {
    if (!client
      || typeof client.listSermonChanges !== 'function'
      || typeof client.getSermon !== 'function'
      || typeof client.createSermon !== 'function'
      || typeof client.updateSermon !== 'function') {
      throw new TypeError('CommunitySermonSync requires a CommunityClient-compatible client');
    }
    if (!localLibrary
      || typeof localLibrary.read !== 'function'
      || typeof localLibrary.readRevision !== 'function'
      || typeof localLibrary.validateSource !== 'function'
      || typeof localLibrary.saveSource !== 'function'
      || typeof localLibrary.stageSource !== 'function') {
      throw new TypeError('CommunitySermonSync requires a LocalSermonLibrary-compatible library');
    }
    if (!stateStore
      || typeof stateStore.getConnectionState !== 'function'
      || typeof stateStore.saveConnectionState !== 'function') {
      throw new TypeError(
        'CommunitySermonSync requires a CommunitySyncStateStore-compatible store'
      );
    }
    if (typeof connectionId !== 'string'
      || !/^[A-Za-z0-9][A-Za-z0-9_-]{7,99}$/.test(connectionId)) {
      throw new TypeError('CommunitySermonSync connection ID is invalid');
    }
    if (typeof accessTokenProvider !== 'function' || typeof now !== 'function') {
      throw new TypeError('CommunitySermonSync dependencies are invalid');
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
    if (Number.isNaN(parsed.getTime())) {
      throw new TypeError('Community sermon sync clock is invalid');
    }
    return parsed.toISOString();
  }

  _token(value) {
    const token = typeof value === 'string' ? value : value?.accessToken;
    if (typeof token !== 'string' || token.length < 16) {
      fail('AUTH_REQUIRED', 'Community sermon authorization is unavailable.');
    }
    return token;
  }

  _isOffline(error) {
    return Boolean(error?.retryable) || OFFLINE_CODES.has(error?.code);
  }

  async _readLocal(syncId) {
    try {
      return await this.localLibrary.read(syncId);
    } catch (error) {
      if (error?.code === 'SERMON_NOT_FOUND') return null;
      throw error;
    }
  }

  _assertStateIdentity(previous, syncId) {
    if (previous.localSermonId !== null
      && previous.localSermonId !== undefined
      && previous.localSermonId !== syncId) {
      fail(
        'SERMON_IDENTITY_CONFLICT',
        'Saved sermon synchronization state points to a different local sermon.',
        null,
        {
          syncId,
          localSermonId: previous.localSermonId
        }
      );
    }
  }

  _assertRemoteContinuity(previous, remote) {
    if (previous.syncVersion === null || previous.syncVersion === undefined) return;
    if (remote.syncVersion < previous.syncVersion) {
      fail(
        'REMOTE_SYNC_VERSION_REGRESSION',
        'Community sermon sync version moved backwards.',
        null,
        { syncId: remote.syncId }
      );
    }
    if (!previous.remoteRevision) return;
    if (remote.syncVersion === previous.syncVersion
      && remote.revision !== previous.remoteRevision) {
      fail(
        'REMOTE_SYNC_VERSION_REUSED',
        'Community reused a sermon sync version for different canonical content.',
        null,
        { syncId: remote.syncId }
      );
    }
  }

  _assertEnvelopeShape(remote, syncId = null) {
    if (!remote || typeof remote !== 'object' || Array.isArray(remote)) {
      fail('INVALID_REMOTE_SERMON', 'Community returned an invalid sermon envelope.');
    }
    const id = normalizeId(remote.syncId);
    if (syncId !== null && id !== syncId) {
      fail('REMOTE_ID_MISMATCH', 'Community returned a different sermon identity.');
    }
    if (!Number.isSafeInteger(remote.syncVersion) || remote.syncVersion < 1) {
      fail('INVALID_REMOTE_SERMON', 'Community returned an invalid sermon sync version.');
    }
    if (typeof remote.revision !== 'string' || !REVISION_PATTERN.test(remote.revision)) {
      fail('INVALID_REMOTE_SERMON', 'Community returned an invalid sermon revision.');
    }
    if (typeof remote.documentSource !== 'string'
      || Buffer.byteLength(remote.documentSource, 'utf8') > MAX_SERMON_SOURCE_BYTES) {
      fail('INVALID_REMOTE_SERMON', 'Community returned an invalid sermon document source.');
    }
    if (typeof remote.archived !== 'boolean'
      || typeof remote.updatedAt !== 'string'
      || Number.isNaN(Date.parse(remote.updatedAt))) {
      fail('INVALID_REMOTE_SERMON', 'Community returned invalid sermon metadata.');
    }
    return id;
  }

  async _verifyEnvelope(remote, {
    summary = null,
    expectedSyncId = null
  } = {}) {
    const syncId = this._assertEnvelopeShape(remote, expectedSyncId);
    if (summary
      && (
        summary.syncId !== remote.syncId
        || summary.syncVersion !== remote.syncVersion
        || summary.revision !== remote.revision
        || summary.archived !== remote.archived
        || summary.updatedAt !== remote.updatedAt
      )) {
      fail(
        'REMOTE_CHANGED_DURING_PULL',
        'A Community sermon changed between its change summary and document read.',
        null,
        { syncId }
      );
    }

    let validated;
    try {
      validated = await this.localLibrary.validateSource(remote.documentSource, {
        expectedSermonId: syncId
      });
    } catch (error) {
      fail(
        'INVALID_REMOTE_SERMON',
        'Community returned a sermon that failed local canonical validation.',
        error?.code || error?.name || 'validation-failed',
        { syncId }
      );
    }
    if (validated.revision !== remote.revision) {
      fail(
        'REMOTE_REVISION_MISMATCH',
        'Community sermon source does not match its advertised revision.',
        null,
        { syncId }
      );
    }
    const documentArchived = validated.sermon.publication.status === 'archived';
    if (documentArchived !== remote.archived) {
      fail(
        'REMOTE_ARCHIVE_MISMATCH',
        'Community sermon archive metadata conflicts with its canonical document.',
        null,
        { syncId }
      );
    }
    return { remote, validated };
  }

  _assertSummary(summary) {
    if (!summary || typeof summary !== 'object' || Array.isArray(summary)) {
      fail('INVALID_REMOTE_PAGE', 'Community returned an invalid sermon change summary.');
    }
    normalizeId(summary.syncId);
    if (!Number.isSafeInteger(summary.syncVersion) || summary.syncVersion < 1) {
      fail('INVALID_REMOTE_PAGE', 'Community returned an invalid sermon change summary.');
    }
    if (typeof summary.revision !== 'string' || !REVISION_PATTERN.test(summary.revision)) {
      fail('INVALID_REMOTE_PAGE', 'Community returned an invalid sermon change summary.');
    }
    if (typeof summary.archived !== 'boolean'
      || typeof summary.updatedAt !== 'string'
      || Number.isNaN(Date.parse(summary.updatedAt))) {
      fail('INVALID_REMOTE_PAGE', 'Community returned an invalid sermon change summary.');
    }
  }

  async _remoteSnapshot(cursor, accessToken, signal) {
    const summaries = [];
    const seenIds = new Set();
    const intermediateCursors = new Set();
    let requestCursor = cursor;

    for (let pageNumber = 0; pageNumber < MAX_REMOTE_PAGES; pageNumber += 1) {
      assertNotAborted(signal);
      const page = await this.client.listSermonChanges({
        cursor: requestCursor,
        limit: MAX_PAGE_ITEMS,
        accessToken,
        signal
      });
      if (!page
        || typeof page !== 'object'
        || !Array.isArray(page.items)
        || page.items.length > MAX_PAGE_ITEMS
        || typeof page.hasMore !== 'boolean'
        || typeof page.nextCursor !== 'string'
        || page.nextCursor.length < 1
        || page.nextCursor.length > 2048
        || /[\u0000-\u001f\u007f]/.test(page.nextCursor)) {
        fail('INVALID_REMOTE_PAGE', 'Community returned an invalid sermon change page.');
      }
      if (page.hasMore && page.items.length === 0) {
        fail(
          'INVALID_REMOTE_CURSOR',
          'A continuing Community sermon page cannot be empty.'
        );
      }
      for (const summary of page.items) {
        this._assertSummary(summary);
        if (seenIds.has(summary.syncId)) {
          fail(
            'INVALID_REMOTE_PAGE',
            'Community sermon changes repeated a sermon identity.',
            null,
            { syncId: summary.syncId }
          );
        }
        seenIds.add(summary.syncId);
        summaries.push(summary);
      }
      if (summaries.length > MAX_REMOTE_ITEMS) {
        fail(
          'REMOTE_LIBRARY_TOO_LARGE',
          'Community sermon changes are too large to synchronize safely.'
        );
      }

      if (!page.hasMore) {
        const retainedEmptyPageCursor = page.items.length === 0
          && page.nextCursor === requestCursor;
        if (
          (!retainedEmptyPageCursor && page.nextCursor === requestCursor)
          || (
            pageNumber > 0
            && !retainedEmptyPageCursor
            && (
              page.nextCursor === cursor
              || intermediateCursors.has(page.nextCursor)
            )
          )
        ) {
          fail(
            'INVALID_REMOTE_CURSOR',
            'Community sermon synchronization returned a cyclic final cursor.'
          );
        }
        return {
          summaries,
          cursor: page.nextCursor
        };
      }
      if (page.nextCursor === requestCursor
        || intermediateCursors.has(page.nextCursor)) {
        fail(
          'INVALID_REMOTE_CURSOR',
          'Community sermon synchronization cursor did not advance.'
        );
      }
      intermediateCursors.add(page.nextCursor);
      requestCursor = page.nextCursor;
    }
    fail(
      'REMOTE_PAGE_LIMIT',
      'Community sermon synchronization returned too many pages.'
    );
  }

  async _stageRemoteRevision(remote, local) {
    let expectedRevision = local?.revision || null;
    if (expectedRevision === remote.revision) {
      await this.localLibrary.readRevision(remote.syncId, remote.revision);
      return local;
    }

    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const staged = await this.localLibrary.stageSource(remote.documentSource, {
          expectedSermonId: remote.syncId,
          expectedRevision
        });
        if (staged.revision !== remote.revision) {
          fail(
            'REMOTE_REVISION_MISMATCH',
            'Community sermon source did not stage under its advertised revision.',
            null,
            { syncId: remote.syncId }
          );
        }
        await this.localLibrary.readRevision(remote.syncId, remote.revision);
        return await this._readLocal(remote.syncId);
      } catch (error) {
        if (error?.code !== 'SERMON_CONFLICT') throw error;
        const current = await this._readLocal(remote.syncId);
        if (current?.revision === remote.revision) {
          await this.localLibrary.readRevision(remote.syncId, remote.revision);
          return current;
        }
        if (attempt === 0) {
          expectedRevision = current?.revision || null;
          continue;
        }
        fail(
          'LOCAL_REVISION_RACE',
          'The local sermon kept changing while its Community revision was being preserved.',
          error,
          {
            syncId: remote.syncId,
            currentLocalRevision: current?.revision || null
          }
        );
      }
    }
  }

  async _recordConflict(previous, remote, local, code, syncedAt) {
    const currentLocal = await this._stageRemoteRevision(remote, local);
    const conflict = conflictFor(
      previous,
      remote,
      currentLocal?.revision || null,
      code,
      syncedAt
    );
    return remoteObservation(previous, remote, {
      localRevision: previous.localRevision,
      conflict,
      syncedAt
    });
  }

  async _applyRemote(previous, remote, syncedAt, signal) {
    this._assertStateIdentity(previous, remote.syncId);
    this._assertRemoteContinuity(previous, remote);
    let local = await this._readLocal(remote.syncId);
    assertNotAborted(signal);

    if (local?.revision === remote.revision) {
      return {
        outcome: 'unchanged',
        state: remoteObservation(previous, remote, {
          localRevision: local.revision,
          conflict: null,
          syncedAt
        })
      };
    }

    if (!local || (previous.localRevision && local.revision === previous.localRevision)) {
      const expectedRevision = local?.revision || null;
      try {
        const saved = await this.localLibrary.saveSource(remote.documentSource, {
          expectedSermonId: remote.syncId,
          expectedRevision
        });
        assertNotAborted(signal);
        return {
          outcome: 'pulled',
          state: remoteObservation(previous, remote, {
            localRevision: saved.revision,
            conflict: null,
            syncedAt
          })
        };
      } catch (error) {
        if (error?.code !== 'SERMON_CONFLICT') throw error;
        local = await this._readLocal(remote.syncId);
        assertNotAborted(signal);
        // This is the expected crash/retry shape when the local CAS committed
        // but its sync-state checkpoint did not.
        if (local?.revision === remote.revision) {
          return {
            outcome: 'unchanged',
            state: remoteObservation(previous, remote, {
              localRevision: local.revision,
              conflict: null,
              syncedAt
            })
          };
        }
        return {
          outcome: 'conflict',
          state: await this._recordConflict(
            previous,
            remote,
            local,
            'LOCAL_CAS_CONFLICT',
            syncedAt
          )
        };
      }
    }

    const code = previous.localRevision === null
      ? 'INDEPENDENT_FIRST_SYNC'
      : previous.remoteRevision !== remote.revision
        ? 'BOTH_CHANGED'
        : 'LOCAL_DIVERGED';
    return {
      outcome: 'conflict',
      state: await this._recordConflict(previous, remote, local, code, syncedAt)
    };
  }

  async pullSermon(syncId, {
    expectedSyncVersion,
    expectedRevision,
    signal = null
  } = {}) {
    const id = normalizeId(syncId);
    if (!Number.isSafeInteger(expectedSyncVersion) || expectedSyncVersion < 1) {
      fail(
        'INVALID_REMOTE_PRECONDITION',
        'An exact Community sermon pull requires a valid reviewed version.'
      );
    }
    if (
      typeof expectedRevision !== 'string'
      || !REVISION_PATTERN.test(expectedRevision)
    ) {
      fail(
        'INVALID_REMOTE_PRECONDITION',
        'An exact Community sermon pull requires a valid reviewed revision.'
      );
    }
    assertNotAborted(signal);
    let state = await this.stateStore.getConnectionState(this.connectionId);
    const result = {
      status: 'synced',
      pulled: 0,
      unchanged: 0,
      conflicts: 0,
      warnings: []
    };

    let accessToken;
    try {
      accessToken = this._token(await this.accessTokenProvider());
    } catch (error) {
      if (!this._isOffline(error)) throw error;
      return frozenResult({
        ...result,
        status: 'offline',
        cursor: state.sermonCursor,
        warnings: [{
          code: error.code,
          message: 'Local sermons remain available; the exact Community sermon will retry later.'
        }]
      });
    }

    let envelope;
    try {
      envelope = await this.client.getSermon({
        syncId: id,
        accessToken,
        signal
      });
    } catch (error) {
      assertNotAborted(signal);
      if (!this._isOffline(error)) throw error;
      return frozenResult({
        ...result,
        status: 'offline',
        cursor: state.sermonCursor,
        warnings: [{
          code: error.code,
          message: 'Local sermons remain available; the exact Community sermon will retry later.'
        }]
      });
    }
    const { remote } = await this._verifyEnvelope(envelope, {
      expectedSyncId: id
    });
    assertNotAborted(signal);
    if (
      remote.syncVersion !== expectedSyncVersion
      || remote.revision !== expectedRevision
    ) {
      fail(
        'REMOTE_PRECONDITION_FAILED',
        'The Community sermon no longer matches the exact reviewed version.',
        null,
        {
          syncId: id,
          expectedSyncVersion,
          currentSyncVersion: remote.syncVersion,
          expectedRevision,
          currentRevision: remote.revision
        }
      );
    }

    const previous = ownValue(
      state.sermons,
      id,
      defaultSermonState(id)
    );
    const syncedAt = this._timestamp();
    const applied = await this._applyRemote(
      previous,
      remote,
      syncedAt,
      signal
    );
    state.sermons[id] = applied.state;
    if (applied.outcome === 'pulled') result.pulled = 1;
    else if (applied.outcome === 'conflict') {
      result.conflicts = 1;
      result.warnings.push({
        code: applied.state.conflict.code,
        syncId: id,
        message: 'Local and Community sermon revisions differ; both were preserved for review.'
      });
    } else {
      result.unchanged = 1;
    }
    state = await this.stateStore.saveConnectionState(this.connectionId, state);
    return frozenResult({
      ...result,
      cursor: state.sermonCursor,
      syncId: id,
      syncVersion: remote.syncVersion,
      revision: remote.revision
    });
  }

  async pull({ signal = null } = {}) {
    assertNotAborted(signal);
    let state = await this.stateStore.getConnectionState(this.connectionId);
    const result = {
      status: 'synced',
      pulled: 0,
      unchanged: 0,
      conflicts: 0,
      warnings: []
    };

    let accessToken;
    try {
      accessToken = this._token(await this.accessTokenProvider());
    } catch (error) {
      if (!this._isOffline(error)) throw error;
      return frozenResult({
        ...result,
        status: 'offline',
        cursor: state.sermonCursor,
        warnings: [{
          code: error.code,
          message: 'Local sermons remain available; Community sermon sync will retry later.'
        }]
      });
    }

    let snapshot;
    try {
      snapshot = await this._remoteSnapshot(state.sermonCursor, accessToken, signal);
    } catch (error) {
      assertNotAborted(signal);
      if (!this._isOffline(error)) throw error;
      return frozenResult({
        ...result,
        status: 'offline',
        cursor: state.sermonCursor,
        warnings: [{
          code: error.code,
          message: 'Local sermons remain available; Community sermon sync will retry later.'
        }]
      });
    }

    const syncedAt = this._timestamp();
    for (const summary of snapshot.summaries) {
      assertNotAborted(signal);
      let remote;
      try {
        remote = await this.client.getSermon({
          syncId: summary.syncId,
          accessToken,
          signal
        });
      } catch (error) {
        assertNotAborted(signal);
        if (!this._isOffline(error)) throw error;
        return frozenResult({
          ...result,
          status: 'offline',
          cursor: state.sermonCursor,
          warnings: [
            ...result.warnings,
            {
              code: error.code,
              message: 'Verified sermon changes were kept, but the Community cursor will retry after reconnecting.'
            }
          ]
        });
      }
      const verified = await this._verifyEnvelope(remote, {
        summary,
        expectedSyncId: summary.syncId
      });
      assertNotAborted(signal);
      const previous = ownValue(
        state.sermons,
        verified.remote.syncId,
        defaultSermonState(verified.remote.syncId)
      );
      const applied = await this._applyRemote(
        previous,
        verified.remote,
        syncedAt,
        signal
      );
      state.sermons[verified.remote.syncId] = applied.state;
      if (applied.outcome === 'pulled') result.pulled += 1;
      else if (applied.outcome === 'conflict') {
        result.conflicts += 1;
        result.warnings.push({
          code: applied.state.conflict.code,
          syncId: verified.remote.syncId,
          message: 'Local and Community sermon revisions differ; both were preserved for review.'
        });
      } else {
        result.unchanged += 1;
      }
      // Checkpoint the exact applied record without advancing the durable feed
      // cursor. A retry can safely recognize a committed local revision even
      // when this state write fails.
      state = await this.stateStore.saveConnectionState(this.connectionId, state);
    }

    assertNotAborted(signal);
    state.sermonCursor = snapshot.cursor;
    state.lastSermonSyncAt = syncedAt;
    state = await this.stateStore.saveConnectionState(this.connectionId, state);
    return frozenResult({
      ...result,
      cursor: state.sermonCursor
    });
  }

  sync(options = {}) {
    return this.pull(options);
  }

  async _adoptWriteEnvelope(state, local, remote, syncedAt) {
    const previous = ownValue(
      state.sermons,
      remote.syncId,
      defaultSermonState(remote.syncId)
    );
    this._assertStateIdentity(previous, remote.syncId);
    this._assertRemoteContinuity(previous, remote);
    if (remote.revision === local.revision) {
      state.sermons[remote.syncId] = remoteObservation(previous, remote, {
        localRevision: local.revision,
        conflict: null,
        syncedAt
      });
      return { state, conflict: false };
    }
    state.sermons[remote.syncId] = await this._recordConflict(
      previous,
      remote,
      local,
      previous.syncVersion === null ? 'CREATE_CONFLICT' : 'REMOTE_CAS_CONFLICT',
      syncedAt
    );
    return { state, conflict: true };
  }

  async _fetchAfterWriteConflict(syncId, local, state, accessToken, signal, syncedAt) {
    const latest = await this.client.getSermon({
      syncId,
      accessToken,
      signal
    });
    const { remote } = await this._verifyEnvelope(latest, { expectedSyncId: syncId });
    assertNotAborted(signal);
    return this._adoptWriteEnvelope(state, local, remote, syncedAt);
  }

  async pushSermon(localSermonId, {
    syncId = localSermonId,
    expectedSyncVersion = undefined,
    expectedLocalRevision = undefined,
    signal = null
  } = {}) {
    const localId = normalizeId(localSermonId, 'Local sermon ID');
    const remoteId = normalizeId(syncId);
    if (localId !== remoteId) {
      fail(
        'SERMON_IDENTITY_CONFLICT',
        'Community sermons may synchronize only under their exact stable local ID.'
      );
    }
    if (expectedSyncVersion !== undefined
      && expectedSyncVersion !== null
      && (!Number.isSafeInteger(expectedSyncVersion) || expectedSyncVersion < 1)) {
      fail('INVALID_SYNC_VERSION', 'Expected sermon sync version is invalid.');
    }
    if (typeof expectedLocalRevision !== 'string'
      || !REVISION_PATTERN.test(expectedLocalRevision)) {
      fail(
        'INVALID_LOCAL_REVISION',
        'Expected local sermon revision is required.'
      );
    }
    assertNotAborted(signal);
    const local = await this.localLibrary.read(localId);
    if (local.revision !== expectedLocalRevision) {
      fail(
        'LOCAL_REVISION_CONFLICT',
        'The local sermon changed since this upload was opened.',
        null,
        {
          syncId: remoteId,
          expectedLocalRevision,
          currentLocalRevision: local.revision
        }
      );
    }
    let state = await this.stateStore.getConnectionState(this.connectionId);
    const previous = ownValue(
      state.sermons,
      remoteId,
      defaultSermonState(remoteId)
    );
    this._assertStateIdentity(previous, remoteId);
    if (previous.conflict) {
      fail(
        'UNRESOLVED_SERMON_CONFLICT',
        'Resolve the saved local and Community sermon conflict before uploading.'
      );
    }
    if (expectedSyncVersion !== undefined
      && expectedSyncVersion !== previous.syncVersion) {
      fail(
        'STATE_CONFLICT',
        'The Community sermon changed since this upload was opened.'
      );
    }

    const accessToken = this._token(await this.accessTokenProvider());
    const syncedAt = this._timestamp();
    let operation;
    let adoption;
    try {
      if (previous.syncVersion === null) {
        operation = 'created';
        const created = await this.client.createSermon({
          syncId: remoteId,
          documentSource: local.documentSource || local.source,
          idempotencyKey: crypto.createHash('sha256')
            .update(`${this.connectionId}:sermon:${remoteId}:${local.revision}`)
            .digest('hex'),
          accessToken,
          signal
        });
        const { remote } = await this._verifyEnvelope(created, {
          expectedSyncId: remoteId
        });
        adoption = await this._adoptWriteEnvelope(
          state,
          local,
          remote,
          syncedAt
        );
      } else if (local.revision === previous.localRevision
        && local.revision === previous.remoteRevision) {
        const current = await this.client.getSermon({
          syncId: remoteId,
          accessToken,
          signal
        });
        const { remote } = await this._verifyEnvelope(current, {
          expectedSyncId: remoteId
        });
        assertNotAborted(signal);
        const exactCheckpoint = remote.syncVersion === previous.syncVersion
          && remote.revision === previous.remoteRevision;
        adoption = await this._adoptWriteEnvelope(
          state,
          local,
          remote,
          syncedAt
        );
        operation = adoption.conflict
          ? 'conflict'
          : exactCheckpoint
            ? 'unchanged'
            : 'adopted';
      } else {
        operation = 'updated';
        const updated = await this.client.updateSermon({
          syncId: remoteId,
          documentSource: local.documentSource || local.source,
          expectedSyncVersion: previous.syncVersion,
          accessToken,
          signal
        });
        const { remote } = await this._verifyEnvelope(updated, {
          expectedSyncId: remoteId
        });
        adoption = await this._adoptWriteEnvelope(
          state,
          local,
          remote,
          syncedAt
        );
      }
    } catch (error) {
      assertNotAborted(signal);
      if (error?.code !== 'REVISION_CONFLICT') throw error;
      adoption = await this._fetchAfterWriteConflict(
        remoteId,
        local,
        state,
        accessToken,
        signal,
        syncedAt
      );
      operation = adoption.conflict ? 'conflict' : 'adopted';
    }

    state = adoption.state;
    state.lastSermonSyncAt = syncedAt;
    state = await this.stateStore.saveConnectionState(this.connectionId, state);
    const saved = state.sermons[remoteId];
    if (adoption.conflict) {
      return frozenResult({
        status: 'conflict',
        operation: 'conflict',
        syncId: remoteId,
        revision: local.revision,
        syncVersion: saved.syncVersion,
        warnings: [{
          code: saved.conflict.code,
          syncId: remoteId,
          message: 'Community changed before upload; both sermon revisions were preserved.'
        }]
      });
    }
    return frozenResult({
      status: 'synced',
      operation,
      syncId: remoteId,
      revision: local.revision,
      syncVersion: saved.syncVersion,
      warnings: []
    });
  }

  _resolutionState(state, syncId, expectedSyncVersion) {
    const previous = ownValue(state.sermons, syncId);
    if (!previous?.conflict) {
      fail(
        'CONFLICT_NOT_FOUND',
        'This sermon no longer has a saved local and Community conflict.'
      );
    }
    this._assertStateIdentity(previous, syncId);
    const conflict = previous.conflict;
    if (previous.syncVersion !== expectedSyncVersion
      || previous.remoteRevision !== conflict.remoteRevision
      || conflict.remoteSyncVersion !== expectedSyncVersion) {
      fail(
        'RESOLUTION_STALE',
        'The saved sermon conflict changed; reload it before resolving.'
      );
    }
    return { previous, conflict };
  }

  async _resolutionLocal(syncId, expectedLocalRevision) {
    const local = await this._readLocal(syncId);
    if (!local) {
      fail(
        'LOCAL_SERMON_NOT_FOUND',
        'The local sermon is unavailable; the conflict was not resolved.'
      );
    }
    if (local.revision !== expectedLocalRevision) {
      fail(
        'RESOLUTION_STALE',
        'The local sermon changed; reload the conflict before resolving it.',
        null,
        {
          syncId,
          expectedLocalRevision,
          currentLocalRevision: local.revision
        }
      );
    }
    return local;
  }

  async _savedConflictRemote(syncId, conflict) {
    let saved;
    try {
      saved = await this.localLibrary.readRevision(
        syncId,
        conflict.remoteRevision
      );
    } catch (error) {
      fail(
        'INVALID_SAVED_CONFLICT',
        'The preserved Community sermon revision is unavailable.',
        error?.code || error?.name || 'revision-read-failed',
        { syncId }
      );
    }
    const source = saved.documentSource || saved.source;
    if (typeof source !== 'string'
      || Buffer.byteLength(source, 'utf8') > MAX_SERMON_SOURCE_BYTES) {
      fail(
        'INVALID_SAVED_CONFLICT',
        'The preserved Community sermon revision is too large to resolve safely.'
      );
    }
    let validated;
    try {
      validated = await this.localLibrary.validateSource(source, {
        expectedSermonId: syncId
      });
    } catch (error) {
      fail(
        'INVALID_SAVED_CONFLICT',
        'The saved Community sermon is not a valid canonical sermon.',
        error?.code || error?.name || 'validation-failed',
        { syncId }
      );
    }
    if (validated.revision !== conflict.remoteRevision
      || validated.revision !== saved.revision
      || validated.documentSource !== source) {
      fail(
        'INVALID_SAVED_CONFLICT',
        'The saved Community sermon no longer matches its recorded revision.',
        null,
        { syncId }
      );
    }
    return validated;
  }

  async _checkpointResolutionConflict(
    state,
    previous,
    remote,
    local,
    code,
    syncedAt
  ) {
    state.sermons[remote.syncId] = await this._recordConflict(
      previous,
      remote,
      local,
      code,
      syncedAt
    );
    state.lastSermonSyncAt = syncedAt;
    const savedState = await this.stateStore.saveConnectionState(
      this.connectionId,
      state
    );
    const saved = savedState.sermons[remote.syncId];
    return frozenResult({
      resolved: false,
      status: 'conflict',
      strategy: 'keep-local',
      syncId: remote.syncId,
      revision: local.revision,
      syncVersion: saved.syncVersion,
      warnings: [{
        code: saved.conflict.code,
        syncId: remote.syncId,
        message: 'Community changed during conflict resolution; both sermon revisions remain preserved.'
      }]
    });
  }

  async resolveConflict(syncId, {
    strategy,
    expectedSyncVersion,
    expectedLocalRevision,
    signal = null
  } = {}) {
    const id = normalizeId(syncId);
    if (!['keep-local', 'keep-remote'].includes(strategy)) {
      fail(
        'INVALID_RESOLUTION',
        'Choose whether to keep the local or Community sermon.'
      );
    }
    if (!Number.isSafeInteger(expectedSyncVersion) || expectedSyncVersion < 1) {
      fail(
        'INVALID_RESOLUTION',
        'Reload the sermon conflict before resolving it.'
      );
    }
    if (typeof expectedLocalRevision !== 'string'
      || !REVISION_PATTERN.test(expectedLocalRevision)) {
      fail(
        'INVALID_RESOLUTION',
        'Reload the local sermon before resolving the conflict.'
      );
    }

    assertNotAborted(signal);
    let state = await this.stateStore.getConnectionState(this.connectionId);
    let { previous, conflict } = this._resolutionState(
      state,
      id,
      expectedSyncVersion
    );
    let local = await this._resolutionLocal(id, expectedLocalRevision);
    assertNotAborted(signal);

    if (strategy === 'keep-remote') {
      const remote = await this._savedConflictRemote(id, conflict);
      assertNotAborted(signal);
      let saved;
      try {
        saved = await this.localLibrary.saveSource(remote.documentSource, {
          expectedSermonId: id,
          expectedRevision: expectedLocalRevision
        });
      } catch (error) {
        if (error?.code !== 'SERMON_CONFLICT') throw error;
        const current = await this._readLocal(id);
        fail(
          'RESOLUTION_STALE',
          'The local sermon changed while the Community revision was being restored.',
          error,
          {
            syncId: id,
            expectedLocalRevision,
            currentLocalRevision: current?.revision || null
          }
        );
      }
      assertNotAborted(signal);
      const syncedAt = this._timestamp();
      state.sermons[id] = {
        ...previous,
        syncId: id,
        localSermonId: id,
        syncVersion: expectedSyncVersion,
        localRevision: saved.revision,
        remoteRevision: conflict.remoteRevision,
        lastSyncedAt: syncedAt,
        conflict: null
      };
      state.lastSermonSyncAt = syncedAt;
      state = await this.stateStore.saveConnectionState(this.connectionId, state);
      return frozenResult({
        resolved: true,
        status: 'synced',
        strategy,
        syncId: id,
        revision: saved.revision,
        syncVersion: state.sermons[id].syncVersion,
        warnings: []
      });
    }

    const accessToken = this._token(await this.accessTokenProvider());
    assertNotAborted(signal);
    const fetched = await this.client.getSermon({
      syncId: id,
      accessToken,
      signal
    });
    const { remote: latest } = await this._verifyEnvelope(fetched, {
      expectedSyncId: id
    });
    assertNotAborted(signal);
    this._assertRemoteContinuity(previous, latest);
    const syncedAt = this._timestamp();
    if (latest.syncVersion !== expectedSyncVersion
      || latest.revision !== conflict.remoteRevision) {
      return this._checkpointResolutionConflict(
        state,
        previous,
        latest,
        local,
        'RESOLUTION_REMOTE_CHANGED',
        syncedAt
      );
    }

    // The GET above can take long enough for another window to edit the local
    // sermon or resolve this same saved conflict. Re-read both before PUT so
    // the exact reviewed revisions remain the write preconditions.
    state = await this.stateStore.getConnectionState(this.connectionId);
    ({ previous, conflict } = this._resolutionState(
      state,
      id,
      expectedSyncVersion
    ));
    local = await this._resolutionLocal(id, expectedLocalRevision);
    assertNotAborted(signal);

    let updated;
    try {
      updated = await this.client.updateSermon({
        syncId: id,
        documentSource: local.documentSource || local.source,
        expectedSyncVersion,
        accessToken,
        signal
      });
    } catch (error) {
      assertNotAborted(signal);
      if (error?.code !== 'REVISION_CONFLICT') throw error;
      const raced = await this.client.getSermon({
        syncId: id,
        accessToken,
        signal
      });
      const { remote } = await this._verifyEnvelope(raced, {
        expectedSyncId: id
      });
      assertNotAborted(signal);
      this._assertRemoteContinuity(previous, remote);
      return this._checkpointResolutionConflict(
        state,
        previous,
        remote,
        local,
        'RESOLUTION_REMOTE_RACE',
        syncedAt
      );
    }

    const { remote } = await this._verifyEnvelope(updated, {
      expectedSyncId: id
    });
    assertNotAborted(signal);
    this._assertRemoteContinuity(previous, remote);

    const currentLocal = await this._readLocal(id);
    assertNotAborted(signal);
    if (!currentLocal || currentLocal.revision !== local.revision
      || remote.revision !== local.revision) {
      return this._checkpointResolutionConflict(
        state,
        previous,
        remote,
        currentLocal || local,
        currentLocal?.revision !== local.revision
          ? 'RESOLUTION_LOCAL_RACE'
          : 'RESOLUTION_REMOTE_RACE',
        syncedAt
      );
    }

    state.sermons[id] = remoteObservation(previous, remote, {
      localRevision: local.revision,
      conflict: null,
      syncedAt
    });
    state.lastSermonSyncAt = syncedAt;
    state = await this.stateStore.saveConnectionState(this.connectionId, state);
    return frozenResult({
      resolved: true,
      status: 'synced',
      strategy,
      syncId: id,
      revision: local.revision,
      syncVersion: state.sermons[id].syncVersion,
      warnings: []
    });
  }
}

module.exports = {
  CommunitySermonSync,
  CommunitySermonSyncError
};
