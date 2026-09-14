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
  lookupCanonicalRange,
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

test('loads a canonical cross-chapter range with chapter-qualified immutable verses', async () => {
  const result = await lookupCanonicalRange({
    book: 'Eph',
    startChapter: 3,
    startVerse: 20,
    endChapter: 4,
    endVerse: 2
  });

  assert.equal(result.status, 'ok');
  assert.equal(result.passage.translation.id, 'BSB');
  assert.equal(result.passage.book, 'Ephesians');
  assert.equal(result.passage.bookAbbr, 'Eph');
  assert.deepEqual(result.passage.start, { chapter: 3, verse: 20 });
  assert.deepEqual(result.passage.end, { chapter: 4, verse: 2 });
  assert.equal(result.passage.reference, 'Ephesians 3:20–4:2');
  assert.equal(result.passage.verseCount, 4);
  assert.deepEqual(
    result.passage.verses.map(verse => `${verse.chapter}:${verse.number}`),
    ['3:20', '3:21', '4:1', '4:2']
  );
  assert.match(result.passage.verses[0].text, /immeasurably more/i);
  assert.ok(Object.isFrozen(result));
  assert.ok(Object.isFrozen(result.passage));
  assert.ok(Object.isFrozen(result.passage.start));
  assert.ok(Object.isFrozen(result.passage.end));
  assert.ok(Object.isFrozen(result.passage.verses));
  assert.ok(Object.isFrozen(result.passage.verses[0]));
});

test('canonical range lookup accepts a full book name and an explicit LSV option', async () => {
  const result = await lookupCanonicalRange({
    book: 'Ephesians',
    startChapter: 4,
    startVerse: 1,
    endChapter: 4,
    endVerse: 2
  }, { translationId: 'lsv' });

  assert.equal(result.status, 'ok');
  assert.equal(result.passage.translation.id, 'LSV');
  assert.equal(result.passage.reference, 'Ephesians 4:1–2');
  assert.deepEqual(
    result.passage.verses.map(verse => [verse.chapter, verse.number]),
    [[4, 1], [4, 2]]
  );
});

test('canonical range lookup enforces maxVerses across chapter boundaries', async () => {
  const range = {
    book: 'Eph',
    startChapter: 3,
    startVerse: 20,
    endChapter: 4,
    endVerse: 2
  };
  const result = await new BibleLibrary({ maxVerses: 3 }).lookupCanonicalRange(
    range,
    { translationId: 'BSB' }
  );

  assert.equal(result.status, 'error');
  assert.equal(result.code, 'range-too-large');
  assert.equal(result.maxVerses, 3);

  const exactLimit = await new BibleLibrary({ maxVerses: 4 }).lookupCanonicalRange(
    range,
    { translationId: 'BSB' }
  );
  assert.equal(exactLimit.status, 'ok');
  assert.equal(exactLimit.passage.verseCount, 4);
});

test('canonical range lookup checks every requested verse and translation text exactly', async () => {
  const library = new BibleLibrary({ maxVerses: 100 });
  const bsbOmission = await library.lookupCanonicalRange({
    book: 'John',
    startChapter: 4,
    startVerse: 54,
    endChapter: 5,
    endVerse: 4
  }, { translationId: 'BSB' });
  assert.equal(bsbOmission.status, 'error');
  assert.equal(bsbOmission.code, 'verse-text-unavailable');
  assert.equal(bsbOmission.missingChapter, 5);
  assert.equal(bsbOmission.missingVerse, 4);

  const lsvRange = await library.lookupCanonicalRange({
    book: 'John',
    startChapter: 4,
    startVerse: 54,
    endChapter: 5,
    endVerse: 4
  }, { translationId: 'LSV' });
  assert.equal(lsvRange.status, 'ok');
  assert.equal(lsvRange.passage.verseCount, 5);

  const nonexistentVerse = await library.lookupCanonicalRange({
    book: 'Eph',
    startChapter: 3,
    startVerse: 21,
    endChapter: 4,
    endVerse: 33
  }, { translationId: 'BSB' });
  assert.equal(nonexistentVerse.status, 'error');
  assert.equal(nonexistentVerse.code, 'verse-not-found');
  assert.equal(nonexistentVerse.missingChapter, 4);
  assert.equal(nonexistentVerse.missingVerse, 33);

  const nonexistentStart = await library.lookupCanonicalRange({
    book: 'Eph',
    startChapter: 3,
    startVerse: 99,
    endChapter: 4,
    endVerse: 2
  }, { translationId: 'BSB' });
  assert.equal(nonexistentStart.status, 'error');
  assert.equal(nonexistentStart.code, 'verse-not-found');
  assert.equal(nonexistentStart.missingChapter, 3);
  assert.equal(nonexistentStart.missingVerse, 99);
});

test('canonical range lookup rejects aliases, loose fields, and reversed endpoints', async () => {
  const validEndpoints = {
    startChapter: 3,
    startVerse: 20,
    endChapter: 4,
    endVerse: 2
  };

  assert.equal(
    (await lookupCanonicalRange({ book: 'Ephes', ...validEndpoints })).code,
    'invalid-canonical-book'
  );
  assert.equal(
    (await lookupCanonicalRange({
      book: 'Eph',
      ...validEndpoints,
      selectedBook: 'Ephesians'
    })).code,
    'invalid-canonical-range'
  );
  assert.equal(
    (await lookupCanonicalRange({
      book: 'Eph',
      startChapter: 4,
      startVerse: 2,
      endChapter: 3,
      endVerse: 20
    })).code,
    'invalid-canonical-range'
  );
  assert.equal(
    (await lookupCanonicalRange({
      book: 'Eph',
      startChapter: 7,
      startVerse: 1,
      endChapter: 7,
      endVerse: 1
    })).code,
    'chapter-not-found'
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

test('keeps projected Bible lookups at eight verses while sermon references allow exactly 100', async () => {
  const projectedLibrary = new BibleLibrary({ maxVerses: 8 });
  const sermonReferenceLibrary = new BibleLibrary({ maxVerses: 100 });

  const projectedNine = await projectedLibrary.lookup('Psalm 119:1-9', {
    translationId: 'BSB'
  });
  assert.equal(projectedNine.status, 'error');
  assert.equal(projectedNine.code, 'range-too-large');
  assert.equal(projectedNine.maxVerses, 8);

  const exactHundred = await sermonReferenceLibrary.lookup('Psalm 119:1-100', {
    translationId: 'BSB'
  });
  assert.equal(exactHundred.status, 'ok');
  assert.equal(exactHundred.passage.translation.id, 'BSB');
  assert.equal(exactHundred.passage.verses.length, 100);

  const hundredOne = await sermonReferenceLibrary.lookup('Psalm 119:1-101', {
    translationId: 'BSB'
  });
  assert.equal(hundredOne.status, 'error');
  assert.equal(hundredOne.code, 'range-too-large');
  assert.equal(hundredOne.maxVerses, 100);
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
