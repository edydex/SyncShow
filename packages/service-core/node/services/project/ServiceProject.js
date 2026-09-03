'use strict';
const { normalizeSermonOptions, sermonSlideBlocks } = require('./SermonPresentation');
const { scriptureFlowText } = require('./SlideFormatting');

const { normalizeSongPresentation, presentationTitleBlocks, presentationLyricBlocks } = require('./SongPresentation');

const { Buffer, crypto } = require('../../runtime');
const { isValidIsoDate } = require('../service-set/ServiceDate');
const {
  compareSongSections,
  normalizeSongDocument,
  parseSongDocument,
  parseSongArrangement,
  serializeSongDocument
} = require('./SongDocument');
const {
  normalizeSermonDocument,
  serializeSermonDocument
} = require('../sermon/SermonDocument');
const {
  bibleRangeContains
} = require('../sermon/BibleRange');
const {
  planSermonPrimaryReading
} = require('../sermon/SermonReadingPlan');
const {
  isNativePresetAllowed,
  listNativePresets
} = require('./NativePresetCatalog');
const {
  ServiceProjectServingError,
  normalizeServiceProjectServing,
  pruneMissingServiceProjectServingItemScopes,
  rebindServiceProjectServingItemScopes
} = require('./ServiceProjectServing');

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
const CUE_KINDS = Object.freeze(['song', 'bible', 'sermon', 'picture', 'video', 'notice', 'blank', 'slide']);
const CHANNEL_MODES = Object.freeze(['content', 'inherit', 'condensed', 'hide']);
const BLOCK_TYPES = Object.freeze(['text', 'bible', 'image', 'video', 'blank', 'legacy-deck']);
const ASSET_KINDS = Object.freeze(['image', 'video', 'deck', 'document']);
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
const MAX_SOURCE_RANGE_REPLACEMENT_ITEMS = 200;
const SOURCE_RANGE_REPLACEMENT_KIND = 'reviewed-powerpoint-song-range';
const SOURCE_BODY_PROJECTION_SCHEMA_VERSION = 1;
const SOURCE_BODY_PROJECTION_SCHEMA_VERSION_V2 = 2;
const SOURCE_BODY_PROJECTION_KIND = 'reviewed-sermon-body-projection';
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

let communityServicePlanBaselineNormalizer = null;

function configureCommunityServicePlanBaselineNormalizer(normalizer) {
  if (normalizer !== null && typeof normalizer !== 'function') {
    throw new TypeError('Community service-plan baseline normalizer must be a function or null.');
  }
  communityServicePlanBaselineNormalizer = normalizer;
}

