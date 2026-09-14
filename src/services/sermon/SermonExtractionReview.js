'use strict';

const { normalizeBibleRange } = require('./BibleRange');
const {
  MAX_SERMON_REFERENCES,
  SERMON_SCHEMA_VERSION,
  normalizeSermonDocument,
  sermonDocumentSha256,
  upgradeSermonDocument
} = require('./SermonDocument');

const SERMON_EXTRACTION_PROPOSAL_SCHEMA_VERSION = 1;
const SERMON_EXTRACTION_PROPOSAL_KIND = 'syncshow-sermon-extraction-proposal';
const MAX_EXTRACTION_OUTLINE_SUGGESTIONS = 500;
const MAX_EXTRACTION_REFERENCE_SUGGESTIONS = 500;
const MAX_SELECTED_OUTLINE_SUGGESTIONS = 500;
const MAX_SELECTED_REFERENCE_SUGGESTIONS = 500;

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const LANGUAGE_PATTERN = /^[a-z]{2,3}(?:-[a-z0-9]{2,8})*$/;
const OUTLINE_KINDS = new Set(['section', 'point', 'subpoint']);

// Sermon sources and reference provenance intentionally use different
// vocabularies. This is the only mapping the review boundary permits.
const REFERENCE_SOURCE_BY_SERMON_SOURCE_KIND = Object.freeze({
  manuscript: 'manuscript',
  'slide-notes': 'slide-notes',
  transcript: 'transcript-extraction',
  other: 'operator'
});

class SermonExtractionReviewError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'SermonExtractionReviewError';
    this.code = code;
    this.details = details;
  }
}

function fail(code, message, details = {}) {
  throw new SermonExtractionReviewError(code, message, details);
}

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
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

function normalizeId(value, field, code = 'INVALID_PROPOSAL') {
  if (typeof value !== 'string' || !ID_PATTERN.test(value)) {
    fail(code, `${field} must be a canonical identifier.`, { field });
  }
  return value;
}

function normalizeRevision(value, field) {
  if (typeof value !== 'string' || !SHA256_PATTERN.test(value)) {
    fail('INVALID_PROPOSAL_REVISION', `${field} must be a lowercase SHA-256 digest.`, {
      field
    });
  }
  return value;
}

function exactKeys(value, expectedKeys) {
  if (!isRecord(value)) return false;
  const actual = Object.keys(value).sort();
  const expected = [...expectedKeys].sort();
  return actual.length === expected.length
    && actual.every((key, index) => key === expected[index]);
}

function normalizeNullableId(value, field) {
  if (value === null) return null;
  return normalizeId(value, field, 'MALFORMED_SUGGESTION');
}

function normalizeOutlineTitles(value, field) {
  if (!isRecord(value) || Object.keys(value).length === 0) {
    fail('MALFORMED_SUGGESTION', `${field} must contain at least one localized title.`, {
      field
    });
  }
  const entries = [];
  const languages = new Set();
  for (const [rawLanguage, rawTitle] of Object.entries(value)) {
    const language = rawLanguage.trim().toLowerCase();
    if (!LANGUAGE_PATTERN.test(language)) {
      fail('MALFORMED_SUGGESTION', `${field} contains an invalid language tag.`, {
        field,
        language: rawLanguage
      });
    }
    if (languages.has(language)) {
      fail('MALFORMED_SUGGESTION', `${field} repeats a normalized language tag.`, {
        field,
        language
      });
    }
    if (typeof rawTitle !== 'string') {
      fail('MALFORMED_SUGGESTION', `${field}.${language} must be text.`, {
        field,
        language
      });
    }
    const title = rawTitle.trim().normalize('NFC');
    if (!title || title.length > 500) {
      fail(
        'MALFORMED_SUGGESTION',
        `${field}.${language} must contain 1 through 500 characters.`,
        { field, language }
      );
    }
    languages.add(language);
    entries.push([language, title]);
  }
  entries.sort(([left], [right]) => left.localeCompare(right));
  return Object.fromEntries(entries);
}

