'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  BibleRangeError,
  CANONICAL_BIBLE_BOOKS,
  bibleRangeContains,
  bibleRangesIntersect,
  canonicalBibleChapterVerseMaximum,
  formatBibleRange,
  normalizeBibleRange,
  serializeBibleRange
} = require('../src/services/sermon/BibleRange');
const {
  MAX_SERMON_BODY_BYTES,
  MAX_SERMON_BODY_ENTRY_BYTES,
  SERMON_KIND,
  SERMON_SCHEMA_VERSION,
  SermonDocumentError,
  buildSermonPassageIndex,
  createSermonRevision,
  normalizeSermonDocument,
  parseSermonDocument,
  querySermonsForPassage,
  serializeSermonDocument,
  serializeSermonPassageIndex,
  sermonDocumentSha256,
  upgradeSermonDocument,
  upgradeSermonDocumentV1ToV3,
  upgradeSermonDocumentV2ToV3
} = require('../src/services/sermon/SermonDocument');

const BSB_VERSIFICATION_CONTRACT_SHA256 =
  '878253daa85e874da525fd58cbc5fb22522c30fe494522bf356da3ecbf874069';
const BSB_VERSIFICATION_CONTRACT_PATH = path.join(
  __dirname,
  '../src/services/sermon/bible-versification-bsb-v1.json'
);

function range(bookId, chapter, verseStart, verseEnd = verseStart) {
  return {
    schemaVersion: 1,
    bookId,
    start: { chapter, verse: verseStart },
    end: { chapter, verse: verseEnd }
  };
}

function july26Sermon(overrides = {}) {
  return {
    schemaVersion: 2,
    kind: SERMON_KIND,
    id: 'sermon-2026-07-26-prayer',
    titles: {
      ru: 'Молитва, преображающая Церковь',
      en: 'The Prayer That Transforms the Church'
    },
    defaultLanguage: 'en',
    speaker: {
      id: 'paul-lvutin',
      name: 'Paul Lvutin'
    },
    serviceDate: '2026-07-26',
    series: {
      id: 'from-pain-to-unity',
      titles: {
        en: 'From Pain to Unity',
        ru: 'От боли к единству'
      }
    },
    outline: [{
      id: 'foundation',
      parentId: null,
      kind: 'section',
      titles: {
        en: 'The Foundation of the Prayer',
        ru: 'Основание молитвы'
      }
    }, {
      id: 'content',
      parentId: null,
      kind: 'section',
      titles: {
        en: 'The Content of the Prayer',
        ru: 'Содержание молитвы'
      }
    }, {
      id: 'know-love',
      parentId: 'content',
      kind: 'point',
      titles: {
        en: 'To Know the Love of Christ',
        ru: 'Познать любовь Христову'
      }
    }],
    sources: [{
      id: 'pastor-manuscript',
      kind: 'manuscript',
      fileName: '07-26-26_Молитва, преображающая Церковь.pdf',
      mediaType: 'application/pdf',
      languages: ['ru', 'en'],
      sha256: 'a'.repeat(64),
      sizeBytes: 184320,
      provenance: {
        providedBy: 'Paul Lvutin',
        receivedAt: '2026-07-24T18:30:00Z',
        sourceSystem: 'pastor-email',
        externalId: 'message-2026-07-24'
      }
    }, {
      id: 'english-slide-notes',
      kind: 'slide-notes',
      fileName: '07-26-2026 Service ENG.pptx',
      mediaType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      language: 'en',
      sha256: 'b'.repeat(64),
      sizeBytes: 2200000,
      provenance: {
        providedBy: 'Media team',
        receivedAt: '2026-07-25T16:00:00Z',
        sourceSystem: 'church-drive',
        externalId: ''
      }
    }],
    references: [{
      id: 'primary-eph-3-14-21',
      range: range('Eph', 3, 14, 21),
      role: 'primary',
      source: 'pastor',
      reviewStatus: 'confirmed',
      displayText: 'Ephesians 3:14-21',
      sourceId: 'pastor-manuscript',
      sectionId: null,
      startOffset: null,
      endOffset: null
    }, {
      id: 'mentioned-eph-5-2',
      range: range('Eph', 5, 2),
      role: 'mentioned',
      source: 'manuscript',
      reviewStatus: 'confirmed',
      displayText: 'Ephesians 5:2',
      sourceId: 'pastor-manuscript',
      sectionId: 'foundation',
      startOffset: 1260,
      endOffset: 1276
    }, {
      id: 'suggested-eph-1-19-20',
      range: range('Eph', 1, 19, 20),
      role: 'mentioned',
      source: 'transcript-extraction',
      reviewStatus: 'suggested',
      displayText: 'Ephesians 1:19-20',
      sourceId: null,
      sectionId: 'know-love',
      startOffset: null,
      endOffset: null
    }],
    media: [{
      id: 'website-audio',
      kind: 'audio',
      status: 'ready',
      title: 'Sunday sermon recording',
      language: 'ru',
      mediaType: 'audio/mpeg',
      fileName: null,
      sha256: null,
      sizeBytes: null,
      durationSeconds: 2484.5,
      url: 'https://church.example/sermons/prayer.mp3'
    }],
    publication: {
      status: 'published',
      visibility: 'public',
      publishedAt: '2026-07-26T20:00:00Z',
      canonicalUrl: 'https://church.example/sermons/prayer'
    },
    ...overrides
  };
}

