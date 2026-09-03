'use strict';

const crypto = require('crypto');
const { TextDecoder } = require('util');
const JSZip = require('jszip');

const {
  SOURCE_TYPES,
  validateSourceBuffer
} = require('./LocalSermonSourceStore');
const { CANONICAL_BIBLE_BOOKS } = require('./BibleRange');
const {
  DEFAULT_SERMON_EMPHASIS_COLORS,
  MAX_PPTX_TEXT_SPANS,
  PptxStyledTextError,
  extractStyledTextFromSlideXml,
  normalizeStyledText
} = require('./PptxStyledText');
const { openPdf } = require('../pdf/PdfEngine');

const SERMON_SOURCE_EXTRACTION_LEGACY_SCHEMA_VERSION = 1;
const SERMON_SOURCE_EXTRACTION_SCHEMA_VERSION = 2;
const SERMON_SOURCE_EXTRACTION_KIND = 'syncshow-sermon-source-extraction-proposal';
const SERMON_SOURCE_EXTRACTOR_ID = 'syncshow-deterministic-source-extractor';
const SERMON_SOURCE_EXTRACTOR_VERSION = 3;

const MAX_EXTRACTION_UNITS = 256;
const MAX_UNIT_TEXT_CHARS = 32_000;
const MAX_TOTAL_TEXT_CHARS = 512_000;
const MAX_TEXT_PREVIEW_CHARS = 8_000;
const MAX_OUTLINE_SUGGESTIONS = 128;
const MAX_REFERENCE_SUGGESTIONS = 256;
const MAX_SOURCE_UNIT_LINKS = 32;
const MAX_OUTLINE_TITLE_CHARS = 500;
const MAX_XML_PART_BYTES = 16 * 1024 * 1024;
const MAX_OOXML_ENTRIES = 10_000;
const DOCUMENT_CHUNK_TARGET_CHARS = 12_000;
const PPTX_SERMON_LEAD_UNITS = 4;
const PPTX_MAX_HEADING_GAP_UNITS = 12;

const SOURCE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const LANGUAGE_PATTERN = /^[a-z]{2,3}(?:-[a-z0-9]{2,8})*$/;
const SOURCE_KINDS = new Set(['manuscript', 'slide-notes', 'transcript', 'other']);
const LOCAL_PATH_KEYS = new Set([
  'path',
  'filepath',
  'localpath',
  'absolutepath',
  'sourcepath'
]);

const FORMAT_BY_EXTENSION = Object.freeze(Object.fromEntries(
  Object.entries(SOURCE_TYPES).map(([extension, sourceType]) => [
    extension,
    Object.freeze({
      extension,
      format: sourceType.format,
      mediaType: sourceType.mediaType,
      maximumBytes: sourceType.maximumBytes
    })
  ])
));

const LETTER_MARKERS = Object.freeze({
  A: 'A',
  B: 'B',
  C: 'C',
  А: 'A',
  В: 'B',
  С: 'C'
});

const ENGLISH_EXTRA_BOOK_ALIASES = Object.freeze({
  Gen: ['Gen'],
  Exod: ['Exo'],
  Lev: ['Lev'],
  Num: ['Num'],
  Deut: ['Deut'],
  Josh: ['Josh'],
  Judg: ['Judg'],
  '1Sam': ['1 Sam'],
  '2Sam': ['2 Sam'],
  '1Kgs': ['1 Kgs'],
  '2Kgs': ['2 Kgs'],
  '1Chr': ['1 Chr'],
  '2Chr': ['2 Chr'],
  Neh: ['Neh'],
  Esth: ['Est'],
  Ps: ['Psalm'],
  Prov: ['Prov'],
  Eccl: ['Eccl'],
  Song: ['Song of Songs'],
  Isa: ['Isa'],
  Jer: ['Jer'],
  Lam: ['Lam'],
  Ezek: ['Ezek'],
  Dan: ['Dan'],
  Hos: ['Hos'],
  Obad: ['Obad'],
  Mic: ['Mic'],
  Hab: ['Hab'],
  Zeph: ['Zeph'],
  Hag: ['Hag'],
  Zech: ['Zech'],
  Mal: ['Mal'],
  Matt: ['Matt'],
  John: ['Jn'],
  Rom: ['Romans'],
  '1Cor': ['1 Cor'],
  '2Cor': ['2 Cor'],
  Gal: ['Gal'],
  Eph: ['Ephesians'],
  Phil: ['Phil'],
  Col: ['Col'],
  '1Thess': ['1 Thess', '1 Thes'],
  '2Thess': ['2 Thess', '2 Thes'],
  '1Tim': ['1 Tim'],
  '2Tim': ['2 Tim'],
  Phlm: ['Philemon'],
  Heb: ['Heb'],
  Jas: ['James'],
  '1Pet': ['1 Pet'],
  '2Pet': ['2 Pet'],
  '1John': ['1 Jn'],
  '2John': ['2 Jn'],
  '3John': ['3 Jn'],
  Rev: ['Revelation']
});

