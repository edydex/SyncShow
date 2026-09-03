'use strict';

const {
  MAX_EXTRACTION_UNITS,
  MAX_OUTLINE_TITLE_CHARS,
  MAX_OUTLINE_SUGGESTIONS,
  MAX_REFERENCE_SUGGESTIONS,
  MAX_SOURCE_UNIT_LINKS,
  MAX_TEXT_PREVIEW_CHARS,
  MAX_TOTAL_TEXT_CHARS,
  MAX_UNIT_TEXT_CHARS,
  SERMON_SOURCE_EXTRACTION_KIND,
  SERMON_SOURCE_EXTRACTION_LEGACY_SCHEMA_VERSION,
  SERMON_SOURCE_EXTRACTION_SCHEMA_VERSION
} = require('./SermonSourceExtraction');
const { CANONICAL_BIBLE_BOOKS } = require('./BibleRange');
const {
  PptxStyledTextError,
  normalizePptxTextSpans
} = require('./PptxStyledText');

const MAX_UNIT_LABEL_CHARS = 160;
const MAX_RAW_SUGGESTION_TEXT_CHARS = 600;
const MAX_MEDIA_TYPE_CHARS = 200;
const MAX_EXTRACTOR_ID_CHARS = 128;
const MAX_OCCURRENCE_COUNT = 1_000_000;

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const LANGUAGE_PATTERN = /^[a-z]{2,3}(?:-[a-z0-9]{2,8})*$/;
const MEDIA_TYPE_PATTERN = /^[\x21-\x7e]+$/;
const SOURCE_KINDS = new Set(['manuscript', 'slide-notes', 'transcript', 'other']);
const UNIT_KINDS = new Set(['page', 'slide', 'document']);
const OUTLINE_KINDS = new Set(['section', 'point', 'subpoint']);
const OUTLINE_MARKERS = new Set(['I', 'II', 'III', 'A', 'B', 'C']);
const SCOPE_STRATEGIES = new Set([
  'whole-source',
  'pptx-roman-outline-window',
  'pptx-no-sermon-window'
]);
const BOOK_IDS = new Set(CANONICAL_BIBLE_BOOKS.map(book => book.id));

class SermonSourceExtractionProposalError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'SermonSourceExtractionProposalError';
    this.code = code;
    this.details = Object.freeze({ ...details });
  }
}

function fail(code, message, details = {}) {
  throw new SermonSourceExtractionProposalError(code, message, details);
}

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function exactKeys(value, expectedKeys, field) {
  if (!isRecord(value)) {
    fail('INVALID_EXTRACTION_PROPOSAL', `${field} must be an object.`, { field });
  }
  const actual = Object.keys(value);
  const expected = new Set(expectedKeys);
  if (
    actual.length !== expected.size
    || actual.some(key => !expected.has(key))
  ) {
    fail(
      'INVALID_EXTRACTION_PROPOSAL',
      `${field} has unsupported or missing fields.`,
      { field }
    );
  }
}

function exactKeysWithOptional(value, requiredKeys, optionalKeys, field) {
  if (!isRecord(value)) {
    fail('INVALID_EXTRACTION_PROPOSAL', `${field} must be an object.`, { field });
  }
  const actual = Object.keys(value);
  const required = new Set(requiredKeys);
  const allowed = new Set([...requiredKeys, ...optionalKeys]);
  if (
    requiredKeys.some(key => !Object.prototype.hasOwnProperty.call(value, key))
    || actual.some(key => !allowed.has(key))
  ) {
    fail(
      'INVALID_EXTRACTION_PROPOSAL',
      `${field} has unsupported or missing fields.`,
      { field }
    );
  }
}

function boundedString(value, field, maximum, { required = true } = {}) {
  if (typeof value !== 'string') {
    fail('INVALID_EXTRACTION_PROPOSAL', `${field} must be text.`, { field });
  }
  if ((required && value.length < 1) || value.length > maximum) {
    fail(
      'EXTRACTION_PROPOSAL_TOO_LARGE',
      `${field} is outside its safe text limit.`,
      { field, maximum }
    );
  }
  return value;
}

