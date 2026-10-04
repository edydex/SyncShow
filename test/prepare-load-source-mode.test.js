'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require.resolve('../src/renderer/app.js'), 'utf8');

function functionSource(name) {
  const start = source.search(new RegExp(`^(?:async )?function ${name}\\(`, 'm'));
  assert.notEqual(start, -1);
  const next = source.slice(start + 1).search(/\n(?:async )?function /);
  return source.slice(start, next < 0 ? source.length : start + 1 + next);
}

function fixture({ mode = 'pptx', prepareMode = 'community' } = {}) {
  let resolveSave, rejectSave;
  const saving = new Promise((resolve, reject) => { resolveSave = resolve; rejectSave = reject; });
  const calls = { save: 0, refresh: 0, legacyScan: 0, cancelledStart: 0 }, opened = [], timers = new Map();
  const node = () => ({ hidden: false, attributes: {}, classList: { toggle() {} },
    setAttribute(key, value) { this.attributes[key] = value; }, removeAttribute(key) { delete this.attributes[key]; }, focus() {} });
  const elements = Object.fromEntries([
    'showAdjustPanel', 'btnShowAdjust', 'btnStagePrepare', 'btnStageLoad', 'btnStageShow',
    'appSubtitle', 'loadPrepareWarning', 'btnBackToSetup', 'btnStartPresentation'
  ].map(key => [key, node()]));
  elements.loadModeTabs = ['syncshow', 'pptx'].map(mode => ({ ...node(), dataset: { loadTab: mode } }));
  elements.loadModePanels = ['syncshow', 'pptx'].map(mode => ({ ...node(), dataset: { loadPanel: mode } }));
  const state = { workflowStage: 'prepare', prepareMode, loadMode: mode,
    community: { handoffGeneration: 0, handoffBusy: false }, serviceHandoff: { id: 'previous-package' },
    serviceFolder: { scanVersion: 0, changeTimer: null, scanning: false, folderChangedSinceLoad: true } };
  let timerId = 0;
  const statuses = [];
  const sandbox = vm.createContext({
    state, elements, document: { body: { classList: { toggle() {} } } },
    prepareController: { isBusy: () => false }, showAdjustGeneration: 0, showAdjustOpen: false,
    window: { api: { async prepareCommunityPlannerForLoad() { calls.save++; return saving; } },
      setTimeout(callback) { timers.set(++timerId, callback); return timerId; }, clearTimeout(id) { timers.delete(id); } },
    setTimeout(callback) { timers.set(++timerId, callback); return timerId; }, clearTimeout(id) { timers.delete(id); },
    sharedServiceController: { async openById(id, options) { opened.push({ id, options }); } },
    cancelQueuedStart() { calls.cancelledStart++; }, placeServiceInputCards() {}, refreshLoadLocalServices() {},
    scheduleCommunityPlannerLayout() {}, updateWorkflowNavigationAvailability() {}, checkReadyState() {},
    activatePrepareMode() { return Promise.resolve(true); }, openCommunityPrepare: async () => {},
    async refreshLoadedService() { calls.refresh++; },
    isLoadStage: () => state.workflowStage === 'load', hasConfiguredServiceSource: () => true,
    async scanLinkedServiceFolder() { calls.legacyScan++; },
    setStatus(message) { statuses.push(message); }, operatorErrorMessage: error => error.message,
    communityCheckedResult(result) { if (result.success === false) throw new Error(result.error.message); return result.data; }
  });
  vm.runInContext([
    'activateLoadMode', 'invalidateServiceFolderScan', 'resumeServiceFolderScanOnLoad',
    'setWorkflowStage', 'setPrepareLoadWarning', 'cancelPendingPrepareLoad', 'navigateWorkflowStage'
  ].map(functionSource).join('\n'), sandbox);
  return { state, elements, calls, opened, timers, statuses, resolveSave, rejectSave,
    navigate: stage => sandbox.navigateWorkflowStage(stage),
    activate: mode => sandbox.activateLoadMode(mode), cancelPending: () => sandbox.cancelPendingPrepareLoad(),
    async flushTimers() {
      const callbacks = [...timers.values()]; timers.clear();
      for (const callback of callbacks) await callback();
    }
  };
}

