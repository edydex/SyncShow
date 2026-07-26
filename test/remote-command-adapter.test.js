'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  RemoteCommandAdapter,
  RemoteCommandError
} = require('../src/services/show');

function cue(index, text = `Cue ${index + 1}`) {
  return { index, text, thumbnailAvailable: true };
}

function createHarness({ readCueThumbnail } = {}) {
  const runtime = {
    hasActiveShow: true,
    phase: 'live',
    profileName: 'Main Sanctuary',
    currentSlide: 0,
    totalSlides: 3,
    currentCue: cue(0),
    nextCue: cue(1),
    cues: [cue(0), cue(1), cue(2)],
    outputs: [{
      id: 'front',
      name: 'Front Screen',
      renderer: 'slides',
      status: 'healthy',
      visible: true,
      displayId: 991,
      cachePath: '/private/should-not-leak'
    }],
    bible: { phase: 'idle', targetOutputIds: [] },
    permissions: { canOpenBiblePicker: false },
    secret: 'not-public'
  };

  const calls = [];
  const syncCues = () => {
    runtime.currentCue = cue(runtime.currentSlide);
    runtime.nextCue = runtime.currentSlide + 1 < runtime.totalSlides
      ? cue(runtime.currentSlide + 1)
      : null;
  };
  const adapter = new RemoteCommandAdapter({
    readRuntimeState: () => runtime,
    readCueThumbnail,
    createSessionId: () => 'session-1234567890abcdef',
    commands: {
      previous: () => {
        calls.push('previous');
        runtime.currentSlide -= 1;
        runtime.phase = 'live';
        syncCues();
      },
      next: () => {
        calls.push('next');
        runtime.currentSlide += 1;
        runtime.phase = 'live';
        syncCues();
      },
      jump: cueIndex => {
        calls.push(['jump', cueIndex]);
        runtime.currentSlide = cueIndex;
        runtime.phase = 'live';
        syncCues();
      },
      clear: () => {
        calls.push('clear');
        runtime.phase = 'cleared';
        runtime.bible = { phase: 'idle', targetOutputIds: [] };
      },
      restore: () => {
        calls.push('restore');
        runtime.phase = 'live';
        runtime.bible = { phase: 'idle', targetOutputIds: [] };
      }
    }
  });
  adapter.beginSession();
  return { adapter, runtime, calls, syncCues };
}

function envelope(state, command, extra = {}) {
  return {
    protocolVersion: 1,
    outputSessionId: state.outputSessionId,
    expectedRevision: state.revision,
    command,
    ...extra
  };
}

async function rejectsCode(promise, code) {
  await assert.rejects(promise, error => {
    assert.ok(error instanceof RemoteCommandError);
    assert.equal(error.code, code);
    return true;
  });
}

test('show state is revisioned, session-scoped, and strips local implementation details', async () => {
  const { adapter } = createHarness();
  const events = [];
  const unsubscribe = adapter.subscribe(event => events.push(event));
  const state = adapter.getState();

  assert.equal(state.protocolVersion, 1);
  assert.equal(state.revision, 1);
  assert.equal(state.outputSessionId, 'session-1234567890abcdef');
  assert.equal(state.phase, 'live');
  assert.equal(state.profileName, 'Main Sanctuary');
  assert.equal(state.totalCues, 3);
  assert.equal(Object.hasOwn(state, 'cues'), false);
  assert.deepEqual(state.currentCue, {
    id: 'cue-1',
    index: 0,
    number: 1,
    label: 'Cue 1',
    text: 'Cue 1',
    thumbnailAvailable: true
  });
  assert.equal(state.outputs[0].name, 'Front Screen');
  assert.equal(state.controls.canPrevious, false);
  assert.equal(state.controls.canNext, true);
  assert.deepEqual(state.permissions, { canOpenBiblePicker: false });

  const catalog = adapter.getCueCatalog(state.outputSessionId);
  assert.equal(catalog.length, 3);
  assert.equal(catalog[2].label, 'Cue 3');

  const serialized = JSON.stringify(state);
  assert.doesNotMatch(serialized, /displayId|cachePath|private\/should-not-leak|secret/);

  adapter.publish('test-change');
  await new Promise(resolve => queueMicrotask(resolve));
  assert.equal(events.length, 1);
  assert.equal(events[0].reason, 'test-change');
  assert.equal(events[0].state.revision, 2);
  unsubscribe();

  const ended = adapter.endSession();
  assert.equal(ended.phase, 'idle');
  assert.equal(ended.outputSessionId, null);
  assert.equal(ended.totalCues, 0);
  assert.deepEqual(ended.outputs, []);
});

