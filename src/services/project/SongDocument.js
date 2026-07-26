'use strict';

const crypto = require('crypto');
const path = require('path');

const SONG_SCHEMA_VERSION = 1;
const MAX_SOURCE_BYTES = 512 * 1024;
const MAX_FRONT_MATTER_LINES = 100;
const MAX_SECTIONS = 200;
const MAX_SLIDES = 1000;
const MAX_LINES = 10000;
const MAX_LINE_LENGTH = 1000;
const MAX_ARRANGEMENT_ITEMS = 500;
// Attribution was accepted as arbitrary extra metadata before it became a
// first-class schema-v1 field. Retain that historical 2,048-character bound
// so existing immutable revisions remain readable without a schema migration.
const MAX_ATTRIBUTION_LENGTH = 2048;
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

class SongDocumentError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'SongDocumentError';
    this.code = code;
    this.details = details;
  }
}

function fail(code, message, details = {}) {
  throw new SongDocumentError(code, message, details);
}

function boundedText(value, field, maximum, { required = false } = {}) {
  if (value === undefined || value === null) value = '';
  if (typeof value !== 'string') fail('INVALID_TEXT', `${field} must be text.`, { field });
  const result = value.trim();
  if (required && !result) fail('MISSING_TEXT', `${field} is required.`, { field });
  if (result.length > maximum) {
    fail('TEXT_TOO_LONG', `${field} must be ${maximum} characters or fewer.`, { field, maximum });
  }
  return result;
}

function slugify(value, fallback = 'song') {
  const original = String(value || '');
  const hashSuffix = () => crypto.createHash('sha256')
    .update(original.normalize('NFC'))
    .digest('hex')
    .slice(0, 10);
  const result = String(value || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 96);
  if (result) {
    const lostNonAsciiWord = /[^\x00-\x7F]/.test(original) && /[\p{L}\p{N}]/u.test(original);
    return lostNonAsciiWord ? `${result.slice(0, 84)}-${hashSuffix()}` : result;
  }
  if (!fallback) return '';
  return `${fallback}-${hashSuffix()}`;
}

function normalizeSongId(value, fallback) {
  const id = boundedText(value || fallback, 'Song id', 128, { required: true });
  if (!ID_PATTERN.test(id)) {
    fail(
      'INVALID_SONG_ID',
      'Song id must start with a letter or number and use only letters, numbers, dot, underscore, colon, or hyphen.',
      { id }
    );
  }
  return id;
}

function parseScalar(rawValue, field) {
  const value = rawValue.trim();
  if (value.length > 2048) fail('FRONT_MATTER_TOO_LARGE', `${field} is too long.`, { field });
  if (value.startsWith('"') && value.endsWith('"')) {
    try {
      const parsed = JSON.parse(value);
      if (typeof parsed !== 'string') throw new Error('not text');
      return parsed;
    } catch (_error) {
      fail('INVALID_FRONT_MATTER', `${field} has invalid quoted text.`, { field });
    }
  }
  if (value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1).replace(/''/g, "'");
  }
  if (value.startsWith('[') && value.endsWith(']')) {
    try {
      const parsed = JSON.parse(value);
      if (!Array.isArray(parsed) || parsed.some(item => typeof item !== 'string')) throw new Error('not a string list');
      return parsed;
    } catch (_error) {
      const inner = value.slice(1, -1).trim();
      if (!inner) return [];
      return inner.split(',').map(item => item.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean);
    }
  }
  return value;
}

function parseFrontMatter(lines) {
  if (lines[0]?.trim() !== '---') return { metadata: {}, bodyStart: 0 };
  const end = lines.slice(1, MAX_FRONT_MATTER_LINES + 1).findIndex(line => line.trim() === '---');
  if (end === -1) fail('UNCLOSED_FRONT_MATTER', 'The song metadata starts with --- but has no closing --- line.');

  const metadata = {};
  for (let index = 1; index <= end; index += 1) {
    const line = lines[index];
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const match = /^([A-Za-z][A-Za-z0-9_-]{0,63})\s*:\s*(.*)$/.exec(line);
    if (!match) {
      fail('INVALID_FRONT_MATTER', `Song metadata line ${index + 1} must use “name: value”.`, {
        line: index + 1
      });
    }
    const key = match[1];
    if (Object.prototype.hasOwnProperty.call(metadata, key)) {
      fail('DUPLICATE_FRONT_MATTER_KEY', `Song metadata repeats “${key}”.`, { key });
    }
    metadata[key] = parseScalar(match[2], key);
  }
  return { metadata, bodyStart: end + 2 };
}

