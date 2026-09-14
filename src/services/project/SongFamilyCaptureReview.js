'use strict';

const crypto = require('crypto');

const {
  SONG_SCHEMA_VERSION,
  normalizeSongDocument,
  serializeSongDocument
} = require('./SongDocument');

const SONG_FAMILY_CAPTURE_SCHEMA_VERSION = 1;
const SONG_FAMILY_CAPTURE_KIND = 'syncshow-song-family-capture';
const SONG_FAMILY_CAPTURE_REVIEW_KIND = 'syncshow-song-family-capture-review';
const SONG_FAMILY_CAPTURE_REVIEW_RESULT_KIND =
  'syncshow-song-family-capture-review-result';

const MAX_DOCUMENTS = 2;
const MAX_OCCURRENCES = 200;
const MAX_LINES = 10_000;
const MAX_LINE_LENGTH = 1_000;
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const DECISION_ACTIONS = Object.freeze([
  'new',
  'repeat',
  'exclude',
  'needs-pairing'
]);

const CAPTURE_KEYS = Object.freeze([
  'schemaVersion',
  'kind',
  'source',
  'documents',
  'occurrences'
]);
const SOURCE_KEYS = Object.freeze(['label', 'sha256']);
const DOCUMENT_KEYS = Object.freeze(['key', 'id', 'title', 'language']);
const OCCURRENCE_KEYS = Object.freeze([
  'occurrenceId',
  'sourceLabel',
  'linesByDocument'
]);
const REVIEW_KEYS = Object.freeze([
  'schemaVersion',
  'kind',
  'captureFingerprint',
  'rootDocumentKey',
  'decisions'
]);
const DECISION_KEYS = Object.freeze([
  'occurrenceId',
  'action',
  'repeatOfOccurrenceId',
  'note'
]);

class SongFamilyCaptureReviewError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'SongFamilyCaptureReviewError';
    this.code = code;
    this.details = deepFreeze({ ...details });
  }
}

function fail(code, message, details = {}) {
  throw new SongFamilyCaptureReviewError(code, message, details);
}

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function sameStringList(left, right) {
  return left.length === right.length
    && left.every((value, index) => value === right[index]);
}

function requireExactKeys(value, keys, field, code = 'INVALID_CAPTURE') {
  if (!isRecord(value)) {
    fail(code, `${field} must be an object.`, { field });
  }
  const expected = [...keys].sort();
  const actual = Object.keys(value).sort();
  if (!sameStringList(actual, expected)) {
    fail(code, `${field} must contain exactly the supported fields.`, {
      field,
      expected,
      actual
    });
  }
}

function requireTrimmedText(
  value,
  field,
  maximum,
  { allowEmpty = false, code = 'INVALID_CAPTURE' } = {}
) {
  if (typeof value !== 'string') {
    fail(code, `${field} must be text.`, { field });
  }
  if (value !== value.trim() || (!allowEmpty && !value)) {
    fail(
      code,
      `${field} must be ${allowEmpty ? '' : 'non-empty '}text without leading or trailing whitespace.`,
      { field }
    );
  }
  if (value.length > maximum || /[\0\r\n]/u.test(value)) {
    fail(code, `${field} must be one line of ${maximum} characters or fewer.`, {
      field,
      maximum
    });
  }
  return value;
}

function requireId(value, field, code = 'INVALID_CAPTURE') {
  const id = requireTrimmedText(value, field, 128, { code });
  if (!ID_PATTERN.test(id)) {
    fail(
      code,
      `${field} must start with a letter or number and use only letters, numbers, dot, underscore, colon, or hyphen.`,
      { field, value: id }
    );
  }
  return id;
}

function normalizeCanonicalLines(value, field) {
  if (!Array.isArray(value)) {
    fail('INVALID_CAPTURE', `${field} must be an array of lyric lines.`, { field });
  }
  const result = [];
  let previousBlank = false;
  for (const [index, rawLine] of value.entries()) {
    if (typeof rawLine !== 'string' || /[\0\r\n]/u.test(rawLine)) {
      fail('INVALID_CAPTURE', `${field}[${index}] must be one lyric line.`, {
        field,
        index
      });
    }
    if (rawLine.length > MAX_LINE_LENGTH) {
      fail(
        'INVALID_CAPTURE',
        `${field}[${index}] must be ${MAX_LINE_LENGTH} characters or fewer.`,
        { field, index, maximum: MAX_LINE_LENGTH }
      );
    }
    const line = rawLine.replace(/[ \t]+$/gu, '');
    const blank = line.length === 0;
    if (blank && previousBlank) continue;
    result.push(line);
    previousBlank = blank;
  }
  while (result[0] === '') result.shift();
  while (result.at(-1) === '') result.pop();
  return result;
}

