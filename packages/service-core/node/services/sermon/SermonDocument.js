'use strict';

const { Buffer, crypto, utf8Text } = require('../../runtime');
const {
  bibleRangesIntersect,
  compareBibleRanges,
  normalizeBibleRange
} = require('./BibleRange');

const SERMON_SCHEMA_VERSION = 3;
const SUPPORTED_SERMON_SCHEMA_VERSIONS = new Set([1, 2, SERMON_SCHEMA_VERSION]);
const SERMON_KIND = 'syncshow-sermon';
const SERMON_PASSAGE_INDEX_SCHEMA_VERSION = 1;
const SERMON_PASSAGE_INDEX_KIND = 'syncshow-sermon-passage-index';
const MAX_SERMON_SOURCE_BYTES = 2 * 1024 * 1024;
const MAX_SERMON_REFERENCES = 512;
const MAX_SERMON_BODY_ENTRIES = 256;
const MAX_SERMON_BODY_ENTRY_BYTES = 1024 * 1024;
const MAX_SERMON_BODY_BYTES = 1536 * 1024;
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const LANGUAGE_PATTERN = /^[a-z]{2,3}(?:-[a-z0-9]{2,8})*$/;
const MAX_SOURCE_LANGUAGES = 8;

const OUTLINE_KINDS = new Set(['section', 'point', 'subpoint']);
const SOURCE_KINDS = new Set(['manuscript', 'slide-notes', 'transcript', 'other']);
const BODY_KINDS = new Set(['manuscript', 'slide-notes', 'transcript', 'other']);
const REFERENCE_ROLES = new Set(['primary', 'mentioned']);
const REFERENCE_SOURCES = new Set([
  'pastor',
  'slide-notes',
  'manuscript',
  'transcript-extraction',
  'operator'
]);
const REVIEW_STATUSES = new Set(['suggested', 'confirmed']);
const MEDIA_KINDS = new Set(['audio', 'video', 'transcript', 'document']);
const MEDIA_STATUSES = new Set(['pending', 'processing', 'ready', 'failed']);
const PUBLICATION_STATUSES = new Set(['draft', 'ready', 'published', 'archived']);
const VISIBILITIES = new Set(['private', 'members', 'unlisted', 'public']);

class SermonDocumentError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'SermonDocumentError';
    this.code = code;
    this.details = details;
  }
}

