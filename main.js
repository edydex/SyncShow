const {
  app,
  BrowserWindow,
  ipcMain,
  screen,
  dialog,
  powerMonitor,
  safeStorage,
  shell,
  clipboard
} = require('electron');
const crypto = require('crypto');
const os = require('os');
const path = require('path');
const fs = require('fs');
const { pathToFileURL } = require('url');
const QRCode = require('qrcode');

// Node.js PPTX converter (replaces Python)
const { Converter } = require('./src/services/converter');
const { migrateVenueProfile } = require('./src/services/profile');
const {
  deriveNativeSingerScene,
  nativeSceneSingerLine,
  normalizeCacheRestoreContext,
  OutputHealthTracker,
  RemoteCommandAdapter,
  resolveCacheRestorePlan,
  resolveLaunchPlan,
  sceneAssetIds
} = require('./src/services/show');
const { BibleLibrary } = require('./src/services/bible');
const {
  fsyncDirectory,
  readFileNoFollow,
  statIdentityMatches
} = require('./src/services/project/StorageSafety');
const {
  NetworkBindingCatalog,
  RemoteAuthority,
  RemoteControlServer
} = require('./src/services/remote');
const {
  checkSourceChanges,
  pinRemoteServiceSet,
  pinServiceSet,
  readCurrentServiceSet,
  scanDriveServiceFiles,
  scanServiceFolder,
  serviceDateForTimeZone
} = require('./src/services/service-set');
const {
  DRIVE_FOLDER_MIME_TYPE,
  GOOGLE_SLIDES_MIME_TYPE,
  DriveConnectionStore,
  GoogleDriveClient,
  GoogleOAuthFlow,
  loadGoogleDriveConfig,
  parseGoogleDriveFolderLink,
  refreshGoogleAccessToken,
  sanitizeGoogleDriveConfig
} = require('./src/services/google-drive');
const {
  MAX_BUNDLE_BYTES,
  MAX_SOURCE_BYTES,
  LocalSongLibrary,
  NativeSlideRenderer,
  ServiceProjectExchange,
  ServiceProjectStore,
  ShowPackagePublisher,
  addBibleItem,
  addGroupItem,
  addProjectItem,
  addSongResource,
  compileServiceProject,
  compareSongTranslations,
  duplicateProjectItem,
  listNativePresets,
  linkSongTranslation,
  moveProjectItem,
  parseSongArrangement,
  removeProjectItemAndDescendants,
  resolveAuthoritativeSongSource,
  resetSongChannelVariant,
  updateGroupItem,
  updatePictureChannelAsset,
  updatePresentationItem,
  updateSongArrangement,
  updateTextItem
} = require('./src/services/project');
const {
  MAX_SONG_BATCH_IMPORT_FILES,
  importSongFilesSequentially
} = require('./src/services/project/SongBatchImport');
const { parseSongDocument } = require('./src/services/project/SongDocument');
const {
  CommunityClient,
  CommunityConnectionStore,
  CommunitySongSync,
  CommunitySyncStateStore
} = require('./src/services/community');

const SERVICE_SCAN_MAX_DEPTH = 2;
const SERVICE_SCAN_MAX_ENTRIES = 5000;
const SERVICE_SCAN_MAX_FILES = 1000;
const SERVICE_SCAN_PROPOSAL_LIMIT = 5;
const SERVICE_SCAN_PROPOSAL_TTL_MS = 15 * 60 * 1000;
const SERVICE_WATCH_DIRECTORY_LIMIT = 128;
const SERVICE_WATCH_DEBOUNCE_MS = 750;
const APPROVED_SERVICE_FOLDER_LIMIT = 8;
const APPROVED_DRIVE_CONNECTION_LIMIT = 16;
const APPROVED_PRESENTATION_PATH_LIMIT = 256;
const REMOTE_THUMBNAIL_MAX_BYTES = 2 * 1024 * 1024;
const PREPARE_MAX_EMPHASIS_SPANS = 256;
const PREPARE_GOLD_EMPHASIS_FOREGROUND = '#ffc000';

// Keep a live overlay readable on ordinary venue screens. Longer passages can
// be sent as consecutive ranges until multi-page Bible overlays land.
const bibleLibrary = new BibleLibrary({ maxVerses: 8 });

// Keep references to prevent garbage collection
let controlWindow = null;
let controlSettingsDraftState = { dirty: false, saving: false };
let outputWindows = new Map();
let outputSessionId = 0;
let outputLifecyclePhase = 'idle';
let outputsShouldBeVisible = false;
let outputPreviewTimer = null;
let outputPreviewSubscriptions = new Set();
let activeBibleOverlay = null;
let pendingBibleOverlay = null;
let bibleOperationEpoch = 0;
let bibleOverlaySequence = 0;
let activeVenueProfile = null;
let settingsRecoveryWarning = null;
let identifyWindows = [];
let identifyTimer = null;
let controlDisplayRefreshTimer = null;
let serviceFolderWatchers = [];
let serviceFolderWatchTimer = null;
let watchedServiceFolder = null;
let serviceFolderWatchEpoch = 0;
const serviceScanProposals = new Map();
const approvedServiceFolders = new Map();
const approvedDriveConnections = new Map();
const approvedPresentationPaths = new Map();
const googleDriveAccessTokens = new Map();
let googleDriveServicesPromise = null;
let googleDriveOperationEpoch = 0;
let privateDriveOAuthPublicState = Object.freeze({ active: false, revision: 0 });
let showGateway = null;
let outputHealthTracker = null;
let deferredShowStatePublish = null;
let remoteServer = null;
let remoteAuthority = null;
let remotePairing = null;
let remotePairingTimer = null;
let remotePairingGeneration = 0;
let remoteManagementRevision = 0;
let remoteLastError = null;
let remoteOperationQueue = Promise.resolve();
let localSongLibrary = null;
let serviceProjectStore = null;
let serviceProjectExchange = null;
let showPackagePublisher = null;
let communityServicesPromise = null;
let communityOperationQueue = Promise.resolve();
let communityOperationEpoch = 0;
let communitySyncAbortController = null;
let communityAuthAbortController = null;
let communitySyncTimer = null;
let communityPeriodicSyncTimer = null;
let communityPeriodicSyncGeneration = 0;
let communityPeriodicSyncFailures = 0;
let communityLastSyncSummary = null;
let communityReconnectRequired = null;
let communityConnectionWarning = null;
const pendingCommunityAuthorizations = new Map();
const COMMUNITY_PERIODIC_SYNC_BASE_MS = 5 * 60 * 1000;
const COMMUNITY_PERIODIC_SYNC_MAX_MS = 30 * 60 * 1000;

const controlRendererUrl = pathToFileURL(path.join(__dirname, 'src', 'renderer', 'index.html')).href;

function requireControlSender(event) {
  if (!controlWindow
    || controlWindow.isDestroyed()
    || event.sender !== controlWindow.webContents
    || event.senderFrame !== event.sender.mainFrame
    || event.senderFrame?.url !== controlRendererUrl) {
    throw new Error('This operation is only available from the SyncShow control window');
  }
}

function isControlSender(event) {
  return Boolean(
    controlWindow
    && !controlWindow.isDestroyed()
    && event.sender === controlWindow.webContents
    && event.senderFrame === event.sender.mainFrame
    && event.senderFrame?.url === controlRendererUrl
  );
}

function requirePresentationRole(role) {
  const configuredRoles = new Set((activeVenueProfile?.inputRoles || [])
    .filter(inputRole => inputRole.enabled && inputRole.kind === 'deck')
    .map(inputRole => inputRole.id));
  if (typeof role !== 'string' || !configuredRoles.has(role)) {
    throw new TypeError('Unknown presentation role');
  }
  return role;
}

function getPresentationRoleLabel(roleId) {
  return activeVenueProfile?.inputRoles.find(role => role.id === roleId)?.label || roleId;
}

function requirePresentationFile(filePath) {
  if (typeof filePath !== 'string' || filePath.length === 0) {
    throw new TypeError('A presentation file is required');
  }

  const resolvedPath = path.resolve(filePath);
  const extension = path.extname(resolvedPath).toLowerCase();
  if (extension !== '.pptx' && extension !== '.ppt') {
    throw new TypeError('Only PowerPoint .pptx or .ppt files are supported');
  }
  if (!fs.existsSync(resolvedPath) || !fs.statSync(resolvedPath).isFile()) {
    throw new Error('The selected presentation file no longer exists');
  }
  return (fs.realpathSync.native || fs.realpathSync)(resolvedPath);
}

function failMainOperation(code, message, details = {}) {
  const error = new Error(message);
  error.code = code;
  error.details = details;
  throw error;
}

function rememberBounded(map, key, value, limit) {
  map.delete(key);
  map.set(key, value);
  while (map.size > limit) {
    map.delete(map.keys().next().value);
  }
}

function grantPresentationPath(filePath, source) {
  const canonicalPath = requirePresentationFile(filePath);
  rememberBounded(
    approvedPresentationPaths,
    canonicalPath,
    {
      source: source && typeof source === 'object'
        ? JSON.parse(JSON.stringify(source))
        : { kind: String(source || 'unknown') },
      grantedAt: Date.now()
    },
    APPROVED_PRESENTATION_PATH_LIMIT
  );
  return canonicalPath;
}

function requireApprovedPresentationFile(filePath) {
  const canonicalPath = requirePresentationFile(filePath);
  if (!approvedPresentationPaths.has(canonicalPath)) {
    failMainOperation(
      'UNAPPROVED_PRESENTATION_PATH',
      'Choose this presentation in SyncShow before loading it.'
    );
  }
  return canonicalPath;
}

function conversionRestoreContext(filePath, roleId, requestedGroupId) {
  const approval = approvedPresentationPaths.get(filePath);
  const source = approval?.source || {};
  if (source.kind === 'pinned-service-set') {
    if (source.roleId !== roleId) {
      failMainOperation(
        'PINNED_ROLE_MISMATCH',
        'This saved service input belongs to a different presentation role.'
      );
    }
    return normalizeCacheRestoreContext({
      schemaVersion: 1,
      groupId: source.serviceSetId,
      sourceKind: 'service-set',
      roleId,
      serviceSetId: source.serviceSetId,
      assetId: source.assetId
    }, { allowNull: false });
  }
  if (requestedGroupId === undefined || requestedGroupId === null || requestedGroupId === '') {
    return null;
  }
  return normalizeCacheRestoreContext({
    schemaVersion: 1,
    groupId: requestedGroupId,
    sourceKind: 'manual',
    roleId
  }, { allowNull: false });
}

function canonicalServiceFolderPath(folderPath) {
  if (folderPath === null || folderPath === undefined || folderPath === '') return null;
  if (typeof folderPath !== 'string' || folderPath.includes('\0')) {
    failMainOperation('INVALID_SERVICE_FOLDER', 'The service folder path is invalid.');
  }
  if (!path.isAbsolute(folderPath)) {
    failMainOperation('INVALID_SERVICE_FOLDER', 'The service folder must use an absolute path.');
  }
  return path.resolve(folderPath);
}

function rememberApprovedServiceFolder(folderPath) {
  const canonicalPath = canonicalServiceFolderPath(folderPath);
  rememberBounded(
    approvedServiceFolders,
    canonicalPath,
    { grantedAt: Date.now() },
    APPROVED_SERVICE_FOLDER_LIMIT
  );
  return canonicalPath;
}

function authorizeServiceFolderChange(previousFolder, nextFolder) {
  const nextPath = canonicalServiceFolderPath(nextFolder);
  if (nextPath === null) return;
  const previousPath = typeof previousFolder === 'string' && path.isAbsolute(previousFolder)
    ? path.resolve(previousFolder)
    : null;
  if (nextPath === previousPath) return;
  if (!approvedServiceFolders.has(nextPath)) {
    failMainOperation(
      'UNAPPROVED_SERVICE_FOLDER',
      'Choose the service folder with SyncShow’s folder picker before saving it.'
    );
  }
}

function rememberApprovedDriveConnection(connectionId) {
  if (typeof connectionId !== 'string'
    || !/^[A-Za-z0-9][A-Za-z0-9_-]{7,99}$/.test(connectionId)) {
    failMainOperation('INVALID_DRIVE_CONNECTION', 'The Google Drive connection is invalid.');
  }
  rememberBounded(
    approvedDriveConnections,
    connectionId,
    { grantedAt: Date.now() },
    APPROVED_DRIVE_CONNECTION_LIMIT
  );
  return connectionId;
}

function authorizeDriveConnectionChange(previousConnectionId, nextConnectionId) {
  const previous = previousConnectionId || null;
  const next = nextConnectionId || null;
  if (previous === next) return;
  // Keep the former ID briefly authorized so the renderer can save a new
  // profile first and then securely delete the detached credential record.
  if (previous) rememberApprovedDriveConnection(previous);
  if (next && !approvedDriveConnections.has(next)) {
    failMainOperation(
      'UNAPPROVED_DRIVE_CONNECTION',
      'Connect Google Drive through SyncShow before saving it as the automatic loading source.'
    );
  }
}

function publicDriveConnectionSummary(summary) {
  if (!summary) return null;
  return {
    id: summary.id,
    mode: summary.kind,
    folderName: summary.folderName,
    accountEmail: summary.accountEmail || null,
    accountName: summary.accountName || null,
    canWrite: summary.canWrite === true,
    publishingEnabled: summary.writeEnabled === true,
    access: summary.access,
    createdAt: summary.createdAt,
    updatedAt: summary.updatedAt
  };
}

function updatePrivateDriveOAuthPublicState(nextState) {
  const active = nextState?.active === true;
  if (privateDriveOAuthPublicState.active === active) return privateDriveOAuthPublicState;
  privateDriveOAuthPublicState = Object.freeze({
    active,
    revision: privateDriveOAuthPublicState.revision + 1
  });
  if (controlWindow && !controlWindow.isDestroyed()) {
    controlWindow.webContents.send('drive:privateOAuthStateChanged', privateDriveOAuthPublicState);
  }
  return privateDriveOAuthPublicState;
}

function privateDriveOAuthStatePayload() {
  return {
    active: privateDriveOAuthPublicState.active,
    revision: privateDriveOAuthPublicState.revision
  };
}

async function revokeGoogleToken(refreshToken) {
  try {
    const response = await fetch('https://oauth2.googleapis.com/revoke', {
      method: 'POST',
      redirect: 'error',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: new URLSearchParams({ token: refreshToken })
    });
    return response.ok;
  } catch (_error) {
    return false;
  }
}

async function getGoogleDriveServices() {
  if (!googleDriveServicesPromise) {
    googleDriveServicesPromise = (async () => {
      let config;
      let configError = null;
      try {
        config = await loadGoogleDriveConfig();
      } catch (error) {
        console.error('[GoogleDrive] Configuration could not be loaded:', error.message);
        configError = error.message;
        config = {
          clientId: null,
          clientSecret: null,
          apiKey: null,
          oauthConfigured: false,
          publicAccessConfigured: false
        };
      }
      const store = new DriveConnectionStore({
        storageRoot: path.join(app.getPath('userData'), 'google-drive'),
        safeStorage,
        revokeToken: revokeGoogleToken,
        onDisconnect: summary => {
          googleDriveAccessTokens.delete(summary.id);
          googleDriveOperationEpoch += 1;
          clearServiceScanProposals();
        }
      });
      const oauthFlow = config.clientId
        ? new GoogleOAuthFlow({
          clientId: config.clientId,
          clientSecret: config.clientSecret,
          openExternal: url => shell.openExternal(url),
          onAuthorizationStateChanged: updatePrivateDriveOAuthPublicState
        })
        : null;
      return { config, configError, store, oauthFlow };
    })();
  }
  return googleDriveServicesPromise;
}

async function driveStatusPayload() {
  const services = await getGoogleDriveServices();
  const sanitizedConfig = sanitizeGoogleDriveConfig(services.config);
  let connection = null;
  if (activeVenueProfile?.driveConnectionId) {
    connection = await services.store.getConnectionSummary(activeVenueProfile.driveConnectionId);
  }
  return {
    configuration: {
      privateOAuthConfigured: sanitizedConfig.oauthConfigured,
      publicApiKeyConfigured: sanitizedConfig.publicAccessConfigured
    },
    connection: publicDriveConnectionSummary(connection),
    configurationError: services.configError
  };
}

async function getDriveConnectionOrFail(connectionId = activeVenueProfile?.driveConnectionId) {
  if (!connectionId) {
    failMainOperation('NO_DRIVE_CONNECTION', 'Connect a Google Drive folder first.');
  }
  const services = await getGoogleDriveServices();
  const connection = await services.store.getConnection(connectionId);
  if (!connection) {
    failMainOperation(
      'DRIVE_RECONNECT_REQUIRED',
      'This Google Drive connection is no longer available. Connect the folder again.'
    );
  }
  return { services, connection };
}

async function driveClientForConnection(connection, services, { forceRefresh = false } = {}) {
  if (connection.kind === 'public') {
    if (!services.config.apiKey) {
      failMainOperation(
        'PUBLIC_DRIVE_NOT_CONFIGURED',
        'This SyncShow build needs a Drive-API-restricted Google API key before it can use public folder links.'
      );
    }
    return new GoogleDriveClient({ apiKey: services.config.apiKey });
  }
  if (!services.config.clientId) {
    failMainOperation(
      'PRIVATE_DRIVE_NOT_CONFIGURED',
      'This SyncShow build needs a Google Desktop OAuth client ID before it can open private folders.'
    );
  }
  const cached = googleDriveAccessTokens.get(connection.id);
  const now = Date.now();
  let accessToken = !forceRefresh
    && cached
    && cached.expiresAt > now + 60 * 1000
    ? cached.accessToken
    : null;
  if (!accessToken) {
    const refreshed = await refreshGoogleAccessToken({
      clientId: services.config.clientId,
      clientSecret: services.config.clientSecret,
      refreshToken: connection.refreshToken
    });
    accessToken = refreshed.accessToken;
    googleDriveAccessTokens.set(connection.id, {
      accessToken,
      expiresAt: now + refreshed.expiresIn * 1000
    });
  }
  return new GoogleDriveClient({ accessToken });
}

function driveMetadataMatchesCandidate(metadata, candidate) {
  if (!metadata || !candidate) return false;
  return metadata.id === candidate.fileId
    && metadata.mimeType === candidate.sourceMimeType
    && metadata.modifiedTime === candidate.modifiedTime
    && (candidate.version === null || metadata.version === candidate.version)
    && (candidate.size === null || metadata.size === candidate.size)
    && (!candidate.driveChecksum
      || candidate.driveChecksumAlgorithm !== 'md5'
      || metadata.md5Checksum === candidate.driveChecksum);
}

async function cancelGoogleDriveOperations() {
  googleDriveOperationEpoch += 1;
  googleDriveAccessTokens.clear();
  if (!googleDriveServicesPromise) return;
  try {
    const services = await googleDriveServicesPromise;
    await services.oauthFlow?.cancel();
  } catch (_error) {
    // App shutdown/suspend cancellation is best effort.
  }
}

function isPathInside(parentPath, childPath) {
  const relative = path.relative(parentPath, childPath);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function getServiceSetRoot() {
  return path.join(app.getPath('userData'), 'service-sets');
}

function serviceProfileSignature(profile) {
  if (!profile) return null;
  return JSON.stringify({
    id: profile.id,
    timeZone: profile.timeZone,
    serviceDateOrder: profile.serviceDateOrder,
    localServiceFolder: profile.localServiceFolder,
    driveConnectionId: profile.driveConnectionId,
    inputRoles: profile.inputRoles.map(role => ({
      id: role.id,
      label: role.label,
      enabled: role.enabled,
      kind: role.kind,
      required: role.required,
      filenameMatchers: role.filenameMatchers,
      datePolicy: role.datePolicy
    })),
    outputs: profile.outputs.map(output => ({
      id: output.id,
      enabled: output.enabled,
      expectedRoleId: output.expectedRoleId,
      mode: output.mode,
      sourceRoleId: output.sourceRoleId,
      sourceOutputId: output.sourceOutputId,
      fallback: output.fallback
    }))
  });
}

function clearServiceScanProposals() {
  serviceScanProposals.clear();
}

function stopServiceFolderWatchers() {
  serviceFolderWatchEpoch += 1;
  if (serviceFolderWatchTimer) {
    clearTimeout(serviceFolderWatchTimer);
    serviceFolderWatchTimer = null;
  }
  for (const watcher of serviceFolderWatchers) {
    try {
      watcher.close();
    } catch (error) {
      console.warn('[ServiceFolder] Could not close a folder watcher:', error.message);
    }
  }
  serviceFolderWatchers = [];
  watchedServiceFolder = null;
}

function scheduleServiceFolderChanged(reason = 'filesystem-change') {
  const epoch = serviceFolderWatchEpoch;
  if (serviceFolderWatchTimer) clearTimeout(serviceFolderWatchTimer);
  serviceFolderWatchTimer = setTimeout(() => {
    serviceFolderWatchTimer = null;
    if (epoch !== serviceFolderWatchEpoch || !watchedServiceFolder) return;
    if (!controlWindow || controlWindow.isDestroyed()) return;
    controlWindow.webContents.send('service-folder:changed', {
      reason,
      folderPath: watchedServiceFolder,
      changedAt: new Date().toISOString()
    });
  }, SERVICE_WATCH_DEBOUNCE_MS);
}

function startServiceFolderWatchers(folderPath, directories) {
  stopServiceFolderWatchers();
  const canonicalFolder = canonicalServiceFolderPath(folderPath);
  const watchPaths = [...new Set([canonicalFolder, ...(directories || [])]
    .map(directory => path.resolve(directory))
    .filter(directory => isPathInside(canonicalFolder, directory)))]
    .slice(0, SERVICE_WATCH_DIRECTORY_LIMIT);
  watchedServiceFolder = canonicalFolder;
  const epoch = serviceFolderWatchEpoch;

  for (const directory of watchPaths) {
    try {
      const watcher = fs.watch(directory, { persistent: false }, () => {
        if (epoch === serviceFolderWatchEpoch) scheduleServiceFolderChanged();
      });
      watcher.on('error', error => {
        console.warn(`[ServiceFolder] Watcher failed for ${directory}:`, error.message);
        if (epoch === serviceFolderWatchEpoch) scheduleServiceFolderChanged('watcher-error');
      });
      serviceFolderWatchers.push(watcher);
    } catch (error) {
      console.warn(`[ServiceFolder] Could not watch ${directory}:`, error.message);
    }
  }
}

function deriveServiceScanContext(profile) {
  const inputRoles = (profile?.inputRoles || [])
    .filter(role => role.enabled && role.kind === 'deck')
    .map(role => ({
      id: role.id,
      label: role.label,
      filenameMatchers: [...role.filenameMatchers],
      datePolicy: role.datePolicy
    }));
  if (inputRoles.length === 0) {
    failMainOperation('NO_SERVICE_INPUTS', 'This venue profile has no enabled presentation inputs.');
  }

  const enabledRoleIds = new Set(inputRoles.map(role => role.id));
  const rolesUsedByOutputs = new Set();
  for (const output of profile.outputs || []) {
    if (!output.enabled) continue;
    for (const roleId of [
      output.expectedRoleId,
      output.sourceRoleId,
      output.fallback?.sourceRoleId
    ]) {
      if (enabledRoleIds.has(roleId)) rolesUsedByOutputs.add(roleId);
    }
  }
  const requiredRoleIds = (profile.inputRoles || [])
    .filter(role => role.enabled && role.kind === 'deck')
    .filter(role => role.required === 'always'
      || (role.required === 'if-used-by-enabled-output' && rolesUsedByOutputs.has(role.id)))
    .map(role => role.id);
  return { inputRoles, requiredRoleIds };
}

function validateRequestedServiceDate(value) {
  if (typeof value !== 'string') {
    failMainOperation('INVALID_SERVICE_DATE', 'The service date must use YYYY-MM-DD format.');
  }
  const match = value.match(/^(20\d{2})-(\d{2})-(\d{2})$/);
  if (!match) failMainOperation('INVALID_SERVICE_DATE', 'The service date must use YYYY-MM-DD format.');
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const candidate = new Date(Date.UTC(year, month - 1, day));
  if (candidate.getUTCFullYear() !== year
    || candidate.getUTCMonth() !== month - 1
    || candidate.getUTCDate() !== day) {
    failMainOperation('INVALID_SERVICE_DATE', 'Choose a real calendar date for the service.');
  }
  return value;
}

function requestedServiceDate(value, timeZone) {
  if (value !== undefined && value !== null && value !== '') {
    return validateRequestedServiceDate(value);
  }
  try {
    return serviceDateForTimeZone(new Date(), timeZone || null);
  } catch (error) {
    failMainOperation(
      'INVALID_PROFILE_TIME_ZONE',
      `The venue profile time zone is invalid: ${error.message}`
    );
  }
}

function captureServiceScanContext(requestedDateValue) {
  const profile = activeVenueProfile;
  const profileSignature = serviceProfileSignature(profile);
  const folderPath = canonicalServiceFolderPath(profile?.localServiceFolder);
  const driveConnectionId = profile?.driveConnectionId || null;
  if (!folderPath && !driveConnectionId) {
    failMainOperation('NO_SERVICE_SOURCE', 'Connect Google Drive or choose a local service folder first.');
  }
  const { inputRoles, requiredRoleIds } = deriveServiceScanContext(profile);
  return {
    profileSignature,
    sourceKind: driveConnectionId ? 'google-drive' : 'local-folder',
    folderPath,
    driveConnectionId,
    inputRoles,
    requiredRoleIds,
    requestedDate: requestedServiceDate(requestedDateValue, profile?.timeZone),
    dateOrder: profile?.serviceDateOrder || 'mdy'
  };
}

async function preflightServiceFolderScan(folderPath) {
  const canonicalFolder = canonicalServiceFolderPath(folderPath);
  let rootStats;
  try {
    rootStats = await fs.promises.stat(canonicalFolder);
  } catch (error) {
    failMainOperation(
      'FOLDER_UNAVAILABLE',
      `The service folder is not available: ${error.message}`,
      { cause: error.code || null }
    );
  }
  if (!rootStats.isDirectory()) {
    failMainOperation('NOT_A_FOLDER', 'The selected service location is not a folder.');
  }

  let entryCount = 0;
  let presentationFileCount = 0;
  const directories = [canonicalFolder];
  async function walk(currentPath, depth) {
    let directory;
    try {
      directory = await fs.promises.opendir(currentPath);
    } catch (error) {
      failMainOperation(
        'FOLDER_UNAVAILABLE',
        `SyncShow cannot read the service folder: ${error.message}`,
        { cause: error.code || null }
      );
    }
    for await (const entry of directory) {
      entryCount += 1;
      if (entryCount > SERVICE_SCAN_MAX_ENTRIES) {
        failMainOperation(
          'SERVICE_FOLDER_TOO_LARGE',
          `This folder contains more than ${SERVICE_SCAN_MAX_ENTRIES} items in the scanned levels. Choose a smaller service folder.`
        );
      }
      if (entry.isSymbolicLink()) continue;
      const entryPath = path.join(currentPath, entry.name);
      if (entry.isDirectory()) {
        if (entry.name.startsWith('.') || depth >= SERVICE_SCAN_MAX_DEPTH) continue;
        directories.push(entryPath);
        await walk(entryPath, depth + 1);
        continue;
      }
      if (!entry.isFile()) continue;
      const extension = path.extname(entry.name).toLowerCase();
      if (extension !== '.pptx' && extension !== '.ppt') continue;
      presentationFileCount += 1;
      if (presentationFileCount > SERVICE_SCAN_MAX_FILES) {
        failMainOperation(
          'TOO_MANY_SERVICE_FILES',
          `This folder contains more than ${SERVICE_SCAN_MAX_FILES} PowerPoint files in the scanned levels. Choose a smaller service folder.`
        );
      }
    }
  }
  await walk(canonicalFolder, 0);
  return { canonicalFolder, directories };
}

function pruneServiceScanProposals(now = Date.now()) {
  for (const [token, proposal] of serviceScanProposals) {
    if (proposal.expiresAt <= now) serviceScanProposals.delete(token);
  }
  while (serviceScanProposals.size >= SERVICE_SCAN_PROPOSAL_LIMIT) {
    serviceScanProposals.delete(serviceScanProposals.keys().next().value);
  }
}

function requireCurrentServiceScanProfile(profileSignature) {
  if (profileSignature !== serviceProfileSignature(activeVenueProfile)) {
    failMainOperation('PROFILE_CHANGED', 'The venue setup changed. Refresh the service folder and try again.');
  }
}

function holdServiceScanProposal(scan, profileSignature) {
  // The signature belongs to the exact profile snapshot that produced `scan`.
  // Never derive it here: settings may have changed while the async scan ran.
  requireCurrentServiceScanProfile(profileSignature);
  const now = Date.now();
  pruneServiceScanProposals(now);
  const scanToken = crypto.randomBytes(24).toString('base64url');
  serviceScanProposals.set(scanToken, {
    scan,
    profileSignature,
    expiresAt: now + SERVICE_SCAN_PROPOSAL_TTL_MS
  });
  return scanToken;
}

function requireServiceScanProposal(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    failMainOperation('INVALID_SCAN_REQUEST', 'Choose a discovered service before loading it.');
  }
  const { scanToken, setId } = payload;
  if (typeof scanToken !== 'string' || scanToken.length < 16 || scanToken.length > 200) {
    failMainOperation('INVALID_SCAN_TOKEN', 'The service-folder scan is no longer available. Refresh the folder.');
  }
  if (typeof setId !== 'string' || setId.length === 0 || setId.length > 128) {
    failMainOperation('INVALID_SERVICE_SET', 'Choose one of the discovered service dates.');
  }
  const proposal = serviceScanProposals.get(scanToken);
  if (!proposal || proposal.expiresAt <= Date.now()) {
    serviceScanProposals.delete(scanToken);
    failMainOperation('EXPIRED_SCAN_TOKEN', 'The service-folder scan expired. Refresh the folder and try again.');
  }
  try {
    requireCurrentServiceScanProfile(proposal.profileSignature);
  } catch (error) {
    serviceScanProposals.delete(scanToken);
    throw error;
  }
  return { proposal, setId };
}

