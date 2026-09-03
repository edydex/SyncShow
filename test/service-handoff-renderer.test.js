'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const api = require('../src/renderer/service-handoff');
const {
  cueContextAtIndex,
  normalizeServiceHandoff
} = api;

const CHECK_IDS = [
  'compilable-nonempty',
  'song-present',
  'exact-sermon-link',
  'linked-sermon-material',
  'sermon-reading-before-material',
  'channel-visible-content'
];

function cueId(number) {
  return `cue-${number.toString(16).padStart(24, '0')}`;
}

function cue(number, overrides = {}) {
  const id = cueId(number);
  return {
    id,
    itemId: `item-${number}`,
    title: number === 1 ? '<Opening & welcome>' : 'Next cue',
    kind: number === 1 ? 'notice' : 'song',
    groupPath: number === 1 ? ['Welcome'] : ['Singing', 'Song one'],
    operatorNotes: number === 1 ? 'Wait for the room to settle.\nThen continue.' : '',
    ...overrides
  };
}

function fixture() {
  const first = cue(1);
  const second = cue(2);
  return {
    schemaVersion: 1,
    kind: 'syncshow-service-handoff',
    project: {
      id: 'service-2026-07-26',
      revisionId: 'a'.repeat(64),
      revision: 17,
      contentHash: 'b'.repeat(64),
      title: 'Sunday Service',
      serviceDate: '2026-07-26'
    },
    planning: {
      status: 'ready',
      startTime: '10:30',
      teamNotes: 'Sound check at 09:45.',
      readinessWaivers: []
    },
    readiness: {
      ready: true,
      checks: CHECK_IDS.map(id => ({ id, status: 'pass' })),
      waivedCheckIds: []
    },
    cueIds: [first.id, second.id],
    cues: {
      [first.id]: first,
      [second.id]: second
    }
  };
}

function clock(time, dayOffset = 0, date = '2026-07-26') {
  return { date, time, dayOffset };
}

function runSheetRow({
  itemId,
  kind,
  title,
  plannedDurationSeconds,
  startOffsetSeconds,
  endOffsetSeconds,
  start,
  end
}) {
  return {
    itemId,
    parentItemId: null,
    depth: 0,
    kind,
    title,
    plannedDurationSeconds,
    effectiveDurationSeconds: plannedDurationSeconds,
    timingSource: 'explicit',
    coveredByItemId: null,
    startOffsetSeconds,
    endOffsetSeconds,
    start,
    end
  };
}

function fixtureV2() {
  const handoff = fixture();
  handoff.schemaVersion = 2;
  handoff.planning.serving = {
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
        id: 'assignment-song-leader',
        role: 'Song leader',
        personName: 'Oleh K.',
        scope: { kind: 'item', itemId: 'item-2' },
        status: 'assigned',
        required: false,
        callTime: null,
        note: ''
      }
    ]
  };
  handoff.runSheet = {
    schemaVersion: 1,
    kind: 'syncshow-service-run-sheet',
    projectId: handoff.project.id,
    projectRevision: handoff.project.revision,
    serviceDate: handoff.project.serviceDate,
    startTime: handoff.planning.startTime,
    status: 'complete',
    complete: true,
    breakdownComplete: true,
    totalDurationSeconds: 300,
    expectedFinish: clock('10:35:00'),
    missingItemIds: [],
    unestimatedItemIds: [],
    overruns: [],
    rows: [
      runSheetRow({
        itemId: 'item-1',
        kind: 'notice',
        title: '<Opening & welcome>',
        plannedDurationSeconds: 120,
        startOffsetSeconds: 0,
        endOffsetSeconds: 120,
        start: clock('10:30:00'),
        end: clock('10:32:00')
      }),
      runSheetRow({
        itemId: 'item-2',
        kind: 'song',
        title: 'Next cue',
        plannedDurationSeconds: 180,
        startOffsetSeconds: 120,
        endOffsetSeconds: 300,
        start: clock('10:32:00'),
        end: clock('10:35:00')
      })
    ]
  };
  handoff.cues[cueId(1)].groupPath = [];
  handoff.cues[cueId(1)].itemPathIds = ['item-1'];
  handoff.cues[cueId(2)].groupPath = [];
  handoff.cues[cueId(2)].itemPathIds = ['item-2'];
  return handoff;
}

function clone(value) {
  return structuredClone(value);
}

test('exposes exactly the supported CommonJS and browser interfaces', () => {
  assert.deepEqual(Object.keys(api).sort(), [
    'cueContextAtIndex',
    'normalizeServiceHandoff'
  ]);

  const source = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'renderer', 'service-handoff.js'),
    'utf8'
  );
  const context = vm.createContext({});
  vm.runInContext(source, context);
  assert.deepEqual(
    Array.from(Object.keys(context.SyncShowServiceHandoff)).sort(),
    ['cueContextAtIndex', 'normalizeServiceHandoff']
  );
  assert.equal(
    typeof context.SyncShowServiceHandoff.normalizeServiceHandoff,
    'function'
  );
  assert.equal(
    typeof context.SyncShowServiceHandoff.cueContextAtIndex,
    'function'
  );
});

