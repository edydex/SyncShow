'use strict';

/*
 * Ported from heritage_study_bible at commit
 * f3cd93ca949a7189db8bade49501a30023e6343c.
 * Copyright (c) 2026 edydex. Licensed under the MIT License; see
 * LICENSE.heritage-study-bible.txt in this directory.
 */

const { bibleBooks, getBookByName } = require('./BibleBooks');

// Common English names and shortcuts accepted by Heritage's reference search.
const extraAliases = {
  'genesis': 'Genesis', 'gen': 'Genesis', 'ge': 'Genesis', 'gn': 'Genesis',
  'exodus': 'Exodus', 'exod': 'Exodus', 'exo': 'Exodus', 'ex': 'Exodus',
  'leviticus': 'Leviticus', 'lev': 'Leviticus', 'le': 'Leviticus', 'lv': 'Leviticus',
  'numbers': 'Numbers', 'num': 'Numbers', 'nu': 'Numbers', 'nm': 'Numbers', 'nb': 'Numbers',
  'deuteronomy': 'Deuteronomy', 'deut': 'Deuteronomy', 'de': 'Deuteronomy', 'dt': 'Deuteronomy',
  'joshua': 'Joshua', 'josh': 'Joshua', 'jos': 'Joshua', 'jsh': 'Joshua',
  'judges': 'Judges', 'judg': 'Judges', 'jdg': 'Judges', 'jdgs': 'Judges',
  'ruth': 'Ruth', 'ru': 'Ruth', 'rth': 'Ruth',
  '1 samuel': '1 Samuel', '1samuel': '1 Samuel', '1 sam': '1 Samuel', '1sam': '1 Samuel', '1 sa': '1 Samuel', '1sa': '1 Samuel',
  '2 samuel': '2 Samuel', '2samuel': '2 Samuel', '2 sam': '2 Samuel', '2sam': '2 Samuel', '2 sa': '2 Samuel', '2sa': '2 Samuel',
  '1 kings': '1 Kings', '1 king': '1 Kings', '1kings': '1 Kings', '1 kin': '1 Kings', '1kin': '1 Kings', '1 kgs': '1 Kings', '1kgs': '1 Kings', '1 ki': '1 Kings', '1ki': '1 Kings',
  '2 kings': '2 Kings', '2 king': '2 Kings', '2kings': '2 Kings', '2 kin': '2 Kings', '2kin': '2 Kings', '2 kgs': '2 Kings', '2kgs': '2 Kings', '2 ki': '2 Kings', '2ki': '2 Kings',
  '1 chronicles': '1 Chronicles', '1 chronicle': '1 Chronicles', '1chronicles': '1 Chronicles', '1 chron': '1 Chronicles', '1chro': '1 Chronicles', '1 chro': '1 Chronicles', '1chron': '1 Chronicles', '1 chr': '1 Chronicles', '1chr': '1 Chronicles', '1 ch': '1 Chronicles',
  '2 chronicles': '2 Chronicles', '2 chronicle': '2 Chronicles', '2chronicles': '2 Chronicles', '2 chron': '2 Chronicles', '2chro': '2 Chronicles', '2 chro': '2 Chronicles', '2chron': '2 Chronicles', '2 chr': '2 Chronicles', '2chr': '2 Chronicles', '2 ch': '2 Chronicles',
  'ezra': 'Ezra', 'ezr': 'Ezra',
  'nehemiah': 'Nehemiah', 'neh': 'Nehemiah', 'ne': 'Nehemiah',
  'esther': 'Esther', 'esth': 'Esther', 'est': 'Esther', 'es': 'Esther',
  'job': 'Job', 'jb': 'Job',
  'psalms': 'Psalms', 'psalm': 'Psalms', 'ps': 'Psalms', 'psa': 'Psalms', 'psm': 'Psalms', 'pss': 'Psalms',
  'proverbs': 'Proverbs', 'prov': 'Proverbs', 'pro': 'Proverbs', 'prv': 'Proverbs', 'pr': 'Proverbs',
  'ecclesiastes': 'Ecclesiastes', 'eccl': 'Ecclesiastes', 'ecc': 'Ecclesiastes', 'ec': 'Ecclesiastes', 'qoh': 'Ecclesiastes',
  'song of solomon': 'Song of Solomon', 'song of songs': 'Song of Solomon', 'song': 'Song of Solomon', 'sos': 'Song of Solomon', 'canticles': 'Song of Solomon',
  'isaiah': 'Isaiah', 'isa': 'Isaiah', 'is': 'Isaiah',
  'jeremiah': 'Jeremiah', 'jer': 'Jeremiah', 'je': 'Jeremiah', 'jr': 'Jeremiah',
  'lamentations': 'Lamentations', 'lam': 'Lamentations', 'la': 'Lamentations',
  'ezekiel': 'Ezekiel', 'ezek': 'Ezekiel', 'eze': 'Ezekiel', 'ez': 'Ezekiel',
  'daniel': 'Daniel', 'dan': 'Daniel', 'da': 'Daniel', 'dn': 'Daniel',
  'hosea': 'Hosea', 'hos': 'Hosea', 'ho': 'Hosea',
  'joel': 'Joel', 'jl': 'Joel',
  'amos': 'Amos', 'am': 'Amos',
  'obadiah': 'Obadiah', 'obad': 'Obadiah', 'ob': 'Obadiah', 'oba': 'Obadiah',
  'jonah': 'Jonah', 'jon': 'Jonah', 'jnh': 'Jonah',
  'micah': 'Micah', 'mic': 'Micah', 'mi': 'Micah',
  'nahum': 'Nahum', 'nah': 'Nahum', 'na': 'Nahum',
  'habakkuk': 'Habakkuk', 'hab': 'Habakkuk',
  'zephaniah': 'Zephaniah', 'zeph': 'Zephaniah', 'zep': 'Zephaniah',
  'haggai': 'Haggai', 'hag': 'Haggai', 'hg': 'Haggai',
  'zechariah': 'Zechariah', 'zech': 'Zechariah', 'zec': 'Zechariah',
  'malachi': 'Malachi', 'mal': 'Malachi', 'ml': 'Malachi',
  'matthew': 'Matthew', 'matt': 'Matthew', 'mat': 'Matthew', 'mt': 'Matthew',
  'mark': 'Mark', 'mrk': 'Mark', 'mk': 'Mark', 'mr': 'Mark',
  'luke': 'Luke', 'lk': 'Luke', 'lu': 'Luke',
  'john': 'John', 'jhn': 'John', 'jn': 'John',
  'acts': 'Acts', 'act': 'Acts', 'ac': 'Acts',
  'romans': 'Romans', 'rom': 'Romans', 'ro': 'Romans', 'rm': 'Romans',
  '1 corinthians': '1 Corinthians', '1corinthians': '1 Corinthians', '1 cor': '1 Corinthians', '1cor': '1 Corinthians', '1 co': '1 Corinthians', '1co': '1 Corinthians',
  '2 corinthians': '2 Corinthians', '2corinthians': '2 Corinthians', '2 cor': '2 Corinthians', '2cor': '2 Corinthians', '2 co': '2 Corinthians', '2co': '2 Corinthians',
  'galatians': 'Galatians', 'gal': 'Galatians', 'ga': 'Galatians',
  'ephesians': 'Ephesians', 'eph': 'Ephesians', 'ep': 'Ephesians',
  'philippians': 'Philippians', 'phil': 'Philippians', 'php': 'Philippians', 'pp': 'Philippians',
  'colossians': 'Colossians', 'col': 'Colossians',
  '1 thessalonians': '1 Thessalonians', '1thessalonians': '1 Thessalonians', '1 thess': '1 Thessalonians', '1thess': '1 Thessalonians', '1 th': '1 Thessalonians', '1th': '1 Thessalonians',
  '2 thessalonians': '2 Thessalonians', '2thessalonians': '2 Thessalonians', '2 thess': '2 Thessalonians', '2thess': '2 Thessalonians', '2 th': '2 Thessalonians', '2th': '2 Thessalonians',
  '1 timothy': '1 Timothy', '1timothy': '1 Timothy', '1 tim': '1 Timothy', '1tim': '1 Timothy', '1 ti': '1 Timothy', '1ti': '1 Timothy',
  '2 timothy': '2 Timothy', '2timothy': '2 Timothy', '2 tim': '2 Timothy', '2tim': '2 Timothy', '2 ti': '2 Timothy', '2ti': '2 Timothy',
  'titus': 'Titus', 'tit': 'Titus',
  'philemon': 'Philemon', 'phlm': 'Philemon', 'phm': 'Philemon',
  'hebrews': 'Hebrews', 'heb': 'Hebrews', 'he': 'Hebrews',
  'james': 'James', 'jas': 'James', 'jm': 'James',
  '1 peter': '1 Peter', '1peter': '1 Peter', '1 pet': '1 Peter', '1pet': '1 Peter', '1 pe': '1 Peter', '1pe': '1 Peter', '1pt': '1 Peter',
  '2 peter': '2 Peter', '2peter': '2 Peter', '2 pet': '2 Peter', '2pet': '2 Peter', '2 pe': '2 Peter', '2pe': '2 Peter', '2pt': '2 Peter',
  '1 john': '1 John', '1john': '1 John', '1 jn': '1 John', '1jn': '1 John', '1 jhn': '1 John',
  '2 john': '2 John', '2john': '2 John', '2 jn': '2 John', '2jn': '2 John', '2 jhn': '2 John',
  '3 john': '3 John', '3john': '3 John', '3 jn': '3 John', '3jn': '3 John', '3 jhn': '3 John',
  'jude': 'Jude', 'jd': 'Jude',
  'revelation': 'Revelation', 'rev': 'Revelation', 're': 'Revelation', 'rv': 'Revelation', 'apocalypse': 'Revelation'
};

