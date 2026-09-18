'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const {
  CommunitySermonPublicationConformanceError,
  verifyCommunitySermonPublicationConformance
} = require('../src/services/community/CommunitySermonPublicationConformance');
const {
  buildSermonPublicPassageIndex,
  deriveSermonPublicId,
  parseSermonPublicCatalog,
  parseSermonPublicPassageIndex,
  querySermonPublicPassageIndex,
  serializeSermonPublicCatalog,
  serializeSermonPublicPassageIndex
} = require('../src/services/sermon/SermonPublicProjection');
const {
  parseSermonDocument,
  serializeSermonDocument
} = require('../src/services/sermon/SermonDocument');

const FIXTURE = JSON.parse(fs.readFileSync(path.join(
  __dirname,
  'fixtures',
  'community-sermon-publication-conformance-v1.json'
), 'utf8'));

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function sha256(source) {
  return crypto.createHash('sha256').update(source, 'utf8').digest('hex');
}

function request(overrides = {}) {
  return {
    documentSource: FIXTURE.documentSource,
    publicationState: clone(FIXTURE.publicationState),
    detailSource: FIXTURE.detailSource,
    catalogSource: FIXTURE.catalogSource,
    passageIndexSource: FIXTURE.passageIndexSource,
    ...overrides
  };
}

function expectCode(code, operation, causeCode = undefined) {
  assert.throws(operation, error => {
    assert.equal(
      error instanceof CommunitySermonPublicationConformanceError,
      true
    );
    assert.equal(error.code, code);
    if (causeCode !== undefined) assert.equal(error.details.causeCode, causeCode);
    return true;
  });
}

test('self-contained vector binds exact canonical state and every anonymous artifact', () => {
  assert.equal(FIXTURE.schemaVersion, 1);
  assert.equal(
    FIXTURE.kind,
    'syncshow-community-sermon-publication-conformance'
  );
  assert.equal(Object.hasOwn(FIXTURE, 'sourceFixture'), false);

  const document = parseSermonDocument(FIXTURE.documentSource);
  assert.equal(serializeSermonDocument(document), FIXTURE.documentSource);
  assert.equal(sha256(FIXTURE.documentSource), FIXTURE.publicationState.publicRevision);
  assert.equal(document.id, FIXTURE.publicationState.syncId);
  assert.equal(
    document.publication.publishedAt,
    FIXTURE.publicationState.publishedAt
  );
  assert.equal(sha256(FIXTURE.detailSource), FIXTURE.publicationState.detailChecksum);
  assert.equal(sha256(FIXTURE.catalogSource), FIXTURE.publicationState.catalogChecksum);
  assert.equal(
    sha256(FIXTURE.passageIndexSource),
    FIXTURE.publicationState.passageIndexChecksum
  );

  const verified = verifyCommunitySermonPublicationConformance(request());
  assert.equal(verified.detail.sermonId, FIXTURE.publicationState.syncId);
  assert.equal(verified.detail.publicId, FIXTURE.publicationState.publicId);
  assert.equal(
    verified.catalogItem.sermonRevision,
    FIXTURE.publicationState.publicRevision
  );
  assert.equal(
    verified.passageIndexItem.sermonRevision,
    FIXTURE.publicationState.publicRevision
  );
  assert.equal(verified.catalogItem.checksum, FIXTURE.publicationState.detailChecksum);
  assert.equal(
    verified.passageIndexItem.checksum,
    FIXTURE.publicationState.detailChecksum
  );
  assert.equal(Object.isFrozen(verified), true);
  assert.equal(Object.isFrozen(verified.publicationState.selectedBodyEntryIds), true);
  assert.equal(Object.isFrozen(verified.passageIndexItem.references[0].range), true);

  const publicSources = [
    FIXTURE.detailSource,
    FIXTURE.catalogSource,
    FIXTURE.passageIndexSource
  ].join('\n');
  for (const privateValue of [
    'private-pastor-manuscript.docx',
    'private-message-id',
    'Private inbox identity',
    'private-body-en',
    'private-audio-id',
    'private-pending-notes-id'
  ]) {
    assert.equal(publicSources.includes(privateValue), false, privateValue);
  }
});

test('the vector locks representative primary, mentioned, and excluded queries', () => {
  const verified = verifyCommunitySermonPublicationConformance(request());
  assert.deepEqual(
    FIXTURE.queries.map(query => query.id),
    ['primary-overlap', 'mentioned-only', 'suggested-excluded']
  );
  for (const query of FIXTURE.queries) {
    assert.deepEqual(
      querySermonPublicPassageIndex(verified.passageIndex, query.range),
      query.expected,
      query.id
    );
  }
  assert.equal(FIXTURE.queries[0].expected.primary.length, 1);
  assert.equal(FIXTURE.queries[0].expected.mentioned.length, 0);
  assert.equal(FIXTURE.queries[1].expected.primary.length, 0);
  assert.equal(FIXTURE.queries[1].expected.mentioned.length, 1);
  assert.deepEqual(
    FIXTURE.queries[2].expected,
    { primary: [], mentioned: [] }
  );
});

