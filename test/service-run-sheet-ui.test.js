'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const appSource = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'renderer', 'app.js'),
  'utf8'
);

function functionSource(name) {
  const marker = `function ${name}(`;
  const start = appSource.indexOf(marker);
  assert.notEqual(start, -1, `${name} must exist`);
  const tail = appSource.slice(start + 1);
  const next = tail.match(
    /\n\s*(?:async\s+)?function\s+[A-Za-z_$][\w$]*\s*\(/u
  );
  return appSource.slice(
    start,
    next ? start + 1 + next.index : appSource.length
  );
}

function loadHelpers() {
  const names = [
    'formatServiceStartTime',
    'formatRunSheetDuration',
    'formatRunSheetClock',
    'summarizeHandoffServing',
    'runSheetLoadSummary',
    'servingLoadSummary'
  ];
  const context = {};
  vm.runInNewContext(
    `${names.map(functionSource).join('\n')}
    globalThis.helpers = { ${names.join(', ')} };`,
    context,
    { filename: 'service-run-sheet-ui-functions.js' }
  );
  return context.helpers;
}

test('Load run-sheet copy distinguishes complete, partial, and internal timing', () => {
  const { runSheetLoadSummary } = loadHelpers();
  const complete = {
    complete: true,
    breakdownComplete: true,
    totalDurationSeconds: 5400,
    expectedFinish: {
      date: '2026-08-03',
      time: '00:30:00',
      dayOffset: 1
    },
    missingItemIds: [],
    unestimatedItemIds: [],
    overruns: [],
    rows: []
  };
  assert.equal(
    runSheetLoadSummary(complete),
    'Run sheet: 1 hr 30 min · expected finish 12:30 AM next day.'
  );

  const partial = {
    ...complete,
    complete: false,
    breakdownComplete: false,
    totalDurationSeconds: null,
    expectedFinish: null,
    missingItemIds: ['sermon'],
    unestimatedItemIds: ['sermon'],
    rows: [
      { depth: 0, effectiveDurationSeconds: 600 },
      { depth: 0, effectiveDurationSeconds: null }
    ]
  };
  assert.equal(
    runSheetLoadSummary(partial),
    'Run sheet: 10 min entered · 1 moment untimed · finish unknown.'
  );

  assert.match(
    runSheetLoadSummary({
      ...complete,
      breakdownComplete: false,
      unestimatedItemIds: ['verse-1', 'verse-2'],
      overruns: [{ groupItemId: 'singing' }]
    }),
    /2 internal moments untimed · 1 section is over budget/
  );
});

test('serving summary reports staffing work and only bounded display details', () => {
  const { servingLoadSummary, summarizeHandoffServing } = loadHelpers();
  const serving = {
    schemaVersion: 1,
    assignments: [
      {
        role: 'Slides',
        personName: 'Maria S.',
        status: 'confirmed',
        required: true
      },
      {
        role: 'Reader',
        personName: null,
        status: 'open',
        required: true
      },
      {
        role: 'Prayer',
        personName: 'Oleh K.',
        status: 'declined',
        required: false
      }
    ]
  };
  const summary = summarizeHandoffServing(serving);
  assert.equal(summary.filled.length, 1);
  assert.equal(summary.requiredOpen.length, 1);
  assert.equal(
    servingLoadSummary(serving),
    'Serving team: 1 filled · 1 open · 1 required open · 1 declined. Slides — Maria S.'
  );
  assert.equal(servingLoadSummary({ schemaVersion: 1, assignments: [] }), '');
});
