'use strict';

// Electron-only entrypoint; keep this outside Node's automatic test discovery.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsPromises = require('node:fs/promises');
const path = require('node:path');
const {
  app,
  BrowserWindow,
  ipcMain,
  screen
} = require('electron');

const PACKAGED_INSTRUMENTATION =
  process.env.SYNCSHOW_PACKAGED_LIVE_CUE_INSTRUMENTATION === '1';
const ISOLATED_TEST_USER_DATA_MARKER = PACKAGED_INSTRUMENTATION
  ? '.syncshow-isolated-test-user-data'
  : require('../../src/services/runtime/IsolatedTestUserData')
    .ISOLATED_TEST_USER_DATA_MARKER;
const PACKAGED_INSTRUMENTATION_NONCE =
  process.env.SYNCSHOW_PACKAGED_LIVE_CUE_NONCE || '';
const EXPECTED_PACKAGED_RESOURCES =
  process.env.SYNCSHOW_EXPECTED_PACKAGED_RESOURCES || '';
const EXPECTED_PACKAGED_APP_PATH =
  process.env.SYNCSHOW_EXPECTED_PACKAGED_APP_PATH || '';
const EXPECTED_PACKAGED_EXECUTABLE =
  process.env.SYNCSHOW_EXPECTED_PACKAGED_EXECUTABLE || '';
const EXPECTED_PACKAGED_PRELOAD =
  process.env.SYNCSHOW_EXPECTED_PACKAGED_PRELOAD || '';

const CONTRACT = 'syncshow-live-cue-navigation-real-electron-v3';
const RESULT_FILE = 'live-cue-navigation-electron.json';
const RESULT_PATH = process.env.SYNCSHOW_LIVE_CUE_NAVIGATION_RESULT || '';
const WAIT_TIMEOUT_MS = 50_000;
const OUTPUT_ROUTES = Object.freeze([
  Object.freeze({
    id: 'front-projector',
    name: 'Front Projector',
    kind: 'normal',
    roleId: 'front',
    roleLabel: 'Front',
    displayId: 880_001,
    operatorPreview: false
  }),
  Object.freeze({
    id: 'translation-projector',
    name: 'Translation Projector',
    kind: 'normal',
    roleId: 'translation',
    roleLabel: 'Translation',
    displayId: 880_002,
    operatorPreview: false
  }),
  Object.freeze({
    id: 'singers-monitor',
    name: 'Singers Monitor',
    kind: 'singer',
    roleId: 'singers',
    roleLabel: 'Singers',
    displayId: 880_003,
    operatorPreview: true
  })
]);
const OUTPUT_IDS = Object.freeze(OUTPUT_ROUTES.map(route => route.id));
const EARLY_ACK_OUTPUT_IDS = Object.freeze(OUTPUT_IDS.slice(0, 2));
const SINGER_OUTPUT_ID = OUTPUT_IDS[2];
const AUTHORITATIVE_RESTORE_TEXT = 'Acknowledged cue two';
const STALE_TIMEOUT_TEXT = 'Acknowledged cue three';
const FINAL_CUE_TEXT = 'Acknowledged cue four';
const READINESS_WAIVERS = Object.freeze([
  Object.freeze({
    checkId: 'song-present',
    reason: 'This isolated navigation proof intentionally contains text cues only.'
  }),
  Object.freeze({
    checkId: 'exact-sermon-link',
    reason: 'This isolated navigation proof does not represent a Sunday sermon.'
  }),
  Object.freeze({
    checkId: 'linked-sermon-material',
    reason: 'No sermon material is needed for this isolated navigation proof.'
  }),
  Object.freeze({
    checkId: 'sermon-reading-before-material',
    reason: 'No sermon reading is needed for this isolated navigation proof.'
  })
]);

function delay(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

async function waitFor(callback, label, timeoutMs = WAIT_TIMEOUT_MS) {
  const startedAt = Date.now();
  let lastError = null;
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const result = await callback();
      if (result) return result;
    } catch (error) {
      lastError = error;
    }
    await delay(40);
  }
  const suffix = lastError ? ` Last error: ${lastError.message}` : '';
  throw new Error(`Timed out waiting for ${label}.${suffix}`);
}

function confinedResultPath() {
  if (!path.isAbsolute(RESULT_PATH)) {
    throw new Error('The live-cue navigation result path must be absolute.');
  }
  const profilePath = fs.realpathSync(app.getPath('userData'));
  const resultParent = fs.realpathSync(path.dirname(RESULT_PATH));
  if (
    resultParent !== profilePath
    || path.basename(RESULT_PATH) !== RESULT_FILE
  ) {
    throw new Error(
      'The live-cue navigation result path escaped its isolated profile.'
    );
  }
  return RESULT_PATH;
}

async function writeResult(result) {
  await fsPromises.writeFile(
    confinedResultPath(),
    `${JSON.stringify(result, null, 2)}\n`,
    {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o600
    }
  );
}

let originalGetAllDisplays = null;
let syntheticGetAllDisplays = null;

function installSyntheticDisplays() {
  originalGetAllDisplays = screen.getAllDisplays.bind(screen);
  syntheticGetAllDisplays = () => {
    const realDisplays = originalGetAllDisplays();
    const rightEdge = Math.max(...realDisplays.map(display =>
      display.bounds.x + display.bounds.width));
    return [
      ...realDisplays,
      ...OUTPUT_ROUTES.map((route, index) => {
        const syntheticBounds = {
          x: rightEdge + 200 + (index * 700),
          y: realDisplays[0]?.bounds?.y || 0,
          width: 640,
          height: 360
        };
        return {
          id: route.displayId,
          bounds: syntheticBounds,
          workArea: syntheticBounds,
          size: { width: syntheticBounds.width, height: syntheticBounds.height },
          workAreaSize: {
            width: syntheticBounds.width,
            height: syntheticBounds.height
          },
          scaleFactor: 1,
          rotation: 0,
          touchSupport: 'unknown',
          internal: false
        };
      })
    ];
  };
  screen.getAllDisplays = syntheticGetAllDisplays;
}

// Electron exposes `screen` only after ready. A synchronous ready listener is
// installed before production main registers its whenReady callback, so every
// production display read sees the isolated extra display without touching
// application code.
app.once('ready', installSyntheticDisplays);

// The output remains a real BrowserWindow and real renderer, but fullscreen is
// suppressed so this automated proof cannot create a macOS Space or cover the
// user's desktop. Visibility and hide semantics remain native BrowserWindow
// behavior and are asserted below.
const originalSetFullScreen = BrowserWindow.prototype.setFullScreen;
BrowserWindow.prototype.setFullScreen = function suppressTestFullscreen(value) {
  this.__syncShowRequestedFullscreen = Boolean(value);
};

const originalIpcMainEmit = ipcMain.emit;
const outputIdBySender = new WeakMap();
const frameFault = {
  mode: 'pass',
  targetIndex: null,
  targetSender: null,
  targetOutputId: null,
  held: [],
  history: [],

  set(mode, targetIndex, { sender, outputId }) {
    assert.ok(['hold', 'negative'].includes(mode));
    assert.equal(this.mode, 'pass');
    assert.equal(this.held.length, 0);
    assert.ok(Number.isSafeInteger(targetIndex) && targetIndex >= 0);
    assert.ok(sender && typeof sender.send === 'function');
    assert.equal(outputId, SINGER_OUTPUT_ID);
    this.mode = mode;
    this.targetIndex = targetIndex;
    this.targetSender = sender;
    this.targetOutputId = outputId;
  },

  releaseAll() {
    const released = this.held.splice(0);
    this.mode = 'pass';
    this.targetIndex = null;
    this.targetSender = null;
    this.targetOutputId = null;
    for (const entry of released) {
      this.history.push({
        action: 'released',
        outputId: entry.outputId,
        index: entry.payload.index,
        ok: entry.payload.ok
      });
      Reflect.apply(originalIpcMainEmit, ipcMain, [
        'output:frameReady',
        { sender: entry.sender },
        entry.payload
      ]);
    }
    return released.length;
  }
};