function legacyV1Sermon() {
  return {
    schemaVersion: 1,
    kind: SERMON_KIND,
    id: 'sermon-legacy-v1',
    titles: { en: 'Legacy sermon packet' },
    defaultLanguage: 'en',
    speaker: { id: null, name: 'Pastor Example' },
    serviceDate: '2025-01-05',
    series: null,
    outline: [],
    sources: [{
      id: 'legacy-manuscript',
      kind: 'manuscript',
      fileName: 'legacy-sermon.pdf',
      mediaType: 'application/pdf',
      language: 'en',
      sha256: 'd'.repeat(64),
      sizeBytes: 2048,
      provenance: {
        providedBy: 'Pastor Example',
        receivedAt: '2025-01-04T18:00:00.000Z',
        sourceSystem: 'manual-file-picker',
        externalId: ''
      }
    }],
    references: [],
    media: [],
    publication: {
      status: 'draft',
      visibility: 'private',
      publishedAt: null,
      canonicalUrl: null
    }
  };
}

function expectDocumentCode(code, callback) {
  assert.throws(callback, error => {
    assert.ok(error instanceof SermonDocumentError);
    assert.equal(error.code, code);
    return true;
  });
}

test('BibleRangeV1 exposes the canonical 66-book order and stable OSIS-like ids', () => {
  assert.equal(CANONICAL_BIBLE_BOOKS.length, 66);
  assert.equal(new Set(CANONICAL_BIBLE_BOOKS.map(book => book.id)).size, 66);
  assert.deepEqual(CANONICAL_BIBLE_BOOKS[0], {
    id: 'Gen',
    name: 'Genesis',
    chapters: 50,
    testament: 'OT',
    order: 1
  });
  assert.equal(CANONICAL_BIBLE_BOOKS.at(-1).id, 'Rev');

  const normalized = normalizeBibleRange({
    book: 'Ephesians',
    chapter: 3,
    verse: 14,
    endVerse: 21
  });
  assert.deepEqual(normalized, range('Eph', 3, 14, 21));
  assert.equal(formatBibleRange(normalized), 'Ephesians 3:14-21');
  assert.equal(serializeBibleRange({ ...normalized, bookId: 'eph' }), serializeBibleRange(normalized));
});

test('BibleRangeV1 validates canonical boundaries and calculates intersections', () => {
  assert.equal(
    bibleRangesIntersect(range('Eph', 3, 14, 21), range('Eph', 3, 18)),
    true
  );
  assert.equal(
    bibleRangesIntersect(range('Eph', 3, 14, 21), range('Eph', 5, 2)),
    false
  );
  assert.equal(
    bibleRangesIntersect(range('Eph', 3, 14, 21), range('Phil', 3, 18)),
    false
  );
  assert.throws(
    () => normalizeBibleRange(range('Eph', 3, 21, 14)),
    error => error instanceof BibleRangeError && error.code === 'REVERSED_BIBLE_RANGE'
  );
  assert.throws(
    () => normalizeBibleRange(range('NotABook', 1, 1)),
    error => error instanceof BibleRangeError && error.code === 'UNKNOWN_BIBLE_BOOK'
  );
  assert.throws(
    () => normalizeBibleRange(range('Eph', 7, 1)),
    error => error instanceof BibleRangeError && error.code === 'INVALID_RANGE_NUMBER'
  );
});

