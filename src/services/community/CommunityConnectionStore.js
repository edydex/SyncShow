'use strict';

const crypto = require('crypto');
const path = require('path');

const {
  atomicWriteFile,
  ensurePrivateDirectory,
  readFileNoFollow
} = require('../project/StorageSafety');

const LEGACY_CONNECTION_SCHEMA_VERSION = 1;
const RESOURCE_SCOPE_CONNECTION_SCHEMA_VERSION = 2;
const EFFECTIVE_SCOPE_CONNECTION_SCHEMA_VERSION = 3;
const PRE_SERVICE_DOCUMENT_CONNECTION_SCHEMA_VERSION = 4;
const CONNECTION_SCHEMA_VERSION = 5;
const MAX_STORE_BYTES = 2 * 1024 * 1024;
const MAX_CONNECTIONS = 64;
const DEFAULT_SECURE_STORAGE_TIMEOUT_MS = 15000;
const CONNECTION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{7,99}$/;
const SERVER_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const ACCOUNT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,255}$/;
const EMAIL_PATTERN = /^[^\s@]{1,128}@[^\s@]{1,190}$/;
const SONG_SCOPES = new Set(['syncshow:songs:read', 'syncshow:songs:write']);
const PRE_PUBLIC_LINK_SCOPES = new Set([
  ...SONG_SCOPES,
  'syncshow:sermons:read',
  'syncshow:sermons:write',
  'syncshow:sermon-sources:read',
  'syncshow:sermon-sources:write'
]);
const KNOWN_SCOPES = new Set([
  ...PRE_PUBLIC_LINK_SCOPES,
  'syncshow:song-public-links:read',
  'syncshow:song-public-links:write',
  'syncshow:sermon-publications:read',
  'syncshow:sermon-media:read',
  'syncshow:sermon-media:write',
  'syncshow:service-plans:read',
  'syncshow:service-documents:read',
  'syncshow:service-documents:write'
]);

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

function normalizeScopes(value, {
  legacySongsOnly = false,
  allowEmpty = false,
  allowPublicLinks = true,
  allowServiceDocuments = true
} = {}) {
  const baselineScopes = legacySongsOnly
    ? SONG_SCOPES
    : allowPublicLinks
      ? KNOWN_SCOPES
      : PRE_PUBLIC_LINK_SCOPES;
  const allowedScopes = allowServiceDocuments
    ? baselineScopes
    : new Set([...baselineScopes].filter(scope =>
        !scope.startsWith('syncshow:service-documents:')));
  if (!Array.isArray(value)
    || (!allowEmpty && value.length < 1)
    || value.length > allowedScopes.size) {
    fail('INVALID_CONNECTION', 'Community access scopes are invalid.');
  }
  const scopes = [...new Set(value)];
  if (scopes.some(scope => typeof scope !== 'string' || !allowedScopes.has(scope))) {
    fail('INVALID_CONNECTION', 'Community access scopes are invalid.');
  }
  if (scopes.includes('syncshow:songs:write') && !scopes.includes('syncshow:songs:read')) {
    fail('INVALID_CONNECTION', 'Song write access also requires song read access.');
  }
  if (scopes.includes('syncshow:sermons:write')
    && !scopes.includes('syncshow:sermons:read')) {
    fail('INVALID_CONNECTION', 'Sermon write access also requires sermon read access.');
  }
  if (scopes.includes('syncshow:sermon-sources:read')
    && !scopes.includes('syncshow:sermons:read')) {
    fail('INVALID_CONNECTION', 'Sermon source access also requires sermon read access.');
  }
  if (scopes.includes('syncshow:sermon-sources:write')
    && (!scopes.includes('syncshow:sermon-sources:read')
      || !scopes.includes('syncshow:sermons:write'))) {
    fail(
      'INVALID_CONNECTION',
      'Sermon source write access requires source read and sermon write access.'
    );
  }
  if (scopes.includes('syncshow:sermon-publications:read')
    && !scopes.includes('syncshow:sermons:read')) {
    fail(
      'INVALID_CONNECTION',
      'Sermon publication read access also requires sermon read access.'
    );
  }
  if (scopes.includes('syncshow:sermon-media:read')
    && !scopes.includes('syncshow:sermons:read')) {
    fail(
      'INVALID_CONNECTION',
      'Sermon media read access also requires sermon read access.'
    );
  }
  if (scopes.includes('syncshow:sermon-media:write')
    && (!scopes.includes('syncshow:sermon-media:read')
      || !scopes.includes('syncshow:sermons:read'))) {
    fail(
      'INVALID_CONNECTION',
      'Sermon media write access requires media read and sermon read access.'
    );
  }
  if (scopes.includes('syncshow:song-public-links:read')
    && !scopes.includes('syncshow:songs:read')) {
    fail(
      'INVALID_CONNECTION',
      'Song public-link read access also requires song read access.'
    );
  }
  if (scopes.includes('syncshow:song-public-links:write')
    && (!scopes.includes('syncshow:song-public-links:read')
      || !scopes.includes('syncshow:songs:read'))) {
    fail(
      'INVALID_CONNECTION',
      'Song public-link write access requires public-link read and song read access.'
    );
  }
  if (scopes.includes('syncshow:service-documents:write')
    && !scopes.includes('syncshow:service-documents:read')) {
    fail(
      'INVALID_CONNECTION',
      'Service-document write access also requires service-document read access.'
    );
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

function normalizeRecord(value, {
  schemaVersion = CONNECTION_SCHEMA_VERSION
} = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail('CORRUPT_STORE', 'Saved community connection is invalid.');
  }
  const baseUrl = normalizeServerUrl(value.baseUrl, 'Community server URL');
  const apiBaseUrl = normalizeServerUrl(value.apiBaseUrl, 'Community API URL', { api: true });
  if (new URL(baseUrl).origin !== new URL(apiBaseUrl).origin) {
    fail('CORRUPT_STORE', 'Saved community API origin does not match its server.');
  }
  const scopes = normalizeScopes(value.scopes, {
    legacySongsOnly: schemaVersion === LEGACY_CONNECTION_SCHEMA_VERSION,
    allowPublicLinks:
      schemaVersion >= PRE_SERVICE_DOCUMENT_CONNECTION_SCHEMA_VERSION,
    allowServiceDocuments: schemaVersion >= CONNECTION_SCHEMA_VERSION
  });
  // Schema v1 and v2 predate a separately persisted capability advertisement.
  // Their exact grant is the only safe baseline until main refreshes discovery.
  const advertisedScopes = schemaVersion < PRE_SERVICE_DOCUMENT_CONNECTION_SCHEMA_VERSION
    ? (schemaVersion < EFFECTIVE_SCOPE_CONNECTION_SCHEMA_VERSION
      ? [...scopes]
      : normalizeScopes(value.advertisedScopes, {
        allowEmpty: true,
        allowPublicLinks: false
      }))
    : normalizeScopes(value.advertisedScopes, {
        allowEmpty: true,
        allowServiceDocuments: schemaVersion >= CONNECTION_SCHEMA_VERSION
      });
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
    scopes,
    advertisedScopes,
    expiresAt: normalizeTimestamp(value.expiresAt, 'Access expiration time', { required: true }),
    createdAt: normalizeTimestamp(value.createdAt, 'Connection creation time', { required: true }),
    updatedAt: normalizeTimestamp(value.updatedAt, 'Connection update time', { required: true }),
    secret: normalizeSecret(value.secret)
  };
}

