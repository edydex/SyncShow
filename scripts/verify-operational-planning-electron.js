'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const electronPath = require('electron');

const RESULT_FILE = 'operational-planning-electron.json';
const TIMEOUT_MS = 180_000;
const MAX_LOG_BYTES = 256 * 1024;
const WEEKLY_CHECK_IDS = Object.freeze([
  'compilable-nonempty',
  'song-present',
  'exact-sermon-link',
  'linked-sermon-material',
  'sermon-reading-before-material',
  'channel-visible-content'
]);
const WEEKLY_ACTION_LABELS = Object.freeze([
  'Add projected content',
  'Open Song Library',
  'Set up this week’s sermon',
  'Open sermon material',
  'Add reading before sermon',
  'Review output treatments'
]);

function boundedCollector(stream) {
  let value = '';
  stream.setEncoding('utf8');
  stream.on('data', chunk => {
    value = `${value}${chunk}`;
    if (Buffer.byteLength(value, 'utf8') > MAX_LOG_BYTES) {
      value = value.slice(-MAX_LOG_BYTES);
    }
  });
  return () => value;
}

function runElectron({ profilePath, resultPath, screenshotPath }) {
  const entryPath = path.resolve(
    __dirname,
    'fixtures',
    'operational-planning-electron-app.js'
  );
  const environment = { ...process.env };
  delete environment.ELECTRON_RUN_AS_NODE;
  environment.SYNCSHOW_TEST_USER_DATA_DIR = profilePath;
  environment.SYNCSHOW_OPERATIONAL_PLANNING_RESULT = resultPath;
  if (screenshotPath) {
    environment.SYNCSHOW_OPERATIONAL_PLANNING_SCREENSHOT = screenshotPath;
  }
  environment.ELECTRON_DISABLE_SECURITY_WARNINGS = 'true';

  return new Promise((resolve, reject) => {
    const child = spawn(electronPath, [
      entryPath,
      '--syncshow-test-user-data',
      '--headless'
    ], {
      cwd: path.resolve(__dirname, '..'),
      env: environment,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    const stdout = boundedCollector(child.stdout);
    const stderr = boundedCollector(child.stderr);
    let timedOut = false;
    let forceKillTimer = null;
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      forceKillTimer = setTimeout(() => child.kill('SIGKILL'), 5_000);
    }, TIMEOUT_MS);

    child.once('error', error => {
      clearTimeout(timeout);
      if (forceKillTimer) clearTimeout(forceKillTimer);
      reject(error);
    });
    child.once('close', (code, signal) => {
      clearTimeout(timeout);
      if (forceKillTimer) clearTimeout(forceKillTimer);
      resolve({
        code,
        signal,
        timedOut,
        stdout: stdout(),
        stderr: stderr()
      });
    });
  });
}

function screenshotOption() {
  const optionIndex = process.argv.indexOf('--screenshot');
  const screenshotPath = optionIndex >= 0
    ? process.argv[optionIndex + 1]
    : '';
  if (
    optionIndex >= 0
    && (
      !screenshotPath
      || !path.isAbsolute(screenshotPath)
      || !/\.(?:jpe?g|png)$/iu.test(screenshotPath)
    )
  ) {
    throw new Error(
      '--screenshot requires an absolute .png, .jpg, or .jpeg path.'
    );
  }
  return screenshotPath;
}

