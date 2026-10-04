'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  preparedServiceDateGuard, isPastServiceDate
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
    currentDate: '2026-08-09',
    confirmedKeys: new Set(),
    ...overrides
  };
}

test('today and future prepared services need no confirmation', () => {
  for (const currentDate of ['2026-08-02', '2026-08-01', '2026-07-31']) {
    const result = preparedServiceDateGuard(fixture({currentDate}));
    assert.equal(result.requiresConfirmation, false);
    assert.equal(result.key, null);
  }
});

test('an older service asks once per revision and current day', () => {
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
  assert.equal(preparedServiceDateGuard(fixture({
    currentDate: '2026-08-10', confirmedKeys: new Set([first.key])
  })).requiresConfirmation, true);
  const revised = fixture({confirmedKeys: new Set([first.key])});
  revised.serviceHandoff.project.revisionId = 'b'.repeat(64);
  assert.equal(preparedServiceDateGuard(revised).requiresConfirmation, true);
});

test('only real, dated services strictly before the current day are old', () => {
  assert.equal(isPastServiceDate('2026-10-02', '2026-10-03'), true);
  assert.equal(isPastServiceDate('2026-10-03', '2026-10-03'), false);
  assert.equal(isPastServiceDate('2026-10-04', '2026-10-03'), false);
  assert.equal(isPastServiceDate('2026-12-31', '2027-01-01'), true);
  for (const invalid of [null, '', 'invalid', '2026-02-30', '2026-13-01']) {
    assert.equal(isPastServiceDate(invalid, '2026-10-03'), false);
    assert.equal(isPastServiceDate('2026-10-02', invalid), false);
  }
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
