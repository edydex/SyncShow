'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const mainSource = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
const preloadSource = fs.readFileSync(path.join(root, 'preload.js'), 'utf8');
const controllerPath = path.join(
  root,
  'src',
  'renderer',
  'prepare-controller.js'
);
const controllerSource = fs.readFileSync(controllerPath, 'utf8');
const reviewContractPath = path.join(
  root,
  'src',
  'renderer',
  'community-service-plan-review.js'
);
const reviewContractSource = fs.readFileSync(reviewContractPath, 'utf8');
const htmlSource = fs.readFileSync(
  path.join(root, 'src', 'renderer', 'index.html'),
  'utf8'
);
const stylesSource = fs.readFileSync(
  path.join(root, 'src', 'renderer', 'styles.css'),
  'utf8'
);

function plain(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.keys(value).sort().map(key => [key, stableValue(value[key])])
  );
}

function loadPreloadBridge() {
  const calls = [];
  let api = null;
  vm.runInNewContext(preloadSource, {
    require(moduleId) {
      if (moduleId !== 'electron') {
        throw new Error(`Unexpected preload dependency: ${moduleId}`);
      }
      return {
        contextBridge: {
          exposeInMainWorld(name, value) {
            if (name === 'api') api = value;
          }
        },
        ipcRenderer: {
          invoke(channel, payload) {
            calls.push({ channel, payload: plain(payload) });
            return Promise.resolve({ success: true, data: {} });
          },
          send() {},
          on() {},
          removeListener() {},
          removeAllListeners() {}
        }
      };
    },
    console,
    TextEncoder
  }, { filename: path.join(root, 'preload.js') });
  return { api, calls };
}

function handlerSource(channel) {
  const marker = `ipcMain.handle('${channel}'`;
  const start = mainSource.indexOf(marker);
  assert.notEqual(start, -1, `${channel} must be implemented`);
  const next = mainSource.indexOf("ipcMain.handle('", start + marker.length);
  return mainSource.slice(start, next === -1 ? mainSource.length : next);
}

function reviewContracts() {
  const window = {};
  vm.runInNewContext(
    reviewContractSource,
    { window },
    { filename: reviewContractPath }
  );
  return window.SyncShowCommunityServicePlans;
}

function loadStalePinHelpers() {
  const start = mainSource.indexOf(
    'function communityServicePlanDependencyKey'
  );
  const end = mainSource.indexOf(
    'function pruneCommunityServicePlanPreparations',
    start
  );
  assert.ok(start >= 0 && end > start);
  const sandbox = {
    COMMUNITY_SERVICE_PLAN_PREPARATION_MAX_ITEMS: 100,
    COMMUNITY_SERVICE_PLAN_STALE_PIN_LIMIT: 12,
    COMMUNITY_SERVICE_PLAN_STALE_PIN_TTL_MS: 60 * 60 * 1000,
    communityServicePlanStalePins: new Map()
  };
  vm.runInNewContext(
    mainSource.slice(start, end),
    sandbox,
    { filename: path.join(root, 'main.js') }
  );
  return sandbox;
}

function readyReview(overrides = {}) {
  const revision = 'a'.repeat(64);
  return {
    connection: {
      id: 'connection-1',
      serverId: 'wotbc-community',
      serverName: 'WOTBC Community'
    },
    servicePlan: {
      syncId: 'plan-2026-08-02',
      syncVersion: 4,
      revision,
      status: 'ready',
      changedAt: '2026-07-28T12:00:00.000Z',
      plan: {
        schemaVersion: 1,
        id: 'plan-2026-08-02',
        title: 'Sunday Service',
        serviceDate: '2026-08-02',
        startTime: '10:30',
        teamNotes: 'Review the sermon reading.',
        entries: [
          { id: 'gathering', kind: 'section', title: 'Gathering' }
        ]
      }
    },
    proposal: {
      status: 'ready-to-import',
      projectId: 'community-plan-local',
      planId: 'plan-2026-08-02',
      planRevision: revision,
      remoteStatus: 'ready',
      blockerCount: 0,
      blockersTruncated: false,
      blockers: [],
      diff: null,
      existingProject: false
    },
    reviewToken: '123e4567-e89b-42d3-a456-426614174000',
    reviewExpiresAt: '2026-07-28T12:15:00.000Z',
    replacementToken: null,
    replacementExpiresAt: null,
    preparation: null,
    ...overrides
  };
}

function threeWayReconciliation(overrides = {}) {
  return {
    schemaVersion: 1,
    mode: 'three-way',
    applicable: true,
    baselinePlanRevision: 'c'.repeat(64),
    baselineProjectionSha256: 'd'.repeat(64),
    candidatePlanRevision: 'a'.repeat(64),
    candidateProjectionSha256: 'e'.repeat(64),
    mergeResultSha256: 'f'.repeat(64),
    preservedLocalItemCount: 2,
    appliedCommunityItemCount: 1,
    autoMergedItemCount: 1,
    conflictCount: 1,
    conflictsTruncated: false,
    conflicts: [{
      conflictId: 'reconcile-gathering',
      kind: 'LOCAL_AND_COMMUNITY_ITEM_CHANGED',
      itemId: 'gathering',
      entryId: 'gathering',
      title: 'Gathering',
      local: {
        choice: 'keep-local',
        summary: 'Keep the locally edited gathering cue.'
      },
      community: {
        choice: 'use-community',
        summary: 'Use the gathering cue from Community.'
      }
    }],
    ...overrides
  };
}

function legacyReconciliation(overrides = {}) {
  return threeWayReconciliation({
    mode: 'legacy-full-replace',
    baselineProjectionSha256: null,
    preservedLocalItemCount: 0,
    autoMergedItemCount: 0,
    conflictCount: 1,
    conflicts: [{
      conflictId: 'reconcile-legacy-project',
      kind: 'RECONCILIATION_BASELINE_UNAVAILABLE',
      itemId: null,
      entryId: null,
      title: 'Legacy imported project',
      local: {
        choice: 'keep-local',
        summary: 'Keep the current local Planning project unchanged.'
      },
      community: {
        choice: 'use-community',
        summary: 'Replace every active editable Planning item.'
      }
    }],
    ...overrides
  });
}

function projectReconciliationBaseline(
  planRevision = 'a'.repeat(64),
  { schemaVersion = 2 } = {}
) {
  return {
    schemaVersion,
    kind: 'syncshow-community-service-plan-baseline',
    planRevision,
    projectionSha256: 'e'.repeat(64),
    channelContractSha256: 'f'.repeat(64),
    metadata: {
      title: 'Sunday Service',
      serviceDate: '2026-08-02',
      startTime: '10:30',
      teamNotes: 'Review the sermon reading.'
    },
    entries: [{
      entryId: 'gathering',
      itemId: 'community-item-gathering',
      entryKind: 'section',
      itemKind: 'group',
      sourceSha256: '1'.repeat(64),
      contentSha256: '2'.repeat(64),
      stateSha256: '3'.repeat(64),
      ...(schemaVersion === 2
        ? {
            contentSpecSha256: '4'.repeat(64),
            relationshipSha256: '5'.repeat(64),
            dependentStateSha256: '6'.repeat(64),
            titleSha256: '7'.repeat(64)
          }
        : {})
    }],
    containers: [{
      parentItemId: null,
      childItemIds: ['community-item-gathering']
    }]
  };
}

function projectReconciliationReceipt({
  mode = 'three-way',
  previousLocalRevisionId = 'b'.repeat(64),
  overrides = {}
} = {}) {
  const legacy = mode === 'legacy-full-replace';
  const receipt = {
    schemaVersion: 1,
    kind: 'community-service-plan-reconciliation-receipt',
    mode,
    previousPlanRevision: 'c'.repeat(64),
    candidatePlanRevision: 'a'.repeat(64),
    previousBaselineProjectionSha256:
      legacy ? null : 'd'.repeat(64),
    candidateProjectionSha256: 'e'.repeat(64),
    mergeResultSha256: 'f'.repeat(64),
    previousLocalRevisionId,
    conflictCount: 1,
    decisions: [{
      conflictId: legacy
        ? 'reconcile-legacy-project'
        : 'reconcile-gathering',
      choice: legacy ? 'use-community' : 'keep-local'
    }],
    appliedAt: '2026-07-28T12:01:00.000Z',
    ...overrides
  };
  receipt.receiptSha256 = crypto.createHash('sha256')
    .update(JSON.stringify(stableValue(receipt)))
    .digest('hex');
  return receipt;
}

function projectReconciliationBoundaryBaseline() {
  const baseline = projectReconciliationBaseline();
  const entries = Array.from({ length: 500 }, (_, index) => ({
    ...baseline.entries[0],
    entryId: `section-${index}`,
    itemId: `community-item-${index}`
  }));
  return {
    ...baseline,
    entries,
    containers: [{
      parentItemId: null,
      childItemIds: entries.map(entry => entry.itemId)
    }, ...entries.map(entry => ({
      parentItemId: entry.itemId,
      childItemIds: []
    }))]
  };
}

function newerRevisionReview(overrides = {}) {
  const base = readyReview();
  return {
    ...base,
    proposal: {
      ...base.proposal,
      status: 'newer-revision',
      existingProject: true,
      revisionId: 'b'.repeat(64),
      diff: {
        fromRevision: 'c'.repeat(64),
        toRevision: base.servicePlan.revision,
        addedCount: 1,
        removedCount: 0,
        changedCount: 1,
        unchangedCount: 2,
        metadataChanges: {
          titleChanged: true,
          serviceDateChanged: false,
          startTimeChanged: false,
          teamNotesChanged: true
        },
        changes: [{
          itemId: 'gathering',
          change: 'changed',
          before: { kind: 'section', title: 'Old gathering' },
          after: { kind: 'section', title: 'Gathering' }
        }, {
          itemId: 'song-new',
          change: 'added',
          before: null,
          after: { kind: 'song', title: 'New song' }
        }],
        truncated: false
      },
      reconciliation: threeWayReconciliation()
    },
    reviewToken: null,
    reviewExpiresAt: null,
    replacementToken: '323e4567-e89b-42d3-a456-426614174000',
    replacementExpiresAt: '2026-07-28T12:15:00.000Z',
    ...overrides
  };
}

