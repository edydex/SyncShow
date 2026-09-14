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

function sourceBetween(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  assert.notEqual(start, -1, `${startMarker} must be implemented`);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.notEqual(end, -1, `${endMarker} must follow ${startMarker}`);
  return source.slice(start, end);
}

function rendererExports() {
  const window = {};
  vm.runInNewContext(
    controllerSource,
    { console, window },
    { filename: controllerPath }
  );
  return window.SyncShowPrepare;
}

function hasLocalPath(value) {
  if (typeof value === 'string') {
    return value.includes('/private/')
      || value.includes('/Users/')
      || /^[A-Za-z]:[\\/]/u.test(value);
  }
  if (!value || typeof value !== 'object') return false;
  return Object.values(value).some(hasLocalPath);
}

function proposal(overrides = {}) {
  return {
    proposalToken: 'p'.repeat(32),
    expiresAt: '2026-07-26T16:15:00.000Z',
    action: 'create',
    source: {
      projectTitle: 'Sunday Community Plan',
      planId: 'plan-2026-07-26',
      planRevision: 'a'.repeat(64)
    },
    sermon: {
      id: 'sermon-prayer',
      revisionId: 'b'.repeat(64),
      title: 'The Prayer That Transforms the Church',
      speaker: 'Pastor Example'
    },
    serviceSet: {
      name: 'Sunday Service',
      serviceDate: '2026-07-26',
      profileName: 'Main Sanctuary'
    },
    roles: [{
      roleId: 'english',
      roleLabel: 'English',
      fileName: '07-26-2026 Service ENG.pptx'
    }, {
      roleId: 'media',
      roleLabel: 'Singers',
      fileName: '07-26-2026 Media.pptx'
    }, {
      roleId: 'russian',
      roleLabel: 'Russian',
      fileName: '07-26-2026 Служение RUS.pptx'
    }],
    ...overrides
  };
}

test('renderer normalizes a path-free exact sermon and PowerPoint review', () => {
  const { normalizePlanLinkedPowerPointHandoffProposal } = rendererExports();
  const normalized = normalizePlanLinkedPowerPointHandoffProposal(proposal());

  assert.equal(normalized.action, 'create');
  assert.equal(normalized.sermon.id, 'sermon-prayer');
  assert.equal(normalized.sermon.revisionId, 'b'.repeat(64));
  assert.equal(normalized.source.planRevision, 'a'.repeat(64));
  assert.deepEqual(
    JSON.parse(JSON.stringify(normalized.roles.map(role => role.roleId))),
    ['english', 'media', 'russian']
  );
  assert.equal(hasLocalPath(normalized), false);

  const scrubbed = normalizePlanLinkedPowerPointHandoffProposal(proposal({
    roles: [{
      roleId: 'english',
      roleLabel: 'English',
      fileName: '/Users/operator/Church/07-26 Service ENG.pptx'
    }]
  }));
  assert.equal(scrubbed.roles[0].fileName, '07-26 Service ENG.pptx');
  assert.equal(hasLocalPath(scrubbed), false);

  assert.throws(
    () => normalizePlanLinkedPowerPointHandoffProposal(proposal({
      action: 'publish'
    })),
    /review was incomplete/
  );
  assert.throws(
    () => normalizePlanLinkedPowerPointHandoffProposal(proposal({
      roles: []
    })),
    /review was incomplete/
  );
});

