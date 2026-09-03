'use strict';

const crypto = require('crypto');

const {
  bindCommunityServicePlanBaseline,
  normalizeServiceProject,
  pruneUnreachableProjectRecords,
  repinSermonRevision,
  resolveSermonSourceLink,
  serializeServiceProject
} = require('../project/ServiceProject');
const {
  pruneMissingServiceProjectServingItemScopes
} = require('../project/ServiceProjectServing');
const {
  communityServicePlanChannelContractSha256,
  communityServicePlanItemContentSpecSha256,
  communityServicePlanItemContentSha256,
  communityServicePlanItemDependentStateSha256,
  communityServicePlanItemRelationshipSha256,
  communityServicePlanItemStateSha256,
  communityServicePlanItemTitleSha256,
  deriveCommunityServicePlanBaselineWithComponentOverrides,
  normalizeCommunityServicePlanBaseline
} = require('./CommunityServicePlanBaseline');

const MAX_COMMUNITY_PLAN_RECONCILIATION_CONFLICTS = 500;
const CHOICES = Object.freeze(['keep-local', 'use-community']);
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

class CommunityServicePlanReconciliationError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'CommunityServicePlanReconciliationError';
    this.code = code;
    this.details = details;
  }
}

function fail(code, message, details = {}) {
  throw new CommunityServicePlanReconciliationError(
    code,
    message,
    details
  );
}

function isRecord(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.keys(value).sort().map(key => [key, stableValue(value[key])])
  );
}

function stableJson(value) {
  return JSON.stringify(stableValue(value));
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function equal(left, right) {
  return stableJson(left) === stableJson(right);
}

function freezeDeep(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) {
    return value;
  }
  Object.freeze(value);
  for (const child of Object.values(value)) freezeDeep(child);
  return value;
}

function projectPlacement(project) {
  const byItemId = new Map();
  const childrenByParent = new Map([[null, [...project.rootItemIds]]]);
  const visit = (itemId, parentItemId, index) => {
    const item = project.items[itemId];
    if (!item) return;
    byItemId.set(itemId, { parentItemId, index });
    if (item.kind !== 'group') return;
    childrenByParent.set(itemId, [...item.childIds]);
    item.childIds.forEach((childId, childIndex) =>
      visit(childId, itemId, childIndex));
  };
  project.rootItemIds.forEach((itemId, index) => visit(itemId, null, index));
  return { byItemId, childrenByParent };
}

function baselinePlacement(baseline) {
  const byItemId = new Map();
  const childrenByParent = new Map();
  for (const container of baseline.containers) {
    childrenByParent.set(
      container.parentItemId,
      [...container.childItemIds]
    );
    container.childItemIds.forEach((itemId, index) => {
      byItemId.set(itemId, {
        parentItemId: container.parentItemId,
        index
      });
    });
  }
  return { byItemId, childrenByParent };
}

function descendants(project, rootItemId) {
  const result = new Set();
  const visit = itemId => {
    if (result.has(itemId)) return;
    result.add(itemId);
    const item = project.items[itemId];
    if (item?.kind === 'group') item.childIds.forEach(visit);
  };
  visit(rootItemId);
  return result;
}

function describeItem(item, fallback = 'Service item') {
  return String(item?.title || fallback).slice(0, 200);
}

function entryByItemId(baseline) {
  return new Map(baseline.entries.map(entry => [entry.itemId, entry]));
}

function mergeMissingItems(primary, secondary, allowedIds) {
  const result = primary.filter(itemId => allowedIds.has(itemId));
  for (const itemId of secondary) {
    if (!allowedIds.has(itemId) || result.includes(itemId)) continue;
    const secondaryIndex = secondary.indexOf(itemId);
    let previous = null;
    for (let index = secondaryIndex - 1; index >= 0; index -= 1) {
      if (result.includes(secondary[index])) {
        previous = secondary[index];
        break;
      }
    }
    if (previous !== null) {
      result.splice(result.indexOf(previous) + 1, 0, itemId);
      continue;
    }
    let next = null;
    for (
      let index = secondaryIndex + 1;
      index < secondary.length;
      index += 1
    ) {
      if (result.includes(secondary[index])) {
        next = secondary[index];
        break;
      }
    }
    if (next !== null) {
      result.splice(result.indexOf(next), 0, itemId);
    } else {
      result.push(itemId);
    }
  }
  for (const itemId of [...allowedIds].sort()) {
    if (!result.includes(itemId)) result.push(itemId);
  }
  return result;
}

function relativeOrderChanged(baseSequence, sideSequence) {
  const sideIds = new Set(sideSequence);
  const baseProjection = baseSequence.filter(itemId => sideIds.has(itemId));
  const baseIds = new Set(baseSequence);
  const sideProjection = sideSequence.filter(itemId => baseIds.has(itemId));
  return !equal(baseProjection, sideProjection);
}

function normalizeDecisions(raw, conflicts, { required }) {
  if (raw === undefined || raw === null) {
    if (required && conflicts.length > 0) {
      fail(
        'COMMUNITY_PLAN_RECONCILIATION_DECISIONS_REQUIRED',
        'Choose Local or Community for every reconciliation conflict.'
      );
    }
    return new Map();
  }
  if (!Array.isArray(raw) || raw.length > MAX_COMMUNITY_PLAN_RECONCILIATION_CONFLICTS) {
    fail(
      'INVALID_COMMUNITY_PLAN_RECONCILIATION_DECISIONS',
      'Community reconciliation decisions must be a bounded list.'
    );
  }
  const conflictIds = new Set(conflicts.map(conflict => conflict.conflictId));
  const decisions = new Map();
  for (const [index, decision] of raw.entries()) {
    if (
      !isRecord(decision)
      || Object.keys(decision).length !== 2
      || !Object.prototype.hasOwnProperty.call(decision, 'conflictId')
      || !Object.prototype.hasOwnProperty.call(decision, 'choice')
      || typeof decision.conflictId !== 'string'
      || !ID_PATTERN.test(decision.conflictId)
      || !CHOICES.includes(decision.choice)
      || !conflictIds.has(decision.conflictId)
      || decisions.has(decision.conflictId)
    ) {
      fail(
        'INVALID_COMMUNITY_PLAN_RECONCILIATION_DECISIONS',
        `Community reconciliation decision ${index + 1} is invalid.`
      );
    }
    decisions.set(decision.conflictId, decision.choice);
  }
  if (required && decisions.size !== conflicts.length) {
    fail(
      'COMMUNITY_PLAN_RECONCILIATION_DECISIONS_REQUIRED',
      'Choose Local or Community for every reconciliation conflict.'
    );
  }
  return decisions;
}

function localPresentationOverlay(localItem, remoteItem, {
  preserveDependentState = true
} = {}) {
  const next = clone(remoteItem);
  if (!localItem || localItem.kind !== remoteItem.kind) return next;
  next.createdAt = localItem.createdAt;
  if (Object.prototype.hasOwnProperty.call(localItem, 'operatorNotes')) {
    next.operatorNotes = localItem.operatorNotes;
  }
  if (Object.prototype.hasOwnProperty.call(
    localItem,
    'plannedDurationSeconds'
  )) {
    next.plannedDurationSeconds = localItem.plannedDurationSeconds;
  } else {
    delete next.plannedDurationSeconds;
  }
  if (remoteItem.kind === 'song') {
    next.titlePresetId = localItem.titlePresetId;
    next.lyricsPresetId = localItem.lyricsPresetId;
    if (preserveDependentState) {
      next.arrangement = clone(localItem.arrangement);
      if (localItem.sourceRangeReplacement) {
        next.sourceRangeReplacement = clone(
          localItem.sourceRangeReplacement
        );
      } else {
        delete next.sourceRangeReplacement;
      }
    }
  } else if (remoteItem.kind === 'bible') {
    next.presetId = localItem.presetId;
    if (preserveDependentState) {
      next.passagesByChannel = clone(localItem.passagesByChannel);
    }
  }
  return next;
}

function addItemRecordCandidates(project, item, resourceIds, assetIds) {
  if (!item) return;
  if (item.sermonResourceId) resourceIds.add(item.sermonResourceId);
  if (item.kind === 'bible' && item.sermonReading) {
    resourceIds.add(item.sermonReading.sermonResourceId);
  }
  if (item.kind === 'song') {
    for (const variant of Object.values(item.variants)) {
      if (variant.mode === 'content') resourceIds.add(variant.resourceId);
    }
  } else if (item.kind === 'picture') {
    if (item.assetIdsByChannel) {
      Object.values(item.assetIdsByChannel).forEach(assetId =>
        assetIds.add(assetId));
    } else {
      assetIds.add(item.assetId);
    }
  } else if (item.kind === 'imported-deck') {
    Object.values(item.assetIdsByChannel).forEach(assetId =>
      assetIds.add(assetId));
  }
}

function reconciliationProjectSha256(project) {
  const raw = JSON.parse(serializeServiceProject(project));
  const sentinelTimestamp = '2000-01-01T00:00:00.000Z';
  raw.revision = 0;
  raw.createdAt = sentinelTimestamp;
  raw.updatedAt = sentinelTimestamp;
  if (raw.planning?.source) {
    raw.planning.source.importedAt = sentinelTimestamp;
  }
  if (raw.planning) {
    delete raw.planning.lastReconciliationReceipt;
  }
  const clearItemTimes = item => {
    item.createdAt = sentinelTimestamp;
    item.updatedAt = sentinelTimestamp;
  };
  Object.values(raw.items).forEach(clearItemTimes);
  return sha256(stableJson(raw));
}

