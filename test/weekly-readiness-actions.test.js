'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const {
  WEEKLY_READINESS_CHECK_IDS,
  WEEKLY_READINESS_TARGET_KINDS,
  resolveWeeklyReadinessActions
} = require('../src/renderer/weekly-readiness-actions');
const {
  addProjectItem,
  analyzeServiceProjectReadiness,
  createServiceProject,
  serializeServiceProject
} = require('../src/services/project');

const PROJECT_ID = 'service-2026-08-16';
const PROJECT_REVISION = 7;
const REVISION_ID = 'a'.repeat(64);
const CURRENT_CONTEXT = Object.freeze({
  projectId: PROJECT_ID,
  projectRevision: PROJECT_REVISION,
  revisionId: REVISION_ID
});
const MODULE_PATH = path.resolve(
  __dirname,
  '../src/renderer/weekly-readiness-actions.js'
);
const PREPARE_CONTROLLER_PATH = path.resolve(
  __dirname,
  '../src/renderer/prepare-controller.js'
);
const EXACT_SERMON_OWNER_CONFLICT_MESSAGE =
  'Each exact sermon revision must have one unambiguous sermon material set.';

const CHECKS = Object.freeze([
  Object.freeze({
    id: 'compilable-nonempty',
    label: 'Compilable service',
    waivable: false,
    message: 'The native service must compile to at least one cue.'
  }),
  Object.freeze({
    id: 'song-present',
    label: 'Communal singing',
    waivable: true,
    message: 'Add at least one song to the service order.'
  }),
  Object.freeze({
    id: 'exact-sermon-link',
    label: 'Exact sermon packet',
    waivable: true,
    message: 'Link at least one exact sermon packet revision.'
  }),
  Object.freeze({
    id: 'linked-sermon-material',
    label: 'Projected sermon material',
    waivable: true,
    message: 'Add a projected sermon cue or imported deck under an exact sermon link.'
  }),
  Object.freeze({
    id: 'sermon-reading-before-material',
    label: 'Reading before the sermon',
    waivable: true,
    message: 'Place an exact linked sermon reading before its projected sermon material.'
  }),
  Object.freeze({
    id: 'channel-visible-content',
    label: 'Every output has content',
    waivable: true,
    message: 'Every configured channel must have visible projected content.'
  })
]);

function readinessReport(statuses, options = {}) {
  const cueCount = options.cueCount ?? (statuses[0] === 'pass' ? 1 : 0);
  const checks = CHECKS.map((check, index) => ({
    ...check,
    status: statuses[index],
    ...(statuses[index] === 'waived'
      ? { waiverReason: `Reviewed exception ${index + 1}.` }
      : {})
  }));
  return {
    projectId: options.projectId ?? PROJECT_ID,
    projectRevision: options.projectRevision ?? PROJECT_REVISION,
    projectContentHash: Object.hasOwn(options, 'projectContentHash')
      ? options.projectContentHash
      : (cueCount > 0 ? REVISION_ID : null),
    ready: checks.every(check => check.status !== 'blocker'),
    cueCount,
    checks,
    blockers: checks.filter(check => check.status === 'blocker'),
    waivedChecks: checks.filter(check => check.status === 'waived')
  };
}

function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

function exactSermonConflictReport() {
  const report = readinessReport([
    'pass',
    'pass',
    'blocker',
    'pass',
    'pass',
    'pass'
  ]);
  const revisionId = 'b'.repeat(64);
  const exactLink = report.checks[2];
  exactLink.waivable = false;
  exactLink.message = EXACT_SERMON_OWNER_CONFLICT_MESSAGE;
  exactLink.evidence = {
    count: 1,
    sermonRevisionIds: [revisionId],
    ambiguousOwnerSets: [{
      resourceId: `sha256:${revisionId}`,
      itemIds: ['sermon-morning', 'sermon-evening']
    }]
  };
  return report;
}

