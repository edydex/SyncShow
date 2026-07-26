'use strict';

const crypto = require('crypto');
const path = require('path');

const {
  atomicWriteFile,
  ensurePrivateDirectory,
  readFileNoFollow
} = require('../project/StorageSafety');

const CURRENT_DRIVE_CONNECTION_SCHEMA_VERSION = 1;
const DEFAULT_MAX_CONNECTIONS = 64;
const MAX_STORE_BYTES = 1024 * 1024;
const CONNECTION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{7,99}$/;
const DRIVE_ID_PATTERN = /^[A-Za-z0-9_-]{10,200}$/;
const RESOURCE_KEY_PATTERN = /^[A-Za-z0-9_-]{1,200}$/;
const EMAIL_PATTERN = /^[^\s@]{1,128}@[^\s@]{1,190}$/;

class DriveConnectionStoreError extends Error {
  constructor(code, message, { cause = null } = {}) {
    super(message);
    this.name = 'DriveConnectionStoreError';
    this.code = code;
    this.cause = cause;
  }
}

function boundedString(value, label, {
  required = false,
  maximumLength = 240,
  pattern = null,
  fallback = null
} = {}) {
  if (value === undefined || value === null || value === '') {
    if (required) throw new DriveConnectionStoreError('INVALID_CONNECTION', `${label} is required.`);
    return fallback;
  }
  if (typeof value !== 'string') {
    throw new DriveConnectionStoreError('INVALID_CONNECTION', `${label} must be text.`);
  }
  const normalized = value
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .trim();
  if (!normalized || normalized.length > maximumLength || (pattern && !pattern.test(normalized))) {
    throw new DriveConnectionStoreError('INVALID_CONNECTION', `${label} is not valid.`);
  }
  return normalized;
}

function normalizeCapabilities(value = {}) {
  const capabilities = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  return Object.freeze({
    canListChildren: capabilities.canListChildren === true,
    canAddChildren: capabilities.canAddChildren === true,
    canDownload: capabilities.canDownload === true,
    canEdit: capabilities.canEdit === true,
    canModifyContent: capabilities.canModifyContent === true
  });
}

function capabilitiesAllowWrite(capabilities) {
  return capabilities.canAddChildren === true
    || capabilities.canEdit === true
    || capabilities.canModifyContent === true;
}

function normalizeTimestamp(value, label) {
  if (typeof value !== 'string' || value.length > 40 || Number.isNaN(Date.parse(value))) {
    throw new DriveConnectionStoreError('CORRUPT_STORE', `${label} is invalid.`);
  }
  return new Date(value).toISOString();
}

function normalizeCiphertext(value) {
  if (typeof value !== 'string' || value.length < 4 || value.length > 64 * 1024) {
    throw new DriveConnectionStoreError('CORRUPT_STORE', 'Encrypted Google credentials are invalid.');
  }
  const buffer = Buffer.from(value, 'base64');
  if (!buffer.length || buffer.toString('base64') !== value) {
    throw new DriveConnectionStoreError('CORRUPT_STORE', 'Encrypted Google credentials are invalid.');
  }
  return value;
}

function normalizeRecord(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new DriveConnectionStoreError('CORRUPT_STORE', 'Google Drive connection record is invalid.');
  }
  const id = boundedString(value.id, 'Connection ID', {
    required: true,
    maximumLength: 100,
    pattern: CONNECTION_ID_PATTERN
  });
  if (!['private', 'public'].includes(value.kind)) {
    throw new DriveConnectionStoreError('CORRUPT_STORE', 'Google Drive connection type is invalid.');
  }
  const capabilities = normalizeCapabilities(value.capabilities);
  const record = {
    id,
    kind: value.kind,
    folderId: boundedString(value.folderId, 'Folder ID', {
      required: true,
      maximumLength: 200,
      pattern: DRIVE_ID_PATTERN
    }),
    folderName: boundedString(value.folderName, 'Folder name', {
      required: true,
      maximumLength: 240
    }),
    resourceKey: boundedString(value.resourceKey, 'Resource key', {
      maximumLength: 200,
      pattern: RESOURCE_KEY_PATTERN
    }),
    accountEmail: boundedString(value.accountEmail, 'Account email', {
      maximumLength: 320,
      pattern: EMAIL_PATTERN
    }),
    accountName: boundedString(value.accountName, 'Account name', { maximumLength: 160 }),
    capabilities,
    writeEnabled: value.kind === 'private'
      && value.writeEnabled === true
      && capabilitiesAllowWrite(capabilities),
    createdAt: normalizeTimestamp(value.createdAt, 'Connection creation time'),
    updatedAt: normalizeTimestamp(value.updatedAt, 'Connection update time'),
    secret: null
  };
  if (value.kind === 'private') {
    if (!value.secret || value.secret.format !== 'electron-safe-storage-v1') {
      throw new DriveConnectionStoreError('CORRUPT_STORE', 'Private Google credentials are missing.');
    }
    record.secret = {
      format: 'electron-safe-storage-v1',
      ciphertext: normalizeCiphertext(value.secret.ciphertext)
    };
  } else if (value.secret) {
    throw new DriveConnectionStoreError('CORRUPT_STORE', 'Public Google Drive links cannot contain credentials.');
  }
  return record;
}

