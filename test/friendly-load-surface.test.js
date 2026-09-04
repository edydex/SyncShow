'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const rendererDirectory = path.join(__dirname, '..', 'src', 'renderer');
const html = fs.readFileSync(path.join(rendererDirectory, 'index.html'), 'utf8');
const appSource = fs.readFileSync(path.join(rendererDirectory, 'app.js'), 'utf8');
const css = fs.readFileSync(path.join(rendererDirectory, 'styles.css'), 'utf8');
const mainSource = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
const preloadSource = fs.readFileSync(path.join(__dirname, '..', 'preload.js'), 'utf8');

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function elementBlockById(source, id) {
  const startExpression = new RegExp(
    `<([a-z][a-z0-9-]*)\\b[^>]*\\bid="${escapeRegExp(id)}"[^>]*>`,
    'i'
  );
  const startMatch = startExpression.exec(source);
  assert.ok(startMatch, `expected #${id} in renderer HTML`);

  const tagName = startMatch[1].toLowerCase();
  const startIndex = startMatch.index;
  const tokenExpression = new RegExp(`<\\/?${escapeRegExp(tagName)}\\b[^>]*>`, 'gi');
  tokenExpression.lastIndex = startIndex;
  let depth = 0;
  let token;

  while ((token = tokenExpression.exec(source))) {
    if (token[0].startsWith('</')) {
      depth -= 1;
      if (depth === 0) return source.slice(startIndex, tokenExpression.lastIndex);
    } else if (!token[0].endsWith('/>')) {
      depth += 1;
    }
  }

  assert.fail(`could not find closing </${tagName}> for #${id}`);
}

function functionBlock(source, functionName) {
  const start = source.indexOf(`function ${functionName}(`);
  assert.notEqual(start, -1, `expected function ${functionName}()`);
  const next = source.indexOf('\nfunction ', start + 1);
  return source.slice(start, next === -1 ? source.length : next);
}

function assertContainsId(source, id, message) {
  assert.match(source, new RegExp(`\\bid="${escapeRegExp(id)}"`), message);
}

function assertDoesNotContainId(source, id, message) {
  assert.doesNotMatch(source, new RegExp(`\\bid="${escapeRegExp(id)}"`), message);
}

test('Friendly Load keeps only operator essentials on the normal surface', () => {
  const setupPanel = elementBlockById(html, 'setupPanel');
  const loadEssentials = elementBlockById(html, 'loadEssentials');
  const adminDialog = elementBlockById(html, 'advancedSetupDetails');

  assert.match(html, /<body class="friendly-mode load-stage">/,
    'Friendly Mode must remain the default Load experience');
  assertContainsId(loadEssentials, 'inputCards',
    'configured slideshow inputs belong on the normal Load surface');
  assert.match(loadEssentials, /class="[^"]*\bload-intro\b/,
    'the concise Load introduction belongs on the normal surface');
  assert.match(loadEssentials, /class="[^"]*\breadiness-card\b/,
    'readiness and actionable exceptions belong on the normal surface');
  assertContainsId(html, 'btnStartPresentation',
    'the primary Start Show action must remain available');
  assertDoesNotContainId(adminDialog, 'inputCards',
    'configured input cards must not be buried in Admin Settings');
  assertDoesNotContainId(adminDialog, 'btnStartPresentation',
    'Start Show must not be buried in Admin Settings');

  assertContainsId(setupPanel, 'loadEssentials');
  assertContainsId(setupPanel, 'advancedSetupDetails');
  assertDoesNotContainId(loadEssentials, 'advancedSetupDetails',
    'Admin Settings must be a sibling surface, not inline Load clutter');
  assertDoesNotContainId(loadEssentials, 'serviceFolderCard',
    'folder setup must not appear among normal operator essentials');
});

