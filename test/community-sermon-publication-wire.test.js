'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  COMMUNITY_SERMON_PUBLICATION_SCHEMA_VERSION,
  CommunitySermonPublicationWireError,
  MAX_SERMON_PUBLICATION_BODY_SELECTIONS,
  MAX_SERMON_PUBLICATION_ID_BYTES,
  MAX_SERMON_PUBLICATION_MEDIA_SELECTIONS,
  normalizeSermonPublicationIntent,
  normalizeSermonPublicationState,
  normalizeSermonPublishIntent,
  normalizeSermonWithdrawIntent
} = require('../src/services/community/CommunitySermonPublicationWire');
const {
  deriveSermonPublicId
} = require('../src/services/sermon/SermonPublicProjection');

const SYNC_ID = 'sermon-2026-07-26-prayer';
const CURRENT_REVISION = 'a'.repeat(64);
const PUBLIC_REVISION = 'b'.repeat(64);

function publishIntent(overrides = {}) {
  return {
    schemaVersion: COMMUNITY_SERMON_PUBLICATION_SCHEMA_VERSION,
    action: 'publish',
    syncId: SYNC_ID,
    expectedSyncVersion: 7,
    expectedCurrentRevision: CURRENT_REVISION,
    expectedPublicationVersion: 3,
    expectedPublicRevision: PUBLIC_REVISION,
    selectedBodyEntryIds: ['manuscript-opening-en'],
    selectedMediaIds: ['post-service:recording:en'],
    publicAudienceConfirmed: true,
    canonicalLinkConfirmed: true,
    ...overrides
  };
}

function withdrawIntent(overrides = {}) {
  return {
    schemaVersion: COMMUNITY_SERMON_PUBLICATION_SCHEMA_VERSION,
    action: 'withdraw',
    syncId: SYNC_ID,
    expectedSyncVersion: 7,
    expectedCurrentRevision: CURRENT_REVISION,
    expectedPublicationVersion: 3,
    expectedPublicRevision: PUBLIC_REVISION,
    ...overrides
  };
}

function publicationState(overrides = {}) {
  return {
    schemaVersion: COMMUNITY_SERMON_PUBLICATION_SCHEMA_VERSION,
    syncId: SYNC_ID,
    currentRevision: CURRENT_REVISION,
    syncVersion: 7,
    publicationVersion: 3,
    publicRevision: PUBLIC_REVISION,
    publicId: deriveSermonPublicId(SYNC_ID),
    detailChecksum: 'c'.repeat(64),
    catalogChecksum: 'd'.repeat(64),
    passageIndexChecksum: 'e'.repeat(64),
    publishedAt: '2026-07-27T18:30:00.000Z',
    selectedBodyEntryIds: ['manuscript-opening-en'],
    selectedMediaIds: ['post-service:recording:en'],
    ...overrides
  };
}

function unpublishedState(overrides = {}) {
  return publicationState({
    publicationVersion: null,
    publicRevision: null,
    publicId: null,
    detailChecksum: null,
    catalogChecksum: null,
    passageIndexChecksum: null,
    publishedAt: null,
    selectedBodyEntryIds: [],
    selectedMediaIds: [],
    ...overrides
  });
}

function expectCode(code, callback) {
  assert.throws(callback, error => {
    assert.ok(error instanceof CommunitySermonPublicationWireError);
    assert.equal(error.code, code);
    return true;
  });
}

test('publish intents bind the exact current and prior public state with explicit authority', () => {
  const normalized = normalizeSermonPublicationIntent(publishIntent());
  assert.deepEqual(normalized, publishIntent());
  assert.equal(Object.isFrozen(normalized), true);
  assert.equal(Object.isFrozen(normalized.selectedBodyEntryIds), true);
  assert.equal(Object.isFrozen(normalized.selectedMediaIds), true);

  const firstPublication = normalizeSermonPublishIntent(publishIntent({
    expectedPublicationVersion: null,
    expectedPublicRevision: null
  }));
  assert.equal(firstPublication.expectedPublicationVersion, null);
  assert.equal(firstPublication.expectedPublicRevision, null);

  const publishAfterWithdrawal = normalizeSermonPublishIntent(publishIntent({
    expectedPublicationVersion: 4,
    expectedPublicRevision: null
  }));
  assert.equal(publishAfterWithdrawal.expectedPublicationVersion, 4);
  assert.equal(publishAfterWithdrawal.expectedPublicRevision, null);
});

