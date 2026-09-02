'use strict';
const { singerSourceCue, singerNextLine } = require('../project/SingerPresentation');

const {
  cueTextForChannel,
  meaningfulFirstLine,
  normalizeSafeTextSpans,
  splitLeadingScriptureReference
} = require('../project/NativeSlideRenderer');
const { resolveNativeTextPreset } = require('../project/NativePresetCatalog');
const { scriptureFlowText } = require('../bible/ScriptureText');

const NATIVE_CUE_SCENE_SCHEMA_VERSION = 2;
const NATIVE_CUE_SCENE_KIND = 'syncshow-native-cue-scene';
const MAX_NATIVE_SCENE_BYTES = 256 * 1024;
const MAX_SCENE_TEXT = 12000;
const MAX_SCENE_LINES = 240;
const MAX_SCENE_SPANS = 256;
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const ASSET_ID_PATTERN = /^sha256:[a-f0-9]{64}$/;
const HEX_COLOR_PATTERN = /^#[a-f0-9]{6}$/;
const TEXT_WEIGHTS = new Set(['400', '500', '600', '650', '700']);
const TEXT_ALIGNMENTS = new Set(['left', 'center', 'right']);
const BODY_POSITIONS = new Set(['center', 'top']);
const IMAGE_FITS = new Set(['fit', 'fill', 'stretch']);
const SCENE_LAYOUTS = new Set(['blank', 'text', 'song-title', 'picture', 'singer-current-next']);
const SOURCE_KINDS = new Set(['song', 'bible', 'sermon', 'picture', 'notice', 'blank', 'slide']);

class NativeCueSceneError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'NativeCueSceneError';
    this.code = code;
    this.details = details;
  }
}

function fail(code, message, details = {}) {
  throw new NativeCueSceneError(code, message, details);
}

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function exactKeys(value, expected, field) {
  if (!isRecord(value)) fail('INVALID_NATIVE_SCENE', `${field} must be an object.`);
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    fail('INVALID_NATIVE_SCENE', `${field} has unsupported or missing fields.`, {
      field,
      actual,
      expected: wanted
    });
  }
}

function boundedString(value, field, maximum, { required = false } = {}) {
  if (typeof value !== 'string' || value.length > maximum || (required && value.length < 1)) {
    fail('INVALID_NATIVE_SCENE', `${field} must be ${required ? 'a non-empty ' : ''}text no longer than ${maximum} characters.`);
  }
  return value;
}

function boundedInteger(value, field, minimum, maximum) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    fail('INVALID_NATIVE_SCENE', `${field} must be a whole number from ${minimum} to ${maximum}.`);
  }
  return value;
}

function boundedNumber(value, field, minimum, maximum) {
  if (!Number.isFinite(value) || value < minimum || value > maximum) {
    fail('INVALID_NATIVE_SCENE', `${field} must be a number from ${minimum} to ${maximum}.`);
  }
  return value;
}

function safeId(value, field) {
  if (typeof value !== 'string' || !ID_PATTERN.test(value)
    || ['__proto__', 'prototype', 'constructor'].includes(value)) {
    fail('INVALID_NATIVE_SCENE', `${field} is invalid.`);
  }
  return value;
}

function safeColor(value, field) {
  if (typeof value !== 'string' || !HEX_COLOR_PATTERN.test(value)) {
    fail('INVALID_NATIVE_SCENE', `${field} must be a six-digit lowercase RGB color.`);
  }
  return value;
}

function safeWeight(value, field) {
  if (typeof value !== 'string' || !TEXT_WEIGHTS.has(value)) {
    fail('INVALID_NATIVE_SCENE', `${field} has an unsupported font weight.`);
  }
  return value;
}

function normalizeCanvas(raw) {
  exactKeys(raw, ['height', 'width'], 'scene.canvas');
  const width = boundedInteger(raw.width, 'scene.canvas.width', 640, 3840);
  const height = boundedInteger(raw.height, 'scene.canvas.height', 360, 2160);
  if (width * height > 3840 * 2160) {
    fail('INVALID_NATIVE_SCENE', 'scene.canvas exceeds the native output pixel limit.');
  }
  return { width, height };
}

