'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const {
  SERVICE_HANDOFF_KIND,
  SERVICE_HANDOFF_SCHEMA_VERSION,
  ServiceHandoffError,
  addGroupItem,
  addProjectItem,
  analyzeServiceProjectReadiness,
  attachLocalServicePlanning,
  compileServiceProject,
  createServiceProject,
  deriveServiceHandoff,
  normalizeServiceHandoff,
  normalizeServiceProject,
  planNextServiceProject,
  serializeServiceHandoff,
  serializeServiceProject,
  updateServicePlanningDetails
} = require('../src/services/project');

const SOURCE_NOW = '2026-07-27T16:00:00.000Z';
const PLAN_NOW = '2026-07-28T16:00:00.000Z';

function revisionId(project) {
  return crypto
    .createHash('sha256')
    .update(serializeServiceProject(project))
    .digest('hex');
}

function noticeProject(project, operatorNotes = 'Advance after the welcome.') {
  return addProjectItem(project, {
    id: 'welcome',
    kind: 'notice',
    title: 'Welcome',
    textByChannel: Object.fromEntries(
      project.channelIds.map(channelId => [channelId, 'Welcome, church family.'])
    ),
    operatorNotes,
    presetId: 'notice-text',
    plannedDurationSeconds: 300
  }, { now: PLAN_NOW });
}

function exactSources(project) {
  const timeline = compileServiceProject(project);
  const readiness = analyzeServiceProjectReadiness(project, {
    waivers: project.planning?.readinessWaivers || []
  });
  return {
    project,
    revisionId: revisionId(project),
    timeline,
    readiness
  };
}

function unplannedProject() {
  return noticeProject(createServiceProject({
    id: 'legacy-sunday',
    title: 'Legacy Sunday Service',
    serviceDate: '2026-08-02',
    profileId: 'main-sanctuary',
    now: SOURCE_NOW
  }));
}

function plannedProject() {
  const source = createServiceProject({
    id: 'source-sunday',
    title: 'Source Sunday Service',
    serviceDate: '2026-07-26',
    profileId: 'main-sanctuary',
    now: SOURCE_NOW
  });
  const rawSource = JSON.parse(serializeServiceProject(source));
  rawSource.revision = 1;
  const savedSource = normalizeServiceProject(rawSource, { now: SOURCE_NOW });
  const planned = planNextServiceProject(savedSource, {
    id: 'planned-sunday',
    title: 'Planned Sunday Service',
    serviceDate: '2026-08-02',
    startTime: '10:30',
    teamNotes: 'Sound check at 09:45.',
    now: PLAN_NOW
  });
  return updateServicePlanningDetails(noticeProject(
    planned,
    'Wait for the pastor to reach the platform.'
  ), {
    serving: {
      schemaVersion: 1,
      assignments: [
        {
          id: 'assignment-slides',
          role: 'Slides',
          personName: 'Maria S.',
          scope: { kind: 'service', itemId: null },
          status: 'confirmed',
          required: true,
          callTime: '09:15',
          note: 'Check the confidence monitor.'
        },
        {
          id: 'assignment-welcome',
          role: 'Welcome',
          personName: 'Oleh K.',
          scope: { kind: 'item', itemId: 'welcome' },
          status: 'assigned',
          required: false,
          callTime: null,
          note: ''
        }
      ]
    },
    readinessWaivers: [
      {
        checkId: 'song-present',
        reason: 'This prayer service intentionally has no songs.'
      },
      {
        checkId: 'exact-sermon-link',
        reason: 'This prayer service intentionally has no sermon.'
      },
      {
        checkId: 'linked-sermon-material',
        reason: 'No projected sermon material is expected.'
      },
      {
        checkId: 'sermon-reading-before-material',
        reason: 'No sermon reading is expected.'
      }
    ]
  });
}

function firstLocalPlannedProject() {
  const local = attachLocalServicePlanning(createServiceProject({
    id: 'first-local-sunday',
    title: 'First Local Sunday Service',
    serviceDate: '2026-08-02',
    profileId: 'main-sanctuary',
    now: SOURCE_NOW
  }), {
    startTime: '09:00',
    teamNotes: 'First-service sound check at 08:15.'
  });
  return updateServicePlanningDetails(noticeProject(
    local,
    'Wait for the welcome to finish.'
  ), {
    readinessWaivers: [
      {
        checkId: 'song-present',
        reason: 'This prayer service intentionally has no songs.'
      },
      {
        checkId: 'exact-sermon-link',
        reason: 'This prayer service intentionally has no sermon.'
      },
      {
        checkId: 'linked-sermon-material',
        reason: 'No projected sermon material is expected.'
      },
      {
        checkId: 'sermon-reading-before-material',
        reason: 'No sermon reading is expected.'
      }
    ]
  });
}

function expectHandoffCode(code, callback) {
  assert.throws(callback, error => {
    assert.ok(error instanceof ServiceHandoffError);
    assert.equal(error.code, code);
    return true;
  });
}