function sanitizeCandidate(candidate) {
  if (!candidate) return null;
  return {
    id: candidate.id,
    relativePath: candidate.relativePath,
    name: candidate.name,
    extension: candidate.extension,
    size: candidate.size,
    modifiedTime: candidate.modifiedTime,
    modifiedTimeMs: candidate.modifiedTimeMs,
    serviceDate: candidate.serviceDate,
    parsedServiceDate: candidate.parsedServiceDate,
    serviceDateSource: candidate.serviceDateSource,
    datePolicy: candidate.datePolicy,
    dateStatus: candidate.dateStatus,
    dateNeutral: candidate.dateNeutral,
    available: candidate.available,
    availability: candidate.availability,
    availabilityError: candidate.availabilityError,
    versionRank: candidate.versionRank,
    matchedRoleIds: [...candidate.matchedRoleIds],
    roleMatchScore: candidate.roleMatchScore,
    ambiguousRoleMatch: candidate.ambiguousRoleMatch
  };
}

function sanitizeServiceSet(set) {
  return {
    id: set.id,
    serviceDate: set.serviceDate,
    inputs: Object.fromEntries(
      Object.entries(set.inputs).map(([roleId, candidate]) => [roleId, sanitizeCandidate(candidate)])
    ),
    alternates: Object.fromEntries(
      Object.entries(set.alternates).map(([roleId, candidates]) => [
        roleId,
        candidates.map(sanitizeCandidate)
      ])
    ),
    missingRoleIds: [...set.missingRoleIds],
    unavailableRoleIds: [...set.unavailableRoleIds],
    complete: set.complete,
    dateStatus: set.dateStatus,
    warnings: JSON.parse(JSON.stringify(set.warnings))
  };
}

function sanitizeServiceScan(scan, scanToken) {
  return {
    schemaVersion: scan.schemaVersion,
    scanToken,
    source: { type: scan.source.type, locator: scan.source.locator },
    folderPath: scan.folderPath,
    scannedAt: scan.scannedAt,
    inputRoles: scan.inputRoles.map(role => ({
      id: role.id,
      label: role.label,
      required: role.required,
      filenameMatchers: [...role.filenameMatchers],
      datePolicy: role.datePolicy
    })),
    files: scan.files.map(sanitizeCandidate),
    unmatchedFiles: scan.unmatchedFiles.map(sanitizeCandidate),
    ignoredFiles: scan.ignoredFiles.map(file => ({
      relativePath: file.relativePath,
      reason: file.reason
    })),
    requestedDate: scan.requestedDate,
    sets: scan.sets.map(sanitizeServiceSet),
    recommendedSetId: scan.recommendedSetId,
    scanFingerprint: scan.scanFingerprint
  };
}

function grantPinnedPresentationPaths(manifest) {
  if (!manifest?.inputs || typeof manifest.inputs !== 'object') return;
  const configuredServiceSetRoot = path.resolve(getServiceSetRoot());
  const serviceSetRoot = fs.existsSync(configuredServiceSetRoot)
    ? (fs.realpathSync.native || fs.realpathSync)(configuredServiceSetRoot)
    : configuredServiceSetRoot;
  for (const input of Object.values(manifest.inputs)) {
    if (!input || typeof input.pinnedPath !== 'string') {
      failMainOperation('INVALID_PINNED_SET', 'A saved service input has an invalid local path.');
    }
    const pinnedPath = requirePresentationFile(input.pinnedPath);
    if (!isPathInside(serviceSetRoot, pinnedPath)) {
      failMainOperation('INVALID_PINNED_SET', 'A saved service input escaped SyncShow’s snapshot folder.');
    }
    grantPresentationPath(pinnedPath, {
      kind: 'pinned-service-set',
      serviceSetId: manifest.id,
      roleId: input.roleId,
      assetId: input.assetId
    });
  }
}

function validatePinnedSourcePaths(manifest) {
  const sourceFolder = canonicalServiceFolderPath(manifest?.source?.locator);
  if (!sourceFolder) {
    failMainOperation('INVALID_PINNED_SET', 'The saved service snapshot has no source folder.');
  }
  for (const input of Object.values(manifest.inputs || {})) {
    if (!input || typeof input.sourcePath !== 'string') {
      failMainOperation('INVALID_PINNED_SET', 'A saved service input has an invalid source path.');
    }
    const sourcePath = path.resolve(input.sourcePath);
    if (!isPathInside(sourceFolder, sourcePath)) {
      failMainOperation('INVALID_PINNED_SET', 'A saved service input escaped its source folder.');
    }
  }
}

function sanitizePinnedServiceSet(manifest) {
  if (!manifest) return null;
  return {
    schemaVersion: manifest.schemaVersion,
    id: manifest.id,
    name: manifest.name,
    profileId: manifest.profileId,
    serviceDate: manifest.serviceDate,
    requestedDate: manifest.requestedDate,
    timeZone: manifest.timeZone,
    createdAt: manifest.createdAt,
    source: {
      type: manifest.source?.type || null,
      locator: manifest.source?.locator || null,
      scanFingerprint: manifest.source?.scanFingerprint || null,
      scannedAt: manifest.source?.scannedAt || null
    },
    inputs: Object.fromEntries(Object.entries(manifest.inputs || {}).map(([roleId, input]) => [
      roleId,
      {
        assetId: input.assetId,
        roleId: input.roleId,
        sourceName: input.sourceName,
        sourceRelativePath: input.sourceRelativePath,
        pinnedPath: input.pinnedPath,
        fileDate: input.fileDate,
        size: input.size,
        sourceModifiedTime: input.sourceModifiedTime,
        sha256: input.sha256
      }
    ])),
    warnings: JSON.parse(JSON.stringify(manifest.warnings || []))
  };
}

// User settings storage path (in userData folder)
function getSettingsPath() {
  return path.join(app.getPath('userData'), 'settings.json');
}

// Load user settings
function loadUserSettings() {
  try {
    const settingsPath = getSettingsPath();
    if (fs.existsSync(settingsPath)) {
      const data = fs.readFileSync(settingsPath, 'utf8');
      return JSON.parse(data);
    }
  } catch (error) {
    console.error('Error loading user settings:', error);
  }
  return {};
}

function normalizeUserSettings(settings) {
  const venueProfile = migrateVenueProfile(settings || {});
  return {
    settingsVersion: 1,
    venueProfile
  };
}

function applyVenueProfile(profile) {
  const previousSignature = serviceProfileSignature(activeVenueProfile);
  const nextSignature = serviceProfileSignature(profile);
  activeVenueProfile = profile;
  if (previousSignature !== null && previousSignature !== nextSignature) {
    clearServiceScanProposals();
    stopServiceFolderWatchers();
  }
  for (const role of profile.inputRoles) {
    if (role.kind !== 'deck') continue;
    if (!(role.id in appState.presentations)) installPresentation(role.id, null);
  }
}

function loadAndApplyUserSettings() {
  try {
    const normalized = normalizeUserSettings(loadUserSettings());
    applyVenueProfile(normalized.venueProfile);
    settingsRecoveryWarning = null;
    return normalized;
  } catch (error) {
    console.error('[Settings] Could not load the saved venue profile:', error);
    const fallback = normalizeUserSettings({});
    applyVenueProfile(fallback.venueProfile);
    settingsRecoveryWarning = `The saved venue setup could not be loaded: ${error.message}`;
    return fallback;
  }
}

// Save user settings
function saveUserSettings(settings) {
  const settingsPath = getSettingsPath();
  const temporaryPath = `${settingsPath}.${process.pid}.tmp`;
  const backupPath = `${settingsPath}.bak`;

  try {
    if (!settings || typeof settings !== 'object' || Array.isArray(settings)) {
      throw new TypeError('Settings must be an object');
    }

    const normalizedSettings = normalizeUserSettings(settings);
    authorizeServiceFolderChange(
      activeVenueProfile?.localServiceFolder || null,
      normalizedSettings.venueProfile.localServiceFolder
    );
    authorizeDriveConnectionChange(
      activeVenueProfile?.driveConnectionId || null,
      normalizedSettings.venueProfile.driveConnectionId
    );
    const serialized = `${JSON.stringify(normalizedSettings, null, 2)}\n`;
    if (Buffer.byteLength(serialized, 'utf8') > 256 * 1024) {
      throw new Error('Settings data is unexpectedly large');
    }

    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    fs.writeFileSync(temporaryPath, serialized, { encoding: 'utf8', mode: 0o600 });
    if (fs.existsSync(settingsPath)) fs.copyFileSync(settingsPath, backupPath);
    fs.renameSync(temporaryPath, settingsPath);
    applyVenueProfile(normalizedSettings.venueProfile);
    console.log('[Settings] Saved to:', settingsPath);
    return normalizedSettings;
  } catch (error) {
    try {
      if (fs.existsSync(temporaryPath)) fs.unlinkSync(temporaryPath);
    } catch (cleanupError) {
      console.error('Error cleaning temporary settings file:', cleanupError);
    }
    console.error('Error saving user settings:', error);
    throw error;
  }
}

// Application state
let appState = {
  presentations: {},
  currentSlide: 0,
  totalSlides: 0,
  displays: [],
  displayAssignments: new Map(),
  activeLaunchPlan: null,
  slideCache: { metadata: {} },
  isCleared: false,  // Track if displays are currently cleared (black)
  fadeDuration: 300,  // Fade transition duration in ms
  syncMode: false,  // Experimental: coordinate exact reveal timing across displays
  singerFontSize: 36,  // Singer screen next-text font size in px
  singerCharLimit: 70,  // Singer screen next-text character limit
  singerTextPadding: 4  // Singer screen next-text vertical padding in px
};
let presentationRevision = 0;
let preparePublishGeneration = 0;

function installPresentation(roleId, presentation) {
  appState.presentations[roleId] = presentation;
  presentationRevision += 1;
}

function buildShowCue(index) {
  const launchPlan = appState.activeLaunchPlan;
  if (!launchPlan || !Number.isInteger(index) || index < 0 || index >= launchPlan.totalSlides) {
    return null;
  }
  const presentation = appState.presentations[launchPlan.timelineRoleId];
  const metadata = presentation?.metadata?.slides?.[index] || {};
  const extractedText = metadata.text || metadata.firstLine || '';
  const stableCueId = typeof metadata.cueId === 'string'
    && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(metadata.cueId)
    ? metadata.cueId
    : `cue-${index + 1}`;
  return {
    id: stableCueId,
    index,
    label: metadata.title || metadata.firstLine || `Slide ${index + 1}`,
    text: extractedText,
    // Conversion validation guarantees a thumbnail for every published slide.
    // Expose only availability; a future authenticated endpoint will derive and
    // read the path internally rather than sending filesystem paths to clients.
    thumbnailAvailable: Boolean(presentation?.cacheDir)
  };
}

async function readActiveCueThumbnail(cueIndex) {
  const launchPlan = appState.activeLaunchPlan;
  if (!launchPlan || !Number.isInteger(cueIndex) || cueIndex < 0 || cueIndex >= launchPlan.totalSlides) {
    failMainOperation('INVALID_CUE_INDEX', 'That cue does not exist in the active Show.');
  }
  const presentation = appState.presentations[launchPlan.timelineRoleId];
  if (!presentation?.cacheDir) {
    failMainOperation('THUMBNAIL_UNAVAILABLE', 'That cue preview is unavailable.');
  }
  const fileName = `slide_${String(cueIndex + 1).padStart(3, '0')}_thumb.jpg`;
  const thumbnailPath = path.join(presentation.cacheDir, fileName);
  let handle;
  try {
    handle = await fs.promises.open(thumbnailPath, 'r');
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size < 1 || stat.size > REMOTE_THUMBNAIL_MAX_BYTES) {
      failMainOperation('THUMBNAIL_UNAVAILABLE', 'That cue preview is unavailable.');
    }
    const data = Buffer.allocUnsafe(stat.size);
    let offset = 0;
    while (offset < data.length) {
      const { bytesRead } = await handle.read(data, offset, data.length - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    const overflow = Buffer.allocUnsafe(1);
    const extra = await handle.read(overflow, 0, 1, data.length);
    if (offset !== data.length || extra.bytesRead !== 0) {
      failMainOperation('THUMBNAIL_UNAVAILABLE', 'That cue preview is unavailable.');
    }
    return data;
  } catch (_error) {
    // Never pass a filesystem path or raw I/O error through the LAN boundary.
    failMainOperation('THUMBNAIL_UNAVAILABLE', 'That cue preview is unavailable.');
  } finally {
    await handle?.close().catch(() => {});
  }
}

function readShowRuntimeState() {
  const launchPlan = appState.activeLaunchPlan;
  const hasActiveShow = Boolean(launchPlan);
  const activePassage = pendingBibleOverlay?.passage || activeBibleOverlay?.passage || null;
  const biblePhase = pendingBibleOverlay ? 'preparing' : (activeBibleOverlay ? 'live' : 'idle');
  const targetOutputIds = pendingBibleOverlay?.targetOutputIds
    || activeBibleOverlay?.targetOutputIds
    || [];

  return {
    hasActiveShow,
    phase: hasActiveShow ? outputLifecyclePhase : 'idle',
    profileName: activeVenueProfile?.name || 'SyncShow',
    currentSlide: appState.currentSlide,
    totalSlides: hasActiveShow ? appState.totalSlides : 0,
    currentCue: hasActiveShow ? buildShowCue(appState.currentSlide) : null,
    nextCue: hasActiveShow ? buildShowCue(appState.currentSlide + 1) : null,
    outputs: hasActiveShow
      ? launchPlan.outputs.map(output => {
          const entry = outputWindows.get(output.id);
          const available = Boolean(
            entry?.win
            && !entry.win.isDestroyed()
            && entry.win.webContents
            && !entry.win.webContents.isDestroyed()
          );
          const visible = available && entry.win.isVisible();
          const health = available
            ? outputHealthTracker?.read(output.id, entry.sessionId, entry.win.webContents)
            : null;
          let status = outputLifecyclePhase === 'starting' ? 'starting' : 'unavailable';
          if (available && health?.status === 'unavailable') status = 'unavailable';
          else if (outputLifecyclePhase === 'starting') status = 'starting';
          else if (available && health?.status !== 'healthy') status = 'starting';
          else if (available && outputLifecyclePhase === 'cleared') status = 'cleared';
          else if (available && (outputLifecyclePhase === 'locally-stopped' || !visible)) status = 'hidden';
          else if (available) status = 'healthy';
          return {
            id: output.id,
            name: output.name,
            renderer: output.renderer,
            status,
            visible
          };
        })
      : [],
    bible: {
      phase: biblePhase,
      reference: activePassage?.reference || '',
      translationId: activePassage?.translationId || activePassage?.translation?.id || '',
      targetOutputIds: [...targetOutputIds]
    },
    permissions: {
      // The first network-free foundation intentionally exposes no remote Bible
      // picker authority. A later locally-approved Remote session may opt in.
      canOpenBiblePicker: false
    }
  };
}

function publishShowState(reason) {
  return showGateway ? showGateway.publish(reason) : null;
}

function scheduleShowStatePublish(reason, sessionId = outputSessionId) {
  if (deferredShowStatePublish?.sessionId === sessionId) {
    deferredShowStatePublish.reasons.add(reason);
    return;
  }

  const task = { sessionId, reasons: new Set([reason]) };
  deferredShowStatePublish = task;

  // Renderer acknowledgements are observational. Never extend a frame IPC or
  // navigation transaction by publishing synchronously; coalesce health state
  // onto the microtask queue and discard it if that private session is gone.
  queueMicrotask(() => {
    if (deferredShowStatePublish === task) deferredShowStatePublish = null;
    if (task.sessionId !== outputSessionId || !appState.activeLaunchPlan) return;
    publishShowState([...task.reasons].sort().join(','));
  });
}

function restoreOutputsForRemote() {
  if (activeBibleOverlay || pendingBibleOverlay) {
    hideBibleOverlay({ restore: true });
    return { accepted: true };
  }
  return showAllDisplays();
}

showGateway = new RemoteCommandAdapter({
  readRuntimeState: readShowRuntimeState,
  readCueCatalog: () => appState.activeLaunchPlan
    ? Array.from({ length: appState.totalSlides }, (_value, index) => buildShowCue(index))
    : [],
  readCueThumbnail: readActiveCueThumbnail,
  commands: {
    previous: () => navigateSlide(-1),
    next: () => navigateSlide(1),
    jump: index => goToSlide(index),
    restore: restoreOutputsForRemote,
    clear: clearAllDisplays
  }
});

outputHealthTracker = new OutputHealthTracker({
  maximumEntries: 32,
  onChange: event => scheduleShowStatePublish(`output-health:${event.reason}`, event.sessionId)
});

showGateway.subscribe(({ reason, state }) => {
  if (!controlWindow || controlWindow.isDestroyed()) return;
  controlWindow.webContents.send('show:stateChanged', { reason, state });
});

function clearRemotePairingTimer() {
  if (remotePairingTimer) clearTimeout(remotePairingTimer);
  remotePairingTimer = null;
}

function queueRemoteOperation(task) {
  const operation = remoteOperationQueue.catch(() => {}).then(task);
  remoteOperationQueue = operation.catch(() => {});
  return operation;
}

function remoteManagementState() {
  const status = remoteServer?.getStatus() || {
    mode: 'off',
    enabled: false,
    binding: null,
    origin: null,
    pairedDeviceCount: 0,
    connectedDeviceCount: 0
  };
  const devices = remoteAuthority
    ? remoteAuthority.listDevices().map(device => ({
        id: device.id,
        name: device.name,
        createdAt: device.createdAt,
        expiresAt: device.expiresAt,
        lastSeenAt: device.lastSeenAt
      }))
    : [];
  const pairing = remotePairing
    ? {
        code: remotePairing.code,
        expiresAt: remotePairing.expiresAt,
        qrDataUrl: remotePairing.qrDataUrl,
        expired: remotePairing.expired === true || Date.now() >= remotePairing.expiresAt
      }
    : null;

  return {
    managementRevision: remoteManagementRevision,
    enabled: status.enabled === true && status.mode === 'lan',
    mode: status.mode,
    origin: status.origin,
    binding: status.binding
      ? {
          id: status.binding.id,
          label: status.binding.label,
          interfaceName: status.binding.interfaceName,
          kind: status.binding.kind
        }
      : null,
    pairedDeviceCount: devices.length,
    connectedDeviceCount: status.connectedDeviceCount || 0,
    devices,
    pairing,
    lastError: remoteLastError
  };
}

function emitRemoteState() {
  remoteManagementRevision += 1;
  const snapshot = remoteManagementState();
  if (!controlWindow || controlWindow.isDestroyed()) return snapshot;
  controlWindow.webContents.send('remote:stateChanged', snapshot);
  return snapshot;
}

function closeRemotePairing({ preserveExpired = false } = {}) {
  remotePairingGeneration += 1;
  clearRemotePairingTimer();
  remoteServer?.closePairing();
  if (preserveExpired && remotePairing) remotePairing.expired = true;
  else remotePairing = null;
  emitRemoteState();
}

async function createRemotePairing({ expectedGeneration = null } = {}) {
  const status = remoteServer?.getStatus();
  const showState = showGateway.getState();
  if (!status?.enabled || status.mode !== 'lan') {
    failMainOperation('REMOTE_OFF', 'Turn on Remote Control first.');
  }
  if (!showState.outputSessionId || (showState.phase !== 'live' && showState.phase !== 'cleared')) {
    failMainOperation('NO_ACTIVE_SHOW', 'Start the Show before pairing a phone.');
  }
  if (expectedGeneration !== null && expectedGeneration !== remotePairingGeneration) {
    failMainOperation('PAIRING_CANCELLED', 'Phone pairing was closed before the code was ready.');
  }

  closeRemotePairing();
  const pairingGeneration = remotePairingGeneration;
  const sessionId = showState.outputSessionId;
  const grant = remoteServer.openPairing();
  let qrDataUrl;
  try {
    qrDataUrl = await QRCode.toDataURL(grant.pairingUrl, {
      errorCorrectionLevel: 'M',
      margin: 2,
      width: 256,
      type: 'image/png'
    });
  } catch (_error) {
    if (pairingGeneration !== remotePairingGeneration) {
      failMainOperation('PAIRING_CANCELLED', 'Phone pairing was closed before the code was ready.');
    }
    closeRemotePairing();
    failMainOperation('PAIRING_QR_FAILED', 'SyncShow could not create the phone pairing code.');
  }

  const latestStatus = remoteServer.getStatus();
  if (pairingGeneration !== remotePairingGeneration) {
    failMainOperation('PAIRING_CANCELLED', 'Phone pairing was closed before the code was ready.');
  }
  if (!latestStatus.enabled || latestStatus.mode !== 'lan'
    || showGateway.getState().outputSessionId !== sessionId) {
    closeRemotePairing();
    failMainOperation('OUTPUT_SESSION_REPLACED', 'The Show changed while Remote Control was opening.');
  }

  remotePairing = {
    code: grant.code,
    expiresAt: grant.expiresAt,
    qrDataUrl,
    expired: false
  };
  clearRemotePairingTimer();
  remotePairingTimer = setTimeout(() => {
    closeRemotePairing({ preserveExpired: true });
  }, Math.max(1, grant.expiresAt - Date.now()));
  remotePairingTimer.unref?.();
  emitRemoteState();
  return remoteManagementState();
}

function listRemoteBindings() {
  if (!remoteServer) return [];
  return remoteServer.listBindings()
    .filter(binding => binding.kind === 'lan')
    .map(binding => ({
      id: binding.id,
      label: binding.label,
      interfaceName: binding.interfaceName,
      kind: binding.kind
    }));
}

async function enableRemoteControl(bindingId) {
  return queueRemoteOperation(async () => {
    const showState = showGateway.getState();
    if (!showState.outputSessionId || (showState.phase !== 'live' && showState.phase !== 'cleared')) {
      failMainOperation('NO_ACTIVE_SHOW', 'Start the Show before turning on Remote Control.');
    }
    const binding = remoteServer.listBindings()
      .find(candidate => candidate.id === bindingId && candidate.kind === 'lan');
    if (!binding) {
      failMainOperation('INVALID_BINDING', 'Choose an available trusted network.');
    }

    remoteLastError = null;
    closeRemotePairing();
    const enablePairingGeneration = remotePairingGeneration;
    if (remoteServer.getStatus().enabled) await remoteServer.stop('remote-reconfigured');
    const sessionId = showState.outputSessionId;
    try {
      await remoteServer.startLoopback();
      await remoteServer.bindLan(binding.id);
      if (showGateway.getState().outputSessionId !== sessionId) {
        failMainOperation('OUTPUT_SESSION_REPLACED', 'The Show changed while Remote Control was opening.');
      }
      return await createRemotePairing({ expectedGeneration: enablePairingGeneration });
    } catch (error) {
      remoteLastError = error?.code === 'PAIRING_CANCELLED'
        ? null
        : error?.message || 'Remote Control could not use that network.';
      closeRemotePairing();
      await remoteServer.stop('remote-start-failed');
      emitRemoteState();
      throw error;
    }
  });
}

function disableRemoteControl(reason = 'remote-off', { clearError = false } = {}) {
  remotePairingGeneration += 1;
  clearRemotePairingTimer();
  remotePairing = null;
  if (clearError) remoteLastError = null;

  // Revoke before waiting for the listener to close. A replacement/ended Show
  // must lose LAN authority synchronously, even if a socket is slow to drain.
  try {
    remoteServer?.closePairing();
    remoteServer?.revokeAll(reason);
  } catch (error) {
    console.error('[Remote] Could not revoke devices immediately:', error);
  }
  emitRemoteState();

  return queueRemoteOperation(async () => {
    if (remoteServer) await remoteServer.stop(reason);
    emitRemoteState();
    return remoteManagementState();
  });
}

function stopRemoteForShow(reason) {
  const status = remoteServer?.getStatus();
  const hasAuthority = Boolean(
    status?.enabled
    || remotePairing
    || (remoteAuthority && remoteAuthority.listDevices().length > 0)
  );
  if (!hasAuthority) return;
  disableRemoteControl(reason).catch(error => {
    console.error('[Remote] Could not finish Show-lifecycle cleanup:', error);
  });
}

remoteAuthority = new RemoteAuthority();
remoteServer = new RemoteControlServer({
  showGateway,
  authority: remoteAuthority,
  bindingCatalog: new NetworkBindingCatalog(),
  staticRoutes: {
    '/': {
      filePath: path.join(__dirname, 'src', 'remote', 'index.html'),
      contentType: 'text/html; charset=utf-8'
    },
    '/styles.css': {
      filePath: path.join(__dirname, 'src', 'remote', 'remote.css'),
      contentType: 'text/css; charset=utf-8'
    },
    '/app.js': {
      filePath: path.join(__dirname, 'src', 'remote', 'remote.js'),
      contentType: 'text/javascript; charset=utf-8'
    }
  }
});

remoteServer.on('status-changed', emitRemoteState);
remoteServer.on('device-paired', () => {
  clearRemotePairingTimer();
  remotePairing = null;
  emitRemoteState();
});
remoteServer.on('devices-revoked', () => {
  clearRemotePairingTimer();
  remotePairing = null;
  emitRemoteState();
});
remoteServer.on('server-error', error => {
  console.error('[Remote] LAN listener failed:', error);
  remoteLastError = 'Remote Control lost its network connection and was turned off.';
  disableRemoteControl('network-error').catch(stopError => {
    console.error('[Remote] Could not finish network-error cleanup:', stopError);
  });
});
remoteServer.on('state-publish-error', error => {
  console.error('[Remote] Could not publish a Show-state update:', error);
});


// Conversion queue to prevent concurrent conversions
let conversionQueue = [];
let isConverting = false;

// Determine if running in production (packaged) or development
const isPackaged = app.isPackaged;

// Get the correct paths for packaged vs development mode
function getResourcePath(relativePath) {
  if (isPackaged) {
    // In production, resources are in the resources folder
    return path.join(process.resourcesPath, relativePath);
  } else {
    // In development, use __dirname
    return path.join(__dirname, relativePath);
  }
}

// Get cache directory - must be writable (not inside asar)
// Named 'slide-cache' to avoid collision with Electron/Chromium's 'Cache'
// directory on case-insensitive filesystems (Windows, macOS).
function getCacheDir() {
  if (isPackaged) {
    // Use app's userData folder for cache in production
    return path.join(app.getPath('userData'), 'slide-cache');
  } else {
    // Use local cache folder in development
    return path.join(__dirname, 'slide-cache');
  }
}

// Configuration
const CONFIG = {
  thumbnailWidth: 300,
  thumbnailHeight: 169,
  displayWidth: 1920,
  displayHeight: 1080,
  get cacheDir() { return getCacheDir(); }
};

function getBundledPresentationFontPath() {
  if (isPackaged) {
    return path.join(
      process.resourcesPath,
      'app.asar.unpacked',
      'assets',
      'fonts',
      'NotoSans-Variable.ttf'
    );
  }
  return path.join(__dirname, 'assets', 'fonts', 'NotoSans-Variable.ttf');
}

function getPrepareServices() {
  if (!app.isReady()) throw new Error('Prepare storage is not available before SyncShow is ready.');
  const userDataPath = app.getPath('userData');
  if (!serviceProjectStore) {
    serviceProjectStore = new ServiceProjectStore({
      rootPath: path.join(userDataPath, 'service-projects')
    });
  }
  if (!localSongLibrary) {
    localSongLibrary = new LocalSongLibrary({
      rootPath: path.join(userDataPath, 'song-library')
    });
  }
  if (!serviceProjectExchange) {
    serviceProjectExchange = new ServiceProjectExchange({
      projectStore: serviceProjectStore,
      songLibrary: localSongLibrary,
      appVersion: app.getVersion()
    });
  }
  if (!showPackagePublisher) {
    showPackagePublisher = new ShowPackagePublisher({
      projectStore: serviceProjectStore,
      rootPath: path.join(userDataPath, 'show-packages'),
      fontPath: getBundledPresentationFontPath()
    });
  }
  return {
    localSongLibrary,
    serviceProjectExchange,
    serviceProjectStore,
    showPackagePublisher
  };
}

async function getCommunityServices() {
  if (!app.isReady()) {
    throw new Error('Community storage is not available before SyncShow is ready.');
  }
  if (!communityServicesPromise) {
    communityServicesPromise = Promise.resolve({
      connectionStore: new CommunityConnectionStore({
        storageRoot: path.join(app.getPath('userData'), 'community'),
        safeStorage,
        maximumConnections: 1
      }),
      stateStore: new CommunitySyncStateStore({
        storageRoot: path.join(app.getPath('userData'), 'community')
      })
    });
  }
  return communityServicesPromise;
}

function serializeCommunityOperation(operation) {
  const result = communityOperationQueue.then(operation, operation);
  communityOperationQueue = result.then(() => undefined, () => undefined);
  return result;
}

function communityRequest(value, maximumBytes = 32 * 1024) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    failMainOperation('INVALID_COMMUNITY_REQUEST', 'That Community request is invalid.');
  }
  let serialized;
  try {
    serialized = JSON.stringify(value);
  } catch (_error) {
    failMainOperation('INVALID_COMMUNITY_REQUEST', 'That Community request could not be read.');
  }
  if (Buffer.byteLength(serialized, 'utf8') > maximumBytes) {
    failMainOperation('COMMUNITY_REQUEST_TOO_LARGE', 'That Community request is too large.');
  }
  return value;
}

