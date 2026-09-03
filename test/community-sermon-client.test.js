'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');

const {
  CommunityClient,
  CommunityClientError,
  DISCOVERY_PATH,
  MAX_SERMON_PUBLICATION_RESPONSE_BYTES,
  SERMON_PUBLICATION_SCOPES,
  MAX_SERMON_TRANSFER_JSON_BYTES
} = require('../src/services/community/CommunityClient');
const {
  MAX_SERMON_SOURCE_BYTES,
  SERMON_KIND,
  serializeSermonDocument
} = require('../src/services/sermon/SermonDocument');
const {
  MAX_PUBLIC_SERMON_CATALOG_BYTES,
  MAX_PUBLIC_SERMON_DETAIL_BYTES,
  MAX_PUBLIC_SERMON_PASSAGE_INDEX_BYTES,
  SERMON_PUBLIC_CATALOG_PATH,
  SERMON_PUBLIC_CONTENT_BASE_PATH,
  SERMON_PUBLIC_PASSAGE_INDEX_PATH,
  deriveSermonPublicId
} = require('../src/services/sermon/SermonPublicProjection');

const BASE_URL = 'https://community.example.test/';
const ACCESS_TOKEN = 'community-sermon-access-token-00000001';

function json(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json' }
  });
}

function discovery({
  endpoint = 'sermons',
  sermonScopes = ['syncshow:sermons:read', 'syncshow:sermons:write']
} = {}) {
  return {
    schemaVersion: 1,
    server: { id: 'wotbc-community', name: 'WOTBC Community' },
    integrations: {
      syncShow: {
        schemaVersion: 2,
        apiBaseUrl: `${BASE_URL}api/community/syncshow/v1`,
        deviceAuthorization: true,
        resources: {
          sermons: {
            schemaVersion: 1,
            endpoint,
            scopes: sermonScopes,
            sourceObjectScopes: []
          }
        }
      }
    }
  };
}

function publicationDiscovery({
  endpoint = 'sermon-publications',
  publicationScopes = SERMON_PUBLICATION_SCOPES
} = {}) {
  const value = discovery({
    sermonScopes: ['syncshow:sermons:read']
  });
  value.integrations.syncShow.resources.sermonPublications = {
    schemaVersion: 1,
    endpoint,
    scopes: publicationScopes
  };
  return value;
}

function legacyDiscovery({ sermons = true } = {}) {
  const syncShow = {
    schemaVersion: 1,
    apiBaseUrl: `${BASE_URL}api/community/syncshow/v1`,
    deviceAuthorization: true,
    songLibrary: true,
    scopes: ['syncshow:songs:read', 'syncshow:songs:write']
  };
  if (sermons) {
    syncShow.resources = {
      sermons: {
        schemaVersion: 1,
        endpoint: 'sermons',
        scopes: ['syncshow:sermons:read', 'syncshow:sermons:write'],
        sourceObjectScopes: []
      }
    };
  }
  return {
    schemaVersion: 1,
    server: { id: 'wotbc-community', name: 'WOTBC Community' },
    integrations: { syncShow }
  };
}

function sermonDocument({
  id = 'sermon:2026-07-27',
  titles = { en: 'Prayer for the Church' },
  sources = []
} = {}) {
  return {
    schemaVersion: 2,
    kind: SERMON_KIND,
    id,
    titles,
    defaultLanguage: 'en',
    speaker: { id: null, name: 'Pastor Example' },
    serviceDate: '2026-07-27',
    series: null,
    outline: [],
    sources,
    references: [],
    media: [],
    publication: {
      status: 'draft',
      visibility: 'private',
      publishedAt: null,
      canonicalUrl: null
    }
  };
}

function sermonEnvelope(document, {
  syncVersion = 7,
  archived = false,
  updatedAt = '2026-07-27T18:22:03.000Z'
} = {}) {
  const documentSource = serializeSermonDocument(document);
  return {
    syncId: document.id,
    syncVersion,
    revision: crypto.createHash('sha256').update(documentSource).digest('hex'),
    documentSource,
    archived,
    updatedAt,
    sourceObjects: document.sources.map(source => ({
      sourceId: source.id,
      sha256: source.sha256,
      sizeBytes: source.sizeBytes,
      available: false
    }))
  };
}