function legacyHandoffFromV2(rawHandoff) {
  const legacy = structuredClone(rawHandoff);
  legacy.schemaVersion = 1;
  delete legacy.runSheet;
  if (legacy.planning) delete legacy.planning.serving;
  for (const cue of Object.values(legacy.cues)) delete cue.itemPathIds;
  return legacy;
}

test('derives a strict path-free v2 handoff from one exact unplanned project revision', () => {
  const sources = exactSources(unplannedProject());
  const handoff = deriveServiceHandoff(sources);
  const cueId = handoff.cueIds[0];

  assert.equal(handoff.schemaVersion, SERVICE_HANDOFF_SCHEMA_VERSION);
  assert.equal(handoff.kind, SERVICE_HANDOFF_KIND);
  assert.deepEqual(handoff.project, {
    id: 'legacy-sunday',
    revisionId: sources.revisionId,
    revision: sources.project.revision,
    contentHash: sources.timeline.projectContentHash,
    title: 'Legacy Sunday Service',
    serviceDate: '2026-08-02'
  });
  assert.equal(handoff.planning, null);
  assert.equal(handoff.runSheet, null);
  assert.equal(handoff.readiness.ready, false);
  assert.deepEqual(
    handoff.readiness.checks.map(check => [check.id, check.status]),
    sources.readiness.checks.map(check => [check.id, check.status])
  );
  assert.deepEqual(handoff.readiness.waivedCheckIds, []);
  assert.deepEqual(Object.keys(handoff.cues), [cueId]);
  assert.deepEqual(handoff.cues[cueId], {
    id: cueId,
    itemId: 'welcome',
    title: 'Welcome',
    kind: 'notice',
    groupPath: [],
    operatorNotes: 'Advance after the welcome.',
    itemPathIds: ['welcome']
  });
  assert.equal(Object.isFrozen(handoff), true);
  assert.equal(Object.isFrozen(handoff.cues[cueId]), true);
  assert.equal(
    serializeServiceHandoff(JSON.parse(serializeServiceHandoff(handoff))),
    serializeServiceHandoff(handoff)
  );
});

test('carries canonical planning decisions and reviewed readiness waivers', () => {
  const sources = exactSources(plannedProject());
  const handoff = deriveServiceHandoff(sources);

  assert.deepEqual(handoff.planning, {
    status: 'planning',
    startTime: '10:30',
    teamNotes: 'Sound check at 09:45.',
    readinessWaivers: sources.project.planning.readinessWaivers,
    serving: sources.project.planning.serving
  });
  assert.equal(handoff.runSheet.projectId, sources.project.id);
  assert.equal(handoff.runSheet.projectRevision, sources.project.revision);
  assert.equal(handoff.runSheet.serviceDate, sources.project.serviceDate);
  assert.equal(handoff.runSheet.startTime, '10:30');
  assert.equal(handoff.runSheet.totalDurationSeconds, 300);
  assert.deepEqual(
    handoff.runSheet.rows.map(row => row.itemId),
    ['welcome']
  );
  assert.equal(handoff.readiness.ready, true);
  assert.deepEqual(handoff.readiness.waivedCheckIds, [
    'song-present',
    'exact-sermon-link',
    'linked-sermon-material',
    'sermon-reading-before-material'
  ]);
  assert.deepEqual(
    normalizeServiceHandoff(JSON.parse(serializeServiceHandoff(handoff))),
    handoff
  );
});

test('a first local Planning service produces the same path-free volunteer handoff', () => {
  const sources = exactSources(firstLocalPlannedProject());
  const handoff = deriveServiceHandoff(sources);

  assert.deepEqual(handoff.planning, {
    status: 'planning',
    startTime: '09:00',
    teamNotes: 'First-service sound check at 08:15.',
    readinessWaivers: sources.project.planning.readinessWaivers,
    serving: {
      schemaVersion: 1,
      assignments: []
    }
  });
  assert.equal(handoff.runSheet.startTime, '09:00');
  assert.equal(handoff.readiness.ready, true);
  assert.equal(JSON.stringify(handoff).includes('local-created'), false);
  assert.equal(JSON.stringify(handoff).includes('templateSource'), false);
  assert.equal(
    serializeServiceHandoff(normalizeServiceHandoff(
      JSON.parse(serializeServiceHandoff(handoff))
    )),
    serializeServiceHandoff(handoff)
  );
});

test('continues to normalize and serialize strict schema-v1 handoffs canonically', () => {
  const current = deriveServiceHandoff(exactSources(plannedProject()));
  const legacy = legacyHandoffFromV2(current);
  const firstBytes = serializeServiceHandoff(legacy);
  const normalized = normalizeServiceHandoff(JSON.parse(firstBytes));

  assert.equal(normalized.schemaVersion, 1);
  assert.equal(Object.hasOwn(normalized, 'runSheet'), false);
  assert.equal(Object.hasOwn(normalized.planning, 'serving'), false);
  assert.equal(
    Object.hasOwn(normalized.cues[normalized.cueIds[0]], 'itemPathIds'),
    false
  );
  assert.equal(serializeServiceHandoff(normalized), firstBytes);
});

