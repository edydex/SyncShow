'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.join(__dirname, '..');
const mainSource = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
const preloadSource = fs.readFileSync(path.join(root, 'preload.js'), 'utf8');
const rendererSource = fs.readFileSync(
  path.join(root, 'src', 'renderer', 'app.js'),
  'utf8'
);
const rendererHtml = fs.readFileSync(
  path.join(root, 'src', 'renderer', 'index.html'),
  'utf8'
);

function functionBlock(source, name) {
  const start = source.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `expected ${name}()`);
  const declarationStart = source.slice(start - 6, start) === 'async '
    ? start - 6
    : start;
  const bodyStart = source.indexOf('{', start);
  let depth = 0;
  let quote = null;
  let escaped = false;
  for (let index = bodyStart; index < source.length; index += 1) {
    const char = source[index];
    if (quote) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === quote) quote = null;
      continue;
    }
    if (char === '\'' || char === '"' || char === '`') {
      quote = char;
      continue;
    }
    if (char === '{') depth += 1;
    if (char === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(declarationStart, index + 1);
    }
  }
  assert.fail(`could not find the end of ${name}()`);
}

function handlerBlock(channel, nextChannel) {
  const start = mainSource.indexOf(`'${channel}'`);
  assert.ok(start >= 0, `expected ${channel} handler`);
  const end = nextChannel
    ? mainSource.indexOf(`'${nextChannel}'`, start + channel.length)
    : mainSource.indexOf("\nipcMain.handle('drive:status'", start);
  assert.ok(end > start, `expected end of ${channel} handler`);
  return mainSource.slice(start, end);
}

function loadPreloadApi() {
  let api = null;
  const invocations = [];
  vm.runInNewContext(preloadSource, {
    TextEncoder,
    URL,
    console,
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
            invocations.push({ channel, payload });
            return Promise.resolve({ channel, payload });
          },
          on() {},
          once() {},
          removeListener() {},
          send() {}
        }
      };
    }
  }, { filename: path.join(root, 'preload.js') });
  assert.ok(api, 'preload must expose the renderer API');
  return { api, invocations };
}

test('retention construction binds the canonical private stores and all main calls recover first', () => {
  const prepareServices = functionBlock(mainSource, 'getPrepareServices');
  assert.match(
    prepareServices,
    /new LocalSermonSourceRetention\(\{\s*sourceStore: localSermonSourceStore,\s*sermonLibrary: localSermonLibrary,\s*projectStore: serviceProjectStore,\s*extractionStore: localSermonExtractionStore\s*\}\)/
  );

  const audit = functionBlock(mainSource, 'auditPrivateSermonStorage');
  const startup = functionBlock(
    mainSource,
    'applyConfirmedSermonSourceCleanupAtStartup'
  );
  const schedule = handlerBlock(
    'maintenance:sermonSources:scheduleCleanup',
    'drive:status'
  );
  assert.ok(
    audit.indexOf('recoverSermonTransactionsForRetention(services)')
      < audit.indexOf('localSermonSourceRetention.audit()')
  );
  assert.ok(
    startup.indexOf('recoverSermonTransactionsForRetention(services)')
      < startup.indexOf('applyConfirmedStartupPlan()')
  );
  assert.ok(
    schedule.indexOf('recoverSermonTransactionsForRetention(services)')
      < schedule.indexOf('confirmStartupPlan({')
  );
  assert.equal(
    (mainSource.match(/\.applyConfirmedStartupPlan\(\)/g) || []).length,
    1,
    'deletion-capable apply must have one startup-only call site'
  );
});

test('startup cleanup is caught and finishes before windows, restoration, or Community writers', () => {
  const helper = functionBlock(
    mainSource,
    'applyConfirmedSermonSourceCleanupAtStartup'
  );
  assert.ok(helper.indexOf('try {') < helper.indexOf('getPrepareServices()'));
  assert.match(helper, /catch \(error\)[\s\S]*status: 'safety-check-failed'/);

  const start = mainSource.indexOf('app.whenReady().then(async () => {');
  const end = mainSource.indexOf("\n  app.on('window-all-closed'", start);
  const startup = mainSource.slice(start, end);
  const cleanupIndex = startup.indexOf(
    'await applyConfirmedSermonSourceCleanupAtStartup()'
  );
  assert.ok(cleanupIndex >= 0);
  for (const later of [
    'await restoreCurrentPreparedService()',
    'createControlWindow()',
    "scheduleCommunitySongSync('app startup'",
    'scheduleCommunityPeriodicSync('
  ]) {
    assert.ok(
      cleanupIndex < startup.indexOf(later),
      `startup cleanup must precede ${later}`
    );
  }
});