function normalizeSceneSpans(raw, text, field = 'scene.bodySpans') {
  if (!Array.isArray(raw) || raw.length > MAX_SCENE_SPANS) {
    fail('INVALID_NATIVE_SCENE', `${field} must contain at most ${MAX_SCENE_SPANS} entries.`);
  }
  try {
    return normalizeSafeTextSpans(text, raw);
  } catch (error) {
    fail('INVALID_NATIVE_SCENE', `${field} is invalid: ${error.message}`);
  }
}

function normalizeTextStyle(raw) {
  exactKeys(raw, [
    'bodyAlign',
    'bodyForeground',
    'bodyHeight',
    'bodyMinimumSize',
    'bodyPosition',
    'bodyRegionHeightPercent',
    'bodySize',
    'bodyTopPercent',
    'bodyWeight',
    'bodyWidthPercent',
    'lineSpacingPercent',
    'paragraphGap',
    'showTitle',
    'titleAlign',
    'titleForeground',
    'titleMinimumSize',
    'titleSize',
    'titleTopPercent',
    'titleWeight',
    'titleWidthPercent'
  ], 'scene.style');
  if (typeof raw.showTitle !== 'boolean' || typeof raw.paragraphGap !== 'boolean') {
    fail('INVALID_NATIVE_SCENE', 'scene.style boolean fields are invalid.');
  }
  if (!TEXT_ALIGNMENTS.has(raw.titleAlign) || !TEXT_ALIGNMENTS.has(raw.bodyAlign)) {
    fail('INVALID_NATIVE_SCENE', 'scene.style has an unsupported text alignment.');
  }
  if (!BODY_POSITIONS.has(raw.bodyPosition)) {
    fail('INVALID_NATIVE_SCENE', 'scene.style has an unsupported vertical position.');
  }
  return {
    showTitle: raw.showTitle,
    titleSize: boundedInteger(raw.titleSize, 'scene.style.titleSize', 14, 160),
    titleMinimumSize: boundedInteger(raw.titleMinimumSize, 'scene.style.titleMinimumSize', 14, 160),
    titleForeground: safeColor(raw.titleForeground, 'scene.style.titleForeground'),
    titleWeight: safeWeight(raw.titleWeight, 'scene.style.titleWeight'),
    titleAlign: raw.titleAlign,
    titleWidthPercent: boundedInteger(raw.titleWidthPercent, 'scene.style.titleWidthPercent', 50, 100),
    titleTopPercent: boundedInteger(raw.titleTopPercent, 'scene.style.titleTopPercent', 0, 80),
    bodySize: boundedInteger(raw.bodySize, 'scene.style.bodySize', 14, 240),
    bodyMinimumSize: boundedInteger(raw.bodyMinimumSize, 'scene.style.bodyMinimumSize', 14, 240),
    bodyForeground: safeColor(raw.bodyForeground, 'scene.style.bodyForeground'),
    bodyWeight: safeWeight(raw.bodyWeight, 'scene.style.bodyWeight'),
    bodyAlign: raw.bodyAlign,
    bodyWidthPercent: boundedInteger(raw.bodyWidthPercent, 'scene.style.bodyWidthPercent', 50, 100),
    bodyHeight: boundedInteger(raw.bodyHeight, 'scene.style.bodyHeight', 50, 1080),
    bodyTopPercent: boundedInteger(raw.bodyTopPercent, 'scene.style.bodyTopPercent', 0, 80),
    bodyRegionHeightPercent: boundedInteger(
      raw.bodyRegionHeightPercent,
      'scene.style.bodyRegionHeightPercent',
      10,
      90
    ),
    bodyPosition: raw.bodyPosition,
    lineSpacingPercent: boundedInteger(raw.lineSpacingPercent, 'scene.style.lineSpacingPercent', 0, 200),
    paragraphGap: raw.paragraphGap
  };
}

