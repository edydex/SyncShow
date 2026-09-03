'use strict';

const { normalizeBibleRange } = require('./BibleRange');
const {
  MAX_SERMON_REFERENCES,
  SERMON_SCHEMA_VERSION,
  normalizeSermonDocument,
  sermonDocumentSha256,
  upgradeSermonDocument
} = require('./SermonDocument');

const MAX_SERMON_REFERENCE_REVIEW_ENTRIES = MAX_SERMON_REFERENCES;
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const REFERENCE_ROLES = new Set(['primary', 'mentioned']);
const REVIEW_STATUSES = new Set(['suggested', 'confirmed']);
const DISALLOWED_TEXT_CONTROLS =
  /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u;

class SermonReferenceReviewError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'SermonReferenceReviewError';
    this.code = code;
    this.details = Object.freeze({ ...details });
  }
}

function fail(code, message, details = {}) {
  throw new SermonReferenceReviewError(code, message, details);
}

function isPlainRecord(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function requireExactRecord(value, expectedKeys, field, code = 'INVALID_REFERENCE_REVIEW') {
  if (!isPlainRecord(value)) {
    fail(code, `${field} must be a plain object.`, { field });
  }
  const keys = Reflect.ownKeys(value);
  const expected = [...expectedKeys].sort();
  if (
    keys.some(key => typeof key !== 'string')
    || keys.length !== expected.length
    || keys.slice().sort().some((key, index) => key !== expected[index])
  ) {
    fail(code, `${field} must contain exactly the supported fields.`, { field });
  }
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (
      !descriptor
      || !Object.prototype.hasOwnProperty.call(descriptor, 'value')
      || descriptor.enumerable !== true
    ) {
      fail(code, `${field}.${key} must be an enumerable own data property.`, {
        field,
        key
      });
    }
  }
  return value;
}

function requireDenseArray(value, field) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
    fail('INVALID_REFERENCE_REVIEW', `${field} must be a plain array.`, { field });
  }
  if (value.length > MAX_SERMON_REFERENCE_REVIEW_ENTRIES) {
    fail(
      'TOO_MANY_REFERENCES',
      `A sermon reference review may contain at most ${MAX_SERMON_REFERENCE_REVIEW_ENTRIES} entries.`,
      { maximum: MAX_SERMON_REFERENCE_REVIEW_ENTRIES }
    );
  }
  const keys = Reflect.ownKeys(value);
  const expectedKeys = [
    ...Array.from({ length: value.length }, (_unused, index) => String(index)),
    'length'
  ];
  if (
    keys.length !== expectedKeys.length
    || expectedKeys.some(key => !keys.includes(key))
  ) {
    fail(
      'INVALID_REFERENCE_REVIEW',
      `${field} must be dense and contain no extra properties.`,
      { field }
    );
  }
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (
      !descriptor
      || !Object.prototype.hasOwnProperty.call(descriptor, 'value')
      || descriptor.enumerable !== true
    ) {
      fail(
        'INVALID_REFERENCE_REVIEW',
        `${field}[${index}] must be an enumerable own data property.`,
        { field, index }
      );
    }
  }
  return value;
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

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function identifier(value, field) {
  if (typeof value !== 'string' || !ID_PATTERN.test(value)) {
    fail('INVALID_REFERENCE_ENTRY', `${field} must be a canonical identifier.`, {
      field
    });
  }
  return value;
}

function nullableIdentifier(value, field) {
  if (value === null) return null;
  return identifier(value, field);
}

function hasUnpairedSurrogate(value) {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
}

function canonicalEnteredText(value, field, { required = false } = {}) {
  if (typeof value !== 'string') {
    fail('INVALID_REFERENCE_ENTRY', `${field} must be text.`, { field });
  }
  const canonical = value.trim().normalize('NFC');
  if (
    value !== canonical
    || canonical.length > 300
    || (required && canonical.length === 0)
    || DISALLOWED_TEXT_CONTROLS.test(canonical)
    || hasUnpairedSurrogate(canonical)
  ) {
    fail(
      'INVALID_REFERENCE_ENTRY',
      `${field} must be canonical safe text${required ? ' and cannot be empty' : ''}.`,
      { field }
    );
  }
  return canonical;
}