test('a newer private current revision does not change the exact older public receipt', () => {
  const publicationState = {
    ...clone(FIXTURE.publicationState),
    currentRevision: 'f'.repeat(64),
    syncVersion: FIXTURE.publicationState.syncVersion + 1,
    publishedAt: '2026-07-26T13:00:00.000-07:00'
  };
  const verified = verifyCommunitySermonPublicationConformance(request({
    publicationState
  }));
  assert.notEqual(
    verified.publicationState.currentRevision,
    verified.publicationState.publicRevision
  );
  assert.equal(
    verified.publicationState.publishedAt,
    FIXTURE.publicationState.publishedAt
  );
});

test('withdrawn state, request smuggling, identity, revision, and time drift fail closed', () => {
  const withdrawn = {
    ...clone(FIXTURE.publicationState),
    publicationVersion: 2,
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
    'INACTIVE_PUBLICATION_CONFORMANCE',
    () => verifyCommunitySermonPublicationConformance(request({
      publicationState: withdrawn
    }))
  );
  expectCode(
    'INVALID_PUBLICATION_CONFORMANCE_REQUEST',
    () => verifyCommunitySermonPublicationConformance({
      ...request(),
      managerAuthorization: true
    })
  );
  expectCode(
    'INVALID_PUBLICATION_CONFORMANCE_REQUEST',
    () => verifyCommunitySermonPublicationConformance(new Date())
  );

  const differentId = 'Golden:Sermon:Different';
  expectCode(
    'PUBLICATION_CONFORMANCE_ID_MISMATCH',
    () => verifyCommunitySermonPublicationConformance(request({
      publicationState: {
        ...clone(FIXTURE.publicationState),
        syncId: differentId,
        publicId: deriveSermonPublicId(differentId)
      }
    }))
  );
  expectCode(
    'INVALID_PUBLICATION_CONFORMANCE_SOURCE',
    () => verifyCommunitySermonPublicationConformance(request({
      publicationState: {
        ...clone(FIXTURE.publicationState),
        publicRevision: 'f'.repeat(64)
      }
    })),
    'PUBLIC_REVISION_MISMATCH'
  );
  expectCode(
    'PUBLICATION_CONFORMANCE_TIME_MISMATCH',
    () => verifyCommunitySermonPublicationConformance(request({
      publicationState: {
        ...clone(FIXTURE.publicationState),
        publishedAt: '2026-07-26T20:00:01.000Z'
      }
    }))
  );
});

test('selection IDs must retain canonical document order', () => {
  expectCode(
    'PUBLICATION_CONFORMANCE_SELECTION_ORDER_MISMATCH',
    () => verifyCommunitySermonPublicationConformance(request({
      publicationState: {
        ...clone(FIXTURE.publicationState),
        selectedBodyEntryIds: ['private-body-ru', 'private-body-en']
      }
    }))
  );
});

test('detail bytes and receipt checksum are exact', () => {
  expectCode(
    'INVALID_PUBLICATION_CONFORMANCE_DETAIL',
    () => verifyCommunitySermonPublicationConformance(request({
      detailSource: `${FIXTURE.detailSource}\n`
    })),
    'NONCANONICAL_PUBLIC_DETAIL_SOURCE'
  );
  expectCode(
    'PUBLICATION_CONFORMANCE_DETAIL_CHECKSUM_MISMATCH',
    () => verifyCommunitySermonPublicationConformance(request({
      publicationState: {
        ...clone(FIXTURE.publicationState),
        detailChecksum: 'f'.repeat(64)
      }
    }))
  );
});

test('catalog validation precedes hashing and binds the target row to detail bytes', () => {
  expectCode(
    'INVALID_PUBLICATION_CONFORMANCE_CATALOG',
    () => verifyCommunitySermonPublicationConformance(request({
      catalogSource: `${FIXTURE.catalogSource}\n`,
      publicationState: {
        ...clone(FIXTURE.publicationState),
        catalogChecksum: 'f'.repeat(64)
      }
    })),
    'NONCANONICAL_PUBLIC_CATALOG_SOURCE'
  );
  expectCode(
    'PUBLICATION_CONFORMANCE_CATALOG_CHECKSUM_MISMATCH',
    () => verifyCommunitySermonPublicationConformance(request({
      publicationState: {
        ...clone(FIXTURE.publicationState),
        catalogChecksum: 'f'.repeat(64)
      }
    }))
  );

  const driftedCatalog = clone(parseSermonPublicCatalog(FIXTURE.catalogSource));
  driftedCatalog.items[0].speaker.name = 'Different speaker';
  const driftedCatalogSource = serializeSermonPublicCatalog(driftedCatalog);
  expectCode(
    'PUBLICATION_CONFORMANCE_CATALOG_DETAIL_MISMATCH',
    () => verifyCommunitySermonPublicationConformance(request({
      catalogSource: driftedCatalogSource,
      publicationState: {
        ...clone(FIXTURE.publicationState),
        catalogChecksum: sha256(driftedCatalogSource)
      }
    })),
    'PUBLIC_CATALOG_DETAIL_MISMATCH'
  );

  const emptyCatalogSource = serializeSermonPublicCatalog({
    schemaVersion: 2,
    contentType: 'sermons',
    items: []
  });
  expectCode(
    'PUBLICATION_CONFORMANCE_CATALOG_ITEM_MISSING',
    () => verifyCommunitySermonPublicationConformance(request({
      catalogSource: emptyCatalogSource,
      publicationState: {
        ...clone(FIXTURE.publicationState),
        catalogChecksum: sha256(emptyCatalogSource)
      }
    }))
  );
});