function normalizedStringList(value, field, maximum = 64) {
  if (value === undefined || value === null || value === '') return [];
  const list = Array.isArray(value) ? value : String(value).split(',');
  if (list.length > maximum) fail('TOO_MANY_VALUES', `${field} has too many values.`, { field, maximum });
  const result = [];
  const seen = new Set();
  for (const item of list) {
    const normalized = boundedText(String(item), field, 120);
    if (!normalized || seen.has(normalized.toLowerCase())) continue;
    seen.add(normalized.toLowerCase());
    result.push(normalized);
  }
  return result;
}

function markerIdentity(rawMarker) {
  const marker = boundedText(rawMarker, 'Section marker', 64, { required: true });
  const numeric = /^(?:v(?:erse)?\s*)?(\d{1,3})$/i.exec(marker);
  if (numeric) {
    const number = Number.parseInt(numeric[1], 10);
    return { id: `verse-${number}`, marker: String(number), label: `Verse ${number}` };
  }

  const compact = marker.toLowerCase().replace(/[\s_-]+/g, ' ').trim();
  const known = {
    chorus: ['chorus', 'Chorus'],
    refrain: ['chorus', 'Chorus'],
    bridge: ['bridge', 'Bridge'],
    tag: ['tag', 'Tag'],
    intro: ['intro', 'Intro'],
    outro: ['outro', 'Outro'],
    prechorus: ['pre-chorus', 'Pre-chorus'],
    'pre chorus': ['pre-chorus', 'Pre-chorus']
  };
  if (known[compact]) {
    return { id: known[compact][0], marker: known[compact][0], label: known[compact][1] };
  }
  return { id: slugify(marker, 'section'), marker, label: marker };
}

