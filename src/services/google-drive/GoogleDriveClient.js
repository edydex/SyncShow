'use strict';

const path = require('path');

const DRIVE_API_ORIGIN = 'https://www.googleapis.com';
const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const DRIVE_FOLDER_MIME_TYPE = 'application/vnd.google-apps.folder';
const GOOGLE_SLIDES_MIME_TYPE = 'application/vnd.google-apps.presentation';
const POWERPOINT_MIME_TYPE = 'application/vnd.openxmlformats-officedocument.presentationml.presentation';
const LEGACY_POWERPOINT_MIME_TYPE = 'application/vnd.ms-powerpoint';
const DRIVE_ID_PATTERN = /^[A-Za-z0-9_-]{10,200}$/;
const PAGE_TOKEN_PATTERN = /^[A-Za-z0-9._~+\/=-]{1,2048}$/;
const DEFAULT_JSON_LIMIT = 2 * 1024 * 1024;
const DEFAULT_DOWNLOAD_LIMIT = 256 * 1024 * 1024;
const MAX_LIST_DEPTH = 8;
const MAX_LIST_FILES = 10000;
const MAX_LIST_PAGES = 200;

class GoogleDriveError extends Error {
  constructor(code, message, {
    status = null,
    retryable = false,
    details = null
  } = {}) {
    super(message);
    this.name = 'GoogleDriveError';
    this.code = code;
    this.status = status;
    this.retryable = retryable;
    this.details = details;
  }
}

function requireString(value, label, maximumLength = 4096) {
  if (typeof value !== 'string' || !value || value.length > maximumLength) {
    throw new TypeError(`${label} is invalid`);
  }
  return value;
}

function optionalOAuthClientSecret(value) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || !/^[\x21-\x7e]{8,1024}$/.test(value)) {
    throw new TypeError('Google OAuth client secret is invalid');
  }
  return value;
}

function requireDriveId(value, label = 'Google Drive file ID') {
  if (typeof value !== 'string' || !DRIVE_ID_PATTERN.test(value)) {
    throw new GoogleDriveError('INVALID_FILE_ID', `${label} is not valid.`);
  }
  return value;
}

function normalizeResourceKey(value) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,200}$/.test(value)) {
    throw new GoogleDriveError('INVALID_RESOURCE_KEY', 'Google Drive resource key is not valid.');
  }
  return value;
}

function resourceKeyHeader(entries) {
  const unique = new Map();
  for (const entry of entries || []) {
    if (!entry?.fileId || !entry?.resourceKey) continue;
    const fileId = requireDriveId(entry.fileId);
    const resourceKey = normalizeResourceKey(entry.resourceKey);
    unique.set(fileId, `${fileId}/${resourceKey}`);
  }
  return [...unique.values()].join(',');
}

function safeDrivePathSegment(value, fallback = 'untitled') {
  const normalized = String(value || '')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/[\/\\]/g, ' ')
    .trim()
    .slice(0, 240);
  return !normalized || normalized === '.' || normalized === '..' ? fallback : normalized;
}

function responseContentLength(response) {
  const raw = response?.headers?.get?.('content-length');
  if (!raw || !/^[0-9]{1,20}$/.test(raw)) return null;
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

async function readResponseBuffer(response, maximumBytes) {
  const advertised = responseContentLength(response);
  if (advertised !== null && advertised > maximumBytes) {
    throw new GoogleDriveError(
      'RESPONSE_TOO_LARGE',
      `Google Drive returned more than ${maximumBytes} bytes.`
    );
  }
  const chunks = [];
  let size = 0;
  const append = chunk => {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > maximumBytes) {
      throw new GoogleDriveError(
        'RESPONSE_TOO_LARGE',
        `Google Drive returned more than ${maximumBytes} bytes.`
      );
    }
    chunks.push(buffer);
  };

  if (response.body?.getReader) {
    const reader = response.body.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        append(value);
      }
    } finally {
      reader.releaseLock?.();
    }
  } else if (response.body && typeof response.body[Symbol.asyncIterator] === 'function') {
    for await (const chunk of response.body) append(chunk);
  } else {
    append(await response.arrayBuffer());
  }
  return Buffer.concat(chunks, size);
}