function communityText(value, label, maximum, { required = false } = {}) {
  if (value === undefined || value === null) value = '';
  if (typeof value !== 'string') {
    failMainOperation('INVALID_COMMUNITY_INPUT', `${label} must be text.`);
  }
  const normalized = value.trim();
  if (required && !normalized) {
    failMainOperation('INVALID_COMMUNITY_INPUT', `${label} is required.`);
  }
  if (normalized.length > maximum
    || /[\u0000-\u001f\u007f]/.test(normalized)) {
    failMainOperation('INVALID_COMMUNITY_INPUT', `${label} is invalid.`);
  }
  return normalized;
}

function communityAuthorizationId(value) {
  const id = communityText(value, 'Community authorization', 100, { required: true });
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{7,99}$/.test(id)) {
    failMainOperation('INVALID_COMMUNITY_AUTHORIZATION', 'That Community approval request is invalid.');
  }
  return id;
}

function communityConnectionExpired(connection, now = Date.now()) {
  return !connection?.expiresAt
    || !Number.isFinite(Date.parse(connection.expiresAt))
    || Date.parse(connection.expiresAt) <= now;
}

function requireCommunityReconnectFor(error) {
  if (!['AUTH_REQUIRED', 'PERMISSION_DENIED'].includes(error?.code)) return false;
  communityReconnectRequired = {
    code: error.code,
    message: error.code === 'PERMISSION_DENIED'
      ? 'This Community account no longer has song-editor permission. Connect again with a manager account.'
      : 'This Community approval is no longer valid. Connect this computer again.'
  };
  return true;
}

function terminalCommunityAuthorizationError(error) {
  return [
    'AUTHORIZATION_CANCELLED',
    'AUTHORIZATION_DENIED',
    'AUTHORIZATION_EXPIRED',
    'AUTHORIZATION_NOT_FOUND',
    'AUTH_REQUIRED',
    'BAD_REQUEST',
    'PERMISSION_DENIED',
    'REVISION_CONFLICT',
    'INVALID_RESPONSE'
  ].includes(error?.code);
}

function publicCommunityConnection(connection) {
  if (!connection) return null;
  return {
    id: connection.id,
    serverId: connection.serverId,
    serverName: connection.serverName,
    baseUrl: connection.baseUrl,
    account: connection.account
      ? {
          id: connection.account.id,
          email: connection.account.email,
          name: connection.account.name || null
        }
      : null,
    canReadSongs: connection.canReadSongs === true,
    canWriteSongs: connection.canWriteSongs === true,
    expiresAt: connection.expiresAt,
    createdAt: connection.createdAt,
    updatedAt: connection.updatedAt
  };
}

function publicCommunityError(error) {
  const rawCode = typeof error?.code === 'string' ? error.code : 'COMMUNITY_ERROR';
  const code = /^[A-Z][A-Z0-9_]{2,79}$/.test(rawCode)
    ? rawCode
    : 'COMMUNITY_ERROR';
  const rawMessage = typeof error?.message === 'string' ? error.message.trim() : '';
  const message = rawMessage && rawMessage.length <= 500
    ? rawMessage
    : 'The Community operation could not be completed.';
  return { code, message };
}

async function communityIpcResult(operation) {
  try {
    return { success: true, data: await operation() };
  } catch (error) {
    console.error(`[Community] ${error?.code || error?.name || 'operation-failed'}: ${error?.message || 'Unknown error'}`);
    return { success: false, error: publicCommunityError(error) };
  }
}

async function currentCommunityConnectionSummary() {
  const { connectionStore } = await getCommunityServices();
  const connections = await connectionStore.listConnections();
  return connections[0] || null;
}

async function communityLastSyncFromState(connectionId) {
  if (communityLastSyncSummary) return communityLastSyncSummary;
  if (!connectionId) return null;
  const { stateStore } = await getCommunityServices();
  const state = await stateStore.getConnectionState(connectionId);
  if (!state.lastSyncAt) return null;
  return {
    status: 'synced',
    completedAt: state.lastSyncAt,
    conflicts: Object.values(state.songs).filter(song => song.conflict).length
  };
}

async function communityStatusPayload() {
  const connection = await currentCommunityConnectionSummary();
  const pending = pendingCommunityAuthorizations.values().next().value;
  if (pending) {
    return {
      connected: false,
      pending: true,
      status: 'pending',
      authorizationId: pending.authorizationId,
      serverUrl: pending.discovery.baseUrl,
      adminEmail: pending.email,
      verificationUri: pending.verificationUri,
      userCode: pending.userCode,
      expiresAt: pending.expiresAt,
      pollIntervalMs: pending.pollIntervalMs,
      message: 'Approval email sent. Approve this computer from the Community admin account.'
    };
  }
  if (connection && communityReconnectRequired) {
    return {
      connected: false,
      pending: false,
      status: 'reconnect-required',
      connection: publicCommunityConnection(connection),
      message: communityReconnectRequired.message,
      lastSync: await communityLastSyncFromState(connection.id)
    };
  }
  if (connection && !communityConnectionExpired(connection)) {
    return {
      connected: true,
      pending: false,
      status: 'connected',
      connection: publicCommunityConnection(connection),
      warning: communityConnectionWarning,
      lastSync: await communityLastSyncFromState(connection.id)
    };
  }

  if (connection) {
    return {
      connected: false,
      pending: false,
      status: 'expired',
      connection: publicCommunityConnection(connection),
      message: 'This Community approval expired. Connect again to keep the existing sync history.'
    };
  }
  return {
    connected: false,
    pending: false,
    status: 'disconnected',
    connection: null,
    warning: communityConnectionWarning,
    lastSync: null
  };
}

async function notifyCommunityStatusChanged() {
  if (!controlWindow || controlWindow.isDestroyed()) return;
  try {
    controlWindow.webContents.send(
      'community:statusChanged',
      await communityStatusPayload()
    );
  } catch (error) {
    console.warn('[Community] Could not publish connection status:', error.message);
  }
}

function communityClientForConnection(connection) {
  return new CommunityClient({ baseUrl: connection.baseUrl });
}

function beginCommunityAuthRequest() {
  communityAuthAbortController?.abort();
  const controller = new AbortController();
  communityAuthAbortController = controller;
  return controller;
}

function finishCommunityAuthRequest(controller) {
  if (communityAuthAbortController === controller) {
    communityAuthAbortController = null;
  }
}

async function communitySyncForConnection(connection) {
  const { stateStore, connectionStore } = await getCommunityServices();
  return new CommunitySongSync({
    client: communityClientForConnection(connection),
    localLibrary: getPrepareServices().localSongLibrary,
    stateStore,
    connectionId: connection.id,
    accessTokenProvider: async () => {
      const current = await connectionStore.getConnection(connection.id);
      if (!current || communityConnectionExpired(current)) {
        failMainOperation(
          'COMMUNITY_RECONNECT_REQUIRED',
          'This Community approval expired. Connect this computer again.'
        );
      }
      return current.accessToken;
    }
  });
}

function completeCommunitySyncSummary(result) {
  return {
    ...result,
    completedAt: new Date().toISOString()
  };
}

async function runCommunitySongSync({
  syncId = null,
  visibility = null,
  publishAt = null,
  expectedSyncVersion = null
} = {}) {
  const connection = await currentCommunityConnectionSummary();
  if (communityReconnectRequired) {
    failMainOperation(
      'COMMUNITY_RECONNECT_REQUIRED',
      communityReconnectRequired.message
    );
  }
  if (!connection || communityConnectionExpired(connection)) {
    failMainOperation(
      'COMMUNITY_RECONNECT_REQUIRED',
      'Connect this computer to Heritage Community before syncing songs.'
    );
  }
  if (!connection.canReadSongs) {
    failMainOperation(
      'COMMUNITY_PERMISSION_DENIED',
      'This Community approval cannot read the shared song library.'
    );
  }
  if (visibility !== null && !connection.canWriteSongs) {
    failMainOperation(
      'COMMUNITY_READ_ONLY',
      'This Community approval is read-only. Reconnect with a song editor account.'
    );
  }

  communitySyncAbortController?.abort();
  const controller = new AbortController();
  communitySyncAbortController = controller;
  const epoch = ++communityOperationEpoch;
  try {
    const sync = await communitySyncForConnection(connection);
    let result;
    try {
      result = syncId
        ? await sync.syncSong(syncId, {
            signal: controller.signal,
            ...(visibility === null
              ? {}
              : {
                  visibilityForSong: () => ({
                    visibility,
                    publishAt,
                    expectedSyncVersion
                  })
                })
          })
        : await sync.sync({ signal: controller.signal });
    } catch (error) {
      if (requireCommunityReconnectFor(error)) {
        await notifyCommunityStatusChanged();
      }
      throw error;
    }
    if (controller.signal.aborted || epoch !== communityOperationEpoch) {
      failMainOperation('COMMUNITY_SYNC_CANCELLED', 'Community song sync was cancelled.');
    }
    communityLastSyncSummary = completeCommunitySyncSummary(result);
    await notifyCommunityStatusChanged();
    return communityLastSyncSummary;
  } finally {
    if (communitySyncAbortController === controller) {
      communitySyncAbortController = null;
    }
  }
}

function clearCommunitySyncTimer() {
  if (communitySyncTimer) clearTimeout(communitySyncTimer);
  communitySyncTimer = null;
}

function scheduleCommunitySongSync(reason, delayMs = 1500) {
  clearCommunitySyncTimer();
  communitySyncTimer = setTimeout(() => {
    communitySyncTimer = null;
    serializeCommunityOperation(() => runCommunitySongSync())
      .then(result => {
        console.log(
          `[Community] Background song sync (${reason}) finished: `
          + `${result.pulled || 0} received, ${result.pushed || 0} sent, `
          + `${result.conflicts || 0} conflicts.`
        );
      })
      .catch(error => {
        if (!['COMMUNITY_RECONNECT_REQUIRED', 'COMMUNITY_SYNC_CANCELLED', 'SYNC_CANCELLED']
          .includes(error?.code)) {
          console.warn(`[Community] Background song sync (${reason}) deferred:`, error.message);
        }
      });
  }, Math.max(0, Math.min(delayMs, 30000)));
}

function clearCommunityPeriodicSync({ resetBackoff = false } = {}) {
  if (communityPeriodicSyncTimer) clearTimeout(communityPeriodicSyncTimer);
  communityPeriodicSyncTimer = null;
  communityPeriodicSyncGeneration += 1;
  if (resetBackoff) communityPeriodicSyncFailures = 0;
}

function scheduleCommunityPeriodicSync(options) {
  const { resetBackoff = false } = options || {};
  clearCommunityPeriodicSync({ resetBackoff });
  const backoffMs = Math.min(
    COMMUNITY_PERIODIC_SYNC_BASE_MS * (2 ** Math.min(communityPeriodicSyncFailures, 3)),
    COMMUNITY_PERIODIC_SYNC_MAX_MS
  );
  // A little jitter prevents several venue computers from polling the church
  // server in lockstep after a service-wide restart or power restoration.
  const delayMs = Math.round(backoffMs * (0.9 + (Math.random() * 0.2)));
  const generation = communityPeriodicSyncGeneration;
  communityPeriodicSyncTimer = setTimeout(() => {
    communityPeriodicSyncTimer = null;
    serializeCommunityOperation(() => runCommunitySongSync())
      .then(result => {
        if (generation !== communityPeriodicSyncGeneration) return;
        const deferred = result.status === 'offline';
        communityPeriodicSyncFailures = deferred
          ? Math.min(communityPeriodicSyncFailures + 1, 8)
          : 0;
        if (!deferred) {
          console.log(
            '[Community] Periodic song refresh finished: '
            + `${result.pulled || 0} received, ${result.pushed || 0} sent, `
            + `${result.conflicts || 0} conflicts.`
          );
        }
        scheduleCommunityPeriodicSync();
      })
      .catch(error => {
        if (generation !== communityPeriodicSyncGeneration) return;
        if (['COMMUNITY_RECONNECT_REQUIRED', 'AUTH_REQUIRED', 'PERMISSION_DENIED']
          .includes(error?.code)) {
          clearCommunityPeriodicSync();
          return;
        }
        if (!['COMMUNITY_SYNC_CANCELLED', 'SYNC_CANCELLED'].includes(error?.code)) {
          console.warn('[Community] Periodic song refresh deferred:', error.message);
        }
        communityPeriodicSyncFailures = Math.min(communityPeriodicSyncFailures + 1, 8);
        scheduleCommunityPeriodicSync();
      });
  }, delayMs);
  communityPeriodicSyncTimer.unref?.();
}

async function resolveCommunitySongFamily(songId) {
  const id = prepareId(songId, 'Song');
  const local = await getPrepareServices().localSongLibrary.read(id);
  return {
    songId: id,
    familyId: local.song.translationOf || local.song.id,
    local
  };
}

function findCommunitySongState(connectionState, familyId, songId = familyId) {
  return Object.values(connectionState.songs).find(song =>
    song.syncId === familyId
    || song.localFamilyId === familyId
    || Boolean(song.documents?.[songId])
  ) || null;
}

function publicCommunitySongState(song, connection, {
  familyId,
  exists = null
} = {}) {
  const pending = song?.pendingVisibility || null;
  const hasRemote = exists === null
    ? Boolean(song && (song.syncVersion !== null || song.remoteRevision !== null))
    : exists;
  const conflict = song?.conflict
    ? {
        code: song.conflict.code,
        detectedAt: song.conflict.detectedAt
      }
    : null;
  const status = conflict
    ? 'conflict'
    : song?.archived
      ? 'archived'
      : pending
        ? 'pending'
        : hasRemote
          ? 'synced'
          : 'local-only';
  return {
    connected: Boolean(connection),
    canWriteSongs: connection?.canWriteSongs === true,
    exists: hasRemote,
    status,
    syncId: song?.syncId || familyId,
    localFamilyId: song?.localFamilyId || familyId,
    syncVersion: song?.syncVersion ?? null,
    visibility: pending?.visibility || song?.visibility || 'private',
    publishAt: pending?.publishAt || song?.publishAt || null,
    pendingVisibility: pending
      ? {
          visibility: pending.visibility,
          publishAt: pending.publishAt
        }
      : null,
    archived: song?.archived === true,
    conflict,
    lastSyncedAt: song?.lastSyncedAt || null
  };
}

async function communitySongStatePayload(songId) {
  const local = await resolveCommunitySongFamily(songId);
  const connection = await currentCommunityConnectionSummary();
  if (!connection || communityConnectionExpired(connection) || communityReconnectRequired) {
    return publicCommunitySongState(null, null, {
      familyId: local.familyId,
      exists: false
    });
  }
  const { stateStore } = await getCommunityServices();
  const state = await stateStore.getConnectionState(connection.id);
  const song = findCommunitySongState(state, local.familyId, local.songId);
  return publicCommunitySongState(song, connection, {
    familyId: local.familyId
  });
}

async function localCommunityFamilyDocuments(familyId) {
  const library = getPrepareServices().localSongLibrary;
  const listed = await library.list({
    query: familyId,
    pageSize: 100,
    offset: 0
  });
  const summaries = listed.items
    .filter(summary => summary.id === familyId || summary.translationOf === familyId)
    .sort((left, right) =>
      Number(Boolean(left.translationOf)) - Number(Boolean(right.translationOf))
      || left.id.localeCompare(right.id));
  const documents = [];
  for (const summary of summaries) {
    const document = await library.read(summary.id);
    documents.push({
      id: document.song.id,
      title: document.song.title,
      language: document.song.language,
      translationOf: document.song.translationOf || null,
      revision: document.revision,
      source: document.source
    });
  }
  return documents;
}

function communityConflictDocument(document) {
  let parsed = null;
  try {
    parsed = parseSongDocument(document.source, { fileName: `${document.id}.md` });
  } catch (_error) {
    // The sync core already preserves an invalid remote document as a conflict.
    // Show the source safely as text even when its metadata cannot be parsed.
  }
  return {
    id: document.id,
    title: parsed?.title || document.id,
    language: parsed?.language || null,
    translationOf: parsed?.translationOf || null,
    revision: document.revision,
    source: document.source
  };
}

async function communitySongConflictPayload(songId) {
  const local = await resolveCommunitySongFamily(songId);
  const connection = await currentCommunityConnectionSummary();
  if (!connection || communityConnectionExpired(connection)) {
    failMainOperation(
      'COMMUNITY_RECONNECT_REQUIRED',
      'Reconnect Heritage Community before reviewing this conflict.'
    );
  }
  const { stateStore } = await getCommunityServices();
  const state = await stateStore.getConnectionState(connection.id);
  const song = findCommunitySongState(state, local.familyId, local.songId);
  if (!song?.conflict) {
    failMainOperation(
      'COMMUNITY_CONFLICT_NOT_FOUND',
      'This song no longer has a Community conflict.'
    );
  }
  const localDocuments = await localCommunityFamilyDocuments(local.familyId);
  const currentLocalRevision = crypto.createHash('sha256')
    .update(localDocuments.map(document => `${document.id}:${document.revision}`).join('\n'))
    .digest('hex');
  return {
    syncId: song.syncId,
    familyId: local.familyId,
    code: song.conflict.code,
    detectedAt: song.conflict.detectedAt,
    expectedSyncVersion: song.syncVersion,
    expectedLocalRevision: currentLocalRevision,
    localDocuments,
    communityDocuments: song.conflict.remoteDocuments.map(communityConflictDocument)
  };
}

async function augmentSongLibraryWithCommunity(listing) {
  const connection = await currentCommunityConnectionSummary();
  if (!connection || communityConnectionExpired(connection)) return listing;
  try {
    const { stateStore } = await getCommunityServices();
    const state = await stateStore.getConnectionState(connection.id);
    return {
      ...listing,
      items: listing.items.map(summary => {
        const familyId = summary.translationOf || summary.id;
        const song = findCommunitySongState(state, familyId, summary.id);
        if (!song) return summary;
        return {
          ...summary,
          community: publicCommunitySongState(song, connection, { familyId })
        };
      })
    };
  } catch (error) {
    console.warn('[Community] Song badges are temporarily unavailable:', error.message);
    return listing;
  }
}

async function cancelPendingCommunityAuthorizations() {
  const pending = [...pendingCommunityAuthorizations.values()];
  pendingCommunityAuthorizations.clear();
  await Promise.allSettled(pending.map(item =>
    item.client.cancelDeviceAuthorization(item.authorizationId)));
}

async function cancelCommunityTransientOperations() {
  communityOperationEpoch += 1;
  communitySyncAbortController?.abort();
  communitySyncAbortController = null;
  communityAuthAbortController?.abort();
  communityAuthAbortController = null;
  clearCommunitySyncTimer();
  clearCommunityPeriodicSync();
  await cancelPendingCommunityAuthorizations();
  await notifyCommunityStatusChanged();
}

// Ensure cache directory exists (must be called after app is ready)
function ensureCacheDir() {
  const cacheDir = CONFIG.cacheDir;
  if (!fs.existsSync(cacheDir)) {
    fs.mkdirSync(cacheDir, { recursive: true });
  }
}

function guardControlWindowClose(event) {
  if (controlSettingsDraftState.saving) {
    event.preventDefault();
    dialog.showMessageBoxSync(controlWindow, {
      type: 'info',
      buttons: ['Keep SyncShow Open'],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
      message: 'Admin Settings are still saving',
      detail: 'Wait for the venue profile to finish saving, then close SyncShow again.'
    });
    return;
  }
  if (!controlSettingsDraftState.dirty) return;

  const response = dialog.showMessageBoxSync(controlWindow, {
    type: 'warning',
    buttons: ['Keep Editing', 'Discard Changes and Close'],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
    message: 'Discard unsaved Admin Settings changes?',
    detail: 'The saved venue setup will stay unchanged.'
  });
  if (response !== 1) event.preventDefault();
}

function createControlWindow() {
  controlSettingsDraftState = { dirty: false, saving: false };
  controlWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1200,
    minHeight: 700,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      preload: path.join(__dirname, 'preload.js')
    },
    icon: path.join(__dirname, 'assets', 'icon.png'),
    title: 'SyncShow',
    show: false
  });

  controlWindow.loadFile(path.join(__dirname, 'src', 'renderer', 'index.html'));
  controlWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  controlWindow.webContents.on('will-navigate', (event, url) => {
    if (url !== controlRendererUrl) event.preventDefault();
  });

  controlWindow.once('ready-to-show', () => {
    controlWindow.show();
    // Detect available displays
    updateDisplayList();
  });

  controlWindow.on('close', guardControlWindowClose);
  controlWindow.on('closed', () => {
    if (controlDisplayRefreshTimer) clearTimeout(controlDisplayRefreshTimer);
    controlDisplayRefreshTimer = null;
    controlWindow = null;
    destroyOutputWindows();
    app.quit();
  });
  controlWindow.on('move', scheduleControlDisplayRefresh);
  controlWindow.on('resize', scheduleControlDisplayRefresh);

  // Open DevTools in development
  if (process.argv.includes('--dev')) {
    controlWindow.webContents.on('console-message', (_event, level, message, line, sourceId) => {
      const label = ['debug', 'info', 'warning', 'error'][level] || `level-${level}`;
      console.log(`[Renderer:${label}] ${message} (${sourceId}:${line})`);
    });
    controlWindow.webContents.openDevTools();
  }

  controlWindow.webContents.on('render-process-gone', (_event, details) => {
    console.error('[Renderer] Control process exited unexpectedly:', details);
  });
}

function getControlDisplayId() {
  if (!controlWindow || controlWindow.isDestroyed()) return screen.getPrimaryDisplay().id;
  return screen.getDisplayMatching(controlWindow.getBounds()).id;
}

function scheduleControlDisplayRefresh() {
  if (controlDisplayRefreshTimer) clearTimeout(controlDisplayRefreshTimer);
  controlDisplayRefreshTimer = setTimeout(() => {
    controlDisplayRefreshTimer = null;
    updateDisplayList();
  }, 180);
}

function isCurrentOutputWindow(win, sessionId, outputId) {
  if (!win || win.isDestroyed() || sessionId !== outputSessionId) return false;
  return outputWindows.get(outputId)?.win === win;
}

function trackOutputWindowHealth(win, output, sessionId) {
  const sender = win.webContents;
  const identity = { outputId: output.id, sessionId, sender };
  outputHealthTracker.register(identity);

  win.on('unresponsive', () => {
    if (!isCurrentOutputWindow(win, sessionId, output.id)) return;
    outputHealthTracker.markUnresponsive(identity);
  });
  win.on('responsive', () => {
    if (!isCurrentOutputWindow(win, sessionId, output.id)) return;
    outputHealthTracker.markResponsive(identity);
  });
  sender.on('render-process-gone', (_event, details) => {
    if (!isCurrentOutputWindow(win, sessionId, output.id)) return;
    console.error(`[Display] ${output.name} renderer process exited:`, details);
    outputHealthTracker.markProcessGone(identity);
    handleUnexpectedOutputWindowClose(output.id, 'output-renderer-gone');
  });
}

function handleOutputFrameHealth(event, payload = {}) {
  outputHealthTracker.acknowledge({
    sender: event.sender,
    sessionId: outputSessionId,
    cueIndex: payload?.index,
    ok: payload?.ok
  });
}

// This permanent listener records every current-frame result. Startup also
// installs short-lived waiters, but those only own the reveal barrier and do
// not determine the ongoing public health state.
ipcMain.on('output:frameReady', handleOutputFrameHealth);

function showOutputWindow(win) {
  if (!win || win.isDestroyed()) return;

  // Presentation windows never need keyboard or pointer input. Keeping them
  // inactive prevents Start/Show from taking navigation away from the control
  // panel (especially on Windows when a fullscreen window is revealed).
  win.setIgnoreMouseEvents(true);
  win.showInactive();
  win.setFullScreen(true);
  win.setAlwaysOnTop(true, 'screen-saver');
}

function destroyOutputWindows() {
  stopRemoteForShow('show-ended');
  outputSessionId += 1;
  bibleOperationEpoch += 1;
  outputsShouldBeVisible = false;
  outputHealthTracker?.clear();

  if (outputPreviewTimer) {
    clearTimeout(outputPreviewTimer);
    outputPreviewTimer = null;
  }
  outputPreviewSubscriptions = new Set();
  const hadBibleOverlay = Boolean(activeBibleOverlay || pendingBibleOverlay);
  if (pendingBibleOverlay) {
    cancelPendingBibleOverlay(new Error('The output session was closed'));
  }
  activeBibleOverlay = null;
  pendingBibleOverlay = null;

  const windows = new Set(
    [...outputWindows.values()]
      .map(entry => entry.win)
      .filter(Boolean)
  );

  // Drop shared references before destroying. Any late window callback will
  // then fail its session/reference check instead of touching a replacement.
  outputWindows = new Map();
  appState.displayAssignments = new Map();
  appState.activeLaunchPlan = null;
  appState.isCleared = false;
  outputLifecyclePhase = 'idle';

  windows.forEach(win => {
    if (!win.isDestroyed()) {
      win.destroy();
    }
  });

  if (hadBibleOverlay) notifyBibleStateChanged({ publish: false });
  showGateway?.endSession('session-ended');
}

function handleUnexpectedOutputWindowClose(outputId, reason = 'output-closed') {
  if (!appState.activeLaunchPlan) return;
  outputLifecyclePhase = 'interrupted';
  publishShowState('output-interrupted');
  destroyOutputWindows();
  if (controlWindow && !controlWindow.isDestroyed()) {
    controlWindow.webContents.send('display:interrupted', {
      reason,
      affectedOutputs: [outputId]
    });
  }
}