test('renderer normalization returns a detached, deeply frozen text-only handoff', () => {
  const input = fixture();
  const before = clone(input);
  const normalized = normalizeServiceHandoff(input);

  assert.deepEqual(normalized, before);
  assert.deepEqual(input, before);
  assert.notEqual(normalized, input);
  assert.notEqual(normalized.project, input.project);
  assert.equal(Object.isFrozen(normalized), true);
  assert.equal(Object.isFrozen(normalized.project), true);
  assert.equal(Object.isFrozen(normalized.readiness.checks[0]), true);
  assert.equal(Object.isFrozen(normalized.cues[cueId(1)].groupPath), true);
  assert.equal(
    normalized.cues[cueId(1)].title,
    '<Opening & welcome>',
    'markup-like user text stays literal text rather than becoming renderer markup'
  );
  assert.deepEqual(Object.keys(normalized.cues[cueId(1)]).sort(), [
    'groupPath',
    'id',
    'itemId',
    'kind',
    'operatorNotes',
    'title'
  ]);
});

test('renderer strictly normalizes v2 serving, run-sheet, and cue ancestry', () => {
  const input = fixtureV2();
  const before = clone(input);
  const normalized = normalizeServiceHandoff(input);

  assert.deepEqual(normalized, before);
  assert.deepEqual(input, before);
  assert.equal(normalized.schemaVersion, 2);
  assert.equal(normalized.runSheet.totalDurationSeconds, 300);
  assert.equal(normalized.runSheet.expectedFinish.time, '10:35:00');
  assert.deepEqual(
    normalized.planning.serving.assignments.map(assignment => [
      assignment.role,
      assignment.personName,
      assignment.scope
    ]),
    [
      ['Slides', 'Maria S.', { kind: 'service', itemId: null }],
      ['Song leader', 'Oleh K.', { kind: 'item', itemId: 'item-2' }]
    ]
  );
  assert.deepEqual(normalized.cues[cueId(2)].itemPathIds, ['item-2']);
  assert.equal(Object.isFrozen(normalized.runSheet.rows[0]), true);
  assert.equal(
    Object.isFrozen(normalized.planning.serving.assignments[0]),
    true
  );
});

test('cue context resolves the exact current and next cue by zero-based slide index', () => {
  const input = fixture();
  const first = cueContextAtIndex(input, 0);
  assert.deepEqual(first, {
    slideIndex: 0,
    cueCount: 2,
    currentCue: normalizeServiceHandoff(input).cues[cueId(1)],
    nextCue: normalizeServiceHandoff(input).cues[cueId(2)]
  });
  assert.equal(Object.isFrozen(first), true);

  const last = cueContextAtIndex(input, 1);
  assert.equal(last.currentCue.id, cueId(2));
  assert.equal(last.nextCue, null);
  assert.equal(cueContextAtIndex(input, -1), null);
  assert.equal(cueContextAtIndex(input, 2), null);
  assert.throws(
    () => cueContextAtIndex(input, 0.5),
    /slide index must be a safe integer/
  );
});

test('cue context remains stable for schema-v2 handoffs', () => {
  const input = fixtureV2();
  const context = cueContextAtIndex(input, 0);

  assert.equal(context.currentCue.id, cueId(1));
  assert.deepEqual(context.currentCue.itemPathIds, ['item-1']);
  assert.equal(context.nextCue.id, cueId(2));
  assert.deepEqual(context.nextCue.itemPathIds, ['item-2']);
});

test('planning may be absent, but readiness waivers remain exact and reviewed', () => {
  const unplanned = fixture();
  unplanned.planning = null;
  assert.equal(normalizeServiceHandoff(unplanned).planning, null);

  const waived = fixture();
  waived.planning.readinessWaivers = [{
    checkId: 'song-present',
    reason: 'This service intentionally contains no congregational song.'
  }];
  waived.readiness.checks[1].status = 'waived';
  waived.readiness.waivedCheckIds = ['song-present'];
  const normalized = normalizeServiceHandoff(waived);
  assert.deepEqual(normalized.planning.readinessWaivers, [{
    checkId: 'song-present',
    reason: 'This service intentionally contains no congregational song.'
  }]);
  assert.deepEqual(normalized.readiness.waivedCheckIds, ['song-present']);

  const missingReview = clone(waived);
  missingReview.planning.readinessWaivers = [];
  assert.throws(
    () => normalizeServiceHandoff(missingReview),
    /has no reviewed planning waiver/
  );

  const falseReady = fixture();
  falseReady.readiness.ready = false;
  assert.throws(
    () => normalizeServiceHandoff(falseReady),
    /must match the absence of blockers/
  );
});

