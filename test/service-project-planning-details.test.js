'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  MAX_SERVICE_READINESS_WAIVERS,
  SERVICE_READINESS_CHECK_IDS,
  COMMUNITY_SERVICE_PLAN_SCHEMA_VERSION,
  LEGACY_COMMUNITY_SERVICE_PLAN_SCHEMA_VERSION,
  ServiceProjectError,
  addGroupItem,
  analyzeServiceProjectReadiness,
  attachCommunityServicePlanning,
  bindCommunityServicePlanBaseline,
  bindCommunityServicePlanReconciliationReceipt,
  createCommunityServicePlanReconciliationReceipt,
  createServiceProject,
  normalizeServiceProject,
  planNextServiceProject,
  removeProjectItemAndDescendants,
  serializeServiceProject,
  setServicePlanStatus,
  updateServicePlanningDetails
} = require('../src/services/project');
const {
  COMMUNITY_SERVICE_PLAN_BASELINE_SCHEMA_VERSION,
  communityServicePlanBaselineFromProject,
  communityServicePlanItemContentSpecSha256,
  communityServicePlanItemDependentStateSha256,
  communityServicePlanItemRelationshipSha256,
  communityServicePlanItemTitleSha256,
  deriveCommunityServicePlanBaselineWithComponentOverrides,
  normalizeCommunityServicePlanBaseline,
  deterministicCommunityItemId
} = require('../src/services/community/CommunityServicePlanBaseline');
const {
  reconciliationProjectSha256
} = require('../src/services/community/CommunityServicePlanReconciliation');

const SOURCE_NOW = '2026-07-27T16:00:00.000Z';
const PLAN_NOW = '2026-07-28T16:00:00.000Z';

function expectProjectCode(code, callback) {
  assert.throws(callback, error => {
    assert.ok(error instanceof ServiceProjectError);
    assert.equal(error.code, code);
    return true;
  });
}

function savedSource() {
  const source = createServiceProject({
    id: 'source-service',
    title: 'Source Service',
    serviceDate: '2026-07-26',
    profileId: 'main-sanctuary',
    now: SOURCE_NOW,
    channels: [
      { id: 'primary', label: 'Primary', language: 'en' },
      { id: 'secondary', label: 'Secondary', language: 'ru' }
    ]
  });
  const raw = JSON.parse(serializeServiceProject(source));
  raw.revision = 1;
  return normalizeServiceProject(raw, { now: SOURCE_NOW });
}

function plannedService() {
  return planNextServiceProject(savedSource(), {
    id: 'planned-service',
    title: 'Planned Service',
    serviceDate: '2026-08-02',
    startTime: '10:00',
    teamNotes: 'Initial notes',
    now: PLAN_NOW
  });
}

function waiver(checkId, reason = `Human reason for ${checkId}.`) {
  return { checkId, reason };
}

test('legacy planning bytes round-trip unchanged when no readiness waivers exist', () => {
  const project = plannedService();
  const serialized = serializeServiceProject(project);
  const raw = JSON.parse(serialized);

  assert.equal(raw.planning.readinessWaivers, undefined);
  assert.deepEqual(Object.keys(raw.planning), [
    'schemaVersion',
    'startTime',
    'status',
    'teamNotes',
    'templateSource'
  ]);
  assert.equal(
    serializeServiceProject(normalizeServiceProject(raw, { now: PLAN_NOW })),
    serialized
  );
});

