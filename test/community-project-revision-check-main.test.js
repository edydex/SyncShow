'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const mainPath = path.join(root, 'main.js');
const preloadPath = path.join(root, 'preload.js');
const mainSource = fs.readFileSync(mainPath, 'utf8');
const preloadSource = fs.readFileSync(preloadPath, 'utf8');
const EXPECTED_REVISION = 'a'.repeat(64);

function plain(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function handlerSource() {
  const marker =
    "ipcMain.handle('community:servicePlans:checkProjectRevision'";
  const start = mainSource.indexOf(marker);
  assert.notEqual(start, -1, 'project-bound Community check must be registered');
  const next = mainSource.indexOf("\nipcMain.handle('", start + marker.length);
  return mainSource.slice(start, next < 0 ? mainSource.length : next);
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
            return Promise.resolve({ success: true });
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
  }, { filename: preloadPath });
  assert.ok(api);
  return { api, calls };
}

function localRecord({
  revisionId = EXPECTED_REVISION,
  serverId = 'wotbc-community',
  planId = 'service-2026-08-02',
  sourceKind = 'community-plan',
  includeSource = true
} = {}) {
  const planning = includeSource
    ? {
        source: {
          kind: sourceKind,
          serverId,
          planId,
          planRevision: 'c'.repeat(64),
          importedAt: '2026-07-28T12:00:00.000Z'
        }
      }
    : {};
  return {
    revisionId,
    project: {
      id: 'local-service',
      planning
    }
  };
}

function loadHandler({
  records = [localRecord(), localRecord()],
  connectedServerId = 'wotbc-community',
  changeEpochDuringGet = false,
  reviewProjectId = 'local-service'
} = {}) {
  const handlers = new Map();
  const calls = {
    reads: [],
    contexts: 0,
    gets: [],
    reviews: []
  };
  let readIndex = 0;
  const context = {
    connection: {
      id: 'connection-1',
      serverId: connectedServerId,
      serverName: 'WOTBC Community',
      accessToken: 'main-owned-access-token'
    },
    client: {
      async getServicePlan(input) {
        calls.gets.push(plain(input));
        if (changeEpochDuringGet) sandbox.communityOperationEpoch += 1;
        return {
          syncId: input.syncId,
          revision: 'd'.repeat(64),
          status: 'ready'
        };
      }
    }
  };
  const reviewResponse = {
    connection: {
      id: context.connection.id,
      serverId: context.connection.serverId,
      serverName: context.connection.serverName
    },
    servicePlan: {
      syncId: 'service-2026-08-02',
      revision: 'd'.repeat(64)
    },
    proposal: {
      status: 'newer-revision',
      projectId: reviewProjectId
    },
    reviewToken: null,
    reviewExpiresAt: null,
    replacementToken: 'replacement-token',
    replacementExpiresAt: '2026-07-28T12:15:00.000Z',
    preparation: null
  };

  function fail(code, message, details = undefined) {
    const error = new Error(message);
    error.code = code;
    error.details = details;
    throw error;
  }

  const sandbox = {
    communityOperationEpoch: 7,
    communityIpcResult: async operation => {
      try {
        return { success: true, data: await operation() };
      } catch (error) {
        return {
          success: false,
          error: {
            code: error.code || 'COMMUNITY_ERROR',
            message: error.message,
            details: plain(error.details)
          }
        };
      }
    },
    communityRequestKeys(value, allowedKeys) {
      if (!value || typeof value !== 'object' || Array.isArray(value)) {
        fail('INVALID_COMMUNITY_REQUEST', 'That request is invalid.');
      }
      const allowed = new Set(allowedKeys);
      if (Object.keys(value).some(key => !allowed.has(key))) {
        fail(
          'INVALID_COMMUNITY_REQUEST',
          'That request contains unsupported fields.'
        );
      }
    },
    communityServicePlanContext: async () => {
      calls.contexts += 1;
      return context;
    },
    communityServicePlanImportOptions: () => ({
      profileId: 'main-sanctuary',
      preferredProfileId: 'main-sanctuary',
      channels: []
    }),
    communityServicePlanReviewResponse: async input => {
      calls.reviews.push(input);
      return reviewResponse;
    },
    failMainOperation: fail,
    getPrepareServices: () => ({
      serviceProjectStore: {
        async read(projectId) {
          calls.reads.push(projectId);
          const record = records[
            Math.min(readIndex, records.length - 1)
          ];
          readIndex += 1;
          return record;
        }
      }
    }),
    ipcMain: {
      handle(channel, callback) {
        handlers.set(channel, callback);
      }
    },
    prepareId(value, label) {
      if (typeof value !== 'string'
        || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)) {
        fail('INVALID_PREPARE_ID', `${label} is invalid.`);
      }
      return value;
    },
    prepareRevision(value, label) {
      if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) {
        fail('INVALID_PREPARE_REVISION', `${label} is invalid.`);
      }
      return value;
    },
    requireControlSender(event) {
      if (event?.trusted !== true) {
        fail('UNTRUSTED_CONTROL_SENDER', 'Only the control window may check.');
      }
    },
    serializeCommunityOperation: operation => operation()
  };
  vm.runInNewContext(handlerSource(), sandbox, { filename: mainPath });
  return {
    calls,
    handler: handlers.get(
      'community:servicePlans:checkProjectRevision'
    ),
    reviewResponse
  };
}

