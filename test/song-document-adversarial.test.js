'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  MAX_ATTRIBUTION_LENGTH,
  MAX_SOURCE_BYTES,
  SONG_SCHEMA_VERSION,
  SongDocumentError,
  canonicalizeSongDocumentSectionIds,
  compareSongSections,
  normalizeSongDocument,
  parseSongArrangement,
  parseSongDocument,
  serializeSongDocument
} = require('../src/services/project/SongDocument');

function expectCode(code, callback) {
  assert.throws(callback, error => {
    assert.ok(error instanceof SongDocumentError, `expected SongDocumentError, received ${error?.constructor?.name}`);
    assert.equal(error.code, code);
    return true;
  });
}

function makeRawSong(overrides = {}) {
  return {
    schemaVersion: SONG_SCHEMA_VERSION,
    id: 'test-song',
    title: 'Test Song',
    language: 'en',
    translationOf: null,
    license: '',
    tags: [],
    authors: [],
    translators: [],
    composers: [],
    source: '',
    extraMetadata: {},
    sections: [{
      id: 'verse-1',
      marker: '1',
      label: 'Verse 1',
      slides: [{ lines: ['A lyric'] }]
    }],
    ...overrides
  };
}

function withoutSourceHash(song) {
  const clone = structuredClone(song);
  delete clone.sourceHash;
  return clone;
}

test('Unicode metadata, scalar quoting, arrays, and safe prototype-looking keys round-trip canonically', () => {
  delete Object.prototype.polluted;
  const source = '\uFEFF---\r\n'
    + 'id: blahodat\r\n'
    + 'title: "Благодать: пісня"\r\n'
    + 'language: uk\r\n'
    + 'translationOf: amazing-grace\r\n'
    + 'license: "Public Domain: verified"\r\n'
    + 'tags: ["милість", "worship", "МИЛІСТЬ"]\r\n'
    + 'authors: ["John Newton"]\r\n'
    + 'translators: ["Олександр"]\r\n'
    + 'composers: ["Traditional melody"]\r\n'
    + 'source: "Архів #42"\r\n'
    + 'zeta: "line\\n---\\n^not-a-section"\r\n'
    + 'constructor: harmless\r\n'
    + 'toString: "also harmless"\r\n'
    + 'alpha: \'O\'\'Brien\'\r\n'
    + '---\r\n\r\n'
    + '^1\r\n'
    + 'О благодать, спасенний я\r\n';

  const parsed = parseSongDocument(source, { fileName: 'ignored-name.md' });
  assert.equal(parsed.title, 'Благодать: пісня');
  assert.equal(parsed.translationOf, 'amazing-grace');
  assert.deepEqual(parsed.tags, ['милість', 'worship']);
  assert.deepEqual(parsed.authors, ['John Newton']);
  assert.deepEqual(parsed.translators, ['Олександр']);
  assert.deepEqual(parsed.composers, ['Traditional melody']);
  assert.deepEqual(parsed.extraMetadata, {
    zeta: 'line\n---\n^not-a-section',
    constructor: 'harmless',
    toString: 'also harmless',
    alpha: "O'Brien"
  });
  assert.equal(Object.prototype.polluted, undefined);

  const canonical = serializeSongDocument(parsed);
  assert.ok(canonical.indexOf('alpha:') < canonical.indexOf('constructor:'));
  assert.ok(canonical.indexOf('constructor:') < canonical.indexOf('toString:'));
  assert.ok(canonical.indexOf('toString:') < canonical.indexOf('zeta:'));
  const reparsed = parseSongDocument(canonical);
  assert.deepEqual(withoutSourceHash(reparsed), withoutSourceHash(parsed));
  assert.equal(reparsed.sourceHash, parsed.sourceHash);
  assert.equal(serializeSongDocument(reparsed), canonical);
  assert.equal(Object.prototype.polluted, undefined);
});