test('native semantic cue ids survive the Remote boundary while unsafe ids fall back to position', () => {
  const { adapter, runtime } = createHarness();
  runtime.currentCue = { ...cue(0), id: 'cue-a0b1c2d3e4f5678901234567' };
  runtime.nextCue = { ...cue(1), id: '../private/path' };

  const state = adapter.getState();
  assert.equal(state.currentCue.id, 'cue-a0b1c2d3e4f5678901234567');
  assert.equal(state.nextCue.id, 'cue-2');
});

test('remote navigation requires the current session, revision, and cue expectation', async () => {
  const { adapter, calls } = createHarness();
  const initial = adapter.getState();

  await rejectsCode(adapter.execute({
    ...envelope(initial, { type: 'cue.next' }, { expectedCueIndex: 0 }),
    outputSessionId: 'session-old-123456789'
  }), 'STALE_OUTPUT_SESSION');

  const nextResult = await adapter.execute(
    envelope(initial, { type: 'cue.next' }, { expectedCueIndex: 0 })
  );
  assert.equal(nextResult.applied, true);
  assert.equal(nextResult.state.currentCue.index, 1);
  assert.equal(nextResult.state.revision, initial.revision + 1);
  assert.deepEqual(calls, ['next']);

  await rejectsCode(
    adapter.execute(envelope(initial, { type: 'cue.previous' }, { expectedCueIndex: 0 })),
    'STALE_SHOW_STATE'
  );

  const current = adapter.getState();
  await rejectsCode(
    adapter.execute(envelope(current, { type: 'cue.next' }, { expectedCueIndex: 0 })),
    'STALE_CURRENT_CUE'
  );

  const jump = await adapter.execute(envelope(current, { type: 'cue.jump', cueIndex: 2 }));
  assert.equal(jump.state.currentCue.index, 2);
  assert.deepEqual(calls.at(-1), ['jump', 2]);

  await rejectsCode(
    adapter.execute(envelope(jump.state, { type: 'cue.next' }, { expectedCueIndex: 2 })),
    'AT_LAST_CUE'
  );
});

test('Bible state blocks navigation while Clear and Restore remain authoritative', async () => {
  const { adapter, runtime, calls } = createHarness();
  runtime.bible = {
    phase: 'live',
    reference: 'John 3:16',
    translationId: 'BSB',
    targetOutputIds: ['front']
  };
  adapter.publish('bible-live');
  const bibleState = adapter.getState();

  assert.equal(bibleState.controls.canNext, false);
  assert.equal(bibleState.controls.canClear, true);
  await rejectsCode(
    adapter.execute(envelope(bibleState, { type: 'cue.next' }, { expectedCueIndex: 0 })),
    'BIBLE_OVERLAY_ACTIVE'
  );

  const cleared = await adapter.execute(envelope(bibleState, { type: 'output.clear' }));
  assert.equal(cleared.state.phase, 'cleared');
  assert.equal(cleared.state.bible.phase, 'idle');
  assert.equal(calls.at(-1), 'clear');

  const restored = await adapter.execute(envelope(cleared.state, { type: 'output.restore' }));
  assert.equal(restored.state.phase, 'live');
  assert.equal(calls.at(-1), 'restore');
});

