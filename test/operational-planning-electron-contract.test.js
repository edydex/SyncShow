'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..');
const fixtureSource = fs.readFileSync(path.join(
  root,
  'scripts',
  'fixtures',
  'operational-planning-electron-app.js'
), 'utf8');
const runnerSource = fs.readFileSync(path.join(
  root,
  'scripts',
  'verify-operational-planning-electron.js'
), 'utf8');
const prepareSource = fs.readFileSync(path.join(
  root,
  'src',
  'renderer',
  'prepare-controller.js'
), 'utf8');
const mainSource = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
const packageJson = JSON.parse(fs.readFileSync(
  path.join(root, 'package.json'),
  'utf8'
));

test('operational Planning Electron proof uses the production app and an isolated store', () => {
  assert.equal(
    packageJson.scripts['test:operational-planning-electron'],
    'node scripts/verify-operational-planning-electron.js'
  );
  assert.match(fixtureSource, /require\('\.\.\/\.\.\/main'\);/u);
  assert.match(fixtureSource, /ISOLATED_TEST_USER_DATA_MARKER/u);
  assert.match(fixtureSource, /new ServiceProjectStore\(\{/u);
  assert.match(fixtureSource, /initialStoredProject\.project\.revision, 1/u);
  assert.match(fixtureSource, /unchangedAfterNavigation\.revisionId/u);
  assert.match(runnerSource, /--syncshow-test-user-data/u);
  assert.match(
    runnerSource,
    /syncshow-operational-planning-real-electron-v2/u
  );
});

test('blank-service Weekly Checks prove all six actions, primary routing, and review dialog behavior', () => {
  for (const checkId of [
    'compilable-nonempty',
    'song-present',
    'exact-sermon-link',
    'linked-sermon-material',
    'sermon-reading-before-material',
    'channel-visible-content'
  ]) {
    assert.match(fixtureSource, new RegExp(checkId, 'u'));
    assert.match(runnerSource, new RegExp(checkId, 'u'));
  }
  assert.match(
    fixtureSource,
    /#prepareServiceReadinessChecks button\[data-weekly-readiness-action/u
  );
  assert.match(fixtureSource, /actions\.length !== 6/u);
  assert.match(
    fixtureSource,
    /Continue setup · \$\{WEEKLY_ACTION_LABELS\[0\]\}/u
  );
  assert.match(
    fixtureSource,
    /exerciseWeeklyReadinessAction[\s\S]*expectedFocusId/u
  );
  assert.match(fixtureSource, /expectedFocusId: 'prepareSongSearch'/u);
  assert.match(fixtureSource, /expectedFocusId: 'btnAddServiceSermon'/u);
  assert.match(
    fixtureSource,
    /#serviceReadinessReviewChecks \[data-readiness-check-id\]/u
  );
  assert.match(
    fixtureSource,
    /document\.activeElement\?\.id !== 'serviceReadinessStartTime'/u
  );
  assert.match(
    runnerSource,
    /result\.weeklyChecks\.reviewDialog\.openDialogs/u
  );
});

test('detached revision-bound action is refused after Add Text without another store write', () => {
  assert.match(
    fixtureSource,
    /window\.__syncshowOperationalStaleWeeklyAction = actions\[0\]/u
  );
  assert.match(fixtureSource, /button\.remove\(\)/u);
  assert.match(
    fixtureSource,
    /storedAfterAddText\.project\.revision, 2/u
  );
  assert.match(
    fixtureSource,
    /window\.__syncshowOperationalStaleWeeklyAction;[\s\S]*button\.click\(\)/u
  );
  assert.match(fixtureSource, /older service revision/u);
  assert.match(fixtureSource, /nothing was changed/u);
  assert.match(
    fixtureSource,
    /storedAfterStaleRefusal\.project\.revision,[\s\S]*storedAfterAddText\.project\.revision/u
  );
  assert.match(
    fixtureSource,
    /storedAfterStaleRefusal\.revisionId,[\s\S]*storedAfterAddText\.revisionId/u
  );
  assert.match(runnerSource, /staleRefusal\.projectRevisionAfter/u);
  assert.match(runnerSource, /staleRefusal\.revisionIdAfter/u);
  assert.match(
    runnerSource,
    /result\.weeklyChecks\.staleRefusal\.statusKind, 'warning'/u
  );
});

test('tracked native Planning continuation requires review, exact Ready CAS, then real Load publish', () => {
  assert.match(fixtureSource, /createTrackedNativeWeeklyService/u);
  assert.match(
    fixtureSource,
    /setServicePlanStatus\([\s\S]*fixture\.ready\.project,[\s\S]*'planning'/u
  );
  assert.match(
    fixtureSource,
    /fixture\.projectStore\.save\(planningProject,[\s\S]*expectedRevisionId: fixture\.ready\.revisionId/u
  );
  assert.match(fixtureSource, /analyzeServiceProjectReadiness/u);
  assert.match(
    fixtureSource,
    /#prepareProjectList button\[data-project-id\]/u
  );
  assert.match(
    fixtureSource,
    /dataset\.workflowContinuation !== 'review-ready'/u
  );
  assert.match(fixtureSource, /Review & mark Ready/u);
  assert.match(
    fixtureSource,
    /document\.activeElement\?\.id !== 'serviceReadinessTitle'/u
  );
  assert.match(fixtureSource, /confirmed\.click\(\)/u);
  assert.match(fixtureSource, /markReady\.click\(\)/u);
  assert.match(
    fixtureSource,
    /readyStored\.project\.revision,[\s\S]*planningStored\.project\.revision \+ 1/u
  );
  assert.match(
    fixtureSource,
    /dataset\.workflowContinuation !== 'publish-load'/u
  );
  assert.match(fixtureSource, /Save & go to Load/u);
  assert.match(fixtureSource, /classList\.contains\('load-stage'\)/u);
  assert.match(fixtureSource, /new CurrentShowPackageStore/u);
  assert.match(fixtureSource, /publisher\.open\(pointer\.packageId\)/u);
  assert.match(fixtureSource, /sourceType === 'service-project'/u);
  assert.match(fixtureSource, /renderer === 'native-cue'/u);
  assert.match(
    fixtureSource,
    /externalAfter\.community,[\s\S]*externalBefore\.community/u
  );
  assert.match(
    fixtureSource,
    /externalAfter\.powerPointSlideCache,[\s\S]*externalBefore\.powerPointSlideCache/u
  );
  assert.match(
    fixtureSource,
    /\.pptx\?\\b\|imported-deck\|legacy-deck/u
  );

  assert.match(runnerSource, /result\.lifecycleContinuation/u);
  assert.match(runnerSource, /continuation\.humanConfirmation/u);
  assert.match(runnerSource, /continuation\.ready\.revisionId/u);
  assert.match(runnerSource, /continuation\.load\.handoffVisible/u);
  assert.match(runnerSource, /continuation\.currentPackage/u);
  assert.match(runnerSource, /continuation\.externalWrites/u);
});

test('production continuation authority has no Community write or PowerPoint processing branch', () => {
  const continuationStart = prepareSource.indexOf(
    'function runNativeWorkflowContinuation(descriptor)'
  );
  const continuationEnd = prepareSource.indexOf(
    '\n    function closeWeeklySermonAnchorChooser',
    continuationStart
  );
  assert.ok(continuationStart >= 0 && continuationEnd > continuationStart);
  const continuationSource = prepareSource.slice(
    continuationStart,
    continuationEnd
  );
  assert.match(
    continuationSource,
    /openServiceReadinessReview\(\{ focusConfirmation: true \}\)/u
  );
  assert.match(continuationSource, /publishProject\(\)/u);
  assert.doesNotMatch(
    continuationSource,
    /pushCommunity|replaceCommunity|importCommunity|PowerPoint|openPptx|runConversion/iu
  );

  const publishStart = prepareSource.indexOf('async function publishProject()');
  const publishEnd = prepareSource.indexOf(
    '\n    function handlePublishProgress',
    publishStart
  );
  assert.ok(publishStart >= 0 && publishEnd > publishStart);
  const rendererPublishSource = prepareSource.slice(publishStart, publishEnd);
  assert.match(
    rendererPublishSource,
    /api\.publishServiceProject\(\{[\s\S]*projectId:[\s\S]*revisionId:/u
  );
  assert.doesNotMatch(
    rendererPublishSource,
    /pushCommunity|replaceCommunity|importCommunity|openPptx|runConversion/iu
  );

  const handlerStart = mainSource.indexOf(
    "ipcMain.handle('prepare:projects:publish'"
  );
  const handlerEnd = mainSource.indexOf(
    "\nipcMain.handle('dialog:openPptx'",
    handlerStart
  );
  assert.ok(handlerStart >= 0 && handlerEnd > handlerStart);
  const publishHandlerSource = mainSource.slice(handlerStart, handlerEnd);
  assert.match(publishHandlerSource, /isPowerPointCompanionProject/u);
  assert.match(publishHandlerSource, /showPackagePublisher\.publish\(\{/u);
  assert.match(publishHandlerSource, /activateCurrentPreparedService/u);
  assert.doesNotMatch(publishHandlerSource, /community/iu);
  assert.doesNotMatch(
    publishHandlerSource,
    /runConversion\s*\(|new Converter\s*\(|processConversionQueue\s*\(/u
  );
});
