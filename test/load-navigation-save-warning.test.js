'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require.resolve('../src/renderer/app.js'), 'utf8');
const navigation = source.slice(source.indexOf('function setPrepareLoadWarning('), source.indexOf('async function loadAppState('));
const settle = () => new Promise(resolve => setImmediate(resolve));

function fixture() {
  let resolve, reject, timeout;
  const saving = new Promise((yes, no) => { resolve = yes; reject = no; });
  const loaded = [], notices = [];
  const state = { workflowStage: 'prepare', prepareMode: 'community', loadMode: 'syncshow', community: {}, serviceHandoff: { id: 'old' } };
  const warning = { hidden: true, textContent: '' };
  const context = vm.createContext({
    state, elements: { loadPrepareWarning: warning, btnBackToSetup: {}, btnStartPresentation: {} },
    prepareController: { isBusy: () => false },
    window: { api: { prepareCommunityPlannerForLoad: () => saving } },
    sharedServiceController: { openById: async id => loaded.push(id) },
    setWorkflowStage: async stage => { state.workflowStage = stage; },
    setStatus: text => notices.push(text), updateWorkflowNavigationAvailability: () => {}, checkReadyState: () => {},
    communityCheckedResult: result => { if (result.success === false) throw new Error(result.error.message); return result.data; },
    operatorErrorMessage: error => error.message,
    setTimeout: (callback, milliseconds) => { assert.equal(milliseconds, 3000); timeout = callback; return 1; },
    clearTimeout: () => {}, openCommunityPrepare: async () => {}, refreshLoadedService: async () => {}
  });
  vm.runInContext(navigation, context);
  return { ...context, warning, loaded, notices, resolve, reject, expire: () => timeout() };
}

test('Load opens immediately and stays usable while saving is unresolved', async () => {
  const f = fixture(), done = f.navigateWorkflowStage('load');
  assert.equal(f.state.workflowStage, 'load');
  await settle();
  assert.equal(f.warning.hidden, false);
  assert.match(f.warning.textContent, /Checking Prepare/);
  f.resolve({ success: false, error: { message: 'Save conflict' } });
  await done;
  assert.equal(f.state.workflowStage, 'load');
  assert.match(f.warning.textContent, /Save conflict/);
  assert.deepEqual(f.loaded, []);
  assert.equal(f.state.community.handoffBusy, false);
});

test('a confirmed save can load the selected service', async () => {
  const f = fixture(), done = f.navigateWorkflowStage('load');
  await settle();
  f.resolve({ success: true, data: { serviceId: 'saved' } });
  await done;
  assert.deepEqual(f.loaded, ['saved']);
  assert.equal(f.warning.hidden, true);
});

test('an older editor with no save response gives a bounded warning, never a late auto-load', async () => {
  const f = fixture(), done = f.navigateWorkflowStage('load');
  await settle();
  f.expire(); await done;
  assert.match(f.warning.textContent, /not confirmed saving/);
  f.resolve({ success: true, data: { serviceId: 'late' } });
  await settle();
  assert.deepEqual(f.loaded, []);
  assert.equal(f.state.workflowStage, 'load');
});

test('returning to Prepare during a save remains possible and cannot be overridden', async () => {
  const f = fixture(), done = f.navigateWorkflowStage('load');
  await settle();
  await f.navigateWorkflowStage('prepare');
  f.resolve({ success: true, data: { serviceId: 'late' } }); await done;
  assert.equal(f.state.workflowStage, 'prepare');
  assert.deepEqual(f.loaded, []);
});

test('an operator choice in Load prevents a late save from replacing that choice', async () => {
  const f = fixture(), done = f.navigateWorkflowStage('load');
  await settle(); f.cancelPendingPrepareLoad();
  f.resolve({ success: true, data: { serviceId: 'late' } }); await done;
  assert.deepEqual(f.loaded, []);
  assert.equal(f.state.community.handoffBusy, false);
  assert.match(f.warning.textContent, /Choose a saved service/);
});

test('starting Show while confirmation is pending cannot replace the live package', async () => {
  const f = fixture(), done = f.navigateWorkflowStage('load');
  await settle(); f.state.activeLaunchPlan = { id: 'live' };
  f.resolve({ success: true, data: { serviceId: 'late' } }); await done;
  assert.deepEqual(f.loaded, []);
});
