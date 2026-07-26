'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const rendererDirectory = path.join(__dirname, '..', 'src', 'renderer');
const readSource = filePath => fs.readFileSync(filePath, 'utf8').replace(/\r\n/g, '\n');
const html = readSource(path.join(rendererDirectory, 'index.html'));
const appSource = readSource(path.join(rendererDirectory, 'app.js'));
const prepareSource = readSource(path.join(rendererDirectory, 'prepare-controller.js'));
const mainSource = readSource(path.join(__dirname, '..', 'main.js'));
const preloadSource = readSource(path.join(__dirname, '..', 'preload.js'));
const displayHtml = readSource(path.join(rendererDirectory, 'display.html'));
const displaySource = readSource(path.join(rendererDirectory, 'display.js'));
const nativeCueSource = readSource(path.join(rendererDirectory, 'native-cue-renderer.js'));
const singerHtml = readSource(path.join(rendererDirectory, 'singer.html'));
const singerSource = readSource(path.join(rendererDirectory, 'singer.js'));
const bibleOverlaySource = readSource(path.join(rendererDirectory, 'bible-overlay.js'));

function matches(source, expression) {
  return [...source.matchAll(expression)].map(match => match[1]);
}

test('every renderer element lookup has a matching unique HTML id', () => {
  const lookedUpIds = new Set([
    ...matches(appSource, /getElementById\('([^']+)'\)/g),
    ...matches(prepareSource, /byId\('([^']+)'\)/g)
  ]);
  const htmlIds = matches(html, /\sid="([^"]+)"/g);
  const htmlIdSet = new Set(htmlIds);

  assert.deepEqual(
    [...lookedUpIds].filter(id => !htmlIdSet.has(id)),
    [],
    'app.js must not look up missing elements'
  );
  assert.equal(htmlIdSet.size, htmlIds.length, 'HTML ids must be unique');
});

test('live Show and in-flight Prepare work cannot be abandoned through stage tabs', () => {
  assert.match(appSource, /function updateWorkflowNavigationAvailability\(\)/);
  assert.match(appSource, /elements\.btnStagePrepare\.disabled = liveShowSession/);
  assert.match(appSource, /elements\.btnStageLoad\.disabled = liveShowSession/);
  assert.match(appSource, /Use Back to Load to end the live Show safely/);
  assert.match(appSource, /prepareController\?\.isBusy\?\.\(\)/);
  assert.match(prepareSource, /isBusy: \(\) => state\.mutationBusy \|\| state\.publishBusy/);
});

test('Prepare exposes retry-safe loading, complete subtree warnings, and render progress', () => {
  assert.match(prepareSource, /state\.activated = false;/);
  assert.match(prepareSource, /Leave Prepare and open it again to retry/);
  assert.match(prepareSource, /function countDescendants\(project, itemId\)/);
  assert.match(prepareSource, /and all \$\{nestedCount\}/);
  assert.match(prepareSource, /api\.onPreparePublishProgress\(handlePublishProgress\)/);
  assert.match(prepareSource, /Preparing offline Show…/);
});

test('Load is the friendly startup surface and Start blockers have visible reasons', () => {
  assert.match(html, /<body class="friendly-mode load-stage">/);
  assert.match(html, /id="loadEssentials"/);
  assert.match(html, /<h2 id="loadHeading">Today’s slideshows<\/h2>/);
  assert.match(html, /id="loadAutoStatus"/);
  assert.match(html, /id="readinessIssues"/);
  assert.match(html, /id="btnRestorePrevious"[^>]+hidden/);
  assert.doesNotMatch(html, /setupSlideNum|setupTotalSlides|btnStopPresentation/);
  assert.match(appSource, /function getReadinessState\(\)/);
  assert.match(html, /id="inputCards"[^>]+Service slideshow inputs/);
  assert.match(appSource, /getDeckRoles\(\)\.forEach/);
  assert.match(appSource, /state\.cachedPresentations = plan\?\.caches/);
  assert.match(appSource, /presentationElements\[role\.id\]/);
});

