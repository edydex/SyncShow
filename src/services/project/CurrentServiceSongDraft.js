'use strict';

const crypto = require('crypto');
const { TextDecoder } = require('util');

const JSZip = require('jszip');

const {
  PptxStyledTextError,
  extractStyledTextFromSlideXml
} = require('../sermon/PptxStyledText');
const {
  SONG_SCHEMA_VERSION,
  SongDocumentError,
  normalizeSongDocument,
  slugify
} = require('./SongDocument');

const CURRENT_SERVICE_SONG_SLIDES_SCHEMA_VERSION = 1;
const CURRENT_SERVICE_SONG_SLIDES_KIND = 'syncshow-current-service-song-slides';
const CURRENT_SERVICE_SONG_DRAFT_PROVENANCE_KIND =
  'syncshow-current-service-song-draft-provenance';
const CURRENT_SERVICE_SONG_REVIEW_CANDIDATE_KIND =
  'syncshow-current-service-song-review-range';

const MAX_PPTX_BYTES = 128 * 1024 * 1024;
const MAX_ARCHIVE_ENTRIES = 10_000;
const MAX_SLIDES = 1_000;
const MAX_SELECTED_SLIDES = 200;
const MAX_XML_PART_BYTES = 16 * 1024 * 1024;
const MAX_TOTAL_SLIDE_XML_BYTES = 64 * 1024 * 1024;
const MAX_SLIDE_TEXT_CHARS = 32_000;
const MAX_INSPECTION_TEXT_CHARS = 1_500_000;
const MAX_INSPECTION_LINES = 30_000;
const MAX_DRAFT_TEXT_BYTES = 384 * 1024;
const MAX_DRAFT_LINES = 10_000;
const MAX_TEXT_SHAPES_PER_SLIDE = 128;
const MAX_SHAPE_NAME_CHARS = 500;
const MAX_REVIEW_CANDIDATES = 256;
const ZIP_END_OF_CENTRAL_DIRECTORY_SIGNATURE = 0x06054b50;
const ZIP_CENTRAL_DIRECTORY_ENTRY_SIGNATURE = 0x02014b50;
const ZIP_MIN_END_OF_CENTRAL_DIRECTORY_BYTES = 22;
const ZIP_MAX_COMMENT_BYTES = 0xffff;
// Inspection responses are cumulatively bounded above. Keep the complete
// canonical extraction for each lane so confirmation never approves an unseen
// tail that the later draft build would retain.
const MAX_PREVIEW_CHARS = MAX_SLIDE_TEXT_CHARS;

const BUILD_OPTION_KEYS = Object.freeze([
  'slideNumbers',
  'lane',
  'title',
  'language',
  'sourceLabel'
]);
const BUILD_OPTION_KEYS_WITH_SLIDE_LANES = Object.freeze([
  ...BUILD_OPTION_KEYS,
  'slideLanes'
]);
const LANE_IDS = Object.freeze(['all', 'white', 'yellow']);
const LANE_COLOR_FILTERS = Object.freeze({
  all: null,
  white: Object.freeze(['#FFFFFF']),
  yellow: Object.freeze(['#FFFF00'])
});

class CurrentServiceSongDraftError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'CurrentServiceSongDraftError';
    this.code = code;
    this.details = deepFreeze({ ...details });
  }
}