test('legacy Community planning v2 remains readable with exact reviewed import provenance', () => {
  const fresh = createServiceProject({
    id: 'community-planned-service',
    title: 'Community Planned Service',
    serviceDate: '2026-08-02',
    profileId: 'main-sanctuary',
    now: PLAN_NOW,
    channels: [
      { id: 'primary', label: 'Primary', language: 'en' }
    ]
  });
  const project = attachCommunityServicePlanning(fresh, {
    serverId: 'wotbc-community',
    planId: 'service-2026-08-02',
    planRevision: 'a'.repeat(64),
    importedAt: PLAN_NOW,
    startTime: '10:30',
    teamNotes: 'Sound check at 09:45.'
  });

  assert.equal(
    project.planning.schemaVersion,
    LEGACY_COMMUNITY_SERVICE_PLAN_SCHEMA_VERSION
  );
  assert.deepEqual(project.planning.source, {
    kind: 'community-plan',
    serverId: 'wotbc-community',
    planId: 'service-2026-08-02',
    planRevision: 'a'.repeat(64),
    importedAt: PLAN_NOW
  });
  assert.equal(Object.hasOwn(project.planning, 'templateSource'), false);
  const serialized = serializeServiceProject(project);
  assert.equal(
    serializeServiceProject(
      normalizeServiceProject(JSON.parse(serialized), { now: PLAN_NOW })
    ),
    serialized
  );
  assert.equal(
    updateServicePlanningDetails(
      setServicePlanStatus(project, 'ready'),
      { startTime: '11:00' }
    ).planning.source.planRevision,
    'a'.repeat(64)
  );

  const raw = JSON.parse(serialized);
  raw.planning.source.filePath = '/private/community-plan.json';
  expectProjectCode(
    'INVALID_SERVICE_PLAN_PROVENANCE',
    () => normalizeServiceProject(raw, { now: PLAN_NOW })
  );
  delete raw.planning.source.filePath;
  raw.planning.source.importedAt = '2026-07-28T16:00:00Z';
  expectProjectCode(
    'INVALID_SERVICE_PLAN_PROVENANCE',
    () => normalizeServiceProject(raw, { now: PLAN_NOW })
  );
});

test('Community planning v3 embeds one exact portable reconciliation baseline', () => {
  const entry = {
    id: 'opening',
    kind: 'section',
    title: 'Opening'
  };
  const itemId = deterministicCommunityItemId(entry.id);
  let project = createServiceProject({
    id: 'community-baseline-service',
    title: 'Community Baseline Service',
    serviceDate: '2026-08-02',
    profileId: 'main-sanctuary',
    now: PLAN_NOW,
    channels: [
      { id: 'primary', label: 'Primary', language: 'en' }
    ]
  });
  project = addGroupItem(project, {
    id: itemId,
    title: entry.title,
    groupKind: 'section',
    now: PLAN_NOW
  });
  project = attachCommunityServicePlanning(project, {
    serverId: 'wotbc-community',
    planId: 'service-2026-08-02',
    planRevision: 'b'.repeat(64),
    importedAt: PLAN_NOW,
    startTime: '10:30',
    teamNotes: ''
  });
  const baseline = communityServicePlanBaselineFromProject(project, [entry]);
  const upgraded = bindCommunityServicePlanBaseline(project, baseline);

  assert.equal(
    baseline.schemaVersion,
    COMMUNITY_SERVICE_PLAN_BASELINE_SCHEMA_VERSION
  );
  assert.equal(baseline.schemaVersion, 2);
  assert.match(baseline.entries[0].contentSpecSha256, /^[a-f0-9]{64}$/);
  assert.match(baseline.entries[0].relationshipSha256, /^[a-f0-9]{64}$/);
  assert.match(baseline.entries[0].dependentStateSha256, /^[a-f0-9]{64}$/);
  assert.match(baseline.entries[0].titleSha256, /^[a-f0-9]{64}$/);
  assert.equal(
    upgraded.planning.schemaVersion,
    COMMUNITY_SERVICE_PLAN_SCHEMA_VERSION
  );
  assert.equal(
    upgraded.planning.reconciliationBaseline.projectionSha256,
    baseline.projectionSha256
  );
  assert.equal(
    serializeServiceProject(
      normalizeServiceProject(
        JSON.parse(serializeServiceProject(upgraded)),
        { now: PLAN_NOW }
      )
    ),
    serializeServiceProject(upgraded)
  );

  const forged = JSON.parse(serializeServiceProject(upgraded));
  forged.planning.reconciliationBaseline.metadata.title = 'Forged';
  expectProjectCode(
    'COMMUNITY_PLAN_BASELINE_HASH_MISMATCH',
    () => normalizeServiceProject(forged, { now: PLAN_NOW })
  );

  const missingComponent = JSON.parse(serializeServiceProject(upgraded));
  delete missingComponent.planning.reconciliationBaseline
    .entries[0].contentSpecSha256;
  expectProjectCode(
    'INVALID_COMMUNITY_PLAN_BASELINE',
    () => normalizeServiceProject(missingComponent, { now: PLAN_NOW })
  );
});