function fail(code, message, details = {}) {
  throw new SermonDocumentError(code, message, details);
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

function boundedText(value, field, maximum, { required = false } = {}) {
  if (value === undefined || value === null) value = '';
  if (typeof value !== 'string') fail('INVALID_TEXT', `${field} must be text.`, { field });
  const result = value.trim().normalize('NFC');
  if (required && !result) fail('MISSING_TEXT', `${field} is required.`, { field });
  if (result.length > maximum) {
    fail('TEXT_TOO_LONG', `${field} must be ${maximum} characters or fewer.`, {
      field,
      maximum
    });
  }
  return result;
}

function normalizeId(value, field) {
  const result = boundedText(value, field, 128, { required: true });
  if (!ID_PATTERN.test(result)) {
    fail(
      'INVALID_ID',
      `${field} must start with a letter or number and use only letters, numbers, dot, underscore, colon, or hyphen.`,
      { field, value: result }
    );
  }
  return result;
}

function normalizeLanguage(value, field, { required = true } = {}) {
  const result = boundedText(value, field, 35, { required }).toLowerCase();
  if (result && !LANGUAGE_PATTERN.test(result)) {
    fail('INVALID_LANGUAGE', `${field} must be a BCP-47-style language tag.`, { field, value });
  }
  return result;
}

function normalizeLanguageList(value, field) {
  const rawLanguages = value === undefined || value === null
    ? ['und']
    : Array.isArray(value)
      ? value
      : [value];
  if (rawLanguages.length < 1 || rawLanguages.length > MAX_SOURCE_LANGUAGES) {
    fail(
      'INVALID_LANGUAGES',
      `${field} must include between 1 and ${MAX_SOURCE_LANGUAGES} language tags.`,
      { field }
    );
  }
  const languages = [...new Set(rawLanguages.map((language, index) =>
    normalizeLanguage(language, `${field} ${index + 1}`)
  ))].sort();
  if (languages.length === 0) {
    fail('INVALID_LANGUAGES', `${field} must include at least one language tag.`, { field });
  }
  return languages;
}

function normalizeLocalizedTextMap(value, field, { required = false, maximum = 300 } = {}) {
  if (value === undefined || value === null) value = {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail('INVALID_LOCALIZED_TEXT', `${field} must map language tags to text.`, { field });
  }
  const normalizedEntries = [];
  for (const [rawLanguage, rawText] of Object.entries(value)) {
    const language = normalizeLanguage(rawLanguage, `${field} language`);
    const text = boundedText(rawText, `${field}.${language}`, maximum, { required: true });
    normalizedEntries.push([language, text]);
  }
  normalizedEntries.sort(([left], [right]) => left.localeCompare(right));
  const result = Object.fromEntries(normalizedEntries);
  if (required && normalizedEntries.length === 0) {
    fail('MISSING_LOCALIZED_TEXT', `${field} must include at least one language.`, { field });
  }
  return result;
}

function normalizeDate(value, field, { required = false } = {}) {
  const result = boundedText(value, field, 10, { required });
  if (!result) return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(result);
  if (!match) fail('INVALID_DATE', `${field} must use YYYY-MM-DD.`, { field, value });
  const timestamp = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  const date = new Date(timestamp);
  if (
    date.getUTCFullYear() !== Number(match[1])
    || date.getUTCMonth() !== Number(match[2]) - 1
    || date.getUTCDate() !== Number(match[3])
  ) {
    fail('INVALID_DATE', `${field} must be a real calendar date.`, { field, value });
  }
  return result;
}

function normalizeTimestamp(value, field) {
  const result = boundedText(value, field, 40);
  if (!result) return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|([+-])(\d{2}):(\d{2}))$/.exec(result);
  if (!match) {
    fail('INVALID_TIMESTAMP', `${field} must be an ISO-8601 UTC timestamp.`, {
      field,
      value
    });
  }

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const milliseconds = Number((match[7] || '').padEnd(3, '0'));
  const offsetHours = match[8] === 'Z' ? 0 : Number(match[10]);
  const offsetMinutes = match[8] === 'Z' ? 0 : Number(match[11]);
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [
    31,
    leapYear ? 29 : 28,
    31,
    30,
    31,
    30,
    31,
    31,
    30,
    31,
    30,
    31
  ];
  if (
    month < 1
    || month > 12
    || day < 1
    || day > daysInMonth[month - 1]
    || hour > 23
    || minute > 59
    || second > 59
    || offsetHours > 23
    || offsetMinutes > 59
  ) {
    fail('INVALID_TIMESTAMP', `${field} must be an ISO-8601 UTC timestamp.`, {
      field,
      value
    });
  }

  const wallClock = new Date(0);
  wallClock.setUTCFullYear(year, month - 1, day);
  wallClock.setUTCHours(hour, minute, second, milliseconds);
  const signedOffsetMinutes = match[8] === 'Z'
    ? 0
    : (match[9] === '+' ? 1 : -1) * ((offsetHours * 60) + offsetMinutes);
  const intendedTimestamp = wallClock.getTime() - (signedOffsetMinutes * 60 * 1000);
  const parsedTimestamp = Date.parse(result);
  if (!Number.isFinite(parsedTimestamp) || parsedTimestamp !== intendedTimestamp) {
    fail('INVALID_TIMESTAMP', `${field} must be an ISO-8601 UTC timestamp.`, {
      field,
      value
    });
  }

  const canonical = new Date(parsedTimestamp).toISOString();
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(canonical)) {
    fail('INVALID_TIMESTAMP', `${field} must resolve to a four-digit UTC year.`, {
      field,
      value
    });
  }
  return canonical;
}

function normalizeSha256(value, field, { required = true } = {}) {
  const result = boundedText(value, field, 64, { required }).toLowerCase();
  if (result && !SHA256_PATTERN.test(result)) {
    fail('INVALID_SHA256', `${field} must be a lowercase SHA-256 digest.`, { field });
  }
  return result || null;
}

function normalizeNonNegativeInteger(value, field, { required = false } = {}) {
  if ((value === undefined || value === null) && !required) return null;
  if (!Number.isSafeInteger(value) || value < 0) {
    fail('INVALID_NUMBER', `${field} must be a non-negative integer.`, { field, value });
  }
  return value;
}

function normalizePositiveNumber(value, field) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    fail('INVALID_NUMBER', `${field} must be a positive number.`, { field, value });
  }
  return value;
}

function normalizeEnum(value, field, options, fallback) {
  const result = boundedText(value === undefined ? fallback : value, field, 50, { required: true });
  if (!options.has(result)) {
    fail('INVALID_ENUM', `${field} has an unsupported value.`, {
      field,
      value: result,
      options: [...options]
    });
  }
  return result;
}

function normalizeOptionalId(value, field) {
  if (value === undefined || value === null || value === '') return null;
  return normalizeId(value, field);
}

function ensureNoLocalPathFields(raw, field) {
  for (const key of ['path', 'filePath', 'localPath', 'absolutePath']) {
    if (raw && Object.prototype.hasOwnProperty.call(raw, key)) {
      fail(
        'LOCAL_PATH_NOT_ALLOWED',
        `${field} must not persist a machine-local path; use a content hash and file name.`,
        { field, key }
      );
    }
  }
}

