'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.join(__dirname, '..');
const mainSource = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
const appSource = fs.readFileSync(
  path.join(root, 'src', 'renderer', 'app.js'),
  'utf8'
);
const controllerSource = fs.readFileSync(
  path.join(root, 'src', 'renderer', 'prepare-controller.js'),
  'utf8'
);
const htmlSource = fs.readFileSync(
  path.join(root, 'src', 'renderer', 'index.html'),
  'utf8'
);
const styleSource = fs.readFileSync(
  path.join(root, 'src', 'renderer', 'styles.css'),
  'utf8'
);

function functionSource(source, name, nextMarker = '\nfunction ') {
  const start = source.indexOf(`function ${name}`);
  assert.notEqual(start, -1, `${name} must exist`);
  const tail = source.slice(start + 10);
  const nextFunction = tail.match(/\n\s*(?:async\s+)?function\s+[A-Za-z_$]/u);
  const end = nextFunction ? start + 10 + nextFunction.index : -1;
  return source.slice(start, end === -1 ? source.length : end);
}

function asyncFunctionSource(source, name) {
  const start = source.indexOf(`async function ${name}`);
  assert.notEqual(start, -1, `${name} must exist`);
  const tail = source.slice(start + 10);
  const nextFunction = tail.match(/\n\s*(?:async\s+)?function\s+[A-Za-z_$]/u);
  const end = nextFunction ? start + 10 + nextFunction.index : source.length;
  return source.slice(start, end);
}

test('Load and Show expose the verified service brief only to the local operator', () => {
  for (const id of [
    'loadServiceHandoff',
    'loadServiceHandoffTitle',
    'loadServiceHandoffNotes',
    'loadServiceHandoffRunSheet',
    'loadServiceHandoffTeam',
    'loadServiceHandoffReview',
    'showCueContext',
    'showCueContextTitle',
    'showCueContextMeta',
    'showCueContextNote',
    'showCueContextNext'
  ]) {
    assert.match(htmlSource, new RegExp(`id="${id}"`));
  }
  assert.match(htmlSource, /<script src="service-handoff\.js"><\/script>[\s\S]*<script src="app\.js"><\/script>/);
  assert.match(styleSource, /\.load-service-handoff\[hidden\]/);
  assert.match(styleSource, /\.show-cue-context-note/);
  assert.match(appSource, /function applyServiceHandoff[\s\S]*normalizeServiceHandoff/);
  assert.match(appSource, /function renderLoadServiceHandoff/);
  assert.match(appSource, /function renderShowCueContext/);
  assert.match(appSource, /runSheetLoadSummary\(handoff\.runSheet\)/);
  assert.match(appSource, /servingLoadSummary\(planning\?\.serving\)/);
  assert.match(appSource, /current\?\.itemPathIds/);
  assert.match(appSource, /assignment\.scope\.kind === 'service'/);
  assert.match(appSource, /function updateSlideCounter[\s\S]*renderShowCueContext\(\)/);
});

test('main revalidates one agreeing installed handoff and exposes path-free cue semantics', () => {
  assert.match(mainSource, /normalizeServiceHandoff,/);
  const installed = functionSource(mainSource, 'installedServiceHandoff');
  assert.match(installed, /renderer === 'native-cue'/);
  assert.match(installed, /handoffs\.some\(handoff => !handoff\)/);
  assert.match(installed, /JSON\.stringify\(handoff\) !== canonical/);

  const appStateStart = mainSource.indexOf("ipcMain.handle('app:getState'");
  const appStateEnd = mainSource.indexOf("ipcMain.handle('", appStateStart + 20);
  const appStateHandler = mainSource.slice(appStateStart, appStateEnd);
  assert.match(appStateHandler, /serviceHandoff: installedServiceHandoff\(\)/);

  const slideListStart = mainSource.indexOf("ipcMain.handle('slides:getList'");
  const slideListEnd = mainSource.indexOf("ipcMain.handle('", slideListStart + 20);
  const slideListHandler = mainSource.slice(slideListStart, slideListEnd);
  assert.match(
    slideListHandler,
    /rendererSlideSemantics\(presentation, index, serviceHandoff\)/
  );
  assert.match(slideListHandler, /\.\.\.semantics/);
  assert.doesNotMatch(
    functionSource(mainSource, 'rendererSlideSemantics'),
    /cacheDir|imagePath|thumbnailPath/
  );
});

test('Back to Load ends outputs before offering any post-service action', () => {
  const source = asyncFunctionSource(appSource, 'backToSetup');
  const endIndex = source.indexOf('window.api.endPresentation()');
  const stageIndex = source.indexOf('setWorkflowStage(');
  const dialogIndex = source.indexOf('openShowHandoffDialog(');
  assert.ok(endIndex >= 0, 'Back must end the output session');
  assert.ok(stageIndex > endIndex, 'Load navigation must wait for the output session to end');
  assert.ok(dialogIndex > stageIndex, 'post-service actions must appear only after Load is safe');
});

test('post-service planning uses the exact package revision and never publishes', () => {
  const source = asyncFunctionSource(appSource, 'savePostShowPlanningStatus');
  assert.match(source, /setServicePlanningStatus\(\{/);
  assert.match(source, /projectId: handoff\.project\.id/);
  assert.match(source, /expectedRevisionId: handoff\.project\.revisionId/);
  assert.match(source, /result\?\.project\?\.planning\?\.status !== status/);
  assert.doesNotMatch(
    source,
    /window\.api\.(?:syncCommunity|publish|push)/u
  );
  assert.match(htmlSource, /Nothing here publishes to Community\./);
});

test('Complete and open advances by exact CAS before opening only the committed revision', () => {
  assert.match(
    htmlSource,
    /id="btnShowHandoffCompleted"[^>]*>Complete &amp; open sermon handoff</u
  );
  const action = asyncFunctionSource(
    appSource,
    'completeAndOpenPostShowSermonHandoff'
  );
  assert.match(
    action,
    /savePostShowPlanningStatus\('completed',\s*\{\s*openSermonHandoff: true/
  );

  const source = asyncFunctionSource(appSource, 'savePostShowPlanningStatus');
  const casIndex = source.indexOf('window.api.setServicePlanningStatus({');
  const openIndex = source.indexOf('prepareController.openServiceHandoff({');
  assert.ok(casIndex >= 0, 'the exact planning CAS must run');
  assert.ok(openIndex > casIndex, 'the sermon handoff must open only after completion commits');
  assert.match(source, /expectedRevisionId: handoff\.project\.revisionId/);
  assert.match(
    source,
    /project:\s*\{\s*id: result\.project\.id,\s*revisionId: result\.revisionId/
  );
  assert.doesNotMatch(
    source,
    /window\.api\.(?:syncCommunity|publish|push)/u
  );
});

test('sermon handoff opens only the still-current exact project before selecting its owner', () => {
  const source = asyncFunctionSource(controllerSource, 'openServiceHandoff');
  assert.match(source, /openProject\(projectId, null,/);
  assert.match(source, /validateBeforeApply:/);
  assert.match(source, /rawResult\?\.revisionId !== revisionId/);
  assert.match(source, /linked\.resourceOwnerId === row\.item\.id/);
  assert.match(source, /elements\.btnReviewSermonPostService/);
  assert.doesNotMatch(source, /api\.(?:syncCommunity|publish|push)/u);
});
