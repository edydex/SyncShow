'use strict';

const crypto = require('node:crypto');
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  CommunityClient,
  CommunityClientError,
  DISCOVERY_PATH
} = require('../src/services/community/CommunityClient');
const {
  createHeritageServiceDocument,
  serializeHeritageServiceDocument
} = require('../src/services/community/HeritageServiceDocument');
const { createServiceProject } = require('../src/services/project');

const BASE_URL = 'https://community.example.test/';
const ACCESS_TOKEN = 'community-access-token-0000000001';
const NOW = '2026-08-13T20:00:00.000Z';

test('a short caller deadline aborts discovery or the conditional document read', async () => {
  for (const blockedPhase of ['discovery', 'document']) {
    const requests = [];
    let aborted = false;
    const client = new CommunityClient({
      baseUrl: BASE_URL,
      fetchImpl: async (url, options) => {
        requests.push(url);
        if (url.endsWith(DISCOVERY_PATH) && blockedPhase === 'document') return json(discovery());
        return new Promise((_resolve, reject) => {
          const abort = () => { aborted = true; reject(options.signal.reason); };
          if (options.signal.aborted) abort();
          else options.signal.addEventListener('abort', abort, { once: true });
        });
      }
    });
    // Keep the fixture alive independently of AbortSignal's unref'ed timer.
    const keepAlive = setTimeout(() => {}, 2000);
    const started = Date.now();
    try {
      await assert.rejects(client.getServiceDocument({
        syncId: 'service-2026-07-26', accessToken: ACCESS_TOKEN,
        knownRevision: 'a'.repeat(64), signal: AbortSignal.timeout(40)
      }), error => error.code === 'REQUEST_CANCELLED');
      assert.equal(aborted, true);
      assert(Date.now() - started < 1500, blockedPhase);
      assert.equal(requests.length, blockedPhase === 'document' ? 2 : 1);
    } finally {
      clearTimeout(keepAlive);
    }
  }
});

function json(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json' }
  });
}

function discovery(scopes = [
  'syncshow:service-documents:read',
  'syncshow:service-documents:write'
]) {
  return {
    schemaVersion: 1,
    server: { id: 'wotbc-community', name: 'WOTBC Community' },
    integrations: {
      syncShow: {
        schemaVersion: 2,
        apiBaseUrl: `${BASE_URL}api/community/syncshow/v1`,
        deviceAuthorization: true,
        resources: {
          serviceDocuments: {
            schemaVersion: 1,
            endpoint: 'service-documents',
            changesEndpoint: 'service-documents/changes',
            scopes
          }
        }
      }
    }
  };
}

function source(title = 'July 26 Service') {
  const project = createServiceProject({
    id: 'service-2026-07-26',
    title,
    serviceDate: '2026-07-26',
    profileId: 'main-sanctuary',
    now: NOW,
    channels: [
      { id: 'english', label: 'English', language: 'en' },
      { id: 'russian', label: 'Russian', language: 'ru' },
      { id: 'media', label: 'Media', language: 'und' }
    ]
  });
  return serializeHeritageServiceDocument(createHeritageServiceDocument(project));
}

function revision(documentSource) {
  return crypto.createHash('sha256').update(documentSource).digest('hex');
}

function envelope(documentSource, overrides = {}) {
  return {
    syncId: 'service-2026-07-26',
    syncVersion: 4,
    revision: revision(documentSource),
    documentSource,
    status: 'planning',
    changedAt: NOW,
    ...overrides
  };
}

function summary(documentSource, overrides = {}) {
  return {
    syncId: 'service-2026-07-26',
    syncVersion: 4,
    revision: revision(documentSource),
    status: 'planning',
    title: 'July 26 Service',
    serviceDate: '2026-07-26',
    changedAt: NOW,
    ...overrides
  };
}

test('discovers the canonical read/write resource and pinned change feed', async () => {
  const client = new CommunityClient({
    baseUrl: BASE_URL,
    fetchImpl: async () => json(discovery())
  });
  const found = await client.discover();

  assert.equal(found.capabilities.serviceDocuments, true);
  assert.deepEqual(found.resources.serviceDocuments.scopes, [
    'syncshow:service-documents:read',
    'syncshow:service-documents:write'
  ]);
  assert.equal(
    new URL(found.resources.serviceDocuments.endpoint).pathname,
    '/api/community/syncshow/v1/service-documents'
  );
  assert.equal(
    new URL(found.resources.serviceDocuments.changesEndpoint).pathname,
    '/api/community/syncshow/v1/service-documents/changes'
  );
});

