'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const {
  CommunitySermonFirstPublicationTransactionConformanceError,
  verifyCommunitySermonFirstPublicationTransactionConformance
} = require(
  '../src/services/community/CommunitySermonFirstPublicationTransactionConformance'
);
const {
  parseSermonDocument,
  serializeSermonDocument
} = require('../src/services/sermon/SermonDocument');
const {
  buildSermonPublicationTransition
} = require('../src/services/sermon/SermonPublicationTransition');
const {
  buildSermonPublicPassageIndex,
  parseSermonPublicCatalog,
  parseSermonPublicPassageIndex,
  serializeSermonPublicCatalog,
  serializeSermonPublicPassageIndex
} = require('../src/services/sermon/SermonPublicProjection');

const FIXTURE = JSON.parse(fs.readFileSync(path.join(
  __dirname,
  'fixtures',
  'community-sermon-first-publication-transaction-conformance-v1.json'
), 'utf8'));

const REQUEST_KEYS = [
  'readyDocumentSource',
  'publishedDocumentSource',
  'preState',
  'publishIntent',
  'serverPublishedAt',
  'preCatalogAuthority',
  'postState',
  'postDetailSource',
  'postCatalogAuthority'
];

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function sha256(source) {
  return crypto.createHash('sha256').update(source, 'utf8').digest('hex');
}

function request(overrides = {}) {
  return {
    ...Object.fromEntries(REQUEST_KEYS.map(key => [key, clone(FIXTURE[key])])),
    ...overrides
  };
}

function expectCode(code, operation, causeCode = undefined) {
  assert.throws(operation, error => {
    assert.equal(
      error
      instanceof CommunitySermonFirstPublicationTransactionConformanceError,
      true
    );
    assert.equal(error.code, code);
    if (causeCode !== undefined) {
      assert.equal(error.details.causeCode, causeCode);
    }
    return true;
  });
}

function authorityForCatalog(baseAuthority, rawCatalog, overrides = {}) {
  const source = serializeSermonPublicCatalog(rawCatalog);
  const catalog = parseSermonPublicCatalog(source);
  const passageIndexSource = serializeSermonPublicPassageIndex(
    buildSermonPublicPassageIndex(catalog)
  );
  return {
    ...clone(baseAuthority),
    source,
    checksum: sha256(source),
    passageIndexSource,
    passageIndexChecksum: sha256(passageIndexSource),
    ...overrides
  };
}

function authorityWithSources(baseAuthority, source, passageIndexSource, overrides = {}) {
  return {
    ...clone(baseAuthority),
    source,
    checksum: sha256(source),
    passageIndexSource,
    passageIndexChecksum: sha256(passageIndexSource),
    ...overrides
  };
}

function catalogItem(items, sermonId) {
  return items.find(item => item.sermonId === sermonId);
}

