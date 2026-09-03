'use strict';

const { Readable } = require('stream');

const DEFAULT_TIMEOUT_MS = 30_000;
const MIN_REQUEST_TIMEOUT_MS = 1_000;
const MAX_CONFIGURED_TIMEOUT_MS = 120_000;
const MAX_REQUEST_TIMEOUT_MS = 30 * 60_000;
const DEFAULT_JSON_LIMIT = 256 * 1024;
const TOKEN_PATTERN = /^[^\s\u0000-\u001f\u007f]{16,16384}$/u;

class CommunityBinaryClientError extends Error {
  constructor(code, message, {
    status = null,
    retryable = false,
    cause = null
  } = {}) {
    super(message);
    this.name = 'CommunityBinaryClientError';
    this.code = code;
    this.status = status;
    this.retryable = retryable;
    this.cause = cause;
  }
}

function fail(code, message, options = {}) {
  throw new CommunityBinaryClientError(code, message, options);
}

function boundedInteger(value, fallback, minimum, maximum, label) {
  const normalized = value === undefined ? fallback : value;
  if (!Number.isSafeInteger(normalized)
    || normalized < minimum
    || normalized > maximum) {
    throw new TypeError(`${label} is invalid`);
  }
  return normalized;
}

function normalizeOrigin(value) {
  let url;
  try {
    url = new URL(value);
  } catch (_error) {
    throw new TypeError('Community binary client base URL is invalid');
  }
  const loopback = url.protocol === 'http:'
    && (
      url.hostname === 'localhost'
      || url.hostname === '::1'
      || /^127(?:\.\d{1,3}){3}$/u.test(url.hostname)
    );
  if ((url.protocol !== 'https:' && !loopback)
    || url.username
    || url.password
    || url.search
    || url.hash
    || url.pathname !== '/') {
    throw new TypeError('Community binary client requires a trusted HTTPS origin');
  }
  return url;
}

function normalizeEndpoint(value, origin) {
  let endpoint;
  try {
    endpoint = new URL(value);
  } catch (_error) {
    throw new TypeError('Community binary endpoint is invalid');
  }
  if (endpoint.origin !== origin.origin
    || endpoint.username
    || endpoint.password
    || endpoint.search
    || endpoint.hash
    || !endpoint.pathname.startsWith('/api/community/syncshow/v1/')
    || endpoint.pathname.includes('/../')
    || endpoint.pathname.includes('/./')) {
    throw new TypeError('Community binary endpoint escaped its pinned API origin');
  }
  endpoint.pathname = endpoint.pathname.replace(/\/+$/u, '');
  return endpoint;
}

function normalizeAccessToken(value) {
  if (typeof value !== 'string' || !TOKEN_PATTERN.test(value)) {
    throw new TypeError('Community binary client access token is invalid');
  }
  return value;
}

function timeoutController(
  timeoutMs,
  parentSignal,
  setTimeoutImpl,
  clearTimeoutImpl
) {
  const controller = new AbortController();
  let timeoutTriggered = false;
  const abortFromParent = () => controller.abort(parentSignal?.reason);
  if (parentSignal?.aborted) abortFromParent();
  else parentSignal?.addEventListener?.('abort', abortFromParent, { once: true });
  const timer = setTimeoutImpl(() => {
    timeoutTriggered = true;
    controller.abort();
  }, timeoutMs);
  timer.unref?.();
  return {
    signal: controller.signal,
    timedOut: () => timeoutTriggered,
    dispose() {
      clearTimeoutImpl(timer);
      parentSignal?.removeEventListener?.('abort', abortFromParent);
    }
  };
}