function preparableReview(overrides = {}) {
  const base = readyReview();
  const entries = [{
    id: 'song-grace',
    kind: 'song',
    title: 'Grace Alone',
    syncId: 'song-family-grace',
    expectedRevision: 'song:song-family-grace:7',
    expectedSyncVersion: 7
  }, {
    id: 'sermon-prayer',
    kind: 'sermon',
    title: 'The Prayer That Transforms the Church',
    syncId: 'sermon-prayer',
    expectedRevision: 'b'.repeat(64),
    expectedSyncVersion: 4
  }];
  return {
    ...base,
    servicePlan: {
      ...base.servicePlan,
      plan: {
        ...base.servicePlan.plan,
        entries
      }
    },
    proposal: {
      ...base.proposal,
      status: 'blocked',
      blockerCount: 2,
      blockers: [{
        entryId: 'song-grace',
        kind: 'song',
        code: 'LOCAL_SONG_MISSING',
        message: 'The referenced song family is not fully available locally.'
      }, {
        entryId: 'sermon-prayer',
        kind: 'sermon',
        code: 'LOCAL_SERMON_MISSING',
        message: 'The referenced sermon is not available locally.'
      }]
    },
    reviewToken: null,
    reviewExpiresAt: null,
    replacementToken: null,
    replacementExpiresAt: null,
    preparation: {
      token: '223e4567-e89b-42d3-a456-426614174000',
      expiresAt: '2026-07-28T12:15:00.000Z',
      itemCount: 2,
      songCount: 1,
      sermonCount: 1
    },
    ...overrides
  };
}

function loadImportHandler({ failImports = 0 } = {}) {
  const handlers = new Map();
  const reviews = new Map();
  const token = '123e4567-e89b-42d3-a456-426614174000';
  const review = {
    connectionId: 'connection-1',
    serverId: 'wotbc-community',
    envelope: { syncId: 'plan-2026-08-02' },
    options: { profileId: 'main' },
    optionsKey: JSON.stringify({ profileId: 'main' })
  };
  reviews.set(token, review);
  let attempts = 0;
  const fail = (code, message) => {
    const error = new Error(message);
    error.code = code;
    throw error;
  };
  vm.runInNewContext(handlerSource('community:servicePlans:import'), {
    communityIpcResult: async operation => {
      try {
        return { success: true, data: await operation() };
      } catch (error) {
        return {
          success: false,
          error: { code: error.code, message: error.message }
        };
      }
    },
    communityRequestKeys() {},
    communityServicePlanContext: async () => ({
      connection: {
        id: 'connection-1',
        serverId: 'wotbc-community'
      }
    }),
    communityServicePlanCoordinator() {
      return {
        async importPlan() {
          attempts += 1;
          if (attempts <= failImports) {
            fail('TRANSIENT_IMPORT_FAILURE', 'Local storage is temporarily busy.');
          }
          return {
            status: 'imported',
            project: { id: 'community-plan-local' },
            revisionId: 'b'.repeat(64)
          };
        }
      };
    },
    communityServicePlanImportOptions: () => ({ profileId: 'main' }),
    communityServicePlanImportOptionsKey: JSON.stringify,
    communityServicePlanReviews: reviews,
    failMainOperation: fail,
    ipcMain: {
      handle(channel, callback) {
        handlers.set(channel, callback);
      }
    },
    projectResult: value => value,
    requireCommunityServicePlanReview(rawToken) {
      const held = reviews.get(rawToken);
      if (!held) {
        fail(
          'EXPIRED_SERVICE_PLAN_REVIEW',
          'That service-plan review is no longer available.'
        );
      }
      return { token: rawToken, review: held };
    },
    requireControlSender() {},
    serializeCommunityOperation: operation => operation()
  });
  return {
    handler: handlers.get('community:servicePlans:import'),
    reviews,
    token,
    attempts: () => attempts
  };
}

function loadReplacementHandler({
  blocked = false,
  connectionChanged = false,
  localChanged = false,
  profileChanged = false,
  proposalChanged = false,
  remoteChanged = false,
  remoteStatus = 'ready'
} = {}) {
  const handlers = new Map();
  const replacements = new Map();
  const token = '323e4567-e89b-42d3-a456-426614174000';
  const reviewedEnvelope = {
    syncId: 'plan-2026-08-02',
    syncVersion: 4,
    revision: 'a'.repeat(64),
    status: 'ready',
    changedAt: '2026-07-28T12:00:00.000Z',
    documentSource: 'reviewed-plan'
  };
  const localRevisionId = 'b'.repeat(64);
  const proposal = {
    status: 'newer-revision',
    projectId: 'community-plan-local',
    planId: reviewedEnvelope.syncId,
    planRevision: reviewedEnvelope.revision,
    remoteStatus: 'ready',
    blockerCount: 0,
    blockersTruncated: false,
    blockers: [],
    diff: {
      fromRevision: 'c'.repeat(64),
      toRevision: reviewedEnvelope.revision,
      addedCount: 1,
      removedCount: 0,
      changedCount: 0,
      unchangedCount: 1,
      metadataChanges: {
        titleChanged: false,
        serviceDateChanged: false,
        startTimeChanged: false,
        teamNotesChanged: false
      },
      changes: [],
      truncated: false
    },
    reconciliation: threeWayReconciliation(),
    existingProject: true,
    revisionId: localRevisionId
  };
  const options = { profileId: 'main' };
  replacements.set(token, {
    connectionId: 'connection-1',
    serverId: 'wotbc-community',
    envelope: reviewedEnvelope,
    planId: reviewedEnvelope.syncId,
    remoteSyncVersion: reviewedEnvelope.syncVersion,
    remoteRevision: reviewedEnvelope.revision,
    localProjectId: proposal.projectId,
    localRevisionId,
    options,
    optionsKey: JSON.stringify(options),
    proposalKey: JSON.stringify(proposal),
    expiresAt: Date.now() + 60_000
  });
  let replacementsApplied = 0;
  const fail = (code, message) => {
    const error = new Error(message);
    error.code = code;
    throw error;
  };
  const freshEnvelope = {
    ...reviewedEnvelope,
    ...(remoteChanged
      ? {
          syncVersion: 5,
          revision: 'd'.repeat(64),
          changedAt: '2026-07-28T12:01:00.000Z',
          documentSource: 'changed-plan'
        }
      : {}),
    status: remoteStatus
  };
  const freshProposal = blocked
    ? {
        ...proposal,
        status: 'blocked',
        blockerCount: 1,
        blockers: [{
          entryId: null,
          kind: 'plan',
          code: 'LOCAL_CONTENT_INCOMPATIBLE',
          message: 'The exact local content changed.'
        }],
        diff: null
      }
    : {
        ...proposal,
        ...(localChanged ? { revisionId: 'e'.repeat(64) } : {}),
        ...(proposalChanged
          ? {
              diff: {
                ...proposal.diff,
                addedCount: 2
              }
            }
          : {})
      };
  vm.runInNewContext(handlerSource('community:servicePlans:replace'), {
    communityIpcResult: async operation => {
      try {
        return { success: true, data: await operation() };
      } catch (error) {
        return {
          success: false,
          error: { code: error.code, message: error.message }
        };
      }
    },
    communityRequestKeys() {},
    communityServicePlanContext: async () => ({
      connection: {
        id: connectionChanged ? 'connection-2' : 'connection-1',
        serverId: 'wotbc-community',
        accessToken: 'main-owned-token'
      },
      client: {
        async getServicePlan({ syncId, accessToken }) {
          assert.equal(syncId, reviewedEnvelope.syncId);
          assert.equal(accessToken, 'main-owned-token');
          return freshEnvelope;
        }
      }
    }),
    communityServicePlanCoordinator() {
      return {
        async review() {
          return {
            proposal: freshProposal,
            preparationDependencies: []
          };
        },
        async replacePlanRevision(envelope, heldOptions, replaceOptions) {
          replacementsApplied += 1;
          assert.equal(envelope, freshEnvelope);
          assert.equal(heldOptions, options);
          assert.equal(
            replaceOptions.expectedRevisionId,
            localRevisionId
          );
          assert.deepEqual(
            plain(replaceOptions.decisions),
            [{
              conflictId: 'reconcile-gathering',
              choice: 'keep-local'
            }]
          );
          assert.deepEqual(
            plain(replaceOptions.expectedReconciliation),
            {
              mode: proposal.reconciliation.mode,
              baselineProjectionSha256:
                proposal.reconciliation.baselineProjectionSha256,
              candidateProjectionSha256:
                proposal.reconciliation.candidateProjectionSha256,
              mergeResultSha256:
                proposal.reconciliation.mergeResultSha256
            }
          );
          return {
            status: 'reconciled',
            project: {
              id: proposal.projectId,
              title: 'Sunday Service'
            },
            previousRevisionId: localRevisionId,
            revisionId: 'f'.repeat(64),
            unchanged: false
          };
        }
      };
    },
    communityServicePlanImportOptions: () =>
      profileChanged ? { profileId: 'other' } : options,
    communityServicePlanImportOptionsKey: JSON.stringify,
    communityServicePlanReplacementProposalKey: JSON.stringify,
    prepareCommunityServicePlanReconciliationDecisions(
      rawDecisions,
      heldProposal
    ) {
      assert.equal(heldProposal, freshProposal);
      if (!Array.isArray(rawDecisions)) {
        fail(
          'INVALID_SERVICE_PLAN_RECONCILIATION_DECISIONS',
          'Every conflict needs a choice.'
        );
      }
      return rawDecisions.map(decision => ({
        conflictId: decision.conflictId,
        choice: decision.choice
      }));
    },
    communityServicePlanReplacements: replacements,
    failMainOperation: fail,
    ipcMain: {
      handle(channel, callback) {
        handlers.set(channel, callback);
      }
    },
    projectResult: value => ({
      project: value.project,
      revisionId: value.revisionId,
      unchanged: value.unchanged,
      recovery: null,
      readiness: {}
    }),
    requireCommunityServicePlanReplacement(rawToken) {
      const replacement = replacements.get(rawToken);
      if (!replacement) {
        fail(
          'EXPIRED_SERVICE_PLAN_REPLACEMENT',
          'That replacement review is no longer available.'
        );
      }
      return { token: rawToken, replacement };
    },
    requireControlSender() {},
    sameCommunityServicePlanEnvelope: (left, right) =>
      left.syncId === right.syncId
      && left.syncVersion === right.syncVersion
      && left.revision === right.revision
      && left.status === right.status
      && left.changedAt === right.changedAt
      && left.documentSource === right.documentSource,
    serializeCommunityOperation: operation => operation()
  });
  return {
    handler: handlers.get('community:servicePlans:replace'),
    replacements,
    token,
    decisions: [{
      conflictId: 'reconcile-gathering',
      choice: 'keep-local'
    }],
    replacementsApplied: () => replacementsApplied
  };
}

