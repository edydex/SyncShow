'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const mainPath = path.join(root, 'main.js');
const mainSource = fs.readFileSync(mainPath, 'utf8');

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function handlerSource(channel) {
  const marker = `ipcMain.handle('${channel}'`;
  const start = mainSource.indexOf(marker);
  assert.notEqual(start, -1, `${channel} must be implemented`);
  const next = mainSource.indexOf(
    "ipcMain.handle('",
    start + marker.length
  );
  return mainSource.slice(start, next === -1 ? mainSource.length : next);
}

const token = '223e4567-e89b-42d3-a456-426614174000';
const options = Object.freeze({ profileId: 'main' });
const envelope = Object.freeze({
  syncId: 'plan-2026-08-02',
  syncVersion: 4,
  revision: 'a'.repeat(64),
  status: 'ready',
  changedAt: '2026-07-28T12:00:00.000Z',
  documentSource: 'reviewed-plan'
});
const songDependency = Object.freeze({
  kind: 'song',
  syncId: 'song-family-grace',
  expectedSyncVersion: 7,
  expectedRevision: 'song:song-family-grace:7',
  entryIds: Object.freeze(['song-grace']),
  blockerCodes: Object.freeze(['LOCAL_SONG_MISSING'])
});
const sermonDependency = Object.freeze({
  kind: 'sermon',
  syncId: 'sermon-prayer',
  expectedSyncVersion: 4,
  expectedRevision: 'b'.repeat(64),
  entryIds: Object.freeze(['sermon-prayer']),
  blockerCodes: Object.freeze(['LOCAL_SERMON_MISSING'])
});
const originalDependencies = Object.freeze([
  songDependency,
  sermonDependency
]);

function operationResult(operation) {
  return Promise.resolve()
    .then(operation)
    .then(
      data => ({ success: true, data }),
      error => ({
        success: false,
        error: {
          code: error?.code || 'COMMUNITY_ERROR',
          message: error?.message || 'The Community operation failed.'
        }
      })
    );
}

function fail(code, message) {
  const error = new Error(message);
  error.code = code;
  throw error;
}

