'use strict';

const fs = require('fs/promises');
const path = require('path');

const { bibleBooks, getBookByName } = require('./BibleBooks');
const {
  getNumberedBookReferenceChoices,
  parseBibleReference,
  resolveBookAliasPrefix
} = require('./BibleReferenceParser');
const {
  DEFAULT_TRANSLATION_ID,
  TRANSLATION_DATA_ROOT,
  getTranslationById,
  normalizeTranslationId
} = require('./BibleTranslations');

const DEFAULT_MAX_VERSES = 12;
const ABSOLUTE_MAX_VERSES = 100;
const SIMPLE_REFERENCE_PART = /^\d+(?:[\s:.]\d+)?$/;
const RANGE_SEPARATOR = /^(.*\d)\s*[-–—]\s*(\d+)\s*$/u;
const CANONICAL_RANGE_FIELDS = Object.freeze([
  'book',
  'startChapter',
  'startVerse',
  'endChapter',
  'endVerse'
]);

class BibleDataError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'BibleDataError';
    this.code = code;
    this.details = details;
  }
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}

function errorResult(code, message, details = {}) {
  return deepFreeze({ status: 'error', code, message, ...details });
}

function formatReference(reference) {
  const chapterReference = `${reference.book} ${reference.chapter}`;
  if (reference.verseStart == null) return chapterReference;
  if (reference.verseEnd === reference.verseStart) {
    return `${chapterReference}:${reference.verseStart}`;
  }
  return `${chapterReference}:${reference.verseStart}–${reference.verseEnd}`;
}

function formatCanonicalRangeReference(range) {
  const start = `${range.book} ${range.startChapter}:${range.startVerse}`;
  if (range.startChapter === range.endChapter) {
    if (range.startVerse === range.endVerse) return start;
    return `${start}–${range.endVerse}`;
  }
  return `${start}–${range.endChapter}:${range.endVerse}`;
}

function normalizeCanonicalRangeInput(input) {
  const isPlainObject = input
    && typeof input === 'object'
    && !Array.isArray(input)
    && (
      Object.getPrototypeOf(input) === Object.prototype
      || Object.getPrototypeOf(input) === null
    );
  if (!isPlainObject) {
    return errorResult(
      'invalid-canonical-range',
      'Canonical Bible range must be a plain object.'
    );
  }

  const keys = Object.keys(input);
  if (
    keys.length !== CANONICAL_RANGE_FIELDS.length
    || CANONICAL_RANGE_FIELDS.some(field => !Object.hasOwn(input, field))
    || keys.some(field => !CANONICAL_RANGE_FIELDS.includes(field))
  ) {
    return errorResult(
      'invalid-canonical-range',
      'Canonical Bible range must contain only book, startChapter, startVerse, endChapter, and endVerse.'
    );
  }

  if (
    typeof input.book !== 'string'
    || !input.book.trim()
    || input.book.trim().length > 80
  ) {
    return errorResult(
      'invalid-canonical-book',
      'Canonical Bible range needs a full book name or canonical abbreviation.'
    );
  }
  const requestedBook = input.book.trim().normalize('NFKC').toLowerCase();
  const book = bibleBooks.find(candidate =>
    candidate.name.normalize('NFKC').toLowerCase() === requestedBook
    || candidate.abbr.normalize('NFKC').toLowerCase() === requestedBook);
  if (!book) {
    return errorResult(
      'invalid-canonical-book',
      `"${input.book.trim()}" is not a canonical Bible book name or abbreviation.`
    );
  }

  for (const field of CANONICAL_RANGE_FIELDS.slice(1)) {
    if (!Number.isSafeInteger(input[field]) || input[field] < 1) {
      return errorResult(
        'invalid-canonical-range',
        `${field} must be a positive integer.`,
        { field }
      );
    }
  }

  if (input.startChapter > book.chapters) {
    return errorResult(
      'chapter-not-found',
      `${book.name} ${input.startChapter} is not a canonical chapter.`,
      { missingChapter: input.startChapter }
    );
  }
  if (input.endChapter > book.chapters) {
    return errorResult(
      'chapter-not-found',
      `${book.name} ${input.endChapter} is not a canonical chapter.`,
      { missingChapter: input.endChapter }
    );
  }
  if (
    input.endChapter < input.startChapter
    || (
      input.endChapter === input.startChapter
      && input.endVerse < input.startVerse
    )
  ) {
    return errorResult(
      'invalid-canonical-range',
      'Canonical Bible range end must not come before its start.'
    );
  }

  return deepFreeze({
    status: 'resolved',
    range: {
      book: book.name,
      bookAbbr: book.abbr,
      startChapter: input.startChapter,
      startVerse: input.startVerse,
      endChapter: input.endChapter,
      endVerse: input.endVerse
    }
  });
}

