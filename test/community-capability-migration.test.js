'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');

const {
  CommunityClient,
  CommunityClientError,
  DISCOVERY_PATH,
  SERMON_MEDIA_SCOPES,
  SERMON_PUBLICATION_SCOPES
} = require('../src/services/community/CommunityClient');
const {
  CommunityConnectionStore,
  CommunityConnectionStoreError,
  CONNECTION_SCHEMA_VERSION,
  EFFECTIVE_SCOPE_CONNECTION_SCHEMA_VERSION,
  PRE_SERVICE_DOCUMENT_CONNECTION_SCHEMA_VERSION
} = require('../src/services/community/CommunityConnectionStore');
const {
  CommunitySyncStateStore,
  CommunitySyncStateStoreError,
  LEGACY_STATE_SCHEMA_VERSION,
  INLINE_SERMON_CONFLICT_STATE_SCHEMA_VERSION,
  PRE_SHARING_REVIEW_STATE_SCHEMA_VERSION,
  STATE_SCHEMA_VERSION
} = require('../src/services/community/CommunitySyncStateStore');

const BASE_URL = 'https://community.example.test/';
const SONG_SCOPES = [
  'syncshow:songs:read',
  'syncshow:songs:write'
];
const SERMON_SCOPES = [
  'syncshow:sermons:read',
  'syncshow:sermons:write'
];
const SOURCE_SCOPES = [
  'syncshow:sermon-sources:read',
  'syncshow:sermon-sources:write'
];
const ALL_SCOPES = [...SONG_SCOPES, ...SERMON_SCOPES, ...SOURCE_SCOPES];
const SONG_PUBLIC_LINK_SCOPES = [
  'syncshow:song-public-links:read',
  'syncshow:song-public-links:write'
];
const ALL_CURRENT_SCOPES = [...ALL_SCOPES, ...SONG_PUBLIC_LINK_SCOPES];
const SERVICE_DOCUMENT_SCOPES = [
  'syncshow:service-documents:read',
  'syncshow:service-documents:write'
];
const ACCESS_TOKEN = 'community-access-token-secret-000001';
const REFRESH_TOKEN = 'community-refresh-token-secret-0001';
const SAVED_SHARING_REVIEW = Object.freeze({
  scope: 'community-members',
  basis: 'public-domain',
  evidence: '',
  validUntil: null,
  reviewedAt: '2026-07-27T11:00:00.000Z',
  familyRevision: 'd'.repeat(64)
});

function json(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json' }
  });
}

function discovery(syncShow = {}) {
  return {
    schemaVersion: 1,
    server: { id: 'wotbc-community', name: 'WOTBC Community' },
    integrations: {
      syncShow: {
        schemaVersion: 1,
        apiBaseUrl: `${BASE_URL}api/community/syncshow/v1`,
        deviceAuthorization: true,
        songLibrary: true,
        scopes: SONG_SCOPES,
        ...syncShow
      }
    }
  };
}

function resourceDiscovery(resources, syncShow = {}) {
  return {
    schemaVersion: 1,
    server: { id: 'wotbc-community', name: 'WOTBC Community' },
    integrations: {
      syncShow: {
        schemaVersion: 2,
        apiBaseUrl: `${BASE_URL}api/community/syncshow/v1`,
        deviceAuthorization: true,
        resources,
        ...syncShow
      }
    }
  };
}

function songResource(overrides = {}) {
  return {
    schemaVersion: 1,
    endpoint: 'songs',
    scopes: SONG_SCOPES,
    ...overrides
  };
}

function sermonResource(overrides = {}) {
  return {
    schemaVersion: 1,
    endpoint: 'sermons',
    scopes: SERMON_SCOPES,
    sourceObjectScopes: SOURCE_SCOPES,
    ...overrides
  };
}

function songPublicLinkResource(overrides = {}) {
  return {
    schemaVersion: 1,
    endpoint: 'song-public-links',
    publicBaseUrl: '/community/songs/shared/',
    scopes: SONG_PUBLIC_LINK_SCOPES,
    ...overrides
  };
}

function sermonPublicationResource(overrides = {}) {
  return {
    schemaVersion: 1,
    endpoint: 'sermon-publications',
    scopes: SERMON_PUBLICATION_SCOPES,
    ...overrides
  };
}

function clientFor(payload, requests = []) {
  return new CommunityClient({
    baseUrl: BASE_URL,
    fetchImpl: async (input, options) => {
      requests.push({ input, options });
      if (new URL(input).pathname === DISCOVERY_PATH) return json(payload);
      throw new Error(`Unexpected request: ${input}`);
    }
  });
}

async function tempDirectory(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'syncshow-capability-migration-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return fs.realpath(directory);
}

function safeStorage() {
  return {
    isEncryptionAvailable: () => true,
    encryptString: value => Buffer.from(`protected:${Buffer.from(value).toString('base64')}`),
    decryptString: value => {
      const serialized = value.toString();
      if (!serialized.startsWith('protected:')) throw new Error('not encrypted');
      return Buffer.from(serialized.slice('protected:'.length), 'base64').toString();
    }
  };
}

function connectionInput(overrides = {}) {
  return {
    serverId: 'wotbc-community',
    serverName: 'WOTBC Community',
    baseUrl: BASE_URL,
    apiBaseUrl: `${BASE_URL}api/community/syncshow/v1`,
    account: {
      id: 'admin-1',
      email: 'admin@example.com',
      name: 'Church Admin'
    },
    scopes: ALL_SCOPES,
    accessToken: ACCESS_TOKEN,
    refreshToken: REFRESH_TOKEN,
    expiresAt: '2026-07-27T13:00:00.000Z',
    ...overrides
  };
}

test('legacy discovery keeps root scopes song-only and does not invent sermon support', async () => {
  const found = await clientFor(discovery()).discover();

  assert.equal(found.schemaVersion, 1);
  assert.deepEqual(found.songScopes, [...SONG_SCOPES].sort());
  assert.deepEqual(found.scopes, [...SONG_SCOPES].sort());
  assert.equal(found.resources.songs.schemaVersion, 1);
  assert.deepEqual(found.resources.songs.scopes, [...SONG_SCOPES].sort());
  assert.equal(
    new URL(found.resources.songs.endpoint).pathname,
    '/api/community/syncshow/v1/songs'
  );
  assert.equal(found.resources.sermons, null);
  assert.equal(found.resources.sermonPublications, null);
  assert.deepEqual(found.capabilities, {
    deviceAuthorization: true,
    songs: true,
    songPublicLinks: false,
    sermons: false,
    sermonSources: false,
    sermonPublications: false,
    sermonMedia: false,
    servicePlans: false,
    serviceDocuments: false
  });
  assert.equal(
    new URL(found.endpoints.songs).pathname,
    '/api/community/syncshow/v1/songs'
  );
});

test('protocol v2 accepts a sermon-only resource without inventing a song lane', async () => {
  const found = await clientFor(resourceDiscovery({
    sermons: sermonResource()
  }, {
    // Protocol-v2 nested resources are authoritative even if stale v1 fields
    // remain during a server rollout.
    songLibrary: true,
    scopes: SONG_SCOPES
  })).discover();

  assert.equal(found.schemaVersion, 2);
  assert.deepEqual(found.songScopes, []);
  assert.deepEqual(
    found.scopes,
    [...SERMON_SCOPES, ...SOURCE_SCOPES].sort()
  );
  assert.equal(found.resources.songs, null);
  assert.equal(found.endpoints.songs, null);
  assert.equal(
    found.resources.sermons.endpoint,
    `${BASE_URL}api/community/syncshow/v1/sermons`
  );
  assert.deepEqual(found.capabilities, {
    deviceAuthorization: true,
    songs: false,
    songPublicLinks: false,
    sermons: true,
    sermonSources: true,
    sermonPublications: false,
    sermonMedia: false,
    servicePlans: false,
    serviceDocuments: false
  });
});

