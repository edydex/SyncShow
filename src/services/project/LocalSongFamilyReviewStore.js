'use strict';

const crypto = require('crypto');
const fs = require('fs/promises');
const path = require('path');
const { TextDecoder } = require('util');

const {
  MAX_SOURCE_BYTES,
  compareSongSections,
  parseSongDocument,
  serializeSongDocument
} = require('./SongDocument');
const {
  atomicWriteFile,
  ensureConfinedDirectory,
  ensurePrivateDirectory,
  flushPublishedFile,
  fsyncDirectory,
  readFileNoFollow,
  withExclusiveFileLock
} = require('./StorageSafety');
const {
  compareCanonicalText,
  songFamilyRevision
} = require('./SongFamilyRevision');
const {
  LocalServiceSongRightsEvidenceError,
  normalizeLocalServiceSongRightsEvidence
} = require('./LocalServiceSongRightsEvidence');

const LEGACY_SONG_FAMILY_REVIEW_SNAPSHOT_SCHEMA_VERSION = 1;
const CONFIRMED_SONG_FAMILY_REVIEW_SNAPSHOT_SCHEMA_VERSION = 2;
const SONG_FAMILY_REVIEW_SNAPSHOT_SCHEMA_VERSION = 3;
const SONG_FAMILY_REVIEW_SNAPSHOT_KIND =
  'syncshow-song-family-review-snapshot';
const LEGACY_SONG_FAMILY_REVIEW_RECEIPT_SCHEMA_VERSION = 1;
const CONFIRMED_SONG_FAMILY_REVIEW_RECEIPT_SCHEMA_VERSION = 2;
const SONG_FAMILY_REVIEW_RECEIPT_SCHEMA_VERSION = 3;
const SONG_FAMILY_REVIEW_RECEIPT_KIND =
  'syncshow-song-family-review-receipt';
const SONG_FAMILY_REVIEW_INDEX_SCHEMA_VERSION = 1;
const SONG_FAMILY_REVIEW_INDEX_KIND =
  'syncshow-song-family-review-index';
const SONG_FAMILY_REVIEW_SCOPE = 'local-powerpoint-family';
const SONG_FAMILY_REVIEW_CONFIRMATION_AUTHORITY_SCOPE =
  'local-song-library-only';
const RECEIPT_STORAGE_PROVISION_KIND =
  'syncshow-song-family-receipt-storage';
const RECEIPT_STORAGE_PROVISION_FILE = '.receipt-storage.json';
const RECEIPT_CAPACITY_RESERVATION_KIND =
  'syncshow-song-family-receipt-capacity-reservation';
const RECEIPT_CAPACITY_RESERVATION_FILE = '.receipt-capacity-reservation.json';
const COMMIT_WITNESS_KIND =
  'syncshow-song-family-commit-witness';
const COMMIT_WITNESS_FILE = '.committed.json';

const MAX_SNAPSHOT_BYTES = 16 * 1024 * 1024;
const MAX_RECEIPT_BYTES = 2 * 1024 * 1024;
const MAX_INDEX_BYTES = 256 * 1024;
const MAX_RECEIPT_STORAGE_PROVISION_BYTES = 1024;
const MAX_RECEIPT_CAPACITY_RESERVATION_BYTES = 1024;
const MAX_COMMIT_WITNESS_BYTES = 2 * 1024;
const MAX_SNAPSHOTS = 10_000;
const MAX_RECEIPTS = 50_000;
const MAX_INDEX_ENTRIES = 1_000;
const MAX_FAMILY_MEMBERS = 32;
const MAX_SOURCE_DECKS = 32;
const MAX_CAPTURES = 64;
const MAX_CAPTURES_PER_MEMBER = 4;
const MAX_SLIDES_PER_CAPTURE = 200;
const MAX_TOTAL_CAPTURED_SLIDES = 1_000;
const MAX_OCCURRENCES = MAX_TOTAL_CAPTURED_SLIDES;
const MAX_TOTAL_CAPTURED_TEXT_BYTES = 4 * 1024 * 1024;
const MAX_TOTAL_DOCUMENT_SOURCE_BYTES = 8 * 1024 * 1024;
const MAX_LINES_PER_SLIDE = 10_000;
const MAX_LINE_CHARS = 1_000;

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const HASH_FILE_PATTERN = /^([a-f0-9]{64})\.json$/;
const HASH_DIRECTORY_PATTERN = /^[a-f0-9]{64}$/;
const HASH_PREFIX_PATTERN = /^[a-f0-9]{2}$/;
const LANE_IDS = new Set(['all', 'white', 'yellow']);
const FAMILY_ROLES = new Set(['original', 'translation']);
const COMMIT_ACTIONS = new Set(['create', 'update', 'reuse']);
const SELECTION_ORIGINS = new Set(['template-local', 'manual']);
const OCCURRENCE_ACTIONS = new Set(['new', 'repeat', 'exclude']);

class LocalSongFamilyReviewStoreError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'LocalSongFamilyReviewStoreError';
    this.code = code;
    this.details = Object.freeze({ ...details });
  }
}

function fail(code, message, details = {}) {
  throw new LocalSongFamilyReviewStoreError(code, message, details);
}

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function exactKeys(value, expectedKeys, field, code = 'INVALID_REVIEW_INPUT') {
  if (!isRecord(value)) fail(code, `${field} must be an object.`);
  const actual = Object.keys(value);
  const expected = new Set(expectedKeys);
  if (actual.length !== expected.size || actual.some(key => !expected.has(key))) {
    fail(code, `${field} has unsupported or missing fields.`);
  }
}

function normalizeReviewConfirmations(
  raw,
  field = 'Song-family review confirmations',
  code = 'INVALID_REVIEW_INPUT'
) {
  exactKeys(raw, [
    'sourceConfirmed',
    'rightsConfirmed',
    'localCommitConfirmed',
    'authorityScope',
    'communityAuthorityGranted'
  ], field, code);
  if (
    raw.sourceConfirmed !== true
    || raw.rightsConfirmed !== true
    || raw.localCommitConfirmed !== true
    || raw.authorityScope !==
      SONG_FAMILY_REVIEW_CONFIRMATION_AUTHORITY_SCOPE
    || raw.communityAuthorityGranted !== false
  ) {
    fail(
      code,
      `${field} must record all three local confirmations without granting Community authority.`
    );
  }
  return {
    sourceConfirmed: true,
    rightsConfirmed: true,
    localCommitConfirmed: true,
    authorityScope: SONG_FAMILY_REVIEW_CONFIRMATION_AUTHORITY_SCOPE,
    communityAuthorityGranted: false
  };
}

function normalizeMemberLocalServiceRights(
  raw,
  {
    captured,
    reviewedAt,
    song,
    songId,
    code
  }
) {
  let normalized;
  try {
    normalized = normalizeLocalServiceSongRightsEvidence(raw, {
      required: captured,
      reviewedAt
    });
  } catch (error) {
    if (error instanceof LocalServiceSongRightsEvidenceError) {
      fail(code, error.message, { songId });
    }
    throw error;
  }
  if (!captured && normalized !== null) {
    fail(
      code,
      `Uncaptured family member ${songId} cannot claim a current local-service rights review.`
    );
  }
  if (normalized !== null && !song.license) {
    fail(
      code,
      `Reviewed family member ${songId} requires separate SongDocument license metadata.`
    );
  }
  return normalized;
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function canonicalBuffer(value) {
  return Buffer.from(`${canonicalJson(value)}\n`, 'utf8');
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function canonicalEqual(left, right) {
  return canonicalJson(left) === canonicalJson(right);
}

function identifier(value, field, code = 'INVALID_REVIEW_INPUT') {
  if (typeof value !== 'string' || !ID_PATTERN.test(value)) {
    fail(code, `${field} must be a canonical identifier.`);
  }
  return value;
}

function digest(value, field, code = 'INVALID_REVIEW_INPUT') {
  if (typeof value !== 'string' || !SHA256_PATTERN.test(value)) {
    fail(code, `${field} must be a lowercase SHA-256 digest.`);
  }
  return value;
}

function nullableDigest(value, field, code = 'INVALID_REVIEW_INPUT') {
  return value === null ? null : digest(value, field, code);
}

function boundedText(value, field, maximum, code = 'INVALID_REVIEW_INPUT') {
  if (
    typeof value !== 'string'
    || value.length < 1
    || value.length > maximum
    || value !== value.trim()
    || /[\0\r\n]/u.test(value)
  ) {
    fail(code, `${field} must be bounded one-line text.`);
  }
  return value;
}

function canonicalTimestamp(value, field, code = 'INVALID_REVIEW_INPUT') {
  if (
    typeof value !== 'string'
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value)
    || !Number.isFinite(Date.parse(value))
    || new Date(value).toISOString() !== value
  ) {
    fail(code, `${field} must be a canonical ISO-8601 UTC timestamp.`);
  }
  return value;
}

function positiveInteger(value, field, maximum, code = 'INVALID_REVIEW_INPUT') {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    fail(code, `${field} must be a bounded positive integer.`);
  }
  return value;
}

function capacityOption(value, fallback, maximum, label) {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new TypeError(`${label} must be an integer between 1 and ${maximum}`);
  }
  return value;
}

function slideLinesHash(lines) {
  return sha256(Buffer.from(JSON.stringify(lines), 'utf8'));
}

function orderedSlidesTextHash(slides) {
  return sha256(Buffer.from(JSON.stringify(slides.map(slide => slide.lines)), 'utf8'));
}

function songTextHash(song) {
  const slides = song.sections.flatMap(section => section.slides);
  return orderedSlidesTextHash(slides);
}

function normalizeDeck(raw, index, code = 'INVALID_REVIEW_SNAPSHOT') {
  exactKeys(raw, [
    'roleId',
    'sourceName',
    'sourceSizeBytes',
    'deckSha256',
    'deckSlideCount'
  ], `Source deck ${index + 1}`, code);
  const sourceName = boundedText(
    raw.sourceName,
    `Source deck ${index + 1} sourceName`,
    255,
    code
  );
  if (
    sourceName !== path.basename(sourceName)
    || sourceName.includes('/')
    || sourceName.includes('\\')
  ) {
    fail(code, `Source deck ${index + 1} sourceName must be a path-free basename.`);
  }
  return {
    roleId: identifier(raw.roleId, `Source deck ${index + 1} roleId`, code),
    sourceName,
    sourceSizeBytes: positiveInteger(
      raw.sourceSizeBytes,
      `Source deck ${index + 1} sourceSizeBytes`,
      128 * 1024 * 1024,
      code
    ),
    deckSha256: digest(
      raw.deckSha256,
      `Source deck ${index + 1} deckSha256`,
      code
    ),
    deckSlideCount: positiveInteger(
      raw.deckSlideCount,
      `Source deck ${index + 1} deckSlideCount`,
      1_000,
      code
    )
  };
}

function normalizeServiceSet(raw, code = 'INVALID_REVIEW_SNAPSHOT') {
  exactKeys(raw, [
    'id',
    'fingerprint',
    'serviceDate',
    'profileId',
    'extractor',
    'decks'
  ], 'PowerPoint service binding', code);
  exactKeys(raw.extractor, ['id', 'version'], 'PowerPoint song extractor', code);
  if (
    typeof raw.serviceDate !== 'string'
    || !/^\d{4}-\d{2}-\d{2}$/u.test(raw.serviceDate)
    || !Number.isFinite(Date.parse(`${raw.serviceDate}T00:00:00.000Z`))
    || new Date(`${raw.serviceDate}T00:00:00.000Z`)
      .toISOString()
      .slice(0, 10) !== raw.serviceDate
  ) {
    fail(code, 'PowerPoint serviceDate is invalid.');
  }
  if (
    !Array.isArray(raw.decks)
    || raw.decks.length < 1
    || raw.decks.length > MAX_SOURCE_DECKS
  ) {
    fail(code, `PowerPoint service decks must contain 1 to ${MAX_SOURCE_DECKS} items.`);
  }
  const decks = raw.decks
    .map((deck, index) => normalizeDeck(deck, index, code))
    .sort((left, right) =>
      compareCanonicalText(left.roleId, right.roleId)
      || compareCanonicalText(left.deckSha256, right.deckSha256));
  const roles = new Set();
  for (const deck of decks) {
    if (roles.has(deck.roleId)) {
      fail(code, 'PowerPoint service decks cannot repeat a role.');
    }
    roles.add(deck.roleId);
  }
  return {
    id: identifier(raw.id, 'PowerPoint ServiceSet id', code),
    fingerprint: digest(raw.fingerprint, 'PowerPoint ServiceSet fingerprint', code),
    serviceDate: raw.serviceDate,
    profileId: identifier(raw.profileId, 'PowerPoint service profileId', code),
    extractor: {
      id: boundedText(raw.extractor.id, 'PowerPoint song extractor id', 128, code),
      version: positiveInteger(
        raw.extractor.version,
        'PowerPoint song extractor version',
        1_000_000,
        code
      )
    },
    decks
  };
}

function normalizeSourceLines(rawLines, field, state, code) {
  if (
    !Array.isArray(rawLines)
    || rawLines.length < 1
    || rawLines.length > MAX_LINES_PER_SLIDE
  ) {
    fail(code, `${field} must contain bounded source lines.`);
  }
  let hasText = false;
  const lines = rawLines.map((line, index) => {
    if (
      typeof line !== 'string'
      || line.length > MAX_LINE_CHARS
      || /[\0\r\n]/u.test(line)
    ) {
      fail(code, `${field} line ${index + 1} is invalid.`);
    }
    if (line.length > 0) hasText = true;
    state.capturedTextBytes += Buffer.byteLength(line, 'utf8');
    if (state.capturedTextBytes > MAX_TOTAL_CAPTURED_TEXT_BYTES) {
      fail(code, 'PowerPoint family captured text exceeds its storage limit.');
    }
    return line;
  });
  if (!hasText) fail(code, `${field} cannot be entirely empty.`);
  return lines;
}

