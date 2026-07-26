'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  VenueProfileError,
  normalizeVenueProfile
} = require('../src/services/profile');

const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'src', 'renderer', 'index.html'), 'utf8');
const appSource = fs.readFileSync(path.join(root, 'src', 'renderer', 'app.js'), 'utf8');
const mainSource = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
const preloadSource = fs.readFileSync(path.join(root, 'preload.js'), 'utf8');
const oauthFlowSource = fs.readFileSync(
  path.join(root, 'src', 'services', 'google-drive', 'GoogleOAuthFlow.js'),
  'utf8'
);
const driveStoreSource = fs.readFileSync(
  path.join(root, 'src', 'services', 'google-drive', 'DriveConnectionStore.js'),
  'utf8'
);

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

test('direct Google Drive setup stays in Admin Settings while Friendly Load stays card-only', () => {
  const loadEssentials = elementBlockById(html, 'loadEssentials');
  const adminDialog = elementBlockById(html, 'advancedSetupDetails');
  const driveAdminIds = [
    'btnConnectPrivateDrive',
    'publicDriveFolderUrl',
    'btnLinkPublicDrive',
    'driveSetupNotice',
    'btnDisconnectServiceSource',
    'drivePublishingControl',
    'drivePublishingEnabled',
    'drivePublishingHelp'
  ];

  assertContainsId(loadEssentials, 'inputCards',
    'Friendly Load must remain driven by the configured slideshow cards');
  assertContainsId(loadEssentials, 'loadAutoStatus',
    'Friendly Load may expose only the compact automatic-loading status');

  for (const id of driveAdminIds) {
    assertContainsId(adminDialog, id, `#${id} must be contained by Admin Settings`);
    assertDoesNotContainId(loadEssentials, id, `#${id} must not clutter Friendly Load`);
  }
  assert.doesNotMatch(
    loadEssentials,
    /Private Google Drive|Public Drive link|Paste a public Google Drive folder link/,
    'Friendly Load must not contain Drive connection instructions'
  );
});

test('Admin Settings presents private, public-view, and local source choices with visible status', () => {
  const adminDialog = elementBlockById(html, 'advancedSetupDetails');

  assert.match(
    adminDialog,
    /id="btnConnectPrivateDrive"[\s\S]*?<strong>Private Google Drive<\/strong>[\s\S]*?Sign in and choose one folder/
  );
  assert.match(
    adminDialog,
    /<input id="publicDriveFolderUrl"[^>]+type="url"[^>]+maxlength="2048"/,
    'the public source accepts a bounded URL rather than a raw Drive ID'
  );
  assert.match(adminDialog, /<strong>Public Drive link<\/strong>[\s\S]*?No sign-in · view-only/);
  assert.match(adminDialog, /id="btnLinkPublicDrive"[^>]*>\s*Connect\s*<\/button>/);
  assert.match(adminDialog, /id="btnChooseServiceFolder"[\s\S]*?Folder on this computer/);
  assert.match(adminDialog, /id="serviceFolderStateBadge"[^>]*>Not linked<\/span>/);
  assert.match(adminDialog, /id="serviceFolderScanStatus"[^>]+role="status"/);
  assert.match(adminDialog, /id="driveSetupNotice"[^>]+role="status"/);
  assert.match(adminDialog, /id="btnDisconnectServiceSource"[^>]+hidden/);
  assert.match(adminDialog, /id="drivePublishingControl"[^>]+hidden/);
  assert.match(adminDialog, /Background loading never changes Drive files/);
});