function normalizeOutlineSuggestion(raw, index) {
  if (!isRecord(raw)) {
    fail('MALFORMED_SUGGESTION', `Outline suggestion ${index + 1} must be an object.`);
  }
  const suggestionId = normalizeId(
    raw.id,
    `Outline suggestion ${index + 1} id`,
    'MALFORMED_SUGGESTION'
  );
  if (!exactKeys(raw.canonical, ['id', 'parentId', 'kind', 'titles'])) {
    fail(
      'MALFORMED_SUGGESTION',
      `Outline suggestion “${suggestionId}” must contain exactly the canonical outline fields.`,
      { suggestionId }
    );
  }
  const canonical = raw.canonical;
  if (!OUTLINE_KINDS.has(canonical.kind)) {
    fail(
      'MALFORMED_SUGGESTION',
      `Outline suggestion “${suggestionId}” has an unsupported outline kind.`,
      { suggestionId, kind: canonical.kind }
    );
  }
  return {
    id: suggestionId,
    canonical: {
      id: normalizeId(
        canonical.id,
        `Outline suggestion “${suggestionId}” canonical id`,
        'MALFORMED_SUGGESTION'
      ),
      parentId: normalizeNullableId(
        canonical.parentId,
        `Outline suggestion “${suggestionId}” parentId`
      ),
      kind: canonical.kind,
      titles: normalizeOutlineTitles(
        canonical.titles,
        `Outline suggestion “${suggestionId}” titles`
      )
    }
  };
}

function normalizeCanonicalBibleRange(value, suggestionId) {
  if (
    !exactKeys(value, ['schemaVersion', 'bookId', 'start', 'end'])
    || !exactKeys(value.start, ['chapter', 'verse'])
    || !exactKeys(value.end, ['chapter', 'verse'])
  ) {
    fail(
      'NON_CANONICAL_BIBLE_RANGE',
      `Reference suggestion “${suggestionId}” must carry canonical BibleRangeV1.`,
      { suggestionId }
    );
  }

  let normalized;
  try {
    normalized = normalizeBibleRange(value);
  } catch (error) {
    fail(
      'NON_CANONICAL_BIBLE_RANGE',
      `Reference suggestion “${suggestionId}” has an invalid BibleRangeV1.`,
      { suggestionId, causeCode: error.code || null }
    );
  }
  if (canonicalJson(value) !== canonicalJson(normalized)) {
    fail(
      'NON_CANONICAL_BIBLE_RANGE',
      `Reference suggestion “${suggestionId}” must be canonical before review.`,
      { suggestionId }
    );
  }
  return normalized;
}

function normalizeOffset(value, field) {
  if (value === null) return null;
  if (!Number.isSafeInteger(value) || value < 0) {
    fail('MALFORMED_SUGGESTION', `${field} must be null or a non-negative integer.`, {
      field
    });
  }
  return value;
}

function normalizeReferenceSuggestion(raw, index) {
  if (!isRecord(raw)) {
    fail('MALFORMED_SUGGESTION', `Reference suggestion ${index + 1} must be an object.`);
  }
  const suggestionId = normalizeId(
    raw.id,
    `Reference suggestion ${index + 1} id`,
    'MALFORMED_SUGGESTION'
  );
  if (!exactKeys(raw.canonical, [
    'id',
    'range',
    'enteredText',
    'sectionId',
    'startOffset',
    'endOffset'
  ])) {
    fail(
      'MALFORMED_SUGGESTION',
      `Reference suggestion “${suggestionId}” must contain exactly the canonical reference input fields.`,
      { suggestionId }
    );
  }
  const canonical = raw.canonical;
  if (typeof canonical.enteredText !== 'string') {
    fail(
      'MALFORMED_SUGGESTION',
      `Reference suggestion “${suggestionId}” enteredText must be text.`,
      { suggestionId }
    );
  }
  const enteredText = canonical.enteredText.trim().normalize('NFC');
  if (enteredText.length > 300) {
    fail(
      'MALFORMED_SUGGESTION',
      `Reference suggestion “${suggestionId}” enteredText is too long.`,
      { suggestionId }
    );
  }
  const startOffset = normalizeOffset(
    canonical.startOffset,
    `Reference suggestion “${suggestionId}” startOffset`
  );
  const endOffset = normalizeOffset(
    canonical.endOffset,
    `Reference suggestion “${suggestionId}” endOffset`
  );
  if (
    (startOffset === null) !== (endOffset === null)
    || (startOffset !== null && endOffset < startOffset)
  ) {
    fail(
      'MALFORMED_SUGGESTION',
      `Reference suggestion “${suggestionId}” offsets must be a complete, ordered pair.`,
      { suggestionId, startOffset, endOffset }
    );
  }
  return {
    id: suggestionId,
    canonical: {
      id: normalizeId(
        canonical.id,
        `Reference suggestion “${suggestionId}” canonical id`,
        'MALFORMED_SUGGESTION'
      ),
      range: normalizeCanonicalBibleRange(canonical.range, suggestionId),
      enteredText,
      sectionId: normalizeNullableId(
        canonical.sectionId,
        `Reference suggestion “${suggestionId}” sectionId`
      ),
      startOffset,
      endOffset
    }
  };
}

