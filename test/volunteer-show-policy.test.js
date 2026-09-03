'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  LOCAL_COMMANDS,
  MAX_VOLUNTEER_UNLOCK_TTL_MS,
  OPERATOR_AUTHORITY_STATES,
  REMOTE_COMMANDS,
  SHOW_COMMAND_CLASSIFICATIONS,
  SHOW_COMMAND_SOURCES,
  VOLUNTEER_SHOW_MODES,
  VOLUNTEER_UNLOCK_GRANT_KIND,
  VolunteerShowPolicyError,
  authorityForVolunteerShowUnlockGrant,
  authorizeVolunteerShowCommand,
  classifyShowCommand,
  createVolunteerShowUnlockGrant,
  normalizeOperatorAuthority,
  normalizeVolunteerShowBinding,
  normalizeVolunteerShowMode,
  normalizeVolunteerShowUnlockGrant,
  sameVolunteerShowBinding
} = require('../src/services/show');

const ISSUED_AT = '2026-07-29T17:00:00.000Z';
const EXPIRES_AT = '2026-07-29T17:05:00.000Z';
const TOKEN = 'unlock_abcdefghijklmnopqrstuvwxyz0123456789';

function showBinding(overrides = {}) {
  return {
    showId: 'show-sunday-2026-08-02',
    showFingerprint: 'a'.repeat(64),
    venueProfileId: 'main-sanctuary',
    venueFingerprint: 'b'.repeat(64),
    outputSessionId: 'session-1234567890abcdef',
    ...overrides
  };
}

function unlockGrant(overrides = {}) {
  return createVolunteerShowUnlockGrant({
    confirmed: true,
    token: TOKEN,
    binding: showBinding(),
    issuedAt: ISSUED_AT,
    expiresAt: EXPIRES_AT,
    ...overrides
  });
}

function expectCode(code, callback) {
  assert.throws(callback, error => {
    assert.ok(error instanceof VolunteerShowPolicyError);
    assert.equal(error.code, code);
    return true;
  });
}

test('venue mode and operator authority normalize with locked fail-closed defaults', () => {
  assert.deepEqual(VOLUNTEER_SHOW_MODES, ['full', 'volunteer']);
  assert.deepEqual(OPERATOR_AUTHORITY_STATES, ['locked', 'unlocked']);
  assert.equal(normalizeVolunteerShowMode(), 'full');
  assert.equal(normalizeVolunteerShowMode(''), 'full');
  assert.equal(normalizeVolunteerShowMode('full'), 'full');
  assert.equal(normalizeVolunteerShowMode('volunteer'), 'volunteer');

  const locked = normalizeOperatorAuthority();
  assert.deepEqual(locked, { state: 'locked' });
  assert.equal(Object.isFrozen(locked), true);
  assert.deepEqual(
    normalizeOperatorAuthority({ state: 'locked' }),
    { state: 'locked' }
  );

  const unlocked = normalizeOperatorAuthority({
    state: 'unlocked',
    unlockToken: TOKEN
  });
  assert.deepEqual(unlocked, {
    state: 'unlocked',
    unlockToken: TOKEN
  });
  assert.equal(Object.isFrozen(unlocked), true);

  expectCode(
    'INVALID_VOLUNTEER_SHOW_MODE',
    () => normalizeVolunteerShowMode('friendly')
  );
  expectCode(
    'INVALID_VOLUNTEER_UNLOCK_AUTHORITY',
    () => normalizeOperatorAuthority('unlocked')
  );
  expectCode(
    'INVALID_VOLUNTEER_UNLOCK_AUTHORITY',
    () => normalizeOperatorAuthority({
      state: 'locked',
      unlockToken: TOKEN
    })
  );
  expectCode(
    'INVALID_VOLUNTEER_UNLOCK_AUTHORITY',
    () => normalizeOperatorAuthority({
      state: 'unlocked',
      unlockToken: 'short'
    })
  );

  const accessorAuthority = {};
  Object.defineProperty(accessorAuthority, 'state', {
    enumerable: true,
    get() {
      throw new Error('must not execute');
    }
  });
  expectCode(
    'INVALID_VOLUNTEER_UNLOCK_AUTHORITY',
    () => normalizeOperatorAuthority(accessorAuthority)
  );
});