function normalizeCaptureSlide(raw, index, deck, state, code) {
  exactKeys(
    raw,
    ['number', 'lane', 'lines', 'textSha256'],
    `PowerPoint capture slide ${index + 1}`,
    code
  );
  const number = positiveInteger(
    raw.number,
    `PowerPoint capture slide ${index + 1} number`,
    deck.deckSlideCount,
    code
  );
  if (!LANE_IDS.has(raw.lane)) {
    fail(code, `PowerPoint capture slide ${index + 1} lane is invalid.`);
  }
  const lines = normalizeSourceLines(
    raw.lines,
    `PowerPoint capture slide ${number}`,
    state,
    code
  );
  const textSha256 = digest(
    raw.textSha256,
    `PowerPoint capture slide ${number} textSha256`,
    code
  );
  if (textSha256 !== slideLinesHash(lines)) {
    fail(code, `PowerPoint capture slide ${number} text hash is inconsistent.`);
  }
  state.capturedSlides += 1;
  if (state.capturedSlides > MAX_TOTAL_CAPTURED_SLIDES) {
    fail(code, 'PowerPoint family capture exceeds its total slide limit.');
  }
  return { number, lane: raw.lane, lines, textSha256 };
}

function normalizeCapture(raw, index, decksByRole, state, code) {
  exactKeys(raw, [
    'ordinal',
    'roleId',
    'deckSha256',
    'selectionOrigin',
    'candidateId',
    'titleSlide',
    'capturedTextSha256',
    'slides'
  ], `PowerPoint capture ${index + 1}`, code);
  const roleId = identifier(raw.roleId, `PowerPoint capture ${index + 1} roleId`, code);
  const deck = decksByRole.get(roleId);
  const deckSha256 = digest(
    raw.deckSha256,
    `PowerPoint capture ${index + 1} deckSha256`,
    code
  );
  if (!deck || deck.deckSha256 !== deckSha256) {
    fail(code, `PowerPoint capture ${index + 1} does not match its exact source deck.`);
  }
  if (!SELECTION_ORIGINS.has(raw.selectionOrigin)) {
    fail(code, `PowerPoint capture ${index + 1} selectionOrigin is invalid.`);
  }
  let candidateId = null;
  let titleSlide = null;
  if (raw.selectionOrigin === 'template-local') {
    candidateId = boundedText(
      raw.candidateId,
      `PowerPoint capture ${index + 1} candidateId`,
      128,
      code
    );
    if (!/^slides-\d{1,4}-\d{1,4}-\d{1,4}$/u.test(candidateId)) {
      fail(code, `PowerPoint capture ${index + 1} candidateId is invalid.`);
    }
    titleSlide = positiveInteger(
      raw.titleSlide,
      `PowerPoint capture ${index + 1} titleSlide`,
      deck.deckSlideCount,
      code
    );
  } else if (raw.candidateId !== null || raw.titleSlide !== null) {
    fail(code, `Manual PowerPoint capture ${index + 1} cannot claim template evidence.`);
  }
  if (
    !Array.isArray(raw.slides)
    || raw.slides.length < 1
    || raw.slides.length > MAX_SLIDES_PER_CAPTURE
  ) {
    fail(
      code,
      `PowerPoint capture ${index + 1} must contain 1 to ${MAX_SLIDES_PER_CAPTURE} slides.`
    );
  }
  if (raw.selectionOrigin === 'template-local' && raw.slides.length < 2) {
    fail(
      code,
      `PowerPoint capture ${index + 1} template-local evidence requires at least two slides.`
    );
  }
  const slides = raw.slides.map((slide, slideIndex) =>
    normalizeCaptureSlide(slide, slideIndex, deck, state, code));
  for (let slideIndex = 1; slideIndex < slides.length; slideIndex += 1) {
    if (slides[slideIndex].number <= slides[slideIndex - 1].number) {
      fail(code, `PowerPoint capture ${index + 1} slides must be strictly increasing.`);
    }
  }
  if (raw.selectionOrigin === 'template-local') {
    const match = /^slides-(\d{1,4})-(\d{1,4})-(\d{1,4})$/u.exec(candidateId);
    const candidateTitle = Number.parseInt(match[1], 10);
    const candidateStart = Number.parseInt(match[2], 10);
    const candidateEnd = Number.parseInt(match[3], 10);
    if (
      candidateTitle !== titleSlide
      || candidateStart !== titleSlide + 1
      || candidateStart !== slides[0].number
      || candidateEnd !== slides[slides.length - 1].number
      || slides.some((slide, slideIndex) =>
        slide.number !== candidateStart + slideIndex)
    ) {
      fail(
        code,
        `PowerPoint capture ${index + 1} does not match its template-local candidate.`
      );
    }
  }
  const capturedTextSha256 = digest(
    raw.capturedTextSha256,
    `PowerPoint capture ${index + 1} capturedTextSha256`,
    code
  );
  if (capturedTextSha256 !== orderedSlidesTextHash(slides)) {
    fail(code, `PowerPoint capture ${index + 1} text hash is inconsistent.`);
  }
  state.captures += 1;
  if (state.captures > MAX_CAPTURES) {
    fail(code, `PowerPoint family review can contain at most ${MAX_CAPTURES} captures.`);
  }
  return {
    ordinal: positiveInteger(
      raw.ordinal,
      `PowerPoint capture ${index + 1} ordinal`,
      MAX_CAPTURES_PER_MEMBER,
      code
    ),
    roleId,
    deckSha256,
    selectionOrigin: raw.selectionOrigin,
    candidateId,
    titleSlide,
    capturedTextSha256,
    slides
  };
}

function normalizeMember(
  raw,
  index,
  decksByRole,
  state,
  code,
  { schemaVersion, reviewedAt }
) {
  const storesLocalServiceRights =
    schemaVersion === SONG_FAMILY_REVIEW_SNAPSHOT_SCHEMA_VERSION;
  exactKeys(raw, [
    'songId',
    'familyRole',
    'translationOf',
    'action',
    'expectedRevision',
    'reviewedRevision',
    'finalTextSha256',
    'documentSource',
    'captures',
    ...(storesLocalServiceRights ? ['localServiceRights'] : [])
  ], `Reviewed family member ${index + 1}`, code);
  const songId = identifier(raw.songId, `Reviewed family member ${index + 1} songId`, code);
  if (!FAMILY_ROLES.has(raw.familyRole)) {
    fail(code, `Reviewed family member ${songId} familyRole is invalid.`);
  }
  if (!COMMIT_ACTIONS.has(raw.action)) {
    fail(code, `Reviewed family member ${songId} action is invalid.`);
  }
  const expectedRevision = nullableDigest(
    raw.expectedRevision,
    `Reviewed family member ${songId} expectedRevision`,
    code
  );
  if (raw.action === 'create' && expectedRevision !== null) {
    fail(code, `New reviewed family member ${songId} cannot have a prior revision.`);
  }
  if (raw.action !== 'create' && expectedRevision === null) {
    fail(code, `Reviewed family member ${songId} requires its exact prior revision.`);
  }
  if (typeof raw.documentSource !== 'string') {
    fail(code, `Reviewed family member ${songId} documentSource must be text.`);
  }
  const documentBytes = Buffer.byteLength(raw.documentSource, 'utf8');
  if (documentBytes < 1 || documentBytes > MAX_SOURCE_BYTES) {
    fail(code, `Reviewed family member ${songId} documentSource exceeds its limit.`);
  }
  state.documentSourceBytes += documentBytes;
  if (state.documentSourceBytes > MAX_TOTAL_DOCUMENT_SOURCE_BYTES) {
    fail(code, 'Reviewed family document sources exceed their total storage limit.');
  }
  let song;
  try {
    song = parseSongDocument(raw.documentSource, { fileName: `${songId}.md` });
  } catch (_error) {
    fail(code, `Reviewed family member ${songId} is not a valid SongDocument.`);
  }
  if (song.id !== songId || serializeSongDocument(song) !== raw.documentSource) {
    fail(code, `Reviewed family member ${songId} is not canonical.`);
  }
  const reviewedRevision = digest(
    raw.reviewedRevision,
    `Reviewed family member ${songId} reviewedRevision`,
    code
  );
  if (reviewedRevision !== sha256(Buffer.from(raw.documentSource, 'utf8'))) {
    fail(code, `Reviewed family member ${songId} revision is inconsistent.`);
  }
  const finalTextSha256 = digest(
    raw.finalTextSha256,
    `Reviewed family member ${songId} finalTextSha256`,
    code
  );
  if (finalTextSha256 !== songTextHash(song)) {
    fail(code, `Reviewed family member ${songId} final text hash is inconsistent.`);
  }
  if (raw.action === 'reuse' && expectedRevision !== reviewedRevision) {
    fail(code, `Reused reviewed family member ${songId} must retain its exact revision.`);
  }
  if (raw.action === 'update' && expectedRevision === reviewedRevision) {
    fail(code, `Updated reviewed family member ${songId} must change its exact revision.`);
  }
  if (
    !Array.isArray(raw.captures)
    || raw.captures.length > MAX_CAPTURES_PER_MEMBER
  ) {
    fail(
      code,
      `Reviewed family member ${songId} has too many PowerPoint captures.`
    );
  }
  if (raw.action !== 'reuse' && raw.captures.length < 1) {
    fail(code, `Reviewed family member ${songId} requires PowerPoint capture evidence.`);
  }
  const captures = raw.captures
    .map((capture, captureIndex) =>
      normalizeCapture(capture, captureIndex, decksByRole, state, code))
    .sort((left, right) => left.ordinal - right.ordinal);
  captures.forEach((capture, captureIndex) => {
    if (capture.ordinal !== captureIndex + 1) {
      fail(code, `Reviewed family member ${songId} capture ordinals must be consecutive.`);
    }
  });
  const translationOf = raw.translationOf === null
    ? null
    : identifier(
        raw.translationOf,
        `Reviewed family member ${songId} translationOf`,
        code
      );
  if (song.translationOf !== translationOf) {
    fail(code, `Reviewed family member ${songId} translation relationship is inconsistent.`);
  }
  const localServiceRights = storesLocalServiceRights
    ? normalizeMemberLocalServiceRights(raw.localServiceRights, {
      captured: captures.length > 0,
      reviewedAt,
      song,
      songId,
      code
    })
    : null;
  return {
    songId,
    familyRole: raw.familyRole,
    translationOf,
    action: raw.action,
    expectedRevision,
    reviewedRevision,
    finalTextSha256,
    documentSource: raw.documentSource,
    ...(storesLocalServiceRights ? { localServiceRights } : {}),
    captures,
    song
  };
}

function sameLines(left, right) {
  return left.length === right.length
    && left.every((line, index) => line === right[index]);
}

function captureEvidenceKey(songId, captureOrdinal, slideNumber) {
  return `${songId}\0${captureOrdinal}\0${slideNumber}`;
}

function normalizeOccurrenceEvidence(raw, occurrenceIndex, evidenceIndex, membersById, code) {
  exactKeys(
    raw,
    ['songId', 'captureOrdinal', 'slideNumber'],
    `Occurrence ${occurrenceIndex + 1} evidence ${evidenceIndex + 1}`,
    code
  );
  const songId = identifier(
    raw.songId,
    `Occurrence ${occurrenceIndex + 1} evidence songId`,
    code
  );
  const member = membersById.get(songId);
  const captureOrdinal = positiveInteger(
    raw.captureOrdinal,
    `Occurrence ${occurrenceIndex + 1} evidence captureOrdinal`,
    MAX_CAPTURES_PER_MEMBER,
    code
  );
  const slideNumber = positiveInteger(
    raw.slideNumber,
    `Occurrence ${occurrenceIndex + 1} evidence slideNumber`,
    1_000,
    code
  );
  const capture = member?.captures.find(candidate =>
    candidate.ordinal === captureOrdinal);
  const slide = capture?.slides.find(candidate =>
    candidate.number === slideNumber);
  if (!member || !capture || !slide) {
    fail(
      code,
      `Occurrence ${occurrenceIndex + 1} evidence does not identify an exact captured slide.`
    );
  }
  return {
    songId,
    captureOrdinal,
    slideNumber,
    slide
  };
}