test('subtree removal prunes missing collision boundaries and keeps unrelated live boundaries', () => {
  const entries = [{
    id: 'removed-boundary',
    kind: 'section',
    title: 'Removed boundary'
  }, {
    id: 'nested-boundary',
    kind: 'section',
    title: 'Nested boundary'
  }, {
    id: 'live-boundary',
    kind: 'section',
    title: 'Live boundary'
  }];
  const removedBoundaryId =
    deterministicCommunityItemId('removed-boundary');
  const nestedBoundaryId =
    deterministicCommunityItemId('nested-boundary');
  const liveBoundaryId =
    deterministicCommunityItemId('live-boundary');
  let project = createServiceProject({
    id: 'community-collision-boundary-service',
    title: 'Community Collision Boundary Service',
    serviceDate: '2026-08-02',
    profileId: 'main-sanctuary',
    now: PLAN_NOW,
    channels: [
      { id: 'primary', label: 'Primary', language: 'en' }
    ]
  });
  project = addGroupItem(project, {
    id: removedBoundaryId,
    title: entries[0].title,
    groupKind: 'section',
    now: PLAN_NOW
  });
  project = addGroupItem(project, {
    id: nestedBoundaryId,
    title: entries[1].title,
    groupKind: 'section',
    parentId: removedBoundaryId,
    now: PLAN_NOW
  });
  project = addGroupItem(project, {
    id: liveBoundaryId,
    title: entries[2].title,
    groupKind: 'section',
    now: PLAN_NOW
  });
  project = attachCommunityServicePlanning(project, {
    serverId: 'wotbc-community',
    planId: 'service-2026-08-02',
    planRevision: 'b'.repeat(64),
    importedAt: PLAN_NOW,
    startTime: '10:30',
    teamNotes: ''
  });
  project = bindCommunityServicePlanBaseline(
    project,
    communityServicePlanBaselineFromProject(project, entries)
  );
  const raw = JSON.parse(serializeServiceProject(project));
  raw.planning.localCollisionBoundaryItemIds = [
    removedBoundaryId,
    nestedBoundaryId,
    liveBoundaryId,
    'missing-collision-boundary'
  ];
  const marked = normalizeServiceProject(raw, { now: PLAN_NOW });

  const removed = removeProjectItemAndDescendants(
    marked,
    removedBoundaryId
  );

  assert.equal(removed.items[removedBoundaryId], undefined);
  assert.equal(removed.items[nestedBoundaryId], undefined);
  assert.ok(removed.items[liveBoundaryId]);
  assert.deepEqual(
    removed.planning.localCollisionBoundaryItemIds,
    [liveBoundaryId]
  );
  assert.equal(
    serializeServiceProject(
      normalizeServiceProject(
        JSON.parse(serializeServiceProject(removed)),
        { now: PLAN_NOW }
      )
    ),
    serializeServiceProject(removed)
  );
});