async function main() {
  const screenshotPath = screenshotOption();
  const root = await fs.mkdtemp(path.join(
    os.tmpdir(),
    'syncshow-operational-planning-'
  ));
  const profilePath = path.join(root, 'profile');
  const resultPath = path.join(profilePath, RESULT_FILE);
  await fs.mkdir(profilePath, { mode: 0o700 });
  if (screenshotPath) {
    await fs.mkdir(path.dirname(screenshotPath), { recursive: true });
  }

  try {
    const child = await runElectron({
      profilePath,
      resultPath,
      screenshotPath
    });
    let result;
    try {
      result = JSON.parse(await fs.readFile(resultPath, 'utf8'));
    } catch (error) {
      throw new Error([
        'The Electron operational-planning verifier did not produce a result.',
        `Exit code: ${child.code}; signal: ${child.signal || 'none'}; timed out: ${child.timedOut}.`,
        child.stdout ? `stdout:\n${child.stdout}` : '',
        child.stderr ? `stderr:\n${child.stderr}` : '',
        `Result read error: ${error.message}`
      ].filter(Boolean).join('\n'));
    }

    assert.equal(child.timedOut, false, 'Electron verification timed out.');
    assert.equal(child.code, 0, child.stderr || child.stdout);
    assert.equal(result.ok, true, result.stack || result.error);
    assert.equal(
      result.contract,
      'syncshow-operational-planning-real-electron-v2'
    );
    assert.equal(result.profileIsolated, true);
    assert.deepEqual(
      result.weeklyChecks.canonicalCheckIds,
      WEEKLY_CHECK_IDS
    );
    assert.deepEqual(
      result.weeklyChecks.actionLabels,
      WEEKLY_ACTION_LABELS
    );
    assert.equal(result.weeklyChecks.initial.projectRevision, 1);
    assert.match(
      result.weeklyChecks.initial.revisionId,
      /^[a-f0-9]{64}$/u
    );
    assert.equal(result.weeklyChecks.initial.rootItemCount, 0);
    assert.deepEqual(
      result.weeklyChecks.initial.surface.checkIds,
      WEEKLY_CHECK_IDS
    );
    assert.deepEqual(
      result.weeklyChecks.initial.surface.actionLabels,
      WEEKLY_ACTION_LABELS
    );
    assert.equal(
      result.weeklyChecks.initial.surface.primaryCheckId,
      'compilable-nonempty'
    );
    assert.equal(
      result.weeklyChecks.initial.surface.primaryText,
      'Continue setup · Add projected content'
    );
    assert.equal(result.weeklyChecks.initial.surface.badge, '6 blockers');
    assert.equal(
      result.weeklyChecks.initial.surface.summary,
      '0 cues · 6 blockers need review.'
    );
    assert.equal(
      result.weeklyChecks.primaryNavigation.activeElementId,
      'btnAddServiceText'
    );
    assert.equal(result.weeklyChecks.primaryNavigation.statusKind, 'ready');
    assert.deepEqual(
      result.weeklyChecks.primaryNavigation.openDialogs,
      []
    );
    assert.deepEqual(
      result.weeklyChecks.actionNavigations.map(navigation => ({
        checkId: navigation.checkId,
        activeElementId: navigation.activeElementId,
        statusKind: navigation.statusKind,
        openDialogs: navigation.openDialogs
      })),
      [
        {
          checkId: 'song-present',
          activeElementId: 'prepareSongSearch',
          statusKind: 'ready',
          openDialogs: []
        },
        {
          checkId: 'exact-sermon-link',
          activeElementId: 'btnAddServiceSermon',
          statusKind: 'ready',
          openDialogs: []
        },
        {
          checkId: 'linked-sermon-material',
          activeElementId: 'btnAddServiceSermon',
          statusKind: 'ready',
          openDialogs: []
        },
        {
          checkId: 'sermon-reading-before-material',
          activeElementId: 'btnAddServiceSermon',
          statusKind: 'ready',
          openDialogs: []
        },
        {
          checkId: 'channel-visible-content',
          activeElementId: 'btnAddServiceText',
          statusKind: 'ready',
          openDialogs: []
        }
      ]
    );
    assert.deepEqual(
      result.weeklyChecks.reviewDialog.checkIds,
      WEEKLY_CHECK_IDS
    );
    assert.deepEqual(
      result.weeklyChecks.reviewDialog.statuses,
      Array(6).fill('blocker')
    );
    assert.deepEqual(
      result.weeklyChecks.reviewDialog.openDialogs,
      ['serviceReadinessDialog']
    );
    assert.equal(
      result.weeklyChecks.unchangedAfterNavigation.projectRevision,
      result.weeklyChecks.initial.projectRevision
    );
    assert.equal(
      result.weeklyChecks.unchangedAfterNavigation.revisionId,
      result.weeklyChecks.initial.revisionId
    );
    assert.equal(
      result.weeklyChecks.unchangedAfterNavigation.rootItemCount,
      0
    );
    assert.equal(result.weeklyChecks.staleRefusal.detached, true);
    assert.equal(
      result.weeklyChecks.staleRefusal.originalCheckId,
      'compilable-nonempty'
    );
    assert.equal(
      result.weeklyChecks.staleRefusal.currentPrimaryCheckId,
      'song-present'
    );
    assert.equal(
      result.weeklyChecks.staleRefusal.activeElementId,
      'prepareWeeklySetupStatus'
    );
    assert.equal(result.weeklyChecks.staleRefusal.statusKind, 'warning');
    assert.match(
      result.weeklyChecks.staleRefusal.statusText,
      /older service revision[\s\S]*nothing was changed/u
    );
    assert.deepEqual(result.weeklyChecks.staleRefusal.openDialogs, []);
    assert.equal(
      result.weeklyChecks.staleRefusal.projectRevisionBefore,
      2
    );
    assert.equal(
      result.weeklyChecks.staleRefusal.projectRevisionAfter,
      result.weeklyChecks.staleRefusal.projectRevisionBefore
    );
    assert.equal(
      result.weeklyChecks.staleRefusal.revisionIdAfter,
      result.weeklyChecks.staleRefusal.revisionIdBefore
    );
    assert.equal(result.projectRevision, 4);
    assert.equal(result.item.plannedDurationSeconds, 450);
    assert.equal(result.serving.assignment.role, 'Scripture reader');
    assert.equal(result.serving.assignment.personName, 'Maria S.');
    assert.equal(result.serving.assignment.status, 'confirmed');
    assert.equal(result.serving.assignment.required, true);
    assert.equal(result.serving.assignment.callTime, '09:00');
    assert.deepEqual(result.serving.assignment.scope, {
      kind: 'item',
      itemId: result.item.id
    });
    assert.equal(result.surface.runSheet.badge, 'Timed');
    assert.equal(result.surface.runSheet.duration, '7 min 30 sec total');
    assert.equal(result.surface.runSheet.finish, '9:22:30 AM finish');
    assert.equal(result.surface.serving.badge, '1 filled');
    assert.equal(
      result.surface.serving.summary,
      '1 filled · 0 open · 0 required open'
    );

    const continuation = result.lifecycleContinuation;
    assert.equal(continuation.fixture, 'tracked-native-weekly-service');
    assert.equal(continuation.projectId, 'native-weekly-2026-08-09');
    assert.equal(continuation.planning.projectRevision, 3);
    assert.match(continuation.planning.revisionId, /^[a-f0-9]{64}$/u);
    assert.equal(continuation.planning.status, 'planning');
    assert.equal(continuation.planning.readinessReady, true);
    assert.deepEqual(
      continuation.planning.checkStatuses,
      WEEKLY_CHECK_IDS.map(id => ({ id, status: 'pass' }))
    );
    assert.equal(
      continuation.planning.surface.heading,
      'Planning · Native Weekly Service — August 9'
    );
    assert.deepEqual(
      continuation.planning.surface.checkStatuses,
      Array(6).fill('pass')
    );
    assert.equal(
      continuation.planning.surface.primaryText,
      'Review & mark Ready'
    );
    assert.equal(
      continuation.planning.surface.primaryKind,
      'review-ready'
    );
    assert.equal(continuation.planning.surface.primaryCheckId, '');
    assert.equal(continuation.planning.surface.ariaHasPopup, 'dialog');
    assert.equal(
      continuation.planning.surface.ariaControls,
      'serviceReadinessDialog'
    );
    assert.deepEqual(continuation.planning.surface.openDialogs, []);
    assert.equal(
      continuation.reviewDialog.activeElementId,
      'serviceReadinessTitle'
    );
    assert.deepEqual(continuation.reviewDialog.checkIds, WEEKLY_CHECK_IDS);
    assert.deepEqual(
      continuation.reviewDialog.statuses,
      Array(6).fill('pass')
    );
    assert.equal(continuation.reviewDialog.badge, 'Checks clear');
    assert.equal(continuation.reviewDialog.confirmationChecked, false);
    assert.equal(continuation.reviewDialog.markReadyDisabled, true);
    assert.deepEqual(
      continuation.reviewDialog.openDialogs,
      ['serviceReadinessDialog']
    );
    assert.deepEqual(continuation.humanConfirmation, {
      confirmationChecked: true,
      markReadyEnabledBeforeClick: true,
      clicked: true
    });
    assert.equal(
      continuation.ready.projectRevision,
      continuation.planning.projectRevision + 1
    );
    assert.match(continuation.ready.revisionId, /^[a-f0-9]{64}$/u);
    assert.notEqual(
      continuation.ready.revisionId,
      continuation.planning.revisionId
    );
    assert.equal(continuation.ready.status, 'ready');
    assert.equal(continuation.ready.readinessReady, true);
    assert.equal(
      continuation.ready.surface.heading,
      'Ready · Native Weekly Service — August 9'
    );
    assert.equal(
      continuation.ready.surface.primaryText,
      'Save & go to Load'
    );
    assert.equal(
      continuation.ready.surface.primaryKind,
      'publish-load'
    );
    assert.equal(continuation.ready.surface.primaryCheckId, '');
    assert.equal(
      continuation.ready.surface.activeElementId,
      'btnContinueWeeklySetup'
    );
    assert.deepEqual(continuation.ready.surface.openDialogs, []);
    assert.equal(continuation.load.handoffVisible, true);
    assert.equal(continuation.load.title, 'Native Weekly Service — August 9');
    assert.equal(continuation.load.badge, 'Ready');
    assert.match(continuation.load.schedule, /9 cues/u);
    assert.match(
      continuation.load.schedule,
      new RegExp(`exact revision ${continuation.ready.projectRevision}`, 'u')
    );
    assert.match(continuation.load.status, /ready in Load/u);
    assert.deepEqual(continuation.load.openDialogs, []);
    assert.equal(continuation.publishDidNotMutateProject, true);
    assert.match(
      continuation.currentPackage.packageId,
      /^show-[a-f0-9]{64}$/u
    );
    assert.match(
      continuation.currentPackage.manifestSha256,
      /^[a-f0-9]{64}$/u
    );
    assert.equal(
      continuation.currentPackage.projectId,
      continuation.projectId
    );
    assert.equal(
      continuation.currentPackage.projectRevision,
      continuation.ready.projectRevision
    );
    assert.equal(
      continuation.currentPackage.projectRevisionId,
      continuation.ready.revisionId
    );
    assert.equal(continuation.currentPackage.cueCount, 9);
    assert.deepEqual(
      continuation.currentPackage.roles,
      ['english', 'media', 'russian']
    );
    assert.deepEqual(
      continuation.currentPackage.sourceTypes,
      ['service-project']
    );
    assert.deepEqual(
      continuation.currentPackage.renderers,
      ['native-cue']
    );
    assert.equal(continuation.currentPackage.legacySceneCount, 0);
    assert.equal(
      continuation.currentPackage.containsPowerPointReference,
      false
    );
    assert.deepEqual(
      continuation.externalWrites.after.community,
      continuation.externalWrites.before.community
    );
    assert.deepEqual(
      continuation.externalWrites.after.communityMediaAttempts,
      continuation.externalWrites.before.communityMediaAttempts
    );
    assert.deepEqual(
      continuation.externalWrites.after.powerPointSlideCache,
      continuation.externalWrites.before.powerPointSlideCache
    );
    assert.equal(continuation.externalWrites.communityUnchanged, true);
    assert.equal(
      continuation.externalWrites.communityMediaAttemptsUnchanged,
      true
    );
    assert.equal(
      continuation.externalWrites.powerPointSlideCacheUnchanged,
      true
    );
    if (screenshotPath) {
      assert.equal(result.screenshot.captured, true);
      assert.equal(result.screenshot.path, screenshotPath);
      assert.ok(result.screenshot.bytes > 500);
      assert.match(result.screenshot.sha256, /^[a-f0-9]{64}$/u);
    } else {
      assert.deepEqual(result.screenshot, { captured: false });
    }

    process.stdout.write(`${JSON.stringify(result)}\n`);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