function createDisplayWindow(displayInfo, output, sessionId) {
  const { bounds } = displayInfo;

  // For Windows: Use fullscreen mode with proper bounds
  // Kiosk mode doesn't work reliably on secondary displays
  const win = new BrowserWindow({
    x: bounds.x,
    y: bounds.y,
    width: bounds.width,
    height: bounds.height,
    frame: false,
    fullscreen: false,  // Will set fullscreen after show
    fullscreenable: true,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    backgroundColor: '#000000',
    focusable: false,
    // Important: This enables proper fullscreen behavior
    autoHideMenuBar: true,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      preload: path.join(__dirname, 'preload.js'),
      backgroundThrottling: false
    },
    show: false
  });

  win.setIgnoreMouseEvents(true);

  win.loadFile(path.join(__dirname, 'src', 'renderer', 'display.html')).catch(error => {
    if (isCurrentOutputWindow(win, sessionId, output.id)) {
      console.error(`[Display] Failed to load ${output.name} window:`, error);
    }
    if (!win.isDestroyed()) win.destroy();
  });

  win.once('ready-to-show', () => {
    if (!isCurrentOutputWindow(win, sessionId, output.id)) {
      if (!win.isDestroyed()) win.destroy();
      return;
    }

    // First, position the window on the correct display
    win.setBounds({
      x: bounds.x,
      y: bounds.y,
      width: bounds.width,
      height: bounds.height
    });

    // Send initial configuration
    win.webContents.send('display:init', {
      // display.js currently calls this field "language", but it is a window
      // routing identity. Keep the wire field for compatibility while using a
      // unique output ID so multiple screens may mirror the same source role.
      language: output.id,
      outputId: output.id,
      outputName: output.name,
      sourceRoleId: output.sourceRoleId,
      renderer: output.renderer,
      displayId: output.displayId,
      fadeDuration: appState.fadeDuration,
      syncMode: appState.syncMode,
      ...(output.renderer === 'native-cue'
        ? { fontPath: getBundledPresentationFontPath() }
        : {})
    });

    win.syncShowReady = true;

    console.log(`[Display] Created ${output.name} (${output.id}) on display ${output.displayId} from ${output.sourceRoleId} at ${bounds.x},${bounds.y} ${bounds.width}x${bounds.height}`);
  });

  // Prevent window from being closed accidentally
  win.on('close', (e) => {
    if (controlWindow && !controlWindow.isDestroyed()) {
      e.preventDefault();
      win.hide();
      if (isCurrentOutputWindow(win, sessionId, output.id)) {
        handleUnexpectedOutputWindowClose(output.id, 'output-hidden');
      }
    }
  });

  win.on('closed', () => {
    if (outputWindows.get(output.id)?.win === win) {
      outputWindows.delete(output.id);
      handleUnexpectedOutputWindowClose(output.id);
    }
  });

  return win;
}

function createSingerWindow(displayInfo, output, sessionId) {
  const { bounds } = displayInfo;

  const win = new BrowserWindow({
    x: bounds.x,
    y: bounds.y,
    width: bounds.width,
    height: bounds.height,
    frame: false,
    fullscreen: false,  // Will set fullscreen after show
    fullscreenable: true,
    resizable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    backgroundColor: '#000000',
    focusable: false,
    autoHideMenuBar: true,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js'),
      backgroundThrottling: false
    },
    show: false
  });

  win.setIgnoreMouseEvents(true);

  if (process.argv.includes('--dev')) {
    win.webContents.on('console-message', (event, level, message) => {
      console.log(`[Singer Renderer:${level}] ${message}`);
    });
  }

  win.loadFile(path.join(__dirname, 'src', 'renderer', 'singer.html')).catch(error => {
    if (isCurrentOutputWindow(win, sessionId, output.id)) {
      console.error(`[Singer] Failed to load ${output.name} window:`, error);
    }
    if (!win.isDestroyed()) win.destroy();
  });

  win.webContents.once('did-finish-load', () => {
    if (!isCurrentOutputWindow(win, sessionId, output.id)) return;

    console.log(`[Singer] ${output.name} content loaded`);
    // Send current font size setting
    win.webContents.send('singer:fontSizeUpdate', appState.singerFontSize);
    win.webContents.send('singer:charLimitUpdate', appState.singerCharLimit);
    win.webContents.send('singer:textPaddingUpdate', appState.singerTextPadding);
  });

  win.once('ready-to-show', () => {
    if (!isCurrentOutputWindow(win, sessionId, output.id)) {
      if (!win.isDestroyed()) win.destroy();
      return;
    }

    // First, position the window on the correct display
    win.setBounds({
      x: bounds.x,
      y: bounds.y,
      width: bounds.width,
      height: bounds.height
    });

    win.syncShowReady = true;

    console.log(`[Singer] Created ${output.name} (${output.id}) on display ${output.displayId} from ${output.sourceRoleId} at ${bounds.x},${bounds.y} ${bounds.width}x${bounds.height}`);
  });

  win.on('closed', () => {
    if (outputWindows.get(output.id)?.win === win) {
      outputWindows.delete(output.id);
      handleUnexpectedOutputWindowClose(output.id);
    }
  });

  return win;
}

function waitForOutputWindowReady(win, output, sessionId, timeoutMs = 15000) {
  const label = output.name || output.id;

  if (win.syncShowReady && isCurrentOutputWindow(win, sessionId, output.id)) {
    return Promise.resolve();
  }

  return new Promise((resolve, reject) => {
    let settled = false;

    const cleanup = () => {
      clearTimeout(timeoutId);
      win.removeListener('ready-to-show', handleReady);
      win.removeListener('closed', handleClosed);
      win.webContents.removeListener('did-fail-load', handleLoadFailure);
    };
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      cleanup();
      callback(value);
    };
    const handleReady = () => {
      if (!isCurrentOutputWindow(win, sessionId, output.id)) {
        finish(reject, new Error(`${label} output was replaced before it became ready`));
        return;
      }
      finish(resolve);
    };
    const handleClosed = () => {
      finish(reject, new Error(`${label} output closed before it became ready`));
    };
    const handleLoadFailure = (event, errorCode, errorDescription) => {
      finish(
        reject,
        new Error(`${label} output failed to load (${errorCode}): ${errorDescription}`)
      );
    };
    const timeoutId = setTimeout(() => {
      finish(reject, new Error(`${label} output did not become ready within ${timeoutMs / 1000} seconds`));
    }, timeoutMs);

    win.once('ready-to-show', handleReady);
    win.once('closed', handleClosed);
    win.webContents.once('did-fail-load', handleLoadFailure);
  });
}

function waitForInitialOutputFrame(win, output, sessionId, slideIndex, timeoutMs = 15000) {
  const label = output.name || output.id;

  return new Promise((resolve, reject) => {
    let settled = false;

    const cleanup = () => {
      clearTimeout(timeoutId);
      ipcMain.removeListener('output:frameReady', handleFrameReady);
      win.removeListener('closed', handleClosed);
    };
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      cleanup();
      callback(value);
    };
    const handleFrameReady = (event, payload = {}) => {
      // ipcRenderer.send() is authoritatively received through ipcMain. Scope
      // the acknowledgement to this exact output WebContents so one window
      // can never satisfy another output's startup barrier.
      if (event.sender !== win.webContents) return;
      if (!payload || payload.index !== slideIndex) return;

      if (!isCurrentOutputWindow(win, sessionId, output.id)) {
        finish(reject, new Error(`${label} output was replaced before its first frame was ready`));
        return;
      }
      if (payload.ok !== true) {
        if (payload.ok !== false) return;
        finish(
          reject,
          new Error(`${label} output could not prepare its first frame${payload.error ? `: ${payload.error}` : ''}`)
        );
        return;
      }
      finish(resolve);
    };
    const handleClosed = () => {
      finish(reject, new Error(`${label} output closed before its first frame was ready`));
    };
    const timeoutId = setTimeout(() => {
      finish(
        reject,
        new Error(`${label} output did not prepare its first frame within ${timeoutMs / 1000} seconds`)
      );
    }, timeoutMs);

    ipcMain.on('output:frameReady', handleFrameReady);
    win.once('closed', handleClosed);
  });
}

function updateDisplayList() {
  const primaryDisplayId = screen.getPrimaryDisplay().id;
  const controlDisplayId = getControlDisplayId();
  appState.displays = screen.getAllDisplays().map((display, index) => ({
    id: display.id,
    index: index,
    // Electron does not expose a portable monitor serial on every OS. This
    // conservative fingerprint omits desktop position so a cable rearrangement
    // can still reconnect a unique monitor. Duplicate fingerprints are treated
    // as ambiguous by the renderer rather than guessed.
    fingerprint: [
      'display-v1',
      process.platform,
      display.internal ? 'internal' : 'external',
      `${display.size?.width || display.bounds.width}x${display.size?.height || display.bounds.height}`,
      `scale-${display.scaleFactor || 1}`,
      `rotation-${display.rotation || 0}`,
      `touch-${display.touchSupport || 'unknown'}`
    ].join(':'),
    label: `Display ${index + 1}${display.internal ? ' (Built-in)' : ''} - ${display.bounds.width}x${display.bounds.height}`,
    bounds: display.bounds,
    isPrimary: display.id === primaryDisplayId,
    isControl: display.id === controlDisplayId
  }));

  if (controlWindow && !controlWindow.isDestroyed()) {
    controlWindow.webContents.send('displays:updated', appState.displays);
  }
}

function closeIdentifyWindows() {
  if (identifyTimer) {
    clearTimeout(identifyTimer);
    identifyTimer = null;
  }
  for (const win of identifyWindows) {
    if (win && !win.isDestroyed()) win.destroy();
  }
  identifyWindows = [];
}

async function identifyAllDisplays() {
  closeIdentifyWindows();
  updateDisplayList();
  const electronDisplays = screen.getAllDisplays();

  for (const [index, display] of electronDisplays.entries()) {
    const descriptor = appState.displays.find(item => String(item.id) === String(display.id));
    const win = new BrowserWindow({
      x: display.bounds.x,
      y: display.bounds.y,
      width: display.bounds.width,
      height: display.bounds.height,
      frame: false,
      transparent: true,
      alwaysOnTop: true,
      skipTaskbar: true,
      focusable: false,
      show: false,
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true
      }
    });
    win.setIgnoreMouseEvents(true);
    const safeLabel = String(descriptor?.label || `Display ${index + 1}`)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
    const html = `<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
      <style>html,body{height:100%;margin:0;background:transparent;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif}body{display:grid;place-items:center}.card{min-width:min(520px,75vw);padding:42px;text-align:center;color:white;background:rgba(12,20,36,.94);border:4px solid #6d91ff;border-radius:28px;box-shadow:0 24px 80px rgba(0,0,0,.55)}strong{display:block;font-size:clamp(86px,14vw,180px);line-height:.9}span{display:block;margin-top:22px;font-size:clamp(24px,3vw,46px);font-weight:700}</style>
      <body><div class="card"><strong>${index + 1}</strong><span>${safeLabel}</span></div></body>`;
    await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
    win.showInactive();
    identifyWindows.push(win);
  }

  identifyTimer = setTimeout(closeIdentifyWindows, 4500);
  return { success: true, count: identifyWindows.length };
}

function handleDisplayRemoved(removedDisplay) {
  if (!removedDisplay) {
    updateDisplayList();
    return;
  }

  const affectedOutputs = [...appState.displayAssignments.entries()]
    .filter(([, displayId]) => displayId === removedDisplay.id)
    .map(([output]) => output);

  if (affectedOutputs.length > 0) {
    // Fullscreen windows can be relocated onto a remaining/primary monitor by
    // the OS after an unplug. Tear down the entire output session immediately
    // so content cannot cover the controller or appear on the wrong screen.
    outputLifecyclePhase = 'interrupted';
    publishShowState('output-interrupted');
    destroyOutputWindows();

    if (controlWindow && !controlWindow.isDestroyed()) {
      controlWindow.webContents.send('display:interrupted', {
        reason: 'display-removed',
        displayId: removedDisplay.id,
        affectedOutputs
      });
    }
  }

  updateDisplayList();
}

// DEPRECATED: Global keyboard shortcuts were disabled because Electron's globalShortcut
// captures keys system-wide (even when the app is not focused), which caused accidental
// slide navigation when typing in other applications during a live show.
// Keyboard handling is now done entirely in the renderer (app.js) via document keydown
// events, which only fire when the control panel window is focused.
//
// let shortcutsRegistered = false;
//
// function registerGlobalShortcuts() {
//   if (shortcutsRegistered) return;
//   globalShortcut.register('Right', () => navigateSlide(1));
//   globalShortcut.register('Left', () => navigateSlide(-1));
//   globalShortcut.register('Space', () => navigateSlide(1));
//   globalShortcut.register('Home', () => goToSlide(0));
//   globalShortcut.register('End', () => goToSlide(appState.totalSlides - 1));
//   globalShortcut.register('Escape', () => { clearAllDisplays(); });
//   shortcutsRegistered = true;
// }
//
// function unregisterGlobalShortcuts() {
//   if (!shortcutsRegistered) return;
//   globalShortcut.unregister('Right');
//   globalShortcut.unregister('Left');
//   globalShortcut.unregister('Space');
//   globalShortcut.unregister('Home');
//   globalShortcut.unregister('End');
//   globalShortcut.unregister('Escape');
//   shortcutsRegistered = false;
// }

function navigateSlide(delta) {
  if (!appState.activeLaunchPlan) {
    return { accepted: false, code: 'NO_ACTIVE_SHOW', message: 'There is no active Show.' };
  }
  if (outputLifecyclePhase === 'locally-stopped') {
    return { accepted: false, code: 'SHOW_STOPPED_LOCALLY', message: 'The outputs were stopped locally.' };
  }
  // Keep slide navigation from replacing an in-flight Bible transaction.
  // Both the acknowledged local IPC boundary and RemoteCommandAdapter surface
  // this rejection to their respective operators.
  if (activeBibleOverlay || pendingBibleOverlay) {
    return {
      accepted: false,
      code: 'BIBLE_OVERLAY_ACTIVE',
      message: 'Return from the Bible passage before changing cues.'
    };
  }
  const newSlide = appState.currentSlide + delta;
  if (newSlide >= 0 && newSlide < appState.totalSlides) {
    return goToSlide(newSlide);
  }
  return {
    accepted: false,
    code: delta < 0 ? 'AT_FIRST_CUE' : 'AT_LAST_CUE',
    message: delta < 0 ? 'The Show is already at the first cue.' : 'The Show is already at the last cue.'
  };
}

function goToSlide(slideIndex, { publish = true } = {}) {
  if (!appState.activeLaunchPlan) {
    return { accepted: false, code: 'NO_ACTIVE_SHOW', message: 'There is no active Show.' };
  }
  if (outputLifecyclePhase === 'locally-stopped') {
    return { accepted: false, code: 'SHOW_STOPPED_LOCALLY', message: 'The outputs were stopped locally.' };
  }
  if (activeBibleOverlay || pendingBibleOverlay) {
    return { accepted: false, code: 'BIBLE_OVERLAY_ACTIVE', message: 'Return from the Bible passage first.' };
  }
  if (!Number.isInteger(slideIndex) || slideIndex < 0 || slideIndex >= appState.totalSlides) {
    return { accepted: false, code: 'INVALID_CUE_INDEX', message: 'That cue does not exist.' };
  }

  appState.currentSlide = slideIndex;
  // Navigation is a live action in SyncShow. If the outputs were cleared, a
  // cue selection restores content; keep the main-process state aligned with
  // what the output renderers actually reveal.
  appState.isCleared = false;
  if (outputLifecyclePhase !== 'starting') outputLifecyclePhase = 'live';
  const timestamp = Date.now();

  // In sync mode, calculate a target reveal time in the future
  // This gives all windows time to load and prepare, then reveal simultaneously
  const revealDelay = appState.syncMode ? 100 : 0;  // 100ms coordination window
  const revealAt = timestamp + revealDelay;

  // Send to every resolved output simultaneously. Window identity is the
  // output ID; sourceRoleId independently selects the loaded slideshow. This
  // permits any number of physical outputs to mirror the same role.
  const slideData = {
    index: slideIndex,
    timestamp: timestamp,
    revealAt: revealAt,  // Target time to reveal (used in sync mode)
    syncMode: appState.syncMode,
    preload: {
      prev: Math.max(0, slideIndex - 1),
      next: Math.min(appState.totalSlides - 1, slideIndex + 1)
    }
  };

  for (const { win, output, sessionId } of outputWindows.values()) {
    if (!win || win.isDestroyed() || win.webContents.isDestroyed()) continue;

    outputHealthTracker.expectFrame({
      outputId: output.id,
      sessionId,
      sender: win.webContents,
      cueIndex: slideIndex
    });

    const sourceRoleId = output.sourceRoleId;
    if (output.renderer === 'native-cue') {
      const nativeCue = getNativeCuePayload(sourceRoleId, slideIndex, output.nativeVariant);
      win.webContents.send('native-cue:goto', {
        ...slideData,
        outputId: output.id,
        sourceRoleId,
        scene: nativeCue?.scene || null,
        assetPaths: nativeCue?.assetPaths || {}
      });
      continue;
    }

    if (output.renderer === 'slides') {
      win.webContents.send('slide:goto', {
        ...slideData,
        language: output.id,
        outputId: output.id,
        sourceRoleId,
        imagePath: getSlideImagePath(sourceRoleId, slideIndex),
        preloadPaths: {
          prev: getSlideImagePath(sourceRoleId, slideData.preload.prev),
          next: getSlideImagePath(sourceRoleId, slideData.preload.next)
        }
      });
      continue;
    }

    if (output.renderer === 'singer-current-next') {
      const currentSlideImage = getSlideImagePath(sourceRoleId, slideIndex);
      const nextSlideText = getSlideText(sourceRoleId, slideIndex + 1);

      console.log(`[Singer] Sending ${output.name}: slide ${slideIndex + 1}, source ${sourceRoleId}, image: ${currentSlideImage ? 'yes' : 'no'}, nextText: "${nextSlideText?.substring(0, 30) || 'none'}..."`);

      win.webContents.send('singer:update', {
        outputId: output.id,
        currentSlide: slideIndex + 1,
        currentSlideImage,
        nextSlideText,
        totalSlides: appState.totalSlides,
        language: sourceRoleId
      });
    }
  }

  // Update control panel
  if (controlWindow && !controlWindow.isDestroyed()) {
    controlWindow.webContents.send('slide:changed', {
      currentSlide: slideIndex,
      totalSlides: appState.totalSlides
    });
  }

  // Capture every output selected for the operator after it has rendered.
  captureOutputPreviews();
  if (publish) publishShowState('cue-changed');
  return { accepted: true };
}

function getSlideImagePath(language, slideIndex) {
  const presentation = appState.presentations[language];
  if (!presentation) {
    console.log(`[getSlideImagePath] No presentation for ${language}`);
    return null;
  }
  if (!presentation.cacheDir) {
    console.log(`[getSlideImagePath] No cacheDir for ${language}`);
    return null;
  }

  const paddedIndex = String(slideIndex + 1).padStart(3, '0');
  const imagePath = path.join(presentation.cacheDir, `slide_${paddedIndex}.jpg`);

  // Check if file exists
  if (!fs.existsSync(imagePath)) {
    console.log(`[getSlideImagePath] File not found: ${imagePath}`);
    return null;
  }

  return imagePath;
}

function getNativeCuePayload(roleId, slideIndex, variant = null) {
  const presentation = appState.presentations[roleId];
  if (!presentation
    || presentation.renderer !== 'native-cue'
    || !Array.isArray(presentation.scenes)
    || !presentation.scenes[slideIndex]) {
    return null;
  }
  let scene = presentation.scenes[slideIndex];
  if (variant === 'singer-current-next') {
    const nextScene = presentation.scenes[slideIndex + 1];
    scene = deriveNativeSingerScene(
      scene,
      nextScene ? nativeSceneSingerLine(nextScene) : ''
    );
  }
  const assetPaths = {};
  for (const assetId of sceneAssetIds(scene)) {
    const assetPath = presentation.assetPaths?.[assetId];
    if (!assetPath || !path.isAbsolute(assetPath) || !fs.existsSync(assetPath)) {
      return null;
    }
    assetPaths[assetId] = assetPath;
  }
  return { scene, assetPaths };
}

function getSlideText(language, slideIndex) {
  const presentation = appState.presentations[language];
  if (!presentation) {
    console.log(`[getSlideText] No presentation for ${language}`);
    return '';
  }
  if (!presentation.metadata) {
    console.log(`[getSlideText] No metadata for ${language}`);
    return '';
  }

  const metadata = presentation.metadata;
  if (metadata && metadata.slides && metadata.slides[slideIndex]) {
    const text = metadata.slides[slideIndex].firstLine || metadata.slides[slideIndex].text || '';
    console.log(`[getSlideText] ${language} slide ${slideIndex}: "${text.substring(0, 50)}..."`);
    return text;
  }
  console.log(`[getSlideText] No slide data for ${language} index ${slideIndex}`);
  return '';
}

function hideDisplayWindows() {
  stopRemoteForShow('outputs-stopped');
  if (activeBibleOverlay || pendingBibleOverlay) hideBibleOverlay({ restore: false });
  else bibleOperationEpoch += 1;
  outputsShouldBeVisible = false;
  if (appState.activeLaunchPlan) outputLifecyclePhase = 'locally-stopped';
  if (outputPreviewTimer) {
    clearTimeout(outputPreviewTimer);
    outputPreviewTimer = null;
  }

  outputWindows.forEach(({ win }) => {
    if (win && !win.isDestroyed()) {
      win.setFullScreen(false);  // Exit fullscreen before hiding
      win.hide();
    }
  });
  publishShowState('outputs-stopped');
  return { accepted: true };
}

// Clear all displays to black
function clearAllDisplays() {
  if (!appState.activeLaunchPlan || outputWindows.size === 0) {
    return { accepted: false, code: 'NO_ACTIVE_SHOW', message: 'There is no active Show.' };
  }
  // Clear is the emergency escape hatch. A temporary Bible overlay is
  // cancelled before every output is blacked, so Return cannot unexpectedly
  // resurrect it later.
  if (activeBibleOverlay || pendingBibleOverlay) hideBibleOverlay({ restore: false });
  else bibleOperationEpoch += 1;
  appState.isCleared = true;
  if (outputLifecyclePhase !== 'locally-stopped') outputLifecyclePhase = 'cleared';
  outputWindows.forEach(({ win }) => {
    if (win && !win.isDestroyed()) {
      win.webContents.send('display:clear');
    }
  });
  // Notify control panel
  if (controlWindow && !controlWindow.isDestroyed()) {
    controlWindow.webContents.send('displays:cleared');
  }
  captureOutputPreviews();
  publishShowState('outputs-cleared');
  return { accepted: true };
}

// Show all displays and re-send current slide
function showAllDisplays() {
  if (!appState.activeLaunchPlan || outputWindows.size === 0) {
    return { accepted: false, code: 'NO_ACTIVE_SHOW', message: 'There is no active Show.' };
  }
  appState.isCleared = false;
  outputsShouldBeVisible = true;
  outputLifecyclePhase = 'live';

  // Re-show windows if hidden
  outputWindows.forEach(({ win }) => {
    if (win && !win.isDestroyed() && !win.isVisible()) {
      showOutputWindow(win);
    }
  });

  // Re-send current slide to all displays
  const navigation = goToSlide(appState.currentSlide, { publish: false });
  publishShowState('outputs-restored');
  return navigation.accepted === false && navigation.code !== 'BIBLE_OVERLAY_ACTIVE'
    ? navigation
    : { accepted: true };
}

// Capture each configured operator preview and send it to the control panel.
// Captures are deliberately deferred and coalesced so they never delay output
// navigation or the first-frame reveal barrier.
function captureOutputPreviews() {
  if (!controlWindow || controlWindow.isDestroyed()) return;

  const previewEntries = [...outputWindows.values()]
    .filter(({ win, output }) =>
      output.operatorPreview
      && outputPreviewSubscriptions.has(output.id)
      && win
      && !win.isDestroyed()
    );
  if (previewEntries.length === 0) return;

  const previewSessionId = outputSessionId;

  // Debounce: if rapid slide changes, only capture after settling
  if (outputPreviewTimer) clearTimeout(outputPreviewTimer);
  outputPreviewTimer = setTimeout(async () => {
    outputPreviewTimer = null;
    await Promise.allSettled(previewEntries.map(async ({ win, output }, index) => {
      try {
        if (!isCurrentOutputWindow(win, previewSessionId, output.id)) return;
        if (!controlWindow || controlWindow.isDestroyed()) return;
        const image = await win.webContents.capturePage();
        if (!isCurrentOutputWindow(win, previewSessionId, output.id)) return;
        if (!controlWindow || controlWindow.isDestroyed()) return;
        const dataUrl = 'data:image/jpeg;base64,' + image.toJPEG(60).toString('base64');
        controlWindow.webContents.send('output:preview', {
          outputId: output.id,
          outputName: output.name,
          dataUrl
        });

        // Keep the previous renderer contract alive during settings migration.
        if (index === 0) controlWindow.webContents.send('singer:preview', dataUrl);
      } catch (err) {
        console.error(`[Preview] ${output.name} capture failed:`, err.message);
      }
    }));
  }, 120);
}

ipcMain.on('singer:requestPreview', (event) => {
  if (!isControlSender(event)) return;
  captureOutputPreviews();
});

ipcMain.on('output:requestPreviews', (event) => {
  if (!isControlSender(event)) return;
  captureOutputPreviews();
});

ipcMain.on('output:setPreviewSubscriptions', (event, outputIds = []) => {
  if (!isControlSender(event) || !Array.isArray(outputIds)) return;
  const available = new Set(
    [...outputWindows.values()]
      .filter(({ output }) => output.operatorPreview)
      .map(({ output }) => output.id)
  );
  const nextSubscriptions = new Set(
    outputIds
      .filter(outputId => typeof outputId === 'string' && available.has(outputId))
      .slice(0, 32)
  );
  for (const outputId of outputPreviewSubscriptions) {
    if (!nextSubscriptions.has(outputId) && controlWindow && !controlWindow.isDestroyed()) {
      controlWindow.webContents.send('output:preview', { outputId, cleared: true });
    }
  }
  outputPreviewSubscriptions = nextSubscriptions;
  captureOutputPreviews();
});

function notifyBibleStateChanged({ publish = true } = {}) {
  if (controlWindow && !controlWindow.isDestroyed()) {
    controlWindow.webContents.send('bible:stateChanged', activeBibleOverlay
      ? {
          isLive: true,
          passage: activeBibleOverlay.passage,
          targetOutputIds: [...activeBibleOverlay.targetOutputIds]
        }
      : { isLive: false, targetOutputIds: [] });
  }
  if (publish) publishShowState('bible-state-changed');
}

function normalizeBibleLookupRequest(request = {}) {
  if (!request || typeof request !== 'object' || Array.isArray(request)) {
    throw new TypeError('Bible lookup request must be an object');
  }
  const query = typeof request.query === 'string' ? request.query.trim() : '';
  if (!query || query.length > 160) {
    throw new TypeError('Enter a Bible reference up to 160 characters');
  }
  const translationId = typeof request.translationId === 'string'
    ? request.translationId.trim().toUpperCase()
    : 'BSB';
  if (translationId !== 'BSB' && translationId !== 'LSV') {
    throw new TypeError('Unknown Bible translation');
  }
  const selectedBook = typeof request.selectedBook === 'string'
    ? request.selectedBook.trim()
    : null;
  if (selectedBook && selectedBook.length > 80) {
    throw new TypeError('Bible book selection is too long');
  }
  return { query, translationId, selectedBook: selectedBook || null };
}

async function resolveBibleLookupRequest(request) {
  const { query, translationId, selectedBook } = normalizeBibleLookupRequest(request);
  return bibleLibrary.lookup(query, {
    translationId,
    ...(selectedBook ? { selectedBook } : {})
  });
}

function createBibleOverlayWaiter(
  win,
  output,
  sessionId,
  overlayId,
  timeoutMs = 7000,
  { eventChannel = 'bible:ready', phase = 'prepare' } = {}
) {
  const label = output.name || output.id;
  const continuousPhase = phase === 'reveal'
    ? 'revealing'
    : (phase === 'hide' ? 'hiding' : 'preparing');
  let cancelWaiter = () => {};
  const promise = new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      clearTimeout(timeoutId);
      ipcMain.removeListener(eventChannel, handleSignal);
      win.removeListener('closed', handleClosed);
    };
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      cleanup();
      callback(value);
    };
    const handleSignal = (event, payload = {}) => {
      if (event.sender !== win.webContents || payload.overlayId !== overlayId) return;
      if (!isCurrentOutputWindow(win, sessionId, output.id)) {
        finish(reject, new Error(`${label} was replaced while ${continuousPhase} the Bible passage`));
      } else if (payload.ok === false) {
        finish(reject, new Error(`${label} could not ${phase} the Bible passage${payload.error ? `: ${payload.error}` : ''}`));
      } else {
        finish(resolve);
      }
    };
    const handleClosed = () => {
      finish(reject, new Error(`${label} closed while ${continuousPhase} the Bible passage`));
    };
    const timeoutId = setTimeout(() => {
      finish(reject, new Error(`${label} did not ${phase} the Bible passage in time`));
    }, timeoutMs);

    cancelWaiter = reason => {
      finish(reject, reason instanceof Error ? reason : new Error(String(reason)));
    };

    ipcMain.on(eventChannel, handleSignal);
    win.once('closed', handleClosed);
  });
  return { promise, cancel: cancelWaiter };
}