test('local and remote command classifications are explicit and fail closed', () => {
  assert.deepEqual(SHOW_COMMAND_SOURCES, ['local', 'remote']);
  assert.deepEqual(SHOW_COMMAND_CLASSIFICATIONS, {
    STANDARD: 'standard',
    EMERGENCY: 'emergency',
    PRIVILEGED: 'privileged'
  });

  assert.deepEqual(LOCAL_COMMANDS, {
    'cue.next': 'standard',
    'cue.previous': 'privileged',
    'cue.jump': 'privileged',
    'output.clear': 'emergency',
    'output.restore': 'privileged',
    'output.stop': 'emergency',
    'output.configure': 'privileged',
    'session.end': 'privileged',
    'bible.show': 'privileged',
    'remote.closePairing': 'emergency',
    'remote.manage': 'privileged'
  });
  assert.deepEqual(REMOTE_COMMANDS, {
    'cue.next': 'standard',
    'cue.previous': 'privileged',
    'cue.jump': 'privileged',
    'output.clear': 'emergency',
    'output.restore': 'privileged'
  });

  assert.deepEqual(
    classifyShowCommand({ source: 'local', type: 'cue.next' }),
    {
      source: 'local',
      type: 'cue.next',
      classification: 'standard',
      requiresUnlock: false
    }
  );
  assert.deepEqual(
    classifyShowCommand({ source: 'remote', type: 'output.clear' }),
    {
      source: 'remote',
      type: 'output.clear',
      classification: 'emergency',
      requiresUnlock: false
    }
  );
  assert.deepEqual(
    classifyShowCommand({ source: 'local', type: 'cue.jump' }),
    {
      source: 'local',
      type: 'cue.jump',
      classification: 'privileged',
      requiresUnlock: true
    }
  );
  assert.deepEqual(
    classifyShowCommand({ source: 'local', type: 'remote.closePairing' }),
    {
      source: 'local',
      type: 'remote.closePairing',
      classification: 'emergency',
      requiresUnlock: false
    }
  );

  expectCode(
    'UNSUPPORTED_SHOW_COMMAND',
    () => classifyShowCommand({ source: 'remote', type: 'output.stop' })
  );
  expectCode(
    'UNSUPPORTED_SHOW_COMMAND',
    () => classifyShowCommand({ source: 'local', type: 'admin.settings' })
  );
  expectCode(
    'INVALID_SHOW_COMMAND_SOURCE',
    () => classifyShowCommand({ source: 'renderer', type: 'cue.next' })
  );
  expectCode(
    'INVALID_SHOW_COMMAND',
    () => classifyShowCommand({
      source: 'local',
      type: 'cue.next',
      filePath: '/private/show'
    })
  );
});

test('full mode permits every recognized command without minting unlock authority', () => {
  for (const [source, commands] of [
    ['local', LOCAL_COMMANDS],
    ['remote', REMOTE_COMMANDS]
  ]) {
    for (const type of Object.keys(commands)) {
      const result = authorizeVolunteerShowCommand({
        mode: 'full',
        authority: 'locked',
        source,
        type
      });
      assert.equal(result.allowed, true);
      assert.equal(result.mode, 'full');
      assert.equal(result.authority, 'locked');
      assert.equal(result.unlockUsed, false);
      assert.equal(Object.isFrozen(result), true);
      assert.equal(Object.isFrozen(result.command), true);
    }
  }

  expectCode(
    'UNSUPPORTED_SHOW_COMMAND',
    () => authorizeVolunteerShowCommand({
      mode: 'full',
      source: 'local',
      type: 'filesystem.delete'
    })
  );
  expectCode(
    'INVALID_SHOW_AUTHORIZATION',
    () => authorizeVolunteerShowCommand({
      mode: 'full',
      source: 'local',
      type: 'cue.next',
      rendererControlled: true
    })
  );
});

test('locked volunteer mode permits Next and only the defined emergency actions', () => {
  for (const source of ['local', 'remote']) {
    const next = authorizeVolunteerShowCommand({
      mode: 'volunteer',
      authority: 'locked',
      source,
      type: 'cue.next'
    });
    assert.equal(next.command.classification, 'standard');
    assert.equal(next.unlockUsed, false);

    const clear = authorizeVolunteerShowCommand({
      mode: 'volunteer',
      authority: { state: 'locked' },
      source,
      type: 'output.clear'
    });
    assert.equal(clear.command.classification, 'emergency');
    assert.equal(clear.unlockUsed, false);
  }

  const stop = authorizeVolunteerShowCommand({
    mode: 'volunteer',
    source: 'local',
    type: 'output.stop'
  });
  assert.equal(stop.command.classification, 'emergency');

  const closePairing = authorizeVolunteerShowCommand({
    mode: 'volunteer',
    source: 'local',
    type: 'remote.closePairing'
  });
  assert.equal(closePairing.command.classification, 'emergency');
  assert.equal(closePairing.unlockUsed, false);

  for (const [source, type] of [
    ['local', 'cue.previous'],
    ['local', 'cue.jump'],
    ['local', 'output.restore'],
    ['local', 'output.configure'],
    ['local', 'session.end'],
    ['local', 'bible.show'],
    ['local', 'remote.manage'],
    ['remote', 'cue.previous'],
    ['remote', 'cue.jump'],
    ['remote', 'output.restore']
  ]) {
    expectCode(
      'VOLUNTEER_COMMAND_LOCKED',
      () => authorizeVolunteerShowCommand({
        mode: 'volunteer',
        authority: 'locked',
        source,
        type
      })
    );
  }
});

