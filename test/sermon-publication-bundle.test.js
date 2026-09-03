'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const {
  serializeSermonDocument
} = require('../src/services/sermon/SermonDocument');
const {
  buildSermonPublicationTransition
} = require('../src/services/sermon/SermonPublicationTransition');
const {
  buildSermonPublicCatalog,
  buildSermonPublicPassageIndex,
  buildSermonPublicProjection,
  parseSermonPublicCatalog,
  parseSermonPublicPassageIndex,
  querySermonPublicPassageIndex,
  SERMON_PUBLIC_CATALOG_PATH,
  SERMON_PUBLIC_CONTENT_BASE_PATH,
  SERMON_PUBLIC_PASSAGE_INDEX_PATH,
  serializeSermonPublicCatalog,
  serializeSermonPublicPassageIndex
} = require('../src/services/sermon/SermonPublicProjection');

const FIXTURES_DIRECTORY = path.join(__dirname, 'fixtures');
const BUNDLE_FIXTURE = readFixture('sermon-publication-bundle-v1.json');
const PROJECTION_FIXTURE = readFixture(BUNDLE_FIXTURE.sourceFixture);
const DYNAMIC_COMMUNITY_ROUTE_PROFILE = {
  id: 'strict-publication-catalog-v1',
  catalogPath: SERMON_PUBLIC_CATALOG_PATH,
  detailPathTemplate: `${SERMON_PUBLIC_CONTENT_BASE_PATH}/{publicId}`,
  passageIndexPath: SERMON_PUBLIC_PASSAGE_INDEX_PATH
};

function readFixture(fileName) {
  return JSON.parse(fs.readFileSync(path.join(FIXTURES_DIRECTORY, fileName), 'utf8'));
}

