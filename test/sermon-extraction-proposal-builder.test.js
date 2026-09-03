'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  SERMON_KIND,
  SERMON_SCHEMA_VERSION,
  SermonExtractionProposalBuilderError,
  applySermonExtractionReview,
  buildSermonExtractionReviewProposal,
  normalizeSermonDocument,
  rangeContains,
  sermonDocumentSha256
} = require('../src/services/sermon');

function range(bookId, chapter, startVerse, endVerse = startVerse) {
  return {
    schemaVersion: 1,
    bookId,
    start: { chapter, verse: startVerse },
    end: { chapter, verse: endVerse }
  };
}

function fixture() {
  return normalizeSermonDocument({
    schemaVersion: SERMON_SCHEMA_VERSION,
    kind: SERMON_KIND,
    id: 'sermon-extraction-builder',
    titles: { en: 'Prayer That Transforms the Church' },
    defaultLanguage: 'en',
    speaker: { id: null, name: 'Pastor Example' },
    serviceDate: '2026-07-26',
    series: null,
    outline: [],
    sources: [{
      id: 'source-manuscript',
      kind: 'manuscript',
      fileName: 'sermon.pdf',
      mediaType: 'application/pdf',
      sha256: 'a'.repeat(64),
      sizeBytes: 1024,
      languages: ['en', 'ru'],
      provenance: {
        providedBy: 'Pastor Example',
        receivedAt: '2026-07-26T18:00:00.000Z',
        sourceSystem: 'manual-file-picker',
        externalId: ''
      }
    }],
    references: [{
      id: 'primary-ephesians-3-14-21',
      range: range('Eph', 3, 14, 21),
      role: 'primary',
      source: 'pastor',
      reviewStatus: 'confirmed',
      enteredText: 'Ephesians 3:14-21',
      sourceId: null,
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
  });
}

function extraction(source) {
  const ephesiansReference = 'Еф. 3:16–19';
  const romansEnglishReference = 'Romans 5:5–8';
  const romansRussianReference = 'Рим. 5:5–8';
  const pageOneText = `I. Foundation\n${ephesiansReference}`;
  const pageTwoText = [
    'A. Strengthened by the Spirit',
    romansEnglishReference,
    romansRussianReference
  ].join('\n');
  return {
    schemaVersion: 1,
    kind: 'syncshow-sermon-source-extraction-proposal',
    extractor: {
      id: 'syncshow-deterministic-source-extractor',
      version: 1
    },
    source: {
      id: source.id,
      sha256: source.sha256,
      kind: source.kind,
      languages: source.languages,
      mediaType: source.mediaType
    },
    units: [{
      id: 'page-1',
      kind: 'page',
      ordinal: 1,
      label: 'Page 1',
      text: pageOneText,
      truncated: false
    }, {
      id: 'page-2',
      kind: 'page',
      ordinal: 2,
      label: 'Page 2',
      text: pageTwoText,
      truncated: false
    }],
    textPreview: `${pageOneText}\n${pageTwoText}`,
    outlineSuggestions: [{
      id: 'outline-i',
      level: 1,
      marker: 'I',
      parentId: null,
      parentSuggestionId: null,
      suggestedKind: 'section',
      titles: { en: 'Foundation', ru: 'Основание' },
      rawText: 'I. Foundation / Основание',
      sourceUnitIds: ['page-1'],
      sourceUnitIdsTruncated: false,
      occurrenceCount: 1
    }, {
      id: 'outline-a',
      level: 2,
      marker: 'A',
      parentId: 'outline-i',
      parentSuggestionId: 'outline-i',
      suggestedKind: 'point',
      titles: { en: 'Strengthened', ru: 'Укрепились' },
      rawText: 'A. Strengthened / Укрепились',
      sourceUnitIds: ['page-2'],
      sourceUnitIdsTruncated: false,
      occurrenceCount: 1
    }],
    scriptureReferenceSuggestions: [{
      id: 'ref-primary-subrange',
      rawText: 'Еф. 3:16–19',
      language: 'ru',
      bookHint: 'Eph',
      unitId: 'page-1',
      startOffset: pageOneText.indexOf(ephesiansReference),
      endOffset: pageOneText.indexOf(ephesiansReference) + ephesiansReference.length,
      sourceUnitIds: ['page-1'],
      sourceUnitIdsTruncated: false,
      occurrenceCount: 1
    }, {
      id: 'ref-romans-first',
      rawText: 'Romans 5:5–8',
      language: 'en',
      bookHint: 'Rom',
      unitId: 'page-2',
      startOffset: pageTwoText.indexOf(romansEnglishReference),
      endOffset: pageTwoText.indexOf(romansEnglishReference)
        + romansEnglishReference.length,
      sourceUnitIds: ['page-2'],
      sourceUnitIdsTruncated: false,
      occurrenceCount: 1
    }, {
      id: 'ref-romans-duplicate',
      rawText: 'Рим. 5:5–8',
      language: 'ru',
      bookHint: 'Rom',
      unitId: 'page-2',
      startOffset: pageTwoText.indexOf(romansRussianReference),
      endOffset: pageTwoText.indexOf(romansRussianReference)
        + romansRussianReference.length,
      sourceUnitIds: ['page-2'],
      sourceUnitIdsTruncated: false,
      occurrenceCount: 1
    }],
    suggestionScope: {
      strategy: 'whole-source',
      startUnitId: 'page-1',
      endUnitId: 'page-2',
      startOrdinal: 1,
      endOrdinal: 2
    },
    truncated: {
      units: false,
      text: false,
      preview: false,
      outlineSuggestions: false,
      scriptureReferences: false
    }
  };
}

async function build(sermon, proposalId, options = {}) {
  const source = options.source || sermon.sources[0];
  const extracted = options.extraction || extraction(source);
  return buildSermonExtractionReviewProposal({
    sermon,
    sermonRevision: sermonDocumentSha256(sermon),
    source,
    extraction: extracted,
    proposalId,
    async resolveReference(suggestion) {
      if (suggestion.bookHint === 'Eph') return range('Eph', 3, 16, 19);
      if (suggestion.bookHint === 'Rom') return range('Rom', 5, 5, 8);
      return null;
    }
  });
}

test('range containment distinguishes the preached passage from other citations', () => {
  assert.equal(rangeContains(
    range('Eph', 3, 14, 21),
    range('Eph', 3, 16, 19)
  ), true);
  assert.equal(rangeContains(
    range('Eph', 3, 14, 21),
    range('Eph', 3, 10, 16)
  ), false);
  assert.equal(rangeContains(
    range('Eph', 3, 14, 21),
    range('Rom', 3, 16, 19)
  ), false);
});

test('builder binds canonical suggestions and removes primary-range and duplicate noise', async () => {
  const sermon = fixture();
  const built = await build(sermon, 'proposal-first');

  assert.equal(built.internalProposal.sermonId, sermon.id);
  assert.equal(built.internalProposal.sourceId, sermon.sources[0].id);
  assert.equal(built.internalProposal.sourceRevision, sermon.sources[0].sha256);
  assert.equal(built.internalProposal.outlineSuggestions.length, 2);
  assert.equal(built.internalProposal.referenceSuggestions.length, 1);
  assert.equal(
    built.internalProposal.outlineSuggestions[1].canonical.parentId,
    built.internalProposal.outlineSuggestions[0].canonical.id
  );
  assert.deepEqual(
    built.publicProposal.outlineSuggestions.map(item => item.parentSuggestionId),
    ['', 'outline:outline-i']
  );
  assert.equal(built.publicProposal.referenceSuggestions[0].enteredText, 'Romans 5:5–8');
  assert.deepEqual(
    built.publicProposal.referenceSuggestions[0].canonicalReference,
    range('Rom', 5, 5, 8)
  );
  assert.equal(
    built.internalProposal.referenceSuggestions[0].canonical.startOffset,
    null,
    'unit-local offsets must not be persisted without a canonical unit id'
  );
  assert.match(built.publicProposal.referenceSuggestions[0].evidence.text, /Page 2/);
  assert.equal(built.publicProposal.extraction.unitLabel, 'pages');
  assert.doesNotMatch(JSON.stringify(built.publicProposal), /unitId|startOffset|endOffset/);
});

test('canonical ids are stable and a fresh extraction omits already-applied content', async () => {
  const sermon = fixture();
  const first = await build(sermon, 'proposal-first');
  const reviewed = applySermonExtractionReview(
    sermon,
    first.internalProposal,
    {
      outlineSuggestionIds: first.internalProposal.outlineSuggestions.map(item => item.id),
      referenceSuggestionIds: first.internalProposal.referenceSuggestions.map(item => item.id)
    }
  );
  const second = await build(reviewed.document, 'proposal-second');

  assert.equal(reviewed.changed, true);
  assert.equal(reviewed.document.references.at(-1).reviewStatus, 'suggested');
  assert.deepEqual(second.internalProposal.outlineSuggestions, []);
  assert.deepEqual(second.internalProposal.referenceSuggestions, []);
  assert.deepEqual(second.publicProposal.outlineSuggestions, []);
  assert.deepEqual(second.publicProposal.referenceSuggestions, []);
});

test('identical re-extraction ignores localized-title insertion order', async () => {
  const sermon = fixture();
  const source = sermon.sources[0];
  const extracted = extraction(source);
  extracted.outlineSuggestions[0].titles = {
    ru: 'Основание',
    en: 'Foundation'
  };
  const first = await build(sermon, 'proposal-key-order-first', {
    source,
    extraction: extracted
  });
  const reviewed = applySermonExtractionReview(
    sermon,
    first.internalProposal,
    {
      outlineSuggestionIds: first.internalProposal.outlineSuggestions.map(item => item.id)
    }
  );

  assert.deepEqual(Object.keys(reviewed.document.outline[0].titles), ['en', 'ru']);
  const second = await build(reviewed.document, 'proposal-key-order-second', {
    source: reviewed.document.sources[0],
    extraction: extracted
  });
  assert.deepEqual(second.internalProposal.outlineSuggestions, []);
  assert.deepEqual(second.publicProposal.outlineSuggestions, []);
});

test('RUS then ENG extraction enriches one source-independent outline and retries cleanly', async () => {
  const base = fixture();
  const ruSource = {
    ...base.sources[0],
    id: 'source-slides-ru',
    kind: 'slide-notes',
    fileName: 'sermon-ru.pptx',
    mediaType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    sha256: 'b'.repeat(64),
    languages: ['ru']
  };
  const enSource = {
    ...base.sources[0],
    id: 'source-slides-en',
    kind: 'slide-notes',
    fileName: 'sermon-en.pptx',
    mediaType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    sha256: 'c'.repeat(64),
    languages: ['en']
  };
  const sermon = normalizeSermonDocument({
    ...base,
    sources: [ruSource, enSource]
  });
  const ruExtraction = extraction(sermon.sources[0]);
  ruExtraction.outlineSuggestions = [{
    ...ruExtraction.outlineSuggestions[0],
    titles: { ru: 'Основание' },
    rawText: 'I. Основание'
  }];
  ruExtraction.scriptureReferenceSuggestions = [];

  const ruBuilt = await build(sermon, 'proposal-rus', {
    source: sermon.sources[0],
    extraction: ruExtraction
  });
  const canonicalOutlineId =
    ruBuilt.internalProposal.outlineSuggestions[0].canonical.id;
  const afterRu = applySermonExtractionReview(
    sermon,
    ruBuilt.internalProposal,
    { outlineSuggestionIds: ['outline:outline-i'] }
  );
  assert.deepEqual(afterRu.document.outline[0].titles, { ru: 'Основание' });

  const currentEnSource = afterRu.document.sources.find(source => source.id === enSource.id);
  const enExtraction = extraction(currentEnSource);
  enExtraction.schemaVersion = 2;
  enExtraction.extractor.version = 2;
  enExtraction.outlineSuggestions = [{
    ...enExtraction.outlineSuggestions[0],
    titles: { en: 'Foundation' },
    rawText: 'I. Foundation'
  }];
  enExtraction.scriptureReferenceSuggestions = [];
  const enBuilt = await build(afterRu.document, 'proposal-eng', {
    source: currentEnSource,
    extraction: enExtraction
  });

  assert.equal(enBuilt.internalProposal.outlineSuggestions.length, 1);
  assert.equal(
    enBuilt.internalProposal.outlineSuggestions[0].canonical.id,
    canonicalOutlineId
  );
  const afterEn = applySermonExtractionReview(
    afterRu.document,
    enBuilt.internalProposal,
    { outlineSuggestionIds: ['outline:outline-i'] }
  );
  assert.equal(afterEn.document.outline.length, 1);
  assert.deepEqual(afterEn.document.outline[0].titles, {
    en: 'Foundation',
    ru: 'Основание'
  });

  const repeated = applySermonExtractionReview(
    afterEn.document,
    enBuilt.internalProposal,
    { outlineSuggestionIds: ['outline:outline-i'] }
  );
  assert.equal(repeated.changed, false);
  assert.equal(repeated.revision, afterEn.revision);
  assert.deepEqual(repeated.applied.outlineSuggestionIds, []);

  const freshEnSource = afterEn.document.sources.find(source => source.id === enSource.id);
  const freshEn = await build(afterEn.document, 'proposal-eng-fresh', {
    source: freshEnSource,
    extraction: enExtraction
  });
  assert.deepEqual(freshEn.internalProposal.outlineSuggestions, []);
  assert.deepEqual(freshEn.publicProposal.outlineSuggestions, []);

  const currentRuSource = afterEn.document.sources.find(source => source.id === ruSource.id);
  const conflictingRuExtraction = extraction(currentRuSource);
  conflictingRuExtraction.outlineSuggestions = [{
    ...conflictingRuExtraction.outlineSuggestions[0],
    titles: { ru: 'Другое основание' },
    rawText: 'I. Другое основание'
  }];
  conflictingRuExtraction.scriptureReferenceSuggestions = [];
  await assert.rejects(
    build(afterEn.document, 'proposal-rus-conflict', {
      source: currentRuSource,
      extraction: conflictingRuExtraction
    }),
    error => {
      assert.ok(error instanceof SermonExtractionProposalBuilderError);
      assert.equal(error.code, 'CANONICAL_ID_COLLISION');
      return true;
    }
  );
});