function fail(code, message, details = {}) {
  throw new CurrentServiceSongDraftError(code, message, details);
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

function requireExactKeys(value, keys, field) {
  if (!isRecord(value)) {
    fail('INVALID_DRAFT_OPTIONS', `${field} must be an object.`, { field });
  }
  const expected = [...keys].sort();
  const actual = Object.keys(value).sort();
  if (!sameStringList(actual, expected)) {
    fail(
      'INVALID_DRAFT_OPTIONS',
      `${field} must contain exactly the supported fields.`,
      { field, expected, actual }
    );
  }
}

function requireTrimmedText(value, field, maximum) {
  if (typeof value !== 'string') {
    fail('INVALID_DRAFT_OPTIONS', `${field} must be text.`, { field });
  }
  if (!value || value !== value.trim()) {
    fail(
      'INVALID_DRAFT_OPTIONS',
      `${field} must be non-empty text without leading or trailing whitespace.`,
      { field }
    );
  }
  if (value.length > maximum || /[\0\r\n]/u.test(value)) {
    fail(
      'INVALID_DRAFT_OPTIONS',
      `${field} must be one line of ${maximum} characters or fewer.`,
      { field, maximum }
    );
  }
  return value;
}

function normalizeBuildOptions(raw) {
  const rawKeys = isRecord(raw) ? Object.keys(raw).sort() : [];
  const expectedKeys = rawKeys.includes('slideLanes')
    ? BUILD_OPTION_KEYS_WITH_SLIDE_LANES
    : BUILD_OPTION_KEYS;
  requireExactKeys(raw, expectedKeys, 'options');
  if (!Array.isArray(raw.slideNumbers)
    || raw.slideNumbers.length < 1
    || raw.slideNumbers.length > MAX_SELECTED_SLIDES) {
    fail(
      'INVALID_SLIDE_SELECTION',
      `slideNumbers must contain 1 to ${MAX_SELECTED_SLIDES} slide numbers.`,
      { maximum: MAX_SELECTED_SLIDES }
    );
  }
  const slideNumbers = raw.slideNumbers.map((number, index) => {
    if (!Number.isSafeInteger(number) || number < 1) {
      fail(
        'INVALID_SLIDE_SELECTION',
        `slideNumbers[${index}] must be a positive whole number.`,
        { index }
      );
    }
    if (index > 0 && number <= raw.slideNumbers[index - 1]) {
      fail(
        'INVALID_SLIDE_SELECTION',
        'slideNumbers must be unique and strictly increasing. Gaps are supported.',
        { index }
      );
    }
    return number;
  });
  if (!LANE_IDS.includes(raw.lane)) {
    fail(
      'INVALID_DRAFT_OPTIONS',
      `lane must be one of: ${LANE_IDS.join(', ')}.`,
      { field: 'lane' }
    );
  }
  const slideLanes = raw.slideLanes === undefined
    ? slideNumbers.map(() => raw.lane)
    : raw.slideLanes;
  if (
    !Array.isArray(slideLanes)
    || slideLanes.length !== slideNumbers.length
    || slideLanes.some(lane => !LANE_IDS.includes(lane))
  ) {
    fail(
      'INVALID_DRAFT_OPTIONS',
      'slideLanes must choose all, white, or yellow once for every selected slide.',
      { field: 'slideLanes', expectedLength: slideNumbers.length }
    );
  }
  return {
    slideNumbers,
    lane: raw.lane,
    slideLanes: [...slideLanes],
    title: requireTrimmedText(raw.title, 'title', 200),
    language: requireTrimmedText(raw.language, 'language', 35),
    sourceLabel: requireTrimmedText(raw.sourceLabel, 'sourceLabel', 500)
  };
}

function compactSlideLaneRuns(slideNumbers, slideLanes) {
  const codeByLane = { all: 'a', white: 'w', yellow: 'y' };
  const runs = [];
  let startIndex = 0;
  for (let index = 1; index <= slideNumbers.length; index += 1) {
    const sameRun = index < slideNumbers.length
      && slideNumbers[index] === slideNumbers[index - 1] + 1
      && slideLanes[index] === slideLanes[startIndex];
    if (sameRun) continue;
    const start = slideNumbers[startIndex];
    const end = slideNumbers[index - 1];
    runs.push(
      `${start}${end === start ? '' : `-${end}`}:${codeByLane[slideLanes[startIndex]]}`
    );
    startIndex = index;
  }
  return runs.join(',');
}

function capturedSlideTextSha256(sections) {
  const orderedSlides = sections.flatMap(section =>
    section.slides.map(slide => slide.lines));
  return crypto
    .createHash('sha256')
    .update(JSON.stringify(orderedSlides), 'utf8')
    .digest('hex');
}

function assertPptxBuffer(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 1) {
    fail('INVALID_PPTX', 'PowerPoint source bytes must be a non-empty Buffer.');
  }
  if (buffer.length > MAX_PPTX_BYTES) {
    fail(
      'PPTX_TOO_LARGE',
      `The PowerPoint source exceeds the ${MAX_PPTX_BYTES}-byte limit.`,
      { maximumBytes: MAX_PPTX_BYTES, sizeBytes: buffer.length }
    );
  }
}

function findZipEndOfCentralDirectory(buffer) {
  const minimumOffset = Math.max(
    0,
    buffer.length
      - ZIP_MIN_END_OF_CENTRAL_DIRECTORY_BYTES
      - ZIP_MAX_COMMENT_BYTES
  );
  for (
    let offset = buffer.length - ZIP_MIN_END_OF_CENTRAL_DIRECTORY_BYTES;
    offset >= minimumOffset;
    offset -= 1
  ) {
    if (buffer.readUInt32LE(offset) !== ZIP_END_OF_CENTRAL_DIRECTORY_SIGNATURE) {
      continue;
    }
    const commentLength = buffer.readUInt16LE(offset + 20);
    if (
      offset
        + ZIP_MIN_END_OF_CENTRAL_DIRECTORY_BYTES
        + commentLength
      === buffer.length
    ) {
      return offset;
    }
  }
  return -1;
}

/**
 * Bound the ZIP directory before JSZip constructs one object per package part.
 *
 * PPTX does not need multi-disk ZIPs. ZIP64 is deliberately rejected here:
 * accepting it safely would require another directory format and the ordinary
 * 128 MiB source cap gives current service decks no reason to use it.
 */
