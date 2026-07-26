'use strict';

const crypto = require('crypto');
const path = require('path');

const {
  atomicWriteFile,
  ensurePrivateDirectory,
  readFileNoFollow
} = require('../project/StorageSafety');

const CONNECTION_SCHEMA_VERSION = 1;
const MAX_STORE_BYTES = 2 * 1024 * 1024;
const MAX_CONNECTIONS = 64;
const CONNECTION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{7,99}$/;
const SERVER_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const ACCOUNT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,255}$/;
const EMAIL_PATTERN = /^[^\s@]{1,128}@[^\s@]{1,190}$/;
const KNOWN_SCOPES = new Set(['syncshow:songs:read', 'syncshow:songs:write']);

class CommunityConnectionStoreError extends Error {
  constructor(code, message, { cause = null } = {}) {
    super(message);
    this.name = 'CommunityConnectionStoreError';
    this.code = code;
    this.cause = cause;
  }
}

function fail(code, message, cause = null) {
  throw new CommunityConnectionStoreError(code, message, { cause });
}

function boundedText(value, label, maximum, {
  required = false,
  pattern = null,
  fallback = null
} = {}) {
  if (value === undefined || value === null || value === '') {
    if (required) fail('INVALID_CONNECTION', `${label} is required.`);
    return fallback;
  }
  if (typeof value !== 'string') fail('INVALID_CONNECTION', `${label} must be text.`);
  const normalized = value.trim();
  if (!normalized
    || normalized.length > maximum
    || /[\u0000-\u001f\u007f]/.test(normalized)
    || (pattern && !pattern.test(normalized))) {
    fail('INVALID_CONNECTION', `${label} is invalid.`);
  }
  return normalized;
}

function normalizeTimestamp(value, label, { required = false } = {}) {
  if (value === undefined || value === null || value === '') {
    if (required) fail('INVALID_CONNECTION', `${label} is required.`);
    return null;
  }
  if (typeof value !== 'string' || value.length > 40 || Number.isNaN(Date.parse(value))) {
    fail('INVALID_CONNECTION', `${label} is invalid.`);
  }
  return new Date(value).toISOString();
}

function isLoopbackHostname(hostname) {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  return normalized === 'localhost'
    || normalized === '::1'
    || /^127(?:\.\d{1,3}){3}$/.test(normalized);
}

function normalizeServerUrl(value, label, { api = false } = {}) {
  let url;
  try {
    url = new URL(value);
  } catch (_error) {
    fail('INVALID_CONNECTION', `${label} is invalid.`);
  }
  const secure = url.protocol === 'https:';
  const loopbackDevelopment = url.protocol === 'http:' && isLoopbackHostname(url.hostname);
  if ((!secure && !loopbackDevelopment)
    || url.username
    || url.password
    || url.search
    || url.hash) {
    fail('INVALID_CONNECTION', `${label} must use HTTPS.`);
  }
  if (url.pathname.includes('/../') || url.pathname.includes('/./')) {
    fail('INVALID_CONNECTION', `${label} is invalid.`);
  }
  if (!api && url.pathname !== '/') fail('INVALID_CONNECTION', `${label} must be a server origin.`);
  if (api
    && url.pathname !== '/api/community/syncshow/v1'
    && !url.pathname.startsWith('/api/community/syncshow/v1/')) {
    fail('INVALID_CONNECTION', `${label} is not a SyncShow community endpoint.`);
  }
  url.pathname = api ? url.pathname.replace(/\/+$/, '') : '/';
  return url.toString();
}

function normalizeScopes(value) {
  if (!Array.isArray(value) || value.length < 1 || value.length > KNOWN_SCOPES.size) {
    fail('INVALID_CONNECTION', 'Community access scopes are invalid.');
  }
  const scopes = [...new Set(value)];
  if (scopes.some(scope => !KNOWN_SCOPES.has(scope))) {
    fail('INVALID_CONNECTION', 'Community access scopes are invalid.');
  }
  if (scopes.includes('syncshow:songs:write') && !scopes.includes('syncshow:songs:read')) {
    fail('INVALID_CONNECTION', 'Song write access also requires song read access.');
  }
  return scopes.sort();
}

function normalizeAccount(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail('INVALID_CONNECTION', 'Community account is invalid.');
  }
  return {
    id: boundedText(value.id, 'Account ID', 256, {
      required: true,
      pattern: ACCOUNT_ID_PATTERN
    }),
    email: boundedText(value.email, 'Account email', 320, {
      required: true,
      pattern: EMAIL_PATTERN
    }),
    name: boundedText(value.name, 'Account name', 160)
  };
}

