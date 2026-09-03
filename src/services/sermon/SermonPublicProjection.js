'use strict';

const crypto = require('crypto');
const { isIP } = require('node:net');

const {
  bibleRangesIntersect,
  compareBibleRanges,
  normalizeBibleRange
} = require('./BibleRange');
const {
  MAX_SERMON_BODY_BYTES,
  MAX_SERMON_BODY_ENTRIES,
  MAX_SERMON_BODY_ENTRY_BYTES,
  MAX_SERMON_REFERENCES,
  MAX_SERMON_SOURCE_BYTES,
  parseSermonDocument,
  serializeSermonDocument
} = require('./SermonDocument');

// This module is a pure compatibility contract. Calling it does not authorize
// publication or move a Community publicRevision pointer. A Heritage server
// must invoke it only inside its separately authenticated publication
// transaction and must store the exact returned bytes/checksum atomically with
// that pointer.
const SERMON_PUBLIC_DETAIL_SCHEMA_VERSION = 1;
const SERMON_PUBLIC_DETAIL_KIND = 'heritage-public-sermon';
const SERMON_PUBLIC_CATALOG_SCHEMA_VERSION = 2;
const SERMON_PUBLIC_CATALOG_CONTENT_TYPE = 'sermons';
const SERMON_PUBLIC_PASSAGE_INDEX_SCHEMA_VERSION = 1;
const SERMON_PUBLIC_PASSAGE_INDEX_KIND = 'heritage-public-sermon-passage-index';
const SERMON_PUBLIC_MEDIA_TYPE = 'application/vnd.heritage.sermon+json';
// The strict, explicitly approved publication lane must never overlap the
// legacy generic sermon catalog. Heritage readers only discover this path
// through the positive public-sermon publication descriptor.
const SERMON_PUBLIC_CATALOG_PATH = '/publications/sermons/catalog.json';
const SERMON_PUBLIC_CONTENT_BASE_PATH = '/content/sermons';
const SERMON_PUBLIC_PASSAGE_INDEX_PATH = '/indexes/sermon-passages';

const MAX_PUBLIC_SERMON_DETAIL_BYTES = 2 * 1024 * 1024;
const MAX_PUBLIC_SERMON_CATALOG_BYTES = 16 * 1024 * 1024;
const MAX_PUBLIC_SERMON_PASSAGE_INDEX_BYTES = 32 * 1024 * 1024;
const MAX_PUBLIC_SERMON_CATALOG_ITEMS = 10000;
const MAX_PUBLIC_SERMON_REFERENCES = MAX_SERMON_REFERENCES;
const MAX_PUBLIC_SERMON_INDEX_REFERENCES = 100000;
const MAX_PUBLIC_SERMON_MEDIA = 256;
const MAX_PUBLIC_SERMON_LANGUAGES = 32;

const SERMON_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const PUBLIC_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,95}$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const LANGUAGE_PATTERN = /^[a-z]{2,3}(?:-[a-z0-9]{2,8})*$/;
const BODY_KINDS = new Set(['manuscript', 'slide-notes', 'transcript', 'other']);
const MEDIA_KINDS = new Set(['audio', 'video', 'transcript', 'document']);
const REFERENCE_ROLES = new Set(['primary', 'mentioned']);
const NONPUBLIC_HOST_SUFFIXES = Object.freeze([
  '.arpa',
  '.example',
  '.home',
  '.internal',
  '.invalid',
  '.lan',
  '.local',
  '.localhost',
  '.onion',
  '.test'
]);

class SermonPublicProjectionError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'SermonPublicProjectionError';
    this.code = code;
    this.details = details;
  }
}

function fail(code, message, details = {}) {
  throw new SermonPublicProjectionError(code, message, details);
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

function sha256(source) {
  return crypto.createHash('sha256').update(source, 'utf8').digest('hex');
}

function isPlainRecord(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertRecord(value, label, code = 'INVALID_PUBLIC_PROJECTION') {
  if (!isPlainRecord(value)) fail(code, `${label} must be a plain object.`);
}

function assertExactKeys(value, keys, label, code = 'INVALID_PUBLIC_PROJECTION') {
  assertRecord(value, label, code);
  const expected = new Set(keys);
  for (const key of keys) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) {
      fail(code, `${label} is missing ${key}.`, { field: key });
    }
  }
  for (const key of Object.keys(value)) {
    if (!expected.has(key)) {
      fail(code, `${label} contains an unsupported field.`, { field: key });
    }
  }
}

function hasUnpairedSurrogate(value) {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint >= 0xd800 && codePoint <= 0xdfff) return true;
  }
  return false;
}

function boundedText(value, label, maximumBytes, {
  required = false,
  preserveWhitespace = false
} = {}) {
  if (typeof value !== 'string') {
    fail('INVALID_PUBLIC_TEXT', `${label} must be text.`, { field: label });
  }
  const normalized = (preserveWhitespace
    ? value.replace(/\r\n?/g, '\n')
    : value.trim()).normalize('NFC');
  if (required && !normalized.trim()) {
    fail('MISSING_PUBLIC_TEXT', `${label} is required.`, { field: label });
  }
  const unsafeControls = preserveWhitespace
    ? /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u
    : /[\u0000-\u001f\u007f-\u009f]/u;
  if (hasUnpairedSurrogate(normalized) || unsafeControls.test(normalized)) {
    fail('UNSAFE_PUBLIC_TEXT', `${label} contains unsupported text characters.`, {
      field: label
    });
  }
  const sizeBytes = Buffer.byteLength(normalized, 'utf8');
  if (sizeBytes > maximumBytes) {
    fail('PUBLIC_TEXT_TOO_LARGE', `${label} is too large.`, {
      field: label,
      maximumBytes,
      sizeBytes
    });
  }
  return normalized;
}

function normalizeSermonId(value, label = 'Public sermon ID') {
  const normalized = boundedText(value, label, 128, { required: true });
  if (!SERMON_ID_PATTERN.test(normalized)) {
    fail('INVALID_PUBLIC_SERMON_ID', `${label} is invalid.`);
  }
  return normalized;
}

