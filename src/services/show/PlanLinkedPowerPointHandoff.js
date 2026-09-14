'use strict';

const {
  addSermonResource,
  isPowerPointCompanionProject,
  normalizeServiceProject,
  resolveSermonSourceLink,
  setSermonSourceLink
} = require('../project/ServiceProject');

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const ASSET_ID_PATTERN = /^sha256:[a-f0-9]{64}$/;
const SERVICE_SET_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;
const SERVICE_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

class PlanLinkedPowerPointHandoffError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'PlanLinkedPowerPointHandoffError';
    this.code = code;
    this.details = details;
  }
}

function fail(code, message, details = {}) {
  throw new PlanLinkedPowerPointHandoffError(code, message, details);
}

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function exactId(value, label) {
  if (typeof value !== 'string'
    || !ID_PATTERN.test(value)
    || ['__proto__', 'prototype', 'constructor'].includes(value)) {
    fail('INVALID_PLAN_LINKED_POWERPOINT_SOURCE', `${label} is invalid.`);
  }
  return value;
}

function exactRevision(value, label) {
  if (typeof value !== 'string' || !SHA256_PATTERN.test(value)) {
    fail('INVALID_PLAN_LINKED_POWERPOINT_SOURCE', `${label} is invalid.`);
  }
  return value;
}

function normalizeServiceSetClaim(raw) {
  if (!isRecord(raw)
    || typeof raw.id !== 'string'
    || !SERVICE_SET_ID_PATTERN.test(raw.id)
    || !SHA256_PATTERN.test(raw.fingerprint || '')
    || !SERVICE_DATE_PATTERN.test(raw.serviceDate || '')
    || !ID_PATTERN.test(raw.profileId || '')
    || !Array.isArray(raw.roles)
    || raw.roles.length < 1
    || raw.roles.length > 32) {
    fail(
      'INVALID_PLAN_LINKED_POWERPOINT_SERVICE',
      'The verified PowerPoint service claim is invalid.'
    );
  }
  const seen = new Set();
  const roles = raw.roles.map(rawRole => {
    if (!isRecord(rawRole)
      || !ID_PATTERN.test(rawRole.roleId || '')
      || typeof rawRole.assetId !== 'string'
      || !ASSET_ID_PATTERN.test(rawRole.assetId)
      || seen.has(rawRole.roleId)) {
      fail(
        'INVALID_PLAN_LINKED_POWERPOINT_SERVICE',
        'The verified PowerPoint service roles are invalid.'
      );
    }
    seen.add(rawRole.roleId);
    return {
      roleId: rawRole.roleId,
      assetId: rawRole.assetId
    };
  }).sort((left, right) => left.roleId.localeCompare(right.roleId, 'en'));
  return {
    id: raw.id,
    fingerprint: raw.fingerprint,
    serviceDate: raw.serviceDate,
    profileId: raw.profileId,
    roles
  };
}

function sameServiceSetClaim(left, right) {
  let normalizedLeft;
  let normalizedRight;
  try {
    normalizedLeft = normalizeServiceSetClaim(left);
    normalizedRight = normalizeServiceSetClaim(right);
  } catch (_error) {
    return false;
  }
  return normalizedLeft.id === normalizedRight.id
    && normalizedLeft.fingerprint === normalizedRight.fingerprint
    && normalizedLeft.serviceDate === normalizedRight.serviceDate
    && normalizedLeft.profileId === normalizedRight.profileId
    && normalizedLeft.roles.length === normalizedRight.roles.length
    && normalizedLeft.roles.every((role, index) =>
      role.roleId === normalizedRight.roles[index].roleId
      && role.assetId === normalizedRight.roles[index].assetId);
}

function directWholeSermonOwners(project) {
  return Object.values(project.items)
    .filter(item =>
      item.kind === 'group'
      && item.groupKind === 'sermon'
      && typeof item.sermonResourceId === 'string'
      && !item.sermonSectionId)
    .sort((left, right) => left.id.localeCompare(right.id, 'en'));
}

/**
 * Resolve one explicit whole-sermon owner from an exact imported Community
 * plan revision and bind it to the exact, freshly verified PowerPoint set.
 * No source path, Community credential, or mutable library lookup participates
 * in this claim.
 */