function normalizeSongTitleStyle(raw) {
  exactKeys(raw, [
    'creditBottomPercent',
    'creditForeground',
    'creditMinimumSize',
    'creditRightPercent',
    'creditSize',
    'creditWeight',
    'creditWidthPercent',
    'titleForeground',
    'titleMinimumSize',
    'titleRegionHeightPercent',
    'titleSize',
    'titleTopPercent',
    'titleWeight',
    'titleWidthPercent',
    'subtitleForeground',
    'subtitleMinimumSize',
    'subtitleSize',
    'subtitleWeight',
    'subtitleWidthPercent'
  ], 'scene.style');
  const titleSize = boundedInteger(raw.titleSize, 'scene.style.titleSize', 14, 240);
  const titleMinimumSize = boundedInteger(
    raw.titleMinimumSize,
    'scene.style.titleMinimumSize',
    14,
    240
  );
  const creditSize = boundedInteger(raw.creditSize, 'scene.style.creditSize', 14, 96);
  const creditMinimumSize = boundedInteger(
    raw.creditMinimumSize,
    'scene.style.creditMinimumSize',
    14,
    96
  );
  const subtitleSize = boundedInteger(raw.subtitleSize, 'scene.style.subtitleSize', 14, 160);
  const subtitleMinimumSize = boundedInteger(
    raw.subtitleMinimumSize,
    'scene.style.subtitleMinimumSize',
    14,
    160
  );
  if (titleMinimumSize > titleSize
    || subtitleMinimumSize > subtitleSize
    || creditMinimumSize > creditSize) {
    fail('INVALID_NATIVE_SCENE', 'scene.style minimum text sizes cannot exceed their preferred sizes.');
  }
  return {
    titleSize,
    titleMinimumSize,
    titleForeground: safeColor(raw.titleForeground, 'scene.style.titleForeground'),
    titleWeight: safeWeight(raw.titleWeight, 'scene.style.titleWeight'),
    titleWidthPercent: boundedInteger(raw.titleWidthPercent, 'scene.style.titleWidthPercent', 50, 96),
    titleTopPercent: boundedInteger(raw.titleTopPercent, 'scene.style.titleTopPercent', 0, 60),
    titleRegionHeightPercent: boundedInteger(
      raw.titleRegionHeightPercent,
      'scene.style.titleRegionHeightPercent',
      20,
      80
    ),
    subtitleSize,
    subtitleMinimumSize,
    subtitleForeground: safeColor(raw.subtitleForeground, 'scene.style.subtitleForeground'),
    subtitleWeight: safeWeight(raw.subtitleWeight, 'scene.style.subtitleWeight'),
    subtitleWidthPercent: boundedInteger(
      raw.subtitleWidthPercent,
      'scene.style.subtitleWidthPercent',
      50,
      96
    ),
    creditSize,
    creditMinimumSize,
    creditForeground: safeColor(raw.creditForeground, 'scene.style.creditForeground'),
    creditWeight: safeWeight(raw.creditWeight, 'scene.style.creditWeight'),
    creditWidthPercent: boundedInteger(raw.creditWidthPercent, 'scene.style.creditWidthPercent', 25, 80),
    creditRightPercent: boundedInteger(raw.creditRightPercent, 'scene.style.creditRightPercent', 0, 20),
    creditBottomPercent: boundedInteger(raw.creditBottomPercent, 'scene.style.creditBottomPercent', 0, 20)
  };
}

