'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const mainSource = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
const rendererSource = fs.readFileSync(
  path.join(root, 'src', 'renderer', 'app.js'),
  'utf8'
);

function between(source, startText, endText) {
  const start = source.indexOf(startText);
  assert.notEqual(start, -1, `expected ${startText}`);
  const end = source.indexOf(endText, start + startText.length);
  assert.notEqual(end, -1, `expected ${endText} after ${startText}`);
  return source.slice(start, end);
}

test('startup verifies and installs the exact current package before opening Load', () => {
  const restore = between(
    mainSource,
    'async function restoreCurrentPreparedService()',
    'async function activateCurrentPreparedService('
  );
  assert.match(
    restore,
    /currentShowPackageStore\.read\(\)[\s\S]*showPackagePublisher\.open\(pointer\.packageId\)[\s\S]*currentPreparedServiceBinding\(pointer, opened\)[\s\S]*installPreparedPresentations/
  );
  assert.match(restore, /'incompatible'/);
  assert.match(restore, /'corrupt'/);
  assert.doesNotMatch(
    restore,
    /packagePath|cacheDir|manifest\.artifacts|accessToken|sourcePath/
  );

  const startup = between(
    mainSource,
    'app.whenReady().then(async () => {',
    "app.on('window-all-closed'"
  );
  assert.ok(
    startup.indexOf('loadAndApplyUserSettings()')
      < startup.indexOf('await restoreCurrentPreparedService()')
  );
  assert.ok(
    startup.indexOf('await restoreCurrentPreparedService()')
      < startup.indexOf('createControlWindow()')
  );
});