ipcMain.emit = function interceptOutputFrame(channel, ...args) {
  if (channel !== 'output:frameReady') {
    return Reflect.apply(originalIpcMainEmit, this, [channel, ...args]);
  }
  const [event, payload = {}] = args;
  const outputId = outputIdBySender.get(event?.sender) || null;
  if (
    frameFault.mode === 'pass'
    || payload?.index !== frameFault.targetIndex
    || payload?.ok !== true
    || event?.sender !== frameFault.targetSender
  ) {
    frameFault.history.push({
      action: 'passed',
      outputId,
      index: payload?.index,
      ok: payload?.ok
    });
    return Reflect.apply(originalIpcMainEmit, this, [channel, ...args]);
  }
  if (frameFault.mode === 'hold') {
    frameFault.held.push({
      sender: event.sender,
      outputId: frameFault.targetOutputId,
      payload: { ...payload }
    });
    frameFault.history.push({
      action: 'held',
      outputId: frameFault.targetOutputId,
      index: payload.index,
      ok: payload.ok
    });
    return true;
  }

  frameFault.mode = 'pass';
  frameFault.targetIndex = null;
  frameFault.targetSender = null;
  const rejectedOutputId = frameFault.targetOutputId;
  frameFault.targetOutputId = null;
  const rejected = {
    ...payload,
    ok: false,
    error: 'Injected renderer rejection for the real-Electron proof.'
  };
  frameFault.history.push({
    action: 'rejected',
    outputId: rejectedOutputId,
    index: rejected.index,
    ok: rejected.ok
  });
  return Reflect.apply(originalIpcMainEmit, this, [channel, event, rejected]);
};

function controlWindow() {
  return BrowserWindow.getAllWindows().find(window =>
    !window.isDestroyed()
    && window.webContents.getURL().endsWith('/src/renderer/index.html')) || null;
}

function outputWindowCandidates() {
  return BrowserWindow.getAllWindows().filter(window =>
    !window.isDestroyed()
    && window.webContents.getURL().endsWith('/src/renderer/display.html'));
}

async function waitForOutputWindows(label) {
  return waitFor(async () => {
    const candidates = outputWindowCandidates();
    if (
      candidates.length !== OUTPUT_IDS.length
      || candidates.some(window => window.webContents.isLoading())
    ) return null;

    const entries = await Promise.all(candidates.map(async window => {
      const outputId = await window.webContents.executeJavaScript(`
        typeof displayState === 'object' ? displayState.language : null
      `);
      return [outputId, window];
    }));
    if (
      entries.some(([outputId]) => !OUTPUT_IDS.includes(outputId))
      || new Set(entries.map(([outputId]) => outputId)).size !== OUTPUT_IDS.length
    ) return null;

    const windows = new Map(entries);
    for (const [outputId, window] of windows) {
      outputIdBySender.set(window.webContents, outputId);
    }
    return windows;
  }, label);
}

function showOutput(state, outputId) {
  return state?.outputs?.find(output => output.id === outputId) || null;
}

function everyShowOutput(state, predicate) {
  return OUTPUT_IDS.every(outputId => predicate(showOutput(state, outputId)));
}

function targetSingerFrame(frameFaultMode, cueIndex, outputs) {
  const singer = outputs.get(SINGER_OUTPUT_ID);
  assert.ok(singer && !singer.isDestroyed());
  frameFault.set(frameFaultMode, cueIndex, {
    sender: singer.webContents,
    outputId: SINGER_OUTPUT_ID
  });
}

function stateStatuses(state) {
  return Object.fromEntries(OUTPUT_IDS.map(outputId => [
    outputId,
    showOutput(state, outputId)?.status || null
  ]));
}

function stateVisibilities(state) {
  return Object.fromEntries(OUTPUT_IDS.map(outputId => [
    outputId,
    showOutput(state, outputId)?.visible === true
  ]));
}

function windowVisibilities(outputs) {
  return Object.fromEntries(OUTPUT_IDS.map(outputId => [
    outputId,
    outputs.get(outputId)?.isVisible() === true
  ]));
}

async function rendererInvoke(control, expression) {
  return control.webContents.executeJavaScript(`(async () => {${expression}})()`);
}

async function readShowState(control) {
  return rendererInvoke(control, 'return window.api.getShowState();');
}

async function waitForShowState(control, predicate, label, timeoutMs) {
  return waitFor(async () => {
    const state = await readShowState(control);
    return predicate(state) ? state : null;
  }, label, timeoutMs);
}

async function readOutputSurface(output) {
  return output.webContents.executeJavaScript(`
    (() => {
      const guard = document.querySelector('#outputRestoreGuard');
      const guardStyle = guard ? window.getComputedStyle(guard) : null;
      const guardRect = guard?.getBoundingClientRect() || null;
      const guardOpacity = Number(guardStyle?.opacity || 0);
      const guardCssVisible = Boolean(
        guard
        && guard.hidden === false
        && guardStyle.display !== 'none'
        && guardStyle.visibility !== 'hidden'
        && guardOpacity > 0
        && guardRect.width > 0
        && guardRect.height > 0
      );
      return {
        outputId: typeof displayState === 'object'
          ? displayState.language
          : null,
        cleared: document.querySelector('#displayContainer')
          ?.classList.contains('cleared') === true,
        activeNativeText: [...document.querySelectorAll(
          '.native-cue-layer.active'
        )].map(layer => layer.textContent.trim()).join(' '),
        restoreGuard: {
          present: Boolean(guard),
          active: guard?.hidden === false,
          cssVisible: guardCssVisible,
          coversViewport: Boolean(
            guardRect
            && guardRect.left === 0
            && guardRect.top === 0
            && guardRect.width === window.innerWidth
            && guardRect.height === window.innerHeight
          ),
          backgroundColor: guardStyle?.backgroundColor || '',
          opacity: Number.isFinite(guardOpacity) ? guardOpacity : 0,
          opaqueBlack: guardCssVisible
            && guardStyle.backgroundColor === 'rgb(0, 0, 0)'
            && guardOpacity === 1
        }
      };
    })()
  `);
}

async function readOutputSurfaces(outputs) {
  return Object.fromEntries(await Promise.all(OUTPUT_IDS.map(async outputId => [
    outputId,
    await readOutputSurface(outputs.get(outputId))
  ])));
}

function everySurface(surfaces, predicate) {
  return OUTPUT_IDS.every(outputId => predicate(surfaces[outputId], outputId));
}

async function beginRecordedOperation(control, key, invocation) {
  const safeKey = JSON.stringify(key);
  await control.webContents.executeJavaScript(`
    (() => {
      const record = {
        settled: false,
        fulfilled: false,
        value: null,
        error: null
      };
      window.__syncShowLiveCueProof = window.__syncShowLiveCueProof || {};
      window.__syncShowLiveCueProof[${safeKey}] = record;
      (${invocation}).then(
        value => {
          record.settled = true;
          record.fulfilled = true;
          record.value = value;
        },
        error => {
          record.settled = true;
          record.error = {
            name: error?.name || '',
            code: error?.code || null,
            message: error?.message || String(error)
          };
        }
      );
      return true;
    })()
  `);
}

async function beginNext(control, key) {
  return beginRecordedOperation(control, key, 'window.api.nextSlide()');
}

async function beginRestore(control, key) {
  return beginRecordedOperation(control, key, 'window.api.showDisplays()');
}

async function readPendingOperation(control, key) {
  const safeKey = JSON.stringify(key);
  return control.webContents.executeJavaScript(`
    (() => {
      const record = window.__syncShowLiveCueProof?.[${safeKey}];
      return record ? JSON.parse(JSON.stringify(record)) : null;
    })()
  `);
}

async function waitForPendingOperation(
  control,
  key,
  timeoutMs = WAIT_TIMEOUT_MS
) {
  return waitFor(async () => {
    const record = await readPendingOperation(control, key);
    return record?.settled ? record : null;
  }, `${key} operation to settle`, timeoutMs);
}

async function invokeNext(control) {
  return rendererInvoke(control, `
    try {
      return {
        fulfilled: true,
        value: await window.api.nextSlide(),
        error: null
      };
    } catch (error) {
      return {
        fulfilled: false,
        value: null,
        error: {
          name: error?.name || '',
          code: error?.code || null,
          message: error?.message || String(error)
        }
      };
    }
  `);
}