function normalizePicture(raw) {
  exactKeys(raw, ['altText', 'assetId', 'attribution', 'fit', 'focalPoint'], 'scene.picture');
  if (!ASSET_ID_PATTERN.test(raw.assetId || '')) {
    fail('INVALID_NATIVE_SCENE', 'scene.picture.assetId is invalid.');
  }
  if (!IMAGE_FITS.has(raw.fit)) {
    fail('INVALID_NATIVE_SCENE', 'scene.picture.fit is unsupported.');
  }
  exactKeys(raw.focalPoint, ['x', 'y'], 'scene.picture.focalPoint');
  return {
    assetId: raw.assetId,
    fit: raw.fit,
    focalPoint: {
      x: boundedNumber(raw.focalPoint.x, 'scene.picture.focalPoint.x', 0, 1),
      y: boundedNumber(raw.focalPoint.y, 'scene.picture.focalPoint.y', 0, 1)
    },
    altText: boundedString(raw.altText, 'scene.picture.altText', 500, { required: true }),
    attribution: boundedString(raw.attribution, 'scene.picture.attribution', 500)
  };
}

function commonScene(raw, expected = {}) {
  if (!isRecord(raw)) fail('INVALID_NATIVE_SCENE', 'A native cue scene must be an object.');
  if (raw.schemaVersion !== NATIVE_CUE_SCENE_SCHEMA_VERSION
    || raw.kind !== NATIVE_CUE_SCENE_KIND
    || !SCENE_LAYOUTS.has(raw.layout)) {
    fail('INVALID_NATIVE_SCENE', 'The native cue scene identity is invalid.');
  }
  const cueId = safeId(raw.cueId, 'scene.cueId');
  const sourceKind = boundedString(raw.sourceKind, 'scene.sourceKind', 24, { required: true });
  if (!SOURCE_KINDS.has(sourceKind)) fail('INVALID_NATIVE_SCENE', 'scene.sourceKind is unsupported.');
  if (expected.cueId && cueId !== expected.cueId) {
    fail('NATIVE_SCENE_CUE_MISMATCH', 'The native cue scene does not match its package position.');
  }
  if (expected.layout && raw.layout !== expected.layout) {
    fail('NATIVE_SCENE_LAYOUT_MISMATCH', 'The native cue scene has an unexpected layout.');
  }
  return {
    schemaVersion: NATIVE_CUE_SCENE_SCHEMA_VERSION,
    kind: NATIVE_CUE_SCENE_KIND,
    cueId,
    sourceKind,
    canvas: normalizeCanvas(raw.canvas),
    layout: raw.layout,
    background: safeColor(raw.background, 'scene.background')
  };
}

function normalizeNativeCueScene(raw, expected = {}) {
  const common = commonScene(raw, expected);
  if (common.layout === 'blank') {
    exactKeys(raw, ['background', 'canvas', 'cueId', 'kind', 'layout', 'schemaVersion', 'sourceKind'], 'scene');
    return common;
  }
  if (common.layout === 'text') {
    exactKeys(raw, [
      'background',
      'body',
      'bodySpans',
      'canvas',
      'cueId',
      'kind',
      'layout',
      'schemaVersion',
      'sourceKind',
      'style',
      'title'
    ], 'scene');
    const title = boundedString(raw.title, 'scene.title', 500);
    const body = boundedString(raw.body, 'scene.body', MAX_SCENE_TEXT, { required: true });
    if (body.split(/\r\n|\r|\n/).length > MAX_SCENE_LINES) {
      fail('INVALID_NATIVE_SCENE', `scene.body may contain at most ${MAX_SCENE_LINES} lines.`);
    }
    return {
      ...common,
      title,
      body,
      bodySpans: normalizeSceneSpans(raw.bodySpans, body),
      style: normalizeTextStyle(raw.style)
    };
  }
  if (common.layout === 'song-title') {
    exactKeys(raw, [
      'background',
      'canvas',
      'credit',
      'cueId',
      'kind',
      'layout',
      'schemaVersion',
      'sourceKind',
      'style',
      'subtitle',
      'title'
    ], 'scene');
    return {
      ...common,
      title: boundedString(raw.title, 'scene.title', 500, { required: true }),
      subtitle: boundedString(raw.subtitle, 'scene.subtitle', 500),
      credit: boundedString(raw.credit, 'scene.credit', 2048),
      style: normalizeSongTitleStyle(raw.style)
    };
  }
  if (common.layout === 'picture') {
    exactKeys(raw, [
      'background',
      'canvas',
      'cueId',
      'kind',
      'layout',
      'picture',
      'schemaVersion',
      'sourceKind'
    ], 'scene');
    return { ...common, picture: normalizePicture(raw.picture) };
  }
  exactKeys(raw, [
    'background',
    'canvas',
    'cueId',
    'current',
    'kind',
    'layout',
    'nextLine',
    'schemaVersion',
    'sourceKind'
  ], 'scene');
  const current = normalizeNativeCueScene(raw.current, { cueId: common.cueId });
  if (current.layout === 'singer-current-next'
    || current.sourceKind !== common.sourceKind
    || current.canvas.width !== common.canvas.width
    || current.canvas.height !== common.canvas.height) {
    fail('INVALID_NATIVE_SCENE', 'A Singer scene must contain a matching non-Singer current scene.');
  }
  return {
    ...common,
    current,
    nextLine: boundedString(raw.nextLine, 'scene.nextLine', 2000)
  };
}

