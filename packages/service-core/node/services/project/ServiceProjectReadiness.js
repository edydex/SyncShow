'use strict';

const {
  ServiceProjectError,
  compileServiceProject,
  normalizeServiceProject,
  resolveSermonSourceLink,
  sermonReadingOutputPlan,
  sermonReadingOutputPlanSignature,
  validateProjectTree
} = require('./ServiceProject');

const SERVICE_READINESS_SCHEMA_VERSION = 1;
const SERVICE_READINESS_REPORT_KIND = 'syncshow-service-readiness-report';
const MAX_SERVICE_READINESS_WAIVERS = 5;

// These IDs are a persisted/operator-facing contract. Keep their order stable:
// reports, blockers, and applied waivers all use this order rather than caller
// or object insertion order.
const SERVICE_READINESS_CHECKS = Object.freeze([
  Object.freeze({
    id: 'compilable-nonempty',
    waivable: false,
    blockerCode: 'SERVICE_NOT_COMPILABLE_NONEMPTY',
    message: 'The native service must compile to at least one cue.'
  }),
  Object.freeze({
    id: 'song-present',
    waivable: true,
    blockerCode: 'SERVICE_SONG_MISSING',
    message: 'Add at least one song to the service order.'
  }),
  Object.freeze({
    id: 'exact-sermon-link',
    waivable: true,
    blockerCode: 'SERVICE_SERMON_LINK_MISSING',
    message: 'Link at least one exact sermon packet revision.'
  }),
  Object.freeze({
    id: 'linked-sermon-material',
    waivable: true,
    blockerCode: 'SERVICE_SERMON_MATERIAL_MISSING',
    message: 'Add a projected sermon cue or imported deck under an exact sermon link.'
  }),
  Object.freeze({
    id: 'sermon-reading-before-material',
    waivable: true,
    blockerCode: 'SERVICE_SERMON_READING_MISSING',
    message: 'Place an exact linked sermon reading before its projected sermon material.'
  }),
  Object.freeze({
    id: 'channel-visible-content',
    waivable: true,
    blockerCode: 'SERVICE_CHANNEL_CONTENT_MISSING',
    message: 'Every configured channel must have visible projected content.'
  })
]);
const SERVICE_READINESS_CHECK_IDS = Object.freeze(
  SERVICE_READINESS_CHECKS.map(check => check.id)
);
const SERVICE_READINESS_CHECK_BY_ID = new Map(
  SERVICE_READINESS_CHECKS.map(check => [check.id, check])
);

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function readinessError(code, message, details = {}) {
  return new ServiceProjectError(code, message, details);
}

