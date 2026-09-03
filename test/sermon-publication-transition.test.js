'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const test = require('node:test');

const {
  SERMON_KIND,
  parseSermonDocument,
  serializeSermonDocument
} = require('../src/services/sermon/SermonDocument');
const {
  SermonPublicProjectionError
} = require('../src/services/sermon/SermonPublicProjection');
const {
  SermonPublicationTransitionError,
  buildSermonPublicationTransition
} = require('../src/services/sermon/SermonPublicationTransition');

const PUBLISHED_AT = '2026-07-27T20:15:30.123Z';

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
    id: 'sermon-2026-07-27-publication',
    titles: {
      en: 'A Church That Remembers',
      ru: 'Церковь, которая помнит'
    },
    defaultLanguage: 'en',
    speaker: {
      id: 'pastor-private-id',
      name: 'Pastor Example'
    },
    serviceDate: '2026-07-27',
    series: {
      id: 'series-private-id',
      titles: {
        en: 'Life Together',
        ru: 'Жизнь вместе'
      }
    },
    outline: [{
      id: 'outline-opening',
      parentId: null,
      kind: 'section',
      titles: {
        en: 'Opening',
        ru: 'Вступление'
      }
    }],
    sources: [{
      id: 'pastor-manuscript',
      kind: 'manuscript',
      fileName: 'private-manuscript.docx',
      mediaType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      languages: ['en', 'ru'],
      sha256: 'a'.repeat(64),
      sizeBytes: 12345,
      provenance: {
        providedBy: 'Pastor Example',
        receivedAt: '2026-07-25T18:30:00Z',
        sourceSystem: 'pastor-email',
        externalId: 'private-message-id'
      }
    }],
    references: [{
      id: 'primary-eph-4',
      range: range('Eph', 4, 1, 6),
      role: 'primary',
      source: 'pastor',
      reviewStatus: 'confirmed',
      enteredText: 'Ephesians 4:1–6',
      sourceId: 'pastor-manuscript',
      sectionId: null,
      startOffset: 10,
      endOffset: 27
    }, {
      id: 'suggested-rom-12',
      range: range('Rom', 12, 4, 5),
      role: 'mentioned',
      source: 'transcript-extraction',
      reviewStatus: 'suggested',
      enteredText: 'Romans 12:4–5',
      sourceId: null,
      sectionId: null,
      startOffset: null,
      endOffset: null
    }],
    media: [{
      id: 'sermon-audio',
      kind: 'audio',
      status: 'ready',
      title: 'Sermon audio',
      language: 'en',
      mediaType: 'audio/mpeg',
      fileName: 'sermon.mp3',
      sha256: 'b'.repeat(64),
      sizeBytes: 45000000,
      durationSeconds: 2300.5,
      url: 'https://media.example.church/sermons/remember.mp3'
    }, {
      id: 'sermon-notes',
      kind: 'document',
      status: 'ready',
      title: 'Sermon notes',
      language: 'en',
      mediaType: 'application/pdf',
      fileName: 'sermon-notes.pdf',
      sha256: 'c'.repeat(64),
      sizeBytes: 450000,
      durationSeconds: null,
      url: 'https://media.example.church/sermons/remember-notes.pdf'
    }, {
      id: 'pending-video',
      kind: 'video',
      status: 'processing',
      title: 'Sermon video',
      language: 'en',
      mediaType: 'video/mp4',
      fileName: 'sermon.mp4',
      sha256: 'd'.repeat(64),
      sizeBytes: 900000000,
      durationSeconds: 2320,
      url: 'https://media.church.example/sermons/remember.mp4'
    }, {
      id: 'insecure-transcript',
      kind: 'transcript',
      status: 'ready',
      title: 'Transcript',
      language: 'en',
      mediaType: 'text/plain',
      fileName: 'sermon.txt',
      sha256: 'e'.repeat(64),
      sizeBytes: 12000,
      durationSeconds: null,
      url: 'http://media.church.example/sermons/remember.txt'
    }],
    publication: {
      status: 'ready',
      visibility: 'members',
      publishedAt: null,
      canonicalUrl: 'https://church.example/sermons/remember'
    },
    body: [{
      id: 'body-english',
      kind: 'manuscript',
      language: 'en',
      sourceId: 'pastor-manuscript',
      sectionId: 'outline-opening',
      text: 'Reviewed English manuscript.'
    }, {
      id: 'body-russian',
      kind: 'manuscript',
      language: 'ru',
      sourceId: 'pastor-manuscript',
      sectionId: 'outline-opening',
      text: 'Проверенная русская рукопись.'
    }],
    ...overrides
  };
}

function revisionOf(source) {
  return crypto.createHash('sha256').update(source, 'utf8').digest('hex');
}

function readyInput(overrides = {}) {
  return {
    documentSource: serializeSermonDocument(sermonDocument()),
    publishedAt: PUBLISHED_AT,
    selectedBodyEntryIds: ['body-russian', 'body-english'],
    selectedMediaIds: ['sermon-notes', 'sermon-audio'],
    ...overrides
  };
}