function canonicalRange(value, field) {
  requireExactRecord(
    value,
    ['schemaVersion', 'bookId', 'start', 'end'],
    field,
    'INVALID_REFERENCE_ENTRY'
  );
  requireExactRecord(
    value.start,
    ['chapter', 'verse'],
    `${field}.start`,
    'INVALID_REFERENCE_ENTRY'
  );
  requireExactRecord(
    value.end,
    ['chapter', 'verse'],
    `${field}.end`,
    'INVALID_REFERENCE_ENTRY'
  );
  let normalized;
  try {
    normalized = normalizeBibleRange(value);
  } catch (error) {
    fail('INVALID_REFERENCE_RANGE', `${field} must be a valid BibleRangeV1.`, {
      field,
      causeCode: error?.code || null
    });
  }
  if (canonicalJson(value) !== canonicalJson(normalized)) {
    fail(
      'NONCANONICAL_REFERENCE_RANGE',
      `${field} must use the exact canonical BibleRangeV1 shape.`,
      { field }
    );
  }
  return normalized;
}

function canonicalCurrentSermon(raw) {
  try {
    return normalizeSermonDocument(raw);
  } catch (error) {
    fail('INVALID_SERMON', 'A canonical sermon is required for reference review.', {
      causeCode: error?.code || null
    });
  }
}

function normalizeEntry(raw, index, currentById, allCurrentIds) {
  const field = `Reference review entry ${index + 1}`;
  const entry = requireExactRecord(raw, [
    'referenceId',
    'existingReferenceId',
    'range',
    'replaced',
    'enteredText',
    'role',
    'reviewStatus',
    'sectionId'
  ], field, 'INVALID_REFERENCE_ENTRY');
  const referenceId = identifier(entry.referenceId, `${field}.referenceId`);
  const existingReferenceId = nullableIdentifier(
    entry.existingReferenceId,
    `${field}.existingReferenceId`
  );
  if (typeof entry.replaced !== 'boolean') {
    fail('INVALID_REFERENCE_ENTRY', `${field}.replaced must be a boolean.`, {
      field
    });
  }
  if (!REFERENCE_ROLES.has(entry.role)) {
    fail('INVALID_REFERENCE_ENTRY', `${field}.role is unsupported.`, {
      field,
      role: entry.role
    });
  }
  if (!REVIEW_STATUSES.has(entry.reviewStatus)) {
    fail('INVALID_REFERENCE_ENTRY', `${field}.reviewStatus is unsupported.`, {
      field,
      reviewStatus: entry.reviewStatus
    });
  }
  const sectionId = nullableIdentifier(entry.sectionId, `${field}.sectionId`);
  const range = canonicalRange(entry.range, `${field}.range`);

  if (existingReferenceId === null) {
    if (allCurrentIds.has(referenceId)) {
      fail(
        'REFERENCE_ID_COLLISION',
        `New reference id “${referenceId}” already belongs to this sermon.`,
        { referenceId }
      );
    }
    return {
      reference: {
        id: referenceId,
        range,
        role: entry.role,
        source: 'operator',
        reviewStatus: entry.reviewStatus,
        enteredText: canonicalEnteredText(
          entry.enteredText,
          `${field}.enteredText`,
          { required: true }
        ),
        sourceId: null,
        sectionId,
        startOffset: null,
        endOffset: null
      },
      existingReferenceId,
      replaced: true
    };
  }

  const existing = currentById.get(existingReferenceId);
  if (!existing) {
    fail(
      'UNKNOWN_REFERENCE',
      `Reference “${existingReferenceId}” is not part of this sermon revision.`,
      { existingReferenceId }
    );
  }
  if (referenceId !== existingReferenceId) {
    fail(
      'REFERENCE_ID_CHANGED',
      'An existing sermon reference must retain its stable id.',
      { referenceId, existingReferenceId }
    );
  }

  if (entry.replaced) {
    return {
      reference: {
        id: referenceId,
        range,
        role: entry.role,
        source: 'operator',
        reviewStatus: entry.reviewStatus,
        enteredText: canonicalEnteredText(
          entry.enteredText,
          `${field}.enteredText`,
          { required: true }
        ),
        sourceId: null,
        sectionId,
        startOffset: null,
        endOffset: null
      },
      existingReferenceId,
      replaced: true
    };
  }

  if (canonicalJson(range) !== canonicalJson(existing.range)) {
    fail(
      'RANGE_REPLACEMENT_REQUIRED',
      `Reference “${referenceId}” must be explicitly replaced before changing its canonical range.`,
      { referenceId }
    );
  }
  if (entry.enteredText !== existing.enteredText) {
    fail(
      'ENTERED_TEXT_REPLACEMENT_REQUIRED',
      `Reference “${referenceId}” must be explicitly replaced before changing entered text.`,
      { referenceId }
    );
  }
  return {
    reference: {
      ...existing,
      range: existing.range,
      role: entry.role,
      reviewStatus: entry.reviewStatus,
      enteredText: existing.enteredText,
      sectionId
    },
    existingReferenceId,
    replaced: false
  };
}