function normalizeWaivers(options) {
  if (options === undefined) return new Map();
  if (!isRecord(options)) {
    throw readinessError(
      'INVALID_SERVICE_READINESS_OPTIONS',
      'Service readiness options must be an object.'
    );
  }
  const unexpectedOptions = Object.keys(options).filter(key => key !== 'waivers');
  if (unexpectedOptions.length > 0) {
    throw readinessError(
      'INVALID_SERVICE_READINESS_OPTIONS',
      'Service readiness options contain unsupported fields.',
      { fields: unexpectedOptions.sort() }
    );
  }
  const rawWaivers = options.waivers === undefined ? [] : options.waivers;
  if (!Array.isArray(rawWaivers)) {
    throw readinessError(
      'INVALID_SERVICE_READINESS_WAIVER',
      'Service readiness waivers must be a list.'
    );
  }
  if (rawWaivers.length > MAX_SERVICE_READINESS_WAIVERS) {
    throw readinessError(
      'TOO_MANY_SERVICE_READINESS_WAIVERS',
      `A service may use at most ${MAX_SERVICE_READINESS_WAIVERS} readiness waivers.`,
      { maximum: MAX_SERVICE_READINESS_WAIVERS }
    );
  }

  const waivers = new Map();
  for (const [index, rawWaiver] of rawWaivers.entries()) {
    if (!isRecord(rawWaiver)) {
      throw readinessError(
        'INVALID_SERVICE_READINESS_WAIVER',
        `Readiness waiver ${index + 1} must be an object.`,
        { index }
      );
    }
    const unexpectedFields = Object.keys(rawWaiver)
      .filter(key => !['checkId', 'reason'].includes(key));
    if (unexpectedFields.length > 0) {
      throw readinessError(
        'INVALID_SERVICE_READINESS_WAIVER',
        `Readiness waiver ${index + 1} contains unsupported fields.`,
        { index, fields: unexpectedFields.sort() }
      );
    }
    if (typeof rawWaiver.checkId !== 'string'
      || !SERVICE_READINESS_CHECK_BY_ID.has(rawWaiver.checkId)) {
      throw readinessError(
        'UNKNOWN_SERVICE_READINESS_WAIVER',
        `Readiness waiver ${index + 1} does not identify a known check.`,
        { index, checkId: rawWaiver.checkId }
      );
    }
    const check = SERVICE_READINESS_CHECK_BY_ID.get(rawWaiver.checkId);
    if (!check.waivable) {
      throw readinessError(
        'UNWAIVABLE_SERVICE_READINESS_CHECK',
        `Readiness check ${check.id} cannot be waived.`,
        { index, checkId: check.id }
      );
    }
    if (waivers.has(check.id)) {
      throw readinessError(
        'DUPLICATE_SERVICE_READINESS_WAIVER',
        `Readiness check ${check.id} has more than one waiver.`,
        { index, checkId: check.id }
      );
    }
    if (typeof rawWaiver.reason !== 'string') {
      throw readinessError(
        'INVALID_SERVICE_READINESS_WAIVER',
        `Readiness waiver ${index + 1} needs a human reason.`,
        { index, checkId: check.id }
      );
    }
    const reason = rawWaiver.reason.trim().normalize('NFC');
    if (!reason
      || reason.length > 500
      || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(reason)) {
      throw readinessError(
        'INVALID_SERVICE_READINESS_WAIVER',
        `Readiness waiver ${index + 1} needs a valid human reason of 500 characters or fewer.`,
        { index, checkId: check.id }
      );
    }
    waivers.set(check.id, reason);
  }
  return waivers;
}

function orderedProjectItemIds(project) {
  const result = [];
  const visit = itemId => {
    result.push(itemId);
    const item = project.items[itemId];
    if (item.kind === 'group') item.childIds.forEach(visit);
  };
  project.rootItemIds.forEach(visit);
  return result;
}

function resolvedChannel(cue, channelId) {
  const seen = new Set();
  let channel = cue.channels[channelId];
  while (channel?.mode === 'inherit' && !seen.has(channel.from)) {
    seen.add(channel.from);
    channel = cue.channels[channel.from];
  }
  return channel;
}

function isVisibleBlock(block) {
  if (!block || block.type === 'blank') return false;
  if (block.type === 'text') return /\S/u.test(block.text || '');
  if (block.type === 'bible') {
    return Array.isArray(block.verses)
      && block.verses.some(verse => /\S/u.test(verse?.text || ''));
  }
  return block.type === 'image' || block.type === 'legacy-deck';
}

function cueIsVisibleInChannel(cue, channelId) {
  const channel = resolvedChannel(cue, channelId);
  return Boolean(
    channel
    && channel.mode !== 'hide'
    && Array.isArray(channel.blocks)
    && channel.blocks.some(isVisibleBlock)
  );
}

function cueIndexesByItemId(timeline) {
  const result = new Map();
  if (!timeline) return result;
  timeline.cueIds.forEach((cueId, cueIndex) => {
    const itemId = timeline.cues[cueId]?.itemId;
    if (!itemId) return;
    if (!result.has(itemId)) result.set(itemId, []);
    result.get(itemId).push(cueIndex);
  });
  return result;
}

function sermonMaterialSetItemId(project, item, projectIndex, resolved) {
  let parentId = projectIndex.parentByItemId[item.id];
  while (parentId !== null && parentId !== undefined) {
    const parent = project.items[parentId];
    if (parent?.kind === 'group' && parent.groupKind === 'sermon') {
      return parent.id;
    }
    parentId = projectIndex.parentByItemId[parentId];
  }
  return resolved.resourceOwnerId;
}