function loadPreparationHandler({
  dependencyChangedBefore = false,
  missingScope = false,
  planChangedBefore = false,
  sermonOffline = false,
  songPreconditionFailure = false
} = {}) {
  const handlers = new Map();
  const preparations = new Map();
  const token = '223e4567-e89b-42d3-a456-426614174000';
  const dependencies = [{
    kind: 'song',
    syncId: 'song-family-grace',
    expectedSyncVersion: 7,
    expectedRevision: 'song:song-family-grace:7',
    entryIds: ['song-grace'],
    blockerCodes: ['LOCAL_SONG_MISSING']
  }, {
    kind: 'sermon',
    syncId: 'sermon-prayer',
    expectedSyncVersion: 4,
    expectedRevision: 'b'.repeat(64),
    entryIds: ['sermon-prayer'],
    blockerCodes: ['LOCAL_SERMON_MISSING']
  }];
  const reviewedEnvelope = {
    syncId: 'plan-2026-08-02',
    syncVersion: 4,
    revision: 'a'.repeat(64),
    status: 'ready',
    changedAt: '2026-07-28T12:00:00.000Z',
    documentSource: 'reviewed-plan'
  };
  const changedEnvelope = {
    ...reviewedEnvelope,
    syncVersion: 5,
    revision: 'c'.repeat(64),
    documentSource: 'changed-plan'
  };
  const options = { profileId: 'main' };
  preparations.set(token, {
    connectionId: 'connection-1',
    serverId: 'wotbc-community',
    envelope: reviewedEnvelope,
    options,
    optionsKey: JSON.stringify(options),
    dependencies,
    dependencyKey: JSON.stringify(dependencies),
    expiresAt: Date.now() + 60_000
  });
  const events = [];
  let planReads = 0;
  let songPrepared = false;
  let sermonPrepared = false;
  let sermonPulls = 0;
  let stalePinObserved = false;
  const fail = (code, message) => {
    const error = new Error(message);
    error.code = code;
    throw error;
  };
  const context = {
    connection: {
      id: 'connection-1',
      serverId: 'wotbc-community',
      serverName: 'WOTBC Community',
      accessToken: 'community-access-token',
      canReadSongs: true,
      canReadSermons: true,
      scopes: [
        'syncshow:service-plans:read',
        'syncshow:songs:read',
        'syncshow:sermons:read'
      ],
      advertisedScopes: [
        'syncshow:service-plans:read',
        'syncshow:songs:read',
        'syncshow:sermons:read'
      ]
    },
    client: {
      async getServicePlan() {
        planReads += 1;
        events.push(`plan-${planReads}`);
        return planReads === 1 && planChangedBefore
          ? changedEnvelope
          : reviewedEnvelope;
      }
    }
  };
  vm.runInNewContext(handlerSource('community:servicePlans:prepare'), {
    AbortController,
    communityIpcResult: async operation => {
      try {
        return { success: true, data: await operation() };
      } catch (error) {
        return {
          success: false,
          error: { code: error.code, message: error.message }
        };
      }
    },
    communityOperationEpoch: 0,
    communityRequestKeys() {},
    communityServicePlanContext: async () => context,
    communityServicePlanCoordinator() {
      return {
        async review() {
          const preparationDependencies = dependencyChangedBefore
            ? []
            : dependencies.filter(dependency =>
                dependency.kind === 'song'
                  ? !songPrepared
                  : !sermonPrepared);
          return {
            proposal: {
              status: preparationDependencies.length > 0
                ? 'blocked'
                : 'ready-to-import'
            },
            preparationDependencies
          };
        }
      };
    },
    applyCommunityServicePlanStalePins(review) {
      return stalePinObserved
        ? {
            proposal: { status: 'blocked' },
            preparationDependencies: []
          }
        : review;
    },
    knownCommunityServicePlanStalePins: () =>
      stalePinObserved ? dependencies.slice(0, 1) : [],
    rememberCommunityServicePlanStalePin() {
      stalePinObserved = true;
      events.push('stale-pin');
    },
    communityServicePlanDependencyKey: JSON.stringify,
    communityServicePlanImportOptions: () => options,
    communityServicePlanImportOptionsKey: JSON.stringify,
    communityServicePlanPreparations: preparations,
    communityServicePlanReviewResponse: async input => {
      events.push('fresh-review');
      return {
        fresh: true,
        planRevision: input.envelope.revision,
        proposalStatus: input.inspected.proposal.status
      };
    },
    communitySyncAbortController: null,
    activeCommunityServicePlanPreparation: null,
    communitySyncForConnection: async () => ({
      async pullSong() {
        events.push('song');
        if (songPreconditionFailure) {
          fail(
            'REMOTE_PRECONDITION_FAILED',
            'The planned song changed.'
          );
        }
        songPrepared = true;
        return { status: 'synced', pulled: 1 };
      }
    }),
    communitySermonSyncForConnection: async () => ({
      async pullSermon() {
        events.push('sermon');
        sermonPulls += 1;
        if (sermonOffline && sermonPulls === 1) {
          return { status: 'offline' };
        }
        sermonPrepared = true;
        return { status: 'synced', pulled: 1 };
      }
    }),
    failMainOperation: fail,
    ipcMain: {
      handle(channel, callback) {
        handlers.set(channel, callback);
      }
    },
    notifyCommunityStatusChanged: async () => {
      events.push('status');
    },
    requireCommunityReconnectFor: () => false,
    requireCommunityServicePlanPreparation(rawToken) {
      const preparation = preparations.get(rawToken);
      if (!preparation) {
        fail(
          'EXPIRED_SERVICE_PLAN_PREPARATION',
          'The plan preparation expired.'
        );
      }
      return { token: rawToken, preparation };
    },
    requireCommunityServicePlanPreparationScopes() {
      if (missingScope) {
        fail(
          'COMMUNITY_SERVICE_PLAN_ITEMS_RECONNECT_REQUIRED',
          'Reconnect with sermon read access.'
        );
      }
    },
    requireControlSender() {},
    sameCommunityServicePlanEnvelope: (left, right) =>
      left.revision === right.revision
      && left.syncVersion === right.syncVersion
      && left.documentSource === right.documentSource,
    serializeCommunityOperation: operation => operation()
  });
  return {
    events,
    handler: handlers.get('community:servicePlans:prepare'),
    preparations,
    token
  };
}

test('preload exposes only bounded service-plan browse, review, and confirmation intents', async () => {
  const { api, calls } = loadPreloadBridge();

  await api.listCommunityServicePlans({
    cursor: 'page-2',
    limit: 25,
    accessToken: 'must-not-cross',
    documentSource: 'must-not-cross'
  });
  await api.reviewCommunityServicePlan({
    syncId: 'plan-2026-08-02',
    revision: 'renderer-does-not-pin-this'
  });
  await api.prepareCommunityServicePlan({
    preparationToken: 'preparation-token',
    confirmed: 1,
    syncIds: ['renderer-must-not-select'],
    accessToken: 'must-not-cross'
  });
  await api.prepareCommunityServicePlan({
    preparationToken: 'confirmed-preparation-token',
    confirmed: true
  });
  await api.cancelCommunityServicePlanPreparation({
    preparationToken: 'confirmed-preparation-token',
    syncIds: ['must-not-cross'],
    accessToken: 'must-not-cross'
  });
  await api.importReviewedCommunityServicePlan({
    reviewToken: 'review-token',
    confirmed: 1,
    project: { id: 'renderer-owned' }
  });
  await api.replaceReviewedCommunityServicePlan({
    replacementToken: 'replacement-token',
    confirmed: true,
    decisions: [{
      conflictId: 'reconcile-gathering',
      choice: 'keep-local',
      project: { id: 'must-not-cross' }
    }, {
      conflictId: 'reconcile-order',
      choice: 'use-community',
      unsupported: true
    }],
    expectedRevisionId: 'renderer-must-not-bind-this',
    project: { id: 'renderer-owned' }
  });

  assert.deepEqual(calls, [
    {
      channel: 'community:servicePlans:list',
      payload: { cursor: 'page-2', limit: 25 }
    },
    {
      channel: 'community:servicePlans:review',
      payload: { syncId: 'plan-2026-08-02' }
    },
    {
      channel: 'community:servicePlans:prepare',
      payload: {
        preparationToken: 'preparation-token',
        confirmed: false
      }
    },
    {
      channel: 'community:servicePlans:prepare',
      payload: {
        preparationToken: 'confirmed-preparation-token',
        confirmed: true
      }
    },
    {
      channel: 'community:servicePlans:prepareCancel',
      payload: {
        preparationToken: 'confirmed-preparation-token'
      }
    },
    {
      channel: 'community:servicePlans:import',
      payload: { reviewToken: 'review-token', confirmed: false }
    },
    {
      channel: 'community:servicePlans:replace',
      payload: {
        replacementToken: 'replacement-token',
        confirmed: true,
        decisions: [{
          conflictId: 'reconcile-gathering',
          choice: 'keep-local'
        }, {
          conflictId: 'reconcile-order',
          choice: 'use-community'
        }]
      }
    }
  ]);
});