test('protocol v2 normalizes song-only and combined resource lanes independently', async () => {
  const songOnly = await clientFor(resourceDiscovery({
    songs: songResource({
      endpoint: 'library/songs',
      scopes: ['syncshow:songs:read']
    })
  })).discover();

  assert.deepEqual(songOnly.songScopes, ['syncshow:songs:read']);
  assert.deepEqual(songOnly.scopes, ['syncshow:songs:read']);
  assert.equal(
    songOnly.resources.songs.endpoint,
    `${BASE_URL}api/community/syncshow/v1/library/songs`
  );
  assert.equal(songOnly.resources.sermons, null);
  assert.equal(songOnly.endpoints.songs, songOnly.resources.songs.endpoint);
  assert.deepEqual(songOnly.capabilities, {
    deviceAuthorization: true,
    songs: true,
    songPublicLinks: false,
    sermons: false,
    sermonSources: false,
    sermonPublications: false,
    sermonMedia: false,
    servicePlans: false,
    serviceDocuments: false
  });

  const combined = await clientFor(resourceDiscovery({
    songs: songResource(),
    sermons: sermonResource({ sourceObjectScopes: undefined })
  })).discover();

  assert.deepEqual(
    combined.scopes,
    [...SONG_SCOPES, ...SERMON_SCOPES].sort()
  );
  assert.equal(combined.resources.songs.schemaVersion, 1);
  assert.equal(combined.resources.sermons.schemaVersion, 1);
  assert.deepEqual(combined.resources.sermons.sourceObjectScopes, []);
  assert.deepEqual(combined.capabilities, {
    deviceAuthorization: true,
    songs: true,
    songPublicLinks: false,
    sermons: true,
    sermonSources: false,
    sermonPublications: false,
    sermonMedia: false,
    servicePlans: false,
    serviceDocuments: false
  });
});

test('protocol v2 advertises song public links as a separate same-origin scoped lane', async () => {
  const found = await clientFor(resourceDiscovery({
    songs: songResource(),
    songPublicLinks: songPublicLinkResource({
      endpoint: 'sharing/song-links',
      publicBaseUrl: '/shared/songs'
    })
  })).discover();

  assert.deepEqual(found.scopes, [
    ...SONG_PUBLIC_LINK_SCOPES,
    ...SONG_SCOPES
  ].sort());
  assert.deepEqual(found.resources.songPublicLinks, {
    schemaVersion: 1,
    endpoint: `${BASE_URL}api/community/syncshow/v1/sharing/song-links`,
    publicBaseUrl: `${BASE_URL}shared/songs/`,
    scopes: [...SONG_PUBLIC_LINK_SCOPES].sort()
  });
  assert.equal(found.capabilities.songPublicLinks, true);
  assert.equal(found.capabilities.songs, true);

  const legacy = await clientFor(discovery({
    resources: {
      songPublicLinks: songPublicLinkResource()
    }
  })).discover();
  assert.equal(legacy.resources.songPublicLinks, null);
  assert.equal(legacy.capabilities.songPublicLinks, false);
  assert.deepEqual(legacy.scopes, [...SONG_SCOPES].sort());
});

test('protocol v2 advertises sermon publications as a dependent read-only lane', async () => {
  const found = await clientFor(resourceDiscovery({
    sermons: sermonResource({
      scopes: ['syncshow:sermons:read'],
      sourceObjectScopes: []
    }),
    sermonPublications: sermonPublicationResource({
      endpoint: 'publication-state'
    })
  })).discover();

  assert.deepEqual(SERMON_PUBLICATION_SCOPES, [
    'syncshow:sermon-publications:read'
  ]);
  assert.deepEqual(found.scopes, [
    'syncshow:sermon-publications:read',
    'syncshow:sermons:read'
  ].sort());
  assert.deepEqual(found.resources.sermonPublications, {
    schemaVersion: 1,
    endpoint: `${BASE_URL}api/community/syncshow/v1/publication-state`,
    scopes: ['syncshow:sermon-publications:read']
  });
  assert.equal(found.capabilities.sermonPublications, true);
  assert.equal(found.capabilities.sermons, true);
  assert.equal(Object.isFrozen(found.resources.sermonPublications), true);

  const legacy = await clientFor(discovery({
    resources: {
      sermons: sermonResource({
        scopes: ['syncshow:sermons:read'],
        sourceObjectScopes: []
      }),
      sermonPublications: sermonPublicationResource()
    }
  })).discover();
  assert.equal(legacy.resources.sermonPublications, null);
  assert.equal(legacy.capabilities.sermonPublications, false);
  assert.equal(
    legacy.scopes.includes('syncshow:sermon-publications:read'),
    false
  );
});

test('nested sermon discovery combines validated resource grants without changing the root contract', async () => {
  const found = await clientFor(discovery({
    resources: {
      sermons: sermonResource(),
      futureResource: { ignoredByThisClient: true }
    }
  })).discover();

  assert.deepEqual(found.songScopes, [...SONG_SCOPES].sort());
  assert.deepEqual(found.scopes, [...ALL_SCOPES].sort());
  assert.equal(found.resources.sermons.schemaVersion, 1);
  assert.equal(
    found.resources.sermons.endpoint,
    `${BASE_URL}api/community/syncshow/v1/sermons`
  );
  assert.deepEqual(found.resources.sermons.scopes, [...SERMON_SCOPES].sort());
  assert.deepEqual(
    found.resources.sermons.sourceObjectScopes,
    [...SOURCE_SCOPES].sort()
  );
  assert.equal(Object.hasOwn(found.resources, 'futureResource'), false);
});

test('combined sermon and source-object grants can be requested through device authorization', async () => {
  const requests = [];
  const client = new CommunityClient({
    baseUrl: BASE_URL,
    randomBytes: () => Buffer.alloc(32, 3),
    randomUUID: () => 'authorization-00000002',
    fetchImpl: async (input, options) => {
      const url = new URL(input);
      if (url.pathname === DISCOVERY_PATH) {
        return json(discovery({ resources: { sermons: sermonResource() } }));
      }
      requests.push(JSON.parse(options.body));
      return json({
        deviceId: 'device-authorization-0002',
        deviceSecret: 'device-secret-000000000000002',
        userCode: 'ABCD-5678',
        verificationUri: `${BASE_URL}admin/syncshow/approve`,
        expiresAt: '2026-07-27T12:10:00.000Z',
        pollIntervalMs: 1000
      }, 201);
    }
  });

  await client.startDeviceAuthorization({
    email: 'admin@example.com',
    deviceName: 'Sanctuary Mac',
    scopes: ALL_SCOPES
  });
  assert.deepEqual(requests[0].scopes, [...ALL_SCOPES].sort());
});

