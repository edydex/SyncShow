'use strict';

const { normalizeSongPresentation, presentationTitleBlocks, presentationLyricBlocks } = require('./SongPresentation');

const crypto = require('crypto');
const { isValidIsoDate } = require('../service-set/ServiceDate');
const {
  compareSongSections,
  normalizeSongDocument,
  parseSongArrangement,
  serializeSongDocument
} = require('./SongDocument');
const {
  isNativePresetAllowed,
  listNativePresets
} = require('./NativePresetCatalog');

// A translation comparison is structural: every channel must retain the same
// section identities and slide breaks so one cue index means the same thing on
// every output. The relationship check below additionally prevents an
// unrelated, coincidentally-shaped song from being linked as a translation.
function compareSongTranslations(rawPrimarySong, rawTranslationSong) {
  const primarySong = normalizeSongDocument(rawPrimarySong);
  const translationSong = normalizeSongDocument(rawTranslationSong);
  const structure = compareSongSections(primarySong, translationSong);
  const primaryFamilyId = primarySong.translationOf || primarySong.id;
  const translationFamilyId = translationSong.translationOf || translationSong.id;
  const relationshipCompatible = primarySong.id === translationSong.id
    || primarySong.id === translationSong.translationOf
    || translationSong.id === primarySong.translationOf
    || primaryFamilyId === translationFamilyId;
  return {
    ...structure,
    relationshipCompatible,
    primarySongId: primarySong.id,
    translationSongId: translationSong.id,
    translationOf: translationSong.translationOf,
    compatible: structure.compatible && relationshipCompatible
  };
}

const SERVICE_PROJECT_SCHEMA_VERSION = 1;
const PROJECT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const ASSET_ID_PATTERN = /^sha256:[a-f0-9]{64}$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const STORED_NAME_PATTERN = /^[a-f0-9]{64}\.[a-z0-9]{1,10}$/;
const CUE_KINDS = Object.freeze(['song', 'bible', 'sermon', 'picture', 'notice', 'blank', 'slide']);
const CHANNEL_MODES = Object.freeze(['content', 'inherit', 'condensed', 'hide']);
const BLOCK_TYPES = Object.freeze(['text', 'bible', 'image', 'blank', 'legacy-deck']);
const ASSET_KINDS = Object.freeze(['image', 'deck', 'document']);
const IMAGE_FITS = Object.freeze(['fit', 'fill', 'stretch']);
const MAX_CUES = 5000;
const MAX_ASSETS = 2000;
const MAX_CHANNELS_PER_CUE = 32;
const MAX_BLOCKS_PER_CHANNEL = 64;
const MAX_GROUP_DEPTH = 32;
const MAX_LIBRARY_REFERENCES = 2000;
const MAX_PROJECT_JSON_BYTES = 16 * 1024 * 1024;
const MAX_IMAGE_PIXELS = 64 * 1000 * 1000;
const MAX_TEXT_SPANS = 256;
const TEXT_SPAN_FOREGROUND_PATTERN = /^#[0-9a-f]{6}$/i;
const TEXT_SPAN_WEIGHTS = Object.freeze(['400', '500', '600', '700']);

class ServiceProjectError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'ServiceProjectError';
    this.code = code;
    this.details = details;
  }
}

function fail(code, message, details = {}) {
  throw new ServiceProjectError(code, message, details);
}

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function text(value, field, maximum, { required = false, trim = true } = {}) {
  if (value === undefined || value === null) value = '';
  if (typeof value !== 'string') fail('INVALID_TEXT', `${field} must be text.`, { field });
  const normalized = trim ? value.trim() : value;
  if (required && normalized.length === 0) fail('MISSING_TEXT', `${field} is required.`, { field });
  if (normalized.length > maximum) {
    fail('TEXT_TOO_LONG', `${field} must be ${maximum} characters or fewer.`, { field, maximum });
  }
  return normalized;
}

function splitsSurrogatePair(value, offset) {
  if (offset <= 0 || offset >= value.length) return false;
  const previous = value.charCodeAt(offset - 1);
  const current = value.charCodeAt(offset);
  return previous >= 0xD800
    && previous <= 0xDBFF
    && current >= 0xDC00
    && current <= 0xDFFF;
}

/**
 * Inline formatting is deliberately data-only: offsets address UTF-16 code
 * units in the authoritative plain-text value, and style values come from a
 * tiny allowlist. Renderers must escape the text independently and may then
 * translate these validated ranges into their native markup representation.
 */
function normalizeTextSpans(raw, authoritativeText, field) {
  if (raw === undefined) return [];
  if (!Array.isArray(raw) || raw.length > MAX_TEXT_SPANS) {
    fail(
      'INVALID_TEXT_SPANS',
      `${field} must contain at most ${MAX_TEXT_SPANS} inline formatting ranges.`,
      { field, maximum: MAX_TEXT_SPANS }
    );
  }
  const normalized = [];
  let previousEnd = 0;
  for (const [index, candidate] of raw.entries()) {
    const spanField = `${field}[${index}]`;
    if (!isRecord(candidate)) {
      fail('INVALID_TEXT_SPANS', `${spanField} must be an object.`, { field: spanField });
    }
    const keys = Object.keys(candidate);
    const unexpected = keys.filter(key => !['start', 'end', 'foreground', 'weight'].includes(key));
    if (unexpected.length > 0) {
      fail(
        'INVALID_TEXT_SPANS',
        `${spanField} contains unsupported style properties.`,
        { field: spanField, properties: unexpected }
      );
    }
    const { start, end } = candidate;
    if (!Number.isSafeInteger(start)
      || !Number.isSafeInteger(end)
      || start < 0
      || end <= start
      || end > authoritativeText.length) {
      fail(
        'INVALID_TEXT_SPANS',
        `${spanField} must be a non-empty range inside its authoritative text.`,
        { field: spanField, start, end, textLength: authoritativeText.length }
      );
    }
    if (start < previousEnd) {
      fail(
        'INVALID_TEXT_SPANS',
        `${field} ranges must be sorted and must not overlap.`,
        { field, index, previousEnd, start }
      );
    }
    if (splitsSurrogatePair(authoritativeText, start)
      || splitsSurrogatePair(authoritativeText, end)) {
      fail(
        'INVALID_TEXT_SPANS',
        `${spanField} cannot split a Unicode character.`,
        { field: spanField, start, end }
      );
    }
    const span = { start, end };
    if (candidate.foreground !== undefined) {
      if (typeof candidate.foreground !== 'string'
        || !TEXT_SPAN_FOREGROUND_PATTERN.test(candidate.foreground)) {
        fail(
          'INVALID_TEXT_SPANS',
          `${spanField}.foreground must be a six-digit RGB color such as #ffc000.`,
          { field: `${spanField}.foreground` }
        );
      }
      span.foreground = candidate.foreground.toLowerCase();
    }
    if (candidate.weight !== undefined) {
      if (typeof candidate.weight !== 'string'
        || !TEXT_SPAN_WEIGHTS.includes(candidate.weight)) {
        fail(
          'INVALID_TEXT_SPANS',
          `${spanField}.weight must be one of ${TEXT_SPAN_WEIGHTS.join(', ')}.`,
          { field: `${spanField}.weight`, allowed: TEXT_SPAN_WEIGHTS }
        );
      }
      span.weight = candidate.weight;
    }
    if (span.foreground === undefined && span.weight === undefined) {
      fail(
        'INVALID_TEXT_SPANS',
        `${spanField} must set foreground, weight, or both.`,
        { field: spanField }
      );
    }
    normalized.push(span);
    previousEnd = end;
  }
  return normalized;
}

function id(value, field, fallback = null) {
  const normalized = text(value || fallback, field, 128, { required: true });
  if (!PROJECT_ID_PATTERN.test(normalized)) {
    fail(
      'INVALID_ID',
      `${field} must start with a letter or number and use only letters, numbers, dot, underscore, colon, or hyphen.`,
      { field, value: normalized }
    );
  }
  if (normalized === '__proto__'
    || normalized === 'prototype'
    || normalized === 'constructor'
    || Object.prototype.hasOwnProperty.call(Object.prototype, normalized)) {
    fail('RESERVED_ID', `${field} uses a reserved identifier.`, { field, value: normalized });
  }
  return normalized;
}

function isoDate(value, field) {
  if (!isValidIsoDate(value)) fail('INVALID_DATE', `${field} must use YYYY-MM-DD.`, { field, value });
  return value;
}

function timestamp(value, field, fallback) {
  const normalized = value || fallback;
  if (typeof normalized !== 'string' || !Number.isFinite(Date.parse(normalized))) {
    fail('INVALID_TIMESTAMP', `${field} must be an ISO timestamp.`, { field });
  }
  return new Date(normalized).toISOString();
}

function finiteInteger(value, field, minimum, maximum, fallback = null) {
  const candidate = value === undefined || value === null ? fallback : value;
  if (!Number.isSafeInteger(candidate) || candidate < minimum || candidate > maximum) {
    fail('INVALID_NUMBER', `${field} must be a whole number from ${minimum} to ${maximum}.`, {
      field,
      minimum,
      maximum
    });
  }
  return candidate;
}

function deepClone(value) {
  return JSON.parse(JSON.stringify(value));
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}

function normalizeFocalPoint(raw, field) {
  if (raw === undefined || raw === null) return { x: 0.5, y: 0.5 };
  if (!isRecord(raw)) fail('INVALID_FOCAL_POINT', `${field} must have x and y values.`, { field });
  const x = Number(raw.x);
  const y = Number(raw.y);
  if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || x > 1 || y < 0 || y > 1) {
    fail('INVALID_FOCAL_POINT', `${field} x and y must be between 0 and 1.`, { field });
  }
  return { x, y };
}

function normalizeBlock(raw, field) {
  if (!isRecord(raw)) fail('INVALID_BLOCK', `${field} must be a content block.`, { field });
  const type = raw.type;
  if (!BLOCK_TYPES.includes(type)) fail('INVALID_BLOCK_TYPE', `${field} has an unsupported block type.`, { field, type });

  if (type === 'text') {
    const normalized = {
      type,
      text: text(raw.text, `${field}.text`, 20000, { trim: false }),
      role: ['title', 'subtitle', 'body', 'lyrics', 'caption', 'credit'].includes(raw.role)
        ? raw.role
        : 'body'
    };
    const spans = normalizeTextSpans(raw.spans, normalized.text, `${field}.spans`);
    if (spans.length > 0) normalized.spans = spans;
    return normalized;
  }
  if (type === 'bible') {
    if (!Array.isArray(raw.verses) || raw.verses.length < 1 || raw.verses.length > 200) {
      fail('INVALID_BIBLE_BLOCK', `${field}.verses must contain 1 to 200 verses.`, { field });
    }
    const normalized = {
      type,
      reference: text(raw.reference, `${field}.reference`, 160, { required: true }),
      translationId: id(raw.translationId || 'BSB', `${field}.translationId`),
      attribution: text(raw.attribution, `${field}.attribution`, 500),
      verses: raw.verses.map((verse, index) => {
        if (!isRecord(verse)) fail('INVALID_BIBLE_VERSE', `${field}.verses[${index}] must be an object.`);
        return {
          number: finiteInteger(verse.number, `${field}.verses[${index}].number`, 1, 999),
          text: text(verse.text, `${field}.verses[${index}].text`, 4000, { required: true })
        };
      })
    };
    normalized.contentSha256 = crypto.createHash('sha256')
      .update(JSON.stringify({
        kind: 'syncshow-pinned-bible-passage',
        schemaVersion: 1,
        reference: normalized.reference,
        translationId: normalized.translationId,
        attribution: normalized.attribution,
        verses: normalized.verses
      }))
      .digest('hex');
    if (raw.contentSha256 !== undefined && raw.contentSha256 !== normalized.contentSha256) {
      fail('BIBLE_CONTENT_HASH_MISMATCH', `${field} no longer matches its pinned checksum.`, {
        field,
        expected: raw.contentSha256,
        actual: normalized.contentSha256
      });
    }
    return normalized;
  }
  if (type === 'image') {
    if (!ASSET_ID_PATTERN.test(raw.assetId || '')) {
      fail('INVALID_ASSET_REFERENCE', `${field}.assetId is invalid.`, { field, assetId: raw.assetId });
    }
    const fit = raw.fit || 'fit';
    if (!IMAGE_FITS.includes(fit)) fail('INVALID_IMAGE_FIT', `${field}.fit is unsupported.`, { field, fit });
    return {
      type,
      assetId: raw.assetId,
      fit,
      focalPoint: normalizeFocalPoint(raw.focalPoint, `${field}.focalPoint`),
      altText: text(raw.altText, `${field}.altText`, 500, { required: true }),
      attribution: text(raw.attribution, `${field}.attribution`, 500)
    };
  }
  if (type === 'legacy-deck') {
    if (!ASSET_ID_PATTERN.test(raw.assetId || '')) {
      fail('INVALID_ASSET_REFERENCE', `${field}.assetId is invalid.`, { field, assetId: raw.assetId });
    }
    return {
      type,
      assetId: raw.assetId,
      slideIndex: raw.slideIndex === null || raw.slideIndex === undefined
        ? null
        : finiteInteger(raw.slideIndex, `${field}.slideIndex`, 0, 9999)
    };
  }
  return { type: 'blank' };
}

function normalizeChannel(raw, field, channelId) {
  if (!isRecord(raw)) fail('INVALID_CHANNEL', `${field} must be a channel variant.`, { field });
  const mode = raw.mode || 'content';
  if (!CHANNEL_MODES.includes(mode)) fail('INVALID_CHANNEL_MODE', `${field}.mode is unsupported.`, { field, mode });
  if (mode === 'inherit') {
    const from = id(raw.from, `${field}.from`);
    if (from === channelId) fail('CHANNEL_INHERITANCE_CYCLE', `${field} cannot inherit from itself.`, { field });
    return { mode, from };
  }
  if (mode === 'hide') return { mode, blocks: [] };
  if (!Array.isArray(raw.blocks) || raw.blocks.length > MAX_BLOCKS_PER_CHANNEL) {
    fail('INVALID_BLOCKS', `${field}.blocks must contain at most ${MAX_BLOCKS_PER_CHANNEL} blocks.`, { field });
  }
  const normalized = {
    mode,
    blocks: raw.blocks.map((block, index) => normalizeBlock(block, `${field}.blocks[${index}]`))
  };
  if (mode === 'condensed' && raw.sourceChannelId !== undefined) {
    normalized.sourceChannelId = id(raw.sourceChannelId, `${field}.sourceChannelId`);
    if (normalized.sourceChannelId === channelId) {
      fail('CHANNEL_INHERITANCE_CYCLE', `${field} cannot derive from itself.`, { field });
    }
  }
  return normalized;
}

