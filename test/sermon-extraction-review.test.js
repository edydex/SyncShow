'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const sermonApi = require('../src/services/sermon');

const {
  MAX_SELECTED_OUTLINE_SUGGESTIONS,
  MAX_SERMON_REFERENCES,
  REFERENCE_SOURCE_BY_SERMON_SOURCE_KIND,
  SERMON_EXTRACTION_PROPOSAL_KIND,
  SERMON_EXTRACTION_PROPOSAL_SCHEMA_VERSION,
  SERMON_KIND,
  SERMON_SCHEMA_VERSION,
  SermonExtractionReviewError,
  applySermonExtractionReview,
  canonicalBibleChapterVerseMaximum,
  normalizeSermonDocument,
  normalizeSermonExtractionProposal,
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

function sermonFixture({ schemaVersion = SERMON_SCHEMA_VERSION } = {}) {
  const source = {
    id: 'source-manuscript',
    kind: 'manuscript',
    fileName: 'sermon.pdf',
    mediaType: 'application/pdf',
    sha256: 'a'.repeat(64),
    sizeBytes: 12345,
    provenance: {
      providedBy: 'Pastor Example',
      receivedAt: '2026-07-26T18:30:00.000Z',
      sourceSystem: 'pastor-email',
      externalId: 'message-1'
    }
  };
  if (schemaVersion === 1) source.language = 'en';
  else source.languages = ['en'];

  return {
    schemaVersion,
    kind: SERMON_KIND,
    id: 'sermon-review-example',
    titles: { en: 'Review Example' },
    defaultLanguage: 'en',
    speaker: { id: null, name: 'Pastor Example' },
    serviceDate: '2026-07-26',
    series: null,
    outline: [{
      id: 'existing-root',
      parentId: null,
      kind: 'section',
      titles: { en: 'Existing root' }
    }],
    sources: [source],
    references: [{
      id: 'primary-john-3-16',
      range: range('John', 3, 16),
      role: 'primary',
      source: 'pastor',
      reviewStatus: 'confirmed',
      enteredText: 'John 3:16',
      sourceId: 'source-manuscript',
      sectionId: null,
      startOffset: null,
      endOffset: null
    }],
    media: [],
    publication: {
      status: 'draft',
      visibility: 'private',
      publishedAt: null,
      canonicalUrl: null
    }
  };
}

function proposalFor(rawSermon, overrides = {}) {
  const sermon = normalizeSermonDocument(rawSermon);
  return {
    schemaVersion: SERMON_EXTRACTION_PROPOSAL_SCHEMA_VERSION,
    kind: SERMON_EXTRACTION_PROPOSAL_KIND,
    id: 'proposal-review-example',
    sermonId: sermon.id,
    sermonRevision: sermonDocumentSha256(sermon),
    sourceId: 'source-manuscript',
    sourceKind: 'manuscript',
    sourceRevision: 'a'.repeat(64),
    outlineSuggestions: [{
      id: 'outline-application',
      canonical: {
        id: 'application',
        parentId: 'existing-root',
        kind: 'point',
        titles: { en: 'Apply the truth' }
      },
      text: 'TRANSIENT OUTLINE TEXT',
      evidence: { quote: 'TRANSIENT OUTLINE EVIDENCE' },
      derivatives: ['TRANSIENT OUTLINE DERIVATIVE']
    }, {
      id: 'outline-unselected',
      canonical: {
        id: 'unselected-point',
        parentId: null,
        kind: 'point',
        titles: { en: 'Do not persist me' }
      }
    }],
    referenceSuggestions: [{
      id: 'reference-romans-12-2',
      canonical: {
        id: 'mentioned-romans-12-2',
        range: range('Rom', 12, 2),
        enteredText: 'Romans 12:2',
        sectionId: 'application',
        startOffset: 210,
        endOffset: 222
      },
      text: 'TRANSIENT REFERENCE TEXT',
      evidence: { quote: 'TRANSIENT REFERENCE EVIDENCE' },
      derivatives: ['TRANSIENT REFERENCE DERIVATIVE']
    }, {
      id: 'reference-unselected',
      canonical: {
        id: 'mentioned-philippians-4-8',
        range: range('Phil', 4, 8),
        enteredText: 'Philippians 4:8',
        sectionId: null,
        startOffset: null,
        endOffset: null
      }
    }],
    text: 'TRANSIENT PROPOSAL TEXT',
    evidence: { model: 'TRANSIENT PROPOSAL EVIDENCE' },
    derivatives: ['TRANSIENT PROPOSAL DERIVATIVE'],
    ...overrides
  };
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function expectReviewCode(code, callback) {
  assert.throws(callback, error => {
    assert.ok(error instanceof SermonExtractionReviewError);
    assert.equal(error.code, code);
    return true;
  });
}

test('sermon index exports a clear normalized proposal and selection review API', () => {
  assert.equal(typeof sermonApi.applySermonExtractionReview, 'function');
  assert.equal(typeof sermonApi.normalizeSermonExtractionProposal, 'function');
  assert.equal(typeof sermonApi.normalizeSermonExtractionSelection, 'function');
  assert.equal(
    sermonApi.SermonExtractionReviewError,
    SermonExtractionReviewError
  );
  assert.deepEqual(REFERENCE_SOURCE_BY_SERMON_SOURCE_KIND, {
    manuscript: 'manuscript',
    'slide-notes': 'slide-notes',
    transcript: 'transcript-extraction',
    other: 'operator'
  });

  const normalized = normalizeSermonExtractionProposal(
    proposalFor(sermonFixture())
  );
  assert.deepEqual(Object.keys(normalized), [
    'schemaVersion',
    'kind',
    'id',
    'sermonId',
    'sermonRevision',
    'sourceId',
    'sourceKind',
    'sourceRevision',
    'outlineSuggestions',
    'referenceSuggestions'
  ]);
  assert.deepEqual(Object.keys(normalized.outlineSuggestions[0]), ['id', 'canonical']);
  assert.deepEqual(Object.keys(normalized.referenceSuggestions[0]), ['id', 'canonical']);
  assert.ok(Object.isFrozen(normalized));
  assert.ok(Object.isFrozen(normalized.referenceSuggestions[0].canonical.range));
});

test('review applies only selected canonical suggestions and drops all extraction material', () => {
  const current = normalizeSermonDocument(sermonFixture());
  const confirmedPrimary = current.references[0];
  const proposal = proposalFor(current);
  const reviewed = applySermonExtractionReview(current, proposal, {
    outlineSuggestionIds: ['outline-application'],
    referenceSuggestionIds: ['reference-romans-12-2']
  });

  assert.equal(reviewed.changed, true);
  assert.equal(reviewed.previousRevision, proposal.sermonRevision);
  assert.equal(reviewed.revision, sermonDocumentSha256(reviewed.document));
  assert.deepEqual(reviewed.applied, {
    outlineSuggestionIds: ['outline-application'],
    referenceSuggestionIds: ['reference-romans-12-2']
  });
  assert.deepEqual(reviewed.document.outline.map(section => section.id), [
    'existing-root',
    'application'
  ]);
  assert.deepEqual(reviewed.document.references.map(reference => reference.id), [
    'primary-john-3-16',
    'mentioned-romans-12-2'
  ]);
  assert.deepEqual(reviewed.document.references[0], confirmedPrimary);
  assert.deepEqual(reviewed.document.references[1], {
    id: 'mentioned-romans-12-2',
    range: range('Rom', 12, 2),
    role: 'mentioned',
    source: 'manuscript',
    reviewStatus: 'suggested',
    enteredText: 'Romans 12:2',
    sourceId: 'source-manuscript',
    sectionId: 'application',
    startOffset: 210,
    endOffset: 222
  });

  const source = serializeSermonDocument(reviewed.document);
  assert.doesNotMatch(source, /TRANSIENT|evidence|derivatives/);
  assert.doesNotMatch(source, /unselected-point|mentioned-philippians-4-8/);
});

test('suggested mentioned references derive provenance only from the bound source kind', () => {
  for (const [sourceKind, expectedReferenceSource] of Object.entries(
    REFERENCE_SOURCE_BY_SERMON_SOURCE_KIND
  )) {
    const raw = sermonFixture();
    raw.sources[0].kind = sourceKind;
    const current = normalizeSermonDocument(raw);
    const proposal = proposalFor(current, { sourceKind });
    const reviewed = applySermonExtractionReview(current, proposal, {
      referenceSuggestionIds: ['reference-unselected']
    });
    const reference = reviewed.document.references.at(-1);

    assert.equal(reference.role, 'mentioned');
    assert.equal(reference.reviewStatus, 'suggested');
    assert.equal(reference.sourceId, 'source-manuscript');
    assert.equal(reference.source, expectedReferenceSource);
  }
});

test('real extraction changes reopen publication review without changing audience or URL', () => {
  const publishedRaw = sermonFixture();
  publishedRaw.publication = {
    status: 'published',
    visibility: 'public',
    publishedAt: '2026-07-27T18:00:00.000Z',
    canonicalUrl: 'https://church.example/sermons/review-example'
  };
  const published = normalizeSermonDocument(publishedRaw);
  const referenceReview = applySermonExtractionReview(
    published,
    proposalFor(published),
    { referenceSuggestionIds: ['reference-unselected'] }
  );

  assert.equal(referenceReview.changed, true);
  assert.deepEqual(referenceReview.document.publication, {
    status: 'draft',
    visibility: 'public',
    publishedAt: null,
    canonicalUrl: 'https://church.example/sermons/review-example'
  });
  assert.equal(
    referenceReview.document.references.at(-1).reviewStatus,
    'suggested'
  );
  assert.equal(published.publication.status, 'published');

  const readyRaw = sermonFixture();
  readyRaw.publication = {
    status: 'ready',
    visibility: 'members',
    publishedAt: null,
    canonicalUrl: 'https://church.example/sermons/ready-review-example'
  };
  const ready = normalizeSermonDocument(readyRaw);
  const outlineReview = applySermonExtractionReview(
    ready,
    proposalFor(ready),
    { outlineSuggestionIds: ['outline-unselected'] }
  );

  assert.equal(outlineReview.changed, true);
  assert.deepEqual(outlineReview.document.publication, {
    status: 'draft',
    visibility: 'members',
    publishedAt: null,
    canonicalUrl: 'https://church.example/sermons/ready-review-example'
  });

  const exactNoOpProposal = proposalFor(ready, {
    id: 'proposal-exact-outline-no-op',
    outlineSuggestions: [{
      id: 'outline-existing-root',
      canonical: clone(ready.outline[0])
    }],
    referenceSuggestions: []
  });
  const exactNoOp = applySermonExtractionReview(
    ready,
    exactNoOpProposal,
    { outlineSuggestionIds: ['outline-existing-root'] }
  );

  assert.equal(exactNoOp.changed, false);
  assert.equal(exactNoOp.document.publication.status, 'ready');
  assert.equal(exactNoOp.revision, sermonDocumentSha256(ready));
});

test('archived sermons reject extraction review before any content can change', () => {
  const raw = sermonFixture();
  raw.publication = {
    status: 'archived',
    visibility: 'private',
    publishedAt: null,
    canonicalUrl: null
  };
  const archived = normalizeSermonDocument(raw);

  expectReviewCode('ARCHIVED_SERMON', () => applySermonExtractionReview(
    archived,
    proposalFor(archived),
    {
      outlineSuggestionIds: ['outline-application'],
      referenceSuggestionIds: ['reference-romans-12-2']
    }
  ));
  assert.equal(archived.outline.length, 1);
  assert.equal(archived.references.length, 1);
  assert.equal(archived.publication.status, 'archived');
});

test('extraction enforces the shared final Scripture-reference limit', () => {
  const psalmCoordinate = ordinal => {
    let remaining = ordinal;
    for (let chapter = 1; chapter <= 150; chapter += 1) {
      const verseMaximum = canonicalBibleChapterVerseMaximum('Ps', chapter);
      if (remaining <= verseMaximum) return { chapter, verse: remaining };
      remaining -= verseMaximum;
    }
    throw new Error(`Psalm coordinate ordinal ${ordinal} is unavailable.`);
  };
  const referencesAtCount = count => {
    const references = clone(sermonFixture().references);
    for (let index = 1; index < count; index += 1) {
      const coordinate = psalmCoordinate(index);
      references.push({
        id: `existing-reference-${index}`,
        range: range('Ps', coordinate.chapter, coordinate.verse),
        role: 'mentioned',
        source: 'manuscript',
        reviewStatus: 'suggested',
        enteredText: `Psalm reference ${index}`,
        sourceId: 'source-manuscript',
        sectionId: null,
        startOffset: null,
        endOffset: null
      });
    }
    return references;
  };
  const oneReferenceProposal = current => proposalFor(current, {
    id: `proposal-limit-${current.references.length}`,
    outlineSuggestions: [],
    referenceSuggestions: [{
      id: 'reference-limit-addition',
      canonical: {
        id: 'reference-limit-addition',
        range: range('Rev', 22, 21),
        enteredText: 'Revelation 22:21',
        sectionId: null,
        startOffset: null,
        endOffset: null
      }
    }]
  });
  const selection = {
    referenceSuggestionIds: ['reference-limit-addition']
  };

  const exactRaw = sermonFixture();
  exactRaw.references = referencesAtCount(MAX_SERMON_REFERENCES - 1);
  const exact = normalizeSermonDocument(exactRaw);
  const exactReview = applySermonExtractionReview(
    exact,
    oneReferenceProposal(exact),
    selection
  );
  assert.equal(exactReview.document.references.length, MAX_SERMON_REFERENCES);

  const overflowRaw = sermonFixture();
  overflowRaw.references = referencesAtCount(MAX_SERMON_REFERENCES);
  const overflow = normalizeSermonDocument(overflowRaw);
  expectReviewCode('TOO_MANY_REFERENCES', () => applySermonExtractionReview(
    overflow,
    oneReferenceProposal(overflow),
    selection
  ));
  assert.equal(overflow.references.length, MAX_SERMON_REFERENCES);
});

test('identical retry is an exact no-op even after the first application changes revision', () => {
  const current = normalizeSermonDocument(sermonFixture());
  const proposal = proposalFor(current);
  const selection = {
    outlineSuggestionIds: ['outline-application'],
    referenceSuggestionIds: ['reference-romans-12-2']
  };
  const first = applySermonExtractionReview(current, proposal, selection);
  const repeated = applySermonExtractionReview(first.document, proposal, selection);

  assert.equal(first.changed, true);
  assert.equal(repeated.changed, false);
  assert.equal(repeated.previousRevision, first.revision);
  assert.equal(repeated.revision, first.revision);
  assert.deepEqual(repeated.applied, {
    outlineSuggestionIds: [],
    referenceSuggestionIds: []
  });
  assert.equal(
    serializeSermonDocument(repeated.document),
    serializeSermonDocument(first.document)
  );
});

test('review safely enriches localized outline titles and rejects same-language conflicts', () => {
  const current = normalizeSermonDocument(sermonFixture());
  const proposal = proposalFor(current, {
    id: 'proposal-outline-ru-enrichment',
    outlineSuggestions: [{
      id: 'outline-existing-root-ru',
      canonical: {
        id: 'existing-root',
        parentId: null,
        kind: 'section',
        titles: { ru: 'Существующий корень' }
      }
    }],
    referenceSuggestions: []
  });
  const selection = {
    outlineSuggestionIds: ['outline-existing-root-ru']
  };

  const first = applySermonExtractionReview(current, proposal, selection);
  assert.equal(first.changed, true);
  assert.deepEqual(first.applied.outlineSuggestionIds, ['outline-existing-root-ru']);
  assert.equal(first.document.outline.length, 1);
  assert.deepEqual(first.document.outline[0].titles, {
    en: 'Existing root',
    ru: 'Существующий корень'
  });

  const repeated = applySermonExtractionReview(first.document, proposal, selection);
  assert.equal(repeated.changed, false);
  assert.equal(repeated.revision, first.revision);
  assert.deepEqual(repeated.applied.outlineSuggestionIds, []);
  assert.equal(
    serializeSermonDocument(repeated.document),
    serializeSermonDocument(first.document)
  );

  const conflicting = proposalFor(first.document, {
    id: 'proposal-outline-en-conflict',
    outlineSuggestions: [{
      id: 'outline-existing-root-conflict',
      canonical: {
        id: 'existing-root',
        parentId: null,
        kind: 'section',
        titles: { en: 'Conflicting root title' }
      }
    }],
    referenceSuggestions: []
  });
  expectReviewCode('CANONICAL_ID_COLLISION', () => applySermonExtractionReview(
    first.document,
    conflicting,
    { outlineSuggestionIds: ['outline-existing-root-conflict'] }
  ));
});

test('v1 stays v1 for no-op review and upgrades only when selected content really changes', () => {
  const current = normalizeSermonDocument(sermonFixture({ schemaVersion: 1 }));
  const proposal = proposalFor(current, {
    outlineSuggestions: [{
      id: 'outline-already-present',
      canonical: {
        id: 'existing-root',
        parentId: null,
        kind: 'section',
        titles: { en: 'Existing root' }
      }
    }],
    referenceSuggestions: [{
      id: 'reference-romans-8-1',
      canonical: {
        id: 'mentioned-romans-8-1',
        range: range('Rom', 8, 1),
        enteredText: 'Romans 8:1',
        sectionId: 'existing-root',
        startOffset: null,
        endOffset: null
      }
    }]
  });

  const empty = applySermonExtractionReview(current, proposal, {});
  assert.equal(empty.changed, false);
  assert.equal(empty.document.schemaVersion, 1);
  assert.equal(empty.revision, sermonDocumentSha256(current));

  const identical = applySermonExtractionReview(current, proposal, {
    outlineSuggestionIds: ['outline-already-present']
  });
  assert.equal(identical.changed, false);
  assert.equal(identical.document.schemaVersion, 1);

  const enrichmentProposal = proposalFor(current, {
    id: 'proposal-v1-outline-enrichment',
    outlineSuggestions: [{
      id: 'outline-existing-root-ru',
      canonical: {
        id: 'existing-root',
        parentId: null,
        kind: 'section',
        titles: { ru: 'Существующий корень' }
      }
    }],
    referenceSuggestions: []
  });
  const enriched = applySermonExtractionReview(current, enrichmentProposal, {
    outlineSuggestionIds: ['outline-existing-root-ru']
  });
  assert.equal(enriched.changed, true);
  assert.equal(enriched.document.schemaVersion, SERMON_SCHEMA_VERSION);
  assert.deepEqual(enriched.document.outline[0].titles, {
    en: 'Existing root',
    ru: 'Существующий корень'
  });

  const changed = applySermonExtractionReview(current, proposal, {
    referenceSuggestionIds: ['reference-romans-8-1']
  });
  assert.equal(changed.changed, true);
  assert.equal(changed.document.schemaVersion, SERMON_SCHEMA_VERSION);
  assert.deepEqual(changed.document.sources[0].languages, ['en']);
  assert.equal(Object.hasOwn(changed.document.sources[0], 'language'), false);
});

test('review fails closed when sermon or source binding is wrong or stale', () => {
  const current = normalizeSermonDocument(sermonFixture());
  const selection = { outlineSuggestionIds: ['outline-application'] };

  expectReviewCode('SERMON_MISMATCH', () => applySermonExtractionReview(
    current,
    proposalFor(current, { sermonId: 'different-sermon' }),
    selection
  ));
  expectReviewCode('SERMON_REVISION_MISMATCH', () => applySermonExtractionReview(
    current,
    proposalFor(current, { sermonRevision: 'b'.repeat(64) }),
    selection
  ));
  expectReviewCode('SOURCE_MISMATCH', () => applySermonExtractionReview(
    current,
    proposalFor(current, { sourceId: 'different-source' }),
    selection
  ));
  expectReviewCode('SOURCE_MISMATCH', () => applySermonExtractionReview(
    current,
    proposalFor(current, { sourceKind: 'slide-notes' }),
    selection
  ));
  expectReviewCode('SOURCE_REVISION_MISMATCH', () => applySermonExtractionReview(
    current,
    proposalFor(current, { sourceRevision: 'b'.repeat(64) }),
    selection
  ));

  expectReviewCode('SERMON_REVISION_MISMATCH', () => applySermonExtractionReview(
    current,
    proposalFor(current, { sermonRevision: 'b'.repeat(64) }),
    {}
  ));
});

test('review rejects unknown, duplicate, and excessive selection ids', () => {
  const current = normalizeSermonDocument(sermonFixture());
  const proposal = proposalFor(current);

  expectReviewCode('UNKNOWN_SUGGESTION_ID', () => applySermonExtractionReview(
    current,
    proposal,
    { outlineSuggestionIds: ['missing-suggestion'] }
  ));
  expectReviewCode('DUPLICATE_SELECTION_ID', () => applySermonExtractionReview(
    current,
    proposal,
    { referenceSuggestionIds: ['reference-romans-12-2', 'reference-romans-12-2'] }
  ));
  expectReviewCode('TOO_MANY_SELECTION_IDS', () => applySermonExtractionReview(
    current,
    proposal,
    {
      outlineSuggestionIds: Array.from(
        { length: MAX_SELECTED_OUTLINE_SUGGESTIONS + 1 },
        (_, index) => `suggestion-${index}`
      )
    }
  ));
});

test('proposal validation rejects duplicate ids, malformed suggestions, and noncanonical ranges', () => {
  const current = normalizeSermonDocument(sermonFixture());

  const duplicateSuggestion = proposalFor(current);
  duplicateSuggestion.referenceSuggestions[0].id =
    duplicateSuggestion.outlineSuggestions[0].id;
  expectReviewCode(
    'DUPLICATE_SUGGESTION_ID',
    () => normalizeSermonExtractionProposal(duplicateSuggestion)
  );

  const duplicateCanonical = proposalFor(current);
  duplicateCanonical.outlineSuggestions[1].canonical.id =
    duplicateCanonical.outlineSuggestions[0].canonical.id;
  expectReviewCode(
    'CANONICAL_ID_COLLISION',
    () => normalizeSermonExtractionProposal(duplicateCanonical)
  );

  const noncanonicalRange = proposalFor(current);
  noncanonicalRange.referenceSuggestions[0].canonical.range = {
    book: 'Romans',
    chapter: 12,
    verse: 2
  };
  expectReviewCode(
    'NON_CANONICAL_BIBLE_RANGE',
    () => normalizeSermonExtractionProposal(noncanonicalRange)
  );

  const lowercaseBookId = proposalFor(current);
  lowercaseBookId.referenceSuggestions[0].canonical.range.bookId = 'rom';
  expectReviewCode(
    'NON_CANONICAL_BIBLE_RANGE',
    () => normalizeSermonExtractionProposal(lowercaseBookId)
  );

  const authoritativeOverride = proposalFor(current);
  authoritativeOverride.referenceSuggestions[0].canonical.sourceId = 'attacker-source';
  expectReviewCode(
    'MALFORMED_SUGGESTION',
    () => normalizeSermonExtractionProposal(authoritativeOverride)
  );

  const partialOffsets = proposalFor(current);
  partialOffsets.referenceSuggestions[0].canonical.endOffset = null;
  expectReviewCode(
    'MALFORMED_SUGGESTION',
    () => normalizeSermonExtractionProposal(partialOffsets)
  );

  const cyclicOutline = proposalFor(current);
  cyclicOutline.outlineSuggestions[0].canonical.parentId = 'unselected-point';
  cyclicOutline.outlineSuggestions[1].canonical.parentId = 'application';
  expectReviewCode('MALFORMED_SUGGESTION', () => applySermonExtractionReview(
    current,
    cyclicOutline,
    {}
  ));
});

test('review rejects stale dependencies, unselected dependencies, and canonical collisions', () => {
  const current = normalizeSermonDocument(sermonFixture());

  const stale = proposalFor(current);
  stale.outlineSuggestions[0].canonical.parentId = 'deleted-section';
  expectReviewCode('STALE_SUGGESTION', () => applySermonExtractionReview(
    current,
    stale,
    { outlineSuggestionIds: ['outline-application'] }
  ));

  expectReviewCode(
    'UNSELECTED_SUGGESTION_DEPENDENCY',
    () => applySermonExtractionReview(
      current,
      proposalFor(current),
      { referenceSuggestionIds: ['reference-romans-12-2'] }
    )
  );

  const outlineCollision = proposalFor(current);
  outlineCollision.outlineSuggestions[0].canonical = {
    id: 'existing-root',
    parentId: null,
    kind: 'section',
    titles: { en: 'Different canonical content' }
  };
  outlineCollision.referenceSuggestions[0].canonical.sectionId = 'existing-root';
  expectReviewCode('CANONICAL_ID_COLLISION', () => applySermonExtractionReview(
    current,
    outlineCollision,
    { outlineSuggestionIds: ['outline-application'] }
  ));

  const primaryCollision = proposalFor(current);
  primaryCollision.referenceSuggestions[1].canonical.id = 'primary-john-3-16';
  expectReviewCode('CANONICAL_ID_COLLISION', () => applySermonExtractionReview(
    current,
    primaryCollision,
    { referenceSuggestionIds: ['reference-unselected'] }
  ));
});
