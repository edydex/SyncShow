'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  SERMON_SCHEMA_VERSION,
  SermonPostServiceLinksError,
  analyzeSermonPostServiceReadiness,
  buildSermonPublicationTransition,
  planSermonPostServiceLinks,
  sermonDocumentSha256,
  serializeSermonDocument,
  stablePublicHttpsLocation,
  strictHttpsUrl
} = require('../src/services/project');
const {
  buildSermonCreateBody
} = require('../src/services/community');

function sermon(overrides = {}) {
  return {
    schemaVersion: SERMON_SCHEMA_VERSION,
    kind: 'syncshow-sermon',
    id: 'sermon-post-service',
    titles: { en: 'Post-service sermon' },
    defaultLanguage: 'en',
    speaker: { id: null, name: 'Pastor' },
    serviceDate: '2026-07-27',
    series: null,
    outline: [],
    sources: [],
    references: [{
      id: 'primary',
      range: {
        schemaVersion: 1,
        bookId: 'Eph',
        start: { chapter: 3, verse: 14 },
        end: { chapter: 3, verse: 21 }
      },
      role: 'primary',
      source: 'operator',
      reviewStatus: 'confirmed',
      enteredText: 'Ephesians 3:14-21',
      sourceId: null,
      sectionId: null,
      startOffset: null,
      endOffset: null
    }],
    media: [],
    body: [],
    publication: {
      status: 'draft',
      visibility: 'members',
      publishedAt: null,
      canonicalUrl: null
    },
    ...overrides
  };
}

test('reviewed post-service links normalize deterministically and preserve unrelated media', () => {
  const unrelated = {
    id: 'existing-upload',
    kind: 'audio',
    status: 'processing',
    title: 'Preserved upload',
    language: 'en',
    mediaType: 'audio/wav',
    fileName: 'sermon.wav',
    sha256: 'a'.repeat(64),
    sizeBytes: 1234,
    durationSeconds: 12.5,
    url: null
  };
  const current = sermon({ media: [unrelated] });
  const review = {
    action: 'mark-ready',
    canonicalUrl: ' HTTPS://Church.Example:443/sermons/hope?view=full ',
    recording: {
      kind: 'video',
      status: 'ready',
      url: 'https://video.example.org/watch/sermon.mp4'
    },
    text: {
      kind: 'transcript',
      status: 'pending',
      url: 'https://church.example.org/sermons/hope/transcript'
    }
  };
  const first = planSermonPostServiceLinks(current, review);
  const second = planSermonPostServiceLinks(first.document, review);

  assert.equal(
    first.document.publication.canonicalUrl,
    'https://church.example/sermons/hope?view=full'
  );
  assert.deepEqual(first.document.publication, {
    status: 'ready',
    visibility: 'members',
    publishedAt: null,
    canonicalUrl: 'https://church.example/sermons/hope?view=full'
  });
  assert.deepEqual(first.document.media[0], unrelated);
  assert.deepEqual(first.document.media.slice(1).map(media => ({
    id: media.id,
    kind: media.kind,
    status: media.status,
    title: media.title,
    language: media.language,
    url: media.url
  })), [
    {
      id: 'post-service:recording:en',
      kind: 'video',
      status: 'ready',
      title: 'Sermon video',
      language: 'en',
      url: 'https://video.example.org/watch/sermon.mp4'
    },
    {
      id: 'post-service:text:en',
      kind: 'transcript',
      status: 'pending',
      title: 'Sermon transcript',
      language: 'en',
      url: 'https://church.example.org/sermons/hope/transcript'
    }
  ]);
  assert.equal(first.readiness.ready, true);
  assert.equal(first.readiness.recordingReady, true);
  assert.equal(first.readiness.reviewedBodyReady, false);
  assert.equal(first.readiness.pageReady, true);
  assert.equal(first.readiness.textReady, false);
  assert.equal(first.readiness.revisitContentReady, true);
  assert.equal(
    sermonDocumentSha256(second.document),
    sermonDocumentSha256(first.document),
    'saving an identical review is content-addressed as the same revision'
  );
});

test('blank Waiting slots create no media and draft saves never claim publication', () => {
  const result = planSermonPostServiceLinks(sermon({
    publication: {
      status: 'ready',
      visibility: 'public',
      publishedAt: null,
      canonicalUrl: 'https://old.example/sermon'
    }
  }), {
    action: 'save-draft',
    canonicalUrl: '',
    recording: { kind: 'audio', status: 'pending', url: '   ' },
    text: { kind: 'document', status: 'pending', url: '' }
  });

  assert.deepEqual(result.document.media, []);
  assert.deepEqual(result.document.publication, {
    status: 'draft',
    visibility: 'public',
    publishedAt: null,
    canonicalUrl: null
  });
  assert.equal(result.readiness.ready, false);
  assert.deepEqual(
    result.readiness.missing,
    ['available-recording', 'reviewed-body-sermon-page-or-available-text']
  );
});

