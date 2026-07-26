'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');

const {
  CommunityClient,
  CommunityClientError,
  DISCOVERY_PATH
} = require('../src/services/community/CommunityClient');

const BASE_URL = 'https://community.example.test/';
const ACCESS_TOKEN = 'community-access-token-0000000001';
const DEVICE_SECRET = 'device-secret-000000000000001';

function json(value, status = 200, headers = {}) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers }
  });
}

function discovery(overrides = {}) {
  return {
    schemaVersion: 1,
    server: { id: 'wotbc-community', name: 'WOTBC Community' },
    integrations: {
      syncShow: {
        schemaVersion: 1,
        apiBaseUrl: `${BASE_URL}api/community/syncshow/v1`,
        deviceAuthorization: true,
        songLibrary: true,
        scopes: ['syncshow:songs:read', 'syncshow:songs:write'],
        ...overrides
      }
    }
  };
}

function songDocument(id = 'amazing-grace', title = 'Amazing Grace') {
  const source = `---\nid: ${id}\ntitle: ${JSON.stringify(title)}\nlanguage: en\n---\n\n^1\nAmazing grace\n`;
  return {
    id,
    source,
    revision: crypto.createHash('sha256').update(source).digest('hex')
  };
}

function remoteSong(overrides = {}) {
  const document = songDocument();
  return {
    syncId: 'amazing-grace',
    syncVersion: 3,
    revision: 'song:amazing-grace:3',
    syncDocuments: [document],
    visibility: 'private',
    publishAt: null,
    archived: false,
    title: 'Amazing Grace',
    alternateTitles: [],
    updatedAt: '2026-07-25T12:00:00.000Z',
    ...overrides
  };
}

test('Community client requires HTTPS except explicit loopback development origins', () => {
  assert.throws(
    () => new CommunityClient({ baseUrl: 'http://community.example.test/' }),
    /HTTPS origin/
  );
  assert.throws(
    () => new CommunityClient({ baseUrl: 'https://user:password@community.example.test/' }),
    /HTTPS origin/
  );
  assert.throws(
    () => new CommunityClient({ baseUrl: 'https://community.example.test/path' }),
    /HTTPS origin/
  );
  assert.doesNotThrow(() => new CommunityClient({
    baseUrl: 'http://127.0.0.1:3000/',
    fetchImpl: async () => json({})
  }));
});

test('discovery pins the SyncShow API and every advertised endpoint to the server origin', async () => {
  const requested = [];
  const client = new CommunityClient({
    baseUrl: BASE_URL,
    fetchImpl: async (input, options) => {
      requested.push({ input, options });
      return json(discovery());
    }
  });
  const found = await client.discover();

  assert.equal(new URL(requested[0].input).pathname, DISCOVERY_PATH);
  assert.equal(requested[0].options.redirect, 'manual');
  assert.equal(found.serverId, 'wotbc-community');
  assert.equal(found.apiBaseUrl, `${BASE_URL}api/community/syncshow/v1`);
  assert.equal(
    new URL(found.endpoints.deviceStart).pathname,
    '/api/community/syncshow/v1/auth/device/start'
  );
  assert.equal(
    new URL(found.endpoints.songs).pathname,
    '/api/community/syncshow/v1/songs'
  );

  const escaped = new CommunityClient({
    baseUrl: BASE_URL,
    fetchImpl: async () => json(discovery({
      endpoints: { songs: 'https://attacker.invalid/steal' }
    }))
  });
  await assert.rejects(
    escaped.discover(),
    error => error instanceof CommunityClientError && error.code === 'INVALID_DISCOVERY'
  );
});

test('redirects and oversized discovery responses are rejected without following them', async () => {
  const redirected = new CommunityClient({
    baseUrl: BASE_URL,
    fetchImpl: async () => new Response('', {
      status: 302,
      headers: { Location: 'https://attacker.invalid/' }
    })
  });
  await assert.rejects(
    redirected.discover(),
    error => error.code === 'UNSAFE_REDIRECT'
  );

  const oversized = new CommunityClient({
    baseUrl: BASE_URL,
    maximumJsonBytes: 1024,
    fetchImpl: async () => new Response('x', {
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': '2048'
      }
    })
  });
  await assert.rejects(
    oversized.discover(),
    error => error.code === 'RESPONSE_TOO_LARGE'
  );
});

test('oversized song pages retry with smaller limits instead of wedging synchronization', async () => {
  const requestedLimits = [];
  const client = new CommunityClient({
    baseUrl: BASE_URL,
    maximumJsonBytes: 1024,
    fetchImpl: async input => {
      const url = new URL(input);
      if (url.pathname === DISCOVERY_PATH) return json(discovery());
      const limit = Number(url.searchParams.get('limit'));
      requestedLimits.push(limit);
      if (limit > 1) {
        return new Response('{}', {
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': '2048'
          }
        });
      }
      return json({
        items: [remoteSong()],
        nextCursor: null,
        hasMore: false
      });
    }
  });

  const page = await client.listSongChanges({
    limit: 100,
    accessToken: ACCESS_TOKEN
  });
  assert.deepEqual(requestedLimits, [100, 50, 25, 12, 6, 3, 1]);
  assert.equal(page.items.length, 1);
  assert.equal(page.items[0].syncId, 'amazing-grace');
});