test('unconfigured Drive choices are visibly unavailable and cannot be submitted by keyboard', () => {
  const adminDialog = elementBlockById(html, 'advancedSetupDetails');
  const setupListeners = functionBlock(appSource, 'setupEventListeners');
  const privateConnect = functionBlock(appSource, 'connectPrivateDrive');
  const publicConnect = functionBlock(appSource, 'linkPublicDrive');
  const renderer = functionBlock(appSource, 'renderServiceFolder');

  assertContainsId(adminDialog, 'privateDriveSourceHelp');
  assertContainsId(adminDialog, 'publicDriveSourceOption');
  assertContainsId(adminDialog, 'publicDriveSourceHelp');
  assert.match(
    setupListeners,
    /publicDriveFolderUrl\.disabled\s*\|\|\s*elements\.btnLinkPublicDrive\.disabled\)\s*return;[\s\S]*?linkPublicDrive\(\)/,
    'Enter must use the same disabled configuration gate as the Connect button'
  );
  assert.ok(
    privateConnect.indexOf('if (!privateDriveIsConfigured())') <
      privateConnect.indexOf('window.api.connectPrivateDrive()'),
    'private OAuth configuration must be checked before invoking main'
  );
  assert.ok(
    publicConnect.indexOf('if (!publicDriveIsConfigured())') <
      publicConnect.indexOf('window.api.linkPublicDrive({ url })'),
    'public-link configuration must be checked before invoking main'
  );
  assert.match(
    renderer,
    /publicDriveFolderUrl\.disabled\s*=\s*sourceBusy\s*\|\|\s*!publicDriveReady/
  );
  assert.match(
    renderer,
    /btnLinkPublicDrive\.disabled\s*=\s*sourceBusy\s*\|\|\s*!publicDriveReady/
  );
  assert.match(
    renderer,
    /btnLinkPublicDrive\.textContent\s*=\s*publicDriveReady\s*\?\s*'Connect'\s*:\s*'Unavailable'/
  );
  assert.match(renderer, /classList\.toggle\('is-unavailable',\s*!publicDriveReady\)/);
  assert.match(renderer, /Google Drive is not enabled in this copy of SyncShow/);
});

test('preload exposes narrow Drive actions without credentials or arbitrary Drive resource IDs', () => {
  const driveStart = preloadSource.indexOf('getDriveStatus:');
  const driveEnd = preloadSource.indexOf('// Coherent service-folder discovery', driveStart);
  const driveBridge = preloadSource.slice(driveStart, driveEnd);
  const scanStart = preloadSource.indexOf('scanServiceFolder:');
  const scanEnd = preloadSource.indexOf('// PPTX conversion', scanStart);
  const scanBridge = preloadSource.slice(scanStart, scanEnd);

  assert.ok(driveStart >= 0 && driveEnd > driveStart, 'expected a dedicated Drive preload bridge');
  assert.match(driveBridge, /getDriveStatus:\s*\(\)\s*=>\s*ipcRenderer\.invoke\('drive:status'\)/);
  assert.match(driveBridge, /connectPrivateDrive:\s*\(\)\s*=>\s*ipcRenderer\.invoke\('drive:connectPrivate'\)/);
  assert.match(
    driveBridge,
    /getPrivateDriveOAuthState:\s*\(\)\s*=>\s*ipcRenderer\.invoke\('drive:privateOAuthState'\)/
  );
  assert.match(
    driveBridge,
    /copyPrivateDriveOAuthLink:\s*\(\)\s*=>\s*ipcRenderer\.invoke\('drive:copyPrivateOAuthUrl'\)/
  );
  assert.match(
    driveBridge,
    /cancelPrivateDriveOAuth:\s*\(\)\s*=>\s*ipcRenderer\.invoke\('drive:cancelPrivateOAuth'\)/
  );
  assert.match(
    driveBridge,
    /linkPublicDrive:[\s\S]*ipcRenderer\.invoke\('drive:linkPublic',\s*\{\s*url:\s*request\?\.url\s*\}\)/
  );
  assert.match(
    driveBridge,
    /setDrivePublishingEnabled:[\s\S]*enabled:\s*enabled === true/
  );
  assert.match(
    driveBridge,
    /disconnectDrive:[\s\S]*connectionId:\s*request\?\.connectionId/
  );
  assert.doesNotMatch(
    driveBridge,
    /\b(?:accessToken|refreshToken|idToken|apiKey|clientSecret|client_secret|fileId|folderId|resourceKey|downloadUrl)\b/i,
    'the sandbox bridge must never transport Drive credentials or address resources directly'
  );
  assert.doesNotMatch(
    driveBridge,
    /\b(?:authorizationUrl|codeVerifier|oauthCode|clientId)\b/i,
    'the renderer must not receive OAuth internals or the active link itself'
  );

  assert.match(
    scanBridge,
    /scanServiceFolder:[\s\S]*requestedDate:\s*request\?\.requestedDate/
  );
  assert.doesNotMatch(
    scanBridge,
    /\b(?:folderPath|connectionId|fileId|folderId|resourceKey|accessToken|refreshToken|apiKey)\b/i,
    'scans must use only the committed profile source in main'
  );
  assert.match(scanBridge, /pinServiceSet:[\s\S]*scanToken:\s*request\?\.scanToken/);
  assert.match(scanBridge, /setId:\s*request\?\.setId/);
});

