'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  DEFAULT_LIVE_CUE_TRANSITION_TIMEOUT_MS,
  LIVE_CUE_TRANSITION_KIND,
  LIVE_CUE_TRANSITION_RECEIPT_KIND,
  MAX_LIVE_CUE_TRANSITION_OUTPUTS,
  MAX_LIVE_CUE_TRANSITION_TIMEOUT_MS,
  LiveCueTransitionCoordinator,
  LiveCueTransitionError
} = require('../src/services/show/LiveCueTransitionCoordinator');

function fakeRuntime(initialNow = 1_000) {
  let now = initialNow;
  let nextTimerId = 1;
  const timers = new Map();

  return {
    clock: () => now,
    setTimer(callback, delay) {
      const id = nextTimerId;
      nextTimerId += 1;
      timers.set(id, { callback, dueAt: now + delay });
      return id;
    },
    clearTimer(id) {
      timers.delete(id);
    },
    advance(milliseconds) {
      now += milliseconds;
      while (true) {
        const due = [...timers.entries()]
          .filter(([, timer]) => timer.dueAt <= now)
          .sort((left, right) => (
            left[1].dueAt - right[1].dueAt
            || left[0] - right[0]
          ));
        if (due.length === 0) break;
        const [id, timer] = due[0];
        timers.delete(id);
        timer.callback();
      }
    },
    setNow(value) {
      now = value;
    },
    timerCount: () => timers.size
  };
}

function coordinator(runtime, timeoutMs = 250) {
  return new LiveCueTransitionCoordinator({
    timeoutMs,
    clock: runtime.clock,
    setTimer: runtime.setTimer,
    clearTimer: runtime.clearTimer
  });
}

function beginRequest(overrides = {}) {
  const front = {};
  const singer = {};
  return {
    request: {
      sessionId: 17,
      fromCueIndex: 3,
      toCueIndex: 4,
      outputs: [
        { outputId: 'front-projector', sender: front },
        { outputId: 'singers-monitor', sender: singer }
      ],
      ...overrides
    },
    front,
    singer
  };
}

function assertTransitionError(error, code) {
  assert.ok(error instanceof LiveCueTransitionError);
  assert.equal(error.code, code);
  return true;
}

test('an exact all-output acknowledgement resolves one immutable receipt', async () => {
  const runtime = fakeRuntime(10_000);
  const transitions = coordinator(runtime, 500);
  const { request, front, singer } = beginRequest();
  const { transition, promise } = transitions.begin(request);

  assert.equal(transitions.isPending(), true);
  assert.equal(runtime.timerCount(), 1);
  assert.equal(Object.isFrozen(transition), true);
  assert.equal(Object.isFrozen(transition.outputIds), true);
  assert.deepEqual(transition, {
    schemaVersion: 1,
    kind: LIVE_CUE_TRANSITION_KIND,
    sessionId: 17,
    fromCueIndex: 3,
    toCueIndex: 4,
    outputIds: ['front-projector', 'singers-monitor'],
    startedAt: 10_000,
    deadlineAt: 10_500
  });
  assert.deepEqual(transitions.read(), {
    ...transition,
    pendingOutputIds: ['front-projector', 'singers-monitor'],
    acknowledgedOutputIds: []
  });
  assert.equal(Object.isFrozen(transitions.read()), true);
  assert.equal(Object.isFrozen(transitions.read().pendingOutputIds), true);

  assert.equal(transitions.acknowledge({
    sender: {}, sessionId: 17, cueIndex: 4, ok: true
  }), false);
  assert.equal(transitions.acknowledge({
    sender: front, sessionId: 18, cueIndex: 4, ok: true
  }), false);
  assert.equal(transitions.acknowledge({
    sender: front, sessionId: 17, cueIndex: 5, ok: true
  }), false);
  assert.equal(transitions.acknowledge({
    sender: front, sessionId: 17, cueIndex: 4, ok: 'yes'
  }), false);

  runtime.advance(25);
  assert.equal(transitions.acknowledge({
    sender: front, sessionId: 17, cueIndex: 4, ok: true
  }), true);
  assert.equal(transitions.acknowledge({
    sender: front, sessionId: 17, cueIndex: 4, ok: true
  }), false, 'one output cannot acknowledge twice');
  assert.deepEqual(transitions.read().pendingOutputIds, ['singers-monitor']);
  assert.deepEqual(transitions.read().acknowledgedOutputIds, ['front-projector']);

  runtime.advance(10);
  assert.equal(transitions.acknowledge({
    sender: singer, sessionId: 17, cueIndex: 4, ok: true
  }), true);
  const receipt = await promise;

  assert.deepEqual(receipt, {
    schemaVersion: 1,
    kind: LIVE_CUE_TRANSITION_RECEIPT_KIND,
    sessionId: 17,
    fromCueIndex: 3,
    toCueIndex: 4,
    outputIds: ['front-projector', 'singers-monitor'],
    startedAt: 10_000,
    completedAt: 10_035
  });
  assert.equal(Object.isFrozen(receipt), true);
  assert.equal(Object.isFrozen(receipt.outputIds), true);
  assert.equal(transitions.isPending(), false);
  assert.equal(transitions.read(), null);
  assert.equal(runtime.timerCount(), 0);
  assert.equal(transitions.acknowledge({
    sender: singer, sessionId: 17, cueIndex: 4, ok: true
  }), false, 'late acknowledgements are inert');
});

