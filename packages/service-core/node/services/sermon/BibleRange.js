'use strict';

const { bibleBooks } = require('../bible/BibleBooks');
const BSB_VERSIFICATION = require('./bible-versification-bsb-v1.json');

const BIBLE_RANGE_SCHEMA_VERSION = 1;

// These identifiers follow the compact OSIS convention already used by the
// Bible service. Keep the mapping explicit so a display-name change cannot
// silently alter persisted sermon references.
const BOOK_IDS_BY_NAME = Object.freeze({
  Genesis: 'Gen',
  Exodus: 'Exod',
  Leviticus: 'Lev',
  Numbers: 'Num',
  Deuteronomy: 'Deut',
  Joshua: 'Josh',
  Judges: 'Judg',
  Ruth: 'Ruth',
  '1 Samuel': '1Sam',
  '2 Samuel': '2Sam',
  '1 Kings': '1Kgs',
  '2 Kings': '2Kgs',
  '1 Chronicles': '1Chr',
  '2 Chronicles': '2Chr',
  Ezra: 'Ezra',
  Nehemiah: 'Neh',
  Esther: 'Esth',
  Job: 'Job',
  Psalms: 'Ps',
  Proverbs: 'Prov',
  Ecclesiastes: 'Eccl',
  'Song of Solomon': 'Song',
  Isaiah: 'Isa',
  Jeremiah: 'Jer',
  Lamentations: 'Lam',
  Ezekiel: 'Ezek',
  Daniel: 'Dan',
  Hosea: 'Hos',
  Joel: 'Joel',
  Amos: 'Amos',
  Obadiah: 'Obad',
  Jonah: 'Jonah',
  Micah: 'Mic',
  Nahum: 'Nah',
  Habakkuk: 'Hab',
  Zephaniah: 'Zeph',
  Haggai: 'Hag',
  Zechariah: 'Zech',
  Malachi: 'Mal',
  Matthew: 'Matt',
  Mark: 'Mark',
  Luke: 'Luke',
  John: 'John',
  Acts: 'Acts',
  Romans: 'Rom',
  '1 Corinthians': '1Cor',
  '2 Corinthians': '2Cor',
  Galatians: 'Gal',
  Ephesians: 'Eph',
  Philippians: 'Phil',
  Colossians: 'Col',
  '1 Thessalonians': '1Thess',
  '2 Thessalonians': '2Thess',
  '1 Timothy': '1Tim',
  '2 Timothy': '2Tim',
  Titus: 'Titus',
  Philemon: 'Phlm',
  Hebrews: 'Heb',
  James: 'Jas',
  '1 Peter': '1Pet',
  '2 Peter': '2Pet',
  '1 John': '1John',
  '2 John': '2John',
  '3 John': '3John',
  Jude: 'Jude',
  Revelation: 'Rev'
});

class BibleRangeError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'BibleRangeError';
    this.code = code;
    this.details = details;
  }
}

function fail(code, message, details = {}) {
  throw new BibleRangeError(code, message, details);
}

if (bibleBooks.length !== 66 || Object.keys(BOOK_IDS_BY_NAME).length !== 66) {
  fail('INVALID_BOOK_CANON', 'The Bible range canon must contain exactly 66 books.');
}
if (
  BSB_VERSIFICATION.schemaVersion !== 1
  || BSB_VERSIFICATION.kind !== 'heritage-syncshow-bsb-versification'
  || BSB_VERSIFICATION.sourceTranslation !== 'BSB'
  || BSB_VERSIFICATION.canon !== 'protestant-66'
  || !Array.isArray(BSB_VERSIFICATION.books)
  || BSB_VERSIFICATION.books.length !== 66
) {
  fail('INVALID_VERSE_CANON', 'The bundled BSB versification contract is invalid.');
}

const CANONICAL_BIBLE_BOOKS = Object.freeze(bibleBooks.map((book, index) => {
  const id = BOOK_IDS_BY_NAME[book.name];
  if (!id) fail('INVALID_BOOK_CANON', `The Bible range canon has no id for ${book.name}.`);
  return Object.freeze({
    id,
    name: book.name,
    chapters: book.chapters,
    testament: book.testament,
    order: index + 1
  });
}));