test('legacy music metadata is promoted to a distinct composer credit', () => {
  const parsed = parseSongDocument([
    '---',
    'id: old-hymn',
    'title: Old Hymn',
    'language: en',
    'authors: ["Words Author"]',
    'translators: ["Translation Author"]',
    'music: ["Tune Composer"]',
    '---',
    '^1',
    'A lyric'
  ].join('\n'));

  assert.deepEqual(parsed.authors, ['Words Author']);
  assert.deepEqual(parsed.translators, ['Translation Author']);
  assert.deepEqual(parsed.composers, ['Tune Composer']);
  const canonical = serializeSongDocument(parsed);
  assert.match(canonical, /authors: \["Words Author"\]/);
  assert.match(canonical, /translators: \["Translation Author"\]/);
  assert.match(canonical, /composers: \["Tune Composer"\]/);
  assert.doesNotMatch(canonical, /^music:/m);
});

test('attribution is first-class while retaining the legacy extension-block canonical bytes', () => {
  const legacy = normalizeSongDocument(makeRawSong({
    source: 'Church archive',
    extraMetadata: {
      zeta: 'last',
      attribution: 'Public Domain',
      alpha: 'first'
    }
  }));

  assert.equal(legacy.attribution, 'Public Domain');
  assert.deepEqual(legacy.extraMetadata, {
    zeta: 'last',
    alpha: 'first'
  });
  const canonical = serializeSongDocument(legacy);
  assert.equal(canonical, [
    '---',
    'id: test-song',
    'title: Test Song',
    'language: en',
    'source: Church archive',
    'alpha: first',
    'attribution: Public Domain',
    'zeta: last',
    '---',
    '',
    '^1',
    'A lyric',
    ''
  ].join('\n'));

  const reparsed = parseSongDocument(canonical);
  assert.equal(reparsed.attribution, 'Public Domain');
  assert.deepEqual(reparsed.extraMetadata, { alpha: 'first', zeta: 'last' });
  assert.equal(serializeSongDocument(reparsed), canonical);

  expectCode('DUPLICATE_ATTRIBUTION', () => normalizeSongDocument(makeRawSong({
    attribution: 'Credit A',
    extraMetadata: { attribution: 'Credit B' }
  })));
  const longLegacyCredit = normalizeSongDocument(makeRawSong({
    extraMetadata: { attribution: 'x'.repeat(MAX_ATTRIBUTION_LENGTH) }
  }));
  assert.equal(longLegacyCredit.attribution.length, MAX_ATTRIBUTION_LENGTH);
  assert.equal(
    parseSongDocument(serializeSongDocument(longLegacyCredit)).attribution,
    longLegacyCredit.attribution
  );
  expectCode('TEXT_TOO_LONG', () => normalizeSongDocument(makeRawSong({
    attribution: 'x'.repeat(MAX_ATTRIBUTION_LENGTH + 1)
  })));
});

test('front matter cannot use a __proto__ key or escape into projected sections', () => {
  delete Object.prototype.polluted;
  expectCode('INVALID_FRONT_MATTER', () => parseSongDocument([
    '---',
    'title: Safe title',
    '__proto__: polluted',
    '---',
    '^1',
    'Lyrics'
  ].join('\n')));
  assert.equal(Object.prototype.polluted, undefined);

  const escapedMetadata = parseSongDocument([
    '---',
    'id: metadata-escape-test',
    'title: "Title\\n---\\n^chorus"',
    'note: "Value\\n---\\n^bridge"',
    '---',
    '^1',
    'Only projected lyric'
  ].join('\n'));
  assert.equal(escapedMetadata.sections.length, 1);
  assert.deepEqual(escapedMetadata.sections[0].slides[0].lines, ['Only projected lyric']);
  assert.equal(escapedMetadata.title, 'Title\n---\n^chorus');
  assert.equal(escapedMetadata.extraMetadata.note, 'Value\n---\n^bridge');
  assert.deepEqual(
    withoutSourceHash(parseSongDocument(serializeSongDocument(escapedMetadata))),
    withoutSourceHash(escapedMetadata)
  );
});