function reportWithAllBlockerEvidence() {
  const report = readinessReport(Array(6).fill('blocker'));
  report.checks[0].evidence = {
    cueCount: 0,
    compilationCode: 'EMPTY_PROJECT'
  };
  report.checks[1].evidence = { count: 0, itemIds: [] };
  report.checks[2].evidence = {
    count: 0,
    sermonRevisionIds: [],
    ambiguousOwnerSets: []
  };
  report.checks[3].evidence = { count: 0, itemIds: [] };
  report.checks[4].evidence = {
    count: 0,
    itemIds: [],
    requiredSermonResourceIds: [],
    missingSermonResourceIds: []
  };
  report.checks[5].evidence = {
    coveredChannelIds: [],
    missingChannelIds: ['primary']
  };
  return report;
}

function prepareRendererExports() {
  const source = fs.readFileSync(PREPARE_CONTROLLER_PATH, 'utf8');
  const window = {};
  vm.runInNewContext(source, { console, window }, {
    filename: PREPARE_CONTROLLER_PATH
  });
  return window.SyncShowPrepare;
}

test('all canonical blockers resolve to frozen revision-bound actions in canonical order', () => {
  const report = readinessReport(Array(6).fill('blocker'));
  const before = structuredClone(report);
  const resolved = resolveWeeklyReadinessActions(report, CURRENT_CONTEXT);

  assert.deepEqual(WEEKLY_READINESS_CHECK_IDS, [
    'compilable-nonempty',
    'song-present',
    'exact-sermon-link',
    'linked-sermon-material',
    'sermon-reading-before-material',
    'channel-visible-content'
  ]);
  assert.deepEqual(WEEKLY_READINESS_TARGET_KINDS, [
    'add-content',
    'song-library',
    'weekly-sermon',
    'sermon-material',
    'sermon-reading',
    'output-treatments'
  ]);
  assert.deepEqual(
    resolved.actions.map(action => action.targetKind),
    WEEKLY_READINESS_TARGET_KINDS
  );
  assert.deepEqual(
    resolved.actions.map(action => action.checkId),
    WEEKLY_READINESS_CHECK_IDS
  );
  assert.deepEqual(
    Object.keys(resolved.actions[0]).sort(),
    [
      'actionLabel',
      'checkId',
      'detail',
      'label',
      'projectId',
      'projectRevision',
      'revisionId',
      'targetKind'
    ]
  );
  assert.equal(resolved.primaryAction, resolved.actions[0]);
  assert.equal(resolved.actions.every(action =>
    action.projectId === PROJECT_ID
      && action.projectRevision === PROJECT_REVISION
      && action.revisionId === REVISION_ID), true);
  assert.equal(Object.isFrozen(resolved), true);
  assert.equal(Object.isFrozen(resolved.actions), true);
  assert.equal(resolved.actions.every(Object.isFrozen), true);
  assert.deepEqual(report, before, 'resolution must not mutate the report');
});

test('only blockers become actions and the first blocker is primary', () => {
  const resolved = resolveWeeklyReadinessActions(
    readinessReport([
      'pass',
      'blocker',
      'waived',
      'pass',
      'blocker',
      'pass'
    ]),
    CURRENT_CONTEXT
  );

  assert.deepEqual(
    resolved.actions.map(action => [action.checkId, action.targetKind]),
    [
      ['song-present', 'song-library'],
      ['sermon-reading-before-material', 'sermon-reading']
    ]
  );
  assert.equal(resolved.primaryAction.checkId, 'song-present');
});

test('pass and canonically reviewed multiline waivers produce an empty result', () => {
  const report = readinessReport([
    'pass',
    'waived',
    'pass',
    'waived',
    'pass',
    'waived'
  ]);
  report.checks[1].waiverReason = 'Spoken service\nNo communal song.';
  const resolved = resolveWeeklyReadinessActions(report, CURRENT_CONTEXT);

  assert.deepEqual(plain(resolved), { actions: [], primaryAction: null });
  assert.equal(Object.isFrozen(resolved), true);
  assert.equal(Object.isFrozen(resolved.actions), true);
});