function sha256(source) {
  return crypto.createHash('sha256').update(source, 'utf8').digest('hex');
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function projectionFromFixture(fixture) {
  const documentSource = serializeSermonDocument(fixture.document);
  return buildSermonPublicProjection({
    documentSource,
    publicRevision: fixture.expectedSermonRevision,
    selectedBodyEntryIds: fixture.selectedBodyEntryIds,
    selectedMediaIds: fixture.selectedMediaIds
  });
}

function publicationArtifacts(projection) {
  const publications = [{
    detailSource: projection.detailSource,
    checksum: projection.checksum
  }];
  const catalog = buildSermonPublicCatalog(publications);
  const passageIndex = buildSermonPublicPassageIndex(catalog, publications);
  return {
    catalog,
    catalogSource: serializeSermonPublicCatalog(catalog),
    passageIndex,
    passageIndexSource: serializeSermonPublicPassageIndex(passageIndex)
  };
}

function assertOneTrailingNewline(source, label) {
  assert.equal(source.endsWith('\n'), true, `${label} must end with a newline`);
  assert.equal(source.endsWith('\n\n'), false, `${label} must have one trailing newline`);
}

function referenceProjection(reference) {
  return {
    role: reference.role,
    range: reference.range
  };
}

test('dynamic-Community publication bundle locks exact canonical artifacts and routes', () => {
  assert.equal(BUNDLE_FIXTURE.schemaVersion, 1);
  assert.equal(BUNDLE_FIXTURE.kind, 'syncshow-sermon-publication-bundle-fixture');
  assert.deepEqual(BUNDLE_FIXTURE.routeProfile, DYNAMIC_COMMUNITY_ROUTE_PROFILE);

  const projection = projectionFromFixture(PROJECTION_FIXTURE);
  const artifacts = publicationArtifacts(projection);

  const readyDocument = clone(PROJECTION_FIXTURE.document);
  readyDocument.publication = {
    ...readyDocument.publication,
    status: 'ready',
    visibility: 'members',
    publishedAt: null
  };
  const transition = buildSermonPublicationTransition({
    documentSource: serializeSermonDocument(readyDocument),
    publishedAt: new Date(
      PROJECTION_FIXTURE.document.publication.publishedAt
    ).toISOString(),
    selectedBodyEntryIds: PROJECTION_FIXTURE.selectedBodyEntryIds,
    selectedMediaIds: PROJECTION_FIXTURE.selectedMediaIds
  });
  assert.equal(
    transition.documentSource,
    serializeSermonDocument(PROJECTION_FIXTURE.document)
  );
  assert.equal(transition.publicRevision, PROJECTION_FIXTURE.expectedSermonRevision);
  assert.equal(transition.projection.detailSource, BUNDLE_FIXTURE.detailSource);
  assert.equal(transition.projection.checksum, BUNDLE_FIXTURE.detailSha256);

  assert.equal(projection.detailSource, BUNDLE_FIXTURE.detailSource);
  assert.equal(artifacts.catalogSource, BUNDLE_FIXTURE.catalogSource);
  assert.equal(artifacts.passageIndexSource, BUNDLE_FIXTURE.passageIndexSource);

  const exactArtifacts = [{
    label: 'detailSource',
    source: projection.detailSource,
    expectedHash: BUNDLE_FIXTURE.detailSha256
  }, {
    label: 'catalogSource',
    source: artifacts.catalogSource,
    expectedHash: BUNDLE_FIXTURE.catalogSha256
  }, {
    label: 'passageIndexSource',
    source: artifacts.passageIndexSource,
    expectedHash: BUNDLE_FIXTURE.passageIndexSha256
  }];
  for (const artifact of exactArtifacts) {
    assertOneTrailingNewline(artifact.source, artifact.label);
    assert.equal(sha256(artifact.source), artifact.expectedHash);
  }
  assert.equal(BUNDLE_FIXTURE.detailSha256, projection.checksum);

  const catalog = parseSermonPublicCatalog(BUNDLE_FIXTURE.catalogSource);
  const passageIndex = parseSermonPublicPassageIndex(
    BUNDLE_FIXTURE.passageIndexSource
  );
  const publicId = projection.detail.publicId;
  const detailPath = BUNDLE_FIXTURE.routeProfile.detailPathTemplate.replace(
    '{publicId}',
    publicId
  );
  assert.equal(catalog.items[0].content.url, detailPath);
  assert.equal(passageIndex.items[0].contentUrl, detailPath);

  const routedArtifacts = new Map([
    [BUNDLE_FIXTURE.routeProfile.catalogPath, BUNDLE_FIXTURE.catalogSource],
    [detailPath, BUNDLE_FIXTURE.detailSource],
    [BUNDLE_FIXTURE.routeProfile.passageIndexPath, BUNDLE_FIXTURE.passageIndexSource]
  ]);
  assert.equal(routedArtifacts.size, 3);
  for (const route of routedArtifacts.keys()) {
    assert.match(route, /^\/[a-z0-9/_{}.-]+$/);
    assert.equal(
      route.endsWith('.json'),
      route === BUNDLE_FIXTURE.routeProfile.catalogPath
    );
    assert.equal(route.endsWith('/'), false);
  }

  const confirmedReferences = PROJECTION_FIXTURE.document.references
    .filter(reference => reference.reviewStatus === 'confirmed')
    .map(referenceProjection);
  assert.equal(
    PROJECTION_FIXTURE.document.references.some(
      reference => reference.reviewStatus === 'suggested'
    ),
    true
  );
  assert.deepEqual(projection.detail.references, confirmedReferences);
  assert.deepEqual(catalog.items[0].references, confirmedReferences);
  assert.deepEqual(passageIndex.items[0].references, confirmedReferences);
  for (const artifact of exactArtifacts) {
    assert.equal(artifact.source.includes('reviewStatus'), false);
    assert.equal(artifact.source.includes('"chapter":1'), false);
  }

  const artifactBookIds = [...new Set(
    passageIndex.items.flatMap(item =>
      item.references.map(reference => reference.range.bookId))
  )].sort();
  assert.deepEqual(artifactBookIds, BUNDLE_FIXTURE.osisBookIds);
  assert.deepEqual(BUNDLE_FIXTURE.osisBookIds, ['Eph']);

  const suggestedRange = PROJECTION_FIXTURE.document.references.find(
    reference => reference.reviewStatus === 'suggested'
  ).range;
  assert.deepEqual(
    querySermonPublicPassageIndex(passageIndex, suggestedRange),
    { primary: [], mentioned: [] }
  );
});

test('passage query gives a primary match precedence over an overlapping mention', () => {
  const document = clone(PROJECTION_FIXTURE.document);
  document.references.splice(document.references.length - 1, 0, {
    id: 'bundle-overlap-confirmed',
    range: {
      schemaVersion: 1,
      bookId: 'Eph',
      start: { chapter: 3, verse: 18 },
      end: { chapter: 3, verse: 18 }
    },
    role: 'mentioned',
    source: 'manuscript',
    reviewStatus: 'confirmed',
    enteredText: 'Ephesians 3:18',
    sourceId: 'private-manuscript-id',
    sectionId: 'private-outline-id',
    startOffset: 200,
    endOffset: 216
  });
  const documentSource = serializeSermonDocument(document);
  const projection = buildSermonPublicProjection({
    documentSource,
    publicRevision: sha256(documentSource),
    selectedBodyEntryIds: PROJECTION_FIXTURE.selectedBodyEntryIds,
    selectedMediaIds: PROJECTION_FIXTURE.selectedMediaIds
  });
  const { passageIndex } = publicationArtifacts(projection);
  const overlapRange = {
    schemaVersion: 1,
    bookId: 'Eph',
    start: { chapter: 3, verse: 18 },
    end: { chapter: 3, verse: 18 }
  };

  assert.equal(
    passageIndex.items[0].references.some(reference =>
      reference.role === 'mentioned'
        && JSON.stringify(reference.range) === JSON.stringify(overlapRange)),
    true
  );
  const result = querySermonPublicPassageIndex(passageIndex, overlapRange);
  assert.equal(result.primary.length, 1);
  assert.equal(result.mentioned.length, 0);
  assert.deepEqual(result.primary[0].matches, [{
    schemaVersion: 1,
    bookId: 'Eph',
    start: { chapter: 3, verse: 14 },
    end: { chapter: 3, verse: 21 }
  }]);
});