function safeApiErrorDetails(value) {
  const reason = value?.error?.errors?.[0]?.reason;
  const status = value?.error?.status;
  return {
    reason: typeof reason === 'string' ? reason.slice(0, 100) : null,
    status: typeof status === 'string' ? status.slice(0, 100) : null
  };
}

function isRetryableStatus(status) {
  return status === 408 || status === 429 || status >= 500;
}

function isDriveRateLimit(status, details) {
  return status === 429
    || (status === 403
      && ['rateLimitExceeded', 'userRateLimitExceeded'].includes(details?.reason));
}

function validateLimit(value, fallback, minimum, maximum, label) {
  if (value === undefined || value === null) return fallback;
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new TypeError(`${label} must be between ${minimum} and ${maximum}`);
  }
  return value;
}

function normalizeFile(file) {
  if (!file || typeof file !== 'object') {
    throw new GoogleDriveError('INVALID_RESPONSE', 'Google Drive returned invalid file metadata.');
  }
  const id = requireDriveId(file.id);
  const name = safeDrivePathSegment(file.name);
  const mimeType = typeof file.mimeType === 'string' ? file.mimeType.slice(0, 255) : '';
  if (!mimeType) {
    throw new GoogleDriveError('INVALID_RESPONSE', 'Google Drive returned a file without a type.');
  }
  const size = file.size === undefined ? null : Number(file.size);
  if (size !== null && (!Number.isSafeInteger(size) || size < 0)) {
    throw new GoogleDriveError('INVALID_RESPONSE', 'Google Drive returned an invalid file size.');
  }
  const version = file.version === undefined || file.version === null
    ? null
    : String(file.version);
  if (version !== null && !/^[0-9]{1,40}$/.test(version)) {
    throw new GoogleDriveError('INVALID_RESPONSE', 'Google Drive returned an invalid file version.');
  }
  const capabilities = file.capabilities && typeof file.capabilities === 'object'
    ? {
      canListChildren: file.capabilities.canListChildren === true,
      canAddChildren: file.capabilities.canAddChildren === true,
      canDownload: file.capabilities.canDownload === true,
      canEdit: file.capabilities.canEdit === true,
      canModifyContent: file.capabilities.canModifyContent === true
    }
    : {
      canListChildren: false,
      canAddChildren: false,
      canDownload: false,
      canEdit: false,
      canModifyContent: false
    };
  return Object.freeze({
    id,
    name,
    mimeType,
    size,
    version,
    modifiedTime: typeof file.modifiedTime === 'string' ? file.modifiedTime : null,
    md5Checksum: typeof file.md5Checksum === 'string' ? file.md5Checksum : null,
    resourceKey: normalizeResourceKey(file.resourceKey),
    driveId: typeof file.driveId === 'string' && DRIVE_ID_PATTERN.test(file.driveId)
      ? file.driveId
      : null,
    parents: Array.isArray(file.parents)
      ? file.parents.filter(parent => typeof parent === 'string' && DRIVE_ID_PATTERN.test(parent))
      : [],
    capabilities
  });
}

async function parseJsonResponse(response, maximumBytes) {
  const body = await readResponseBuffer(response, maximumBytes);
  if (body.length === 0) return {};
  try {
    return JSON.parse(body.toString('utf8'));
  } catch (_error) {
    throw new GoogleDriveError('INVALID_RESPONSE', 'Google Drive returned an invalid response.');
  }
}

function timeoutSignal(timeoutMs, callerSignal) {
  const controller = new AbortController();
  let callerAbort = null;
  const timer = setTimeout(() => controller.abort(new Error('request timeout')), timeoutMs);
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
    dispose() {
      clearTimeout(timer);
      if (callerAbort) callerSignal.removeEventListener('abort', callerAbort);
    }
  };
}

