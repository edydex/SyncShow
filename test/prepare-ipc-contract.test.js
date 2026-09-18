'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const mainSource = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
const preloadSource = fs.readFileSync(path.join(root, 'preload.js'), 'utf8');
const afterPackSource = fs.readFileSync(path.join(root, 'scripts', 'afterPack.js'), 'utf8');
const fontConfigSource = fs.readFileSync(path.join(root, 'assets', 'fonts', 'fonts.conf'), 'utf8');
const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

const channels = [
  'prepare:projects:list',
  'prepare:projects:create',
  'prepare:projects:planNext',
  'prepare:projects:setPlanning',
  'prepare:projects:updatePlanning',
  'prepare:projects:updateServing',
  'prepare:projects:open',
  'prepare:songs:list',
  'prepare:songs:import',
  'prepare:projects:addSong',
  'prepare:projects:replaceSong',
  'prepare:projects:addText',
  'prepare:projects:addPicture',
  'prepare:projects:proposeSermonCueReconciliation',
  'prepare:projects:applySermonCueReconciliation',
  'prepare:projects:updatePictureOutput',
  'prepare:projects:removeItem',
  'prepare:projects:moveItem',
  'prepare:projects:publish'
];

test('every Prepare mutation stays on the exact trusted control main frame', () => {
  assert.match(mainSource, /event\.senderFrame !== event\.sender\.mainFrame/);
  assert.match(mainSource, /event\.senderFrame\?\.url !== controlRendererUrl/);
  assert.match(mainSource, /setWindowOpenHandler\(\(\) => \(\{ action: 'deny' \}\)\)/);
  assert.match(mainSource, /webContents\.on\('will-navigate'/);

  for (const channel of channels) {
    const start = mainSource.indexOf(`ipcMain.handle('${channel}'`);
    assert.notEqual(start, -1, `${channel} must be implemented`);
    assert.match(mainSource.slice(start, start + 260), /requireControlSender\(event\)/,
      `${channel} must reject non-control senders`);
  }
});

test('Prepare preload APIs expose semantic records, never renderer-supplied file paths', () => {
  for (const api of [
    'listServiceProjects',
    'createServiceProject',
    'planNextServiceProject',
    'setServicePlanningStatus',
    'updateServicePlanning',
    'updateServiceServing',
    'openServiceProject',
    'listSongLibrary',
    'importSongDocument',
    'addSongToService',
    'replaceSongInService',
    'addTextToService',
    'addPictureToService',
    'proposeSermonCueReconciliationForServiceItem',
    'applySermonCueReconciliationForServiceItem',
    'updatePictureOutput',
    'removeServiceItem',
    'moveServiceItem',
    'publishServiceProject'
  ]) {
    assert.match(preloadSource, new RegExp(`${api}:`), `${api} must be available through the narrow bridge`);
  }
  const prepareBridgeStart = preloadSource.indexOf('// Prepare workspace');
  const prepareBridgeEnd = preloadSource.indexOf('// App state', prepareBridgeStart);
  const prepareBridge = preloadSource.slice(prepareBridgeStart, prepareBridgeEnd);
  assert.doesNotMatch(prepareBridge, /sourcePath|filePath|cacheDir|packagePath/);
  assert.match(
    prepareBridge,
    /applySermonCueReconciliationForServiceItem:[\s\S]*?placementIndex:/
  );
  assert.match(
    preloadSource,
    /function sermonCueDecisionsIntent[\s\S]*?targetItemId:\s*decision\?\.targetItemId \?\? null/
  );
  assert.match(mainSource, /importSongFilesSequentially\(\s*result\.filePaths/);
  assert.match(mainSource, /library\.importFile\(sourcePath/);
  assert.match(mainSource, /serviceProjectStore\.importImageAndUpdateProject\(current\.projectId/);
});

test('publishing pins a native package and returns only opaque project/package identity', () => {
  const start = mainSource.indexOf("ipcMain.handle('prepare:projects:publish'");
  const end = mainSource.indexOf("ipcMain.handle('dialog:openPptx'", start);
  const source = mainSource.slice(start, end);
  assert.match(source, /showPackagePublisher\.publish\(/);
  assert.match(
    source,
    /installPreparedPresentations\(published\.presentations, binding\.roleIds\)/
  );
  assert.match(source, /activateCurrentPreparedService\(/);
  assert.match(source, /showPackage: \{/);
  const returnStart = source.lastIndexOf('return {');
  assert.doesNotMatch(source.slice(returnStart), /cacheDir|packagePath|fontPath|assetPath/);
  assert.match(mainSource, /path\.join\(userDataPath, 'service-projects'\)/);
  assert.match(mainSource, /path\.join\(userDataPath, 'song-library'\)/);
  assert.match(mainSource, /path\.join\(userDataPath, 'show-packages'\)/);
  assert.match(mainSource, /path\.join\(userDataPath, 'prepared-service'\)/);
});

test('publishing cannot replace Load or live Show state after an async render', () => {
  const start = mainSource.indexOf("ipcMain.handle('prepare:projects:publish'");
  const end = mainSource.indexOf("ipcMain.handle('dialog:openPptx'", start);
  const source = mainSource.slice(start, end);
  const publishIndex = source.indexOf('showPackagePublisher.publish(');
  const staleCheckIndex = source.indexOf("'PREPARE_PUBLISH_STALE'");
  const installIndex = source.indexOf(
    'installPreparedPresentations(published.presentations, binding.roleIds)'
  );

  assert.ok(publishIndex >= 0 && staleCheckIndex > publishIndex && installIndex > staleCheckIndex,
    'async publication must be revalidated before presentations become current');
  assert.match(source, /publishGeneration !== preparePublishGeneration/);
  assert.match(source, /presentationRevision !== presentationRevisionAtStart/);
  assert.match(source, /outputSessionId !== outputSessionIdAtStart/);
  assert.match(source, /activeVenueProfile !== venueProfileAtStart/);
  assert.match(source, /\|\| isConverting/);
  assert.match(source, /\|\| conversionQueue\.length > 0/);
  assert.match(source, /\|\| appState\.activeLaunchPlan/);
});

test('native Prepare packages render on the stable 16:9 preset canvas', () => {
  const start = mainSource.indexOf("ipcMain.handle('prepare:projects:publish'");
  const end = mainSource.indexOf("ipcMain.handle('dialog:openPptx'", start);
  const source = mainSource.slice(start, end);
  assert.match(source, /const targetWidth = CONFIG\.displayWidth/);
  assert.match(source, /const targetHeight = CONFIG\.displayHeight/);
  assert.doesNotMatch(source, /screen\.getAllDisplays\(\)/);
});

test('the bundled native font and its fontconfig remain physical packaged resources', () => {
  assert.ok(packageJson.build.asarUnpack.includes('assets/fonts/**'));
  assert.equal(packageJson.build.mac.minimumSystemVersion, '12.0');
  assert.match(packageJson.build.buildVersion, /^\d+$/);
  assert.equal(packageJson.build.afterPack, 'scripts/afterPack.js');
  assert.equal(packageJson.build.mac.extendInfo.NSAppTransportSecurity.NSAllowsArbitraryLoads, false);
  assert.match(afterPackSource, /NSAllowsArbitraryLoads false/);
  assert.match(afterPackSource, /MAC_UNRELATED_DEVICE_USAGE_KEYS/);
  assert.equal(fs.existsSync(path.join(root, 'assets', 'fonts', 'NotoSans-Variable.ttf')), true);
  assert.equal(fs.existsSync(path.join(root, 'assets', 'fonts', 'OFL-NotoSans.txt')), true);
  assert.equal(fs.existsSync(path.join(root, 'assets', 'fonts', 'fonts.conf')), true);
  assert.match(fontConfigSource, /<cachedir prefix="xdg">fontconfig<\/cachedir>/);
});
