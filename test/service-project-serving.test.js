'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  MAX_SERVICE_PROJECT_SERVING_ASSIGNMENTS,
  ServiceProjectServingError,
  normalizeServiceProjectServing,
  pruneMissingServiceProjectServingItemScopes,
  rebindServiceProjectServingItemScopes,
  summarizeServiceProjectServing
} = require('../src/services/project/ServiceProjectServing');

function assignment(overrides = {}) {
  return {
    id: 'assignment-slides',
    role: 'Slides',
    personName: 'Maria S.',
    scope: { kind: 'service', itemId: null },
    status: 'assigned',
    required: true,
    callTime: '09:15',
    note: 'Check the confidence monitor.',
    ...overrides
  };
}

function serving(assignments = [assignment()]) {
  return {
    schemaVersion: 1,
    assignments
  };
}

function expectServingCode(code, callback) {
  assert.throws(callback, error => {
    assert.ok(error instanceof ServiceProjectServingError);
    assert.equal(error.code, code);
    return true;
  });
}

function assertDeeplyFrozen(value) {
  if (!value || typeof value !== 'object') return;
  assert.equal(Object.isFrozen(value), true);
  Object.values(value).forEach(assertDeeplyFrozen);
}

test('normalizes and deeply freezes service-wide and item serving assignments', () => {
  const normalized = normalizeServiceProjectServing(serving([
    assignment({
      role: '  Slides  ',
      personName: '  Mari\u0061 S.  ',
      note: 'First line.\r\nSecond line.'
    }),
    assignment({
      id: 'assignment-reader',
      role: 'Reader',
      personName: 'Oleh K.',
      scope: { kind: 'item', itemId: 'scripture-reading' },
      status: 'confirmed',
      required: false,
      callTime: null,
      note: ''
    })
  ]), {
    itemIds: ['scripture-reading']
  });

  assert.deepEqual(normalized, {
    schemaVersion: 1,
    assignments: [
      {
        id: 'assignment-slides',
        role: 'Slides',
        personName: 'Maria S.',
        scope: { kind: 'service', itemId: null },
        status: 'assigned',
        required: true,
        callTime: '09:15',
        note: 'First line.\nSecond line.'
      },
      {
        id: 'assignment-reader',
        role: 'Reader',
        personName: 'Oleh K.',
        scope: { kind: 'item', itemId: 'scripture-reading' },
        status: 'confirmed',
        required: false,
        callTime: null,
        note: ''
      }
    ]
  });
  assertDeeplyFrozen(normalized);
});

test('accepts an empty serving plan without item context', () => {
  assert.deepEqual(normalizeServiceProjectServing(serving([])), {
    schemaVersion: 1,
    assignments: []
  });
});

test('requires exact plan, assignment, and scope fields', () => {
  expectServingCode(
    'INVALID_SERVICE_PROJECT_SERVING_FIELDS',
    () => normalizeServiceProjectServing({
      ...serving(),
      directory: []
    })
  );
  const withContact = assignment({ email: 'maria@example.test' });
  expectServingCode(
    'INVALID_SERVICE_PROJECT_SERVING_FIELDS',
    () => normalizeServiceProjectServing(serving([withContact]))
  );
  const missingNote = assignment();
  delete missingNote.note;
  expectServingCode(
    'INVALID_SERVICE_PROJECT_SERVING_FIELDS',
    () => normalizeServiceProjectServing(serving([missingNote]))
  );
  expectServingCode(
    'INVALID_SERVICE_PROJECT_SERVING_FIELDS',
    () => normalizeServiceProjectServing(serving([
      assignment({
        scope: {
          kind: 'service',
          itemId: null,
          accountId: 'payload-user-4'
        }
      })
    ]))
  );
});

