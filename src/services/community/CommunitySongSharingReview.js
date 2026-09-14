'use strict';

const crypto = require('crypto');
const {
  songFamilyRevision: projectSongFamilyRevision
} = require('../project/SongFamilyRevision');

const SONG_SHARING_REVIEW_SCOPE = 'community-members';
const SONG_SHARING_REVIEW_BASES = Object.freeze([
  'church-managed',
  'public-domain',
  'original-work',
  'church-license',
  'specific-web-license',
  'direct-permission',
  'other-reviewed'
]);
const SONG_SHARING_REVIEW_BASIS_SET = new Set(SONG_SHARING_REVIEW_BASES);
const LEGACY_SONG_SHARING_REVIEW_BASES = new Set([
  'ccli-songselect'
]);
const EVIDENCE_REQUIRED_BASES = new Set([
  'ccli-songselect',
  'church-license',
  'specific-web-license',
  'direct-permission',
  'other-reviewed'
]);
const SONG_FAMILY_REVISION_PATTERN = /^[a-f0-9]{64}$/;
const SONG_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

class CommunitySongSharingReviewError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'CommunitySongSharingReviewError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new CommunitySongSharingReviewError(code, message);
}

function boundedText(value, label, maximum, { required = false } = {}) {
  if (value === undefined || value === null || value === '') {
    if (required) fail('INVALID_SHARING_REVIEW', `${label} is required.`);
    return null;
  }
  if (typeof value !== 'string') {
    fail('INVALID_SHARING_REVIEW', `${label} must be text.`);
  }
  const normalized = value.trim();
  if (!normalized
    || normalized.length > maximum
    || /[\u0000-\u001f\u007f]/u.test(normalized)) {
    fail('INVALID_SHARING_REVIEW', `${label} is invalid.`);
  }
  return normalized;
}

function isoTimestamp(value, label) {
  const normalized = boundedText(value, label, 40, { required: true });
  const parsed = new Date(normalized);
  if (Number.isNaN(parsed.getTime())) {
    fail('INVALID_SHARING_REVIEW', `${label} is invalid.`);
  }
  return parsed.toISOString();
}

function calendarDate(value, label) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/u.test(value)) {
    fail('INVALID_SHARING_REVIEW', `${label} must be a calendar date.`);
  }
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime())
    || parsed.toISOString().slice(0, 10) !== value) {
    fail('INVALID_SHARING_REVIEW', `${label} is invalid.`);
  }
  return value;
}

function localEndOfCalendarDate(value) {
  const [year, month, day] = value.split('-').map(Number);
  const end = new Date(year, month - 1, day, 23, 59, 59, 999);
  if (Number.isNaN(end.getTime())
    || end.getFullYear() !== year
    || end.getMonth() !== month - 1
    || end.getDate() !== day) {
    fail('INVALID_SHARING_REVIEW', 'Sharing-review validity date is invalid.');
  }
  return end;
}

function familyDocuments(value) {
  const documents = Array.isArray(value) ? value : value?.documents;
  if (!Array.isArray(documents)
    || documents.length < 1
    || documents.length > 32) {
    fail(
      'INVALID_SONG_FAMILY',
      'A song family must contain between one and 32 exact local documents.'
    );
  }
  const seen = new Set();
  return documents.map(document => {
    const id = document?.song?.id;
    const revision = document?.revision;
    if (typeof id !== 'string'
      || !SONG_ID_PATTERN.test(id)
      || typeof revision !== 'string'
      || !SONG_FAMILY_REVISION_PATTERN.test(revision)
      || seen.has(id)) {
      fail(
        'INVALID_SONG_FAMILY',
        'A song family contains an invalid or duplicate exact document.'
      );
    }
    seen.add(id);
    return document;
  });
}

/**
 * Hash the exact immutable documents in one original/translation family.
 * Sorting here mirrors CommunitySongSync's local-family order while keeping
 * callers from making the review identity depend on list pagination.
 */
function songFamilyRevision(value) {
  const documents = familyDocuments(value);
  try {
    return projectSongFamilyRevision(documents);
  } catch (_error) {
    fail(
      'INVALID_SONG_FAMILY',
      'A song family contains an invalid or duplicate exact document.'
    );
  }
}

