'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { OutputHealthTracker } = require('../src/services/show');

function identity(outputId, sessionId, sender) {
  return { outputId, sessionId, sender };
}

test('an output stays starting until its exact sender, session, and cue reports success', () => {
  const changes = [];
  const tracker = new OutputHealthTracker({ onChange: change => changes.push(change) });
  const sender = {};
  const otherSender = {};
  const output = identity('front', 17, sender);

  tracker.register(output);
  assert.equal(tracker.read('front', 17, sender).status, 'starting');
  assert.equal(tracker.expectFrame({ ...output, cueIndex: 4 }), true);

  assert.equal(tracker.acknowledge({ sender: otherSender, sessionId: 17, cueIndex: 4, ok: true }), false);
  assert.equal(tracker.acknowledge({ sender, sessionId: 16, cueIndex: 4, ok: true }), false);
  assert.equal(tracker.acknowledge({ sender, sessionId: 17, cueIndex: 3, ok: true }), false);
  assert.equal(tracker.acknowledge({ sender, sessionId: 17, cueIndex: 4, ok: undefined }), false);
  assert.equal(tracker.read('front', 17, sender).status, 'starting');

  assert.equal(tracker.acknowledge({ sender, sessionId: 17, cueIndex: 4, ok: true }), true);
  assert.equal(tracker.read('front', 17, sender).status, 'healthy');
  assert.deepEqual(changes.map(change => change.reason), ['frame-ready']);
});

test('new frames, failures, and renderer responsiveness conservatively update health', () => {
  const tracker = new OutputHealthTracker();
  const sender = {};
  const output = identity('singer', 22, sender);
  tracker.register(output);
  tracker.expectFrame({ ...output, cueIndex: 0 });
  tracker.acknowledge({ sender, sessionId: 22, cueIndex: 0, ok: true });
  assert.equal(tracker.read('singer', 22).status, 'healthy');

  tracker.expectFrame({ ...output, cueIndex: 1 });
  assert.equal(tracker.read('singer', 22).status, 'starting');
  tracker.acknowledge({ sender, sessionId: 22, cueIndex: 1, ok: false });
  assert.equal(tracker.read('singer', 22).status, 'unavailable');

  tracker.expectFrame({ ...output, cueIndex: 2 });
  tracker.acknowledge({ sender, sessionId: 22, cueIndex: 2, ok: true });
  assert.equal(tracker.read('singer', 22).status, 'healthy');
  tracker.markUnresponsive(output);
  assert.equal(tracker.read('singer', 22).status, 'unavailable');
  tracker.markResponsive(output);
  assert.equal(tracker.read('singer', 22).status, 'healthy');

  tracker.markProcessGone(output);
  assert.equal(tracker.read('singer', 22).status, 'unavailable');
  assert.equal(tracker.markResponsive(output), false);
  assert.equal(tracker.expectFrame({ ...output, cueIndex: 3 }), false);
});

test('authoritative Clear cancels a pending frame without reviving a failed output', () => {
  const tracker = new OutputHealthTracker();
  const sender = {};
  const output = identity('front', 24, sender);
  tracker.register(output);
  tracker.expectFrame({ ...output, cueIndex: 0 });
  tracker.acknowledge({ sender, sessionId: 24, cueIndex: 0, ok: true });

  tracker.expectFrame({ ...output, cueIndex: 1 });
  assert.equal(tracker.read('front', 24, sender).status, 'starting');
  assert.equal(tracker.markCleared(output), true);
  assert.deepEqual(tracker.read('front', 24, sender), {
    status: 'healthy',
    expectedCueIndex: null
  });
  assert.equal(
    tracker.acknowledge({ sender, sessionId: 24, cueIndex: 1, ok: true }),
    false,
    'a late pre-Clear cue cannot become authoritative'
  );

  tracker.expectFrame({ ...output, cueIndex: 2 });
  tracker.acknowledge({ sender, sessionId: 24, cueIndex: 2, ok: false });
  assert.equal(tracker.markCleared(output), false);
  assert.equal(tracker.read('front', 24, sender).status, 'unavailable');
});

test('the ledger is bounded and clearing it invalidates late senders', () => {
  const tracker = new OutputHealthTracker({ maximumEntries: 2 });
  const firstSender = {};
  tracker.register(identity('one', 5, firstSender));
  tracker.register(identity('two', 5, {}));
  tracker.register(identity('three', 5, {}));

  assert.equal(tracker.read('one', 5), null);
  assert.equal(tracker.read('two', 5).status, 'starting');
  assert.equal(tracker.read('three', 5).status, 'starting');

  tracker.clear();
  assert.equal(tracker.read('two', 5), null);
  assert.equal(tracker.acknowledge({
    sender: firstSender,
    sessionId: 5,
    cueIndex: 0,
    ok: true
  }), false);
});