test('publish intents reject authority smuggling, hostile fields, invalid versions, and duplicates', () => {
  for (const overrides of [
    { publicAudienceConfirmed: false },
    { publicAudienceConfirmed: 1 },
    { canonicalLinkConfirmed: false },
    { expectedSyncVersion: 0 },
    { expectedSyncVersion: Number.MAX_SAFE_INTEGER + 1 },
    { expectedCurrentRevision: 'A'.repeat(64) },
    { expectedPublicationVersion: null, expectedPublicRevision: PUBLIC_REVISION },
    { selectedBodyEntryIds: ['opening', 'opening'] },
    { selectedMediaIds: ['audio', 'audio'] },
    { selectedBodyEntryIds: ['bad id'] },
    { schemaVersion: 2 }
  ]) {
    expectCode(
      'INVALID_PUBLICATION_INTENT',
      () => normalizeSermonPublishIntent(publishIntent(overrides))
    );
  }

  expectCode('INVALID_PUBLICATION_INTENT', () =>
    normalizeSermonPublishIntent({
      ...publishIntent(),
      approvedBy: 'renderer-supplied-manager'
    }));
  expectCode('INVALID_PUBLICATION_INTENT', () =>
    normalizeSermonPublishIntent(Object.assign(
      Object.create({ inheritedAuthority: true }),
      publishIntent()
    )));
  expectCode('INVALID_PUBLICATION_INTENT', () =>
    normalizeSermonPublicationIntent({ ...publishIntent(), action: 'replace' }));
});

test('publication selections have independent count and identifier bounds', () => {
  const longestId = `x${'y'.repeat(MAX_SERMON_PUBLICATION_ID_BYTES - 1)}`;
  const bodyIds = Array.from(
    { length: MAX_SERMON_PUBLICATION_BODY_SELECTIONS },
    (_, index) => `body-${index}`
  );
  const mediaIds = Array.from(
    { length: MAX_SERMON_PUBLICATION_MEDIA_SELECTIONS },
    (_, index) => `media-${index}`
  );
  const bounded = normalizeSermonPublishIntent(publishIntent({
    selectedBodyEntryIds: [...bodyIds.slice(0, -1), longestId],
    selectedMediaIds: mediaIds
  }));
  assert.equal(bounded.selectedBodyEntryIds.length, MAX_SERMON_PUBLICATION_BODY_SELECTIONS);
  assert.equal(bounded.selectedMediaIds.length, MAX_SERMON_PUBLICATION_MEDIA_SELECTIONS);

  expectCode('INVALID_PUBLICATION_INTENT', () =>
    normalizeSermonPublishIntent(publishIntent({
      selectedBodyEntryIds: [...bodyIds, 'one-too-many']
    })));
  expectCode('INVALID_PUBLICATION_INTENT', () =>
    normalizeSermonPublishIntent(publishIntent({
      selectedMediaIds: [...mediaIds, 'one-too-many']
    })));
  expectCode('INVALID_PUBLICATION_INTENT', () =>
    normalizeSermonPublishIntent(publishIntent({
      selectedBodyEntryIds: [`x${'y'.repeat(MAX_SERMON_PUBLICATION_ID_BYTES)}`]
    })));
});

test('withdraw intents are a separate exact schema and require an active prior pointer', () => {
  const normalized = normalizeSermonPublicationIntent(withdrawIntent());
  assert.deepEqual(normalized, withdrawIntent());
  assert.equal(Object.isFrozen(normalized), true);

  for (const overrides of [
    { expectedPublicationVersion: null },
    { expectedPublicRevision: null },
    { expectedPublicationVersion: 0 },
    { expectedPublicRevision: 'not-a-revision' },
    { action: 'publish' }
  ]) {
    expectCode(
      'INVALID_PUBLICATION_INTENT',
      () => normalizeSermonWithdrawIntent(withdrawIntent(overrides))
    );
  }

  expectCode('INVALID_PUBLICATION_INTENT', () =>
    normalizeSermonWithdrawIntent({
      ...withdrawIntent(),
      selectedBodyEntryIds: []
    }));
  expectCode('INVALID_PUBLICATION_INTENT', () =>
    normalizeSermonWithdrawIntent({
      ...withdrawIntent(),
      publicAudienceConfirmed: true
    }));
});

