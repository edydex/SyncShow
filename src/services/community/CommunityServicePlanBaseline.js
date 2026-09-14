'use strict';

const crypto = require('crypto');

const COMMUNITY_SERVICE_PLAN_BASELINE_SCHEMA_VERSION = 2;
const COMMUNITY_SERVICE_PLAN_BASELINE_SCHEMA_VERSIONS =
  Object.freeze([1, 2]);
const COMMUNITY_SERVICE_PLAN_BASELINE_KIND =
  'syncshow-community-service-plan-baseline';
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const REVISION_PATTERN = /^[a-f0-9]{64}$/;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const TIME_PATTERN = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
const ENTRY_KINDS = new Set(['section', 'song', 'scripture', 'sermon']);
const ITEM_KIND_BY_ENTRY_KIND = Object.freeze({
  section: 'group',
  song: 'song',
  scripture: 'bible',
  sermon: 'group'
});
const MAX_ENTRIES = 500;
const MAX_CONTAINERS = MAX_ENTRIES + 1;
const RESERVED_KEYS = new Set(['__proto__', 'prototype', 'constructor']);

class CommunityServicePlanBaselineError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'CommunityServicePlanBaselineError';
    this.code = code;
    this.details = details;
  }
}

function fail(code, message, details = {}) {
  throw new CommunityServicePlanBaselineError(code, message, details);
}

function isRecord(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactKeys(value, expected, label) {
  if (!isRecord(value)) {
    fail('INVALID_COMMUNITY_PLAN_BASELINE', `${label} must be an object.`);
  }
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (
    actual.length !== wanted.length
    || actual.some((key, index) => key !== wanted[index])
  ) {
    fail(
      'INVALID_COMMUNITY_PLAN_BASELINE',
      `${label} contains unsupported or missing fields.`,
      { fields: actual }
    );
  }
}

function boundedText(value, label, maximum, {
  required = true,
  pattern = null,
  multiline = false
} = {}) {
  if (typeof value !== 'string') {
    fail('INVALID_COMMUNITY_PLAN_BASELINE', `${label} must be text.`);
  }
  const normalized = multiline
    ? value.replace(/\r\n?/g, '\n').normalize('NFC')
    : value.trim().normalize('NFC');
  const controls = multiline
    ? /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/
    : /[\u0000-\u001f\u007f]/;
  if (
    (required && !normalized)
    || normalized.length > maximum
    || controls.test(normalized)
    || (pattern && !pattern.test(normalized))
  ) {
    fail('INVALID_COMMUNITY_PLAN_BASELINE', `${label} is invalid.`);
  }
  return normalized;
}

function identifier(value, label) {
  return boundedText(value, label, 128, { pattern: ID_PATTERN });
}

function revision(value, label) {
  return boundedText(value, label, 64, { pattern: REVISION_PATTERN });
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!isRecord(value)) return value;
  const result = {};
  for (const key of Object.keys(value).sort()) {
    if (RESERVED_KEYS.has(key)) {
      fail(
        'INVALID_COMMUNITY_PLAN_BASELINE',
        'Community baseline contains a reserved field.'
      );
    }
    result[key] = stableValue(value[key]);
  }
  return result;
}

function stableJson(value) {
  return JSON.stringify(stableValue(value));
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function freezeDeep(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) {
    return value;
  }
  Object.freeze(value);
  for (const child of Object.values(value)) freezeDeep(child);
  return value;
}

function deterministicCommunityItemId(entryId) {
  return `community-item-${
    crypto.createHash('sha256').update(entryId).digest('hex').slice(0, 40)
  }`;
}

function normalizeMetadata(raw) {
  exactKeys(
    raw,
    ['title', 'serviceDate', 'startTime', 'teamNotes'],
    'Community baseline metadata'
  );
  return {
    title: boundedText(raw.title, 'Community baseline title', 200),
    serviceDate: boundedText(
      raw.serviceDate,
      'Community baseline service date',
      10,
      { pattern: DATE_PATTERN }
    ),
    startTime: boundedText(
      raw.startTime,
      'Community baseline start time',
      5,
      { pattern: TIME_PATTERN }
    ),
    teamNotes: boundedText(
      raw.teamNotes,
      'Community baseline team notes',
      4000,
      { required: false, multiline: true }
    )
  };
}

