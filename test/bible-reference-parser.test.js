'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { bibleBooks } = require('../src/services/bible/BibleBooks');
const {
  getNumberedBookReferenceChoices,
  parseBibleReference,
  resolveBookAliasPrefix
} = require('../src/services/bible/BibleReferenceParser');

test('parses ordinary book, chapter, and verse shortcuts', () => {
  assert.deepEqual(parseBibleReference('Psalm 23:1'), {
    book: 'Psalms', chapter: 23, verse: 1
  });
  assert.deepEqual(parseBibleReference('Jn 3 16'), {
    book: 'John', chapter: 3, verse: 16
  });
  assert.deepEqual(parseBibleReference('10:4', 'Romans'), {
    book: 'Romans', chapter: 10, verse: 4
  });
});

test('parses explicit numbered books without guessing', () => {
  assert.deepEqual(parseBibleReference('1 pet 1 4'), {
    book: '1 Peter', chapter: 1, verse: 4
  });
  assert.deepEqual(parseBibleReference('2pet1:4'), {
    book: '2 Peter', chapter: 1, verse: 4
  });
  assert.deepEqual(parseBibleReference('2thes 2'), {
    book: '2 Thessalonians', chapter: 2, verse: null
  });
});

test('offers both Peters when an ordinal is omitted', () => {
  assert.deepEqual(getNumberedBookReferenceChoices('pet2'), [
    { book: '1 Peter', chapter: 2, verse: null },
    { book: '2 Peter', chapter: 2, verse: null }
  ]);
  assert.deepEqual(getNumberedBookReferenceChoices('pet 1 4'), [
    { book: '1 Peter', chapter: 1, verse: 4 },
    { book: '2 Peter', chapter: 1, verse: 4 }
  ]);
});

test('filters numbered-family choices by valid chapter', () => {
  assert.deepEqual(getNumberedBookReferenceChoices('thess4'), [
    { book: '1 Thessalonians', chapter: 4, verse: null }
  ]);
  assert.deepEqual(getNumberedBookReferenceChoices('pet4'), [
    { book: '1 Peter', chapter: 4, verse: null }
  ]);
});

test('does not reinterpret an exact numbered book or unnumbered John', () => {
  assert.deepEqual(getNumberedBookReferenceChoices('1pet2'), []);
  assert.deepEqual(getNumberedBookReferenceChoices('john2'), []);
});

test('returns multiple choices for an ambiguous explicit prefix', () => {
  assert.deepEqual(getNumberedBookReferenceChoices('1 c 2'), [
    { book: '1 Chronicles', chapter: 2, verse: null },
    { book: '1 Corinthians', chapter: 2, verse: null }
  ]);
});

test('supports compact canonical names and abbreviations for every numbered book', () => {
  const numberedBooks = bibleBooks.filter(book => /^\d\s/.test(book.name));

  for (const book of numberedBooks) {
    const chapter = Math.min(2, book.chapters);
    assert.deepEqual(parseBibleReference(`${book.name.replace(/\s+/g, '')}${chapter}`), {
      book: book.name, chapter, verse: null
    });
    assert.deepEqual(parseBibleReference(`${book.abbr.replace(/\s+/g, '')}${chapter}`), {
      book: book.name, chapter, verse: null
    });
  }
});

test('rejects alias collisions, invalid chapters, and non-references', () => {
  assert.equal(resolveBookAliasPrefix('johnny 3:16'), null);
  assert.equal(parseBibleReference('Obadiah 2'), null);
  assert.equal(parseBibleReference('Genesis'), null);
  assert.equal(parseBibleReference('faith hope love'), null);
  assert.equal(parseBibleReference(null), null);
});
