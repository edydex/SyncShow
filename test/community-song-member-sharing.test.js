'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const fixture = require('./fixtures/song-member-sharing-wire-v1.json');
const {
  buildSongMemberSharingRequest,
  normalizeSongMemberSharingReceipt,
  normalizeSongMemberSharingResponse,
  songMemberSharingRequestRevision
} = require('../src/services/community/CommunitySongMemberSharing');
const {
  songSharingReviewRevision
} = require('../src/services/community/CommunitySongSharingReview');

test('SyncShow and Heritage share the exact member-sharing wire digests', () => {
  assert.equal(
    songSharingReviewRevision(fixture.request.review),
    fixture.request.reviewRevision
  );
  const built = buildSongMemberSharingRequest({
    syncId: fixture.songSyncId,
    expectedSyncVersion: fixture.expectedSongSyncVersion,
    familyRevision: fixture.request.familyRevision,
    review: fixture.request.review,
    reviewRevision: fixture.request.reviewRevision,
    visibility: fixture.request.visibility,
    publishAt: fixture.request.publishAt
  });
  assert.deepEqual(built.body, fixture.request);
  assert.equal(built.requestRevision, fixture.expectedRequestRevision);
  assert.equal(built.idempotencyKey, fixture.expectedRequestRevision);
  assert.equal(songMemberSharingRequestRevision({
    syncId: fixture.songSyncId,
    expectedSyncVersion: fixture.expectedSongSyncVersion,
    familyRevision: fixture.request.familyRevision,
    reviewRevision: fixture.request.reviewRevision,
    visibility: fixture.request.visibility,
    publishAt: fixture.request.publishAt
  }), fixture.expectedRequestRevision);

  const receipt = normalizeSongMemberSharingResponse({
    receipt: fixture.receipt
  }, {
    expected: built,
    review: fixture.request.review
  });
  assert.deepEqual(receipt, fixture.receipt);
  assert.equal(receipt.receiptRevision, fixture.expectedReceiptRevision);
});

test('member-sharing receipt verification rejects substitution and nonexact shapes', () => {
  const cases = [
    {
      ...fixture.receipt,
      visibility: 'scheduled-public'
    },
    {
      ...fixture.receipt,
      songSyncVersion: fixture.receipt.songSyncVersion + 1
    },
    {
      ...fixture.receipt,
      validThrough: '2026-09-01T06:59:59.998Z'
    },
    {
      ...fixture.receipt,
      evidence: 'must never be returned'
    }
  ];
  for (const candidate of cases) {
    assert.throws(
      () => normalizeSongMemberSharingReceipt(candidate, {
        review: fixture.request.review
      }),
      error => [
        'INVALID_MEMBER_SHARING_RECEIPT',
        'MEMBER_SHARING_NOT_CONFIRMED'
      ].includes(error.code)
    );
  }
});

test('member-sharing request refuses legacy review authority and extra fields', () => {
  assert.throws(
    () => buildSongMemberSharingRequest({
      syncId: fixture.songSyncId,
      expectedSyncVersion: fixture.expectedSongSyncVersion,
      familyRevision: fixture.request.familyRevision,
      review: {
        ...fixture.request.review,
        basis: 'ccli-songselect'
      },
      reviewRevision: fixture.request.reviewRevision,
      visibility: fixture.request.visibility,
      publishAt: fixture.request.publishAt
    }),
    error => error.code === 'INVALID_MEMBER_SHARING_REQUEST'
  );
  assert.throws(
    () => buildSongMemberSharingRequest({
      syncId: fixture.songSyncId,
      expectedSyncVersion: fixture.expectedSongSyncVersion,
      familyRevision: fixture.request.familyRevision,
      review: fixture.request.review,
      reviewRevision: fixture.request.reviewRevision,
      visibility: fixture.request.visibility,
      publishAt: fixture.request.publishAt,
      operation: 'publish'
    }),
    error => error.code === 'INVALID_MEMBER_SHARING_REQUEST'
  );
});