test('Community reconciliation receipts are checksum-bound, schema-bound, and hash-neutral', () => {
  const entry = {
    id: 'receipt-section',
    kind: 'section',
    title: 'Receipt section'
  };
  let project = createServiceProject({
    id: 'community-receipt-service',
    title: 'Community Receipt Service',
    serviceDate: '2026-08-02',
    profileId: 'main-sanctuary',
    now: PLAN_NOW,
    channels: [
      { id: 'primary', label: 'Primary', language: 'en' }
    ]
  });
  project = addGroupItem(project, {
    id: deterministicCommunityItemId(entry.id),
    title: entry.title,
    groupKind: 'section',
    now: PLAN_NOW
  });
  project = attachCommunityServicePlanning(project, {
    serverId: 'wotbc-community',
    planId: 'service-2026-08-02',
    planRevision: 'b'.repeat(64),
    importedAt: PLAN_NOW,
    startTime: '10:30',
    teamNotes: ''
  });
  project = bindCommunityServicePlanBaseline(
    project,
    communityServicePlanBaselineFromProject(project, [entry])
  );
  const beforeReceiptHash = reconciliationProjectSha256(project);
  const receipt = createCommunityServicePlanReconciliationReceipt({
    mode: 'three-way',
    previousPlanRevision: 'a'.repeat(64),
    candidatePlanRevision: project.planning.source.planRevision,
    previousBaselineProjectionSha256: 'c'.repeat(64),
    candidateProjectionSha256:
      project.planning.reconciliationBaseline.projectionSha256,
    mergeResultSha256: beforeReceiptHash,
    previousLocalRevisionId: 'd'.repeat(64),
    conflictCount: 1,
    decisions: [{
      conflictId: 'title-receipt-section',
      choice: 'keep-local'
    }],
    appliedAt: project.planning.source.importedAt
  });
  const bound = bindCommunityServicePlanReconciliationReceipt(
    project,
    receipt
  );
  assert.equal(reconciliationProjectSha256(bound), beforeReceiptHash);
  assert.equal(
    normalizeServiceProject(
      JSON.parse(serializeServiceProject(bound))
    ).planning.lastReconciliationReceipt.receiptSha256,
    receipt.receiptSha256
  );

  const tampered = JSON.parse(serializeServiceProject(bound));
  tampered.planning.lastReconciliationReceipt
    .decisions[0].choice = 'use-community';
  expectProjectCode(
    'COMMUNITY_RECONCILIATION_RECEIPT_HASH_MISMATCH',
    () => normalizeServiceProject(tampered)
  );

  const unsupported = JSON.parse(serializeServiceProject(bound));
  unsupported.planning.lastReconciliationReceipt.unsupported = true;
  expectProjectCode(
    'INVALID_COMMUNITY_RECONCILIATION_RECEIPT',
    () => normalizeServiceProject(unsupported)
  );

  const onLegacyPlanning = JSON.parse(serializeServiceProject(bound));
  onLegacyPlanning.planning.schemaVersion =
    LEGACY_COMMUNITY_SERVICE_PLAN_SCHEMA_VERSION;
  delete onLegacyPlanning.planning.reconciliationBaseline;
  expectProjectCode(
    'INVALID_SERVICE_PLAN',
    () => normalizeServiceProject(onLegacyPlanning)
  );

  const wrongBinding = createCommunityServicePlanReconciliationReceipt({
    ...{
      mode: receipt.mode,
      previousPlanRevision: receipt.previousPlanRevision,
      candidatePlanRevision: 'e'.repeat(64),
      previousBaselineProjectionSha256:
        receipt.previousBaselineProjectionSha256,
      candidateProjectionSha256: receipt.candidateProjectionSha256,
      mergeResultSha256: receipt.mergeResultSha256,
      previousLocalRevisionId: receipt.previousLocalRevisionId,
      conflictCount: receipt.conflictCount,
      decisions: receipt.decisions,
      appliedAt: receipt.appliedAt
    }
  });
  expectProjectCode(
    'COMMUNITY_RECONCILIATION_RECEIPT_BINDING_MISMATCH',
    () => bindCommunityServicePlanReconciliationReceipt(
      project,
      wrongBinding
    )
  );
});

