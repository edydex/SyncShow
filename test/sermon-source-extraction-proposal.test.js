'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  MAX_EXTRACTION_UNITS,
  MAX_OUTLINE_SUGGESTIONS,
  MAX_REFERENCE_SUGGESTIONS,
  MAX_TEXT_PREVIEW_CHARS
} = require('../src/services/sermon/SermonSourceExtraction');
const {
  SermonSourceExtractionProposalError,
  normalizeSermonSourceExtractionProposal
} = require('../src/services/sermon/SermonSourceExtractionProposal');
const {
  SERMON_KIND,
  SERMON_SCHEMA_VERSION,
  buildSermonExtractionReviewProposal,
  normalizeSermonDocument,
  sermonDocumentSha256
} = require('../src/services/sermon');

function range(bookId, chapter, verseStart, verseEnd = verseStart) {
  return {
    schemaVersion: 1,
    bookId,
    start: { chapter, verse: verseStart },
    end: { chapter, verse: verseEnd }
  };
}

function source() {
  return {
    id: 'source-manuscript',
    kind: 'manuscript',
    fileName: 'sermon.txt',
    mediaType: 'text/plain',
    sha256: 'a'.repeat(64),
    sizeBytes: 1024,
    languages: ['en'],
    provenance: {
      providedBy: 'Pastor Example',
      receivedAt: '2026-07-26T18:00:00.000Z',
      sourceSystem: 'manual-file-picker',
      externalId: ''
    }
  };
}

function sermon() {
  return normalizeSermonDocument({
    schemaVersion: SERMON_SCHEMA_VERSION,
    kind: SERMON_KIND,
    id: 'sermon-extraction-boundary',
    titles: { en: 'Extraction boundary' },
    defaultLanguage: 'en',
    speaker: { id: null, name: 'Pastor Example' },
    serviceDate: '2026-07-26',
    series: null,
    outline: [],
    sources: [source()],
    references: [],
    media: [],
    publication: {
      status: 'draft',
      visibility: 'private',
      publishedAt: null,
      canonicalUrl: null
    }
  });
}

