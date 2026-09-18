'use strict';

const crypto = require('crypto');
const path = require('path');

const {
  atomicWriteFile,
  ensurePrivateDirectory,
  readFileNoFollow
} = require('../project/StorageSafety');
const {
  HERITAGE_SERVICE_DOCUMENT_STATUSES,
  heritageServiceDocumentRevision,
  validateHeritageServiceDocumentSource
} = require('./HeritageServiceDocument');

const OUTBOX_KIND = 'heritage-service-document-outbox';
const OUTBOX_SCHEMA_VERSION = 1;
const ENTRY_KIND = 'heritage-service-document-outbox-entry';
const MAX_ENTRIES = 8;
const MAX_STORE_BYTES = 128 * 1024 * 1024;
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const REVISION_PATTERN = /^[a-f0-9]{64}$/u;
const IDEMPOTENCY_KEY_PATTERN =
  /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;

class HeritageServiceDocumentOutboxError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'HeritageServiceDocumentOutboxError';
    this.code = code;
    this.details = details;
  }
}

function fail(code, message, details = {}) {
  throw new HeritageServiceDocumentOutboxError(code, message, details);
}

function isRecord(value) {
  return Boolean(value)
    && typeof value === 'object'
    && !Array.isArray(value);
}

function identifier(value, label) {
  if (typeof value !== 'string' || !ID_PATTERN.test(value)) {
    fail('INVALID_OUTBOX_ENTRY', `${label} is invalid.`);
  }
  return value;
}

function timestamp(value, label) {
  if (typeof value !== 'string'
    || Number.isNaN(Date.parse(value))
    || new Date(value).toISOString() !== value) {
    fail('INVALID_OUTBOX_ENTRY', `${label} is invalid.`);
  }
  return value;
}

function clone(value) {
  return value === null || value === undefined
    ? value
    : JSON.parse(JSON.stringify(value));
}

function entryKey(serverId, syncId) {
  return crypto.createHash('sha256')
    .update(serverId)
    .update('\0')
    .update(syncId)
    .digest('hex');
}

function normalizeEntry(raw) {
  if (!isRecord(raw)
    || Object.keys(raw).sort().join('\n') !== [
      'baseRevision',
      'baseSyncVersion',
      'documentRevision',
      'documentSource',
      'idempotencyKey',
      'kind',
      'mode',
      'queuedAt',
      'serverId',
      'status',
      'syncId'
    ].sort().join('\n')
    || raw.kind !== ENTRY_KIND) {
    fail('INVALID_OUTBOX_ENTRY', 'A queued service-document edit is invalid.');
  }
  const serverId = identifier(raw.serverId, 'Community server id');
  const syncId = identifier(raw.syncId, 'Service document id');
  if (!['create', 'update'].includes(raw.mode)) {
    fail('INVALID_OUTBOX_ENTRY', 'Queued service-document mode is invalid.');
  }
  if (!HERITAGE_SERVICE_DOCUMENT_STATUSES.includes(raw.status)) {
    fail('INVALID_OUTBOX_ENTRY', 'Queued service-document status is invalid.');
  }
  if (!IDEMPOTENCY_KEY_PATTERN.test(raw.idempotencyKey || '')) {
    fail('INVALID_OUTBOX_ENTRY', 'Queued service-document idempotency key is invalid.');
  }
  let validated;
  try {
    validated = validateHeritageServiceDocumentSource(raw.documentSource);
  } catch (error) {
    fail('INVALID_OUTBOX_ENTRY', 'Queued service-document content is invalid.', {
      cause: error.code || error.name
    });
  }
  if (validated.document.id !== syncId
    || validated.revision !== raw.documentRevision) {
    fail(
      'INVALID_OUTBOX_ENTRY',
      'Queued service-document content does not match its identity or revision.'
    );
  }
  if (raw.mode === 'create') {
    if (raw.baseSyncVersion !== 0 || raw.baseRevision !== null) {
      fail('INVALID_OUTBOX_ENTRY', 'A queued create cannot claim a remote base.');
    }
  } else if (!Number.isSafeInteger(raw.baseSyncVersion)
    || raw.baseSyncVersion < 1
    || !REVISION_PATTERN.test(raw.baseRevision || '')) {
    fail('INVALID_OUTBOX_ENTRY', 'A queued update needs an exact remote base.');
  }
  return Object.freeze({
    kind: ENTRY_KIND,
    serverId,
    syncId,
    mode: raw.mode,
    baseSyncVersion: raw.baseSyncVersion,
    baseRevision: raw.baseRevision,
    documentSource: validated.documentSource,
    documentRevision: validated.revision,
    status: raw.status,
    idempotencyKey: raw.idempotencyKey,
    queuedAt: timestamp(raw.queuedAt, 'Queued service-document time')
  });
}

class HeritageServiceDocumentOutbox {
  constructor({
    rootPath,
    now = () => new Date(),
    randomUUID = crypto.randomUUID
  } = {}) {
    if (typeof rootPath !== 'string' || !path.isAbsolute(rootPath)) {
      throw new TypeError('Service-document outbox requires an absolute root.');
    }
    if (typeof now !== 'function' || typeof randomUUID !== 'function') {
      throw new TypeError('Service-document outbox dependencies are invalid.');
    }
    this.rootPath = path.resolve(rootPath);
    this.storePath = path.join(this.rootPath, 'outbox.json');
    this.now = now;
    this.randomUUID = randomUUID;
    this.writeQueue = Promise.resolve();
  }

  _serialize(operation) {
    const result = this.writeQueue.then(operation, operation);
    this.writeQueue = result.then(() => undefined, () => undefined);
    return result;
  }