test('Community baseline v2 component hashes isolate native spec, relationship, and dependent state', () => {
  const clone = value => JSON.parse(JSON.stringify(value));
  const songResourceA = 'resource-song-a';
  const songResourceB = 'resource-song-b';
  const sermonResourceA = 'resource-sermon-a';
  const sermonResourceB = 'resource-sermon-b';
  const project = {
    resources: {
      [songResourceA]: { kind: 'song', sha256: '1'.repeat(64) },
      [songResourceB]: { kind: 'song', sha256: '2'.repeat(64) },
      [sermonResourceA]: { kind: 'sermon', sha256: '3'.repeat(64) },
      [sermonResourceB]: { kind: 'sermon', sha256: '4'.repeat(64) }
    },
    assets: {},
    items: {
      song: {
        id: 'song',
        kind: 'song',
        title: 'Grace Alone',
        variants: {
          primary: { mode: 'content', resourceId: songResourceA }
        },
        primaryChannelId: 'primary',
        arrangement: [{ id: 'arrangement-1', sectionId: 'verse-1' }],
        titlePresetId: 'song-title',
        lyricsPresetId: 'song-lyrics',
        operatorNotes: ''
      },
      reading: {
        id: 'reading',
        kind: 'bible',
        title: 'Ephesians 3:14',
        range: {
          bookId: 'Eph',
          start: { chapter: 3, verse: 14 },
          end: { chapter: 3, verse: 14 }
        },
        passagesByChannel: {
          primary: {
            type: 'bible',
            reference: 'Ephesians 3:14',
            translationId: 'BSB',
            attribution: '',
            verses: [{ number: 14, text: 'For this reason I bow my knees.' }],
            contentSha256: '5'.repeat(64)
          }
        },
        presetId: 'scripture-text',
        sermonReading: {
          sermonResourceId: sermonResourceA,
          referenceId: 'primary-eph-3',
          translationId: 'BSB',
          chunkIndex: 0,
          chunkCount: 1
        },
        operatorNotes: ''
      },
      sermon: {
        id: 'sermon',
        kind: 'group',
        title: 'The Prayer',
        groupKind: 'sermon',
        childIds: ['local-sermon-cue'],
        sermonResourceId: sermonResourceA,
        operatorNotes: ''
      }
    }
  };

  const songSpec = communityServicePlanItemContentSpecSha256(project, 'song');
  const songTitle = communityServicePlanItemTitleSha256(project, 'song');
  const songRelationship =
    communityServicePlanItemRelationshipSha256(project, 'song');
  const songDependent =
    communityServicePlanItemDependentStateSha256(project, 'song');
  const songPresentationEdit = clone(project);
  songPresentationEdit.items.song.title = 'Local title';
  songPresentationEdit.items.song.titlePresetId = 'local-title';
  songPresentationEdit.items.song.operatorNotes = 'Local note';
  assert.equal(
    communityServicePlanItemContentSpecSha256(songPresentationEdit, 'song'),
    songSpec
  );
  assert.equal(
    communityServicePlanItemRelationshipSha256(
      songPresentationEdit,
      'song'
    ),
    songRelationship
  );
  assert.equal(
    communityServicePlanItemDependentStateSha256(
      songPresentationEdit,
      'song'
    ),
    songDependent
  );
  assert.notEqual(
    communityServicePlanItemTitleSha256(songPresentationEdit, 'song'),
    songTitle
  );

  const songArrangementEdit = clone(project);
  songArrangementEdit.items.song.arrangement.push({
    id: 'arrangement-2',
    sectionId: 'verse-1'
  });
  assert.equal(
    communityServicePlanItemContentSpecSha256(songArrangementEdit, 'song'),
    songSpec
  );
  assert.notEqual(
    communityServicePlanItemDependentStateSha256(
      songArrangementEdit,
      'song'
    ),
    songDependent
  );

  const songPinEdit = clone(project);
  songPinEdit.items.song.variants.primary.resourceId = songResourceB;
  assert.notEqual(
    communityServicePlanItemContentSpecSha256(songPinEdit, 'song'),
    songSpec
  );
  assert.equal(
    communityServicePlanItemDependentStateSha256(songPinEdit, 'song'),
    songDependent
  );

  const readingSpec =
    communityServicePlanItemContentSpecSha256(project, 'reading');
  const readingRelationship =
    communityServicePlanItemRelationshipSha256(project, 'reading');
  const readingDependent =
    communityServicePlanItemDependentStateSha256(project, 'reading');
  const resolverDrift = clone(project);
  resolverDrift.items.reading.passagesByChannel.primary.verses[0].text =
    'Resolver returned different words.';
  resolverDrift.items.reading.passagesByChannel.primary.contentSha256 =
    '6'.repeat(64);
  assert.equal(
    communityServicePlanItemContentSpecSha256(resolverDrift, 'reading'),
    readingSpec
  );
  assert.equal(
    communityServicePlanItemRelationshipSha256(resolverDrift, 'reading'),
    readingRelationship
  );
  assert.notEqual(
    communityServicePlanItemDependentStateSha256(resolverDrift, 'reading'),
    readingDependent
  );

  const readingRepin = clone(project);
  readingRepin.items.reading.sermonReading.sermonResourceId =
    sermonResourceB;
  assert.equal(
    communityServicePlanItemContentSpecSha256(readingRepin, 'reading'),
    readingSpec
  );
  assert.notEqual(
    communityServicePlanItemRelationshipSha256(readingRepin, 'reading'),
    readingRelationship
  );
  assert.equal(
    communityServicePlanItemDependentStateSha256(readingRepin, 'reading'),
    readingDependent
  );

  const sermonSpec =
    communityServicePlanItemContentSpecSha256(project, 'sermon');
  const sermonChildrenEdit = clone(project);
  sermonChildrenEdit.items.sermon.childIds.push('another-local-cue');
  assert.equal(
    communityServicePlanItemContentSpecSha256(sermonChildrenEdit, 'sermon'),
    sermonSpec
  );
  const sermonRepin = clone(project);
  sermonRepin.items.sermon.sermonResourceId = sermonResourceB;
  assert.notEqual(
    communityServicePlanItemContentSpecSha256(sermonRepin, 'sermon'),
    sermonSpec
  );
});

