'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');

const {
  MAX_SERMON_SOURCE_BYTES,
  SERMON_KIND,
  serializeSermonDocument
} = require('../src/services/sermon/SermonDocument');
const {
  COMMUNITY_SERMON_WIRE_SCHEMA_VERSION,
  CommunitySermonWireError,
  MAX_SERMON_CHANGE_ITEMS,
  MAX_SERMON_CURSOR_BYTES,
  MAX_SERMON_SOURCE_OBJECTS,
  buildSermonCreateBody,
  buildSermonIdempotencyHeaders,
  buildSermonIfMatchHeaders,
  buildSermonUpdateBody,
  normalizeRemoteSermonEnvelope,
  normalizeSermonChangePage,
  normalizeSermonChangeSummary
} = require('../src/services/community/CommunitySermonWire');

function sourceRecord({
  id,
  sha256,
  sizeBytes,
  kind = 'manuscript',
  schemaVersion = 2
}) {
  const record = {
    id,
    kind,
    fileName: `${id}.pdf`,
    mediaType: 'application/pdf',
    sha256,
    sizeBytes,
    provenance: {
      providedBy: 'Pastor Example',
      receivedAt: '2026-07-26T18:00:00.000Z',
      sourceSystem: 'manual-file-picker',
      externalId: ''
    }
  };
  if (schemaVersion === 1) record.language = 'en';
  else record.languages = ['en'];
  return record;
}

function sermonDocument({
  schemaVersion = 2,
  id = 'sermon-2026-07-26-prayer',
  sources = null,
  publicationStatus = 'draft',
  body = null
} = {}) {
  const document = {
    schemaVersion,
    kind: SERMON_KIND,
    id,
    titles: { en: 'The Prayer That Transforms the Church' },
    defaultLanguage: 'en',
    speaker: { id: null, name: 'Pastor Example' },
    serviceDate: '2026-07-26',
    series: null,
    outline: [],
    sources: sources || [
      sourceRecord({
        id: 'pastor-manuscript',
        sha256: 'a'.repeat(64),
        sizeBytes: 184320,
        schemaVersion
      }),
      sourceRecord({
        id: 'sermon-slides',
        sha256: 'b'.repeat(64),
        sizeBytes: 2200000,
        kind: 'slide-notes',
        schemaVersion
      })
    ],
    references: [],
    media: [],
    publication: {
      status: publicationStatus,
      visibility: 'private',
      publishedAt: null,
      canonicalUrl: null
    }
  };
  if (schemaVersion === 3) document.body = body || [];
  return document;
}

function reviewedBody() {
  return [{
    id: 'manuscript-opening-en',
    kind: 'manuscript',
    language: 'en',
    sourceId: 'pastor-manuscript',
    sectionId: null,
    text: 'For this reason I bow my knees before the Father.\n\nThis is the reviewed manuscript.'
  }, {
    id: 'slides-prayer-ru',
    kind: 'slide-notes',
    language: 'ru',
    sourceId: 'sermon-slides',
    sectionId: null,
    text: 'Для сего преклоняю колени мои пред Отцом.'
  }];
}

function revisionOf(documentSource) {
  return crypto.createHash('sha256').update(documentSource, 'utf8').digest('hex');
}

function changeSummary(overrides = {}) {
  return {
    syncId: 'sermon-2026-07-26-prayer',
    syncVersion: 3,
    revision: 'c'.repeat(64),
    archived: false,
    updatedAt: '2026-07-27T01:30:00.000Z',
    ...overrides
  };
}

function envelope({
  document = sermonDocument(),
  sourceAvailability = {},
  overrides = {}
} = {}) {
  const documentSource = serializeSermonDocument(document);
  return {
    syncId: document.id,
    syncVersion: 3,
    revision: revisionOf(documentSource),
    documentSource,
    archived: false,
    updatedAt: '2026-07-27T01:30:00.000Z',
    sourceObjects: [...document.sources].reverse().map(source => ({
      sourceId: source.id,
      sha256: source.sha256,
      sizeBytes: source.sizeBytes,
      available: sourceAvailability[source.id] === true
    })),
    ...overrides
  };
}