test('unlock issuance is explicit, short-lived, opaque, immutable, and exact-bound', () => {
  const sourceBinding = showBinding();
  const grant = unlockGrant({ binding: sourceBinding });
  const authority = authorityForVolunteerShowUnlockGrant(grant);

  assert.equal(grant.schemaVersion, 1);
  assert.equal(grant.kind, VOLUNTEER_UNLOCK_GRANT_KIND);
  assert.equal(
    Date.parse(grant.expiresAt) - Date.parse(grant.issuedAt),
    MAX_VOLUNTEER_UNLOCK_TTL_MS
  );
  assert.deepEqual(grant.binding, showBinding());
  assert.equal(Object.isFrozen(grant), true);
  assert.equal(Object.isFrozen(grant.binding), true);
  assert.deepEqual(authority, {
    state: 'unlocked',
    unlockToken: TOKEN
  });
  assert.deepEqual(Object.keys(authority).sort(), [
    'state',
    'unlockToken'
  ]);
  assert.equal(JSON.stringify(authority).includes(grant.binding.showId), false);

  sourceBinding.showId = 'changed-after-issuance';
  assert.equal(grant.binding.showId, 'show-sunday-2026-08-02');

  expectCode(
    'VOLUNTEER_UNLOCK_NOT_CONFIRMED',
    () => createVolunteerShowUnlockGrant({
      confirmed: false,
      token: TOKEN,
      binding: showBinding(),
      issuedAt: ISSUED_AT,
      expiresAt: EXPIRES_AT
    })
  );
  expectCode(
    'INVALID_VOLUNTEER_UNLOCK_GRANT',
    () => unlockGrant({
      expiresAt: new Date(
        Date.parse(ISSUED_AT) + MAX_VOLUNTEER_UNLOCK_TTL_MS + 1
      ).toISOString()
    })
  );
  expectCode(
    'INVALID_VOLUNTEER_UNLOCK_GRANT',
    () => unlockGrant({ issuedAt: '2026-07-29T10:00:00-07:00' })
  );
});

test('privileged volunteer commands require the matching active grant', () => {
  const grant = unlockGrant();
  const authority = authorityForVolunteerShowUnlockGrant(grant);
  const now = '2026-07-29T17:02:00.000Z';

  for (const [source, type] of [
    ['local', 'cue.previous'],
    ['local', 'cue.jump'],
    ['local', 'output.restore'],
    ['local', 'output.configure'],
    ['local', 'session.end'],
    ['local', 'bible.show'],
    ['local', 'remote.manage'],
    ['remote', 'cue.previous'],
    ['remote', 'cue.jump'],
    ['remote', 'output.restore']
  ]) {
    const result = authorizeVolunteerShowCommand({
      mode: 'volunteer',
      authority,
      source,
      type,
      binding: showBinding(),
      unlockGrant: grant,
      now
    });
    assert.equal(result.allowed, true);
    assert.equal(result.authority, 'unlocked');
    assert.equal(result.unlockUsed, true);
  }

  expectCode(
    'VOLUNTEER_UNLOCK_GRANT_REQUIRED',
    () => authorizeVolunteerShowCommand({
      mode: 'volunteer',
      authority,
      source: 'local',
      type: 'cue.previous',
      binding: showBinding(),
      now
    })
  );
  expectCode(
    'VOLUNTEER_UNLOCK_GRANT_MISMATCH',
    () => authorizeVolunteerShowCommand({
      mode: 'volunteer',
      authority: {
        state: 'unlocked',
        unlockToken: 'different_abcdefghijklmnopqrstuvwxyz012345'
      },
      source: 'local',
      type: 'cue.previous',
      binding: showBinding(),
      unlockGrant: grant,
      now
    })
  );
});