function loadRuntime({
  reviewVectors = [originalDependencies, []],
  serializeOperation = operation => operation(),
  onContext = null,
  onPlanRead = null,
  onSongPull = null,
  onSermonPull = null
} = {}) {
  const handlers = new Map();
  const preparations = new Map();
  const events = [];
  const planReads = [];
  const pullCalls = [];
  const freshReviews = [];
  let reviewIndex = 0;

  preparations.set(token, {
    connectionId: 'connection-1',
    serverId: 'wotbc-community',
    envelope,
    options,
    optionsKey: JSON.stringify(options),
    dependencies: originalDependencies,
    dependencyKey: JSON.stringify(originalDependencies),
    expiresAt: Date.now() + 60_000
  });

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
      async getServicePlan(request) {
        planReads.push(request);
        events.push(`plan-${planReads.length}`);
        if (onPlanRead) {
          return onPlanRead(request, planReads.length);
        }
        return envelope;
      }
    }
  };

  const sandbox = {
    AbortController,
    activeCommunityServicePlanPreparation: null,
    applyCommunityServicePlanStalePins: review => review,
    communityIpcResult: operationResult,
    communityOperationEpoch: 0,
    communityRequestKeys() {},
    communityServicePlanContext: async () => {
      events.push('context');
      if (onContext) return onContext(context);
      return context;
    },
    communityServicePlanCoordinator() {
      return {
        async review() {
          const dependencies =
            reviewVectors[Math.min(reviewIndex, reviewVectors.length - 1)];
          reviewIndex += 1;
          events.push(`review-${reviewIndex}`);
          return {
            proposal: {
              status: dependencies.length > 0
                ? 'blocked'
                : 'ready-to-import'
            },
            preparationDependencies: dependencies
          };
        }
      };
    },
    communityServicePlanDependencyKey: JSON.stringify,
    communityServicePlanImportOptions: () => options,
    communityServicePlanImportOptionsKey: JSON.stringify,
    communityServicePlanPreparations: preparations,
    communityServicePlanReviewResponse: async input => {
      freshReviews.push(input);
      events.push('fresh-review');
      return {
        fresh: true,
        proposalStatus: input.inspected.proposal.status
      };
    },
    communitySermonSyncForConnection: async () => ({
      async pullSermon(syncId, pullOptions) {
        const call = { kind: 'sermon', syncId, options: pullOptions };
        pullCalls.push(call);
        events.push('pull-sermon');
        if (onSermonPull) return onSermonPull(call);
        return { status: 'synced', pulled: 1 };
      }
    }),
    communitySyncAbortController: null,
    communitySyncForConnection: async () => ({
      async pullSong(syncId, pullOptions) {
        const call = { kind: 'song', syncId, options: pullOptions };
        pullCalls.push(call);
        events.push('pull-song');
        if (onSongPull) return onSongPull(call);
        return { status: 'synced', pulled: 1 };
      }
    }),
    communityText: value => String(value || ''),
    failMainOperation: fail,
    ipcMain: {
      handle(channel, callback) {
        handlers.set(channel, callback);
      }
    },
    knownCommunityServicePlanStalePins: () => [],
    notifyCommunityStatusChanged: async () => {
      events.push('status');
    },
    rememberCommunityServicePlanStalePin() {
      events.push('stale-pin');
    },
    requireCommunityReconnectFor: () => false,
    requireCommunityServicePlanPreparation(rawToken) {
      const preparation = preparations.get(rawToken);
      if (!preparation) {
        fail(
          'EXPIRED_SERVICE_PLAN_PREPARATION',
          'That preparation is no longer available.'
        );
      }
      return { token: rawToken, preparation };
    },
    requireCommunityServicePlanPreparationScopes() {
      events.push('scopes');
    },
    requireControlSender() {},
    sameCommunityServicePlanEnvelope: (left, right) =>
      left.syncId === right.syncId
      && left.syncVersion === right.syncVersion
      && left.revision === right.revision
      && left.status === right.status
      && left.changedAt === right.changedAt
      && left.documentSource === right.documentSource,
    serializeCommunityOperation: serializeOperation
  };

  const contextified = vm.createContext(sandbox);
  vm.runInContext(
    handlerSource('community:servicePlans:prepare'),
    contextified,
    { filename: mainPath }
  );
  vm.runInContext(
    handlerSource('community:servicePlans:prepareCancel'),
    contextified,
    { filename: mainPath }
  );

  return {
    cancel: handlers.get('community:servicePlans:prepareCancel'),
    context,
    events,
    freshReviews,
    planReads,
    prepare: handlers.get('community:servicePlans:prepare'),
    preparations,
    pullCalls,
    sandbox
  };
}

function prepareRequest() {
  return {
    preparationToken: token,
    confirmed: true
  };
}

test('an immediate stop is retained while preparation waits to enter the serialized operation', async () => {
  const enteredSerializer = deferred();
  const releaseSerializer = deferred();
  const fixture = loadRuntime({
    serializeOperation(operation) {
      fixture?.events.push('serialize-wait');
      enteredSerializer.resolve();
      return releaseSerializer.promise.then(operation);
    }
  });

  const preparing = fixture.prepare({ trusted: true }, prepareRequest());
  await enteredSerializer.promise;
  const cancelled = await fixture.cancel(
    { trusted: true },
    { preparationToken: token }
  );
  assert.equal(cancelled.success, true);
  assert.equal(cancelled.data.cancelled, true);

  releaseSerializer.resolve();
  const result = await preparing;
  assert.equal(result.success, false);
  assert.equal(result.error.code, 'COMMUNITY_OPERATION_CANCELLED');
  assert.deepEqual(fixture.events, ['serialize-wait']);
  assert.equal(fixture.planReads.length, 0);
  assert.equal(fixture.pullCalls.length, 0);
  assert.equal(fixture.freshReviews.length, 0);
  assert.equal(fixture.preparations.has(token), true);
  assert.equal(fixture.sandbox.activeCommunityServicePlanPreparation, null);
});