function uniqueSuggestionIds(outlineSuggestions, referenceSuggestions) {
  const seen = new Set();
  for (const suggestion of [...outlineSuggestions, ...referenceSuggestions]) {
    if (seen.has(suggestion.id)) {
      fail(
        'DUPLICATE_SUGGESTION_ID',
        `Extraction suggestion id “${suggestion.id}” is repeated.`,
        { suggestionId: suggestion.id }
      );
    }
    seen.add(suggestion.id);
  }
}

function uniqueCanonicalIds(suggestions, kind) {
  const seen = new Set();
  for (const suggestion of suggestions) {
    const canonicalId = suggestion.canonical.id;
    if (seen.has(canonicalId)) {
      fail(
        'CANONICAL_ID_COLLISION',
        `${kind} canonical id “${canonicalId}” is proposed more than once.`,
        { canonicalId }
      );
    }
    seen.add(canonicalId);
  }
}

/**
 * Canonical authoritative shape:
 * {
 *   schemaVersion: 1,
 *   kind: 'syncshow-sermon-extraction-proposal',
 *   id, sermonId, sermonRevision,
 *   sourceId, sourceKind, sourceRevision,
 *   outlineSuggestions: [{ id, canonical: { id, parentId, kind, titles } }],
 *   referenceSuggestions: [{
 *     id,
 *     canonical: { id, range, enteredText, sectionId, startOffset, endOffset }
 *   }]
 * }
 *
 * Suggestion envelopes may also hold transient text, evidence, or derivative
 * data for a review UI. Normalization deliberately drops those fields so they
 * can never be spread into a SermonDocument.
 */
function normalizeSermonExtractionProposal(raw) {
  if (!isRecord(raw)) {
    fail('INVALID_PROPOSAL', 'Sermon extraction proposal must be an object.');
  }
  if (
    raw.schemaVersion !== SERMON_EXTRACTION_PROPOSAL_SCHEMA_VERSION
    || raw.kind !== SERMON_EXTRACTION_PROPOSAL_KIND
  ) {
    fail('UNSUPPORTED_PROPOSAL', 'Sermon extraction proposal has an unsupported shape.');
  }
  if (!Array.isArray(raw.outlineSuggestions) || !Array.isArray(raw.referenceSuggestions)) {
    fail(
      'INVALID_PROPOSAL',
      'Sermon extraction proposal must contain outlineSuggestions and referenceSuggestions lists.'
    );
  }
  if (raw.outlineSuggestions.length > MAX_EXTRACTION_OUTLINE_SUGGESTIONS) {
    fail(
      'TOO_MANY_SUGGESTIONS',
      `A proposal can contain at most ${MAX_EXTRACTION_OUTLINE_SUGGESTIONS} outline suggestions.`,
      { kind: 'outline', maximum: MAX_EXTRACTION_OUTLINE_SUGGESTIONS }
    );
  }
  if (raw.referenceSuggestions.length > MAX_EXTRACTION_REFERENCE_SUGGESTIONS) {
    fail(
      'TOO_MANY_SUGGESTIONS',
      `A proposal can contain at most ${MAX_EXTRACTION_REFERENCE_SUGGESTIONS} reference suggestions.`,
      { kind: 'reference', maximum: MAX_EXTRACTION_REFERENCE_SUGGESTIONS }
    );
  }
  if (!Object.prototype.hasOwnProperty.call(REFERENCE_SOURCE_BY_SERMON_SOURCE_KIND, raw.sourceKind)) {
    fail('INVALID_PROPOSAL', 'Sermon extraction proposal has an unsupported source kind.', {
      sourceKind: raw.sourceKind || null
    });
  }

  const outlineSuggestions = raw.outlineSuggestions.map(normalizeOutlineSuggestion);
  const referenceSuggestions = raw.referenceSuggestions.map(normalizeReferenceSuggestion);
  uniqueSuggestionIds(outlineSuggestions, referenceSuggestions);
  uniqueCanonicalIds(outlineSuggestions, 'Outline');
  uniqueCanonicalIds(referenceSuggestions, 'Reference');

  return deepFreeze({
    schemaVersion: SERMON_EXTRACTION_PROPOSAL_SCHEMA_VERSION,
    kind: SERMON_EXTRACTION_PROPOSAL_KIND,
    id: normalizeId(raw.id, 'Proposal id'),
    sermonId: normalizeId(raw.sermonId, 'Proposal sermonId'),
    sermonRevision: normalizeRevision(raw.sermonRevision, 'Proposal sermonRevision'),
    sourceId: normalizeId(raw.sourceId, 'Proposal sourceId'),
    sourceKind: raw.sourceKind,
    sourceRevision: normalizeRevision(raw.sourceRevision, 'Proposal sourceRevision'),
    outlineSuggestions,
    referenceSuggestions
  });
}