function validateChannelGraph(channels, cueId) {
  for (const channelId of Object.keys(channels)) {
    const channel = channels[channelId];
    if (channel?.mode === 'condensed'
      && channel.sourceChannelId
      && !channels[channel.sourceChannelId]) {
      fail(
        'MISSING_INHERITED_CHANNEL',
        `Cue ${cueId} derives from missing channel “${channel.sourceChannelId}”.`,
        { cueId, channelId, from: channel.sourceChannelId }
      );
    }
    const seen = new Set([channelId]);
    let current = channel;
    while (current?.mode === 'inherit') {
      if (!channels[current.from]) {
        fail('MISSING_INHERITED_CHANNEL', `Cue ${cueId} inherits from missing channel “${current.from}”.`, {
          cueId,
          channelId,
          from: current.from
        });
      }
      if (seen.has(current.from)) {
        fail('CHANNEL_INHERITANCE_CYCLE', `Cue ${cueId} has a channel inheritance cycle.`, { cueId, channelId });
      }
      seen.add(current.from);
      current = channels[current.from];
    }
  }
}

function normalizeCue(raw, expectedId = null) {
  if (!isRecord(raw)) fail('INVALID_CUE', 'Every cue must be an object.');
  const cueId = id(raw.id || expectedId, 'Cue id');
  if (expectedId && cueId !== expectedId) fail('CUE_ID_MISMATCH', `Cue key ${expectedId} does not match ${cueId}.`);
  if (!CUE_KINDS.includes(raw.kind)) fail('INVALID_CUE_KIND', `Cue ${cueId} has an unsupported kind.`, { cueId, kind: raw.kind });
  if (!Array.isArray(raw.groupPath) || raw.groupPath.length > MAX_GROUP_DEPTH) {
    fail('INVALID_GROUP_PATH', `Cue ${cueId} may have at most ${MAX_GROUP_DEPTH} parent levels.`, { cueId });
  }
  if (!isRecord(raw.channels)) fail('INVALID_CHANNELS', `Cue ${cueId} must have channel variants.`, { cueId });
  const channelEntries = Object.entries(raw.channels);
  if (channelEntries.length < 1 || channelEntries.length > MAX_CHANNELS_PER_CUE) {
    fail('INVALID_CHANNELS', `Cue ${cueId} must have 1 to ${MAX_CHANNELS_PER_CUE} channels.`, { cueId });
  }
  const channels = {};
  for (const [rawChannelId, channel] of channelEntries) {
    const channelId = id(rawChannelId, `Cue ${cueId} channel id`);
    channels[channelId] = normalizeChannel(channel, `Cue ${cueId} channel ${channelId}`, channelId);
  }
  validateChannelGraph(channels, cueId);

  const normalized = {
    id: cueId,
    kind: raw.kind,
    title: text(raw.title || raw.kind, `Cue ${cueId} title`, 200, { required: true }),
    groupPath: raw.groupPath.map((part, index) => text(part, `Cue ${cueId} groupPath[${index}]`, 160, { required: true })),
    channels,
    operatorNotes: text(raw.operatorNotes, `Cue ${cueId} operatorNotes`, 4000, { trim: false }),
    presetId: id(raw.presetId || defaultPresetForKind(raw.kind), `Cue ${cueId} presetId`)
  };
  if (raw.itemId !== undefined && raw.itemId !== null) {
    normalized.itemId = id(raw.itemId, `Cue ${cueId} itemId`);
  }
  if (raw.sourceReference !== undefined && raw.sourceReference !== null) {
    if (!isRecord(raw.sourceReference)) fail('INVALID_SOURCE_REFERENCE', `Cue ${cueId} sourceReference is invalid.`);
    normalized.sourceReference = {
      type: text(raw.sourceReference.type || 'local', 'Source reference type', 40, { required: true }),
      id: id(raw.sourceReference.id, 'Source reference id'),
      revision: text(raw.sourceReference.revision, 'Source reference revision', 128),
      sectionId: raw.sourceReference.sectionId ? id(raw.sourceReference.sectionId, 'Source section id') : null
    };
  }
  return normalized;
}

function defaultPresetForKind(kind) {
  return {
    song: 'song-lyrics',
    bible: 'scripture-text',
    sermon: 'sermon-point',
    picture: 'picture-fullscreen',
    notice: 'notice-text',
    blank: 'blank-black',
    slide: 'legacy-slide'
  }[kind] || 'blank-black';
}

function normalizeAsset(raw, expectedId = null) {
  if (!isRecord(raw)) fail('INVALID_ASSET', 'Every asset must be an object.');
  const assetId = raw.id || expectedId;
  if (!ASSET_ID_PATTERN.test(assetId || '') || (expectedId && assetId !== expectedId)) {
    fail('INVALID_ASSET_ID', 'Asset IDs must be sha256 content identifiers.', { assetId, expectedId });
  }
  if (!ASSET_KINDS.includes(raw.kind)) fail('INVALID_ASSET_KIND', `Asset ${assetId} has an unsupported kind.`);
  if (!SHA256_PATTERN.test(raw.sha256 || '') || assetId !== `sha256:${raw.sha256}`) {
    fail('INVALID_ASSET_HASH', `Asset ${assetId} has an invalid content hash.`);
  }
  if (!STORED_NAME_PATTERN.test(raw.storedName || '') || !raw.storedName.startsWith(raw.sha256)) {
    fail('INVALID_STORED_NAME', `Asset ${assetId} has an unsafe stored name.`);
  }
  const normalized = {
    id: assetId,
    kind: raw.kind,
    sha256: raw.sha256,
    fileName: text(raw.fileName, `Asset ${assetId} fileName`, 255, { required: true }),
    storedName: raw.storedName,
    mediaType: text(raw.mediaType, `Asset ${assetId} mediaType`, 100, { required: true }),
    size: finiteInteger(raw.size, `Asset ${assetId} size`, 1, 1024 * 1024 * 1024),
    createdAt: timestamp(raw.createdAt, `Asset ${assetId} createdAt`, new Date(0).toISOString()),
    attribution: text(raw.attribution, `Asset ${assetId} attribution`, 500),
    altText: text(raw.altText, `Asset ${assetId} altText`, 500)
  };
  if (raw.kind === 'image') {
    normalized.width = finiteInteger(raw.width, `Asset ${assetId} width`, 1, 32768);
    normalized.height = finiteInteger(raw.height, `Asset ${assetId} height`, 1, 32768);
    if (normalized.width * normalized.height > MAX_IMAGE_PIXELS) {
      fail('IMAGE_PIXEL_LIMIT', `Asset ${assetId} exceeds the ${MAX_IMAGE_PIXELS.toLocaleString('en-US')} pixel safety limit.`);
    }
    const expectedExtensions = {
      'image/png': ['png'],
      'image/jpeg': ['jpg', 'jpeg'],
      'image/webp': ['webp']
    }[normalized.mediaType];
    const extension = normalized.storedName.split('.').at(-1);
    if (!expectedExtensions || !expectedExtensions.includes(extension)) {
      fail('IMAGE_TYPE_MISMATCH', `Asset ${assetId} has inconsistent image type metadata.`);
    }
    normalized.orientation = finiteInteger(raw.orientation, `Asset ${assetId} orientation`, 1, 8, 1);
  }
  return normalized;
}

function normalizeLibraryReference(raw, index) {
  if (!isRecord(raw)) fail('INVALID_LIBRARY_REFERENCE', `Library reference ${index + 1} must be an object.`);
  return {
    id: id(raw.id, `Library reference ${index + 1} id`),
    kind: text(raw.kind || 'song', `Library reference ${index + 1} kind`, 40, { required: true }),
    revision: text(raw.revision, `Library reference ${index + 1} revision`, 128),
    pinnedAt: timestamp(raw.pinnedAt, `Library reference ${index + 1} pinnedAt`, new Date(0).toISOString())
  };
}

function normalizeServiceProject(raw, options = {}) {
  if (!isRecord(raw)) fail('INVALID_PROJECT', 'ServiceProject must be an object.');
  if (raw.schemaVersion !== SERVICE_PROJECT_SCHEMA_VERSION) {
    fail('UNSUPPORTED_SCHEMA', `This project uses unsupported schema version ${raw.schemaVersion}.`, {
      supported: SERVICE_PROJECT_SCHEMA_VERSION,
      actual: raw.schemaVersion
    });
  }
  const now = options.now instanceof Date ? options.now : new Date(options.now || Date.now());
  const projectId = id(raw.id, 'Project id');
  const cueIds = raw.cueIds;
  if (!Array.isArray(cueIds) || cueIds.length > MAX_CUES) {
    fail('INVALID_CUE_ORDER', `A project can contain at most ${MAX_CUES} cues.`);
  }
  if (!isRecord(raw.cues)) fail('INVALID_CUES', 'Project cues must be an object.');
  if (!isRecord(raw.assets)) fail('INVALID_ASSETS', 'Project assets must be an object.');
  if (Object.keys(raw.assets).length > MAX_ASSETS) fail('TOO_MANY_ASSETS', `A project can contain at most ${MAX_ASSETS} assets.`);
  if (!Array.isArray(raw.libraryReferences) || raw.libraryReferences.length > MAX_LIBRARY_REFERENCES) {
    fail('INVALID_LIBRARY_REFERENCES', `A project can contain at most ${MAX_LIBRARY_REFERENCES} library references.`);
  }

  const normalizedCueIds = cueIds.map((cueId, index) => id(cueId, `cueIds[${index}]`));
  if (new Set(normalizedCueIds).size !== normalizedCueIds.length) fail('DUPLICATE_CUE_ID', 'The cue order contains duplicates.');
  const rawCueKeys = Object.keys(raw.cues);
  if (rawCueKeys.length !== normalizedCueIds.length
    || rawCueKeys.some(cueId => !normalizedCueIds.includes(cueId))) {
    fail('CUE_ORDER_MISMATCH', 'cueIds and cues must contain exactly the same cue IDs.');
  }
  const cues = {};
  for (const cueId of normalizedCueIds) cues[cueId] = normalizeCue(raw.cues[cueId], cueId);

  const assets = {};
  for (const assetId of Object.keys(raw.assets).sort()) assets[assetId] = normalizeAsset(raw.assets[assetId], assetId);
  for (const cue of Object.values(cues)) {
    for (const channel of Object.values(cue.channels)) {
      for (const block of channel.blocks || []) {
        if (['image', 'legacy-deck'].includes(block.type) && !assets[block.assetId]) {
          fail('MISSING_ASSET', `Cue ${cue.id} uses an asset that is not in this project.`, {
            cueId: cue.id,
            assetId: block.assetId
          });
        }
        if (block.type === 'image' && assets[block.assetId]?.kind !== 'image') {
          fail('WRONG_ASSET_KIND', `Cue ${cue.id} expects an image asset.`, { cueId: cue.id, assetId: block.assetId });
        }
      }
    }
  }

  const normalizedProject = {
    schemaVersion: SERVICE_PROJECT_SCHEMA_VERSION,
    id: projectId,
    title: text(raw.title, 'Project title', 200, { required: true }),
    serviceDate: isoDate(raw.serviceDate, 'Project serviceDate'),
    profileId: id(raw.profileId, 'Project profileId'),
    createdAt: timestamp(raw.createdAt, 'Project createdAt', now.toISOString()),
    updatedAt: timestamp(raw.updatedAt, 'Project updatedAt', now.toISOString()),
    revision: finiteInteger(raw.revision, 'Project revision', 0, Number.MAX_SAFE_INTEGER, 0),
    cueIds: normalizedCueIds,
    cues,
    assets,
    libraryReferences: raw.libraryReferences.map(normalizeLibraryReference),
    presetPackVersion: text(raw.presetPackVersion || `${raw.profileId}@1`, 'Project presetPackVersion', 160, { required: true })
  };
  if (Buffer.byteLength(JSON.stringify(normalizedProject), 'utf8') > MAX_PROJECT_JSON_BYTES) {
    fail('PROJECT_TOO_LARGE', `A project can use at most ${MAX_PROJECT_JSON_BYTES / (1024 * 1024)} MB of structured data.`);
  }
  return deepFreeze(normalizedProject);
}

function createServiceProject(options = {}) {
  const now = options.now instanceof Date ? options.now : new Date(options.now || Date.now());
  const serviceDate = isoDate(options.serviceDate, 'Project serviceDate');
  const projectId = id(options.id || `service-${serviceDate}-${crypto.randomUUID().slice(0, 8)}`, 'Project id');
  return normalizeServiceProject({
    schemaVersion: SERVICE_PROJECT_SCHEMA_VERSION,
    id: projectId,
    title: options.title || 'Sunday Service',
    serviceDate,
    profileId: options.profileId,
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    revision: 0,
    cueIds: [],
    cues: {},
    assets: {},
    libraryReferences: [],
    presetPackVersion: options.presetPackVersion || `${options.profileId}@1`
  }, { now });
}

function stableObject(value) {
  if (Array.isArray(value)) return value.map(stableObject);
  if (!isRecord(value)) return value;
  const result = {};
  for (const key of Object.keys(value).sort()) result[key] = stableObject(value[key]);
  return result;
}

function serializeServiceProject(project) {
  const normalized = normalizeServiceProject(project);
  const ordered = {
    schemaVersion: normalized.schemaVersion,
    id: normalized.id,
    title: normalized.title,
    serviceDate: normalized.serviceDate,
    profileId: normalized.profileId,
    createdAt: normalized.createdAt,
    updatedAt: normalized.updatedAt,
    revision: normalized.revision,
    cueIds: normalized.cueIds,
    cues: Object.fromEntries(normalized.cueIds.map(cueId => [cueId, stableObject(normalized.cues[cueId])])),
    assets: stableObject(normalized.assets),
    libraryReferences: normalized.libraryReferences.map(stableObject),
    presetPackVersion: normalized.presetPackVersion
  };
  return `${JSON.stringify(ordered, null, 2)}\n`;
}

