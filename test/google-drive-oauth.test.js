'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  DRIVE_FILE_SCOPE,
  GoogleOAuthError,
  GoogleOAuthFlow,
  buildAuthorizationUrl,
  exchangeAuthorizationCode,
  parsePickedFileIds
} = require('../src/services/google-drive/GoogleOAuthFlow');

const CLIENT_ID = '123456789012-abcdefghijklmnopqrstuvwxyz.apps.googleusercontent.com';
const CLIENT_SECRET = 'GOCSPX-test-desktop-client-credential';
const FOLDER_ID = 'privateFolder123456789';

function fakeLoopback() {
  let handler = null;
  const server = {
    listening: false,
    address: () => ({ address: '127.0.0.1', port: 45123, family: 'IPv4' })
  };
  return {
    createServer(callback) {
      handler = callback;
      return server;
    },
    async listenServer() {
      server.listening = true;
    },
    async closeServer() {
      server.listening = false;
    },
    async dispatch(url) {
      let statusCode = null;
      const parsed = new URL(url);
      const response = {
        writeHead(status) {
          statusCode = status;
        },
        end() {}
      };
      await handler({
        method: 'GET',
        url: parsed.pathname + parsed.search,
        headers: { host: parsed.host },
        socket: { remoteAddress: '127.0.0.1' }
      }, response);
      return statusCode;
    }
  };
}

test('OAuth authorization uses PKCE, loopback redirect, drive.file, offline consent, and folder picker', () => {
  const url = buildAuthorizationUrl({
    clientId: CLIENT_ID,
    redirectUri: 'http://127.0.0.1:45123/oauth2/callback',
    state: 'state-value',
    codeChallenge: 'challenge-value'
  });
  assert.equal(url.origin, 'https://accounts.google.com');
  assert.equal(url.searchParams.get('client_id'), CLIENT_ID);
  assert.equal(url.searchParams.get('scope'), DRIVE_FILE_SCOPE);
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(url.searchParams.get('access_type'), 'offline');
  assert.equal(url.searchParams.get('prompt'), 'consent');
  assert.equal(url.searchParams.get('trigger_onepick'), 'true');
  assert.equal(url.searchParams.get('allow_folder_selection'), 'true');
  assert.equal(url.searchParams.get('mimetypes'), 'application/vnd.google-apps.folder');
  assert.equal(url.searchParams.has('file_mime_types'), false);
  assert.equal(url.searchParams.has('include_granted_scopes'), false);
});

test('folder picker callback requires exactly one valid folder ID', () => {
  assert.deepEqual(
    parsePickedFileIds(new URLSearchParams({ picked_file_ids: `["${FOLDER_ID}"]` })),
    [FOLDER_ID]
  );
  assert.deepEqual(
    parsePickedFileIds(new URLSearchParams({ picked_file_ids: FOLDER_ID })),
    [FOLDER_ID]
  );
  assert.throws(
    () => parsePickedFileIds(new URLSearchParams({
      picked_file_ids: `${FOLDER_ID},secondFolder12345678`
    })),
    error => error instanceof GoogleOAuthError && error.code === 'FOLDER_NOT_SELECTED'
  );
});

test('OAuth flow keeps the optional client secret out of the browser and uses it at token exchange', async () => {
  let authorizationUrl = null;
  let tokenBody = null;
  const lifecycle = [];
  const loopback = fakeLoopback();
  const flow = new GoogleOAuthFlow({
    clientId: CLIENT_ID,
    clientSecret: CLIENT_SECRET,
    createServer: loopback.createServer,
    listenServer: loopback.listenServer,
    closeServerImpl: loopback.closeServer,
    randomBytes: size => Buffer.alloc(size, 7),
    onAuthorizationStateChanged: state => lifecycle.push(state),
    openExternal: async value => {
      authorizationUrl = new URL(value);
      assert.equal(authorizationUrl.searchParams.has('client_secret'), false);
      assert.equal(value.includes(CLIENT_SECRET), false);
      assert.equal(flow.getActiveAuthorizationUrl(), value);
      const callback = new URL(authorizationUrl.searchParams.get('redirect_uri'));
      assert.equal(callback.hostname, '127.0.0.1');
      assert.notEqual(callback.port, '');
      callback.searchParams.set('state', authorizationUrl.searchParams.get('state'));
      callback.searchParams.set('code', 'authorization-code-for-testing');
      callback.searchParams.set('picked_file_ids', JSON.stringify([FOLDER_ID]));
      setImmediate(() => loopback.dispatch(callback).catch(() => {}));
    },
    fetchImpl: async (_input, options) => {
      tokenBody = new URLSearchParams(String(options.body));
      return new Response(JSON.stringify({
        access_token: 'access-token-for-testing',
        refresh_token: 'refresh-token-for-testing',
        expires_in: 3600,
        token_type: 'Bearer',
        scope: DRIVE_FILE_SCOPE
      }), { headers: { 'Content-Type': 'application/json' } });
    }
  });

  const result = await flow.start();
  assert.equal(result.folderId, FOLDER_ID);
  assert.equal(result.accessToken, 'access-token-for-testing');
  assert.equal(result.refreshToken, 'refresh-token-for-testing');
  assert.equal(tokenBody.get('client_id'), CLIENT_ID);
  assert.equal(tokenBody.get('client_secret'), CLIENT_SECRET);
  assert.equal(tokenBody.get('code'), 'authorization-code-for-testing');
  assert.match(tokenBody.get('code_verifier'), /^[A-Za-z0-9_-]{43}$/);
  assert.notEqual(
    authorizationUrl.searchParams.get('code_challenge'),
    tokenBody.get('code_verifier')
  );
  assert.equal(flow.getActiveAuthorizationUrl(), null);
  assert.deepEqual(lifecycle, [{ active: true }, { active: false }]);
  assert.deepEqual(Object.keys(lifecycle[0]), ['active']);
});

