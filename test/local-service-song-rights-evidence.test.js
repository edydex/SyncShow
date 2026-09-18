'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  LOCAL_SERVICE_SONG_RIGHTS_BASES,
  LOCAL_SERVICE_SONG_RIGHTS_SCOPE,
  LocalServiceSongRightsEvidenceError,
  createLocalServiceSongRightsEvidence,
  normalizeLocalServiceSongRightsEvidence,
  normalizeLocalServiceSongRightsSelection
} = require('../src/services/project/LocalServiceSongRightsEvidence');
const {
  normalizeSongPublicLinkReview
} = require('../src/services/community/CommunitySongPublicLinkReview');
const {
  normalizeSongSharingReview
} = require('../src/services/community/CommunitySongSharingReview');

const REVIEWED_AT = '2026-07-28T18:00:00.000Z';

function selection(overrides = {}) {
  return {
    basis: 'ccli-service-license',
    evidence:
      'CCLI service license and exact SongSelect catalog entry reviewed.',
    ...overrides
  };
}

test('every supported basis creates one exact immutable local-intake record', () => {
  for (const basis of LOCAL_SERVICE_SONG_RIGHTS_BASES) {
    const review = createLocalServiceSongRightsEvidence(
      selection({ basis }),
      { reviewedAt: REVIEWED_AT }
    );
    assert.deepEqual(review, {
      scope: LOCAL_SERVICE_SONG_RIGHTS_SCOPE,
      basis,
      evidence:
        'CCLI service license and exact SongSelect catalog entry reviewed.',
      reviewedAt: REVIEWED_AT
    });
    assert.equal(Object.isFrozen(review), true);
    assert.deepEqual(
      normalizeLocalServiceSongRightsEvidence(review, {
        required: true,
        reviewedAt: REVIEWED_AT
      }),
      review
    );
  }
});

test('selections and durable evidence reject blanks, drift, and authority fields', () => {
  const invalidSelections = [
    selection({ basis: 'ccli-songselect' }),
    selection({ evidence: '' }),
    selection({ evidence: ' padded ' }),
    { ...selection(), visibility: 'public' },
    { ...selection(), communityAuthorityGranted: true }
  ];
  for (const candidate of invalidSelections) {
    assert.throws(
      () => normalizeLocalServiceSongRightsSelection(candidate),
      error => error instanceof LocalServiceSongRightsEvidenceError
        && error.code === 'INVALID_LOCAL_SERVICE_SONG_RIGHTS'
    );
  }

  const durable = createLocalServiceSongRightsEvidence(selection(), {
    reviewedAt: REVIEWED_AT
  });
  for (const candidate of [
    { ...durable, scope: 'community-members' },
    { ...durable, reviewedAt: '2026-07-28T18:00:01.000Z' },
    { ...durable, familyRevision: 'a'.repeat(64) },
    { ...durable, publicLink: true }
  ]) {
    assert.throws(
      () => normalizeLocalServiceSongRightsEvidence(candidate, {
        required: true,
        reviewedAt: REVIEWED_AT
      }),
      error => error instanceof LocalServiceSongRightsEvidenceError
        && error.code === 'INVALID_LOCAL_SERVICE_SONG_RIGHTS'
    );
  }
});

test('church-managed local intake does not require rights evidence', () => {
  const review = createLocalServiceSongRightsEvidence({
    basis: 'church-managed',
    evidence: ''
  }, { reviewedAt: REVIEWED_AT });

  assert.deepEqual(review, {
    scope: LOCAL_SERVICE_SONG_RIGHTS_SCOPE,
    basis: 'church-managed',
    evidence: '',
    reviewedAt: REVIEWED_AT
  });
  assert.deepEqual(
    normalizeLocalServiceSongRightsSelection({
      basis: 'church-managed',
      evidence: ''
    }),
    { basis: 'church-managed', evidence: '' }
  );
});

test('local-intake evidence never normalizes as Community member or public-link authority', () => {
  const local = createLocalServiceSongRightsEvidence(selection(), {
    reviewedAt: REVIEWED_AT
  });
  assert.throws(
    () => normalizeSongSharingReview(local, { required: true }),
    /review/i
  );
  assert.throws(
    () => normalizeSongPublicLinkReview(local, { required: true }),
    /review/i
  );
  assert.throws(
    () => normalizeLocalServiceSongRightsEvidence({
      scope: 'community-members',
      basis: 'direct-permission',
      evidence: 'Member sharing permission.',
      reviewedAt: REVIEWED_AT
    }, { required: true }),
    /scope/i
  );
  assert.throws(
    () => normalizeLocalServiceSongRightsEvidence({
      scope: 'public-link',
      basis: 'direct-permission',
      evidence: 'Anonymous web permission.',
      reviewedAt: REVIEWED_AT
    }, { required: true }),
    /scope/i
  );
});