test('Prepare exposes one explicit human-confirmed Community-sermon CTA', () => {
  for (const id of [
    'prepareCurrentServicePlanHandoffHint',
    'btnUseCommunitySermonWithCurrentService',
    'planLinkedPowerPointHandoffDialog',
    'planLinkedPowerPointHandoffForm',
    'planLinkedPowerPointHandoffSermon',
    'planLinkedPowerPointHandoffService',
    'planLinkedPowerPointHandoffRoles',
    'planLinkedPowerPointHandoffConfirmed',
    'btnCancelPlanLinkedPowerPointHandoff',
    'btnCommitPlanLinkedPowerPointHandoff'
  ]) {
    assert.match(htmlSource, new RegExp(`id="${id}"`));
  }
  assert.match(
    htmlSource,
    /Use this sermon with the current PowerPoint Show/
  );
  assert.match(
    htmlSource,
    /It will not create another sermon, modify the presentations, publish anything, or contact Community\./
  );
  assert.match(
    htmlSource,
    /I reviewed this exact Community sermon and every current PowerPoint role\./
  );

  const contextSource = sourceBetween(
    controllerSource,
    'function selectedPlanLinkedPowerPointHandoffContext()',
    'function renderCurrentServiceCompanion()'
  );
  assert.match(
    contextSource,
    /!\[2, 3\]\.includes\(project\.planning\?\.schemaVersion\)/
  );
  assert.match(contextSource, /source\?\.kind !== 'community-plan'/);
  assert.match(contextSource, /row\.item\.groupKind !== 'sermon'/);
  assert.match(contextSource, /linked\.resourceOwnerId !== row\.item\.id/);
  assert.match(contextSource, /linked\.resource\?\.kind !== 'sermon'/);

  const reviewSource = sourceBetween(
    controllerSource,
    'async function openPlanLinkedPowerPointHandoffReview()',
    'async function commitPlanLinkedPowerPointHandoff(event)'
  );
  assert.match(
    reviewSource,
    /api\.proposePlanLinkedPowerPointHandoff\(\{[\s\S]*projectId: context\.projectId,[\s\S]*expectedRevisionId: context\.expectedRevisionId,[\s\S]*itemId: context\.itemId,[\s\S]*inspectionToken: summary\.inspectionToken/
  );
  assert.doesNotMatch(
    reviewSource,
    /(?:sourcePath|filePath|communityToken|accessToken|publish|startShow|endSession)\s*:/
  );

  const commitSource = sourceBetween(
    controllerSource,
    'async function commitPlanLinkedPowerPointHandoff(event)',
    'async function inspectPostShowPowerPointService('
  );
  const renderReviewSource = sourceBetween(
    controllerSource,
    'function renderPlanLinkedPowerPointHandoffReview()',
    'function closePlanLinkedPowerPointHandoffReview('
  );
  assert.match(
    commitSource,
    /planLinkedPowerPointHandoffConfirmed\.checked !== true/
  );
  assert.match(
    commitSource,
    /api\.commitPlanLinkedPowerPointHandoff\(\{[\s\S]*proposalToken: proposal\.proposalToken,[\s\S]*confirmed: true/
  );
  assert.match(
    commitSource,
    /linked\.resource\.document\.id !== proposal\.sermon\.id/
  );
  assert.match(
    commitSource,
    /linked\.resource\.sha256 !== proposal\.sermon\.revisionId/
  );
  assert.doesNotMatch(
    commitSource,
    /(?:pushCommunitySermon|publishServiceProject|startShow|endSession|sourcePath|filePath)\s*\(/
  );
  assert.match(
    renderReviewSource,
    /planLinkedPowerPointHandoffError\.textContent\s*=\s*state\.planLinkedPowerPointHandoffError \|\| ''/
  );
  assert.match(
    renderReviewSource,
    /planLinkedPowerPointHandoffError\.hidden\s*=\s*!state\.planLinkedPowerPointHandoffError/
  );
  assert.doesNotMatch(
    renderReviewSource,
    /planLinkedPowerPointHandoffError\.(?:hidden\s*=\s*true|textContent\s*=\s*'')/
  );
  assert.match(
    commitSource,
    /catch \(error\) \{[\s\S]*state\.planLinkedPowerPointHandoffError = errorMessage\([\s\S]*finally \{[\s\S]*renderPlanLinkedPowerPointHandoffReview\(\)/
  );
});