const allAliases = { ...extraAliases };
for (const book of bibleBooks) {
  allAliases[book.name.toLowerCase()] = book.name;
  allAliases[book.abbr.toLowerCase()] = book.name;
}

// Every spaced numbered-book alias also accepts its compact form (1 pet -> 1pet).
for (const [alias, book] of Object.entries({ ...allAliases })) {
  if (/^\d\s/.test(alias)) {
    allAliases[alias.replace(/\s+/g, '')] = book;
  }
}

const sortedAliasKeys = Object.keys(allAliases).sort((a, b) => b.length - a.length);

const unnumberedAliases = new Set(
  Object.entries(allAliases)
    .filter(([, book]) => !/^\d\s/.test(book))
    .map(([alias]) => alias)
);

const numberedFamilyAliases = new Map();
for (const [alias, book] of Object.entries(allAliases)) {
  const bookMatch = book.match(/^(\d)\s+(.+)$/);
  const aliasMatch = alias.match(/^\d\s*(.+)$/);
  if (!bookMatch || !aliasMatch) continue;

  const familyAlias = aliasMatch[1].replace(/\s+/g, '');
  if (!familyAlias || unnumberedAliases.has(familyAlias)) continue;

  const entry = numberedFamilyAliases.get(familyAlias) || { books: new Set() };
  entry.books.add(book);
  numberedFamilyAliases.set(familyAlias, entry);
}