function expectWireCode(code, callback) {
  assert.throws(callback, error => {
    assert.ok(error instanceof CommunitySermonWireError);
    assert.equal(error.code, code);
    return true;
  });
}

test('change summaries are strict, normalized, and immutable', () => {
  const normalized = normalizeSermonChangeSummary(changeSummary({
    updatedAt: '2026-07-26T18:30:00-07:00'
  }));
  assert.deepEqual(normalized, {
    syncId: 'sermon-2026-07-26-prayer',
    syncVersion: 3,
    revision: 'c'.repeat(64),
    archived: false,
    updatedAt: '2026-07-27T01:30:00.000Z'
  });
  assert.equal(Object.isFrozen(normalized), true);

  expectWireCode('INVALID_RESPONSE', () =>
    normalizeSermonChangeSummary(changeSummary({ archived: 0 })));
  expectWireCode('INVALID_RESPONSE', () =>
    normalizeSermonChangeSummary(changeSummary({ revision: 'C'.repeat(64) })));
  expectWireCode('INVALID_RESPONSE', () =>
    normalizeSermonChangeSummary(changeSummary({ updatedAt: '2026-02-30T12:00:00Z' })));
  expectWireCode('INVALID_RESPONSE', () =>
    normalizeSermonChangeSummary(changeSummary({ updatedAt: '9999-12-31T23:59:59-23:00' })));
  expectWireCode('INVALID_RESPONSE', () =>
    normalizeSermonChangeSummary({ ...changeSummary(), documentSource: '{}' }));
});

test('change pages enforce schema, pagination invariants, uniqueness, and hard limits', () => {
  const page = normalizeSermonChangePage({
    schemaVersion: COMMUNITY_SERMON_WIRE_SCHEMA_VERSION,
    items: [changeSummary()],
    nextCursor: 'cursor-2',
    hasMore: true
  });
  assert.equal(Object.isFrozen(page), true);
  assert.equal(Object.isFrozen(page.items), true);
  assert.equal(page.nextCursor, 'cursor-2');

  expectWireCode('INVALID_RESPONSE', () => normalizeSermonChangePage({
    schemaVersion: 2,
    items: [],
    nextCursor: null,
    hasMore: false
  }));
  expectWireCode('INVALID_RESPONSE', () => normalizeSermonChangePage({
    schemaVersion: 1,
    items: [],
    nextCursor: null,
    hasMore: false
  }));
  expectWireCode('INVALID_RESPONSE', () => normalizeSermonChangePage({
    schemaVersion: 1,
    items: [],
    nextCursor: 'cursor-without-items',
    hasMore: true
  }));
  const finalPage = normalizeSermonChangePage({
    schemaVersion: 1,
    items: [],
    nextCursor: 'durable-final-cursor',
    hasMore: false
  });
  assert.equal(finalPage.nextCursor, 'durable-final-cursor');
  assert.equal(finalPage.hasMore, false);
  expectWireCode('INVALID_RESPONSE', () => normalizeSermonChangePage({
    schemaVersion: 1,
    items: [changeSummary(), changeSummary()],
    nextCursor: 'duplicate-page-cursor',
    hasMore: false
  }));
  expectWireCode('INVALID_RESPONSE', () => normalizeSermonChangePage({
    schemaVersion: 1,
    items: Array.from({ length: MAX_SERMON_CHANGE_ITEMS + 1 }, (_, index) =>
      changeSummary({ syncId: `sermon-${index}` })),
    nextCursor: 'oversized-page-cursor',
    hasMore: false
  }));
});

test('change cursors preserve opaque text while rejecting oversized or controlling values', () => {
  const maximumCursor = 'x'.repeat(MAX_SERMON_CURSOR_BYTES);
  assert.equal(normalizeSermonChangePage({
    schemaVersion: 1,
    items: [changeSummary()],
    nextCursor: maximumCursor,
    hasMore: true
  }).nextCursor, maximumCursor);

  expectWireCode('INVALID_RESPONSE', () => normalizeSermonChangePage({
    schemaVersion: 1,
    items: [changeSummary()],
    nextCursor: 'x'.repeat(MAX_SERMON_CURSOR_BYTES + 1),
    hasMore: true
  }));
  expectWireCode('INVALID_RESPONSE', () => normalizeSermonChangePage({
    schemaVersion: 1,
    items: [changeSummary()],
    nextCursor: 'cursor\nheader-injection',
    hasMore: true
  }));
});