function referenceSpans(value, preset) {
  if (preset.leadingReferenceStyle !== 'scripture') return [];
  const spans = [];
  let offset = 0;
  for (const line of String(value || '').split(/\r\n|\r|\n/)) {
    const reference = splitLeadingScriptureReference(line);
    if (reference) {
      const start = offset + reference.leadingWhitespace.length;
      spans.push({
        start,
        end: start + reference.reference.length,
        foreground: preset.leadingReferenceForeground || '#ffc000',
        weight: preset.leadingReferenceWeight || '700'
      });
    }
    offset += line.length;
    const newline = String(value || '').slice(offset).match(/^(\r\n|\r|\n)/)?.[0] || '';
    offset += newline.length;
  }
  return spans;
}

function resolvedTextStyle(preset, hasTitle, presetId = '') {
  const churchLayout = presetId.startsWith('wotbc-');
  return {
    showTitle: hasTitle,
    titleSize: preset.titleSize,
    titleMinimumSize: preset.titleMinimumSize,
    titleForeground: preset.titleForeground || '#93b4ff',
    titleWeight: preset.titleWeight || '650',
    titleAlign: preset.titleAlign || 'center',
    titleWidthPercent: churchLayout ? 98 : 82,
    titleTopPercent: preset.titleTopPercent === undefined ? 9 : preset.titleTopPercent,
    bodySize: preset.bodySize,
    bodyMinimumSize: preset.bodyMinimumSize,
    bodyForeground: preset.bodyForeground || '#f8fafc',
    bodyWeight: TEXT_WEIGHTS.has(preset.bodyWeight) ? preset.bodyWeight : '500',
    bodyAlign: preset.bodyAlign || 'center',
    bodyWidthPercent: preset.bodyWidthPercent || 82,
    bodyHeight: preset.bodyHeight,
    bodyTopPercent: preset.bodyTopPercent === undefined ? (hasTitle ? 26 : 10) : preset.bodyTopPercent,
    bodyRegionHeightPercent: churchLayout ? Math.min(90, Math.round(preset.bodyHeight / 1080 * 100)) : hasTitle ? 66 : 80,
    bodyPosition: preset.bodyPosition || 'center',
    lineSpacingPercent: preset.lineSpacingPercent === undefined ? 18 : preset.lineSpacingPercent,
    paragraphGap: preset.paragraphGap === true
  };
}