function normalizeFileName(value, field, { required = true } = {}) {
  const result = boundedText(value, field, 255, { required });
  if (!result) return null;
  if (
    result === '.'
    || result === '..'
    || result.includes('/')
    || result.includes('\\')
    || /^[A-Za-z]:/.test(result)
  ) {
    fail('INVALID_FILE_NAME', `${field} must be a file name, not a path.`, { field, value });
  }
  return result;
}

function normalizeHttpUrl(value, field) {
  const result = boundedText(value, field, 2048);
  if (!result) return null;
  let parsed;
  try {
    parsed = new URL(result);
  } catch (_error) {
    fail('INVALID_URL', `${field} must be an HTTP or HTTPS URL.`, { field });
  }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) {
    fail('INVALID_URL', `${field} must be an HTTP or HTTPS URL without embedded credentials.`, {
      field
    });
  }
  return parsed.toString();
}

function normalizeSpeaker(raw) {
  if (typeof raw === 'string') raw = { name: raw };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    fail('INVALID_SPEAKER', 'Sermon speaker must contain a name.');
  }
  return {
    id: normalizeOptionalId(raw.id, 'Speaker id'),
    name: boundedText(raw.name, 'Speaker name', 200, { required: true })
  };
}

function normalizeSeries(raw) {
  if (raw === undefined || raw === null) return null;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    fail('INVALID_SERIES', 'Sermon series must be an object.');
  }
  return {
    id: normalizeOptionalId(raw.id, 'Series id'),
    titles: normalizeLocalizedTextMap(raw.titles, 'Series titles', { required: true })
  };
}

function normalizeOutline(rawOutline) {
  if (rawOutline === undefined || rawOutline === null) rawOutline = [];
  if (!Array.isArray(rawOutline)) fail('INVALID_OUTLINE', 'Sermon outline must be a list.');
  if (rawOutline.length > 500) fail('OUTLINE_TOO_LARGE', 'Sermon outline cannot exceed 500 sections.');

  const seen = new Set();
  const outline = rawOutline.map((raw, index) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      fail('INVALID_OUTLINE_SECTION', `Outline section ${index + 1} must be an object.`);
    }
    const id = normalizeId(raw.id, `Outline section ${index + 1} id`);
    if (seen.has(id)) fail('DUPLICATE_ID', `Outline section id “${id}” is repeated.`, { id });
    seen.add(id);
    const parentId = normalizeOptionalId(raw.parentId, `Outline section ${id} parentId`);
    return {
      id,
      parentId,
      kind: normalizeEnum(raw.kind, `Outline section ${id} kind`, OUTLINE_KINDS, 'point'),
      titles: normalizeLocalizedTextMap(raw.titles, `Outline section ${id} titles`, {
        required: true,
        maximum: 500
      })
    };
  });

  for (const section of outline) {
    if (section.parentId && !seen.has(section.parentId)) {
      fail('UNKNOWN_OUTLINE_PARENT', `Outline section “${section.id}” has an unknown parent.`, {
        id: section.id,
        parentId: section.parentId
      });
    }
    const visited = new Set([section.id]);
    let parentId = section.parentId;
    while (parentId) {
      if (visited.has(parentId)) {
        fail('OUTLINE_CYCLE', `Outline section “${section.id}” is in a parent cycle.`, {
          id: section.id
        });
      }
      visited.add(parentId);
      parentId = outline.find(candidate => candidate.id === parentId)?.parentId || null;
    }
  }
  return outline;
}

function normalizeSource(raw, index, schemaVersion) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    fail('INVALID_SOURCE', `Sermon source ${index + 1} must be an object.`);
  }
  ensureNoLocalPathFields(raw, `Sermon source ${index + 1}`);
  const id = normalizeId(raw.id, `Sermon source ${index + 1} id`);
  const provenance = raw.provenance === undefined || raw.provenance === null
    ? {}
    : raw.provenance;
  if (!provenance || typeof provenance !== 'object' || Array.isArray(provenance)) {
    fail('INVALID_PROVENANCE', `Sermon source “${id}” provenance must be an object.`);
  }
  ensureNoLocalPathFields(provenance, `Sermon source “${id}” provenance`);
  const normalized = {
    id,
    kind: normalizeEnum(raw.kind, `Sermon source “${id}” kind`, SOURCE_KINDS, 'other'),
    fileName: normalizeFileName(raw.fileName, `Sermon source “${id}” fileName`),
    mediaType: boundedText(raw.mediaType, `Sermon source “${id}” mediaType`, 200, { required: true }),
    sha256: normalizeSha256(raw.sha256, `Sermon source “${id}” sha256`),
    sizeBytes: normalizeNonNegativeInteger(
      raw.sizeBytes,
      `Sermon source “${id}” sizeBytes`,
      { required: true }
    ),
    provenance: {
      providedBy: boundedText(
        provenance.providedBy,
        `Sermon source “${id}” provenance providedBy`,
        200
      ),
      receivedAt: normalizeTimestamp(
        provenance.receivedAt,
        `Sermon source “${id}” provenance receivedAt`
      ),
      sourceSystem: boundedText(
        provenance.sourceSystem,
        `Sermon source “${id}” provenance sourceSystem`,
        100
      ),
      externalId: boundedText(
        provenance.externalId,
        `Sermon source “${id}” provenance externalId`,
        300
      )
    }
  };
  if (schemaVersion === 1) {
    normalized.language = normalizeLanguage(
      raw.language || 'und',
      `Sermon source “${id}” language`
    );
  } else {
    normalized.languages = normalizeLanguageList(
      raw.languages ?? raw.language ?? 'und',
      `Sermon source “${id}” languages`
    );
  }
  return normalized;
}

