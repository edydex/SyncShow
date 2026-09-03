'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  preparedServiceVenueRevisionId
} = require('../src/services/project/PreparedServiceVenueContract');

function profile(overrides = {}) {
  return {
    schemaVersion: 2,
    id: 'main-sanctuary',
    operator: {
      showControlMode: 'full'
    },
    inputRoles: [
      { id: 'russian', label: 'Russian', enabled: true, kind: 'deck' },
      { id: 'english', label: 'English', enabled: true, kind: 'deck' },
      { id: 'media', label: 'Media', enabled: true, kind: 'deck' },
      { id: 'notes', label: 'Notes', enabled: true, kind: 'document' }
    ],
    outputs: [],
    ...overrides
  };
}

test('the prepared venue revision binds profile id plus mapping-affecting deck order and labels', () => {
  const original = profile();
  const originalRevision = preparedServiceVenueRevisionId(original);
  assert.match(originalRevision, /^[a-f0-9]{64}$/);
  assert.equal(
    preparedServiceVenueRevisionId(structuredClone(original)),
    originalRevision
  );

  const reordered = profile({
    inputRoles: [
      original.inputRoles[1],
      original.inputRoles[0],
      ...original.inputRoles.slice(2)
    ]
  });
  const renamed = profile({
    inputRoles: original.inputRoles.map(role =>
      role.id === 'english' ? { ...role, label: 'Russian overflow' } : role)
  });
  const disabled = profile({
    inputRoles: original.inputRoles.map(role =>
      role.id === 'media' ? { ...role, enabled: false } : role)
  });
  assert.notEqual(preparedServiceVenueRevisionId(reordered), originalRevision);
  assert.notEqual(preparedServiceVenueRevisionId(renamed), originalRevision);
  assert.notEqual(preparedServiceVenueRevisionId(disabled), originalRevision);
});

test('output routing and non-deck setup can change without rerendering deck channels', () => {
  const original = profile();
  assert.equal(
    preparedServiceVenueRevisionId(profile({
      outputs: [{ id: 'projector', displayId: 'different-screen' }]
    })),
    preparedServiceVenueRevisionId(original)
  );
  assert.equal(
    preparedServiceVenueRevisionId(profile({
      inputRoles: original.inputRoles.map(role =>
        role.id === 'notes' ? { ...role, label: 'Operator notes' } : role)
    })),
    preparedServiceVenueRevisionId(original)
  );
});

test('show control mode changes do not invalidate prepared deck channels', () => {
  const fullControl = profile();
  const volunteerControl = profile({
    operator: {
      ...fullControl.operator,
      showControlMode: 'volunteer'
    }
  });

  assert.equal(
    preparedServiceVenueRevisionId(volunteerControl),
    preparedServiceVenueRevisionId(fullControl)
  );
});
