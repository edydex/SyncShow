'use strict';

const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'src', 'renderer', 'index.html'), 'utf8');
const app = fs.readFileSync(path.join(root, 'src', 'renderer', 'app.js'), 'utf8');

test('Load separates native SyncShow services from the legacy PPTX workflow', () => {
  assert.match(html, /id="loadTabSyncShow"[\s\S]*SyncShow service/u);
  assert.match(html, /id="loadTabPptx"[\s\S]*Legacy PPTX files/u);
  assert.match(html, /id="loadSyncShowPanel"[\s\S]*Heritage Community[\s\S]*Import SyncShow file[\s\S]*Saved on this computer/u);
  assert.match(html, /id="loadPptxPanel"[\s\S]*one, two, three, or more files/u);
  assert.match(app, /function activateLoadMode\(mode/u);
  assert.match(app, /publishServiceProject\(\{[\s\S]*projectId: project\.id,[\s\S]*revisionId: project\.revisionId/u);
});

test('prepared service routing lives in tiered Screen Setup instead of the Load page', () => {
  assert.match(html, /id="settingsScreensPanel"[\s\S]*id="inputCardsHostScreens"/u);
  assert.match(html, /id="venueProfileDetails"[\s\S]*<strong>Venue defaults<\/strong>/u);
  assert.match(html, /id="technicalSettingsDetails"[\s\S]*<strong>Advanced Show behavior<\/strong>/u);
  assert.match(app, /const target = preparedService[\s\S]*elements\.inputCardsHostScreens[\s\S]*elements\.inputCardsHostLoad/u);
  assert.match(app, /createEditorField\('Physical screen', display\)[\s\S]*createEditorField\('Slideshow shown here', roleSelect\)/u);
  assert.match(app, /more\.className = 'output-row-more'/u);
});

test('choosing the legacy PPTX tab reveals file inputs even when a native service is loaded', () => {
  assert.match(app, /state\.workflowStage === 'load'[\s\S]*state\.loadMode === 'pptx'/u);
  assert.match(app, /preparedService && !loadingLegacyPptx/u);
  assert.match(app, /placeServiceInputCards\(\);[\s\S]*refreshLoadLocalServices/u);
});

test('generic reviewed-package filler is omitted while meaningful exceptions remain available', () => {
  assert.doesNotMatch(html, /No volunteer notes were recorded/u);
  assert.doesNotMatch(html, /All readiness checks passed without an exception/u);
  assert.match(html, /id="loadServiceReviewDetails"[\s\S]*Notes and readiness details/u);
  assert.match(app, /elements\.loadServiceReviewDetails\.hidden = !hasReviewDetails/u);
});
