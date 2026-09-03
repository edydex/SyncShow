'use strict';

const crypto = require('crypto');

const {
  normalizeSermonDocument,
  parseSermonDocument,
  serializeSermonDocument
} = require('./SermonDocument');
const {
  buildSermonPublicProjection
} = require('./SermonPublicProjection');

const TRANSITION_REQUEST_KEYS = [
  'documentSource',
  'publishedAt',
  'selectedBodyEntryIds',
  'selectedMediaIds'
];
const CANONICAL_TIMESTAMP_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

class SermonPublicationTransitionError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'SermonPublicationTransitionError';
    this.code = code;
    this.details = details;
  }
}

function fail(code, message, details = {}) {
  throw new SermonPublicationTransitionError(code, message, details);
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function isPlainRecord(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertExactTransitionRequest(value) {
  if (!isPlainRecord(value)) {
    fail(
      'INVALID_PUBLICATION_TRANSITION_REQUEST',
      'Sermon publication transition request must be a plain object.'
    );
  }
  const expected = new Set(TRANSITION_REQUEST_KEYS);
  for (const key of TRANSITION_REQUEST_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) {
      fail(
        'INVALID_PUBLICATION_TRANSITION_REQUEST',
        `Sermon publication transition request is missing ${key}.`,
        { field: key }
      );
    }
  }
  for (const key of Object.keys(value)) {
    if (!expected.has(key)) {
      fail(
        'INVALID_PUBLICATION_TRANSITION_REQUEST',
        'Sermon publication transition request contains an unsupported field.',
        { field: key }
      );
    }
  }
}

function sha256(source) {
  return crypto.createHash('sha256').update(source, 'utf8').digest('hex');
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

function inspectCanonicalReadySource(source) {
  if (typeof source !== 'string') {
    fail(
      'INVALID_PUBLICATION_DOCUMENT_SOURCE',
      'Publication input must be canonical sermon JSON text.'
    );
  }
  let document;
  try {
    document = parseSermonDocument(source);
  } catch (error) {
    fail(
      'INVALID_PUBLICATION_DOCUMENT_SOURCE',
      'Publication input is not a valid sermon document.',
      { causeCode: error?.code || null }
    );
  }
  if (serializeSermonDocument(document) !== source) {
    fail(
      'NONCANONICAL_PUBLICATION_DOCUMENT_SOURCE',
      'Publication input must be the exact canonical sermon serialization.'
    );
  }
  if (document.publication.status !== 'ready') {
    fail(
      'SERMON_NOT_READY_FOR_PUBLICATION',
      'Only an exact Ready sermon revision can be published.',
      { actualStatus: document.publication.status }
    );
  }
  return document;
}

function normalizeCanonicalPublishedAt(value) {
  if (
    typeof value !== 'string'
    || !CANONICAL_TIMESTAMP_PATTERN.test(value)
    || !Number.isFinite(Date.parse(value))
  ) {
    fail(
      'INVALID_PUBLICATION_TIMESTAMP',
      'Publication time must be an exact canonical UTC timestamp with milliseconds.'
    );
  }
  let canonical;
  try {
    canonical = new Date(value).toISOString();
  } catch (_error) {
    canonical = null;
  }
  if (canonical !== value) {
    fail(
      'INVALID_PUBLICATION_TIMESTAMP',
      'Publication time must be a real canonical UTC timestamp with milliseconds.'
    );
  }
  return value;
}

function assertOnlyPublicationChanged(baseDocument, document, publishedAt) {
  const { publication: basePublication, ...baseContent } = baseDocument;
  const { publication, ...content } = document;
  const expectedPublication = {
    ...basePublication,
    status: 'published',
    visibility: 'public',
    publishedAt
  };
  if (
    canonicalJson(content) !== canonicalJson(baseContent)
    || canonicalJson(publication) !== canonicalJson(expectedPublication)
  ) {
    fail(
      'PUBLICATION_TRANSITION_MUTATION',
      'Publication transition attempted to change sermon content outside publication state.'
    );
  }
}

function orderSelectionByDocument(document, bodyIds, mediaIds) {
  // The public projector validates and canonically normalizes selection IDs.
  // Mirror that normalization only after it succeeds so the returned audit
  // list names the exact document IDs even if transport text had edge
  // whitespace or decomposed Unicode.
  const normalizeSelectedId = value => value.trim().normalize('NFC');
  const selectedBodyIds = new Set(bodyIds.map(normalizeSelectedId));
  const selectedMediaIds = new Set(mediaIds.map(normalizeSelectedId));
  return {
    selectedBodyEntryIds: (document.body || [])
      .filter(entry => selectedBodyIds.has(entry.id))
      .map(entry => entry.id),
    selectedMediaIds: document.media
      .filter(entry => selectedMediaIds.has(entry.id))
      .map(entry => entry.id)
  };
}

/**
 * Pure compatibility transition for an authenticated server publication
 * transaction. The caller remains responsible for authoring `publishedAt`,
 * storing the exact returned bytes, and atomically moving its public pointer.
 */
function buildSermonPublicationTransition(options = {}) {
  assertExactTransitionRequest(options);
  const baseDocument = inspectCanonicalReadySource(options.documentSource);
  const publishedAt = normalizeCanonicalPublishedAt(options.publishedAt);
  const baseRevision = sha256(options.documentSource);

  const document = normalizeSermonDocument({
    ...baseDocument,
    publication: {
      ...baseDocument.publication,
      status: 'published',
      visibility: 'public',
      publishedAt
    }
  });
  assertOnlyPublicationChanged(baseDocument, document, publishedAt);

  const documentSource = serializeSermonDocument(document);
  const publicRevision = sha256(documentSource);
  const projection = buildSermonPublicProjection({
    documentSource,
    publicRevision,
    selectedBodyEntryIds: options.selectedBodyEntryIds,
    selectedMediaIds: options.selectedMediaIds
  });
  const orderedSelection = orderSelectionByDocument(
    document,
    options.selectedBodyEntryIds,
    options.selectedMediaIds
  );

  return deepFreeze({
    baseRevision,
    document,
    documentSource,
    publicRevision,
    projection,
    selectedBodyEntryIds: orderedSelection.selectedBodyEntryIds,
    selectedMediaIds: orderedSelection.selectedMediaIds
  });
}

module.exports = {
  SermonPublicationTransitionError,
  buildSermonPublicationTransition
};
