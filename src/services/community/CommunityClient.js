'use strict';

const crypto = require('crypto');

const DISCOVERY_PATH = '/.well-known/heritage-community.json';
const DEFAULT_API_PATH = '/api/community/syncshow/v1';
const DEFAULT_TIMEOUT_MS = 15000;
const DEFAULT_JSON_LIMIT = 4 * 1024 * 1024;
const AUTHORIZATION_RECOVERY_GRACE_MS = 15 * 60 * 1000;
const MAX_DOCUMENT_BYTES = 512 * 1024;
const MAX_DOCUMENTS = 32;
const MAX_DOCUMENT_TOTAL_BYTES = 2 * 1024 * 1024;
const SYNC_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const TOKEN_PATTERN = /^[^\s\u0000-\u001f\u007f]{16,16384}$/;
const KNOWN_SCOPES = new Set(['syncshow:songs:read', 'syncshow:songs:write']);
const VISIBILITIES = new Set(['private', 'public', 'scheduled-public']);

class CommunityClientError extends Error {
  constructor(code, message, {
    status = null,
    retryable = false,
    cause = null
  } = {}) {
    super(message);
    this.name = 'CommunityClientError';
    this.code = code;
    this.status = status;
    this.retryable = retryable;
    this.cause = cause;
  }
}

function fail(code, message, options = {}) {
  throw new CommunityClientError(code, message, options);
}

function boundedText(value, label, maximum, {
  required = false,
  pattern = null,
  fallback = null
} = {}) {
  if (value === undefined || value === null || value === '') {
    if (required) fail('INVALID_INPUT', `${label} is required.`);
    return fallback;
  }
  if (typeof value !== 'string') fail('INVALID_INPUT', `${label} must be text.`);
  const normalized = value.trim();
  if (!normalized
    || normalized.length > maximum
    || /[\u0000-\u001f\u007f]/.test(normalized)
    || (pattern && !pattern.test(normalized))) {
    fail('INVALID_INPUT', `${label} is invalid.`);
  }
  return normalized;
}

function isLoopbackHostname(hostname) {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  return normalized === 'localhost'
    || normalized === '::1'
    || /^127(?:\.\d{1,3}){3}$/.test(normalized);
}

function normalizeBaseUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch (_error) {
    throw new TypeError('Community server URL is invalid');
  }
  const secure = url.protocol === 'https:';
  const loopbackDevelopment = url.protocol === 'http:' && isLoopbackHostname(url.hostname);
  if ((!secure && !loopbackDevelopment)
    || url.username
    || url.password
    || url.search
    || url.hash
    || url.pathname !== '/') {
    throw new TypeError('Community server URL must be an HTTPS origin or loopback development origin');
  }
  url.pathname = '/';
  return url;
}

function normalizeScopes(value) {
  const scopes = value === undefined ? ['syncshow:songs:read'] : value;
  if (!Array.isArray(scopes) || scopes.length < 1 || scopes.length > KNOWN_SCOPES.size) {
    fail('INVALID_SCOPE', 'Community access scopes are invalid.');
  }
  const result = [...new Set(scopes)];
  if (result.some(scope => !KNOWN_SCOPES.has(scope))) {
    fail('INVALID_SCOPE', 'Community access scopes are invalid.');
  }
  if (result.includes('syncshow:songs:write') && !result.includes('syncshow:songs:read')) {
    fail('INVALID_SCOPE', 'Song write access also requires song read access.');
  }
  return result.sort();
}

function normalizeTimestamp(value, label, { required = false } = {}) {
  if (value === undefined || value === null || value === '') {
    if (required) fail('INVALID_RESPONSE', `${label} is missing.`);
    return null;
  }
  if (typeof value !== 'string' || value.length > 40 || Number.isNaN(Date.parse(value))) {
    fail('INVALID_RESPONSE', `${label} is invalid.`);
  }
  return new Date(value).toISOString();
}

function normalizeVisibility(value, publishAt = null, {
  defaultVisibility = 'private',
  response = false
} = {}) {
  const normalized = value || defaultVisibility;
  const code = response ? 'INVALID_RESPONSE' : 'INVALID_INPUT';
  if (!VISIBILITIES.has(normalized)) fail(code, 'Song visibility is invalid.');
  let scheduledAt = null;
  if (publishAt !== undefined && publishAt !== null && publishAt !== '') {
    if (typeof publishAt !== 'string' || publishAt.length > 40 || Number.isNaN(Date.parse(publishAt))) {
      fail(code, 'Scheduled publication time is invalid.');
    }
    scheduledAt = new Date(publishAt).toISOString();
  }
  if (normalized === 'scheduled-public' && !scheduledAt) {
    fail(code, 'Scheduled-public songs require a publication time.');
  }
  if (normalized !== 'scheduled-public' && scheduledAt) {
    fail(code, 'Only scheduled-public songs may have a publication time.');
  }
  return { visibility: normalized, publishAt: scheduledAt };
}