function identifier(value, field) {
  const result = boundedString(value, field, 128);
  if (!ID_PATTERN.test(result)) {
    fail('INVALID_EXTRACTION_PROPOSAL', `${field} is not a canonical identifier.`, {
      field
    });
  }
  return result;
}

function nullableIdentifier(value, field) {
  if (value === null) return null;
  return identifier(value, field);
}

function positiveInteger(value, field, maximum = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    fail('INVALID_EXTRACTION_PROPOSAL', `${field} must be a bounded positive integer.`, {
      field,
      maximum
    });
  }
  return value;
}

function nonNegativeInteger(value, field, maximum = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || value < 0 || value > maximum) {
    fail(
      'INVALID_EXTRACTION_PROPOSAL',
      `${field} must be a bounded non-negative integer.`,
      { field, maximum }
    );
  }
  return value;
}

function boolean(value, field) {
  if (typeof value !== 'boolean') {
    fail('INVALID_EXTRACTION_PROPOSAL', `${field} must be true or false.`, { field });
  }
  return value;
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function normalizeLanguages(value, field) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 8) {
    fail('INVALID_EXTRACTION_PROPOSAL', `${field} must contain 1 through 8 languages.`, {
      field
    });
  }
  const languages = value.map((language, index) => {
    const normalized = boundedString(language, `${field} ${index + 1}`, 35);
    if (!LANGUAGE_PATTERN.test(normalized)) {
      fail(
        'INVALID_EXTRACTION_PROPOSAL',
        `${field} contains an invalid language tag.`,
        { field }
      );
    }
    return normalized;
  });
  if (new Set(languages).size !== languages.length) {
    fail('INVALID_EXTRACTION_PROPOSAL', `${field} repeats a language tag.`, { field });
  }
  return [...languages].sort();
}

function normalizeUnitIds(value, field, unitsById, primaryUnitId = null) {
  if (!Array.isArray(value) || value.length > MAX_SOURCE_UNIT_LINKS) {
    fail(
      'EXTRACTION_PROPOSAL_TOO_LARGE',
      `${field} exceeds the safe source-unit link limit.`,
      { field, maximum: MAX_SOURCE_UNIT_LINKS }
    );
  }
  const ids = value.map((unitId, index) => identifier(unitId, `${field} ${index + 1}`));
  if (new Set(ids).size !== ids.length) {
    fail('INVALID_EXTRACTION_PROPOSAL', `${field} repeats a source unit.`, { field });
  }
  if (ids.some(unitId => !unitsById.has(unitId))) {
    fail('INVALID_EXTRACTION_PROPOSAL', `${field} refers to an unknown source unit.`, {
      field
    });
  }
  if (primaryUnitId && !ids.includes(primaryUnitId)) {
    fail(
      'INVALID_EXTRACTION_PROPOSAL',
      `${field} must include the primary source unit.`,
      { field }
    );
  }
  return ids;
}

