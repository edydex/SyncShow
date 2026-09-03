'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const mainSource = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
const preloadSource = fs.readFileSync(path.join(root, 'preload.js'), 'utf8');
const rendererSource = fs.readFileSync(path.join(root, 'src', 'renderer', 'app.js'), 'utf8');

test('main owns a revisioned sanitized Show gateway and publishes every lifecycle boundary', () => {
  assert.match(mainSource, /new RemoteCommandAdapter\(\{/);
  assert.match(mainSource, /showGateway\.beginSession\(\)/);
  assert.match(mainSource, /showGateway\?\.endSession\('session-ended'\)/);
  assert.match(mainSource, /publishShowState\('show-started'\)/);
  assert.match(mainSource, /publishShowState\('cue-changed'\)/);
  assert.match(mainSource, /publishShowState\('outputs-cleared'\)/);
  assert.match(mainSource, /publishShowState\('outputs-restored'\)/);
  assert.match(mainSource, /publishShowState\('outputs-stopped'\)/);
  assert.match(mainSource, /publishShowState\('bible-preparing'\)/);
  assert.match(mainSource, /publishShowState\('bible-state-changed'\)/);
  assert.match(mainSource, /publishShowState\('output-interrupted'\)/);
  assert.match(mainSource, /webContents\.send\('show:stateChanged', \{ reason, state \}\)/);
});

test('navigation reconciles Clear state with the slide content outputs reveal', () => {
  const goToStart = mainSource.indexOf('function goToSlide(');
  const goToEnd = mainSource.indexOf('\nfunction getSlideImagePath', goToStart);
  const goToSource = mainSource.slice(goToStart, goToEnd);
  assert.match(goToSource, /appState\.isCleared = false;/);
  assert.match(goToSource, /outputLifecyclePhase = 'live'/);
  assert.match(goToSource, /publishShowState\('cue-changed'\)/);
});

test('Back to Load ends rather than hides the output session', () => {
  assert.match(mainSource, /ipcMain\.handle\('display:endSession'/);
  assert.match(preloadSource, /endPresentation: \(\) => ipcRenderer\.invoke\('display:endSession'\)/);
  const backStart = rendererSource.indexOf('async function backToSetup(');
  assert.notEqual(backStart, -1, 'Back-to-setup handler must exist');
  const backEnd = rendererSource.indexOf('\n// Slide Navigation', backStart);
  const backSource = rendererSource.slice(backStart, backEnd);
  const guardIndex = backSource.indexOf('if (state.showEndSessionBusy) return;');
  const beginIndex = backSource.indexOf('beginShowOutputAction()');
  const endIndex = backSource.indexOf('window.api.endPresentation()');
  assert.ok(guardIndex >= 0 && guardIndex < beginIndex && beginIndex < endIndex);
  assert.match(backSource, /state\.showEndSessionBusy = true/);
  assert.match(backSource, /updateShowEndSessionBarrier\(\)/);
  assert.match(backSource, /finally \{[\s\S]*state\.showEndSessionBusy = false/);
  assert.match(backSource, /window\.api\.endPresentation\(\)/);
});

test('the final cue exposes an explicit Finish service action on the safe end-session path', () => {
  assert.match(
    rendererSource,
    /elements\.btnBackToSetup\.addEventListener\('click', \(\) => backToSetup\('load'\)\)/
  );
  const finishStart = rendererSource.indexOf('function renderShowFinishAction()');
  const finishEnd = rendererSource.indexOf('\nasync function refreshPublishedProject', finishStart);
  assert.ok(finishStart >= 0 && finishEnd > finishStart);
  const finishSource = rendererSource.slice(finishStart, finishEnd);
  assert.match(
    finishSource,
    /state\.totalSlides > 0[\s\S]*state\.currentSlide >= state\.totalSlides - 1/
  );
  assert.match(finishSource, /'Finish service…'/);
  assert.match(finishSource, /'Back to Load'/);
  assert.match(finishSource, /End outputs safely, return to Load/);
  assert.match(
    rendererSource,
    /function renderShowCueContext\(\)[\s\S]*renderShowFinishAction\(\)/
  );
});

test('Finish service blocks every competing local Show command until its receipt is consumed', () => {
  for (const functionName of [
    'showDisplays',
    'clearDisplays',
    'stopDisplays',
    'sendBibleLive',
    'returnFromBible',
    'navigateSlide',
    'goToSlide'
  ]) {
    const start = rendererSource.indexOf(`async function ${functionName}(`);
    assert.notEqual(start, -1, `${functionName} must exist`);
    const next = rendererSource.indexOf('\nasync function ', start + 1);
    const body = rendererSource.slice(
      start,
      next === -1 ? rendererSource.length : next
    );
    assert.match(
      body,
      /showEndSessionBlocksAction\(\)|state\.showEndSessionBusy/,
      `${functionName} must refuse work while Finish service is pending`
    );
  }
  const barrierStart = rendererSource.indexOf('function updateShowEndSessionBarrier()');
  const barrierEnd = rendererSource.indexOf(
    '\nfunction showEndSessionBlocksAction()',
    barrierStart
  );
  assert.ok(barrierStart >= 0 && barrierEnd > barrierStart);
  const barrierSource = rendererSource.slice(barrierStart, barrierEnd);
  for (const control of [
    'btnShowDisplays',
    'btnClearDisplays',
    'btnStopDisplays',
    'btnBackToSetup',
    'btnOpenRemote'
  ]) {
    assert.match(barrierSource, new RegExp(`elements\\.${control}\\.disabled`));
  }
  assert.match(barrierSource, /updateBibleActions\(\)/);
});

test('control renderer consumes the same authoritative Show-state stream', () => {
  assert.match(mainSource, /ipcMain\.handle\('show:getState'/);
  assert.match(preloadSource, /getShowState: \(\) => ipcRenderer\.invoke\('show:getState'\)/);
  assert.match(preloadSource, /ipcRenderer\.on\('show:stateChanged', listener\)/);
  assert.match(rendererSource, /window\.api\.onShowStateChanged\(handleShowStateChanged\)/);
  assert.match(rendererSource, /function handleShowStateChanged\(payload = \{\}\)/);
  assert.match(rendererSource, /next\.revision < state\.showState\.revision/);
});

test('output health requires current sender-scoped frame success and publishes off the frame path', () => {
  assert.match(mainSource, /new OutputHealthTracker\(\{/);
  assert.match(mainSource, /ipcMain\.on\('output:frameReady', handleOutputFrameHealth\)/);
  assert.match(mainSource, /sender: event\.sender/);
  assert.match(mainSource, /sessionId: outputSessionId/);
  assert.match(mainSource, /outputHealthTracker\.expectFrame\(\{/);
  assert.match(mainSource, /win\.on\('unresponsive'/);
  assert.match(mainSource, /win\.on\('responsive'/);
  assert.match(mainSource, /sender\.on\('render-process-gone'/);
  assert.match(mainSource, /queueMicrotask\(\(\) => \{/);
  assert.match(mainSource, /health\?\.status === 'unavailable'/);
  assert.match(mainSource, /health\?\.status !== 'healthy'/);
});

test('LAN Remote is local-opt-in, opaque-bound, and revoked with the Show lifecycle', () => {
  assert.match(mainSource, /new RemoteControlServer\(\{/);
  assert.match(mainSource, /new NetworkBindingCatalog\(\)/);
  assert.match(mainSource, /\.filter\(binding => binding\.kind === 'lan'\)/);
  assert.match(mainSource, /candidate\.id === bindingId && candidate\.kind === 'lan'/);
  assert.match(mainSource, /await remoteServer\.startLoopback\(\)/);
  assert.match(mainSource, /await remoteServer\.bindLan\(binding\.id\)/);
  assert.match(mainSource, /QRCode\.toDataURL\(grant\.pairingUrl/);
  assert.match(mainSource, /stopRemoteForShow\('show-ended'\)/);
  assert.match(mainSource, /stopRemoteForShow\('outputs-stopped'\)/);
  assert.match(mainSource, /remoteServer\?\.revokeAll\(reason\)/);
  assert.match(mainSource, /powerMonitor\.on\('suspend'/);
  assert.match(mainSource, /remoteServer\?\.revokeAll\('app-quit'\)/);

  for (const channel of [
    'remote:listBindings',
    'remote:getState',
    'remote:enable',
    'remote:rotatePairing',
    'remote:closePairing',
    'remote:revokeAll',
    'remote:disable'
  ]) {
    const start = mainSource.indexOf(`ipcMain.handle('${channel}'`);
    assert.notEqual(start, -1, `${channel} must exist`);
    assert.match(mainSource.slice(start, start + 260), /requireControlSender\(event\)/,
      `${channel} must be restricted to the control window`);
  }
});

test('desktop Remote controls use the narrow preload bridge and close unused pair codes', () => {
  assert.match(preloadSource, /listRemoteBindings: \(\) => ipcRenderer\.invoke\('remote:listBindings'\)/);
  assert.match(preloadSource, /enableRemote: \(bindingId\) => ipcRenderer\.invoke\('remote:enable', \{ bindingId \}\)/);
  assert.match(preloadSource, /closeRemotePairing: \(\) => ipcRenderer\.invoke\('remote:closePairing'\)/);
  assert.match(preloadSource, /revokeRemoteDevices: \(\) => ipcRenderer\.invoke\('remote:revokeAll'\)/);
  assert.match(preloadSource, /disableRemote: \(\) => ipcRenderer\.invoke\('remote:disable'\)/);
  assert.match(preloadSource, /ipcRenderer\.on\('remote:stateChanged', listener\)/);

  assert.match(rendererSource, /window\.api\.onRemoteStateChanged\(handleRemoteStateChanged\)/);
  assert.match(rendererSource, /function openRemoteDialog\(event\)/);
  assert.match(rendererSource, /window\.api\.enableRemote\(bindingId\)/);
  assert.match(rendererSource, /window\.api\.closeRemotePairing\(\)/);
  assert.match(rendererSource, /window\.api\.revokeRemoteDevices\(\)/);
  assert.match(rendererSource, /window\.api\.disableRemote\(\)/);
  assert.match(rendererSource, /data:image\/png;base64,/);
});

test('Remote pairing and management snapshots reject stale asynchronous work', () => {
  assert.match(mainSource, /let remotePairingGeneration = 0;/);
  assert.match(mainSource, /pairingGeneration !== remotePairingGeneration/);
  assert.match(mainSource, /managementRevision: remoteManagementRevision/);
  assert.match(rendererSource, /incomingRevision < currentRevision/);
  const openStart = rendererSource.indexOf('async function openRemoteDialog(event)');
  const openEnd = rendererSource.indexOf('\nfunction closeRemoteDialog()', openStart);
  assert.doesNotMatch(rendererSource.slice(openStart, openEnd), /rotateRemotePairing\(/,
    'opening status must not silently create a new pairing grant');
});