function normalizeEntry(raw, index, schemaVersion) {
  exactKeys(
    raw,
    [
      'entryId',
      'itemId',
      'entryKind',
      'itemKind',
      'sourceSha256',
      'contentSha256',
      'stateSha256',
      ...(schemaVersion === 2
        ? [
            'contentSpecSha256',
            'relationshipSha256',
            'dependentStateSha256',
            'titleSha256'
          ]
        : [])
    ],
    `Community baseline entry ${index + 1}`
  );
  const entryId = identifier(
    raw.entryId,
    `Community baseline entry ${index + 1} source ID`
  );
  const itemId = identifier(
    raw.itemId,
    `Community baseline entry ${index + 1} item ID`
  );
  const entryKind = boundedText(
    raw.entryKind,
    `Community baseline entry ${index + 1} kind`,
    20
  );
  const itemKind = boundedText(
    raw.itemKind,
    `Community baseline entry ${index + 1} item kind`,
    20
  );
  if (
    !ENTRY_KINDS.has(entryKind)
    || ITEM_KIND_BY_ENTRY_KIND[entryKind] !== itemKind
    || deterministicCommunityItemId(entryId) !== itemId
  ) {
    fail(
      'INVALID_COMMUNITY_PLAN_BASELINE',
      `Community baseline entry ${index + 1} has inconsistent identity.`
    );
  }
  const normalized = {
    entryId,
    itemId,
    entryKind,
    itemKind,
    sourceSha256: revision(
      raw.sourceSha256,
      `Community baseline entry ${index + 1} source hash`
    ),
    contentSha256: revision(
      raw.contentSha256,
      `Community baseline entry ${index + 1} content hash`
    ),
    stateSha256: revision(
      raw.stateSha256,
      `Community baseline entry ${index + 1} state hash`
    )
  };
  if (schemaVersion === 2) {
    normalized.contentSpecSha256 = revision(
      raw.contentSpecSha256,
      `Community baseline entry ${index + 1} content-spec hash`
    );
    normalized.relationshipSha256 = revision(
      raw.relationshipSha256,
      `Community baseline entry ${index + 1} relationship hash`
    );
    normalized.dependentStateSha256 = revision(
      raw.dependentStateSha256,
      `Community baseline entry ${index + 1} dependent-state hash`
    );
    normalized.titleSha256 = revision(
      raw.titleSha256,
      `Community baseline entry ${index + 1} title hash`
    );
  }
  return normalized;
}

function normalizeContainer(raw, index, managedItemIds, groupItemIds) {
  exactKeys(
    raw,
    ['parentItemId', 'childItemIds'],
    `Community baseline container ${index + 1}`
  );
  const parentItemId = raw.parentItemId === null
    ? null
    : identifier(
        raw.parentItemId,
        `Community baseline container ${index + 1} parent`
      );
  if (parentItemId !== null && !groupItemIds.has(parentItemId)) {
    fail(
      'INVALID_COMMUNITY_PLAN_BASELINE',
      `Community baseline container ${index + 1} has a non-group parent.`
    );
  }
  if (
    !Array.isArray(raw.childItemIds)
    || raw.childItemIds.length > MAX_ENTRIES
  ) {
    fail(
      'INVALID_COMMUNITY_PLAN_BASELINE',
      `Community baseline container ${index + 1} has invalid children.`
    );
  }
  const childItemIds = raw.childItemIds.map((itemId, childIndex) =>
    identifier(
      itemId,
      `Community baseline container ${index + 1} child ${childIndex + 1}`
    ));
  if (
    new Set(childItemIds).size !== childItemIds.length
    || childItemIds.some(itemId => !managedItemIds.has(itemId))
  ) {
    fail(
      'INVALID_COMMUNITY_PLAN_BASELINE',
      `Community baseline container ${index + 1} repeats or references an unknown item.`
    );
  }
  return { parentItemId, childItemIds };
}

function baselineProjectionBody(value) {
  return {
    schemaVersion: value.schemaVersion,
    kind: value.kind,
    planRevision: value.planRevision,
    channelContractSha256: value.channelContractSha256,
    metadata: value.metadata,
    entries: value.entries,
    containers: value.containers
  };
}

