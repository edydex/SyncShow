'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  SERMON_SCHEMA_VERSION,
  SermonPostServiceLinksError,
  attachLocalSermonRecording,
  planSermonPostServiceLinks
} = require('../src/services/project');

function sermon(overrides = {}) {
  return {
    schemaVersion: SERMON_SCHEMA_VERSION,
    kind: 'syncshow-sermon',
    id: 'sermon-recording-intake',
    titles: { en: 'Recording intake sermon' },
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

function localRecording(overrides = {}) {
  return {
    kind: 'audio',
    mediaType: 'audio/mpeg',
    fileName: 'sermon.mp3',
    sha256: 'a'.repeat(64),
    sizeBytes: 4_096,
    durationSeconds: null,
    ...overrides
  };
}

function reviewedBody() {
  return [{
    id: 'reviewed-manuscript-en',
    kind: 'manuscript',
    language: 'en',
    sourceId: null,
    sectionId: null,
    text: 'Reviewed sermon text for post-service revisit.'
  }];
}

function unrelatedMedia() {
  return {
    id: 'pastor-source-upload',
    kind: 'document',
    status: 'processing',
    title: 'Original notes upload',
    language: 'en',
    mediaType: 'application/pdf',
    fileName: 'notes.pdf',
    sha256: 'f'.repeat(64),
    sizeBytes: 2_048,
    durationSeconds: null,
    url: null
  };
}

function readyWithLocalRecording(metadata = localRecording()) {
  const attached = attachLocalSermonRecording(
    sermon({ body: reviewedBody() }),
    metadata
  );
  return planSermonPostServiceLinks(attached.document, {
    action: 'mark-ready',
    canonicalUrl: null,
    recording: {
      kind: metadata.kind,
      status: 'ready',
      url: 'https://media.example.org/sermon.mp3'
    },
    text: null
  }).document;
}

test('local recording intake owns the stable managed slot and deeply freezes its result', () => {
  const unrelated = unrelatedMedia();
  const result = attachLocalSermonRecording(
    sermon({ media: [unrelated] }),
    localRecording()
  );

  assert.deepEqual(result.document.media[0], unrelated);
  assert.deepEqual(result.document.media[1], {
    id: 'post-service:recording:en',
    kind: 'audio',
    status: 'pending',
    title: 'Sermon audio',
    language: 'en',
    mediaType: 'audio/mpeg',
    fileName: 'sermon.mp3',
    sha256: 'a'.repeat(64),
    sizeBytes: 4_096,
    durationSeconds: null,
    url: null
  });
  assert.equal(result.readiness.recordingReady, false);
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.document), true);
  assert.equal(Object.isFrozen(result.document.media), true);
  assert.equal(Object.isFrozen(result.document.media[1]), true);
  assert.equal(Object.isFrozen(result.readiness), true);
  assert.equal(Object.isFrozen(result.readiness.missing), true);
});

test('identical recording bytes preserve the reviewed HTTPS link and Ready state', () => {
  const current = readyWithLocalRecording();
  const result = attachLocalSermonRecording(current, localRecording({
    fileName: 'renamed-sermon.mp3',
    mediaType: 'audio/mp3',
    sizeBytes: 4_096,
    durationSeconds: 1_825.25
  }));
  const recording = result.document.media.find(media =>
    media.id === 'post-service:recording:en');

  assert.equal(recording.sha256, 'a'.repeat(64));
  assert.equal(recording.fileName, 'renamed-sermon.mp3');
  assert.equal(recording.mediaType, 'audio/mp3');
  assert.equal(recording.durationSeconds, 1_825.25);
  assert.equal(recording.status, 'ready');
  assert.equal(recording.url, 'https://media.example.org/sermon.mp3');
  assert.equal(result.document.publication.status, 'ready');
  assert.equal(result.readiness.ready, true);
});

test('replacement bytes cannot inherit an old recording URL and demote Ready to Draft', () => {
  const current = readyWithLocalRecording();
  const result = attachLocalSermonRecording(current, localRecording({
    kind: 'video',
    mediaType: 'video/mp4',
    fileName: 'replacement.mp4',
    sha256: 'b'.repeat(64),
    sizeBytes: 8_192,
    durationSeconds: 1_900
  }));
  const recording = result.document.media.find(media =>
    media.id === 'post-service:recording:en');

  assert.deepEqual(recording, {
    id: 'post-service:recording:en',
    kind: 'video',
    status: 'pending',
    title: 'Sermon video',
    language: 'en',
    mediaType: 'video/mp4',
    fileName: 'replacement.mp4',
    sha256: 'b'.repeat(64),
    sizeBytes: 8_192,
    durationSeconds: 1_900,
    url: null
  });
  assert.equal(result.document.publication.status, 'draft');
  assert.equal(result.readiness.recordingReady, false);
  assert.equal(result.readiness.ready, false);
});