function normalizePublicId(value, label = 'Public content ID') {
  const normalized = boundedText(value, label, 96, { required: true });
  if (!PUBLIC_ID_PATTERN.test(normalized)) {
    fail('INVALID_PUBLIC_CONTENT_ID', `${label} is invalid.`);
  }
  return normalized;
}

function normalizeSha256(value, label) {
  const normalized = boundedText(value, label, 64, { required: true });
  if (!SHA256_PATTERN.test(normalized)) {
    fail('INVALID_PUBLIC_CHECKSUM', `${label} must be a lowercase SHA-256 digest.`);
  }
  return normalized;
}

function normalizeLanguage(value, label) {
  const normalized = boundedText(value, label, 35, { required: true }).toLowerCase();
  if (!LANGUAGE_PATTERN.test(normalized)) {
    fail('INVALID_PUBLIC_LANGUAGE', `${label} must be a BCP-47-style language tag.`);
  }
  return normalized;
}

function normalizeLocalizedText(value, label, { required = true } = {}) {
  assertRecord(value, label);
  const entries = Object.entries(value);
  if (entries.length > MAX_PUBLIC_SERMON_LANGUAGES) {
    fail(
      'PUBLIC_LOCALIZATIONS_TOO_LARGE',
      `${label} may contain at most ${MAX_PUBLIC_SERMON_LANGUAGES} languages.`
    );
  }
  const normalized = new Map();
  for (const [rawLanguage, rawText] of entries) {
    const language = normalizeLanguage(rawLanguage, `${label} language`);
    if (normalized.has(language)) {
      fail('DUPLICATE_PUBLIC_LANGUAGE', `${label} repeats language “${language}”.`);
    }
    normalized.set(
      language,
      boundedText(rawText, `${label}.${language}`, 1200, { required: true })
    );
  }
  if (required && normalized.size === 0) {
    fail('MISSING_PUBLIC_LOCALIZATION', `${label} needs at least one language.`);
  }
  return Object.fromEntries([...normalized].sort(([left], [right]) =>
    left < right ? -1 : left > right ? 1 : 0));
}

function normalizeDate(value, label) {
  const normalized = boundedText(value, label, 10, { required: true });
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(normalized);
  if (!match) fail('INVALID_PUBLIC_DATE', `${label} must use YYYY-MM-DD.`);
  const timestamp = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  const date = new Date(timestamp);
  if (
    date.getUTCFullYear() !== Number(match[1])
    || date.getUTCMonth() !== Number(match[2]) - 1
    || date.getUTCDate() !== Number(match[3])
  ) {
    fail('INVALID_PUBLIC_DATE', `${label} must be a real calendar date.`);
  }
  return normalized;
}

function normalizePositiveNumber(value, label) {
  if (value === null) return null;
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    fail('INVALID_PUBLIC_NUMBER', `${label} must be a positive finite number or null.`);
  }
  return value;
}

function normalizeStrictHttpsUrl(value, label, { nullable = false } = {}) {
  if (value === null && nullable) return null;
  const normalized = boundedText(value, label, 8192, { required: true });
  if (normalized.includes('\\')) {
    fail('INVALID_PUBLIC_URL', `${label} must be a normal HTTPS URL.`);
  }
  let parsed;
  try {
    parsed = new URL(normalized);
  } catch (_error) {
    fail('INVALID_PUBLIC_URL', `${label} must be a complete HTTPS URL.`);
  }
  if (
    parsed.protocol !== 'https:'
    || !parsed.hostname
    || parsed.username
    || parsed.password
    || parsed.hash
  ) {
    fail(
      'INVALID_PUBLIC_URL',
      `${label} must use HTTPS without credentials or a fragment.`
    );
  }
  return parsed.toString();
}

function normalizeStablePublicHttpsUrl(
  value,
  label,
  { maximumCharacters = 8192 } = {}
) {
  const normalized = normalizeStrictHttpsUrl(value, label);
  const parsed = new URL(normalized);
  const canonical = parsed.toString();
  const hostname = parsed.hostname
    .replace(/^\[/, '')
    .replace(/\]$/, '')
    .toLowerCase();
  if (
    parsed.search
    || parsed.port
    || canonical.length > maximumCharacters
    || hostname.endsWith('.')
    || !hostname.includes('.')
    || isIP(hostname) !== 0
    || hostname === 'localhost'
    || NONPUBLIC_HOST_SUFFIXES.some(suffix => hostname.endsWith(suffix))
  ) {
    fail(
      'INVALID_PUBLIC_URL',
      `${label} must be a stable public HTTPS URL without credentials, a query string, fragment, private host, or nonstandard port.`
    );
  }
  return canonical;
}

function deriveSermonPublicId(rawSermonId) {
  const sermonId = normalizeSermonId(rawSermonId);
  return `sermon-${sha256(sermonId)}`;
}

function normalizeStrictBibleRange(raw, label) {
  assertExactKeys(raw, ['schemaVersion', 'bookId', 'start', 'end'], label);
  assertExactKeys(raw.start, ['chapter', 'verse'], `${label}.start`);
  assertExactKeys(raw.end, ['chapter', 'verse'], `${label}.end`);
  let normalized;
  try {
    normalized = normalizeBibleRange(raw);
  } catch (error) {
    fail('INVALID_PUBLIC_BIBLE_RANGE', `${label} is invalid.`, {
      causeCode: error?.code || null
    });
  }
  if (canonicalJson(raw) !== canonicalJson(normalized)) {
    fail('NONCANONICAL_PUBLIC_BIBLE_RANGE', `${label} must use the exact canonical range shape.`);
  }
  return normalized;
}

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function compareReferences(left, right) {
  return compareBibleRanges(left.range, right.range)
    || (left.role === right.role ? 0 : left.role === 'primary' ? -1 : 1);
}

