'use strict';

const crypto = require('crypto');

const { normalizeBibleRange } = require('./BibleRange');
const {
  normalizeSermonDocument,
  sermonDocumentSha256
} = require('./SermonDocument');
const {
  SERMON_EXTRACTION_PROPOSAL_KIND,
  SERMON_EXTRACTION_PROPOSAL_SCHEMA_VERSION,
  normalizeSermonExtractionProposal
} = require('./SermonExtractionReview');
const {
  normalizeSermonSourceExtractionProposal
} = require('./SermonSourceExtractionProposal');

const SOURCE_EXTRACTION_PROPOSAL_KIND = 'syncshow-sermon-source-extraction-proposal';
const MAX_PUBLIC_EVIDENCE_LENGTH = 900;

class SermonExtractionProposalBuilderError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'SermonExtractionProposalBuilderError';
    this.code = code;
    this.details = details;
  }
}

function fail(code, message, details = {}) {
  throw new SermonExtractionProposalBuilderError(code, message, details);
}

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function stableId(prefix, ...parts) {
  const digest = crypto
    .createHash('sha256')
    .update(parts.map(part => String(part ?? '')).join('\u001f'))
    .digest('hex')
    .slice(0, 32);
  return `${prefix}-${digest}`;
}

function rangePosition(endpoint, edge) {
  const verse = endpoint.verse === null
    ? (edge === 'start' ? 0 : 1000)
    : endpoint.verse;
  return (endpoint.chapter * 1001) + verse;
}

function rangeContains(containerRaw, candidateRaw) {
  const container = normalizeBibleRange(containerRaw);
  const candidate = normalizeBibleRange(candidateRaw);
  return container.bookId === candidate.bookId
    && rangePosition(container.start, 'start') <= rangePosition(candidate.start, 'start')
    && rangePosition(container.end, 'end') >= rangePosition(candidate.end, 'end');
}

function rangeKey(raw) {
  const range = normalizeBibleRange(raw);
  return [
    range.bookId,
    range.start.chapter,
    range.start.verse ?? '',
    range.end.chapter,
    range.end.verse ?? ''
  ].join(':');
}

function unitLabelForExtraction(extraction) {
  const kinds = new Set(
    (Array.isArray(extraction.units) ? extraction.units : [])
      .map(unit => String(unit?.kind || '').trim())
      .filter(Boolean)
  );
  if (kinds.size !== 1) return 'source units';
  const [kind] = kinds;
  if (kind === 'page') return 'pages';
  if (kind === 'slide') return 'slides';
  if (kind === 'paragraph') return 'paragraphs';
  if (kind === 'document') return 'document sections';
  return `${kind} units`;
}

function evidenceText(rawText, sourceUnitIds, unitsById) {
  const labels = [...new Set((Array.isArray(sourceUnitIds) ? sourceUnitIds : [])
    .map(unitId => unitsById.get(unitId)?.label)
    .filter(Boolean))];
  const raw = String(rawText || '').trim().replace(/\s+/gu, ' ');
  const combined = [
    labels.length > 0 ? labels.join(', ') : '',
    raw
  ].filter(Boolean).join(': ');
  if (combined.length <= MAX_PUBLIC_EVIDENCE_LENGTH) return combined;
  return `${combined.slice(0, MAX_PUBLIC_EVIDENCE_LENGTH - 1).trimEnd()}…`;
}

function validateBinding(sermon, sermonRevision, source, extraction, proposalId) {
  if (
    typeof sermonRevision !== 'string'
    || !/^[a-f0-9]{64}$/.test(sermonRevision)
    || sermonDocumentSha256(sermon) !== sermonRevision
  ) {
    fail(
      'SERMON_REVISION_MISMATCH',
      'The extraction review must bind to the exact canonical sermon revision.'
    );
  }
  if (
    typeof proposalId !== 'string'
    || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(proposalId)
  ) {
    fail('INVALID_PROPOSAL_ID', 'The extraction review proposal id is invalid.');
  }
  const canonicalSource = sermon.sources.find(candidate => candidate.id === source?.id);
  if (
    !canonicalSource
    || canonicalSource.sha256 !== source?.sha256
    || canonicalSource.kind !== source?.kind
  ) {
    fail('SOURCE_MISMATCH', 'The extracted source is not part of this sermon revision.');
  }
  if (
    !isRecord(extraction)
    || extraction.kind !== SOURCE_EXTRACTION_PROPOSAL_KIND
    || extraction.source?.id !== canonicalSource.id
    || extraction.source?.sha256 !== canonicalSource.sha256
    || extraction.source?.kind !== canonicalSource.kind
  ) {
    fail('EXTRACTION_BINDING_MISMATCH', 'The extracted source proposal has the wrong identity.');
  }
  return canonicalSource;
}