test('production analyzer and renderer normalization feed the resolver without schema adaptation', () => {
  const now = '2026-08-10T18:00:00.000Z';
  let project = createServiceProject({
    id: PROJECT_ID,
    title: 'Sunday Service',
    serviceDate: '2026-08-16',
    profileId: 'main-sanctuary',
    channels: [{ id: 'primary', label: 'Main', language: 'en' }],
    now
  });
  project = addProjectItem(project, {
    id: 'welcome',
    kind: 'notice',
    title: 'Welcome',
    textByChannel: { primary: 'Welcome to worship.' },
    presetId: 'notice-text',
    operatorNotes: ''
  }, { now });

  const canonical = analyzeServiceProjectReadiness(project);
  const normalized = prepareRendererExports()
    .normalizeServiceReadinessReport(canonical, project);
  const revisionId = crypto
    .createHash('sha256')
    .update(serializeServiceProject(project))
    .digest('hex');
  assert.equal(canonical.projectContentHash, revisionId);
  assert.equal(Object.hasOwn(normalized.checks[0], 'evidence'), true);

  const resolved = resolveWeeklyReadinessActions(normalized, {
    projectId: project.id,
    projectRevision: project.revision,
    revisionId
  });
  assert.deepEqual(
    resolved.actions.map(action => action.checkId),
    [
      'song-present',
      'exact-sermon-link',
      'linked-sermon-material',
      'sermon-reading-before-material'
    ]
  );
});

test('malformed, stale, unknown, duplicate, and inconsistent reports fail closed', () => {
  const allPass = readinessReport(Array(6).fill('pass'));
  assert.throws(
    () => resolveWeeklyReadinessActions(null, CURRENT_CONTEXT),
    /normalized readiness report/
  );
  assert.throws(
    () => resolveWeeklyReadinessActions(allPass, {
      ...CURRENT_CONTEXT,
      projectId: 'bad project!'
    }),
    /canonical project ID/
  );
  assert.throws(
    () => resolveWeeklyReadinessActions(allPass, {
      ...CURRENT_CONTEXT,
      projectRevision: -1
    }),
    /non-negative safe integer/
  );
  assert.throws(
    () => resolveWeeklyReadinessActions(allPass, {
      ...CURRENT_CONTEXT,
      revisionId: 'A'.repeat(64)
    }),
    /lowercase SHA-256/
  );
  assert.throws(
    () => resolveWeeklyReadinessActions(
      { ...allPass, projectId: 'another-service' },
      CURRENT_CONTEXT
    ),
    /does not match/
  );
  assert.throws(
    () => resolveWeeklyReadinessActions(
      { ...allPass, projectRevision: PROJECT_REVISION + 1 },
      CURRENT_CONTEXT
    ),
    /does not match/
  );
  assert.throws(
    () => resolveWeeklyReadinessActions(
      { ...allPass, projectContentHash: 'b'.repeat(64) },
      CURRENT_CONTEXT
    ),
    /revision ID/
  );
  assert.throws(
    () => resolveWeeklyReadinessActions(
      { ...allPass, checks: allPass.checks.slice(0, 5) },
      CURRENT_CONTEXT
    ),
    /exactly 6 canonical checks/
  );

  const unknown = structuredClone(allPass);
  unknown.checks[2].id = 'unknown-check';
  assert.throws(
    () => resolveWeeklyReadinessActions(unknown, CURRENT_CONTEXT),
    /canonical ID exactly once and in canonical order/
  );

  const duplicate = structuredClone(allPass);
  duplicate.checks[2].id = duplicate.checks[1].id;
  assert.throws(
    () => resolveWeeklyReadinessActions(duplicate, CURRENT_CONTEXT),
    /canonical ID exactly once and in canonical order/
  );

  const outOfOrder = structuredClone(allPass);
  [outOfOrder.checks[1], outOfOrder.checks[2]] = [
    outOfOrder.checks[2],
    outOfOrder.checks[1]
  ];
  assert.throws(
    () => resolveWeeklyReadinessActions(outOfOrder, CURRENT_CONTEXT),
    /canonical ID exactly once and in canonical order/
  );

  const inconsistentReady = structuredClone(allPass);
  inconsistentReady.ready = false;
  assert.throws(
    () => resolveWeeklyReadinessActions(inconsistentReady, CURRENT_CONTEXT),
    /ready state does not match/
  );

  const inconsistentSummary = structuredClone(allPass);
  inconsistentSummary.blockers.push(inconsistentSummary.checks[1]);
  assert.throws(
    () => resolveWeeklyReadinessActions(inconsistentSummary, CURRENT_CONTEXT),
    /summaries do not match/
  );
});