  _timestamp() {
    const value = this.now();
    const date = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(date.getTime())) {
      throw new TypeError('Service-document outbox clock is invalid.');
    }
    return date.toISOString();
  }

  async _read() {
    await ensurePrivateDirectory(this.rootPath);
    let buffer;
    try {
      ({ buffer } = await readFileNoFollow(this.storePath, MAX_STORE_BYTES));
    } catch (error) {
      if (error.code === 'ENOENT') return {};
      fail('OUTBOX_READ_FAILED', 'Queued service-document edits could not be read.', {
        cause: error.code || error.name
      });
    }
    let payload;
    try {
      payload = JSON.parse(buffer.toString('utf8'));
    } catch (_error) {
      fail('CORRUPT_OUTBOX', 'Queued service-document edits are corrupt.');
    }
    if (!isRecord(payload)
      || payload.kind !== OUTBOX_KIND
      || payload.schemaVersion !== OUTBOX_SCHEMA_VERSION
      || !isRecord(payload.entries)
      || Object.keys(payload.entries).length > MAX_ENTRIES) {
      fail('CORRUPT_OUTBOX', 'Queued service-document edits are corrupt.');
    }
    const entries = {};
    for (const [key, raw] of Object.entries(payload.entries)) {
      let entry;
      try {
        entry = normalizeEntry(raw);
      } catch (error) {
        fail('CORRUPT_OUTBOX', 'Queued service-document edits are corrupt.', {
          cause: error.code || error.name
        });
      }
      if (entryKey(entry.serverId, entry.syncId) !== key) {
        fail('CORRUPT_OUTBOX', 'Queued service-document edit key is invalid.');
      }
      entries[key] = entry;
    }
    return entries;
  }

  async _write(entries) {
    const source = `${JSON.stringify({
      schemaVersion: OUTBOX_SCHEMA_VERSION,
      kind: OUTBOX_KIND,
      entries
    }, null, 2)}\n`;
    if (Buffer.byteLength(source, 'utf8') > MAX_STORE_BYTES) {
      fail('OUTBOX_TOO_LARGE', 'Queued service-document edits exceed safe local storage.');
    }
    try {
      await atomicWriteFile(this.storePath, source, {
        rootPath: this.rootPath,
        maximumBytes: MAX_STORE_BYTES,
        mode: 0o600
      });
    } catch (error) {
      if (error instanceof HeritageServiceDocumentOutboxError) throw error;
      fail('OUTBOX_WRITE_FAILED', 'Queued service-document edits could not be saved.', {
        cause: error.code || error.name
      });
    }
  }

  async queue({
    serverId,
    syncId,
    mode,
    baseSyncVersion = 0,
    baseRevision = null,
    documentSource,
    status = 'planning'
  } = {}) {
    return this._serialize(async () => {
      serverId = identifier(serverId, 'Community server id');
      syncId = identifier(syncId, 'Service document id');
      const key = entryKey(serverId, syncId);
      const entries = await this._read();
      const previous = entries[key] || null;
      if (!previous && Object.keys(entries).length >= MAX_ENTRIES) {
        fail('OUTBOX_FULL', 'Too many service documents are waiting to synchronize.');
      }
      // The oldest unacknowledged remote base is the only safe comparison
      // point. Editing an already queued document replaces its payload while
      // retaining that base, so reconnect can never skip an intervening edit.
      const effectiveMode = previous?.mode === 'create' ? 'create' : mode;
      const entry = normalizeEntry({
        kind: ENTRY_KIND,
        serverId,
        syncId,
        mode: effectiveMode,
        baseSyncVersion: effectiveMode === 'create'
          ? 0
          : previous?.baseSyncVersion ?? baseSyncVersion,
        baseRevision: effectiveMode === 'create'
          ? null
          : previous?.baseRevision ?? baseRevision,
        documentSource,
        documentRevision: heritageServiceDocumentRevision(documentSource),
        status,
        idempotencyKey: this.randomUUID(),
        queuedAt: this._timestamp()
      });
      entries[key] = entry;
      await this._write(entries);
      return clone(entry);
    });
  }

  async get(serverId, syncId) {
    serverId = identifier(serverId, 'Community server id');
    syncId = identifier(syncId, 'Service document id');
    const entries = await this._read();
    return clone(entries[entryKey(serverId, syncId)] || null);
  }

  async list({ serverId = null } = {}) {
    if (serverId !== null) serverId = identifier(serverId, 'Community server id');
    const entries = Object.values(await this._read())
      .filter(entry => serverId === null || entry.serverId === serverId)
      .sort((left, right) => left.queuedAt.localeCompare(right.queuedAt));
    return entries.map(clone);
  }

  async remove(serverId, syncId, { documentRevision = null } = {}) {
    return this._serialize(async () => {
      serverId = identifier(serverId, 'Community server id');
      syncId = identifier(syncId, 'Service document id');
      if (documentRevision !== null
        && !REVISION_PATTERN.test(documentRevision || '')) {
        fail('INVALID_OUTBOX_ENTRY', 'Acknowledged service-document revision is invalid.');
      }
      const entries = await this._read();
      const key = entryKey(serverId, syncId);
      const current = entries[key];
      if (!current) return false;
      // Do not let an acknowledgement for an older in-flight request erase a
      // newer edit that replaced it while the request was running.
      if (documentRevision !== null
        && current.documentRevision !== documentRevision) return false;
      delete entries[key];
      await this._write(entries);
      return true;
    });
  }
}

module.exports = {
  ENTRY_KIND,
  HeritageServiceDocumentOutbox,
  HeritageServiceDocumentOutboxError,
  MAX_ENTRIES,
  OUTBOX_KIND,
  OUTBOX_SCHEMA_VERSION,
  entryKey,
  normalizeEntry
};
