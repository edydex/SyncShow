'use strict';

const crypto = require('crypto');

const {
  CommunityClientError
} = require('./CommunityClient');
const {
  validateHeritageServiceDocumentSource
} = require('./HeritageServiceDocument');
const {
  HeritageServiceDocumentOutbox
} = require('./HeritageServiceDocumentOutbox');

class HeritageServiceDocumentSync {
  constructor({
    client,
    outbox,
    serverId,
    synchronizeAssets = async () => {},
    randomUUID = crypto.randomUUID
  } = {}) {
    if (!client
      || typeof client.createServiceDocument !== 'function'
      || typeof client.updateServiceDocument !== 'function'
      || typeof client.getServiceDocument !== 'function') {
      throw new TypeError('Service-document sync requires a Community client.');
    }
    if (!(outbox instanceof HeritageServiceDocumentOutbox)) {
      throw new TypeError('Service-document sync requires a durable outbox.');
    }
    if (typeof serverId !== 'string' || !serverId) {
      throw new TypeError('Service-document sync requires a Community server id.');
    }
    if (typeof randomUUID !== 'function') {
      throw new TypeError('Service-document sync idempotency source is invalid.');
    }
    if (typeof synchronizeAssets !== 'function') {
      throw new TypeError('Service-document asset synchronizer is invalid.');
    }
    this.client = client;
    this.outbox = outbox;
    this.serverId = serverId;
    this.synchronizeAssets = synchronizeAssets;
    this.randomUUID = randomUUID;
  }

  async _remoteConflict(syncId, accessToken, signal) {
    try {
      return await this.client.getServiceDocument({
        syncId,
        accessToken,
        signal
      });
    } catch (error) {
      if (error instanceof CommunityClientError
        && (error.retryable || error.code === 'NOT_FOUND')) return null;
      throw error;
    }
  }

  _requestFor({
    mode,
    syncId,
    documentSource,
    status,
    baseSyncVersion,
    baseRevision,
    accessToken,
    idempotencyKey,
    signal
  }) {
    if (mode === 'create') {
      return this.client.createServiceDocument({
        syncId,
        documentSource,
        status,
        accessToken,
        idempotencyKey,
        signal
      });
    }
    return this.client.updateServiceDocument({
      syncId,
      documentSource,
      status,
      baseSyncVersion,
      baseRevision,
      accessToken,
      idempotencyKey,
      signal
    });
  }

  async save({
    documentSource,
    status = 'planning',
    base = null,
    accessToken,
    signal = null
  } = {}) {
    const validated = validateHeritageServiceDocumentSource(documentSource);
    const pending = await this.outbox.get(
      this.serverId,
      validated.document.id
    );
    const initialMode = pending?.mode || (base === null ? 'create' : 'update');
    // If an edit is already waiting, durably replace its payload before the
    // network attempt. A crash after the request begins must recover the exact
    // bytes that were in flight, while retaining the oldest remote base.
    const staged = pending
      ? await this.outbox.queue({
          serverId: this.serverId,
          syncId: validated.document.id,
          mode: initialMode,
          baseSyncVersion: pending.baseSyncVersion,
          baseRevision: pending.baseRevision,
          documentSource: validated.documentSource,
          status
        })
      : null;
    const mode = staged?.mode || initialMode;
    const request = {
      mode,
      syncId: validated.document.id,
      documentSource: validated.documentSource,
      documentRevision: validated.revision,
      status,
      baseSyncVersion: staged?.baseSyncVersion
        ?? pending?.baseSyncVersion
        ?? base?.syncVersion
        ?? 0,
      baseRevision: staged?.baseRevision
        ?? pending?.baseRevision
        ?? base?.revision
        ?? null,
      accessToken,
      idempotencyKey: staged?.idempotencyKey || this.randomUUID(),
      signal
    };
    try {
      const remote = await this._requestFor(request);
      await this.synchronizeAssets({
        project: validated.document.project,
        remote,
        accessToken,
        signal
      });
      await this.outbox.remove(this.serverId, request.syncId, {
        documentRevision: request.documentRevision
      });
      return Object.freeze({
        state: 'synced',
        remote
      });
    } catch (error) {
      if (error instanceof CommunityClientError
        && error.code === 'REVISION_CONFLICT') {
        return Object.freeze({
          state: 'conflict',
          syncId: request.syncId,
          base: request.mode === 'update' ? Object.freeze({
            syncVersion: request.baseSyncVersion,
            revision: request.baseRevision
          }) : null,
          local: Object.freeze({
            documentSource: request.documentSource,
            revision: validated.revision,
            status
          }),
          remote: await this._remoteConflict(
            request.syncId,
            accessToken,
            signal
          )
        });
      }
      if (!(error instanceof CommunityClientError) || !error.retryable) {
        throw error;
      }
      const queued = staged || await this.outbox.queue({
          serverId: this.serverId,
          syncId: request.syncId,
          mode,
          baseSyncVersion: request.baseSyncVersion,
          baseRevision: request.baseRevision,
          documentSource: request.documentSource,
          status
        });
      return Object.freeze({
        state: 'queued',
        queued,
        reason: error.code
      });
    }
  }

  async flush({ accessToken, signal = null } = {}) {
    const entries = await this.outbox.list({ serverId: this.serverId });
    const results = [];
    for (const entry of entries) {
      try {
        const remote = await this._requestFor({
          ...entry,
          accessToken,
          signal
        });
        const validated = validateHeritageServiceDocumentSource(
          entry.documentSource
        );
        await this.synchronizeAssets({
          project: validated.document.project,
          remote,
          accessToken,
          signal
        });
        const removed = await this.outbox.remove(
          this.serverId,
          entry.syncId,
          { documentRevision: entry.documentRevision }
        );
        results.push(Object.freeze({
          state: removed ? 'synced' : 'superseded',
          syncId: entry.syncId,
          remote
        }));
      } catch (error) {
        if (error instanceof CommunityClientError
          && error.code === 'REVISION_CONFLICT') {
          results.push(Object.freeze({
            state: 'conflict',
            syncId: entry.syncId,
            base: Object.freeze({
              syncVersion: entry.baseSyncVersion,
              revision: entry.baseRevision
            }),
            local: Object.freeze({
              documentSource: entry.documentSource,
              revision: entry.documentRevision,
              status: entry.status
            }),
            remote: await this._remoteConflict(
              entry.syncId,
              accessToken,
              signal
            )
          }));
          continue;
        }
        if (error instanceof CommunityClientError && error.retryable) {
          results.push(Object.freeze({
            state: 'waiting',
            syncId: entry.syncId,
            reason: error.code
          }));
          break;
        }
        throw error;
      }
    }
    return Object.freeze(results);
  }
}

module.exports = {
  HeritageServiceDocumentSync
};