test('Community baseline component overrides are strict, immutable, and rehash the projection', () => {
  const entry = {
    id: 'opening',
    kind: 'section',
    title: 'Opening'
  };
  const itemId = deterministicCommunityItemId(entry.id);
  let project = createServiceProject({
    id: 'community-baseline-override-service',
    title: 'Community Baseline Override Service',
    serviceDate: '2026-08-02',
    profileId: 'main-sanctuary',
    now: PLAN_NOW,
    channels: [
      { id: 'primary', label: 'Primary', language: 'en' }
    ]
  });
  project = addGroupItem(project, {
    id: itemId,
    title: entry.title,
    groupKind: 'section',
    now: PLAN_NOW
  });
  project = attachCommunityServicePlanning(project, {
    serverId: 'wotbc-community',
    planId: 'service-2026-08-02',
    planRevision: 'c'.repeat(64),
    importedAt: PLAN_NOW,
    startTime: '10:30',
    teamNotes: ''
  });
  const baseline = communityServicePlanBaselineFromProject(project, [entry]);
  const carriedDependentStateSha256 = '9'.repeat(64);
  const derived = deriveCommunityServicePlanBaselineWithComponentOverrides(
    baseline,
    [{
      entryId: entry.id,
      dependentStateSha256: carriedDependentStateSha256
    }]
  );

  assert.notEqual(derived.projectionSha256, baseline.projectionSha256);
  assert.notEqual(
    baseline.entries[0].dependentStateSha256,
    carriedDependentStateSha256
  );
  assert.equal(
    derived.entries[0].dependentStateSha256,
    carriedDependentStateSha256
  );
  assert.equal(
    normalizeCommunityServicePlanBaseline(derived).projectionSha256,
    derived.projectionSha256
  );
  assert.throws(
    () => deriveCommunityServicePlanBaselineWithComponentOverrides(
      baseline,
      [{ entryId: 'unknown', dependentStateSha256: '8'.repeat(64) }]
    ),
    error => error?.code === 'INVALID_COMMUNITY_PLAN_BASELINE'
  );
  assert.throws(
    () => deriveCommunityServicePlanBaselineWithComponentOverrides(
      baseline,
      [{
        entryId: entry.id,
        dependentStateSha256: '8'.repeat(64),
        sourceSha256: '7'.repeat(64)
      }]
    ),
    error => error?.code === 'INVALID_COMMUNITY_PLAN_BASELINE'
  );
});

