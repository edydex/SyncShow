'use strict';

const crypto = require('crypto');

const {
  CommunitySongSharingReviewError,
  normalizeSongSharingReview,
  songSharingReviewRevision
} = require('./CommunitySongSharingReview');

const SONG_MEMBER_SHARING_SCHEMA_VERSION = 1;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const SYNC_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const RECEIPT_ID_PATTERN = /^[A-Za-z0-9_-]{32,128}$/;
const CANONICAL_TIMESTAMP_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const REQUEST_KEYS = Object.freeze([
  'schemaVersion',
  'familyRevision',
  'review',
  'reviewRevision',
  'visibility',
  'publishAt'
]);
const RECEIPT_KEYS = Object.freeze([
  'schemaVersion',
  'receiptId',
  'receiptVersion',
  'songSyncId',
  'previousSongSyncVersion',
  'songSyncVersion',
  'familyRevision',
  'reviewRevision',
  'visibility',
  'publishAt',
  'timeZone',
  'validThrough',
  'reviewedAt',
  'confirmedAt',
  'requestRevision',
  'receiptRevision'
]);

class CommunitySongMemberSharingError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'CommunitySongMemberSharingError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new CommunitySongMemberSharingError(code, message);
}

function exactRecord(value, keys, label, code) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail(code, `${label} is invalid.`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    fail(code, `${label} is invalid.`);
  }
  if (Object.keys(value).length !== keys.length
    || keys.some(key => !Object.prototype.hasOwnProperty.call(value, key))) {
    fail(code, `${label} contains unsupported or missing fields.`);
  }
}

function sha256(value) {
  return crypto.createHash('sha256')
    .update(JSON.stringify(value), 'utf8')
    .digest('hex');
}

function canonicalTimestamp(value, label, { nullable = false } = {}) {
  if (nullable && value === null) return null;
  if (typeof value !== 'string'
    || !CANONICAL_TIMESTAMP_PATTERN.test(value)
    || !Number.isFinite(Date.parse(value))
    || new Date(value).toISOString() !== value) {
    fail('INVALID_MEMBER_SHARING_RECEIPT', `${label} is invalid.`);
  }
  return value;
}

function positiveVersion(value, label) {
  if (!Number.isSafeInteger(value) || value < 1) {
    fail('INVALID_MEMBER_SHARING_RECEIPT', `${label} is invalid.`);
  }
  return value;
}

function hash(value, label, code = 'INVALID_MEMBER_SHARING_RECEIPT') {
  if (typeof value !== 'string' || !SHA256_PATTERN.test(value)) {
    fail(code, `${label} is invalid.`);
  }
  return value;
}

function syncId(value, code = 'INVALID_MEMBER_SHARING_RECEIPT') {
  if (typeof value !== 'string' || !SYNC_ID_PATTERN.test(value)) {
    fail(code, 'Song sync ID is invalid.');
  }
  return value;
}

function memberVisibility(value, publishAt, {
  code = 'INVALID_MEMBER_SHARING_RECEIPT'
} = {}) {
  if (!['public', 'scheduled-public'].includes(value)) {
    fail(code, 'Song member visibility is invalid.');
  }
  const scheduled = publishAt === null
    ? null
    : canonicalTimestamp(publishAt, 'Scheduled member-sharing time');
  if ((value === 'scheduled-public') !== (scheduled !== null)) {
    fail(code, 'Song member visibility and schedule do not match.');
  }
  return { visibility: value, publishAt: scheduled };
}

function normalizeTimeZone(value) {
  if (typeof value !== 'string'
    || value.length < 1
    || value.length > 128
    || /[\u0000-\u001f\u007f]/u.test(value)
    || value.trim() !== value) {
    fail('INVALID_MEMBER_SHARING_RECEIPT', 'Community time zone is invalid.');
  }
  try {
    new Intl.DateTimeFormat('en-US', {
      timeZone: value
    }).format(new Date(0));
  } catch (_error) {
    fail('INVALID_MEMBER_SHARING_RECEIPT', 'Community time zone is invalid.');
  }
  return value;
}

function assertValidityBoundary(validUntil, validThrough, timeZone) {
  if ((validUntil === null) !== (validThrough === null)) {
    fail(
      'INVALID_MEMBER_SHARING_RECEIPT',
      'Community review date and validity boundary do not match.'
    );
  }
  if (validThrough === null) return;
  let parts;
  try {
    parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      fractionalSecondDigits: 3,
      hourCycle: 'h23'
    }).formatToParts(new Date(validThrough))
      .filter(part => part.type !== 'literal')
      .map(part => [part.type, part.value]));
  } catch (_error) {
    fail(
      'INVALID_MEMBER_SHARING_RECEIPT',
      'Community review validity boundary is invalid.'
    );
  }
  if (`${parts.year}-${parts.month}-${parts.day}` !== validUntil
    || parts.hour !== '23'
    || parts.minute !== '59'
    || parts.second !== '59'
    || parts.fractionalSecond !== '999') {
    fail(
      'INVALID_MEMBER_SHARING_RECEIPT',
      'Community review validity boundary does not match its civil date and time zone.'
    );
  }
}

