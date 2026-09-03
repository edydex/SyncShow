'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  CURRENT_PROFILE_SCHEMA_VERSION,
  VenueProfileError,
  migrateLegacySettingsToVenueProfile,
  migrateVenueProfile,
  resolveVenueProfile
} = require('../src/services/profile');

test('current nested settings migrate without losing assignments or preferences', () => {
  const profile = migrateLegacySettingsToVenueProfile({
    displayAssignments: {
      russian: '1201',
      english: '1202',
      singer: '1203'
    },
    displayFingerprints: {
      russian: 'win:display-a',
      singer: 'win:display-c'
    },
    singerLanguage: 'english',
    fadeDuration: 650,
    syncMode: true,
    friendlyMode: false,
    advancedWarningAcknowledged: true,
    thumbnailZoom: 135,
    showPreviewRussian: true,
    showPreviewEnglish: false,
    showPreviewSinger: true,
    previewOpenRu: true,
    previewOpenSinger: true,
    singerFontSize: 52,
    singerCharLimit: 91,
    singerTextPadding: 13
  });

  assert.equal(profile.friendlyModeDefault, false);
  assert.equal(profile.operator.showControlMode, 'full');
  assert.deepEqual(profile.outputs.map(output => output.legacyDisplayId), [
    '1201', '1202', '1203'
  ]);
  assert.equal(profile.outputs[0].displayFingerprint, 'win:display-a');
  assert.equal(profile.outputs[2].displayFingerprint, 'win:display-c');
  assert.equal(profile.outputs[2].fallback.sourceRoleId, 'english');
  assert.equal(profile.singer.fallbackSourceRoleId, 'english');
  assert.deepEqual(profile.previewOutputIds, ['russian', 'singer']);
  assert.deepEqual(profile.transition, { fadeDurationMs: 650, syncMode: true });
  assert.deepEqual(profile.operator.previewOpenOutputIds, ['russian', 'singer']);
  assert.equal(profile.operator.advancedWarningAcknowledged, true);
  assert.equal(profile.operator.thumbnailZoomPercent, 135);
  assert.deepEqual(profile.singer, {
    fallbackSourceRoleId: 'english',
    fontSizePx: 52,
    charLimit: 91,
    textPaddingPx: 13
  });
});

test('flat legacy display fields and previewEnabled aliases remain supported', () => {
  const profile = migrateVenueProfile({
    russianDisplay: 41,
    englishDisplayId: '42',
    singerDisplay: 43,
    singerSource: 'english',
    previewEnabled: false
  });

  assert.deepEqual(profile.outputs.map(output => output.legacyDisplayId), [41, '42', 43]);
  assert.deepEqual(profile.previewOutputIds, []);
  assert.equal(profile.outputs[2].fallback.sourceRoleId, 'english');
});

test('empty legacy settings produce backward-compatible safe defaults', () => {
  const profile = resolveVenueProfile({});

  assert.equal(profile.schemaVersion, CURRENT_PROFILE_SCHEMA_VERSION);
  assert.equal(profile.id, 'default');
  assert.equal(profile.name, 'Main Sanctuary');
  assert.deepEqual(profile.inputRoles.map(role => role.id), ['russian', 'english', 'media']);
  assert.deepEqual(profile.inputRoles[0].filenameMatchers, [
    'rus', 'russian', 'рус', 'служение'
  ]);
  assert.deepEqual(profile.inputRoles[1].filenameMatchers, [
    'eng', 'english', 'service'
  ]);
  assert.deepEqual(profile.outputs.map(output => output.id), ['russian', 'english', 'singer']);
  assert.deepEqual(profile.outputs.map(output => output.legacyDisplayId), [null, null, null]);
  assert.deepEqual(profile.previewOutputIds, ['singer']);
  assert.deepEqual(profile.operator.previewOpenOutputIds, ['singer']);
  assert.equal(profile.operator.showControlMode, 'full');
  assert.equal(profile.friendlyModeDefault, true);
  assert.equal(profile.stalenessPolicy, 'warn-and-confirm');
  assert.equal(profile.outputs[2].expectedRoleId, 'media');
  assert.equal(profile.inputRoles[2].label, 'Stage-Facing Screen (Media)');
  assert.equal(profile.outputs[2].name, 'Stage-Facing Screen');
  assert.equal(profile.outputs[2].fallback.mode, 'derive-next-text');
  assert.deepEqual(profile.outputs.map(output => output.enabled), [true, true, false]);
});