function normalizeCommunityServicePlanBaseline(raw) {
  exactKeys(raw, [
    'schemaVersion',
    'kind',
    'planRevision',
    'projectionSha256',
    'channelContractSha256',
    'metadata',
    'entries',
    'containers'
  ], 'Community service-plan baseline');
  if (
    !COMMUNITY_SERVICE_PLAN_BASELINE_SCHEMA_VERSIONS.includes(
      raw.schemaVersion
    )
    || raw.kind !== COMMUNITY_SERVICE_PLAN_BASELINE_KIND
  ) {
    fail(
      'INVALID_COMMUNITY_PLAN_BASELINE',
      'Community service-plan baseline uses an unsupported schema.'
    );
  }
  const planRevision = revision(
    raw.planRevision,
    'Community baseline plan revision'
  );
  const channelContractSha256 = revision(
    raw.channelContractSha256,
    'Community baseline channel contract'
  );
  if (
    !Array.isArray(raw.entries)
    || raw.entries.length < 1
    || raw.entries.length > MAX_ENTRIES
  ) {
    fail(
      'INVALID_COMMUNITY_PLAN_BASELINE',
      `Community baseline needs 1 to ${MAX_ENTRIES} entries.`
    );
  }
  const entries = raw.entries.map((entry, index) =>
    normalizeEntry(entry, index, raw.schemaVersion));
  const entryIds = new Set(entries.map(entry => entry.entryId));
  const managedItemIds = new Set(entries.map(entry => entry.itemId));
  if (
    entryIds.size !== entries.length
    || managedItemIds.size !== entries.length
  ) {
    fail(
      'INVALID_COMMUNITY_PLAN_BASELINE',
      'Community baseline entry identities must be unique.'
    );
  }
  const groupItemIds = new Set(
    entries
      .filter(entry => entry.itemKind === 'group')
      .map(entry => entry.itemId)
  );
  if (
    !Array.isArray(raw.containers)
    || raw.containers.length < 1
    || raw.containers.length > MAX_CONTAINERS
  ) {
    fail(
      'INVALID_COMMUNITY_PLAN_BASELINE',
      `Community baseline needs 1 to ${MAX_CONTAINERS} containers.`
    );
  }
  const containers = raw.containers.map((container, index) =>
    normalizeContainer(
      container,
      index,
      managedItemIds,
      groupItemIds
    ));
  const parentKeys = containers.map(container =>
    container.parentItemId === null ? '\u0000root' : container.parentItemId);
  if (
    new Set(parentKeys).size !== parentKeys.length
    || !containers.some(container => container.parentItemId === null)
  ) {
    fail(
      'INVALID_COMMUNITY_PLAN_BASELINE',
      'Community baseline containers must have unique parents and one root.'
    );
  }
  const placed = containers.flatMap(container => container.childItemIds);
  if (
    placed.length !== entries.length
    || new Set(placed).size !== entries.length
    || placed.some(itemId => !managedItemIds.has(itemId))
  ) {
    fail(
      'INVALID_COMMUNITY_PLAN_BASELINE',
      'Every Community baseline item must appear in exactly one container.'
    );
  }
  const normalized = {
    schemaVersion: raw.schemaVersion,
    kind: COMMUNITY_SERVICE_PLAN_BASELINE_KIND,
    planRevision,
    projectionSha256: revision(
      raw.projectionSha256,
      'Community baseline projection hash'
    ),
    channelContractSha256,
    metadata: normalizeMetadata(raw.metadata),
    entries,
    containers
  };
  const calculated = sha256(stableJson(baselineProjectionBody(normalized)));
  if (calculated !== normalized.projectionSha256) {
    fail(
      'COMMUNITY_PLAN_BASELINE_HASH_MISMATCH',
      'Community baseline no longer matches its projection checksum.'
    );
  }
  return freezeDeep(normalized);
}

function collectReferencedRecords(item, project) {
  const resourceIds = new Set();
  const assetIds = new Set();
  const visit = value => {
    if (typeof value === 'string') {
      if (Object.prototype.hasOwnProperty.call(project.resources, value)) {
        resourceIds.add(value);
      }
      if (Object.prototype.hasOwnProperty.call(project.assets, value)) {
        assetIds.add(value);
      }
      return;
    }
    if (Array.isArray(value)) {
      for (const child of value) visit(child);
      return;
    }
    if (!isRecord(value)) return;
    for (const child of Object.values(value)) visit(child);
  };
  visit(item);
  return {
    resources: Object.fromEntries(
      [...resourceIds].sort().map(id => [id, project.resources[id]])
    ),
    assets: Object.fromEntries(
      [...assetIds].sort().map(id => [id, project.assets[id]])
    )
  };
}