test('OAuth token exchange remains compatible with a secretless Desktop client', async () => {
  let tokenBody = null;
  const result = await exchangeAuthorizationCode({
    clientId: CLIENT_ID,
    code: 'authorization-code-for-testing',
    codeVerifier: 'v'.repeat(43),
    redirectUri: 'http://127.0.0.1:45123/oauth2/callback',
    fetchImpl: async (_input, options) => {
      tokenBody = new URLSearchParams(String(options.body));
      return new Response(JSON.stringify({
        access_token: 'access-token-for-testing',
        refresh_token: 'refresh-token-for-testing',
        expires_in: 3600,
        token_type: 'Bearer',
        scope: DRIVE_FILE_SCOPE
      }), { headers: { 'Content-Type': 'application/json' } });
    }
  });

  assert.equal(tokenBody.has('client_secret'), false);
  assert.equal(result.accessToken, 'access-token-for-testing');
  assert.equal(result.refreshToken, 'refresh-token-for-testing');
});

test('OAuth token exchange rejects malformed optional client secrets before network access', async () => {
  for (const clientSecret of ['short', 'contains space', 'unicode-\u2603', 'x'.repeat(1025)]) {
    let fetchCalled = false;
    await assert.rejects(
      exchangeAuthorizationCode({
        clientId: CLIENT_ID,
        clientSecret,
        code: 'authorization-code-for-testing',
        codeVerifier: 'v'.repeat(43),
        redirectUri: 'http://127.0.0.1:45123/oauth2/callback',
        fetchImpl: async () => {
          fetchCalled = true;
          throw new Error('must not fetch');
        }
      }),
      error => error instanceof TypeError && /client secret is invalid/.test(error.message)
    );
    assert.equal(fetchCalled, false);
  }
});

test('OAuth flow rejects callback state mismatch before exchanging a token', async () => {
  let tokenCalls = 0;
  const loopback = fakeLoopback();
  const flow = new GoogleOAuthFlow({
    clientId: CLIENT_ID,
    createServer: loopback.createServer,
    listenServer: loopback.listenServer,
    closeServerImpl: loopback.closeServer,
    openExternal: async value => {
      const callback = new URL(new URL(value).searchParams.get('redirect_uri'));
      callback.searchParams.set('state', 'attacker-state');
      callback.searchParams.set('code', 'stolen-code');
      callback.searchParams.set('picked_file_ids', FOLDER_ID);
      setImmediate(() => loopback.dispatch(callback).catch(() => {}));
    },
    fetchImpl: async () => {
      tokenCalls += 1;
      throw new Error('must not exchange');
    }
  });

  await assert.rejects(
    flow.start(),
    error => error instanceof GoogleOAuthError && error.code === 'STATE_MISMATCH'
  );
  assert.equal(tokenCalls, 0);
});

test('OAuth token exchange rejects scopes beyond drive.file', async () => {
  await assert.rejects(
    exchangeAuthorizationCode({
      clientId: CLIENT_ID,
      code: 'authorization-code-for-testing',
      codeVerifier: 'v'.repeat(43),
      redirectUri: 'http://127.0.0.1:45123/oauth2/callback',
      fetchImpl: async () => new Response(JSON.stringify({
        access_token: 'access-token-for-testing',
        refresh_token: 'refresh-token-for-testing',
        expires_in: 3600,
        token_type: 'Bearer',
        scope: `${DRIVE_FILE_SCOPE} https://www.googleapis.com/auth/drive.readonly`
      }), { headers: { 'Content-Type': 'application/json' } })
    }),
    error => error instanceof GoogleOAuthError && error.code === 'UNEXPECTED_TOKEN_SCOPE'
  );
});

