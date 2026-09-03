'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  COMMUNITY_SERVICE_PLAN_SCHEMA_VERSION,
  LEGACY_COMMUNITY_SERVICE_PLAN_SCHEMA_VERSION,
  LOCAL_SERVICE_PLAN_SCHEMA_VERSION,
  SERVICE_PLAN_SCHEMA_VERSION,
  ServiceProjectError,
  addGroupItem,
  addProjectItem,
  addSongResource,
  attachCommunityServicePlanning,
  attachLocalServicePlanning,
  bindCommunityServicePlanBaseline,
  createServiceProject,
  normalizeServiceProject,
  parseSongDocument,
  planNextServiceProject,
  removeProjectItemAndDescendants,
  replaceSongItem,
  serializeServiceProject,
  setServicePlanStatus,
  updateGroupItem,
  updateProjectItemTiming,
  updateServicePlanningDetails
} = require('../src/services/project');
const {
  communityServicePlanBaselineFromProject,
  communityServicePlanItemStateSha256,
  deterministicCommunityItemId
} = require('../src/services/community/CommunityServicePlanBaseline');
const {
  buildCommunityServicePlanReconciliation
} = require('../src/services/community/CommunityServicePlanReconciliation');

const NOW = '2026-07-30T16:00:00.000Z';
const NEXT_NOW = '2026-08-03T16:00:00.000Z';

function expectProjectCode(code, callback) {
  assert.throws(callback, error => {
    assert.ok(error instanceof ServiceProjectError);
    assert.equal(error.code, code);
    return true;
  });
}

function freshProject(id = 'serving-integration') {
  return createServiceProject({
    id,
    title: 'Serving Integration',
    serviceDate: '2026-08-02',
    profileId: 'main-sanctuary',
    now: NOW,
    channels: [
      { id: 'primary', label: 'Main', language: 'en' }
    ]
  });
}

function servingAssignment({
  id = 'slides',
  role = 'Slides',
  personName = 'Maria S.',
  itemId = null,
  status = 'assigned',
  required = true,
  callTime = '09:15',
  note = ''
} = {}) {
  return {
    id,
    role,
    personName,
    scope: itemId === null
      ? { kind: 'service', itemId: null }
      : { kind: 'item', itemId },
    status,
    required,
    callTime,
    note
  };
}

function servingPlan(assignments) {
  return {
    schemaVersion: 1,
    assignments
  };
}

function addSection(project, id, options = {}) {
  return addGroupItem(project, {
    id,
    title: options.title || id,
    groupKind: options.groupKind || 'section',
    parentId: options.parentId,
    plannedDurationSeconds: options.plannedDurationSeconds,
    now: NOW
  });
}

function saved(project) {
  const raw = JSON.parse(serializeServiceProject(project));
  raw.revision = Math.max(1, raw.revision);
  return normalizeServiceProject(raw, { now: NOW });
}

function schemaOneProject() {
  const source = saved(addSection(
    freshProject('serving-template'),
    'template-section'
  ));
  return planNextServiceProject(source, {
    id: 'serving-schema-one',
    title: 'Serving schema one',
    serviceDate: '2026-08-09',
    startTime: '10:00',
    now: NEXT_NOW
  });
}

function schemaTwoProject() {
  const itemId = deterministicCommunityItemId('opening');
  let project = addSection(
    freshProject('serving-community'),
    itemId,
    { title: 'Opening' }
  );
  project = attachCommunityServicePlanning(project, {
    serverId: 'wotbc-community',
    planId: 'service-2026-08-02',
    planRevision: 'a'.repeat(64),
    importedAt: NOW,
    startTime: '10:00',
    teamNotes: ''
  });
  return { project, itemId };
}

function schemaThreeProject() {
  const entry = {
    id: 'opening',
    kind: 'section',
    title: 'Opening'
  };
  const legacy = schemaTwoProject();
  return {
    project: bindCommunityServicePlanBaseline(
      legacy.project,
      communityServicePlanBaselineFromProject(
        legacy.project,
        [entry]
      )
    ),
    itemId: legacy.itemId,
    entries: [entry]
  };
}

function schemaFourProject() {
  const itemId = 'local-opening';
  const project = attachLocalServicePlanning(
    addSection(freshProject('serving-local'), itemId, {
      title: 'Opening'
    }),
    {
      startTime: '10:00',
      teamNotes: ''
    }
  );
  return { project, itemId };
}

