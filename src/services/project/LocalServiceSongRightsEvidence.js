'use strict';

const LOCAL_SERVICE_SONG_RIGHTS_SCOPE = 'local-service-song-intake';
const LOCAL_SERVICE_SONG_RIGHTS_BASES = Object.freeze([
  'church-managed',
  'public-domain',
  'original-work',
  'ccli-service-license',
  'specific-service-license',
  'direct-permission',
  'multiple-bases'
]);
const LOCAL_SERVICE_SONG_RIGHTS_BASIS_SET = new Set(
  LOCAL_SERVICE_SONG_RIGHTS_BASES
);
const MAX_LOCAL_SERVICE_SONG_RIGHTS_EVIDENCE_CHARS = 1_000;

class LocalServiceSongRightsEvidenceError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'LocalServiceSongRightsEvidenceError';
    this.code = code;
  }
}

function fail(message) {
  throw new LocalServiceSongRightsEvidenceError(
    'INVALID_LOCAL_SERVICE_SONG_RIGHTS',
    message
  );
}

function exactKeys(value, expected, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail(`${label} must be an object.`);
  }
  const keys = Object.keys(value);
  const allowed = new Set(expected);
  if (
    keys.length !== allowed.size
    || keys.some(key => !allowed.has(key))
  ) {
    fail(`${label} contains unsupported or missing fields.`);
  }
}

function boundedEvidence(value, { required = true } = {}) {
  if (value === undefined || value === null || value === '') {
    if (required) fail('Local-service song rights evidence is required.');
    return '';
  }
  if (
    typeof value !== 'string'
    || value !== value.trim()
    || (required && value.length < 1)
    || value.length > MAX_LOCAL_SERVICE_SONG_RIGHTS_EVIDENCE_CHARS
    || /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    fail('Local-service song rights evidence must be bounded one-line text.');
  }
  return value;
}

function canonicalTimestamp(value) {
  if (
    typeof value !== 'string'
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value)
    || !Number.isFinite(Date.parse(value))
    || new Date(value).toISOString() !== value
  ) {
    fail(
      'Local-service song rights reviewedAt must be a canonical UTC timestamp.'
    );
  }
  return value;
}

function normalizeLocalServiceSongRightsEvidence(
  value,
  { required = false, reviewedAt = null } = {}
) {
  if (value === null || value === undefined) {
    if (required) fail('Local-service song rights evidence is required.');
    return null;
  }
  exactKeys(value, [
    'scope',
    'basis',
    'evidence',
    'reviewedAt'
  ], 'Local-service song rights evidence');
  if (value.scope !== LOCAL_SERVICE_SONG_RIGHTS_SCOPE) {
    fail('Local-service song rights evidence has an invalid scope.');
  }
  if (!LOCAL_SERVICE_SONG_RIGHTS_BASIS_SET.has(value.basis)) {
    fail('Choose a supported local-service song rights basis.');
  }
  const exactReviewedAt = canonicalTimestamp(value.reviewedAt);
  if (reviewedAt !== null && exactReviewedAt !== reviewedAt) {
    fail(
      'Local-service song rights evidence must use the exact family review time.'
    );
  }
  return Object.freeze({
    scope: LOCAL_SERVICE_SONG_RIGHTS_SCOPE,
    basis: value.basis,
    evidence: boundedEvidence(value.evidence, {
      required: value.basis !== 'church-managed'
    }),
    reviewedAt: exactReviewedAt
  });
}

function normalizeLocalServiceSongRightsSelection(value) {
  exactKeys(
    value,
    ['basis', 'evidence'],
    'Local-service song rights selection'
  );
  if (!LOCAL_SERVICE_SONG_RIGHTS_BASIS_SET.has(value.basis)) {
    fail('Choose a supported local-service song rights basis.');
  }
  return Object.freeze({
    basis: value.basis,
    evidence: boundedEvidence(value.evidence, {
      required: value.basis !== 'church-managed'
    })
  });
}

function createLocalServiceSongRightsEvidence(
  value,
  { reviewedAt } = {}
) {
  const selection = normalizeLocalServiceSongRightsSelection(value);
  return normalizeLocalServiceSongRightsEvidence({
    scope: LOCAL_SERVICE_SONG_RIGHTS_SCOPE,
    basis: selection.basis,
    evidence: selection.evidence,
    reviewedAt
  }, {
    required: true,
    reviewedAt
  });
}

module.exports = {
  LOCAL_SERVICE_SONG_RIGHTS_BASES,
  LOCAL_SERVICE_SONG_RIGHTS_SCOPE,
  LocalServiceSongRightsEvidenceError,
  MAX_LOCAL_SERVICE_SONG_RIGHTS_EVIDENCE_CHARS,
  createLocalServiceSongRightsEvidence,
  normalizeLocalServiceSongRightsEvidence,
  normalizeLocalServiceSongRightsSelection
};
