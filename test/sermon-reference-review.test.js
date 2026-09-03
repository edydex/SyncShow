'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const sermonApi = require('../src/services/sermon');

const {
  MAX_SERMON_REFERENCE_REVIEW_ENTRIES,
  MAX_SERMON_REFERENCES,
  SERMON_KIND,
  SermonReferenceReviewError,
  applySermonReferenceReview,
  normalizeSermonDocument,
  serializeSermonDocument,
  sermonDocumentSha256
} = sermonApi;

function range(bookId, chapter, verseStart, verseEnd = verseStart) {
  return {
    schemaVersion: 1,
    bookId,
    start: { chapter, verse: verseStart },
    end: { chapter, verse: verseEnd }
  };
}

function reference(id, rawRange, overrides = {}) {
  return {
    id,
    range: rawRange,
    role: 'mentioned',
    source: 'manuscript',
    reviewStatus: 'confirmed',
    enteredText: 'Romans 12:2',
    sourceId: 'source-manuscript',
    sectionId: 'section-one',
    startOffset: 120,
    endOffset: 132,
    ...overrides
  };
}

function sermonFixture({
  schemaVersion = 3,
  publicationStatus = 'draft',
  references
} = {}) {
  const source = {
    id: 'source-manuscript',
    kind: 'manuscript',
    fileName: 'sermon.txt',
    mediaType: 'text/plain',
    sha256: 'a'.repeat(64),
    sizeBytes: 2048,
    provenance: {
      providedBy: 'Pastor Example',
      receivedAt: '2026-07-27T18:00:00.000Z',
      sourceSystem: 'pastor-email',
      externalId: 'message-one'
    }
  };
  if (schemaVersion === 1) source.language = 'en';
  else source.languages = ['en'];
  const publication = {
    status: publicationStatus,
    visibility: publicationStatus === 'published' ? 'public' : 'private',
    publishedAt: publicationStatus === 'published'
      ? '2026-07-28T20:00:00.000Z'
      : null,
    canonicalUrl: 'https://church.example/sermons/reference-review'
  };
  const raw = {
    schemaVersion,
    kind: SERMON_KIND,
    id: 'sermon-reference-review',
    titles: { en: 'Reference review' },
    defaultLanguage: 'en',
    speaker: { id: null, name: 'Pastor Example' },
    serviceDate: '2026-07-27',
    series: null,
    outline: [{
      id: 'section-one',
      parentId: null,
      kind: 'section',
      titles: { en: 'First section' }
    }, {
      id: 'section-two',
      parentId: null,
      kind: 'section',
      titles: { en: 'Second section' }
    }],
    sources: [source],
    references: references || [
      reference('primary-john-3-16', range('John', 3, 16), {
        role: 'primary',
        source: 'pastor',
        enteredText: 'John 3:16',
        startOffset: 12,
        endOffset: 21
      }),
      reference('mentioned-romans-12-2', range('Rom', 12, 2))
    ],
    media: [],
    publication
  };
  if (schemaVersion === 3) raw.body = [];
  return raw;
}

function entryFor(rawReference, overrides = {}) {
  const item = structuredClone(rawReference);
  return {
    referenceId: item.id,
    existingReferenceId: item.id,
    range: item.range,
    replaced: false,
    enteredText: item.enteredText,
    role: item.role,
    reviewStatus: item.reviewStatus,
    sectionId: item.sectionId,
    ...overrides
  };
}

function reviewFor(document, entries) {
  return {
    baseSermonRevisionId: sermonDocumentSha256(document),
    entries
  };
}

function expectReviewCode(code, callback) {
  assert.throws(callback, error => {
    assert.ok(error instanceof SermonReferenceReviewError);
    assert.equal(error.code, code);
    return true;
  });
}

test('exports the bounded pure review API', () => {
  assert.equal(typeof applySermonReferenceReview, 'function');
  assert.equal(MAX_SERMON_REFERENCE_REVIEW_ENTRIES, 512);
  assert.equal(MAX_SERMON_REFERENCE_REVIEW_ENTRIES, MAX_SERMON_REFERENCES);
  assert.equal(
    sermonApi.SermonReferenceReviewError,
    SermonReferenceReviewError
  );
});

test('exact no-op reviews preserve v1, v2, and v3 schema bytes and hashes', () => {
  for (const schemaVersion of [1, 2, 3]) {
    const current = normalizeSermonDocument(sermonFixture({ schemaVersion }));
    const sourceBefore = serializeSermonDocument(current);
    const revisionBefore = sermonDocumentSha256(current);
    const result = applySermonReferenceReview(
      current,
      reviewFor(current, current.references.map(entryFor))
    );

    assert.equal(result.changed, false);
    assert.equal(result.document.schemaVersion, schemaVersion);
    assert.equal(result.previousRevision, revisionBefore);
    assert.equal(result.revision, revisionBefore);
    assert.equal(serializeSermonDocument(result.document), sourceBefore);
    assert.equal(result.publicationReset, false);
    assert.equal(result.upgradedFromSchemaVersion, null);
    assert.deepEqual(result.changes, {
      addedReferenceIds: [],
      removedReferenceIds: [],
      updatedReferenceIds: [],
      replacedReferenceIds: [],
      orderChanged: false
    });
    assert.equal(Object.isFrozen(result), true);
    assert.equal(Object.isFrozen(result.changes), true);
  }
});