test('OAuth token exchange reports safe Google invalid_grant diagnostics without request credentials', async () => {
  const authorizationCode = 'authorization-code-for-testing';
  const codeVerifier = 'v'.repeat(43);
  await assert.rejects(
    exchangeAuthorizationCode({
      clientId: CLIENT_ID,
      clientSecret: CLIENT_SECRET,
      code: authorizationCode,
      codeVerifier,
      redirectUri: 'http://127.0.0.1:45123/oauth2/callback',
      fetchImpl: async () => new Response(JSON.stringify({
        error: 'invalid_grant',
        error_description: 'Malformed auth code.'
      }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      })
    }),
    error => {
      assert.ok(error instanceof GoogleOAuthError);
      assert.equal(error.code, 'TOKEN_EXCHANGE_FAILED');
      assert.equal(error.cause, 'invalid_grant');
      assert.match(error.message, /one-time sign-in code/i);
      assert.match(error.message, /invalid_grant: Malformed auth code\./);
      assert.doesNotMatch(error.message, new RegExp(authorizationCode));
      assert.doesNotMatch(error.message, new RegExp(codeVerifier));
      assert.doesNotMatch(error.message, new RegExp(CLIENT_SECRET));
      return true;
    }
  );
});

test('OAuth token exchange preserves the safe missing-client-secret provider diagnostic', async () => {
  await assert.rejects(
    exchangeAuthorizationCode({
      clientId: CLIENT_ID,
      code: 'authorization-code-for-testing',
      codeVerifier: 'v'.repeat(43),
      redirectUri: 'http://127.0.0.1:45123/oauth2/callback',
      fetchImpl: async () => new Response(JSON.stringify({
        error: 'invalid_request',
        error_description: 'client_secret is missing.'
      }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      })
    }),
    error => {
      assert.equal(error.code, 'TOKEN_EXCHANGE_FAILED');
      assert.equal(error.cause, 'invalid_request');
      assert.match(error.message, /Google rejected part of SyncShow’s OAuth request/);
      assert.match(error.message, /invalid_request: client_secret is missing\./);
      assert.doesNotMatch(error.message, /authorization-code-for-testing|v{43}/);
      return true;
    }
  );
});

