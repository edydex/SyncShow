'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');

const {
  CommandSequencer,
  NetworkBindingCatalog,
  RemoteAuthority,
  RemoteProtocolError,
  SlidingWindowRateLimiter,
  commandFingerprint,
  isPrivateIpv4,
  normalizePeerAddress,
  parseCommandEnvelope,
  parsePairRequest,
  sanitizeCueCatalog,
  sanitizeRemoteState
} = require('../src/services/remote');

const SESSION_ID = '4c480506-4436-4e72-90d2-6e3fca88e775';

function commandEnvelope(overrides = {}) {
  return {
    version: 1,
    outputSessionId: SESSION_ID,
    sequence: 1,
    commandId: '00000000-0000-4000-8000-000000000001',
    expectedRevision: 7,
    expectedCueIndex: 3,
    command: { type: 'cue.next' },
    ...overrides
  };
}

function state(overrides = {}) {
  const cues = [0, 1, 2].map(index => ({
    id: `cue-${index + 1}`,
    index,
    number: index + 1,
    text: `Cue ${index + 1}`,
    thumbnailAvailable: index === 0
  }));
  return {
    protocolVersion: 1,
    revision: 7,
    outputSessionId: SESSION_ID,
    phase: 'live',
    profileName: 'Main Sanctuary',
    currentCue: cues[0],
    nextCue: cues[1],
    totalCues: cues.length,
    cues,
    outputs: [{
      id: 'main',
      name: 'Main Screen',
      renderer: 'slides',
      status: 'healthy',
      visible: true
    }],
    bible: { phase: 'idle', reference: '', translationId: '', targetOutputIds: [] },
    controls: {
      canPrevious: false,
      canNext: true,
      canJump: true,
      canRestore: true,
      canClear: true
    },
    permissions: { canOpenBiblePicker: false },
    ...overrides
  };
}

function expectProtocolError(code, callback) {
  assert.throws(callback, error => {
    assert.ok(error instanceof RemoteProtocolError);
    assert.equal(error.code, code);
    return true;
  });
}

test('pair protocol validates deviceName type before trimming and accepts one credential only', () => {
  expectProtocolError('INVALID_FIELD', () => parsePairRequest({
    version: 1,
    deviceName: null,
    code: '123456'
  }));
  expectProtocolError('INVALID_PAIR_CREDENTIAL', () => parsePairRequest({
    version: 1,
    deviceName: 'Phone',
    code: '123456',
    ticket: 'A'.repeat(43)
  }));
  expectProtocolError('UNKNOWN_FIELD', () => parsePairRequest({
    version: 1,
    deviceName: 'Phone',
    code: '123456',
    admin: true
  }));

  assert.deepEqual(parsePairRequest({
    version: 1,
    deviceName: '  Booth iPad  ',
    ticket: 'A'.repeat(43)
  }), {
    version: 1,
    deviceName: 'Booth iPad',
    ticket: 'A'.repeat(43)
  });
});

test('command protocol is a strict allow-list with sequence, command ID, and cue guard', () => {
  const parsed = parseCommandEnvelope(commandEnvelope());
  assert.equal(parsed.command.type, 'cue.next');
  assert.equal(parsed.expectedCueIndex, 3);

  expectProtocolError('INVALID_FIELD', () => parseCommandEnvelope(commandEnvelope({
    expectedCueIndex: null
  })));
  expectProtocolError('COMMAND_NOT_ALLOWED', () => parseCommandEnvelope(commandEnvelope({
    command: { type: 'app.quit' }
  })));
  expectProtocolError('UNKNOWN_FIELD', () => parseCommandEnvelope(commandEnvelope({
    command: { type: 'output.clear', filePath: '/tmp/private' },
    expectedCueIndex: null
  })));
  expectProtocolError('INVALID_FIELD', () => parseCommandEnvelope(commandEnvelope({
    commandId: 'predictable'
  })));

  const clear = parseCommandEnvelope(commandEnvelope({
    expectedCueIndex: null,
    command: { type: 'output.clear' }
  }));
  assert.equal(clear.expectedCueIndex, null);
  expectProtocolError('INVALID_FIELD', () => parseCommandEnvelope(commandEnvelope({
    expectedCueIndex: 3,
    command: { type: 'cue.jump', cueIndex: 8 }
  })));
});

