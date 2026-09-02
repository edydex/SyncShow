'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const { parseBibleReference } = require('../bible/BibleReferenceParser');
const { scriptureFlowText } = require('../bible/ScriptureText');
const { resolveNativeTextPreset } = require('./NativePresetCatalog');
const { MAX_IMAGE_PIXELS } = require('./ServiceProject');

const MAX_RENDER_PIXELS = 3840 * 2160;
const MAX_TEXT_SPANS = 256;
const SAFE_PANGO_COLOR_PATTERN = /^#[a-fA-F0-9]{6}$/;
const COMPILED_SPAN_COLOR_PATTERN = /^#[a-f0-9]{6}$/;
const SAFE_PANGO_WEIGHT_PATTERN = /^[1-9]00$/;
const COMPILED_SPAN_WEIGHTS = new Set(['400', '500', '600', '700']);
const LEADING_SCRIPTURE_REFERENCE_PATTERN =
  /^(\s*)((?:[1-4]\s*)?[\p{L}][\p{L}\p{M}.'’ʼ -]{0,48}?\.?)\s*(\d{1,3})\s*:\s*(\d{1,3}(?:\s*[-–—]\s*\d{1,3})?(?:\s*[,;]\s*\d{1,3}(?:\s*[-–—]\s*\d{1,3})?)*)(?=\s|$)/u;
const CYRILLIC_SCRIPTURE_BOOK_CHAPTERS = new Map([
  [50, ['быт', 'бытие', 'бут']],
  [40, ['исх', 'исход', 'вих']],
  [27, ['лев', 'левит']],
  [36, ['чис', 'числа']],
  [34, ['втор', 'второзаконие', 'повт']],
  [24, ['нав', 'иисуснавин', 'исн']],
  [21, ['суд', 'судьи']],
  [4, ['руф', 'руфь', 'рут']],
  [31, ['1цар', '1сам']],
  [24, ['2цар', '2сам']],
  [22, ['3цар']],
  [25, ['4цар']],
  [29, ['1пар', '1хрон']],
  [36, ['2пар', '2хрон']],
  [10, ['езд', 'ездра']],
  [13, ['неем', 'неемия']],
  [10, ['есф', 'есфирь']],
  [42, ['иов', 'йов']],
  [150, ['пс', 'псалом', 'псалмы']],
  [31, ['притч', 'притчи']],
  [12, ['еккл', 'екклесиаст']],
  [8, ['песн', 'песнипесней']],
  [66, ['ис', 'исаия']],
  [52, ['иер', 'иеремия']],
  [5, ['плач', 'плачиеремии']],
  [48, ['иез', 'иезекииль']],
  [12, ['дан', 'даниил']],
  [14, ['ос', 'осия']],
  [3, ['иоил']],
  [9, ['ам', 'амос']],
  [1, ['авд', 'авдий']],
  [4, ['ион', 'иона']],
  [7, ['мих', 'михей']],
  [3, ['наум']],
  [3, ['авв', 'аввакум']],
  [3, ['соф', 'софония']],
  [2, ['агг', 'аггей']],
  [14, ['зах', 'захария']],
  [4, ['мал', 'малахия']],
  [28, ['мф', 'матфей', 'матвій', 'мт']],
  [16, ['мк', 'марк']],
  [24, ['лк', 'лука']],
  [21, ['ин', 'иоанн', 'іван']],
  [28, ['деян', 'деяния', 'дії']],
  [16, ['рим', 'римлянам']],
  [16, ['1кор']],
  [13, ['2кор']],
  [6, ['гал', 'галатам']],
  [6, ['еф', 'ефесянам', 'ефес']],
  [4, ['флп', 'филиппийцам']],
  [4, ['кол', 'колоссянам']],
  [5, ['1фес']],
  [3, ['2фес']],
  [6, ['1тим']],
  [4, ['2тим']],
  [3, ['тит']],
  [1, ['флм', 'филимону']],
  [13, ['евр', 'евреям']],
  [5, ['иак', 'иаков']],
  [5, ['1пет', '1петр']],
  [3, ['2пет', '2петр']],
  [5, ['1ин']],
  [1, ['2ин', '3ин', 'иуд', 'иуда']],
  [22, ['откр', 'откровение', 'обявлення']]
].flatMap(([chapterCount, aliases]) =>
  aliases.map(alias => [alias, chapterCount])
));

function escapePango(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function meaningfulFirstLine(value) {
  return String(value || '').split(/\r?\n/).map(line => line.trim()).find(Boolean) || '';
}

function normalizeScriptureBookToken(value) {
  return String(value || '')
    .normalize('NFKC')
    .toLocaleLowerCase('und')
    .replace(/[^\p{L}\p{N}]/gu, '');
}

function splitLeadingScriptureReference(value) {
  const line = String(value || '');
  const match = line.match(LEADING_SCRIPTURE_REFERENCE_PATTERN);
  if (!match) return null;
  const [, leadingWhitespace, rawBook, rawChapter, rawVerses] = match;
  const chapter = Number.parseInt(rawChapter, 10);
  const verseNumbers = [...rawVerses.matchAll(/\d+/g)].map(entry => Number.parseInt(entry[0], 10));
  if (chapter < 1 || chapter > 150
    || verseNumbers.length < 1
    || verseNumbers.some(verse => verse < 1 || verse > 176)) {
    return null;
  }
  for (const range of rawVerses.split(/[,;]/)) {
    const bounds = [...range.matchAll(/\d+/g)].map(entry => Number.parseInt(entry[0], 10));
    if (bounds.length > 1 && bounds[1] < bounds[0]) return null;
  }
  const book = rawBook.trim().replace(/\.+$/u, '');
  const englishReference = parseBibleReference(`${book} ${chapter}:${verseNumbers[0]}`);
  const cyrillicChapterCount = CYRILLIC_SCRIPTURE_BOOK_CHAPTERS.get(
    normalizeScriptureBookToken(book)
  );
  if (!englishReference
    && (!cyrillicChapterCount || chapter > cyrillicChapterCount)) {
    return null;
  }
  return {
    leadingWhitespace,
    reference: match[0].slice(leadingWhitespace.length),
    remainder: line.slice(match[0].length)
  };
}

function invalidTextSpans(message) {
  const error = new TypeError(message);
  error.code = 'INVALID_TEXT_SPANS';
  return error;
}

function splitsSurrogatePair(value, index) {
  if (index <= 0 || index >= value.length) return false;
  const previous = value.charCodeAt(index - 1);
  const next = value.charCodeAt(index);
  return previous >= 0xD800 && previous <= 0xDBFF && next >= 0xDC00 && next <= 0xDFFF;
}

function normalizeSafeTextSpans(value, rawSpans) {
  const text = String(value || '');
  if (rawSpans === undefined || rawSpans === null) return [];
  if (!Array.isArray(rawSpans) || rawSpans.length > MAX_TEXT_SPANS) {
    throw invalidTextSpans(`Compiled text spans must be an array of at most ${MAX_TEXT_SPANS} entries.`);
  }
  let previousEnd = 0;
  return rawSpans.map((raw, index) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw invalidTextSpans(`Compiled text span ${index + 1} must be an object.`);
    }
    const keys = Object.keys(raw).sort();
    if (keys.some(key => !['end', 'foreground', 'start', 'weight'].includes(key))) {
      throw invalidTextSpans(`Compiled text span ${index + 1} has an unsupported field.`);
    }
    const { start, end } = raw;
    if (!Number.isSafeInteger(start)
      || !Number.isSafeInteger(end)
      || start < previousEnd
      || start < 0
      || end <= start
      || end > text.length
      || splitsSurrogatePair(text, start)
      || splitsSurrogatePair(text, end)) {
      throw invalidTextSpans(`Compiled text span ${index + 1} has invalid text boundaries.`);
    }
    const span = { start, end };
    if (raw.foreground !== undefined) {
      if (typeof raw.foreground !== 'string'
        || !COMPILED_SPAN_COLOR_PATTERN.test(raw.foreground)) {
        throw invalidTextSpans(`Compiled text span ${index + 1} has an invalid foreground.`);
      }
      span.foreground = raw.foreground;
    }
    if (raw.weight !== undefined) {
      if (typeof raw.weight !== 'string' || !COMPILED_SPAN_WEIGHTS.has(raw.weight)) {
        throw invalidTextSpans(`Compiled text span ${index + 1} has an invalid weight.`);
      }
      span.weight = raw.weight;
    }
    if (!span.foreground && !span.weight) {
      throw invalidTextSpans(`Compiled text span ${index + 1} has no presentation style.`);
    }
    previousEnd = end;
    return span;
  });
}

function leadingScriptureReferenceSpans(value, options = {}) {
  const text = String(value || '');
  const foreground = SAFE_PANGO_COLOR_PATTERN.test(options.foreground || '')
    ? options.foreground.toLowerCase()
    : '#ffc000';
  const weight = SAFE_PANGO_WEIGHT_PATTERN.test(String(options.weight || ''))
    ? String(options.weight)
    : '700';
  const spans = [];
  let offset = 0;
  for (const line of text.split(/\r\n|\r|\n/)) {
    const reference = splitLeadingScriptureReference(line);
    if (reference) {
      const start = offset + reference.leadingWhitespace.length;
      spans.push({
        start,
        end: start + reference.reference.length,
        foreground,
        weight
      });
    }
    offset += line.length;
    const newline = text.slice(offset).match(/^(\r\n|\r|\n)/)?.[0] || '';
    offset += newline.length;
  }
  return spans;
}

function markupTextSpans(value, rawSpans = [], options = {}) {
  const text = String(value || '');
  const explicitSpans = normalizeSafeTextSpans(text, rawSpans);
  const referenceSpans = options.leadingReferenceStyle === 'scripture'
    ? leadingScriptureReferenceSpans(text, {
        foreground: options.leadingReferenceForeground,
        weight: options.leadingReferenceWeight
      })
    : [];
  const boundaries = new Set([0, text.length]);
  for (const span of [...referenceSpans, ...explicitSpans]) {
    boundaries.add(span.start);
    boundaries.add(span.end);
  }
  const ordered = [...boundaries].sort((left, right) => left - right);
  const fragments = [];
  for (let index = 0; index < ordered.length - 1; index += 1) {
    const start = ordered[index];
    const end = ordered[index + 1];
    if (end <= start) continue;
    const reference = referenceSpans.find(span => span.start <= start && span.end >= end);
    const explicit = explicitSpans.find(span => span.start <= start && span.end >= end);
    const foreground = explicit?.foreground || reference?.foreground;
    const weight = explicit?.weight || reference?.weight;
    let escaped = escapePango(text.slice(start, end));
    if (options.paragraphGap === true) {
      escaped = escaped.replace(/\r\n|\r|\n/g, '\n\n');
    }
    if (foreground || weight) {
      const attributes = [
        foreground ? `foreground="${foreground}"` : '',
        weight ? `weight="${weight}"` : ''
      ].filter(Boolean).join(' ');
      escaped = `<span ${attributes}>${escaped}</span>`;
    }
    fragments.push(escaped);
  }
  return fragments.join('');
}

function markupLeadingScriptureReferences(value, options = {}) {
  return markupTextSpans(value, [], {
    paragraphGap: options.paragraphGap,
    leadingReferenceStyle: 'scripture',
    leadingReferenceForeground: options.foreground,
    leadingReferenceWeight: options.weight
  });
}

function cueTextForChannel(cue, channelId) {
  const channel = cue?.channels?.[channelId];
  if (!channel || channel.mode === 'hide') return '';
  return (channel.blocks || []).map(block => {
    if (block.type === 'text') return block.text || '';
    if (block.type === 'bible') {
      return scriptureFlowText(block.verses);
    }
    return '';
  }).filter(Boolean).join('\n\n');
}

function focalGravity(focalPoint = { x: 0.5, y: 0.5 }) {
  const horizontal = focalPoint.x < 0.34 ? 'west' : focalPoint.x > 0.66 ? 'east' : '';
  const vertical = focalPoint.y < 0.34 ? 'north' : focalPoint.y > 0.66 ? 'south' : '';
  return `${vertical}${horizontal}` || 'centre';
}

function alignedLayerLeft(canvasWidth, layerWidth, regionWidth, alignment) {
  const boundedRegionWidth = Math.min(canvasWidth, Math.max(0, Math.round(regionWidth)));
  const regionLeft = Math.round((canvasWidth - boundedRegionWidth) / 2);
  if (alignment === 'left') return regionLeft;
  if (alignment === 'right') {
    return Math.max(regionLeft, regionLeft + boundedRegionWidth - layerWidth);
  }
  return Math.round((canvasWidth - layerWidth) / 2);
}

class NativeSlideRenderer {
  constructor(options = {}) {
    this.width = Number.isSafeInteger(options.width) ? options.width : 1920;
    this.height = Number.isSafeInteger(options.height) ? options.height : 1080;
    if (this.width < 640 || this.height < 360 || this.width * this.height > MAX_RENDER_PIXELS) {
      throw new RangeError('Native renderer size must be between 640×360 and 3840×2160');
    }
    this.fontPath = path.resolve(options.fontPath || path.join(__dirname, '../../../assets/fonts/NotoSans-Variable.ttf'));
    if (!fs.existsSync(this.fontPath) || !fs.statSync(this.fontPath).isFile()) {
      throw new Error(`Bundled presentation font is unavailable: ${this.fontPath}`);
    }
    const fontConfigPath = path.resolve(options.fontConfigPath || path.join(path.dirname(this.fontPath), 'fonts.conf'));
    if (fs.existsSync(fontConfigPath) && fs.statSync(fontConfigPath).isFile()) {
      const cachePath = path.resolve(options.fontConfigCachePath || path.join(os.tmpdir(), 'syncshow-font-cache'));
      fs.mkdirSync(cachePath, { recursive: true, mode: 0o700 });
      if (process.platform !== 'win32') fs.chmodSync(cachePath, 0o700);
      process.env.FONTCONFIG_FILE = fontConfigPath;
      process.env.XDG_CACHE_HOME = cachePath;
    }
    this.sharp = options.sharp || require('sharp');
    this.resolveAsset = options.resolveAsset || null;
    this.jpegQuality = Number.isSafeInteger(options.jpegQuality)
      ? Math.max(70, Math.min(100, options.jpegQuality))
      : 92;
  }

  async _textLayer(value, options = {}) {
    const text = String(value || '');
    if (!text.trim()) return null;
    const width = Math.max(100, Math.floor(options.width || this.width * 0.78));
    const maxHeight = Math.max(50, Math.floor(options.maxHeight || this.height * 0.7));
    const preferred = Math.max(18, Math.floor(options.fontSize || 72));
    const minimum = Math.max(14, Math.min(preferred, Math.floor(options.minimumFontSize || 28)));
    const foreground = options.foreground || '#f8fafc';
    const weight = options.weight || '500';
    if (text.length > 12000 || text.split(/\r?\n/).length > 240) {
      const error = new Error('This cue has more text than the selected preset can display safely.');
      error.code = 'TEXT_OVERFLOW';
      error.details = { width, maxHeight, minimumFontSize: minimum };
      throw error;
    }
    const contentMarkup = options.leadingReferenceStyle === 'scripture'
      || options.spans !== undefined
      ? markupTextSpans(text, options.spans || [], {
          paragraphGap: options.paragraphGap,
          leadingReferenceStyle: options.leadingReferenceStyle,
          leadingReferenceForeground: options.leadingReferenceForeground,
          leadingReferenceWeight: options.leadingReferenceWeight
        })
      : escapePango(options.paragraphGap === true
          ? text.split(/\r?\n/).join('\n\n')
          : text);
    const fontStyle = options.italic === true ? 'italic' : 'normal';
    const markup =
      `<span foreground="${foreground}" weight="${weight}" style="${fontStyle}">${contentMarkup}</span>`;
    let last = null;
    for (let size = preferred; size >= minimum; size -= 2) {
      let rendered;
      try {
        const spacing = options.lineSpacingPercent === undefined
          ? Math.max(size, Math.round(size * (options.lineHeight || 1.18)))
          : Math.max(0, Math.round(size * options.lineSpacingPercent / 100));
        rendered = await this.sharp({
          text: {
            text: markup,
            font: `Noto Sans ${size}`,
            fontfile: this.fontPath,
            width,
            align: options.align || 'center',
            rgba: true,
            spacing,
            wrap: 'word-char'
          }
        }).png().toBuffer({ resolveWithObject: true });
      } catch (_error) {
        const error = new Error('This cue could not be laid out with the selected presentation preset.');
        error.code = 'TEXT_RENDER_FAILED';
        error.details = { width, maxHeight, fontSize: size };
        throw error;
      }
      last = rendered;
      if (rendered.info.height <= maxHeight) return rendered;
    }
    if (last && last.info.height <= maxHeight * 1.08) return last;
    const error = new Error('This cue has more text than the selected preset can display safely.');
    error.code = 'TEXT_OVERFLOW';
    error.details = { width, maxHeight, minimumFontSize: minimum };
    throw error;
  }

  _background(color) {
    return this.sharp({
      create: {
        width: this.width,
        height: this.height,
        channels: 3,
        background: color
      }
    });
  }

  async _renderTextSlide({
    title = '',
    body = '',
    bodySpans = [],
    presetId = 'notice-text'
  }) {
    const preset = resolveNativeTextPreset(presetId).render;
    const churchLayout = presetId.startsWith('wotbc-');
    const composites = [];
    const hasTitle = Boolean(String(title || '').trim()) && preset.showTitle;
    const resolutionScale = Math.min(1, this.width / 1920, this.height / 1080);
    let titleBottom = 0;
    if (hasTitle) {
      const titleWidth = this.width * (churchLayout ? 0.98 : 0.82);
      const titleAlign = preset.titleAlign || 'center';
      const titleLayer = await this._textLayer(title, {
        width: titleWidth,
        maxHeight: this.height * 0.16,
        fontSize: churchLayout ? preset.titleSize * resolutionScale : preset.titleSize,
        minimumFontSize: Math.max(
          14,
          Math.round(preset.titleMinimumSize * resolutionScale)
        ),
        foreground: preset.titleForeground || '#93b4ff',
        weight: preset.titleWeight || '650',
        align: titleAlign
      });
      if (titleLayer) {
        const titleTop = preset.titleTopPercent === undefined
          ? Math.round(this.height * 0.09)
          : Math.round(this.height * preset.titleTopPercent / 100);
        composites.push({
          input: titleLayer.data,
          left: alignedLayerLeft(
            this.width,
            titleLayer.info.width,
            titleWidth,
            titleAlign
          ),
          top: titleTop
        });
        titleBottom = titleTop + titleLayer.info.height;
      }
    }
    const oldAvailableTop = hasTitle ? Math.round(this.height * 0.26) : Math.round(this.height * 0.1);
    const oldAvailableHeight = hasTitle ? Math.round(this.height * 0.66) : Math.round(this.height * 0.8);
    const configuredBodyTop = preset.bodyTopPercent === undefined
      ? oldAvailableTop
      : Math.round(this.height * preset.bodyTopPercent / 100);
    const availableTop = preset.bodyPosition === 'top' && titleBottom > 0
      ? Math.max(configuredBodyTop, titleBottom + Math.round(this.height * (churchLayout ? 0.02 : 0.04)))
      : configuredBodyTop;
    const bodyMaximumHeight = churchLayout
      ? Math.min(preset.bodyHeight * resolutionScale, this.height - availableTop - this.height * 0.02)
      : preset.bodyPosition === 'top'
      ? Math.min(
          preset.bodyHeight,
          Math.max(50, this.height - availableTop - Math.round(this.height * 0.06))
        )
      : Math.min(preset.bodyHeight, this.height * (hasTitle ? 0.66 : 0.78));
    const bodyWidth = this.width * (preset.bodyWidthPercent || 82) / 100;
    const bodyAlign = preset.bodyAlign || 'center';
    const bodyLayer = await this._textLayer(body || title, {
      width: bodyWidth,
      maxHeight: bodyMaximumHeight,
      fontSize: churchLayout ? preset.bodySize * resolutionScale : preset.bodySize,
      minimumFontSize: Math.max(
        14,
        Math.round(preset.bodyMinimumSize * resolutionScale)
      ),
      foreground: preset.bodyForeground || '#f8fafc',
      weight: preset.bodyWeight,
      align: bodyAlign,
      lineSpacingPercent: preset.lineSpacingPercent,
      paragraphGap: preset.paragraphGap,
      // Imported blocks carry source-authoritative spans. When any are
      // present, render exactly those instead of layering heuristic reference
      // recognition over the imported styling. Plain authored text keeps the
      // safe leading-reference convenience.
      leadingReferenceStyle: bodySpans.length > 0 ? undefined : preset.leadingReferenceStyle,
      leadingReferenceForeground: preset.leadingReferenceForeground,
      leadingReferenceWeight: preset.leadingReferenceWeight,
      spans: bodySpans
    });
    if (bodyLayer) {
      composites.push({
        input: bodyLayer.data,
        left: alignedLayerLeft(
          this.width,
          bodyLayer.info.width,
          bodyWidth,
          bodyAlign
        ),
        top: preset.bodyPosition === 'top'
          ? availableTop
          : availableTop + Math.max(0, Math.round(((churchLayout ? bodyMaximumHeight : oldAvailableHeight) - bodyLayer.info.height) / 2))
      });
    }
    return this._background(preset.background).composite(composites);
  }

  async _renderSongTitleSlide({
    title,
    subtitle = '',
    credit = '',
    presetId = 'song-title'
  }) {
    const composites = [];
    const logicalScale = Math.min(this.width / 1920, this.height / 1080);
    const titleLayer = await this._textLayer(title, {
      width: this.width * 0.94,
      maxHeight: this.height * (subtitle ? 0.42 : 0.7),
      fontSize: Math.round((presetId === 'wotbc-song-title' ? 144 : 128) * logicalScale),
      minimumFontSize: Math.round(52 * logicalScale),
      foreground: '#ffffff',
      weight: '700',
      align: 'center',
      lineSpacingPercent: 12
    });
    const subtitleLayer = await this._textLayer(subtitle, {
      width: this.width * 0.9,
      maxHeight: this.height * 0.25,
      fontSize: Math.round((presetId === 'wotbc-song-title' ? 128 : 92) * logicalScale),
      minimumFontSize: Math.round(36 * logicalScale),
      foreground: presetId === 'wotbc-song-title' ? '#ffc000' : '#ffff00',
      weight: '500',
      align: 'center',
      lineSpacingPercent: 14
    });
    if (titleLayer) {
      const regionTop = Math.round(this.height * 0.1);
      const regionHeight = Math.round(this.height * 0.7);
      const gap = subtitleLayer ? Math.round(this.height * 0.025) : 0;
      const contentHeight = titleLayer.info.height + gap + (subtitleLayer?.info.height || 0);
      const contentTop = regionTop + Math.max(0, Math.round((regionHeight - contentHeight) / 2));
      composites.push({
        input: titleLayer.data,
        left: Math.round((this.width - titleLayer.info.width) / 2),
        top: contentTop
      });
      if (subtitleLayer) {
        composites.push({
          input: subtitleLayer.data,
          left: Math.round((this.width - subtitleLayer.info.width) / 2),
          top: contentTop + titleLayer.info.height + gap
        });
      }
    }
    const creditLayer = await this._textLayer(credit, {
      width: this.width * 0.56,
      maxHeight: this.height * 0.18,
      fontSize: Math.round(56 * logicalScale),
      minimumFontSize: Math.round(24 * logicalScale),
      foreground: '#ffffff',
      weight: '500',
      align: 'right',
      italic: true,
      lineSpacingPercent: 18
    });
    if (creditLayer) {
      composites.push({
        input: creditLayer.data,
        left: Math.max(
          Math.round(this.width * 0.02),
          this.width - creditLayer.info.width - Math.round(this.width * 0.02)
        ),
        top: Math.max(
          Math.round(this.height * 0.02),
          this.height - creditLayer.info.height - Math.round(this.height * 0.02)
        )
      });
    }
    return this._background('#000000').composite(composites);
  }

  async _renderPicture(block) {
    if (!this.resolveAsset) throw new Error('NativeSlideRenderer needs an asset resolver for picture cues.');
    const resolved = await this.resolveAsset(block.assetId);
    const assetPath = typeof resolved === 'string' ? resolved : resolved?.assetPath;
    if (!assetPath) throw new Error(`Picture asset ${block.assetId} is unavailable.`);
    const fit = block.fit === 'stretch' ? 'fill' : block.fit === 'fill' ? 'cover' : 'contain';
    const position = fit === 'cover' ? focalGravity(block.focalPoint) : 'centre';
    const image = await this.sharp(assetPath, {
      failOn: 'warning',
      limitInputPixels: MAX_IMAGE_PIXELS
    })
      .rotate()
      .resize(this.width, this.height, {
        fit,
        position,
        background: '#000000',
        withoutEnlargement: false
      })
      .removeAlpha()
      .jpeg({ quality: this.jpegQuality, chromaSubsampling: '4:4:4' })
      .toBuffer();
    const base = this.sharp(image);
    if (!block.attribution) return base;
    const attribution = await this._textLayer(block.attribution, {
      width: this.width * 0.72,
      maxHeight: this.height * 0.08,
      fontSize: 24,
      minimumFontSize: 18,
      align: 'right',
      foreground: '#f8fafc',
      weight: '500'
    });
    if (!attribution) return base;
    return base.composite([{
      input: attribution.data,
      left: Math.max(24, this.width - attribution.info.width - 36),
      top: Math.max(24, this.height - attribution.info.height - 28)
    }]);
  }

  async renderCue(cue, channelId, outputPath = null) {
    if (!cue || typeof cue !== 'object') throw new TypeError('A compiled cue is required');
    const channel = cue.channels?.[channelId];
    let pipeline;
    let textValue = '';
    if (!channel || channel.mode === 'hide' || channel.blocks?.some(block => block.type === 'blank')) {
      pipeline = this._background('#000000');
    } else {
      const imageBlock = channel.blocks?.find(block => block.type === 'image');
      const bibleBlock = channel.blocks?.find(block => block.type === 'bible');
      const textBlocks = channel.blocks?.filter(block => block.type === 'text') || [];
      const legacyBlock = channel.blocks?.find(block => block.type === 'legacy-deck');
      if (legacyBlock) {
        const error = new Error('Imported PowerPoint items must be reconciled and rendered before native package publication.');
        error.code = 'LEGACY_DECK_REQUIRES_RENDER';
        throw error;
      }
      if (imageBlock) {
        pipeline = await this._renderPicture(imageBlock);
        textValue = imageBlock.altText;
      } else if (bibleBlock) {
        textValue = scriptureFlowText(bibleBlock.verses);
        pipeline = await this._renderTextSlide({
          title: bibleBlock.reference,
          body: textValue,
          presetId: cue.presetId || 'scripture-text'
        });
      } else {
        const localizedTitle = textBlocks.find(block => block.role === 'title')?.text || '';
        const subtitle = textBlocks.find(block => block.role === 'subtitle')?.text || '';
        const credit = textBlocks.find(block => block.role === 'credit')?.text || '';
        if (cue.kind === 'song' && localizedTitle) {
          textValue = localizedTitle;
          pipeline = await this._renderSongTitleSlide({
            title: localizedTitle,
            subtitle,
            credit,
            presetId: cue.presetId
          });
        } else {
          const bodyParts = [];
          const bodySeparator = cue.presetId === 'wotbc-song-stacked' ? '\n' : '\n\n';
          const bodySpans = [];
          let bodyOffset = 0;
          for (const block of textBlocks.filter(
            candidate => candidate.role !== 'title' && candidate.role !== 'credit'
          )) {
            if (!block.text) continue;
            if (bodyParts.length > 0) bodyOffset += bodySeparator.length;
            const blockText = String(block.text);
            bodyParts.push(blockText);
            for (const span of block.spans || []) {
              bodySpans.push({
                ...span,
                start: span.start + bodyOffset,
                end: span.end + bodyOffset
              });
            }
            bodyOffset += blockText.length;
          }
          textValue = bodyParts.join(bodySeparator);
          pipeline = await this._renderTextSlide({
            // Sermon/notice rundown titles are operator-facing. Only an explicit
            // per-output title block belongs on those projected slides.
            title: cue.kind === 'song'
              ? ''
              : (cue.kind === 'sermon' || cue.kind === 'notice'
                  ? localizedTitle
                  : (localizedTitle || cue.title)),
            body: textValue || localizedTitle,
            bodySpans: textValue ? bodySpans : [],
            presetId: cue.presetId
          });
        }
      }
    }
    pipeline = pipeline.flatten({ background: '#000000' }).jpeg({
      quality: this.jpegQuality,
      chromaSubsampling: '4:4:4',
      mozjpeg: false
    });
    let info;
    if (outputPath) {
      info = await pipeline.toFile(outputPath);
    } else {
      const result = await pipeline.toBuffer({ resolveWithObject: true });
      info = result.info;
      info.data = result.data;
    }
    return {
      info,
      metadata: {
        cueId: cue.id,
        title: cue.title,
        kind: cue.kind,
        groupPath: [...(cue.groupPath || [])],
        text: textValue,
        firstLine: meaningfulFirstLine(textValue) || cue.title
      }
    };
  }

  async renderSingerPreview(cue, sourceChannelId, nextCue = null, outputPath = null) {
    const current = await this.renderCue(cue, sourceChannelId);
    const padding = Math.max(8, Math.round(this.width * 0.012));
    const footerHeight = Math.max(68, Math.round(this.height * 0.19));
    const dividerThickness = Math.max(4, Math.round(this.height * 0.011));
    const dividerY = this.height - footerHeight;
    const currentHeight = Math.max(1, dividerY - padding * 2);
    const currentWidth = Math.max(1, this.width - padding * 2);
    const currentImage = await this.sharp(current.info.data)
      .resize(currentWidth, currentHeight, {
        fit: 'contain',
        position: 'centre',
        background: '#0a0a15'
      })
      .jpeg({ quality: this.jpegQuality, chromaSubsampling: '4:4:4' })
      .toBuffer();

    const nextLine = meaningfulFirstLine(cueTextForChannel(nextCue, sourceChannelId));
    const footerText = nextLine || 'End of song';
    const nextLayer = await this._textLayer(footerText, {
      width: this.width * 0.88,
      maxHeight: footerHeight - dividerThickness - padding,
      fontSize: Math.max(20, Math.round(this.height * 0.043)),
      minimumFontSize: Math.max(14, Math.round(this.height * 0.026)),
      foreground: nextLine ? '#f8fafc' : '#6b7280',
      weight: nextLine ? '500' : '400'
    });
    const dashWidth = Math.max(12, Math.round(this.width * 0.025));
    const dashGap = Math.max(8, Math.round(dashWidth * 0.62));
    const divider = Buffer.from(
      `<svg width="${this.width}" height="${dividerThickness}" xmlns="http://www.w3.org/2000/svg">`
      + `<line x1="${padding}" y1="${dividerThickness / 2}" x2="${this.width - padding}" y2="${dividerThickness / 2}" `
      + `stroke="#22d3ee" stroke-width="${dividerThickness}" stroke-dasharray="${dashWidth} ${dashGap}"/>`
      + '</svg>'
    );
    const composites = [
      {
        input: currentImage,
        left: padding,
        top: padding
      },
      {
        input: divider,
        left: 0,
        top: dividerY
      }
    ];
    if (nextLayer) {
      composites.push({
        input: nextLayer.data,
        left: Math.round((this.width - nextLayer.info.width) / 2),
        top: dividerY + dividerThickness
          + Math.max(0, Math.round((footerHeight - dividerThickness - nextLayer.info.height) / 2))
      });
    }
    let pipeline = this._background('#000000')
      .composite(composites)
      .flatten({ background: '#000000' })
      .jpeg({
        quality: this.jpegQuality,
        chromaSubsampling: '4:4:4',
        mozjpeg: false
      });
    let info;
    if (outputPath) {
      info = await pipeline.toFile(outputPath);
    } else {
      const result = await pipeline.toBuffer({ resolveWithObject: true });
      info = result.info;
      info.data = result.data;
    }
    return {
      info,
      metadata: {
        ...current.metadata,
        layout: 'singer-current-next',
        sourceChannelId,
        nextLine
      }
    };
  }
}

module.exports = {
  MAX_RENDER_PIXELS,
  NativeSlideRenderer,
  cueTextForChannel,
  escapePango,
  focalGravity,
  markupLeadingScriptureReferences,
  markupTextSpans,
  normalizeSafeTextSpans,
  normalizeScriptureBookToken,
  splitLeadingScriptureReference,
  meaningfulFirstLine
};