function sanitizeConnection(record) {
  const canWrite = record.kind === 'private' && capabilitiesAllowWrite(record.capabilities);
  return Object.freeze({
    id: record.id,
    kind: record.kind,
    folderName: record.folderName,
    accountEmail: record.kind === 'private' ? record.accountEmail : null,
    accountName: record.kind === 'private' ? record.accountName : null,
    canWrite,
    writeEnabled: canWrite && record.writeEnabled,
    access: canWrite && record.writeEnabled ? 'read-write' : 'read-only',
    createdAt: record.createdAt,
    updatedAt: record.updatedAt
  });
}

function serializeStore(records) {
  return `${JSON.stringify({
    schemaVersion: CURRENT_DRIVE_CONNECTION_SCHEMA_VERSION,
    connections: records
  }, null, 2)}\n`;
}

class DriveConnectionStore {
  constructor({
    storageRoot,
    safeStorage,
    platform = process.platform,
    now = () => new Date(),
    randomUUID = crypto.randomUUID,
    revokeToken = null,
    onDisconnect = null,
    maximumConnections = DEFAULT_MAX_CONNECTIONS
  } = {}) {
    if (typeof storageRoot !== 'string' || !path.isAbsolute(storageRoot)) {
      throw new TypeError('Drive connection storage root must be absolute');
    }
    const supportsSynchronousStorage = Boolean(
      safeStorage
      && typeof safeStorage.isEncryptionAvailable === 'function'
      && typeof safeStorage.encryptString === 'function'
      && typeof safeStorage.decryptString === 'function'
    );
    const supportsAsynchronousStorage = Boolean(
      safeStorage
      && typeof safeStorage.isAsyncEncryptionAvailable === 'function'
      && typeof safeStorage.encryptStringAsync === 'function'
      && typeof safeStorage.decryptStringAsync === 'function'
    );
    if (!supportsSynchronousStorage && !supportsAsynchronousStorage) {
      throw new TypeError('Drive connection store requires Electron safeStorage');
    }
    if (!['darwin', 'linux', 'win32'].includes(platform)) {
      throw new TypeError('Drive connection store platform is invalid');
    }
    if (typeof now !== 'function' || typeof randomUUID !== 'function') {
      throw new TypeError('Drive connection store dependencies are invalid');
    }
    if (!Number.isSafeInteger(maximumConnections)
      || maximumConnections < 1
      || maximumConnections > 256) {
      throw new TypeError('Drive connection limit must be between 1 and 256');
    }
    if (revokeToken !== null && typeof revokeToken !== 'function') {
      throw new TypeError('revokeToken must be a function');
    }
    if (onDisconnect !== null && typeof onDisconnect !== 'function') {
      throw new TypeError('onDisconnect must be a function');
    }
    this.storageRoot = path.resolve(storageRoot);
    this.storePath = path.join(this.storageRoot, 'connections.json');
    this.safeStorage = safeStorage;
    this.supportsSynchronousStorage = supportsSynchronousStorage;
    this.supportsAsynchronousStorage = supportsAsynchronousStorage;
    this.platform = platform;
    this.now = now;
    this.randomUUID = randomUUID;
    this.revokeToken = revokeToken;
    this.onDisconnect = onDisconnect;
    this.maximumConnections = maximumConnections;
    this.writeQueue = Promise.resolve();
  }

