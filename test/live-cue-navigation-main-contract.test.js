'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const mainSource = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
const rendererSource = fs.readFileSync(
  path.join(root, 'src', 'renderer', 'app.js'),
  'utf8'
);
const singerSource = fs.readFileSync(
  path.join(root, 'src', 'renderer', 'singer.js'),
  'utf8'
);
const displaySource = fs.readFileSync(
  path.join(root, 'src', 'renderer', 'display.js'),
  'utf8'
);
const preloadSource = fs.readFileSync(path.join(root, 'preload.js'), 'utf8');
const remoteClientSource = fs.readFileSync(
  path.join(root, 'src', 'remote', 'remote.js'),
  'utf8'
);
const remoteServerSource = fs.readFileSync(
  path.join(root, 'src', 'services', 'remote', 'RemoteServer.js'),
  'utf8'
);
const remoteAdapterSource = fs.readFileSync(
  path.join(root, 'src', 'services', 'show', 'RemoteCommandAdapter.js'),
  'utf8'
);
const coordinatorSource = fs.readFileSync(
  path.join(root, 'src', 'services', 'show', 'LiveCueTransitionCoordinator.js'),
  'utf8'
);
const accessibility = require(path.join(
  root,
  'src',
  'renderer',
  'show-accessibility.js'
));

function section(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  assert.notEqual(start, -1, `missing source marker: ${startMarker}`);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.notEqual(end, -1, `missing source marker after ${startMarker}: ${endMarker}`);
  return source.slice(start, end);
}