test('same local bytes cannot preserve a stale Ready publication without an available URL', () => {
  const localOnly = attachLocalSermonRecording(
    sermon({ body: reviewedBody() }),
    localRecording()
  ).document;
  const inconsistentReady = {
    ...localOnly,
    publication: {
      ...localOnly.publication,
      status: 'ready'
    }
  };
  const result = attachLocalSermonRecording(
    inconsistentReady,
    localRecording()
  );

  assert.equal(result.document.publication.status, 'draft');
  assert.equal(result.document.media[0].status, 'pending');
  assert.equal(result.document.media[0].url, null);
  assert.equal(result.readiness.ready, false);
});

test('later URL review preserves local metadata and clearing the URL keeps local bytes', () => {
  const attached = attachLocalSermonRecording(
    sermon({ body: reviewedBody() }),
    localRecording({ durationSeconds: 1_700.5 })
  );
  const linked = planSermonPostServiceLinks(attached.document, {
    action: 'mark-ready',
    canonicalUrl: null,
    recording: {
      kind: 'audio',
      status: 'ready',
      url: 'https://media.example.org/recordings/sermon.mp3'
    },
    text: null
  });
  const linkedRecording = linked.document.media.find(media =>
    media.id === 'post-service:recording:en');

  assert.equal(linkedRecording.id, 'post-service:recording:en');
  assert.equal(linkedRecording.sha256, 'a'.repeat(64));
  assert.equal(linkedRecording.fileName, 'sermon.mp3');
  assert.equal(linkedRecording.mediaType, 'audio/mpeg');
  assert.equal(linkedRecording.sizeBytes, 4_096);
  assert.equal(linkedRecording.durationSeconds, 1_700.5);
  assert.equal(linkedRecording.url, 'https://media.example.org/recordings/sermon.mp3');
  assert.equal(linked.readiness.recordingReady, true);

  const cleared = planSermonPostServiceLinks(linked.document, {
    action: 'save-draft',
    canonicalUrl: null,
    recording: { kind: 'audio', status: 'pending', url: '   ' },
    text: null
  });
  const clearedRecording = cleared.document.media.find(media =>
    media.id === 'post-service:recording:en');

  assert.deepEqual({
    id: clearedRecording.id,
    status: clearedRecording.status,
    sha256: clearedRecording.sha256,
    fileName: clearedRecording.fileName,
    mediaType: clearedRecording.mediaType,
    sizeBytes: clearedRecording.sizeBytes,
    durationSeconds: clearedRecording.durationSeconds,
    url: clearedRecording.url
  }, {
    id: 'post-service:recording:en',
    status: 'pending',
    sha256: 'a'.repeat(64),
    fileName: 'sermon.mp3',
    mediaType: 'audio/mpeg',
    sizeBytes: 4_096,
    durationSeconds: 1_700.5,
    url: null
  });
  assert.equal(cleared.readiness.recordingReady, false);
});

test('a reviewed URL cannot relabel locally verified audio bytes as video', () => {
  const attached = attachLocalSermonRecording(
    sermon({ body: reviewedBody() }),
    localRecording()
  );

  assert.throws(
    () => planSermonPostServiceLinks(attached.document, {
      action: 'save-draft',
      canonicalUrl: null,
      recording: {
        kind: 'video',
        status: 'ready',
        url: 'https://media.example.org/sermon.mp4'
      },
      text: null
    }),
    error => error instanceof SermonPostServiceLinksError
      && error.code === 'LOCAL_RECORDING_KIND_MISMATCH'
  );
});

test('a locally retained recording cannot satisfy Ready without a reviewed HTTPS URL', () => {
  const attached = attachLocalSermonRecording(
    sermon({ body: reviewedBody() }),
    localRecording()
  );

  assert.throws(
    () => planSermonPostServiceLinks(attached.document, {
      action: 'mark-ready',
      canonicalUrl: null,
      recording: { kind: 'audio', status: 'pending', url: '' },
      text: null
    }),
    error => error instanceof SermonPostServiceLinksError
      && error.code === 'POST_SERVICE_NOT_READY'
      && error.details.missing.includes('available-recording')
  );
});

