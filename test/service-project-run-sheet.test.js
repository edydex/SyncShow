'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  MAX_PLANNED_ITEM_DURATION_SECONDS,
  SERVICE_RUN_SHEET_KIND,
  SERVICE_RUN_SHEET_SCHEMA_VERSION,
  ServiceProjectError,
  addGroupItem,
  addProjectItem,
  addSongResource,
  attachLocalServicePlanning,
  buildServiceRunSheet,
  compileServiceProject,
  createServiceProject,
  normalizeServiceProject,
  parseSongDocument,
  planNextServiceProject,
  replaceSongItem,
  serializeServiceProject,
  setServicePlanStatus,
  updateProjectItemTiming,
  updateServicePlanningDetails
} = require('../src/services/project');

const NOW = '2026-07-30T16:00:00.000Z';

function expectProjectCode(code, callback) {
  assert.throws(callback, error => {
    assert.ok(error instanceof ServiceProjectError);
    assert.equal(error.code, code);
    return true;
  });
}

function freshProject({
  id = 'timed-service',
  serviceDate = '2026-08-02'
} = {}) {
  return createServiceProject({
    id,
    title: 'Timed Service',
    serviceDate,
    profileId: 'main-sanctuary',
    now: NOW,
    channels: [
      { id: 'primary', label: 'Main', language: 'en' }
    ]
  });
}

function plannedProject({
  id = 'timed-service',
  serviceDate = '2026-08-02',
  startTime = '10:00'
} = {}) {
  return attachLocalServicePlanning(
    freshProject({ id, serviceDate }),
    {
      startTime,
      teamNotes: 'Operator-owned planning notes.'
    }
  );
}

function addNotice(project, {
  id,
  title = id,
  parentId = null,
  plannedDurationSeconds,
  operatorNotes = ''
}) {
  const item = {
    id,
    kind: 'notice',
    title,
    textByChannel: { primary: title },
    presetId: 'notice-text',
    operatorNotes
  };
  if (plannedDurationSeconds !== undefined) {
    item.plannedDurationSeconds = plannedDurationSeconds;
  }
  return addProjectItem(project, item, {
    parentId,
    now: NOW
  });
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
  id,
  documentId,
  title,
  parentId = null,
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
      id,
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
        id: `arr-${id}-verse-one`,
        sectionId: 'verse-1'
      }],
      titlePresetId: 'song-title',
      lyricsPresetId: 'song-lyrics',
      operatorNotes: '',
      ...(plannedDurationSeconds === undefined
        ? {}
        : { plannedDurationSeconds })
    }, {
      parentId,
      now: NOW
    }),
    resourceId: pinned.resourceId
  };
}

test('untimed v1 project bytes remain canonical and explicit zero round-trips', () => {
  const untimed = addNotice(plannedProject(), { id: 'welcome' });
  const untimedBytes = serializeServiceProject(untimed);
  const untimedRaw = JSON.parse(untimedBytes);

  assert.equal(
    Object.hasOwn(untimedRaw.items.welcome, 'plannedDurationSeconds'),
    false
  );
  assert.equal(
    serializeServiceProject(normalizeServiceProject(untimedRaw, { now: NOW })),
    untimedBytes
  );

  untimedRaw.items.welcome.plannedDurationSeconds = 0;
  const zero = normalizeServiceProject(untimedRaw, { now: NOW });
  assert.equal(zero.items.welcome.plannedDurationSeconds, 0);
  assert.equal(
    normalizeServiceProject(
      JSON.parse(serializeServiceProject(zero)),
      { now: NOW }
    ).items.welcome.plannedDurationSeconds,
    0
  );

  for (const invalid of [-1, 1.5, MAX_PLANNED_ITEM_DURATION_SECONDS + 1, null]) {
    const raw = JSON.parse(untimedBytes);
    raw.items.welcome.plannedDurationSeconds = invalid;
    expectProjectCode(
      'INVALID_NUMBER',
      () => normalizeServiceProject(raw, { now: NOW })
    );
  }
});