test('unsafe or inconsistent check strings and fields fail closed', () => {
  const unsafeLabel = readinessReport(Array(6).fill('pass'));
  unsafeLabel.checks[1].label = 'Communal singing\u0000';
  assert.throws(
    () => resolveWeeklyReadinessActions(unsafeLabel, CURRENT_CONTEXT),
    /invalid label/
  );

  const unsafeMessage = readinessReport(Array(6).fill('pass'));
  unsafeMessage.checks[1].message = 'Unsafe\u0007message';
  assert.throws(
    () => resolveWeeklyReadinessActions(unsafeMessage, CURRENT_CONTEXT),
    /normalized safe text/
  );

  const tooLongMessage = readinessReport(Array(6).fill('pass'));
  tooLongMessage.checks[1].message = 'x'.repeat(1001);
  assert.throws(
    () => resolveWeeklyReadinessActions(tooLongMessage, CURRENT_CONTEXT),
    /1000 characters or fewer/
  );

  const badWaiver = readinessReport([
    'pass',
    'waived',
    'pass',
    'pass',
    'pass',
    'pass'
  ]);
  badWaiver.checks[1].waiverReason = 'Unsafe\u0000reason';
  assert.throws(
    () => resolveWeeklyReadinessActions(badWaiver, CURRENT_CONTEXT),
    /normalized safe text/
  );

  const inconsistentWaiver = readinessReport(Array(6).fill('pass'));
  inconsistentWaiver.checks[1].waiverReason = 'Not actually waived.';
  assert.throws(
    () => resolveWeeklyReadinessActions(inconsistentWaiver, CURRENT_CONTEXT),
    /unexpected waiver reason/
  );

  const invalidStatus = readinessReport(Array(6).fill('pass'));
  invalidStatus.checks[1].status = 'warning';
  assert.throws(
    () => resolveWeeklyReadinessActions(invalidStatus, CURRENT_CONTEXT),
    /invalid status/
  );

  const invalidWaivable = readinessReport(Array(6).fill('pass'));
  invalidWaivable.checks[0].waivable = true;
  assert.throws(
    () => resolveWeeklyReadinessActions(invalidWaivable, CURRENT_CONTEXT),
    /invalid waiver contract/
  );
});