test('an unavailable output pauses every Remote command until local recovery', async () => {
  const { adapter, runtime } = createHarness();
  runtime.outputs[0].status = 'unavailable';
  adapter.publish('output-unavailable');
  const state = adapter.getState();

  assert.equal(state.phase, 'interrupted');
  assert.deepEqual(state.controls, {
    canPrevious: false,
    canNext: false,
    canJump: false,
    canRestore: false,
    canClear: false
  });
  await rejectsCode(
    adapter.execute(envelope(state, { type: 'output.clear' })),
    'SHOW_NOT_CONTROLLABLE'
  );
});

test('hidden or malformed commands fail explicitly and forbidden admin actions never dispatch', async () => {
  const { adapter, runtime, calls } = createHarness();
  let state = adapter.getState();

  await rejectsCode(
    adapter.execute(envelope(state, { type: 'profile.save' })),
    'FORBIDDEN_REMOTE_COMMAND'
  );
  await rejectsCode(
    adapter.execute(envelope(state, { type: 'cue.jump', cueIndex: 99 })),
    'INVALID_CUE_INDEX'
  );
  await rejectsCode(
    adapter.execute({ ...envelope(state, { type: 'output.clear' }), injected: true }),
    'INVALID_REMOTE_COMMAND'
  );
  assert.deepEqual(calls, []);

  runtime.phase = 'locally-stopped';
  adapter.publish('stopped');
  state = adapter.getState();
  assert.equal(state.phase, 'hidden');
  await rejectsCode(
    adapter.execute(envelope(state, { type: 'output.restore' })),
    'SHOW_STOPPED_LOCALLY'
  );

  adapter.endSession();
  const idle = adapter.getState();
  await rejectsCode(
    adapter.execute({
      protocolVersion: 1,
      outputSessionId: 'session-1234567890abcdef',
      expectedRevision: idle.revision,
      command: { type: 'output.clear' }
    }),
    'NO_ACTIVE_SHOW'
  );
});

test('an output session replaced during an asynchronous command never reports success', async () => {
  const runtime = {
    hasActiveShow: true,
    phase: 'live',
    currentSlide: 0,
    totalSlides: 2,
    currentCue: cue(0),
    nextCue: cue(1),
    cues: [cue(0), cue(1)],
    outputs: [],
    bible: { phase: 'idle' }
  };
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const adapter = new RemoteCommandAdapter({
    readRuntimeState: () => runtime,
    createSessionId: () => 'session-async-123456789',
    commands: { next: () => gate }
  });
  const state = adapter.beginSession();
  const pending = adapter.execute(envelope(state, { type: 'cue.next' }, { expectedCueIndex: 0 }));

  runtime.hasActiveShow = false;
  adapter.endSession('replacement');
  release();
  await rejectsCode(pending, 'OUTPUT_SESSION_REPLACED');
});

test('cue thumbnails are session-scoped and rechecked after asynchronous reads', async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const calls = [];
  const { adapter, runtime } = createHarness({
    readCueThumbnail: async cueIndex => {
      calls.push(cueIndex);
      await gate;
      return Buffer.from([0xff, 0xd8, 0xff, cueIndex]);
    }
  });
  const state = adapter.getState();

  await rejectsCode(
    adapter.readCueThumbnail('session-old-123456789', 0),
    'STALE_OUTPUT_SESSION'
  );
  await rejectsCode(
    adapter.readCueThumbnail(state.outputSessionId, 99),
    'INVALID_CUE_INDEX'
  );
  assert.deepEqual(calls, []);

  const pending = adapter.readCueThumbnail(state.outputSessionId, 1);
  runtime.hasActiveShow = false;
  adapter.endSession('replacement');
  release();
  await rejectsCode(pending, 'OUTPUT_SESSION_REPLACED');
  assert.deepEqual(calls, [1]);
});
