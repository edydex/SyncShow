'use strict';

const { EventEmitter } = require('events');
const fs = require('fs');
const http = require('http');
const path = require('path');

const { NetworkBindingCatalog, normalizePeerAddress } = require('./NetworkBindings');
const { SlidingWindowRateLimiter } = require('./RateLimiter');
const { RemoteAuthority } = require('./RemoteAuthority');
const {
  COOKIE_NAME,
  PROTOCOL_VERSION,
  RemoteProtocolError,
  commandFingerprint,
  parseCommandEnvelope,
  parsePairRequest,
  sanitizeCueCatalog,
  sanitizeRemoteState
} = require('./RemoteProtocol');
const { RemoteStateHub } = require('./RemoteStateHub');

const JSON_BODY_LIMIT = 4 * 1024;
const PAIR_BODY_LIMIT = 2 * 1024;
const STATIC_ASSET_LIMIT = 4 * 1024 * 1024;
const REMOTE_STATE_LIMIT = 3 * 1024 * 1024;
const CUE_CATALOG_LIMIT = 2 * 1024 * 1024;
const CUE_CATALOG_PAGE_LIMIT = 200;
const THUMBNAIL_LIMIT = 2 * 1024 * 1024;
const THUMBNAIL_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);
const SAFE_GATEWAY_ERROR_CODES = new Set([
  'AT_FIRST_CUE',
  'AT_LAST_CUE',
  'BIBLE_OVERLAY_ACTIVE',
  'COMMAND_REJECTED',
  'COMMAND_UNAVAILABLE',
  'FORBIDDEN_REMOTE_COMMAND',
  'INVALID_CUE_INDEX',
  'INVALID_REMOTE_COMMAND',
  'NO_ACTIVE_SHOW',
  'OUTPUT_SESSION_REPLACED',
  'SHOW_NOT_CONTROLLABLE',
  'SHOW_STOPPED_LOCALLY',
  'STALE_CURRENT_CUE',
  'STALE_OUTPUT_SESSION',
  'STALE_SHOW_STATE',
  'UNSUPPORTED_REMOTE_PROTOCOL'
]);
const DEFAULT_SECURITY_HEADERS = Object.freeze({
  'Cache-Control': 'no-store',
  'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY'
});

function isValidPort(port) {
  return Number.isSafeInteger(port) && port >= 0 && port <= 65535;
}

function headerOccurrences(request, headerName) {
  const target = headerName.toLowerCase();
  let count = 0;
  for (let index = 0; index < request.rawHeaders.length; index += 2) {
    if (String(request.rawHeaders[index]).toLowerCase() === target) count += 1;
  }
  return count;
}

function normalizedStaticRoutes(routes) {
  const entries = routes instanceof Map ? [...routes.entries()] : Object.entries(routes || {});
  const normalized = new Map();
  for (const [route, rawEntry] of entries) {
    if (typeof route !== 'string'
      || !route.startsWith('/')
      || route.startsWith('/api/')
      || route.includes('?')
      || route.includes('#')
      || route.includes('\\')) {
      throw new TypeError('Remote static routes must be exact non-API paths');
    }
    const entry = Buffer.isBuffer(rawEntry) || typeof rawEntry === 'string'
      ? { body: rawEntry }
      : rawEntry;
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new TypeError(`Remote static route ${route} is invalid`);
    }
    const hasBody = Object.hasOwn(entry, 'body');
    const hasFile = Object.hasOwn(entry, 'filePath');
    if (hasBody === hasFile) {
      throw new TypeError(`Remote static route ${route} needs either body or filePath`);
    }
    if (hasFile && (typeof entry.filePath !== 'string' || !path.isAbsolute(entry.filePath))) {
      throw new TypeError(`Remote static route ${route} filePath must be absolute`);
    }
    if (hasBody && !Buffer.isBuffer(entry.body) && typeof entry.body !== 'string') {
      throw new TypeError(`Remote static route ${route} body is invalid`);
    }
    const contentType = typeof entry.contentType === 'string' && entry.contentType.length <= 100
      && !/[\r\n]/.test(entry.contentType)
      ? entry.contentType
      : route.endsWith('.js')
        ? 'text/javascript; charset=utf-8'
        : route.endsWith('.css')
          ? 'text/css; charset=utf-8'
          : 'text/html; charset=utf-8';
    let body;
    try {
      body = hasBody
        ? Buffer.isBuffer(entry.body) ? Buffer.from(entry.body) : Buffer.from(entry.body, 'utf8')
        : fs.readFileSync(entry.filePath);
    } catch (_error) {
      throw new TypeError(`Remote static route ${route} could not be loaded`);
    }
    if (body.length === 0 || body.length > STATIC_ASSET_LIMIT) {
      throw new TypeError(`Remote static route ${route} has an invalid size`);
    }
    normalized.set(route, Object.freeze({ body, contentType }));
  }
  return normalized;
}

