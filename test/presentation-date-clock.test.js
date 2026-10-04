'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const guard = require('../src/renderer/prepared-service-guard');
const source = fs.readFileSync(require.resolve('../src/renderer/app.js'), 'utf8');

function functionSource(start, end) {
  return source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start)));
}

function fixture() {
  let now = '2026-10-04T06:59:00Z'; // Still October 3 in the church's time zone.
  class Clock extends Date {
    constructor(...args) { super(...(args.length ? args : [now])); }
  }
  const messages = [], statuses = [], badges = [];
  const state = {
    profile: {timeZone: 'America/Los_Angeles'},
    serviceFolder: {requestedDate: '2026-10-01'},
    presentations: {english: {loaded: true, source: 'prepared'}},
    serviceHandoff: {project: {id: 'sunday', revisionId: 'a'.repeat(64), title: 'Sunday', serviceDate: '2026-10-04'}},
    preparedServiceDateConfirmations: new Set()
  };
  const dateWarning = {style: {}, textContent: ''};
  const context = vm.createContext({
    Date: Clock, state, console,
    window: {SyncShowPreparedServiceGuard: guard, confirm(message) {messages.push(message); return false;}},
    setStatus: message => statuses.push(message),
    presentationElements: {english: {dateWarning}},
    getRole: () => ({datePolicy: 'service-date'}),
    parseDateFromFilename: () => ({year: 2026, month: 10, day: 4}),
    setRoleCardState: (...args) => badges.push(args)
  });
  vm.runInContext([
    functionSource('function serviceDateForProfile(', 'function formatServiceDate('),
    functionSource('function formatServiceDate(', 'function isLoadStage('),
    functionSource('function confirmPreparedServiceDate()', 'async function startPresentation('),
    functionSource('function checkFilenameDate(', 'function recheckLoadedPresentationDates('),
    functionSource('function serviceSetWarnings(', 'function serviceSourceView(')
  ].join('\n'), context);
  return {state, messages, statuses, dateWarning, badges,
    setClock(value) {now = value;},
    run(code) {return vm.runInContext(code, context);}};
}

test('Start Show uses the current church day after midnight and ignores the hidden old search date', () => {
  const app = fixture();
  assert.equal(app.run('confirmPreparedServiceDate()'), true); // Tomorrow.
  app.setClock('2026-10-04T07:01:00Z');
  assert.equal(app.run('confirmPreparedServiceDate()'), true); // Today, without restarting.
  assert.equal(app.messages.length, 0);
  app.setClock('2026-10-05T07:01:00Z');
  assert.equal(app.run('confirmPreparedServiceDate()'), false); // Yesterday.
  assert.match(app.messages[0], /October 4, 2026.*before today \(October 5, 2026\)/);
  assert.doesNotMatch(app.messages[0], /October 1|Load is set/);
  assert.equal(app.state.serviceFolder.requestedDate, '2026-10-01');
});

test('legacy filename and folder warnings allow future and today, then flag the same files after midnight', () => {
  const app = fixture();
  const folderWarnings = `serviceSetWarnings({requestedDate:'2026-10-01'}, {serviceDate:'2026-10-04',dateStatus:'mismatch',warnings:[]})`;
  for (const now of ['2026-10-04T06:59:00Z', '2026-10-04T07:01:00Z']) {
    app.setClock(now);
    app.run("checkFilenameDate('english', '2026-10-04.pptx')");
    assert.equal(app.dateWarning.style.display, 'none');
    assert.equal(app.run(folderWarnings).length, 0);
  }
  app.setClock('2026-10-05T07:01:00Z');
  app.run("checkFilenameDate('english', '2026-10-04.pptx')");
  assert.equal(app.dateWarning.style.display, 'block');
  assert.match(app.dateWarning.textContent, /before today/);
  assert.equal(app.run(folderWarnings).length, 1);
  assert.match(app.run(folderWarnings)[0].text, /older service/);
});
