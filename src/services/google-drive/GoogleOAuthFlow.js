'use strict';

const crypto = require('crypto');
const http = require('http');

const AUTHORIZATION_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const DRIVE_FILE_SCOPE = 'https://www.googleapis.com/auth/drive.file';
const CALLBACK_PATH = '/oauth2/callback';
const DEFAULT_TIMEOUT_MS = 3 * 60 * 1000;
const FOLDER_ID_PATTERN = /^[A-Za-z0-9_-]{10,200}$/;
const PROVIDER_ERROR_PATTERN = /^[a-z][a-z0-9_.-]{0,63}$/;
const PROVIDER_DESCRIPTION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9 .,:;'"!?()/_-]{0,199}$/;
const PROVIDER_DESCRIPTION_SECRET_PATTERN =
  /(?:^|[\s?&#])(?:authorization_code|access_token|refresh_token|id_token|client_secret|code|token|state|verifier|secret|code_verifier|code_challenge)\s*[:=]/i;
const PROVIDER_DESCRIPTION_OPAQUE_PATTERN = /[A-Za-z0-9_-]{24,}/;
const PROVIDER_DESCRIPTION_URL_PATTERN = /(?:https?:\/\/|www\.)/i;
const PROVIDER_DESCRIPTION_EMAIL_PATTERN = /[^\s@]+@[^\s@]+\.[^\s@]+/;

class GoogleOAuthError extends Error {
  constructor(code, message, { cause = null } = {}) {
    super(message);
    this.name = 'GoogleOAuthError';
    this.code = code;
    this.cause = cause;
  }
}

function base64Url(buffer) {
  return Buffer.from(buffer).toString('base64url');
}

function timingSafeStringEqual(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string') return false;
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length
    && crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function parsePickedFileIds(searchParams) {
  const rawValues = searchParams.getAll('picked_file_ids');
  if (rawValues.length !== 1 || rawValues[0].length > 4096) {
    throw new GoogleOAuthError(
      'FOLDER_NOT_SELECTED',
      'Choose exactly one Google Drive folder for SyncShow.'
    );
  }
  let values;
  const raw = rawValues[0].trim();
  if (raw.startsWith('[')) {
    try {
      values = JSON.parse(raw);
    } catch (_error) {
      throw new GoogleOAuthError('INVALID_CALLBACK', 'Google returned an invalid folder selection.');
    }
  } else {
    values = raw.split(',');
  }
  if (!Array.isArray(values)) {
    throw new GoogleOAuthError('INVALID_CALLBACK', 'Google returned an invalid folder selection.');
  }
  const ids = [...new Set(values.map(value => String(value).trim()).filter(Boolean))];
  if (ids.length !== 1 || !FOLDER_ID_PATTERN.test(ids[0])) {
    throw new GoogleOAuthError(
      'FOLDER_NOT_SELECTED',
      'Choose exactly one Google Drive folder for SyncShow.'
    );
  }
  return ids;
}

function buildAuthorizationUrl({
  clientId,
  redirectUri,
  state,
  codeChallenge,
  authorizationEndpoint = AUTHORIZATION_ENDPOINT
}) {
  const url = new URL(authorizationEndpoint);
  if (url.protocol !== 'https:' || url.username || url.password) {
    throw new TypeError('Google authorization endpoint must be HTTPS');
  }
  url.search = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: DRIVE_FILE_SCOPE,
    state,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
    access_type: 'offline',
    prompt: 'consent',
    trigger_onepick: 'true',
    allow_folder_selection: 'true',
    mimetypes: 'application/vnd.google-apps.folder'
  }).toString();
  return url;
}

function writeBrowserResponse(response, statusCode, title, message) {
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8">`
    + `<meta name="viewport" content="width=device-width,initial-scale=1">`
    + `<title>${title}</title></head><body><main><h1>${title}</h1><p>${message}</p></main></body></html>`;
  response.writeHead(statusCode, {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Length': Buffer.byteLength(html),
    'Cache-Control': 'no-store',
    'Content-Security-Policy': "default-src 'none'; style-src 'none'; img-src 'none'; base-uri 'none'; frame-ancestors 'none'",
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff'
  });
  response.end(html);
}

function validateClientId(clientId) {
  if (typeof clientId !== 'string'
    || !/^[A-Za-z0-9._-]{10,200}\.apps\.googleusercontent\.com$/.test(clientId)) {
    throw new TypeError('A Google Desktop OAuth client ID is required');
  }
  return clientId;
}

function optionalClientSecret(value) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || !/^[\x21-\x7e]{8,1024}$/.test(value)) {
    throw new TypeError('Google OAuth client secret is invalid');
  }
  return value;
}