test('persisted waivers canonicalize in fixed readiness-check order and round-trip', () => {
  const project = updateServicePlanningDetails(plannedService(), {
    readinessWaivers: [
      waiver('channel-visible-content', 'Only the sanctuary output is used.'),
      waiver('song-present', 'This service intentionally has no songs.'),
      waiver('exact-sermon-link', 'This is a prayer service without a sermon.')
    ]
  });

  assert.deepEqual(project.planning.readinessWaivers, [
    waiver('song-present', 'This service intentionally has no songs.'),
    waiver('exact-sermon-link', 'This is a prayer service without a sermon.'),
    waiver('channel-visible-content', 'Only the sanctuary output is used.')
  ]);
  const serialized = serializeServiceProject(project);
  const roundTripped = normalizeServiceProject(
    JSON.parse(serialized),
    { now: PLAN_NOW }
  );
  assert.equal(serializeServiceProject(roundTripped), serialized);
  assert.equal(Object.isFrozen(roundTripped.planning.readinessWaivers), true);
  assert.equal(Object.isFrozen(roundTripped.planning.readinessWaivers[0]), true);

  const readiness = analyzeServiceProjectReadiness(roundTripped, {
    waivers: roundTripped.planning.readinessWaivers
  });
  assert.deepEqual(
    readiness.waivedChecks.map(entry => entry.checkId),
    ['song-present', 'exact-sermon-link', 'channel-visible-content']
  );
});

test('planning detail updates retain exact status and provenance without mutating input', () => {
  const existingWaivers = [
    waiver(
      'sermon-reading-before-material',
      'The special service reads Scripture after the message.'
    )
  ];
  const ready = setServicePlanStatus(
    updateServicePlanningDetails(plannedService(), {
      readinessWaivers: existingWaivers
    }),
    'ready'
  );
  const before = serializeServiceProject(ready);
  const sourceProvenance = ready.planning.templateSource;
  const options = Object.freeze({
    startTime: '18:30',
    teamNotes: 'Doors open at 18:00.',
    readinessWaivers: ready.planning.readinessWaivers
  });

  const updated = updateServicePlanningDetails(ready, options);

  assert.equal(serializeServiceProject(ready), before);
  assert.equal(updated.planning.status, 'ready');
  assert.deepEqual(updated.planning.templateSource, sourceProvenance);
  assert.equal(updated.planning.startTime, '18:30');
  assert.equal(updated.planning.teamNotes, 'Doors open at 18:00.');
  assert.deepEqual(updated.planning.readinessWaivers, options.readinessWaivers);
  assert.equal(updated.updatedAt, ready.updatedAt);
  assert.equal(updated.revision, ready.revision);
  assert.equal(Object.isFrozen(updated), true);
});

test('changing a readiness waiver reopens a Ready service while schedule-only edits do not', () => {
  const ready = setServicePlanStatus(plannedService(), 'ready');
  const changedDecision = updateServicePlanningDetails(ready, {
    readinessWaivers: [
      waiver('song-present', 'This service intentionally has no songs.')
    ]
  });
  assert.equal(changedDecision.planning.status, 'planning');
  assert.deepEqual(changedDecision.planning.readinessWaivers, [
    waiver('song-present', 'This service intentionally has no songs.')
  ]);

  const readyWithWaiver = setServicePlanStatus(changedDecision, 'ready');
  const removedDecision = updateServicePlanningDetails(readyWithWaiver, {
    readinessWaivers: []
  });
  assert.equal(removedDecision.planning.status, 'planning');
  assert.equal(removedDecision.planning.readinessWaivers, undefined);

  const scheduleOnly = updateServicePlanningDetails(readyWithWaiver, {
    startTime: '09:15',
    teamNotes: 'Sound check at 08:45.',
    readinessWaivers: readyWithWaiver.planning.readinessWaivers
  });
  assert.equal(scheduleOnly.planning.status, 'ready');
});

test('no-op detail updates are deterministic and an empty waiver list clears the field', () => {
  const withWaiver = updateServicePlanningDetails(plannedService(), {
    readinessWaivers: [
      waiver('song-present', 'This service intentionally has no songs.')
    ]
  });
  const before = serializeServiceProject(withWaiver);

  assert.equal(
    serializeServiceProject(updateServicePlanningDetails(withWaiver, {})),
    before
  );
  assert.equal(
    serializeServiceProject(updateServicePlanningDetails(withWaiver, {
      startTime: withWaiver.planning.startTime,
      teamNotes: withWaiver.planning.teamNotes,
      readinessWaivers: withWaiver.planning.readinessWaivers
    })),
    before
  );

  const cleared = updateServicePlanningDetails(withWaiver, {
    readinessWaivers: []
  });
  assert.equal(cleared.planning.readinessWaivers, undefined);
  assert.equal(cleared.planning.status, withWaiver.planning.status);
  assert.deepEqual(
    cleared.planning.templateSource,
    withWaiver.planning.templateSource
  );
});