const sortedNumberedFamilyAliasKeys = [...numberedFamilyAliases.keys()]
  .sort((a, b) => b.length - a.length);

function resolveBookAliasPrefix(input) {
  const trimmed = String(input || '').trim().toLowerCase();
  if (!trimmed) return null;

  for (const alias of sortedAliasKeys) {
    if (!trimmed.startsWith(alias)) continue;
    const rest = trimmed.slice(alias.length);
    if (rest && !/^[\s\d:.-]/.test(rest)) continue;
    return {
      alias,
      book: allAliases[alias],
      rest: rest.trim()
    };
  }

  return null;
}

function parseChapterVersePart(refPart, bookMeta, options = {}) {
  const { requireWhole = false } = options;
  if (!refPart) return null;

  // Supports 23, 23:1, 23 1, and 23.1.
  const pattern = requireWhole
    ? /^(\d+)(?:[\s:.](\d+))?$/
    : /^(\d+)(?:[\s:.](\d+))?/;
  const match = String(refPart).match(pattern);
  if (!match) return null;

  const chapter = Number.parseInt(match[1], 10);
  const verse = match[2] ? Number.parseInt(match[2], 10) : null;
  if (chapter < 1 || chapter > bookMeta.chapters) return null;

  return { chapter, verse };
}