test('no-op review does not retroactively rewrite historically accepted entered text', () => {
  const raw = sermonFixture();
  raw.references[1].enteredText = 'Romans\u000112:2';
  const current = normalizeSermonDocument(raw);
  const sourceBefore = serializeSermonDocument(current);
  const result = applySermonReferenceReview(
    current,
    reviewFor(current, current.references.map(entryFor))
  );

  assert.equal(result.changed, false);
  assert.equal(serializeSermonDocument(result.document), sourceBefore);
});

test('one full desired list adds, edits, removes, and reorders without accepting renderer provenance', () => {
  const current = normalizeSermonDocument(sermonFixture());
  const primary = current.references[0];
  const mentioned = current.references[1];
  const result = applySermonReferenceReview(current, reviewFor(current, [{
    ...entryFor(mentioned),
    role: 'primary',
    reviewStatus: 'confirmed',
    sectionId: 'section-two'
  }, {
    referenceId: 'operator-ephesians-4-1',
    existingReferenceId: null,
    range: range('Eph', 4, 1),
    replaced: false,
    enteredText: 'Ephesians 4:1',
    role: 'mentioned',
    reviewStatus: 'suggested',
    sectionId: null
  }, entryFor(primary)]));

  assert.equal(result.changed, true);
  assert.deepEqual(result.document.references.map(item => item.id), [
    'mentioned-romans-12-2',
    'operator-ephesians-4-1',
    'primary-john-3-16'
  ]);
  assert.deepEqual(result.document.references[0], {
    ...mentioned,
    role: 'primary',
    reviewStatus: 'confirmed',
    enteredText: mentioned.enteredText,
    sectionId: 'section-two'
  });
  assert.deepEqual(result.document.references[1], {
    id: 'operator-ephesians-4-1',
    range: range('Eph', 4, 1),
    role: 'mentioned',
    source: 'operator',
    reviewStatus: 'suggested',
    enteredText: 'Ephesians 4:1',
    sourceId: null,
    sectionId: null,
    startOffset: null,
    endOffset: null
  });
  assert.deepEqual(result.changes, {
    addedReferenceIds: ['operator-ephesians-4-1'],
    removedReferenceIds: [],
    updatedReferenceIds: ['mentioned-romans-12-2'],
    replacedReferenceIds: [],
    orderChanged: true
  });
  assert.deepEqual(current.references, [primary, mentioned]);

  const removed = applySermonReferenceReview(result.document, reviewFor(
    result.document,
    result.document.references
      .filter(item => item.id !== 'operator-ephesians-4-1')
      .map(entryFor)
  ));
  assert.deepEqual(removed.changes.removedReferenceIds, [
    'operator-ephesians-4-1'
  ]);
});

test('explicit replacement resets provenance and requires nonempty entered text', () => {
  const current = normalizeSermonDocument(sermonFixture());
  const [primary, mentioned] = current.references;
  const result = applySermonReferenceReview(current, reviewFor(current, [
    entryFor(primary),
    {
      ...entryFor(mentioned),
      replaced: true,
      range: range('Phil', 4, 8),
      enteredText: 'Philippians 4:8',
      sectionId: 'section-two'
    }
  ]));
  assert.deepEqual(result.document.references[1], {
    id: mentioned.id,
    range: range('Phil', 4, 8),
    role: 'mentioned',
    source: 'operator',
    reviewStatus: 'confirmed',
    enteredText: 'Philippians 4:8',
    sourceId: null,
    sectionId: 'section-two',
    startOffset: null,
    endOffset: null
  });
  assert.deepEqual(result.changes.replacedReferenceIds, [mentioned.id]);

  const hiddenEnteredTextEdit = [
    entryFor(primary),
    { ...entryFor(mentioned), enteredText: 'Different text' }
  ];
  expectReviewCode(
    'ENTERED_TEXT_REPLACEMENT_REQUIRED',
    () => applySermonReferenceReview(
      current,
      reviewFor(current, hiddenEnteredTextEdit)
    )
  );

  const hiddenRangeEdit = [
    entryFor(primary),
    {
      ...entryFor(mentioned),
      range: range('Rom', 12, 1, 2)
    }
  ];
  expectReviewCode(
    'RANGE_REPLACEMENT_REQUIRED',
    () => applySermonReferenceReview(
      current,
      reviewFor(current, hiddenRangeEdit)
    )
  );

  const emptyReplacement = [
    entryFor(primary),
    { ...entryFor(mentioned), replaced: true, enteredText: '' }
  ];
  expectReviewCode(
    'INVALID_REFERENCE_ENTRY',
    () => applySermonReferenceReview(current, reviewFor(current, emptyReplacement))
  );
});