test('preload forwards only the project and exact local revision binding', async () => {
  const { api, calls } = loadPreloadBridge();

  await api.checkCommunityServicePlanRevision({
    projectId: 'local-service',
    expectedRevisionId: EXPECTED_REVISION,
    serverId: 'renderer-must-not-select-a-server',
    planId: 'renderer-must-not-select-a-plan',
    syncId: 'renderer-must-not-select-a-plan',
    accessToken: 'renderer-must-not-send-credentials',
    confirmed: true
  });

  assert.deepEqual(calls, [{
    channel: 'community:servicePlans:checkProjectRevision',
    payload: {
      projectId: 'local-service',
      expectedRevisionId: EXPECTED_REVISION
    }
  }]);
});

test('main check is trusted, exact-field, source-bound, and read-only', () => {
  const source = handlerSource();
  assert.match(source, /requireControlSender\(event\)/);
  assert.match(
    source,
    /communityRequestKeys\(\s*request,\s*\[\s*'projectId',\s*'expectedRevisionId'\s*\]/
  );
  assert.match(source, /source\.kind !== 'community-plan'/);
  assert.match(source, /const serverId = prepareId\(\s*source\.serverId/);
  assert.match(source, /const planId = prepareId\(\s*source\.planId/);
  assert.match(source, /context\.connection\.serverId !== serverId/);
  assert.match(
    source,
    /context\.client\.getServicePlan\(\{\s*syncId:\s*planId,\s*accessToken:\s*context\.connection\.accessToken/
  );
  assert.match(source, /await readBoundProject\(\)/);
  assert.match(source, /communityServicePlanReviewResponse\(\{/);
  assert.match(source, /response\.proposal\?\.projectId !== projectId/);
  assert.doesNotMatch(
    source,
    /request\.(?:serverId|planId|syncId|accessToken)|\.save\(|\.create\(|\.importPlan\(|\.replacePlanRevision\(|showPackage|appState|startShow|publish\(/
  );
});

test('successful check gets only the imported plan and reuses the review response', async () => {
  const fixture = loadHandler();
  const result = await fixture.handler(
    { trusted: true },
    {
      projectId: 'local-service',
      expectedRevisionId: EXPECTED_REVISION
    }
  );

  assert.equal(result.success, true);
  assert.deepEqual(plain(result.data), fixture.reviewResponse);
  assert.deepEqual(fixture.calls.reads, [
    'local-service',
    'local-service',
    'local-service'
  ]);
  assert.equal(fixture.calls.contexts, 1);
  assert.deepEqual(fixture.calls.gets, [{
    syncId: 'service-2026-08-02',
    accessToken: 'main-owned-access-token'
  }]);
  assert.equal(fixture.calls.reviews.length, 1);
  assert.equal(
    fixture.calls.reviews[0].context.connection.serverId,
    'wotbc-community'
  );
  assert.equal(
    fixture.calls.reviews[0].envelope.syncId,
    'service-2026-08-02'
  );
});

test('unsupported renderer fields fail before local or remote state is read', async () => {
  const fixture = loadHandler();
  const result = await fixture.handler(
    { trusted: true },
    {
      projectId: 'local-service',
      expectedRevisionId: EXPECTED_REVISION,
      serverId: 'malicious-server'
    }
  );

  assert.equal(result.success, false);
  assert.equal(result.error.code, 'INVALID_COMMUNITY_REQUEST');
  assert.equal(fixture.calls.reads.length, 0);
  assert.equal(fixture.calls.contexts, 0);
  assert.equal(fixture.calls.gets.length, 0);
});

test('untrusted senders fail before the project is read', async () => {
  const fixture = loadHandler();
  await assert.rejects(
    fixture.handler(
      { trusted: false },
      {
        projectId: 'local-service',
        expectedRevisionId: EXPECTED_REVISION
      }
    ),
    error => error?.code === 'UNTRUSTED_CONTROL_SENDER'
  );
  assert.equal(fixture.calls.reads.length, 0);
});

test('a stale local revision fails before any Community request', async () => {
  const fixture = loadHandler({
    records: [
      localRecord({ revisionId: 'b'.repeat(64) })
    ]
  });
  const result = await fixture.handler(
    { trusted: true },
    {
      projectId: 'local-service',
      expectedRevisionId: EXPECTED_REVISION
    }
  );

  assert.equal(result.success, false);
  assert.equal(result.error.code, 'PROJECT_CONFLICT');
  assert.equal(fixture.calls.contexts, 0);
  assert.equal(fixture.calls.gets.length, 0);
  assert.equal(fixture.calls.reviews.length, 0);
});

test('a local edit across the GET boundary discards the remote review', async () => {
  const fixture = loadHandler({
    records: [
      localRecord(),
      localRecord({ revisionId: 'b'.repeat(64) })
    ]
  });
  const result = await fixture.handler(
    { trusted: true },
    {
      projectId: 'local-service',
      expectedRevisionId: EXPECTED_REVISION
    }
  );

  assert.equal(result.success, false);
  assert.equal(result.error.code, 'PROJECT_CONFLICT');
  assert.equal(fixture.calls.gets.length, 1);
  assert.equal(fixture.calls.reviews.length, 0);
});

test('a local edit during coordinator review discards the response', async () => {
  const fixture = loadHandler({
    records: [
      localRecord(),
      localRecord(),
      localRecord({ revisionId: 'b'.repeat(64) })
    ]
  });
  const result = await fixture.handler(
    { trusted: true },
    {
      projectId: 'local-service',
      expectedRevisionId: EXPECTED_REVISION
    }
  );

  assert.equal(result.success, false);
  assert.equal(result.error.code, 'PROJECT_CONFLICT');
  assert.equal(fixture.calls.gets.length, 1);
  assert.equal(fixture.calls.reviews.length, 1);
  assert.equal(fixture.calls.reads.length, 3);
});

test('a coordinator proposal for another local project is rejected', async () => {
  const fixture = loadHandler({
    reviewProjectId: 'another-local-service'
  });
  const result = await fixture.handler(
    { trusted: true },
    {
      projectId: 'local-service',
      expectedRevisionId: EXPECTED_REVISION
    }
  );

  assert.equal(result.success, false);
  assert.equal(
    result.error.code,
    'COMMUNITY_SERVICE_PLAN_PROJECT_MISMATCH'
  );
  assert.equal(fixture.calls.gets.length, 1);
  assert.equal(fixture.calls.reviews.length, 1);
  assert.equal(fixture.calls.reads.length, 3);
});

test('a project without imported Community provenance cannot select a remote plan', async () => {
  for (const record of [
    localRecord({ includeSource: false }),
    localRecord({ sourceKind: 'local-template' })
  ]) {
    const fixture = loadHandler({ records: [record] });
    const result = await fixture.handler(
      { trusted: true },
      {
        projectId: 'local-service',
        expectedRevisionId: EXPECTED_REVISION
      }
    );
    assert.equal(result.success, false);
    assert.equal(
      result.error.code,
      'COMMUNITY_SERVICE_PLAN_SOURCE_REQUIRED'
    );
    assert.equal(fixture.calls.contexts, 0);
    assert.equal(fixture.calls.gets.length, 0);
  }
});

test('the active Community connection must match the imported server', async () => {
  const fixture = loadHandler({
    connectedServerId: 'another-community'
  });
  const result = await fixture.handler(
    { trusted: true },
    {
      projectId: 'local-service',
      expectedRevisionId: EXPECTED_REVISION
    }
  );

  assert.equal(result.success, false);
  assert.equal(
    result.error.code,
    'COMMUNITY_SERVICE_PLAN_SERVER_MISMATCH'
  );
  assert.equal(fixture.calls.gets.length, 0);
  assert.equal(fixture.calls.reviews.length, 0);
});

test('a connection epoch change discards the fetched envelope', async () => {
  const fixture = loadHandler({ changeEpochDuringGet: true });
  const result = await fixture.handler(
    { trusted: true },
    {
      projectId: 'local-service',
      expectedRevisionId: EXPECTED_REVISION
    }
  );

  assert.equal(result.success, false);
  assert.equal(result.error.code, 'COMMUNITY_OPERATION_CANCELLED');
  assert.equal(fixture.calls.gets.length, 1);
  assert.equal(fixture.calls.reads.length, 1);
  assert.equal(fixture.calls.reviews.length, 0);
});