test('a stop during capability discovery wins over its eventual request failure', async () => {
  const contextStarted = deferred();
  const contextResult = deferred();
  const fixture = loadRuntime({
    onContext() {
      contextStarted.resolve();
      return contextResult.promise;
    }
  });

  const preparing = fixture.prepare({ trusted: true }, prepareRequest());
  await contextStarted.promise;
  const cancelled = await fixture.cancel(
    { trusted: true },
    { preparationToken: token }
  );
  assert.equal(cancelled.success, true);
  assert.equal(cancelled.data.cancelled, true);
  const networkError = new Error('discovery failed after cancellation');
  networkError.code = 'NETWORK_ERROR';
  contextResult.reject(networkError);

  const result = await preparing;
  assert.equal(result.success, false);
  assert.equal(result.error.code, 'COMMUNITY_OPERATION_CANCELLED');
  assert.equal(fixture.planReads.length, 0);
  assert.equal(fixture.pullCalls.length, 0);
  assert.equal(fixture.freshReviews.length, 0);
  assert.equal(fixture.preparations.has(token), true);
});

test('a stop during the initial exact plan read normalizes an abort and prevents local pulls', async () => {
  const planStarted = deferred();
  const fixture = loadRuntime({
    onPlanRead(request) {
      planStarted.resolve(request.signal);
      return new Promise((resolve, reject) => {
        const rejectAborted = () => {
          const error = new Error('aborted');
          error.name = 'AbortError';
          reject(error);
        };
        if (request.signal.aborted) {
          rejectAborted();
        } else {
          request.signal.addEventListener(
            'abort',
            rejectAborted,
            { once: true }
          );
        }
      });
    }
  });

  const preparing = fixture.prepare({ trusted: true }, prepareRequest());
  const signal = await planStarted.promise;
  const cancelled = await fixture.cancel(
    { trusted: true },
    { preparationToken: token }
  );
  assert.equal(cancelled.success, true);
  assert.equal(cancelled.data.cancelled, true);

  const result = await preparing;
  assert.equal(result.success, false);
  assert.equal(result.error.code, 'COMMUNITY_OPERATION_CANCELLED');
  assert.equal(signal.aborted, true);
  assert.equal(fixture.planReads.length, 1);
  assert.equal(fixture.pullCalls.length, 0);
  assert.equal(fixture.freshReviews.length, 0);
  assert.equal(fixture.preparations.has(token), true);
});

test('stopping an in-flight exact pull aborts it and prevents later pulls or a final review', async () => {
  const pullStarted = deferred();
  const fixture = loadRuntime({
    onSongPull(call) {
      pullStarted.resolve(call.options.signal);
      return new Promise((resolve, reject) => {
        const rejectAborted = () => {
          const error = new Error('aborted');
          error.name = 'AbortError';
          reject(error);
        };
        if (call.options.signal.aborted) {
          rejectAborted();
        } else {
          call.options.signal.addEventListener(
            'abort',
            rejectAborted,
            { once: true }
          );
        }
      });
    }
  });

  const preparing = fixture.prepare({ trusted: true }, prepareRequest());
  const signal = await pullStarted.promise;
  const cancelled = await fixture.cancel(
    { trusted: true },
    { preparationToken: token }
  );
  assert.equal(cancelled.success, true);
  assert.equal(cancelled.data.cancelled, true);

  const result = await preparing;
  assert.equal(result.success, false);
  assert.equal(result.error.code, 'COMMUNITY_OPERATION_CANCELLED');
  assert.equal(signal.aborted, true);
  assert.deepEqual(
    fixture.pullCalls.map(call => call.kind),
    ['song']
  );
  assert.equal(fixture.planReads.length, 1);
  assert.equal(fixture.freshReviews.length, 0);
  assert.equal(fixture.preparations.has(token), true);
});