async function readJsonBody(request, limit) {
  const contentEncoding = request.headers['content-encoding'];
  if (contentEncoding && contentEncoding.toLowerCase() !== 'identity') {
    throw new RemoteProtocolError('UNSUPPORTED_ENCODING', 'Compressed request bodies are not accepted', 415);
  }
  const contentType = String(request.headers['content-type'] || '').toLowerCase();
  if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/.test(contentType)) {
    throw new RemoteProtocolError('JSON_REQUIRED', 'Use application/json', 415);
  }
  const declaredLength = Number(request.headers['content-length']);
  if (Number.isFinite(declaredLength) && declaredLength > limit) {
    request.resume();
    throw new RemoteProtocolError('BODY_TOO_LARGE', 'The request body is too large', 413);
  }

  const chunks = [];
  let length = 0;
  for await (const chunk of request) {
    length += chunk.length;
    if (length > limit) {
      request.resume();
      throw new RemoteProtocolError('BODY_TOO_LARGE', 'The request body is too large', 413);
    }
    chunks.push(chunk);
  }
  if (length === 0) throw new RemoteProtocolError('INVALID_JSON', 'A JSON body is required');
  let value;
  try {
    value = JSON.parse(Buffer.concat(chunks, length).toString('utf8'));
  } catch (_error) {
    throw new RemoteProtocolError('INVALID_JSON', 'The request body is not valid JSON');
  }
  return value;
}

function retryAfterSeconds(error) {
  const milliseconds = error?.details?.retryAfterMs;
  return Number.isFinite(milliseconds) && milliseconds > 0
    ? Math.max(1, Math.ceil(milliseconds / 1000))
    : null;
}

function gatewayError(error) {
  if (error instanceof RemoteProtocolError) return error;
  if (error?.name === 'RemoteCommandError'
    && typeof error.code === 'string'
    && SAFE_GATEWAY_ERROR_CODES.has(error.code)) {
    const message = typeof error.message === 'string'
      ? error.message.replace(/[\u0000-\u001f\u007f]/gu, '').slice(0, 240)
      : 'The Show command was rejected';
    return new RemoteProtocolError(error.code, message, 409, error.details || null);
  }
  return new RemoteProtocolError('REMOTE_INTERNAL_ERROR', 'Remote Control could not complete that request', 500);
}