function hasLyrics(lines) {
  return Array.isArray(lines) && lines.some(Boolean);
}

function normalizeCapture(rawCapture) {
  requireExactKeys(rawCapture, CAPTURE_KEYS, 'capture');
  if (rawCapture.schemaVersion !== SONG_FAMILY_CAPTURE_SCHEMA_VERSION) {
    fail(
      'UNSUPPORTED_CAPTURE_SCHEMA',
      `Song family capture schema version ${rawCapture.schemaVersion} is not supported.`,
      {
        supported: SONG_FAMILY_CAPTURE_SCHEMA_VERSION,
        actual: rawCapture.schemaVersion
      }
    );
  }
  if (rawCapture.kind !== SONG_FAMILY_CAPTURE_KIND) {
    fail('INVALID_CAPTURE_KIND', `Capture kind must be ${SONG_FAMILY_CAPTURE_KIND}.`, {
      actual: rawCapture.kind
    });
  }

  requireExactKeys(rawCapture.source, SOURCE_KEYS, 'capture.source');
  const source = {
    label: requireTrimmedText(rawCapture.source.label, 'capture.source.label', 500),
    sha256: requireTrimmedText(
      rawCapture.source.sha256,
      'capture.source.sha256',
      64,
      { allowEmpty: true }
    )
  };
  if (source.sha256 && !SHA256_PATTERN.test(source.sha256)) {
    fail(
      'INVALID_CAPTURE',
      'capture.source.sha256 must be an empty string or a lowercase SHA-256 digest.',
      { field: 'capture.source.sha256' }
    );
  }

  if (
    !Array.isArray(rawCapture.documents)
    || rawCapture.documents.length < 1
    || rawCapture.documents.length > MAX_DOCUMENTS
  ) {
    fail(
      'INVALID_CAPTURE',
      `capture.documents must contain one standalone document or one root/translation pair.`,
      { maximum: MAX_DOCUMENTS }
    );
  }
  const documentKeySet = new Set();
  const documentIdSet = new Set();
  const documentLanguageSet = new Set();
  const documents = rawCapture.documents.map((rawDocument, index) => {
    const field = `capture.documents[${index}]`;
    requireExactKeys(rawDocument, DOCUMENT_KEYS, field);
    const document = {
      key: requireId(rawDocument.key, `${field}.key`),
      id: requireId(rawDocument.id, `${field}.id`),
      title: requireTrimmedText(rawDocument.title, `${field}.title`, 200),
      language: requireTrimmedText(rawDocument.language, `${field}.language`, 35)
    };
    if (documentKeySet.has(document.key)) {
      fail('DUPLICATE_DOCUMENT_KEY', `Document key “${document.key}” is repeated.`, {
        documentKey: document.key
      });
    }
    if (documentIdSet.has(document.id)) {
      fail('DUPLICATE_DOCUMENT_ID', `Song id “${document.id}” is repeated.`, {
        documentId: document.id
      });
    }
    if (documentLanguageSet.has(document.language)) {
      fail(
        'DUPLICATE_DOCUMENT_LANGUAGE',
        `Language “${document.language}” is repeated in this capture.`,
        { language: document.language }
      );
    }
    documentKeySet.add(document.key);
    documentIdSet.add(document.id);
    documentLanguageSet.add(document.language);
    return document;
  });

  if (
    !Array.isArray(rawCapture.occurrences)
    || rawCapture.occurrences.length < 1
    || rawCapture.occurrences.length > MAX_OCCURRENCES
  ) {
    fail(
      'INVALID_CAPTURE',
      `capture.occurrences must contain 1 to ${MAX_OCCURRENCES} ordered occurrences.`,
      { maximum: MAX_OCCURRENCES }
    );
  }
  const occurrenceIdSet = new Set();
  let lineCount = 0;
  const occurrences = rawCapture.occurrences.map((rawOccurrence, index) => {
    const field = `capture.occurrences[${index}]`;
    requireExactKeys(rawOccurrence, OCCURRENCE_KEYS, field);
    const occurrenceId = requireId(
      rawOccurrence.occurrenceId,
      `${field}.occurrenceId`
    );
    if (occurrenceIdSet.has(occurrenceId)) {
      fail(
        'DUPLICATE_OCCURRENCE_ID',
        `Occurrence id “${occurrenceId}” is repeated.`,
        { occurrenceId }
      );
    }
    occurrenceIdSet.add(occurrenceId);
    const sourceLabel = requireTrimmedText(
      rawOccurrence.sourceLabel,
      `${field}.sourceLabel`,
      500
    );
    if (!isRecord(rawOccurrence.linesByDocument)) {
      fail(
        'INVALID_CAPTURE',
        `${field}.linesByDocument must be an object keyed by document key.`,
        { field: `${field}.linesByDocument` }
      );
    }
    const unknownDocumentKeys = Object.keys(rawOccurrence.linesByDocument)
      .filter(key => !documentKeySet.has(key));
    if (unknownDocumentKeys.length > 0) {
      fail(
        'UNKNOWN_DOCUMENT_KEY',
        `${field}.linesByDocument contains an unknown document key.`,
        { occurrenceId, unknownDocumentKeys }
      );
    }
    const linesByDocument = {};
    for (const document of documents) {
      if (!Object.prototype.hasOwnProperty.call(
        rawOccurrence.linesByDocument,
        document.key
      )) {
        continue;
      }
      const lines = normalizeCanonicalLines(
        rawOccurrence.linesByDocument[document.key],
        `${field}.linesByDocument.${document.key}`
      );
      lineCount += lines.length;
      if (lineCount > MAX_LINES) {
        fail(
          'CAPTURE_TOO_LARGE',
          `A song family capture can contain at most ${MAX_LINES} lyric lines.`,
          { maximum: MAX_LINES }
        );
      }
      if (hasLyrics(lines)) linesByDocument[document.key] = lines;
    }
    if (Object.keys(linesByDocument).length < 1) {
      fail(
        'EMPTY_OCCURRENCE',
        `Occurrence “${occurrenceId}” has no captured lyric text.`,
        { occurrenceId }
      );
    }
    return {
      occurrenceId,
      sourceLabel,
      linesByDocument
    };
  });

  return deepFreeze({
    schemaVersion: SONG_FAMILY_CAPTURE_SCHEMA_VERSION,
    kind: SONG_FAMILY_CAPTURE_KIND,
    source,
    documents,
    occurrences
  });
}