function normalizePublicReferences(value, label = 'Public sermon references') {
  if (!Array.isArray(value) || value.length > MAX_PUBLIC_SERMON_REFERENCES) {
    fail(
      'PUBLIC_REFERENCES_TOO_LARGE',
      `${label} must contain at most ${MAX_PUBLIC_SERMON_REFERENCES} references.`
    );
  }
  const seen = new Set();
  let hasPrimary = false;
  const references = value.map((raw, index) => {
    const itemLabel = `${label} ${index + 1}`;
    assertExactKeys(raw, ['role', 'range'], itemLabel);
    const role = boundedText(raw.role, `${itemLabel}.role`, 16, { required: true });
    if (!REFERENCE_ROLES.has(role)) {
      fail('INVALID_PUBLIC_REFERENCE_ROLE', `${itemLabel}.role is invalid.`);
    }
    const range = normalizeStrictBibleRange(raw.range, `${itemLabel}.range`);
    const key = `${role}:${canonicalJson(range)}`;
    if (seen.has(key)) {
      fail('DUPLICATE_PUBLIC_REFERENCE', `${label} repeats the same role and range.`);
    }
    seen.add(key);
    if (role === 'primary') hasPrimary = true;
    return { role, range };
  });
  if (!hasPrimary) {
    fail('MISSING_PUBLIC_PRIMARY_REFERENCE', 'A public sermon needs a confirmed primary passage.');
  }
  references.sort(compareReferences);
  return references;
}

function normalizePublicBody(value) {
  if (!Array.isArray(value) || value.length > MAX_SERMON_BODY_ENTRIES) {
    fail(
      'PUBLIC_BODY_TOO_LARGE',
      `Public sermon body may contain at most ${MAX_SERMON_BODY_ENTRIES} entries.`
    );
  }
  let totalBytes = 0;
  return value.map((raw, index) => {
    const label = `Public sermon body entry ${index + 1}`;
    assertExactKeys(raw, ['kind', 'language', 'text'], label);
    const kind = boundedText(raw.kind, `${label}.kind`, 32, { required: true });
    if (!BODY_KINDS.has(kind)) fail('INVALID_PUBLIC_BODY_KIND', `${label}.kind is invalid.`);
    const text = boundedText(raw.text, `${label}.text`, MAX_SERMON_BODY_ENTRY_BYTES, {
      required: true,
      preserveWhitespace: true
    });
    totalBytes += Buffer.byteLength(text, 'utf8');
    if (totalBytes > MAX_SERMON_BODY_BYTES) {
      fail(
        'PUBLIC_BODY_TOO_LARGE',
        `Public sermon body must be ${MAX_SERMON_BODY_BYTES} UTF-8 bytes or fewer.`
      );
    }
    return {
      kind,
      language: normalizeLanguage(raw.language, `${label}.language`),
      text
    };
  });
}

function normalizePublicMedia(value) {
  if (!Array.isArray(value) || value.length > MAX_PUBLIC_SERMON_MEDIA) {
    fail(
      'PUBLIC_MEDIA_TOO_LARGE',
      `Public sermon media may contain at most ${MAX_PUBLIC_SERMON_MEDIA} entries.`
    );
  }
  return value.map((raw, index) => {
    const label = `Public sermon media ${index + 1}`;
    assertExactKeys(
      raw,
      ['kind', 'title', 'language', 'mediaType', 'durationSeconds', 'url'],
      label
    );
    const kind = boundedText(raw.kind, `${label}.kind`, 32, { required: true });
    if (!MEDIA_KINDS.has(kind)) fail('INVALID_PUBLIC_MEDIA_KIND', `${label}.kind is invalid.`);
    return {
      kind,
      title: boundedText(raw.title, `${label}.title`, 1200),
      language: normalizeLanguage(raw.language, `${label}.language`),
      mediaType: boundedText(raw.mediaType, `${label}.mediaType`, 800),
      durationSeconds: normalizePositiveNumber(raw.durationSeconds, `${label}.durationSeconds`),
      url: normalizeStablePublicHttpsUrl(
        raw.url,
        `${label}.url`,
        { maximumCharacters: 2048 }
      )
    };
  });
}

function normalizePublicSeries(value) {
  if (value === null) return null;
  assertExactKeys(value, ['titles'], 'Public sermon series');
  return {
    titles: normalizeLocalizedText(value.titles, 'Public sermon series titles')
  };
}

function normalizePublicSpeaker(value) {
  assertExactKeys(value, ['name'], 'Public sermon speaker');
  return {
    name: boundedText(value.name, 'Public sermon speaker name', 800, { required: true })
  };
}

function publicDetailValue(raw) {
  assertExactKeys(raw, [
    'schemaVersion',
    'kind',
    'publicId',
    'sermonId',
    'sermonRevision',
    'titles',
    'defaultLanguage',
    'speaker',
    'serviceDate',
    'series',
    'references',
    'body',
    'media',
    'canonicalUrl'
  ], 'Public sermon detail');
  if (
    raw.schemaVersion !== SERMON_PUBLIC_DETAIL_SCHEMA_VERSION
    || raw.kind !== SERMON_PUBLIC_DETAIL_KIND
  ) {
    fail('UNSUPPORTED_PUBLIC_DETAIL', 'Public sermon detail uses an unsupported schema.');
  }

  const sermonId = normalizeSermonId(raw.sermonId);
  const publicId = normalizePublicId(raw.publicId);
  if (publicId !== deriveSermonPublicId(sermonId)) {
    fail(
      'PUBLIC_ID_MISMATCH',
      'Public sermon content ID does not match its stable sermon identity.'
    );
  }
  const titles = normalizeLocalizedText(raw.titles, 'Public sermon titles');
  const defaultLanguage = normalizeLanguage(raw.defaultLanguage, 'Public sermon default language');
  if (!Object.prototype.hasOwnProperty.call(titles, defaultLanguage)) {
    fail(
      'MISSING_PUBLIC_DEFAULT_TITLE',
      'Public sermon titles do not include the default language.'
    );
  }

  return {
    schemaVersion: SERMON_PUBLIC_DETAIL_SCHEMA_VERSION,
    kind: SERMON_PUBLIC_DETAIL_KIND,
    publicId,
    sermonId,
    sermonRevision: normalizeSha256(raw.sermonRevision, 'Public sermon revision'),
    titles,
    defaultLanguage,
    speaker: normalizePublicSpeaker(raw.speaker),
    serviceDate: normalizeDate(raw.serviceDate, 'Public sermon service date'),
    series: normalizePublicSeries(raw.series),
    references: normalizePublicReferences(raw.references),
    body: normalizePublicBody(raw.body),
    media: normalizePublicMedia(raw.media),
    canonicalUrl: normalizeStrictHttpsUrl(
      raw.canonicalUrl,
      'Public sermon canonical URL',
      { nullable: true }
    )
  };
}