test('objects must be own plain data with exact fields', () => {
  const extra = fixture();
  extra.project.localPath = '/private/service.json';
  assert.throws(
    () => normalizeServiceHandoff(extra),
    /project must contain exactly the supported fields/
  );

  const inherited = fixture();
  inherited.project = Object.assign(
    Object.create({ localPath: '/private/inherited.json' }),
    inherited.project
  );
  assert.throws(
    () => normalizeServiceHandoff(inherited),
    /project must be a plain object/
  );

  const accessor = fixture();
  const originalTitle = accessor.project.title;
  Object.defineProperty(accessor.project, 'title', {
    enumerable: true,
    get() {
      return originalTitle;
    }
  });
  assert.throws(
    () => normalizeServiceHandoff(accessor),
    /project\.title must be an own data property/
  );

  const symbol = fixture();
  symbol.cues[Symbol('private')] = cue(3);
  assert.throws(
    () => normalizeServiceHandoff(symbol),
    /cueIds and cues must contain exactly the same cue IDs/
  );
});

test('cue order and cue map must describe exactly the same unique compiled cues', () => {
  const missing = fixture();
  delete missing.cues[cueId(2)];
  assert.throws(
    () => normalizeServiceHandoff(missing),
    /cueIds and cues must contain exactly the same cue IDs/
  );

  const extra = fixture();
  extra.cues[cueId(3)] = cue(3);
  assert.throws(
    () => normalizeServiceHandoff(extra),
    /cueIds and cues must contain exactly the same cue IDs/
  );

  const repeated = fixture();
  repeated.cueIds[1] = repeated.cueIds[0];
  assert.throws(
    () => normalizeServiceHandoff(repeated),
    /must be one unique compiled cue ID/
  );

  const mismatch = fixture();
  mismatch.cues[cueId(1)].id = cueId(3);
  assert.throws(
    () => normalizeServiceHandoff(mismatch),
    /must match its cue-map key/
  );
});

test('bounds, calendar dates, kinds, and renderer-visible text fail closed', () => {
  const impossibleDate = fixture();
  impossibleDate.project.serviceDate = '2026-02-30';
  assert.throws(
    () => normalizeServiceHandoff(impossibleDate),
    /must be a real calendar date/
  );

  const unsafeText = fixture();
  unsafeText.cues[cueId(1)].operatorNotes = 'Visible\u0000hidden';
  assert.throws(
    () => normalizeServiceHandoff(unsafeText),
    /operatorNotes must be safe bounded text/
  );

  const objectText = fixture();
  objectText.cues[cueId(1)].title = { html: '<strong>unsafe</strong>' };
  assert.throws(
    () => normalizeServiceHandoff(objectText),
    /title must be safe bounded text/
  );

  const unknownKind = fixture();
  unknownKind.cues[cueId(1)].kind = 'video';
  assert.throws(
    () => normalizeServiceHandoff(unknownKind),
    /kind is unsupported/
  );

  const tooMany = fixture();
  tooMany.cueIds = Array.from({ length: 2001 }, (_unused, index) => cueId(index));
  tooMany.cues = {};
  assert.throws(
    () => normalizeServiceHandoff(tooMany),
    /cueIds must contain 1 to 2000 entries/
  );
});

test('v2 project binding, canonical serving, run-sheet arithmetic, and item paths fail closed', () => {
  const wrongRevision = fixtureV2();
  wrongRevision.runSheet.projectRevision += 1;
  assert.throws(
    () => normalizeServiceHandoff(wrongRevision),
    /runSheet must belong to the exact planned service revision/
  );

  const contactData = fixtureV2();
  contactData.planning.serving.assignments[0].email = 'maria@example.test';
  assert.throws(
    () => normalizeServiceHandoff(contactData),
    /assignments\[0\] must contain exactly the supported fields/
  );

  const nonCanonicalName = fixtureV2();
  nonCanonicalName.planning.serving.assignments[0].personName = ' Maria S. ';
  assert.throws(
    () => normalizeServiceHandoff(nonCanonicalName),
    /personName must be canonical single-line text/
  );

  const wrongClock = fixtureV2();
  wrongClock.runSheet.rows[1].start.time = '10:33:00';
  assert.throws(
    () => normalizeServiceHandoff(wrongClock),
    /inconsistent wall-clock values/
  );

  const wrongSummary = fixtureV2();
  wrongSummary.runSheet.totalDurationSeconds = 301;
  assert.throws(
    () => normalizeServiceHandoff(wrongSummary),
    /summary must match its canonical rows/
  );

  const wrongPath = fixtureV2();
  wrongPath.cues[cueId(2)].itemPathIds = ['item-1'];
  assert.throws(
    () => normalizeServiceHandoff(wrongPath),
    /itemPathIds must end in itemId/
  );

  const missingRunSheet = fixtureV2();
  missingRunSheet.runSheet = null;
  assert.throws(
    () => normalizeServiceHandoff(missingRunSheet),
    /runSheet must be null exactly when planning is null/
  );
});
