'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');

const {
  CommunityClient,
  CommunityClientError,
  DISCOVERY_PATH,
  SERMON_MEDIA_SCOPES
} = require('../src/services/community/CommunityClient');

const BASE_URL = 'https://community.example.test/';
const fixturePath = path.join(
  __dirname,
  'fixtures',
  'community-sermon-media-wire-v1.json'
);

function json(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json' }
  });
}

function discovery(resources) {
  return {
    schemaVersion: 1,
    id: 'wotbc',
    name: 'WOTBC',
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

function sermons() {
  return {
    schemaVersion: 1,
    endpoint: 'sermons',
    scopes: [
      'syncshow:sermons:read',
      'syncshow:sermons:write'
    ]
  };
}

function client(payload) {
  return new CommunityClient({
    baseUrl: BASE_URL,
    fetchImpl: async input => {
      assert.equal(new URL(input).pathname, DISCOVERY_PATH);
      return json(payload);
    }
  });
}

async function fixture() {
  return JSON.parse(await fs.readFile(fixturePath, 'utf8'));
}

test('discovery accepts only the exact managed sermon-media v1 descriptor', async () => {
  const vector = await fixture();
  const found = await client(discovery({
    sermons: sermons(),
    sermonMedia: vector.discoveryResource
  })).discover();

  assert.equal(found.schemaVersion, 2);
  assert.equal(found.capabilities.sermonMedia, true);
  assert.deepEqual(found.resources.sermonMedia, {
    schemaVersion: 1,
    endpoint:
      `${BASE_URL}api/community/syncshow/v1/sermon-media`,
    scopes: [...SERMON_MEDIA_SCOPES].sort(),
    chunkSizeBytes: 8_388_608,
    maximumBytes: 1_073_741_824,
    acceptedMediaTypes: ['audio/mp4', 'audio/mpeg'],
    sessionTtlSeconds: 604_800
  });
  assert.deepEqual(
    found.scopes,
    [
      ...sermons().scopes,
      ...SERMON_MEDIA_SCOPES
    ].sort()
  );
});

test('older discovery remains usable and explicitly has no managed upload lane', async () => {
  const found = await client(discovery({
    sermons: sermons()
  })).discover();

  assert.equal(found.capabilities.sermonMedia, false);
  assert.equal(found.resources.sermonMedia, null);
  assert.ok(!found.scopes.some(scope => scope.includes('sermon-media')));
});

test('sermon-media discovery fails closed on drift, extras, or missing sermon dependency', async () => {
  const vector = await fixture();
  const variants = [
    {
      label: 'extra field',
      resources: {
        sermons: sermons(),
        sermonMedia: { ...vector.discoveryResource, publicUrl: '/unsafe' }
      },
      code: 'INVALID_DISCOVERY'
    },
    {
      label: 'endpoint drift',
      resources: {
        sermons: sermons(),
        sermonMedia: {
          ...vector.discoveryResource,
          endpoint: 'uploads'
        }
      },
      code: 'INVALID_DISCOVERY'
    },
    {
      label: 'scope drift',
      resources: {
        sermons: sermons(),
        sermonMedia: {
          ...vector.discoveryResource,
          scopes: ['syncshow:sermon-media:read']
        }
      },
      code: 'INVALID_DISCOVERY'
    },
    {
      label: 'media type drift',
      resources: {
        sermons: sermons(),
        sermonMedia: {
          ...vector.discoveryResource,
          acceptedMediaTypes: ['audio/mpeg', 'video/mp4']
        }
      },
      code: 'INVALID_DISCOVERY'
    },
    {
      label: 'duplicate media type',
      resources: {
        sermons: sermons(),
        sermonMedia: {
          ...vector.discoveryResource,
          acceptedMediaTypes: [
            'audio/mpeg',
            'audio/mp4',
            'audio/mpeg'
          ]
        }
      },
      code: 'INVALID_DISCOVERY'
    },
    {
      label: 'transfer-limit drift',
      resources: {
        sermons: sermons(),
        sermonMedia: {
          ...vector.discoveryResource,
          chunkSizeBytes: 4_194_304
        }
      },
      code: 'SYNC_UNSUPPORTED'
    },
    {
      label: 'missing sermon dependency',
      resources: {
        sermonMedia: vector.discoveryResource
      },
      code: 'INVALID_DISCOVERY'
    }
  ];

  for (const variant of variants) {
    await assert.rejects(
      client(discovery(variant.resources)).discover(),
      error => {
        assert.ok(error instanceof CommunityClientError, variant.label);
        assert.equal(error.code, variant.code, variant.label);
        return true;
      }
    );
  }
});