function sanitize(record) {
  const advertisedScopes = new Set(record.advertisedScopes);
  const effectiveScopes = record.scopes.filter(scope => advertisedScopes.has(scope));
  return Object.freeze({
    id: record.id,
    serverId: record.serverId,
    serverName: record.serverName,
    baseUrl: record.baseUrl,
    apiBaseUrl: record.apiBaseUrl,
    account: Object.freeze({ ...record.account }),
    scopes: Object.freeze([...record.scopes]),
    advertisedScopes: Object.freeze([...record.advertisedScopes]),
    effectiveScopes: Object.freeze(effectiveScopes),
    canReadSongs: effectiveScopes.includes('syncshow:songs:read'),
    canWriteSongs: effectiveScopes.includes('syncshow:songs:write'),
    canReadSongPublicLinks:
      effectiveScopes.includes('syncshow:song-public-links:read'),
    canWriteSongPublicLinks:
      effectiveScopes.includes('syncshow:song-public-links:write'),
    canReadSermons: effectiveScopes.includes('syncshow:sermons:read'),
    canWriteSermons: effectiveScopes.includes('syncshow:sermons:write'),
    canReadSermonPublications:
      effectiveScopes.includes('syncshow:sermon-publications:read'),
    canReadSermonMedia:
      effectiveScopes.includes('syncshow:sermon-media:read'),
    canWriteSermonMedia:
      effectiveScopes.includes('syncshow:sermon-media:write'),
    canReadSermonSources: effectiveScopes.includes('syncshow:sermon-sources:read'),
    canWriteSermonSources: effectiveScopes.includes('syncshow:sermon-sources:write'),
    canReadServicePlans: effectiveScopes.includes('syncshow:service-plans:read'),
    canReadServiceDocuments:
      effectiveScopes.includes('syncshow:service-documents:read'),
    canWriteServiceDocuments:
      effectiveScopes.includes('syncshow:service-documents:write'),
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
    maximumConnections = MAX_CONNECTIONS,
    secureStorageTimeoutMs = DEFAULT_SECURE_STORAGE_TIMEOUT_MS,
    setTimeoutImpl = setTimeout,
    clearTimeoutImpl = clearTimeout
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
    if (typeof now !== 'function'
      || typeof randomUUID !== 'function'
      || typeof setTimeoutImpl !== 'function'
      || typeof clearTimeoutImpl !== 'function') {
      throw new TypeError('Community connection store dependencies are invalid');
    }
    if (!Number.isSafeInteger(maximumConnections)
      || maximumConnections < 1
      || maximumConnections > MAX_CONNECTIONS) {
      throw new TypeError(`Community connection limit must be between 1 and ${MAX_CONNECTIONS}`);
    }
    if (!Number.isSafeInteger(secureStorageTimeoutMs)
      || secureStorageTimeoutMs < 100
      || secureStorageTimeoutMs > 30000) {
      throw new TypeError('Community secure-storage timeout must be between 100ms and 30 seconds');
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
    this.secureStorageTimeoutMs = secureStorageTimeoutMs;
    this.setTimeout = setTimeoutImpl;
    this.clearTimeout = clearTimeoutImpl;
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
      return 'Approve any macOS Keychain prompt for SyncShow, then click Connect again. If no prompt appears, unlock the login keychain, fully quit SyncShow, and reopen it.';
    }
    return 'Secure credential storage is unavailable. Unlock the system credential store, then reopen SyncShow.';
  }

  async _boundedAsyncStorageOperation(operation) {
    let timer = null;
    try {
      return await Promise.race([
        Promise.resolve().then(operation),
        new Promise((_, reject) => {
          timer = this.setTimeout(() => {
            const error = new Error('Secure credential storage timed out.');
            error.code = 'SECURE_STORAGE_TIMEOUT';
            reject(error);
          }, this.secureStorageTimeoutMs);
          timer?.unref?.();
        })
      ]);
    } finally {
      if (timer !== null) this.clearTimeout(timer);
    }
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
        if (await this._boundedAsyncStorageOperation(
          () => this.safeStorage.isAsyncEncryptionAvailable()
        )) {
          return 'async';
        }
      } catch (_error) {
        // Non-macOS may still use its complete synchronous secure provider.
      }
      // Electron 43's macOS synchronous and asynchronous providers can both
      // block in Keychain. Once the bounded async contract exists, fail closed
      // instead of moving the hang onto the main thread through the sync API.
      if (this.platform === 'darwin') {
        fail('SECURE_STORAGE_UNAVAILABLE', this._unavailableMessage());
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
        ? await this._boundedAsyncStorageOperation(
          () => this.safeStorage.encryptStringAsync(plaintext)
        )
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
        ? await this._boundedAsyncStorageOperation(
          () => this.safeStorage.decryptStringAsync(ciphertext)
        )
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
      || ![
        LEGACY_CONNECTION_SCHEMA_VERSION,
        RESOURCE_SCOPE_CONNECTION_SCHEMA_VERSION,
        EFFECTIVE_SCOPE_CONNECTION_SCHEMA_VERSION,
        PRE_SERVICE_DOCUMENT_CONNECTION_SCHEMA_VERSION,
        CONNECTION_SCHEMA_VERSION
      ].includes(payload.schemaVersion)
      || !Array.isArray(payload.connections)
      || payload.connections.length > this.maximumConnections) {
      fail('CORRUPT_STORE', 'Saved community connections are corrupt.');
    }
    const records = payload.connections.map(record => normalizeRecord(record, {
      schemaVersion: payload.schemaVersion
    }));
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
        advertisedScopes: input.advertisedScopes === undefined
          ? input.scopes
          : input.advertisedScopes,
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

  updateAdvertisedScopes(connectionId, input = {}) {
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
        fail('CONNECTION_CONFLICT', 'Community capabilities changed since they were opened.');
      }
      const advertisedScopes = normalizeScopes(input.advertisedScopes, {
        allowEmpty: true
      });
      if (JSON.stringify(advertisedScopes) === JSON.stringify(record.advertisedScopes)) {
        return sanitize(record);
      }
      record.advertisedScopes = advertisedScopes;
      record.updatedAt = this._timestamp();
      records[index] = normalizeRecord(record);
      await this._writeRecords(records);
      return sanitize(records[index]);
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
  EFFECTIVE_SCOPE_CONNECTION_SCHEMA_VERSION,
  LEGACY_CONNECTION_SCHEMA_VERSION,
  PRE_SERVICE_DOCUMENT_CONNECTION_SCHEMA_VERSION,
  RESOURCE_SCOPE_CONNECTION_SCHEMA_VERSION,
  KNOWN_SCOPES,
  normalizeServerUrl
};
