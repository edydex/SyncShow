'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  applyPlanLinkedPowerPointHandoff,
  derivePlanLinkedPowerPointHandoff,
  samePlanLinkedPowerPointHandoff
} = require('../src/services/show/PlanLinkedPowerPointHandoff');
const {
  addGroupItem,
  addSermonResource,
  attachCommunityServicePlanning,
  bindProjectAsPowerPointCompanion,
  bindProjectToServiceSet,
  createServiceProject,
  resolveSermonSourceLink,
  setSermonSourceLink
} = require('../src/services/project/ServiceProject');

const NOW = '2026-07-26T16:00:00.000Z';
const SOURCE_REVISION_ID = 'a'.repeat(64);
const PLAN_REVISION = 'b'.repeat(64);
const SERVICE_FINGERPRINT = 'c'.repeat(64);

function sermonDocument({
  id = 'sermon-prayer',
  title = 'The Prayer That Transforms the Church'
} = {}) {
  return {
    schemaVersion: 2,
    kind: 'syncshow-sermon',
    id,
    titles: { en: title },
    defaultLanguage: 'en',
    speaker: { id: null, name: 'Pastor Example' },
    serviceDate: '2026-07-26',
    series: null,
    outline: [],
    sources: [],
    references: [],
    media: [],
    publication: {
      status: 'draft',
      visibility: 'private',
      publishedAt: null,
      canonicalUrl: null
    }
  };
}

function binding(overrides = {}) {
  return {
    id: '2026-07-26-main',
    fingerprint: SERVICE_FINGERPRINT,
    serviceDate: '2026-07-26',
    profileId: 'main-sanctuary',
    ...overrides
  };
}

function serviceSet(overrides = {}) {
  return {
    ...binding(),
    roles: [
      { roleId: 'english', assetId: `sha256:${'1'.repeat(64)}` },
      { roleId: 'media', assetId: `sha256:${'2'.repeat(64)}` },
      { roleId: 'russian', assetId: `sha256:${'3'.repeat(64)}` }
    ],
    ...overrides
  };
}

function communityProject({ extraSermon = false } = {}) {
  let project = createServiceProject({
    id: 'community-plan-local',
    title: 'Sunday Service',
    serviceDate: '2026-07-26',
    profileId: 'main-sanctuary',
    channels: [
      { id: 'primary', label: 'English', language: 'en' },
      { id: 'secondary', label: 'Russian', language: 'ru' }
    ],
    now: NOW
  });
  const added = addSermonResource(project, sermonDocument(), {
    provider: 'local-sermon-library',
    providerId: 'wotbc-community',
    itemId: 'sermon-prayer',
    revision: 'd'.repeat(64)
  });
  project = addGroupItem(added.project, {
    id: 'sermon-entry',
    title: 'Sermon',
    groupKind: 'sermon',
    sermonResourceId: added.resourceId,
    now: NOW
  });
  if (extraSermon) {
    const second = addSermonResource(
      project,
      sermonDocument({
        id: 'sermon-second',
        title: 'Second Sermon'
      })
    );
    project = addGroupItem(second.project, {
      id: 'second-sermon-entry',
      title: 'Second sermon',
      groupKind: 'sermon',
      sermonResourceId: second.resourceId,
      now: NOW
    });
  }
  project = attachCommunityServicePlanning(project, {
    serverId: 'wotbc-community',
    planId: 'plan-2026-07-26',
    planRevision: PLAN_REVISION,
    importedAt: NOW,
    startTime: '10:30'
  });
  return bindProjectToServiceSet(project, binding());
}

function companionProject() {
  let project = createServiceProject({
    id: 'pptx-companion-example',
    title: 'Sunday Service',
    serviceDate: '2026-07-26',
    profileId: 'main-sanctuary',
    channels: [
      { id: 'primary', label: 'English', language: 'en' }
    ],
    now: NOW
  });
  project = addGroupItem(project, {
    id: 'sermon-anchor',
    title: 'Sermon',
    groupKind: 'sermon',
    now: NOW
  });
  return bindProjectAsPowerPointCompanion(project, binding());
}

function handoff(sourceProject = communityProject()) {
  return derivePlanLinkedPowerPointHandoff({
    sourceProject,
    sourceProjectRevisionId: SOURCE_REVISION_ID,
    sourceItemId: 'sermon-entry',
    serviceSet: serviceSet()
  });
}