function sanitizeOAuthProviderError(value) {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toLowerCase();
  return PROVIDER_ERROR_PATTERN.test(normalized) ? normalized : null;
}

function sanitizeOAuthProviderDescription(value) {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().replace(/\s+/g, ' ');
  if (!PROVIDER_DESCRIPTION_PATTERN.test(normalized)
    || PROVIDER_DESCRIPTION_SECRET_PATTERN.test(normalized)
    || PROVIDER_DESCRIPTION_OPAQUE_PATTERN.test(normalized)
    || PROVIDER_DESCRIPTION_URL_PATTERN.test(normalized)
    || PROVIDER_DESCRIPTION_EMAIL_PATTERN.test(normalized)) {
    return null;
  }
  return normalized;
}

function tokenExchangeFailure(payload) {
  const providerError = sanitizeOAuthProviderError(payload?.error);
  const providerDescription = sanitizeOAuthProviderDescription(payload?.error_description);
  const action = {
    invalid_grant:
      'Google rejected the one-time sign-in code. It may have expired, already been used, or failed Google’s PKCE check. Start Google sign-in again.',
    redirect_uri_mismatch:
      'Google rejected SyncShow’s local callback address. Check the Google Desktop OAuth client configuration, then start Google sign-in again.',
    invalid_client:
      'Google rejected SyncShow’s Desktop OAuth client. Check the packaged Google OAuth credentials, then start Google sign-in again.',
    unauthorized_client:
      'Google has not authorized this Desktop OAuth client to complete sign-in. Check the Google OAuth configuration, then try again.',
    deleted_client:
      'The configured Google Desktop OAuth client has been deleted. Replace the client ID before trying again.',
    invalid_request:
      'Google rejected part of SyncShow’s OAuth request. Check the Google Desktop OAuth configuration, then try again.',
    temporarily_unavailable:
      'Google sign-in is temporarily unavailable. Wait a moment, then start Google sign-in again.',
    server_error:
      'Google sign-in is temporarily unavailable. Wait a moment, then start Google sign-in again.'
  }[providerError] || 'Google rejected the sign-in response. Start Google sign-in again.';
  const diagnostic = providerError
    ? ` Google reported “${providerError}${providerDescription ? `: ${providerDescription}` : ''}”.`
    : '';
  return Object.freeze({
    cause: providerError,
    message: `${action}${diagnostic}`
  });
}

async function exchangeAuthorizationCode({
  clientId,
  clientSecret = null,
  code,
  codeVerifier,
  redirectUri,
  fetchImpl = globalThis.fetch,
  tokenEndpoint = TOKEN_ENDPOINT,
  signal = null
}) {
  validateClientId(clientId);
  const normalizedClientSecret = optionalClientSecret(clientSecret);
  if (typeof fetchImpl !== 'function') throw new TypeError('OAuth token exchange requires fetch');
  if (typeof code !== 'string' || code.length < 1 || code.length > 4096) {
    throw new GoogleOAuthError('INVALID_CALLBACK', 'Google returned an invalid authorization code.');
  }
  if (typeof codeVerifier !== 'string' || !/^[A-Za-z0-9_-]{43,128}$/.test(codeVerifier)) {
    throw new TypeError('PKCE verifier is invalid');
  }
  const endpoint = new URL(tokenEndpoint);
  if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password) {
    throw new TypeError('Google token endpoint must be HTTPS');
  }
  const body = new URLSearchParams({
    client_id: clientId,
    code,
    code_verifier: codeVerifier,
    grant_type: 'authorization_code',
    redirect_uri: redirectUri
  });
  if (normalizedClientSecret) body.set('client_secret', normalizedClientSecret);
  let response;
  try {
    response = await fetchImpl(endpoint, {
      method: 'POST',
      redirect: 'error',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body,
      signal
    });
  } catch (error) {
    throw new GoogleOAuthError(
      'TOKEN_EXCHANGE_NETWORK_ERROR',
      'SyncShow could not finish Google sign-in.',
      { cause: error?.code || error?.name || 'network-error' }
    );
  }
  let text;
  try {
    text = await response.text();
  } catch (_error) {
    throw new GoogleOAuthError('INVALID_TOKEN_RESPONSE', 'Google returned an invalid token response.');
  }
  if (Buffer.byteLength(text) > 2 * 1024 * 1024) {
    throw new GoogleOAuthError('INVALID_TOKEN_RESPONSE', 'Google returned an oversized token response.');
  }
  let payload;
  try {
    payload = text ? JSON.parse(text) : {};
  } catch (_error) {
    throw new GoogleOAuthError('INVALID_TOKEN_RESPONSE', 'Google returned an invalid token response.');
  }
  if (!response.ok) {
    const failure = tokenExchangeFailure(payload);
    throw new GoogleOAuthError(
      'TOKEN_EXCHANGE_FAILED',
      failure.message,
      { cause: failure.cause }
    );
  }
  if (typeof payload.access_token !== 'string'
    || payload.access_token.length < 10
    || typeof payload.refresh_token !== 'string'
    || payload.refresh_token.length < 10) {
    throw new GoogleOAuthError(
      'MISSING_REFRESH_TOKEN',
      'Google did not provide durable access. Disconnect SyncShow in Google and try again.'
    );
  }
  const expiresIn = Number(payload.expires_in);
  if (!Number.isSafeInteger(expiresIn) || expiresIn < 1 || expiresIn > 24 * 60 * 60) {
    throw new GoogleOAuthError('INVALID_TOKEN_RESPONSE', 'Google returned an invalid token lifetime.');
  }
  const grantedScopes = typeof payload.scope === 'string'
    ? payload.scope.trim().split(/\s+/).filter(Boolean)
    : [DRIVE_FILE_SCOPE];
  if (grantedScopes.length !== 1 || grantedScopes[0] !== DRIVE_FILE_SCOPE) {
    throw new GoogleOAuthError(
      'UNEXPECTED_TOKEN_SCOPE',
      'Google granted permissions beyond the selected Drive folder.'
    );
  }
  return Object.freeze({
    accessToken: payload.access_token,
    refreshToken: payload.refresh_token,
    expiresIn,
    tokenType: typeof payload.token_type === 'string' ? payload.token_type : 'Bearer',
    scope: DRIVE_FILE_SCOPE
  });
}