test('marking ready requires reviewed Scripture, an available recording, and revisit content', () => {
  const missingRecording = {
    action: 'mark-ready',
    canonicalUrl: 'https://church.example/sermon',
    recording: null,
    text: null
  };
  assert.throws(
    () => planSermonPostServiceLinks(sermon(), missingRecording),
    error => error instanceof SermonPostServiceLinksError
      && error.code === 'POST_SERVICE_NOT_READY'
      && error.details.missing.includes('available-recording')
  );

  const textInsteadOfPage = planSermonPostServiceLinks(sermon(), {
    action: 'mark-ready',
    canonicalUrl: null,
    recording: {
      kind: 'audio',
      status: 'ready',
      url: 'https://media.example.org/sermon.mp3'
    },
    text: {
      kind: 'document',
      status: 'ready',
      url: 'https://church.example.org/sermon-notes.pdf'
    }
  });
  assert.equal(textInsteadOfPage.readiness.ready, true);
  assert.equal(textInsteadOfPage.document.publication.status, 'ready');
  assert.equal(textInsteadOfPage.document.publication.publishedAt, null);
  assert.equal(textInsteadOfPage.readiness.revisitContentReady, true);

  const suggested = sermon({
    references: sermon().references.map(reference => ({
      ...reference,
      reviewStatus: 'suggested'
    }))
  });
  assert.equal(analyzeSermonPostServiceReadiness(suggested).requirements.confirmedPrimary, false);
  assert.throws(
    () => planSermonPostServiceLinks(suggested, {
      action: 'mark-ready',
      canonicalUrl: 'https://church.example/sermon',
      recording: {
        kind: 'audio',
        status: 'ready',
        url: 'https://media.example.org/sermon.mp3'
      },
      text: null
    }),
    error => error.code === 'MISSING_CONFIRMED_PRIMARY_REFERENCE'
      || error.code === 'POST_SERVICE_NOT_READY'
  );
});

test('reviewed canonical body crosses Ready, Community wire, and the server-compatible publication transition without external text links', () => {
  const bodyEntry = {
    id: 'reviewed-manuscript-en',
    kind: 'manuscript',
    language: 'en',
    sourceId: null,
    sectionId: null,
    text: 'The complete sermon text reviewed by an operator.'
  };
  const ready = planSermonPostServiceLinks(sermon({
    body: [bodyEntry]
  }), {
    action: 'mark-ready',
    canonicalUrl: null,
    recording: {
      kind: 'audio',
      status: 'ready',
      url: 'https://media.example.org/sermon.mp3'
    },
    text: null
  });

  assert.equal(ready.document.publication.status, 'ready');
  assert.equal(ready.document.publication.canonicalUrl, null);
  assert.equal(ready.readiness.reviewedBodyReady, true);
  assert.equal(ready.readiness.pageReady, false);
  assert.equal(ready.readiness.textReady, false);
  assert.equal(ready.readiness.recordingReady, true);
  assert.equal(ready.readiness.revisitContentReady, true);
  assert.deepEqual(ready.readiness.missing, []);

  const readySource = serializeSermonDocument(ready.document);
  const wireBody = buildSermonCreateBody({
    syncId: ready.document.id,
    documentSource: readySource
  });
  assert.equal(wireBody.documentSource, readySource);
  assert.deepEqual(JSON.parse(wireBody.documentSource).body, [bodyEntry]);

  const publication = buildSermonPublicationTransition({
    documentSource: wireBody.documentSource,
    publishedAt: '2026-07-27T20:15:30.123Z',
    selectedBodyEntryIds: [bodyEntry.id],
    selectedMediaIds: ['post-service:recording:en']
  });
  assert.deepEqual(publication.projection.detail.body, [{
    kind: bodyEntry.kind,
    language: bodyEntry.language,
    text: bodyEntry.text
  }]);
  assert.deepEqual(publication.projection.detail.media, [{
    kind: 'audio',
    title: 'Sermon audio',
    language: 'en',
    mediaType: '',
    durationSeconds: null,
    url: 'https://media.example.org/sermon.mp3'
  }]);
  assert.equal(publication.projection.detail.canonicalUrl, null);
});

test('an attached manuscript without reviewed canonical body is not revisit content', () => {
  const attachedOnly = sermon({
    sources: [{
      id: 'pastor-manuscript',
      kind: 'manuscript',
      fileName: 'sermon.docx',
      mediaType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      languages: ['en'],
      sha256: 'a'.repeat(64),
      sizeBytes: 1024,
      provenance: null
    }]
  });
  const readiness = analyzeSermonPostServiceReadiness({
    ...attachedOnly,
    media: [{
      id: 'post-service:recording:en',
      kind: 'audio',
      status: 'ready',
      title: 'Sermon audio',
      language: 'en',
      mediaType: '',
      fileName: null,
      sha256: null,
      sizeBytes: null,
      durationSeconds: null,
      url: 'https://media.example.org/sermon.mp3'
    }]
  });

  assert.equal(readiness.reviewedBodyReady, false);
  assert.equal(readiness.revisitContentReady, false);
  assert.deepEqual(
    readiness.missing,
    ['reviewed-body-sermon-page-or-available-text']
  );
});