function emptyChanges() {
  return {
    addedReferenceIds: [],
    removedReferenceIds: [],
    updatedReferenceIds: [],
    replacedReferenceIds: [],
    orderChanged: false
  };
}

function changesBetween(document, normalizedEntries) {
  const currentById = new Map(document.references.map(reference => [reference.id, reference]));
  const nextById = new Map(
    normalizedEntries.map(entry => [entry.reference.id, entry.reference])
  );
  const addedReferenceIds = normalizedEntries
    .filter(entry => !currentById.has(entry.reference.id))
    .map(entry => entry.reference.id);
  const removedReferenceIds = document.references
    .filter(reference => !nextById.has(reference.id))
    .map(reference => reference.id);
  const updatedReferenceIds = normalizedEntries
    .filter(entry => {
      const current = currentById.get(entry.reference.id);
      return current && canonicalJson(current) !== canonicalJson(entry.reference);
    })
    .map(entry => entry.reference.id);
  const replacedReferenceIds = normalizedEntries
    .filter(entry =>
      entry.replaced
      && currentById.has(entry.reference.id)
      && updatedReferenceIds.includes(entry.reference.id))
    .map(entry => entry.reference.id);
  const retainedCurrentOrder = document.references
    .map(reference => reference.id)
    .filter(referenceId => nextById.has(referenceId));
  const retainedNextOrder = normalizedEntries
    .map(entry => entry.reference.id)
    .filter(referenceId => currentById.has(referenceId));
  const orderChanged = canonicalJson(retainedCurrentOrder)
    !== canonicalJson(retainedNextOrder);
  return {
    addedReferenceIds,
    removedReferenceIds,
    updatedReferenceIds,
    replacedReferenceIds,
    orderChanged
  };
}

function validateDesiredReferences(normalizedEntries) {
  const referenceIds = new Set();
  const existingReferenceIds = new Set();
  const roleRangeKeys = new Set();
  let hasConfirmedPrimary = false;

  for (const entry of normalizedEntries) {
    const reference = entry.reference;
    if (referenceIds.has(reference.id)) {
      fail('DUPLICATE_REFERENCE_ID', `Reference id “${reference.id}” is repeated.`, {
        referenceId: reference.id
      });
    }
    referenceIds.add(reference.id);
    if (entry.existingReferenceId !== null) {
      if (existingReferenceIds.has(entry.existingReferenceId)) {
        fail(
          'DUPLICATE_EXISTING_REFERENCE',
          `Existing reference “${entry.existingReferenceId}” is used more than once.`,
          { existingReferenceId: entry.existingReferenceId }
        );
      }
      existingReferenceIds.add(entry.existingReferenceId);
    }
    const roleRangeKey = `${reference.role}:${canonicalJson(reference.range)}`;
    if (roleRangeKeys.has(roleRangeKey)) {
      fail(
        'DUPLICATE_REFERENCE_RANGE',
        'The desired list repeats the same canonical range with the same role.',
        { referenceId: reference.id, role: reference.role }
      );
    }
    roleRangeKeys.add(roleRangeKey);
    if (
      reference.role === 'primary'
      && reference.reviewStatus === 'confirmed'
    ) {
      hasConfirmedPrimary = true;
    }
  }

  if (!hasConfirmedPrimary) {
    fail(
      'MISSING_CONFIRMED_PRIMARY_REFERENCE',
      'A reviewed sermon reference list must retain at least one confirmed primary passage.'
    );
  }
}