test('BibleRangeV1 fails closed at each bundled BSB chapter maximum', () => {
  assert.equal(canonicalBibleChapterVerseMaximum('Genesis', 1), 31);
  assert.equal(canonicalBibleChapterVerseMaximum('Ps', 119), 176);
  assert.equal(canonicalBibleChapterVerseMaximum('Eph', 3), 21);
  assert.equal(canonicalBibleChapterVerseMaximum('Eph', 7), null);
  assert.equal(normalizeBibleRange(range('Eph', 3, 21)).start.verse, 21);

  for (const impossibleVerse of [22, 999]) {
    assert.throws(
      () => normalizeBibleRange(range('Eph', 3, impossibleVerse)),
      error => (
        error instanceof BibleRangeError
        && error.code === 'INVALID_RANGE_NUMBER'
        && error.details.maximum === 21
      )
    );
  }
});

test('BibleRangeV1 matches the shared versioned BSB coordinate vector and local source', () => {
  const contractSource = fs.readFileSync(BSB_VERSIFICATION_CONTRACT_PATH, 'utf8');
  const contract = JSON.parse(contractSource);
  assert.equal(contractSource, `${JSON.stringify(contract)}\n`);
  assert.equal(
    crypto.createHash('sha256').update(contractSource).digest('hex'),
    BSB_VERSIFICATION_CONTRACT_SHA256
  );
  assert.equal(contract.schemaVersion, 1);
  assert.equal(contract.kind, 'heritage-syncshow-bsb-versification');
  assert.equal(contract.sourceTranslation, 'BSB');
  assert.equal(contract.canon, 'protestant-66');
  assert.equal(contract.books.length, 66);
  assert.equal(
    contract.books.reduce((count, book) => count + book.verseMaximums.length, 0),
    1189
  );
  assert.equal(
    contract.books.reduce(
      (count, book) => count + book.verseMaximums.reduce(
        (bookCount, maximum) => bookCount + maximum,
        0
      ),
      0
    ),
    31102
  );

  const bsbDirectory = path.join(__dirname, '../src/services/bible/data/BSB');
  const bsbIndex = JSON.parse(fs.readFileSync(path.join(bsbDirectory, 'index.json'), 'utf8'));
  assert.equal(bsbIndex.books.length, contract.books.length);
  for (const [bookIndex, contractBook] of contract.books.entries()) {
    const canonicalBook = CANONICAL_BIBLE_BOOKS[bookIndex];
    const sourceMetadata = bsbIndex.books[bookIndex];
    assert.equal(contractBook.id, canonicalBook.id);
    assert.equal(contractBook.name, canonicalBook.name);
    assert.equal(sourceMetadata.name, canonicalBook.name);
    assert.equal(contractBook.verseMaximums.length, canonicalBook.chapters);
    assert.equal(sourceMetadata.chapters, canonicalBook.chapters);

    const sourceBook = JSON.parse(fs.readFileSync(
      path.join(bsbDirectory, sourceMetadata.file),
      'utf8'
    ));
    assert.equal(sourceBook.chapters.length, canonicalBook.chapters);
    for (const [chapterIndex, chapter] of sourceBook.chapters.entries()) {
      assert.equal(chapter.number, chapterIndex + 1);
      assert.equal(chapter.verses.at(-1)?.number, contractBook.verseMaximums[chapterIndex]);
      assert.equal(
        canonicalBibleChapterVerseMaximum(canonicalBook.id, chapter.number),
        contractBook.verseMaximums[chapterIndex]
      );
    }
  }
});

