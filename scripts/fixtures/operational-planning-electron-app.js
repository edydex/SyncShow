'use strict';

// Electron-only entrypoint; keep this outside Node's automatic test discovery.

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const fsPromises = require('node:fs/promises');
const path = require('node:path');
const { app, BrowserWindow } = require('electron');

const {
  CurrentShowPackageStore,
  LOCAL_SERVICE_PLAN_ORIGIN,
  LOCAL_SERVICE_PLAN_SCHEMA_VERSION,
  ShowPackagePublisher,
  analyzeServiceProjectReadiness,
  setServicePlanStatus
} = require('../../src/services/project');
const {
  ServiceProjectStore
} = require('../../src/services/project/ServiceProjectStore');
const {
  ISOLATED_TEST_USER_DATA_MARKER
} = require('../../src/services/runtime/IsolatedTestUserData');
const {
  READY_PROJECT_ID,
  createTrackedNativeWeeklyService
} = require('../../test/fixtures/native-weekly-service');

const RESULT_FILE = 'operational-planning-electron.json';
const RESULT_PATH =
  process.env.SYNCSHOW_OPERATIONAL_PLANNING_RESULT || '';
const SCREENSHOT_PATH =
  process.env.SYNCSHOW_OPERATIONAL_PLANNING_SCREENSHOT || '';
const TIMEOUT_MS = 120_000;
const FONT_PATH = path.resolve(
  __dirname,
  '../../assets/fonts/NotoSans-Variable.ttf'
);
const NATIVE_WEEKLY_TITLE = 'Native Weekly Service — August 9';
const ASSIGNMENT_FIELDS = Object.freeze([
  'callTime',
  'id',
  'note',
  'personName',
  'required',
  'role',
  'scope',
  'status'
]);
const ASSIGNMENT_NOTE = 'Read from the pulpit.';
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

function delay(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

async function waitFor(callback, label, timeoutMs = TIMEOUT_MS) {
  const startedAt = Date.now();
  let lastError = null;
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const result = await callback();
      if (result) return result;
    } catch (error) {
      lastError = error;
    }
    await delay(50);
  }
  const suffix = lastError ? ` Last error: ${lastError.message}` : '';
  throw new Error(`Timed out waiting for ${label}.${suffix}`);
}

async function exerciseWeeklyReadinessAction(
  controlWindow,
  { checkId, expectedFocusId, primary = false }
) {
  const selector = primary
    ? '#btnContinueWeeklySetup'
    : `#prepareServiceReadinessChecks button[data-weekly-readiness-action="${checkId}"]`;
  const clicked = await controlWindow.webContents.executeJavaScript(`
    (() => {
      const button = document.querySelector(${JSON.stringify(selector)});
      if (!button || button.disabled || !button.getClientRects().length) {
        return false;
      }
      button.scrollIntoView({ block: 'nearest' });
      button.click();
      return true;
    })()
  `);
  assert.equal(clicked, true, `Weekly action ${checkId} was not clickable.`);

  return waitFor(
    () => controlWindow.webContents.executeJavaScript(`
      (() => {
        const activeElementId = document.activeElement?.id || '';
        const status = document.querySelector('#prepareWeeklySetupStatus');
        if (
          activeElementId !== ${JSON.stringify(expectedFocusId)}
          || !status
          || !status.textContent.trim()
        ) {
          return null;
        }
        return {
          checkId: ${JSON.stringify(checkId)},
          activeElementId,
          statusKind: status.dataset.kind || '',
          statusText: status.textContent.trim(),
          openDialogs: [...document.querySelectorAll('dialog[open]')]
            .map(dialog => dialog.id)
        };
      })()
    `),
    `${checkId} to move focus without changing the service`
  );
}

function confinedResultPath() {
  if (!path.isAbsolute(RESULT_PATH)) {
    throw new Error(
      'The operational-planning result path must be absolute.'
    );
  }
  const profilePath = fs.realpathSync(app.getPath('userData'));
  const resultParent = fs.realpathSync(path.dirname(RESULT_PATH));
  if (
    resultParent !== profilePath
    || path.basename(RESULT_PATH) !== RESULT_FILE
  ) {
    throw new Error(
      'The operational-planning result path escaped its isolated profile.'
    );
  }
  return RESULT_PATH;
}

async function writeResult(result) {
  await fsPromises.writeFile(
    confinedResultPath(),
    `${JSON.stringify(result, null, 2)}\n`,
    {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o600
    }
  );
}

function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

async function directorySnapshot(rootPath) {
  const entries = [];

  async function walk(directoryPath, relativeDirectory = '') {
    let children;
    try {
      children = await fsPromises.readdir(directoryPath, {
        withFileTypes: true
      });
    } catch (error) {
      if (error?.code === 'ENOENT' && relativeDirectory === '') {
        return false;
      }
      throw error;
    }
    children.sort((left, right) => left.name.localeCompare(right.name));
    for (const child of children) {
      const relativePath = relativeDirectory
        ? `${relativeDirectory}/${child.name}`
        : child.name;
      const childPath = path.join(directoryPath, child.name);
      if (child.isSymbolicLink()) {
        throw new Error(`Snapshot path contains a symbolic link: ${relativePath}`);
      }
      if (child.isDirectory()) {
        entries.push({ path: relativePath, kind: 'directory' });
        await walk(childPath, relativePath);
        continue;
      }
      if (!child.isFile()) {
        throw new Error(`Snapshot path contains an unsupported entry: ${relativePath}`);
      }
      const bytes = await fsPromises.readFile(childPath);
      entries.push({
        path: relativePath,
        kind: 'file',
        size: bytes.length,
        sha256: sha256(bytes)
      });
    }
    return true;
  }

  const exists = await walk(rootPath);
  return Object.freeze({
    exists,
    entryCount: entries.length,
    sha256: sha256(Buffer.from(JSON.stringify(entries), 'utf8'))
  });
}

async function noExternalWorkflowSnapshot(activeProfile) {
  return Object.freeze({
    community: await directorySnapshot(path.join(activeProfile, 'community')),
    communityMediaAttempts: await directorySnapshot(path.join(
      activeProfile,
      'community-sermon-media-attempts'
    )),
    powerPointSlideCache: await directorySnapshot(path.join(
      activeProfile,
      'slide-cache'
    ))
  });
}