async function configureThreeOutputProfile(control) {
  const routes = OUTPUT_ROUTES.map(route => ({
    id: route.id,
    name: route.name,
    kind: route.kind,
    roleId: route.roleId,
    roleLabel: route.roleLabel,
    displayId: route.displayId,
    operatorPreview: route.operatorPreview
  }));
  const saved = await rendererInvoke(control, `
    const template = await window.api.getDefaultVenueProfile();
    const routes = ${JSON.stringify(routes)};
    const venueProfile = {
      ...template,
      id: 'electron-three-output-proof',
      name: 'Electron Three Output Proof',
      inputRoles: routes.map((route, index) => ({
        ...template.inputRoles[index],
        id: route.roleId,
        label: route.roleLabel,
        enabled: true,
        kind: 'deck'
      })),
      outputs: routes.map((route, index) => ({
        ...template.outputs[index],
        id: route.id,
        name: route.name,
        enabled: true,
        kind: route.kind,
        expectedRoleId: route.roleId,
        mode: 'role',
        renderer: 'slides',
        sourceRoleId: route.roleId,
        sourceOutputId: null,
        displayFingerprint: null,
        legacyDisplayId: route.displayId,
        operatorPreview: route.operatorPreview,
        fallback: null
      })),
      previewOutputIds: routes
        .filter(route => route.operatorPreview)
        .map(route => route.id),
      singer: {
        ...template.singer,
        fallbackSourceRoleId: 'front'
      },
      operator: {
        ...template.operator,
        showControlMode: 'full',
        previewOpenOutputIds: ['singers-monitor']
      }
    };
    const saved = await window.api.saveSettings({ venueProfile });
    if (saved?.success && typeof loadSavedSettings === 'function') {
      await loadSavedSettings();
      renderProfileEditor();
      checkReadyState();
    }
    return saved;
  `);
  assert.equal(saved.success, true);
  assert.deepEqual(
    saved.venueProfile.inputRoles.map(role => role.id),
    OUTPUT_ROUTES.map(route => route.roleId)
  );
  return saved.venueProfile;
}

async function createAndPublishService(control) {
  let current = await rendererInvoke(control, `
    return window.api.createServiceProject({
      title: 'Acknowledged Navigation Electron Proof',
      serviceDate: '2026-08-16',
      startTime: '10:30',
      teamNotes: 'Isolated automated proof only.'
    });
  `);
  const cueBodies = [
    'Acknowledged cue one',
    AUTHORITATIVE_RESTORE_TEXT,
    STALE_TIMEOUT_TEXT,
    'Acknowledged cue four'
  ];
  for (const [index, text] of cueBodies.entries()) {
    current = await rendererInvoke(control, `
      return window.api.addTextToService({
        projectId: ${JSON.stringify(current.project.id)},
        expectedRevisionId: ${JSON.stringify(current.revisionId)},
        kind: 'notice',
        title: ${JSON.stringify(`Navigation cue ${index + 1}`)},
        text: ${JSON.stringify(text)},
        parentId: null
      });
    `);
  }
  current = await rendererInvoke(control, `
    return window.api.setServicePlanningStatus({
      projectId: ${JSON.stringify(current.project.id)},
      expectedRevisionId: ${JSON.stringify(current.revisionId)},
      status: 'ready',
      waivers: ${JSON.stringify(READINESS_WAIVERS)}
    });
  `);
  assert.equal(current.readiness.ready, true);
  assert.equal(current.readiness.cueCount, 4);
  const published = await rendererInvoke(control, `
    return window.api.publishServiceProject({
      projectId: ${JSON.stringify(current.project.id)},
      revisionId: ${JSON.stringify(current.revisionId)}
    });
  `);
  return {
    ...published,
    project: current.project,
    revisionId: current.revisionId
  };
}

async function startShow(control) {
  const outputs = OUTPUT_ROUTES.map(route => ({
    id: route.id,
    name: route.name,
    kind: route.kind,
    displayId: route.displayId,
    expectedRole: route.roleId,
    enabled: true,
    operatorPreview: route.operatorPreview
  }));
  return rendererInvoke(control, `
    return window.api.startPresentation({
      outputs: ${JSON.stringify(outputs)},
      decisions: {},
      preferredTimelineRoleId: 'front',
      settings: {
        fadeDuration: 0,
        syncMode: false,
        singerFontSize: 36,
        singerCharLimit: 70,
        singerTextPadding: 4
      }
    });
  `);
}

async function startShowThroughOperatorUi(control, published) {
  const projectDate = published.project.serviceDate;
  return rendererInvoke(control, `
    const appState = await window.api.getAppState();
    applyServiceHandoff(appState.serviceHandoff);
    applyRuntimePresentationState(appState.presentations, {
      displayName: ${JSON.stringify(published.project.title)},
      replaceSource: true
    });
    state.preparedServiceRestore = appState.preparedServiceRestore || {
      status: 'none'
    };
    state.currentSlide = appState.currentSlide;
    state.totalSlides = appState.totalSlides;
    state.displays = appState.displays;
    state.serviceFolder.requestedDate = ${JSON.stringify(projectDate)};
    elements.serviceFolderDate.value = ${JSON.stringify(projectDate)};
    setWorkflowStage('load');
    renderInputCards();
    renderLoadServiceHandoff();
    checkReadyState();
    const readiness = getReadinessState();
    const startButton = elements.btnStartPresentation;
    const before = {
      ready: readiness.isReady,
      disabled: startButton.disabled,
      loadStage: document.body.classList.contains('load-stage'),
      handoffVisible: elements.loadServiceHandoff.hidden === false
    };
    await startPresentation();
    return {
      before,
      showStage: document.body.classList.contains('show-stage'),
      activeLaunchPlan: state.activeLaunchPlan,
      serviceHandoffProjectId: state.serviceHandoff?.project?.id || null,
      serviceHandoffRevisionId:
        state.serviceHandoff?.project?.revisionId || null
    };
  `);
}

async function clickNextThroughOperatorUi(control) {
  return rendererInvoke(control, `
    const button = elements.btnNextSlide;
    const style = window.getComputedStyle(button);
    const rect = button.getBoundingClientRect();
    const before = {
      disabled: button.disabled,
      visible: style.display !== 'none'
        && style.visibility !== 'hidden'
        && Number(style.opacity) > 0
        && rect.width > 0
        && rect.height > 0,
      text: button.textContent.trim()
    };
    button.click();
    return before;
  `);
}