function normalizeSongDocument(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail('INVALID_SONG', 'Song document must be an object.');
  if (raw.schemaVersion !== SONG_SCHEMA_VERSION) {
    fail('UNSUPPORTED_SONG_SCHEMA', `Song schema version ${raw.schemaVersion} is not supported.`, {
      supported: SONG_SCHEMA_VERSION,
      actual: raw.schemaVersion
    });
  }
  const rawExtraMetadata = raw.extraMetadata === undefined ? {} : raw.extraMetadata;
  if (!rawExtraMetadata || typeof rawExtraMetadata !== 'object' || Array.isArray(rawExtraMetadata)) {
    fail('INVALID_EXTRA_METADATA', 'Song extraMetadata must be an object.');
  }
  const legacyAttribution = typeof rawExtraMetadata.attribution === 'string'
    ? rawExtraMetadata.attribution
    : '';
  const legacyTranslators = rawExtraMetadata.translators;
  const legacyComposers = rawExtraMetadata.composers ?? rawExtraMetadata.music;
  if (raw.attribution !== undefined
    && legacyAttribution
    && boundedText(raw.attribution, 'Song attribution', MAX_ATTRIBUTION_LENGTH)
      !== boundedText(legacyAttribution, 'Song attribution', MAX_ATTRIBUTION_LENGTH)) {
    fail('DUPLICATE_ATTRIBUTION', 'Song attribution is defined twice with different values.');
  }
  const song = {
    schemaVersion: SONG_SCHEMA_VERSION,
    id: normalizeSongId(raw.id, null),
    title: boundedText(raw.title, 'Song title', 200, { required: true }),
    language: boundedText(raw.language || 'und', 'Song language', 35, { required: true }),
    translationOf: raw.translationOf ? normalizeSongId(raw.translationOf, null) : null,
    license: boundedText(raw.license || '', 'Song license', 300),
    tags: normalizedStringList(raw.tags, 'Song tags'),
    authors: normalizedStringList(raw.authors, 'Song authors'),
    translators: normalizedStringList(
      raw.translators !== undefined ? raw.translators : legacyTranslators,
      'Song translators'
    ),
    composers: normalizedStringList(
      raw.composers !== undefined ? raw.composers : legacyComposers,
      'Song composers'
    ),
    source: boundedText(raw.source || '', 'Song source', 500),
    attribution: boundedText(
      raw.attribution !== undefined ? raw.attribution : legacyAttribution,
      'Song attribution',
      MAX_ATTRIBUTION_LENGTH
    ),
    extraMetadata: {},
    sections: []
  };
  if (raw.extraMetadata !== undefined) {
    const entries = Object.entries(rawExtraMetadata);
    if (entries.length > 64) fail('TOO_MUCH_EXTRA_METADATA', 'Song metadata has too many custom fields.');
    for (const [key, value] of entries) {
      if (!/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(key)) {
        fail('INVALID_EXTRA_METADATA', `Song metadata key “${key}” is invalid.`, { key });
      }
      if (['attribution', 'translators', 'composers', 'music'].includes(key)) continue;
      if ([
        'id', 'title', 'language', 'translationOf', 'license', 'tags',
        'authors', 'translators', 'composers', 'source', 'attribution'
      ].includes(key)) {
        fail('RESERVED_EXTRA_METADATA', `Song metadata key “${key}” is reserved.`, { key });
      }
      if (typeof value === 'string') song.extraMetadata[key] = boundedText(value, `Song metadata ${key}`, 2048);
    }
  }
  if (!Array.isArray(raw.sections) || raw.sections.length < 1 || raw.sections.length > MAX_SECTIONS) {
    fail('INVALID_SECTIONS', `A song must contain 1 to ${MAX_SECTIONS} sections.`);
  }
  const ids = new Set();
  let slideCount = 0;
  let lineCount = 0;
  let hasLyrics = false;
  for (const [sectionIndex, rawSection] of raw.sections.entries()) {
    if (!rawSection || typeof rawSection !== 'object' || Array.isArray(rawSection)) {
      fail('INVALID_SECTION', `Song section ${sectionIndex + 1} must be an object.`);
    }
    const sectionId = normalizeSongId(rawSection.id, null);
    if (ids.has(sectionId)) fail('DUPLICATE_SECTION', `Section “${sectionId}” appears more than once.`, { sectionId });
    ids.add(sectionId);
    const marker = boundedText(rawSection.marker || sectionId, `Section ${sectionId} marker`, 64, { required: true });
    if (/[\r\n\0]/.test(marker) || marker.startsWith('^')) {
      fail('INVALID_SECTION_MARKER', `Section ${sectionId} has an invalid marker.`, { sectionId });
    }
    if (!Array.isArray(rawSection.slides) || rawSection.slides.length < 1) {
      fail('INVALID_SECTION_SLIDES', `Section ${sectionId} must contain at least one slide.`, { sectionId });
    }
    const slides = rawSection.slides.map((rawSlide, slideIndex) => {
      slideCount += 1;
      if (slideCount > MAX_SLIDES) fail('TOO_MANY_SLIDES', `A song can contain at most ${MAX_SLIDES} slides.`);
      if (!rawSlide || typeof rawSlide !== 'object' || !Array.isArray(rawSlide.lines)) {
        fail('INVALID_SLIDE', `Section ${sectionId} slide ${slideIndex + 1} is invalid.`);
      }
      lineCount += rawSlide.lines.length;
      if (lineCount > MAX_LINES) fail('TOO_MANY_LINES', `A song can contain at most ${MAX_LINES} lyric lines.`);
      const lines = normalizeLines(rawSlide.lines);
      if (lines.some(Boolean)) hasLyrics = true;
      return { id: `${sectionId}-slide-${slideIndex + 1}`, lines };
    });
    song.sections.push({
      id: sectionId,
      marker,
      label: boundedText(rawSection.label || marker, `Section ${sectionId} label`, 100, { required: true }),
      slides
    });
  }
  if (!hasLyrics) fail('EMPTY_SONG', 'Add at least one lyric line to this song.');
  return song;
}

function normalizeLines(lines) {
  const result = [];
  let previousBlank = false;
  for (const rawLine of lines) {
    if (typeof rawLine !== 'string') fail('INVALID_LYRIC_LINE', 'Every lyric line must be text.');
    if (/[\r\n\0]/.test(rawLine)) {
      fail('INVALID_LYRIC_LINE', 'A lyric line cannot contain an embedded line break or null character.');
    }
    if (rawLine.length > MAX_LINE_LENGTH) {
      fail('LYRIC_LINE_TOO_LONG', `Lyric lines must be ${MAX_LINE_LENGTH} characters or fewer.`, {
        maximum: MAX_LINE_LENGTH
      });
    }
    const line = rawLine.replace(/[ \t]+$/g, '');
    const blank = line.length === 0;
    if (blank && previousBlank) continue;
    result.push(line);
    previousBlank = blank;
  }
  while (result[0] === '') result.shift();
  while (result.at(-1) === '') result.pop();
  return result;
}

