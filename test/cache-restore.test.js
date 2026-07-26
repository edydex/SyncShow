'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  CacheRestoreError,
  normalizeCacheRestoreContext,
  resolveCacheRestorePlan
} = require('../src/services/show/CacheRestoreResolver');

const ASSET_A = `sha256:${'a'.repeat(64)}`;

function cache(roleId, groupId, convertedAt, sourceKind = 'service-set') {
  return {
    roleId,
    exists: true,
    slideCount: 12,
    originalFile: `${roleId}.pptx`,
    convertedAt,
    restoreContext: groupId === null ? null : {
      schemaVersion: 1,
      groupId,
      sourceKind,
      roleId,
      ...(sourceKind === 'service-set'
        ? { serviceSetId: groupId, assetId: ASSET_A }
        : {})
    }
  };
}

test('restart restore chooses only the newest compatible generation after a partial conversion', () => {
  const plan = resolveCacheRestorePlan([
    cache('english', 'service-b', '2026-07-22T12:00:00.000Z'),
    cache('russian', 'service-a', '2026-07-20T12:00:00.000Z'),
    cache('media', 'service-a', '2026-07-20T12:01:00.000Z')
  ]);

  assert.equal(plan.groupId, 'service-b');
  assert.deepEqual(Object.keys(plan.caches), ['english']);
  assert.deepEqual(plan.excludedRoleIds, ['russian', 'media']);
});

test('manual replacements intentionally sharing the active group restore with ServiceSet inputs', () => {
  const plan = resolveCacheRestorePlan([
    cache('english', 'service-b', '2026-07-22T12:00:00.000Z'),
    cache('media', 'service-b', '2026-07-22T12:05:00.000Z', 'manual')
  ]);

  assert.equal(plan.groupId, 'service-b');
  assert.deepEqual(Object.keys(plan.caches), ['english', 'media']);
  assert.deepEqual(plan.excludedRoleIds, []);
});

test('legacy caches remain compatible with each other but never mix into contextual groups', () => {
  const legacyPlan = resolveCacheRestorePlan([
    cache('english', null, null),
    cache('russian', null, null)
  ]);
  assert.equal(legacyPlan.legacy, true);
  assert.deepEqual(Object.keys(legacyPlan.caches), ['english', 'russian']);

  const contextualPlan = resolveCacheRestorePlan([
    cache('english', 'manual:new', '2026-07-22T12:00:00.000Z', 'manual'),
    cache('russian', null, null)
  ]);
  assert.equal(contextualPlan.legacy, false);
  assert.deepEqual(Object.keys(contextualPlan.caches), ['english']);
  assert.deepEqual(contextualPlan.excludedRoleIds, ['russian']);
});

test('restore group selection is deterministic on equal timestamps', () => {
  const plan = resolveCacheRestorePlan([
    cache('english', 'group-a', '2026-07-22T12:00:00.000Z', 'manual'),
    cache('russian', 'group-b', '2026-07-22T12:00:00.000Z', 'manual')
  ]);
  assert.equal(plan.groupId, 'group-b');
  assert.deepEqual(Object.keys(plan.caches), ['russian']);
});

test('cache provenance rejects role mismatches and unbounded renderer group IDs', () => {
  assert.throws(
    () => resolveCacheRestorePlan([{
      ...cache('english', 'service-a', '2026-07-22T12:00:00.000Z'),
      restoreContext: {
        ...cache('english', 'service-a', '2026-07-22T12:00:00.000Z').restoreContext,
        roleId: 'russian'
      }
    }]),
    error => error instanceof CacheRestoreError && error.code === 'CACHE_ROLE_MISMATCH'
  );
  assert.throws(
    () => normalizeCacheRestoreContext({
      schemaVersion: 1,
      groupId: `manual:${'x'.repeat(300)}`,
      sourceKind: 'manual',
      roleId: 'english'
    }, { allowNull: false }),
    error => error instanceof CacheRestoreError && error.code === 'INVALID_RESTORE_CONTEXT'
  );
});