function splitRangeSuffix(input) {
  const normalizedInput = String(input || '').trim();
  if (!normalizedInput) return null;

  const rangeMatch = normalizedInput.match(RANGE_SEPARATOR);
  if (!rangeMatch) {
    return { baseInput: normalizedInput, verseEnd: null };
  }

  return {
    baseInput: rangeMatch[1].trim(),
    verseEnd: Number.parseInt(rangeMatch[2], 10)
  };
}

function isStrictReferenceSyntax(baseInput, parsedReference, defaultBook) {
  const aliasMatch = resolveBookAliasPrefix(baseInput);
  if (aliasMatch) {
    if (aliasMatch.rest) return SIMPLE_REFERENCE_PART.test(aliasMatch.rest);
    return /^\d\s/.test(parsedReference.book);
  }

  return Boolean(defaultBook) && SIMPLE_REFERENCE_PART.test(baseInput);
}

function normalizeChoice(choice, verseEnd) {
  const verseStart = choice.verse == null ? null : choice.verse;
  const normalized = {
    book: choice.book,
    chapter: choice.chapter,
    verseStart,
    verseEnd: verseStart == null ? null : (verseEnd == null ? verseStart : verseEnd)
  };
  return { ...normalized, reference: formatReference(normalized) };
}

/**
 * Resolve Heritage-style shorthand without reading translation data.
 * Ambiguous numbered-book families are surfaced to the caller and never
 * guessed. A unique family/chapter combination such as "pet4" may resolve to
 * 1 Peter because 2 Peter has only three chapters.
 */
function resolvePassageReference(input, options = {}) {
  const split = splitRangeSuffix(input);
  if (!split) {
    return errorResult('empty-query', 'Enter a Bible reference.');
  }

  const { defaultBook = null, selectedBook = null } = options;
  const rawChoices = getNumberedBookReferenceChoices(split.baseInput);

  if (split.verseEnd != null) {
    const starts = rawChoices.length > 0
      ? rawChoices.map(choice => choice.verse)
      : [parseBibleReference(split.baseInput, defaultBook)?.verse];
    if (starts.every(verse => verse == null)) {
      return errorResult(
        'invalid-range',
        'A verse range needs a starting verse, for example John 3:16-18.'
      );
    }
    if (starts.some(verse => verse != null && split.verseEnd < verse)) {
      return errorResult('invalid-range', 'The ending verse must not come before the starting verse.');
    }
  }

  if (rawChoices.length > 0) {
    const choices = rawChoices.map(choice => normalizeChoice(choice, split.verseEnd));
    if (selectedBook) {
      const normalizedSelection = String(selectedBook).trim().toLowerCase();
      const selected = choices.find(choice => choice.book.toLowerCase() === normalizedSelection);
      if (!selected) {
        return errorResult(
          'invalid-book-choice',
          'Choose one of the books offered for this shortcut.',
          { choices }
        );
      }
      return deepFreeze({ status: 'resolved', reference: selected });
    }

    if (choices.length > 1) {
      return deepFreeze({
        status: 'ambiguous',
        message: 'Which book did you mean?',
        choices
      });
    }

    return deepFreeze({ status: 'resolved', reference: choices[0] });
  }

  const parsed = parseBibleReference(split.baseInput, defaultBook);
  if (!parsed || !isStrictReferenceSyntax(split.baseInput, parsed, defaultBook)) {
    return errorResult('invalid-reference', 'Enter a reference such as John 3:16 or Psalm 23:1-4.');
  }

  const normalized = normalizeChoice(parsed, split.verseEnd);
  return deepFreeze({ status: 'resolved', reference: normalized });
}