function createCue(raw = {}, options = {}) {
  const cueId = raw.id || `${raw.kind || 'cue'}-${(options.randomUUID || crypto.randomUUID)().slice(0, 12)}`;
  return normalizeCue({
    id: cueId,
    kind: raw.kind || 'blank',
    title: raw.title || raw.kind || 'Blank',
    groupPath: raw.groupPath || [],
    channels: raw.channels || { primary: { mode: 'content', blocks: [{ type: 'blank' }] } },
    operatorNotes: raw.operatorNotes || '',
    presetId: raw.presetId || defaultPresetForKind(raw.kind || 'blank'),
    sourceReference: raw.sourceReference
  });
}

function projectWithCue(project, cue, atIndex = null) {
  const normalizedProject = normalizeServiceProject(project);
  const normalizedCue = normalizeCue(cue);
  if (normalizedProject.cues[normalizedCue.id]) fail('DUPLICATE_CUE_ID', `Cue ${normalizedCue.id} already exists.`);
  const next = deepClone(normalizedProject);
  const index = atIndex === null
    ? next.cueIds.length
    : finiteInteger(atIndex, 'Cue insertion index', 0, next.cueIds.length);
  next.cueIds.splice(index, 0, normalizedCue.id);
  next.cues[normalizedCue.id] = normalizedCue;
  return normalizeServiceProject(next);
}

function projectWithoutCue(project, cueId) {
  const normalizedProject = normalizeServiceProject(project);
  cueId = id(cueId, 'Cue id');
  if (!normalizedProject.cues[cueId]) fail('UNKNOWN_CUE', `Cue ${cueId} does not exist.`);
  const next = deepClone(normalizedProject);
  next.cueIds = next.cueIds.filter(candidate => candidate !== cueId);
  delete next.cues[cueId];
  return normalizeServiceProject(next);
}

function projectWithMovedCue(project, cueId, targetIndex) {
  const normalizedProject = normalizeServiceProject(project);
  cueId = id(cueId, 'Cue id');
  const fromIndex = normalizedProject.cueIds.indexOf(cueId);
  if (fromIndex === -1) fail('UNKNOWN_CUE', `Cue ${cueId} does not exist.`);
  const index = finiteInteger(targetIndex, 'Cue target index', 0, normalizedProject.cueIds.length - 1);
  const next = deepClone(normalizedProject);
  next.cueIds.splice(fromIndex, 1);
  next.cueIds.splice(index, 0, cueId);
  return normalizeServiceProject(next);
}

function createSongCues(options = {}) {
  const song = options.song;
  const translation = options.translation || null;
  if (!song || !Array.isArray(song.sections)) fail('INVALID_SONG', 'Choose a parsed song before creating cues.');
  if (translation) {
    const alignment = compareSongSections(song, translation);
    if (!alignment.compatible) {
      fail('TRANSLATION_MISMATCH', `${translation.title} does not have the same sections and slide breaks as ${song.title}.`, alignment);
    }
  }
  const arrangement = parseSongArrangement(options.arrangement, song);
  const primaryChannelId = id(options.primaryChannelId || 'primary', 'Primary song channel id');
  const translationChannelId = translation
    ? id(options.translationChannelId || 'secondary', 'Translation song channel id')
    : null;
  const singerChannelId = options.singerChannelId ? id(options.singerChannelId, 'Singer song channel id') : null;
  const randomUUID = options.randomUUID || crypto.randomUUID;
  const groupPath = Array.isArray(options.groupPath) ? options.groupPath : ['Worship', song.title];
  const cues = [];

  for (const [arrangementIndex, sectionId] of arrangement.entries()) {
    const section = song.sections.find(candidate => candidate.id === sectionId);
    const translatedSection = translation?.sections.find(candidate => candidate.id === sectionId) || null;
    for (const [slideIndex, slide] of section.slides.entries()) {
      const channels = {
        [primaryChannelId]: {
          mode: 'content',
          blocks: [{ type: 'text', role: 'lyrics', text: slide.lines.join('\n') }]
        }
      };
      if (translationChannelId) {
        channels[translationChannelId] = {
          mode: 'content',
          blocks: [{ type: 'text', role: 'lyrics', text: translatedSection.slides[slideIndex].lines.join('\n') }]
        };
      }
      if (singerChannelId) {
        channels[singerChannelId] = {
          mode: 'condensed',
          blocks: [{ type: 'text', role: 'lyrics', text: slide.lines.join('\n') }]
        };
      }
      cues.push(createCue({
        id: `song-${randomUUID().slice(0, 12)}`,
        kind: 'song',
        title: `${song.title} — ${section.label}${section.slides.length > 1 ? ` ${slideIndex + 1}` : ''}`,
        groupPath: [...groupPath, section.label],
        channels,
        presetId: options.presetId || 'song-lyrics',
        sourceReference: {
          type: 'song-library',
          id: song.id,
          revision: song.sourceHash || '',
          sectionId
        },
        operatorNotes: `Arrangement item ${arrangementIndex + 1}`
      }, { randomUUID }));
    }
  }
  return cues;
}

// The editable project intentionally stores semantic items and immutable
// resources, not generated cue text. Compilation is the only place where a
// song arrangement becomes a flat executable timeline.
const EDITABLE_PROJECT_KIND = 'syncshow-service-project';
const CUE_TIMELINE_KIND = 'syncshow-cue-timeline';
const PROJECT_ITEM_KINDS = Object.freeze([
  'group',
  'song',
  'bible',
  'sermon',
  'notice',
  'picture',
  'blank',
  'imported-deck'
]);
const PROJECT_GROUP_KINDS = Object.freeze(['service', 'sermon', 'section', 'point', 'subpoint', 'custom']);
const SONG_VARIANT_MODES = Object.freeze(['content', 'inherit', 'derive', 'hidden']);
const SONG_TITLE_CARD_MODES = Object.freeze(['full', 'simple']);
const MAX_PROJECT_ITEMS = 5000;
const MAX_GROUP_CHILDREN = 5000;
const MAX_ARRANGEMENT_ENTRIES = 1000;
const MAX_PROJECT_CHANNELS = 32;

function normalizeUniqueIds(value, field, maximum) {
  if (!Array.isArray(value) || value.length > maximum) {
    fail('INVALID_ID_LIST', `${field} must contain at most ${maximum} IDs.`, { field, maximum });
  }
  const result = value.map((entry, index) => id(entry, `${field}[${index}]`));
  if (new Set(result).size !== result.length) fail('DUPLICATE_ID', `${field} contains duplicate IDs.`, { field });
  return result;
}

function normalizeProjectChannel(raw, expectedId) {
  if (!isRecord(raw)) fail('INVALID_PROJECT_CHANNEL', `Channel ${expectedId} must be an object.`);
  const channelId = id(raw.id || expectedId, `Channel ${expectedId} id`);
  if (channelId !== expectedId) fail('CHANNEL_ID_MISMATCH', `Channel key ${expectedId} does not match ${channelId}.`);
  return {
    id: channelId,
    label: text(raw.label || channelId, `Channel ${channelId} label`, 120, { required: true }),
    language: text(raw.language || 'und', `Channel ${channelId} language`, 35, { required: true })
  };
}

function normalizeResourceOrigin(raw, field) {
  if (raw === undefined || raw === null) return { provider: 'local', providerId: null, itemId: null, revision: null };
  if (!isRecord(raw)) fail('INVALID_RESOURCE_ORIGIN', `${field} must be an object.`);
  return {
    provider: text(raw.provider || 'local', `${field}.provider`, 80, { required: true }),
    providerId: raw.providerId ? text(raw.providerId, `${field}.providerId`, 200) : null,
    itemId: raw.itemId ? text(raw.itemId, `${field}.itemId`, 200) : null,
    revision: raw.revision ? text(raw.revision, `${field}.revision`, 200) : null
  };
}

function normalizeProjectResource(raw, expectedId) {
  if (!isRecord(raw)) fail('INVALID_RESOURCE', `Resource ${expectedId} must be an object.`);
  if (raw.kind !== 'song') fail('INVALID_RESOURCE_KIND', `Resource ${expectedId} has unsupported kind ${raw.kind}.`);
  const document = normalizeSongDocument(raw.document);
  const canonical = serializeSongDocument(document);
  const sha256 = crypto.createHash('sha256').update(canonical).digest('hex');
  const resourceId = `sha256:${sha256}`;
  if (expectedId !== resourceId || raw.id !== resourceId || (raw.sha256 && raw.sha256 !== sha256)) {
    fail('RESOURCE_HASH_MISMATCH', `Resource ${expectedId} does not match its content hash.`, { expectedId, resourceId });
  }
  return {
    id: resourceId,
    kind: 'song',
    schemaVersion: document.schemaVersion,
    mediaType: 'application/vnd.syncshow.song+json',
    size: Buffer.byteLength(canonical, 'utf8'),
    sha256,
    origin: normalizeResourceOrigin(raw.origin, `Resource ${resourceId} origin`),
    document
  };
}

function normalizeSongVariant(raw, field, channelId) {
  if (!isRecord(raw)) fail('INVALID_SONG_VARIANT', `${field} must be an object.`);
  const mode = raw.mode || 'content';
  if (!SONG_VARIANT_MODES.includes(mode)) fail('INVALID_SONG_VARIANT', `${field} has unsupported mode ${mode}.`);
  const titleCardMode = raw.titleCardMode === undefined
    ? null
    : text(raw.titleCardMode, `${field}.titleCardMode`, 16, { required: true });
  if (titleCardMode && !SONG_TITLE_CARD_MODES.includes(titleCardMode)) {
    fail('INVALID_SONG_VARIANT', `${field}.titleCardMode must be full or simple.`);
  }
  const presentation = titleCardMode ? { titleCardMode } : {};
  if (mode === 'content') {
    if (!ASSET_ID_PATTERN.test(raw.resourceId || '')) {
      fail('INVALID_RESOURCE_REFERENCE', `${field}.resourceId must be content-addressed.`);
    }
    return { mode, resourceId: raw.resourceId, ...presentation };
  }
  if (mode === 'inherit') {
    const from = id(raw.from, `${field}.from`);
    if (from === channelId) fail('CHANNEL_INHERITANCE_CYCLE', `${field} cannot inherit from itself.`);
    return { mode, from, ...presentation };
  }
  if (mode === 'derive') {
    const from = id(raw.from, `${field}.from`);
    if (from === channelId) fail('CHANNEL_INHERITANCE_CYCLE', `${field} cannot derive from itself.`);
    if (!isRecord(raw.transform) || raw.transform.id !== 'first-lines' || raw.transform.version !== 1) {
      fail('INVALID_DERIVE_TRANSFORM', `${field} must use the versioned first-lines transform.`);
    }
    return {
      mode,
      from,
      transform: {
        id: 'first-lines',
        version: 1,
        maxLines: finiteInteger(raw.transform.maxLines, `${field}.transform.maxLines`, 1, 8, 2)
      },
      ...presentation
    };
  }
  return { mode: 'hidden', ...presentation };
}

function normalizeBibleRange(raw, field) {
  if (!isRecord(raw) || !isRecord(raw.start) || !isRecord(raw.end)) {
    fail('INVALID_BIBLE_RANGE', `${field} needs a canonical range.`);
  }
  const range = {
    bookId: id(raw.bookId, `${field} bookId`),
    start: {
      chapter: finiteInteger(raw.start.chapter, `${field} start chapter`, 1, 200),
      verse: finiteInteger(raw.start.verse, `${field} start verse`, 1, 999)
    },
    end: {
      chapter: finiteInteger(raw.end.chapter, `${field} end chapter`, 1, 200),
      verse: finiteInteger(raw.end.verse, `${field} end verse`, 1, 999)
    }
  };
  if (range.end.chapter < range.start.chapter
    || (range.end.chapter === range.start.chapter && range.end.verse < range.start.verse)) {
    fail('INVALID_BIBLE_RANGE', `${field} cannot end before it starts.`);
  }
  return range;
}