function songDocument(id, title) {
  return parseSongDocument([
    '---',
    `id: ${id}`,
    `title: ${title}`,
    'language: en',
    '---',
    '^1',
    `${title} first verse`
  ].join('\n'));
}

function addSong(project, {
  itemId,
  documentId,
  title,
  plannedDurationSeconds
}) {
  const pinned = addSongResource(
    project,
    songDocument(documentId, title),
    {
      provider: 'local',
      itemId: documentId,
      revision: `${documentId}-revision`
    }
  );
  return {
    project: addProjectItem(pinned.project, {
      id: itemId,
      kind: 'song',
      title,
      primaryChannelId: 'primary',
      variants: {
        primary: {
          mode: 'content',
          resourceId: pinned.resourceId
        }
      },
      arrangement: [{
        id: `arr-${itemId}-verse-one`,
        sectionId: 'verse-1'
      }],
      titlePresetId: 'song-title',
      lyricsPresetId: 'song-lyrics',
      operatorNotes: '',
      plannedDurationSeconds
    }, { now: NOW }),
    resourceId: pinned.resourceId
  };
}

test('planning serving round-trips strictly through schemas 1, 2, 3, and 4', () => {
  const schemaOne = schemaOneProject();
  const schemaTwo = schemaTwoProject();
  const schemaThree = schemaThreeProject();
  const schemaFour = schemaFourProject();
  const cases = [
    {
      project: schemaOne,
      itemId: 'template-section',
      schemaVersion: SERVICE_PLAN_SCHEMA_VERSION
    },
    {
      ...schemaTwo,
      schemaVersion: LEGACY_COMMUNITY_SERVICE_PLAN_SCHEMA_VERSION
    },
    {
      ...schemaThree,
      schemaVersion: COMMUNITY_SERVICE_PLAN_SCHEMA_VERSION
    },
    {
      ...schemaFour,
      schemaVersion: LOCAL_SERVICE_PLAN_SCHEMA_VERSION
    }
  ];

  for (const candidate of cases) {
    const serving = servingPlan([
      servingAssignment(),
      servingAssignment({
        id: 'item-reader',
        role: 'Reader',
        personName: 'Oleh K.',
        itemId: candidate.itemId,
        status: 'confirmed',
        required: false,
        callTime: null
      })
    ]);
    const updated = updateServicePlanningDetails(
      candidate.project,
      { serving }
    );
    const serialized = serializeServiceProject(updated);
    const roundTripped = normalizeServiceProject(
      JSON.parse(serialized),
      { now: NOW }
    );

    assert.equal(roundTripped.planning.schemaVersion, candidate.schemaVersion);
    assert.deepEqual(roundTripped.planning.serving, serving);
    assert.equal(serializeServiceProject(roundTripped), serialized);

    const unsupported = JSON.parse(serialized);
    unsupported.planning.serving.directory = [];
    expectProjectCode(
      'INVALID_SERVICE_PROJECT_SERVING_FIELDS',
      () => normalizeServiceProject(unsupported, { now: NOW })
    );
  }
});

test('serving detail edits are immutable no-ops when equal and retain Ready', () => {
  const local = schemaFourProject();
  const ready = setServicePlanStatus(local.project, 'ready');
  const before = serializeServiceProject(ready);
  const serving = servingPlan([
    servingAssignment(),
    servingAssignment({
      id: 'opening-reader',
      role: 'Reader',
      personName: 'Oleh K.',
      itemId: local.itemId,
      status: 'confirmed',
      required: false,
      callTime: null
    })
  ]);

  const assigned = updateServicePlanningDetails(ready, { serving });
  assert.equal(serializeServiceProject(ready), before);
  assert.equal(assigned.planning.status, 'ready');
  assert.deepEqual(assigned.planning.serving, serving);

  const assignedBytes = serializeServiceProject(assigned);
  const noOp = updateServicePlanningDetails(assigned, {
    serving: structuredClone(assigned.planning.serving)
  });
  assert.equal(serializeServiceProject(noOp), assignedBytes);
  assert.equal(noOp.planning.status, 'ready');

  const changed = updateServicePlanningDetails(assigned, {
    serving: servingPlan([
      servingAssignment({
        personName: 'Nadia S.',
        status: 'confirmed'
      })
    ])
  });
  assert.equal(changed.planning.status, 'ready');
  assert.equal(
    changed.planning.serving.assignments[0].personName,
    'Nadia S.'
  );

  expectProjectCode(
    'UNKNOWN_SERVICE_PROJECT_SERVING_ITEM',
    () => updateServicePlanningDetails(assigned, {
      serving: servingPlan([
        servingAssignment({
          itemId: 'missing-item'
        })
      ])
    })
  );
});