class RemoteControlServer extends EventEmitter {
  constructor({
    showGateway,
    staticRoutes = {},
    authority = new RemoteAuthority(),
    bindingCatalog = new NetworkBindingCatalog(),
    stateHub = new RemoteStateHub(),
    now = Date.now,
    limits = {},
    maxConnections = 32,
    maxCommandQueue = 32
  } = {}) {
    super();
    if (!showGateway
      || typeof showGateway.getState !== 'function'
      || typeof showGateway.execute !== 'function') {
      throw new TypeError('RemoteControlServer requires an injected Show gateway');
    }
    if (!authority || typeof authority.authenticate !== 'function') {
      throw new TypeError('RemoteControlServer requires a RemoteAuthority');
    }
    if (!bindingCatalog || typeof bindingCatalog.list !== 'function') {
      throw new TypeError('RemoteControlServer requires a NetworkBindingCatalog');
    }
    if (!Number.isSafeInteger(maxConnections) || maxConnections < 1 || maxConnections > 256) {
      throw new TypeError('Remote connection limit is invalid');
    }
    if (!Number.isSafeInteger(maxCommandQueue) || maxCommandQueue < 1 || maxCommandQueue > 256) {
      throw new TypeError('Remote command queue limit is invalid');
    }

    this.showGateway = showGateway;
    this.staticRoutes = normalizedStaticRoutes(staticRoutes);
    this.authority = authority;
    this.bindingCatalog = bindingCatalog;
    this.stateHub = stateHub;
    this.now = now;
    this.maxConnections = maxConnections;
    this.maxCommandQueue = maxCommandQueue;

    this.server = null;
    this.sockets = new Set();
    this.binding = null;
    this.origin = null;
    this.expectedHost = null;
    this.mode = 'off';
    this.loopbackInitialized = false;
    this.lifecycleGeneration = 0;
    this.gatewayUnsubscribe = null;
    this.publishScheduled = false;
    this.cueCatalogCache = null;
    this.commandTail = Promise.resolve();
    this.pendingCommands = 0;

    this.requestIpLimiter = new SlidingWindowRateLimiter({
      limit: limits.requestPerIp ?? 360,
      windowMs: limits.requestWindowMs ?? 60 * 1000,
      maxKeys: 512,
      now
    });
    this.requestGlobalLimiter = new SlidingWindowRateLimiter({
      limit: limits.requestGlobal ?? 1200,
      windowMs: limits.requestWindowMs ?? 60 * 1000,
      maxKeys: 1,
      now
    });

    this.pairIpLimiter = new SlidingWindowRateLimiter({
      limit: limits.pairPerIp ?? 5,
      windowMs: limits.pairWindowMs ?? 60 * 1000,
      maxKeys: 512,
      now
    });
    this.pairGlobalLimiter = new SlidingWindowRateLimiter({
      limit: limits.pairGlobal ?? 20,
      windowMs: limits.pairWindowMs ?? 60 * 1000,
      maxKeys: 1,
      now
    });
    this.apiIpLimiter = new SlidingWindowRateLimiter({
      limit: limits.apiPerIp ?? 180,
      windowMs: limits.apiWindowMs ?? 60 * 1000,
      maxKeys: 512,
      now
    });
    this.apiGlobalLimiter = new SlidingWindowRateLimiter({
      limit: limits.apiGlobal ?? 600,
      windowMs: limits.apiWindowMs ?? 60 * 1000,
      maxKeys: 1,
      now
    });
    this.commandDeviceLimiter = new SlidingWindowRateLimiter({
      limit: limits.commandPerDevice ?? 20,
      windowMs: limits.commandWindowMs ?? 1000,
      maxKeys: 128,
      now
    });
    this.commandGlobalLimiter = new SlidingWindowRateLimiter({
      limit: limits.commandGlobal ?? 40,
      windowMs: limits.commandWindowMs ?? 1000,
      maxKeys: 1,
      now
    });

    this.stateHub.on('count-changed', count => {
      this.emit('connected-count-changed', count);
      this._emitStatus();
    });
    this.authority.on('device-paired', device => {
      this.emit('device-paired', device);
      this._emitStatus();
    });
    this.authority.on('revoked-all', event => {
      this.emit('devices-revoked', event);
      this._emitStatus();
    });
  }

  listBindings() {
    return this.bindingCatalog.list();
  }

  getStatus() {
    return Object.freeze({
      mode: this.mode,
      enabled: this.server !== null,
      binding: this.binding ? { ...this.binding } : null,
      origin: this.origin,
      pairedDeviceCount: this.authority.listDevices().length,
      connectedDeviceCount: this.stateHub.connectedDeviceCount
    });
  }

  async startLoopback({ port = 0 } = {}) {
    if (!isValidPort(port)) throw new TypeError('Remote port is invalid');
    if (this.server) {
      throw new RemoteProtocolError('REMOTE_ALREADY_RUNNING', 'Remote Control is already running', 409);
    }
    const binding = this.bindingCatalog.loopback();
    if (!binding) throw new Error('Loopback networking is unavailable');
    await this._listen(binding, port);
    this.loopbackInitialized = true;
    return this.getStatus();
  }

  async bindLan(bindingId, { port = 0 } = {}) {
    if (!this.loopbackInitialized) {
      throw new RemoteProtocolError(
        'LOOPBACK_REQUIRED',
        'Start Remote Control locally before choosing a LAN interface',
        409
      );
    }
    if (!isValidPort(port)) throw new TypeError('Remote port is invalid');
    const selected = this.bindingCatalog.resolve(bindingId, { kind: 'lan' });
    if (!selected) {
      throw new RemoteProtocolError('INVALID_BINDING', 'Choose an available private LAN interface', 400);
    }
    const loopback = this.bindingCatalog.loopback();
    this.lifecycleGeneration += 1;
    await this._closeListener();
    this.revokeAll('network-rebind');
    try {
      await this._listen(selected, port);
      return this.getStatus();
    } catch (error) {
      if (loopback) {
        try {
          await this._listen(loopback, 0);
        } catch (rollbackError) {
          this.emit('server-error', rollbackError);
        }
      }
      throw error;
    }
  }

  openPairing(options = {}) {
    if (!this.server || !this.origin) {
      throw new RemoteProtocolError('REMOTE_OFF', 'Turn on Remote Control first', 409);
    }
    const allowedKeys = new Set(['ttlMs']);
    for (const key of Object.keys(options)) {
      if (!allowedKeys.has(key)) throw new TypeError(`Unknown pairing option ${key}`);
    }
    return this.authority.openPairing({
      baseUrl: `${this.origin}/`,
      ...(Object.hasOwn(options, 'ttlMs') ? { ttlMs: options.ttlMs } : {})
    });
  }