function normalizeProjectItem(raw, channelIds, now) {
  if (!isRecord(raw)) fail('INVALID_PROJECT_ITEM', 'Every project item must be an object.');
  const itemId = id(raw.id, 'Project item id');
  if (!PROJECT_ITEM_KINDS.includes(raw.kind)) {
    fail('INVALID_PROJECT_ITEM_KIND', `Item ${itemId} has unsupported kind ${raw.kind}.`, { itemId, kind: raw.kind });
  }
  const common = {
    id: itemId,
    kind: raw.kind,
    title: text(raw.title || raw.kind, `Item ${itemId} title`, 200, { required: true }),
    createdAt: timestamp(raw.createdAt, `Item ${itemId} createdAt`, now.toISOString()),
    updatedAt: timestamp(raw.updatedAt, `Item ${itemId} updatedAt`, now.toISOString()),
    operatorNotes: text(raw.operatorNotes, `Item ${itemId} operatorNotes`, 4000, { trim: false })
  };

  if (raw.kind === 'group') {
    if (!PROJECT_GROUP_KINDS.includes(raw.groupKind)) {
      fail('INVALID_GROUP_KIND', `Group ${itemId} has unsupported kind ${raw.groupKind}.`);
    }
    return {
      ...common,
      groupKind: raw.groupKind,
      childIds: normalizeUniqueIds(raw.childIds || [], `Group ${itemId} childIds`, MAX_GROUP_CHILDREN)
    };
  }

  if (raw.kind === 'song') {
    if (!isRecord(raw.variants)) fail('INVALID_SONG_VARIANTS', `Song item ${itemId} needs channel variants.`);
    const variants = {};
    for (const [channelId, variant] of Object.entries(raw.variants)) {
      if (!channelIds.includes(channelId)) fail('UNKNOWN_PROJECT_CHANNEL', `Song item ${itemId} uses unknown channel ${channelId}.`);
      variants[channelId] = normalizeSongVariant(variant, `Song item ${itemId} channel ${channelId}`, channelId);
    }
    if (Object.keys(variants).length < 1) fail('INVALID_SONG_VARIANTS', `Song item ${itemId} needs at least one channel variant.`);
    if (!Array.isArray(raw.arrangement) || raw.arrangement.length < 1 || raw.arrangement.length > MAX_ARRANGEMENT_ENTRIES) {
      fail('INVALID_ARRANGEMENT', `Song item ${itemId} needs 1 to ${MAX_ARRANGEMENT_ENTRIES} arrangement entries.`);
    }
    const arrangementIds = new Set();
    const arrangement = raw.arrangement.map((entry, index) => {
      if (!isRecord(entry)) fail('INVALID_ARRANGEMENT', `Song arrangement entry ${index + 1} must be an object.`);
      const arrangementId = id(entry.id, `Song arrangement entry ${index + 1} id`);
      if (arrangementIds.has(arrangementId)) fail('DUPLICATE_ARRANGEMENT_ID', `Song arrangement repeats id ${arrangementId}.`);
      arrangementIds.add(arrangementId);
      return { id: arrangementId, sectionId: id(entry.sectionId, `Song arrangement entry ${index + 1} sectionId`) };
    });
    let primaryChannelId = null;
    if (raw.primaryChannelId !== undefined && raw.primaryChannelId !== null) {
      primaryChannelId = id(raw.primaryChannelId, `Song item ${itemId} primaryChannelId`);
      if (!channelIds.includes(primaryChannelId)
        || variants[primaryChannelId]?.mode !== 'content') {
        fail(
          'INVALID_PRIMARY_SONG_CHANNEL',
          `Song item ${itemId} primary channel must be a direct content channel.`,
          { itemId, primaryChannelId }
        );
      }
    }
    return {
      ...common,
      variants,
      arrangement,
      ...(raw.songPresentation !== undefined
        ? { songPresentation: normalizeSongPresentation(raw.songPresentation, channelIds, variants) } : {}),
      ...(primaryChannelId ? { primaryChannelId } : {}),
      titlePresetId: id(raw.titlePresetId || 'song-title', `Song item ${itemId} titlePresetId`),
      lyricsPresetId: id(raw.lyricsPresetId || 'song-lyrics', `Song item ${itemId} lyricsPresetId`)
    };
  }

  if (raw.kind === 'bible') {
    const range = normalizeBibleRange(raw.range, `Bible item ${itemId}`);
    if (!isRecord(raw.passagesByChannel)) fail('INVALID_BIBLE_VARIANTS', `Bible item ${itemId} needs passage variants.`);
    const passagesByChannel = {};
    for (const [channelId, passage] of Object.entries(raw.passagesByChannel)) {
      if (!channelIds.includes(channelId)) fail('UNKNOWN_PROJECT_CHANNEL', `Bible item ${itemId} uses unknown channel ${channelId}.`);
      passagesByChannel[channelId] = normalizeBlock(
        { ...passage, type: 'bible' },
        `Bible item ${itemId} channel ${channelId}`
      );
    }
    if (Object.keys(passagesByChannel).length < 1) fail('INVALID_BIBLE_VARIANTS', `Bible item ${itemId} needs at least one passage.`);
    return { ...common, range, passagesByChannel, presetId: id(raw.presetId || 'scripture-text', `Bible item ${itemId} presetId`) };
  }

  if (raw.kind === 'sermon' || raw.kind === 'notice') {
    if (!isRecord(raw.textByChannel)) fail('INVALID_TEXT_VARIANTS', `Item ${itemId} needs text variants.`);
    const textByChannel = {};
    for (const [channelId, value] of Object.entries(raw.textByChannel)) {
      if (!channelIds.includes(channelId)) fail('UNKNOWN_PROJECT_CHANNEL', `Item ${itemId} uses unknown channel ${channelId}.`);
      textByChannel[channelId] = text(value, `Item ${itemId} channel ${channelId}`, 20000, { required: true, trim: false });
    }
    if (Object.keys(textByChannel).length < 1) fail('INVALID_TEXT_VARIANTS', `Item ${itemId} needs at least one text variant.`);
    let spansByChannel;
    if (raw.spansByChannel !== undefined) {
      if (!isRecord(raw.spansByChannel)) {
        fail('INVALID_TEXT_SPANS', `Item ${itemId} inline formatting must be an object.`);
      }
      spansByChannel = {};
      for (const [channelId, rawSpans] of Object.entries(raw.spansByChannel)) {
        if (!channelIds.includes(channelId)) {
          fail('UNKNOWN_PROJECT_CHANNEL', `Item ${itemId} uses unknown inline-formatting channel ${channelId}.`);
        }
        if (!Object.prototype.hasOwnProperty.call(textByChannel, channelId)) {
          fail(
            'INVALID_TEXT_SPANS',
            `Item ${itemId} cannot format channel ${channelId} because that channel has no authoritative text.`,
            { itemId, channelId }
          );
        }
        const spans = normalizeTextSpans(
          rawSpans,
          textByChannel[channelId],
          `Item ${itemId} channel ${channelId} spans`
        );
        if (spans.length > 0) spansByChannel[channelId] = spans;
      }
      if (Object.keys(spansByChannel).length < 1) spansByChannel = undefined;
    }
    let titlesByChannel;
    if (raw.titlesByChannel !== undefined) {
      if (!isRecord(raw.titlesByChannel)) {
        fail('INVALID_TITLE_VARIANTS', `Item ${itemId} output titles must be an object.`);
      }
      titlesByChannel = {};
      for (const [channelId, value] of Object.entries(raw.titlesByChannel)) {
        if (!channelIds.includes(channelId)) {
          fail('UNKNOWN_PROJECT_CHANNEL', `Item ${itemId} uses unknown title channel ${channelId}.`);
        }
        titlesByChannel[channelId] = text(
          value,
          `Item ${itemId} title channel ${channelId}`,
          200,
          { required: true }
        );
      }
      if (Object.keys(titlesByChannel).length < 1) {
        fail('INVALID_TITLE_VARIANTS', `Item ${itemId} needs at least one output title.`);
      }
    }
    return {
      ...common,
      textByChannel,
      ...(spansByChannel ? { spansByChannel } : {}),
      ...(titlesByChannel ? { titlesByChannel } : {}),
      presetId: id(raw.presetId || (raw.kind === 'sermon' ? 'sermon-point' : 'notice-text'), `Item ${itemId} presetId`)
    };
  }

  if (raw.kind === 'picture') {
    const fit = raw.fit || 'fit';
    if (!IMAGE_FITS.includes(fit)) fail('INVALID_IMAGE_FIT', `Picture item ${itemId} has unsupported fit ${fit}.`);
    let pictureSource;
    if (isRecord(raw.assetIdsByChannel)) {
      const assetIdsByChannel = {};
      for (const [channelId, assetId] of Object.entries(raw.assetIdsByChannel)) {
        if (!channelIds.includes(channelId) || !ASSET_ID_PATTERN.test(assetId || '')) {
          fail(
            'INVALID_PICTURE_VARIANTS',
            `Picture item ${itemId} has an invalid output-specific image.`,
            { itemId, channelId }
          );
        }
        assetIdsByChannel[channelId] = assetId;
      }
      if (Object.keys(assetIdsByChannel).length < 1) {
        fail('INVALID_PICTURE_VARIANTS', `Picture item ${itemId} needs at least one output-specific image.`);
      }
      pictureSource = { assetIdsByChannel };
    } else {
      if (!ASSET_ID_PATTERN.test(raw.assetId || '')) {
        fail('INVALID_ASSET_REFERENCE', `Picture item ${itemId} needs an asset.`);
      }
      pictureSource = {
        assetId: raw.assetId,
        channelIds: normalizeUniqueIds(
          raw.channelIds || channelIds,
          `Picture item ${itemId} channelIds`,
          MAX_PROJECT_CHANNELS
        )
      };
    }
    return {
      ...common,
      ...pictureSource,
      fit,
      focalPoint: normalizeFocalPoint(raw.focalPoint, `Picture item ${itemId} focalPoint`),
      altText: text(raw.altText, `Picture item ${itemId} altText`, 500, { required: true }),
      attribution: text(raw.attribution, `Picture item ${itemId} attribution`, 500),
      presetId: id(raw.presetId || 'picture-fullscreen', `Picture item ${itemId} presetId`)
    };
  }

  if (raw.kind === 'blank') {
    return {
      ...common,
      channelIds: normalizeUniqueIds(raw.channelIds || channelIds, `Blank item ${itemId} channelIds`, MAX_PROJECT_CHANNELS),
      presetId: id(raw.presetId || 'blank-black', `Blank item ${itemId} presetId`)
    };
  }

  if (!isRecord(raw.assetIdsByChannel)) fail('INVALID_DECK_VARIANTS', `Imported deck item ${itemId} needs channel assets.`);
  const assetIdsByChannel = {};
  for (const [channelId, assetId] of Object.entries(raw.assetIdsByChannel)) {
    if (!channelIds.includes(channelId) || !ASSET_ID_PATTERN.test(assetId || '')) {
      fail('INVALID_DECK_VARIANTS', `Imported deck item ${itemId} has an invalid channel asset.`);
    }
    assetIdsByChannel[channelId] = assetId;
  }
  if (!Array.isArray(raw.slides) || raw.slides.length < 1 || raw.slides.length > 5000) {
    fail('INVALID_DECK_SLIDES', `Imported deck item ${itemId} needs 1 to 5000 explicit slides.`);
  }
  const slideIds = new Set();
  const slides = raw.slides.map((slide, index) => {
    if (!isRecord(slide) || !isRecord(slide.sourceIndexes)) fail('INVALID_DECK_SLIDE', `Imported deck slide ${index + 1} is invalid.`);
    const slideId = id(slide.id, `Imported deck slide ${index + 1} id`);
    if (slideIds.has(slideId)) fail('DUPLICATE_DECK_SLIDE', `Imported deck repeats slide id ${slideId}.`);
    slideIds.add(slideId);
    const sourceIndexes = {};
    for (const [channelId, sourceIndex] of Object.entries(slide.sourceIndexes)) {
      if (!assetIdsByChannel[channelId]) fail('INVALID_DECK_SLIDE', `Slide ${slideId} uses an unknown deck channel.`);
      sourceIndexes[channelId] = finiteInteger(sourceIndex, `Slide ${slideId} ${channelId} index`, 0, 9999);
    }
    return { id: slideId, sourceIndexes };
  });
  return { ...common, assetIdsByChannel, slides, presetId: id(raw.presetId || 'legacy-slide', `Item ${itemId} presetId`) };
}

function validateProjectTree(project) {
  const visited = new Set();
  const visiting = new Set();
  const parentByItemId = Object.create(null);
  const groupPathByItemId = Object.create(null);

  const visit = (itemId, parentId, groupPath, depth) => {
    if (depth > MAX_GROUP_DEPTH) fail('PROJECT_TREE_TOO_DEEP', `Project nesting may not exceed ${MAX_GROUP_DEPTH} levels.`);
    if (!project.items[itemId]) fail('MISSING_PROJECT_ITEM', `Project tree references missing item ${itemId}.`);
    if (visiting.has(itemId)) fail('PROJECT_TREE_CYCLE', `Project tree contains a cycle at ${itemId}.`);
    if (visited.has(itemId)) fail('PROJECT_ITEM_MULTIPLE_PARENTS', `Project item ${itemId} appears more than once.`);
    visiting.add(itemId);
    parentByItemId[itemId] = parentId;
    groupPathByItemId[itemId] = groupPath;
    const item = project.items[itemId];
    if (item.kind === 'group') {
      const nextPath = [...groupPath, { id: item.id, kind: item.groupKind, title: item.title }];
      for (const childId of item.childIds) visit(childId, item.id, nextPath, depth + 1);
    }
    visiting.delete(itemId);
    visited.add(itemId);
  };

  for (const rootId of project.rootItemIds) visit(rootId, null, [], 0);
  const orphanIds = Object.keys(project.items).filter(itemId => !visited.has(itemId));
  if (orphanIds.length > 0) fail('ORPHAN_PROJECT_ITEMS', 'Every project item must appear exactly once in the service order.', { orphanIds });
  return { parentByItemId, groupPathByItemId };
}

function resolveSongVariant(item, channelId, resources, stack = new Set()) {
  const variant = item.variants[channelId] || { mode: 'hidden' };
  if (variant.mode === 'hidden') return { mode: 'hidden' };
  if (stack.has(channelId)) fail('CHANNEL_INHERITANCE_CYCLE', `Song item ${item.id} has a channel cycle.`);
  if (variant.mode === 'content') {
    const resource = resources[variant.resourceId];
    if (!resource || resource.kind !== 'song') {
      fail('MISSING_RESOURCE', `Song item ${item.id} references a missing song resource.`, { resourceId: variant.resourceId });
    }
    return { mode: 'content', resource, sourceChannelId: channelId };
  }
  if (!item.variants[variant.from]) {
    fail('MISSING_INHERITED_CHANNEL', `Song item ${item.id} references missing channel ${variant.from}.`);
  }
  const nextStack = new Set(stack);
  nextStack.add(channelId);
  const resolved = resolveSongVariant(item, variant.from, resources, nextStack);
  if (variant.mode === 'derive') return { ...resolved, mode: 'derive', transform: variant.transform };
  return resolved;
}

function songContentDependencyCounts(item, channelIds) {
  const counts = new Map();
  for (const channelId of channelIds) {
    let currentChannelId = channelId;
    const visited = new Set();
    while (!visited.has(currentChannelId)) {
      visited.add(currentChannelId);
      const variant = item.variants[currentChannelId];
      if (!variant || variant.mode === 'hidden') break;
      if (variant.mode === 'content') {
        counts.set(currentChannelId, (counts.get(currentChannelId) || 0) + 1);
        break;
      }
      currentChannelId = variant.from;
    }
  }
  return counts;
}

/**
 * Resolve the immutable source SongDocument for one semantic song item.
 *
 * New items persist primaryChannelId. Older schema-v1 revisions deliberately
 * remain byte-stable, so their source is derived without rewriting history:
 * prefer an original/root SongDocument, then the direct content channel that
 * the inheritance graph treats as its source. Configurable channel ordering is
 * only the final deterministic tie-breaker.
 */
