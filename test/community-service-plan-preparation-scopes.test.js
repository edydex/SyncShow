'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const mainPath = path.join(root, 'main.js');
const mainSource = fs.readFileSync(mainPath, 'utf8');

const SONG_SCOPE = 'syncshow:songs:read';
const SERMON_SCOPE = 'syncshow:sermons:read';
const TOKEN = '223e4567-e89b-42d3-a456-426614174000';
const OPTIONS = Object.freeze({ profileId: 'main' });
const ENVELOPE = Object.freeze({
  syncId: 'plan-2026-08-02',
  syncVersion: 4,
  revision: 'a'.repeat(64),
  status: 'ready',
  changedAt: '2026-07-29T12:00:00.000Z',
  documentSource: 'reviewed-plan'
});

function fail(code, message) {
  const error = new Error(message);
  error.code = code;
  throw error;
}

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

function sourceBetween(startMarker, endMarker) {
  const start = mainSource.indexOf(startMarker);
  const end = mainSource.indexOf(endMarker, start);
  assert.ok(start >= 0, `${startMarker} must exist`);
  assert.ok(end > start, `${endMarker} must follow ${startMarker}`);
  return mainSource.slice(start, end);
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

function loadScopeRequirement() {
  const sandbox = {
    failMainOperation: fail
  };
  vm.runInNewContext(
    sourceBetween(
      'function requireCommunityServicePlanPreparationScopes',
      'async function currentCommunityConnectionSummary'
    ),
    sandbox,
    { filename: mainPath }
  );
  assert.equal(
    typeof sandbox.requireCommunityServicePlanPreparationScopes,
    'function'
  );
  return sandbox.requireCommunityServicePlanPreparationScopes;
}

function connection(overrides = {}) {
  return {
    canReadSongs: false,
    canReadSermons: false,
    scopes: [],
    advertisedScopes: [],
    ...overrides
  };
}

function dependencies(...kinds) {
  return kinds.map(kind => ({ kind }));
}

function expectCode(code, label) {
  return error => {
    assert.equal(error.code, code);
    assert.match(error.message, new RegExp(label, 'i'));
    return true;
  };
}

function loadPreparationRuntime({
  activeConnection,
  preparationDependencies
}) {
  const handlers = new Map();
  const preparations = new Map();
  const constructions = {
    song: 0,
    sermon: 0
  };
  const contextRequests = [];
  let planReads = 0;

  preparations.set(TOKEN, {
    connectionId: 'connection-1',
    serverId: 'wotbc-community',
    envelope: ENVELOPE,
    options: OPTIONS,
    optionsKey: JSON.stringify(OPTIONS),
    dependencies: preparationDependencies,
    dependencyKey: JSON.stringify(preparationDependencies),
    expiresAt: Date.now() + 60_000
  });

  const context = {
    connection: {
      id: 'connection-1',
      serverId: 'wotbc-community',
      serverName: 'WOTBC Community',
      accessToken: 'community-access-token',
      ...activeConnection
    },
    client: {
      async getServicePlan() {
        planReads += 1;
        return ENVELOPE;
      }
    }
  };
  const scopeRequirement = loadScopeRequirement();
  const sandbox = {
    AbortController,
    activeCommunityServicePlanPreparation: null,
    applyCommunityServicePlanStalePins: review => review,
    communityIpcResult: operationResult,
    communityOperationEpoch: 0,
    communityRequestKeys() {},
    communityServicePlanContext: async request => {
      contextRequests.push(request);
      return context;
    },
    communityServicePlanCoordinator() {
      return {
        async review() {
          return {
            proposal: { status: 'blocked' },
            preparationDependencies
          };
        }
      };
    },
    communityServicePlanDependencyKey: JSON.stringify,
    communityServicePlanImportOptions: () => OPTIONS,
    communityServicePlanImportOptionsKey: JSON.stringify,
    communityServicePlanPreparations: preparations,
    communityServicePlanReviewResponse: async () => {
      throw new Error('a scope failure must not produce a fresh review');
    },
    communitySermonSyncForConnection: async () => {
      constructions.sermon += 1;
      throw new Error('sermon sync must not be constructed before scope checks');
    },
    communitySyncAbortController: null,
    communitySyncForConnection: async () => {
      constructions.song += 1;
      throw new Error('song sync must not be constructed before scope checks');
    },
    failMainOperation: fail,
    ipcMain: {
      handle(channel, callback) {
        handlers.set(channel, callback);
      }
    },
    knownCommunityServicePlanStalePins: () => [],
    notifyCommunityStatusChanged: async () => {},
    rememberCommunityServicePlanStalePin() {},
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
    requireCommunityServicePlanPreparationScopes: scopeRequirement,
    requireControlSender() {},
    sameCommunityServicePlanEnvelope: (left, right) =>
      left.syncId === right.syncId
      && left.syncVersion === right.syncVersion
      && left.revision === right.revision
      && left.status === right.status
      && left.changedAt === right.changedAt
      && left.documentSource === right.documentSource,
    serializeCommunityOperation: operation => operation()
  };

  vm.runInNewContext(
    handlerSource('community:servicePlans:prepare'),
    sandbox,
    { filename: mainPath }
  );
  return {
    constructions,
    contextRequests,
    planReads: () => planReads,
    preparation: preparations,
    prepare: handlers.get('community:servicePlans:prepare'),
    sandbox
  };
}

test('the real scope gate requires only the resource lanes in the exact subset', async t => {
  const requireScopes = loadScopeRequirement();
  const cases = [{
    name: 'song-only',
    activeConnection: connection({
      canReadSongs: true,
      scopes: [SONG_SCOPE],
      advertisedScopes: [SONG_SCOPE]
    }),
    required: dependencies('song')
  }, {
    name: 'sermon-only',
    activeConnection: connection({
      canReadSermons: true,
      scopes: [SERMON_SCOPE],
      advertisedScopes: [SERMON_SCOPE]
    }),
    required: dependencies('sermon')
  }, {
    name: 'mixed song and sermon',
    activeConnection: connection({
      canReadSongs: true,
      canReadSermons: true,
      scopes: [SONG_SCOPE, SERMON_SCOPE],
      advertisedScopes: [SONG_SCOPE, SERMON_SCOPE]
    }),
    required: dependencies('song', 'sermon')
  }];

  for (const scenario of cases) {
    await t.test(scenario.name, () => {
      assert.doesNotThrow(() =>
        requireScopes(scenario.activeConnection, scenario.required));
    });
  }
});

test('an advertised but ungranted required lane requires reconnect', () => {
  const requireScopes = loadScopeRequirement();
  assert.throws(
    () => requireScopes(
      connection({
        canReadSermons: false,
        scopes: [],
        advertisedScopes: [SERMON_SCOPE]
      }),
      dependencies('sermon')
    ),
    expectCode(
      'COMMUNITY_SERVICE_PLAN_ITEMS_RECONNECT_REQUIRED',
      'sermons'
    )
  );
});

test('a required lane absent from server capabilities is unavailable', () => {
  const requireScopes = loadScopeRequirement();
  assert.throws(
    () => requireScopes(
      connection({
        canReadSongs: false,
        scopes: [],
        advertisedScopes: []
      }),
      dependencies('song')
    ),
    expectCode(
      'COMMUNITY_SERVICE_PLAN_ITEMS_UNAVAILABLE',
      'songs'
    )
  );
});

test('the real preparation handler checks scopes before constructing either synchronizer', async t => {
  const cases = [{
    name: 'reconnect required',
    activeConnection: connection({
      canReadSongs: false,
      scopes: [],
      advertisedScopes: [SONG_SCOPE]
    }),
    required: dependencies('song'),
    code: 'COMMUNITY_SERVICE_PLAN_ITEMS_RECONNECT_REQUIRED'
  }, {
    name: 'capability unavailable',
    activeConnection: connection({
      canReadSermons: false,
      scopes: [],
      advertisedScopes: []
    }),
    required: dependencies('sermon'),
    code: 'COMMUNITY_SERVICE_PLAN_ITEMS_UNAVAILABLE'
  }];

  for (const scenario of cases) {
    await t.test(scenario.name, async () => {
      const fixture = loadPreparationRuntime({
        activeConnection: scenario.activeConnection,
        preparationDependencies: scenario.required
      });
      const result = await fixture.prepare(
        { trusted: true },
        {
          preparationToken: TOKEN,
          confirmed: true
        }
      );

      assert.equal(result.success, false);
      assert.equal(result.error.code, scenario.code);
      assert.deepEqual(fixture.constructions, {
        song: 0,
        sermon: 0
      });
      assert.equal(fixture.planReads(), 1);
      assert.equal(fixture.contextRequests.length, 1);
      assert.equal(
        fixture.contextRequests[0].refreshCapabilities,
        true
      );
      assert.deepEqual(
        Object.keys(fixture.contextRequests[0]),
        ['refreshCapabilities']
      );
      assert.equal(fixture.preparation.has(TOKEN), true);
      assert.equal(
        fixture.sandbox.activeCommunityServicePlanPreparation,
        null
      );
      assert.equal(fixture.sandbox.communitySyncAbortController, null);
    });
  }
});