function communityManagedItemView(item) {
  const common = {
    id: item.id,
    kind: item.kind,
    title: item.title
  };
  if (item.kind === 'group') {
    return {
      ...common,
      groupKind: item.groupKind,
      ...(item.sermonResourceId
        ? { sermonResourceId: item.sermonResourceId }
        : {}),
      ...(item.sermonSectionId
        ? { sermonSectionId: item.sermonSectionId }
        : {})
    };
  }
  if (item.kind === 'song') {
    return {
      ...common,
      variants: item.variants,
      ...(item.primaryChannelId
        ? { primaryChannelId: item.primaryChannelId }
        : {})
    };
  }
  if (item.kind === 'bible') {
    return {
      ...common,
      range: item.range,
      passagesByChannel: item.passagesByChannel,
      ...(item.sermonReading
        ? { sermonReading: item.sermonReading }
        : {})
    };
  }
  return common;
}

function communityServicePlanItemContentSha256(rawProject, itemId) {
  const project = rawProject;
  const item = project?.items?.[itemId];
  if (!item) return null;
  const comparable = communityManagedItemView(item);
  return sha256(stableJson({
    item: comparable,
    ...collectReferencedRecords(comparable, project)
  }));
}

function communityServicePlanItemStateSha256(rawProject, itemId) {
  const project = rawProject;
  const item = project?.items?.[itemId];
  if (!item) return null;
  const comparable = { ...item };
  delete comparable.createdAt;
  delete comparable.updatedAt;
  delete comparable.plannedDurationSeconds;
  if (comparable.kind === 'group') delete comparable.childIds;
  return sha256(stableJson({
    item: comparable,
    ...collectReferencedRecords(comparable, project)
  }));
}

/**
 * Hash only the Community-owned native content specification for one stable
 * entry occurrence. Titles, generated Scripture text, song arrangements,
 * presets, operator notes, timestamps, and group children are intentionally
 * excluded so reconciliation can distinguish a changed resource/range from a
 * presentation-only edit.
 */
function communityServicePlanItemContentSpecSha256(rawProject, itemId) {
  const project = rawProject;
  const item = project?.items?.[itemId];
  if (!item) return null;
  let comparable;
  if (item.kind === 'group') {
    comparable = {
      id: item.id,
      kind: item.kind,
      groupKind: item.groupKind,
      ...(item.sermonResourceId
        ? { sermonResourceId: item.sermonResourceId }
        : {}),
      ...(item.sermonSectionId
        ? { sermonSectionId: item.sermonSectionId }
        : {})
    };
  } else if (item.kind === 'song') {
    comparable = {
      id: item.id,
      kind: item.kind,
      variants: item.variants,
      ...(item.primaryChannelId
        ? { primaryChannelId: item.primaryChannelId }
        : {})
    };
  } else if (item.kind === 'bible') {
    comparable = {
      id: item.id,
      kind: item.kind,
      range: item.range,
      translationsByChannel: Object.fromEntries(
        Object.keys(item.passagesByChannel || {})
          .sort()
          .map(channelId => [
            channelId,
            item.passagesByChannel[channelId]?.translationId || null
          ])
      )
    };
  } else {
    comparable = {
      id: item.id,
      kind: item.kind
    };
  }
  return sha256(stableJson({
    item: comparable,
    ...collectReferencedRecords(comparable, project)
  }));
}

/**
 * Hash the resolved cross-entry relationship independently from generated
 * content. Today only a Bible item can own a Community relationship: its exact
 * linked sermon resource/reference receipt. Unlinked and non-Bible items hash
 * a canonical null relationship.
 */
function communityServicePlanItemRelationshipSha256(rawProject, itemId) {
  const project = rawProject;
  const item = project?.items?.[itemId];
  if (!item) return null;
  const comparable = item.kind === 'bible'
    ? {
        kind: 'sermon-reading',
        value: item.sermonReading || null
      }
    : null;
  return sha256(stableJson({
    relationship: comparable,
    ...collectReferencedRecords(comparable, project)
  }));
}

/**
 * Hash locally materialized state whose source inputs may remain unchanged
 * while a resolver/library produces a different fresh candidate. Song
 * arrangements (and their source replacement receipt) and exact Bible passage
 * snapshots are isolated here. Other managed item kinds hash canonical null.
 */
function communityServicePlanItemDependentStateSha256(rawProject, itemId) {
  const project = rawProject;
  const item = project?.items?.[itemId];
  if (!item) return null;
  let comparable = null;
  if (item.kind === 'song') {
    comparable = {
      kind: 'song-arrangement',
      arrangement: item.arrangement,
      sourceRangeReplacement: item.sourceRangeReplacement || null
    };
  } else if (item.kind === 'bible') {
    comparable = {
      kind: 'bible-passages',
      passagesByChannel: item.passagesByChannel
    };
  }
  return sha256(stableJson({ dependentState: comparable }));
}