function normalizeSyncVersion(value, { required = true } = {}) {
  if ((value === undefined || value === null) && !required) return null;
  if (!Number.isSafeInteger(value) || value < 1) {
    fail('INVALID_RESPONSE', 'Community song sync version is invalid.');
  }
  return value;
}

function normalizeRevision(value, label = 'Song revision', { required = true } = {}) {
  return boundedText(value, label, 256, {
    required,
    pattern: /^[A-Za-z0-9][A-Za-z0-9._:"/-]{0,255}$/
  });
}

function normalizeSyncDocuments(value, {
  allowMissing = false,
  response = false
} = {}) {
  if ((value === undefined || value === null) && allowMissing) return null;
  const code = response ? 'INVALID_RESPONSE' : 'INVALID_INPUT';
  if (!Array.isArray(value) || value.length > MAX_DOCUMENTS) {
    fail(code, `A synced song family may contain at most ${MAX_DOCUMENTS} documents.`);
  }
  const seen = new Set();
  let totalBytes = 0;
  return value.map(document => {
    if (!document || typeof document !== 'object' || Array.isArray(document)) {
      fail(code, 'A synced song document is invalid.');
    }
    let id;
    try {
      id = boundedText(document.id, 'Song document ID', 128, {
        required: true,
        pattern: SYNC_ID_PATTERN
      });
    } catch (error) {
      if (response && error instanceof CommunityClientError) {
        fail('INVALID_RESPONSE', 'Community returned an invalid song document.');
      }
      throw error;
    }
    if (seen.has(id)) fail(code, 'A synced song family repeats a document ID.');
    seen.add(id);
    if (typeof document.source !== 'string') fail(code, 'Song document source must be text.');
    const sourceBytes = Buffer.byteLength(document.source, 'utf8');
    totalBytes += sourceBytes;
    if (sourceBytes > MAX_DOCUMENT_BYTES || totalBytes > MAX_DOCUMENT_TOTAL_BYTES) {
      fail(code, 'Synced song documents exceed the safe transfer limit.');
    }
    const revision = normalizeRevision(document.revision, 'Song document revision');
    if (revision !== crypto.createHash('sha256').update(document.source).digest('hex')) {
      fail(
        response ? 'INVALID_RESPONSE' : 'INVALID_INPUT',
        'Community song document checksum does not match its source.'
      );
    }
    return Object.freeze({
      id,
      source: document.source,
      revision
    });
  });
}

function normalizeRemoteSong(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail('INVALID_RESPONSE', 'Community returned an invalid song record.');
  }
  const syncId = boundedText(value.syncId || value.id, 'Song sync ID', 128, {
    required: true,
    pattern: SYNC_ID_PATTERN
  });
  const syncDocuments = normalizeSyncDocuments(value.syncDocuments, {
    allowMissing: true,
    response: true
  });
  const normalizedVisibility = normalizeVisibility(value.visibility, value.publishAt, {
    response: true
  });
  const advertisedAlternateTitles = Array.isArray(value.alternateTitles)
    ? value.alternateTitles.slice(0, 32).map(title =>
      boundedText(title, 'Alternate title', 240, { required: true }))
    : [];
  const alternateTitles = [...new Set([
    ...advertisedAlternateTitles,
    boundedText(value.russianTitle, 'Russian song title', 240),
    boundedText(value.englishTitle, 'English song title', 240)
  ].filter(Boolean))].slice(0, 32);
  return Object.freeze({
    syncId,
    syncVersion: normalizeSyncVersion(value.syncVersion),
    revision: normalizeRevision(
      value.revision || `song:${syncId}:${value.syncVersion}`,
      'Remote song revision'
    ),
    syncDocuments,
    metadataOnly: !syncDocuments || syncDocuments.length === 0,
    archived: value.archived === true || value.deleted === true || value.tombstone === true,
    ...normalizedVisibility,
    title: boundedText(value.title, 'Song title', 240),
    alternateTitles: Object.freeze(alternateTitles),
    updatedAt: normalizeTimestamp(value.updatedAt, 'Song update time')
  });
}