function createBibleOverlayRevealWaiter(win, output, sessionId, overlayId, timeoutMs = 3000) {
  return createBibleOverlayWaiter(win, output, sessionId, overlayId, timeoutMs, {
    eventChannel: 'bible:revealed',
    phase: 'reveal'
  });
}

function createBibleOverlayHideWaiter(win, output, sessionId, overlayId, timeoutMs = 3000) {
  return createBibleOverlayWaiter(win, output, sessionId, overlayId, timeoutMs, {
    eventChannel: 'bible:hidden',
    phase: 'hide'
  });
}

function sendToBibleOutput(outputId, channel, payload) {
  const entry = outputWindows.get(outputId);
  if (!entry?.win || entry.win.isDestroyed()) return false;
  entry.win.webContents.send(channel, payload);
  return true;
}

function cancelBibleOverlayWaiters(overlay, reason) {
  for (const waiter of overlay?.waiters || []) {
    waiter.cancel(reason);
  }
}

function cancelPendingBibleOverlay(reason = new Error('The Bible send was replaced')) {
  const pending = pendingBibleOverlay;
  if (!pending) return false;
  cancelBibleOverlayWaiters(pending, reason);
  for (const outputId of pending.targetOutputIds) {
    sendToBibleOutput(outputId, 'bible:hide', { overlayId: pending.id });
  }
  pendingBibleOverlay = null;
  return true;
}

function hideBibleOverlay({ restore = true } = {}) {
  bibleOperationEpoch += 1;
  const overlay = activeBibleOverlay;
  const pending = pendingBibleOverlay;
  if (!overlay && !pending) return false;

  if (pending) {
    cancelBibleOverlayWaiters(pending, new Error('The Bible send was cancelled'));
    for (const outputId of pending.targetOutputIds) {
      sendToBibleOutput(outputId, 'bible:hide', { overlayId: pending.id });
    }
  }
  if (overlay) {
    for (const outputId of overlay.targetOutputIds) {
      sendToBibleOutput(outputId, 'bible:hide', { overlayId: overlay.id });
    }
  }
  activeBibleOverlay = null;
  pendingBibleOverlay = null;
  notifyBibleStateChanged();

  const returnState = overlay?.returnState || pending?.returnState;
  if (restore) {
    if (returnState.isCleared) {
      clearAllDisplays();
    } else {
      appState.isCleared = false;
      goToSlide(returnState.currentSlide);
    }
  }
  captureOutputPreviews();
  return true;
}

// IPC Handlers
ipcMain.handle('bible:lookup', async (event, request = {}) => {
  requireControlSender(event);
  return resolveBibleLookupRequest(request);
});

ipcMain.handle('bible:show', async (event, request = {}) => {
  requireControlSender(event);
  if (!appState.activeLaunchPlan || outputWindows.size === 0 || !outputsShouldBeVisible) {
    throw new Error('Start and show the output screens before sending a Bible passage live');
  }
  if (!Array.isArray(request.targetOutputIds)) {
    throw new TypeError('Choose at least one output screen');
  }

  const targetOutputIds = [...new Set(request.targetOutputIds
    .filter(outputId => typeof outputId === 'string'))]
    .slice(0, 32);
  if (targetOutputIds.length === 0) throw new Error('Choose at least one output screen');
  const sessionId = outputSessionId;
  const operationEpoch = ++bibleOperationEpoch;
  cancelPendingBibleOverlay();
  const lookupResult = await resolveBibleLookupRequest(request);
  if (operationEpoch !== bibleOperationEpoch
    || sessionId !== outputSessionId
    || !appState.activeLaunchPlan
    || !outputsShouldBeVisible) {
    throw new Error('The Bible send was cancelled because the output session changed');
  }
  if (lookupResult?.status !== 'ok' || !lookupResult.passage) {
    if (lookupResult?.status === 'ambiguous') {
      throw new Error('Choose which Bible book you meant before sending it live');
    }
    throw new Error(lookupResult?.message || 'The Bible passage could not be loaded');
  }

  const passageBytes = Buffer.byteLength(JSON.stringify(lookupResult.passage), 'utf8');
  if (passageBytes > 64 * 1024) throw new Error('That Bible passage is too large for one live overlay');

  const targetEntries = targetOutputIds.map(outputId => {
    const entry = outputWindows.get(outputId);
    if (!entry?.win
      || entry.win.isDestroyed()
      || !isCurrentOutputWindow(entry.win, sessionId, outputId)) {
      throw new Error('One of the selected output screens is no longer available');
    }
    return entry;
  });

  const previousOverlay = activeBibleOverlay;
  const returnState = previousOverlay?.returnState || {
    currentSlide: appState.currentSlide,
    isCleared: appState.isCleared
  };
  const overlayId = `${sessionId}:${++bibleOverlaySequence}`;
  const candidate = {
    id: overlayId,
    sessionId,
    passage: lookupResult.passage,
    targetOutputIds,
    returnState,
    waiters: []
  };
  pendingBibleOverlay = candidate;
  publishShowState('bible-preparing');
  const transactionWaiters = [];
  let revealStarted = false;

  try {
    const readyWaiters = [];
    for (const { win, output } of targetEntries) {
      const waiter = createBibleOverlayWaiter(win, output, sessionId, overlayId);
      readyWaiters.push(waiter);
      transactionWaiters.push(waiter);
    }
    candidate.waiters = readyWaiters;
    const readiness = Promise.all(readyWaiters.map(waiter => waiter.promise));
    for (const { win } of targetEntries) {
      if (win.isDestroyed()) throw new Error('An output closed before the Bible passage could be prepared');
      win.webContents.send('bible:prepare', { overlayId, passage: lookupResult.passage });
    }
    await readiness;
    candidate.waiters = [];
    if (pendingBibleOverlay !== candidate
      || operationEpoch !== bibleOperationEpoch
      || sessionId !== outputSessionId
      || !outputsShouldBeVisible) {
      throw new Error('The output session changed while preparing the Bible passage');
    }
    const revealAt = Date.now() + 120;
    const nextTargets = new Set(targetOutputIds);
    const previousOnlyEntries = previousOverlay
      ? previousOverlay.targetOutputIds
        .filter(outputId => !nextTargets.has(outputId))
        .map(outputId => {
          const entry = outputWindows.get(outputId);
          if (!entry?.win
            || entry.win.isDestroyed()
            || !isCurrentOutputWindow(entry.win, sessionId, outputId)) {
            throw new Error('A previous Bible output is no longer available');
          }
          return entry;
        })
      : [];
    const revealWaiters = targetEntries.map(({ win, output }) =>
      createBibleOverlayRevealWaiter(win, output, sessionId, overlayId)
    );
    const hideWaiters = previousOnlyEntries.map(({ win, output }) =>
      createBibleOverlayHideWaiter(win, output, sessionId, previousOverlay.id)
    );
    const transitionWaiters = [...revealWaiters, ...hideWaiters];
    transactionWaiters.push(...transitionWaiters);
    candidate.waiters = transitionWaiters;
    const transitioned = Promise.all(transitionWaiters.map(waiter => waiter.promise));
    revealStarted = true;
    for (const { win } of targetEntries) {
      if (win.isDestroyed()) throw new Error('An output closed before the Bible passage could be revealed');
      win.webContents.send('bible:reveal', { overlayId, revealAt });
    }
    for (const { win } of previousOnlyEntries) {
      if (win.isDestroyed()) throw new Error('A previous Bible output closed before its passage could be hidden');
      win.webContents.send('bible:hide', {
        overlayId: previousOverlay.id,
        revealAt
      });
    }
    await transitioned;
    candidate.waiters = [];
    if (pendingBibleOverlay !== candidate
      || operationEpoch !== bibleOperationEpoch
      || sessionId !== outputSessionId
      || !outputsShouldBeVisible) {
      throw new Error('The Bible send was cancelled before it became live');
    }
    activeBibleOverlay = candidate;
    pendingBibleOverlay = null;
    // The overlay is visible content even when it was launched from a cleared
    // output. Preserve the underlying return state on the overlay itself while
    // keeping the main-process live state aligned with the pixels now shown.
    appState.isCleared = false;
    outputLifecyclePhase = 'live';
  } catch (error) {
    const revealFailedWhileCurrent = revealStarted
      && pendingBibleOverlay === candidate
      && operationEpoch === bibleOperationEpoch
      && sessionId === outputSessionId
      && outputsShouldBeVisible;
    for (const waiter of transactionWaiters) waiter.cancel(error);
    await Promise.allSettled(transactionWaiters.map(waiter => waiter.promise));
    if (revealFailedWhileCurrent) {
      // A passage may already be visible on only some outputs. Blacking every
      // output is safer than leaving the room in an unknowable mixed state.
      clearAllDisplays();
    } else {
      for (const { win } of targetEntries) {
        if (!win.isDestroyed()) win.webContents.send('bible:hide', { overlayId });
      }
      if (pendingBibleOverlay === candidate) pendingBibleOverlay = null;
      notifyBibleStateChanged();
    }
    throw error;
  }

  notifyBibleStateChanged();
  captureOutputPreviews();
  return {
    success: true,
    passage: lookupResult.passage,
    targetOutputIds
  };
});

ipcMain.handle('bible:hide', async (event) => {
  requireControlSender(event);
  const restored = hideBibleOverlay({ restore: true });
  return { success: true, restored };
});

function requirePrepareRequest(value, maximumBytes = 256 * 1024) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    failMainOperation('INVALID_PREPARE_REQUEST', 'That Prepare request is invalid.');
  }
  let serialized;
  try {
    serialized = JSON.stringify(value);
  } catch (_error) {
    failMainOperation('INVALID_PREPARE_REQUEST', 'That Prepare request could not be read.');
  }
  if (Buffer.byteLength(serialized, 'utf8') > maximumBytes) {
    failMainOperation('PREPARE_REQUEST_TOO_LARGE', 'That Prepare change is too large to process safely.');
  }
  return value;
}

function prepareText(value, label, maximum, { required = false } = {}) {
  if (value === undefined || value === null) value = '';
  if (typeof value !== 'string') failMainOperation('INVALID_PREPARE_TEXT', `${label} must be text.`);
  const normalized = value.trim();
  if (required && !normalized) failMainOperation('MISSING_PREPARE_TEXT', `${label} is required.`);
  if (normalized.length > maximum) {
    failMainOperation('PREPARE_TEXT_TOO_LONG', `${label} must be ${maximum} characters or fewer.`);
  }
  return normalized;
}

function prepareSpanSplitsSurrogatePair(value, offset) {
  if (offset <= 0 || offset >= value.length) return false;
  const previous = value.charCodeAt(offset - 1);
  const current = value.charCodeAt(offset);
  return previous >= 0xD800
    && previous <= 0xDBFF
    && current >= 0xDC00
    && current <= 0xDFFF;
}

function prepareSpansByChannel(value, project, item, textByChannel) {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (!Array.isArray(value) || value.length !== project.channelIds.length) {
    failMainOperation(
      'INVALID_CHANNEL_EMPHASIS',
      'Include emphasis for every configured output when changing emphasized phrases.'
    );
  }

  const desired = Object.create(null);
  const seenChannelIds = new Set();
  for (const entry of value) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      failMainOperation('INVALID_CHANNEL_EMPHASIS', 'One output emphasis entry is invalid.');
    }
    const channelId = prepareId(entry.channelId, 'Emphasis output');
    if (!project.channels[channelId] || seenChannelIds.has(channelId)) {
      failMainOperation(
        'INVALID_CHANNEL_EMPHASIS',
        'Each configured emphasis output must appear exactly once.'
      );
    }
    seenChannelIds.add(channelId);
    if (!Array.isArray(entry.spans) || entry.spans.length > PREPARE_MAX_EMPHASIS_SPANS) {
      failMainOperation(
        'INVALID_CHANNEL_EMPHASIS',
        `Each output can have at most ${PREPARE_MAX_EMPHASIS_SPANS} emphasized phrases.`
      );
    }

    const body = textByChannel[channelId] || '';
    const bodyUnchanged = body === (item.textByChannel?.[channelId] || '');
    const existingByRange = new Map(
      bodyUnchanged
        ? (item.spansByChannel?.[channelId] || []).map(span => [
            `${span.start}:${span.end}`,
            span
          ])
        : []
    );
    const spans = [];
    let previousEnd = 0;
    for (const candidate of entry.spans) {
      if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
        failMainOperation('INVALID_CHANNEL_EMPHASIS', 'One emphasized phrase is invalid.');
      }
      const unexpected = Object.keys(candidate)
        .filter(key => !['start', 'end', 'gold'].includes(key));
      if (unexpected.length > 0
        || !Number.isSafeInteger(candidate.start)
        || !Number.isSafeInteger(candidate.end)
        || candidate.start < previousEnd
        || candidate.end <= candidate.start
        || candidate.end > body.length
        || typeof candidate.gold !== 'boolean'
        || prepareSpanSplitsSurrogatePair(body, candidate.start)
        || prepareSpanSplitsSurrogatePair(body, candidate.end)) {
        failMainOperation(
          'INVALID_CHANNEL_EMPHASIS',
          'One emphasized phrase no longer lines up with its projected body.'
        );
      }

      if (candidate.gold) {
        spans.push({
          start: candidate.start,
          end: candidate.end,
          foreground: PREPARE_GOLD_EMPHASIS_FOREGROUND
        });
      } else {
        const existing = existingByRange.get(`${candidate.start}:${candidate.end}`);
        if (!existing) {
          failMainOperation(
            'INVALID_CHANNEL_EMPHASIS',
            'Existing emphasis changed with its body. Reopen the item and select the phrase again.'
          );
        }
        spans.push({ ...existing });
      }
      previousEnd = candidate.end;
    }
    if (spans.length > 0) desired[channelId] = spans;
  }
  if (seenChannelIds.size !== project.channelIds.length) {
    failMainOperation(
      'INVALID_CHANNEL_EMPHASIS',
      'Include every configured emphasis output exactly once.'
    );
  }
  return Object.keys(desired).length > 0 ? desired : null;
}

function prepareDocumentSource(value, label = 'Song document') {
  if (typeof value !== 'string') {
    failMainOperation('INVALID_PREPARE_TEXT', `${label} must be UTF-8 text.`);
  }
  const size = Buffer.byteLength(value, 'utf8');
  if (size < 1) failMainOperation('MISSING_PREPARE_TEXT', `${label} is required.`);
  if (size > MAX_SOURCE_BYTES) {
    failMainOperation(
      'PREPARE_TEXT_TOO_LONG',
      `${label} must be ${MAX_SOURCE_BYTES} bytes or fewer.`
    );
  }
  return value;
}

async function retrySongWrite(operation) {
  for (const delayMs of [0, 60, 150]) {
    if (delayMs > 0) await new Promise(resolve => setTimeout(resolve, delayMs));
    try {
      return await operation();
    } catch (error) {
      if (error?.code !== 'WRITE_LOCKED') throw error;
    }
  }
  failMainOperation(
    'WRITE_LOCKED',
    'Another song save is still finishing. Wait a moment, then try again.'
  );
}

async function writePortableExport(filePath, buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 22 || buffer.length > MAX_BUNDLE_BYTES) {
    failMainOperation('INVALID_SERVICE_BUNDLE', 'The portable service output is invalid.');
  }
  const requestedPath = path.resolve(filePath);
  const directoryPath = await fs.promises.realpath(path.dirname(requestedPath));
  const targetPath = path.join(directoryPath, path.basename(requestedPath));
  let previous = null;
  try {
    previous = await fs.promises.lstat(targetPath);
    if (!previous.isFile() || previous.isSymbolicLink()) {
      failMainOperation('UNSAFE_EXPORT_TARGET', 'Choose a regular file location for the portable service.');
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }

  const temporaryPath = path.join(
    directoryPath,
    `.${path.basename(targetPath)}.${process.pid}-${crypto.randomUUID()}.tmp`
  );
  let handle;
  let published = false;
  try {
    handle = await fs.promises.open(temporaryPath, 'wx', 0o600);
    await handle.writeFile(buffer);
    await handle.sync();
    await handle.close();
    handle = null;

    let current = null;
    try {
      current = await fs.promises.lstat(targetPath);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    if ((previous && (!current
      || current.isSymbolicLink()
      || !current.isFile()
      || !statIdentityMatches(previous, current)))
      || (!previous && current)) {
      failMainOperation(
        'EXPORT_TARGET_CHANGED',
        'The selected export file changed while SyncShow was preparing it. Choose the location again.'
      );
    }

    await fs.promises.rename(temporaryPath, targetPath);
    published = true;
    await fsyncDirectory(directoryPath).catch(error => {
      if (process.platform !== 'win32') throw error;
    });
    return targetPath;
  } finally {
    await handle?.close().catch(() => {});
    if (!published) await fs.promises.unlink(temporaryPath).catch(() => {});
  }
}

function prepareId(value, label) {
  const normalized = prepareText(value, label, 128, { required: true });
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(normalized)
    || ['__proto__', 'prototype', 'constructor'].includes(normalized)) {
    failMainOperation('INVALID_PREPARE_ID', `${label} is invalid.`);
  }
  return normalized;
}

function prepareRevision(value, label) {
  const normalized = prepareText(value, label, 64, { required: true });
  if (!/^[a-f0-9]{64}$/.test(normalized)) failMainOperation('INVALID_PREPARE_REVISION', `${label} is invalid.`);
  return normalized;
}

async function readExpectedProject(request) {
  const services = getPrepareServices();
  const projectId = prepareId(request.projectId, 'Service project');
  const expectedRevisionId = prepareRevision(request.expectedRevisionId, 'Expected service revision');
  const current = await services.serviceProjectStore.read(projectId);
  if (current.revisionId !== expectedRevisionId) {
    failMainOperation(
      'PROJECT_CONFLICT',
      'This service changed since it was opened. Reload it before making another change.',
      { currentRevisionId: current.revisionId, expectedRevisionId }
    );
  }
  return { ...current, services, projectId, expectedRevisionId };
}

function projectResult(result) {
  return {
    project: result.project,
    revisionId: result.revisionId,
    unchanged: result.unchanged === true,
    recovery: result.recovery || null
  };
}

function projectItemId(prefix) {
  return `${prefix}-${crypto.randomUUID()}`;
}

function nativeProjectChannels(profile = activeVenueProfile) {
  const channels = (profile?.inputRoles || [])
    .filter(role => role.enabled && role.kind === 'deck')
    .map(role => ({
      id: role.id,
      label: role.label,
      language: 'und'
    }));
  return channels.length > 0 ? channels : undefined;
}

function nativeProjectRoleMapping(project) {
  const roles = (activeVenueProfile?.inputRoles || [])
    .filter(role => role.enabled && role.kind === 'deck');
  if (roles.length < 1) failMainOperation('NO_SERVICE_INPUTS', 'This venue has no enabled presentation inputs.');
  const channelIds = project.channelIds;
  const findChannel = patterns => channelIds.find(channelId => {
    const channel = project.channels[channelId];
    const searchable = `${channelId} ${channel?.label || ''} ${channel?.language || ''}`.toLowerCase();
    return patterns.some(pattern => pattern.test(searchable));
  });
  const primary = channelIds.includes('primary') ? 'primary' : channelIds[0];
  const secondary = channelIds.includes('secondary') ? 'secondary' : channelIds[1] || primary;
  const media = channelIds.includes('media')
    ? 'media'
    : findChannel([/singer/, /stage/, /media/]) || primary;
  const mapping = {};
  for (const [index, role] of roles.entries()) {
    const searchable = `${role.id} ${role.label}`.toLowerCase();
    let channelId = channelIds.includes(role.id) ? role.id : null;
    if (!channelId && /(media|singer|stage)/.test(searchable)) channelId = media;
    if (!channelId && /(english|eng\b)/.test(searchable)) channelId = secondary;
    if (!channelId && /(russian|rus\b)/.test(searchable)) channelId = primary;
    mapping[role.id] = channelId || channelIds[index] || primary;
  }
  return mapping;
}

function projectSongItem(project, itemId) {
  const item = project.items[itemId];
  if (!item || item.kind !== 'song') {
    failMainOperation('INVALID_SONG_ITEM', 'Choose a song in this service before editing its song details.');
  }
  return item;
}

function requestedArrangement(project, item, rawArrangement) {
  if (!Array.isArray(rawArrangement) || rawArrangement.length < 1 || rawArrangement.length > 200) {
    failMainOperation('INVALID_ARRANGEMENT', 'A song arrangement needs 1 to 200 sections.');
  }
  const existingById = new Map(item.arrangement.map(entry => [entry.id, entry]));
  const usedIds = new Set();
  return rawArrangement.map((rawEntry, index) => {
    if (!rawEntry || typeof rawEntry !== 'object' || Array.isArray(rawEntry)) {
      failMainOperation('INVALID_ARRANGEMENT', `Arrangement entry ${index + 1} is invalid.`);
    }
    const sectionId = prepareId(rawEntry.sectionId, `Arrangement section ${index + 1}`);
    let entryId;
    if (rawEntry.id !== undefined && rawEntry.id !== null && rawEntry.id !== '') {
      entryId = prepareId(rawEntry.id, `Arrangement entry ${index + 1}`);
      const existing = existingById.get(entryId);
      if (!existing || existing.sectionId !== sectionId) {
        failMainOperation(
          'INVALID_ARRANGEMENT_ENTRY',
          'Existing arrangement entries may be reordered or removed, but their identity cannot be reassigned.'
        );
      }
    } else {
      entryId = projectItemId('arr');
    }
    if (usedIds.has(entryId)) {
      failMainOperation('DUPLICATE_ARRANGEMENT_ENTRY', 'Each arrangement entry may appear only once.');
    }
    usedIds.add(entryId);
    return { id: entryId, sectionId };
  });
}

ipcMain.handle('prepare:projects:list', async (event, request = {}) => {
  requireControlSender(event);
  requirePrepareRequest(request, 16 * 1024);
  return getPrepareServices().serviceProjectStore.list({
    query: prepareText(request.query, 'Project search', 120),
    pageSize: Number.isSafeInteger(request.pageSize) ? request.pageSize : 50,
    offset: Number.isSafeInteger(request.offset) ? request.offset : 0
  });
});

ipcMain.handle('prepare:projects:create', async (event, request = {}) => {
  requireControlSender(event);
  requirePrepareRequest(request, 16 * 1024);
  const serviceDate = request.serviceDate
    ? prepareText(request.serviceDate, 'Service date', 10, { required: true })
    : serviceDateForTimeZone(new Date(), activeVenueProfile?.timeZone || null);
  const created = await getPrepareServices().serviceProjectStore.create({
    id: projectItemId('service'),
    title: prepareText(request.title || 'Sunday Service', 'Service title', 200, { required: true }),
    serviceDate,
    profileId: activeVenueProfile?.id || 'default',
    channels: nativeProjectChannels()
  });
  return projectResult(created);
});

ipcMain.handle('prepare:projects:open', async (event, request = {}) => {
  requireControlSender(event);
  requirePrepareRequest(request, 16 * 1024);
  const projectId = prepareId(request.projectId, 'Service project');
  const revisionId = request.revisionId
    ? prepareRevision(request.revisionId, 'Service revision')
    : 'current';
  return projectResult(await getPrepareServices().serviceProjectStore.read(projectId, { revisionId }));
});

ipcMain.handle('prepare:projects:history', async (event, request = {}) => {
  requireControlSender(event);
  requirePrepareRequest(request, 16 * 1024);
  const projectId = prepareId(request.projectId, 'Service project');
  const limit = Number.isSafeInteger(request.limit) ? request.limit : 100;
  return getPrepareServices().serviceProjectStore.listRevisions(projectId, { limit });
});

ipcMain.handle('prepare:projects:restoreRevision', async (event, request = {}) => {
  requireControlSender(event);
  requirePrepareRequest(request, 16 * 1024);
  const restored = await getPrepareServices().serviceProjectStore.restoreRevision(
    prepareId(request.projectId, 'Service project'),
    {
      expectedRevisionId: prepareRevision(request.expectedRevisionId, 'Expected service revision'),
      targetRevisionId: prepareRevision(request.targetRevisionId, 'Saved service revision'),
      reason: 'prepare-history-restore'
    }
  );
  return projectResult(restored);
});

ipcMain.handle('prepare:projects:export', async (event, request = {}) => {
  requireControlSender(event);
  requirePrepareRequest(request, 16 * 1024);
  const projectId = prepareId(request.projectId, 'Service project');
  const revisionId = prepareRevision(request.revisionId, 'Service revision');
  const exported = await getPrepareServices().serviceProjectExchange.exportBundle(projectId, revisionId);
  const selected = await dialog.showSaveDialog(controlWindow, {
    title: 'Export Portable SyncShow Service',
    defaultPath: exported.fileName,
    filters: [{ name: 'SyncShow service', extensions: ['syncshow-service'] }]
  });
  if (selected.canceled || !selected.filePath) return null;
  const targetPath = selected.filePath.toLowerCase().endsWith('.syncshow-service')
    ? selected.filePath
    : `${selected.filePath}.syncshow-service`;
  const publishedPath = await writePortableExport(targetPath, exported.buffer);
  return {
    success: true,
    fileName: path.basename(publishedPath),
    projectId: exported.projectId,
    revisionId: exported.revisionId,
    assetCount: exported.assetCount
  };
});

ipcMain.handle('prepare:projects:import', async (event) => {
  requireControlSender(event);
  const selected = await dialog.showOpenDialog(controlWindow, {
    title: 'Import Portable SyncShow Service',
    filters: [{ name: 'SyncShow service', extensions: ['syncshow-service'] }],
    properties: ['openFile']
  });
  if (selected.canceled || selected.filePaths.length === 0) return null;
  const sourcePath = selected.filePaths[0];
  let read;
  try {
    read = await readFileNoFollow(sourcePath, MAX_BUNDLE_BYTES);
  } catch (error) {
    failMainOperation(
      'INVALID_SERVICE_BUNDLE',
      `That portable service could not be read safely: ${error.message}`
    );
  }
  if (read.buffer.length < 22) {
    failMainOperation('INVALID_SERVICE_BUNDLE', 'That portable service is empty or incomplete.');
  }
  const imported = await getPrepareServices().serviceProjectExchange.importBundle(read.buffer);
  return {
    ...projectResult(imported),
    imported: imported.imported === true,
    forked: imported.forked === true,
    songLibrary: imported.songLibrary,
    bundle: imported.bundle
  };
});

ipcMain.handle('prepare:presets:list', async event => {
  requireControlSender(event);
  const items = listNativePresets().map(preset => ({
    id: preset.id,
    label: preset.label,
    description: preset.description,
    selectable: preset.selectable,
    kinds: [...preset.kinds]
  }));
  return { items, total: items.length };
});

ipcMain.handle('prepare:projects:previewItem', async (event, request = {}) => {
  requireControlSender(event);
  requirePrepareRequest(request, 16 * 1024);
  const current = await readExpectedProject(request);
  const itemId = prepareId(request.itemId, 'Service item');
  if (!current.project.items[itemId]) {
    failMainOperation('UNKNOWN_PROJECT_ITEM', 'That service item no longer exists.');
  }
  const channelId = prepareId(request.channelId, 'Preview output');
  if (!current.project.channels[channelId]) {
    failMainOperation('UNKNOWN_PROJECT_CHANNEL', 'That output is not part of this service.');
  }
  const cueOffset = Number.isSafeInteger(request.cueOffset) ? request.cueOffset : 0;
  if (cueOffset < 0 || cueOffset > 20000) {
    failMainOperation('INVALID_PREVIEW_CUE', 'That preview position is invalid.');
  }
  const timeline = compileServiceProject(current.project, { allowEmpty: true });
  const cues = timeline.cueIds
    .map(cueId => timeline.cues[cueId])
    .filter(cue => cue.itemId === itemId);
  if (cues.length === 0) {
    return {
      cueCount: 0,
      cueOffset: 0,
      channelId,
      message: 'This item does not create a projected cue.'
    };
  }
  const boundedOffset = Math.min(cueOffset, cues.length - 1);
  const renderer = new NativeSlideRenderer({
    width: CONFIG.displayWidth,
    height: CONFIG.displayHeight,
    fontPath: getBundledPresentationFontPath(),
    resolveAsset: assetId => current.services.serviceProjectStore.resolveAssetPath(
      current.projectId,
      current.expectedRevisionId,
      assetId
    )
  });
  const item = current.project.items[itemId];
  const channelVariant = item.kind === 'song' ? item.variants?.[channelId] : null;
  const rendered = channelVariant?.mode === 'derive'
    ? await renderer.renderSingerPreview(
        cues[boundedOffset],
        channelVariant.from,
        cues[boundedOffset + 1] || null
      )
    : await renderer.renderCue(cues[boundedOffset], channelId);
  const previewBuffer = await require('sharp')(rendered.info.data)
    .resize(640, 360, { fit: 'fill' })
    .jpeg({ quality: 82, chromaSubsampling: '4:2:0' })
    .toBuffer();
  return {
    cueCount: cues.length,
    cueOffset: boundedOffset,
    channelId,
    dataUrl: `data:image/jpeg;base64,${previewBuffer.toString('base64')}`,
    metadata: rendered.metadata
  };
});

