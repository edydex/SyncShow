'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const electron = require('electron');
const { app, BrowserWindow } = electron;

const {
  ServiceProjectStore
} = require('../../src/services/project/ServiceProjectStore');
const {
  compileServiceProject
} = require('../../src/services/project');

const RESULT_PATH = process.env.SYNCSHOW_COMMUNITY_SERVICE_RESULT || '';
const BASE_URL = process.env.SYNCSHOW_COMMUNITY_SERVICE_BASE_URL || '';
const SCREENSHOT_ROOT =
  process.env.SYNCSHOW_COMMUNITY_SERVICE_SCREENSHOT_ROOT || '';
const TIMEOUT_MS = 180_000;

const fakeDisplays = [
  { id: 1, internal: true, bounds: { x: 0, y: 0, width: 1400, height: 900 } },
  { id: 2, internal: false, bounds: { x: 1400, y: 0, width: 1280, height: 720 } },
  { id: 3, internal: false, bounds: { x: 2680, y: 0, width: 1280, height: 720 } },
  { id: 4, internal: false, bounds: { x: 3960, y: 0, width: 1280, height: 720 } }
].map(display => ({
  ...display,
  size: { width: display.bounds.width, height: display.bounds.height },
  workArea: display.bounds,
  workAreaSize: { width: display.bounds.width, height: display.bounds.height },
  scaleFactor: 1,
  rotation: 0,
  touchSupport: 'unknown',
  monochrome: false,
  colorDepth: 24,
  depthPerComponent: 8,
  displayFrequency: 60
}));

app.once('ready', () => {
  const { screen } = electron;
  screen.getPrimaryDisplay = () => fakeDisplays[0];
  screen.getAllDisplays = () => fakeDisplays;
  screen.getDisplayMatching = bounds => {
    const centerX = bounds.x + bounds.width / 2;
    return fakeDisplays.find(display =>
      centerX >= display.bounds.x
      && centerX < display.bounds.x + display.bounds.width) || fakeDisplays[0];
  };
});

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
    await delay(75);
  }
  throw new Error(
    `Timed out waiting for ${label}.${lastError ? ` Last error: ${lastError.message}` : ''}`
  );
}

async function writeResult(value) {
  await fs.writeFile(RESULT_PATH, `${JSON.stringify(value, null, 2)}\n`, {
    mode: 0o600
  });
}

async function capture(controlWindow, name) {
  const target = path.join(SCREENSHOT_ROOT, `${name}.png`);
  const image = await controlWindow.capturePage();
  await fs.writeFile(target, image.toPNG(), { mode: 0o600 });
  return target;
}

async function renderer(controlWindow, source) {
  return controlWindow.webContents.executeJavaScript(source);
}