function songTitleScene(cue, title, subtitle, credit, canvas) {
  return normalizeNativeCueScene({
    schemaVersion: NATIVE_CUE_SCENE_SCHEMA_VERSION,
    kind: NATIVE_CUE_SCENE_KIND,
    cueId: cue.id,
    sourceKind: cue.kind,
    canvas,
    layout: 'song-title',
    background: '#000000',
    title,
    subtitle,
    credit,
    style: {
      titleSize: cue.presetId === 'wotbc-song-title' ? 144 : 128,
      titleMinimumSize: 52,
      titleForeground: '#ffffff',
      titleWeight: '700',
      titleWidthPercent: 94,
      titleTopPercent: 10,
      titleRegionHeightPercent: 70,
      subtitleSize: cue.presetId === 'wotbc-song-title' ? 128 : 92,
      subtitleMinimumSize: 36,
      subtitleForeground: cue.presetId === 'wotbc-song-title' ? '#ffc000' : '#ffff00',
      subtitleWeight: '500',
      subtitleWidthPercent: 90,
      creditSize: 56,
      creditMinimumSize: 24,
      creditForeground: '#ffffff',
      creditWeight: '500',
      creditWidthPercent: 56,
      creditRightPercent: 2,
      creditBottomPercent: 2
    }
  });
}

function textScene(cue, channel, canvas) {
  const bibleBlock = channel.blocks?.find(block => block.type === 'bible');
  const textBlocks = channel.blocks?.filter(block => block.type === 'text') || [];
  let title = '';
  let body = '';
  let bodySpans = [];
  if (bibleBlock) {
    title = bibleBlock.reference;
    body = scriptureFlowText(bibleBlock.verses);
  } else {
    const localizedTitle = textBlocks.find(block => block.role === 'title')?.text || '';
    if (cue.kind === 'song' && localizedTitle) {
      const subtitle = textBlocks.find(block => block.role === 'subtitle')?.text || '';
      const credit = textBlocks.find(block => block.role === 'credit')?.text || '';
      return songTitleScene(cue, localizedTitle, subtitle, credit, canvas);
    }
    const bodyParts = [];
    const bodySeparator = cue.presetId === 'wotbc-song-stacked' ? '\n' : '\n\n';
    let bodyOffset = 0;
    for (const block of textBlocks.filter(candidate => candidate.role !== 'title')) {
      if (!block.text) continue;
      if (bodyParts.length > 0) bodyOffset += bodySeparator.length;
      bodyParts.push(block.text);
      for (const span of block.spans || []) {
        bodySpans.push({
          ...span,
          start: span.start + bodyOffset,
          end: span.end + bodyOffset
        });
      }
      bodyOffset += block.text.length;
    }
    body = bodyParts.join(bodySeparator);
    title = cue.kind === 'song'
      ? ''
      : (cue.kind === 'sermon' || cue.kind === 'notice'
          ? localizedTitle
          : (localizedTitle || cue.title));
    if (!body) {
      body = localizedTitle;
      bodySpans = [];
    }
  }
  if (!body.trim()) body = title || cue.title;
  const preset = resolveNativeTextPreset(cue.presetId).render;
  const hasTitle = Boolean(title.trim()) && preset.showTitle;
  if (bodySpans.length === 0) bodySpans = referenceSpans(body, preset);
  return normalizeNativeCueScene({
    schemaVersion: NATIVE_CUE_SCENE_SCHEMA_VERSION,
    kind: NATIVE_CUE_SCENE_KIND,
    cueId: cue.id,
    sourceKind: cue.kind,
    canvas,
    layout: 'text',
    background: preset.background,
    title,
    body,
    bodySpans,
    style: resolvedTextStyle(preset, hasTitle, cue.presetId)
  });
}