function normalizeOccurrences(rawOccurrences, members, code) {
  if (
    !Array.isArray(rawOccurrences)
    || rawOccurrences.length < 1
    || rawOccurrences.length > MAX_OCCURRENCES
  ) {
    fail(
      code,
      `Reviewed family occurrences must contain 1 to ${MAX_OCCURRENCES} decisions.`
    );
  }
  const membersById = new Map(members.map(member => [member.songId, member]));
  const capturedMembers = members.filter(member => member.captures.length > 0);
  const memberOrder = new Map(
    [...members]
      .sort((left, right) =>
        Number(left.familyRole === 'translation')
          - Number(right.familyRole === 'translation')
        || compareCanonicalText(left.songId, right.songId))
      .map((member, index) => [member.songId, index])
  );
  const allCaptureSlides = new Set();
  for (const member of members) {
    for (const capture of member.captures) {
      for (const slide of capture.slides) {
        allCaptureSlides.add(
          captureEvidenceKey(member.songId, capture.ordinal, slide.number)
        );
      }
    }
  }
  const coveredCaptureSlides = new Set();
  const occurrencesById = new Map();
  const newOccurrences = [];
  const newSectionIds = new Set();
  const occurrences = rawOccurrences.map((raw, occurrenceIndex) => {
    exactKeys(raw, [
      'occurrenceId',
      'action',
      'sectionId',
      'repeatOfOccurrenceId',
      'evidence'
    ], `Reviewed family occurrence ${occurrenceIndex + 1}`, code);
    const occurrenceId = identifier(
      raw.occurrenceId,
      `Reviewed family occurrence ${occurrenceIndex + 1} occurrenceId`,
      code
    );
    if (occurrencesById.has(occurrenceId)) {
      fail(code, `Reviewed family occurrence ${occurrenceId} is repeated.`);
    }
    if (!OCCURRENCE_ACTIONS.has(raw.action)) {
      fail(code, `Reviewed family occurrence ${occurrenceId} action is invalid.`);
    }
    if (
      !Array.isArray(raw.evidence)
      || raw.evidence.length !== capturedMembers.length
    ) {
      fail(
        code,
        `Reviewed family occurrence ${occurrenceId} must identify every captured family member.`
      );
    }
    const evidenceWithSlides = raw.evidence.map((item, evidenceIndex) =>
      normalizeOccurrenceEvidence(
        item,
        occurrenceIndex,
        evidenceIndex,
        membersById,
        code
      ));
    const seenSongs = new Set();
    for (const evidence of evidenceWithSlides) {
      if (seenSongs.has(evidence.songId)) {
        fail(
          code,
          `Reviewed family occurrence ${occurrenceId} repeats member evidence.`
        );
      }
      seenSongs.add(evidence.songId);
      const key = captureEvidenceKey(
        evidence.songId,
        evidence.captureOrdinal,
        evidence.slideNumber
      );
      if (coveredCaptureSlides.has(key)) {
        fail(
          code,
          `Reviewed family occurrence ${occurrenceId} reuses captured slide evidence.`
        );
      }
      coveredCaptureSlides.add(key);
    }
    if (seenSongs.size !== capturedMembers.length) {
      fail(
        code,
        `Reviewed family occurrence ${occurrenceId} does not cover every captured family member.`
      );
    }

    const sectionId = raw.sectionId === null
      ? null
      : identifier(
          raw.sectionId,
          `Reviewed family occurrence ${occurrenceId} sectionId`,
          code
        );
    const repeatOfOccurrenceId = raw.repeatOfOccurrenceId === null
      ? null
      : identifier(
          raw.repeatOfOccurrenceId,
          `Reviewed family occurrence ${occurrenceId} repeatOfOccurrenceId`,
          code
        );
    if (raw.action === 'new') {
      if (
        sectionId === null
        || repeatOfOccurrenceId !== null
        || newSectionIds.has(sectionId)
      ) {
        fail(
          code,
          `New reviewed occurrence ${occurrenceId} has an invalid section decision.`
        );
      }
      newSectionIds.add(sectionId);
    } else if (raw.action === 'repeat') {
      const repeated = occurrencesById.get(repeatOfOccurrenceId);
      if (
        sectionId === null
        || !repeated
        || repeated.action === 'exclude'
        || repeated.sectionId !== sectionId
      ) {
        fail(
          code,
          `Repeated occurrence ${occurrenceId} must reuse a prior included section.`
        );
      }
      const repeatedBySong = new Map(
        repeated.evidenceWithSlides.map(item => [item.songId, item])
      );
      if (evidenceWithSlides.some(item =>
        !sameLines(item.slide.lines, repeatedBySong.get(item.songId).slide.lines))) {
        fail(
          code,
          `Repeated occurrence ${occurrenceId} is not an exact all-member text match.`
        );
      }
    } else if (sectionId !== null || repeatOfOccurrenceId !== null) {
      fail(
        code,
        `Excluded occurrence ${occurrenceId} cannot claim a canonical section.`
      );
    }
    const evidence = evidenceWithSlides
      .map(({ slide, ...item }) => item)
      .sort((left, right) =>
        memberOrder.get(left.songId) - memberOrder.get(right.songId));
    const normalized = {
      occurrenceId,
      action: raw.action,
      sectionId,
      repeatOfOccurrenceId,
      evidence,
      evidenceWithSlides
    };
    occurrencesById.set(occurrenceId, normalized);
    if (raw.action === 'new') newOccurrences.push(normalized);
    return normalized;
  });

  if (
    allCaptureSlides.size !== coveredCaptureSlides.size
    || [...allCaptureSlides].some(key => !coveredCaptureSlides.has(key))
  ) {
    fail(
      code,
      'Reviewed family occurrence decisions must cover every captured slide exactly once.'
    );
  }
  if (newOccurrences.length < 1) {
    fail(code, 'Reviewed family occurrences must retain at least one new section.');
  }
  for (const member of members) {
    if (member.song.sections.length !== newOccurrences.length) {
      fail(
        code,
        `Reviewed family member ${member.songId} sections do not match its occurrence decisions.`
      );
    }
    for (const [index, occurrence] of newOccurrences.entries()) {
      const section = member.song.sections[index];
      const evidence = occurrence.evidenceWithSlides.find(item =>
        item.songId === member.songId);
      if (
        section.id !== occurrence.sectionId
        || section.slides.length !== 1
        || (
          member.captures.length > 0
          && (
            !evidence
            || !sameLines(section.slides[0].lines, evidence.slide.lines)
          )
        )
      ) {
        fail(
          code,
          `Reviewed family member ${member.songId} section ${index + 1} does not match its exact new occurrence.`
        );
      }
    }
  }
  return occurrences.map(({ evidenceWithSlides, ...occurrence }) => occurrence);
}

function normalizeSnapshotRecord(raw, code = 'INVALID_REVIEW_SNAPSHOT') {
  const schemaVersion = raw?.schemaVersion;
  const hasConfirmations = [
    CONFIRMED_SONG_FAMILY_REVIEW_SNAPSHOT_SCHEMA_VERSION,
    SONG_FAMILY_REVIEW_SNAPSHOT_SCHEMA_VERSION
  ].includes(schemaVersion);
  exactKeys(raw, !hasConfirmations ? [
    'schemaVersion',
    'kind',
    'reviewScope',
    'reviewedAt',
    'serviceSet',
    'family'
  ] : [
    'schemaVersion',
    'kind',
    'reviewScope',
    'confirmations',
    'reviewedAt',
    'serviceSet',
    'family'
  ], 'Song-family review snapshot', code);
  if (
    ![
      LEGACY_SONG_FAMILY_REVIEW_SNAPSHOT_SCHEMA_VERSION,
      CONFIRMED_SONG_FAMILY_REVIEW_SNAPSHOT_SCHEMA_VERSION,
      SONG_FAMILY_REVIEW_SNAPSHOT_SCHEMA_VERSION
    ].includes(schemaVersion)
    || raw.kind !== SONG_FAMILY_REVIEW_SNAPSHOT_KIND
    || raw.reviewScope !== SONG_FAMILY_REVIEW_SCOPE
  ) {
    fail(code, 'Song-family review snapshot uses an unsupported schema.');
  }
  const confirmations = hasConfirmations
    ? normalizeReviewConfirmations(
      raw.confirmations,
      'Song-family review snapshot confirmations',
      code
    )
    : null;
  const reviewedAt = canonicalTimestamp(raw.reviewedAt, 'Song-family reviewedAt', code);
  const serviceSet = normalizeServiceSet(raw.serviceSet, code);
  exactKeys(
    raw.family,
    ['rootSongId', 'members', 'occurrences'],
    'Reviewed song family',
    code
  );
  const rootSongId = identifier(raw.family.rootSongId, 'Reviewed family rootSongId', code);
  if (
    !Array.isArray(raw.family.members)
    || raw.family.members.length < 1
    || raw.family.members.length > MAX_FAMILY_MEMBERS
  ) {
    fail(code, `Reviewed family must contain 1 to ${MAX_FAMILY_MEMBERS} members.`);
  }
  const state = {
    captures: 0,
    capturedSlides: 0,
    capturedTextBytes: 0,
    documentSourceBytes: 0
  };
  const decksByRole = new Map(serviceSet.decks.map(deck => [deck.roleId, deck]));
  const normalizedMembers = raw.family.members.map((member, index) =>
    normalizeMember(member, index, decksByRole, state, code, {
      schemaVersion,
      reviewedAt
    }));
  const seenSongs = new Set();
  for (const member of normalizedMembers) {
    if (seenSongs.has(member.songId)) {
      fail(code, 'Reviewed song family cannot repeat a song identity.');
    }
    seenSongs.add(member.songId);
  }
  const roots = normalizedMembers.filter(member => member.familyRole === 'original');
  if (
    roots.length !== 1
    || roots[0].songId !== rootSongId
    || roots[0].translationOf !== null
  ) {
    fail(code, 'Reviewed song family must contain exactly one unlinked original root.');
  }
  const root = roots[0];
  for (const member of normalizedMembers) {
    if (member.familyRole === 'translation') {
      if (member.translationOf !== rootSongId) {
        fail(code, 'Every reviewed translation must point directly to the exact root.');
      }
      if (!compareSongSections(root.song, member.song).compatible) {
        fail(code, `Reviewed translation ${member.songId} does not align with its root.`);
      }
    } else if (member.songId !== rootSongId) {
      fail(code, 'Reviewed song family contains more than one original.');
    }
  }
  const occurrences = normalizeOccurrences(
    raw.family.occurrences,
    normalizedMembers,
    code
  );
  if (state.captures < 1) {
    fail(code, 'Reviewed song family requires at least one PowerPoint capture.');
  }
  const members = normalizedMembers
    .sort((left, right) =>
      Number(left.familyRole === 'translation')
        - Number(right.familyRole === 'translation')
      || compareCanonicalText(left.songId, right.songId))
    .map(({ song, ...member }) => member);
  return deepFreeze({
    schemaVersion,
    kind: SONG_FAMILY_REVIEW_SNAPSHOT_KIND,
    reviewScope: SONG_FAMILY_REVIEW_SCOPE,
    ...(confirmations === null ? {} : { confirmations }),
    reviewedAt,
    serviceSet,
    family: {
      rootSongId,
      members,
      occurrences
    }
  });
}

function captureReceiptSummary(capture) {
  return {
    ordinal: capture.ordinal,
    roleId: capture.roleId,
    deckSha256: capture.deckSha256,
    selectionOrigin: capture.selectionOrigin,
    candidateId: capture.candidateId,
    titleSlide: capture.titleSlide,
    capturedTextSha256: capture.capturedTextSha256,
    slides: capture.slides.map(slide => ({
      number: slide.number,
      lane: slide.lane,
      textSha256: slide.textSha256
    }))
  };
}

function occurrenceReceiptSummary(occurrence, membersById) {
  return {
    occurrenceId: occurrence.occurrenceId,
    action: occurrence.action,
    sectionId: occurrence.sectionId,
    repeatOfOccurrenceId: occurrence.repeatOfOccurrenceId,
    evidence: occurrence.evidence.map(item => {
      const capture = membersById.get(item.songId).captures.find(candidate =>
        candidate.ordinal === item.captureOrdinal);
      const slide = capture.slides.find(candidate =>
        candidate.number === item.slideNumber);
      return {
        songId: item.songId,
        captureOrdinal: item.captureOrdinal,
        slideNumber: item.slideNumber,
        textSha256: slide.textSha256
      };
    })
  };
}

function normalizeReceiptCaptureSlide(raw, index, code) {
  exactKeys(
    raw,
    ['number', 'lane', 'textSha256'],
    `Receipt capture slide ${index + 1}`,
    code
  );
  if (!LANE_IDS.has(raw.lane)) fail(code, 'Receipt capture lane is invalid.');
  return {
    number: positiveInteger(raw.number, 'Receipt capture slide number', 1_000, code),
    lane: raw.lane,
    textSha256: digest(raw.textSha256, 'Receipt capture slide textSha256', code)
  };
}

function normalizeReceiptCapture(raw, index, code) {
  exactKeys(raw, [
    'ordinal',
    'roleId',
    'deckSha256',
    'selectionOrigin',
    'candidateId',
    'titleSlide',
    'capturedTextSha256',
    'slides'
  ], `Receipt capture ${index + 1}`, code);
  if (!SELECTION_ORIGINS.has(raw.selectionOrigin)) {
    fail(code, 'Receipt capture selectionOrigin is invalid.');
  }
  if (
    !Array.isArray(raw.slides)
    || raw.slides.length < 1
    || raw.slides.length > MAX_SLIDES_PER_CAPTURE
  ) {
    fail(code, 'Receipt capture slides are outside their limit.');
  }
  const slides = raw.slides.map((slide, slideIndex) =>
    normalizeReceiptCaptureSlide(slide, slideIndex, code));
  for (let slideIndex = 1; slideIndex < slides.length; slideIndex += 1) {
    if (slides[slideIndex].number <= slides[slideIndex - 1].number) {
      fail(code, 'Receipt capture slides must be strictly increasing.');
    }
  }
  return {
    ordinal: positiveInteger(raw.ordinal, 'Receipt capture ordinal', MAX_CAPTURES_PER_MEMBER, code),
    roleId: identifier(raw.roleId, 'Receipt capture roleId', code),
    deckSha256: digest(raw.deckSha256, 'Receipt capture deckSha256', code),
    selectionOrigin: raw.selectionOrigin,
    candidateId: raw.candidateId === null
      ? null
      : boundedText(raw.candidateId, 'Receipt capture candidateId', 128, code),
    titleSlide: raw.titleSlide === null
      ? null
      : positiveInteger(raw.titleSlide, 'Receipt capture titleSlide', 1_000, code),
    capturedTextSha256: digest(
      raw.capturedTextSha256,
      'Receipt capture capturedTextSha256',
      code
    ),
    slides
  };
}