test('hostile or dependency-invalid nested sermon capabilities fail closed', async () => {
  const cases = [
    {
      value: resourceDiscovery({}),
      code: 'SYNC_UNSUPPORTED'
    },
    {
      value: resourceDiscovery(
        { sermons: sermonResource() },
        { deviceAuthorization: undefined }
      ),
      code: 'SYNC_UNSUPPORTED'
    },
    {
      value: resourceDiscovery({
        songs: songResource({ endpoint: '../songs' })
      }),
      code: 'INVALID_DISCOVERY'
    },
    {
      value: resourceDiscovery({
        songs: songResource({ endpoint: 'https://attacker.invalid/songs' })
      }),
      code: 'INVALID_DISCOVERY'
    },
    {
      value: resourceDiscovery({
        songs: songResource({ endpoint: '/api/community/songs' })
      }),
      code: 'INVALID_DISCOVERY'
    },
    {
      value: resourceDiscovery({
        songs: songResource({ endpoint: 'songs?credential=leak' })
      }),
      code: 'INVALID_DISCOVERY'
    },
    {
      value: resourceDiscovery({
        songs: songResource({ endpoint: 'songs#fragment' })
      }),
      code: 'INVALID_DISCOVERY'
    },
    {
      value: resourceDiscovery({
        songs: songResource({
          endpoint: 'https://user:password@community.example.test/api/community/syncshow/v1/songs'
        })
      }),
      code: 'INVALID_DISCOVERY'
    },
    {
      value: resourceDiscovery({
        songs: songResource({ scopes: ['syncshow:songs:write'] })
      }),
      code: 'INVALID_DISCOVERY'
    },
    {
      value: resourceDiscovery({
        songs: songResource({ schemaVersion: 2 })
      }),
      code: 'SYNC_UNSUPPORTED'
    },
    {
      value: resourceDiscovery([], {}),
      code: 'INVALID_DISCOVERY'
    },
    {
      value: resourceDiscovery({ songs: songResource() }, { schemaVersion: 3 }),
      code: 'SYNC_UNSUPPORTED'
    },
    {
      value: discovery({ scopes: [...SONG_SCOPES, 'syncshow:sermons:read'] }),
      code: 'INVALID_DISCOVERY'
    },
    {
      value: discovery({ endpoints: [] }),
      code: 'INVALID_DISCOVERY'
    },
    {
      value: discovery({ resources: [] }),
      code: 'INVALID_DISCOVERY'
    },
    {
      value: discovery({ resources: { sermons: [] } }),
      code: 'INVALID_DISCOVERY'
    },
    {
      value: discovery({
        resources: { sermons: sermonResource({ schemaVersion: 2 }) }
      }),
      code: 'SYNC_UNSUPPORTED'
    },
    {
      value: discovery({
        resources: { sermons: sermonResource({ endpoint: null }) }
      }),
      code: 'INVALID_DISCOVERY'
    },
    {
      value: discovery({
        resources: {
          sermons: sermonResource({ endpoint: 'https://attacker.invalid/sermons' })
        }
      }),
      code: 'INVALID_DISCOVERY'
    },
    {
      value: discovery({
        resources: {
          sermons: sermonResource({ endpoint: '../sermons' })
        }
      }),
      code: 'INVALID_DISCOVERY'
    },
    {
      value: discovery({
        resources: {
          sermons: sermonResource({ endpoint: 'sermons?cursor=attacker' })
        }
      }),
      code: 'INVALID_DISCOVERY'
    },
    {
      value: discovery({
        resources: {
          sermons: sermonResource({ scopes: ['syncshow:sermons:write'] })
        }
      }),
      code: 'INVALID_DISCOVERY'
    },
    {
      value: discovery({
        resources: {
          sermons: sermonResource({
            scopes: ['syncshow:sermons:read'],
            sourceObjectScopes: ['syncshow:sermon-sources:write']
          })
        }
      }),
      code: 'INVALID_DISCOVERY'
    },
    {
      value: discovery({
        resources: {
          sermons: sermonResource({
            sourceObjectScopes: ['syncshow:songs:read']
          })
        }
      }),
      code: 'INVALID_DISCOVERY'
    },
    {
      value: resourceDiscovery({
        songPublicLinks: songPublicLinkResource()
      }),
      code: 'INVALID_DISCOVERY'
    },
    {
      value: resourceDiscovery({
        songs: songResource(),
        songPublicLinks: songPublicLinkResource({
          endpoint: '../song-public-links'
        })
      }),
      code: 'INVALID_DISCOVERY'
    },
    {
      value: resourceDiscovery({
        songs: songResource(),
        songPublicLinks: songPublicLinkResource({
          endpoint: 'https://attacker.invalid/song-public-links'
        })
      }),
      code: 'INVALID_DISCOVERY'
    },
    {
      value: resourceDiscovery({
        songs: songResource(),
        songPublicLinks: songPublicLinkResource({
          publicBaseUrl: 'https://attacker.invalid/shared/song'
        })
      }),
      code: 'INVALID_DISCOVERY'
    },
    {
      value: resourceDiscovery({
        songs: songResource(),
        songPublicLinks: songPublicLinkResource({
          publicBaseUrl: '/community/songs/shared/?token=leak'
        })
      }),
      code: 'INVALID_DISCOVERY'
    },
    {
      value: resourceDiscovery({
        songs: songResource(),
        songPublicLinks: songPublicLinkResource({
          publicBaseUrl: '/'
        })
      }),
      code: 'INVALID_DISCOVERY'
    },
    {
      value: resourceDiscovery({
        songs: songResource(),
        songPublicLinks: songPublicLinkResource({
          scopes: ['syncshow:song-public-links:write']
        })
      }),
      code: 'INVALID_DISCOVERY'
    },
    {
      value: resourceDiscovery({
        sermonPublications: sermonPublicationResource()
      }),
      code: 'INVALID_DISCOVERY'
    },
    {
      value: resourceDiscovery({
        sermons: sermonResource({
          scopes: ['syncshow:sermons:read'],
          sourceObjectScopes: []
        }),
        sermonPublications: sermonPublicationResource({ scopes: [] })
      }),
      code: 'INVALID_DISCOVERY'
    },
    {
      value: resourceDiscovery({
        sermons: sermonResource({
          scopes: ['syncshow:sermons:read'],
          sourceObjectScopes: []
        }),
        sermonPublications: sermonPublicationResource({
          scopes: ['syncshow:sermon-publications:write']
        })
      }),
      code: 'INVALID_DISCOVERY'
    },
    {
      value: resourceDiscovery({
        sermons: sermonResource({
          scopes: ['syncshow:sermons:read'],
          sourceObjectScopes: []
        }),
        sermonPublications: sermonPublicationResource({
          scopes: [
            'syncshow:sermon-publications:read',
            'syncshow:sermon-publications:read'
          ]
        })
      }),
      code: 'INVALID_DISCOVERY'
    },
    {
      value: resourceDiscovery({
        sermons: sermonResource({
          scopes: ['syncshow:sermons:read'],
          sourceObjectScopes: []
        }),
        sermonPublications: sermonPublicationResource({ schemaVersion: 2 })
      }),
      code: 'SYNC_UNSUPPORTED'
    },
    {
      value: resourceDiscovery({
        sermons: sermonResource({
          scopes: ['syncshow:sermons:read'],
          sourceObjectScopes: []
        }),
        sermonPublications: sermonPublicationResource({
          endpoint: '../sermon-publications'
        })
      }),
      code: 'INVALID_DISCOVERY'
    }
  ];

  for (const scenario of cases) {
    await assert.rejects(
      clientFor(scenario.value).discover(),
      error => error instanceof CommunityClientError && error.code === scenario.code
    );
  }
});

