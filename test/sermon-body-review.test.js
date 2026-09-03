'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  SERMON_BODY_REVIEW_PROPOSAL_KIND,
  SERMON_BODY_REVIEW_PROPOSAL_SCHEMA_VERSION,
  SERMON_KIND,
  SermonBodyReviewError,
  applySermonBodyReview,
  buildSermonBodyReviewProposal,
  normalizeSermonBodyReviewProposal,
  normalizeSermonDocument,
  sermonDocumentSha256
} = require('../src/services/sermon');

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function range(bookId, chapter, verseStart, verseEnd = verseStart) {
  return {
    schemaVersion: 1,
    bookId,
    start: { chapter, verse: verseStart },
    end: { chapter, verse: verseEnd }
  };
}

function sermon(overrides = {}) {
  return normalizeSermonDocument({
    schemaVersion: 2,
    kind: SERMON_KIND,
    id: 'sermon-body-review',
    titles: { en: 'Reviewed sermon body' },
    defaultLanguage: 'en',
    speaker: { id: null, name: 'Pastor Example' },
    serviceDate: '2026-07-26',
    series: null,
    outline: [{
      id: 'introduction',
      parentId: null,
      kind: 'section',
      titles: { en: 'Introduction' }
    }],
    sources: [{
      id: 'pastor-manuscript',
      kind: 'manuscript',
      fileName: 'sermon.pdf',
      mediaType: 'application/pdf',
      languages: ['en', 'ru'],
      sha256: 'a'.repeat(64),
      sizeBytes: 4096,
      provenance: {
        providedBy: 'Pastor Example',
        receivedAt: '2026-07-25T18:00:00.000Z',
        sourceSystem: 'manual-file-picker',
        externalId: ''
      }
    }],
    references: [{
      id: 'primary-romans',
      range: range('Rom', 5, 1, 5),
      role: 'primary',
      source: 'pastor',
      reviewStatus: 'confirmed',
      enteredText: 'Romans 5:1-5',
      sourceId: 'pastor-manuscript',
      sectionId: null,
      startOffset: null,
      endOffset: null
    }],
    media: [],
    publication: {
      status: 'published',
      visibility: 'members',
      publishedAt: '2026-07-26T20:00:00.000Z',
      canonicalUrl: 'https://church.example/sermons/reviewed-body'
    },
    ...overrides
  });
}

function extraction(overrides = {}) {
  return {
    schemaVersion: 1,
    kind: 'syncshow-sermon-source-extraction-proposal',
    extractor: {
      id: 'syncshow-deterministic-source-extractor',
      version: 1
    },
    source: {
      id: 'pastor-manuscript',
      sha256: 'a'.repeat(64),
      kind: 'manuscript',
      languages: ['en', 'ru'],
      mediaType: 'application/pdf'
    },
    units: [{
      id: 'pdf-page-1',
      kind: 'page',
      ordinal: 1,
      label: 'Page 1',
      text: 'Full page one\r\nnot merely the preview.',
      truncated: false
    }, {
      id: 'pdf-page-2',
      kind: 'page',
      ordinal: 2,
      label: 'Page 2',
      text: 'Полный текст второй страницы.',
      truncated: false
    }],
    textPreview: 'Short preview only',
    suggestionScope: {
      strategy: 'whole-source',
      startUnitId: 'pdf-page-1',
      endUnitId: 'pdf-page-2',
      startOrdinal: 1,
      endOrdinal: 2
    },
    outlineSuggestions: [],
    scriptureReferenceSuggestions: [],
    truncated: {
      units: false,
      text: false,
      preview: true,
      outlineSuggestions: true,
      scriptureReferences: true
    },
    ...overrides
  };
}

function build(document = sermon(), extractionOverride = extraction()) {
  return buildSermonBodyReviewProposal({
    sermon: document,
    baseSermonRevisionId: sermonDocumentSha256(document),
    sourceId: 'pastor-manuscript',
    snapshotHash: 'b'.repeat(64),
    extraction: extractionOverride
  });
}