test('lists, reads, creates, updates, and reads changes for one exact document', async () => {
  const originalSource = source();
  const changedSource = source('July 26 Service — reviewed');
  const requests = [];
  const client = new CommunityClient({
    baseUrl: BASE_URL,
    fetchImpl: async (input, options) => {
      const url = new URL(input);
      requests.push({ url, options });
      if (url.pathname === DISCOVERY_PATH) return json(discovery());
      if (url.pathname.endsWith('/service-documents/changes')) {
        return json({
          items: [summary(changedSource, {
            syncVersion: 5,
            revision: revision(changedSource),
            title: 'July 26 Service — reviewed'
          })],
          nextCursor: 'checkpoint-5',
          hasMore: false
        });
      }
      if (url.pathname.endsWith('/service-documents/service-2026-07-26')) {
        if (options.method === 'PUT') {
          return json({
            serviceDocument: envelope(changedSource, {
              syncVersion: 5,
              revision: revision(changedSource)
            })
          });
        }
        return json({ serviceDocument: envelope(originalSource) });
      }
      if (url.pathname.endsWith('/service-documents')) {
        if (options.method === 'POST') {
          return json({ serviceDocument: envelope(originalSource) }, 201);
        }
        return json({
          items: [summary(originalSource)],
          nextCursor: null,
          hasMore: false
        });
      }
      throw new Error(`Unexpected request: ${url}`);
    }
  });

  const listed = await client.listServiceDocuments({
    limit: 20,
    accessToken: ACCESS_TOKEN
  });
  const found = await client.getServiceDocument({
    syncId: 'service-2026-07-26',
    accessToken: ACCESS_TOKEN
  });
  const created = await client.createServiceDocument({
    syncId: 'service-2026-07-26',
    documentSource: originalSource,
    accessToken: ACCESS_TOKEN,
    idempotencyKey: '00000000-0000-4000-8000-000000000001'
  });
  const updated = await client.updateServiceDocument({
    syncId: 'service-2026-07-26',
    documentSource: changedSource,
    baseSyncVersion: 4,
    baseRevision: revision(originalSource),
    accessToken: ACCESS_TOKEN,
    idempotencyKey: '00000000-0000-4000-8000-000000000002'
  });
  const changes = await client.listServiceDocumentChanges({
    cursor: 'cursor-4',
    accessToken: ACCESS_TOKEN
  });

  assert.equal(listed.items[0].syncId, 'service-2026-07-26');
  assert.equal(found.project.title, 'July 26 Service');
  assert.equal(created.revision, revision(originalSource));
  assert.equal(updated.project.title, 'July 26 Service — reviewed');
  assert.equal(changes.items[0].syncVersion, 5);
  assert.equal(changes.nextCursor, 'checkpoint-5');

  const post = requests.find(request => request.options.method === 'POST');
  const put = requests.find(request => request.options.method === 'PUT');
  assert.equal(
    post.options.headers['Idempotency-Key'],
    '00000000-0000-4000-8000-000000000001'
  );
  assert.equal(
    put.options.headers['If-Match'],
    `"${revision(originalSource)}"`
  );
  assert.equal(put.options.headers['X-Heritage-Base-Sync-Version'], '4');
  assert.deepEqual(JSON.parse(put.options.body), {
    syncId: 'service-2026-07-26',
    baseSyncVersion: 4,
    baseRevision: revision(originalSource),
    documentSource: changedSource,
    status: 'planning'
  });
});

test('write-only discovery is rejected and a concurrent update is surfaced', async () => {
  const invalid = new CommunityClient({
    baseUrl: BASE_URL,
    fetchImpl: async () => json(discovery([
      'syncshow:service-documents:write'
    ]))
  });
  await assert.rejects(
    invalid.discover(),
    error => error instanceof CommunityClientError
      && error.code === 'INVALID_DISCOVERY'
  );

  const documentSource = source();
  const conflict = new CommunityClient({
    baseUrl: BASE_URL,
    fetchImpl: async input => new URL(input).pathname === DISCOVERY_PATH
      ? json(discovery())
      : json({ error: 'revision-conflict' }, 409)
  });
  await assert.rejects(
    conflict.updateServiceDocument({
      syncId: 'service-2026-07-26',
      documentSource,
      baseSyncVersion: 4,
      baseRevision: revision(documentSource),
      accessToken: ACCESS_TOKEN,
      idempotencyKey: '00000000-0000-4000-8000-000000000003'
    }),
    error => error instanceof CommunityClientError
      && error.code === 'REVISION_CONFLICT'
      && error.retryable === false
  );
});