function completeReadingItemIdsBeforeMaterial(readings, firstMaterialCueIndex) {
  if (!Number.isSafeInteger(firstMaterialCueIndex)) return [];
  const sets = new Map();
  for (const reading of readings) {
    const key = JSON.stringify([
      reading.referenceId,
      reading._outputPlanSignature,
      reading.chunkCount
    ]);
    if (!sets.has(key)) sets.set(key, []);
    sets.get(key).push(reading);
  }

  const completeSets = [];
  for (const [key, candidates] of sets.entries()) {
    const chunkCount = candidates[0]?.chunkCount;
    if (!Number.isSafeInteger(chunkCount)
      || chunkCount < 1
      || candidates.length !== chunkCount) {
      continue;
    }
    const ordered = [...candidates].sort((left, right) =>
      left.chunkIndex - right.chunkIndex
      || (left.cueIndex ?? Number.MAX_SAFE_INTEGER)
        - (right.cueIndex ?? Number.MAX_SAFE_INTEGER)
      || left.itemId.localeCompare(right.itemId, 'en'));
    const complete = ordered.every((reading, chunkIndex) =>
      reading.chunkIndex === chunkIndex
      && Number.isSafeInteger(reading.cueIndex)
      && reading.cueIndex < firstMaterialCueIndex
      && (chunkIndex === 0
        || ordered[chunkIndex - 1].cueIndex < reading.cueIndex));
    if (!complete) continue;
    completeSets.push({
      key,
      firstCueIndex: ordered[0].cueIndex,
      itemIds: ordered.map(reading => reading.itemId)
    });
  }

  completeSets.sort((left, right) =>
    left.firstCueIndex - right.firstCueIndex
    || left.key.localeCompare(right.key, 'en'));
  return completeSets[0]?.itemIds || [];
}

function collectSermonEvidence(project, timeline, orderedItemIds, projectIndex) {
  const itemOrder = new Map(
    orderedItemIds.map((itemId, index) => [itemId, index])
  );
  const cueIndexes = cueIndexesByItemId(timeline);
  const evidenceByResourceId = new Map();

  const ensureEvidence = resolved => {
    let evidence = evidenceByResourceId.get(resolved.resourceId);
    if (!evidence) {
      evidence = {
        resourceId: resolved.resourceId,
        sermonId: resolved.resource.document.id,
        sermonRevisionId: resolved.resource.sha256,
        firstOwnerOrder: Number.MAX_SAFE_INTEGER,
        ownerItemIds: [],
        material: [],
        materialSetItemIds: new Set(),
        readings: []
      };
      evidenceByResourceId.set(resolved.resourceId, evidence);
    }
    return evidence;
  };

  // A direct resource owner proves that the service pins one immutable sermon
  // revision. Inherited links alone are material placement, not a second packet.
  for (const itemId of orderedItemIds) {
    const item = project.items[itemId];
    if (!item.sermonResourceId || !['group', 'sermon'].includes(item.kind)) continue;
    const resolved = resolveSermonSourceLink(project, item, projectIndex);
    const evidence = ensureEvidence(resolved);
    evidence.ownerItemIds.push(itemId);
    evidence.firstOwnerOrder = Math.min(
      evidence.firstOwnerOrder,
      itemOrder.get(itemId) ?? Number.MAX_SAFE_INTEGER
    );
  }

  // Only material that actually compiles to a visible cue counts as projected.
  // Imported decks inherit exact sermon provenance from their ancestor group.
  for (const itemId of orderedItemIds) {
    const item = project.items[itemId];
    if (!['sermon', 'imported-deck'].includes(item.kind)) continue;
    const resolved = resolveSermonSourceLink(project, item, projectIndex);
    if (!resolved || !evidenceByResourceId.has(resolved.resourceId)) continue;
    const itemCueIndexes = cueIndexes.get(itemId) || [];
    const visibleCueIndexes = itemCueIndexes.filter(cueIndex => {
      const cue = timeline?.cues[timeline.cueIds[cueIndex]];
      return cue && project.channelIds.some(channelId =>
        cueIsVisibleInChannel(cue, channelId));
    });
    if (visibleCueIndexes.length < 1) continue;
    const evidence = evidenceByResourceId.get(resolved.resourceId);
    evidence.materialSetItemIds.add(
      sermonMaterialSetItemId(project, item, projectIndex, resolved)
    );
    evidence.material.push({
      itemId,
      kind: item.kind,
      firstCueIndex: visibleCueIndexes[0],
      cueCount: visibleCueIndexes.length
    });
  }

  for (const itemId of orderedItemIds) {
    const item = project.items[itemId];
    if (item.kind !== 'bible' || !item.sermonReading) continue;
    const evidence = evidenceByResourceId.get(item.sermonReading.sermonResourceId);
    if (!evidence) continue;
    const firstCueIndex = (cueIndexes.get(itemId) || [])[0];
    const outputs = sermonReadingOutputPlan(project, item);
    const readingEvidence = {
      itemId,
      referenceId: item.sermonReading.referenceId,
      ...(Array.isArray(item.sermonReading.outputs)
        ? { outputs }
        : { translationId: item.sermonReading.translationId }),
      chunkIndex: item.sermonReading.chunkIndex,
      chunkCount: item.sermonReading.chunkCount,
      cueIndex: Number.isSafeInteger(firstCueIndex) ? firstCueIndex : null
    };
    Object.defineProperty(readingEvidence, '_outputPlanSignature', {
      value: sermonReadingOutputPlanSignature(outputs),
      enumerable: false
    });
    evidence.readings.push(readingEvidence);
  }

  return [...evidenceByResourceId.values()]
    .sort((left, right) =>
      left.firstOwnerOrder - right.firstOwnerOrder
      || left.resourceId.localeCompare(right.resourceId, 'en'))
    .map(evidence => {
      const firstMaterialCueIndex = evidence.material.length > 0
        ? Math.min(...evidence.material.map(material => material.firstCueIndex))
        : null;
      const qualifyingReadingItemIds = completeReadingItemIdsBeforeMaterial(
        evidence.readings,
        firstMaterialCueIndex
      );
      return {
        resourceId: evidence.resourceId,
        sermonId: evidence.sermonId,
        sermonRevisionId: evidence.sermonRevisionId,
        ownerItemIds: evidence.ownerItemIds,
        material: evidence.material,
        readings: evidence.readings,
        materialSetItemIds: [...evidence.materialSetItemIds],
        firstMaterialCueIndex,
        qualifyingReadingItemIds
      };
    });
}