async function capturePlanningSurface(controlWindow) {
  if (!SCREENSHOT_PATH) return { captured: false };
  if (
    !path.isAbsolute(SCREENSHOT_PATH)
    || !/\.(?:jpe?g|png)$/iu.test(SCREENSHOT_PATH)
  ) {
    throw new Error('The operational-planning screenshot path is invalid.');
  }

  const image = await controlWindow.webContents.capturePage();
  const size = image.getSize();
  const bytes = /\.png$/iu.test(SCREENSHOT_PATH)
    ? image.toPNG()
    : image.toJPEG(90);
  assert.equal(Buffer.isBuffer(bytes), true);
  assert.ok(bytes.length > 500);
  if (/\.png$/iu.test(SCREENSHOT_PATH)) {
    assert.equal(bytes.subarray(1, 4).toString('ascii'), 'PNG');
  } else {
    assert.deepEqual([...bytes.subarray(0, 3)], [0xff, 0xd8, 0xff]);
  }
  assert.ok(size.width >= 1000);
  assert.ok(size.height >= 700);

  await fsPromises.writeFile(SCREENSHOT_PATH, bytes, { mode: 0o600 });
  const reopened = await fsPromises.readFile(SCREENSHOT_PATH);
  assert.equal(reopened.length, bytes.length);
  assert.equal(sha256(reopened), sha256(bytes));
  return {
    captured: true,
    path: SCREENSHOT_PATH,
    bytes: bytes.length,
    sha256: sha256(bytes),
    width: size.width,
    height: size.height
  };
}