function parseSongDocument(source, options = {}) {
  if (typeof source !== 'string') fail('INVALID_SOURCE', 'Song source must be UTF-8 text.');
  if (Buffer.byteLength(source, 'utf8') > MAX_SOURCE_BYTES) {
    fail('SOURCE_TOO_LARGE', `Song files must be ${MAX_SOURCE_BYTES / 1024} KB or smaller.`, {
      maximumBytes: MAX_SOURCE_BYTES
    });
  }
  if (source.includes('\0')) fail('INVALID_SOURCE', 'Song source cannot contain a null character.');

  const normalizedSource = source.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  const lines = normalizedSource.split('\n');
  const { metadata, bodyStart } = parseFrontMatter(lines);
  const fileBase = path.basename(options.fileName || 'song', path.extname(options.fileName || ''));
  const title = boundedText(metadata.title || fileBase || 'Untitled Song', 'Song title', 200, { required: true });
  const id = normalizeSongId(metadata.id, slugify(title));
  const language = boundedText(metadata.language || 'und', 'Song language', 35, { required: true });
  const translationOf = metadata.translationOf
    ? normalizeSongId(metadata.translationOf, null)
    : null;

  const sections = [];
  const sectionIds = new Set();
  let currentSection = null;
  let slideCount = 0;
  let lineCount = 0;

  const beginSection = identity => {
    if (sections.length >= MAX_SECTIONS) {
      fail('TOO_MANY_SECTIONS', `A song can contain at most ${MAX_SECTIONS} sections.`);
    }
    if (sectionIds.has(identity.id)) {
      fail(
        'DUPLICATE_SECTION',
        `Section “${identity.label}” appears more than once. Keep it once and repeat it in the arrangement instead.`,
        { sectionId: identity.id }
      );
    }
    sectionIds.add(identity.id);
    currentSection = {
      id: identity.id,
      marker: identity.marker,
      label: identity.label,
      slides: [{ lines: [] }]
    };
    slideCount += 1;
    sections.push(currentSection);
  };

  const ensureSection = () => {
    if (!currentSection) beginSection({ id: 'section-1', marker: 'section', label: 'Song' });
    return currentSection;
  };

  for (let index = bodyStart; index < lines.length; index += 1) {
    let line = lines[index];
    if (line.startsWith('^^')) {
      line = line.slice(1);
    } else {
      const markerMatch = /^\^([^\s].{0,63})\s*$/.exec(line);
      if (markerMatch) {
        beginSection(markerIdentity(markerMatch[1]));
        continue;
      }
    }

    if (line.trim() === '---') {
      const section = ensureSection();
      if (slideCount >= MAX_SLIDES) fail('TOO_MANY_SLIDES', `A song can contain at most ${MAX_SLIDES} slides.`);
      section.slides.push({ lines: [] });
      slideCount += 1;
      continue;
    }

    // Formatting whitespace between front matter and the first explicit
    // section is not an unnamed projected section.
    if (!currentSection && line.trim() === '') continue;

    if (line.length > MAX_LINE_LENGTH) {
      fail('LYRIC_LINE_TOO_LONG', `Line ${index + 1} is longer than ${MAX_LINE_LENGTH} characters.`, {
        line: index + 1,
        maximum: MAX_LINE_LENGTH
      });
    }
    lineCount += 1;
    if (lineCount > MAX_LINES) fail('TOO_MANY_LINES', `A song can contain at most ${MAX_LINES} lyric lines.`);
    ensureSection().slides.at(-1).lines.push(line.replace(/[ \t]+$/g, ''));
  }

  if (sections.length === 0) fail('EMPTY_SONG', 'Add at least one lyric line or section to this song.');
  for (const section of sections) {
    section.slides = section.slides.map((slide, index) => ({
      id: `${section.id}-slide-${index + 1}`,
      lines: normalizeLines(slide.lines)
    }));
  }
  if (!sections.some(section => section.slides.some(slide => slide.lines.some(Boolean)))) {
    fail('EMPTY_SONG', 'Add at least one lyric line to this song.');
  }

  const knownKeys = new Set([
    'id',
    'title',
    'language',
    'translationOf',
    'license',
    'tags',
    'authors',
    'translators',
    'composers',
    'music',
    'source',
    'attribution'
  ]);
  const extraMetadata = {};
  for (const [key, value] of Object.entries(metadata)) {
    if (!knownKeys.has(key)) extraMetadata[key] = value;
  }

  const song = normalizeSongDocument({
    schemaVersion: SONG_SCHEMA_VERSION,
    id,
    title,
    language,
    translationOf,
    license: boundedText(metadata.license || '', 'Song license', 300),
    tags: normalizedStringList(metadata.tags, 'Song tags'),
    authors: normalizedStringList(metadata.authors, 'Song authors'),
    translators: normalizedStringList(metadata.translators, 'Song translators'),
    composers: normalizedStringList(
      metadata.composers !== undefined ? metadata.composers : metadata.music,
      'Song composers'
    ),
    source: boundedText(metadata.source || '', 'Song source', 500),
    attribution: boundedText(metadata.attribution || '', 'Song attribution', MAX_ATTRIBUTION_LENGTH),
    extraMetadata,
    sections
  });
  song.sourceHash = crypto.createHash('sha256').update(serializeSongDocument(song)).digest('hex');
  return song;
}