test('current connection schema derives sanitized effective capabilities for all six grants', async t => {
  const root = await tempDirectory(t);
  const storageRoot = path.join(root, 'connections');
  const store = new CommunityConnectionStore({
    storageRoot,
    safeStorage: safeStorage(),
    randomUUID: () => 'connection-00000020',
    now: () => new Date('2026-07-27T12:00:00.000Z')
  });
  const saved = await store.saveConnection(connectionInput());

  assert.equal(saved.canReadSongs, true);
  assert.equal(saved.canWriteSongs, true);
  assert.equal(saved.canReadSermons, true);
  assert.equal(saved.canWriteSermons, true);
  assert.equal(saved.canReadSermonSources, true);
  assert.equal(saved.canWriteSermonSources, true);
  assert.equal(saved.canReadSermonPublications, false);
  assert.equal(saved.canReadSongPublicLinks, false);
  assert.equal(saved.canWriteSongPublicLinks, false);
  assert.equal(saved.canReadServicePlans, false);
  assert.equal(saved.canReadServiceDocuments, false);
  assert.equal(saved.canWriteServiceDocuments, false);
  assert.equal(saved.apiBaseUrl, `${BASE_URL}api/community/syncshow/v1`);
  assert.deepEqual(saved.advertisedScopes, [...ALL_SCOPES].sort());
  assert.deepEqual(saved.effectiveScopes, [...ALL_SCOPES].sort());
  assert.equal(Object.hasOwn(saved, 'accessToken'), false);
  assert.equal(
    JSON.parse(await fs.readFile(path.join(storageRoot, 'connections.json'), 'utf8'))
      .schemaVersion,
    CONNECTION_SCHEMA_VERSION
  );
});

test('service-plan reads require an explicit fresh grant and have no song or sermon dependency', async t => {
  const root = await tempDirectory(t);
  const store = new CommunityConnectionStore({
    storageRoot: path.join(root, 'connections'),
    safeStorage: safeStorage(),
    randomUUID: () => 'connection-service-plans-01',
    now: () => new Date('2026-07-27T12:00:00.000Z')
  });
  const servicePlanScope = ['syncshow:service-plans:read'];
  const approved = await store.saveConnection(connectionInput({
    id: 'connection-service-plans-01',
    scopes: servicePlanScope,
    advertisedScopes: servicePlanScope
  }));

  assert.equal(approved.canReadServicePlans, true);
  assert.equal(approved.canReadSongs, false);
  assert.equal(approved.canReadSermons, false);
  assert.deepEqual(approved.effectiveScopes, servicePlanScope);

  const oldGrant = await store.saveConnection(connectionInput({
    id: 'connection-service-plans-02',
    account: {
      id: 'admin-2',
      email: 'other@example.com',
      name: 'Other Admin'
    },
    scopes: ['syncshow:songs:read'],
    advertisedScopes: [
      'syncshow:songs:read',
      'syncshow:service-plans:read'
    ]
  }));
  assert.equal(oldGrant.canReadSongs, true);
  assert.equal(oldGrant.canReadServicePlans, false);
  assert.deepEqual(oldGrant.effectiveScopes, ['syncshow:songs:read']);
});

test('shared-service writes require read access and a fresh schema-v5 grant', async t => {
  const root = await tempDirectory(t);
  const storageRoot = path.join(root, 'connections');
  const options = {
    storageRoot,
    safeStorage: safeStorage(),
    randomUUID: () => 'connection-service-documents-01',
    now: () => new Date('2026-08-13T19:00:00.000Z')
  };
  const store = new CommunityConnectionStore(options);
  const approved = await store.saveConnection(connectionInput({
    id: 'connection-service-documents-01',
    scopes: SERVICE_DOCUMENT_SCOPES,
    advertisedScopes: SERVICE_DOCUMENT_SCOPES
  }));

  assert.equal(approved.canReadServiceDocuments, true);
  assert.equal(approved.canWriteServiceDocuments, true);
  assert.equal(approved.canReadSongs, false);
  assert.equal(approved.canReadSermons, false);

  await assert.rejects(
    store.saveConnection(connectionInput({
      id: 'connection-service-documents-02',
      scopes: ['syncshow:service-documents:write'],
      advertisedScopes: ['syncshow:service-documents:write']
    })),
    error => error instanceof CommunityConnectionStoreError
      && error.code === 'INVALID_CONNECTION'
  );

  const storePath = path.join(storageRoot, 'connections.json');
  const hostile = JSON.parse(await fs.readFile(storePath, 'utf8'));
  hostile.schemaVersion = PRE_SERVICE_DOCUMENT_CONNECTION_SCHEMA_VERSION;
  await fs.writeFile(storePath, `${JSON.stringify(hostile, null, 2)}\n`, {
    mode: 0o600
  });
  await assert.rejects(
    new CommunityConnectionStore(options).listConnections(),
    error => error instanceof CommunityConnectionStoreError
      && error.code === 'INVALID_CONNECTION'
  );
});

test('current connection schema keeps sermon-publication reads dependent and effective', async t => {
  const root = await tempDirectory(t);
  let now = new Date('2026-07-27T12:00:00.000Z');
  const store = new CommunityConnectionStore({
    storageRoot: path.join(root, 'connections'),
    safeStorage: safeStorage(),
    randomUUID: () => 'connection-publications-01',
    now: () => now
  });
  const scopes = [
    'syncshow:sermons:read',
    ...SERMON_PUBLICATION_SCOPES
  ];
  const saved = await store.saveConnection(connectionInput({
    scopes,
    advertisedScopes: scopes
  }));

  assert.equal(saved.canReadSermons, true);
  assert.equal(saved.canWriteSermons, false);
  assert.equal(saved.canReadSermonPublications, true);
  assert.deepEqual(saved.effectiveScopes, [...scopes].sort());

  now = new Date('2026-07-27T12:05:00.000Z');
  const withdrawn = await store.updateAdvertisedScopes(saved.id, {
    advertisedScopes: ['syncshow:sermons:read'],
    expectedUpdatedAt: saved.updatedAt
  });
  assert.equal(withdrawn.canReadSermons, true);
  assert.equal(withdrawn.canReadSermonPublications, false);
  assert.deepEqual(withdrawn.scopes, [...scopes].sort());

  await assert.rejects(
    store.updateAdvertisedScopes(saved.id, {
      advertisedScopes: [...SERMON_PUBLICATION_SCOPES],
      expectedUpdatedAt: withdrawn.updatedAt
    }),
    error => error instanceof CommunityConnectionStoreError
      && error.code === 'INVALID_CONNECTION'
  );
});

