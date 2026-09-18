'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const controllerPath = path.join(
  root,
  'src',
  'renderer',
  'prepare-controller.js'
);
const controllerSource = fs.readFileSync(controllerPath, 'utf8');

function rendererExports() {
  const window = {};
  vm.runInNewContext(controllerSource, { console, window }, {
    filename: controllerPath
  });
  return window.SyncShowPrepare;
}

function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

function assignment(overrides = {}) {
  return {
    id: 'serving-slides',
    role: 'Slides',
    personName: 'Maria S.',
    scope: { kind: 'service', itemId: null },
    status: 'assigned',
    required: true,
    callTime: '09:15',
    note: 'Check the confidence monitor.',
    ...overrides
  };
}

test('planned item timing preserves untimed and intentional zero as different values', () => {
  const { plannedDurationFromInputs } = rendererExports();

  assert.equal(plannedDurationFromInputs({
    scheduled: false,
    minutes: 'not used',
    seconds: 'not used'
  }), null);
  assert.equal(plannedDurationFromInputs({
    scheduled: true,
    minutes: '0',
    seconds: '0'
  }), 0);
  assert.equal(plannedDurationFromInputs({
    scheduled: true,
    minutes: '12',
    seconds: '34'
  }), 754);
  assert.equal(plannedDurationFromInputs({
    scheduled: true,
    minutes: '1440',
    seconds: '0'
  }), 86400);

  for (const values of [
    { scheduled: true, minutes: '', seconds: '0' },
    { scheduled: true, minutes: '-1', seconds: '0' },
    { scheduled: true, minutes: '1.5', seconds: '0' },
    { scheduled: true, minutes: '0', seconds: '60' },
    { scheduled: true, minutes: '1440', seconds: '1' }
  ]) {
    assert.throws(
      () => plannedDurationFromInputs(values),
      /whole|from 0|more than one day/
    );
  }
});

test('run-sheet presentation reports complete, incomplete, and overrun states honestly', () => {
  const { serviceRunSheetPresentation } = rendererExports();

  assert.deepEqual(plain(serviceRunSheetPresentation({
    status: 'complete',
    complete: true,
    breakdownComplete: true,
    totalDurationSeconds: 3900,
    expectedFinish: {
      date: '2026-08-02',
      time: '11:35:00',
      dayOffset: 0
    },
    missingItemIds: [],
    unestimatedItemIds: [],
    rows: [
      { plannedDurationSeconds: 600 },
      { plannedDurationSeconds: 3300 }
    ],
    overruns: []
  })), {
    badge: 'Timed',
    badgeKind: 'ready',
    summary:
      'Every service slot has enough timing to calculate the expected finish.',
    duration: '1 hr 5 min total',
    finish: '11:35 AM finish'
  });

  const incomplete = plain(serviceRunSheetPresentation({
    status: 'incomplete',
    complete: false,
    totalDurationSeconds: null,
    expectedFinish: null,
    missingItemIds: ['sermon', 'closing-song'],
    rows: [
      { plannedDurationSeconds: 300 },
      { plannedDurationSeconds: null },
      { plannedDurationSeconds: 0 }
    ],
    overruns: []
  }));
  assert.equal(incomplete.badge, '2 missing');
  assert.equal(incomplete.duration, '2 durations entered');
  assert.equal(incomplete.finish, 'Finish unknown');
  assert.match(incomplete.summary, /2 durations entered/);
  assert.match(incomplete.summary, /2 required slots still need timing/);

  const conflict = plain(serviceRunSheetPresentation({
    status: 'conflict',
    complete: true,
    totalDurationSeconds: 4500,
    expectedFinish: {
      date: '2026-08-02',
      time: '11:45:00',
      dayOffset: 0
    },
    missingItemIds: [],
    rows: [{ plannedDurationSeconds: 4500 }],
    overruns: [{
      groupItemId: 'sermon',
      overrunSeconds: 300
    }]
  }));
  assert.equal(conflict.badge, '1 overrun');
  assert.equal(conflict.badgeKind, 'warning');
  assert.equal(conflict.duration, '1 hr 15 min total');
  assert.equal(conflict.finish, '11:45 AM finish');
  assert.match(conflict.summary, /overruns its planned slot by 5 min/);
});

test('serving summaries keep filled, open, declined, and required-open truthful', () => {
  const { serviceServingSummary } = rendererExports();
  assert.deepEqual(plain(serviceServingSummary({
    schemaVersion: 1,
    assignments: [
      assignment(),
      assignment({
        id: 'serving-reader',
        role: 'Reader',
        personName: 'Oleh K.',
        status: 'confirmed',
        required: false
      }),
      assignment({
        id: 'serving-sound',
        role: 'Sound',
        personName: null,
        status: 'open'
      }),
      assignment({
        id: 'serving-prayer',
        role: 'Prayer',
        personName: 'Anna K.',
        status: 'declined'
      })
    ]
  })), {
    total: 4,
    filled: 2,
    open: 1,
    declined: 1,
    requiredOpen: 2
  });
});