test('BibleRangeV1 containment treats null verses as whole-edge boundaries', () => {
  const wholeChapter = range('Eph', 3, null);
  assert.equal(
    bibleRangeContains(wholeChapter, range('Eph', 3, 14, 21)),
    true
  );
  assert.equal(
    bibleRangeContains(range('Eph', 3, 14, 21), wholeChapter),
    false
  );
  assert.equal(
    bibleRangeContains(
      {
        schemaVersion: 1,
        bookId: 'Eph',
        start: { chapter: 3, verse: null },
        end: { chapter: 4, verse: null }
      },
      range('Eph', 4, 1, 8)
    ),
    true
  );
  assert.equal(
    bibleRangeContains(wholeChapter, range('Phil', 3, 14, 21)),
    false
  );
});

test('SermonDocumentV2 canonicalizes bilingual sermon packets into immutable revisions', () => {
  const document = normalizeSermonDocument(july26Sermon());
  assert.equal(document.titles.en, 'The Prayer That Transforms the Church');
  assert.equal(document.titles.ru, 'Молитва, преображающая Церковь');
  assert.equal(document.references[0].range.bookId, 'Eph');
  assert.equal(document.references[0].enteredText, 'Ephesians 3:14-21');
  assert.equal(Object.hasOwn(document.references[0], 'displayText'), false);
  assert.deepEqual(document.sources[0].languages, ['en', 'ru']);
  assert.deepEqual(document.sources[1].languages, ['en']);
  assert.equal(Object.hasOwn(document.sources[1], 'language'), false);
  assert.ok(Object.isFrozen(document));
  assert.ok(Object.isFrozen(document.references[0].range));
  assert.throws(() => {
    document.titles.en = 'Changed after review';
  }, TypeError);

  const source = serializeSermonDocument(document);
  assert.match(source, /"enteredText":"Ephesians 3:14-21"/);
  assert.doesNotMatch(source, /"displayText":/);
  const reparsed = parseSermonDocument(source);
  assert.deepEqual(reparsed, document);
  assert.equal(serializeSermonDocument(reparsed), source);

  const revision = createSermonRevision(document);
  assert.equal(revision.sha256, sermonDocumentSha256(document));
  assert.equal(revision.id, `sha256:${revision.sha256}`);
  assert.equal(revision.source, source);
  assert.ok(Object.isFrozen(revision));
  assert.match(revision.sha256, /^[a-f0-9]{64}$/);
  assert.equal(
    revision.sha256,
    '68044b535426e261a9f07dc75595ab0d04b7ab385f9c718eaa3ff188868f4849'
  );

  const reorderedTopLevel = Object.fromEntries(Object.entries(july26Sermon()).reverse());
  assert.equal(sermonDocumentSha256(reorderedTopLevel), revision.sha256);
});

test('sermon timestamps reject calendar rollover and preserve equivalent offset instants', () => {
  const utc = normalizeSermonDocument(july26Sermon());
  const offsetInput = july26Sermon();
  offsetInput.sources[0].provenance.receivedAt = '2026-07-24T11:30:00-07:00';
  offsetInput.publication.publishedAt = '2026-07-26T22:30:00+02:30';
  const offset = normalizeSermonDocument(offsetInput);

  assert.equal(offset.sources[0].provenance.receivedAt, '2026-07-24T18:30:00.000Z');
  assert.equal(offset.publication.publishedAt, '2026-07-26T20:00:00.000Z');
  assert.equal(sermonDocumentSha256(offset), sermonDocumentSha256(utc));

  const leapDay = july26Sermon();
  leapDay.sources[0].provenance.receivedAt = '2024-02-29T23:59:59.12+14:00';
  assert.equal(
    normalizeSermonDocument(leapDay).sources[0].provenance.receivedAt,
    '2024-02-29T09:59:59.120Z'
  );

  for (const receivedAt of [
    '2026-02-29T12:00:00Z',
    '2026-02-31T12:00:00Z',
    '2026-04-31T12:00:00Z',
    '2026-07-24T24:00:00Z',
    '2026-07-24T18:60:00Z',
    '2026-07-24T18:30:60Z',
    '2026-07-24T18:30:00+24:00'
  ]) {
    const invalid = july26Sermon();
    invalid.sources[0].provenance.receivedAt = receivedAt;
    expectDocumentCode('INVALID_TIMESTAMP', () => normalizeSermonDocument(invalid));
  }
});