function expectReviewCode(code, callback) {
  assert.throws(callback, error => {
    assert.ok(error instanceof SermonBodyReviewError);
    assert.equal(error.code, code);
    return true;
  });
}

test('sermon API exports the pure reviewed-body contract', () => {
  const api = require('../src/services/sermon');
  assert.equal(typeof api.buildSermonBodyReviewProposal, 'function');
  assert.equal(typeof api.applySermonBodyReview, 'function');
  assert.equal(typeof api.normalizeSermonBodyReviewProposal, 'function');
  assert.equal(api.SERMON_BODY_REVIEW_PROPOSAL_SCHEMA_VERSION, 1);
  assert.equal(api.SERMON_BODY_REVIEW_PROPOSAL_KIND, 'syncshow-sermon-body-review-proposal');
});

test('body proposal is exact-bound and uses all ordered unit text rather than preview text', () => {
  const current = sermon();
  const proposal = build(current);

  assert.equal(proposal.schemaVersion, SERMON_BODY_REVIEW_PROPOSAL_SCHEMA_VERSION);
  assert.equal(proposal.kind, SERMON_BODY_REVIEW_PROPOSAL_KIND);
  assert.equal(proposal.sermonId, current.id);
  assert.equal(proposal.baseSermonRevisionId, sermonDocumentSha256(current));
  assert.equal(proposal.sourceId, 'pastor-manuscript');
  assert.equal(proposal.sourceRevision, 'a'.repeat(64));
  assert.equal(proposal.sourceKind, 'manuscript');
  assert.equal(proposal.snapshotHash, 'b'.repeat(64));
  assert.equal(proposal.entries[0].language, 'mul');
  assert.equal(
    proposal.entries[0].text,
    'Full page one\nnot merely the preview.\n\nПолный текст второй страницы.'
  );
  assert.doesNotMatch(proposal.entries[0].text, /Short preview only/);
  assert.ok(Object.isFrozen(proposal));
  assert.ok(Object.isFrozen(proposal.entries[0]));
  assert.deepEqual(normalizeSermonBodyReviewProposal(proposal, current), proposal);
});

test('preview and suggestion truncation remain reviewable but any full-text truncation is blocked', () => {
  assert.doesNotThrow(() => build(sermon(), extraction()));

  for (const mutate of [
    value => { value.truncated.units = true; },
    value => { value.truncated.text = true; },
    value => { value.units[1].truncated = true; }
  ]) {
    const incomplete = extraction();
    mutate(incomplete);
    expectReviewCode('INCOMPLETE_EXTRACTION', () => build(sermon(), incomplete));
  }

  const empty = extraction({
    units: [],
    textPreview: '',
    suggestionScope: {
      strategy: 'whole-source',
      startUnitId: null,
      endUnitId: null,
      startOrdinal: null,
      endOrdinal: null
    }
  });
  expectReviewCode('EMPTY_EXTRACTION', () => build(sermon(), empty));
});

test('automatic body draft accepts only whole manuscripts or transcripts', () => {
  const partial = extraction({
    suggestionScope: {
      strategy: 'pptx-roman-outline-window',
      startUnitId: 'pdf-page-1',
      endUnitId: 'pdf-page-2',
      startOrdinal: 1,
      endOrdinal: 2
    }
  });
  expectReviewCode('PARTIAL_EXTRACTION_SCOPE', () => build(sermon(), partial));

  const current = sermon({
    sources: [{
      ...sermon().sources[0],
      kind: 'slide-notes',
      fileName: 'service.pptx',
      mediaType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation'
    }]
  });
  const deckExtraction = extraction();
  deckExtraction.source.kind = 'slide-notes';
  deckExtraction.source.mediaType =
    'application/vnd.openxmlformats-officedocument.presentationml.presentation';
  expectReviewCode('UNSUPPORTED_BODY_SOURCE_KIND', () => build(current, deckExtraction));
});