test('current connection schema keeps song public-link authority separate and fail-closed', async t => {
  const root = await tempDirectory(t);
  let now = new Date('2026-07-27T12:00:00.000Z');
  const store = new CommunityConnectionStore({
    storageRoot: path.join(root, 'connections'),
    safeStorage: safeStorage(),
    randomUUID: () => 'connection-public-links-01',
    now: () => now
  });
  const saved = await store.saveConnection(connectionInput({
    scopes: ALL_CURRENT_SCOPES,
    advertisedScopes: ALL_CURRENT_SCOPES
  }));

  assert.equal(saved.canReadSongPublicLinks, true);
  assert.equal(saved.canWriteSongPublicLinks, true);
  assert.deepEqual(saved.effectiveScopes, [...ALL_CURRENT_SCOPES].sort());

  now = new Date('2026-07-27T12:05:00.000Z');
  const downgraded = await store.updateAdvertisedScopes(saved.id, {
    advertisedScopes: ALL_SCOPES,
    expectedUpdatedAt: saved.updatedAt
  });
  assert.equal(downgraded.canReadSongPublicLinks, false);
  assert.equal(downgraded.canWriteSongPublicLinks, false);
  assert.equal(downgraded.canReadSongs, true);
  assert.equal(downgraded.canWriteSongs, true);
  assert.deepEqual(
    downgraded.scopes,
    [...ALL_CURRENT_SCOPES].sort(),
    'capability withdrawal must not rewrite the approved grant'
  );
});

test('combined grant downgraded to sermon-only keeps sermons effective and disables songs', async t => {
  const root = await tempDirectory(t);
  const store = new CommunityConnectionStore({
    storageRoot: path.join(root, 'connections'),
    safeStorage: safeStorage(),
    randomUUID: () => 'connection-00000026',
    now: () => new Date('2026-07-27T12:00:00.000Z')
  });
  const saved = await store.saveConnection(connectionInput({
    advertisedScopes: SERMON_SCOPES
  }));

  assert.deepEqual(saved.scopes, [...ALL_SCOPES].sort(), 'the approved grant is preserved');
  assert.deepEqual(saved.advertisedScopes, [...SERMON_SCOPES].sort());
  assert.deepEqual(saved.effectiveScopes, [...SERMON_SCOPES].sort());
  assert.equal(saved.canReadSongs, false);
  assert.equal(saved.canWriteSongs, false);
  assert.equal(saved.canReadSermons, true);
  assert.equal(saved.canWriteSermons, true);
  assert.equal(saved.canReadSermonSources, false);
});

test('sermon-only connections are valid and never invent a song lane', async t => {
  const root = await tempDirectory(t);
  const store = new CommunityConnectionStore({
    storageRoot: path.join(root, 'connections'),
    safeStorage: safeStorage(),
    randomUUID: () => 'connection-00000027'
  });
  const saved = await store.saveConnection(connectionInput({
    scopes: SERMON_SCOPES,
    advertisedScopes: SERMON_SCOPES
  }));

  assert.equal(saved.canReadSongs, false);
  assert.equal(saved.canWriteSongs, false);
  assert.equal(saved.canReadSermons, true);
  assert.equal(saved.canWriteSermons, true);
  assert.deepEqual(saved.effectiveScopes, [...SERMON_SCOPES].sort());
});

test('advertised-scope updates change effective lanes without rewriting grants', async t => {
  const root = await tempDirectory(t);
  let now = new Date('2026-07-27T12:00:00.000Z');
  const store = new CommunityConnectionStore({
    storageRoot: path.join(root, 'connections'),
    safeStorage: safeStorage(),
    randomUUID: () => 'connection-00000028',
    now: () => now
  });
  const saved = await store.saveConnection(connectionInput());
  now = new Date('2026-07-27T12:05:00.000Z');
  const downgraded = await store.updateAdvertisedScopes(saved.id, {
    advertisedScopes: SERMON_SCOPES,
    expectedUpdatedAt: saved.updatedAt
  });

  assert.deepEqual(downgraded.scopes, [...ALL_SCOPES].sort());
  assert.deepEqual(downgraded.effectiveScopes, [...SERMON_SCOPES].sort());
  assert.equal(downgraded.canReadSongs, false);
  assert.equal(downgraded.canReadSermons, true);
  assert.equal((await store.getConnection(saved.id)).accessToken, ACCESS_TOKEN);

  await assert.rejects(
    store.updateAdvertisedScopes(saved.id, {
      advertisedScopes: SONG_SCOPES,
      expectedUpdatedAt: saved.updatedAt
    }),
    error => error instanceof CommunityConnectionStoreError
      && error.code === 'CONNECTION_CONFLICT'
  );

  now = new Date('2026-07-27T12:10:00.000Z');
  const unavailable = await store.updateAdvertisedScopes(saved.id, {
    advertisedScopes: [],
    expectedUpdatedAt: downgraded.updatedAt
  });
  assert.deepEqual(unavailable.scopes, [...ALL_SCOPES].sort());
  assert.deepEqual(unavailable.advertisedScopes, []);
  assert.deepEqual(unavailable.effectiveScopes, []);
  assert.equal(unavailable.canReadSongs, false);
  assert.equal(unavailable.canReadSermons, false);
});

test('song-only grant keeps songs effective when sermons are newly advertised but unapproved', async t => {
  const root = await tempDirectory(t);
  const store = new CommunityConnectionStore({
    storageRoot: path.join(root, 'connections'),
    safeStorage: safeStorage(),
    randomUUID: () => 'connection-00000029'
  });
  const saved = await store.saveConnection(connectionInput({
    scopes: SONG_SCOPES,
    advertisedScopes: SONG_SCOPES
  }));
  const expanded = await store.updateAdvertisedScopes(saved.id, {
    advertisedScopes: [...SONG_SCOPES, ...SERMON_SCOPES],
    expectedUpdatedAt: saved.updatedAt
  });

  assert.deepEqual(expanded.scopes, [...SONG_SCOPES].sort());
  assert.deepEqual(
    expanded.advertisedScopes,
    [...SONG_SCOPES, ...SERMON_SCOPES].sort()
  );
  assert.deepEqual(expanded.effectiveScopes, [...SONG_SCOPES].sort());
  assert.equal(expanded.canReadSongs, true);
  assert.equal(expanded.canWriteSongs, true);
  assert.equal(expanded.canReadSermons, false);
  assert.equal(expanded.canWriteSermons, false);
});

test('connection grants enforce sermon and source-object scope dependencies', async t => {
  const root = await tempDirectory(t);
  const store = new CommunityConnectionStore({
    storageRoot: path.join(root, 'connections'),
    safeStorage: safeStorage(),
    randomUUID: () => 'connection-00000021'
  });
  const invalidScopes = [
    ['syncshow:sermons:write'],
    ['syncshow:sermons:read', 'syncshow:sermon-sources:write'],
    [
      'syncshow:sermons:read',
      'syncshow:sermons:write',
      'syncshow:sermon-sources:write'
    ],
    ['syncshow:sermon-sources:read'],
    ['syncshow:sermon-publications:read'],
    ['syncshow:sermon-media:read'],
    [
      'syncshow:sermons:read',
      'syncshow:sermon-media:write'
    ],
    [
      'syncshow:sermon-media:read',
      'syncshow:sermon-media:write'
    ],
    ['syncshow:songs:read', 'syncshow:unknown:read'],
    ['syncshow:song-public-links:read'],
    ['syncshow:songs:read', 'syncshow:song-public-links:write']
  ];

  for (const scopes of invalidScopes) {
    await assert.rejects(
      store.saveConnection(connectionInput({ scopes })),
      error => error instanceof CommunityConnectionStoreError
        && error.code === 'INVALID_CONNECTION'
    );
  }
});

