'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const test = require('node:test');

const {
  CommunitySongSharingReviewError,
  createSongSharingReview,
  normalizeSongSharingReview,
  songFamilyRevision,
  songSharingReviewRevision,
  songSharingReviewStatus
} = require('../src/services/community/CommunitySongSharingReview');

function familyDocument(id, revision, translationOf = null) {
  return {
    song: {
      id,
      translationOf
    },
    revision
  };
}

test('song-family review identity is canonical and covers every exact document revision', () => {
  const original = familyDocument('grace', 'a'.repeat(64));
  const russian = familyDocument('grace-ru', 'b'.repeat(64), 'grace');
  const expected = crypto.createHash('sha256')
    .update(`grace:${'a'.repeat(64)}\ngrace-ru:${'b'.repeat(64)}`)
    .digest('hex');

  assert.equal(songFamilyRevision([russian, original]), expected);
  assert.equal(songFamilyRevision([original, russian]), expected);
  assert.notEqual(
    songFamilyRevision([
      original,
      familyDocument('grace-ru', 'c'.repeat(64), 'grace')
    ]),
    expected,
    'editing a translation must invalidate the family review'
  );
  assert.notEqual(
    songFamilyRevision([
      original,
      russian,
      familyDocument('grace-es', 'd'.repeat(64), 'grace')
    ]),
    expected,
    'adding a translation must invalidate the family review'
  );
});

test('song-family identity uses locale-independent code-unit ordering', () => {
  const root = familyDocument('root', 'a'.repeat(64));
  const uppercase = familyDocument('root-Z', 'b'.repeat(64), 'root');
  const lowercase = familyDocument('root-a', 'c'.repeat(64), 'root');
  const expected = crypto.createHash('sha256')
    .update([
      `root:${'a'.repeat(64)}`,
      `root-Z:${'b'.repeat(64)}`,
      `root-a:${'c'.repeat(64)}`
    ].join('\n'))
    .digest('hex');

  assert.equal(
    songFamilyRevision([lowercase, root, uppercase]),
    expected
  );
});

test('sharing reviews reject unsupported authority and require evidence for licensed use', () => {
  assert.throws(
    () => createSongSharingReview({
      basis: 'ccli-songselect',
      evidence: '',
      validUntil: null
    }, {
      familyRevision: 'a'.repeat(64),
      reviewedAt: '2026-07-27T12:00:00.000Z'
    }),
    error => error instanceof CommunitySongSharingReviewError
      && error.code === 'INVALID_SHARING_REVIEW'
  );

  assert.throws(
    () => normalizeSongSharingReview({
      scope: 'community-members',
      basis: 'public-domain',
      evidence: null,
      validUntil: null,
      reviewedAt: '2026-07-27T12:00:00.000Z',
      familyRevision: 'a'.repeat(64),
      reviewerId: 'renderer-supplied'
    }, { required: true }),
    error => error instanceof CommunitySongSharingReviewError
      && error.code === 'INVALID_SHARING_REVIEW'
  );

  const review = createSongSharingReview({
    basis: 'direct-permission',
    evidence: '  Written permission dated 2026-07-20  ',
    validUntil: '2027-07-27'
  }, {
    familyRevision: 'a'.repeat(64),
    reviewedAt: '2026-07-27T12:00:00Z'
  });
  assert.deepEqual(review, {
    scope: 'community-members',
    basis: 'direct-permission',
    evidence: 'Written permission dated 2026-07-20',
    validUntil: '2027-07-27',
    reviewedAt: '2026-07-27T12:00:00.000Z',
    familyRevision: 'a'.repeat(64)
  });
  assert.equal(Object.isFrozen(review), true);
  assert.match(songSharingReviewRevision(review), /^[a-f0-9]{64}$/);
  const publicDomainReview = createSongSharingReview({
    basis: 'public-domain'
  }, {
    familyRevision: 'a'.repeat(64),
    reviewedAt: '2026-07-27T12:00:00.000Z'
  });
  assert.equal(
    publicDomainReview.evidence,
    '',
    'optional evidence must use Heritage protocol-v1 empty-string canonicalization'
  );
  const churchManagedReview = createSongSharingReview({
    basis: 'church-managed'
  }, {
    familyRevision: 'a'.repeat(64),
    reviewedAt: '2026-07-27T12:00:00.000Z'
  });
  assert.equal(churchManagedReview.evidence, '');
  assert.equal(churchManagedReview.validUntil, null);
  assert.equal(
    songSharingReviewStatus(churchManagedReview, {
      familyRevision: 'a'.repeat(64),
      now: '2036-07-27T12:00:00.000Z'
    }),
    'current',
    'church-managed access must not expire for missing rights metadata'
  );
  assert.notEqual(
    songSharingReviewRevision(review),
    songSharingReviewRevision({
      ...review,
      evidence: 'A different exact permission record'
    })
  );
  assert.equal(songSharingReviewRevision(null), null);
});

test('review status distinguishes missing, changed, expired, and current families', () => {
  const review = createSongSharingReview({
    basis: 'public-domain',
    validUntil: '2026-07-27'
  }, {
    familyRevision: 'a'.repeat(64),
    reviewedAt: '2026-07-26T12:00:00.000Z'
  });

  assert.equal(
    songSharingReviewStatus(null, {
      familyRevision: 'a'.repeat(64),
      now: '2026-07-27T12:00:00.000Z'
    }),
    'missing'
  );
  assert.equal(
    songSharingReviewStatus(review, {
      familyRevision: 'b'.repeat(64),
      now: '2026-07-27T12:00:00.000Z'
    }),
    'stale'
  );
  assert.equal(
    songSharingReviewStatus(review, {
      familyRevision: 'a'.repeat(64),
      now: new Date(2026, 6, 27, 12)
    }),
    'current',
    'the review-again date remains inclusive'
  );
  assert.equal(
    songSharingReviewStatus(review, {
      familyRevision: 'a'.repeat(64),
      now: new Date(2026, 6, 28, 0)
    }),
    'expired'
  );
  assert.equal(
    songSharingReviewStatus(review, {
      familyRevision: 'a'.repeat(64),
      now: new Date(2026, 6, 27, 12),
      publishAt: new Date(2026, 6, 28, 0)
    }),
    'schedule-after-expiry',
    'the calendar date is interpreted through local end-of-day'
  );
});

test('family hashing rejects duplicate IDs and noncanonical revisions', () => {
  assert.throws(
    () => songFamilyRevision([
      familyDocument('grace', 'a'.repeat(64)),
      familyDocument('grace', 'b'.repeat(64))
    ]),
    error => error instanceof CommunitySongSharingReviewError
      && error.code === 'INVALID_SONG_FAMILY'
  );
  assert.throws(
    () => songFamilyRevision([
      familyDocument('grace', 'A'.repeat(64))
    ]),
    error => error instanceof CommunitySongSharingReviewError
      && error.code === 'INVALID_SONG_FAMILY'
  );
});