async function run() {
  assert.equal(path.isAbsolute(RESULT_PATH), true);
  assert.equal(path.isAbsolute(SCREENSHOT_ROOT), true);
  assert.match(BASE_URL, /^http:\/\/127\.0\.0\.1:\d+\/$/u);

  const controlWindow = await waitFor(() => {
    const candidate = BrowserWindow.getAllWindows().find(window =>
      !window.isDestroyed()
      && window.webContents.getURL().endsWith('/src/renderer/index.html'));
    return candidate?.webContents?.isLoading() ? null : candidate;
  }, 'the real SyncShow control window');

  const initialLoad = await waitFor(
    () => renderer(controlWindow, `(() => {
      const button = document.querySelector('#btnOpenCommunityServiceFromLoad');
      return document.body.classList.contains('load-stage') && button
        ? { text: button.textContent.trim(), disabled: button.disabled }
        : null;
    })()`),
    'the Load Community service action'
  );
  assert.equal(initialLoad.text, 'Open Community service…');

  await renderer(controlWindow, `document.querySelector('#btnOpenSettings').click()`);
  const settingsGate = await waitFor(
    () => renderer(controlWindow, `(() => {
      const state = {
        adminOpen: document.querySelector('#advancedSetupDetails')?.open === true,
        warningOpen: document.querySelector('#advancedWarningDialog')?.open === true
      };
      return state.adminOpen || state.warningOpen ? state : null;
    })()`),
    'the Admin Settings safety gate'
  );
  if (settingsGate.warningOpen) {
    await renderer(controlWindow, `document.querySelector('#btnConfirmAdvanced').click()`);
  }
  await waitFor(
    () => renderer(controlWindow, `Boolean(document.querySelector('#advancedSetupDetails')?.open)`),
    'Admin Settings'
  );
  await renderer(controlWindow, `(() => {
    document.querySelector('#communityServerUrl').value = ${JSON.stringify(BASE_URL)};
    document.querySelector('#communityAdminEmail').value = 'admin@wotbc.example';
    document.querySelector('#communityConnectionForm').requestSubmit();
    return true;
  })()`);

  const connection = await waitFor(
    () => renderer(controlWindow, `(() => {
      const badge = document.querySelector('#communityConnectionBadge')?.textContent?.trim() || '';
      const title = document.querySelector('#communityConnectionStatusTitle')?.textContent?.trim() || '';
      const detail = document.querySelector('#communityConnectionStatusDetail')?.textContent?.trim() || '';
      return badge === 'Connected' ? { badge, title, detail } : null;
    })()`),
    'the Community device authorization',
    45_000
  );
  await renderer(controlWindow, `document.querySelector('#btnCloseAdminSettings').click()`);
  await waitFor(
    () => renderer(controlWindow, `!document.querySelector('#advancedSetupDetails')?.open`),
    'Admin Settings to close'
  );
  const connectionApiStatus = await renderer(controlWindow, `window.api.getCommunityStatus()`);
  assert.equal(
    connectionApiStatus?.data?.connected,
    true,
    `Community status changed before service browsing: ${JSON.stringify(connectionApiStatus)}`
  );

  await renderer(controlWindow, `document.querySelector('#btnOpenCommunityServiceFromLoad').click()`);
  let sharedList;
  try {
    sharedList = await waitFor(
      () => renderer(controlWindow, `(() => {
        const dialog = document.querySelector('#sharedServicesDialog');
        const button = document.querySelector('.shared-service-button[data-sync-id="service-2026-08-23"]');
        const notice = document.querySelector('#sharedServicesNotice')?.textContent?.trim() || '';
        return dialog?.open && button && !button.disabled
          ? { title: button.querySelector('strong')?.textContent || '', detail: button.querySelector('span')?.textContent || '', notice }
          : null;
      })()`),
      'the August 23 Community service list',
      20_000
    );
  } catch (error) {
    const diagnostic = await renderer(controlWindow, `(() => ({
      bodyClass: document.body.className,
      dialogOpen: document.querySelector('#sharedServicesDialog')?.open === true,
      sharedCardStatus: document.querySelector('#prepareSharedServicesStatus')?.textContent?.trim() || '',
      notice: document.querySelector('#sharedServicesNotice')?.textContent?.trim() || '',
      listText: document.querySelector('#sharedServicesList')?.textContent?.trim() || '',
      loadButtonDisabled: document.querySelector('#btnOpenCommunityServiceFromLoad')?.disabled === true,
      prepareButtonDisabled: document.querySelector('#btnBrowseSharedServices')?.disabled === true,
      statusBar: document.querySelector('#statusMessage')?.textContent?.trim() || ''
    }))()`);
    await capture(controlWindow, '00-shared-list-failure');
    throw new Error(`${error.message} Diagnostic: ${JSON.stringify(diagnostic)}`);
  }
  const sharedListScreenshot = await capture(controlWindow, '01-community-service-list');
  await renderer(controlWindow, `document.querySelector('.shared-service-button[data-sync-id="service-2026-08-23"]').click()`);

  let prepareSurface;
  try {
    prepareSurface = await waitFor(
      () => renderer(controlWindow, `(() => {
        const dialog = document.querySelector('#sharedServicesDialog');
        const heading = document.querySelector('#preparePlanningHeading')?.textContent?.trim() || '';
        const rows = [...document.querySelectorAll('#prepareRundownList > [data-item-id]')];
        const notice = document.querySelector('#prepareNotice')?.textContent?.trim() || '';
        if (dialog?.open || !/Sunday Morning Service is open/.test(notice) || rows.length < 40) return null;
        return {
          heading,
          notice,
          projectCount: document.querySelector('#prepareProjectCount')?.textContent?.trim() || '',
          visibleItemRows: rows.length,
          publishDisabled: document.querySelector('#btnPublishServiceProject')?.disabled === true,
          sharedStatus: document.querySelector('#prepareSharedServicesStatus')?.textContent?.trim() || ''
        };
      })()`),
      'the exact service in Prepare',
      20_000
    );
  } catch (error) {
    const diagnostic = await renderer(controlWindow, `(() => ({
      dialogOpen: document.querySelector('#sharedServicesDialog')?.open === true,
      heading: document.querySelector('#preparePlanningHeading')?.textContent?.trim() || '',
      rundownCount: document.querySelectorAll('#prepareRundownList > [data-item-id]').length,
      rundownText: (document.querySelector('#prepareRundownList')?.textContent || '').trim().slice(0, 500),
      notice: document.querySelector('#prepareNotice')?.textContent?.trim() || '',
      projectCount: document.querySelector('#prepareProjectCount')?.textContent?.trim() || '',
      publishDisabled: document.querySelector('#btnPublishServiceProject')?.disabled === true,
      sharedNotice: document.querySelector('#sharedServicesNotice')?.textContent?.trim() || '',
      statusBar: document.querySelector('#statusMessage')?.textContent?.trim() || ''
    }))()`);
    await capture(controlWindow, '00-prepare-failure');
    throw new Error(`${error.message} Diagnostic: ${JSON.stringify(diagnostic)}`);
  }
  assert.equal(prepareSurface.publishDisabled, false);
  const prepareScreenshot = await capture(controlWindow, '02-prepare-aug23');

  const store = new ServiceProjectStore({
    rootPath: path.join(app.getPath('userData'), 'service-projects')
  });
  const stored = await store.read('service-2026-08-23');
  const timeline = compileServiceProject(stored.project);
  const installedAssets = [];
  for (const asset of Object.values(stored.project.assets)) {
    const resolved = await store.resolveAssetPath(
      stored.project.id,
      stored.revisionId,
      asset.id
    );
    const bytes = await fs.readFile(resolved.assetPath);
    installedAssets.push({
      id: asset.id,
      kind: asset.kind,
      size: bytes.length,
      sha256: crypto.createHash('sha256').update(bytes).digest('hex')
    });
  }
  assert.equal(installedAssets.every(asset => asset.id === `sha256:${asset.sha256}`), true);

  const offline = await fetch(`${BASE_URL}__verification/offline`, { method: 'POST' })
    .then(response => response.json());
  assert.equal(offline.offline, true);
  const offlineProbe = await fetch(`${BASE_URL}.well-known/heritage-community.json`);
  assert.equal(offlineProbe.status, 503);

  await renderer(controlWindow, `document.querySelector('#btnPublishServiceProject').click()`);
  const loadSurface = await waitFor(
    () => renderer(controlWindow, `(() => {
      if (!document.body.classList.contains('load-stage')) return null;
      const cards = [...document.querySelectorAll('#inputCards .deck-card')].map(card => ({
        roleId: card.dataset.roleId,
        title: card.querySelector('h3')?.textContent?.trim() || '',
        state: card.querySelector('.status-text')?.textContent?.trim() || ''
      }));
      const handoff = document.querySelector('#loadServiceHandoff');
      const start = document.querySelector('#btnStartPresentation');
      return handoff && !handoff.hidden && cards.length === 3 && start && !start.disabled
        ? {
          title: document.querySelector('#loadServiceHandoffTitle')?.textContent?.trim() || '',
          schedule: document.querySelector('#loadServiceHandoffSchedule')?.textContent?.trim() || '',
          badge: document.querySelector('#loadServiceHandoffBadge')?.textContent?.trim() || '',
          review: document.querySelector('#loadServiceHandoffReview')?.textContent?.trim() || '',
          cards,
          startDisabled: start.disabled
        }
        : null;
    })()`),
    'the offline prepared service in Load'
  );
  assert.deepEqual(loadSurface.cards.map(card => card.title), [
    'Russian',
    'English',
    'Stage-Facing Screen (Media)'
  ]);
  const loadScreenshot = await capture(controlWindow, '03-load-offline');

  await renderer(controlWindow, `(() => {
    // The fixture intentionally rehearses a past service. Accept the same
    // exact-service confirmation an operator sees when the service date and
    // today's Load date differ.
    window.confirm = () => true;
    document.querySelector('#btnStartPresentation').click();
  })()`);
  const showSurface = await waitFor(
    () => renderer(controlWindow, `(() => {
      if (!document.body.classList.contains('show-stage')) return null;
      const counter = document.querySelector('#totalSlides')?.textContent?.trim() || '';
      const title = document.querySelector('#showOutputStateTitle')?.textContent?.trim() || '';
      const detail = document.querySelector('#showOutputStateDetail')?.textContent?.trim() || '';
      return counter === '84' ? { counter, title, detail } : null;
    })()`),
    'the live Show stage',
    60_000
  );
  const outputWindows = BrowserWindow.getAllWindows().filter(window =>
    !window.isDestroyed()
    && window !== controlWindow
    && /\/src\/renderer\/(?:display|singer)\.html$/u.test(window.webContents.getURL()));
  assert.equal(outputWindows.length, 3);
  const outputSurfaces = await Promise.all(outputWindows.map(async window => ({
    url: window.webContents.getURL(),
    visible: window.isVisible(),
    bounds: window.getBounds(),
    surface: await window.webContents.executeJavaScript(`(() => ({
      ready: document.querySelector('#noSlide')?.textContent?.trim() || '',
      nativeSceneCount: document.querySelectorAll('.native-scene-host').length,
      activeNativeSceneCount: document.querySelectorAll(
        '.native-cue-layer.active .native-scene-host'
      ).length,
      nativeText: document.querySelector(
        '.native-cue-layer.active .native-scene-host'
      )?.textContent?.trim() || '',
      cleared: document.querySelector('#displayContainer')?.classList.contains('cleared') === true
    }))()`)
  })));
  assert.equal(outputSurfaces.every(output => output.visible), true);
  assert.equal(outputSurfaces.every(output => output.surface.nativeSceneCount > 0), true);
  assert.equal(outputSurfaces.every(output => output.surface.activeNativeSceneCount === 1), true);
  assert.equal(outputSurfaces.every(output => output.surface.nativeText.length > 0), true);
  const showScreenshot = await capture(controlWindow, '04-show-live');

  await writeResult({
    ok: true,
    initialLoad,
    connection,
    connectionApiStatus,
    sharedList,
    prepare: {
      ...prepareSurface,
      projectRevision: stored.project.revision,
      revisionId: stored.revisionId,
      channels: Object.values(stored.project.channels),
      itemCount: Object.keys(stored.project.items).length,
      assetCount: installedAssets.length,
      assetsVerified: installedAssets.length,
      cueCount: timeline.cueIds.length
    },
    offline: {
      serverStatusAfterDisconnect: offlineProbe.status,
      packageBuiltAfterDisconnect: true
    },
    load: loadSurface,
    show: {
      ...showSurface,
      outputCount: outputSurfaces.length,
      outputs: outputSurfaces
    },
    screenshots: {
      sharedList: sharedListScreenshot,
      prepare: prepareScreenshot,
      load: loadScreenshot,
      show: showScreenshot
    }
  });
}

require('../../main');

app.whenReady().then(run)
  .then(() => app.quit())
  .catch(async error => {
    try {
      await writeResult({ ok: false, error: error?.stack || String(error) });
    } catch (writeError) {
      console.error(writeError);
    }
    console.error(error);
    app.exit(1);
  });