function normalizeReference(raw, index, sourceIds, outlineIds) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    fail('INVALID_REFERENCE', `Sermon reference ${index + 1} must be an object.`);
  }
  const id = normalizeId(raw.id, `Sermon reference ${index + 1} id`);
  const sourceId = normalizeOptionalId(raw.sourceId, `Sermon reference “${id}” sourceId`);
  const sectionId = normalizeOptionalId(raw.sectionId, `Sermon reference “${id}” sectionId`);
  if (sourceId && !sourceIds.has(sourceId)) {
    fail('UNKNOWN_SOURCE', `Sermon reference “${id}” links to an unknown source.`, {
      id,
      sourceId
    });
  }
  if (sectionId && !outlineIds.has(sectionId)) {
    fail('UNKNOWN_OUTLINE_SECTION', `Sermon reference “${id}” links to an unknown outline section.`, {
      id,
      sectionId
    });
  }

  const startOffset = normalizeNonNegativeInteger(
    raw.startOffset,
    `Sermon reference “${id}” startOffset`
  );
  const endOffset = normalizeNonNegativeInteger(
    raw.endOffset,
    `Sermon reference “${id}” endOffset`
  );
  if ((startOffset === null) !== (endOffset === null) || (startOffset !== null && endOffset < startOffset)) {
    fail(
      'INVALID_SOURCE_OFFSETS',
      `Sermon reference “${id}” offsets must be a complete, ordered pair.`,
      { id, startOffset, endOffset }
    );
  }
  const enteredText = boundedText(
    raw.enteredText !== undefined ? raw.enteredText : raw.displayText,
    `Sermon reference “${id}” enteredText`,
    300
  );
  if (
    raw.enteredText !== undefined
    && raw.displayText !== undefined
    && enteredText !== boundedText(
      raw.displayText,
      `Sermon reference “${id}” displayText`,
      300
    )
  ) {
    fail(
      'CONFLICTING_ENTERED_TEXT',
      `Sermon reference “${id}” defines enteredText and displayText differently.`,
      { id }
    );
  }

  return {
    id,
    range: normalizeBibleRange(raw.range),
    role: normalizeEnum(raw.role, `Sermon reference “${id}” role`, REFERENCE_ROLES, 'mentioned'),
    source: normalizeEnum(
      raw.source,
      `Sermon reference “${id}” source`,
      REFERENCE_SOURCES,
      'operator'
    ),
    reviewStatus: normalizeEnum(
      raw.reviewStatus,
      `Sermon reference “${id}” reviewStatus`,
      REVIEW_STATUSES,
      'suggested'
    ),
    enteredText,
    sourceId,
    sectionId,
    startOffset,
    endOffset
  };
}

function normalizeMedia(raw, index) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    fail('INVALID_MEDIA', `Sermon media ${index + 1} must be an object.`);
  }
  ensureNoLocalPathFields(raw, `Sermon media ${index + 1}`);
  const id = normalizeId(raw.id, `Sermon media ${index + 1} id`);
  const sha256 = normalizeSha256(raw.sha256, `Sermon media “${id}” sha256`, { required: false });
  const fileName = normalizeFileName(
    raw.fileName,
    `Sermon media “${id}” fileName`,
    { required: false }
  );
  const url = normalizeHttpUrl(raw.url, `Sermon media “${id}” url`);
  if (!sha256 && !url) {
    fail('MISSING_MEDIA_LOCATION', `Sermon media “${id}” needs a content hash or URL.`, { id });
  }
  return {
    id,
    kind: normalizeEnum(raw.kind, `Sermon media “${id}” kind`, MEDIA_KINDS, 'audio'),
    status: normalizeEnum(raw.status, `Sermon media “${id}” status`, MEDIA_STATUSES, 'pending'),
    title: boundedText(raw.title, `Sermon media “${id}” title`, 300),
    language: normalizeLanguage(raw.language || 'und', `Sermon media “${id}” language`),
    mediaType: boundedText(raw.mediaType, `Sermon media “${id}” mediaType`, 200),
    fileName,
    sha256,
    sizeBytes: normalizeNonNegativeInteger(raw.sizeBytes, `Sermon media “${id}” sizeBytes`),
    durationSeconds: normalizePositiveNumber(
      raw.durationSeconds,
      `Sermon media “${id}” durationSeconds`
    ),
    url
  };
}

