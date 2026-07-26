'use strict';

const fs = require('fs/promises');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  BibleLibrary,
  DEFAULT_MAX_VERSES,
  DEFAULT_TRANSLATION_ID,
  TRANSLATION_DATA_ROOT,
  getTranslationById,
  lookupPassage,
  resolvePassageReference,
  translations
} = require('../src/services/bible');

test('ships BSB as the immutable default and preserves LSV attribution', () => {
  assert.equal(DEFAULT_TRANSLATION_ID, 'BSB');
  assert.deepEqual(translations.map(translation => translation.id), ['BSB', 'LSV']);
  assert.ok(Object.isFrozen(translations));
  assert.ok(Object.isFrozen(translations[0].source));

  const bsb = getTranslationById('bsb');
  assert.equal(bsb.license, 'Public Domain (CC0)');
  assert.equal(bsb.attributionRequired, false);

  const lsv = getTranslationById('LSV');
  assert.equal(lsv.license, 'CC BY-SA 4.0');
  assert.equal(lsv.attributionRequired, true);
  assert.match(lsv.attribution, /copyright © 2020 Covenant Press/);
  assert.match(lsv.attribution, /Covenant Christian Coalition/);
  assert.match(lsv.attribution, /creativecommons\.org\/licenses\/by-sa\/4\.0/);
  assert.match(lsv.source.modification, /whitespace was normalized/);
});

test('bundled BSB and LSV indexes contain the same canonical 66 books', async () => {
  const translationIds = ['BSB', 'LSV'];
  const indexes = await Promise.all(translationIds.map(async translationId => {
    const indexPath = path.join(TRANSLATION_DATA_ROOT, translationId, 'index.json');
    return JSON.parse(await fs.readFile(indexPath, 'utf8'));
  }));

  for (const [itemIndex, index] of indexes.entries()) {
    assert.equal(index.translation, translationIds[itemIndex]);
    assert.equal(index.books.length, 66);
    assert.equal(new Set(index.books.map(book => book.name)).size, 66);
  }
  assert.deepEqual(
    indexes[0].books.map(book => book.name),
    indexes[1].books.map(book => book.name)
  );
});

test('asks which Peter was meant when the ordinal is omitted', () => {
  assert.deepEqual(resolvePassageReference('pet 1 4'), {
    status: 'ambiguous',
    message: 'Which book did you mean?',
    choices: [
      {
        book: '1 Peter', chapter: 1, verseStart: 4, verseEnd: 4,
        reference: '1 Peter 1:4'
      },
      {
        book: '2 Peter', chapter: 1, verseStart: 4, verseEnd: 4,
        reference: '2 Peter 1:4'
      }
    ]
  });
});

test('resolves explicit and uniquely possible numbered books', () => {
  assert.deepEqual(resolvePassageReference('1 pet 1 4'), {
    status: 'resolved',
    reference: {
      book: '1 Peter', chapter: 1, verseStart: 4, verseEnd: 4,
      reference: '1 Peter 1:4'
    }
  });

  assert.deepEqual(resolvePassageReference('pet4'), {
    status: 'resolved',
    reference: {
      book: '1 Peter', chapter: 4, verseStart: null, verseEnd: null,
      reference: '1 Peter 4'
    }
  });
});

test('an ambiguity choice can be selected explicitly before loading text', async () => {
  const result = await lookupPassage('pet 1 4', { selectedBook: '2 Peter' });

  assert.equal(result.status, 'ok');
  assert.equal(result.passage.reference, '2 Peter 1:4');
  assert.equal(result.passage.translation.id, 'BSB');
  assert.equal(result.passage.verses.length, 1);
  assert.match(result.passage.verses[0].text, /divine nature/i);
});

