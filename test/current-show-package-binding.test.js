'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  CurrentShowPackageBindingError,
  validateCurrentShowPackageBinding
} = require('../src/services/project/CurrentShowPackageBinding');

const PACKAGE_ID = `show-${'a'.repeat(64)}`;
const REVISION_ID = 'b'.repeat(64);
const MANIFEST_SHA256 = 'c'.repeat(64);
const PROFILE_REVISION_ID = 'd'.repeat(64);
const ACTIVATION_ID = '11111111-1111-4111-8111-111111111111';

function fixture(overrides = {}) {
  const pointer = {
    packageId: PACKAGE_ID,
    packageManifestSha256: MANIFEST_SHA256,
    projectId: 'service-2026-08-02',
    projectRevisionId: REVISION_ID,
    projectRevision: 7,
    serviceDate: '2026-08-02',
    venueProfileId: 'main-sanctuary',
    venueProfileRevisionId: PROFILE_REVISION_ID,
    activationId: ACTIVATION_ID,
    activatedAt: '2026-07-28T18:30:00.000Z'
  };
  const manifest = {
    id: PACKAGE_ID,
    projectId: pointer.projectId,
    projectRevisionId: REVISION_ID,
    projectRevision: 7,
    roleMapping: {
      russian: 'primary',
      english: 'secondary',
      media: 'media'
    }
  };
  const serviceHandoff = {
    project: {
      id: pointer.projectId,
      revisionId: REVISION_ID,
      revision: 7,
      serviceDate: pointer.serviceDate
    }
  };
  return {
    pointer,
    manifest,
    manifestSha256: MANIFEST_SHA256,
    serviceHandoff,
    venueProfileId: pointer.venueProfileId,
    venueProfileRevisionId: PROFILE_REVISION_ID,
    enabledRoleIds: ['russian', 'english', 'media'],
    presentationRoleIds: ['russian', 'english', 'media'],
    ...overrides
  };
}

function expectCode(code) {
  return error => error instanceof CurrentShowPackageBindingError
    && error.code === code;
}

test('binds one exact verified package to the unchanged venue roles', () => {
  const binding = validateCurrentShowPackageBinding(fixture({
    enabledRoleIds: ['media', 'russian', 'english'],
    presentationRoleIds: ['english', 'media', 'russian']
  }));

  assert.deepEqual(binding, {
    packageId: PACKAGE_ID,
    packageManifestSha256: MANIFEST_SHA256,
    projectId: 'service-2026-08-02',
    projectRevisionId: REVISION_ID,
    projectRevision: 7,
    serviceDate: '2026-08-02',
    venueProfileId: 'main-sanctuary',
    venueProfileRevisionId: PROFILE_REVISION_ID,
    activationId: ACTIVATION_ID,
    activatedAt: '2026-07-28T18:30:00.000Z',
    roleIds: ['english', 'media', 'russian']
  });
  assert.equal(Object.isFrozen(binding), true);
  assert.equal(Object.isFrozen(binding.roleIds), true);
});

test('rejects pointer, manifest, and handoff identity drift as corruption', () => {
  const cases = [
    value => {
      value.manifest.id = `show-${'c'.repeat(64)}`;
    },
    value => {
    value.manifest.projectId = 'different-service';
    },
    value => {
      value.manifest.projectRevisionId = 'd'.repeat(64);
    },
    value => {
      value.manifest.projectRevision = 8;
    },
    value => {
      value.serviceHandoff.project.id = 'different-service';
    },
    value => {
      value.serviceHandoff.project.revisionId = 'e'.repeat(64);
    },
    value => {
      value.serviceHandoff.project.revision = 8;
    },
    value => {
    value.serviceHandoff.project.serviceDate = '2026-08-09';
    },
    value => {
      value.manifestSha256 = 'e'.repeat(64);
    }
  ];
  for (const change of cases) {
    const value = structuredClone(fixture());
    change(value);
    assert.throws(
      () => validateCurrentShowPackageBinding(value),
      expectCode('CURRENT_SHOW_PACKAGE_BINDING_CORRUPT')
    );
  }
});

test('rejects a changed venue profile or enabled role set without calling it corrupt', () => {
  assert.throws(
    () => validateCurrentShowPackageBinding(fixture({
      venueProfileId: 'fellowship-hall'
    })),
    expectCode('CURRENT_SHOW_PACKAGE_PROFILE_INCOMPATIBLE')
  );
  assert.throws(
    () => validateCurrentShowPackageBinding(fixture({
      enabledRoleIds: ['russian', 'english']
    })),
    expectCode('CURRENT_SHOW_PACKAGE_PROFILE_INCOMPATIBLE')
  );
  assert.throws(
    () => validateCurrentShowPackageBinding(fixture({
      presentationRoleIds: ['russian', 'english']
    })),
    expectCode('CURRENT_SHOW_PACKAGE_PROFILE_INCOMPATIBLE')
  );
  assert.throws(
    () => validateCurrentShowPackageBinding(fixture({
      venueProfileRevisionId: 'e'.repeat(64)
    })),
    expectCode('CURRENT_SHOW_PACKAGE_PROFILE_INCOMPATIBLE')
  );
});

test('rejects malformed caller state before compatibility comparison', () => {
  for (const value of [
    {},
    fixture({ enabledRoleIds: [] }),
    fixture({ presentationRoleIds: ['russian', 'russian'] }),
    fixture({ venueProfileId: 'constructor' }),
    fixture({
      pointer: {
        ...fixture().pointer,
        packageId: '../show'
      }
    })
  ]) {
    assert.throws(
      () => validateCurrentShowPackageBinding(value),
      expectCode('CURRENT_SHOW_PACKAGE_BINDING_INVALID')
    );
  }
});