function validateLimit(value, fallback, minimum, maximum, label) {
  if (value === undefined || value === null) return fallback;
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new TypeError(`${label} must be between ${minimum} and ${maximum}`);
  }
  return value;
}

function pinnedUrl(value, {
  origin,
  apiPath,
  label,
  fallback
}) {
  let url;
  try {
    url = new URL(value || fallback, `${origin}${apiPath.replace(/\/?$/, '/')}`);
  } catch (_error) {
    fail('INVALID_DISCOVERY', `${label} is invalid.`);
  }
  const normalizedApiPath = apiPath.replace(/\/+$/, '');
  if (url.origin !== origin
    || url.username
    || url.password
    || url.search
    || url.hash
    || (url.pathname !== normalizedApiPath
      && !url.pathname.startsWith(`${normalizedApiPath}/`))) {
    fail('INVALID_DISCOVERY', `${label} escaped the Community server API.`);
  }
  return url.toString();
}

async function readResponseBuffer(response, maximumBytes) {
  const contentLength = Number(response.headers?.get?.('content-length'));
  if (Number.isFinite(contentLength) && contentLength > maximumBytes) {
    fail('RESPONSE_TOO_LARGE', 'Community server response is too large.');
  }
  if (response.body && typeof response.body.getReader === 'function') {
    const reader = response.body.getReader();
    const chunks = [];
    let length = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        length += value.byteLength;
        if (length > maximumBytes) {
          await reader.cancel().catch(() => {});
          fail('RESPONSE_TOO_LARGE', 'Community server response is too large.');
        }
        chunks.push(Buffer.from(value));
      }
    } finally {
      reader.releaseLock?.();
    }
    return Buffer.concat(chunks, length);
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length > maximumBytes) fail('RESPONSE_TOO_LARGE', 'Community server response is too large.');
  return buffer;
}

function timeoutSignal(timeoutMs, callerSignal) {
  const controller = new AbortController();
  let timedOut = false;
  let callerAbort = null;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort(new Error('request timeout'));
  }, timeoutMs);
  timer.unref?.();
  if (callerSignal) {
    if (callerSignal.aborted) controller.abort(callerSignal.reason);
    else {
      callerAbort = () => controller.abort(callerSignal.reason);
      callerSignal.addEventListener('abort', callerAbort, { once: true });
    }
  }
  return {
    signal: controller.signal,
    timedOut: () => timedOut,
    dispose() {
      clearTimeout(timer);
      if (callerAbort) callerSignal.removeEventListener('abort', callerAbort);
    }
  };
}

class CommunityClient {
  constructor({
    baseUrl,
    fetchImpl = globalThis.fetch,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    maximumJsonBytes = DEFAULT_JSON_LIMIT,
    randomBytes = crypto.randomBytes,
    randomUUID = crypto.randomUUID,
    now = () => new Date()
  } = {}) {
    if (typeof fetchImpl !== 'function') throw new TypeError('Community client requires fetch');
    if (typeof randomBytes !== 'function'
      || typeof randomUUID !== 'function'
      || typeof now !== 'function') {
      throw new TypeError('Community client dependencies are invalid');
    }
    this.baseUrl = normalizeBaseUrl(baseUrl);
    this.fetchImpl = fetchImpl;
    this.timeoutMs = validateLimit(timeoutMs, DEFAULT_TIMEOUT_MS, 1000, 120000, 'timeoutMs');
    this.maximumJsonBytes = validateLimit(
      maximumJsonBytes,
      DEFAULT_JSON_LIMIT,
      1024,
      16 * 1024 * 1024,
      'maximumJsonBytes'
    );
    this.randomBytes = randomBytes;
    this.randomUUID = randomUUID;
    this.now = now;
    this.discovery = null;
    this.authorizationFlows = new Map();
  }