function sermonPublicationState({
  syncId = 'sermon:2026-07-27',
  overrides = {}
} = {}) {
  return {
    schemaVersion: 1,
    syncId,
    currentRevision: 'a'.repeat(64),
    syncVersion: 7,
    publicationVersion: 3,
    publicRevision: 'b'.repeat(64),
    publicId: deriveSermonPublicId(syncId),
    detailChecksum: 'c'.repeat(64),
    catalogChecksum: 'd'.repeat(64),
    passageIndexChecksum: 'e'.repeat(64),
    publishedAt: '2026-07-27T18:30:00.000Z',
    selectedBodyEntryIds: ['manuscript-opening-en'],
    selectedMediaIds: ['post-service:recording:en'],
    ...overrides
  };
}

test('song-only discovery rejects every sermon method before a sermon request', async () => {
  const requests = [];
  const client = new CommunityClient({
    baseUrl: BASE_URL,
    fetchImpl: async (input, options) => {
      requests.push({ input, options });
      return json(legacyDiscovery({ sermons: false }));
    }
  });
  const documentSource = serializeSermonDocument(sermonDocument());
  const calls = [
    () => client.listSermonChanges({ accessToken: ACCESS_TOKEN }),
    () => client.getSermon({
      syncId: 'sermon:2026-07-27',
      accessToken: ACCESS_TOKEN
    }),
    () => client.createSermon({
      syncId: 'sermon:2026-07-27',
      documentSource,
      idempotencyKey: 'sermon-create-0001',
      accessToken: ACCESS_TOKEN
    }),
    () => client.updateSermon({
      syncId: 'sermon:2026-07-27',
      documentSource,
      expectedSyncVersion: 7,
      accessToken: ACCESS_TOKEN
    })
  ];

  for (const call of calls) {
    await assert.rejects(
      call(),
      error => error instanceof CommunityClientError
        && error.code === 'SERMON_SYNC_UNSUPPORTED'
    );
  }
  assert.equal(requests.length, 1);
  assert.equal(new URL(requests[0].input).pathname, DISCOVERY_PATH);
});

test('legacy v1 combined discovery keeps its nested sermon lane compatible', async () => {
  const client = new CommunityClient({
    baseUrl: BASE_URL,
    fetchImpl: async input => {
      assert.equal(new URL(input).pathname, DISCOVERY_PATH);
      return json(legacyDiscovery());
    }
  });

  const found = await client.discover();
  assert.equal(found.schemaVersion, 1);
  assert.equal(found.resources.songs.schemaVersion, 1);
  assert.equal(found.resources.sermons.schemaVersion, 1);
  assert.equal(found.capabilities.songs, true);
  assert.equal(found.capabilities.sermons, true);
});

test('a current read-only sermon resource rejects writes before their request', async () => {
  const requests = [];
  const documentSource = serializeSermonDocument(sermonDocument());
  const client = new CommunityClient({
    baseUrl: BASE_URL,
    fetchImpl: async (input, options) => {
      requests.push({ input, options });
      return json(discovery({
        sermonScopes: ['syncshow:sermons:read']
      }));
    }
  });

  for (const write of [
    () => client.createSermon({
      syncId: 'sermon:2026-07-27',
      documentSource,
      idempotencyKey: 'sermon-create-0001',
      accessToken: ACCESS_TOKEN
    }),
    () => client.updateSermon({
      syncId: 'sermon:2026-07-27',
      documentSource,
      expectedSyncVersion: 7,
      accessToken: ACCESS_TOKEN
    })
  ]) {
    await assert.rejects(
      write(),
      error => error instanceof CommunityClientError
        && error.code === 'SERMON_SCOPE_UNAVAILABLE'
    );
  }
  assert.equal(requests.length, 1);
  assert.equal(new URL(requests[0].input).pathname, DISCOVERY_PATH);
});