test('OAuth token exchange discards provider descriptions containing credentials or URLs', async () => {
  const leakedCode = 'SECRET_AUTHORIZATION_CODE_123456789';
  const leakedState = 'SECRET_STATE_1234567890123456789';
  await assert.rejects(
    exchangeAuthorizationCode({
      clientId: CLIENT_ID,
      code: 'authorization-code-for-testing',
      codeVerifier: 'v'.repeat(43),
      redirectUri: 'http://127.0.0.1:45123/oauth2/callback',
      fetchImpl: async () => new Response(JSON.stringify({
        error: 'invalid_grant',
        error_description:
          `code=${leakedCode} state=${leakedState} https://accounts.google.com/callback`
      }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      })
    }),
    error => {
      assert.equal(error.code, 'TOKEN_EXCHANGE_FAILED');
      assert.equal(error.cause, 'invalid_grant');
      assert.match(error.message, /Google reported “invalid_grant”/);
      assert.doesNotMatch(error.message, /code=|state=|https?:\/\//i);
      assert.doesNotMatch(error.message, new RegExp(leakedCode));
      assert.doesNotMatch(error.message, new RegExp(leakedState));
      return true;
    }
  );
});

test('OAuth token exchange does not echo malformed provider errors', async () => {
  const providerSecret = 'REFRESH_TOKEN_VALUE_1234567890123456789';
  await assert.rejects(
    exchangeAuthorizationCode({
      clientId: CLIENT_ID,
      code: 'authorization-code-for-testing',
      codeVerifier: 'v'.repeat(43),
      redirectUri: 'http://127.0.0.1:45123/oauth2/callback',
      fetchImpl: async () => new Response(JSON.stringify({
        error: `invalid_grant\nrefresh_token=${providerSecret}`,
        error_description: `Provider reference ${providerSecret}`
      }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      })
    }),
    error => {
      assert.equal(error.code, 'TOKEN_EXCHANGE_FAILED');
      assert.equal(error.cause, null);
      assert.equal(error.message, 'Google rejected the sign-in response. Start Google sign-in again.');
      assert.doesNotMatch(error.message, new RegExp(providerSecret));
      return true;
    }
  );
});

test('cancelling during token exchange aborts the in-flight credential request', async () => {
  let tokenRequestAborted = false;
  const loopback = fakeLoopback();
  const flow = new GoogleOAuthFlow({
    clientId: CLIENT_ID,
    createServer: loopback.createServer,
    listenServer: loopback.listenServer,
    closeServerImpl: loopback.closeServer,
    openExternal: async value => {
      const authorizationUrl = new URL(value);
      const callback = new URL(authorizationUrl.searchParams.get('redirect_uri'));
      callback.searchParams.set('state', authorizationUrl.searchParams.get('state'));
      callback.searchParams.set('code', 'authorization-code-for-testing');
      callback.searchParams.set('picked_file_ids', FOLDER_ID);
      setImmediate(() => loopback.dispatch(callback).catch(() => {}));
    },
    fetchImpl: async (_input, options) => new Promise((_resolve, reject) => {
      options.signal.addEventListener('abort', () => {
        tokenRequestAborted = true;
        reject(options.signal.reason);
      }, { once: true });
      setImmediate(() => flow.cancel());
    })
  });

  await assert.rejects(
    flow.start(),
    error => error instanceof GoogleOAuthError && error.code === 'CANCELLED'
  );
  assert.equal(tokenRequestAborted, true);
});

test('OAuth flow can be cancelled while the system browser is open', async () => {
  let openedUrl = null;
  const lifecycle = [];
  const loopback = fakeLoopback();
  const flow = new GoogleOAuthFlow({
    clientId: CLIENT_ID,
    createServer: loopback.createServer,
    listenServer: loopback.listenServer,
    closeServerImpl: loopback.closeServer,
    onAuthorizationStateChanged: state => lifecycle.push(state),
    openExternal: async value => {
      openedUrl = value;
      assert.equal(flow.getActiveAuthorizationUrl(), value);
      setImmediate(() => flow.cancel());
    },
    fetchImpl: async () => {
      throw new Error('must not exchange');
    }
  });
  await assert.rejects(
    flow.start(),
    error => error instanceof GoogleOAuthError && error.code === 'CANCELLED'
  );
  assert.match(openedUrl, /^https:\/\/accounts\.google\.com\//);
  assert.equal(flow.getActiveAuthorizationUrl(), null);
  assert.deepEqual(lifecycle, [{ active: true }, { active: false }]);
});

test('OAuth timeout clears the active authorization URL and lifecycle immediately', async () => {
  let timeoutCallback = null;
  let timerCleared = false;
  const lifecycle = [];
  const loopback = fakeLoopback();
  const flow = new GoogleOAuthFlow({
    clientId: CLIENT_ID,
    createServer: loopback.createServer,
    listenServer: loopback.listenServer,
    closeServerImpl: loopback.closeServer,
    timeoutMs: 1000,
    setTimeoutImpl: callback => {
      timeoutCallback = callback;
      return { unref() {} };
    },
    clearTimeoutImpl: () => {
      timerCleared = true;
    },
    onAuthorizationStateChanged: state => lifecycle.push(state),
    openExternal: async value => {
      assert.equal(flow.getActiveAuthorizationUrl(), value);
      setImmediate(() => timeoutCallback());
      return new Promise(() => {});
    },
    fetchImpl: async () => {
      throw new Error('must not exchange');
    }
  });

  await assert.rejects(
    flow.start(),
    error => error instanceof GoogleOAuthError && error.code === 'TIMEOUT'
  );
  assert.equal(flow.getActiveAuthorizationUrl(), null);
  assert.equal(timerCleared, true);
  assert.deepEqual(lifecycle, [{ active: true }, { active: false }]);
});

test('system-browser launch failures are redacted and clear the fallback URL', async () => {
  const lifecycle = [];
  const loopback = fakeLoopback();
  const flow = new GoogleOAuthFlow({
    clientId: CLIENT_ID,
    createServer: loopback.createServer,
    listenServer: loopback.listenServer,
    closeServerImpl: loopback.closeServer,
    onAuthorizationStateChanged: state => lifecycle.push(state),
    openExternal: async value => {
      throw new Error(`browser rejected ${value}`);
    },
    fetchImpl: async () => {
      throw new Error('must not exchange');
    }
  });

  await assert.rejects(
    flow.start(),
    error => {
      assert.equal(error.code, 'BROWSER_FAILED');
      assert.doesNotMatch(error.message, /accounts\.google\.com|client_id|code_challenge/);
      return true;
    }
  );
  assert.equal(flow.getActiveAuthorizationUrl(), null);
  assert.deepEqual(lifecycle, [{ active: true }, { active: false }]);
});