function normalizeUnits(rawUnits, schemaVersion, source) {
  if (!Array.isArray(rawUnits) || rawUnits.length > MAX_EXTRACTION_UNITS) {
    fail(
      'EXTRACTION_PROPOSAL_TOO_LARGE',
      'Extraction units exceed the safe review limit.',
      { maximum: MAX_EXTRACTION_UNITS }
    );
  }
  const seen = new Set();
  let totalTextChars = 0;
  const units = rawUnits.map((raw, index) => {
    const field = `Extraction unit ${index + 1}`;
    const unitKeys = ['id', 'kind', 'ordinal', 'label', 'text', 'truncated'];
    if (schemaVersion === SERMON_SOURCE_EXTRACTION_LEGACY_SCHEMA_VERSION) {
      exactKeys(raw, unitKeys, field);
    } else {
      exactKeysWithOptional(raw, unitKeys, ['spans'], field);
    }
    const id = identifier(raw.id, `${field} id`);
    if (seen.has(id)) {
      fail('INVALID_EXTRACTION_PROPOSAL', 'Extraction unit ids must be unique.', { field });
    }
    seen.add(id);
    if (!UNIT_KINDS.has(raw.kind)) {
      fail('INVALID_EXTRACTION_PROPOSAL', `${field} has an unsupported kind.`, { field });
    }
    const ordinal = positiveInteger(raw.ordinal, `${field} ordinal`, MAX_EXTRACTION_UNITS);
    if (ordinal !== index + 1) {
      fail('INVALID_EXTRACTION_PROPOSAL', 'Extraction units must remain in ordinal order.', {
        field
      });
    }
    const text = boundedString(raw.text, `${field} text`, MAX_UNIT_TEXT_CHARS, {
      required: false
    });
    totalTextChars += text.length;
    if (totalTextChars > MAX_TOTAL_TEXT_CHARS) {
      fail(
        'EXTRACTION_PROPOSAL_TOO_LARGE',
        'Extraction text exceeds the safe aggregate review limit.',
        { maximum: MAX_TOTAL_TEXT_CHARS }
      );
    }
    let spans;
    if (raw.spans !== undefined) {
      if (raw.kind !== 'slide'
        || source.mediaType
          !== 'application/vnd.openxmlformats-officedocument.presentationml.presentation') {
        fail(
          'INVALID_EXTRACTION_PROPOSAL',
          `${field} may carry direct-run spans only for a PowerPoint slide.`,
          { field }
        );
      }
      try {
        spans = normalizePptxTextSpans(raw.spans, text, {
          field: `${field} spans`
        });
      } catch (error) {
        if (error instanceof PptxStyledTextError) {
          fail(
            error.code === 'TEXT_SPANS_TOO_LARGE'
              ? 'EXTRACTION_PROPOSAL_TOO_LARGE'
              : 'INVALID_EXTRACTION_PROPOSAL',
            `${field} has invalid direct-run formatting evidence.`,
            { field }
          );
        }
        throw error;
      }
    }
    return {
      id,
      kind: raw.kind,
      ordinal,
      label: boundedString(raw.label, `${field} label`, MAX_UNIT_LABEL_CHARS),
      text,
      ...(spans?.length > 0 ? { spans } : {}),
      truncated: boolean(raw.truncated, `${field} truncated`)
    };
  });
  return units;
}

function normalizeScope(raw, units) {
  exactKeys(raw, [
    'strategy',
    'startUnitId',
    'endUnitId',
    'startOrdinal',
    'endOrdinal'
  ], 'Extraction suggestionScope');
  if (!SCOPE_STRATEGIES.has(raw.strategy)) {
    fail(
      'INVALID_EXTRACTION_PROPOSAL',
      'Extraction suggestionScope has an unsupported strategy.'
    );
  }
  const startUnitId = nullableIdentifier(
    raw.startUnitId,
    'Extraction suggestionScope startUnitId'
  );
  const endUnitId = nullableIdentifier(
    raw.endUnitId,
    'Extraction suggestionScope endUnitId'
  );
  const startOrdinal = raw.startOrdinal === null
    ? null
    : positiveInteger(
        raw.startOrdinal,
        'Extraction suggestionScope startOrdinal',
        MAX_EXTRACTION_UNITS
      );
  const endOrdinal = raw.endOrdinal === null
    ? null
    : positiveInteger(
        raw.endOrdinal,
        'Extraction suggestionScope endOrdinal',
        MAX_EXTRACTION_UNITS
      );
  const allNull = startUnitId === null
    && endUnitId === null
    && startOrdinal === null
    && endOrdinal === null;
  if (raw.strategy === 'pptx-no-sermon-window') {
    if (!allNull) {
      fail(
        'INVALID_EXTRACTION_PROPOSAL',
        'A no-window extraction scope cannot identify source units.'
      );
    }
  } else if (units.length === 0) {
    if (!allNull) {
      fail(
        'INVALID_EXTRACTION_PROPOSAL',
        'An empty extraction scope cannot identify source units.'
      );
    }
  } else {
    if (
      startUnitId === null
      || endUnitId === null
      || startOrdinal === null
      || endOrdinal === null
      || startOrdinal > endOrdinal
      || units[startOrdinal - 1]?.id !== startUnitId
      || units[endOrdinal - 1]?.id !== endUnitId
    ) {
      fail(
        'INVALID_EXTRACTION_PROPOSAL',
        'Extraction suggestionScope does not match the ordered source units.'
      );
    }
  }
  if (
    raw.strategy === 'whole-source'
    && units.length > 0
    && (startOrdinal !== 1 || endOrdinal !== units.length)
  ) {
    fail(
      'INVALID_EXTRACTION_PROPOSAL',
      'A whole-source extraction scope must cover every ordered source unit.'
    );
  }
  return {
    strategy: raw.strategy,
    startUnitId,
    endUnitId,
    startOrdinal,
    endOrdinal
  };
}