function listenOnLoopback(server) {
  return new Promise((resolve, reject) => {
    const onError = error => {
      server.off('listening', onListening);
      reject(error);
    };
    const onListening = () => {
      server.off('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen({ host: '127.0.0.1', port: 0, exclusive: true });
  });
}

function closeServer(server) {
  if (!server?.listening) return Promise.resolve();
  return new Promise(resolve => server.close(() => resolve()));
}

class GoogleOAuthFlow {
  constructor({
    clientId,
    clientSecret = null,
    openExternal,
    fetchImpl = globalThis.fetch,
    createServer = handler => http.createServer(handler),
    listenServer = listenOnLoopback,
    closeServerImpl = closeServer,
    randomBytes = crypto.randomBytes,
    authorizationEndpoint = AUTHORIZATION_ENDPOINT,
    tokenEndpoint = TOKEN_ENDPOINT,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    onAuthorizationStateChanged = () => {},
    setTimeoutImpl = setTimeout,
    clearTimeoutImpl = clearTimeout
  } = {}) {
    this.clientId = validateClientId(clientId);
    this.clientSecret = optionalClientSecret(clientSecret);
    if (typeof openExternal !== 'function') throw new TypeError('OAuth flow requires openExternal');
    if (typeof fetchImpl !== 'function') throw new TypeError('OAuth flow requires fetch');
    if (typeof createServer !== 'function'
      || typeof listenServer !== 'function'
      || typeof closeServerImpl !== 'function'
      || typeof randomBytes !== 'function'
      || typeof onAuthorizationStateChanged !== 'function'
      || typeof setTimeoutImpl !== 'function'
      || typeof clearTimeoutImpl !== 'function') {
      throw new TypeError('OAuth flow dependencies are invalid');
    }
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 10 * 60 * 1000) {
      throw new TypeError('OAuth timeout must be between one second and ten minutes');
    }
    this.openExternal = openExternal;
    this.fetchImpl = fetchImpl;
    this.createServer = createServer;
    this.listenServer = listenServer;
    this.closeServer = closeServerImpl;
    this.randomBytes = randomBytes;
    this.authorizationEndpoint = authorizationEndpoint;
    this.tokenEndpoint = tokenEndpoint;
    this.timeoutMs = timeoutMs;
    this.onAuthorizationStateChanged = onAuthorizationStateChanged;
    this.setTimeout = setTimeoutImpl;
    this.clearTimeout = clearTimeoutImpl;
    this.activeServer = null;
    this.activeCancellation = null;
    this.activeAuthorizationUrl = null;
  }

  setActiveAuthorizationUrl(value) {
    const nextValue = typeof value === 'string' && value ? value : null;
    if (this.activeAuthorizationUrl === nextValue) return;
    this.activeAuthorizationUrl = nextValue;
    try {
      // The renderer-facing callback deliberately receives lifecycle only.
      // The exact URL remains in main and can be copied only by explicit IPC.
      this.onAuthorizationStateChanged(Object.freeze({
        active: nextValue !== null
      }));
    } catch (_error) {
      // UI notification failure must not interrupt or log an OAuth attempt.
    }
  }

  getActiveAuthorizationUrl() {
    return this.activeAuthorizationUrl;
  }

  async start({ signal = null } = {}) {
    if (this.activeServer) {
      throw new GoogleOAuthError('FLOW_ACTIVE', 'Google sign-in is already open.');
    }
    const state = base64Url(this.randomBytes(32));
    const codeVerifier = base64Url(this.randomBytes(32));
    if (!/^[A-Za-z0-9_-]{43}$/.test(state) || !/^[A-Za-z0-9_-]{43}$/.test(codeVerifier)) {
      throw new GoogleOAuthError('RANDOMNESS_FAILED', 'Secure Google sign-in could not be started.');
    }
    const codeChallenge = base64Url(crypto.createHash('sha256').update(codeVerifier).digest());
    let settleCallback;
    const callbackPromise = new Promise((resolve, reject) => {
      settleCallback = { resolve, reject, settled: false };
    });
    const settle = (method, value) => {
      if (settleCallback.settled) return false;
      settleCallback.settled = true;
      settleCallback[method](value);
      return true;
    };
    const tokenExchangeController = new AbortController();
    let callbackClaimed = false;

    let redirectUri = null;
    let authorizationUrlString = null;
    const server = this.createServer(async (request, response) => {
      let requestUrl;
      if (typeof request.url !== 'string' || request.url.length > 8192) {
        writeBrowserResponse(response, 400, 'Could not connect', 'Return to SyncShow and try again.');
        return;
      }
      try {
        requestUrl = new URL(request.url, redirectUri || 'http://127.0.0.1');
      } catch (_error) {
        writeBrowserResponse(response, 400, 'Could not connect', 'Return to SyncShow and try again.');
        return;
      }
      if (request.method !== 'GET' || requestUrl.pathname !== CALLBACK_PATH) {
        writeBrowserResponse(response, 404, 'Not found', 'This local page is only for SyncShow sign-in.');
        return;
      }
      const expectedHost = redirectUri ? new URL(redirectUri).host : null;
      const remoteAddress = request.socket?.remoteAddress || null;
      if (expectedHost
        && (request.headers?.host !== expectedHost
          || !['127.0.0.1', '::ffff:127.0.0.1'].includes(remoteAddress))) {
        writeBrowserResponse(response, 400, 'Could not connect', 'The local sign-in response was not expected.');
        return;
      }
      if (settleCallback.settled || callbackClaimed) {
        writeBrowserResponse(response, 410, 'Connection expired', 'Return to SyncShow to continue.');
        return;
      }
      const states = requestUrl.searchParams.getAll('state');
      const codes = requestUrl.searchParams.getAll('code');
      const errors = requestUrl.searchParams.getAll('error');
      if (states.length !== 1
        || codes.length > 1
        || errors.length > 1
        || (codes.length > 0 && errors.length > 0)) {
        writeBrowserResponse(response, 400, 'Could not connect', 'The sign-in response was not valid.');
        settle('reject', new GoogleOAuthError('INVALID_CALLBACK', 'Google sign-in response was invalid.'));
        return;
      }
      if (!timingSafeStringEqual(states[0], state)) {
        writeBrowserResponse(response, 400, 'Could not connect', 'The sign-in response was not expected.');
        settle('reject', new GoogleOAuthError('STATE_MISMATCH', 'Google sign-in state did not match.'));
        return;
      }
      if (errors.length === 1) {
        const oauthError = errors[0];
        const cancelled = oauthError === 'access_denied';
        writeBrowserResponse(
          response,
          400,
          cancelled ? 'Connection cancelled' : 'Could not connect',
          'Return to SyncShow to continue.'
        );
        settle(
          'reject',
          new GoogleOAuthError(cancelled ? 'CANCELLED' : 'OAUTH_ERROR', 'Google sign-in was not completed.')
        );
        return;
      }
      try {
        callbackClaimed = true;
        const folderIds = parsePickedFileIds(requestUrl.searchParams);
        const code = codes[0];
        const tokens = await exchangeAuthorizationCode({
          clientId: this.clientId,
          clientSecret: this.clientSecret,
          code,
          codeVerifier,
          redirectUri,
          fetchImpl: this.fetchImpl,
          tokenEndpoint: this.tokenEndpoint,
          signal: tokenExchangeController.signal
        });
        writeBrowserResponse(
          response,
          200,
          'Google Drive connected',
          'You can close this tab and return to SyncShow.'
        );
        settle('resolve', Object.freeze({
          ...tokens,
          folderId: folderIds[0]
        }));
      } catch (error) {
        writeBrowserResponse(response, 400, 'Could not connect', 'Return to SyncShow and try again.');
        settle(
          'reject',
          error instanceof GoogleOAuthError
            ? error
            : new GoogleOAuthError('INVALID_CALLBACK', 'Google sign-in could not be completed.')
        );
      }
    });
    this.activeServer = server;
    this.activeCancellation = () => {
      tokenExchangeController.abort(new Error('Google sign-in cancelled'));
      settle('reject', new GoogleOAuthError('CANCELLED', 'Google sign-in was cancelled.'));
    };

    let timer = null;
    let abortListener = null;
    try {
      try {
        await this.listenServer(server);
      } catch (error) {
        throw new GoogleOAuthError(
          'LOOPBACK_FAILED',
          'SyncShow could not open its private Google sign-in callback.',
          { cause: error?.code || 'listen-error' }
        );
      }
      const address = server.address();
      if (!address || typeof address === 'string' || address.address !== '127.0.0.1') {
        throw new GoogleOAuthError('LOOPBACK_FAILED', 'Google sign-in did not bind to loopback.');
      }
      redirectUri = `http://127.0.0.1:${address.port}${CALLBACK_PATH}`;
      const authorizationUrl = buildAuthorizationUrl({
        clientId: this.clientId,
        redirectUri,
        state,
        codeChallenge,
        authorizationEndpoint: this.authorizationEndpoint
      });
      authorizationUrlString = authorizationUrl.toString();
      this.setActiveAuthorizationUrl(authorizationUrlString);

      timer = this.setTimeout(() => {
        tokenExchangeController.abort(new Error('Google sign-in timed out'));
        settle('reject', new GoogleOAuthError('TIMEOUT', 'Google sign-in timed out.'));
      }, this.timeoutMs);
      timer.unref?.();
      if (signal) {
        abortListener = () => {
          tokenExchangeController.abort(signal.reason);
          settle('reject', new GoogleOAuthError('CANCELLED', 'Google sign-in was cancelled.'));
        };
        if (signal.aborted) abortListener();
        else signal.addEventListener('abort', abortListener, { once: true });
      }
      if (settleCallback.settled) return await callbackPromise;
      const browserOpenPromise = (async () => {
        try {
          await this.openExternal(authorizationUrlString);
          return { source: 'browser' };
        } catch (error) {
          const browserError = new GoogleOAuthError(
            'BROWSER_FAILED',
            'SyncShow could not open the system browser for Google sign-in.',
            { cause: error?.code || error?.name || 'browser-error' }
          );
          settle('reject', browserError);
          throw browserError;
        }
      })();
      const callbackOutcomePromise = callbackPromise.then(value => ({
        source: 'callback',
        value
      }));
      const firstOutcome = await Promise.race([browserOpenPromise, callbackOutcomePromise]);
      if (firstOutcome.source === 'callback') {
        authorizationUrlString = null;
        return firstOutcome.value;
      }
      return await callbackPromise;
    } finally {
      this.setActiveAuthorizationUrl(null);
      authorizationUrlString = null;
      tokenExchangeController.abort(new Error('Google sign-in finished'));
      if (timer) this.clearTimeout(timer);
      if (abortListener) signal.removeEventListener('abort', abortListener);
      await this.closeServer(server);
      if (this.activeServer === server) this.activeServer = null;
      this.activeCancellation = null;
    }
  }

  async cancel() {
    if (!this.activeServer) return false;
    this.activeCancellation?.();
    return true;
  }
}

module.exports = {
  AUTHORIZATION_ENDPOINT,
  CALLBACK_PATH,
  DEFAULT_TIMEOUT_MS,
  DRIVE_FILE_SCOPE,
  GoogleOAuthError,
  GoogleOAuthFlow,
  TOKEN_ENDPOINT,
  buildAuthorizationUrl,
  exchangeAuthorizationCode,
  parsePickedFileIds
};