test('Russian and other Unicode section markers retain stable identities and remain human-arrangeable', () => {
  const source = [
    '---',
    'id: velik-bog-ru',
    'title: Великий Бог',
    'language: ru',
    '---',
    '',
    '^Куплет 1',
    'Когда смотрю я на мир Божий',
    '',
    '^Припев',
    'Тогда поёт мой дух, Господь',
    '',
    '^Куплет 2',
    'Когда читаю я Писанье'
  ].join('\n');
  const song = parseSongDocument(source);

  assert.deepEqual(song.sections.map(section => section.marker), ['Куплет 1', 'Припев', 'Куплет 2']);
  assert.equal(new Set(song.sections.map(section => section.id)).size, 3);
  for (const section of song.sections) assert.match(section.id, /^(?:[a-z0-9-]+-)?[a-f0-9]{10}$/);

  const reparsed = parseSongDocument(serializeSongDocument(song));
  assert.deepEqual(reparsed.sections.map(section => section.id), song.sections.map(section => section.id));
  assert.deepEqual(
    parseSongArrangement('Куплет 1, Припев, Куплет 2, Припев', song),
    [song.sections[0].id, song.sections[1].id, song.sections[2].id, song.sections[1].id]
  );
});

test('canonically equivalent Unicode markers produce the same ID and duplicates are rejected', () => {
  const composed = parseSongDocument('^Куплёт\nСтрока');
  const decomposed = parseSongDocument('^Купле\u0308т\nСтрока');
  assert.equal(composed.sections[0].id, decomposed.sections[0].id);

  expectCode('DUPLICATE_SECTION', () => parseSongDocument([
    '^Куплёт',
    'Первая строка',
    '^Купле\u0308т',
    'Вторая строка'
  ].join('\n')));
});

test('caret escapes, CRLF input, explicit slide breaks, and blank-line normalization are lossless', () => {
  const source = [
    '---',
    'id: escape-song',
    'title: Escape Song',
    'language: en',
    '---',
    '^1',
    '',
    '^^This is a projected caret',
    '^^^chorus is also projected',
    '',
    '',
    'Trailing spaces   ',
    '',
    '---',
    '',
    'Second slide',
    ''
  ].join('\r\n');
  const song = parseSongDocument(source);

  assert.equal(song.sections.length, 1);
  assert.equal(song.sections[0].slides.length, 2);
  assert.deepEqual(song.sections[0].slides[0].lines, [
    '^This is a projected caret',
    '^^chorus is also projected',
    '',
    'Trailing spaces'
  ]);
  assert.deepEqual(song.sections[0].slides[1].lines, ['Second slide']);

  const reparsed = parseSongDocument(serializeSongDocument(song));
  assert.deepEqual(withoutSourceHash(reparsed), withoutSourceHash(song));
});

test('programmatic section ids canonicalize to the identities restored from Markdown', () => {
  const raw = makeRawSong({
    sections: [
      {
        id: 'part-01',
        marker: 'P1',
        label: 'Part 1 (provisional)',
        slides: [{ lines: ['First part'] }]
      },
      {
        id: 'part-02',
        marker: 'P2',
        label: 'Part 2 (provisional)',
        slides: [{ lines: ['Second part'] }]
      },
      {
        id: 'constructor',
        marker: 'P3',
        label: 'Prototype-looking legacy id',
        slides: [{ lines: ['Third part'] }]
      }
    ]
  });
  const canonical = canonicalizeSongDocumentSectionIds(raw);

  assert.deepEqual(canonical.sectionIdMap, {
    'part-01': 'p1',
    'part-02': 'p2',
    constructor: 'p3'
  });
  assert.equal(
    Object.prototype.hasOwnProperty.call(canonical.sectionIdMap, 'constructor'),
    true
  );
  assert.equal(Object.getPrototypeOf(canonical.sectionIdMap), Object.prototype);
  assert.equal(canonical.song.id, raw.id);
  assert.deepEqual(
    canonical.song.sections.map(section => ({
      id: section.id,
      marker: section.marker,
      label: section.label,
      lines: section.slides[0].lines
    })),
    [
      {
        id: 'p1',
        marker: 'P1',
        label: 'Part 1 (provisional)',
        lines: ['First part']
      },
      {
        id: 'p2',
        marker: 'P2',
        label: 'Part 2 (provisional)',
        lines: ['Second part']
      },
      {
        id: 'p3',
        marker: 'P3',
        label: 'Prototype-looking legacy id',
        lines: ['Third part']
      }
    ]
  );
  assert.equal(serializeSongDocument(canonical.song), canonical.source);
  assert.deepEqual(
    parseSongDocument(canonical.source).sections.map(section => section.id),
    canonical.song.sections.map(section => section.id)
  );
});