function captureFingerprint(capture) {
  return crypto
    .createHash('sha256')
    .update(JSON.stringify(capture), 'utf8')
    .digest('hex');
}

function resolveRootDocumentKey(capture, value, code = 'INVALID_REVIEW') {
  if (capture.documents.length === 1) {
    if (value !== undefined && value !== capture.documents[0].key) {
      fail(
        code,
        `The standalone document root must be “${capture.documents[0].key}”.`,
        {
          expected: capture.documents[0].key,
          actual: value
        }
      );
    }
    return capture.documents[0].key;
  }
  if (value === undefined || value === null || value === '') {
    fail(
      'MISSING_ROOT_DOCUMENT',
      'Choose which captured document is the root before reviewing a bilingual family.'
    );
  }
  const rootDocumentKey = requireId(value, 'rootDocumentKey', code);
  if (!capture.documents.some(document => document.key === rootDocumentKey)) {
    fail(
      'UNKNOWN_ROOT_DOCUMENT',
      `Root document key “${rootDocumentKey}” is not in this capture.`,
      { rootDocumentKey }
    );
  }
  return rootDocumentKey;
}

function occurrenceHasEveryDocument(capture, occurrence) {
  return capture.documents.every(document =>
    hasLyrics(occurrence.linesByDocument[document.key]));
}

