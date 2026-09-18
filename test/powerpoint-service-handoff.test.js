'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  bindVerifiedPowerPointServiceSet,
  resolvePowerPointServiceSetClaim
} = require('../src/services/show/PowerPointServiceHandoff');

const SERVICE_ID = '2026-07-27-main';
const ENGLISH_ASSET = `sha256:${'a'.repeat(64)}`;
const RUSSIAN_ASSET = `sha256:${'b'.repeat(64)}`;
const FINGERPRINT = 'c'.repeat(64);

function restoreContext(roleId, assetId, overrides = {}) {
  return {
    schemaVersion: 1,
    groupId: SERVICE_ID,
    sourceKind: 'service-set',
    roleId,
    serviceSetId: SERVICE_ID,
    assetId,
    ...overrides
  };
}

function presentation(roleId, assetId, overrides = {}) {
  return {
    success: true,
    slideCount: 12,
    metadata: {
      restoreContext: restoreContext(roleId, assetId)
    },
    ...overrides
  };
}

function launchPlan(roleIds = ['english', 'russian']) {
  return {
    timelineRoleId: roleIds[0],
    totalSlides: 12,
    outputs: roleIds.map((roleId, index) => ({
      id: `output-${index + 1}`,
      renderer: index === 0 ? 'slides' : 'singer-current-next',
      sourceRoleId: roleId
    }))
  };
}

function manifest(overrides = {}) {
  return {
    schemaVersion: 1,
    id: SERVICE_ID,
    profileId: 'main-sanctuary',
    serviceDate: '2026-07-27',
    inputs: {
      english: {
        roleId: 'english',
        assetId: ENGLISH_ASSET
      },
      russian: {
        roleId: 'russian',
        assetId: RUSSIAN_ASSET
      }
    },
    ...overrides
  };
}

test('claims only the exact ServiceSet roles actually used by the launch plan', () => {
  const claim = resolvePowerPointServiceSetClaim({
    launchPlan: launchPlan(['english']),
    presentations: {
      english: presentation('english', ENGLISH_ASSET),
      // An unused manual deck does not make the running Show mixed.
      russian: presentation('russian', RUSSIAN_ASSET, {
        metadata: {
          restoreContext: {
            schemaVersion: 1,
            groupId: 'manual-review',
            sourceKind: 'manual',
            roleId: 'russian'
          }
        }
      })
    }
  });

  assert.deepEqual(claim, {
    serviceSetId: SERVICE_ID,
    roleAssets: [{
      roleId: 'english',
      assetId: ENGLISH_ASSET
    }]
  });
  assert.equal(Object.isFrozen(claim), true);
  assert.equal(Object.isFrozen(claim.roleAssets[0]), true);
});

test('manual, mixed, malformed, role-mismatched, and native used decks are ineligible', () => {
  const cases = [
    {
      name: 'manual',
      presentations: {
        english: presentation('english', ENGLISH_ASSET, {
          metadata: {
            restoreContext: {
              schemaVersion: 1,
              groupId: 'manual-review',
              sourceKind: 'manual',
              roleId: 'english'
            }
          }
        }),
        russian: presentation('russian', RUSSIAN_ASSET)
      }
    },
    {
      name: 'mixed',
      presentations: {
        english: presentation('english', ENGLISH_ASSET),
        russian: presentation('russian', RUSSIAN_ASSET, {
          metadata: {
            restoreContext: restoreContext('russian', RUSSIAN_ASSET, {
              groupId: 'different-set',
              serviceSetId: 'different-set'
            })
          }
        })
      }
    },
    {
      name: 'role mismatch',
      presentations: {
        english: presentation('english', ENGLISH_ASSET),
        russian: presentation('russian', RUSSIAN_ASSET, {
          metadata: {
            restoreContext: restoreContext('english', RUSSIAN_ASSET)
          }
        })
      }
    },
    {
      name: 'malformed',
      presentations: {
        english: presentation('english', ENGLISH_ASSET),
        russian: presentation('russian', RUSSIAN_ASSET, {
          metadata: { restoreContext: { nope: true } }
        })
      }
    },
    {
      name: 'native',
      presentations: {
        english: presentation('english', ENGLISH_ASSET),
        russian: presentation('russian', RUSSIAN_ASSET, {
          renderer: 'native-cue',
          sourceType: 'service-project'
        })
      }
    }
  ];

  for (const fixture of cases) {
    assert.equal(
      resolvePowerPointServiceSetClaim({
        launchPlan: launchPlan(),
        presentations: fixture.presentations
      }),
      null,
      fixture.name
    );
  }
});

test('the verified binding requires exact set, profile, role, and asset identities', () => {
  const claim = resolvePowerPointServiceSetClaim({
    launchPlan: launchPlan(),
    presentations: {
      english: presentation('english', ENGLISH_ASSET),
      russian: presentation('russian', RUSSIAN_ASSET)
    }
  });
  const binding = bindVerifiedPowerPointServiceSet({
    claim,
    manifest: manifest(),
    activeProfileId: 'main-sanctuary',
    fingerprint: FINGERPRINT
  });
  assert.deepEqual(binding, {
    id: SERVICE_ID,
    fingerprint: FINGERPRINT,
    serviceDate: '2026-07-27',
    profileId: 'main-sanctuary'
  });
  assert.equal(Object.isFrozen(binding), true);

  const mismatches = [
    {
      claim,
      manifest: manifest({ id: 'another-set' }),
      activeProfileId: 'main-sanctuary',
      fingerprint: FINGERPRINT
    },
    {
      claim,
      manifest: manifest(),
      activeProfileId: 'foyer',
      fingerprint: FINGERPRINT
    },
    {
      claim,
      manifest: manifest({
        inputs: {
          ...manifest().inputs,
          russian: {
            roleId: 'russian',
            assetId: `sha256:${'d'.repeat(64)}`
          }
        }
      }),
      activeProfileId: 'main-sanctuary',
      fingerprint: FINGERPRINT
    },
    {
      claim,
      manifest: manifest(),
      activeProfileId: 'main-sanctuary',
      fingerprint: 'not-a-fingerprint'
    }
  ];
  for (const fixture of mismatches) {
    assert.equal(bindVerifiedPowerPointServiceSet(fixture), null);
  }
});