test('uploads and downloads exact private images through the service-document resource', async () => {
  const bytes = Buffer.from('bounded-service-image-fixture');
  const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
  const asset = {
    id: `sha256:${sha256}`,
    kind: 'image',
    sha256,
    mediaType: 'image/png',
    size: bytes.length,
    width: 960,
    height: 540,
    orientation: 1
  };
  const requests = [];
  const client = new CommunityClient({
    baseUrl: BASE_URL,
    fetchImpl: async (input, options) => {
      const url = new URL(input);
      requests.push({ url, options });
      if (url.pathname === DISCOVERY_PATH) return json(discovery());
      if (options.method === 'PUT') return new Response(null, { status: 201 });
      return new Response(bytes, {
        status: 200,
        headers: {
          'Content-Type': 'image/png',
          'Content-Length': String(bytes.length)
        }
      });
    }
  });

  await client.putServiceDocumentAsset({
    asset,
    bytes,
    accessToken: ACCESS_TOKEN
  });
  const downloaded = await client.getServiceDocumentAsset({
    syncId: 'service-2026-07-26',
    asset,
    accessToken: ACCESS_TOKEN
  });

  assert.deepEqual(downloaded, bytes);
  const put = requests.find(request => request.options.method === 'PUT');
  const get = requests.find(request => request.options.method === 'GET'
    && request.url.pathname.includes('/assets/'));
  assert.equal(
    put.url.pathname,
    `/api/community/syncshow/v1/service-documents/assets/${encodeURIComponent(asset.id)}`
  );
  assert.equal(put.options.headers['Content-Type'], 'image/png');
  assert.equal(put.options.headers['X-Heritage-Asset-Width'], '960');
  assert.deepEqual(Buffer.from(put.options.body), bytes);
  assert.equal(
    get.url.pathname,
    `/api/community/syncshow/v1/service-documents/service-2026-07-26/assets/${encodeURIComponent(asset.id)}`
  );
});

test('uploads and downloads exact private videos without image-only headers', async () => {
  const bytes = Buffer.alloc(32);
  bytes.writeUInt32BE(bytes.length, 0);
  bytes.write('ftyp', 4, 'ascii');
  bytes.write('isom', 8, 'ascii');
  const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
  const asset = {
    id: `sha256:${sha256}`,
    kind: 'video',
    sha256,
    mediaType: 'video/mp4',
    size: bytes.length
  };
  const requests = [];
  const client = new CommunityClient({
    baseUrl: BASE_URL,
    fetchImpl: async (input, options) => {
      const url = new URL(input);
      requests.push({ url, options });
      if (url.pathname === DISCOVERY_PATH) return json(discovery());
      if (options.method === 'PUT') return new Response(null, { status: 201 });
      return new Response(bytes, {
        status: 200,
        headers: {
          'Content-Type': 'video/mp4',
          'Content-Length': String(bytes.length)
        }
      });
    }
  });

  await client.putServiceDocumentAsset({ asset, bytes, accessToken: ACCESS_TOKEN });
  assert.deepEqual(await client.getServiceDocumentAsset({
    syncId: 'service-2026-07-26',
    asset,
    accessToken: ACCESS_TOKEN
  }), bytes);

  const put = requests.find(request => request.options.method === 'PUT');
  assert.equal(put.options.headers['Content-Type'], 'video/mp4');
  assert.equal(put.options.headers['X-Heritage-Asset-Width'], undefined);
  assert.equal(put.options.headers['X-Heritage-Asset-Orientation'], undefined);
});

test('unchanged revisions use authenticated conditional GET without downloading a document', async () => {
  const known=revision(source());const requests=[];
  const client=new CommunityClient({baseUrl:BASE_URL,fetchImpl:async(input,options)=>{
    if(new URL(input).pathname===DISCOVERY_PATH)return json(discovery());
    requests.push(options);return new Response(null,{status:304,headers:{ETag:`"${known}"`}});
  }});
  const result=await client.getServiceDocument({syncId:'service-2026-07-26',accessToken:ACCESS_TOKEN,knownRevision:known});
  assert.deepEqual(result,{notModified:true,syncId:'service-2026-07-26',revision:known});
  assert.equal(requests.length,1);assert.equal(requests[0].headers['If-None-Match'],`"${known}"`);
  assert.equal(requests[0].headers.Authorization,`SyncShow ${ACCESS_TOKEN}`);
});
test('changed conditional reads validate the complete canonical document and reject mismatched confirmations', async () => {
  const before=revision(source()), changed=source('Updated service');let wrong=false;
  const client=new CommunityClient({baseUrl:BASE_URL,fetchImpl:async input=>{
    if(new URL(input).pathname===DISCOVERY_PATH)return json(discovery());
    return wrong ? new Response(null,{status:304,headers:{ETag:'"wrong"'}}) : json({serviceDocument:envelope(changed)});
  }});
  assert.equal((await client.getServiceDocument({syncId:'service-2026-07-26',accessToken:ACCESS_TOKEN,knownRevision:before})).documentSource,changed);
  wrong=true;await assert.rejects(client.getServiceDocument({syncId:'service-2026-07-26',accessToken:ACCESS_TOKEN,knownRevision:before}),error=>error.code==='INVALID_RESPONSE');
});