function createSongFamilyCaptureReview(rawCapture, options = {}) {
  const capture = normalizeCapture(rawCapture);
  requireExactKeys(options, ['rootDocumentKey'], 'options', 'INVALID_REVIEW');
  const rootDocumentKey = resolveRootDocumentKey(
    capture,
    options.rootDocumentKey
  );
  const decisions = capture.occurrences.map(occurrence => {
    const paired = occurrenceHasEveryDocument(capture, occurrence);
    return {
      occurrenceId: occurrence.occurrenceId,
      action: paired ? 'new' : 'needs-pairing',
      repeatOfOccurrenceId: null,
      note: paired
        ? 'Safe default: preserve this occurrence as a new provisional section.'
        : 'Capture is missing lyric text for one document and needs pairing.'
    };
  });
  return deepFreeze({
    schemaVersion: SONG_FAMILY_CAPTURE_SCHEMA_VERSION,
    kind: SONG_FAMILY_CAPTURE_REVIEW_KIND,
    captureFingerprint: captureFingerprint(capture),
    rootDocumentKey,
    decisions
  });
}

function normalizeDecision(rawDecision, occurrenceId, index) {
  const field = `review.decisions[${index}]`;
  requireExactKeys(rawDecision, DECISION_KEYS, field, 'INVALID_REVIEW');
  const normalizedOccurrenceId = requireId(
    rawDecision.occurrenceId,
    `${field}.occurrenceId`,
    'INVALID_REVIEW'
  );
  if (normalizedOccurrenceId !== occurrenceId) {
    fail(
      'DECISION_ORDER_MISMATCH',
      'Review decisions must match the capture occurrence order exactly.',
      { index, expected: occurrenceId, actual: normalizedOccurrenceId }
    );
  }
  if (!DECISION_ACTIONS.includes(rawDecision.action)) {
    fail(
      'INVALID_DECISION_ACTION',
      `${field}.action must be one of: ${DECISION_ACTIONS.join(', ')}.`,
      { index, action: rawDecision.action }
    );
  }
  const repeatOfOccurrenceId = rawDecision.repeatOfOccurrenceId === null
    ? null
    : requireId(
      rawDecision.repeatOfOccurrenceId,
      `${field}.repeatOfOccurrenceId`,
      'INVALID_REVIEW'
    );
  if (rawDecision.action === 'repeat' && repeatOfOccurrenceId === null) {
    fail(
      'MISSING_REPEAT_REFERENCE',
      `Repeat decision for “${occurrenceId}” must reference a prior occurrence.`,
      { occurrenceId }
    );
  }
  if (rawDecision.action !== 'repeat' && repeatOfOccurrenceId !== null) {
    fail(
      'UNEXPECTED_REPEAT_REFERENCE',
      `Only a repeat decision may reference another occurrence.`,
      { occurrenceId, action: rawDecision.action }
    );
  }
  return {
    occurrenceId: normalizedOccurrenceId,
    action: rawDecision.action,
    repeatOfOccurrenceId,
    note: requireTrimmedText(
      rawDecision.note,
      `${field}.note`,
      500,
      { allowEmpty: true, code: 'INVALID_REVIEW' }
    )
  };
}

function normalizeReview(rawReview, capture) {
  requireExactKeys(rawReview, REVIEW_KEYS, 'review', 'INVALID_REVIEW');
  if (rawReview.schemaVersion !== SONG_FAMILY_CAPTURE_SCHEMA_VERSION) {
    fail(
      'UNSUPPORTED_REVIEW_SCHEMA',
      `Song family capture review schema version ${rawReview.schemaVersion} is not supported.`,
      {
        supported: SONG_FAMILY_CAPTURE_SCHEMA_VERSION,
        actual: rawReview.schemaVersion
      }
    );
  }
  if (rawReview.kind !== SONG_FAMILY_CAPTURE_REVIEW_KIND) {
    fail('INVALID_REVIEW_KIND', `Review kind must be ${SONG_FAMILY_CAPTURE_REVIEW_KIND}.`, {
      actual: rawReview.kind
    });
  }
  const expectedFingerprint = captureFingerprint(capture);
  if (rawReview.captureFingerprint !== expectedFingerprint) {
    fail(
      'CAPTURE_FINGERPRINT_MISMATCH',
      'This review does not belong to the supplied capture.',
      {
        expected: expectedFingerprint,
        actual: rawReview.captureFingerprint
      }
    );
  }
  const rootDocumentKey = resolveRootDocumentKey(
    capture,
    rawReview.rootDocumentKey
  );
  if (
    !Array.isArray(rawReview.decisions)
    || rawReview.decisions.length !== capture.occurrences.length
  ) {
    fail(
      'DECISION_COVERAGE_MISMATCH',
      'Review decisions must cover every captured occurrence exactly once.',
      {
        expected: capture.occurrences.length,
        actual: Array.isArray(rawReview.decisions)
          ? rawReview.decisions.length
          : null
      }
    );
  }
  return deepFreeze({
    schemaVersion: SONG_FAMILY_CAPTURE_SCHEMA_VERSION,
    kind: SONG_FAMILY_CAPTURE_REVIEW_KIND,
    captureFingerprint: expectedFingerprint,
    rootDocumentKey,
    decisions: rawReview.decisions.map((decision, index) =>
      normalizeDecision(
        decision,
        capture.occurrences[index].occurrenceId,
        index
      ))
  });
}

