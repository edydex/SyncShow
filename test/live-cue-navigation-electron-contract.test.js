'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const runner = fs.readFileSync(path.join(
  root,
  'scripts',
  'verify-live-cue-navigation-electron.js'
), 'utf8');
const fixture = fs.readFileSync(path.join(
  root,
  'scripts',
  'fixtures',
  'live-cue-navigation-electron-app.js'
), 'utf8');
const packagedPreload = fs.readFileSync(path.join(
  root,
  'scripts',
  'fixtures',
  'packaged-live-cue-navigation-preload.js'
), 'utf8');
const packageJson = JSON.parse(fs.readFileSync(
  path.join(root, 'package.json'),
  'utf8'
));

test('real Electron navigation proof is isolated and runs the production app', () => {
  assert.equal(
    packageJson.scripts['test:live-cue-navigation-electron'],
    'node scripts/verify-live-cue-navigation-electron.js'
  );
  assert.match(runner, /--syncshow-test-user-data/u);
  assert.match(runner, /syncshow-live-cue-navigation-real-electron-v3/u);
  assert.match(fixture, /if \(!PACKAGED_INSTRUMENTATION\) require\('\.\.\/\.\.\/main'\);/u);
  assert.match(fixture, /ISOLATED_TEST_USER_DATA_MARKER/u);
  assert.match(fixture, /window\.api\.publishServiceProject\(/u);
  assert.match(fixture, /window\.api\.startPresentation\(/u);
  assert.match(fixture, /\/src\/renderer\/display\.html/u);
});

test('packaged instrumentation is browser-process-only and imports no source product code', () => {
  assert.match(packagedPreload, /process\.type === 'browser'/u);
  assert.match(
    packagedPreload,
    /SYNCSHOW_PACKAGED_LIVE_CUE_INSTRUMENTATION === '1'/u
  );
  assert.match(
    packagedPreload,
    /require\('\.\/live-cue-navigation-electron-app'\)/u
  );
  assert.match(
    fixture,
    /PACKAGED_INSTRUMENTATION[\s\S]*?\.syncshow-isolated-test-user-data/u
  );
  assert.match(fixture, /assert\.equal\(process\.type, 'browser'\)/u);
  assert.match(fixture, /assert\.equal\(app\.isPackaged, true\)/u);
  assert.match(fixture, /SYNCSHOW_EXPECTED_PACKAGED_RESOURCES/u);
  assert.match(fixture, /SYNCSHOW_EXPECTED_PACKAGED_APP_PATH/u);
  assert.match(fixture, /SYNCSHOW_EXPECTED_PACKAGED_EXECUTABLE/u);
  assert.match(fixture, /SYNCSHOW_EXPECTED_PACKAGED_PRELOAD/u);
  assert.match(fixture, /sourceMainImported: false/u);
});

test('real Electron navigation proof confines display simulation to its fixture', () => {
  assert.match(fixture, /app\.once\('ready', installSyntheticDisplays\)/u);
  assert.match(fixture, /originalGetAllDisplays = screen\.getAllDisplays/u);
  assert.match(fixture, /screen\.getAllDisplays = syntheticGetAllDisplays/u);
  assert.match(fixture, /const originalSetFullScreen = BrowserWindow\.prototype\.setFullScreen/u);
  assert.match(
    fixture,
    /BrowserWindow\.prototype\.setFullScreen = function suppressTestFullscreen/u
  );
  assert.match(fixture, /displayId: 880_001/u);
  assert.match(fixture, /displayId: 880_002/u);
  assert.match(fixture, /displayId: 880_003/u);
  assert.match(fixture, /syntheticDisplayConfinedToFixture: true/u);
  assert.match(fixture, /fullscreenSuppressedForTest: true/u);
});

test('real Electron proof joins exact Front, Translation, and Singer senders', () => {
  assert.match(fixture, /id: 'front-projector'/u);
  assert.match(fixture, /roleId: 'front'/u);
  assert.match(fixture, /id: 'translation-projector'/u);
  assert.match(fixture, /roleId: 'translation'/u);
  assert.match(fixture, /id: 'singers-monitor'/u);
  assert.match(fixture, /roleId: 'singers'/u);
  assert.match(fixture, /event\?\.sender !== frameFault\.targetSender/u);
  assert.match(fixture, /targetSingerFrame\('hold', 1, outputs\)/u);
  assert.match(fixture, /targetSingerFrame\('negative', 2, outputs\)/u);
  assert.match(fixture, /EARLY_ACK_OUTPUT_IDS\.every/u);
  assert.match(fixture, /statusesWhileSingerHeld/u);
  assert.match(runner, /assert\.equal\(result\.outputCount, 3\)/u);
  assert.match(runner, /alreadyAcknowledgedOutputIds/u);
  assert.match(runner, /'singers-monitor': 'starting'/u);
});

test('real Electron proof covers selected three-output ACK and Restore-guard races', () => {
  assert.match(fixture, /channel !== 'output:frameReady'/u);
  assert.match(fixture, /const secondAdvance = await invokeNext\(control\)/u);
  assert.match(fixture, /window\.api\.clearDisplays\(\)/u);
  assert.match(fixture, /waitForPendingOperation\([\s\S]*?'timeout',[\s\S]*?30_000/u);
  assert.match(fixture, /did not reach every output within 15 seconds/u);
  assert.match(fixture, /staleTimedOutCueRenderedOnEveryHiddenOutput/u);
  assert.match(fixture, /preLateReceiptPhase: afterTimeout\.phase/u);
  assert.match(runner, /preLateReceiptPhase: 'interrupted'/u);
  assert.match(runner, /phase: 'hidden'/u);
  assert.match(fixture, /document\.querySelector\('#outputRestoreGuard'\)/u);
  assert.match(fixture, /window\.getComputedStyle\(guard\)/u);
  assert.match(fixture, /guard\.hidden === false/u);
  assert.match(fixture, /guardRect\.width === window\.innerWidth/u);
  assert.match(fixture, /opaqueBlack: guardCssVisible/u);
  assert.match(fixture, /beginRestore\(control, 'restore-from-clear'\)/u);
  assert.match(fixture, /clearRestoreWindowVisibilityWhileHeld/u);
  assert.match(fixture, /allRendererGuardsVisibleWhileReceiptHeld/u);
  assert.match(fixture, /allRendererGuardsCoverViewportWhileReceiptHeld/u);
  assert.match(fixture, /allRendererGuardsOpaqueBlackWhileReceiptHeld/u);
  assert.match(fixture, /authoritativeCueRenderedUnderEveryGuard/u);
  assert.match(
    fixture,
    /beginRestore\(control, 'restore-preempted-by-clear'\)/u
  );
  assert.match(fixture, /preemptedRestore\.fulfilled, false/u);
  assert.match(fixture, /lateFrameReceiptDidNotReveal/u);
  assert.match(fixture, /beginRestore\(control, 'restore-after-timeout'\)/u);
  assert.match(fixture, /pendingRestore\.settled, false/u);
  assert.match(fixture, /windowVisibilityWhileRestoreReceiptHeld/u);
  assert.match(fixture, /authoritativeCueRenderedAfterEveryReveal/u);
  assert.match(fixture, /staleTimedOutCueReplacedOnEveryOutput/u);
  assert.match(fixture, /lateReceiptDidNotCommit/u);
  assert.match(runner, /heldReceiptCount: 1/u);
  assert.match(runner, /authoritativeCueRetained: true/u);
  assert.match(runner, /allRendererClearClassesApplied: true/u);
  assert.match(runner, /fullscreenSuppressedForTest, true/u);
});

test('real Electron proof ends a fresh positive session through the final-cue UI', () => {
  assert.match(fixture, /startShowThroughOperatorUi\(control, published\)/u);
  assert.match(fixture, /clickNextThroughOperatorUi\(control\)/u);
  assert.match(fixture, /for \(const targetIndex of \[1, 2, 3\]\)/u);
  assert.match(fixture, /Finish service…/u);
  assert.match(fixture, /button\.click\(\);[\s\S]*?button\.click\(\);/u);
  assert.match(fixture, /Finishing service…/u);
  assert.match(fixture, /dialog\.dataset\.mode !== 'native'/u);
  assert.match(fixture, /document\.activeElement !== title/u);
  assert.match(fixture, /window\.api\.openServiceProject/u);
  assert.match(fixture, /project\.project\.planning\.status, 'ready'/u);
  assert.match(fixture, /const operatorRoutes = operatorStart\.activeLaunchPlan\.outputs/u);
  assert.match(fixture, /output\.visible === true/u);
  assert.match(fixture, /operatorFinalWindowVisibilities/u);
  assert.match(fixture, /outputWindowCount: 0/u);
  assert.match(fixture, /loadFocusedAfterClose/u);
  assert.match(runner, /synchronousDoubleClickBarrierObserved/u);
  assert.match(runner, /projectRevisionUnchanged/u);
});