function scopeDescription(extraction) {
  const scope = extraction.suggestionScope;
  if (!isRecord(scope)) return '';
  if (
    scope.strategy === 'pptx-roman-outline-window'
    && Number.isSafeInteger(scope.startOrdinal)
    && Number.isSafeInteger(scope.endOrdinal)
  ) {
    return `sermon window slides ${scope.startOrdinal}–${scope.endOrdinal}`;
  }
  if (scope.strategy === 'pptx-no-sermon-window') {
    return 'no safe sermon window detected';
  }
  return '';
}

function outlineCandidateStatus(existing, canonical) {
  if (!existing) return 'new';
  if (
    existing.parentId !== canonical.parentId
    || existing.kind !== canonical.kind
  ) {
    fail(
      'CANONICAL_ID_COLLISION',
      'An extracted outline id already belongs to different sermon content.',
      { canonicalId: canonical.id }
    );
  }

  let addsLocalizedTitle = false;
  for (const [language, title] of Object.entries(canonical.titles)) {
    if (!Object.prototype.hasOwnProperty.call(existing.titles, language)) {
      addsLocalizedTitle = true;
      continue;
    }
    if (existing.titles[language] !== title) {
      fail(
        'CANONICAL_ID_COLLISION',
        'An extracted outline id already has a different title in the same language.',
        { canonicalId: canonical.id, language }
      );
    }
  }
  return addsLocalizedTitle ? 'enrichment' : 'present';
}

/**
 * Adapt a deterministic, derivative source extraction into the canonical
 * review helper's proposal shape. Bible resolution remains an injected trusted
 * operation; unresolved or ambiguous candidates are simply not offered.
 */