function validateMaximum(maxVerses) {
  if (!Number.isInteger(maxVerses) || maxVerses < 1 || maxVerses > ABSOLUTE_MAX_VERSES) {
    throw new TypeError(`maxVerses must be an integer between 1 and ${ABSOLUTE_MAX_VERSES}.`);
  }
  return maxVerses;
}

class BibleLibrary {
  constructor(options = {}) {
    this.dataRoot = path.resolve(options.dataRoot || TRANSLATION_DATA_ROOT);
    this.maxVerses = validateMaximum(options.maxVerses ?? DEFAULT_MAX_VERSES);
    this.readFile = options.readFile || fs.readFile;
    this.indexCache = new Map();
    this.bookCache = new Map();
  }

  clearCache() {
    this.indexCache.clear();
    this.bookCache.clear();
  }

  async _readJson(filePath, context) {
    let source;
    try {
      source = await this.readFile(filePath, 'utf8');
    } catch (error) {
      throw new BibleDataError(
        'data-read-failed',
        `Could not read ${context}.`,
        { cause: error.message }
      );
    }

    try {
      return JSON.parse(source);
    } catch (error) {
      throw new BibleDataError(
        'data-invalid-json',
        `${context} contains invalid JSON.`,
        { cause: error.message }
      );
    }
  }

  async _loadIndex(translationId) {
    if (this.indexCache.has(translationId)) return this.indexCache.get(translationId);

    const loadPromise = (async () => {
      const indexPath = path.join(this.dataRoot, translationId, 'index.json');
      const index = await this._readJson(indexPath, `${translationId} translation index`);

      if (index?.translation !== translationId || !Array.isArray(index.books)) {
        throw new BibleDataError(
          'data-invalid-index',
          `${translationId} translation index has an invalid schema.`
        );
      }

      const books = new Map();
      for (const entry of index.books) {
        const validFile = typeof entry?.file === 'string'
          && path.basename(entry.file) === entry.file
          && /^[a-z0-9-]+\.json$/.test(entry.file);
        if (typeof entry?.name !== 'string' || !validFile || books.has(entry.name)) {
          throw new BibleDataError(
            'data-invalid-index',
            `${translationId} translation index contains an invalid book entry.`
          );
        }
        books.set(entry.name, { ...entry });
      }

      const canonicalEntriesAreComplete = books.size === bibleBooks.length
        && bibleBooks.every(book => {
          const entry = books.get(book.name);
          return entry && entry.chapters === book.chapters;
        });
      if (!canonicalEntriesAreComplete) {
        throw new BibleDataError(
          'data-invalid-index',
          `${translationId} translation index does not match the canonical 66-book structure.`
        );
      }

      return { ...index, books };
    })();

    this.indexCache.set(translationId, loadPromise);
    try {
      return await loadPromise;
    } catch (error) {
      this.indexCache.delete(translationId);
      throw error;
    }
  }

  async _loadBook(translationId, bookName) {
    const cacheKey = `${translationId}:${bookName}`;
    if (this.bookCache.has(cacheKey)) return this.bookCache.get(cacheKey);

    const loadPromise = (async () => {
      const index = await this._loadIndex(translationId);
      const entry = index.books.get(bookName);
      if (!entry) {
        throw new BibleDataError(
          'data-book-missing',
          `${bookName} is missing from the ${translationId} translation data.`
        );
      }

      const bookPath = path.join(this.dataRoot, translationId, entry.file);
      const book = await this._readJson(bookPath, `${translationId} ${bookName}`);
      const bookMeta = getBookByName(bookName);
      const chapterNumbers = new Set();
      const validChapters = Array.isArray(book?.chapters)
        && book.chapters.length === bookMeta?.chapters
        && book.chapters.every(chapter => {
          if (!Number.isInteger(chapter?.number)
            || chapter.number < 1
            || chapter.number > bookMeta.chapters
            || chapterNumbers.has(chapter.number)
            || !Array.isArray(chapter.verses)) {
            return false;
          }
          chapterNumbers.add(chapter.number);
          const verseNumbers = new Set();
          return chapter.verses.every(verse => {
            const validVerse = Number.isInteger(verse?.number)
              && verse.number >= 1
              && !verseNumbers.has(verse.number)
              && typeof verse.text === 'string';
            verseNumbers.add(verse?.number);
            return validVerse;
          });
        });
      if (book?.name !== bookName || !validChapters) {
        throw new BibleDataError(
          'data-invalid-book',
          `${translationId} ${bookName} has an invalid schema.`
        );
      }
      return book;
    })();

    this.bookCache.set(cacheKey, loadPromise);
    try {
      return await loadPromise;
    } catch (error) {
      this.bookCache.delete(cacheKey);
      throw error;
    }
  }