function authoritativeSongSource(project, item) {
  if (item.primaryChannelId) {
    const resolved = resolveSongVariant(item, item.primaryChannelId, project.resources);
    if (!resolved.resource) {
      fail(
        'MISSING_RESOURCE',
        `Song item ${item.id} has no content in its persisted primary channel.`,
        { itemId: item.id, primaryChannelId: item.primaryChannelId }
      );
    }
    return {
      channelId: item.primaryChannelId,
      resource: resolved.resource
    };
  }

  const dependencyCounts = songContentDependencyCounts(item, project.channelIds);
  const candidates = project.channelIds
    .map((channelId, channelIndex) => {
      const variant = item.variants[channelId];
      if (variant?.mode !== 'content') return null;
      const resource = project.resources[variant.resourceId];
      if (!resource || resource.kind !== 'song') return null;
      return {
        channelId,
        channelIndex,
        dependencyCount: dependencyCounts.get(channelId) || 0,
        resource
      };
    })
    .filter(Boolean);
  if (candidates.length < 1) {
    fail('MISSING_RESOURCE', `Song item ${item.id} has no direct content channel.`);
  }

  const candidateDocumentIds = new Set(candidates.map(candidate => candidate.resource.document.id));
  candidates.sort((left, right) => {
    const leftIsOriginal = left.resource.document.translationOf ? 0 : 1;
    const rightIsOriginal = right.resource.document.translationOf ? 0 : 1;
    if (leftIsOriginal !== rightIsOriginal) return rightIsOriginal - leftIsOriginal;
    const leftIsRelationshipRoot = candidates.some(candidate =>
      candidate.resource.document.translationOf === left.resource.document.id) ? 1 : 0;
    const rightIsRelationshipRoot = candidates.some(candidate =>
      candidate.resource.document.translationOf === right.resource.document.id) ? 1 : 0;
    if (leftIsRelationshipRoot !== rightIsRelationshipRoot) {
      return rightIsRelationshipRoot - leftIsRelationshipRoot;
    }
    const leftTargetsMissingRoot = left.resource.document.translationOf
      && !candidateDocumentIds.has(left.resource.document.translationOf) ? 1 : 0;
    const rightTargetsMissingRoot = right.resource.document.translationOf
      && !candidateDocumentIds.has(right.resource.document.translationOf) ? 1 : 0;
    if (leftTargetsMissingRoot !== rightTargetsMissingRoot) {
      return leftTargetsMissingRoot - rightTargetsMissingRoot;
    }
    if (left.dependencyCount !== right.dependencyCount) {
      return right.dependencyCount - left.dependencyCount;
    }
    return left.channelIndex - right.channelIndex;
  });
  return {
    channelId: candidates[0].channelId,
    resource: candidates[0].resource
  };
}

function normalizeEditableServiceProject(raw, options = {}) {
  if (!isRecord(raw) || raw.kind !== EDITABLE_PROJECT_KIND || raw.schemaVersion !== SERVICE_PROJECT_SCHEMA_VERSION) {
    fail('INVALID_PROJECT', `ServiceProject must be a ${EDITABLE_PROJECT_KIND} schema v${SERVICE_PROJECT_SCHEMA_VERSION} document.`);
  }
  const now = options.now instanceof Date ? options.now : new Date(options.now || Date.now());
  const projectId = id(raw.id, 'Project id');
  const channelIds = normalizeUniqueIds(raw.channelIds, 'Project channelIds', MAX_PROJECT_CHANNELS);
  if (channelIds.length < 1) fail('INVALID_PROJECT_CHANNELS', 'A project needs at least one channel.');
  if (!isRecord(raw.channels) || Object.keys(raw.channels).length !== channelIds.length) {
    fail('INVALID_PROJECT_CHANNELS', 'channelIds and channels must contain exactly the same channels.');
  }
  const channels = {};
  for (const channelId of channelIds) channels[channelId] = normalizeProjectChannel(raw.channels[channelId], channelId);
  if (Object.keys(raw.channels).some(channelId => !channelIds.includes(channelId))) {
    fail('INVALID_PROJECT_CHANNELS', 'channelIds and channels must contain exactly the same channels.');
  }

  if (!isRecord(raw.resources) || Object.keys(raw.resources).length > 2000) fail('INVALID_RESOURCES', 'Project resources are invalid.');
  const resources = {};
  for (const resourceId of Object.keys(raw.resources).sort()) {
    resources[resourceId] = normalizeProjectResource(raw.resources[resourceId], resourceId);
  }
  if (!isRecord(raw.assets) || Object.keys(raw.assets).length > MAX_ASSETS) fail('INVALID_ASSETS', 'Project assets are invalid.');
  const assets = {};
  for (const assetId of Object.keys(raw.assets).sort()) assets[assetId] = normalizeAsset(raw.assets[assetId], assetId);
  if (!isRecord(raw.items) || Object.keys(raw.items).length > MAX_PROJECT_ITEMS) fail('INVALID_PROJECT_ITEMS', `A project can contain at most ${MAX_PROJECT_ITEMS} items.`);
  const items = {};
  for (const itemId of Object.keys(raw.items)) {
    const normalized = normalizeProjectItem(raw.items[itemId], channelIds, now);
    if (normalized.id !== itemId) fail('ITEM_ID_MISMATCH', `Item key ${itemId} does not match ${normalized.id}.`);
    items[itemId] = normalized;
  }
  const rootItemIds = normalizeUniqueIds(raw.rootItemIds || [], 'Project rootItemIds', MAX_PROJECT_ITEMS);
  const presetPack = isRecord(raw.presetPack) ? raw.presetPack : {};
  const normalized = {
    schemaVersion: SERVICE_PROJECT_SCHEMA_VERSION,
    kind: EDITABLE_PROJECT_KIND,
    id: projectId,
    title: text(raw.title, 'Project title', 200, { required: true }),
    serviceDate: isoDate(raw.serviceDate, 'Project serviceDate'),
    createdAt: timestamp(raw.createdAt, 'Project createdAt', now.toISOString()),
    updatedAt: timestamp(raw.updatedAt, 'Project updatedAt', now.toISOString()),
    revision: finiteInteger(raw.revision, 'Project revision', 0, Number.MAX_SAFE_INTEGER, 0),
    preferredProfileId: id(raw.preferredProfileId, 'Project preferredProfileId'),
    channelIds,
    channels,
    rootItemIds,
    items,
    resources,
    assets,
    presetPack: {
      id: id(presetPack.id || raw.preferredProfileId, 'Project presetPack id'),
      version: finiteInteger(presetPack.version, 'Project presetPack version', 1, 1000000, 1),
      sha256: presetPack.sha256 && SHA256_PATTERN.test(presetPack.sha256) ? presetPack.sha256 : null
    }
  };
  const index = validateProjectTree(normalized);

  for (const item of Object.values(items)) {
    if (item.kind === 'song') {
      const resolved = channelIds.map(channelId => resolveSongVariant(item, channelId, resources));
      const source = authoritativeSongSource(normalized, item).resource;
      for (const entry of item.arrangement) {
        const baseSection = source.document.sections.find(section => section.id === entry.sectionId);
        if (!baseSection) fail('UNKNOWN_ARRANGEMENT_SECTION', `Song item ${item.id} uses missing section ${entry.sectionId}.`);
        for (const variant of resolved.filter(candidate => candidate.resource)) {
          const translatedSection = variant.resource.document.sections.find(section => section.id === entry.sectionId);
          if (!translatedSection || translatedSection.slides.length !== baseSection.slides.length) {
            fail('TRANSLATION_MISMATCH', `Song item ${item.id} has an unaligned translation for ${entry.sectionId}.`);
          }
        }
      }
    } else if (item.kind === 'picture') {
      const pictureAssets = item.assetIdsByChannel
        ? Object.values(item.assetIdsByChannel)
        : [item.assetId];
      if (pictureAssets.some(assetId => !assets[assetId] || assets[assetId].kind !== 'image')) {
        fail('MISSING_ASSET', `Picture item ${item.id} has no pinned image.`);
      }
      if (item.channelIds?.some(channelId => !channelIds.includes(channelId))) {
        fail('UNKNOWN_PROJECT_CHANNEL', `Picture item ${item.id} uses an unknown channel.`);
      }
    } else if (item.kind === 'blank') {
      if (item.channelIds.some(channelId => !channelIds.includes(channelId))) fail('UNKNOWN_PROJECT_CHANNEL', `Blank item ${item.id} uses an unknown channel.`);
    } else if (item.kind === 'imported-deck') {
      for (const assetId of Object.values(item.assetIdsByChannel)) {
        if (!assets[assetId] || assets[assetId].kind !== 'deck') fail('MISSING_ASSET', `Imported deck item ${item.id} has no pinned deck.`);
      }
    }
  }

  const size = Buffer.byteLength(JSON.stringify(normalized), 'utf8');
  if (size > MAX_PROJECT_JSON_BYTES) {
    fail('PROJECT_TOO_LARGE', `A project can use at most ${MAX_PROJECT_JSON_BYTES / (1024 * 1024)} MB of structured data.`);
  }
  Object.defineProperty(normalized, '_index', { value: index, enumerable: false });
  return deepFreeze(normalized);
}

function createEditableServiceProject(options = {}) {
  const now = options.now instanceof Date ? options.now : new Date(options.now || Date.now());
  const serviceDate = isoDate(options.serviceDate, 'Project serviceDate');
  const projectId = id(options.id || `project-${crypto.randomUUID()}`, 'Project id');
  const rawChannels = Array.isArray(options.channels) && options.channels.length > 0
    ? options.channels
    : [
        { id: 'primary', label: 'Primary', language: 'und' },
        { id: 'secondary', label: 'Secondary', language: 'und' },
        { id: 'media', label: 'Singers', language: 'und' }
      ];
  return normalizeEditableServiceProject({
    schemaVersion: SERVICE_PROJECT_SCHEMA_VERSION,
    kind: EDITABLE_PROJECT_KIND,
    id: projectId,
    title: options.title || 'Sunday Service',
    serviceDate,
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    revision: 0,
    preferredProfileId: options.preferredProfileId || options.profileId,
    channelIds: rawChannels.map(channel => channel.id),
    channels: Object.fromEntries(rawChannels.map(channel => [channel.id, channel])),
    rootItemIds: [],
    items: {},
    resources: {},
    assets: {},
    presetPack: {
      id: options.presetPackId || options.preferredProfileId || options.profileId,
      version: options.presetPackVersion || 1,
      sha256: null
    }
  }, { now });
}

function serializeEditableServiceProject(project) {
  const normalized = normalizeEditableServiceProject(project);
  const serializable = {
    schemaVersion: normalized.schemaVersion,
    kind: normalized.kind,
    id: normalized.id,
    title: normalized.title,
    serviceDate: normalized.serviceDate,
    createdAt: normalized.createdAt,
    updatedAt: normalized.updatedAt,
    revision: normalized.revision,
    preferredProfileId: normalized.preferredProfileId,
    channelIds: normalized.channelIds,
    channels: stableObject(normalized.channels),
    rootItemIds: normalized.rootItemIds,
    items: stableObject(normalized.items),
    resources: stableObject(normalized.resources),
    assets: stableObject(normalized.assets),
    presetPack: stableObject(normalized.presetPack)
  };
  return `${JSON.stringify(serializable, null, 2)}\n`;
}

function deterministicCueId(projectId, itemId, leafKey) {
  const digest = crypto.createHash('sha256')
    .update('syncshow-cue-v1\0')
    .update(projectId)
    .update('\0')
    .update(itemId)
    .update('\0')
    .update(leafKey)
    .digest('hex')
    .slice(0, 24);
  return `cue-${digest}`;
}

function songTitleCardMode(project, item, channelId) {
  const explicit = item.variants[channelId]?.titleCardMode;
  if (explicit) return explicit;
  const channel = project.channels[channelId];
  const identity = `${channelId} ${channel?.label || ''}`.toLowerCase();
  return /(^|[^a-z])(media|singer|singers|stage|choir)([^a-z]|$)/.test(identity)
    ? 'simple'
    : 'full';
}

function songCreditLine(document, originalDocument = null, fallbackLanguage = 'en') {
  if (document.attribution) {
    return document.attribution
      .replace(/;\s+/g, '\n')
      .replace(/^(Слова и музыка|Музыка и слова):[ \t]+/iu, '$1:\n')
      .replace(/^Music and words by[ \t]+/iu, 'Music and words by\n');
  }
  const original = originalDocument || document;
  const authors = document.authors?.length ? document.authors : (original.authors || []);
  const composers = document.composers?.length ? document.composers : (original.composers || []);
  const translators = document.translators || [];
  if (authors.length === 0 && composers.length === 0 && translators.length === 0) return '';

  const documentLanguage = String(document.language || '').toLowerCase().split(/[-_]/)[0];
  const language = ['', 'mul', 'und', 'zxx'].includes(documentLanguage)
    ? String(fallbackLanguage || 'en').toLowerCase().split(/[-_]/)[0]
    : documentLanguage;
  const labels = language === 'ru'
    ? {
        combined: 'Слова и музыка',
        words: 'Слова',
        music: 'Музыка',
        translation: 'Перевод'
      }
    : language === 'uk'
      ? {
          combined: 'Слова і музика',
          words: 'Слова',
          music: 'Музика',
          translation: 'Переклад'
        }
      : {
          combined: 'Words and music',
          words: 'Words',
          music: 'Music',
          translation: 'Translation'
        };
  const normalizedList = values => values.map(value => value.trim().toLowerCase());
  const sameCredits = authors.length > 0
    && authors.length === composers.length
    && normalizedList(authors).every((value, index) => value === normalizedList(composers)[index]);
  const lines = [];
  if (sameCredits) {
    lines.push(`${labels.combined}: ${authors.join(', ')}`);
  } else {
    if (authors.length > 0) lines.push(`${labels.words}: ${authors.join(', ')}`);
    if (composers.length > 0) lines.push(`${labels.music}: ${composers.join(', ')}`);
  }
  if (translators.length > 0) lines.push(`${labels.translation}: ${translators.join(', ')}`);
  const value = lines.join('\n');
  if (value.length <= 2048) return value;
  let shortened = value.slice(0, 2047);
  const finalCodeUnit = shortened.charCodeAt(shortened.length - 1);
  if (finalCodeUnit >= 0xD800 && finalCodeUnit <= 0xDBFF) shortened = shortened.slice(0, -1);
  return `${shortened}…`;
}

