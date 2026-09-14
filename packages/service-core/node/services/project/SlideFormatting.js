'use strict';

function scriptureFlowText(verses) {
  return (verses || []).map(verse => {
    const marker = String(verse.number).replace(/\d/g, digit => '⁰¹²³⁴⁵⁶⁷⁸⁹'[Number(digit)]);
    return `${marker}\u00a0${String(verse.text).replace(/\s+/g, ' ').trim()}`;
  }).join(' ');
}

function applyTextStyle(text, spans, start, end, patch) {
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end > text.length || start >= end) throw new Error('Select the text to format.');
  const points = [...new Set([0, text.length, start, end, ...spans.flatMap(span => [span.start, span.end])])].sort((a,b) => a-b);
  const result = [];
  for (let i = 0; i < points.length - 1; i++) {
    const from = points[i], to = points[i+1];
    const original = spans.find(span => span.start <= from && span.end >= to);
    let style = original ? { ...original } : {};
    delete style.start; delete style.end;
    if (from >= start && to <= end) {
      if (patch === null) style = {};
      else for (const [key, value] of Object.entries(patch)) {
        if (value === undefined) delete style[key]; else style[key] = value;
      }
    }
    if (!Object.keys(style).length) continue;
    const last = result[result.length - 1];
    const lastStyle = last && Object.fromEntries(Object.entries(last).filter(([key]) => !['start','end'].includes(key)));
    if (last && last.end === from && JSON.stringify(lastStyle) === JSON.stringify(style)) last.end = to;
    else result.push({ start: from, end: to, ...style });
  }
  if (result.length > 256) throw new Error('This slide has too many separate formatting ranges. Clear some formatting first.');
  return result;
}

function remapTextSpans(before, after, spans) {
  if (before === after) return spans;
  let start = 0;
  while (start < before.length && start < after.length && before[start] === after[start]) start++;
  let oldEnd = before.length, newEnd = after.length;
  while (oldEnd > start && newEnd > start && before[oldEnd-1] === after[newEnd-1]) { oldEnd--; newEnd--; }
  const delta = newEnd - oldEnd;
  const parts = [];
  for (const span of spans) {
    if (span.start < start) parts.push({ ...span, end: Math.min(span.end, start) });
    if (span.end > oldEnd) parts.push({ ...span, start: Math.max(span.start, oldEnd) + delta, end: span.end + delta });
  }
  // Keep the style at the replacement's start, but never extend several
  // removed ranges over the same new text. At an insertion boundary the
  // following text retains its style without styling the inserted prefix.
  const inherited = spans.find(span => span.start < start && span.end > start);
  if (newEnd > start && inherited) parts.push({ ...inherited, start, end: newEnd });
  parts.sort((a, b) => a.start - b.start);
  const result = [];
  for (const part of parts.filter(span => span.end > span.start)) {
    const previous = result[result.length - 1];
    const style = span => JSON.stringify(Object.entries(span).filter(([key]) => !['start', 'end'].includes(key)).sort());
    if (previous && previous.end === part.start && style(previous) === style(part)) previous.end = part.end;
    else result.push(part);
  }
  return result;
}
module.exports = { scriptureFlowText, applyTextStyle, remapTextSpans };