test('applying reviewed body upgrades to v3 and reopens published material without changing audience or URL', () => {
  const current = sermon();
  const proposal = build(current);
  const result = applySermonBodyReview(current, proposal);

  assert.equal(result.changed, true);
  assert.equal(result.previousRevision, sermonDocumentSha256(current));
  assert.equal(result.document.schemaVersion, 3);
  assert.deepEqual(result.bodyEntryIds, ['pastor-manuscript']);
  assert.deepEqual(result.document.body, proposal.entries);
  assert.equal(result.document.publication.status, 'draft');
  assert.equal(result.document.publication.publishedAt, null);
  assert.equal(result.document.publication.visibility, 'members');
  assert.equal(
    result.document.publication.canonicalUrl,
    'https://church.example/sermons/reviewed-body'
  );
  assert.equal(result.binding.snapshotHash, 'b'.repeat(64));

  const retry = applySermonBodyReview(result.document, proposal);
  assert.equal(retry.changed, false);
  assert.equal(retry.revision, result.revision);
  assert.deepEqual(retry.document, result.document);
});

test('default proposal replaces the reviewed source in place without wiping unrelated v3 body', () => {
  const v2 = sermon({
    publication: {
      status: 'draft',
      visibility: 'private',
      publishedAt: null,
      canonicalUrl: null
    }
  });
  const transcriptSource = {
    ...v2.sources[0],
    id: 'existing-transcript',
    kind: 'transcript',
    fileName: 'existing-transcript.txt',
    mediaType: 'text/plain',
    languages: ['ru'],
    sha256: 'c'.repeat(64)
  };
  const current = normalizeSermonDocument({
    ...v2,
    schemaVersion: 3,
    sources: [...v2.sources, transcriptSource],
    body: [{
      id: 'unrelated-russian-body',
      kind: 'transcript',
      language: 'ru',
      sourceId: 'existing-transcript',
      sectionId: null,
      text: 'Существующий проверенный текст.'
    }, {
      id: 'stable-manuscript-body',
      kind: 'manuscript',
      language: 'en',
      sourceId: 'pastor-manuscript',
      sectionId: 'introduction',
      text: 'Older reviewed manuscript.'
    }]
  });

  const proposal = build(current);
  assert.deepEqual(
    proposal.entries.map(entry => entry.id),
    ['unrelated-russian-body', 'stable-manuscript-body']
  );
  assert.equal(proposal.entries[0].text, 'Существующий проверенный текст.');
  assert.equal(proposal.entries[1].sectionId, 'introduction');
  assert.match(proposal.entries[1].text, /Full page one/);

  const result = applySermonBodyReview(current, proposal);
  assert.equal(result.document.body[0].text, 'Существующий проверенный текст.');
  assert.equal(result.document.body[1].id, 'stable-manuscript-body');
});

test('automatic proposal chooses a deterministic free entry id when the source id is already used', () => {
  const v2 = sermon({
    publication: {
      status: 'draft',
      visibility: 'private',
      publishedAt: null,
      canonicalUrl: null
    }
  });
  const current = normalizeSermonDocument({
    ...v2,
    schemaVersion: 3,
    body: [{
      id: 'pastor-manuscript',
      kind: 'other',
      language: 'en',
      sourceId: null,
      sectionId: null,
      text: 'An unrelated reviewed note already owns the source-shaped id.'
    }]
  });

  const proposal = build(current);
  assert.deepEqual(
    proposal.entries.map(entry => entry.id),
    ['pastor-manuscript', 'pastor-manuscript:body']
  );
  assert.deepEqual(build(current), proposal);
  const result = applySermonBodyReview(current, proposal);
  assert.equal(result.document.body[0].text, current.body[0].text);
  assert.match(result.document.body[1].text, /Full page one/);
});