function normalizeSermonPublicDetail(raw) {
  const normalized = publicDetailValue(raw);
  const sizeBytes = Buffer.byteLength(`${canonicalJson(normalized)}\n`, 'utf8');
  if (sizeBytes > MAX_PUBLIC_SERMON_DETAIL_BYTES) {
    fail(
      'PUBLIC_DETAIL_TOO_LARGE',
      `Public sermon detail must be ${MAX_PUBLIC_SERMON_DETAIL_BYTES} bytes or fewer.`,
      { maximumBytes: MAX_PUBLIC_SERMON_DETAIL_BYTES, sizeBytes }
    );
  }
  return deepFreeze(normalized);
}

function serializeSermonPublicDetail(raw) {
  return `${canonicalJson(normalizeSermonPublicDetail(raw))}\n`;
}

function parseCanonicalSource(source, {
  label,
  maximumBytes,
  parse,
  serialize,
  invalidCode,
  noncanonicalCode
}) {
  if (typeof source !== 'string' || Buffer.byteLength(source, 'utf8') > maximumBytes) {
    fail(invalidCode, `${label} is invalid or too large.`);
  }
  let parsed;
  try {
    parsed = JSON.parse(source);
  } catch (_error) {
    fail(invalidCode, `${label} is not valid JSON.`);
  }
  let normalized;
  try {
    normalized = parse(parsed);
  } catch (error) {
    if (error instanceof SermonPublicProjectionError) throw error;
    fail(invalidCode, `${label} is invalid.`, { causeCode: error?.code || null });
  }
  if (serialize(normalized) !== source) {
    fail(
      noncanonicalCode,
      `${label} must be the exact canonical serialization, including its trailing newline.`
    );
  }
  return normalized;
}

function parseSermonPublicDetail(source) {
  return parseCanonicalSource(source, {
    label: 'Public sermon detail source',
    maximumBytes: MAX_PUBLIC_SERMON_DETAIL_BYTES,
    parse: normalizeSermonPublicDetail,
    serialize: serializeSermonPublicDetail,
    invalidCode: 'INVALID_PUBLIC_DETAIL_SOURCE',
    noncanonicalCode: 'NONCANONICAL_PUBLIC_DETAIL_SOURCE'
  });
}

function sermonPublicDetailSha256(raw) {
  return sha256(serializeSermonPublicDetail(raw));
}

function selectionIds(value, label, maximum) {
  if (!Array.isArray(value) || value.length > maximum) {
    fail('INVALID_PUBLIC_SELECTION', `${label} must contain at most ${maximum} IDs.`);
  }
  const ids = new Set();
  for (const rawId of value) {
    const id = normalizeSermonId(rawId, `${label} ID`);
    if (ids.has(id)) fail('DUPLICATE_PUBLIC_SELECTION', `${label} repeats ID “${id}”.`);
    ids.add(id);
  }
  return ids;
}

function inspectCanonicalSermonSource(documentSource, publicRevision) {
  if (
    typeof documentSource !== 'string'
    || Buffer.byteLength(documentSource, 'utf8') > MAX_SERMON_SOURCE_BYTES
  ) {
    fail('INVALID_PUBLIC_SERMON_SOURCE', 'Public sermon input is invalid or too large.');
  }
  let document;
  try {
    document = parseSermonDocument(documentSource);
  } catch (error) {
    fail('INVALID_PUBLIC_SERMON_SOURCE', 'Public sermon input is not a valid sermon document.', {
      causeCode: error?.code || null
    });
  }
  if (serializeSermonDocument(document) !== documentSource) {
    fail(
      'NONCANONICAL_PUBLIC_SERMON_SOURCE',
      'Public sermon input must be the exact canonical sermon serialization.'
    );
  }
  const revision = sha256(documentSource);
  const expectedRevision = normalizeSha256(publicRevision, 'Public revision');
  if (revision !== expectedRevision) {
    fail(
      'PUBLIC_REVISION_MISMATCH',
      'The selected public revision does not match the exact sermon source.'
    );
  }
  if (
    document.publication.status !== 'published'
    || document.publication.visibility !== 'public'
  ) {
    fail(
      'SERMON_NOT_PUBLICLY_ELIGIBLE',
      'Only an exact published, public sermon revision can produce an anonymous projection.'
    );
  }
  return { document, revision };
}

function projectSelectedBody(document, selectedIds) {
  const body = document.body || [];
  const known = new Set(body.map(entry => entry.id));
  for (const id of selectedIds) {
    if (!known.has(id)) {
      fail('UNKNOWN_PUBLIC_BODY_SELECTION', `Selected public body entry “${id}” does not exist.`);
    }
  }
  return body
    .filter(entry => selectedIds.has(entry.id))
    .map(entry => ({
      kind: entry.kind,
      language: entry.language,
      text: entry.text
    }));
}

function projectSelectedMedia(document, selectedIds) {
  const known = new Map(document.media.map(media => [media.id, media]));
  for (const id of selectedIds) {
    const media = known.get(id);
    if (!media) {
      fail('UNKNOWN_PUBLIC_MEDIA_SELECTION', `Selected public media “${id}” does not exist.`);
    }
    if (media.status !== 'ready' || !media.url) {
      fail(
        'PUBLIC_MEDIA_NOT_READY',
        `Selected public media “${id}” is not ready at a public URL.`
      );
    }
    try {
      normalizeStablePublicHttpsUrl(
        media.url,
        `Selected public media “${id}” URL`,
        { maximumCharacters: 2048 }
      );
    } catch (error) {
      if (error instanceof SermonPublicProjectionError) {
        fail(
          'PUBLIC_MEDIA_NOT_READY',
          `Selected public media “${id}” is not ready at a safe HTTPS URL.`,
          { causeCode: error.code }
        );
      }
      throw error;
    }
  }
  return document.media
    .filter(media => selectedIds.has(media.id))
    .map(media => ({
      kind: media.kind,
      title: media.title,
      language: media.language,
      mediaType: media.mediaType,
      durationSeconds: media.durationSeconds,
      url: media.url
    }));
}