test('an epoch change after a point pull prevents later dependencies and the final review', async () => {
  const pullStarted = deferred();
  const releasePull = deferred();
  const fixture = loadRuntime({
    onSongPull(call) {
      pullStarted.resolve(call.options.signal);
      return releasePull.promise;
    }
  });

  const preparing = fixture.prepare({ trusted: true }, prepareRequest());
  const signal = await pullStarted.promise;
  fixture.sandbox.communityOperationEpoch += 1;
  releasePull.resolve({ status: 'synced', pulled: 1 });

  const result = await preparing;
  assert.equal(result.success, false);
  assert.equal(result.error.code, 'COMMUNITY_OPERATION_CANCELLED');
  assert.equal(signal.aborted, false);
  assert.deepEqual(
    fixture.pullCalls.map(call => call.kind),
    ['song']
  );
  assert.equal(fixture.planReads.length, 1);
  assert.equal(fixture.freshReviews.length, 0);
  assert.equal(fixture.preparations.has(token), true);
});

test('exact approved song and sermon pins and one shared abort signal are forwarded', async () => {
  const fixture = loadRuntime();
  const result = await fixture.prepare(
    { trusted: true },
    prepareRequest()
  );

  assert.equal(result.success, true);
  assert.deepEqual(
    fixture.pullCalls.map(call => ({
      kind: call.kind,
      syncId: call.syncId,
      expectedSyncVersion: call.options.expectedSyncVersion,
      expectedRevision: call.options.expectedRevision,
      keys: Object.keys(call.options).sort()
    })),
    [{
      kind: 'song',
      syncId: songDependency.syncId,
      expectedSyncVersion: songDependency.expectedSyncVersion,
      expectedRevision: songDependency.expectedRevision,
      keys: ['expectedRevision', 'expectedSyncVersion', 'signal']
    }, {
      kind: 'sermon',
      syncId: sermonDependency.syncId,
      expectedSyncVersion: sermonDependency.expectedSyncVersion,
      expectedRevision: sermonDependency.expectedRevision,
      keys: ['expectedRevision', 'expectedSyncVersion', 'signal']
    }]
  );
  assert.strictEqual(
    fixture.pullCalls[0].options.signal,
    fixture.pullCalls[1].options.signal
  );
  assert.strictEqual(
    fixture.pullCalls[0].options.signal,
    fixture.planReads[0].signal
  );
  assert.strictEqual(
    fixture.pullCalls[0].options.signal,
    fixture.planReads[1].signal
  );
  assert.equal(fixture.freshReviews.length, 1);
  assert.equal(fixture.preparations.has(token), false);
});

test('a strict unresolved subset of the approved vector resumes without reading other lanes', async () => {
  const fixture = loadRuntime({
    reviewVectors: [[sermonDependency], []]
  });
  const result = await fixture.prepare(
    { trusted: true },
    prepareRequest()
  );

  assert.equal(result.success, true);
  assert.deepEqual(
    fixture.pullCalls.map(call => [call.kind, call.syncId]),
    [['sermon', sermonDependency.syncId]]
  );
  assert.equal(fixture.freshReviews.length, 1);
  assert.equal(fixture.preparations.has(token), false);
});

test('a new or re-pinned dependency returns a fresh review with zero point pulls', async t => {
  const cases = [{
    name: 'new dependency',
    dependency: {
      ...songDependency,
      syncId: 'song-family-new',
      expectedRevision: 'song:song-family-new:1',
      expectedSyncVersion: 1,
      entryIds: ['song-new']
    }
  }, {
    name: 're-pinned dependency',
    dependency: {
      ...songDependency,
      expectedRevision: 'song:song-family-grace:8',
      expectedSyncVersion: 8
    }
  }];

  for (const scenario of cases) {
    await t.test(scenario.name, async () => {
      const fixture = loadRuntime({
        reviewVectors: [[scenario.dependency]]
      });
      const result = await fixture.prepare(
        { trusted: true },
        prepareRequest()
      );

      assert.equal(result.success, true);
      assert.equal(result.data.fresh, true);
      assert.equal(fixture.planReads.length, 1);
      assert.equal(fixture.pullCalls.length, 0);
      assert.equal(fixture.freshReviews.length, 1);
      assert.equal(fixture.preparations.has(token), false);
    });
  }
});