test('legacy v1 sermon hashes remain stable and upgrade explicitly to v3 source languages', () => {
  const legacy = legacyV1Sermon();
  const canonicalV1 = serializeSermonDocument(legacy);
  const parsedV1 = parseSermonDocument(canonicalV1);

  assert.equal(parsedV1.schemaVersion, 1);
  assert.equal(parsedV1.sources[0].language, 'en');
  assert.equal(Object.hasOwn(parsedV1.sources[0], 'languages'), false);
  assert.match(canonicalV1, /"language":"en"/);
  assert.doesNotMatch(canonicalV1, /"languages":/);
  assert.equal(
    sermonDocumentSha256(parsedV1),
    'a3f6118c0eb2df75c119c9c3172c26362b449f9d0979b9f0a5fcd143d18bc1ed'
  );

  const upgraded = upgradeSermonDocument(parsedV1);
  assert.equal(upgraded.schemaVersion, SERMON_SCHEMA_VERSION);
  assert.deepEqual(upgraded.body, []);
  assert.deepEqual(upgraded.sources[0].languages, ['en']);
  assert.equal(Object.hasOwn(upgraded.sources[0], 'language'), false);
  assert.notEqual(sermonDocumentSha256(upgraded), sermonDocumentSha256(parsedV1));
});

test('v1 and v2 have distinct lossless upgrades to v3 while old canonical bytes stay fixed', () => {
  const v1 = legacyV1Sermon();
  const v2 = july26Sermon();

  const upgradedV1 = upgradeSermonDocumentV1ToV3(v1);
  assert.equal(upgradedV1.schemaVersion, 3);
  assert.deepEqual(upgradedV1.sources[0].languages, ['en']);
  assert.deepEqual(upgradedV1.body, []);

  const upgradedV2 = upgradeSermonDocumentV2ToV3(v2);
  assert.equal(upgradedV2.schemaVersion, 3);
  assert.deepEqual(upgradedV2.sources[0].languages, ['en', 'ru']);
  assert.deepEqual(upgradedV2.sources[1].languages, ['en']);
  assert.deepEqual(upgradedV2.body, []);
  assert.equal(
    sermonDocumentSha256(v2),
    '68044b535426e261a9f07dc75595ab0d04b7ab385f9c718eaa3ff188868f4849'
  );
  assert.doesNotMatch(serializeSermonDocument(v2), /"body":/);
  assert.match(serializeSermonDocument(upgradedV2), /"body":\[\]/);

  expectDocumentCode(
    'INVALID_UPGRADE_SOURCE',
    () => upgradeSermonDocumentV1ToV3(v2)
  );
  expectDocumentCode(
    'INVALID_UPGRADE_SOURCE',
    () => upgradeSermonDocumentV2ToV3(v1)
  );
});

test('SermonDocumentV3 canonicalizes ordered reviewed body entries and their provenance', () => {
  const document = normalizeSermonDocument({
    ...july26Sermon(),
    schemaVersion: 3,
    body: [{
      id: 'opening',
      kind: 'manuscript',
      language: 'EN',
      sourceId: 'pastor-manuscript',
      sectionId: 'foundation',
      text: 'Cafe\u0301\r\nFirst line\rSecond line\tkept'
    }, {
      id: 'bilingual-notes',
      kind: 'slide-notes',
      language: 'mul',
      sourceId: 'english-slide-notes',
      sectionId: null,
      text: 'English\nРусский'
    }]
  });

  assert.equal(document.schemaVersion, 3);
  assert.deepEqual(document.body.map(entry => entry.id), ['opening', 'bilingual-notes']);
  assert.equal(document.body[0].language, 'en');
  assert.equal(document.body[0].text, 'Café\nFirst line\nSecond line\tkept');
  assert.equal(document.body[1].language, 'mul');
  assert.ok(Object.isFrozen(document.body));
  assert.ok(Object.isFrozen(document.body[0]));
  assert.equal(parseSermonDocument(serializeSermonDocument(document)).body[0].text, document.body[0].text);
});

