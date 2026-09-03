'use strict';

const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const {
  CommunitySongPublicLinkReviewError,
  createSongPublicLinkReview,
  normalizeSongPublicLinkReview,
  songPublicLinkReviewForRetry,
  songPublicLinkReviewRevision,
  songPublicLinkReviewStatus
} = require('../src/services/community/CommunitySongPublicLinkReview');

const FAMILY_REVISION = 'a'.repeat(64);
const REVIEW_VECTOR = JSON.parse(readFileSync(
  path.join(__dirname, 'fixtures', 'song-public-link-review-v1.json'),
  'utf8'
));

test('public-link review digest matches the shared Community server vector', () => {
  assert.equal(REVIEW_VECTOR.schemaVersion, 1);
  assert.deepEqual(
    normalizeSongPublicLinkReview(REVIEW_VECTOR.review, { required: true }),
    REVIEW_VECTOR.review
  );
  assert.equal(
    songPublicLinkReviewRevision(REVIEW_VECTOR.review),
    REVIEW_VECTOR.reviewRevision
  );
});

test('public-link reviews are a separate fixed authority with explicit evidence', () => {
  const review = createSongPublicLinkReview({
    basis: 'public-domain',
    evidence: 'Hymn text verified in the 1847 public-domain edition.',
    validUntil: null
  }, {
    familyRevision: FAMILY_REVISION,
    reviewedAt: '2026-07-28T12:00:00Z'
  });

  assert.deepEqual(review, {
    scope: 'public-link',
    basis: 'public-domain',
    evidence: 'Hymn text verified in the 1847 public-domain edition.',
    validUntil: null,
    validThrough: null,
    reviewedAt: '2026-07-28T12:00:00.000Z',
    familyRevision: FAMILY_REVISION
  });
  assert.equal(Object.isFrozen(review), true);
  assert.match(songPublicLinkReviewRevision(review), /^[a-f0-9]{64}$/u);

  assert.throws(
    () => createSongPublicLinkReview({
      basis: 'original-work',
      evidence: ''
    }, {
      familyRevision: FAMILY_REVISION,
      reviewedAt: '2026-07-28T12:00:00Z'
    }),
    error => error instanceof CommunitySongPublicLinkReviewError
      && error.code === 'INVALID_PUBLIC_LINK_REVIEW'
  );
  assert.throws(
    () => normalizeSongPublicLinkReview({
      ...review,
      scope: 'community-members'
    }, { required: true }),
    error => error instanceof CommunitySongPublicLinkReviewError
      && error.code === 'INVALID_PUBLIC_LINK_REVIEW'
  );
  assert.throws(
    () => normalizeSongPublicLinkReview({
      ...review,
      reviewerId: 'renderer-supplied'
    }, { required: true }),
    error => error instanceof CommunitySongPublicLinkReviewError
      && error.code === 'INVALID_PUBLIC_LINK_REVIEW'
  );
});

test('church-managed public links do not require rights metadata', () => {
  const review = createSongPublicLinkReview({
    basis: 'church-managed',
    evidence: '',
    validUntil: null
  }, {
    familyRevision: FAMILY_REVISION,
    reviewedAt: '2026-07-28T12:00:00Z'
  });

  assert.deepEqual(review, {
    scope: 'public-link',
    basis: 'church-managed',
    evidence: '',
    validUntil: null,
    validThrough: null,
    reviewedAt: '2026-07-28T12:00:00.000Z',
    familyRevision: FAMILY_REVISION
  });
  assert.equal(songPublicLinkReviewStatus(review, {
    familyRevision: FAMILY_REVISION,
    now: '2036-07-28T12:00:00.000Z'
  }), 'current');
  assert.deepEqual(
    songPublicLinkReviewForRetry(review, {
      basis: 'church-managed',
      evidence: '',
      validUntil: null,
      familyRevision: FAMILY_REVISION
    }),
    review
  );
});

