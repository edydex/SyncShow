'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const {
  CommunitySermonPublicationTransactionConformanceError,
  verifyCommunitySermonPublicationTransactionConformance
} = require(
  '../src/services/community/CommunitySermonPublicationTransactionConformance'
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
  parseSermonPublicDetail,
  parseSermonPublicPassageIndex,
  serializeSermonPublicCatalog,
  serializeSermonPublicDetail,
  serializeSermonPublicPassageIndex
} = require('../src/services/sermon/SermonPublicProjection');

const FIXTURE = JSON.parse(fs.readFileSync(path.join(
  __dirname,
  'fixtures',
  'community-sermon-publication-transaction-conformance-v1.json'
), 'utf8'));

const REQUEST_KEYS = [
  'readyDocumentSource',
  'publishedDocumentSource',
  'preState',
  'publishIntent',
  'serverPublishedAt',
  'prePublishedDocumentSource',
  'preDetailSource',
  'preCatalogSource',
  'prePassageIndexSource',
  'postState',
  'postDetailSource',
  'postCatalogSource',
  'postPassageIndexSource'
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
      instanceof CommunitySermonPublicationTransactionConformanceError,
      true
    );
    assert.equal(error.code, code);
    if (causeCode !== undefined) {
      assert.equal(error.details.causeCode, causeCode);
    }
    return true;
  });
}

function itemFor(items, sermonId, field = 'sermonId') {
  return items.find(item => item[field] === sermonId);
}