function reviewResult({
  changed,
  document,
  previousRevision,
  changes,
  publicationReset,
  upgradedFromSchemaVersion
}) {
  return deepFreeze({
    changed,
    document,
    previousRevision,
    revision: changed ? sermonDocumentSha256(document) : previousRevision,
    changes,
    publicationReset,
    upgradedFromSchemaVersion
  });
}

function applySermonReferenceReview(currentSermon, rawReview) {
  const document = canonicalCurrentSermon(currentSermon);
  if (document.publication.status === 'archived') {
    fail('ARCHIVED_SERMON', 'Archived sermons cannot accept reference edits.');
  }
  const review = requireExactRecord(
    rawReview,
    ['baseSermonRevisionId', 'entries'],
    'Sermon reference review'
  );
  if (
    typeof review.baseSermonRevisionId !== 'string'
    || !SHA256_PATTERN.test(review.baseSermonRevisionId)
  ) {
    fail(
      'INVALID_BASE_REVISION',
      'Sermon reference review baseSermonRevisionId must be a lowercase SHA-256 digest.'
    );
  }
  const previousRevision = sermonDocumentSha256(document);
  if (review.baseSermonRevisionId !== previousRevision) {
    fail(
      'SERMON_REVISION_MISMATCH',
      'The sermon changed after reference review began.',
      {
        baseSermonRevisionId: review.baseSermonRevisionId,
        currentSermonRevisionId: previousRevision
      }
    );
  }

  requireDenseArray(review.entries, 'Sermon reference review entries');
  const currentById = new Map(
    document.references.map(reference => [reference.id, reference])
  );
  const allCurrentIds = new Set(currentById.keys());
  const normalizedEntries = review.entries.map((entry, index) =>
    normalizeEntry(entry, index, currentById, allCurrentIds));
  validateDesiredReferences(normalizedEntries);
  const changes = changesBetween(document, normalizedEntries);
  const nextReferences = normalizedEntries.map(entry => entry.reference);
  const changed = canonicalJson(nextReferences) !== canonicalJson(document.references);

  if (!changed) {
    return reviewResult({
      changed: false,
      document,
      previousRevision,
      changes: emptyChanges(),
      publicationReset: false,
      upgradedFromSchemaVersion: null
    });
  }

  const upgradedFromSchemaVersion = document.schemaVersion === SERMON_SCHEMA_VERSION
    ? null
    : document.schemaVersion;
  const base = upgradedFromSchemaVersion === null
    ? document
    : upgradeSermonDocument(document);
  const publicationReset = ['ready', 'published'].includes(
    document.publication.status
  );
  const publication = publicationReset
    ? {
        ...base.publication,
        status: 'draft',
        publishedAt: null
      }
    : base.publication;
  let reviewed;
  try {
    reviewed = normalizeSermonDocument({
      ...base,
      references: nextReferences,
      publication
    });
  } catch (error) {
    fail(
      error?.code || 'INVALID_REFERENCE_EDIT',
      'The desired references cannot form a canonical sermon revision.',
      { causeCode: error?.code || null }
    );
  }
  return reviewResult({
    changed: true,
    document: reviewed,
    previousRevision,
    changes,
    publicationReset,
    upgradedFromSchemaVersion
  });
}

module.exports = {
  MAX_SERMON_REFERENCE_REVIEW_ENTRIES,
  SermonReferenceReviewError,
  applySermonReferenceReview
};