test('an unlock grant cannot cross show, venue, or output-session boundaries', () => {
  const grant = unlockGrant();
  const authority = authorityForVolunteerShowUnlockGrant(grant);
  const now = '2026-07-29T17:02:00.000Z';
  const mismatches = [
    { showId: 'show-sunday-2026-08-09' },
    { showFingerprint: 'c'.repeat(64) },
    { venueProfileId: 'fellowship-hall' },
    { venueFingerprint: 'd'.repeat(64) },
    { outputSessionId: 'session-fedcba0987654321' }
  ];

  for (const mismatch of mismatches) {
    expectCode(
      'VOLUNTEER_UNLOCK_GRANT_MISMATCH',
      () => authorizeVolunteerShowCommand({
        mode: 'volunteer',
        authority,
        source: 'remote',
        type: 'cue.jump',
        binding: showBinding(mismatch),
        unlockGrant: grant,
        now
      })
    );
  }

  const sameSessionAgain = authorizeVolunteerShowCommand({
    mode: 'volunteer',
    authority,
    source: 'local',
    type: 'cue.previous',
    binding: showBinding(),
    unlockGrant: grant,
    now
  });
  assert.equal(sameSessionAgain.allowed, true);

  expectCode(
    'VOLUNTEER_UNLOCK_GRANT_MISMATCH',
    () => authorizeVolunteerShowCommand({
      mode: 'volunteer',
      authority,
      source: 'local',
      type: 'cue.previous',
      binding: showBinding({
        outputSessionId: 'replacement-session-123456'
      }),
      unlockGrant: grant,
      now
    })
  );
});

test('unlock grants reject use before issuance or at and after expiration', () => {
  const grant = unlockGrant();
  const authority = authorityForVolunteerShowUnlockGrant(grant);
  const request = {
    mode: 'volunteer',
    authority,
    source: 'local',
    type: 'output.restore',
    binding: showBinding(),
    unlockGrant: grant
  };

  expectCode(
    'VOLUNTEER_UNLOCK_GRANT_NOT_ACTIVE',
    () => authorizeVolunteerShowCommand({
      ...request,
      now: Date.parse(ISSUED_AT) - 1
    })
  );
  assert.equal(
    authorizeVolunteerShowCommand({
      ...request,
      now: Date.parse(ISSUED_AT)
    }).allowed,
    true
  );
  expectCode(
    'VOLUNTEER_UNLOCK_GRANT_EXPIRED',
    () => authorizeVolunteerShowCommand({
      ...request,
      now: Date.parse(EXPIRES_AT)
    })
  );
  expectCode(
    'VOLUNTEER_UNLOCK_GRANT_EXPIRED',
    () => authorizeVolunteerShowCommand({
      ...request,
      now: Date.parse(EXPIRES_AT) + 1
    })
  );
});

test('bindings and trusted grants reject extra fields, unsafe IDs, and accessors', () => {
  assert.deepEqual(
    normalizeVolunteerShowBinding(showBinding()),
    showBinding()
  );
  assert.equal(
    sameVolunteerShowBinding(showBinding(), showBinding()),
    true
  );
  assert.equal(
    sameVolunteerShowBinding(
      showBinding(),
      showBinding({ outputSessionId: 'session-fedcba0987654321' })
    ),
    false
  );
  assert.equal(
    sameVolunteerShowBinding(showBinding(), { ...showBinding(), path: '/tmp' }),
    false
  );

  expectCode(
    'INVALID_VOLUNTEER_SHOW_BINDING',
    () => normalizeVolunteerShowBinding({
      ...showBinding(),
      sourcePath: '/private/show'
    })
  );
  expectCode(
    'INVALID_VOLUNTEER_SHOW_BINDING',
    () => normalizeVolunteerShowBinding(showBinding({
      venueProfileId: '__proto__'
    }))
  );
  expectCode(
    'INVALID_VOLUNTEER_SHOW_BINDING',
    () => normalizeVolunteerShowBinding(showBinding({
      showFingerprint: 'A'.repeat(64)
    }))
  );

  const accessorGrant = {
    schemaVersion: 1,
    kind: VOLUNTEER_UNLOCK_GRANT_KIND,
    token: TOKEN,
    binding: showBinding(),
    issuedAt: ISSUED_AT
  };
  Object.defineProperty(accessorGrant, 'expiresAt', {
    enumerable: true,
    get() {
      throw new Error('must not execute');
    }
  });
  expectCode(
    'INVALID_VOLUNTEER_UNLOCK_GRANT',
    () => normalizeVolunteerShowUnlockGrant(accessorGrant)
  );

  expectCode(
    'INVALID_VOLUNTEER_UNLOCK_GRANT',
    () => normalizeVolunteerShowUnlockGrant({
      ...unlockGrant(),
      rendererControlled: true
    })
  );
});