function buildDecisionEvidence(occurrence, decision, sectionId, exactRepeat) {
  return {
    occurrenceId: occurrence.occurrenceId,
    sourceLabel: occurrence.sourceLabel,
    action: decision.action,
    repeatOfOccurrenceId: decision.repeatOfOccurrenceId,
    note: decision.note,
    sectionId,
    exactRepeat,
    linesByDocument: Object.fromEntries(
      Object.entries(occurrence.linesByDocument)
        .map(([documentKey, lines]) => [documentKey, [...lines]])
    )
  };
}

function buildSongDocument(capture, document, rootDocument, newOccurrences) {
  const song = normalizeSongDocument({
    schemaVersion: SONG_SCHEMA_VERSION,
    id: document.id,
    title: document.title,
    language: document.language,
    translationOf: document.key === rootDocument.key
      ? null
      : rootDocument.id,
    license: '',
    tags: [],
    authors: [],
    translators: [],
    composers: [],
    source: capture.source.label,
    attribution: '',
    extraMetadata: {},
    sections: newOccurrences.map(({ occurrence, sectionId, sectionNumber }) => ({
      id: sectionId,
      marker: `P${sectionNumber}`,
      label: `P${sectionNumber}`,
      slides: [{
        id: `${sectionId}-slide-1`,
        lines: occurrence.linesByDocument[document.key]
      }]
    }))
  });
  try {
    serializeSongDocument(song);
  } catch (error) {
    if (error?.code === 'SOURCE_TOO_LARGE') {
      fail(
        'CAPTURE_DOCUMENT_TOO_LARGE',
        `Reviewed document “${document.key}” is too large for a canonical SongDocument.`,
        { documentKey: document.key }
      );
    }
    throw error;
  }
  return song;
}