function normalizeReceiptLocalServiceRights(
  raw,
  { captured, reviewedAt, songId, code }
) {
  let normalized;
  try {
    normalized = normalizeLocalServiceSongRightsEvidence(raw, {
      required: captured,
      reviewedAt
    });
  } catch (error) {
    if (error instanceof LocalServiceSongRightsEvidenceError) {
      fail(code, error.message, { songId });
    }
    throw error;
  }
  if (!captured && normalized !== null) {
    fail(
      code,
      `Uncaptured receipt result ${songId} cannot claim a current local-service rights review.`
    );
  }
  return normalized;
}

function normalizeReceiptResult(
  raw,
  index,
  code,
  { schemaVersion, reviewedAt }
) {
  const storesLocalServiceRights =
    schemaVersion === SONG_FAMILY_REVIEW_RECEIPT_SCHEMA_VERSION;
  exactKeys(raw, [
    'songId',
    'familyRole',
    'translationOf',
    'action',
    'previousRevision',
    'resultingRevision',
    'finalTextSha256',
    'captures',
    ...(storesLocalServiceRights ? ['localServiceRights'] : [])
  ], `Receipt family result ${index + 1}`, code);
  if (!FAMILY_ROLES.has(raw.familyRole) || !COMMIT_ACTIONS.has(raw.action)) {
    fail(code, 'Receipt family result role or action is invalid.');
  }
  if (!Array.isArray(raw.captures) || raw.captures.length > MAX_CAPTURES_PER_MEMBER) {
    fail(code, 'Receipt family result captures are outside their limit.');
  }
  const songId = identifier(raw.songId, 'Receipt result songId', code);
  const captures = raw.captures.map((capture, captureIndex) =>
    normalizeReceiptCapture(capture, captureIndex, code));
  const localServiceRights = storesLocalServiceRights
    ? normalizeReceiptLocalServiceRights(raw.localServiceRights, {
      captured: captures.length > 0,
      reviewedAt,
      songId,
      code
    })
    : null;
  return {
    songId,
    familyRole: raw.familyRole,
    translationOf: raw.translationOf === null
      ? null
      : identifier(raw.translationOf, 'Receipt result translationOf', code),
    action: raw.action,
    previousRevision: nullableDigest(
      raw.previousRevision,
      'Receipt result previousRevision',
      code
    ),
    resultingRevision: digest(
      raw.resultingRevision,
      'Receipt result resultingRevision',
      code
    ),
    finalTextSha256: digest(
      raw.finalTextSha256,
      'Receipt result finalTextSha256',
      code
    ),
    ...(storesLocalServiceRights ? { localServiceRights } : {}),
    captures
  };
}

function normalizeReceiptOccurrenceEvidence(raw, occurrenceIndex, evidenceIndex, code) {
  exactKeys(
    raw,
    ['songId', 'captureOrdinal', 'slideNumber', 'textSha256'],
    `Receipt occurrence ${occurrenceIndex + 1} evidence ${evidenceIndex + 1}`,
    code
  );
  return {
    songId: identifier(raw.songId, 'Receipt occurrence evidence songId', code),
    captureOrdinal: positiveInteger(
      raw.captureOrdinal,
      'Receipt occurrence evidence captureOrdinal',
      MAX_CAPTURES_PER_MEMBER,
      code
    ),
    slideNumber: positiveInteger(
      raw.slideNumber,
      'Receipt occurrence evidence slideNumber',
      1_000,
      code
    ),
    textSha256: digest(
      raw.textSha256,
      'Receipt occurrence evidence textSha256',
      code
    )
  };
}

function normalizeReceiptOccurrence(raw, index, code) {
  exactKeys(raw, [
    'occurrenceId',
    'action',
    'sectionId',
    'repeatOfOccurrenceId',
    'evidence'
  ], `Receipt occurrence ${index + 1}`, code);
  const occurrenceId = identifier(
    raw.occurrenceId,
    `Receipt occurrence ${index + 1} occurrenceId`,
    code
  );
  if (!OCCURRENCE_ACTIONS.has(raw.action)) {
    fail(code, `Receipt occurrence ${occurrenceId} action is invalid.`);
  }
  const sectionId = raw.sectionId === null
    ? null
    : identifier(raw.sectionId, `Receipt occurrence ${occurrenceId} sectionId`, code);
  const repeatOfOccurrenceId = raw.repeatOfOccurrenceId === null
    ? null
    : identifier(
        raw.repeatOfOccurrenceId,
        `Receipt occurrence ${occurrenceId} repeatOfOccurrenceId`,
        code
      );
  if (
    !Array.isArray(raw.evidence)
    || raw.evidence.length < 1
    || raw.evidence.length > MAX_FAMILY_MEMBERS
  ) {
    fail(code, `Receipt occurrence ${occurrenceId} evidence is outside its limit.`);
  }
  const evidence = raw.evidence.map((item, evidenceIndex) =>
    normalizeReceiptOccurrenceEvidence(item, index, evidenceIndex, code));
  if (new Set(evidence.map(item => item.songId)).size !== evidence.length) {
    fail(code, `Receipt occurrence ${occurrenceId} repeats member evidence.`);
  }
  if (
    (raw.action === 'new'
      && (sectionId === null || repeatOfOccurrenceId !== null))
    || (raw.action === 'repeat'
      && (sectionId === null || repeatOfOccurrenceId === null))
    || (raw.action === 'exclude'
      && (sectionId !== null || repeatOfOccurrenceId !== null))
  ) {
    fail(code, `Receipt occurrence ${occurrenceId} decision is inconsistent.`);
  }
  return {
    occurrenceId,
    action: raw.action,
    sectionId,
    repeatOfOccurrenceId,
    evidence
  };
}

function normalizeReceiptRecord(raw, code = 'REVIEW_RECEIPT_CORRUPT') {
  const schemaVersion = raw?.schemaVersion;
  const hasConfirmations = [
    CONFIRMED_SONG_FAMILY_REVIEW_RECEIPT_SCHEMA_VERSION,
    SONG_FAMILY_REVIEW_RECEIPT_SCHEMA_VERSION
  ].includes(schemaVersion);
  exactKeys(raw, !hasConfirmations ? [
    'schemaVersion',
    'kind',
    'reviewScope',
    'snapshotHash',
    'reviewedAt',
    'committedAt',
    'serviceSet',
    'captureSetHash',
    'rootSongId',
    'familyRevision',
    'results',
    'occurrences'
  ] : [
    'schemaVersion',
    'kind',
    'reviewScope',
    'confirmations',
    'snapshotHash',
    'reviewedAt',
    'committedAt',
    'serviceSet',
    'captureSetHash',
    'rootSongId',
    'familyRevision',
    'results',
    'occurrences'
  ], 'Song-family review receipt', code);
  if (
    ![
      LEGACY_SONG_FAMILY_REVIEW_RECEIPT_SCHEMA_VERSION,
      CONFIRMED_SONG_FAMILY_REVIEW_RECEIPT_SCHEMA_VERSION,
      SONG_FAMILY_REVIEW_RECEIPT_SCHEMA_VERSION
    ].includes(schemaVersion)
    || raw.kind !== SONG_FAMILY_REVIEW_RECEIPT_KIND
    || raw.reviewScope !== SONG_FAMILY_REVIEW_SCOPE
  ) {
    fail(code, 'Song-family review receipt uses an unsupported schema.');
  }
  const confirmations = hasConfirmations
    ? normalizeReviewConfirmations(
      raw.confirmations,
      'Song-family review receipt confirmations',
      code
    )
    : null;
  const reviewedAt = canonicalTimestamp(
    raw.reviewedAt,
    'Receipt reviewedAt',
    code
  );
  if (
    !Array.isArray(raw.results)
    || raw.results.length < 1
    || raw.results.length > MAX_FAMILY_MEMBERS
  ) {
    fail(code, 'Song-family review receipt results are outside their limit.');
  }
  const results = raw.results
    .map((result, index) => normalizeReceiptResult(
      result,
      index,
      code,
      { schemaVersion, reviewedAt }
    ))
    .sort((left, right) =>
      Number(left.familyRole === 'translation')
        - Number(right.familyRole === 'translation')
      || compareCanonicalText(left.songId, right.songId));
  const seen = new Set();
  for (const result of results) {
    if (seen.has(result.songId)) fail(code, 'Song-family receipt repeats a song identity.');
    seen.add(result.songId);
  }
  if (
    !Array.isArray(raw.occurrences)
    || raw.occurrences.length < 1
    || raw.occurrences.length > MAX_OCCURRENCES
  ) {
    fail(code, 'Song-family review receipt occurrences are outside their limit.');
  }
  const occurrences = raw.occurrences.map((occurrence, index) =>
    normalizeReceiptOccurrence(occurrence, index, code));
  if (
    new Set(occurrences.map(occurrence => occurrence.occurrenceId)).size
      !== occurrences.length
  ) {
    fail(code, 'Song-family review receipt repeats an occurrence identity.');
  }
  return deepFreeze({
    schemaVersion,
    kind: SONG_FAMILY_REVIEW_RECEIPT_KIND,
    reviewScope: SONG_FAMILY_REVIEW_SCOPE,
    ...(confirmations === null ? {} : { confirmations }),
    snapshotHash: digest(raw.snapshotHash, 'Receipt snapshotHash', code),
    reviewedAt,
    committedAt: canonicalTimestamp(raw.committedAt, 'Receipt committedAt', code),
    serviceSet: normalizeServiceSet(raw.serviceSet, code),
    captureSetHash: digest(raw.captureSetHash, 'Receipt captureSetHash', code),
    rootSongId: identifier(raw.rootSongId, 'Receipt rootSongId', code),
    familyRevision: digest(raw.familyRevision, 'Receipt familyRevision', code),
    results,
    occurrences
  });
}

function normalizeCommitResults(rawResults, snapshot) {
  if (
    !Array.isArray(rawResults)
    || rawResults.length !== snapshot.family.members.length
  ) {
    fail('INVALID_REVIEW_RECEIPT', 'Commit results must cover the exact reviewed family.');
  }
  const results = rawResults.map((raw, index) => {
    exactKeys(
      raw,
      ['songId', 'previousRevision', 'resultingRevision'],
      `Commit result ${index + 1}`,
      'INVALID_REVIEW_RECEIPT'
    );
    return {
      songId: identifier(
        raw.songId,
        `Commit result ${index + 1} songId`,
        'INVALID_REVIEW_RECEIPT'
      ),
      previousRevision: nullableDigest(
        raw.previousRevision,
        `Commit result ${index + 1} previousRevision`,
        'INVALID_REVIEW_RECEIPT'
      ),
      resultingRevision: digest(
        raw.resultingRevision,
        `Commit result ${index + 1} resultingRevision`,
        'INVALID_REVIEW_RECEIPT'
      )
    };
  }).sort((left, right) =>
    compareCanonicalText(left.songId, right.songId));
  const membersById = new Map(snapshot.family.members.map(member => [member.songId, member]));
  const seen = new Set();
  for (const result of results) {
    const member = membersById.get(result.songId);
    if (
      !member
      || seen.has(result.songId)
      || result.previousRevision !== member.expectedRevision
      || result.resultingRevision !== member.reviewedRevision
    ) {
      fail(
        'INVALID_REVIEW_RECEIPT',
        'Commit results do not match the exact reviewed revisions.'
      );
    }
    seen.add(result.songId);
  }
  return results;
}

function expectedFamilyRevision(snapshot) {
  return songFamilyRevision(snapshot.family.members.map(member => ({
    song: parseSongDocument(member.documentSource, {
      fileName: `${member.songId}.md`
    }),
    revision: member.reviewedRevision
  })));
}

