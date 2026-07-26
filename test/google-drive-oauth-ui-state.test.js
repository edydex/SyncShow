'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  applyLifecycleState,
  createInitialState
} = require('../src/renderer/google-drive-oauth-state');

test('OAuth UI lifecycle accepts only newer main-process revisions', () => {
  const initial = createInitialState();
  const opened = applyLifecycleState(initial, { active: true, revision: 1 });
  assert.equal(opened.accepted, true);
  assert.equal(opened.becameActive, true);
  assert.deepEqual(opened.state, {
    active: true,
    revision: 1,
    actionBusy: false,
    actionMessage: ''
  });

  opened.state.actionMessage = 'Copied';
  const duplicate = applyLifecycleState(opened.state, { active: true, revision: 1 });
  const stale = applyLifecycleState(opened.state, { active: false, revision: 0 });
  assert.equal(duplicate.accepted, false);
  assert.equal(stale.accepted, false);
  assert.equal(duplicate.state, opened.state);
  assert.equal(duplicate.state.actionMessage, 'Copied');

  const closed = applyLifecycleState(opened.state, { active: false, revision: 2 });
  assert.equal(closed.accepted, true);
  assert.equal(closed.becameActive, false);
  assert.deepEqual(closed.state, {
    active: false,
    revision: 2,
    actionBusy: false,
    actionMessage: ''
  });
  assert.doesNotMatch(JSON.stringify(closed.state), /url|token|secret|verifier/i);
});