function getExplicitNumberedPrefixChoices(input) {
  const trimmed = String(input || '').trim().toLowerCase();
  const match = trimmed.match(/^([1-3])\s*([a-z]+)\s*(.*)$/);
  if (!match) return [];

  const [, ordinal, bookPrefix, refPart] = match;
  return bibleBooks
    .filter(book => {
      const numberedName = book.name.match(/^(\d)\s+(.+)$/);
      return numberedName
        && numberedName[1] === ordinal
        && numberedName[2].toLowerCase().startsWith(bookPrefix);
    })
    .map(book => {
      const parsed = refPart
        ? parseChapterVersePart(refPart, book, { requireWhole: true })
        : { chapter: 1, verse: null };
      return parsed ? { book: book.name, ...parsed } : null;
    })
    .filter(Boolean);
}

/**
 * Returns possible references when the leading ordinal is omitted from a
 * numbered-book family. Callers must ask the operator to choose when more than
 * one item is returned; this function intentionally never guesses.
 */
function getNumberedBookReferenceChoices(input) {
  const trimmed = String(input || '').trim().toLowerCase();
  if (!trimmed) return [];

  if (/^\d/.test(trimmed)) {
    return resolveBookAliasPrefix(trimmed)
      ? []
      : getExplicitNumberedPrefixChoices(trimmed);
  }

  for (const alias of sortedNumberedFamilyAliasKeys) {
    if (!trimmed.startsWith(alias)) continue;

    // Preserve separators in inputs such as "pet 1 4". Heritage's current
    // implementation compacts this to "pet14", losing the chapter/verse split.
    const refPart = trimmed.slice(alias.length).trim();
    if (refPart && !/^\d/.test(refPart)) continue;

    const family = numberedFamilyAliases.get(alias);
    const choices = [...family.books]
      .sort((left, right) => (
        bibleBooks.findIndex(book => book.name === left)
        - bibleBooks.findIndex(book => book.name === right)
      ))
      .map(bookName => {
        const book = getBookByName(bookName);
        const parsed = refPart
          ? parseChapterVersePart(refPart, book, { requireWhole: true })
          : { chapter: 1, verse: null };
        return parsed ? { book: bookName, ...parsed } : null;
      })
      .filter(Boolean);

    if (choices.length) return choices;
  }

  return [];
}

function parseBibleReference(input, defaultBook = null) {
  const trimmed = String(input || '').trim().toLowerCase();
  if (!trimmed) return null;

  const aliasMatch = resolveBookAliasPrefix(trimmed);
  if (aliasMatch) {
    const book = getBookByName(aliasMatch.book);
    if (!book) return null;

    if (!aliasMatch.rest) {
      return /^\d\s/.test(book.name)
        ? { book: book.name, chapter: 1, verse: null }
        : null;
    }

    const parsed = parseChapterVersePart(aliasMatch.rest, book);
    return parsed ? { book: book.name, ...parsed } : null;
  }

  const numberedPrefixChoices = getExplicitNumberedPrefixChoices(trimmed);
  if (numberedPrefixChoices.length === 1) return numberedPrefixChoices[0];

  if (defaultBook) {
    const book = getBookByName(defaultBook);
    if (book) {
      const parsed = parseChapterVersePart(trimmed, book, { requireWhole: true });
      if (parsed) return { book: book.name, ...parsed };
    }
  }

  return null;
}

module.exports = {
  getNumberedBookReferenceChoices,
  parseBibleReference,
  resolveBookAliasPrefix
};