  async _request(url, {
    method = 'GET',
    body = null,
    accessToken = null,
    expectedStatuses = [200],
    headers = {},
    signal = null,
    allowEmpty = false
  } = {}) {
    const target = new URL(url);
    if (target.origin !== this.baseUrl.origin
      || target.username
      || target.password
      || target.hash) {
      fail('UNSAFE_ENDPOINT', 'Community request escaped the connected server.');
    }
    const requestHeaders = {
      Accept: 'application/json',
      ...headers
    };
    let serializedBody;
    if (body !== null && body !== undefined) {
      serializedBody = JSON.stringify(body);
      if (Buffer.byteLength(serializedBody, 'utf8') > MAX_DOCUMENT_TOTAL_BYTES + 64 * 1024) {
        fail('REQUEST_TOO_LARGE', 'Community request is too large.');
      }
      requestHeaders['Content-Type'] = 'application/json';
    }
    if (accessToken !== null) {
      const token = boundedText(accessToken, 'Community access token', 16384, {
        required: true,
        pattern: TOKEN_PATTERN
      });
      requestHeaders.Authorization = `SyncShow ${token}`;
    }
    const timeout = timeoutSignal(this.timeoutMs, signal);
    let response;
    try {
      response = await this.fetchImpl(target.toString(), {
        method,
        headers: requestHeaders,
        body: serializedBody,
        redirect: 'manual',
        signal: timeout.signal
      });
    } catch (error) {
      timeout.dispose();
      if (timeout.signal.aborted) {
        if (timeout.timedOut()) {
          fail('REQUEST_TIMEOUT', 'Community server did not respond in time.', {
            retryable: true
          });
        }
        fail('REQUEST_CANCELLED', 'Community request was cancelled.');
      }
      fail('NETWORK_ERROR', 'SyncShow could not reach the Community server.', {
        retryable: true,
        cause: error?.code || error?.name || 'network-error'
      });
    }
    try {
      if (response.redirected
        || (response.status >= 300 && response.status < 400)
        || (response.url && new URL(response.url).origin !== target.origin)) {
        fail('UNSAFE_REDIRECT', 'Community server returned an unsafe redirect.', {
          status: response.status
        });
      }
      const buffer = await readResponseBuffer(response, this.maximumJsonBytes);
      let payload = null;
      if (buffer.length > 0) {
        const contentType = response.headers?.get?.('content-type') || '';
        if (contentType && !/(?:application\/json|\+json)(?:;|$)/i.test(contentType)) {
          fail('INVALID_RESPONSE', 'Community server returned an unexpected response type.', {
            status: response.status
          });
        }
        try {
          payload = JSON.parse(buffer.toString('utf8'));
        } catch (_error) {
          fail('INVALID_RESPONSE', 'Community server returned invalid JSON.', {
            status: response.status
          });
        }
      } else if (!allowEmpty && expectedStatuses.includes(response.status)) {
        fail('INVALID_RESPONSE', 'Community server returned an empty response.', {
          status: response.status
        });
      }
      if (!expectedStatuses.includes(response.status)) {
        const statusMap = {
          400: ['BAD_REQUEST', 'Community server rejected the request.', false],
          401: ['AUTH_REQUIRED', 'Community authorization is required.', false],
          403: ['PERMISSION_DENIED', 'This Community account does not have permission.', false],
          404: ['NOT_FOUND', 'The Community resource was not found.', false],
          409: ['REVISION_CONFLICT', 'The Community song changed before this update.', false],
          410: ['AUTHORIZATION_EXPIRED', 'Community authorization expired.', false],
          412: ['REVISION_CONFLICT', 'The Community song changed before this update.', false],
          429: ['RATE_LIMITED', 'Community server is temporarily busy.', true]
        };
        const mapped = statusMap[response.status]
          || (response.status >= 500
            ? ['SERVER_UNAVAILABLE', 'Community server is temporarily unavailable.', true]
            : ['REQUEST_FAILED', 'Community server could not complete the request.', false]);
        fail(mapped[0], mapped[1], {
          status: response.status,
          retryable: mapped[2]
        });
      }
      return { payload, response };
    } finally {
      timeout.dispose();
    }
  }