ipcMain.handle('community:status', async (event) => {
  requireControlSender(event);
  return communityIpcResult(() => communityStatusPayload());
});

ipcMain.handle('community:connectStart', async (event, request = {}) => {
  requireControlSender(event);
  return communityIpcResult(() => serializeCommunityOperation(async () => {
    communityRequest(request);
    const serverUrl = communityText(
      request.serverUrl,
      'Community server address',
      2048,
      { required: true }
    );
    const email = communityText(
      request.email,
      'Community administrator email',
      320,
      { required: true }
    );
    const existing = await currentCommunityConnectionSummary();
    if (existing
      && !communityConnectionExpired(existing)
      && !communityReconnectRequired) {
      failMainOperation(
        'COMMUNITY_ALREADY_CONNECTED',
        'Disconnect the current Community server before connecting another one.'
      );
    }
    if (pendingCommunityAuthorizations.size > 0) {
      failMainOperation(
        'COMMUNITY_AUTHORIZATION_PENDING',
        'Finish or cancel the current Community approval request first.'
      );
    }

    const { connectionStore } = await getCommunityServices();
    await connectionStore.assertSecureStorageAvailable();
    const client = new CommunityClient({ baseUrl: serverUrl });
    const operationEpoch = communityOperationEpoch;
    const controller = beginCommunityAuthRequest();
    let discovery;
    let authorization;
    try {
      discovery = await client.discover({ signal: controller.signal });
      const requiredScopes = ['syncshow:songs:read', 'syncshow:songs:write'];
      if (requiredScopes.some(scope => !discovery.scopes.includes(scope))) {
        failMainOperation(
          'COMMUNITY_WRITE_UNAVAILABLE',
          'This Community server has not enabled song-library editing for SyncShow.'
        );
      }
      authorization = await client.startDeviceAuthorization({
        email,
        deviceName: `SyncShow on ${os.hostname()}`.slice(0, 120),
        scopes: requiredScopes,
        signal: controller.signal
      });
    } finally {
      finishCommunityAuthRequest(controller);
    }
    if (operationEpoch !== communityOperationEpoch) {
      await client.cancelDeviceAuthorization(authorization.authorizationId).catch(() => {});
      failMainOperation(
        'COMMUNITY_AUTHORIZATION_CANCELLED',
        'Community approval was cancelled before it could be saved.'
      );
    }
    pendingCommunityAuthorizations.set(authorization.authorizationId, {
      client,
      discovery,
      email,
      authorizationId: authorization.authorizationId,
      verificationUri: authorization.verificationUri,
      userCode: authorization.userCode,
      expiresAt: authorization.expiresAt,
      pollIntervalMs: authorization.pollIntervalMs,
      replaceConnectionId: existing?.id || null
    });
    await notifyCommunityStatusChanged();
    return {
      connected: false,
      pending: true,
      status: 'pending',
      authorizationId: authorization.authorizationId,
      serverUrl: discovery.baseUrl,
      adminEmail: email,
      verificationUri: authorization.verificationUri,
      userCode: authorization.userCode,
      expiresAt: authorization.expiresAt,
      pollIntervalMs: authorization.pollIntervalMs,
      message: 'Approval email sent. Approve this computer from the Community admin account.'
    };
  }));
});

ipcMain.handle('community:connectPoll', async (event, request = {}) => {
  requireControlSender(event);
  return communityIpcResult(() => serializeCommunityOperation(async () => {
    communityRequest(request);
    const authorizationId = communityAuthorizationId(request.authorizationId);
    const pending = pendingCommunityAuthorizations.get(authorizationId);
    if (!pending) {
      failMainOperation(
        'COMMUNITY_AUTHORIZATION_NOT_FOUND',
        'That Community approval request is no longer active.'
      );
    }
    const operationEpoch = communityOperationEpoch;
    const controller = beginCommunityAuthRequest();
    let result;
    try {
      try {
        result = await pending.client.pollDeviceAuthorization(authorizationId, {
          signal: controller.signal
        });
      } catch (error) {
        if (terminalCommunityAuthorizationError(error)) {
          pendingCommunityAuthorizations.delete(authorizationId);
          await notifyCommunityStatusChanged();
        }
        throw error;
      }
    } finally {
      finishCommunityAuthRequest(controller);
    }
    if (operationEpoch !== communityOperationEpoch) {
      pendingCommunityAuthorizations.delete(authorizationId);
      if (result.status === 'authorized') {
        await pending.client.revokeAccessToken({
          accessToken: result.grant.accessToken
        }).catch(() => {});
      } else {
        await pending.client.cancelDeviceAuthorization(authorizationId).catch(() => {});
      }
      failMainOperation(
        'COMMUNITY_AUTHORIZATION_CANCELLED',
        'Community approval was cancelled before it could be saved.'
      );
    }
    if (result.status !== 'authorized') {
      return {
        connected: false,
        pending: true,
        status: 'pending',
        authorizationId,
        serverUrl: pending.discovery.baseUrl,
        adminEmail: pending.email,
        verificationUri: pending.verificationUri,
        userCode: pending.userCode,
        expiresAt: pending.expiresAt,
        retryAfterMs: result.retryAfterMs
      };
    }

    pendingCommunityAuthorizations.delete(authorizationId);
    const grant = result.grant;
    const requiredScopes = ['syncshow:songs:read', 'syncshow:songs:write'];
    if (requiredScopes.some(scope => !grant.scopes.includes(scope))) {
      await pending.client.revokeAccessToken({
        accessToken: grant.accessToken
      }).catch(() => {});
      failMainOperation(
        'COMMUNITY_WRITE_UNAVAILABLE',
        'The approved Community account did not grant song-library editing.'
      );
    }

    const { connectionStore, stateStore } = await getCommunityServices();
    let connectionId = pending.replaceConnectionId;
    const previousConnection = connectionId
      ? await connectionStore.getConnection(connectionId)
      : null;
    if (connectionId && !previousConnection) connectionId = null;
    const sameServer = Boolean(
      previousConnection
      && previousConnection.serverId === pending.discovery.serverId
      && new URL(previousConnection.baseUrl).origin
        === new URL(pending.discovery.baseUrl).origin
    );
    const changingServers = Boolean(previousConnection && !sameServer);
    if (changingServers) {
      await connectionStore.disconnect(connectionId);
      connectionId = null;
    }
    try {
      await connectionStore.saveConnection({
        ...(connectionId ? { id: connectionId } : {}),
        serverId: pending.discovery.serverId,
        serverName: pending.discovery.serverName,
        baseUrl: pending.discovery.baseUrl,
        apiBaseUrl: pending.discovery.apiBaseUrl,
        account: grant.account,
        scopes: grant.scopes,
        accessToken: grant.accessToken,
        refreshToken: grant.refreshToken,
        expiresAt: grant.expiresAt
      });
    } catch (error) {
      if (changingServers && previousConnection) {
        await connectionStore.saveConnection(previousConnection).catch(restoreError => {
          console.error(
            '[Community] Previous connection could not be restored after a failed replacement:',
            restoreError.message
          );
        });
      }
      await pending.client.revokeAccessToken({
        accessToken: grant.accessToken
      }).catch(() => {});
      throw error;
    }
    if (changingServers && previousConnection) {
      await stateStore.removeConnectionState(previousConnection.id);
    }
    communityConnectionWarning = null;
    if (previousConnection
      && previousConnection.accessToken !== grant.accessToken) {
      try {
        const revoked = await communityClientForConnection(previousConnection)
          .revokeAccessToken({ accessToken: previousConnection.accessToken });
        if (revoked.revoked !== true) {
          communityConnectionWarning = 'The previous Community approval could not be revoked automatically. Revoke the older SyncShow connection from Community admin.';
        }
      } catch (error) {
        communityConnectionWarning = 'The previous Community approval could not be revoked automatically. Revoke the older SyncShow connection from Community admin.';
        console.warn('[Community] Previous approval revocation was not confirmed:', error.message);
      }
    }
    communityLastSyncSummary = null;
    communityReconnectRequired = null;
    await notifyCommunityStatusChanged();
    scheduleCommunitySongSync('new connection', 250);
    scheduleCommunityPeriodicSync({ resetBackoff: true });
    return communityStatusPayload();
  }));
});

ipcMain.handle('community:connectCancel', async (event, request = {}) => {
  requireControlSender(event);
  return communityIpcResult(() => serializeCommunityOperation(async () => {
    communityRequest(request);
    const authorizationId = communityAuthorizationId(request.authorizationId);
    const pending = pendingCommunityAuthorizations.get(authorizationId);
    if (!pending) return { cancelled: true, remoteCancelled: false };
    pendingCommunityAuthorizations.delete(authorizationId);
    const controller = beginCommunityAuthRequest();
    let result;
    try {
      result = await pending.client.cancelDeviceAuthorization(authorizationId, {
        signal: controller.signal
      });
    } finally {
      finishCommunityAuthRequest(controller);
    }
    await notifyCommunityStatusChanged();
    return result;
  }));
});

ipcMain.handle('community:connectOpenApproval', async (event, request = {}) => {
  requireControlSender(event);
  return communityIpcResult(() => serializeCommunityOperation(async () => {
    communityRequest(request);
    const authorizationId = communityAuthorizationId(request.authorizationId);
    const pending = pendingCommunityAuthorizations.get(authorizationId);
    if (!pending) {
      failMainOperation(
        'COMMUNITY_AUTHORIZATION_NOT_FOUND',
        'That Community approval request is no longer active.'
      );
    }
    await shell.openExternal(pending.verificationUri);
    return { opened: true };
  }));
});

ipcMain.handle('community:connectCopyCode', async (event, request = {}) => {
  requireControlSender(event);
  return communityIpcResult(() => serializeCommunityOperation(async () => {
    communityRequest(request);
    const authorizationId = communityAuthorizationId(request.authorizationId);
    const pending = pendingCommunityAuthorizations.get(authorizationId);
    if (!pending) {
      failMainOperation(
        'COMMUNITY_AUTHORIZATION_NOT_FOUND',
        'That Community approval request is no longer active.'
      );
    }
    clipboard.writeText(pending.userCode);
    return { copied: true };
  }));
});

ipcMain.handle('community:disconnect', async (event) => {
  requireControlSender(event);
  communityOperationEpoch += 1;
  communitySyncAbortController?.abort();
  communitySyncAbortController = null;
  communityAuthAbortController?.abort();
  communityAuthAbortController = null;
  clearCommunitySyncTimer();
  clearCommunityPeriodicSync({ resetBackoff: true });
  return communityIpcResult(() => serializeCommunityOperation(async () => {
    await cancelPendingCommunityAuthorizations();
    const summary = await currentCommunityConnectionSummary();
    if (!summary) {
      communityLastSyncSummary = null;
      communityReconnectRequired = null;
      await notifyCommunityStatusChanged();
      return {
        disconnected: true,
        remoteRevoked: false,
        warning: communityConnectionWarning
      };
    }
    const { connectionStore, stateStore } = await getCommunityServices();
    let remoteRevoked = false;
    try {
      const connection = await connectionStore.getConnection(summary.id);
      if (connection) {
        const result = await communityClientForConnection(connection).revokeAccessToken({
          accessToken: connection.accessToken
        });
        remoteRevoked = result.revoked === true;
      }
    } catch (error) {
      console.warn('[Community] Remote token revocation could not be confirmed:', error.message);
    }
    await connectionStore.disconnect(summary.id);
    await stateStore.removeConnectionState(summary.id);
    communityLastSyncSummary = null;
    communityReconnectRequired = null;
    communityConnectionWarning = remoteRevoked
      ? null
      : 'This computer disconnected locally, but remote revocation could not be confirmed. Revoke the old SyncShow connection from Community admin.';
    await notifyCommunityStatusChanged();
    return {
      disconnected: true,
      remoteRevoked,
      warning: communityConnectionWarning
    };
  }));
});

ipcMain.handle('community:songs:sync', async (event) => {
  requireControlSender(event);
  return communityIpcResult(() => serializeCommunityOperation(async () => {
    const summary = await runCommunitySongSync();
    return { ...summary, lastSync: summary };
  }));
});

ipcMain.handle('community:songs:getState', async (event, request = {}) => {
  requireControlSender(event);
  return communityIpcResult(async () => {
    communityRequest(request);
    const songId = prepareId(request.songId, 'Song');
    return { songState: await communitySongStatePayload(songId) };
  });
});

ipcMain.handle('community:songs:getConflict', async (event, request = {}) => {
  requireControlSender(event);
  return communityIpcResult(async () => {
    communityRequest(request);
    const songId = prepareId(request.songId, 'Song');
    return { conflict: await communitySongConflictPayload(songId) };
  });
});

ipcMain.handle('community:songs:resolveConflict', async (event, request = {}) => {
  requireControlSender(event);
  return communityIpcResult(() => serializeCommunityOperation(async () => {
    communityRequest(request);
    const songId = prepareId(request.songId, 'Song');
    const strategy = communityText(
      request.strategy,
      'Community conflict choice',
      32,
      { required: true }
    );
    if (!['keep-local', 'keep-remote'].includes(strategy)) {
      failMainOperation(
        'INVALID_COMMUNITY_RESOLUTION',
        'Choose either this Mac’s copy or the Community copy.'
      );
    }
    if (!Number.isSafeInteger(request.expectedSyncVersion)
      || request.expectedSyncVersion < 1
      || typeof request.expectedLocalRevision !== 'string'
      || !/^[a-f0-9]{64}$/.test(request.expectedLocalRevision)) {
      failMainOperation(
        'COMMUNITY_RESOLUTION_STALE',
        'Reload this conflict before choosing a copy.'
      );
    }
    const conflict = await communitySongConflictPayload(songId);
    const connection = await currentCommunityConnectionSummary();
    if (!connection?.canWriteSongs) {
      failMainOperation(
        'COMMUNITY_READ_ONLY',
        'This Community approval cannot resolve song conflicts.'
      );
    }
    if (communityReconnectRequired) {
      failMainOperation(
        'COMMUNITY_RECONNECT_REQUIRED',
        communityReconnectRequired.message
      );
    }

    communitySyncAbortController?.abort();
    const controller = new AbortController();
    communitySyncAbortController = controller;
    const epoch = ++communityOperationEpoch;
    let resolved;
    try {
      const sync = await communitySyncForConnection(connection);
      try {
        resolved = await sync.resolveConflict(conflict.syncId, {
          strategy,
          expectedSyncVersion: request.expectedSyncVersion,
          expectedLocalRevision: request.expectedLocalRevision,
          signal: controller.signal
        });
      } catch (error) {
        if (requireCommunityReconnectFor(error)) {
          await notifyCommunityStatusChanged();
        }
        throw error;
      }
      if (controller.signal.aborted || epoch !== communityOperationEpoch) {
        failMainOperation('COMMUNITY_SYNC_CANCELLED', 'Community conflict resolution was cancelled.');
      }
    } finally {
      if (communitySyncAbortController === controller) {
        communitySyncAbortController = null;
      }
    }
    const { stateStore } = await getCommunityServices();
    const state = await stateStore.getConnectionState(connection.id);
    const songState = Object.hasOwn(state.songs, resolved.syncId)
      ? state.songs[resolved.syncId]
      : null;
    const resolvedSuccessfully = resolved.resolved === true;
    communityLastSyncSummary = resolvedSuccessfully
      ? {
          status: 'synced',
          resolved: 1,
          resolution: strategy,
          completedAt: new Date().toISOString()
        }
      : {
          status: 'needs-review',
          resolved: 0,
          conflicts: 1,
          warnings: 1,
          warningCode: resolved.warningCode || 'CONFLICT_RETAINED',
          completedAt: new Date().toISOString()
        };
    await notifyCommunityStatusChanged();
    if (resolvedSuccessfully) {
      scheduleCommunitySongSync('conflict resolved', 1000);
    }
    return {
      resolved,
      warning: resolvedSuccessfully
        ? null
        : 'A local translation is not present in Community, so it was preserved and the conflict remains. Keep this Mac’s copy to publish the complete local family, or remove/detach the extra translation before keeping Community.',
      songState: publicCommunitySongState(songState, connection, {
        familyId: songState?.localFamilyId || conflict.familyId,
        exists: true
      }),
      lastSync: communityLastSyncSummary
    };
  }));
});

ipcMain.handle('community:songs:setVisibility', async (event, request = {}) => {
  requireControlSender(event);
  return communityIpcResult(() => serializeCommunityOperation(async () => {
    communityRequest(request);
    const songId = prepareId(request.songId, 'Song');
    const visibility = communityText(
      request.visibility,
      'Community song visibility',
      32,
      { required: true }
    );
    if (!['private', 'public', 'scheduled-public'].includes(visibility)) {
      failMainOperation('INVALID_COMMUNITY_VISIBILITY', 'Choose a valid Community visibility.');
    }
    let publishAt = null;
    if (visibility === 'scheduled-public') {
      publishAt = communityText(
        request.publishAt,
        'Scheduled publication time',
        40,
        { required: true }
      );
      if (!Number.isFinite(Date.parse(publishAt))) {
        failMainOperation(
          'INVALID_COMMUNITY_VISIBILITY',
          'Choose a valid Community publication date and time.'
        );
      }
      publishAt = new Date(publishAt).toISOString();
    } else if (request.publishAt !== null
      && request.publishAt !== undefined
      && request.publishAt !== '') {
      failMainOperation(
        'INVALID_COMMUNITY_VISIBILITY',
        'Only scheduled songs may have a publication time.'
      );
    }
    const expectedSyncVersion = request.expectedSyncVersion;
    if (expectedSyncVersion !== null
      && expectedSyncVersion !== undefined
      && (!Number.isSafeInteger(expectedSyncVersion) || expectedSyncVersion < 1)) {
      failMainOperation(
        'INVALID_COMMUNITY_VERSION',
        'Reload this song before changing its Community visibility.'
      );
    }

    const summary = await runCommunitySongSync({
      syncId: songId,
      visibility,
      publishAt,
      expectedSyncVersion: expectedSyncVersion ?? null
    });
    const songState = await communitySongStatePayload(songId);
    if (songState.conflict) {
      failMainOperation(
        'SONG_SYNC_CONFLICT',
        'The local and Community copies both changed; neither copy was overwritten.'
      );
    }
    if (summary.status === 'offline') {
      failMainOperation(
        'COMMUNITY_OFFLINE',
        'The song was saved locally and its Community visibility is queued until the server is available.'
      );
    }
    return { songState, lastSync: summary };
  }));
});

ipcMain.handle('prepare:songs:list', async (event, request = {}) => {
  requireControlSender(event);
  requirePrepareRequest(request, 16 * 1024);
  const listing = await getPrepareServices().localSongLibrary.list({
    query: prepareText(request.query, 'Song search', 120),
    pageSize: Number.isSafeInteger(request.pageSize) ? request.pageSize : 50,
    offset: Number.isSafeInteger(request.offset) ? request.offset : 0
  });
  return augmentSongLibraryWithCommunity(listing);
});

ipcMain.handle('prepare:songs:read', async (event, request = {}) => {
  requireControlSender(event);
  requirePrepareRequest(request, 16 * 1024);
  const songId = prepareId(request.songId, 'Song');
  const revision = request.revisionId
    ? prepareRevision(request.revisionId, 'Song revision')
    : null;
  return getPrepareServices().localSongLibrary.read(songId, {
    ...(revision ? { revision } : {})
  });
});

ipcMain.handle('prepare:songs:validate', async (event, request = {}) => {
  requireControlSender(event);
  requirePrepareRequest(request, MAX_SOURCE_BYTES + 64 * 1024);
  const documentSource = prepareDocumentSource(request.documentSource);
  const editingSongId = request.editingSongId
    ? prepareId(request.editingSongId, 'Song being edited')
    : null;
  return getPrepareServices().localSongLibrary.validateSource(documentSource, {
    fileName: editingSongId ? `${editingSongId}.md` : 'new-song.md',
    ...(editingSongId ? { expectedSongId: editingSongId } : {})
  });
});

ipcMain.handle('prepare:songs:save', async (event, request = {}) => {
  requireControlSender(event);
  requirePrepareRequest(request, MAX_SOURCE_BYTES + 64 * 1024);
  const documentSource = prepareDocumentSource(request.documentSource);
  const songId = request.songId ? prepareId(request.songId, 'Song being edited') : null;
  let expectedRevision = null;
  if (songId) {
    expectedRevision = prepareRevision(request.expectedRevisionId, 'Expected song revision');
  } else if (request.expectedRevisionId) {
    failMainOperation('INVALID_SONG_REVISION', 'A new song cannot use an existing song revision.');
  }
  const library = getPrepareServices().localSongLibrary;
  const saved = await retrySongWrite(() => library.saveSource(documentSource, songId
    ? {
        fileName: `${songId}.md`,
        expectedSongId: songId,
        expectedRevision
      }
    : {
        fileName: 'new-song.md',
        expectedRevision: null
      }));
  scheduleCommunitySongSync('local song saved', 2000);
  return saved;
});

ipcMain.handle('prepare:songs:translationsForItem', async (event, request = {}) => {
  requireControlSender(event);
  requirePrepareRequest(request, 16 * 1024);
  const current = await readExpectedProject(request);
  const itemId = prepareId(request.itemId, 'Song item');
  const item = projectSongItem(current.project, itemId);
  const primary = resolveAuthoritativeSongSource(current.project, item.id).resource.document;
  const familyId = primary.translationOf || primary.id;
  const listed = await current.services.localSongLibrary.list({
    query: familyId,
    pageSize: 100,
    offset: 0
  });
  const items = [];
  for (const summary of listed.items) {
    if (summary.id === primary.id) continue;
    const candidate = await current.services.localSongLibrary.read(summary.id, {
      revision: prepareRevision(summary.revision, 'Song revision')
    });
    if (compareSongTranslations(primary, candidate.song).compatible) {
      items.push(candidate.summary);
    }
  }
  return {
    items,
    total: items.length,
    offset: 0,
    nextOffset: null
  };
});

ipcMain.handle('prepare:songs:import', async (event) => {
  requireControlSender(event);
  const result = await dialog.showOpenDialog(controlWindow, {
    title: `Import Song Lyrics — up to ${MAX_SONG_BATCH_IMPORT_FILES} files`,
    filters: [{ name: 'Song lyrics', extensions: ['md', 'markdown', 'txt'] }],
    properties: ['openFile', 'multiSelections']
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  const library = getPrepareServices().localSongLibrary;
  const imported = await importSongFilesSequentially(
    result.filePaths,
    sourcePath => retrySongWrite(() => library.importFile(sourcePath, {
      onConflict: 'fork'
    }))
  );
  scheduleCommunitySongSync('songs imported', 500);
  return imported;
});

ipcMain.handle('prepare:projects:addSong', async (event, request = {}) => {
  requireControlSender(event);
  requirePrepareRequest(request, 64 * 1024);
  const current = await readExpectedProject(request);
  const songId = prepareId(request.songId, 'Song');
  const songRevision = request.songRevisionId || request.songRevision;
  const songRead = await current.services.localSongLibrary.read(songId, {
    ...(songRevision ? { revision: prepareRevision(songRevision, 'Song revision') } : {})
  });
  const withResource = addSongResource(current.project, songRead.song, {
    provider: 'local',
    itemId: songRead.song.id,
    revision: songRead.revision
  });
  const sourceChannelId = withResource.project.channelIds.includes('primary')
    ? 'primary'
    : withResource.project.channelIds.find(channelId =>
        !/(media|singer|stage)/i.test(
          `${channelId} ${withResource.project.channels[channelId]?.label || ''}`
        ))
      || withResource.project.channelIds[0];
  const variants = {};
  for (const channelId of withResource.project.channelIds) {
    if (channelId === sourceChannelId) {
      variants[channelId] = { mode: 'content', resourceId: withResource.resourceId };
    } else if (/(media|singer|stage)/i.test(`${channelId} ${withResource.project.channels[channelId]?.label || ''}`)) {
      variants[channelId] = {
        mode: 'derive',
        from: sourceChannelId,
        transform: { id: 'first-lines', version: 1, maxLines: 2 }
      };
    } else {
      variants[channelId] = { mode: 'inherit', from: sourceChannelId };
    }
  }
  const arrangementSections = parseSongArrangement(request.arrangement, songRead.song);
  const next = addProjectItem(withResource.project, {
    id: projectItemId('song'),
    kind: 'song',
    title: songRead.song.title,
    primaryChannelId: sourceChannelId,
    variants,
    arrangement: arrangementSections.map(sectionId => ({
      id: projectItemId('arr'),
      sectionId
    })),
    titlePresetId: 'song-title',
    lyricsPresetId: 'song-lyrics',
    operatorNotes: ''
  }, {
    parentId: request.parentId ? prepareId(request.parentId, 'Parent item') : null
  });
  return projectResult(await current.services.serviceProjectStore.save(next, {
    expectedRevisionId: current.expectedRevisionId,
    reason: 'add-song'
  }));
});

ipcMain.handle('prepare:projects:addGroup', async (event, request = {}) => {
  requireControlSender(event);
  requirePrepareRequest(request, 16 * 1024);
  const current = await readExpectedProject(request);
  const allowedGroupKinds = new Set(['service', 'sermon', 'section', 'point', 'subpoint', 'custom']);
  const requestedKind = prepareText(request.groupKind || 'section', 'Section type', 24, { required: true });
  const groupKind = allowedGroupKinds.has(requestedKind) ? requestedKind : 'section';
  const title = prepareText(request.title || 'Service section', 'Section name', 200, { required: true });
  const next = addGroupItem(current.project, {
    id: projectItemId('group'),
    title,
    groupKind,
    operatorNotes: '',
    parentId: request.parentId ? prepareId(request.parentId, 'Parent item') : null
  });
  return projectResult(await current.services.serviceProjectStore.save(next, {
    expectedRevisionId: current.expectedRevisionId,
    reason: 'add-group'
  }));
});

ipcMain.handle('prepare:projects:updateItem', async (event, request = {}) => {
  requireControlSender(event);
  requirePrepareRequest(request, 256 * 1024);
  const current = await readExpectedProject(request);
  const itemId = prepareId(request.itemId, 'Service item');
  const item = current.project.items[itemId];
  if (!item || item.kind === 'imported-deck') {
    failMainOperation('UNEDITABLE_PROJECT_ITEM', 'That service item cannot be edited here.');
  }
  const title = prepareText(request.title, 'Item title', 200, { required: true });
  const operatorNotes = prepareText(request.operatorNotes, 'Operator notes', 4000);
  let next;
  if (item.kind === 'group') {
    const allowedGroupKinds = new Set(['service', 'sermon', 'section', 'point', 'subpoint', 'custom']);
    const groupKind = prepareText(request.groupKind || item.groupKind, 'Section type', 24, { required: true });
    if (!allowedGroupKinds.has(groupKind)) {
      failMainOperation('INVALID_GROUP_KIND', 'That section type is not supported.');
    }
    next = updateGroupItem(current.project, {
      itemId,
      title,
      groupKind,
      operatorNotes
    });
  } else if (item.kind === 'sermon' || item.kind === 'notice') {
    if (!Array.isArray(request.textByChannel)
      || request.textByChannel.length !== current.project.channelIds.length) {
      failMainOperation('INVALID_CHANNEL_TEXT', 'Include every configured output when editing projected text.');
    }
    const textByChannel = {};
    const textChannelIds = new Set();
    for (const entry of request.textByChannel) {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
        failMainOperation('INVALID_CHANNEL_TEXT', 'One output text entry is invalid.');
      }
      const channelId = prepareId(entry.channelId, 'Output');
      if (!current.project.channels[channelId] || textChannelIds.has(channelId)) {
        failMainOperation('INVALID_CHANNEL_TEXT', 'Each configured output must appear exactly once.');
      }
      textChannelIds.add(channelId);
      const projectedText = prepareText(entry.text, 'Projected text', 20000);
      if (projectedText) textByChannel[channelId] = projectedText;
    }
    if (textChannelIds.size !== current.project.channelIds.length) {
      failMainOperation('INVALID_CHANNEL_TEXT', 'Include every configured output exactly once.');
    }
    if (Object.keys(textByChannel).length < 1) {
      failMainOperation('INVALID_CHANNEL_TEXT', 'Add projected body text for at least one output.');
    }
    let titlesByChannel;
    if (request.titlesByChannel === null) {
      titlesByChannel = null;
    } else if (request.titlesByChannel !== undefined) {
      if (!Array.isArray(request.titlesByChannel)
        || request.titlesByChannel.length !== current.project.channelIds.length) {
        failMainOperation('INVALID_CHANNEL_TITLE', 'Include every configured output when editing projected titles.');
      }
      const projectedTitles = {};
      const titleChannelIds = new Set();
      for (const entry of request.titlesByChannel) {
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
          failMainOperation('INVALID_CHANNEL_TITLE', 'One output title entry is invalid.');
        }
        const channelId = prepareId(entry.channelId, 'Title output');
        if (!current.project.channels[channelId] || titleChannelIds.has(channelId)) {
          failMainOperation('INVALID_CHANNEL_TITLE', 'Each configured title output must appear exactly once.');
        }
        titleChannelIds.add(channelId);
        const projectedTitle = prepareText(entry.title, 'Projected title', 200);
        if (projectedTitle && !textByChannel[channelId]) {
          failMainOperation(
            'INVALID_CHANNEL_TITLE',
            'A projected title needs body text on the same output.'
          );
        }
        if (projectedTitle) projectedTitles[channelId] = projectedTitle;
      }
      if (titleChannelIds.size !== current.project.channelIds.length) {
        failMainOperation('INVALID_CHANNEL_TITLE', 'Include every configured title output exactly once.');
      }
      titlesByChannel = Object.keys(projectedTitles).length > 0 ? projectedTitles : null;
    }
    const spansByChannel = prepareSpansByChannel(
      request.spansByChannel,
      current.project,
      item,
      textByChannel
    );
    next = updateTextItem(current.project, {
      itemId,
      title,
      textByChannel,
      ...(titlesByChannel !== undefined ? { titlesByChannel } : {}),
      ...(spansByChannel !== undefined ? { spansByChannel } : {}),
      operatorNotes,
      ...(request.presetId ? {
        presetId: prepareId(request.presetId, 'Slide preset')
      } : {})
    });
  } else {
    const altText = item.kind === 'picture'
      ? prepareText(request.altText, 'Picture description', 500, { required: true })
      : undefined;
    const fit = request.fit === undefined
      ? undefined
      : prepareText(request.fit, 'Picture fit', 12, { required: true });
    if (fit !== undefined && !['fit', 'fill', 'stretch'].includes(fit)) {
      failMainOperation('INVALID_PICTURE_FIT', 'Picture fit must be Fit, Fill, or Stretch.');
    }
    next = updatePresentationItem(current.project, {
      itemId,
      title,
      operatorNotes,
      ...(request.presetId ? {
        presetId: prepareId(request.presetId, 'Slide preset')
      } : {}),
      ...(altText !== undefined ? { altText } : {}),
      ...(fit !== undefined ? { fit } : {}),
      ...(request.attribution !== undefined ? {
        attribution: prepareText(request.attribution, 'Picture attribution', 500)
      } : {})
    });
  }
  return projectResult(await current.services.serviceProjectStore.save(next, {
    expectedRevisionId: current.expectedRevisionId,
    reason: `update-${item.kind}`
  }));
});