function functionSection(source, functionName) {
  const declaration = new RegExp(
    `(?:async\\s+)?function\\s+${functionName}\\s*\\(`,
    'u'
  );
  const match = declaration.exec(source);
  assert.ok(match, `missing function declaration: ${functionName}`);
  const start = match.index;
  const remainder = source.slice(start + match[0].length);
  const next = /\n(?:async\s+)?function\s+[A-Za-z_$][\w$]*\s*\(/u.exec(remainder);
  return next
    ? source.slice(start, start + match[0].length + next.index)
    : source.slice(start);
}

function assertOrdered(source, markers, label) {
  let previous = -1;
  for (const marker of markers) {
    const index = source.indexOf(marker);
    assert.ok(index >= 0, `${label}: missing ${marker}`);
    assert.ok(index > previous, `${label}: ${marker} is out of order`);
    previous = index;
  }
}

function productionNavigationHarness({ timeoutMs = 500 } = {}) {
  const events = [];
  const context = vm.createContext({
    setTimeout,
    clearTimeout,
    outputsShouldBeVisible: true,
    outputLifecyclePhase: 'live',
    pendingBibleLookup: null,
    activeBibleOverlay: null,
    pendingBibleOverlay: null,
    activeLiveCueNavigation: null,
    outputSessionId: 31,
    outputWindows: { size: 2 },
    module: { exports: {} },
    exports: {},
    appState: null,
    liveCueTransitionCoordinator: null,
    currentLiveCueTransitionOutputs: null,
    sameLiveCueTransitionOutputs: null,
    dispatchCueToOutputs(index, options) {
      assert.equal(options.expectedOutputs, context.outputs);
      events.push(['dispatch', index]);
      return { accepted: true, dispatchedOutputs: context.outputs.length };
    },
    publishShowState(reason) {
      events.push(['publish', reason]);
    },
    commitCueNavigation(index) {
      events.push(['commit', index]);
      context.appState.currentSlide = index;
    },
    markLiveCueTransitionFailure(expected, sessionId, cueIndex) {
      events.push(['mark-failed', expected, sessionId, cueIndex]);
    },
    clearAllDisplays() {
      events.push(['clear']);
      return { accepted: true };
    },
    hideDisplayWindows() {
      events.push(['hide']);
      return { accepted: true };
    }
  });
  vm.runInContext(coordinatorSource, context);
  const Coordinator = context.module.exports.LiveCueTransitionCoordinator;
  context.liveCueTransitionCoordinator = new Coordinator({ timeoutMs });
  context.senders = vm.runInContext(
    'Object.freeze([Object.freeze({ id: "front-sender" }), Object.freeze({ id: "confidence-sender" })])',
    context
  );
  context.outputs = vm.runInContext(
    'Object.freeze(['
      + 'Object.freeze({ outputId: "front", sender: senders[0] }),'
      + 'Object.freeze({ outputId: "confidence", sender: senders[1] })'
      + '])',
    context
  );
  context.launchPlan = Object.freeze({
    outputs: Object.freeze([
      Object.freeze({ id: 'front' }),
      Object.freeze({ id: 'confidence' })
    ])
  });
  context.appState = {
    activeLaunchPlan: context.launchPlan,
    currentSlide: 0,
    totalSlides: 4
  };
  context.currentLiveCueTransitionOutputs = () => ({
    accepted: true,
    launchPlan: context.launchPlan,
    outputs: context.outputs
  });
  context.sameLiveCueTransitionOutputs = expected => expected === context.outputs;
  vm.runInContext([
    functionSection(mainSource, 'liveCueNavigationFailure'),
    functionSection(mainSource, 'normalizeLiveCueNavigationFailure'),
    functionSection(mainSource, 'goToSlideConfirmed'),
    'this.goToSlideConfirmed = goToSlideConfirmed;'
  ].join('\n'), context);
  vm.runInContext(`
    this.ackOutput = (index, ok, error = null) =>
      liveCueTransitionCoordinator.acknowledge({
        sender: outputs[index].sender,
        sessionId: 31,
        cueIndex: 1,
        ok,
        error
      });
  `, context);
  return {
    context,
    events,
    outputs: context.outputs,
    senders: context.senders
  };
}

test('Remote commands and trusted local IPC route through acknowledged navigation', () => {
  const remoteCommands = section(
    mainSource,
    'showGateway = new RemoteCommandAdapter({',
    'outputHealthTracker = new OutputHealthTracker({'
  );
  assert.match(remoteCommands, /previous:\s*\(\)\s*=>\s*navigateSlideConfirmed\(-1\)/u);
  assert.match(remoteCommands, /next:\s*\(\)\s*=>\s*navigateSlideConfirmed\(1\)/u);
  assert.match(remoteCommands, /jump:\s*index\s*=>\s*goToSlideConfirmed\(index\)/u);

  const execute = section(
    remoteAdapterSource,
    '  async execute(envelope) {',
    '  _validateEnvelope(envelope) {'
  );
  assert.match(
    execute,
    /const result = command\.type === 'cue\.jump'[\s\S]*?await handler\(command\.cueIndex\)[\s\S]*?: await handler\(\)/u,
    'the Remote boundary must await its confirmed command before publishing success'
  );

  const navigateTo = section(
    mainSource,
    "ipcMain.handle('show:navigateTo'",
    "ipcMain.handle('show:navigateBy'"
  );
  const navigateBy = section(
    mainSource,
    "ipcMain.handle('show:navigateBy'",
    "ipcMain.handle('show:unlockVolunteerControls'"
  );
  assert.match(navigateTo, /const result = await goToSlideConfirmed\(slideIndex\)/u);
  assert.match(navigateBy, /const result = await navigateSlideConfirmed\(delta\)/u);
  assert.match(navigateTo, /showGateway\.getState\(\)/u);
  assert.match(navigateBy, /showGateway\.getState\(\)/u);
});

test('live navigation starts its exact-output barrier before dispatch and commits only after revalidation', () => {
  const confirmed = functionSection(mainSource, 'goToSlideConfirmed');

  assertOrdered(confirmed, [
    'liveCueTransitionCoordinator.begin({',
    'dispatchCueToOutputs(slideIndex, {',
    "publishShowState('cue-transition-started')",
    'const receipt = await operation.promise',
    'const sameSession =',
    'const exactReceipt =',
    '!sameSession',
    '!sameLiveCueTransitionOutputs(outputs)',
    'commitCueNavigation(slideIndex)'
  ], 'acknowledged cue transition');

  assert.match(
    confirmed,
    /liveCueTransitionCoordinator\.begin\(\{[\s\S]*?\n\s*sessionId,[\s\S]*?\n\s*fromCueIndex,/u
  );
  assert.match(confirmed, /toCueIndex:\s*slideIndex/u);
  assert.match(confirmed, /outputs:\s*\[\.\.\.outputs\]/u);
  assert.match(confirmed, /receipt\.sessionId === sessionId/u);
  assert.match(confirmed, /receipt\?\.kind === LIVE_CUE_TRANSITION_RECEIPT_KIND/u);
  assert.match(confirmed, /receipt\.schemaVersion === LIVE_CUE_TRANSITION_SCHEMA_VERSION/u);
  assert.match(confirmed, /receipt\.fromCueIndex === fromCueIndex/u);
  assert.match(confirmed, /receipt\.toCueIndex === slideIndex/u);
  assert.match(confirmed, /receipt\.outputIds\.length === outputs\.length/u);
  assert.match(confirmed, /outputId === outputs\[index\]\.outputId/u);
  assert.match(confirmed, /appState\.currentSlide !== fromCueIndex/u);

  const beforeReceipt = confirmed.slice(
    0,
    confirmed.indexOf('const receipt = await operation.promise')
  );
  assert.doesNotMatch(
    beforeReceipt,
    /appState\.currentSlide\s*=(?!=)/u,
    'the authoritative cue must not change while outputs are still rendering'
  );
  assert.doesNotMatch(
    confirmed,
    /appState\.currentSlide\s*=(?!=)/u,
    'the confirmed wrapper must delegate the only cue mutation to the commit function'
  );

  const dispatch = functionSection(mainSource, 'dispatchCueToOutputs');
  const commit = functionSection(mainSource, 'commitCueNavigation');
  assert.doesNotMatch(dispatch, /appState\.currentSlide\s*=(?!=)/u);
  assert.match(commit, /appState\.currentSlide = slideIndex/u);
});

test('the production wrapper ignores rapid double Next and commits only after every exact output ACK', async () => {
  const harness = productionNavigationHarness();
  const first = harness.context.goToSlideConfirmed(1);
  const second = await harness.context.goToSlideConfirmed(1);

  assert.equal(second.accepted, false);
  assert.equal(second.code, 'LIVE_CUE_TRANSITION_BUSY');
  assert.equal(harness.context.appState.currentSlide, 0);
  assert.deepEqual(harness.events, [
    ['dispatch', 1],
    ['publish', 'cue-transition-started']
  ]);

  assert.equal(harness.context.ackOutput(0, true), true);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(harness.context.appState.currentSlide, 0);

  assert.equal(harness.context.ackOutput(1, true), true);
  const result = await first;
  assert.equal(result.accepted, true);
  assert.equal(result.applied, true);
  assert.equal(harness.context.appState.currentSlide, 1);
  assert.deepEqual(harness.events.at(-1), ['commit', 1]);
  assert.equal(harness.events.filter(event => event[0] === 'dispatch').length, 1);
});

test('the production wrapper preserves the prior cue and clears after a renderer rejection', async () => {
  const harness = productionNavigationHarness();
  const transition = harness.context.goToSlideConfirmed(1);
  harness.context.ackOutput(0, false, 'Image decode failed');
  const result = await transition;

  assert.equal(result.accepted, false);
  assert.equal(result.code, 'LIVE_CUE_OUTPUT_REJECTED');
  assert.equal(harness.context.appState.currentSlide, 0);
  assert.equal(harness.events.some(event => event[0] === 'commit'), false);
  assert.equal(harness.events.some(event => event[0] === 'mark-failed'), true);
  assert.equal(harness.events.some(event => event[0] === 'clear'), true);
});

test('the production wrapper stops on timeout and treats explicit cancellation as preemption', async () => {
  const timedOut = productionNavigationHarness({ timeoutMs: 10 });
  const timeoutResult = await timedOut.context.goToSlideConfirmed(1);
  assert.equal(timeoutResult.code, 'LIVE_CUE_TRANSITION_TIMEOUT');
  assert.equal(timedOut.context.appState.currentSlide, 0);
  assert.equal(timedOut.events.some(event => event[0] === 'hide'), true);
  assert.equal(timedOut.events.some(event => event[0] === 'clear'), false);

  const cancelled = productionNavigationHarness();
  const pending = cancelled.context.goToSlideConfirmed(1);
  cancelled.context.liveCueTransitionCoordinator.cancel(
    'Emergency Clear replaced this cue.',
    'LIVE_CUE_TRANSITION_CANCELLED'
  );
  const cancelledResult = await pending;
  assert.equal(cancelledResult.code, 'LIVE_CUE_TRANSITION_CANCELLED');
  assert.equal(cancelled.context.appState.currentSlide, 0);
  assert.equal(cancelled.events.some(event => event[0] === 'commit'), false);
  assert.equal(cancelled.events.some(event => event[0] === 'clear'), false);
  assert.equal(cancelled.events.some(event => event[0] === 'hide'), false);
});

test('Clear, Stop, and output-session destruction preempt a pending transition', () => {
  const clear = functionSection(mainSource, 'clearAllDisplays');
  const stop = functionSection(mainSource, 'hideDisplayWindows');
  const destroy = functionSection(mainSource, 'destroyOutputWindows');

  assert.match(clear, /liveCueTransitionCoordinator\?\.cancel\([\s\S]*?'LIVE_CUE_TRANSITION_CANCELLED'/u);
  assert.match(clear, /win\.webContents\.send\('display:clear'\)/u);
  assert.match(stop, /liveCueTransitionCoordinator\?\.cancel\([\s\S]*?'LIVE_CUE_TRANSITION_CANCELLED'/u);
  assert.match(destroy, /liveCueTransitionCoordinator\?\.cancel\([\s\S]*?'OUTPUT_SESSION_REPLACED'/u);

  assert.ok(
    clear.indexOf('liveCueTransitionCoordinator?.cancel(')
      < clear.indexOf("win.webContents.send('display:clear')"),
    'Clear cancels the old transition before blacking its outputs'
  );
  assert.ok(
    destroy.indexOf('liveCueTransitionCoordinator?.cancel(')
      < destroy.indexOf('outputSessionId += 1'),
    'session teardown cancels before rotating private output identity'
  );
});

test('transition failures mark pending frames unhealthy and black the still-current session', () => {
  const confirmed = functionSection(mainSource, 'goToSlideConfirmed');
  const marker = functionSection(mainSource, 'markLiveCueTransitionFailure');
  const catchStart = confirmed.indexOf(
    '} catch (error) {',
    confirmed.indexOf('commitCueNavigation(slideIndex)')
  );
  assert.ok(catchStart >= 0, 'confirmed navigation must handle a failed barrier');
  const failurePath = confirmed.slice(catchStart);

  assertOrdered(failurePath, [
    'normalizeLiveCueNavigationFailure(error)',
    'liveCueTransitionCoordinator.cancel(failure.message, failure.code)',
    'const sameSession =',
    'const intentionallyPreempted =',
    'markLiveCueTransitionFailure(outputs, sessionId, slideIndex)',
    'clearAllDisplays()'
  ], 'failed cue transition');
  assert.match(failurePath, /failure\.code === 'LIVE_CUE_TRANSITION_CANCELLED'/u);
  assert.match(failurePath, /failure\.code === 'OUTPUT_SESSION_REPLACED'/u);
  assert.match(failurePath, /failure\.code === 'LIVE_CUE_TRANSITION_TIMEOUT'/u);
  assert.match(failurePath, /hideDisplayWindows\(\)/u);
  assert.match(failurePath, /if \(sameSession && !intentionallyPreempted\)/u);

  assert.match(marker, /health\?\.expectedCueIndex !== cueIndex/u);
  assert.match(marker, /health\.status !== 'starting'/u);
  assert.match(marker, /outputHealthTracker\.acknowledge\([\s\S]*?ok:\s*false/u);
});

test('frame acknowledgements resolve the exact transition before health publication can re-enable controls', () => {
  const frameHealth = functionSection(mainSource, 'handleOutputFrameHealth');
  assert.match(frameHealth, /sender:\s*event\.sender/u);
  assert.match(frameHealth, /sessionId:\s*outputSessionId/u);
  assert.match(frameHealth, /cueIndex:\s*payload\?\.index/u);
  assert.match(frameHealth, /ok:\s*payload\?\.ok/u);
  assert.match(frameHealth, /error:\s*payload\?\.error/u);
  assert.ok(
    frameHealth.indexOf('liveCueTransitionCoordinator?.acknowledge({')
      < frameHealth.indexOf('outputHealthTracker.acknowledge(acknowledgement)'),
    'the transition promise must settle before the health tracker schedules public state'
  );

  const windowHealth = functionSection(mainSource, 'trackOutputWindowHealth');
  assert.match(windowHealth, /liveCueTransitionCoordinator\?\.outputFailed\([\s\S]*?'LIVE_CUE_OUTPUT_UNRESPONSIVE'/u);
  assert.match(windowHealth, /liveCueTransitionCoordinator\?\.outputFailed\([\s\S]*?'LIVE_CUE_OUTPUT_PROCESS_GONE'/u);
});

test('the singer screen acknowledges only after decode, replacement, and two paint frames', () => {
  const update = functionSection(singerSource, 'handleUpdate');
  const onloadStart = update.indexOf('img.onload = async () => {');
  const onerrorStart = update.indexOf('img.onerror = () => {', onloadStart);
  assert.ok(onloadStart >= 0 && onerrorStart > onloadStart, 'missing singer image lifecycle');
  const onload = update.slice(onloadStart, onerrorStart);

  assertOrdered(onload, [
    "typeof img.decode === 'function'",
    'await img.decode()',
    'elements.currentSlideContainer.replaceChildren(img)',
    'reportFrameReady(currentSlide, true)'
  ], 'singer frame acknowledgement');
  const firstPaint = onload.indexOf('await waitForPaintFrame()');
  const secondPaint = onload.indexOf('await waitForPaintFrame()', firstPaint + 1);
  assert.ok(
    firstPaint > onload.indexOf('elements.currentSlideContainer.replaceChildren(img)')
      && secondPaint > firstPaint
      && onload.indexOf('thisUpdateVersion !== updateVersion || currentImage !== img', secondPaint)
        > secondPaint
      && onload.indexOf('reportFrameReady(currentSlide, true)', secondPaint) > secondPaint,
    'the singer must wait for two distinct paint frames before its success ACK'
  );
  assert.match(onload, /catch \(error\) \{[\s\S]*?reportFrameReady\(currentSlide, false,/u);
});

test('the browser Remote timeout exceeds the live barrier and safe failures remain operator-readable', () => {
  assert.match(remoteClientSource, /const LIVE_COMMAND_TIMEOUT_MS = 20_000;/u);
  assert.match(remoteClientSource, /timeoutMs:\s*LIVE_COMMAND_TIMEOUT_MS/u);

  const requiredCodes = [
    'LIVE_CUE_DISPATCH_FAILED',
    'LIVE_CUE_OUTPUT_PROCESS_GONE',
    'LIVE_CUE_OUTPUT_REJECTED',
    'LIVE_CUE_OUTPUT_UNRESPONSIVE',
    'LIVE_CUE_TRANSITION_BUSY',
    'LIVE_CUE_TRANSITION_STALE',
    'LIVE_CUE_TRANSITION_TIMEOUT',
    'OUTPUT_CLEAR_FAILED',
    'OUTPUT_SESSION_REPLACED',
    'OUTPUTS_NOT_READY',
    'OUTPUTS_UNAVAILABLE',
    'SHOW_NOT_READY'
  ];
  for (const code of requiredCodes) {
    assert.match(
      remoteServerSource,
      new RegExp(`['\"]${code}['\"]`, 'u'),
      `${code} must cross the Remote boundary without becoming a generic 500`
    );
  }
});

test('Bible and output Restore are unavailable while a cue transition is pending', () => {
  const operator = functionSection(mainSource, 'volunteerShowOperatorState');
  assert.match(operator, /navigationPending\s*=\s*[\s\S]*?liveCueTransitionCoordinator\?\.isPending\(\) === true/u);
  assert.match(operator, /canRestore:\s*!navigationPending/u);
  assert.match(operator, /canShowBible:\s*!navigationPending/u);

  const restore = functionSection(mainSource, 'showAllDisplays');
  assert.match(restore, /liveCueTransitionCoordinator\?\.isPending\(\)/u);
  assert.match(restore, /code:\s*'LIVE_CUE_TRANSITION_BUSY'/u);
  assert.ok(
    restore.indexOf('liveCueTransitionCoordinator?.isPending()')
      < restore.indexOf('liveCueTransitionCoordinator.beginRefresh({'),
    'Restore must fail before revealing or redispatching the current cue'
  );

  const bibleShow = section(
    mainSource,
    "ipcMain.handle('bible:show'",
    "ipcMain.handle('bible:hide'"
  );
  assert.match(bibleShow, /liveCueTransitionCoordinator\?\.isPending\(\)/u);
  assert.match(bibleShow, /failMainOperation\([\s\S]*?'LIVE_CUE_TRANSITION_BUSY'/u);
  assertOrdered(bibleShow, [
    'const lookupToken = Object.freeze({',
    'pendingBibleLookup = lookupToken',
    "publishShowState('bible-lookup-started')",
    'await resolveBibleLookupRequest(request)',
    'pendingBibleLookup !== lookupToken',
    'pendingBibleOverlay = candidate',
    'pendingBibleLookup = null',
    "publishShowState('bible-preparing')"
  ], 'Bible-first cue interlock');
  assert.match(
    bibleShow,
    /finally \{[\s\S]*?pendingBibleLookup === lookupToken[\s\S]*?pendingBibleLookup = null/u
  );

  const confirmed = functionSection(mainSource, 'goToSlideConfirmed');
  assert.match(
    confirmed,
    /if \(pendingBibleLookup \|\| activeBibleOverlay \|\| pendingBibleOverlay\)/u,
    'navigation must reject while Bible lookup owns the opposite-order interlock'
  );
});

test('Restore keeps every output black until its authoritative cue is acknowledged', () => {
  const restore = functionSection(mainSource, 'showAllDisplays');
  const setGuard = functionSection(mainSource, 'setOutputRestoreGuard');
  const clear = functionSection(mainSource, 'clearAllDisplays');
  const stop = functionSection(mainSource, 'hideDisplayWindows');
  const localRestore = section(
    mainSource,
    "ipcMain.handle('display:show'",
    "ipcMain.handle('display:clear'"
  );

  assertOrdered(restore, [
    'currentLiveCueTransitionOutputs()',
    'setOutputRestoreGuard({',
    'await transaction.guardReadyPromise',
    'showExactLiveCueTransitionOutputs(outputs, sessionId)',
    "outputLifecyclePhase = 'cleared'",
    'liveCueTransitionCoordinator.beginRefresh({',
    'dispatchCueToOutputs(cueIndex, {',
    "publishShowState('outputs-restore-started')",
    'const receipt = await operation.promise',
    '!sameVisibleLiveCueTransitionOutputs(outputs, sessionId)',
    'await setOutputRestoreGuard({',
    'active: false',
    "outputLifecyclePhase = 'live'",
    "publishShowState('outputs-restored')"
  ], 'black-guarded acknowledged Restore');
  assert.match(restore, /receipt\.fromCueIndex === cueIndex/u);
  assert.match(restore, /receipt\.toCueIndex === cueIndex/u);
  assert.match(restore, /appState\.currentSlide !== cueIndex/u);
  assert.match(
    restore,
    /active:\s*false[\s\S]*?transaction\.revealStarted = true[\s\S]*?active:\s*false,[\s\S]*?reveal:\s*true/u,
    'every guard must remain black through release readiness before reveal begins'
  );
  assert.match(
    restore,
    /recoveryGuardId[\s\S]*?setOutputRestoreGuard\([\s\S]*?active:\s*true/u,
    'a partial reveal failure must re-cover every output before claiming black'
  );

  const beforeReceipt = restore.slice(
    0,
    restore.indexOf('const receipt = await operation.promise')
  );
  assert.doesNotMatch(
    beforeReceipt,
    /active:\s*false/u,
    'Restore must never release its black guard before the exact cue receipt'
  );
  assert.match(setGuard, /ipcMain\.on\('output:restoreGuardReady'/u);
  assert.match(setGuard, /event\.sender/u);
  assert.match(setGuard, /payload\?\.guardId !== guardId/u);
  assert.match(setGuard, /payload\?\.outputId !== output\.outputId/u);
  assert.match(clear, /restoring\.clearRequested = true/u);
  assert.match(clear, /restoring\?\.guardReady === true/u);
  assert.match(clear, /showExactLiveCueTransitionOutputs/u);
  assert.match(stop, /activeLiveCueNavigation\.stopRequested = true/u);
  assert.match(localRestore, /await restoreOutputsForRemote\(\)/u);
});

test('display and singer Restore guards paint black before acknowledging main', () => {
  for (const [label, source] of [
    ['display', displaySource],
    ['singer', singerSource]
  ]) {
    const guard = functionSection(source, 'handleOutputRestoreGuard');
    const activate = guard.indexOf('elements.restoreGuard.hidden = false');
    const firstPaint = guard.indexOf('await waitForPaintFrame()', activate);
    const secondPaint = guard.indexOf('await waitForPaintFrame()', firstPaint + 1);
    const successReport = guard.lastIndexOf('window.api.reportOutputRestoreGuardReady({');
    assert.ok(activate >= 0, `${label} must activate the black Restore guard`);
    assert.ok(firstPaint > activate, `${label} must wait after activating the guard`);
    assert.ok(secondPaint > firstPaint, `${label} must wait for a second paint frame`);
    assert.ok(successReport > secondPaint, `${label} must ACK only after both paint frames`);
    assert.match(guard, /active === false/u);
    assert.match(guard, /else if \(reveal\) \{[\s\S]*?restoreGuard\.hidden = true/u);
    assert.match(guard, /restoreGuard/u);
  }
  assert.match(preloadSource, /ipcRenderer\.on\('output:restoreGuard'/u);
  assert.match(preloadSource, /ipcRenderer\.send\('output:restoreGuardReady'/u);
});

test('renderer serializes advance, exposes busy state, and restores volunteer focus', () => {
  const navigate = functionSection(rendererSource, 'navigateSlide');
  assertOrdered(navigate, [
    'if (state.cueNavigationBusy) return',
    'state.cueNavigationBusy = true',
    "elements.btnPrevSlide.setAttribute('aria-busy', 'true')",
    'const result = await',
    '} finally {',
    'state.cueNavigationBusy = false',
    "elements.btnPrevSlide.removeAttribute('aria-busy')",
    'showUsesVolunteerControls()',
    'elements.btnNextSlide.focus({ preventScroll: true })'
  ], 'renderer Next operation');
  assert.match(navigate, /elements\.btnNextSlide\.setAttribute\('aria-busy', 'true'\)/u);
  assert.match(navigate, /elements\.btnNextSlide\.removeAttribute\('aria-busy'\)/u);

  const jump = functionSection(rendererSource, 'goToSlide');
  assertOrdered(jump, [
    'if (state.cueNavigationBusy) return',
    'state.cueNavigationBusy = true',
    'const result = await window.api.navigateToSlide(slideIndex)',
    '} finally {',
    'state.cueNavigationBusy = false'
  ], 'renderer cue jump');

  const showState = functionSection(rendererSource, 'handleShowStateChanged');
  assert.match(showState, /updateShowEndSessionBarrier\(\)/u);

  const endSessionBarrier = functionSection(
    rendererSource,
    'updateShowEndSessionBarrier'
  );
  for (const control of [
    'btnShowDisplays',
    'btnClearDisplays',
    'btnStopDisplays',
    'btnBackToSetup',
    'btnOpenRemote'
  ]) {
    assert.match(
      endSessionBarrier,
      new RegExp(`${control}\\.disabled\\s*=\\s*[\\s\\S]*?state\\.showEndSessionBusy`, 'u')
    );
  }

  const bibleLiveIndicator = functionSection(
    rendererSource,
    'updateBibleLiveIndicator'
  );
  assert.match(
    bibleLiveIndicator,
    /btnPrevSlide\.disabled\s*=\s*[\s\S]*?state\.showEndSessionBusy[\s\S]*?state\.cueNavigationBusy[\s\S]*?controls\.canPrevious/u
  );
  assert.match(
    bibleLiveIndicator,
    /btnNextSlide\.disabled\s*=\s*[\s\S]*?state\.showEndSessionBusy[\s\S]*?state\.cueNavigationBusy[\s\S]*?controls\.canNext/u
  );
});

test('Start focus, held-key suppression, and emergency Escape remain volunteer safe', () => {
  const start = functionSection(rendererSource, 'launchStartAttempt');
  assert.match(start, /window\.setTimeout\(\(\) => \{[\s\S]*?!elements\.btnNextSlide\.disabled[\s\S]*?elements\.btnNextSlide[\s\S]*?: elements\.btnClearDisplays[\s\S]*?focus\(\{ preventScroll: true \}\)/u);

  const keyboard = functionSection(rendererSource, 'handleKeyboard');
  assert.match(
    keyboard,
    /\(event\.key === 'ArrowRight' \|\| event\.key === ' '\)[\s\S]*?state\.cueNavigationBusy[\s\S]*?volunteerLocked && event\.repeat === true/u
  );
  assert.match(keyboard, /case 'Escape':[\s\S]*?clearDisplays\(\)/u);

  const body = { tagName: 'DIV', parentElement: null };
  const unrelatedButton = {
    tagName: 'BUTTON',
    id: 'btnOpenBible',
    parentElement: body,
    getAttribute: () => null
  };
  const input = {
    tagName: 'INPUT',
    parentElement: body,
    getAttribute: () => null
  };
  assert.equal(
    accessibility.shouldHandleGlobalShowShortcut({ key: 'Escape', target: unrelatedButton }),
    true,
    'a focused non-transport button cannot make emergency Clear inert'
  );
  assert.equal(
    accessibility.shouldHandleGlobalShowShortcut({ key: 'Escape', target: input }),
    false,
    'editable controls retain their own Escape semantics'
  );
  assert.equal(
    accessibility.shouldHandleGlobalShowShortcut(
      { key: 'Escape', target: body },
      { dialogOpen: true }
    ),
    false,
    'an open dialog retains its own Escape semantics'
  );
});