function normalizeTitles(raw, field) {
  if (!isRecord(raw) || Object.keys(raw).length < 1 || Object.keys(raw).length > 8) {
    fail('INVALID_EXTRACTION_PROPOSAL', `${field} must contain localized titles.`, {
      field
    });
  }
  const entries = Object.entries(raw).map(([language, title]) => {
    if (!LANGUAGE_PATTERN.test(language)) {
      fail('INVALID_EXTRACTION_PROPOSAL', `${field} has an invalid language tag.`, {
        field
      });
    }
    return [
      language,
      boundedString(title, `${field}.${language}`, MAX_OUTLINE_TITLE_CHARS)
    ];
  });
  entries.sort(([left], [right]) => left.localeCompare(right));
  return Object.fromEntries(entries);
}

function normalizeOutlineSuggestions(rawSuggestions, unitsById) {
  if (!Array.isArray(rawSuggestions) || rawSuggestions.length > MAX_OUTLINE_SUGGESTIONS) {
    fail(
      'EXTRACTION_PROPOSAL_TOO_LARGE',
      'Outline suggestions exceed the safe review limit.',
      { maximum: MAX_OUTLINE_SUGGESTIONS }
    );
  }
  const seen = new Set();
  const suggestions = rawSuggestions.map((raw, index) => {
    const field = `Outline suggestion ${index + 1}`;
    exactKeys(raw, [
      'id',
      'level',
      'marker',
      'parentId',
      'parentSuggestionId',
      'suggestedKind',
      'titles',
      'rawText',
      'sourceUnitIds',
      'sourceUnitIdsTruncated',
      'occurrenceCount'
    ], field);
    const id = identifier(raw.id, `${field} id`);
    if (seen.has(id)) {
      fail('INVALID_EXTRACTION_PROPOSAL', 'Outline suggestion ids must be unique.', {
        field
      });
    }
    seen.add(id);
    const level = positiveInteger(raw.level, `${field} level`, 3);
    if (!OUTLINE_MARKERS.has(raw.marker)) {
      fail('INVALID_EXTRACTION_PROPOSAL', `${field} has an unsupported marker.`, {
        field
      });
    }
    if (!OUTLINE_KINDS.has(raw.suggestedKind)) {
      fail('INVALID_EXTRACTION_PROPOSAL', `${field} has an unsupported outline kind.`, {
        field
      });
    }
    const parentId = nullableIdentifier(raw.parentId, `${field} parentId`);
    const parentSuggestionId = nullableIdentifier(
      raw.parentSuggestionId,
      `${field} parentSuggestionId`
    );
    if (parentId !== parentSuggestionId) {
      fail(
        'INVALID_EXTRACTION_PROPOSAL',
        `${field} has inconsistent parent suggestion ids.`,
        { field }
      );
    }
    if (
      (level === 1 && (parentId !== null || raw.suggestedKind !== 'section'))
      || (level > 1 && (parentId === null || raw.suggestedKind === 'section'))
    ) {
      fail('INVALID_EXTRACTION_PROPOSAL', `${field} has inconsistent outline depth.`, {
        field
      });
    }
    return {
      id,
      level,
      marker: raw.marker,
      parentId,
      parentSuggestionId,
      suggestedKind: raw.suggestedKind,
      titles: normalizeTitles(raw.titles, `${field} titles`),
      rawText: boundedString(
        raw.rawText,
        `${field} rawText`,
        MAX_RAW_SUGGESTION_TEXT_CHARS
      ),
      sourceUnitIds: normalizeUnitIds(
        raw.sourceUnitIds,
        `${field} sourceUnitIds`,
        unitsById
      ),
      sourceUnitIdsTruncated: boolean(
        raw.sourceUnitIdsTruncated,
        `${field} sourceUnitIdsTruncated`
      ),
      occurrenceCount: positiveInteger(
        raw.occurrenceCount,
        `${field} occurrenceCount`,
        MAX_OCCURRENCE_COUNT
      )
    };
  });
  const suggestionIds = new Set(suggestions.map(suggestion => suggestion.id));
  for (const suggestion of suggestions) {
    if (
      suggestion.parentId
      && (
        suggestion.parentId === suggestion.id
        || !suggestionIds.has(suggestion.parentId)
      )
    ) {
      fail(
        'INVALID_EXTRACTION_PROPOSAL',
        'An outline suggestion has an unavailable parent suggestion.',
        { suggestionId: suggestion.id }
      );
    }
  }
  return suggestions;
}