function createReceipt(snapshotHash, snapshot, rawRequest) {
  exactKeys(rawRequest, [
    'snapshotHash',
    'committedAt',
    'familyRevision',
    'results'
  ], 'Song-family commit receipt request', 'INVALID_REVIEW_RECEIPT');
  if (rawRequest.snapshotHash !== snapshotHash) {
    fail('INVALID_REVIEW_RECEIPT', 'Commit receipt snapshotHash is inconsistent.');
  }
  const committedAt = canonicalTimestamp(
    rawRequest.committedAt,
    'Commit receipt committedAt',
    'INVALID_REVIEW_RECEIPT'
  );
  if (committedAt < snapshot.reviewedAt) {
    fail(
      'INVALID_REVIEW_RECEIPT',
      'Commit receipt committedAt cannot precede the exact family review.'
    );
  }
  const familyRevision = digest(
    rawRequest.familyRevision,
    'Commit receipt familyRevision',
    'INVALID_REVIEW_RECEIPT'
  );
  const computedFamilyRevision = expectedFamilyRevision(snapshot);
  if (familyRevision !== computedFamilyRevision) {
    fail(
      'INVALID_REVIEW_RECEIPT',
      'Commit receipt familyRevision does not match the exact resulting family.'
    );
  }
  const commitResults = normalizeCommitResults(rawRequest.results, snapshot);
  const resultsById = new Map(commitResults.map(result => [result.songId, result]));
  const storesLocalServiceRights =
    snapshot.schemaVersion === SONG_FAMILY_REVIEW_SNAPSHOT_SCHEMA_VERSION;
  const results = snapshot.family.members.map(member => ({
    songId: member.songId,
    familyRole: member.familyRole,
    translationOf: member.translationOf,
    action: member.action,
    previousRevision: resultsById.get(member.songId).previousRevision,
    resultingRevision: resultsById.get(member.songId).resultingRevision,
    finalTextSha256: member.finalTextSha256,
    ...(storesLocalServiceRights
      ? { localServiceRights: member.localServiceRights }
      : {}),
    captures: member.captures.map(captureReceiptSummary)
  }));
  const membersById = new Map(
    snapshot.family.members.map(member => [member.songId, member])
  );
  const occurrences = snapshot.family.occurrences.map(occurrence =>
    occurrenceReceiptSummary(occurrence, membersById));
  const captureSetHash = sha256(canonicalBuffer(
    {
      captures: results.flatMap(result => result.captures.map(capture => ({
        songId: result.songId,
        ...capture
      }))),
      occurrences
    }
  ));
  const receiptSchemaVersion = snapshot.schemaVersion ===
    LEGACY_SONG_FAMILY_REVIEW_SNAPSHOT_SCHEMA_VERSION
    ? LEGACY_SONG_FAMILY_REVIEW_RECEIPT_SCHEMA_VERSION
    : snapshot.schemaVersion ===
      CONFIRMED_SONG_FAMILY_REVIEW_SNAPSHOT_SCHEMA_VERSION
      ? CONFIRMED_SONG_FAMILY_REVIEW_RECEIPT_SCHEMA_VERSION
      : SONG_FAMILY_REVIEW_RECEIPT_SCHEMA_VERSION;
  const hasConfirmations =
    receiptSchemaVersion !== LEGACY_SONG_FAMILY_REVIEW_RECEIPT_SCHEMA_VERSION;
  return normalizeReceiptRecord({
    schemaVersion: receiptSchemaVersion,
    kind: SONG_FAMILY_REVIEW_RECEIPT_KIND,
    reviewScope: SONG_FAMILY_REVIEW_SCOPE,
    ...(hasConfirmations ? { confirmations: snapshot.confirmations } : {}),
    snapshotHash,
    reviewedAt: snapshot.reviewedAt,
    committedAt,
    serviceSet: snapshot.serviceSet,
    captureSetHash,
    rootSongId: snapshot.family.rootSongId,
    familyRevision,
    results,
    occurrences
  });
}

function assertReceiptMatchesSnapshot(receipt, snapshotHash, snapshot) {
  if (
    receipt.snapshotHash !== snapshotHash
    || snapshotHash !== sha256(canonicalBuffer(snapshot))
  ) {
    fail('REVIEW_RECEIPT_CORRUPT', 'Review receipt does not match its snapshot.');
  }
  const request = {
    snapshotHash,
    committedAt: receipt.committedAt,
    familyRevision: receipt.familyRevision,
    results: receipt.results.map(result => ({
      songId: result.songId,
      previousRevision: result.previousRevision,
      resultingRevision: result.resultingRevision
    }))
  };
  let expected;
  try {
    expected = createReceipt(snapshotHash, snapshot, request);
  } catch (_error) {
    fail('REVIEW_RECEIPT_CORRUPT', 'Review receipt does not match its snapshot.');
  }
  if (!canonicalEqual(receipt, expected)) {
    fail('REVIEW_RECEIPT_CORRUPT', 'Review receipt does not match its snapshot.');
  }
}

function normalizeCommitWitnessRecord(raw) {
  exactKeys(
    raw,
    [
      'schemaVersion',
      'kind',
      'snapshotHash',
      'receiptHash',
      'committedAt',
      'familyRevision'
    ],
    'Song-family commit witness',
    'REVIEW_RECEIPT_CORRUPT'
  );
  if (
    raw.schemaVersion !== 1
    || raw.kind !== COMMIT_WITNESS_KIND
  ) {
    fail(
      'REVIEW_RECEIPT_CORRUPT',
      'The song-family commit witness uses an invalid schema.'
    );
  }
  return deepFreeze({
    schemaVersion: 1,
    kind: COMMIT_WITNESS_KIND,
    snapshotHash: digest(
      raw.snapshotHash,
      'Commit witness snapshotHash',
      'REVIEW_RECEIPT_CORRUPT'
    ),
    receiptHash: digest(
      raw.receiptHash,
      'Commit witness receiptHash',
      'REVIEW_RECEIPT_CORRUPT'
    ),
    committedAt: canonicalTimestamp(
      raw.committedAt,
      'Commit witness committedAt',
      'REVIEW_RECEIPT_CORRUPT'
    ),
    familyRevision: digest(
      raw.familyRevision,
      'Commit witness familyRevision',
      'REVIEW_RECEIPT_CORRUPT'
    )
  });
}

function normalizeReceiptCapacityReservationRecord(raw) {
  exactKeys(
    raw,
    ['schemaVersion', 'kind', 'snapshotHash'],
    'Song-family receipt capacity reservation',
    'REVIEW_RECEIPT_CORRUPT'
  );
  if (
    raw.schemaVersion !== 1
    || raw.kind !== RECEIPT_CAPACITY_RESERVATION_KIND
  ) {
    fail(
      'REVIEW_RECEIPT_CORRUPT',
      'The song-family receipt capacity reservation uses an invalid schema.'
    );
  }
  return deepFreeze({
    schemaVersion: 1,
    kind: RECEIPT_CAPACITY_RESERVATION_KIND,
    snapshotHash: digest(
      raw.snapshotHash,
      'Receipt capacity reservation snapshotHash',
      'REVIEW_RECEIPT_CORRUPT'
    )
  });
}

function commitWitness(snapshotHash, receiptHash, receipt) {
  return normalizeCommitWitnessRecord({
    schemaVersion: 1,
    kind: COMMIT_WITNESS_KIND,
    snapshotHash,
    receiptHash,
    committedAt: receipt.committedAt,
    familyRevision: receipt.familyRevision
  });
}

function assertCommitWitnessMatchesReceipt(
  witness,
  snapshotHash,
  receiptHash,
  receipt
) {
  if (!canonicalEqual(
    witness,
    commitWitness(snapshotHash, receiptHash, receipt)
  )) {
    fail(
      'REVIEW_RECEIPT_CORRUPT',
      'The song-family commit witness does not match its immutable receipt.'
    );
  }
}

function normalizeLookup(raw, code = 'INVALID_REVIEW_LOOKUP') {
  if (!isRecord(raw)) fail(code, 'Review lookup must be an object.');
  if (raw.kind === 'member') {
    exactKeys(raw, ['kind', 'songId', 'revision'], 'Member review lookup', code);
    return deepFreeze({
      kind: 'member',
      songId: identifier(raw.songId, 'Member review lookup songId', code),
      revision: digest(raw.revision, 'Member review lookup revision', code)
    });
  }
  if (raw.kind === 'family') {
    exactKeys(
      raw,
      ['kind', 'rootSongId', 'familyRevision'],
      'Family review lookup',
      code
    );
    return deepFreeze({
      kind: 'family',
      rootSongId: identifier(raw.rootSongId, 'Family review lookup rootSongId', code),
      familyRevision: digest(
        raw.familyRevision,
        'Family review lookup familyRevision',
        code
      )
    });
  }
  fail(code, 'Review lookup kind is unsupported.');
}

function normalizeServiceSetBinding(raw, code = 'INVALID_REVIEW_LOOKUP') {
  exactKeys(
    raw,
    ['id', 'fingerprint', 'serviceDate', 'profileId'],
    'Exact reviewed ServiceSet binding',
    code
  );
  if (
    typeof raw.serviceDate !== 'string'
    || !/^\d{4}-\d{2}-\d{2}$/u.test(raw.serviceDate)
    || !Number.isFinite(Date.parse(`${raw.serviceDate}T00:00:00.000Z`))
    || new Date(`${raw.serviceDate}T00:00:00.000Z`)
      .toISOString()
      .slice(0, 10) !== raw.serviceDate
  ) {
    fail(code, 'Exact reviewed ServiceSet serviceDate is invalid.');
  }
  return deepFreeze({
    id: identifier(raw.id, 'Exact reviewed ServiceSet id', code),
    fingerprint: digest(
      raw.fingerprint,
      'Exact reviewed ServiceSet fingerprint',
      code
    ),
    serviceDate: raw.serviceDate,
    profileId: identifier(
      raw.profileId,
      'Exact reviewed ServiceSet profileId',
      code
    )
  });
}

function serviceSetMatchesBinding(serviceSet, binding) {
  return serviceSet.id === binding.id
    && serviceSet.fingerprint === binding.fingerprint
    && serviceSet.serviceDate === binding.serviceDate
    && serviceSet.profileId === binding.profileId;
}

function lookupsForReceipt(receipt) {
  return [
    normalizeLookup({
      kind: 'family',
      rootSongId: receipt.rootSongId,
      familyRevision: receipt.familyRevision
    }),
    ...receipt.results.map(result => normalizeLookup({
      kind: 'member',
      songId: result.songId,
      revision: result.resultingRevision
    }))
  ];
}

function normalizeIndexRecord(raw) {
  exactKeys(
    raw,
    ['schemaVersion', 'kind', 'lookup', 'receipts'],
    'Song-family review index',
    'REVIEW_INDEX_CORRUPT'
  );
  if (
    raw.schemaVersion !== SONG_FAMILY_REVIEW_INDEX_SCHEMA_VERSION
    || raw.kind !== SONG_FAMILY_REVIEW_INDEX_KIND
    || !Array.isArray(raw.receipts)
    || raw.receipts.length < 1
    || raw.receipts.length > MAX_INDEX_ENTRIES
  ) {
    fail('REVIEW_INDEX_CORRUPT', 'Song-family review index uses an invalid schema.');
  }
  const seen = new Set();
  const receipts = raw.receipts.map((reference, index) => {
    exactKeys(
      reference,
      ['snapshotHash', 'receiptHash'],
      `Song-family review index reference ${index + 1}`,
      'REVIEW_INDEX_CORRUPT'
    );
    const normalized = {
      snapshotHash: digest(
        reference.snapshotHash,
        'Index snapshotHash',
        'REVIEW_INDEX_CORRUPT'
      ),
      receiptHash: digest(
        reference.receiptHash,
        'Index receiptHash',
        'REVIEW_INDEX_CORRUPT'
      )
    };
    const key = `${normalized.snapshotHash}:${normalized.receiptHash}`;
    if (seen.has(key)) fail('REVIEW_INDEX_CORRUPT', 'Review index repeats a receipt.');
    seen.add(key);
    return normalized;
  }).sort((left, right) =>
    compareCanonicalText(left.receiptHash, right.receiptHash)
    || compareCanonicalText(left.snapshotHash, right.snapshotHash));
  return deepFreeze({
    schemaVersion: SONG_FAMILY_REVIEW_INDEX_SCHEMA_VERSION,
    kind: SONG_FAMILY_REVIEW_INDEX_KIND,
    lookup: normalizeLookup(raw.lookup, 'REVIEW_INDEX_CORRUPT'),
    receipts
  });
}

function lookupMatchesReceipt(lookup, receipt) {
  return lookupsForReceipt(receipt).some(candidate =>
    canonicalEqual(candidate, lookup));
}

async function ensureOwnerOnlyDirectory(rootPath, directoryPath) {
  const root = await ensurePrivateDirectory(rootPath);
  const target = await ensureConfinedDirectory(root, directoryPath);
  if (process.platform !== 'win32') {
    const relative = path.relative(root, target);
    let current = root;
    for (const component of relative ? relative.split(path.sep) : []) {
      current = path.join(current, component);
      const stats = await fs.lstat(current);
      if (!stats.isDirectory() || stats.isSymbolicLink()) {
        throw new Error('Song-family review storage directory is unsafe.');
      }
      if ((stats.mode & 0o077) !== 0) await fs.chmod(current, 0o700);
    }
  }
  return target;
}

class LocalSongFamilyReviewStore {
  constructor(options = {}) {
    if (typeof options.rootPath !== 'string' || !path.isAbsolute(options.rootPath)) {
      throw new TypeError('LocalSongFamilyReviewStore requires an absolute rootPath');
    }
    this.rootPath = path.resolve(options.rootPath);
    this.maximumSnapshots = capacityOption(
      options.maximumSnapshots,
      MAX_SNAPSHOTS,
      MAX_SNAPSHOTS,
      'maximumSnapshots'
    );
    this.maximumReceipts = capacityOption(
      options.maximumReceipts,
      MAX_RECEIPTS,
      MAX_RECEIPTS,
      'maximumReceipts'
    );
    this.maximumIndexEntries = capacityOption(
      options.maximumIndexEntries,
      MAX_INDEX_ENTRIES,
      MAX_INDEX_ENTRIES,
      'maximumIndexEntries'
    );
  }

  async initialize() {
    try {
      this.rootPath = await ensurePrivateDirectory(this.rootPath);
      for (const name of [
        'snapshots',
        'receipts',
        'indexes',
        path.join('indexes', 'member'),
        path.join('indexes', 'family')
      ]) {
        await ensureOwnerOnlyDirectory(this.rootPath, path.join(this.rootPath, name));
      }
    } catch (error) {
      if (error instanceof LocalSongFamilyReviewStoreError) throw error;
      fail('STORE_UNAVAILABLE', 'The local song-family review store is unavailable.');
    }
    return this;
  }