test('loads a structured BSB passage by default and freezes the result', async () => {
  const result = await lookupPassage('John 3:16-18');

  assert.equal(result.status, 'ok');
  assert.equal(result.passage.translation.id, 'BSB');
  assert.equal(result.passage.reference, 'John 3:16–18');
  assert.equal(result.passage.book, 'John');
  assert.equal(result.passage.chapter, 3);
  assert.equal(result.passage.verseStart, 16);
  assert.equal(result.passage.verseEnd, 18);
  assert.deepEqual(result.passage.verses.map(verse => verse.number), [16, 17, 18]);
  assert.match(result.passage.verses[0].text, /For God so loved the world/);
  assert.ok(Object.isFrozen(result));
  assert.ok(Object.isFrozen(result.passage));
  assert.ok(Object.isFrozen(result.passage.verses));
});

test('loads LSV independently and accepts Unicode range separators', async () => {
  const result = await lookupPassage('John 3:16–18', { translationId: 'lsv' });

  assert.equal(result.status, 'ok');
  assert.equal(result.passage.translation.id, 'LSV');
  assert.deepEqual(result.passage.verses.map(verse => verse.number), [16, 17, 18]);
  assert.notEqual(
    result.passage.verses[0].text,
    (await lookupPassage('John 3:16')).passage.verses[0].text
  );
});

test('requires a verse after resolving a chapter-only shortcut', async () => {
  const result = await lookupPassage('pet4');

  assert.equal(result.status, 'needs-verse');
  assert.equal(result.reference.book, '1 Peter');
  assert.equal(result.reference.chapter, 4);
  assert.match(result.message, /Add a verse number/);
});

test('rejects malformed, reversed, and oversized ranges', async () => {
  assert.equal(resolvePassageReference('John 3:16 trailing').code, 'invalid-reference');
  assert.equal(resolvePassageReference('John 3-4').code, 'invalid-range');
  assert.equal(resolvePassageReference('John 3:18-16').code, 'invalid-range');

  const tooLarge = await lookupPassage(`Psalm 119:1-${DEFAULT_MAX_VERSES + 1}`);
  assert.equal(tooLarge.status, 'error');
  assert.equal(tooLarge.code, 'range-too-large');
  assert.equal(tooLarge.maxVerses, DEFAULT_MAX_VERSES);
});

test('validates requested verses against the selected translation data', async () => {
  const outsideChapter = await lookupPassage('John 3:99');
  assert.equal(outsideChapter.status, 'error');
  assert.equal(outsideChapter.code, 'verse-not-found');
  assert.equal(outsideChapter.missingVerse, 99);

  const bsbOmittedVerse = await lookupPassage('John 5:4');
  assert.equal(bsbOmittedVerse.status, 'error');
  assert.equal(bsbOmittedVerse.code, 'verse-text-unavailable');

  const lsvVerse = await lookupPassage('John 5:4', { translationId: 'LSV' });
  assert.equal(lsvVerse.status, 'ok');
  assert.ok(lsvVerse.passage.verses[0].text.length > 0);
});

test('reports unsupported or unreadable translation data without throwing', async () => {
  const unsupported = await lookupPassage('John 3:16', { translationId: 'unknown' });
  assert.equal(unsupported.status, 'error');
  assert.equal(unsupported.code, 'unsupported-translation');

  const missingData = new BibleLibrary({ dataRoot: path.join(__dirname, 'missing-bible-data') });
  const unavailable = await missingData.lookup('John 3:16');
  assert.equal(unavailable.status, 'error');
  assert.equal(unavailable.code, 'translation-data-unavailable');
  assert.equal(unavailable.dataErrorCode, 'data-read-failed');
});

test('caches each translation index and book after first use', async () => {
  let reads = 0;
  const library = new BibleLibrary({
    readFile: async (...args) => {
      reads += 1;
      return fs.readFile(...args);
    }
  });

  assert.equal((await library.lookup('John 3:16')).status, 'ok');
  assert.equal((await library.lookup('John 3:17')).status, 'ok');
  assert.equal(reads, 2);

  assert.equal((await library.lookup('Romans 8:1')).status, 'ok');
  assert.equal(reads, 3);

  library.clearCache();
  assert.equal((await library.lookup('John 3:18')).status, 'ok');
  assert.equal(reads, 5);
});