function normalizeSelectionIds(value, field, maximum) {
  if (!Array.isArray(value)) {
    fail('INVALID_SELECTION', `${field} must be a list of suggestion ids.`, { field });
  }
  if (value.length > maximum) {
    fail(
      'TOO_MANY_SELECTION_IDS',
      `${field} cannot contain more than ${maximum} ids.`,
      { field, maximum }
    );
  }
  const seen = new Set();
  return value.map((id, index) => {
    const normalized = normalizeId(id, `${field} ${index + 1}`, 'INVALID_SELECTION');
    if (seen.has(normalized)) {
      fail('DUPLICATE_SELECTION_ID', `${field} repeats “${normalized}”.`, {
        field,
        suggestionId: normalized
      });
    }
    seen.add(normalized);
    return normalized;
  });
}

/**
 * Selection shape:
 * {
 *   outlineSuggestionIds: string[],
 *   referenceSuggestionIds: string[]
 * }
 */
function normalizeSermonExtractionSelection(raw = {}) {
  if (!isRecord(raw)) {
    fail('INVALID_SELECTION', 'Sermon extraction selection must be an object.');
  }
  return deepFreeze({
    outlineSuggestionIds: normalizeSelectionIds(
      raw.outlineSuggestionIds === undefined ? [] : raw.outlineSuggestionIds,
      'outlineSuggestionIds',
      MAX_SELECTED_OUTLINE_SUGGESTIONS
    ),
    referenceSuggestionIds: normalizeSelectionIds(
      raw.referenceSuggestionIds === undefined ? [] : raw.referenceSuggestionIds,
      'referenceSuggestionIds',
      MAX_SELECTED_REFERENCE_SUGGESTIONS
    )
  });
}

function selectedSuggestions(suggestions, selectedIds, kind) {
  const byId = new Map(suggestions.map(suggestion => [suggestion.id, suggestion]));
  const selected = new Set(selectedIds);
  for (const suggestionId of selected) {
    if (!byId.has(suggestionId)) {
      fail(
        'UNKNOWN_SUGGESTION_ID',
        `Selected ${kind} suggestion “${suggestionId}” is not in this proposal.`,
        { kind, suggestionId }
      );
    }
  }
  // Proposal order, rather than renderer-provided selection order, makes the
  // resulting canonical revision deterministic.
  return suggestions.filter(suggestion => selected.has(suggestion.id));
}