function quoteFrontMatter(value) {
  if (/^[A-Za-z0-9 ._:/()'&+-]+$/u.test(value)) return value;
  return JSON.stringify(value);
}

function serializeSongDocument(song) {
  song = normalizeSongDocument(song);
  const lines = [
    '---',
    `id: ${quoteFrontMatter(normalizeSongId(song.id, null))}`,
    `title: ${quoteFrontMatter(boundedText(song.title, 'Song title', 200, { required: true }))}`,
    `language: ${quoteFrontMatter(boundedText(song.language || 'und', 'Song language', 35, { required: true }))}`
  ];
  if (song.translationOf) lines.push(`translationOf: ${quoteFrontMatter(normalizeSongId(song.translationOf, null))}`);
  if (song.license) lines.push(`license: ${quoteFrontMatter(boundedText(song.license, 'Song license', 300))}`);
  if (song.tags?.length) lines.push(`tags: ${JSON.stringify(song.tags)}`);
  if (song.authors?.length) lines.push(`authors: ${JSON.stringify(song.authors)}`);
  if (song.translators?.length) lines.push(`translators: ${JSON.stringify(song.translators)}`);
  if (song.composers?.length) lines.push(`composers: ${JSON.stringify(song.composers)}`);
  if (song.source) lines.push(`source: ${quoteFrontMatter(boundedText(song.source, 'Song source', 500))}`);
  // Attribution originally traveled through extraMetadata. Keep it in the
  // same sorted extension block so promoting it to a first-class field does
  // not change the canonical bytes or hashes of existing song revisions.
  const extensionMetadata = { ...(song.extraMetadata || {}) };
  if (song.attribution) {
    extensionMetadata.attribution = boundedText(song.attribution, 'Song attribution', MAX_ATTRIBUTION_LENGTH);
  }
  for (const key of Object.keys(extensionMetadata).sort()) {
    if (!/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(key)) continue;
    const value = extensionMetadata[key];
    if (typeof value === 'string') lines.push(`${key}: ${quoteFrontMatter(value.slice(0, 2048))}`);
  }
  lines.push('---', '');

  for (const [sectionIndex, section] of song.sections.entries()) {
    if (sectionIndex > 0) lines.push('');
    lines.push(`^${section.marker || section.id}`);
    for (const [slideIndex, slide] of section.slides.entries()) {
      if (slideIndex > 0) lines.push('---');
      for (const lyricLine of slide.lines || []) {
        const line = String(lyricLine);
        lines.push(line.startsWith('^') ? `^${line}` : line);
      }
    }
  }
  const serialized = `${lines.join('\n').replace(/\n{3,}/g, '\n\n')}\n`;
  if (Buffer.byteLength(serialized, 'utf8') > MAX_SOURCE_BYTES) {
    fail('SOURCE_TOO_LARGE', `Song files must be ${MAX_SOURCE_BYTES / 1024} KB or smaller.`, {
      maximumBytes: MAX_SOURCE_BYTES
    });
  }
  return serialized;
}

/**
 * Programmatic SongDocuments can carry a stable section id that is different
 * from the human-facing Markdown marker. Markdown persists only the marker,
 * so parsing the serialized source would otherwise manufacture a different
 * section id and break arrangements or translation alignment.
 *
 * Keep the original marker, label, slides, and song identity, but use the
 * exact section ids the Markdown parser will restore. The returned mapping is
 * for callers that also own an arrangement referencing the pre-canonical ids.
 */
function canonicalizeSongDocumentSectionIds(rawSong) {
  const song = normalizeSongDocument(rawSong);
  const source = serializeSongDocument(song);
  const parsed = parseSongDocument(source, { fileName: `${song.id}.md` });
  if (parsed.sections.length !== song.sections.length) {
    fail(
      'SECTION_ROUND_TRIP_MISMATCH',
      `${song.title} changed section count while canonicalizing its Markdown source.`
    );
  }

  const sectionIdEntries = [];
  const sections = song.sections.map((section, index) => {
    const canonicalId = parsed.sections[index].id;
    sectionIdEntries.push([section.id, canonicalId]);
    return {
      ...section,
      id: canonicalId
    };
  });
  const sectionIdMap = Object.freeze(Object.fromEntries(sectionIdEntries));
  const canonicalSong = normalizeSongDocument({
    ...song,
    sections
  });
  if (serializeSongDocument(canonicalSong) !== source) {
    fail(
      'SECTION_ROUND_TRIP_MISMATCH',
      `${song.title} could not preserve its Markdown source while canonicalizing section ids.`
    );
  }
  return {
    song: canonicalSong,
    source,
    sectionIdMap
  };
}

function arrangementAlias(value) {
  const normalized = String(value || '').trim().normalize('NFKC').toLowerCase();
  const numeric = /^(?:v(?:erse)?\s*)?(\d{1,3})$/.exec(normalized);
  if (numeric) return `verse-${Number.parseInt(numeric[1], 10)}`;
  const asciiAlias = slugify(normalized, '');
  if (asciiAlias) return asciiAlias;
  if (!normalized) return '';
  // Arrangement aliases are lookup keys, not persisted identifiers. Preserve
  // non-Latin markers (for example, "Припев") through a stable opaque key
  // instead of collapsing every Unicode-only label to the same empty slug.
  return `unicode-${crypto.createHash('sha256').update(normalized.normalize('NFC')).digest('hex')}`;
}

function parseSongArrangement(value, song) {
  if (!song || !Array.isArray(song.sections)) fail('INVALID_SONG', 'Choose a valid song before arranging it.');
  const rawItems = Array.isArray(value)
    ? value
    : String(value || '').split(/[,;\n]+/);
  const requested = rawItems.map(item => String(item).trim()).filter(Boolean);
  const tokens = requested.length > 0 ? requested : song.sections.map(section => section.id);
  if (tokens.length > MAX_ARRANGEMENT_ITEMS) {
    fail('ARRANGEMENT_TOO_LONG', `An arrangement can contain at most ${MAX_ARRANGEMENT_ITEMS} sections.`);
  }

  const aliases = new Map();
  for (const section of song.sections) {
    for (const alias of [section.id, section.marker, section.label, arrangementAlias(section.id)]) {
      const key = arrangementAlias(alias);
      if (key) aliases.set(key, section.id);
    }
  }
  return tokens.map((token, index) => {
    const sectionId = aliases.get(arrangementAlias(token));
    if (!sectionId) {
      fail('UNKNOWN_ARRANGEMENT_SECTION', `“${token}” is not a section in ${song.title}.`, {
        index,
        token,
        available: song.sections.map(section => section.marker)
      });
    }
    return sectionId;
  });
}

function compareSongSections(baseSong, translationSong) {
  if (!baseSong || !translationSong) fail('INVALID_SONG', 'Two songs are required to compare translations.');
  const baseIds = baseSong.sections.map(section => section.id);
  const translatedIds = translationSong.sections.map(section => section.id);
  const translatedSet = new Set(translatedIds);
  const baseSet = new Set(baseIds);
  const slideMismatches = [];
  for (const section of baseSong.sections) {
    const translated = translationSong.sections.find(candidate => candidate.id === section.id);
    if (translated && translated.slides.length !== section.slides.length) {
      slideMismatches.push({
        sectionId: section.id,
        sourceSlides: section.slides.length,
        translationSlides: translated.slides.length
      });
    }
  }
  return {
    compatible: baseIds.every(id => translatedSet.has(id))
      && translatedIds.every(id => baseSet.has(id))
      && slideMismatches.length === 0,
    missingSectionIds: baseIds.filter(id => !translatedSet.has(id)),
    extraSectionIds: translatedIds.filter(id => !baseSet.has(id)),
    slideMismatches
  };
}

module.exports = {
  MAX_ATTRIBUTION_LENGTH,
  MAX_SOURCE_BYTES,
  SONG_SCHEMA_VERSION,
  SongDocumentError,
  canonicalizeSongDocumentSectionIds,
  compareSongSections,
  normalizeSongDocument,
  parseSongArrangement,
  parseSongDocument,
  serializeSongDocument,
  slugify
};