function expectTransitionCode(code, operation) {
  assert.throws(operation, error => {
    assert.equal(error instanceof SermonPublicationTransitionError, true);
    assert.equal(error.code, code);
    return true;
  });
}

function expectProjectionCode(code, operation) {
  assert.throws(operation, error => {
    assert.equal(error instanceof SermonPublicProjectionError, true);
    assert.equal(error.code, code);
    return true;
  });
}

test('publishes one exact Ready revision without changing sermon content', () => {
  const input = readyInput();
  const originalBodySelection = [...input.selectedBodyEntryIds];
  const originalMediaSelection = [...input.selectedMediaIds];
  const baseDocument = parseSermonDocument(input.documentSource);
  const result = buildSermonPublicationTransition(input);

  assert.deepEqual(Object.keys(result), [
    'baseRevision',
    'document',
    'documentSource',
    'publicRevision',
    'projection',
    'selectedBodyEntryIds',
    'selectedMediaIds'
  ]);
  assert.equal(result.baseRevision, revisionOf(input.documentSource));
  assert.equal(result.publicRevision, revisionOf(result.documentSource));
  assert.equal(serializeSermonDocument(result.document), result.documentSource);
  assert.deepEqual(parseSermonDocument(result.documentSource), result.document);
  assert.deepEqual(result.document.publication, {
    status: 'published',
    visibility: 'public',
    publishedAt: PUBLISHED_AT,
    canonicalUrl: baseDocument.publication.canonicalUrl
  });

  const { publication: _basePublication, ...baseContent } = baseDocument;
  const { publication: _publishedPublication, ...publishedContent } = result.document;
  assert.deepEqual(publishedContent, baseContent);
  assert.deepEqual(result.selectedBodyEntryIds, ['body-english', 'body-russian']);
  assert.deepEqual(result.selectedMediaIds, ['sermon-audio', 'sermon-notes']);
  assert.deepEqual(
    result.projection.detail.body.map(entry => entry.language),
    ['en', 'ru']
  );
  assert.deepEqual(
    result.projection.detail.media.map(entry => entry.kind),
    ['audio', 'document']
  );
  assert.equal(result.projection.detail.sermonRevision, result.publicRevision);
  assert.equal(
    result.projection.detail.canonicalUrl,
    baseDocument.publication.canonicalUrl
  );
  assert.deepEqual(input.selectedBodyEntryIds, originalBodySelection);
  assert.deepEqual(input.selectedMediaIds, originalMediaSelection);
  assert.equal(input.documentSource, serializeSermonDocument(baseDocument));
});

test('transition bytes, revisions, projection, and canonical ID order are deterministic', () => {
  const input = readyInput({
    selectedBodyEntryIds: [' body-russian ', 'body-english'],
    selectedMediaIds: [' sermon-notes ', 'sermon-audio']
  });
  const first = buildSermonPublicationTransition(input);
  const second = buildSermonPublicationTransition({
    ...input,
    selectedBodyEntryIds: [...input.selectedBodyEntryIds],
    selectedMediaIds: [...input.selectedMediaIds]
  });

  assert.deepEqual(second, first);
  assert.equal(second.documentSource, first.documentSource);
  assert.equal(second.publicRevision, first.publicRevision);
  assert.equal(second.projection.detailSource, first.projection.detailSource);
  assert.deepEqual(first.selectedBodyEntryIds, ['body-english', 'body-russian']);
  assert.deepEqual(first.selectedMediaIds, ['sermon-audio', 'sermon-notes']);
});

test('legacy Ready sermon bytes publish without an implicit schema upgrade', () => {
  for (const schemaVersion of [1, 2]) {
    const sources = sermonDocument().sources.map(source => {
      if (schemaVersion === 2) return source;
      const { languages, ...legacySource } = source;
      return { ...legacySource, language: languages[0] };
    });
    const base = sermonDocument({
      schemaVersion,
      sources,
      body: undefined
    });
    const documentSource = serializeSermonDocument(base);
    const baseDocument = parseSermonDocument(documentSource);
    const result = buildSermonPublicationTransition(readyInput({
      documentSource,
      selectedBodyEntryIds: []
    }));

    assert.equal(result.document.schemaVersion, schemaVersion);
    assert.deepEqual(result.selectedBodyEntryIds, []);
    assert.deepEqual(result.projection.detail.body, []);
    const { publication: _basePublication, ...baseContent } = baseDocument;
    const { publication: _publishedPublication, ...publishedContent } = result.document;
    assert.deepEqual(publishedContent, baseContent);
  }
});

test('sermon and project barrels expose the publication transition contract', () => {
  const sermonApi = require('../src/services/sermon');
  const projectApi = require('../src/services/project');
  assert.equal(
    sermonApi.buildSermonPublicationTransition,
    buildSermonPublicationTransition
  );
  assert.equal(
    projectApi.buildSermonPublicationTransition,
    buildSermonPublicationTransition
  );
});

