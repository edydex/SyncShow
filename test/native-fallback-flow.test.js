'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), vm = require('node:vm');
const app = fs.readFileSync(require.resolve('../src/renderer/app.js'), 'utf8');
const main = fs.readFileSync(require.resolve('../main.js'), 'utf8');

function rendererFixture({ wrongRevision = false } = {}) {
  const revisionId = 'a'.repeat(64), context = { project: { id: 'today', title: 'Today' }, revisionId };
  const state = { queuedStart: { mode: 'syncshow', serviceId: 'old' }, loadMode: 'syncshow', nativeLoadError: 'Text overflow' };
  const sandbox = vm.createContext({ state, window: { api: { getAppState: async () => ({
    currentSlide: 0, totalSlides: 2, presentations: {
      english: { loaded: true, slideCount: 2, nativeFallback: { projectId: 'today', revisionId: wrongRevision ? 'b'.repeat(64) : revisionId } }
    }
  }) } }, resetServiceOutputChoices() {}, applyServiceHandoff(value) { state.serviceHandoff = value; },
    activateLoadMode(mode) { state.loadMode = mode; }, applyRuntimePresentationState(value) { state.presentations = value; },
    async loadSlidesIfNeeded() {}, renderThumbnails() {}, renderInputCards() {}, checkReadyState() {},
    setStatus(value) { state.status = value; }, setWorkflowStage(value) { state.workflowStage = value; },
    failNativeServiceLoad(value) { state.nativeLoadError = value; }, console: { error() {} } });
  vm.runInContext(app.slice(app.indexOf('async function refreshPublishedProject('), app.indexOf('// Load saved user settings')), sandbox);
  return { state, context, refresh: () => sandbox.refreshPublishedProject({ success: true, legacyFallback: {
    projectId: 'today', revisionId, title: 'Today', cueCount: 2, roleIds: ['english']
  } }, context) };
}

test('fallback switches Load and its queued Start to verified exact converted decks', async () => {
  const f = rendererFixture();
  await f.refresh();
  assert.equal(f.state.nativeLoadError, null);
  assert.equal(f.state.loadMode, 'pptx');
  assert.equal(f.state.queuedStart.mode, 'pptx');
  assert.equal(f.state.queuedStart.serviceId, null);
  assert.equal(f.state.serviceHandoff, null);
  assert.equal(f.state.totalSlides, 2);
  assert.match(f.state.loadActionNotice.message, /selected service/);
});

test('fallback cannot claim readiness for another converted revision', async () => {
  const f = rendererFixture({ wrongRevision: true });
  await assert.rejects(f.refresh(), /verify the converted service/);
  assert.equal(f.state.loadMode, 'syncshow');
  assert.match(f.state.nativeLoadError, /could not refresh/);
});

function mainFixture({ cancel = false, superseded = false } = {}) {
  const calls = [], selected = { project: { id: 'today', title: 'Today', serviceDate: '2026-10-04' }, revisionId: 'a'.repeat(64) };
  class Fallback {
    async build(request) { calls.push(['build', request.projectId, request.revisionId]); return { presentations: { english: {} } }; }
    async activate() { calls.push(['activate']); }
  }
  const sandbox = vm.createContext({ dialog: { showMessageBox: async () => { calls.push(['prompt']); return { response: cancel ? 2 : 0 }; } },
    controlWindow: {}, LegacyServiceFallback: Fallback, path: require('node:path'), app: { getPath: () => '/isolated' },
    CONFIG: { cacheDir: '/isolated/cache' }, browserSlideRenderer() {}, appState: { activeLaunchPlan: null },
    getPrepareServices: () => ({ serviceProjectStore: { read: async () => selected } }),
    beginPresentationMutation: () => () => { calls.push(['released']); },
    async deactivateCurrentPreparedService() { calls.push(['deactivate']); },
    installPreparedPresentations() { calls.push(['install']); }, compileServiceProject: () => ({ cueIds: ['cue'] }),
    failMainOperation: (_code, message) => { throw new Error(message); } });
  vm.runInContext(main.slice(main.indexOf('async function offerLegacyServiceFallback('), main.indexOf("ipcMain.handle('prepare:projects:publish'")), sandbox);
  return { calls, selected, offer: () => sandbox.offerLegacyServiceFallback(new Error('Text overflow'), selected, { english: 'primary' }, () => !superseded) };
}

test('fallback prompt binds conversion and installation to the exact failed service', async () => {
  const f = mainFixture(), result = await f.offer();
  assert.equal(result.legacyFallback.projectId, 'today');
  assert.deepEqual(f.calls.map(call => call[0]), ['prompt', 'build', 'activate', 'deactivate', 'install', 'released']);
  assert.equal(f.calls[1][2], f.selected.revisionId);
});

test('cancel and superseded selection cannot convert or replace old loaded material', async () => {
  for (const options of [{ cancel: true }, { superseded: true }]) {
    const f = mainFixture(options);
    await assert.rejects(f.offer(), /Text overflow/);
    assert.ok(f.calls.every(call => call[0] === 'prompt'));
  }
});