test('self-contained republish vector binds the full Ready-to-Published transaction', () => {
  assert.equal(FIXTURE.schemaVersion, 1);
  assert.equal(
    FIXTURE.kind,
    'syncshow-community-sermon-publication-transaction-conformance'
  );
  assert.equal(Object.hasOwn(FIXTURE, 'sourceFixture'), false);

  const ready = parseSermonDocument(FIXTURE.readyDocumentSource);
  const published = parseSermonDocument(FIXTURE.publishedDocumentSource);
  const priorPublished = parseSermonDocument(
    FIXTURE.prePublishedDocumentSource
  );
  assert.equal(serializeSermonDocument(ready), FIXTURE.readyDocumentSource);
  assert.equal(
    serializeSermonDocument(published),
    FIXTURE.publishedDocumentSource
  );
  assert.equal(
    serializeSermonDocument(priorPublished),
    FIXTURE.prePublishedDocumentSource
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
  assert.equal(
    sha256(FIXTURE.prePublishedDocumentSource),
    FIXTURE.preState.publicRevision
  );
  assert.equal(
    sha256(FIXTURE.publishedDocumentSource),
    FIXTURE.postState.publicRevision
  );
  assert.notEqual(
    FIXTURE.preState.currentRevision,
    FIXTURE.preState.publicRevision
  );
  assert.equal(
    FIXTURE.postState.syncVersion,
    FIXTURE.preState.syncVersion + 1
  );
  assert.equal(
    FIXTURE.postState.publicationVersion,
    FIXTURE.preState.publicationVersion + 1
  );
  assert.deepEqual(
    FIXTURE.publishIntent.selectedBodyEntryIds,
    ['private-body-ru', 'private-body-en']
  );
  assert.deepEqual(
    FIXTURE.postState.selectedBodyEntryIds,
    ['private-body-en', 'private-body-ru']
  );

  const verified = verifyCommunitySermonPublicationTransactionConformance(
    request()
  );
  assert.equal(Object.isFrozen(verified), true);
  assert.equal(Object.isFrozen(verified.publishIntent.selectedBodyEntryIds), true);
  assert.equal(verified.transition.baseRevision, FIXTURE.preState.currentRevision);
  assert.equal(
    verified.transition.publicRevision,
    FIXTURE.postState.publicRevision
  );
  assert.equal(
    verified.conformance.detail.sermonRevision,
    FIXTURE.postState.publicRevision
  );
});

test('republish replaces the target once and preserves unrelated global rows exactly', () => {
  const verified = verifyCommunitySermonPublicationTransactionConformance(
    request()
  );
  const sermonId = FIXTURE.preState.syncId;
  const unrelatedId = 'Golden:Sermon:Unrelated:2026-07-20';
  const preTarget = itemFor(verified.preCatalog.items, sermonId);
  const postTarget = itemFor(verified.conformance.catalog.items, sermonId);
  const preUnrelated = itemFor(verified.preCatalog.items, unrelatedId);
  const postUnrelated = itemFor(verified.conformance.catalog.items, unrelatedId);

  assert.equal(verified.preCatalog.items.length, 2);
  assert.equal(verified.conformance.catalog.items.length, 2);
  assert.equal(
    verified.preCatalog.items.filter(item => item.sermonId === sermonId).length,
    1
  );
  assert.equal(
    verified.conformance.catalog.items.filter(item =>
      item.sermonId === sermonId).length,
    1
  );
  assert.equal(preTarget.sermonRevision, FIXTURE.preState.publicRevision);
  assert.equal(postTarget.sermonRevision, FIXTURE.postState.publicRevision);
  assert.notDeepEqual(postTarget, preTarget);
  assert.deepEqual(postUnrelated, preUnrelated);

  const preIndexUnrelated = itemFor(
    verified.prePassageIndex.items,
    unrelatedId
  );
  const postIndexUnrelated = itemFor(
    verified.conformance.passageIndex.items,
    unrelatedId
  );
  assert.deepEqual(postIndexUnrelated, preIndexUnrelated);
  assert.equal(
    sha256(FIXTURE.preCatalogSource),
    FIXTURE.preState.catalogChecksum
  );
  assert.equal(
    sha256(FIXTURE.prePassageIndexSource),
    FIXTURE.preState.passageIndexChecksum
  );
  assert.equal(
    sha256(FIXTURE.postCatalogSource),
    FIXTURE.postState.catalogChecksum
  );
  assert.equal(
    sha256(FIXTURE.postPassageIndexSource),
    FIXTURE.postState.passageIndexChecksum
  );
});

test('request smuggling and every stale compare-and-swap guard fail closed', () => {
  expectCode(
    'INVALID_PUBLICATION_TRANSACTION_REQUEST',
    () => verifyCommunitySermonPublicationTransactionConformance({
      ...request(),
      managerAuthorization: true
    })
  );
  expectCode(
    'INVALID_PUBLICATION_TRANSACTION_REQUEST',
    () => verifyCommunitySermonPublicationTransactionConformance(new Date())
  );

  const intentDrifts = [
    { syncId: 'Golden:Sermon:Different' },
    { expectedSyncVersion: FIXTURE.preState.syncVersion + 1 },
    { expectedCurrentRevision: 'a'.repeat(64) },
    { expectedPublicationVersion: FIXTURE.preState.publicationVersion + 1 },
    { expectedPublicRevision: 'b'.repeat(64) }
  ];
  for (const drift of intentDrifts) {
    expectCode(
      'PUBLICATION_TRANSACTION_CAS_MISMATCH',
      () => verifyCommunitySermonPublicationTransactionConformance(request({
        publishIntent: {
          ...clone(FIXTURE.publishIntent),
          ...drift
        }
      }))
    );
  }
  expectCode(
    'PUBLICATION_TRANSACTION_READY_PUBLIC_REVISION_COLLISION',
    () => verifyCommunitySermonPublicationTransactionConformance(request({
      preState: {
        ...clone(FIXTURE.preState),
        currentRevision: FIXTURE.preState.publicRevision
      },
      publishIntent: {
        ...clone(FIXTURE.publishIntent),
        expectedCurrentRevision: FIXTURE.preState.publicRevision
      }
    }))
  );
});

test('Ready source, server time, exact Published source, and versions fail closed on drift', () => {
  expectCode(
    'INVALID_PUBLICATION_TRANSACTION_TRANSITION',
    () => verifyCommunitySermonPublicationTransactionConformance(request({
      readyDocumentSource: `${FIXTURE.readyDocumentSource}\n`
    })),
    'NONCANONICAL_PUBLICATION_DOCUMENT_SOURCE'
  );
  expectCode(
    'PUBLICATION_TRANSACTION_BASE_REVISION_MISMATCH',
    () => verifyCommunitySermonPublicationTransactionConformance(request({
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
    'PUBLICATION_TRANSACTION_PUBLISHED_SOURCE_MISMATCH',
    () => verifyCommunitySermonPublicationTransactionConformance(request({
      serverPublishedAt: '2026-07-27T20:15:31.123Z'
    }))
  );
  expectCode(
    'PUBLICATION_TRANSACTION_PUBLISHED_SOURCE_MISMATCH',
    () => verifyCommunitySermonPublicationTransactionConformance(request({
      publishedDocumentSource: FIXTURE.readyDocumentSource
    }))
  );

  for (const postState of [
    {
      ...clone(FIXTURE.postState),
      syncVersion: FIXTURE.postState.syncVersion + 1
    },
    {
      ...clone(FIXTURE.postState),
      publicationVersion: FIXTURE.postState.publicationVersion + 1
    }
  ]) {
    expectCode(
      'PUBLICATION_TRANSACTION_VERSION_MISMATCH',
      () => verifyCommunitySermonPublicationTransactionConformance(request({
        postState
      }))
    );
  }
});

test('selection, pointer, checksum, and anonymous artifact tampering fail closed', () => {
  expectCode(
    'INVALID_PUBLICATION_TRANSACTION_POST_STATE',
    () => verifyCommunitySermonPublicationTransactionConformance(request({
      postState: {
        ...clone(FIXTURE.postState),
        publicId: `sermon-${'f'.repeat(64)}`
      }
    })),
    'INVALID_PUBLICATION_STATE'
  );
  expectCode(
    'PUBLICATION_TRANSACTION_SELECTION_MISMATCH',
    () => verifyCommunitySermonPublicationTransactionConformance(request({
      postState: {
        ...clone(FIXTURE.postState),
        selectedBodyEntryIds: ['private-body-ru', 'private-body-en']
      }
    }))
  );
  for (const postState of [
    {
      ...clone(FIXTURE.postState),
      publicRevision: 'd'.repeat(64)
    },
    {
      ...clone(FIXTURE.postState),
      detailChecksum: 'e'.repeat(64)
    }
  ]) {
    expectCode(
      'PUBLICATION_TRANSACTION_POST_STATE_MISMATCH',
      () => verifyCommunitySermonPublicationTransactionConformance(request({
        postState
      }))
    );
  }
  expectCode(
    'PUBLICATION_TRANSACTION_POST_DETAIL_MISMATCH',
    () => verifyCommunitySermonPublicationTransactionConformance(request({
      postDetailSource: `${FIXTURE.postDetailSource}\n`
    }))
  );

  const driftedCatalog = clone(parseSermonPublicCatalog(
    FIXTURE.postCatalogSource
  ));
  const unrelated = itemFor(
    driftedCatalog.items,
    'Golden:Sermon:Unrelated:2026-07-20'
  );
  unrelated.title = 'Changed unrelated title';
  unrelated.titles.en = unrelated.title;
  const driftedCatalogSource = serializeSermonPublicCatalog(driftedCatalog);
  const driftedIndexSource = serializeSermonPublicPassageIndex(
    buildSermonPublicPassageIndex(parseSermonPublicCatalog(driftedCatalogSource))
  );
  expectCode(
    'PUBLICATION_TRANSACTION_POST_CATALOG_MISMATCH',
    () => verifyCommunitySermonPublicationTransactionConformance(request({
      postState: {
        ...clone(FIXTURE.postState),
        catalogChecksum: sha256(driftedCatalogSource),
        passageIndexChecksum: sha256(driftedIndexSource)
      },
      postCatalogSource: driftedCatalogSource,
      postPassageIndexSource: driftedIndexSource
    }))
  );

  const driftedIndex = clone(parseSermonPublicPassageIndex(
    FIXTURE.postPassageIndexSource
  ));
  itemFor(
    driftedIndex.items,
    'Golden:Sermon:Unrelated:2026-07-20'
  ).title = 'Changed unrelated index title';
  const driftedIndexOnlySource = serializeSermonPublicPassageIndex(driftedIndex);
  expectCode(
    'PUBLICATION_TRANSACTION_POST_PASSAGE_INDEX_MISMATCH',
    () => verifyCommunitySermonPublicationTransactionConformance(request({
      postState: {
        ...clone(FIXTURE.postState),
        passageIndexChecksum: sha256(driftedIndexOnlySource)
      },
      postPassageIndexSource: driftedIndexOnlySource
    }))
  );
});

test('before-snapshot bytes and global checksums are part of the parity gate', () => {
  expectCode(
    'INVALID_PUBLICATION_TRANSACTION_PRE_CONFORMANCE',
    () => verifyCommunitySermonPublicationTransactionConformance(request({
      prePublishedDocumentSource: FIXTURE.readyDocumentSource
    }))
  );

  const fabricatedRevision = '9'.repeat(64);
  const fabricatedDetail = clone(parseSermonPublicDetail(
    FIXTURE.preDetailSource
  ));
  fabricatedDetail.sermonRevision = fabricatedRevision;
  const fabricatedDetailSource = serializeSermonPublicDetail(
    fabricatedDetail
  );
  const fabricatedCatalog = clone(parseSermonPublicCatalog(
    FIXTURE.preCatalogSource
  ));
  const fabricatedTarget = itemFor(
    fabricatedCatalog.items,
    FIXTURE.preState.syncId
  );
  fabricatedTarget.sermonRevision = fabricatedRevision;
  fabricatedTarget.checksum = sha256(fabricatedDetailSource);
  const fabricatedCatalogSource = serializeSermonPublicCatalog(
    fabricatedCatalog
  );
  const fabricatedPassageIndexSource = serializeSermonPublicPassageIndex(
    buildSermonPublicPassageIndex(
      parseSermonPublicCatalog(fabricatedCatalogSource)
    )
  );
  expectCode(
    'INVALID_PUBLICATION_TRANSACTION_PRE_CONFORMANCE',
    () => verifyCommunitySermonPublicationTransactionConformance(request({
      preState: {
        ...clone(FIXTURE.preState),
        publicRevision: fabricatedRevision,
        detailChecksum: sha256(fabricatedDetailSource),
        catalogChecksum: sha256(fabricatedCatalogSource),
        passageIndexChecksum: sha256(fabricatedPassageIndexSource)
      },
      publishIntent: {
        ...clone(FIXTURE.publishIntent),
        expectedPublicRevision: fabricatedRevision
      },
      preDetailSource: fabricatedDetailSource,
      preCatalogSource: fabricatedCatalogSource,
      prePassageIndexSource: fabricatedPassageIndexSource
    })),
    'INVALID_PUBLICATION_CONFORMANCE_SOURCE'
  );

  expectCode(
    'INVALID_PUBLICATION_TRANSACTION_PRE_CONFORMANCE',
    () => verifyCommunitySermonPublicationTransactionConformance(request({
      preState: {
        ...clone(FIXTURE.preState),
        detailChecksum: 'f'.repeat(64)
      }
    }))
  );
  expectCode(
    'INVALID_PUBLICATION_TRANSACTION_PRE_CONFORMANCE',
    () => verifyCommunitySermonPublicationTransactionConformance(request({
      preState: {
        ...clone(FIXTURE.preState),
        catalogChecksum: 'f'.repeat(64)
      }
    }))
  );
  expectCode(
    'INVALID_PUBLICATION_TRANSACTION_PRE_CONFORMANCE',
    () => verifyCommunitySermonPublicationTransactionConformance(request({
      preState: {
        ...clone(FIXTURE.preState),
        passageIndexChecksum: 'f'.repeat(64)
      }
    }))
  );

  const targetOnlyCatalog = clone(parseSermonPublicCatalog(
    FIXTURE.preCatalogSource
  ));
  targetOnlyCatalog.items = targetOnlyCatalog.items.filter(item =>
    item.sermonId === FIXTURE.preState.syncId);
  const targetOnlyCatalogSource = serializeSermonPublicCatalog(targetOnlyCatalog);
  const targetOnlyIndexSource = serializeSermonPublicPassageIndex(
    buildSermonPublicPassageIndex(
      parseSermonPublicCatalog(targetOnlyCatalogSource)
    )
  );
  expectCode(
    'PUBLICATION_TRANSACTION_POST_CATALOG_MISMATCH',
    () => verifyCommunitySermonPublicationTransactionConformance(request({
      preState: {
        ...clone(FIXTURE.preState),
        catalogChecksum: sha256(targetOnlyCatalogSource),
        passageIndexChecksum: sha256(targetOnlyIndexSource)
      },
      preCatalogSource: targetOnlyCatalogSource,
      prePassageIndexSource: targetOnlyIndexSource
    }))
  );
});

test('never-published state is rejected by the active-republish gate', () => {
  const neverPublishedPreState = {
    ...clone(FIXTURE.preState),
    publicationVersion: null,
    publicRevision: null,
    publicId: null,
    detailChecksum: null,
    catalogChecksum: null,
    passageIndexChecksum: null,
    publishedAt: null,
    selectedBodyEntryIds: [],
    selectedMediaIds: []
  };
  expectCode(
    'PUBLICATION_TRANSACTION_REPUBLISH_REQUIRED',
    () => verifyCommunitySermonPublicationTransactionConformance(request({
      preState: neverPublishedPreState,
      publishIntent: {
        ...clone(FIXTURE.publishIntent),
        expectedPublicationVersion: null,
        expectedPublicRevision: null
      },
      prePublishedDocumentSource: null,
      preDetailSource: null
    }))
  );
});

test('withdrawn state is rejected by the active-republish gate', () => {
  const withdrawnPreState = {
    ...clone(FIXTURE.preState),
    publicRevision: null,
    publicId: null,
    detailChecksum: null,
    catalogChecksum: null,
    passageIndexChecksum: null,
    publishedAt: null,
    selectedBodyEntryIds: [],
    selectedMediaIds: []
  };
  expectCode(
    'PUBLICATION_TRANSACTION_REPUBLISH_REQUIRED',
    () => verifyCommunitySermonPublicationTransactionConformance(request({
      preState: withdrawnPreState,
      publishIntent: {
        ...clone(FIXTURE.publishIntent),
        expectedPublicRevision: null
      },
      prePublishedDocumentSource: null,
      preDetailSource: null
    }))
  );
});

test('active republish cannot reuse unchanged public bytes', () => {
  const priorPublished = parseSermonDocument(
    FIXTURE.prePublishedDocumentSource
  );
  const noOpReadySource = serializeSermonDocument({
    ...priorPublished,
    publication: {
      ...priorPublished.publication,
      status: 'ready',
      publishedAt: null
    }
  });
  const noOpCurrentRevision = sha256(noOpReadySource);
  expectCode(
    'PUBLICATION_TRANSACTION_PUBLIC_REVISION_UNCHANGED',
    () => verifyCommunitySermonPublicationTransactionConformance(request({
      readyDocumentSource: noOpReadySource,
      publishedDocumentSource: FIXTURE.prePublishedDocumentSource,
      preState: {
        ...clone(FIXTURE.preState),
        currentRevision: noOpCurrentRevision
      },
      publishIntent: {
        ...clone(FIXTURE.publishIntent),
        expectedCurrentRevision: noOpCurrentRevision,
        selectedBodyEntryIds: clone(FIXTURE.preState.selectedBodyEntryIds),
        selectedMediaIds: clone(FIXTURE.preState.selectedMediaIds)
      },
      serverPublishedAt: FIXTURE.preState.publishedAt
    }))
  );
});

test('active republish requires a strictly later server time', () => {
  const backdatedTransition = buildSermonPublicationTransition({
    documentSource: FIXTURE.readyDocumentSource,
    publishedAt: FIXTURE.preState.publishedAt,
    selectedBodyEntryIds: FIXTURE.publishIntent.selectedBodyEntryIds,
    selectedMediaIds: FIXTURE.publishIntent.selectedMediaIds
  });
  assert.notEqual(
    backdatedTransition.publicRevision,
    FIXTURE.preState.publicRevision
  );
  expectCode(
    'PUBLICATION_TRANSACTION_TIME_NOT_MONOTONIC',
    () => verifyCommunitySermonPublicationTransactionConformance(request({
      publishedDocumentSource: backdatedTransition.documentSource,
      serverPublishedAt: FIXTURE.preState.publishedAt
    }))
  );
});

test('the Community barrel exports the pure transaction parity gate', () => {
  const api = require('../src/services/community');
  assert.equal(
    api.verifyCommunitySermonPublicationTransactionConformance,
    verifyCommunitySermonPublicationTransactionConformance
  );
});
