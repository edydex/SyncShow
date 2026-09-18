'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.join(__dirname, '..');
const mainSource = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
const preloadSource = fs.readFileSync(path.join(root, 'preload.js'), 'utf8');
const rendererSource = fs.readFileSync(
  path.join(root, 'src', 'renderer', 'app.js'),
  'utf8'
);

function sourceBetween(source, startMarker, endMarker, label = startMarker) {
  const start = source.indexOf(startMarker);
  assert.notEqual(start, -1, `${label} must exist`);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.notEqual(end, -1, `${label} must have an end boundary`);
  return source.slice(start, end);
}

function ipcHandlerSource(channel) {
  const marker = `ipcMain.handle('${channel}'`;
  const start = mainSource.indexOf(marker);
  assert.notEqual(start, -1, `${channel} handler must exist`);
  const end = mainSource.indexOf(
    "\nipcMain.handle('",
    start + marker.length
  );
  return mainSource.slice(start, end === -1 ? mainSource.length : end);
}

function assertOrdered(source, markers, label) {
  let prior = -1;
  for (const marker of markers) {
    const index = source.indexOf(marker);
    assert.notEqual(index, -1, `${label} must contain ${marker}`);
    assert.ok(
      index > prior,
      `${label} must place ${marker} after the preceding boundary`
    );
    prior = index;
  }
}

test('Start snapshots the committed volunteer policy into one bound Show session', () => {
  const source = ipcHandlerSource('display:start');

  assert.match(
    source,
    /const requestedShowControlMode =\s*activeVenueProfile\?\.operator\?\.showControlMode === 'volunteer'\s*\? 'volunteer'\s*: 'full';/
  );
  assertOrdered(source, [
    'const requestedShowControlMode =',
    'destroyOutputWindows();',
    'activeShowControlMode = requestedShowControlMode;',
    'const startingShowState = showGateway.beginSession();',
    'activeVolunteerShowBinding = createActiveVolunteerShowBinding('
  ], 'display:start');
  assert.match(
    source,
    /createActiveVolunteerShowBinding\(\s*launchPlan,\s*startingShowState\.outputSessionId\s*\)/
  );

  const snapshottedSession = source.slice(
    source.indexOf('activeShowControlMode = requestedShowControlMode;')
  );
  assert.doesNotMatch(
    snapshottedSession,
    /activeVenueProfile\?\.operator\?\.showControlMode/,
    'a running Show must not re-read mutable profile policy'
  );
});