function normalizePublication(raw) {
  if (raw === undefined || raw === null) raw = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    fail('INVALID_PUBLICATION', 'Sermon publication metadata must be an object.');
  }
  const status = normalizeEnum(raw.status, 'Publication status', PUBLICATION_STATUSES, 'draft');
  const visibility = normalizeEnum(raw.visibility, 'Publication visibility', VISIBILITIES, 'private');
  const publishedAt = normalizeTimestamp(raw.publishedAt, 'Publication publishedAt');
  if (status === 'published' && !publishedAt) {
    fail('MISSING_PUBLICATION_TIMESTAMP', 'Published sermons need an explicit publishedAt timestamp.');
  }
  return {
    status,
    visibility,
    publishedAt,
    canonicalUrl: normalizeHttpUrl(raw.canonicalUrl, 'Publication canonicalUrl')
  };
}

function normalizeBodyText(value, field) {
  if (typeof value !== 'string') {
    fail('INVALID_BODY_TEXT', `${field} must be text.`, { field });
  }
  const result = value.replace(/\r\n?/g, '\n').normalize('NFC');
  if (!result.trim()) {
    fail('MISSING_BODY_TEXT', `${field} is required.`, { field });
  }
  let hasUnpairedSurrogate = false;
  for (const character of result) {
    const codePoint = character.codePointAt(0);
    if (codePoint >= 0xd800 && codePoint <= 0xdfff) {
      hasUnpairedSurrogate = true;
      break;
    }
  }
  if (
    hasUnpairedSurrogate
    || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u.test(result)
  ) {
    fail(
      'UNSAFE_BODY_TEXT',
      `${field} contains an unsupported Unicode code unit or control character.`,
      { field }
    );
  }
  const sizeBytes = Buffer.byteLength(result, 'utf8');
  if (sizeBytes > MAX_SERMON_BODY_ENTRY_BYTES) {
    fail(
      'BODY_ENTRY_TOO_LARGE',
      `${field} must be ${MAX_SERMON_BODY_ENTRY_BYTES} UTF-8 bytes or fewer.`,
      { field, maximumBytes: MAX_SERMON_BODY_ENTRY_BYTES, sizeBytes }
    );
  }
  return result;
}

function normalizeSermonBody(rawBody, sourcesById, outlineIds) {
  if (rawBody === undefined || rawBody === null) rawBody = [];
  if (!Array.isArray(rawBody)) {
    fail('INVALID_BODY', 'Sermon body must be an ordered list.');
  }
  if (rawBody.length > MAX_SERMON_BODY_ENTRIES) {
    fail(
      'BODY_TOO_LARGE',
      `Sermon body cannot exceed ${MAX_SERMON_BODY_ENTRIES} entries.`,
      { maximum: MAX_SERMON_BODY_ENTRIES }
    );
  }

  const seen = new Set();
  let totalBytes = 0;
  return rawBody.map((raw, index) => {
    const field = `Sermon body entry ${index + 1}`;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      fail('INVALID_BODY_ENTRY', `${field} must be an object.`, { field });
    }
    const expectedKeys = new Set([
      'id',
      'kind',
      'language',
      'sourceId',
      'sectionId',
      'text'
    ]);
    const actualKeys = Object.keys(raw);
    if (
      actualKeys.length !== expectedKeys.size
      || actualKeys.some(key => !expectedKeys.has(key))
    ) {
      fail(
        'INVALID_BODY_ENTRY',
        `${field} has unsupported or missing fields.`,
        { field }
      );
    }

    const id = normalizeId(raw.id, `${field} id`);
    if (seen.has(id)) {
      fail('DUPLICATE_ID', `Sermon body entry id “${id}” is repeated.`, { id });
    }
    seen.add(id);
    const sourceId = normalizeOptionalId(raw.sourceId, `Sermon body entry “${id}” sourceId`);
    const sectionId = normalizeOptionalId(
      raw.sectionId,
      `Sermon body entry “${id}” sectionId`
    );
    const source = sourceId ? sourcesById.get(sourceId) : null;
    if (sourceId && !source) {
      fail('UNKNOWN_SOURCE', `Sermon body entry “${id}” links to an unknown source.`, {
        id,
        sourceId
      });
    }
    if (sectionId && !outlineIds.has(sectionId)) {
      fail(
        'UNKNOWN_OUTLINE_SECTION',
        `Sermon body entry “${id}” links to an unknown outline section.`,
        { id, sectionId }
      );
    }
    const kind = normalizeEnum(
      raw.kind,
      `Sermon body entry “${id}” kind`,
      BODY_KINDS,
      'other'
    );
    if (source && kind !== source.kind) {
      fail(
        'BODY_SOURCE_KIND_MISMATCH',
        `Sermon body entry “${id}” kind must match its linked sermon source.`,
        {
          id,
          sourceId,
          bodyKind: kind,
          sourceKind: source.kind
        }
      );
    }
    const text = normalizeBodyText(raw.text, `Sermon body entry “${id}” text`);
    totalBytes += Buffer.byteLength(text, 'utf8');
    if (totalBytes > MAX_SERMON_BODY_BYTES) {
      fail(
        'BODY_TOO_LARGE',
        `Sermon body must be ${MAX_SERMON_BODY_BYTES} UTF-8 bytes or fewer.`,
        { maximumBytes: MAX_SERMON_BODY_BYTES, sizeBytes: totalBytes }
      );
    }
    return {
      id,
      kind,
      language: normalizeLanguage(raw.language, `Sermon body entry “${id}” language`),
      sourceId,
      sectionId,
      text
    };
  });
}

