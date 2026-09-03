'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  CommunityClient,
  CommunityClientError,
  DISCOVERY_PATH,
  SERVICE_PLAN_SCOPES
} = require('../src/services/community/CommunityClient');
const {
  COMMUNITY_SERVICE_PLAN_KIND,
  serializeCommunityServicePlan,
  communityServicePlanRevision
} = require('../src/services/community/CommunityServicePlan');

const BASE_URL = 'https://community.example.test/';
const ACCESS_TOKEN = 'community-service-plan-token-00000001';

function json(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json' }
  });
}

function resource(overrides = {}) {
  return {
    schemaVersion: 1,
    endpoint: 'service-plans',
    scopes: SERVICE_PLAN_SCOPES,
    ...overrides
  };
}

function discovery({
  resources = { servicePlans: resource() },
  schemaVersion = 2
} = {}) {
  return {
    schemaVersion: 1,
    server: { id: 'wotbc-community', name: 'WOTBC Community' },
    integrations: {
      syncShow: {
        schemaVersion,
        apiBaseUrl: `${BASE_URL}api/community/syncshow/v1`,
        deviceAuthorization: true,
        ...(schemaVersion === 1
          ? {
            songLibrary: true,
            scopes: ['syncshow:songs:read']
          }
          : { resources })
      }
    }
  };
}

function servicePlan(schemaVersion = 1) {
  return {
    schemaVersion,
    kind: COMMUNITY_SERVICE_PLAN_KIND,
    id: 'service-2026-08-02',
    title: 'Sunday Service — August 2',
    serviceDate: '2026-08-02',
    startTime: '10:30',
    teamNotes: '',
    entries: [{
      id: 'opening',
      kind: 'section',
      title: 'Opening'
    }]
  };
}

function envelope(schemaVersion = 1) {
  const plan = servicePlan(schemaVersion);
  const documentSource = serializeCommunityServicePlan(plan);
  return {
    syncId: plan.id,
    syncVersion: 3,
    revision: communityServicePlanRevision(documentSource),
    documentSource,
    status: 'ready',
    changedAt: '2026-07-28T18:00:00.000Z'
  };
}

test('schema-v2 discovery advertises service plans as an independent read-only lane', async () => {
  const requests = [];
  const client = new CommunityClient({
    baseUrl: BASE_URL,
    fetchImpl: async (input, options) => {
      requests.push({ input, options });
      return json(discovery());
    }
  });

  const found = await client.discover();
  assert.deepEqual(found.scopes, ['syncshow:service-plans:read']);
  assert.equal(found.capabilities.servicePlans, true);
  assert.equal(found.capabilities.songs, false);
  assert.equal(found.capabilities.sermons, false);
  assert.deepEqual(found.resources.servicePlans, {
    schemaVersion: 1,
    endpoint: `${BASE_URL}api/community/syncshow/v1/service-plans`,
    scopes: ['syncshow:service-plans:read']
  });
  assert.equal(requests.length, 1);
});

test('service-plan discovery accepts protocol v2 while preserving v1 compatibility', async () => {
  for (const schemaVersion of [1, 2]) {
    const client = new CommunityClient({
      baseUrl: BASE_URL,
      fetchImpl: async () => json(discovery({
        resources: {
          servicePlans: resource({ schemaVersion })
        }
      }))
    });
    const found = await client.discover();
    assert.equal(found.resources.servicePlans.schemaVersion, schemaVersion);
  }

  const unsupported = new CommunityClient({
    baseUrl: BASE_URL,
    fetchImpl: async () => json(discovery({
      resources: {
        servicePlans: resource({ schemaVersion: 3 })
      }
    }))
  });
  await assert.rejects(
    () => unsupported.discover(),
    error => error instanceof CommunityClientError
      && error.code === 'SYNC_UNSUPPORTED'
  );
});

test('service-plan discovery rejects unsafe, writable, or credential-shaped descriptors', async () => {
  const cases = [
    resource({ endpoint: 'https://attacker.example/service-plans' }),
    resource({ scopes: ['syncshow:service-plans:write'] }),
    resource({ accessToken: 'must-not-travel' })
  ];
  for (const descriptor of cases) {
    const client = new CommunityClient({
      baseUrl: BASE_URL,
      fetchImpl: async () => json(discovery({
        resources: { servicePlans: descriptor }
      }))
    });
    await assert.rejects(
      () => client.discover(),
      error => error instanceof CommunityClientError
        && ['INVALID_DISCOVERY', 'INVALID_SCOPE'].includes(error.code)
    );
  }
});