function standardContentUrl(publicId) {
  return `${SERMON_PUBLIC_CONTENT_BASE_PATH}/${normalizePublicId(publicId)}`;
}

function catalogItemFromDetail(rawDetail, rawChecksum) {
  const detail = normalizeSermonPublicDetail(rawDetail);
  const checksum = normalizeSha256(rawChecksum, 'Public sermon detail checksum');
  return {
    id: detail.publicId,
    sermonId: detail.sermonId,
    sermonRevision: detail.sermonRevision,
    checksum,
    title: detail.titles[detail.defaultLanguage],
    titles: detail.titles,
    defaultLanguage: detail.defaultLanguage,
    speaker: detail.speaker,
    serviceDate: detail.serviceDate,
    series: detail.series,
    references: detail.references,
    content: {
      url: standardContentUrl(detail.publicId),
      mediaType: SERMON_PUBLIC_MEDIA_TYPE
    }
  };
}

function buildSermonPublicProjection(options = {}) {
  assertExactKeys(options, [
    'documentSource',
    'publicRevision',
    'selectedBodyEntryIds',
    'selectedMediaIds'
  ], 'Public sermon projection request', 'INVALID_PUBLIC_PROJECTION_REQUEST');
  const { document, revision } = inspectCanonicalSermonSource(
    options.documentSource,
    options.publicRevision
  );
  const bodySelection = selectionIds(
    options.selectedBodyEntryIds,
    'Selected public body entries',
    MAX_SERMON_BODY_ENTRIES
  );
  const mediaSelection = selectionIds(
    options.selectedMediaIds,
    'Selected public media',
    MAX_PUBLIC_SERMON_MEDIA
  );
  const canonicalUrl = document.publication.canonicalUrl
    ? normalizeStrictHttpsUrl(
        document.publication.canonicalUrl,
        'Public sermon canonical URL'
      )
    : null;
  const references = document.references
    .filter(reference => reference.reviewStatus === 'confirmed')
    .map(reference => ({ role: reference.role, range: reference.range }));
  const detail = normalizeSermonPublicDetail({
    schemaVersion: SERMON_PUBLIC_DETAIL_SCHEMA_VERSION,
    kind: SERMON_PUBLIC_DETAIL_KIND,
    publicId: deriveSermonPublicId(document.id),
    sermonId: document.id,
    sermonRevision: revision,
    titles: document.titles,
    defaultLanguage: document.defaultLanguage,
    speaker: { name: document.speaker.name },
    serviceDate: document.serviceDate,
    series: document.series ? { titles: document.series.titles } : null,
    references,
    body: projectSelectedBody(document, bodySelection),
    media: projectSelectedMedia(document, mediaSelection),
    canonicalUrl
  });
  const detailSource = serializeSermonPublicDetail(detail);
  const checksum = sha256(detailSource);
  return deepFreeze({
    detail,
    detailSource,
    checksum,
    catalogItem: catalogItemFromDetail(detail, checksum)
  });
}

function normalizeCatalogContent(raw, publicId) {
  assertExactKeys(raw, ['url', 'mediaType'], 'Public sermon catalog content');
  const url = boundedText(raw.url, 'Public sermon catalog content URL', 256, {
    required: true
  });
  if (url !== standardContentUrl(publicId)) {
    fail(
      'PUBLIC_CONTENT_URL_MISMATCH',
      'Public sermon catalog content URL does not match its deterministic content ID.'
    );
  }
  if (raw.mediaType !== SERMON_PUBLIC_MEDIA_TYPE) {
    fail('INVALID_PUBLIC_MEDIA_TYPE', 'Public sermon catalog media type is unsupported.');
  }
  return { url, mediaType: SERMON_PUBLIC_MEDIA_TYPE };
}

function normalizeCatalogItem(raw, index) {
  const label = `Public sermon catalog item ${index + 1}`;
  assertExactKeys(raw, [
    'id',
    'sermonId',
    'sermonRevision',
    'checksum',
    'title',
    'titles',
    'defaultLanguage',
    'speaker',
    'serviceDate',
    'series',
    'references',
    'content'
  ], label);
  const sermonId = normalizeSermonId(raw.sermonId, `${label}.sermonId`);
  const id = normalizePublicId(raw.id, `${label}.id`);
  if (id !== deriveSermonPublicId(sermonId)) {
    fail('PUBLIC_ID_MISMATCH', `${label}.id does not match its stable sermon identity.`);
  }
  const titles = normalizeLocalizedText(raw.titles, `${label}.titles`);
  const defaultLanguage = normalizeLanguage(raw.defaultLanguage, `${label}.defaultLanguage`);
  if (!Object.prototype.hasOwnProperty.call(titles, defaultLanguage)) {
    fail('MISSING_PUBLIC_DEFAULT_TITLE', `${label} has no default-language title.`);
  }
  const title = boundedText(raw.title, `${label}.title`, 1200, { required: true });
  if (title !== titles[defaultLanguage]) {
    fail('PUBLIC_TITLE_MISMATCH', `${label}.title does not match its default-language title.`);
  }
  return {
    id,
    sermonId,
    sermonRevision: normalizeSha256(raw.sermonRevision, `${label}.sermonRevision`),
    checksum: normalizeSha256(raw.checksum, `${label}.checksum`),
    title,
    titles,
    defaultLanguage,
    speaker: normalizePublicSpeaker(raw.speaker),
    serviceDate: normalizeDate(raw.serviceDate, `${label}.serviceDate`),
    series: normalizePublicSeries(raw.series),
    references: normalizePublicReferences(raw.references, `${label}.references`),
    content: normalizeCatalogContent(raw.content, id)
  };
}

