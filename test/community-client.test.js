'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const memberSharingFixture =
  require('./fixtures/song-member-sharing-wire-v1.json');

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

function resourceDiscovery(resources) {
  return {
    schemaVersion: 1,
    server: { id: 'wotbc-community', name: 'WOTBC Community' },
    integrations: {
      syncShow: {
        schemaVersion: 2,
        apiBaseUrl: `${BASE_URL}api/community/syncshow/v1`,
        deviceAuthorization: true,
        resources
      }
    }
  };
}

function songResource(scopes = ['syncshow:songs:read', 'syncshow:songs:write']) {
  return {
    schemaVersion: 1,
    endpoint: 'songs',
    scopes
  };
}

function sermonResource() {
  return {
    schemaVersion: 1,
    endpoint: 'sermons',
    scopes: ['syncshow:sermons:read', 'syncshow:sermons:write'],
    sourceObjectScopes: [
      'syncshow:sermon-sources:read',
      'syncshow:sermon-sources:write'
    ]
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

test('member-sharing discovery is exact, same-origin, and version pinned', async () => {
  const cases = [
    {
      descriptor: {
        schemaVersion: 1,
        endpoint: 'song-member-sharing',
        reviewScope: 'community-members',
        fallback: 'songs'
      },
      code: 'INVALID_DISCOVERY'
    },
    {
      descriptor: {
        schemaVersion: 2,
        endpoint: 'song-member-sharing',
        reviewScope: 'community-members'
      },
      code: 'SYNC_UNSUPPORTED'
    },
    {
      descriptor: {
        schemaVersion: 1,
        endpoint: 'song-member-sharing',
        reviewScope: 'everyone'
      },
      code: 'SYNC_UNSUPPORTED'
    },
    {
      descriptor: {
        schemaVersion: 1,
        endpoint: 'https://attacker.invalid/member-sharing',
        reviewScope: 'community-members'
      },
      code: 'INVALID_DISCOVERY'
    }
  ];

  for (const testCase of cases) {
    const client = new CommunityClient({
      baseUrl: BASE_URL,
      fetchImpl: async () => json(resourceDiscovery({
        songs: {
          ...songResource(),
          memberSharing: testCase.descriptor
        }
      }))
    });
    await assert.rejects(
      client.discover(),
      error => error instanceof CommunityClientError
        && error.code === testCase.code
    );
  }
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

test('sermon-only discovery rejects every song method before any song request', async () => {
  const requests = [];
  const client = new CommunityClient({
    baseUrl: BASE_URL,
    fetchImpl: async (input, options) => {
      requests.push({ input, options });
      return json(resourceDiscovery({ sermons: sermonResource() }));
    }
  });
  const calls = [
    () => client.listSongChanges({ accessToken: ACCESS_TOKEN }),
    () => client.getSong({
      syncId: 'amazing-grace',
      accessToken: ACCESS_TOKEN
    }),
    () => client.createSong({
      syncId: 'amazing-grace',
      syncDocuments: [songDocument()],
      idempotencyKey: 'song-create-0001',
      accessToken: ACCESS_TOKEN
    }),
    () => client.updateSong({
      syncId: 'amazing-grace',
      syncDocuments: [songDocument()],
      expectedSyncVersion: 3,
      accessToken: ACCESS_TOKEN
    }),
    () => client.archiveSong({
      syncId: 'amazing-grace',
      expectedSyncVersion: 3,
      accessToken: ACCESS_TOKEN
    })
  ];

  for (const call of calls) {
    await assert.rejects(
      call,
      error => error instanceof CommunityClientError
        && error.code === 'SONG_SYNC_UNSUPPORTED'
    );
  }
  assert.equal(requests.length, 1);
  assert.equal(new URL(requests[0].input).pathname, DISCOVERY_PATH);
});

test('a v2 read-only song lane rejects every write before any song request', async () => {
  const requests = [];
  const client = new CommunityClient({
    baseUrl: BASE_URL,
    fetchImpl: async (input, options) => {
      requests.push({ input, options });
      return json(resourceDiscovery({
        songs: songResource(['syncshow:songs:read'])
      }));
    }
  });
  const calls = [
    () => client.createSong({
      syncId: 'amazing-grace',
      syncDocuments: [songDocument()],
      idempotencyKey: 'song-create-0001',
      accessToken: ACCESS_TOKEN
    }),
    () => client.updateSong({
      syncId: 'amazing-grace',
      syncDocuments: [songDocument()],
      expectedSyncVersion: 3,
      accessToken: ACCESS_TOKEN
    }),
    () => client.archiveSong({
      syncId: 'amazing-grace',
      expectedSyncVersion: 3,
      accessToken: ACCESS_TOKEN
    })
  ];

  for (const call of calls) {
    await assert.rejects(
      call,
      error => error instanceof CommunityClientError
        && error.code === 'SONG_SCOPE_UNAVAILABLE'
    );
  }
  assert.equal(requests.length, 1);
  assert.equal(new URL(requests[0].input).pathname, DISCOVERY_PATH);
});

test('omitted device scopes use advertised read lanes without inventing song access', async () => {
  const requests = [];
  const client = new CommunityClient({
    baseUrl: BASE_URL,
    randomBytes: () => Buffer.alloc(32, 5),
    randomUUID: () => 'authorization-sermon-only',
    fetchImpl: async (input, options) => {
      const url = new URL(input);
      if (url.pathname === DISCOVERY_PATH) {
        return json(resourceDiscovery({ sermons: sermonResource() }));
      }
      requests.push(JSON.parse(options.body));
      return json({
        deviceId: 'device-authorization-sermon-only',
        deviceSecret: DEVICE_SECRET,
        userCode: 'SRMN-1234',
        verificationUri: `${BASE_URL}admin/syncshow/approve`,
        expiresAt: '2026-07-25T12:10:00.000Z',
        pollIntervalMs: 1000
      }, 201);
    }
  });

  await client.startDeviceAuthorization({
    email: 'admin@example.com',
    deviceName: 'Sanctuary Mac'
  });

  assert.deepEqual(requests[0].scopes, [
    'syncshow:sermon-sources:read',
    'syncshow:sermons:read'
  ]);
  assert.equal(requests[0].scopes.some(scope => scope.startsWith('syncshow:songs:')), false);
  assert.equal(requests[0].scopes.some(scope => scope.endsWith(':write')), false);
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

test('a device token must explicitly return non-empty granted scopes', async () => {
  const variants = [
    { label: 'missing' },
    { label: 'null', scopes: null },
    { label: 'empty', scopes: [] }
  ];

  for (const variant of variants) {
    const client = new CommunityClient({
      baseUrl: BASE_URL,
      now: () => new Date('2026-07-25T12:00:00.000Z'),
      randomBytes: () => Buffer.alloc(32, 8),
      randomUUID: () => `authorization-${variant.label}-scopes`,
      fetchImpl: async (input) => {
        const url = new URL(input);
        if (url.pathname === DISCOVERY_PATH) return json(discovery());
        if (url.pathname.endsWith('/auth/device/start')) {
          return json({
            deviceId: `device-${variant.label}-scopes-0001`,
            deviceSecret: DEVICE_SECRET,
            userCode: 'SCOPE-1234',
            verificationUri: `${BASE_URL}admin/syncshow/approve`,
            expiresAt: '2026-07-25T12:10:00.000Z',
            pollIntervalMs: 1000
          }, 201);
        }
        if (url.pathname.endsWith('/auth/device/status')) {
          return json({ status: 'approved' });
        }
        if (url.pathname.endsWith('/auth/device/token')) {
          return json({
            accessToken: ACCESS_TOKEN,
            refreshToken: null,
            expiresAt: '2026-07-25T13:00:00.000Z',
            ...(Object.hasOwn(variant, 'scopes')
              ? { scopes: variant.scopes }
              : {}),
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
      scopes: ['syncshow:songs:read']
    });
    await assert.rejects(
      client.pollDeviceAuthorization(started.authorizationId),
      error => error instanceof CommunityClientError
        && error.code === 'INVALID_RESPONSE'
        && /granted community access scopes/i.test(error.message),
      `${variant.label} token scopes must fail closed`
    );
  }
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

test('ordinary song writes stay private and revoke treats an already-invalid token as revoked', async () => {
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
        visibility: 'private',
        publishAt: null
      }));
    }
  });

  await assert.rejects(
    client.updateSong({
      syncId: 'amazing-grace',
      visibility: 'scheduled-public',
      publishAt: '2026-07-26T17:00:00.000Z',
      expectedSyncVersion: 4,
      accessToken: ACCESS_TOKEN
    }),
    error => error.code === 'SONG_MEMBER_SHARING_TRANSACTION_REQUIRED'
  );
  await assert.rejects(
    client.createSong({
      syncId: 'new-song',
      syncDocuments: [songDocument('new-song', 'New Song')],
      visibility: 'public',
      accessToken: ACCESS_TOKEN
    }),
    error => error.code === 'SONG_MEMBER_SHARING_TRANSACTION_REQUIRED'
  );
  assert.equal(
    requests.filter(request =>
      ['POST', 'PUT'].includes(request.options?.method)).length,
    0
  );

  const updated = await client.updateSong({
    syncId: 'amazing-grace',
    visibility: 'private',
    publishAt: null,
    expectedSyncVersion: 4,
    accessToken: ACCESS_TOKEN
  });
  assert.equal(updated.visibility, 'private');
  assert.equal(await client.revokeAccessToken({ accessToken: ACCESS_TOKEN })
    .then(result => result.revoked), true);
});

test('reviewed song submissions send bounded Community rights fields with the private write', async () => {
  const requests = [];
  const client = new CommunityClient({
    baseUrl: BASE_URL,
    fetchImpl: async (input, options) => {
      const url = new URL(input);
      requests.push({ url, options });
      if (url.pathname === DISCOVERY_PATH) return json(discovery());
      const body = JSON.parse(options.body);
      return json(remoteSong({
        syncId: body.syncId,
        syncVersion: 1,
        syncDocuments: body.syncDocuments,
        visibility: 'private',
        publishAt: null,
        rightsStatus: body.rightsStatus,
        rightsNotes: body.rightsNotes
      }));
    }
  });
  const rightsNotes = [
    'SyncShow reviewed submission for Community admins only.',
    'Evidence: exact permission letter reviewed.',
    `Exact family revision: ${'a'.repeat(64)}`,
    'Reviewed at: 2026-07-25T12:00:00.000Z'
  ].join(' ');

  const created = await client.createSong({
    syncId: 'reviewed-private',
    syncDocuments: [songDocument('reviewed-private', 'Reviewed Private')],
    visibility: 'private',
    rightsStatus: 'permission-granted',
    rightsNotes,
    accessToken: ACCESS_TOKEN,
    idempotencyKey: 'reviewed-private-operation-0001'
  });

  const body = JSON.parse(requests[1].options.body);
  assert.equal(body.visibility, 'private');
  assert.equal(body.rightsStatus, 'permission-granted');
  assert.equal(body.rightsNotes, rightsNotes);
  assert.equal(created.rightsStatus, 'permission-granted');
  assert.equal(created.rightsNotes, rightsNotes);
});

test('reviewed member sharing uses its advertised transaction and confirms current receipt state', async () => {
  const requests = [];
  const client = new CommunityClient({
    baseUrl: BASE_URL,
    fetchImpl: async (input, options) => {
      const url = new URL(input);
      requests.push({ url, options });
      if (url.pathname === DISCOVERY_PATH) {
        return json(resourceDiscovery({
          songs: {
            ...songResource(),
            memberSharing: {
              schemaVersion: 1,
              endpoint: 'song-member-sharing',
              reviewScope: 'community-members'
            }
          }
        }));
      }
      if (options.method === 'POST') {
        return json({ receipt: memberSharingFixture.receipt });
      }
      return json({
        ...remoteSong({
          syncId: memberSharingFixture.songSyncId,
          syncVersion: memberSharingFixture.receipt.songSyncVersion,
          visibility: 'public',
          publishAt: null
        }),
        effectiveVisibility: 'public',
        memberSharing: memberSharingFixture.receipt
      });
    }
  });

  const result = await client.shareSongWithMembers({
    syncId: memberSharingFixture.songSyncId,
    expectedSyncVersion: memberSharingFixture.expectedSongSyncVersion,
    familyRevision: memberSharingFixture.request.familyRevision,
    review: memberSharingFixture.request.review,
    reviewRevision: memberSharingFixture.request.reviewRevision,
    visibility: memberSharingFixture.request.visibility,
    publishAt: memberSharingFixture.request.publishAt,
    accessToken: ACCESS_TOKEN
  });

  assert.equal(result.receipt.receiptRevision,
    memberSharingFixture.expectedReceiptRevision);
  assert.equal(result.song.syncVersion,
    memberSharingFixture.receipt.songSyncVersion);
  assert.equal(result.song.effectiveVisibility, 'public');
  assert.equal(requests.length, 3);
  assert.equal(
    requests[1].url.pathname,
    `/api/community/syncshow/v1/song-member-sharing/${
      memberSharingFixture.songSyncId
    }`
  );
  assert.equal(
    requests[1].options.headers['If-Match'],
    `"song:${memberSharingFixture.songSyncId}:${
      memberSharingFixture.expectedSongSyncVersion
    }"`
  );
  assert.equal(
    requests[1].options.headers['Idempotency-Key'],
    memberSharingFixture.expectedRequestRevision
  );
  assert.deepEqual(
    JSON.parse(requests[1].options.body),
    memberSharingFixture.request
  );
  assert.equal(requests[2].options.method, 'GET');
});

test('song reads refuse effective member access without its exact current receipt', async () => {
  const base = {
    ...remoteSong({
      syncId: memberSharingFixture.songSyncId,
      syncVersion: memberSharingFixture.receipt.songSyncVersion,
      revision:
        `song:${memberSharingFixture.songSyncId}:${
          memberSharingFixture.receipt.songSyncVersion
        }`,
      visibility: 'public',
      publishAt: null
    }),
    effectiveVisibility: 'public',
    memberSharing: memberSharingFixture.receipt
  };
  const cases = [
    {
      ...base,
      memberSharing: null
    },
    {
      ...base,
      syncVersion: base.syncVersion + 1,
      revision: `song:${memberSharingFixture.songSyncId}:${base.syncVersion + 1}`
    }
  ];

  for (const song of cases) {
    const client = new CommunityClient({
      baseUrl: BASE_URL,
      fetchImpl: async input => {
        if (new URL(input).pathname === DISCOVERY_PATH) return json(discovery());
        return json({ items: [song], nextCursor: null, hasMore: false });
      }
    });
    await assert.rejects(
      client.listSongChanges({ accessToken: ACCESS_TOKEN }),
      error => error.code === 'INVALID_RESPONSE'
    );
  }
});

test('older Community servers keep private sync but refuse member sharing without fallback', async () => {
  let nonDiscoveryRequests = 0;
  const client = new CommunityClient({
    baseUrl: BASE_URL,
    fetchImpl: async (input, options) => {
      const url = new URL(input);
      if (url.pathname === DISCOVERY_PATH) return json(discovery());
      nonDiscoveryRequests += 1;
      return json(remoteSong({
        syncId: 'private-only-song',
        syncVersion: 1,
        revision: 'song:private-only-song:1',
        syncDocuments: JSON.parse(options.body).syncDocuments,
        visibility: 'private',
        publishAt: null
      }));
    }
  });

  await assert.rejects(
    client.shareSongWithMembers({
      syncId: memberSharingFixture.songSyncId,
      expectedSyncVersion: memberSharingFixture.expectedSongSyncVersion,
      familyRevision: memberSharingFixture.request.familyRevision,
      review: memberSharingFixture.request.review,
      reviewRevision: memberSharingFixture.request.reviewRevision,
      visibility: 'public',
      publishAt: null,
      accessToken: ACCESS_TOKEN
    }),
    error => error.code === 'SONG_MEMBER_SHARING_UNSUPPORTED'
      && /stage songs privately/.test(error.message)
  );
  assert.equal(nonDiscoveryRequests, 0);

  const privateSong = await client.createSong({
    syncId: 'private-only-song',
    syncDocuments: [songDocument('private-only-song', 'Private Only Song')],
    visibility: 'private',
    publishAt: null,
    accessToken: ACCESS_TOKEN
  });
  assert.equal(privateSong.visibility, 'private');
  assert.equal(nonDiscoveryRequests, 1);
});