function normalizeSecret(value) {
  if (!value || value.format !== 'electron-safe-storage-v1') {
    fail('CORRUPT_STORE', 'Saved community credentials are missing.');
  }
  const ciphertext = value.ciphertext;
  if (typeof ciphertext !== 'string' || ciphertext.length < 4 || ciphertext.length > 256 * 1024) {
    fail('CORRUPT_STORE', 'Saved community credentials are invalid.');
  }
  const decoded = Buffer.from(ciphertext, 'base64');
  if (!decoded.length || decoded.toString('base64') !== ciphertext) {
    fail('CORRUPT_STORE', 'Saved community credentials are invalid.');
  }
  return { format: 'electron-safe-storage-v1', ciphertext };
}

function normalizeRecord(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail('CORRUPT_STORE', 'Saved community connection is invalid.');
  }
  const baseUrl = normalizeServerUrl(value.baseUrl, 'Community server URL');
  const apiBaseUrl = normalizeServerUrl(value.apiBaseUrl, 'Community API URL', { api: true });
  if (new URL(baseUrl).origin !== new URL(apiBaseUrl).origin) {
    fail('CORRUPT_STORE', 'Saved community API origin does not match its server.');
  }
  return {
    id: boundedText(value.id, 'Connection ID', 100, {
      required: true,
      pattern: CONNECTION_ID_PATTERN
    }),
    serverId: boundedText(value.serverId, 'Server ID', 128, {
      required: true,
      pattern: SERVER_ID_PATTERN
    }),
    serverName: boundedText(value.serverName, 'Server name', 160, {
      fallback: 'Heritage Community'
    }),
    baseUrl,
    apiBaseUrl,
    account: normalizeAccount(value.account),
    scopes: normalizeScopes(value.scopes),
    expiresAt: normalizeTimestamp(value.expiresAt, 'Access expiration time', { required: true }),
    createdAt: normalizeTimestamp(value.createdAt, 'Connection creation time', { required: true }),
    updatedAt: normalizeTimestamp(value.updatedAt, 'Connection update time', { required: true }),
    secret: normalizeSecret(value.secret)
  };
}

function sanitize(record) {
  return Object.freeze({
    id: record.id,
    serverId: record.serverId,
    serverName: record.serverName,
    baseUrl: record.baseUrl,
    account: Object.freeze({ ...record.account }),
    scopes: Object.freeze([...record.scopes]),
    canReadSongs: record.scopes.includes('syncshow:songs:read'),
    canWriteSongs: record.scopes.includes('syncshow:songs:write'),
    expiresAt: record.expiresAt,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt
  });
}

function normalizeTokenBundle(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail('INVALID_CREDENTIAL', 'Community credentials are invalid.');
  }
  return {
    accessToken: boundedText(value.accessToken, 'Community access token', 16384, {
      required: true,
      pattern: /^[^\s\u0000-\u001f\u007f]{16,16384}$/
    }),
    // Protocol v1 intentionally permits a null refresh token. Community
    // device grants are long-lived but still re-check manager membership on
    // every request; an expired grant is re-approved instead of silently
    // introducing an unreviewed rotating-refresh credential family.
    refreshToken: boundedText(value.refreshToken, 'Community refresh token', 16384, {
      pattern: /^[^\s\u0000-\u001f\u007f]{16,16384}$/
    })
  };
}

class CommunityConnectionStore {
  constructor({
    storageRoot,
    safeStorage,
    platform = process.platform,
    now = () => new Date(),
    randomUUID = crypto.randomUUID,
    maximumConnections = MAX_CONNECTIONS
  } = {}) {
    if (typeof storageRoot !== 'string' || !path.isAbsolute(storageRoot)) {
      throw new TypeError('Community connection storage root must be absolute');
    }
    const synchronous = Boolean(
      safeStorage
      && typeof safeStorage.isEncryptionAvailable === 'function'
      && typeof safeStorage.encryptString === 'function'
      && typeof safeStorage.decryptString === 'function'
    );
    const asynchronous = Boolean(
      safeStorage
      && typeof safeStorage.isAsyncEncryptionAvailable === 'function'
      && typeof safeStorage.encryptStringAsync === 'function'
      && typeof safeStorage.decryptStringAsync === 'function'
    );
    if (!synchronous && !asynchronous) {
      throw new TypeError('Community connection store requires Electron safeStorage');
    }
    if (!['darwin', 'linux', 'win32'].includes(platform)) {
      throw new TypeError('Community connection store platform is invalid');
    }
    if (typeof now !== 'function' || typeof randomUUID !== 'function') {
      throw new TypeError('Community connection store dependencies are invalid');
    }
    if (!Number.isSafeInteger(maximumConnections)
      || maximumConnections < 1
      || maximumConnections > MAX_CONNECTIONS) {
      throw new TypeError(`Community connection limit must be between 1 and ${MAX_CONNECTIONS}`);
    }
    this.storageRoot = path.resolve(storageRoot);
    this.storePath = path.join(this.storageRoot, 'connections.json');
    this.safeStorage = safeStorage;
    this.platform = platform;
    this.synchronous = synchronous;
    this.asynchronous = asynchronous;
    this.now = now;
    this.randomUUID = randomUUID;
    this.maximumConnections = maximumConnections;
    this.writeQueue = Promise.resolve();
  }