test('sermon-media authority is separately approved and depends on sermon read', async t => {
  const root = await tempDirectory(t);
  let now = new Date('2026-07-27T12:00:00.000Z');
  const store = new CommunityConnectionStore({
    storageRoot: path.join(root, 'connections'),
    safeStorage: safeStorage(),
    randomUUID: () => 'connection-sermon-media-01',
    now: () => now
  });
  const scopes = [
    'syncshow:sermons:read',
    ...SERMON_MEDIA_SCOPES
  ];
  const approved = await store.saveConnection(connectionInput({
    scopes,
    advertisedScopes: scopes
  }));

  assert.equal(approved.canReadSermons, true);
  assert.equal(approved.canWriteSermons, false);
  assert.equal(approved.canReadSermonMedia, true);
  assert.equal(approved.canWriteSermonMedia, true);

  now = new Date('2026-07-27T12:05:00.000Z');
  const withdrawn = await store.updateAdvertisedScopes(approved.id, {
    advertisedScopes: ['syncshow:sermons:read'],
    expectedUpdatedAt: approved.updatedAt
  });
  assert.equal(withdrawn.canReadSermons, true);
  assert.equal(withdrawn.canReadSermonMedia, false);
  assert.equal(withdrawn.canWriteSermonMedia, false);
  assert.deepEqual(withdrawn.scopes, [...scopes].sort());
});

test('connection schema v1 migrates song grants losslessly on the next write', async t => {
  const root = await tempDirectory(t);
  const storageRoot = path.join(root, 'connections');
  const options = {
    storageRoot,
    safeStorage: safeStorage(),
    randomUUID: () => 'connection-00000022',
    now: () => new Date('2026-07-27T12:00:00.000Z')
  };
  const store = new CommunityConnectionStore(options);
  const saved = await store.saveConnection(connectionInput({ scopes: SONG_SCOPES }));
  const storePath = path.join(storageRoot, 'connections.json');
  const legacy = JSON.parse(await fs.readFile(storePath, 'utf8'));
  legacy.schemaVersion = 1;
  await fs.writeFile(storePath, `${JSON.stringify(legacy, null, 2)}\n`, { mode: 0o600 });

  const restarted = new CommunityConnectionStore(options);
  const summary = await restarted.getConnectionSummary(saved.id);
  assert.deepEqual(summary.scopes, [...SONG_SCOPES].sort());
  assert.equal(summary.canReadSermons, false);
  assert.equal(summary.canWriteSermonSources, false);

  await restarted.updateTokens(saved.id, {
    accessToken: 'updated-community-access-token-0001',
    expiresAt: '2026-07-27T14:00:00.000Z',
    expectedUpdatedAt: summary.updatedAt
  });
  const migrated = JSON.parse(await fs.readFile(storePath, 'utf8'));
  assert.equal(migrated.schemaVersion, CONNECTION_SCHEMA_VERSION);
  assert.deepEqual(migrated.connections[0].scopes, [...SONG_SCOPES].sort());
});

test('connection schema v2 derives its advertised baseline from the preserved grant', async t => {
  const root = await tempDirectory(t);
  const storageRoot = path.join(root, 'connections');
  const options = {
    storageRoot,
    safeStorage: safeStorage(),
    randomUUID: () => 'connection-00000030',
    now: () => new Date('2026-07-27T12:00:00.000Z')
  };
  const store = new CommunityConnectionStore(options);
  const saved = await store.saveConnection(connectionInput({
    scopes: SERMON_SCOPES,
    advertisedScopes: SERMON_SCOPES
  }));
  const storePath = path.join(storageRoot, 'connections.json');
  const legacy = JSON.parse(await fs.readFile(storePath, 'utf8'));
  legacy.schemaVersion = 2;
  delete legacy.connections[0].advertisedScopes;
  await fs.writeFile(storePath, `${JSON.stringify(legacy, null, 2)}\n`, { mode: 0o600 });

  const restarted = new CommunityConnectionStore(options);
  const summary = await restarted.getConnectionSummary(saved.id);
  assert.deepEqual(summary.scopes, [...SERMON_SCOPES].sort());
  assert.deepEqual(summary.advertisedScopes, [...SERMON_SCOPES].sort());
  assert.deepEqual(summary.effectiveScopes, [...SERMON_SCOPES].sort());
  assert.equal(summary.canReadSongs, false);
  assert.equal(summary.canReadSermons, true);

  await restarted.updateTokens(saved.id, {
    accessToken: 'updated-community-access-token-0002',
    expiresAt: '2026-07-27T14:00:00.000Z',
    expectedUpdatedAt: summary.updatedAt
  });
  const migrated = JSON.parse(await fs.readFile(storePath, 'utf8'));
  assert.equal(migrated.schemaVersion, CONNECTION_SCHEMA_VERSION);
  assert.deepEqual(migrated.connections[0].advertisedScopes, [...SERMON_SCOPES].sort());
});

test('connection schemas before public links cannot smuggle the new authority', async t => {
  const root = await tempDirectory(t);
  const storageRoot = path.join(root, 'connections');
  const options = {
    storageRoot,
    safeStorage: safeStorage(),
    randomUUID: () => 'connection-public-links-02'
  };
  const store = new CommunityConnectionStore(options);
  await store.saveConnection(connectionInput({ scopes: SONG_SCOPES }));
  const storePath = path.join(storageRoot, 'connections.json');
  const hostile = JSON.parse(await fs.readFile(storePath, 'utf8'));
  hostile.schemaVersion = EFFECTIVE_SCOPE_CONNECTION_SCHEMA_VERSION;
  hostile.connections[0].scopes.push(...SONG_PUBLIC_LINK_SCOPES);
  hostile.connections[0].advertisedScopes.push(...SONG_PUBLIC_LINK_SCOPES);
  await fs.writeFile(storePath, `${JSON.stringify(hostile, null, 2)}\n`, {
    mode: 0o600
  });

  await assert.rejects(
    new CommunityConnectionStore(options).listConnections(),
    error => error instanceof CommunityConnectionStoreError
      && error.code === 'INVALID_CONNECTION'
  );
});

test('schema v1 cannot smuggle new capability grants into a saved connection', async t => {
  const root = await tempDirectory(t);
  const storageRoot = path.join(root, 'connections');
  const options = {
    storageRoot,
    safeStorage: safeStorage(),
    randomUUID: () => 'connection-00000023'
  };
  const store = new CommunityConnectionStore(options);
  await store.saveConnection(connectionInput({ scopes: SONG_SCOPES }));
  const storePath = path.join(storageRoot, 'connections.json');
  const hostile = JSON.parse(await fs.readFile(storePath, 'utf8'));
  hostile.schemaVersion = 1;
  hostile.connections[0].scopes.push('syncshow:sermons:read');
  await fs.writeFile(storePath, `${JSON.stringify(hostile, null, 2)}\n`, { mode: 0o600 });

  await assert.rejects(
    new CommunityConnectionStore(options).listConnections(),
    error => error instanceof CommunityConnectionStoreError
      && error.code === 'INVALID_CONNECTION'
  );
});