function validateProposalDependencies(document, proposal) {
  const existingOutlineIds = new Set(document.outline.map(section => section.id));
  const existingParents = new Map(
    document.outline.map(section => [section.id, section.parentId])
  );
  const proposedOutlineIds = new Set(
    proposal.outlineSuggestions.map(suggestion => suggestion.canonical.id)
  );
  const proposedParents = new Map(
    proposal.outlineSuggestions.map(suggestion => [
      suggestion.canonical.id,
      suggestion.canonical.parentId
    ])
  );
  const availableOutlineIds = new Set([...existingOutlineIds, ...proposedOutlineIds]);

  for (const suggestion of proposal.outlineSuggestions) {
    const parentId = suggestion.canonical.parentId;
    if (parentId && !availableOutlineIds.has(parentId)) {
      fail(
        'STALE_SUGGESTION',
        `Outline suggestion “${suggestion.id}” refers to an unavailable parent.`,
        { suggestionId: suggestion.id, parentId }
      );
    }
    const visited = new Set([suggestion.canonical.id]);
    let ancestorId = parentId;
    while (ancestorId) {
      if (visited.has(ancestorId)) {
        fail(
          'MALFORMED_SUGGESTION',
          `Outline suggestion “${suggestion.id}” creates an outline parent cycle.`,
          { suggestionId: suggestion.id, ancestorId }
        );
      }
      visited.add(ancestorId);
      ancestorId = proposedParents.has(ancestorId)
        ? proposedParents.get(ancestorId)
        : (existingParents.get(ancestorId) || null);
    }
  }
  for (const suggestion of proposal.referenceSuggestions) {
    const sectionId = suggestion.canonical.sectionId;
    if (sectionId && !availableOutlineIds.has(sectionId)) {
      fail(
        'STALE_SUGGESTION',
        `Reference suggestion “${suggestion.id}” refers to an unavailable outline section.`,
        { suggestionId: suggestion.id, sectionId }
      );
    }
  }
}

function validateSelectedDependencies(
  document,
  proposal,
  selectedOutlineSuggestions,
  selectedReferenceSuggestions
) {
  const existingOutlineIds = new Set(document.outline.map(section => section.id));
  const proposedOutlineIds = new Set(
    proposal.outlineSuggestions.map(suggestion => suggestion.canonical.id)
  );
  const selectedOutlineIds = new Set(
    selectedOutlineSuggestions.map(suggestion => suggestion.canonical.id)
  );
  const availableAfterSelection = new Set([...existingOutlineIds, ...selectedOutlineIds]);

  for (const suggestion of selectedOutlineSuggestions) {
    const parentId = suggestion.canonical.parentId;
    if (
      parentId
      && proposedOutlineIds.has(parentId)
      && !availableAfterSelection.has(parentId)
    ) {
      fail(
        'UNSELECTED_SUGGESTION_DEPENDENCY',
        `Outline suggestion “${suggestion.id}” needs another selected outline suggestion.`,
        { suggestionId: suggestion.id, parentId }
      );
    }
  }
  for (const suggestion of selectedReferenceSuggestions) {
    const sectionId = suggestion.canonical.sectionId;
    if (
      sectionId
      && proposedOutlineIds.has(sectionId)
      && !availableAfterSelection.has(sectionId)
    ) {
      fail(
        'UNSELECTED_SUGGESTION_DEPENDENCY',
        `Reference suggestion “${suggestion.id}” needs its outline suggestion selected.`,
        { suggestionId: suggestion.id, sectionId }
      );
    }
  }
}

function canonicalReference(suggestion, proposal) {
  return {
    id: suggestion.canonical.id,
    range: suggestion.canonical.range,
    role: 'mentioned',
    source: REFERENCE_SOURCE_BY_SERMON_SOURCE_KIND[proposal.sourceKind],
    // Selecting an extraction result accepts it into the sermon review queue;
    // it does not constitute the separate human confirmation required for
    // public passage discovery.
    reviewStatus: 'suggested',
    enteredText: suggestion.canonical.enteredText,
    sourceId: proposal.sourceId,
    sectionId: suggestion.canonical.sectionId,
    startOffset: suggestion.canonical.startOffset,
    endOffset: suggestion.canonical.endOffset
  };
}