test('item timing mutation is narrow, immutable, clearable, and lifecycle-neutral', () => {
  let project = addNotice(plannedProject(), { id: 'welcome' });
  project = updateServicePlanningDetails(project, {
    readinessWaivers: [{
      checkId: 'song-present',
      reason: 'This service intentionally contains spoken material only.'
    }]
  });
  project = setServicePlanStatus(project, 'ready');
  const originalBytes = serializeServiceProject(project);
  const originalPlanning = structuredClone(project.planning);
  const originalTimeline = compileServiceProject(project);

  const timed = updateProjectItemTiming(project, {
    itemId: 'welcome',
    plannedDurationSeconds: 900,
    now: '2026-07-30T16:05:00.000Z'
  });
  assert.equal(timed.items.welcome.plannedDurationSeconds, 900);
  assert.equal(
    timed.items.welcome.updatedAt,
    '2026-07-30T16:05:00.000Z'
  );
  assert.deepEqual(timed.planning, originalPlanning);
  assert.equal(serializeServiceProject(project), originalBytes);
  const timedTimeline = compileServiceProject(timed);
  assert.deepEqual(timedTimeline.cueIds, originalTimeline.cueIds);
  assert.deepEqual(timedTimeline.cues, originalTimeline.cues);
  assert.notEqual(
    timedTimeline.projectContentHash,
    originalTimeline.projectContentHash
  );

  const noOp = updateProjectItemTiming(timed, {
    itemId: 'welcome',
    plannedDurationSeconds: 900,
    now: '2026-07-30T16:06:00.000Z'
  });
  assert.equal(serializeServiceProject(noOp), serializeServiceProject(timed));
  assert.equal(
    noOp.items.welcome.updatedAt,
    '2026-07-30T16:05:00.000Z'
  );

  const cleared = updateProjectItemTiming(timed, {
    itemId: 'welcome',
    plannedDurationSeconds: null,
    now: '2026-07-30T16:07:00.000Z'
  });
  assert.equal(
    Object.hasOwn(cleared.items.welcome, 'plannedDurationSeconds'),
    false
  );
  assert.deepEqual(cleared.planning, originalPlanning);

  const maximum = updateProjectItemTiming(cleared, {
    itemId: 'welcome',
    plannedDurationSeconds: MAX_PLANNED_ITEM_DURATION_SECONDS,
    now: '2026-07-30T16:08:00.000Z'
  });
  assert.equal(
    maximum.items.welcome.plannedDurationSeconds,
    MAX_PLANNED_ITEM_DURATION_SECONDS
  );

  for (const invalid of [-1, 1.5, MAX_PLANNED_ITEM_DURATION_SECONDS + 1]) {
    expectProjectCode('INVALID_NUMBER', () => updateProjectItemTiming(project, {
      itemId: 'welcome',
      plannedDurationSeconds: invalid
    }));
  }
  expectProjectCode(
    'INVALID_PROJECT_ITEM_TIMING',
    () => updateProjectItemTiming(project, {
      itemId: 'welcome',
      plannedDurationSeconds: 60,
      calculatedStart: '10:00'
    })
  );
  expectProjectCode(
    'UNKNOWN_PROJECT_ITEM',
    () => updateProjectItemTiming(project, {
      itemId: 'missing',
      plannedDurationSeconds: 60
    })
  );
  expectProjectCode(
    'SERVICE_PLAN_REQUIRED',
    () => updateProjectItemTiming(freshProject(), {
      itemId: 'missing',
      plannedDurationSeconds: 60
    })
  );
});

test('flat run sheet derives wall clocks and expected finish across midnight', () => {
  let project = plannedProject({
    id: 'midnight-service',
    serviceDate: '2026-08-02',
    startTime: '23:50'
  });
  project = addNotice(project, {
    id: 'opening',
    title: 'Opening',
    plannedDurationSeconds: 600,
    operatorNotes: '/private/operator-only.txt'
  });
  project = addNotice(project, {
    id: 'prayer',
    title: 'Prayer',
    plannedDurationSeconds: 300
  });
  const projectBytes = serializeServiceProject(project);

  const runSheet = buildServiceRunSheet(project);

  assert.equal(runSheet.schemaVersion, SERVICE_RUN_SHEET_SCHEMA_VERSION);
  assert.equal(runSheet.kind, SERVICE_RUN_SHEET_KIND);
  assert.equal(runSheet.status, 'complete');
  assert.equal(runSheet.complete, true);
  assert.equal(runSheet.breakdownComplete, true);
  assert.equal(runSheet.totalDurationSeconds, 900);
  assert.deepEqual(runSheet.expectedFinish, {
    date: '2026-08-03',
    time: '00:05:00',
    dayOffset: 1
  });
  assert.deepEqual(runSheet.rows[0].start, {
    date: '2026-08-02',
    time: '23:50:00',
    dayOffset: 0
  });
  assert.deepEqual(runSheet.rows[0].end, {
    date: '2026-08-03',
    time: '00:00:00',
    dayOffset: 1
  });
  assert.equal(runSheet.rows[1].startOffsetSeconds, 600);
  assert.equal(runSheet.rows[1].endOffsetSeconds, 900);
  assert.equal(runSheet.missingItemIds.length, 0);
  assert.equal(JSON.stringify(runSheet).includes('/private/'), false);
  assert.ok(Object.isFrozen(runSheet));
  assert.ok(Object.isFrozen(runSheet.rows[0]));
  assert.equal(serializeServiceProject(project), projectBytes);
});