test('sync state v2 keeps song and sermon checkpoints in independent lanes', async t => {
  const root = await tempDirectory(t);
  const storageRoot = path.join(root, 'state');
  const store = new CommunitySyncStateStore({ storageRoot });
  const connectionId = 'connection-00000024';
  await store.saveConnectionState(connectionId, {
    cursor: 'song-cursor-9',
    lastSyncAt: '2026-07-27T10:00:00.000Z',
    songs: {
      'amazing-grace': {
        syncId: 'amazing-grace',
        syncVersion: 4,
        remoteRevision: 'song:amazing-grace:4',
        documents: {},
        visibility: 'private'
      }
    },
    sermonCursor: ' sermon-cursor/+?= ',
    lastSermonSyncAt: '2026-07-27T10:05:00.000Z',
    sermons: {
      'ephesians-3-14': {
        syncId: 'ephesians-3-14',
        localSermonId: 'sermon-local-1',
        syncVersion: 2,
        localRevision: 'a'.repeat(64),
        remoteRevision: 'b'.repeat(64),
        lastSyncedAt: '2026-07-27T10:05:00.000Z'
      }
    }
  });

  const restarted = new CommunitySyncStateStore({ storageRoot });
  const state = await restarted.getConnectionState(connectionId);
  assert.equal(state.cursor, 'song-cursor-9');
  assert.equal(
    state.sermonCursor,
    ' sermon-cursor/+?= ',
    'opaque sermon cursors must survive persistence byte-for-byte'
  );
  assert.equal(state.songs['amazing-grace'].syncVersion, 4);
  assert.equal(state.sermons['ephesians-3-14'].syncVersion, 2);
  assert.equal(
    (await restarted.getSermonState(connectionId, 'ephesians-3-14')).localSermonId,
    'sermon-local-1'
  );
  assert.equal(
    JSON.parse(await fs.readFile(path.join(storageRoot, 'sync-state.json'), 'utf8'))
      .schemaVersion,
    STATE_SCHEMA_VERSION
  );
});

test('sync state schema v1 preserves every song field and initializes an empty sermon lane', async t => {
  const root = await tempDirectory(t);
  const storageRoot = path.join(root, 'state');
  const storePath = path.join(storageRoot, 'sync-state.json');
  const store = new CommunitySyncStateStore({ storageRoot });
  const connectionId = 'connection-00000025';
  await store.saveConnectionState(connectionId, {
    cursor: 'legacy-song-cursor',
    lastSyncAt: '2026-07-27T09:00:00.000Z',
    songs: {
      song: {
        syncId: 'song',
        localFamilyId: 'song',
        remoteTitle: 'Legacy Song',
        alternateTitles: ['Старая песня'],
        syncVersion: 7,
        remoteRevision: 'song:song:7',
        documents: {
          song: {
            localRevision: 'b'.repeat(64),
            remoteRevision: 'b'.repeat(64)
          }
        },
        visibility: 'scheduled-public',
        publishAt: '2026-07-28T17:00:00.000Z',
        pendingVisibility: {
          visibility: 'public',
          publishAt: null,
          expectedSyncVersion: 7
        },
        archived: false,
        metadataOnly: false,
        lastSyncedAt: '2026-07-27T09:00:00.000Z',
        conflict: null
      }
    },
    // A schema-v1 reader never had authority to interpret this future lane.
    sermonCursor: 'must-not-be-trusted',
    sermons: {
      attacker: {
        syncId: 'attacker',
        syncVersion: 99,
        remoteRevision: 'f'.repeat(64)
      }
    }
  });
  const legacy = JSON.parse(await fs.readFile(storePath, 'utf8'));
  legacy.schemaVersion = 1;
  await fs.writeFile(storePath, `${JSON.stringify(legacy, null, 2)}\n`, { mode: 0o600 });

  const restarted = new CommunitySyncStateStore({ storageRoot });
  const state = await restarted.getConnectionState(connectionId);
  assert.equal(state.cursor, 'legacy-song-cursor');
  assert.equal(state.songs.song.remoteTitle, 'Legacy Song');
  assert.deepEqual(state.songs.song.alternateTitles, ['Старая песня']);
  assert.deepEqual(state.songs.song.pendingVisibility, {
    visibility: 'public',
    publishAt: null,
    expectedSyncVersion: 7
  });
  assert.equal(state.songs.song.documents.song.localRevision, 'b'.repeat(64));
  assert.equal(state.sermonCursor, null);
  assert.equal(state.lastSermonSyncAt, null);
  assert.deepEqual(Object.keys(state.sermons), []);

  await restarted.saveConnectionState(connectionId, state);
  const migrated = JSON.parse(await fs.readFile(storePath, 'utf8'));
  assert.equal(migrated.schemaVersion, STATE_SCHEMA_VERSION);
  assert.equal(migrated.connections[connectionId].cursor, 'legacy-song-cursor');
  assert.equal(migrated.connections[connectionId].songs.song.syncVersion, 7);
});

test('sync state schema v2 drops inline sermon sources and migrates to compact revision pointers', async t => {
  const root = await tempDirectory(t);
  const storageRoot = path.join(root, 'state');
  const storePath = path.join(storageRoot, 'sync-state.json');
  const connectionId = 'connection-00000027';
  const sermonId = 'sermon-inline-conflict';
  const largeInlineSource = '\\'.repeat(1024 * 1024);
  await fs.mkdir(storageRoot, { recursive: true });
  await fs.writeFile(storePath, `${JSON.stringify({
    schemaVersion: INLINE_SERMON_CONFLICT_STATE_SCHEMA_VERSION,
    connections: {
      [connectionId]: {
        cursor: null,
        lastSyncAt: null,
        songs: {},
        sermonCursor: 'sermon-cursor-before-migration',
        lastSermonSyncAt: '2026-07-27T10:05:00.000Z',
        sermons: {
          [sermonId]: {
            syncId: sermonId,
            localSermonId: sermonId,
            syncVersion: 2,
            localRevision: 'a'.repeat(64),
            remoteRevision: 'b'.repeat(64),
            lastSyncedAt: '2026-07-27T10:05:00.000Z',
            conflict: {
              code: 'BOTH_CHANGED',
              detectedAt: '2026-07-27T10:05:00.000Z',
              localRevision: 'a'.repeat(64),
              lastSyncedLocalRevision: 'c'.repeat(64),
              remoteRevision: 'b'.repeat(64),
              remoteSyncVersion: 2,
              remoteDocumentSource: largeInlineSource
            }
          }
        }
      }
    }
  }, null, 2)}\n`, { mode: 0o600 });
  const beforeBytes = (await fs.stat(storePath)).size;

  const store = new CommunitySyncStateStore({ storageRoot });
  const state = await store.getConnectionState(connectionId);
  assert.equal(state.sermons[sermonId].conflict.remoteRevision, 'b'.repeat(64));
  assert.equal(
    Object.hasOwn(state.sermons[sermonId].conflict, 'remoteDocumentSource'),
    false
  );
  await store.saveConnectionState(connectionId, state);

  const migrated = JSON.parse(await fs.readFile(storePath, 'utf8'));
  assert.equal(migrated.schemaVersion, STATE_SCHEMA_VERSION);
  assert.equal(
    Object.hasOwn(
      migrated.connections[connectionId].sermons[sermonId].conflict,
      'remoteDocumentSource'
    ),
    false
  );
  assert.ok((await fs.stat(storePath)).size < beforeBytes / 100);
});