  closePairing() {
    return this.authority.closePairing();
  }

  revokeAll(reason = 'operator-revoked') {
    const count = this.authority.revokeAll(reason);
    this.stateHub.closeAll();
    return count;
  }

  async stop(reason = 'remote-off') {
    this.lifecycleGeneration += 1;
    this.revokeAll(reason);
    await this._closeListener();
    this.loopbackInitialized = false;
    this._resetRateLimits();
    return this.getStatus();
  }

  async destroy() {
    await this.stop('destroyed');
    this.stateHub.destroy();
    this.removeAllListeners();
  }

  async _listen(binding, port) {
    const generation = ++this.lifecycleGeneration;
    const server = http.createServer((request, response) => {
      this._handleRequest(request, response, generation).catch(error => {
        this._handleRequestError(response, error);
      });
    });
    server.maxConnections = this.maxConnections;
    server.maxHeadersCount = 64;
    server.headersTimeout = 5000;
    server.requestTimeout = 10000;
    server.keepAliveTimeout = 5000;
    server.maxRequestsPerSocket = 100;
    server.on('connection', socket => {
      this.sockets.add(socket);
      socket.once('close', () => this.sockets.delete(socket));
    });
    server.on('clientError', (_error, socket) => socket.destroy());

    await new Promise((resolve, reject) => {
      const handleError = error => {
        server.removeListener('listening', handleListening);
        reject(error);
      };
      const handleListening = () => {
        server.removeListener('error', handleError);
        resolve();
      };
      server.once('error', handleError);
      server.once('listening', handleListening);
      server.listen({ host: binding.address, port, exclusive: true, backlog: 32 });
    });

    const address = server.address();
    const actualPort = typeof address === 'object' && address ? address.port : port;
    this.server = server;
    this.binding = Object.freeze({ ...binding, port: actualPort });
    this.expectedHost = `${binding.address}:${actualPort}`;
    this.origin = `http://${this.expectedHost}`;
    this.mode = binding.kind;
    server.on('error', error => this.emit('server-error', error));
    this._subscribeGateway();
    this._emitStatus();
  }

  async _closeListener() {
    const server = this.server;
    this.server = null;
    this.binding = null;
    this.origin = null;
    this.expectedHost = null;
    this.mode = 'off';
    this.cueCatalogCache = null;
    this.stateHub.closeAll();
    if (this.gatewayUnsubscribe) {
      try {
        this.gatewayUnsubscribe();
      } catch (_error) {
        // The remote transport is already stopping; a broken subscriber must
        // not affect the Show or prevent socket cleanup.
      }
      this.gatewayUnsubscribe = null;
    }
    if (!server) {
      this._emitStatus();
      return;
    }

    const closed = new Promise(resolve => {
      try {
        server.close(() => resolve());
      } catch (_error) {
        resolve();
      }
    });
    for (const socket of [...this.sockets]) socket.destroy();
    this.sockets.clear();
    await closed;
    this._emitStatus();
  }

  async _handleRequest(request, response, generation) {
    if (generation !== this.lifecycleGeneration || !this.server) {
      throw new RemoteProtocolError('REMOTE_RESTARTED', 'Remote Control was restarted', 503);
    }
    const peer = this._peerAddress(request);
    this._enforceRate(this.requestIpLimiter, peer);
    this._enforceRate(this.requestGlobalLimiter, 'global');
    this._validateHostAndOrigin(request);
    const parsedUrl = this._parseRequestUrl(request.url);
    const pathname = parsedUrl.pathname;
    const method = String(request.method || '').toUpperCase();

    if (method === 'GET' && this.staticRoutes.has(pathname) && parsedUrl.search === '') {
      return this._serveStatic(response, this.staticRoutes.get(pathname));
    }
    if (pathname === '/api/v1/pair' && method === 'POST' && parsedUrl.search === '') {
      return this._handlePair(request, response);
    }

    if (pathname.startsWith('/api/v1/')) {
      this._enforceRate(this.apiIpLimiter, this._peerAddress(request));
      this._enforceRate(this.apiGlobalLimiter, 'global');
      const device = this.authority.authenticate(request.headers.cookie);
      if (pathname === '/api/v1/state' && method === 'GET' && parsedUrl.search === '') {
        return this._handleState(response, device, generation);
      }
      if (pathname === '/api/v1/events' && method === 'GET' && parsedUrl.search === '') {
        return this._handleEvents(response, device, generation);
      }
      if (pathname === '/api/v1/cues' && method === 'GET') {
        return this._handleCueCatalog(response, parsedUrl, device, generation);
      }
      const thumbnailMatch = pathname.match(/^\/api\/v1\/cues\/(0|[1-9]\d{0,5})\/thumbnail$/);
      if (thumbnailMatch && method === 'GET') {
        return this._handleThumbnail(
          response,
          parsedUrl,
          Number(thumbnailMatch[1]),
          device,
          generation
        );
      }
      if (pathname === '/api/v1/commands' && method === 'POST' && parsedUrl.search === '') {
        return this._handleCommand(request, response, device, generation);
      }
    }

    throw new RemoteProtocolError('NOT_FOUND', 'Remote endpoint not found', 404);
  }