test('publish activates only after all existing stale guards and before one atomic install', () => {
  const publish = between(
    mainSource,
    "ipcMain.handle('prepare:projects:publish'",
    "ipcMain.handle('dialog:openPptx'"
  );
  const firstStaleGuard = publish.indexOf(
    'publishGeneration !== preparePublishGeneration'
  );
  const activation = publish.indexOf('activateCurrentPreparedService(');
  const secondStaleGuard = publish.indexOf(
    'publishGeneration !== preparePublishGeneration',
    firstStaleGuard + 1
  );
  const install = publish.indexOf('installPreparedPresentations(');
  assert.ok(firstStaleGuard >= 0 && activation > firstStaleGuard);
  assert.ok(secondStaleGuard > activation && install > secondStaleGuard);
  assert.match(
    publish,
    /rollbackCurrentPreparedServiceActivation\([\s\S]*activationReceipt/
  );
  assert.match(publish, /PREPARE_PUBLISH_ROLLBACK_FAILED/);
  assert.doesNotMatch(
    publish,
    /for \(const \[roleId, presentation\][\s\S]*installPresentation/
  );
});

test('explicit PowerPoint conversion and cache restore clear the durable native pointer first', () => {
  const conversion = between(
    mainSource,
    'async function runConversion(',
    "ipcMain.handle('pptx:convert'"
  );
  assert.ok(
    conversion.indexOf('await deactivateCurrentPreparedService(')
      < conversion.indexOf('installPresentation(language, result)')
  );
  assert.match(
    conversion,
    /deactivateCurrentPreparedService\(\{ clearPresentations: true \}\)/
  );

  const cacheRestore = between(
    mainSource,
    "ipcMain.handle('cache:load'",
    "ipcMain.handle('displays:refresh'"
  );
  assert.ok(
    cacheRestore.indexOf('await deactivateCurrentPreparedService(')
      < cacheRestore.indexOf('installPresentation(language, result)')
  );
  assert.match(
    cacheRestore,
    /deactivateCurrentPreparedService\(\{ clearPresentations: true \}\)/
  );
});

test('renderer keeps restored native service primary and confirms a date mismatch once', () => {
  const load = between(
    rendererSource,
    'async function loadAppState()',
    'function renderPreparedServiceRestoreStatus()'
  );
  assert.match(load, /preparedServiceRestore/);
  assert.ok(
    load.indexOf('await checkForCachedPresentations()')
      < load.indexOf('renderPreparedServiceRestoreStatus()')
  );

  const cached = between(
    rendererSource,
    'async function checkForCachedPresentations()',
    'async function restoreCachedPresentations()'
  );
  assert.match(
    cached,
    /presentation\.source === 'prepared'[\s\S]*available\.length > 0 && !preparedServiceLoaded/
  );

  const dateConfirmation = between(
    rendererSource,
    'function confirmPreparedServiceDate()',
    'async function startPresentation()'
  );
  assert.match(dateConfirmation, /preparedServiceDateConfirmations/);
  assert.match(
    dateConfirmation,
    /SyncShowPreparedServiceGuard\.preparedServiceDateGuard/
  );
  assert.match(dateConfirmation, /Start this exact prepared service anyway\?/);

  const start = between(
    rendererSource,
    'async function startPresentation()',
    'function getAttemptOutput('
  );
  assert.match(start, /if \(!confirmPreparedServiceDate\(\)\) return/);
});

test('renderer receives only bounded restore status metadata and recovery copy', () => {
  const getState = between(
    mainSource,
    "ipcMain.handle('app:getState'",
    '// User settings handlers'
  );
  assert.match(getState, /preparedServiceRestore: currentPreparedServiceRestore/);
  const projection = between(
    mainSource,
    'function setCurrentPreparedServiceRestore(',
    'function normalizedPresentationHandoff('
  );
  assert.match(projection, /status/);
  assert.match(projection, /projectId/);
  assert.match(projection, /serviceDate/);
  assert.match(projection, /activatedAt/);
  assert.doesNotMatch(
    projection,
    /packagePath|cacheDir|manifest|roleMapping|sourcePath/
  );

  const render = between(
    rendererSource,
    'function renderPreparedServiceRestoreStatus()',
    'function applyRuntimePresentationState('
  );
  assert.match(render, /different venue setup/);
  assert.match(render, /could not be verified/);
  assert.match(render, /Save & go to Load again/);
});

test('prepared activation binds exact manifest and mapping-affecting venue revisions', () => {
  const binding = between(
    mainSource,
    'function currentPreparedServiceBinding(',
    'async function restoreCurrentPreparedService()'
  );
  assert.match(binding, /manifestSha256: opened\.manifestSha256/);
  assert.match(
    binding,
    /venueProfileRevisionId: preparedServiceVenueRevisionId\(activeVenueProfile\)/
  );

  const activation = between(
    mainSource,
    'async function activateCurrentPreparedService(',
    'async function rollbackCurrentPreparedServiceActivation('
  );
  assert.match(activation, /activateWithReceipt\(/);
  assert.match(activation, /packageManifestSha256: published\.manifestSha256/);
  assert.match(
    activation,
    /venueProfileRevisionId: preparedServiceVenueRevisionId\(activeVenueProfile\)/
  );

  const install = between(
    mainSource,
    'function installPreparedPresentations(',
    'function clearInstalledPreparedPresentations('
  );
  assert.match(install, /const nextPresentations = \{\}/);
  assert.doesNotMatch(install, /\.\.\.appState\.presentations/);
});

test('profile saves invalidate loaded native packages and Start re-verifies before outputs', () => {
  const settingsSave = between(
    mainSource,
    "ipcMain.handle('settings:save'",
    "ipcMain.handle('settings:defaultProfile'"
  );
  assert.match(
    settingsSave,
    /preparedServiceVenueRevisionId\(\s*activeVenueProfile\s*\)/
  );
  assert.match(settingsSave, /clearInstalledPreparedPresentations\(\)/);
  assert.match(settingsSave, /preparedServiceInvalidated/);

  const start = between(
    mainSource,
    "ipcMain.handle('display:start'",
    "ipcMain.handle('display:stop'"
  );
  assert.ok(
    start.indexOf('await verifyCurrentPreparedServiceForStart()')
      < start.indexOf('resolveLaunchPlan(')
  );
});