test('rejects unsupported versions, sparse arrays, oversized plans, and duplicate IDs', () => {
  expectServingCode(
    'UNSUPPORTED_SERVICE_PROJECT_SERVING',
    () => normalizeServiceProjectServing({
      ...serving(),
      schemaVersion: 2
    })
  );

  const sparse = [];
  sparse.length = 1;
  expectServingCode(
    'INVALID_SERVICE_PROJECT_SERVING_ASSIGNMENTS',
    () => normalizeServiceProjectServing(serving(sparse))
  );

  expectServingCode(
    'TOO_MANY_SERVICE_PROJECT_SERVING_ASSIGNMENTS',
    () => normalizeServiceProjectServing(serving(
      Array.from(
        { length: MAX_SERVICE_PROJECT_SERVING_ASSIGNMENTS + 1 },
        (_value, index) => assignment({ id: `assignment-${index}` })
      )
    ))
  );

  expectServingCode(
    'DUPLICATE_SERVICE_PROJECT_SERVING_ASSIGNMENT',
    () => normalizeServiceProjectServing(serving([
      assignment(),
      assignment({ role: 'Sound' })
    ]))
  );
});

test('enforces canonical IDs and bounded role, name, and note text', () => {
  for (const [code, value] of [
    ['INVALID_SERVICE_PROJECT_SERVING_ID', assignment({ id: '../slides' })],
    [
      'INVALID_SERVICE_PROJECT_SERVING_TEXT',
      assignment({ role: 'r'.repeat(121) })
    ],
    [
      'INVALID_SERVICE_PROJECT_SERVING_TEXT',
      assignment({ personName: 'p'.repeat(121) })
    ],
    [
      'INVALID_SERVICE_PROJECT_SERVING_TEXT',
      assignment({ note: 'n'.repeat(501) })
    ],
    [
      'INVALID_SERVICE_PROJECT_SERVING_TEXT',
      assignment({ role: 'Slides\noperator' })
    ]
  ]) {
    expectServingCode(
      code,
      () => normalizeServiceProjectServing(serving([value]))
    );
  }
});

test('enforces person and status invariants', () => {
  expectServingCode(
    'INVALID_SERVICE_PROJECT_SERVING_PERSON',
    () => normalizeServiceProjectServing(serving([
      assignment({ status: 'open' })
    ]))
  );
  expectServingCode(
    'INVALID_SERVICE_PROJECT_SERVING_PERSON',
    () => normalizeServiceProjectServing(serving([
      assignment({ status: 'confirmed', personName: null })
    ]))
  );
  expectServingCode(
    'INVALID_SERVICE_PROJECT_SERVING_STATUS',
    () => normalizeServiceProjectServing(serving([
      assignment({ status: 'maybe' })
    ]))
  );
  assert.equal(
    normalizeServiceProjectServing(serving([
      assignment({
        status: 'open',
        personName: null,
        callTime: null
      })
    ])).assignments[0].personName,
    null
  );
});

test('requires booleans and canonical local call times', () => {
  expectServingCode(
    'INVALID_SERVICE_PROJECT_SERVING_REQUIRED',
    () => normalizeServiceProjectServing(serving([
      assignment({ required: 1 })
    ]))
  );
  for (const callTime of ['', '9:15', '24:00', '09:60', undefined]) {
    expectServingCode(
      callTime === undefined
        ? 'INVALID_SERVICE_PROJECT_SERVING_FIELDS'
        : 'INVALID_SERVICE_PROJECT_SERVING_CALL_TIME',
      () => {
        const candidate = assignment({ callTime });
        if (callTime === undefined) delete candidate.callTime;
        normalizeServiceProjectServing(serving([candidate]));
      }
    );
  }
});

test('validates item scopes against the supplied project item IDs', () => {
  const itemAssignment = assignment({
    scope: { kind: 'item', itemId: 'sermon' }
  });
  expectServingCode(
    'UNKNOWN_SERVICE_PROJECT_SERVING_ITEM',
    () => normalizeServiceProjectServing(serving([itemAssignment]))
  );
  expectServingCode(
    'UNKNOWN_SERVICE_PROJECT_SERVING_ITEM',
    () => normalizeServiceProjectServing(
      serving([itemAssignment]),
      { itemIds: ['song'] }
    )
  );
  assert.equal(
    normalizeServiceProjectServing(
      serving([itemAssignment]),
      { itemIds: new Set(['sermon']) }
    ).assignments[0].scope.itemId,
    'sermon'
  );
  expectServingCode(
    'INVALID_SERVICE_PROJECT_SERVING_SCOPE',
    () => normalizeServiceProjectServing(serving([
      assignment({ scope: { kind: 'service', itemId: 'sermon' } })
    ]))
  );
});