  _snapshotPath(snapshotHash) {
    return path.join(
      this.rootPath,
      'snapshots',
      snapshotHash.slice(0, 2),
      `${snapshotHash}.json`
    );
  }

  _receiptDirectory(snapshotHash) {
    return path.join(
      this.rootPath,
      'receipts',
      snapshotHash.slice(0, 2),
      snapshotHash
    );
  }

  _receiptPath(snapshotHash, receiptHash) {
    return path.join(this._receiptDirectory(snapshotHash), `${receiptHash}.json`);
  }

  _receiptProvisionPath(snapshotHash) {
    return path.join(
      this._receiptDirectory(snapshotHash),
      RECEIPT_STORAGE_PROVISION_FILE
    );
  }

  _receiptCapacityReservationPath(snapshotHash) {
    return path.join(
      this._receiptDirectory(snapshotHash),
      RECEIPT_CAPACITY_RESERVATION_FILE
    );
  }

  _commitWitnessPath(snapshotHash) {
    return path.join(
      this._receiptDirectory(snapshotHash),
      COMMIT_WITNESS_FILE
    );
  }

  _indexPath(lookup) {
    const lookupHash = sha256(canonicalBuffer(lookup));
    return path.join(
      this.rootPath,
      'indexes',
      lookup.kind,
      lookupHash.slice(0, 2),
      `${lookupHash}.json`
    );
  }

