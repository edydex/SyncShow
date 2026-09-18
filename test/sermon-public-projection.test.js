'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const {
  SERMON_KIND,
  serializeSermonDocument
} = require('../src/services/sermon/SermonDocument');
const {
  MAX_PUBLIC_SERMON_CATALOG_ITEMS,
  SERMON_PUBLIC_DETAIL_KIND,
  SERMON_PUBLIC_MEDIA_TYPE,
  SermonPublicProjectionError,
  buildSermonPublicCatalog,
  buildSermonPublicPassageIndex,
  buildSermonPublicProjection,
  deriveSermonPublicId,
  normalizeSermonPublicCatalog,
  normalizeSermonPublicDetail,
  normalizeSermonPublicPassageIndex,
  normalizeStablePublicHttpsUrl,
  parseSermonPublicCatalog,
  parseSermonPublicDetail,
  parseSermonPublicPassageIndex,
  querySermonPublicPassageIndex,
  serializeSermonPublicCatalog,
  serializeSermonPublicDetail,
  serializeSermonPublicPassageIndex,
  sermonPublicDetailSha256,
  verifySermonPublicDetailForCatalogItem
} = require('../src/services/sermon/SermonPublicProjection');

function range(bookId, chapter, startVerse, endVerse = startVerse) {
  return {
    schemaVersion: 1,
    bookId,
    start: { chapter, verse: startVerse },
    end: { chapter, verse: endVerse }
  };
}