function compileNativeCueScene(cue, channelId, options = {}) {
  if (!cue || typeof cue !== 'object') throw new TypeError('A compiled cue is required.');
  const canvas = {
    width: Number.isSafeInteger(options.width) ? options.width : 1920,
    height: Number.isSafeInteger(options.height) ? options.height : 1080
  };
  const channel = cue.channels?.[channelId];
  if (!channel || channel.mode === 'hide' || channel.blocks?.some(block => block.type === 'blank')) {
    return normalizeNativeCueScene({
      schemaVersion: NATIVE_CUE_SCENE_SCHEMA_VERSION,
      kind: NATIVE_CUE_SCENE_KIND,
      cueId: cue.id,
      sourceKind: cue.kind,
      canvas,
      layout: 'blank',
      background: '#000000'
    });
  }
  const legacyBlock = channel.blocks?.find(block => block.type === 'legacy-deck');
  if (legacyBlock) {
    fail(
      'LEGACY_DECK_REQUIRES_RASTER',
      'Imported PowerPoint cues must use the verified raster presentation path.'
    );
  }
  if (channel.mode === 'condensed' && channel.sourceChannelId) {
    const current = compileNativeCueScene(singerSourceCue(cue, channel.sourceChannelId), channel.sourceChannelId, options);
    const nextLine = singerNextLine(cueTextForChannel(singerSourceCue(options.nextCue, channel.sourceChannelId), channel.sourceChannelId));
    return deriveNativeSingerScene(current, nextLine);
  }
  const imageBlock = channel.blocks?.find(block => block.type === 'image');
  if (imageBlock) {
    return normalizeNativeCueScene({
      schemaVersion: NATIVE_CUE_SCENE_SCHEMA_VERSION,
      kind: NATIVE_CUE_SCENE_KIND,
      cueId: cue.id,
      sourceKind: cue.kind,
      canvas,
      layout: 'picture',
      background: '#000000',
      picture: {
        assetId: imageBlock.assetId,
        fit: imageBlock.fit,
        focalPoint: imageBlock.focalPoint,
        altText: imageBlock.altText,
        attribution: imageBlock.attribution || ''
      }
    });
  }
  return textScene(cue, channel, canvas);
}

function deriveNativeSingerScene(scene, nextLine = '') {
  const current = normalizeNativeCueScene(scene);
  if (current.layout === 'singer-current-next') return current;
  return normalizeNativeCueScene({
    schemaVersion: NATIVE_CUE_SCENE_SCHEMA_VERSION,
    kind: NATIVE_CUE_SCENE_KIND,
    cueId: current.cueId,
    sourceKind: current.sourceKind,
    canvas: current.canvas,
    layout: 'singer-current-next',
    background: '#000000',
    current,
    nextLine: singerNextLine(nextLine)
  });
}

function nativeSceneSingerLine(scene) {
  const normalized = normalizeNativeCueScene(scene);
  if (normalized.layout === 'singer-current-next') {
    return nativeSceneSingerLine(normalized.current);
  }
  if (normalized.layout === 'song-title') return meaningfulFirstLine(normalized.title);
  if (normalized.layout !== 'text') return '';

  // NativeSlideRenderer's Singer contract reads the next compiled channel's
  // semantic blocks in order. Text titles precede bodies, while Bible
  // references are presentation chrome and the verse body is the semantic
  // channel text.
  const semanticText = normalized.sourceKind === 'bible'
    ? normalized.body
    : [normalized.title, normalized.body].filter(Boolean).join('\n\n');
  return meaningfulFirstLine(semanticText);
}

function sceneAssetIds(scene) {
  const normalized = normalizeNativeCueScene(scene);
  if (normalized.layout === 'picture') return [normalized.picture.assetId];
  if (normalized.layout === 'singer-current-next') return sceneAssetIds(normalized.current);
  return [];
}

function stableObject(value) {
  if (Array.isArray(value)) return value.map(stableObject);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, stableObject(value[key])]));
}

function serializeNativeCueScene(scene) {
  const serialized = `${JSON.stringify(stableObject(normalizeNativeCueScene(scene)), null, 2)}\n`;
  if (Buffer.byteLength(serialized, 'utf8') > MAX_NATIVE_SCENE_BYTES) {
    fail('NATIVE_SCENE_TOO_LARGE', `A native cue scene may be at most ${MAX_NATIVE_SCENE_BYTES} bytes.`);
  }
  return serialized;
}

module.exports = {
  MAX_NATIVE_SCENE_BYTES,
  NATIVE_CUE_SCENE_KIND,
  NATIVE_CUE_SCENE_SCHEMA_VERSION,
  NativeCueSceneError,
  compileNativeCueScene,
  deriveNativeSingerScene,
  nativeSceneSingerLine,
  normalizeNativeCueScene,
  sceneAssetIds,
  serializeNativeCueScene
};