function extraction() {
  const text = 'I. Foundation\nRomans 5:5-8';
  const referenceStart = text.indexOf('Romans');
  return {
    schemaVersion: 1,
    kind: 'syncshow-sermon-source-extraction-proposal',
    extractor: {
      id: 'syncshow-deterministic-source-extractor',
      version: 1
    },
    source: {
      id: 'source-manuscript',
      sha256: 'a'.repeat(64),
      kind: 'manuscript',
      languages: ['en'],
      mediaType: 'text/plain'
    },
    units: [{
      id: 'document-1',
      kind: 'document',
      ordinal: 1,
      label: 'Document section 1',
      text,
      truncated: false
    }],
    textPreview: text,
    suggestionScope: {
      strategy: 'whole-source',
      startUnitId: 'document-1',
      endUnitId: 'document-1',
      startOrdinal: 1,
      endOrdinal: 1
    },
    outlineSuggestions: [{
      id: 'outline-i',
      level: 1,
      marker: 'I',
      parentId: null,
      parentSuggestionId: null,
      suggestedKind: 'section',
      titles: { en: 'Foundation' },
      rawText: 'I. Foundation',
      sourceUnitIds: ['document-1'],
      sourceUnitIdsTruncated: false,
      occurrenceCount: 1
    }],
    scriptureReferenceSuggestions: [{
      id: 'reference-romans-5-5-8',
      rawText: 'Romans 5:5-8',
      language: 'en',
      bookHint: 'Rom',
      unitId: 'document-1',
      startOffset: referenceStart,
      endOffset: referenceStart + 'Romans 5:5-8'.length,
      sourceUnitIds: ['document-1'],
      sourceUnitIdsTruncated: false,
      occurrenceCount: 1
    }],
    truncated: {
      units: false,
      text: false,
      preview: false,
      outlineSuggestions: false,
      scriptureReferences: false
    }
  };
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function styledExtraction() {
  const proposal = extraction();
  proposal.schemaVersion = 2;
  proposal.extractor.version = 2;
  proposal.source.kind = 'slide-notes';
  proposal.source.mediaType =
    'application/vnd.openxmlformats-officedocument.presentationml.presentation';
  proposal.units[0].kind = 'slide';
  const start = proposal.units[0].text.indexOf('Romans');
  proposal.units[0].spans = [{
    start,
    end: start + 'Romans 5:5-8'.length,
    foreground: '#ffc000',
    weight: '700'
  }];
  return proposal;
}

function expectProposalError(code) {
  return error => {
    assert.ok(error instanceof SermonSourceExtractionProposalError);
    assert.equal(error.code, code);
    return true;
  };
}

test('strict source extraction normalization returns an exact deeply frozen proposal', () => {
  const normalized = normalizeSermonSourceExtractionProposal(extraction());

  assert.deepEqual(normalized, extraction());
  assert.equal(Object.isFrozen(normalized), true);
  assert.equal(Object.isFrozen(normalized.units[0]), true);
  assert.equal(Object.isFrozen(normalized.outlineSuggestions[0].titles), true);
  assert.equal(Object.isFrozen(normalized.scriptureReferenceSuggestions[0]), true);
});

test('normalization preserves v1 exactly and accepts bounded v2 PowerPoint spans', () => {
  const legacy = extraction();
  assert.deepEqual(normalizeSermonSourceExtractionProposal(legacy), legacy);

  const styled = styledExtraction();
  const normalized = normalizeSermonSourceExtractionProposal(styled);
  assert.deepEqual(normalized, styled);
  assert.equal(Object.isFrozen(normalized.units[0].spans), true);

  const legacyWithSpans = extraction();
  legacyWithSpans.units[0].spans = clone(styled.units[0].spans);
  assert.throws(
    () => normalizeSermonSourceExtractionProposal(legacyWithSpans),
    expectProposalError('INVALID_EXTRACTION_PROPOSAL')
  );
});

test('v2 PowerPoint spans fail closed on tampered style, order, and UTF-16 offsets', () => {
  const mutations = [
    proposal => { proposal.units[0].spans[0].foreground = '#ffffff'; },
    proposal => { proposal.units[0].spans[0].weight = '500'; },
    proposal => { proposal.units[0].spans[0].html = '<strong>'; },
    proposal => {
      proposal.units[0].text = `😀${proposal.units[0].text}`;
      proposal.units[0].spans[0].start = 1;
      proposal.units[0].spans[0].end += 2;
    },
    proposal => {
      const span = proposal.units[0].spans[0];
      proposal.units[0].spans = [
        { ...span, start: 0, end: 3 },
        { ...span, start: 2, end: 4 }
      ];
    }
  ];
  for (const mutate of mutations) {
    const proposal = styledExtraction();
    mutate(proposal);
    assert.throws(
      () => normalizeSermonSourceExtractionProposal(proposal),
      expectProposalError('INVALID_EXTRACTION_PROPOSAL')
    );
  }
});

test('strict source extraction normalization rejects path-like and unknown fields', () => {
  const candidates = [
    proposal => { proposal.localPath = '/private/sermon.txt'; },
    proposal => { proposal.source.filePath = '/private/sermon.txt'; },
    proposal => { proposal.units[0].path = '/private/sermon.txt'; },
    proposal => { proposal.outlineSuggestions[0].bytes = [1, 2, 3]; },
    proposal => { proposal.scriptureReferenceSuggestions[0].range = range('Rom', 5, 5, 8); }
  ];

  for (const mutate of candidates) {
    const proposal = extraction();
    mutate(proposal);
    assert.throws(
      () => normalizeSermonSourceExtractionProposal(proposal),
      expectProposalError('INVALID_EXTRACTION_PROPOSAL')
    );
  }
});

test('strict source extraction normalization enforces every collection and text bound', () => {
  const preview = extraction();
  preview.textPreview = 'x'.repeat(MAX_TEXT_PREVIEW_CHARS + 1);
  assert.throws(
    () => normalizeSermonSourceExtractionProposal(preview),
    expectProposalError('EXTRACTION_PROPOSAL_TOO_LARGE')
  );

  const units = extraction();
  units.units = Array.from({ length: MAX_EXTRACTION_UNITS + 1 }, (_, index) => ({
    ...clone(units.units[0]),
    id: `document-${index + 1}`,
    ordinal: index + 1
  }));
  assert.throws(
    () => normalizeSermonSourceExtractionProposal(units),
    expectProposalError('EXTRACTION_PROPOSAL_TOO_LARGE')
  );

  const outlines = extraction();
  outlines.outlineSuggestions = Array.from(
    { length: MAX_OUTLINE_SUGGESTIONS + 1 },
    (_, index) => ({
      ...clone(outlines.outlineSuggestions[0]),
      id: `outline-${index + 1}`
    })
  );
  assert.throws(
    () => normalizeSermonSourceExtractionProposal(outlines),
    expectProposalError('EXTRACTION_PROPOSAL_TOO_LARGE')
  );

  const references = extraction();
  references.scriptureReferenceSuggestions = Array.from(
    { length: MAX_REFERENCE_SUGGESTIONS + 1 },
    (_, index) => ({
      ...clone(references.scriptureReferenceSuggestions[0]),
      id: `reference-${index + 1}`
    })
  );
  assert.throws(
    () => normalizeSermonSourceExtractionProposal(references),
    expectProposalError('EXTRACTION_PROPOSAL_TOO_LARGE')
  );
});

test('strict source extraction normalization keeps suggestions inside the declared safe scope', () => {
  const partialWholeSource = extraction();
  partialWholeSource.units.push({
    id: 'document-2',
    kind: 'document',
    ordinal: 2,
    label: 'Document section 2',
    text: 'Appendix',
    truncated: false
  });
  assert.throws(
    () => normalizeSermonSourceExtractionProposal(partialWholeSource),
    expectProposalError('INVALID_EXTRACTION_PROPOSAL')
  );

  const outsideWindow = extraction();
  outsideWindow.units.push({
    id: 'document-2',
    kind: 'document',
    ordinal: 2,
    label: 'Document section 2',
    text: 'I. Safe sermon window',
    truncated: false
  });
  outsideWindow.suggestionScope = {
    strategy: 'pptx-roman-outline-window',
    startUnitId: 'document-2',
    endUnitId: 'document-2',
    startOrdinal: 2,
    endOrdinal: 2
  };
  assert.throws(
    () => normalizeSermonSourceExtractionProposal(outsideWindow),
    expectProposalError('INVALID_EXTRACTION_PROPOSAL')
  );

  const noWindow = extraction();
  noWindow.suggestionScope = {
    strategy: 'pptx-no-sermon-window',
    startUnitId: null,
    endUnitId: null,
    startOrdinal: null,
    endOrdinal: null
  };
  assert.throws(
    () => normalizeSermonSourceExtractionProposal(noWindow),
    expectProposalError('INVALID_EXTRACTION_PROPOSAL')
  );
});

test('proposal builder rejects hostile extraction before any trusted Bible lookup', async () => {
  const document = sermon();
  const hostile = extraction();
  hostile.scriptureReferenceSuggestions = Array.from(
    { length: MAX_REFERENCE_SUGGESTIONS + 1 },
    (_, index) => ({
      ...clone(hostile.scriptureReferenceSuggestions[0]),
      id: `reference-${index + 1}`
    })
  );
  let resolverCalls = 0;

  await assert.rejects(
    buildSermonExtractionReviewProposal({
      sermon: document,
      sermonRevision: sermonDocumentSha256(document),
      source: document.sources[0],
      extraction: hostile,
      proposalId: 'proposal-hostile-boundary',
      async resolveReference() {
        resolverCalls += 1;
        return range('Rom', 5, 5, 8);
      }
    }),
    error => {
      assert.equal(error.code, 'EXTRACTION_PROPOSAL_TOO_LARGE');
      return true;
    }
  );
  assert.equal(resolverCalls, 0);
});