test('a full remote sermon verifies canonical bytes, identity, revision, and source availability', () => {
  const raw = envelope({
    sourceAvailability: { 'pastor-manuscript': true }
  });
  const normalized = normalizeRemoteSermonEnvelope(raw);

  assert.deepEqual(normalized, {
    syncId: raw.syncId,
    syncVersion: 3,
    revision: raw.revision,
    documentSource: raw.documentSource,
    archived: false,
    updatedAt: '2026-07-27T01:30:00.000Z',
    sourceObjects: [{
      sourceId: 'pastor-manuscript',
      sha256: 'a'.repeat(64),
      sizeBytes: 184320,
      available: true
    }, {
      sourceId: 'sermon-slides',
      sha256: 'b'.repeat(64),
      sizeBytes: 2200000,
      available: false
    }]
  });
  assert.equal(Object.isFrozen(normalized), true);
  assert.equal(Object.isFrozen(normalized.sourceObjects), true);
  assert.equal(Object.isFrozen(normalized.sourceObjects[0]), true);

  const availabilityChanged = normalizeRemoteSermonEnvelope(envelope({
    sourceAvailability: {
      'pastor-manuscript': false,
      'sermon-slides': true
    }
  }));
  assert.equal(availabilityChanged.revision, normalized.revision);
  assert.notDeepEqual(availabilityChanged.sourceObjects, normalized.sourceObjects);
});

test('canonical v3 sermon bodies cross remote, create, and update wire paths byte-for-byte', () => {
  const document = sermonDocument({
    schemaVersion: 3,
    id: 'sermon-v3-reviewed-body',
    body: reviewedBody()
  });
  const canonicalSource = serializeSermonDocument(document);
  const raw = envelope({ document });
  const normalized = normalizeRemoteSermonEnvelope(raw);

  assert.equal(normalized.documentSource, canonicalSource);
  assert.equal(normalized.revision, revisionOf(canonicalSource));
  assert.deepEqual(JSON.parse(normalized.documentSource).body, reviewedBody());

  for (const builder of [buildSermonCreateBody, buildSermonUpdateBody]) {
    const body = builder({
      syncId: document.id,
      documentSource: normalized.documentSource
    });
    assert.deepEqual(body, {
      syncId: document.id,
      revision: normalized.revision,
      documentSource: canonicalSource
    });
  }
});

test('canonical post-service page and media links cross the sermon wire exactly without media bytes', () => {
  const document = sermonDocument();
  document.publication.canonicalUrl =
    'https://church.example/sermons/prayer?language=en';
  document.media = [{
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
    url: 'https://media.example/sermons/prayer.mp3?download=1'
  }, {
    id: 'post-service:text:en',
    kind: 'document',
    status: 'pending',
    title: 'Sermon notes',
    language: 'en',
    mediaType: '',
    fileName: null,
    sha256: null,
    sizeBytes: null,
    durationSeconds: null,
    url: 'https://church.example/sermons/prayer/notes.pdf'
  }];
  const raw = envelope({ document });
  const normalized = normalizeRemoteSermonEnvelope(raw);
  const parsed = JSON.parse(normalized.documentSource);

  assert.equal(
    parsed.publication.canonicalUrl,
    document.publication.canonicalUrl
  );
  assert.deepEqual(parsed.media, document.media);
  assert.equal(Object.hasOwn(normalized, 'mediaBytes'), false);
  assert.equal(Object.hasOwn(normalized, 'recordingBytes'), false);

  for (const builder of [buildSermonCreateBody, buildSermonUpdateBody]) {
    const body = builder({
      syncId: document.id,
      documentSource: normalized.documentSource
    });
    assert.equal(body.documentSource, normalized.documentSource);
    assert.equal(body.revision, normalized.revision);
    assert.equal(Object.hasOwn(body, 'mediaBytes'), false);
  }
});