  async _handlePair(request, response) {
    const peer = this._peerAddress(request);
    this._enforceRate(this.pairIpLimiter, peer);
    this._enforceRate(this.pairGlobalLimiter, 'global');
    const pairRequest = parsePairRequest(await readJsonBody(request, PAIR_BODY_LIMIT));
    const state = await this._readState();
    const paired = this.authority.redeem(pairRequest);
    const cookie = `${COOKIE_NAME}=${paired.cookieValue}; Max-Age=${paired.maxAgeSeconds}; Path=/api/v1; HttpOnly; SameSite=Strict`;
    this._sendJson(response, 200, {
      ok: true,
      paired: true,
      device: paired.device,
      nextSequence: paired.nextSequence,
      state
    }, { 'Set-Cookie': cookie });
  }

  async _handleState(response, device, generation) {
    const state = await this._readState();
    this._assertCurrentDevice(device, generation);
    this._sendJson(response, 200, {
      ok: true,
      nextSequence: this.authority.nextSequence(device),
      state
    });
  }

  async _handleEvents(response, device, generation) {
    this.stateHub.assertCanAdd(device);
    const state = await this._readState();
    this._assertCurrentDevice(device, generation);
    this.stateHub.assertCanAdd(device);
    response.writeHead(200, {
      ...DEFAULT_SECURITY_HEADERS,
      'Content-Type': 'text/event-stream; charset=utf-8',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no'
    });
    this.stateHub.add({
      response,
      device,
      initialState: state,
      nextSequence: () => this.authority.nextSequence(device),
      isAuthorized: () => this.authority.isCurrentDevice(device)
    });
  }

  async _handleCueCatalog(response, parsedUrl, device, generation) {
    const entries = [...parsedUrl.searchParams.entries()];
    const allowed = new Set(['outputSessionId', 'offset', 'limit']);
    if (entries.length !== 3
      || entries.some(([key]) => !allowed.has(key))
      || new Set(entries.map(([key]) => key)).size !== 3) {
      throw new RemoteProtocolError('INVALID_CUE_CATALOG_REQUEST', 'Cue list request is invalid', 400);
    }
    const outputSessionId = parsedUrl.searchParams.get('outputSessionId');
    const offsetText = parsedUrl.searchParams.get('offset');
    const limitText = parsedUrl.searchParams.get('limit');
    if (!/^(?:0|[1-9]\d{0,5})$/.test(offsetText)
      || !/^[1-9]\d{0,2}$/.test(limitText)) {
      throw new RemoteProtocolError('INVALID_CUE_CATALOG_REQUEST', 'Cue list page is invalid', 400);
    }
    const offset = Number(offsetText);
    const limit = Number(limitText);
    if (limit > CUE_CATALOG_PAGE_LIMIT) {
      throw new RemoteProtocolError('INVALID_CUE_CATALOG_REQUEST', 'Cue list page is too large', 400);
    }

    const catalog = await this._readCueCatalog(outputSessionId);
    this._assertCurrentDevice(device, generation);
    if (offset > catalog.cues.length) {
      throw new RemoteProtocolError('INVALID_CUE_CATALOG_REQUEST', 'Cue list offset is invalid', 400);
    }
    const cues = catalog.cues.slice(offset, offset + limit);
    const nextOffset = offset + cues.length < catalog.cues.length
      ? offset + cues.length
      : null;
    this._sendJson(response, 200, {
      ok: true,
      outputSessionId: catalog.outputSessionId,
      totalCues: catalog.totalCues,
      catalogCueCount: catalog.cues.length,
      offset,
      nextOffset,
      cues
    });
  }