function normalizeReferenceSuggestions(rawSuggestions, unitsById) {
  if (!Array.isArray(rawSuggestions) || rawSuggestions.length > MAX_REFERENCE_SUGGESTIONS) {
    fail(
      'EXTRACTION_PROPOSAL_TOO_LARGE',
      'Scripture reference suggestions exceed the safe review limit.',
      { maximum: MAX_REFERENCE_SUGGESTIONS }
    );
  }
  const seen = new Set();
  return rawSuggestions.map((raw, index) => {
    const field = `Scripture reference suggestion ${index + 1}`;
    exactKeys(raw, [
      'id',
      'rawText',
      'language',
      'bookHint',
      'unitId',
      'startOffset',
      'endOffset',
      'sourceUnitIds',
      'sourceUnitIdsTruncated',
      'occurrenceCount'
    ], field);
    const id = identifier(raw.id, `${field} id`);
    if (seen.has(id)) {
      fail(
        'INVALID_EXTRACTION_PROPOSAL',
        'Scripture reference suggestion ids must be unique.',
        { field }
      );
    }
    seen.add(id);
    const language = boundedString(raw.language, `${field} language`, 35);
    if (!LANGUAGE_PATTERN.test(language)) {
      fail('INVALID_EXTRACTION_PROPOSAL', `${field} has an invalid language tag.`, {
        field
      });
    }
    const bookHint = identifier(raw.bookHint, `${field} bookHint`);
    if (!BOOK_IDS.has(bookHint)) {
      fail('INVALID_EXTRACTION_PROPOSAL', `${field} has an unknown canonical book.`, {
        field
      });
    }
    const unitId = identifier(raw.unitId, `${field} unitId`);
    const unit = unitsById.get(unitId);
    if (!unit) {
      fail('INVALID_EXTRACTION_PROPOSAL', `${field} refers to an unknown source unit.`, {
        field
      });
    }
    const startOffset = nonNegativeInteger(
      raw.startOffset,
      `${field} startOffset`,
      unit.text.length
    );
    const endOffset = nonNegativeInteger(
      raw.endOffset,
      `${field} endOffset`,
      unit.text.length
    );
    if (endOffset <= startOffset) {
      fail('INVALID_EXTRACTION_PROPOSAL', `${field} has invalid source offsets.`, {
        field
      });
    }
    return {
      id,
      rawText: boundedString(
        raw.rawText,
        `${field} rawText`,
        MAX_RAW_SUGGESTION_TEXT_CHARS
      ),
      language,
      bookHint,
      unitId,
      startOffset,
      endOffset,
      sourceUnitIds: normalizeUnitIds(
        raw.sourceUnitIds,
        `${field} sourceUnitIds`,
        unitsById,
        unitId
      ),
      sourceUnitIdsTruncated: boolean(
        raw.sourceUnitIdsTruncated,
        `${field} sourceUnitIdsTruncated`
      ),
      occurrenceCount: positiveInteger(
        raw.occurrenceCount,
        `${field} occurrenceCount`,
        MAX_OCCURRENCE_COUNT
      )
    };
  });
}

function normalizeTruncation(raw) {
  exactKeys(raw, [
    'units',
    'text',
    'preview',
    'outlineSuggestions',
    'scriptureReferences'
  ], 'Extraction truncation');
  return {
    units: boolean(raw.units, 'Extraction truncation units'),
    text: boolean(raw.text, 'Extraction truncation text'),
    preview: boolean(raw.preview, 'Extraction truncation preview'),
    outlineSuggestions: boolean(
      raw.outlineSuggestions,
      'Extraction truncation outlineSuggestions'
    ),
    scriptureReferences: boolean(
      raw.scriptureReferences,
      'Extraction truncation scriptureReferences'
    )
  };
}