function uniqueById(items, kind) {
  const seen = new Set();
  for (const item of items) {
    if (seen.has(item.id)) fail('DUPLICATE_ID', `${kind} id “${item.id}” is repeated.`, { id: item.id });
    seen.add(item.id);
  }
  return seen;
}

function normalizeSermonDocument(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    fail('INVALID_SERMON', 'Sermon document must be an object.');
  }
  if (!SUPPORTED_SERMON_SCHEMA_VERSIONS.has(raw.schemaVersion)) {
    fail(
      'UNSUPPORTED_SERMON_SCHEMA',
      `Sermon schema version ${raw.schemaVersion} is not supported.`,
      { actual: raw.schemaVersion, supported: [...SUPPORTED_SERMON_SCHEMA_VERSIONS] }
    );
  }
  if (raw.kind !== undefined && raw.kind !== SERMON_KIND) {
    fail('INVALID_SERMON_KIND', `Sermon kind must be “${SERMON_KIND}”.`, { actual: raw.kind });
  }

  const titles = normalizeLocalizedTextMap(raw.titles, 'Sermon titles', { required: true });
  const defaultLanguage = normalizeLanguage(
    raw.defaultLanguage || Object.keys(titles)[0],
    'Sermon defaultLanguage'
  );
  if (!Object.prototype.hasOwnProperty.call(titles, defaultLanguage)) {
    fail(
      'MISSING_DEFAULT_TITLE',
      `Sermon titles must include the default language “${defaultLanguage}”.`,
      { defaultLanguage }
    );
  }

  const outline = normalizeOutline(raw.outline);
  const outlineIds = uniqueById(outline, 'Outline section');
  const rawSources = raw.sources === undefined || raw.sources === null ? [] : raw.sources;
  if (!Array.isArray(rawSources)) fail('INVALID_SOURCES', 'Sermon sources must be a list.');
  const sources = rawSources.map((source, index) => normalizeSource(
    source,
    index,
    raw.schemaVersion
  ));
  const sourceIds = uniqueById(sources, 'Sermon source');
  const sourcesById = new Map(sources.map(source => [source.id, source]));
  const rawReferences = raw.references === undefined || raw.references === null ? [] : raw.references;
  if (!Array.isArray(rawReferences)) fail('INVALID_REFERENCES', 'Sermon references must be a list.');
  const references = rawReferences.map((reference, index) => (
    normalizeReference(reference, index, sourceIds, outlineIds)
  ));
  uniqueById(references, 'Sermon reference');
  const rawMedia = raw.media === undefined || raw.media === null ? [] : raw.media;
  if (!Array.isArray(rawMedia)) fail('INVALID_MEDIA', 'Sermon media must be a list.');
  const media = rawMedia.map(normalizeMedia);
  uniqueById(media, 'Sermon media');
  const publication = normalizePublication(raw.publication);
  if (raw.schemaVersion < 3 && raw.body !== undefined) {
    fail(
      'BODY_REQUIRES_SCHEMA_V3',
      'Sermon body entries require sermon schema version 3.',
      { schemaVersion: raw.schemaVersion }
    );
  }
  const body = raw.schemaVersion === 3
    ? normalizeSermonBody(raw.body, sourcesById, outlineIds)
    : null;

  if (
    ['ready', 'published'].includes(publication.status)
    && !references.some(reference => reference.role === 'primary' && reference.reviewStatus === 'confirmed')
  ) {
    fail(
      'MISSING_CONFIRMED_PRIMARY_REFERENCE',
      'Ready and published sermons need at least one confirmed primary passage.'
    );
  }

  const normalized = {
    schemaVersion: raw.schemaVersion,
    kind: SERMON_KIND,
    id: normalizeId(raw.id, 'Sermon id'),
    titles,
    defaultLanguage,
    speaker: normalizeSpeaker(raw.speaker),
    serviceDate: normalizeDate(raw.serviceDate, 'Sermon serviceDate', { required: true }),
    series: normalizeSeries(raw.series),
    outline,
    sources,
    references,
    media,
    publication
  };
  if (raw.schemaVersion === 3) normalized.body = body;
  const serializedBytes = Buffer.byteLength(`${canonicalJson(normalized)}\n`, 'utf8');
  if (serializedBytes > MAX_SERMON_SOURCE_BYTES) {
    fail(
      'SERMON_SOURCE_TOO_LARGE',
      `Sermon documents must be ${MAX_SERMON_SOURCE_BYTES / 1024} KB or smaller.`,
      { maximumBytes: MAX_SERMON_SOURCE_BYTES, sizeBytes: serializedBytes }
    );
  }
  return deepFreeze(normalized);
}