async function finishServiceThroughOperatorUi(control, published) {
  const before = await rendererInvoke(control, `
    const button = elements.btnBackToSetup;
    const style = window.getComputedStyle(button);
    const rect = button.getBoundingClientRect();
    return {
      text: button.textContent.trim(),
      ariaLabel: button.getAttribute('aria-label'),
      ariaBusy: button.getAttribute('aria-busy'),
      disabled: button.disabled,
      visible: style.display !== 'none'
        && style.visibility !== 'hidden'
        && Number(style.opacity) > 0
        && rect.width > 0
        && rect.height > 0,
      showStage: document.body.classList.contains('show-stage')
    };
  `);
  assert.deepEqual(before, {
    text: 'Finish service…',
    ariaLabel: 'Finish service and return safely to Load',
    ariaBusy: null,
    disabled: false,
    visible: true,
    showStage: true
  });

  const doubleClick = await rendererInvoke(control, `
    const button = elements.btnBackToSetup;
    button.click();
    const afterFirstClick = {
      text: button.textContent.trim(),
      ariaBusy: button.getAttribute('aria-busy'),
      disabled: button.disabled,
      showEndSessionBusy: state.showEndSessionBusy
    };
    const secondClickIssuedWhileDisabled = button.disabled === true;
    const secondClickIssuedWhileBusy = state.showEndSessionBusy === true;
    button.click();
    return {
      afterFirstClick,
      secondClickIssuedWhileDisabled,
      secondClickIssuedWhileBusy
    };
  `);
  assert.deepEqual(doubleClick, {
    afterFirstClick: {
      text: 'Finishing service…',
      ariaBusy: 'true',
      disabled: true,
      showEndSessionBusy: true
    },
    secondClickIssuedWhileDisabled: true,
    secondClickIssuedWhileBusy: true
  });

  const load = await waitFor(async () => rendererInvoke(control, `
    const dialog = elements.showHandoffDialog;
    const title = elements.showHandoffTitle;
    const handoff = elements.loadServiceHandoff;
    const stageLoad = elements.btnStageLoad;
    if (
      !document.body.classList.contains('load-stage')
      || !dialog.open
      || dialog.dataset.mode !== 'native'
      || document.activeElement !== title
      || handoff.hidden
      || state.showEndSessionBusy
    ) return null;
    return {
      loadStage: true,
      dialogOpen: true,
      dialogMode: dialog.dataset.mode,
      dialogTitle: title.textContent.trim(),
      dialogTitleFocused: document.activeElement === title,
      handoffTitle: elements.loadServiceHandoffTitle.textContent.trim(),
      handoffBadge: elements.loadServiceHandoffBadge.textContent.trim(),
      handoffReview: elements.loadServiceHandoffReview.textContent.trim(),
      stageLoadAriaCurrent: stageLoad.getAttribute('aria-current')
    };
  `), 'Finish service to return to Load with the native handoff');

  const showState = await readShowState(control);
  assert.equal(showState.phase, 'idle');
  assert.equal(showState.outputSessionId, null);
  await waitFor(
    () => BrowserWindow.getAllWindows().filter(window => {
      if (window.isDestroyed()) return false;
      const url = window.webContents.getURL();
      return url.endsWith('/src/renderer/display.html')
        || url.endsWith('/src/renderer/singer.html');
    }).length === 0,
    'Finish service to destroy every output window'
  );

  const project = await rendererInvoke(control, `
    return window.api.openServiceProject({
      projectId: ${JSON.stringify(published.showPackage.projectId)}
    });
  `);
  assert.equal(project.project.planning.status, 'ready');
  assert.equal(project.revisionId, published.showPackage.revisionId);

  const closed = await rendererInvoke(control, `
    elements.btnCloseShowHandoff.click();
    return {
      dialogOpen: elements.showHandoffDialog.open,
      loadFocused: document.activeElement === elements.btnStageLoad,
      loadStage: document.body.classList.contains('load-stage')
    };
  `);
  assert.deepEqual(closed, {
    dialogOpen: false,
    loadFocused: true,
    loadStage: true
  });

  return {
    finalCueIndex: 3,
    button: before,
    afterFirstClick: doubleClick.afterFirstClick,
    secondClickIssuedWhileDisabled:
      doubleClick.secondClickIssuedWhileDisabled,
    secondClickIssuedWhileBusy: doubleClick.secondClickIssuedWhileBusy,
    synchronousDoubleClickBarrierObserved:
      doubleClick.secondClickIssuedWhileDisabled
      && doubleClick.secondClickIssuedWhileBusy,
    load,
    showPhase: showState.phase,
    outputSessionId: showState.outputSessionId,
    outputWindowCount: 0,
    projectStatus: project.project.planning.status,
    projectRevisionId: project.revisionId,
    projectRevisionUnchanged:
      project.revisionId === published.showPackage.revisionId,
    dialogClosed: closed.dialogOpen === false,
    loadFocusedAfterClose: closed.loadFocused
  };
}

