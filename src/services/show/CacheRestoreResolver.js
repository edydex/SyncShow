'use strict';

const CACHE_RESTORE_CONTEXT_SCHEMA_VERSION = 1;
const GROUP_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;
const ROLE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const ASSET_ID_PATTERN = /^sha256:[a-f0-9]{64}$/;
const SOURCE_KINDS = Object.freeze(['manual', 'service-set']);

class CacheRestoreError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'CacheRestoreError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new CacheRestoreError(code, message);
}

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/** Validate and detach provenance stored inside a transactional cache generation. */
function normalizeCacheRestoreContext(value, { allowNull = true } = {}) {
  if (value === undefined || value === null) {
    if (allowNull) return null;
    fail('MISSING_RESTORE_CONTEXT', 'A cache restore context is required.');
  }
  if (!isRecord(value)
    || value.schemaVersion !== CACHE_RESTORE_CONTEXT_SCHEMA_VERSION
    || typeof value.groupId !== 'string'
    || !GROUP_ID_PATTERN.test(value.groupId)
    || !SOURCE_KINDS.includes(value.sourceKind)
    || typeof value.roleId !== 'string'
    || !ROLE_ID_PATTERN.test(value.roleId)) {
    fail('INVALID_RESTORE_CONTEXT', 'The cache restore context is invalid.');
  }

  const context = {
    schemaVersion: CACHE_RESTORE_CONTEXT_SCHEMA_VERSION,
    groupId: value.groupId,
    sourceKind: value.sourceKind,
    roleId: value.roleId,
    serviceSetId: null,
    assetId: null
  };
  if (value.sourceKind === 'service-set') {
    if (typeof value.serviceSetId !== 'string'
      || value.serviceSetId !== value.groupId
      || !GROUP_ID_PATTERN.test(value.serviceSetId)
      || typeof value.assetId !== 'string'
      || !ASSET_ID_PATTERN.test(value.assetId)) {
      fail('INVALID_SERVICE_SET_RESTORE_CONTEXT', 'The ServiceSet cache identity is invalid.');
    }
    context.serviceSetId = value.serviceSetId;
    context.assetId = value.assetId;
  } else if ((value.serviceSetId !== undefined && value.serviceSetId !== null)
    || (value.assetId !== undefined && value.assetId !== null)) {
    fail('INVALID_MANUAL_RESTORE_CONTEXT', 'A manual cache cannot claim ServiceSet identity.');
  }
  return context;
}

function convertedAtMs(cache) {
  const parsed = Date.parse(cache.convertedAt || '');
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * Choose one compatible cache group for one-click restore. A partially
 * converted newer service therefore cannot be combined with an older role.
 * Legacy caches without provenance remain compatible with each other only.
 */
function resolveCacheRestorePlan(entries) {
  if (!Array.isArray(entries)) fail('INVALID_CACHE_ENTRIES', 'Cache entries must be an array.');
  const available = entries.filter(entry => entry?.exists === true);
  const contextual = [];
  const legacy = [];

  for (const entry of available) {
    if (typeof entry.roleId !== 'string' || !ROLE_ID_PATTERN.test(entry.roleId)) {
      fail('INVALID_CACHE_ROLE', 'A cached presentation has an invalid role.');
    }
    const restoreContext = normalizeCacheRestoreContext(entry.restoreContext);
    if (!restoreContext) {
      legacy.push({ ...entry, restoreContext: null });
      continue;
    }
    if (restoreContext.roleId !== entry.roleId) {
      fail('CACHE_ROLE_MISMATCH', 'A cached presentation belongs to a different role.');
    }
    contextual.push({ ...entry, restoreContext });
  }

  if (contextual.length === 0) {
    return {
      schemaVersion: 1,
      groupId: null,
      legacy: legacy.length > 0,
      caches: Object.fromEntries(legacy.map(entry => [entry.roleId, entry])),
      excludedRoleIds: []
    };
  }

  const groups = new Map();
  for (const entry of contextual) {
    const groupId = entry.restoreContext.groupId;
    const group = groups.get(groupId) || { groupId, entries: [], newestAtMs: 0 };
    group.entries.push(entry);
    group.newestAtMs = Math.max(group.newestAtMs, convertedAtMs(entry));
    groups.set(groupId, group);
  }
  const selected = [...groups.values()].sort((first, second) => (
    second.newestAtMs - first.newestAtMs
    || second.groupId.localeCompare(first.groupId, 'en')
  ))[0];
  const selectedRoleIds = new Set(selected.entries.map(entry => entry.roleId));

  return {
    schemaVersion: 1,
    groupId: selected.groupId,
    legacy: false,
    caches: Object.fromEntries(selected.entries.map(entry => [entry.roleId, entry])),
    excludedRoleIds: available
      .map(entry => entry.roleId)
      .filter(roleId => !selectedRoleIds.has(roleId))
  };
}

module.exports = {
  CACHE_RESTORE_CONTEXT_SCHEMA_VERSION,
  CacheRestoreError,
  normalizeCacheRestoreContext,
  resolveCacheRestorePlan
};
