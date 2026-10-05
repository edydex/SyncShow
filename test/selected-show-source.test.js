'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { assertSelectedShowSource } = require('../src/services/show/SelectedShowSource');
const revision = 'a'.repeat(64);
const request = { sourceMode: 'syncshow', expectedProjectId: 'today', expectedRevisionId: revision };
const prepared = { binding: { projectId: 'today', projectRevisionId: revision } };
const native = { outputs: [{ renderer: 'native-cue' }] };
const legacy = { outputs: [{ renderer: 'slides' }] };

test('native Start and Test Output cannot silently use an old deck or another service revision', () => {
  for (const testOutput of [false, true]) {
    for (const actual of [null, { binding: { ...prepared.binding, projectId: 'last-week' } },
      { binding: { ...prepared.binding, projectRevisionId: 'b'.repeat(64) } }]) {
      assert.throws(() => assertSelectedShowSource({ ...request, testOutput }, actual, native),
        { code: 'SELECTED_SERVICE_NOT_LOADED' });
    }
    assert.throws(() => assertSelectedShowSource({ ...request, testOutput }, prepared, legacy),
      { code: 'SELECTED_SERVICE_NOT_LOADED' });
  }
  assert.doesNotThrow(() => assertSelectedShowSource(request, prepared, native));
});

test('an explicit legacy choice accepts PowerPoints and cannot accidentally start a native service', () => {
  assert.doesNotThrow(() => assertSelectedShowSource({ sourceMode: 'pptx' }, null, legacy));
  assert.throws(() => assertSelectedShowSource({ sourceMode: 'pptx' }, prepared, native),
    { code: 'SELECTED_POWERPOINT_NOT_LOADED' });
  assert.throws(() => assertSelectedShowSource({ sourceMode: 'other' }, null, legacy),
    { code: 'INVALID_SHOW_SOURCE' });
});

test('main checks the selected source after package verification and before touching output windows', () => {
  const main = fs.readFileSync(require.resolve('../main.js'), 'utf8');
  const start = main.indexOf("ipcMain.handle('display:start'");
  const handler = main.slice(start, main.indexOf("ipcMain.handle(", start + 1));
  assert.ok(handler.indexOf('assertSelectedShowSource(options, preparedService, launchPlan)') > handler.indexOf('await verifyCurrentPreparedServiceForStart()'));
  assert.ok(handler.indexOf('assertSelectedShowSource(options, preparedService, launchPlan)') < handler.indexOf('await capturePowerPointServiceSetCandidate(launchPlan)'));
});