test('Plan Next clears prior people while retaining reusable item durations', () => {
  const local = schemaFourProject();
  let source = updateProjectItemTiming(local.project, {
    itemId: local.itemId,
    plannedDurationSeconds: 900,
    now: NOW
  });
  source = updateServicePlanningDetails(source, {
    serving: servingPlan([
      servingAssignment(),
      servingAssignment({
        id: 'opening-reader',
        role: 'Reader',
        personName: 'Oleh K.',
        itemId: local.itemId,
        status: 'confirmed',
        required: false,
        callTime: null
      })
    ])
  });

  const next = planNextServiceProject(saved(source), {
    id: 'serving-next-service',
    title: 'Next service',
    serviceDate: '2026-08-09',
    startTime: '10:00',
    now: NEXT_NOW
  });

  assert.equal(next.planning.serving, undefined);
  assert.equal(next.items[local.itemId].plannedDurationSeconds, 900);
  assert.equal(serializeServiceProject(next).includes('Maria S.'), false);
  assert.equal(serializeServiceProject(next).includes('Oleh K.'), false);
});

test('subtree removal prunes only assignments scoped inside that subtree', () => {
  let project = freshProject('serving-remove-subtree');
  project = addSection(project, 'sermon', {
    title: 'Sermon',
    groupKind: 'sermon',
    plannedDurationSeconds: 1800
  });
  project = addSection(project, 'sermon-point', {
    title: 'Sermon point',
    groupKind: 'point',
    parentId: 'sermon'
  });
  project = addSection(project, 'closing', {
    title: 'Closing',
    plannedDurationSeconds: 300
  });
  project = attachLocalServicePlanning(project, {
    startTime: '10:00',
    teamNotes: ''
  });
  project = updateServicePlanningDetails(project, {
    serving: servingPlan([
      servingAssignment({ id: 'service-slides' }),
      servingAssignment({
        id: 'preacher',
        role: 'Preacher',
        itemId: 'sermon'
      }),
      servingAssignment({
        id: 'point-reader',
        role: 'Point reader',
        itemId: 'sermon-point'
      }),
      servingAssignment({
        id: 'closing-reader',
        role: 'Closing reader',
        itemId: 'closing'
      })
    ])
  });

  const removed = removeProjectItemAndDescendants(project, 'sermon');

  assert.equal(removed.items.sermon, undefined);
  assert.equal(removed.items['sermon-point'], undefined);
  assert.deepEqual(
    removed.planning.serving.assignments.map(assignment => assignment.id),
    ['service-slides', 'closing-reader']
  );
  assert.equal(
    removed.planning.serving.assignments[1].scope.itemId,
    'closing'
  );
});

test('song replacement rebinds item serving scope and preserves duration', () => {
  const originalSong = addSong(
    freshProject('serving-song-replacement'),
    {
      itemId: 'old-song',
      documentId: 'old-hymn',
      title: 'Old Hymn',
      plannedDurationSeconds: 240
    }
  );
  let project = attachLocalServicePlanning(originalSong.project, {
    startTime: '10:00',
    teamNotes: ''
  });
  project = updateServicePlanningDetails(project, {
    serving: servingPlan([
      servingAssignment({ id: 'service-slides' }),
      servingAssignment({
        id: 'song-leader',
        role: 'Song leader',
        itemId: 'old-song'
      })
    ])
  });
  const replacement = addSongResource(
    project,
    songDocument('new-hymn', 'New Hymn'),
    {
      provider: 'local',
      itemId: 'new-hymn',
      revision: 'new-hymn-revision'
    }
  );

  const replaced = replaceSongItem(replacement.project, 'old-song', {
    id: 'new-song',
    kind: 'song',
    title: 'New Hymn',
    primaryChannelId: 'primary',
    variants: {
      primary: {
        mode: 'content',
        resourceId: replacement.resourceId
      }
    },
    arrangement: [{
      id: 'arr-new-song-verse-one',
      sectionId: 'verse-1'
    }],
    titlePresetId: 'song-title',
    lyricsPresetId: 'song-lyrics',
    operatorNotes: ''
  }, { now: NEXT_NOW });

  assert.equal(replaced.items['new-song'].plannedDurationSeconds, 240);
  assert.deepEqual(
    replaced.planning.serving.assignments.map(assignment =>
      assignment.scope),
    [
      { kind: 'service', itemId: null },
      { kind: 'item', itemId: 'new-song' }
    ]
  );
});