function compileServiceProject(rawProject, options = {}) {
  const project = normalizeEditableServiceProject(rawProject);
  const cueIds = [];
  const cues = {};
  const index = project._index || validateProjectTree(project);
  const addCue = (item, leafKey, rawCue) => {
    const cueId = deterministicCueId(project.id, item.id, leafKey);
    if (cues[cueId]) fail('CUE_ID_COLLISION', `Compiled cue id collision at ${item.id}.`);
    const cue = normalizeCue({ ...rawCue, id: cueId, itemId: item.id });
    cueIds.push(cueId);
    cues[cueId] = cue;
  };

  const compileLeaf = item => {
    const groupRecords = index.groupPathByItemId[item.id] || [];
    const groupPath = groupRecords.map(group => group.title);
    if (item.kind === 'song') {
      const resolvedByChannel = Object.fromEntries(project.channelIds.map(channelId => [
        channelId,
        resolveSongVariant(item, channelId, project.resources)
      ]));
      const source = authoritativeSongSource(project, item).resource;
      const titleCardModeByChannel = Object.fromEntries(project.channelIds.map(channelId => [
        channelId,
        songTitleCardMode(project, item, channelId)
      ]));
      const publicTitleSet = new Set(project.channelIds
        .filter(channelId => titleCardModeByChannel[channelId] === 'full')
        .map(channelId => resolvedByChannel[channelId])
        .filter(resolved => resolved.mode !== 'hidden' && resolved.resource)
        .map(resolved => resolved.resource.document.title));
      for (const channelId of project.channelIds) {
        if (item.variants[channelId]?.titleCardMode
          || titleCardModeByChannel[channelId] !== 'simple') {
          continue;
        }
        const variant = item.variants[channelId];
        const document = resolvedByChannel[channelId]?.resource?.document;
        const language = String(document?.language || '').toLowerCase().split(/[-_]/)[0];
        if ((variant?.mode === 'content' && language === 'mul')
          || (variant?.mode === 'inherit'
            && publicTitleSet.size === 1
            && Boolean(document?.attribution))) {
          titleCardModeByChannel[channelId] = 'full';
        }
      }
      const publicBaseDocument = project.channelIds
        .filter(channelId => titleCardModeByChannel[channelId] === 'full')
        .map(channelId => resolvedByChannel[channelId])
        .find(resolved => resolved.mode !== 'hidden' && resolved.resource)
        ?.resource.document || source.document;
      const titleChannels = {};
      for (const channelId of project.channelIds) {
        const resolved = resolvedByChannel[channelId];
        if (resolved.mode === 'hidden') {
          titleChannels[channelId] = { mode: 'hide', blocks: [] };
          continue;
        }
        const fullTitleCard = titleCardModeByChannel[channelId] === 'full';
        const sourceTitle = publicBaseDocument.title;
        const resolvedTitle = resolved.resource.document.title;
        const alternate = !fullTitleCard
          ? null
          : (resolvedTitle !== sourceTitle
              ? resolved.resource.document
              : project.channelIds
                .map(candidateId => resolvedByChannel[candidateId])
                .find((candidate, index) =>
                  titleCardModeByChannel[project.channelIds[index]] === 'full'
                  && candidate.mode !== 'hidden'
                  && candidate.resource
                  && candidate.resource.document.title !== sourceTitle
                )?.resource.document || null);
        const titleBlocks = [{
          type: 'text',
          role: 'title',
          text: fullTitleCard ? sourceTitle : resolvedTitle
        }];
        if (alternate) {
          titleBlocks.push({
            type: 'text',
            role: 'subtitle',
            text: alternate.title
          });
        }
        const credit = !fullTitleCard
          ? ''
          : songCreditLine(
              resolved.resource.document,
              source.document,
              project.channels[channelId]?.language
            );
        if (credit) {
          titleBlocks.push({
            type: 'text',
            role: 'credit',
            text: credit
          });
        }
        titleChannels[channelId] = {
          mode: resolved.mode === 'derive' ? 'condensed' : 'content',
          ...(resolved.mode === 'derive'
            ? { sourceChannelId: resolved.sourceChannelId }
            : {}),
          blocks: presentationTitleBlocks(item, resolvedByChannel, channelId) || titleBlocks
        };
      }
      addCue(item, 'title', {
        kind: 'song',
        title: item.title,
        groupPath: [...groupPath, item.title],
        channels: titleChannels,
        operatorNotes: item.operatorNotes,
        presetId: item.titlePresetId,
        sourceReference: {
          type: 'project-item',
          id: item.id,
          revision: String(project.revision),
          sectionId: null
        }
      });
      for (const entry of item.arrangement) {
        const sourceSection = source.document.sections.find(section => section.id === entry.sectionId);
        for (const [slideIndex, sourceSlide] of sourceSection.slides.entries()) {
          const channels = {};
          for (const channelId of project.channelIds) {
            const resolved = resolvedByChannel[channelId];
            if (resolved.mode === 'hidden') {
              channels[channelId] = { mode: 'hide', blocks: [] };
              continue;
            }
            const section = resolved.resource.document.sections.find(candidate => candidate.id === entry.sectionId);
            let lines = section.slides[slideIndex].lines;
            if (resolved.mode === 'derive') {
              lines = lines.filter(Boolean).slice(0, resolved.transform.maxLines);
            }
            channels[channelId] = {
              mode: resolved.mode === 'derive' ? 'condensed' : 'content',
              ...(resolved.mode === 'derive'
                ? { sourceChannelId: resolved.sourceChannelId }
                : {}),
              blocks: presentationLyricBlocks(item, resolvedByChannel, channelId, entry.sectionId, slideIndex)
                || [{ type: 'text', role: 'lyrics', text: lines.join('\n') }]
            };
          }
          addCue(item, `${entry.id}/${sourceSlide.id}`, {
            kind: 'song',
            title: `${item.title} — ${sourceSection.label}${sourceSection.slides.length > 1 ? ` ${slideIndex + 1}` : ''}`,
            groupPath: [...groupPath, item.title, sourceSection.label],
            channels,
            operatorNotes: item.operatorNotes,
            presetId: item.lyricsPresetId,
            sourceReference: {
              type: 'project-item',
              id: item.id,
              revision: String(project.revision),
              sectionId: entry.sectionId
            }
          });
        }
      }
      return;
    }

    if (item.kind === 'bible') {
      const channels = {};
      for (const channelId of project.channelIds) {
        const passage = item.passagesByChannel[channelId];
        channels[channelId] = passage
          ? { mode: 'content', blocks: [passage] }
          : { mode: 'hide', blocks: [] };
      }
      addCue(item, 'self', {
        kind: 'bible',
        title: item.title,
        groupPath,
        channels,
        operatorNotes: item.operatorNotes,
        presetId: item.presetId
      });
      return;
    }

    if (item.kind === 'sermon' || item.kind === 'notice') {
      const channels = {};
      for (const channelId of project.channelIds) {
        channels[channelId] = item.textByChannel[channelId]
          ? {
              mode: 'content',
              blocks: [
                ...(item.titlesByChannel?.[channelId]
                  ? [{ type: 'text', role: 'title', text: item.titlesByChannel[channelId] }]
                  : []),
                {
                  type: 'text',
                  role: item.kind === 'sermon' ? 'body' : 'caption',
                  text: item.textByChannel[channelId],
                  ...(item.spansByChannel?.[channelId]
                    ? { spans: item.spansByChannel[channelId] }
                    : {})
                }
              ]
            }
          : { mode: 'hide', blocks: [] };
      }
      addCue(item, 'self', {
        kind: item.kind,
        title: item.title,
        groupPath,
        channels,
        operatorNotes: item.operatorNotes,
        presetId: item.presetId
      });
      return;
    }

    if (item.kind === 'picture') {
      const channels = Object.fromEntries(project.channelIds.map(channelId => [
        channelId,
        (item.assetIdsByChannel?.[channelId]
          || (item.channelIds?.includes(channelId) ? item.assetId : null))
          ? {
              mode: 'content',
              blocks: [{
                type: 'image',
                assetId: item.assetIdsByChannel?.[channelId] || item.assetId,
                fit: item.fit,
                focalPoint: item.focalPoint,
                altText: item.altText,
                attribution: item.attribution
              }]
            }
          : { mode: 'hide', blocks: [] }
      ]));
      addCue(item, 'self', {
        kind: 'picture',
        title: item.title,
        groupPath,
        channels,
        operatorNotes: item.operatorNotes,
        presetId: item.presetId
      });
      return;
    }

    if (item.kind === 'blank') {
      const channels = Object.fromEntries(project.channelIds.map(channelId => [
        channelId,
        item.channelIds.includes(channelId)
          ? { mode: 'content', blocks: [{ type: 'blank' }] }
          : { mode: 'hide', blocks: [] }
      ]));
      addCue(item, 'self', {
        kind: 'blank',
        title: item.title,
        groupPath,
        channels,
        operatorNotes: item.operatorNotes,
        presetId: item.presetId
      });
      return;
    }

    for (const slide of item.slides) {
      const channels = {};
      for (const channelId of project.channelIds) {
        const assetId = item.assetIdsByChannel[channelId];
        const slideIndex = slide.sourceIndexes[channelId];
        channels[channelId] = assetId !== undefined && slideIndex !== undefined
          ? { mode: 'content', blocks: [{ type: 'legacy-deck', assetId, slideIndex }] }
          : { mode: 'hide', blocks: [] };
      }
      addCue(item, slide.id, {
        kind: 'slide',
        title: `${item.title} — ${cueIds.length + 1}`,
        groupPath,
        channels,
        operatorNotes: item.operatorNotes,
        presetId: item.presetId
      });
    }
  };

  const walk = itemId => {
    const item = project.items[itemId];
    if (item.kind === 'group') item.childIds.forEach(walk);
    else compileLeaf(item);
  };
  project.rootItemIds.forEach(walk);
  if (cueIds.length < 1 && options.allowEmpty !== true) fail('EMPTY_PROJECT', 'Add at least one projected item before publishing this service.');

  const timeline = normalizeServiceProject({
    schemaVersion: SERVICE_PROJECT_SCHEMA_VERSION,
    id: `compiled:${project.id}`,
    title: project.title,
    serviceDate: project.serviceDate,
    profileId: project.preferredProfileId,
    createdAt: project.createdAt,
    updatedAt: project.updatedAt,
    revision: project.revision,
    cueIds,
    cues,
    assets: project.assets,
    libraryReferences: Object.values(project.resources).map(resource => ({
      id: resource.document.id,
      kind: resource.kind,
      revision: resource.sha256,
      pinnedAt: project.updatedAt
    })),
    presetPackVersion: `${project.presetPack.id}@${project.presetPack.version}`
  });
  return deepFreeze({
    kind: CUE_TIMELINE_KIND,
    compilerVersion: 3,
    projectId: project.id,
    projectRevision: project.revision,
    projectContentHash: crypto.createHash('sha256').update(serializeEditableServiceProject(project)).digest('hex'),
    ...timeline
  });
}

function addSongResource(rawProject, rawSong, origin = null) {
  const project = normalizeEditableServiceProject(rawProject);
  const document = normalizeSongDocument(rawSong);
  const canonical = serializeSongDocument(document);
  const sha256 = crypto.createHash('sha256').update(canonical).digest('hex');
  const resourceId = `sha256:${sha256}`;
  const next = deepClone(project);
  next.resources[resourceId] = {
    id: resourceId,
    kind: 'song',
    schemaVersion: document.schemaVersion,
    mediaType: 'application/vnd.syncshow.song+json',
    size: Buffer.byteLength(canonical, 'utf8'),
    sha256,
    origin: origin || { provider: 'local', itemId: document.id },
    document
  };
  return { project: normalizeEditableServiceProject(next), resourceId };
}

function mutationTimestamp(value, field = 'Mutation timestamp') {
  const candidate = value instanceof Date ? value.toISOString() : value;
  return timestamp(candidate, field, new Date().toISOString());
}

function addProjectItem(rawProject, rawItem, options = {}) {
  const project = normalizeEditableServiceProject(rawProject);
  const item = normalizeProjectItem(rawItem, project.channelIds, new Date(options.now || Date.now()));
  if (project.items[item.id]) fail('DUPLICATE_ITEM_ID', `Project item ${item.id} already exists.`);
  const next = deepClone(project);
  next.items[item.id] = item;
  const siblings = options.parentId === null || options.parentId === undefined
    ? next.rootItemIds
    : next.items[id(options.parentId, 'Parent item id')]?.childIds;
  if (!siblings) fail('INVALID_PARENT', 'Project items can only be placed at the root or inside a group.');
  const at = options.index === undefined || options.index === null
    ? siblings.length
    : finiteInteger(options.index, 'Project item insertion index', 0, siblings.length);
  siblings.splice(at, 0, item.id);
  return normalizeEditableServiceProject(next);
}

/**
 * Remove candidate content-addressed records that the editable semantic item
 * graph no longer reaches. Candidate scoping avoids sweeping unrelated
 * pre-pinned/import-only records during an otherwise focused mutation. This
 * only changes the project document; immutable historical revisions and
 * physical blobs remain available for Undo/Redo.
 */
function pruneUnreachableProjectRecords(rawProject, candidates = {}) {
  const project = normalizeEditableServiceProject(rawProject);
  const reachableResources = new Set();
  const reachableAssets = new Set();
  for (const item of Object.values(project.items)) {
    if (item.kind === 'song') {
      for (const variant of Object.values(item.variants)) {
        if (variant.mode === 'content') reachableResources.add(variant.resourceId);
      }
    } else if (item.kind === 'picture') {
      if (item.assetIdsByChannel) {
        Object.values(item.assetIdsByChannel).forEach(assetId => reachableAssets.add(assetId));
      } else {
        reachableAssets.add(item.assetId);
      }
    } else if (item.kind === 'imported-deck') {
      Object.values(item.assetIdsByChannel).forEach(assetId => reachableAssets.add(assetId));
    }
  }

  const next = deepClone(project);
  for (const resourceId of candidates.resourceIds || []) {
    if (!reachableResources.has(resourceId)) delete next.resources[resourceId];
  }
  for (const assetId of candidates.assetIds || []) {
    if (!reachableAssets.has(assetId)) delete next.assets[assetId];
  }
  return normalizeEditableServiceProject(next);
}

/**
 * Remove one semantic item or complete group subtree, then prune only records
 * that no remaining item references. Shared songs, pictures, and imported-deck
 * assets remain in the new revision.
 */