function derivePlanLinkedPowerPointHandoff({
  sourceProject: rawSourceProject,
  sourceProjectRevisionId,
  sourceItemId = null,
  serviceSet: rawServiceSet
} = {}) {
  const sourceProject = normalizeServiceProject(rawSourceProject);
  if (isPowerPointCompanionProject(sourceProject)) {
    fail(
      'PLAN_LINKED_POWERPOINT_SOURCE_NOT_NATIVE',
      'Choose the imported Community service plan, not a PowerPoint companion.'
    );
  }
  const projectRevisionId = exactRevision(
    sourceProjectRevisionId,
    'Source service revision'
  );
  const source = sourceProject.planning?.source;
  if (![2, 3].includes(sourceProject.planning?.schemaVersion)
    || source?.kind !== 'community-plan') {
    fail(
      'PLAN_LINKED_POWERPOINT_COMMUNITY_PLAN_REQUIRED',
      'Choose a service imported from one exact Community plan revision.'
    );
  }
  const serverId = exactId(source.serverId, 'Community server identity');
  const planId = exactId(source.planId, 'Community plan identity');
  const planRevision = exactRevision(
    source.planRevision,
    'Community plan revision'
  );
  const serviceSet = normalizeServiceSetClaim(rawServiceSet);
  const projectBinding = sourceProject.sourceServiceSet;
  if (!projectBinding
    || projectBinding.id !== serviceSet.id
    || projectBinding.fingerprint !== serviceSet.fingerprint
    || projectBinding.serviceDate !== serviceSet.serviceDate
    || projectBinding.profileId !== serviceSet.profileId
    || sourceProject.serviceDate !== serviceSet.serviceDate
    || sourceProject.preferredProfileId !== serviceSet.profileId) {
    fail(
      'PLAN_LINKED_POWERPOINT_SERVICE_MISMATCH',
      'This Community plan was not reviewed against the exact current PowerPoint service.'
    );
  }

  const candidates = directWholeSermonOwners(sourceProject);
  let item;
  if (sourceItemId === null || sourceItemId === undefined || sourceItemId === '') {
    if (candidates.length !== 1) {
      fail(
        'AMBIGUOUS_PLAN_LINKED_POWERPOINT_SERMON',
        'Select one exact whole-sermon entry from the imported Community plan.',
        { candidateCount: candidates.length }
      );
    }
    [item] = candidates;
  } else {
    const itemId = exactId(sourceItemId, 'Community plan sermon item');
    item = sourceProject.items[itemId];
    if (!item
      || item.kind !== 'group'
      || item.groupKind !== 'sermon'
      || !item.sermonResourceId
      || item.sermonSectionId) {
      fail(
        'PLAN_LINKED_POWERPOINT_WHOLE_SERMON_REQUIRED',
        'Select the exact whole-sermon entry from the imported Community plan.'
      );
    }
  }
  const linked = resolveSermonSourceLink(sourceProject, item);
  if (!linked
    || linked.resourceOwnerId !== item.id
    || linked.sectionId !== null
    || linked.resource?.kind !== 'sermon'
    || linked.resourceId !== item.sermonResourceId) {
    fail(
      'PLAN_LINKED_POWERPOINT_WHOLE_SERMON_REQUIRED',
      'The selected Community plan entry is not one exact whole sermon.'
    );
  }
  const sermonId = exactId(
    linked.resource.document?.id,
    'Stable sermon identity'
  );
  const sermonRevisionId = exactRevision(
    linked.resource.sha256,
    'Sermon revision'
  );
  if (linked.resourceId !== `sha256:${sermonRevisionId}`) {
    fail(
      'INVALID_PLAN_LINKED_POWERPOINT_SOURCE',
      'The imported Community sermon resource is not content-addressed.'
    );
  }

  return Object.freeze({
    schemaVersion: 1,
    source: Object.freeze({
      projectId: sourceProject.id,
      projectRevisionId,
      projectRevision: sourceProject.revision,
      itemId: item.id,
      plan: Object.freeze({
        serverId,
        planId,
        planRevision
      })
    }),
    sermon: Object.freeze({
      id: sermonId,
      revisionId: sermonRevisionId,
      resourceId: linked.resourceId,
      title: linked.resource.document.titles[
        linked.resource.document.defaultLanguage
      ],
      speaker: linked.resource.document.speaker.name
    }),
    serviceSet: Object.freeze({
      ...serviceSet,
      roles: Object.freeze(serviceSet.roles.map(role => Object.freeze(role)))
    })
  });
}

function samePlanLinkedPowerPointHandoff(left, right) {
  return left?.schemaVersion === 1
    && right?.schemaVersion === 1
    && left.source?.projectId === right.source?.projectId
    && left.source?.projectRevisionId === right.source?.projectRevisionId
    && left.source?.projectRevision === right.source?.projectRevision
    && left.source?.itemId === right.source?.itemId
    && left.source?.plan?.serverId === right.source?.plan?.serverId
    && left.source?.plan?.planId === right.source?.plan?.planId
    && left.source?.plan?.planRevision === right.source?.plan?.planRevision
    && left.sermon?.id === right.sermon?.id
    && left.sermon?.revisionId === right.sermon?.revisionId
    && left.sermon?.resourceId === right.sermon?.resourceId
    && sameServiceSetClaim(left.serviceSet, right.serviceSet);
}

