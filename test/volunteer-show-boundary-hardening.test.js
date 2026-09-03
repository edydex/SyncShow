'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const mainSource = fs.readFileSync(path.join(root, 'main.js'), 'utf8');

function sourceBetween(startMarker, endMarker, label = startMarker) {
  const start = mainSource.indexOf(startMarker);
  assert.notEqual(start, -1, `${label} must exist`);
  const end = mainSource.indexOf(endMarker, start + startMarker.length);
  assert.notEqual(end, -1, `${label} must have an end boundary`);
  return mainSource.slice(start, end);
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
    assert.ok(index > prior, `${label} must order ${marker} after its predecessor`);
    prior = index;
  }
}

function stableJsonValue(value) {
  if (Array.isArray(value)) return value.map(stableJsonValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.keys(value).sort().map(key => [key, stableJsonValue(value[key])])
  );
}

function sha256Json(value) {
  return crypto
    .createHash('sha256')
    .update(JSON.stringify(stableJsonValue(value)))
    .digest('hex');
}

test('presentation replacement is locked at the mutation boundary and Start rejects stale Load', () => {
  const mutationFunctions = sourceBetween(
    'function requireNoActiveShowForPresentationMutation()',
    '\nfunction setCurrentPreparedServiceRestore',
    'presentation mutation functions'
  );
  assert.match(
    mutationFunctions,
    /if \(!appState\.activeLaunchPlan\) return;[\s\S]*?'SHOW_CONTENT_LOCKED'/
  );
  assert.match(
    mutationFunctions,
    /function installPresentation[\s\S]*?requireNoActiveShowForPresentationMutation\(\)/
  );
  assert.match(
    mutationFunctions,
    /function installPreparedPresentations[\s\S]*?requireNoActiveShowForPresentationMutation\(\)/
  );
  assert.match(
    mutationFunctions,
    /function clearInstalledPreparedPresentations[\s\S]*?requireNoActiveShowForPresentationMutation\(\)/
  );

  const conversion = sourceBetween(
    'async function runConversion',
    '\n// Queued conversion handler',
    'PowerPoint conversion'
  );
  assertOrdered(conversion, [
    'requireNoActiveShowForPresentationMutation();',
    'await converter.convert(',
    'const releasePresentationMutation = beginPresentationMutation();',
    'await deactivateCurrentPreparedService({ clearPresentations: true });',
    'installPresentation(language, result);'
  ], 'PowerPoint conversion');

  const cacheLoad = ipcHandlerSource('cache:load');
  assertOrdered(cacheLoad, [
    'const releasePresentationMutation = beginPresentationMutation();',
    'await deactivateCurrentPreparedService({ clearPresentations: true });',
    'installPresentation(language, result);'
  ], 'cache restore');

  const settingsSave = ipcHandlerSource('settings:save');
  assertOrdered(settingsSave, [
    'requireControlSender(event);',
    'requireNoActiveShowForPresentationMutation();',
    'saveUserSettings(settings)'
  ], 'settings save');

  const start = ipcHandlerSource('display:start');
  const authorizations = [...start.matchAll(
    /authorizeLocalShowCommand\('session\.end'\)/g
  )].map(match => match.index);
  assert.ok(authorizations.length >= 2, 'Start must authorize before and after async preflight');
  assert.ok(
    authorizations.at(-1) < start.indexOf('destroyOutputWindows();'),
    'the last exact-session authorization must immediately precede replacement'
  );
  assertOrdered(start, [
    'const presentationRevisionForStart = presentationRevision;',
    'const launchPlan = resolveLaunchPlan({',
    'presentationRevision !== presentationRevisionForStart',
    'destroyOutputWindows();'
  ], 'display:start presentation snapshot');
  assert.match(start, /presentationMutationInProgress/);
});