function removeProjectItemAndDescendants(rawProject, rawItemId) {
  const project = normalizeEditableServiceProject(rawProject);
  const itemId = id(rawItemId, 'Project item id');
  if (!project.items[itemId]) {
    fail('UNKNOWN_PROJECT_ITEM', `Project item ${itemId} does not exist.`);
  }

  const removeIds = [];
  const resourceIds = new Set();
  const assetIds = new Set();
  const collect = currentId => {
    const item = project.items[currentId];
    if (item.kind === 'group') item.childIds.forEach(collect);
    if (item.kind === 'song') {
      for (const variant of Object.values(item.variants)) {
        if (variant.mode === 'content') resourceIds.add(variant.resourceId);
      }
    } else if (item.kind === 'picture') {
      if (item.assetIdsByChannel) {
        Object.values(item.assetIdsByChannel).forEach(assetId => assetIds.add(assetId));
      } else {
        assetIds.add(item.assetId);
      }
    } else if (item.kind === 'imported-deck') {
      Object.values(item.assetIdsByChannel).forEach(assetId => assetIds.add(assetId));
    }
    removeIds.push(currentId);
  };
  collect(itemId);

  const next = deepClone(project);
  const parentId = project._index.parentByItemId[itemId];
  const siblings = parentId === null
    ? next.rootItemIds
    : next.items[parentId].childIds;
  const siblingIndex = siblings.indexOf(itemId);
  if (siblingIndex < 0) {
    fail('ORPHAN_PROJECT_ITEM', `Project item ${itemId} was not in the service order.`);
  }
  siblings.splice(siblingIndex, 1);
  removeIds.forEach(removeId => delete next.items[removeId]);
  return pruneUnreachableProjectRecords(next, { resourceIds, assetIds });
}

/**
 * Add an empty semantic group. Existing items are nested through
 * moveProjectItem(), which keeps this operation from accidentally assigning a
 * child twice or creating a cycle.
 */
function addGroupItem(rawProject, options = {}) {
  const project = normalizeEditableServiceProject(rawProject);
  if (options.childIds !== undefined
    && (!Array.isArray(options.childIds) || options.childIds.length > 0)) {
    fail('INVALID_NEW_GROUP_CHILDREN', 'A new group must start empty. Move existing items into it after creation.');
  }
  const now = mutationTimestamp(options.now, 'Group creation timestamp');
  return addProjectItem(project, {
    id: options.id,
    kind: 'group',
    title: options.title || 'Section',
    groupKind: options.groupKind || 'section',
    childIds: [],
    operatorNotes: options.operatorNotes || '',
    createdAt: now,
    updatedAt: now
  }, {
    parentId: options.parentId,
    index: options.index,
    now
  });
}

function requireProjectItem(project, rawItemId, expectedKinds = null) {
  const itemId = id(rawItemId, 'Project item id');
  const item = project.items[itemId];
  if (!item) fail('UNKNOWN_PROJECT_ITEM', `Project item ${itemId} does not exist.`);
  if (Array.isArray(expectedKinds) && !expectedKinds.includes(item.kind)) {
    fail(
      'WRONG_PROJECT_ITEM_KIND',
      `Project item ${itemId} is not a supported ${expectedKinds.join(' or ')} item.`,
      { itemId, actualKind: item.kind, expectedKinds }
    );
  }
  return item;
}

function replaceProjectItem(project, item) {
  const next = deepClone(project);
  next.items[item.id] = item;
  return normalizeEditableServiceProject(next);
}

/**
 * Rename or reclassify one semantic group without changing its identity,
 * children, or position. Stable item IDs keep every descendant Cue ID stable.
 */
function updateGroupItem(rawProject, options = {}) {
  const project = normalizeEditableServiceProject(rawProject);
  const item = requireProjectItem(project, options.itemId, ['group']);
  const updatedAt = mutationTimestamp(options.now, 'Group update timestamp');
  const candidate = normalizeProjectItem({
    ...deepClone(item),
    ...(options.title !== undefined ? { title: options.title } : {}),
    ...(options.groupKind !== undefined ? { groupKind: options.groupKind } : {}),
    ...(options.operatorNotes !== undefined ? { operatorNotes: options.operatorNotes } : {}),
    updatedAt
  }, project.channelIds, new Date(updatedAt));
  return replaceProjectItem(project, candidate);
}

/**
 * Edit a sermon/notice leaf in place. The caller supplies the complete desired
 * channel map so removing an override is explicit, while the project validator
 * continues to reject unknown outputs and empty text variants. Inline spans
 * are likewise a complete desired map when supplied; null clears every span.
 * If omitted, spans survive only channels whose authoritative text is byte
 * identical so an ordinary text edit can never reuse stale offsets.
 */
function updateTextItem(rawProject, options = {}) {
  const project = normalizeEditableServiceProject(rawProject);
  const item = requireProjectItem(project, options.itemId, ['sermon', 'notice']);
  let presetId = item.presetId;
  if (options.presetId !== undefined) {
    presetId = id(options.presetId, `${item.kind} preset id`);
    if (!isNativePresetAllowed(presetId, item.kind)) {
      fail(
        'INVALID_NATIVE_PRESET',
        `Preset ${presetId} cannot be used for a ${item.kind} item.`,
        {
          itemId: item.id,
          kind: item.kind,
          presetId,
          allowedPresetIds: listNativePresets(item.kind).map(preset => preset.id)
        }
      );
    }
  }
  const updatedAt = mutationTimestamp(options.now, 'Text item update timestamp');
  const source = deepClone(item);
  if (options.spansByChannel === null) {
    delete source.spansByChannel;
  } else if (options.spansByChannel !== undefined) {
    source.spansByChannel = options.spansByChannel;
  } else if (options.textByChannel !== undefined && source.spansByChannel) {
    const replacement = isRecord(options.textByChannel) ? options.textByChannel : {};
    const retained = {};
    for (const [channelId, spans] of Object.entries(source.spansByChannel)) {
      if (Object.prototype.hasOwnProperty.call(replacement, channelId)
        && replacement[channelId] === item.textByChannel[channelId]) {
        retained[channelId] = spans;
      }
    }
    if (Object.keys(retained).length > 0) {
      source.spansByChannel = retained;
    } else {
      delete source.spansByChannel;
    }
  }
  if (options.titlesByChannel === null) {
    delete source.titlesByChannel;
  } else if (options.titlesByChannel !== undefined) {
    source.titlesByChannel = options.titlesByChannel;
  }
  const candidate = normalizeProjectItem({
    ...source,
    ...(options.title !== undefined ? { title: options.title } : {}),
    ...(options.textByChannel !== undefined ? { textByChannel: options.textByChannel } : {}),
    ...(options.operatorNotes !== undefined ? { operatorNotes: options.operatorNotes } : {}),
    presetId,
    updatedAt
  }, project.channelIds, new Date(updatedAt));
  return replaceProjectItem(project, candidate);
}

/**
 * Update the presentation-facing metadata for non-text leaves without
 * replacing their pinned content, cue identity, channel routing, or position.
 */
function updatePresentationItem(rawProject, options = {}) {
  const project = normalizeEditableServiceProject(rawProject);
  const item = requireProjectItem(project, options.itemId, ['song', 'bible', 'picture', 'blank']);
  let presetId = item.kind === 'song' ? item.lyricsPresetId : item.presetId;
  if (options.presetId !== undefined) {
    presetId = id(options.presetId, `${item.kind} preset id`);
    if (!isNativePresetAllowed(presetId, item.kind)) {
      fail(
        'INVALID_NATIVE_PRESET',
        `Preset ${presetId} cannot be used for a ${item.kind} item.`,
        {
          itemId: item.id,
          kind: item.kind,
          presetId,
          allowedPresetIds: listNativePresets(item.kind).map(preset => preset.id)
        }
      );
    }
  }
  const updatedAt = mutationTimestamp(options.now, 'Presentation item update timestamp');
  const patch = {
    ...(options.title !== undefined ? { title: options.title } : {}),
    ...(options.operatorNotes !== undefined ? { operatorNotes: options.operatorNotes } : {}),
    updatedAt
  };
  if (item.kind === 'song') patch.lyricsPresetId = presetId;
  if (item.kind === 'bible') patch.presetId = presetId;
  if (item.kind === 'picture') {
    if (options.altText !== undefined) patch.altText = options.altText;
    if (options.fit !== undefined) patch.fit = options.fit;
    if (options.attribution !== undefined) patch.attribution = options.attribution;
  }
  const candidate = normalizeProjectItem({
    ...deepClone(item),
    ...patch
  }, project.channelIds, new Date(updatedAt));
  return replaceProjectItem(project, candidate);
}

/**
 * Set, replace, or remove one localized picture output. Legacy shared-picture
 * routing is expanded into the equivalent per-channel map before the focused
 * change, then only the displaced asset is considered for candidate-scoped
 * pruning. Historical revisions keep their immutable blobs for Undo/Redo.
 */
function updatePictureChannelAsset(rawProject, options = {}) {
  const project = normalizeEditableServiceProject(rawProject);
  const item = requireProjectItem(project, options.itemId, ['picture']);
  const channelId = id(options.channelId, 'Picture output id');
  if (!project.channels[channelId]) {
    fail(
      'UNKNOWN_PROJECT_CHANNEL',
      `Picture output ${channelId} is not part of this service.`,
      { itemId: item.id, channelId }
    );
  }

  const localized = item.assetIdsByChannel
    ? { ...item.assetIdsByChannel }
    : Object.fromEntries((item.channelIds || []).map(outputId => [outputId, item.assetId]));
  const previousAssetId = localized[channelId];
  const remove = options.remove === true;
  let nextAssetId = null;
  if (remove) {
    if (!previousAssetId) {
      fail(
        'PICTURE_OUTPUT_ALREADY_HIDDEN',
        `Picture ${item.id} is already hidden on output ${channelId}.`,
        { itemId: item.id, channelId }
      );
    }
    delete localized[channelId];
    if (Object.keys(localized).length < 1) {
      fail(
        'PICTURE_NEEDS_OUTPUT',
        'Keep this picture on at least one output, or remove the picture from the rundown.',
        { itemId: item.id, channelId }
      );
    }
  } else {
    nextAssetId = id(options.assetId, 'Picture asset id');
    if (!ASSET_ID_PATTERN.test(nextAssetId)
      || !project.assets[nextAssetId]
      || project.assets[nextAssetId].kind !== 'image') {
      fail(
        'INVALID_ASSET_REFERENCE',
        'Choose a verified picture from this service.',
        { itemId: item.id, channelId }
      );
    }
    if (item.assetIdsByChannel && previousAssetId === nextAssetId) return project;
    localized[channelId] = nextAssetId;
  }

  const updatedAt = mutationTimestamp(options.now, 'Picture output update timestamp');
  const candidate = normalizeProjectItem({
    ...deepClone(item),
    assetId: undefined,
    channelIds: undefined,
    assetIdsByChannel: localized,
    updatedAt
  }, project.channelIds, new Date(updatedAt));
  const replaced = replaceProjectItem(project, candidate);
  return previousAssetId && previousAssetId !== nextAssetId
    ? pruneUnreachableProjectRecords(replaced, { assetIds: [previousAssetId] })
    : replaced;
}

function copyTitle(value) {
  const suffix = ' copy';
  const source = String(value || 'Item').trim() || 'Item';
  return `${source.slice(0, 200 - suffix.length)}${suffix}`;
}

function duplicateId(prefix, randomUUID, usedIds) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    let candidate;
    try {
      candidate = id(`${prefix}-${randomUUID()}`, `Duplicated ${prefix} id`);
    } catch (error) {
      if (attempt === 99) throw error;
      continue;
    }
    if (!usedIds.has(candidate)) {
      usedIds.add(candidate);
      return candidate;
    }
  }
  fail('ID_GENERATION_FAILED', `A fresh ${prefix} id could not be generated.`);
}

/**
 * Duplicate one leaf or a complete group subtree. Project-level content
 * resources and assets remain content-addressed and are therefore reused;
 * every copied project item and song arrangement entry receives a fresh ID so
 * the copy compiles to an independent Cue identity set.
 */
function duplicateProjectItem(rawProject, options = {}) {
  const project = normalizeEditableServiceProject(rawProject);
  const source = requireProjectItem(project, options.itemId);
  const sourceParentId = project._index.parentByItemId[source.id];
  const targetParentId = options.targetParentId === undefined
    ? sourceParentId
    : options.targetParentId === null
      ? null
      : id(options.targetParentId, 'Duplicate target parent id');
  if (targetParentId !== null) {
    const targetParent = project.items[targetParentId];
    if (!targetParent || targetParent.kind !== 'group') {
      fail('INVALID_PARENT', 'Duplicated project items can only be placed at the root or inside a group.');
    }
  }

  const targetSiblings = targetParentId === null
    ? project.rootItemIds
    : project.items[targetParentId].childIds;
  const sourceSiblings = sourceParentId === null
    ? project.rootItemIds
    : project.items[sourceParentId].childIds;
  const sourceIndex = sourceSiblings.indexOf(source.id);
  if (sourceIndex < 0) fail('ORPHAN_PROJECT_ITEM', `Project item ${source.id} was not in the service order.`);
  const defaultTargetIndex = targetParentId === sourceParentId ? sourceIndex + 1 : targetSiblings.length;
  const targetIndex = options.targetIndex === undefined
    ? defaultTargetIndex
    : finiteInteger(options.targetIndex, 'Duplicate target index', 0, targetSiblings.length);

  const randomUUID = options.randomUUID === undefined ? crypto.randomUUID : options.randomUUID;
  if (typeof randomUUID !== 'function') {
    fail('INVALID_ID_GENERATOR', 'Duplicating a project item needs an ID generator.');
  }
  const now = mutationTimestamp(options.now, 'Duplicate timestamp');
  const subtreeIds = [];
  const collect = itemId => {
    subtreeIds.push(itemId);
    const item = project.items[itemId];
    if (item.kind === 'group') item.childIds.forEach(collect);
  };
  collect(source.id);

  const usedIds = new Set(Object.keys(project.items));
  for (const item of Object.values(project.items)) {
    if (item.kind === 'song') item.arrangement.forEach(entry => usedIds.add(entry.id));
  }
  const itemIdMap = new Map();
  const prefixByKind = {
    group: 'group',
    song: 'song',
    bible: 'bible',
    sermon: 'sermon',
    notice: 'notice',
    picture: 'picture',
    blank: 'blank',
    'imported-deck': 'deck'
  };
  for (const sourceId of subtreeIds) {
    const item = project.items[sourceId];
    itemIdMap.set(sourceId, duplicateId(prefixByKind[item.kind] || 'item', randomUUID, usedIds));
  }

  const next = deepClone(project);
  for (const sourceId of subtreeIds) {
    const original = project.items[sourceId];
    const copied = deepClone(original);
    copied.id = itemIdMap.get(sourceId);
    copied.createdAt = now;
    copied.updatedAt = now;
    if (sourceId === source.id) copied.title = options.title === undefined ? copyTitle(original.title) : options.title;
    if (copied.kind === 'group') {
      copied.childIds = original.childIds.map(childId => itemIdMap.get(childId));
    }
    if (copied.kind === 'song') {
      copied.arrangement = original.arrangement.map(entry => ({
        id: duplicateId('arr', randomUUID, usedIds),
        sectionId: entry.sectionId
      }));
    }
    next.items[copied.id] = normalizeProjectItem(copied, project.channelIds, new Date(now));
  }
  const nextSiblings = targetParentId === null
    ? next.rootItemIds
    : next.items[targetParentId].childIds;
  nextSiblings.splice(targetIndex, 0, itemIdMap.get(source.id));
  return normalizeEditableServiceProject(next);
}

