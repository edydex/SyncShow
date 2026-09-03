'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const mainSource = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
const preloadSource = fs.readFileSync(path.join(root, 'preload.js'), 'utf8');
const trustedContractSource = fs.readFileSync(
  path.join(root, 'test', 'prepare-ipc-contract.test.js'),
  'utf8'
);

function handlerSource(channel) {
  const marker = `ipcMain.handle('${channel}'`;
  const start = mainSource.indexOf(marker);
  assert.notEqual(start, -1, `${channel} must be registered`);
  const next = mainSource.indexOf('\nipcMain.handle(', start + marker.length);
  return mainSource.slice(start, next < 0 ? mainSource.length : next);
}

function loadPreloadPlanningBridge() {
  const calls = [];
  let api = null;
  const ipcRenderer = {
    invoke(channel, payload) {
      calls.push({
        channel,
        payload: JSON.parse(JSON.stringify(payload))
      });
      return Promise.resolve({ success: true });
    },
    send() {},
    on() {},
    removeListener() {},
    removeAllListeners() {}
  };
  const contextBridge = {
    exposeInMainWorld(name, value) {
      if (name === 'api') api = value;
    }
  };
  vm.runInNewContext(preloadSource, {
    require(moduleId) {
      if (moduleId === 'electron') return { contextBridge, ipcRenderer };
      throw new Error(`Unexpected preload dependency: ${moduleId}`);
    },
    console,
    TextEncoder
  }, { filename: path.join(root, 'preload.js') });
  assert.ok(api);
  return { api, calls };
}