test('publication state preserves an older public revision beside a newer current draft', () => {
  const normalized = normalizeSermonPublicationState(publicationState({
    currentRevision: CURRENT_REVISION,
    publicRevision: PUBLIC_REVISION,
    publishedAt: '2026-07-27T11:30:00-07:00'
  }));
  assert.equal(normalized.currentRevision, CURRENT_REVISION);
  assert.equal(normalized.publicRevision, PUBLIC_REVISION);
  assert.notEqual(normalized.currentRevision, normalized.publicRevision);
  assert.equal(normalized.publishedAt, '2026-07-27T18:30:00.000Z');
  assert.equal(normalized.publicId, deriveSermonPublicId(SYNC_ID));
  assert.equal(Object.isFrozen(normalized), true);
  assert.equal(Object.isFrozen(normalized.selectedBodyEntryIds), true);
  assert.equal(Object.isFrozen(normalized.selectedMediaIds), true);
});

test('a published state may deliberately expose metadata and references without body or media', () => {
  const normalized = normalizeSermonPublicationState(publicationState({
    selectedBodyEntryIds: [],
    selectedMediaIds: []
  }));
  assert.equal(normalized.publicRevision, PUBLIC_REVISION);
  assert.deepEqual(normalized.selectedBodyEntryIds, []);
  assert.deepEqual(normalized.selectedMediaIds, []);
});

test('never-published and withdrawn states are distinct without exposing stale projection data', () => {
  const neverPublished = normalizeSermonPublicationState(unpublishedState());
  assert.equal(neverPublished.publicationVersion, null);
  assert.equal(neverPublished.publicRevision, null);

  const withdrawn = normalizeSermonPublicationState(unpublishedState({
    publicationVersion: 4
  }));
  assert.equal(withdrawn.publicationVersion, 4);
  assert.equal(withdrawn.publicRevision, null);
  assert.deepEqual(withdrawn.selectedBodyEntryIds, []);
  assert.deepEqual(withdrawn.selectedMediaIds, []);
});

test('publication state enforces pointer, projection, selection, identity, and time dependencies', () => {
  for (const candidate of [
    publicationState({ publicationVersion: null }),
    publicationState({ publicId: null }),
    publicationState({ publicId: 'sermon-untrusted' }),
    publicationState({ detailChecksum: null }),
    publicationState({ catalogChecksum: null }),
    publicationState({ passageIndexChecksum: null }),
    publicationState({ publishedAt: null }),
    publicationState({ publishedAt: '2026-02-30T12:00:00Z' }),
    publicationState({ selectedBodyEntryIds: ['opening', 'opening'] }),
    publicationState({ publicRevision: 'B'.repeat(64) }),
    unpublishedState({ publicId: deriveSermonPublicId(SYNC_ID) }),
    unpublishedState({ detailChecksum: 'c'.repeat(64) }),
    unpublishedState({ publishedAt: '2026-07-27T18:30:00.000Z' }),
    unpublishedState({ selectedBodyEntryIds: ['private-body'] })
  ]) {
    expectCode(
      'INVALID_PUBLICATION_STATE',
      () => normalizeSermonPublicationState(candidate)
    );
  }

  expectCode('INVALID_PUBLICATION_STATE', () =>
    normalizeSermonPublicationState({
      ...publicationState(),
      privateSourcePath: '/private/sermon.pdf'
    }));
  expectCode('INVALID_PUBLICATION_STATE', () =>
    normalizeSermonPublicationState(new Date()));
});

test('the community barrel exports the isolated publication contract', () => {
  const api = require('../src/services/community');
  assert.equal(
    api.COMMUNITY_SERMON_PUBLICATION_SCHEMA_VERSION,
    COMMUNITY_SERMON_PUBLICATION_SCHEMA_VERSION
  );
  assert.equal(api.normalizeSermonPublicationIntent, normalizeSermonPublicationIntent);
  assert.equal(api.normalizeSermonPublicationState, normalizeSermonPublicationState);
});
