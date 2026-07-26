'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  CURRENT_PROFILE_SCHEMA_VERSION,
  MAX_FILENAME_MATCHERS_PER_ROLE,
  MAX_FILENAME_MATCHER_LENGTH,
  VenueProfileError,
  createStableId,
  normalizeVenueProfile,
  resolveVenueProfile,
  validateVenueProfile
} = require('../src/services/profile');

function expectCode(code, callback) {
  assert.throws(callback, error => {
    assert.ok(error instanceof VenueProfileError);
    assert.equal(error.code, code);
    return true;
  });
}

function customProfile() {
  return {
    schemaVersion: CURRENT_PROFILE_SCHEMA_VERSION,
    id: 'chapel',
    name: 'Upstairs Chapel',
    friendlyModeDefault: true,
    inputRoles: [
      { id: 'main-language', label: 'Main Language', kind: 'deck' },
      { id: 'translation', label: 'Spanish', kind: 'deck' },
      { id: 'stage-media', label: 'Stage Media', kind: 'deck' }
    ],
    outputs: [
      {
        id: 'projector-a',
        name: 'Center Projector',
        expectedRoleId: 'main-language',
        mode: 'role',
        renderer: 'slides',
        sourceRoleId: 'main-language',
        displayFingerprint: 'mac:vendor-610:model-a:serial-22',
        legacyDisplayId: 887211,
        operatorPreview: false
      },
      {
        id: 'stage',
        name: 'Stage Confidence',
        kind: 'singer',
        expectedRoleId: 'stage-media',
        mode: 'role',
        renderer: 'slides',
        sourceRoleId: 'stage-media',
        displayFingerprint: 'mac:vendor-610:model-b:serial-23',
        legacyDisplayId: '9912',
        operatorPreview: true,
        fallback: {
          mode: 'derive-next-text',
          sourceRoleId: 'main-language',
          renderer: 'singer-current-next'
        }
      }
    ],
    singer: { fallbackSourceRoleId: 'main-language' }
  };
}

test('custom profiles preserve editable names, stable IDs, routing, and display hints', () => {
  const profile = normalizeVenueProfile(customProfile());

  assert.equal(profile.schemaVersion, 1);
  assert.deepEqual(profile.inputRoles.map(role => role.id), [
    'main-language',
    'translation',
    'stage-media'
  ]);
  assert.equal(profile.inputRoles[1].label, 'Spanish');
  assert.equal(profile.outputs[0].name, 'Center Projector');
  assert.equal(profile.outputs[0].displayFingerprint, 'mac:vendor-610:model-a:serial-22');
  assert.equal(profile.outputs[0].legacyDisplayId, 887211);
  assert.equal(profile.outputs[1].expectedRoleId, 'stage-media');
  assert.equal(profile.outputs[1].fallback.mode, 'derive-next-text');
  assert.deepEqual(profile.previewOutputIds, ['stage']);
  assert.equal(validateVenueProfile(profile), true);
});

test('reordering roles and outputs never rewrites stable IDs or their references', () => {
  const first = normalizeVenueProfile(customProfile());
  const reordered = normalizeVenueProfile({
    ...first,
    inputRoles: [first.inputRoles[2], first.inputRoles[0], first.inputRoles[1]],
    outputs: [first.outputs[1], first.outputs[0]]
  });

  assert.deepEqual(reordered.inputRoles.map(role => role.id), [
    'stage-media',
    'main-language',
    'translation'
  ]);
  assert.deepEqual(reordered.outputs.map(output => output.id), ['stage', 'projector-a']);
  assert.equal(reordered.outputs[0].fallback.sourceRoleId, 'main-language');
  assert.equal(reordered.outputs[1].expectedRoleId, 'main-language');
  assert.deepEqual(reordered.previewOutputIds, ['stage']);
});

