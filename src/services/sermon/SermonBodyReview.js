'use strict';

const {
  SERMON_SCHEMA_VERSION,
  normalizeSermonDocument,
  sermonDocumentSha256,
  upgradeSermonDocument
} = require('./SermonDocument');
const {
  normalizeSermonSourceExtractionProposal
} = require('./SermonSourceExtractionProposal');

const SERMON_BODY_REVIEW_PROPOSAL_SCHEMA_VERSION = 1;
const SERMON_BODY_REVIEW_PROPOSAL_KIND = 'syncshow-sermon-body-review-proposal';

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const SOURCE_KINDS = new Set(['manuscript', 'slide-notes', 'transcript', 'other']);

class SermonBodyReviewError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'SermonBodyReviewError';
    this.code = code;
    this.details = Object.freeze({ ...details });
  }
}

function fail(code, message, details = {}) {
  throw new SermonBodyReviewError(code, message, details);
}

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function exactKeys(value, expectedKeys, field, code = 'INVALID_BODY_REVIEW_PROPOSAL') {
  if (!isRecord(value)) fail(code, `${field} must be an object.`, { field });
  const actual = Object.keys(value);
  const expected = new Set(expectedKeys);
  if (actual.length !== expected.size || actual.some(key => !expected.has(key))) {
    fail(code, `${field} has unsupported or missing fields.`, { field });
  }
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

function identifier(value, field, code = 'INVALID_BODY_REVIEW_PROPOSAL') {
  if (typeof value !== 'string' || !ID_PATTERN.test(value)) {
    fail(code, `${field} must be a canonical identifier.`, { field });
  }
  return value;
}

function revision(value, field, code = 'INVALID_BODY_REVIEW_PROPOSAL') {
  if (typeof value !== 'string' || !SHA256_PATTERN.test(value)) {
    fail(code, `${field} must be a lowercase SHA-256 digest.`, { field });
  }
  return value;
}

function sourceKind(value, field, code = 'INVALID_BODY_REVIEW_PROPOSAL') {
  if (!SOURCE_KINDS.has(value)) {
    fail(code, `${field} has an unsupported source kind.`, { field });
  }
  return value;
}

function canonicalSermon(raw, code = 'INVALID_SERMON') {
  try {
    return normalizeSermonDocument(raw);
  } catch (error) {
    fail(code, 'A canonical sermon is required for body review.', {
      causeCode: error?.code || null
    });
  }
}

function v3Base(document) {
  return document.schemaVersion === SERMON_SCHEMA_VERSION
    ? document
    : upgradeSermonDocument(document);
}

function normalizeBodyEntries(document, rawEntries, code = 'INVALID_BODY_REVIEW_ENTRIES') {
  if (!Array.isArray(rawEntries) || rawEntries.length === 0) {
    fail(code, 'A reviewed sermon body must contain at least one ordered entry.');
  }
  try {
    return normalizeSermonDocument({
      ...v3Base(document),
      body: rawEntries
    }).body;
  } catch (error) {
    fail(error?.code || code, 'Reviewed sermon body entries are not canonical.', {
      causeCode: error?.code || null
    });
  }
}

function normalizedLanguages(source) {
  return source.languages || [source.language || 'und'];
}

function unusedBodyEntryId(sourceId, existingBody) {
  const usedIds = new Set(existingBody.map(entry => entry.id));
  if (!usedIds.has(sourceId)) return sourceId;
  for (let index = 1; index <= 256; index += 1) {
    const suffix = index === 1 ? ':body' : `:body-${index}`;
    const candidate = `${sourceId.slice(0, 128 - suffix.length)}${suffix}`;
    if (!usedIds.has(candidate)) return candidate;
  }
  fail(
    'BODY_ID_CAPACITY_REACHED',
    'No deterministic body-entry identity remains for this sermon source.',
    { sourceId }
  );
}

function validateSourceBinding(document, proposal) {
  if (proposal.sermonId !== document.id) {
    fail('SERMON_MISMATCH', 'The body review belongs to a different sermon.', {
      expectedSermonId: document.id,
      proposalSermonId: proposal.sermonId
    });
  }
  const source = document.sources.find(candidate => candidate.id === proposal.sourceId);
  if (!source || source.kind !== proposal.sourceKind) {
    fail('SOURCE_MISMATCH', 'The body review belongs to a different sermon source.', {
      sourceId: proposal.sourceId,
      proposalSourceKind: proposal.sourceKind,
      currentSourceKind: source?.kind || null
    });
  }
  if (source.sha256 !== proposal.sourceRevision) {
    fail('SOURCE_REVISION_MISMATCH', 'The sermon source changed after body extraction.', {
      sourceId: proposal.sourceId,
      proposalSourceRevision: proposal.sourceRevision,
      currentSourceRevision: source.sha256
    });
  }
  return source;
}

function validateEntrySourceKinds(document, entries) {
  const sourcesById = new Map(document.sources.map(source => [source.id, source]));
  for (const entry of entries) {
    if (entry.sourceId === null) continue;
    const source = sourcesById.get(entry.sourceId);
    if (!source || entry.kind !== source.kind) {
      fail(
        'BODY_SOURCE_KIND_MISMATCH',
        `Body entry “${entry.id}” kind must match its linked sermon source.`,
        {
          entryId: entry.id,
          sourceId: entry.sourceId,
          entryKind: entry.kind,
          sourceKind: source?.kind || null
        }
      );
    }
  }
}

function normalizeSermonBodyReviewProposal(raw, currentSermon) {
  const document = canonicalSermon(currentSermon);
  exactKeys(raw, [
    'schemaVersion',
    'kind',
    'sermonId',
    'baseSermonRevisionId',
    'sourceId',
    'sourceRevision',
    'sourceKind',
    'snapshotHash',
    'entries'
  ], 'Sermon body review proposal');
  if (
    raw.schemaVersion !== SERMON_BODY_REVIEW_PROPOSAL_SCHEMA_VERSION
    || raw.kind !== SERMON_BODY_REVIEW_PROPOSAL_KIND
  ) {
    fail(
      'UNSUPPORTED_BODY_REVIEW_PROPOSAL',
      'The sermon body review proposal has an unsupported schema.'
    );
  }
  const proposal = {
    schemaVersion: SERMON_BODY_REVIEW_PROPOSAL_SCHEMA_VERSION,
    kind: SERMON_BODY_REVIEW_PROPOSAL_KIND,
    sermonId: identifier(raw.sermonId, 'Body review sermonId'),
    baseSermonRevisionId: revision(
      raw.baseSermonRevisionId,
      'Body review baseSermonRevisionId'
    ),
    sourceId: identifier(raw.sourceId, 'Body review sourceId'),
    sourceRevision: revision(raw.sourceRevision, 'Body review sourceRevision'),
    sourceKind: sourceKind(raw.sourceKind, 'Body review sourceKind'),
    snapshotHash: revision(raw.snapshotHash, 'Body review snapshotHash'),
    entries: normalizeBodyEntries(document, raw.entries)
  };
  validateSourceBinding(document, proposal);
  validateEntrySourceKinds(document, proposal.entries);
  return deepFreeze(proposal);
}

/**
 * Builds a transient, exact-bound proposal from complete extraction units.
 * Preview text is deliberately ignored because it may be independently
 * truncated without making the complete unit text unsafe to review.
 */
function buildSermonBodyReviewProposal(options = {}) {
  const document = canonicalSermon(options.sermon);
  if (document.publication.status === 'archived') {
    fail('ARCHIVED_SERMON', 'Archived sermons cannot accept a reviewed body.');
  }
  const baseSermonRevisionId = revision(
    options.baseSermonRevisionId,
    'Body review baseSermonRevisionId',
    'INVALID_BODY_REVIEW_BINDING'
  );
  const currentRevision = sermonDocumentSha256(document);
  if (baseSermonRevisionId !== currentRevision) {
    fail('SERMON_REVISION_MISMATCH', 'The sermon changed before body review began.', {
      baseSermonRevisionId,
      currentRevision
    });
  }
  const requestedSourceId = identifier(
    options.sourceId,
    'Body review sourceId',
    'INVALID_BODY_REVIEW_BINDING'
  );
  const snapshotHash = revision(
    options.snapshotHash,
    'Body review snapshotHash',
    'INVALID_BODY_REVIEW_BINDING'
  );
  let extraction;
  try {
    extraction = normalizeSermonSourceExtractionProposal(options.extraction);
  } catch (error) {
    fail(
      error?.code || 'INVALID_EXTRACTION_PROPOSAL',
      'The source extraction is not safe for body review.',
      { causeCode: error?.code || null }
    );
  }
  const source = document.sources.find(candidate => candidate.id === requestedSourceId);
  if (
    !source
    || extraction.source.id !== source.id
    || extraction.source.sha256 !== source.sha256
    || extraction.source.kind !== source.kind
    || extraction.source.mediaType !== source.mediaType
    || canonicalJson(extraction.source.languages) !== canonicalJson(normalizedLanguages(source))
  ) {
    fail('SOURCE_MISMATCH', 'The extraction is not exact-bound to the selected sermon source.', {
      sourceId: requestedSourceId
    });
  }
  if (!['manuscript', 'transcript'].includes(source.kind)) {
    fail(
      'UNSUPPORTED_BODY_SOURCE_KIND',
      'Only a manuscript or transcript can automatically seed reviewed sermon body text.',
      { sourceId: source.id, sourceKind: source.kind }
    );
  }
  if (extraction.suggestionScope.strategy !== 'whole-source') {
    fail(
      'PARTIAL_EXTRACTION_SCOPE',
      'A scoped extraction cannot automatically seed the complete sermon body.',
      { strategy: extraction.suggestionScope.strategy }
    );
  }
  if (
    extraction.truncated.units
    || extraction.truncated.text
    || extraction.units.some(unit => unit.truncated)
  ) {
    fail(
      'INCOMPLETE_EXTRACTION',
      'A truncated source extraction cannot become reviewed sermon body text.'
    );
  }

  const fullText = extraction.units.map(unit => unit.text).join('\n\n');
  if (!fullText.trim()) {
    fail('EMPTY_EXTRACTION', 'The source extraction has no body text to review.');
  }
  const language = extraction.source.languages.length === 1
    ? extraction.source.languages[0]
    : 'mul';
  const existingBody = document.schemaVersion === SERMON_SCHEMA_VERSION
    ? document.body
    : [];
  const matchingIndexes = existingBody
    .map((entry, index) => entry.sourceId === source.id ? index : -1)
    .filter(index => index >= 0);
  if (matchingIndexes.length > 1) {
    fail(
      'AMBIGUOUS_EXISTING_BODY_SOURCE',
      'The reviewed source already has multiple body entries and requires explicit operator edits.',
      { sourceId: source.id, entryCount: matchingIndexes.length }
    );
  }
  const existingEntry = matchingIndexes.length === 1
    ? existingBody[matchingIndexes[0]]
    : null;
  const replacement = {
    id: existingEntry?.id || unusedBodyEntryId(source.id, existingBody),
    kind: source.kind,
    language,
    sourceId: source.id,
    sectionId: existingEntry?.sectionId || null,
    text: fullText
  };
  const entries = existingEntry
    ? existingBody.map(entry => entry.id === existingEntry.id ? replacement : entry)
    : [...existingBody, replacement];
  return normalizeSermonBodyReviewProposal({
    schemaVersion: SERMON_BODY_REVIEW_PROPOSAL_SCHEMA_VERSION,
    kind: SERMON_BODY_REVIEW_PROPOSAL_KIND,
    sermonId: document.id,
    baseSermonRevisionId,
    sourceId: source.id,
    sourceRevision: source.sha256,
    sourceKind: source.kind,
    snapshotHash,
    entries
  }, document);
}

function normalizeEdits(rawEdits, proposal, document) {
  if (rawEdits === undefined || rawEdits === null) return proposal.entries;
  exactKeys(
    rawEdits,
    ['entries'],
    'Sermon body review edits',
    'INVALID_BODY_REVIEW_EDITS'
  );
  const entries = normalizeBodyEntries(
    document,
    rawEdits.entries,
    'INVALID_BODY_REVIEW_EDITS'
  );
  validateEntrySourceKinds(document, entries);
  return entries;
}

function reviewResult(document, previousRevision, changed, proposal) {
  return deepFreeze({
    changed,
    document,
    previousRevision,
    revision: changed ? sermonDocumentSha256(document) : previousRevision,
    binding: {
      sermonId: proposal.sermonId,
      baseSermonRevisionId: proposal.baseSermonRevisionId,
      sourceId: proposal.sourceId,
      sourceRevision: proposal.sourceRevision,
      sourceKind: proposal.sourceKind,
      snapshotHash: proposal.snapshotHash
    },
    bodyEntryIds: document.body.map(entry => entry.id)
  });
}

/**
 * Applies explicit operator-reviewed body entries. The only stale-proposal
 * success is an exact no-op retry of an already applied body review.
 */
function applySermonBodyReview(currentSermon, rawProposal, rawEdits) {
  const document = canonicalSermon(currentSermon);
  if (document.publication.status === 'archived') {
    fail('ARCHIVED_SERMON', 'Archived sermons cannot accept a reviewed body.');
  }
  const proposal = normalizeSermonBodyReviewProposal(rawProposal, document);
  validateSourceBinding(document, proposal);
  const entries = normalizeEdits(rawEdits, proposal, document);
  const previousRevision = sermonDocumentSha256(document);
  const publication = ['ready', 'published'].includes(document.publication.status)
    ? {
        ...document.publication,
        status: 'draft',
        publishedAt: null
      }
    : document.publication;

  let reviewed;
  try {
    reviewed = normalizeSermonDocument({
      ...v3Base(document),
      body: entries,
      publication
    });
  } catch (error) {
    fail(error?.code || 'INVALID_BODY_REVIEW_EDITS', 'Body review cannot form a canonical sermon.', {
      causeCode: error?.code || null
    });
  }
  const reviewedRevision = sermonDocumentSha256(reviewed);
  const changed = reviewedRevision !== previousRevision;
  if (proposal.baseSermonRevisionId !== previousRevision) {
    if (!changed) return reviewResult(document, previousRevision, false, proposal);
    fail('SERMON_REVISION_MISMATCH', 'The sermon changed after body extraction.', {
      proposalSermonRevision: proposal.baseSermonRevisionId,
      currentSermonRevision: previousRevision
    });
  }
  if (!changed) return reviewResult(document, previousRevision, false, proposal);
  return reviewResult(reviewed, previousRevision, true, proposal);
}

module.exports = {
  SERMON_BODY_REVIEW_PROPOSAL_KIND,
  SERMON_BODY_REVIEW_PROPOSAL_SCHEMA_VERSION,
  SermonBodyReviewError,
  applySermonBodyReview,
  buildSermonBodyReviewProposal,
  normalizeSermonBodyReviewProposal
};