test('device authorization keeps the device secret and PKCE verifier out of returned UI state', async () => {
  const requests = [];
  const now = new Date('2026-07-25T12:00:00.000Z');
  const client = new CommunityClient({
    baseUrl: BASE_URL,
    now: () => now,
    randomBytes: () => Buffer.alloc(32, 7),
    randomUUID: () => 'authorization-00000001',
    fetchImpl: async (input, options) => {
      const url = new URL(input);
      const body = options.body ? JSON.parse(options.body) : null;
      requests.push({ url, options, body });
      if (url.pathname === DISCOVERY_PATH) return json(discovery());
      if (url.pathname.endsWith('/auth/device/start')) {
        assert.equal(body.email, 'admin@example.com');
        assert.equal(body.deviceName, 'Sanctuary Mac');
        assert.equal(body.codeChallengeMethod, 'S256');
        assert.match(body.codeChallenge, /^[A-Za-z0-9_-]{43}$/);
        assert.equal(Object.hasOwn(body, 'codeVerifier'), false);
        return json({
          deviceId: 'device-authorization-0001',
          deviceSecret: DEVICE_SECRET,
          userCode: 'ABCD-1234',
          verificationUri: `${BASE_URL}admin/syncshow/approve`,
          expiresAt: '2026-07-25T12:10:00.000Z',
          pollIntervalMs: 1000
        }, 201);
      }
      if (url.pathname.endsWith('/auth/device/status')) {
        assert.equal(body.deviceSecret, DEVICE_SECRET);
        return json({ status: 'approved' });
      }
      if (url.pathname.endsWith('/auth/device/token')) {
        assert.equal(body.deviceSecret, DEVICE_SECRET);
        assert.match(body.codeVerifier, /^[A-Za-z0-9_-]{43}$/);
        return json({
          accessToken: ACCESS_TOKEN,
          refreshToken: 'community-refresh-token-000000001',
          expiresAt: '2026-07-25T13:00:00.000Z',
          scopes: ['syncshow:songs:read', 'syncshow:songs:write'],
          account: {
            id: 'admin-1',
            email: 'admin@example.com',
            name: 'Church Admin'
          }
        });
      }
      throw new Error(`Unexpected request: ${url}`);
    }
  });

  const started = await client.startDeviceAuthorization({
    email: 'admin@example.com',
    deviceName: 'Sanctuary Mac',
    scopes: ['syncshow:songs:read', 'syncshow:songs:write']
  });
  assert.deepEqual(started, {
    authorizationId: 'authorization-00000001',
    userCode: 'ABCD-1234',
    verificationUri: `${BASE_URL}admin/syncshow/approve`,
    expiresAt: '2026-07-25T12:10:00.000Z',
    pollIntervalMs: 1000
  });
  assert.equal(JSON.stringify(started).includes(DEVICE_SECRET), false);
  assert.equal(JSON.stringify(started).includes('codeVerifier'), false);

  const polled = await client.pollDeviceAuthorization(started.authorizationId);
  assert.equal(polled.status, 'authorized');
  assert.equal(polled.grant.accessToken, ACCESS_TOKEN);
  assert.equal(JSON.stringify(polled).includes(DEVICE_SECRET), false);
  assert.equal(requests.length, 4);
});

test('a consumed device grant retries the deterministic token exchange after a lost response', async () => {
  const tokenRequests = [];
  let now = new Date('2026-07-25T12:00:00.000Z');
  const client = new CommunityClient({
    baseUrl: BASE_URL,
    now: () => now,
    randomBytes: () => Buffer.alloc(32, 9),
    randomUUID: () => 'authorization-lost-response',
    fetchImpl: async (input, options) => {
      const url = new URL(input);
      const body = options.body ? JSON.parse(options.body) : null;
      if (url.pathname === DISCOVERY_PATH) return json(discovery());
      if (url.pathname.endsWith('/auth/device/start')) {
        return json({
          deviceId: 'device-lost-response-0001',
          deviceSecret: DEVICE_SECRET,
          userCode: 'EFGH-5678',
          verificationUri: `${BASE_URL}api/community/syncshow/v1/auth/device/approve`,
          expiresAt: '2026-07-25T12:10:00.000Z',
          pollIntervalMs: 1000
        });
      }
      if (url.pathname.endsWith('/auth/device/status')) {
        return json({ status: 'consumed', retryAfterMs: 1000 });
      }
      if (url.pathname.endsWith('/auth/device/token')) {
        tokenRequests.push(body);
        return json({
          accessToken: ACCESS_TOKEN,
          refreshToken: null,
          expiresAt: '2027-01-21T12:00:00.000Z',
          scopes: ['syncshow:songs:read', 'syncshow:songs:write'],
          account: {
            id: 'admin-1',
            email: 'admin@example.com',
            name: 'Church Admin'
          }
        });
      }
      throw new Error(`Unexpected request: ${url}`);
    }
  });

  const started = await client.startDeviceAuthorization({
    email: 'admin@example.com',
    deviceName: 'Sanctuary Mac',
    scopes: ['syncshow:songs:read', 'syncshow:songs:write']
  });
  // The first token response could have committed immediately before the
  // displayed approval expiry. The server's authenticated consumed state is
  // still authoritative during its bounded deterministic-retry window.
  now = new Date('2026-07-25T12:10:30.000Z');
  const result = await client.pollDeviceAuthorization(started.authorizationId);
  assert.equal(result.status, 'authorized');
  assert.equal(result.grant.accessToken, ACCESS_TOKEN);
  assert.equal(tokenRequests.length, 1);
  assert.equal(tokenRequests[0].deviceSecret, DEVICE_SECRET);
  assert.match(tokenRequests[0].codeVerifier, /^[A-Za-z0-9_-]{43}$/);
});