  async lookup(query, options = {}) {
    const translationId = normalizeTranslationId(
      options.translationId || DEFAULT_TRANSLATION_ID
    );
    const translation = getTranslationById(translationId);
    if (!translation) {
      return errorResult(
        'unsupported-translation',
        `Translation "${translationId || options.translationId}" is not available.`
      );
    }

    const resolution = resolvePassageReference(query, options);
    if (resolution.status !== 'resolved') {
      return resolution.status === 'ambiguous'
        ? deepFreeze({ ...resolution, translation })
        : resolution;
    }

    const reference = resolution.reference;
    if (reference.verseStart == null) {
      return deepFreeze({
        status: 'needs-verse',
        message: `Add a verse number to ${reference.reference}.`,
        translation,
        reference
      });
    }

    const verseCount = reference.verseEnd - reference.verseStart + 1;
    if (verseCount > this.maxVerses) {
      return errorResult(
        'range-too-large',
        `Choose ${this.maxVerses} verses or fewer so the passage remains readable on screen.`,
        { maxVerses: this.maxVerses, reference }
      );
    }

    let book;
    try {
      book = await this._loadBook(translationId, reference.book);
    } catch (error) {
      if (!(error instanceof BibleDataError)) throw error;
      return errorResult(
        'translation-data-unavailable',
        `The ${translation.abbr} text could not be loaded.`,
        { dataErrorCode: error.code }
      );
    }

    const chapter = book.chapters.find(item => item.number === reference.chapter);
    if (!chapter || !Array.isArray(chapter.verses)) {
      return errorResult(
        'chapter-not-found',
        `${reference.book} ${reference.chapter} is not available in ${translation.abbr}.`,
        { reference }
      );
    }

    const versesByNumber = new Map(chapter.verses.map(verse => [verse.number, verse]));
    const verses = [];
    for (let number = reference.verseStart; number <= reference.verseEnd; number += 1) {
      const verse = versesByNumber.get(number);
      if (!verse) {
        return errorResult(
          'verse-not-found',
          `${reference.book} ${reference.chapter}:${number} is not available in ${translation.abbr}.`,
          { reference, missingVerse: number }
        );
      }
      if (typeof verse.text !== 'string' || !verse.text.trim()) {
        return errorResult(
          'verse-text-unavailable',
          `${translation.abbr} does not include text for ${reference.book} ${reference.chapter}:${number}. Choose another verse or translation.`,
          { reference, missingVerse: number }
        );
      }
      verses.push({ number, text: verse.text.trim() });
    }

    const passage = {
      translation,
      book: reference.book,
      chapter: reference.chapter,
      verseStart: reference.verseStart,
      verseEnd: reference.verseEnd,
      reference: reference.reference,
      verses
    };

    return deepFreeze({ status: 'ok', passage });
  }

