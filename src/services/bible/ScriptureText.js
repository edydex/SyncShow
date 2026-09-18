'use strict';

const SUPERSCRIPT_DIGITS = '⁰¹²³⁴⁵⁶⁷⁸⁹';

/** Project Scripture as a continuous paragraph with quiet, raised verse
 * markers. The pinned source verses and their checksums remain untouched.
 * Unicode superscripts work in both raster and live text renderers without
 * admitting markup or changing the native scene schema. */
function scriptureFlowText(verses) {
  return (verses || []).map(verse => {
    const marker = String(verse.number).replace(/\d/g, digit => SUPERSCRIPT_DIGITS[Number(digit)]);
    return `${marker}\u00a0${String(verse.text).replace(/\s+/g, ' ').trim()}`;
  }).join(' ');
}

module.exports = { scriptureFlowText };
