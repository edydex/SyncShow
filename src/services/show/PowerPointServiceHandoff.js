'use strict';

const { normalizeCacheRestoreContext } = require('./CacheRestoreResolver');

const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const SERVICE_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

/**
 * Resolve the ServiceSet provenance of only the presentation roles that the
 * immutable launch plan actually uses. A manual, native, stale, or mixed set
 * never becomes eligible for a post-show sermon follow-up.
 */
function resolvePowerPointServiceSetClaim({ launchPlan, presentations } = {}) {
  if (!isRecord(launchPlan)
    || !Array.isArray(launchPlan.outputs)
    || launchPlan.outputs.length < 1
    || !isRecord(presentations)) {
    return null;
  }

  const usedRoleIds = new Set();
  for (const output of launchPlan.outputs) {
    if (!isRecord(output)
      || typeof output.sourceRoleId !== 'string'
      || output.sourceRoleId.length === 0
      || output.renderer === 'native-cue') {
      return null;
    }
    usedRoleIds.add(output.sourceRoleId);
  }
  if (typeof launchPlan.timelineRoleId !== 'string'
    || !usedRoleIds.has(launchPlan.timelineRoleId)) {
    return null;
  }

  let serviceSetId = null;
  const roleAssets = [];
  for (const roleId of [...usedRoleIds].sort((left, right) =>
    left.localeCompare(right, 'en'))) {
    const presentation = presentations[roleId];
    if (!isRecord(presentation)
      || presentation.renderer === 'native-cue'
      || presentation.sourceType === 'service-project'
      || !isRecord(presentation.metadata)) {
      return null;
    }

    let restoreContext;
    try {
      restoreContext = normalizeCacheRestoreContext(
        presentation.metadata.restoreContext,
        { allowNull: false }
      );
    } catch (_error) {
      return null;
    }
    if (restoreContext.sourceKind !== 'service-set'
      || restoreContext.roleId !== roleId) {
      return null;
    }
    if (serviceSetId === null) serviceSetId = restoreContext.serviceSetId;
    if (restoreContext.serviceSetId !== serviceSetId) return null;
    roleAssets.push({
      roleId,
      assetId: restoreContext.assetId
    });
  }

  return deepFreeze({
    serviceSetId,
    roleAssets
  });
}

/**
 * Bind a provenance claim to one freshly verified current manifest. The
 * caller computes the fingerprint from that same verified manifest.
 */
function bindVerifiedPowerPointServiceSet({
  claim,
  manifest,
  activeProfileId,
  fingerprint
} = {}) {
  if (!isRecord(claim)
    || typeof claim.serviceSetId !== 'string'
    || !Array.isArray(claim.roleAssets)
    || claim.roleAssets.length < 1
    || !isRecord(manifest)
    || manifest.id !== claim.serviceSetId
    || typeof activeProfileId !== 'string'
    || manifest.profileId !== activeProfileId
    || typeof fingerprint !== 'string'
    || !SHA256_PATTERN.test(fingerprint)
    || typeof manifest.serviceDate !== 'string'
    || !SERVICE_DATE_PATTERN.test(manifest.serviceDate)
    || !isRecord(manifest.inputs)) {
    return null;
  }

  const seenRoleIds = new Set();
  for (const roleAsset of claim.roleAssets) {
    if (!isRecord(roleAsset)
      || typeof roleAsset.roleId !== 'string'
      || seenRoleIds.has(roleAsset.roleId)
      || typeof roleAsset.assetId !== 'string') {
      return null;
    }
    seenRoleIds.add(roleAsset.roleId);
    const input = manifest.inputs[roleAsset.roleId];
    if (!isRecord(input)
      || input.roleId !== roleAsset.roleId
      || input.assetId !== roleAsset.assetId) {
      return null;
    }
  }

  return deepFreeze({
    id: manifest.id,
    fingerprint,
    serviceDate: manifest.serviceDate,
    profileId: manifest.profileId
  });
}

module.exports = {
  bindVerifiedPowerPointServiceSet,
  resolvePowerPointServiceSetClaim
};