function normalizeReview(value, {
  familyRevision,
  reviewRevision,
  code = 'INVALID_MEMBER_SHARING_REQUEST'
} = {}) {
  let review;
  try {
    review = normalizeSongSharingReview(value, { required: true });
  } catch (error) {
    if (error instanceof CommunitySongSharingReviewError) {
      fail(code, error.message);
    }
    throw error;
  }
  if (review.familyRevision !== familyRevision
    || songSharingReviewRevision(review) !== reviewRevision) {
    fail(code, 'Song member-sharing review does not match the exact family.');
  }
  return review;
}

function songMemberSharingRequestRevision({
  syncId: rawSyncId,
  expectedSyncVersion,
  familyRevision,
  reviewRevision,
  visibility,
  publishAt
} = {}) {
  const id = syncId(rawSyncId, 'INVALID_MEMBER_SHARING_REQUEST');
  if (!Number.isSafeInteger(expectedSyncVersion) || expectedSyncVersion < 1) {
    fail(
      'INVALID_MEMBER_SHARING_REQUEST',
      'Expected Community song version is invalid.'
    );
  }
  return sha256([
    SONG_MEMBER_SHARING_SCHEMA_VERSION,
    id,
    expectedSyncVersion,
    hash(
      familyRevision,
      'Song-family revision',
      'INVALID_MEMBER_SHARING_REQUEST'
    ),
    hash(
      reviewRevision,
      'Song member-sharing review revision',
      'INVALID_MEMBER_SHARING_REQUEST'
    ),
    visibility,
    publishAt
  ]);
}

function buildSongMemberSharingRequest(value = {}) {
  exactRecord(
    value,
    [
      'syncId',
      'expectedSyncVersion',
      'familyRevision',
      'review',
      'reviewRevision',
      'visibility',
      'publishAt'
    ],
    'Song member-sharing request',
    'INVALID_MEMBER_SHARING_REQUEST'
  );
  const id = syncId(value.syncId, 'INVALID_MEMBER_SHARING_REQUEST');
  if (!Number.isSafeInteger(value.expectedSyncVersion)
    || value.expectedSyncVersion < 1) {
    fail(
      'INVALID_MEMBER_SHARING_REQUEST',
      'Expected Community song version is invalid.'
    );
  }
  const familyRevision = hash(
    value.familyRevision,
    'Song-family revision',
    'INVALID_MEMBER_SHARING_REQUEST'
  );
  const reviewRevision = hash(
    value.reviewRevision,
    'Song member-sharing review revision',
    'INVALID_MEMBER_SHARING_REQUEST'
  );
  const review = normalizeReview(value.review, {
    familyRevision,
    reviewRevision
  });
  const access = memberVisibility(value.visibility, value.publishAt, {
    code: 'INVALID_MEMBER_SHARING_REQUEST'
  });
  const body = Object.freeze({
    schemaVersion: SONG_MEMBER_SHARING_SCHEMA_VERSION,
    familyRevision,
    review,
    reviewRevision,
    visibility: access.visibility,
    publishAt: access.publishAt
  });
  exactRecord(
    body,
    REQUEST_KEYS,
    'Song member-sharing body',
    'INVALID_MEMBER_SHARING_REQUEST'
  );
  const requestRevision = songMemberSharingRequestRevision({
    syncId: id,
    expectedSyncVersion: value.expectedSyncVersion,
    familyRevision,
    reviewRevision,
    visibility: access.visibility,
    publishAt: access.publishAt
  });
  return Object.freeze({
    syncId: id,
    expectedSyncVersion: value.expectedSyncVersion,
    body,
    requestRevision,
    idempotencyKey: requestRevision
  });
}