test('remote sermon integrity rejects noncanonical source, checksum, and identity mismatches', () => {
  const canonical = envelope();
  const prettySource = `${JSON.stringify(JSON.parse(canonical.documentSource), null, 2)}\n`;
  expectWireCode('INVALID_RESPONSE', () => normalizeRemoteSermonEnvelope({
    ...canonical,
    documentSource: prettySource,
    revision: revisionOf(prettySource)
  }));
  expectWireCode('INVALID_RESPONSE', () => normalizeRemoteSermonEnvelope({
    ...canonical,
    documentSource: canonical.documentSource.slice(0, -1),
    revision: revisionOf(canonical.documentSource.slice(0, -1))
  }));
  expectWireCode('INVALID_RESPONSE', () => normalizeRemoteSermonEnvelope({
    ...canonical,
    revision: 'd'.repeat(64)
  }));
  expectWireCode('INVALID_RESPONSE', () => normalizeRemoteSermonEnvelope({
    ...canonical,
    syncId: 'different-sermon'
  }));
  expectWireCode('INVALID_RESPONSE', () => normalizeRemoteSermonEnvelope({
    ...canonical,
    documentSource: 'x'.repeat(MAX_SERMON_SOURCE_BYTES + 1),
    revision: 'd'.repeat(64)
  }));

  const reviewed = envelope({
    document: sermonDocument({
      schemaVersion: 3,
      body: reviewedBody()
    })
  });
  const mismatchedBodySource = reviewed.documentSource.replace(
    '"body":[{"id":"manuscript-opening-en","kind":"manuscript"',
    '"body":[{"id":"manuscript-opening-en","kind":"transcript"'
  );
  assert.notEqual(mismatchedBodySource, reviewed.documentSource);
  expectWireCode('INVALID_RESPONSE', () => normalizeRemoteSermonEnvelope({
    ...reviewed,
    documentSource: mismatchedBodySource,
    revision: revisionOf(mismatchedBodySource)
  }));
});

test('remote archived state must agree with the canonical publication status', () => {
  const archivedDocument = sermonDocument({ publicationStatus: 'archived' });
  const archived = normalizeRemoteSermonEnvelope(envelope({
    document: archivedDocument,
    overrides: { archived: true }
  }));
  assert.equal(archived.archived, true);

  expectWireCode('INVALID_RESPONSE', () => normalizeRemoteSermonEnvelope(envelope({
    document: archivedDocument,
    overrides: { archived: false }
  })));
  expectWireCode('INVALID_RESPONSE', () => normalizeRemoteSermonEnvelope(envelope({
    document: sermonDocument(),
    overrides: { archived: true }
  })));
});

test('canonical v1 sermon bytes and their historical hash cross the wire unchanged', () => {
  const legacy = sermonDocument({
    schemaVersion: 1,
    id: 'sermon-legacy-v1'
  });
  const raw = envelope({ document: legacy });
  const normalized = normalizeRemoteSermonEnvelope(raw);

  assert.equal(JSON.parse(normalized.documentSource).schemaVersion, 1);
  assert.equal(JSON.parse(normalized.documentSource).sources[0].language, 'en');
  assert.equal(Object.hasOwn(JSON.parse(normalized.documentSource).sources[0], 'languages'), false);
  assert.equal(normalized.documentSource, raw.documentSource);
  assert.equal(normalized.revision, revisionOf(raw.documentSource));
});