test('Load offers one clear Community path and one separate PPTX setup path', () => {
  const loadEssentials = elementBlockById(html, 'loadEssentials');

  assertContainsId(loadEssentials, 'btnOpenCommunityServiceFromLoad');
  assertContainsId(loadEssentials, 'btnOpenPptxImportFromLoad');
  assert.match(loadEssentials, /Open from Heritage Community/);
  assert.match(loadEssentials, /Import PPTXs/);
  assert.match(
    appSource,
    /elements\.btnOpenPptxImportFromLoad\.addEventListener\('click', \(\) => \{\s*openSettings\('google-drive'\)/,
    'Import PPTXs must open the independent Google Drive and PPTX settings tab'
  );
});

test('Prepare follows the Community planner workspace instead of a three-column dashboard', () => {
  const preparePanel = elementBlockById(html, 'preparePanel');
  const serviceMenu = elementBlockById(preparePanel, 'prepareServiceMenu');

  assertContainsId(serviceMenu, 'prepareProjectList');
  assertContainsId(serviceMenu, 'prepareSharedServices');
  assertContainsId(serviceMenu, 'prepareCommunityPlans');
  assert.match(preparePanel, /class="[^"]*\bprepare-rundown-pane\b/);
  assert.match(preparePanel, /class="[^"]*\bprepare-library-pane\b/);
  assert.doesNotMatch(preparePanel, /class="[^"]*\bprepare-projects-pane\b/,
    'saved services must be in the compact service menu, not a permanent third column');

  assertContainsId(preparePanel, 'preparePreviewTabs');
  assert.match(preparePanel, /id="preparePreviewTabs"[^>]*role="tablist"/);
  for (const label of ['Songs', 'Media', 'Scripture', 'Sermon templates', 'More slide types']) {
    assert.match(preparePanel, new RegExp(`>${escapeRegExp(label)}<`));
  }
  assert.match(preparePanel, /data-prepare-add-tab="songs"/);
  assert.match(preparePanel, /data-prepare-add-panel="songs"/);
  assert.match(appSource, /function activatePrepareAddTab\(/);
  assert.match(appSource, /function handlePrepareAddTabKeydown\(/);
  assert.match(css, /\.prepare-preview-tab\[aria-selected="true"\]/);
  assert.match(css, /\.prepare-add-panel\[hidden\]/);
});

test('folder, display, output, profile, input, output, and timing controls live in Admin Settings', () => {
  const adminDialog = elementBlockById(html, 'advancedSetupDetails');
  assert.match(
    adminDialog,
    /^<dialog\b[^>]*\bid="advancedSetupDetails"[^>]*\bclass="[^"]*\badmin-settings-dialog\b[^"]*"[^>]*>/,
    'Admin Settings must be a separate modal dialog'
  );

  for (const id of [
    'serviceFolderCard',
    'btnRefreshDisplays',
    'btnIdentifyDisplays',
    'friendlyMode',
    'outputHealthSummary',
    'venueProfileSection',
    'profileServiceFolder',
    'profileTimeZone',
    'profileServiceDateOrder',
    'inputRoleSettingsList',
    'outputSettingsList',
    'fadeDuration',
    'singerLanguage',
    'singerFontSize',
    'singerCharLimit',
    'singerTextPadding',
    'syncMode'
  ]) {
    assertContainsId(adminDialog, id, `#${id} must be contained by Admin Settings`);
  }

  assertContainsId(adminDialog, 'btnCloseAdminSettings',
    'the modal must have an explicit close action');
  assertContainsId(adminDialog, 'expertSettingsSection',
    'advanced venue controls must remain available to admins');
  assertContainsId(html, 'advancedWarningDialog',
    'the existing advanced-mode safety warning must be preserved');
});

test('Admin Settings separates Community, Google Drive, and screens into accessible tabs', () => {
  const adminDialog = elementBlockById(html, 'advancedSetupDetails');
  const communityPanel = elementBlockById(adminDialog, 'settingsCommunityPanel');
  const drivePanel = elementBlockById(adminDialog, 'settingsGoogleDrivePanel');
  const screensPanel = elementBlockById(adminDialog, 'settingsScreensPanel');

  assert.match(adminDialog, /id="adminSettingsTabs"[^>]*role="tablist"/);
  assert.match(adminDialog, /id="settingsTabCommunity"[^>]*role="tab"[^>]*aria-selected="true"[^>]*data-settings-tab="community"/);
  assert.match(adminDialog, /id="settingsTabGoogleDrive"[^>]*role="tab"[^>]*data-settings-tab="google-drive"/);
  assert.match(adminDialog, /id="settingsTabScreens"[^>]*role="tab"[^>]*data-settings-tab="screens"/);

  assertContainsId(communityPanel, 'communityConnectionSection');
  assertContainsId(communityPanel, 'sermonStorageSection');
  assertDoesNotContainId(communityPanel, 'serviceFolderCard');
  assertContainsId(drivePanel, 'serviceFolderCard');
  assertDoesNotContainId(drivePanel, 'communityConnectionSection');
  assertContainsId(screensPanel, 'btnRefreshDisplays');
  assertContainsId(screensPanel, 'venueProfileSection');
  assertDoesNotContainId(screensPanel, 'serviceFolderCard');

  assert.match(appSource, /function activateSettingsTab\(/);
  assert.match(appSource, /function handleSettingsTabKeydown\(/);
  assert.match(css, /\.admin-settings-tab\[aria-selected="true"\]/);
  assert.match(css, /\.admin-settings-tab-panel\[hidden\]/);
});

test('the clearly labeled Admin Settings button opens and closes the modal', () => {
  assert.match(
    html,
    /<button\b[^>]*\bid="btnOpenSettings"[^>]*\baria-controls="advancedSetupDetails"[^>]*>\s*Admin Settings\s*<\/button>/,
    'the header entry point must clearly say Admin Settings'
  );
  assert.match(appSource,
    /elements\.btnOpenSettings\.addEventListener\('click', \(\) => openSettings\(\)\)/);
  assert.match(appSource,
    /elements\.btnCloseAdminSettings\.addEventListener\('click', closeSettings\)/);

  const openSettings = functionBlock(appSource, 'openSettings');
  const closeSettings = functionBlock(appSource, 'closeSettings');
  assert.match(openSettings, /elements\.advancedSetupDetails\.showModal\(\)/,
    'Admin Settings must open as a modal rather than expanding inline');
  assert.doesNotMatch(openSettings, /\.open\s*=\s*true/,
    'the removed inline details behavior must not return');
  assert.match(closeSettings, /elements\.advancedSetupDetails\.close\(\)/,
    'the explicit close action must close the modal');
});

test('linked-folder auto-load runs only after a fresh successful scan', () => {
  const initializeServiceFolder = functionBlock(appSource, 'initializeServiceFolder');
  const scanLinkedServiceFolder = functionBlock(appSource, 'scanLinkedServiceFolder');
  const maybeAutoLoad = functionBlock(appSource, 'maybeAutoLoadServiceSet');

  assert.match(initializeServiceFolder,
    /scanLinkedServiceFolder\(\{\s*reason:\s*'startup'\s*\}\)/,
    'startup must scan an admin-configured folder');

  for (const reason of ['startup', 'linked', 'date', 'profile-save']) {
    assert.match(maybeAutoLoad, new RegExp(`['"]${reason}['"]`),
      `${reason} scans must be eligible to populate the input cards automatically`);
  }
  assert.match(maybeAutoLoad, /presentation\.source === 'manual'/,
    'automatic loading must not replace a slideshow the operator chose manually');
  assert.match(maybeAutoLoad, /presentation\.source === 'prepared'/,
    'automatic loading must not replace a slideshow published from Prepare');
  assert.match(maybeAutoLoad, /\|\| hasOperatorOwnedPresentation/,
    'operator-owned slideshows must block the automatic service replacement');
  assert.match(maybeAutoLoad, /await loadSelectedServiceSet\(\)/,
    'automatic folder loading must reuse the same safe service loader as an explicit load');

  const freshnessCheck = scanLinkedServiceFolder.indexOf(
    'if (requestVersion !== state.serviceFolder.scanVersion) return;'
  );
  const validatedScan = scanLinkedServiceFolder.indexOf('state.serviceFolder.scan = scan;');
  const autoLoadCall = scanLinkedServiceFolder.indexOf('await maybeAutoLoadServiceSet(reason);');
  assert.ok(freshnessCheck >= 0, 'a superseded scan must be rejected');
  assert.ok(validatedScan > freshnessCheck,
    'the returned scan must be accepted only after the freshness check');
  assert.ok(autoLoadCall > validatedScan,
    'auto-load must run only after the fresh scan was validated and installed');

  const safeReasons = [...maybeAutoLoad.matchAll(/new Set\(\[([\s\S]*?)\]\)/g)]
    .map(match => match[1])
    .find(source => ['startup', 'linked', 'date', 'profile-save']
      .every(reason => new RegExp(`['"]${reason}['"]`).test(source)));
  assert.ok(safeReasons,
    'auto-load reasons must use an explicit allowlist so folder changes cannot replace live choices');
  assert.doesNotMatch(safeReasons, /folder-change|return-to-load|post-load-change/,
    'background folder changes must remain review-only once a service is loaded');
});

test('unsaved Admin Settings survive an accidental window close', () => {
  const rendererSync = functionBlock(appSource, 'syncProfileDraftCloseState');
  const closeGuard = functionBlock(mainSource, 'guardControlWindowClose');

  assert.match(preloadSource, /setSettingsDraftState:[\s\S]*ipcRenderer\.send\('settings:draftState'/,
    'the sandboxed renderer must expose only a narrow draft-state notification');
  assert.match(rendererSync, /dirty: state\.profileDirty/);
  assert.match(rendererSync, /saving: state\.profileSaveInFlight/);
  assert.match(appSource, /state\.profileDirty = false;\s+syncProfileDraftCloseState\(\)/,
    'committed or discarded profiles must clear the native close guard');
  assert.match(appSource, /state\.profileSaveInFlight = true;\s+syncProfileDraftCloseState\(\)/,
    'an in-flight profile save must reach the native close guard');
  assert.match(mainSource, /ipcMain\.on\('settings:draftState'/);
  assert.match(mainSource, /controlWindow\.on\('close', guardControlWindowClose\)/);
  assert.match(closeGuard, /controlSettingsDraftState\.saving/,
    'closing must wait for an in-flight profile save');
  assert.match(closeGuard, /controlSettingsDraftState\.dirty/,
    'closing must detect an unsaved profile draft');
  assert.match(closeGuard, /dialog\.showMessageBoxSync\(controlWindow/,
    'window and app close must use a visible native prompt');
  assert.match(closeGuard, /Discard Changes and Close/,
    'the operator must explicitly choose to discard staged Admin changes');
  assert.match(closeGuard, /event\.preventDefault\(\)/);
});