test('an exact same-cue refresh waits for every output without weakening navigation validation', async () => {
  const runtime = fakeRuntime(20_000);
  const transitions = coordinator(runtime, 500);
  const { request, front, singer } = beginRequest();
  const { transition, promise } = transitions.beginRefresh({
    sessionId: request.sessionId,
    cueIndex: request.fromCueIndex,
    outputs: request.outputs
  });

  assert.deepEqual(transition, {
    schemaVersion: 1,
    kind: LIVE_CUE_TRANSITION_KIND,
    sessionId: 17,
    fromCueIndex: 3,
    toCueIndex: 3,
    outputIds: ['front-projector', 'singers-monitor'],
    startedAt: 20_000,
    deadlineAt: 20_500
  });
  assert.equal(transitions.acknowledge({
    sender: front, sessionId: 17, cueIndex: 3, ok: true
  }), true);
  await Promise.resolve();
  assert.equal(transitions.isPending(), true);
  assert.equal(transitions.acknowledge({
    sender: singer, sessionId: 17, cueIndex: 3, ok: true
  }), true);

  assert.deepEqual(await promise, {
    schemaVersion: 1,
    kind: LIVE_CUE_TRANSITION_RECEIPT_KIND,
    sessionId: 17,
    fromCueIndex: 3,
    toCueIndex: 3,
    outputIds: ['front-projector', 'singers-monitor'],
    startedAt: 20_000,
    completedAt: 20_000
  });
  assert.throws(
    () => transitions.begin({
      ...request,
      toCueIndex: request.fromCueIndex
    }),
    error => assertTransitionError(error, 'INVALID_LIVE_CUE_TRANSITION')
  );
  assert.throws(
    () => transitions.beginRefresh({
      sessionId: 17,
      cueIndex: 3,
      outputs: request.outputs,
      unsupported: true
    }),
    error => assertTransitionError(error, 'INVALID_LIVE_CUE_TRANSITION')
  );
});

test('an overlapping begin is rejected without replacing the active transition', async () => {
  const runtime = fakeRuntime();
  const transitions = coordinator(runtime);
  const first = beginRequest();
  const active = transitions.begin(first.request);

  assert.throws(
    () => transitions.begin(beginRequest({
      sessionId: 18,
      fromCueIndex: 4,
      toCueIndex: 5
    }).request),
    error => assertTransitionError(error, 'LIVE_CUE_TRANSITION_BUSY')
  );
  assert.equal(transitions.read().sessionId, 17);
  assert.equal(transitions.read().toCueIndex, 4);

  const rejected = assert.rejects(
    active.promise,
    error => assertTransitionError(error, 'TEST_CANCELLED')
  );
  assert.equal(transitions.cancel('Test finished.', 'TEST_CANCELLED'), true);
  await rejected;
  assert.equal(runtime.timerCount(), 0);
});

