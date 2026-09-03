'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  preparedServiceDateGuard
} = require('../src/renderer/prepared-service-guard');

function fixture(overrides = {}) {
  return {
    presentations: {
      main: { loaded: true, source: 'prepared' },
      singers: { loaded: true, source: 'prepared' }
    },
    serviceHandoff: {
      project: {
        id: 'service-sunday',
        revisionId: 'a'.repeat(64),
        serviceDate: '2026-08-02'
      }
    },
    selectedDate: '2026-08-09',
    confirmedKeys: new Set(),
    ...overrides
  };
}

test('matching prepared-service dates need no confirmation', () => {
  const result = preparedServiceDateGuard(fixture({
    selectedDate: '2026-08-02'
  }));
  assert.equal(result.requiresConfirmation, false);
  assert.equal(result.key, null);
});

test('an exact date mismatch produces one revision-and-date-bound confirmation key', () => {
  const first = preparedServiceDateGuard(fixture());
  assert.equal(first.requiresConfirmation, true);
  assert.equal(
    first.key,
    `service-sunday:${'a'.repeat(64)}:2026-08-09`
  );
  const confirmed = preparedServiceDateGuard(fixture({
    confirmedKeys: new Set([first.key])
  }));
  assert.equal(confirmed.requiresConfirmation, false);
  assert.equal(confirmed.key, first.key);
});

test('manual, mixed, empty, or unbound Load state is never mislabeled as prepared', () => {
  for (const value of [
    fixture({ presentations: {} }),
    fixture({
      presentations: {
        main: { loaded: true, source: 'manual' }
      }
    }),
    fixture({
      presentations: {
        main: { loaded: true, source: 'prepared' },
        singers: { loaded: true, source: 'restored' }
      }
    }),
    fixture({ serviceHandoff: null })
  ]) {
    assert.equal(
      preparedServiceDateGuard(value).requiresConfirmation,
      false
    );
  }
});