const BOOK_BY_ID = new Map(CANONICAL_BIBLE_BOOKS.map(book => [book.id, book]));
const BOOK_ID_BY_NORMALIZED_NAME = new Map();
const VERSE_MAXIMUMS_BY_BOOK_ID = new Map();
let greatestCanonicalVerse = 0;

for (const [bookIndex, book] of CANONICAL_BIBLE_BOOKS.entries()) {
  const contractBook = BSB_VERSIFICATION.books[bookIndex];
  if (
    !contractBook
    || contractBook.id !== book.id
    || contractBook.name !== book.name
    || !Array.isArray(contractBook.verseMaximums)
    || contractBook.verseMaximums.length !== book.chapters
    || contractBook.verseMaximums.some(
      maximum => !Number.isSafeInteger(maximum) || maximum < 1
    )
  ) {
    fail(
      'INVALID_VERSE_CANON',
      `The bundled BSB versification is incomplete for ${book.name}.`,
      { bookId: book.id, chapters: book.chapters }
    );
  }
  const verseMaximums = Object.freeze([...contractBook.verseMaximums]);
  VERSE_MAXIMUMS_BY_BOOK_ID.set(book.id, verseMaximums);
  greatestCanonicalVerse = verseMaximums.reduce(
    (greatest, maximum) => Math.max(greatest, maximum),
    greatestCanonicalVerse
  );

  for (const alias of [book.id, book.name]) {
    BOOK_ID_BY_NORMALIZED_NAME.set(
      alias.normalize('NFKC').toLowerCase().replace(/[^a-z0-9]/g, ''),
      book.id
    );
  }
}