function sermonDocument(overrides = {}) {
  return {
    schemaVersion: 3,
    kind: SERMON_KIND,
    id: 'Sermon:2026-07-26:Prayer',
    titles: {
      en: 'The Prayer That Transforms the Church',
      ru: 'Молитва, преображающая Церковь'
    },
    defaultLanguage: 'en',
    speaker: {
      id: 'private-speaker-record',
      name: 'Paul Lvutin'
    },
    serviceDate: '2026-07-26',
    series: {
      id: 'private-series-record',
      titles: {
        en: 'From Pain to Unity',
        ru: 'От боли к единству'
      }
    },
    outline: [{
      id: 'private-outline-section',
      parentId: null,
      kind: 'section',
      titles: {
        en: 'The Foundation',
        ru: 'Основание'
      }
    }],
    sources: [{
      id: 'private-manuscript-source',
      kind: 'manuscript',
      fileName: 'pastor-private-manuscript.docx',
      mediaType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      languages: ['en', 'ru'],
      sha256: 'a'.repeat(64),
      sizeBytes: 24000,
      provenance: {
        providedBy: 'Private inbox identity',
        receivedAt: '2026-07-24T18:30:00Z',
        sourceSystem: 'pastor-email',
        externalId: 'private-message-id'
      }
    }],
    references: [{
      id: 'private-primary-reference',
      range: range('Eph', 3, 14, 21),
      role: 'primary',
      source: 'pastor',
      reviewStatus: 'confirmed',
      enteredText: 'Ephesians 3:14–21',
      sourceId: 'private-manuscript-source',
      sectionId: null,
      startOffset: 10,
      endOffset: 30
    }, {
      id: 'private-mentioned-reference',
      range: range('Eph', 5, 2),
      role: 'mentioned',
      source: 'manuscript',
      reviewStatus: 'confirmed',
      enteredText: 'Ephesians 5:2',
      sourceId: 'private-manuscript-source',
      sectionId: 'private-outline-section',
      startOffset: 100,
      endOffset: 116
    }, {
      id: 'private-overlap-reference',
      range: range('Eph', 3, 18),
      role: 'mentioned',
      source: 'manuscript',
      reviewStatus: 'confirmed',
      enteredText: 'Ephesians 3:18',
      sourceId: 'private-manuscript-source',
      sectionId: 'private-outline-section',
      startOffset: 200,
      endOffset: 216
    }, {
      id: 'private-suggested-reference',
      range: range('Eph', 1, 19, 20),
      role: 'mentioned',
      source: 'transcript-extraction',
      reviewStatus: 'suggested',
      enteredText: 'Ephesians 1:19–20',
      sourceId: null,
      sectionId: null,
      startOffset: null,
      endOffset: null
    }],
    body: [{
      id: 'private-body-entry-en',
      kind: 'manuscript',
      language: 'en',
      sourceId: 'private-manuscript-source',
      sectionId: 'private-outline-section',
      text: 'The reviewed English sermon body.\n\nSecond paragraph.'
    }, {
      id: 'private-body-entry-ru',
      kind: 'manuscript',
      language: 'ru',
      sourceId: 'private-manuscript-source',
      sectionId: 'private-outline-section',
      text: 'Проверенный русский текст проповеди.'
    }],
    media: [{
      id: 'private-recording-media',
      kind: 'audio',
      status: 'ready',
      title: 'Sermon audio',
      language: 'en',
      mediaType: 'audio/mpeg',
      fileName: 'private-recording.mp3',
      sha256: 'b'.repeat(64),
      sizeBytes: 48000000,
      durationSeconds: 2484.5,
      url: 'https://media.church.example.org/sermons/prayer.mp3'
    }, {
      id: 'private-pending-notes',
      kind: 'document',
      status: 'pending',
      title: 'Sermon notes',
      language: 'en',
      mediaType: 'application/pdf',
      fileName: 'private-notes.pdf',
      sha256: 'c'.repeat(64),
      sizeBytes: 500000,
      durationSeconds: null,
      url: 'https://media.church.example.org/sermons/prayer-notes.pdf'
    }, {
      id: 'private-http-video',
      kind: 'video',
      status: 'ready',
      title: 'Insecure sermon video',
      language: 'en',
      mediaType: 'video/mp4',
      fileName: null,
      sha256: null,
      sizeBytes: null,
      durationSeconds: 2500,
      url: 'http://media.church.example/sermons/prayer.mp4'
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

function revisionOf(source) {
  return crypto.createHash('sha256').update(source).digest('hex');
}

function canonicalInput(document = sermonDocument()) {
  const documentSource = serializeSermonDocument(document);
  return {
    documentSource,
    publicRevision: revisionOf(documentSource),
    selectedBodyEntryIds: ['private-body-entry-en'],
    selectedMediaIds: ['private-recording-media']
  };
}

function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

function expectCode(code, operation) {
  assert.throws(operation, error => {
    assert.equal(error instanceof SermonPublicProjectionError, true);
    assert.equal(error.code, code);
    return true;
  });
}

test('sermon and project service barrels expose the pure projection contract', () => {
  const sermonApi = require('../src/services/sermon');
  const projectApi = require('../src/services/project');
  for (const api of [sermonApi, projectApi]) {
    assert.equal(api.buildSermonPublicProjection, buildSermonPublicProjection);
    assert.equal(api.buildSermonPublicCatalog, buildSermonPublicCatalog);
    assert.equal(api.buildSermonPublicPassageIndex, buildSermonPublicPassageIndex);
    assert.equal(api.querySermonPublicPassageIndex, querySermonPublicPassageIndex);
    assert.equal(
      api.verifySermonPublicDetailForCatalogItem,
      verifySermonPublicDetailForCatalogItem
    );
  }
});

test('portable public-projection golden fixture locks cross-repository bytes and hashes', () => {
  const fixture = JSON.parse(fs.readFileSync(
    path.join(__dirname, 'fixtures', 'sermon-public-projection-v1.json'),
    'utf8'
  ));
  const documentSource = serializeSermonDocument(fixture.document);
  const publicRevision = revisionOf(documentSource);
  assert.equal(publicRevision, fixture.expectedSermonRevision);

  const projection = buildSermonPublicProjection({
    documentSource,
    publicRevision,
    selectedBodyEntryIds: fixture.selectedBodyEntryIds,
    selectedMediaIds: fixture.selectedMediaIds
  });
  assert.equal(projection.detail.publicId, fixture.expectedPublicId);
  assert.equal(projection.checksum, fixture.expectedDetailChecksum);
  assert.deepEqual(projection.detail, fixture.expectedDetail);
  assert.equal(
    projection.detailSource,
    serializeSermonPublicDetail(fixture.expectedDetail)
  );
  assert.match(documentSource, /private-pastor-manuscript\.docx/);
  assert.doesNotMatch(projection.detailSource, /private-pastor-manuscript|private-message-id/);
});

test('an exact approved revision produces strict body-selective catalog and detail bytes', () => {
  const input = canonicalInput();
  const projection = buildSermonPublicProjection(input);
  const publicId = deriveSermonPublicId('Sermon:2026-07-26:Prayer');

  assert.equal(projection.detail.schemaVersion, 1);
  assert.equal(projection.detail.kind, SERMON_PUBLIC_DETAIL_KIND);
  assert.equal(projection.detail.publicId, publicId);
  assert.match(publicId, /^[a-z0-9][a-z0-9._-]{0,95}$/);
  assert.equal(projection.detail.sermonRevision, input.publicRevision);
  assert.deepEqual(projection.detail.speaker, { name: 'Paul Lvutin' });
  assert.deepEqual(projection.detail.series, {
    titles: {
      en: 'From Pain to Unity',
      ru: 'От боли к единству'
    }
  });
  assert.deepEqual(projection.detail.body, [{
    kind: 'manuscript',
    language: 'en',
    text: 'The reviewed English sermon body.\n\nSecond paragraph.'
  }]);
  assert.deepEqual(projection.detail.media, [{
    kind: 'audio',
    title: 'Sermon audio',
    language: 'en',
    mediaType: 'audio/mpeg',
    durationSeconds: 2484.5,
    url: 'https://media.church.example.org/sermons/prayer.mp3'
  }]);
  assert.deepEqual(
    projection.detail.references.map(reference => reference.role),
    ['primary', 'mentioned', 'mentioned']
  );

  const serialized = JSON.stringify(projection.detail);
  for (const privateValue of [
    'private-speaker-record',
    'private-series-record',
    'private-outline-section',
    'private-manuscript-source',
    'pastor-private-manuscript.docx',
    'Private inbox identity',
    'private-message-id',
    'private-primary-reference',
    'private-body-entry-en',
    'private-recording-media',
    'private-recording.mp3',
    'private-pending-notes',
    'private-suggested-reference',
    'Ephesians 3:14'
  ]) {
    assert.equal(serialized.includes(privateValue), false, privateValue);
  }
  for (const forbiddenField of [
    'sources',
    'publication',
    'sourceId',
    'sectionId',
    'startOffset',
    'endOffset',
    'enteredText',
    'fileName',
    'sha256',
    'sizeBytes',
    'status'
  ]) {
    assert.equal(Object.hasOwn(projection.detail, forbiddenField), false);
    assert.equal(serialized.includes(`"${forbiddenField}"`), false, forbiddenField);
  }

  assert.equal(
    projection.detailSource,
    serializeSermonPublicDetail(projection.detail)
  );
  assert.equal(
    projection.checksum,
    sermonPublicDetailSha256(projection.detail)
  );
  assert.deepEqual(parseSermonPublicDetail(projection.detailSource), projection.detail);
  assert.equal(projection.catalogItem.id, publicId);
  assert.equal(projection.catalogItem.checksum, projection.checksum);
  assert.equal(projection.catalogItem.content.url, `/content/sermons/${publicId}`);
  assert.equal(projection.catalogItem.content.mediaType, SERMON_PUBLIC_MEDIA_TYPE);
  assert.equal(Object.isFrozen(projection), true);
  assert.equal(Object.isFrozen(projection.detail.body[0]), true);
});

test('projection eligibility is exact and selections fail closed', () => {
  const exact = canonicalInput();
  expectCode('PUBLIC_REVISION_MISMATCH', () => buildSermonPublicProjection({
    ...exact,
    publicRevision: 'f'.repeat(64)
  }));
  expectCode('NONCANONICAL_PUBLIC_SERMON_SOURCE', () => buildSermonPublicProjection({
    ...exact,
    documentSource: JSON.stringify(JSON.parse(exact.documentSource), null, 2)
  }));
  expectCode('SERMON_NOT_PUBLICLY_ELIGIBLE', () => {
    const input = canonicalInput(sermonDocument({
      publication: {
        status: 'draft',
        visibility: 'public',
        publishedAt: null,
        canonicalUrl: 'https://church.example/sermons/prayer'
      }
    }));
    buildSermonPublicProjection(input);
  });
  expectCode('SERMON_NOT_PUBLICLY_ELIGIBLE', () => {
    const input = canonicalInput(sermonDocument({
      publication: {
        status: 'published',
        visibility: 'members',
        publishedAt: '2026-07-26T20:00:00Z',
        canonicalUrl: 'https://church.example/sermons/prayer'
      }
    }));
    buildSermonPublicProjection(input);
  });
  expectCode('UNKNOWN_PUBLIC_BODY_SELECTION', () => buildSermonPublicProjection({
    ...exact,
    selectedBodyEntryIds: ['missing-body']
  }));
  expectCode('UNKNOWN_PUBLIC_MEDIA_SELECTION', () => buildSermonPublicProjection({
    ...exact,
    selectedMediaIds: ['missing-media']
  }));
  expectCode('PUBLIC_MEDIA_NOT_READY', () => buildSermonPublicProjection({
    ...exact,
    selectedMediaIds: ['private-pending-notes']
  }));
  expectCode('PUBLIC_MEDIA_NOT_READY', () => buildSermonPublicProjection({
    ...exact,
    selectedMediaIds: ['private-http-video']
  }));
  expectCode('PUBLIC_MEDIA_NOT_READY', () => {
    const input = canonicalInput(sermonDocument({
      media: sermonDocument().media.map(media =>
        media.id === 'private-recording-media'
          ? {
              ...media,
              url: 'https://media.church.example.org/sermons/prayer.mp3?token=temporary'
            }
          : media)
    }));
    buildSermonPublicProjection(input);
  });
  for (const value of [
    'https://media.example.org:8443/sermon.mp3',
    'https://127.0.0.1/sermon.mp3',
    'https://media.local/sermon.mp3',
    'https://media.example.org/sermon.mp3?token=temporary'
  ]) {
    expectCode(
      'INVALID_PUBLIC_URL',
      () => normalizeStablePublicHttpsUrl(value, 'Public media', {
        maximumCharacters: 2048
      })
    );
  }
  expectCode('DUPLICATE_PUBLIC_SELECTION', () => buildSermonPublicProjection({
    ...exact,
    selectedBodyEntryIds: ['private-body-entry-en', 'private-body-entry-en']
  }));
  expectCode('INVALID_PUBLIC_PROJECTION_REQUEST', () => buildSermonPublicProjection({
    documentSource: exact.documentSource,
    publicRevision: exact.publicRevision,
    selectedBodyEntryIds: []
  }));
  expectCode('INVALID_PUBLIC_URL', () => {
    const input = canonicalInput(sermonDocument({
      publication: {
        status: 'published',
        visibility: 'public',
        publishedAt: '2026-07-26T20:00:00Z',
        canonicalUrl: 'http://church.example/sermons/prayer'
      }
    }));
    buildSermonPublicProjection(input);
  });
});

test('available notes can be explicitly projected beside a recording without attachment metadata', () => {
  const document = sermonDocument();
  document.media[1] = {
    ...document.media[1],
    status: 'ready'
  };
  const input = canonicalInput(document);
  const projection = buildSermonPublicProjection({
    ...input,
    selectedMediaIds: ['private-recording-media', 'private-pending-notes']
  });
  assert.deepEqual(
    projection.detail.media.map(media => media.kind),
    ['audio', 'document']
  );
  assert.equal(
    projection.detail.media[1].url,
    'https://media.church.example.org/sermons/prayer-notes.pdf'
  );
  assert.equal(Object.hasOwn(projection.detail.media[1], 'fileName'), false);
  assert.equal(Object.hasOwn(projection.detail.media[1], 'sha256'), false);
  assert.equal(Object.hasOwn(projection.detail.media[1], 'status'), false);
});

test('v1 and v2 canonical sermon sources remain exact while projecting no implicit body', () => {
  for (const schemaVersion of [1, 2]) {
    const document = sermonDocument({
      schemaVersion,
      body: undefined,
      sources: sermonDocument().sources.map(source => {
        if (schemaVersion === 2) return source;
        const { languages, ...rest } = source;
        return { ...rest, language: languages[0] };
      })
    });
    delete document.body;
    const documentSource = serializeSermonDocument(document);
    const publicRevision = revisionOf(documentSource);
    const projection = buildSermonPublicProjection({
      documentSource,
      publicRevision,
      selectedBodyEntryIds: [],
      selectedMediaIds: []
    });
    assert.equal(projection.detail.sermonRevision, publicRevision);
    assert.deepEqual(projection.detail.body, []);
    assert.equal(revisionOf(documentSource), publicRevision);
    assert.equal(serializeSermonDocument(JSON.parse(documentSource)), documentSource);
  }
});

test('strict detail validation rejects private fields and noncanonical public bytes', () => {
  const projection = buildSermonPublicProjection(canonicalInput());
  const privateBody = plain(projection.detail);
  privateBody.body[0].sourceId = 'private-manuscript-source';
  expectCode('INVALID_PUBLIC_PROJECTION', () => normalizeSermonPublicDetail(privateBody));

  const privateMedia = plain(projection.detail);
  privateMedia.media[0].fileName = 'private-recording.mp3';
  expectCode('INVALID_PUBLIC_PROJECTION', () => normalizeSermonPublicDetail(privateMedia));

  const mismatchedId = plain(projection.detail);
  mismatchedId.publicId = `sermon-${'f'.repeat(64)}`;
  expectCode('PUBLIC_ID_MISMATCH', () => normalizeSermonPublicDetail(mismatchedId));

  const suggestedProvenance = plain(projection.detail);
  suggestedProvenance.references[0].reviewStatus = 'suggested';
  expectCode('INVALID_PUBLIC_PROJECTION', () => normalizeSermonPublicDetail(
    suggestedProvenance
  ));

  expectCode('NONCANONICAL_PUBLIC_DETAIL_SOURCE', () => parseSermonPublicDetail(
    JSON.stringify(projection.detail, null, 2)
  ));
});

test('catalog and passage index bind exact detail checksums and reader navigation', () => {
  const projection = buildSermonPublicProjection(canonicalInput());
  const publications = [{
    detailSource: projection.detailSource,
    checksum: projection.checksum
  }];
  const catalog = buildSermonPublicCatalog(publications);
  const catalogSource = serializeSermonPublicCatalog(catalog);
  assert.deepEqual(parseSermonPublicCatalog(catalogSource), catalog);
  assert.equal(catalog.items.length, 1);
  assert.equal(catalog.items[0].sermonRevision, projection.detail.sermonRevision);
  assert.equal(catalog.items[0].checksum, projection.checksum);

  const index = buildSermonPublicPassageIndex(catalog, publications);
  assert.deepEqual(buildSermonPublicPassageIndex(catalog), index);
  const indexSource = serializeSermonPublicPassageIndex(index);
  assert.deepEqual(parseSermonPublicPassageIndex(indexSource), index);
  assert.deepEqual(
    verifySermonPublicDetailForCatalogItem(
      catalog.items[0],
      projection.detailSource
    ),
    projection.detail
  );

  const primary = querySermonPublicPassageIndex(index, range('Eph', 3, 18));
  assert.equal(primary.primary.length, 1);
  assert.equal(primary.mentioned.length, 0);
  assert.equal(primary.primary[0].sermonRevision, projection.detail.sermonRevision);
  assert.equal(primary.primary[0].checksum, projection.checksum);
  assert.equal(
    primary.primary[0].contentUrl,
    `/content/sermons/${projection.detail.publicId}`
  );
  assert.deepEqual(primary.primary[0].matches, [range('Eph', 3, 14, 21)]);

  const mentioned = querySermonPublicPassageIndex(index, range('Eph', 5, 2));
  assert.equal(mentioned.primary.length, 0);
  assert.equal(mentioned.mentioned.length, 1);
  assert.deepEqual(mentioned.mentioned[0].matches, [range('Eph', 5, 2)]);

  const wholeChapter = querySermonPublicPassageIndex(
    index,
    range('Eph', 3, null, null)
  );
  assert.equal(wholeChapter.primary.length, 1);
  assert.equal(wholeChapter.mentioned.length, 0);

  const suggestedOnly = querySermonPublicPassageIndex(index, range('Eph', 1, 19, 20));
  assert.deepEqual(suggestedOnly, { primary: [], mentioned: [] });
  assert.equal(Object.isFrozen(primary.primary[0].matches[0]), true);
});

test('catalog/detail drift, checksum substitution, duplicates, and mixed revisions are rejected', () => {
  const projection = buildSermonPublicProjection(canonicalInput());
  const publications = [{
    detailSource: projection.detailSource,
    checksum: projection.checksum
  }];
  const catalog = buildSermonPublicCatalog(publications);

  expectCode('PUBLIC_DETAIL_CHECKSUM_MISMATCH', () => buildSermonPublicCatalog([{
    detailSource: projection.detailSource,
    checksum: 'f'.repeat(64)
  }]));

  const wrongChecksum = plain(catalog);
  wrongChecksum.items[0].checksum = 'f'.repeat(64);
  expectCode('PUBLIC_DETAIL_CHECKSUM_MISMATCH', () =>
    buildSermonPublicPassageIndex(wrongChecksum, publications));
  expectCode('PUBLIC_DETAIL_CHECKSUM_MISMATCH', () =>
    verifySermonPublicDetailForCatalogItem(
      wrongChecksum.items[0],
      projection.detailSource
    ));

  const wrongRevision = plain(catalog);
  wrongRevision.items[0].sermonRevision = 'f'.repeat(64);
  expectCode('PUBLIC_DETAIL_REVISION_MISMATCH', () =>
    buildSermonPublicPassageIndex(wrongRevision, publications));

  const changedDisplay = plain(catalog);
  changedDisplay.items[0].speaker.name = 'Different speaker';
  expectCode('PUBLIC_CATALOG_DETAIL_MISMATCH', () =>
    buildSermonPublicPassageIndex(changedDisplay, publications));

  const duplicate = plain(catalog);
  duplicate.items.push(plain(duplicate.items[0]));
  expectCode('DUPLICATE_PUBLIC_SERMON', () => normalizeSermonPublicCatalog(duplicate));

  const mixed = plain(catalog);
  mixed.items.push({
    ...plain(mixed.items[0]),
    sermonRevision: 'f'.repeat(64)
  });
  expectCode('MIXED_PUBLIC_SERMON_REVISIONS', () =>
    normalizeSermonPublicCatalog(mixed));

  const mixedIndex = buildSermonPublicPassageIndex(catalog, publications);
  const secondIndexItem = {
    ...plain(mixedIndex.items[0]),
    sermonRevision: 'f'.repeat(64)
  };
  expectCode('MIXED_PUBLIC_SERMON_REVISIONS', () =>
    normalizeSermonPublicPassageIndex({
      ...plain(mixedIndex),
      items: [...plain(mixedIndex.items), secondIndexItem]
    }));
});

test('catalog and index hard bounds reject oversized untrusted lists before item traversal', () => {
  expectCode('PUBLIC_CATALOG_TOO_LARGE', () => normalizeSermonPublicCatalog({
    schemaVersion: 2,
    contentType: 'sermons',
    items: new Array(MAX_PUBLIC_SERMON_CATALOG_ITEMS + 1).fill(null)
  }));
  expectCode('PUBLIC_PASSAGE_INDEX_TOO_LARGE', () =>
    normalizeSermonPublicPassageIndex({
      schemaVersion: 1,
      kind: 'heritage-public-sermon-passage-index',
      items: new Array(MAX_PUBLIC_SERMON_CATALOG_ITEMS + 1).fill(null)
    }));
});