function buildCommunityServicePlanReconciliation({
  baseline: rawBaseline,
  localProject: rawLocalProject,
  communityProject: rawCommunityProject,
  communityBaseline: rawCommunityBaseline,
  decisions: rawDecisions = null,
  requireDecisions = false
} = {}) {
  const baseline = normalizeCommunityServicePlanBaseline(rawBaseline);
  const communityBaseline =
    normalizeCommunityServicePlanBaseline(rawCommunityBaseline);
  if (baseline.schemaVersion !== 2 || communityBaseline.schemaVersion !== 2) {
    fail(
      'COMMUNITY_PLAN_BASELINE_COMPONENTS_UNAVAILABLE',
      'This older Community baseline cannot be reconciled component by component. Use the explicit legacy fallback after reviewing the whole replacement.'
    );
  }
  const localProject = normalizeServiceProject(rawLocalProject);
  const communityProject = normalizeServiceProject(rawCommunityProject);
  const localSource = localProject.planning?.source;
  const remoteSource = communityProject.planning?.source;
  if (
    localProject.id !== communityProject.id
    || localSource?.kind !== 'community-plan'
    || remoteSource?.kind !== 'community-plan'
    || localSource.serverId !== remoteSource.serverId
    || localSource.planId !== remoteSource.planId
    || baseline.planRevision !== localSource.planRevision
    || communityBaseline.planRevision !== remoteSource.planRevision
  ) {
    fail(
      'COMMUNITY_PLAN_RECONCILIATION_BINDING_MISMATCH',
      'Community reconciliation inputs do not describe one exact local plan lineage.'
    );
  }
  const localChannelHash =
    communityServicePlanChannelContractSha256(localProject);
  const remoteChannelHash =
    communityServicePlanChannelContractSha256(communityProject);
  if (
    baseline.channelContractSha256 !== localChannelHash
    || communityBaseline.channelContractSha256 !== localChannelHash
    || remoteChannelHash !== localChannelHash
  ) {
    fail(
      'LOCAL_OUTPUT_PROFILE_DIVERGED',
      'This service output profile changed after import. Reconcile the output profile before applying a Community revision.',
      {
        baselineChannelContractSha256: baseline.channelContractSha256,
        localChannelContractSha256: localChannelHash,
        communityChannelContractSha256:
          communityBaseline.channelContractSha256
      }
    );
  }

  const baseEntries = entryByItemId(baseline);
  const remoteEntries = entryByItemId(communityBaseline);
  const basePlacement = baselinePlacement(baseline);
  const remotePlacement = baselinePlacement(communityBaseline);
  const localPlacement = projectPlacement(localProject);
  const conflictSeed = [
    baseline.projectionSha256,
    communityBaseline.projectionSha256,
    localSource.planRevision,
    remoteSource.planRevision
  ].join('\u0000');
  const conflicts = [];
  const conflictKeys = new Set();
  const pendingConflictChoices = new Map();

  const addConflict = ({
    key,
    kind,
    itemId = null,
    entryId = null,
    title,
    localSummary,
    communitySummary
  }) => {
    if (conflictKeys.has(key)) {
      return pendingConflictChoices.get(key);
    }
    conflictKeys.add(key);
    const conflictId = `reconcile-${sha256(
      `${conflictSeed}\u0000${key}`
    ).slice(0, 40)}`;
    const conflict = {
      conflictId,
      kind,
      itemId,
      entryId,
      title: String(title || 'Service-plan conflict').slice(0, 200),
      local: {
        choice: 'keep-local',
        summary: String(localSummary).slice(0, 500)
      },
      community: {
        choice: 'use-community',
        summary: String(communitySummary).slice(0, 500)
      }
    };
    conflicts.push(conflict);
    pendingConflictChoices.set(key, conflictId);
    return conflictId;
  };

  const baseIds = new Set(baseEntries.keys());
  const remoteIds = new Set(remoteEntries.keys());
  const localIds = new Set(Object.keys(localProject.items));
  const retainedCollisionBoundaryItemIds = new Set(
    localProject.planning?.localCollisionBoundaryItemIds || []
  );
  const managedIds = new Set([...baseIds, ...remoteIds]);
  const selected = new Map();
  const selectedSource = new Map();
  const titleSelections = new Map();
  const forcedRemovalIds = new Set();
  const baselineComponentOverrides = [];
  const sermonPinChangesByItemId = new Map();
  const sermonReplacementChangesByItemId = new Map();
  const sermonPinChangesByReadingItemId = new Map();
  const sermonPinChangesByTargetResourceId = new Map();
  const sermonPinChangesByPreviousResourceId = new Map();
  const sermonPinChangeGroups = [];
  const sermonReplacementChangesByTargetResourceId = new Map();
  const sermonReplacementChangesByPreviousResourceId = new Map();
  const sermonReplacementChangeGroups = [];
  const candidateResourceIds = new Set(
    Object.keys(communityProject.resources)
  );
  const candidateAssetIds = new Set(Object.keys(communityProject.assets));
  for (const itemId of baseIds) {
    addItemRecordCandidates(
      localProject,
      localProject.items[itemId],
      candidateResourceIds,
      candidateAssetIds
    );
  }
  let preservedLocalItemCount = 0;
  let appliedCommunityItemCount = 0;
  let autoMergedItemCount = 0;

  const placementChangedFromBaseline = (itemId, sidePlacement) => {
    const baseItemPlacement = basePlacement.byItemId.get(itemId);
    const sideItemPlacement = sidePlacement.byItemId.get(itemId);
    if (!baseItemPlacement || !sideItemPlacement) return true;
    if (baseItemPlacement.parentItemId !== sideItemPlacement.parentItemId) {
      return true;
    }
    const parentItemId = baseItemPlacement.parentItemId;
    const baseSiblings =
      basePlacement.childrenByParent.get(parentItemId) || [];
    const sideSiblings =
      sidePlacement.childrenByParent.get(parentItemId) || [];
    const sideSiblingIndex = new Map(
      sideSiblings.map((siblingId, index) => [siblingId, index])
    );
    for (const siblingId of baseSiblings) {
      if (
        siblingId === itemId
        || !sideSiblingIndex.has(siblingId)
        || sidePlacement.byItemId.get(siblingId)?.parentItemId
          !== parentItemId
      ) {
        continue;
      }
      const baseBefore =
        baseSiblings.indexOf(itemId) < baseSiblings.indexOf(siblingId);
      const sideBefore =
        sideSiblingIndex.get(itemId) < sideSiblingIndex.get(siblingId);
      if (baseBefore !== sideBefore) return true;
    }
    return false;
  };

  const placementDescendants = (placement, itemId) => {
    const result = new Set();
    const collect = parentItemId => {
      for (
        const childId
        of placement.childrenByParent.get(parentItemId) || []
      ) {
        if (result.has(childId)) continue;
        result.add(childId);
        collect(childId);
      }
    };
    collect(itemId);
    return result;
  };

  const groupHasLocalDescendantWork = itemId => {
    const baseGroup = baseEntries.get(itemId);
    const localGroup = localProject.items[itemId];
    if (!baseGroup || !localGroup) return false;
    const baseDescendantIds =
      placementDescendants(basePlacement, itemId);
    const localDescendantIds = descendants(localProject, itemId);
    localDescendantIds.delete(itemId);
    if (
      baseDescendantIds.size !== localDescendantIds.size
      || [...baseDescendantIds].some(
        descendantId => !localDescendantIds.has(descendantId)
      )
    ) {
      return true;
    }
    for (const descendantId of baseDescendantIds) {
      const baseDescendant = baseEntries.get(descendantId);
      if (
        !baseDescendant
        || communityServicePlanItemStateSha256(
          localProject,
          descendantId
        ) !== baseDescendant.stateSha256
        || placementChangedFromBaseline(descendantId, localPlacement)
      ) {
        return true;
      }
    }
    return false;
  };
  const remoteGroupSubtreeChanged = itemId => {
    const baseDescendantIds =
      placementDescendants(basePlacement, itemId);
    const remoteDescendantIds =
      placementDescendants(remotePlacement, itemId);
    if (
      baseDescendantIds.size !== remoteDescendantIds.size
      || [...baseDescendantIds].some(
        descendantId => !remoteDescendantIds.has(descendantId)
      )
    ) {
      return true;
    }
    for (const descendantId of baseDescendantIds) {
      const baseDescendant = baseEntries.get(descendantId);
      const remoteDescendant = remoteEntries.get(descendantId);
      if (
        !baseDescendant
        || !remoteDescendant
        || remoteDescendant.sourceSha256 !== baseDescendant.sourceSha256
        || placementChangedFromBaseline(descendantId, remotePlacement)
      ) {
        return true;
      }
    }
    return false;
  };
  const groupHasLocalWork = itemId => {
    const baseGroup = baseEntries.get(itemId);
    return Boolean(
      baseGroup
      && (
        communityServicePlanItemStateSha256(localProject, itemId)
          !== baseGroup.stateSha256
        || groupHasLocalDescendantWork(itemId)
      )
    );
  };

  for (const [itemId, baseEntry] of baseEntries) {
    if (baseEntry.entryKind !== 'sermon') continue;
    const remoteEntry = remoteEntries.get(itemId);
    const localItem = localProject.items[itemId];
    const remoteItem = communityProject.items[itemId];
    if (
      !remoteEntry
      || !localItem
      || !remoteItem
      || localItem.kind !== 'group'
      || remoteItem.kind !== 'group'
      || !localItem.sermonResourceId
      || !remoteItem.sermonResourceId
      || remoteEntry.contentSpecSha256 === baseEntry.contentSpecSha256
      || localItem.sermonResourceId === remoteItem.sermonResourceId
    ) {
      continue;
    }
    const localSpecChanged =
      communityServicePlanItemContentSpecSha256(localProject, itemId)
        !== baseEntry.contentSpecSha256;
    const localSermonId =
      localProject.resources[localItem.sermonResourceId]?.document?.id;
    const remoteSermonId =
      communityProject.resources[remoteItem.sermonResourceId]?.document?.id;
    if (localSermonId !== remoteSermonId) {
      let replacement =
        sermonReplacementChangesByTargetResourceId.get(
          remoteItem.sermonResourceId
        );
      if (!replacement) {
        replacement = {
          type: 'sermon-replacement',
          nextResourceId: remoteItem.sermonResourceId,
          previousResourceIds: new Set(),
          ownerRecords: [],
          readingItemIds: new Set(),
          readingContentWorkItemIds: new Set(),
          readingLocalWorkItemIds: new Set(),
          conflictId: null
        };
        sermonReplacementChangesByTargetResourceId.set(
          remoteItem.sermonResourceId,
          replacement
        );
        sermonReplacementChangeGroups.push(replacement);
      }
      const existingReplacement =
        sermonReplacementChangesByPreviousResourceId.get(
          localItem.sermonResourceId
        );
      if (existingReplacement && existingReplacement !== replacement) {
        fail(
          'COMMUNITY_SERMON_REPLACEMENT_SCOPE_OVERLAP',
          'One local sermon occurrence cannot be replaced by two different Community sermons in one refresh.',
          { previousResourceId: localItem.sermonResourceId }
        );
      }
      replacement.previousResourceIds.add(localItem.sermonResourceId);
      replacement.ownerRecords.push({
        itemId,
        entryId: remoteEntry.entryId,
        title: describeItem(localItem, remoteEntry.entryId),
        localSpecChanged,
        localDescendantWork: groupHasLocalDescendantWork(itemId)
      });
      sermonReplacementChangesByPreviousResourceId.set(
        localItem.sermonResourceId,
        replacement
      );
      continue;
    }
    let change = sermonPinChangesByTargetResourceId.get(
      remoteItem.sermonResourceId
    );
    if (!change) {
      change = {
        nextResourceId: remoteItem.sermonResourceId,
        previousResourceIds: new Set(),
        ownerRecords: [],
        readingItemIds: new Set(),
        readingContentWorkItemIds: new Set(),
        readingLocalWorkItemIds: new Set(),
        externalLocalReferenceIds: new Set(),
        conflictId: null
      };
      sermonPinChangesByTargetResourceId.set(
        remoteItem.sermonResourceId,
        change
      );
      sermonPinChangeGroups.push(change);
    }
    const existingChange = sermonPinChangesByPreviousResourceId.get(
      localItem.sermonResourceId
    );
    if (existingChange && existingChange !== change) {
      fail(
        'COMMUNITY_SERMON_REPIN_SCOPE_OVERLAP',
        'One local sermon revision cannot be reconciled to two different Community revisions in one refresh.',
        {
          previousResourceId: localItem.sermonResourceId,
          nextResourceIds: [
            existingChange.nextResourceId,
            change.nextResourceId
          ].sort()
        }
      );
    }
    change.previousResourceIds.add(localItem.sermonResourceId);
    change.ownerRecords.push({
      itemId,
      entryId: remoteEntry.entryId,
      title: describeItem(localItem, remoteEntry.entryId),
      previousResourceId: localItem.sermonResourceId,
      localSpecChanged,
      localDescendantWork: groupHasLocalDescendantWork(itemId)
    });
    sermonPinChangesByPreviousResourceId.set(
      localItem.sermonResourceId,
      change
    );
  }

  // The general sermon-repin mutation is intentionally resource-global. Reject
  // chains and swaps up front: sequential A->B and B->C operations cannot
  // reproduce two independently reviewed Community owner pins.
  for (const change of sermonPinChangeGroups) {
    const overlappingChange =
      sermonPinChangesByPreviousResourceId.get(change.nextResourceId);
    if (overlappingChange) {
      fail(
        'COMMUNITY_SERMON_REPIN_SCOPE_OVERLAP',
        'Overlapping sermon revision changes cannot be applied as one deterministic Community refresh.',
        {
          resourceId: change.nextResourceId,
          nextResourceIds: [
            change.nextResourceId,
            overlappingChange.nextResourceId
          ].sort()
        }
      );
    }
  }

  // Bind every managed reading that participates in one of the resource-global
  // repins to the same decision, including a Community unlink. This prevents a
  // "Keep local" sermon choice from separately accepting a linked-reading
  // change.
  const managedReadingItemIds = new Set([
    ...[...baseEntries.entries()]
      .filter(([, entry]) => entry.entryKind === 'scripture')
      .map(([itemId]) => itemId),
    ...[...remoteEntries.entries()]
      .filter(([, entry]) => entry.entryKind === 'scripture')
      .map(([itemId]) => itemId)
  ]);
  for (const readingItemId of managedReadingItemIds) {
    const readingBaseEntry = baseEntries.get(readingItemId) || null;
    const localReading = localProject.items[readingItemId];
    const remoteReading = communityProject.items[readingItemId];
    const localResourceId =
      localReading?.kind === 'bible'
        ? localReading.sermonReading?.sermonResourceId || null
        : null;
    const remoteResourceId =
      remoteReading?.kind === 'bible'
        ? remoteReading.sermonReading?.sermonResourceId || null
        : null;
    const candidateChanges = new Set();
    if (localResourceId) {
      const byPrevious =
        sermonPinChangesByPreviousResourceId.get(localResourceId);
      if (byPrevious) candidateChanges.add(byPrevious);
    }
    if (remoteResourceId) {
      const byTarget =
        sermonPinChangesByTargetResourceId.get(remoteResourceId);
      if (byTarget) candidateChanges.add(byTarget);
    }
    if (candidateChanges.size > 1) {
      fail(
        'COMMUNITY_SERMON_REPIN_SCOPE_OVERLAP',
        'A linked Scripture reading crosses two sermon revision changes and cannot be reconciled deterministically.',
        { itemId: readingItemId }
      );
    }
    const [change] = candidateChanges;
    if (!change) continue;
    if (
      remoteResourceId
      && change.previousResourceIds.has(remoteResourceId)
    ) {
      fail(
        'COMMUNITY_SERMON_REPIN_SCOPE_OVERLAP',
        'The Community candidate retains a linked reading on a sermon revision that another owner moves away from.',
        {
          itemId: readingItemId,
          resourceId: remoteResourceId
        }
      );
    }
    change.readingItemIds.add(readingItemId);
    let localWork = false;
    if (readingBaseEntry) {
      if (localReading?.kind !== 'bible') {
        localWork = true;
      } else {
        const contentWork =
          communityServicePlanItemContentSpecSha256(
            localProject,
            readingItemId
          ) !== readingBaseEntry.contentSpecSha256
          || communityServicePlanItemDependentStateSha256(
            localProject,
            readingItemId
          ) !== readingBaseEntry.dependentStateSha256;
        if (contentWork) {
          change.readingContentWorkItemIds.add(readingItemId);
        }
        localWork =
          contentWork
          || communityServicePlanItemRelationshipSha256(
            localProject,
            readingItemId
          ) !== readingBaseEntry.relationshipSha256
          || placementChangedFromBaseline(readingItemId, localPlacement);
      }
    } else if (localReading) {
      localWork = true;
    }
    if (localWork) change.readingLocalWorkItemIds.add(readingItemId);
    sermonPinChangesByReadingItemId.set(readingItemId, change);
  }

  for (const change of sermonPinChangeGroups) {
    const expectedAffectedItemIds = new Set(change.readingItemIds);
    for (const owner of change.ownerRecords) {
      for (const descendantId of descendants(localProject, owner.itemId)) {
        expectedAffectedItemIds.add(descendantId);
      }
    }
    for (const [itemId, item] of Object.entries(localProject.items)) {
      let affected =
        change.previousResourceIds.has(item.sermonResourceId)
        || (
          item.kind === 'bible'
          && change.previousResourceIds.has(
            item.sermonReading?.sermonResourceId
          )
        );
      if (
        !affected
        && item.kind === 'sermon'
        && item.sourceBodyProjection
      ) {
        affected = change.previousResourceIds.has(
          resolveSermonSourceLink(localProject, item)?.resourceId
        );
      }
      if (!affected || expectedAffectedItemIds.has(itemId)) continue;
      if (baseEntries.has(itemId)) {
        fail(
          'COMMUNITY_SERMON_REPIN_SCOPE_OVERLAP',
          'A Community-managed cue still depends on a sermon revision that only another owner changes.',
          { itemId }
        );
      }
      change.externalLocalReferenceIds.add(itemId);
    }

    // Prove every resource-global Community repin before exposing it as a
    // selectable outcome. The domain contract validates sermon identity,
    // sections, confirmed-primary readings, and inherited body projections.
    for (const previousResourceId of [...change.previousResourceIds].sort()) {
      try {
        const preflight = clone(localProject);
        preflight.resources = {
          ...clone(localProject.resources),
          ...clone(communityProject.resources)
        };
        for (const readingItemId of change.readingItemIds) {
          const localReading = preflight.items[readingItemId];
          if (localReading?.kind !== 'bible') continue;
          const remoteReading = communityProject.items[readingItemId];
          if (remoteReading?.kind !== 'bible') {
            preflight.rootItemIds = preflight.rootItemIds.filter(
              itemId => itemId !== readingItemId
            );
            for (const item of Object.values(preflight.items)) {
              if (item.kind === 'group') {
                item.childIds = item.childIds.filter(
                  itemId => itemId !== readingItemId
                );
              }
            }
            delete preflight.items[readingItemId];
            continue;
          }
          if (remoteReading.sermonReading) {
            localReading.sermonReading =
              clone(remoteReading.sermonReading);
          } else {
            delete localReading.sermonReading;
          }
        }
        repinSermonRevision(normalizeServiceProject(preflight), {
          previousResourceId,
          nextResourceId: change.nextResourceId,
          now: communityProject.planning.source.importedAt
        });
      } catch (error) {
        fail(
          error.code || 'COMMUNITY_SERMON_REPIN_INCOMPATIBLE',
          error.message
            || 'The Community sermon revision is incompatible with local sermon work.',
          error.details || {}
        );
      }
    }

    const linkedReadingHasLocalWork =
      change.readingLocalWorkItemIds.size > 0;
    const hasLocalWork =
      change.ownerRecords.some(
        owner => owner.localSpecChanged || owner.localDescendantWork
      )
      || linkedReadingHasLocalWork
      || change.externalLocalReferenceIds.size > 0;
    const firstOwner = change.ownerRecords[0];
    change.conflictId = hasLocalWork
      ? addConflict({
          key: `sermon-pin-target:${change.nextResourceId}`,
          kind: 'COMMUNITY_SERMON_PIN_CHANGED_WITH_LOCAL_WORK',
          itemId: firstOwner.itemId,
          entryId: firstOwner.entryId,
          title: firstOwner.title,
          localSummary:
            'Keep the current sermon revision, linked readings, and every local cue that uses it.',
          communitySummary:
            'Repin all compatible owners, linked readings, and local cues to the reviewed Community revision.'
        })
      : null;
    for (const owner of change.ownerRecords) {
      sermonPinChangesByItemId.set(owner.itemId, {
        conflictId: change.conflictId,
        previousResourceId: owner.previousResourceId,
        nextResourceId: change.nextResourceId
      });
    }
  }

  // A stable service-plan entry may intentionally point at a genuinely
  // different sermon, not merely a newer revision of the same sermon. That is
  // a scoped content replacement: it must not use the resource-global repin
  // contract, but its explicitly linked readings still share one review choice
  // when local work exists.
  for (const readingItemId of managedReadingItemIds) {
    const readingBaseEntry = baseEntries.get(readingItemId) || null;
    const localReading = localProject.items[readingItemId];
    const remoteReading = communityProject.items[readingItemId];
    const localResourceId =
      localReading?.kind === 'bible'
        ? localReading.sermonReading?.sermonResourceId || null
        : null;
    const remoteResourceId =
      remoteReading?.kind === 'bible'
        ? remoteReading.sermonReading?.sermonResourceId || null
        : null;
    const candidateChanges = new Set();
    if (localResourceId) {
      const byPrevious =
        sermonReplacementChangesByPreviousResourceId.get(localResourceId);
      if (byPrevious) candidateChanges.add(byPrevious);
    }
    if (remoteResourceId) {
      const byTarget =
        sermonReplacementChangesByTargetResourceId.get(remoteResourceId);
      if (byTarget) candidateChanges.add(byTarget);
    }
    if (candidateChanges.size > 1) {
      fail(
        'COMMUNITY_SERMON_REPLACEMENT_SCOPE_OVERLAP',
        'A linked Scripture reading crosses two different sermon replacements and cannot be reconciled deterministically.',
        { itemId: readingItemId }
      );
    }
    const [replacement] = candidateChanges;
    if (!replacement) continue;
    if (
      remoteResourceId
      && replacement.previousResourceIds.has(remoteResourceId)
    ) {
      fail(
        'COMMUNITY_SERMON_REPLACEMENT_SCOPE_OVERLAP',
        'The Community candidate retains a linked reading on the sermon being replaced.',
        {
          itemId: readingItemId,
          resourceId: remoteResourceId
        }
      );
    }
    if (
      sermonPinChangesByReadingItemId.has(readingItemId)
      && sermonPinChangesByReadingItemId.get(readingItemId) !== replacement
    ) {
      fail(
        'COMMUNITY_SERMON_REPLACEMENT_SCOPE_OVERLAP',
        'A linked Scripture reading participates in both a revision repin and a sermon replacement.',
        { itemId: readingItemId }
      );
    }
    replacement.readingItemIds.add(readingItemId);
    let localWork = false;
    if (readingBaseEntry) {
      if (localReading?.kind !== 'bible') {
        localWork = true;
      } else {
        const contentWork =
          communityServicePlanItemContentSpecSha256(
            localProject,
            readingItemId
          ) !== readingBaseEntry.contentSpecSha256
          || communityServicePlanItemDependentStateSha256(
            localProject,
            readingItemId
          ) !== readingBaseEntry.dependentStateSha256;
        if (contentWork) {
          replacement.readingContentWorkItemIds.add(readingItemId);
        }
        localWork =
          contentWork
          || communityServicePlanItemRelationshipSha256(
            localProject,
            readingItemId
          ) !== readingBaseEntry.relationshipSha256
          || placementChangedFromBaseline(readingItemId, localPlacement);
      }
    } else if (localReading) {
      localWork = true;
    }
    if (localWork) {
      replacement.readingLocalWorkItemIds.add(readingItemId);
    }
    sermonPinChangesByReadingItemId.set(readingItemId, replacement);
  }
  for (const replacement of sermonReplacementChangeGroups) {
    const linkedReadingHasLocalWork =
      replacement.readingLocalWorkItemIds.size > 0;
    const hasLocalWork =
      replacement.ownerRecords.some(
        owner => owner.localSpecChanged || owner.localDescendantWork
      )
      || linkedReadingHasLocalWork;
    const firstOwner = replacement.ownerRecords[0];
    replacement.conflictId = hasLocalWork
      ? addConflict({
          key: `sermon-replacement-target:${replacement.nextResourceId}`,
          kind: 'COMMUNITY_SERMON_REPLACED_WITH_LOCAL_WORK',
          itemId: firstOwner.itemId,
          entryId: firstOwner.entryId,
          title: firstOwner.title,
          localSummary:
            'Keep the locally selected sermon, its linked readings, and local sermon cues.',
          communitySummary:
            'Use the different Community sermon and its linked readings; retain local cues but clear stale source receipts for review.'
        })
      : null;
    for (const owner of replacement.ownerRecords) {
      sermonReplacementChangesByItemId.set(owner.itemId, replacement);
    }
  }

  // Treat deleting a section locally as one subtree decision when Community
  // changed anything inside that deleted section. Otherwise a newly added or
  // edited remote child could be lifted to the root without ever restoring its
  // reviewed parent.
  const deletedGroupConflictByItemId = new Map();
  const deletedGroupPlacementConflictByItemId = new Map();
  const newGroupCollisionByItemId = new Map();
  const groupCollisionConflictByRootId = new Map();
  const newLeafCollisionConflictByItemId = new Map();
  const deletedGroupCandidateIds = new Set(
    [...baseEntries.entries()]
      .filter(([itemId, baseEntry]) => {
        if (
          baseEntry.itemKind !== 'group'
          || localProject.items[itemId]
          || !remoteEntries.has(itemId)
        ) {
          return false;
        }
        return true;
      })
      .map(([itemId]) => itemId)
  );
  const outerDeletedGroupIds = [...deletedGroupCandidateIds]
    .filter(itemId => {
      let parentItemId =
        basePlacement.byItemId.get(itemId)?.parentItemId ?? null;
      while (parentItemId !== null) {
        if (deletedGroupCandidateIds.has(parentItemId)) return false;
        parentItemId =
          basePlacement.byItemId.get(parentItemId)?.parentItemId ?? null;
      }
      return true;
    })
    .sort();
  for (const itemId of outerDeletedGroupIds) {
    const baseEntry = baseEntries.get(itemId);
    const remoteEntry = remoteEntries.get(itemId);
    const remoteItem = communityProject.items[itemId];
    if (
      !remoteEntry
      || !remoteItem
      || (
        remoteEntry.sourceSha256 === baseEntry.sourceSha256
        && !placementChangedFromBaseline(itemId, remotePlacement)
        && !remoteGroupSubtreeChanged(itemId)
      )
    ) {
      continue;
    }
    const conflictId = addConflict({
      key: `local-delete-subtree:${itemId}`,
      kind: 'LOCAL_ITEM_DELETED_AFTER_COMMUNITY_CHANGE',
      itemId,
      entryId: remoteEntry.entryId,
      title: describeItem(remoteItem, remoteEntry.entryId),
      localSummary:
        'Keep the local deletion of this section and its complete subtree.',
      communitySummary:
        'Restore the section with its changed Community descendants and exact placement.'
    });
    const affectedItemIds = new Set([
      itemId,
      ...placementDescendants(basePlacement, itemId),
      ...placementDescendants(remotePlacement, itemId)
    ]);
    for (const affectedItemId of affectedItemIds) {
      if (
        affectedItemId !== itemId
        && localProject.items[affectedItemId]
      ) {
        const localParent =
          localPlacement.byItemId.get(affectedItemId)?.parentItemId ?? null;
        const remoteParent =
          remotePlacement.byItemId.get(affectedItemId)?.parentItemId ?? null;
        if (
          remoteParent !== localParent
          && placementChangedFromBaseline(
            affectedItemId,
            remotePlacement
          )
        ) {
          const existing =
            deletedGroupPlacementConflictByItemId.get(affectedItemId);
          if (existing && existing.conflictId !== conflictId) {
            fail(
              'COMMUNITY_PLAN_RECONCILIATION_STRUCTURE_OVERLAP',
              'One Community move enters two independently deleted local sections.',
              { itemId: affectedItemId }
            );
          }
          deletedGroupPlacementConflictByItemId.set(affectedItemId, {
            conflictId,
            localParent,
            remoteParent
          });
        }
        continue;
      }
      deletedGroupConflictByItemId.set(affectedItemId, conflictId);
    }
  }

  // A locally created group can independently collide with the stable ID of a
  // newly added Community group (or group-to-leaf counterpart). Treat that as
  // one complete subtree decision. Item-only selection would otherwise combine
  // unrelated local and remote children under whichever group object won.
  const placementDepth = (placement, itemId) => {
    let depth = 0;
    let parentItemId =
      placement.byItemId.get(itemId)?.parentItemId ?? null;
    const visited = new Set();
    while (parentItemId !== null && !visited.has(parentItemId)) {
      visited.add(parentItemId);
      depth += 1;
      parentItemId =
        placement.byItemId.get(parentItemId)?.parentItemId ?? null;
    }
    return depth;
  };
  const newGroupCollisionRootIds = [...remoteEntries.keys()]
    .filter(itemId => {
      if (baseEntries.has(itemId)) return false;
      const localItem = localProject.items[itemId];
      const remoteItem = communityProject.items[itemId];
      return Boolean(
        localItem
        && remoteItem
        && (localItem.kind === 'group' || remoteItem.kind === 'group')
      );
    });
  const retainedGroupCollisionRootIds =
    [...retainedCollisionBoundaryItemIds].filter(itemId => {
      const baseEntry = baseEntries.get(itemId);
      const remoteEntry = remoteEntries.get(itemId);
      const localItem = localProject.items[itemId];
      const remoteItem = communityProject.items[itemId];
      if (!baseEntry || !remoteEntry || !localItem || !remoteItem) {
        return false;
      }
      return (
        remoteEntry.sourceSha256 !== baseEntry.sourceSha256
        || placementChangedFromBaseline(itemId, remotePlacement)
        || (
          remoteItem.kind === 'group'
          && remoteGroupSubtreeChanged(itemId)
        )
      );
    });
  const groupCollisionRootIds = [...new Set([
    ...newGroupCollisionRootIds,
    ...retainedGroupCollisionRootIds
  ])]
    .sort((left, right) =>
      Math.min(
        placementDepth(localPlacement, left),
        placementDepth(remotePlacement, left)
      ) - Math.min(
        placementDepth(localPlacement, right),
        placementDepth(remotePlacement, right)
      )
      || left.localeCompare(right));
  for (const itemId of groupCollisionRootIds) {
    const existingRootCollision = newGroupCollisionByItemId.get(itemId);
    if (existingRootCollision) {
      if (
        !existingRootCollision.localIncluded
        || !existingRootCollision.communityIncluded
      ) {
        fail(
          'COMMUNITY_PLAN_RECONCILIATION_STRUCTURE_OVERLAP',
          'A stable-ID group collision crosses a different subtree boundary in the local and Community plans.',
          { itemId }
        );
      }
      continue;
    }
    const remoteEntry = remoteEntries.get(itemId);
    const localItem = localProject.items[itemId];
    const remoteItem = communityProject.items[itemId];
    const retainedBoundary =
      retainedCollisionBoundaryItemIds.has(itemId);
    const conflictId = addConflict({
      key: `item-collision-subtree:${itemId}`,
      kind: 'LOCAL_ITEM_ID_COLLISION',
      itemId,
      entryId: remoteEntry.entryId,
      title: describeItem(localItem, remoteEntry.entryId),
      localSummary:
        retainedBoundary
          ? 'Keep the complete locally retained item and its local subtree.'
          : 'Keep the complete locally created item and its local subtree.',
      communitySummary:
        retainedBoundary
          ? 'Use the complete changed Community item and its Community subtree.'
          : 'Use the complete new Community item and its Community subtree.'
    });
    groupCollisionConflictByRootId.set(itemId, conflictId);
    const localSubtreeIds = descendants(localProject, itemId);
    const remoteSubtreeIds = new Set([
      itemId,
      ...placementDescendants(remotePlacement, itemId)
    ]);
    const affectedItemIds = new Set([
      ...localSubtreeIds,
      ...remoteSubtreeIds
    ]);
    for (const affectedItemId of affectedItemIds) {
      if (
        sermonPinChangesByItemId.has(affectedItemId)
        || sermonReplacementChangesByItemId.has(affectedItemId)
        || sermonPinChangesByReadingItemId.has(affectedItemId)
      ) {
        fail(
          'COMMUNITY_PLAN_RECONCILIATION_STRUCTURE_OVERLAP',
          'A stable-ID group collision overlaps an atomic sermon revision or replacement.',
          { itemId: affectedItemId }
        );
      }
      const localIncluded = localSubtreeIds.has(affectedItemId);
      const communityIncluded = remoteSubtreeIds.has(affectedItemId);
      if (
        localIncluded !== communityIncluded
        && localProject.items[affectedItemId]
        && communityProject.items[affectedItemId]
      ) {
        fail(
          'COMMUNITY_PLAN_RECONCILIATION_STRUCTURE_OVERLAP',
          'A stable-ID group collision crosses a different subtree boundary in the local and Community plans.',
          { itemId: affectedItemId }
        );
      }
      const existing = newGroupCollisionByItemId.get(affectedItemId);
      if (existing && existing.conflictId !== conflictId) {
        fail(
          'COMMUNITY_PLAN_RECONCILIATION_STRUCTURE_OVERLAP',
          'Two stable-ID group collisions have overlapping subtrees and cannot be reviewed independently.',
          { itemId: affectedItemId }
        );
      }
      newGroupCollisionByItemId.set(affectedItemId, {
        conflictId,
        localIncluded,
        communityIncluded
      });
    }
  }

  const itemIds = [...new Set([
    ...baseIds,
    ...remoteIds,
    ...localIds
  ])].sort();
  for (const itemId of itemIds) {
    const baseEntry = baseEntries.get(itemId) || null;
    const remoteEntry = remoteEntries.get(itemId) || null;
    const localItem = localProject.items[itemId] || null;
    const remoteItem = communityProject.items[itemId] || null;
    const deletedGroupConflictId =
      deletedGroupConflictByItemId.get(itemId) || null;
    const deletedGroupPlacementConflict =
      deletedGroupPlacementConflictByItemId.get(itemId) || null;
    const newGroupCollision =
      newGroupCollisionByItemId.get(itemId) || null;
    const sermonAtomicReadingChange =
      sermonPinChangesByReadingItemId.get(itemId) || null;
    const sermonAtomicConflictId =
      sermonAtomicReadingChange?.conflictId || null;
    const sermonAtomicExistenceOrKindChange = Boolean(
      sermonAtomicConflictId
      && (
        !baseEntry
        || !remoteEntry
        || !localItem
        || remoteEntry.itemKind !== baseEntry.itemKind
        || localItem.kind !== baseEntry.itemKind
      )
    );
    const hasNewStableIdentityCollision = Boolean(
      !baseEntry && remoteEntry && remoteItem && localItem
    );
    if (
      (newGroupCollision || hasNewStableIdentityCollision)
      && (deletedGroupConflictId || deletedGroupPlacementConflict)
    ) {
      fail(
        'COMMUNITY_PLAN_RECONCILIATION_STRUCTURE_OVERLAP',
        'A stable-ID collision crosses a locally deleted Community subtree.',
        { itemId }
      );
    }
    if (newGroupCollision) {
      if (
        (deletedGroupConflictId
          && deletedGroupConflictId !== newGroupCollision.conflictId)
        || (sermonAtomicConflictId
          && sermonAtomicConflictId !== newGroupCollision.conflictId)
      ) {
        fail(
          'COMMUNITY_PLAN_RECONCILIATION_STRUCTURE_OVERLAP',
          'A stable-ID group collision overlaps another atomic subtree or sermon decision.',
          { itemId }
        );
      }
      const localCandidate =
        newGroupCollision.localIncluded ? localItem : null;
      const communityCandidate =
        newGroupCollision.communityIncluded ? remoteItem : null;
      if (localCandidate) selected.set(itemId, localCandidate);
      selectedSource.set(itemId, {
        conflictId: newGroupCollision.conflictId,
        local: localCandidate,
        community: communityCandidate,
        defaultChoice: 'keep-local'
      });
      preservedLocalItemCount += 1;
      continue;
    }
    if (sermonAtomicExistenceOrKindChange) {
      if (
        deletedGroupConflictId
        && deletedGroupConflictId !== sermonAtomicConflictId
      ) {
        fail(
          'COMMUNITY_PLAN_RECONCILIATION_STRUCTURE_OVERLAP',
          'A linked reading participates in two incompatible subtree decisions.',
          { itemId }
        );
      }
      if (localItem) selected.set(itemId, localItem);
      selectedSource.set(itemId, {
        conflictId: sermonAtomicConflictId,
        local: localItem,
        community: remoteItem,
        defaultChoice: 'keep-local'
      });
      preservedLocalItemCount += 1;
      continue;
    }

    if (!baseEntry) {
      if (remoteEntry && remoteItem && !localItem && deletedGroupConflictId) {
        selectedSource.set(itemId, {
          conflictId: deletedGroupConflictId,
          local: null,
          community: remoteItem,
          defaultChoice: 'keep-local'
        });
        preservedLocalItemCount += 1;
        continue;
      }
      if (remoteEntry && localItem) {
        const conflictId = addConflict({
          key: `item-collision:${itemId}`,
          kind: 'LOCAL_ITEM_ID_COLLISION',
          itemId,
          entryId: remoteEntry.entryId,
          title: describeItem(localItem, remoteEntry.entryId),
          localSummary: 'Keep the locally created item that already uses this identity.',
          communitySummary: 'Use the new Community entry with this stable identity.'
        });
        selected.set(itemId, localItem);
        selectedSource.set(itemId, {
          conflictId,
          local: localItem,
          community: remoteItem,
          defaultChoice: 'keep-local'
        });
        newLeafCollisionConflictByItemId.set(itemId, conflictId);
        preservedLocalItemCount += 1;
      } else if (remoteEntry && remoteItem) {
        selected.set(itemId, remoteItem);
        selectedSource.set(itemId, { source: 'community' });
        appliedCommunityItemCount += 1;
        autoMergedItemCount += 1;
      } else if (localItem) {
        selected.set(itemId, localItem);
        selectedSource.set(itemId, { source: 'local' });
        preservedLocalItemCount += 1;
      }
      continue;
    }

    if (!remoteEntry) {
      if (!localItem) continue;
      const localChanged =
        communityServicePlanItemStateSha256(localProject, itemId)
          !== baseEntry.stateSha256
        || placementChangedFromBaseline(itemId, localPlacement)
        || (localItem.kind === 'group' && groupHasLocalWork(itemId));
      if (localChanged) {
        const conflictId = addConflict({
          key: `remote-delete:${itemId}`,
          kind: localItem.kind === 'group'
            ? 'COMMUNITY_PARENT_DELETED_WITH_LOCAL_CHILDREN'
            : 'COMMUNITY_ITEM_DELETED_AFTER_LOCAL_CHANGE',
          itemId,
          entryId: baseEntry.entryId,
          title: describeItem(localItem, baseEntry.entryId),
          localSummary: 'Keep this locally edited item and its local descendants.',
          communitySummary: 'Accept the Community deletion. Local descendants under it will be removed from the active plan but remain in history.'
        });
        selected.set(itemId, localItem);
        selectedSource.set(itemId, {
          conflictId,
          local: localItem,
          community: null,
          defaultChoice: 'keep-local',
          communityRemovesSubtree: localItem.kind === 'group'
        });
        preservedLocalItemCount += 1;
      } else {
        forcedRemovalIds.add(itemId);
        if (localItem.kind === 'group') {
          for (const descendantId of descendants(localProject, itemId)) {
            // A Community revision may remove only the section row while
            // retaining and reparenting its managed entries. Do not cascade
            // through those retained identities; their own BASE/local/remote
            // placement decides where they belong.
            if (!remoteEntries.has(descendantId)) {
              forcedRemovalIds.add(descendantId);
            }
          }
        }
        appliedCommunityItemCount += 1;
        autoMergedItemCount += 1;
      }
      continue;
    }

    if (!localItem) {
      if (deletedGroupConflictId) {
        selectedSource.set(itemId, {
          conflictId: deletedGroupConflictId,
          local: null,
          community: remoteItem,
          defaultChoice: 'keep-local'
        });
        preservedLocalItemCount += 1;
        continue;
      }
      const remoteChanged =
        remoteEntry.sourceSha256 !== baseEntry.sourceSha256
        || placementChangedFromBaseline(itemId, remotePlacement)
        || (
          baseEntry.itemKind === 'group'
          && remoteGroupSubtreeChanged(itemId)
        );
      if (remoteChanged) {
        const conflictId = addConflict({
          key: `local-delete:${itemId}`,
          kind: 'LOCAL_ITEM_DELETED_AFTER_COMMUNITY_CHANGE',
          itemId,
          entryId: remoteEntry.entryId,
          title: describeItem(remoteItem, remoteEntry.entryId),
          localSummary: 'Keep the local deletion.',
          communitySummary: 'Restore the item using the changed Community entry.'
        });
        selectedSource.set(itemId, {
          conflictId,
          local: null,
          community: remoteItem,
          defaultChoice: 'keep-local'
        });
      } else {
        preservedLocalItemCount += 1;
      }
      continue;
    }

    const localStateChanged =
      communityServicePlanItemStateSha256(localProject, itemId)
        !== baseEntry.stateSha256;
    if (remoteEntry.itemKind !== baseEntry.itemKind) {
      const localHasWork =
        localStateChanged
        || placementChangedFromBaseline(itemId, localPlacement)
        || (
          localItem.kind === 'group'
          && groupHasLocalDescendantWork(itemId)
        );
      if (localHasWork) {
        const conflictId = addConflict({
          key: `kind-change:${itemId}`,
          kind: 'COMMUNITY_ENTRY_KIND_CHANGED_AFTER_LOCAL_CHANGE',
          itemId,
          entryId: remoteEntry.entryId,
          title: describeItem(localItem, remoteEntry.entryId),
          localSummary:
            'Keep the local item, presentation treatment, and descendants.',
          communitySummary:
            'Use the Community item with its changed content kind and lift retained local descendants to the nearest section.'
        });
        selected.set(itemId, localItem);
        selectedSource.set(itemId, {
          conflictId,
          local: localItem,
          community: remoteItem,
          defaultChoice: 'keep-local'
        });
        preservedLocalItemCount += 1;
      } else {
        selected.set(itemId, remoteItem);
        selectedSource.set(itemId, { source: 'community' });
        appliedCommunityItemCount += 1;
        autoMergedItemCount += 1;
      }
      continue;
    }

    const localTitleChanged =
      communityServicePlanItemTitleSha256(localProject, itemId)
        !== baseEntry.titleSha256;
    const remoteTitleChanged =
      communityServicePlanItemTitleSha256(communityProject, itemId)
        !== baseEntry.titleSha256;
    let titleConflictId = null;
    if (
      localTitleChanged
      && remoteTitleChanged
      && localItem.title !== remoteItem.title
    ) {
      titleConflictId = addConflict({
        key: `title:${itemId}`,
        kind: 'LOCAL_AND_COMMUNITY_TITLE_CHANGED',
        itemId,
        entryId: remoteEntry.entryId,
        title: describeItem(localItem, remoteEntry.entryId),
        localSummary: 'Keep the local item title.',
        communitySummary: 'Use the changed Community item title.'
      });
    }
    titleSelections.set(itemId, {
      conflictId: titleConflictId,
      local: localItem.title,
      community: remoteItem.title,
      value: localTitleChanged && !remoteTitleChanged
        ? localItem.title
        : remoteItem.title
    });

    const localSpecHash =
      communityServicePlanItemContentSpecSha256(localProject, itemId);
    const localRelationshipHash =
      communityServicePlanItemRelationshipSha256(localProject, itemId);
    const localDependentHash =
      communityServicePlanItemDependentStateSha256(localProject, itemId);
    const remoteSpecChanged =
      remoteEntry.contentSpecSha256 !== baseEntry.contentSpecSha256;
    const localSpecChanged =
      localSpecHash !== baseEntry.contentSpecSha256;
    const remoteRelationshipChanged =
      remoteEntry.relationshipSha256 !== baseEntry.relationshipSha256;
    const localRelationshipChanged =
      localRelationshipHash !== baseEntry.relationshipSha256;
    const localDependentChanged =
      localDependentHash !== baseEntry.dependentStateSha256;
    const specConverged =
      remoteSpecChanged
      && localSpecChanged
      && localSpecHash === remoteEntry.contentSpecSha256;

    if (localItem.kind === 'song') {
      if (remoteSpecChanged) {
        if (specConverged) {
          selected.set(itemId, localItem);
          selectedSource.set(itemId, { source: 'local' });
          appliedCommunityItemCount += 1;
          autoMergedItemCount += 1;
          if (localStateChanged) preservedLocalItemCount += 1;
          continue;
        }
        const communityItem = localPresentationOverlay(
          localItem,
          remoteItem,
          { preserveDependentState: false }
        );
        if (!localSpecChanged && !localDependentChanged) {
          selected.set(itemId, communityItem);
          selectedSource.set(itemId, { source: 'community' });
          appliedCommunityItemCount += 1;
          autoMergedItemCount += 1;
          if (localStateChanged) preservedLocalItemCount += 1;
        } else {
          const conflictId = addConflict({
            key: `song-pin:${itemId}`,
            kind: 'COMMUNITY_SONG_PIN_CHANGED_WITH_LOCAL_ARRANGEMENT',
            itemId,
            entryId: remoteEntry.entryId,
            title: describeItem(localItem, remoteEntry.entryId),
            localSummary:
              'Keep the local song pin, arrangement, and source-range receipt.',
            communitySummary:
              'Use the Community song pin and its newly generated compatible arrangement.'
          });
          selected.set(itemId, localItem);
          selectedSource.set(itemId, {
            conflictId,
            local: localItem,
            community: communityItem,
            defaultChoice: 'keep-local'
          });
          preservedLocalItemCount += 1;
        }
      } else {
        selected.set(itemId, localItem);
        selectedSource.set(itemId, { source: 'local' });
        if (localStateChanged) preservedLocalItemCount += 1;
        if (
          !localDependentChanged
          && remoteEntry.dependentStateSha256
            !== baseEntry.dependentStateSha256
        ) {
          baselineComponentOverrides.push({
            entryId: remoteEntry.entryId,
            dependentStateSha256: baseEntry.dependentStateSha256
          });
        }
      }
      continue;
    }

    if (localItem.kind === 'bible') {
      const sermonPinChange =
        sermonPinChangesByReadingItemId.get(itemId) || null;
      const preservePassages = !remoteSpecChanged || specConverged;
      const communityItem = preservePassages
        ? (() => {
            const merged = clone(localItem);
            if (remoteItem.sermonReading) {
              merged.sermonReading = clone(remoteItem.sermonReading);
            } else {
              delete merged.sermonReading;
            }
            return merged;
          })()
        : localPresentationOverlay(
            localItem,
            remoteItem,
            { preserveDependentState: false }
          );
      const atomicCommunityItem =
        sermonPinChange?.readingContentWorkItemIds?.has(itemId)
          ? localPresentationOverlay(
              localItem,
              remoteItem,
              { preserveDependentState: false }
            )
          : communityItem;
      if (sermonPinChange?.conflictId) {
        selected.set(itemId, localItem);
        selectedSource.set(itemId, {
          conflictId: sermonPinChange.conflictId,
          local: localItem,
          community: atomicCommunityItem,
          defaultChoice: 'keep-local'
        });
        preservedLocalItemCount += 1;
      } else if (remoteSpecChanged && !specConverged) {
        if (
          !localSpecChanged
          && !localRelationshipChanged
          && !localDependentChanged
        ) {
          selected.set(itemId, communityItem);
          selectedSource.set(itemId, { source: 'community' });
          appliedCommunityItemCount += 1;
          autoMergedItemCount += 1;
        } else {
          const conflictId = addConflict({
            key: `scripture-spec:${itemId}`,
            kind: 'LOCAL_AND_COMMUNITY_SCRIPTURE_CHANGED',
            itemId,
            entryId: remoteEntry.entryId,
            title: describeItem(localItem, remoteEntry.entryId),
            localSummary:
              'Keep the local Scripture range, relationship, and passage snapshot.',
            communitySummary:
              'Use the Community range, relationship, and exact resolved passage snapshot.'
          });
          selected.set(itemId, localItem);
          selectedSource.set(itemId, {
            conflictId,
            local: localItem,
            community: communityItem,
            defaultChoice: 'keep-local'
          });
          preservedLocalItemCount += 1;
        }
      } else if (remoteRelationshipChanged) {
        if (
          !localRelationshipChanged
          || localRelationshipHash === remoteEntry.relationshipSha256
        ) {
          selected.set(itemId, communityItem);
          selectedSource.set(itemId, { source: 'community' });
          appliedCommunityItemCount += 1;
          autoMergedItemCount += 1;
          if (localDependentChanged) preservedLocalItemCount += 1;
        } else {
          const conflictId = addConflict({
            key: `scripture-relationship:${itemId}`,
            kind: 'LOCAL_AND_COMMUNITY_SCRIPTURE_RELATIONSHIP_CHANGED',
            itemId,
            entryId: remoteEntry.entryId,
            title: describeItem(localItem, remoteEntry.entryId),
            localSummary: 'Keep the local sermon-reading relationship.',
            communitySummary:
              'Use the changed Community sermon-reading relationship.'
          });
          selected.set(itemId, localItem);
          selectedSource.set(itemId, {
            conflictId,
            local: localItem,
            community: communityItem,
            defaultChoice: 'keep-local'
          });
          preservedLocalItemCount += 1;
        }
      } else {
        selected.set(itemId, localItem);
        selectedSource.set(itemId, { source: 'local' });
        if (localStateChanged) preservedLocalItemCount += 1;
      }
      if (
        preservePassages
        && !localDependentChanged
        && remoteEntry.dependentStateSha256
          !== baseEntry.dependentStateSha256
      ) {
        baselineComponentOverrides.push({
          entryId: remoteEntry.entryId,
          dependentStateSha256: baseEntry.dependentStateSha256
        });
      }
      continue;
    }

    const sermonReplacement =
      sermonReplacementChangesByItemId.get(itemId);
    if (sermonReplacement) {
      const communityItem = localPresentationOverlay(
        localItem,
        remoteItem
      );
      if (sermonReplacement.conflictId) {
        selected.set(itemId, localItem);
        selectedSource.set(itemId, {
          conflictId: sermonReplacement.conflictId,
          local: localItem,
          community: communityItem,
          defaultChoice: 'keep-local'
        });
        preservedLocalItemCount += 1;
      } else {
        selected.set(itemId, communityItem);
        selectedSource.set(itemId, { source: 'community' });
        appliedCommunityItemCount += 1;
        autoMergedItemCount += 1;
      }
      continue;
    }

    const sermonPinChange = sermonPinChangesByItemId.get(itemId);
    if (sermonPinChange) {
      const communityStagingItem = localPresentationOverlay(
        localItem,
        remoteItem
      );
      communityStagingItem.sermonResourceId =
        sermonPinChange.previousResourceId;
      if (sermonPinChange.conflictId) {
        selected.set(itemId, localItem);
        selectedSource.set(itemId, {
          conflictId: sermonPinChange.conflictId,
          local: localItem,
          community: communityStagingItem,
          defaultChoice: 'keep-local'
        });
        preservedLocalItemCount += 1;
      } else {
        selected.set(itemId, communityStagingItem);
        selectedSource.set(itemId, { source: 'community' });
        appliedCommunityItemCount += 1;
        autoMergedItemCount += 1;
      }
      continue;
    }

    if (localItem.kind === 'group') {
      if (remoteSpecChanged) {
        if (specConverged) {
          selected.set(itemId, localItem);
          selectedSource.set(itemId, { source: 'local' });
          appliedCommunityItemCount += 1;
          autoMergedItemCount += 1;
          if (localStateChanged) preservedLocalItemCount += 1;
          continue;
        }
        const communityItem = localPresentationOverlay(
          localItem,
          remoteItem
        );
        if (
          !localSpecChanged
          && !groupHasLocalDescendantWork(itemId)
        ) {
          selected.set(itemId, communityItem);
          selectedSource.set(itemId, { source: 'community' });
          appliedCommunityItemCount += 1;
          autoMergedItemCount += 1;
          if (localStateChanged) preservedLocalItemCount += 1;
        } else {
          const conflictId = addConflict({
            key: `group-spec:${itemId}`,
            kind: 'LOCAL_AND_COMMUNITY_ITEM_CHANGED',
            itemId,
            entryId: remoteEntry.entryId,
            title: describeItem(localItem, remoteEntry.entryId),
            localSummary:
              'Keep the local section or sermon binding and descendants.',
            communitySummary:
              'Use the changed Community section or sermon binding.'
          });
          selected.set(itemId, localItem);
          selectedSource.set(itemId, {
            conflictId,
            local: localItem,
            community: communityItem,
            defaultChoice: 'keep-local'
          });
          preservedLocalItemCount += 1;
        }
      } else {
        selected.set(itemId, localItem);
        selectedSource.set(itemId, { source: 'local' });
        if (localStateChanged) preservedLocalItemCount += 1;
      }
      continue;
    }

    const remoteChanged =
      remoteEntry.sourceSha256 !== baseEntry.sourceSha256;
    const localContentHash =
      communityServicePlanItemContentSha256(localProject, itemId);
    const localChanged = localContentHash !== baseEntry.contentSha256;
    const remoteContentHash =
      communityServicePlanItemContentSha256(communityProject, itemId);
    const sameResult = localContentHash === remoteContentHash;
    if (!remoteChanged) {
      selected.set(itemId, localItem);
      selectedSource.set(itemId, { source: 'local' });
      if (
        communityServicePlanItemStateSha256(localProject, itemId)
          !== baseEntry.stateSha256
      ) {
        preservedLocalItemCount += 1;
      }
      continue;
    }
    if (!localChanged || sameResult) {
      const mergedItem = sameResult
        ? localItem
        : localPresentationOverlay(localItem, remoteItem);
      selected.set(itemId, mergedItem);
      selectedSource.set(itemId, { source: 'community' });
      appliedCommunityItemCount += 1;
      autoMergedItemCount += 1;
      if (
        communityServicePlanItemStateSha256(localProject, itemId)
          !== baseEntry.stateSha256
      ) {
        preservedLocalItemCount += 1;
      }
      continue;
    }
    const conflictId = addConflict({
      key: `item-change:${itemId}`,
      kind: remoteEntry.itemKind !== baseEntry.itemKind
        ? 'COMMUNITY_ENTRY_KIND_CHANGED_AFTER_LOCAL_CHANGE'
        : 'LOCAL_AND_COMMUNITY_ITEM_CHANGED',
      itemId,
      entryId: remoteEntry.entryId,
      title: describeItem(localItem, remoteEntry.entryId),
      localSummary: 'Keep the locally edited content and presentation treatment.',
      communitySummary: 'Use the changed Community content while retaining compatible local presentation settings.'
    });
    selected.set(itemId, localItem);
    selectedSource.set(itemId, {
      conflictId,
      local: localItem,
      community: localPresentationOverlay(localItem, remoteItem),
      defaultChoice: 'keep-local'
    });
    preservedLocalItemCount += 1;
  }

  const metadataFields = [
    ['title', localProject.title, communityProject.title],
    ['serviceDate', localProject.serviceDate, communityProject.serviceDate],
    [
      'startTime',
      localProject.planning.startTime,
      communityProject.planning.startTime
    ],
    [
      'teamNotes',
      localProject.planning.teamNotes || '',
      communityProject.planning.teamNotes || ''
    ]
  ];
  const metadataSelection = new Map();
  for (const [field, localValue, remoteValue] of metadataFields) {
    const baseValue = baseline.metadata[field];
    const localChanged = localValue !== baseValue;
    const remoteChanged = remoteValue !== baseValue;
    if (localChanged && remoteChanged && localValue !== remoteValue) {
      const conflictId = addConflict({
        key: `metadata:${field}`,
        kind: 'LOCAL_AND_COMMUNITY_METADATA_CHANGED',
        title: `Service ${field}`,
        localSummary: `Keep the local ${field} value.`,
        communitySummary: `Use the changed Community ${field} value.`
      });
      metadataSelection.set(field, {
        conflictId,
        local: localValue,
        community: remoteValue
      });
    } else if (remoteChanged && !localChanged) {
      metadataSelection.set(field, { source: 'community', value: remoteValue });
      appliedCommunityItemCount += 1;
    } else {
      metadataSelection.set(field, { source: 'local', value: localValue });
    }
  }

  // Some existence conflicts provisionally keep a local deletion, but the
  // Community side still needs to participate in topology review so choosing
  // it later can restore the exact parent and sibling position.
  const potentialItemIds = new Set(selected.keys());
  const potentialGroupIds = new Set(
    [...selected.entries()]
      .filter(([, item]) => item?.kind === 'group')
      .map(([itemId]) => itemId)
  );
  for (const [itemId, item] of Object.entries(communityProject.items)) {
    if (item.kind === 'group') potentialGroupIds.add(itemId);
  }
  for (const [key, selection] of selectedSource) {
    if (typeof key !== 'string' || key.startsWith('parent:')) continue;
    if (selection.local || selection.community) potentialItemIds.add(key);
    if (selection.local?.kind === 'group' || selection.community?.kind === 'group') {
      potentialGroupIds.add(key);
    }
  }

  const finalParentByItemId = new Map();
  const placementSelections = new Map();
  const placementOutcomesEqual = (itemId, localParent, remoteParent) => {
    if (localParent !== remoteParent) return false;
    const localSequence =
      localPlacement.childrenByParent.get(localParent) || [];
    const remoteSequence =
      remotePlacement.childrenByParent.get(remoteParent) || [];
    const remoteIdsInParent = new Set(remoteSequence);
    const anchors = localSequence.filter(candidateId =>
      candidateId !== itemId
      && remoteIdsInParent.has(candidateId));
    const localIndex = localSequence.indexOf(itemId);
    const remoteIndex = remoteSequence.indexOf(itemId);
    return anchors.every(anchorId =>
      (localIndex < localSequence.indexOf(anchorId))
        === (remoteIndex < remoteSequence.indexOf(anchorId)));
  };
  for (const itemId of [...potentialItemIds].sort()) {
    const baseEntry = baseEntries.get(itemId) || null;
    const remoteEntry = remoteEntries.get(itemId) || null;
    const localItem = localProject.items[itemId] || null;
    const remoteItem = communityProject.items[itemId] || null;
    const baseParent =
      basePlacement.byItemId.get(itemId)?.parentItemId ?? null;
    const localParent =
      localPlacement.byItemId.get(itemId)?.parentItemId ?? null;
    const remoteParent =
      remotePlacement.byItemId.get(itemId)?.parentItemId ?? null;
    const groupCollision = newGroupCollisionByItemId.get(itemId);
    const newIdentitySelection =
      !baseEntry && localItem && remoteItem
        ? selectedSource.get(itemId) || null
        : null;
    if (newIdentitySelection && !newIdentitySelection.conflictId) {
      fail(
        'COMMUNITY_PLAN_RECONCILIATION_STRUCTURE_OVERLAP',
        'A new stable identity exists on both sides without one explicit source choice.',
        { itemId }
      );
    }
    const collisionConflictId =
      groupCollision?.conflictId
      || newLeafCollisionConflictByItemId.get(itemId)
      || newIdentitySelection?.conflictId
      || null;
    if (collisionConflictId) {
      finalParentByItemId.set(
        itemId,
        localItem ? localParent : remoteParent
      );
      selectedSource.set(`parent:${itemId}`, {
        conflictId: collisionConflictId,
        local: localParent,
        community: remoteParent,
        defaultChoice: 'keep-local'
      });
      placementSelections.set(itemId, {
        conflictId: collisionConflictId,
        localParent,
        remoteParent,
        localSequence: [...(
          localPlacement.childrenByParent.get(localParent) || []
        )],
        remoteSequence: [...(
          remotePlacement.childrenByParent.get(remoteParent) || []
        )]
      });
      continue;
    }
    if (!baseEntry) {
      finalParentByItemId.set(
        itemId,
        localItem ? localParent : remoteParent
      );
      continue;
    }
    if (!remoteEntry) {
      finalParentByItemId.set(itemId, localParent);
      continue;
    }
    if (!localItem) {
      finalParentByItemId.set(itemId, remoteParent);
      continue;
    }
    const deletedGroupPlacement =
      deletedGroupPlacementConflictByItemId.get(itemId);
    if (deletedGroupPlacement) {
      finalParentByItemId.set(
        itemId,
        deletedGroupPlacement.localParent
      );
      selectedSource.set(`parent:${itemId}`, {
        conflictId: deletedGroupPlacement.conflictId,
        local: deletedGroupPlacement.localParent,
        community: deletedGroupPlacement.remoteParent,
        defaultChoice: 'keep-local'
      });
      placementSelections.set(itemId, {
        conflictId: deletedGroupPlacement.conflictId,
        localParent: deletedGroupPlacement.localParent,
        remoteParent: deletedGroupPlacement.remoteParent,
        localSequence: [...(
          localPlacement.childrenByParent.get(
            deletedGroupPlacement.localParent
          ) || []
        )],
        remoteSequence: [...(
          remotePlacement.childrenByParent.get(
            deletedGroupPlacement.remoteParent
          ) || []
        )]
      });
      continue;
    }
    const localChanged =
      placementChangedFromBaseline(itemId, localPlacement);
    const remoteChanged =
      placementChangedFromBaseline(itemId, remotePlacement);
    const crossParentChange =
      localParent !== baseParent || remoteParent !== baseParent;
    if (
      localChanged
      && remoteChanged
      && crossParentChange
      && localParent !== remoteParent
      && !placementOutcomesEqual(itemId, localParent, remoteParent)
    ) {
      const entry = remoteEntries.get(itemId);
      const conflictId = addConflict({
        key: `placement:${itemId}`,
        kind: 'LOCAL_AND_COMMUNITY_STRUCTURE_CHANGED',
        itemId,
        entryId: entry.entryId,
        title: describeItem(
          localProject.items[itemId] || communityProject.items[itemId],
          entry.entryId
        ),
        localSummary: 'Keep this item at its local section and relative position.',
        communitySummary: 'Use the Community section and relative position for this item.'
      });
      finalParentByItemId.set(itemId, localParent);
      selectedSource.set(`parent:${itemId}`, {
        conflictId,
        local: localParent,
        community: remoteParent,
        defaultChoice: 'keep-local'
      });
      placementSelections.set(itemId, {
        conflictId,
        localParent,
        remoteParent,
        localSequence: [...(
          localPlacement.childrenByParent.get(localParent) || []
        )],
        remoteSequence: [...(
          remotePlacement.childrenByParent.get(remoteParent) || []
        )]
      });
    } else {
      finalParentByItemId.set(
        itemId,
        remoteChanged && !localChanged ? remoteParent : localParent
      );
    }
  }

  // A set of item-level placement conflicts can have two valid source
  // hierarchies while exposing an invalid mixed decision. Build the union of
  // every possible parent edge and couple all placement conflicts that share a
  // potential cycle. Choosing Local or Community for that whole connected
  // structure then selects one source-valid hierarchy instead of allowing an
  // A->B / B->A combination assembled from opposite sides.
  const potentialParentsByItemId = new Map();
  for (const itemId of [...potentialItemIds].sort()) {
    const selection = placementSelections.get(itemId);
    const localParent =
      localPlacement.byItemId.get(itemId)?.parentItemId ?? null;
    const remoteParent =
      remotePlacement.byItemId.get(itemId)?.parentItemId ?? null;
    const parentItemIds = selection
      ? [selection.localParent, selection.remoteParent]
      : (
          localProject.items[itemId] && communityProject.items[itemId]
            ? [localParent, remoteParent]
            : [finalParentByItemId.get(itemId) ?? null]
        );
    potentialParentsByItemId.set(
      itemId,
      [...new Set(parentItemIds)].filter(parentItemId =>
        parentItemId !== null
        && parentItemId !== undefined
        && potentialItemIds.has(parentItemId))
    );
  }
  let nextStrongIndex = 0;
  const strongIndexByItemId = new Map();
  const lowLinkByItemId = new Map();
  const strongStack = [];
  const onStrongStack = new Set();
  const potentialParentComponents = [];
  const visitPotentialParent = itemId => {
    strongIndexByItemId.set(itemId, nextStrongIndex);
    lowLinkByItemId.set(itemId, nextStrongIndex);
    nextStrongIndex += 1;
    strongStack.push(itemId);
    onStrongStack.add(itemId);
    for (const parentItemId of potentialParentsByItemId.get(itemId) || []) {
      if (!strongIndexByItemId.has(parentItemId)) {
        visitPotentialParent(parentItemId);
        lowLinkByItemId.set(
          itemId,
          Math.min(
            lowLinkByItemId.get(itemId),
            lowLinkByItemId.get(parentItemId)
          )
        );
      } else if (onStrongStack.has(parentItemId)) {
        lowLinkByItemId.set(
          itemId,
          Math.min(
            lowLinkByItemId.get(itemId),
            strongIndexByItemId.get(parentItemId)
          )
        );
      }
    }
    if (
      lowLinkByItemId.get(itemId) !== strongIndexByItemId.get(itemId)
    ) {
      return;
    }
    const component = [];
    let componentItemId;
    do {
      componentItemId = strongStack.pop();
      onStrongStack.delete(componentItemId);
      component.push(componentItemId);
    } while (componentItemId !== itemId);
    potentialParentComponents.push(component);
  };
  for (const itemId of [...potentialItemIds].sort()) {
    if (!strongIndexByItemId.has(itemId)) visitPotentialParent(itemId);
  }

  const coupledPlacementConflictGroups = [];
  const mergeCoupledPlacementGroup = (
    rawConflictIds,
    rawItemIds
  ) => {
    const merged = {
      conflictIds: new Set(rawConflictIds),
      itemIds: new Set(rawItemIds)
    };
    for (
      let index = coupledPlacementConflictGroups.length - 1;
      index >= 0;
      index -= 1
    ) {
      const existing = coupledPlacementConflictGroups[index];
      if (
        ![...existing.conflictIds].some(conflictId =>
          merged.conflictIds.has(conflictId))
      ) {
        continue;
      }
      existing.conflictIds.forEach(conflictId =>
        merged.conflictIds.add(conflictId));
      existing.itemIds.forEach(itemId => merged.itemIds.add(itemId));
      coupledPlacementConflictGroups.splice(index, 1);
    }
    coupledPlacementConflictGroups.push(merged);
  };
  for (const component of potentialParentComponents) {
    const componentIds = new Set(component);
    const cyclic = component.length > 1 || (
      component.length === 1
      && potentialParentsByItemId.get(component[0])?.includes(component[0])
    );
    if (!cyclic) continue;
    const conflictIds = new Set(
      component
        .map(itemId => placementSelections.get(itemId)?.conflictId)
        .filter(Boolean)
    );
    if (conflictIds.size < 1) continue;
    const affectedItemIds = component.filter(itemId => {
      if (!localProject.items[itemId] || !communityProject.items[itemId]) {
        return placementSelections.has(itemId);
      }
      const localParent =
        localPlacement.byItemId.get(itemId)?.parentItemId ?? null;
      const remoteParent =
        remotePlacement.byItemId.get(itemId)?.parentItemId ?? null;
      return localParent !== remoteParent || placementSelections.has(itemId);
    });
    mergeCoupledPlacementGroup(conflictIds, affectedItemIds);
  }
  coupledPlacementConflictGroups.sort((left, right) =>
    [...left.conflictIds].sort().join('\u0000').localeCompare(
      [...right.conflictIds].sort().join('\u0000')
    ));
  for (const coupledGroup of coupledPlacementConflictGroups) {
    const oldConflictIds = coupledGroup.conflictIds;
    const affectedItemIds = [...new Set([
      ...coupledGroup.itemIds,
      ...[...placementSelections.entries()]
      .filter(([, selection]) =>
        oldConflictIds.has(selection.conflictId))
        .map(([itemId]) => itemId)
    ])].sort();
    const coupledConflicts = conflicts.filter(conflict =>
      oldConflictIds.has(conflict.conflictId));
    const collisionConflicts = coupledConflicts.filter(conflict =>
      conflict.kind === 'LOCAL_ITEM_ID_COLLISION');
    const collisionTitles = collisionConflicts
      .map(conflict => conflict.title)
      .slice(0, 3);
    const undisclosedCollisionCount =
      collisionConflicts.length - collisionTitles.length;
    const collisionLabel = [
      collisionTitles.join(', '),
      undisclosedCollisionCount > 0
        ? `and ${undisclosedCollisionCount} more collision ${
            undisclosedCollisionCount === 1 ? 'subtree' : 'subtrees'
          }`
        : ''
    ].filter(Boolean).join(', ');
    const collisionNoun =
      collisionConflicts.length === 1 ? 'subtree' : 'subtrees';
    const restoredDeletionConflicts = coupledConflicts
      .filter(conflict =>
        conflict.kind === 'LOCAL_ITEM_DELETED_AFTER_COMMUNITY_CHANGE');
    const restoredDeletionTitles = restoredDeletionConflicts
      .map(conflict => conflict.title)
      .slice(0, 3);
    const undisclosedDeletionCount =
      restoredDeletionConflicts.length - restoredDeletionTitles.length;
    const restorationLabel = [
      restoredDeletionTitles.join(', '),
      undisclosedDeletionCount > 0
        ? `and ${undisclosedDeletionCount} more locally deleted ${
            undisclosedDeletionCount === 1 ? 'section' : 'sections'
          }`
        : ''
    ].filter(Boolean).join(', ');
    const restorationNoun =
      restoredDeletionConflicts.length === 1 ? 'section' : 'sections';
    const hasCollisionDisclosure = collisionConflicts.length > 0;
    const hasRestorationDisclosure =
      restoredDeletionConflicts.length > 0;
    const localSummary = hasCollisionDisclosure
      ? [
          `Use complete local collision ${collisionNoun}: content, local-only descendants, parent structure, and sibling placement.`,
          hasRestorationDisclosure
            ? `Keep the locally deleted ${restorationNoun} absent.`
            : '',
          `Affected collision ${collisionNoun}: ${collisionLabel}.`,
          hasRestorationDisclosure
            ? `Locally deleted ${restorationNoun}: ${restorationLabel}.`
            : ''
        ].filter(Boolean).join(' ')
      : (
          hasRestorationDisclosure
            ? `Use the complete local parent structure and keep the locally deleted ${restorationNoun} absent: ${restorationLabel}.`
            : 'Use the complete local parent structure for these connected moves.'
        );
    const communitySummary = hasCollisionDisclosure
      ? [
          `Use complete Community collision ${collisionNoun}: content, Community-only descendants, parent structure, and sibling placement.`,
          hasRestorationDisclosure
            ? `Restore the reviewed ${restorationNoun} and subtrees.`
            : '',
          `Affected collision ${collisionNoun}: ${collisionLabel}.`,
          hasRestorationDisclosure
            ? `Restored ${restorationNoun}: ${restorationLabel}.`
            : ''
        ].filter(Boolean).join(' ')
      : (
          hasRestorationDisclosure
            ? `Use the complete Community parent structure and restore the reviewed ${restorationNoun} and subtrees: ${restorationLabel}.`
            : 'Use the complete Community parent structure for these connected moves.'
        );
    const conflictId = addConflict({
      key: `placement-choice-set:${affectedItemIds.join(':')}`,
      kind: 'LOCAL_AND_COMMUNITY_STRUCTURE_CHANGED',
      itemId: affectedItemIds[0],
      title: hasCollisionDisclosure
        ? (
            hasRestorationDisclosure
              ? `Connected collision ${collisionNoun}, moves, and restoration`
              : `Connected collision ${collisionNoun} and moves`
          )
        : (
            hasRestorationDisclosure
              ? 'Connected section moves and restoration'
              : 'Connected section moves'
          ),
      localSummary,
      communitySummary
    });
    for (let index = conflicts.length - 1; index >= 0; index -= 1) {
      if (oldConflictIds.has(conflicts[index].conflictId)) {
        conflicts.splice(index, 1);
      }
    }
    for (const sourceSelection of selectedSource.values()) {
      if (oldConflictIds.has(sourceSelection.conflictId)) {
        sourceSelection.conflictId = conflictId;
      }
    }
    for (const itemId of affectedItemIds) {
      const localParent =
        localPlacement.byItemId.get(itemId)?.parentItemId ?? null;
      const remoteParent =
        remotePlacement.byItemId.get(itemId)?.parentItemId ?? null;
      finalParentByItemId.set(itemId, localParent);
      selectedSource.set(`parent:${itemId}`, {
        conflictId,
        local: localParent,
        community: remoteParent,
        defaultChoice: 'keep-local'
      });
      placementSelections.set(itemId, {
        conflictId,
        localParent,
        remoteParent,
        localSequence: [...(
          localPlacement.childrenByParent.get(localParent) || []
        )],
        remoteSequence: [...(
          remotePlacement.childrenByParent.get(remoteParent) || []
        )]
      });
    }
  }

  // Independently valid local and Community moves can compose into a cycle
  // even when neither side changed the same item. Collapse every such cycle
  // into one whole-structure choice so both outcomes remain valid and the
  // operator never receives only a generic normalization failure.
  const completedParentWalkIds = new Set();
  const parentCycles = [];
  for (const startItemId of [...potentialItemIds].sort()) {
    if (completedParentWalkIds.has(startItemId)) continue;
    const path = [];
    const pathIndexByItemId = new Map();
    let itemId = startItemId;
    while (
      itemId !== null
      && itemId !== undefined
      && potentialItemIds.has(itemId)
      && !completedParentWalkIds.has(itemId)
    ) {
      if (pathIndexByItemId.has(itemId)) {
        parentCycles.push(path.slice(pathIndexByItemId.get(itemId)));
        break;
      }
      pathIndexByItemId.set(itemId, path.length);
      path.push(itemId);
      itemId = finalParentByItemId.get(itemId) ?? null;
    }
    path.forEach(pathItemId => completedParentWalkIds.add(pathItemId));
  }
  for (const cycleItemIds of parentCycles) {
    if (cycleItemIds.some(itemId => placementSelections.has(itemId))) {
      fail(
        'COMMUNITY_PLAN_RECONCILIATION_STRUCTURE_OVERLAP',
        'Overlapping item-level and cross-section structure choices cannot be reconciled deterministically.',
        { itemIds: [...cycleItemIds].sort() }
      );
    }
    const sortedCycleItemIds = [...cycleItemIds].sort();
    const conflictId = addConflict({
      key: `placement-cycle:${sortedCycleItemIds.join(':')}`,
      kind: 'LOCAL_AND_COMMUNITY_STRUCTURE_CHANGED',
      itemId: sortedCycleItemIds[0],
      title: 'Conflicting section moves',
      localSummary:
        'Use the complete local parent structure for these moved sections.',
      communitySummary:
        'Use the complete Community parent structure for these moved sections.'
    });
    for (const cycleItemId of cycleItemIds) {
      const localParent =
        localPlacement.byItemId.get(cycleItemId)?.parentItemId ?? null;
      const remoteParent =
        remotePlacement.byItemId.get(cycleItemId)?.parentItemId ?? null;
      finalParentByItemId.set(cycleItemId, localParent);
      selectedSource.set(`parent:${cycleItemId}`, {
        conflictId,
        local: localParent,
        community: remoteParent,
        defaultChoice: 'keep-local'
      });
      placementSelections.set(cycleItemId, {
        conflictId,
        localParent,
        remoteParent,
        localSequence: [...(
          localPlacement.childrenByParent.get(localParent) || []
        )],
        remoteSequence: [...(
          remotePlacement.childrenByParent.get(remoteParent) || []
        )]
      });
    }
  }

  const parentIds = new Set([
    null,
    ...potentialGroupIds
  ]);
  const orderSelections = new Map();
  for (const parentItemId of [...parentIds].sort((left, right) =>
    String(left).localeCompare(String(right)))) {
    const baseSequence =
      basePlacement.childrenByParent.get(parentItemId) || [];
    const localSequence =
      (localPlacement.childrenByParent.get(parentItemId) || [])
        .filter(itemId => potentialItemIds.has(itemId));
    const remoteSequence =
      (remotePlacement.childrenByParent.get(parentItemId) || [])
        .filter(itemId => potentialItemIds.has(itemId));
    const localChanged = relativeOrderChanged(baseSequence, localSequence);
    const remoteChanged = relativeOrderChanged(baseSequence, remoteSequence);
    const commonManaged = new Set(
      [...selected.keys()].filter(itemId =>
        baseIds.has(itemId)
        && remoteIds.has(itemId)
        && localIds.has(itemId)
        && !placementSelections.has(itemId)
        && finalParentByItemId.get(itemId) === parentItemId)
    );
    const localComparable =
      localSequence.filter(itemId => commonManaged.has(itemId));
    const remoteComparable =
      remoteSequence.filter(itemId => commonManaged.has(itemId));
    const hasCommonMovedInItem = [...commonManaged].some(itemId =>
      basePlacement.byItemId.get(itemId)?.parentItemId !== parentItemId
      && localPlacement.byItemId.get(itemId)?.parentItemId === parentItemId
      && remotePlacement.byItemId.get(itemId)?.parentItemId === parentItemId);
    if (
      (localChanged && remoteChanged || hasCommonMovedInItem)
      && !equal(localComparable, remoteComparable)
    ) {
      const conflictId = addConflict({
        key: `order:${parentItemId || 'root'}`,
        kind: 'LOCAL_AND_COMMUNITY_STRUCTURE_CHANGED',
        itemId: parentItemId,
        title: parentItemId
          ? describeItem(selected.get(parentItemId), parentItemId)
          : 'Top-level service order',
        localSummary: 'Keep the local order in this section.',
        communitySummary: 'Use the changed Community order in this section.'
      });
      orderSelections.set(parentItemId, {
        conflictId,
        local: localSequence,
        community: remoteSequence
      });
    } else {
      orderSelections.set(parentItemId, {
        source: remoteChanged ? 'community' : 'local',
        value: remoteChanged ? remoteSequence : localSequence
      });
    }
  }

  const nextBaseline =
    deriveCommunityServicePlanBaselineWithComponentOverrides(
      communityBaseline,
      baselineComponentOverrides
    );
  if (conflicts.length > MAX_COMMUNITY_PLAN_RECONCILIATION_CONFLICTS) {
    return freezeDeep({
      schemaVersion: 1,
      mode: 'three-way',
      applicable: false,
      baselinePlanRevision: baseline.planRevision,
      baselineProjectionSha256: baseline.projectionSha256,
      candidatePlanRevision: communityBaseline.planRevision,
      candidateProjectionSha256: nextBaseline.projectionSha256,
      preservedLocalItemCount,
      appliedCommunityItemCount,
      autoMergedItemCount,
      conflictCount: conflicts.length,
      conflictsTruncated: true,
      conflicts: conflicts.slice(
        0,
        MAX_COMMUNITY_PLAN_RECONCILIATION_CONFLICTS
      )
    });
  }

  const decisions = normalizeDecisions(rawDecisions, conflicts, {
    required: requireDecisions
  });
  const choiceFor = conflictId =>
    decisions.get(conflictId) || 'keep-local';
  const restoredCommunityGroups = [];

  for (const [key, selection] of selectedSource) {
    if (!selection.conflictId) continue;
    const choice = choiceFor(selection.conflictId);
    const chosen = choice === 'use-community'
      ? selection.community
      : selection.local;
    if (typeof key === 'string' && key.startsWith('parent:')) {
      finalParentByItemId.set(key.slice('parent:'.length), chosen);
      continue;
    }
    if (chosen) {
      selected.set(key, chosen);
      if (
        choice === 'use-community'
        && !selection.local
        && selection.community?.kind === 'group'
      ) {
        restoredCommunityGroups.push(key);
      }
    } else {
      selected.delete(key);
      forcedRemovalIds.add(key);
      if (selection.communityRemovesSubtree) {
        const localDescendants = descendants(localProject, key);
        const protectedByKeptGroup = new Set();
        for (const descendantId of localDescendants) {
          const descendantSelection = selectedSource.get(descendantId);
          if (
            descendantSelection?.conflictId
            && choiceFor(descendantSelection.conflictId) === 'keep-local'
            && localProject.items[descendantId]?.kind === 'group'
          ) {
            for (const protectedId of descendants(
              localProject,
              descendantId
            )) {
              protectedByKeptGroup.add(protectedId);
            }
          }
        }
        for (const descendantId of localDescendants) {
          // "Use Community" accepts deletion of the local-only subtree, but
          // Community-managed descendants that still exist in the new plan
          // must survive so they can follow their new remote placement.
          const descendantSelection = selectedSource.get(descendantId);
          const explicitlyKept =
            descendantSelection?.conflictId
            && choiceFor(descendantSelection.conflictId) === 'keep-local';
          if (
            !remoteEntries.has(descendantId)
            && !explicitlyKept
            && !protectedByKeptGroup.has(descendantId)
          ) {
            forcedRemovalIds.add(descendantId);
          }
        }
      }
    }
  }

  // A local group deletion removes its descendants as one operator action.
  // If the group itself changed remotely and the operator chooses Community,
  // restore its unchanged remote descendants too. Descendants with their own
  // conflicts still obey their own explicit choices.
  const restoreCommunityDescendants = groupItemId => {
    const group = communityProject.items[groupItemId];
    if (!group || group.kind !== 'group') return;
    for (const childId of group.childIds) {
      const child = communityProject.items[childId];
      if (!child) continue;
      const selection = selectedSource.get(childId);
      if (
        selection?.conflictId
        && !selection.local
        && choiceFor(selection.conflictId) !== 'use-community'
      ) {
        continue;
      }
      if (!selected.has(childId)) selected.set(childId, child);
      if (child.kind === 'group' && selected.has(childId)) {
        restoreCommunityDescendants(childId);
      }
    }
  };
  restoredCommunityGroups.forEach(restoreCommunityDescendants);
  const protectedByExplicitKeep = new Set();
  for (const [itemId, selection] of selectedSource) {
    if (
      typeof itemId !== 'string'
      || itemId.startsWith('parent:')
      || !selection.conflictId
      || choiceFor(selection.conflictId) !== 'keep-local'
      || !selection.local
    ) {
      continue;
    }
    protectedByExplicitKeep.add(itemId);
    if (selection.local.kind === 'group') {
      for (const descendantId of descendants(localProject, itemId)) {
        protectedByExplicitKeep.add(descendantId);
      }
    }
  }
  for (const itemId of forcedRemovalIds) {
    if (!protectedByExplicitKeep.has(itemId)) selected.delete(itemId);
  }
  for (const [itemId, selection] of titleSelections) {
    const item = selected.get(itemId);
    if (!item) continue;
    const title = selection.conflictId
      ? (
          choiceFor(selection.conflictId) === 'use-community'
            ? selection.community
            : selection.local
        )
      : selection.value;
    if (item.title !== title) {
      selected.set(itemId, { ...clone(item), title });
    }
  }

  // Resolve placement after existence choices. This is essential for a
  // locally deleted item restored from Community: it must return to the exact
  // reviewed parent/order rather than falling through to the root.
  finalParentByItemId.clear();
  for (const itemId of [...selected.keys()].sort()) {
    const baseEntry = baseEntries.get(itemId) || null;
    const remoteEntry = remoteEntries.get(itemId) || null;
    const localItem = localProject.items[itemId] || null;
    const remoteItem = communityProject.items[itemId] || null;
    const baseParent =
      basePlacement.byItemId.get(itemId)?.parentItemId ?? null;
    const localParent =
      localPlacement.byItemId.get(itemId)?.parentItemId ?? null;
    const remoteParent =
      remotePlacement.byItemId.get(itemId)?.parentItemId ?? null;
    if (!baseEntry) {
      const existenceSelection = selectedSource.get(itemId);
      if (
        localItem
        && remoteItem
        && existenceSelection?.conflictId
      ) {
        finalParentByItemId.set(
          itemId,
          choiceFor(existenceSelection.conflictId) === 'use-community'
            ? remoteParent
            : localParent
        );
      } else {
        finalParentByItemId.set(
          itemId,
          remoteItem && !localItem ? remoteParent : localParent
        );
      }
      continue;
    }
    if (!remoteEntry) {
      finalParentByItemId.set(itemId, localParent);
      continue;
    }
    if (!localItem) {
      finalParentByItemId.set(itemId, remoteParent);
      continue;
    }
    const parentSelection = selectedSource.get(`parent:${itemId}`);
    if (parentSelection?.conflictId) {
      finalParentByItemId.set(
        itemId,
        choiceFor(parentSelection.conflictId) === 'use-community'
          ? parentSelection.community
          : parentSelection.local
      );
      continue;
    }
    const localChanged = localParent !== baseParent;
    const remoteChanged = remoteParent !== baseParent;
    finalParentByItemId.set(
      itemId,
      remoteChanged && !localChanged ? remoteParent : localParent
    );
  }

  // When a parent deletion or group-to-leaf kind change is accepted but a
  // descendant is kept, lift that descendant to the nearest surviving local
  // group ancestor. An explicit child choice must never be silently undone by
  // a broader parent choice.
  for (const itemId of [...selected.keys()]) {
    let parentItemId = finalParentByItemId.get(itemId);
    const visited = new Set();
    while (
      parentItemId !== null
      && parentItemId !== undefined
      && (
        !selected.has(parentItemId)
        || selected.get(parentItemId)?.kind !== 'group'
      )
    ) {
      if (visited.has(parentItemId)) {
        fail(
          'COMMUNITY_PLAN_RECONCILIATION_INVALID_RESULT',
          'The reviewed local hierarchy contains a cycle.'
        );
      }
      visited.add(parentItemId);
      parentItemId =
        localPlacement.byItemId.get(parentItemId)?.parentItemId ?? null;
    }
    finalParentByItemId.set(itemId, parentItemId ?? null);
  }

  let removedOrphan = true;
  while (removedOrphan) {
    removedOrphan = false;
    for (const itemId of [...selected.keys()]) {
      const parentItemId = finalParentByItemId.get(itemId);
      if (
        parentItemId !== null
        && parentItemId !== undefined
        && !selected.has(parentItemId)
      ) {
        selected.delete(itemId);
        removedOrphan = true;
      }
    }
  }

  // Candidate-scoped pruning must include records reachable only from local
  // items that this reviewed merge removed or replaced. Otherwise accepting a
  // Community parent deletion could leave the removed local-only cue's private
  // song/sermon/asset record hitchhiking in the new active revision.
  for (const [itemId, localItem] of Object.entries(localProject.items)) {
    const mergedItem = selected.get(itemId);
    if (!mergedItem || !equal(localItem, mergedItem)) {
      addItemRecordCandidates(
        localProject,
        localItem,
        candidateResourceIds,
        candidateAssetIds
      );
    }
  }

  const rawMerged = clone(localProject);
  rawMerged.title = metadataSelection.has('title')
    ? (() => {
        const selection = metadataSelection.get('title');
        return selection.conflictId
          ? (choiceFor(selection.conflictId) === 'use-community'
              ? selection.community
              : selection.local)
          : selection.value;
      })()
    : localProject.title;
  rawMerged.serviceDate = (() => {
    const selection = metadataSelection.get('serviceDate');
    return selection.conflictId
      ? (choiceFor(selection.conflictId) === 'use-community'
          ? selection.community
          : selection.local)
      : selection.value;
  })();
  rawMerged.items = Object.fromEntries(
    [...selected.entries()].map(([itemId, item]) => [itemId, clone(item)])
  );
  const locallySelectedResourceIds = new Set();
  const locallySelectedAssetIds = new Set();
  for (const [itemId, item] of selected) {
    const sourceSelection = selectedSource.get(itemId);
    const keepsLocal = sourceSelection?.conflictId
      ? choiceFor(sourceSelection.conflictId) === 'keep-local'
      : sourceSelection?.source !== 'community';
    if (!keepsLocal || !localProject.items[itemId]) continue;
    addItemRecordCandidates(
      localProject,
      item,
      locallySelectedResourceIds,
      locallySelectedAssetIds
    );
  }
  rawMerged.resources = clone(communityProject.resources);
  for (const [resourceId, resource] of Object.entries(
    localProject.resources
  )) {
    if (
      !Object.prototype.hasOwnProperty.call(rawMerged.resources, resourceId)
      || locallySelectedResourceIds.has(resourceId)
    ) {
      rawMerged.resources[resourceId] = clone(resource);
    }
  }
  rawMerged.assets = clone(communityProject.assets);
  for (const [assetId, asset] of Object.entries(localProject.assets)) {
    if (
      !Object.prototype.hasOwnProperty.call(rawMerged.assets, assetId)
      || locallySelectedAssetIds.has(assetId)
    ) {
      rawMerged.assets[assetId] = clone(asset);
    }
  }

  const childIdsByParent = new Map();
  for (const parentItemId of parentIds) {
    if (parentItemId !== null && !selected.has(parentItemId)) continue;
    const allowedIds = new Set(
      [...selected.keys()].filter(itemId =>
        (finalParentByItemId.get(itemId) ?? null) === parentItemId)
    );
    const selection = orderSelections.get(parentItemId) || {
      source: 'local',
      value: []
    };
    const selectedOrder = selection.conflictId
      ? (
          choiceFor(selection.conflictId) === 'use-community'
            ? selection.community
            : selection.local
        )
      : selection.value;
    const secondary = selection.conflictId
      ? (
          choiceFor(selection.conflictId) === 'use-community'
            ? selection.local
            : selection.community
        )
      : (
          selection.source === 'community'
            ? (localPlacement.childrenByParent.get(parentItemId) || [])
            : (remotePlacement.childrenByParent.get(parentItemId) || [])
        );
    childIdsByParent.set(
      parentItemId,
      mergeMissingItems(selectedOrder, secondary, allowedIds)
    );
  }

  const chosenPlacements = [...placementSelections.entries()]
    .filter(([itemId]) => selected.has(itemId))
    .map(([itemId, selection]) => {
      const useCommunity =
        choiceFor(selection.conflictId) === 'use-community';
      // Existence and kind decisions may already have lifted this item away
      // from a deleted or no-longer-group parent. Keep that validated target;
      // the reviewed side's sequence is only an ordering reference.
      const parentItemId = finalParentByItemId.get(itemId) ?? null;
      const referenceSequence = useCommunity
        ? selection.remoteSequence
        : selection.localSequence;
      return {
        itemId,
        parentItemId,
        referenceSequence,
        referenceIndex: referenceSequence.indexOf(itemId)
      };
    })
    .sort((left, right) =>
      String(left.parentItemId).localeCompare(String(right.parentItemId))
      || left.referenceIndex - right.referenceIndex
      || left.itemId.localeCompare(right.itemId));
  for (const placement of chosenPlacements) {
    for (const childIds of childIdsByParent.values()) {
      const currentIndex = childIds.indexOf(placement.itemId);
      if (currentIndex >= 0) childIds.splice(currentIndex, 1);
    }
    const target = childIdsByParent.get(placement.parentItemId);
    if (!target) continue;
    const referenceIndex = placement.referenceSequence.indexOf(
      placement.itemId
    );
    let insertAt = target.length;
    for (let index = referenceIndex - 1; index >= 0; index -= 1) {
      const anchorIndex = target.indexOf(placement.referenceSequence[index]);
      if (anchorIndex >= 0) {
        insertAt = anchorIndex + 1;
        break;
      }
    }
    if (insertAt === target.length) {
      for (
        let index = referenceIndex + 1;
        index < placement.referenceSequence.length;
        index += 1
      ) {
        const anchorIndex = target.indexOf(
          placement.referenceSequence[index]
        );
        if (anchorIndex >= 0) {
          insertAt = anchorIndex;
          break;
        }
      }
    }
    target.splice(insertAt, 0, placement.itemId);
  }
  rawMerged.rootItemIds = childIdsByParent.get(null) || [];
  for (const [itemId, item] of Object.entries(rawMerged.items)) {
    if (item.kind === 'group') {
      item.childIds = childIdsByParent.get(itemId) || [];
    }
  }

  const startTimeSelection = metadataSelection.get('startTime');
  const teamNotesSelection = metadataSelection.get('teamNotes');
  rawMerged.planning = clone(communityProject.planning);
  const nextCollisionBoundaryItemIds = new Set(
    retainedCollisionBoundaryItemIds
  );
  for (const itemId of [...nextCollisionBoundaryItemIds]) {
    const selection = selectedSource.get(itemId);
    if (
      !localProject.items[itemId]
      || !remoteEntries.has(itemId)
      || (
        selection
        && choiceFor(selection.conflictId) === 'use-community'
      )
    ) {
      nextCollisionBoundaryItemIds.delete(itemId);
    }
  }
  for (const [itemId, conflictId] of groupCollisionConflictByRootId) {
    const activeConflictId =
      selectedSource.get(itemId)?.conflictId || conflictId;
    if (choiceFor(activeConflictId) === 'keep-local') {
      nextCollisionBoundaryItemIds.add(itemId);
    } else {
      nextCollisionBoundaryItemIds.delete(itemId);
    }
  }
  if (nextCollisionBoundaryItemIds.size > 0) {
    rawMerged.planning.localCollisionBoundaryItemIds =
      [...nextCollisionBoundaryItemIds].sort();
  } else {
    delete rawMerged.planning.localCollisionBoundaryItemIds;
  }
  rawMerged.planning.status = 'planning';
  delete rawMerged.planning.readinessWaivers;
  rawMerged.planning.startTime = startTimeSelection.conflictId
    ? (
        choiceFor(startTimeSelection.conflictId) === 'use-community'
          ? startTimeSelection.community
          : startTimeSelection.local
      )
    : startTimeSelection.value;
  const teamNotes = teamNotesSelection.conflictId
    ? (
        choiceFor(teamNotesSelection.conflictId) === 'use-community'
          ? teamNotesSelection.community
          : teamNotesSelection.local
      )
    : teamNotesSelection.value;
  rawMerged.planning.teamNotes = teamNotes;
  if (localProject.planning.serving) {
    rawMerged.planning.serving =
      pruneMissingServiceProjectServingItemScopes(
        localProject.planning.serving,
        { itemIds: Object.keys(rawMerged.items) }
      );
  } else {
    delete rawMerged.planning.serving;
  }
  rawMerged.planning.reconciliationBaseline = nextBaseline;
  rawMerged.planning.schemaVersion = 3;

  for (const replacement of sermonReplacementChangeGroups) {
    if (
      replacement.conflictId
      && choiceFor(replacement.conflictId) !== 'use-community'
    ) {
      continue;
    }
    const affectedProjectionItemIds = new Set();
    const replacedOwnerItemIds = new Set(
      replacement.ownerRecords.map(owner => owner.itemId)
    );
    for (const owner of replacement.ownerRecords) {
      for (const descendantId of descendants(localProject, owner.itemId)) {
        const localDescendant = localProject.items[descendantId];
        const sourceLink = localDescendant?.kind === 'sermon'
          ? resolveSermonSourceLink(localProject, localDescendant)
          : null;
        if (
          localDescendant?.kind === 'sermon'
          && localDescendant.sourceBodyProjection
          && replacement.previousResourceIds.has(
            sourceLink?.resourceId
          )
          && replacedOwnerItemIds.has(sourceLink?.resourceOwnerId)
        ) {
          affectedProjectionItemIds.add(descendantId);
        }
      }
    }
    for (const descendantId of affectedProjectionItemIds) {
      const descendant = rawMerged.items[descendantId];
      if (
        descendant?.kind === 'sermon'
        && descendant.sourceBodyProjection
      ) {
        delete descendant.sourceBodyProjection;
        descendant.updatedAt =
          communityProject.planning.source.importedAt;
      }
    }
  }

  let mergedProject;
  try {
    let normalizedMerged = normalizeServiceProject(rawMerged);
    for (const change of sermonPinChangeGroups) {
      if (
        change.conflictId
        && choiceFor(change.conflictId) !== 'use-community'
      ) {
        continue;
      }
      for (
        const previousResourceId
        of [...change.previousResourceIds].sort()
      ) {
        normalizedMerged = repinSermonRevision(normalizedMerged, {
          previousResourceId,
          nextResourceId: change.nextResourceId,
          now: communityProject.planning.source.importedAt
        });
      }
    }
    const prunedMerged = pruneUnreachableProjectRecords(
      normalizedMerged,
      {
        resourceIds: [...candidateResourceIds],
        assetIds: [...candidateAssetIds]
      }
    );
    mergedProject = bindCommunityServicePlanBaseline(
      prunedMerged,
      nextBaseline
    );
  } catch (error) {
    if (error instanceof CommunityServicePlanReconciliationError) throw error;
    fail(
      'COMMUNITY_PLAN_RECONCILIATION_INVALID_RESULT',
      'These choices cannot form a valid native service project. Keep the affected local work and review its linked sermon, Scripture, or song treatment before retrying.',
      { cause: error.code || error.message }
    );
  }

  const publicConflicts = conflicts.map(conflict => freezeDeep(conflict));
  return freezeDeep({
    schemaVersion: 1,
    mode: 'three-way',
    applicable: true,
    baselinePlanRevision: baseline.planRevision,
    baselineProjectionSha256: baseline.projectionSha256,
    candidatePlanRevision: communityBaseline.planRevision,
    candidateProjectionSha256: nextBaseline.projectionSha256,
    mergeResultSha256: reconciliationProjectSha256(mergedProject),
    preservedLocalItemCount,
    appliedCommunityItemCount,
    autoMergedItemCount,
    conflictCount: publicConflicts.length,
    conflictsTruncated: false,
    conflicts: publicConflicts,
    decisions: [...decisions.entries()].map(([conflictId, choice]) => ({
      conflictId,
      choice
    })),
    project: mergedProject
  });
}

function publicCommunityServicePlanReconciliation(result) {
  return freezeDeep({
    schemaVersion: result.schemaVersion,
    mode: result.mode,
    applicable: result.applicable,
    baselinePlanRevision: result.baselinePlanRevision,
    baselineProjectionSha256: result.baselineProjectionSha256,
    candidatePlanRevision: result.candidatePlanRevision,
    candidateProjectionSha256: result.candidateProjectionSha256,
    mergeResultSha256: result.mergeResultSha256 || null,
    preservedLocalItemCount: result.preservedLocalItemCount,
    appliedCommunityItemCount: result.appliedCommunityItemCount,
    autoMergedItemCount: result.autoMergedItemCount,
    conflictCount: result.conflictCount,
    conflictsTruncated: result.conflictsTruncated,
    conflicts: result.conflicts
  });
}

module.exports = {
  CHOICES,
  MAX_COMMUNITY_PLAN_RECONCILIATION_CONFLICTS,
  CommunityServicePlanReconciliationError,
  buildCommunityServicePlanReconciliation,
  publicCommunityServicePlanReconciliation,
  reconciliationProjectSha256
};