test('derives cue item ancestry and preserves group-scoped serving responsibility', () => {
  let project = attachLocalServicePlanning(createServiceProject({
    id: 'nested-service',
    title: 'Nested Service',
    serviceDate: '2026-08-02',
    profileId: 'main-sanctuary',
    now: SOURCE_NOW
  }), {
    startTime: '10:00',
    teamNotes: ''
  });
  project = addGroupItem(project, {
    id: 'opening',
    title: 'Opening',
    groupKind: 'section',
    plannedDurationSeconds: 600,
    now: PLAN_NOW
  });
  project = addProjectItem(project, {
    id: 'nested-welcome',
    kind: 'notice',
    title: 'Welcome',
    textByChannel: { primary: 'Welcome.' },
    operatorNotes: '',
    presetId: 'notice-text',
    plannedDurationSeconds: 300
  }, {
    parentId: 'opening',
    now: PLAN_NOW
  });
  project = updateServicePlanningDetails(project, {
    serving: {
      schemaVersion: 1,
      assignments: [{
        id: 'assignment-opening-host',
        role: 'Host',
        personName: 'Anna P.',
        scope: { kind: 'item', itemId: 'opening' },
        status: 'confirmed',
        required: true,
        callTime: null,
        note: ''
      }]
    }
  });

  const handoff = deriveServiceHandoff(exactSources(project));
  const cue = handoff.cues[handoff.cueIds[0]];
  assert.deepEqual(cue.groupPath, ['Opening']);
  assert.deepEqual(cue.itemPathIds, ['opening', 'nested-welcome']);
  assert.deepEqual(handoff.planning.serving, project.planning.serving);
  assert.deepEqual(
    handoff.runSheet.rows.map(row => [row.itemId, row.parentItemId]),
    [
      ['opening', null],
      ['nested-welcome', 'opening']
    ]
  );
});

test('rejects unsupported fields and inconsistent readiness summaries', () => {
  const handoff = deriveServiceHandoff(exactSources(plannedProject()));
  const withPath = JSON.parse(serializeServiceHandoff(handoff));
  withPath.project.localPath = '/private/service-project.json';
  expectHandoffCode(
    'INVALID_SERVICE_HANDOFF',
    () => normalizeServiceHandoff(withPath)
  );

  const inconsistent = JSON.parse(serializeServiceHandoff(handoff));
  inconsistent.readiness.waivedCheckIds = [];
  expectHandoffCode(
    'INVALID_SERVICE_HANDOFF',
    () => normalizeServiceHandoff(inconsistent)
  );

  const contactData = JSON.parse(serializeServiceHandoff(handoff));
  contactData.planning.serving.assignments[0].email = 'maria@example.test';
  expectHandoffCode(
    'INVALID_SERVICE_HANDOFF',
    () => normalizeServiceHandoff(contactData)
  );

  const wrongRunSheetRevision = JSON.parse(serializeServiceHandoff(handoff));
  wrongRunSheetRevision.runSheet.projectRevision += 1;
  expectHandoffCode(
    'INVALID_SERVICE_HANDOFF',
    () => normalizeServiceHandoff(wrongRunSheetRevision)
  );

  const wrongItemPath = JSON.parse(serializeServiceHandoff(handoff));
  const cueId = wrongItemPath.cueIds[0];
  wrongItemPath.cues[cueId].itemPathIds[0] = 'other-item';
  expectHandoffCode(
    'INVALID_SERVICE_HANDOFF',
    () => normalizeServiceHandoff(wrongItemPath)
  );
});

test('rejects a mismatched project revision, timeline, or readiness report', () => {
  const sources = exactSources(unplannedProject());
  expectHandoffCode(
    'SERVICE_HANDOFF_SOURCE_MISMATCH',
    () => deriveServiceHandoff({
      ...sources,
      revisionId: '0'.repeat(64)
    })
  );

  const wrongTimeline = {
    ...sources.timeline,
    projectContentHash: '1'.repeat(64)
  };
  expectHandoffCode(
    'SERVICE_HANDOFF_SOURCE_MISMATCH',
    () => deriveServiceHandoff({
      ...sources,
      timeline: wrongTimeline
    })
  );

  const wrongReadiness = {
    ...sources.readiness,
    projectRevision: sources.readiness.projectRevision + 1
  };
  expectHandoffCode(
    'SERVICE_HANDOFF_SOURCE_MISMATCH',
    () => deriveServiceHandoff({
      ...sources,
      readiness: wrongReadiness
    })
  );

  for (const forbidden of [
    { runSheet: null },
    { serving: { schemaVersion: 1, assignments: [] } }
  ]) {
    expectHandoffCode(
      'INVALID_SERVICE_HANDOFF_SOURCE',
      () => deriveServiceHandoff({
        ...sources,
        ...forbidden
      })
    );
  }
});