test('only documented ambiguous sermon ownership may tighten the waiver contract', () => {
  const report = exactSermonConflictReport();
  const before = structuredClone(report);
  const resolved = resolveWeeklyReadinessActions(report, CURRENT_CONTEXT);

  assert.deepEqual(plain(resolved.actions), [{
    checkId: 'exact-sermon-link',
    label: 'Exact sermon packet',
    actionLabel: 'Review sermon sections',
    targetKind: 'weekly-sermon',
    projectId: PROJECT_ID,
    projectRevision: PROJECT_REVISION,
    revisionId: REVISION_ID,
    detail: 'This exact sermon revision appears in more than one sermon material set. Review the sermon sections and keep one unambiguous owner.'
  }]);
  assert.deepEqual(report, before);

  const noEvidence = exactSermonConflictReport();
  delete noEvidence.checks[2].evidence;
  assert.throws(
    () => resolveWeeklyReadinessActions(noEvidence, CURRENT_CONTEXT),
    /invalid waiver contract/
  );

  const oneOwner = exactSermonConflictReport();
  oneOwner.checks[2].evidence.ambiguousOwnerSets[0].itemIds.pop();
  assert.throws(
    () => resolveWeeklyReadinessActions(oneOwner, CURRENT_CONTEXT),
    /at least two material sets/
  );

  const wrongMessage = exactSermonConflictReport();
  wrongMessage.checks[2].message = 'Review this packet.';
  assert.throws(
    () => resolveWeeklyReadinessActions(wrongMessage, CURRENT_CONTEXT),
    /invalid waiver contract/
  );

  const wrongCheck = readinessReport(Array(6).fill('blocker'));
  wrongCheck.checks[1].waivable = false;
  assert.throws(
    () => resolveWeeklyReadinessActions(wrongCheck, CURRENT_CONTEXT),
    /invalid waiver contract/
  );
});

test('bounded evidence for every canonical check is accepted and contradictions fail closed', () => {
  const report = reportWithAllBlockerEvidence();
  assert.deepEqual(
    resolveWeeklyReadinessActions(report, CURRENT_CONTEXT)
      .actions.map(action => action.checkId),
    WEEKLY_READINESS_CHECK_IDS
  );

  const corruptions = [
    candidate => {
      candidate.checks[0].evidence.cueCount = 1;
    },
    candidate => {
      candidate.checks[1].evidence.count = 1;
    },
    candidate => {
      candidate.checks[2].evidence.sermonRevisionIds = ['B'.repeat(64)];
      candidate.checks[2].evidence.count = 1;
    },
    candidate => {
      candidate.checks[3].evidence.itemIds = ['bad item!'];
      candidate.checks[3].evidence.count = 1;
    },
    candidate => {
      candidate.checks[4].evidence.missingSermonResourceIds = [
        `sha256:${'c'.repeat(64)}`
      ];
    },
    candidate => {
      candidate.checks[5].evidence.coveredChannelIds = ['primary'];
    }
  ];
  for (const corrupt of corruptions) {
    const candidate = structuredClone(report);
    corrupt(candidate);
    assert.throws(
      () => resolveWeeklyReadinessActions(candidate, CURRENT_CONTEXT)
    );
  }

  const contradictoryStatus = structuredClone(report);
  contradictoryStatus.checks[1].evidence = {
    count: 1,
    itemIds: ['song-one']
  };
  assert.throws(
    () => resolveWeeklyReadinessActions(contradictoryStatus, CURRENT_CONTEXT),
    /status contradicts its evidence/
  );
});

test('the same frozen contract is exposed to a browser global without runtime authority', () => {
  const source = fs.readFileSync(MODULE_PATH, 'utf8');
  const context = vm.createContext({});
  vm.runInContext(source, context, {
    filename: 'weekly-readiness-actions.js'
  });

  const browserContract = context.SyncShowWeeklyReadinessActions;
  assert.ok(browserContract);
  assert.equal(Object.isFrozen(browserContract), true);
  assert.deepEqual(
    plain(browserContract.WEEKLY_READINESS_CHECK_IDS),
    plain(WEEKLY_READINESS_CHECK_IDS)
  );
  assert.deepEqual(
    plain(browserContract.resolveWeeklyReadinessActions(
      readinessReport(Array(6).fill('blocker')),
      CURRENT_CONTEXT
    )),
    plain(resolveWeeklyReadinessActions(
      readinessReport(Array(6).fill('blocker')),
      CURRENT_CONTEXT
    ))
  );
  assert.doesNotMatch(
    source,
    /window\.api|ipcRenderer|ipcMain|fetch\s*\(|mutateProject/
  );
});