function assertZipDirectoryBounds(buffer) {
  const endOffset = findZipEndOfCentralDirectory(buffer);
  if (endOffset < 0) {
    fail('CORRUPT_PPTX', 'The PowerPoint source has no valid ZIP directory.');
  }
  const diskNumber = buffer.readUInt16LE(endOffset + 4);
  const directoryDisk = buffer.readUInt16LE(endOffset + 6);
  const entriesOnDisk = buffer.readUInt16LE(endOffset + 8);
  const totalEntries = buffer.readUInt16LE(endOffset + 10);
  const directorySize = buffer.readUInt32LE(endOffset + 12);
  const directoryOffset = buffer.readUInt32LE(endOffset + 16);
  if (diskNumber !== 0 || directoryDisk !== 0 || entriesOnDisk !== totalEntries) {
    fail(
      'UNSAFE_PPTX',
      'Multi-disk PowerPoint packages are not supported for song review.'
    );
  }
  if (
    totalEntries === 0xffff
    || directorySize === 0xffffffff
    || directoryOffset === 0xffffffff
  ) {
    fail(
      'UNSAFE_PPTX',
      'ZIP64 PowerPoint packages are not supported for song review.'
    );
  }
  if (totalEntries > MAX_ARCHIVE_ENTRIES) {
    fail(
      'PPTX_TOO_LARGE',
      `The PowerPoint source contains more than ${MAX_ARCHIVE_ENTRIES} package parts.`,
      { maximumEntries: MAX_ARCHIVE_ENTRIES, entryCount: totalEntries }
    );
  }
  if (
    directoryOffset > endOffset
    || directorySize > endOffset - directoryOffset
    || directoryOffset + directorySize !== endOffset
  ) {
    fail('CORRUPT_PPTX', 'The PowerPoint ZIP directory has invalid bounds.');
  }

  let offset = directoryOffset;
  let entryCount = 0;
  while (offset < endOffset) {
    if (
      endOffset - offset < 46
      || buffer.readUInt32LE(offset) !== ZIP_CENTRAL_DIRECTORY_ENTRY_SIGNATURE
    ) {
      fail('CORRUPT_PPTX', 'The PowerPoint ZIP directory is malformed.');
    }
    const fileNameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const entryDisk = buffer.readUInt16LE(offset + 34);
    const localHeaderOffset = buffer.readUInt32LE(offset + 42);
    if (entryDisk !== 0 || localHeaderOffset === 0xffffffff) {
      fail(
        'UNSAFE_PPTX',
        'The PowerPoint ZIP directory contains an unsupported package part.'
      );
    }
    const nextOffset =
      offset + 46 + fileNameLength + extraLength + commentLength;
    if (nextOffset <= offset || nextOffset > endOffset) {
      fail('CORRUPT_PPTX', 'The PowerPoint ZIP directory is malformed.');
    }
    entryCount += 1;
    if (entryCount > MAX_ARCHIVE_ENTRIES) {
      fail(
        'PPTX_TOO_LARGE',
        `The PowerPoint source contains more than ${MAX_ARCHIVE_ENTRIES} package parts.`,
        { maximumEntries: MAX_ARCHIVE_ENTRIES, entryCount }
      );
    }
    offset = nextOffset;
  }
  if (offset !== endOffset || entryCount !== totalEntries) {
    fail(
      'CORRUPT_PPTX',
      'The PowerPoint ZIP directory entry count is inconsistent.'
    );
  }
}

function safeArchiveEntryName(entry) {
  const name = entry.name;
  const originalName = entry.unsafeOriginalName;
  if (typeof name !== 'string'
    || !name
    || name.includes('\0')
    || name.includes('\\')
    || name.startsWith('/')
    || /^[A-Za-z]:/u.test(name)
    || (typeof originalName === 'string' && originalName !== name)) {
    return false;
  }
  const comparable = entry.dir && name.endsWith('/') ? name.slice(0, -1) : name;
  const segments = comparable.split('/');
  return comparable.length > 0
    && segments.every(segment => segment && segment !== '.' && segment !== '..');
}

async function loadArchive(buffer) {
  assertPptxBuffer(buffer);
  assertZipDirectoryBounds(buffer);
  let archive;
  try {
    archive = await JSZip.loadAsync(buffer, {
      checkCRC32: false,
      createFolders: false
    });
  } catch (_error) {
    fail('CORRUPT_PPTX', 'The PowerPoint source could not be opened.');
  }
  const entries = Object.values(archive.files);
  if (entries.length > MAX_ARCHIVE_ENTRIES) {
    fail(
      'PPTX_TOO_LARGE',
      `The PowerPoint source contains more than ${MAX_ARCHIVE_ENTRIES} package parts.`,
      { maximumEntries: MAX_ARCHIVE_ENTRIES, entryCount: entries.length }
    );
  }
  for (const entry of entries) {
    if (!safeArchiveEntryName(entry)) {
      fail('UNSAFE_PPTX', 'The PowerPoint source contains an unsafe package path.');
    }
  }
  return archive;
}

