'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  CommunitySyncStateStore,
  CommunitySyncStateStoreError,
  PRE_PUBLIC_LINK_REVIEW_STATE_SCHEMA_VERSION,
  STATE_SCHEMA_VERSION
} = require('../src/services/community/CommunitySyncStateStore');
const {
  songPublicLinkReviewRevision
} = require('../src/services/community/CommunitySongPublicLinkReview');

const CONNECTION_ID = 'connection-00000001';
const FAMILY_ID = 'amazing-grace';
const FAMILY_REVISION = 'a'.repeat(64);

async function tempDirectory(t) {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), 'syncshow-public-link-state-')
  );
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return fs.realpath(directory);
}

function publicReview(overrides = {}) {
  return {
    basis: 'direct-permission',
    evidence: 'Written anonymous web-display permission.',
    validUntil: null,
    validThrough: null,
    familyRevision: FAMILY_REVISION,
    expectedReviewRevision: null,
    ...overrides
  };
}

test('public-link reviews are isolated, store-owned, and CAS protected', async t => {
  const root = await tempDirectory(t);
  let timestamp = '2026-07-28T12:00:00.000Z';
  const store = new CommunitySyncStateStore({
    storageRoot: root,
    now: () => new Date(timestamp)
  });

  const review = await store.confirmSongPublicLinkReview(
    CONNECTION_ID,
    FAMILY_ID,
    publicReview()
  );
  assert.equal(review.scope, 'public-link');
  assert.equal(review.validThrough, null);
  assert.equal(
    await store.getSongSharingReview(CONNECTION_ID, FAMILY_ID),
    null,
    'anonymous authority must not populate the signed-in member review lane'
  );
  assert.deepEqual(
    await store.getSongPublicLinkReview(CONNECTION_ID, FAMILY_ID),
    review
  );

  await assert.rejects(
    store.confirmSongPublicLinkReview(
      CONNECTION_ID,
      FAMILY_ID,
      publicReview({
        expectedReviewRevision: null,
        evidence: 'A stale renderer proposal.'
      })
    ),
    error => error instanceof CommunitySyncStateStoreError
      && error.code === 'STATE_CONFLICT'
  );

  const firstRevision = songPublicLinkReviewRevision(review);
  timestamp = '2026-07-28T13:00:00.000Z';
  const updated = await store.confirmSongPublicLinkReview(
    CONNECTION_ID,
    FAMILY_ID,
    publicReview({
      expectedReviewRevision: firstRevision,
      evidence: 'Renewed written anonymous web-display permission.'
    })
  );
  assert.notEqual(songPublicLinkReviewRevision(updated), firstRevision);

  await assert.rejects(
    store.confirmSongPublicLinkReview(
      CONNECTION_ID,
      'dated-family',
      publicReview({
        validUntil: '2026-08-31',
        validThrough: '2026-08-31T00:00:00.000Z',
        expectedReviewRevision: null
      })
    ),
    error => error instanceof CommunitySyncStateStoreError
      && error.code === 'INVALID_PUBLIC_LINK_REVIEW'
      && /exact permission boundary/i.test(error.message)
  );

  await store.saveConnectionState(CONNECTION_ID, {
    cursor: 'new-song-cursor',
    lastSyncAt: '2026-07-28T14:00:00.000Z',
    songs: {},
    songSharingReviews: {},
    songPublicLinkReviews: {},
    sermonCursor: null,
    lastSermonSyncAt: null,
    sermons: {}
  });
  assert.deepEqual(
    await store.getSongPublicLinkReview(CONNECTION_ID, FAMILY_ID),
    updated,
    'a whole-state sync checkpoint may not erase the audit record'
  );

  const removed = await store.clearSongPublicLinkReview(
    CONNECTION_ID,
    FAMILY_ID,
    {
      expectedFamilyRevision: FAMILY_REVISION,
      expectedReviewRevision: songPublicLinkReviewRevision(updated)
    }
  );
  assert.deepEqual(removed, { removed: true });
  assert.equal(
    await store.getSongPublicLinkReview(CONNECTION_ID, FAMILY_ID),
    null
  );
});

