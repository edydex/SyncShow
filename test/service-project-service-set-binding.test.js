'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  ServiceProjectError,
  addGroupItem,
  bindProjectToServiceSet,
  createServiceProject,
  normalizeServiceProject,
  serializeServiceProject
} = require('../src/services/project');

function project() {
  return createServiceProject({
    id: 'service-2026-07-26',
    title: 'Sunday Service',
    serviceDate: '2026-07-26',
    profileId: 'main-sanctuary'
  });
}

function binding(overrides = {}) {
  return {
    id: 'set-2026-07-26-main',
    fingerprint: 'a'.repeat(64),
    serviceDate: '2026-07-26',
    profileId: 'main-sanctuary',
    ...overrides
  };
}

test('service-set binding is optional, exact, portable, and retained by project mutations', () => {
  const original = project();
  assert.equal(original.sourceServiceSet, undefined);
  assert.doesNotMatch(serializeServiceProject(original), /sourceServiceSet/);

  const bound = bindProjectToServiceSet(original, binding());
  assert.deepEqual(bound.sourceServiceSet, binding());
  assert.deepEqual(bindProjectToServiceSet(bound, binding()), bound);
  const serialized = serializeServiceProject(bound);
  assert.match(serialized, /"sourceServiceSet"/);
  assert.deepEqual(normalizeServiceProject(JSON.parse(serialized)).sourceServiceSet, binding());

  const edited = addGroupItem(bound, {
    id: 'sermon',
    title: 'Sermon',
    groupKind: 'sermon'
  });
  assert.deepEqual(edited.sourceServiceSet, binding());
});

test('a project cannot be rebound to a same-date same-profile presentation set', () => {
  const bound = bindProjectToServiceSet(project(), binding());
  for (const conflicting of [
    binding({ id: 'set-evening-service' }),
    binding({ fingerprint: 'b'.repeat(64) })
  ]) {
    assert.throws(
      () => bindProjectToServiceSet(bound, conflicting),
      error => error instanceof ServiceProjectError
        && error.code === 'SERVICE_SET_BINDING_CONFLICT'
    );
  }
});

test('binding rejects presentation sets from another date or venue profile', () => {
  for (const mismatched of [
    binding({ serviceDate: '2026-07-27' }),
    binding({ profileId: 'evening-sanctuary' })
  ]) {
    assert.throws(
      () => bindProjectToServiceSet(project(), mismatched),
      error => error instanceof ServiceProjectError
        && error.code === 'SERVICE_SET_BINDING_MISMATCH'
    );
  }
});