test('sermon publication reads use the pinned read-only resource and strict state wrapper', async () => {
  const requests = [];
  const publication = sermonPublicationState();
  const client = new CommunityClient({
    baseUrl: BASE_URL,
    fetchImpl: async (input, options) => {
      const url = new URL(input);
      requests.push({ url, options });
      if (url.pathname === DISCOVERY_PATH) {
        return json(publicationDiscovery({
          endpoint: 'publication-state'
        }));
      }
      return json({ publication });
    }
  });

  const fetched = await client.getSermonPublication({
    syncId: publication.syncId,
    accessToken: ACCESS_TOKEN
  });

  assert.deepEqual(SERMON_PUBLICATION_SCOPES, [
    'syncshow:sermon-publications:read'
  ]);
  assert.deepEqual(fetched, publication);
  assert.equal(Object.isFrozen(fetched), true);
  assert.equal(Object.isFrozen(fetched.selectedBodyEntryIds), true);
  assert.equal(requests[1].options.method, 'GET');
  assert.equal(
    requests[1].url.pathname,
    '/api/community/syncshow/v1/publication-state/sermon%3A2026-07-27'
  );
  assert.equal(
    requests[1].options.headers.Authorization,
    `SyncShow ${ACCESS_TOKEN}`
  );
  assert.equal(requests[1].options.body, undefined);
  assert.equal(client.publishSermonPublication, undefined);
  assert.equal(client.withdrawSermonPublication, undefined);
});

test('sermon publication artifact reads preserve exact anonymous sources in parallel', async () => {
  const publicId = deriveSermonPublicId('sermon:2026-07-27');
  const detailPath = `${SERMON_PUBLIC_CONTENT_BASE_PATH}/${publicId}`;
  const sources = new Map([
    [SERMON_PUBLIC_CATALOG_PATH, '{"items":[],"schemaVersion":2}\n'],
    [detailPath, '{"kind":"detail","schemaVersion":1}\n'],
    [SERMON_PUBLIC_PASSAGE_INDEX_PATH, '{"items":[],"schemaVersion":1}\n']
  ]);
  const requests = [];
  let activeArtifactRequests = 0;
  let maximumActiveArtifactRequests = 0;
  const client = new CommunityClient({
    baseUrl: BASE_URL,
    fetchImpl: async (input, options) => {
      const url = new URL(input);
      requests.push({ url, options });
      if (url.pathname === DISCOVERY_PATH) {
        return json(publicationDiscovery());
      }
      activeArtifactRequests += 1;
      maximumActiveArtifactRequests = Math.max(
        maximumActiveArtifactRequests,
        activeArtifactRequests
      );
      await new Promise(resolve => setImmediate(resolve));
      activeArtifactRequests -= 1;
      return new Response(sources.get(url.pathname), {
        status: 200,
        headers: { 'Content-Type': 'application/json; charset=utf-8' }
      });
    }
  });

  const artifacts = await client.getSermonPublicationArtifacts({ publicId });

  assert.deepEqual(artifacts, {
    detailSource: sources.get(detailPath),
    catalogSource: sources.get(SERMON_PUBLIC_CATALOG_PATH),
    passageIndexSource: sources.get(SERMON_PUBLIC_PASSAGE_INDEX_PATH)
  });
  assert.equal(Object.isFrozen(artifacts), true);
  assert.equal(maximumActiveArtifactRequests, 3);
  assert.deepEqual(
    new Set(requests.slice(1).map(request => request.url.pathname)),
    new Set([
      SERMON_PUBLIC_CATALOG_PATH,
      detailPath,
      SERMON_PUBLIC_PASSAGE_INDEX_PATH
    ])
  );
  for (const request of requests.slice(1)) {
    assert.equal(request.url.origin, new URL(BASE_URL).origin);
    assert.equal(request.options.method, 'GET');
    assert.equal(request.options.redirect, 'manual');
    assert.equal(request.options.headers.Authorization, undefined);
    assert.equal(request.options.body, undefined);
  }
});

test('sermon publication reads fail closed when the optional lane is absent', async () => {
  const requests = [];
  const client = new CommunityClient({
    baseUrl: BASE_URL,
    fetchImpl: async (input, options) => {
      requests.push({ input, options });
      return json(discovery({
        sermonScopes: ['syncshow:sermons:read']
      }));
    }
  });

  await assert.rejects(
    client.getSermonPublication({
      syncId: 'sermon:2026-07-27',
      accessToken: ACCESS_TOKEN
    }),
    error => error instanceof CommunityClientError
      && error.code === 'SERMON_PUBLICATIONS_UNSUPPORTED'
  );
  await assert.rejects(
    client.getSermonPublicationArtifacts({
      publicId: deriveSermonPublicId('sermon:2026-07-27')
    }),
    error => error instanceof CommunityClientError
      && error.code === 'SERMON_PUBLICATIONS_UNSUPPORTED'
  );
  assert.equal(requests.length, 1);
  assert.equal(new URL(requests[0].input).pathname, DISCOVERY_PATH);
});