test('real legacy edits upgrade to v3 while preserving the exact prior revision', () => {
  for (const schemaVersion of [1, 2]) {
    const current = normalizeSermonDocument(sermonFixture({ schemaVersion }));
    const previousSource = serializeSermonDocument(current);
    const previousRevision = sermonDocumentSha256(current);
    const entries = current.references.map(entryFor);
    entries.reverse();
    const result = applySermonReferenceReview(
      current,
      reviewFor(current, entries)
    );

    assert.equal(result.changed, true);
    assert.equal(result.document.schemaVersion, 3);
    assert.deepEqual(result.document.body, []);
    assert.equal(result.upgradedFromSchemaVersion, schemaVersion);
    assert.equal(result.previousRevision, previousRevision);
    assert.notEqual(result.revision, previousRevision);
    assert.equal(serializeSermonDocument(current), previousSource);
    assert.equal(sermonDocumentSha256(current), previousRevision);
  }
});

test('any real ready or published edit resets publication without losing audience or URL', () => {
  for (const publicationStatus of ['ready', 'published']) {
    const current = normalizeSermonDocument(sermonFixture({
      publicationStatus
    }));
    const entries = current.references.map(entryFor);
    entries[1] = {
      ...entries[1],
      reviewStatus: 'suggested'
    };
    const result = applySermonReferenceReview(
      current,
      reviewFor(current, entries)
    );

    assert.equal(result.publicationReset, true);
    assert.equal(result.document.publication.status, 'draft');
    assert.equal(
      result.document.publication.visibility,
      current.publication.visibility
    );
    assert.equal(
      result.document.publication.canonicalUrl,
      current.publication.canonicalUrl
    );
    assert.equal(result.document.publication.publishedAt, null);
  }
});

test('stale reviews, archived sermons, and loss of the final confirmed primary fail closed', () => {
  const current = normalizeSermonDocument(sermonFixture());
  expectReviewCode(
    'SERMON_REVISION_MISMATCH',
    () => applySermonReferenceReview(current, {
      baseSermonRevisionId: 'b'.repeat(64),
      entries: current.references.map(entryFor)
    })
  );

  const archived = normalizeSermonDocument(sermonFixture({
    publicationStatus: 'archived'
  }));
  expectReviewCode(
    'ARCHIVED_SERMON',
    () => applySermonReferenceReview(
      archived,
      reviewFor(archived, archived.references.map(entryFor))
    )
  );

  const withoutPrimary = current.references.map(entryFor);
  withoutPrimary[0] = {
    ...withoutPrimary[0],
    role: 'mentioned'
  };
  expectReviewCode(
    'MISSING_CONFIRMED_PRIMARY_REFERENCE',
    () => applySermonReferenceReview(
      current,
      reviewFor(current, withoutPrimary)
    )
  );
});

test('stable identities, strict fields, canonical ranges, and unique role/ranges are enforced', () => {
  const current = normalizeSermonDocument(sermonFixture());
  const [primary, mentioned] = current.references;

  expectReviewCode(
    'REFERENCE_ID_CHANGED',
    () => applySermonReferenceReview(current, reviewFor(current, [
      {
        ...entryFor(primary),
        referenceId: 'renamed-primary'
      },
      entryFor(mentioned)
    ]))
  );

  expectReviewCode(
    'REFERENCE_ID_COLLISION',
    () => applySermonReferenceReview(current, reviewFor(current, [
      entryFor(primary),
      {
        ...entryFor(mentioned),
        existingReferenceId: null
      }
    ]))
  );

  expectReviewCode(
    'INVALID_REFERENCE_ENTRY',
    () => applySermonReferenceReview(current, reviewFor(current, [
      { ...entryFor(primary), rendererOwnedSource: 'pastor' },
      entryFor(mentioned)
    ]))
  );

  expectReviewCode(
    'NONCANONICAL_REFERENCE_RANGE',
    () => applySermonReferenceReview(current, reviewFor(current, [
      entryFor(primary),
      {
        ...entryFor(mentioned),
        range: {
          schemaVersion: 1,
          bookId: 'rom',
          start: { chapter: 12, verse: 2 },
          end: { chapter: 12, verse: 2 }
        }
      }
    ]))
  );

  expectReviewCode(
    'DUPLICATE_REFERENCE_RANGE',
    () => applySermonReferenceReview(current, reviewFor(current, [
      entryFor(primary),
      {
        referenceId: 'another-primary',
        existingReferenceId: null,
        range: structuredClone(primary.range),
        replaced: false,
        enteredText: 'John 3:16',
        role: 'primary',
        reviewStatus: 'confirmed',
        sectionId: null
      },
      entryFor(mentioned)
    ]))
  );
});

test('the final list is bounded before individual entries are evaluated', () => {
  const current = normalizeSermonDocument(sermonFixture());
  const entries = Array.from(
    { length: MAX_SERMON_REFERENCE_REVIEW_ENTRIES + 1 },
    (_unused, index) => ({ hostile: index })
  );
  expectReviewCode(
    'TOO_MANY_REFERENCES',
    () => applySermonReferenceReview(current, reviewFor(current, entries))
  );
});