  async discover({ signal = null, force = false } = {}) {
    if (this.discovery && !force) return this.discovery;
    const discoveryUrl = new URL(DISCOVERY_PATH, this.baseUrl);
    const { payload } = await this._request(discoveryUrl, { signal });
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      fail('INVALID_DISCOVERY', 'This is not a compatible Heritage Community server.');
    }
    const integration = payload.integrations?.syncShow;
    const legacyCapability = payload.capabilities?.syncShowSongLibrary === true;
    if ((!integration || typeof integration !== 'object' || Array.isArray(integration))
      && !legacyCapability) {
      fail('SYNC_UNSUPPORTED', 'This Heritage Community server does not support SyncShow.');
    }
    const configured = integration || {};
    if (configured.schemaVersion !== undefined && configured.schemaVersion !== 1) {
      fail('SYNC_UNSUPPORTED', 'This Community server uses an unsupported SyncShow protocol.');
    }
    if (configured.deviceAuthorization === false || configured.songLibrary === false) {
      fail('SYNC_UNSUPPORTED', 'This Community server has not enabled SyncShow song synchronization.');
    }
    const apiBase = pinnedUrl(configured.apiBaseUrl, {
      origin: this.baseUrl.origin,
      apiPath: DEFAULT_API_PATH,
      label: 'Community API URL',
      fallback: DEFAULT_API_PATH
    });
    const apiPath = new URL(apiBase).pathname.replace(/\/+$/, '');
    const endpoints = configured.endpoints || {};
    const normalized = Object.freeze({
      schemaVersion: 1,
      serverId: boundedText(payload.server?.id || payload.id, 'Community server ID', 128, {
        required: true,
        pattern: /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
      }),
      serverName: boundedText(
        payload.server?.name || payload.name,
        'Community server name',
        160,
        { fallback: 'Heritage Community' }
      ),
      baseUrl: this.baseUrl.toString(),
      apiBaseUrl: apiBase.replace(/\/+$/, ''),
      scopes: Object.freeze(normalizeScopes(configured.scopes || [...KNOWN_SCOPES])),
      endpoints: Object.freeze({
        deviceStart: pinnedUrl(endpoints.deviceStart, {
          origin: this.baseUrl.origin,
          apiPath,
          label: 'Device authorization start endpoint',
          fallback: 'auth/device/start'
        }),
        deviceStatus: pinnedUrl(endpoints.deviceStatus, {
          origin: this.baseUrl.origin,
          apiPath,
          label: 'Device authorization status endpoint',
          fallback: 'auth/device/status'
        }),
        deviceToken: pinnedUrl(endpoints.deviceToken, {
          origin: this.baseUrl.origin,
          apiPath,
          label: 'Device token endpoint',
          fallback: 'auth/device/token'
        }),
        deviceCancel: pinnedUrl(endpoints.deviceCancel, {
          origin: this.baseUrl.origin,
          apiPath,
          label: 'Device authorization cancel endpoint',
          fallback: 'auth/device/cancel'
        }),
        revoke: pinnedUrl(endpoints.revoke, {
          origin: this.baseUrl.origin,
          apiPath,
          label: 'Token revocation endpoint',
          fallback: 'auth/revoke'
        }),
        songs: pinnedUrl(endpoints.songs, {
          origin: this.baseUrl.origin,
          apiPath,
          label: 'Song library endpoint',
          fallback: 'songs'
        })
      })
    });
    this.discovery = normalized;
    return normalized;
  }

  _authorizationId() {
    const id = String(this.randomUUID());
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{7,99}$/.test(id)) {
      throw new TypeError('Community authorization ID generator returned an invalid value');
    }
    return id;
  }

  async startDeviceAuthorization({
    email,
    deviceName,
    scopes = ['syncshow:songs:read'],
    signal = null
  } = {}) {
    const discovery = await this.discover({ signal });
    const requestedScopes = normalizeScopes(scopes);
    if (requestedScopes.some(scope => !discovery.scopes.includes(scope))) {
      fail('SCOPE_UNAVAILABLE', 'This Community server did not offer the requested access.');
    }
    const normalizedEmail = boundedText(email, 'Administrator email', 320, {
      required: true,
      pattern: /^[^\s@]{1,128}@[^\s@]{1,190}$/
    });
    const normalizedDeviceName = boundedText(deviceName, 'Device name', 120, {
      required: true
    });
    if (this.authorizationFlows.size >= 8) {
      fail('TOO_MANY_AUTHORIZATIONS', 'Finish or cancel the current Community connection first.');
    }
    const verifierBuffer = this.randomBytes(32);
    if (!Buffer.isBuffer(verifierBuffer) || verifierBuffer.length < 32) {
      throw new TypeError('Community PKCE random generator returned too little data');
    }
    const codeVerifier = verifierBuffer.toString('base64url');
    const codeChallenge = crypto.createHash('sha256').update(codeVerifier).digest('base64url');
    const { payload } = await this._request(discovery.endpoints.deviceStart, {
      method: 'POST',
      body: {
        email: normalizedEmail,
        deviceName: normalizedDeviceName,
        scopes: requestedScopes,
        codeChallenge,
        codeChallengeMethod: 'S256'
      },
      expectedStatuses: [200, 201],
      signal
    });
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      fail('INVALID_RESPONSE', 'Community returned invalid device authorization details.');
    }
    const authorizationId = this._authorizationId();
    const deviceId = boundedText(payload.deviceId, 'Device authorization ID', 256, {
      required: true
    });
    const deviceSecret = boundedText(payload.deviceSecret, 'Device authorization secret', 16384, {
      required: true,
      pattern: TOKEN_PATTERN
    });
    const userCode = boundedText(payload.userCode, 'Device authorization code', 32, {
      required: true,
      pattern: /^[A-Z0-9][A-Z0-9-]{3,31}$/i
    });
    const verificationUri = pinnedUrl(payload.verificationUri, {
      origin: this.baseUrl.origin,
      apiPath: '/',
      label: 'Device verification URL',
      fallback: '/'
    });
    const expiresAt = normalizeTimestamp(payload.expiresAt, 'Device authorization expiration', {
      required: true
    });
    const pollIntervalMs = validateLimit(
      payload.pollIntervalMs,
      3000,
      1000,
      30000,
      'pollIntervalMs'
    );
    this.authorizationFlows.set(authorizationId, {
      authorizationId,
      deviceId,
      deviceSecret,
      codeVerifier,
      scopes: requestedScopes,
      expiresAt,
      pollIntervalMs,
      nextPollAt: 0
    });
    return Object.freeze({
      authorizationId,
      userCode,
      verificationUri,
      expiresAt,
      pollIntervalMs
    });
  }

  _flow(authorizationId) {
    const id = boundedText(authorizationId, 'Authorization ID', 100, {
      required: true,
      pattern: /^[A-Za-z0-9][A-Za-z0-9_-]{7,99}$/
    });
    const flow = this.authorizationFlows.get(id);
    if (!flow) fail('AUTHORIZATION_NOT_FOUND', 'Community authorization was not found.');
    // Ask the server once during its short deterministic token-recovery
    // window. A token exchange may have committed just before the displayed
    // approval expiry even if that HTTP response never reached SyncShow.
    if (Date.parse(flow.expiresAt) + AUTHORIZATION_RECOVERY_GRACE_MS
      <= new Date(this.now()).getTime()) {
      this.authorizationFlows.delete(id);
      fail('AUTHORIZATION_EXPIRED', 'Community authorization expired.');
    }
    return flow;
  }

  async pollDeviceAuthorization(authorizationId, { signal = null } = {}) {
    const flow = this._flow(authorizationId);
    const now = new Date(this.now()).getTime();
    if (now < flow.nextPollAt) {
      return Object.freeze({
        status: 'pending',
        retryAfterMs: Math.max(1, flow.nextPollAt - now)
      });
    }
    flow.nextPollAt = now + flow.pollIntervalMs;
    const discovery = await this.discover({ signal });
    const { payload } = await this._request(discovery.endpoints.deviceStatus, {
      method: 'POST',
      body: {
        deviceId: flow.deviceId,
        deviceSecret: flow.deviceSecret
      },
      expectedStatuses: [200, 202],
      signal
    });
    const status = payload?.status;
    if (status === 'pending') {
      const retryAfterMs = validateLimit(
        payload.retryAfterMs,
        flow.pollIntervalMs,
        1000,
        30000,
        'retryAfterMs'
      );
      flow.nextPollAt = now + retryAfterMs;
      return Object.freeze({ status: 'pending', retryAfterMs });
    }
    if (status === 'denied' || status === 'expired' || status === 'cancelled') {
      this.authorizationFlows.delete(flow.authorizationId);
      const codes = {
        denied: ['AUTHORIZATION_DENIED', 'Community authorization was denied.'],
        expired: ['AUTHORIZATION_EXPIRED', 'Community authorization expired.'],
        cancelled: ['AUTHORIZATION_CANCELLED', 'Community authorization was cancelled.']
      };
      fail(codes[status][0], codes[status][1]);
    }
    // A server may have committed the deterministic token exchange even when
    // the first response was lost. "consumed" tells this same device-secret +
    // PKCE holder to retry that idempotent exchange instead of abandoning it.
    if (status !== 'approved' && status !== 'consumed') {
      fail('INVALID_RESPONSE', 'Community returned an invalid authorization status.');
    }
    const tokenResult = await this._request(discovery.endpoints.deviceToken, {
      method: 'POST',
      body: {
        deviceId: flow.deviceId,
        deviceSecret: flow.deviceSecret,
        codeVerifier: flow.codeVerifier
      },
      expectedStatuses: [200, 201],
      signal
    });
    this.authorizationFlows.delete(flow.authorizationId);
    const token = tokenResult.payload;
    if (!token || typeof token !== 'object' || Array.isArray(token)) {
      fail('INVALID_RESPONSE', 'Community returned invalid credentials.');
    }
    const grantedScopes = normalizeScopes(token.scopes);
    if (grantedScopes.some(scope => !flow.scopes.includes(scope))) {
      fail('INVALID_RESPONSE', 'Community granted an unexpected access scope.');
    }
    const account = token.account;
    if (!account || typeof account !== 'object' || Array.isArray(account)) {
      fail('INVALID_RESPONSE', 'Community returned an invalid account.');
    }
    return Object.freeze({
      status: 'authorized',
      grant: Object.freeze({
        accessToken: boundedText(token.accessToken, 'Community access token', 16384, {
          required: true,
          pattern: TOKEN_PATTERN
        }),
        refreshToken: boundedText(token.refreshToken, 'Community refresh token', 16384),
        expiresAt: normalizeTimestamp(token.expiresAt, 'Access expiration time', {
          required: true
        }),
        scopes: Object.freeze(grantedScopes),
        account: Object.freeze({
          id: boundedText(account.id, 'Account ID', 256, { required: true }),
          email: boundedText(account.email, 'Account email', 320, {
            required: true,
            pattern: /^[^\s@]{1,128}@[^\s@]{1,190}$/
          }),
          name: boundedText(account.name, 'Account name', 160)
        })
      })
    });
  }

  async cancelDeviceAuthorization(authorizationId, { signal = null } = {}) {
    const flow = this._flow(authorizationId);
    this.authorizationFlows.delete(flow.authorizationId);
    const discovery = await this.discover({ signal });
    try {
      await this._request(discovery.endpoints.deviceCancel, {
        method: 'POST',
        body: {
          deviceId: flow.deviceId,
          deviceSecret: flow.deviceSecret
        },
        expectedStatuses: [200, 204, 404, 410],
        allowEmpty: true,
        signal
      });
    } catch (error) {
      if (!(error instanceof CommunityClientError) || !error.retryable) throw error;
      return Object.freeze({ cancelled: true, remoteCancelled: false });
    }
    return Object.freeze({ cancelled: true, remoteCancelled: true });
  }

  async revokeAccessToken({ accessToken, signal = null } = {}) {
    const discovery = await this.discover({ signal });
    try {
      await this._request(discovery.endpoints.revoke, {
        method: 'POST',
        accessToken,
        expectedStatuses: [200, 204, 401],
        allowEmpty: true,
        signal
      });
      return Object.freeze({ revoked: true });
    } catch (error) {
      if (error instanceof CommunityClientError && error.retryable) {
        return Object.freeze({ revoked: false, warningCode: 'REMOTE_REVOCATION_FAILED' });
      }
      throw error;
    }
  }

  async listSongChanges({
    cursor = null,
    limit = 100,
    accessToken,
    signal = null
  } = {}) {
    const discovery = await this.discover({ signal });
    const normalizedCursor = cursor !== null && cursor !== undefined
      ? boundedText(cursor, 'Sync cursor', 2048, { required: true })
      : null;
    let pageLimit = validateLimit(limit, 100, 1, 100, 'limit');
    while (pageLimit >= 1) {
      const url = new URL(discovery.endpoints.songs);
      if (normalizedCursor !== null) url.searchParams.set('cursor', normalizedCursor);
      url.searchParams.set('limit', String(pageLimit));
      let payload;
      try {
        ({ payload } = await this._request(url, { accessToken, signal }));
      } catch (error) {
        if (error instanceof CommunityClientError
          && error.code === 'RESPONSE_TOO_LARGE'
          && pageLimit > 1) {
          pageLimit = Math.max(1, Math.floor(pageLimit / 2));
          continue;
        }
        throw error;
      }
      const items = payload?.items || payload?.songs;
      if (!Array.isArray(items) || items.length > pageLimit) {
        fail('INVALID_RESPONSE', 'Community returned an invalid song change page.');
      }
      return Object.freeze({
        items: Object.freeze(items.map(normalizeRemoteSong)),
        nextCursor: boundedText(payload.nextCursor, 'Next sync cursor', 2048),
        hasMore: payload.hasMore === true
      });
    }
    fail('RESPONSE_TOO_LARGE', 'A Community song is too large to synchronize safely.');
  }

  async getSong({ syncId, accessToken, signal = null } = {}) {
    const discovery = await this.discover({ signal });
    const id = boundedText(syncId, 'Song sync ID', 128, {
      required: true,
      pattern: SYNC_ID_PATTERN
    });
    const url = `${discovery.endpoints.songs.replace(/\/+$/, '')}/${encodeURIComponent(id)}`;
    const { payload } = await this._request(url, { accessToken, signal });
    return normalizeRemoteSong(payload?.song || payload);
  }

  async createSong({
    syncId,
    syncDocuments,
    visibility = 'private',
    publishAt = null,
    accessToken,
    idempotencyKey = null,
    signal = null
  } = {}) {
    const discovery = await this.discover({ signal });
    const id = boundedText(syncId, 'Song sync ID', 128, {
      required: true,
      pattern: SYNC_ID_PATTERN
    });
    const documents = normalizeSyncDocuments(syncDocuments);
    if (documents.length < 1) fail('INVALID_INPUT', 'A new community song requires at least one document.');
    const normalizedVisibility = normalizeVisibility(visibility, publishAt);
    const requestHeaders = {};
    if (idempotencyKey) {
      requestHeaders['Idempotency-Key'] = boundedText(
        idempotencyKey,
        'Idempotency key',
        128,
        { required: true, pattern: /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/ }
      );
    }
    const { payload } = await this._request(discovery.endpoints.songs, {
      method: 'POST',
      accessToken,
      headers: requestHeaders,
      body: {
        syncId: id,
        syncDocuments: documents,
        ...normalizedVisibility
      },
      expectedStatuses: [200, 201],
      signal
    });
    return normalizeRemoteSong(payload?.song || payload);
  }

  async updateSong({
    syncId,
    syncDocuments,
    visibility,
    publishAt,
    expectedSyncVersion,
    accessToken,
    signal = null
  } = {}) {
    const discovery = await this.discover({ signal });
    const id = boundedText(syncId, 'Song sync ID', 128, {
      required: true,
      pattern: SYNC_ID_PATTERN
    });
    if (!Number.isSafeInteger(expectedSyncVersion) || expectedSyncVersion < 1) {
      fail('INVALID_INPUT', 'Expected song sync version is invalid.');
    }
    const body = {};
    if (syncDocuments !== undefined) {
      const documents = normalizeSyncDocuments(syncDocuments);
      if (documents.length < 1) fail('INVALID_INPUT', 'A song update cannot erase all synced documents.');
      body.syncDocuments = documents;
    }
    if (visibility !== undefined || publishAt !== undefined) {
      Object.assign(body, normalizeVisibility(visibility, publishAt));
    }
    if (Object.keys(body).length === 0) fail('INVALID_INPUT', 'Song update has no changes.');
    const url = `${discovery.endpoints.songs.replace(/\/+$/, '')}/${encodeURIComponent(id)}`;
    const { payload } = await this._request(url, {
      method: 'PUT',
      accessToken,
      headers: { 'If-Match': `"song:${id}:${expectedSyncVersion}"` },
      body,
      signal
    });
    return normalizeRemoteSong(payload?.song || payload);
  }

  async archiveSong({
    syncId,
    expectedSyncVersion,
    accessToken,
    signal = null
  } = {}) {
    const discovery = await this.discover({ signal });
    const id = boundedText(syncId, 'Song sync ID', 128, {
      required: true,
      pattern: SYNC_ID_PATTERN
    });
    if (!Number.isSafeInteger(expectedSyncVersion) || expectedSyncVersion < 1) {
      fail('INVALID_INPUT', 'Expected song sync version is invalid.');
    }
    const url = `${discovery.endpoints.songs.replace(/\/+$/, '')}/${encodeURIComponent(id)}`;
    const { payload } = await this._request(url, {
      method: 'DELETE',
      accessToken,
      headers: { 'If-Match': `"song:${id}:${expectedSyncVersion}"` },
      expectedStatuses: [200, 202],
      signal
    });
    return normalizeRemoteSong(payload?.song || payload);
  }
}

module.exports = {
  CommunityClient,
  CommunityClientError,
  DEFAULT_API_PATH,
  DISCOVERY_PATH,
  KNOWN_SCOPES,
  MAX_DOCUMENTS,
  MAX_DOCUMENT_BYTES,
  MAX_DOCUMENT_TOTAL_BYTES,
  VISIBILITIES,
  normalizeBaseUrl,
  normalizeRemoteSong,
  normalizeSyncDocuments
};