test('Load discovers one coherent offline service set while preserving manual fallback', () => {
  assert.match(html, /id="serviceFolderCard"/);
  assert.match(html, /Matching slideshows will populate the Load cards automatically/);
  assert.match(html, /Google Drive Desktop/);
  assert.match(html, /id="serviceFolderDate"[^>]+type="date"/);
  assert.match(html, /id="btnChooseServiceFolder"/);
  assert.match(html, /id="btnRefreshServiceFolder"/);
  assert.match(html, /id="btnLoadServiceSet"/);
  assert.match(html, /id="advancedSetupDetails" class="admin-settings-dialog"/);
  assert.match(html, /id="profileServiceFolder"/);
  assert.match(html, /id="profileTimeZone"/);
  assert.match(html, /id="profileServiceDateOrder"/);

  assert.match(appSource, /function loadPresentationFile\(/);
  assert.match(appSource, /window\.api\.scanServiceFolder/);
  assert.match(appSource, /window\.api\.pinServiceSet/);
  assert.match(appSource, /window\.api\.checkServiceSetChanges/);
  assert.match(appSource, /state\.serviceFolder\.staleRoleIds\.length/);
  assert.match(appSource, /files from different services are not mixed/);
  assert.match(appSource, /window\.api\.getCacheRestorePlan/);
  assert.match(appSource, /state\.restoreGroupId = manifest\.id/);
  assert.match(appSource, /Not part of the compatible saved service/);

  assert.match(mainSource, /ipcMain\.handle\('dialog:openServiceFolder'/);
  assert.match(mainSource, /ipcMain\.handle\('service-folder:scan'/);
  assert.match(mainSource, /ipcMain\.handle\('service-set:pin'/);
  assert.match(mainSource, /requireServiceScanProposal\(/);
  assert.match(mainSource, /requireApprovedPresentationFile\(/);
  assert.match(mainSource, /ipcMain\.handle\('cache:restorePlan'/);
  assert.match(mainSource, /CACHE_RESTORE_CHANGED/);
  assert.match(mainSource, /readCurrentServiceSet\(getServiceSetRoot\(\), \{ verifyAssets: true \}\)/);
  assert.match(preloadSource, /chooseServiceFolder/);
  assert.match(preloadSource, /scanServiceFolder/);
  assert.match(preloadSource, /pinServiceSet/);
  assert.match(preloadSource, /getCacheRestorePlan/);
  assert.match(preloadSource, /onServiceFolderChanged/);
});

test('service-folder scans cannot publish a token for a profile that changed mid-scan', () => {
  const handlerStart = mainSource.indexOf("ipcMain.handle('service-folder:scan'");
  const handlerEnd = mainSource.indexOf("ipcMain.handle('service-set:pin'", handlerStart);
  const handlerSource = mainSource.slice(handlerStart, handlerEnd);
  const captureIndex = handlerSource.indexOf('captureServiceScanContext(request.requestedDate)');
  const firstAwaitIndex = handlerSource.indexOf('await ');

  assert.notEqual(handlerStart, -1, 'service-folder scan handler must exist');
  assert.notEqual(handlerEnd, -1, 'service-set pin handler must follow the scan handler');
  assert.ok(captureIndex >= 0 && captureIndex < firstAwaitIndex,
    'profile-derived scan context must be captured before the first async boundary');
  assert.match(handlerSource, /inputRoles: scanContext\.inputRoles/);
  assert.match(handlerSource, /requiredRoleIds: scanContext\.requiredRoleIds/);
  assert.match(handlerSource, /requestedDate: scanContext\.requestedDate/);
  assert.match(handlerSource, /dateOrder: scanContext\.dateOrder/);
  assert.match(handlerSource,
    /holdServiceScanProposal\(scan, scanContext\.profileSignature\)/);

  assert.match(mainSource, /function holdServiceScanProposal\(scan, profileSignature\)/);
  assert.match(mainSource, /requireCurrentServiceScanProfile\(profileSignature\);/);
  assert.match(mainSource, /profileSignature,\n\s+expiresAt:/);
});

test('renderer never mixes an omitted or superseded role into a loaded service', () => {
  const loadStart = appSource.indexOf('async function loadSelectedServiceSet()');
  const loadEnd = appSource.indexOf('function renderInputCards()', loadStart);
  const loadSource = appSource.slice(loadStart, loadEnd);

  assert.notEqual(loadStart, -1, 'service-set loader must exist');
  assert.match(appSource, /function clearPresentationRole\(roleId,/);
  assert.match(loadSource, /const omittedRoles = activeRoles\.filter/);
  assert.match(loadSource, /clearPresentationRole\(role\.id,/);
  assert.match(loadSource, /state\.serviceFolder\.staleRoleIds = \[\.\.\.staleRoleIds\]/);
  assert.match(loadSource, /presentationConversionInFlight\(\)/);
  assert.match(loadSource, /choose manually or decide at Start/);
});

test('renderer uses fresh scan epochs and an offline fallback for unavailable Drive files', () => {
  assert.match(appSource, /scanEpoch: null/);
  assert.match(appSource, /changeEpoch: 0/);
  assert.match(appSource, /state\.serviceFolder\.changeEpoch \+= 1/);
  assert.match(appSource,
    /state\.serviceFolder\.scanEpoch === state\.serviceFolder\.changeEpoch/);
  assert.match(appSource, /function serviceSetHasUnavailableInput\(/);
  assert.match(appSource, /function shouldUseSavedServiceFallback\(/);
  assert.match(appSource, /Load saved service will use the verified offline copy/);
  assert.match(appSource, /const noNewerFolderEvent = loadedScanEpoch !== null/);
});

test('scan-relevant profile changes invalidate the renderer scan contract', () => {
  const signatureStart = appSource.indexOf('function serviceFolderScanProfileSignature(profile)');
  const signatureEnd = appSource.indexOf('function invalidateServiceFolderScan()', signatureStart);
  const signatureSource = appSource.slice(signatureStart, signatureEnd);

  assert.notEqual(signatureStart, -1, 'renderer scan-profile signature must exist');
  for (const field of [
    'serviceDateOrder',
    'inputRoles',
    'filenameMatchers',
    'required',
    'datePolicy',
    'outputs',
    'expectedRoleId',
    'sourceRoleId',
    'fallback'
  ]) {
    assert.match(signatureSource, new RegExp(`\\b${field}\\b`));
  }
  assert.match(appSource, /if \(scanProfileChanged\) \{/);
  assert.match(appSource, /invalidateServiceFolderScan\(\);/);
  assert.match(appSource, /filter\(roleId => activeRoleIds\.has\(roleId\)\)/);
});

test('manual and cached filename warnings respect reusable input roles', () => {
  const warningStart = appSource.indexOf('function checkFilenameDate(language, filePath)');
  const warningEnd = appSource.indexOf('function updateConversionStatus(', warningStart);
  const warningSource = appSource.slice(warningStart, warningEnd);

  assert.match(warningSource, /getRole\(language\)\?\.datePolicy === 'none'/);
  assert.match(warningSource, /warningEl\.style\.display = 'none'/);
});

test('missing outputs are resolved by an accessible service-only Start dialog', () => {
  assert.match(html, /<dialog id="startPreflightDialog"[^>]+aria-labelledby="preflightTitle"/);
  assert.match(html, /id="preflightChoices"/);
  assert.match(html, /id="preflightReview"/);
  assert.match(html, /id="btnCancelPreflight"/);
  assert.match(appSource, /value: 'derive-next-text'/);
  assert.match(appSource, /value: 'mirror'/);
  assert.match(appSource, /value: 'disabled'/);
  assert.match(appSource, /expectedRole: output\.expectedRoleId/);
  assert.doesNotMatch(appSource, /if \(!russianReady\) issues\.push/);
  assert.doesNotMatch(appSource, /if \(!englishReady\) issues\.push/);
});

test('Load exposes one-service-only and Singer fallback choices without saving the venue profile', () => {
  assert.match(html, /<script src="service-output-plan\.js"><\/script>/);
  assert.match(appSource, /serviceOutputDecisions: \{\}/);
  assert.match(appSource, /singleServiceRoleId: null/);
  assert.match(appSource, /Use only this slideshow today/);
  assert.match(appSource, /Affects this service only—not Admin Settings\./);
  assert.match(appSource, /Next-text view from \$\{getRoleLabel\(sourceRole\)\}/);
  assert.match(appSource, /Show \$\{getRoleLabel\(sourceRole\)\} slides as-is/);
  assert.match(appSource, /Turn off \$\{output\.name\} for this service/);
  assert.match(appSource, /createOnlyRoleDecisions\(outputs, roleId\)/);
  assert.match(appSource, /filterDecisionsForOutputs\(\s*readiness\.outputs,/);
  assert.match(appSource, /resetServiceOutputChoices\(\);\s*state\.profile = cloneValue\(profile\)/);
});

test('Friendly Mode guards the staged profile editor and previews are output-driven', () => {
  assert.match(html, /id="friendlyMode" checked/);
  assert.match(html, /id="advancedWarningDialog"/);
  assert.match(html, /Do you know what you’re doing\?/);
  assert.match(html, /id="expertSettingsSection" class="expert-settings"/);
  assert.match(html, /id="outputSettingsList"/);
  assert.match(html, /id="btnSaveProfile"[^>]+disabled/);
  assert.match(html, /id="btnCancelProfileChanges"[^>]+disabled/);
  assert.match(html, /id="outputPreviewList"/);
  assert.match(appSource, /state\.profileDraft/);
  assert.match(appSource, /operatorPreview: output\.operatorPreview/);
  assert.match(appSource, /window\.api\.onOutputPreview\(handleOutputPreview\)/);
  assert.match(appSource, /window\.api\.setPreviewSubscriptions\(outputIds\)/);
  assert.match(appSource, /function queueProfilePreferenceSave\(/);
  assert.match(appSource, /globalThis\.crypto\?\.randomUUID/);
  assert.match(appSource, /function isEditableOutputRoute\(output\)/);
  assert.match(appSource, /imported route that must be changed to a direct slideshow/);
  assert.doesNotMatch(appSource, /output\.id === ['"]singer['"]/);
});

test('display bindings are explicit and never auto-assigned after a rescan', () => {
  assert.match(html, /id="btnIdentifyDisplays"/);
  assert.match(appSource, /Saved screen is not connected/);
  assert.match(appSource, /function resolveOutputDisplay\(output\)/);
  assert.doesNotMatch(appSource, /Auto-select if possible/);
  assert.doesNotMatch(appSource, /nonPrimaryDisplays\[index\]/);
  assert.match(appSource, /The saved binding was preserved/);
  assert.match(appSource, /Operator controls \(not available for output\)/);
});

test('operator display and closed previews are protected in both renderer and main', () => {
  assert.match(mainSource, /function getControlDisplayId\(\)/);
  assert.match(mainSource, /isControl: display\.id === controlDisplayId/);
  assert.match(mainSource, /assigned to the operator screen; choose a presentation screen/);
  assert.match(mainSource, /outputPreviewSubscriptions\.has\(output\.id\)/);
  assert.match(mainSource, /output:setPreviewSubscriptions/);
  assert.match(preloadSource, /setPreviewSubscriptions/);
});

test('Show includes a staged Heritage-style Bible palette with explicit ambiguity choices', () => {
  assert.match(html, /id="btnOpenBible"[^>]+aria-haspopup="dialog"/);
  assert.match(html, /<dialog id="bibleDialog"[^>]+aria-labelledby="bibleDialogTitle"/);
  assert.match(html, /id="bibleAmbiguityTitle">Which book did you mean\?<\/h3>/);
  assert.match(html, /id="bibleTranslation"/);
  assert.match(html, /<option value="BSB" selected>BSB<\/option>/);
  assert.match(html, /<option value="LSV">LSV<\/option>/);
  assert.match(html, /id="bibleTargetList"/);
  assert.match(html, /id="btnSendBibleLive"[^>]+disabled/);
  assert.match(html, /id="btnReturnFromBible"[^>]+hidden/);
  assert.match(appSource, /function handleBibleChoiceKeyboard\(/);
  assert.match(appSource, /window\.api\.lookupBiblePassage/);
  assert.match(appSource, /window\.api\.showBiblePassage/);
  assert.match(appSource, /window\.api\.hideBiblePassage/);
});

test('Bible outputs use the shared fitted double-buffer overlay controller', () => {
  for (const [outputHtml, rendererScript] of [
    [displayHtml, 'display.js'],
    [singerHtml, 'singer.js']
  ]) {
    const outputIds = matches(outputHtml, /\sid="([^"]+)"/g);
    assert.equal(new Set(outputIds).size, outputIds.length, 'output HTML ids must be unique');
    assert.match(outputHtml, /id="bibleOverlay"[^>]+hidden/);
    assert.match(outputHtml, /id="bibleVerses"/);
    assert.match(outputHtml, /id="bibleOverlayStaging"[^>]+aria-hidden="true"[^>]+hidden/);
    assert.match(outputHtml, /id="bibleReferenceStaging"/);
    assert.match(outputHtml, /id="bibleVersesStaging"/);
    assert.match(outputHtml, /id="bibleTranslationStaging"/);
    assert.match(outputHtml, /id="bibleAttributionStaging"/);
    const scriptSequence = rendererScript === 'display.js'
      ? '<script src="bible-overlay.js"></script>\\s*'
        + '<script src="native-cue-renderer.js"></script>\\s*'
        + '<script src="display.js"></script>'
      : '<script src="bible-overlay.js"></script>\\s*'
        + `<script src="${rendererScript}"></script>`;
    assert.match(outputHtml, new RegExp(scriptSequence),
      'trusted helpers must load before the output renderer');
  }

  for (const outputSource of [displaySource, singerSource]) {
    assert.match(outputSource, /window\.createBibleOverlayController\(/);
    assert.match(outputSource, /onBibleOverlayPrepare\(data => bibleOverlayController\.prepare\(data\)\)/);
    assert.match(outputSource, /onBibleOverlayReveal\(data => bibleOverlayController\.reveal\(data\)\)/);
    assert.match(outputSource, /onBibleOverlayHide\(data => bibleOverlayController\.hide\(data\)\)/);
    assert.match(outputSource, /bibleOverlayController\.hide\(\)/);
    assert.match(outputSource, /reportBibleOverlayRevealed\(data\)/);
    assert.match(outputSource, /reportBibleOverlayHidden\(data\)/);
  }

  assert.match(bibleOverlaySource, /let activeLayer = layerFromSuffix\(''\)/);
  assert.match(bibleOverlaySource, /let stagingLayer = layerFromSuffix\('Staging'\)/);
  assert.match(bibleOverlaySource, /document\.createTextNode/);
  assert.match(bibleOverlaySource, /element\.scrollWidth <= element\.clientWidth \+ tolerance/);
  assert.match(bibleOverlaySource, /element\.scrollHeight <= element\.clientHeight \+ tolerance/);
  assert.match(bibleOverlaySource, /requestAnimationFrame\(\(\) => requestAnimationFrame/);
  assert.match(bibleOverlaySource, /onReady\?\.\(\{\s*overlayId,\s*ok: fits/);
  assert.match(bibleOverlaySource, /schedule\(stagingLayer, revealAt/);
  assert.match(bibleOverlaySource, /activeLayer = stagingLayer;\s*stagingLayer = previousLayer;/);
  assert.match(bibleOverlaySource, /if \(overlayId === preparedOverlayId\)/);
  assert.match(bibleOverlaySource, /if \(overlayId === activeOverlayId\)/);
  assert.match(bibleOverlaySource, /if \(preparedOverlayId !== overlayId\) return;/);
  assert.match(bibleOverlaySource, /if \(activeOverlayId !== overlayId\) return;/);
  assert.match(bibleOverlaySource, /window\.createBibleOverlayController = createBibleOverlayController/);
});

test('native cue output is constrained, font-gated, staged, and acknowledged after paint', () => {
  assert.match(displayHtml, /font-src 'self' file:/);
  assert.match(displayHtml, /object-src 'none'/);
  assert.match(displayHtml, /id="native-layer-0"/);
  assert.match(displayHtml, /id="native-layer-1"/);
  assert.match(preloadSource, /ipcRenderer\.on\('native-cue:goto'/);
  assert.match(displaySource, /window\.api\.onNativeCueGoto\(handleNativeCueGoto\)/);
  assert.match(displaySource, /new FontFace\(/);
  assert.match(displaySource, /await document\.fonts\.ready/);
  assert.match(displaySource, /await candidate\.prepare\(\)/);
  assert.match(displaySource, /reportOutputFrameReady\(\{ kind: 'native-cue', index, ok: true \}\)/);
  assert.match(displaySource, /await swapToNativeCue\(/);
  assert.match(displaySource, /function scheduleReveal\(/);
  assert.match(displaySource, /request\.paintFrame = requestAnimationFrame/);
  assert.ok(
    displaySource.indexOf('const didReveal = await swapToNativeCue')
      < displaySource.indexOf("reportOutputFrameReady({ kind: 'native-cue', index, ok: true })"),
    'a fitted native scene must reach its paint barrier before ACKing readiness'
  );

  assert.match(nativeCueSource, /function exactKeys\(/);
  assert.match(nativeCueSource, /document\.createTextNode/);
  assert.match(nativeCueSource, /element\.scrollWidth <= element\.clientWidth/);
  assert.match(nativeCueSource, /element\.scrollHeight <= element\.clientHeight/);
  assert.doesNotMatch(
    nativeCueSource,
    /innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\s*\(|new Function/
  );
});

test('Bible overlay lifecycle is cancellable and preserves an exact Return path', () => {
  assert.match(mainSource, /new BibleLibrary\(\{ maxVerses: 8 \}\)/);
  assert.match(mainSource, /ipcMain\.handle\('bible:lookup'/);
  assert.match(mainSource, /ipcMain\.handle\('bible:show'/);
  assert.match(mainSource, /let pendingBibleOverlay = null;/);
  assert.match(mainSource, /let bibleOperationEpoch = 0;/);
  assert.match(mainSource, /function createBibleOverlayWaiter\(/);
  assert.match(mainSource, /function createBibleOverlayRevealWaiter\(/);
  assert.match(mainSource, /function createBibleOverlayHideWaiter\(/);
  assert.match(mainSource, /eventChannel: 'bible:revealed'/);
  assert.match(mainSource, /eventChannel: 'bible:hidden'/);
  assert.match(mainSource, /cancelWaiter = reason =>/);
  assert.match(mainSource, /return \{ promise, cancel: cancelWaiter \};/);
  assert.match(mainSource, /function cancelPendingBibleOverlay\([^)]*\)/);
  assert.match(mainSource, /const operationEpoch = \+\+bibleOperationEpoch;/);
  assert.match(mainSource, /operationEpoch !== bibleOperationEpoch/);
  assert.match(mainSource, /pendingBibleOverlay = candidate;/);
  assert.match(mainSource, /Promise\.all\(readyWaiters\.map\(waiter => waiter\.promise\)\)/);
  assert.match(mainSource, /Promise\.all\(transitionWaiters\.map\(waiter => waiter\.promise\)\)/);
  assert.match(mainSource, /for \(const waiter of transactionWaiters\) waiter\.cancel\(error\);/);
  assert.match(mainSource, /Promise\.allSettled\(transactionWaiters\.map\(waiter => waiter\.promise\)\)/);
  assert.match(mainSource, /const revealAt = Date\.now\(\) \+ 120;/);
  assert.match(mainSource, /win\.webContents\.send\('bible:reveal', \{ overlayId, revealAt \}\)/);
  assert.match(
    mainSource,
    /if \(activeBibleOverlay \|\| pendingBibleOverlay\) \{[\s\S]*accepted: false,[\s\S]*code: 'BIBLE_OVERLAY_ACTIVE'/
  );
  assert.match(mainSource, /function hideBibleOverlay\(\{ restore = true \} = \{\}\) \{\s*bibleOperationEpoch \+= 1;/);
  assert.match(mainSource, /isCleared: appState\.isCleared/);
  assert.match(mainSource, /hideBibleOverlay\(\{ restore: false \}\)/);
  assert.match(preloadSource, /reportBibleOverlayReady/);
  assert.match(preloadSource, /reportBibleOverlayRevealed/);
  assert.match(preloadSource, /reportBibleOverlayHidden/);
  assert.match(preloadSource, /onBibleStateChanged/);
});
