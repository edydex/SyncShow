'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const controllerPath = path.join(
  root,
  'src',
  'renderer',
  'prepare-controller.js'
);
const controllerSource = fs.readFileSync(controllerPath, 'utf8');
const htmlSource = fs.readFileSync(
  path.join(root, 'src', 'renderer', 'index.html'),
  'utf8'
);
const stylesSource = fs.readFileSync(
  path.join(root, 'src', 'renderer', 'styles.css'),
  'utf8'
);

function rendererExports() {
  const window = {};
  vm.runInNewContext(controllerSource, { console, window }, {
    filename: controllerPath
  });
  return window.SyncShowPrepare;
}

function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

function functionSource(name, nextName) {
  const start = controllerSource.indexOf(`function ${name}(`);
  const nextStarts = [
    controllerSource.indexOf(`\n    function ${nextName}(`, start),
    controllerSource.indexOf(`\n    async function ${nextName}(`, start)
  ].filter(index => index > start);
  const end = Math.min(...nextStarts);
  assert.ok(start >= 0, `${name} must exist`);
  assert.ok(end > start, `${name} must end before ${nextName}`);
  return controllerSource.slice(start, end);
}

const planRevision = 'a'.repeat(64);
const localRevision = 'b'.repeat(64);

function importedProject() {
  return {
    id: 'community-service-local',
    planning: {
      source: {
        kind: 'community-plan',
        serverId: 'wotbc-community',
        planId: 'sunday-service-2026-08-02',
        planRevision,
        importedAt: '2026-07-29T19:06:26.441Z'
      }
    }
  };
}

function review({
  proposalStatus = 'already-imported',
  remoteStatus = 'ready',
  remoteRevision = planRevision,
  blockerCount = 0
} = {}) {
  return {
    connection: {
      serverId: 'wotbc-community'
    },
    servicePlan: {
      syncId: 'sunday-service-2026-08-02',
      revision: remoteRevision,
      status: remoteStatus
    },
    proposal: {
      status: proposalStatus,
      projectId: 'community-service-local',
      planId: 'sunday-service-2026-08-02',
      existingProject: true,
      blockerCount,
      ...(proposalStatus === 'already-imported'
        ? { revisionId: localRevision }
        : {}),
      ...(proposalStatus === 'newer-revision'
        ? {
            revisionId: localRevision,
            diff: { fromRevision: planRevision }
          }
        : {})
    }
  };
}