function normalizeSermonSourceExtractionProposal(raw) {
  exactKeys(raw, [
    'schemaVersion',
    'kind',
    'extractor',
    'source',
    'units',
    'textPreview',
    'suggestionScope',
    'outlineSuggestions',
    'scriptureReferenceSuggestions',
    'truncated'
  ], 'Sermon source extraction proposal');
  const supportedSchemaVersions = new Set([
    SERMON_SOURCE_EXTRACTION_LEGACY_SCHEMA_VERSION,
    SERMON_SOURCE_EXTRACTION_SCHEMA_VERSION
  ]);
  if (!supportedSchemaVersions.has(raw.schemaVersion)
    || raw.kind !== SERMON_SOURCE_EXTRACTION_KIND) {
    fail(
      'UNSUPPORTED_EXTRACTION_PROPOSAL',
      'Sermon source extraction proposal has an unsupported schema.'
    );
  }

  exactKeys(raw.extractor, ['id', 'version'], 'Extraction extractor');
  const extractor = {
    id: boundedString(raw.extractor.id, 'Extraction extractor id', MAX_EXTRACTOR_ID_CHARS),
    version: positiveInteger(
      raw.extractor.version,
      'Extraction extractor version',
      1_000_000
    )
  };

  exactKeys(
    raw.source,
    ['id', 'sha256', 'kind', 'languages', 'mediaType'],
    'Extraction source'
  );
  const sourceId = identifier(raw.source.id, 'Extraction source id');
  if (typeof raw.source.sha256 !== 'string' || !SHA256_PATTERN.test(raw.source.sha256)) {
    fail('INVALID_EXTRACTION_PROPOSAL', 'Extraction source sha256 is invalid.');
  }
  if (!SOURCE_KINDS.has(raw.source.kind)) {
    fail('INVALID_EXTRACTION_PROPOSAL', 'Extraction source kind is unsupported.');
  }
  const mediaType = boundedString(
    raw.source.mediaType,
    'Extraction source mediaType',
    MAX_MEDIA_TYPE_CHARS
  );
  if (!MEDIA_TYPE_PATTERN.test(mediaType)) {
    fail('INVALID_EXTRACTION_PROPOSAL', 'Extraction source mediaType is invalid.');
  }
  const source = {
    id: sourceId,
    sha256: raw.source.sha256,
    kind: raw.source.kind,
    languages: normalizeLanguages(raw.source.languages, 'Extraction source languages'),
    mediaType
  };

  const units = normalizeUnits(raw.units, raw.schemaVersion, source);
  const suggestionScope = normalizeScope(raw.suggestionScope, units);
  const suggestionUnits = suggestionScope.startOrdinal === null
    ? []
    : units.slice(
        suggestionScope.startOrdinal - 1,
        suggestionScope.endOrdinal
      );
  const suggestionUnitsById = new Map(
    suggestionUnits.map(unit => [unit.id, unit])
  );
  const outlineSuggestions = normalizeOutlineSuggestions(
    raw.outlineSuggestions,
    suggestionUnitsById
  );
  const scriptureReferenceSuggestions = normalizeReferenceSuggestions(
    raw.scriptureReferenceSuggestions,
    suggestionUnitsById
  );

  return deepFreeze({
    schemaVersion: raw.schemaVersion,
    kind: SERMON_SOURCE_EXTRACTION_KIND,
    extractor,
    source,
    units,
    textPreview: boundedString(
      raw.textPreview,
      'Extraction textPreview',
      MAX_TEXT_PREVIEW_CHARS,
      { required: false }
    ),
    suggestionScope,
    outlineSuggestions,
    scriptureReferenceSuggestions,
    truncated: normalizeTruncation(raw.truncated)
  });
}

module.exports = {
  MAX_EXTRACTOR_ID_CHARS,
  MAX_MEDIA_TYPE_CHARS,
  MAX_OCCURRENCE_COUNT,
  MAX_RAW_SUGGESTION_TEXT_CHARS,
  MAX_SOURCE_UNIT_LINKS,
  MAX_UNIT_LABEL_CHARS,
  SermonSourceExtractionProposalError,
  normalizeSermonSourceExtractionProposal
};