test('URL-only managed recordings retain prior review and blank-slot behavior', () => {
  const first = planSermonPostServiceLinks(sermon(), {
    action: 'save-draft',
    canonicalUrl: null,
    recording: {
      kind: 'audio',
      status: 'ready',
      url: 'https://media.example.org/first.mp3'
    },
    text: null
  });
  const second = planSermonPostServiceLinks(first.document, {
    action: 'save-draft',
    canonicalUrl: null,
    recording: {
      kind: 'audio',
      status: 'pending',
      url: 'https://media.example.org/second.mp3'
    },
    text: null
  });
  const recording = second.document.media.find(media =>
    media.id === 'post-service:recording:en');

  assert.equal(recording.url, 'https://media.example.org/second.mp3');
  assert.equal(recording.sha256, null);
  assert.equal(recording.fileName, null);
  assert.equal(recording.mediaType, '');
  assert.equal(recording.sizeBytes, null);
  assert.equal(recording.durationSeconds, null);

  const blank = planSermonPostServiceLinks(second.document, {
    action: 'save-draft',
    canonicalUrl: null,
    recording: { kind: 'audio', status: 'pending', url: '' },
    text: null
  });
  assert.equal(
    blank.document.media.some(media => media.id === 'post-service:recording:en'),
    false
  );
});

test('recording intake preserves unrelated and managed text media', () => {
  const linked = planSermonPostServiceLinks(sermon({
    media: [unrelatedMedia()]
  }), {
    action: 'save-draft',
    canonicalUrl: null,
    recording: null,
    text: {
      kind: 'transcript',
      status: 'ready',
      url: 'https://church.example.org/sermon/transcript'
    }
  });
  const result = attachLocalSermonRecording(linked.document, localRecording());

  assert.deepEqual(
    result.document.media.map(media => media.id).sort(),
    [
      'pastor-source-upload',
      'post-service:recording:en',
      'post-service:text:en'
    ].sort()
  );
  assert.deepEqual(
    result.document.media.find(media => media.id === 'pastor-source-upload'),
    unrelatedMedia()
  );
  assert.equal(
    result.document.media.find(media => media.id === 'post-service:text:en').url,
    'https://church.example.org/sermon/transcript'
  );
});

test('local managed slots are collision-compatible, while invalid slots and locked records fail closed', () => {
  const compatibleLocal = {
    id: 'post-service:recording:en',
    kind: 'audio',
    status: 'pending',
    title: 'Sermon audio',
    language: 'en',
    mediaType: 'audio/mpeg',
    fileName: 'sermon.mp3',
    sha256: 'a'.repeat(64),
    sizeBytes: 4_096,
    durationSeconds: null,
    url: null
  };
  const retained = planSermonPostServiceLinks(sermon({
    media: [compatibleLocal]
  }), {
    action: 'save-draft',
    canonicalUrl: null,
    recording: { kind: 'audio', status: 'pending', url: '' },
    text: null
  });
  assert.deepEqual(retained.document.media, [compatibleLocal]);

  const collision = sermon({
    media: [{
      ...compatibleLocal,
      kind: 'document',
      title: 'Not a recording'
    }]
  });
  assert.throws(
    () => attachLocalSermonRecording(collision, localRecording()),
    error => error instanceof SermonPostServiceLinksError
      && error.code === 'POST_SERVICE_MEDIA_ID_COLLISION'
  );

  for (const status of ['published', 'archived']) {
    const locked = sermon({
      publication: {
        status,
        visibility: 'public',
        publishedAt: status === 'published' ? '2026-07-27T20:00:00.000Z' : null,
        canonicalUrl: 'https://church.example/sermon'
      }
    });
    assert.throws(
      () => attachLocalSermonRecording(locked, localRecording()),
      error => error instanceof SermonPostServiceLinksError
        && error.code === 'POST_SERVICE_PUBLICATION_LOCKED'
    );
  }
});

test('recording intake rejects caller-controlled identity, URL, and invalid local metadata', () => {
  for (const metadata of [
    { ...localRecording(), id: 'caller-owned-id' },
    { ...localRecording(), url: 'https://attacker.example/recording' },
    { ...localRecording(), filePath: '/Users/operator/sermon.mp3' },
    { ...localRecording(), mediaType: '' },
    { ...localRecording(), sizeBytes: -1 },
    { ...localRecording(), durationSeconds: 0 }
  ]) {
    assert.throws(
      () => attachLocalSermonRecording(sermon(), metadata)
    );
  }
});