test('remote state sanitizer keeps only the public Show contract', () => {
  const sanitized = sanitizeRemoteState(state({
    secretPath: '/Users/operator/private.pptx',
    currentCue: {
      id: 'cue-1',
      index: 0,
      text: 'Hello\u0000 world',
      thumbnailAvailable: true,
      thumbnailUrl: 'file:///private/current.jpg',
      cacheDir: '/private/cache'
    },
    cues: [{
      id: 'cue-1',
      index: 0,
      text: 'Hello\u0000 world',
      thumbnailAvailable: true,
      thumbnailUrl: 'file:///private/slide.jpg',
      cacheDir: '/private/cache'
    }],
    outputs: [
      { id: 'main', name: 'Room', renderer: 'slides', status: 'healthy', visible: true,
        displayId: 123 },
      { id: 'bad', name: 'Bad', status: 'invented', visible: true }
    ]
  }));

  assert.equal(sanitized.revision, 7);
  assert.equal(sanitized.currentCue.text, 'Hello world');
  assert.equal(sanitized.currentCue.thumbnailUrl, null);
  assert.equal(Object.hasOwn(sanitized, 'cues'), false);
  assert.deepEqual(sanitized.outputs, [{
    id: 'main',
    name: 'Room',
    renderer: 'slides',
    status: 'healthy',
    visible: true
  }]);
  assert.equal(JSON.stringify(sanitized).includes('/private'), false);
  assert.equal(Object.hasOwn(sanitized, 'secretPath'), false);

  const catalog = sanitizeCueCatalog(state().cues, 3);
  assert.equal(catalog.length, 3);
  assert.equal(catalog[0].index, 0);

  expectProtocolError('INVALID_GATEWAY_STATE', () => sanitizeRemoteState(state({
    protocolVersion: 2
  })));
  expectProtocolError('INVALID_GATEWAY_STATE', () => sanitizeRemoteState(state({
    phase: 'starting'
  })));
});

test('binding catalog exposes opaque choices and permits only loopback or RFC1918 IPv4', () => {
  const catalog = new NetworkBindingCatalog({
    secret: Buffer.alloc(32, 7),
    networkInterfaces: () => ({
      en0: [
        { family: 'IPv4', address: '192.168.50.12', internal: false },
        { family: 'IPv6', address: 'fd00::1', internal: false }
      ],
      vpn0: [
        { family: 'IPv4', address: '10.42.0.8', internal: false },
        { family: 'IPv4', address: '100.64.0.8', internal: false },
        { family: 'IPv4', address: '169.254.1.2', internal: false }
      ],
      public0: [{ family: 4, address: '203.0.113.9', internal: false }]
    })
  });
  const bindings = catalog.list();

  assert.deepEqual(bindings.map(binding => [binding.kind, binding.address]), [
    ['loopback', '127.0.0.1'],
    ['lan', '192.168.50.12'],
    ['lan', '10.42.0.8']
  ]);
  assert.ok(bindings.every(binding => !binding.id.includes(binding.address)));
  assert.deepEqual(catalog.resolve(bindings[1].id, { kind: 'lan' }).address, '192.168.50.12');
  assert.equal(catalog.resolve('192.168.50.12'), null);
  assert.equal(isPrivateIpv4('172.31.255.2'), true);
  assert.equal(isPrivateIpv4('172.32.0.1'), false);
  assert.equal(normalizePeerAddress('::ffff:192.168.1.8'), '192.168.1.8');
});

test('sliding rate limiter expires attempts and keeps a bounded key set', () => {
  let now = 1000;
  const limiter = new SlidingWindowRateLimiter({
    limit: 2,
    windowMs: 100,
    maxKeys: 2,
    now: () => now
  });
  assert.equal(limiter.consume('one').allowed, true);
  assert.equal(limiter.consume('one').allowed, true);
  const denied = limiter.consume('one');
  assert.equal(denied.allowed, false);
  assert.equal(denied.retryAfterMs, 100);

  limiter.consume('two');
  limiter.consume('three');
  assert.equal(limiter.entries.has('one'), false);
  now += 101;
  assert.equal(limiter.consume('two').allowed, true);
});