async function performFetch(fetchImpl, url, options, timeoutMs, signal) {
  const timeout = timeoutSignal(timeoutMs, signal);
  try {
    return await fetchImpl(url, { ...options, signal: timeout.signal });
  } catch (error) {
    if (timeout.signal.aborted) {
      throw new GoogleDriveError('REQUEST_TIMEOUT', 'Google Drive did not respond in time.', {
        retryable: true
      });
    }
    throw new GoogleDriveError('NETWORK_ERROR', 'SyncShow could not reach Google Drive.', {
      retryable: true,
      details: { cause: error?.code || error?.name || 'network-error' }
    });
  } finally {
    timeout.dispose();
  }
}

class GoogleDriveClient {
  constructor({
    fetchImpl = globalThis.fetch,
    apiKey = null,
    accessToken = null,
    baseUrl = DRIVE_API_ORIGIN,
    timeoutMs = 15000,
    maximumJsonBytes = DEFAULT_JSON_LIMIT,
    maximumDownloadBytes = DEFAULT_DOWNLOAD_LIMIT
  } = {}) {
    if (typeof fetchImpl !== 'function') throw new TypeError('Google Drive client requires fetch');
    if (Boolean(apiKey) === Boolean(accessToken)) {
      throw new TypeError('Google Drive client requires exactly one API key or access token');
    }
    this.fetchImpl = fetchImpl;
    this.apiKey = apiKey ? requireString(apiKey, 'Google API key', 256) : null;
    this.accessToken = accessToken ? requireString(accessToken, 'Google access token', 8192) : null;
    this.baseUrl = new URL(baseUrl);
    if (this.baseUrl.protocol !== 'https:' || this.baseUrl.username || this.baseUrl.password) {
      throw new TypeError('Google Drive API base URL must be HTTPS');
    }
    this.timeoutMs = validateLimit(timeoutMs, 15000, 1000, 120000, 'timeoutMs');
    this.maximumJsonBytes = validateLimit(
      maximumJsonBytes,
      DEFAULT_JSON_LIMIT,
      1024,
      16 * 1024 * 1024,
      'maximumJsonBytes'
    );
    this.maximumDownloadBytes = validateLimit(
      maximumDownloadBytes,
      DEFAULT_DOWNLOAD_LIMIT,
      1024,
      2 * 1024 * 1024 * 1024,
      'maximumDownloadBytes'
    );
  }

  setAccessToken(accessToken) {
    if (!this.accessToken) throw new TypeError('Cannot set a bearer token on a public Drive client');
    this.accessToken = requireString(accessToken, 'Google access token', 8192);
  }

  async _request(pathname, {
    query = {},
    headers = {},
    maximumBytes = this.maximumJsonBytes,
    signal = null,
    responseType = 'json'
  } = {}) {
    const url = new URL(pathname, this.baseUrl);
    for (const [name, value] of Object.entries(query)) {
      if (value !== null && value !== undefined) url.searchParams.set(name, String(value));
    }
    if (this.apiKey) url.searchParams.set('key', this.apiKey);
    const requestHeaders = { Accept: responseType === 'json' ? 'application/json' : '*/*', ...headers };
    if (this.accessToken) requestHeaders.Authorization = `Bearer ${this.accessToken}`;

    const response = await performFetch(
      this.fetchImpl,
      url,
      { method: 'GET', headers: requestHeaders, redirect: 'error' },
      this.timeoutMs,
      signal
    );
    if (!response?.ok) {
      let details = null;
      try {
        details = safeApiErrorDetails(await parseJsonResponse(response, Math.min(maximumBytes, 64 * 1024)));
      } catch (_error) {
        details = null;
      }
      const status = Number.isInteger(response?.status) ? response.status : null;
      const rateLimited = isDriveRateLimit(status, details);
      const accessDenied = (status === 401 || status === 403) && !rateLimited;
      throw new GoogleDriveError(
        rateLimited ? 'RATE_LIMITED' : (accessDenied ? 'ACCESS_DENIED' : 'DRIVE_REQUEST_FAILED'),
        rateLimited
          ? 'Google Drive is receiving too many requests. Try again shortly.'
          : accessDenied
          ? 'Google Drive did not allow access to this item.'
          : 'Google Drive could not complete the request.',
        { status, retryable: rateLimited || isRetryableStatus(status), details }
      );
    }
    if (responseType === 'buffer') return readResponseBuffer(response, maximumBytes);
    return parseJsonResponse(response, maximumBytes);
  }