test('parser limits count UTF-8 bytes and enforce line, section, slide, line-count, and arrangement aggregates', () => {
  expectCode('SOURCE_TOO_LARGE', () => parseSongDocument('я'.repeat(Math.floor(MAX_SOURCE_BYTES / 2) + 1)));

  const exactLine = parseSongDocument(`^1\n${'x'.repeat(1000)}`);
  assert.equal(exactLine.sections[0].slides[0].lines[0].length, 1000);
  expectCode('LYRIC_LINE_TOO_LONG', () => parseSongDocument(`^1\n${'x'.repeat(1001)}`));

  const twoHundredSections = Array.from({ length: 200 }, (_, index) => ({
    id: `part-${index + 1}`,
    marker: `Part ${index + 1}`,
    label: `Part ${index + 1}`,
    slides: [{ lines: ['x'] }]
  }));
  assert.equal(normalizeSongDocument(makeRawSong({ sections: twoHundredSections })).sections.length, 200);
  expectCode('INVALID_SECTIONS', () => normalizeSongDocument(makeRawSong({
    sections: [...twoHundredSections, {
      id: 'part-201', marker: 'Part 201', label: 'Part 201', slides: [{ lines: ['x'] }]
    }]
  })));

  const thousandSlides = Array.from({ length: 1000 }, () => ({ lines: ['x'] }));
  assert.equal(
    normalizeSongDocument(makeRawSong({
      sections: [{ id: 'verse-1', marker: '1', label: 'Verse 1', slides: thousandSlides }]
    })).sections[0].slides.length,
    1000
  );
  expectCode('TOO_MANY_SLIDES', () => normalizeSongDocument(makeRawSong({
    sections: [{
      id: 'verse-1', marker: '1', label: 'Verse 1', slides: [...thousandSlides, { lines: ['x'] }]
    }]
  })));

  const tenThousandLines = Array.from({ length: 10000 }, () => 'x');
  assert.equal(normalizeSongDocument(makeRawSong({
    sections: [{ id: 'verse-1', marker: '1', label: 'Verse 1', slides: [{ lines: tenThousandLines }] }]
  })).sections[0].slides[0].lines.length, 10000);
  expectCode('TOO_MANY_LINES', () => normalizeSongDocument(makeRawSong({
    sections: [{
      id: 'verse-1', marker: '1', label: 'Verse 1', slides: [{ lines: [...tenThousandLines, 'x'] }]
    }]
  })));

  const simple = parseSongDocument('^1\nLine');
  assert.equal(parseSongArrangement(Array.from({ length: 500 }, () => '1'), simple).length, 500);
  expectCode('ARRANGEMENT_TOO_LONG', () => parseSongArrangement(Array.from({ length: 501 }, () => '1'), simple));
});

test('translation comparison reports missing, extra, and slide-break mismatches together', () => {
  const base = parseSongDocument([
    '---',
    'id: source-song',
    'title: Source',
    'language: en',
    '---',
    '^1',
    'Verse part one',
    '---',
    'Verse part two',
    '^chorus',
    'Chorus'
  ].join('\n'));
  const translation = parseSongDocument([
    '---',
    'id: translated-song',
    'title: Translation',
    'language: ru',
    'translationOf: source-song',
    '---',
    '^1',
    'Один слайд',
    '^bridge',
    'Мост'
  ].join('\n'));

  assert.deepEqual(compareSongSections(base, translation), {
    compatible: false,
    missingSectionIds: ['chorus'],
    extraSectionIds: ['bridge'],
    slideMismatches: [{ sectionId: 'verse-1', sourceSlides: 2, translationSlides: 1 }]
  });
});