test('SermonDocumentV3 rejects unsafe, ambiguous, orphaned, and oversized body content', () => {
  const candidate = body => ({
    ...july26Sermon(),
    schemaVersion: 3,
    body
  });
  const entry = {
    id: 'body-one',
    kind: 'manuscript',
    language: 'mul',
    sourceId: 'pastor-manuscript',
    sectionId: 'foundation',
    text: 'Reviewed text'
  };

  expectDocumentCode('DUPLICATE_ID', () => normalizeSermonDocument(candidate([
    entry,
    { ...entry }
  ])));
  expectDocumentCode('UNKNOWN_SOURCE', () => normalizeSermonDocument(candidate([
    { ...entry, sourceId: 'missing-source' }
  ])));
  expectDocumentCode('BODY_SOURCE_KIND_MISMATCH', () => normalizeSermonDocument(candidate([
    { ...entry, kind: 'transcript' }
  ])));
  expectDocumentCode('UNKNOWN_OUTLINE_SECTION', () => normalizeSermonDocument(candidate([
    { ...entry, sectionId: 'missing-section' }
  ])));
  expectDocumentCode('INVALID_BODY_ENTRY', () => normalizeSermonDocument(candidate([
    { ...entry, reviewStatus: 'confirmed' }
  ])));
  expectDocumentCode('UNSAFE_BODY_TEXT', () => normalizeSermonDocument(candidate([
    { ...entry, text: 'Unsafe\u0000text' }
  ])));
  expectDocumentCode('UNSAFE_BODY_TEXT', () => normalizeSermonDocument(candidate([
    { ...entry, text: 'Before\uD800after' }
  ])));
  expectDocumentCode('UNSAFE_BODY_TEXT', () => normalizeSermonDocument(candidate([
    { ...entry, text: 'Before\uDC00after' }
  ])));
  expectDocumentCode('MISSING_BODY_TEXT', () => normalizeSermonDocument(candidate([
    { ...entry, text: ' \n\t ' }
  ])));
  expectDocumentCode('BODY_ENTRY_TOO_LARGE', () => normalizeSermonDocument(candidate([
    { ...entry, text: 'é'.repeat(Math.floor(MAX_SERMON_BODY_ENTRY_BYTES / 2) + 1) }
  ])));
  expectDocumentCode('BODY_TOO_LARGE', () => normalizeSermonDocument(candidate([
    { ...entry, id: 'body-one', text: 'a'.repeat(MAX_SERMON_BODY_ENTRY_BYTES) },
    {
      ...entry,
      id: 'body-two',
      text: 'b'.repeat((MAX_SERMON_BODY_BYTES - MAX_SERMON_BODY_ENTRY_BYTES) + 1)
    }
  ])));
  expectDocumentCode('SERMON_SOURCE_TOO_LARGE', () => normalizeSermonDocument(candidate([
    { ...entry, text: '"'.repeat(MAX_SERMON_BODY_ENTRY_BYTES) }
  ])));

  expectDocumentCode('BODY_REQUIRES_SCHEMA_V3', () => normalizeSermonDocument({
    ...july26Sermon(),
    body: []
  }));
  expectDocumentCode('UNSUPPORTED_SERMON_SCHEMA', () => normalizeSermonDocument({
    ...july26Sermon(),
    schemaVersion: 4
  }));
});

test('source provenance is hash-addressed and cannot persist machine-local paths', () => {
  const source = serializeSermonDocument(july26Sermon());
  assert.equal(source.includes('/Users/'), false);
  assert.equal(source.includes('C:\\'), false);
  assert.match(source, /07-26-26_Молитва, преображающая Церковь\.pdf/);
  assert.match(source, new RegExp(`"sha256":"${'a'.repeat(64)}"`));

  const withLocalPath = july26Sermon();
  withLocalPath.sources[0].localPath = '/Users/pastor/sermon.pdf';
  expectDocumentCode('LOCAL_PATH_NOT_ALLOWED', () => normalizeSermonDocument(withLocalPath));

  const withPathAsName = july26Sermon();
  withPathAsName.sources[0].fileName = 'Downloads/sermon.pdf';
  expectDocumentCode('INVALID_FILE_NAME', () => normalizeSermonDocument(withPathAsName));
});

test('ready and published sermons require a human-confirmed primary passage', () => {
  const suggestedOnly = july26Sermon({
    references: [{
      id: 'possible-primary',
      range: range('Eph', 3, 14, 21),
      role: 'primary',
      source: 'transcript-extraction',
      reviewStatus: 'suggested'
    }]
  });
  expectDocumentCode(
    'MISSING_CONFIRMED_PRIMARY_REFERENCE',
    () => normalizeSermonDocument(suggestedOnly)
  );

  const draft = normalizeSermonDocument({
    ...suggestedOnly,
    publication: {
      status: 'draft',
      visibility: 'private'
    }
  });
  assert.equal(draft.references[0].reviewStatus, 'suggested');
});