function normalizeSongMemberSharingReceipt(value, {
  expected = null,
  review = null
} = {}) {
  exactRecord(
    value,
    RECEIPT_KEYS,
    'Community song member-sharing receipt',
    'INVALID_MEMBER_SHARING_RECEIPT'
  );
  if (value.schemaVersion !== SONG_MEMBER_SHARING_SCHEMA_VERSION) {
    fail(
      'INVALID_MEMBER_SHARING_RECEIPT',
      'Community song member-sharing receipt uses an unsupported schema.'
    );
  }
  if (typeof value.receiptId !== 'string'
    || !RECEIPT_ID_PATTERN.test(value.receiptId)) {
    fail('INVALID_MEMBER_SHARING_RECEIPT', 'Member-sharing receipt ID is invalid.');
  }
  const receiptBytes = Buffer.from(value.receiptId, 'base64url');
  if (receiptBytes.length < 24
    || receiptBytes.toString('base64url') !== value.receiptId) {
    fail('INVALID_MEMBER_SHARING_RECEIPT', 'Member-sharing receipt ID is invalid.');
  }
  const receiptVersion = positiveVersion(
    value.receiptVersion,
    'Member-sharing receipt version'
  );
  const songSyncId = syncId(value.songSyncId);
  const previousSongSyncVersion = positiveVersion(
    value.previousSongSyncVersion,
    'Prior Community song version'
  );
  const songSyncVersion = positiveVersion(
    value.songSyncVersion,
    'Resulting Community song version'
  );
  if (songSyncVersion !== previousSongSyncVersion + 1) {
    fail(
      'INVALID_MEMBER_SHARING_RECEIPT',
      'Member-sharing receipt did not advance the song version exactly once.'
    );
  }
  const familyRevision = hash(
    value.familyRevision,
    'Member-sharing family revision'
  );
  const reviewRevision = hash(
    value.reviewRevision,
    'Member-sharing review revision'
  );
  const access = memberVisibility(value.visibility, value.publishAt);
  const timeZone = normalizeTimeZone(value.timeZone);
  const validThrough = canonicalTimestamp(
    value.validThrough,
    'Member-sharing validity boundary',
    { nullable: true }
  );
  const reviewedAt = canonicalTimestamp(
    value.reviewedAt,
    'Member-sharing review time'
  );
  const confirmedAt = canonicalTimestamp(
    value.confirmedAt,
    'Member-sharing confirmation time'
  );
  const requestRevision = hash(
    value.requestRevision,
    'Member-sharing request revision'
  );
  const receiptRevision = hash(
    value.receiptRevision,
    'Member-sharing receipt revision'
  );
  const normalized = {
    schemaVersion: SONG_MEMBER_SHARING_SCHEMA_VERSION,
    receiptId: value.receiptId,
    receiptVersion,
    songSyncId,
    previousSongSyncVersion,
    songSyncVersion,
    familyRevision,
    reviewRevision,
    visibility: access.visibility,
    publishAt: access.publishAt,
    timeZone,
    validThrough,
    reviewedAt,
    confirmedAt,
    requestRevision,
    receiptRevision
  };
  const expectedReceiptRevision = sha256(
    RECEIPT_KEYS
      .filter(key => key !== 'receiptRevision')
      .map(key => normalized[key])
  );
  if (receiptRevision !== expectedReceiptRevision) {
    fail(
      'INVALID_MEMBER_SHARING_RECEIPT',
      'Community member-sharing receipt checksum does not match.'
    );
  }
  if (Date.parse(reviewedAt) > Date.parse(confirmedAt)
    || (validThrough
      && Date.parse(validThrough) < Date.parse(confirmedAt))
    || (access.publishAt
      && validThrough
      && Date.parse(access.publishAt) > Date.parse(validThrough))) {
    fail(
      'INVALID_MEMBER_SHARING_RECEIPT',
      'Community member-sharing receipt lifetime is invalid.'
    );
  }
  if (expected
    && (
      songSyncId !== expected.syncId
      || previousSongSyncVersion !== expected.expectedSyncVersion
      || familyRevision !== expected.body.familyRevision
      || reviewRevision !== expected.body.reviewRevision
      || access.visibility !== expected.body.visibility
      || access.publishAt !== expected.body.publishAt
      || requestRevision !== expected.requestRevision
    )) {
    fail(
      'MEMBER_SHARING_NOT_CONFIRMED',
      'Heritage Community did not confirm the exact reviewed member-sharing request.'
    );
  }
  if (review) {
    if (review.reviewedAt !== reviewedAt) {
      fail(
        'MEMBER_SHARING_NOT_CONFIRMED',
        'Community member-sharing receipt does not match the reviewed time.'
      );
    }
    assertValidityBoundary(review.validUntil, validThrough, timeZone);
  }
  return Object.freeze(normalized);
}

function normalizeSongMemberSharingResponse(value, options = {}) {
  exactRecord(
    value,
    ['receipt'],
    'Community song member-sharing response',
    'INVALID_MEMBER_SHARING_RECEIPT'
  );
  return normalizeSongMemberSharingReceipt(value.receipt, options);
}

module.exports = {
  CommunitySongMemberSharingError,
  RECEIPT_KEYS,
  REQUEST_KEYS,
  SONG_MEMBER_SHARING_SCHEMA_VERSION,
  buildSongMemberSharingRequest,
  normalizeSongMemberSharingReceipt,
  normalizeSongMemberSharingResponse,
  songMemberSharingRequestRevision
};