test('operator edits are canonicalized, ordered, source-safe, and section-validated', () => {
  const current = sermon({
    publication: {
      status: 'ready',
      visibility: 'unlisted',
      publishedAt: null,
      canonicalUrl: 'https://church.example/review'
    }
  });
  const proposal = build(current);
  const edits = {
    entries: [{
      id: 'opening',
      kind: 'manuscript',
      language: 'EN',
      sourceId: 'pastor-manuscript',
      sectionId: 'introduction',
      text: 'Cafe\u0301\r\nReviewed opening'
    }, {
      id: 'application',
      kind: 'other',
      language: 'mul',
      sourceId: null,
      sectionId: null,
      text: 'Apply this text.'
    }]
  };
  const result = applySermonBodyReview(current, proposal, edits);

  assert.deepEqual(result.document.body.map(entry => entry.id), ['opening', 'application']);
  assert.equal(result.document.body[0].language, 'en');
  assert.equal(result.document.body[0].text, 'Café\nReviewed opening');
  assert.equal(result.document.publication.status, 'draft');
  assert.equal(result.document.publication.visibility, 'unlisted');
  assert.equal(result.document.publication.canonicalUrl, 'https://church.example/review');

  const retry = applySermonBodyReview(result.document, proposal, edits);
  assert.equal(retry.changed, false);

  expectReviewCode('UNKNOWN_OUTLINE_SECTION', () => applySermonBodyReview(
    current,
    proposal,
    {
      entries: [{ ...edits.entries[0], sectionId: 'missing-section' }]
    }
  ));
  expectReviewCode('BODY_SOURCE_KIND_MISMATCH', () => applySermonBodyReview(
    normalizeSermonDocument({
      ...current,
      sources: [
        ...current.sources,
        {
          ...current.sources[0],
          id: 'other-source',
          sha256: 'c'.repeat(64)
        }
      ]
    }),
    proposal,
    {
      entries: [{ ...edits.entries[0], kind: 'other', sourceId: 'other-source' }]
    }
  ));
});

test('body review rejects stale or malformed bindings while allowing only exact no-op retry', () => {
  const current = sermon();
  const proposal = build(current);

  const changedTitle = normalizeSermonDocument({
    ...current,
    titles: { en: 'Changed after extraction' }
  });
  expectReviewCode(
    'SERMON_REVISION_MISMATCH',
    () => applySermonBodyReview(changedTitle, proposal)
  );

  for (const mutate of [
    value => { value.sermonId = 'another-sermon'; },
    value => { value.sourceRevision = 'c'.repeat(64); },
    value => { value.snapshotHash = 'B'.repeat(64); },
    value => { value.filePath = '/private/sermon.pdf'; },
    value => { value.entries[0].reviewStatus = 'confirmed'; }
  ]) {
    const malformed = clone(proposal);
    mutate(malformed);
    assert.throws(
      () => normalizeSermonBodyReviewProposal(malformed, current),
      error => error instanceof SermonBodyReviewError
    );
  }

  const mismatchedExtraction = extraction();
  mismatchedExtraction.source.sha256 = 'c'.repeat(64);
  expectReviewCode('SOURCE_MISMATCH', () => build(current, mismatchedExtraction));
  expectReviewCode('INVALID_BODY_REVIEW_BINDING', () => buildSermonBodyReviewProposal({
    sermon: current,
    baseSermonRevisionId: sermonDocumentSha256(current),
    sourceId: 'pastor-manuscript',
    snapshotHash: 'B'.repeat(64),
    extraction: extraction()
  }));
});

test('archived sermons cannot begin or apply body review', () => {
  const current = sermon({
    publication: {
      status: 'draft',
      visibility: 'private',
      publishedAt: null,
      canonicalUrl: null
    }
  });
  const proposal = build(current);
  const archived = normalizeSermonDocument({
    ...current,
    publication: {
      ...current.publication,
      status: 'archived'
    }
  });

  expectReviewCode('ARCHIVED_SERMON', () => build(archived));
  expectReviewCode('ARCHIVED_SERMON', () => applySermonBodyReview(archived, proposal));
});
