'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require.resolve('../src/renderer/app.js'), 'utf8');
const queueSource = source.slice(source.indexOf('function notifyLoadWork('), source.indexOf('function confirmPreparedServiceDate('));

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

function fixture(options = {}) {
  const check = deferred();
  const starts = [], checks = [], statuses = [];
  const node = () => ({ hidden: false, dataset: {}, attributes: {}, setAttribute(key, value) { this.attributes[key] = value; } });
  const spinner = node();
  const elements = { btnStartPresentation: node(), btnTestOutput: node(), loadActionStatus: node(),
    loadActionMessage: node(), btnCancelLoadAction: node() };
  elements.loadActionStatus.querySelector = () => spinner;
  const state = { workflowStage: 'load', loadMode: 'syncshow', queuedStart: null, loadActionNotice: null,
    serviceHandoff: { project: { id: 'sunday', revisionId: 'a'.repeat(64) } },
    community: { handoffBusy: false }, presentations: {}, serviceFolder: { loading: false },
    loadFreshness: { busy: false }, initializingLoad: false };
  const sandbox = vm.createContext({ state, elements,
    sharedServiceController: { isBusy: () => false },
    renderPresentationMode() {}, renderTestOutputSettings() {}, renderReadiness() {},
    setStatus(message) { statuses.push(message); },
    getReadinessState() { return { isReady: !options.issue, issues: options.issue ? [options.issue] : [], needsChoices: [] }; },
    operatorErrorMessage: error => error.message,
    async refreshLoadedService(request) {
      checks.push(request);
      state.loadFreshness.busy = true;
      state.loadFreshness.message = 'Checking for updates…';
      sandbox.renderLoadActionStatus();
      const result = options.immediate || await check.promise;
      state.loadFreshness.busy = false;
      state.loadFreshness.lastResult = result;
      state.loadFreshness.message = result.state === 'prepare-pending' ? 'Prepare has pending edits.' : '';
      sandbox.checkReadyState();
      return result;
    },
    async beginStartPresentation(testOutput) { starts.push({ testOutput, notice: sandbox.offlineLaunchNotice() }); }
  });
  vm.runInContext('const loadWorkWaiters = new Set();\n' + queueSource, sandbox);
  sandbox.checkReadyState();
  return { state, elements, spinner, starts, checks, statuses, check,
    start: value => sandbox.startPresentation(value), cancel: () => sandbox.cancelQueuedStart(),
    changed: () => sandbox.checkReadyState() };
}

test('a click is accepted immediately, shows progress and starts once when ready', async () => {
  const f = fixture();
  const first = f.start(false);
  assert.equal(f.elements.btnStartPresentation.attributes['aria-busy'], 'true');
  assert.equal(f.spinner.hidden, false);
  assert.equal(f.elements.btnCancelLoadAction.hidden, false);
  assert.match(f.elements.loadActionMessage.textContent, /continue automatically/);
  assert.equal(f.start(true), first, 'a repeated or other launch click cannot queue a second show');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.checks.length, 1);
  assert.equal(f.checks[0].reuseRecent, true);
  f.check.resolve({ state: 'current' });
  await first;
  assert.equal(f.starts.length, 1);
  assert.equal(f.starts[0].testOutput, false);
  assert.equal(f.elements.btnStartPresentation.attributes['aria-busy'], 'false');
});

test('Test Output waits for loading and Prepare handoff instead of dropping the click', async () => {
  const f = fixture({ immediate: { state: 'current' } });
  f.state.community.handoffBusy = true;
  f.state.presentations.english = { pending: true };
  const opening = f.start(true);
  assert.match(f.elements.loadActionMessage.textContent, /Saving Prepare/);
  assert.equal(f.checks.length, 0);
  f.state.community.handoffBusy = false;
  f.changed();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.starts.length, 0);
  f.state.presentations.english.pending = false;
  f.changed();
  await opening;
  assert.equal(f.starts.length, 1);
  assert.equal(f.starts[0].testOutput, true);
});

test('initial startup and a check already in flight can accept a Start click', async () => {
  for (const key of ['initializingLoad', 'busy']) {
    const f = fixture({ immediate: { state: 'current' } });
    if (key === 'busy') f.state.loadFreshness.busy = true;
    else f.state.initializingLoad = true;
    const opening = f.start(false);
    assert.equal(f.spinner.hidden, false);
    assert.equal(f.starts.length, 0);
    f.state.initializingLoad = false;
    f.state.loadFreshness.busy = false;
    f.changed();
    await opening;
    assert.equal(f.starts.length, 1);
  }
});

test('Cancel prevents a late network result from opening outputs', async () => {
  const f = fixture();
  const opening = f.start(false);
  await new Promise(resolve => setImmediate(resolve));
  f.cancel();
  assert.equal(f.state.queuedStart, null);
  assert.match(f.elements.loadActionMessage.textContent, /cancelled/);
  f.check.resolve({ state: 'updated' });
  await opening;
  assert.equal(f.starts.length, 0);
  assert.equal(f.elements.btnStartPresentation.disabled, false);
});

test('navigation or selecting another service prevents an obsolete queued start', async () => {
  for (const change of [f => { f.state.workflowStage = 'prepare'; }, f => { f.state.serviceHandoff.project.id = 'next-week'; }]) {
    const f = fixture(), opening = f.start(false);
    await new Promise(resolve => setImmediate(resolve));
    change(f);
    f.check.resolve({ state: 'current' });
    await opening;
    assert.equal(f.starts.length, 0);
    assert.equal(f.state.queuedStart, null);
  }
});

test('offline fallback continues once and clearly names the saved local copy', async () => {
  const f = fixture({ immediate: { state: 'unavailable', offline: true } });
  await f.start(true);
  assert.equal(f.starts.length, 1);
  assert.match(f.starts[0].notice, /No internet connection.*saved local copy/);
  assert.match(f.elements.loadActionMessage.textContent, /latest version could not be checked/);
  assert.equal(f.elements.loadActionStatus.dataset.kind, 'warning');
});

test('pending drafts, conflicts and setup issues explain why a queued start cannot proceed', async () => {
  for (const outcome of ['prepare-pending', 'conflict', 'superseded']) {
    const f = fixture({ immediate: { state: outcome } });
    await f.start(false);
    assert.equal(f.starts.length, 0);
    assert.equal(f.elements.loadActionStatus.dataset.kind, 'warning');
  }
  const f = fixture({ immediate: { state: 'current' }, issue: 'Connect an external presentation screen' });
  assert.equal(f.elements.btnStartPresentation.disabled, false, 'a configuration issue should explain itself on click');
  await f.start(false);
  assert.match(f.elements.loadActionMessage.textContent, /Connect an external/);
  assert.equal(f.starts.length, 0);
});
