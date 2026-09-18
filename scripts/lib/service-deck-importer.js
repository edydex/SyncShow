'use strict';

const crypto = require('crypto');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');

const JSZip = require('jszip');
const sharp = require('sharp');

const {
  LocalSongLibrary,
  OUTPUT_ONLY_SONG_PROVIDER,
  ServiceProjectStore,
  addGroupItem,
  addProjectItem,
  addSongResource,
  compareSongTranslations,
  createServiceProject,
  imageFormatFromMagic,
  normalizeServiceProject,
  normalizeSongDocument,
  serializeServiceProject,
  serializeSongDocument
} = require('../../src/services/project');
const {
  PptxStyledTextError,
  extractStyledParagraphsFromSlideXml: extractSharedStyledParagraphsFromSlideXml
} = require('../../src/services/sermon/PptxStyledText');

const MANIFEST_SCHEMA_VERSION = 1;
const MAX_MANIFEST_BYTES = 2 * 1024 * 1024;
const MAX_DECK_BYTES = 500 * 1024 * 1024;
const MAX_SLIDES = 10000;
const MAX_SLIDE_XML_BYTES = 20 * 1024 * 1024;
const MAX_IMAGE_BYTES = 75 * 1024 * 1024;
const MAX_EMPHASIS_COLORS = 16;
const UKRAINIAN_HOMOGLYPH_NORMALIZATION = 'ukrainian-cyrillic-homoglyphs-v1';
const CYRILLIC_HOMOGLYPH_NORMALIZATION = 'cyrillic-homoglyphs-v1';
const LATIN_HOMOGLYPH_NORMALIZATION = 'latin-homoglyphs-v1';
const REPEAT_MARKER_NORMALIZATION = 'repeat-marker-multiplication-v1';
const UKRAINIAN_HOMOGLYPHS = Object.freeze({
  O: 'О',
  a: 'а',
  e: 'е',
  c: 'с',
  x: 'х',
  o: 'о',
  i: 'і',
  T: 'Т',
  p: 'р',
  I: 'І',
  X: 'Х'
});
const CYRILLIC_HOMOGLYPHS = Object.freeze({
  A: 'А',
  B: 'В',
  C: 'С',
  E: 'Е',
  H: 'Н',
  K: 'К',
  M: 'М',
  O: 'О',
  P: 'Р',
  T: 'Т',
  X: 'Х',
  a: 'а',
  c: 'с',
  e: 'е',
  o: 'о',
  p: 'р',
  x: 'х'
});
const LATIN_HOMOGLYPHS = Object.freeze(
  Object.fromEntries(Object.entries(CYRILLIC_HOMOGLYPHS)
    .map(([latin, cyrillic]) => [cyrillic, latin]))
);
const FORBIDDEN_CONTENT_KEYS = new Set([
  'body',
  'bodyText',
  'lines',
  'lyricLines',
  'lyrics',
  'sourceText',
  'textByChannel'
]);

class ServiceDeckImportError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'ServiceDeckImportError';
    this.code = code;
    this.details = details;
  }
}

function fail(code, message, details = {}) {
  throw new ServiceDeckImportError(code, message, details);
}

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function requireRecord(value, field) {
  if (!isRecord(value)) fail('INVALID_MANIFEST', `${field} must be an object.`, { field });
  return value;
}

function requireText(value, field, maximum = 500) {
  if (typeof value !== 'string' || !value.trim()) {
    fail('INVALID_MANIFEST', `${field} is required.`, { field });
  }
  const result = value.trim();
  if (result.length > maximum) {
    fail('INVALID_MANIFEST', `${field} must be ${maximum} characters or fewer.`, { field, maximum });
  }
  return result;
}

function rejectEmbeddedContent(value, field = 'manifest') {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => rejectEmbeddedContent(entry, `${field}[${index}]`));
    return;
  }
  if (!isRecord(value)) return;
  for (const [key, child] of Object.entries(value)) {
    if (FORBIDDEN_CONTENT_KEYS.has(key)) {
      fail(
        'EMBEDDED_CONTENT_NOT_ALLOWED',
        `${field}.${key} is not allowed. The import manifest may contain only metadata and slide selections; content must come from the PPTX files.`,
        { field: `${field}.${key}` }
      );
    }
    rejectEmbeddedContent(child, `${field}.${key}`);
  }
}

