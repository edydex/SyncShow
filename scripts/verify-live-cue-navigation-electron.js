'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const electronPath = require('electron');

const RESULT_FILE = 'live-cue-navigation-electron.json';
const TIMEOUT_MS = 120_000;
const MAX_LOG_BYTES = 256 * 1024;
const OUTPUT_IDS = Object.freeze([
  'front-projector',
  'translation-projector',
  'singers-monitor'
]);
const EARLY_ACK_OUTPUT_IDS = Object.freeze(OUTPUT_IDS.slice(0, 2));
const SINGER_HELD_STATUSES = Object.freeze({
  'front-projector': 'healthy',
  'translation-projector': 'healthy',
  'singers-monitor': 'starting'
});
const SINGER_HELD_RESTORE_STATUSES = Object.freeze({
  'front-projector': 'cleared',
  'translation-projector': 'cleared',
  'singers-monitor': 'starting'
});

function boundedCollector(stream) {
  let value = '';
  stream.setEncoding('utf8');
  stream.on('data', chunk => {
    value = `${value}${chunk}`;
    if (Buffer.byteLength(value, 'utf8') > MAX_LOG_BYTES) {
      value = value.slice(-MAX_LOG_BYTES);
    }
  });
  return () => value;
}

function runElectron({ profilePath, resultPath }) {
  const entryPath = path.resolve(
    __dirname,
    'fixtures',
    'live-cue-navigation-electron-app.js'
  );
  const environment = { ...process.env };
  delete environment.ELECTRON_RUN_AS_NODE;
  environment.SYNCSHOW_TEST_USER_DATA_DIR = profilePath;
  environment.SYNCSHOW_LIVE_CUE_NAVIGATION_RESULT = resultPath;
  environment.ELECTRON_DISABLE_SECURITY_WARNINGS = 'true';

  return new Promise((resolve, reject) => {
    const child = spawn(electronPath, [
      entryPath,
      '--syncshow-test-user-data',
      '--headless'
    ], {
      cwd: path.resolve(__dirname, '..'),
      env: environment,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    const stdout = boundedCollector(child.stdout);
    const stderr = boundedCollector(child.stderr);
    let timedOut = false;
    let forceKillTimer = null;
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      forceKillTimer = setTimeout(() => child.kill('SIGKILL'), 5_000);
    }, TIMEOUT_MS);

    child.once('error', error => {
      clearTimeout(timeout);
      if (forceKillTimer) clearTimeout(forceKillTimer);
      reject(error);
    });
    child.once('close', (code, signal) => {
      clearTimeout(timeout);
      if (forceKillTimer) clearTimeout(forceKillTimer);
      resolve({
        code,
        signal,
        timedOut,
        stdout: stdout(),
        stderr: stderr()
      });
    });
  });
}