function normalizeSongSharingReview(value, {
  required = false,
  allowLegacyBasis = false
} = {}) {
  if (value === undefined || value === null) {
    if (required) {
      fail(
        'SONG_SHARING_REVIEW_REQUIRED',
        'Review this exact song family before making it visible to Community members.'
      );
    }
    return null;
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail('INVALID_SHARING_REVIEW', 'Song sharing review is invalid.');
  }
  const allowedKeys = new Set([
    'scope',
    'basis',
    'evidence',
    'validUntil',
    'reviewedAt',
    'familyRevision'
  ]);
  if (Object.keys(value).some(key => !allowedKeys.has(key))) {
    fail('INVALID_SHARING_REVIEW', 'Song sharing review contains unsupported fields.');
  }
  const scope = boundedText(value.scope, 'Sharing-review scope', 40, {
    required: true
  });
  if (scope !== SONG_SHARING_REVIEW_SCOPE) {
    fail(
      'INVALID_SHARING_REVIEW',
      'This review does not cover Heritage Community member access.'
    );
  }
  const basis = boundedText(value.basis, 'Sharing-review basis', 40, {
    required: true
  });
  const legacyBasis = LEGACY_SONG_SHARING_REVIEW_BASES.has(basis);
  if (!SONG_SHARING_REVIEW_BASIS_SET.has(basis)
    && !(allowLegacyBasis && legacyBasis)) {
    fail('INVALID_SHARING_REVIEW', 'Choose a supported song-sharing basis.');
  }
  // Heritage's protocol-v1 review wire uses an exact string field. Keep the
  // optional bases canonical as the empty string rather than local null so
  // both runtimes hash the same six review values.
  const evidence = boundedText(
    value.evidence,
    'Sharing-review evidence',
    1000
  ) || '';
  if (EVIDENCE_REQUIRED_BASES.has(basis) && !evidence) {
    fail(
      'INVALID_SHARING_REVIEW',
      'Record the exact license, catalog entry, permission, or other evidence reviewed.'
    );
  }
  const familyRevision = boundedText(
    value.familyRevision,
    'Reviewed song-family revision',
    64,
    { required: true }
  );
  if (!SONG_FAMILY_REVISION_PATTERN.test(familyRevision)) {
    fail('INVALID_SHARING_REVIEW', 'Reviewed song-family revision is invalid.');
  }
  return Object.freeze({
    scope,
    basis,
    evidence,
    validUntil: calendarDate(value.validUntil, 'Sharing-review validity date'),
    reviewedAt: isoTimestamp(value.reviewedAt, 'Sharing-review time'),
    familyRevision
  });
}

function createSongSharingReview(value = {}, {
  familyRevision,
  reviewedAt
} = {}) {
  return normalizeSongSharingReview({
    scope: SONG_SHARING_REVIEW_SCOPE,
    basis: value.basis,
    evidence: value.evidence,
    validUntil: value.validUntil,
    reviewedAt,
    familyRevision
  }, { required: true });
}

function songSharingReviewRevision(value) {
  if (value === undefined || value === null) return null;
  const review = normalizeSongSharingReview(value, {
    required: true,
    allowLegacyBasis: true
  });
  return crypto.createHash('sha256')
    .update(JSON.stringify([
      review.scope,
      review.basis,
      review.evidence,
      review.validUntil,
      review.reviewedAt,
      review.familyRevision
    ]))
    .digest('hex');
}

function songSharingReviewStatus(review, {
  familyRevision,
  now = new Date(),
  publishAt = null
} = {}) {
  if (!review) return 'missing';
  const normalized = normalizeSongSharingReview(review, {
    required: true,
    allowLegacyBasis: true
  });
  if (typeof familyRevision !== 'string'
    || !SONG_FAMILY_REVISION_PATTERN.test(familyRevision)
    || normalized.familyRevision !== familyRevision) {
    return 'stale';
  }
  if (!SONG_SHARING_REVIEW_BASIS_SET.has(normalized.basis)) {
    return 'basis-unsupported';
  }
  const parsedNow = now instanceof Date ? now : new Date(now);
  if (Number.isNaN(parsedNow.getTime())) {
    throw new TypeError('Song sharing-review clock is invalid');
  }
  if (normalized.validUntil) {
    const validThrough = localEndOfCalendarDate(normalized.validUntil);
    if (parsedNow.getTime() > validThrough.getTime()) return 'expired';
    if (publishAt !== null && publishAt !== undefined && publishAt !== '') {
      const scheduled = publishAt instanceof Date ? publishAt : new Date(publishAt);
      if (Number.isNaN(scheduled.getTime())) {
        throw new TypeError('Scheduled song publication time is invalid');
      }
      if (scheduled.getTime() > validThrough.getTime()) {
        return 'schedule-after-expiry';
      }
    }
  }
  return 'current';
}

module.exports = {
  CommunitySongSharingReviewError,
  EVIDENCE_REQUIRED_BASES,
  SONG_FAMILY_REVISION_PATTERN,
  SONG_SHARING_REVIEW_BASES,
  SONG_SHARING_REVIEW_SCOPE,
  createSongSharingReview,
  normalizeSongSharingReview,
  songFamilyRevision,
  songSharingReviewRevision,
  songSharingReviewStatus
};