async function buildSermonExtractionReviewProposal(options = {}) {
  let sermon;
  try {
    sermon = normalizeSermonDocument(options.sermon);
  } catch (error) {
    fail('INVALID_SERMON', 'A canonical sermon is required for extraction review.', {
      causeCode: error.code || null
    });
  }
  let extraction;
  try {
    extraction = normalizeSermonSourceExtractionProposal(options.extraction);
  } catch (error) {
    fail(
      error?.code || 'INVALID_EXTRACTION_PROPOSAL',
      'The source extraction proposal is not safe to review.',
      { causeCode: error?.code || null }
    );
  }
  const source = validateBinding(
    sermon,
    options.sermonRevision,
    options.source,
    extraction,
    options.proposalId
  );
  if (typeof options.resolveReference !== 'function') {
    fail('MISSING_REFERENCE_RESOLVER', 'A trusted Bible reference resolver is required.');
  }

  const units = Array.isArray(extraction.units) ? extraction.units : [];
  const unitsById = new Map(units.map(unit => [unit.id, unit]));
  const rawOutline = Array.isArray(extraction.outlineSuggestions)
    ? extraction.outlineSuggestions
    : [];
  const canonicalOutlineIdBySuggestionId = new Map(rawOutline.map(suggestion => [
    suggestion.id,
    stableId('sermon-outline', sermon.id, suggestion.id)
  ]));
  const normalizedOutlineSuggestions = normalizeSermonExtractionProposal({
    schemaVersion: SERMON_EXTRACTION_PROPOSAL_SCHEMA_VERSION,
    kind: SERMON_EXTRACTION_PROPOSAL_KIND,
    id: options.proposalId,
    sermonId: sermon.id,
    sermonRevision: options.sermonRevision,
    sourceId: source.id,
    sourceKind: source.kind,
    sourceRevision: source.sha256,
    outlineSuggestions: rawOutline.map(suggestion => ({
      id: `outline:${suggestion.id}`,
      canonical: {
        id: canonicalOutlineIdBySuggestionId.get(suggestion.id),
        parentId: suggestion.parentId
          ? (canonicalOutlineIdBySuggestionId.get(suggestion.parentId) || null)
          : null,
        kind: suggestion.suggestedKind,
        titles: suggestion.titles
      }
    })),
    referenceSuggestions: []
  }).outlineSuggestions;
  const existingOutlineById = new Map(sermon.outline.map(section => [section.id, section]));
  const outlineCandidates = rawOutline.map((suggestion, index) => {
    const envelopeId = `outline:${suggestion.id}`;
    const internal = normalizedOutlineSuggestions[index];
    const canonical = internal.canonical;
    const existing = existingOutlineById.get(canonical.id);
    const status = outlineCandidateStatus(existing, canonical);
    return {
      included: status !== 'present',
      raw: suggestion,
      internal,
      public: {
        id: envelopeId,
        kind: canonical.kind,
        parentSuggestionId: suggestion.parentId
          ? `outline:${suggestion.parentId}`
          : '',
        titles: canonical.titles,
        evidence: {
          text: evidenceText(
            suggestion.rawText,
            suggestion.sourceUnitIds,
            unitsById
          ),
          occurrenceCount: suggestion.occurrenceCount
        }
      }
    };
  });
  const includedOutlineIds = new Set(
    outlineCandidates.filter(candidate => candidate.included).map(candidate => candidate.raw.id)
  );
  for (const candidate of outlineCandidates) {
    if (
      candidate.public.parentSuggestionId
      && !includedOutlineIds.has(candidate.raw.parentId)
    ) {
      candidate.public.parentSuggestionId = '';
    }
  }

  const primaryRanges = sermon.references
    .filter(reference =>
      reference.role === 'primary' && reference.reviewStatus === 'confirmed')
    .map(reference => reference.range);
  const existingRangeKeys = new Set(sermon.references.map(reference => rangeKey(reference.range)));
  const offeredRangeKeys = new Set();
  const referenceCandidates = [];
  for (const suggestion of Array.isArray(extraction.scriptureReferenceSuggestions)
    ? extraction.scriptureReferenceSuggestions
    : []) {
    const resolved = await options.resolveReference(suggestion);
    if (!resolved) continue;
    let range;
    try {
      range = normalizeBibleRange(resolved.range || resolved);
    } catch (_error) {
      continue;
    }
    const key = rangeKey(range);
    if (
      existingRangeKeys.has(key)
      || offeredRangeKeys.has(key)
      || primaryRanges.some(primary => rangeContains(primary, range))
    ) {
      continue;
    }
    offeredRangeKeys.add(key);
    const envelopeId = `reference:${suggestion.id}`;
    const canonicalId = stableId(
      'sermon-reference',
      sermon.id,
      source.id,
      source.sha256,
      key
    );
    const enteredText = String(suggestion.rawText || '').trim().slice(0, 300);
    referenceCandidates.push({
      internal: {
        id: envelopeId,
        canonical: {
          id: canonicalId,
          range,
          enteredText,
          sectionId: null,
          // Extractor offsets are local to an ordered source unit. The current
          // canonical schema has no unit-id field, so persisting them would be
          // ambiguous; retain the unit label in transient evidence instead.
          startOffset: null,
          endOffset: null
        }
      },
      public: {
        id: envelopeId,
        enteredText,
        canonicalReference: range,
        evidence: {
          text: evidenceText(
            suggestion.rawText,
            suggestion.sourceUnitIds || [suggestion.unitId],
            unitsById
          ),
          occurrenceCount: suggestion.occurrenceCount
        }
      }
    });
  }

  const internalProposal = normalizeSermonExtractionProposal({
    schemaVersion: SERMON_EXTRACTION_PROPOSAL_SCHEMA_VERSION,
    kind: SERMON_EXTRACTION_PROPOSAL_KIND,
    id: options.proposalId,
    sermonId: sermon.id,
    sermonRevision: options.sermonRevision,
    sourceId: source.id,
    sourceKind: source.kind,
    sourceRevision: source.sha256,
    outlineSuggestions: outlineCandidates
      .filter(candidate => candidate.included)
      .map(candidate => candidate.internal),
    referenceSuggestions: referenceCandidates.map(candidate => candidate.internal)
  });

  const scope = scopeDescription(extraction);
  const extractorId = String(extraction.extractor?.id || 'deterministic source extractor');
  const extractorVersion = Number.isSafeInteger(extraction.extractor?.version)
    ? ` v${extraction.extractor.version}`
    : '';
  const publicProposal = {
    source: {
      id: source.id,
      fileName: source.fileName,
      kind: source.kind,
      languages: [...(source.languages || [source.language || 'und'])]
    },
    extraction: {
      unitLabel: unitLabelForExtraction(extraction),
      unitCount: units.length,
      textPreview: String(extraction.textPreview || ''),
      textTruncated: extraction.truncated?.text === true
        || extraction.truncated?.preview === true,
      extractor: [extractorId + extractorVersion, scope].filter(Boolean).join(' · ')
    },
    outlineSuggestions: outlineCandidates
      .filter(candidate => candidate.included)
      .map(candidate => candidate.public),
    referenceSuggestions: referenceCandidates.map(candidate => candidate.public)
  };

  return {
    internalProposal,
    publicProposal
  };
}

module.exports = {
  MAX_PUBLIC_EVIDENCE_LENGTH,
  SermonExtractionProposalBuilderError,
  buildSermonExtractionReviewProposal,
  rangeContains
};