function communityServicePlanItemTitleSha256(rawProject, itemId) {
  const item = rawProject?.items?.[itemId];
  if (!item) return null;
  return sha256(stableJson({ title: item.title }));
}

function communityServicePlanChannelContractSha256(rawProject) {
  const project = rawProject;
  return sha256(stableJson({
    preferredProfileId: project.preferredProfileId,
    channelIds: project.channelIds,
    channels: project.channels,
    presetPack: project.presetPack
  }));
}

function communityServicePlanBaselineFromProject(rawProject, rawEntries) {
  // Lazy loading avoids a module-initialization cycle when ServiceProject
  // validates the embedded baseline during project normalization.
  const {
    normalizeServiceProject
  } = require('../project/ServiceProject');
  const project = normalizeServiceProject(rawProject);
  const source = project.planning?.source;
  if (
    ![2, 3].includes(project.planning?.schemaVersion)
    || source?.kind !== 'community-plan'
  ) {
    fail(
      'COMMUNITY_PLAN_BASELINE_SOURCE_REQUIRED',
      'Only an exact imported Community Planning project can become a baseline.'
    );
  }
  if (
    !Array.isArray(rawEntries)
    || rawEntries.length < 1
    || rawEntries.length > MAX_ENTRIES
  ) {
    fail(
      'INVALID_COMMUNITY_PLAN_BASELINE',
      'Community baseline requires the exact ordered plan entries.'
    );
  }
  const entries = rawEntries.map((entry, index) => {
    const entryId = identifier(
      entry?.id,
      `Community baseline source entry ${index + 1}`
    );
    const entryKind = String(entry?.kind || '');
    if (!ENTRY_KINDS.has(entryKind)) {
      fail(
        'INVALID_COMMUNITY_PLAN_BASELINE',
        `Community baseline source entry ${index + 1} has an unsupported kind.`
      );
    }
    const itemId = deterministicCommunityItemId(entryId);
    const item = project.items[itemId];
    if (!item || item.kind !== ITEM_KIND_BY_ENTRY_KIND[entryKind]) {
      fail(
        'COMMUNITY_PLAN_BASELINE_ITEM_MISMATCH',
        `Community entry ${entryId} does not match its deterministic native item.`
      );
    }
    return {
      entryId,
      itemId,
      entryKind,
      itemKind: item.kind,
      sourceSha256: sha256(stableJson(entry)),
      contentSha256: communityServicePlanItemContentSha256(project, itemId),
      stateSha256: communityServicePlanItemStateSha256(project, itemId),
      contentSpecSha256:
        communityServicePlanItemContentSpecSha256(project, itemId),
      relationshipSha256:
        communityServicePlanItemRelationshipSha256(project, itemId),
      dependentStateSha256:
        communityServicePlanItemDependentStateSha256(project, itemId),
      titleSha256:
        communityServicePlanItemTitleSha256(project, itemId)
    };
  });
  const managedItemIds = new Set(entries.map(entry => entry.itemId));
  const containers = [{
    parentItemId: null,
    childItemIds: project.rootItemIds.filter(itemId =>
      managedItemIds.has(itemId))
  }];
  for (const entry of entries) {
    const item = project.items[entry.itemId];
    if (item.kind !== 'group') continue;
    containers.push({
      parentItemId: item.id,
      childItemIds: item.childIds.filter(itemId =>
        managedItemIds.has(itemId))
    });
  }
  const projection = {
    schemaVersion: COMMUNITY_SERVICE_PLAN_BASELINE_SCHEMA_VERSION,
    kind: COMMUNITY_SERVICE_PLAN_BASELINE_KIND,
    planRevision: source.planRevision,
    channelContractSha256:
      communityServicePlanChannelContractSha256(project),
    metadata: {
      title: project.title,
      serviceDate: project.serviceDate,
      startTime: project.planning.startTime,
      teamNotes: project.planning.teamNotes || ''
    },
    entries,
    containers
  };
  return normalizeCommunityServicePlanBaseline({
    ...projection,
    projectionSha256: sha256(stableJson(baselineProjectionBody(projection)))
  });
}

function serializeCommunityServicePlanBaseline(raw) {
  const baseline = normalizeCommunityServicePlanBaseline(raw);
  return `${JSON.stringify(stableValue(baseline), null, 2)}\n`;
}