test('serving drafts emit only strict local assignment fields', () => {
  const { normalizeServingPlanDraft } = rendererExports();
  const normalized = plain(normalizeServingPlanDraft({
    schemaVersion: 1,
    assignments: [
      assignment({
        role: '  Slides  ',
        personName: '  Maria S.  ',
        note: 'First line.\r\nSecond line.'
      }),
      assignment({
        id: 'serving-reader',
        role: 'Reader',
        personName: null,
        scope: { kind: 'item', itemId: 'reading' },
        status: 'open',
        required: false,
        callTime: null,
        note: ''
      })
    ]
  }, ['reading']));

  assert.deepEqual(normalized, {
    schemaVersion: 1,
    assignments: [
      assignment({
        role: 'Slides',
        personName: 'Maria S.',
        note: 'First line.\nSecond line.'
      }),
      assignment({
        id: 'serving-reader',
        role: 'Reader',
        personName: null,
        scope: { kind: 'item', itemId: 'reading' },
        status: 'open',
        required: false,
        callTime: null,
        note: ''
      })
    ]
  });

  assert.throws(
    () => normalizeServingPlanDraft({
      schemaVersion: 1,
      assignments: [{
        ...assignment(),
        email: 'maria@example.test'
      }]
    }),
    /unsupported or missing fields/
  );
  assert.throws(
    () => normalizeServingPlanDraft({
      schemaVersion: 1,
      assignments: [assignment({
        personName: 'Someone',
        status: 'open'
      })]
    }),
    /cannot name a person while it is open/
  );
  assert.throws(
    () => normalizeServingPlanDraft({
      schemaVersion: 1,
      assignments: [assignment({
        personName: null,
        status: 'confirmed'
      })]
    }),
    /person is required/
  );
  assert.throws(
    () => normalizeServingPlanDraft({
      schemaVersion: 1,
      assignments: [assignment({
        scope: { kind: 'item', itemId: 'missing-item' }
      })]
    }, ['reading']),
    /item that still exists/
  );
});

test('new native add flows select only one exact newly returned item', () => {
  const { newlyAddedItemId } = rendererExports();
  const result = {
    project: {
      items: {
        existing: { id: 'existing', kind: 'group' },
        song: { id: 'song', kind: 'song' }
      }
    }
  };
  assert.equal(newlyAddedItemId(['existing'], result, 'song'), 'song');
  assert.equal(newlyAddedItemId(['existing'], result, 'bible'), null);
  assert.equal(newlyAddedItemId([], result, ['group', 'song']), null);
});

test('controller wiring keeps timing and serving native, revisioned, and local-only', () => {
  assert.match(controllerSource, /'updateServiceServing'/);
  assert.match(
    controllerSource,
    /state\.runSheet = !companionProject[\s\S]*result\.runSheet\?\.projectId === result\.project\.id[\s\S]*result\.runSheet\?\.projectRevision === result\.project\.revision/
  );
  assert.match(
    controllerSource,
    /Object\.prototype\.hasOwnProperty\.call\(item, 'plannedDurationSeconds'\)/
  );
  const saveItemStart = controllerSource.indexOf(
    'async function saveEditedItem(event)'
  );
  const saveItemEnd = controllerSource.indexOf(
    '\n    async function importSong()',
    saveItemStart
  );
  const saveItemSource = controllerSource.slice(saveItemStart, saveItemEnd);
  assert.match(
    saveItemSource,
    /api\.updateServiceItem\(\{[\s\S]*plannedDurationSeconds/
  );
  assert.match(
    controllerSource,
    /editItemGroupKindField\.hidden = item\.kind !== 'group'/
  );
  assert.match(
    saveItemSource,
    /groupKind: row\.item\.kind === 'group'[\s\S]*elements\.editItemGroupKind\.value/
  );

  const servingStart = controllerSource.indexOf(
    'function cloneServingPlanForEditor(project)'
  );
  const servingEnd = controllerSource.indexOf(
    '\n    function renderServiceReadinessReviewDialog',
    servingStart
  );
  const servingSource = controllerSource.slice(servingStart, servingEnd);
  assert.match(
    servingSource,
    /api\.updateServiceServing\(\{[\s\S]*projectId:[\s\S]*expectedRevisionId:[\s\S]*serving/
  );
  assert.doesNotMatch(servingSource, /\b(?:email|phone|accountId|contactId)\b/u);
  assert.match(
    controllerSource,
    /renderPlanningOperationalSummary\(\)[\s\S]*!isPowerPointCompanionProject\(project\)/
  );

  for (const kind of ['song', 'bible']) {
    assert.match(
      controllerSource,
      new RegExp(`selectNewlyAddedNativeItem\\([\\s\\S]*?['"]${kind}['"]`)
    );
  }
  assert.match(
    controllerSource,
    /selectNewlyAddedNativeItem\([\s\S]*previousItemIds,[\s\S]*kind/
  );
});