function normalizeConfiguredCommunityServicePlanBaseline(rawBaseline) {
  if (!communityServicePlanBaselineNormalizer) {
    fail(
      'LEGACY_COMMUNITY_PLAN_UNAVAILABLE',
      'This browser-safe service core does not include the retired Community plan reconciliation format.'
    );
  }
  return communityServicePlanBaselineNormalizer(rawBaseline);
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
    const unexpected = keys.filter(key => !['start', 'end', 'foreground', 'weight', 'fontScale', 'italic', 'underline'].includes(key));
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
    if (candidate.fontScale !== undefined) {
      if (!Number.isFinite(candidate.fontScale) || candidate.fontScale < 0.5 || candidate.fontScale > 2) {
        fail('INVALID_TEXT_SPANS', `${spanField}.fontScale must be between 0.5 and 2.`);
      }
      span.fontScale = candidate.fontScale;
    }
    for (const key of ['italic', 'underline']) {
      if (candidate[key] !== undefined) {
        if (typeof candidate[key] !== 'boolean') fail('INVALID_TEXT_SPANS', `${spanField}.${key} must be a boolean.`);
        span[key] = candidate[key];
      }
    }
    if (span.foreground === undefined && span.weight === undefined && span.fontScale === undefined && span.italic === undefined && span.underline === undefined) {
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
    const spans = normalizeTextSpans(raw.spans, scriptureFlowText(normalized.verses), `${field}.spans`);
    if (spans.length) normalized.spans = spans;
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
      ...(raw.role === 'background' ? { role: 'background' } : {}),
      ...(raw.dimOpacity !== undefined ? { dimOpacity: typeof raw.dimOpacity === 'number' && Number.isFinite(raw.dimOpacity) && raw.dimOpacity >= 0 && raw.dimOpacity <= 1 ? raw.dimOpacity : fail('INVALID_BACKGROUND_DIM', 'Background darkening must be from 0 to 1.') } : {}),
      fit,
      focalPoint: normalizeFocalPoint(raw.focalPoint, `${field}.focalPoint`),
      altText: text(raw.altText, `${field}.altText`, 500, { required: true }),
      attribution: text(raw.attribution, `${field}.attribution`, 500)
    };
  }
  if (type === 'video') {
    if (!ASSET_ID_PATTERN.test(raw.assetId || '')) {
      fail('INVALID_ASSET_REFERENCE', `${field}.assetId is invalid.`, { field, assetId: raw.assetId });
    }
    const fit = raw.fit || 'fit';
    if (!IMAGE_FITS.includes(fit)) fail('INVALID_VIDEO_FIT', `${field}.fit is unsupported.`, { field, fit });
    if (typeof raw.muted !== 'boolean') {
      fail('INVALID_VIDEO_AUDIO', `${field}.muted must be true or false.`, { field });
    }
    return {
      type,
      assetId: raw.assetId,
      fit,
      muted: raw.muted
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
    if (raw.sourceBlocks !== undefined) {
      if (!Array.isArray(raw.sourceBlocks) || raw.sourceBlocks.length > MAX_BLOCKS_PER_CHANNEL) {
        fail('INVALID_BLOCKS', `${field}.sourceBlocks has invalid singer source content.`, { field });
      }
      normalized.sourceBlocks = raw.sourceBlocks.map((block, index) => normalizeBlock(block, `${field}.sourceBlocks[${index}]`));
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
    const sourceReferenceType = text(
      raw.sourceReference.type || 'local',
      'Source reference type',
      40,
      { required: true }
    );
    normalized.sourceReference = {
      type: sourceReferenceType,
      id: id(raw.sourceReference.id, 'Source reference id'),
      revision: text(raw.sourceReference.revision, 'Source reference revision', 128),
      sectionId: raw.sourceReference.sectionId ? id(raw.sourceReference.sectionId, 'Source section id') : null
    };
    if (sourceReferenceType === 'sermon-reading') {
      const chunkCount = finiteInteger(
        raw.sourceReference.chunkCount,
        'Sermon reading source chunkCount',
        1,
        100
      );
      normalized.sourceReference.referenceId = id(
        raw.sourceReference.referenceId,
        'Sermon reading source reference id'
      );
      const hasLegacyTranslation = raw.sourceReference.translationId
        !== undefined;
      const hasDenseOutputs = raw.sourceReference.outputs !== undefined;
      if (hasLegacyTranslation === hasDenseOutputs) {
        fail(
          'INVALID_SOURCE_REFERENCE',
          `Cue ${cueId} sermon reading source must use either one legacy translation or one dense output plan.`
        );
      }
      if (hasLegacyTranslation) {
        normalized.sourceReference.translationId = text(
          raw.sourceReference.translationId,
          'Sermon reading source translation',
          12,
          { required: true }
        ).toUpperCase();
      } else {
        const cueChannelIds = Object.keys(channels).sort((left, right) =>
          left.localeCompare(right, 'en'));
        const outputs = normalizeSermonReadingOutputs(
          raw.sourceReference.outputs,
          cueChannelIds,
          'Sermon reading source outputs'
        );
        for (const output of outputs) {
          const channel = channels[output.channelId];
          if (output.mode === 'hidden') {
            if (channel.mode !== 'hide' || channel.blocks.length !== 0) {
              fail(
                'SERMON_READING_SOURCE_OUTPUT_MISMATCH',
                `Cue ${cueId} hidden sermon-reading output ${output.channelId} has projected content.`
              );
            }
            continue;
          }
          const bibleBlocks = channel.mode === 'content'
            ? channel.blocks.filter(block => block.type === 'bible')
            : [];
          if (
            channel.mode !== 'content'
            || channel.blocks.length !== 1
            || bibleBlocks.length !== 1
            || bibleBlocks[0].translationId !== output.translationId
          ) {
            fail(
              'SERMON_READING_SOURCE_OUTPUT_MISMATCH',
              `Cue ${cueId} sermon-reading output ${output.channelId} does not match its pinned Bible translation.`
            );
          }
        }
        normalized.sourceReference.outputs = outputs;
      }
      normalized.sourceReference.chunkIndex = finiteInteger(
        raw.sourceReference.chunkIndex,
        'Sermon reading source chunkIndex',
        0,
        chunkCount - 1
      );
      normalized.sourceReference.chunkCount = chunkCount;
    }
  }
  return normalized;
}

function defaultPresetForKind(kind) {
  return {
    song: 'song-lyrics',
    bible: 'scripture-text',
    sermon: 'sermon-point',
    picture: 'picture-fullscreen',
    video: 'video-fullscreen',
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
  } else if (raw.kind === 'video') {
    const expectedExtension = {
      'video/mp4': 'mp4',
      'video/webm': 'webm'
    }[normalized.mediaType];
    const extension = normalized.storedName.split('.').at(-1);
    if (!expectedExtension || extension !== expectedExtension) {
      fail('VIDEO_TYPE_MISMATCH', `Asset ${assetId} has inconsistent video type metadata.`);
    }
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
        if (['image', 'video', 'legacy-deck'].includes(block.type) && !assets[block.assetId]) {
          fail('MISSING_ASSET', `Cue ${cue.id} uses an asset that is not in this project.`, {
            cueId: cue.id,
            assetId: block.assetId
          });
        }
        if (block.type === 'image' && assets[block.assetId]?.kind !== 'image') {
          fail('WRONG_ASSET_KIND', `Cue ${cue.id} expects an image asset.`, { cueId: cue.id, assetId: block.assetId });
        }
        if (block.type === 'video' && assets[block.assetId]?.kind !== 'video') {
          fail('WRONG_ASSET_KIND', `Cue ${cue.id} expects a video asset.`, { cueId: cue.id, assetId: block.assetId });
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
const POWERPOINT_COMPANION_WORKFLOW_MODE = 'pptx-companion';
const SERVICE_PLAN_SCHEMA_VERSION = 1;
const LEGACY_COMMUNITY_SERVICE_PLAN_SCHEMA_VERSION = 2;
const COMMUNITY_SERVICE_PLAN_SCHEMA_VERSION = 3;
const LOCAL_SERVICE_PLAN_SCHEMA_VERSION = 4;
const LOCAL_SERVICE_PLAN_ORIGIN = 'local-created';
const COMMUNITY_SERVICE_PLAN_SOURCE_KIND = 'community-plan';
const COMMUNITY_RECONCILIATION_RECEIPT_KIND =
  'community-service-plan-reconciliation-receipt';
const COMMUNITY_RECONCILIATION_RECEIPT_SCHEMA_VERSION = 1;
const MAX_COMMUNITY_RECONCILIATION_RECEIPT_DECISIONS = 500;
const MAX_COMMUNITY_LOCAL_COLLISION_BOUNDARIES = 500;
const SERVICE_PLAN_STATUSES = Object.freeze([
  'planning',
  'ready',
  'completed',
  'needs-follow-up'
]);
const SERVICE_START_TIME_PATTERN = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
const PROJECT_ITEM_KINDS = Object.freeze([
  'group',
  'song',
  'bible',
  'sermon',
  'notice',
  'picture',
  'video',
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
const MAX_PLANNED_ITEM_DURATION_SECONDS = 24 * 60 * 60;

/**
 * Planning waivers use the same fixed IDs and bound as the readiness analyzer.
 * The lookup stays lazy because ServiceProjectReadiness compiles projects
 * through this module; loading it at module initialization would create a
 * partially initialized circular dependency.
 */
function serviceReadinessWaiverContract() {
  const {
    MAX_SERVICE_READINESS_WAIVERS,
    SERVICE_READINESS_CHECK_IDS
  } = require('./ServiceProjectReadiness');
  return {
    maximum: MAX_SERVICE_READINESS_WAIVERS,
    checkIds: SERVICE_READINESS_CHECK_IDS,
    unwaivableCheckIds: new Set(['compilable-nonempty'])
  };
}

function normalizeServiceReadinessWaivers(raw) {
  const contract = serviceReadinessWaiverContract();
  if (!Array.isArray(raw)) {
    fail(
      'INVALID_SERVICE_READINESS_WAIVER',
      'Project planning readinessWaivers must be a list.'
    );
  }
  if (raw.length > contract.maximum) {
    fail(
      'TOO_MANY_SERVICE_READINESS_WAIVERS',
      `A service may use at most ${contract.maximum} readiness waivers.`,
      { maximum: contract.maximum }
    );
  }

  const byCheckId = new Map();
  for (const [index, rawWaiver] of raw.entries()) {
    if (!isRecord(rawWaiver)) {
      fail(
        'INVALID_SERVICE_READINESS_WAIVER',
        `Readiness waiver ${index + 1} must be an object.`,
        { index }
      );
    }
    const unexpected = Object.keys(rawWaiver)
      .filter(key => !['checkId', 'reason'].includes(key));
    if (unexpected.length > 0) {
      fail(
        'INVALID_SERVICE_READINESS_WAIVER',
        `Readiness waiver ${index + 1} contains unsupported fields.`,
        { index, fields: unexpected.sort() }
      );
    }
    if (typeof rawWaiver.checkId !== 'string'
      || !contract.checkIds.includes(rawWaiver.checkId)) {
      fail(
        'UNKNOWN_SERVICE_READINESS_WAIVER',
        `Readiness waiver ${index + 1} does not identify a known check.`,
        { index, checkId: rawWaiver.checkId }
      );
    }
    if (contract.unwaivableCheckIds.has(rawWaiver.checkId)) {
      fail(
        'UNWAIVABLE_SERVICE_READINESS_CHECK',
        `Readiness check ${rawWaiver.checkId} cannot be waived.`,
        { index, checkId: rawWaiver.checkId }
      );
    }
    if (byCheckId.has(rawWaiver.checkId)) {
      fail(
        'DUPLICATE_SERVICE_READINESS_WAIVER',
        `Readiness check ${rawWaiver.checkId} has more than one waiver.`,
        { index, checkId: rawWaiver.checkId }
      );
    }
    if (typeof rawWaiver.reason !== 'string') {
      fail(
        'INVALID_SERVICE_READINESS_WAIVER',
        `Readiness waiver ${index + 1} needs a human reason.`,
        { index, checkId: rawWaiver.checkId }
      );
    }
    const reason = rawWaiver.reason.trim().normalize('NFC');
    if (!reason
      || reason.length > 500
      || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(reason)) {
      fail(
        'INVALID_SERVICE_READINESS_WAIVER',
        `Readiness waiver ${index + 1} needs a valid human reason of 500 characters or fewer.`,
        { index, checkId: rawWaiver.checkId }
      );
    }
    byCheckId.set(rawWaiver.checkId, {
      checkId: rawWaiver.checkId,
      reason
    });
  }

  return contract.checkIds
    .filter(checkId => byCheckId.has(checkId))
    .map(checkId => byCheckId.get(checkId));
}

function communityReconciliationReceiptBody(receipt) {
  return {
    schemaVersion: receipt.schemaVersion,
    kind: receipt.kind,
    mode: receipt.mode,
    previousPlanRevision: receipt.previousPlanRevision,
    candidatePlanRevision: receipt.candidatePlanRevision,
    previousBaselineProjectionSha256:
      receipt.previousBaselineProjectionSha256,
    candidateProjectionSha256: receipt.candidateProjectionSha256,
    mergeResultSha256: receipt.mergeResultSha256,
    previousLocalRevisionId: receipt.previousLocalRevisionId,
    conflictCount: receipt.conflictCount,
    decisions: receipt.decisions,
    appliedAt: receipt.appliedAt
  };
}

function communityReconciliationReceiptSha256(receipt) {
  return crypto.createHash('sha256')
    .update(JSON.stringify(stableObject(
      communityReconciliationReceiptBody(receipt)
    )))
    .digest('hex');
}

function normalizeCommunityReconciliationReceipt(raw) {
  if (!isRecord(raw)) {
    fail(
      'INVALID_COMMUNITY_RECONCILIATION_RECEIPT',
      'Community reconciliation receipt must be an object.'
    );
  }
  const expectedFields = [
    'schemaVersion',
    'kind',
    'mode',
    'previousPlanRevision',
    'candidatePlanRevision',
    'previousBaselineProjectionSha256',
    'candidateProjectionSha256',
    'mergeResultSha256',
    'previousLocalRevisionId',
    'conflictCount',
    'decisions',
    'appliedAt',
    'receiptSha256'
  ].sort();
  const actualFields = Object.keys(raw).sort();
  if (
    actualFields.length !== expectedFields.length
    || actualFields.some((field, index) => field !== expectedFields[index])
  ) {
    fail(
      'INVALID_COMMUNITY_RECONCILIATION_RECEIPT',
      'Community reconciliation receipt contains unsupported or missing fields.',
      { fields: actualFields }
    );
  }
  if (
    raw.schemaVersion !== COMMUNITY_RECONCILIATION_RECEIPT_SCHEMA_VERSION
    || raw.kind !== COMMUNITY_RECONCILIATION_RECEIPT_KIND
    || !['three-way', 'legacy-full-replace'].includes(raw.mode)
  ) {
    fail(
      'INVALID_COMMUNITY_RECONCILIATION_RECEIPT',
      'Community reconciliation receipt has an unsupported contract.'
    );
  }
  for (const field of [
    'previousPlanRevision',
    'candidatePlanRevision',
    'candidateProjectionSha256',
    'mergeResultSha256',
    'previousLocalRevisionId',
    'receiptSha256'
  ]) {
    if (!SHA256_PATTERN.test(raw[field] || '')) {
      fail(
        'INVALID_COMMUNITY_RECONCILIATION_RECEIPT',
        `Community reconciliation receipt ${field} must be a lowercase SHA-256.`
      );
    }
  }
  if (
    raw.previousBaselineProjectionSha256 !== null
    && !SHA256_PATTERN.test(raw.previousBaselineProjectionSha256 || '')
  ) {
    fail(
      'INVALID_COMMUNITY_RECONCILIATION_RECEIPT',
      'Community reconciliation receipt previous baseline must be null or a lowercase SHA-256.'
    );
  }
  if (
    raw.mode === 'three-way'
    && raw.previousBaselineProjectionSha256 === null
  ) {
    fail(
      'INVALID_COMMUNITY_RECONCILIATION_RECEIPT',
      'A three-way reconciliation receipt requires its previous baseline hash.'
    );
  }
  const conflictCount = finiteInteger(
    raw.conflictCount,
    'Community reconciliation receipt conflictCount',
    0,
    MAX_COMMUNITY_RECONCILIATION_RECEIPT_DECISIONS
  );
  if (
    !Array.isArray(raw.decisions)
    || raw.decisions.length !== conflictCount
  ) {
    fail(
      'INVALID_COMMUNITY_RECONCILIATION_RECEIPT',
      'Community reconciliation receipt must retain one decision for every reviewed conflict.'
    );
  }
  const conflictIds = new Set();
  const decisions = raw.decisions.map((decision, index) => {
    if (
      !isRecord(decision)
      || Object.keys(decision).length !== 2
      || !Object.prototype.hasOwnProperty.call(decision, 'conflictId')
      || !Object.prototype.hasOwnProperty.call(decision, 'choice')
    ) {
      fail(
        'INVALID_COMMUNITY_RECONCILIATION_RECEIPT',
        `Community reconciliation receipt decision ${index + 1} is invalid.`
      );
    }
    const conflictId = id(
      decision.conflictId,
      `Community reconciliation receipt decision ${index + 1} conflictId`
    );
    if (
      conflictIds.has(conflictId)
      || !['keep-local', 'use-community'].includes(decision.choice)
    ) {
      fail(
        'INVALID_COMMUNITY_RECONCILIATION_RECEIPT',
        `Community reconciliation receipt decision ${index + 1} is invalid.`
      );
    }
    conflictIds.add(conflictId);
    return {
      conflictId,
      choice: decision.choice
    };
  });
  if (
    raw.mode === 'legacy-full-replace'
    && (
      decisions.length !== 1
      || decisions[0].choice !== 'use-community'
    )
  ) {
    fail(
      'INVALID_COMMUNITY_RECONCILIATION_RECEIPT',
      'A legacy replacement receipt must record its one explicit Community choice.'
    );
  }
  const appliedAt = timestamp(
    raw.appliedAt,
    'Community reconciliation receipt appliedAt'
  );
  if (appliedAt !== raw.appliedAt) {
    fail(
      'INVALID_COMMUNITY_RECONCILIATION_RECEIPT',
      'Community reconciliation receipt appliedAt must be canonical UTC.'
    );
  }
  const normalized = {
    schemaVersion: COMMUNITY_RECONCILIATION_RECEIPT_SCHEMA_VERSION,
    kind: COMMUNITY_RECONCILIATION_RECEIPT_KIND,
    mode: raw.mode,
    previousPlanRevision: raw.previousPlanRevision,
    candidatePlanRevision: raw.candidatePlanRevision,
    previousBaselineProjectionSha256:
      raw.previousBaselineProjectionSha256,
    candidateProjectionSha256: raw.candidateProjectionSha256,
    mergeResultSha256: raw.mergeResultSha256,
    previousLocalRevisionId: raw.previousLocalRevisionId,
    conflictCount,
    decisions,
    appliedAt
  };
  const receiptSha256 = communityReconciliationReceiptSha256(normalized);
  if (receiptSha256 !== raw.receiptSha256) {
    fail(
      'COMMUNITY_RECONCILIATION_RECEIPT_HASH_MISMATCH',
      'Community reconciliation receipt no longer matches its checksum.'
    );
  }
  return {
    ...normalized,
    receiptSha256
  };
}

function normalizeProjectServing(raw, itemIds) {
  try {
    return normalizeServiceProjectServing(raw, { itemIds });
  } catch (error) {
    if (!(error instanceof ServiceProjectServingError)) throw error;
    fail(error.code, error.message, error.details);
  }
}

function normalizeServicePlanning(raw, projectId, itemIds = []) {
  if (!isRecord(raw)) {
    fail('INVALID_SERVICE_PLAN', 'Project planning metadata must be an object.');
  }
  if (raw.schemaVersion === LOCAL_SERVICE_PLAN_SCHEMA_VERSION) {
    const unexpected = Object.keys(raw).filter(key =>
      ![
        'schemaVersion',
        'status',
        'startTime',
        'teamNotes',
        'origin',
        'readinessWaivers',
        'serving'
      ].includes(key));
    if (unexpected.length > 0) {
      fail(
        'INVALID_SERVICE_PLAN',
        'Local service planning metadata contains unsupported fields.',
        { fields: unexpected.sort() }
      );
    }
    if (raw.origin !== LOCAL_SERVICE_PLAN_ORIGIN) {
      fail(
        'INVALID_SERVICE_PLAN_PROVENANCE',
        `Local service planning origin must be ${LOCAL_SERVICE_PLAN_ORIGIN}.`
      );
    }
    const status = text(
      raw.status,
      'Project planning status',
      20,
      { required: true }
    );
    if (!SERVICE_PLAN_STATUSES.includes(status)) {
      fail(
        'INVALID_SERVICE_PLAN_STATUS',
        `Project planning status must be one of ${SERVICE_PLAN_STATUSES.join(', ')}.`,
        { status, allowed: SERVICE_PLAN_STATUSES }
      );
    }
    if (
      typeof raw.startTime !== 'string'
      || !SERVICE_START_TIME_PATTERN.test(raw.startTime)
    ) {
      fail(
        'INVALID_SERVICE_PLAN_START_TIME',
        'Project planning startTime must use 24-hour local venue time as HH:mm.',
        { startTime: raw.startTime }
      );
    }
    const normalized = {
      schemaVersion: LOCAL_SERVICE_PLAN_SCHEMA_VERSION,
      status,
      startTime: raw.startTime,
      origin: LOCAL_SERVICE_PLAN_ORIGIN
    };
    if (raw.teamNotes !== undefined) {
      normalized.teamNotes = text(
        raw.teamNotes,
        'Project planning teamNotes',
        4000,
        { trim: false }
      );
    }
    if (raw.readinessWaivers !== undefined) {
      const readinessWaivers =
        normalizeServiceReadinessWaivers(raw.readinessWaivers);
      if (readinessWaivers.length > 0) {
        normalized.readinessWaivers = readinessWaivers;
      }
    }
    if (raw.serving !== undefined) {
      normalized.serving = normalizeProjectServing(raw.serving, itemIds);
    }
    return normalized;
  }
  if ([
    LEGACY_COMMUNITY_SERVICE_PLAN_SCHEMA_VERSION,
    COMMUNITY_SERVICE_PLAN_SCHEMA_VERSION
  ].includes(raw.schemaVersion)) {
    const hasReconciliationBaseline =
      raw.schemaVersion === COMMUNITY_SERVICE_PLAN_SCHEMA_VERSION;
    if (Object.prototype.hasOwnProperty.call(raw, 'templateSource')) {
      fail(
        'INVALID_SERVICE_PLAN_SCHEMA',
        'Template planning metadata must remain schema v1.'
      );
    }
    const unexpected = Object.keys(raw).filter(key =>
      ![
        'schemaVersion',
        'status',
        'startTime',
        'teamNotes',
        'source',
        'readinessWaivers',
        'serving',
        ...(hasReconciliationBaseline
          ? [
              'reconciliationBaseline',
              'lastReconciliationReceipt',
              'localCollisionBoundaryItemIds'
            ]
          : [])
      ].includes(key));
    if (unexpected.length > 0) {
      fail(
        'INVALID_SERVICE_PLAN',
        'Community project planning metadata contains unsupported fields.',
        { fields: unexpected.sort() }
      );
    }
    const status = text(raw.status, 'Project planning status', 20, {
      required: true
    });
    if (!SERVICE_PLAN_STATUSES.includes(status)) {
      fail(
        'INVALID_SERVICE_PLAN_STATUS',
        `Project planning status must be one of ${SERVICE_PLAN_STATUSES.join(', ')}.`,
        { status, allowed: SERVICE_PLAN_STATUSES }
      );
    }
    if (typeof raw.startTime !== 'string'
      || !SERVICE_START_TIME_PATTERN.test(raw.startTime)) {
      fail(
        'INVALID_SERVICE_PLAN_START_TIME',
        'Project planning startTime must use 24-hour local venue time as HH:mm.',
        { startTime: raw.startTime }
      );
    }
    if (!isRecord(raw.source)) {
      fail(
        'INVALID_SERVICE_PLAN_PROVENANCE',
        'Community project planning metadata must identify one exact imported plan.'
      );
    }
    const expectedSourceFields = [
      'kind',
      'serverId',
      'planId',
      'planRevision',
      'importedAt'
    ].sort();
    const actualSourceFields = Object.keys(raw.source).sort();
    if (actualSourceFields.length !== expectedSourceFields.length
      || actualSourceFields.some((key, index) =>
        key !== expectedSourceFields[index])) {
      fail(
        'INVALID_SERVICE_PLAN_PROVENANCE',
        'Community plan provenance contains unsupported or missing fields.',
        { fields: actualSourceFields }
      );
    }
    if (raw.source.kind !== COMMUNITY_SERVICE_PLAN_SOURCE_KIND) {
      fail(
        'INVALID_SERVICE_PLAN_PROVENANCE',
        `Community plan provenance kind must be ${COMMUNITY_SERVICE_PLAN_SOURCE_KIND}.`
      );
    }
    const importedAt = timestamp(
      raw.source.importedAt,
      'Community plan import timestamp'
    );
    if (importedAt !== raw.source.importedAt) {
      fail(
        'INVALID_SERVICE_PLAN_PROVENANCE',
        'Community plan import timestamp must be canonical UTC.'
      );
    }
    if (!SHA256_PATTERN.test(raw.source.planRevision || '')) {
      fail(
        'INVALID_SERVICE_PLAN_PROVENANCE',
        'Community plan revision must be a lowercase SHA-256.'
      );
    }
    let reconciliationBaseline = null;
    let lastReconciliationReceipt = null;
    let localCollisionBoundaryItemIds = [];
    if (hasReconciliationBaseline) {
      if (raw.reconciliationBaseline === undefined) {
        fail(
          'COMMUNITY_PLAN_BASELINE_REQUIRED',
          'Community planning schema v3 requires its exact reconciliation baseline.'
        );
      }
      try {
        reconciliationBaseline = normalizeConfiguredCommunityServicePlanBaseline(
          raw.reconciliationBaseline
        );
      } catch (error) {
        if (error?.name !== 'CommunityServicePlanBaselineError') throw error;
        fail(
          error.code || 'INVALID_COMMUNITY_PLAN_BASELINE',
          error.message,
          error.details
        );
      }
      if (reconciliationBaseline.planRevision !== raw.source.planRevision) {
        fail(
          'COMMUNITY_PLAN_BASELINE_REVISION_MISMATCH',
          'Community reconciliation baseline belongs to another plan revision.'
        );
      }
      if (raw.lastReconciliationReceipt !== undefined) {
        lastReconciliationReceipt =
          normalizeCommunityReconciliationReceipt(
            raw.lastReconciliationReceipt
          );
        if (
          lastReconciliationReceipt.candidatePlanRevision
            !== raw.source.planRevision
          || lastReconciliationReceipt.candidateProjectionSha256
            !== reconciliationBaseline.projectionSha256
          || lastReconciliationReceipt.appliedAt !== importedAt
        ) {
          fail(
            'COMMUNITY_RECONCILIATION_RECEIPT_BINDING_MISMATCH',
            'Community reconciliation receipt belongs to another imported plan revision.'
          );
        }
      }
      if (raw.localCollisionBoundaryItemIds !== undefined) {
        if (
          !Array.isArray(raw.localCollisionBoundaryItemIds)
          || raw.localCollisionBoundaryItemIds.length
            > MAX_COMMUNITY_LOCAL_COLLISION_BOUNDARIES
        ) {
          fail(
            'INVALID_COMMUNITY_COLLISION_BOUNDARIES',
            'Community local collision boundaries must be a bounded item-ID list.'
          );
        }
        localCollisionBoundaryItemIds =
          raw.localCollisionBoundaryItemIds.map((itemId, index) =>
            id(
              itemId,
              `Community local collision boundary ${index + 1}`
            ));
        if (
          new Set(localCollisionBoundaryItemIds).size
            !== localCollisionBoundaryItemIds.length
        ) {
          fail(
            'INVALID_COMMUNITY_COLLISION_BOUNDARIES',
            'Community local collision boundary item IDs must be unique.'
          );
        }
        localCollisionBoundaryItemIds.sort();
      }
    }
    const normalized = {
      schemaVersion: raw.schemaVersion,
      status,
      startTime: raw.startTime,
      source: {
        kind: COMMUNITY_SERVICE_PLAN_SOURCE_KIND,
        serverId: id(raw.source.serverId, 'Community plan server id'),
        planId: id(raw.source.planId, 'Community plan id'),
        planRevision: raw.source.planRevision,
        importedAt
      },
      ...(reconciliationBaseline ? { reconciliationBaseline } : {}),
      ...(lastReconciliationReceipt ? { lastReconciliationReceipt } : {}),
      ...(localCollisionBoundaryItemIds.length > 0
        ? { localCollisionBoundaryItemIds }
        : {})
    };
    if (raw.teamNotes !== undefined) {
      normalized.teamNotes = text(
        raw.teamNotes,
        'Project planning teamNotes',
        4000,
        { trim: false }
      );
    }
    if (raw.readinessWaivers !== undefined) {
      const readinessWaivers =
        normalizeServiceReadinessWaivers(raw.readinessWaivers);
      if (readinessWaivers.length > 0) {
        normalized.readinessWaivers = readinessWaivers;
      }
    }
    if (raw.serving !== undefined) {
      normalized.serving = normalizeProjectServing(raw.serving, itemIds);
    }
    return normalized;
  }
  if (raw.schemaVersion !== SERVICE_PLAN_SCHEMA_VERSION) {
    fail(
      'INVALID_SERVICE_PLAN_SCHEMA',
      `Project planning metadata must use schema v${SERVICE_PLAN_SCHEMA_VERSION}, v${LEGACY_COMMUNITY_SERVICE_PLAN_SCHEMA_VERSION}, v${COMMUNITY_SERVICE_PLAN_SCHEMA_VERSION}, or v${LOCAL_SERVICE_PLAN_SCHEMA_VERSION}.`
    );
  }
  const unexpected = Object.keys(raw).filter(key =>
    ![
      'schemaVersion',
      'status',
      'startTime',
      'teamNotes',
      'templateSource',
      'readinessWaivers',
      'serving'
    ].includes(key));
  if (unexpected.length > 0) {
    fail(
      'INVALID_SERVICE_PLAN',
      'Project planning metadata contains unsupported fields.',
      { fields: unexpected }
    );
  }
  const status = text(raw.status, 'Project planning status', 20, { required: true });
  if (!SERVICE_PLAN_STATUSES.includes(status)) {
    fail(
      'INVALID_SERVICE_PLAN_STATUS',
      `Project planning status must be one of ${SERVICE_PLAN_STATUSES.join(', ')}.`,
      { status, allowed: SERVICE_PLAN_STATUSES }
    );
  }
  if (typeof raw.startTime !== 'string' || !SERVICE_START_TIME_PATTERN.test(raw.startTime)) {
    fail(
      'INVALID_SERVICE_PLAN_START_TIME',
      'Project planning startTime must use 24-hour local venue time as HH:mm.',
      { startTime: raw.startTime }
    );
  }
  if (!isRecord(raw.templateSource)) {
    fail(
      'INVALID_SERVICE_PLAN_PROVENANCE',
      'Project planning metadata must identify one exact saved source template.'
    );
  }
  const unexpectedSourceFields = Object.keys(raw.templateSource).filter(key =>
    !['projectId', 'sourceRevisionId'].includes(key));
  if (unexpectedSourceFields.length > 0) {
    fail(
      'INVALID_SERVICE_PLAN_PROVENANCE',
      'Project template provenance contains unsupported fields.',
      { fields: unexpectedSourceFields }
    );
  }
  const sourceProjectId = id(
    raw.templateSource.projectId,
    'Project planning template source project id'
  );
  if (sourceProjectId === projectId) {
    fail(
      'INVALID_SERVICE_PLAN_PROVENANCE',
      'A planned service must have a new project id distinct from its source template.'
    );
  }
  if (!SHA256_PATTERN.test(raw.templateSource.sourceRevisionId || '')) {
    fail(
      'INVALID_SERVICE_PLAN_PROVENANCE',
      'Project template sourceRevisionId must be a lowercase SHA-256 revision id.'
    );
  }
  const normalized = {
    schemaVersion: SERVICE_PLAN_SCHEMA_VERSION,
    status,
    startTime: raw.startTime,
    templateSource: {
      projectId: sourceProjectId,
      sourceRevisionId: raw.templateSource.sourceRevisionId
    }
  };
  if (raw.teamNotes !== undefined) {
    normalized.teamNotes = text(
      raw.teamNotes,
      'Project planning teamNotes',
      4000,
      { trim: false }
    );
  }
  if (raw.readinessWaivers !== undefined) {
    const readinessWaivers = normalizeServiceReadinessWaivers(raw.readinessWaivers);
    if (readinessWaivers.length > 0) normalized.readinessWaivers = readinessWaivers;
  }
  if (raw.serving !== undefined) {
    normalized.serving = normalizeProjectServing(raw.serving, itemIds);
  }
  return normalized;
}

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
  let document;
  let canonical;
  let mediaType;
  if (raw.kind === 'song') {
    document = normalizeSongDocument(raw.document);
    canonical = serializeSongDocument(document);
    mediaType = 'application/vnd.syncshow.song+json';
  } else if (raw.kind === 'sermon') {
    document = normalizeSermonDocument(raw.document);
    canonical = serializeSermonDocument(document);
    mediaType = 'application/vnd.syncshow.sermon+json';
  } else {
    fail('INVALID_RESOURCE_KIND', `Resource ${expectedId} has unsupported kind ${raw.kind}.`);
  }
  const sha256 = crypto.createHash('sha256').update(canonical).digest('hex');
  const resourceId = `sha256:${sha256}`;
  if (expectedId !== resourceId || raw.id !== resourceId || (raw.sha256 && raw.sha256 !== sha256)) {
    fail('RESOURCE_HASH_MISMATCH', `Resource ${expectedId} does not match its content hash.`, { expectedId, resourceId });
  }
  return {
    id: resourceId,
    kind: raw.kind,
    schemaVersion: document.schemaVersion,
    mediaType,
    size: Buffer.byteLength(canonical, 'utf8'),
    sha256,
    origin: normalizeResourceOrigin(raw.origin, `Resource ${resourceId} origin`),
    document
  };
}

function normalizeSermonLinkFields(raw, field) {
  const link = {};
  if (raw.sermonResourceId !== undefined && raw.sermonResourceId !== null) {
    if (!ASSET_ID_PATTERN.test(raw.sermonResourceId || '')) {
      fail(
        'INVALID_SERMON_RESOURCE_REFERENCE',
        `${field}.sermonResourceId must be content-addressed.`
      );
    }
    link.sermonResourceId = raw.sermonResourceId;
  }
  if (raw.sermonSectionId !== undefined && raw.sermonSectionId !== null) {
    link.sermonSectionId = id(raw.sermonSectionId, `${field}.sermonSectionId`);
  }
  return link;
}

function normalizeSermonReadingOutputs(
  rawOutputs,
  channelIds,
  field,
  { requireOrder = true } = {}
) {
  if (!Array.isArray(rawOutputs)
    || rawOutputs.length !== channelIds.length) {
    fail(
      'INVALID_SERMON_READING_OUTPUTS',
      `${field} must include exactly one treatment for every project channel.`
    );
  }
  const expectedChannelIds = new Set(channelIds);
  const seenChannelIds = new Set();
  const normalized = rawOutputs.map((rawOutput, index) => {
    const outputField = `${field}[${index}]`;
    if (!isRecord(rawOutput)) {
      fail(
        'INVALID_SERMON_READING_OUTPUT',
        `${outputField} must be an output treatment.`
      );
    }
    const mode = rawOutput.mode;
    const allowedKeys = mode === 'translation'
      ? ['channelId', 'mode', 'translationId']
      : ['channelId', 'mode'];
    const unexpectedKeys = Object.keys(rawOutput)
      .filter(key => !allowedKeys.includes(key));
    if (unexpectedKeys.length > 0) {
      fail(
        'INVALID_SERMON_READING_OUTPUT',
        `${outputField} contains unsupported fields.`,
        { fields: unexpectedKeys.sort() }
      );
    }
    const channelId = id(rawOutput.channelId, `${outputField}.channelId`);
    if (!expectedChannelIds.has(channelId)) {
      fail(
        'UNKNOWN_PROJECT_CHANNEL',
        `${outputField} uses unknown project channel ${channelId}.`
      );
    }
    if (requireOrder && channelId !== channelIds[index]) {
      fail(
        'INVALID_SERMON_READING_OUTPUT_ORDER',
        `${field} must follow the project's channel order.`
      );
    }
    if (seenChannelIds.has(channelId)) {
      fail(
        'DUPLICATE_SERMON_READING_OUTPUT',
        `${field} repeats project channel ${channelId}.`
      );
    }
    seenChannelIds.add(channelId);
    if (mode === 'hidden') return { channelId, mode };
    if (mode !== 'translation') {
      fail(
        'INVALID_SERMON_READING_OUTPUT_MODE',
        `${outputField} must use a translation or stay hidden.`
      );
    }
    const rawTranslationId = text(
      rawOutput.translationId,
      `${outputField}.translationId`,
      12,
      { required: true }
    );
    const translationId = rawTranslationId.toUpperCase();
    if (translationId !== rawTranslationId) {
      fail(
        'INVALID_SERMON_READING_TRANSLATION',
        `${outputField}.translationId must be uppercase.`
      );
    }
    return { channelId, mode, translationId };
  });
  if (seenChannelIds.size !== channelIds.length) {
    fail(
      'INVALID_SERMON_READING_OUTPUTS',
      `${field} must include exactly one treatment for every project channel.`
    );
  }
  if (!normalized.some(output => output.mode === 'translation')) {
    fail(
      'SERMON_READING_OUTPUTS_ALL_HIDDEN',
      `${field} must show the reading on at least one project channel.`
    );
  }
  return normalized;
}

function normalizeSermonReadingLink(raw, field, channelIds) {
  if (raw === undefined || raw === null) return null;
  if (!isRecord(raw)) {
    fail('INVALID_SERMON_READING_LINK', `${field} must identify one reviewed sermon reading chunk.`);
  }
  if (!ASSET_ID_PATTERN.test(raw.sermonResourceId || '')) {
    fail(
      'INVALID_SERMON_READING_LINK',
      `${field}.sermonResourceId must identify an exact content-addressed sermon revision.`
    );
  }
  const chunkCount = finiteInteger(raw.chunkCount, `${field}.chunkCount`, 1, 100);
  const chunkIndex = finiteInteger(raw.chunkIndex, `${field}.chunkIndex`, 0, chunkCount - 1);
  const hasLegacyTranslation = raw.translationId !== undefined;
  const hasDenseOutputs = raw.outputs !== undefined;
  if (hasLegacyTranslation === hasDenseOutputs) {
    fail(
      'INVALID_SERMON_READING_LINK',
      `${field} must use either one legacy translation or one dense output plan.`
    );
  }
  const normalized = {
    sermonResourceId: raw.sermonResourceId,
    referenceId: id(raw.referenceId, `${field}.referenceId`),
    chunkIndex,
    chunkCount
  };
  if (hasLegacyTranslation) {
    normalized.translationId = text(
      raw.translationId,
      `${field}.translationId`,
      12,
      { required: true }
    ).toUpperCase();
  } else {
    normalized.outputs = normalizeSermonReadingOutputs(
      raw.outputs,
      channelIds,
      `${field}.outputs`
    );
  }
  return normalized;
}

/**
 * Return the exact logical output treatment plan for one normalized generated
 * sermon-reading item without rewriting its persisted provenance shape.
 *
 * New readings carry an explicit dense output plan, including hidden
 * channels. Legacy readings derive their effective plan from the already
 * pinned channel passages, with their one translation as a final fallback.
 */
function sermonReadingOutputPlan(project, item) {
  if (!project
    || !Array.isArray(project.channelIds)
    || !item
    || item.kind !== 'bible'
    || !item.sermonReading) {
    return null;
  }
  if (Array.isArray(item.sermonReading.outputs)) {
    return item.sermonReading.outputs.map(output => ({ ...output }));
  }
  if (isRecord(item.passagesByChannel)) {
    const fromPinnedPassages = project.channelIds.map(channelId => {
      const passage = item.passagesByChannel[channelId];
      return passage
        ? {
            channelId,
            mode: 'translation',
            translationId: passage.translationId
          }
        : { channelId, mode: 'hidden' };
    });
    if (fromPinnedPassages.some(output => output.mode === 'translation')) {
      return fromPinnedPassages;
    }
  }
  if (typeof item.sermonReading.translationId === 'string'
    && item.sermonReading.translationId) {
    return project.channelIds.map(channelId => ({
      channelId,
      mode: 'translation',
      translationId: item.sermonReading.translationId
    }));
  }
  return null;
}

function sermonReadingOutputPlansEqual(left, right) {
  return Boolean(
    Array.isArray(left)
    && Array.isArray(right)
    && left.length === right.length
    && left.every((output, index) =>
      output.channelId === right[index]?.channelId
      && output.mode === right[index]?.mode
      && (
        output.mode === 'hidden'
        || output.translationId === right[index]?.translationId
      ))
  );
}

function sermonReadingOutputPlanSignature(outputs) {
  if (!Array.isArray(outputs)) return '';
  return JSON.stringify(outputs.map(output =>
    output.mode === 'hidden'
      ? [output.channelId, 'hidden']
      : [output.channelId, 'translation', output.translationId]));
}

function sermonBodyEntryRevisionId(rawEntry) {
  return crypto.createHash('sha256')
    .update(`${JSON.stringify(stableObject(rawEntry))}\n`)
    .digest('hex');
}

function sermonBodyParagraphCandidates(bodyEntry) {
  const sourceText = bodyEntry?.text;
  if (typeof sourceText !== 'string') return [];
  const segments = [];
  let paragraphStart = null;
  let paragraphEnd = null;
  let lineStart = 0;
  while (lineStart <= sourceText.length) {
    const newlineOffset = sourceText.indexOf('\n', lineStart);
    const lineEnd = newlineOffset < 0 ? sourceText.length : newlineOffset;
    const blank = /^[ \t]*$/u.test(sourceText.slice(lineStart, lineEnd));
    if (blank) {
      if (paragraphStart !== null) {
        segments.push({
          startOffset: paragraphStart,
          endOffset: paragraphEnd,
          text: sourceText.slice(paragraphStart, paragraphEnd)
        });
        paragraphStart = null;
        paragraphEnd = null;
      }
    } else {
      if (paragraphStart === null) paragraphStart = lineStart;
      paragraphEnd = lineEnd;
    }
    if (newlineOffset < 0) break;
    lineStart = newlineOffset + 1;
  }
  if (paragraphStart !== null) {
    segments.push({
      startOffset: paragraphStart,
      endOffset: paragraphEnd,
      text: sourceText.slice(paragraphStart, paragraphEnd)
    });
  }
  return segments.map((segment, index) => ({
    id: `paragraph-${String(index + 1).padStart(3, '0')}`,
    ordinal: index + 1,
    ...segment,
    textSha256: crypto.createHash('sha256')
      .update(segment.text)
      .digest('hex')
  }));
}

function normalizeSourceBodyProjection(raw, itemId, channelIds) {
  if (raw === undefined || raw === null) return null;
  const field = `Sermon item ${itemId} sourceBodyProjection`;
  const schemaVersion = raw?.schemaVersion;
  const expectedKeys = [
    'schemaVersion',
    'kind',
    'proposalId',
    'rowId',
    'anchorItemId',
    'sermonId',
    'sermonRevisionId',
    'channels'
  ].sort();
  if (!isRecord(raw)
    || Object.keys(raw).sort().some((key, index) => key !== expectedKeys[index])
    || Object.keys(raw).length !== expectedKeys.length
    || ![
      SOURCE_BODY_PROJECTION_SCHEMA_VERSION,
      SOURCE_BODY_PROJECTION_SCHEMA_VERSION_V2
    ].includes(schemaVersion)
    || raw.kind !== SOURCE_BODY_PROJECTION_KIND
    || !SHA256_PATTERN.test(raw.proposalId || '')
    || !SHA256_PATTERN.test(raw.sermonRevisionId || '')
    || !isRecord(raw.channels)) {
    fail(
      'INVALID_SOURCE_BODY_PROJECTION',
      `${field} is not a reviewed sermon-body projection receipt.`,
      { itemId }
    );
  }
  const sourceChannelIds = Object.keys(raw.channels);
  if (sourceChannelIds.length < 1
    || sourceChannelIds.length > MAX_PROJECT_CHANNELS
    || sourceChannelIds.some(channelId => !channelIds.includes(channelId))) {
    fail(
      'INVALID_SOURCE_BODY_PROJECTION',
      `${field} channels must identify one or more reviewed project outputs.`,
      { itemId }
    );
  }
  const channels = {};
  for (const channelId of channelIds.filter(candidate =>
    Object.prototype.hasOwnProperty.call(raw.channels, candidate))) {
    const source = raw.channels[channelId];
    const channelField = `${field} channel ${channelId}`;
    const expectedSourceKeys = (
      schemaVersion === SOURCE_BODY_PROJECTION_SCHEMA_VERSION
        ? [
            'bodyEntryId',
            'bodyEntrySha256',
            'paragraphId',
            'startOffset',
            'endOffset',
            'textSha256'
          ]
        : [
            'mode',
            'bodyEntryId',
            'bodyEntrySha256',
            'paragraphId',
            'startOffset',
            'endOffset',
            'sourceTextSha256',
            'projectedTextSha256'
          ]
    ).sort();
    if (!isRecord(source)
      || Object.keys(source).length !== expectedSourceKeys.length
      || Object.keys(source).sort().some((key, index) =>
        key !== expectedSourceKeys[index])
      || !SHA256_PATTERN.test(source.bodyEntrySha256 || '')
      || (
        schemaVersion === SOURCE_BODY_PROJECTION_SCHEMA_VERSION
          ? !SHA256_PATTERN.test(source.textSha256 || '')
          : (
              !['exact', 'condensed'].includes(source.mode)
              || !SHA256_PATTERN.test(source.sourceTextSha256 || '')
              || !SHA256_PATTERN.test(source.projectedTextSha256 || '')
            )
      )) {
      fail(
        'INVALID_SOURCE_BODY_PROJECTION',
        `${channelField} is not bounded reviewed source evidence.`,
        { itemId, channelId }
      );
    }
    const startOffset = finiteInteger(
      source.startOffset,
      `${channelField} startOffset`,
      0,
      1024 * 1024
    );
    const endOffset = finiteInteger(
      source.endOffset,
      `${channelField} endOffset`,
      startOffset + 1,
      1024 * 1024
    );
    const common = {
      bodyEntryId: id(source.bodyEntryId, `${channelField} bodyEntryId`),
      bodyEntrySha256: source.bodyEntrySha256,
      paragraphId: id(source.paragraphId, `${channelField} paragraphId`),
      startOffset,
      endOffset
    };
    channels[channelId] = schemaVersion === SOURCE_BODY_PROJECTION_SCHEMA_VERSION
      ? {
          ...common,
          textSha256: source.textSha256
        }
      : {
          mode: source.mode,
          ...common,
          sourceTextSha256: source.sourceTextSha256,
          projectedTextSha256: source.projectedTextSha256
        };
  }
  return {
    schemaVersion,
    kind: SOURCE_BODY_PROJECTION_KIND,
    proposalId: raw.proposalId,
    rowId: id(raw.rowId, `${field} rowId`),
    anchorItemId: id(raw.anchorItemId, `${field} anchorItemId`),
    sermonId: id(raw.sermonId, `${field} sermonId`),
    sermonRevisionId: raw.sermonRevisionId,
    channels
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

function normalizePictureSourceVisualReview(
  raw,
  itemId,
  pictureSource,
  channelIds
) {
  if (raw === undefined) return null;
  const field = `Picture item ${itemId} sourceVisualReview`;
  const allowedKeys = [
    'schemaVersion',
    'kind',
    'serviceSetId',
    'serviceSetFingerprint',
    'renderRevisionId',
    'position',
    'assetIdsByChannel'
  ];
  if (!isRecord(raw)
    || Object.keys(raw).some(key => !allowedKeys.includes(key))
    || raw.schemaVersion !== 1
    || raw.kind !== 'powerpoint-render'
    || !SHA256_PATTERN.test(raw.serviceSetFingerprint || '')
    || !SHA256_PATTERN.test(raw.renderRevisionId || '')
    || !isRecord(raw.assetIdsByChannel)
    || !pictureSource.assetIdsByChannel) {
    fail(
      'INVALID_SOURCE_VISUAL_REVIEW',
      `${field} is invalid.`,
      { itemId }
    );
  }

  const serviceSetId = id(raw.serviceSetId, `${field} serviceSetId`);
  const position = finiteInteger(
    raw.position,
    `${field} position`,
    1,
    MAX_CUES
  );
  const pictureChannelIds = Object.keys(pictureSource.assetIdsByChannel);
  const reviewChannelIds = Object.keys(raw.assetIdsByChannel);
  if (reviewChannelIds.length !== pictureChannelIds.length) {
    fail(
      'SOURCE_VISUAL_REVIEW_ASSET_MISMATCH',
      `${field} must identify the picture's exact output images.`,
      { itemId }
    );
  }
  const assetIdsByChannel = {};
  for (const channelId of channelIds) {
    if (!Object.prototype.hasOwnProperty.call(
      pictureSource.assetIdsByChannel,
      channelId
    )) {
      continue;
    }
    const assetId = raw.assetIdsByChannel[channelId];
    if (!ASSET_ID_PATTERN.test(assetId || '')
      || assetId !== pictureSource.assetIdsByChannel[channelId]) {
      fail(
        'SOURCE_VISUAL_REVIEW_ASSET_MISMATCH',
        `${field} must identify the picture's exact output images.`,
        { itemId, channelId }
      );
    }
    assetIdsByChannel[channelId] = assetId;
  }
  if (Object.keys(assetIdsByChannel).length !== pictureChannelIds.length) {
    fail(
      'SOURCE_VISUAL_REVIEW_ASSET_MISMATCH',
      `${field} must identify the picture's exact output images.`,
      { itemId }
    );
  }
  return {
    schemaVersion: 1,
    kind: 'powerpoint-render',
    serviceSetId,
    serviceSetFingerprint: raw.serviceSetFingerprint,
    renderRevisionId: raw.renderRevisionId,
    position,
    assetIdsByChannel
  };
}

function normalizeSongSourceRangeReplacement(raw, itemId) {
  if (raw === undefined || raw === null) return null;
  const field = `Song item ${itemId} sourceRangeReplacement`;
  const allowedKeys = [
    'schemaVersion',
    'kind',
    'serviceSetId',
    'serviceSetFingerprint',
    'renderRevisionId',
    'sourceProjectRevisionId',
    'startPosition',
    'endPosition',
    'sourceItemIds',
    'sourceItemsSha256',
    'snapshotHash',
    'receiptHash',
    'rootSongId',
    'familyRevision'
  ];
  if (
    !isRecord(raw)
    || Object.keys(raw).length !== allowedKeys.length
    || Object.keys(raw).some(key => !allowedKeys.includes(key))
    || raw.schemaVersion !== 1
    || raw.kind !== SOURCE_RANGE_REPLACEMENT_KIND
    || !SHA256_PATTERN.test(raw.serviceSetFingerprint || '')
    || !SHA256_PATTERN.test(raw.renderRevisionId || '')
    || !SHA256_PATTERN.test(raw.sourceProjectRevisionId || '')
    || !SHA256_PATTERN.test(raw.sourceItemsSha256 || '')
    || !SHA256_PATTERN.test(raw.snapshotHash || '')
    || !SHA256_PATTERN.test(raw.receiptHash || '')
    || !SHA256_PATTERN.test(raw.familyRevision || '')
    || !Array.isArray(raw.sourceItemIds)
    || raw.sourceItemIds.length < 2
    || raw.sourceItemIds.length > MAX_SOURCE_RANGE_REPLACEMENT_ITEMS
  ) {
    fail(
      'INVALID_SOURCE_RANGE_REPLACEMENT',
      `${field} is invalid.`,
      { itemId }
    );
  }
  const startPosition = finiteInteger(
    raw.startPosition,
    `${field} startPosition`,
    1,
    MAX_CUES
  );
  const endPosition = finiteInteger(
    raw.endPosition,
    `${field} endPosition`,
    startPosition,
    MAX_CUES
  );
  const sourceItemIds = normalizeUniqueIds(
    raw.sourceItemIds,
    `${field} sourceItemIds`,
    MAX_SOURCE_RANGE_REPLACEMENT_ITEMS
  );
  if (endPosition - startPosition + 1 !== sourceItemIds.length) {
    fail(
      'INVALID_SOURCE_RANGE_REPLACEMENT',
      `${field} must describe one consecutive source range.`,
      { itemId, startPosition, endPosition }
    );
  }
  return {
    schemaVersion: 1,
    kind: SOURCE_RANGE_REPLACEMENT_KIND,
    serviceSetId: id(raw.serviceSetId, `${field} serviceSetId`),
    serviceSetFingerprint: raw.serviceSetFingerprint,
    renderRevisionId: raw.renderRevisionId,
    sourceProjectRevisionId: raw.sourceProjectRevisionId,
    startPosition,
    endPosition,
    sourceItemIds,
    sourceItemsSha256: raw.sourceItemsSha256,
    snapshotHash: raw.snapshotHash,
    receiptHash: raw.receiptHash,
    rootSongId: id(raw.rootSongId, `${field} rootSongId`),
    familyRevision: raw.familyRevision
  };
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
  if (Object.prototype.hasOwnProperty.call(raw, 'plannedDurationSeconds')) {
    common.plannedDurationSeconds = finiteInteger(
      raw.plannedDurationSeconds,
      `Item ${itemId} plannedDurationSeconds`,
      0,
      MAX_PLANNED_ITEM_DURATION_SECONDS
    );
  }

  if (raw.kind === 'group') {
    if (!PROJECT_GROUP_KINDS.includes(raw.groupKind)) {
      fail('INVALID_GROUP_KIND', `Group ${itemId} has unsupported kind ${raw.groupKind}.`);
    }
    return {
      ...common,
      groupKind: raw.groupKind,
      childIds: normalizeUniqueIds(raw.childIds || [], `Group ${itemId} childIds`, MAX_GROUP_CHILDREN),
      ...normalizeSermonLinkFields(raw, `Group ${itemId}`)
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
    if (raw.showTitle !== undefined && typeof raw.showTitle !== 'boolean') fail('INVALID_SONG_TITLE_MODE', 'Song showTitle must be a boolean.');
    if (!Array.isArray(raw.arrangement) || raw.arrangement.length < (raw.showTitle === true ? 0 : 1) || raw.arrangement.length > MAX_ARRANGEMENT_ENTRIES) {
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
    const sourceRangeReplacement = normalizeSongSourceRangeReplacement(
      raw.sourceRangeReplacement,
      itemId
    );
    return {
      ...common,
      variants,
      arrangement,
      ...(raw.showTitle !== undefined ? { showTitle: raw.showTitle } : {}),
      ...(raw.songPresentation !== undefined
        ? { songPresentation: normalizeSongPresentation(raw.songPresentation, channelIds, variants) } : {}),
      ...(primaryChannelId ? { primaryChannelId } : {}),
      titlePresetId: id(raw.titlePresetId || 'song-title', `Song item ${itemId} titlePresetId`),
      lyricsPresetId: id(raw.lyricsPresetId || 'song-lyrics', `Song item ${itemId} lyricsPresetId`),
      ...(sourceRangeReplacement ? { sourceRangeReplacement } : {})
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
    const sermonReading = normalizeSermonReadingLink(
      raw.sermonReading,
      `Bible item ${itemId}.sermonReading`,
      channelIds
    );
    return {
      ...common,
      range,
      passagesByChannel,
      presetId: id(raw.presetId || 'scripture-text', `Bible item ${itemId} presetId`),
      ...(sermonReading ? { sermonReading } : {})
    };
  }

  if (raw.kind === 'sermon' || raw.kind === 'notice') {
    const sermonOptions = normalizeSermonOptions(raw, channelIds, fail);
    if (!isRecord(raw.textByChannel)) fail('INVALID_TEXT_VARIANTS', `Item ${itemId} needs text variants.`);
    const textByChannel = {};
    for (const [channelId, value] of Object.entries(raw.textByChannel)) {
      if (!channelIds.includes(channelId)) fail('UNKNOWN_PROJECT_CHANNEL', `Item ${itemId} uses unknown channel ${channelId}.`);
      textByChannel[channelId] = text(value, `Item ${itemId} channel ${channelId}`, 20000, { required: !sermonOptions.sermonTemplate, trim: false });
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
      ...sermonOptions,
      ...(spansByChannel ? { spansByChannel } : {}),
      ...(titlesByChannel ? { titlesByChannel } : {}),
      ...(raw.titleSpansByChannel ? { titleSpansByChannel: Object.fromEntries(Object.entries(raw.titleSpansByChannel).map(([channelId, spans]) => {
        if (!titlesByChannel?.[channelId]) fail('INVALID_TEXT_SPANS', 'Title formatting needs text on the same output.');
        return [channelId, normalizeTextSpans(spans, titlesByChannel[channelId], `Item ${itemId} title spans`)];
      })) } : {}),
      ...(raw.backgroundAssetId ? { backgroundAssetId: ASSET_ID_PATTERN.test(raw.backgroundAssetId) ? raw.backgroundAssetId : fail('INVALID_ASSET_REFERENCE', 'Invalid slide background image.') } : {}),
      ...(raw.kind === 'sermon' ? normalizeSermonLinkFields(raw, `Sermon item ${itemId}`) : {}),
      ...(raw.kind === 'sermon' && raw.sourceBodyProjection
        ? {
            sourceBodyProjection: normalizeSourceBodyProjection(
              raw.sourceBodyProjection,
              itemId,
              channelIds
            )
          }
        : {}),
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
    const sourceVisualReview = normalizePictureSourceVisualReview(
      raw.sourceVisualReview,
      itemId,
      pictureSource,
      channelIds
    );
    return {
      ...common,
      ...pictureSource,
      ...(sourceVisualReview ? { sourceVisualReview } : {}),
      fit,
      focalPoint: normalizeFocalPoint(raw.focalPoint, `Picture item ${itemId} focalPoint`),
      altText: text(raw.altText, `Picture item ${itemId} altText`, 500, { required: true }),
      attribution: text(raw.attribution, `Picture item ${itemId} attribution`, 500),
      presetId: id(raw.presetId || 'picture-fullscreen', `Picture item ${itemId} presetId`)
    };
  }

  if (raw.kind === 'video') {
    if (!ASSET_ID_PATTERN.test(raw.assetId || '')) {
      fail('INVALID_ASSET_REFERENCE', `Video item ${itemId} needs an asset.`);
    }
    const videoChannelIds = normalizeUniqueIds(
      raw.channelIds || channelIds,
      `Video item ${itemId} channelIds`,
      MAX_PROJECT_CHANNELS
    );
    const audioChannelId = id(
      raw.audioChannelId || videoChannelIds[0],
      `Video item ${itemId} audioChannelId`
    );
    if (!videoChannelIds.includes(audioChannelId)) {
      fail(
        'INVALID_VIDEO_AUDIO_CHANNEL',
        `Video item ${itemId} audio output must also show the video.`
      );
    }
    const fit = raw.fit || 'fit';
    if (!IMAGE_FITS.includes(fit)) {
      fail('INVALID_VIDEO_FIT', `Video item ${itemId} has unsupported fit ${fit}.`);
    }
    return {
      ...common,
      assetId: raw.assetId,
      channelIds: videoChannelIds,
      audioChannelId,
      fit,
      presetId: id(raw.presetId || 'video-fullscreen', `Video item ${itemId} presetId`)
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

function resolveSermonSourceLink(project, item, index = project._index || validateProjectTree(project)) {
  const lineage = [];
  let parentId = index.parentByItemId[item.id];
  while (parentId !== null && parentId !== undefined) {
    lineage.unshift(project.items[parentId]);
    parentId = index.parentByItemId[parentId];
  }
  lineage.push(item);

  let resourceId = null;
  let sectionId = null;
  let resourceOwnerId = null;
  let sectionOwnerId = null;
  let hasLink = false;
  for (const record of lineage) {
    if (record.sermonResourceId) {
      resourceId = record.sermonResourceId;
      resourceOwnerId = record.id;
      sectionId = null;
      sectionOwnerId = null;
      hasLink = true;
    }
    if (record.sermonSectionId) {
      sectionId = record.sermonSectionId;
      sectionOwnerId = record.id;
      hasLink = true;
    }
  }
  if (!hasLink) return null;
  if (!resourceId) {
    fail(
      'MISSING_SERMON_RESOURCE',
      `Project item ${item.id} selects a sermon section without a sermon resource.`
    );
  }
  const resource = project.resources[resourceId];
  if (!resource || resource.kind !== 'sermon') {
    fail(
      'INVALID_SERMON_RESOURCE_REFERENCE',
      `Project item ${item.id} does not resolve to a pinned sermon resource.`,
      { itemId: item.id, resourceId }
    );
  }
  if (sectionId && !resource.document.outline.some(section => section.id === sectionId)) {
    fail(
      'UNKNOWN_SERMON_SECTION',
      `Project item ${item.id} selects missing sermon section ${sectionId}.`,
      { itemId: item.id, resourceId, sectionId }
    );
  }
  return {
    resourceId,
    sectionId,
    resource,
    resourceOwnerId,
    sectionOwnerId
  };
}

function validateSourceBodyProjection(project, item, index, linked) {
  const projection = item.sourceBodyProjection;
  if (!projection) return;
  const parentItemId = index.parentByItemId[item.id];
  if (
    !linked
    ||
    parentItemId !== projection.anchorItemId
    || linked.resource.document.schemaVersion !== 3
    || linked.resource.document.id !== projection.sermonId
    || linked.resource.sha256 !== projection.sermonRevisionId
  ) {
    fail(
      'SOURCE_BODY_PROJECTION_BINDING_MISMATCH',
      `Sermon item ${item.id} no longer matches its reviewed sermon-body projection binding.`,
      { itemId: item.id }
    );
  }
  const projectedChannelIds = Object.keys(projection.channels);
  const textChannelIds = Object.keys(item.textByChannel);
  const isLegacyExactReceipt =
    projection.schemaVersion === SOURCE_BODY_PROJECTION_SCHEMA_VERSION;
  const hasInvalidChannelCoverage = isLegacyExactReceipt
    ? (
        projectedChannelIds.length !== textChannelIds.length
        || textChannelIds.some(channelId =>
          !Object.prototype.hasOwnProperty.call(projection.channels, channelId))
      )
    : projectedChannelIds.some(channelId =>
        !Object.prototype.hasOwnProperty.call(item.textByChannel, channelId));
  if (hasInvalidChannelCoverage) {
    fail(
      'SOURCE_BODY_PROJECTION_TEXT_MISMATCH',
      `Sermon item ${item.id} outputs no longer match its reviewed body sources.`,
      { itemId: item.id }
    );
  }
  for (const channelId of projectedChannelIds) {
    const source = projection.channels[channelId];
    const entry = linked.resource.document.body.find(candidate =>
      candidate.id === source.bodyEntryId);
    const paragraph = entry
      ? sermonBodyParagraphCandidates(entry).find(candidate =>
          candidate.id === source.paragraphId)
      : null;
    const projectedText = entry?.text.slice(
      source.startOffset,
      source.endOffset
    );
    const projectedTextSha256 = crypto.createHash('sha256')
      .update(projectedText || '')
      .digest('hex');
    const itemText = item.textByChannel[channelId];
    const itemTextSha256 = typeof itemText === 'string'
      ? crypto.createHash('sha256').update(itemText).digest('hex')
      : null;
    const sourceTextSha256 = isLegacyExactReceipt
      ? source.textSha256
      : source.sourceTextSha256;
    if (
      !entry
      || sermonBodyEntryRevisionId(entry) !== source.bodyEntrySha256
      || !paragraph
      || paragraph.startOffset !== source.startOffset
      || paragraph.endOffset !== source.endOffset
      || paragraph.textSha256 !== sourceTextSha256
      || source.endOffset > entry.text.length
      || splitsSurrogatePair(entry.text, source.startOffset)
      || splitsSurrogatePair(entry.text, source.endOffset)
      || projectedTextSha256 !== sourceTextSha256
      || (
        isLegacyExactReceipt
          ? projectedText !== itemText
          : (
              itemTextSha256 !== source.projectedTextSha256
              || (source.mode === 'exact' && projectedText !== itemText)
            )
      )
    ) {
      fail(
        'SOURCE_BODY_PROJECTION_TEXT_MISMATCH',
        `Sermon item ${item.id} channel ${channelId} no longer matches its reviewed canonical body projection.`,
        { itemId: item.id, channelId, bodyEntryId: source.bodyEntryId }
      );
    }
  }
}

function isSermonSourceTarget(project, item, index = project._index || validateProjectTree(project)) {
  if (!item) return false;
  if (item.kind === 'sermon') return true;
  if (item.kind !== 'group') return false;
  if (['sermon', 'point', 'subpoint'].includes(item.groupKind)) return true;
  if (item.groupKind !== 'section') return false;
  if (item.sermonResourceId || item.sermonSectionId) return true;

  const hasSermonSignal = record => Boolean(
    record
    && (
      record.kind === 'sermon'
      || record.sermonResourceId
      || record.sermonSectionId
      || (record.kind === 'group'
        && ['sermon', 'point', 'subpoint'].includes(record.groupKind))
    )
  );
  const seenAncestors = new Set();
  let parentId = index.parentByItemId[item.id];
  while (parentId !== null && parentId !== undefined && !seenAncestors.has(parentId)) {
    seenAncestors.add(parentId);
    if (hasSermonSignal(project.items[parentId])) return true;
    parentId = index.parentByItemId[parentId];
  }

  const pending = [...item.childIds];
  const seenDescendants = new Set();
  while (pending.length > 0) {
    const childId = pending.shift();
    if (seenDescendants.has(childId)) continue;
    seenDescendants.add(childId);
    const child = project.items[childId];
    if (hasSermonSignal(child)) return true;
    if (child?.kind === 'group') pending.push(...child.childIds);
  }
  return false;
}

/**
 * Derive one path-free relationship between a saved service project and one
 * stable sermon identity.
 *
 * A project may contain many inherited sermon links beneath one direct owner.
 * Those links describe one service relationship, not one result per cue or
 * outline row. The result therefore selects the first direct resource owner in
 * service order as its navigable anchor, while retaining every exact sermon
 * revision pinned by direct owners so an unusual mixed-revision project is
 * never silently flattened. A resource owner always resolves its own exact
 * pin; an unlinked outer sermon group may not resolve a descendant-owned pin.
 *
 * This is a read-only projection. It does not add ServicePlan state to the
 * project, inspect private source records, or infer facts from presentation
 * files.
 */
function deriveSermonServiceRelationship(rawProject, rawSermonId) {
  const project = normalizeEditableServiceProject(rawProject);
  const sermonId = id(rawSermonId, 'Sermon id');
  const orderedItemIds = [];
  const visit = itemId => {
    orderedItemIds.push(itemId);
    const item = project.items[itemId];
    if (item.kind === 'group') item.childIds.forEach(visit);
  };
  project.rootItemIds.forEach(visit);
  const orderByItemId = new Map(
    orderedItemIds.map((itemId, index) => [itemId, index])
  );

  const linked = [];
  for (const itemId of orderedItemIds) {
    const item = project.items[itemId];
    if (!item || (item.kind !== 'group' && item.kind !== 'sermon')) continue;
    const resolved = resolveSermonSourceLink(project, item);
    if (!resolved || resolved.resource.document.id !== sermonId) continue;
    linked.push({
      itemId,
      resourceId: resolved.resourceId,
      resourceOwnerId: resolved.resourceOwnerId,
      sermonRevisionId: resolved.resource.sha256
    });
  }
  if (linked.length < 1) return null;

  const owners = new Map();
  for (const candidate of linked) {
    if (!owners.has(candidate.resourceOwnerId)) {
      owners.set(candidate.resourceOwnerId, {
        resourceOwnerId: candidate.resourceOwnerId,
        resourceId: candidate.resourceId,
        sermonRevisionId: candidate.sermonRevisionId,
        anchorItemId: candidate.resourceOwnerId
      });
    }
  }
  const orderedOwners = [...owners.values()].sort((left, right) =>
    (orderByItemId.get(left.anchorItemId) ?? Number.MAX_SAFE_INTEGER)
      - (orderByItemId.get(right.anchorItemId) ?? Number.MAX_SAFE_INTEGER)
    || (orderByItemId.get(left.resourceOwnerId) ?? Number.MAX_SAFE_INTEGER)
      - (orderByItemId.get(right.resourceOwnerId) ?? Number.MAX_SAFE_INTEGER)
    || left.resourceOwnerId.localeCompare(right.resourceOwnerId, 'en'));
  const selected = orderedOwners[0];
  const pinnedSermonRevisionIds = [...new Set(
    orderedOwners.map(owner => owner.sermonRevisionId)
  )];
  const sourceServiceSet = project.sourceServiceSet
    ? {
        id: project.sourceServiceSet.id,
        fingerprint: project.sourceServiceSet.fingerprint,
        serviceDate: project.sourceServiceSet.serviceDate,
        profileId: project.sourceServiceSet.profileId
      }
    : null;

  return deepFreeze({
    schemaVersion: 1,
    sermonId,
    sermonRevisionId: selected.sermonRevisionId,
    pinnedSermonRevisionIds,
    projectId: project.id,
    projectRevision: project.revision,
    projectTitle: project.title,
    serviceDate: project.serviceDate,
    updatedAt: project.updatedAt,
    profileId: project.preferredProfileId,
    workflowMode: project.workflowMode || 'native',
    anchorItemId: selected.anchorItemId,
    resourceOwnerId: selected.resourceOwnerId,
    sourceServiceSet,
    linkedItemCount: linked.length,
    resourceOwnerCount: orderedOwners.length
  });
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
  const projectServiceDate = isoDate(raw.serviceDate, 'Project serviceDate');
  const preferredProfileId = id(raw.preferredProfileId, 'Project preferredProfileId');
  let workflowMode = null;
  if (raw.workflowMode !== undefined) {
    if (raw.workflowMode !== POWERPOINT_COMPANION_WORKFLOW_MODE) {
      fail(
        'INVALID_WORKFLOW_MODE',
        `Project workflowMode must be omitted or ${POWERPOINT_COMPANION_WORKFLOW_MODE}.`
      );
    }
    workflowMode = POWERPOINT_COMPANION_WORKFLOW_MODE;
  }
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
  const planning = raw.planning === undefined
    ? null
    : normalizeServicePlanning(raw.planning, projectId, Object.keys(items));
  let sourceServiceSet = null;
  if (raw.sourceServiceSet !== undefined && raw.sourceServiceSet !== null) {
    if (!isRecord(raw.sourceServiceSet)) {
      fail('INVALID_SERVICE_SET_BINDING', 'The project service-set binding is invalid.');
    }
    if (Object.keys(raw.sourceServiceSet).some(key =>
      !['id', 'fingerprint', 'serviceDate', 'profileId'].includes(key))) {
      fail(
        'INVALID_SERVICE_SET_BINDING',
        'The project service-set binding contains unsupported fields.'
      );
    }
    sourceServiceSet = {
      id: id(raw.sourceServiceSet.id, 'Project service-set id'),
      fingerprint: SHA256_PATTERN.test(raw.sourceServiceSet.fingerprint || '')
        ? raw.sourceServiceSet.fingerprint
        : fail(
            'INVALID_SERVICE_SET_BINDING',
            'The project service-set fingerprint is invalid.'
          ),
      serviceDate: isoDate(
        raw.sourceServiceSet.serviceDate,
        'Project service-set serviceDate'
      ),
      profileId: id(
        raw.sourceServiceSet.profileId,
        'Project service-set profileId'
      )
    };
    if (
      sourceServiceSet.serviceDate !== projectServiceDate
      || sourceServiceSet.profileId !== preferredProfileId
    ) {
      fail(
        'SERVICE_SET_BINDING_MISMATCH',
        'The project service-set binding belongs to another date or venue profile.'
      );
    }
  }
  const normalized = {
    schemaVersion: SERVICE_PROJECT_SCHEMA_VERSION,
    kind: EDITABLE_PROJECT_KIND,
    id: projectId,
    title: text(raw.title, 'Project title', 200, { required: true }),
    serviceDate: projectServiceDate,
    createdAt: timestamp(raw.createdAt, 'Project createdAt', now.toISOString()),
    updatedAt: timestamp(raw.updatedAt, 'Project updatedAt', now.toISOString()),
    revision: finiteInteger(raw.revision, 'Project revision', 0, Number.MAX_SAFE_INTEGER, 0),
    preferredProfileId,
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
  if (workflowMode) normalized.workflowMode = workflowMode;
  if (sourceServiceSet) normalized.sourceServiceSet = sourceServiceSet;
  if (planning) normalized.planning = planning;
  for (const item of Object.values(items)) {
    if (!item.sourceVisualReview) continue;
    if (!sourceServiceSet) {
      fail(
        'SOURCE_VISUAL_REVIEW_SERVICE_SET_REQUIRED',
        `Picture item ${item.id} needs its exact reviewed service-set binding.`,
        { itemId: item.id }
      );
    }
    if (item.sourceVisualReview.serviceSetId !== sourceServiceSet.id
      || item.sourceVisualReview.serviceSetFingerprint
        !== sourceServiceSet.fingerprint) {
      fail(
        'SOURCE_VISUAL_REVIEW_SERVICE_SET_MISMATCH',
        `Picture item ${item.id} belongs to a different reviewed service set.`,
        {
          itemId: item.id,
          serviceSetId: item.sourceVisualReview.serviceSetId
        }
      );
    }
  }
  if (workflowMode === POWERPOINT_COMPANION_WORKFLOW_MODE) {
    if (!sourceServiceSet) {
      fail(
        'COMPANION_SERVICE_SET_REQUIRED',
        'A PowerPoint companion project must be bound to one exact reviewed service set.'
      );
    }
    const companionItems = Object.values(items);
    const projectedItemIds = companionItems
      .filter(item => item.kind !== 'group')
      .map(item => item.id);
    if (projectedItemIds.length > 0) {
      fail(
        'COMPANION_PROJECTED_ITEMS_NOT_ALLOWED',
        'A PowerPoint companion project can contain only nonprojected groups and resources.',
        { itemIds: projectedItemIds }
      );
    }
    if (Object.keys(assets).length > 0) {
      fail(
        'COMPANION_ASSETS_NOT_ALLOWED',
        'A PowerPoint companion project cannot contain native presentation assets.',
        { assetIds: Object.keys(assets) }
      );
    }
    const anchor = companionItems[0];
    if (
      companionItems.length !== 1
      || !anchor
      || anchor.kind !== 'group'
      || anchor.groupKind !== 'sermon'
      || anchor.childIds.length !== 0
      || rootItemIds.length !== 1
      || rootItemIds[0] !== anchor.id
    ) {
      fail(
        'COMPANION_SERMON_ANCHOR_REQUIRED',
        'A PowerPoint companion project must retain exactly one top-level sermon anchor.'
      );
    }
    const unsupportedResourceIds = Object.values(resources)
      .filter(resource => resource.kind !== 'sermon')
      .map(resource => resource.id);
    if (unsupportedResourceIds.length > 0) {
      fail(
        'COMPANION_SERMON_RESOURCES_ONLY',
        'A PowerPoint companion project can contain only sermon resources.',
        { resourceIds: unsupportedResourceIds }
      );
    }
  }
  const index = validateProjectTree(normalized);

  for (const item of Object.values(items)) {
    if (item.backgroundAssetId && assets[item.backgroundAssetId]?.kind !== 'image') fail('MISSING_ASSET', `Slide ${item.id} has no pinned background image.`);
    if (item.kind === 'bible' && item.sermonReading) {
      const resource = resources[item.sermonReading.sermonResourceId];
      if (!resource || resource.kind !== 'sermon') {
        fail(
          'MISSING_SERMON_READING_RESOURCE',
          `Bible item ${item.id} does not identify an embedded sermon revision.`,
          { itemId: item.id, resourceId: item.sermonReading.sermonResourceId }
        );
      }
      const reference = resource.document.references.find(candidate =>
        candidate.id === item.sermonReading.referenceId);
      if (
        !reference
        || reference.role !== 'primary'
        || reference.reviewStatus !== 'confirmed'
      ) {
        fail(
          'INVALID_SERMON_READING_REFERENCE',
          `Bible item ${item.id} must identify a confirmed primary passage in its exact sermon revision.`,
          {
            itemId: item.id,
            resourceId: item.sermonReading.sermonResourceId,
            referenceId: item.sermonReading.referenceId
          }
        );
      }
      if (!bibleRangeContains(reference.range, item.range)) {
        fail(
          'SERMON_READING_RANGE_MISMATCH',
          `Bible item ${item.id} is outside its reviewed primary sermon passage.`,
          { itemId: item.id, referenceId: reference.id }
        );
      }
      if (Array.isArray(item.sermonReading.outputs)) {
        for (const output of item.sermonReading.outputs) {
          const passage = item.passagesByChannel[output.channelId];
          if (output.mode === 'hidden') {
            if (passage) {
              fail(
                'SERMON_READING_OUTPUT_MISMATCH',
                `Bible item ${item.id} has text on hidden channel ${output.channelId}.`,
                { itemId: item.id, channelId: output.channelId }
              );
            }
            continue;
          }
          if (!passage || passage.translationId !== output.translationId) {
            fail(
              'SERMON_READING_OUTPUT_MISMATCH',
              `Bible item ${item.id} does not match its ${output.channelId} sermon-reading treatment.`,
              {
                itemId: item.id,
                channelId: output.channelId,
                translationId: output.translationId
              }
            );
          }
        }
      } else if (Object.values(item.passagesByChannel).some(passage =>
        passage.translationId !== item.sermonReading.translationId)) {
        fail(
          'SERMON_READING_TRANSLATION_MISMATCH',
          `Bible item ${item.id} does not use its reviewed sermon-reading translation.`,
          {
            itemId: item.id,
            translationId: item.sermonReading.translationId
          }
        );
      }
    } else if (item.kind === 'song') {
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
    } else if (item.kind === 'sermon'
      || (item.kind === 'group' && (item.sermonResourceId || item.sermonSectionId))) {
      const linked = resolveSermonSourceLink(normalized, item, index);
      if (item.kind === 'sermon') {
        validateSourceBodyProjection(normalized, item, index, linked);
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
    } else if (item.kind === 'video') {
      if (!assets[item.assetId] || assets[item.assetId].kind !== 'video') {
        fail('MISSING_ASSET', `Video item ${item.id} has no pinned video.`);
      }
      if (item.channelIds.some(channelId => !channelIds.includes(channelId))) {
        fail('UNKNOWN_PROJECT_CHANNEL', `Video item ${item.id} uses an unknown channel.`);
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
  if (normalized.workflowMode) {
    serializable.workflowMode = normalized.workflowMode;
  }
  if (normalized.sourceServiceSet) {
    serializable.sourceServiceSet = stableObject(normalized.sourceServiceSet);
  }
  if (normalized.planning) {
    serializable.planning = stableObject(normalized.planning);
  }
  return `${JSON.stringify(serializable, null, 2)}\n`;
}

/**
 * Domain mutations use this finalizer so a lifecycle decision cannot stay in
 * force after the planned content changes. Callers that edit raw project
 * fields directly must make the same explicit transition to "planning" with
 * setServicePlanStatus() before saving. "ready" describes editorial review
 * only; it does not claim a Show Package exists or has been installed in Load.
 */
function normalizeProjectContentMutation(rawProject, options = {}) {
  const next = deepClone(rawProject);
  if (next.planning) {
    if (next.planning.status !== 'planning') {
      next.planning.status = 'planning';
    }
    // A waiver records a human decision about one exact project revision.
    // Any content mutation invalidates that decision, even when the service was
    // already back in Planning.
    delete next.planning.readinessWaivers;
  }
  return normalizeEditableServiceProject(next, options);
}

function setServicePlanStatus(rawProject, rawStatus) {
  const project = normalizeEditableServiceProject(rawProject);
  if (!project.planning) {
    fail(
      'SERVICE_PLAN_REQUIRED',
      'Only a planned service has planning status.'
    );
  }
  const status = text(rawStatus, 'Project planning status', 20, { required: true });
  if (!SERVICE_PLAN_STATUSES.includes(status)) {
    fail(
      'INVALID_SERVICE_PLAN_STATUS',
      `Project planning status must be one of ${SERVICE_PLAN_STATUSES.join(', ')}.`,
      { status, allowed: SERVICE_PLAN_STATUSES }
    );
  }
  if (project.planning.status === status) return project;
  const next = deepClone(project);
  next.planning.status = status;
  return normalizeEditableServiceProject(next);
}

/**
 * Update operator-owned planning details without treating them as projected
 * content. Exact source provenance, when present, remains unchanged. Schedule/team-note
 * edits retain lifecycle status, while a changed readiness-waiver decision
 * intentionally reopens Ready to Planning. Waivers are canonicalized against
 * the analyzer's fixed contract.
 */
function updateServicePlanningDetails(rawProject, options = {}) {
  const project = normalizeEditableServiceProject(rawProject);
  if (!project.planning) {
    fail(
      'SERVICE_PLAN_REQUIRED',
      'Only a planned service has planning details.'
    );
  }
  if (!isRecord(options)) {
    fail(
      'INVALID_SERVICE_PLAN_DETAILS',
      'Service planning detail changes must be an object.'
    );
  }
  const allowedFields = [
    'startTime',
    'teamNotes',
    'readinessWaivers',
    'serving'
  ];
  const unexpected = Object.keys(options).filter(key =>
    !allowedFields.includes(key));
  if (unexpected.length > 0) {
    fail(
      'INVALID_SERVICE_PLAN_DETAILS',
      'Service planning detail changes contain unsupported fields.',
      { fields: unexpected.sort() }
    );
  }

  const next = deepClone(project);
  let changed = false;
  for (const field of allowedFields) {
    if (!Object.prototype.hasOwnProperty.call(options, field)
      || options[field] === undefined) {
      continue;
    }
    next.planning[field] = options[field];
    changed = true;
  }
  if (!changed) return project;

  const normalized = normalizeEditableServiceProject(next);
  if (JSON.stringify(normalized.planning) === JSON.stringify(project.planning)) {
    return project;
  }
  const waiverDecisionChanged =
    Object.prototype.hasOwnProperty.call(options, 'readinessWaivers')
    && options.readinessWaivers !== undefined
    && JSON.stringify(normalized.planning.readinessWaivers || [])
      !== JSON.stringify(project.planning.readinessWaivers || []);
  if (waiverDecisionChanged && project.planning.status === 'ready') {
    const reopened = deepClone(normalized);
    reopened.planning.status = 'planning';
    return normalizeEditableServiceProject(reopened);
  }
  return normalized;
}

/**
 * Change only one semantic item's local service-time allocation. Timing is a
 * planning detail rather than projected content, so it retains lifecycle
 * status and revision-specific readiness decisions just like a start-time
 * change. A null value explicitly clears the estimate; missing is never
 * normalized to zero.
 */
function updateProjectItemTiming(rawProject, options = {}) {
  const project = normalizeEditableServiceProject(rawProject);
  if (!project.planning) {
    fail(
      'SERVICE_PLAN_REQUIRED',
      'Only a planned service has item timing.'
    );
  }
  if (!isRecord(options)) {
    fail(
      'INVALID_PROJECT_ITEM_TIMING',
      'Service item timing changes must be an object.'
    );
  }
  const allowedFields = ['itemId', 'plannedDurationSeconds', 'now'];
  const unexpected = Object.keys(options).filter(key =>
    !allowedFields.includes(key));
  if (unexpected.length > 0) {
    fail(
      'INVALID_PROJECT_ITEM_TIMING',
      'Service item timing changes contain unsupported fields.',
      { fields: unexpected.sort() }
    );
  }
  if (!Object.prototype.hasOwnProperty.call(options, 'plannedDurationSeconds')
    || options.plannedDurationSeconds === undefined) {
    fail(
      'INVALID_PROJECT_ITEM_TIMING',
      'Service item timing requires plannedDurationSeconds or null to clear it.'
    );
  }

  const itemId = id(options.itemId, 'Project item id');
  const item = project.items[itemId];
  if (!item) {
    fail(
      'UNKNOWN_PROJECT_ITEM',
      `Project item ${itemId} does not exist.`
    );
  }
  const clearing = options.plannedDurationSeconds === null;
  const plannedDurationSeconds = clearing
    ? null
    : finiteInteger(
        options.plannedDurationSeconds,
        `Item ${itemId} plannedDurationSeconds`,
        0,
        MAX_PLANNED_ITEM_DURATION_SECONDS
      );
  const hasDuration = Object.prototype.hasOwnProperty.call(
    item,
    'plannedDurationSeconds'
  );
  if ((clearing && !hasDuration)
    || (!clearing
      && hasDuration
      && item.plannedDurationSeconds === plannedDurationSeconds)) {
    return project;
  }

  const next = deepClone(project);
  if (clearing) {
    delete next.items[itemId].plannedDurationSeconds;
  } else {
    next.items[itemId].plannedDurationSeconds = plannedDurationSeconds;
  }
  next.items[itemId].updatedAt = mutationTimestamp(
    options.now,
    'Item timing timestamp'
  );
  return normalizeEditableServiceProject(next);
}

/**
 * Add planning lifecycle metadata to a newly created native project without
 * manufacturing template or remote provenance. Ordinary createServiceProject
 * calls remain unplanned for backward compatibility; the New Service workflow
 * opts into this explicit local-created representation before its first save.
 */
function attachLocalServicePlanning(rawProject, options = {}) {
  const project = normalizeEditableServiceProject(rawProject);
  if (!isRecord(options)) {
    fail(
      'INVALID_SERVICE_PLAN',
      'Local service planning details must be an object.'
    );
  }
  const unexpected = Object.keys(options).filter(key =>
    !['startTime', 'teamNotes'].includes(key));
  if (unexpected.length > 0) {
    fail(
      'INVALID_SERVICE_PLAN',
      'Local service planning details contain unsupported fields.',
      { fields: unexpected.sort() }
    );
  }
  if (project.planning) {
    fail(
      'SERVICE_PLAN_ALREADY_ATTACHED',
      'This service project already has planning metadata.'
    );
  }
  if (project.workflowMode === POWERPOINT_COMPANION_WORKFLOW_MODE) {
    fail(
      'SERVICE_PLAN_SOURCE_NOT_NATIVE',
      'Local service planning requires a native SyncShow project.'
    );
  }
  const next = deepClone(project);
  next.planning = {
    schemaVersion: LOCAL_SERVICE_PLAN_SCHEMA_VERSION,
    status: 'planning',
    startTime: options.startTime,
    origin: LOCAL_SERVICE_PLAN_ORIGIN,
    ...(options.teamNotes !== undefined
      ? { teamNotes: options.teamNotes }
      : {})
  };
  return normalizeEditableServiceProject(next);
}

/**
 * Attach exact Community-plan provenance to a newly assembled offline native
 * project. The imported plan is metadata only: it does not authorize later
 * remote refreshes and it never changes Load or Show state.
 */
function attachCommunityServicePlanning(rawProject, options = {}) {
  const project = normalizeEditableServiceProject(rawProject);
  if (project.planning) {
    fail(
      'SERVICE_PLAN_ALREADY_ATTACHED',
      'This service project already has planning provenance.'
    );
  }
  if (project.workflowMode === POWERPOINT_COMPANION_WORKFLOW_MODE) {
    fail(
      'SERVICE_PLAN_SOURCE_NOT_NATIVE',
      'A Community plan must create a native SyncShow service project.'
    );
  }
  const importedAt = mutationTimestamp(
    options.importedAt || options.now,
    'Community plan import timestamp'
  );
  const next = deepClone(project);
  next.planning = {
    schemaVersion: LEGACY_COMMUNITY_SERVICE_PLAN_SCHEMA_VERSION,
    status: 'planning',
    startTime: options.startTime,
    ...(options.teamNotes !== undefined
      ? { teamNotes: options.teamNotes }
      : {}),
    source: {
      kind: COMMUNITY_SERVICE_PLAN_SOURCE_KIND,
      serverId: options.serverId,
      planId: options.planId,
      planRevision: options.planRevision,
      importedAt
    }
  };
  return normalizeEditableServiceProject(next, { now: new Date(importedAt) });
}

/**
 * Upgrade an imported Community plan to the portable reconciliation contract
 * after its exact native candidate has been assembled.
 */
function bindCommunityServicePlanBaseline(rawProject, rawBaseline) {
  const project = normalizeEditableServiceProject(rawProject);
  if (
    ![
      LEGACY_COMMUNITY_SERVICE_PLAN_SCHEMA_VERSION,
      COMMUNITY_SERVICE_PLAN_SCHEMA_VERSION
    ].includes(project.planning?.schemaVersion)
    || project.planning.source?.kind !== COMMUNITY_SERVICE_PLAN_SOURCE_KIND
  ) {
    fail(
      'COMMUNITY_SERVICE_PLAN_REQUIRED',
      'Only an imported Community Planning project can bind a Community baseline.'
    );
  }
  let baseline;
  try {
    baseline = normalizeConfiguredCommunityServicePlanBaseline(rawBaseline);
  } catch (error) {
    if (error?.name !== 'CommunityServicePlanBaselineError') throw error;
    fail(
      error.code || 'INVALID_COMMUNITY_PLAN_BASELINE',
      error.message,
      error.details
    );
  }
  if (baseline.planRevision !== project.planning.source.planRevision) {
    fail(
      'COMMUNITY_PLAN_BASELINE_REVISION_MISMATCH',
      'Community reconciliation baseline belongs to another plan revision.'
    );
  }
  if (
    project.planning.schemaVersion === COMMUNITY_SERVICE_PLAN_SCHEMA_VERSION
    && JSON.stringify(project.planning.reconciliationBaseline)
      === JSON.stringify(baseline)
  ) {
    return project;
  }
  const next = deepClone(project);
  next.planning.schemaVersion = COMMUNITY_SERVICE_PLAN_SCHEMA_VERSION;
  next.planning.reconciliationBaseline = baseline;
  return normalizeEditableServiceProject(next);
}

function createCommunityServicePlanReconciliationReceipt(raw) {
  if (
    !isRecord(raw)
    || ['schemaVersion', 'kind', 'receiptSha256'].some(field =>
      Object.prototype.hasOwnProperty.call(raw, field))
  ) {
    fail(
      'INVALID_COMMUNITY_RECONCILIATION_RECEIPT',
      'Create a reconciliation receipt from its unhashed receipt body.'
    );
  }
  const candidate = {
    schemaVersion: COMMUNITY_RECONCILIATION_RECEIPT_SCHEMA_VERSION,
    kind: COMMUNITY_RECONCILIATION_RECEIPT_KIND,
    ...deepClone(raw)
  };
  candidate.receiptSha256 =
    communityReconciliationReceiptSha256(candidate);
  return normalizeCommunityReconciliationReceipt(candidate);
}

function bindCommunityServicePlanReconciliationReceipt(
  rawProject,
  rawReceipt
) {
  const project = normalizeEditableServiceProject(rawProject);
  if (
    project.planning?.schemaVersion
      !== COMMUNITY_SERVICE_PLAN_SCHEMA_VERSION
    || project.planning.source?.kind !== COMMUNITY_SERVICE_PLAN_SOURCE_KIND
  ) {
    fail(
      'COMMUNITY_SERVICE_PLAN_REQUIRED',
      'Only a baseline-bound Community Planning project can retain a reconciliation receipt.'
    );
  }
  const receipt = normalizeCommunityReconciliationReceipt(rawReceipt);
  if (
    receipt.candidatePlanRevision
      !== project.planning.source.planRevision
    || receipt.candidateProjectionSha256
      !== project.planning.reconciliationBaseline.projectionSha256
    || receipt.appliedAt !== project.planning.source.importedAt
  ) {
    fail(
      'COMMUNITY_RECONCILIATION_RECEIPT_BINDING_MISMATCH',
      'Community reconciliation receipt belongs to another imported plan revision.'
    );
  }
  const next = deepClone(project);
  next.planning.lastReconciliationReceipt = receipt;
  return normalizeEditableServiceProject(next);
}

/**
 * Derive a new native planning project from one exact saved native revision.
 * Reusable project structure and the content-addressed records it still
 * reaches remain pinned. Every occurrence-specific sermon record is removed
 * fail-safe: sermon resources and leaves, generated sermon-reading Bible
 * items, direct sermon links, and the contents of sermon groups. The empty
 * sermon-group anchors remain reusable in the next service order. Orphaned
 * resources/assets are omitted so last week's private files do not hitchhike.
 */
function planNextServiceProject(rawSourceProject, options = {}) {
  const source = normalizeEditableServiceProject(rawSourceProject);
  if (source.workflowMode === POWERPOINT_COMPANION_WORKFLOW_MODE) {
    fail(
      'SERVICE_PLAN_SOURCE_NOT_NATIVE',
      'Plan next service requires a saved native SyncShow project, not a PowerPoint companion.'
    );
  }
  if (source.revision < 1) {
    fail(
      'SERVICE_PLAN_SOURCE_NOT_SAVED',
      'Plan next service requires an exact saved project revision.'
    );
  }
  const projectId = id(options.id, 'Planned service project id');
  if (projectId === source.id) {
    fail(
      'SERVICE_PLAN_ID_REUSED',
      'Plan next service requires a new project id distinct from the source template.'
    );
  }
  const title = text(options.title, 'Planned service title', 200, { required: true });
  const serviceDate = isoDate(options.serviceDate, 'Planned service date');
  const createdAt = mutationTimestamp(options.now, 'Planned service creation timestamp');
  const sourceRevisionId = crypto.createHash('sha256')
    .update(serializeEditableServiceProject(source))
    .digest('hex');

  const next = deepClone(source);
  next.id = projectId;
  next.title = title;
  next.serviceDate = serviceDate;
  next.createdAt = createdAt;
  next.updatedAt = createdAt;
  next.revision = 0;
  delete next.workflowMode;
  delete next.sourceServiceSet;
  delete next.planning;

  const removeItemIds = new Set();
  const collectDescendants = group => {
    for (const childId of group.childIds) {
      if (removeItemIds.has(childId)) continue;
      removeItemIds.add(childId);
      const child = source.items[childId];
      if (child?.kind === 'group') collectDescendants(child);
    }
  };
  for (const item of Object.values(source.items)) {
    if (item.kind === 'group' && item.groupKind === 'sermon') {
      collectDescendants(item);
    }
    if (item.kind === 'sermon'
      || (item.kind === 'bible' && item.sermonReading)) {
      removeItemIds.add(item.id);
    }
  }

  next.rootItemIds = next.rootItemIds.filter(itemId => !removeItemIds.has(itemId));
  for (const itemId of removeItemIds) delete next.items[itemId];
  for (const item of Object.values(next.items)) {
    const carriedSermonLink = Boolean(item.sermonResourceId || item.sermonSectionId);
    let changed = carriedSermonLink;
    delete item.sermonResourceId;
    delete item.sermonSectionId;
    if (item.kind === 'picture' && item.sourceVisualReview) {
      delete item.sourceVisualReview;
      changed = true;
    }
    if (item.kind === 'song' && item.sourceRangeReplacement) {
      delete item.sourceRangeReplacement;
      changed = true;
    }
    if (item.kind === 'group') {
      const retainedChildIds = item.childIds.filter(itemId => !removeItemIds.has(itemId));
      if (retainedChildIds.length !== item.childIds.length) changed = true;
      item.childIds = retainedChildIds;
      if (item.groupKind === 'sermon') {
        if (item.title !== 'Sermon' || item.operatorNotes || item.childIds.length > 0) {
          changed = true;
        }
        item.title = 'Sermon';
        item.childIds = [];
        item.operatorNotes = '';
      } else if (carriedSermonLink) {
        item.operatorNotes = '';
      }
    }
    if (changed) item.updatedAt = createdAt;
  }
  const reachableResourceIds = new Set();
  const reachableAssetIds = new Set();
  for (const item of Object.values(next.items)) {
    if (item.kind === 'song') {
      for (const variant of Object.values(item.variants)) {
        if (variant.mode === 'content') reachableResourceIds.add(variant.resourceId);
      }
    } else if (item.kind === 'picture') {
      if (item.assetIdsByChannel) {
        Object.values(item.assetIdsByChannel).forEach(assetId =>
          reachableAssetIds.add(assetId));
      } else {
        reachableAssetIds.add(item.assetId);
      }
    } else if (item.kind === 'video') {
      reachableAssetIds.add(item.assetId);
    } else if (item.kind === 'imported-deck') {
      Object.values(item.assetIdsByChannel).forEach(assetId =>
        reachableAssetIds.add(assetId));
    }
  }
  for (const resourceId of Object.keys(next.resources)) {
    if (!reachableResourceIds.has(resourceId)) delete next.resources[resourceId];
  }
  for (const assetId of Object.keys(next.assets)) {
    if (!reachableAssetIds.has(assetId)) delete next.assets[assetId];
  }

  next.planning = {
    schemaVersion: SERVICE_PLAN_SCHEMA_VERSION,
    status: 'planning',
    startTime: options.startTime,
    ...(options.teamNotes !== undefined ? { teamNotes: options.teamNotes } : {}),
    templateSource: {
      projectId: source.id,
      sourceRevisionId
    }
  };
  return normalizeEditableServiceProject(next, { now: new Date(createdAt) });
}

function bindProjectToServiceSet(rawProject, rawBinding) {
  const project = normalizeEditableServiceProject(rawProject);
  if (!isRecord(rawBinding)) {
    fail('INVALID_SERVICE_SET_BINDING', 'A reviewed service-set binding is required.');
  }
  const binding = {
    id: id(rawBinding.id, 'Project service-set id'),
    fingerprint: SHA256_PATTERN.test(rawBinding.fingerprint || '')
      ? rawBinding.fingerprint
      : fail(
          'INVALID_SERVICE_SET_BINDING',
          'The project service-set fingerprint is invalid.'
        ),
    serviceDate: isoDate(
      rawBinding.serviceDate,
      'Project service-set serviceDate'
    ),
    profileId: id(rawBinding.profileId, 'Project service-set profileId')
  };
  if (
    binding.serviceDate !== project.serviceDate
    || binding.profileId !== project.preferredProfileId
  ) {
    fail(
      'SERVICE_SET_BINDING_MISMATCH',
      'The reviewed service set belongs to another project date or venue profile.'
    );
  }
  if (
    project.sourceServiceSet
    && (
      project.sourceServiceSet.id !== binding.id
      || project.sourceServiceSet.fingerprint !== binding.fingerprint
    )
  ) {
    fail(
      'SERVICE_SET_BINDING_CONFLICT',
      'This project is already bound to a different reviewed service set.'
    );
  }
  if (project.sourceServiceSet) return project;
  const next = deepClone(project);
  next.sourceServiceSet = binding;
  return normalizeProjectContentMutation(next);
}

function bindProjectAsPowerPointCompanion(rawProject, rawBinding) {
  const bound = bindProjectToServiceSet(rawProject, rawBinding);
  if (bound.workflowMode === POWERPOINT_COMPANION_WORKFLOW_MODE) return bound;
  const next = deepClone(bound);
  next.workflowMode = POWERPOINT_COMPANION_WORKFLOW_MODE;
  return normalizeProjectContentMutation(next);
}

function isPowerPointCompanionProject(rawProject) {
  return normalizeEditableServiceProject(rawProject).workflowMode
    === POWERPOINT_COMPANION_WORKFLOW_MODE;
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
  if (project.workflowMode === POWERPOINT_COMPANION_WORKFLOW_MODE) {
    fail(
      'COMPANION_PROJECT_NOT_PUBLISHABLE',
      'This PowerPoint companion keeps its original presentations in Load and cannot be published as a native service.'
    );
  }
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
            ? { sourceChannelId: item.songPresentation?.primaryChannelId || resolved.sourceChannelId,
                sourceBlocks: [{ type: 'text', role: 'title', text: resolvedByChannel[item.songPresentation?.primaryChannelId || resolved.sourceChannelId].resource.document.title }] }
            : {}),
          blocks: presentationTitleBlocks(item, resolvedByChannel, channelId) || titleBlocks
        };
      }
      if (item.showTitle !== false) addCue(item, 'title', {
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
                ? { sourceChannelId: item.songPresentation?.primaryChannelId || resolved.sourceChannelId,
                    sourceBlocks: [{ type: 'text', role: 'lyrics', text: resolvedByChannel[item.songPresentation?.primaryChannelId || resolved.sourceChannelId].resource.document.sections.find(candidate => candidate.id === entry.sectionId).slides[slideIndex].lines.join('\n') }] }
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
        presetId: item.presetId,
        ...(item.sermonReading
          ? {
              sourceReference: {
                type: 'sermon-reading',
                id: project.resources[item.sermonReading.sermonResourceId].document.id,
                revision: project.resources[item.sermonReading.sermonResourceId].sha256,
                sectionId: null,
                referenceId: item.sermonReading.referenceId,
                ...(Array.isArray(item.sermonReading.outputs)
                  ? {
                      outputs: item.sermonReading.outputs
                        .map(output => ({ ...output }))
                        .sort((left, right) =>
                          left.channelId.localeCompare(right.channelId, 'en'))
                    }
                  : { translationId: item.sermonReading.translationId }),
                chunkIndex: item.sermonReading.chunkIndex,
                chunkCount: item.sermonReading.chunkCount
              }
            }
          : {})
      });
      return;
    }

    if (item.kind === 'sermon' || item.kind === 'notice') {
      const sermonSource = item.kind === 'sermon'
        ? resolveSermonSourceLink(project, item, index)
        : null;
      const channels = {};
      for (const channelId of project.channelIds) {
        const projectionSource =
          item.kind === 'sermon'
          && item.sourceBodyProjection?.schemaVersion
            === SOURCE_BODY_PROJECTION_SCHEMA_VERSION_V2
            ? item.sourceBodyProjection.channels[channelId]
            : null;
        channels[channelId] = item.textByChannel[channelId]
          || (item.sermonTemplate && Object.prototype.hasOwnProperty.call(item.textByChannel, channelId))
          ? {
              mode: projectionSource?.mode === 'condensed'
                ? 'condensed'
                : 'content',
              blocks: sermonSlideBlocks(item, channelId)
            }
          : { mode: 'hide', blocks: [] };
      }
      addCue(item, 'self', {
        kind: item.kind,
        title: item.title,
        groupPath,
        channels,
        operatorNotes: item.operatorNotes,
        presetId: item.presetId,
        ...(sermonSource
          ? {
              sourceReference: {
                type: 'sermon-library',
                id: sermonSource.resource.document.id,
                revision: sermonSource.resource.sha256,
                sectionId: sermonSource.sectionId
              }
            }
          : {})
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

    if (item.kind === 'video') {
      const channels = Object.fromEntries(project.channelIds.map(channelId => [
        channelId,
        item.channelIds.includes(channelId)
          ? {
              mode: 'content',
              blocks: [{
                type: 'video',
                assetId: item.assetId,
                fit: item.fit,
                muted: channelId !== item.audioChannelId
              }]
            }
          : { mode: 'hide', blocks: [] }
      ]));
      addCue(item, 'self', {
        kind: 'video',
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
  return { project: normalizeProjectContentMutation(next), resourceId };
}

/**
 * Build the deterministic starting routing for a newly pinned song. Output
 * labels are presentation-only and never imply Singer, stage, or translation
 * behavior: `primary` wins when configured, otherwise channel order does.
 */
function createDefaultSongChannelVariants(rawProject, rawResourceId) {
  const project = normalizeEditableServiceProject(rawProject);
  const resourceId = text(
    rawResourceId,
    'Default song resource id',
    80,
    { required: true }
  );
  const resource = project.resources[resourceId];
  if (!resource || resource.kind !== 'song') {
    fail(
      'MISSING_RESOURCE',
      'The default song treatment needs an exact pinned song resource.',
      { resourceId }
    );
  }
  const sourceChannelId = project.channelIds.includes('primary')
    ? 'primary'
    : project.channelIds[0];
  const variants = {};
  for (const channelId of project.channelIds) {
    variants[channelId] = channelId === sourceChannelId
      ? { mode: 'content', resourceId }
      : { mode: 'inherit', from: sourceChannelId };
  }
  return deepFreeze({ sourceChannelId, variants });
}

function embedSermonResource(rawProject, rawSermon, origin = null, {
  contentMutation = true
} = {}) {
  const project = normalizeEditableServiceProject(rawProject);
  const document = normalizeSermonDocument(rawSermon);
  const canonical = serializeSermonDocument(document);
  const sha256 = crypto.createHash('sha256').update(canonical).digest('hex');
  const resourceId = `sha256:${sha256}`;
  const next = deepClone(project);
  next.resources[resourceId] = {
    id: resourceId,
    kind: 'sermon',
    schemaVersion: document.schemaVersion,
    mediaType: 'application/vnd.syncshow.sermon+json',
    size: Buffer.byteLength(canonical, 'utf8'),
    sha256,
    origin: origin || { provider: 'local-sermon-library', itemId: document.id },
    document
  };
  return {
    project: contentMutation
      ? normalizeProjectContentMutation(next)
      : normalizeEditableServiceProject(next),
    resourceId
  };
}

function addSermonResource(rawProject, rawSermon, origin = null) {
  return embedSermonResource(rawProject, rawSermon, origin);
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
  return normalizeProjectContentMutation(next);
}

/**
 * Replace one exact contiguous run of untouched leaf pictures with one
 * semantic item. The caller supplies the reviewed parent/index as stale-state
 * evidence; this mutation never searches for a "close enough" placement.
 */
function replaceProjectItemRange(rawProject, rawItem, options = {}) {
  const project = normalizeEditableServiceProject(rawProject);
  const itemIds = normalizeUniqueIds(
    options.itemIds || [],
    'Project replacement itemIds',
    MAX_PROJECT_ITEMS
  );
  if (itemIds.length < 1) {
    fail(
      'EMPTY_PROJECT_ITEM_RANGE',
      'Choose at least one reviewed picture to replace.'
    );
  }
  const parentId = options.parentId === null || options.parentId === undefined
    ? null
    : id(options.parentId, 'Project replacement parent id');
  const siblings = parentId === null
    ? project.rootItemIds
    : project.items[parentId]?.kind === 'group'
      ? project.items[parentId].childIds
      : null;
  if (!siblings) {
    fail(
      'INVALID_PROJECT_ITEM_RANGE_PARENT',
      'The reviewed picture range no longer has the same parent.'
    );
  }
  const startIndex = finiteInteger(
    options.index,
    'Project replacement start index',
    0,
    Math.max(0, siblings.length - 1)
  );
  const exactRange = siblings.slice(startIndex, startIndex + itemIds.length);
  if (
    exactRange.length !== itemIds.length
    || exactRange.some((itemId, index) => itemId !== itemIds[index])
  ) {
    fail(
      'PROJECT_ITEM_RANGE_CHANGED',
      'The reviewed picture range moved or changed order.',
      { parentId, startIndex, itemIds }
    );
  }

  const candidateAssetIds = new Set();
  for (const itemId of itemIds) {
    const source = project.items[itemId];
    if (
      !source
      || source.kind !== 'picture'
      || project._index.parentByItemId[itemId] !== parentId
      || !source.sourceVisualReview
    ) {
      fail(
        'INVALID_PROJECT_ITEM_RANGE',
        'Only untouched reviewed PowerPoint pictures can be replaced as one range.',
        { itemId, parentId }
      );
    }
    if (source.assetIdsByChannel) {
      Object.values(source.assetIdsByChannel).forEach(assetId =>
        candidateAssetIds.add(assetId));
    } else {
      candidateAssetIds.add(source.assetId);
    }
  }

  const replacement = normalizeProjectItem(
    rawItem,
    project.channelIds,
    new Date(options.now || Date.now())
  );
  if (project.items[replacement.id]) {
    fail(
      'DUPLICATE_ITEM_ID',
      `Project item ${replacement.id} already exists.`
    );
  }

  const next = deepClone(project);
  const nextSiblings = parentId === null
    ? next.rootItemIds
    : next.items[parentId].childIds;
  nextSiblings.splice(startIndex, itemIds.length, replacement.id);
  for (const itemId of itemIds) delete next.items[itemId];
  next.items[replacement.id] = replacement;
  return pruneUnreachableProjectRecords(next, {
    assetIds: [...candidateAssetIds],
    servingItemRebindings: Object.fromEntries(
      itemIds.map(itemId => [itemId, replacement.id])
    )
  });
}

/**
 * Replace one exact native song occurrence without moving its service slot.
 * The replacement receives a fresh item identity from the trusted caller, so
 * its Cue identities cannot be confused with the removed song. Only
 * content-addressed song resources that became unreachable are pruned; shared
 * originals or translations remain available to every surviving occurrence
 * and to immutable history.
 */
function replaceSongItem(rawProject, rawItemId, rawReplacementItem, options = {}) {
  const project = normalizeEditableServiceProject(rawProject);
  const source = requireProjectItem(project, rawItemId, ['song']);
  const replacementInput = isRecord(rawReplacementItem)
    ? deepClone(rawReplacementItem)
    : rawReplacementItem;
  if (isRecord(replacementInput)
    && !Object.prototype.hasOwnProperty.call(
    replacementInput,
    'plannedDurationSeconds'
  ) && Object.prototype.hasOwnProperty.call(source, 'plannedDurationSeconds')) {
    replacementInput.plannedDurationSeconds = source.plannedDurationSeconds;
  }
  const replacement = normalizeProjectItem(
    replacementInput,
    project.channelIds,
    new Date(options.now || Date.now())
  );
  if (replacement.kind !== 'song') {
    fail(
      'INVALID_SONG_REPLACEMENT',
      'A native song can only be replaced with another native song.'
    );
  }
  if (replacement.id === source.id) {
    fail(
      'SONG_REPLACEMENT_ID_REUSED',
      'A replacement song must receive a fresh project item identity.'
    );
  }
  if (project.items[replacement.id]) {
    fail(
      'DUPLICATE_ITEM_ID',
      `Project item ${replacement.id} already exists.`
    );
  }

  const parentId = project._index.parentByItemId[source.id];
  const siblings = parentId === null
    ? project.rootItemIds
    : project.items[parentId].childIds;
  const sourceIndex = siblings.indexOf(source.id);
  if (sourceIndex < 0) {
    fail(
      'ORPHAN_PROJECT_ITEM',
      `Project item ${source.id} was not in the service order.`
    );
  }

  const candidateResourceIds = new Set();
  for (const variant of Object.values(source.variants)) {
    if (variant.mode === 'content') candidateResourceIds.add(variant.resourceId);
  }

  const next = deepClone(project);
  const nextSiblings = parentId === null
    ? next.rootItemIds
    : next.items[parentId].childIds;
  nextSiblings.splice(sourceIndex, 1, replacement.id);
  delete next.items[source.id];
  next.items[replacement.id] = replacement;
  return pruneUnreachableProjectRecords(next, {
    resourceIds: [...candidateResourceIds],
    servingItemRebindings: {
      [source.id]: replacement.id
    }
  });
}

/**
 * Remove candidate content-addressed records that the editable semantic item
 * graph no longer reaches. Candidate scoping avoids sweeping unrelated
 * pre-pinned/import-only records during an otherwise focused mutation. This
 * only changes the project document; immutable historical revisions and
 * physical blobs remain available for Undo/Redo.
 */
function pruneUnreachableProjectRecords(rawProject, candidates = {}, {
  preserveTerminalPlanning = false
} = {}) {
  let projectInput = rawProject;
  if (rawProject?.planning?.serving) {
    projectInput = deepClone(rawProject);
    const itemIds = Object.keys(projectInput.items || {});
    try {
      const rebindings = candidates.servingItemRebindings;
      projectInput.planning.serving = rebindings
        ? rebindServiceProjectServingItemScopes(
            projectInput.planning.serving,
            rebindings,
            { itemIds }
          )
        : pruneMissingServiceProjectServingItemScopes(
            projectInput.planning.serving,
            { itemIds }
          );
    } catch (error) {
      if (!(error instanceof ServiceProjectServingError)) throw error;
      fail(error.code, error.message, error.details);
    }
  }
  const project = normalizeEditableServiceProject(projectInput);
  const reachableResources = new Set();
  const reachableAssets = new Set();
  for (const item of Object.values(project.items)) {
    if (item.backgroundAssetId) reachableAssets.add(item.backgroundAssetId);
    if (item.sermonResourceId) reachableResources.add(item.sermonResourceId);
    if (item.kind === 'bible' && item.sermonReading) {
      reachableResources.add(item.sermonReading.sermonResourceId);
    }
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
    } else if (item.kind === 'video') {
      reachableAssets.add(item.assetId);
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
  if (Array.isArray(
    next.planning?.localCollisionBoundaryItemIds
  )) {
    const retainedBoundaryItemIds =
      next.planning.localCollisionBoundaryItemIds.filter(itemId =>
        Object.prototype.hasOwnProperty.call(next.items, itemId));
    if (retainedBoundaryItemIds.length > 0) {
      next.planning.localCollisionBoundaryItemIds =
        retainedBoundaryItemIds;
    } else {
      delete next.planning.localCollisionBoundaryItemIds;
    }
  }
  return preserveTerminalPlanning
    && ['completed', 'needs-follow-up'].includes(next.planning?.status)
    ? normalizeEditableServiceProject(next)
    : normalizeProjectContentMutation(next);
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
    if (item.backgroundAssetId) assetIds.add(item.backgroundAssetId);
    if (item.kind === 'group') item.childIds.forEach(collect);
    if (item.sermonResourceId) resourceIds.add(item.sermonResourceId);
    if (item.kind === 'bible' && item.sermonReading) {
      resourceIds.add(item.sermonReading.sermonResourceId);
    }
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
    } else if (item.kind === 'video') {
      assetIds.add(item.assetId);
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
    ...(options.sermonResourceId !== undefined
      ? { sermonResourceId: options.sermonResourceId }
      : {}),
    ...(options.sermonSectionId !== undefined
      ? { sermonSectionId: options.sermonSectionId }
      : {}),
    operatorNotes: options.operatorNotes || '',
    ...(options.plannedDurationSeconds !== undefined
      ? { plannedDurationSeconds: options.plannedDurationSeconds }
      : {}),
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
  return normalizeProjectContentMutation(next);
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
 * Link a semantic sermon group or projected sermon cue to an exact immutable
 * SermonDocument revision. A null value explicitly clears one direct field;
 * omitted fields retain their current value and may continue to inherit from
 * an ancestor sermon group.
 */
function setSermonSourceLink(rawProject, options = {}) {
  const project = normalizeEditableServiceProject(rawProject);
  const item = requireProjectItem(project, options.itemId, ['group', 'sermon']);
  const hasResourceChange = Object.prototype.hasOwnProperty.call(options, 'sermonResourceId')
    && options.sermonResourceId !== undefined;
  const hasSectionChange = Object.prototype.hasOwnProperty.call(options, 'sermonSectionId')
    && options.sermonSectionId !== undefined;
  if (!hasResourceChange && !hasSectionChange) {
    fail(
      'MISSING_SERMON_LINK_CHANGE',
      'Choose a sermon revision, a sermon section, or explicitly clear one of those links.'
    );
  }

  const source = deepClone(item);
  const previousResourceId = source.sermonResourceId || null;
  if (hasResourceChange) {
    if (options.sermonResourceId === null) delete source.sermonResourceId;
    else source.sermonResourceId = options.sermonResourceId;
  }
  if (hasSectionChange) {
    if (options.sermonSectionId === null) delete source.sermonSectionId;
    else source.sermonSectionId = options.sermonSectionId;
  }
  if (
    source.kind === 'sermon'
    && source.sourceBodyProjection
    && (
      (hasResourceChange
        && (item.sermonResourceId || null) !== (source.sermonResourceId || null))
      || (hasSectionChange
        && (item.sermonSectionId || null) !== (source.sermonSectionId || null))
    )
  ) {
    delete source.sourceBodyProjection;
  }
  const updatedAt = mutationTimestamp(options.now, 'Sermon source-link update timestamp');
  const candidate = normalizeProjectItem({
    ...source,
    updatedAt
  }, project.channelIds, new Date(updatedAt));
  const directLinkChanged = (
    (hasResourceChange
      && (item.sermonResourceId || null) !== (candidate.sermonResourceId || null))
    || (hasSectionChange
      && (item.sermonSectionId || null) !== (candidate.sermonSectionId || null))
  );
  let replaced;
  if (candidate.kind === 'group' && directLinkChanged) {
    const next = deepClone(project);
    next.items[candidate.id] = candidate;
    const pending = [...candidate.childIds];
    while (pending.length > 0) {
      const descendant = next.items[pending.shift()];
      if (!descendant) continue;
      if (descendant.kind === 'group') pending.push(...descendant.childIds);
      if (descendant.kind === 'sermon' && descendant.sourceBodyProjection) {
        delete descendant.sourceBodyProjection;
      }
    }
    replaced = normalizeProjectContentMutation(next);
  } else {
    replaced = replaceProjectItem(project, candidate);
  }
  return previousResourceId && previousResourceId !== candidate.sermonResourceId
    ? pruneUnreachableProjectRecords(replaced, { resourceIds: [previousResourceId] })
    : replaced;
}

function prepareSermonRevisionRepin(rawProject, options = {}) {
  const project = normalizeEditableServiceProject(rawProject);
  const previousResourceId = text(
    options.previousResourceId,
    'Previous sermon resource id',
    80,
    { required: true }
  );
  const nextResourceId = text(
    options.nextResourceId,
    'Next sermon resource id',
    80,
    { required: true }
  );
  if (!ASSET_ID_PATTERN.test(previousResourceId)
    || !ASSET_ID_PATTERN.test(nextResourceId)) {
    fail(
      'INVALID_SERMON_RESOURCE_REFERENCE',
      'Sermon revision repins require exact content-addressed resources.'
    );
  }
  if (previousResourceId === nextResourceId) {
    return {
      project,
      previousResourceId,
      nextResourceId,
      previousResource: null,
      nextResource: null,
      unchanged: true
    };
  }

  const previousResource = project.resources[previousResourceId];
  const nextResource = project.resources[nextResourceId];
  if (previousResource?.kind !== 'sermon' || nextResource?.kind !== 'sermon') {
    fail(
      'MISSING_SERMON_RESOURCE',
      'Both sermon revisions must be embedded before they can be repinned.'
    );
  }
  if (previousResource.document.id !== nextResource.document.id) {
    fail(
      'SERMON_REPIN_ID_MISMATCH',
      'A service cannot repin sermon provenance to a different sermon.'
    );
  }
  return {
    project,
    previousResourceId,
    nextResourceId,
    previousResource,
    nextResource,
    unchanged: false
  };
}

function applySermonRevisionRepin(prepared, options = {}, {
  preserveTerminalPlanning = false
} = {}) {
  const {
    project,
    previousResourceId,
    nextResourceId,
    previousResource,
    nextResource
  } = prepared;
  const previousReferences = new Map(
    previousResource.document.references.map(reference => [reference.id, reference])
  );
  const nextReferences = new Map(
    nextResource.document.references.map(reference => [reference.id, reference])
  );
  const nextOutlineIds = new Set(
    nextResource.document.outline.map(section => section.id)
  );
  let changed = false;
  let directLinksChanged = 0;
  const now = mutationTimestamp(options.now, 'Sermon revision repin timestamp');
  const next = deepClone(project);
  for (const item of Object.values(next.items)) {
    let itemChanged = false;
    if (
      item.kind === 'sermon'
      && item.sourceBodyProjection
      && resolveSermonSourceLink(
        project,
        project.items[item.id],
        project._index
      )?.resourceId === previousResourceId
    ) {
      delete item.sourceBodyProjection;
      itemChanged = true;
    }
    if (item.sermonResourceId === previousResourceId) {
      if (item.sermonSectionId && !nextOutlineIds.has(item.sermonSectionId)) {
        fail(
          'SERMON_REPIN_SECTION_MISMATCH',
          `Sermon section ${item.sermonSectionId} is not present in the replacement revision.`,
          { itemId: item.id, sectionId: item.sermonSectionId }
        );
      }
      item.sermonResourceId = nextResourceId;
      directLinksChanged += 1;
      itemChanged = true;
    }
    if (
      item.kind === 'bible'
      && item.sermonReading?.sermonResourceId === previousResourceId
    ) {
      const previousReference = previousReferences.get(item.sermonReading.referenceId);
      const nextReference = nextReferences.get(item.sermonReading.referenceId);
      if (
        !previousReference
        || !nextReference
        || previousReference.role !== 'primary'
        || nextReference.role !== 'primary'
        || previousReference.reviewStatus !== 'confirmed'
        || nextReference.reviewStatus !== 'confirmed'
        || !bibleRangesEqual(previousReference.range, nextReference.range)
      ) {
        fail(
          'SERMON_REPIN_READING_MISMATCH',
          'The replacement sermon revision changed a passage used by a generated congregational reading.',
          {
            itemId: item.id,
            referenceId: item.sermonReading.referenceId
          }
        );
      }
      item.sermonReading.sermonResourceId = nextResourceId;
      itemChanged = true;
    }
    if (itemChanged) {
      item.updatedAt = now;
      changed = true;
    }
  }
  if (!changed) {
    fail(
      'SERMON_REPIN_NOT_REFERENCED',
      'The previous sermon revision is not used by this service.'
    );
  }
  if (directLinksChanged < 1) {
    fail(
      'SERMON_REPIN_OWNER_MISSING',
      'A sermon revision repin must retain at least one direct sermon resource owner.'
    );
  }
  const terminalPlanningStatus = next.planning?.status;
  const normalized = preserveTerminalPlanning
    && ['completed', 'needs-follow-up'].includes(terminalPlanningStatus)
    ? normalizeEditableServiceProject(next, { now })
    : normalizeProjectContentMutation(next, { now });
  return pruneUnreachableProjectRecords(
    normalized,
    { resourceIds: [previousResourceId] },
    { preserveTerminalPlanning }
  );
}

/**
 * Move every live reference to one exact sermon revision onto a compatible
 * replacement revision as one semantic project mutation. Direct sermon owners
 * move together with generated Scripture-reading provenance. A generated
 * reading moves only when the same confirmed-primary reference id and canonical
 * range remain present, so source and reviewed-extraction updates cannot
 * silently change the passage the congregation will read.
 */
function repinSermonRevision(rawProject, options = {}) {
  const prepared = prepareSermonRevisionRepin(rawProject, options);
  if (prepared.unchanged) return prepared.project;
  return applySermonRevisionRepin(prepared, options);
}

/**
 * Apply the general sermon-revision repin only after proving that the change is
 * limited to post-service metadata. This stricter wrapper keeps that workflow
 * from changing sermon content, audience, sources, references, or outline.
 */
function repinCompatibleSermonRevision(rawProject, options = {}) {
  const prepared = prepareSermonRevisionRepin(rawProject, options);
  if (prepared.unchanged) return prepared.project;
  const {
    previousResource,
    nextResource
  } = prepared;
  const repinInvariantShape = document => ({
    ...document,
    media: document.media.filter(media =>
      !media.id.startsWith('post-service:')),
    publication: {
      visibility: document.publication.visibility
    }
  });
  if (JSON.stringify(repinInvariantShape(previousResource.document))
    !== JSON.stringify(repinInvariantShape(nextResource.document))) {
    fail(
      'SERMON_REPIN_CONTENT_MISMATCH',
      'A metadata-only sermon repin cannot change sermon content, audience, sources, references, outline, or unrelated media.'
    );
  }
  return applySermonRevisionRepin(prepared, options, {
    preserveTerminalPlanning: true
  });
}

/**
 * Add and repin one post-service sermon revision as a single proven metadata
 * mutation. The temporary unreferenced resource is normalized without making
 * a lifecycle decision; terminal planning state is retained only after the
 * compatibility proof succeeds. Ordinary resource additions and general
 * sermon repins continue to reopen the service in Planning.
 */
function repinCompatibleSermonDocument(rawProject, rawSermon, options = {}) {
  const embedded = embedSermonResource(
    rawProject,
    rawSermon,
    options.origin || null,
    { contentMutation: false }
  );
  return {
    project: repinCompatibleSermonRevision(embedded.project, {
      previousResourceId: options.previousResourceId,
      nextResourceId: embedded.resourceId,
      now: options.now
    }),
    resourceId: embedded.resourceId
  };
}

function textVariantMapsEqual(left, right) {
  if (!isRecord(left) || !isRecord(right)) return false;
  const leftChannelIds = Object.keys(left);
  const rightChannelIds = Object.keys(right);
  return leftChannelIds.length === rightChannelIds.length
    && leftChannelIds.every(channelId =>
      Object.prototype.hasOwnProperty.call(right, channelId)
      && left[channelId] === right[channelId]);
}

function retainedSourceBodyProjection(
  projection,
  originalTextByChannel,
  replacementTextByChannel
) {
  if (!isRecord(replacementTextByChannel)) return null;
  const channels = {};
  for (const [channelId, source] of Object.entries(projection.channels)) {
    if (
      !Object.prototype.hasOwnProperty.call(replacementTextByChannel, channelId)
      || replacementTextByChannel[channelId] !== originalTextByChannel[channelId]
    ) {
      continue;
    }
    channels[channelId] =
      projection.schemaVersion === SOURCE_BODY_PROJECTION_SCHEMA_VERSION
        ? {
            mode: 'exact',
            bodyEntryId: source.bodyEntryId,
            bodyEntrySha256: source.bodyEntrySha256,
            paragraphId: source.paragraphId,
            startOffset: source.startOffset,
            endOffset: source.endOffset,
            sourceTextSha256: source.textSha256,
            projectedTextSha256: source.textSha256
          }
        : deepClone(source);
  }
  if (Object.keys(channels).length < 1) return null;
  return {
    schemaVersion: SOURCE_BODY_PROJECTION_SCHEMA_VERSION_V2,
    kind: projection.kind,
    proposalId: projection.proposalId,
    rowId: projection.rowId,
    anchorItemId: projection.anchorItemId,
    sermonId: projection.sermonId,
    sermonRevisionId: projection.sermonRevisionId,
    channels
  };
}

/**
 * Edit a sermon/notice leaf in place. The caller supplies the complete desired
 * channel map so removing an override is explicit, while the project validator
 * continues to reject unknown outputs and empty text variants. Inline spans
 * are likewise a complete desired map when supplied; null clears every span.
 * If omitted, spans survive only channels whose authoritative text is byte
 * identical so an ordinary text edit can never reuse stale offsets. Reviewed
 * sermon-body evidence follows the same channel-local rule; a partial edit
 * upgrades any retained legacy evidence to the subset-capable v2 receipt.
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
  if (
    source.kind === 'sermon'
    && source.sourceBodyProjection
    && options.textByChannel !== undefined
    && !textVariantMapsEqual(options.textByChannel, item.textByChannel)
  ) {
    const retainedProjection = retainedSourceBodyProjection(
      source.sourceBodyProjection,
      item.textByChannel,
      options.textByChannel
    );
    if (retainedProjection) {
      source.sourceBodyProjection = retainedProjection;
    } else {
      delete source.sourceBodyProjection;
    }
  }
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
  const source = deepClone(item);
  if (source.kind === 'picture') delete source.sourceVisualReview;
  if (source.kind === 'song') delete source.sourceRangeReplacement;
  const candidate = normalizeProjectItem({
    ...source,
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
  const source = deepClone(item);
  delete source.sourceVisualReview;
  const candidate = normalizeProjectItem({
    ...source,
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
  const sermonOwnerItemIds = subtreeIds.filter(itemId => {
    const item = project.items[itemId];
    return item.sermonResourceId && ['group', 'sermon'].includes(item.kind);
  });
  if (sermonOwnerItemIds.length > 0) {
    fail(
      'SERMON_OWNER_DUPLICATION_REQUIRES_EXPLICIT_REPIN',
      'A linked sermon packet cannot be duplicated as ordinary project content. Add the next sermon packet explicitly or pin a distinct exact sermon revision.',
      {
        itemId: source.id,
        sermonOwnerItemIds
      }
    );
  }

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
    video: 'video',
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
      delete copied.sourceRangeReplacement;
      copied.arrangement = original.arrangement.map(entry => ({
        id: duplicateId('arr', randomUUID, usedIds),
        sectionId: entry.sectionId
      }));
    }
    if (copied.kind === 'bible' && copied.sermonReading) {
      delete copied.sermonReading;
    }
    if (copied.kind === 'picture') {
      delete copied.sourceVisualReview;
    }
    if (copied.kind === 'sermon') {
      delete copied.sourceBodyProjection;
    }
    next.items[copied.id] = normalizeProjectItem(copied, project.channelIds, new Date(now));
  }
  const nextSiblings = targetParentId === null
    ? next.rootItemIds
    : next.items[targetParentId].childIds;
  nextSiblings.splice(targetIndex, 0, itemIdMap.get(source.id));
  return normalizeProjectContentMutation(next);
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
  const source = deepClone(item);
  delete source.sourceRangeReplacement;
  const candidate = normalizeProjectItem({
    ...source,
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
  return normalizeProjectContentMutation(next);
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
  delete next.items[item.id].sourceRangeReplacement;
  next.items[item.id].updatedAt = mutationTimestamp(options.now, 'Song translation update timestamp');
  return pruneUnreachableProjectRecords(next, {
    resourceIds: previousResourceId ? [previousResourceId] : []
  });
}

/**
 * Set one non-authoritative song output to an explicit presentation treatment.
 * The renderer-facing contract names the derived behavior "derive-next-text";
 * ServiceProject keeps the existing schema-v1 "derive" representation.
 *
 * Superseded direct content is pruned only when no other item/channel reaches
 * it. An exact repeat returns the normalized input unchanged so the project
 * store can preserve its current immutable revision.
 */
function setSongChannelTreatment(rawProject, options = {}) {
  const project = normalizeEditableServiceProject(rawProject);
  const item = requireSongItem(project, options.itemId);
  const channelId = id(options.channelId, 'Song channel id');
  if (!project.channelIds.includes(channelId)) {
    fail('UNKNOWN_PROJECT_CHANNEL', `Project channel ${channelId} does not exist.`);
  }
  const primary = authoritativeSongSource(project, item);
  if (channelId === primary.channelId) {
    fail(
      'PRIMARY_SONG_CHANNEL',
      'The primary song channel must keep its exact pinned content.'
    );
  }
  const mode = text(
    options.mode,
    'Song output treatment',
    32,
    { required: true }
  );
  if (!['inherit', 'derive-next-text', 'hidden'].includes(mode)) {
    fail(
      'INVALID_SONG_TREATMENT',
      'A song output treatment must inherit, derive next text, or stay hidden.',
      { mode }
    );
  }
  let sourceChannelId = null;
  if (mode === 'hidden') {
    if (options.sourceChannelId !== undefined
      && options.sourceChannelId !== null
      && options.sourceChannelId !== '') {
      fail(
        'INVALID_SONG_TREATMENT',
        'A hidden song output cannot identify a source output.'
      );
    }
  } else {
    if (options.sourceChannelId === undefined
      || options.sourceChannelId === null
      || options.sourceChannelId === '') {
      fail(
        'MISSING_SONG_TREATMENT_SOURCE',
        'Choose the exact source output for this song treatment.'
      );
    }
    sourceChannelId = id(options.sourceChannelId, 'Song treatment source channel id');
    if (!project.channelIds.includes(sourceChannelId)) {
      fail(
        'UNKNOWN_PROJECT_CHANNEL',
        `Project channel ${sourceChannelId} does not exist.`
      );
    }
    if (sourceChannelId === channelId) {
      fail(
        'CHANNEL_INHERITANCE_CYCLE',
        `Song output ${channelId} cannot use itself as its source.`
      );
    }
  }

  const titleCardMode = item.variants[channelId]?.titleCardMode;
  const desired = mode === 'hidden'
    ? {
        mode: 'hidden',
        ...(titleCardMode ? { titleCardMode } : {})
      }
    : mode === 'derive-next-text'
      ? {
          mode: 'derive',
          from: sourceChannelId,
          transform: { id: 'first-lines', version: 1, maxLines: 2 },
          ...(titleCardMode ? { titleCardMode } : {})
        }
      : {
          mode: 'inherit',
          from: sourceChannelId,
          ...(titleCardMode ? { titleCardMode } : {})
        };
  const existing = item.variants[channelId] || { mode: 'hidden' };
  if (JSON.stringify(existing) === JSON.stringify(desired)
    && item.primaryChannelId === primary.channelId
    && !item.sourceRangeReplacement) {
    return project;
  }

  const next = deepClone(project);
  const previousResourceId = item.variants[channelId]?.mode === 'content'
    ? item.variants[channelId].resourceId
    : null;
  next.items[item.id].primaryChannelId = item.primaryChannelId || primary.channelId;
  next.items[item.id].variants[channelId] = desired;
  delete next.items[item.id].sourceRangeReplacement;
  next.items[item.id].updatedAt = mutationTimestamp(
    options.now,
    'Song output treatment timestamp'
  );
  return pruneUnreachableProjectRecords(next, {
    resourceIds: previousResourceId ? [previousResourceId] : []
  });
}

/**
 * Compatibility wrapper for the original "Use normal" action. New callers
 * should use setSongChannelTreatment() with an explicit sourceChannelId.
 */
function resetSongChannelVariant(rawProject, options = {}) {
  const project = normalizeEditableServiceProject(rawProject);
  const item = requireSongItem(project, options.itemId);
  const primary = authoritativeSongSource(project, item);
  const mode = options.mode || 'inherit';
  if (mode !== 'inherit' && mode !== 'derive') {
    fail(
      'INVALID_SONG_VARIANT',
      'A reset song channel must inherit or use the singers next-line view.'
    );
  }
  return setSongChannelTreatment(project, {
    ...options,
    mode: mode === 'derive' ? 'derive-next-text' : 'inherit',
    sourceChannelId: options.sourceChannelId || primary.channelId
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
    operatorNotes: options.operatorNotes || '',
    ...(options.sermonReading ? { sermonReading: options.sermonReading } : {})
  }, {
    parentId: options.parentId,
    index: options.index,
    now: options.now
  });
}

function resolveSermonReadingPlacement(rawProject, itemId) {
  const project = normalizeEditableServiceProject(rawProject);
  const item = requireProjectItem(project, itemId);
  if (!isSermonSourceTarget(project, item)) {
    fail(
      'INVALID_SERMON_SOURCE_ITEM',
      'Choose a linked sermon cue or sermon outline group before adding its reading.'
    );
  }
  const linked = resolveSermonSourceLink(project, item);
  if (!linked) {
    fail(
      'SERMON_SOURCE_NOT_LINKED',
      'Link an exact sermon packet before adding its primary reading.'
    );
  }

  const lineageIds = [];
  let currentId = item.id;
  while (currentId !== null && currentId !== undefined) {
    lineageIds.unshift(currentId);
    currentId = project._index.parentByItemId[currentId];
  }
  const outerSermonGroup = lineageIds
    .map(lineageId => project.items[lineageId])
    .find(candidate => candidate?.kind === 'group' && candidate.groupKind === 'sermon');
  const anchorItemId = outerSermonGroup?.id || linked.resourceOwnerId;
  const parentId = project._index.parentByItemId[anchorItemId];
  const siblings = parentId === null
    ? project.rootItemIds
    : project.items[parentId].childIds;
  const index = siblings.indexOf(anchorItemId);
  if (index < 0) {
    fail(
      'ORPHAN_PROJECT_ITEM',
      `Sermon reading anchor ${anchorItemId} is not in the service order.`
    );
  }
  return { project, linked, anchorItemId, parentId, index };
}

function analyzeSermonPrimaryReading(rawProject, options = {}) {
  const placement = resolveSermonReadingPlacement(rawProject, options.itemId);
  const plan = planSermonPrimaryReading(placement.linked.resource.document, {
    referenceId: options.referenceId,
    maxVerses: options.maxVerses
  });
  const project = placement.project;
  let requestedOutputs = null;
  let requestedTranslationId = null;
  if (options.outputs !== undefined) {
    requestedOutputs = normalizeSermonReadingOutputs(
      options.outputs,
      project.channelIds,
      'Sermon reading outputs'
    );
  } else if (options.translationId !== undefined) {
    requestedTranslationId = text(
      options.translationId,
      'Sermon reading translation',
      12,
      { required: true }
    ).toUpperCase();
  }
  const matchesRequestedTreatment = item => {
    const itemOutputs = sermonReadingOutputPlan(project, item);
    if (requestedOutputs) {
      return sermonReadingOutputPlansEqual(itemOutputs, requestedOutputs);
    }
    if (!requestedTranslationId) return true;
    const visibleOutputs = itemOutputs?.filter(output =>
      output.mode === 'translation') || [];
    return visibleOutputs.length > 0
      && visibleOutputs.every(output =>
        output.translationId === requestedTranslationId);
  };
  const matching = Object.values(project.items).filter(item =>
    item.kind === 'bible'
    && item.sermonReading?.sermonResourceId === placement.linked.resourceId
    && item.sermonReading?.referenceId === plan.referenceId
    && matchesRequestedTreatment(item));
  const alternateItemIds = Object.values(project.items)
    .filter(item =>
      item.kind === 'bible'
      && item.sermonReading?.sermonResourceId === placement.linked.resourceId
      && item.sermonReading?.referenceId === plan.referenceId
      && (requestedOutputs || requestedTranslationId)
      && !matchesRequestedTreatment(item))
    .map(item => item.id);
  const conflictingReferenceItemIds = Object.values(project.items)
    .filter(item =>
      item.kind === 'bible'
      && item.sermonReading?.sermonResourceId === placement.linked.resourceId
      && item.sermonReading?.referenceId !== plan.referenceId)
    .map(item => item.id);
  const staleItemIds = Object.values(project.items)
    .filter(item => {
      if (item.kind !== 'bible' || !item.sermonReading) return false;
      const resource = project.resources[item.sermonReading.sermonResourceId];
      return resource?.kind === 'sermon'
        && resource.document.id === plan.sermonId
        && item.sermonReading.sermonResourceId !== placement.linked.resourceId;
    })
    .map(item => item.id);

  const expected = plan.chunks.map((chunk, chunkIndex) => {
    const candidates = matching.filter(item =>
      item.sermonReading.chunkIndex === chunkIndex
      && item.sermonReading.chunkCount === plan.chunks.length
      && bibleRangesEqual(item.range, chunk.range));
    return {
      chunkIndex,
      range: chunk.range,
      reference: chunk.reference,
      itemId: candidates.length === 1 ? candidates[0].id : null,
      duplicate: candidates.length > 1
    };
  });
  const exactIds = new Set(expected.map(chunk => chunk.itemId).filter(Boolean));
  const invalidMatching = matching.filter(item => !exactIds.has(item.id));
  const reviewItemIds = [
    ...new Set([
      ...invalidMatching.map(item => item.id),
      ...alternateItemIds,
      ...conflictingReferenceItemIds,
      ...staleItemIds
    ])
  ];
  let status;
  if (expected.some(chunk => chunk.duplicate) || reviewItemIds.length > 0) {
    status = 'wrong-passage';
  } else if (expected.some(chunk => !chunk.itemId)) {
    status = 'missing';
  } else {
    const siblings = placement.parentId === null
      ? project.rootItemIds
      : project.items[placement.parentId].childIds;
    const adjacentIds = siblings.slice(
      placement.index - expected.length,
      placement.index
    );
    status = adjacentIds.length === expected.length
      && adjacentIds.every((itemId, index) => itemId === expected[index].itemId)
      ? 'ready'
      : 'out-of-position';
  }

  return {
    status,
    sermonId: plan.sermonId,
    sermonResourceId: placement.linked.resourceId,
    referenceId: plan.referenceId,
    reference: plan.reference,
    anchorItemId: placement.anchorItemId,
    parentId: placement.parentId,
    anchorIndex: placement.index,
    ...(requestedOutputs ? { outputs: requestedOutputs } : {}),
    chunks: expected,
    staleItemIds,
    alternateItemIds,
    conflictingReferenceItemIds,
    invalidItemIds: invalidMatching.map(item => item.id),
    reviewItemIds
  };
}

function placeBibleReadingItemsBefore(rawProject, options = {}) {
  const project = normalizeEditableServiceProject(rawProject);
  const itemIds = normalizeUniqueIds(
    options.itemIds || [],
    'Sermon reading itemIds',
    100
  );
  if (itemIds.length < 1) {
    fail('EMPTY_SERMON_READING', 'Choose at least one sermon reading cue to place.');
  }
  const anchorItemId = id(options.anchorItemId, 'Sermon reading anchor item id');
  if (itemIds.includes(anchorItemId)) {
    fail('INVALID_SERMON_READING_PLACEMENT', 'A sermon reading cue cannot be its own anchor.');
  }
  for (const itemId of itemIds) {
    if (project.items[itemId]?.kind !== 'bible') {
      fail(
        'INVALID_SERMON_READING_ITEM',
        `Sermon reading item ${itemId} must be a Bible cue.`
      );
    }
  }
  if (!project.items[anchorItemId]) {
    fail('UNKNOWN_PROJECT_ITEM', `Sermon reading anchor ${anchorItemId} does not exist.`);
  }

  const parentId = project._index.parentByItemId[anchorItemId];
  const next = deepClone(project);
  const removed = new Set();
  const removeFrom = siblings => {
    for (const itemId of itemIds) {
      const at = siblings.indexOf(itemId);
      if (at >= 0) {
        siblings.splice(at, 1);
        removed.add(itemId);
      }
    }
  };
  removeFrom(next.rootItemIds);
  for (const item of Object.values(next.items)) {
    if (item.kind === 'group') removeFrom(item.childIds);
  }
  if (removed.size !== itemIds.length) {
    fail(
      'ORPHAN_PROJECT_ITEM',
      'Every sermon reading cue must already appear once in the service order.'
    );
  }

  const siblings = parentId === null
    ? next.rootItemIds
    : next.items[parentId].childIds;
  const anchorIndex = siblings.indexOf(anchorItemId);
  if (anchorIndex < 0) {
    fail(
      'ORPHAN_PROJECT_ITEM',
      `Sermon reading anchor ${anchorItemId} is not in the service order.`
    );
  }
  siblings.splice(anchorIndex, 0, ...itemIds);
  return normalizeProjectContentMutation(next);
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
  const previousParentId = project._index.parentByItemId[itemId];
  if (
    previousParentId !== parentId
    && next.items[itemId]?.kind === 'sermon'
    && next.items[itemId].sourceBodyProjection
  ) {
    delete next.items[itemId].sourceBodyProjection;
  }
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
  return normalizeProjectContentMutation(next);
}

module.exports = {
  configureCommunityServicePlanBaselineNormalizer,
  ASSET_ID_PATTERN,
  CUE_KINDS,
  CUE_TIMELINE_KIND,
  EDITABLE_PROJECT_KIND,
  MAX_GROUP_DEPTH,
  MAX_IMAGE_PIXELS,
  MAX_PROJECT_JSON_BYTES,
  PROJECT_ITEM_KINDS,
  POWERPOINT_COMPANION_WORKFLOW_MODE,
  COMMUNITY_SERVICE_PLAN_SCHEMA_VERSION,
  LEGACY_COMMUNITY_SERVICE_PLAN_SCHEMA_VERSION,
  LOCAL_SERVICE_PLAN_SCHEMA_VERSION,
  LOCAL_SERVICE_PLAN_ORIGIN,
  COMMUNITY_SERVICE_PLAN_SOURCE_KIND,
  COMMUNITY_RECONCILIATION_RECEIPT_KIND,
  COMMUNITY_RECONCILIATION_RECEIPT_SCHEMA_VERSION,
  MAX_COMMUNITY_RECONCILIATION_RECEIPT_DECISIONS,
  MAX_PLANNED_ITEM_DURATION_SECONDS,
  SERVICE_PLAN_SCHEMA_VERSION,
  SERVICE_PLAN_STATUSES,
  SERVICE_PROJECT_SCHEMA_VERSION,
  SOURCE_BODY_PROJECTION_KIND,
  SOURCE_BODY_PROJECTION_SCHEMA_VERSION,
  SOURCE_BODY_PROJECTION_SCHEMA_VERSION_V2,
  ServiceProjectError,
  addBibleItem,
  addGroupItem,
  addProjectItem,
  addSermonResource,
  addSongResource,
  attachCommunityServicePlanning,
  attachLocalServicePlanning,
  analyzeSermonPrimaryReading,
  bindCommunityServicePlanBaseline,
  bindCommunityServicePlanReconciliationReceipt,
  bindProjectAsPowerPointCompanion,
  bindProjectToServiceSet,
  compileServiceProject,
  compareSongTranslations,
  parseSongDocument,
  createCommunityServicePlanReconciliationReceipt,
  createCue,
  createCueTimeline: createServiceProject,
  createDefaultSongChannelVariants,
  createServiceProject: createEditableServiceProject,
  createSongCues,
  deriveSermonServiceRelationship,
  deterministicCueId,
  duplicateProjectItem,
  linkSongTranslation,
  moveProjectItem,
  normalizeCue,
  normalizeCueTimeline: normalizeServiceProject,
  normalizeServiceProject: normalizeEditableServiceProject,
  placeBibleReadingItemsBefore,
  planNextServiceProject,
  pruneUnreachableProjectRecords,
  projectWithCue,
  projectWithMovedCue,
  projectWithoutCue,
  repinCompatibleSermonDocument,
  repinCompatibleSermonRevision,
  repinSermonRevision,
  removeProjectItemAndDescendants,
  replaceProjectItemRange,
  replaceSongItem,
  resolveAuthoritativeSongSource,
  resolveSermonSourceLink,
  sermonReadingOutputPlan,
  sermonReadingOutputPlanSignature,
  sermonReadingOutputPlansEqual,
  isSermonSourceTarget,
  isPowerPointCompanionProject,
  resetSongChannelVariant,
  setSongChannelTreatment,
  setSermonSourceLink,
  serializeCueTimeline: serializeServiceProject,
  serializeServiceProject: serializeEditableServiceProject,
  sermonBodyEntryRevisionId,
  sermonBodyParagraphCandidates,
  setServicePlanStatus,
  updateServicePlanningDetails,
  updateGroupItem,
  updatePictureChannelAsset,
  updateProjectItemTiming,
  updatePresentationItem,
  updateSongArrangement,
  updateTextItem,
  validateProjectTree
};