  /**
   * Load a trusted, already-canonicalized same-book range. This deliberately
   * does not invoke the shorthand parser: callers must provide an exact book
   * name/abbreviation and both verse-qualified endpoints.
   *
   * @param {{
   *   book: string,
   *   startChapter: number,
   *   startVerse: number,
   *   endChapter: number,
   *   endVerse: number
   * }} input
   * @param {{ translationId?: 'BSB'|'LSV' }} options
   */
  async lookupCanonicalRange(input, options = {}) {
    const translationId = normalizeTranslationId(
      options.translationId || DEFAULT_TRANSLATION_ID
    );
    const translation = getTranslationById(translationId);
    if (!translation) {
      return errorResult(
        'unsupported-translation',
        `Translation "${translationId || options.translationId}" is not available.`
      );
    }

    const resolution = normalizeCanonicalRangeInput(input);
    if (resolution.status !== 'resolved') return resolution;
    const range = resolution.range;
    const reference = formatCanonicalRangeReference(range);

    let book;
    try {
      book = await this._loadBook(translationId, range.book);
    } catch (error) {
      if (!(error instanceof BibleDataError)) throw error;
      return errorResult(
        'translation-data-unavailable',
        `The ${translation.abbr} text could not be loaded.`,
        { dataErrorCode: error.code }
      );
    }

    const chaptersByNumber = new Map(
      book.chapters.map(chapter => [chapter.number, chapter])
    );
    const verses = [];
    for (
      let chapterNumber = range.startChapter;
      chapterNumber <= range.endChapter;
      chapterNumber += 1
    ) {
      const chapter = chaptersByNumber.get(chapterNumber);
      if (!chapter || !Array.isArray(chapter.verses)) {
        return errorResult(
          'chapter-not-found',
          `${range.book} ${chapterNumber} is not available in ${translation.abbr}.`,
          { reference: range, missingChapter: chapterNumber }
        );
      }

      const versesByNumber = new Map(
        chapter.verses.map(verse => [verse.number, verse])
      );
      const lastVerse = chapter.verses.reduce(
        (maximum, verse) => Math.max(maximum, verse.number),
        0
      );
      const verseStart = chapterNumber === range.startChapter
        ? range.startVerse
        : 1;
      const verseEnd = chapterNumber === range.endChapter
        ? range.endVerse
        : lastVerse;

      for (const endpoint of new Set([verseStart, verseEnd])) {
        if (!versesByNumber.has(endpoint)) {
          return errorResult(
            'verse-not-found',
            `${range.book} ${chapterNumber}:${endpoint} is not available in ${translation.abbr}.`,
            {
              reference: range,
              missingChapter: chapterNumber,
              missingVerse: endpoint
            }
          );
        }
      }

      for (let number = verseStart; number <= verseEnd; number += 1) {
        if (verses.length >= this.maxVerses) {
          return errorResult(
            'range-too-large',
            `Choose ${this.maxVerses} verses or fewer so the passage remains readable on screen.`,
            { maxVerses: this.maxVerses, reference: range }
          );
        }
        const verse = versesByNumber.get(number);
        if (!verse) {
          return errorResult(
            'verse-not-found',
            `${range.book} ${chapterNumber}:${number} is not available in ${translation.abbr}.`,
            {
              reference: range,
              missingChapter: chapterNumber,
              missingVerse: number
            }
          );
        }
        if (typeof verse.text !== 'string' || !verse.text.trim()) {
          return errorResult(
            'verse-text-unavailable',
            `${translation.abbr} does not include text for ${range.book} ${chapterNumber}:${number}. Choose another verse or translation.`,
            {
              reference: range,
              missingChapter: chapterNumber,
              missingVerse: number
            }
          );
        }
        verses.push({
          chapter: chapterNumber,
          number,
          text: verse.text.trim()
        });
      }
    }

    const passage = {
      translation,
      book: range.book,
      bookAbbr: range.bookAbbr,
      start: {
        chapter: range.startChapter,
        verse: range.startVerse
      },
      end: {
        chapter: range.endChapter,
        verse: range.endVerse
      },
      reference,
      verseCount: verses.length,
      verses
    };
    return deepFreeze({ status: 'ok', passage });
  }
}

const defaultLibrary = new BibleLibrary();

function lookupPassage(query, options) {
  return defaultLibrary.lookup(query, options);
}

function lookupCanonicalRange(input, options) {
  return defaultLibrary.lookupCanonicalRange(input, options);
}

module.exports = {
  ABSOLUTE_MAX_VERSES,
  BibleDataError,
  BibleLibrary,
  DEFAULT_MAX_VERSES,
  formatReference,
  lookupCanonicalRange,
  lookupPassage,
  resolvePassageReference
};