test('explicit group owns its outer slot and reports an internal overrun', () => {
  let project = plannedProject({ id: 'group-budget-service' });
  project = addGroupItem(project, {
    id: 'sermon',
    title: 'Sermon',
    groupKind: 'sermon',
    plannedDurationSeconds: 1800,
    now: NOW
  });
  project = addNotice(project, {
    id: 'sermon-introduction',
    title: 'Sermon introduction',
    parentId: 'sermon',
    plannedDurationSeconds: 1200
  });
  project = addNotice(project, {
    id: 'sermon-conclusion',
    title: 'Sermon conclusion',
    parentId: 'sermon',
    plannedDurationSeconds: 900
  });
  project = addNotice(project, {
    id: 'closing',
    title: 'Closing',
    plannedDurationSeconds: 300
  });

  const runSheet = buildServiceRunSheet(project);
  const sermon = runSheet.rows.find(row => row.itemId === 'sermon');
  const conclusion = runSheet.rows.find(row =>
    row.itemId === 'sermon-conclusion');
  const closing = runSheet.rows.find(row => row.itemId === 'closing');

  assert.equal(runSheet.totalDurationSeconds, 2100);
  assert.deepEqual(runSheet.expectedFinish, {
    date: '2026-08-02',
    time: '10:35:00',
    dayOffset: 0
  });
  assert.equal(runSheet.status, 'conflict');
  assert.equal(sermon.effectiveDurationSeconds, 1800);
  assert.equal(sermon.childDurationSeconds, 2100);
  assert.equal(sermon.remainingSeconds, 0);
  assert.equal(sermon.overrunSeconds, 300);
  assert.equal(conclusion.coveredByItemId, 'sermon');
  assert.equal(conclusion.endOffsetSeconds, 2100);
  assert.equal(closing.startOffsetSeconds, 1800);
  assert.deepEqual(runSheet.overruns, [{
    groupItemId: 'sermon',
    plannedDurationSeconds: 1800,
    childDurationSeconds: 2100,
    overrunSeconds: 300
  }]);
});

test('explicit group can cover an optional internal breakdown', () => {
  let project = plannedProject({ id: 'covered-breakdown-service' });
  project = addGroupItem(project, {
    id: 'sermon',
    title: 'Sermon',
    groupKind: 'sermon',
    plannedDurationSeconds: 1800,
    now: NOW
  });
  project = addNotice(project, {
    id: 'sermon-opening',
    parentId: 'sermon',
    plannedDurationSeconds: 600
  });
  project = addNotice(project, {
    id: 'sermon-body',
    parentId: 'sermon'
  });
  project = addNotice(project, {
    id: 'closing',
    plannedDurationSeconds: 300
  });

  const runSheet = buildServiceRunSheet(project);
  const body = runSheet.rows.find(row => row.itemId === 'sermon-body');
  const closing = runSheet.rows.find(row => row.itemId === 'closing');

  assert.equal(runSheet.complete, true);
  assert.equal(runSheet.breakdownComplete, false);
  assert.equal(runSheet.status, 'complete');
  assert.equal(runSheet.totalDurationSeconds, 2100);
  assert.deepEqual(runSheet.missingItemIds, []);
  assert.deepEqual(runSheet.unestimatedItemIds, ['sermon-body']);
  assert.equal(body.coveredByItemId, 'sermon');
  assert.equal(body.startOffsetSeconds, 600);
  assert.equal(body.endOffsetSeconds, null);
  assert.equal(closing.startOffsetSeconds, 1800);
});

