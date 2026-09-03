'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { app, BrowserWindow } = require('electron');

const {
  LOCAL_SERVICE_PLAN_ORIGIN,
  LOCAL_SERVICE_PLAN_SCHEMA_VERSION
} = require('../../src/services/project');
const {
  ServiceProjectStore
} = require('../../src/services/project/ServiceProjectStore');

const RESULT_PATH =
  process.env.SYNCSHOW_FIRST_SERVICE_PLANNING_RESULT || '';
const SCREENSHOT_PATH =
  process.env.SYNCSHOW_FIRST_SERVICE_PLANNING_SCREENSHOT || '';
const TIMEOUT_MS = 45_000;

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

async function writeResult(result) {
  if (!path.isAbsolute(RESULT_PATH)) {
    throw new Error('The first-service planning result path must be absolute.');
  }
  await fs.writeFile(
    RESULT_PATH,
    `${JSON.stringify(result, null, 2)}\n`,
    { encoding: 'utf8', mode: 0o600 }
  );
}

async function run() {
  const controlWindow = await waitFor(() => {
    const candidate = BrowserWindow.getAllWindows().find(window =>
      !window.isDestroyed()
      && window.webContents.getURL().endsWith('/src/renderer/index.html'));
    return candidate?.webContents?.isLoading() ? null : candidate;
  }, 'the real SyncShow control window');

  await controlWindow.webContents.executeJavaScript(`
    (() => {
      document.querySelector('#btnStagePrepare')?.click();
      return true;
    })()
  `);

  await waitFor(
    () => controlWindow.webContents.executeJavaScript(`
      (() => {
        const button = document.querySelector('#btnNewServiceProject');
        return Boolean(button && !button.disabled);
      })()
    `),
    'the native Prepare workspace'
  );

  await controlWindow.webContents.executeJavaScript(`
    (() => {
      document.querySelector('#btnNewServiceProject').click();
      return document.querySelector('#newServiceProjectDialog').open;
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
        'First Native Planning Service';
      document.querySelector('#newServiceProjectDate').value = '2026-08-02';
      document.querySelector('#newServiceProjectStartTime').value = '09:15';
      document.querySelector('#newServiceProjectTeamNotes').value =
        'Sound check at 08:30. Communion this week.';
      document.querySelector('#newServiceProjectForm').requestSubmit();
      return true;
    })()
  `);

  const surface = await waitFor(
    () => controlWindow.webContents.executeJavaScript(`
      (() => {
        const dialog = document.querySelector('#newServiceProjectDialog');
        const panel = document.querySelector('#preparePlanningPanel');
        const notice = document.querySelector('#prepareNotice');
        const projectCount =
          document.querySelector('#prepareProjectCount')?.textContent || '';
        const readiness =
          document.querySelector('#prepareServiceReadinessBadge')?.textContent || '';
        if (
          dialog?.open
          || panel?.hidden
          || projectCount !== '1'
          || !/blocker/i.test(readiness)
        ) {
          return null;
        }
        return {
          heading: document.querySelector('#preparePlanningHeading')?.textContent || '',
          schedule: document.querySelector('#preparePlanningSchedule')?.textContent || '',
          notes: document.querySelector('#preparePlanningNotes')?.textContent || '',
          badge: document.querySelector('#preparePlanningBadge')?.textContent || '',
          readiness,
          notice: notice?.textContent?.trim() || '',
          projectCount,
          publishDisabled:
            document.querySelector('#btnPublishServiceProject')?.disabled === true
        };
      })()
    `),
    'the first service to open in Planning'
  );

  const store = new ServiceProjectStore({
    rootPath: path.join(app.getPath('userData'), 'service-projects')
  });
  const listing = await store.list({ pageSize: 10, offset: 0 });
  assert.equal(listing.total, 1);
  const reopened = await store.read(listing.items[0].id);

  assert.equal(reopened.project.title, 'First Native Planning Service');
  assert.equal(reopened.project.serviceDate, '2026-08-02');
  assert.equal(reopened.project.revision, 1);
  assert.deepEqual(reopened.project.planning, {
    schemaVersion: LOCAL_SERVICE_PLAN_SCHEMA_VERSION,
    status: 'planning',
    startTime: '09:15',
    origin: LOCAL_SERVICE_PLAN_ORIGIN,
    teamNotes: 'Sound check at 08:30. Communion this week.'
  });
  assert.equal(Object.hasOwn(reopened.project.planning, 'templateSource'), false);
  assert.equal(Object.hasOwn(reopened.project.planning, 'source'), false);
  assert.deepEqual(reopened.project.rootItemIds, []);

  assert.match(surface.heading, /^Planning · First Native Planning Service$/);
  assert.match(surface.schedule, /Aug 2, 2026 · 09:15 start/);
  assert.equal(
    surface.notes,
    'Team notes: Sound check at 08:30. Communion this week.'
  );
  assert.equal(surface.badge, 'Planning');
  assert.match(surface.readiness, /blocker/i);
  assert.match(
    surface.notice,
    /First Native Planning Service is open in Planning/
  );
  assert.equal(surface.projectCount, '1');
  assert.equal(surface.publishDisabled, true);

  if (SCREENSHOT_PATH) {
    if (
      !path.isAbsolute(SCREENSHOT_PATH)
      || !/\.(?:jpe?g|png)$/i.test(SCREENSHOT_PATH)
    ) {
      throw new Error('The first-service planning screenshot path is invalid.');
    }
    const image = await controlWindow.capturePage();
    const bytes = /\.png$/i.test(SCREENSHOT_PATH)
      ? image.toPNG()
      : image.toJPEG(90);
    await fs.writeFile(SCREENSHOT_PATH, bytes, { mode: 0o600 });
  }

  await writeResult({
    ok: true,
    projectId: reopened.project.id,
    revisionId: reopened.revisionId,
    projectRevision: reopened.project.revision,
    planning: reopened.project.planning,
    surface,
    screenshotCaptured: Boolean(SCREENSHOT_PATH)
  });
}

require('../../main');

app.whenReady().then(() => run())
  .then(() => app.quit())
  .catch(async error => {
    try {
      await writeResult({
        ok: false,
        error: error?.stack || String(error)
      });
    } catch (writeError) {
      console.error(writeError);
    }
    console.error(error);
    app.exit(1);
  });