function applySongFamilyCaptureReview(rawCapture, rawReview) {
  const capture = normalizeCapture(rawCapture);
  const review = normalizeReview(rawReview, capture);
  const occurrenceById = new Map();
  const sectionByOccurrenceId = new Map();
  const decisionByOccurrenceId = new Map();
  const newOccurrences = [];
  const occurrenceArrangement = [];
  const decisionEvidence = [];

  for (const [index, occurrence] of capture.occurrences.entries()) {
    const decision = review.decisions[index];
    let sectionId = null;
    let exactRepeat = null;

    if (
      (decision.action === 'new' || decision.action === 'repeat')
      && !occurrenceHasEveryDocument(capture, occurrence)
    ) {
      fail(
        'OCCURRENCE_NEEDS_PAIRING',
        `Occurrence “${occurrence.occurrenceId}” is missing lyric text for one document.`,
        {
          occurrenceId: occurrence.occurrenceId,
          missingDocumentKeys: capture.documents
            .filter(document => !hasLyrics(occurrence.linesByDocument[document.key]))
            .map(document => document.key)
        }
      );
    }

    if (decision.action === 'new') {
      const sectionNumber = newOccurrences.length + 1;
      sectionId = `p${sectionNumber}`;
      newOccurrences.push({ occurrence, sectionId, sectionNumber });
      sectionByOccurrenceId.set(occurrence.occurrenceId, sectionId);
    } else if (decision.action === 'repeat') {
      const repeatedOccurrence = occurrenceById.get(
        decision.repeatOfOccurrenceId
      );
      const repeatedDecision = decisionByOccurrenceId.get(
        decision.repeatOfOccurrenceId
      );
      if (!repeatedOccurrence) {
        fail(
          'REPEAT_REFERENCE_NOT_PRIOR',
          `Repeat “${occurrence.occurrenceId}” must reference a prior occurrence.`,
          {
            occurrenceId: occurrence.occurrenceId,
            repeatOfOccurrenceId: decision.repeatOfOccurrenceId
          }
        );
      }
      if (!['new', 'repeat'].includes(repeatedDecision.action)) {
        fail(
          'REPEAT_REFERENCE_NOT_INCLUDED',
          `Repeat “${occurrence.occurrenceId}” cannot reference an excluded or unresolved occurrence.`,
          {
            occurrenceId: occurrence.occurrenceId,
            repeatOfOccurrenceId: decision.repeatOfOccurrenceId,
            referencedAction: repeatedDecision.action
          }
        );
      }
      const mismatchedDocumentKeys = capture.documents
        .filter(document => !sameStringList(
          occurrence.linesByDocument[document.key],
          repeatedOccurrence.linesByDocument[document.key]
        ))
        .map(document => document.key);
      if (mismatchedDocumentKeys.length > 0) {
        fail(
          'REPEAT_TEXT_MISMATCH',
          `Repeat “${occurrence.occurrenceId}” is not an exact all-language match for “${decision.repeatOfOccurrenceId}”.`,
          {
            occurrenceId: occurrence.occurrenceId,
            repeatOfOccurrenceId: decision.repeatOfOccurrenceId,
            mismatchedDocumentKeys
          }
        );
      }
      sectionId = sectionByOccurrenceId.get(decision.repeatOfOccurrenceId);
      sectionByOccurrenceId.set(occurrence.occurrenceId, sectionId);
      exactRepeat = true;
    }

    if (sectionId) {
      occurrenceArrangement.push({
        id: occurrence.occurrenceId,
        sectionId
      });
    }
    decisionEvidence.push(
      buildDecisionEvidence(occurrence, decision, sectionId, exactRepeat)
    );
    occurrenceById.set(occurrence.occurrenceId, occurrence);
    decisionByOccurrenceId.set(occurrence.occurrenceId, decision);
  }

  const unresolvedEvidence = decisionEvidence
    .filter(evidence => evidence.action === 'needs-pairing');
  const excludedEvidence = decisionEvidence
    .filter(evidence => evidence.action === 'exclude');
  let status = 'ready';
  if (unresolvedEvidence.length > 0) status = 'needs-review';
  else if (newOccurrences.length === 0) status = 'excluded';

  const rootDocument = capture.documents.find(
    document => document.key === review.rootDocumentKey
  );
  const documents = status === 'ready'
    ? capture.documents.map(document =>
      buildSongDocument(capture, document, rootDocument, newOccurrences))
    : [];

  return deepFreeze({
    schemaVersion: SONG_FAMILY_CAPTURE_SCHEMA_VERSION,
    kind: SONG_FAMILY_CAPTURE_REVIEW_RESULT_KIND,
    captureFingerprint: review.captureFingerprint,
    captureSource: { ...capture.source },
    status,
    rootDocumentKey: review.rootDocumentKey,
    documentRoles: capture.documents.map(document => ({
      documentKey: document.key,
      role: document.key === review.rootDocumentKey ? 'root' : 'translation',
      translationOfDocumentKey: document.key === review.rootDocumentKey
        ? null
        : review.rootDocumentKey
    })),
    documents,
    occurrenceArrangement: status === 'ready'
      ? occurrenceArrangement
      : [],
    decisionEvidence,
    unresolvedEvidence,
    excludedEvidence,
    reviewBoundaries: {
      rightsReviewed: false,
      communityVisibilityReviewed: false
    }
  });
}

module.exports = {
  DECISION_ACTIONS,
  SONG_FAMILY_CAPTURE_KIND,
  SONG_FAMILY_CAPTURE_REVIEW_KIND,
  SONG_FAMILY_CAPTURE_REVIEW_RESULT_KIND,
  SONG_FAMILY_CAPTURE_SCHEMA_VERSION,
  SongFamilyCaptureReviewError,
  applySongFamilyCaptureReview,
  createSongFamilyCaptureReview
};