  async _handleThumbnail(response, parsedUrl, cueIndex, device, generation) {
    if (typeof this.showGateway.readCueThumbnail !== 'function') {
      throw new RemoteProtocolError('THUMBNAILS_UNAVAILABLE', 'Cue previews are unavailable', 404);
    }
    const queryEntries = [...parsedUrl.searchParams.entries()];
    if (queryEntries.length !== 1 || queryEntries[0][0] !== 'outputSessionId') {
      throw new RemoteProtocolError('INVALID_THUMBNAIL_REQUEST', 'Cue preview request is invalid', 400);
    }
    const requestedSessionId = queryEntries[0][1];
    const before = await this._readState();
    if (!before.outputSessionId || requestedSessionId !== before.outputSessionId) {
      throw new RemoteProtocolError('STALE_OUTPUT_SESSION', 'That cue preview belongs to an older Show', 409);
    }
    if (cueIndex >= before.totalCues) {
      throw new RemoteProtocolError('THUMBNAIL_NOT_FOUND', 'That cue preview is unavailable', 404);
    }

    let result;
    try {
      result = await this.showGateway.readCueThumbnail(requestedSessionId, cueIndex);
    } catch (error) {
      throw gatewayError(error);
    }
    const data = Buffer.isBuffer(result) ? result : result?.data;
    const contentType = Buffer.isBuffer(result) ? 'image/jpeg' : result?.contentType;
    if (!Buffer.isBuffer(data)
      || data.length === 0
      || data.length > THUMBNAIL_LIMIT
      || !THUMBNAIL_TYPES.has(contentType)) {
      throw new RemoteProtocolError('INVALID_THUMBNAIL', 'Cue preview data is invalid', 502);
    }
    const after = await this._readState();
    if (after.outputSessionId !== requestedSessionId) {
      throw new RemoteProtocolError('STALE_OUTPUT_SESSION', 'The Show changed while loading that preview', 409);
    }
    this._assertCurrentDevice(device, generation);
    response.writeHead(200, {
      ...DEFAULT_SECURITY_HEADERS,
      'Content-Type': contentType,
      'Content-Length': data.length
    });
    response.end(data);
  }

  async _handleCommand(request, response, device, generation) {
    this._enforceRate(this.commandDeviceLimiter, device.id);
    this._enforceRate(this.commandGlobalLimiter, 'global');
    const envelope = parseCommandEnvelope(await readJsonBody(request, JSON_BODY_LIMIT));
    const sequencer = this.authority.getSequencer(device);
    const fingerprint = commandFingerprint(envelope);

    try {
      const result = await this._enqueueCommand(async () => {
        if (generation !== this.lifecycleGeneration || !this.authority.isCurrentDevice(device)) {
          throw new RemoteProtocolError('REMOTE_RESTARTED', 'Remote Control was restarted', 503);
        }
        return sequencer.dispatch({
          envelope,
          fingerprint,
          precondition: async () => this._checkCommandPreconditions(envelope),
          execute: async () => {
            const gatewayEnvelope = {
              protocolVersion: PROTOCOL_VERSION,
              outputSessionId: envelope.outputSessionId,
              expectedRevision: envelope.expectedRevision,
              command: envelope.command
            };
            // A cue index is a stale-relative-navigation guard, not a generic
            // field. The Show gateway intentionally rejects it for absolute
            // jump and output actions.
            if (envelope.command.type === 'cue.previous' || envelope.command.type === 'cue.next') {
              gatewayEnvelope.expectedCueIndex = envelope.expectedCueIndex;
            }
            try {
              return await this.showGateway.execute(gatewayEnvelope, {
                deviceId: device.id,
                source: 'lan-remote'
              });
            } catch (error) {
              throw gatewayError(error);
            }
          },
          getState: () => this._readState()
        });
      });
      this._sendJson(response, 200, {
        ok: true,
        accepted: true,
        duplicate: result.duplicate,
        applied: result.applied,
        nextSequence: result.nextSequence,
        state: result.state
      });
    } catch (error) {
      try {
        error.remoteState = await this._readState();
        error.nextSequence = this.authority.isCurrentDevice(device)
          ? this.authority.nextSequence(device)
          : null;
      } catch (_stateError) {
        // Preserve the original protocol/auth failure if state is unavailable.
      }
      throw error;
    }
  }

  async _checkCommandPreconditions(envelope) {
    const state = await this._readState();
    if (state.outputSessionId !== envelope.outputSessionId) {
      throw new RemoteProtocolError(
        'STALE_OUTPUT_SESSION',
        'This command belongs to an older Show',
        409
      );
    }
    if (state.revision !== envelope.expectedRevision) {
      throw new RemoteProtocolError(
        'STALE_SHOW_STATE',
        'The Show changed before this command arrived',
        409
      );
    }
    if ((envelope.command.type === 'cue.previous' || envelope.command.type === 'cue.next')
      && state.currentCue?.index !== envelope.expectedCueIndex) {
      throw new RemoteProtocolError(
        'STALE_CUE',
        'The current cue changed before this command arrived',
        409
      );
    }
  }