test('missing IDs receive deterministic position IDs and newly added IDs avoid collisions', () => {
  const normalized = normalizeVenueProfile({
    inputRoles: [{ label: 'Primary' }],
    outputs: [{ name: 'Projector', expectedRoleId: 'input-1' }]
  });

  assert.equal(normalized.inputRoles[0].id, 'input-1');
  assert.equal(normalized.outputs[0].id, 'output-1');
  assert.equal(createStableId('output', ['output', 'output-2', 'other']), 'output-3');
  assert.equal(createStableId('lobby', new Set(['main'])), 'lobby');
});

test('resolved profiles are detached deeply frozen snapshots', () => {
  const source = customProfile();
  const snapshot = resolveVenueProfile(source);

  assert.ok(Object.isFrozen(snapshot));
  assert.ok(Object.isFrozen(snapshot.inputRoles));
  assert.ok(Object.isFrozen(snapshot.inputRoles[0]));
  assert.ok(Object.isFrozen(snapshot.outputs));
  assert.ok(Object.isFrozen(snapshot.outputs[1].fallback));
  assert.ok(Object.isFrozen(snapshot.singer));

  source.name = 'Changed after resolution';
  source.outputs[0].name = 'Changed output';
  assert.equal(snapshot.name, 'Upstairs Chapel');
  assert.equal(snapshot.outputs[0].name, 'Center Projector');
});

test('unknown role references, duplicate IDs, and mirror cycles fail closed', () => {
  expectCode('UNKNOWN_EXPECTED_ROLE', () => normalizeVenueProfile({
    inputRoles: [{ id: 'main', label: 'Main' }],
    outputs: [{ id: 'screen', name: 'Screen', expectedRoleId: 'removed' }]
  }));

  expectCode('DUPLICATE_OUTPUT_ID', () => normalizeVenueProfile({
    inputRoles: [{ id: 'main', label: 'Main' }],
    outputs: [
      { id: 'screen', name: 'One', expectedRoleId: 'main' },
      { id: 'screen', name: 'Two', expectedRoleId: 'main' }
    ]
  }));

  expectCode('MIRROR_CYCLE', () => normalizeVenueProfile({
    inputRoles: [{ id: 'main', label: 'Main' }],
    outputs: [
      {
        id: 'one', name: 'One', expectedRoleId: 'main', mode: 'mirror',
        sourceOutputId: 'two'
      },
      {
        id: 'two', name: 'Two', expectedRoleId: 'main', mode: 'mirror',
        sourceOutputId: 'one'
      }
    ]
  }));
});

test('future profile versions are rejected instead of silently downgraded', () => {
  expectCode('UNSUPPORTED_SCHEMA_VERSION', () => resolveVenueProfile({
    schemaVersion: CURRENT_PROFILE_SCHEMA_VERSION + 1,
    inputRoles: [],
    outputs: []
  }));
});

test('service dates use a validated venue timezone and configurable numeric order', () => {
  const profile = normalizeVenueProfile({
    timeZone: 'Europe/Kyiv',
    serviceDateOrder: 'dmy'
  });
  assert.equal(profile.timeZone, 'Europe/Kyiv');
  assert.equal(profile.serviceDateOrder, 'dmy');

  expectCode('INVALID_TIME_ZONE', () => normalizeVenueProfile({ timeZone: 'Church/Upstairs' }));
  expectCode('INVALID_ENUM', () => normalizeVenueProfile({ serviceDateOrder: 'ymd' }));
});

test('venue profiles select one automatic loading source and keep Drive IDs opaque', () => {
  const driveProfile = normalizeVenueProfile({
    driveConnectionId: 'drive-connection:church-main'
  });
  assert.equal(driveProfile.driveConnectionId, 'drive-connection:church-main');
  assert.equal(driveProfile.localServiceFolder, null);

  expectCode('INVALID_ID', () => normalizeVenueProfile({
    driveConnectionId: '../not-an-opaque-id'
  }));
  expectCode('MULTIPLE_SERVICE_SOURCES', () => normalizeVenueProfile({
    localServiceFolder: '/Volumes/Church Slides',
    driveConnectionId: 'drive-main'
  }));
});