async function boundedResponseBuffer(response, maximumBytes) {
  const contentLength = response.headers?.get?.('content-length');
  if (contentLength !== null && contentLength !== undefined && contentLength !== '') {
    if (!/^(?:0|[1-9]\d*)$/u.test(contentLength)
      || Number(contentLength) > maximumBytes) {
      await response.body?.cancel?.().catch(() => {});
      fail(
        'RESPONSE_TOO_LARGE',
        'Community returned an oversized sermon-media response.',
        { status: response.status }
      );
    }
  }
  if (!response.body) return Buffer.alloc(0);
  if (typeof response.body.getReader !== 'function') {
    await response.body?.cancel?.().catch(() => {});
    fail(
      'INVALID_RESPONSE',
      'Community returned an unreadable sermon-media response.',
      { status: response.status }
    );
  }
  const reader = response.body.getReader();
  const chunks = [];
  let length = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      if (!(next.value instanceof Uint8Array)) {
        await reader.cancel().catch(() => {});
        fail(
          'INVALID_RESPONSE',
          'Community returned unreadable sermon-media response bytes.',
          { status: response.status }
        );
      }
      const bytes = Buffer.from(
        next.value.buffer,
        next.value.byteOffset,
        next.value.byteLength
      );
      const retainedLength = Math.min(
        bytes.length,
        (maximumBytes + 1) - length
      );
      if (retainedLength > 0) {
        chunks.push(Buffer.from(bytes.subarray(0, retainedLength)));
        length += retainedLength;
      }
      if (length > maximumBytes || retainedLength < bytes.length) {
        await reader.cancel().catch(() => {});
        fail(
          'RESPONSE_TOO_LARGE',
          'Community returned an oversized sermon-media response.',
          { status: response.status }
        );
      }
    }
  } finally {
    reader.releaseLock?.();
  }
  return Buffer.concat(chunks, length);
}

function parseJsonResponse(buffer, response, {
  allowEmpty = false
} = {}) {
  if (buffer.length === 0) {
    if (allowEmpty) return null;
    fail(
      'INVALID_RESPONSE',
      'Community returned an empty sermon-media response.',
      { status: response.status }
    );
  }
  const contentType = response.headers?.get?.('content-type') || '';
  if (!/(?:application\/json|\+json)(?:;|$)/iu.test(contentType)) {
    fail(
      'INVALID_RESPONSE',
      'Community returned an unexpected sermon-media response type.',
      { status: response.status }
    );
  }
  const source = buffer.toString('utf8');
  if (!Buffer.from(source, 'utf8').equals(buffer)) {
    fail(
      'INVALID_RESPONSE',
      'Community returned invalid UTF-8 sermon-media data.',
      { status: response.status }
    );
  }
  try {
    return JSON.parse(source);
  } catch (_error) {
    fail(
      'INVALID_RESPONSE',
      'Community returned invalid sermon-media JSON.',
      { status: response.status }
    );
  }
}

function parseOptionalServerError(buffer, response) {
  if (buffer.length === 0) return null;
  const contentType = response.headers?.get?.('content-type') || '';
  if (!/(?:application\/json|\+json)(?:;|$)/iu.test(contentType)) return null;
  const source = buffer.toString('utf8');
  if (!Buffer.from(source, 'utf8').equals(buffer)) return null;
  try {
    return JSON.parse(source);
  } catch (_error) {
    return null;
  }
}

function serverError(payload, status) {
  const error = payload?.error;
  const valid = payload
    && typeof payload === 'object'
    && !Array.isArray(payload)
    && Object.keys(payload).length === 2
    && payload.schemaVersion === 1
    && error
    && typeof error === 'object'
    && !Array.isArray(error)
    && Object.keys(error).sort().join('\n') === 'code\nmessage\nretryable'
    && typeof error.code === 'string'
    && /^[A-Z][A-Z0-9_]{2,79}$/u.test(error.code)
    && typeof error.message === 'string'
    && error.message.trim() === error.message
    && error.message.length >= 1
    && error.message.length <= 500
    && typeof error.retryable === 'boolean';
  if (valid) {
    return new CommunityBinaryClientError(error.code, error.message, {
      status,
      retryable: error.retryable
    });
  }
  const fallback = status === 401
    ? ['AUTH_REQUIRED', 'Community authorization is required.', false]
    : status === 403
      ? ['PERMISSION_DENIED', 'This Community approval cannot upload sermon recordings.', false]
      : status === 404
        ? ['UPLOAD_NOT_FOUND', 'The private sermon-recording upload was not found.', false]
        : status === 410
          ? ['UPLOAD_EXPIRED', 'The private sermon-recording upload expired.', false]
          : status === 412
            ? ['STALE_SERMON_BINDING', 'The sermon or recording changed before upload finished.', false]
            : status === 429
              ? ['RATE_LIMITED', 'Community is temporarily busy.', true]
              : status >= 500
                ? ['SERVER_UNAVAILABLE', 'Community is temporarily unavailable.', true]
                : ['REQUEST_FAILED', 'Community rejected the sermon-recording upload.', false];
  return new CommunityBinaryClientError(fallback[0], fallback[1], {
    status,
    retryable: fallback[2]
  });
}