function compareCatalogItems(left, right) {
  return right.serviceDate.localeCompare(left.serviceDate)
    || compareText(left.id, right.id);
}

function catalogValue(raw) {
  assertExactKeys(
    raw,
    ['schemaVersion', 'contentType', 'items'],
    'Public sermon catalog'
  );
  if (
    raw.schemaVersion !== SERMON_PUBLIC_CATALOG_SCHEMA_VERSION
    || raw.contentType !== SERMON_PUBLIC_CATALOG_CONTENT_TYPE
  ) {
    fail('UNSUPPORTED_PUBLIC_CATALOG', 'Public sermon catalog uses an unsupported schema.');
  }
  if (!Array.isArray(raw.items) || raw.items.length > MAX_PUBLIC_SERMON_CATALOG_ITEMS) {
    fail(
      'PUBLIC_CATALOG_TOO_LARGE',
      `Public sermon catalog may contain at most ${MAX_PUBLIC_SERMON_CATALOG_ITEMS} items.`
    );
  }
  const publicIds = new Set();
  const sermons = new Map();
  const items = raw.items.map(normalizeCatalogItem);
  for (const item of items) {
    const priorRevision = sermons.get(item.sermonId);
    if (priorRevision) {
      if (priorRevision !== item.sermonRevision) {
        fail(
          'MIXED_PUBLIC_SERMON_REVISIONS',
          `Public sermon catalog contains multiple revisions for “${item.sermonId}”.`
        );
      }
      fail(
        'DUPLICATE_PUBLIC_SERMON',
        `Public sermon catalog repeats sermon “${item.sermonId}”.`
      );
    }
    if (publicIds.has(item.id)) {
      fail('DUPLICATE_PUBLIC_CONTENT_ID', `Public sermon catalog repeats ID “${item.id}”.`);
    }
    publicIds.add(item.id);
    sermons.set(item.sermonId, item.sermonRevision);
  }
  items.sort(compareCatalogItems);
  return {
    schemaVersion: SERMON_PUBLIC_CATALOG_SCHEMA_VERSION,
    contentType: SERMON_PUBLIC_CATALOG_CONTENT_TYPE,
    items
  };
}

function normalizeSermonPublicCatalog(raw) {
  const normalized = catalogValue(raw);
  const sizeBytes = Buffer.byteLength(`${canonicalJson(normalized)}\n`, 'utf8');
  if (sizeBytes > MAX_PUBLIC_SERMON_CATALOG_BYTES) {
    fail(
      'PUBLIC_CATALOG_TOO_LARGE',
      `Public sermon catalog must be ${MAX_PUBLIC_SERMON_CATALOG_BYTES} bytes or fewer.`,
      { maximumBytes: MAX_PUBLIC_SERMON_CATALOG_BYTES, sizeBytes }
    );
  }
  return deepFreeze(normalized);
}

function serializeSermonPublicCatalog(raw) {
  return `${canonicalJson(normalizeSermonPublicCatalog(raw))}\n`;
}

function parseSermonPublicCatalog(source) {
  return parseCanonicalSource(source, {
    label: 'Public sermon catalog source',
    maximumBytes: MAX_PUBLIC_SERMON_CATALOG_BYTES,
    parse: normalizeSermonPublicCatalog,
    serialize: serializeSermonPublicCatalog,
    invalidCode: 'INVALID_PUBLIC_CATALOG_SOURCE',
    noncanonicalCode: 'NONCANONICAL_PUBLIC_CATALOG_SOURCE'
  });
}

function normalizePublicationRecord(raw, index) {
  const label = `Public sermon publication ${index + 1}`;
  assertExactKeys(raw, ['detailSource', 'checksum'], label);
  const detail = parseSermonPublicDetail(raw.detailSource);
  const checksum = normalizeSha256(raw.checksum, `${label}.checksum`);
  const actualChecksum = sha256(raw.detailSource);
  if (checksum !== actualChecksum) {
    fail(
      'PUBLIC_DETAIL_CHECKSUM_MISMATCH',
      `${label} checksum does not match its exact detail bytes.`
    );
  }
  return { detail, detailSource: raw.detailSource, checksum };
}

function normalizePublicationRecords(value) {
  if (!Array.isArray(value) || value.length > MAX_PUBLIC_SERMON_CATALOG_ITEMS) {
    fail(
      'PUBLIC_CATALOG_TOO_LARGE',
      `Public sermon publications may contain at most ${MAX_PUBLIC_SERMON_CATALOG_ITEMS} records.`
    );
  }
  return value.map(normalizePublicationRecord);
}

function buildSermonPublicCatalog(rawPublications) {
  const publications = normalizePublicationRecords(rawPublications);
  return normalizeSermonPublicCatalog({
    schemaVersion: SERMON_PUBLIC_CATALOG_SCHEMA_VERSION,
    contentType: SERMON_PUBLIC_CATALOG_CONTENT_TYPE,
    items: publications.map(publication =>
      catalogItemFromDetail(publication.detail, publication.checksum))
  });
}