  async _readCanonicalRecord(
    filePath,
    maximumBytes,
    normalize,
    { missingCode, corruptCode, missingMessage, corruptMessage }
  ) {
    let buffer;
    let stats;
    try {
      ({ buffer, stats } = await readFileNoFollow(filePath, maximumBytes));
    } catch (error) {
      if (error.code === 'ENOENT') fail(missingCode, missingMessage);
      fail(corruptCode, corruptMessage);
    }
    if (process.platform !== 'win32' && (stats.mode & 0o077) !== 0) {
      fail(corruptCode, corruptMessage);
    }
    let parsed;
    try {
      parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(buffer));
    } catch (_error) {
      fail(corruptCode, corruptMessage);
    }
    let normalized;
    try {
      normalized = normalize(parsed);
    } catch (_error) {
      fail(corruptCode, corruptMessage);
    }
    if (!buffer.equals(canonicalBuffer(normalized))) {
      fail(corruptCode, corruptMessage);
    }
    return { buffer, normalized };
  }

  async _readSnapshot(snapshotHash) {
    digest(snapshotHash, 'Song-family snapshot hash', 'INVALID_SNAPSHOT_HASH');
    const snapshotPath = this._snapshotPath(snapshotHash);
    try {
      await ensureOwnerOnlyDirectory(this.rootPath, path.dirname(snapshotPath));
    } catch (_error) {
      fail('SNAPSHOT_CORRUPT', 'The stored song-family snapshot is unsafe.');
    }
    const { buffer, normalized } = await this._readCanonicalRecord(
      snapshotPath,
      MAX_SNAPSHOT_BYTES,
      raw => normalizeSnapshotRecord(raw, 'SNAPSHOT_CORRUPT'),
      {
        missingCode: 'SNAPSHOT_NOT_FOUND',
        corruptCode: 'SNAPSHOT_CORRUPT',
        missingMessage: 'The requested song-family snapshot is unavailable.',
        corruptMessage: 'The stored song-family snapshot failed validation.'
      }
    );
    if (sha256(buffer) !== snapshotHash) {
      fail('SNAPSHOT_CORRUPT', 'The stored song-family snapshot failed validation.');
    }
    return normalized;
  }

  async _readReceipt(snapshotHash, receiptHash) {
    digest(snapshotHash, 'Receipt snapshot hash', 'INVALID_SNAPSHOT_HASH');
    digest(receiptHash, 'Song-family receipt hash', 'INVALID_RECEIPT_HASH');
    const receiptPath = this._receiptPath(snapshotHash, receiptHash);
    try {
      await ensureOwnerOnlyDirectory(this.rootPath, path.dirname(receiptPath));
    } catch (_error) {
      fail('REVIEW_RECEIPT_CORRUPT', 'The stored song-family receipt is unsafe.');
    }
    const { buffer, normalized } = await this._readCanonicalRecord(
      receiptPath,
      MAX_RECEIPT_BYTES,
      normalizeReceiptRecord,
      {
        missingCode: 'REVIEW_RECEIPT_NOT_FOUND',
        corruptCode: 'REVIEW_RECEIPT_CORRUPT',
        missingMessage: 'The requested song-family receipt is unavailable.',
        corruptMessage: 'The stored song-family receipt failed validation.'
      }
    );
    if (
      sha256(buffer) !== receiptHash
      || normalized.snapshotHash !== snapshotHash
    ) {
      fail('REVIEW_RECEIPT_CORRUPT', 'The stored song-family receipt failed validation.');
    }
    return normalized;
  }

  async _readCommitWitness(snapshotHash, { missingIsNull = false } = {}) {
    digest(snapshotHash, 'Commit witness snapshot hash', 'INVALID_SNAPSHOT_HASH');
    const witnessPath = this._commitWitnessPath(snapshotHash);
    try {
      await ensureOwnerOnlyDirectory(this.rootPath, path.dirname(witnessPath));
    } catch (_error) {
      fail(
        'REVIEW_RECEIPT_CORRUPT',
        'The stored song-family commit witness is unsafe.'
      );
    }
    let result;
    try {
      result = await this._readCanonicalRecord(
        witnessPath,
        MAX_COMMIT_WITNESS_BYTES,
        normalizeCommitWitnessRecord,
        {
          missingCode: 'COMMIT_WITNESS_NOT_FOUND',
          corruptCode: 'REVIEW_RECEIPT_CORRUPT',
          missingMessage: 'No song-family commit witness is available.',
          corruptMessage: 'The stored song-family commit witness failed validation.'
        }
      );
    } catch (error) {
      if (
        missingIsNull
        && error instanceof LocalSongFamilyReviewStoreError
        && error.code === 'COMMIT_WITNESS_NOT_FOUND'
      ) {
        return null;
      }
      throw error;
    }
    if (result.normalized.snapshotHash !== snapshotHash) {
      fail(
        'REVIEW_RECEIPT_CORRUPT',
        'The stored song-family commit witness failed validation.'
      );
    }
    return result.normalized;
  }

  async _readReceiptCapacityReservation(
    snapshotHash,
    { missingIsNull = false } = {}
  ) {
    digest(
      snapshotHash,
      'Receipt capacity reservation snapshot hash',
      'INVALID_SNAPSHOT_HASH'
    );
    const reservationPath =
      this._receiptCapacityReservationPath(snapshotHash);
    try {
      await ensureOwnerOnlyDirectory(
        this.rootPath,
        path.dirname(reservationPath)
      );
    } catch (_error) {
      fail(
        'REVIEW_RECEIPT_CORRUPT',
        'The stored song-family receipt capacity reservation is unsafe.'
      );
    }
    let result;
    try {
      result = await this._readCanonicalRecord(
        reservationPath,
        MAX_RECEIPT_CAPACITY_RESERVATION_BYTES,
        normalizeReceiptCapacityReservationRecord,
        {
          missingCode: 'RECEIPT_CAPACITY_RESERVATION_NOT_FOUND',
          corruptCode: 'REVIEW_RECEIPT_CORRUPT',
          missingMessage:
            'No song-family receipt capacity reservation is available.',
          corruptMessage:
            'The stored song-family receipt capacity reservation failed validation.'
        }
      );
    } catch (error) {
      if (
        missingIsNull
        && error instanceof LocalSongFamilyReviewStoreError
        && error.code === 'RECEIPT_CAPACITY_RESERVATION_NOT_FOUND'
      ) {
        return null;
      }
      throw error;
    }
    if (result.normalized.snapshotHash !== snapshotHash) {
      fail(
        'REVIEW_RECEIPT_CORRUPT',
        'The stored song-family receipt capacity reservation failed validation.'
      );
    }
    return result.normalized;
  }

  async _readIndex(lookup, { missingIsNull = false } = {}) {
    const indexPath = this._indexPath(lookup);
    try {
      await ensureOwnerOnlyDirectory(this.rootPath, path.dirname(indexPath));
    } catch (_error) {
      fail('REVIEW_INDEX_CORRUPT', 'The song-family review index is unsafe.');
    }
    let result;
    try {
      result = await this._readCanonicalRecord(
        indexPath,
        MAX_INDEX_BYTES,
        normalizeIndexRecord,
        {
          missingCode: 'REVIEW_INDEX_NOT_FOUND',
          corruptCode: 'REVIEW_INDEX_CORRUPT',
          missingMessage: 'No exact reviewed song family matches that lookup.',
          corruptMessage: 'The song-family review index failed validation.'
        }
      );
    } catch (error) {
      if (
        missingIsNull
        && error instanceof LocalSongFamilyReviewStoreError
        && error.code === 'REVIEW_INDEX_NOT_FOUND'
      ) {
        return null;
      }
      throw error;
    }
    if (!canonicalEqual(result.normalized.lookup, lookup)) {
      fail('REVIEW_INDEX_CORRUPT', 'The song-family review index is inconsistent.');
    }
    return result.normalized;
  }

  async _storeImmutable(filePath, bytes, expectedHash, maximumBytes, code, label) {
    try {
      const { buffer, stats } = await readFileNoFollow(filePath, maximumBytes);
      if (
        (process.platform !== 'win32' && (stats.mode & 0o077) !== 0)
        || !buffer.equals(bytes)
        || sha256(buffer) !== expectedHash
      ) {
        fail(code, `An immutable ${label} has changed.`);
      }
      await flushPublishedFile(filePath, bytes);
      try {
        await fsyncDirectory(path.dirname(filePath));
      } catch (error) {
        if (
          process.platform !== 'win32'
          || !['EINVAL', 'EPERM', 'EBADF', 'EACCES'].includes(error.code)
        ) {
          throw error;
        }
      }
      return true;
    } catch (error) {
      if (error instanceof LocalSongFamilyReviewStoreError) throw error;
      if (error.code !== 'ENOENT') fail(code, `An immutable ${label} is unsafe.`);
    }
    try {
      await atomicWriteFile(filePath, bytes, {
        rootPath: this.rootPath,
        maximumBytes,
        mode: 0o600
      });
      const { buffer, stats } = await readFileNoFollow(filePath, maximumBytes);
      if (
        (process.platform !== 'win32' && (stats.mode & 0o077) !== 0)
        || !buffer.equals(bytes)
        || sha256(buffer) !== expectedHash
      ) {
        fail(code, `The saved ${label} failed validation.`);
      }
    } catch (error) {
      if (error instanceof LocalSongFamilyReviewStoreError) throw error;
      fail(code, `The ${label} could not be saved safely.`);
    }
    return false;
  }

  async _provisionReceiptStorage(snapshotHash) {
    digest(
      snapshotHash,
      'Receipt storage snapshot hash',
      'INVALID_SNAPSHOT_HASH'
    );
    const directory = this._receiptDirectory(snapshotHash);
    await ensureOwnerOnlyDirectory(this.rootPath, directory);
    const marker = {
      schemaVersion: 1,
      kind: RECEIPT_STORAGE_PROVISION_KIND,
      snapshotHash
    };
    const bytes = canonicalBuffer(marker);
    const markerPath = this._receiptProvisionPath(snapshotHash);
    try {
      await atomicWriteFile(markerPath, bytes, {
        rootPath: this.rootPath,
        maximumBytes: MAX_RECEIPT_STORAGE_PROVISION_BYTES,
        mode: 0o600
      });
      const read = await readFileNoFollow(
        markerPath,
        MAX_RECEIPT_STORAGE_PROVISION_BYTES
      );
      if (
        !read.buffer.equals(bytes)
        || (
          process.platform !== 'win32'
          && (read.stats.mode & 0o077) !== 0
        )
      ) {
        throw new Error('receipt storage marker mismatch');
      }
    } catch (_error) {
      fail(
        'RECEIPT_STORAGE_UNAVAILABLE',
        'The durable receipt location for this reviewed family could not be prepared.'
      );
    }
    return deepFreeze({ snapshotHash, prepared: true });
  }

  async _assertReceiptStorageProvisioned(snapshotHash) {
    const expected = canonicalBuffer({
      schemaVersion: 1,
      kind: RECEIPT_STORAGE_PROVISION_KIND,
      snapshotHash
    });
    try {
      const read = await readFileNoFollow(
        this._receiptProvisionPath(snapshotHash),
        MAX_RECEIPT_STORAGE_PROVISION_BYTES
      );
      if (
        !read.buffer.equals(expected)
        || (
          process.platform !== 'win32'
          && (read.stats.mode & 0o077) !== 0
        )
      ) {
        throw new Error('receipt storage marker mismatch');
      }
    } catch (_error) {
      fail(
        'RECEIPT_STORAGE_UNAVAILABLE',
        'The durable receipt location for this reviewed family is unavailable.'
      );
    }
  }

  async _countSnapshotFiles(stopAfter) {
    let count = 0;
    const root = path.join(this.rootPath, 'snapshots');
    const prefixes = await fs.readdir(root, { withFileTypes: true });
    for (const prefix of prefixes) {
      if (!HASH_PREFIX_PATTERN.test(prefix.name)) continue;
      if (!prefix.isDirectory() || prefix.isSymbolicLink?.()) {
        fail('STORE_UNAVAILABLE', 'The song-family snapshot store is unsafe.');
      }
      const directory = path.join(root, prefix.name);
      await ensureOwnerOnlyDirectory(this.rootPath, directory);
      const entries = await fs.readdir(directory, { withFileTypes: true });
      for (const entry of entries) {
        if (!HASH_FILE_PATTERN.test(entry.name)) continue;
        count += 1;
        if (count >= stopAfter) return count;
      }
    }
    return count;
  }

  async _countReceiptSlots(stopAfter) {
    let count = 0;
    const root = path.join(this.rootPath, 'receipts');
    const prefixes = await fs.readdir(root, { withFileTypes: true });
    for (const prefix of prefixes) {
      if (!HASH_PREFIX_PATTERN.test(prefix.name)) continue;
      if (!prefix.isDirectory() || prefix.isSymbolicLink?.()) {
        fail('STORE_UNAVAILABLE', 'The song-family receipt store is unsafe.');
      }
      const prefixPath = path.join(root, prefix.name);
      await ensureOwnerOnlyDirectory(this.rootPath, prefixPath);
      const snapshotDirectories = await fs.readdir(prefixPath, {
        withFileTypes: true
      });
      for (const snapshotDirectory of snapshotDirectories) {
        if (!HASH_DIRECTORY_PATTERN.test(snapshotDirectory.name)) continue;
        if (
          snapshotDirectory.name.slice(0, 2) !== prefix.name
          || !snapshotDirectory.isDirectory()
          || snapshotDirectory.isSymbolicLink?.()
        ) {
          fail('STORE_UNAVAILABLE', 'The song-family receipt store is unsafe.');
        }
        const directory = path.join(prefixPath, snapshotDirectory.name);
        await ensureOwnerOnlyDirectory(this.rootPath, directory);
        const entries = await fs.readdir(directory, { withFileTypes: true });
        const receiptEntries = entries.filter(entry =>
          HASH_FILE_PATTERN.test(entry.name));
        if (
          receiptEntries.length > 1
          || receiptEntries.some(entry =>
            !entry.isFile() || entry.isSymbolicLink?.())
        ) {
          fail(
            'REVIEW_RECEIPT_CORRUPT',
            'The song-family receipt store contains unsafe commit evidence.'
          );
        }
        const reservationEntry = entries.find(entry =>
          entry.name === RECEIPT_CAPACITY_RESERVATION_FILE);
        if (
          reservationEntry
          && (
            !reservationEntry.isFile()
            || reservationEntry.isSymbolicLink?.()
          )
        ) {
          fail(
            'REVIEW_RECEIPT_CORRUPT',
            'The song-family receipt store contains an unsafe capacity reservation.'
          );
        }
        if (reservationEntry) {
          await this._readReceiptCapacityReservation(
            snapshotDirectory.name
          );
        }
        if (reservationEntry || receiptEntries.length === 1) {
          count += 1;
          if (count >= stopAfter) return count;
        }
      }
    }
    return count;
  }

  async _reserveCommitReceiptCapacity(snapshotHash) {
    const existing = await this._readReceiptCapacityReservation(
      snapshotHash,
      { missingIsNull: true }
    );
    if (existing) return existing;

    const receiptEntries = await this._receiptFileEntries(snapshotHash);
    if (receiptEntries.length > 1) {
      fail(
        'REVIEW_RECEIPT_CORRUPT',
        'A song-family snapshot has more than one immutable receipt.'
      );
    }
    if (receiptEntries.length === 1) {
      const receiptHash = HASH_FILE_PATTERN.exec(receiptEntries[0].name)[1];
      await this._readReceipt(snapshotHash, receiptHash);
    } else if (
      await this._countReceiptSlots(this.maximumReceipts)
        >= this.maximumReceipts
    ) {
      fail(
        'RECEIPT_CAPACITY_REACHED',
        `The local song-family review store can contain at most ${this.maximumReceipts} receipts.`
      );
    }

    // A snapshot can have at most one receipt, so its immutable hash is the
    // reservation identity. Retries intentionally reuse this slot even when
    // they compute a new transaction timestamp before a journal is published.
    const reservation =
      normalizeReceiptCapacityReservationRecord({
        schemaVersion: 1,
        kind: RECEIPT_CAPACITY_RESERVATION_KIND,
        snapshotHash
      });
    const bytes = canonicalBuffer(reservation);
    await this._storeImmutable(
      this._receiptCapacityReservationPath(snapshotHash),
      bytes,
      sha256(bytes),
      MAX_RECEIPT_CAPACITY_RESERVATION_BYTES,
      'REVIEW_RECEIPT_CORRUPT',
      'song-family receipt capacity reservation'
    );
    return this._readReceiptCapacityReservation(snapshotHash);
  }

  async _receiptFileEntries(snapshotHash) {
    const directory = this._receiptDirectory(snapshotHash);
    let stats;
    try {
      stats = await fs.lstat(directory);
    } catch (error) {
      if (error.code === 'ENOENT') return [];
      fail('REVIEW_RECEIPT_CORRUPT', 'The song-family receipt directory is unsafe.');
    }
    if (!stats.isDirectory() || stats.isSymbolicLink()) {
      fail('REVIEW_RECEIPT_CORRUPT', 'The song-family receipt directory is unsafe.');
    }
    try {
      await ensureOwnerOnlyDirectory(this.rootPath, directory);
    } catch (_error) {
      fail('REVIEW_RECEIPT_CORRUPT', 'The song-family receipt directory is unsafe.');
    }
    const entries = await fs.readdir(directory, { withFileTypes: true });
    return entries.filter(entry => HASH_FILE_PATTERN.test(entry.name));
  }

  async _writeFullIndex(index) {
    const bytes = canonicalBuffer(index);
    if (bytes.length > MAX_INDEX_BYTES) {
      fail('REVIEW_INDEX_CAPACITY_REACHED', 'The song-family review index is too large.');
    }
    const indexPath = this._indexPath(index.lookup);
    await ensureOwnerOnlyDirectory(this.rootPath, path.dirname(indexPath));
    await atomicWriteFile(indexPath, bytes, {
      rootPath: this.rootPath,
      maximumBytes: MAX_INDEX_BYTES,
      mode: 0o600
    });
    return this._readIndex(index.lookup);
  }

  async _writeIndexReference(lookup, reference) {
    const current = await this._readIndex(lookup, { missingIsNull: true });
    const receipts = current ? [...current.receipts] : [];
    const exists = receipts.some(candidate =>
      candidate.snapshotHash === reference.snapshotHash
      && candidate.receiptHash === reference.receiptHash);
    if (!exists && receipts.length >= this.maximumIndexEntries) {
      fail(
        'REVIEW_INDEX_CAPACITY_REACHED',
        'That exact song-family review lookup has reached its limit.'
      );
    }
    if (!exists) receipts.push(reference);
    const next = normalizeIndexRecord({
      schemaVersion: SONG_FAMILY_REVIEW_INDEX_SCHEMA_VERSION,
      kind: SONG_FAMILY_REVIEW_INDEX_KIND,
      lookup,
      receipts
    });
    if (!current || !canonicalEqual(current, next)) {
      await this._writeFullIndex(next);
    }
    return next;
  }

  async _ensureIndexesForReceipt(snapshotHash, receiptHash, receipt) {
    const reference = { snapshotHash, receiptHash };
    for (const lookup of lookupsForReceipt(receipt)) {
      await this._writeIndexReference(lookup, reference);
    }
  }

  async _scanReceiptReferences(lookup) {
    const references = [];
    let scanned = 0;
    const root = path.join(this.rootPath, 'receipts');
    const prefixes = await fs.readdir(root, { withFileTypes: true });
    for (const prefix of prefixes) {
      if (!HASH_PREFIX_PATTERN.test(prefix.name)) continue;
      if (!prefix.isDirectory() || prefix.isSymbolicLink?.()) {
        fail('STORE_UNAVAILABLE', 'The song-family receipt store is unsafe.');
      }
      const prefixPath = path.join(root, prefix.name);
      await ensureOwnerOnlyDirectory(this.rootPath, prefixPath);
      const snapshotDirectories = await fs.readdir(prefixPath, {
        withFileTypes: true
      });
      for (const snapshotDirectory of snapshotDirectories) {
        if (
          !HASH_DIRECTORY_PATTERN.test(snapshotDirectory.name)
          || snapshotDirectory.name.slice(0, 2) !== prefix.name
        ) {
          continue;
        }
        if (!snapshotDirectory.isDirectory() || snapshotDirectory.isSymbolicLink?.()) {
          fail('STORE_UNAVAILABLE', 'The song-family receipt store is unsafe.');
        }
        const snapshotHash = snapshotDirectory.name;
        const directory = path.join(prefixPath, snapshotHash);
        await ensureOwnerOnlyDirectory(this.rootPath, directory);
        const entries = await fs.readdir(directory, { withFileTypes: true });
        let witness;
        try {
          witness = await this._readCommitWitness(snapshotHash, {
            missingIsNull: true
          });
        } catch (_error) {
          continue;
        }
        if (!witness) continue;
        let snapshot = null;
        let snapshotRead = false;
        for (const entry of entries) {
          const match = HASH_FILE_PATTERN.exec(entry.name);
          if (!match || match[1] !== witness.receiptHash) continue;
          scanned += 1;
          if (scanned > MAX_RECEIPTS) {
            fail('RECEIPT_CAPACITY_REACHED', 'The song-family receipt capacity was exceeded.');
          }
          if (!entry.isFile() || entry.isSymbolicLink?.()) continue;
          let receipt;
          try {
            receipt = await this._readReceipt(snapshotHash, match[1]);
            assertCommitWitnessMatchesReceipt(
              witness,
              snapshotHash,
              match[1],
              receipt
            );
          } catch (_error) {
            continue;
          }
          if (!lookupMatchesReceipt(lookup, receipt)) continue;
          if (!snapshotRead) {
            snapshotRead = true;
            try {
              snapshot = await this._readSnapshot(snapshotHash);
            } catch (_error) {
              snapshot = null;
            }
          }
          if (!snapshot) continue;
          try {
            assertReceiptMatchesSnapshot(receipt, snapshotHash, snapshot);
          } catch (_error) {
            continue;
          }
          references.push({ snapshotHash, receiptHash: match[1] });
          if (references.length > this.maximumIndexEntries) {
            fail(
              'REVIEW_INDEX_CAPACITY_REACHED',
              'That exact song-family review lookup has reached its limit.'
            );
          }
        }
      }
    }
    return references;
  }

  async _reconcileIndex(lookup, observed) {
    try {
      return await withExclusiveFileLock(
        path.join(this.rootPath, '.song-family-review-write-lock'),
        async () => {
          const current = await this._readIndex(lookup, { missingIsNull: true });
          const recovered = await this._scanReceiptReferences(lookup);
          const receipts = current ? [...current.receipts] : [];
          const seen = new Set(receipts.map(reference =>
            `${reference.snapshotHash}:${reference.receiptHash}`));
          for (const reference of recovered) {
            const key = `${reference.snapshotHash}:${reference.receiptHash}`;
            if (seen.has(key)) continue;
            if (receipts.length >= this.maximumIndexEntries) {
              fail(
                'REVIEW_INDEX_CAPACITY_REACHED',
                'That exact song-family review lookup has reached its limit.'
              );
            }
            seen.add(key);
            receipts.push(reference);
          }
          if (receipts.length < 1) return null;
          const reconciled = normalizeIndexRecord({
            schemaVersion: SONG_FAMILY_REVIEW_INDEX_SCHEMA_VERSION,
            kind: SONG_FAMILY_REVIEW_INDEX_KIND,
            lookup,
            receipts
          });
          if (current && canonicalEqual(current, reconciled)) return current;
          return this._writeFullIndex(reconciled);
        },
        { reclaimDeadOwner: true }
      );
    } catch (error) {
      if (error instanceof LocalSongFamilyReviewStoreError) throw error;
      if (error.code === 'WRITE_LOCKED' && observed) return observed;
      fail('STORE_UNAVAILABLE', 'The song-family review index could not be reconciled.');
    }
  }

  async saveSnapshot(rawSnapshot) {
    const snapshot = normalizeSnapshotRecord(rawSnapshot);
    const bytes = canonicalBuffer(snapshot);
    if (bytes.length > MAX_SNAPSHOT_BYTES) {
      fail('SNAPSHOT_TOO_LARGE', 'Song-family review snapshot exceeds its limit.');
    }
    const snapshotHash = sha256(bytes);
    await this.initialize();
    try {
      return await withExclusiveFileLock(
        path.join(this.rootPath, '.song-family-review-write-lock'),
        async () => {
          let existed = false;
          try {
            const existing = await this._readSnapshot(snapshotHash);
            if (!canonicalEqual(existing, snapshot)) {
              fail('SNAPSHOT_CORRUPT', 'Immutable song-family snapshot is inconsistent.');
            }
            existed = true;
          } catch (error) {
            if (
              !(error instanceof LocalSongFamilyReviewStoreError)
              || error.code !== 'SNAPSHOT_NOT_FOUND'
            ) {
              throw error;
            }
          }
          if (
            !existed
            && await this._countSnapshotFiles(this.maximumSnapshots) >= this.maximumSnapshots
          ) {
            fail(
              'SNAPSHOT_CAPACITY_REACHED',
              `The local song-family review store can contain at most ${this.maximumSnapshots} snapshots.`
            );
          }
          const snapshotPath = this._snapshotPath(snapshotHash);
          await ensureOwnerOnlyDirectory(this.rootPath, path.dirname(snapshotPath));
          await this._storeImmutable(
            snapshotPath,
            bytes,
            snapshotHash,
            MAX_SNAPSHOT_BYTES,
            'SNAPSHOT_CORRUPT',
            'song-family review snapshot'
          );
          await this._provisionReceiptStorage(snapshotHash);
          return deepFreeze({
            snapshotHash,
            snapshot,
            unchanged: existed
          });
        },
        { reclaimDeadOwner: true }
      );
    } catch (error) {
      if (error instanceof LocalSongFamilyReviewStoreError) throw error;
      if (error.code === 'WRITE_LOCKED') {
        fail('WRITE_LOCKED', 'The local song-family review store is already being updated.');
      }
      fail('STORE_UNAVAILABLE', 'Song-family review snapshot could not be saved.');
    }
  }

  async readSnapshot(snapshotHash) {
    await this.initialize();
    return this._readSnapshot(snapshotHash);
  }

  async prepareCommitReceiptStorage(rawRequest = {}) {
    exactKeys(
      rawRequest,
      ['snapshotHash'],
      'Receipt storage preparation request',
      'INVALID_SNAPSHOT_HASH'
    );
    const snapshotHash = digest(
      rawRequest.snapshotHash,
      'Receipt storage snapshotHash',
      'INVALID_SNAPSHOT_HASH'
    );
    await this.initialize();
    try {
      return await withExclusiveFileLock(
        path.join(this.rootPath, '.song-family-review-write-lock'),
        async () => {
          await this._readSnapshot(snapshotHash);
          const prepared = await this._provisionReceiptStorage(snapshotHash);
          await this._reserveCommitReceiptCapacity(snapshotHash);
          return prepared;
        },
        { reclaimDeadOwner: true }
      );
    } catch (error) {
      if (error instanceof LocalSongFamilyReviewStoreError) throw error;
      if (error.code === 'WRITE_LOCKED') {
        fail(
          'WRITE_LOCKED',
          'The local song-family review store is already being updated.'
        );
      }
      fail(
        'RECEIPT_STORAGE_UNAVAILABLE',
        'The durable receipt location for this reviewed family could not be prepared.'
      );
    }
  }

  async saveCommitReceipt(rawRequest) {
    exactKeys(rawRequest, [
      'snapshotHash',
      'committedAt',
      'familyRevision',
      'results'
    ], 'Song-family commit receipt request', 'INVALID_REVIEW_RECEIPT');
    const snapshotHash = digest(
      rawRequest.snapshotHash,
      'Commit receipt snapshotHash',
      'INVALID_REVIEW_RECEIPT'
    );
    await this.initialize();
    const snapshot = await this._readSnapshot(snapshotHash);
    const receipt = createReceipt(snapshotHash, snapshot, rawRequest);
    const bytes = canonicalBuffer(receipt);
    if (bytes.length > MAX_RECEIPT_BYTES) {
      fail('REVIEW_RECEIPT_TOO_LARGE', 'Song-family review receipt exceeds its limit.');
    }
    const receiptHash = sha256(bytes);
    try {
      return await withExclusiveFileLock(
        path.join(this.rootPath, '.song-family-review-write-lock'),
        async () => {
          await this._assertReceiptStorageProvisioned(snapshotHash);
          const entries = await this._receiptFileEntries(snapshotHash);
          if (entries.length > 1) {
            fail(
              'REVIEW_RECEIPT_CORRUPT',
              'A song-family snapshot has more than one immutable receipt.'
            );
          }
          const existingWitness = await this._readCommitWitness(snapshotHash, {
            missingIsNull: true
          });
          if (existingWitness && entries.length !== 1) {
            fail(
              'REVIEW_RECEIPT_CORRUPT',
              'A completed song-family review has lost its immutable receipt.'
            );
          }
          let existed = false;
          if (entries.length === 1) {
            const existingHash = HASH_FILE_PATTERN.exec(entries[0].name)[1];
            const existing = await this._readReceipt(snapshotHash, existingHash);
            assertReceiptMatchesSnapshot(existing, snapshotHash, snapshot);
            if (existingWitness) {
              assertCommitWitnessMatchesReceipt(
                existingWitness,
                snapshotHash,
                existingHash,
                existing
              );
            }
            if (existingHash !== receiptHash || !canonicalEqual(existing, receipt)) {
              fail(
                'REVIEW_RECEIPT_CONFLICT',
                'That exact song-family review already has a different commit receipt.'
              );
            }
            existed = true;
          }
          await this._reserveCommitReceiptCapacity(snapshotHash);
          const receiptPath = this._receiptPath(snapshotHash, receiptHash);
          await ensureOwnerOnlyDirectory(this.rootPath, path.dirname(receiptPath));
          await this._storeImmutable(
            receiptPath,
            bytes,
            receiptHash,
            MAX_RECEIPT_BYTES,
            'REVIEW_RECEIPT_CORRUPT',
            'song-family review receipt'
          );

          const expectedWitness = commitWitness(
            snapshotHash,
            receiptHash,
            receipt
          );
          const witnessBytes = canonicalBuffer(expectedWitness);
          await this._storeImmutable(
            this._commitWitnessPath(snapshotHash),
            witnessBytes,
            sha256(witnessBytes),
            MAX_COMMIT_WITNESS_BYTES,
            'REVIEW_RECEIPT_CORRUPT',
            'song-family commit witness'
          );

          // The immutable receipt plus commit witness are authoritative.
          // Every index below is a rebuildable cache and is deliberately
          // published afterward.
          await this._ensureIndexesForReceipt(snapshotHash, receiptHash, receipt);
          return deepFreeze({
            receiptHash,
            receipt,
            unchanged: existed
          });
        },
        { reclaimDeadOwner: true }
      );
    } catch (error) {
      if (error instanceof LocalSongFamilyReviewStoreError) throw error;
      if (error.code === 'WRITE_LOCKED') {
        fail('WRITE_LOCKED', 'The local song-family review store is already being updated.');
      }
      fail('STORE_UNAVAILABLE', 'Song-family review receipt could not be saved.');
    }
  }

  async readReviewStatus(raw = {}) {
    exactKeys(raw, ['snapshotHash'], 'Song-family review status request', 'INVALID_REVIEW_LOOKUP');
    const snapshotHash = digest(
      raw.snapshotHash,
      'Song-family review status snapshotHash',
      'INVALID_REVIEW_LOOKUP'
    );
    await this.initialize();
    const snapshot = await this._readSnapshot(snapshotHash);
    const entries = await this._receiptFileEntries(snapshotHash);
    if (entries.length > 1) {
      fail(
        'REVIEW_RECEIPT_CORRUPT',
        'A song-family snapshot has more than one immutable receipt.'
      );
    }
    const receipts = [];
    let skippedCorruptReceipts = 0;
    let witness = null;
    try {
      witness = await this._readCommitWitness(snapshotHash, {
        missingIsNull: true
      });
    } catch (_error) {
      skippedCorruptReceipts += 1;
    }
    if (!witness && entries.length > 0 && skippedCorruptReceipts < 1) {
      skippedCorruptReceipts += 1;
    }
    for (const entry of witness ? entries : []) {
      try {
        if (!entry.isFile() || entry.isSymbolicLink?.()) {
          throw new Error('unsafe receipt');
        }
        const receiptHash = HASH_FILE_PATTERN.exec(entry.name)[1];
        if (receiptHash !== witness.receiptHash) {
          throw new Error('commit witness points to another receipt');
        }
        const receipt = await this._readReceipt(snapshotHash, receiptHash);
        assertReceiptMatchesSnapshot(receipt, snapshotHash, snapshot);
        assertCommitWitnessMatchesReceipt(
          witness,
          snapshotHash,
          receiptHash,
          receipt
        );
        receipts.push(deepFreeze({ receiptHash, ...receipt }));
      } catch (_error) {
        skippedCorruptReceipts += 1;
      }
    }
    if (witness && entries.length < 1) skippedCorruptReceipts += 1;
    return deepFreeze({
      snapshotHash,
      reviewed: receipts.length > 0,
      receipts,
      skippedCorruptReceipts
    });
  }

  async _findByLookup(
    rawLookup,
    {
      candidateFilter = null,
      rejectCorruptEvidence = false
    } = {}
  ) {
    await this.initialize();
    const lookup = normalizeLookup(rawLookup);
    const observed = await this._readIndex(lookup, { missingIsNull: true });
    const index = await this._reconcileIndex(lookup, observed);
    if (!index) return null;
    const candidates = [];
    let skippedCorruptReceipts = 0;
    for (const reference of index.receipts) {
      try {
        const snapshot = await this._readSnapshot(reference.snapshotHash);
        const receipt = await this._readReceipt(
          reference.snapshotHash,
          reference.receiptHash
        );
        const witness = await this._readCommitWitness(reference.snapshotHash);
        assertCommitWitnessMatchesReceipt(
          witness,
          reference.snapshotHash,
          reference.receiptHash,
          receipt
        );
        assertReceiptMatchesSnapshot(receipt, reference.snapshotHash, snapshot);
        if (!lookupMatchesReceipt(lookup, receipt)) {
          fail('REVIEW_INDEX_CORRUPT', 'Song-family review index points elsewhere.');
        }
        candidates.push({
          snapshotHash: reference.snapshotHash,
          snapshot,
          receiptHash: reference.receiptHash,
          receipt
        });
      } catch (error) {
        if (
          error instanceof LocalSongFamilyReviewStoreError
          && error.code === 'REVIEW_INDEX_CORRUPT'
        ) {
          throw error;
        }
        skippedCorruptReceipts += 1;
      }
    }
    if (rejectCorruptEvidence && skippedCorruptReceipts > 0) {
      fail(
        'REVIEW_EVIDENCE_CORRUPT',
        'Saved song-family review evidence could not be validated.'
      );
    }
    const matchingCandidates = candidateFilter === null
      ? candidates
      : candidates.filter(candidateFilter);
    if (matchingCandidates.length < 1) {
      if (skippedCorruptReceipts > 0) {
        fail(
          'REVIEW_EVIDENCE_CORRUPT',
          'Saved song-family review evidence could not be validated.'
        );
      }
      return null;
    }
    matchingCandidates.sort((left, right) =>
      compareCanonicalText(
        right.receipt.committedAt,
        left.receipt.committedAt
      )
      || compareCanonicalText(left.receiptHash, right.receiptHash));
    const selected = matchingCandidates[0];
    const reviewStatus = await this.readReviewStatus({
      snapshotHash: selected.snapshotHash
    });
    if (
      rejectCorruptEvidence
      && (
        reviewStatus.reviewed !== true
        || reviewStatus.skippedCorruptReceipts > 0
        || !reviewStatus.receipts.some(candidate =>
          candidate.receiptHash === selected.receiptHash)
      )
    ) {
      fail(
        'REVIEW_EVIDENCE_CORRUPT',
        'Saved song-family review evidence could not be validated.'
      );
    }
    return deepFreeze({
      snapshot: {
        snapshotHash: selected.snapshotHash,
        snapshot: selected.snapshot
      },
      receipt: {
        receiptHash: selected.receiptHash,
        ...selected.receipt
      },
      reviewStatus: {
        ...reviewStatus,
        skippedCorruptReceipts: Math.max(
          reviewStatus.skippedCorruptReceipts,
          skippedCorruptReceipts
        )
      }
    });
  }

  async findByMemberRevision(raw = {}) {
    exactKeys(
      raw,
      ['songId', 'revision'],
      'Exact reviewed song-member lookup',
      'INVALID_REVIEW_LOOKUP'
    );
    return this._findByLookup({
      kind: 'member',
      songId: raw.songId,
      revision: raw.revision
    });
  }

  async findByMemberRevisionForServiceSet(raw = {}) {
    exactKeys(
      raw,
      ['songId', 'revision', 'binding'],
      'Exact reviewed song-member ServiceSet lookup',
      'INVALID_REVIEW_LOOKUP'
    );
    const binding = normalizeServiceSetBinding(raw.binding);
    return this._findByLookup(
      {
        kind: 'member',
        songId: raw.songId,
        revision: raw.revision
      },
      {
        candidateFilter: candidate =>
          serviceSetMatchesBinding(candidate.receipt.serviceSet, binding),
        rejectCorruptEvidence: true
      }
    );
  }

  async findByFamilyRevision(raw = {}) {
    exactKeys(
      raw,
      ['rootSongId', 'familyRevision'],
      'Exact reviewed song-family lookup',
      'INVALID_REVIEW_LOOKUP'
    );
    return this._findByLookup({
      kind: 'family',
      rootSongId: raw.rootSongId,
      familyRevision: raw.familyRevision
    });
  }
}

module.exports = {
  LocalSongFamilyReviewStore,
  LocalSongFamilyReviewStoreError,
  MAX_FAMILY_MEMBERS,
  MAX_TOTAL_DOCUMENT_SOURCE_BYTES,
  MAX_RECEIPTS,
  MAX_RECEIPT_BYTES,
  MAX_SNAPSHOTS,
  MAX_SNAPSHOT_BYTES,
  SONG_FAMILY_REVIEW_INDEX_KIND,
  SONG_FAMILY_REVIEW_INDEX_SCHEMA_VERSION,
  SONG_FAMILY_REVIEW_RECEIPT_KIND,
  SONG_FAMILY_REVIEW_RECEIPT_SCHEMA_VERSION,
  SONG_FAMILY_REVIEW_CONFIRMATION_AUTHORITY_SCOPE,
  SONG_FAMILY_REVIEW_SCOPE,
  SONG_FAMILY_REVIEW_SNAPSHOT_KIND,
  SONG_FAMILY_REVIEW_SNAPSHOT_SCHEMA_VERSION
};