function normalizeHeaders(headers) {
  if (!headers || typeof headers !== 'object' || Array.isArray(headers)) {
    throw new TypeError('Community binary headers are invalid');
  }
  const normalized = {};
  for (const [name, value] of Object.entries(headers)) {
    if (!/^[A-Za-z0-9-]{1,64}$/u.test(name)
      || ['accept', 'authorization'].includes(name.toLowerCase())
      || typeof value !== 'string'
      || value.length > 2048
      || /[\r\n\u0000]/u.test(value)) {
      throw new TypeError('Community binary headers are invalid');
    }
    normalized[name] = value;
  }
  return normalized;
}

class CommunityBinaryClient {
  constructor({
    baseUrl,
    endpoint,
    accessToken,
    fetchImpl = globalThis.fetch,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    maximumJsonBytes = DEFAULT_JSON_LIMIT,
    setTimeoutImpl = globalThis.setTimeout,
    clearTimeoutImpl = globalThis.clearTimeout
  } = {}) {
    if (typeof fetchImpl !== 'function') {
      throw new TypeError('Community binary client requires fetch');
    }
    if (typeof setTimeoutImpl !== 'function'
      || typeof clearTimeoutImpl !== 'function') {
      throw new TypeError('Community binary client timer is invalid');
    }
    this.baseUrl = normalizeOrigin(baseUrl);
    this.endpoint = normalizeEndpoint(endpoint, this.baseUrl);
    this.accessToken = normalizeAccessToken(accessToken);
    this.fetchImpl = fetchImpl;
    this.timeoutMs = boundedInteger(
      timeoutMs,
      DEFAULT_TIMEOUT_MS,
      MIN_REQUEST_TIMEOUT_MS,
      MAX_CONFIGURED_TIMEOUT_MS,
      'Community binary timeout'
    );
    this.maximumJsonBytes = boundedInteger(
      maximumJsonBytes,
      DEFAULT_JSON_LIMIT,
      1024,
      1024 * 1024,
      'Community binary JSON limit'
    );
    this.setTimeoutImpl = setTimeoutImpl;
    this.clearTimeoutImpl = clearTimeoutImpl;
  }

  _url(pathname = '') {
    if (typeof pathname !== 'string'
      || pathname.length > 1024
      || pathname.includes('?')
      || pathname.includes('#')
      || pathname.includes('\\')
      || pathname.split('/').some(segment => segment === '.' || segment === '..')) {
      throw new TypeError('Community binary request path is invalid');
    }
    const suffix = pathname.replace(/^\/+/u, '');
    const target = new URL(
      `${this.endpoint.pathname}/${suffix}`.replace(/\/+$/u, ''),
      this.baseUrl
    );
    if (target.origin !== this.baseUrl.origin
      || !target.pathname.startsWith(`${this.endpoint.pathname}/`)) {
      throw new TypeError('Community binary request escaped its pinned endpoint');
    }
    return target;
  }

  async requestJson({
    path = '',
    method = 'GET',
    body = null,
    headers = {},
    expectedStatuses = [200],
    signal = null,
    timeoutMs = undefined
  } = {}) {
    let serializedBody = null;
    const requestHeaders = normalizeHeaders(headers);
    if (body !== null && body !== undefined) {
      serializedBody = JSON.stringify(body);
      const sizeBytes = Buffer.byteLength(serializedBody, 'utf8');
      if (sizeBytes > this.maximumJsonBytes) {
        fail('REQUEST_TOO_LARGE', 'The sermon-media request is too large.');
      }
      requestHeaders['Content-Type'] = 'application/json';
      requestHeaders['Content-Length'] = String(sizeBytes);
    }
    return this._request({
      path,
      method,
      body: serializedBody,
      headers: requestHeaders,
      expectedStatuses,
      signal,
      timeoutMs
    });
  }

