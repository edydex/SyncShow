'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const test = require('node:test');

const {
  CommunityClient,
  CommunityClientError,
  DISCOVERY_PATH
} = require('../src/services/community/CommunityClient');

const BASE_URL = 'https://community.example.test/';
const ACCESS_TOKEN = 'community-public-links-token-000001';
const SONG_ID = 'amazing-grace';
const FAMILY_REVISION = 'a'.repeat(64);
const ACTIVE_LINK_ID = 'A'.repeat(32);
const EXPIRED_LINK_ID = 'B'.repeat(32);
const REVOKED_LINK_ID = 'C'.repeat(32);
const NOW = new Date('2026-07-28T12:00:00.000Z');

function json(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json' }
  });
}

function songResource(scopes = ['syncshow:songs:read', 'syncshow:songs:write']) {
  return {
    schemaVersion: 1,
    endpoint: 'songs',
    scopes
  };
}

function publicLinkResource(
  scopes = [
    'syncshow:song-public-links:read',
    'syncshow:song-public-links:write'
  ]
) {
  return {
    schemaVersion: 1,
    endpoint: 'song-public-links',
    publicBaseUrl: '/community/songs/shared/',
    scopes
  };
}

function discovery(resources = {
  songs: songResource(),
  songPublicLinks: publicLinkResource()
}) {
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

function review(overrides = {}) {
  return {
    scope: 'public-link',
    basis: 'direct-permission',
    evidence: 'Written permission for anonymous web sharing dated 2026-07-20.',
    validUntil: null,
    validThrough: null,
    reviewedAt: '2026-07-28T11:55:00.000Z',
    familyRevision: FAMILY_REVISION,
    ...overrides
  };
}

function reviewRevision(value) {
  return crypto.createHash('sha256')
    .update(JSON.stringify([
      value.scope,
      value.basis,
      value.evidence,
      value.validUntil,
      value.validThrough,
      value.reviewedAt,
      value.familyRevision
    ]))
    .digest('hex');
}

function linkRecord(overrides = {}) {
  return {
    schemaVersion: 1,
    linkId: ACTIVE_LINK_ID,
    linkVersion: 1,
    songSyncId: SONG_ID,
    songSyncVersion: 7,
    familyRevision: FAMILY_REVISION,
    reviewRevision: reviewRevision(review()),
    label: 'Tuesday home group',
    createdAt: '2026-07-28T11:59:00.000Z',
    expiresAt: null,
    revokedAt: null,
    ...overrides
  };
}

test('absent and read-only public-link lanes reject writes before a link request', async () => {
  const absentRequests = [];
  const absent = new CommunityClient({
    baseUrl: BASE_URL,
    fetchImpl: async (input, options) => {
      absentRequests.push({ input, options });
      return json(discovery({ songs: songResource() }));
    }
  });
  await assert.rejects(
    absent.listSongPublicLinks({
      songSyncId: SONG_ID,
      accessToken: ACCESS_TOKEN
    }),
    error => error instanceof CommunityClientError
      && error.code === 'SONG_PUBLIC_LINKS_UNSUPPORTED'
  );
  assert.equal(absentRequests.length, 1);
  assert.equal(new URL(absentRequests[0].input).pathname, DISCOVERY_PATH);

  const readOnlyRequests = [];
  const readOnly = new CommunityClient({
    baseUrl: BASE_URL,
    fetchImpl: async (input, options) => {
      readOnlyRequests.push({ input, options });
      return json(discovery({
        songs: songResource(['syncshow:songs:read']),
        songPublicLinks: publicLinkResource([
          'syncshow:song-public-links:read'
        ])
      }));
    }
  });
  const exactReview = review();
  await assert.rejects(
    readOnly.createSongPublicLink({
      songSyncId: SONG_ID,
      songSyncVersion: 7,
      familyRevision: FAMILY_REVISION,
      review: exactReview,
      reviewRevision: reviewRevision(exactReview),
      idempotencyKey: 'public-link-create-0001',
      accessToken: ACCESS_TOKEN
    }),
    error => error instanceof CommunityClientError
      && error.code === 'SONG_PUBLIC_LINK_SCOPE_UNAVAILABLE'
  );
  await assert.rejects(
    readOnly.revokeSongPublicLink({
      linkId: ACTIVE_LINK_ID,
      expectedLinkVersion: 1,
      idempotencyKey: 'public-link-revoke-0001',
      accessToken: ACCESS_TOKEN
    }),
    error => error instanceof CommunityClientError
      && error.code === 'SONG_PUBLIC_LINK_SCOPE_UNAVAILABLE'
  );
  assert.equal(readOnlyRequests.length, 1);
});

test('listing public links is bounded, authenticated, and derives only active share URLs', async () => {
  const requests = [];
  const client = new CommunityClient({
    baseUrl: BASE_URL,
    now: () => NOW,
    fetchImpl: async (input, options) => {
      const url = new URL(input);
      requests.push({ url, options });
      if (url.pathname === DISCOVERY_PATH) return json(discovery());
      return json({
        items: [
          linkRecord(),
          linkRecord({
            linkId: EXPIRED_LINK_ID,
            expiresAt: '2026-07-28T11:59:59.999Z'
          }),
          linkRecord({
            linkId: REVOKED_LINK_ID,
            linkVersion: 2,
            revokedAt: '2026-07-28T11:59:30.000Z'
          })
        ],
        nextCursor: ' cursor/+?= ',
        hasMore: true
      });
    }
  });

  const page = await client.listSongPublicLinks({
    songSyncId: SONG_ID,
    cursor: ' prior/+?= ',
    limit: 3,
    accessToken: ACCESS_TOKEN
  });

  assert.equal(requests[1].url.pathname, '/api/community/syncshow/v1/song-public-links');
  assert.equal(requests[1].url.searchParams.get('songSyncId'), SONG_ID);
  assert.equal(requests[1].url.searchParams.get('cursor'), ' prior/+?= ');
  assert.equal(requests[1].url.searchParams.get('limit'), '3');
  assert.equal(requests[1].options.headers.Authorization, `SyncShow ${ACCESS_TOKEN}`);
  assert.equal(
    page.items[0].shareUrl,
    `${BASE_URL}community/songs/shared/${ACTIVE_LINK_ID}`
  );
  assert.equal(page.items[0].status, 'active');
  assert.equal(page.items[1].status, 'expired');
  assert.equal(page.items[1].shareUrl, null);
  assert.equal(page.items[2].status, 'revoked');
  assert.equal(page.items[2].shareUrl, null);
  assert.equal(page.nextCursor, ' cursor/+?= ');
  assert.equal(page.hasMore, true);
  assert.equal(Object.isFrozen(page.items), true);
});

test('creating a link sends exact CAS and idempotency headers and verifies the echo', async () => {
  const requests = [];
  const exactReview = review({
    basis: 'specific-web-license',
    evidence: 'License grant 2026-17, section 3, covers anonymous web display.'
  });
  const exactReviewRevision = reviewRevision(exactReview);
  const client = new CommunityClient({
    baseUrl: BASE_URL,
    now: () => NOW,
    fetchImpl: async (input, options) => {
      const url = new URL(input);
      requests.push({ url, options });
      if (url.pathname === DISCOVERY_PATH) return json(discovery());
      return json({
        link: linkRecord({
          reviewRevision: exactReviewRevision,
          label: 'Tuesday home group',
          createdAt: '2026-07-28T12:00:01.000Z'
        })
      }, 201);
    }
  });

  const created = await client.createSongPublicLink({
    songSyncId: SONG_ID,
    songSyncVersion: 7,
    familyRevision: FAMILY_REVISION,
    review: exactReview,
    reviewRevision: exactReviewRevision,
    label: '  Tuesday home group  ',
    expiresAt: null,
    idempotencyKey: 'public-link-create-0001',
    accessToken: ACCESS_TOKEN
  });

  assert.equal(requests[1].options.method, 'POST');
  assert.equal(
    requests[1].options.headers['If-Match'],
    `"song:${SONG_ID}:7"`
  );
  assert.equal(
    requests[1].options.headers['Idempotency-Key'],
    'public-link-create-0001'
  );
  assert.deepEqual(JSON.parse(requests[1].options.body), {
    songSyncId: SONG_ID,
    familyRevision: FAMILY_REVISION,
    review: exactReview,
    reviewRevision: exactReviewRevision,
    label: 'Tuesday home group',
    expiresAt: null
  });
  assert.equal(created.songSyncVersion, 7);
  assert.equal(created.familyRevision, FAMILY_REVISION);
  assert.equal(
    created.shareUrl,
    `${BASE_URL}community/songs/shared/${ACTIVE_LINK_ID}`
  );
});

test('revoking a link uses link CAS plus idempotency and requires an advanced tombstone', async () => {
  const requests = [];
  const client = new CommunityClient({
    baseUrl: BASE_URL,
    now: () => NOW,
    fetchImpl: async (input, options) => {
      const url = new URL(input);
      requests.push({ url, options });
      if (url.pathname === DISCOVERY_PATH) return json(discovery());
      return json({
        link: linkRecord({
          linkVersion: 4,
          revokedAt: '2026-07-28T12:00:02.000Z'
        })
      });
    }
  });

  const revoked = await client.revokeSongPublicLink({
    linkId: ACTIVE_LINK_ID,
    expectedLinkVersion: 3,
    idempotencyKey: 'public-link-revoke-0001',
    accessToken: ACCESS_TOKEN
  });

  assert.equal(
    requests[1].url.pathname,
    `/api/community/syncshow/v1/song-public-links/${ACTIVE_LINK_ID}`
  );
  assert.equal(requests[1].options.method, 'DELETE');
  assert.equal(
    requests[1].options.headers['If-Match'],
    `"song-public-link:${ACTIVE_LINK_ID}:3"`
  );
  assert.equal(
    requests[1].options.headers['Idempotency-Key'],
    'public-link-revoke-0001'
  );
  assert.equal(revoked.linkVersion, 4);
  assert.equal(revoked.status, 'revoked');
  assert.equal(revoked.shareUrl, null);
});

test('public-link reviews are strict, exact-family, evidence-bearing records', async () => {
  const requests = [];
  const client = new CommunityClient({
    baseUrl: BASE_URL,
    now: () => NOW,
    fetchImpl: async (input, options) => {
      requests.push({ input, options });
      return json(discovery());
    }
  });
  const cases = [
    review({ scope: 'community-members' }),
    review({ basis: 'ccli-songselect' }),
    review({ evidence: '' }),
    review({ familyRevision: 'b'.repeat(64) }),
    { ...review(), rendererAuthority: true }
  ];
  for (const candidate of cases) {
    await assert.rejects(
      client.createSongPublicLink({
        songSyncId: SONG_ID,
        songSyncVersion: 7,
        familyRevision: FAMILY_REVISION,
        review: candidate,
        reviewRevision: reviewRevision(candidate),
        idempotencyKey: 'public-link-create-0002',
        accessToken: ACCESS_TOKEN
      }),
      error => error instanceof CommunityClientError
        && error.code === 'INVALID_INPUT'
    );
  }

  const dated = review({
    validUntil: '2026-07-30',
    validThrough: '2026-07-30T23:59:59.999Z'
  });
  await assert.rejects(
    client.createSongPublicLink({
      songSyncId: SONG_ID,
      songSyncVersion: 7,
      familyRevision: FAMILY_REVISION,
      review: dated,
      reviewRevision: reviewRevision(dated),
      expiresAt: null,
      idempotencyKey: 'public-link-create-0003',
      accessToken: ACCESS_TOKEN
    }),
    error => error instanceof CommunityClientError
      && error.code === 'INVALID_INPUT'
      && /cannot outlast/i.test(error.message)
  );
  assert.equal(
    requests.length,
    1,
    'invalid reviews must stop after the cached discovery response'
  );
});

test('malformed and non-echoing public-link responses fail closed', async () => {
  const exactReview = review();
  const exactReviewRevision = reviewRevision(exactReview);
  const variants = [
    {
      label: 'low-entropy link ID',
      record: linkRecord({ linkId: 'too-short' }),
      code: 'INVALID_RESPONSE'
    },
    {
      label: 'noncanonical base64url link ID',
      record: linkRecord({ linkId: 'A'.repeat(33) }),
      code: 'INVALID_RESPONSE'
    },
    {
      label: 'noncanonical timestamp',
      record: linkRecord({ createdAt: '2026-07-28T12:00:01Z' }),
      code: 'INVALID_RESPONSE'
    },
    {
      label: 'normalized response song identity',
      record: linkRecord({ songSyncId: ` ${SONG_ID}` }),
      code: 'INVALID_RESPONSE'
    },
    {
      label: 'normalized response label',
      record: linkRecord({ label: ' Tuesday home group' }),
      code: 'INVALID_RESPONSE'
    },
    {
      label: 'extra response authority',
      record: { ...linkRecord(), publicUrl: 'https://attacker.invalid/' },
      code: 'INVALID_RESPONSE'
    },
    {
      label: 'different family',
      record: linkRecord({ familyRevision: 'b'.repeat(64) }),
      code: 'PUBLIC_LINK_NOT_APPLIED'
    },
    {
      label: 'different song version',
      record: linkRecord({ songSyncVersion: 8 }),
      code: 'PUBLIC_LINK_NOT_APPLIED'
    },
    {
      label: 'already revoked create',
      record: linkRecord({ revokedAt: '2026-07-28T12:00:02.000Z' }),
      code: 'PUBLIC_LINK_NOT_APPLIED'
    }
  ];

  for (const variant of variants) {
    const client = new CommunityClient({
      baseUrl: BASE_URL,
      now: () => NOW,
      fetchImpl: async input => {
        if (new URL(input).pathname === DISCOVERY_PATH) return json(discovery());
        return json({ link: variant.record }, 201);
      }
    });
    await assert.rejects(
      client.createSongPublicLink({
        songSyncId: SONG_ID,
        songSyncVersion: 7,
        familyRevision: FAMILY_REVISION,
        review: exactReview,
        reviewRevision: exactReviewRevision,
        label: 'Tuesday home group',
        idempotencyKey: 'public-link-create-0004',
        accessToken: ACCESS_TOKEN
      }),
      error => error instanceof CommunityClientError
        && error.code === variant.code,
      variant.label
    );
  }
});

test('public-link pages reject overflow, cursor drift, and cross-song records', async () => {
  const variants = [
    {
      payload: {
        items: [linkRecord(), linkRecord({ linkId: 'D'.repeat(32) })],
        nextCursor: null,
        hasMore: false
      },
      limit: 1
    },
    {
      payload: {
        items: [],
        nextCursor: null,
        hasMore: true
      },
      limit: 50
    },
    {
      payload: {
        items: [linkRecord({ songSyncId: 'another-song' })],
        nextCursor: null,
        hasMore: false
      },
      limit: 50
    }
  ];

  for (const variant of variants) {
    const client = new CommunityClient({
      baseUrl: BASE_URL,
      now: () => NOW,
      fetchImpl: async input => {
        if (new URL(input).pathname === DISCOVERY_PATH) return json(discovery());
        return json(variant.payload);
      }
    });
    await assert.rejects(
      client.listSongPublicLinks({
        songSyncId: SONG_ID,
        limit: variant.limit,
        accessToken: ACCESS_TOKEN
      }),
      error => error instanceof CommunityClientError
        && error.code === 'INVALID_RESPONSE'
    );
  }
});

test('public-link pages reject duplicate link identities', async () => {
  const variants = [
    [linkRecord(), linkRecord()],
    [
      linkRecord(),
      linkRecord({
        linkVersion: 2,
        label: 'Renewed purpose'
      })
    ]
  ];

  for (const items of variants) {
    const client = new CommunityClient({
      baseUrl: BASE_URL,
      now: () => NOW,
      fetchImpl: async input => {
        if (new URL(input).pathname === DISCOVERY_PATH) return json(discovery());
        return json({
          items,
          nextCursor: null,
          hasMore: false
        });
      }
    });
    await assert.rejects(
      client.listSongPublicLinks({
        songSyncId: SONG_ID,
        accessToken: ACCESS_TOKEN
      }),
      error => error instanceof CommunityClientError
        && error.code === 'INVALID_RESPONSE'
    );
  }
});