  _timestamp() {
    const value = this.now();
    const parsed = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(parsed.getTime())) throw new TypeError('Drive connection clock is invalid');
    return parsed.toISOString();
  }

  _secureStorageUnavailableMessage() {
    if (this.platform === 'darwin') {
      return 'Your Mac login keychain is locked or unavailable. Unlock it, fully quit SyncShow, then reopen SyncShow before connecting Google Drive.';
    }
    return 'Secure credential storage is unavailable. Unlock your computer credential store, fully quit SyncShow, then reopen it before connecting Google Drive.';
  }

  async _secureStorageMode() {
    if (this.platform === 'linux'
      && typeof this.safeStorage.getSelectedStorageBackend === 'function'
      && this.safeStorage.getSelectedStorageBackend() === 'basic_text') {
      throw new DriveConnectionStoreError(
        'INSECURE_SECRET_STORAGE',
        'Linux credential storage is using basic_text. Configure a secure keyring before connecting Google Drive.'
      );
    }

    if (this.supportsAsynchronousStorage) {
      try {
        if (await this.safeStorage.isAsyncEncryptionAvailable()) return 'async';
      } catch (_error) {
        // A synchronous provider may still be securely available.
      }
    }

    if (this.supportsSynchronousStorage) {
      let available = false;
      try {
        available = this.safeStorage.isEncryptionAvailable();
      } catch (_error) {
        available = false;
      }
      if (available) {
        return 'sync';
      }
    }

    throw new DriveConnectionStoreError(
      'SECURE_STORAGE_UNAVAILABLE',
      this._secureStorageUnavailableMessage()
    );
  }

  async _encryptRefreshToken(refreshToken, mode = null) {
    const normalized = boundedString(refreshToken, 'Google refresh token', {
      required: true,
      maximumLength: 8192
    });
    const storageMode = mode || await this._secureStorageMode();
    let encrypted;
    try {
      encrypted = storageMode === 'async'
        ? await this.safeStorage.encryptStringAsync(normalized)
        : this.safeStorage.encryptString(normalized);
    } catch (error) {
      throw new DriveConnectionStoreError(
        'ENCRYPTION_FAILED',
        'Google credentials could not be encrypted.',
        { cause: error?.code || error?.name || 'encryption-error' }
      );
    }
    if (!Buffer.isBuffer(encrypted) || encrypted.length === 0) {
      throw new DriveConnectionStoreError('ENCRYPTION_FAILED', 'Google credentials could not be encrypted.');
    }
    return {
      format: 'electron-safe-storage-v1',
      ciphertext: encrypted.toString('base64')
    };
  }

  async _decryptRefreshToken(secret, mode = null) {
    const storageMode = mode || await this._secureStorageMode();
    try {
      const ciphertext = Buffer.from(secret.ciphertext, 'base64');
      const decrypted = storageMode === 'async'
        ? await this.safeStorage.decryptStringAsync(ciphertext)
        : this.safeStorage.decryptString(ciphertext);
      const plaintext = storageMode === 'async' ? decrypted?.result : decrypted;
      return boundedString(plaintext, 'Google refresh token', {
        required: true,
        maximumLength: 8192
      });
    } catch (error) {
      if (error instanceof DriveConnectionStoreError) throw error;
      throw new DriveConnectionStoreError(
        'DECRYPTION_FAILED',
        'Saved Google credentials could not be decrypted.',
        { cause: error?.code || error?.name || 'decryption-error' }
      );
    }
  }

  async assertSecureStorageAvailable() {
    const probe = 'syncshow-secure-storage-check';
    try {
      const mode = await this._secureStorageMode();
      const encrypted = await this._encryptRefreshToken(probe, mode);
      const decrypted = await this._decryptRefreshToken(encrypted, mode);
      if (decrypted !== probe) throw new Error('secure-storage-round-trip-failed');
      return true;
    } catch (error) {
      if (error instanceof DriveConnectionStoreError
        && error.code === 'INSECURE_SECRET_STORAGE') {
        throw error;
      }
      throw new DriveConnectionStoreError(
        'SECURE_STORAGE_UNAVAILABLE',
        this._secureStorageUnavailableMessage(),
        { cause: error?.code || error?.name || 'secure-storage-check-failed' }
      );
    }
  }

  async _readRecords() {
    await ensurePrivateDirectory(this.storageRoot);
    let contents;
    try {
      ({ buffer: contents } = await readFileNoFollow(this.storePath, MAX_STORE_BYTES));
    } catch (error) {
      if (error.code === 'ENOENT') return [];
      if (error instanceof DriveConnectionStoreError) throw error;
      throw new DriveConnectionStoreError(
        'STORE_READ_FAILED',
        'Saved Google Drive connections could not be read.',
        { cause: error?.code || error?.name || 'read-error' }
      );
    }
    let payload;
    try {
      payload = JSON.parse(contents.toString('utf8'));
    } catch (_error) {
      throw new DriveConnectionStoreError('CORRUPT_STORE', 'Saved Google Drive connections are corrupt.');
    }
    if (!payload
      || payload.schemaVersion !== CURRENT_DRIVE_CONNECTION_SCHEMA_VERSION
      || !Array.isArray(payload.connections)
      || payload.connections.length > this.maximumConnections) {
      throw new DriveConnectionStoreError('CORRUPT_STORE', 'Saved Google Drive connections are corrupt.');
    }
    const records = payload.connections.map(normalizeRecord);
    if (new Set(records.map(record => record.id)).size !== records.length) {
      throw new DriveConnectionStoreError('CORRUPT_STORE', 'Saved Google Drive connection IDs conflict.');
    }
    return records;
  }

  async _writeRecords(records) {
    const serialized = serializeStore(records);
    if (Buffer.byteLength(serialized) > MAX_STORE_BYTES) {
      throw new DriveConnectionStoreError('STORE_TOO_LARGE', 'Too many Google Drive connections are saved.');
    }
    try {
      await atomicWriteFile(this.storePath, serialized, {
        rootPath: this.storageRoot,
        maximumBytes: MAX_STORE_BYTES,
        mode: 0o600
      });
    } catch (error) {
      throw new DriveConnectionStoreError(
        'STORE_WRITE_FAILED',
        'Google Drive connection could not be saved securely.',
        { cause: error?.code || error?.name || 'write-error' }
      );
    }
  }

  _serialize(operation) {
    const result = this.writeQueue.then(operation, operation);
    this.writeQueue = result.then(() => undefined, () => undefined);
    return result;
  }

  _newConnectionId() {
    const id = String(this.randomUUID());
    if (!CONNECTION_ID_PATTERN.test(id)) {
      throw new TypeError('Drive connection ID generator returned an invalid value');
    }
    return id;
  }

  _baseRecord(input, kind, previous = null) {
    const capabilities = normalizeCapabilities(input.capabilities);
    const now = this._timestamp();
    return {
      id: previous?.id || boundedString(input.id, 'Connection ID', {
        maximumLength: 100,
        pattern: CONNECTION_ID_PATTERN,
        fallback: this._newConnectionId()
      }),
      kind,
      folderId: boundedString(input.folderId, 'Folder ID', {
        required: true,
        maximumLength: 200,
        pattern: DRIVE_ID_PATTERN
      }),
      folderName: boundedString(input.folderName, 'Folder name', {
        maximumLength: 240,
        fallback: 'Google Drive folder'
      }),
      resourceKey: boundedString(input.resourceKey, 'Resource key', {
        maximumLength: 200,
        pattern: RESOURCE_KEY_PATTERN
      }),
      accountEmail: kind === 'private'
        ? boundedString(input.accountEmail, 'Account email', {
          maximumLength: 320,
          pattern: EMAIL_PATTERN
        })
        : null,
      accountName: kind === 'private'
        ? boundedString(input.accountName, 'Account name', { maximumLength: 160 })
        : null,
      capabilities,
      writeEnabled: kind === 'private'
        && input.writeEnabled === true
        && capabilitiesAllowWrite(capabilities),
      createdAt: previous?.createdAt || now,
      updatedAt: now,
      secret: null
    };
  }

  async _save(input, kind) {
    return this._serialize(async () => {
      const records = await this._readRecords();
      const requestedId = input.id
        ? boundedString(input.id, 'Connection ID', {
          required: true,
          maximumLength: 100,
          pattern: CONNECTION_ID_PATTERN
        })
        : null;
      const index = requestedId ? records.findIndex(record => record.id === requestedId) : -1;
      const previous = index >= 0 ? records[index] : null;
      if (previous && previous.kind !== kind) {
        throw new DriveConnectionStoreError(
          'CONNECTION_KIND_CHANGED',
          'Disconnect the existing Google Drive source before changing its type.'
        );
      }
      if (!previous && records.length >= this.maximumConnections) {
        throw new DriveConnectionStoreError(
          'CONNECTION_LIMIT_REACHED',
          'Disconnect an unused Google Drive source before adding another one.'
        );
      }
      const record = this._baseRecord({ ...input, id: requestedId }, kind, previous);
      if (kind === 'private') {
        record.secret = await this._encryptRefreshToken(input.refreshToken);
      }
      const normalized = normalizeRecord(record);
      if (index >= 0) records[index] = normalized;
      else records.push(normalized);
      await this._writeRecords(records);
      return sanitizeConnection(normalized);
    });
  }

  savePrivateConnection(input = {}) {
    return this._save(input, 'private');
  }

  async savePublicConnection(input = {}) {
    if (Object.hasOwn(input, 'refreshToken') && input.refreshToken) {
      throw new DriveConnectionStoreError(
        'PUBLIC_CREDENTIAL_FORBIDDEN',
        'Public Google Drive links cannot store an OAuth credential.'
      );
    }
    return this._save({ ...input, writeEnabled: false }, 'public');
  }

  async listConnections() {
    const records = await this._readRecords();
    return Object.freeze(records.map(sanitizeConnection));
  }

  async getConnectionSummary(connectionId) {
    const id = boundedString(connectionId, 'Connection ID', {
      required: true,
      maximumLength: 100,
      pattern: CONNECTION_ID_PATTERN
    });
    const record = (await this._readRecords()).find(item => item.id === id);
    return record ? sanitizeConnection(record) : null;
  }

  async getConnection(connectionId) {
    const id = boundedString(connectionId, 'Connection ID', {
      required: true,
      maximumLength: 100,
      pattern: CONNECTION_ID_PATTERN
    });
    const record = (await this._readRecords()).find(item => item.id === id);
    if (!record) return null;
    return Object.freeze({
      id: record.id,
      kind: record.kind,
      folderId: record.folderId,
      folderName: record.folderName,
      resourceKey: record.resourceKey,
      accountEmail: record.accountEmail,
      accountName: record.accountName,
      capabilities: record.capabilities,
      writeEnabled: record.writeEnabled,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      refreshToken: record.kind === 'private'
        ? await this._decryptRefreshToken(record.secret)
        : null
    });
  }

  async setWriteEnabled(connectionId, enabled) {
    if (typeof enabled !== 'boolean') {
      throw new DriveConnectionStoreError('INVALID_WRITE_SETTING', 'Write access setting must be on or off.');
    }
    return this._serialize(async () => {
      const records = await this._readRecords();
      const id = boundedString(connectionId, 'Connection ID', {
        required: true,
        maximumLength: 100,
        pattern: CONNECTION_ID_PATTERN
      });
      const index = records.findIndex(record => record.id === id);
      if (index < 0) throw new DriveConnectionStoreError('CONNECTION_NOT_FOUND', 'Google Drive source was not found.');
      const record = records[index];
      if (record.kind !== 'private') {
        throw new DriveConnectionStoreError(
          'PUBLIC_WRITE_FORBIDDEN',
          'Public Google Drive links are always read-only.'
        );
      }
      if (enabled && !capabilitiesAllowWrite(record.capabilities)) {
        throw new DriveConnectionStoreError(
          'WRITE_NOT_ALLOWED',
          'Google Drive did not grant write access to this folder.'
        );
      }
      records[index] = normalizeRecord({
        ...record,
        writeEnabled: enabled,
        updatedAt: this._timestamp()
      });
      await this._writeRecords(records);
      return sanitizeConnection(records[index]);
    });
  }

  async disconnect(connectionId) {
    const removed = await this._serialize(async () => {
      const records = await this._readRecords();
      const id = boundedString(connectionId, 'Connection ID', {
        required: true,
        maximumLength: 100,
        pattern: CONNECTION_ID_PATTERN
      });
      const index = records.findIndex(record => record.id === id);
      if (index < 0) return null;
      const [record] = records.splice(index, 1);
      await this._writeRecords(records);
      return { record, summary: sanitizeConnection(record) };
    });
    if (!removed) return Object.freeze({ disconnected: false, remoteRevoked: null, warningCode: null });

    let remoteRevoked = removed.record.kind === 'private' ? false : null;
    let warningCode = null;
    if (removed.record.kind === 'private' && this.revokeToken) {
      try {
        const refreshToken = await this._decryptRefreshToken(removed.record.secret);
        const result = await this.revokeToken(refreshToken, removed.summary);
        remoteRevoked = result !== false;
        if (!remoteRevoked) warningCode = 'REMOTE_REVOCATION_FAILED';
      } catch (_error) {
        warningCode = 'REMOTE_REVOCATION_FAILED';
      }
    }
    const result = Object.freeze({ disconnected: true, remoteRevoked, warningCode });
    if (this.onDisconnect) {
      try {
        await this.onDisconnect(removed.summary, result);
      } catch (_error) {
        // Disconnect hooks are informational and must not restore deleted credentials.
      }
    }
    return result;
  }
}

module.exports = {
  CURRENT_DRIVE_CONNECTION_SCHEMA_VERSION,
  DriveConnectionStore,
  DriveConnectionStoreError,
  capabilitiesAllowWrite,
  normalizeCapabilities,
  sanitizeConnection
};
