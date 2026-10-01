'use strict';

const { BibleLibrary } = require('../bible/BibleLibrary');
const { bibleBooks } = require('../bible/BibleBooks');
const { resolveBookId } = require('../../../packages/service-core/node/services/sermon/BibleRange');
const { verseSelectionLabel } = require('../../../packages/service-core/node/services/project/SlideFormatting');

function createOfflinePlannerBible({ installedLibrary } = {}) {
  const library = new BibleLibrary({ maxVerses: 100, installedLibrary });
  return async function lookup(raw) {
    const book = bibleBooks.find(value => resolveBookId(value.name) === raw.bookId);
    if (!book || raw.schemaVersion !== 1 || !['chapter', 'startVerse', 'endVerse'].every(key => Number.isSafeInteger(raw[key]) && raw[key] > 0)) {
      throw new Error('Choose a valid Bible passage.');
    }
    const range = { book: book.name, startChapter: raw.chapter, endChapter: raw.chapter,
      startVerse: raw.startVerse, endVerse: raw.endVerse };
    const translations = raw.translations || { english: 'BSB', russian: 'SYNO-W' };
    let selected = raw.verseNumbers;
    if (selected && (!Array.isArray(selected) || !selected.length || selected.some((n, i) =>
      !Number.isSafeInteger(n) || n < raw.startVerse || n > raw.endVerse || (i && n <= selected[i - 1]))
      || selected[0] !== raw.startVerse || selected.at(-1) !== raw.endVerse)) throw new Error('Choose valid verses in ascending order.');
    const passagesByChannel = {}, sources = {};
    for (const channel of ['english', 'russian']) {
      const result = await library.lookupCanonicalRange(range, { translationId: translations[channel] });
      if (result.status !== 'ok') throw new Error(result.message || 'This Bible edition is not installed on this computer.');
      const passage = result.passage;
      passagesByChannel[channel] = { reference: selected
        ? passage.reference.replace(/\s+\d+:.*$/, ` ${raw.chapter}:${verseSelectionLabel(selected)}`)
        : passage.reference, translationId: passage.translation.id,
        attribution: passage.translation.attribution || 'Berean Standard Bible (BSB); exact text pinned from Heritage Study Bible reader data.',
        verses: passage.verses.filter(verse => !selected || selected.includes(verse.number)).map(({ number, text }) => ({ number, text })) };
      sources[channel] = passage.translation.source?.sourceUrl || 'https://heritage.faith';
    }
    passagesByChannel.media = passagesByChannel.russian;
    const canonical = { schemaVersion: 1, bookId: raw.bookId,
      start: { chapter: raw.chapter, verse: raw.startVerse }, end: { chapter: raw.chapter, verse: raw.endVerse } };
    return { schemaVersion: 1, range: canonical, title: passagesByChannel.english.reference,
      ...(selected ? { verseNumbers: selected } : {}), passagesByChannel, sources };
  };
}

module.exports = { createOfflinePlannerBible };