function requireSongItem(project, rawItemId) {
  return requireProjectItem(project, rawItemId, ['song']);
}

function resolveAuthoritativeSongSource(rawProject, rawItemId) {
  const project = normalizeEditableServiceProject(rawProject);
  const item = requireSongItem(project, rawItemId);
  return deepFreeze(authoritativeSongSource(project, item));
}

/**
 * Replace a semantic song arrangement without manufacturing new identities.
 * Callers must supply the stable entry IDs, including distinct IDs for
 * repeated choruses, so compiled Cue IDs survive simple reordering.
 */
function updateSongArrangement(rawProject, options = {}) {
  const project = normalizeEditableServiceProject(rawProject);
  const item = requireSongItem(project, options.itemId);
  const primary = authoritativeSongSource(project, item);
  const updatedAt = mutationTimestamp(options.now, 'Song arrangement update timestamp');
  const candidate = normalizeProjectItem({
    ...deepClone(item),
    arrangement: options.arrangement,
    primaryChannelId: item.primaryChannelId || primary.channelId,
    updatedAt
  }, project.channelIds, new Date(updatedAt));
  const availableSectionIds = new Set(primary.resource.document.sections.map(section => section.id));
  for (const entry of candidate.arrangement) {
    if (!availableSectionIds.has(entry.sectionId)) {
      fail(
        'UNKNOWN_ARRANGEMENT_SECTION',
        `Song item ${item.id} uses missing primary section ${entry.sectionId}.`,
        {
          itemId: item.id,
          primaryChannelId: primary.channelId,
          sectionId: entry.sectionId,
          available: [...availableSectionIds]
        }
      );
    }
  }
  const next = deepClone(project);
  next.items[item.id] = candidate;
  return normalizeEditableServiceProject(next);
}

/**
 * Pin a SongDocument and link it to one output channel only after proving it
 * belongs to the same song family and has aligned section/slide boundaries.
 */
function linkSongTranslation(rawProject, options = {}) {
  const project = normalizeEditableServiceProject(rawProject);
  const item = requireSongItem(project, options.itemId);
  const channelId = id(options.channelId, 'Translation channel id');
  if (!project.channelIds.includes(channelId)) {
    fail('UNKNOWN_PROJECT_CHANNEL', `Project channel ${channelId} does not exist.`);
  }
  const primary = authoritativeSongSource(project, item);
  if (channelId === primary.channelId) {
    fail('PRIMARY_SONG_CHANNEL', 'The primary song channel cannot be replaced with a translation.');
  }
  const translation = normalizeSongDocument(options.song);
  const comparison = compareSongTranslations(primary.resource.document, translation);
  if (!comparison.compatible) {
    fail(
      'TRANSLATION_MISMATCH',
      `${translation.title} is not an aligned translation of ${primary.resource.document.title}.`,
      comparison
    );
  }
  const pinned = addSongResource(project, translation, options.origin || null);
  const next = deepClone(pinned.project);
  const previousResourceId = item.variants[channelId]?.mode === 'content'
    ? item.variants[channelId].resourceId
    : null;
  const titleCardMode = item.variants[channelId]?.titleCardMode;
  next.items[item.id].primaryChannelId = item.primaryChannelId || primary.channelId;
  next.items[item.id].variants[channelId] = {
    mode: 'content',
    resourceId: pinned.resourceId,
    ...(titleCardMode ? { titleCardMode } : {})
  };
  next.items[item.id].updatedAt = mutationTimestamp(options.now, 'Song translation update timestamp');
  return pruneUnreachableProjectRecords(next, {
    resourceIds: previousResourceId ? [previousResourceId] : []
  });
}

/**
 * Return one translated channel to the project's normal song behavior. The
 * replaced resource record is removed from this new semantic revision only
 * when no other item/channel still references it.
 */
function resetSongChannelVariant(rawProject, options = {}) {
  const project = normalizeEditableServiceProject(rawProject);
  const item = requireSongItem(project, options.itemId);
  const channelId = id(options.channelId, 'Song channel id');
  if (!project.channelIds.includes(channelId)) {
    fail('UNKNOWN_PROJECT_CHANNEL', `Project channel ${channelId} does not exist.`);
  }
  const primary = authoritativeSongSource(project, item);
  if (channelId === primary.channelId) {
    fail('PRIMARY_SONG_CHANNEL', 'The primary song channel cannot inherit from itself.');
  }
  const mode = options.mode || 'inherit';
  if (mode !== 'inherit' && mode !== 'derive') {
    fail('INVALID_SONG_VARIANT', 'A reset song channel must inherit or use the singers next-line view.');
  }
  const next = deepClone(project);
  const previousResourceId = item.variants[channelId]?.mode === 'content'
    ? item.variants[channelId].resourceId
    : null;
  const titleCardMode = item.variants[channelId]?.titleCardMode;
  next.items[item.id].primaryChannelId = item.primaryChannelId || primary.channelId;
  next.items[item.id].variants[channelId] = mode === 'derive'
    ? {
        mode: 'derive',
        from: primary.channelId,
        transform: { id: 'first-lines', version: 1, maxLines: 2 },
        ...(titleCardMode ? { titleCardMode } : {})
      }
    : {
        mode: 'inherit',
        from: primary.channelId,
        ...(titleCardMode ? { titleCardMode } : {})
      };
  next.items[item.id].updatedAt = mutationTimestamp(options.now, 'Song channel reset timestamp');
  return pruneUnreachableProjectRecords(next, {
    resourceIds: previousResourceId ? [previousResourceId] : []
  });
}

function canonicalBibleBookId(value) {
  const source = text(value, 'Bible passage book', 100, { required: true });
  const normalized = source.normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (!normalized) fail('INVALID_BIBLE_RANGE', 'Bible passage book needs a canonical identifier.');
  return id(normalized, 'Bible passage bookId');
}

function passageRange(rawPassage, field) {
  if (!isRecord(rawPassage)) fail('INVALID_BIBLE_BLOCK', `${field} must be a resolved Bible passage.`);
  const hasRangeMetadata = rawPassage.bookId !== undefined
    || rawPassage.book !== undefined
    || rawPassage.chapter !== undefined
    || rawPassage.verseStart !== undefined
    || rawPassage.verseEnd !== undefined;
  if (!hasRangeMetadata) return null;
  const bookId = rawPassage.bookId
    ? id(rawPassage.bookId, `${field}.bookId`)
    : canonicalBibleBookId(rawPassage.book);
  const chapter = finiteInteger(rawPassage.chapter, `${field}.chapter`, 1, 200);
  const verseStart = finiteInteger(rawPassage.verseStart, `${field}.verseStart`, 1, 999);
  const verseEnd = finiteInteger(
    rawPassage.verseEnd,
    `${field}.verseEnd`,
    verseStart,
    999,
    verseStart
  );
  return {
    bookId,
    start: { chapter, verse: verseStart },
    end: { chapter, verse: verseEnd }
  };
}

function bibleRangesEqual(left, right) {
  return left.bookId === right.bookId
    && left.start.chapter === right.start.chapter
    && left.start.verse === right.start.verse
    && left.end.chapter === right.end.chapter
    && left.end.verse === right.end.verse;
}

function pinnedBibleBlock(rawPassage, field) {
  if (!isRecord(rawPassage)) fail('INVALID_BIBLE_BLOCK', `${field} must be a resolved Bible passage.`);
  const translation = isRecord(rawPassage.translation) ? rawPassage.translation : {};
  const attribution = rawPassage.attribution !== undefined
    ? rawPassage.attribution
    : translation.attribution || translation.suggestedCredit || '';
  return normalizeBlock({
    type: 'bible',
    reference: rawPassage.reference,
    translationId: rawPassage.translationId || translation.id,
    attribution,
    verses: rawPassage.verses,
    contentSha256: rawPassage.contentSha256
  }, field);
}

/**
 * Pin already-resolved Bible text into the project. Reference parsing,
 * ambiguity selection, and translation-data lookup deliberately remain in the
 * trusted application layer; this pure helper snapshots and checks the result.
 */
function addBibleItem(rawProject, options = {}) {
  const project = normalizeEditableServiceProject(rawProject);
  if (!isRecord(options.passagesByChannel) || Object.keys(options.passagesByChannel).length < 1) {
    fail('INVALID_BIBLE_VARIANTS', 'A Bible item needs at least one resolved passage.');
  }
  const passagesByChannel = {};
  let range = options.range ? normalizeBibleRange(options.range, 'Bible item range') : null;
  for (const [channelId, rawPassage] of Object.entries(options.passagesByChannel)) {
    if (!project.channelIds.includes(channelId)) {
      fail('UNKNOWN_PROJECT_CHANNEL', `Project channel ${channelId} does not exist.`);
    }
    const candidateRange = passageRange(rawPassage, `Bible passage ${channelId}`);
    if (!range && !candidateRange) {
      fail('INVALID_BIBLE_RANGE', 'Resolved Bible passage metadata is required when no explicit range is supplied.');
    }
    if (!range) range = candidateRange;
    if (candidateRange && !bibleRangesEqual(range, candidateRange)) {
      fail('BIBLE_RANGE_MISMATCH', `Bible passage ${channelId} does not match the pinned canonical range.`);
    }
    const block = pinnedBibleBlock(rawPassage, `Bible passage ${channelId}`);
    if (range.start.chapter !== range.end.chapter) {
      fail('INVALID_BIBLE_RANGE', 'Pinned Bible items currently support one chapter at a time.');
    }
    const expectedVerseNumbers = [];
    for (let verse = range.start.verse; verse <= range.end.verse; verse += 1) expectedVerseNumbers.push(verse);
    if (block.verses.length !== expectedVerseNumbers.length
      || block.verses.some((verse, index) => verse.number !== expectedVerseNumbers[index])) {
      fail('BIBLE_RANGE_MISMATCH', `Bible passage ${channelId} text does not exactly cover its pinned canonical range.`);
    }
    passagesByChannel[channelId] = block;
  }
  return addProjectItem(project, {
    id: options.id,
    kind: 'bible',
    title: options.title || Object.values(passagesByChannel)[0].reference,
    range,
    passagesByChannel,
    presetId: options.presetId || 'scripture-text',
    operatorNotes: options.operatorNotes || ''
  }, {
    parentId: options.parentId,
    index: options.index,
    now: options.now
  });
}

function moveProjectItem(rawProject, options = {}) {
  const project = normalizeEditableServiceProject(rawProject);
  const itemId = id(options.itemId, 'Project item id');
  if (!project.items[itemId]) fail('UNKNOWN_PROJECT_ITEM', `Project item ${itemId} does not exist.`);
  const parentId = options.targetParentId === null || options.targetParentId === undefined
    ? null
    : id(options.targetParentId, 'Target parent id');
  if (parentId !== null) {
    const parent = project.items[parentId];
    if (!parent || parent.kind !== 'group') {
      fail('INVALID_PARENT', 'Project items can only be placed at the root or inside a group.');
    }
    let ancestorId = parentId;
    while (ancestorId !== null && ancestorId !== undefined) {
      if (ancestorId === itemId) {
        fail('PROJECT_TREE_CYCLE', `Project item ${itemId} cannot be moved inside itself or one of its descendants.`);
      }
      ancestorId = project._index.parentByItemId[ancestorId];
    }
  }
  const next = deepClone(project);
  const removeFrom = siblings => {
    const index = siblings.indexOf(itemId);
    if (index >= 0) siblings.splice(index, 1);
    return index >= 0;
  };
  let removed = removeFrom(next.rootItemIds);
  for (const item of Object.values(next.items)) {
    if (item.kind === 'group' && removeFrom(item.childIds)) removed = true;
  }
  if (!removed) fail('ORPHAN_PROJECT_ITEM', `Project item ${itemId} was not in the service order.`);
  const siblings = parentId === null ? next.rootItemIds : next.items[parentId]?.childIds;
  if (!siblings) fail('INVALID_PARENT', 'Project items can only be placed at the root or inside a group.');
  const targetIndex = options.targetIndex === undefined
    ? siblings.length
    : finiteInteger(options.targetIndex, 'Project item target index', 0, siblings.length);
  siblings.splice(targetIndex, 0, itemId);
  return normalizeEditableServiceProject(next);
}

module.exports = {
  ASSET_ID_PATTERN,
  CUE_KINDS,
  CUE_TIMELINE_KIND,
  EDITABLE_PROJECT_KIND,
  MAX_GROUP_DEPTH,
  MAX_IMAGE_PIXELS,
  MAX_PROJECT_JSON_BYTES,
  PROJECT_ITEM_KINDS,
  SERVICE_PROJECT_SCHEMA_VERSION,
  ServiceProjectError,
  addBibleItem,
  addGroupItem,
  addProjectItem,
  addSongResource,
  compileServiceProject,
  compareSongTranslations,
  createCue,
  createCueTimeline: createServiceProject,
  createServiceProject: createEditableServiceProject,
  createSongCues,
  deterministicCueId,
  duplicateProjectItem,
  linkSongTranslation,
  moveProjectItem,
  normalizeCue,
  normalizeCueTimeline: normalizeServiceProject,
  normalizeServiceProject: normalizeEditableServiceProject,
  projectWithCue,
  projectWithMovedCue,
  projectWithoutCue,
  removeProjectItemAndDescendants,
  resolveAuthoritativeSongSource,
  resetSongChannelVariant,
  serializeCueTimeline: serializeServiceProject,
  serializeServiceProject: serializeEditableServiceProject,
  updateGroupItem,
  updatePictureChannelAsset,
  updatePresentationItem,
  updateSongArrangement,
  updateTextItem,
  validateProjectTree
};