async function exerciseNativeLifecycleContinuation(
  controlWindow,
  activeProfile
) {
  const fixture = await createTrackedNativeWeeklyService(activeProfile);
  const planningProject = setServicePlanStatus(
    fixture.ready.project,
    'planning'
  );
  const planningStored = await fixture.projectStore.save(planningProject, {
    expectedRevisionId: fixture.ready.revisionId,
    reason: 'operational-continuation-planning'
  });
  assert.equal(planningStored.project.id, READY_PROJECT_ID);
  assert.equal(planningStored.project.title, NATIVE_WEEKLY_TITLE);
  assert.equal(planningStored.project.planning.status, 'planning');
  assert.equal(
    planningStored.project.revision,
    fixture.ready.project.revision + 1
  );

  const planningReadiness = analyzeServiceProjectReadiness(
    planningStored.project
  );
  assert.equal(planningReadiness.ready, true);
  assert.deepEqual(planningReadiness.blockers, []);
  assert.deepEqual(planningReadiness.waivedChecks, []);
  assert.deepEqual(
    planningReadiness.checks.map(check => [check.id, check.status]),
    WEEKLY_CHECK_IDS.map(checkId => [checkId, 'pass'])
  );

  const searchPrepared = await controlWindow.webContents.executeJavaScript(`
    (() => {
      const search = document.querySelector('#prepareProjectSearch');
      if (!search || search.disabled) return false;
      search.value = ${JSON.stringify(NATIVE_WEEKLY_TITLE)};
      search.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    })()
  `);
  assert.equal(searchPrepared, true);

  await waitFor(
    () => controlWindow.webContents.executeJavaScript(`
      (() => {
        const button = [...document.querySelectorAll(
          '#prepareProjectList button[data-project-id]'
        )].find(candidate =>
          candidate.dataset.projectId === ${JSON.stringify(READY_PROJECT_ID)}
        );
        if (!button || button.disabled || !button.getClientRects().length) {
          return false;
        }
        button.scrollIntoView({ block: 'nearest' });
        button.click();
        return true;
      })()
    `),
    'the tracked native Planning service in the real project list'
  );

  const planningSurface = await waitFor(
    () => controlWindow.webContents.executeJavaScript(`
      (() => {
        const primary = document.querySelector('#btnContinueWeeklySetup');
        const checks = [...document.querySelectorAll(
          '#prepareServiceReadinessChecks > li'
        )];
        const heading = document.querySelector('#preparePlanningHeading')
          ?.textContent?.trim() || '';
        if (
          heading !== ${JSON.stringify(`Planning · ${NATIVE_WEEKLY_TITLE}`)}
          || !primary
          || primary.disabled
          || !primary.getClientRects().length
          || primary.dataset.workflowContinuation !== 'review-ready'
          || primary.dataset.weeklyReadinessAction !== ''
          || primary.textContent.trim() !== 'Review & mark Ready'
          || checks.length !== 6
          || checks.some(check => check.dataset.status !== 'pass')
        ) {
          return null;
        }
        return {
          heading,
          checkStatuses: checks.map(check => check.dataset.status || ''),
          badge: document.querySelector('#prepareServiceReadinessBadge')
            ?.textContent?.trim() || '',
          summary: document.querySelector('#prepareServiceReadinessSummary')
            ?.textContent?.trim() || '',
          primaryText: primary.textContent.trim(),
          primaryKind: primary.dataset.workflowContinuation || '',
          primaryCheckId: primary.dataset.weeklyReadinessAction || '',
          ariaHasPopup: primary.getAttribute('aria-haspopup'),
          ariaControls: primary.getAttribute('aria-controls'),
          openDialogs: [...document.querySelectorAll('dialog[open]')]
            .map(dialog => dialog.id)
        };
      })()
    `),
    'all six tracked checks to clear with Review & mark Ready visible'
  );
  assert.deepEqual(planningSurface.checkStatuses, Array(6).fill('pass'));
  assert.equal(planningSurface.badge, 'Checks clear');
  assert.equal(planningSurface.primaryKind, 'review-ready');
  assert.equal(planningSurface.primaryCheckId, '');
  assert.equal(planningSurface.ariaHasPopup, 'dialog');
  assert.equal(planningSurface.ariaControls, 'serviceReadinessDialog');
  assert.deepEqual(planningSurface.openDialogs, []);

  // Let the renderer's read-only sermon/community lookups settle before the
  // lifecycle boundary. From this point through Load, these stores and the
  // PowerPoint conversion cache must remain byte-for-byte unchanged.
  await delay(500);
  const externalBefore = await noExternalWorkflowSnapshot(activeProfile);

  const reviewOpened = await controlWindow.webContents.executeJavaScript(`
    (() => {
      const button = document.querySelector('#btnContinueWeeklySetup');
      if (
        !button
        || button.disabled
        || button.dataset.workflowContinuation !== 'review-ready'
      ) return false;
      button.click();
      return true;
    })()
  `);
  assert.equal(reviewOpened, true);

  const reviewDialog = await waitFor(
    () => controlWindow.webContents.executeJavaScript(`
      (() => {
        const dialog = document.querySelector('#serviceReadinessDialog');
        const cards = [...document.querySelectorAll(
          '#serviceReadinessReviewChecks [data-readiness-check-id]'
        )];
        const confirmed = document.querySelector(
          '#serviceReadinessConfirmed'
        );
        const markReady = document.querySelector('#btnMarkServiceReady');
        if (
          !dialog?.open
          || document.activeElement?.id !== 'serviceReadinessTitle'
          || cards.length !== 6
          || cards.some(card => card.dataset.status !== 'pass')
          || confirmed?.checked !== false
          || markReady?.disabled !== true
        ) {
          return null;
        }
        return {
          activeElementId: document.activeElement.id,
          checkIds: cards.map(card => card.dataset.readinessCheckId || ''),
          statuses: cards.map(card => card.dataset.status || ''),
          badge: document.querySelector('#serviceReadinessDialogBadge')
            ?.textContent?.trim() || '',
          confirmationChecked: confirmed.checked,
          markReadyDisabled: markReady.disabled,
          openDialogs: [...document.querySelectorAll('dialog[open]')]
            .map(candidate => candidate.id)
        };
      })()
    `),
    'the readiness dialog opened by the lifecycle continuation'
  );
  assert.deepEqual(reviewDialog.checkIds, WEEKLY_CHECK_IDS);
  assert.deepEqual(reviewDialog.statuses, Array(6).fill('pass'));
  assert.equal(reviewDialog.badge, 'Checks clear');
  assert.deepEqual(reviewDialog.openDialogs, ['serviceReadinessDialog']);

  const humanConfirmation = await controlWindow.webContents
    .executeJavaScript(`
      (() => {
        const confirmed = document.querySelector(
          '#serviceReadinessConfirmed'
        );
        const markReady = document.querySelector('#btnMarkServiceReady');
        if (!confirmed || !markReady || confirmed.checked) return null;
        confirmed.click();
        if (!confirmed.checked || markReady.disabled) return null;
        markReady.click();
        return {
          confirmationChecked: confirmed.checked,
          markReadyEnabledBeforeClick: true,
          clicked: true
        };
      })()
    `);
  assert.deepEqual(humanConfirmation, {
    confirmationChecked: true,
    markReadyEnabledBeforeClick: true,
    clicked: true
  });

  const readySurface = await waitFor(
    () => controlWindow.webContents.executeJavaScript(`
      (() => {
        const dialog = document.querySelector('#serviceReadinessDialog');
        const primary = document.querySelector('#btnContinueWeeklySetup');
        const heading = document.querySelector('#preparePlanningHeading')
          ?.textContent?.trim() || '';
        const error = document.querySelector('#serviceReadinessError');
        if (
          dialog?.open
          && error
          && !error.hidden
          && error.textContent.trim()
        ) {
          throw new Error(error.textContent.trim());
        }
        if (
          dialog?.open
          || heading !== ${JSON.stringify(`Ready · ${NATIVE_WEEKLY_TITLE}`)}
          || !primary
          || primary.disabled
          || primary.dataset.workflowContinuation !== 'publish-load'
          || primary.dataset.weeklyReadinessAction !== ''
          || primary.textContent.trim() !== 'Save & go to Load'
          || document.activeElement?.id !== 'btnContinueWeeklySetup'
        ) {
          return null;
        }
        return {
          heading,
          primaryText: primary.textContent.trim(),
          primaryKind: primary.dataset.workflowContinuation || '',
          primaryCheckId: primary.dataset.weeklyReadinessAction || '',
          activeElementId: document.activeElement.id,
          statusText: document.querySelector('#prepareWeeklySetupStatus')
            ?.textContent?.trim() || '',
          openDialogs: [...document.querySelectorAll('dialog[open]')]
            .map(candidate => candidate.id)
        };
      })()
    `),
    'the exact reviewed revision to become Ready with Load still separate'
  );
  assert.equal(readySurface.primaryKind, 'publish-load');
  assert.equal(readySurface.primaryCheckId, '');
  assert.deepEqual(readySurface.openDialogs, []);

  const readyStored = await fixture.projectStore.read(READY_PROJECT_ID);
  assert.equal(readyStored.project.planning.status, 'ready');
  assert.equal(
    readyStored.project.revision,
    planningStored.project.revision + 1
  );
  assert.notEqual(readyStored.revisionId, planningStored.revisionId);
  const readyReadiness = analyzeServiceProjectReadiness(readyStored.project);
  assert.equal(readyReadiness.ready, true);
  assert.deepEqual(readyReadiness.blockers, []);

  const publishStarted = await controlWindow.webContents.executeJavaScript(`
    (() => {
      const button = document.querySelector('#btnContinueWeeklySetup');
      if (
        !button
        || button.disabled
        || button.dataset.workflowContinuation !== 'publish-load'
      ) return false;
      button.click();
      return true;
    })()
  `);
  assert.equal(publishStarted, true);

  const loadSurface = await waitFor(
    () => controlWindow.webContents.executeJavaScript(`
      (() => {
        const handoff = document.querySelector('#loadServiceHandoff');
        const title = document.querySelector('#loadServiceHandoffTitle')
          ?.textContent?.trim() || '';
        const badge = document.querySelector('#loadServiceHandoffBadge')
          ?.textContent?.trim() || '';
        const schedule = document.querySelector('#loadServiceHandoffSchedule')
          ?.textContent?.trim() || '';
        const status = document.querySelector('#statusMessage')
          ?.textContent?.trim() || '';
        if (
          !document.body.classList.contains('load-stage')
          || handoff?.hidden !== false
          || title !== ${JSON.stringify(NATIVE_WEEKLY_TITLE)}
          || badge !== 'Ready'
          || !schedule.includes('9 cues')
          || !schedule.includes('exact revision ${readyStored.project.revision}')
          || !status.includes('ready in Load')
        ) {
          return null;
        }
        return {
          bodyClass: document.body.className,
          title,
          badge,
          schedule,
          status,
          review: document.querySelector('#loadServiceHandoffReview')
            ?.textContent?.trim() || '',
          handoffVisible: handoff.hidden === false,
          openDialogs: [...document.querySelectorAll('dialog[open]')]
            .map(candidate => candidate.id)
        };
      })()
    `),
    'the real native publish path to finish on Load'
  );
  assert.equal(loadSurface.handoffVisible, true);
  assert.deepEqual(loadSurface.openDialogs, []);

  const unchangedAfterPublish = await fixture.projectStore.read(
    READY_PROJECT_ID
  );
  assert.equal(
    unchangedAfterPublish.project.revision,
    readyStored.project.revision
  );
  assert.equal(unchangedAfterPublish.revisionId, readyStored.revisionId);

  const currentStore = new CurrentShowPackageStore({
    rootPath: path.join(activeProfile, 'prepared-service')
  });
  const pointer = await currentStore.read();
  assert.ok(pointer);
  assert.equal(pointer.projectId, READY_PROJECT_ID);
  assert.equal(pointer.projectRevision, readyStored.project.revision);
  assert.equal(pointer.projectRevisionId, readyStored.revisionId);

  const publisher = new ShowPackagePublisher({
    projectStore: fixture.projectStore,
    rootPath: path.join(activeProfile, 'show-packages'),
    fontPath: FONT_PATH
  });
  const openedPackage = await publisher.open(pointer.packageId);
  assert.equal(openedPackage.manifest.projectId, READY_PROJECT_ID);
  assert.equal(
    openedPackage.manifest.projectRevisionId,
    readyStored.revisionId
  );
  assert.equal(openedPackage.manifest.projectRevision, readyStored.project.revision);
  assert.equal(openedPackage.manifest.cueCount, 9);
  assert.equal(openedPackage.serviceHandoff.planning.status, 'ready');
  assert.equal(openedPackage.serviceHandoff.readiness.ready, true);
  assert.deepEqual(
    openedPackage.serviceHandoff.readiness.checks.map(check => [
      check.id,
      check.status
    ]),
    WEEKLY_CHECK_IDS.map(checkId => [checkId, 'pass'])
  );
  const presentations = Object.values(openedPackage.presentations);
  assert.equal(presentations.length, 3);
  assert.equal(
    presentations.every(presentation =>
      presentation.sourceType === 'service-project'
      && presentation.renderer === 'native-cue'),
    true
  );
  assert.equal(
    presentations.some(presentation =>
      presentation.scenes.some(scene => scene.layout === 'legacy-deck')),
    false
  );
  const serializedNativeAuthority = JSON.stringify({
    project: readyStored.project,
    manifest: openedPackage.manifest,
    serviceHandoff: openedPackage.serviceHandoff,
    presentations: openedPackage.presentations
  });
  assert.doesNotMatch(
    serializedNativeAuthority,
    /\.pptx?\b|imported-deck|legacy-deck/iu
  );

  const externalAfter = await noExternalWorkflowSnapshot(activeProfile);
  assert.deepEqual(externalAfter.community, externalBefore.community);
  assert.deepEqual(
    externalAfter.communityMediaAttempts,
    externalBefore.communityMediaAttempts
  );
  assert.deepEqual(
    externalAfter.powerPointSlideCache,
    externalBefore.powerPointSlideCache
  );

  return {
    fixture: 'tracked-native-weekly-service',
    projectId: READY_PROJECT_ID,
    planning: {
      projectRevision: planningStored.project.revision,
      revisionId: planningStored.revisionId,
      status: planningStored.project.planning.status,
      readinessReady: planningReadiness.ready,
      checkStatuses: planningReadiness.checks.map(check => ({
        id: check.id,
        status: check.status
      })),
      surface: planningSurface
    },
    reviewDialog,
    humanConfirmation,
    ready: {
      projectRevision: readyStored.project.revision,
      revisionId: readyStored.revisionId,
      status: readyStored.project.planning.status,
      readinessReady: readyReadiness.ready,
      surface: readySurface
    },
    load: loadSurface,
    publishDidNotMutateProject: true,
    currentPackage: {
      packageId: pointer.packageId,
      manifestSha256: pointer.packageManifestSha256,
      projectId: pointer.projectId,
      projectRevision: pointer.projectRevision,
      projectRevisionId: pointer.projectRevisionId,
      cueCount: openedPackage.manifest.cueCount,
      roles: Object.keys(openedPackage.presentations).sort(),
      sourceTypes: [...new Set(presentations.map(
        presentation => presentation.sourceType
      ))],
      renderers: [...new Set(presentations.map(
        presentation => presentation.renderer
      ))],
      legacySceneCount: presentations.reduce(
        (count, presentation) => count + presentation.scenes.filter(
          scene => scene.layout === 'legacy-deck'
        ).length,
        0
      ),
      containsPowerPointReference: /\.pptx?\b|imported-deck|legacy-deck/iu
        .test(serializedNativeAuthority)
    },
    externalWrites: {
      before: externalBefore,
      after: externalAfter,
      communityUnchanged: true,
      communityMediaAttemptsUnchanged: true,
      powerPointSlideCacheUnchanged: true
    }
  };
}