test('draft, Published, and Archived bases cannot enter the Ready transition', () => {
  for (const status of ['draft', 'published', 'archived']) {
    const base = sermonDocument({
      publication: {
        ...sermonDocument().publication,
        status,
        publishedAt: status === 'published' ? '2026-07-27T19:00:00.000Z' : null
      }
    });
    expectTransitionCode('SERMON_NOT_READY_FOR_PUBLICATION', () => {
      buildSermonPublicationTransition(readyInput({
        documentSource: serializeSermonDocument(base)
      }));
    });
  }
});

test('invalid or noncanonical source bytes fail closed', () => {
  const canonical = readyInput().documentSource;
  expectTransitionCode('INVALID_PUBLICATION_DOCUMENT_SOURCE', () => {
    buildSermonPublicationTransition(readyInput({ documentSource: '{bad json' }));
  });
  expectTransitionCode('INVALID_PUBLICATION_DOCUMENT_SOURCE', () => {
    buildSermonPublicationTransition(readyInput({
      documentSource: Buffer.from(canonical, 'utf8')
    }));
  });
  for (const documentSource of [
    canonical.slice(0, -1),
    JSON.stringify(JSON.parse(canonical), null, 2),
    ` ${canonical}`
  ]) {
    expectTransitionCode('NONCANONICAL_PUBLICATION_DOCUMENT_SOURCE', () => {
      buildSermonPublicationTransition(readyInput({ documentSource }));
    });
  }
});

test('publishedAt must be exact canonical UTC server timestamp text', () => {
  for (const publishedAt of [
    null,
    '',
    '2026-07-27T20:15:30Z',
    '2026-07-27T20:15:30.12Z',
    '2026-07-27T13:15:30.123-07:00',
    '2026-07-27T20:15:30.123Z ',
    '2026-02-30T20:15:30.123Z'
  ]) {
    expectTransitionCode('INVALID_PUBLICATION_TIMESTAMP', () => {
      buildSermonPublicationTransition(readyInput({ publishedAt }));
    });
  }
});

test('body and media eligibility errors come from the strict public projector', () => {
  const cases = [{
    code: 'INVALID_PUBLIC_SELECTION',
    overrides: { selectedBodyEntryIds: null }
  }, {
    code: 'UNKNOWN_PUBLIC_BODY_SELECTION',
    overrides: { selectedBodyEntryIds: ['missing-body'] }
  }, {
    code: 'DUPLICATE_PUBLIC_SELECTION',
    overrides: { selectedBodyEntryIds: ['body-english', ' body-english '] }
  }, {
    code: 'INVALID_PUBLIC_SELECTION',
    overrides: { selectedMediaIds: null }
  }, {
    code: 'UNKNOWN_PUBLIC_MEDIA_SELECTION',
    overrides: { selectedMediaIds: ['missing-media'] }
  }, {
    code: 'DUPLICATE_PUBLIC_SELECTION',
    overrides: { selectedMediaIds: ['sermon-audio', ' sermon-audio '] }
  }, {
    code: 'PUBLIC_MEDIA_NOT_READY',
    overrides: { selectedMediaIds: ['pending-video'] }
  }, {
    code: 'PUBLIC_MEDIA_NOT_READY',
    overrides: { selectedMediaIds: ['insecure-transcript'] }
  }];
  for (const { code, overrides } of cases) {
    expectProjectionCode(code, () => {
      buildSermonPublicationTransition(readyInput(overrides));
    });
  }
});

test('mutation-shaped requests are rejected and successful output is deeply immutable', () => {
  const input = readyInput();
  for (const field of ['document', 'publication', 'publicRevision', 'baseRevision']) {
    expectTransitionCode('INVALID_PUBLICATION_TRANSITION_REQUEST', () => {
      buildSermonPublicationTransition({ ...input, [field]: {} });
    });
  }
  const { selectedMediaIds: _removed, ...missingSelection } = input;
  expectTransitionCode('INVALID_PUBLICATION_TRANSITION_REQUEST', () => {
    buildSermonPublicationTransition(missingSelection);
  });
  expectTransitionCode('INVALID_PUBLICATION_TRANSITION_REQUEST', () => {
    buildSermonPublicationTransition(Object.assign(
      Object.create({ inheritedMutation: true }),
      input
    ));
  });

  const result = buildSermonPublicationTransition(input);
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.document.publication), true);
  assert.equal(Object.isFrozen(result.projection.detail), true);
  assert.equal(Object.isFrozen(result.selectedBodyEntryIds), true);
  assert.throws(() => {
    result.document.publication.status = 'draft';
  }, TypeError);
  assert.throws(() => {
    result.selectedBodyEntryIds.push('missing-body');
  }, TypeError);
  assert.equal(result.document.publication.status, 'published');
  assert.deepEqual(result.selectedBodyEntryIds, ['body-english', 'body-russian']);
});