test('new post-service links require durable HTTPS without credentials, fragments, or hidden controls', () => {
  const invalid = [
    'http://church.example/sermon',
    'ftp://church.example/sermon',
    '/sermon',
    'https://user:secret@church.example/sermon',
    'https://church.example/sermon#recording',
    'https://church.example\\sermon',
    `https://church.example/${'x'.repeat(2050)}`
  ];
  for (const value of invalid) {
    assert.throws(
      () => strictHttpsUrl(value, 'Reviewed link', { required: true }),
      error => error instanceof SermonPostServiceLinksError
        && !error.message.includes(value)
    );
  }
  assert.equal(
    strictHttpsUrl('https://www.youtube.com/watch?v=abc&list=xyz', 'Recording'),
    'https://www.youtube.com/watch?v=abc&list=xyz'
  );
  assert.equal(
    stablePublicHttpsLocation('https://media.example.org/sermons/sermon.mp3', {
      requireFilePath: true
    }),
    true
  );
  for (const value of [
    'https://media.example.org/sermons/sermon.mp3?token=temporary',
    'https://media.example.org:8443/sermons/sermon.mp3',
    'https://127.0.0.1/sermons/sermon.mp3',
    'https://media.local/sermons/sermon.mp3',
    'https://media.example.org/'
  ]) {
    assert.equal(
      stablePublicHttpsLocation(value, { requireFilePath: true }),
      false,
      value
    );
  }
  const temporaryDraft = planSermonPostServiceLinks(sermon(), {
    action: 'save-draft',
    canonicalUrl: 'https://church.example/sermon',
    recording: {
      kind: 'audio',
      status: 'ready',
      url: 'https://media.example/sermon.mp3?token=temporary'
    },
    text: null
  });
  assert.equal(temporaryDraft.document.publication.status, 'draft');
  assert.equal(temporaryDraft.readiness.recordingReady, false);
  assert.equal(temporaryDraft.readiness.ready, false);
  assert.throws(
    () => planSermonPostServiceLinks(sermon(), {
      action: 'mark-ready',
      canonicalUrl: 'https://church.example/sermon',
      recording: {
        kind: 'audio',
        status: 'ready',
        url: 'https://media.example/sermon.mp3?token=temporary'
      },
      text: null
    }),
    error => error instanceof SermonPostServiceLinksError
      && error.code === 'POST_SERVICE_NOT_READY'
      && error.details.missing.includes('available-recording')
  );
  assert.throws(
    () => planSermonPostServiceLinks(sermon(), {
      action: 'save-draft',
      canonicalUrl: null,
      recording: { kind: 'audio', status: 'ready', url: '' },
      text: null
    }),
    error => error.code === 'MISSING_POST_SERVICE_URL'
  );
});

test('reserved slot collisions and duplicate managed URLs fail closed', () => {
  const collision = sermon({
    media: [{
      id: 'post-service:recording:en',
      kind: 'document',
      status: 'ready',
      title: 'Unrelated record',
      language: 'en',
      mediaType: '',
      fileName: null,
      sha256: null,
      sizeBytes: null,
      durationSeconds: null,
      url: 'https://church.example/not-a-recording'
    }]
  });
  assert.throws(
    () => planSermonPostServiceLinks(collision, {
      action: 'save-draft',
      canonicalUrl: null,
      recording: null,
      text: null
    }),
    error => error.code === 'POST_SERVICE_MEDIA_ID_COLLISION'
  );
  assert.throws(
    () => planSermonPostServiceLinks(sermon(), {
      action: 'save-draft',
      canonicalUrl: null,
      recording: {
        kind: 'audio',
        status: 'pending',
        url: 'https://church.example/shared'
      },
      text: {
        kind: 'document',
        status: 'pending',
        url: 'https://church.example/shared'
      }
    }),
    error => error.code === 'DUPLICATE_POST_SERVICE_URL'
  );
});

test('published and archived sermon records are read-only in the local link editor', () => {
  for (const status of ['published', 'archived']) {
    const document = sermon({
      publication: {
        status,
        visibility: 'public',
        publishedAt: status === 'published' ? '2026-07-27T20:00:00.000Z' : null,
        canonicalUrl: 'https://church.example/sermon'
      }
    });
    assert.throws(
      () => planSermonPostServiceLinks(document, {
        action: 'save-draft',
        canonicalUrl: 'https://church.example/revised-sermon',
        recording: null,
        text: null
      }),
      error => error instanceof SermonPostServiceLinksError
        && error.code === 'POST_SERVICE_PUBLICATION_LOCKED'
    );
  }
});