test('sermon publication artifacts reject path injection, redirects, types, and invalid UTF-8', async () => {
  const publicId = deriveSermonPublicId('sermon:2026-07-27');
  const detailPath = `${SERMON_PUBLIC_CONTENT_BASE_PATH}/${publicId}`;
  const cases = [{
    publicId: 'https://attacker.invalid/sermon',
    code: 'INVALID_INPUT',
    expectedArtifactRequests: 0
  }, {
    hostilePath: SERMON_PUBLIC_CATALOG_PATH,
    response: new Response('', {
      status: 302,
      headers: { Location: 'https://attacker.invalid/sermons' }
    }),
    code: 'UNSAFE_REDIRECT'
  }, {
    hostilePath: detailPath,
    response: new Response('{}', {
      status: 200,
      headers: { 'Content-Type': 'text/html' }
    }),
    code: 'INVALID_RESPONSE',
    message: 'unexpected response type'
  }, {
    hostilePath: SERMON_PUBLIC_PASSAGE_INDEX_PATH,
    response: new Response(Uint8Array.from([
      0x7b, 0x22, 0x78, 0x22, 0x3a, 0x22, 0xc3, 0x28, 0x22, 0x7d
    ]), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    }),
    code: 'INVALID_RESPONSE',
    message: 'invalid UTF-8'
  }];

  for (const scenario of cases) {
    const artifactRequests = [];
    const client = new CommunityClient({
      baseUrl: BASE_URL,
      fetchImpl: async (input, options) => {
        const url = new URL(input);
        if (url.pathname === DISCOVERY_PATH) {
          return json(publicationDiscovery());
        }
        artifactRequests.push({ url, options });
        return url.pathname === scenario.hostilePath
          ? scenario.response
          : json({});
      }
    });
    await assert.rejects(
      client.getSermonPublicationArtifacts({
        publicId: scenario.publicId || publicId
      }),
      error => error instanceof CommunityClientError
        && error.code === scenario.code
        && (!scenario.message || error.message.includes(scenario.message))
    );
    assert.equal(
      artifactRequests.length,
      scenario.expectedArtifactRequests ?? 3
    );
    for (const request of artifactRequests) {
      assert.equal(request.options.redirect, 'manual');
      assert.equal(request.options.headers.Authorization, undefined);
    }
  }
});

test('sermon publication artifacts enforce each projection byte ceiling independently', async () => {
  const publicId = deriveSermonPublicId('sermon:2026-07-27');
  const detailPath = `${SERMON_PUBLIC_CONTENT_BASE_PATH}/${publicId}`;
  const cases = [
    [SERMON_PUBLIC_CATALOG_PATH, MAX_PUBLIC_SERMON_CATALOG_BYTES],
    [detailPath, MAX_PUBLIC_SERMON_DETAIL_BYTES],
    [
      SERMON_PUBLIC_PASSAGE_INDEX_PATH,
      MAX_PUBLIC_SERMON_PASSAGE_INDEX_BYTES
    ]
  ];

  for (const [oversizedPath, maximumBytes] of cases) {
    const client = new CommunityClient({
      baseUrl: BASE_URL,
      fetchImpl: async input => {
        const url = new URL(input);
        if (url.pathname === DISCOVERY_PATH) {
          return json(publicationDiscovery());
        }
        return new Response('{}', {
          status: 200,
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': String(
              url.pathname === oversizedPath ? maximumBytes + 1 : 2
            )
          }
        });
      }
    });
    await assert.rejects(
      client.getSermonPublicationArtifacts({ publicId }),
      error => error instanceof CommunityClientError
        && error.code === 'RESPONSE_TOO_LARGE'
    );
  }
});

