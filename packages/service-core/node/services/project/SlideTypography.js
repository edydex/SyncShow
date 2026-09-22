'use strict';

const metrics = require('./NotoSansMetrics.json');
const { resolveNativeTextPreset } = require('./NativePresetCatalog');
const { scriptureDisplay, scriptureCredit } = require('./SlideFormatting');

// These advances come from the bundled Noto Sans font at each displayed weight.
// A small shaping allowance covers kerning and browser/Pango rounding. It is
// independent of viewport size, so all renderers receive the same saved size.
const advanceCache = new Map();
function textWidth(text, size, weight = '500') {
  const table = metrics[String(weight)] || metrics['500'];
  const key = weight + ':' + text;
  let advance = advanceCache.get(key);
  if (advance === undefined) {
    advance = Array.from(text).reduce((width, character) => width + (table[character.codePointAt(0)] ?? .65), 0);
    if (advanceCache.size >= 4096) advanceCache.clear();
    advanceCache.set(key, advance);
  }
  return advance * size * 1.02;
}
function wrappedLines(text, size, width, weight = '500') {
  return String(text).split('\n').reduce((total, paragraph) => {
    let lines = 1, used = 0;
    for (const word of paragraph.split(/\s+/u).filter(Boolean)) {
      const length = textWidth(word, size, weight), gap = used ? textWidth(' ', size, weight) : 0;
      if (used && used + gap + length > width) { lines++; used = 0; }
      used += (used ? gap : 0) + length;
      while (used > width) { lines++; used -= width; }
    }
    return total + lines;
  }, 0);
}
function normalizeTextStyle(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new TypeError('Invalid slide text style.');
  const value = {};
  for (const key of Object.keys(raw)) {
    if (key === 'bodySize') {
      if (!Number.isInteger(raw[key]) || raw[key] < 32 || raw[key] > 160) throw new TypeError('Font size must be between 32 and 160.');
    } else if (['bodyAlign','titleAlign','creditAlign'].includes(key)) {
      if (!['left','center','right'].includes(raw[key])) throw new TypeError('Choose left, center or right alignment.');
    } else throw new TypeError(`Unknown slide text style: ${key}`);
    value[key] = raw[key];
  }
  return value;
}
function textPreset(presetId, style = {}) {
  const preset = {...resolveNativeTextPreset(presetId).render, ...style};
  // A group has already been fitted. Never independently shrink one page again.
  if (style.bodySize) preset.bodyMinimumSize = style.bodySize;
  return preset;
}
function cueBodies(cue) {
  return Object.values(cue.channels).filter(channel => channel.mode !== 'hide').map(channel => {
    const bible = channel.blocks.find(block => block.type === 'bible');
    if (bible) return scriptureDisplay(bible, cue.presetId).text;
    return channel.blocks.filter(block => block.type === 'text' && !['title','credit'].includes(block.role))
      .map(block => block.text).join(cue.presetId === 'wotbc-song-stacked' ? '\n' : '\n\n');
  }).filter(Boolean);
}
function groupFontSize(cues, maximum, minimum) {
  for (let size = maximum; size >= minimum; size--) {
    if (cues.every(cue => {
      const preset = textPreset(cue.presetId);
      const width = 1920 * (preset.bodyWidthPercent || 98) / 100;
      let height = Math.min(preset.bodyHeight, 1080 * (1 - (preset.bodyTopPercent || 2) / 100) - 24);
      if (Object.values(cue.channels).some(channel => channel.blocks.some(block => block.type === 'bible' && scriptureCredit(block)))) {
        height = Math.min(height, 1080 * (.84 - (preset.bodyTopPercent || 2) / 100));
      }
      return cueBodies(cue).every(body => {
        const lines = wrappedLines(body, size, width, preset.bodyWeight);
        return lines * size * (1 + (preset.lineSpacingPercent ?? 8) / 100) <= height
          && (cue.kind !== 'song' || size === minimum || body.split('\n').every(line => textWidth(line, size, preset.bodyWeight) <= width));
      });
    })) return size;
  }
  return minimum;
}

const fittedCache = new Map();
function applyTimelineTypography(project, cues, index) {
  const groups = new Map();
  for (const cue of Object.values(cues)) {
    const item = project.items[cue.itemId];
    if (item?.textStyle) {
      cue.textStyle = {...item.textStyle};
      if (cue.kind === 'song' && cue.presetId.includes('title')) delete cue.textStyle.bodySize;
    }
    if (!cue.presetId.startsWith('wotbc-') || !['song','bible'].includes(cue.kind)
      || cue.presetId.includes('title')) continue;
    const parent = (index.groupPathByItemId[item.id] || []).at(-1)?.id;
    const group = cue.kind === 'song' ? item.id : `${parent || item.id}:${cue.presetId}`;
    if (!groups.has(group)) groups.set(group, []);
    groups.get(group).push(cue);
  }
  for (const entries of groups.values()) {
    const maximum = Math.min(...entries.map(cue => cue.textStyle?.bodySize || textPreset(cue.presetId).bodySize));
    const minimum = entries[0].kind === 'song' ? Math.ceil(maximum * .75) : Math.min(maximum, 42);
    const key = JSON.stringify([maximum, minimum, entries.map(cue => [cue.presetId,cueBodies(cue),Object.values(cue.channels).some(channel => channel.blocks.some(block => block.type === 'bible' && scriptureCredit(block)))])]);
    let size = fittedCache.get(key);
    if (!size) {
      size = groupFontSize(entries, maximum, minimum);
      if (fittedCache.size >= 128) fittedCache.delete(fittedCache.keys().next().value);
      fittedCache.set(key, size);
    }
    for (const cue of entries) cue.textStyle = {...cue.textStyle, bodySize: size};
  }
}
module.exports = {textWidth, wrappedLines, normalizeTextStyle, textPreset, groupFontSize, applyTimelineTypography};
