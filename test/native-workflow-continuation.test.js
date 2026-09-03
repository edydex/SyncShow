'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const {
  resolveNativeWorkflowContinuation
} = require('../src/renderer/native-workflow-continuation');

const MODULE_PATH = path.resolve(
  __dirname,
  '../src/renderer/native-workflow-continuation.js'
);
const PROJECT_ID = 'service-2026-08-16';
const PROJECT_REVISION = 7;
const REVISION_ID = 'a'.repeat(64);

function context(overrides = {}) {
  return {
    projectId: PROJECT_ID,
    projectRevision: PROJECT_REVISION,
    revisionId: REVISION_ID,
    planningStatus: 'planning',
    readinessReady: false,
    primaryReadinessAction: null,
    ...overrides
  };
}

function readinessAction(overrides = {}) {
  return {
    checkId: 'song-present',
    label: 'Communal singing',
    actionLabel: 'Open Song Library',
    targetKind: 'song-library',
    projectId: PROJECT_ID,
    projectRevision: PROJECT_REVISION,
    revisionId: REVISION_ID,
    detail: 'Choose a saved song and add it to this service.',
    ...overrides
  };
}

function plain(value) {
  return value === null ? null : JSON.parse(JSON.stringify(value));
}

test('a matching readiness blocker remains the first revision-bound continuation', () => {
  const result = resolveNativeWorkflowContinuation(context({
    primaryReadinessAction: readinessAction()
  }));

  assert.deepEqual(plain(result), {
    kind: 'readiness-blocker',
    label: 'Continue setup · Open Song Library',
    help: 'Choose a saved song and add it to this service. Opening this step does not create content, waive a check, mark Ready, or prepare Load.',
    projectId: PROJECT_ID,
    projectRevision: PROJECT_REVISION,
    revisionId: REVISION_ID,
    readinessAction: readinessAction()
  });
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.readinessAction), true);
  assert.throws(() => {
    result.label = 'Changed';
  }, TypeError);
  assert.throws(() => {
    result.readinessAction.actionLabel = 'Changed';
  }, TypeError);
});

test('checks-clear Planning and exact Ready revisions expose separate human actions', () => {
  const review = resolveNativeWorkflowContinuation(context({
    readinessReady: true
  }));
  assert.deepEqual(plain(review), {
    kind: 'review-ready',
    label: 'Review & mark Ready',
    help: 'Review this exact saved service order and every stated exception. Nothing is marked Ready until a person confirms the review.',
    projectId: PROJECT_ID,
    projectRevision: PROJECT_REVISION,
    revisionId: REVISION_ID
  });
  assert.equal(Object.isFrozen(review), true);

  const publish = resolveNativeWorkflowContinuation(context({
    planningStatus: 'ready',
    readinessReady: true
  }));
  assert.deepEqual(plain(publish), {
    kind: 'publish-load',
    label: 'Save & go to Load',
    help: 'Build and install Load from this exact Ready revision. This does not start Show or publish anything to Community.',
    projectId: PROJECT_ID,
    projectRevision: PROJECT_REVISION,
    revisionId: REVISION_ID
  });
  assert.equal(Object.isFrozen(publish), true);
});

test('valid contexts with no safe next action fail closed with null', () => {
  assert.equal(resolveNativeWorkflowContinuation(context()), null);
  assert.equal(resolveNativeWorkflowContinuation(context({
    planningStatus: 'ready',
    readinessReady: false
  })), null);
  assert.equal(resolveNativeWorkflowContinuation(context({
    planningStatus: 'completed',
    readinessReady: true
  })), null);
  assert.equal(resolveNativeWorkflowContinuation(context({
    planningStatus: 'needs-follow-up',
    readinessReady: true
  })), null);
  for (const planningStatus of ['completed', 'needs-follow-up']) {
    assert.equal(resolveNativeWorkflowContinuation(context({
      planningStatus,
      readinessReady: false,
      primaryReadinessAction: readinessAction()
    })), null);
  }
});

test('malformed current context is rejected before any continuation is returned', () => {
  for (const candidate of [
    null,
    [],
    context({ projectId: 'bad project!' }),
    context({ projectId: '__proto__' }),
    context({ projectRevision: -1 }),
    context({ projectRevision: 1.5 }),
    context({ projectRevision: Number.MAX_SAFE_INTEGER + 1 }),
    context({ revisionId: 'A'.repeat(64) }),
    context({ revisionId: 'a'.repeat(63) }),
    context({ planningStatus: 'draft' }),
    context({ readinessReady: 1 }),
    context({ primaryReadinessAction: undefined }),
    context({
      readinessReady: true,
      primaryReadinessAction: readinessAction()
    })
  ]) {
    assert.throws(() => resolveNativeWorkflowContinuation(candidate));
  }

  const missing = context();
  delete missing.revisionId;
  assert.throws(() => resolveNativeWorkflowContinuation(missing));

  const extra = context();
  extra.publish = true;
  assert.throws(() => resolveNativeWorkflowContinuation(extra));
});

test('stale, malformed, or widened readiness actions are rejected', () => {
  for (const action of [
    readinessAction({ projectId: 'another-service' }),
    readinessAction({ projectRevision: PROJECT_REVISION + 1 }),
    readinessAction({ revisionId: 'b'.repeat(64) }),
    readinessAction({ checkId: 'bad check!' }),
    readinessAction({ targetKind: 'bad target!' }),
    readinessAction({ actionLabel: ' Open Song Library' }),
    readinessAction({ detail: 'Unsafe\u0000detail' }),
    'song-present',
    []
  ]) {
    assert.throws(() => resolveNativeWorkflowContinuation(context({
      primaryReadinessAction: action
    })));
  }

  const widened = readinessAction();
  widened.onClick = 'publish';
  assert.throws(() => resolveNativeWorkflowContinuation(context({
    primaryReadinessAction: widened
  })));
});

test('the browser contract is frozen and has no runtime or mutation authority', () => {
  const source = fs.readFileSync(MODULE_PATH, 'utf8');
  const browserContext = vm.createContext({});
  vm.runInContext(source, browserContext, {
    filename: 'native-workflow-continuation.js'
  });

  const browserContract = browserContext.SyncShowNativeWorkflowContinuation;
  assert.ok(browserContract);
  assert.equal(Object.isFrozen(browserContract), true);
  assert.deepEqual(
    plain(browserContract.resolveNativeWorkflowContinuation(context({
      planningStatus: 'ready',
      readinessReady: true
    }))),
    plain(resolveNativeWorkflowContinuation(context({
      planningStatus: 'ready',
      readinessReady: true
    })))
  );
  assert.doesNotMatch(
    source,
    /window\.api|ipcRenderer|ipcMain|fetch\s*\(|XMLHttpRequest|WebSocket|mutateProject|publishServiceProject|setServicePlanningStatus/
  );
});