test('sync state schemas v1 through v3 cannot smuggle future song sharing reviews', async t => {
  const root = await tempDirectory(t);
  const schemaVersions = [
    LEGACY_STATE_SCHEMA_VERSION,
    INLINE_SERMON_CONFLICT_STATE_SCHEMA_VERSION,
    PRE_SHARING_REVIEW_STATE_SCHEMA_VERSION
  ];

  for (const schemaVersion of schemaVersions) {
    const storageRoot = path.join(root, `state-v${schemaVersion}`);
    const storePath = path.join(storageRoot, 'sync-state.json');
    const connectionId = `connection-0000003${schemaVersion}`;
    await fs.mkdir(storageRoot, { recursive: true });
    await fs.writeFile(storePath, `${JSON.stringify({
      schemaVersion,
      connections: {
        [connectionId]: {
          cursor: `cursor-v${schemaVersion}`,
          lastSyncAt: '2026-07-27T10:00:00.000Z',
          songs: {
            song: {
              syncId: 'song',
              localFamilyId: 'song',
              documents: {},
              visibility: 'public'
            }
          },
          songSharingReviews: {
            song: SAVED_SHARING_REVIEW
          },
          sermonCursor: null,
          lastSermonSyncAt: null,
          sermons: {}
        }
      }
    }, null, 2)}\n`, { mode: 0o600 });

    const store = new CommunitySyncStateStore({ storageRoot });
    const state = await store.getConnectionState(connectionId);
    assert.equal(state.songs.song.visibility, 'public');
    assert.deepEqual(
      Object.keys(state.songSharingReviews),
      [],
      `schema v${schemaVersion} must not grant authority to a future review lane`
    );
    assert.equal(await store.getSongSharingReview(connectionId, 'song'), null);

    await store.saveConnectionState(connectionId, state);
    const migrated = JSON.parse(await fs.readFile(storePath, 'utf8'));
    assert.equal(migrated.schemaVersion, STATE_SCHEMA_VERSION);
    assert.deepEqual(
      migrated.connections[connectionId].songSharingReviews,
      {},
      `schema v${schemaVersion} must migrate without inferring review from public visibility`
    );
  }
});

test('sync state schema v4 round-trips valid song sharing reviews', async t => {
  const root = await tempDirectory(t);
  const storageRoot = path.join(root, 'state');
  const storePath = path.join(storageRoot, 'sync-state.json');
  const connectionId = 'connection-00000034';
  await fs.mkdir(storageRoot, { recursive: true });
  await fs.writeFile(storePath, `${JSON.stringify({
    schemaVersion: STATE_SCHEMA_VERSION,
    connections: {
      [connectionId]: {
        cursor: null,
        lastSyncAt: null,
        songs: {},
        songSharingReviews: {
          song: SAVED_SHARING_REVIEW
        },
        sermonCursor: null,
        lastSermonSyncAt: null,
        sermons: {}
      }
    }
  }, null, 2)}\n`, { mode: 0o600 });

  const store = new CommunitySyncStateStore({ storageRoot });
  assert.deepEqual(
    await store.getSongSharingReview(connectionId, 'song'),
    SAVED_SHARING_REVIEW
  );
  const state = await store.getConnectionState(connectionId);
  await store.saveConnectionState(connectionId, state);

  const persisted = JSON.parse(await fs.readFile(storePath, 'utf8'));
  assert.equal(persisted.schemaVersion, STATE_SCHEMA_VERSION);
  assert.deepEqual(
    persisted.connections[connectionId].songSharingReviews.song,
    SAVED_SHARING_REVIEW
  );
});

test('sync state schema v4 fails closed on malformed song sharing reviews', async t => {
  const root = await tempDirectory(t);
  const malformedReviews = [
    {
      label: 'null review entry',
      reviews: { song: null }
    },
    {
      label: 'unsupported scope',
      reviews: {
        song: { ...SAVED_SHARING_REVIEW, scope: 'public-link' }
      }
    },
    {
      label: 'unsupported authority field',
      reviews: {
        song: { ...SAVED_SHARING_REVIEW, publicLinkApproved: true }
      }
    },
    {
      label: 'noncanonical family revision',
      reviews: {
        song: { ...SAVED_SHARING_REVIEW, familyRevision: 'D'.repeat(64) }
      }
    }
  ];

  for (const [index, candidate] of malformedReviews.entries()) {
    const storageRoot = path.join(root, `malformed-${index}`);
    const storePath = path.join(storageRoot, 'sync-state.json');
    const connectionId = `connection-0000004${index}`;
    await fs.mkdir(storageRoot, { recursive: true });
    await fs.writeFile(storePath, `${JSON.stringify({
      schemaVersion: STATE_SCHEMA_VERSION,
      connections: {
        [connectionId]: {
          cursor: null,
          lastSyncAt: null,
          songs: {},
          songSharingReviews: candidate.reviews,
          sermonCursor: null,
          lastSermonSyncAt: null,
          sermons: {}
        }
      }
    }, null, 2)}\n`, { mode: 0o600 });

    await assert.rejects(
      new CommunitySyncStateStore({ storageRoot }).getConnectionState(connectionId),
      error => error instanceof CommunitySyncStateStoreError
        && error.code === 'INVALID_STATE',
      candidate.label
    );
  }
});

test('sermon state rejects malformed maps and treats prototype names as ordinary IDs', async t => {
  const root = await tempDirectory(t);
  const storageRoot = path.join(root, 'state');
  const store = new CommunitySyncStateStore({ storageRoot });
  const connectionId = 'connection-00000026';

  assert.throws(
    () => store.saveConnectionState(connectionId, {
      songs: {},
      sermons: {
        expected: { syncId: 'different' }
      }
    }),
    error => error instanceof CommunitySyncStateStoreError
      && error.code === 'INVALID_STATE'
  );
  assert.throws(
    () => store.saveConnectionState(connectionId, {
      songs: {},
      sermons: {
        unpaired: { syncId: 'unpaired', syncVersion: 1 }
      }
    }),
    error => error instanceof CommunitySyncStateStoreError
      && error.code === 'INVALID_STATE'
  );
  assert.throws(
    () => store.saveConnectionState(connectionId, {
      songs: {},
      sermons: {
        unpaired: { syncId: 'unpaired', remoteRevision: 'a'.repeat(64) }
      }
    }),
    error => error instanceof CommunitySyncStateStoreError
      && error.code === 'INVALID_STATE'
  );
  assert.throws(
    () => store.saveConnectionState(connectionId, {
      songs: {},
      sermons: 'not-a-map'
    }),
    error => error instanceof CommunitySyncStateStoreError
      && error.code === 'INVALID_STATE'
  );
  assert.throws(
    () => store.saveConnectionState(connectionId, {
      songs: {},
      sermons: {
        numeric: { syncId: 0 }
      }
    }),
    error => error instanceof CommunitySyncStateStoreError
      && error.code === 'INVALID_STATE'
  );
  assert.throws(
    () => store.saveConnectionState(connectionId, {
      songs: {},
      sermons: {
        placeholder: {
          syncId: 'placeholder',
          localRevision: 'sermon:placeholder:1',
          remoteRevision: 'sermon:placeholder:1'
        }
      }
    }),
    error => error instanceof CommunitySyncStateStoreError
      && error.code === 'INVALID_STATE'
  );

  const sermons = Object.create(null);
  for (const [index, id] of ['constructor', 'toString', 'hasOwnProperty'].entries()) {
    sermons[id] = {
      syncId: id,
      syncVersion: 1,
      remoteRevision: String(index + 1).repeat(64)
    };
  }
  await store.saveConnectionState(connectionId, { songs: {}, sermons });
  const restarted = new CommunitySyncStateStore({ storageRoot });
  for (const id of Object.keys(sermons)) {
    assert.equal((await restarted.getSermonState(connectionId, id)).syncId, id);
  }
});