const RUSSIAN_BOOK_ALIASES = Object.freeze({
  Gen: ['Бытие', 'Быт'],
  Exod: ['Исход', 'Исх'],
  Lev: ['Левит', 'Лев'],
  Num: ['Числа', 'Чис'],
  Deut: ['Второзаконие', 'Втор'],
  Josh: ['Иисус Навин', 'Нав'],
  Judg: ['Судьи', 'Суд'],
  Ruth: ['Руфь', 'Руф'],
  '1Sam': ['1 Царств', '1 Цар', '1 Самуила', '1 Сам'],
  '2Sam': ['2 Царств', '2 Цар', '2 Самуила', '2 Сам'],
  '1Kgs': ['3 Царств', '3 Цар', '1 Царей'],
  '2Kgs': ['4 Царств', '4 Цар', '2 Царей'],
  '1Chr': ['1 Паралипоменон', '1 Пар', '1 Хроник'],
  '2Chr': ['2 Паралипоменон', '2 Пар', '2 Хроник'],
  Ezra: ['Ездра', 'Езд'],
  Neh: ['Неемия', 'Неем'],
  Esth: ['Есфирь', 'Есф'],
  Job: ['Иов'],
  Ps: ['Псалтирь', 'Псалом', 'Псалмы', 'Пс'],
  Prov: ['Притчи', 'Притч'],
  Eccl: ['Екклесиаст', 'Еккл'],
  Song: ['Песнь Песней', 'Песн'],
  Isa: ['Исаия', 'Ис'],
  Jer: ['Иеремия', 'Иер'],
  Lam: ['Плач Иеремии', 'Плач'],
  Ezek: ['Иезекииль', 'Иез'],
  Dan: ['Даниил', 'Дан'],
  Hos: ['Осия', 'Ос'],
  Joel: ['Иоиль', 'Иоил'],
  Amos: ['Амос', 'Ам'],
  Obad: ['Авдий', 'Авд'],
  Jonah: ['Иона', 'Ион'],
  Mic: ['Михей', 'Мих'],
  Nah: ['Наум'],
  Hab: ['Аввакум', 'Авв'],
  Zeph: ['Софония', 'Соф'],
  Hag: ['Аггей', 'Агг'],
  Zech: ['Захария', 'Зах'],
  Mal: ['Малахия', 'Мал'],
  Matt: ['Матфея', 'Матфей', 'Мф'],
  Mark: ['Марка', 'Марк', 'Мк'],
  Luke: ['Луки', 'Лука', 'Лк'],
  John: ['Иоанна', 'Иоанн', 'Ин'],
  Acts: ['Деяния', 'Деян'],
  Rom: ['Римлянам', 'Рим'],
  '1Cor': ['1 Коринфянам', '1 Кор'],
  '2Cor': ['2 Коринфянам', '2 Кор'],
  Gal: ['Галатам', 'Гал'],
  Eph: ['Ефесянам', 'Еф'],
  Phil: ['Филиппийцам', 'Флп'],
  Col: ['Колоссянам', 'Кол'],
  '1Thess': ['1 Фессалоникийцам', '1 Фесс', '1 Фес'],
  '2Thess': ['2 Фессалоникийцам', '2 Фесс', '2 Фес'],
  '1Tim': ['1 Тимофею', '1 Тим'],
  '2Tim': ['2 Тимофею', '2 Тим'],
  Titus: ['Титу', 'Тит'],
  Phlm: ['Филимону', 'Флм'],
  Heb: ['Евреям', 'Евр'],
  Jas: ['Иакова', 'Иак'],
  '1Pet': ['1 Петра', '1 Пет'],
  '2Pet': ['2 Петра', '2 Пет'],
  '1John': ['1 Иоанна', '1 Ин'],
  '2John': ['2 Иоанна', '2 Ин'],
  '3John': ['3 Иоанна', '3 Ин'],
  Jude: ['Иуды', 'Иуд'],
  Rev: ['Откровение', 'Откровения', 'Откр']
});

class SermonSourceExtractionError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'SermonSourceExtractionError';
    this.code = code;
    this.details = deepFreeze({ ...details });
  }
}