function checkResult(check, result, waivers) {
  const waivable = result.waivable ?? check.waivable;
  const reason = !result.passed && waivable ? waivers.get(check.id) : null;
  return {
    id: check.id,
    waivable,
    status: result.passed ? 'pass' : (reason ? 'waived' : 'blocker'),
    message: result.message || check.message,
    evidence: result.evidence,
    ...(reason ? { waiverReason: reason } : {})
  };
}

/**
 * Derive weekly-service readiness from one exact native ServiceProject.
 *
 * The report intentionally exposes only project/item/channel identifiers,
 * counts, and immutable sermon identity/revision evidence. Sermon source
 * records, filenames, local paths, manuscript text, and imported bytes never
 * cross this boundary. This function is read-only; in particular, legacy
 * projects without planning metadata remain unplanned.
 */
function analyzeServiceProjectReadiness(rawProject, options = undefined) {
  const waivers = normalizeWaivers(options);
  const project = normalizeServiceProject(rawProject, { now: new Date(0) });
  const projectIndex = validateProjectTree(project);
  const orderedItemIds = orderedProjectItemIds(project);

  let timeline = null;
  let compilationCode = null;
  try {
    timeline = compileServiceProject(project);
  } catch (error) {
    if (!(error instanceof ServiceProjectError)) throw error;
    compilationCode = error.code;
  }

  const cueCount = timeline?.cueIds.length || 0;
  const songItemIds = orderedItemIds.filter(itemId =>
    project.items[itemId].kind === 'song');
  const collectedSermonEvidence = collectSermonEvidence(
    project,
    timeline,
    orderedItemIds,
    projectIndex
  );
  const ambiguousSermonOwnerSets = collectedSermonEvidence
    .filter(sermon => sermon.materialSetItemIds.length > 1)
    .map(sermon => ({
      resourceId: sermon.resourceId,
      itemIds: sermon.materialSetItemIds
    }));
  const sermonEvidence = collectedSermonEvidence.map(sermon => {
    const { materialSetItemIds, ...reportEvidence } = sermon;
    return reportEvidence;
  });
  const materialItemIds = sermonEvidence.flatMap(sermon =>
    sermon.material.map(material => material.itemId));
  const materialBearingSermons = sermonEvidence.filter(sermon =>
    sermon.material.length > 0);
  const qualifyingReadingItemIds = materialBearingSermons.flatMap(sermon =>
    sermon.qualifyingReadingItemIds);
  const sermonResourceIdsMissingQualifyingReading = materialBearingSermons
    .filter(sermon => sermon.qualifyingReadingItemIds.length < 1)
    .map(sermon => sermon.resourceId);

  const channels = project.channelIds.map(channelId => {
    const visibleCueCount = timeline
      ? timeline.cueIds.reduce((count, cueId) =>
          count + (cueIsVisibleInChannel(timeline.cues[cueId], channelId) ? 1 : 0), 0)
      : 0;
    return {
      channelId,
      visibleCueCount,
      covered: visibleCueCount > 0
    };
  });
  const coveredChannelIds = channels
    .filter(channel => channel.covered)
    .map(channel => channel.channelId);
  const missingChannelIds = channels
    .filter(channel => !channel.covered)
    .map(channel => channel.channelId);

  const rawResults = [
    {
      passed: Boolean(timeline && cueCount > 0),
      evidence: { cueCount, compilationCode }
    },
    {
      passed: songItemIds.length > 0,
      evidence: { count: songItemIds.length, itemIds: songItemIds }
    },
    {
      passed: sermonEvidence.length > 0 && ambiguousSermonOwnerSets.length === 0,
      ...(ambiguousSermonOwnerSets.length > 0
        ? {
          waivable: false,
          blockerCode: 'SERVICE_SERMON_OWNER_AMBIGUOUS',
          message: 'Each exact sermon revision must have one unambiguous sermon material set.'
        }
        : {}),
      evidence: {
        count: sermonEvidence.length,
        sermonRevisionIds: sermonEvidence.map(sermon => sermon.sermonRevisionId),
        ambiguousOwnerSets: ambiguousSermonOwnerSets
      }
    },
    {
      passed: materialItemIds.length > 0,
      evidence: {
        count: materialItemIds.length,
        itemIds: materialItemIds
      }
    },
    {
      passed: materialBearingSermons.length > 0
        && sermonResourceIdsMissingQualifyingReading.length === 0,
      evidence: {
        count: qualifyingReadingItemIds.length,
        itemIds: qualifyingReadingItemIds,
        requiredSermonResourceIds: materialBearingSermons.map(sermon =>
          sermon.resourceId),
        missingSermonResourceIds: sermonResourceIdsMissingQualifyingReading
      }
    },
    {
      passed: missingChannelIds.length === 0,
      evidence: { coveredChannelIds, missingChannelIds }
    }
  ];
  const checks = SERVICE_READINESS_CHECKS.map((check, index) =>
    checkResult(check, rawResults[index], waivers));
  const blockers = checks
    .filter(check => check.status === 'blocker')
    .map(check => {
      const definition = SERVICE_READINESS_CHECK_BY_ID.get(check.id);
      const result = rawResults[SERVICE_READINESS_CHECKS.indexOf(definition)];
      return {
        checkId: check.id,
        code: result.blockerCode || definition.blockerCode,
        message: check.message
      };
    });
  const waivedChecks = checks
    .filter(check => check.status === 'waived')
    .map(check => ({
      checkId: check.id,
      reason: check.waiverReason
    }));

  return deepFreeze({
    schemaVersion: SERVICE_READINESS_SCHEMA_VERSION,
    kind: SERVICE_READINESS_REPORT_KIND,
    projectId: project.id,
    projectRevision: project.revision,
    projectContentHash: timeline?.projectContentHash || null,
    planning: {
      present: Boolean(project.planning),
      status: project.planning?.status || null
    },
    ready: blockers.length === 0,
    cueCount,
    checks,
    blockers,
    waivedChecks,
    channels,
    sermons: sermonEvidence
  });
}

module.exports = {
  MAX_SERVICE_READINESS_WAIVERS,
  SERVICE_READINESS_CHECK_IDS,
  SERVICE_READINESS_REPORT_KIND,
  SERVICE_READINESS_SCHEMA_VERSION,
  analyzeServiceProjectReadiness
};