test('PowerPoint evidence binds exact role context, JPG bytes, and all Singer metadata', async () => {
  const evidence = sourceBetween(
    'async function serviceSetRehearsalEvidence',
    '\nasync function showRehearsalEvidenceForStart',
    'ServiceSet rehearsal evidence'
  );
  assert.match(
    evidence,
    /normalizeCacheRestoreContext\([\s\S]*?\{ allowNull: false \}/
  );
  assert.match(evidence, /context\.roleId !== roleId/);
  assert.match(evidence, /renderedPowerPointGenerationRevision\(/);
  assert.match(evidence, /rehearsalServiceSetFingerprint\(manifest\)/);
  assert.doesNotMatch(evidence, /serviceSetFingerprint\(manifest\)/);

  const renderedSource = sourceBetween(
    'async function renderedPowerPointGenerationRevision',
    '\nasync function serviceSetRehearsalEvidence',
    'rendered PowerPoint revision'
  );
  assert.match(renderedSource, /hashFileNoFollow\(/);
  assert.match(
    renderedSource,
    /slideMetadataRevisionId: sha256Json\(\s*presentation\.metadata\?\.slides \|\| \[\]\s*\)/
  );

  let renderedBytesRevision = '1'.repeat(64);
  const context = {
    CONFIG: { cacheDir: '/cache' },
    SHOW_REHEARSAL_RENDERED_SLIDE_MAX_BYTES: 1024,
    console: { warn() {} },
    hashFileNoFollow: async () => renderedBytesRevision,
    path,
    sha256Json
  };
  vm.runInNewContext(
    `${renderedSource}\nthis.renderedPowerPointGenerationRevision = renderedPowerPointGenerationRevision;`,
    context
  );
  const presentation = {
    cacheDir: path.join('/cache', 'english'),
    slideCount: 1,
    metadata: {
      pdfRenderer: { id: 'fixture' },
      slides: [{
        text: 'The text stays populated',
        firstLine: 'Original singer line',
        title: 'Cue'
      }]
    }
  };
  const original = await context.renderedPowerPointGenerationRevision(
    'english',
    presentation,
    'a'.repeat(64)
  );
  presentation.metadata.slides[0].firstLine = 'Changed singer line';
  const metadataChanged = await context.renderedPowerPointGenerationRevision(
    'english',
    presentation,
    'a'.repeat(64)
  );
  assert.notEqual(
    metadataChanged,
    original,
    'firstLine must invalidate evidence even while text remains populated'
  );
  renderedBytesRevision = '2'.repeat(64);
  const jpgChanged = await context.renderedPowerPointGenerationRevision(
    'english',
    presentation,
    'a'.repeat(64)
  );
  assert.notEqual(jpgChanged, metadataChanged, 'projected JPG bytes must invalidate evidence');
});

test('rehearsal ServiceSet fingerprint accepts exact valid undated PPT manifests', () => {
  const fingerprintSource = sourceBetween(
    'function rehearsalServiceSetFingerprint',
    '\nfunction rehearsalDecision',
    'rehearsal ServiceSet fingerprint'
  );
  const context = { sha256Json };
  vm.runInNewContext(
    `${fingerprintSource}\nthis.rehearsalServiceSetFingerprint = rehearsalServiceSetFingerprint;`,
    context
  );
  const manifest = {
    schemaVersion: 1,
    id: 'undated-main',
    serviceDate: null,
    inputs: {
      english: {
        roleId: 'english',
        pinnedPath: '/snapshot/assets/english.ppt',
        sha256: 'a'.repeat(64),
        assetId: `sha256:${'a'.repeat(64)}`
      }
    }
  };
  const fingerprint = context.rehearsalServiceSetFingerprint(manifest);
  assert.match(fingerprint, /^[a-f0-9]{64}$/);
  manifest.inputs.english.pinnedPath = '/snapshot/assets/english.pptx';
  assert.notEqual(
    context.rehearsalServiceSetFingerprint(manifest),
    fingerprint,
    'the exact valid manifest, including its input format, must be bound'
  );
});

test('effective render settings are normalized before lookup and rechecked before reveal', () => {
  const start = ipcHandlerSource('display:start');
  assertOrdered(start, [
    'const renderingSettings = normalizeStartRenderingSettings(settings);',
    'showRehearsalEvidenceForStart({',
    'matchingSavedRehearsalReceipt(rehearsalEvidence)',
    'appState.fadeDuration = renderingSettings.fadeDuration;',
    'requireCurrentOutputStartup(',
    'outputWindows.forEach(({ win }) => showOutputWindow(win));'
  ], 'render settings and receipt lookup');

  const venueEvidence = sourceBetween(
    'function rehearsalVenueRevisionId',
    '\nfunction rehearsalServiceSetFingerprint',
    'venue rehearsal evidence'
  );
  assert.match(venueEvidence, /renderingSettings/);

  const startupGuard = sourceBetween(
    'function requireCurrentOutputStartup',
    '\nasync function rehearseHiddenShowCues',
    'startup transaction guard'
  );
  for (const contract of [
    'sessionId === outputSessionId',
    'appState.activeLaunchPlan === launchPlan',
    "outputLifecyclePhase === 'starting'",
    'sameStartRenderingSettings(renderingSettings)',
    'outputWindows.size === launchPlan.outputs.length'
  ]) {
    assert.ok(startupGuard.includes(contract), `startup guard must bind ${contract}`);
  }
});

test('every post-await startup boundary is checked before progress, receipt, or reveal', () => {
  const rehearsal = sourceBetween(
    'async function rehearseHiddenShowCues',
    '\nfunction updateDisplayList',
    'hidden rehearsal'
  );
  assertOrdered(rehearsal, [
    'await Promise.all(framePromises);',
    'requireCurrentOutputStartup(',
    'acknowledgements.push({',
    'setActiveShowRehearsalState({'
  ], 'hidden rehearsal acknowledgement');

  const start = ipcHandlerSource('display:start');
  const postWrite = start.slice(
    start.indexOf('await getShowRehearsalReceiptStore().write(receipt);')
  );
  assertOrdered(postWrite, [
    'await getShowRehearsalReceiptStore().write(receipt);',
    'requireCurrentOutputStartup(',
    'persisted = true;',
    'setActiveShowRehearsalState({',
    'outputWindows.forEach(({ win }) => showOutputWindow(win));'
  ], 'durable receipt reveal barrier');
});

test('native prepared packages are reopened and verified after the frame barrier', () => {
  const start = ipcHandlerSource('display:start');
  const postFrame = start.slice(
    start.indexOf('await Promise.all(initialFramePromises);')
  );
  assertOrdered(postFrame, [
    'await Promise.all(initialFramePromises);',
    'confirmedPreparedService =',
    'await verifyCurrentPreparedServiceForStart();',
    'samePreparedServiceVerification(',
    'confirmedRehearsalEvidence = await showRehearsalEvidenceForStart({',
    'sameShowRehearsalEvidence(',
    'outputWindows.forEach(({ win }) => showOutputWindow(win));'
  ], 'prepared package final verification');
});

test('queued Remote mutations reauthorize the captured output session at execution time', () => {
  const enableHandler = ipcHandlerSource('remote:enable');
  assertOrdered(enableHandler, [
    "authorizeLocalShowCommand('remote.manage');",
    'const expectedOutputSessionId = showGateway.getState().outputSessionId;',
    'enableRemoteControl(request.bindingId, expectedOutputSessionId)'
  ], 'Remote enable handler');

  const enable = sourceBetween(
    'async function enableRemoteControl',
    '\nfunction disableRemoteControl',
    'Remote enable operation'
  );
  assertOrdered(enable, [
    'return queueRemoteOperation(async () => {',
    'requireRemoteManagementSession(',
    'await remoteServer.startLoopback();',
    'await remoteServer.bindLan(binding.id);',
    'createRemotePairing({'
  ], 'queued Remote enable');
  assert.ok(
    [...enable.matchAll(/requireRemoteManagementSession\(/g)].length >= 3,
    'queued Remote enable must reauthorize before and after its awaits'
  );
  assert.match(enable, /requireLocalAuthority: true/);

  const rotate = ipcHandlerSource('remote:rotatePairing');
  assertOrdered(rotate, [
    "authorizeLocalShowCommand('remote.manage');",
    'const expectedOutputSessionId = showGateway.getState().outputSessionId;',
    'const expectedGeneration = remotePairingGeneration;',
    'return queueRemoteOperation(() => createRemotePairing({'
  ], 'queued pairing rotation');
  assert.match(rotate, /requireLocalAuthority: true/);
});

test('relocking cancels an open invitation and cleanup remains available while locked', () => {
  const relock = sourceBetween(
    'function relockVolunteerShowControls',
    '\nfunction currentVolunteerShowUnlockGrant',
    'volunteer relock'
  );
  assertOrdered(relock, [
    'activeVolunteerShowUnlockGrant = null;',
    'if (changed) closeRemotePairing();'
  ], 'volunteer relock');

  const unlock = ipcHandlerSource('show:unlockVolunteerControls');
  assert.match(unlock, /const changed = relockVolunteerShowControls\(\);/);
  const lock = ipcHandlerSource('show:lockVolunteerControls');
  assert.match(lock, /const changed = relockVolunteerShowControls\(\);/);

  const closePairing = ipcHandlerSource('remote:closePairing');
  assert.match(
    closePairing,
    /authorizeLocalShowCommand\('remote\.closePairing'\)/
  );
});