function mergeSelectedOutlines(existingItems, selectedSuggestionsList) {
  const existingById = new Map(existingItems.map(item => [item.id, item]));
  const additions = [];
  const updates = new Map();
  const appliedSuggestionIds = [];

  for (const suggestion of selectedSuggestionsList) {
    const canonical = suggestion.canonical;
    const existing = existingById.get(canonical.id);
    if (!existing) {
      additions.push(canonical);
      appliedSuggestionIds.push(suggestion.id);
      existingById.set(canonical.id, canonical);
      continue;
    }
    if (
      existing.parentId !== canonical.parentId
      || existing.kind !== canonical.kind
    ) {
      fail(
        'CANONICAL_ID_COLLISION',
        `Outline id “${canonical.id}” already belongs to different canonical content.`,
        { kind: 'Outline', canonicalId: canonical.id, suggestionId: suggestion.id }
      );
    }

    let changed = false;
    const mergedTitles = { ...existing.titles };
    for (const [language, title] of Object.entries(canonical.titles)) {
      if (!Object.prototype.hasOwnProperty.call(existing.titles, language)) {
        mergedTitles[language] = title;
        changed = true;
        continue;
      }
      if (existing.titles[language] !== title) {
        fail(
          'CANONICAL_ID_COLLISION',
          `Outline id “${canonical.id}” already has a different ${language} title.`,
          {
            kind: 'Outline',
            canonicalId: canonical.id,
            suggestionId: suggestion.id,
            language
          }
        );
      }
    }
    if (!changed) continue;

    const updated = {
      ...existing,
      titles: Object.fromEntries(
        Object.entries(mergedTitles).sort(([left], [right]) => left.localeCompare(right))
      )
    };
    updates.set(canonical.id, updated);
    existingById.set(canonical.id, updated);
    appliedSuggestionIds.push(suggestion.id);
  }
  return { additions, updates, appliedSuggestionIds };
}

function mergeSelected(existingItems, selectedSuggestionsList, canonicalForSuggestion, kind) {
  const existingById = new Map(existingItems.map(item => [item.id, item]));
  const additions = [];
  const appliedSuggestionIds = [];
  for (const suggestion of selectedSuggestionsList) {
    const canonical = canonicalForSuggestion(suggestion);
    const existing = existingById.get(canonical.id);
    if (existing) {
      if (canonicalJson(existing) !== canonicalJson(canonical)) {
        fail(
          'CANONICAL_ID_COLLISION',
          `${kind} id “${canonical.id}” already belongs to different canonical content.`,
          { kind, canonicalId: canonical.id, suggestionId: suggestion.id }
        );
      }
      continue;
    }
    additions.push(canonical);
    appliedSuggestionIds.push(suggestion.id);
    existingById.set(canonical.id, canonical);
  }
  return { additions, appliedSuggestionIds };
}

function result(document, previousRevision, changed, applied) {
  return deepFreeze({
    changed,
    document,
    previousRevision,
    revision: changed ? sermonDocumentSha256(document) : previousRevision,
    applied: {
      outlineSuggestionIds: applied.outlineSuggestionIds,
      referenceSuggestionIds: applied.referenceSuggestionIds
    }
  });
}

/**
 * Applies only human-selected canonical suggestions. A stale proposal may
 * return unchanged only when every selected canonical item is already present
 * identically; this is the idempotent retry path and cannot mutate content.
 */