test('schema 4 preserves member reviews but invents no public-link authority', async t => {
  const root = await tempDirectory(t);
  const store = new CommunitySyncStateStore({
    storageRoot: root,
    now: () => new Date('2026-07-28T12:00:00.000Z')
  });
  await store.confirmSongSharingReview(CONNECTION_ID, FAMILY_ID, {
    basis: 'public-domain',
    evidence: null,
    validUntil: null,
    familyRevision: FAMILY_REVISION,
    expectedReviewRevision: null
  });

  const storePath = path.join(root, 'sync-state.json');
  const payload = JSON.parse(await fs.readFile(storePath, 'utf8'));
  assert.equal(payload.schemaVersion, STATE_SCHEMA_VERSION);
  payload.schemaVersion = PRE_PUBLIC_LINK_REVIEW_STATE_SCHEMA_VERSION;
  delete payload.connections[CONNECTION_ID].songPublicLinkReviews;
  await fs.writeFile(storePath, `${JSON.stringify(payload, null, 2)}\n`, {
    mode: 0o600
  });

  const migrated = await store.getConnectionState(CONNECTION_ID);
  assert.equal(migrated.songSharingReviews[FAMILY_ID].scope, 'community-members');
  assert.deepEqual(
    Object.keys(migrated.songPublicLinkReviews),
    [],
    'an older member review must never migrate into anonymous-link authority'
  );
});

test('public-link review validation rejects member scope smuggling in schema 5', async t => {
  const root = await tempDirectory(t);
  const payload = {
    schemaVersion: STATE_SCHEMA_VERSION,
    connections: {
      [CONNECTION_ID]: {
        cursor: null,
        lastSyncAt: null,
        songs: {},
        songSharingReviews: {},
        songPublicLinkReviews: {
          [FAMILY_ID]: {
            scope: 'community-members',
            basis: 'public-domain',
            evidence: 'Not anonymous-link authority.',
            validUntil: null,
            reviewedAt: '2026-07-28T12:00:00.000Z',
            familyRevision: FAMILY_REVISION
          }
        },
        sermonCursor: null,
        lastSermonSyncAt: null,
        sermons: {}
      }
    }
  };
  await fs.writeFile(
    path.join(root, 'sync-state.json'),
    `${JSON.stringify(payload, null, 2)}\n`
  );
  const store = new CommunitySyncStateStore({ storageRoot: root });
  await assert.rejects(
    store.getConnectionState(CONNECTION_ID),
    error => error instanceof CommunitySyncStateStoreError
      && error.code === 'INVALID_STATE'
  );
});

test('schema 5 preserves a legacy dated review but renewal records an exact boundary', async t => {
  const root = await tempDirectory(t);
  const legacyReview = {
    scope: 'public-link',
    basis: 'direct-permission',
    evidence: 'Legacy dated permission retained for audit.',
    validUntil: '2026-08-31',
    reviewedAt: '2026-07-28T12:00:00.000Z',
    familyRevision: FAMILY_REVISION
  };
  const payload = {
    schemaVersion: STATE_SCHEMA_VERSION,
    connections: {
      [CONNECTION_ID]: {
        cursor: null,
        lastSyncAt: null,
        songs: {},
        songSharingReviews: {},
        songPublicLinkReviews: {
          [FAMILY_ID]: legacyReview
        },
        sermonCursor: null,
        lastSermonSyncAt: null,
        sermons: {}
      }
    }
  };
  await fs.writeFile(
    path.join(root, 'sync-state.json'),
    `${JSON.stringify(payload, null, 2)}\n`
  );
  const store = new CommunitySyncStateStore({
    storageRoot: root,
    now: () => new Date('2026-07-29T12:00:00.000Z')
  });
  const preserved = await store.getSongPublicLinkReview(
    CONNECTION_ID,
    FAMILY_ID
  );
  assert.deepEqual(preserved, legacyReview);
  assert.equal(Object.hasOwn(preserved, 'validThrough'), false);

  const renewed = await store.confirmSongPublicLinkReview(
    CONNECTION_ID,
    FAMILY_ID,
    {
      basis: legacyReview.basis,
      evidence: 'Permission re-reviewed with an exact local boundary.',
      validUntil: legacyReview.validUntil,
      familyRevision: FAMILY_REVISION,
      expectedReviewRevision: songPublicLinkReviewRevision(preserved)
    }
  );
  assert.match(renewed.validThrough, /^\d{4}-\d{2}-\d{2}T/u);
  assert.equal(
    renewed.validThrough,
    new Date(2026, 7, 31, 23, 59, 59, 999).toISOString()
  );
});
