'use strict';

// Offsets always refer to the authored text. Layout never inserts indentation,
// joins Scripture words, or shifts saved emphasis ranges.
function sliceSpans(spans = [], start, end) {
  return spans.filter(span => span.start < end && span.end > start)
    .map(span => ({...span, start: Math.max(start, span.start) - start, end: Math.min(end, span.end) - start}));
}
function outlineParagraphs(text = '') {
  const rows = []; let start = 0;
  for (const line of text.split('\n')) {
    const main = line.match(/^((?:[IVXLCDM]+|\d+)[.)])([ \t]+)(.*)$/u);
    const sub = main ? null : line.match(/^(\s*)([A-Za-zА-Яа-яЁё]+[.)])([ \t]+)(.*)$/u);
    if (!main && !sub && rows.length) rows[rows.length - 1].end = start + line.length;
    else {
      const prefix = main ? main[1] + main[2] : sub ? sub[1] + sub[2] + sub[3] : '';
      rows.push({start, end: start + line.length, prefixEnd: start + prefix.length});
    }
    start += line.length + 1;
  }
  return rows;
}
function verseWordRanges(text = '') {
  return [...text.matchAll(/[⁰¹²³⁴⁵⁶⁷⁸⁹]+[ \t\u00a0\u2060]+[^\s⁰¹²³⁴⁵⁶⁷⁸⁹]+/gu)]
    .map(match => ({start: match.index, end: match.index + match[0].length}));
}
module.exports = {sliceSpans, outlineParagraphs, verseWordRanges};