async function run() {
  if (PACKAGED_INSTRUMENTATION) {
    assert.equal(process.type, 'browser');
    assert.equal(app.isPackaged, true);
    assert.match(PACKAGED_INSTRUMENTATION_NONCE, /^[a-f0-9]{64}$/u);
    assert.equal(process.argv.includes('--dev'), false);
    assert.ok(path.isAbsolute(EXPECTED_PACKAGED_RESOURCES));
    assert.ok(path.isAbsolute(EXPECTED_PACKAGED_APP_PATH));
    assert.ok(path.isAbsolute(EXPECTED_PACKAGED_EXECUTABLE));
    assert.ok(path.isAbsolute(EXPECTED_PACKAGED_PRELOAD));
    assert.equal(
      fs.realpathSync(process.resourcesPath),
      fs.realpathSync(EXPECTED_PACKAGED_RESOURCES)
    );
    assert.equal(
      fs.realpathSync(app.getAppPath()),
      fs.realpathSync(EXPECTED_PACKAGED_APP_PATH)
    );
    assert.equal(
      fs.realpathSync(process.execPath),
      fs.realpathSync(EXPECTED_PACKAGED_EXECUTABLE)
    );
    assert.equal(
      process.env.NODE_OPTIONS,
      `--require=${fs.realpathSync(EXPECTED_PACKAGED_PRELOAD)}`
    );
  } else {
    assert.equal(app.isPackaged, false);
  }
  const requestedProfile = process.env.SYNCSHOW_TEST_USER_DATA_DIR || '';
  const activeProfile = fs.realpathSync(app.getPath('userData'));
  assert.equal(activeProfile, fs.realpathSync(requestedProfile));
  assert.equal(
    fs.readFileSync(
      path.join(activeProfile, ISOLATED_TEST_USER_DATA_MARKER),
      'utf8'
    ),
    'SyncShow isolated test user data v1\n'
  );
  assert.ok(originalGetAllDisplays);
  assert.deepEqual(
    screen.getAllDisplays()
      .filter(display => OUTPUT_ROUTES.some(route => route.displayId === display.id))
      .map(display => display.id)
      .sort((left, right) => left - right),
    OUTPUT_ROUTES.map(route => route.displayId)
  );
  assert.notEqual(BrowserWindow.prototype.setFullScreen, originalSetFullScreen);
  if (process.platform === 'darwin' && app.dock) app.dock.hide();

  const control = await waitFor(() => {
    const candidate = controlWindow();
    return candidate?.webContents?.isLoading() ? null : candidate;
  }, 'the real SyncShow control window');

  await configureThreeOutputProfile(control);
  const published = await createAndPublishService(control);
  assert.equal(published.success, true);
  assert.equal(published.showPackage.cueCount, 4);
  assert.deepEqual(
    [...published.showPackage.roles].sort(),
    OUTPUT_ROUTES.map(route => route.roleId).sort()
  );

  let started = await startShow(control);
  assert.equal(started.success, true);
  assert.equal(started.totalSlides, 4);
  assert.equal(started.plan.outputs.length, OUTPUT_ROUTES.length);
  assert.equal(started.plan.timelineRoleId, 'front');
  assert.deepEqual(
    started.plan.outputs.map(output => ({
      id: output.id,
      displayId: output.displayId,
      renderer: output.renderer,
      sourceRoleId: output.sourceRoleId
    })),
    OUTPUT_ROUTES.map(route => ({
      id: route.id,
      displayId: route.displayId,
      renderer: 'native-cue',
      sourceRoleId: route.roleId
    }))
  );

  let outputs = await waitForOutputWindows(
    'the three real native-cue output renderers'
  );
  await waitForShowState(
    control,
    state => state.phase === 'live'
      && state.currentCue?.index === 0
      && everyShowOutput(state, output => output?.status === 'healthy'),
    'the initial acknowledged cue'
  );

  // Hold only the real Singer renderer receipt. Front and Translation must
  // acknowledge normally, while Main keeps the first Next pending and rejects
  // a rapid second Next until that exact last sender is released.
  targetSingerFrame('hold', 1, outputs);
  await beginNext(control, 'delayed');
  await waitFor(() => frameFault.held.length === 1, 'the delayed cue receipt');
  const delayedHeldReceiptCount = frameFault.held.length;
  const pendingState = await waitForShowState(
    control,
    state => state.currentCue?.index === 0
      && EARLY_ACK_OUTPUT_IDS.every(outputId =>
        showOutput(state, outputId)?.status === 'healthy')
      && showOutput(state, SINGER_OUTPUT_ID)?.status === 'starting'
      && state.operator?.controls?.canNext === false,
    'Front and Translation to finish before the held Singer acknowledgement'
  );
  const delayedStatusesWhileSingerHeld = stateStatuses(pendingState);
  const pendingDelayed = await readPendingOperation(control, 'delayed');
  assert.equal(pendingDelayed.settled, false);
  assert.equal(pendingState.currentCue.index, 0);
  const secondAdvance = await invokeNext(control);
  assert.equal(secondAdvance.fulfilled, false);
  assert.match(
    secondAdvance.error.message,
    /Wait for the current cue to reach every output before advancing again\./u
  );
  assert.equal(frameFault.held.length, 1);
  assert.equal(frameFault.releaseAll(), 1);
  const delayed = await waitForPendingOperation(control, 'delayed');
  assert.equal(delayed.fulfilled, true);
  assert.equal(delayed.value.success, true);
  assert.equal(delayed.value.applied, true);
  const afterDelayed = await waitForShowState(
    control,
    state => state.phase === 'live'
      && state.currentCue?.index === 1
      && everyShowOutput(state, output => output?.status === 'healthy'),
    'the delayed cue to commit'
  );
  assert.equal(afterDelayed.currentCue.index, 1);

  // Convert the renderer's next successful paint receipt into an explicit
  // negative Singer ACK. Main must retain cue 2 and synchronously issue Clear
  // to all three routes, even though Front and Translation already succeeded.
  targetSingerFrame('negative', 2, outputs);
  const rejected = await invokeNext(control);
  assert.equal(rejected.fulfilled, false);
  assert.match(
    rejected.error.message,
    /Injected renderer rejection for the real-Electron proof\./u
  );
  const afterRejected = await waitForShowState(
    control,
    state => state.phase === 'interrupted'
      && state.currentCue?.index === 1
      && EARLY_ACK_OUTPUT_IDS.every(outputId =>
        showOutput(state, outputId)?.status === 'cleared')
      && showOutput(state, SINGER_OUTPUT_ID)?.status === 'unavailable',
    'negative Singer acknowledgement to clear every output'
  );
  const rejectedSurfaces = await waitFor(async () => {
    const surfaces = await readOutputSurfaces(outputs);
    return everySurface(surfaces, surface => surface.cleared)
      ? surfaces
      : null;
  }, 'the three output renderers to apply Clear');

  // A rejected renderer stays unavailable even though Clear reached it. Start
  // a fresh output session before exercising the remaining independent races.
  await rendererInvoke(control, 'return window.api.endPresentation();');
  await waitForShowState(
    control,
    state => state.phase === 'idle' && state.outputSessionId === null,
    'the rejected output session to end'
  );
  started = await startShow(control);
  assert.equal(started.success, true);
  outputs = await waitForOutputWindows(
    'the three replacement native-cue output renderers'
  );
  await waitForShowState(
    control,
    state => state.phase === 'live'
      && state.currentCue?.index === 0
      && everyShowOutput(state, output => output?.status === 'healthy'),
    'the replacement session initial cue'
  );
  const replacementAdvance = await invokeNext(control);
  assert.equal(replacementAdvance.fulfilled, true);
  assert.equal(replacementAdvance.value.applied, true);
  await waitForShowState(
    control,
    state => state.phase === 'live'
      && state.currentCue?.index === 1
      && everyShowOutput(state, output => output?.status === 'healthy'),
    'the replacement session second cue'
  );

  // Clear is the emergency preemption boundary. A receipt delivered after
  // Clear must not revive or commit the cancelled cue.
  targetSingerFrame('hold', 2, outputs);
  await beginNext(control, 'clear');
  await waitFor(() => frameFault.held.length === 1, 'the clear-race receipt');
  await waitForShowState(
    control,
    state => state.currentCue?.index === 1
      && EARLY_ACK_OUTPUT_IDS.every(outputId =>
        showOutput(state, outputId)?.status === 'healthy')
      && showOutput(state, SINGER_OUTPUT_ID)?.status === 'starting',
    'the clear-race navigation state'
  );
  const cleared = await rendererInvoke(
    control,
    'return window.api.clearDisplays();'
  );
  assert.equal(cleared.success, true);
  const cancelled = await waitForPendingOperation(control, 'clear');
  assert.equal(cancelled.fulfilled, true);
  assert.equal(cancelled.value.success, true);
  assert.equal(cancelled.value.applied, false);
  assert.equal(frameFault.releaseAll(), 1);
  await delay(250);
  const afterLateClearReceipt = await waitForShowState(
    control,
    state => state.phase === 'cleared'
      && state.currentCue?.index === 1
      && everyShowOutput(state, output => output?.status === 'cleared'),
    'the late clear receipt to remain non-authoritative'
  );
  const clearSurfaces = await readOutputSurfaces(outputs);
  assert.equal(everySurface(clearSurfaces, surface => surface.cleared), true);

  // A common Clear-to-Restore keeps the already-visible output on screen. The
  // independently acknowledged renderer guard covers the authoritative cue
  // while its frame receipt is held, then releases only after that receipt.
  const clearWindowVisibilityBeforeRestore = windowVisibilities(outputs);
  assert.equal(Object.values(clearWindowVisibilityBeforeRestore).every(Boolean), true);
  assert.equal(
    everySurface(clearSurfaces, surface =>
      surface.restoreGuard.present && !surface.restoreGuard.cssVisible),
    true
  );

  targetSingerFrame('hold', 1, outputs);
  await beginRestore(control, 'restore-from-clear');
  await waitFor(
    () => frameFault.held.length === 1,
    'the common Clear-to-Restore frame receipt'
  );
  const clearRestoreHeldReceiptCount = frameFault.held.length;
  const pendingClearRestore = await readPendingOperation(
    control,
    'restore-from-clear'
  );
  assert.equal(pendingClearRestore.settled, false);
  const duringClearRestore = await waitForShowState(
    control,
    state => state.phase === 'cleared'
      && state.currentCue?.index === 1
      && everyShowOutput(state, output => output?.visible === true)
      && EARLY_ACK_OUTPUT_IDS.every(outputId =>
        showOutput(state, outputId)?.status === 'cleared')
      && showOutput(state, SINGER_OUTPUT_ID)?.status === 'starting',
    'the guarded common Restore state'
  );
  const clearRestoreStatusesWhileSingerHeld = stateStatuses(duringClearRestore);
  const clearRestoreWindowVisibilityWhileHeld = windowVisibilities(outputs);
  assert.equal(
    Object.values(clearRestoreWindowVisibilityWhileHeld).every(Boolean),
    true
  );
  const clearRestoreGuardedSurfaces = await readOutputSurfaces(outputs);
  assert.equal(
    everySurface(clearRestoreGuardedSurfaces, surface =>
      surface.restoreGuard.active
      && surface.restoreGuard.cssVisible
      && surface.restoreGuard.coversViewport
      && surface.restoreGuard.opaqueBlack
      && surface.activeNativeText.includes(AUTHORITATIVE_RESTORE_TEXT)),
    true
  );

  assert.equal(frameFault.releaseAll(), 1);
  const completedClearRestore = await waitForPendingOperation(
    control,
    'restore-from-clear'
  );
  assert.equal(completedClearRestore.fulfilled, true);
  assert.equal(completedClearRestore.value.success, true);
  const afterClearRestore = await waitForShowState(
    control,
    state => state.phase === 'live'
      && state.currentCue?.index === 1
      && everyShowOutput(state, output =>
        output?.status === 'healthy' && output.visible === true),
    'the completed common Restore'
  );
  const clearRestoreWindowVisibilityAfterRelease = windowVisibilities(outputs);
  assert.equal(
    Object.values(clearRestoreWindowVisibilityAfterRelease).every(Boolean),
    true
  );
  const clearRestoreReleasedSurfaces = await readOutputSurfaces(outputs);
  assert.equal(
    everySurface(clearRestoreReleasedSurfaces, surface =>
      !surface.restoreGuard.active
      && !surface.restoreGuard.cssVisible
      && surface.activeNativeText.includes(AUTHORITATIVE_RESTORE_TEXT)),
    true
  );

  // Clear is also allowed to preempt an in-flight Restore. Its renderer guard
  // remains visible, and a late authoritative frame receipt cannot release it.
  const clearBeforeRestorePreemption = await rendererInvoke(
    control,
    'return window.api.clearDisplays();'
  );
  assert.equal(clearBeforeRestorePreemption.success, true);
  await waitForShowState(
    control,
    state => state.phase === 'cleared'
      && state.currentCue?.index === 1
      && everyShowOutput(state, output =>
        output?.status === 'cleared' && output.visible === true),
    'Clear before the preempted Restore'
  );

  targetSingerFrame('hold', 1, outputs);
  await beginRestore(control, 'restore-preempted-by-clear');
  await waitFor(
    () => frameFault.held.length === 1,
    'the preempted Restore frame receipt'
  );
  const preemptedRestoreHeldReceiptCount = frameFault.held.length;
  const pendingPreemptedRestore = await readPendingOperation(
    control,
    'restore-preempted-by-clear'
  );
  assert.equal(pendingPreemptedRestore.settled, false);
  const duringPreemptedRestore = await waitForShowState(
    control,
    state => state.phase === 'cleared'
      && state.currentCue?.index === 1
      && everyShowOutput(state, output => output?.visible === true)
      && EARLY_ACK_OUTPUT_IDS.every(outputId =>
        showOutput(state, outputId)?.status === 'cleared')
      && showOutput(state, SINGER_OUTPUT_ID)?.status === 'starting',
    'Front and Translation to finish during the preempted Restore'
  );
  const preemptedRestoreGuardedSurfaces = await readOutputSurfaces(outputs);
  assert.equal(
    everySurface(preemptedRestoreGuardedSurfaces, surface =>
      surface.restoreGuard.cssVisible
      && surface.restoreGuard.opaqueBlack),
    true
  );
  assert.equal(Object.values(windowVisibilities(outputs)).every(Boolean), true);

  const emergencyClear = await rendererInvoke(
    control,
    'return window.api.clearDisplays();'
  );
  assert.equal(emergencyClear.success, true);
  const preemptedRestore = await waitForPendingOperation(
    control,
    'restore-preempted-by-clear'
  );
  assert.equal(preemptedRestore.fulfilled, false);
  const afterRestorePreemption = await waitForShowState(
    control,
    state => state.phase === 'cleared'
      && state.currentCue?.index === 1
      && everyShowOutput(state, output =>
        output?.status === 'cleared' && output.visible === true),
    'Clear to preserve the guarded output after Restore preemption'
  );
  const restorePreemptedWindowVisibility = windowVisibilities(outputs);
  assert.equal(Object.values(restorePreemptedWindowVisibility).every(Boolean), true);
  const restorePreemptedSurfaces = await readOutputSurfaces(outputs);
  assert.equal(
    everySurface(restorePreemptedSurfaces, surface =>
      surface.cleared
      && surface.restoreGuard.cssVisible
      && surface.restoreGuard.opaqueBlack),
    true
  );

  assert.equal(frameFault.releaseAll(), 1);
  await delay(250);
  const afterLatePreemptedRestoreReceipt = await readShowState(control);
  assert.equal(afterLatePreemptedRestoreReceipt.phase, 'cleared');
  assert.equal(afterLatePreemptedRestoreReceipt.currentCue.index, 1);
  assert.equal(
    everyShowOutput(afterLatePreemptedRestoreReceipt, output =>
      output?.visible === true),
    true
  );
  const afterLatePreemptedRestoreSurfaces = await readOutputSurfaces(outputs);
  assert.equal(
    everySurface(afterLatePreemptedRestoreSurfaces, surface =>
      surface.restoreGuard.cssVisible
      && surface.restoreGuard.opaqueBlack),
    true
  );
  const restorePreemptedWindowVisibilityAfterLateReceipt =
    windowVisibilities(outputs);
  assert.equal(
    Object.values(restorePreemptedWindowVisibilityAfterLateReceipt).every(Boolean),
    true
  );

  // Start a fresh output session for the independent timeout-hidden Restore
  // proof so the deliberately preserved preemption guard cannot influence it.
  await rendererInvoke(control, 'return window.api.endPresentation();');
  await waitForShowState(
    control,
    state => state.phase === 'idle' && state.outputSessionId === null,
    'the preempted Restore session to end'
  );
  started = await startShow(control);
  assert.equal(started.success, true);
  outputs = await waitForOutputWindows(
    'the three timeout Restore native-cue output renderers'
  );
  await waitForShowState(
    control,
    state => state.phase === 'live'
      && state.currentCue?.index === 0
      && everyShowOutput(state, output => output?.status === 'healthy'),
    'the timeout Restore session initial cue'
  );
  const timeoutSessionAdvance = await invokeNext(control);
  assert.equal(timeoutSessionAdvance.fulfilled, true);
  assert.equal(timeoutSessionAdvance.value.applied, true);
  await waitForShowState(
    control,
    state => state.phase === 'live'
      && state.currentCue?.index === 1
      && everyShowOutput(state, output => output?.status === 'healthy'),
    'the timeout Restore session authoritative cue'
  );

  // Exercise the coordinator's production 15-second deadline. All renderers
  // paint cue 3, but only Singer's receipt is held. Front and Translation
  // finish normally; Main still hides all outputs and retains cue 2.
  targetSingerFrame('hold', 2, outputs);
  const timeoutStartedAt = Date.now();
  await beginNext(control, 'timeout');
  await waitFor(() => frameFault.held.length === 1, 'the timeout receipt');
  const pendingTimeoutState = await waitForShowState(
    control,
    state => state.currentCue?.index === 1
      && EARLY_ACK_OUTPUT_IDS.every(outputId =>
        showOutput(state, outputId)?.status === 'healthy')
      && showOutput(state, SINGER_OUTPUT_ID)?.status === 'starting',
    'Front and Translation to finish before the Singer timeout'
  );
  const timedOut = await waitForPendingOperation(
    control,
    'timeout',
    30_000
  );
  const timeoutElapsedMs = Date.now() - timeoutStartedAt;
  assert.equal(timedOut.fulfilled, false);
  assert.match(
    timedOut.error.message,
    /did not reach every output within 15 seconds\./u
  );
  const afterTimeout = await waitForShowState(
    control,
    state => state.phase === 'interrupted'
      && state.currentCue?.index === 1
      && everyShowOutput(state, output => output?.visible === false),
    'the timeout safety hide',
    10_000
  );
  const windowVisibilityAfterTimeout = windowVisibilities(outputs);
  assert.equal(Object.values(windowVisibilityAfterTimeout).some(Boolean), false);
  const timedOutSurfaces = await readOutputSurfaces(outputs);
  assert.equal(
    everySurface(timedOutSurfaces, surface =>
      surface.activeNativeText.includes(STALE_TIMEOUT_TEXT)),
    true
  );
  assert.equal(frameFault.releaseAll(), 1);
  await delay(250);
  const afterLateTimeoutReceipt = await readShowState(control);
  assert.equal(afterLateTimeoutReceipt.phase, 'hidden');
  assert.equal(afterLateTimeoutReceipt.currentCue.index, 1);
  assert.equal(
    everyShowOutput(afterLateTimeoutReceipt, output => output?.visible === false),
    true
  );
  const windowVisibilityAfterLateTimeoutReceipt = windowVisibilities(outputs);
  assert.equal(
    Object.values(windowVisibilityAfterLateTimeoutReceipt).some(Boolean),
    false
  );

  // Restore first paints its guard while the window is hidden, then presents
  // that guarded window. The authoritative cue replaces the stale DOM under
  // the guard, which releases only after its exact frame receipt reaches main.
  targetSingerFrame('hold', 1, outputs);
  await beginRestore(control, 'restore-after-timeout');
  await waitFor(
    () => frameFault.held.length === 1,
    'the authoritative Restore receipt'
  );
  const restoreHeldReceiptCount = frameFault.held.length;
  const pendingRestore = await readPendingOperation(
    control,
    'restore-after-timeout'
  );
  assert.equal(pendingRestore.settled, false);
  const duringRestore = await waitForShowState(
    control,
    state => state.phase === 'cleared'
      && state.currentCue?.index === 1
      && everyShowOutput(state, output => output?.visible === true)
      && EARLY_ACK_OUTPUT_IDS.every(outputId =>
        showOutput(state, outputId)?.status === 'cleared')
      && showOutput(state, SINGER_OUTPUT_ID)?.status === 'starting',
    'Restore to present only guarded windows while Singer is held'
  );
  const restoreStatusesWhileSingerHeld = stateStatuses(duringRestore);
  const windowVisibilityWhileRestoreReceiptHeld = windowVisibilities(outputs);
  assert.equal(
    Object.values(windowVisibilityWhileRestoreReceiptHeld).every(Boolean),
    true
  );
  const duringRestoreSurfaces = await readOutputSurfaces(outputs);
  assert.equal(
    everySurface(duringRestoreSurfaces, surface =>
      surface.restoreGuard.active
      && surface.restoreGuard.cssVisible
      && surface.restoreGuard.coversViewport
      && surface.restoreGuard.opaqueBlack
      && surface.activeNativeText.includes(AUTHORITATIVE_RESTORE_TEXT)
      && !surface.activeNativeText.includes(STALE_TIMEOUT_TEXT)),
    true
  );

  assert.equal(frameFault.releaseAll(), 1);
  const restoredAfterTimeout = await waitForPendingOperation(
    control,
    'restore-after-timeout'
  );
  assert.equal(restoredAfterTimeout.fulfilled, true);
  assert.equal(restoredAfterTimeout.value.success, true);
  const afterSafeRestore = await waitForShowState(
    control,
    state => state.phase === 'live'
      && state.currentCue?.index === 1
      && everyShowOutput(state, output =>
        output?.status === 'healthy' && output.visible === true),
    'the authoritative cue to reveal after Restore acknowledgement'
  );
  const windowVisibilityAfterRestore = windowVisibilities(outputs);
  assert.equal(Object.values(windowVisibilityAfterRestore).every(Boolean), true);
  const restoredSurfaces = await readOutputSurfaces(outputs);
  assert.equal(
    everySurface(restoredSurfaces, surface =>
      !surface.restoreGuard.active
      && !surface.restoreGuard.cssVisible
      && surface.activeNativeText.includes(AUTHORITATIVE_RESTORE_TEXT)
      && !surface.activeNativeText.includes(STALE_TIMEOUT_TEXT)),
    true
  );

  // Finish with a fresh, positive operator-UI session. The earlier sections
  // deliberately drive lower-level APIs to inject selected ACK faults; this
  // final segment reloads the prepared service into the real renderer state,
  // starts through the real Start Show path, advances with the visible Next
  // control, and double-clicks the final Finish service control.
  await rendererInvoke(control, 'return window.api.endPresentation();');
  await waitForShowState(
    control,
    state => state.phase === 'idle' && state.outputSessionId === null,
    'the fault-injection session to end before the operator Finish proof'
  );
  const operatorStart = await startShowThroughOperatorUi(control, published);
  assert.deepEqual(operatorStart.before, {
    ready: true,
    disabled: false,
    loadStage: true,
    handoffVisible: true
  });
  assert.equal(operatorStart.showStage, true);
  assert.equal(
    operatorStart.serviceHandoffProjectId,
    published.showPackage.projectId
  );
  assert.equal(
    operatorStart.serviceHandoffRevisionId,
    published.showPackage.revisionId
  );
  const operatorRoutes = operatorStart.activeLaunchPlan.outputs.map(output => ({
    id: output.id,
    displayId: output.displayId,
    renderer: output.renderer,
    sourceRoleId: output.sourceRoleId
  }));
  assert.deepEqual(
    operatorRoutes,
    OUTPUT_ROUTES.map(route => ({
      id: route.id,
      displayId: route.displayId,
      renderer: 'native-cue',
      sourceRoleId: route.roleId
    }))
  );
  outputs = await waitForOutputWindows(
    'the three operator-UI Finish-session output renderers'
  );
  await waitForShowState(
    control,
    state => state.phase === 'live'
      && state.currentCue?.index === 0
      && everyShowOutput(state, output => output?.status === 'healthy'),
    'the operator-UI Finish session initial cue'
  );
  const operatorAdvances = [];
  let operatorFinalState = null;
  for (const targetIndex of [1, 2, 3]) {
    const button = await clickNextThroughOperatorUi(control);
    assert.equal(button.disabled, false);
    assert.equal(button.visible, true);
    operatorAdvances.push({ targetIndex, ...button });
    operatorFinalState = await waitForShowState(
      control,
      state => state.phase === 'live'
        && state.currentCue?.index === targetIndex
        && everyShowOutput(state, output =>
          output?.status === 'healthy' && output.visible === true),
      `operator Next to acknowledge cue ${targetIndex + 1}`
    );
  }
  assert.equal(operatorFinalState.currentCue.index, 3);
  const operatorFinalWindowVisibilities = windowVisibilities(outputs);
  assert.equal(
    Object.values(operatorFinalWindowVisibilities).every(Boolean),
    true
  );
  const finalCueSurfaces = await readOutputSurfaces(outputs);
  assert.equal(
    everySurface(finalCueSurfaces, surface =>
      surface.activeNativeText.includes(FINAL_CUE_TEXT)),
    true
  );
  const finish = await finishServiceThroughOperatorUi(control, published);

  return {
    ok: true,
    contract: CONTRACT,
    profileIsolated: true,
    productionMainPreloadOutputRenderer: true,
    syntheticDisplayConfinedToFixture: true,
    fullscreenSuppressedForTest: true,
    cueCount: started.totalSlides,
    outputCount: started.plan.outputs.length,
    outputRoutes: started.plan.outputs.map(output => ({
      outputId: output.id,
      displayId: output.displayId,
      renderer: output.renderer,
      sourceRoleId: output.sourceRoleId
    })),
    packagedInstrumentation: PACKAGED_INSTRUMENTATION
      ? {
          mode: 'node-options-browser-process-preload',
          nonceSha256: require('node:crypto')
            .createHash('sha256')
            .update(PACKAGED_INSTRUMENTATION_NONCE)
            .digest('hex'),
          appIsPackaged: app.isPackaged,
          resourcesPath: fs.realpathSync(process.resourcesPath),
          appPath: fs.realpathSync(app.getAppPath()),
          executablePath: fs.realpathSync(process.execPath),
          sourceMainImported: false,
          privilegedExternalInstrumentation: true,
          faultInjected: true,
          uninstrumentedPackageProof: false,
          physicalDisplayProof: false,
          fullscreenProof: false,
          venueProof: false,
          releaseProof: false
        }
      : null,
    operatorFinish: {
      start: operatorStart,
      routes: operatorRoutes,
      advances: operatorAdvances,
      finalCueOutputStatuses: stateStatuses(operatorFinalState),
      finalCueAllOutputsVisible:
        everyShowOutput(operatorFinalState, output => output?.visible === true),
      finalCueWindowVisibilities: operatorFinalWindowVisibilities,
      finalCueAllWindowsVisible:
        Object.values(operatorFinalWindowVisibilities).every(Boolean),
      finalCueRenderedOnEveryOutput:
        everySurface(finalCueSurfaces, surface =>
          surface.activeNativeText.includes(FINAL_CUE_TEXT)),
      ...finish
    },
    delayedAcknowledgement: {
      previousCueIndex: 0,
      targetCueIndex: 1,
      heldOutputId: SINGER_OUTPUT_ID,
      alreadyAcknowledgedOutputIds: [...EARLY_ACK_OUTPUT_IDS],
      statusesWhileSingerHeld: delayedStatusesWhileSingerHeld,
      heldReceiptCount: delayedHeldReceiptCount,
      pendingWhileSingerHeld: pendingDelayed.settled === false,
      authoritativeCueRetainedWhileSingerHeld:
        pendingState.currentCue.index === 0,
      secondAdvanceRejected: secondAdvance.fulfilled === false,
      secondAdvanceMessageMatched:
        /Wait for the current cue/u.test(secondAdvance.error.message),
      allOutputsHealthyAfterRelease:
        everyShowOutput(afterDelayed, output => output?.status === 'healthy'),
      committedAfterRelease: afterDelayed.currentCue.index === 1
    },
    negativeAcknowledgement: {
      previousCueIndex: 1,
      rejectedCueIndex: 2,
      rejectedOutputId: SINGER_OUTPUT_ID,
      authoritativeCueRetained: afterRejected.currentCue.index === 1,
      phase: afterRejected.phase,
      outputStatuses: stateStatuses(afterRejected),
      allRendererClearClassesApplied:
        everySurface(rejectedSurfaces, surface => surface.cleared)
    },
    clearAndLateAcknowledgement: {
      previousCueIndex: 1,
      cancelledCueIndex: 2,
      heldOutputId: SINGER_OUTPUT_ID,
      navigationApplied: cancelled.value.applied,
      authoritativeCueRetained: afterLateClearReceipt.currentCue.index === 1,
      phase: afterLateClearReceipt.phase,
      allRendererClearClassesAppliedAfterLateReceipt:
        everySurface(clearSurfaces, surface => surface.cleared)
    },
    restoreFromClear: {
      authoritativeCueIndex: 1,
      heldOutputId: SINGER_OUTPUT_ID,
      alreadyAcknowledgedOutputIds: [...EARLY_ACK_OUTPUT_IDS],
      statusesWhileSingerHeld: clearRestoreStatusesWhileSingerHeld,
      heldReceiptCount: clearRestoreHeldReceiptCount,
      pendingWhileReceiptHeld: pendingClearRestore.settled === false,
      authoritativeCueRetainedWhileSingerHeld:
        duringClearRestore.currentCue.index === 1,
      allWindowsVisibleBeforeRestore:
        Object.values(clearWindowVisibilityBeforeRestore).every(Boolean),
      allOutputsVisibleWhileReceiptHeld:
        everyShowOutput(duringClearRestore, output => output?.visible === true),
      allWindowsVisibleWhileReceiptHeld:
        Object.values(clearRestoreWindowVisibilityWhileHeld).every(Boolean),
      allRendererGuardsVisibleWhileReceiptHeld:
        everySurface(clearRestoreGuardedSurfaces, surface =>
          surface.restoreGuard.cssVisible),
      allRendererGuardsCoverViewportWhileReceiptHeld:
        everySurface(clearRestoreGuardedSurfaces, surface =>
          surface.restoreGuard.coversViewport),
      allRendererGuardsOpaqueBlackWhileReceiptHeld:
        everySurface(clearRestoreGuardedSurfaces, surface =>
          surface.restoreGuard.opaqueBlack),
      authoritativeCueRenderedUnderEveryGuard:
        everySurface(clearRestoreGuardedSurfaces, surface =>
          surface.activeNativeText.includes(AUTHORITATIVE_RESTORE_TEXT)),
      phase: afterClearRestore.phase,
      allOutputStatusesHealthy:
        everyShowOutput(afterClearRestore, output => output?.status === 'healthy'),
      allOutputsVisible:
        everyShowOutput(afterClearRestore, output => output?.visible === true),
      allWindowsVisible:
        Object.values(clearRestoreWindowVisibilityAfterRelease).every(Boolean),
      allRendererGuardsHiddenAfterRestore:
        everySurface(clearRestoreReleasedSurfaces, surface =>
          !surface.restoreGuard.cssVisible),
      authoritativeCueRetained:
        afterClearRestore.currentCue.index === 1
    },
    restorePreemptedByClear: {
      authoritativeCueIndex: 1,
      heldOutputId: SINGER_OUTPUT_ID,
      statusesWhileSingerHeld: stateStatuses(duringPreemptedRestore),
      heldReceiptCount: preemptedRestoreHeldReceiptCount,
      pendingBeforeClear: pendingPreemptedRestore.settled === false,
      restoreRejected: preemptedRestore.fulfilled === false,
      authoritativeCueRetained:
        afterRestorePreemption.currentCue.index === 1,
      phase: afterRestorePreemption.phase,
      allOutputStatusesCleared:
        everyShowOutput(afterRestorePreemption, output =>
          output?.status === 'cleared'),
      allOutputsVisible:
        everyShowOutput(afterRestorePreemption, output => output?.visible === true),
      allWindowsVisible:
        Object.values(restorePreemptedWindowVisibility).every(Boolean),
      allRendererClearClassesApplied:
        everySurface(restorePreemptedSurfaces, surface => surface.cleared),
      allRendererGuardsVisible:
        everySurface(restorePreemptedSurfaces, surface =>
          surface.restoreGuard.cssVisible),
      allRendererGuardsOpaqueBlack:
        everySurface(restorePreemptedSurfaces, surface =>
          surface.restoreGuard.opaqueBlack),
      lateFrameReceiptDidNotReveal:
        afterLatePreemptedRestoreReceipt.phase === 'cleared'
        && afterLatePreemptedRestoreReceipt.currentCue.index === 1
        && everyShowOutput(afterLatePreemptedRestoreReceipt, output =>
          output?.visible === true)
        && everySurface(afterLatePreemptedRestoreSurfaces, surface =>
          surface.restoreGuard.cssVisible
          && surface.restoreGuard.opaqueBlack)
        && Object.values(
          restorePreemptedWindowVisibilityAfterLateReceipt
        ).every(Boolean)
    },
    timeout: {
      previousCueIndex: 1,
      timedOutCueIndex: 2,
      heldOutputId: SINGER_OUTPUT_ID,
      statusesWhileSingerHeld: stateStatuses(pendingTimeoutState),
      authoritativeCueRetained: afterTimeout.currentCue.index === 1,
      timeoutMessageMatched:
        /did not reach every output within 15 seconds/u.test(
          timedOut.error.message
        ),
      preLateReceiptPhase: afterTimeout.phase,
      phase: afterLateTimeoutReceipt.phase,
      allOutputsHidden:
        everyShowOutput(afterLateTimeoutReceipt, output => output?.visible === false),
      allWindowsHiddenBeforeLateReceipt:
        !Object.values(windowVisibilityAfterTimeout).some(Boolean),
      allWindowsHidden:
        !Object.values(windowVisibilityAfterLateTimeoutReceipt).some(Boolean),
      lateReceiptDidNotCommit:
        afterLateTimeoutReceipt.currentCue.index === 1,
      staleTimedOutCueRenderedOnEveryHiddenOutput:
        everySurface(timedOutSurfaces, surface =>
          surface.activeNativeText.includes(STALE_TIMEOUT_TEXT)),
      elapsedMs: timeoutElapsedMs
    },
    restoreAfterTimeout: {
      authoritativeCueIndex: 1,
      heldOutputId: SINGER_OUTPUT_ID,
      alreadyAcknowledgedOutputIds: [...EARLY_ACK_OUTPUT_IDS],
      statusesWhileSingerHeld: restoreStatusesWhileSingerHeld,
      heldReceiptCount: restoreHeldReceiptCount,
      pendingWhileReceiptHeld: pendingRestore.settled === false,
      authoritativeCueRetainedWhileHeld:
        duringRestore.currentCue.index === 1,
      allOutputsVisibleWhileReceiptHeld:
        everyShowOutput(duringRestore, output => output?.visible === true),
      allWindowsVisibleWhileReceiptHeld:
        Object.values(windowVisibilityWhileRestoreReceiptHeld).every(Boolean),
      allRendererGuardsVisibleWhileReceiptHeld:
        everySurface(duringRestoreSurfaces, surface =>
          surface.restoreGuard.cssVisible),
      allRendererGuardsCoverViewportWhileReceiptHeld:
        everySurface(duringRestoreSurfaces, surface =>
          surface.restoreGuard.coversViewport),
      allRendererGuardsOpaqueBlackWhileReceiptHeld:
        everySurface(duringRestoreSurfaces, surface =>
          surface.restoreGuard.opaqueBlack),
      authoritativeCueRenderedUnderEveryGuard:
        everySurface(duringRestoreSurfaces, surface =>
          surface.activeNativeText.includes(AUTHORITATIVE_RESTORE_TEXT)),
      phase: afterSafeRestore.phase,
      allOutputStatusesHealthy:
        everyShowOutput(afterSafeRestore, output => output?.status === 'healthy'),
      allOutputsVisible:
        everyShowOutput(afterSafeRestore, output => output?.visible === true),
      allWindowsVisible:
        Object.values(windowVisibilityAfterRestore).every(Boolean),
      allRendererGuardsHiddenAfterRestore:
        everySurface(restoredSurfaces, surface =>
          !surface.restoreGuard.cssVisible),
      authoritativeCueRetained:
        afterSafeRestore.currentCue.index === 1,
      authoritativeCueRenderedAfterEveryReveal:
        everySurface(restoredSurfaces, surface =>
          surface.activeNativeText.includes(AUTHORITATIVE_RESTORE_TEXT)),
      staleTimedOutCueReplacedOnEveryOutput:
        everySurface(restoredSurfaces, surface =>
          !surface.activeNativeText.includes(STALE_TIMEOUT_TEXT))
    }
  };
}

if (!PACKAGED_INSTRUMENTATION) require('../../main');

app.whenReady().then(async () => {
  let exitCode = 0;
  try {
    const result = await run();
    await writeResult(result);
  } catch (error) {
    exitCode = 1;
    try {
      await writeResult({
        ok: false,
        contract: CONTRACT,
        profileIsolated: false,
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : null
      });
    } catch (writeError) {
      console.error(
        '[Live cue navigation Electron verifier] Could not write failure result:',
        writeError
      );
    }
    console.error('[Live cue navigation Electron verifier] Failed:', error);
  } finally {
    frameFault.mode = 'pass';
    frameFault.targetIndex = null;
    frameFault.targetSender = null;
    frameFault.targetOutputId = null;
    frameFault.held.length = 0;
    ipcMain.emit = originalIpcMainEmit;
    BrowserWindow.prototype.setFullScreen = originalSetFullScreen;
    if (originalGetAllDisplays) screen.getAllDisplays = originalGetAllDisplays;
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed()) window.destroy();
    }
    app.exit(exitCode);
  }
}).catch(error => {
  console.error(
    '[Live cue navigation Electron verifier] App readiness failed:',
    error
  );
  app.exit(1);
});