  _timestamp() {
    const current = this.now();
    const parsed = current instanceof Date ? current : new Date(current);
    if (Number.isNaN(parsed.getTime())) throw new TypeError('Community connection clock is invalid');
    return parsed.toISOString();
  }

  _unavailableMessage() {
    if (this.platform === 'darwin') {
      return 'Your Mac login keychain is locked or unavailable. Unlock it, fully quit SyncShow, then reopen it.';
    }
    return 'Secure credential storage is unavailable. Unlock the system credential store, then reopen SyncShow.';
  }

  async _storageMode() {
    if (this.platform === 'linux'
      && typeof this.safeStorage.getSelectedStorageBackend === 'function'
      && this.safeStorage.getSelectedStorageBackend() === 'basic_text') {
      fail(
        'INSECURE_SECRET_STORAGE',
        'Linux credential storage is using basic_text. Configure a secure keyring before connecting a Community server.'
      );
    }
    if (this.asynchronous) {
      try {
        if (await this.safeStorage.isAsyncEncryptionAvailable()) return 'async';
      } catch (_error) {
        // A complete synchronous secure provider may still be available.
      }
    }
    if (this.synchronous) {
      try {
        if (this.safeStorage.isEncryptionAvailable()) return 'sync';
      } catch (_error) {
        // Fail closed below.
      }
    }
    fail('SECURE_STORAGE_UNAVAILABLE', this._unavailableMessage());
  }

  async _encrypt(tokens, mode = null) {
    const normalized = normalizeTokenBundle(tokens);
    const selectedMode = mode || await this._storageMode();
    let encrypted;
    try {
      const plaintext = JSON.stringify(normalized);
      encrypted = selectedMode === 'async'
        ? await this.safeStorage.encryptStringAsync(plaintext)
        : this.safeStorage.encryptString(plaintext);
    } catch (error) {
      fail('ENCRYPTION_FAILED', 'Community credentials could not be encrypted.', error?.code || error?.name);
    }
    if (!Buffer.isBuffer(encrypted) || encrypted.length === 0) {
      fail('ENCRYPTION_FAILED', 'Community credentials could not be encrypted.');
    }
    return {
      format: 'electron-safe-storage-v1',
      ciphertext: encrypted.toString('base64')
    };
  }

  async _decrypt(secret, mode = null) {
    const selectedMode = mode || await this._storageMode();
    try {
      const ciphertext = Buffer.from(secret.ciphertext, 'base64');
      const decrypted = selectedMode === 'async'
        ? await this.safeStorage.decryptStringAsync(ciphertext)
        : this.safeStorage.decryptString(ciphertext);
      const plaintext = selectedMode === 'async' ? decrypted?.result : decrypted;
      return normalizeTokenBundle(JSON.parse(plaintext));
    } catch (error) {
      if (error instanceof CommunityConnectionStoreError) throw error;
      fail('DECRYPTION_FAILED', 'Saved community credentials could not be decrypted.', error?.code || error?.name);
    }
  }

  async assertSecureStorageAvailable() {
    const probe = { accessToken: 'syncshow-community-storage-check' };
    try {
      const mode = await this._storageMode();
      const encrypted = await this._encrypt(probe, mode);
      const decrypted = await this._decrypt(encrypted, mode);
      if (decrypted.accessToken !== probe.accessToken) throw new Error('round-trip-failed');
      return true;
    } catch (error) {
      if (error instanceof CommunityConnectionStoreError
        && error.code === 'INSECURE_SECRET_STORAGE') throw error;
      fail(
        'SECURE_STORAGE_UNAVAILABLE',
        this._unavailableMessage(),
        error?.code || error?.name
      );
    }
  }

  async _readRecords() {
    await ensurePrivateDirectory(this.storageRoot);
    let buffer;
    try {
      ({ buffer } = await readFileNoFollow(this.storePath, MAX_STORE_BYTES));
    } catch (error) {
      if (error.code === 'ENOENT') return [];
      fail('STORE_READ_FAILED', 'Saved community connections could not be read.', error?.code);
    }
    let payload;
    try {
      payload = JSON.parse(buffer.toString('utf8'));
    } catch (_error) {
      fail('CORRUPT_STORE', 'Saved community connections are corrupt.');
    }
    if (!payload
      || payload.schemaVersion !== CONNECTION_SCHEMA_VERSION
      || !Array.isArray(payload.connections)
      || payload.connections.length > this.maximumConnections) {
      fail('CORRUPT_STORE', 'Saved community connections are corrupt.');
    }
    const records = payload.connections.map(normalizeRecord);
    if (new Set(records.map(record => record.id)).size !== records.length) {
      fail('CORRUPT_STORE', 'Saved community connection IDs conflict.');
    }
    return records;
  }