test('derives one exact path-free Community-plan sermon and ServiceSet claim', () => {
  const sourceProject = communityProject();
  const claim = handoff(sourceProject);
  const sourceResource = sourceProject.resources[
    sourceProject.items['sermon-entry'].sermonResourceId
  ];

  assert.equal(claim.source.projectId, sourceProject.id);
  assert.equal(claim.source.projectRevisionId, SOURCE_REVISION_ID);
  assert.deepEqual(claim.source.plan, {
    serverId: 'wotbc-community',
    planId: 'plan-2026-07-26',
    planRevision: PLAN_REVISION
  });
  assert.equal(claim.sermon.id, 'sermon-prayer');
  assert.equal(claim.sermon.revisionId, sourceResource.sha256);
  assert.equal(claim.sermon.resourceId, sourceResource.id);
  assert.deepEqual(claim.serviceSet.roles.map(role => role.roleId), [
    'english',
    'media',
    'russian'
  ]);
  assert.equal(
    /(?:\/Users\/|\/private\/|[A-Za-z]:\\)/u.test(JSON.stringify(claim)),
    false
  );
});

test('links the same content-addressed sermon to a companion and repeats idempotently', () => {
  const sourceProject = communityProject();
  const claim = handoff(sourceProject);
  const first = applyPlanLinkedPowerPointHandoff({
    companionProject: companionProject(),
    anchorItemId: 'sermon-anchor',
    sourceProject,
    handoff: claim,
    now: NOW
  });
  const linked = resolveSermonSourceLink(
    first.project,
    first.project.items['sermon-anchor']
  );

  assert.equal(first.unchanged, false);
  assert.equal(first.sermonId, 'sermon-prayer');
  assert.equal(linked.resourceId, claim.sermon.resourceId);
  assert.equal(linked.resource.document.id, claim.sermon.id);
  assert.equal(linked.resource.sha256, claim.sermon.revisionId);

  const repeated = applyPlanLinkedPowerPointHandoff({
    companionProject: first.project,
    anchorItemId: 'sermon-anchor',
    sourceProject,
    handoff: claim,
    now: NOW
  });
  assert.equal(repeated.unchanged, true);
  assert.deepEqual(repeated.project, first.project);
});

test('fails closed for ambiguous selection, stale plan/service claims, and conflicting companions', () => {
  assert.throws(
    () => derivePlanLinkedPowerPointHandoff({
      sourceProject: communityProject({ extraSermon: true }),
      sourceProjectRevisionId: SOURCE_REVISION_ID,
      serviceSet: serviceSet()
    }),
    error => error.code === 'AMBIGUOUS_PLAN_LINKED_POWERPOINT_SERMON'
  );
  assert.throws(
    () => derivePlanLinkedPowerPointHandoff({
      sourceProject: communityProject(),
      sourceProjectRevisionId: SOURCE_REVISION_ID,
      sourceItemId: 'sermon-entry',
      serviceSet: serviceSet({
        fingerprint: 'f'.repeat(64)
      })
    }),
    error => error.code === 'PLAN_LINKED_POWERPOINT_SERVICE_MISMATCH'
  );
  assert.throws(
    () => derivePlanLinkedPowerPointHandoff({
      sourceProject: communityProject(),
      sourceProjectRevisionId: SOURCE_REVISION_ID,
      sourceItemId: 'sermon-entry',
      serviceSet: serviceSet({
        roles: [{
          roleId: 'english',
          assetId: '/private/pinned/english.pptx'
        }]
      })
    }),
    error => error.code === 'INVALID_PLAN_LINKED_POWERPOINT_SERVICE'
  );

  const sourceProject = communityProject();
  const claim = handoff(sourceProject);
  const other = addSermonResource(
    companionProject(),
    sermonDocument({
      id: 'other-sermon',
      title: 'Another sermon'
    })
  );
  const conflicting = setSermonSourceLink(other.project, {
    itemId: 'sermon-anchor',
    sermonResourceId: other.resourceId,
    now: NOW
  });
  assert.throws(
    () => applyPlanLinkedPowerPointHandoff({
      companionProject: conflicting,
      anchorItemId: 'sermon-anchor',
      sourceProject,
      handoff: claim,
      now: NOW
    }),
    error => error.code === 'PLAN_LINKED_POWERPOINT_COMPANION_CONFLICT'
  );

  const changed = {
    ...claim,
    source: {
      ...claim.source,
      plan: {
        ...claim.source.plan,
        planRevision: 'e'.repeat(64)
      }
    }
  };
  assert.equal(samePlanLinkedPowerPointHandoff(claim, changed), false);
  assert.throws(
    () => applyPlanLinkedPowerPointHandoff({
      companionProject: companionProject(),
      anchorItemId: 'sermon-anchor',
      sourceProject,
      handoff: changed,
      now: NOW
    }),
    error => error.code === 'PLAN_LINKED_POWERPOINT_SOURCE_CHANGED'
  );
});