test('begin validates session, cue, output count, IDs, and sender uniqueness', () => {
  const runtime = fakeRuntime();
  const transitions = coordinator(runtime);
  const base = beginRequest();

  for (const request of [
    { ...base.request, sessionId: -1 },
    { ...base.request, sessionId: Number.MAX_SAFE_INTEGER + 1 },
    { ...base.request, fromCueIndex: -1 },
    { ...base.request, toCueIndex: 3 },
    { ...base.request, outputs: [] },
    {
      ...base.request,
      outputs: Array.from(
        { length: MAX_LIVE_CUE_TRANSITION_OUTPUTS + 1 },
        (_value, index) => ({ outputId: `output-${index}`, sender: {} })
      )
    },
    {
      ...base.request,
      outputs: [{ outputId: '../unsafe', sender: {} }]
    },
    {
      ...base.request,
      outputs: [{ outputId: 'constructor', sender: {} }]
    },
    {
      ...base.request,
      outputs: [
        { outputId: 'front', sender: {} },
        { outputId: 'front', sender: {} }
      ]
    },
    {
      ...base.request,
      outputs: [
        { outputId: 'front', sender: base.front },
        { outputId: 'singer', sender: base.front }
      ]
    },
    {
      ...base.request,
      outputs: [{ outputId: 'front', sender: null }]
    },
    { ...base.request, unsupported: true }
  ]) {
    assert.throws(
      () => transitions.begin(request),
      error => error instanceof LiveCueTransitionError
        && (
          error.code === 'INVALID_LIVE_CUE_TRANSITION'
          || error.code === 'DUPLICATE_LIVE_CUE_OUTPUT'
          || error.code === 'DUPLICATE_LIVE_CUE_OUTPUT_SENDER'
        )
    );
    assert.equal(transitions.isPending(), false);
  }
});

test('constructor enforces a bounded timeout and injectable functions', () => {
  assert.equal(DEFAULT_LIVE_CUE_TRANSITION_TIMEOUT_MS, 15_000);
  assert.equal(MAX_LIVE_CUE_TRANSITION_TIMEOUT_MS, 60_000);

  for (const timeoutMs of [
    0,
    -1,
    1.5,
    MAX_LIVE_CUE_TRANSITION_TIMEOUT_MS + 1
  ]) {
    assert.throws(
      () => new LiveCueTransitionCoordinator({ timeoutMs }),
      error => assertTransitionError(
        error,
        'INVALID_LIVE_CUE_TRANSITION_TIMEOUT'
      )
    );
  }
  assert.throws(
    () => new LiveCueTransitionCoordinator({ clock: null }),
    /clock must be a function/
  );
  assert.throws(
    () => new LiveCueTransitionCoordinator({ setTimer: null }),
    /timers must be functions/
  );
  assert.throws(
    () => new LiveCueTransitionCoordinator({ clearTimer: null }),
    /timers must be functions/
  );
});

test('an exact negative frame acknowledgement rejects and clears immediately', async () => {
  const runtime = fakeRuntime();
  const transitions = coordinator(runtime);
  const { request, front, singer } = beginRequest();
  const { promise } = transitions.begin(request);
  const rejected = assert.rejects(promise, error => {
    assertTransitionError(error, 'LIVE_CUE_OUTPUT_REJECTED');
    assert.equal(error.message, 'Bundled font did not load');
    assert.deepEqual(error.details, {
      sessionId: 17,
      outputId: 'singers-monitor',
      cueIndex: 4
    });
    return true;
  });

  assert.equal(transitions.acknowledge({
    sender: {}, sessionId: 17, cueIndex: 4, ok: false
  }), false);
  assert.equal(transitions.acknowledge({
    sender: front, sessionId: 99, cueIndex: 4, ok: false
  }), false);
  assert.equal(transitions.acknowledge({
    sender: singer,
    sessionId: 17,
    cueIndex: 4,
    ok: false,
    error: '  Bundled   font\n did not load  '
  }), true);

  await rejected;
  assert.equal(transitions.isPending(), false);
  assert.equal(runtime.timerCount(), 0);
  assert.equal(transitions.acknowledge({
    sender: front, sessionId: 17, cueIndex: 4, ok: true
  }), false);
});