test('summarizes filled, open, declined, required-open, and unique people', () => {
  const summary = summarizeServiceProjectServing(serving([
    assignment({
      id: 'slides',
      personName: 'Maria S.',
      status: 'confirmed'
    }),
    assignment({
      id: 'sound',
      role: 'Sound',
      personName: 'Maria S.',
      status: 'assigned'
    }),
    assignment({
      id: 'reader',
      role: 'Reader',
      personName: null,
      status: 'open',
      required: true
    }),
    assignment({
      id: 'welcome',
      role: 'Welcome',
      personName: null,
      status: 'open',
      required: false
    }),
    assignment({
      id: 'prayer',
      role: 'Prayer',
      personName: 'Oleh K.',
      status: 'declined',
      required: true
    })
  ]));

  assert.deepEqual(summary, {
    filled: 2,
    open: 2,
    declined: 1,
    requiredOpen: 2,
    uniquePeople: 1
  });
  assertDeeplyFrozen(summary);
});

test('prunes only assignments scoped to missing items', () => {
  const original = serving([
    assignment({ id: 'service-assignment' }),
    assignment({
      id: 'keep-item',
      role: 'Reader',
      scope: { kind: 'item', itemId: 'reading' }
    }),
    assignment({
      id: 'remove-item',
      role: 'Preacher',
      scope: { kind: 'item', itemId: 'sermon' }
    })
  ]);
  const pruned = pruneMissingServiceProjectServingItemScopes(
    original,
    { itemIds: ['reading'] }
  );

  assert.deepEqual(
    pruned.assignments.map(candidate => candidate.id),
    ['service-assignment', 'keep-item']
  );
  assert.equal(original.assignments.length, 3);
  assertDeeplyFrozen(pruned);
  expectServingCode(
    'INVALID_SERVICE_PROJECT_SERVING_ITEM_CONTEXT',
    () => pruneMissingServiceProjectServingItemScopes(original)
  );
});

test('rebinds item scopes while preserving service-wide assignments', () => {
  const original = serving([
    assignment({ id: 'service-assignment' }),
    assignment({
      id: 'reader',
      role: 'Reader',
      scope: { kind: 'item', itemId: 'old-reading' }
    })
  ]);
  const rebound = rebindServiceProjectServingItemScopes(
    original,
    new Map([['old-reading', 'new-reading']]),
    { itemIds: ['new-reading'] }
  );

  assert.deepEqual(rebound.assignments.map(candidate => candidate.scope), [
    { kind: 'service', itemId: null },
    { kind: 'item', itemId: 'new-reading' }
  ]);
  assert.equal(original.assignments[1].scope.itemId, 'old-reading');
  assertDeeplyFrozen(rebound);
});

test('rejects unsafe or incomplete item-scope rebindings', () => {
  const original = serving([
    assignment({
      scope: { kind: 'item', itemId: 'old-reading' }
    })
  ]);
  expectServingCode(
    'UNKNOWN_SERVICE_PROJECT_SERVING_REBINDING_TARGET',
    () => rebindServiceProjectServingItemScopes(
      original,
      { 'old-reading': 'missing-reading' },
      { itemIds: ['new-reading'] }
    )
  );
  expectServingCode(
    'UNKNOWN_SERVICE_PROJECT_SERVING_ITEM',
    () => rebindServiceProjectServingItemScopes(
      original,
      {},
      { itemIds: ['new-reading'] }
    )
  );
  expectServingCode(
    'INVALID_SERVICE_PROJECT_SERVING_REBINDINGS',
    () => rebindServiceProjectServingItemScopes(
      original,
      [['old-reading', 'new-reading']],
      { itemIds: ['new-reading'] }
    )
  );
});