test('preload preserves reviewed reconciliation order and caps the decision payload', async () => {
  const { api, calls } = loadPreloadBridge();
  const decisions = Array.from({ length: 501 }, (_, index) => ({
    conflictId: `reconcile-${index}`,
    choice: index % 2 === 0 ? 'keep-local' : 'use-community',
    unsupported: 'must-not-cross'
  }));

  await api.replaceReviewedCommunityServicePlan({
    replacementToken: 'replacement-token',
    confirmed: true,
    decisions
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].payload.decisions.length, 500);
  assert.deepEqual(calls[0].payload.decisions[0], {
    conflictId: 'reconcile-0',
    choice: 'keep-local'
  });
  assert.deepEqual(calls[0].payload.decisions[499], {
    conflictId: 'reconcile-499',
    choice: 'use-community'
  });
});

test('Prepare owns an explicit lifecycle, reconciliation, and confirmation review surface', () => {
  for (const id of [
    'prepareCommunityPlans',
    'communityServicePlansDialog',
    'communityServicePlansList',
    'communityServicePlanLifecycle',
    'communityServicePlanBlockers',
    'communityServicePlanDiff',
    'communityServicePlanReconciliationSummary',
    'communityServicePlanReconciliationMode',
    'communityServicePlanConflicts',
    'communityServicePlanDecisionStatus',
    'communityServicePlanPreparationSection',
    'btnPrepareCommunityServicePlan',
    'btnCancelCommunityServicePlanPreparation',
    'communityServicePlanConfirmed',
    'btnImportCommunityServicePlan'
  ]) {
    assert.match(htmlSource, new RegExp(`id="${id}"`));
  }
  assert.match(
    htmlSource,
    /never changes current Load or Show/
  );
  assert.match(
    htmlSource,
    /class="community-service-plan-detail" aria-label="Selected Community service plan"/
  );
  assert.match(controllerSource, /draft: 'Draft'/);
  assert.match(controllerSource, /ready: 'Ready'/);
  assert.match(controllerSource, /archived: 'Archived'/);
  assert.match(controllerSource, /cancelled: 'Cancelled'/);
  assert.match(controllerSource, /proposal\.status === 'newer-revision'/);
  assert.match(
    controllerSource,
    /Apply reconciliation & open Planning/
  );
  assert.match(controllerSource, /Legacy fallback:/);
  assert.match(controllerSource, /Keep local makes no change/);
  assert.match(controllerSource, /input\.type = 'radio'/);
  assert.match(controllerSource, /communityPlanConflictChoices/);
  assert.match(
    controllerSource,
    /!\[2, 3\]\.includes\(project\.planning\?\.schemaVersion\)/
  );
  assert.match(
    controllerSource,
    /\[2, 3\]\.includes\(state\.currentProject\?\.planning\?\.schemaVersion\)/
  );
  assert.match(controllerSource, /proposal\.blockersTruncated/);
  assert.match(controllerSource, /diff\.truncated/);
  assert.match(
    mainSource,
    /schemaVersion:\s*envelope\.plan\.schemaVersion/
  );
  assert.match(
    mainSource,
    /sermonEntryId:\s*entry\.sermonReading\.sermonEntryId/
  );
  assert.match(
    controllerSource,
    /SyncShowCommunityServicePlans\.entryDisplayLabel/
  );
  assert.match(htmlSource, /Prepare required plan items/);
  assert.match(
    htmlSource,
    /does not import a service or change Load or Show/
  );
  assert.match(htmlSource, /Stop preparation/);
});

test('renderer conflict choices have no default and invalidate final confirmation', () => {
  assert.match(
    controllerSource,
    /communityPlanConflictChoices:\s*new Map\(\)/
  );
  assert.match(
    controllerSource,
    /for \(const conflict of reconciliation\.conflicts\)/
  );
  assert.match(
    controllerSource,
    /input\.checked = state\.communityPlanConflictChoices\.get\([\s\S]*?\) === side\.choice/
  );
  assert.match(
    controllerSource,
    /state\.communityPlanConflictChoices\.set\(conflictId, input\.value\);[\s\S]*?communityPlanConfirmed\.checked = false;/
  );
  assert.match(
    controllerSource,
    /decisions === null[\s\S]*?legacyCommunityPlanReconciliationDeclined/
  );
  assert.doesNotMatch(
    controllerSource,
    /communityPlanConflictChoices\.get\([^)]*\)\s*\|\|\s*['"]keep-local['"]/
  );
});

test('service-plan review labels duplicate sermon titles by their exact item position', () => {
  const contracts = reviewContracts();
  const entries = [
    {
      id: 'reading',
      kind: 'scripture',
      title: 'Ephesians 3:14–21',
      range: {
        schemaVersion: 1,
        bookId: 'Eph',
        start: { chapter: 3, verse: 14 },
        end: { chapter: 3, verse: 21 }
      },
      translationId: 'BSB',
      sermonReading: {
        sermonEntryId: 'sermon-b',
        referenceId: 'primary-eph-3'
      }
    },
    {
      id: 'sermon-a',
      kind: 'sermon',
      title: 'Faithful Prayer',
      syncId: 'sermon-resource-a',
      expectedRevision: 'a'.repeat(64),
      expectedSyncVersion: 1
    },
    {
      id: 'sermon-b',
      kind: 'sermon',
      title: 'Faithful Prayer',
      syncId: 'sermon-resource-b',
      expectedRevision: 'b'.repeat(64),
      expectedSyncVersion: 1
    }
  ];

  assert.equal(
    contracts.entryDisplayLabel(entries[0], entries),
    'Ephesians 3:14–21 · Eph 3:14–21 · BSB · Item 1'
      + ' · Reading for Faithful Prayer (Item 3)'
  );
  assert.equal(
    contracts.entryDisplayLabel(entries[1], entries),
    'Faithful Prayer · Sermon · Item 2'
  );
  assert.equal(
    contracts.entryDisplayLabel(entries[2], entries),
    'Faithful Prayer · Sermon · Item 3'
  );
});

test('Community service-plan surfaces use only the defined dark-theme palette', () => {
  const rootEnd = stylesSource.indexOf('}');
  assert.ok(rootEnd > 0, 'the root token block must be present');
  const definedTokens = new Set(
    [...stylesSource.slice(0, rootEnd).matchAll(/^\s*(--[a-z0-9-]+)\s*:/gim)]
      .map(match => match[1])
  );
  const blockStart = stylesSource.indexOf('.prepare-community-plans-card {');
  const blockEnd = stylesSource.indexOf('@media (max-width: 850px)', blockStart);
  assert.ok(blockStart >= 0 && blockEnd > blockStart,
    'the Community service-plan style block must be present');
  const communityStyles = stylesSource.slice(blockStart, blockEnd);
  const usedTokens = [
    ...communityStyles.matchAll(/var\(\s*(--[a-z0-9-]+)(?:\s*,[^)]*)?\)/gi)
  ];

  assert.ok(usedTokens.length > 0);
  for (const [, token] of usedTokens) {
    assert.ok(definedTokens.has(token), `${token} must be defined in :root`);
  }
  assert.doesNotMatch(
    communityStyles,
    /var\(\s*--[a-z0-9-]+\s*,/i,
    'Community service-plan surfaces must not fall back to a light-theme color'
  );
  assert.match(
    communityStyles,
    /\.prepare-community-plans-card\s*\{[^}]*border:\s*1px solid var\(--border\)[^}]*background:\s*var\(--bg-raised\)/s
  );
  assert.match(
    communityStyles,
    /\.community-service-plans-list-pane,\s*\.community-service-plan-detail\s*\{[^}]*border:\s*1px solid var\(--border\)/s
  );
  assert.match(
    communityStyles,
    /\.community-service-plan-review-state,\s*\.community-service-plan-notes,\s*\.community-service-plan-findings\s*\{[^}]*background:\s*var\(--bg-input\)/s
  );
  assert.match(
    communityStyles,
    /\.community-service-plan-review-state\[data-kind="error"\],[^}]*border-left:\s*3px solid var\(--danger\)/s
  );
  assert.match(
    communityStyles,
    /\.community-service-plan-review-state\[data-kind="success"\]\s*\{[^}]*border-left:\s*3px solid var\(--success\)/s
  );
});