test('an exact output failure rejects even after that output acknowledged', async () => {
  const runtime = fakeRuntime();
  const transitions = coordinator(runtime);
  const { request, front } = beginRequest();
  const { promise } = transitions.begin(request);

  assert.equal(transitions.acknowledge({
    sender: front, sessionId: 17, cueIndex: 4, ok: true
  }), true);
  assert.equal(transitions.outputFailed({
    sessionId: 17,
    outputId: 'front-projector',
    sender: {},
    code: 'OUTPUT_CLOSED',
    reason: 'Wrong sender'
  }), false);
  assert.equal(transitions.outputFailed({
    sessionId: 16,
    outputId: 'front-projector',
    sender: front,
    code: 'OUTPUT_CLOSED',
    reason: 'Wrong session'
  }), false);

  const rejected = assert.rejects(promise, error => {
    assertTransitionError(error, 'OUTPUT_CLOSED');
    assert.equal(error.message, 'Front projector closed during transition.');
    assert.deepEqual(error.details, {
      sessionId: 17,
      outputId: 'front-projector',
      cueIndex: 4
    });
    return true;
  });
  assert.equal(transitions.outputFailed({
    sessionId: 17,
    outputId: 'front-projector',
    sender: front,
    code: 'OUTPUT_CLOSED',
    reason: 'Front projector closed during transition.'
  }), true);
  await rejected;
  assert.equal(runtime.timerCount(), 0);
});

test('cancel rejects with bounded explicit reason and code, then becomes idempotent', async () => {
  const runtime = fakeRuntime();
  const transitions = coordinator(runtime);
  const { promise } = transitions.begin(beginRequest().request);
  const rejected = assert.rejects(promise, error => {
    assertTransitionError(error, 'OUTPUTS_CLEARED');
    assert.equal(error.message, 'Emergency Clear preempted the cue transition.');
    assert.deepEqual(error.details, {
      sessionId: 17,
      fromCueIndex: 3,
      toCueIndex: 4
    });
    return true;
  });

  assert.equal(transitions.cancel(
    ' Emergency   Clear\npreempted the cue transition. ',
    'OUTPUTS_CLEARED'
  ), true);
  assert.equal(transitions.cancel('Already settled.', 'TEST_CANCELLED'), false);
  await rejected;
  assert.equal(transitions.read(), null);
  assert.equal(runtime.timerCount(), 0);
});

test('timeout reports only pending outputs, rejects once, and clears its timer', async () => {
  const runtime = fakeRuntime(2_000);
  const transitions = coordinator(runtime, 50);
  const { request, front, singer } = beginRequest();
  const { promise } = transitions.begin(request);

  runtime.advance(20);
  assert.equal(transitions.acknowledge({
    sender: front, sessionId: 17, cueIndex: 4, ok: true
  }), true);
  const rejected = assert.rejects(promise, error => {
    assertTransitionError(error, 'LIVE_CUE_TRANSITION_TIMEOUT');
    assert.deepEqual(error.details, {
      sessionId: 17,
      fromCueIndex: 3,
      toCueIndex: 4,
      pendingOutputIds: ['singers-monitor']
    });
    assert.equal(Object.isFrozen(error.details.pendingOutputIds), true);
    return true;
  });

  runtime.advance(30);
  await rejected;
  assert.equal(transitions.isPending(), false);
  assert.equal(runtime.timerCount(), 0);
  assert.equal(transitions.acknowledge({
    sender: singer, sessionId: 17, cueIndex: 4, ok: true
  }), false);
  runtime.advance(1_000);
  assert.equal(runtime.timerCount(), 0);
});

test('invalid clock state rejects the promise without leaving a pending transition', async () => {
  const runtime = fakeRuntime(100);
  const transitions = coordinator(runtime);
  const { request, front, singer } = beginRequest();
  const { promise } = transitions.begin(request);

  assert.equal(transitions.acknowledge({
    sender: front, sessionId: 17, cueIndex: 4, ok: true
  }), true);
  runtime.setNow(Number.NaN);
  const rejected = assert.rejects(
    promise,
    error => assertTransitionError(error, 'INVALID_LIVE_CUE_TRANSITION_TIME')
  );
  assert.equal(transitions.acknowledge({
    sender: singer, sessionId: 17, cueIndex: 4, ok: true
  }), true);
  await rejected;
  assert.equal(transitions.isPending(), false);
  assert.equal(runtime.timerCount(), 0);
});