const settle = () => new Promise(resolve => setImmediate(resolve));

test('Community Prepare returns to native Load after the operator previously used Legacy PPTX', async () => {
  const f = fixture(), opening = f.navigate('load');
  assert.equal(f.state.workflowStage, 'load', 'Load remains immediately available while saving');
  assert.equal(f.state.loadMode, 'syncshow');
  await settle();
  assert.equal(f.calls.save, 1);
  assert.equal(f.state.community.handoffBusy, true);
  assert.match(f.elements.loadPrepareWarning.textContent, /Checking Prepare/);
  assert.deepEqual(f.opened, []);
  f.resolveSave({ success: true, data: { serviceId: 'saved-current-service' } });
  await opening;
  assert.deepEqual(f.opened.map(item => item.id), ['saved-current-service']);
  assert.equal(f.opened[0].options.fresh, false, 'reuse the exact confirmed save rather than importing twice');
  assert.equal(f.elements.loadPrepareWarning.hidden, true);
  assert.equal(f.state.community.handoffBusy, false);
  assert.equal(f.calls.cancelledStart, 1, 'the source switch fences a start queued for the old legacy source');
  await f.flushTimers();
  assert.equal(f.calls.legacyScan, 0, 'a pending legacy folder scan cannot run after returning from Community Prepare');
  assert.equal(f.elements.loadModePanels.find(panel => panel.dataset.loadPanel === 'pptx').hidden, true);
});

test('failed Prepare save keeps the previous package and gives a visible native Load warning', async () => {
  const f = fixture(), previous = f.state.serviceHandoff, opening = f.navigate('load');
  await settle();
  f.resolveSave({ success: false, error: { message: 'The service did not save' } });
  await opening;
  assert.equal(f.calls.save, 1);
  assert.equal(f.state.loadMode, 'syncshow');
  assert.equal(f.state.serviceHandoff, previous);
  assert.match(f.elements.loadPrepareWarning.textContent, /The service did not save/);
  assert.equal(f.elements.loadPrepareWarning.hidden, false);
  assert.deepEqual(f.opened, []);
});

test('choosing Legacy explicitly while Prepare saving is pending prevents a late native replacement', async () => {
  const f = fixture(), opening = f.navigate('load');
  await settle();
  assert.equal(f.calls.save, 1);
  f.cancelPending();
  f.activate('pptx');
  f.resolveSave({ success: true, data: { serviceId: 'late-native-service' } });
  await opening;
  assert.equal(f.state.loadMode, 'pptx');
  assert.deepEqual(f.opened, []);
  assert.equal(f.elements.loadModeTabs.find(tab => tab.dataset.loadTab === 'pptx').attributes['aria-selected'], 'true');
  assert.match(f.elements.loadPrepareWarning.textContent, /Choose a saved service/);
});

test('returning to Prepare fences a pending save after automatically choosing native Load', async () => {
  const f = fixture(), opening = f.navigate('load');
  await settle();
  assert.equal(f.calls.save, 1);
  await f.navigate('prepare');
  f.resolveSave({ success: true, data: { serviceId: 'late-native-service' } });
  await opening;
  assert.equal(f.state.workflowStage, 'prepare');
  assert.deepEqual(f.opened, []);
});

test('normal native Prepare handoff remains one checked save and one package load', async () => {
  const f = fixture({ mode: 'syncshow' }), opening = f.navigate('load');
  await settle();
  f.resolveSave({ success: true, data: { serviceId: 'saved-native-service' } });
  await opening;
  assert.equal(f.calls.save, 1);
  assert.deepEqual(f.opened.map(item => item.id), ['saved-native-service']);
  assert.equal(f.calls.cancelledStart, 0);
});

test('an explicit Legacy mode is preserved when navigation does not hand off Community Prepare', async () => {
  const f = fixture();
  f.state.workflowStage = 'show';
  await f.navigate('load');
  assert.equal(f.state.loadMode, 'pptx');
  assert.equal(f.calls.save, 0);
  assert.deepEqual(f.opened, []);
});