test('untimed group derives only from fully timed children', () => {
  let complete = plannedProject({ id: 'derived-group-service' });
  complete = addGroupItem(complete, {
    id: 'opening',
    title: 'Opening',
    groupKind: 'section',
    now: NOW
  });
  complete = addNotice(complete, {
    id: 'welcome',
    parentId: 'opening',
    plannedDurationSeconds: 120
  });
  complete = addNotice(complete, {
    id: 'announcements',
    parentId: 'opening',
    plannedDurationSeconds: 180
  });

  const derived = buildServiceRunSheet(complete);
  const opening = derived.rows.find(row => row.itemId === 'opening');
  assert.equal(derived.complete, true);
  assert.equal(derived.totalDurationSeconds, 300);
  assert.equal(opening.timingSource, 'children');
  assert.equal(opening.effectiveDurationSeconds, 300);

  let incomplete = plannedProject({ id: 'incomplete-group-service' });
  incomplete = addGroupItem(incomplete, {
    id: 'opening',
    title: 'Opening',
    groupKind: 'section',
    now: NOW
  });
  incomplete = addNotice(incomplete, {
    id: 'welcome',
    parentId: 'opening',
    plannedDurationSeconds: 120
  });
  incomplete = addNotice(incomplete, {
    id: 'announcements',
    parentId: 'opening'
  });
  incomplete = addNotice(incomplete, {
    id: 'closing',
    plannedDurationSeconds: 60
  });

  const missing = buildServiceRunSheet(incomplete);
  const missingOpening = missing.rows.find(row => row.itemId === 'opening');
  const closing = missing.rows.find(row => row.itemId === 'closing');
  assert.equal(missing.complete, false);
  assert.equal(missing.status, 'incomplete');
  assert.equal(missing.totalDurationSeconds, null);
  assert.equal(missing.expectedFinish, null);
  assert.deepEqual(missing.missingItemIds, ['announcements']);
  assert.equal(missingOpening.timingSource, 'missing');
  assert.equal(missingOpening.effectiveDurationSeconds, null);
  assert.equal(closing.start, null);
});

test('Plan Next and song replacement preserve reusable service-slot durations', () => {
  let source = freshProject({ id: 'timed-source-service' });
  source = addGroupItem(source, {
    id: 'songs',
    title: 'Songs',
    groupKind: 'section',
    now: NOW
  });
  source = addSong(source, {
    id: 'opening-song',
    documentId: 'opening-hymn',
    title: 'Opening Hymn',
    parentId: 'songs',
    plannedDurationSeconds: 240
  }).project;
  source = addGroupItem(source, {
    id: 'sermon',
    title: 'Sermon',
    groupKind: 'sermon',
    plannedDurationSeconds: 1800,
    now: NOW
  });
  source = addNotice(source, {
    id: 'old-sermon-slide',
    parentId: 'sermon',
    plannedDurationSeconds: 600
  });
  const savedRaw = JSON.parse(serializeServiceProject(source));
  savedRaw.revision = 1;
  const saved = normalizeServiceProject(savedRaw, { now: NOW });

  const planned = planNextServiceProject(saved, {
    id: 'timed-next-service',
    title: 'Next Timed Service',
    serviceDate: '2026-08-09',
    startTime: '10:00',
    now: '2026-08-03T16:00:00.000Z'
  });

  assert.equal(planned.items['opening-song'].plannedDurationSeconds, 240);
  assert.equal(planned.items.sermon.plannedDurationSeconds, 1800);
  assert.deepEqual(planned.items.sermon.childIds, []);
  assert.equal(planned.items['old-sermon-slide'], undefined);

  const replacementPinned = addSongResource(
    planned,
    songDocument('replacement-hymn', 'Replacement Hymn'),
    {
      provider: 'local',
      itemId: 'replacement-hymn',
      revision: 'replacement-hymn-revision'
    }
  );
  const replaced = replaceSongItem(
    replacementPinned.project,
    'opening-song',
    {
      id: 'replacement-song',
      kind: 'song',
      title: 'Replacement Hymn',
      primaryChannelId: 'primary',
      variants: {
        primary: {
          mode: 'content',
          resourceId: replacementPinned.resourceId
        }
      },
      arrangement: [{
        id: 'arr-replacement-song-verse-one',
        sectionId: 'verse-1'
      }],
      titlePresetId: 'song-title',
      lyricsPresetId: 'song-lyrics',
      operatorNotes: ''
    },
    { now: '2026-08-03T16:05:00.000Z' }
  );

  assert.equal(replaced.items['replacement-song'].plannedDurationSeconds, 240);
  const reopened = normalizeServiceProject(
    JSON.parse(serializeServiceProject(replaced)),
    { now: NOW }
  );
  assert.equal(reopened.items['replacement-song'].plannedDurationSeconds, 240);
  assert.equal(reopened.items.sermon.plannedDurationSeconds, 1800);
});

test('run sheets reject unplanned projects instead of inventing a start time', () => {
  expectProjectCode(
    'SERVICE_PLAN_REQUIRED',
    () => buildServiceRunSheet(freshProject())
  );
});