test('New service creates a validated local plan and never enters Load or Show', () => {
  const source = handlerSource('prepare:projects:create');
  assert.match(source, /requireControlSender\(event\)/);
  assert.match(source, /requirePrepareRequest\(request,\s*16 \* 1024\)/);
  assert.match(source, /requireExactPrepareKeys\(request,\s*\[/);
  for (const key of ['title', 'serviceDate', 'startTime', 'teamNotes']) {
    assert.match(source, new RegExp(`'${key}'`));
  }
  assert.match(
    source,
    /prepareText\(\s*request\.startTime,\s*'Service start time',\s*5,\s*\{\s*required:\s*true\s*\}/
  );
  assert.match(
    source,
    /prepareText\(request\.teamNotes,\s*'Planning team notes',\s*4000\)/
  );
  assert.match(source, /serviceProjectStore\.create\(\{/);
  assert.match(source, /\bstartTime,\s*\.\.\.\(teamNotes !== undefined/);
  assert.match(source, /return projectResult\(created\)/);
  assert.doesNotMatch(
    source,
    /PowerPoint|pptx|showPackage|installPresentation|publish\(/
  );
});

test('Plan next service validates one exact saved source and returns only the project result', () => {
  const source = handlerSource('prepare:projects:planNext');
  assert.match(source, /requireControlSender\(event\)/);
  assert.match(source, /requirePrepareRequest\(request,\s*16 \* 1024\)/);
  assert.match(source, /requireExactPrepareKeys\(request,\s*\[/);
  for (const key of [
    'sourceProjectId',
    'sourceRevisionId',
    'title',
    'serviceDate',
    'startTime',
    'teamNotes'
  ]) {
    assert.match(source, new RegExp(`'${key}'`));
  }
  assert.match(source, /prepareId\(\s*request\.sourceProjectId/);
  assert.match(source, /prepareRevision\(\s*request\.sourceRevisionId/);
  assert.match(source, /prepareText\(\s*request\.title/);
  assert.match(source, /prepareText\(\s*request\.serviceDate/);
  assert.match(source, /prepareText\(\s*request\.startTime/);
  assert.match(source, /prepareText\(request\.teamNotes,\s*'Planning team notes',\s*4000\)/);
  assert.match(source, /serviceProjectStore\.planNextService\(/);
  assert.match(source, /id:\s*projectItemId\('service'\)/);
  assert.match(source, /return projectResult\(planned\)/);
  assert.doesNotMatch(source, /showPackage|installPresentation|publish\(/);
});

test('planning lifecycle changes use the domain transition and an exact revision CAS', () => {
  const source = handlerSource('prepare:projects:setPlanning');
  assert.match(source, /requireControlSender\(event\)/);
  assert.match(source, /requirePrepareRequest\(request,\s*16 \* 1024\)/);
  assert.match(source, /requireExactPrepareKeys\(request,\s*\[/);
  for (const key of ['projectId', 'expectedRevisionId', 'status']) {
    assert.match(source, new RegExp(`'${key}'`));
  }
  assert.match(source, /prepareId\(request\.projectId/);
  assert.match(source, /prepareRevision\(\s*request\.expectedRevisionId/);
  assert.match(
    source,
    /\['planning', 'ready', 'completed', 'needs-follow-up'\]\.includes\(status\)/
  );
  assert.match(source, /readExpectedProject\(\{\s*projectId,\s*expectedRevisionId\s*\}\)/);
  assert.match(source, /updateServicePlanningDetails\(reviewedProject,/);
  assert.match(source, /analyzeServiceProjectReadiness\(reviewedProject,/);
  assert.match(source, /'SERVICE_READINESS_BLOCKED'/);
  assert.match(source, /setServicePlanStatus\(reviewedProject,\s*status\)/);
  assert.match(source, /serviceProjectStore\.save\(next,\s*\{\s*expectedRevisionId,/);
  assert.match(source, /reason:\s*'prepare-planning-status'/);
  assert.match(source, /return projectResult\(saved\)/);
  assert.doesNotMatch(source, /showPackage|installPresentation|publish\(/);
});

test('planning details and revision-specific waivers use one exact project CAS', () => {
  const source = handlerSource('prepare:projects:updatePlanning');
  assert.match(source, /requireControlSender\(event\)/);
  assert.match(source, /requirePrepareRequest\(request,\s*32 \* 1024\)/);
  for (const key of [
    'projectId',
    'expectedRevisionId',
    'startTime',
    'teamNotes',
    'waivers'
  ]) {
    assert.match(source, new RegExp(`'${key}'`));
  }
  assert.match(source, /updateServicePlanningDetails\(current\.project,\s*details\)/);
  assert.match(source, /serviceProjectStore\.save\(next,\s*\{/);
  assert.match(source, /reason:\s*'prepare-planning-details'/);
  assert.match(source, /return projectResult\(saved\)/);
});

test('serving assignments use a strict path-free planning CAS', () => {
  const source = handlerSource('prepare:projects:updateServing');
  assert.match(source, /requireControlSender\(event\)/);
  assert.match(source, /requirePrepareRequest\(request,\s*256 \* 1024\)/);
  for (const key of ['projectId', 'expectedRevisionId', 'serving']) {
    assert.match(source, new RegExp(`'${key}'`));
  }
  assert.match(
    source,
    /updateServicePlanningDetails\(current\.project,\s*\{\s*serving:\s*request\.serving/
  );
  assert.match(source, /reason:\s*'prepare-serving-assignments'/);
  assert.match(source, /return projectResult\(saved\)/);
  assert.doesNotMatch(source, /Community|Remote|showPackage|publish\(/);
});

test('native project results derive a run sheet in main', () => {
  const start = mainSource.indexOf('function projectResult(');
  const end = mainSource.indexOf('\nfunction ', start + 10);
  const source = mainSource.slice(start, end);
  assert.match(source, /buildServiceRunSheet\(result\.project\)/);
  assert.match(source, /native && result\.project\.planning/);
  assert.match(source, /runSheet:/);
});

test('planned-project publication re-derives readiness in main before rendering', () => {
  const source = handlerSource('prepare:projects:publish');
  const readinessIndex = source.indexOf('analyzeServiceProjectReadiness(');
  const publishIndex = source.indexOf('showPackagePublisher.publish(');
  assert.ok(readinessIndex >= 0 && publishIndex > readinessIndex);
  assert.match(source, /selected\.project\.planning\?\.status !== undefined/);
  assert.match(source, /selected\.project\.planning\.status !== 'ready'/);
  assert.match(source, /'SERVICE_PLAN_NOT_READY'/);
  assert.match(source, /!readiness\.ready/);
  assert.match(source, /'SERVICE_READINESS_BLOCKED'/);
});

test('preload exposes path-free planning requests and the trusted-sender contract covers both channels', () => {
  assert.match(
    preloadSource,
    /planNextServiceProject:[\s\S]*?'prepare:projects:planNext'[\s\S]*?sourceProjectId:[\s\S]*?sourceRevisionId:[\s\S]*?teamNotes:/
  );
  assert.match(
    preloadSource,
    /setServicePlanningStatus:[\s\S]*?'prepare:projects:setPlanning'[\s\S]*?projectId:[\s\S]*?expectedRevisionId:[\s\S]*?status:[\s\S]*?waivers:/
  );
  assert.match(
    preloadSource,
    /updateServicePlanning:[\s\S]*?'prepare:projects:updatePlanning'[\s\S]*?startTime:[\s\S]*?teamNotes:[\s\S]*?waivers:/
  );
  assert.match(
    preloadSource,
    /updateServiceServing:[\s\S]*?'prepare:projects:updateServing'[\s\S]*?serviceServingIntent\(request\?\.serving\)/
  );
  const prepareBridgeStart = preloadSource.indexOf('// Prepare workspace');
  const prepareBridgeEnd = preloadSource.indexOf('// App state', prepareBridgeStart);
  const bridge = preloadSource.slice(prepareBridgeStart, prepareBridgeEnd);
  assert.doesNotMatch(bridge, /sourcePath|filePath|cacheDir|packagePath/);
  assert.match(trustedContractSource, /'prepare:projects:planNext'/);
  assert.match(trustedContractSource, /'prepare:projects:setPlanning'/);
  assert.match(trustedContractSource, /'prepare:projects:updatePlanning'/);
  assert.match(trustedContractSource, /'prepare:projects:updateServing'/);
});

test('preload preserves a valid 500-character non-ASCII readiness reason', () => {
  const { api, calls } = loadPreloadPlanningBridge();
  const reason = 'Ц'.repeat(500);
  api.updateServicePlanning({
    projectId: 'service-2026-08-02',
    expectedRevisionId: 'a'.repeat(64),
    startTime: '10:30',
    teamNotes: '',
    waivers: [{
      checkId: 'song-present',
      reason
    }]
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].channel, 'prepare:projects:updatePlanning');
  assert.equal(calls[0].payload.waivers[0].reason, reason);

  api.updateServicePlanning({
    projectId: 'service-2026-08-02',
    expectedRevisionId: 'a'.repeat(64),
    waivers: [{
      checkId: 'song-present',
      reason: 'Ц'.repeat(501)
    }]
  });
  assert.equal(calls[1].payload.waivers[0].reason, null);
});

test('preload forwards only semantic New service planning fields', () => {
  const { api, calls } = loadPreloadPlanningBridge();
  api.createServiceProject({
    title: 'Sunday Service',
    serviceDate: '2026-08-02',
    startTime: '10:30',
    teamNotes: 'Sound check at 09:45.',
    sourcePath: '/private/legacy-deck.pptx',
    extra: 'not forwarded'
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].channel, 'prepare:projects:create');
  assert.deepEqual(calls[0].payload, {
    title: 'Sunday Service',
    serviceDate: '2026-08-02',
    startTime: '10:30',
    teamNotes: 'Sound check at 09:45.'
  });
});

test('preload strips directory, contact, and account fields from serving assignments', () => {
  const { api, calls } = loadPreloadPlanningBridge();
  api.updateServiceServing({
    projectId: 'service-2026-08-02',
    expectedRevisionId: 'a'.repeat(64),
    serving: {
      schemaVersion: 1,
      directory: [{ email: 'not-forwarded@example.test' }],
      assignments: [{
        id: 'slides',
        role: 'Slides',
        personName: 'Maria S.',
        scope: {
          kind: 'service',
          itemId: null,
          accountId: 'not-forwarded'
        },
        status: 'confirmed',
        required: true,
        callTime: '09:15',
        note: 'Check the confidence monitor.',
        email: 'not-forwarded@example.test',
        phone: 'not-forwarded'
      }]
    }
  });

  assert.deepEqual(calls, [{
    channel: 'prepare:projects:updateServing',
    payload: {
      projectId: 'service-2026-08-02',
      expectedRevisionId: 'a'.repeat(64),
      serving: {
        schemaVersion: 1,
        assignments: [{
          id: 'slides',
          role: 'Slides',
          personName: 'Maria S.',
          scope: { kind: 'service', itemId: null },
          status: 'confirmed',
          required: true,
          callTime: '09:15',
          note: 'Check the confidence monitor.'
        }]
      }
    }
  }]);
});