test('maintenance IPC is trusted, bounded, explicitly confirmed, and path-free', () => {
  const audit = handlerBlock(
    'maintenance:sermonSources:audit',
    'maintenance:sermonSources:scheduleCleanup'
  );
  const schedule = handlerBlock(
    'maintenance:sermonSources:scheduleCleanup',
    'drive:status'
  );
  assert.match(audit, /requireControlSender\(event\)/);
  assert.match(schedule, /requireControlSender\(event\)/);
  assert.match(schedule, /requirePrepareRequest\(request, 1024\)/);
  assert.match(
    schedule,
    /requireExactPrepareKeys\(\s*request,\s*\['candidateHash', 'confirmed'\]/
  );
  assert.match(schedule, /if \(request\.confirmed !== true\)/);
  assert.match(schedule, /confirmStartupPlan\(\{\s*candidateHash\s*\}\)/);
  assert.doesNotMatch(schedule, /\b(?:apply|delete|unlink)ConfirmedStartupPlan\b/);

  const projection = functionBlock(mainSource, 'auditPrivateSermonStorage');
  assert.doesNotMatch(projection, /\.\.\.summary/);
  for (const field of [
    'objectCount',
    'objectBytes',
    'referencedObjectCount',
    'referencedBytes',
    'waitingObjectCount',
    'waitingBytes',
    'eligibleObjectCount',
    'eligibleBytes',
    'candidateHash'
  ]) {
    assert.match(projection, new RegExp(`${field}: summary\\.${field}`));
  }
  assert.doesNotMatch(
    projection,
    /\b(?:path|objectId|sha256|digest|candidates)\b/i
  );
});

test('preload forwards only an opaque hash and strict confirmation boolean', async () => {
  const { api, invocations } = loadPreloadApi();
  await api.checkPrivateSermonStorage();
  await api.schedulePrivateSermonStorageCleanup({
    candidateHash: 'a'.repeat(64),
    confirmed: 'yes',
    path: '/private/church/sermons',
    candidates: [{ objectId: 'secret' }],
    applyNow: true
  });
  await api.schedulePrivateSermonStorageCleanup({
    candidateHash: 'b'.repeat(64),
    confirmed: true
  });

  assert.deepEqual(
    JSON.parse(JSON.stringify(invocations.slice(-3))),
    [
      {
        channel: 'maintenance:sermonSources:audit'
      },
      {
        channel: 'maintenance:sermonSources:scheduleCleanup',
        payload: {
          candidateHash: 'a'.repeat(64),
          confirmed: false
        }
      },
      {
        channel: 'maintenance:sermonSources:scheduleCleanup',
        payload: {
          candidateHash: 'b'.repeat(64),
          confirmed: true
        }
      }
    ]
  );
  const maintenanceNames = Object.keys(api)
    .filter(name => /SermonStorage|Retention|Cleanup/i.test(name));
  assert.deepEqual(maintenanceNames.sort(), [
    'checkPrivateSermonStorage',
    'schedulePrivateSermonStorageCleanup'
  ]);
});

test('Admin Settings keeps retention explicit, aggregate-only, and restart-only', () => {
  const dialogStart = rendererHtml.indexOf('<dialog id="advancedSetupDetails"');
  const dialogEnd = rendererHtml.indexOf('</dialog>', dialogStart);
  const dialog = rendererHtml.slice(dialogStart, dialogEnd);
  assert.match(dialog, /id="sermonStorageSection"/);
  assert.match(dialog, />Check private sermon storage</);
  assert.match(dialog, />Remove after restart</);
  assert.match(dialog, /id="btnScheduleSermonStorageCleanup"[^>]*hidden/);
  assert.doesNotMatch(dialog, /candidateHash|objectId|sha256|digest/);

  const openSettings = functionBlock(rendererSource, 'openSettings');
  assert.doesNotMatch(openSettings, /checkPrivateSermonStorage/);
  const render = functionBlock(rendererSource, 'renderPrivateSermonStorage');
  const schedule = functionBlock(
    rendererSource,
    'schedulePrivateSermonStorageCleanup'
  );
  assert.match(
    render,
    /eligibleObjectCount > 0[\s\S]*eligibleBytes > 0[\s\S]*\^\[a-f0-9\]\{64\}\$/
  );
  assert.match(
    render,
    /btnScheduleSermonStorageCleanup\.hidden = !eligible \|\| storage\.scheduled/
  );
  assert.doesNotMatch(render, /\.innerHTML\s*=/);
  assert.match(schedule, /const confirmed = window\.confirm\(/);
  assert.ok(
    schedule.indexOf('const confirmed = window.confirm(')
      < schedule.indexOf('window.api.schedulePrivateSermonStorageCleanup({')
  );
  assert.match(schedule, /candidateHash: summary\.candidateHash,\s*confirmed: true/);
  assert.match(
    schedule,
    /Nothing will be removed now[\s\S]*next startup[\s\S]*recheck the exact file set/
  );
});

test('renderer exposes removal only for a fresh eligible aggregate and schedules no live delete', async () => {
  const elementNames = [
    'btnCheckSermonStorage',
    'btnScheduleSermonStorageCleanup',
    'sermonStorageBadge',
    'sermonStorageStatus',
    'sermonStorageStatusTitle',
    'sermonStorageStatusDetail',
    'sermonStorageSummary',
    'sermonStorageTotal',
    'sermonStorageProtected',
    'sermonStorageWaiting',
    'sermonStorageEligible',
    'sermonStorageActionStatus'
  ];
  const elements = Object.fromEntries(elementNames.map(name => [
    name,
    {
      textContent: '',
      hidden: false,
      disabled: false,
      dataset: {}
    }
  ]));
  const state = {
    sermonStorage: {
      summary: null,
      checking: false,
      scheduling: false,
      scheduled: false,
      error: null,
      actionMessage: ''
    }
  };
  const scheduledRequests = [];
  const context = {
    console,
    elements,
    state,
    window: {
      confirm: () => true,
      api: {
        async schedulePrivateSermonStorageCleanup(request) {
          scheduledRequests.push({ ...request });
          return {
            scheduled: true,
            requiresRestart: true,
            candidateHash: request.candidateHash,
            eligibleObjectCount: 1,
            eligibleBytes: 300
          };
        }
      }
    },
    operatorErrorMessage(error, fallback) {
      return error?.message || fallback;
    }
  };
  vm.runInNewContext([
    functionBlock(rendererSource, 'storageBytesLabel'),
    functionBlock(rendererSource, 'storageCountAndBytes'),
    functionBlock(rendererSource, 'normalizeSermonStorageSummary'),
    functionBlock(rendererSource, 'renderPrivateSermonStorage'),
    functionBlock(rendererSource, 'schedulePrivateSermonStorageCleanup')
  ].join('\n\n'), context);

  const candidateHash = 'c'.repeat(64);
  state.sermonStorage.summary = context.normalizeSermonStorageSummary({
    schemaVersion: 1,
    auditedAt: '2026-07-28T20:00:00.000Z',
    retentionDays: 90,
    objectCount: 3,
    objectBytes: 600,
    referencedObjectCount: 1,
    referencedBytes: 100,
    unreferencedObjectCount: 2,
    unreferencedBytes: 500,
    waitingObjectCount: 1,
    waitingBytes: 200,
    eligibleObjectCount: 1,
    eligibleBytes: 300,
    candidateHash,
    startupCleanup: {
      status: 'no-confirmed-plan',
      causeCode: null,
      deletedObjectCount: 0,
      deletedBytes: 0
    }
  });
  context.renderPrivateSermonStorage();
  assert.equal(elements.btnScheduleSermonStorageCleanup.hidden, false);
  assert.equal(elements.btnScheduleSermonStorageCleanup.disabled, false);
  assert.equal(elements.sermonStorageStatus.dataset.kind, 'attention');
  assert.match(elements.sermonStorageStatusTitle.textContent, /1 file is eligible/);
  assert.equal(
    Object.values(elements).some(element =>
      String(element.textContent).includes(candidateHash)
    ),
    false,
    'the opaque candidate hash must never be rendered'
  );

  await context.schedulePrivateSermonStorageCleanup();
  assert.deepEqual(scheduledRequests, [{
    candidateHash,
    confirmed: true
  }]);
  assert.equal(state.sermonStorage.scheduled, true);
  assert.equal(elements.btnScheduleSermonStorageCleanup.hidden, true);
  assert.equal(elements.btnCheckSermonStorage.disabled, true);
  assert.match(
    elements.sermonStorageStatusDetail.textContent,
    /Nothing was removed while SyncShow was open/
  );

  assert.throws(
    () => context.normalizeSermonStorageSummary({
      ...state.sermonStorage.summary,
      objectCount: 4
    }),
    /invalid private sermon storage summary/
  );
});