test('self-contained vector binds a true first publication and locked catalog generations', () => {
  assert.equal(FIXTURE.schemaVersion, 1);
  assert.equal(
    FIXTURE.kind,
    'syncshow-community-sermon-first-publication-transaction-conformance'
  );
  assert.equal(Object.hasOwn(FIXTURE, 'sourceFixture'), false);

  const ready = parseSermonDocument(FIXTURE.readyDocumentSource);
  const published = parseSermonDocument(FIXTURE.publishedDocumentSource);
  assert.equal(serializeSermonDocument(ready), FIXTURE.readyDocumentSource);
  assert.equal(
    serializeSermonDocument(published),
    FIXTURE.publishedDocumentSource
  );
  assert.deepEqual(ready.publication, {
    status: 'ready',
    visibility: 'members',
    publishedAt: null,
    canonicalUrl: 'https://church.example/sermons/prayer'
  });
  assert.deepEqual(published.publication, {
    status: 'published',
    visibility: 'public',
    publishedAt: FIXTURE.serverPublishedAt,
    canonicalUrl: 'https://church.example/sermons/prayer'
  });
  assert.equal(
    sha256(FIXTURE.readyDocumentSource),
    FIXTURE.preState.currentRevision
  );
  assert.equal(FIXTURE.preState.publicationVersion, null);
  assert.equal(FIXTURE.preState.publicRevision, null);
  assert.equal(FIXTURE.publishIntent.expectedPublicationVersion, null);
  assert.equal(FIXTURE.publishIntent.expectedPublicRevision, null);
  assert.equal(FIXTURE.postState.syncVersion, FIXTURE.preState.syncVersion + 1);
  assert.equal(FIXTURE.postState.publicationVersion, 1);
  assert.equal(
    sha256(FIXTURE.publishedDocumentSource),
    FIXTURE.postState.publicRevision
  );

  const preCatalog = parseSermonPublicCatalog(
    FIXTURE.preCatalogAuthority.source
  );
  const postCatalog = parseSermonPublicCatalog(
    FIXTURE.postCatalogAuthority.source
  );
  const targetId = FIXTURE.preState.syncId;
  const unrelatedId = 'Golden:Sermon:Unrelated:2026-07-20';
  assert.equal(preCatalog.items.length, 1);
  assert.equal(postCatalog.items.length, 2);
  assert.equal(catalogItem(preCatalog.items, targetId), undefined);
  assert.ok(catalogItem(postCatalog.items, targetId));
  assert.deepEqual(
    catalogItem(postCatalog.items, unrelatedId),
    catalogItem(preCatalog.items, unrelatedId)
  );
  assert.equal(
    sha256(FIXTURE.preCatalogAuthority.source),
    FIXTURE.preCatalogAuthority.checksum
  );
  assert.equal(
    sha256(FIXTURE.preCatalogAuthority.passageIndexSource),
    FIXTURE.preCatalogAuthority.passageIndexChecksum
  );
  assert.equal(
    sha256(FIXTURE.postCatalogAuthority.source),
    FIXTURE.postCatalogAuthority.checksum
  );
  assert.equal(
    sha256(FIXTURE.postCatalogAuthority.passageIndexSource),
    FIXTURE.postCatalogAuthority.passageIndexChecksum
  );
  assert.equal(
    FIXTURE.postCatalogAuthority.generation,
    FIXTURE.preCatalogAuthority.generation + 1
  );

  const verified =
    verifyCommunitySermonFirstPublicationTransactionConformance(request());
  assert.equal(Object.isFrozen(verified), true);
  assert.equal(Object.isFrozen(verified.publishIntent.selectedBodyEntryIds), true);
  assert.equal(Object.isFrozen(verified.preCatalogAuthority), true);
  assert.equal(Object.isFrozen(verified.postCatalogAuthority), true);
  assert.equal(
    verified.transition.baseRevision,
    FIXTURE.preState.currentRevision
  );
  assert.equal(
    verified.transition.publicRevision,
    FIXTURE.postState.publicRevision
  );
  assert.equal(verified.preCatalog.items.length, 1);
  assert.equal(verified.conformance.catalog.items.length, 2);
  assert.equal(
    verified.conformance.detail.sermonRevision,
    FIXTURE.postState.publicRevision
  );
});

test('request and catalog-authority shapes reject smuggled, missing, and inherited fields', () => {
  expectCode(
    'INVALID_FIRST_PUBLICATION_TRANSACTION_REQUEST',
    () => verifyCommunitySermonFirstPublicationTransactionConformance({
      ...request(),
      managerAuthorization: true
    })
  );
  const missing = request();
  delete missing.postDetailSource;
  expectCode(
    'INVALID_FIRST_PUBLICATION_TRANSACTION_REQUEST',
    () => verifyCommunitySermonFirstPublicationTransactionConformance(missing)
  );
  expectCode(
    'INVALID_FIRST_PUBLICATION_TRANSACTION_REQUEST',
    () => verifyCommunitySermonFirstPublicationTransactionConformance(new Date())
  );
  expectCode(
    'INVALID_FIRST_PUBLICATION_TRANSACTION_REQUEST',
    () => verifyCommunitySermonFirstPublicationTransactionConformance(
      Object.assign(Object.create({ inheritedAuthority: true }), request())
    )
  );

  for (const phase of ['preCatalogAuthority', 'postCatalogAuthority']) {
    const code = phase === 'preCatalogAuthority'
      ? 'INVALID_FIRST_PUBLICATION_PRE_CATALOG_AUTHORITY'
      : 'INVALID_FIRST_PUBLICATION_POST_CATALOG_AUTHORITY';
    expectCode(code, () =>
      verifyCommunitySermonFirstPublicationTransactionConformance(request({
        [phase]: {
          ...clone(FIXTURE[phase]),
          communityId: 7
        }
      })));
    const missingSource = clone(FIXTURE[phase]);
    delete missingSource.source;
    expectCode(code, () =>
      verifyCommunitySermonFirstPublicationTransactionConformance(request({
        [phase]: missingSource
      })));
    expectCode(code, () =>
      verifyCommunitySermonFirstPublicationTransactionConformance(request({
        [phase]: Object.assign(
          Object.create({ inheritedAuthority: true }),
          clone(FIXTURE[phase])
        )
      })));
  }
});