  async _enqueueCommand(task) {
    if (this.pendingCommands >= this.maxCommandQueue) {
      throw new RemoteProtocolError('COMMAND_QUEUE_FULL', 'Remote Control is busy', 503);
    }
    this.pendingCommands += 1;
    const run = this.commandTail.then(task, task);
    this.commandTail = run.catch(() => undefined);
    try {
      return await run;
    } finally {
      this.pendingCommands -= 1;
    }
  }

  async _readState() {
    let raw;
    try {
      raw = await this.showGateway.getState();
    } catch (_error) {
      throw new RemoteProtocolError('SHOW_STATE_UNAVAILABLE', 'Show state is unavailable', 503);
    }
    const state = sanitizeRemoteState(raw);
    const thumbnailRoute = cue => {
      if (!cue) return null;
      const thumbnailUrl = cue.thumbnailAvailable === true
        && state.outputSessionId
        && typeof this.showGateway.readCueThumbnail === 'function'
        ? `/api/v1/cues/${cue.index}/thumbnail?outputSessionId=${encodeURIComponent(state.outputSessionId)}`
        : null;
      return { ...cue, thumbnailUrl };
    };
    state.currentCue = thumbnailRoute(state.currentCue);
    state.nextCue = thumbnailRoute(state.nextCue);
    if (Buffer.byteLength(JSON.stringify(state), 'utf8') > REMOTE_STATE_LIMIT) {
      throw new RemoteProtocolError('SHOW_STATE_TOO_LARGE', 'Show state is too large for Remote Control', 503);
    }
    return state;
  }

  async _readCueCatalog(outputSessionId) {
    const before = await this._readState();
    if (!before.outputSessionId || before.outputSessionId !== outputSessionId) {
      throw new RemoteProtocolError('STALE_OUTPUT_SESSION', 'That cue list belongs to an older Show', 409);
    }
    if (this.cueCatalogCache?.outputSessionId === outputSessionId
      && this.cueCatalogCache.totalCues === before.totalCues) {
      return this.cueCatalogCache;
    }
    if (typeof this.showGateway.getCueCatalog !== 'function') {
      throw new RemoteProtocolError('CUE_CATALOG_UNAVAILABLE', 'The cue list is unavailable', 404);
    }

    let rawCatalog;
    try {
      rawCatalog = await this.showGateway.getCueCatalog(outputSessionId);
    } catch (error) {
      throw gatewayError(error);
    }
    const cues = sanitizeCueCatalog(rawCatalog, before.totalCues);
    const expectedCount = Math.min(before.totalCues, 2000);
    if (cues.length !== expectedCount || cues.some((cue, index) => cue.index !== index)) {
      throw new RemoteProtocolError('INVALID_GATEWAY_STATE', 'Show cue catalog is incomplete', 500);
    }
    const thumbnailRoute = cue => ({
      ...cue,
      thumbnailUrl: cue.thumbnailAvailable === true
        && typeof this.showGateway.readCueThumbnail === 'function'
        ? `/api/v1/cues/${cue.index}/thumbnail?outputSessionId=${encodeURIComponent(outputSessionId)}`
        : null
    });
    const routedCues = cues.map(thumbnailRoute);
    if (Buffer.byteLength(JSON.stringify(routedCues), 'utf8') > CUE_CATALOG_LIMIT) {
      throw new RemoteProtocolError('CUE_CATALOG_TOO_LARGE', 'The cue list is too large for Remote Control', 503);
    }
    const after = await this._readState();
    if (after.outputSessionId !== outputSessionId) {
      throw new RemoteProtocolError('STALE_OUTPUT_SESSION', 'The Show changed while loading the cue list', 409);
    }
    const catalog = Object.freeze({
      outputSessionId,
      totalCues: before.totalCues,
      cues: Object.freeze(routedCues.map(cue => Object.freeze(cue)))
    });
    this.cueCatalogCache = catalog;
    return catalog;
  }

  _subscribeGateway() {
    if (this.gatewayUnsubscribe || typeof this.showGateway.subscribe !== 'function') return;
    const unsubscribe = this.showGateway.subscribe(() => this._schedulePublish());
    this.gatewayUnsubscribe = typeof unsubscribe === 'function' ? unsubscribe : () => {};
  }

  _schedulePublish() {
    if (this.publishScheduled || !this.server || this.stateHub.connections.size === 0) return;
    this.publishScheduled = true;
    setImmediate(async () => {
      this.publishScheduled = false;
      if (!this.server || this.stateHub.connections.size === 0) return;
      try {
        this.stateHub.publish(await this._readState());
      } catch (error) {
        this.emit('state-publish-error', error);
      }
    });
  }