test('source availability is complete and must agree with canonical source metadata', () => {
  const raw = envelope();
  const mutate = callback => {
    const candidate = {
      ...raw,
      sourceObjects: raw.sourceObjects.map(item => ({ ...item }))
    };
    callback(candidate);
    return candidate;
  };

  expectWireCode('INVALID_RESPONSE', () => normalizeRemoteSermonEnvelope(
    mutate(candidate => candidate.sourceObjects.pop())
  ));
  expectWireCode('INVALID_RESPONSE', () => normalizeRemoteSermonEnvelope(
    mutate(candidate => candidate.sourceObjects[1].sourceId = candidate.sourceObjects[0].sourceId)
  ));
  expectWireCode('INVALID_RESPONSE', () => normalizeRemoteSermonEnvelope(
    mutate(candidate => candidate.sourceObjects[0].sha256 = 'e'.repeat(64))
  ));
  expectWireCode('INVALID_RESPONSE', () => normalizeRemoteSermonEnvelope(
    mutate(candidate => candidate.sourceObjects[0].sizeBytes += 1)
  ));
  expectWireCode('INVALID_RESPONSE', () => normalizeRemoteSermonEnvelope(
    mutate(candidate => candidate.sourceObjects[0].available = 'yes')
  ));
  expectWireCode('INVALID_RESPONSE', () => normalizeRemoteSermonEnvelope(
    mutate(candidate => candidate.sourceObjects[0].sourceBytes = 'private bytes')
  ));
});

test('source availability count has an independent wire safety bound', () => {
  const raw = envelope();
  raw.sourceObjects = Array.from({ length: MAX_SERMON_SOURCE_OBJECTS + 1 }, (_, index) => ({
    sourceId: `source-${index}`,
    sha256: 'a'.repeat(64),
    sizeBytes: 1,
    available: false
  }));
  expectWireCode('INVALID_RESPONSE', () => normalizeRemoteSermonEnvelope(raw));
});

test('create and update bodies are symmetric, self-describing, and derive the exact revision', () => {
  const canonicalV2 = serializeSermonDocument(sermonDocument());
  const canonicalV1 = serializeSermonDocument(sermonDocument({
    schemaVersion: 1,
    id: 'sermon-legacy-v1'
  }));

  for (const [builder, syncId, documentSource] of [
    [buildSermonCreateBody, 'sermon-2026-07-26-prayer', canonicalV2],
    [buildSermonUpdateBody, 'sermon-legacy-v1', canonicalV1]
  ]) {
    const body = builder({ syncId, documentSource });
    assert.deepEqual(body, {
      syncId,
      revision: revisionOf(documentSource),
      documentSource
    });
    assert.equal(Object.isFrozen(body), true);
  }

  expectWireCode('INVALID_INPUT', () => buildSermonCreateBody({
    syncId: 'different-sermon',
    documentSource: canonicalV2
  }));
  expectWireCode('INVALID_INPUT', () => buildSermonUpdateBody({
    syncId: 'sermon-2026-07-26-prayer',
    documentSource: JSON.stringify(JSON.parse(canonicalV2))
  }));
  expectWireCode('INVALID_INPUT', () => buildSermonCreateBody({
    syncId: 'sermon-2026-07-26-prayer',
    documentSource: canonicalV2,
    sourceBytes: 'not part of this protocol'
  }));
});

test('If-Match and idempotency helpers emit injection-safe exact headers', () => {
  assert.deepEqual(buildSermonIfMatchHeaders({
    syncId: 'sermon-2026-07-26-prayer',
    expectedSyncVersion: 9
  }), {
    'If-Match': '"sermon:sermon-2026-07-26-prayer:9"'
  });
  assert.deepEqual(
    buildSermonIdempotencyHeaders('sermon-create.2026-07-26:retry-1'),
    { 'Idempotency-Key': 'sermon-create.2026-07-26:retry-1' }
  );

  expectWireCode('INVALID_INPUT', () => buildSermonIfMatchHeaders({
    syncId: 'sermon\r\nX-Evil: yes',
    expectedSyncVersion: 1
  }));
  expectWireCode('INVALID_INPUT', () => buildSermonIfMatchHeaders({
    syncId: 'sermon-valid',
    expectedSyncVersion: 0
  }));
  expectWireCode('INVALID_INPUT', () =>
    buildSermonIdempotencyHeaders('short'));
  expectWireCode('INVALID_INPUT', () =>
    buildSermonIdempotencyHeaders('safe-key\r\nX-Evil: yes'));
});