test('filename matcher settings obey the Service Folder resolver limits at save time', () => {
  const maximumMatchers = Array.from(
    { length: MAX_FILENAME_MATCHERS_PER_ROLE },
    (_, index) => `language ${index + 1}`
  );
  const accepted = normalizeVenueProfile({
    inputRoles: [{ id: 'main', label: 'Main', filenameMatchers: maximumMatchers }],
    outputs: [{ id: 'main', name: 'Main', expectedRoleId: 'main' }]
  });
  assert.equal(accepted.inputRoles[0].filenameMatchers.length, MAX_FILENAME_MATCHERS_PER_ROLE);
  assert.equal(
    normalizeVenueProfile({
      inputRoles: [{
        id: 'main',
        label: 'Main',
        filenameMatchers: ['x'.repeat(MAX_FILENAME_MATCHER_LENGTH)]
      }],
      outputs: [{ id: 'main', name: 'Main', expectedRoleId: 'main' }]
    }).inputRoles[0].filenameMatchers[0].length,
    MAX_FILENAME_MATCHER_LENGTH
  );

  expectCode('TOO_MANY_FILENAME_MATCHERS', () => normalizeVenueProfile({
    inputRoles: [{
      id: 'main',
      label: 'Main',
      filenameMatchers: [...maximumMatchers, 'one too many']
    }],
    outputs: [{ id: 'main', name: 'Main', expectedRoleId: 'main' }]
  }));
  expectCode('INVALID_FILENAME_MATCHER', () => normalizeVenueProfile({
    inputRoles: [{
      id: 'main',
      label: 'Main',
      filenameMatchers: ['x'.repeat(MAX_FILENAME_MATCHER_LENGTH + 1)]
    }],
    outputs: [{ id: 'main', name: 'Main', expectedRoleId: 'main' }]
  }));
  expectCode('INVALID_FILENAME_MATCHER', () => normalizeVenueProfile({
    inputRoles: [{ id: 'main', label: 'Main', filenameMatchers: ['--- ___ !!!'] }],
    outputs: [{ id: 'main', name: 'Main', expectedRoleId: 'main' }]
  }));

  const invalidCanonicalProfile = structuredClone(accepted);
  invalidCanonicalProfile.inputRoles[0].filenameMatchers = ['...'];
  expectCode('INVALID_FILENAME_MATCHER', () => validateVenueProfile(invalidCanonicalProfile));
});

test('invalid derive and native renderer combinations fail validation', () => {
  expectCode('INVALID_DERIVED_RENDERER', () => normalizeVenueProfile({
    inputRoles: [{ id: 'main', label: 'Main' }],
    outputs: [{
      id: 'stage',
      name: 'Stage',
      expectedRoleId: 'main',
      mode: 'derive-next-text',
      renderer: 'slides',
      sourceRoleId: 'main'
    }]
  }));

  expectCode('INVALID_NATIVE_RENDERER', () => normalizeVenueProfile({
    inputRoles: [{ id: 'main', label: 'Main' }],
    outputs: [{
      id: 'main',
      name: 'Main',
      expectedRoleId: null,
      mode: 'native-cue',
      renderer: 'slides'
    }]
  }));
});

test('enabled outputs cannot depend on disabled input roles', () => {
  expectCode('DISABLED_EXPECTED_ROLE', () => normalizeVenueProfile({
    inputRoles: [{ id: 'unused', label: 'Unused', enabled: false }],
    outputs: [{ id: 'main', name: 'Main', expectedRoleId: 'unused' }]
  }));

  const profile = normalizeVenueProfile({
    inputRoles: [{ id: 'unused', label: 'Unused', enabled: false }],
    outputs: [{ id: 'main', name: 'Main', enabled: false, expectedRoleId: 'unused' }]
  });
  assert.equal(profile.outputs[0].enabled, false);
});