test('confirmed import consumes a main-owned reviewed envelope without a remote fetch or Show mutation', () => {
  const review = handlerSource('community:servicePlans:review');
  const imported = handlerSource('community:servicePlans:import');

  assert.match(review, /context\.client\.getServicePlan/);
  assert.match(review, /communityServicePlanReviewResponse/);
  assert.match(imported, /request\.confirmed !== true/);
  assert.match(imported, /requireCommunityServicePlanReview/);
  assert.match(imported, /\.importPlan\(review\.envelope, review\.options\)/);
  assert.match(imported, /refreshCapabilities: false/);
  assert.doesNotMatch(imported, /\.getServicePlan\(/);
  assert.doesNotMatch(imported, /\.listServicePlans\(/);
  assert.doesNotMatch(imported, /currentShowPackage|appState|startShow|publish/);
});

test('renderer opens the local Planning project only after confirmed import succeeds', () => {
  const start = controllerSource.indexOf(
    'async function importReviewedCommunityServicePlan()'
  );
  const end = controllerSource.indexOf(
    '\n    function renderProjectList()',
    start
  );
  assert.notEqual(start, -1);
  assert.notEqual(end, -1);
  const source = controllerSource.slice(start, end);
  const invokeAt = source.indexOf('api.importReviewedCommunityServicePlan');
  const openAt = source.indexOf('await openProject(projectId');
  assert.ok(invokeAt >= 0);
  assert.ok(openAt > invokeAt);
  assert.match(source, /confirmed: true/);
  assert.match(source, /Load and Show were not changed/);
});

test('confirmed replacement re-fetches, re-reviews, and CAS-saves only the same Planning project', () => {
  const replaced = handlerSource('community:servicePlans:replace');

  assert.match(replaced, /request\.confirmed !== true/);
  assert.match(replaced, /requireCommunityServicePlanReplacement/);
  assert.match(replaced, /context\.client\.getServicePlan/);
  assert.match(replaced, /sameCommunityServicePlanEnvelope/);
  assert.match(replaced, /coordinator\.review/);
  assert.match(
    replaced,
    /communityServicePlanReplacementProposalKey\(proposal\)/
  );
  assert.match(replaced, /\.replacePlanRevision\(/);
  assert.match(replaced, /expectedRevisionId:\s*replacement\.localRevisionId/);
  assert.match(replaced, /communityServicePlanReplacements\.delete\(token\)/);
  assert.doesNotMatch(
    replaced,
    /currentShowPackage|appState|startShow|publish|activateCurrentPreparedService|deactivateCurrentPreparedService/
  );
});

test('renderer reconciles only after every ordered choice and confirmation, then reopens Planning', () => {
  const start = controllerSource.indexOf(
    'async function replaceReviewedCommunityServicePlan()'
  );
  const end = controllerSource.indexOf(
    '\n    async function applyReviewedCommunityServicePlan()',
    start
  );
  assert.notEqual(start, -1);
  assert.ok(end > start);
  const source = controllerSource.slice(start, end);
  const invokeAt = source.indexOf('api.replaceReviewedCommunityServicePlan');
  const openAt = source.indexOf('await openProject(projectId');
  assert.ok(invokeAt >= 0);
  assert.ok(openAt > invokeAt);
  assert.match(source, /replacementToken:\s*review\.replacementToken/);
  assert.match(source, /confirmed:\s*true/);
  assert.match(source, /decisions/);
  assert.match(
    source,
    /reviewedCommunityPlanReconciliationDecisions\(review\)/
  );
  assert.match(source, /prior local revision remains in history/);
  assert.match(source, /Load and Show were not changed/);
  assert.doesNotMatch(
    source,
    /publish|startShow|activateCurrentPreparedService|deactivateCurrentPreparedService/
  );
});

test('successful replacement consumes its exact authority and replay fails closed', async () => {
  const fixture = loadReplacementHandler();
  const unconfirmed = await fixture.handler(
    { trusted: true },
    { replacementToken: fixture.token, confirmed: false }
  );
  assert.equal(unconfirmed.success, false);
  assert.equal(
    unconfirmed.error.code,
    'SERVICE_PLAN_REPLACEMENT_CONFIRMATION_REQUIRED'
  );
  assert.equal(fixture.replacements.has(fixture.token), true);
  assert.equal(fixture.replacementsApplied(), 0);

  const first = await fixture.handler(
    { trusted: true },
    {
      replacementToken: fixture.token,
      confirmed: true,
      decisions: fixture.decisions
    }
  );
  assert.equal(first.success, true);
  assert.equal(first.data.replacementStatus, 'reconciled');
  assert.equal(first.data.previousRevisionId, 'b'.repeat(64));
  assert.equal(fixture.replacements.has(fixture.token), false);
  assert.equal(fixture.replacementsApplied(), 1);

  const replay = await fixture.handler(
    { trusted: true },
    {
      replacementToken: fixture.token,
      confirmed: true,
      decisions: fixture.decisions
    }
  );
  assert.equal(replay.success, false);
  assert.equal(replay.error.code, 'EXPIRED_SERVICE_PLAN_REPLACEMENT');
  assert.equal(fixture.replacementsApplied(), 1);
});

test('replacement authority is consumed when its remote, local, connection, profile, or candidate binding is stale', async () => {
  for (const [options, expectedCode] of [
    [{ remoteChanged: true }, 'STALE_SERVICE_PLAN_REPLACEMENT'],
    [{ remoteStatus: 'draft' }, 'SERVICE_PLAN_REPLACEMENT_NOT_READY'],
    [{ blocked: true }, 'SERVICE_PLAN_REPLACEMENT_BLOCKED'],
    [{ localChanged: true }, 'LOCAL_PROJECT_CHANGED'],
    [{ proposalChanged: true }, 'STALE_SERVICE_PLAN_REPLACEMENT'],
    [
      { connectionChanged: true },
      'SERVICE_PLAN_REPLACEMENT_CONNECTION_CHANGED'
    ],
    [
      { profileChanged: true },
      'SERVICE_PLAN_REPLACEMENT_PROFILE_CHANGED'
    ]
  ]) {
    const fixture = loadReplacementHandler(options);
    const result = await fixture.handler(
      { trusted: true },
      {
        replacementToken: fixture.token,
        confirmed: true,
        decisions: fixture.decisions
      }
    );
    assert.equal(result.success, false, JSON.stringify(options));
    assert.equal(result.error.code, expectedCode, JSON.stringify(options));
    assert.equal(fixture.replacements.has(fixture.token), false);
    assert.equal(fixture.replacementsApplied(), 0);
  }
});

test('successful import consumes its human review and replay fails closed', async () => {
  const fixture = loadImportHandler();
  const first = await fixture.handler(
    { trusted: true },
    { reviewToken: fixture.token, confirmed: true }
  );
  assert.equal(first.success, true);
  assert.equal(first.data.importStatus, 'imported');
  assert.equal(fixture.reviews.has(fixture.token), false);

  const replay = await fixture.handler(
    { trusted: true },
    { reviewToken: fixture.token, confirmed: true }
  );
  assert.equal(replay.success, false);
  assert.equal(replay.error.code, 'EXPIRED_SERVICE_PLAN_REVIEW');
  assert.equal(fixture.attempts(), 1);
});

test('transient failed import retains the exact review for one safe retry', async () => {
  const fixture = loadImportHandler({ failImports: 1 });
  const failed = await fixture.handler(
    { trusted: true },
    { reviewToken: fixture.token, confirmed: true }
  );
  assert.equal(failed.success, false);
  assert.equal(failed.error.code, 'TRANSIENT_IMPORT_FAILURE');
  assert.equal(fixture.reviews.has(fixture.token), true);

  const retried = await fixture.handler(
    { trusted: true },
    { reviewToken: fixture.token, confirmed: true }
  );
  assert.equal(retried.success, true);
  assert.equal(fixture.reviews.has(fixture.token), false);
  assert.equal(fixture.attempts(), 2);
});

test('plan-item preparation is one explicit read-only action followed by a fresh review', () => {
  const prepared = handlerSource('community:servicePlans:prepare');
  assert.match(prepared, /request\.confirmed !== true/);
  assert.match(prepared, /requireCommunityServicePlanPreparation/);
  assert.match(prepared, /requireCommunityServicePlanPreparationScopes/);
  assert.match(prepared, /\.pullSong\(dependency\.syncId/);
  assert.match(prepared, /\.pullSermon\(dependency\.syncId/);
  assert.equal((prepared.match(/\.getServicePlan\(/g) || []).length, 2);
  assert.match(prepared, /communityServicePlanReviewResponse/);
  assert.match(prepared, /REMOTE_PRECONDITION_FAILED/);
  assert.match(prepared, /remainingDependencies/);
  assert.match(prepared, /rememberCommunityServicePlanStalePin/);
  assert.doesNotMatch(
    prepared,
    /\.importPlan\(|projectResult|currentShowPackage|startShow|publish/
  );

  const start = controllerSource.indexOf(
    'async function prepareReviewedCommunityServicePlan()'
  );
  const end = controllerSource.indexOf(
    '\n    async function importReviewedCommunityServicePlan()',
    start
  );
  assert.ok(start >= 0 && end > start);
  const rendererAction = controllerSource.slice(start, end);
  assert.match(rendererAction, /api\.prepareCommunityServicePlan/);
  assert.match(rendererAction, /confirmed: true/);
  assert.match(rendererAction, /normalizeReview/);
  assert.doesNotMatch(
    rendererAction,
    /importReviewedCommunityServicePlan|openProject|loadProjects|publish/
  );

  const cancelled = handlerSource(
    'community:servicePlans:prepareCancel'
  );
  assert.match(cancelled, /active\.controller\.abort\(\)/);
  assert.doesNotMatch(
    cancelled,
    /\.importPlan\(|projectResult|currentShowPackage|startShow|publish/
  );
  assert.match(
    controllerSource,
    /cancelCommunityServicePlanPreparation/
  );
});

test('main prepares dependencies sequentially and turns stale pins into a non-retrying fresh review', async () => {
  for (const songPreconditionFailure of [false, true]) {
    const fixture = loadPreparationHandler({ songPreconditionFailure });
    const result = await fixture.handler(
      { trusted: true },
      {
        preparationToken: fixture.token,
        confirmed: true
      }
    );
    assert.equal(result.success, true);
    assert.equal(result.data.fresh, true);
    assert.equal(
      result.data.proposalStatus,
      songPreconditionFailure ? 'blocked' : 'ready-to-import'
    );
    assert.deepEqual(
      fixture.events,
      songPreconditionFailure
        ? [
            'plan-1',
            'song',
            'stale-pin',
            'sermon',
            'plan-2',
            'status',
            'fresh-review'
          ]
        : [
            'plan-1',
            'song',
            'sermon',
            'plan-2',
            'status',
            'fresh-review'
          ]
    );
    assert.equal(fixture.preparations.has(fixture.token), false);
  }
});

test('a live point-read pin mismatch remains a non-preparable stale-plan review for that exact plan', () => {
  const helpers = loadStalePinHelpers();
  const context = {
    connection: {
      id: 'connection-1',
      serverId: 'wotbc-community'
    }
  };
  const envelope = {
    syncId: 'plan-2026-08-02',
    syncVersion: 4,
    revision: 'a'.repeat(64)
  };
  const dependency = {
    kind: 'song',
    syncId: 'song-family-grace',
    expectedSyncVersion: 7,
    expectedRevision: 'song:song-family-grace:7',
    entryIds: ['song-grace'],
    blockerCodes: ['LOCAL_SONG_MISSING']
  };
  helpers.rememberCommunityServicePlanStalePin({
    context,
    envelope,
    dependency
  });
  const observations = helpers.knownCommunityServicePlanStalePins(
    context,
    envelope
  );
  assert.equal(observations.length, 1);
  const transformed = helpers.applyCommunityServicePlanStalePins({
    proposal: {
      status: 'blocked',
      projectId: 'community-plan-local',
      planId: envelope.syncId,
      planRevision: envelope.revision,
      remoteStatus: 'ready',
      blockerCount: 1,
      blockersTruncated: false,
      blockers: [{
        entryId: 'song-grace',
        kind: 'song',
        code: 'LOCAL_SONG_MISSING',
        message: 'The exact song is not local.'
      }],
      diff: null,
      existingProject: false
    },
    preparationDependencies: [dependency]
  }, observations);
  assert.equal(transformed.proposal.status, 'blocked');
  assert.equal(
    transformed.proposal.blockers[0].code,
    'SERVICE_PLAN_SONG_PIN_STALE'
  );
  assert.match(
    transformed.proposal.blockers[0].message,
    /return the plan to Draft/
  );
  assert.deepEqual(
    plain(transformed.preparationDependencies),
    []
  );
  assert.equal(
    helpers.knownCommunityServicePlanStalePins(context, {
      ...envelope,
      revision: 'b'.repeat(64)
    }).length,
    0,
    'a changed exact plan revision does not inherit stale-pin evidence'
  );
});

test('preparation cancellation is token-bound and aborts only the active point-read sequence', async () => {
  const handlers = new Map();
  let aborts = 0;
  const token = '223e4567-e89b-42d3-a456-426614174000';
  vm.runInNewContext(handlerSource(
    'community:servicePlans:prepareCancel'
  ), {
    activeCommunityServicePlanPreparation: {
      token,
      controller: {
        abort() {
          aborts += 1;
        }
      }
    },
    communityIpcResult: async operation => {
      try {
        return { success: true, data: await operation() };
      } catch (error) {
        return {
          success: false,
          error: { code: error.code, message: error.message }
        };
      }
    },
    communityRequestKeys() {},
    communityText: value => String(value || ''),
    failMainOperation(code, message) {
      const error = new Error(message);
      error.code = code;
      throw error;
    },
    ipcMain: {
      handle(channel, callback) {
        handlers.set(channel, callback);
      }
    },
    requireControlSender() {}
  });
  const cancel = handlers.get(
    'community:servicePlans:prepareCancel'
  );
  const wrong = await cancel(
    { trusted: true },
    {
      preparationToken:
        '323e4567-e89b-42d3-a456-426614174000'
    }
  );
  assert.equal(wrong.success, true);
  assert.equal(wrong.data.cancelled, false);
  assert.equal(aborts, 0);
  const matched = await cancel(
    { trusted: true },
    { preparationToken: token }
  );
  assert.equal(matched.success, true);
  assert.equal(matched.data.cancelled, true);
  assert.equal(aborts, 1);
});

test('a changed plan is re-reviewed before pulls and an offline partial retry retains authority', async () => {
  const changed = loadPreparationHandler({ planChangedBefore: true });
  const changedResult = await changed.handler(
    { trusted: true },
    {
      preparationToken: changed.token,
      confirmed: true
    }
  );
  assert.equal(changedResult.success, true);
  assert.equal(changedResult.data.planRevision, 'c'.repeat(64));
  assert.deepEqual(changed.events, ['plan-1', 'fresh-review']);
  assert.equal(changed.preparations.has(changed.token), false);

  const offline = loadPreparationHandler({ sermonOffline: true });
  const offlineResult = await offline.handler(
    { trusted: true },
    {
      preparationToken: offline.token,
      confirmed: true
    }
  );
  assert.equal(offlineResult.success, false);
  assert.equal(
    offlineResult.error.code,
    'COMMUNITY_SERVICE_PLAN_PREPARATION_OFFLINE'
  );
  assert.deepEqual(offline.events, ['plan-1', 'song', 'sermon']);
  assert.equal(
    offline.preparations.has(offline.token),
    true,
    'successfully checkpointed exact pulls can be retried idempotently'
  );
  const retriedOffline = await offline.handler(
    { trusted: true },
    {
      preparationToken: offline.token,
      confirmed: true
    }
  );
  assert.equal(retriedOffline.success, true);
  assert.equal(retriedOffline.data.proposalStatus, 'ready-to-import');
  assert.deepEqual(offline.events, [
    'plan-1',
    'song',
    'sermon',
    'plan-2',
    'sermon',
    'plan-3',
    'status',
    'fresh-review'
  ]);
  assert.equal(offline.preparations.has(offline.token), false);

  const localChanged = loadPreparationHandler({
    dependencyChangedBefore: true
  });
  const localChangedResult = await localChanged.handler(
    { trusted: true },
    {
      preparationToken: localChanged.token,
      confirmed: true
    }
  );
  assert.equal(localChangedResult.success, true);
  assert.deepEqual(localChanged.events, ['plan-1', 'fresh-review']);
  assert.equal(localChanged.preparations.has(localChanged.token), false);

  const missingScope = loadPreparationHandler({ missingScope: true });
  const missingScopeResult = await missingScope.handler(
    { trusted: true },
    {
      preparationToken: missingScope.token,
      confirmed: true
    }
  );
  assert.equal(missingScopeResult.success, false);
  assert.equal(
    missingScopeResult.error.code,
    'COMMUNITY_SERVICE_PLAN_ITEMS_RECONNECT_REQUIRED'
  );
  assert.deepEqual(missingScope.events, ['plan-1']);
  assert.equal(missingScope.preparations.has(missingScope.token), true);
});

test('renderer accepts only bounded preparation authority on a blocked Ready plan', () => {
  const contracts = reviewContracts();
  const normalized = contracts.normalizeReview(preparableReview());
  assert.equal(normalized.preparation.itemCount, 2);
  assert.equal(normalized.preparation.songCount, 1);
  assert.ok(Object.isFrozen(normalized.preparation));

  for (const invalid of [
    {
      preparation: {
        ...preparableReview().preparation,
        token: 'not-a-main-token'
      }
    },
    {
      preparation: {
        ...preparableReview().preparation,
        itemCount: 3
      }
    },
    {
      preparation: {
        ...preparableReview().preparation,
        unsupported: true
      }
    },
    {
      proposal: {
        ...preparableReview().proposal,
        blockersTruncated: true,
        blockerCount: 3
      }
    },
    {
      proposal: {
        ...preparableReview().proposal,
        blockers: preparableReview().proposal.blockers.map(
          (blocker, index) => index === 0
            ? { ...blocker, code: 'LOCAL_SONG_CONFLICT' }
            : blocker
        )
      }
    },
    {
      preparation: {
        ...preparableReview().preparation,
        songCount: 2,
        sermonCount: 0
      }
    },
    {
      proposal: readyReview().proposal,
      reviewToken: readyReview().reviewToken,
      reviewExpiresAt: readyReview().reviewExpiresAt
    }
  ]) {
    assert.throws(
      () => contracts.normalizeReview({
        ...preparableReview(),
        ...invalid
      }),
      /invalid service-plan preparation token|inconsistent service-plan preparation authority|unsupported service-plan item preparation details/
    );
  }
});

test('renderer accepts replacement authority only for one existing newer Ready revision', () => {
  const contracts = reviewContracts();
  const normalized = contracts.normalizeReview(newerRevisionReview());
  assert.equal(normalized.proposal.status, 'newer-revision');
  assert.equal(
    normalized.replacementToken,
    newerRevisionReview().replacementToken
  );
  assert.equal(normalized.reviewToken, null);
  assert.ok(Object.isFrozen(normalized));

  for (const invalid of [
    { replacementToken: null, replacementExpiresAt: null },
    { reviewToken: readyReview().reviewToken },
    { reviewExpiresAt: readyReview().reviewExpiresAt },
    {
      proposal: {
        ...newerRevisionReview().proposal,
        status: 'already-imported',
        diff: null
      }
    },
    {
      servicePlan: {
        ...newerRevisionReview().servicePlan,
        status: 'draft'
      }
    }
  ]) {
    assert.throws(
      () => contracts.normalizeReview({
        ...newerRevisionReview(),
        ...invalid
      }),
      /inconsistent review authority|inconsistent import proposal|reconciliation details/
    );
  }
});

test('renderer strictly normalizes three-way, legacy, and fail-closed reconciliation reviews', () => {
  const contracts = reviewContracts();
  assert.match(reviewContractSource, /value\.containers\.length > 501/);
  const normalized = contracts.normalizeReview(newerRevisionReview());
  assert.equal(normalized.proposal.reconciliation.mode, 'three-way');
  assert.equal(normalized.proposal.reconciliation.conflictCount, 1);
  assert.equal(
    normalized.proposal.reconciliation.conflicts[0].local.choice,
    'keep-local'
  );
  assert.ok(Object.isFrozen(normalized.proposal.reconciliation));
  assert.ok(Object.isFrozen(
    normalized.proposal.reconciliation.conflicts[0].community
  ));

  const legacyBase = newerRevisionReview();
  const legacy = contracts.normalizeReview({
    ...legacyBase,
    proposal: {
      ...legacyBase.proposal,
      reconciliation: legacyReconciliation()
    }
  });
  assert.equal(
    legacy.proposal.reconciliation.mode,
    'legacy-full-replace'
  );
  assert.equal(legacy.replacementToken, legacyBase.replacementToken);

  const unavailableBase = newerRevisionReview();
  const unavailable = contracts.normalizeReview({
    ...unavailableBase,
    proposal: {
      ...unavailableBase.proposal,
      reconciliation: threeWayReconciliation({
        applicable: false,
        mergeResultSha256: null,
        conflictCount: 2,
        conflictsTruncated: true
      })
    },
    replacementToken: null,
    replacementExpiresAt: null
  });
  assert.equal(unavailable.proposal.reconciliation.applicable, false);
  assert.equal(unavailable.proposal.reconciliation.conflictsTruncated, true);
  assert.equal(unavailable.replacementToken, null);

  const conflict = threeWayReconciliation().conflicts[0];
  for (const reconciliation of [
    { ...threeWayReconciliation(), unsupported: true },
    {
      ...threeWayReconciliation(),
      candidatePlanRevision: '9'.repeat(64)
    },
    {
      ...threeWayReconciliation(),
      conflictCount: 0
    },
    {
      ...threeWayReconciliation(),
      conflictCount: 2,
      conflicts: [conflict, { ...conflict, title: 'Duplicate identity' }]
    },
    {
      ...threeWayReconciliation(),
      conflicts: [{
        ...conflict,
        local: {
          ...conflict.local,
          choice: 'use-community'
        }
      }]
    },
    {
      ...threeWayReconciliation(),
      applicable: true,
      conflictsTruncated: true,
      conflictCount: 2
    },
    {
      ...legacyReconciliation(),
      preservedLocalItemCount: 1
    }
  ]) {
    const base = newerRevisionReview();
    assert.throws(
      () => contracts.normalizeReview({
        ...base,
        proposal: {
          ...base.proposal,
          reconciliation
        }
      }),
      /reconciliation/
    );
  }
});

test('renderer validates exact bounded list and review projections before use', () => {
  const contracts = reviewContracts();
  const normalized = contracts.normalizeReview(readyReview());
  assert.equal(normalized.proposal.status, 'ready-to-import');
  assert.equal(normalized.servicePlan.plan.entries.length, 1);
  assert.ok(Object.isFrozen(normalized));
  const importedProject = {
    schemaVersion: 1,
    kind: 'syncshow-service-project',
    id: 'community-plan-local',
    title: 'Sunday Service',
    serviceDate: '2026-08-02',
    preferredProfileId: 'main',
    channelIds: ['primary'],
    channels: { primary: { id: 'primary' } },
    rootItemIds: [],
    items: {},
    resources: {},
    assets: {},
    presetPack: { id: 'main', version: 1, sha256: null },
    planning: {
      schemaVersion: 3,
      status: 'planning',
      startTime: '10:30',
      teamNotes: 'Review the sermon reading.',
      source: {
        kind: 'community-plan',
        serverId: 'wotbc-community',
        planId: 'plan-2026-08-02',
        planRevision: 'a'.repeat(64),
        importedAt: '2026-07-28T12:01:00.000Z'
      },
      reconciliationBaseline: projectReconciliationBaseline()
    },
    revision: 1,
    createdAt: '2026-07-28T12:01:00.000Z',
    updatedAt: '2026-07-28T12:01:00.000Z'
  };
  const imported = contracts.normalizeImportResult({
    project: importedProject,
    revisionId: 'b'.repeat(64),
    unchanged: false,
    recovery: null,
    readiness: {},
    importStatus: 'imported'
  }, normalized);
  assert.equal(imported.project.id, 'community-plan-local');
  assert.equal(
    importedProject.planning.reconciliationBaseline.schemaVersion,
    2
  );
  const boundaryBaseline = projectReconciliationBoundaryBaseline();
  assert.equal(boundaryBaseline.containers.length, 501);
  assert.equal(
    contracts.normalizeImportResult({
      project: {
        ...importedProject,
        planning: {
          ...importedProject.planning,
          reconciliationBaseline: boundaryBaseline
        }
      },
      revisionId: 'b'.repeat(64),
      unchanged: false,
      recovery: null,
      readiness: {},
      importStatus: 'imported'
    }, normalized).importStatus,
    'imported'
  );
  const tooManyContainers = plain(boundaryBaseline);
  tooManyContainers.containers.push({
    parentItemId: null,
    childItemIds: []
  });
  assert.throws(
    () => contracts.normalizeImportResult({
      project: {
        ...importedProject,
        planning: {
          ...importedProject.planning,
          reconciliationBaseline: tooManyContainers
        }
      },
      revisionId: 'b'.repeat(64),
      unchanged: false,
      recovery: null,
      readiness: {},
      importStatus: 'imported'
    }, normalized),
    /baseline/
  );

  const legacyBaseline = projectReconciliationBaseline(
    'a'.repeat(64),
    { schemaVersion: 1 }
  );
  assert.throws(
    () => contracts.normalizeImportResult({
      project: {
        ...importedProject,
        planning: {
          ...importedProject.planning,
          reconciliationBaseline: legacyBaseline
        }
      },
      revisionId: 'b'.repeat(64),
      unchanged: false,
      recovery: null,
      readiness: {},
      importStatus: 'imported'
    }, normalized),
    /baseline/
  );

  const missingV2Hash = plain(projectReconciliationBaseline());
  delete missingV2Hash.entries[0].titleSha256;
  const v1WithV2Field = plain(legacyBaseline);
  v1WithV2Field.entries[0].contentSpecSha256 = '4'.repeat(64);
  for (const invalidBaseline of [
    missingV2Hash,
    v1WithV2Field,
    {
      ...projectReconciliationBaseline(),
      metadata: {
        ...projectReconciliationBaseline().metadata,
        unsupported: true
      }
    }
  ]) {
    assert.throws(
      () => contracts.normalizeImportResult({
        project: {
          ...importedProject,
          planning: {
            ...importedProject.planning,
            reconciliationBaseline: invalidBaseline
          }
        },
        revisionId: 'b'.repeat(64),
        unchanged: false,
        recovery: null,
        readiness: {},
        importStatus: 'imported'
      }, normalized),
      /baseline/
    );
  }

  const replacementReview = contracts.normalizeReview(
    newerRevisionReview()
  );
  const replacementDecisions =
    projectReconciliationReceipt().decisions;
  const collisionBoundaryItemId =
    'community-item-collision-boundary';
  const replaced = contracts.normalizeReplacementResult({
    project: {
      ...importedProject,
      items: {
        [collisionBoundaryItemId]: {}
      },
      planning: {
        ...importedProject.planning,
        localCollisionBoundaryItemIds: [collisionBoundaryItemId],
        lastReconciliationReceipt: projectReconciliationReceipt()
      }
    },
    revisionId: 'd'.repeat(64),
    unchanged: false,
    recovery: null,
    readiness: {},
    replacementStatus: 'reconciled',
    previousRevisionId: replacementReview.proposal.revisionId
  }, replacementReview, replacementDecisions);
  assert.equal(replaced.project.id, 'community-plan-local');
  assert.equal(
    replaced.previousRevisionId,
    replacementReview.proposal.revisionId
  );
  assert.equal(replaced.replacementStatus, 'reconciled');
  for (const localCollisionBoundaryItemIds of [
    [collisionBoundaryItemId, collisionBoundaryItemId],
    ['community-item-z', 'community-item-a'],
    ['community-item-missing']
  ]) {
    assert.throws(
      () => contracts.normalizeReplacementResult({
        project: {
          ...importedProject,
          items: {
            [collisionBoundaryItemId]: {},
            'community-item-a': {},
            'community-item-z': {}
          },
          planning: {
            ...importedProject.planning,
            localCollisionBoundaryItemIds,
            lastReconciliationReceipt:
              projectReconciliationReceipt()
          }
        },
        revisionId: 'd'.repeat(64),
        unchanged: false,
        recovery: null,
        readiness: {},
        replacementStatus: 'reconciled',
        previousRevisionId:
          replacementReview.proposal.revisionId
      }, replacementReview, replacementDecisions),
      /collision boundaries/
    );
  }

  const legacyReviewBase = newerRevisionReview();
  const legacyReview = contracts.normalizeReview({
    ...legacyReviewBase,
    proposal: {
      ...legacyReviewBase.proposal,
      reconciliation: legacyReconciliation()
    }
  });
  const legacyReplacementDecisions = projectReconciliationReceipt({
    mode: 'legacy-full-replace'
  }).decisions;
  const legacyReplaced = contracts.normalizeReplacementResult({
    project: {
      ...importedProject,
      planning: {
        ...importedProject.planning,
        lastReconciliationReceipt: projectReconciliationReceipt({
          mode: 'legacy-full-replace'
        })
      }
    },
    revisionId: '4'.repeat(64),
    unchanged: false,
    recovery: null,
    readiness: {},
    replacementStatus: 'replaced',
    previousRevisionId: legacyReview.proposal.revisionId
  }, legacyReview, legacyReplacementDecisions);
  assert.equal(legacyReplaced.replacementStatus, 'replaced');

  assert.throws(
    () => contracts.normalizeReplacementResult({
      project: importedProject,
      revisionId: 'd'.repeat(64),
      unchanged: false,
      recovery: null,
      readiness: {},
      replacementStatus: 'reconciled',
      previousRevisionId: replacementReview.proposal.revisionId
    }, replacementReview, replacementDecisions),
    /reconciliation (?:result|receipt)/
  );
  assert.throws(
    () => contracts.normalizeReplacementResult({
      project: {
        ...importedProject,
        planning: {
          ...importedProject.planning,
          lastReconciliationReceipt: projectReconciliationReceipt({
            previousLocalRevisionId: '7'.repeat(64)
          })
        }
      },
      revisionId: 'd'.repeat(64),
      unchanged: false,
      recovery: null,
      readiness: {},
      replacementStatus: 'reconciled',
      previousRevisionId: replacementReview.proposal.revisionId
    }, replacementReview, replacementDecisions),
    /reconciliation (?:result|receipt)/
  );
  assert.throws(
    () => contracts.normalizeReplacementResult({
      project: {
        ...importedProject,
        planning: {
          ...importedProject.planning,
          lastReconciliationReceipt: projectReconciliationReceipt({
            overrides: {
              conflictCount: 2
            }
          })
        }
      },
      revisionId: 'd'.repeat(64),
      unchanged: false,
      recovery: null,
      readiness: {},
      replacementStatus: 'reconciled',
      previousRevisionId: replacementReview.proposal.revisionId
    }, replacementReview, replacementDecisions),
    /reconciliation receipt/
  );
  const badChecksumReceipt = projectReconciliationReceipt();
  badChecksumReceipt.receiptSha256 = '0'.repeat(64);
  assert.throws(
    () => contracts.normalizeReplacementResult({
      project: {
        ...importedProject,
        planning: {
          ...importedProject.planning,
          lastReconciliationReceipt: badChecksumReceipt
        }
      },
      revisionId: 'd'.repeat(64),
      unchanged: false,
      recovery: null,
      readiness: {},
      replacementStatus: 'reconciled',
      previousRevisionId: replacementReview.proposal.revisionId
    }, replacementReview, replacementDecisions),
    /invalid checksum/
  );
  const differentDecisionReceipt = projectReconciliationReceipt({
    overrides: {
      decisions: [{
        conflictId: 'reconcile-gathering',
        choice: 'use-community'
      }]
    }
  });
  assert.throws(
    () => contracts.normalizeReplacementResult({
      project: {
        ...importedProject,
        planning: {
          ...importedProject.planning,
          lastReconciliationReceipt: differentDecisionReceipt
        }
      },
      revisionId: 'd'.repeat(64),
      unchanged: false,
      recovery: null,
      readiness: {},
      replacementStatus: 'reconciled',
      previousRevisionId: replacementReview.proposal.revisionId
    }, replacementReview, replacementDecisions),
    /unbound service-plan reconciliation receipt/
  );

  const alreadyBase = readyReview();
  const alreadyReview = contracts.normalizeReview({
    ...alreadyBase,
    proposal: {
      ...alreadyBase.proposal,
      status: 'already-imported',
      existingProject: true,
      revisionId: 'b'.repeat(64)
    }
  });
  const legacyPlanningProject = {
    ...importedProject,
    planning: {
      schemaVersion: 2,
      status: importedProject.planning.status,
      startTime: importedProject.planning.startTime,
      teamNotes: importedProject.planning.teamNotes,
      source: importedProject.planning.source
    }
  };
  const alreadyImported = contracts.normalizeImportResult({
    project: legacyPlanningProject,
    revisionId: 'b'.repeat(64),
    unchanged: true,
    recovery: null,
    readiness: {},
    importStatus: 'already-imported'
  }, alreadyReview);
  assert.equal(alreadyImported.importStatus, 'already-imported');

  assert.throws(
    () => contracts.normalizeImportResult({
      project: {
        ...legacyPlanningProject,
        planning: {
          ...legacyPlanningProject.planning,
          lastReconciliationReceipt: projectReconciliationReceipt()
        }
      },
      revisionId: 'b'.repeat(64),
      unchanged: true,
      recovery: null,
      readiness: {},
      importStatus: 'already-imported'
    }, alreadyReview),
    /reconciliation metadata/
  );

  const alreadyImportedWithV1Baseline = contracts.normalizeImportResult({
    project: {
      ...importedProject,
      planning: {
        ...importedProject.planning,
        reconciliationBaseline: legacyBaseline
      }
    },
    revisionId: 'b'.repeat(64),
    unchanged: true,
    recovery: null,
    readiness: {},
    importStatus: 'already-imported'
  }, alreadyReview);
  assert.equal(
    alreadyImportedWithV1Baseline.importStatus,
    'already-imported'
  );
  assert.throws(
    () => contracts.normalizeImportResult({
      project: {
        ...importedProject,
        planning: {
          ...importedProject.planning,
          reconciliationBaseline: v1WithV2Field
        }
      },
      revisionId: 'b'.repeat(64),
      unchanged: true,
      recovery: null,
      readiness: {},
      importStatus: 'already-imported'
    }, alreadyReview),
    /baseline entry/
  );

  assert.throws(
    () => contracts.normalizeReplacementResult({
      project: importedProject,
      revisionId: 'd'.repeat(64),
      unchanged: false,
      recovery: null,
      readiness: {},
      replacementStatus: 'reconciled',
      previousRevisionId: 'e'.repeat(64)
    }, replacementReview, replacementDecisions),
    /invalid service-plan reconciliation result/
  );

  assert.throws(
    () => contracts.normalizeImportResult({
      project: {
        ...importedProject,
        planning: {
          ...importedProject.planning,
          source: {
            ...importedProject.planning.source,
            planRevision: 'c'.repeat(64)
          },
          reconciliationBaseline: projectReconciliationBaseline(
            'c'.repeat(64)
          )
        }
      },
      revisionId: 'b'.repeat(64),
      unchanged: false,
      recovery: null,
      readiness: {},
      importStatus: 'imported'
    }, normalized),
    /different Community revision/
  );

  const page = contracts.normalizePage({
    connection: readyReview().connection,
    items: [{
      syncId: 'plan-2026-08-02',
      syncVersion: 4,
      revision: 'a'.repeat(64),
      status: 'ready',
      title: 'Sunday Service',
      serviceDate: '2026-08-02',
      startTime: '10:30',
      changedAt: '2026-07-28T12:00:00.000Z'
    }],
    nextCursor: null,
    hasMore: false
  });
  assert.equal(page.items.length, 1);

  assert.throws(
    () => contracts.normalizeReview({
      ...readyReview(),
      rendererOwnedAuthority: true
    }),
    /unsupported Community service-plan review details/
  );
  assert.throws(
    () => contracts.normalizeReview({
      ...readyReview(),
      reviewToken: 'A'.repeat(32)
    }),
    /invalid service-plan review token/
  );
  assert.throws(
    () => contracts.normalizePage({
      connection: readyReview().connection,
      items: [],
      nextCursor: 'cursor-without-more',
      hasMore: false
    }),
    /inconsistent service-plan cursor/
  );
});

test('renderer preserves an exact v2 Scripture-to-sermon relationship for review', () => {
  const contracts = reviewContracts();
  const base = readyReview();
  const normalized = contracts.normalizeReview({
    ...base,
    servicePlan: {
      ...base.servicePlan,
      plan: {
        ...base.servicePlan.plan,
        schemaVersion: 2,
        entries: [{
          id: 'reading',
          kind: 'scripture',
          title: 'Ephesians 3:14–21',
          range: {
            schemaVersion: 1,
            bookId: 'Eph',
            start: { chapter: 3, verse: 14 },
            end: { chapter: 3, verse: 21 }
          },
          translationId: 'BSB',
          sermonReading: {
            sermonEntryId: 'sermon-prayer',
            referenceId: 'primary-eph-3'
          }
        }, {
          id: 'sermon-prayer',
          kind: 'sermon',
          title: 'Faithful Prayer',
          syncId: 'sermon-golden-v3',
          expectedRevision: 'b'.repeat(64),
          expectedSyncVersion: 4
        }]
      }
    }
  });
  assert.deepEqual(
    plain(normalized.servicePlan.plan.entries[0].sermonReading),
    {
      sermonEntryId: 'sermon-prayer',
      referenceId: 'primary-eph-3'
    }
  );

  const hostile = plain({
    ...base,
    servicePlan: {
      ...base.servicePlan,
      plan: {
        ...base.servicePlan.plan,
        schemaVersion: 2,
        entries: normalized.servicePlan.plan.entries
      }
    }
  });
  hostile.servicePlan.plan.entries[0].sermonReading.sermonEntryId = 'missing';
  assert.throws(
    () => contracts.normalizeReview(hostile),
    /invalid service-plan sermon reading/
  );

  const oversized = plain({
    ...base,
    servicePlan: {
      ...base.servicePlan,
      plan: {
        ...base.servicePlan.plan,
        schemaVersion: 2,
        entries: normalized.servicePlan.plan.entries
      }
    }
  });
  oversized.servicePlan.plan.entries[0].range.end.verse = 22;
  assert.throws(
    () => contracts.normalizeReview(oversized),
    /invalid service-plan sermon reading/
  );
});

test('36-character plan review authority is distinct from 32-character PowerPoint song-family review', () => {
  const planRequireStart = mainSource.indexOf(
    'function requireCommunityServicePlanReview'
  );
  const planRequireEnd = mainSource.indexOf(
    'async function currentCommunityConnectionSummary',
    planRequireStart
  );
  const planRequire = mainSource.slice(planRequireStart, planRequireEnd);
  assert.match(
    planRequire,
    /\{8\}-\[a-f0-9\]\{4\}-4\[a-f0-9\]\{3\}-\[89ab\]\[a-f0-9\]\{3\}-\[a-f0-9\]\{12\}/
  );
  assert.doesNotMatch(planRequire, /\{32\}/);
  assert.match(reviewContractSource, /REVIEW_TOKEN[\s\S]*\{12\}/);

  const familyStart = controllerSource.indexOf(
    'function normalizeCurrentServiceSongFamilyReview'
  );
  const familyEnd = controllerSource.indexOf(
    'function currentServiceSongFamilyLocalServiceRights',
    familyStart
  );
  const familyReview = controllerSource.slice(familyStart, familyEnd);
  assert.match(familyReview, /PowerPoint song-family review token/);
  assert.match(familyReview, /\{32\}/);
});