function advertisedUncompressedSize(entry) {
  const size = entry?._data?.uncompressedSize;
  return Number.isSafeInteger(size) && size >= 0 ? size : null;
}

function decodeXmlPart(buffer, description) {
  let source;
  try {
    source = new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  } catch (_error) {
    fail('CORRUPT_PPTX', `${description} is not valid UTF-8.`);
  }
  if (/<!DOCTYPE|<!ENTITY/iu.test(source)) {
    fail('UNSAFE_PPTX', `${description} contains an unsafe XML declaration.`);
  }
  if (source.includes('\0')) {
    fail('CORRUPT_PPTX', `${description} contains an invalid null character.`);
  }
  return source;
}

async function readXmlPart(archive, name, description, slideBudget = null) {
  const entry = archive.file(name);
  if (!entry || entry.dir) {
    fail(
      'CORRUPT_PPTX',
      `${description} is missing from the PowerPoint source.`,
      { part: name }
    );
  }
  const remainingSlideBytes = slideBudget
    ? MAX_TOTAL_SLIDE_XML_BYTES - slideBudget.bytes
    : MAX_XML_PART_BYTES;
  const maximumBytes = Math.min(MAX_XML_PART_BYTES, remainingSlideBytes);
  if (maximumBytes < 1) {
    fail(
      'PPTX_XML_TOO_LARGE',
      'The PowerPoint source exceeds the cumulative slide XML limit.',
      { maximumBytes: MAX_TOTAL_SLIDE_XML_BYTES }
    );
  }
  const advertisedSize = advertisedUncompressedSize(entry);
  if (advertisedSize !== null && advertisedSize > maximumBytes) {
    const cumulativeLimit =
      Boolean(slideBudget) && maximumBytes < MAX_XML_PART_BYTES;
    fail(
      'PPTX_XML_TOO_LARGE',
      cumulativeLimit
        ? 'The PowerPoint source exceeds the cumulative slide XML limit.'
        : `${description} exceeds the safe XML part limit.`,
      {
        part: name,
        maximumBytes: cumulativeLimit
          ? MAX_TOTAL_SLIDE_XML_BYTES
          : MAX_XML_PART_BYTES,
        sizeBytes: advertisedSize
      }
    );
  }
  let buffer;
  try {
    buffer = await readArchiveEntryBounded(entry, maximumBytes);
  } catch (_error) {
    if (_error?.code === 'PPTX_XML_TOO_LARGE') {
      const cumulativeLimit =
        Boolean(slideBudget) && maximumBytes < MAX_XML_PART_BYTES;
      fail(
        'PPTX_XML_TOO_LARGE',
        cumulativeLimit
          ? 'The PowerPoint source exceeds the cumulative slide XML limit.'
          : `${description} exceeds the safe XML part limit.`,
        {
          part: name,
          maximumBytes: cumulativeLimit
            ? MAX_TOTAL_SLIDE_XML_BYTES
            : MAX_XML_PART_BYTES
        }
      );
    }
    fail('CORRUPT_PPTX', `${description} could not be read.`, { part: name });
  }
  if (buffer.length < 1 || buffer.length > maximumBytes) {
    fail(
      buffer.length > maximumBytes ? 'PPTX_XML_TOO_LARGE' : 'CORRUPT_PPTX',
      `${description} has an invalid size.`,
      { part: name, maximumBytes, sizeBytes: buffer.length }
    );
  }
  if (slideBudget) slideBudget.bytes += buffer.length;
  return decodeXmlPart(buffer, description);
}

function readArchiveEntryBounded(entry, maximumBytes) {
  return new Promise((resolve, reject) => {
    const stream = entry.internalStream('nodebuffer');
    const chunks = [];
    let total = 0;
    let settled = false;
    const rejectOnce = error => {
      if (settled) return;
      settled = true;
      stream.pause();
      reject(error);
    };
    stream.on('data', chunk => {
      if (settled) return;
      total += chunk.length;
      if (total > maximumBytes) {
        const error = new Error('The decompressed archive entry exceeds its limit.');
        error.code = 'PPTX_XML_TOO_LARGE';
        rejectOnce(error);
        return;
      }
      chunks.push(Buffer.from(chunk));
    });
    stream.on('error', rejectOnce);
    stream.on('end', () => {
      if (settled) return;
      settled = true;
      resolve(Buffer.concat(chunks, total));
    });
    stream.resume();
  });
}