function upgradeSermonDocumentV1ToV3(raw) {
  const document = normalizeSermonDocument(raw);
  if (document.schemaVersion !== 1) {
    fail(
      'INVALID_UPGRADE_SOURCE',
      'The v1-to-v3 upgrade requires a schema version 1 sermon.',
      { actual: document.schemaVersion }
    );
  }
  return normalizeSermonDocument({
    ...document,
    schemaVersion: SERMON_SCHEMA_VERSION,
    sources: document.sources.map(source => {
      const { language, ...rest } = source;
      return {
        ...rest,
        languages: [language || 'und']
      };
    }),
    body: []
  });
}

function upgradeSermonDocumentV2ToV3(raw) {
  const document = normalizeSermonDocument(raw);
  if (document.schemaVersion !== 2) {
    fail(
      'INVALID_UPGRADE_SOURCE',
      'The v2-to-v3 upgrade requires a schema version 2 sermon.',
      { actual: document.schemaVersion }
    );
  }
  return normalizeSermonDocument({
    ...document,
    schemaVersion: SERMON_SCHEMA_VERSION,
    body: []
  });
}

function upgradeSermonDocument(raw) {
  const document = normalizeSermonDocument(raw);
  if (document.schemaVersion === SERMON_SCHEMA_VERSION) return document;
  if (document.schemaVersion === 1) return upgradeSermonDocumentV1ToV3(document);
  return upgradeSermonDocumentV2ToV3(document);
}

function serializeSermonDocument(raw) {
  const serialized = `${canonicalJson(normalizeSermonDocument(raw))}\n`;
  if (Buffer.byteLength(serialized, 'utf8') > MAX_SERMON_SOURCE_BYTES) {
    fail(
      'SERMON_SOURCE_TOO_LARGE',
      `Sermon documents must be ${MAX_SERMON_SOURCE_BYTES / 1024} KB or smaller.`
    );
  }
  return serialized;
}

function parseSermonDocument(source) {
  if (typeof source !== 'string' && !Buffer.isBuffer(source)) {
    fail('INVALID_SERMON_SOURCE', 'Sermon source must be JSON text.');
  }
  if (Buffer.byteLength(source) > MAX_SERMON_SOURCE_BYTES) {
    fail('SERMON_SOURCE_TOO_LARGE', 'Sermon source is too large.');
  }
  let raw;
  try {
    raw = JSON.parse(utf8Text(source));
  } catch (_error) {
    fail('INVALID_SERMON_JSON', 'Sermon source is not valid JSON.');
  }
  return normalizeSermonDocument(raw);
}

function sermonDocumentSha256(raw) {
  return crypto.createHash('sha256').update(serializeSermonDocument(raw)).digest('hex');
}

function createSermonRevision(raw) {
  const document = normalizeSermonDocument(raw);
  const source = serializeSermonDocument(document);
  const sha256 = crypto.createHash('sha256').update(source).digest('hex');
  return deepFreeze({
    id: `sha256:${sha256}`,
    sha256,
    source,
    document
  });
}

function isPubliclyIndexable(document) {
  return document.publication.status === 'published'
    && document.publication.visibility === 'public';
}

function passageIndexEntry(document, revision, reference) {
  return {
    sermonId: document.id,
    sermonRevision: revision.sha256,
    title: document.titles[document.defaultLanguage],
    serviceDate: document.serviceDate,
    referenceId: reference.id,
    role: reference.role,
    range: reference.range
  };
}

function compareIndexEntries(left, right) {
  return compareBibleRanges(left.range, right.range)
    || (left.role === right.role ? 0 : left.role === 'primary' ? -1 : 1)
    || right.serviceDate.localeCompare(left.serviceDate)
    || left.sermonId.localeCompare(right.sermonId)
    || left.referenceId.localeCompare(right.referenceId);
}