/**
 * Derive a new exact schema-v2 baseline while allowing reconciliation to carry
 * selected BASE component hashes across candidate-only generator drift. No
 * identity, source, metadata, placement, or whole-item hash can be overridden.
 */
function deriveCommunityServicePlanBaselineWithComponentOverrides(
  rawBaseline,
  rawOverrides = []
) {
  const baseline = normalizeCommunityServicePlanBaseline(rawBaseline);
  if (baseline.schemaVersion !== 2) {
    fail(
      'COMMUNITY_PLAN_BASELINE_COMPONENTS_UNAVAILABLE',
      'Community baseline component overrides require schema v2.'
    );
  }
  if (!Array.isArray(rawOverrides) || rawOverrides.length > MAX_ENTRIES) {
    fail(
      'INVALID_COMMUNITY_PLAN_BASELINE',
      'Community baseline component overrides must be a bounded list.'
    );
  }
  const allowedComponentKeys = [
    'contentSpecSha256',
    'relationshipSha256',
    'dependentStateSha256'
  ];
  const entryById = new Map(
    baseline.entries.map(entry => [entry.entryId, entry])
  );
  const overridesByEntryId = new Map();
  for (const [index, rawOverride] of rawOverrides.entries()) {
    if (!isRecord(rawOverride)) {
      fail(
        'INVALID_COMMUNITY_PLAN_BASELINE',
        `Community baseline component override ${index + 1} must be an object.`
      );
    }
    const fields = Object.keys(rawOverride).sort();
    const componentFields = fields.filter(field =>
      allowedComponentKeys.includes(field));
    if (
      !fields.includes('entryId')
      || componentFields.length < 1
      || fields.length !== componentFields.length + 1
    ) {
      fail(
        'INVALID_COMMUNITY_PLAN_BASELINE',
        `Community baseline component override ${index + 1} contains unsupported or missing fields.`,
        { fields }
      );
    }
    const entryId = identifier(
      rawOverride.entryId,
      `Community baseline component override ${index + 1} entry ID`
    );
    if (!entryById.has(entryId) || overridesByEntryId.has(entryId)) {
      fail(
        'INVALID_COMMUNITY_PLAN_BASELINE',
        `Community baseline component override ${index + 1} has an unknown or repeated entry ID.`,
        { entryId }
      );
    }
    const normalizedOverride = { entryId };
    for (const field of componentFields) {
      normalizedOverride[field] = revision(
        rawOverride[field],
        `Community baseline component override ${index + 1} ${field}`
      );
    }
    overridesByEntryId.set(entryId, normalizedOverride);
  }
  if (overridesByEntryId.size < 1) return baseline;

  const projection = {
    schemaVersion: baseline.schemaVersion,
    kind: baseline.kind,
    planRevision: baseline.planRevision,
    channelContractSha256: baseline.channelContractSha256,
    metadata: baseline.metadata,
    entries: baseline.entries.map(entry => {
      const override = overridesByEntryId.get(entry.entryId);
      return override
        ? {
            ...entry,
            ...Object.fromEntries(
              allowedComponentKeys
                .filter(field =>
                  Object.prototype.hasOwnProperty.call(override, field))
                .map(field => [field, override[field]])
            )
          }
        : entry;
    }),
    containers: baseline.containers
  };
  return normalizeCommunityServicePlanBaseline({
    ...projection,
    projectionSha256: sha256(stableJson(baselineProjectionBody(projection)))
  });
}

module.exports = {
  COMMUNITY_SERVICE_PLAN_BASELINE_KIND,
  COMMUNITY_SERVICE_PLAN_BASELINE_SCHEMA_VERSION,
  COMMUNITY_SERVICE_PLAN_BASELINE_SCHEMA_VERSIONS,
  CommunityServicePlanBaselineError,
  communityServicePlanBaselineFromProject,
  communityServicePlanChannelContractSha256,
  communityServicePlanItemContentSpecSha256,
  communityServicePlanItemContentSha256,
  communityServicePlanItemDependentStateSha256,
  communityServicePlanItemRelationshipSha256,
  communityServicePlanItemStateSha256,
  communityServicePlanItemTitleSha256,
  deriveCommunityServicePlanBaselineWithComponentOverrides,
  deterministicCommunityItemId,
  normalizeCommunityServicePlanBaseline,
  serializeCommunityServicePlanBaseline
};