function decodeXmlText(value) {
  return String(value || '').replace(
    /&(?:#(\d+)|#x([0-9a-f]+)|amp|lt|gt|quot|apos);/gi,
    (entity, decimal, hexadecimal) => {
      if (decimal) return String.fromCodePoint(Number.parseInt(decimal, 10));
      if (hexadecimal) return String.fromCodePoint(Number.parseInt(hexadecimal, 16));
      return {
        '&amp;': '&',
        '&lt;': '<',
        '&gt;': '>',
        '&quot;': '"',
        '&apos;': "'"
      }[entity.toLowerCase()] || entity;
    }
  );
}

function parseXmlAttributes(source) {
  const attributes = {};
  const expression = /([A-Za-z_][A-Za-z0-9_.:-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  for (const match of source.matchAll(expression)) {
    attributes[match[1]] = decodeXmlText(match[2] ?? match[3] ?? '');
  }
  return attributes;
}

function normalizeRunColor(value) {
  const normalized = String(value || '').trim().replace(/^#/, '').toUpperCase();
  const presetColors = {
    BLACK: '000000',
    WHITE: 'FFFFFF',
    YELLOW: 'FFFF00'
  };
  if (presetColors[normalized]) return presetColors[normalized];
  return /^[0-9A-F]{6}$/.test(normalized) ? normalized : null;
}

function normalizeColorFilter(value, field) {
  if (value === undefined || value === null) return null;
  const rawColors = Array.isArray(value) ? value : [value];
  if (rawColors.length < 1 || rawColors.length > 64) {
    fail('INVALID_COLOR_FILTER', `${field} must contain 1 to 64 colors.`, { field });
  }
  const colors = new Set();
  for (const [index, rawColor] of rawColors.entries()) {
    const color = normalizeRunColor(rawColor);
    if (!color) {
      fail(
        'INVALID_COLOR_FILTER',
        `${field}[${index}] must be a six-digit RGB color such as #FFFFFF.`,
        { field, value: rawColor }
      );
    }
    colors.add(color);
  }
  return colors;
}

function normalizeExtractedSongText(value, mode, field = 'textNormalization') {
  const text = String(value || '');
  if (mode === undefined || mode === null || mode === '') {
    return { text, replacementCount: 0 };
  }
  if (![
    UKRAINIAN_HOMOGLYPH_NORMALIZATION,
    CYRILLIC_HOMOGLYPH_NORMALIZATION,
    LATIN_HOMOGLYPH_NORMALIZATION,
    REPEAT_MARKER_NORMALIZATION
  ].includes(mode)) {
    fail(
      'INVALID_TEXT_NORMALIZATION',
      `${field} must be "${UKRAINIAN_HOMOGLYPH_NORMALIZATION}" `
        + `"${CYRILLIC_HOMOGLYPH_NORMALIZATION}", `
        + `"${LATIN_HOMOGLYPH_NORMALIZATION}", `
        + `or "${REPEAT_MARKER_NORMALIZATION}".`,
      { field, mode }
    );
  }
  if (mode === REPEAT_MARKER_NORMALIZATION) {
    let replacementCount = 0;
    const normalized = text.replace(
      /(^|[^\p{L}\p{N}])х(?= 2$)/u,
      (_match, prefix) => {
        replacementCount += 1;
        return `${prefix}×`;
      }
    );
    return { text: normalized, replacementCount };
  }
  const replacements = mode === UKRAINIAN_HOMOGLYPH_NORMALIZATION
    ? UKRAINIAN_HOMOGLYPHS
    : mode === CYRILLIC_HOMOGLYPH_NORMALIZATION
      ? CYRILLIC_HOMOGLYPHS
      : LATIN_HOMOGLYPHS;
  let replacementCount = 0;
  const normalized = text.replace(/\p{L}+/gu, token => {
    const eligible = mode === LATIN_HOMOGLYPH_NORMALIZATION
      ? /\p{Script=Latin}/u.test(token)
      : /\p{Script=Cyrillic}/u.test(token)
        || (mode === UKRAINIAN_HOMOGLYPH_NORMALIZATION && /^[OIi]$/.test(token));
    if (!eligible) return token;
    return [...token].map(character => {
      const replacement = replacements[character];
      if (!replacement) return character;
      replacementCount += 1;
      return replacement;
    }).join('');
  });
  return { text: normalized, replacementCount };
}

function normalizeEmphasisColorFilter(value, field) {
  if (value === undefined) return null;
  if (value === null || (Array.isArray(value) && value.length === 0)) return new Set();
  const colors = normalizeColorFilter(value, field);
  if (colors.size > MAX_EMPHASIS_COLORS) {
    fail(
      'INVALID_COLOR_FILTER',
      `${field} may contain at most ${MAX_EMPHASIS_COLORS} colors.`,
      { field, maximum: MAX_EMPHASIS_COLORS }
    );
  }
  return colors;
}

function extractStyledParagraphsFromSlideXml(xml, options = {}) {
  try {
    return extractSharedStyledParagraphsFromSlideXml(xml, options);
  } catch (error) {
    if (error instanceof PptxStyledTextError) {
      fail(error.code, error.message, error.details);
    }
    throw error;
  }
}

function extractParagraphsFromSlideXml(xml, options = {}) {
  return extractStyledParagraphsFromSlideXml(xml, options).map(paragraph => paragraph.text);
}

function expandPositiveIntegerSelection(value, field, maximum = MAX_SLIDES) {
  let values;
  if (Number.isSafeInteger(value)) {
    values = [value];
  } else if (Array.isArray(value)) {
    values = value;
  } else if (isRecord(value)
    && Number.isSafeInteger(value.from)
    && Number.isSafeInteger(value.to)) {
    if (value.to < value.from || value.to - value.from > maximum) {
      fail('INVALID_SLIDE_SELECTION', `${field} has an invalid inclusive range.`, { field });
    }
    values = Array.from({ length: value.to - value.from + 1 }, (_unused, index) => value.from + index);
  } else {
    fail(
      'INVALID_SLIDE_SELECTION',
      `${field} must be a slide number, an array of slide numbers, or { "from": n, "to": n }.`,
      { field }
    );
  }
  if (values.length < 1 || values.length > maximum) {
    fail('INVALID_SLIDE_SELECTION', `${field} must select 1 to ${maximum} entries.`, { field });
  }
  return values.map((entry, index) => {
    if (!Number.isSafeInteger(entry) || entry < 1 || entry > maximum) {
      fail('INVALID_SLIDE_SELECTION', `${field}[${index}] is not a valid one-based number.`, {
        field,
        value: entry
      });
    }
    return entry;
  });
}

function isRangeObject(value) {
  return isRecord(value)
    && Object.keys(value).every(key => ['from', 'to'].includes(key))
    && Number.isSafeInteger(value.from)
    && Number.isSafeInteger(value.to);
}

function resolveSlideSelection(rawSelection, context, field) {
  let selection = rawSelection;
  if (isRecord(selection) && !isRangeObject(selection)) {
    selection = selection[context.channelId]
      ?? selection[context.deckKey]
      ?? selection.default;
  }
  if (selection === undefined) {
    fail(
      'MISSING_SLIDE_SELECTION',
      `${field} does not select slides for channel ${context.channelId} (deck ${context.deckKey}).`,
      { field, ...context }
    );
  }
  return expandPositiveIntegerSelection(selection, field);
}

function selectParagraphs(paragraphs, selection, field) {
  if (selection === undefined || selection === null) return paragraphs;
  const ordinals = expandPositiveIntegerSelection(selection, field, 10000);
  return ordinals.map(ordinal => {
    if (!paragraphs[ordinal - 1]) {
      fail(
        'MISSING_PARAGRAPH',
        `${field} selects paragraph ${ordinal}, but the slide has only ${paragraphs.length} non-empty paragraphs.`,
        { field, ordinal, paragraphCount: paragraphs.length }
      );
    }
    return paragraphs[ordinal - 1];
  });
}

function comparableText(value) {
  return String(value || '')
    .normalize('NFKC')
    .toLocaleLowerCase('en-US')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

function projectedTextLayout(selected, configuredTitle, options = {}) {
  const title = typeof configuredTitle === 'string' && configuredTitle.trim()
    ? configuredTitle.trim()
    : null;
  if (!title || selected.length < 1) return { title, paragraphStart: 0 };

  // The sampled sermon deck repeats its semantic outline as separate
  // PowerPoint text regions. Keeping the first visible region as the native
  // heading preserves that visual hierarchy without rendering it twice.
  if (options.preferFirstParagraphTitle === true && selected.length > 1) {
    return {
      title: selected[0],
      paragraphStart: 1
    };
  }

  // Reading-title slides often store "Reference · Translation" as two text
  // regions while the manifest supplies the same combined accessible title.
  // Remove only exact leading components. If nothing else remains, retain the
  // source regions and omit the separate heading so one clean copy is shown.
  const titleParts = title.split(/\s*[·|]\s*/).map(comparableText).filter(Boolean);
  if (titleParts.length > 1 && selected.length >= titleParts.length) {
    const leading = selected.slice(0, titleParts.length).map(comparableText);
    if (titleParts.every((part, index) => part === leading[index])) {
      if (selected.length === titleParts.length) {
        return { title: null, paragraphStart: 0 };
      }
      return {
        title,
        paragraphStart: titleParts.length
      };
    }
  }
  return { title, paragraphStart: 0 };
}

function projectedTextFromParagraphs(paragraphs, configuredTitle, options = {}) {
  const selected = Array.isArray(paragraphs)
    ? paragraphs.map(paragraph => String(paragraph).trim()).filter(Boolean)
    : [];
  const layout = projectedTextLayout(selected, configuredTitle, options);
  return {
    title: layout.title,
    paragraphs: selected.slice(layout.paragraphStart)
  };
}

function normalizeStyledParagraph(paragraph, field) {
  if (!isRecord(paragraph) || typeof paragraph.text !== 'string') {
    fail('INVALID_EXTRACTED_TEXT', `${field} must contain extracted plain text.`, { field });
  }
  const untrimmed = paragraph.text;
  const leading = untrimmed.length - untrimmed.trimStart().length;
  const trailing = untrimmed.trimEnd().length;
  const normalizedText = untrimmed.slice(leading, trailing);
  if (!normalizedText) return null;
  const rawSpans = paragraph.spans === undefined ? [] : paragraph.spans;
  if (!Array.isArray(rawSpans)) {
    fail('INVALID_EXTRACTED_TEXT_SPANS', `${field}.spans must be an array.`, { field });
  }
  const spans = [];
  for (const [index, span] of rawSpans.entries()) {
    if (!isRecord(span)
      || !Number.isSafeInteger(span.start)
      || !Number.isSafeInteger(span.end)
      || span.start < 0
      || span.end <= span.start
      || span.end > untrimmed.length) {
      fail(
        'INVALID_EXTRACTED_TEXT_SPANS',
        `${field}.spans[${index}] is outside its extracted text.`,
        { field: `${field}.spans[${index}]` }
      );
    }
    const start = Math.max(span.start, leading);
    const end = Math.min(span.end, trailing);
    if (end <= start) continue;
    spans.push({ ...span, start: start - leading, end: end - leading });
  }
  return {
    text: normalizedText,
    ...(spans.length > 0 ? { spans } : {})
  };
}

function projectedStyledTextFromParagraphs(paragraphs, configuredTitle, options = {}) {
  const selected = Array.isArray(paragraphs)
    ? paragraphs
        .map((paragraph, index) => normalizeStyledParagraph(paragraph, `paragraphs[${index}]`))
        .filter(Boolean)
    : [];
  const layout = projectedTextLayout(
    selected.map(paragraph => paragraph.text),
    configuredTitle,
    options
  );
  return {
    title: layout.title,
    paragraphs: selected.slice(layout.paragraphStart)
  };
}

function joinStyledText(parts, separator) {
  const joinedParts = Array.isArray(parts) ? parts : [];
  let text = '';
  const spans = [];
  for (const [index, part] of joinedParts.entries()) {
    if (index > 0) text += separator;
    const offset = text.length;
    text += part.text;
    for (const span of part.spans || []) {
      spans.push({
        ...span,
        start: offset + span.start,
        end: offset + span.end
      });
    }
  }
  return {
    text,
    ...(spans.length > 0 ? { spans } : {})
  };
}

function posixTarget(basePart, target) {
  const normalized = target.startsWith('/')
    ? target.slice(1)
    : path.posix.normalize(path.posix.join(path.posix.dirname(basePart), target));
  if (normalized.startsWith('../') || path.posix.isAbsolute(normalized)) {
    fail('UNSAFE_PPTX_RELATIONSHIP', 'A PPTX relationship points outside the package.', { target });
  }
  return normalized;
}

function relationshipPartFor(partName) {
  return path.posix.join(
    path.posix.dirname(partName),
    '_rels',
    `${path.posix.basename(partName)}.rels`
  );
}

function parseRelationships(xml, sourcePart) {
  const relationships = new Map();
  const expression = /<Relationship\b([^>]*)\/?>/g;
  for (const match of xml.matchAll(expression)) {
    const attributes = parseXmlAttributes(match[1]);
    if (!attributes.Id || !attributes.Target) continue;
    if (attributes.TargetMode === 'External') continue;
    relationships.set(attributes.Id, {
      id: attributes.Id,
      type: attributes.Type || '',
      target: posixTarget(sourcePart, attributes.Target)
    });
  }
  return relationships;
}

function imageFormatFromPath(fileName) {
  const extension = path.posix.extname(fileName).toLowerCase();
  if (extension === '.png') return { format: 'png', mediaType: 'image/png', extension: 'png' };
  if (extension === '.jpg' || extension === '.jpeg') {
    return { format: 'jpeg', mediaType: 'image/jpeg', extension: 'jpg' };
  }
  if (extension === '.webp') return { format: 'webp', mediaType: 'image/webp', extension: 'webp' };
  return null;
}

async function zipEntryBuffer(zip, entryName, maximumBytes, description) {
  const entry = zip.file(entryName);
  if (!entry || entry.dir) {
    fail('PPTX_PART_MISSING', `${description} is missing from the PPTX package.`, { entryName });
  }
  const buffer = await entry.async('nodebuffer');
  if (buffer.length < 1 || buffer.length > maximumBytes) {
    fail('PPTX_PART_TOO_LARGE', `${description} has an unsafe size.`, {
      entryName,
      size: buffer.length,
      maximumBytes
    });
  }
  return buffer;
}

class PptxDeckExtractor {
  constructor(filePath, zip, slideParts) {
    this.filePath = filePath;
    this.zip = zip;
    this.slideParts = slideParts;
    this.slideCount = slideParts.length;
  }

  static async open(filePath) {
    if (typeof filePath !== 'string' || !path.isAbsolute(filePath)) {
      fail('INVALID_DECK_PATH', 'Every PPTX deck path must be absolute.', { filePath });
    }
    const resolved = path.resolve(filePath);
    let stats;
    try {
      stats = await fs.lstat(resolved);
    } catch (error) {
      fail('DECK_UNAVAILABLE', `The PPTX deck is unavailable: ${resolved}`, {
        filePath: resolved,
        cause: error.message
      });
    }
    if (!stats.isFile() || stats.isSymbolicLink() || stats.size < 1 || stats.size > MAX_DECK_BYTES) {
      fail('INVALID_DECK', `The PPTX deck must be a regular file no larger than ${MAX_DECK_BYTES / (1024 * 1024)} MB.`, {
        filePath: resolved,
        size: stats.size
      });
    }
    if (path.extname(resolved).toLowerCase() !== '.pptx') {
      fail('INVALID_DECK', 'Service deck imports must use .pptx files.', { filePath: resolved });
    }

    const zip = await JSZip.loadAsync(await fs.readFile(resolved), {
      createFolders: false,
      checkCRC32: true
    });
    const presentationPart = 'ppt/presentation.xml';
    const presentationXml = (await zipEntryBuffer(
      zip,
      presentationPart,
      MAX_SLIDE_XML_BYTES,
      'PowerPoint presentation order'
    )).toString('utf8');
    const relationshipXml = (await zipEntryBuffer(
      zip,
      relationshipPartFor(presentationPart),
      MAX_SLIDE_XML_BYTES,
      'PowerPoint presentation relationships'
    )).toString('utf8');
    const relationships = parseRelationships(relationshipXml, presentationPart);
    const slideParts = [];
    for (const match of presentationXml.matchAll(/<p:sldId\b([^>]*)\/?>/g)) {
      const relationshipId = parseXmlAttributes(match[1])['r:id'];
      const relationship = relationships.get(relationshipId);
      if (!relationship || !/\/slide$/i.test(relationship.type)) {
        fail('INVALID_PRESENTATION_ORDER', 'A slide in the presentation order has no internal slide relationship.', {
          relationshipId
        });
      }
      slideParts.push(relationship.target);
    }
    if (slideParts.length < 1 || slideParts.length > MAX_SLIDES || new Set(slideParts).size !== slideParts.length) {
      fail('INVALID_PRESENTATION_ORDER', 'The PPTX has an invalid or unsupported slide order.', {
        slideCount: slideParts.length
      });
    }
    return new PptxDeckExtractor(resolved, zip, slideParts);
  }

  _slidePart(oneBasedSlideNumber) {
    if (!Number.isSafeInteger(oneBasedSlideNumber)
      || oneBasedSlideNumber < 1
      || oneBasedSlideNumber > this.slideParts.length) {
      fail('SLIDE_OUT_OF_RANGE', `Slide ${oneBasedSlideNumber} is outside this ${this.slideParts.length}-slide deck.`, {
        filePath: this.filePath,
        slideNumber: oneBasedSlideNumber,
        slideCount: this.slideParts.length
      });
    }
    return this.slideParts[oneBasedSlideNumber - 1];
  }

  async _slideXml(oneBasedSlideNumber) {
    const slidePart = this._slidePart(oneBasedSlideNumber);
    const xml = (await zipEntryBuffer(
      this.zip,
      slidePart,
      MAX_SLIDE_XML_BYTES,
      `PowerPoint slide ${oneBasedSlideNumber}`
    )).toString('utf8');
    return { slidePart, xml };
  }

  async extractSlideText(oneBasedSlideNumber, options = {}) {
    const { xml } = await this._slideXml(oneBasedSlideNumber);
    const paragraphs = extractParagraphsFromSlideXml(xml, {
      includeColors: options.includeColors,
      excludeColors: options.excludeColors
    });
    return selectParagraphs(
      paragraphs,
      options.paragraphs,
      `Slide ${oneBasedSlideNumber} paragraph selection`
    );
  }

  async extractSlideStyledText(oneBasedSlideNumber, options) {
    const extractionOptions = options || {};
    const { xml } = await this._slideXml(oneBasedSlideNumber);
    const paragraphs = extractStyledParagraphsFromSlideXml(xml, {
      includeColors: extractionOptions.includeColors,
      excludeColors: extractionOptions.excludeColors,
      emphasisColors: extractionOptions.emphasisColors
    });
    return selectParagraphs(
      paragraphs,
      extractionOptions.paragraphs,
      `Slide ${oneBasedSlideNumber} paragraph selection`
    );
  }

  async extractSlideImage(oneBasedSlideNumber, options = {}) {
    const imageIndex = options.imageIndex === undefined ? 0 : options.imageIndex;
    if (!Number.isSafeInteger(imageIndex) || imageIndex < 0 || imageIndex > 1000) {
      fail('INVALID_IMAGE_INDEX', 'A slide image index must be a zero-based whole number.', { imageIndex });
    }
    const { slidePart, xml } = await this._slideXml(oneBasedSlideNumber);
    const relationshipName = relationshipPartFor(slidePart);
    const relationshipXml = (await zipEntryBuffer(
      this.zip,
      relationshipName,
      MAX_SLIDE_XML_BYTES,
      `PowerPoint slide ${oneBasedSlideNumber} relationships`
    )).toString('utf8');
    const relationships = parseRelationships(relationshipXml, slidePart);
    const imageParts = [];
    for (const match of xml.matchAll(/<a:blip\b[^>]*(?:r:embed|r:link)\s*=\s*(?:"([^"]+)"|'([^']+)')[^>]*>/g)) {
      const relationshipId = match[1] ?? match[2];
      const relationship = relationships.get(relationshipId);
      if (!relationship || !/\/image$/i.test(relationship.type)) continue;
      if (!imageParts.includes(relationship.target)) imageParts.push(relationship.target);
    }
    const imagePart = imageParts[imageIndex];
    if (!imagePart) {
      fail(
        'SLIDE_IMAGE_NOT_FOUND',
        `Slide ${oneBasedSlideNumber} has ${imageParts.length} embedded image(s), so image index ${imageIndex} is unavailable.`,
        {
          filePath: this.filePath,
          slideNumber: oneBasedSlideNumber,
          imageIndex,
          availableImages: imageParts.length
        }
      );
    }
    const imageFormat = imageFormatFromPath(imagePart);
    if (!imageFormat) {
      fail(
        'UNSUPPORTED_SLIDE_IMAGE',
        `Slide ${oneBasedSlideNumber} uses an image format SyncShow cannot import directly.`,
        { imagePart }
      );
    }
    const buffer = await zipEntryBuffer(
      this.zip,
      imagePart,
      MAX_IMAGE_BYTES,
      `PowerPoint slide ${oneBasedSlideNumber} image`
    );
    return {
      buffer,
      imagePart,
      ...imageFormat
    };
  }
}

function normalizedDeckMap(rawDecks) {
  requireRecord(rawDecks, 'decks');
  const decks = {};
  for (const [rawKey, filePath] of Object.entries(rawDecks)) {
    const key = requireText(rawKey, 'Deck key', 80);
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/.test(key)) {
      fail('INVALID_DECK_KEY', `Deck key ${key} is invalid.`, { key });
    }
    if (typeof filePath !== 'string' || !path.isAbsolute(filePath)) {
      fail('INVALID_DECK_PATH', `Deck ${key} must use an explicit absolute PPTX path.`, { key, filePath });
    }
    decks[key] = path.resolve(filePath);
  }
  if (Object.keys(decks).length < 1) fail('INVALID_DECKS', 'At least one explicit PPTX deck is required.');
  return decks;
}

function normalizedImageMap(rawImages = {}) {
  requireRecord(rawImages, 'images');
  const images = {};
  for (const [rawKey, filePath] of Object.entries(rawImages)) {
    const key = requireText(rawKey, 'Rendered image key', 80);
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/.test(key)) {
      fail('INVALID_IMAGE_KEY', `Rendered image key ${key} is invalid.`, { key });
    }
    if (typeof filePath !== 'string' || !path.isAbsolute(filePath)) {
      fail(
        'INVALID_RENDERED_IMAGE_PATH',
        `Rendered image ${key} must use an explicit absolute PNG, JPEG, or WebP path.`,
        { key, filePath }
      );
    }
    images[key] = path.resolve(filePath);
  }
  return images;
}

function fileIdentityMatches(left, right) {
  return left
    && right
    && left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && left.mtimeMs === right.mtimeMs;
}

async function readExplicitRenderedImage(filePath, imageKey) {
  let before;
  try {
    before = await fs.lstat(filePath);
  } catch (error) {
    fail('RENDERED_IMAGE_UNAVAILABLE', `Rendered image ${imageKey} is unavailable.`, {
      imageKey,
      cause: error.message
    });
  }
  if (!before.isFile()
    || before.isSymbolicLink()
    || before.size < 1
    || before.size > MAX_IMAGE_BYTES) {
    fail(
      'INVALID_RENDERED_IMAGE',
      `Rendered image ${imageKey} must be a regular PNG, JPEG, or WebP no larger than ${MAX_IMAGE_BYTES / (1024 * 1024)} MB.`,
      { imageKey, size: before.size }
    );
  }
  const declared = imageFormatFromPath(filePath);
  if (!declared) {
    fail('INVALID_RENDERED_IMAGE', `Rendered image ${imageKey} must end in .png, .jpg, .jpeg, or .webp.`, {
      imageKey
    });
  }

  const beforeRealPath = await fs.realpath(filePath);
  const handle = await fs.open(filePath, 'r');
  let buffer;
  let opened;
  try {
    opened = await handle.stat();
    if (!fileIdentityMatches(before, opened)) {
      fail('RENDERED_IMAGE_CHANGED', `Rendered image ${imageKey} changed while opening.`);
    }
    buffer = await handle.readFile();
    if (buffer.length !== opened.size) {
      fail('RENDERED_IMAGE_CHANGED', `Rendered image ${imageKey} changed while reading.`);
    }
  } finally {
    await handle.close();
  }
  const after = await fs.lstat(filePath);
  const afterRealPath = await fs.realpath(filePath);
  if (!fileIdentityMatches(opened, after)
    || after.isSymbolicLink()
    || afterRealPath !== beforeRealPath) {
    fail('RENDERED_IMAGE_CHANGED', `Rendered image ${imageKey} changed during import.`);
  }

  const actualFormat = imageFormatFromMagic(buffer);
  if (!actualFormat || actualFormat !== declared.format) {
    fail(
      'RENDERED_IMAGE_TYPE_MISMATCH',
      `Rendered image ${imageKey} does not match its PNG, JPEG, or WebP extension.`,
      { imageKey, expectedFormat: declared.format, actualFormat }
    );
  }
  return {
    buffer,
    imagePart: null,
    sourceName: path.basename(filePath),
    ...declared
  };
}

function normalizeManifest(rawManifest) {
  const manifest = requireRecord(rawManifest, 'manifest');
  rejectEmbeddedContent(manifest);
  if (manifest.schemaVersion !== MANIFEST_SCHEMA_VERSION) {
    fail(
      'UNSUPPORTED_MANIFEST',
      `Service import manifest schema ${manifest.schemaVersion} is unsupported.`,
      { supported: MANIFEST_SCHEMA_VERSION, actual: manifest.schemaVersion }
    );
  }
  const project = requireRecord(manifest.project, 'manifest.project');
  if (!Array.isArray(project.channels) || project.channels.length < 1) {
    fail('INVALID_MANIFEST', 'manifest.project.channels must contain at least one output channel.');
  }
  if (!Array.isArray(manifest.items) || manifest.items.length < 1) {
    fail('INVALID_MANIFEST', 'manifest.items must contain at least one service item.');
  }
  return manifest;
}

function documentFromSongChannel(item, channelId, channelSpec, sections, primarySongId) {
  const metadata = isRecord(channelSpec.song) ? channelSpec.song : {};
  const songId = requireText(metadata.id || `${item.id}-${channelId}`, `Song ${item.id} channel ${channelId} id`, 128);
  return normalizeSongDocument({
    schemaVersion: 1,
    id: songId,
    title: metadata.title || item.title,
    language: metadata.language || 'und',
    translationOf: metadata.translationOf
      ?? (songId === primarySongId ? null : primarySongId),
    license: metadata.license || '',
    tags: metadata.tags || [],
    authors: metadata.authors || [],
    translators: metadata.translators || [],
    composers: metadata.composers || [],
    source: metadata.source || '',
    attribution: metadata.attribution || '',
    extraMetadata: metadata.extraMetadata || {},
    sections
  });
}

function songChannelCatalogEligible(itemId, channelId, channelSpec) {
  const metadata = isRecord(channelSpec.song) ? channelSpec.song : {};
  const values = [
    ['channel catalog', channelSpec.catalog],
    ['song catalog', metadata.catalog]
  ].filter(([_label, value]) => value !== undefined);
  for (const [label, value] of values) {
    if (typeof value !== 'boolean') {
      fail(
        'INVALID_MANIFEST',
        `Song ${itemId} channel ${channelId} ${label} must be true or false.`,
        { itemId, channelId, field: label }
      );
    }
  }
  if (values.length > 1 && values[0][1] !== values[1][1]) {
    fail(
      'INVALID_MANIFEST',
      `Song ${itemId} channel ${channelId} defines conflicting catalog eligibility.`,
      { itemId, channelId }
    );
  }
  return values.length < 1 || values[0][1] !== false;
}

function stableChildId(prefix, parentId, index) {
  const candidate = `${prefix}-${parentId}-${index + 1}`;
  if (candidate.length <= 128 && /^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(candidate)) return candidate;
  const digest = crypto.createHash('sha256').update(candidate).digest('hex').slice(0, 20);
  return `${prefix}-${digest}`;
}

async function extractSongDocuments(item, project, extractors, counters) {
  const channelSpecs = requireRecord(item.channels, `Song ${item.id} channels`);
  if (!Array.isArray(item.sections) || item.sections.length < 1) {
    fail('INVALID_MANIFEST', `Song ${item.id} needs at least one section definition.`);
  }
  const primaryChannelId = item.primaryChannelId
    || project.channelIds.find(channelId => {
      const spec = channelSpecs[channelId];
      return isRecord(spec) && (spec.mode || 'content') === 'content';
    });
  if (!primaryChannelId || !project.channelIds.includes(primaryChannelId)) {
    fail('INVALID_MANIFEST', `Song ${item.id} has no valid primary content channel.`);
  }
  const primarySpec = requireRecord(channelSpecs[primaryChannelId], `Song ${item.id} primary channel`);
  if ((primarySpec.mode || 'content') !== 'content') {
    fail('INVALID_MANIFEST', `Song ${item.id} primary channel must extract content.`);
  }
  const primarySongMetadata = isRecord(primarySpec.song) ? primarySpec.song : {};
  const primarySongId = requireText(
    primarySongMetadata.id || `${item.id}-${primaryChannelId}`,
    `Song ${item.id} primary document id`,
    128
  );

  const documents = new Map();
  for (const channelId of project.channelIds) {
    const channelSpec = channelSpecs[channelId];
    if (!isRecord(channelSpec) || (channelSpec.mode || 'content') !== 'content') continue;
    const deckKey = requireText(channelSpec.deck, `Song ${item.id} channel ${channelId} deck`, 80);
    const extractor = extractors[deckKey];
    if (!extractor) {
      fail('UNKNOWN_DECK', `Song ${item.id} channel ${channelId} uses unknown deck ${deckKey}.`, {
        itemId: item.id,
        channelId,
        deckKey
      });
    }
    const sections = [];
    for (const [sectionIndex, rawSection] of item.sections.entries()) {
      const section = requireRecord(rawSection, `Song ${item.id} section ${sectionIndex + 1}`);
      const sectionId = requireText(section.id, `Song ${item.id} section ${sectionIndex + 1} id`, 128);
      const slideNumbers = resolveSlideSelection(
        section.slides,
        { channelId, deckKey },
        `Song ${item.id} section ${sectionId} slides`
      );
      const slides = [];
      for (const slideNumber of slideNumbers) {
        const paragraphs = await extractor.extractSlideText(slideNumber, {
          paragraphs: channelSpec.paragraphs ?? section.paragraphs,
          includeColors: channelSpec.includeColors ?? section.includeColors,
          excludeColors: channelSpec.excludeColors ?? section.excludeColors
        });
        const rawLines = Array.isArray(paragraphs)
          ? paragraphs.flatMap(paragraph => String(paragraph).split('\n')).filter(Boolean)
          : [];
        const normalizationMode = channelSpec.textNormalization ?? section.textNormalization;
        const lines = rawLines.map(line => {
          const normalized = normalizeExtractedSongText(
            line,
            normalizationMode,
            `Song ${item.id} channel ${channelId} textNormalization`
          );
          counters.normalizedCharacters += normalized.replacementCount;
          if (normalized.replacementCount > 0) {
            const scope = `${item.id}:${channelId}:${normalizationMode}`;
            counters.normalizedCharactersByScope[scope] =
              (counters.normalizedCharactersByScope[scope] || 0)
              + normalized.replacementCount;
          }
          return normalized.text;
        });
        counters.textSlides += 1;
        if (!Array.isArray(lines) || lines.length < 1 || lines.some(line => typeof line !== 'string')) {
          fail(
            'EMPTY_EXTRACTED_SLIDE',
            `Song ${item.id} channel ${channelId} slide ${slideNumber} has no selected text.`,
            { itemId: item.id, channelId, slideNumber }
          );
        }
        slides.push({ lines });
      }
      sections.push({
        id: sectionId,
        marker: section.marker || sectionId,
        label: section.label || section.marker || sectionId,
        slides
      });
    }
    documents.set(
      channelId,
      documentFromSongChannel(item, channelId, channelSpec, sections, primarySongId)
    );
  }

  const primaryDocument = documents.get(primaryChannelId);
  if (!primaryDocument || primaryDocument.translationOf) {
    fail('INVALID_PRIMARY_SONG', `Song ${item.id} primary document must be an original/root song.`);
  }
  for (const [channelId, document] of documents) {
    if (channelId === primaryChannelId) continue;
    const comparison = compareSongTranslations(primaryDocument, document);
    if (!comparison.compatible) {
      fail(
        'TRANSLATION_MISMATCH',
        `Song ${item.id} channel ${channelId} is not structurally aligned with ${primaryChannelId}.`,
        comparison
      );
    }
  }
  const catalogEligibility = new Map();
  for (const channelId of documents.keys()) {
    catalogEligibility.set(
      channelId,
      songChannelCatalogEligible(item.id, channelId, channelSpecs[channelId])
    );
  }
  return { documents, primaryChannelId, catalogEligibility };
}

async function describeImageAsset(extracted, options) {
  const metadata = await sharp(extracted.buffer, {
    animated: true,
    failOn: 'warning',
    limitInputPixels: 64 * 1000 * 1000
  }).metadata();
  if (metadata.format !== extracted.format
    || !Number.isSafeInteger(metadata.width)
    || !Number.isSafeInteger(metadata.height)
    || metadata.width < 1
    || metadata.height < 1
    || (metadata.pages !== undefined && metadata.pages !== 1)) {
    fail('INVALID_EXTRACTED_IMAGE', 'The selected embedded slide image is not a supported single-frame image.');
  }
  const sha256 = crypto.createHash('sha256').update(extracted.buffer).digest('hex');
  const assetId = `sha256:${sha256}`;
  return {
    id: assetId,
    kind: 'image',
    sha256,
    fileName: options.fileName.slice(0, 255),
    storedName: `${sha256}.${extracted.extension}`,
    mediaType: extracted.mediaType,
    size: extracted.buffer.length,
    createdAt: options.createdAt,
    attribution: String(options.attribution || '').trim().slice(0, 500),
    altText: requireText(options.altText, 'Picture alt text', 500),
    width: metadata.width,
    height: metadata.height,
    orientation: Number.isSafeInteger(metadata.orientation) ? metadata.orientation : 1
  };
}

function rawProjectWithAsset(project, asset) {
  const raw = JSON.parse(serializeServiceProject(project));
  raw.assets[asset.id] = asset;
  return normalizeServiceProject(raw);
}

function songVariantFromSpec(itemId, channelId, rawSpec, resourceIds) {
  if (!isRecord(rawSpec)) return { mode: 'hidden' };
  const mode = rawSpec.mode || 'content';
  const titleCardMode = rawSpec.titleCardMode === undefined
    ? null
    : requireText(rawSpec.titleCardMode, `Song ${itemId} channel ${channelId} title card mode`, 16);
  if (titleCardMode && !['full', 'simple'].includes(titleCardMode)) {
    fail(
      'INVALID_MANIFEST',
      `Song ${itemId} channel ${channelId} title card mode must be full or simple.`
    );
  }
  const presentation = titleCardMode ? { titleCardMode } : {};
  if (mode === 'content') {
    const resourceId = resourceIds.get(channelId);
    if (!resourceId) fail('MISSING_SONG_RESOURCE', `Song ${itemId} channel ${channelId} has no extracted document.`);
    return { mode: 'content', resourceId, ...presentation };
  }
  if (mode === 'inherit') {
    return {
      mode,
      from: requireText(rawSpec.from, `Song ${itemId} channel ${channelId} source`, 128),
      ...presentation
    };
  }
  if (mode === 'derive') {
    return {
      mode,
      from: requireText(rawSpec.from, `Song ${itemId} channel ${channelId} source`, 128),
      transform: {
        id: 'first-lines',
        version: 1,
        maxLines: rawSpec.maxLines === undefined ? 2 : rawSpec.maxLines
      },
      ...presentation
    };
  }
  if (mode === 'hidden') return { mode, ...presentation };
  fail('INVALID_MANIFEST', `Song ${itemId} channel ${channelId} has unsupported mode ${mode}.`);
}

async function addManifestItem(state, rawItem, itemIndex) {
  const item = requireRecord(rawItem, `manifest.items[${itemIndex}]`);
  const itemId = requireText(item.id, `manifest.items[${itemIndex}].id`, 128);
  const itemKind = requireText(item.kind, `Item ${itemId} kind`, 40);
  const parentId = item.parentId === undefined || item.parentId === null
    ? null
    : requireText(item.parentId, `Item ${itemId} parentId`, 128);
  const commonOptions = { parentId, now: state.createdAt };

  if (itemKind === 'group') {
    state.project = addGroupItem(state.project, {
      id: itemId,
      title: item.title || 'Section',
      groupKind: item.groupKind || 'section',
      operatorNotes: item.operatorNotes || '',
      parentId,
      now: state.createdAt
    });
    return;
  }

  if (itemKind === 'song') {
    const extracted = await extractSongDocuments(item, state.project, state.extractors, state.counters);
    const resourceIds = new Map();
    for (const [channelId, document] of extracted.documents) {
      const source = serializeSongDocument(document);
      const revision = crypto.createHash('sha256').update(source).digest('hex');
      const catalogEligible = extracted.catalogEligibility.get(channelId) !== false;
      const previous = state.songSources.get(document.id);
      if (previous && previous.revision !== revision) {
        fail(
          'DUPLICATE_SONG_ID',
          `Manifest song id ${document.id} resolves to two different documents.`,
          { songId: document.id }
        );
      }
      state.songSources.set(document.id, {
        song: document,
        source,
        revision,
        primary: (previous?.primary === true) || channelId === extracted.primaryChannelId,
        catalogEligible: (previous?.catalogEligible === true) || catalogEligible
      });
      const pinned = addSongResource(state.project, document, {
        provider: catalogEligible
          ? 'pptx-service-import'
          : OUTPUT_ONLY_SONG_PROVIDER,
        providerId: requireText(item.channels[channelId].deck, `Song ${itemId} deck`, 80),
        itemId: document.id,
        revision
      });
      state.project = pinned.project;
      resourceIds.set(channelId, pinned.resourceId);
      state.resourceCatalogEligibility.set(
        pinned.resourceId,
        state.resourceCatalogEligibility.get(pinned.resourceId) === true || catalogEligible
      );
    }
    const variants = {};
    for (const channelId of state.project.channelIds) {
      variants[channelId] = songVariantFromSpec(itemId, channelId, item.channels[channelId], resourceIds);
    }
    const arrangement = Array.isArray(item.arrangement) && item.arrangement.length > 0
      ? item.arrangement
      : item.sections.map(section => section.id);
    state.project = addProjectItem(state.project, {
      id: itemId,
      kind: 'song',
      title: item.title,
      primaryChannelId: extracted.primaryChannelId,
      variants,
      arrangement: arrangement.map((sectionId, index) => ({
        id: stableChildId('arr', itemId, index),
        sectionId
      })),
      titlePresetId: item.titlePresetId || 'song-title',
      lyricsPresetId: item.lyricsPresetId || 'song-lyrics',
      operatorNotes: item.operatorNotes || ''
    }, commonOptions);
    return;
  }

  if (itemKind === 'sermon' || itemKind === 'notice') {
    const channelSpecs = requireRecord(item.channels, `Item ${itemId} channels`);
    const textByChannel = {};
    const spansByChannel = {};
    const titlesByChannel = {};
    for (const channelId of state.project.channelIds) {
      const channelSpec = channelSpecs[channelId];
      if (!isRecord(channelSpec)) continue;
      const deckKey = requireText(channelSpec.deck, `Item ${itemId} channel ${channelId} deck`, 80);
      const extractor = state.extractors[deckKey];
      if (!extractor) fail('UNKNOWN_DECK', `Item ${itemId} uses unknown deck ${deckKey}.`);
      const slideNumbers = resolveSlideSelection(
        channelSpec.slides ?? item.slides,
        { channelId, deckKey },
        `Item ${itemId} channel ${channelId} slides`
      );
      let rawEmphasisColors;
      if (Object.prototype.hasOwnProperty.call(channelSpec, 'emphasisColors')) {
        rawEmphasisColors = channelSpec.emphasisColors;
      } else if (Object.prototype.hasOwnProperty.call(item, 'emphasisColors')) {
        rawEmphasisColors = item.emphasisColors;
      } else if (itemKind === 'sermon'
        && (item.presetId || 'sermon-point') === 'sermon-notes') {
        // The editable sermon-notes preset is intentionally source-faithful:
        // the sampled service decks use direct #FFC000 runs for Scripture
        // references and selected semantic emphasis. Explicit [] opts out.
        rawEmphasisColors = ['#FFC000'];
      }
      const emphasisColorSet = normalizeEmphasisColorFilter(
        rawEmphasisColors,
        `Item ${itemId} channel ${channelId} emphasisColors`
      );
      const emphasisColors = emphasisColorSet?.size > 0 ? [...emphasisColorSet] : null;
      const slideBodies = [];
      let projectedTitle = channelSpec.title || null;
      for (const slideNumber of slideNumbers) {
        let paragraphs;
        if (emphasisColors) {
          if (typeof extractor.extractSlideStyledText !== 'function') {
            fail(
              'STYLED_TEXT_EXTRACTION_UNSUPPORTED',
              `Item ${itemId} requests inline emphasis, but deck ${deckKey} cannot extract styled text.`,
              { itemId, channelId, deckKey }
            );
          }
          paragraphs = await extractor.extractSlideStyledText(slideNumber, {
            paragraphs: channelSpec.paragraphs,
            includeColors: channelSpec.includeColors,
            excludeColors: channelSpec.excludeColors,
            emphasisColors
          });
        } else {
          paragraphs = (await extractor.extractSlideText(slideNumber, {
            paragraphs: channelSpec.paragraphs,
            includeColors: channelSpec.includeColors,
            excludeColors: channelSpec.excludeColors
          })).map(text => ({ text }));
        }
        state.counters.textSlides += 1;
        if (!Array.isArray(paragraphs) || paragraphs.length < 1) {
          fail('EMPTY_EXTRACTED_SLIDE', `Item ${itemId} channel ${channelId} slide ${slideNumber} has no selected text.`);
        }
        const projected = projectedStyledTextFromParagraphs(paragraphs, projectedTitle, {
          preferFirstParagraphTitle: itemKind === 'sermon'
            && (item.presetId || 'sermon-point') === 'sermon-notes'
            && slideNumbers.length === 1
        });
        projectedTitle = projected.title;
        if (projected.paragraphs.length < 1) {
          fail('EMPTY_EXTRACTED_SLIDE', `Item ${itemId} channel ${channelId} slide ${slideNumber} has no body text after title extraction.`);
        }
        slideBodies.push(joinStyledText(projected.paragraphs, '\n'));
      }
      const channelBody = joinStyledText(slideBodies, '\n\n');
      textByChannel[channelId] = channelBody.text;
      if (channelBody.spans?.length > 0) spansByChannel[channelId] = channelBody.spans;
      if (projectedTitle) titlesByChannel[channelId] = projectedTitle;
    }
    state.project = addProjectItem(state.project, {
      id: itemId,
      kind: itemKind,
      title: item.title,
      textByChannel,
      ...(Object.keys(spansByChannel).length > 0 ? { spansByChannel } : {}),
      ...(Object.keys(titlesByChannel).length > 0 ? { titlesByChannel } : {}),
      presetId: item.presetId || (itemKind === 'sermon' ? 'sermon-point' : 'notice-text'),
      operatorNotes: item.operatorNotes || ''
    }, commonOptions);
    return;
  }

  if (itemKind === 'picture') {
    const channelSpecs = requireRecord(item.channels, `Picture ${itemId} channels`);
    const assetIdsByChannel = {};
    for (const channelId of state.project.channelIds) {
      const channelSpec = channelSpecs[channelId];
      if (!isRecord(channelSpec)) continue;
      const imageKey = channelSpec.image ?? item.image;
      if (imageKey !== undefined && channelSpec.deck !== undefined) {
        fail(
          'AMBIGUOUS_PICTURE_SOURCE',
          `Picture ${itemId} channel ${channelId} must choose either a rendered image key or deck slide extraction.`,
          { itemId, channelId }
        );
      }
      let extracted;
      let sourceName;
      if (imageKey !== undefined) {
        const normalizedKey = requireText(imageKey, `Picture ${itemId} channel ${channelId} image`, 80);
        const imagePath = state.images[normalizedKey];
        if (!imagePath) {
          fail('UNKNOWN_RENDERED_IMAGE', `Picture ${itemId} uses unknown rendered image ${normalizedKey}.`, {
            itemId,
            channelId,
            imageKey: normalizedKey
          });
        }
        if (!state.renderedImageCache.has(normalizedKey)) {
          state.renderedImageCache.set(
            normalizedKey,
            await readExplicitRenderedImage(imagePath, normalizedKey)
          );
        }
        extracted = state.renderedImageCache.get(normalizedKey);
        sourceName = extracted.sourceName;
      } else {
        const deckKey = requireText(channelSpec.deck, `Picture ${itemId} channel ${channelId} deck`, 80);
        const extractor = state.extractors[deckKey];
        if (!extractor) fail('UNKNOWN_DECK', `Picture ${itemId} uses unknown deck ${deckKey}.`);
        const slideNumber = expandPositiveIntegerSelection(
          channelSpec.slide ?? item.slide,
          `Picture ${itemId} channel ${channelId} slide`
        )[0];
        extracted = await extractor.extractSlideImage(slideNumber, {
          imageIndex: channelSpec.imageIndex ?? item.imageIndex ?? 0
        });
        sourceName = `${path.basename(state.decks[deckKey], '.pptx')}-slide-${slideNumber}.${extracted.extension}`;
      }
      state.counters.imageSlides += 1;
      const asset = await describeImageAsset(extracted, {
        fileName: sourceName,
        createdAt: state.createdAt,
        attribution: channelSpec.attribution ?? item.attribution ?? '',
        altText: channelSpec.altText ?? item.altText
      });
      state.project = rawProjectWithAsset(state.project, asset);
      state.assetBuffers.set(asset.id, extracted.buffer);
      assetIdsByChannel[channelId] = asset.id;
    }
    state.project = addProjectItem(state.project, {
      id: itemId,
      kind: 'picture',
      title: item.title,
      assetIdsByChannel,
      fit: item.fit || 'fit',
      focalPoint: item.focalPoint || { x: 0.5, y: 0.5 },
      altText: item.altText,
      attribution: item.attribution || '',
      presetId: item.presetId || 'picture-fullscreen',
      operatorNotes: item.operatorNotes || ''
    }, commonOptions);
    return;
  }

  if (itemKind === 'blank') {
    state.project = addProjectItem(state.project, {
      id: itemId,
      kind: 'blank',
      title: item.title || 'Blank',
      channelIds: item.channelIds || state.project.channelIds,
      presetId: item.presetId || 'blank-black',
      operatorNotes: item.operatorNotes || ''
    }, commonOptions);
    return;
  }

  fail('INVALID_MANIFEST', `Item ${itemId} has unsupported kind ${itemKind}.`, { itemId, itemKind });
}

function projectFingerprint(project) {
  const raw = JSON.parse(serializeServiceProject(project));
  raw.revision = 0;
  raw.updatedAt = raw.createdAt;
  return crypto.createHash('sha256').update(`${JSON.stringify(raw)}\n`).digest('hex');
}

function orderedSongSources(songSources) {
  const ordered = [];
  const visited = new Set();
  const visiting = new Set();
  const visit = (entry, requiredBy = null) => {
    if (entry.catalogEligible === false) {
      if (requiredBy) {
        fail(
          'CATALOG_TRANSLATION_TARGET_EXCLUDED',
          `Catalog song ${requiredBy} depends on output-only song ${entry.song.id}.`,
          { songId: requiredBy, targetId: entry.song.id }
        );
      }
      return;
    }
    if (visited.has(entry.song.id)) return;
    if (visiting.has(entry.song.id)) {
      fail('TRANSLATION_CYCLE', `Song ${entry.song.id} has a circular translation relationship.`);
    }
    visiting.add(entry.song.id);
    const parent = entry.song.translationOf && songSources.get(entry.song.translationOf);
    if (parent) visit(parent, entry.song.id);
    visiting.delete(entry.song.id);
    visited.add(entry.song.id);
    ordered.push(entry);
  };
  [...songSources.values()]
    .filter(entry => entry.catalogEligible !== false)
    .sort((left, right) => Number(right.primary) - Number(left.primary) || left.song.id.localeCompare(right.song.id))
    .forEach(visit);
  return ordered;
}

function summaryForPlan(state) {
  const songs = orderedSongSources(state.songSources).map(entry => ({
    id: entry.song.id,
    title: entry.song.title,
    language: entry.song.language,
    translationOf: entry.song.translationOf,
    revision: entry.revision,
    sectionCount: entry.song.sections.length,
    slideCount: entry.song.sections.reduce((count, section) => count + section.slides.length, 0)
  }));
  return {
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    project: {
      id: state.project.id,
      title: state.project.title,
      serviceDate: state.project.serviceDate,
      fingerprint: projectFingerprint(state.project),
      itemCount: Object.keys(state.project.items).length,
      assetCount: Object.keys(state.project.assets).length
    },
    songs,
    decks: Object.fromEntries(Object.entries(state.extractors).map(([key, extractor]) => [
      key,
      { slideCount: extractor.slideCount }
    ])),
    renderedImages: Object.keys(state.images).sort(),
    extracted: { ...state.counters }
  };
}

async function buildImportPlan(options) {
  const manifest = normalizeManifest(options.manifest);
  const decks = normalizedDeckMap(options.decks);
  const images = normalizedImageMap(options.images || {});
  const extractorFactory = options.extractorFactory || (filePath => PptxDeckExtractor.open(filePath));
  if (typeof extractorFactory !== 'function') {
    throw new TypeError('extractorFactory must be a function');
  }
  const extractors = {};
  for (const [deckKey, filePath] of Object.entries(decks)) {
    const extractor = await extractorFactory(filePath, deckKey);
    if (!extractor
      || typeof extractor.extractSlideText !== 'function'
      || typeof extractor.extractSlideImage !== 'function'
      || !Number.isSafeInteger(extractor.slideCount)
      || extractor.slideCount < 1) {
      fail('INVALID_DECK_EXTRACTOR', `Deck extractor ${deckKey} is invalid.`);
    }
    extractors[deckKey] = extractor;
  }

  const projectManifest = manifest.project;
  const createdAt = projectManifest.createdAt
    || `${requireText(projectManifest.serviceDate, 'Project serviceDate', 10)}T12:00:00.000Z`;
  const project = createServiceProject({
    id: projectManifest.id,
    title: projectManifest.title,
    serviceDate: projectManifest.serviceDate,
    preferredProfileId: projectManifest.preferredProfileId || projectManifest.profileId,
    channels: projectManifest.channels,
    presetPackId: projectManifest.presetPackId,
    presetPackVersion: projectManifest.presetPackVersion,
    now: createdAt
  });
  const state = {
    project,
    createdAt,
    decks,
    images,
    extractors,
    renderedImageCache: new Map(),
    songSources: new Map(),
    resourceCatalogEligibility: new Map(),
    assetBuffers: new Map(),
    counters: {
      textSlides: 0,
      imageSlides: 0,
      normalizedCharacters: 0,
      normalizedCharactersByScope: {}
    }
  };
  for (const [itemIndex, item] of manifest.items.entries()) {
    await addManifestItem(state, item, itemIndex);
  }
  const rawProject = JSON.parse(serializeServiceProject(state.project));
  for (const [resourceId, catalogEligible] of state.resourceCatalogEligibility) {
    const resource = rawProject.resources[resourceId];
    if (!resource) continue;
    resource.origin.provider = catalogEligible
      ? 'pptx-service-import'
      : OUTPUT_ONLY_SONG_PROVIDER;
  }
  state.project = normalizeServiceProject(rawProject);
  return {
    ...state,
    orderedSongSources: orderedSongSources(state.songSources),
    summary: summaryForPlan(state)
  };
}

function liveUserDataRoots() {
  const roots = [
    path.join(os.homedir(), 'Library', 'Application Support', 'sync-show'),
    path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'sync-show'),
    path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'sync-show')
  ];
  return new Set(roots.map(candidate => path.resolve(candidate)));
}

function assertSafeOutputRoot(outputRoot, options = {}) {
  if (typeof outputRoot !== 'string' || !path.isAbsolute(outputRoot)) {
    fail('OUTPUT_ROOT_REQUIRED', 'Applying an import requires an explicit absolute --output-root.');
  }
  const resolved = path.resolve(outputRoot);
  const liveRoot = [...liveUserDataRoots()].find(candidate =>
    resolved === candidate || resolved.startsWith(`${candidate}${path.sep}`));
  if (liveRoot && options.liveUserDataApproved !== true) {
    fail(
      'LIVE_USER_DATA_APPROVAL_REQUIRED',
      'Writing to SyncShow’s live user-data folder requires the explicit --live-user-data-approved flag after the user approves that exact write.',
      { outputRoot: resolved, liveRoot }
    );
  }
  return resolved;
}

async function resolveSafeOutputRoot(outputRoot, options = {}) {
  const requested = assertSafeOutputRoot(outputRoot, options);
  const missingParts = [];
  let existingAncestor = requested;
  while (true) {
    try {
      await fs.lstat(existingAncestor);
      break;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      const parent = path.dirname(existingAncestor);
      if (parent === existingAncestor) throw error;
      missingParts.unshift(path.basename(existingAncestor));
      existingAncestor = parent;
    }
  }
  const realAncestor = await fs.realpath(existingAncestor);
  const resolvedThroughLinks = path.join(realAncestor, ...missingParts);
  return assertSafeOutputRoot(resolvedThroughLinks, options);
}

async function readSongIfPresent(library, songId) {
  try {
    return await library.read(songId);
  } catch (error) {
    if (error?.code === 'SONG_NOT_FOUND') return null;
    throw error;
  }
}

async function readProjectIfPresent(store, projectId) {
  try {
    return await store.read(projectId);
  } catch (error) {
    if (error?.code === 'PROJECT_NOT_FOUND') return null;
    throw error;
  }
}

async function applyImportPlan(plan, options) {
  const outputRoot = await resolveSafeOutputRoot(options.outputRoot, {
    liveUserDataApproved: options.liveUserDataApproved
  });
  const library = new LocalSongLibrary({
    rootPath: path.join(outputRoot, 'song-library'),
    clock: options.clock
  });
  const projectStore = new ServiceProjectStore({
    rootPath: path.join(outputRoot, 'service-projects'),
    clock: options.clock
  });
  await Promise.all([library.initialize(), projectStore.initialize()]);

  const existingSongs = new Map();
  for (const entry of plan.orderedSongSources) {
    const current = await readSongIfPresent(library, entry.song.id);
    if (current && current.revision !== entry.revision) {
      fail(
        'SONG_CONFLICT',
        `Song ${entry.song.id} already exists with different content. No existing song was replaced.`,
        {
          songId: entry.song.id,
          currentRevision: current.revision,
          importRevision: entry.revision
        }
      );
    }
    existingSongs.set(entry.song.id, current);
  }
  const existingProject = await readProjectIfPresent(projectStore, plan.project.id);
  if (existingProject
    && projectFingerprint(existingProject.project) !== projectFingerprint(plan.project)) {
    fail(
      'PROJECT_CONFLICT',
      `Service project ${plan.project.id} already exists with different content. No existing project was replaced.`,
      { projectId: plan.project.id }
    );
  }

  const songs = [];
  for (const entry of plan.orderedSongSources) {
    const current = existingSongs.get(entry.song.id);
    if (current) {
      songs.push({ id: entry.song.id, revision: current.revision, unchanged: true });
      continue;
    }
    const saved = await library.saveSource(entry.source, {
      fileName: `${entry.song.id}.md`,
      expectedRevision: null
    });
    songs.push({ id: entry.song.id, revision: saved.revision, unchanged: saved.unchanged === true });
  }

  const importedProject = await projectStore.importPortableProject(
    plan.project,
    plan.assetBuffers,
    { reason: 'pptx-service-import' }
  );
  return {
    outputRoot,
    songs,
    project: {
      id: importedProject.project.id,
      revisionId: importedProject.revisionId,
      unchanged: importedProject.unchanged === true,
      imported: importedProject.imported === true,
      forked: importedProject.forked === true
    }
  };
}

async function importServiceDecks(options = {}) {
  const plan = await buildImportPlan(options);
  if (options.dryRun !== false) {
    return {
      dryRun: true,
      summary: plan.summary,
      applied: null
    };
  }
  const applied = await applyImportPlan(plan, options);
  return {
    dryRun: false,
    summary: plan.summary,
    applied
  };
}

async function readImportManifest(filePath) {
  if (typeof filePath !== 'string' || !path.isAbsolute(filePath)) {
    fail('INVALID_MANIFEST_PATH', 'The service import manifest path must be absolute.');
  }
  const resolved = path.resolve(filePath);
  const stats = await fs.lstat(resolved);
  if (!stats.isFile() || stats.isSymbolicLink() || stats.size < 1 || stats.size > MAX_MANIFEST_BYTES) {
    fail('INVALID_MANIFEST_PATH', `The manifest must be a regular JSON file no larger than ${MAX_MANIFEST_BYTES / 1024} KB.`);
  }
  let manifest;
  try {
    manifest = JSON.parse(await fs.readFile(resolved, 'utf8'));
  } catch (error) {
    fail('INVALID_MANIFEST_JSON', `The service import manifest is not valid JSON: ${error.message}`);
  }
  return normalizeManifest(manifest);
}

module.exports = {
  MANIFEST_SCHEMA_VERSION,
  PptxDeckExtractor,
  ServiceDeckImportError,
  applyImportPlan,
  assertSafeOutputRoot,
  buildImportPlan,
  extractParagraphsFromSlideXml,
  extractStyledParagraphsFromSlideXml,
  importServiceDecks,
  joinStyledText,
  normalizeExtractedSongText,
  projectFingerprint,
  projectedStyledTextFromParagraphs,
  projectedTextFromParagraphs,
  readImportManifest,
  resolveSafeOutputRoot,
  resolveSlideSelection
};