test('every local privileged live IPC path crosses the main authorization gate', () => {
  const gatedHandlers = new Map([
    ['bible:show', /authorizeLocalShowCommand\('bible\.show'\)/],
    ['display:stop', /authorizeLocalShowCommand\('output\.stop'\)/],
    ['display:show', /authorizeLocalShowCommand\('output\.restore'\)/],
    ['display:clear', /authorizeLocalShowCommand\('output\.clear'\)/],
    ['display:endSession', /authorizeLocalShowCommand\('session\.end'\)/],
    ['display:setFade', /authorizeLocalShowCommand\('output\.configure'\)/],
    ['display:setSyncMode', /authorizeLocalShowCommand\('output\.configure'\)/],
    ['singer:setFontSize', /authorizeLocalShowCommand\('output\.configure'\)/],
    ['singer:setTextPadding', /authorizeLocalShowCommand\('output\.configure'\)/],
    ['singer:setCharLimit', /authorizeLocalShowCommand\('output\.configure'\)/],
    ['display:hide', /authorizeLocalShowCommand\('output\.stop'\)/],
    ['show:navigateTo', /authorizeLocalShowCommand\('cue\.jump'\)/],
    [
      'show:navigateBy',
      /authorizeLocalShowCommand\(delta === 1 \? 'cue\.next' : 'cue\.previous'\)/
    ],
    ['remote:enable', /authorizeLocalShowCommand\('remote\.manage'\)/],
    ['remote:rotatePairing', /authorizeLocalShowCommand\('remote\.manage'\)/],
    [
      'remote:closePairing',
      /authorizeLocalShowCommand\('remote\.closePairing'\)/
    ],
    ['remote:revokeAll', /authorizeLocalShowCommand\('remote\.manage'\)/],
    ['remote:disable', /authorizeLocalShowCommand\('remote\.manage'\)/]
  ]);

  for (const [channel, authorization] of gatedHandlers) {
    const source = ipcHandlerSource(channel);
    const senderCheck = source.indexOf('requireControlSender(event)');
    const authorizationCheck = source.search(authorization);
    assert.notEqual(senderCheck, -1, `${channel} must trust-check its sender`);
    assert.notEqual(
      authorizationCheck,
      -1,
      `${channel} must authorize its live mutation`
    );
    assert.ok(
      authorizationCheck > senderCheck,
      `${channel} must authorize only after identifying the control renderer`
    );
  }

  const configureChannels = [
    'display:setFade',
    'display:setSyncMode',
    'singer:setFontSize',
    'singer:setTextPadding',
    'singer:setCharLimit'
  ];
  for (const channel of configureChannels) {
    assert.match(
      ipcHandlerSource(channel),
      /if \(appState\.activeLaunchPlan\) authorizeLocalShowCommand\('output\.configure'\)/,
      `${channel} must lock configuration changes only while a Show is active`
    );
  }
});

test('native volunteer unlock is cancel-safe, exact-session bound, and two minutes', () => {
  const unlock = ipcHandlerSource('show:unlockVolunteerControls');

  assertOrdered(unlock, [
    'const expectedBinding = activeVolunteerShowBinding;',
    'await dialog.showMessageBox(controlWindow, {',
    'if (result.response !== 0)',
    'expectedBinding !== activeVolunteerShowBinding',
    'const grant = createVolunteerShowUnlockGrant({'
  ], 'volunteer unlock');
  assert.match(unlock, /buttons: \['Unlock for 2 minutes', 'Keep volunteer controls'\]/);
  assert.match(unlock, /defaultId: 1,\s*cancelId: 1,\s*noLink: true/);
  assert.match(unlock, /binding: expectedBinding/);
  assert.match(
    unlock,
    /token: crypto\.randomBytes\(32\)\.toString\('base64url'\)/
  );
  assert.match(
    unlock,
    /expiresAt: new Date\(issuedAtMs \+ 2 \* 60 \* 1000\)\.toISOString\(\)/
  );
  assert.match(
    unlock,
    /if \(activeVolunteerShowUnlockGrant !== grant\) return;/
  );
  assert.match(
    unlock,
    /Math\.max\(1, Date\.parse\(grant\.expiresAt\) - Date\.now\(\)\)/
  );

  const destroy = sourceBetween(
    mainSource,
    'function destroyOutputWindows()',
    '\nfunction handleUnexpectedOutputWindowClose',
    'destroyOutputWindows'
  );
  assertOrdered(destroy, [
    'clearVolunteerShowUnlockTimer();',
    'activeVolunteerShowUnlockGrant = null;',
    'activeVolunteerShowBinding = null;',
    "activeShowControlMode = 'full';"
  ], 'destroyOutputWindows');
  assert.match(
    destroy,
    /activeShowRehearsalState = Object\.freeze\(\{\s*status: 'idle',\s*currentCue: 0,\s*totalCues: 0,\s*persisted: false,\s*reused: false\s*\}\)/
  );
});