async function main() {
  const root = await fs.mkdtemp(path.join(
    os.tmpdir(),
    'syncshow-live-cue-navigation-'
  ));
  const profilePath = path.join(root, 'profile');
  const resultPath = path.join(profilePath, RESULT_FILE);
  await fs.mkdir(profilePath, { mode: 0o700 });

  try {
    const child = await runElectron({ profilePath, resultPath });
    let result;
    try {
      result = JSON.parse(await fs.readFile(resultPath, 'utf8'));
    } catch (error) {
      throw new Error([
        'The Electron live-cue navigation verifier did not produce a result.',
        `Exit code: ${child.code}; signal: ${child.signal || 'none'}; timed out: ${child.timedOut}.`,
        child.stdout ? `stdout:\n${child.stdout}` : '',
        child.stderr ? `stderr:\n${child.stderr}` : '',
        `Result read error: ${error.message}`
      ].filter(Boolean).join('\n'));
    }

    assert.equal(child.timedOut, false, 'Electron verification timed out.');
    assert.equal(child.code, 0, child.stderr || child.stdout);
    assert.equal(result.ok, true, result.stack || result.error);
    assert.equal(
      result.contract,
      'syncshow-live-cue-navigation-real-electron-v3'
    );
    assert.equal(result.profileIsolated, true);
    assert.equal(result.productionMainPreloadOutputRenderer, true);
    assert.equal(result.syntheticDisplayConfinedToFixture, true);
    assert.equal(result.fullscreenSuppressedForTest, true);
    assert.equal(result.cueCount, 4);
    assert.equal(result.outputCount, 3);
    assert.equal(result.packagedInstrumentation, null);
    assert.deepEqual(result.outputRoutes, [
      {
        outputId: 'front-projector',
        displayId: 880_001,
        renderer: 'native-cue',
        sourceRoleId: 'front'
      },
      {
        outputId: 'translation-projector',
        displayId: 880_002,
        renderer: 'native-cue',
        sourceRoleId: 'translation'
      },
      {
        outputId: 'singers-monitor',
        displayId: 880_003,
        renderer: 'native-cue',
        sourceRoleId: 'singers'
      }
    ]);
    assert.deepEqual(result.delayedAcknowledgement, {
      previousCueIndex: 0,
      targetCueIndex: 1,
      heldOutputId: 'singers-monitor',
      alreadyAcknowledgedOutputIds: [...EARLY_ACK_OUTPUT_IDS],
      statusesWhileSingerHeld: { ...SINGER_HELD_STATUSES },
      heldReceiptCount: 1,
      pendingWhileSingerHeld: true,
      authoritativeCueRetainedWhileSingerHeld: true,
      secondAdvanceRejected: true,
      secondAdvanceMessageMatched: true,
      allOutputsHealthyAfterRelease: true,
      committedAfterRelease: true
    });
    assert.deepEqual(result.negativeAcknowledgement, {
      previousCueIndex: 1,
      rejectedCueIndex: 2,
      rejectedOutputId: 'singers-monitor',
      authoritativeCueRetained: true,
      phase: 'interrupted',
      outputStatuses: {
        'front-projector': 'cleared',
        'translation-projector': 'cleared',
        'singers-monitor': 'unavailable'
      },
      allRendererClearClassesApplied: true
    });
    assert.deepEqual(result.clearAndLateAcknowledgement, {
      previousCueIndex: 1,
      cancelledCueIndex: 2,
      heldOutputId: 'singers-monitor',
      navigationApplied: false,
      authoritativeCueRetained: true,
      phase: 'cleared',
      allRendererClearClassesAppliedAfterLateReceipt: true
    });
    assert.deepEqual(result.restoreFromClear, {
      authoritativeCueIndex: 1,
      heldOutputId: 'singers-monitor',
      alreadyAcknowledgedOutputIds: [...EARLY_ACK_OUTPUT_IDS],
      statusesWhileSingerHeld: { ...SINGER_HELD_RESTORE_STATUSES },
      heldReceiptCount: 1,
      pendingWhileReceiptHeld: true,
      authoritativeCueRetainedWhileSingerHeld: true,
      allWindowsVisibleBeforeRestore: true,
      allOutputsVisibleWhileReceiptHeld: true,
      allWindowsVisibleWhileReceiptHeld: true,
      allRendererGuardsVisibleWhileReceiptHeld: true,
      allRendererGuardsCoverViewportWhileReceiptHeld: true,
      allRendererGuardsOpaqueBlackWhileReceiptHeld: true,
      authoritativeCueRenderedUnderEveryGuard: true,
      phase: 'live',
      allOutputStatusesHealthy: true,
      allOutputsVisible: true,
      allWindowsVisible: true,
      allRendererGuardsHiddenAfterRestore: true,
      authoritativeCueRetained: true
    });
    assert.deepEqual(result.restorePreemptedByClear, {
      authoritativeCueIndex: 1,
      heldOutputId: 'singers-monitor',
      statusesWhileSingerHeld: { ...SINGER_HELD_RESTORE_STATUSES },
      heldReceiptCount: 1,
      pendingBeforeClear: true,
      restoreRejected: true,
      authoritativeCueRetained: true,
      phase: 'cleared',
      allOutputStatusesCleared: true,
      allOutputsVisible: true,
      allWindowsVisible: true,
      allRendererClearClassesApplied: true,
      allRendererGuardsVisible: true,
      allRendererGuardsOpaqueBlack: true,
      lateFrameReceiptDidNotReveal: true
    });
    const { elapsedMs, ...timeoutResult } = result.timeout;
    assert.deepEqual(timeoutResult, {
      previousCueIndex: 1,
      timedOutCueIndex: 2,
      heldOutputId: 'singers-monitor',
      statusesWhileSingerHeld: { ...SINGER_HELD_STATUSES },
      authoritativeCueRetained: true,
      timeoutMessageMatched: true,
      preLateReceiptPhase: 'interrupted',
      phase: 'hidden',
      allOutputsHidden: true,
      allWindowsHiddenBeforeLateReceipt: true,
      allWindowsHidden: true,
      lateReceiptDidNotCommit: true,
      staleTimedOutCueRenderedOnEveryHiddenOutput: true
    });
    assert.ok(elapsedMs >= 14_000);
    assert.ok(elapsedMs < 30_000);
    assert.deepEqual(result.restoreAfterTimeout, {
      authoritativeCueIndex: 1,
      heldOutputId: 'singers-monitor',
      alreadyAcknowledgedOutputIds: [...EARLY_ACK_OUTPUT_IDS],
      statusesWhileSingerHeld: { ...SINGER_HELD_RESTORE_STATUSES },
      heldReceiptCount: 1,
      pendingWhileReceiptHeld: true,
      authoritativeCueRetainedWhileHeld: true,
      allOutputsVisibleWhileReceiptHeld: true,
      allWindowsVisibleWhileReceiptHeld: true,
      allRendererGuardsVisibleWhileReceiptHeld: true,
      allRendererGuardsCoverViewportWhileReceiptHeld: true,
      allRendererGuardsOpaqueBlackWhileReceiptHeld: true,
      authoritativeCueRenderedUnderEveryGuard: true,
      phase: 'live',
      allOutputStatusesHealthy: true,
      allOutputsVisible: true,
      allWindowsVisible: true,
      allRendererGuardsHiddenAfterRestore: true,
      authoritativeCueRetained: true,
      authoritativeCueRenderedAfterEveryReveal: true,
      staleTimedOutCueReplacedOnEveryOutput: true
    });
    assert.deepEqual(result.operatorFinish.start.before, {
      ready: true,
      disabled: false,
      loadStage: true,
      handoffVisible: true
    });
    assert.equal(result.operatorFinish.start.showStage, true);
    assert.equal(
      result.operatorFinish.start.activeLaunchPlan.outputs.length,
      3
    );
    assert.equal(result.operatorFinish.advances.length, 3);
    assert.deepEqual(result.operatorFinish.routes, [
      {
        id: 'front-projector',
        displayId: 880_001,
        renderer: 'native-cue',
        sourceRoleId: 'front'
      },
      {
        id: 'translation-projector',
        displayId: 880_002,
        renderer: 'native-cue',
        sourceRoleId: 'translation'
      },
      {
        id: 'singers-monitor',
        displayId: 880_003,
        renderer: 'native-cue',
        sourceRoleId: 'singers'
      }
    ]);
    assert.deepEqual(
      result.operatorFinish.advances.map(advance => advance.targetIndex),
      [1, 2, 3]
    );
    assert.equal(
      result.operatorFinish.advances.every(advance =>
        advance.disabled === false && advance.visible === true),
      true
    );
    assert.equal(result.operatorFinish.finalCueRenderedOnEveryOutput, true);
    assert.deepEqual(result.operatorFinish.finalCueOutputStatuses, {
      'front-projector': 'healthy',
      'translation-projector': 'healthy',
      'singers-monitor': 'healthy'
    });
    assert.equal(result.operatorFinish.finalCueAllOutputsVisible, true);
    assert.deepEqual(result.operatorFinish.finalCueWindowVisibilities, {
      'front-projector': true,
      'translation-projector': true,
      'singers-monitor': true
    });
    assert.equal(result.operatorFinish.finalCueAllWindowsVisible, true);
    assert.deepEqual(result.operatorFinish.button, {
      text: 'Finish service…',
      ariaLabel: 'Finish service and return safely to Load',
      ariaBusy: null,
      disabled: false,
      visible: true,
      showStage: true
    });
    assert.deepEqual(result.operatorFinish.afterFirstClick, {
      text: 'Finishing service…',
      ariaBusy: 'true',
      disabled: true,
      showEndSessionBusy: true
    });
    assert.equal(
      result.operatorFinish.secondClickIssuedWhileDisabled,
      true
    );
    assert.equal(
      result.operatorFinish.secondClickIssuedWhileBusy,
      true
    );
    assert.equal(
      result.operatorFinish.synchronousDoubleClickBarrierObserved,
      true
    );
    assert.equal(result.operatorFinish.load.loadStage, true);
    assert.equal(result.operatorFinish.load.dialogOpen, true);
    assert.equal(result.operatorFinish.load.dialogMode, 'native');
    assert.equal(result.operatorFinish.load.dialogTitleFocused, true);
    assert.equal(
      result.operatorFinish.load.handoffTitle,
      'Acknowledged Navigation Electron Proof'
    );
    assert.equal(result.operatorFinish.load.handoffBadge, 'Ready');
    assert.equal(result.operatorFinish.showPhase, 'idle');
    assert.equal(result.operatorFinish.outputSessionId, null);
    assert.equal(result.operatorFinish.outputWindowCount, 0);
    assert.equal(result.operatorFinish.projectStatus, 'ready');
    assert.equal(result.operatorFinish.projectRevisionUnchanged, true);
    assert.equal(result.operatorFinish.dialogClosed, true);
    assert.equal(result.operatorFinish.loadFocusedAfterClose, true);

    process.stdout.write(`${JSON.stringify(result)}\n`);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