test('pair tickets and short codes are one-time, expiring, and backed by revocable device tokens', () => {
  let now = 100000;
  const authority = new RemoteAuthority({ now: () => now, pairingTtlMs: 5000 });
  const grant = authority.openPairing({ baseUrl: 'http://127.0.0.1:43100/' });
  assert.match(grant.ticket, /^[A-Za-z0-9_-]{43}$/);
  assert.match(grant.code, /^\d{6}$/);
  assert.equal(grant.pairingUrl, `http://127.0.0.1:43100/#pair=${grant.ticket}`);
  assert.equal(grant.pairingUrl.includes('?'), false);

  const paired = authority.redeem({ ticket: grant.ticket, deviceName: 'Phone' });
  assert.match(paired.cookieValue, /^[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]{43}$/);
  const device = authority.authenticate(`other=x; syncshow_remote=${paired.cookieValue}`);
  assert.equal(device.name, 'Phone');
  assert.equal(authority.nextSequence(device), 1);
  expectProtocolError('PAIRING_CLOSED', () => authority.redeem({
    code: grant.code,
    deviceName: 'Replay'
  }));

  authority.revokeAll();
  expectProtocolError('AUTH_REQUIRED', () => authority.authenticate(
    `syncshow_remote=${paired.cookieValue}`
  ));

  const expiring = authority.openPairing({ baseUrl: 'http://127.0.0.1:43100/', ttlMs: 1000 });
  now += 1000;
  expectProtocolError('PAIRING_EXPIRED', () => authority.redeem({
    code: expiring.code,
    deviceName: 'Late Phone'
  }));
});

test('command sequencer rejects gaps and altered replays while making exact retry idempotent', async () => {
  const sequencer = new CommandSequencer({ replayLimit: 4 });
  const envelope = parseCommandEnvelope(commandEnvelope());
  let executions = 0;
  let currentState = state();
  const dispatch = candidate => sequencer.dispatch({
    envelope: candidate,
    fingerprint: commandFingerprint(candidate),
    precondition: async () => {},
    execute: async () => {
      executions += 1;
      currentState = state({ revision: currentState.revision + 1 });
      return { applied: true };
    },
    getState: async () => currentState
  });

  const first = await dispatch(envelope);
  assert.equal(first.duplicate, false);
  assert.equal(first.nextSequence, 2);
  const retry = await dispatch(envelope);
  assert.equal(retry.duplicate, true);
  assert.equal(executions, 1);

  await assert.rejects(dispatch(parseCommandEnvelope(commandEnvelope({
    commandId: '00000000-0000-4000-8000-000000000099'
  }))), error => error.code === 'SEQUENCE_REPLAY');
  await assert.rejects(dispatch(parseCommandEnvelope(commandEnvelope({
    sequence: 3,
    commandId: '00000000-0000-4000-8000-000000000003'
  }))), error => error.code === 'SEQUENCE_GAP');
  await assert.rejects(dispatch(parseCommandEnvelope(commandEnvelope({
    sequence: 2,
    commandId: envelope.commandId
  }))), error => error.code === 'COMMAND_ID_REUSED');
});

test('sequencer commits replay identity before a post-command state read failure', async () => {
  const sequencer = new CommandSequencer();
  const envelope = parseCommandEnvelope(commandEnvelope());
  let executions = 0;
  let reads = 0;
  const options = {
    envelope,
    fingerprint: commandFingerprint(envelope),
    precondition: async () => {},
    execute: async () => {
      executions += 1;
      return { applied: true };
    },
    getState: async () => {
      reads += 1;
      if (reads === 1) throw new Error('serialization failed');
      return state({ revision: 8 });
    }
  };

  await assert.rejects(sequencer.dispatch(options), /serialization failed/);
  const retry = await sequencer.dispatch(options);
  assert.equal(retry.duplicate, true);
  assert.equal(executions, 1);
  assert.equal(retry.state.revision, 8);
});

test('command fingerprints bind command IDs and every stale-state field', () => {
  const first = parseCommandEnvelope(commandEnvelope());
  const second = parseCommandEnvelope(commandEnvelope({ expectedRevision: 8 }));
  assert.notEqual(commandFingerprint(first), commandFingerprint(second));
  assert.equal(crypto.createHash('sha256').update('x').digest('base64url').length, 43);
});