  async getFileMetadata({ fileId, resourceKey = null, signal = null } = {}) {
    const id = requireDriveId(fileId);
    const normalizedKey = normalizeResourceKey(resourceKey);
    const keyHeader = resourceKeyHeader([{ fileId: id, resourceKey: normalizedKey }]);
    const response = await this._request(`/drive/v3/files/${encodeURIComponent(id)}`, {
      query: {
        fields: 'id,name,mimeType,size,version,modifiedTime,md5Checksum,resourceKey,driveId,parents,capabilities(canListChildren,canAddChildren,canDownload,canEdit,canModifyContent)',
        supportsAllDrives: 'true'
      },
      headers: keyHeader ? { 'X-Goog-Drive-Resource-Keys': keyHeader } : {},
      signal
    });
    return normalizeFile(response);
  }

  async _listChildren({
    folderId,
    resourceKey,
    maximumPages,
    remainingItems,
    signal
  }) {
    const results = [];
    const seenPageTokens = new Set();
    let pageToken = null;
    let pagesUsed = 0;
    for (let page = 0; page < maximumPages; page += 1) {
      pagesUsed += 1;
      const keyHeader = resourceKeyHeader([{ fileId: folderId, resourceKey }]);
      const response = await this._request('/drive/v3/files', {
        query: {
          q: `'${folderId}' in parents and trashed = false`,
          fields: 'nextPageToken,files(id,name,mimeType,size,version,modifiedTime,md5Checksum,resourceKey,driveId,parents,capabilities(canListChildren,canAddChildren,canDownload,canEdit,canModifyContent))',
          pageSize: Math.min(1000, remainingItems - results.length),
          pageToken,
          spaces: 'drive',
          orderBy: 'folder,name_natural',
          supportsAllDrives: 'true',
          includeItemsFromAllDrives: 'true'
        },
        headers: keyHeader ? { 'X-Goog-Drive-Resource-Keys': keyHeader } : {},
        signal
      });
      if (!response || !Array.isArray(response.files)) {
        throw new GoogleDriveError('INVALID_RESPONSE', 'Google Drive returned an invalid file list.');
      }
      for (const item of response.files) {
        if (results.length >= remainingItems) {
          throw new GoogleDriveError(
            'LIST_LIMIT_EXCEEDED',
            `This Google Drive folder contains more than ${remainingItems} discoverable items.`
          );
        }
        results.push(normalizeFile(item));
      }
      if (!response.nextPageToken) return { items: results, pagesUsed };
      if (results.length >= remainingItems) {
        throw new GoogleDriveError(
          'LIST_LIMIT_EXCEEDED',
          `This Google Drive folder contains more than ${remainingItems} discoverable items.`
        );
      }
      if (typeof response.nextPageToken !== 'string'
        || !PAGE_TOKEN_PATTERN.test(response.nextPageToken)
        || seenPageTokens.has(response.nextPageToken)) {
        throw new GoogleDriveError('INVALID_RESPONSE', 'Google Drive returned an invalid page token.');
      }
      seenPageTokens.add(response.nextPageToken);
      pageToken = response.nextPageToken;
    }
    throw new GoogleDriveError(
      'PAGE_LIMIT_EXCEEDED',
      `Google Drive listing exceeded its ${maximumPages}-page safety limit.`
    );
  }