test('enteredText is canonical while displayText remains a migration-only input alias', () => {
  const aliased = normalizeSermonDocument(july26Sermon());
  assert.equal(aliased.references[1].enteredText, 'Ephesians 5:2');
  assert.equal(Object.hasOwn(aliased.references[1], 'displayText'), false);

  const conflicting = july26Sermon();
  conflicting.references[0].enteredText = 'Eph. 3:14-21';
  expectDocumentCode(
    'CONFLICTING_ENTERED_TEXT',
    () => normalizeSermonDocument(conflicting)
  );
});

test('publication visibility uses members rather than the former community label', () => {
  const membersOnly = normalizeSermonDocument(july26Sermon({
    publication: {
      status: 'published',
      visibility: 'members',
      publishedAt: '2026-07-26T20:00:00Z'
    }
  }));
  assert.equal(membersOnly.publication.visibility, 'members');
  assert.equal(buildSermonPassageIndex([membersOnly]).entries.length, 0);
  assert.equal(
    buildSermonPassageIndex([membersOnly], { publicOnly: false }).entries.length,
    2
  );

  const obsoleteVisibility = july26Sermon({
    publication: {
      status: 'draft',
      visibility: 'community'
    }
  });
  expectDocumentCode('INVALID_ENUM', () => normalizeSermonDocument(obsoleteVisibility));
});

test('public passage index keeps primary and mentioned roles distinct and excludes suggestions', () => {
  const document = july26Sermon();
  const index = buildSermonPassageIndex([document]);
  assert.equal(index.publicOnly, true);
  assert.deepEqual(index.entries.map(entry => entry.referenceId), [
    'primary-eph-3-14-21',
    'mentioned-eph-5-2'
  ]);
  assert.equal(serializeSermonPassageIndex(index), serializeSermonPassageIndex(
    buildSermonPassageIndex([document])
  ));

  const primaryMatch = querySermonsForPassage(index, range('Eph', 3, 18));
  assert.equal(primaryMatch.primary.length, 1);
  assert.equal(primaryMatch.primary[0].sermonId, document.id);
  assert.equal(primaryMatch.mentioned.length, 0);

  const mentionedMatch = querySermonsForPassage(index, range('Eph', 5, 2));
  assert.equal(mentionedMatch.primary.length, 0);
  assert.equal(mentionedMatch.mentioned.length, 1);
  assert.equal(mentionedMatch.mentioned[0].sermonId, document.id);

  const unconfirmedMatch = querySermonsForPassage(index, range('Eph', 1, 19));
  assert.deepEqual(unconfirmedMatch, { primary: [], mentioned: [] });
});

test('public passage index excludes private or unpublished documents without losing internal confirmed refs', () => {
  const privateDraft = july26Sermon({
    id: 'sermon-private-draft',
    publication: {
      status: 'draft',
      visibility: 'private'
    }
  });
  assert.equal(buildSermonPassageIndex([privateDraft]).entries.length, 0);

  const internalIndex = buildSermonPassageIndex([privateDraft], { publicOnly: false });
  assert.deepEqual(internalIndex.entries.map(entry => entry.referenceId), [
    'primary-eph-3-14-21',
    'mentioned-eph-5-2'
  ]);
});

test('a primary match suppresses the same sermon from Appears-in mentioned results', () => {
  const document = july26Sermon();
  document.references.push({
    id: 'mentioned-overlapping-primary',
    range: range('Eph', 3, 18),
    role: 'mentioned',
    source: 'slide-notes',
    reviewStatus: 'confirmed',
    enteredText: 'Ephesians 3:18',
    sourceId: 'english-slide-notes'
  });

  const results = querySermonsForPassage(
    buildSermonPassageIndex([document]),
    range('Eph', 3, 18)
  );
  assert.equal(results.primary.length, 1);
  assert.equal(results.primary[0].sermonId, document.id);
  assert.deepEqual(results.mentioned, []);
});