function buildSermonPassageIndex(rawDocuments, { publicOnly = true } = {}) {
  if (!Array.isArray(rawDocuments)) {
    fail('INVALID_SERMON_LIST', 'Sermon passage index input must be a list.');
  }
  const entries = [];
  const sermonIds = new Set();
  for (const rawDocument of rawDocuments) {
    const revision = createSermonRevision(rawDocument);
    const document = revision.document;
    if (sermonIds.has(document.id)) {
      fail('DUPLICATE_SERMON', `Sermon id “${document.id}” appears more than once in the index.`, {
        id: document.id
      });
    }
    sermonIds.add(document.id);
    if (publicOnly && !isPubliclyIndexable(document)) continue;
    for (const reference of document.references) {
      // Extraction is advisory. A suggestion cannot affect a public passage
      // count or create an "Appears in sermons" link until a person confirms it.
      if (reference.reviewStatus !== 'confirmed') continue;
      entries.push(passageIndexEntry(document, revision, reference));
    }
  }
  entries.sort(compareIndexEntries);
  return deepFreeze({
    schemaVersion: SERMON_PASSAGE_INDEX_SCHEMA_VERSION,
    kind: SERMON_PASSAGE_INDEX_KIND,
    publicOnly: Boolean(publicOnly),
    entries
  });
}

function normalizePassageIndex(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    fail('INVALID_PASSAGE_INDEX', 'Sermon passage index must be an object.');
  }
  if (
    raw.schemaVersion !== SERMON_PASSAGE_INDEX_SCHEMA_VERSION
    || raw.kind !== SERMON_PASSAGE_INDEX_KIND
    || !Array.isArray(raw.entries)
  ) {
    fail('INVALID_PASSAGE_INDEX', 'Sermon passage index has an unsupported shape.');
  }
  const entries = raw.entries.map((entry, index) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      fail('INVALID_PASSAGE_INDEX', `Passage index entry ${index + 1} must be an object.`);
    }
    return {
      sermonId: normalizeId(entry.sermonId, `Passage index entry ${index + 1} sermonId`),
      sermonRevision: normalizeSha256(
        entry.sermonRevision,
        `Passage index entry ${index + 1} sermonRevision`
      ),
      title: boundedText(entry.title, `Passage index entry ${index + 1} title`, 300, {
        required: true
      }),
      serviceDate: normalizeDate(
        entry.serviceDate,
        `Passage index entry ${index + 1} serviceDate`,
        { required: true }
      ),
      referenceId: normalizeId(
        entry.referenceId,
        `Passage index entry ${index + 1} referenceId`
      ),
      role: normalizeEnum(
        entry.role,
        `Passage index entry ${index + 1} role`,
        REFERENCE_ROLES
      ),
      range: normalizeBibleRange(entry.range)
    };
  });
  entries.sort(compareIndexEntries);
  return deepFreeze({
    schemaVersion: SERMON_PASSAGE_INDEX_SCHEMA_VERSION,
    kind: SERMON_PASSAGE_INDEX_KIND,
    publicOnly: Boolean(raw.publicOnly),
    entries
  });
}

function serializeSermonPassageIndex(raw) {
  return `${canonicalJson(normalizePassageIndex(raw))}\n`;
}

function querySermonsForPassage(rawIndex, rawPassage) {
  const index = normalizePassageIndex(rawIndex);
  const passage = normalizeBibleRange(rawPassage);
  const grouped = {
    primary: new Map(),
    mentioned: new Map()
  };
  for (const entry of index.entries) {
    if (!bibleRangesIntersect(entry.range, passage)) continue;
    let result = grouped[entry.role].get(entry.sermonId);
    if (!result) {
      result = {
        sermonId: entry.sermonId,
        sermonRevision: entry.sermonRevision,
        title: entry.title,
        serviceDate: entry.serviceDate,
        references: []
      };
      grouped[entry.role].set(entry.sermonId, result);
    }
    result.references.push({
      referenceId: entry.referenceId,
      range: entry.range
    });
  }
  // A sermon whose primary passage contains the query is "on this passage,"
  // not an additional "appears in" hit. Keep the roles distinct without
  // allowing a secondary citation in that same sermon to inflate the count.
  for (const sermonId of grouped.primary.keys()) grouped.mentioned.delete(sermonId);
  const resultSort = (left, right) => (
    right.serviceDate.localeCompare(left.serviceDate)
    || left.sermonId.localeCompare(right.sermonId)
  );
  return deepFreeze({
    primary: [...grouped.primary.values()].sort(resultSort),
    mentioned: [...grouped.mentioned.values()].sort(resultSort)
  });
}

module.exports = {
  MAX_SERMON_BODY_BYTES,
  MAX_SERMON_BODY_ENTRIES,
  MAX_SERMON_BODY_ENTRY_BYTES,
  MAX_SERMON_REFERENCES,
  MAX_SERMON_SOURCE_BYTES,
  SERMON_KIND,
  SERMON_PASSAGE_INDEX_KIND,
  SERMON_PASSAGE_INDEX_SCHEMA_VERSION,
  SERMON_SCHEMA_VERSION,
  SermonDocumentError,
  buildSermonPassageIndex,
  createSermonRevision,
  normalizeSermonDocument,
  parseSermonDocument,
  querySermonsForPassage,
  serializeSermonDocument,
  serializeSermonPassageIndex,
  sermonDocumentSha256,
  upgradeSermonDocument,
  upgradeSermonDocumentV1ToV3,
  upgradeSermonDocumentV2ToV3
};