test('song updates use SyncShow authentication and exact ETag compare-and-swap', async () => {
  const requests = [];
  const client = new CommunityClient({
    baseUrl: BASE_URL,
    fetchImpl: async (input, options) => {
      const url = new URL(input);
      requests.push({ url, options });
      if (url.pathname === DISCOVERY_PATH) return json(discovery());
      if (options.method === 'PUT') return json(remoteSong({ syncVersion: 4 }));
      return json({ items: [remoteSong()], nextCursor: 'cursor-2', hasMore: false });
    }
  });

  const page = await client.listSongChanges({
    cursor: 'cursor-1',
    limit: 20,
    accessToken: ACCESS_TOKEN
  });
  assert.equal(page.items[0].syncId, 'amazing-grace');
  assert.equal(requests[1].options.headers.Authorization, `SyncShow ${ACCESS_TOKEN}`);
  assert.equal(requests[1].url.searchParams.get('cursor'), 'cursor-1');

  const updated = await client.updateSong({
    syncId: 'amazing-grace',
    syncDocuments: [songDocument()],
    expectedSyncVersion: 3,
    accessToken: ACCESS_TOKEN
  });
  assert.equal(updated.syncVersion, 4);
  assert.equal(requests[2].options.headers['If-Match'], '"song:amazing-grace:3"');
  const body = JSON.parse(requests[2].options.body);
  assert.deepEqual(Object.keys(body), ['syncDocuments']);
  assert.equal(Object.hasOwn(body, 'title'), false);
  assert.equal(Object.hasOwn(body, 'rights'), false);
});

test('remote document checksums are independently verified', async () => {
  const client = new CommunityClient({
    baseUrl: BASE_URL,
    fetchImpl: async input => {
      if (new URL(input).pathname === DISCOVERY_PATH) return json(discovery());
      return json({
        items: [remoteSong({
          syncDocuments: [{ ...songDocument(), revision: '0'.repeat(64) }]
        })],
        nextCursor: null,
        hasMore: false
      });
    }
  });

  await assert.rejects(
    client.listSongChanges({ accessToken: ACCESS_TOKEN }),
    error => error.code === 'INVALID_RESPONSE' && /checksum/.test(error.message)
  );
});

test('legacy bilingual title fields are retained as matchable alternate titles', async () => {
  const client = new CommunityClient({
    baseUrl: BASE_URL,
    fetchImpl: async input => {
      if (new URL(input).pathname === DISCOVERY_PATH) return json(discovery());
      return json({
        items: [remoteSong({
          title: 'Amazing Grace',
          russianTitle: 'О благодать',
          englishTitle: 'Amazing Grace'
        })],
        nextCursor: 'durable-cursor',
        hasMore: false
      });
    }
  });
  const page = await client.listSongChanges({ accessToken: ACCESS_TOKEN });
  assert.deepEqual(page.items[0].alternateTitles, ['О благодать', 'Amazing Grace']);
});

test('scheduled visibility is explicit and revoke treats an already-invalid token as revoked', async () => {
  const requests = [];
  const client = new CommunityClient({
    baseUrl: BASE_URL,
    fetchImpl: async (input, options) => {
      const url = new URL(input);
      requests.push({ url, options });
      if (url.pathname === DISCOVERY_PATH) return json(discovery());
      if (url.pathname.endsWith('/auth/revoke')) return new Response(null, { status: 401 });
      return json(remoteSong({
        syncVersion: 5,
        visibility: 'scheduled-public',
        publishAt: '2026-07-26T17:00:00.000Z'
      }));
    }
  });

  await assert.rejects(
    client.updateSong({
      syncId: 'amazing-grace',
      visibility: 'scheduled-public',
      expectedSyncVersion: 4,
      accessToken: ACCESS_TOKEN
    }),
    error => error.code === 'INVALID_INPUT'
  );
  const updated = await client.updateSong({
    syncId: 'amazing-grace',
    visibility: 'scheduled-public',
    publishAt: '2026-07-26T17:00:00.000Z',
    expectedSyncVersion: 4,
    accessToken: ACCESS_TOKEN
  });
  assert.equal(updated.visibility, 'scheduled-public');
  assert.equal(await client.revokeAccessToken({ accessToken: ACCESS_TOKEN })
    .then(result => result.revoked), true);
});