test('service-plan absence is independent and fails before any plan request', async () => {
  const requests = [];
  const client = new CommunityClient({
    baseUrl: BASE_URL,
    fetchImpl: async (input, options) => {
      requests.push({ input, options });
      return json(discovery({
        resources: {
          songs: {
            schemaVersion: 1,
            endpoint: 'songs',
            scopes: ['syncshow:songs:read']
          }
        }
      }));
    }
  });

  await assert.rejects(
    () => client.listServicePlans({ accessToken: ACCESS_TOKEN }),
    error => error instanceof CommunityClientError
      && error.code === 'SERVICE_PLANS_UNSUPPORTED'
  );
  assert.equal(requests.length, 1);
  assert.equal(new URL(requests[0].input).pathname, DISCOVERY_PATH);
});

test('list and get use the approved read lane and validate exact canonical responses', async () => {
  const requests = [];
  const remote = envelope();
  const client = new CommunityClient({
    baseUrl: BASE_URL,
    fetchImpl: async (input, options) => {
      const url = new URL(input);
      requests.push({ url, options });
      if (url.pathname === DISCOVERY_PATH) return json(discovery());
      if (url.pathname.endsWith('/service-plans')) {
        return json({
          items: [{
            syncId: remote.syncId,
            syncVersion: remote.syncVersion,
            revision: remote.revision,
            status: remote.status,
            title: servicePlan().title,
            serviceDate: servicePlan().serviceDate,
            startTime: servicePlan().startTime,
            changedAt: remote.changedAt
          }],
          nextCursor: null,
          hasMore: false
        });
      }
      if (url.pathname.endsWith(`/service-plans/${remote.syncId}`)) {
        return json({ plan: remote });
      }
      throw new Error(`Unexpected request: ${input}`);
    }
  });

  const page = await client.listServicePlans({
    cursor: 'page-2',
    limit: 25,
    accessToken: ACCESS_TOKEN
  });
  assert.equal(page.items[0].syncId, remote.syncId);
  assert.equal(requests[1].url.searchParams.get('cursor'), 'page-2');
  assert.equal(requests[1].url.searchParams.get('limit'), '25');
  assert.equal(
    requests[1].options.headers.Authorization,
    `SyncShow ${ACCESS_TOKEN}`
  );

  const found = await client.getServicePlan({
    syncId: remote.syncId,
    accessToken: ACCESS_TOKEN
  });
  assert.equal(found.revision, remote.revision);
  assert.deepEqual(found.plan, servicePlan());
});

test('service-plan detail schema is bounded by the advertised resource protocol', async () => {
  const cases = [
    { resourceSchemaVersion: 1, planSchemaVersion: 1, accepted: true },
    { resourceSchemaVersion: 1, planSchemaVersion: 2, accepted: false },
    { resourceSchemaVersion: 2, planSchemaVersion: 1, accepted: true },
    { resourceSchemaVersion: 2, planSchemaVersion: 2, accepted: true }
  ];

  for (const {
    resourceSchemaVersion,
    planSchemaVersion,
    accepted
  } of cases) {
    const remote = envelope(planSchemaVersion);
    const client = new CommunityClient({
      baseUrl: BASE_URL,
      fetchImpl: async input => {
        const url = new URL(input);
        if (url.pathname === DISCOVERY_PATH) {
          return json(discovery({
            resources: {
              servicePlans: resource({
                schemaVersion: resourceSchemaVersion
              })
            }
          }));
        }
        if (url.pathname.endsWith(`/service-plans/${remote.syncId}`)) {
          return json({ plan: remote });
        }
        throw new Error(`Unexpected request: ${input}`);
      }
    });
    const operation = () => client.getServicePlan({
      syncId: remote.syncId,
      accessToken: ACCESS_TOKEN
    });

    if (accepted) {
      const found = await operation();
      assert.equal(found.plan.schemaVersion, planSchemaVersion);
    } else {
      await assert.rejects(
        operation,
        error => error instanceof CommunityClientError
          && error.code === 'SERVICE_PLAN_SCHEMA_MISMATCH'
          && error.retryable === false
      );
    }
  }
});
