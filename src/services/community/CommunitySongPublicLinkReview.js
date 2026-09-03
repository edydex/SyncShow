'use strict';

const crypto = require('crypto');

const SONG_PUBLIC_LINK_REVIEW_SCOPE = 'public-link';
const SONG_PUBLIC_LINK_REVIEW_BASES = Object.freeze([
  'church-managed',
  'public-domain',
  'original-work',
  'specific-web-license',
  'direct-permission',
  'other-reviewed'
]);
const SONG_PUBLIC_LINK_REVIEW_BASIS_SET = new Set(
  SONG_PUBLIC_LINK_REVIEW_BASES
);
const SONG_FAMILY_REVISION_PATTERN = /^[a-f0-9]{64}$/;

class CommunitySongPublicLinkReviewError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'CommunitySongPublicLinkReviewError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new CommunitySongPublicLinkReviewError(code, message);
}

function boundedText(value, label, maximum, { required = false } = {}) {
  if (value === undefined || value === null || value === '') {
    if (required) fail('INVALID_PUBLIC_LINK_REVIEW', `${label} is required.`);
    return null;
  }
  if (typeof value !== 'string') {
    fail('INVALID_PUBLIC_LINK_REVIEW', `${label} must be text.`);
  }
  const normalized = value.trim();
  if (!normalized
    || normalized.length > maximum
    || /[\u0000-\u001f\u007f]/u.test(normalized)) {
    fail('INVALID_PUBLIC_LINK_REVIEW', `${label} is invalid.`);
  }
  return normalized;
}

function isoTimestamp(value, label) {
  const normalized = boundedText(value, label, 40, { required: true });
  const parsed = new Date(normalized);
  if (Number.isNaN(parsed.getTime())) {
    fail('INVALID_PUBLIC_LINK_REVIEW', `${label} is invalid.`);
  }
  return parsed.toISOString();
}

function calendarDate(value, label) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/u.test(value)) {
    fail('INVALID_PUBLIC_LINK_REVIEW', `${label} must be a calendar date.`);
  }
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime())
    || parsed.toISOString().slice(0, 10) !== value) {
    fail('INVALID_PUBLIC_LINK_REVIEW', `${label} is invalid.`);
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
    fail(
      'INVALID_PUBLIC_LINK_REVIEW',
      'Public-link review validity date is invalid.'
    );
  }
  return end;
}

function normalizeSongPublicLinkReview(value, {
  required = false,
  allowLegacyBoundary = false
} = {}) {
  if (value === undefined || value === null) {
    if (required) {
      fail(
        'SONG_PUBLIC_LINK_REVIEW_REQUIRED',
        'Review this exact song family before creating an anonymous public link.'
      );
    }
    return null;
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail('INVALID_PUBLIC_LINK_REVIEW', 'Song public-link review is invalid.');
  }
  const allowedKeys = new Set([
    'scope',
    'basis',
    'evidence',
    'validUntil',
    'validThrough',
    'reviewedAt',
    'familyRevision'
  ]);
  const keys = Object.keys(value);
  const commonKeys = [
    'scope',
    'basis',
    'evidence',
    'validUntil',
    'reviewedAt',
    'familyRevision'
  ];
  const hasValidThrough = Object.prototype.hasOwnProperty.call(
    value,
    'validThrough'
  );
  if (keys.some(key => !allowedKeys.has(key))
    || commonKeys.some(key => !Object.prototype.hasOwnProperty.call(value, key))
    || (!hasValidThrough && !allowLegacyBoundary)) {
    fail(
      'INVALID_PUBLIC_LINK_REVIEW',
      'Song public-link review contains unsupported or missing fields.'
    );
  }
  const scope = boundedText(value.scope, 'Public-link review scope', 40, {
    required: true
  });
  if (scope !== SONG_PUBLIC_LINK_REVIEW_SCOPE) {
    fail(
      'INVALID_PUBLIC_LINK_REVIEW',
      'This review does not cover anonymous access by anyone with the link.'
    );
  }
  const basis = boundedText(value.basis, 'Public-link review basis', 40, {
    required: true
  });
  if (!SONG_PUBLIC_LINK_REVIEW_BASIS_SET.has(basis)) {
    fail(
      'INVALID_PUBLIC_LINK_REVIEW',
      'Choose a supported public-link permission basis.'
    );
  }
  const evidence = boundedText(
    value.evidence,
    'Public-link review evidence',
    1000,
    { required: basis !== 'church-managed' }
  ) || '';
  const familyRevision = boundedText(
    value.familyRevision,
    'Reviewed song-family revision',
    64,
    { required: true }
  );
  if (!SONG_FAMILY_REVISION_PATTERN.test(familyRevision)) {
    fail(
      'INVALID_PUBLIC_LINK_REVIEW',
      'Reviewed song-family revision is invalid.'
    );
  }
  const validUntil = calendarDate(
    value.validUntil,
    'Public-link review validity date'
  );
  let validThrough;
  if (hasValidThrough) {
    validThrough = value.validThrough === undefined
      || value.validThrough === null
      || value.validThrough === ''
      ? null
      : isoTimestamp(
          value.validThrough,
          'Public-link review validity boundary'
        );
    if ((validUntil === null) !== (validThrough === null)) {
      fail(
        'INVALID_PUBLIC_LINK_REVIEW',
        'The public-link review date and exact validity boundary must be recorded together.'
      );
    }
  }
  return Object.freeze({
    scope,
    basis,
    evidence,
    validUntil,
    ...(hasValidThrough ? { validThrough } : {}),
    reviewedAt: isoTimestamp(value.reviewedAt, 'Public-link review time'),
    familyRevision
  });
}