ipcMain.handle('prepare:projects:updatePictureOutput', async (event, request = {}) => {
  requireControlSender(event);
  requirePrepareRequest(request, 16 * 1024);
  const current = await readExpectedProject(request);
  const itemId = prepareId(request.itemId, 'Picture item');
  const channelId = prepareId(request.channelId, 'Picture output');
  const item = current.project.items[itemId];
  const channel = current.project.channels[channelId];
  if (!item || item.kind !== 'picture') {
    failMainOperation('UNEDITABLE_PROJECT_ITEM', 'That picture is no longer available.');
  }
  if (!channel) {
    failMainOperation('UNKNOWN_PROJECT_CHANNEL', 'That output is not part of this service.');
  }
  const action = prepareText(request.action, 'Picture output action', 12, { required: true });
  if (!['choose', 'remove'].includes(action)) {
    failMainOperation('INVALID_PICTURE_OUTPUT_ACTION', 'Choose or remove a picture for this output.');
  }

  if (action === 'remove') {
    const next = updatePictureChannelAsset(current.project, {
      itemId,
      channelId,
      remove: true
    });
    return projectResult(await current.services.serviceProjectStore.save(next, {
      expectedRevisionId: current.expectedRevisionId,
      reason: 'remove-picture-output'
    }));
  }

  const result = await dialog.showOpenDialog(controlWindow, {
    title: `Choose Picture for ${channel.label || channelId}`,
    filters: [{ name: 'Pictures', extensions: ['png', 'jpg', 'jpeg', 'webp'] }],
    properties: ['openFile']
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  const updated = await current.services.serviceProjectStore.importImageAndUpdateProject(
    current.projectId,
    {
      sourcePath: result.filePaths[0],
      expectedRevisionId: current.expectedRevisionId,
      altText: item.altText,
      attribution: item.attribution,
      reason: 'replace-picture-output'
    },
    (project, asset) => updatePictureChannelAsset(project, {
      itemId,
      channelId,
      assetId: asset.id
    })
  );
  return projectResult(updated);
});

ipcMain.handle('prepare:projects:duplicateItem', async (event, request = {}) => {
  requireControlSender(event);
  requirePrepareRequest(request, 16 * 1024);
  const current = await readExpectedProject(request);
  const itemId = prepareId(request.itemId, 'Service item');
  const item = current.project.items[itemId];
  if (!item || item.kind === 'imported-deck') {
    failMainOperation('UNDUPLICATABLE_PROJECT_ITEM', 'That service item cannot be duplicated here.');
  }
  const next = duplicateProjectItem(current.project, { itemId });
  return projectResult(await current.services.serviceProjectStore.save(next, {
    expectedRevisionId: current.expectedRevisionId,
    reason: 'duplicate-item'
  }));
});

ipcMain.handle('prepare:projects:updateSongArrangement', async (event, request = {}) => {
  requireControlSender(event);
  requirePrepareRequest(request, 64 * 1024);
  const current = await readExpectedProject(request);
  const itemId = prepareId(request.itemId, 'Song item');
  const item = projectSongItem(current.project, itemId);
  const next = updateSongArrangement(current.project, {
    itemId,
    arrangement: requestedArrangement(current.project, item, request.arrangement)
  });
  return projectResult(await current.services.serviceProjectStore.save(next, {
    expectedRevisionId: current.expectedRevisionId,
    reason: 'arrange-song'
  }));
});

ipcMain.handle('prepare:projects:linkSongTranslation', async (event, request = {}) => {
  requireControlSender(event);
  requirePrepareRequest(request, 32 * 1024);
  const current = await readExpectedProject(request);
  const itemId = prepareId(request.itemId, 'Song item');
  const channelId = prepareId(request.channelId, 'Output language');
  const songId = prepareId(request.songId, 'Song translation');
  const songRevision = request.songRevisionId || request.songRevision;
  const songRead = await current.services.localSongLibrary.read(songId, {
    ...(songRevision ? { revision: prepareRevision(songRevision, 'Song revision') } : {})
  });
  const next = linkSongTranslation(current.project, {
    itemId,
    channelId,
    song: songRead.song,
    origin: {
      provider: 'local',
      itemId: songRead.song.id,
      revision: songRead.revision
    }
  });
  return projectResult(await current.services.serviceProjectStore.save(next, {
    expectedRevisionId: current.expectedRevisionId,
    reason: 'link-song-translation'
  }));
});

ipcMain.handle('prepare:projects:resetSongTranslation', async (event, request = {}) => {
  requireControlSender(event);
  requirePrepareRequest(request, 16 * 1024);
  const current = await readExpectedProject(request);
  const itemId = prepareId(request.itemId, 'Song item');
  const channelId = prepareId(request.channelId, 'Output language');
  const channel = current.project.channels[channelId];
  if (!channel) {
    failMainOperation('UNKNOWN_PROJECT_CHANNEL', 'That output language is not part of this service.');
  }
  const mode = /(media|singer|stage)/i.test(`${channelId} ${channel.label || ''}`)
    ? 'derive'
    : 'inherit';
  const next = resetSongChannelVariant(current.project, {
    itemId,
    channelId,
    mode
  });
  return projectResult(await current.services.serviceProjectStore.save(next, {
    expectedRevisionId: current.expectedRevisionId,
    reason: 'reset-song-translation'
  }));
});

ipcMain.handle('prepare:projects:addBible', async (event, request = {}) => {
  requireControlSender(event);
  requirePrepareRequest(request, 16 * 1024);
  const current = await readExpectedProject(request);
  const reference = prepareText(request.reference, 'Bible reference', 160, { required: true });
  const translationId = prepareText(request.translationId || 'BSB', 'Bible translation', 12, { required: true });
  const selectedBookId = request.selectedBookId
    ? prepareText(request.selectedBookId, 'Bible book selection', 80, { required: true })
    : null;
  const lookup = await resolveBibleLookupRequest({
    query: reference,
    translationId,
    ...(selectedBookId ? { selectedBook: selectedBookId } : {})
  });
  if (lookup?.status !== 'ok' || !lookup.passage) {
    if (lookup?.status === 'ambiguous') {
      failMainOperation(
        'BIBLE_REFERENCE_AMBIGUOUS',
        'Choose which Bible book you meant before adding the passage.',
        { choices: lookup.choices }
      );
    }
    failMainOperation(
      'BIBLE_REFERENCE_INVALID',
      lookup?.message || 'That Bible passage could not be added.',
      { status: lookup?.status || 'error', code: lookup?.code || null }
    );
  }
  const passage = lookup.passage;
  const next = addBibleItem(current.project, {
    id: projectItemId('bible'),
    title: `${passage.reference} (${passage.translation.abbr})`,
    passagesByChannel: Object.fromEntries(
      current.project.channelIds.map(channelId => [channelId, passage])
    ),
    presetId: 'scripture-text',
    operatorNotes: '',
    parentId: request.parentId ? prepareId(request.parentId, 'Parent item') : null
  });
  return projectResult(await current.services.serviceProjectStore.save(next, {
    expectedRevisionId: current.expectedRevisionId,
    reason: 'add-bible'
  }));
});

ipcMain.handle('prepare:projects:addText', async (event, request = {}) => {
  requireControlSender(event);
  requirePrepareRequest(request, 64 * 1024);
  const current = await readExpectedProject(request);
  const kind = request.kind === 'sermon' ? 'sermon' : request.kind === 'blank' ? 'blank' : 'notice';
  const title = prepareText(request.title || (kind === 'sermon' ? 'Sermon point' : 'Notice'), 'Item title', 200, { required: true });
  const item = kind === 'blank'
    ? {
        id: projectItemId('blank'),
        kind,
        title,
        channelIds: [...current.project.channelIds],
        presetId: 'blank-black',
        operatorNotes: ''
      }
    : {
        id: projectItemId(kind),
        kind,
        title,
        textByChannel: Object.fromEntries(current.project.channelIds.map(channelId => [
          channelId,
          prepareText(request.text, 'Projected text', 20000, { required: true })
        ])),
        presetId: kind === 'sermon' ? 'sermon-point' : 'notice-text',
        operatorNotes: ''
      };
  const next = addProjectItem(current.project, item, {
    parentId: request.parentId ? prepareId(request.parentId, 'Parent item') : null
  });
  return projectResult(await current.services.serviceProjectStore.save(next, {
    expectedRevisionId: current.expectedRevisionId,
    reason: `add-${kind}`
  }));
});

ipcMain.handle('prepare:projects:addPicture', async (event, request = {}) => {
  requireControlSender(event);
  requirePrepareRequest(request, 32 * 1024);
  const current = await readExpectedProject(request);
  const altText = prepareText(request.altText, 'Picture description', 500, { required: true });
  const attribution = prepareText(request.attribution, 'Picture attribution', 500);
  const fit = request.fit === 'fill' || request.fit === 'stretch' ? request.fit : 'fit';
  const parentId = request.parentId ? prepareId(request.parentId, 'Parent item') : null;
  const result = await dialog.showOpenDialog(controlWindow, {
    title: 'Add Picture to Service',
    filters: [{ name: 'Pictures', extensions: ['png', 'jpg', 'jpeg', 'webp'] }],
    properties: ['openFile']
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  const added = await current.services.serviceProjectStore.importImageAndUpdateProject(current.projectId, {
    sourcePath: result.filePaths[0],
    expectedRevisionId: current.expectedRevisionId,
    altText,
    attribution,
    reason: 'add-picture'
  }, (project, asset) => addProjectItem(project, {
    id: projectItemId('picture'),
    kind: 'picture',
    title: altText,
    assetId: asset.id,
    channelIds: [...project.channelIds],
    fit,
    focalPoint: { x: 0.5, y: 0.5 },
    altText,
    attribution,
    presetId: 'picture-fullscreen',
    operatorNotes: ''
  }, { parentId }));
  return projectResult(added);
});

ipcMain.handle('prepare:projects:removeItem', async (event, request = {}) => {
  requireControlSender(event);
  requirePrepareRequest(request, 16 * 1024);
  const current = await readExpectedProject(request);
  const itemId = prepareId(request.itemId, 'Service item');
  const next = removeProjectItemAndDescendants(current.project, itemId);
  return projectResult(await current.services.serviceProjectStore.save(next, {
    expectedRevisionId: current.expectedRevisionId,
    reason: 'remove-item'
  }));
});

ipcMain.handle('prepare:projects:moveItem', async (event, request = {}) => {
  requireControlSender(event);
  requirePrepareRequest(request, 16 * 1024);
  const current = await readExpectedProject(request);
  const next = moveProjectItem(current.project, {
    itemId: prepareId(request.itemId, 'Service item'),
    targetParentId: request.targetParentId ? prepareId(request.targetParentId, 'Target parent') : null,
    targetIndex: Number.isSafeInteger(request.targetIndex) ? request.targetIndex : undefined
  });
  return projectResult(await current.services.serviceProjectStore.save(next, {
    expectedRevisionId: current.expectedRevisionId,
    reason: 'move-item'
  }));
});

ipcMain.handle('prepare:projects:publish', async (event, request = {}) => {
  requireControlSender(event);
  requirePrepareRequest(request, 16 * 1024);
  if (appState.activeLaunchPlan) {
    failMainOperation('SHOW_ACTIVE', 'Return to Load and end the current Show before publishing another service.');
  }
  if (isConverting || conversionQueue.length > 0) {
    failMainOperation('LOAD_BUSY', 'Wait for the current slideshow to finish loading before preparing another service.');
  }
  const publishGeneration = ++preparePublishGeneration;
  const presentationRevisionAtStart = presentationRevision;
  const outputSessionIdAtStart = outputSessionId;
  const venueProfileAtStart = activeVenueProfile;
  const projectId = prepareId(request.projectId, 'Service project');
  const revisionId = prepareRevision(request.revisionId, 'Service revision');
  const services = getPrepareServices();
  const selected = await services.serviceProjectStore.read(projectId);
  if (selected.revisionId !== revisionId) {
    failMainOperation(
      'PROJECT_CONFLICT',
      'This service changed since it was opened. Reload it before preparing Load.',
      { currentRevisionId: selected.revisionId, expectedRevisionId: revisionId }
    );
  }
  const roleMapping = nativeProjectRoleMapping(selected.project);
  // Native services use the same stable 16:9 logical canvas as their presets.
  // Picking the largest connected display here can accidentally inherit a
  // Retina laptop's 3:2 aspect ratio and letterbox every venue projector.
  const targetWidth = CONFIG.displayWidth;
  const targetHeight = CONFIG.displayHeight;
  const published = await services.showPackagePublisher.publish({
    projectId,
    revisionId,
    roleMapping,
    width: targetWidth,
    height: targetHeight,
    thumbnailWidth: CONFIG.thumbnailWidth,
    onProgress: progress => {
      if (controlWindow && !controlWindow.isDestroyed()) {
        controlWindow.webContents.send('prepare:publishProgress', progress);
      }
    }
  });
  const currentBeforeInstall = await services.serviceProjectStore.read(projectId);
  if (currentBeforeInstall.revisionId !== revisionId) {
    failMainOperation(
      'PROJECT_CONFLICT',
      'The service changed while its offline Show package was being prepared. The safe package was kept, but Load was not replaced.',
      { currentRevisionId: currentBeforeInstall.revisionId, expectedRevisionId: revisionId }
    );
  }
  if (publishGeneration !== preparePublishGeneration
    || presentationRevision !== presentationRevisionAtStart
    || outputSessionId !== outputSessionIdAtStart
    || activeVenueProfile !== venueProfileAtStart
    || isConverting
    || conversionQueue.length > 0
    || appState.activeLaunchPlan) {
    failMainOperation(
      'PREPARE_PUBLISH_STALE',
      'The service package was prepared safely, but Load or Show changed before it could be installed. Return to Prepare and choose Save & go to Load again.'
    );
  }
  for (const [roleId, presentation] of Object.entries(published.presentations)) {
    installPresentation(roleId, presentation);
  }
  return {
    success: true,
    showPackage: {
      id: published.manifest.id,
      projectId,
      revisionId,
      cueCount: published.manifest.cueCount,
      roles: Object.keys(published.presentations)
    }
  };
});

ipcMain.handle('dialog:openPptx', async (event, language) => {
  requireControlSender(event);
  language = requirePresentationRole(language);

  const result = await dialog.showOpenDialog(controlWindow, {
    title: `Select ${getPresentationRoleLabel(language)} PowerPoint`,
    filters: [
      { name: 'PowerPoint Files', extensions: ['pptx', 'ppt'] }
    ],
    properties: ['openFile']
  });

  if (!result.canceled && result.filePaths.length > 0) {
    return grantPresentationPath(result.filePaths[0], 'native-file-picker');
  }
  return null;
});

// Process conversion queue
async function processConversionQueue() {
  if (isConverting || conversionQueue.length === 0) return;

  isConverting = true;
  const { filePath, language, restoreContext, resolve, reject } = conversionQueue.shift();

  try {
    const result = await runConversion(filePath, language, restoreContext);
    resolve(result);
  } catch (error) {
    reject(error);
  } finally {
    isConverting = false;
    // Process next in queue
    processConversionQueue();
  }
}

// Actual conversion function using Node.js converter
async function runConversion(filePath, language, restoreContext = null) {
  filePath = requirePresentationFile(filePath);
  language = requirePresentationRole(language);
  const outputDir = path.join(CONFIG.cacheDir, language);

  // Detect the largest display resolution for optimal render quality.
  // Floor at 1080p so slides always look sharp even if all monitors are small.
  const displays = screen.getAllDisplays();
  let targetWidth = CONFIG.displayWidth;
  let targetHeight = CONFIG.displayHeight;
  for (const d of displays) {
    const w = d.size.width * (d.scaleFactor || 1);
    const h = d.size.height * (d.scaleFactor || 1);
    if (w * h > targetWidth * targetHeight) {
      targetWidth = w;
      targetHeight = h;
    }
  }
  console.log(`[Converter] Target resolution: ${targetWidth}x${targetHeight} (from ${displays.length} display(s))`);

  // Create converter with options
  const converter = new Converter({
    width: targetWidth,
    height: targetHeight,
    thumbnailWidth: CONFIG.thumbnailWidth
  });

  // Listen for progress events
  converter.on('progress', ({ percent, stage, converter: converterName, fallbackFrom, message }) => {
    if (controlWindow && !controlWindow.isDestroyed()) {
      controlWindow.webContents.send('conversion:progress', {
        language,
        progress: percent,
        stage,
        converter: converterName || null,
        fallbackFrom: fallbackFrom || null,
        message: message || null
      });
    }
    console.log(`[Converter] ${language}: ${percent}% (${stage})`);
  });

  try {
    // Run conversion
    const conversionResult = await converter.convert(filePath, outputDir, restoreContext);

    const { slideCount, metadata } = conversionResult;
    console.log(`[Metadata] Loaded for ${language}: ${metadata.slides?.length || 0} slides`);
    if (metadata.slides && metadata.slides[0]) {
      console.log(`[Metadata] First slide text sample: "${metadata.slides[0].firstLine?.substring(0, 50) || metadata.slides[0].text?.substring(0, 50) || 'none'}..."`);
    }

    const result = {
      success: true,
      cacheDir: outputDir,
      slideCount,
      metadata
    };

    // Update app state
    installPresentation(language, result);
    console.log(`[State] Presentation ${language} stored with ${result.slideCount} slides and metadata: ${metadata.slides?.length || 0} slides`);

    return result;
  } catch (error) {
    console.error(`[Converter] Error converting ${language}:`, error);
    throw error;
  }
}

// Queued conversion handler - prevents concurrent conversions
ipcMain.handle('pptx:convert', async (event, payload = {}) => {
  requireControlSender(event);
  const { filePath, language, restoreGroupId } = payload || {};
  const safeFilePath = requireApprovedPresentationFile(filePath);
  const safeLanguage = requirePresentationRole(language);
  const restoreContext = conversionRestoreContext(
    safeFilePath,
    safeLanguage,
    restoreGroupId
  );

  return new Promise((resolve, reject) => {
    // Add to queue
    conversionQueue.push({
      filePath: safeFilePath,
      language: safeLanguage,
      restoreContext,
      resolve,
      reject
    });
    // Start processing if not already
    processConversionQueue();
  });
});

ipcMain.handle('slides:getList', async (event, language) => {
  requireControlSender(event);
  language = requirePresentationRole(language);
  const presentation = appState.presentations[language];
  if (!presentation) return [];

  const slideFiles = presentation.renderer === 'native-cue'
    ? Array.from({ length: presentation.slideCount }, (_, index) =>
        `scene_${String(index + 1).padStart(3, '0')}.json`)
    : fs.readdirSync(presentation.cacheDir)
      .filter(f => f.startsWith('slide_') && f.endsWith('.jpg') && !f.includes('_thumb'))
      .sort();

  // Read thumbnail images as base64 for reliable display
  return slideFiles.map((file, index) => {
    const number = String(index + 1).padStart(3, '0');
    const thumbFile = presentation.renderer === 'native-cue'
      ? `slide_${number}_thumb.jpg`
      : file.replace('.jpg', '_thumb.jpg');
    const thumbPath = path.join(presentation.cacheDir, thumbFile);
    const imagePath = presentation.renderer === 'native-cue'
      ? null
      : path.join(presentation.cacheDir, file);

    // Read thumbnail as base64
    let thumbnailBase64 = '';
    try {
      if (fs.existsSync(thumbPath)) {
        const thumbBuffer = fs.readFileSync(thumbPath);
        thumbnailBase64 = `data:image/jpeg;base64,${thumbBuffer.toString('base64')}`;
      }
    } catch (e) {
      console.error(`Error reading thumbnail ${thumbFile}:`, e);
    }

    return {
      index: index,
      imagePath: imagePath,
      thumbnailPath: thumbPath,
      thumbnailBase64: thumbnailBase64,  // New: base64 for thumbnails
      text: presentation.metadata?.slides?.[index]?.text || ''
    };
  });
});

ipcMain.handle('display:start', async (event, options = {}) => {
  requireControlSender(event);

  if (!options || typeof options !== 'object' || Array.isArray(options)) {
    throw new TypeError('Launch options must be an object');
  }

  const {
    outputs,
    decisions = {},
    preferredTimelineRoleId,
    settings = {}
  } = options;

  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) {
    throw new TypeError('Launch settings must be an object');
  }

  // Resolve and freeze all per-service decisions before touching the active
  // output session. A malformed or incomplete Start therefore leaves the
  // currently running show intact.
  const launchPlan = resolveLaunchPlan({
    presentations: appState.presentations,
    outputs,
    decisions,
    preferredTimelineRoleId
  });

  const displays = screen.getAllDisplays();
  const displayById = new Map(displays.map(display => [String(display.id), display]));
  const controlDisplayId = getControlDisplayId();
  for (const output of launchPlan.outputs) {
    if (!displayById.has(String(output.displayId))) {
      throw new Error(`${output.name} is assigned to a display that is no longer connected`);
    }
    if (!['slides', 'native-cue', 'singer-current-next'].includes(output.renderer)) {
      throw new Error(`${output.name} uses an unsupported renderer`);
    }
    if (String(output.displayId) === String(controlDisplayId)) {
      throw new Error(`${output.name} is assigned to the operator screen; choose a presentation screen`);
    }
  }

  // Reconcile every Start from a clean output session. This destroys windows
  // hidden by Back/Stop as well as any partially-created windows from a rapid
  // repeated Start, so no unreferenced fullscreen windows survive.
  destroyOutputWindows();
  const sessionId = outputSessionId;
  outputsShouldBeVisible = true;
  outputLifecyclePhase = 'starting';
  appState.isCleared = false;
  const readyPromises = [];

  // Store fade duration setting
  appState.fadeDuration = Number.isFinite(settings.fadeDuration)
    ? Math.max(0, Math.min(5000, settings.fadeDuration))
    : 300;

  // Store sync mode setting
  appState.syncMode = Boolean(settings.syncMode);

  // Store singer font size setting
  appState.singerFontSize = Number.isFinite(settings.singerFontSize)
    ? Math.max(12, Math.min(240, settings.singerFontSize))
    : 36;

  // Store singer char limit setting
  appState.singerCharLimit = Number.isFinite(settings.singerCharLimit)
    ? Math.max(10, Math.min(500, settings.singerCharLimit))
    : 70;

  // Store singer text padding setting
  appState.singerTextPadding = Number.isFinite(settings.singerTextPadding)
    ? Math.max(0, Math.min(80, settings.singerTextPadding))
    : 4;

  appState.activeLaunchPlan = launchPlan;
  appState.currentSlide = 0;
  appState.totalSlides = launchPlan.totalSlides;
  showGateway.beginSession();

  try {
    for (const output of launchPlan.outputs) {
      const displayInfo = displayById.get(String(output.displayId));
      const win = output.renderer === 'singer-current-next'
        ? createSingerWindow(displayInfo, output, sessionId)
        : createDisplayWindow(displayInfo, output, sessionId);

      outputWindows.set(output.id, { win, output, sessionId });
      trackOutputWindowHealth(win, output, sessionId);
      appState.displayAssignments.set(output.id, displayInfo.id);
      readyPromises.push(waitForOutputWindowReady(win, output, sessionId));
    }
  } catch (error) {
    if (sessionId === outputSessionId) destroyOutputWindows();
    throw error;
  }

  // Global shortcuts deprecated — keyboard handling is in the renderer (app.js).
  // registerGlobalShortcuts();

  try {
    await Promise.all(readyPromises);
  } catch (error) {
    if (sessionId === outputSessionId) destroyOutputWindows();
    throw error;
  }

  if (sessionId !== outputSessionId) {
    throw new Error('Output startup was replaced by a newer session');
  }
  if (!outputsShouldBeVisible) {
    destroyOutputWindows();
    throw new Error('Output startup was cancelled before the windows became ready');
  }

  const initialFramePromises = [...outputWindows.values()].map(({ win, output }) =>
    waitForInitialOutputFrame(win, output, sessionId, 0)
  );

  console.log('[Display] Output windows ready; preparing initial goToSlide(0) while hidden');
  goToSlide(0, { publish: false });

  try {
    await Promise.all(initialFramePromises);
  } catch (error) {
    if (sessionId === outputSessionId) destroyOutputWindows();
    throw error;
  }

  if (sessionId !== outputSessionId || !outputsShouldBeVisible) {
    if (sessionId === outputSessionId) destroyOutputWindows();
    throw new Error('Output startup was cancelled before the first frame became ready');
  }

  // Reveal only after every output has loaded its first frame. A slow or
  // failed output can no longer expose a partial set of fullscreen windows.
  outputWindows.forEach(({ win }) => showOutputWindow(win));
  outputLifecyclePhase = 'live';
  const showState = publishShowState('show-started');

  return {
    success: true,
    totalSlides: appState.totalSlides,
    plan: launchPlan,
    outputSessionId: showState?.outputSessionId || null,
    showState
  };
});

ipcMain.handle('display:stop', async (event) => {
  requireControlSender(event);
  const result = hideDisplayWindows();
  // unregisterGlobalShortcuts(); // deprecated
  return { success: result.accepted !== false, showState: showGateway.getState() };
});

// Show displays - re-show windows and current slide
ipcMain.handle('display:show', async (event) => {
  requireControlSender(event);
  const result = showAllDisplays();
  if (result.accepted === false) failMainOperation(result.code, result.message);
  // registerGlobalShortcuts(); // deprecated
  return { success: true, showState: showGateway.getState() };
});

// Clear displays - show black screens but keep windows open
ipcMain.handle('display:clear', async (event) => {
  requireControlSender(event);
  const result = clearAllDisplays();
  if (result.accepted === false) failMainOperation(result.code, result.message);
  return { success: true, showState: showGateway.getState() };
});

// End the output session rather than merely hiding it. Back to Load uses this
// boundary so no retained window, launch plan, or future Remote grant can
// restore a service the local operator intentionally left.
ipcMain.handle('display:endSession', async (event) => {
  requireControlSender(event);
  destroyOutputWindows();
  return { success: true, showState: showGateway.getState() };
});

// Set fade duration for transitions
ipcMain.handle('display:setFade', async (event, duration) => {
  requireControlSender(event);
  if (!Number.isFinite(duration)) throw new TypeError('Fade duration must be a number');
  appState.fadeDuration = Math.max(0, Math.min(5000, duration));

  // Notify every ordinary slide renderer. Singer-derived renderers do not use
  // the crossfade layers and safely keep their own layout timing.
  outputWindows.forEach(({ win, output }) => {
    if (output.renderer !== 'slides' && output.renderer !== 'native-cue') return;
    if (win && !win.isDestroyed()) {
      win.webContents.send('display:fadeUpdate', appState.fadeDuration);
    }
  });

  console.log(`[Display] Fade duration set to ${appState.fadeDuration}ms`);
  return { success: true };
});

// Set sync mode for coordinated reveal timing
ipcMain.handle('display:setSyncMode', async (event, enabled) => {
  requireControlSender(event);
  appState.syncMode = Boolean(enabled);

  outputWindows.forEach(({ win, output }) => {
    if (output.renderer !== 'slides' && output.renderer !== 'native-cue') return;
    if (win && !win.isDestroyed()) {
      win.webContents.send('display:syncModeUpdate', appState.syncMode);
    }
  });

  console.log(`[Display] Sync mode ${appState.syncMode ? 'enabled' : 'disabled'}`);
  return { success: true };
});

// Set singer font size
ipcMain.handle('singer:setFontSize', async (event, size) => {
  requireControlSender(event);
  if (!Number.isFinite(size)) throw new TypeError('Singer font size must be a number');
  appState.singerFontSize = Math.max(12, Math.min(240, size));

  outputWindows.forEach(({ win, output }) => {
    if (output.renderer === 'singer-current-next' && win && !win.isDestroyed()) {
      win.webContents.send('singer:fontSizeUpdate', appState.singerFontSize);
    }
  });

  console.log(`[Singer] Font size set to ${appState.singerFontSize}px`);
  return { success: true };
});

// Set singer text padding
ipcMain.handle('singer:setTextPadding', async (event, padding) => {
  requireControlSender(event);
  if (!Number.isFinite(padding)) throw new TypeError('Singer text padding must be a number');
  appState.singerTextPadding = Math.max(0, Math.min(80, padding));

  outputWindows.forEach(({ win, output }) => {
    if (output.renderer === 'singer-current-next' && win && !win.isDestroyed()) {
      win.webContents.send('singer:textPaddingUpdate', appState.singerTextPadding);
    }
  });

  console.log(`[Singer] Text padding set to ${appState.singerTextPadding}px`);
  return { success: true };
});

// Set singer char limit
ipcMain.handle('singer:setCharLimit', async (event, limit) => {
  requireControlSender(event);
  if (!Number.isFinite(limit)) throw new TypeError('Singer character limit must be a number');
  appState.singerCharLimit = Math.max(10, Math.min(500, limit));

  outputWindows.forEach(({ win, output }) => {
    if (output.renderer === 'singer-current-next' && win && !win.isDestroyed()) {
      win.webContents.send('singer:charLimitUpdate', appState.singerCharLimit);
    }
  });

  console.log(`[Singer] Char limit set to ${appState.singerCharLimit}`);
  return { success: true };
});

// Hide displays - hide windows but don't stop presentation
ipcMain.handle('display:hide', async (event) => {
  requireControlSender(event);
  hideDisplayWindows();
  return { success: true };
});

ipcMain.handle('show:navigateTo', async (event, slideIndex) => {
  requireControlSender(event);
  const result = goToSlide(slideIndex);
  if (result?.accepted === false) failMainOperation(result.code, result.message);
  if (!result || result.accepted !== true) {
    failMainOperation('SHOW_NAVIGATION_FAILED', 'The Show could not change to that cue.');
  }
  return { success: true, showState: showGateway.getState() };
});

ipcMain.handle('show:navigateBy', async (event, delta) => {
  requireControlSender(event);
  if (delta !== -1 && delta !== 1) {
    failMainOperation('INVALID_CUE_DIRECTION', 'Show navigation must move one cue at a time.');
  }
  const result = navigateSlide(delta);
  if (result?.code === 'AT_FIRST_CUE' || result?.code === 'AT_LAST_CUE') {
    return { success: true, applied: false, showState: showGateway.getState() };
  }
  if (result?.accepted === false) failMainOperation(result.code, result.message);
  if (!result || result.accepted !== true) {
    failMainOperation('SHOW_NAVIGATION_FAILED', 'The Show could not change cues.');
  }
  return { success: true, showState: showGateway.getState() };
});

ipcMain.handle('show:getState', async (event) => {
  requireControlSender(event);
  return showGateway.getState();
});

ipcMain.handle('remote:listBindings', async (event) => {
  requireControlSender(event);
  return listRemoteBindings();
});

ipcMain.handle('remote:getState', async (event) => {
  requireControlSender(event);
  return remoteManagementState();
});

ipcMain.handle('remote:enable', async (event, request = {}) => {
  requireControlSender(event);
  if (!request || typeof request !== 'object' || Array.isArray(request)
    || Object.keys(request).some(key => key !== 'bindingId')
    || typeof request.bindingId !== 'string'
    || request.bindingId.length > 96) {
    throw new TypeError('Choose a valid Remote Control network.');
  }
  return enableRemoteControl(request.bindingId);
});

ipcMain.handle('remote:rotatePairing', async (event) => {
  requireControlSender(event);
  remoteLastError = null;
  return queueRemoteOperation(createRemotePairing);
});

ipcMain.handle('remote:closePairing', async (event) => {
  requireControlSender(event);
  closeRemotePairing();
  return remoteManagementState();
});

ipcMain.handle('remote:revokeAll', async (event) => {
  requireControlSender(event);
  return queueRemoteOperation(async () => {
    closeRemotePairing();
    remoteServer.revokeAll('operator-revoked');
    emitRemoteState();
    return remoteManagementState();
  });
});

ipcMain.handle('remote:disable', async (event) => {
  requireControlSender(event);
  return disableRemoteControl('operator-off', { clearError: true });
});

ipcMain.handle('app:getState', async (event) => {
  requireControlSender(event);
  updateDisplayList();
  return {
    currentSlide: appState.currentSlide,
    totalSlides: appState.totalSlides,
    showState: showGateway.getState(),
    displays: appState.displays,
    presentations: Object.fromEntries((activeVenueProfile?.inputRoles || [])
      .filter(role => role.kind === 'deck')
      .map(role => [
        role.id,
        appState.presentations[role.id]
          ? { loaded: true, slideCount: appState.presentations[role.id].slideCount }
          : null
      ]))
  };
});

// User settings handlers
ipcMain.handle('settings:load', async (event) => {
  requireControlSender(event);
  const settings = loadAndApplyUserSettings();
  return {
    ...settings,
    recoveryWarning: settingsRecoveryWarning
  };
});

ipcMain.handle('settings:save', async (event, settings) => {
  requireControlSender(event);
  const normalized = saveUserSettings(settings);
  settingsRecoveryWarning = null;
  return { success: true, ...normalized };
});

ipcMain.handle('settings:defaultProfile', async (event) => {
  requireControlSender(event);
  return normalizeUserSettings({}).venueProfile;
});

ipcMain.on('settings:draftState', (event, draftState = {}) => {
  requireControlSender(event);
  if (typeof draftState.dirty !== 'boolean' || typeof draftState.saving !== 'boolean') {
    throw new TypeError('Settings draft state must contain boolean dirty and saving values');
  }
  controlSettingsDraftState = {
    dirty: draftState.dirty,
    saving: draftState.saving
  };
});

ipcMain.handle('drive:status', async (event) => {
  requireControlSender(event);
  return driveStatusPayload();
});

ipcMain.handle('drive:privateOAuthState', async (event) => {
  requireControlSender(event);
  return privateDriveOAuthStatePayload();
});

ipcMain.handle('drive:copyPrivateOAuthUrl', async (event) => {
  requireControlSender(event);
  const services = await getGoogleDriveServices();
  const authorizationUrl = services.oauthFlow?.getActiveAuthorizationUrl();
  if (!authorizationUrl) {
    failMainOperation(
      'NO_ACTIVE_PRIVATE_DRIVE_SIGN_IN',
      'Google sign-in is no longer waiting. Start it again to copy a new link.'
    );
  }
  try {
    clipboard.writeText(authorizationUrl);
  } catch (_error) {
    failMainOperation(
      'PRIVATE_DRIVE_LINK_COPY_FAILED',
      'SyncShow could not copy the Google sign-in link.'
    );
  }
  return { copied: true };
});

ipcMain.handle('drive:cancelPrivateOAuth', async (event) => {
  requireControlSender(event);
  const services = await getGoogleDriveServices();
  return {
    cancelled: await services.oauthFlow?.cancel() === true
  };
});

ipcMain.handle('drive:connectPrivate', async (event) => {
  requireControlSender(event);
  const services = await getGoogleDriveServices();
  if (!services.oauthFlow || !services.config.clientId) {
    failMainOperation(
      'PRIVATE_DRIVE_NOT_CONFIGURED',
      'This SyncShow build needs a Google Desktop OAuth client ID before it can connect a private folder.'
    );
  }
  // Prove the OS credential store works before opening Google sign-in. This
  // avoids issuing a refresh token that the app cannot persist securely.
  await services.store.assertSecureStorageAvailable();
  const operationEpoch = googleDriveOperationEpoch;
  const authorization = await services.oauthFlow.start();
  try {
    if (operationEpoch !== googleDriveOperationEpoch) {
      failMainOperation('DRIVE_OPERATION_CANCELLED', 'Google Drive connection was cancelled.');
    }
    const grantedScopes = String(authorization.scope || '').split(/\s+/).filter(Boolean);
    if (!grantedScopes.includes('https://www.googleapis.com/auth/drive.file')) {
      failMainOperation(
        'DRIVE_SCOPE_NOT_GRANTED',
        'Google did not grant access to the selected Drive folder.'
      );
    }
    const client = new GoogleDriveClient({ accessToken: authorization.accessToken });
    const folder = await client.getFileMetadata({ fileId: authorization.folderId });
    if (folder.mimeType !== DRIVE_FOLDER_MIME_TYPE) {
      failMainOperation('NOT_A_DRIVE_FOLDER', 'Choose a Google Drive folder, not an individual file.');
    }
    if (!folder.capabilities.canListChildren) {
      failMainOperation(
        'DRIVE_FOLDER_NOT_READABLE',
        'Google did not allow SyncShow to read files inside that folder.'
      );
    }
    const summary = await services.store.savePrivateConnection({
      folderId: folder.id,
      folderName: folder.name,
      resourceKey: folder.resourceKey,
      capabilities: folder.capabilities,
      refreshToken: authorization.refreshToken,
      writeEnabled: false
    });
    googleDriveAccessTokens.set(summary.id, {
      accessToken: authorization.accessToken,
      expiresAt: Date.now() + authorization.expiresIn * 1000
    });
    rememberApprovedDriveConnection(summary.id);
    return { connection: publicDriveConnectionSummary(summary) };
  } catch (error) {
    await revokeGoogleToken(authorization.refreshToken);
    throw error;
  }
});

ipcMain.handle('drive:linkPublic', async (event, request = {}) => {
  requireControlSender(event);
  if (!request || typeof request !== 'object' || Array.isArray(request)
    || Object.keys(request).some(key => key !== 'url')) {
    failMainOperation('INVALID_PUBLIC_DRIVE_LINK', 'Paste a public Google Drive folder link.');
  }
  const services = await getGoogleDriveServices();
  if (!services.config.apiKey) {
    failMainOperation(
      'PUBLIC_DRIVE_NOT_CONFIGURED',
      'This SyncShow build needs a Drive-API-restricted Google API key before it can use public folder links.'
    );
  }
  const parsed = parseGoogleDriveFolderLink(request.url);
  const client = new GoogleDriveClient({ apiKey: services.config.apiKey });
  const folder = await client.getFileMetadata({
    fileId: parsed.folderId,
    resourceKey: parsed.resourceKey
  });
  if (folder.mimeType !== DRIVE_FOLDER_MIME_TYPE) {
    failMainOperation('NOT_A_DRIVE_FOLDER', 'That link does not point to a Google Drive folder.');
  }
  const summary = await services.store.savePublicConnection({
    folderId: folder.id,
    folderName: folder.name,
    resourceKey: folder.resourceKey || parsed.resourceKey,
    capabilities: folder.capabilities
  });
  rememberApprovedDriveConnection(summary.id);
  return { connection: publicDriveConnectionSummary(summary) };
});

ipcMain.handle('drive:setPublishingEnabled', async (event, request = {}) => {
  requireControlSender(event);
  if (!request || typeof request !== 'object' || Array.isArray(request)
    || Object.keys(request).some(key => key !== 'enabled')
    || typeof request.enabled !== 'boolean') {
    failMainOperation('INVALID_DRIVE_WRITE_SETTING', 'Drive publishing must be on or off.');
  }
  const { services, connection } = await getDriveConnectionOrFail();
  const summary = await services.store.setWriteEnabled(connection.id, request.enabled);
  return {
    ...(await driveStatusPayload()),
    connection: publicDriveConnectionSummary(summary)
  };
});

ipcMain.handle('drive:disconnect', async (event, request = {}) => {
  requireControlSender(event);
  if (!request || typeof request !== 'object' || Array.isArray(request)
    || Object.keys(request).some(key => key !== 'connectionId')
    || (request.connectionId !== undefined
      && request.connectionId !== null
      && request.connectionId !== ''
      && typeof request.connectionId !== 'string')) {
    failMainOperation('INVALID_DRIVE_CONNECTION', 'The Google Drive connection is invalid.');
  }
  const connectionId = request.connectionId || activeVenueProfile?.driveConnectionId || null;
  if (!connectionId
    || (connectionId !== activeVenueProfile?.driveConnectionId
      && !approvedDriveConnections.has(connectionId))) {
    failMainOperation('UNAPPROVED_DRIVE_CONNECTION', 'That Google Drive connection cannot be removed here.');
  }
  const services = await getGoogleDriveServices();
  const result = await services.store.disconnect(connectionId);
  approvedDriveConnections.delete(connectionId);
  googleDriveAccessTokens.delete(connectionId);
  clearServiceScanProposals();
  return {
    ...result,
    status: await driveStatusPayload()
  };
});

ipcMain.handle('dialog:openServiceFolder', async (event) => {
  requireControlSender(event);
  const configuredFolder = activeVenueProfile?.localServiceFolder || null;
  const defaultPath = configuredFolder && fs.existsSync(configuredFolder)
    ? configuredFolder
    : undefined;
  const result = await dialog.showOpenDialog(controlWindow, {
    title: 'Choose Service Folder',
    ...(defaultPath ? { defaultPath } : {}),
    properties: ['openDirectory']
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  return rememberApprovedServiceFolder(result.filePaths[0]);
});

ipcMain.handle('service-folder:scan', async (event, request = {}) => {
  requireControlSender(event);
  if (!request || typeof request !== 'object' || Array.isArray(request)) {
    failMainOperation('INVALID_SCAN_REQUEST', 'The service-folder scan request is invalid.');
  }
  // Capture every profile-derived value before the first await. Another IPC
  // request can save a different venue profile while this folder is scanning.
  const scanContext = captureServiceScanContext(request.requestedDate);
  let scan;
  let canonicalFolder = null;
  let directories = [];
  if (scanContext.sourceKind === 'local-folder') {
    const preflight = await preflightServiceFolderScan(scanContext.folderPath);
    canonicalFolder = preflight.canonicalFolder;
    directories = preflight.directories;
    scan = await scanServiceFolder({
      folderPath: canonicalFolder,
      inputRoles: scanContext.inputRoles,
      requiredRoleIds: scanContext.requiredRoleIds,
      requestedDate: scanContext.requestedDate,
      dateOrder: scanContext.dateOrder,
      maxDepth: SERVICE_SCAN_MAX_DEPTH,
      maxFiles: SERVICE_SCAN_MAX_FILES,
      maxEntries: SERVICE_SCAN_MAX_ENTRIES
    });
  } else {
    const operationEpoch = googleDriveOperationEpoch;
    const { services, connection } = await getDriveConnectionOrFail(scanContext.driveConnectionId);
    const client = await driveClientForConnection(connection, services);
    const listing = await client.listFolder({
      folderId: connection.folderId,
      resourceKey: connection.resourceKey,
      maximumDepth: SERVICE_SCAN_MAX_DEPTH,
      maximumFiles: SERVICE_SCAN_MAX_ENTRIES,
      maximumPages: 100
    });
    if (operationEpoch !== googleDriveOperationEpoch) {
      failMainOperation('DRIVE_OPERATION_CANCELLED', 'The Google Drive scan was cancelled.');
    }
    scan = scanDriveServiceFiles({
      sourceType: `google-drive-${connection.kind}`,
      folderId: connection.folderId,
      folderResourceKey: connection.resourceKey,
      files: listing.files,
      inputRoles: scanContext.inputRoles,
      requiredRoleIds: scanContext.requiredRoleIds,
      requestedDate: scanContext.requestedDate,
      dateOrder: scanContext.dateOrder,
      maxFiles: SERVICE_SCAN_MAX_ENTRIES
    });
    // These stay only in the main-held proposal. The renderer receives neither
    // folder/file IDs nor resource keys.
    scan.source.connectionId = connection.id;
    scan.source.connectionRevision = connection.updatedAt;
  }
  if (scan.files.length > SERVICE_SCAN_MAX_FILES) {
    failMainOperation(
      'TOO_MANY_SERVICE_FILES',
      `This folder contains more than ${SERVICE_SCAN_MAX_FILES} PowerPoint files in the scanned levels. Choose a smaller service folder.`
    );
  }
  const scanToken = holdServiceScanProposal(scan, scanContext.profileSignature);
  if (canonicalFolder) startServiceFolderWatchers(canonicalFolder, directories);
  else stopServiceFolderWatchers();
  return sanitizeServiceScan(scan, scanToken);
});

ipcMain.handle('service-set:pin', async (event, request = {}) => {
  requireControlSender(event);
  const { proposal, setId } = requireServiceScanProposal(request);
  let manifest;
  if (proposal.scan.source?.type === 'local-folder') {
    manifest = await pinServiceSet({
      scan: proposal.scan,
      setId,
      destinationRoot: getServiceSetRoot(),
      profileId: activeVenueProfile.id,
      profileName: activeVenueProfile.name,
      timeZone: activeVenueProfile.timeZone
    });
  } else {
    const connectionId = proposal.scan.source?.connectionId;
    if (!connectionId || connectionId !== activeVenueProfile.driveConnectionId) {
      failMainOperation(
        'DRIVE_CONNECTION_CHANGED',
        'The Google Drive connection changed. Refresh the service files and try again.'
      );
    }
    const operationEpoch = googleDriveOperationEpoch;
    const { services, connection } = await getDriveConnectionOrFail(connectionId);
    if (`google-drive-${connection.kind}` !== proposal.scan.source.type
      || connection.folderId !== proposal.scan.source.folderId
      || (connection.resourceKey || null) !== (proposal.scan.source.resourceKey || null)) {
      failMainOperation(
        'DRIVE_CONNECTION_CHANGED',
        'The Google Drive folder changed. Refresh the service files and try again.'
      );
    }
    let client = await driveClientForConnection(connection, services);
    const withPrivateRefresh = async operation => {
      try {
        return await operation(client);
      } catch (error) {
        if (connection.kind !== 'private' || error?.status !== 401) throw error;
        client = await driveClientForConnection(connection, services, { forceRefresh: true });
        return operation(client);
      }
    };
    const assertOperationCurrent = () => {
      if (operationEpoch !== googleDriveOperationEpoch
        || activeVenueProfile.driveConnectionId !== connectionId) {
        failMainOperation('DRIVE_OPERATION_CANCELLED', 'The Google Drive download was cancelled.');
      }
    };
    manifest = await pinRemoteServiceSet({
      scan: proposal.scan,
      setId,
      destinationRoot: getServiceSetRoot(),
      profileId: activeVenueProfile.id,
      profileName: activeVenueProfile.name,
      timeZone: activeVenueProfile.timeZone,
      checkCandidateUnchanged: async candidate => {
        assertOperationCurrent();
        const metadata = await withPrivateRefresh(currentClient =>
          currentClient.getFileMetadata({
            fileId: candidate.fileId,
            resourceKey: candidate.resourceKey
          })
        );
        assertOperationCurrent();
        return driveMetadataMatchesCandidate(metadata, candidate);
      },
      materialize: async ({ candidate, destinationPath, maximumBytes }) => {
        assertOperationCurrent();
        const buffer = await withPrivateRefresh(currentClient => (
          candidate.nativeGoogleSlides
            ? currentClient.exportGoogleSlides({
              fileId: candidate.fileId,
              resourceKey: candidate.resourceKey,
              maximumBytes
            })
            : currentClient.downloadFile({
              fileId: candidate.fileId,
              resourceKey: candidate.resourceKey,
              maximumBytes
            })
        ));
        assertOperationCurrent();
        await fs.promises.writeFile(destinationPath, buffer, { flag: 'wx', mode: 0o600 });
      }
    });
  }
  grantPinnedPresentationPaths(manifest);
  return sanitizePinnedServiceSet(manifest);
});

ipcMain.handle('service-set:current', async (event) => {
  requireControlSender(event);
  const manifest = await readCurrentServiceSet(getServiceSetRoot(), { verifyAssets: true });
  if (!manifest) return null;
  grantPinnedPresentationPaths(manifest);
  return sanitizePinnedServiceSet(manifest);
});

ipcMain.handle('service-set:checkChanges', async (event) => {
  requireControlSender(event);
  const manifest = await readCurrentServiceSet(getServiceSetRoot(), { verifyAssets: true });
  if (!manifest) return { current: null, changes: [] };
  grantPinnedPresentationPaths(manifest);
  if (manifest.source?.type === 'local-folder') validatePinnedSourcePaths(manifest);
  const changes = await checkSourceChanges(manifest);
  return {
    current: sanitizePinnedServiceSet(manifest),
    changes
  };
});

async function readValidatedCache(language) {
  const cacheDir = path.join(CONFIG.cacheDir, requirePresentationRole(language));
  const converter = new Converter();
  const metadata = await converter.validateGeneration(cacheDir);

  return {
    cacheDir,
    metadata,
    slideCount: metadata.slideCount
  };
}

function publicCacheEntry(roleId, cached) {
  const restoreContext = normalizeCacheRestoreContext(cached.metadata.restoreContext);
  return {
    roleId,
    exists: true,
    slideCount: cached.slideCount,
    originalFile: cached.metadata.originalFile || null,
    convertedAt: cached.metadata.convertedAt || null,
    restoreContext
  };
}

async function inspectCacheEntry(roleId) {
  const cacheDir = path.join(CONFIG.cacheDir, roleId);
  if (!fs.existsSync(cacheDir)) return { roleId, exists: false };
  try {
    return publicCacheEntry(roleId, await readValidatedCache(roleId));
  } catch (error) {
    console.error(`Error checking cache for ${roleId}:`, error);
    return { roleId, exists: false, invalid: true };
  }
}

// Check if a cached presentation exists and is valid
ipcMain.handle('cache:check', async (event, language) => {
  requireControlSender(event);
  language = requirePresentationRole(language);
  return inspectCacheEntry(language);
});

ipcMain.handle('cache:restorePlan', async (event) => {
  requireControlSender(event);
  const roleIds = (activeVenueProfile?.inputRoles || [])
    .filter(role => role.enabled && role.kind === 'deck')
    .map(role => role.id);
  const entries = await Promise.all(roleIds.map(inspectCacheEntry));
  return resolveCacheRestorePlan(entries);
});

// Load cached presentation (without reconverting)
ipcMain.handle('cache:load', async (event, request) => {
  requireControlSender(event);
  const legacyRequest = typeof request === 'string';
  const payload = legacyRequest ? { language: request } : request;
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    failMainOperation('INVALID_CACHE_LOAD', 'Choose a cached presentation from the current restore list.');
  }
  const language = requirePresentationRole(payload.language);
  let cached;
  try {
    cached = await readValidatedCache(language);
  } catch (error) {
    throw new Error(`No valid cached ${language} presentation is available: ${error.message}`);
  }

  const actualContext = normalizeCacheRestoreContext(cached.metadata.restoreContext);
  if (payload.legacy === true) {
    if (actualContext) {
      failMainOperation(
        'CACHE_RESTORE_CHANGED',
        'The cached service changed after the restore list was shown. Check the available service again.'
      );
    }
  } else if (typeof payload.groupId === 'string') {
    // Reuse the strict context parser to keep renderer-provided group IDs
    // bounded before comparing them with trusted cache metadata.
    const expected = normalizeCacheRestoreContext({
      schemaVersion: 1,
      groupId: payload.groupId,
      sourceKind: 'manual',
      roleId: language
    }, { allowNull: false });
    if (!actualContext || actualContext.groupId !== expected.groupId) {
      failMainOperation(
        'CACHE_RESTORE_CHANGED',
        'The cached service changed after the restore list was shown. Check the available service again.'
      );
    }
  } else if (actualContext || !legacyRequest) {
    failMainOperation(
      'CACHE_RESTORE_CONTRACT_REQUIRED',
      'Refresh the list of cached services before restoring this presentation.'
    );
  }

  const result = {
    success: true,
    cacheDir: cached.cacheDir,
    slideCount: cached.slideCount,
    metadata: cached.metadata
  };

  // Update app state
  installPresentation(language, result);
  console.log(`[Cache] Loaded ${language} from cache: ${result.slideCount} slides`);

  return result;
});

ipcMain.handle('displays:refresh', async (event) => {
  requireControlSender(event);
  updateDisplayList();
  return appState.displays;
});

ipcMain.handle('displays:identify', async (event) => {
  requireControlSender(event);
  return identifyAllDisplays();
});

// App lifecycle. The cache publication lock is process-local, and PowerPoint
// automation also depends on exclusive ownership, so only one SyncShow process
// may use a given user-data/cache location at a time.
const hasSingleInstanceLock = app.requestSingleInstanceLock();

if (!hasSingleInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!controlWindow || controlWindow.isDestroyed()) return;
    if (controlWindow.isMinimized()) controlWindow.restore();
    controlWindow.show();
    controlWindow.focus();
  });

  app.whenReady().then(() => {
    // Ensure cache directory exists now that app is ready
    ensureCacheDir();
    loadAndApplyUserSettings();

    createControlWindow();
    scheduleCommunitySongSync('app startup', 2000);
    scheduleCommunityPeriodicSync({ resetBackoff: true });
    // Don't register shortcuts on startup - only when presentation starts

    // Handle display changes
    screen.on('display-added', () => updateDisplayList());
    screen.on('display-removed', (event, display) => handleDisplayRemoved(display));
    screen.on('display-metrics-changed', () => updateDisplayList());
    powerMonitor.on('suspend', () => {
      cancelGoogleDriveOperations().catch(error => {
        console.error('[GoogleDrive] Could not finish suspend cleanup:', error);
      });
      cancelCommunityTransientOperations().catch(error => {
        console.error('[Community] Could not finish suspend cleanup:', error);
      });
      disableRemoteControl('computer-suspended').catch(error => {
        console.error('[Remote] Could not finish suspend cleanup:', error);
      });
    });
    powerMonitor.on('resume', () => {
      scheduleCommunitySongSync('computer resumed', 1500);
      scheduleCommunityPeriodicSync({ resetBackoff: true });
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
      app.quit();
    }
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createControlWindow();
    }
  });
}

app.on('will-quit', () => {
  cancelGoogleDriveOperations().catch(() => {});
  cancelCommunityTransientOperations().catch(() => {});
  clearRemotePairingTimer();
  try {
    remoteServer?.revokeAll('app-quit');
    remoteServer?.destroy().catch(error => {
      console.error('[Remote] Could not finish app-quit cleanup:', error);
    });
  } catch (error) {
    console.error('[Remote] Could not revoke devices during app quit:', error);
  }
  stopServiceFolderWatchers();
  clearServiceScanProposals();
  approvedServiceFolders.clear();
  approvedDriveConnections.clear();
  googleDriveAccessTokens.clear();
  approvedPresentationPaths.clear();
});
