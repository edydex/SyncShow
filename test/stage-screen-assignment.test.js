'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../src/renderer/app.js'), 'utf8');
const implementation = source.slice(source.indexOf('function handleProfileEditorInput(event)'), source.indexOf('function moveRecord('));

function changeDisplay({ display, mode = 'role', enabled = false, value = '2' } = {}) {
  const output = { id: 'stage', enabled, expectedRoleId: 'media', sourceRoleId: 'media', mode, renderer: 'slides' };
  let renders = 0, dirty = 0;
  const context = vm.createContext({
    state: { profileDraft: { outputs: [output], inputRoles: [] }, displays: display ? [display] : [] },
    renderProfileEditor: () => renders++, markProfileDirty: () => dirty++
  });
  vm.runInContext(implementation, context);
  const control = { dataset: { profileType: 'output', profileId: 'stage', field: 'display' }, value, closest() { return this; } };
  context.handleProfileEditorInput({ target: control });
  return { output, renders, dirty };
}

test('assigning an external Stage-Facing monitor explicitly enables its saved output', () => {
  const { output, renders, dirty } = changeDisplay({ display: { id: 2, fingerprint: 'stage-monitor', isControl: false } });
  assert.equal(output.enabled, true);
  assert.equal(output.legacyDisplayId, 2);
  assert.equal(output.displayFingerprint, 'stage-monitor');
  assert.equal(renders, 1);
  assert.equal(dirty, 1, 'Assignment remains a draft until the operator saves');
});

test('assigning a monitor reactivates an explicitly disabled direct stage route', () => {
  const { output } = changeDisplay({ display: { id: 2, isControl: false }, mode: 'disabled' });
  assert.equal(output.enabled, true);
  assert.equal(output.mode, 'role');
  assert.equal(output.sourceRoleId, 'media');
  assert.equal(output.sourceOutputId, null);
});

test('unavailable or operator displays never auto-enable Stage-Facing', () => {
  assert.equal(changeDisplay().output.enabled, false);
  assert.equal(changeDisplay({ display: { id: 2, isControl: true } }).output.enabled, false);
});

test('clearing a display does not silently disable an active output', () => {
  const { output } = changeDisplay({ value: '', enabled: true });
  assert.equal(output.enabled, true);
  assert.equal(output.legacyDisplayId, null);
});

test('Live Output uses an in-app disclosure with keyboard isolation and actual click coverage', () => {
  const html = fs.readFileSync(path.join(__dirname, '../src/renderer/index.html'), 'utf8');
  const fixture = fs.readFileSync(path.join(__dirname, '../scripts/fixtures/live-cue-navigation-electron-app.js'), 'utf8');
  assert.match(html, /<details id="outputPreviewPicker"/);
  assert.match(html, /<select id="outputPreviewSelect"[^>]* hidden/);
  assert.match(source, /outputPreviewPicker.addEventListener\('keydown'[\s\S]*?event.stopPropagation\(\)/);
  assert.match(fixture, /sendInputEvent\(\{ type: 'mouseDown'/);
  assert.match(fixture, /const liveOutputPicker = await verifyLiveOutputPicker\(control\)/);
});
