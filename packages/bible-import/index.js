'use strict';

// Portable, plain-text interchange. Never repair, translate or fill a verse.
const MAX_BIBLE_IMPORT_BYTES = 24 * 1024 * 1024;
class BibleImportError extends Error {
  constructor(code, message, status = 400) { super(message); this.name = 'BibleImportError'; this.code = code; this.status = status; }
}
const fail = message => { throw new BibleImportError('INVALID_BIBLE_IMPORT', message); };
function keys(value, expected, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).sort().join('|') !== expected.slice().sort().join('|')) fail(`${label} has missing or unsupported fields.`);
}
function text(value, maximum, label) {
  if (typeof value !== 'string' || !value.trim() || value.length > maximum || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/u.test(value)) fail(`${label} must be nonempty plain text (up to ${maximum} characters).`);
  return value;
}
function array(value, maximum, label) {
  if (!Array.isArray(value) || !value.length || value.length > maximum) fail(`${label} is empty or too large.`);
  return value;
}
function integer(value, maximum, label) {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) fail(`${label} is outside the supported range.`);
  return value;
}
function parseBibleImport(source, canonicalBooks) {
  if (typeof source !== 'string' || Buffer.byteLength(source, 'utf8') > MAX_BIBLE_IMPORT_BYTES) throw new BibleImportError('BIBLE_IMPORT_TOO_LARGE', 'Choose a Bible JSON file smaller than 24 MiB.', 413);
  let raw;
  try { raw = JSON.parse(source.replace(/^\uFEFF/, '')); } catch { fail('The file is not valid Bible JSON.'); }
  keys(raw, ['schemaVersion', 'kind', 'translation', 'books'], 'Bible file');
  if (raw.schemaVersion !== 1 || raw.kind !== 'heritage-bible-translation') fail('Use Heritage Bible translation format version 1.');
  const metadata = raw.translation;
  keys(metadata, ['id', 'name', 'language', 'edition', 'attribution', 'sourceUrl', 'license'], 'Translation');
  const id = text(metadata.id, 32, 'Translation ID');
  if (!/^[A-Z][A-Z0-9-]{1,31}$/.test(id) || ['BSB', 'LSV', 'SYNO-W'].includes(id)) fail('Use a unique uppercase translation ID; built-in translations cannot be replaced.');
  const language = text(metadata.language, 35, 'Language');
  if (!/^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/.test(language)) fail('Use a language code such as en, ru or uk.');
  const sourceUrl = text(metadata.sourceUrl, 1000, 'Publisher/source URL');
  try { const url = new URL(sourceUrl); if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) fail('Use an HTTP or HTTPS publisher/source URL without credentials.'); }
  catch { fail('Use a valid publisher/source URL.'); }
  const translation = { id, name: text(metadata.name, 160, 'Translation name'), language,
    edition: text(metadata.edition, 160, 'Edition'), attribution: text(metadata.attribution, 500, 'Attribution'),
    sourceUrl, license: text(metadata.license, 2000, 'License or permission') };
  const seenBooks = new Set();
  let chapterCount = 0, verseCount = 0;
  const books = array(raw.books, 66, 'Books').map(rawBook => {
    keys(rawBook, ['id', 'chapters'], 'Book');
    const canonical = canonicalBooks.find(book => book.id === rawBook.id);
    if (!canonical || seenBooks.has(rawBook.id)) fail('Books must have unique canonical IDs from the 66-book catalog.');
    seenBooks.add(rawBook.id);
    const seenChapters = new Set();
    const chapters = array(rawBook.chapters, canonical.chapters, `${canonical.name} chapters`).map(rawChapter => {
      keys(rawChapter, ['number', 'verses'], 'Chapter');
      const number = integer(rawChapter.number, canonical.chapters, `${canonical.name} chapter`);
      if (seenChapters.has(number)) fail(`Duplicate chapter: ${canonical.name} ${number}.`);
      seenChapters.add(number); chapterCount++;
      const seenVerses = new Set();
      const verses = array(rawChapter.verses, 200, 'Verses').map(rawVerse => {
        keys(rawVerse, ['number', 'text'], 'Verse');
        const verseNumber = integer(rawVerse.number, 200, 'Verse number');
        if (seenVerses.has(verseNumber)) fail(`Duplicate verse: ${canonical.name} ${number}:${verseNumber}.`);
        seenVerses.add(verseNumber); verseCount++;
        return { number: verseNumber, text: text(rawVerse.text, 4000, `${canonical.name} ${number}:${verseNumber}`) };
      }).sort((a, b) => a.number - b.number);
      return { number, verses };
    }).sort((a, b) => a.number - b.number);
    return { id: canonical.id, chapters };
  }).sort((a, b) => canonicalBooks.findIndex(book => book.id === a.id) - canonicalBooks.findIndex(book => book.id === b.id));
  const document = { schemaVersion: 1, kind: 'heritage-bible-translation', translation, books };
  // Counts deliberately describe supplied content, not a claim of completeness.
  const first = books[0];
  const summary = { ...translation, bookCount: books.length, chapterCount, verseCount,
    sample: { bookId: first.id, chapter: first.chapters[0].number, verses: first.chapters[0].verses.slice(0, 3) } };
  return { document, source: JSON.stringify(document), summary };
}
function importedBiblePassage(document, range, reference) {
  if (!range?.start?.verse || !range?.end?.verse || range.start.chapter !== range.end.chapter) fail('Choose exact verses within one chapter.');
  const chapter = document.books.find(book => book.id === range.bookId)?.chapters.find(chapter => chapter.number === range.start.chapter);
  const verses = [];
  for (let number = range.start.verse; number <= range.end.verse; number++) {
    const verse = chapter?.verses.find(candidate => candidate.number === number);
    if (!verse) throw new BibleImportError('BIBLE_VERSE_NOT_INSTALLED', `${document.translation.id} does not contain ${reference}, verse ${number}. Choose another translation or import the correct edition.`, 422);
    verses.push({ number, text: verse.text });
  }
  return { reference, translationId: document.translation.id, attribution: document.translation.attribution, verses };
}
module.exports = { MAX_BIBLE_IMPORT_BYTES, BibleImportError, parseBibleImport, importedBiblePassage };