function createSongPublicLinkReview(value = {}, {
  familyRevision,
  reviewedAt
} = {}) {
  const validUntil = calendarDate(
    value.validUntil,
    'Public-link review validity date'
  );
  const derivedValidThrough = validUntil
    ? localEndOfCalendarDate(validUntil).toISOString()
    : null;
  if (Object.prototype.hasOwnProperty.call(value, 'validThrough')) {
    const requestedValidThrough = value.validThrough === undefined
      || value.validThrough === null
      || value.validThrough === ''
      ? null
      : isoTimestamp(
          value.validThrough,
          'Public-link review validity boundary'
        );
    if (requestedValidThrough !== derivedValidThrough) {
      fail(
        'INVALID_PUBLIC_LINK_REVIEW',
        'The exact permission boundary no longer matches this computer’s local review date.'
      );
    }
  }
  return normalizeSongPublicLinkReview({
    scope: SONG_PUBLIC_LINK_REVIEW_SCOPE,
    basis: value.basis,
    evidence: value.evidence,
    validUntil,
    validThrough: derivedValidThrough,
    reviewedAt,
    familyRevision
  }, { required: true });
}

function songPublicLinkReviewRevision(value) {
  if (value === undefined || value === null) return null;
  const review = normalizeSongPublicLinkReview(value, {
    required: true,
    allowLegacyBoundary: true
  });
  const legacy = !Object.prototype.hasOwnProperty.call(
    review,
    'validThrough'
  );
  return crypto.createHash('sha256')
    .update(JSON.stringify(legacy
      ? [
          review.scope,
          review.basis,
          review.evidence,
          review.validUntil,
          review.reviewedAt,
          review.familyRevision
        ]
      : [
          review.scope,
          review.basis,
          review.evidence,
          review.validUntil,
          review.validThrough,
          review.reviewedAt,
          review.familyRevision
        ]))
    .digest('hex');
}

function songPublicLinkReviewForRetry(review, {
  basis,
  evidence,
  validUntil,
  familyRevision
} = {}) {
  const held = normalizeSongPublicLinkReview(review, { required: true });
  const requestedBasis = boundedText(
    basis,
    'Public-link review basis',
    40,
    { required: true }
  );
  const requestedEvidence = boundedText(
    evidence,
    'Public-link review evidence',
    1000,
    { required: requestedBasis !== 'church-managed' }
  ) || '';
  const requestedValidUntil = calendarDate(
    validUntil,
    'Public-link review validity date'
  );
  const requestedFamilyRevision = boundedText(
    familyRevision,
    'Reviewed song-family revision',
    64,
    { required: true }
  );
  if (!SONG_FAMILY_REVISION_PATTERN.test(requestedFamilyRevision)
    || held.basis !== requestedBasis
    || held.evidence !== requestedEvidence
    || held.validUntil !== requestedValidUntil
    || held.familyRevision !== requestedFamilyRevision) {
    fail(
      'PUBLIC_LINK_REVIEW_RETRY_MISMATCH',
      'Retry this public link with the same reviewed permission details.'
    );
  }
  return held;
}

function songPublicLinkReviewStatus(review, {
  familyRevision,
  now = new Date(),
  expiresAt = null
} = {}) {
  if (!review) return 'missing';
  const normalized = normalizeSongPublicLinkReview(review, {
    required: true,
    allowLegacyBoundary: true
  });
  if (typeof familyRevision !== 'string'
    || !SONG_FAMILY_REVISION_PATTERN.test(familyRevision)
    || normalized.familyRevision !== familyRevision) {
    return 'stale';
  }
  if (!Object.prototype.hasOwnProperty.call(normalized, 'validThrough')) {
    return 'boundary-missing';
  }
  const parsedNow = now instanceof Date ? now : new Date(now);
  if (Number.isNaN(parsedNow.getTime())) {
    throw new TypeError('Song public-link review clock is invalid');
  }
  const validityEnd = normalized.validThrough
    ? new Date(normalized.validThrough)
    : null;
  if (validityEnd && parsedNow.getTime() > validityEnd.getTime()) {
    return 'expired';
  }
  if (validityEnd && (expiresAt === null || expiresAt === undefined || expiresAt === '')) {
    return 'nonexpiring-after-review';
  }
  if (expiresAt !== null && expiresAt !== undefined && expiresAt !== '') {
    const parsedExpiry = expiresAt instanceof Date ? expiresAt : new Date(expiresAt);
    if (Number.isNaN(parsedExpiry.getTime())) {
      throw new TypeError('Song public-link expiry is invalid');
    }
    if (validityEnd && parsedExpiry.getTime() > validityEnd.getTime()) {
      return 'link-after-review';
    }
  }
  return 'current';
}

module.exports = {
  CommunitySongPublicLinkReviewError,
  SONG_PUBLIC_LINK_REVIEW_BASES,
  SONG_PUBLIC_LINK_REVIEW_SCOPE,
  createSongPublicLinkReview,
  normalizeSongPublicLinkReview,
  songPublicLinkReviewForRetry,
  songPublicLinkReviewRevision,
  songPublicLinkReviewStatus
};