test('Community reconciliation preserves local timing and valid serving scopes without a false conflict', () => {
  const entries = [{
    id: 'opening',
    kind: 'section',
    title: 'Opening'
  }, {
    id: 'closing',
    kind: 'section',
    title: 'Closing'
  }];
  const openingId = deterministicCommunityItemId('opening');
  const closingId = deterministicCommunityItemId('closing');
  let baselineProject = freshProject('serving-community-reconciliation');
  baselineProject = addSection(baselineProject, openingId, {
    title: 'Opening'
  });
  baselineProject = addSection(baselineProject, closingId, {
    title: 'Closing'
  });
  baselineProject = attachCommunityServicePlanning(baselineProject, {
    serverId: 'wotbc-community',
    planId: 'service-2026-08-02',
    planRevision: 'b'.repeat(64),
    importedAt: NOW,
    startTime: '10:00',
    teamNotes: ''
  });
  baselineProject = bindCommunityServicePlanBaseline(
    baselineProject,
    communityServicePlanBaselineFromProject(baselineProject, entries)
  );

  let local = updateProjectItemTiming(baselineProject, {
    itemId: openingId,
    plannedDurationSeconds: 600,
    now: NEXT_NOW
  });
  local = updateServicePlanningDetails(local, {
    serving: servingPlan([
      servingAssignment({ id: 'service-slides' }),
      servingAssignment({
        id: 'opening-reader',
        role: 'Opening reader',
        itemId: openingId
      }),
      servingAssignment({
        id: 'closing-reader',
        role: 'Closing reader',
        itemId: closingId
      })
    ])
  });
  assert.equal(
    communityServicePlanItemStateSha256(baselineProject, openingId),
    communityServicePlanItemStateSha256(local, openingId)
  );

  let community = updateGroupItem(baselineProject, {
    itemId: openingId,
    title: 'Community opening',
    now: NEXT_NOW
  });
  community = removeProjectItemAndDescendants(community, closingId);
  const communityRaw = JSON.parse(serializeServiceProject(community));
  communityRaw.planning.schemaVersion =
    LEGACY_COMMUNITY_SERVICE_PLAN_SCHEMA_VERSION;
  communityRaw.planning.source.planRevision = 'c'.repeat(64);
  delete communityRaw.planning.reconciliationBaseline;
  delete communityRaw.planning.lastReconciliationReceipt;
  delete communityRaw.planning.localCollisionBoundaryItemIds;
  community = normalizeServiceProject(communityRaw, { now: NEXT_NOW });
  const communityEntries = [{
    ...entries[0],
    title: 'Community opening'
  }];
  const communityBaseline = communityServicePlanBaselineFromProject(
    community,
    communityEntries
  );
  community = bindCommunityServicePlanBaseline(
    community,
    communityBaseline
  );

  const reconciled = buildCommunityServicePlanReconciliation({
    baseline: baselineProject.planning.reconciliationBaseline,
    localProject: local,
    communityProject: community,
    communityBaseline
  });

  assert.equal(
    reconciled.conflictCount,
    0,
    JSON.stringify(reconciled.conflicts, null, 2)
  );
  assert.equal(
    reconciled.project.items[openingId].plannedDurationSeconds,
    600
  );
  assert.equal(
    reconciled.project.items[openingId].title,
    'Community opening'
  );
  assert.equal(reconciled.project.items[closingId], undefined);
  assert.deepEqual(
    reconciled.project.planning.serving.assignments.map(assignment =>
      assignment.id),
    ['service-slides', 'opening-reader']
  );
  assert.equal(
    reconciled.project.planning.serving.assignments[1].scope.itemId,
    openingId
  );
});