  async _writeRecords(records) {
    const serialized = `${JSON.stringify({
      schemaVersion: CONNECTION_SCHEMA_VERSION,
      connections: records
    }, null, 2)}\n`;
    if (Buffer.byteLength(serialized, 'utf8') > MAX_STORE_BYTES) {
      fail('STORE_TOO_LARGE', 'Too many community connections are saved.');
    }
    try {
      await atomicWriteFile(this.storePath, serialized, {
        rootPath: this.storageRoot,
        maximumBytes: MAX_STORE_BYTES,
        mode: 0o600
      });
    } catch (error) {
      fail('STORE_WRITE_FAILED', 'Community connection could not be saved securely.', error?.code);
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

  saveConnection(input = {}) {
    return this._serialize(async () => {
      const records = await this._readRecords();
      const id = input.id
        ? this._connectionId(input.id)
        : this._connectionId(String(this.randomUUID()));
      const index = records.findIndex(record => record.id === id);
      if (index < 0 && records.length >= this.maximumConnections) {
        fail('CONNECTION_LIMIT_REACHED', 'Disconnect an unused Community server before adding another one.');
      }
      const previous = index >= 0 ? records[index] : null;
      const baseUrl = normalizeServerUrl(input.baseUrl, 'Community server URL');
      const apiBaseUrl = normalizeServerUrl(input.apiBaseUrl, 'Community API URL', { api: true });
      if (new URL(baseUrl).origin !== new URL(apiBaseUrl).origin) {
        fail('INVALID_CONNECTION', 'Community API origin does not match its server.');
      }
      const now = this._timestamp();
      const record = normalizeRecord({
        id,
        serverId: input.serverId,
        serverName: input.serverName,
        baseUrl,
        apiBaseUrl,
        account: input.account,
        scopes: input.scopes,
        expiresAt: input.expiresAt,
        createdAt: previous?.createdAt || now,
        updatedAt: now,
        secret: await this._encrypt(input)
      });
      if (index >= 0) records[index] = record;
      else records.push(record);
      await this._writeRecords(records);
      return sanitize(record);
    });
  }

  async listConnections() {
    return Object.freeze((await this._readRecords()).map(sanitize));
  }

  async getConnectionSummary(connectionId) {
    const id = this._connectionId(connectionId);
    const record = (await this._readRecords()).find(candidate => candidate.id === id);
    return record ? sanitize(record) : null;
  }

  async getConnection(connectionId) {
    const id = this._connectionId(connectionId);
    const record = (await this._readRecords()).find(candidate => candidate.id === id);
    if (!record) return null;
    const tokens = await this._decrypt(record.secret);
    return Object.freeze({
      ...sanitize(record),
      apiBaseUrl: record.apiBaseUrl,
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken
    });
  }

  updateTokens(connectionId, input = {}) {
    const id = this._connectionId(connectionId);
    return this._serialize(async () => {
      const records = await this._readRecords();
      const index = records.findIndex(record => record.id === id);
      if (index < 0) fail('CONNECTION_NOT_FOUND', 'Community connection was not found.');
      const record = records[index];
      if (input.expectedUpdatedAt && normalizeTimestamp(
        input.expectedUpdatedAt,
        'Expected update time',
        { required: true }
      ) !== record.updatedAt) {
        fail('CONNECTION_CONFLICT', 'Community credentials changed since they were opened.');
      }
      const previous = await this._decrypt(record.secret);
      record.secret = await this._encrypt({
        accessToken: input.accessToken,
        refreshToken: input.refreshToken === undefined
          ? previous.refreshToken
          : input.refreshToken
      });
      record.expiresAt = normalizeTimestamp(input.expiresAt, 'Access expiration time', {
        required: true
      });
      record.updatedAt = this._timestamp();
      records[index] = normalizeRecord(record);
      await this._writeRecords(records);
      return sanitize(records[index]);
    });
  }

  disconnect(connectionId) {
    const id = this._connectionId(connectionId);
    return this._serialize(async () => {
      const records = await this._readRecords();
      const retained = records.filter(record => record.id !== id);
      const disconnected = retained.length !== records.length;
      if (disconnected) await this._writeRecords(retained);
      return { disconnected };
    });
  }
}

module.exports = {
  CommunityConnectionStore,
  CommunityConnectionStoreError,
  CONNECTION_SCHEMA_VERSION,
  KNOWN_SCOPES,
  normalizeServerUrl
};