  async requestBinary({
    path,
    method = 'PUT',
    body,
    contentLength,
    contentRange,
    sha256,
    idempotencyKey,
    expectedStatuses = [200, 201],
    signal = null,
    timeoutMs = undefined
  } = {}) {
    if (!Number.isSafeInteger(contentLength) || contentLength < 1) {
      throw new TypeError('Community binary Content-Length is invalid');
    }
    if (typeof contentRange !== 'string'
      || !/^bytes (?:0|[1-9]\d*)-(?:0|[1-9]\d*)\/(?:[1-9]\d*)$/u.test(contentRange)) {
      throw new TypeError('Community binary Content-Range is invalid');
    }
    if (typeof sha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(sha256)) {
      throw new TypeError('Community binary hash is invalid');
    }
    if (typeof idempotencyKey !== 'string'
      || !/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/u.test(idempotencyKey)) {
      throw new TypeError('Community binary idempotency key is invalid');
    }
    if (!(body instanceof Readable)
      && (!body || typeof body[Symbol.asyncIterator] !== 'function')) {
      throw new TypeError('Community binary request body must be a raw stream');
    }
    return this._request({
      path,
      method,
      body,
      headers: {
        'Content-Type': 'application/octet-stream',
        'Content-Length': String(contentLength),
        'Content-Range': contentRange,
        'X-Content-SHA256': sha256,
        'Idempotency-Key': idempotencyKey
      },
      expectedStatuses,
      signal,
      timeoutMs,
      duplex: 'half'
    });
  }

  async _request({
    path,
    method,
    body,
    headers,
    expectedStatuses,
    signal,
    timeoutMs,
    duplex
  }) {
    const target = this._url(path);
    const requestTimeoutMs = boundedInteger(
      timeoutMs,
      this.timeoutMs,
      MIN_REQUEST_TIMEOUT_MS,
      MAX_REQUEST_TIMEOUT_MS,
      'Community binary request timeout'
    );
    const timeout = timeoutController(
      requestTimeoutMs,
      signal,
      this.setTimeoutImpl,
      this.clearTimeoutImpl
    );
    try {
      const response = await this.fetchImpl(target.toString(), {
        method,
        headers: {
          ...headers,
          Accept: 'application/json',
          Authorization: `SyncShow ${this.accessToken}`
        },
        body,
        redirect: 'manual',
        signal: timeout.signal,
        ...(duplex ? { duplex } : {})
      });
      if (response.redirected
        || (response.status >= 300 && response.status < 400)
        || (response.url && new URL(response.url).origin !== target.origin)) {
        fail(
          'UNSAFE_REDIRECT',
          'Community returned an unsafe sermon-media redirect.',
          { status: response.status }
        );
      }
      const expected = expectedStatuses.includes(response.status);
      let buffer;
      try {
        buffer = await boundedResponseBuffer(response, this.maximumJsonBytes);
      } catch (error) {
        if (!expected
          && error instanceof CommunityBinaryClientError
          && ['INVALID_RESPONSE', 'RESPONSE_TOO_LARGE'].includes(error.code)) {
          throw serverError(null, response.status);
        }
        throw error;
      }
      if (!expected) {
        throw serverError(
          parseOptionalServerError(buffer, response),
          response.status
        );
      }
      const payload = parseJsonResponse(buffer, response);
      return Object.freeze({
        payload,
        status: response.status
      });
    } catch (error) {
      if (error instanceof CommunityBinaryClientError) throw error;
      if (timeout.signal.aborted) {
        if (timeout.timedOut()) {
          fail(
            'REQUEST_TIMEOUT',
            'Community did not respond to the sermon-recording upload in time.',
            { retryable: true }
          );
        }
        fail('REQUEST_CANCELLED', 'The sermon-recording upload request was stopped.');
      }
      fail(
        'NETWORK_ERROR',
        'SyncShow could not reach Community for the sermon-recording upload.',
        {
          retryable: true,
          cause: error?.code || error?.name || 'network-error'
        }
      );
    } finally {
      timeout.dispose();
    }
  }
}

module.exports = {
  CommunityBinaryClient,
  CommunityBinaryClientError,
  DEFAULT_JSON_LIMIT,
  DEFAULT_TIMEOUT_MS,
  MAX_CONFIGURED_TIMEOUT_MS,
  MAX_REQUEST_TIMEOUT_MS,
  MIN_REQUEST_TIMEOUT_MS
};
