'use strict';

const path = require('path');

const {
  atomicWriteFile,
  ensurePrivateDirectory,
  readFileNoFollow
} = require('../project/StorageSafety');

const STORE_KIND = 'heritage-service-document-bindings';
const STORE_SCHEMA_VERSION = 1;
const MAX_STORE_BYTES = 2 * 1024 * 1024;
const MAX_BINDINGS = 5000;
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const REVISION_PATTERN = /^[a-f0-9]{64}$/u;

function identifier(value, label) {
  if (typeof value !== 'string' || !ID_PATTERN.test(value)) {
    throw new TypeError(`${label} is invalid.`);
  }
  return value;
}

function revision(value, label) {
  if (typeof value !== 'string' || !REVISION_PATTERN.test(value)) {
    throw new TypeError(`${label} is invalid.`);
  }
  return value;
}

function normalizeBinding(raw) {
  if (!raw
    || typeof raw !== 'object'
    || Array.isArray(raw)
    || Object.keys(raw).sort().join('\n') !== [
      'changedAt',
      'documentRevision',
      'localRevisionId',
      'projectId',
      'serverId',
      'status',
      'syncId',
      'syncVersion'
    ].sort().join('\n')) {
    throw new Error('Saved service-document binding is invalid.');
  }
  const changedAt = raw.changedAt === null
    ? null
    : new Date(String(raw.changedAt || '')).toISOString();
  if (!['planning', 'ready', 'archived', 'cancelled'].includes(raw.status)
    || !Number.isSafeInteger(raw.syncVersion)
    || raw.syncVersion < 0
    || (raw.syncVersion === 0
      && (raw.documentRevision !== null || raw.changedAt !== null))) {
    throw new Error('Saved service-document binding is invalid.');
  }
  return Object.freeze({
    projectId: identifier(raw.projectId, 'Project id'),
    serverId: identifier(raw.serverId, 'Community server id'),
    syncId: identifier(raw.syncId, 'Service document id'),
    syncVersion: raw.syncVersion,
    documentRevision: raw.syncVersion === 0
      ? null
      : revision(raw.documentRevision, 'Document revision'),
    localRevisionId: revision(raw.localRevisionId, 'Local revision'),
    status: raw.status,
    changedAt
  });
}

function clone(value) {
  return value ? JSON.parse(JSON.stringify(value)) : null;
}

class HeritageServiceDocumentBindingStore {
  constructor({ rootPath } = {}) {
    if (typeof rootPath !== 'string' || !path.isAbsolute(rootPath)) {
      throw new TypeError('Service-document bindings require an absolute root.');
    }
    this.rootPath = path.resolve(rootPath);
    this.storePath = path.join(this.rootPath, 'bindings.json');
    this.writeQueue = Promise.resolve();
  }

  _serialize(operation) {
    const result = this.writeQueue.then(operation, operation);
    this.writeQueue = result.then(() => undefined, () => undefined);
    return result;
  }

  async _read() {
    await ensurePrivateDirectory(this.rootPath);
    let buffer;
    try {
      ({ buffer } = await readFileNoFollow(this.storePath, MAX_STORE_BYTES));
    } catch (error) {
      if (error.code === 'ENOENT') return {};
      throw error;
    }
    const payload = JSON.parse(buffer.toString('utf8'));
    if (!payload
      || payload.kind !== STORE_KIND
      || payload.schemaVersion !== STORE_SCHEMA_VERSION
      || !payload.bindings
      || typeof payload.bindings !== 'object'
      || Array.isArray(payload.bindings)
      || Object.keys(payload.bindings).length > MAX_BINDINGS) {
      throw new Error('Saved service-document bindings are corrupt.');
    }
    return Object.fromEntries(Object.entries(payload.bindings).map(
      ([projectId, raw]) => {
        const binding = normalizeBinding(raw);
        if (binding.projectId !== projectId) {
          throw new Error('Saved service-document bindings are corrupt.');
        }
        return [projectId, binding];
      }
    ));
  }

  async _write(bindings) {
    const source = `${JSON.stringify({
      schemaVersion: STORE_SCHEMA_VERSION,
      kind: STORE_KIND,
      bindings
    }, null, 2)}\n`;
    await atomicWriteFile(this.storePath, source, {
      rootPath: this.rootPath,
      maximumBytes: MAX_STORE_BYTES,
      mode: 0o600
    });
  }

  async get(projectId) {
    projectId = identifier(projectId, 'Project id');
    return clone((await this._read())[projectId] || null);
  }

  async save(raw) {
    return this._serialize(async () => {
      const binding = normalizeBinding(raw);
      const bindings = await this._read();
      if (!bindings[binding.projectId]
        && Object.keys(bindings).length >= MAX_BINDINGS) {
        throw new Error('Too many service-document bindings are saved.');
      }
      bindings[binding.projectId] = binding;
      await this._write(bindings);
      return clone(binding);
    });
  }

  async remove(projectId) {
    return this._serialize(async () => {
      projectId = identifier(projectId, 'Project id');
      const bindings = await this._read();
      if (!bindings[projectId]) return false;
      delete bindings[projectId];
      await this._write(bindings);
      return true;
    });
  }
}

module.exports = {
  HeritageServiceDocumentBindingStore,
  STORE_KIND,
  STORE_SCHEMA_VERSION,
  normalizeBinding
};