test('the Community origin card exposes one bound, accessible manual check', () => {
  for (const id of [
    'preparePlanningOrigin',
    'btnCheckCommunityPlanRevision',
    'preparePlanningOriginRevisionStatus',
    'communityServicePlansDialog',
    'communityServicePlanBlockersHeading'
  ]) {
    assert.equal(
      (htmlSource.match(new RegExp(`id="${id}"`, 'g')) || []).length,
      1,
      `${id} must be unique`
    );
  }
  const origin = htmlSource.slice(
    htmlSource.indexOf('<aside id="preparePlanningOrigin"'),
    htmlSource.indexOf(
      '</aside>',
      htmlSource.indexOf('<aside id="preparePlanningOrigin"')
    ) + 8
  );
  assert.match(
    origin,
    /id="btnCheckCommunityPlanRevision"[^>]*aria-haspopup="dialog"[^>]*aria-controls="communityServicePlansDialog"[^>]*aria-describedby="preparePlanningOriginRevisionStatus"/
  );
  assert.match(
    origin,
    /id="preparePlanningOriginRevisionStatus"[^>]*role="status"[^>]*aria-live="polite"[^>]*tabindex="-1"/
  );
  assert.match(origin, /saved local service remains available offline/i);
  assert.match(
    stylesSource,
    /\.community-service-plans-dialog\[data-review-source="project"\][\s\S]*\.community-service-plans-list-pane\s*\{\s*display:\s*none;/
  );
});

test('the bound check identity includes the exact local and imported revisions', () => {
  const {
    communityPlanRevisionCheckBinding,
    validateBoundCommunityPlanReview
  } = rendererExports();
  const binding = plain(
    communityPlanRevisionCheckBinding(importedProject(), localRevision)
  );
  assert.deepEqual(binding, {
    projectId: 'community-service-local',
    expectedRevisionId: localRevision,
    serverId: 'wotbc-community',
    planId: 'sunday-service-2026-08-02',
    planRevision,
    key: [
      'community-service-local',
      localRevision,
      'wotbc-community',
      'sunday-service-2026-08-02',
      planRevision
    ].join('\u0000')
  });
  assert.equal(
    validateBoundCommunityPlanReview(review(), binding).proposal.status,
    'already-imported'
  );
  assert.equal(
    validateBoundCommunityPlanReview(
      review({
        proposalStatus: 'newer-revision',
        remoteRevision: 'c'.repeat(64)
      }),
      binding
    ).proposal.status,
    'newer-revision'
  );
  assert.throws(
    () => validateBoundCommunityPlanReview({
      ...review(),
      connection: { serverId: 'different-community' }
    }, binding),
    /different imported service/
  );
  assert.throws(
    () => validateBoundCommunityPlanReview(
      review({ proposalStatus: 'ready-to-import' }),
      binding
    ),
    /different imported service/
  );
  assert.throws(
    () => validateBoundCommunityPlanReview({
      ...review(),
      proposal: {
        ...review().proposal,
        revisionId: 'd'.repeat(64)
      }
    }, binding),
    /local service changed/
  );
});

test('same, newer, lifecycle, offline, reconnect, cancellation, and errors stay read-only', () => {
  const {
    communityPlanRevisionCheckFailure,
    communityPlanRevisionReviewOutcome
  } = rendererExports();
  const outcomes = [
    [review(), 'same', 'Same revision'],
    [
      review({
        proposalStatus: 'newer-revision',
        remoteRevision: 'c'.repeat(64)
      }),
      'newer',
      'Newer Ready revision'
    ],
    [
      review({
        proposalStatus: 'blocked',
        remoteStatus: 'draft',
        blockerCount: 1
      }),
      'draft',
      'Draft'
    ],
    [
      review({
        proposalStatus: 'blocked',
        remoteStatus: 'archived',
        blockerCount: 1
      }),
      'archived',
      'Archived'
    ],
    [
      review({
        proposalStatus: 'blocked',
        remoteStatus: 'cancelled',
        blockerCount: 1
      }),
      'cancelled',
      'Cancelled'
    ]
  ];
  for (const [value, status, phrase] of outcomes) {
    const outcome = plain(communityPlanRevisionReviewOutcome(value));
    assert.equal(outcome.status, status);
    assert.match(outcome.text, new RegExp(phrase));
    assert.match(outcome.text, /remains unchanged and available offline/);
  }

  for (const [code, status, phrase] of [
    ['NETWORK_ERROR', 'offline', 'offline or unreachable'],
    [
      'COMMUNITY_SERVICE_PLAN_RECONNECT_REQUIRED',
      'reconnect',
      'Reconnect the exact Heritage Community server'
    ],
    [
      'COMMUNITY_OPERATION_CANCELLED',
      'cancelled',
      'request was cancelled'
    ],
    ['PROJECT_CONFLICT', 'stale', 'local service changed'],
    ['UNEXPECTED_FAILURE', 'error', 'Server rejected the check']
  ]) {
    const failure = plain(
      communityPlanRevisionCheckFailure({
        code,
        message: code === 'UNEXPECTED_FAILURE'
          ? 'Server rejected the check.'
          : ''
      })
    );
    assert.equal(failure.status, status);
    assert.match(failure.text, new RegExp(phrase, 'i'));
    assert.match(failure.text, /remains unchanged and available offline/);
  }
});

test('the origin action calls only the project-bound semantic API and rejects stale results', () => {
  const source = functionSource(
    'checkCurrentCommunityServicePlanRevision',
    'reviewCommunityServicePlan'
  );
  assert.match(
    source,
    /api\.checkCommunityServicePlanRevision\(\{\s*projectId:\s*binding\.projectId,\s*expectedRevisionId:\s*binding\.expectedRevisionId\s*\}\)/
  );
  assert.match(
    source,
    /validateBoundCommunityPlanReview\([\s\S]*communityServicePlanContracts\.normalizeReview\(/
  );
  assert.match(
    source,
    /request !== state\.communityPlanCheckRequest[\s\S]*currentBinding\?\.key !== binding\.key/
  );
  assert.match(source, /state\.communityPlanDirectReviewBindingKey = binding\.key/);
  assert.match(source, /elements\.communityPlansDialog\.showModal\(\)/);
  assert.match(source, /elements\.communityPlanReviewState[\s\S]*\.focus\(\)/);
  assert.doesNotMatch(source, /listCommunityServicePlans/);
  assert.doesNotMatch(source, /reviewCommunityServicePlan\(/);
  assert.doesNotMatch(
    source,
    /replaceReviewedCommunityServicePlan|importReviewedCommunityServicePlan|mutateProject/
  );

  const bindStart = controllerSource.indexOf('function bindEvents()');
  const bindEnd = controllerSource.indexOf('\n    async function activate(', bindStart);
  const binding = controllerSource.slice(bindStart, bindEnd);
  assert.match(
    binding,
    /btnCheckCommunityPlanRevision\.addEventListener\(\s*'click',\s*checkCurrentCommunityServicePlanRevision\s*\)/
  );
});

test('a same-revision bound review has no redundant confirmation action', () => {
  const source = functionSource(
    'renderCommunityPlanDetail',
    'renderCommunityPlanList'
  );
  assert.match(
    source,
    /const directSameRevision = directReview\s*&& proposal\.status === 'already-imported'/
  );
  assert.match(
    source,
    /const importable = !directSameRevision[\s\S]*elements\.communityPlanConfirmationLabel\.hidden = !actionable/
  );
  assert.match(
    source,
    /already uses the exact current Ready Community revision/
  );
  assert.match(
    source,
    /There is nothing to apply, and no local content was changed/
  );
});
