'use strict';

const DEFAULT_SERMON_EMPHASIS_COLORS = Object.freeze(['#FFC000']);
const MAX_EMPHASIS_COLORS = 16;
const MAX_PPTX_TEXT_SPANS = 256;
const RAISED_DIGIT_WORD_SEPARATOR = '\u202f';
const TEXT_SPAN_FOREGROUND_PATTERN = /^#[0-9a-f]{6}$/iu;
const DIRECT_BOLD_WEIGHTS = Object.freeze(['400', '700']);

class PptxStyledTextError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'PptxStyledTextError';
    this.code = code;
    this.details = Object.freeze({ ...details });
  }
}

function fail(code, message, details = {}) {
  throw new PptxStyledTextError(code, message, details);
}

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function decodeXmlText(value) {
  return String(value || '').replace(
    /&(?:#(\d+)|#x([0-9a-f]+)|amp|lt|gt|quot|apos);/giu,
    (entity, decimal, hexadecimal) => {
      if (decimal || hexadecimal) {
        const codePoint = Number.parseInt(decimal || hexadecimal, decimal ? 10 : 16);
        return Number.isSafeInteger(codePoint) && codePoint <= 0x10ffff
          ? String.fromCodePoint(codePoint)
          : '\ufffd';
      }
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
  const expression = /([A-Za-z_][A-Za-z0-9_.:-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/gu;
  for (const match of String(source || '').matchAll(expression)) {
    attributes[match[1]] = decodeXmlText(match[2] ?? match[3] ?? '');
  }
  return attributes;
}

function normalizeRunColor(value) {
  const normalized = String(value || '').trim().replace(/^#/u, '').toUpperCase();
  const presetColors = {
    BLACK: '000000',
    WHITE: 'FFFFFF',
    YELLOW: 'FFFF00'
  };
  if (presetColors[normalized]) return presetColors[normalized];
  return /^[0-9A-F]{6}$/u.test(normalized) ? normalized : null;
}

function normalizeColorFilter(value, field, maximum = 64) {
  if (value === undefined || value === null) return null;
  const rawColors = Array.isArray(value) ? value : [value];
  if (rawColors.length < 1 || rawColors.length > maximum) {
    fail(
      'INVALID_COLOR_FILTER',
      `${field} must contain 1 to ${maximum} colors.`,
      { field, maximum }
    );
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

function normalizeEmphasisColorFilter(value, field = 'emphasisColors') {
  if (value === undefined) return null;
  if (value === null || (Array.isArray(value) && value.length === 0)) return new Set();
  return normalizeColorFilter(value, field, MAX_EMPHASIS_COLORS);
}

function runColor(runXml) {
  const colorMatch = /<(?:a:srgbClr|a:prstClr)\b([^>]*)\/?>/u.exec(runXml);
  if (!colorMatch) return null;
  return normalizeRunColor(parseXmlAttributes(colorMatch[1]).val);
}

function runWeight(runXml) {
  const propertiesMatch = /<a:rPr\b([^>]*)\/?>/u.exec(runXml);
  if (!propertiesMatch) return null;
  const attributes = parseXmlAttributes(propertiesMatch[1]);
  if (!Object.prototype.hasOwnProperty.call(attributes, 'b')) return null;
  const bold = String(attributes.b).toLowerCase();
  if (['1', 'true', 'on'].includes(bold)) return '700';
  if (['0', 'false', 'off'].includes(bold)) return '400';
  return null;
}

function runBaseline(runXml) {
  const propertiesMatch = /<a:rPr\b([^>]*)\/?>/u.exec(runXml);
  if (!propertiesMatch) return null;
  const rawBaseline = parseXmlAttributes(propertiesMatch[1]).baseline;
  if (rawBaseline === undefined || rawBaseline === '') return null;
  const baseline = Number(rawBaseline);
  return Number.isFinite(baseline) ? baseline : null;
}

function sameInlineStyle(left, right) {
  return left?.foreground === right?.foreground
    && left?.weight === right?.weight;
}

function pushInlineSpan(spans, start, end, style) {
  if (!style || end <= start) return;
  const previous = spans.at(-1);
  if (previous && previous.end === start && sameInlineStyle(previous, style)) {
    previous.end = end;
    return;
  }
  spans.push({
    start,
    end,
    ...(style.foreground ? { foreground: style.foreground } : {}),
    ...(style.weight ? { weight: style.weight } : {})
  });
}

function styledParagraphFromFragments(fragments, maximumCharacters = Number.MAX_SAFE_INTEGER) {
  const characters = [];
  const rawSpans = [];
  let outputLength = 0;
  let previousWasNewline = false;
  let truncated = false;
  outer:
  for (const fragment of fragments) {
    const normalized = String(fragment.text || '').replace(/\r\n?/gu, '\n');
    for (const character of normalized) {
      if (character === '\n' && previousWasNewline) continue;
      if (outputLength + character.length > maximumCharacters) {
        truncated = true;
        break outer;
      }
      const start = outputLength;
      characters.push(character);
      outputLength += character.length;
      pushInlineSpan(rawSpans, start, outputLength, fragment.style);
      previousWasNewline = character === '\n';
    }
  }
  const untrimmed = characters.join('');
  const leading = untrimmed.length - untrimmed.trimStart().length;
  const trailing = untrimmed.trimEnd().length;
  const text = untrimmed.slice(leading, trailing);
  if (!text) return { paragraph: null, truncated };
  const spans = [];
  for (const span of rawSpans) {
    const start = Math.max(span.start, leading);
    const end = Math.min(span.end, trailing);
    if (end <= start) continue;
    pushInlineSpan(spans, start - leading, end - leading, span);
  }
  return {
    paragraph: {
      text,
      ...(spans.length > 0 ? { spans } : {})
    },
    truncated
  };
}

/**
 * Extract PowerPoint text as literal paragraphs with constrained inline style.
 * Only direct run properties are inspected: theme/inherited formatting is
 * deliberately outside this deterministic contract.
 */
function extractStyledParagraphResultFromSlideXml(xml, options = {}) {
  if (typeof xml !== 'string') {
    fail('INVALID_SLIDE_XML', 'PowerPoint slide XML must be text.');
  }
  const includeColors = normalizeColorFilter(options.includeColors, 'includeColors');
  const excludeColors = normalizeColorFilter(options.excludeColors, 'excludeColors');
  const emphasisColors = normalizeEmphasisColorFilter(
    options.emphasisColors,
    'emphasisColors'
  );
  const acceptsRun = color => (!includeColors || (color && includeColors.has(color)))
    && (!excludeColors || !color || !excludeColors.has(color));
  const paragraphs = [];
  let remainingCharacters = options.maximumCharacters ?? Number.MAX_SAFE_INTEGER;
  let truncated = false;
  const paragraphExpression = /<a:p(?:\s[^>]*)?>([\s\S]*?)<\/a:p>/gu;
  for (const paragraphMatch of xml.matchAll(paragraphExpression)) {
    if (paragraphs.length > 0) {
      if (remainingCharacters < 1) {
        truncated = true;
        break;
      }
      remainingCharacters -= 1;
    }
    const fragments = [];
    let sawRun = false;
    let includedField = false;
    let pendingRaisedDigits = false;
    const tokenExpression = /<a:r(?:\s[^>]*)?>([\s\S]*?)<\/a:r>|<a:fld(?:\s[^>]*)?>([\s\S]*?)<\/a:fld>|<a:br(?:\s[^>]*)?(?:\/>|>[\s\S]*?<\/a:br>)|<a:tab(?:\s[^>]*)?\/?>/gu;
    for (const token of paragraphMatch[1].matchAll(tokenExpression)) {
      if (token[1] === undefined) {
        if (token[2] !== undefined) {
          if (options.includeFields === true) {
            const fieldText = [...token[2].matchAll(
              /<a:t(?:\s[^>]*)?>([\s\S]*?)<\/a:t>/gu
            )].map(match => decodeXmlText(match[1])).join('');
            fragments.push({ text: fieldText, style: null });
            includedField = true;
          }
        } else if (/^<a:tab/iu.test(token[0])) {
          if (options.includeTabs === true) {
            fragments.push({ text: ' ', style: null });
          }
        } else {
          fragments.push({ text: '\n', style: null });
        }
        pendingRaisedDigits = false;
        continue;
      }
      sawRun = true;
      const color = runColor(token[1]);
      if (!acceptsRun(color)) {
        pendingRaisedDigits = false;
        continue;
      }
      const textParts = [...token[1].matchAll(/<a:t(?:\s[^>]*)?>([\s\S]*?)<\/a:t>/gu)]
        .map(match => decodeXmlText(match[1]));
      const runText = textParts.join('');
      if (pendingRaisedDigits && /^\p{L}/u.test(runText)) {
        fragments.push({ text: RAISED_DIGIT_WORD_SEPARATOR, style: null });
      }
      const weight = runWeight(token[1]);
      const style = color && emphasisColors?.has(color)
        ? {
            foreground: `#${color.toLowerCase()}`,
            ...(weight ? { weight } : {})
          }
        : null;
      fragments.push({ text: runText, style });
      pendingRaisedDigits = runBaseline(token[1]) > 0 && /^[0-9]+$/u.test(runText);
    }
    if (!sawRun && !includedField && !includeColors) {
      for (const match of paragraphMatch[1].matchAll(
        /<a:t(?:\s[^>]*)?>([\s\S]*?)<\/a:t>/gu
      )) {
        fragments.push({ text: decodeXmlText(match[1]), style: null });
      }
    }
    const extracted = styledParagraphFromFragments(fragments, remainingCharacters);
    if (extracted.paragraph) {
      paragraphs.push(extracted.paragraph);
      remainingCharacters -= extracted.paragraph.text.length;
    }
    else if (options.preserveEmptyParagraphs === true) paragraphs.push({ text: '' });
    if (extracted.truncated) {
      truncated = true;
      break;
    }
  }
  return { paragraphs, truncated };
}

function extractStyledParagraphsFromSlideXml(xml, options = {}) {
  return extractStyledParagraphResultFromSlideXml(xml, options).paragraphs;
}

function joinStyledText(parts, separator = '\n') {
  const selected = Array.isArray(parts) ? parts : [];
  let text = '';
  const spans = [];
  for (const [index, part] of selected.entries()) {
    if (!isRecord(part) || typeof part.text !== 'string') {
      fail('INVALID_STYLED_TEXT', `Styled text part ${index + 1} is invalid.`);
    }
    if (index > 0) text += separator;
    const offset = text.length;
    text += part.text;
    for (const span of part.spans || []) {
      pushInlineSpan(spans, offset + span.start, offset + span.end, span);
    }
  }
  return {
    text,
    ...(spans.length > 0 ? { spans } : {})
  };
}

function splitsSurrogatePair(value, offset) {
  if (offset <= 0 || offset >= value.length) return false;
  const previous = value.charCodeAt(offset - 1);
  const current = value.charCodeAt(offset);
  return previous >= 0xd800
    && previous <= 0xdbff
    && current >= 0xdc00
    && current <= 0xdfff;
}

function normalizePptxTextSpans(raw, authoritativeText, options = {}) {
  const field = options.field || 'PowerPoint text spans';
  const maximumSpans = options.maximumSpans ?? MAX_PPTX_TEXT_SPANS;
  const allowedForegrounds = new Set(
    (options.allowedForegrounds || DEFAULT_SERMON_EMPHASIS_COLORS)
      .map(color => String(color).toLowerCase())
  );
  const allowedWeights = new Set(options.allowedWeights || DIRECT_BOLD_WEIGHTS);
  if (raw === undefined) return [];
  if (!Array.isArray(raw) || raw.length > maximumSpans) {
    fail(
      'TEXT_SPANS_TOO_LARGE',
      `${field} must contain at most ${maximumSpans} ranges.`,
      { field, maximum: maximumSpans }
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
    if (keys.some(key => !['start', 'end', 'foreground', 'weight'].includes(key))) {
      fail(
        'INVALID_TEXT_SPANS',
        `${spanField} contains unsupported style properties.`,
        { field: spanField }
      );
    }
    if (!Number.isSafeInteger(candidate.start)
      || !Number.isSafeInteger(candidate.end)
      || candidate.start < 0
      || candidate.end <= candidate.start
      || candidate.end > authoritativeText.length
      || candidate.start < previousEnd
      || splitsSurrogatePair(authoritativeText, candidate.start)
      || splitsSurrogatePair(authoritativeText, candidate.end)) {
      fail(
        'INVALID_TEXT_SPANS',
        `${spanField} must be a sorted, non-overlapping UTF-16 range inside its text.`,
        { field: spanField }
      );
    }
    if (typeof candidate.foreground !== 'string'
      || !TEXT_SPAN_FOREGROUND_PATTERN.test(candidate.foreground)
      || !allowedForegrounds.has(candidate.foreground.toLowerCase())) {
      fail(
        'INVALID_TEXT_SPANS',
        `${spanField}.foreground is not an allowed direct PowerPoint emphasis color.`,
        { field: `${spanField}.foreground` }
      );
    }
    const span = {
      start: candidate.start,
      end: candidate.end,
      foreground: candidate.foreground.toLowerCase()
    };
    if (candidate.weight !== undefined) {
      if (typeof candidate.weight !== 'string' || !allowedWeights.has(candidate.weight)) {
        fail(
          'INVALID_TEXT_SPANS',
          `${spanField}.weight is not an allowed direct PowerPoint bold value.`,
          { field: `${spanField}.weight` }
        );
      }
      span.weight = candidate.weight;
    }
    normalized.push(span);
    previousEnd = span.end;
  }
  return normalized;
}

function graphemeSegments(value) {
  if (typeof Intl?.Segmenter === 'function') {
    const segmenter = new Intl.Segmenter('en', { granularity: 'grapheme' });
    return [...segmenter.segment(value)].map(entry => ({
      text: entry.segment,
      start: entry.index,
      end: entry.index + entry.segment.length
    }));
  }
  const segments = [];
  let offset = 0;
  for (const character of value) {
    segments.push({ text: character, start: offset, end: offset + character.length });
    offset += character.length;
  }
  return segments;
}

function styleForSegment(segment, spans, state) {
  while (state.index < spans.length && spans[state.index].end <= segment.start) {
    state.index += 1;
  }
  const span = spans[state.index];
  if (!span || span.start > segment.start || span.end < segment.end) return null;
  return {
    foreground: span.foreground,
    ...(span.weight ? { weight: span.weight } : {})
  };
}

function whitespaceToken(character) {
  return character !== '\n' && /[^\S\n]/u.test(character);
}

function uniformStyle(tokens) {
  const first = tokens[0]?.style || null;
  if (!first) return null;
  return tokens.every(token => sameInlineStyle(token.style, first)) ? first : null;
}

function normalizeLineTokens(tokens) {
  const output = [];
  let whitespace = [];
  const flushWhitespace = () => {
    if (!whitespace.length) return;
    if (output.length > 0) {
      output.push({ text: ' ', style: uniformStyle(whitespace) });
    }
    whitespace = [];
  };
  for (const token of tokens) {
    if (whitespaceToken(token.text)) {
      whitespace.push(token);
      continue;
    }
    flushWhitespace();
    output.push(token);
  }
  return output;
}

/**
 * Apply the source extractor's canonical text normalization while rebasing
 * style ranges over the exact normalized UTF-16 string.
 */
function normalizeStyledText(rawText, rawSpans, options = {}) {
  const sourceText = String(rawText ?? '');
  const maximumChars = options.maximumChars ?? Number.MAX_SAFE_INTEGER;
  const maximumSpans = options.maximumSpans ?? MAX_PPTX_TEXT_SPANS;
  const spans = normalizePptxTextSpans(rawSpans, sourceText, {
    field: options.field || 'PowerPoint source spans',
    maximumSpans: Number.MAX_SAFE_INTEGER,
    allowedForegrounds: options.allowedForegrounds,
    allowedWeights: options.allowedWeights
  });
  const tokens = [];
  const spanState = { index: 0 };
  for (const segment of graphemeSegments(sourceText)) {
    const style = styleForSegment(segment, spans, spanState);
    const normalized = segment.text.normalize('NFC').replace(/\r\n?/gu, '\n');
    for (const character of normalized) {
      if (character === '\u0000') continue;
      const text = /[\u0001-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(character)
        ? ' '
        : character;
      tokens.push({ text, style });
    }
  }

  const lines = [[]];
  for (const token of tokens) {
    if (token.text === '\n') lines.push([]);
    else lines.at(-1).push(token);
  }
  const normalizedLines = lines.map(normalizeLineTokens);
  while (normalizedLines.length && normalizedLines[0].length === 0) normalizedLines.shift();
  while (normalizedLines.length && normalizedLines.at(-1).length === 0) normalizedLines.pop();

  const canonicalTokens = [];
  let previousWasEmpty = false;
  for (const line of normalizedLines) {
    const isEmpty = line.length === 0;
    if (isEmpty && previousWasEmpty) continue;
    if (canonicalTokens.length > 0) canonicalTokens.push({ text: '\n', style: null });
    canonicalTokens.push(...line);
    previousWasEmpty = isEmpty;
  }

  let text = '';
  const outputSpans = [];
  let textTruncated = false;
  let spansTruncated = false;
  for (const token of canonicalTokens) {
    if (text.length + token.text.length > maximumChars) {
      textTruncated = true;
      break;
    }
    const start = text.length;
    text += token.text;
    if (!token.style) continue;
    const previous = outputSpans.at(-1);
    if (previous && previous.end === start && sameInlineStyle(previous, token.style)) {
      previous.end = text.length;
      continue;
    }
    if (outputSpans.length >= maximumSpans) {
      spansTruncated = true;
      continue;
    }
    pushInlineSpan(outputSpans, start, text.length, token.style);
  }
  return {
    text,
    ...(outputSpans.length > 0 ? { spans: outputSpans } : {}),
    textTruncated,
    spansTruncated
  };
}

function extractStyledTextFromSlideXml(xml, options = {}) {
  const extracted = extractStyledParagraphResultFromSlideXml(xml, {
    includeFields: true,
    includeTabs: true,
    preserveEmptyParagraphs: true,
    ...options
  });
  return {
    ...joinStyledText(extracted.paragraphs, '\n'),
    truncated: extracted.truncated
  };
}

module.exports = {
  DEFAULT_SERMON_EMPHASIS_COLORS,
  DIRECT_BOLD_WEIGHTS,
  MAX_EMPHASIS_COLORS,
  MAX_PPTX_TEXT_SPANS,
  PptxStyledTextError,
  extractStyledParagraphsFromSlideXml,
  extractStyledTextFromSlideXml,
  joinStyledText,
  normalizePptxTextSpans,
  normalizeStyledText
};