const WHOLE_CHAPTER_END_VERSE_POSITION = greatestCanonicalVerse + 1;
const CHAPTER_POSITION_STRIDE = greatestCanonicalVerse + 2;

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const pairs = Object.keys(value)
      .sort()
      .map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`);
    return `{${pairs.join(',')}}`;
  }
  return JSON.stringify(value);
}

function resolveBookId(value) {
  if (typeof value !== 'string') return null;
  const compact = value.normalize('NFKC').toLowerCase().replace(/[^a-z0-9]/g, '');
  return BOOK_ID_BY_NORMALIZED_NAME.get(compact) || null;
}

function canonicalBibleChapterVerseMaximum(bookValue, chapterValue) {
  const bookId = resolveBookId(bookValue);
  if (!bookId || !Number.isSafeInteger(chapterValue)) return null;
  const verseMaximums = VERSE_MAXIMUMS_BY_BOOK_ID.get(bookId);
  if (!verseMaximums || chapterValue < 1 || chapterValue > verseMaximums.length) return null;
  return verseMaximums[chapterValue - 1] ?? null;
}

function normalizeInteger(value, field, minimum, maximum) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    fail('INVALID_RANGE_NUMBER', `${field} must be an integer from ${minimum} through ${maximum}.`, {
      field,
      minimum,
      maximum,
      value
    });
  }
  return value;
}

function normalizeEndpoint(raw, field, book) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    fail('INVALID_RANGE_ENDPOINT', `${field} must contain a chapter and optional verse.`, { field });
  }
  const chapter = normalizeInteger(raw.chapter, `${field}.chapter`, 1, book.chapters);
  const verseMaximum = canonicalBibleChapterVerseMaximum(book.id, chapter);
  if (verseMaximum === null) {
    fail('INVALID_VERSE_CANON', `No canonical verse bounds exist for ${book.name} ${chapter}.`, {
      bookId: book.id,
      chapter
    });
  }
  const verse = raw.verse === undefined || raw.verse === null
    ? null
    : normalizeInteger(raw.verse, `${field}.verse`, 1, verseMaximum);
  return { chapter, verse };
}

function endpointPosition(endpoint, edge) {
  const verse = endpoint.verse === null
    ? (edge === 'start' ? 0 : WHOLE_CHAPTER_END_VERSE_POSITION)
    : endpoint.verse;
  return (endpoint.chapter * CHAPTER_POSITION_STRIDE) + verse;
}

function normalizeBibleRange(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    fail('INVALID_BIBLE_RANGE', 'Bible range must be an object.');
  }
  const schemaVersion = raw.schemaVersion === undefined
    ? BIBLE_RANGE_SCHEMA_VERSION
    : raw.schemaVersion;
  if (schemaVersion !== BIBLE_RANGE_SCHEMA_VERSION) {
    fail(
      'UNSUPPORTED_BIBLE_RANGE_SCHEMA',
      `Bible range schema version ${schemaVersion} is not supported.`,
      { actual: schemaVersion, supported: BIBLE_RANGE_SCHEMA_VERSION }
    );
  }

  const bookId = resolveBookId(raw.bookId || raw.book);
  const book = bookId ? BOOK_BY_ID.get(bookId) : null;
  if (!book) {
    fail('UNKNOWN_BIBLE_BOOK', 'Bible range must use a canonical 66-book id.', {
      bookId: raw.bookId || raw.book || null
    });
  }

  let startSource = raw.start;
  let endSource = raw.end;
  if (!startSource && raw.chapter !== undefined) {
    startSource = { chapter: raw.chapter, verse: raw.verse ?? null };
    endSource = { chapter: raw.endChapter ?? raw.chapter, verse: raw.endVerse ?? raw.verse ?? null };
  }
  const start = normalizeEndpoint(startSource, 'Bible range start', book);
  const end = normalizeEndpoint(endSource || startSource, 'Bible range end', book);
  if (endpointPosition(start, 'start') > endpointPosition(end, 'end')) {
    fail('REVERSED_BIBLE_RANGE', 'Bible range end must not precede its start.', { start, end });
  }

  return {
    schemaVersion: BIBLE_RANGE_SCHEMA_VERSION,
    bookId,
    start,
    end
  };
}

function serializeBibleRange(raw) {
  return `${canonicalJson(normalizeBibleRange(raw))}\n`;
}

function formatBibleRange(raw) {
  const range = normalizeBibleRange(raw);
  const book = BOOK_BY_ID.get(range.bookId);
  const startVerse = range.start.verse === null ? '' : `:${range.start.verse}`;
  if (range.start.chapter === range.end.chapter) {
    if (range.start.verse === range.end.verse) {
      return `${book.name} ${range.start.chapter}${startVerse}`;
    }
    const displayStart = range.start.verse === null ? ':1' : startVerse;
    const displayEnd = range.end.verse === null ? 'end' : range.end.verse;
    return `${book.name} ${range.start.chapter}${displayStart}-${displayEnd}`;
  }
  const endVerse = range.end.verse === null ? '' : `:${range.end.verse}`;
  return `${book.name} ${range.start.chapter}${startVerse}-${range.end.chapter}${endVerse}`;
}

function bibleRangesIntersect(leftRaw, rightRaw) {
  const left = normalizeBibleRange(leftRaw);
  const right = normalizeBibleRange(rightRaw);
  if (left.bookId !== right.bookId) return false;
  return endpointPosition(left.start, 'start') <= endpointPosition(right.end, 'end')
    && endpointPosition(right.start, 'start') <= endpointPosition(left.end, 'end');
}

function bibleRangeContains(containerRaw, candidateRaw) {
  const container = normalizeBibleRange(containerRaw);
  const candidate = normalizeBibleRange(candidateRaw);
  if (container.bookId !== candidate.bookId) return false;
  return endpointPosition(container.start, 'start')
      <= endpointPosition(candidate.start, 'start')
    && endpointPosition(candidate.end, 'end')
      <= endpointPosition(container.end, 'end');
}

function compareBibleRanges(leftRaw, rightRaw) {
  const left = normalizeBibleRange(leftRaw);
  const right = normalizeBibleRange(rightRaw);
  const leftBook = BOOK_BY_ID.get(left.bookId);
  const rightBook = BOOK_BY_ID.get(right.bookId);
  return leftBook.order - rightBook.order
    || endpointPosition(left.start, 'start') - endpointPosition(right.start, 'start')
    || endpointPosition(left.end, 'end') - endpointPosition(right.end, 'end');
}

module.exports = {
  BIBLE_RANGE_SCHEMA_VERSION,
  BibleRangeError,
  CANONICAL_BIBLE_BOOKS,
  bibleRangeContains,
  bibleRangesIntersect,
  canonicalBibleChapterVerseMaximum,
  compareBibleRanges,
  formatBibleRange,
  normalizeBibleRange,
  resolveBookId,
  serializeBibleRange
};