test('passage index validation precedes hashing and covers the full catalog snapshot', () => {
  expectCode(
    'INVALID_PUBLICATION_CONFORMANCE_PASSAGE_INDEX',
    () => verifyCommunitySermonPublicationConformance(request({
      passageIndexSource: `${FIXTURE.passageIndexSource}\n`,
      publicationState: {
        ...clone(FIXTURE.publicationState),
        passageIndexChecksum: 'f'.repeat(64)
      }
    })),
    'NONCANONICAL_PUBLIC_PASSAGE_INDEX_SOURCE'
  );
  expectCode(
    'PUBLICATION_CONFORMANCE_PASSAGE_INDEX_CHECKSUM_MISMATCH',
    () => verifyCommunitySermonPublicationConformance(request({
      publicationState: {
        ...clone(FIXTURE.publicationState),
        passageIndexChecksum: 'f'.repeat(64)
      }
    }))
  );

  const expandedCatalog = clone(parseSermonPublicCatalog(FIXTURE.catalogSource));
  const unrelatedItem = clone(expandedCatalog.items[0]);
  unrelatedItem.sermonId = 'Golden:Sermon:Unrelated';
  unrelatedItem.id = deriveSermonPublicId(unrelatedItem.sermonId);
  unrelatedItem.sermonRevision = 'a'.repeat(64);
  unrelatedItem.checksum = 'b'.repeat(64);
  unrelatedItem.title = 'An unrelated public sermon';
  unrelatedItem.titles.en = unrelatedItem.title;
  unrelatedItem.serviceDate = '2026-07-20';
  unrelatedItem.content.url = `/content/sermons/${unrelatedItem.id}`;
  expandedCatalog.items.push(unrelatedItem);

  const expandedCatalogSource = serializeSermonPublicCatalog(expandedCatalog);
  const expandedIndexSource = serializeSermonPublicPassageIndex(
    buildSermonPublicPassageIndex(expandedCatalog)
  );
  const expandedState = {
    ...clone(FIXTURE.publicationState),
    catalogChecksum: sha256(expandedCatalogSource),
    passageIndexChecksum: sha256(expandedIndexSource)
  };
  const expanded = verifyCommunitySermonPublicationConformance(request({
    publicationState: expandedState,
    catalogSource: expandedCatalogSource,
    passageIndexSource: expandedIndexSource
  }));
  assert.equal(expanded.catalog.items.length, 2);
  assert.equal(expanded.passageIndex.items.length, 2);

  const driftedIndex = clone(parseSermonPublicPassageIndex(
    expandedIndexSource
  ));
  driftedIndex.items.find(item =>
    item.publicId === unrelatedItem.id
  ).title = 'Stale unrelated index title';
  const driftedIndexSource = serializeSermonPublicPassageIndex(driftedIndex);
  expectCode(
    'PUBLICATION_CONFORMANCE_PASSAGE_INDEX_MISMATCH',
    () => verifyCommunitySermonPublicationConformance(request({
      catalogSource: expandedCatalogSource,
      passageIndexSource: driftedIndexSource,
      publicationState: {
        ...expandedState,
        passageIndexChecksum: sha256(driftedIndexSource)
      }
    }))
  );
});

test('the Community barrel exposes verification but no publication authority', () => {
  const api = require('../src/services/community');
  const source = fs.readFileSync(path.join(
    __dirname,
    '..',
    'src',
    'services',
    'community',
    'CommunitySermonPublicationConformance.js'
  ), 'utf8');
  assert.equal(
    api.verifyCommunitySermonPublicationConformance,
    verifyCommunitySermonPublicationConformance
  );
  assert.equal(api.publishCommunitySermon, undefined);
  assert.equal(api.withdrawCommunitySermon, undefined);
  assert.deepEqual(
    Object.keys(require('../src/services/community/CommunitySermonPublicationConformance'))
      .sort(),
    [
      'CommunitySermonPublicationConformanceError',
      'verifyCommunitySermonPublicationConformance'
    ]
  );
  assert.doesNotMatch(
    source,
    /\b(?:fetch|ipcMain|ipcRenderer|CommunityClient|writeFile|createWriteStream)\b/
  );
});