function applySermonExtractionReview(currentSermon, rawProposal, rawSelection = {}) {
  let document;
  try {
    document = normalizeSermonDocument(currentSermon);
  } catch (error) {
    fail('INVALID_CURRENT_SERMON', 'Current sermon is not a canonical SermonDocument.', {
      causeCode: error.code || null
    });
  }
  if (document.publication.status === 'archived') {
    fail(
      'ARCHIVED_SERMON',
      'Archived sermons cannot accept extracted outline or Scripture-reference suggestions.'
    );
  }
  const proposal = normalizeSermonExtractionProposal(rawProposal);
  const selection = normalizeSermonExtractionSelection(rawSelection);
  const currentRevision = sermonDocumentSha256(document);

  if (proposal.sermonId !== document.id) {
    fail('SERMON_MISMATCH', 'Extraction proposal belongs to a different sermon.', {
      expectedSermonId: document.id,
      proposalSermonId: proposal.sermonId
    });
  }

  const source = document.sources.find(candidate => candidate.id === proposal.sourceId);
  if (!source || source.kind !== proposal.sourceKind) {
    fail('SOURCE_MISMATCH', 'Extraction proposal belongs to a different sermon source.', {
      sourceId: proposal.sourceId,
      proposalSourceKind: proposal.sourceKind,
      currentSourceKind: source?.kind || null
    });
  }
  if (source.sha256 !== proposal.sourceRevision) {
    fail('SOURCE_REVISION_MISMATCH', 'The sermon source changed after extraction.', {
      sourceId: source.id,
      proposalSourceRevision: proposal.sourceRevision,
      currentSourceRevision: source.sha256
    });
  }

  validateProposalDependencies(document, proposal);
  const selectedOutlineSuggestions = selectedSuggestions(
    proposal.outlineSuggestions,
    selection.outlineSuggestionIds,
    'outline'
  );
  const selectedReferenceSuggestions = selectedSuggestions(
    proposal.referenceSuggestions,
    selection.referenceSuggestionIds,
    'reference'
  );
  validateSelectedDependencies(
    document,
    proposal,
    selectedOutlineSuggestions,
    selectedReferenceSuggestions
  );

  const outlineMerge = mergeSelectedOutlines(
    document.outline,
    selectedOutlineSuggestions
  );
  const referenceMerge = mergeSelected(
    document.references,
    selectedReferenceSuggestions,
    suggestion => canonicalReference(suggestion, proposal),
    'Reference'
  );
  const applied = {
    outlineSuggestionIds: outlineMerge.appliedSuggestionIds,
    referenceSuggestionIds: referenceMerge.appliedSuggestionIds
  };
  const changed = outlineMerge.additions.length > 0
    || outlineMerge.updates.size > 0
    || referenceMerge.additions.length > 0;
  const selectedCount = selectedOutlineSuggestions.length + selectedReferenceSuggestions.length;
  const finalReferenceCount = document.references.length
    + referenceMerge.additions.length;
  if (finalReferenceCount > MAX_SERMON_REFERENCES) {
    fail(
      'TOO_MANY_REFERENCES',
      `A sermon can contain at most ${MAX_SERMON_REFERENCES} Scripture references.`,
      {
        maximum: MAX_SERMON_REFERENCES,
        existing: document.references.length,
        additions: referenceMerge.additions.length,
        final: finalReferenceCount
      }
    );
  }

  if (proposal.sermonRevision !== currentRevision) {
    // Retrying a successfully applied review is safe even though the first
    // write changed the sermon revision. No other stale proposal can mutate.
    if (!changed && selectedCount > 0) {
      return result(document, currentRevision, false, applied);
    }
    fail('SERMON_REVISION_MISMATCH', 'The sermon changed after extraction.', {
      proposalSermonRevision: proposal.sermonRevision,
      currentSermonRevision: currentRevision
    });
  }

  if (!changed) return result(document, currentRevision, false, applied);
  if (document.outline.length + outlineMerge.additions.length > 500) {
    fail('TOO_MANY_OUTLINE_ITEMS', 'Selected suggestions exceed the sermon outline limit.', {
      maximum: 500
    });
  }

  const base = document.schemaVersion === SERMON_SCHEMA_VERSION
    ? document
    : upgradeSermonDocument(document);
  const publication = ['ready', 'published'].includes(base.publication.status)
    ? {
        ...base.publication,
        status: 'draft',
        publishedAt: null
      }
    : base.publication;
  let merged;
  try {
    merged = normalizeSermonDocument({
      ...base,
      outline: [
        ...base.outline.map(section => outlineMerge.updates.get(section.id) || section),
        ...outlineMerge.additions
      ],
      references: [...base.references, ...referenceMerge.additions],
      publication
    });
  } catch (error) {
    fail('MALFORMED_SUGGESTION', 'Selected suggestions cannot form a canonical sermon.', {
      causeCode: error.code || null
    });
  }
  return result(merged, currentRevision, true, applied);
}

module.exports = {
  MAX_EXTRACTION_OUTLINE_SUGGESTIONS,
  MAX_EXTRACTION_REFERENCE_SUGGESTIONS,
  MAX_SELECTED_OUTLINE_SUGGESTIONS,
  MAX_SELECTED_REFERENCE_SUGGESTIONS,
  REFERENCE_SOURCE_BY_SERMON_SOURCE_KIND,
  SERMON_EXTRACTION_PROPOSAL_KIND,
  SERMON_EXTRACTION_PROPOSAL_SCHEMA_VERSION,
  SermonExtractionReviewError,
  applySermonExtractionReview,
  normalizeSermonExtractionProposal,
  normalizeSermonExtractionSelection
};