test('catalog authorities bind schema, generation, time, canonical bytes, hashes, and index derivation', () => {
  const preCode = 'INVALID_FIRST_PUBLICATION_PRE_CATALOG_AUTHORITY';
  const invalidPreAuthorities = [
    {
      ...clone(FIXTURE.preCatalogAuthority),
      schemaVersion: 2
    },
    {
      ...clone(FIXTURE.preCatalogAuthority),
      generation: 0
    },
    {
      ...clone(FIXTURE.preCatalogAuthority),
      generation: Number.MAX_SAFE_INTEGER + 1
    },
    {
      ...clone(FIXTURE.preCatalogAuthority),
      changedAt: '2026-07-26T19:30:00Z'
    },
    {
      ...clone(FIXTURE.preCatalogAuthority),
      checksum: FIXTURE.preCatalogAuthority.checksum.toUpperCase()
    },
    {
      ...clone(FIXTURE.preCatalogAuthority),
      source: `${FIXTURE.preCatalogAuthority.source} `
    }
  ];
  for (const preCatalogAuthority of invalidPreAuthorities) {
    expectCode(preCode, () =>
      verifyCommunitySermonFirstPublicationTransactionConformance(request({
        preCatalogAuthority
      })));
  }

  const noncanonicalSource = `${FIXTURE.preCatalogAuthority.source}\n`;
  expectCode(
    preCode,
    () => verifyCommunitySermonFirstPublicationTransactionConformance(request({
      preCatalogAuthority: authorityWithSources(
        FIXTURE.preCatalogAuthority,
        noncanonicalSource,
        FIXTURE.preCatalogAuthority.passageIndexSource
      )
    })),
    'NONCANONICAL_PUBLIC_CATALOG_SOURCE'
  );

  expectCode(
    preCode,
    () => verifyCommunitySermonFirstPublicationTransactionConformance(request({
      preCatalogAuthority: authorityWithSources(
        FIXTURE.preCatalogAuthority,
        FIXTURE.preCatalogAuthority.source,
        FIXTURE.postCatalogAuthority.passageIndexSource
      )
    }))
  );

  const postCode = 'INVALID_FIRST_PUBLICATION_POST_CATALOG_AUTHORITY';
  const postIndex = clone(parseSermonPublicPassageIndex(
    FIXTURE.postCatalogAuthority.passageIndexSource
  ));
  postIndex.items[0].title = 'A valid but non-derived passage-index title';
  const driftedPostIndexSource = serializeSermonPublicPassageIndex(postIndex);
  expectCode(
    postCode,
    () => verifyCommunitySermonFirstPublicationTransactionConformance(request({
      postCatalogAuthority: authorityWithSources(
        FIXTURE.postCatalogAuthority,
        FIXTURE.postCatalogAuthority.source,
        driftedPostIndexSource
      )
    }))
  );
});

