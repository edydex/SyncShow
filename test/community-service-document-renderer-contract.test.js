'use strict';

const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(
  path.join(root, 'src', 'renderer', 'index.html'),
  'utf8'
);
const controller = fs.readFileSync(
  path.join(root, 'src', 'renderer', 'community-service-document-controller.js'),
  'utf8'
);
const app = fs.readFileSync(
  path.join(root, 'src', 'renderer', 'app.js'),
  'utf8'
);
const prepare = fs.readFileSync(
  path.join(root, 'src', 'renderer', 'prepare-controller.js'),
  'utf8'
);
const preload = fs.readFileSync(path.join(root, 'preload.js'), 'utf8');
const main = fs.readFileSync(path.join(root, 'main.js'), 'utf8');

test('Prepare presents canonical shared services instead of the legacy import card', () => {
  assert.match(html, /id="prepareSharedServices"/u);
  assert.match(html, />Prepared services</u);
  assert.match(html, />Open prepared service…</u);
  assert.match(html, /id="prepareCommunityPlans"[^>]+hidden/u);
  assert.match(
    html,
    /Community and SyncShow edit the same service/u
  );
  assert.match(
    html,
    /<script src="community-service-document-controller\.js"><\/script>\s*<script src="app\.js"><\/script>/u
  );
});

test('Load offers a direct route to the canonical Community service browser', () => {
  assert.match(html, /id="btnOpenCommunityServiceFromLoad"/u);
  assert.match(html, />\s*Open from Heritage Community\s*</u);
  assert.match(app, /sharedServiceController\?\.open\?\.\(\)/u);
  assert.match(app, /await setWorkflowStage\('prepare'\)/u);
  assert.match(controller, /open: browseServices/u);
  assert.match(controller, /elements\.dialog\.showModal\(\)/u);
});

test('multi-channel prepared services build the thumbnail grid once with deferred decoding', () => {
  assert.match(app, /loadSlideList\(role, \{ render: false \}\)/u);
  assert.match(app, /if \(render\) renderThumbnails\(\)/u);
  assert.match(app, /image\.loading = 'lazy'/u);
  assert.match(app, /image\.decoding = 'async'/u);
});

test('concurrent edits require a visible choice and never auto-overwrite', () => {
  assert.match(controller, /result\.state === 'conflict'/u);
  assert.match(controller, /Nothing was overwritten/u);
  assert.match(controller, /resolveConflict\('use-community'\)/u);
  assert.match(controller, /resolveConflict\('keep-local'\)/u);
  assert.match(html, /id="btnUseCommunityService"/u);
  assert.match(html, /id="btnKeepLocalService"/u);
  assert.match(main, /kind: 'concurrent-change'/u);
  assert.match(main, /localChanged && !remoteChanged/u);
  assert.match(main, /!localChanged && remoteChanged/u);
});

test('linked local mutations autosave through the narrow durable service bridge', () => {
  assert.match(prepare, /onProjectChanged\(\{/u);
  assert.match(prepare, /openProjectById: projectId => openProject\(projectId\)/u);
  assert.match(controller, /getCommunityServiceDocumentState/u);
  assert.match(controller, /saveCommunityServiceDocument/u);
  assert.match(controller, /Saved locally\. This edit will synchronize/u);
  assert.match(preload, /community:serviceDocuments:save/u);
  assert.match(main, /HeritageServiceDocumentOutbox/u);
  assert.match(main, /community:serviceDocuments:flush/u);
});