function publicCatalogAndDetails(rawCatalog, rawPublications) {
  const catalog = normalizeSermonPublicCatalog(rawCatalog);
  const publications = normalizePublicationRecords(rawPublications);
  const publicationsById = new Map();
  for (const publication of publications) {
    const publicId = publication.detail.publicId;
    if (publicationsById.has(publicId)) {
      fail(
        'DUPLICATE_PUBLIC_CONTENT_ID',
        `Public sermon publications repeat ID “${publicId}”.`
      );
    }
    publicationsById.set(publicId, publication);
  }
  if (publicationsById.size !== catalog.items.length) {
    fail(
      'PUBLIC_CATALOG_DETAIL_MISMATCH',
      'Public sermon catalog and detail set contain different numbers of sermons.'
    );
  }
  const ordered = [];
  for (const item of catalog.items) {
    const publication = publicationsById.get(item.id);
    if (!publication) {
      fail(
        'PUBLIC_CATALOG_DETAIL_MISMATCH',
        `Public sermon catalog item “${item.id}” has no exact detail source.`
      );
    }
    if (item.checksum !== publication.checksum) {
      fail(
        'PUBLIC_DETAIL_CHECKSUM_MISMATCH',
        `Public sermon catalog item “${item.id}” does not match its detail checksum.`
      );
    }
    if (item.sermonRevision !== publication.detail.sermonRevision) {
      fail(
        'PUBLIC_DETAIL_REVISION_MISMATCH',
        `Public sermon catalog item “${item.id}” does not match its detail revision.`
      );
    }
    const expected = normalizeCatalogItem(
      catalogItemFromDetail(publication.detail, publication.checksum),
      0
    );
    if (canonicalJson(item) !== canonicalJson(expected)) {
      fail(
        'PUBLIC_CATALOG_DETAIL_MISMATCH',
        `Public sermon catalog item “${item.id}” differs from its exact detail source.`
      );
    }
    ordered.push({ item, publication });
    publicationsById.delete(item.id);
  }
  if (publicationsById.size > 0) {
    fail(
      'PUBLIC_CATALOG_DETAIL_MISMATCH',
      'Public sermon details contain an item absent from the catalog.'
    );
  }
  return { catalog, ordered };
}

function verifySermonPublicDetailForCatalogItem(rawItem, detailSource) {
  const item = normalizeCatalogItem(rawItem, 0);
  const publication = normalizePublicationRecord({
    detailSource,
    checksum: item.checksum
  }, 0);
  if (item.sermonRevision !== publication.detail.sermonRevision) {
    fail(
      'PUBLIC_DETAIL_REVISION_MISMATCH',
      `Public sermon catalog item “${item.id}” does not match its detail revision.`
    );
  }
  const expected = normalizeCatalogItem(
    catalogItemFromDetail(publication.detail, publication.checksum),
    0
  );
  if (canonicalJson(item) !== canonicalJson(expected)) {
    fail(
      'PUBLIC_CATALOG_DETAIL_MISMATCH',
      `Public sermon catalog item “${item.id}” differs from its exact detail source.`
    );
  }
  return publication.detail;
}

function normalizeIndexItem(raw, index) {
  const label = `Public sermon passage-index item ${index + 1}`;
  assertExactKeys(raw, [
    'publicId',
    'sermonId',
    'sermonRevision',
    'checksum',
    'title',
    'speaker',
    'serviceDate',
    'contentUrl',
    'references'
  ], label);
  const sermonId = normalizeSermonId(raw.sermonId, `${label}.sermonId`);
  const publicId = normalizePublicId(raw.publicId, `${label}.publicId`);
  if (publicId !== deriveSermonPublicId(sermonId)) {
    fail('PUBLIC_ID_MISMATCH', `${label}.publicId does not match its stable sermon identity.`);
  }
  const contentUrl = boundedText(raw.contentUrl, `${label}.contentUrl`, 256, {
    required: true
  });
  if (contentUrl !== standardContentUrl(publicId)) {
    fail('PUBLIC_CONTENT_URL_MISMATCH', `${label}.contentUrl is not deterministic.`);
  }
  return {
    publicId,
    sermonId,
    sermonRevision: normalizeSha256(raw.sermonRevision, `${label}.sermonRevision`),
    checksum: normalizeSha256(raw.checksum, `${label}.checksum`),
    title: boundedText(raw.title, `${label}.title`, 1200, { required: true }),
    speaker: normalizePublicSpeaker(raw.speaker),
    serviceDate: normalizeDate(raw.serviceDate, `${label}.serviceDate`),
    contentUrl,
    references: normalizePublicReferences(raw.references, `${label}.references`)
  };
}

function indexValue(raw) {
  assertExactKeys(raw, ['schemaVersion', 'kind', 'items'], 'Public sermon passage index');
  if (
    raw.schemaVersion !== SERMON_PUBLIC_PASSAGE_INDEX_SCHEMA_VERSION
    || raw.kind !== SERMON_PUBLIC_PASSAGE_INDEX_KIND
  ) {
    fail('UNSUPPORTED_PUBLIC_PASSAGE_INDEX', 'Public sermon passage index uses an unsupported schema.');
  }
  if (!Array.isArray(raw.items) || raw.items.length > MAX_PUBLIC_SERMON_CATALOG_ITEMS) {
    fail(
      'PUBLIC_PASSAGE_INDEX_TOO_LARGE',
      `Public sermon passage index may contain at most ${MAX_PUBLIC_SERMON_CATALOG_ITEMS} sermons.`
    );
  }
  const publicIds = new Set();
  const sermons = new Map();
  let referenceCount = 0;
  const items = raw.items.map(normalizeIndexItem);
  for (const item of items) {
    const priorRevision = sermons.get(item.sermonId);
    if (priorRevision) {
      if (priorRevision !== item.sermonRevision) {
        fail(
          'MIXED_PUBLIC_SERMON_REVISIONS',
          `Public sermon passage index contains multiple revisions for “${item.sermonId}”.`
        );
      }
      fail(
        'DUPLICATE_PUBLIC_SERMON',
        `Public sermon passage index repeats sermon “${item.sermonId}”.`
      );
    }
    if (publicIds.has(item.publicId)) {
      fail(
        'DUPLICATE_PUBLIC_CONTENT_ID',
        `Public sermon passage index repeats ID “${item.publicId}”.`
      );
    }
    publicIds.add(item.publicId);
    sermons.set(item.sermonId, item.sermonRevision);
    referenceCount += item.references.length;
    if (referenceCount > MAX_PUBLIC_SERMON_INDEX_REFERENCES) {
      fail(
        'PUBLIC_PASSAGE_INDEX_TOO_LARGE',
        `Public sermon passage index may contain at most ${MAX_PUBLIC_SERMON_INDEX_REFERENCES} references.`
      );
    }
  }
  items.sort((left, right) =>
    right.serviceDate.localeCompare(left.serviceDate)
      || compareText(left.publicId, right.publicId));
  return {
    schemaVersion: SERMON_PUBLIC_PASSAGE_INDEX_SCHEMA_VERSION,
    kind: SERMON_PUBLIC_PASSAGE_INDEX_KIND,
    items
  };
}

