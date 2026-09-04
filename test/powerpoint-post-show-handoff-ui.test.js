'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const appSource = fs.readFileSync(
  path.join(root, 'src', 'renderer', 'app.js'),
  'utf8'
);
const controllerSource = fs.readFileSync(
  path.join(root, 'src', 'renderer', 'prepare-controller.js'),
  'utf8'
);
const htmlSource = fs.readFileSync(
  path.join(root, 'src', 'renderer', 'index.html'),
  'utf8'
);

function functionSource(source, name) {
  const markers = [`function ${name}(`, `async function ${name}(`];
  const start = markers
    .map(marker => source.indexOf(marker))
    .filter(index => index >= 0)
    .sort((left, right) => left - right)[0];
  assert.notEqual(start, undefined, `${name} must exist`);
  const tail = source.slice(start + 1);
  const next = tail.match(/\n\s*(?:async\s+)?function\s+[A-Za-z_$][\w$]*\s*\(/u);
  return source.slice(
    start,
    next ? start + 1 + next.index : source.length
  );
}

function executeFunctions(source, names, context, exports) {
  const declarations = names.map(name => functionSource(source, name)).join('\n');
  const exportSource = exports
    .map(name => `${JSON.stringify(name)}: ${name}`)
    .join(',');
  vm.runInNewContext(
    `${declarations}\nglobalThis.testExports = {${exportSource}};`,
    context,
    { filename: 'renderer-handoff-test.js' }
  );
  return context.testExports;
}

function classList(initial = []) {
  const values = new Set(initial);
  return {
    contains: value => values.has(value),
    toggle(value, force) {
      if (force === false) values.delete(value);
      else if (force === true) values.add(value);
      else if (values.has(value)) values.delete(value);
      else values.add(value);
    }
  };
}

function dialogElements() {
  const dialog = {
    dataset: {},
    open: false,
    showModal() {
      this.open = true;
    },
    close() {
      this.open = false;
    }
  };
  return {
    showHandoffDialog: dialog,
    showHandoffTitle: {
      focused: false,
      focus() {
        this.focused = true;
      }
    },
    showHandoffDescription: { textContent: '' },
    showHandoffServiceTitle: { textContent: '' },
    showHandoffServiceMeta: { textContent: '' },
    btnShowHandoffCompleted: { hidden: false },
    btnShowHandoffFollowUp: { hidden: false },
    btnOpenShowSermonHandoff: {
      textContent: '',
      classList: classList(['btn', 'btn-outline'])
    },
    btnCloseShowHandoff: { textContent: '' },
    btnStageLoad: { focus() {} }
  };
}

function powerPointReceipt(overrides = {}) {
  return {
    schemaVersion: 1,
    serviceDate: '2026-07-27',
    receiptToken: 'r'.repeat(32),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    ...overrides
  };
}

test('PowerPoint receipt normalization is path-free, exact, and expiry-aware', () => {
  const context = { Date, Number, Object };
  const { normalizePowerPointServiceHandoff } = executeFunctions(
    appSource,
    ['normalizePowerPointServiceHandoff'],
    context,
    ['normalizePowerPointServiceHandoff']
  );
  const now = Date.now();
  const normalized = normalizePowerPointServiceHandoff(
    powerPointReceipt({
      expiresAt: new Date(now + 60_000).toISOString()
    }),
    now
  );
  assert.equal(normalized.serviceDate, '2026-07-27');
  assert.equal(normalized.receiptToken, 'r'.repeat(32));
  assert.equal(Object.isFrozen(normalized), true);
  assert.equal(
    normalizePowerPointServiceHandoff({
      ...powerPointReceipt(),
      sourcePath: '/private/service.pptx'
    }, now),
    null,
    'unexpected fields, including paths, must invalidate the receipt'
  );
  assert.equal(
    normalizePowerPointServiceHandoff(
      powerPointReceipt({
        expiresAt: new Date(now).toISOString()
      }),
      now
    ),
    null
  );
  assert.equal(
    normalizePowerPointServiceHandoff(
      powerPointReceipt({ receiptToken: 'short' }),
      now
    ),
    null
  );
});

test('native planning handoff wins over a simultaneous PowerPoint receipt', () => {
  const elements = dialogElements();
  const state = {
    serviceHandoff: {
      planning: { startTime: '10:30' },
      project: {
        title: 'Reviewed native service',
        serviceDate: '2026-07-27',
        revision: 8,
        revisionId: 'a'.repeat(64)
      }
    },
    showHandoffMode: null,
    postShowPowerPointHandoff: null
  };
  const context = {
    Date,
    Number,
    Object,
    state,
    elements,
    formatServiceDate: value => value,
    formatServiceStartTime: value => value,
    setShowHandoffError() {},
    setShowHandoffBusy() {},
    window: { setTimeout(callback) { callback(); } }
  };
  const { openShowHandoffDialog } = executeFunctions(
    appSource,
    ['normalizePowerPointServiceHandoff', 'openShowHandoffDialog'],
    context,
    ['openShowHandoffDialog']
  );
  assert.equal(openShowHandoffDialog(powerPointReceipt()), true);
  assert.equal(state.showHandoffMode, 'native');
  assert.equal(state.postShowPowerPointHandoff, null);
  assert.equal(elements.btnShowHandoffCompleted.hidden, false);
  assert.equal(elements.btnShowHandoffFollowUp.hidden, false);
  assert.equal(
    elements.showHandoffServiceTitle.textContent,
    'Reviewed native service'
  );
});

test('PowerPoint mode offers only exact sermon follow-up and Not now', () => {
  const elements = dialogElements();
  const state = {
    serviceHandoff: null,
    showHandoffMode: null,
    postShowPowerPointHandoff: null
  };
  const context = {
    Date,
    Number,
    Object,
    state,
    elements,
    formatServiceDate: value => value,
    formatServiceStartTime: value => value,
    setShowHandoffError() {},
    setShowHandoffBusy() {},
    window: { setTimeout(callback) { callback(); } }
  };
  const { openShowHandoffDialog } = executeFunctions(
    appSource,
    ['normalizePowerPointServiceHandoff', 'openShowHandoffDialog'],
    context,
    ['openShowHandoffDialog']
  );
  assert.equal(openShowHandoffDialog(powerPointReceipt()), true);
  assert.equal(state.showHandoffMode, 'powerpoint');
  assert.equal(elements.btnShowHandoffCompleted.hidden, true);
  assert.equal(elements.btnShowHandoffFollowUp.hidden, true);
  assert.equal(
    elements.btnOpenShowSermonHandoff.textContent,
    'Open sermon follow-up'
  );
  assert.equal(elements.btnCloseShowHandoff.textContent, 'Not now');
  assert.equal(
    elements.showHandoffDescription.textContent.includes(
      'nothing here publishes to Community'
    ),
    true
  );
  assert.match(
    htmlSource,
    /id="btnOpenShowSermonHandoff"[^>]*aria-controls="preparePanel"/
  );
});

test('manual, mixed, or unverified shows have no renderer fallback prompt', () => {
  const elements = dialogElements();
  const state = {
    serviceHandoff: null,
    showHandoffMode: null,
    postShowPowerPointHandoff: null
  };
  const context = {
    Date,
    Number,
    Object,
    state,
    elements,
    formatServiceDate: value => value,
    formatServiceStartTime: value => value,
    setShowHandoffError() {},
    setShowHandoffBusy() {},
    window: { setTimeout(callback) { callback(); } }
  };
  const { openShowHandoffDialog } = executeFunctions(
    appSource,
    ['normalizePowerPointServiceHandoff', 'openShowHandoffDialog'],
    context,
    ['openShowHandoffDialog']
  );
  assert.equal(openShowHandoffDialog(null), false);
  assert.equal(openShowHandoffDialog({ serviceDate: '2026-07-27' }), false);
  assert.equal(elements.showHandoffDialog.open, false);
  assert.equal(state.showHandoffMode, null);
});

test('Back to Load waits for endSession and passes only its verified receipt', async () => {
  const events = [];
  const receipt = powerPointReceipt();
  const state = {
    isPresenting: true,
    activeLaunchPlan: {},
    showEndSessionBusy: false,
    showState: null,
    bible: {
      isLive: false,
      liveOutputIds: []
    }
  };
  const context = {
    console: { error() {} },
    state,
    elements: {
      bibleDialog: { open: false, close() {} },
      btnBackToSetup: {
        disabled: false,
        setAttribute() {},
        removeAttribute() {}
      }
    },
    updateShowEndSessionBarrier() {},
    beginShowOutputAction() {
      events.push('begin');
      return { id: 1 };
    },
    applyShowOutputActionResult() {
      events.push('applied');
      return true;
    },
    updateBibleLiveIndicator() {},
    setWorkflowStage(stage) {
      events.push(`stage:${stage}`);
    },
    setStatus() {},
    openShowHandoffDialog(value) {
      events.push('dialog');
      assert.equal(value, receipt);
    },
    showOutputActionCanReportError() {
      return true;
    },
    showOutputActionError() {},
    window: {
      api: {
        async endPresentation() {
          events.push('end');
          return {
            success: true,
            showState: null,
            powerPointServiceHandoff: receipt
          };
        }
      }
    }
  };
  const { backToSetup } = executeFunctions(
    appSource,
    ['backToSetup'],
    context,
    ['backToSetup']
  );
  await backToSetup('load');
  assert.ok(events.indexOf('end') < events.indexOf('stage:load'));
  assert.ok(events.indexOf('stage:load') < events.indexOf('dialog'));
});

test('a no-handoff Finish moves focus onto the visible Load stage', async () => {
  let loadFocused = 0;
  const state = {
    isPresenting: true,
    activeLaunchPlan: {},
    showEndSessionBusy: false,
    showState: null,
    bible: { isLive: false, liveOutputIds: [] }
  };
  const context = {
    console: { error() {} },
    state,
    elements: {
      bibleDialog: { open: false, close() {} },
      btnBackToSetup: {
        setAttribute() {},
        removeAttribute() {}
      },
      btnStageLoad: {
        focus() {
          loadFocused += 1;
        }
      },
      btnStagePrepare: { focus() {} }
    },
    updateShowEndSessionBarrier() {},
    beginShowOutputAction: () => ({ id: 1 }),
    applyShowOutputActionResult: () => true,
    updateBibleLiveIndicator() {},
    setWorkflowStage() {},
    setStatus() {},
    openShowHandoffDialog: () => false,
    showOutputActionCanReportError: () => true,
    showOutputActionError() {},
    window: {
      api: {
        async endPresentation() {
          return { success: true, showState: null };
        }
      }
    }
  };
  const { backToSetup } = executeFunctions(
    appSource,
    ['backToSetup'],
    context,
    ['backToSetup']
  );

  await backToSetup('load');
  assert.equal(loadFocused, 1);
});

test('Finish service admits only one in-flight endSession and retains its receipt', async () => {
  let resolveEnd;
  let endCalls = 0;
  let handoffCalls = 0;
  const receipt = powerPointReceipt();
  const state = {
    isPresenting: true,
    activeLaunchPlan: {},
    showEndSessionBusy: false,
    showState: null,
    bible: { isLive: false, liveOutputIds: [] }
  };
  const context = {
    console: { error() {} },
    state,
    elements: {
      bibleDialog: { open: false, close() {} },
      btnBackToSetup: {
        disabled: false,
        setAttribute() {},
        removeAttribute() {}
      }
    },
    updateShowEndSessionBarrier() {},
    beginShowOutputAction: () => ({ id: 1 }),
    applyShowOutputActionResult: () => true,
    updateBibleLiveIndicator() {},
    setWorkflowStage() {},
    setStatus() {},
    openShowHandoffDialog(value) {
      handoffCalls += 1;
      assert.equal(value, receipt);
    },
    showOutputActionCanReportError: () => true,
    showOutputActionError() {},
    window: {
      api: {
        endPresentation() {
          endCalls += 1;
          return new Promise(resolve => {
            resolveEnd = resolve;
          });
        }
      }
    }
  };
  const { backToSetup } = executeFunctions(
    appSource,
    ['backToSetup'],
    context,
    ['backToSetup']
  );

  const first = backToSetup('load');
  const second = backToSetup('load');
  await second;
  assert.equal(endCalls, 1);
  assert.equal(state.showEndSessionBusy, true);
  resolveEnd({
    success: true,
    showState: null,
    powerPointServiceHandoff: receipt
  });
  await first;
  assert.equal(endCalls, 1);
  assert.equal(handoffCalls, 1);
  assert.equal(state.showEndSessionBusy, false);
});

test('a pending Finish service rejects Clear before it can supersede the handoff receipt', async () => {
  let beginCalls = 0;
  let clearCalls = 0;
  let status = '';
  const context = {
    state: { showEndSessionBusy: true },
    setStatus(message) {
      status = message;
    },
    beginShowOutputAction() {
      beginCalls += 1;
      return { id: beginCalls };
    },
    applyShowOutputActionResult() {
      throw new Error('Clear must not reach result handling');
    },
    showOutputActionCanReportError: () => true,
    showOutputActionError() {},
    setPreviewsBlacked() {},
    console,
    window: {
      api: {
        clearDisplays() {
          clearCalls += 1;
          return Promise.resolve({ success: true });
        }
      }
    }
  };
  const { clearDisplays } = executeFunctions(
    appSource,
    ['showEndSessionBlocksAction', 'clearDisplays'],
    context,
    ['clearDisplays']
  );

  await clearDisplays();
  assert.equal(beginCalls, 0);
  assert.equal(clearCalls, 0);
  assert.match(status, /Finishing the service safely/);
});

test('Stop outputs never offers PowerPoint post-service follow-up', async () => {
  let prompts = 0;
  const context = {
    console,
    state: { isPresenting: true },
    showEndSessionBlocksAction: () => false,
    beginShowOutputAction: () => ({ id: 1 }),
    applyShowOutputActionResult: () => true,
    setStatus() {},
    showOutputActionCanReportError: () => true,
    showOutputActionError() {},
    openShowHandoffDialog() {
      prompts += 1;
    },
    window: {
      api: {
        async stopPresentation() {
          return {
            success: true,
            showState: null,
            powerPointServiceHandoff: powerPointReceipt()
          };
        }
      }
    }
  };
  const { stopDisplays } = executeFunctions(
    appSource,
    ['stopDisplays'],
    context,
    ['stopDisplays']
  );
  await stopDisplays();
  assert.equal(prompts, 0);
});

function postShowActionHarness({
  handoff = powerPointReceipt(),
  openResult = { opened: true, sermonOpened: true }
} = {}) {
  const calls = [];
  const elements = dialogElements();
  elements.showHandoffDialog.open = true;
  const state = {
    showHandoffMode: 'powerpoint',
    postShowPowerPointHandoff: handoff,
    showHandoffBusy: false,
    serviceHandoff: null
  };
  const context = {
    console: { error() {} },
    Date,
    state,
    elements,
    prepareController: {
      async activate(options) {
        calls.push(['activate', options]);
      },
      async openCurrentServiceCompanion(options) {
        calls.push(['open', options]);
        return openResult;
      }
    },
    setShowHandoffBusy(value) {
      state.showHandoffBusy = value;
    },
    setShowHandoffError(message) {
      calls.push(['error', message]);
    },
    operatorErrorMessage(error, fallback) {
      return error?.message || fallback;
    },
    setWorkflowStage(stage, options) {
      calls.push(['stage', stage, options]);
    },
    setStatus(message) {
      calls.push(['status', message]);
    },
    window: {
      setTimeout(callback) {
        callback();
      }
    }
  };
  const exports = executeFunctions(
    appSource,
    ['resetShowHandoffContext', 'openPostShowSermonHandoff'],
    context,
    ['openPostShowSermonHandoff']
  );
  return {
    calls,
    elements,
    state,
    open: exports.openPostShowSermonHandoff
  };
}

test('PowerPoint action activates Prepare with only the sealed receipt', async () => {
  const harness = postShowActionHarness();
  await harness.open();
  const activateCall = harness.calls.find(call => call[0] === 'activate');
  const openCall = harness.calls.find(call => call[0] === 'open');
  assert.equal(activateCall[0], 'activate');
  assert.equal(activateCall[1].exactPostShowHandoff, true);
  assert.equal(
    openCall[1].receiptToken,
    'r'.repeat(32)
  );
  assert.equal(
    openCall[1].expectedServiceDate,
    '2026-07-27'
  );
  assert.equal(
    openCall[1].exactPostShowHandoff,
    true
  );
  assert.equal(
    harness.calls.some(call => call[0] === 'stage' && call[1] === 'prepare'),
    true
  );
  const stageCall = harness.calls.find(
    call => call[0] === 'stage' && call[1] === 'prepare'
  );
  assert.equal(stageCall[2].exactPostShowHandoff, true);
  assert.equal(harness.elements.showHandoffDialog.open, false);
});

test('the Prepare stage keeps the receipt-only activation mode after exact open', () => {
  const source = functionSource(appSource, 'setWorkflowStage');
  assert.match(
    source,
    /activatePrepareMode\(requestedMode, activationOptions\)/
  );
  const modeSource = functionSource(appSource, 'activatePrepareMode');
  assert.match(modeSource, /prepareController\?\.activate\(options\)/);
  const action = functionSource(appSource, 'openPostShowSermonHandoff');
  assert.match(
    action,
    /setWorkflowStage\('prepare', \{\s*localTools: true,\s*exactPostShowHandoff: true\s*\}\)/
  );
});

test('expired or rejected receipts stay in Load and never open a generic current set', async () => {
  const expired = postShowActionHarness({
    handoff: powerPointReceipt({
      expiresAt: new Date(Date.now() - 1).toISOString()
    })
  });
  await expired.open();
  assert.equal(expired.calls.some(call => call[0] === 'activate'), false);
  assert.equal(expired.calls.some(call => call[0] === 'open'), false);
  assert.equal(expired.calls.some(call => call[0] === 'stage'), false);

  const rejected = postShowActionHarness({
    openResult: {
      opened: false,
      sermonOpened: false,
      error: 'The ended PowerPoint service changed.'
    }
  });
  await rejected.open();
  assert.equal(
    rejected.calls.some(call => call[0] === 'stage'),
    false
  );
  assert.equal(rejected.elements.showHandoffDialog.open, true);
});

function companionControllerHarness({
  inspectResults = null,
  openResults = null
} = {}) {
  const calls = {
    inspectReceipt: 0,
    open: 0,
    genericInspect: 0,
    community: 0,
    relationships: 0
  };
  const summaries = inspectResults || [{
    available: true,
    serviceSet: {
      name: 'Sunday Service',
      serviceDate: '2026-07-27',
      profileName: 'Main Sanctuary'
    },
    sources: [{
      roleId: 'english',
      roleLabel: 'English',
      fileName: 'service.pptx'
    }],
    exists: true,
    projectId: 'companion',
    inspectionToken: 'i'.repeat(32),
    expiresAt: new Date(Date.now() + 60_000).toISOString()
  }];
  const linked = {
    resourceId: 'sermon-resource',
    resource: {
      kind: 'sermon',
      sha256: 'a'.repeat(64)
    }
  };
  const project = {
    id: 'companion',
    items: {
      sermon: {
        id: 'sermon',
        kind: 'group',
        groupKind: 'sermon'
      }
    }
  };
  const successfulOpen = {
    project,
    revisionId: 'b'.repeat(64),
    anchorItemId: 'sermon',
    companion: summaries[summaries.length - 1]
  };
  const queuedOpenResults = openResults || [];
  const state = {
    available: true,
    currentServiceCompanionBusy: false,
    mutationBusy: false,
    publishBusy: false,
    currentServiceCompanion: null,
    currentProject: null,
    revisionId: null,
    selectedItemId: null,
    selectedArrangementId: null,
    undoStack: [],
    redoStack: [],
    collapsedGroupIds: new Set(),
    previewRequest: 0,
    previewResult: null
  };
  const context = {
    console,
    Date,
    Promise,
    state,
    elements: {
      btnReviewSermonPostService: { disabled: false, focus() {} },
      sermonSource: { focus() {} },
      sermonPostService: { scrollIntoView() {} }
    },
    api: {
      async inspectPostShowPowerPointService() {
        const result = summaries[Math.min(
          calls.inspectReceipt,
          summaries.length - 1
        )];
        calls.inspectReceipt += 1;
        return result;
      },
      async inspectCurrentServiceCompanion() {
        calls.genericInspect += 1;
        throw new Error('generic inspection must not run');
      },
      async openCurrentServiceCompanion() {
        const result = queuedOpenResults[calls.open] || successfulOpen;
        calls.open += 1;
        return result;
      }
    },
    checkedResult(result) {
      if (result?.success === false) {
        const error = new Error(result.error?.message || 'failed');
        error.code = result.error?.code;
        throw error;
      }
      return result;
    },
    normalizeCurrentServiceCompanionSummary: value => value,
    renderCurrentServiceCompanion() {},
    setNotice() {},
    updateControlStates() {},
    resolveCurrentServiceCompanionHandoff: () => ({ linked }),
    applyProjectResult(result) {
      state.currentProject = result.project;
      state.revisionId = result.revisionId;
      return result;
    },
    resetSermonInspectorSelection() {},
    loadProjects: async () => true,
    errorMessage: (error, fallback) => error?.message || fallback,
    loadCurrentServiceCompanion: async () => {
      calls.genericInspect += 1;
      throw new Error('generic inspection must not run');
    },
    renderAll() {},
    openSermonPacketDialog() {},
    ensureSelectedSermonAttachmentHealth: async () => true,
    loadSelectedSermonServiceRelationships: async () => {
      calls.relationships += 1;
      return true;
    },
    loadSelectedSermonCommunityState: async () => {
      calls.community += 1;
      throw new Error('Community must not be contacted');
    },
    resolveSermonSourceForItem: () => linked,
    window: {
      setTimeout(callback) {
        callback();
      }
    }
  };
  const exports = executeFunctions(
    controllerSource,
    [
      'inspectPostShowPowerPointService',
      'openCurrentServiceCompanion'
    ],
    context,
    ['openCurrentServiceCompanion']
  );
  return {
    calls,
    open: exports.openCurrentServiceCompanion
  };
}

test('controller redeems the receipt, skips generic inspection and Community, and resumes links', async () => {
  const harness = companionControllerHarness();
  const result = await harness.open({
    receiptToken: 'r'.repeat(32),
    expectedServiceDate: '2026-07-27',
    exactPostShowHandoff: true
  });
  assert.equal(result.opened, true);
  assert.equal(result.sermonOpened, true);
  assert.equal(harness.calls.inspectReceipt, 1);
  assert.equal(harness.calls.open, 1);
  assert.equal(harness.calls.genericInspect, 0);
  assert.equal(harness.calls.community, 0);
  assert.equal(harness.calls.relationships, 1);
});

test('serialized expired-inspection envelope retries only through the sealed receipt', async () => {
  const expired = {
    success: false,
    error: {
      code: 'EXPIRED_CURRENT_SERVICE_COMPANION_INSPECTION',
      message: 'inspection expired'
    }
  };
  const harness = companionControllerHarness({
    inspectResults: [
      {
        available: true,
        serviceSet: {
          name: 'Sunday Service',
          serviceDate: '2026-07-27',
          profileName: 'Main Sanctuary'
        },
        sources: [{
          roleId: 'english',
          roleLabel: 'English',
          fileName: 'service.pptx'
        }],
        exists: true,
        projectId: 'companion',
        inspectionToken: 'i'.repeat(32),
        expiresAt: new Date(Date.now() + 60_000).toISOString()
      },
      {
        available: true,
        serviceSet: {
          name: 'Sunday Service',
          serviceDate: '2026-07-27',
          profileName: 'Main Sanctuary'
        },
        sources: [{
          roleId: 'english',
          roleLabel: 'English',
          fileName: 'service.pptx'
        }],
        exists: true,
        projectId: 'companion',
        inspectionToken: 'j'.repeat(32),
        expiresAt: new Date(Date.now() + 60_000).toISOString()
      }
    ],
    openResults: [expired]
  });
  const result = await harness.open({
    receiptToken: 'r'.repeat(32),
    expectedServiceDate: '2026-07-27',
    exactPostShowHandoff: true
  });
  assert.equal(result.opened, true);
  assert.equal(harness.calls.inspectReceipt, 2);
  assert.equal(harness.calls.open, 2);
  assert.equal(harness.calls.genericInspect, 0);
  assert.equal(harness.calls.community, 0);
});