  async listFolder({
    folderId,
    resourceKey = null,
    maximumDepth = 2,
    maximumFiles = 5000,
    maximumPages = 100,
    signal = null
  } = {}) {
    const id = requireDriveId(folderId, 'Google Drive folder ID');
    const rootKey = normalizeResourceKey(resourceKey);
    const depthLimit = validateLimit(maximumDepth, 2, 0, MAX_LIST_DEPTH, 'maximumDepth');
    const fileLimit = validateLimit(maximumFiles, 5000, 1, MAX_LIST_FILES, 'maximumFiles');
    const pageLimit = validateLimit(maximumPages, 100, 1, MAX_LIST_PAGES, 'maximumPages');
    const root = await this.getFileMetadata({ fileId: id, resourceKey: rootKey, signal });
    if (root.mimeType !== DRIVE_FOLDER_MIME_TYPE) {
      throw new GoogleDriveError('NOT_A_FOLDER', 'The selected Google Drive item is not a folder.');
    }

    const folders = [];
    const files = [];
    const queue = [{
      folderId: id,
      resourceKey: root.resourceKey || rootKey,
      relativePath: '',
      depth: 0
    }];
    const visitedFolders = new Set([id]);
    const seenItems = new Set();
    let pagesRemaining = pageLimit;

    while (queue.length > 0) {
      const current = queue.shift();
      if (pagesRemaining <= 0) {
        throw new GoogleDriveError(
          'PAGE_LIMIT_EXCEEDED',
          `Google Drive listing exceeded its ${pageLimit}-page safety limit.`
        );
      }
      const remainingItems = fileLimit - seenItems.size;
      if (remainingItems <= 0) {
        throw new GoogleDriveError(
          'LIST_LIMIT_EXCEEDED',
          `This Google Drive folder contains more than ${fileLimit} discoverable items.`
        );
      }
      const childPage = await this._listChildren({
        folderId: current.folderId,
        resourceKey: current.resourceKey,
        maximumPages: pagesRemaining,
        remainingItems,
        signal
      });
      pagesRemaining -= childPage.pagesUsed;

      for (const child of childPage.items) {
        if (seenItems.has(child.id)) continue;
        seenItems.add(child.id);
        const relativePath = current.relativePath
          ? path.posix.join(current.relativePath, child.name)
          : child.name;
        const enriched = Object.freeze({
          ...child,
          relativePath,
          parentId: current.folderId,
          depth: current.depth
        });
        if (child.mimeType !== DRIVE_FOLDER_MIME_TYPE) {
          files.push(enriched);
          continue;
        }
        folders.push(enriched);
        if (current.depth < depthLimit && !visitedFolders.has(child.id)) {
          visitedFolders.add(child.id);
          queue.push({
            folderId: child.id,
            resourceKey: child.resourceKey,
            relativePath,
            depth: current.depth + 1
          });
        }
      }
    }
    return Object.freeze({
      root,
      files: Object.freeze(files),
      folders: Object.freeze(folders),
      maximumDepth: depthLimit
    });
  }

  async downloadFile({
    fileId,
    resourceKey = null,
    maximumBytes = this.maximumDownloadBytes,
    signal = null
  } = {}) {
    const id = requireDriveId(fileId);
    const normalizedKey = normalizeResourceKey(resourceKey);
    const byteLimit = validateLimit(
      maximumBytes,
      this.maximumDownloadBytes,
      1,
      2 * 1024 * 1024 * 1024,
      'maximumBytes'
    );
    const keyHeader = resourceKeyHeader([{ fileId: id, resourceKey: normalizedKey }]);
    return this._request(`/drive/v3/files/${encodeURIComponent(id)}`, {
      query: { alt: 'media', supportsAllDrives: 'true' },
      headers: keyHeader ? { 'X-Goog-Drive-Resource-Keys': keyHeader } : {},
      maximumBytes: byteLimit,
      signal,
      responseType: 'buffer'
    });
  }

  async exportGoogleSlides({
    fileId,
    resourceKey = null,
    maximumBytes = this.maximumDownloadBytes,
    signal = null
  } = {}) {
    const id = requireDriveId(fileId);
    const normalizedKey = normalizeResourceKey(resourceKey);
    const byteLimit = validateLimit(
      maximumBytes,
      this.maximumDownloadBytes,
      1,
      2 * 1024 * 1024 * 1024,
      'maximumBytes'
    );
    const keyHeader = resourceKeyHeader([{ fileId: id, resourceKey: normalizedKey }]);
    return this._request(`/drive/v3/files/${encodeURIComponent(id)}/export`, {
      query: { mimeType: POWERPOINT_MIME_TYPE },
      headers: keyHeader ? { 'X-Goog-Drive-Resource-Keys': keyHeader } : {},
      maximumBytes: byteLimit,
      signal,
      responseType: 'buffer'
    });
  }

