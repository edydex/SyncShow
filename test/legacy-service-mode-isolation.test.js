'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const source = fs.readFileSync(require.resolve('../src/renderer/app.js'), 'utf8');
function functionSource(name) {
  const start = source.search(new RegExp(`^(?:async )?function ${name}\\(`, 'm'));
  assert.notEqual(start, -1, `production function ${name} must exist`);
  const next = source.slice(start + 1).search(/\n(?:async )?function /);
  return source.slice(start, next < 0 ? source.length : start + 1 + next);
}

function deferred() {
  let resolve, reject;
  const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

function fixture({ mode = 'syncshow', stage = 'load', scanResult, current = null } = {}) {
  const calls = { check: 0, cached: 0, scans: 0, loads: 0 };
  const statuses = [], timers = new Map();
  let timerId = 0;
  const state = {
    loadMode: mode, workflowStage: stage, community: { handoffBusy: false },
    profile: { localServiceFolder: '/saved/legacy-slides' }, presentations: {}, isPresenting: false,
    serviceFolder: { current: null, sourceChanges: [], folderChangedSinceLoad: false,
      scanning: false, loading: false, scanVersion: 0, changeEpoch: 0, changeTimer: null }
  };
  const elements = {
    serviceFolderDate: { value: '2026-10-04' }, loadModePanels: [],
    loadModeTabs: ['syncshow', 'pptx'].map(mode => ({
      dataset: { loadTab: mode }, classList: { toggle() {} }, setAttribute() {}, focus() {}
    }))
  };
  const api = {
    async checkServiceSetChanges() { calls.check++; return { current, changes: [] }; },
    async getCurrentServiceSet() { calls.cached++; return current; },
    async scanServiceFolder() {
      calls.scans++;
      return scanResult || { scanToken: 'valid', sets: [] };
    }
  };
  const sandbox = vm.createContext({
    state, elements, console: { warn() {}, error() {} },
    window: { api, setTimeout(callback) { timers.set(++timerId, callback); return timerId; },
      clearTimeout(id) { timers.delete(id); } },
    serviceDateForProfile: () => '2026-10-04', refreshDriveStatus: async () => {},
    renderServiceFolder() {}, serviceFolderApiAvailable: () => true,
    hasConfiguredServiceSource: () => Boolean(state.profile.localServiceFolder),
    isLoadStage: () => state.workflowStage === 'load',
    setStatus(message) { statuses.push(message); },
    driveErrorMessage: error => error.message, formatServiceDate: date => date,
    presentationConversionInFlight: () => false,
    selectedServiceSetCanBePinned: () => true, shouldUseSavedServiceFallback: () => Boolean(current),
    async loadSelectedServiceSet() { calls.loads++; },
    cancelQueuedStart() {}, placeServiceInputCards() {}, refreshLoadLocalServices() {},
    async refreshLoadedService() {}
  });
  vm.runInContext([
    'activateLoadMode', 'invalidateServiceFolderScan', 'initializeServiceFolder',
    'scanLinkedServiceFolder', 'handleServiceFolderChanged', 'resumeServiceFolderScanOnLoad',
    'getSelectedServiceSet', 'maybeAutoLoadServiceSet'
  ].map(functionSource).join('\n'), sandbox);
  return { state, calls, statuses, timers, api,
    initialize: () => sandbox.initializeServiceFolder(),
    scan: reason => sandbox.scanLinkedServiceFolder({ reason }),
    activate: mode => sandbox.activateLoadMode(mode),
    changed: () => sandbox.handleServiceFolderChanged({ folderPath: state.profile.localServiceFolder }),
    resume: () => sandbox.resumeServiceFolderScanOnLoad(),
    autoLoad: reason => sandbox.maybeAutoLoadServiceSet(reason),
    async flushTimers() {
      const pending = [...timers.values()]; timers.clear();
      for (const callback of pending) await callback();
      await new Promise(resolve => setImmediate(resolve));
    }
  };
}

test('native startup reads only the cached legacy snapshot and leaves native readiness alone', async () => {
  const current = { id: 'old-pptx', serviceDate: '2026-10-04', verified: true };
  const f = fixture({ current });
  f.api.scanServiceFolder = async () => { f.calls.scans++; throw new Error('Missing optional Drive API key'); };
  await f.initialize();
  assert.equal(f.calls.check, 0, 'a Community service does not need to compare the old Drive source');
  assert.equal(f.calls.cached, 1, 'the verified local Legacy copy remains available');
  assert.equal(f.calls.scans, 0);
  assert.equal(f.calls.loads, 0);
  assert.equal(f.state.serviceFolder.current, current);
  assert.deepEqual(f.statuses, []);
});

test('switching explicitly to Legacy PPTX scans its configured source', async () => {
  const f = fixture();
  await f.initialize();
  f.api.scanServiceFolder = async () => { f.calls.scans++; throw new Error('Missing optional Drive API key'); };
  f.activate('pptx');
  await f.flushTimers();
  assert.equal(f.calls.scans, 1);
  assert.match(f.statuses.at(-1), /Could not check the service folder: Missing optional Drive API key/);
  assert.match(f.state.serviceFolder.error, /Missing optional Drive API key/);
});

test('legacy startup still compares, scans and safely loads matching legacy files', async () => {
  const f = fixture({ mode: 'pptx', scanResult: {
    scanToken: 'fresh', sets: [{ id: 'sunday', serviceDate: '2026-10-04', dateStatus: 'matches', complete: true }]
  } });
  await f.initialize();
  assert.equal(f.calls.check, 1);
  assert.equal(f.calls.scans, 1);
  assert.equal(f.calls.loads, 1);
  assert.match(f.statuses.at(-1), /Found a complete service/);
});

for (const outcome of ['success', 'failure']) {
  test(`late legacy ${outcome} cannot replace native status or auto-load after switching modes`, async () => {
    const pending = deferred();
    const f = fixture({ mode: 'pptx', scanResult: pending.promise });
    const scanning = f.scan('startup');
    assert.equal(f.calls.scans, 1);
    f.activate('syncshow');
    f.statuses.push('Community service is verified and ready');
    if (outcome === 'failure') pending.reject(new Error('Missing optional Drive API key'));
    else pending.resolve({ scanToken: 'fresh', sets: [{ id: 'old', complete: true, dateStatus: 'matches' }] });
    await scanning;
    assert.equal(f.statuses.at(-1), 'Community service is verified and ready');
    assert.equal(f.state.serviceFolder.error, null);
    assert.equal(f.state.serviceFolder.scanning, false);
    assert.equal(f.calls.loads, 0);
  });
}

test('a superseded scan stays rejected even if the operator quickly returns to Legacy', async () => {
  const pending = deferred();
  const f = fixture({ mode: 'pptx', scanResult: pending.promise });
  const scanning = f.scan('startup');
  f.activate('syncshow');
  f.activate('pptx');
  pending.resolve({ scanToken: 'obsolete', sets: [{ id: 'old', complete: true, dateStatus: 'matches' }] });
  await scanning;
  assert.equal(f.state.serviceFolder.scan, null);
  assert.equal(f.calls.loads, 0);
  assert.equal(f.state.serviceFolder.folderChangedSinceLoad, true);
});

for (const stage of ['load', 'prepare', 'show']) {
  test(`legacy folder watcher leaves native ${stage} status unchanged and defers work`, async () => {
    const f = fixture({ stage });
    f.statuses.push('Native service status');
    f.changed();
    f.resume();
    await f.flushTimers();
    assert.equal(f.calls.scans, 0);
    assert.deepEqual(f.statuses, ['Native service status']);
    assert.equal(f.state.serviceFolder.folderChangedSinceLoad, true);
  });
}

test('explicit Legacy Show still reports changed files without changing the audience screen', async () => {
  const f = fixture({ mode: 'pptx', stage: 'show' });
  f.state.presentations.english = { loaded: true };
  f.changed();
  await f.flushTimers();
  assert.equal(f.calls.scans, 0);
  assert.equal(f.calls.loads, 0);
  assert.match(f.statuses.at(-1), /live Show was not changed/);
  assert.equal(f.state.serviceFolder.folderChangedSinceLoad, true);
});

test('automatic legacy fallback cannot replace a native service even without prepared role metadata', async () => {
  const f = fixture({ current: { id: 'legacy', serviceDate: '2026-10-04' } });
  f.state.serviceFolder.current = { id: 'legacy', serviceDate: '2026-10-04' };
  f.state.serviceFolder.requestedDate = '2026-10-04';
  assert.equal(await f.autoLoad('startup'), false);
  assert.equal(f.calls.loads, 0);
});