test('preload exposes only narrow grant-free unlock and lock calls', () => {
  assert.match(
    preloadSource,
    /unlockVolunteerControls: \(\) =>\s*ipcRenderer\.invoke\('show:unlockVolunteerControls'\)/
  );
  assert.match(
    preloadSource,
    /lockVolunteerControls: \(\) =>\s*ipcRenderer\.invoke\('show:lockVolunteerControls'\)/
  );

  const volunteerInvokeChannels = [
    ...preloadSource.matchAll(
      /ipcRenderer\.invoke\('(show:(?:unlock|lock)VolunteerControls)'/g
    )
  ].map(match => match[1]);
  assert.deepEqual(volunteerInvokeChannels, [
    'show:unlockVolunteerControls',
    'show:lockVolunteerControls'
  ]);

  const bridge = sourceBetween(
    preloadSource,
    'unlockVolunteerControls: () =>',
    '\n  // Display operations',
    'volunteer control preload bridge'
  );
  assert.doesNotMatch(
    bridge,
    /\b(?:binding|grant|token|authority|expiresAt)\b/i,
    'the renderer must not supply or receive an authority credential directly'
  );
});

test('renderer obeys authoritative operator controls for lock state, thumbnails, and keys', () => {
  const volunteerRendering = sourceBetween(
    rendererSource,
    'function showUsesVolunteerControls',
    '\nasync function unlockVolunteerControls',
    'volunteer Show rendering'
  );
  assert.match(
    volunteerRendering,
    /showState\?\.operator\?\.mode === 'volunteer'/
  );
  assert.match(
    volunteerRendering,
    /showState\?\.operator\?\.authority !== 'unlocked'/
  );
  assert.match(
    volunteerRendering,
    /showState\?\.operator\?\.controls[\s\S]*?canJump === true/
  );
  assert.doesNotMatch(
    volunteerRendering,
    /state\.profile/,
    'live authority must not be inferred from editable profile state'
  );

  const changed = sourceBetween(
    rendererSource,
    'function handleShowStateChanged',
    '\nfunction operatorErrorMessage',
    'handleShowStateChanged'
  );
  assert.match(changed, /state\.showState = next;/);
  assert.match(changed, /updateShowEndSessionBarrier\(\)/);
  assert.match(changed, /renderVolunteerShowControls\(next\)/);
  assert.doesNotMatch(changed, /state\.profile/);

  const endSessionBarrier = sourceBetween(
    rendererSource,
    'function updateShowEndSessionBarrier',
    '\nfunction showEndSessionBlocksAction',
    'updateShowEndSessionBarrier'
  );
  assert.match(
    endSessionBarrier,
    /state\.showState\?\.operator\?\.controls\s*\|\|\s*state\.showState\?\.controls\s*\|\|\s*\{\}/
  );
  assert.match(
    endSessionBarrier,
    /btnShowDisplays\.disabled\s*=\s*[\s\S]*?state\.showEndSessionBusy[\s\S]*?controls\.canRestore/
  );
  assert.doesNotMatch(endSessionBarrier, /state\.profile/);

  const thumbnails = sourceBetween(
    rendererSource,
    'function renderThumbnails()',
    '\n// Keyboard Handling',
    'renderThumbnails'
  );
  assert.match(
    thumbnails,
    /item\.disabled = \(\s*state\.showState\?\.operator\?\.controls\s*\|\| state\.showState\?\.controls\s*\)\?\.canJump !== true;/
  );
  assert.doesNotMatch(thumbnails, /state\.profile/);

  const keyboard = sourceBetween(
    rendererSource,
    'function handleKeyboard(event)',
    '\n// Utility Functions',
    'handleKeyboard'
  );
  assert.match(
    keyboard,
    /case 'ArrowRight':\s*event\.preventDefault\(\);\s*navigateSlide\(1, 'right'\);[\s\S]*case ' ':\s*event\.preventDefault\(\);\s*navigateSlide\(1, 'space'\);/
  );
  assert.match(
    keyboard,
    /case 'ArrowLeft':[\s\S]*?if \(volunteerLocked\) break;[\s\S]*?navigateSlide\(-1\);/
  );
  assert.match(
    keyboard,
    /case 'Home':[\s\S]*?if \(volunteerLocked\) break;[\s\S]*?goToSlide\(0\);/
  );
  assert.match(
    keyboard,
    /case 'End':[\s\S]*?if \(volunteerLocked\) break;[\s\S]*?goToSlide\(state\.totalSlides - 1\);/
  );
  assert.doesNotMatch(keyboard, /state\.profile/);
});

test('hidden rehearsal acknowledges every cue on every output before reveal', () => {
  const rehearsal = sourceBetween(
    mainSource,
    'async function rehearseHiddenShowCues',
    '\nfunction updateDisplayList',
    'rehearseHiddenShowCues'
  );
  assert.match(
    rehearsal,
    /const outputIds = launchPlan\.outputs\.map\(output => output\.id\);/
  );
  assert.match(
    rehearsal,
    /for \(let cueIndex = 0; cueIndex < launchPlan\.totalSlides; cueIndex \+= 1\)/
  );
  assert.match(
    rehearsal,
    /\[\.\.\.outputWindows\.values\(\)\]\.map\(\(\{ win, output \}\) =>\s*waitForInitialOutputFrame\(win, output, sessionId, cueIndex\)\s*\)/
  );
  assertOrdered(rehearsal, [
    'const framePromises =',
    'const applied = goToSlide(cueIndex, {',
    'await Promise.all(framePromises);',
    'acknowledgements.push({',
    'outputIds: [...outputIds]'
  ], 'hidden cue rehearsal');

  const start = ipcHandlerSource('display:start');
  assertOrdered(start, [
    'rehearsalAcknowledgements = await rehearseHiddenShowCues({',
    'await getShowRehearsalReceiptStore().write(receipt);',
    'outputWindows.forEach(({ win }) => showOutputWindow(win));',
    "publishShowState('show-started')"
  ], 'display:start reveal');
});

test('exact receipt reuse and rehearsal progress are bridged end to end', () => {
  const receiptStore = sourceBetween(
    mainSource,
    'function getShowRehearsalReceiptStore()',
    '\n// Load user settings',
    'Show rehearsal receipt store'
  );
  assert.match(receiptStore, /new ShowRehearsalReceiptStore\(\{/);
  assert.match(
    receiptStore,
    /rootPath: path\.join\(app\.getPath\('userData'\), 'show-readiness'\)/
  );

  const receiptMatch = sourceBetween(
    mainSource,
    'async function matchingSavedRehearsalReceipt',
    '\nfunction setActiveShowRehearsalState',
    'matchingSavedRehearsalReceipt'
  );
  assert.match(receiptMatch, /getShowRehearsalReceiptStore\(\)\.read\(\)/);
  assert.match(
    receiptMatch,
    /receipt && showRehearsalReceiptMatches\(receipt, evidence\)/
  );

  const progress = sourceBetween(
    mainSource,
    'function setActiveShowRehearsalState',
    '\nfunction volunteerShowFingerprint',
    'setActiveShowRehearsalState'
  );
  assert.match(
    progress,
    /controlWindow\.webContents\.send\(\s*'show:rehearsalProgress',\s*activeShowRehearsalState\s*\)/
  );
  assert.match(mainSource, /operator: volunteerShowOperatorState\(\)/);
  assert.match(
    preloadSource,
    /onShowRehearsalProgress: \(callback\) => \{[\s\S]*?ipcRenderer\.on\('show:rehearsalProgress', listener\);[\s\S]*?ipcRenderer\.removeListener\('show:rehearsalProgress', listener\)/
  );
  assert.match(
    rendererSource,
    /window\.api\.onShowRehearsalProgress\(handleShowRehearsalProgress\)/
  );
  assert.match(
    rendererSource,
    /function handleShowRehearsalProgress\(progress = \{\}\)[\s\S]*?progress\.status === 'rehearsing'[\s\S]*?progress\.currentCue[\s\S]*?progress\.totalCues[\s\S]*?progress\.status === 'ready'/
  );
});