  async downloadPresentation(file, options = {}) {
    if (!file || typeof file !== 'object') throw new TypeError('Drive file metadata is required');
    if (file.mimeType === GOOGLE_SLIDES_MIME_TYPE) {
      return this.exportGoogleSlides({
        fileId: file.id,
        resourceKey: file.resourceKey,
        ...options
      });
    }
    if (![POWERPOINT_MIME_TYPE, LEGACY_POWERPOINT_MIME_TYPE].includes(file.mimeType)) {
      throw new GoogleDriveError(
        'UNSUPPORTED_PRESENTATION',
        'This Google Drive item is not a supported slideshow.'
      );
    }
    return this.downloadFile({
      fileId: file.id,
      resourceKey: file.resourceKey,
      ...options
    });
  }
}

async function refreshGoogleAccessToken({
  clientId,
  clientSecret = null,
  refreshToken,
  fetchImpl = globalThis.fetch,
  timeoutMs = 15000,
  signal = null,
  tokenEndpoint = TOKEN_ENDPOINT
} = {}) {
  requireString(clientId, 'Google OAuth client ID', 256);
  const normalizedClientSecret = optionalOAuthClientSecret(clientSecret);
  requireString(refreshToken, 'Google refresh token', 8192);
  if (typeof fetchImpl !== 'function') throw new TypeError('Token refresh requires fetch');
  const endpoint = new URL(tokenEndpoint);
  if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password) {
    throw new TypeError('Google token endpoint must be HTTPS');
  }
  const body = new URLSearchParams({
    client_id: clientId,
    refresh_token: refreshToken,
    grant_type: 'refresh_token'
  });
  if (normalizedClientSecret) body.set('client_secret', normalizedClientSecret);
  const response = await performFetch(fetchImpl, endpoint, {
    method: 'POST',
    redirect: 'error',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body
  }, validateLimit(timeoutMs, 15000, 1000, 120000, 'timeoutMs'), signal);
  const payload = await parseJsonResponse(response, DEFAULT_JSON_LIMIT);
  if (!response.ok) {
    const status = Number.isInteger(response.status) ? response.status : null;
    throw new GoogleDriveError('TOKEN_REFRESH_FAILED', 'Google sign-in needs to be renewed.', {
      status,
      retryable: isRetryableStatus(status),
      details: safeApiErrorDetails(payload)
    });
  }
  if (typeof payload.access_token !== 'string' || payload.access_token.length < 10) {
    throw new GoogleDriveError('INVALID_TOKEN_RESPONSE', 'Google returned an invalid access token.');
  }
  const expiresIn = Number(payload.expires_in);
  if (!Number.isSafeInteger(expiresIn) || expiresIn < 1 || expiresIn > 24 * 60 * 60) {
    throw new GoogleDriveError('INVALID_TOKEN_RESPONSE', 'Google returned an invalid token lifetime.');
  }
  return Object.freeze({
    accessToken: payload.access_token,
    expiresIn,
    tokenType: typeof payload.token_type === 'string' ? payload.token_type : 'Bearer',
    scope: typeof payload.scope === 'string' ? payload.scope : null
  });
}

module.exports = {
  DRIVE_API_ORIGIN,
  DRIVE_FOLDER_MIME_TYPE,
  GOOGLE_SLIDES_MIME_TYPE,
  GoogleDriveClient,
  GoogleDriveError,
  LEGACY_POWERPOINT_MIME_TYPE,
  POWERPOINT_MIME_TYPE,
  TOKEN_ENDPOINT,
  normalizeFile,
  readResponseBuffer,
  refreshGoogleAccessToken,
  resourceKeyHeader,
  safeDrivePathSegment
};