test('public-link review status binds the exact family and link lifetime', () => {
  const review = createSongPublicLinkReview({
    basis: 'direct-permission',
    evidence: 'Written worldwide web-display permission.',
    validUntil: '2026-08-31'
  }, {
    familyRevision: FAMILY_REVISION,
    reviewedAt: '2026-07-28T12:00:00Z'
  });
  const validThrough = new Date(
    2026,
    7,
    31,
    23,
    59,
    59,
    999
  ).toISOString();
  assert.equal(review.validThrough, validThrough);

  assert.equal(songPublicLinkReviewStatus(null, {
    familyRevision: FAMILY_REVISION
  }), 'missing');
  assert.equal(songPublicLinkReviewStatus(review, {
    familyRevision: 'b'.repeat(64),
    now: new Date(2026, 6, 29)
  }), 'stale');
  assert.equal(songPublicLinkReviewStatus(review, {
    familyRevision: FAMILY_REVISION,
    now: new Date(2026, 6, 29),
    expiresAt: null
  }), 'nonexpiring-after-review');
  assert.equal(songPublicLinkReviewStatus(review, {
    familyRevision: FAMILY_REVISION,
    now: new Date(2026, 6, 29),
    expiresAt: new Date(Date.parse(validThrough) - 60_000)
  }), 'current');
  assert.equal(songPublicLinkReviewStatus(review, {
    familyRevision: FAMILY_REVISION,
    now: new Date(2026, 6, 29),
    expiresAt: new Date(Date.parse(validThrough) + 1)
  }), 'link-after-review');
  assert.equal(songPublicLinkReviewStatus(review, {
    familyRevision: FAMILY_REVISION,
    now: new Date(Date.parse(validThrough) + 1),
    expiresAt: new Date(Date.parse(validThrough) + 1)
  }), 'expired');
});

test('legacy dated reviews remain auditable but cannot authorize another link', () => {
  const legacy = {
    scope: 'public-link',
    basis: 'direct-permission',
    evidence: 'Legacy dated review retained for audit.',
    validUntil: '2026-08-31',
    reviewedAt: '2026-07-28T12:00:00.000Z',
    familyRevision: FAMILY_REVISION
  };
  assert.match(songPublicLinkReviewRevision(legacy), /^[a-f0-9]{64}$/u);
  assert.equal(songPublicLinkReviewStatus(legacy, {
    familyRevision: FAMILY_REVISION,
    now: new Date('2026-07-29T00:00:00.000Z'),
    expiresAt: new Date('2026-08-01T00:00:00.000Z')
  }), 'boundary-missing');
  assert.throws(
    () => normalizeSongPublicLinkReview(legacy, { required: true }),
    error => error instanceof CommunitySongPublicLinkReviewError
      && error.code === 'INVALID_PUBLIC_LINK_REVIEW'
  );
});

test('an ambiguous retry reuses its exact boundary after the machine timezone changes', () => {
  const previousTimeZone = process.env.TZ;
  try {
    process.env.TZ = 'America/Los_Angeles';
    const held = createSongPublicLinkReview({
      basis: 'direct-permission',
      evidence: 'Written permission through the reviewed local day.',
      validUntil: '2026-08-31'
    }, {
      familyRevision: FAMILY_REVISION,
      reviewedAt: '2026-07-28T12:00:00.000Z'
    });
    assert.equal(held.validThrough, '2026-09-01T06:59:59.999Z');

    process.env.TZ = 'America/New_York';
    const newlyDerived = createSongPublicLinkReview({
      basis: held.basis,
      evidence: held.evidence,
      validUntil: held.validUntil
    }, {
      familyRevision: held.familyRevision,
      reviewedAt: held.reviewedAt
    });
    assert.equal(newlyDerived.validThrough, '2026-09-01T03:59:59.999Z');

    const retried = songPublicLinkReviewForRetry(held, {
      basis: held.basis,
      evidence: held.evidence,
      validUntil: held.validUntil,
      familyRevision: held.familyRevision
    });
    assert.equal(retried.validThrough, '2026-09-01T06:59:59.999Z');
    assert.equal(
      songPublicLinkReviewRevision(retried),
      songPublicLinkReviewRevision(held)
    );
    assert.throws(
      () => songPublicLinkReviewForRetry(held, {
        basis: held.basis,
        evidence: 'Different permission evidence.',
        validUntil: held.validUntil,
        familyRevision: held.familyRevision
      }),
      error => error instanceof CommunitySongPublicLinkReviewError
        && error.code === 'PUBLIC_LINK_REVIEW_RETRY_MISMATCH'
    );
  } finally {
    if (previousTimeZone === undefined) delete process.env.TZ;
    else process.env.TZ = previousTimeZone;
  }
});

test('a review digest changes with evidence and never aliases a member review', () => {
  const review = createSongPublicLinkReview({
    basis: 'specific-web-license',
    evidence: 'License grant 2026-17, section 3.',
    validUntil: null
  }, {
    familyRevision: FAMILY_REVISION,
    reviewedAt: '2026-07-28T12:00:00Z'
  });
  assert.notEqual(
    songPublicLinkReviewRevision(review),
    songPublicLinkReviewRevision({
      ...review,
      evidence: 'License grant 2026-18, section 4.'
    })
  );
  assert.equal(songPublicLinkReviewRevision(null), null);
});