function fail(code, message, details = {}) {
  throw new SermonSourceExtractionError(code, message, details);
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function escapeRegularExpression(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

function normalizeBookAlias(value) {
  return value
    .normalize('NFKC')
    .toLocaleLowerCase()
    .replace(/[.\s]+/gu, '');
}

function bookAliasExpression(alias) {
  const compactNumbered = /^([1-3])(\p{L}.*)$/u.exec(alias.trim());
  if (compactNumbered) {
    return `${escapeRegularExpression(compactNumbered[1])}[ \\t]*`
      + escapeRegularExpression(compactNumbered[2]);
  }
  const parts = alias.trim().split(/\s+/u);
  return parts.map((part, index) => {
    if (index === 0) return escapeRegularExpression(part);
    const separator = index === 1 && /^\d$/u.test(parts[0])
      ? '[ \\t]*'
      : '[ \\t]+';
    return `${separator}${escapeRegularExpression(part)}`;
  }).join('');
}

function buildReferencePattern(language, languageAliases) {
  const canonicalIds = new Set(CANONICAL_BIBLE_BOOKS.map(book => book.id));
  for (const bookId of Object.keys(languageAliases)) {
    if (!canonicalIds.has(bookId)) {
      throw new Error(`Unknown Scripture alias book id: ${bookId}`);
    }
  }
  if (language === 'ru' && Object.keys(languageAliases).length !== canonicalIds.size) {
    throw new Error('The Russian Scripture alias table must cover all 66 canonical books.');
  }

  const aliases = [];
  if (language === 'en') {
    for (const book of CANONICAL_BIBLE_BOOKS) {
      aliases.push({ alias: book.name, bookId: book.id });
      aliases.push({ alias: book.id, bookId: book.id });
      for (const alias of languageAliases[book.id] || []) {
        aliases.push({ alias, bookId: book.id });
      }
    }
  } else {
    for (const [bookId, bookAliases] of Object.entries(languageAliases)) {
      for (const alias of bookAliases) aliases.push({ alias, bookId });
    }
  }

  const bookIdsByAlias = new Map();
  const uniqueAliases = new Map();
  for (const { alias, bookId } of aliases) {
    const normalized = normalizeBookAlias(alias);
    const existing = bookIdsByAlias.get(normalized);
    if (existing && existing !== bookId) {
      throw new Error(`Ambiguous Scripture alias: ${alias}`);
    }
    bookIdsByAlias.set(normalized, bookId);
    if (!uniqueAliases.has(normalized)) uniqueAliases.set(normalized, alias);
  }
  const bookExpression = [...uniqueAliases.values()]
    .sort((left, right) => right.length - left.length || left.localeCompare(right))
    .map(bookAliasExpression)
    .join('|');
  return Object.freeze({
    language,
    bookIdsByAlias,
    expression: new RegExp(
      `(?<![\\p{L}\\p{N}_])`
        + `(?<token>(?<book>${bookExpression})\\.?[ \\t]*`
        + '\\d{1,3}[ \\t]*:[ \\t]*\\d{1,3}'
        + '(?:[ \\t]*(?:-|–|—)[ \\t\\r\\n]*'
        + '(?:(?:\\d{1,3})[ \\t]*:[ \\t]*)?\\d{1,3})?)'
        + '(?![\\p{L}\\p{N}_])',
      'giu'
    )
  });
}

const REFERENCE_PATTERNS = Object.freeze([
  buildReferencePattern('en', ENGLISH_EXTRA_BOOK_ALIASES),
  buildReferencePattern('ru', RUSSIAN_BOOK_ALIASES)
]);

function containsLocalPathField(value, visited = new Set()) {
  if (!value || typeof value !== 'object' || visited.has(value)) return false;
  visited.add(value);
  for (const [key, child] of Object.entries(value)) {
    if (LOCAL_PATH_KEYS.has(key.toLowerCase())) return true;
    if (containsLocalPathField(child, visited)) return true;
  }
  return false;
}

function normalizeSourceMetadata(buffer, source) {
  if (!Buffer.isBuffer(buffer)) {
    fail('INVALID_SOURCE_BYTES', 'Sermon source bytes must be provided as a Buffer.');
  }
  if (buffer.length < 1) fail('EMPTY_SOURCE', 'The sermon source is empty.');
  if (!source || typeof source !== 'object' || Array.isArray(source)) {
    fail('INVALID_SOURCE_METADATA', 'Canonical sermon source metadata is required.');
  }
  if (containsLocalPathField(source)) {
    fail('LOCAL_PATH_NOT_ALLOWED', 'Sermon source metadata must not contain a machine-local path.');
  }

  if (typeof source.id !== 'string' || !SOURCE_ID_PATTERN.test(source.id)) {
    fail('INVALID_SOURCE_METADATA', 'The sermon source id is invalid.');
  }
  if (!SOURCE_KINDS.has(source.kind)) {
    fail('INVALID_SOURCE_METADATA', 'The sermon source kind is unsupported.');
  }
  if (typeof source.fileName !== 'string'
    || source.fileName.length < 1
    || source.fileName.length > 255
    || source.fileName === '.'
    || source.fileName === '..'
    || source.fileName.includes('/')
    || source.fileName.includes('\\')
    || /^[A-Za-z]:/u.test(source.fileName)
    || /[\u0000-\u001f\u007f]/u.test(source.fileName)) {
    fail('INVALID_SOURCE_METADATA', 'The sermon source file name is invalid.');
  }

  const dot = source.fileName.lastIndexOf('.');
  const extension = dot < 0 ? '' : source.fileName.slice(dot).toLowerCase();
  const sourceType = FORMAT_BY_EXTENSION[extension];
  if (!sourceType) {
    fail(
      'UNSUPPORTED_SOURCE_TYPE',
      'Sermon extraction supports PDF, DOCX, PPTX, UTF-8 text, and Markdown.'
    );
  }
  if (source.mediaType !== sourceType.mediaType) {
    fail('SOURCE_TYPE_MISMATCH', 'The sermon source media type does not match its file type.');
  }
  if (!Number.isSafeInteger(source.sizeBytes) || source.sizeBytes < 1) {
    fail('INVALID_SOURCE_METADATA', 'The sermon source byte size is invalid.');
  }
  if (source.sizeBytes !== buffer.length) {
    fail('SOURCE_SIZE_MISMATCH', 'The sermon source bytes do not match the recorded byte size.', {
      expectedBytes: source.sizeBytes,
      actualBytes: buffer.length
    });
  }
  if (buffer.length > sourceType.maximumBytes) {
    fail('SOURCE_TOO_LARGE', 'The sermon source exceeds the safe extraction limit.', {
      maximumBytes: sourceType.maximumBytes
    });
  }
  if (typeof source.sha256 !== 'string' || !SHA256_PATTERN.test(source.sha256)) {
    fail('INVALID_SOURCE_METADATA', 'The sermon source SHA-256 digest is invalid.');
  }
  if (sha256(buffer) !== source.sha256) {
    fail('SOURCE_HASH_MISMATCH', 'The sermon source bytes do not match the recorded SHA-256 digest.');
  }

  const rawLanguages = source.languages ?? source.language ?? ['und'];
  const languageValues = Array.isArray(rawLanguages) ? rawLanguages : [rawLanguages];
  if (languageValues.length < 1 || languageValues.length > 8) {
    fail('INVALID_SOURCE_METADATA', 'The sermon source languages are invalid.');
  }
  const languages = [...new Set(languageValues.map(language => {
    if (typeof language !== 'string' || !LANGUAGE_PATTERN.test(language)) {
      fail('INVALID_SOURCE_METADATA', 'The sermon source languages are invalid.');
    }
    return language;
  }))].sort();

  return {
    id: source.id,
    kind: source.kind,
    languages,
    mediaType: source.mediaType,
    sourceType
  };
}

function wrapValidationError(error) {
  if (error instanceof SermonSourceExtractionError) throw error;
  const safeCodes = new Set([
    'CORRUPT_SOURCE',
    'EMPTY_SOURCE',
    'SOURCE_TOO_LARGE',
    'SOURCE_TYPE_MISMATCH'
  ]);
  const code = safeCodes.has(error?.code) ? error.code : 'SOURCE_VALIDATION_FAILED';
  fail(code, 'The sermon source failed deterministic format validation.');
}

function normalizeExtractedText(value) {
  return String(value ?? '')
    .normalize('NFC')
    .replace(/\r\n?/gu, '\n')
    .replace(/\u0000/gu, '')
    .replace(/[\u0001-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, ' ')
    .split('\n')
    .map(line => line.replace(/[^\S\n]+/gu, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/gu, '\n\n')
    .trim();
}

function splitTextIntoChunks(value, targetChars = DOCUMENT_CHUNK_TARGET_CHARS) {
  const text = normalizeExtractedText(value);
  if (!text) return [''];
  const chunks = [];
  let current = '';

  const pushCurrent = () => {
    if (!current) return;
    chunks.push(current);
    current = '';
  };

  for (const block of text.split(/\n{2,}/u)) {
    if (block.length > targetChars) {
      pushCurrent();
      let offset = 0;
      while (offset < block.length) {
        let end = Math.min(block.length, offset + targetChars);
        if (end < block.length) {
          const preferredBreak = block.lastIndexOf('\n', end);
          if (preferredBreak > offset + Math.floor(targetChars / 2)) end = preferredBreak;
        }
        chunks.push(block.slice(offset, end).trim());
        offset = end;
        while (block[offset] === '\n' || block[offset] === ' ') offset += 1;
      }
      continue;
    }
    const candidate = current ? `${current}\n\n${block}` : block;
    if (candidate.length > targetChars) {
      pushCurrent();
      current = block;
    } else {
      current = candidate;
    }
  }
  pushCurrent();
  return chunks.length ? chunks : [''];
}

function boundedUnits(rawUnits) {
  const selected = rawUnits.slice(0, MAX_EXTRACTION_UNITS);
  let remainingChars = MAX_TOTAL_TEXT_CHARS;
  let textTruncated = false;
  const units = selected.map((rawUnit, index) => {
    let truncated = rawUnit.truncated === true;
    let text;
    let spans;
    if (Object.prototype.hasOwnProperty.call(rawUnit, 'spans')) {
      let normalized;
      try {
        normalized = normalizeStyledText(rawUnit.text, rawUnit.spans, {
          field: `PowerPoint slide ${index + 1} spans`,
          maximumChars: Math.min(MAX_UNIT_TEXT_CHARS, remainingChars),
          maximumSpans: MAX_PPTX_TEXT_SPANS,
          allowedForegrounds: DEFAULT_SERMON_EMPHASIS_COLORS
        });
      } catch (error) {
        if (error instanceof PptxStyledTextError) {
          fail(
            'CORRUPT_SOURCE',
            'A PowerPoint slide contains invalid direct-run formatting evidence.'
          );
        }
        throw error;
      }
      text = normalized.text;
      spans = normalized.spans;
      truncated = truncated || normalized.textTruncated || normalized.spansTruncated;
    } else {
      const normalized = normalizeExtractedText(rawUnit.text);
      text = normalized;
      if (text.length > MAX_UNIT_TEXT_CHARS) {
        text = text.slice(0, MAX_UNIT_TEXT_CHARS);
        truncated = true;
      }
      if (text.length > remainingChars) {
        text = text.slice(0, Math.max(0, remainingChars));
        truncated = true;
      }
    }
    remainingChars -= text.length;
    if (truncated) textTruncated = true;
    return {
      id: rawUnit.id,
      kind: rawUnit.kind,
      ordinal: index + 1,
      label: rawUnit.label,
      text,
      ...(spans?.length > 0 ? { spans } : {}),
      truncated
    };
  });
  return {
    units,
    unitsTruncated: rawUnits.length > MAX_EXTRACTION_UNITS,
    textTruncated
  };
}

function decodeXmlText(value) {
  return value.replace(/&(?:#(\d+)|#x([a-f0-9]+)|(amp|apos|gt|lt|quot));/giu, (
    entity,
    decimal,
    hexadecimal,
    named
  ) => {
    if (decimal) {
      const codePoint = Number(decimal);
      return Number.isSafeInteger(codePoint) && codePoint <= 0x10ffff
        ? String.fromCodePoint(codePoint)
        : '\ufffd';
    }
    if (hexadecimal) {
      const codePoint = Number.parseInt(hexadecimal, 16);
      return Number.isSafeInteger(codePoint) && codePoint <= 0x10ffff
        ? String.fromCodePoint(codePoint)
        : '\ufffd';
    }
    return {
      amp: '&',
      apos: "'",
      gt: '>',
      lt: '<',
      quot: '"'
    }[named.toLowerCase()];
  });
}

function decodeXmlPart(buffer) {
  let source;
  try {
    source = new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  } catch (_error) {
    fail('CORRUPT_SOURCE', 'A required Office XML part is not valid UTF-8.');
  }
  if (/<!DOCTYPE|<!ENTITY/iu.test(source)) {
    fail('UNSAFE_XML', 'A required Office XML part contains an unsafe declaration.');
  }
  return source;
}

function parseXmlAttributes(tag) {
  const attributes = {};
  const expression = /([A-Za-z_][A-Za-z0-9_.:-]*)\s*=\s*(["'])([\s\S]*?)\2/gu;
  for (const match of tag.matchAll(expression)) {
    attributes[match[1]] = decodeXmlText(match[3]);
  }
  return attributes;
}

async function loadOoxml(buffer) {
  let archive;
  try {
    archive = await JSZip.loadAsync(buffer, {
      checkCRC32: false,
      createFolders: false
    });
  } catch (_error) {
    fail('CORRUPT_SOURCE', 'The Office source could not be opened.');
  }
  if (Object.keys(archive.files).length > MAX_OOXML_ENTRIES) {
    fail('SOURCE_TOO_LARGE', 'The Office source contains too many parts.');
  }
  return archive;
}

async function readXmlPart(archive, name, { required = true } = {}) {
  const entry = archive.file(name);
  if (!entry) {
    if (!required) return null;
    fail('CORRUPT_SOURCE', 'The Office source is missing a required XML part.');
  }
  let buffer;
  try {
    buffer = await entry.async('nodebuffer');
  } catch (_error) {
    fail('CORRUPT_SOURCE', 'A required Office XML part could not be read.');
  }
  if (buffer.length < 1 || buffer.length > MAX_XML_PART_BYTES) {
    fail('SOURCE_TOO_LARGE', 'A required Office XML part exceeds the safe extraction limit.');
  }
  return decodeXmlPart(buffer);
}

function appendBounded(pieces, state, value, maximumChars) {
  if (!value) return;
  const remaining = maximumChars - state.length;
  if (remaining <= 0) {
    state.truncated = true;
    return;
  }
  if (value.length > remaining) {
    let prefix = value.slice(0, remaining);
    if (/[\uD800-\uDBFF]$/u.test(prefix)) prefix = prefix.slice(0, -1);
    if (prefix) {
      pieces.push(prefix);
      state.length += prefix.length;
    }
    state.truncated = true;
    return;
  }
  pieces.push(value);
  state.length += value.length;
}

function boundedDecodedXmlText(value, remainingChars) {
  if (remainingChars <= 0) return { text: '', truncated: Boolean(value) };
  const sourceLimit = Math.min(value.length, (remainingChars * 12) + 16);
  return {
    text: decodeXmlText(value.slice(0, sourceLimit)),
    truncated: value.length > sourceLimit
  };
}

function extractWordText(documentXml, maximumChars) {
  const pieces = [];
  const state = { length: 0, truncated: false };
  const tokenExpression = /<w:t\b[^>]*>([\s\S]*?)<\/w:t\s*>|<w:tab\b[^>]*\/?>|<w:(?:br|cr)\b[^>]*\/?>|<\/w:p\s*>/giu;
  for (const match of documentXml.matchAll(tokenExpression)) {
    if (match[1] !== undefined) {
      const decoded = boundedDecodedXmlText(match[1], maximumChars - state.length);
      appendBounded(pieces, state, decoded.text, maximumChars);
      if (decoded.truncated) state.truncated = true;
    } else if (/^<w:tab/iu.test(match[0])) {
      appendBounded(pieces, state, ' ', maximumChars);
    } else {
      appendBounded(pieces, state, '\n', maximumChars);
    }
  }
  return {
    text: pieces.join('').replace(/\n{3,}/gu, '\n\n'),
    truncated: state.truncated
  };
}

function extractPresentationText(slideXml, maximumChars) {
  const pieces = [];
  const state = { length: 0, truncated: false };
  const tokenExpression = /<a:t\b[^>]*>([\s\S]*?)<\/a:t\s*>|<a:tab\b[^>]*\/?>|<a:br\b[^>]*\/?>|<\/a:p\s*>/giu;
  for (const match of slideXml.matchAll(tokenExpression)) {
    if (match[1] !== undefined) {
      const decoded = boundedDecodedXmlText(match[1], maximumChars - state.length);
      appendBounded(pieces, state, decoded.text, maximumChars);
      if (decoded.truncated) state.truncated = true;
    } else if (/^<a:tab/iu.test(match[0])) {
      appendBounded(pieces, state, ' ', maximumChars);
    } else {
      appendBounded(pieces, state, '\n', maximumChars);
    }
  }
  return {
    text: pieces.join('').replace(/\n{3,}/gu, '\n\n'),
    truncated: state.truncated
  };
}

function orderedPresentationTargets(presentationXml, relationshipsXml) {
  const targetsByRelationship = new Map();
  const relationshipExpression = /<(?:[A-Za-z_][A-Za-z0-9_.-]*:)?Relationship\b[^>]*\/?>/gu;
  for (const match of relationshipsXml.matchAll(relationshipExpression)) {
    const attributes = parseXmlAttributes(match[0]);
    if (!attributes.Id
      || !attributes.Target
      || attributes.TargetMode === 'External'
      || (attributes.Type && !/\/slide$/u.test(attributes.Type))) {
      continue;
    }
    const target = attributes.Target;
    if (target.includes('\\')
      || target.startsWith('/')
      || /^[A-Za-z]:/u.test(target)
      || target.split('/').some(part => !part || part === '.' || part === '..')) {
      fail('CORRUPT_SOURCE', 'A presentation slide relationship is unsafe.');
    }
    const partName = `ppt/${target}`;
    if (!/^ppt\/slides\/[^/]+\.xml$/u.test(partName)) {
      fail('CORRUPT_SOURCE', 'A presentation slide relationship has an unsupported target.');
    }
    if (targetsByRelationship.has(attributes.Id)) {
      fail('CORRUPT_SOURCE', 'A presentation slide relationship id is repeated.');
    }
    targetsByRelationship.set(attributes.Id, partName);
  }

  const targets = [];
  const seenTargets = new Set();
  const slideIdExpression = /<(?:[A-Za-z_][A-Za-z0-9_.-]*:)?sldId\b[^>]*\/?>/gu;
  for (const match of presentationXml.matchAll(slideIdExpression)) {
    const attributes = parseXmlAttributes(match[0]);
    const relationshipId = attributes['r:id']
      || Object.entries(attributes).find(([key]) => key.endsWith(':id'))?.[1];
    const target = targetsByRelationship.get(relationshipId);
    if (!target) {
      fail('CORRUPT_SOURCE', 'The presentation slide order contains an unresolved relationship.');
    }
    if (seenTargets.has(target)) {
      fail('CORRUPT_SOURCE', 'The presentation slide order repeats a slide relationship.');
    }
    seenTargets.add(target);
    targets.push(target);
  }
  if (!targets.length) fail('CORRUPT_SOURCE', 'The presentation does not contain any slides.');
  return targets;
}

async function extractDocxUnits(buffer) {
  const archive = await loadOoxml(buffer);
  const documentXml = await readXmlPart(archive, 'word/document.xml');
  const extracted = extractWordText(documentXml, MAX_TOTAL_TEXT_CHARS);
  const chunks = splitTextIntoChunks(extracted.text);
  return chunks.map((text, index) => ({
    id: `docx-chunk-${index + 1}`,
    kind: 'document',
    label: `Document chunk ${index + 1}`,
    text,
    truncated: extracted.truncated && index === chunks.length - 1
  }));
}

async function extractPptxUnits(buffer) {
  const archive = await loadOoxml(buffer);
  const [presentationXml, relationshipsXml] = await Promise.all([
    readXmlPart(archive, 'ppt/presentation.xml'),
    readXmlPart(archive, 'ppt/_rels/presentation.xml.rels')
  ]);
  const targets = orderedPresentationTargets(presentationXml, relationshipsXml);
  const units = [];
  for (let index = 0; index < Math.min(targets.length, MAX_EXTRACTION_UNITS); index += 1) {
    const slideXml = await readXmlPart(archive, targets[index]);
    let extracted;
    try {
      extracted = extractStyledTextFromSlideXml(slideXml, {
        emphasisColors: DEFAULT_SERMON_EMPHASIS_COLORS,
        maximumCharacters: MAX_UNIT_TEXT_CHARS * 4
      });
    } catch (error) {
      if (error instanceof PptxStyledTextError) {
        fail('CORRUPT_SOURCE', 'A PowerPoint slide could not be read deterministically.');
      }
      throw error;
    }
    units.push({
      id: `pptx-slide-${index + 1}`,
      kind: 'slide',
      label: `Slide ${index + 1}`,
      text: extracted.text,
      spans: extracted.spans || [],
      truncated: extracted.truncated
    });
  }
  if (targets.length > MAX_EXTRACTION_UNITS) {
    units.push({
      id: `pptx-slide-${MAX_EXTRACTION_UNITS + 1}`,
      kind: 'slide',
      label: `Slide ${MAX_EXTRACTION_UNITS + 1}`,
      text: ''
    });
  }
  return units;
}

function extractTextUnits(buffer, format) {
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  } catch (_error) {
    fail('INVALID_UTF8', 'The text sermon source is not valid UTF-8.');
  }
  if (/[\u0000\u0001-\u0008\u000b\u000c\u000e-\u001f]/u.test(text)) {
    fail('SOURCE_TYPE_MISMATCH', 'The text sermon source contains binary control bytes.');
  }
  const chunks = splitTextIntoChunks(text.replace(/^\ufeff/u, ''));
  return chunks.map((chunk, index) => ({
    id: `${format}-chunk-${index + 1}`,
    kind: 'document',
    label: `Document chunk ${index + 1}`,
    text: chunk
  }));
}

async function extractPdfUnits(buffer) {
  try {
    const document = await openPdf(buffer);
    try {
      const pageCount = document.pageCount;
      const units = [];
      let remainingTextChars = MAX_TOTAL_TEXT_CHARS;
      for (let index = 0; index < Math.min(pageCount, MAX_EXTRACTION_UNITS); index += 1) {
        const maximumCharacters = Math.min(MAX_UNIT_TEXT_CHARS, remainingTextChars);
        if (maximumCharacters === 0) {
          units.push({
            id: `pdf-page-${index + 1}`,
            kind: 'page',
            label: `Page ${index + 1}`,
            text: '',
            truncated: true
          });
          continue;
        }
        const extracted = await document.extractPageText(index, {
          maximumCharacters
        });
        remainingTextChars -= extracted.text.length;
        units.push({
          id: `pdf-page-${index + 1}`,
          kind: 'page',
          label: `Page ${index + 1}`,
          text: extracted.text,
          truncated: extracted.truncated
        });
      }
      if (pageCount > MAX_EXTRACTION_UNITS) {
        units.push({
          id: `pdf-page-${MAX_EXTRACTION_UNITS + 1}`,
          kind: 'page',
          label: `Page ${MAX_EXTRACTION_UNITS + 1}`,
          text: ''
        });
      }
      return units;
    } finally {
      await document.close();
    }
  } catch (error) {
    if (error instanceof SermonSourceExtractionError) throw error;
    fail('CORRUPT_SOURCE', 'The PDF sermon source could not be read deterministically.');
  }
}

function inferLanguage(text, languages) {
  const cyrillic = (text.match(/\p{Script=Cyrillic}/gu) || []).length;
  const latin = (text.match(/\p{Script=Latin}/gu) || []).length;
  const concrete = languages.filter(language => language !== 'und');
  const cyrillicBases = new Set(['be', 'bg', 'kk', 'ky', 'mk', 'mn', 'ru', 'sr', 'tg', 'uk']);
  const candidates = cyrillic > latin
    ? concrete.filter(language => cyrillicBases.has(language.split('-')[0]))
    : latin > cyrillic
      ? concrete.filter(language => !cyrillicBases.has(language.split('-')[0]))
      : concrete;
  return candidates.length === 1 ? candidates[0] : 'und';
}

function localizedHeadingTitles(title, languages) {
  const result = {};
  const parts = title
    .split(/\s+\/\s+/u)
    .map(part => part.trim())
    .filter(Boolean);
  const candidates = parts.length ? parts : [title.trim()];
  if (candidates.length > 2
    || candidates.some(part => !part || part.length > MAX_OUTLINE_TITLE_CHARS)) {
    return null;
  }
  for (const part of candidates) {
    const language = inferLanguage(part, languages);
    if (!result[language]) result[language] = part;
  }
  return Object.fromEntries(
    Object.entries(result).sort(([left], [right]) => left.localeCompare(right))
  );
}

function headingMatch(line) {
  const match = /^(III|II|I|[ABCАВС])[.)]\s+(.+)$/u.exec(line.trim());
  if (!match) return null;
  const rawMarker = match[1].toUpperCase();
  const isRoman = /^(?:I|II|III)$/u.test(rawMarker);
  const marker = isRoman ? rawMarker : LETTER_MARKERS[rawMarker];
  if (!marker) return null;
  return {
    isRoman,
    marker,
    title: match[2],
    rawText: line.trim()
  };
}

function pptxSermonWindow(units) {
  const romanUnits = new Map([['I', []], ['II', []], ['III', []]]);
  const headingUnitIndexes = [];
  const headingsByUnit = new Map();
  let hasLetterHeading = false;
  for (let index = 0; index < units.length; index += 1) {
    const headings = [];
    for (const line of units[index].text.split('\n')) {
      const heading = headingMatch(line);
      if (!heading) continue;
      headings.push(heading);
      if (heading.isRoman) romanUnits.get(heading.marker).push(index);
      else hasLetterHeading = true;
    }
    if (headings.length) {
      headingUnitIndexes.push(index);
      headingsByUnit.set(index, headings);
    }
  }
  const firstI = romanUnits.get('I')[0];
  const firstII = romanUnits.get('II').find(index => index >= firstI);
  const firstIII = romanUnits.get('III').find(index => index >= firstII);
  if (!Number.isInteger(firstI)
    || !Number.isInteger(firstII)
    || !Number.isInteger(firstIII)
    || (!hasLetterHeading
      && [...romanUnits.values()].reduce((count, indexes) => count + indexes.length, 0) < 5)) {
    return {
      strategy: 'pptx-no-sermon-window',
      startOrdinal: null,
      endOrdinal: null,
      units: []
    };
  }
  let endIndex = firstIII;
  let previousHeadingIndex = firstIII;
  for (const index of headingUnitIndexes.filter(index => index > firstIII)) {
    const headings = headingsByUnit.get(index);
    const romanMarkers = new Set(
      headings.filter(heading => heading.isRoman).map(heading => heading.marker)
    );
    if (index - previousHeadingIndex > PPTX_MAX_HEADING_GAP_UNITS
      || ((romanMarkers.has('I') || romanMarkers.has('II'))
        && !romanMarkers.has('III'))) {
      break;
    }
    endIndex = index;
    previousHeadingIndex = index;
  }
  const startIndex = Math.max(0, firstI - PPTX_SERMON_LEAD_UNITS);
  return {
    strategy: 'pptx-roman-outline-window',
    startOrdinal: startIndex + 1,
    endOrdinal: endIndex + 1,
    units: units.slice(startIndex, endIndex + 1)
  };
}

function addSourceUnitLink(suggestion, unitId) {
  if (suggestion.sourceUnitIds.includes(unitId)) return;
  if (suggestion.sourceUnitIds.length < MAX_SOURCE_UNIT_LINKS) {
    suggestion.sourceUnitIds.push(unitId);
  } else {
    suggestion.sourceUnitIdsTruncated = true;
  }
}

function outlineSuggestionsFromUnits(units, languages) {
  const byKey = new Map();
  let currentRoman = null;
  let suggestionsTruncated = false;

  for (const unit of units) {
    for (const line of unit.text.split('\n')) {
      const heading = headingMatch(line);
      if (!heading) continue;
      const titles = localizedHeadingTitles(heading.title, languages);
      if (!titles) continue;
      if (!heading.isRoman && !currentRoman) continue;
      if (heading.isRoman) currentRoman = heading.marker;
      const level = heading.isRoman ? 1 : 2;
      const key = heading.isRoman
        ? heading.marker
        : `${currentRoman || 'root'}:${heading.marker}`;
      let suggestion = byKey.get(key);
      if (!suggestion) {
        if (byKey.size >= MAX_OUTLINE_SUGGESTIONS) {
          suggestionsTruncated = true;
          continue;
        }
        const id = heading.isRoman
          ? `outline-${heading.marker.toLowerCase()}`
          : `outline-${(currentRoman || 'root').toLowerCase()}-${heading.marker.toLowerCase()}`;
        const parentSuggestionId = heading.isRoman
          ? null
          : (currentRoman ? `outline-${currentRoman.toLowerCase()}` : null);
        suggestion = {
          id,
          level,
          marker: heading.marker,
          parentId: parentSuggestionId,
          parentSuggestionId,
          suggestedKind: heading.isRoman ? 'section' : 'point',
          titles: {},
          rawText: heading.rawText,
          sourceUnitIds: [],
          sourceUnitIdsTruncated: false,
          occurrenceCount: 0
        };
        byKey.set(key, suggestion);
      }
      for (const [language, title] of Object.entries(titles)) {
        if (!suggestion.titles[language]) suggestion.titles[language] = title;
      }
      suggestion.occurrenceCount += 1;
      addSourceUnitLink(suggestion, unit.id);
    }
  }

  return {
    suggestions: [...byKey.values()].map(suggestion => ({
      ...suggestion,
      titles: Object.fromEntries(
        Object.entries(suggestion.titles)
          .sort(([left], [right]) => left.localeCompare(right))
      )
    })),
    truncated: suggestionsTruncated
  };
}

function normalizeReferenceToken(value) {
  return value
    .normalize('NFC')
    .replace(/\s+/gu, ' ')
    .replace(/\s*:\s*/gu, ':')
    .replace(/\s*([-–—])\s*/gu, '$1')
    .trim();
}

function referenceSuggestionsFromUnits(units) {
  const byKey = new Map();
  let suggestionsTruncated = false;

  for (const unit of units) {
    const matches = [];
    for (const pattern of REFERENCE_PATTERNS) {
      pattern.expression.lastIndex = 0;
      for (const match of unit.text.matchAll(pattern.expression)) {
        const bookHint = pattern.bookIdsByAlias.get(normalizeBookAlias(match.groups.book));
        if (!bookHint) continue;
        matches.push({
          language: pattern.language,
          rawText: normalizeReferenceToken(match.groups.token),
          bookHint,
          startOffset: match.index,
          endOffset: match.index + match[0].length
        });
      }
    }
    matches.sort((left, right) => left.startOffset - right.startOffset);
    for (const match of matches) {
      const key = `${match.language}:${match.rawText
        .toLocaleLowerCase(match.language)
        .replace(/\s+/gu, '')}`;
      let suggestion = byKey.get(key);
      if (!suggestion) {
        if (byKey.size >= MAX_REFERENCE_SUGGESTIONS) {
          suggestionsTruncated = true;
          continue;
        }
        const digest = crypto.createHash('sha256').update(key).digest('hex').slice(0, 16);
        suggestion = {
          id: `reference-${digest}`,
          rawText: match.rawText,
          language: match.language,
          bookHint: match.bookHint,
          unitId: unit.id,
          startOffset: match.startOffset,
          endOffset: match.endOffset,
          sourceUnitIds: [],
          sourceUnitIdsTruncated: false,
          occurrenceCount: 0
        };
        byKey.set(key, suggestion);
      }
      suggestion.occurrenceCount += 1;
      addSourceUnitLink(suggestion, unit.id);
    }
  }

  return {
    suggestions: [...byKey.values()],
    truncated: suggestionsTruncated
  };
}

function textPreviewFromUnits(units) {
  const combined = units
    .map(unit => unit.text)
    .filter(Boolean)
    .join('\n\n');
  return {
    text: combined.slice(0, MAX_TEXT_PREVIEW_CHARS),
    truncated: combined.length > MAX_TEXT_PREVIEW_CHARS
  };
}

async function rawUnitsForFormat(buffer, format) {
  if (format === 'pdf') return extractPdfUnits(buffer);
  if (format === 'docx') return extractDocxUnits(buffer);
  if (format === 'pptx') return extractPptxUnits(buffer);
  return extractTextUnits(buffer, format);
}

/**
 * Build a deterministic, review-only proposal from verified source bytes.
 *
 * @param {Buffer} buffer exact bytes described by sourceMetadata
 * @param {object} sourceMetadata canonical sermon source metadata
 * @returns {Promise<object>} deeply frozen, path-free extraction proposal
 */
async function extractSermonSourceProposal(buffer, sourceMetadata) {
  const source = normalizeSourceMetadata(buffer, sourceMetadata);
  try {
    await validateSourceBuffer(buffer, SOURCE_TYPES[source.sourceType.extension]);
  } catch (error) {
    wrapValidationError(error);
  }

  const rawUnits = await rawUnitsForFormat(buffer, source.sourceType.format);
  const bounded = boundedUnits(rawUnits);
  const scope = source.sourceType.format === 'pptx'
    ? pptxSermonWindow(bounded.units)
    : {
        strategy: 'whole-source',
        startOrdinal: bounded.units.length ? 1 : null,
        endOrdinal: bounded.units.length || null,
        units: bounded.units
      };
  const completeScopeUnits = scope.units.filter(unit => !unit.truncated);
  const outline = outlineSuggestionsFromUnits(completeScopeUnits, source.languages);
  const references = referenceSuggestionsFromUnits(completeScopeUnits);
  const preview = textPreviewFromUnits(
    scope.strategy === 'pptx-roman-outline-window' ? scope.units : bounded.units
  );

  return deepFreeze({
    schemaVersion: source.sourceType.format === 'pptx'
      ? SERMON_SOURCE_EXTRACTION_SCHEMA_VERSION
      : SERMON_SOURCE_EXTRACTION_LEGACY_SCHEMA_VERSION,
    kind: SERMON_SOURCE_EXTRACTION_KIND,
    extractor: {
      id: SERMON_SOURCE_EXTRACTOR_ID,
      version: SERMON_SOURCE_EXTRACTOR_VERSION
    },
    source: {
      id: source.id,
      sha256: sourceMetadata.sha256,
      kind: source.kind,
      languages: [...source.languages],
      mediaType: source.mediaType
    },
    units: bounded.units,
    textPreview: preview.text,
    suggestionScope: {
      strategy: scope.strategy,
      startUnitId: scope.units[0]?.id || null,
      endUnitId: scope.units.at(-1)?.id || null,
      startOrdinal: scope.startOrdinal,
      endOrdinal: scope.endOrdinal
    },
    outlineSuggestions: outline.suggestions,
    scriptureReferenceSuggestions: references.suggestions,
    truncated: {
      units: bounded.unitsTruncated,
      text: bounded.textTruncated,
      preview: preview.truncated,
      outlineSuggestions: outline.truncated,
      scriptureReferences: references.truncated
    }
  });
}

module.exports = {
  DOCUMENT_CHUNK_TARGET_CHARS,
  MAX_EXTRACTION_UNITS,
  MAX_OUTLINE_TITLE_CHARS,
  MAX_OUTLINE_SUGGESTIONS,
  MAX_REFERENCE_SUGGESTIONS,
  MAX_SOURCE_UNIT_LINKS,
  MAX_TEXT_PREVIEW_CHARS,
  MAX_TOTAL_TEXT_CHARS,
  MAX_UNIT_TEXT_CHARS,
  PPTX_MAX_HEADING_GAP_UNITS,
  PPTX_SERMON_LEAD_UNITS,
  SERMON_SOURCE_EXTRACTION_KIND,
  SERMON_SOURCE_EXTRACTION_LEGACY_SCHEMA_VERSION,
  SERMON_SOURCE_EXTRACTION_SCHEMA_VERSION,
  SERMON_SOURCE_EXTRACTOR_ID,
  SERMON_SOURCE_EXTRACTOR_VERSION,
  SermonSourceExtractionError,
  extractSermonSourceProposal
};