function decodeXmlText(value) {
  return String(value || '').replace(
    /&(?:#(\d+)|#x([0-9a-f]+)|(amp|apos|gt|lt|quot));/giu,
    (entity, decimal, hexadecimal, named) => {
      if (decimal || hexadecimal) {
        const codePoint = Number.parseInt(decimal || hexadecimal, decimal ? 10 : 16);
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
      }[named.toLowerCase()] || entity;
    }
  );
}

function parseXmlAttributes(tag) {
  const attributes = {};
  const expression = /([A-Za-z_][A-Za-z0-9_.:-]*)\s*=\s*(["'])([\s\S]*?)\2/gu;
  for (const match of String(tag || '').matchAll(expression)) {
    attributes[match[1]] = decodeXmlText(match[3]);
  }
  return attributes;
}

function safeSlideRelationshipTarget(target) {
  if (typeof target !== 'string'
    || !target
    || target.includes('\\')
    || target.startsWith('/')
    || /^[A-Za-z]:/u.test(target)
    || target.split('/').some(part => !part || part === '.' || part === '..')) {
    return null;
  }
  const part = `ppt/${target}`;
  return /^ppt\/slides\/[^/]+\.xml$/u.test(part) ? part : null;
}

function orderedSlideParts(presentationXml, relationshipsXml) {
  const slidesByRelationship = new Map();
  const relationshipIds = new Set();
  const relationshipExpression =
    /<(?:[A-Za-z_][A-Za-z0-9_.-]*:)?Relationship\b[^>]*\/?>/gu;
  for (const match of relationshipsXml.matchAll(relationshipExpression)) {
    const attributes = parseXmlAttributes(match[0]);
    if (!attributes.Id || relationshipIds.has(attributes.Id)) {
      fail('CORRUPT_PPTX', 'A PowerPoint presentation relationship id is invalid or repeated.');
    }
    relationshipIds.add(attributes.Id);
    if (!attributes.Type || !/\/slide$/u.test(attributes.Type)) continue;
    if (attributes.TargetMode === 'External') {
      fail('UNSAFE_PPTX', 'A PowerPoint slide relationship cannot be external.');
    }
    const target = safeSlideRelationshipTarget(attributes.Target);
    if (!target) {
      fail('UNSAFE_PPTX', 'A PowerPoint slide relationship has an unsafe target.');
    }
    slidesByRelationship.set(attributes.Id, target);
  }

  const parts = [];
  const seenParts = new Set();
  const slideIdExpression =
    /<(?:[A-Za-z_][A-Za-z0-9_.-]*:)?sldId\b[^>]*\/?>/gu;
  for (const match of presentationXml.matchAll(slideIdExpression)) {
    if (parts.length >= MAX_SLIDES) {
      fail(
        'PPTX_TOO_MANY_SLIDES',
        `The PowerPoint source contains more than ${MAX_SLIDES} slides.`,
        { maximumSlides: MAX_SLIDES }
      );
    }
    const attributes = parseXmlAttributes(match[0]);
    const relationshipId = attributes['r:id']
      || Object.entries(attributes).find(([key]) => key.endsWith(':id'))?.[1];
    const part = slidesByRelationship.get(relationshipId);
    if (!part) {
      fail(
        'CORRUPT_PPTX',
        'The PowerPoint presentation order contains an unresolved slide relationship.'
      );
    }
    if (seenParts.has(part)) {
      fail('CORRUPT_PPTX', 'The PowerPoint presentation order repeats a slide part.');
    }
    seenParts.add(part);
    parts.push(part);
  }
  if (parts.length < 1) {
    fail('CORRUPT_PPTX', 'The PowerPoint presentation does not contain any slides.');
  }
  return parts;
}

async function openPptxDeck(buffer) {
  const archive = await loadArchive(buffer);
  const [presentationXml, relationshipsXml] = await Promise.all([
    readXmlPart(
      archive,
      'ppt/presentation.xml',
      'The PowerPoint presentation order'
    ),
    readXmlPart(
      archive,
      'ppt/_rels/presentation.xml.rels',
      'The PowerPoint presentation relationships'
    )
  ]);
  return {
    archive,
    deckSha256: crypto.createHash('sha256').update(buffer).digest('hex'),
    slideParts: orderedSlideParts(presentationXml, relationshipsXml)
  };
}

function truncatePreview(value) {
  if (value.length <= MAX_PREVIEW_CHARS) return value;
  let end = MAX_PREVIEW_CHARS;
  const previous = value.charCodeAt(end - 1);
  const next = value.charCodeAt(end);
  if (previous >= 0xd800
    && previous <= 0xdbff
    && next >= 0xdc00
    && next <= 0xdfff) {
    end -= 1;
  }
  return value.slice(0, end);
}

function laneOptions(lane) {
  const includeColors = LANE_COLOR_FILTERS[lane];
  return {
    maximumCharacters: MAX_SLIDE_TEXT_CHARS,
    // Paragraphs made empty only because another color lane was filtered out
    // are not lyric lines in the selected lane.
    preserveEmptyParagraphs: false,
    ...(includeColors
      ? {
          includeColors,
          includeFields: false,
          includeTabs: false
        }
      : {})
  };
}

function extractLane(xml, lane, slideNumber) {
  let extracted;
  try {
    extracted = extractStyledTextFromSlideXml(xml, laneOptions(lane));
  } catch (error) {
    if (error instanceof PptxStyledTextError) {
      fail(
        'CORRUPT_PPTX',
        `PowerPoint slide ${slideNumber} could not be read deterministically.`,
        { slideNumber, lane }
      );
    }
    throw error;
  }
  if (extracted.truncated || extracted.text.length > MAX_SLIDE_TEXT_CHARS) {
    fail(
      'PPTX_TEXT_TOO_LARGE',
      `PowerPoint slide ${slideNumber} exceeds the per-slide text limit.`,
      { slideNumber, lane, maximumCharacters: MAX_SLIDE_TEXT_CHARS }
    );
  }
  const lines = extracted.text ? extracted.text.split('\n') : [];
  return {
    lines,
    preview: truncatePreview(extracted.text),
    lineCount: lines.length
  };
}

function slideTextStructure(xml, slideNumber) {
  const textShapes = [];
  const shapeExpression =
    /<(?:[A-Za-z_][A-Za-z0-9_.-]*:)?sp\b[\s\S]*?<\/(?:[A-Za-z_][A-Za-z0-9_.-]*:)?sp>/gu;
  for (const match of xml.matchAll(shapeExpression)) {
    const block = match[0];
    if (!/<(?:[A-Za-z_][A-Za-z0-9_.-]*:)?(?:t|fld)\b/gu.test(block)) {
      continue;
    }
    if (textShapes.length >= MAX_TEXT_SHAPES_PER_SLIDE) {
      fail(
        'PPTX_STRUCTURE_TOO_LARGE',
        `PowerPoint slide ${slideNumber} has too many text shapes.`,
        {
          slideNumber,
          maximumTextShapes: MAX_TEXT_SHAPES_PER_SLIDE
        }
      );
    }
    const nonVisualTag = block.match(
      /<(?:[A-Za-z_][A-Za-z0-9_.-]*:)?cNvPr\b[^>]*\/?>/u
    )?.[0] || '';
    const shapePropertiesTag = block.match(
      /<(?:[A-Za-z_][A-Za-z0-9_.-]*:)?cNvSpPr\b[^>]*\/?>/u
    )?.[0] || '';
    const placeholderTag = block.match(
      /<(?:[A-Za-z_][A-Za-z0-9_.-]*:)?ph\b[^>]*\/?>/u
    )?.[0] || '';
    const nonVisual = parseXmlAttributes(nonVisualTag);
    const shapeProperties = parseXmlAttributes(shapePropertiesTag);
    const placeholder = parseXmlAttributes(placeholderTag);
    const name = String(nonVisual.name || '');
    const placeholderType = String(placeholder.type || '');
    const placeholderIndex = String(placeholder.idx || '');
    if (
      name.length > MAX_SHAPE_NAME_CHARS
      || /[\0\r\n]/u.test(name)
      || placeholderType.length > 64
      || !/^[A-Za-z0-9_.-]*$/u.test(placeholderType)
      || placeholderIndex.length > 16
      || !/^\d*$/u.test(placeholderIndex)
    ) {
      fail(
        'CORRUPT_PPTX',
        `PowerPoint slide ${slideNumber} has invalid text-shape metadata.`,
        { slideNumber }
      );
    }
    textShapes.push({
      name,
      placeholderType,
      placeholderIndex,
      textBox: shapeProperties.txBox === '1'
    });
  }
  return { textShapes };
}

function hasExactTextShape(slide, expected) {
  return slide.structure.textShapes.some(shape =>
    shape.name === expected.name
    && shape.placeholderIndex === expected.placeholderIndex
    && shape.textBox === expected.textBox);
}

function discoverPptxSongReviewCandidates(slides) {
  const candidates = [];
  const titleShape = {
    name: 'Content Placeholder 2',
    placeholderIndex: '1',
    textBox: false
  };
  const bodyShape = {
    name: 'TextBox 3',
    placeholderIndex: '',
    textBox: true
  };
  for (let index = 0; index < slides.length; index += 1) {
    const title = slides[index];
    if (
      title.lanes.all.lineCount < 1
      || title.structure.textShapes.length !== 1
      || !hasExactTextShape(title, titleShape)
    ) {
      continue;
    }
    let bodyEnd = index + 1;
    while (
      bodyEnd < slides.length
      && slides[bodyEnd].lanes.all.lineCount > 0
      && hasExactTextShape(slides[bodyEnd], bodyShape)
    ) {
      bodyEnd += 1;
    }
    const bodySlideCount = bodyEnd - index - 1;
    if (bodySlideCount < 2 || bodySlideCount > MAX_SELECTED_SLIDES) continue;
    if (candidates.length >= MAX_REVIEW_CANDIDATES) {
      fail(
        'PPTX_STRUCTURE_TOO_LARGE',
        `The PowerPoint source contains more than ${MAX_REVIEW_CANDIDATES} structural song-review ranges.`,
        { maximumCandidates: MAX_REVIEW_CANDIDATES }
      );
    }
    const startSlide = title.number + 1;
    const endSlide = slides[bodyEnd - 1].number;
    candidates.push({
      id: `slides-${title.number}-${startSlide}-${endSlide}`,
      kind: CURRENT_SERVICE_SONG_REVIEW_CANDIDATE_KIND,
      titleSlide: title.number,
      startSlide,
      endSlide,
      evidence: {
        kind: 'template-text-shape-run',
        bodySlideCount,
        titleShapeName: titleShape.name,
        titlePlaceholderIndex: titleShape.placeholderIndex,
        bodyShapeName: bodyShape.name
      }
    });
    index = bodyEnd - 1;
  }
  return candidates;
}

async function readSlideXml(deck, slideNumber, slideBudget) {
  const part = deck.slideParts[slideNumber - 1];
  if (!part) {
    fail(
      'INVALID_SLIDE_SELECTION',
      `Slide ${slideNumber} is outside this ${deck.slideParts.length}-slide deck.`,
      { slideNumber, slideCount: deck.slideParts.length }
    );
  }
  return readXmlPart(
    deck.archive,
    part,
    `PowerPoint slide ${slideNumber}`,
    slideBudget
  );
}

/**
 * Inspect exact PPTX bytes and expose bounded text lanes in presentation order.
 *
 * Only direct #FFFFFF and #FFFF00 run colors enter the named color lanes.
 * Theme and inherited colors remain available through the all lane.
 */
async function inspectPptxSongSlides(buffer) {
  const deck = await openPptxDeck(buffer);
  const slides = [];
  const discoverySlides = [];
  const slideBudget = { bytes: 0 };
  let totalCharacters = 0;
  let totalLines = 0;
  for (let index = 0; index < deck.slideParts.length; index += 1) {
    const number = index + 1;
    const xml = await readSlideXml(deck, number, slideBudget);
    const lanes = {
      all: extractLane(xml, 'all', number),
      white: extractLane(xml, 'white', number),
      yellow: extractLane(xml, 'yellow', number)
    };
    const structure = slideTextStructure(xml, number);
    for (const lane of Object.values(lanes)) {
      totalCharacters += lane.lines.reduce((sum, line) => sum + line.length, 0);
      totalLines += lane.lineCount;
    }
    if (totalCharacters > MAX_INSPECTION_TEXT_CHARS
      || totalLines > MAX_INSPECTION_LINES) {
      fail(
        'PPTX_TEXT_TOO_LARGE',
        'The PowerPoint source exceeds the bounded inspection text limit.',
        {
          maximumCharacters: MAX_INSPECTION_TEXT_CHARS,
          maximumLines: MAX_INSPECTION_LINES
        }
      );
    }
    slides.push({ number, lanes });
    discoverySlides.push({ number, lanes, structure });
  }
  const candidates = discoverPptxSongReviewCandidates(discoverySlides);
  return deepFreeze({
    schemaVersion: CURRENT_SERVICE_SONG_SLIDES_SCHEMA_VERSION,
    kind: CURRENT_SERVICE_SONG_SLIDES_KIND,
    deckSha256: deck.deckSha256,
    slideCount: deck.slideParts.length,
    slides,
    candidates
  });
}

function sameLines(left, right) {
  return left.length === right.length
    && left.every((line, index) => line === right[index]);
}

function ensureCanonicalLines(extractedSections, normalizedSong) {
  for (let index = 0; index < extractedSections.length; index += 1) {
    const extracted = extractedSections[index].slides[0].lines;
    const normalized = normalizedSong.sections[index]?.slides[0]?.lines;
    if (!normalized || !sameLines(extracted, normalized)) {
      fail(
        'SOURCE_TEXT_NOT_CANONICAL',
        'The selected PowerPoint text cannot be represented without normalization.',
        { section: index + 1 }
      );
    }
  }
}

/**
 * Build one private, review-only SongDocument draft from explicit slide and
 * color-lane selections. Noncontiguous selections are supported when they are
 * unique and strictly increasing.
 */
async function buildPptxSongDraft(buffer, rawOptions) {
  const options = normalizeBuildOptions(rawOptions);
  const deck = await openPptxDeck(buffer);
  for (const slideNumber of options.slideNumbers) {
    if (slideNumber > deck.slideParts.length) {
      fail(
        'INVALID_SLIDE_SELECTION',
        `Slide ${slideNumber} is outside this ${deck.slideParts.length}-slide deck.`,
        { slideNumber, slideCount: deck.slideParts.length }
      );
    }
  }

  const sections = [];
  const slideBudget = { bytes: 0 };
  let totalTextBytes = 0;
  let totalLines = 0;
  for (const [index, slideNumber] of options.slideNumbers.entries()) {
    const xml = await readSlideXml(deck, slideNumber, slideBudget);
    const selectedLane = options.slideLanes[index];
    const extracted = extractLane(xml, selectedLane, slideNumber);
    if (!extracted.lines.some(line => line.length > 0)) {
      fail(
        'EMPTY_SELECTED_LANE',
        `Slide ${slideNumber} has no text in the ${selectedLane} lane.`,
        { slideNumber, lane: selectedLane }
      );
    }
    totalLines += extracted.lines.length;
    totalTextBytes += Buffer.byteLength(extracted.lines.join('\n'), 'utf8');
    if (totalLines > MAX_DRAFT_LINES || totalTextBytes > MAX_DRAFT_TEXT_BYTES) {
      fail(
        'PPTX_TEXT_TOO_LARGE',
        'The selected PowerPoint lyrics exceed the bounded song draft limit.',
        {
          maximumBytes: MAX_DRAFT_TEXT_BYTES,
          maximumLines: MAX_DRAFT_LINES
        }
      );
    }
    const provisional = `P${index + 1}`;
    sections.push({
      id: provisional.toLowerCase(),
      marker: provisional,
      label: provisional,
      slides: [{
        id: `${provisional.toLowerCase()}-slide-1`,
        lines: extracted.lines
      }]
    });
  }

  const capturedTextSha256 = capturedSlideTextSha256(sections);
  let song;
  try {
    song = normalizeSongDocument({
      schemaVersion: SONG_SCHEMA_VERSION,
      id: slugify(options.title),
      title: options.title,
      language: options.language,
      translationOf: null,
      license: '',
      tags: [],
      authors: [],
      translators: [],
      composers: [],
      source: options.sourceLabel,
      attribution: '',
      // These deterministic fields survive the ordinary Song Library editor
      // and local save. They identify the derivative source without claiming
      // that the later human confirmation is itself a durable audit receipt.
      extraMetadata: {
        syncshow_capture_kind: 'current-service-pptx',
        syncshow_capture_deck_sha256: deck.deckSha256,
        syncshow_capture_deck_slides: String(deck.slideParts.length),
        syncshow_capture_selected_slides: options.slideNumbers.join(','),
        // This hashes only the ordered canonical slide-line arrays. Section
        // relabeling can preserve it; lyric, slide-boundary, or ordering edits
        // cannot. It records extraction origin, not a reviewer receipt.
        syncshow_capture_text_sha256: capturedTextSha256,
        syncshow_capture_text_lane:
          new Set(options.slideLanes).size === 1
            ? options.slideLanes[0]
            : 'per-slide',
        syncshow_capture_slide_lanes: compactSlideLaneRuns(
          options.slideNumbers,
          options.slideLanes
        )
      },
      sections
    });
  } catch (error) {
    if (error instanceof SongDocumentError) {
      fail(
        'INVALID_SONG_DRAFT',
        'The selected PowerPoint text is not a valid canonical song draft.',
        { causeCode: error.code }
      );
    }
    throw error;
  }
  ensureCanonicalLines(sections, song);

  return deepFreeze({
    song,
    warnings: [
      {
        code: 'PROVISIONAL_SECTION_LABELS',
        message:
          'P1, P2, and later section labels preserve slide boundaries but require human review.'
      },
      {
        code: 'CREDITS_AND_RIGHTS_NOT_INFERRED',
        message:
          'Credits, copyright, licensing, and sharing permission were not inferred from slide text.'
      },
      ...(new Set(options.slideLanes).size > 1
        ? [{
            code: 'PER_SLIDE_TEXT_LANES',
            message:
              'Text-lane colors vary by slide and are not language labels. Confirm the intended language text on every slide.'
          }]
        : [])
    ],
    provenance: {
      schemaVersion: CURRENT_SERVICE_SONG_SLIDES_SCHEMA_VERSION,
      kind: CURRENT_SERVICE_SONG_DRAFT_PROVENANCE_KIND,
      deckSha256: deck.deckSha256,
      deckSlideCount: deck.slideParts.length,
      slideNumbers: [...options.slideNumbers],
      textSha256: capturedTextSha256,
      lane: new Set(options.slideLanes).size === 1
        ? options.slideLanes[0]
        : 'per-slide',
      slideLanes: [...options.slideLanes],
      sourceLabel: options.sourceLabel
    }
  });
}

module.exports = {
  CURRENT_SERVICE_SONG_DRAFT_PROVENANCE_KIND,
  CURRENT_SERVICE_SONG_REVIEW_CANDIDATE_KIND,
  CURRENT_SERVICE_SONG_SLIDES_KIND,
  CURRENT_SERVICE_SONG_SLIDES_SCHEMA_VERSION,
  CurrentServiceSongDraftError,
  buildPptxSongDraft,
  inspectPptxSongSlides
};