function normalizeSermonPublicPassageIndex(raw) {
  const normalized = indexValue(raw);
  const sizeBytes = Buffer.byteLength(`${canonicalJson(normalized)}\n`, 'utf8');
  if (sizeBytes > MAX_PUBLIC_SERMON_PASSAGE_INDEX_BYTES) {
    fail(
      'PUBLIC_PASSAGE_INDEX_TOO_LARGE',
      `Public sermon passage index must be ${MAX_PUBLIC_SERMON_PASSAGE_INDEX_BYTES} bytes or fewer.`,
      { maximumBytes: MAX_PUBLIC_SERMON_PASSAGE_INDEX_BYTES, sizeBytes }
    );
  }
  return deepFreeze(normalized);
}

function serializeSermonPublicPassageIndex(raw) {
  return `${canonicalJson(normalizeSermonPublicPassageIndex(raw))}\n`;
}

function parseSermonPublicPassageIndex(source) {
  return parseCanonicalSource(source, {
    label: 'Public sermon passage-index source',
    maximumBytes: MAX_PUBLIC_SERMON_PASSAGE_INDEX_BYTES,
    parse: normalizeSermonPublicPassageIndex,
    serialize: serializeSermonPublicPassageIndex,
    invalidCode: 'INVALID_PUBLIC_PASSAGE_INDEX_SOURCE',
    noncanonicalCode: 'NONCANONICAL_PUBLIC_PASSAGE_INDEX_SOURCE'
  });
}

function buildSermonPublicPassageIndex(rawCatalog, rawPublications = undefined) {
  // A reader can build the passage index directly from the bounded catalog
  // without downloading every detail. A publishing transaction should also
  // pass its exact detail set so checksum/revision/display drift is rejected
  // before catalog and range rows are committed together.
  const catalog = rawPublications === undefined
    ? normalizeSermonPublicCatalog(rawCatalog)
    : publicCatalogAndDetails(rawCatalog, rawPublications).catalog;
  return normalizeSermonPublicPassageIndex({
    schemaVersion: SERMON_PUBLIC_PASSAGE_INDEX_SCHEMA_VERSION,
    kind: SERMON_PUBLIC_PASSAGE_INDEX_KIND,
    items: catalog.items.map(item => ({
      publicId: item.id,
      sermonId: item.sermonId,
      sermonRevision: item.sermonRevision,
      checksum: item.checksum,
      title: item.title,
      speaker: item.speaker,
      serviceDate: item.serviceDate,
      contentUrl: item.content.url,
      references: item.references
    }))
  });
}

function querySermonPublicPassageIndex(rawIndex, rawRange) {
  const index = normalizeSermonPublicPassageIndex(rawIndex);
  let range;
  try {
    range = normalizeBibleRange(rawRange);
  } catch (error) {
    fail('INVALID_PUBLIC_PASSAGE_QUERY', 'Public sermon passage query is invalid.', {
      causeCode: error?.code || null
    });
  }
  const primary = [];
  const mentioned = [];
  for (const item of index.items) {
    const primaryMatches = [];
    const mentionedMatches = [];
    for (const reference of item.references) {
      if (!bibleRangesIntersect(reference.range, range)) continue;
      (reference.role === 'primary' ? primaryMatches : mentionedMatches).push(reference.range);
    }
    const matches = primaryMatches.length > 0 ? primaryMatches : mentionedMatches;
    if (matches.length === 0) continue;
    const result = {
      publicId: item.publicId,
      sermonId: item.sermonId,
      sermonRevision: item.sermonRevision,
      checksum: item.checksum,
      title: item.title,
      speaker: item.speaker,
      serviceDate: item.serviceDate,
      contentUrl: item.contentUrl,
      matches
    };
    (primaryMatches.length > 0 ? primary : mentioned).push(result);
  }
  const resultSort = (left, right) =>
    right.serviceDate.localeCompare(left.serviceDate)
      || compareText(left.publicId, right.publicId);
  primary.sort(resultSort);
  mentioned.sort(resultSort);
  return deepFreeze({ primary, mentioned });
}

module.exports = {
  MAX_PUBLIC_SERMON_CATALOG_BYTES,
  MAX_PUBLIC_SERMON_CATALOG_ITEMS,
  MAX_PUBLIC_SERMON_DETAIL_BYTES,
  MAX_PUBLIC_SERMON_INDEX_REFERENCES,
  MAX_PUBLIC_SERMON_MEDIA,
  MAX_PUBLIC_SERMON_PASSAGE_INDEX_BYTES,
  MAX_PUBLIC_SERMON_REFERENCES,
  SERMON_PUBLIC_CATALOG_CONTENT_TYPE,
  SERMON_PUBLIC_CATALOG_PATH,
  SERMON_PUBLIC_CATALOG_SCHEMA_VERSION,
  SERMON_PUBLIC_CONTENT_BASE_PATH,
  SERMON_PUBLIC_DETAIL_KIND,
  SERMON_PUBLIC_DETAIL_SCHEMA_VERSION,
  SERMON_PUBLIC_MEDIA_TYPE,
  SERMON_PUBLIC_PASSAGE_INDEX_KIND,
  SERMON_PUBLIC_PASSAGE_INDEX_PATH,
  SERMON_PUBLIC_PASSAGE_INDEX_SCHEMA_VERSION,
  SermonPublicProjectionError,
  buildSermonPublicCatalog,
  buildSermonPublicPassageIndex,
  buildSermonPublicProjection,
  deriveSermonPublicId,
  normalizeSermonPublicCatalog,
  normalizeSermonPublicDetail,
  normalizeSermonPublicPassageIndex,
  normalizeStablePublicHttpsUrl,
  parseSermonPublicCatalog,
  parseSermonPublicDetail,
  parseSermonPublicPassageIndex,
  querySermonPublicPassageIndex,
  serializeSermonPublicCatalog,
  serializeSermonPublicDetail,
  serializeSermonPublicPassageIndex,
  sermonPublicDetailSha256,
  verifySermonPublicDetailForCatalogItem
};