/**
 * Copy the already-pinned sermon document into the exact PowerPoint
 * companion and link its unique sermon anchor. Repeating the same reviewed
 * decision is idempotent; any other existing link fails closed.
 */
function applyPlanLinkedPowerPointHandoff({
  companionProject: rawCompanionProject,
  anchorItemId,
  sourceProject: rawSourceProject,
  handoff,
  now
} = {}) {
  const companionProject = normalizeServiceProject(rawCompanionProject);
  if (!isPowerPointCompanionProject(companionProject)) {
    fail(
      'PLAN_LINKED_POWERPOINT_COMPANION_REQUIRED',
      'The target is not an exact PowerPoint service companion.'
    );
  }
  const currentHandoff = derivePlanLinkedPowerPointHandoff({
    sourceProject: rawSourceProject,
    sourceProjectRevisionId: handoff?.source?.projectRevisionId,
    sourceItemId: handoff?.source?.itemId,
    serviceSet: handoff?.serviceSet
  });
  if (!samePlanLinkedPowerPointHandoff(currentHandoff, handoff)) {
    fail(
      'PLAN_LINKED_POWERPOINT_SOURCE_CHANGED',
      'The Community plan or sermon changed after review.'
    );
  }
  if (!companionProject.sourceServiceSet
    || companionProject.sourceServiceSet.id !== handoff.serviceSet.id
    || companionProject.sourceServiceSet.fingerprint
      !== handoff.serviceSet.fingerprint
    || companionProject.sourceServiceSet.serviceDate
      !== handoff.serviceSet.serviceDate
    || companionProject.sourceServiceSet.profileId
      !== handoff.serviceSet.profileId) {
    fail(
      'PLAN_LINKED_POWERPOINT_SERVICE_MISMATCH',
      'The PowerPoint companion belongs to another exact service.'
    );
  }
  const anchor = companionProject.items[anchorItemId];
  if (!anchor
    || anchor.kind !== 'group'
    || anchor.groupKind !== 'sermon') {
    fail(
      'PLAN_LINKED_POWERPOINT_COMPANION_INVALID',
      'The exact PowerPoint companion has no valid sermon anchor.'
    );
  }
  const existing = resolveSermonSourceLink(companionProject, anchor);
  if (existing) {
    if (existing.resourceOwnerId !== anchor.id
      || existing.sectionId !== null
      || existing.resourceId !== handoff.sermon.resourceId
      || existing.resource?.kind !== 'sermon'
      || existing.resource.document.id !== handoff.sermon.id
      || existing.resource.sha256 !== handoff.sermon.revisionId) {
      fail(
        'PLAN_LINKED_POWERPOINT_COMPANION_CONFLICT',
        'This exact PowerPoint service is already linked to a different sermon.'
      );
    }
    return Object.freeze({
      project: companionProject,
      resourceId: existing.resourceId,
      sermonId: existing.resource.document.id,
      sermonRevisionId: existing.resource.sha256,
      unchanged: true
    });
  }
  if (Object.values(companionProject.resources)
    .some(resource => resource.kind === 'sermon')) {
    fail(
      'PLAN_LINKED_POWERPOINT_COMPANION_CONFLICT',
      'This exact PowerPoint service contains a conflicting unlinked sermon.'
    );
  }

  const sourceResource =
    rawSourceProject.resources[handoff.sermon.resourceId];
  if (!sourceResource
    || sourceResource.kind !== 'sermon'
    || sourceResource.document?.id !== handoff.sermon.id
    || sourceResource.sha256 !== handoff.sermon.revisionId) {
    fail(
      'PLAN_LINKED_POWERPOINT_SOURCE_CHANGED',
      'The exact imported Community sermon is no longer available.'
    );
  }
  const added = addSermonResource(
    companionProject,
    sourceResource.document,
    sourceResource.origin
  );
  if (added.resourceId !== handoff.sermon.resourceId) {
    fail(
      'PLAN_LINKED_POWERPOINT_SOURCE_CHANGED',
      'The imported Community sermon no longer reproduces its reviewed revision.'
    );
  }
  const linked = setSermonSourceLink(added.project, {
    itemId: anchor.id,
    sermonResourceId: added.resourceId,
    sermonSectionId: null,
    ...(now === undefined ? {} : { now })
  });
  return Object.freeze({
    project: linked,
    resourceId: added.resourceId,
    sermonId: handoff.sermon.id,
    sermonRevisionId: handoff.sermon.revisionId,
    unchanged: false
  });
}

module.exports = {
  PlanLinkedPowerPointHandoffError,
  applyPlanLinkedPowerPointHandoff,
  derivePlanLinkedPowerPointHandoff,
  normalizeServiceSetClaim,
  samePlanLinkedPowerPointHandoff,
  sameServiceSetClaim
};