test('artifact byte ceilings run before authority hashing or checksum comparison', () => {
  const oversizedCatalogSource = 'x'.repeat((16 * 1024 * 1024) + 1);
  expectCode(
    'INVALID_FIRST_PUBLICATION_PRE_CATALOG_AUTHORITY',
    () => verifyCommunitySermonFirstPublicationTransactionConformance(request({
      preCatalogAuthority: {
        ...clone(FIXTURE.preCatalogAuthority),
        source: oversizedCatalogSource
      }
    })),
    'INVALID_PUBLIC_CATALOG_SOURCE'
  );

  const oversizedPassageIndexSource = 'x'.repeat((32 * 1024 * 1024) + 1);
  expectCode(
    'INVALID_FIRST_PUBLICATION_POST_CATALOG_AUTHORITY',
    () => verifyCommunitySermonFirstPublicationTransactionConformance(request({
      postCatalogAuthority: {
        ...clone(FIXTURE.postCatalogAuthority),
        passageIndexSource: oversizedPassageIndexSource
      }
    })),
    'INVALID_PUBLIC_PASSAGE_INDEX_SOURCE'
  );
});

test('only true never-published null/null state enters this parity gate', () => {
  const withdrawnState = {
    ...clone(FIXTURE.preState),
    publicationVersion: 4
  };
  expectCode(
    'FIRST_PUBLICATION_TRANSACTION_REQUIRED',
    () => verifyCommunitySermonFirstPublicationTransactionConformance(request({
      preState: withdrawnState,
      publishIntent: {
        ...clone(FIXTURE.publishIntent),
        expectedPublicationVersion: 4
      }
    }))
  );

  const activeState = clone(FIXTURE.postState);
  expectCode(
    'FIRST_PUBLICATION_TRANSACTION_REQUIRED',
    () => verifyCommunitySermonFirstPublicationTransactionConformance(request({
      preState: activeState,
      publishIntent: {
        ...clone(FIXTURE.publishIntent),
        expectedSyncVersion: activeState.syncVersion,
        expectedCurrentRevision: activeState.currentRevision,
        expectedPublicationVersion: activeState.publicationVersion,
        expectedPublicRevision: activeState.publicRevision
      }
    }))
  );
});

test('every identity and version compare-and-swap field is exact', () => {
  const drifts = [
    { syncId: 'Golden:Sermon:Different' },
    { expectedSyncVersion: FIXTURE.preState.syncVersion + 1 },
    { expectedCurrentRevision: 'a'.repeat(64) },
    { expectedPublicationVersion: 1 },
    {
      expectedPublicationVersion: 1,
      expectedPublicRevision: 'b'.repeat(64)
    }
  ];
  for (const drift of drifts) {
    expectCode(
      'FIRST_PUBLICATION_TRANSACTION_CAS_MISMATCH',
      () => verifyCommunitySermonFirstPublicationTransactionConformance(request({
        publishIntent: {
          ...clone(FIXTURE.publishIntent),
          ...drift
        }
      }))
    );
  }

  expectCode(
    'INVALID_FIRST_PUBLICATION_TRANSACTION_INTENT',
    () => verifyCommunitySermonFirstPublicationTransactionConformance(request({
      publishIntent: {
        ...clone(FIXTURE.publishIntent),
        expectedPublicRevision: 'b'.repeat(64)
      }
    })),
    'INVALID_PUBLICATION_INTENT'
  );
});

test('Ready source, stable identity, server time, and exact Published bytes fail closed on drift', () => {
  expectCode(
    'INVALID_FIRST_PUBLICATION_TRANSACTION_TRANSITION',
    () => verifyCommunitySermonFirstPublicationTransactionConformance(request({
      readyDocumentSource: `${FIXTURE.readyDocumentSource}\n`
    })),
    'NONCANONICAL_PUBLICATION_DOCUMENT_SOURCE'
  );
  expectCode(
    'FIRST_PUBLICATION_TRANSACTION_BASE_REVISION_MISMATCH',
    () => verifyCommunitySermonFirstPublicationTransactionConformance(request({
      preState: {
        ...clone(FIXTURE.preState),
        currentRevision: 'c'.repeat(64)
      },
      publishIntent: {
        ...clone(FIXTURE.publishIntent),
        expectedCurrentRevision: 'c'.repeat(64)
      }
    }))
  );
  expectCode(
    'FIRST_PUBLICATION_TRANSACTION_ID_MISMATCH',
    () => verifyCommunitySermonFirstPublicationTransactionConformance(request({
      preState: {
        ...clone(FIXTURE.preState),
        syncId: 'Golden:Sermon:Different'
      },
      publishIntent: {
        ...clone(FIXTURE.publishIntent),
        syncId: 'Golden:Sermon:Different'
      }
    }))
  );
  expectCode(
    'FIRST_PUBLICATION_TRANSACTION_PUBLISHED_SOURCE_MISMATCH',
    () => verifyCommunitySermonFirstPublicationTransactionConformance(request({
      publishedDocumentSource: FIXTURE.readyDocumentSource
    }))
  );
  expectCode(
    'FIRST_PUBLICATION_TRANSACTION_PUBLISHED_SOURCE_MISMATCH',
    () => verifyCommunitySermonFirstPublicationTransactionConformance(request({
      serverPublishedAt: '2026-07-26T20:00:00.001Z'
    }))
  );
});