test('every projected-content mutation clears revision-specific waivers', () => {
  const planning = updateServicePlanningDetails(plannedService(), {
    readinessWaivers: [
      waiver('song-present', 'This service intentionally has no songs.')
    ]
  });
  assert.equal(planning.planning.status, 'planning');
  const changedWhilePlanning = addGroupItem(planning, {
    id: 'opening',
    title: 'Opening',
    groupKind: 'section',
    now: PLAN_NOW
  });
  assert.equal(changedWhilePlanning.planning.status, 'planning');
  assert.equal(changedWhilePlanning.planning.readinessWaivers, undefined);

  const ready = setServicePlanStatus(
    updateServicePlanningDetails(plannedService(), {
      readinessWaivers: [
        waiver('song-present', 'This service intentionally has no songs.')
      ]
    }),
    'ready'
  );
  const changedWhileReady = addGroupItem(ready, {
    id: 'closing',
    title: 'Closing',
    groupKind: 'section',
    now: PLAN_NOW
  });
  assert.equal(changedWhileReady.planning.status, 'planning');
  assert.equal(changedWhileReady.planning.readinessWaivers, undefined);
});

test('planning waivers use the readiness analyzer validation contract', () => {
  const project = plannedService();
  assert.equal(MAX_SERVICE_READINESS_WAIVERS, 5);
  assert.deepEqual(SERVICE_READINESS_CHECK_IDS, [
    'compilable-nonempty',
    'song-present',
    'exact-sermon-link',
    'linked-sermon-material',
    'sermon-reading-before-material',
    'channel-visible-content'
  ]);

  const cases = [
    {
      code: 'INVALID_SERVICE_READINESS_WAIVER',
      value: 'song-present'
    },
    {
      code: 'INVALID_SERVICE_READINESS_WAIVER',
      value: [waiver('song-present', '   ')]
    },
    {
      code: 'UNKNOWN_SERVICE_READINESS_WAIVER',
      value: [waiver('unknown-check')]
    },
    {
      code: 'DUPLICATE_SERVICE_READINESS_WAIVER',
      value: [waiver('song-present'), waiver('song-present', 'Another reason.')]
    },
    {
      code: 'UNWAIVABLE_SERVICE_READINESS_CHECK',
      value: [waiver('compilable-nonempty')]
    },
    {
      code: 'TOO_MANY_SERVICE_READINESS_WAIVERS',
      value: Array.from(
        { length: MAX_SERVICE_READINESS_WAIVERS + 1 },
        () => waiver('song-present')
      )
    }
  ];
  for (const { code, value } of cases) {
    expectProjectCode(code, () =>
      updateServicePlanningDetails(project, { readinessWaivers: value }));
  }

  const raw = JSON.parse(serializeServiceProject(project));
  raw.planning.readinessWaivers = [waiver('compilable-nonempty')];
  expectProjectCode('UNWAIVABLE_SERVICE_READINESS_CHECK', () =>
    normalizeServiceProject(raw, { now: PLAN_NOW }));
});

test('planning detail mutation rejects unplanned projects and malformed changes', () => {
  const unplanned = savedSource();
  expectProjectCode('SERVICE_PLAN_REQUIRED', () =>
    updateServicePlanningDetails(unplanned, { startTime: '11:00' }));
  expectProjectCode('INVALID_SERVICE_PLAN_DETAILS', () =>
    updateServicePlanningDetails(plannedService(), []));
  expectProjectCode('INVALID_SERVICE_PLAN_DETAILS', () =>
    updateServicePlanningDetails(plannedService(), { status: 'completed' }));
  expectProjectCode('INVALID_SERVICE_PLAN_START_TIME', () =>
    updateServicePlanningDetails(plannedService(), { startTime: '6:30 PM' }));
  expectProjectCode('TEXT_TOO_LONG', () =>
    updateServicePlanningDetails(plannedService(), {
      teamNotes: 'x'.repeat(4001)
    }));
});