  _validateHostAndOrigin(request) {
    if (headerOccurrences(request, 'host') !== 1 || request.headers.host !== this.expectedHost) {
      throw new RemoteProtocolError('INVALID_HOST', 'Remote request host was rejected', 421);
    }
    const localAddress = normalizePeerAddress(request.socket.localAddress);
    if (localAddress !== this.binding.address) {
      throw new RemoteProtocolError('INVALID_BINDING', 'Remote request reached the wrong interface', 421);
    }

    const originCount = headerOccurrences(request, 'origin');
    if (originCount > 1) {
      throw new RemoteProtocolError('INVALID_ORIGIN', 'Remote request origin was rejected', 403);
    }
    const origin = request.headers.origin;
    const mutation = String(request.method || '').toUpperCase() === 'POST';
    if ((mutation && (originCount !== 1 || origin !== this.origin))
      || (!mutation && origin !== undefined && origin !== this.origin)) {
      throw new RemoteProtocolError('INVALID_ORIGIN', 'Remote request origin was rejected', 403);
    }
  }

  _parseRequestUrl(requestUrl) {
    if (typeof requestUrl !== 'string'
      || !requestUrl.startsWith('/')
      || requestUrl.startsWith('//')
      || requestUrl.includes('\\')) {
      throw new RemoteProtocolError('INVALID_REQUEST_TARGET', 'Remote request target was rejected', 400);
    }
    try {
      const parsed = new URL(requestUrl, this.origin);
      const rawPathname = requestUrl.split('?', 1)[0];
      if (parsed.pathname !== rawPathname) {
        throw new Error('Request path required normalization');
      }
      return parsed;
    } catch (_error) {
      throw new RemoteProtocolError('INVALID_REQUEST_TARGET', 'Remote request target was rejected', 400);
    }
  }

  _peerAddress(request) {
    return normalizePeerAddress(request.socket.remoteAddress);
  }

  _enforceRate(limiter, key) {
    const result = limiter.consume(key);
    if (!result.allowed) {
      throw new RemoteProtocolError(
        'RATE_LIMITED',
        'Too many remote requests; wait a moment and try again',
        429,
        { retryAfterMs: result.retryAfterMs }
      );
    }
  }

  _assertCurrentDevice(device, generation) {
    if (generation !== this.lifecycleGeneration || !this.authority.isCurrentDevice(device)) {
      throw new RemoteProtocolError('REMOTE_RESTARTED', 'Remote Control was restarted', 503);
    }
  }

  _resetRateLimits() {
    this.requestIpLimiter.clear();
    this.requestGlobalLimiter.clear();
    this.pairIpLimiter.clear();
    this.pairGlobalLimiter.clear();
    this.apiIpLimiter.clear();
    this.apiGlobalLimiter.clear();
    this.commandDeviceLimiter.clear();
    this.commandGlobalLimiter.clear();
  }

  _serveStatic(response, entry) {
    const body = entry.body;
    response.writeHead(200, {
      ...DEFAULT_SECURITY_HEADERS,
      'Content-Type': entry.contentType,
      'Content-Length': body.length
    });
    response.end(body);
  }

  _sendJson(response, status, value, additionalHeaders = {}) {
    const body = Buffer.from(JSON.stringify(value), 'utf8');
    response.writeHead(status, {
      ...DEFAULT_SECURITY_HEADERS,
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': body.length,
      ...additionalHeaders
    });
    response.end(body);
  }

  _handleRequestError(response, rawError) {
    const error = gatewayError(rawError);
    if (response.headersSent) {
      if (!response.writableEnded) response.destroy();
      return;
    }
    const retryAfter = retryAfterSeconds(error);
    const payload = {
      ok: false,
      error: {
        code: error.code,
        message: error.message
      }
    };
    if (Number.isSafeInteger(error.nextSequence) || error.nextSequence === null) {
      payload.nextSequence = error.nextSequence;
    }
    if (error.remoteState) payload.state = error.remoteState;
    this._sendJson(response, error.status || 500, payload, retryAfter
      ? { 'Retry-After': String(retryAfter) }
      : {});
  }

  _emitStatus() {
    this.emit('status-changed', this.getStatus());
  }
}

module.exports = {
  DEFAULT_SECURITY_HEADERS,
  JSON_BODY_LIMIT,
  PAIR_BODY_LIMIT,
  REMOTE_STATE_LIMIT,
  THUMBNAIL_LIMIT,
  RemoteControlServer,
  gatewayError,
  headerOccurrences,
  normalizedStaticRoutes,
  readJsonBody
};