test('post-state versions, pointers, selections, and detail bytes are exact', () => {
  for (const postState of [
    {
      ...clone(FIXTURE.postState),
      syncVersion: FIXTURE.postState.syncVersion + 1
    },
    {
      ...clone(FIXTURE.postState),
      publicationVersion: 2
    }
  ]) {
    expectCode(
      'FIRST_PUBLICATION_TRANSACTION_VERSION_MISMATCH',
      () => verifyCommunitySermonFirstPublicationTransactionConformance(request({
        postState
      }))
    );
  }

  for (const postState of [
    {
      ...clone(FIXTURE.postState),
      currentRevision: 'd'.repeat(64)
    },
    {
      ...clone(FIXTURE.postState),
      publicRevision: 'd'.repeat(64)
    },
    {
      ...clone(FIXTURE.postState),
      detailChecksum: 'e'.repeat(64)
    },
    {
      ...clone(FIXTURE.postState),
      publishedAt: '2026-07-26T20:00:00.001Z'
    }
  ]) {
    expectCode(
      'FIRST_PUBLICATION_TRANSACTION_POST_STATE_MISMATCH',
      () => verifyCommunitySermonFirstPublicationTransactionConformance(request({
        postState
      }))
    );
  }

  expectCode(
    'FIRST_PUBLICATION_TRANSACTION_SELECTION_MISMATCH',
    () => verifyCommunitySermonFirstPublicationTransactionConformance(request({
      postState: {
        ...clone(FIXTURE.postState),
        selectedBodyEntryIds: []
      }
    }))
  );
  expectCode(
    'FIRST_PUBLICATION_TRANSACTION_POST_DETAIL_MISMATCH',
    () => verifyCommunitySermonFirstPublicationTransactionConformance(request({
      postDetailSource: `${FIXTURE.postDetailSource}\n`
    }))
  );
});

test('the first publication cannot replace a target already present in the protected generation', () => {
  const preCatalogWithTarget = parseSermonPublicCatalog(
    FIXTURE.postCatalogAuthority.source
  );
  expectCode(
    'FIRST_PUBLICATION_TRANSACTION_TARGET_ALREADY_PUBLIC',
    () => verifyCommunitySermonFirstPublicationTransactionConformance(request({
      preCatalogAuthority: authorityForCatalog(
        FIXTURE.preCatalogAuthority,
        preCatalogWithTarget
      )
    }))
  );
});