test('sermon publication responses reject wrapper, state, identity, and size drift', async () => {
  const publication = sermonPublicationState();
  const cases = [{
    response: publication,
    code: 'INVALID_RESPONSE'
  }, {
    response: { publication, privateSource: '/private/manuscript.docx' },
    code: 'INVALID_RESPONSE'
  }, {
    response: {
      publication: {
        ...publication,
        privateSource: '/private/manuscript.docx'
      }
    },
    code: 'INVALID_PUBLICATION_STATE'
  }, {
    response: {
      publication: sermonPublicationState({
        syncId: 'sermon:different'
      })
    },
    code: 'INVALID_RESPONSE'
  }];

  for (const scenario of cases) {
    const client = new CommunityClient({
      baseUrl: BASE_URL,
      fetchImpl: async input =>
        new URL(input).pathname === DISCOVERY_PATH
          ? json(publicationDiscovery())
          : json(scenario.response)
    });
    await assert.rejects(
      client.getSermonPublication({
        syncId: publication.syncId,
        accessToken: ACCESS_TOKEN
      }),
      error => error instanceof CommunityClientError
        && error.code === scenario.code
        && error.retryable === false
    );
  }

  const oversized = new CommunityClient({
    baseUrl: BASE_URL,
    fetchImpl: async input => {
      if (new URL(input).pathname === DISCOVERY_PATH) {
        return json(publicationDiscovery());
      }
      return new Response('x'.repeat(MAX_SERMON_PUBLICATION_RESPONSE_BYTES + 1), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    }
  });
  await assert.rejects(
    oversized.getSermonPublication({
      syncId: publication.syncId,
      accessToken: ACCESS_TOKEN
    }),
    error => error instanceof CommunityClientError
      && error.code === 'RESPONSE_TOO_LARGE'
  );
});

test('sermon list, read, create, and update use the pinned resource contract', async () => {
  const requests = [];
  const document = sermonDocument();
  const documentSource = serializeSermonDocument(document);
  const revision = crypto.createHash('sha256').update(documentSource).digest('hex');
  const client = new CommunityClient({
    baseUrl: BASE_URL,
    fetchImpl: async (input, options) => {
      const url = new URL(input);
      const body = options.body ? JSON.parse(options.body) : null;
      requests.push({ url, options, body });
      if (url.pathname === DISCOVERY_PATH) {
        return json(discovery({ endpoint: 'sermon-transport' }));
      }
      if (options.method === 'GET' && url.searchParams.has('limit')) {
        return json({
          schemaVersion: 1,
          items: [{
            syncId: document.id,
            syncVersion: 7,
            revision,
            archived: false,
            updatedAt: '2026-07-27T18:22:03.000Z'
          }],
          nextCursor: 'durable-final-cursor',
          hasMore: false
        });
      }
      if (options.method === 'GET') {
        return json({ sermon: sermonEnvelope(document) });
      }
      if (options.method === 'POST') {
        return json({
          sermon: sermonEnvelope(document, { syncVersion: 1 })
        }, 201);
      }
      if (options.method === 'PUT') {
        return json({
          sermon: sermonEnvelope(document, { syncVersion: 8 })
        });
      }
      throw new Error(`Unexpected request: ${options.method} ${url}`);
    }
  });
  const opaqueCursor = ' cursor/+?= ';

  const page = await client.listSermonChanges({
    cursor: opaqueCursor,
    limit: 20,
    accessToken: ACCESS_TOKEN
  });
  const fetched = await client.getSermon({
    syncId: document.id,
    accessToken: ACCESS_TOKEN
  });
  const created = await client.createSermon({
    syncId: document.id,
    documentSource,
    idempotencyKey: 'sermon-create-0001',
    accessToken: ACCESS_TOKEN
  });
  const updated = await client.updateSermon({
    syncId: document.id,
    documentSource,
    expectedSyncVersion: 7,
    accessToken: ACCESS_TOKEN
  });

  assert.equal(page.nextCursor, 'durable-final-cursor');
  assert.equal(page.hasMore, false);
  assert.equal(Object.isFrozen(page), true);
  assert.equal(fetched.revision, revision);
  assert.equal(created.syncVersion, 1);
  assert.equal(updated.syncVersion, 8);

  assert.equal(requests[1].url.pathname, '/api/community/syncshow/v1/sermon-transport');
  assert.equal(requests[1].url.searchParams.get('cursor'), opaqueCursor);
  assert.equal(requests[1].url.searchParams.get('limit'), '20');
  assert.equal(requests[1].options.redirect, 'manual');
  assert.equal(requests[1].options.headers.Authorization, `SyncShow ${ACCESS_TOKEN}`);

  assert.equal(
    requests[2].url.pathname,
    '/api/community/syncshow/v1/sermon-transport/sermon%3A2026-07-27'
  );
  assert.equal(requests[2].options.headers.Authorization, `SyncShow ${ACCESS_TOKEN}`);

  assert.equal(requests[3].url.pathname, '/api/community/syncshow/v1/sermon-transport');
  assert.equal(requests[3].options.headers['Idempotency-Key'], 'sermon-create-0001');
  assert.deepEqual(requests[3].body, {
    syncId: document.id,
    revision,
    documentSource
  });
  assert.deepEqual(Object.keys(requests[3].body), [
    'syncId',
    'revision',
    'documentSource'
  ]);

  assert.equal(
    requests[4].url.pathname,
    '/api/community/syncshow/v1/sermon-transport/sermon%3A2026-07-27'
  );
  assert.equal(
    requests[4].options.headers['If-Match'],
    '"sermon:sermon:2026-07-27:7"'
  );
  assert.deepEqual(requests[4].body, requests[3].body);
});

test('an empty final sermon page advances to its non-null durable cursor', async () => {
  const client = new CommunityClient({
    baseUrl: BASE_URL,
    fetchImpl: async input => {
      if (new URL(input).pathname === DISCOVERY_PATH) return json(discovery());
      return json({
        schemaVersion: 1,
        items: [],
        nextCursor: 'checkpoint-after-empty-page',
        hasMore: false
      });
    }
  });
  const page = await client.listSermonChanges({ accessToken: ACCESS_TOKEN });

  assert.deepEqual(page, {
    schemaVersion: 1,
    items: [],
    nextCursor: 'checkpoint-after-empty-page',
    hasMore: false
  });
});

test('sermon create retries are stable and update conflicts preserve CAS semantics', async () => {
  const document = sermonDocument();
  const documentSource = serializeSermonDocument(document);
  const writes = [];
  const client = new CommunityClient({
    baseUrl: BASE_URL,
    fetchImpl: async (input, options) => {
      const url = new URL(input);
      if (url.pathname === DISCOVERY_PATH) return json(discovery());
      writes.push({
        method: options.method,
        headers: options.headers,
        body: options.body
      });
      if (options.method === 'POST') {
        return json({ sermon: sermonEnvelope(document, { syncVersion: 1 }) }, 201);
      }
      if (options.method === 'PUT') {
        return json({ code: 'stale-write' }, 412);
      }
      throw new Error(`Unexpected request: ${options.method} ${url}`);
    }
  });
  const createInput = {
    syncId: document.id,
    documentSource,
    idempotencyKey: 'sermon-create-stable-0001',
    accessToken: ACCESS_TOKEN
  };

  await client.createSermon(createInput);
  await client.createSermon(createInput);
  assert.equal(writes[0].headers['Idempotency-Key'], createInput.idempotencyKey);
  assert.equal(writes[1].headers['Idempotency-Key'], createInput.idempotencyKey);
  assert.equal(writes[0].body, writes[1].body);

  await assert.rejects(
    client.updateSermon({
      syncId: document.id,
      documentSource,
      expectedSyncVersion: 7,
      accessToken: ACCESS_TOKEN
    }),
    error => error instanceof CommunityClientError
      && error.code === 'REVISION_CONFLICT'
      && error.status === 412
  );
  assert.equal(
    writes[2].headers['If-Match'],
    '"sermon:sermon:2026-07-27:7"'
  );
});

test('hostile sermon pages and wrapped records fail as generic client errors', async () => {
  const document = sermonDocument();
  const rawEnvelope = sermonEnvelope(document);
  const cases = [
    {
      response: {
        schemaVersion: 1,
        items: [],
        nextCursor: null,
        hasMore: false
      },
      invoke: client => client.listSermonChanges({ accessToken: ACCESS_TOKEN })
    },
    {
      response: rawEnvelope,
      invoke: client => client.getSermon({
        syncId: document.id,
        accessToken: ACCESS_TOKEN
      })
    },
    {
      response: { sermon: rawEnvelope, sourceBytes: 'private bytes' },
      invoke: client => client.getSermon({
        syncId: document.id,
        accessToken: ACCESS_TOKEN
      })
    },
    {
      response: {
        sermon: {
          ...rawEnvelope,
          revision: 'f'.repeat(64)
        }
      },
      invoke: client => client.getSermon({
        syncId: document.id,
        accessToken: ACCESS_TOKEN
      })
    }
  ];

  for (const scenario of cases) {
    const client = new CommunityClient({
      baseUrl: BASE_URL,
      fetchImpl: async input =>
        new URL(input).pathname === DISCOVERY_PATH
          ? json(discovery())
          : json(scenario.response)
    });
    await assert.rejects(scenario.invoke(client), error => {
      assert.ok(error instanceof CommunityClientError);
      assert.equal(error.code, 'INVALID_RESPONSE');
      assert.equal(error.retryable, false);
      assert.equal(JSON.stringify(error).includes(rawEnvelope.documentSource), false);
      assert.equal(Object.hasOwn(error, 'details'), false);
      return true;
    });
  }
});

test('sermon pages cannot exceed the requested limit', async () => {
  const document = sermonDocument();
  const envelope = sermonEnvelope(document);
  const client = new CommunityClient({
    baseUrl: BASE_URL,
    fetchImpl: async input => {
      if (new URL(input).pathname === DISCOVERY_PATH) return json(discovery());
      return json({
        schemaVersion: 1,
        items: [1, 2].map(index => ({
          syncId: `${document.id}-${index}`,
          syncVersion: index,
          revision: envelope.revision,
          archived: false,
          updatedAt: envelope.updatedAt
        })),
        nextCursor: 'oversized-request-page',
        hasMore: false
      });
    }
  });

  await assert.rejects(
    client.listSermonChanges({
      limit: 1,
      accessToken: ACCESS_TOKEN
    }),
    error => error instanceof CommunityClientError
      && error.code === 'INVALID_RESPONSE'
  );
});

test('near-limit escaped sermon envelopes use only the sermon transfer allowance', async () => {
  const titles = { en: 'Near transfer limit' };
  for (let index = 0; index < 2140; index += 1) {
    titles[`aa-${index.toString(36).padStart(6, '0')}`] = '\\'.repeat(300);
  }
  const sources = Array.from({ length: 512 }, (_, index) => ({
    id: `source-${index}`,
    kind: 'manuscript',
    fileName: `source-${index}.pdf`,
    mediaType: 'application/pdf',
    sha256: crypto.createHash('sha256').update(String(index)).digest('hex'),
    sizeBytes: index,
    provenance: {
      providedBy: '\\'.repeat(200),
      receivedAt: '2026-07-27T18:00:00.000Z',
      sourceSystem: '\\'.repeat(100),
      externalId: '\\'.repeat(300)
    },
    languages: ['en']
  }));
  const document = sermonDocument({
    id: 'near-bound-sermon',
    titles,
    sources
  });
  const envelope = sermonEnvelope(document);
  const responseBytes = Buffer.byteLength(JSON.stringify({ sermon: envelope }), 'utf8');

  assert.ok(Buffer.byteLength(envelope.documentSource, 'utf8')
    > MAX_SERMON_SOURCE_BYTES - (8 * 1024));
  assert.ok(responseBytes > 4_000_000);
  assert.ok(responseBytes < MAX_SERMON_TRANSFER_JSON_BYTES);

  const client = new CommunityClient({
    baseUrl: BASE_URL,
    maximumJsonBytes: 1024,
    fetchImpl: async input =>
      new URL(input).pathname === DISCOVERY_PATH
        ? json(discovery())
        : json({ sermon: envelope })
  });
  const fetched = await client.getSermon({
    syncId: document.id,
    accessToken: ACCESS_TOKEN
  });

  assert.equal(fetched.revision, envelope.revision);
  assert.equal(fetched.sourceObjects.length, 512);
});