test('Desktop OAuth client secret is wired only through main-process exchange and refresh', () => {
  assert.match(
    mainSource,
    /new GoogleOAuthFlow\(\{\s*clientId:\s*config\.clientId,\s*clientSecret:\s*config\.clientSecret,/
  );
  assert.match(
    mainSource,
    /refreshGoogleAccessToken\(\{\s*clientId:\s*services\.config\.clientId,\s*clientSecret:\s*services\.config\.clientSecret,/
  );
  assert.doesNotMatch(preloadSource, /\b(?:clientSecret|client_secret)\b/);
  assert.doesNotMatch(appSource, /\b(?:clientSecret|client_secret)\b/);
});

test('private OAuth proves secure credential persistence before opening the browser', () => {
  const handlerStart = mainSource.indexOf("ipcMain.handle('drive:connectPrivate'");
  const handlerEnd = mainSource.indexOf("ipcMain.handle('drive:linkPublic'", handlerStart);
  const handler = mainSource.slice(handlerStart, handlerEnd);

  assert.ok(handlerStart >= 0 && handlerEnd > handlerStart);
  assert.ok(
    handler.indexOf('await services.store.assertSecureStorageAvailable()') <
      handler.indexOf('await services.oauthFlow.start()'),
    'the OS credential-store round trip must finish before OAuth can issue a refresh token'
  );
});

test('private OAuth fallback stays visible, copies in main, and exposes no credential material', () => {
  const dialog = elementBlockById(html, 'driveOAuthDialog');
  const rendererBlocks = [
    functionBlock(appSource, 'renderPrivateDriveOAuthDialog'),
    functionBlock(appSource, 'handlePrivateDriveOAuthStateChanged'),
    functionBlock(appSource, 'refreshPrivateDriveOAuthState'),
    functionBlock(appSource, 'copyPrivateDriveOAuthLink'),
    functionBlock(appSource, 'cancelPrivateDriveOAuth')
  ].join('\n');
  const oauthStatePayloadStart = mainSource.indexOf('function privateDriveOAuthStatePayload(');
  const oauthStatePayloadEnd = mainSource.indexOf('\n}', oauthStatePayloadStart) + 2;
  const oauthStatePayload = mainSource.slice(oauthStatePayloadStart, oauthStatePayloadEnd);
  const oauthHandlersStart = mainSource.indexOf("ipcMain.handle('drive:privateOAuthState'");
  const oauthHandlersEnd = mainSource.indexOf("ipcMain.handle('drive:connectPrivate'", oauthHandlersStart);
  const oauthHandlers = mainSource.slice(oauthHandlersStart, oauthHandlersEnd);

  assertContainsId(dialog, 'btnCopyDriveOAuthLink');
  assertContainsId(dialog, 'btnCancelDriveOAuth');
  assertContainsId(dialog, 'driveOAuthActionStatus');
  assert.match(dialog, /Browser crashed or the folder chooser is blank/);
  assert.match(dialog, /open it in Safari, Chrome, Firefox, or another browser on this computer/);
  assert.match(dialog, /before the three-minute timer expires/);
  assert.match(dialog, /Do not copy or replay a callback or Picker URL/);
  assert.match(dialog, /do not share the link/i);
  assert.doesNotMatch(dialog, /<input|<textarea|href=/i,
    'the ephemeral authorization URL must not be rendered or placed in a form control');

  assert.match(rendererBlocks, /driveOAuthDialog\.showModal\(\)/);
  assert.match(rendererBlocks, /copyPrivateDriveOAuthLink\(\)/);
  assert.match(rendererBlocks, /cancelPrivateDriveOAuth\(\)/);
  assert.match(rendererBlocks, /applyLifecycleState/);
  assert.doesNotMatch(
    rendererBlocks,
    /\b(?:authorizationUrl|accessToken|refreshToken|clientSecret|codeVerifier|localStorage|indexedDB)\b/i
  );
  assert.doesNotMatch(rendererBlocks, /\bconsole\.(?:log|info|warn|error)\b/);

  assert.doesNotMatch(
    oauthStatePayload,
    /\b(?:url|token|secret|verifier|clientId)\b/i,
    'renderer lifecycle state must remain non-secret and URL-free'
  );
  assert.match(oauthHandlers, /clipboard\.writeText\(authorizationUrl\)/);
  assert.match(oauthHandlers, /return \{\s*copied:\s*true\s*\}/);
  assert.doesNotMatch(
    oauthHandlers,
    /return\s+\{[^}]*authorizationUrl|refreshToken|accessToken|clientSecret|codeVerifier/i,
    'copy IPC may acknowledge the action but must not return OAuth material'
  );
  assert.doesNotMatch(oauthHandlers, /\bconsole\.(?:log|info|warn|error)\b/);
  assert.doesNotMatch(oauthHandlers, /\b(?:writeFile|appendFile|localStorage|store\.save)\b/);
  assert.doesNotMatch(
    driveStoreSource,
    /\b(?:authorizationUrl|codeVerifier|codeChallenge|oauthCode)\b/,
    'ephemeral authorization state must never enter the persistent connection store'
  );
  assert.doesNotMatch(oauthFlowSource, /\bconsole\.(?:log|info|warn|error)\b/);
  assert.match(
    mainSource,
    /openExternal:\s*url\s*=>\s*shell\.openExternal\(url\)/,
    'system-browser opening must remain the default OAuth behavior'
  );
});

test('private OAuth lifecycle events carry only monotonic state and are recoverable after renderer reload', () => {
  const listenerStart = preloadSource.indexOf('onPrivateDriveOAuthStateChanged:');
  const listenerEnd = preloadSource.indexOf('onPreparePublishProgress:', listenerStart);
  const listener = preloadSource.slice(listenerStart, listenerEnd);
  const initialize = functionBlock(appSource, 'init');

  assert.ok(listenerStart >= 0 && listenerEnd > listenerStart);
  assert.match(listener, /active:\s*data\?\.active === true/);
  assert.match(listener, /Number\.isSafeInteger\(data\?\.revision\)/);
  assert.doesNotMatch(listener, /\b(?:url|token|secret|verifier|clientId)\b/i);
  assert.ok(
    initialize.indexOf('onPrivateDriveOAuthStateChanged(handlePrivateDriveOAuthStateChanged)') <
      initialize.indexOf('await refreshPrivateDriveOAuthState()'),
    'renderer must subscribe before reading current lifecycle state to avoid a lost transition'
  );
});

test('Drive connection identity participates in both renderer and main scan signatures', () => {
  const rendererSignature = functionBlock(appSource, 'serviceFolderScanProfileSignature');
  const mainSignature = functionBlock(mainSource, 'serviceProfileSignature');

  for (const signature of [rendererSignature, mainSignature]) {
    assert.match(signature, /\blocalServiceFolder\b/,
      'local source identity must remain scan-relevant');
    assert.match(signature, /\bdriveConnectionId\b/,
      'switching Drive connections must invalidate old scan proposals');
  }
});

test('venue profiles persist one opaque automatic-loading source and reject mixed sources', () => {
  const driveProfile = normalizeVenueProfile({
    driveConnectionId: 'drive-connection:main-sanctuary'
  });
  assert.equal(driveProfile.driveConnectionId, 'drive-connection:main-sanctuary');
  assert.equal(driveProfile.localServiceFolder, null);

  assert.throws(
    () => normalizeVenueProfile({
      localServiceFolder: '/Volumes/Church Slides',
      driveConnectionId: 'drive-connection:main-sanctuary'
    }),
    error => error instanceof VenueProfileError && error.code === 'MULTIPLE_SERVICE_SOURCES'
  );
  assert.throws(
    () => normalizeVenueProfile({ driveConnectionId: '../raw-drive-folder-id' }),
    error => error instanceof VenueProfileError && error.code === 'INVALID_ID'
  );
});