test('catalog generation and changedAt advance exactly once, including clock catch-up', () => {
  expectCode(
    'FIRST_PUBLICATION_TRANSACTION_CATALOG_GENERATION_MISMATCH',
    () => verifyCommunitySermonFirstPublicationTransactionConformance(request({
      postCatalogAuthority: {
        ...clone(FIXTURE.postCatalogAuthority),
        generation: FIXTURE.postCatalogAuthority.generation + 1
      }
    }))
  );
  expectCode(
    'FIRST_PUBLICATION_TRANSACTION_CATALOG_TIME_MISMATCH',
    () => verifyCommunitySermonFirstPublicationTransactionConformance(request({
      postCatalogAuthority: {
        ...clone(FIXTURE.postCatalogAuthority),
        changedAt: '2026-07-26T20:00:00.001Z'
      }
    }))
  );
  expectCode(
    'FIRST_PUBLICATION_TRANSACTION_VERSION_EXHAUSTED',
    () => verifyCommunitySermonFirstPublicationTransactionConformance(request({
      preCatalogAuthority: {
        ...clone(FIXTURE.preCatalogAuthority),
        generation: Number.MAX_SAFE_INTEGER
      },
      postCatalogAuthority: {
        ...clone(FIXTURE.postCatalogAuthority),
        generation: Number.MAX_SAFE_INTEGER
      }
    }))
  );
  expectCode(
    'FIRST_PUBLICATION_TRANSACTION_VERSION_EXHAUSTED',
    () => verifyCommunitySermonFirstPublicationTransactionConformance(request({
      preState: {
        ...clone(FIXTURE.preState),
        syncVersion: Number.MAX_SAFE_INTEGER
      },
      publishIntent: {
        ...clone(FIXTURE.publishIntent),
        expectedSyncVersion: Number.MAX_SAFE_INTEGER
      }
    }))
  );

  const laterPreChangedAt = '2026-07-26T21:00:00.000Z';
  const verified =
    verifyCommunitySermonFirstPublicationTransactionConformance(request({
      preCatalogAuthority: {
        ...clone(FIXTURE.preCatalogAuthority),
        changedAt: laterPreChangedAt
      },
      postCatalogAuthority: {
        ...clone(FIXTURE.postCatalogAuthority),
        changedAt: '2026-07-26T21:00:00.001Z'
      }
    }));
  assert.equal(
    verified.postCatalogAuthority.changedAt,
    '2026-07-26T21:00:00.001Z'
  );
});

test('post generation is an exact insertion and preserves every unrelated catalog row', () => {
  const omittedTargetCatalog = parseSermonPublicCatalog(
    FIXTURE.preCatalogAuthority.source
  );
  expectCode(
    'FIRST_PUBLICATION_TRANSACTION_POST_CATALOG_MISMATCH',
    () => verifyCommunitySermonFirstPublicationTransactionConformance(request({
      postCatalogAuthority: authorityForCatalog(
        FIXTURE.postCatalogAuthority,
        omittedTargetCatalog
      )
    }))
  );

  const changedUnrelatedCatalog = clone(parseSermonPublicCatalog(
    FIXTURE.postCatalogAuthority.source
  ));
  const unrelated = catalogItem(
    changedUnrelatedCatalog.items,
    'Golden:Sermon:Unrelated:2026-07-20'
  );
  unrelated.title = 'Changed unrelated title';
  unrelated.titles.en = unrelated.title;
  expectCode(
    'FIRST_PUBLICATION_TRANSACTION_POST_CATALOG_MISMATCH',
    () => verifyCommunitySermonFirstPublicationTransactionConformance(request({
      postCatalogAuthority: authorityForCatalog(
        FIXTURE.postCatalogAuthority,
        changedUnrelatedCatalog
      )
    }))
  );
});

test('post state binds both protected global artifact checksums', () => {
  expectCode(
    'FIRST_PUBLICATION_TRANSACTION_POST_CATALOG_CHECKSUM_MISMATCH',
    () => verifyCommunitySermonFirstPublicationTransactionConformance(request({
      postState: {
        ...clone(FIXTURE.postState),
        catalogChecksum: 'f'.repeat(64)
      }
    }))
  );
  expectCode(
    'FIRST_PUBLICATION_TRANSACTION_POST_PASSAGE_INDEX_CHECKSUM_MISMATCH',
    () => verifyCommunitySermonFirstPublicationTransactionConformance(request({
      postState: {
        ...clone(FIXTURE.postState),
        passageIndexChecksum: 'f'.repeat(64)
      }
    }))
  );
});

test('the Community barrel exports the first-publication verifier without changing the republish API', () => {
  const api = require('../src/services/community');
  const republish = require(
    '../src/services/community/CommunitySermonPublicationTransactionConformance'
  );
  assert.equal(
    api.verifyCommunitySermonFirstPublicationTransactionConformance,
    verifyCommunitySermonFirstPublicationTransactionConformance
  );
  assert.equal(
    api.verifyCommunitySermonPublicationTransactionConformance,
    republish.verifyCommunitySermonPublicationTransactionConformance
  );
  assert.notEqual(
    api.verifyCommunitySermonFirstPublicationTransactionConformance,
    api.verifyCommunitySermonPublicationTransactionConformance
  );
});