test('the exact old stock screen label upgrades without rewriting custom names', () => {
  const stock = migrateVenueProfile({
    schemaVersion: CURRENT_PROFILE_SCHEMA_VERSION,
    id: 'default',
    name: 'Main Sanctuary',
    inputRoles: [
      { id: 'english', label: 'English' },
      { id: 'media', label: 'Singers Screen (Media)' }
    ],
    outputs: [
      { id: 'english', name: 'English Screen', expectedRoleId: 'english' },
      { id: 'singer', name: 'Singers Screen', expectedRoleId: 'media' }
    ]
  });
  assert.equal(stock.inputRoles[1].label, 'Stage-Facing Screen (Media)');
  assert.equal(stock.outputs[1].name, 'Stage-Facing Screen');

  const customized = migrateVenueProfile({
    schemaVersion: CURRENT_PROFILE_SCHEMA_VERSION,
    id: 'custom',
    name: 'Custom',
    inputRoles: [{ id: 'media', label: 'Choir confidence feed' }],
    outputs: [{ id: 'singer', name: 'Choir loft', expectedRoleId: 'media' }]
  });
  assert.equal(customized.inputRoles[0].label, 'Choir confidence feed');
  assert.equal(customized.outputs[0].name, 'Choir loft');
});

test('an explicitly closed legacy Singer preview stays closed', () => {
  const profile = migrateLegacySettingsToVenueProfile({
    previewOpenSinger: false
  });

  assert.deepEqual(profile.previewOutputIds, ['singer']);
  assert.deepEqual(profile.operator.previewOpenOutputIds, []);
});

test('an explicitly empty legacy assignment remains off instead of being auto-assigned', () => {
  const profile = migrateLegacySettingsToVenueProfile({
    displayAssignments: {
      russian: '10',
      english: null,
      singer: ''
    }
  });

  assert.deepEqual(profile.outputs.map(output => output.enabled), [true, false, false]);
  assert.deepEqual(profile.outputs.map(output => output.legacyDisplayId), ['10', null, null]);
});

test('numeric preferences are clamped to the same safety ranges as the live app', () => {
  const profile = migrateLegacySettingsToVenueProfile({
    fadeDuration: 90000,
    thumbnailZoom: 5,
    singerFontSize: 1000,
    singerCharLimit: 2,
    singerTextPadding: -4
  });

  assert.equal(profile.transition.fadeDurationMs, 5000);
  assert.equal(profile.operator.thumbnailZoomPercent, 50);
  assert.equal(profile.singer.fontSizePx, 240);
  assert.equal(profile.singer.charLimit, 10);
  assert.equal(profile.singer.textPaddingPx, 0);
});

test('a nested persisted venueProfile wins over surrounding legacy settings', () => {
  const profile = migrateVenueProfile({
    friendlyMode: false,
    venueProfile: {
      schemaVersion: 1,
      id: 'portable',
      name: 'Portable Church',
      friendlyModeDefault: true,
      inputRoles: [{ id: 'service', label: 'Service Deck' }],
      outputs: [{ id: 'front', name: 'Front Screen', expectedRoleId: 'service' }]
    }
  });

  assert.equal(profile.id, 'portable');
  assert.equal(profile.schemaVersion, CURRENT_PROFILE_SCHEMA_VERSION);
  assert.equal(profile.friendlyModeDefault, true);
  assert.equal(profile.operator.showControlMode, 'full');
  assert.deepEqual(profile.outputs.map(output => output.id), ['front']);
});

test('persisted volunteer mode survives v2 normalization', () => {
  const profile = migrateVenueProfile({
    schemaVersion: CURRENT_PROFILE_SCHEMA_VERSION,
    id: 'volunteer-booth',
    name: 'Volunteer Booth',
    operator: {
      showControlMode: 'volunteer'
    }
  });

  assert.equal(profile.schemaVersion, CURRENT_PROFILE_SCHEMA_VERSION);
  assert.equal(profile.operator.showControlMode, 'volunteer');
});

test('persisted stock matchers gain the generic service names without changing custom roles', () => {
  const stock = migrateVenueProfile({
    schemaVersion: 1,
    id: 'default',
    name: 'Main Sanctuary',
    inputRoles: [
      { id: 'russian', label: 'Russian', filenameMatchers: ['rus', 'russian', 'рус'] },
      { id: 'english', label: 'English', filenameMatchers: ['eng', 'english'] },
      { id: 'media', label: 'Media', filenameMatchers: ['media', 'singer', 'stage'] }
    ]
  });
  assert.deepEqual(stock.inputRoles[0].filenameMatchers, ['rus', 'russian', 'рус', 'служение']);
  assert.deepEqual(stock.inputRoles[1].filenameMatchers, ['eng', 'english', 'service']);

  const customized = migrateVenueProfile({
    schemaVersion: 1,
    id: 'custom',
    name: 'Custom',
    inputRoles: [
      { id: 'russian', label: 'Primary', filenameMatchers: ['main-deck'] }
    ],
    outputs: [
      { id: 'front', name: 'Front', expectedRoleId: 'russian' }
    ]
  });
  assert.deepEqual(customized.inputRoles[0].filenameMatchers, ['main-deck']);
});

test('legacy inputs must be records and malformed values fail with typed errors', () => {
  assert.throws(
    () => migrateLegacySettingsToVenueProfile(null),
    error => error instanceof VenueProfileError && error.code === 'INVALID_LEGACY_SETTINGS'
  );
  assert.throws(
    () => migrateLegacySettingsToVenueProfile({ syncMode: 'yes' }),
    error => error instanceof VenueProfileError && error.code === 'INVALID_BOOLEAN'
  );
});