async function run() {
  const requestedProfile =
    process.env.SYNCSHOW_TEST_USER_DATA_DIR || '';
  const activeProfile = fs.realpathSync(app.getPath('userData'));
  assert.equal(activeProfile, fs.realpathSync(requestedProfile));
  assert.equal(
    fs.readFileSync(
      path.join(activeProfile, ISOLATED_TEST_USER_DATA_MARKER),
      'utf8'
    ),
    'SyncShow isolated test user data v1\n'
  );
  if (process.platform === 'darwin' && app.dock) app.dock.hide();

  const controlWindow = await waitFor(() => {
    const candidate = BrowserWindow.getAllWindows().find(window =>
      !window.isDestroyed()
      && window.webContents.getURL().endsWith('/src/renderer/index.html'));
    return candidate?.webContents?.isLoading() ? null : candidate;
  }, 'the real SyncShow control window');

  controlWindow.setSize(1440, 1000, false);

  await controlWindow.webContents.executeJavaScript(`
    (() => {
      const button = document.querySelector('#btnStagePrepare');
      if (!button || button.disabled) return false;
      button.click();
      return true;
    })()
  `);

  await waitFor(
    () => controlWindow.webContents.executeJavaScript(`
      (() => {
        const button = document.querySelector('#btnNewServiceProject');
        return Boolean(button && !button.disabled && button.getClientRects().length);
      })()
    `),
    'the native Prepare workspace'
  );

  await controlWindow.webContents.executeJavaScript(`
    (() => {
      const button = document.querySelector('#btnNewServiceProject');
      button.scrollIntoView({ block: 'nearest' });
      button.click();
      return true;
    })()
  `);

  await waitFor(
    () => controlWindow.webContents.executeJavaScript(`
      Boolean(document.querySelector('#newServiceProjectDialog')?.open)
    `),
    'the New service dialog'
  );

  await controlWindow.webContents.executeJavaScript(`
    (() => {
      document.querySelector('#newServiceProjectName').value =
        'Operational Planning Rehearsal';
      document.querySelector('#newServiceProjectDate').value = '2026-08-09';
      document.querySelector('#newServiceProjectStartTime').value = '09:15';
      document.querySelector('#newServiceProjectTeamNotes').value =
        'Volunteer call time is 09:00.';
      document.querySelector('#newServiceProjectForm').requestSubmit();
      return true;
    })()
  `);

  await waitFor(
    () => controlWindow.webContents.executeJavaScript(`
      (() => {
        const dialog = document.querySelector('#newServiceProjectDialog');
        const panel = document.querySelector('#preparePlanningPanel');
        const heading =
          document.querySelector('#preparePlanningHeading')?.textContent || '';
        const addText = document.querySelector('#btnAddServiceText');
        if (
          dialog?.open
          || panel?.hidden
          || heading !== 'Planning · Operational Planning Rehearsal'
          || !addText
          || addText.disabled
        ) {
          return false;
        }
        return true;
      })()
    `),
    'the new local service in Planning'
  );

  const store = new ServiceProjectStore({
    rootPath: path.join(activeProfile, 'service-projects')
  });
  const initialListing = await store.list({ pageSize: 10, offset: 0 });
  assert.equal(initialListing.total, 1);
  const initialStoredProject = await store.read(initialListing.items[0].id);
  assert.equal(initialStoredProject.project.revision, 1);
  assert.deepEqual(initialStoredProject.project.rootItemIds, []);

  const initialWeeklySurface = await waitFor(
    () => controlWindow.webContents.executeJavaScript(`
      (() => {
        const list = document.querySelector('#prepareServiceReadinessChecks');
        const primary = document.querySelector('#btnContinueWeeklySetup');
        const songSearch = document.querySelector('#prepareSongSearch');
        const actions = list
          ? [...list.querySelectorAll(
              'button[data-weekly-readiness-action]'
            )]
          : [];
        if (
          !list
          || !primary
          || primary.disabled
          || !primary.getClientRects().length
          || actions.length !== 6
          || actions.some(button => button.disabled)
          || !songSearch
          || songSearch.disabled
        ) {
          return null;
        }
        window.__syncshowOperationalStaleWeeklyAction = actions[0];
        return {
          checkIds: actions.map(button =>
            button.dataset.weeklyReadinessAction || ''),
          actionLabels: actions.map(button => button.textContent.trim()),
          primaryCheckId:
            primary.dataset.weeklyReadinessAction || '',
          primaryText: primary.textContent.trim(),
          badge:
            document.querySelector('#prepareServiceReadinessBadge')
              ?.textContent?.trim() || '',
          summary:
            document.querySelector('#prepareServiceReadinessSummary')
              ?.textContent?.trim() || '',
          storedActionConnected:
            window.__syncshowOperationalStaleWeeklyAction.isConnected
        };
      })()
    `),
    'all six blank-service Weekly Check actions'
  );
  assert.deepEqual(initialWeeklySurface.checkIds, WEEKLY_CHECK_IDS);
  assert.deepEqual(initialWeeklySurface.actionLabels, WEEKLY_ACTION_LABELS);
  assert.equal(initialWeeklySurface.primaryCheckId, WEEKLY_CHECK_IDS[0]);
  assert.equal(
    initialWeeklySurface.primaryText,
    `Continue setup · ${WEEKLY_ACTION_LABELS[0]}`
  );
  assert.equal(initialWeeklySurface.badge, '6 blockers');
  assert.equal(initialWeeklySurface.summary, '0 cues · 6 blockers need review.');
  assert.equal(initialWeeklySurface.storedActionConnected, true);

  const primaryNavigation = await exerciseWeeklyReadinessAction(
    controlWindow,
    {
      checkId: 'compilable-nonempty',
      expectedFocusId: 'btnAddServiceText',
      primary: true
    }
  );
  const actionNavigations = [];
  for (const action of [
    {
      checkId: 'song-present',
      expectedFocusId: 'prepareSongSearch'
    },
    {
      checkId: 'exact-sermon-link',
      expectedFocusId: 'btnAddServiceSermon'
    },
    {
      checkId: 'linked-sermon-material',
      expectedFocusId: 'btnAddServiceSermon'
    },
    {
      checkId: 'sermon-reading-before-material',
      expectedFocusId: 'btnAddServiceSermon'
    },
    {
      checkId: 'channel-visible-content',
      expectedFocusId: 'btnAddServiceText'
    }
  ]) {
    actionNavigations.push(await exerciseWeeklyReadinessAction(
      controlWindow,
      action
    ));
  }
  for (const navigation of [primaryNavigation, ...actionNavigations]) {
    assert.equal(navigation.statusKind, 'ready');
    assert.deepEqual(navigation.openDialogs, []);
  }

  await controlWindow.webContents.executeJavaScript(`
    (() => {
      const button = document.querySelector('#btnReviewServiceReadiness');
      if (!button || button.disabled) return false;
      button.scrollIntoView({ block: 'nearest' });
      button.click();
      return true;
    })()
  `);
  const reviewDialog = await waitFor(
    () => controlWindow.webContents.executeJavaScript(`
      (() => {
        const dialog = document.querySelector('#serviceReadinessDialog');
        const cards = [...document.querySelectorAll(
          '#serviceReadinessReviewChecks [data-readiness-check-id]'
        )];
        if (
          !dialog?.open
          || cards.length !== 6
          || document.activeElement?.id !== 'serviceReadinessStartTime'
        ) {
          return null;
        }
        return {
          open: true,
          activeElementId: document.activeElement.id,
          checkIds: cards.map(card => card.dataset.readinessCheckId || ''),
          statuses: cards.map(card => card.dataset.status || ''),
          openDialogs: [...document.querySelectorAll('dialog[open]')]
            .map(candidate => candidate.id)
        };
      })()
    `),
    'the exact-revision Weekly Check review dialog'
  );
  assert.deepEqual(reviewDialog.checkIds, WEEKLY_CHECK_IDS);
  assert.deepEqual(reviewDialog.statuses, Array(6).fill('blocker'));
  assert.deepEqual(reviewDialog.openDialogs, ['serviceReadinessDialog']);

  await controlWindow.webContents.executeJavaScript(`
    (() => {
      const button = document.querySelector('#btnCancelServiceReadiness');
      if (!button || button.disabled) return false;
      button.click();
      return true;
    })()
  `);
  await waitFor(
    () => controlWindow.webContents.executeJavaScript(`
      (() => {
        const dialog = document.querySelector('#serviceReadinessDialog');
        return !dialog?.open
          && document.activeElement?.id === 'btnReviewServiceReadiness';
      })()
    `),
    'the readiness review to close without a save'
  );

  const unchangedAfterNavigation = await store.read(
    initialStoredProject.project.id
  );
  assert.equal(
    unchangedAfterNavigation.project.revision,
    initialStoredProject.project.revision
  );
  assert.equal(
    unchangedAfterNavigation.revisionId,
    initialStoredProject.revisionId
  );
  assert.deepEqual(unchangedAfterNavigation.project.rootItemIds, []);
  const detachedBeforeMutation = await controlWindow.webContents
    .executeJavaScript(`
      (() => {
        const button = window.__syncshowOperationalStaleWeeklyAction;
        if (!button || button.disabled) return false;
        button.remove();
        return !button.isConnected && !button.disabled;
      })()
    `);
  assert.equal(detachedBeforeMutation, true);

  await controlWindow.webContents.executeJavaScript(`
    (() => {
      const button = document.querySelector('#btnAddServiceText');
      button.scrollIntoView({ block: 'nearest' });
      button.click();
      return true;
    })()
  `);

  await waitFor(
    () => controlWindow.webContents.executeJavaScript(`
      Boolean(document.querySelector('#addServiceTextDialog')?.open)
    `),
    'the Add text dialog'
  );

  await controlWindow.webContents.executeJavaScript(`
    (() => {
      const kind = document.querySelector('#addServiceTextKind');
      const title = document.querySelector('#addServiceTextTitleInput');
      const body = document.querySelector('#addServiceTextBody');
      kind.value = 'notice';
      kind.dispatchEvent(new Event('change', { bubbles: true }));
      title.value = 'Scripture Reading';
      title.dispatchEvent(new Event('input', { bubbles: true }));
      body.value = 'Please stand for the reading of God’s Word.';
      body.dispatchEvent(new Event('input', { bubbles: true }));
      document.querySelector('#addServiceTextForm').requestSubmit();
      return true;
    })()
  `);

  const selectedItem = await waitFor(
    () => controlWindow.webContents.executeJavaScript(`
      (() => {
        const dialog = document.querySelector('#addServiceTextDialog');
        const selected = document.querySelector(
          '#prepareRundownList button[data-item-id][aria-current="true"]'
        );
        const edit = document.querySelector('#btnEditPrepareItem');
        const error = document.querySelector('#addServiceTextError');
        if (
          dialog?.open
          && error
          && !error.hidden
          && error.textContent.trim()
        ) {
          throw new Error(error.textContent.trim());
        }
        if (
          dialog?.open
          || !selected
          || !selected.dataset.itemId
          || !/Scripture Reading/u.test(selected.textContent)
          || edit?.disabled
        ) {
          return null;
        }
        return {
          id: selected.dataset.itemId,
          label: selected.getAttribute('aria-label') || '',
          text: selected.textContent.trim()
        };
      })()
    `),
    'the newly added notice to be automatically selected'
  );

  const storedAfterAddText = await store.read(initialStoredProject.project.id);
  assert.equal(storedAfterAddText.project.revision, 2);
  assert.deepEqual(storedAfterAddText.project.rootItemIds, [selectedItem.id]);
  const staleClickStarted = await controlWindow.webContents.executeJavaScript(`
    (() => {
      const button = window.__syncshowOperationalStaleWeeklyAction;
      if (!button || button.isConnected || button.disabled) return false;
      button.click();
      return true;
    })()
  `);
  assert.equal(staleClickStarted, true);
  const staleRefusal = await waitFor(
    () => controlWindow.webContents.executeJavaScript(`
      (() => {
        const status = document.querySelector('#prepareWeeklySetupStatus');
        const primary = document.querySelector('#btnContinueWeeklySetup');
        if (
          status?.dataset?.kind !== 'warning'
          || document.activeElement?.id !== 'prepareWeeklySetupStatus'
          || !/older service revision/u.test(status.textContent)
          || !/nothing was changed/u.test(status.textContent)
        ) {
          return null;
        }
        return {
          detached: !window.__syncshowOperationalStaleWeeklyAction.isConnected,
          originalCheckId:
            window.__syncshowOperationalStaleWeeklyAction
              .dataset.weeklyReadinessAction || '',
          currentPrimaryCheckId:
            primary?.dataset?.weeklyReadinessAction || '',
          activeElementId: document.activeElement.id,
          statusKind: status.dataset.kind,
          statusText: status.textContent.trim(),
          openDialogs: [...document.querySelectorAll('dialog[open]')]
            .map(dialog => dialog.id)
        };
      })()
    `),
    'the detached old Weekly Check action to be refused as stale'
  );
  assert.equal(staleRefusal.detached, true);
  assert.equal(staleRefusal.originalCheckId, 'compilable-nonempty');
  assert.equal(staleRefusal.currentPrimaryCheckId, 'song-present');
  assert.deepEqual(staleRefusal.openDialogs, []);
  await delay(100);
  const storedAfterStaleRefusal = await store.read(
    initialStoredProject.project.id
  );
  assert.equal(
    storedAfterStaleRefusal.project.revision,
    storedAfterAddText.project.revision
  );
  assert.equal(
    storedAfterStaleRefusal.revisionId,
    storedAfterAddText.revisionId
  );
  assert.deepEqual(
    storedAfterStaleRefusal.project.rootItemIds,
    storedAfterAddText.project.rootItemIds
  );

  await controlWindow.webContents.executeJavaScript(`
    (() => {
      const button = document.querySelector('#btnEditPrepareItem');
      button.scrollIntoView({ block: 'nearest' });
      button.click();
      return true;
    })()
  `);

  await waitFor(
    () => controlWindow.webContents.executeJavaScript(`
      (() => {
        const dialog = document.querySelector('#editServiceItemDialog');
        const runSheet = document.querySelector('#editServiceItemRunSheet');
        const scheduled = document.querySelector('#editServiceItemScheduled');
        const minutes =
          document.querySelector('#editServiceItemDurationMinutes');
        const seconds =
          document.querySelector('#editServiceItemDurationSeconds');
        if (!dialog?.open || runSheet?.hidden) return false;
        if (scheduled.checked || !minutes.disabled || !seconds.disabled) {
          throw new Error(
            'A newly added item must begin untimed with disabled duration fields.'
          );
        }
        return true;
      })()
    `),
    'the native item run-sheet editor'
  );

  await controlWindow.webContents.executeJavaScript(`
    (() => {
      const scheduled = document.querySelector('#editServiceItemScheduled');
      const minutes =
        document.querySelector('#editServiceItemDurationMinutes');
      const seconds =
        document.querySelector('#editServiceItemDurationSeconds');
      scheduled.checked = true;
      scheduled.dispatchEvent(new Event('change', { bubbles: true }));
      minutes.value = '7';
      minutes.dispatchEvent(new Event('input', { bubbles: true }));
      seconds.value = '30';
      seconds.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    })()
  `);

  await waitFor(
    () => controlWindow.webContents.executeJavaScript(`
      (() => {
        const minutes =
          document.querySelector('#editServiceItemDurationMinutes');
        const seconds =
          document.querySelector('#editServiceItemDurationSeconds');
        const status =
          document.querySelector('#editServiceItemDurationStatus')
            ?.textContent?.trim() || '';
        return !minutes.disabled
          && !seconds.disabled
          && minutes.value === '7'
          && seconds.value === '30'
          && status === 'Planned duration: 7 min 30 sec.';
      })()
    `),
    'the explicit 7 minute 30 second duration'
  );

  await controlWindow.webContents.executeJavaScript(`
    (() => {
      document.querySelector('#editServiceItemForm').requestSubmit();
      return true;
    })()
  `);

  await waitFor(
    () => controlWindow.webContents.executeJavaScript(`
      (() => {
        const dialog = document.querySelector('#editServiceItemDialog');
        const error = document.querySelector('#editServiceItemError');
        if (
          dialog?.open
          && error
          && !error.hidden
          && error.textContent.trim()
        ) {
          throw new Error(error.textContent.trim());
        }
        return !dialog?.open
          && document.querySelector('#prepareRunSheetBadge')
            ?.textContent?.trim() === 'Timed'
          && document.querySelector('#prepareRunSheetDuration')
            ?.textContent?.trim() === '7 min 30 sec total'
          && document.querySelector('#prepareRunSheetFinish')
            ?.textContent?.trim() === '9:22:30 AM finish';
      })()
    `),
    'the saved run-sheet summary'
  );

  await controlWindow.webContents.executeJavaScript(`
    (() => {
      const button = document.querySelector('#btnManageServingTeam');
      if (!button || button.disabled) return false;
      button.scrollIntoView({ block: 'nearest' });
      button.click();
      return true;
    })()
  `);

  await waitFor(
    () => controlWindow.webContents.executeJavaScript(`
      Boolean(document.querySelector('#manageServingTeamDialog')?.open)
    `),
    'the serving-team dialog'
  );

  await controlWindow.webContents.executeJavaScript(`
    (() => {
      const button = document.querySelector('#btnAddServingTeamAssignment');
      if (!button || button.disabled) return false;
      button.click();
      return true;
    })()
  `);

  await waitFor(
    () => controlWindow.webContents.executeJavaScript(`
      Boolean(document.querySelector(
        '#manageServingTeamRows [data-serving-assignment-id]'
      ))
    `),
    'a new serving assignment row'
  );

  const itemIdSource = JSON.stringify(selectedItem.id);
  const assignmentDraft = await controlWindow.webContents.executeJavaScript(`
    (() => {
      const row = document.querySelector(
        '#manageServingTeamRows [data-serving-assignment-id]'
      );
      const control = field => row.querySelector(
        '[data-serving-field="' + field + '"]'
      );
      const role = control('role');
      const status = control('status');
      const person = control('personName');
      const scope = control('scope');
      const required = control('required');
      const callTime = control('callTime');
      const note = control('note');

      role.value = 'Scripture reader';
      role.dispatchEvent(new Event('input', { bubbles: true }));
      status.value = 'confirmed';
      status.dispatchEvent(new Event('change', { bubbles: true }));
      person.value = 'Maria S.';
      person.dispatchEvent(new Event('input', { bubbles: true }));
      scope.value = 'item:' + ${itemIdSource};
      scope.dispatchEvent(new Event('change', { bubbles: true }));
      required.value = 'true';
      required.dispatchEvent(new Event('change', { bubbles: true }));
      callTime.value = '09:00';
      callTime.dispatchEvent(new Event('input', { bubbles: true }));
      note.value = ${JSON.stringify(ASSIGNMENT_NOTE)};
      note.dispatchEvent(new Event('input', { bubbles: true }));
      return {
        id: row.dataset.servingAssignmentId,
        role: role.value,
        personName: person.value,
        status: status.value,
        scope: scope.value,
        required: required.value,
        callTime: callTime.value,
        note: note.value,
        personDisabled: person.disabled
      };
    })()
  `);

  assert.equal(assignmentDraft.role, 'Scripture reader');
  assert.equal(assignmentDraft.personName, 'Maria S.');
  assert.equal(assignmentDraft.status, 'confirmed');
  assert.equal(assignmentDraft.scope, `item:${selectedItem.id}`);
  assert.equal(assignmentDraft.required, 'true');
  assert.equal(assignmentDraft.callTime, '09:00');
  assert.equal(assignmentDraft.note, ASSIGNMENT_NOTE);
  assert.equal(assignmentDraft.personDisabled, false);

  await controlWindow.webContents.executeJavaScript(`
    (() => {
      document.querySelector('#manageServingTeamForm').requestSubmit();
      return true;
    })()
  `);

  const surface = await waitFor(
    () => controlWindow.webContents.executeJavaScript(`
      (() => {
        const dialog = document.querySelector('#manageServingTeamDialog');
        const error = document.querySelector('#manageServingTeamError');
        if (
          dialog?.open
          && error
          && !error.hidden
          && error.textContent.trim()
        ) {
          throw new Error(error.textContent.trim());
        }
        const operational =
          document.querySelector('#preparePlanningOperationalSummary');
        const runSheet = {
          badge:
            document.querySelector('#prepareRunSheetBadge')
              ?.textContent?.trim() || '',
          summary:
            document.querySelector('#prepareRunSheetSummary')
              ?.textContent?.trim() || '',
          duration:
            document.querySelector('#prepareRunSheetDuration')
              ?.textContent?.trim() || '',
          finish:
            document.querySelector('#prepareRunSheetFinish')
              ?.textContent?.trim() || ''
        };
        const serving = {
          badge:
            document.querySelector('#prepareServingTeamBadge')
              ?.textContent?.trim() || '',
          summary:
            document.querySelector('#prepareServingTeamSummary')
              ?.textContent?.trim() || ''
        };
        if (
          dialog?.open
          || operational?.hidden
          || runSheet.badge !== 'Timed'
          || runSheet.summary !==
            'Every service slot has enough timing to calculate the expected finish.'
          || runSheet.duration !== '7 min 30 sec total'
          || runSheet.finish !== '9:22:30 AM finish'
          || serving.badge !== '1 filled'
          || serving.summary !==
            '1 filled · 0 open · 0 required open'
        ) {
          return null;
        }
        return {
          heading:
            document.querySelector('#preparePlanningHeading')
              ?.textContent?.trim() || '',
          schedule:
            document.querySelector('#preparePlanningSchedule')
              ?.textContent?.trim() || '',
          notes:
            document.querySelector('#preparePlanningNotes')
              ?.textContent?.trim() || '',
          selectedItemId:
            document.querySelector(
              '#prepareRundownList button[data-item-id][aria-current="true"]'
            )?.dataset?.itemId || null,
          runSheet,
          serving,
          openDialogs: [...document.querySelectorAll('dialog[open]')]
            .map(candidate => candidate.id)
        };
      })()
    `),
    'the settled Planning operational summaries'
  );

  assert.equal(surface.heading, 'Planning · Operational Planning Rehearsal');
  assert.match(surface.schedule, /09:15 start$/u);
  assert.equal(surface.notes, 'Team notes: Volunteer call time is 09:00.');
  assert.equal(surface.selectedItemId, selectedItem.id);
  assert.deepEqual(surface.openDialogs, []);

  const listing = await store.list({ pageSize: 10, offset: 0 });
  assert.equal(listing.total, 1);
  assert.equal(listing.items[0].title, 'Operational Planning Rehearsal');
  const reopened = await store.read(listing.items[0].id);

  assert.equal(reopened.project.id, listing.items[0].id);
  assert.equal(reopened.project.title, 'Operational Planning Rehearsal');
  assert.equal(reopened.project.serviceDate, '2026-08-09');
  assert.equal(reopened.project.revision, 4);
  assert.equal(reopened.project.planning.schemaVersion, LOCAL_SERVICE_PLAN_SCHEMA_VERSION);
  assert.equal(reopened.project.planning.status, 'planning');
  assert.equal(reopened.project.planning.startTime, '09:15');
  assert.equal(reopened.project.planning.origin, LOCAL_SERVICE_PLAN_ORIGIN);
  assert.equal(
    reopened.project.planning.teamNotes,
    'Volunteer call time is 09:00.'
  );
  assert.deepEqual(reopened.project.rootItemIds, [selectedItem.id]);

  const item = reopened.project.items[selectedItem.id];
  assert.ok(item);
  assert.equal(item.kind, 'notice');
  assert.equal(item.title, 'Scripture Reading');
  assert.equal(
    Object.prototype.hasOwnProperty.call(item, 'plannedDurationSeconds'),
    true
  );
  assert.equal(item.plannedDurationSeconds, 450);

  const serving = reopened.project.planning.serving;
  assert.deepEqual(Object.keys(serving).sort(), [
    'assignments',
    'schemaVersion'
  ]);
  assert.equal(serving.schemaVersion, 1);
  assert.equal(serving.assignments.length, 1);
  const assignment = serving.assignments[0];
  assert.deepEqual(Object.keys(assignment).sort(), ASSIGNMENT_FIELDS);
  assert.match(assignment.id, /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u);
  assert.equal(assignment.id, assignmentDraft.id);
  assert.equal(assignment.role, 'Scripture reader');
  assert.equal(assignment.personName, 'Maria S.');
  assert.deepEqual(assignment.scope, {
    kind: 'item',
    itemId: selectedItem.id
  });
  assert.deepEqual(Object.keys(assignment.scope).sort(), ['itemId', 'kind']);
  assert.equal(assignment.status, 'confirmed');
  assert.equal(assignment.required, true);
  assert.equal(assignment.callTime, '09:00');
  assert.equal(assignment.note, ASSIGNMENT_NOTE);
  assert.doesNotMatch(
    JSON.stringify(serving),
    /"(?:email|phone|accountId|contactId|directory|path)"/iu
  );

  const captureSurface = await controlWindow.webContents.executeJavaScript(`
    (() => {
      document.activeElement?.blur?.();
      const panel = document.querySelector('#preparePlanningPanel');
      panel?.scrollIntoView?.({ block: 'start' });
      return {
        panelVisible: Boolean(panel && !panel.hidden),
        operationalVisible:
          document.querySelector('#preparePlanningOperationalSummary')
            ?.hidden === false,
        openDialogs: document.querySelectorAll('dialog[open]').length
      };
    })()
  `);
  assert.deepEqual(captureSurface, {
    panelVisible: true,
    operationalVisible: true,
    openDialogs: 0
  });
  await delay(150);
  const screenshot = await capturePlanningSurface(controlWindow);
  const lifecycleContinuation = await exerciseNativeLifecycleContinuation(
    controlWindow,
    activeProfile
  );

  return {
    ok: true,
    contract: 'syncshow-operational-planning-real-electron-v2',
    profileIsolated: true,
    productionMainPreloadRenderer: true,
    projectId: reopened.project.id,
    revisionId: reopened.revisionId,
    projectRevision: reopened.project.revision,
    weeklyChecks: {
      canonicalCheckIds: WEEKLY_CHECK_IDS,
      actionLabels: WEEKLY_ACTION_LABELS,
      initial: {
        projectRevision: initialStoredProject.project.revision,
        revisionId: initialStoredProject.revisionId,
        rootItemCount: initialStoredProject.project.rootItemIds.length,
        surface: initialWeeklySurface
      },
      primaryNavigation,
      actionNavigations,
      reviewDialog,
      unchangedAfterNavigation: {
        projectRevision: unchangedAfterNavigation.project.revision,
        revisionId: unchangedAfterNavigation.revisionId,
        rootItemCount: unchangedAfterNavigation.project.rootItemIds.length
      },
      staleRefusal: {
        ...staleRefusal,
        projectRevisionBefore: storedAfterAddText.project.revision,
        projectRevisionAfter: storedAfterStaleRefusal.project.revision,
        revisionIdBefore: storedAfterAddText.revisionId,
        revisionIdAfter: storedAfterStaleRefusal.revisionId
      }
    },
    planning: {
      schemaVersion: reopened.project.planning.schemaVersion,
      status: reopened.project.planning.status,
      startTime: reopened.project.planning.startTime,
      origin: reopened.project.planning.origin,
      teamNotes: reopened.project.planning.teamNotes
    },
    item: {
      id: item.id,
      kind: item.kind,
      title: item.title,
      plannedDurationSeconds: item.plannedDurationSeconds
    },
    serving: {
      schemaVersion: serving.schemaVersion,
      assignment
    },
    selectedItem,
    surface,
    screenshot,
    lifecycleContinuation
  };
}

require('../../main');

app.whenReady().then(async () => {
  let exitCode = 0;
  try {
    const result = await run();
    await writeResult(result);
  } catch (error) {
    exitCode = 1;
    try {
      await writeResult({
        ok: false,
        contract: 'syncshow-operational-planning-real-electron-v2',
        profileIsolated: false,
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : null
      });
    } catch (writeError) {
      console.error(
        '[Operational planning Electron verifier] Could not write failure result:',
        writeError
      );
    }
    console.error('[Operational planning Electron verifier] Failed:', error);
  } finally {
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed()) window.destroy();
    }
    app.exit(exitCode);
  }
}).catch(error => {
  console.error(
    '[Operational planning Electron verifier] App readiness failed:',
    error
  );
  app.exit(1);
});
