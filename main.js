const {
  app,
  BrowserWindow,
  ipcMain,
  screen,
  dialog,
  powerMonitor,
  protocol,
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
const {
  configureIsolatedTestUserData
} = require('./src/services/runtime/IsolatedTestUserData');

const SERMON_RECORDING_PLAYBACK_SCHEME = 'syncshow-sermon-media';
if (typeof protocol?.registerSchemesAsPrivileged === 'function') {
  protocol.registerSchemesAsPrivileged([{
    scheme: SERMON_RECORDING_PLAYBACK_SCHEME,
    privileges: {
      secure: true,
      standard: true,
      stream: true
    }
  }]);
}

// Native UI smoke tests must never share the church's normal application
// profile. This override is inert unless the caller supplies both its explicit
// switch and a marked/empty directory confined beneath the OS temporary root.
configureIsolatedTestUserData({ app });

// Node.js PPTX converter (replaces Python)
const {
  Converter,
  serializeConversionFailure
} = require('./src/services/converter');
const { migrateVenueProfile } = require('./src/services/profile');
const {
  bindVerifiedPowerPointServiceSet,
  authorityForVolunteerShowUnlockGrant,
  authorizeVolunteerShowCommand,
  createVolunteerShowUnlockGrant,
  LiveCueTransitionCoordinator,
  LIVE_CUE_TRANSITION_RECEIPT_KIND,
  LIVE_CUE_TRANSITION_SCHEMA_VERSION,
  normalizeCacheRestoreContext,
  OutputHealthTracker,
  applyPlanLinkedPowerPointHandoff,
  derivePlanLinkedPowerPointHandoff,
  normalizeServiceSetClaim,
  RemoteCommandAdapter,
  resolveCacheRestorePlan,
  resolveLaunchPlan,
  resolvePowerPointServiceSetClaim,
  SHOW_REHEARSAL_RECEIPT_KIND,
  SHOW_REHEARSAL_RECEIPT_SCHEMA_VERSION,
  ShowRehearsalReceiptStore,
  normalizeShowRehearsalEvidence,
  samePlanLinkedPowerPointHandoff,
  sameServiceSetClaim,
  resolveNativeCuePayload,
  showRehearsalReceiptMatches
} = require('./src/services/show');
const { BibleLibrary } = require('./src/services/bible');
const {
  CANONICAL_BIBLE_BOOKS
} = require('./src/services/sermon/BibleRange');
const {
  NATIVE_SERMON_MATERIAL_REVIEW_STATEMENT_ID,
  applyNativeSermonMaterialCommit,
  buildNativeSermonMaterialProposal,
  confirmNativeSermonMaterialProposal
} = require('./src/services/sermon/NativeSermonMaterialIntake');
const {
  fsyncDirectory,
  hashFileNoFollow,
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
  MAX_IMAGE_BYTES,
  MAX_VIDEO_BYTES,
  MAX_SERMON_BODY_ENTRY_BYTES,
  MAX_SOURCE_BYTES,
  CurrentShowPackageStore,
  LocalSermonExtractionStore,
  LocalSermonLibrary,
  LocalSermonMediaStore,
  LocalSermonSourceRetention,
  LocalSermonSourceStore,
  LocalServiceSongRightsEvidenceError,
  LocalSongFamilyCommitCoordinator,
  LocalSongFamilyReviewStore,
  LocalSongLibrary,
  MAX_SERMON_RELATIONSHIP_PAGE_SIZE,
  NativeSlideRenderer,
  POWERPOINT_COMPANION_WORKFLOW_MODE,
  ServiceProjectExchange,
  ServiceProjectStore,
  SONG_FAMILY_REVIEW_CONFIRMATION_AUTHORITY_SCOPE,
  SERMON_SCHEMA_VERSION,
  SERMON_SOURCE_EXTRACTOR_ID,
  SERMON_SOURCE_EXTRACTOR_VERSION,
  SermonAttachmentHealthCoordinator,
  SermonProjectCommitCoordinator,
  SermonRecordingPlaybackAuthority,
  SermonSourceExtractionCoordinator,
  ShowPackagePublisher,
  addBibleItem,
  addGroupItem,
  addProjectItem,
  addSermonResource,
  addSongResource,
  attachLocalSermonRecording,
  analyzeServiceProjectReadiness,
  analyzeSermonPostServiceReadiness,
  analyzeSermonPrimaryReading,
  applyCurrentServiceSongFamilyReview,
  applyCanonicalSermonBodyProjection,
  applySermonCueReconciliation,
  applySermonBodyReview,
  applySermonExtractionReview,
  applySermonReferenceReview,
  bindProjectAsPowerPointCompanion,
  bindProjectToServiceSet,
  buildCurrentServiceNativeDraft,
  buildCanonicalSermonBodyProjectionProposal,
  buildServiceRunSheet,
  buildPptxSongDraftInWorker: buildPptxSongDraft,
  buildSermonBodyReviewProposal,
  buildSermonCueReconciliationProposal,
  buildSermonExtractionReviewProposal,
  buildServiceSermonPacketSourcePlan,
  compileServiceProject,
  compareSongTranslations,
  createCurrentServiceSongFamilyReview,
  createDefaultSongChannelVariants,
  createServiceProject,
  createSermonRecordingPlaybackResponse,
  currentServiceSongFamilyReviewSnapshot,
  duplicateProjectItem,
  extractSermonSourceProposal,
  formatBibleRange,
  inspectPptxSongSlidesInWorker: inspectPptxSongSlides,
  isPowerPointCompanionProject,
  isSermonSourceTarget,
  importedSourceMatchesPlan,
  listNativePresets,
  linkSongTranslation,
  moveProjectItem,
  nativeDraftProjectId,
  normalizeServiceHandoff,
  normalizeLocalServiceSongRightsSelection,
  parseSongArrangement,
  placeBibleReadingItemsBefore,
  planSermonPostServiceLinks,
  preparedServiceVenueRevisionId,
  repinCompatibleSermonDocument,
  repinSermonRevision,
  removeProjectItemAndDescendants,
  replaceSongItem,
  requireSermonCueReconciliationAnchor,
  resolveBookId,
  resolveAuthoritativeSongSource,
  resolveSermonSourceLink,
  sermonDocumentSha256,
  serviceSermonPacketSourceDispositions,
  serviceSetFingerprint,
  setSongChannelTreatment,
  setServicePlanStatus,
  setSermonSourceLink,
  updateGroupItem,
  updatePictureChannelAsset,
  updateProjectItemTiming,
  updatePresentationItem,
  updateServicePlanningDetails,
  updateSongArrangement,
  updateTextItem,
  upgradeSermonDocument,
  validateCurrentShowPackageBinding
} = require('./src/services/project');
const {
  MAX_SONG_BATCH_IMPORT_FILES,
  importSongFilesSequentially
} = require('./src/services/project/SongBatchImport');
const { parseSongDocument } = require('./src/services/project/SongDocument');
const {
  CommunityBinaryClient,
  CommunityClient,
  CommunityConnectionStore,
  CommunityServicePlanImportCoordinator,
  CommunitySermonMediaAttemptStore,
  CommunitySermonMediaUpload,
  CommunitySermonSync,
  CommunitySongFamilyImportCoordinator,
  CommunitySongSync,
  CommunitySyncStateStore,
  HeritageServiceDocumentBindingStore,
  HeritageServiceDocumentOutbox,
  HeritageServiceDocumentSync,
  SONG_PUBLIC_LINK_REVIEW_BASES,
  SONG_SHARING_REVIEW_BASES,
  createSongPublicLinkReview,
  createSongSharingReview,
  createHeritageServiceDocument,
  heritageServiceDocumentRevision,
  songFamilyRevision,
  songPublicLinkReviewForRetry,
  songPublicLinkReviewRevision,
  songPublicLinkReviewStatus,
  songSharingReviewRevision,
  songSharingReviewStatus,
  sermonMediaAttemptBindingKey,
  sermonMediaAttemptRecoveryLocator,
  serializeHeritageServiceDocument,
  verifyDeployedCommunitySermonPublication
} = require('./src/services/community');

const SERVICE_SCAN_MAX_DEPTH = 2;
const SERVICE_SCAN_MAX_ENTRIES = 5000;
const SERVICE_SCAN_MAX_FILES = 1000;
const SERVICE_SCAN_PROPOSAL_LIMIT = 5;
const SERVICE_SCAN_PROPOSAL_TTL_MS = 15 * 60 * 1000;
const SERMON_EXTRACTION_PROPOSAL_LIMIT = 12;
const SERMON_EXTRACTION_PROPOSAL_TTL_MS = 15 * 60 * 1000;
const SERMON_BODY_REVIEW_PROPOSAL_LIMIT = 6;
const SERMON_BODY_REVIEW_PROPOSAL_TTL_MS = 15 * 60 * 1000;
const SERMON_REFERENCE_REVIEW_PROPOSAL_LIMIT = 12;
const SERMON_REFERENCE_REVIEW_PROPOSAL_TTL_MS = 15 * 60 * 1000;
const SERMON_CUE_RECONCILIATION_PROPOSAL_LIMIT = 8;
const SERMON_CUE_RECONCILIATION_PROPOSAL_TTL_MS = 15 * 60 * 1000;
const CANONICAL_SERMON_BODY_PROJECTION_PROPOSAL_LIMIT = 8;
const CANONICAL_SERMON_BODY_PROJECTION_PROPOSAL_TTL_MS = 15 * 60 * 1000;
const SERVICE_SERMON_PACKET_PROPOSAL_LIMIT = 8;
const SERVICE_SERMON_PACKET_PROPOSAL_TTL_MS = 15 * 60 * 1000;
const LINKED_SERVICE_SERMON_SOURCE_PROPOSAL_LIMIT = 8;
const LINKED_SERVICE_SERMON_SOURCE_PROPOSAL_TTL_MS = 15 * 60 * 1000;
const CURRENT_SERVICE_COMPANION_INSPECTION_LIMIT = 12;
const CURRENT_SERVICE_COMPANION_INSPECTION_TTL_MS = 15 * 60 * 1000;
const CURRENT_SERVICE_NATIVE_DRAFT_REVIEW_LIMIT = 4;
const CURRENT_SERVICE_NATIVE_DRAFT_REVIEW_TTL_MS = 15 * 60 * 1000;
const CURRENT_SERVICE_SONG_RANGE_REVIEW_LIMIT = 8;
const CURRENT_SERVICE_SONG_RANGE_REVIEW_TTL_MS = 15 * 60 * 1000;
const CURRENT_SERVICE_SONG_RANGE_PROPOSAL_LIMIT = 8;
const CURRENT_SERVICE_SONG_RANGE_PROPOSAL_TTL_MS = 15 * 60 * 1000;
const PLAN_LINKED_POWERPOINT_HANDOFF_LIMIT = 12;
const PLAN_LINKED_POWERPOINT_HANDOFF_TTL_MS = 15 * 60 * 1000;
const POST_SHOW_POWERPOINT_RECEIPT_LIMIT = 12;
const POST_SHOW_POWERPOINT_RECEIPT_TTL_MS = 15 * 60 * 1000;
const CURRENT_SERVICE_SONG_DRAFT_PROPOSAL_LIMIT = 12;
const CURRENT_SERVICE_SONG_DRAFT_PROPOSAL_TTL_MS = 15 * 60 * 1000;
const CURRENT_SERVICE_SONG_FAMILY_REVIEW_LIMIT = 12;
const CURRENT_SERVICE_SONG_FAMILY_REVIEW_TTL_MS = 15 * 60 * 1000;
const CURRENT_SERVICE_SONG_DRAFT_MAX_SOURCE_BYTES = 128 * 1024 * 1024;
const CURRENT_SERVICE_SONG_DRAFT_MAX_INSPECTION_SLIDES = 1000;
const CURRENT_SERVICE_SONG_DRAFT_MAX_SLIDES = 200;
const CURRENT_SERVICE_SONG_DRAFT_MAX_PREVIEW_CHARS = 32_000;
const CURRENT_SERVICE_SONG_DRAFT_MAX_CANDIDATES = 256;
const SONG_SHARING_REVIEW_PROPOSAL_LIMIT = 12;
const SONG_SHARING_REVIEW_PROPOSAL_TTL_MS = 15 * 60 * 1000;
const SONG_PUBLIC_LINK_REVIEW_PROPOSAL_LIMIT = 12;
const SONG_PUBLIC_LINK_REVIEW_PROPOSAL_TTL_MS = 15 * 60 * 1000;
const SONG_PUBLIC_LINK_ACTION_LIMIT = 256;
const SONG_PUBLIC_LINK_ACTION_TTL_MS = 15 * 60 * 1000;
const COMMUNITY_SERVICE_PLAN_REVIEW_LIMIT = 12;
const COMMUNITY_SERVICE_PLAN_REVIEW_TTL_MS = 15 * 60 * 1000;
const COMMUNITY_SERVICE_PLAN_REPLACEMENT_LIMIT = 12;
const COMMUNITY_SERVICE_PLAN_REPLACEMENT_TTL_MS = 15 * 60 * 1000;
const COMMUNITY_SERVICE_PLAN_PREPARATION_LIMIT = 12;
const COMMUNITY_SERVICE_PLAN_PREPARATION_TTL_MS = 15 * 60 * 1000;
const COMMUNITY_SERVICE_PLAN_PREPARATION_MAX_ITEMS = 100;
const COMMUNITY_SERVICE_PLAN_STALE_PIN_LIMIT = 12;
const COMMUNITY_SERVICE_PLAN_STALE_PIN_TTL_MS = 60 * 60 * 1000;
const SERVICE_WATCH_DIRECTORY_LIMIT = 128;
const SERVICE_WATCH_DEBOUNCE_MS = 750;
const APPROVED_SERVICE_FOLDER_LIMIT = 8;
const APPROVED_DRIVE_CONNECTION_LIMIT = 16;
const APPROVED_PRESENTATION_PATH_LIMIT = 256;
const REMOTE_THUMBNAIL_MAX_BYTES = 2 * 1024 * 1024;
const SHOW_REHEARSAL_RENDERED_SLIDE_MAX_BYTES = 128 * 1024 * 1024;
const PREPARE_MAX_EMPHASIS_SPANS = 256;
const SERMON_CONFLICT_MEDIA_LIMIT = 32;
const sermonConflictUrlProjectionKey = crypto.randomBytes(32);
const PREPARE_GOLD_EMPHASIS_FOREGROUND = '#ffc000';

// Keep a live overlay readable on ordinary venue screens. Longer passages can
// be sent as consecutive ranges until multi-page Bible overlays land.
const bibleLibrary = new BibleLibrary({ maxVerses: 8 });
// Sermon primary references are metadata, not one projected screen. Keep their
// larger review preview on a separate resolver so no live or service Bible cue
// can inherit this limit accidentally.
const sermonReferenceBibleLibrary = new BibleLibrary({ maxVerses: 100 });
const sermonAttachmentHealthCoordinator = new SermonAttachmentHealthCoordinator();
const sermonRecordingHealthCoordinator = new SermonAttachmentHealthCoordinator();
const sermonSourceExtractionCoordinator = new SermonSourceExtractionCoordinator();
const sermonExtractionProposalCoordinator = new SermonSourceExtractionCoordinator({
  maxPendingDistinct: 8
});

// Keep references to prevent garbage collection
let controlWindow = null;
let controlSettingsDraftState = { dirty: false, saving: false };
let outputWindows = new Map();
let outputSessionId = 0;
let outputLifecyclePhase = 'idle';
let displayStartInProgress = false;
let outputsShouldBeVisible = false;
let activeShowControlMode = 'full';
let activeVolunteerShowBinding = null;
let activeVolunteerShowUnlockGrant = null;
let volunteerShowUnlockTimer = null;
let volunteerRelockPublishScheduled = false;
let activeShowRehearsalState = Object.freeze({
  status: 'idle',
  currentCue: 0,
  totalCues: 0,
  persisted: false,
  reused: false
});
let showRehearsalReceiptStore = null;
let outputPreviewTimer = null;
let outputPreviewSubscriptions = new Set();
let liveCueTransitionCoordinator = null;
let activeLiveCueNavigation = null;
let outputRestoreGuardSequence = 0;
let activeBibleOverlay = null;
let pendingBibleOverlay = null;
let pendingBibleLookup = null;
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
const sermonExtractionProposals = new Map();
const sermonBodyReviewProposals = new Map();
const sermonReferenceReviewProposals = new Map();
const sermonCueReconciliationProposals = new Map();
const canonicalSermonBodyProjectionProposals = new Map();
const serviceSermonPacketProposals = new Map();
const linkedServiceSermonSourceProposals = new Map();
const currentServiceCompanionInspections = new Map();
const currentServiceNativeDraftReviews = new Map();
const currentServiceSongRangeReviews = new Map();
const currentServiceSongRangeProposals = new Map();
const planLinkedPowerPointHandoffs = new Map();
const postShowPowerPointServiceReceipts = new Map();
let activePowerPointShowReceipt = null;
let presentationMutationInProgress = false;
const currentServiceSongDraftProposals = new Map();
const currentServiceSongFamilyReviews = new Map();
const songSharingReviewProposals = new Map();
const songPublicLinkReviewProposals = new Map();
const songPublicLinkActions = new Map();
const communityServicePlanReviews = new Map();
const communityServicePlanReplacements = new Map();
const communityServicePlanPreparations = new Map();
const communityServicePlanStalePins = new Map();
const communitySermonPublicationVersions = new Map();
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
let localSongFamilyReviewStore = null;
let localSongFamilyCommitCoordinator = null;
let communitySongFamilyImportCoordinator = null;
const localSongFamilyRecoveryAuthority =
  Symbol('syncshow-local-song-family-recovery');
let localSermonExtractionStore = null;
let localSermonLibrary = null;
let localSermonMediaStore = null;
let communitySermonMediaAttemptStore = null;
const sermonRecordingPlaybackAuthority =
  new SermonRecordingPlaybackAuthority();
let sermonRecordingPlaybackProtocolReady = false;
let sermonRecordingPlayer = null;
let sermonRecordingPlaybackEpoch = 0;
let sermonRecordingPlaybackAbortController = null;
let sermonRecordingPlaybackVerificationTail = Promise.resolve();
let localSermonSourceRetention = null;
let localSermonSourceStore = null;
let serviceProjectStore = null;
let sermonProjectCommitCoordinator = null;
let serviceProjectExchange = null;
let showPackagePublisher = null;
let currentShowPackageStore = null;
let communityServicesPromise = null;
let communityOperationQueue = Promise.resolve();
let communityOperationEpoch = 0;
let communitySyncAbortController = null;
let activeCommunityServicePlanPreparation = null;
let communityAuthAbortController = null;
let communitySyncTimer = null;
let communityPeriodicSyncTimer = null;
let communityPeriodicSyncGeneration = 0;
let communityPeriodicSyncFailures = 0;
let communityLastSyncSummary = null;
let communityLastSermonSyncSummary = null;
let communityReconnectRequired = null;
let communityConnectionWarning = null;
let communityCapabilityWarning = null;
const communitySermonMediaUploads = new Map();
let sermonSourceRetentionStartup = Object.freeze({
  status: 'not-checked',
  deletedObjectCount: 0,
  deletedBytes: 0
});
const pendingCommunityAuthorizations = new Map();
const COMMUNITY_PERIODIC_SYNC_BASE_MS = 5 * 60 * 1000;
const COMMUNITY_PERIODIC_SYNC_MAX_MS = 30 * 60 * 1000;
const COMMUNITY_SERMON_PUBLICATION_VERSION_LIMIT = 1000;

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

function clearSermonExtractionProposals() {
  sermonExtractionProposals.clear();
}

function clearSermonBodyReviewProposals() {
  sermonBodyReviewProposals.clear();
}

function clearSermonCueReconciliationProposals() {
  sermonCueReconciliationProposals.clear();
}

function clearCanonicalSermonBodyProjectionProposals() {
  canonicalSermonBodyProjectionProposals.clear();
}

function clearServiceSermonPacketProposals() {
  serviceSermonPacketProposals.clear();
  linkedServiceSermonSourceProposals.clear();
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

function getShowRehearsalReceiptStore() {
  if (!showRehearsalReceiptStore) {
    showRehearsalReceiptStore = new ShowRehearsalReceiptStore({
      rootPath: path.join(app.getPath('userData'), 'show-readiness')
    });
  }
  return showRehearsalReceiptStore;
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
let activeVideoPlayback = null;
let presentationRevision = 0;
let preparePublishGeneration = 0;
let currentPreparedServicePointer = null;
let currentPreparedServiceRestore = Object.freeze({
  status: 'none',
  projectId: null,
  serviceDate: null,
  activatedAt: null
});

function requireNoActiveShowForPresentationMutation() {
  if (!appState.activeLaunchPlan) return;
  failMainOperation(
    'SHOW_CONTENT_LOCKED',
    'End the current Show before loading, clearing, or replacing presentation content.'
  );
}

function beginPresentationMutation() {
  requireNoActiveShowForPresentationMutation();
  if (presentationMutationInProgress) {
    failMainOperation(
      'PRESENTATION_MUTATION_BUSY',
      'Another presentation is still being loaded. Wait for it to finish before replacing Load.'
    );
  }
  presentationMutationInProgress = true;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    presentationMutationInProgress = false;
  };
}

function installPresentation(roleId, presentation) {
  const createsEmptyRole = presentation === null
    && !Object.prototype.hasOwnProperty.call(appState.presentations, roleId);
  if (!createsEmptyRole) requireNoActiveShowForPresentationMutation();
  appState.presentations[roleId] = presentation;
  presentationRevision += 1;
}

function enabledPresentationRoleIds(profile = activeVenueProfile) {
  return (profile?.inputRoles || [])
    .filter(role => role.enabled && role.kind === 'deck')
    .map(role => role.id)
    .sort();
}

function installPreparedPresentations(presentations, roleIds) {
  requireNoActiveShowForPresentationMutation();
  const nextPresentations = {};
  for (const roleId of roleIds) {
    nextPresentations[roleId] = presentations[roleId];
  }
  appState.presentations = nextPresentations;
  presentationRevision += 1;
}

function clearInstalledPreparedPresentations() {
  const entries = Object.entries(appState.presentations);
  const retained = entries.filter(([, presentation]) =>
    presentation?.renderer !== 'native-cue');
  if (retained.length === entries.length) return false;
  requireNoActiveShowForPresentationMutation();
  appState.presentations = Object.fromEntries(retained);
  presentationRevision += 1;
  return true;
}

function setCurrentPreparedServiceRestore(status, pointer = null) {
  currentPreparedServiceRestore = Object.freeze({
    status,
    projectId: pointer?.projectId || null,
    serviceDate: pointer?.serviceDate || null,
    activatedAt: pointer?.activatedAt || null
  });
}

function normalizedPresentationHandoff(presentation) {
  if (
    presentation?.renderer !== 'native-cue'
    || !presentation.serviceHandoff
  ) {
    return null;
  }
  try {
    const handoff = normalizeServiceHandoff(presentation.serviceHandoff);
    return handoff.cueIds.length === presentation.slideCount ? handoff : null;
  } catch (error) {
    console.warn('[ServiceHandoff] Ignoring an invalid installed handoff:', error.message);
    return null;
  }
}

function installedServiceHandoff() {
  const nativePresentations = (activeVenueProfile?.inputRoles || [])
    .filter(role => role.kind === 'deck')
    .map(role => appState.presentations[role.id])
    .filter(presentation => presentation?.renderer === 'native-cue');
  if (nativePresentations.length === 0) return null;

  const handoffs = nativePresentations.map(normalizedPresentationHandoff);
  if (handoffs.some(handoff => !handoff)) return null;
  const canonical = JSON.stringify(handoffs[0]);
  if (handoffs.some(handoff => JSON.stringify(handoff) !== canonical)) {
    console.warn('[ServiceHandoff] Installed native presentations do not share one exact handoff.');
    return null;
  }
  return handoffs[0];
}

function rendererSafeText(value, maximum, { multiline = false } = {}) {
  if (
    typeof value !== 'string'
    || value.length > maximum
    || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value)
    || (!multiline && /[\r\n\t]/u.test(value))
  ) {
    return '';
  }
  return value;
}

function rendererSlideSemantics(
  presentation,
  index,
  handoff = normalizedPresentationHandoff(presentation)
) {
  const metadata = presentation?.metadata?.slides?.[index] || {};
  const metadataCueId = rendererSafeText(metadata.cueId, 128);
  const cue = metadataCueId && handoff?.cues?.[metadataCueId]
    ? handoff.cues[metadataCueId]
    : null;
  const groupPath = Array.isArray(cue?.groupPath || metadata.groupPath)
    ? (cue?.groupPath || metadata.groupPath)
      .slice(0, 16)
      .map(value => rendererSafeText(value, 300))
      .filter(Boolean)
    : [];
  return {
    cueId: rendererSafeText(cue?.id || metadata.cueId, 128),
    title: rendererSafeText(cue?.title || metadata.title, 300),
    kind: rendererSafeText(cue?.kind || metadata.kind, 40),
    groupPath,
    operatorNotes: rendererSafeText(cue?.operatorNotes || '', 4000, {
      multiline: true
    })
  };
}

function stableJsonValue(value) {
  if (Array.isArray(value)) return value.map(stableJsonValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map(key => [key, stableJsonValue(value[key])])
  );
}

function sha256Json(value) {
  return crypto
    .createHash('sha256')
    .update(JSON.stringify(stableJsonValue(value)))
    .digest('hex');
}

function rehearsalDisplayIdentity(displayId) {
  const descriptor = appState.displays.find(
    display => String(display.id) === String(displayId)
  );
  return `display-${sha256Json({
    id: String(displayId),
    fingerprint: descriptor?.fingerprint || null
  })}`;
}

function normalizeStartRenderingSettings(settings = {}) {
  return Object.freeze({
    fadeDuration: Number.isFinite(settings.fadeDuration)
      ? Math.max(0, Math.min(5000, settings.fadeDuration))
      : 300,
    syncMode: Boolean(settings.syncMode),
    singerFontSize: Number.isFinite(settings.singerFontSize)
      ? Math.max(12, Math.min(240, settings.singerFontSize))
      : 36,
    singerCharLimit: Number.isFinite(settings.singerCharLimit)
      ? Math.max(10, Math.min(500, settings.singerCharLimit))
      : 70,
    singerTextPadding: Number.isFinite(settings.singerTextPadding)
      ? Math.max(0, Math.min(80, settings.singerTextPadding))
      : 4
  });
}

function currentStartRenderingSettings() {
  return {
    fadeDuration: appState.fadeDuration,
    syncMode: appState.syncMode,
    singerFontSize: appState.singerFontSize,
    singerCharLimit: appState.singerCharLimit,
    singerTextPadding: appState.singerTextPadding
  };
}

function sameStartRenderingSettings(expected) {
  return sha256Json(currentStartRenderingSettings()) === sha256Json(expected);
}

function rehearsalVenueRevisionId(renderingSettings) {
  return sha256Json({
    profile: activeVenueProfile,
    syncShowVersion: app.getVersion(),
    renderingSettings
  });
}

function rehearsalServiceSetFingerprint(manifest) {
  // The sermon-packet fingerprint intentionally accepts only dated PPTX
  // packets. Rehearsal evidence covers the broader, already-validated
  // ServiceSet contract, including .ppt inputs and undated sets, and hashes
  // the entire exact manifest so no valid field is silently omitted.
  return sha256Json({
    contract: 'syncshow-rehearsal-service-set-v1',
    manifest
  });
}

function rehearsalDecision(output, decisions) {
  if (output.nativeVariant === 'singer-current-next'
    || output.renderer === 'singer-current-next') {
    return 'derive-next-text';
  }
  return decisions?.[output.id]?.mode === 'mirror'
    ? 'mirror'
    : 'direct';
}

function rehearsalRouting(launchPlan, decisions, sourceAssets) {
  return launchPlan.outputs.map(output => ({
    outputId: output.id,
    displayId: rehearsalDisplayIdentity(output.displayId),
    decision: rehearsalDecision(output, decisions),
    sourceRoleId: output.sourceRoleId,
    sourceAssetId: sourceAssets.get(output.sourceRoleId),
    renderer: output.renderer,
    nativeVariant: output.nativeVariant || null,
    operatorPreview: output.operatorPreview === true
  }));
}

function showPackageRehearsalEvidence(
  preparedService,
  launchPlan,
  decisions,
  renderingSettings
) {
  const opened = preparedService?.opened;
  const manifest = opened?.manifest;
  if (!manifest || !opened?.manifestSha256) return null;

  const sourceAssets = new Map();
  const channelAssets = manifest.channels.map(channel => {
    const assetId = `channel-${channel.roleId}`;
    sourceAssets.set(channel.roleId, assetId);
    const prefix = `${channel.directory}/`;
    const artifacts = manifest.artifacts
      .filter(artifact => artifact.path.startsWith(prefix))
      .map(artifact => ({
        path: artifact.path,
        sha256: artifact.sha256,
        size: artifact.size
      }));
    return {
      assetId,
      revisionId: sha256Json({
        roleId: channel.roleId,
        renderer: channel.renderer,
        artifacts
      })
    };
  });
  const assets = [...channelAssets];
  if (manifest.assets.length > 0) {
    assets.push({
      assetId: 'show-pictures',
      revisionId: sha256Json(
        manifest.assets.map(asset => ({
          id: asset.id,
          sha256: asset.sha256,
          size: asset.size
        }))
      )
    });
  }

  return normalizeShowRehearsalEvidence({
    show: {
      kind: 'show-package',
      packageId: manifest.id,
      manifestRevisionId: opened.manifestSha256,
      assets
    },
    venueProfile: {
      id: activeVenueProfile.id,
      revisionId: rehearsalVenueRevisionId(renderingSettings)
    },
    routing: rehearsalRouting(
      launchPlan,
      decisions,
      sourceAssets
    ),
    cueCount: manifest.cueCount,
    cueIds: [...manifest.cueIds]
  });
}

function powerPointRehearsalCueIds(
  launchPlan,
  sourceAssets,
  presentationsByRole
) {
  const roles = [...new Set(
    launchPlan.outputs.map(output => output.sourceRoleId)
  )].sort();
  return Array.from(
    { length: launchPlan.totalSlides },
    (_value, index) =>
      `cue-${index + 1}-${sha256Json({
        index,
        roles: roles.map(roleId => {
          const slide = presentationsByRole
            .get(roleId)?.metadata?.slides?.[index] || {};
          return {
            roleId,
            sourceAssetId: sourceAssets.get(roleId),
            firstLine: slide.firstLine || '',
            text: slide.text || '',
            title: slide.title || ''
          };
        })
      }).slice(0, 20)}`
  );
}

async function renderedPowerPointGenerationRevision(
  roleId,
  presentation,
  sourceRevisionId
) {
  if (
    !presentation
    || typeof presentation.cacheDir !== 'string'
    || path.resolve(presentation.cacheDir)
      !== path.resolve(path.join(CONFIG.cacheDir, roleId))
    || !Number.isSafeInteger(presentation.slideCount)
    || presentation.slideCount < 1
    || presentation.slideCount > 2000
  ) {
    return null;
  }

  const slideImages = [];
  try {
    for (let index = 1; index <= presentation.slideCount; index += 1) {
      const fileName = `slide_${String(index).padStart(3, '0')}.jpg`;
      slideImages.push({
        index,
        sha256: await hashFileNoFollow(
          path.join(presentation.cacheDir, fileName),
          SHOW_REHEARSAL_RENDERED_SLIDE_MAX_BYTES
        )
      });
    }
  } catch (error) {
    console.warn(
      `[ShowRehearsal] Could not bind rendered ${roleId} slides:`,
      error?.code || error?.message || 'rendered-generation-unavailable'
    );
    return null;
  }

  return sha256Json({
    contract: 'syncshow-rendered-powerpoint-v1',
    roleId,
    sourceRevisionId,
    slideCount: presentation.slideCount,
    pdfRenderer: presentation.metadata?.pdfRenderer || null,
    // Singer-current-next derives its next line from conversion metadata
    // rather than JPG pixels. Bind the full ordered slide metadata so a
    // firstLine/text change (or a future derivation input) cannot reuse an
    // older all-cue rehearsal receipt.
    slideMetadataRevisionId: sha256Json(
      presentation.metadata?.slides || []
    ),
    slideImages
  });
}

async function serviceSetRehearsalEvidence(
  launchPlan,
  decisions,
  renderingSettings
) {
  const roleIds = [...new Set(
    launchPlan.outputs.map(output => output.sourceRoleId)
  )];
  const capturedPresentationRevision = presentationRevision;
  const presentationsByRole = new Map();
  const contextsByRole = new Map();
  try {
    for (const roleId of roleIds) {
      const presentation = appState.presentations[roleId];
      const context = normalizeCacheRestoreContext(
        presentation?.metadata?.restoreContext,
        { allowNull: false }
      );
      if (
        context.sourceKind !== 'service-set'
        || context.roleId !== roleId
      ) {
        return null;
      }
      presentationsByRole.set(roleId, presentation);
      contextsByRole.set(roleId, context);
    }
  } catch (_error) {
    return null;
  }
  if (new Set(
    [...contextsByRole.values()].map(context => context.serviceSetId)
  ).size !== 1) {
    return null;
  }

  const manifest = await readCurrentServiceSet(
    getServiceSetRoot(),
    { verifyAssets: true }
  );
  const firstContext = contextsByRole.get(roleIds[0]);
  if (
    !manifest
    || manifest.id !== firstContext.serviceSetId
    || presentationRevision !== capturedPresentationRevision
    || roleIds.some(
      roleId => appState.presentations[roleId] !== presentationsByRole.get(roleId)
    )
  ) {
    return null;
  }

  const sourceAssets = new Map();
  const renderedRevisions = new Map();
  for (const roleId of roleIds) {
    const input = manifest.inputs?.[roleId];
    const context = contextsByRole.get(roleId);
    if (
      !input
      || input.assetId !== context.assetId
      || typeof input.sha256 !== 'string'
    ) {
      return null;
    }
    const renderedRevisionId = await renderedPowerPointGenerationRevision(
      roleId,
      presentationsByRole.get(roleId),
      input.sha256
    );
    if (
      !renderedRevisionId
      || presentationRevision !== capturedPresentationRevision
      || appState.presentations[roleId] !== presentationsByRole.get(roleId)
    ) {
      return null;
    }
    sourceAssets.set(roleId, input.assetId);
    renderedRevisions.set(roleId, renderedRevisionId);
  }

  const assetEvidence = new Map();
  for (const [roleId, input] of Object.entries(manifest.inputs)) {
    const current = assetEvidence.get(input.assetId) || {
      sourceRevisionId: input.sha256,
      renderedRoles: []
    };
    if (renderedRevisions.has(roleId)) {
      current.renderedRoles.push({
        roleId,
        revisionId: renderedRevisions.get(roleId)
      });
    }
    assetEvidence.set(input.assetId, current);
  }
  const assets = [...assetEvidence.entries()].map(([assetId, evidence]) => ({
    assetId,
    revisionId: sha256Json({
      sourceRevisionId: evidence.sourceRevisionId,
      renderedRoles: evidence.renderedRoles.sort((left, right) =>
        left.roleId.localeCompare(right.roleId, 'en'))
    })
  }));
  return normalizeShowRehearsalEvidence({
    show: {
      kind: 'service-set',
      serviceSetId: manifest.id,
      fingerprint: rehearsalServiceSetFingerprint(manifest),
      assets
    },
    venueProfile: {
      id: activeVenueProfile.id,
      revisionId: rehearsalVenueRevisionId(renderingSettings)
    },
    routing: rehearsalRouting(
      launchPlan,
      decisions,
      sourceAssets
    ),
    cueCount: launchPlan.totalSlides,
    cueIds: powerPointRehearsalCueIds(
      launchPlan,
      sourceAssets,
      presentationsByRole
    )
  });
}

async function showRehearsalEvidenceForStart({
  preparedService,
  launchPlan,
  decisions,
  renderingSettings
}) {
  if (preparedService) {
    return showPackageRehearsalEvidence(
      preparedService,
      launchPlan,
      decisions,
      renderingSettings
    );
  }
  return serviceSetRehearsalEvidence(
    launchPlan,
    decisions,
    renderingSettings
  );
}

function sameShowRehearsalEvidence(left, right) {
  if (left === null || right === null) return left === right;
  return sha256Json(left) === sha256Json(right);
}

function samePreparedServiceVerification(left, right) {
  if (!left || !right) return left === right;
  return left.opened?.manifestSha256 === right.opened?.manifestSha256
    && sha256Json(left.binding) === sha256Json(right.binding);
}

async function matchingSavedRehearsalReceipt(evidence) {
  if (!evidence) return null;
  try {
    const receipt = await getShowRehearsalReceiptStore().read();
    return receipt && showRehearsalReceiptMatches(receipt, evidence)
      ? receipt
      : null;
  } catch (error) {
    if (error?.code === 'SHOW_REHEARSAL_RECEIPT_STORE_CORRUPT') {
      console.warn(
        '[ShowRehearsal] Saved evidence was corrupt; every cue will be rehearsed again.'
      );
      return null;
    }
    failMainOperation(
      error?.code || 'SHOW_REHEARSAL_RECEIPT_UNAVAILABLE',
      'SyncShow could not inspect the private volunteer-readiness receipt safely.',
      { causeCode: error?.code || null }
    );
  }
}

function setActiveShowRehearsalState(next) {
  activeShowRehearsalState = Object.freeze({
    status: next.status,
    currentCue: Number.isInteger(next.currentCue) ? next.currentCue : 0,
    totalCues: Number.isInteger(next.totalCues) ? next.totalCues : 0,
    persisted: next.persisted === true,
    reused: next.reused === true
  });
  if (controlWindow && !controlWindow.isDestroyed()) {
    controlWindow.webContents.send(
      'show:rehearsalProgress',
      activeShowRehearsalState
    );
  }
  return activeShowRehearsalState;
}

function volunteerShowFingerprint(launchPlan) {
  return sha256Json({
    timelineRoleId: launchPlan.timelineRoleId,
    totalSlides: launchPlan.totalSlides,
    outputs: launchPlan.outputs.map(output => ({
      id: output.id,
      displayId: output.displayId,
      renderer: output.renderer,
      nativeVariant: output.nativeVariant || null,
      sourceRoleId: output.sourceRoleId
    })),
    presentations: [...new Set(
      launchPlan.outputs.map(output => output.sourceRoleId)
    )].sort().map(roleId => {
      const presentation = appState.presentations[roleId] || {};
      return {
        roleId,
        showPackageId: presentation.showPackageId || null,
        projectRevisionId: presentation.projectRevisionId || null,
        slideCount: presentation.slideCount || 0,
        restoreContext: presentation.metadata?.restoreContext || null,
        slides: (presentation.metadata?.slides || []).map((slide, index) => ({
          cueId: slide?.cueId || `cue-${index + 1}`,
          text: slide?.text || slide?.firstLine || ''
        }))
      };
    })
  });
}

function createActiveVolunteerShowBinding(launchPlan, publicOutputSessionId) {
  const showFingerprint = volunteerShowFingerprint(launchPlan);
  const packageIds = [...new Set(
    launchPlan.outputs
      .map(output => appState.presentations[output.sourceRoleId]?.showPackageId)
      .filter(Boolean)
  )];
  return Object.freeze({
    showId: packageIds.length === 1
      ? packageIds[0]
      : `show-${showFingerprint}`,
    showFingerprint,
    venueProfileId: activeVenueProfile?.id || 'default',
    venueFingerprint: sha256Json(activeVenueProfile || {}),
    outputSessionId: publicOutputSessionId
  });
}

function clearVolunteerShowUnlockTimer() {
  if (volunteerShowUnlockTimer) clearTimeout(volunteerShowUnlockTimer);
  volunteerShowUnlockTimer = null;
}

function scheduleVolunteerRelockStatePublish() {
  if (volunteerRelockPublishScheduled) return;
  volunteerRelockPublishScheduled = true;
  queueMicrotask(() => {
    volunteerRelockPublishScheduled = false;
    if (!appState.activeLaunchPlan || activeVolunteerShowUnlockGrant) return;
    publishShowState('volunteer-controls-relocked');
  });
}

function relockVolunteerShowControls({ deferPublish = false } = {}) {
  const changed = Boolean(activeVolunteerShowUnlockGrant);
  clearVolunteerShowUnlockTimer();
  activeVolunteerShowUnlockGrant = null;

  // Relocking revokes the short-lived pairing invitation synchronously. It
  // deliberately leaves already-paired Remote devices alone; only an
  // unredeemed privilege minted during this local unlock is cancelled.
  if (changed) closeRemotePairing();

  if (changed && deferPublish) scheduleVolunteerRelockStatePublish();
  return changed;
}

function currentVolunteerShowUnlockGrant(now = Date.now()) {
  const grant = activeVolunteerShowUnlockGrant;
  if (!grant) return null;
  if (now >= Date.parse(grant.expiresAt)) {
    relockVolunteerShowControls({ deferPublish: true });
    return null;
  }
  return grant;
}

function volunteerShowOperatorState() {
  const grant = currentVolunteerShowUnlockGrant();
  const navigationPending =
    activeLiveCueNavigation !== null
    || liveCueTransitionCoordinator?.isPending() === true;
  const cueBlocked = navigationPending
    || pendingBibleLookup !== null
    || pendingBibleOverlay !== null
    || activeBibleOverlay !== null;
  return {
    mode: activeShowControlMode,
    authority: grant ? 'unlocked' : 'locked',
    unlockExpiresAt: grant?.expiresAt || null,
    rehearsal: activeShowRehearsalState,
    controls: {
      canPrevious:
        !cueBlocked && localShowCommandAllowed('cue.previous'),
      canNext:
        !cueBlocked && localShowCommandAllowed('cue.next'),
      canJump:
        !cueBlocked && localShowCommandAllowed('cue.jump'),
      canRestore:
        !navigationPending
        && pendingBibleLookup === null
        && localShowCommandAllowed('output.restore'),
      canClear: localShowCommandAllowed('output.clear'),
      canStop: localShowCommandAllowed('output.stop'),
      canEndSession: localShowCommandAllowed('session.end'),
      canShowBible:
        !navigationPending
        && pendingBibleLookup === null
        && pendingBibleOverlay === null
        && localShowCommandAllowed('bible.show'),
      canManageRemote: localShowCommandAllowed('remote.manage')
    }
  };
}

function authorizeActiveShowCommand(source, type) {
  const grant = source === 'local'
    ? currentVolunteerShowUnlockGrant()
    : null;
  const authority = grant
    ? authorityForVolunteerShowUnlockGrant(grant)
    : { state: 'locked' };
  try {
    const result = authorizeVolunteerShowCommand({
      mode: activeShowControlMode,
      source,
      type,
      authority,
      ...(grant && activeVolunteerShowBinding
        ? {
            binding: activeVolunteerShowBinding,
            unlockGrant: grant,
            now: Date.now()
          }
        : {})
    });
    if (
      activeShowControlMode === 'volunteer'
      && authority.state === 'locked'
      && outputLifecyclePhase === 'cleared'
      && type === 'cue.next'
    ) {
      failMainOperation(
        'VOLUNTEER_OUTPUTS_CLEARED',
        'Outputs are black. Unlock operator controls before returning to the Show.'
      );
    }
    return result;
  } catch (error) {
    if (error?.code) {
      failMainOperation(error.code, error.message, error.details || {});
    }
    throw error;
  }
}

function authorizeLocalShowCommand(type) {
  return authorizeActiveShowCommand('local', type);
}

function localShowCommandAllowed(type) {
  try {
    authorizeLocalShowCommand(type);
    return true;
  } catch (_error) {
    return false;
  }
}

function authorizeRemoteShowCommand(type) {
  return authorizeActiveShowCommand('remote', type);
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
  const biblePhase = pendingBibleLookup || pendingBibleOverlay
    ? 'preparing'
    : activeBibleOverlay
      ? 'live'
      : 'idle';
  const targetOutputIds = pendingBibleLookup?.targetOutputIds
    || pendingBibleOverlay?.targetOutputIds
    || activeBibleOverlay?.targetOutputIds
    || [];

  return {
    hasActiveShow,
    navigationPending: activeLiveCueNavigation !== null
      || liveCueTransitionCoordinator?.isPending() === true,
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
          else if (available && outputLifecyclePhase === 'cleared' && visible) status = 'cleared';
          else if (available && !visible) status = 'hidden';
          else if (available && outputLifecyclePhase === 'locally-stopped') status = 'unavailable';
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
    operator: volunteerShowOperatorState(),
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

async function restoreOutputsForRemote() {
  if (pendingBibleLookup) {
    return {
      accepted: false,
      code: 'BIBLE_OVERLAY_ACTIVE',
      message: 'Wait for the Bible passage request to finish before restoring the Show.'
    };
  }
  if (activeBibleOverlay || pendingBibleOverlay) {
    hideBibleOverlay({ restore: true });
    return { accepted: true };
  }
  return await showAllDisplays();
}

liveCueTransitionCoordinator = new LiveCueTransitionCoordinator();

showGateway = new RemoteCommandAdapter({
  readRuntimeState: readShowRuntimeState,
  readShowPolicyState: () => ({ mode: activeShowControlMode }),
  authorizeShowCommand: request =>
    authorizeRemoteShowCommand(request.type),
  readCueCatalog: () => appState.activeLaunchPlan
    ? Array.from({ length: appState.totalSlides }, (_value, index) => buildShowCue(index))
    : [],
  readCueThumbnail: readActiveCueThumbnail,
  commands: {
    previous: () => navigateSlideConfirmed(-1),
    next: () => navigateSlideConfirmed(1),
    jump: index => goToSlideConfirmed(index),
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
  return {
    snapshotHash: snapshot.snapshotHash,
    binding: snapshot.binding,
    extraction: snapshot.extraction
  };
}

function closeRemotePairing({ preserveExpired = false } = {}) {
  remotePairingGeneration += 1;
  clearRemotePairingTimer();
  remoteServer?.closePairing();
  if (preserveExpired && remotePairing) remotePairing.expired = true;
  else remotePairing = null;
  emitRemoteState();
}

function requireRemoteManagementSession(expectedOutputSessionId) {
  authorizeLocalShowCommand('remote.manage');
  const showState = showGateway.getState();
  if (
    !expectedOutputSessionId
    || showState.outputSessionId !== expectedOutputSessionId
    || (showState.phase !== 'live' && showState.phase !== 'cleared')
  ) {
    failMainOperation(
      'OUTPUT_SESSION_REPLACED',
      'The Show changed before Remote Control setup could finish.'
    );
  }
  return showState;
}

async function createRemotePairing({
  expectedGeneration = null,
  expectedOutputSessionId = null,
  requireLocalAuthority = false
} = {}) {
  if (requireLocalAuthority) {
    requireRemoteManagementSession(expectedOutputSessionId);
  }
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
  if (
    expectedOutputSessionId !== null
    && showState.outputSessionId !== expectedOutputSessionId
  ) {
    failMainOperation('OUTPUT_SESSION_REPLACED', 'The Show changed before pairing could begin.');
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
  try {
    if (requireLocalAuthority) {
      requireRemoteManagementSession(expectedOutputSessionId);
    }
  } catch (error) {
    closeRemotePairing();
    throw error;
  }
  if (!latestStatus.enabled || latestStatus.mode !== 'lan'
    || showGateway.getState().outputSessionId !== sessionId
    || (
      expectedOutputSessionId !== null
      && sessionId !== expectedOutputSessionId
    )) {
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

async function enableRemoteControl(bindingId, expectedOutputSessionId) {
  return queueRemoteOperation(async () => {
    const showState = requireRemoteManagementSession(
      expectedOutputSessionId
    );
    const binding = remoteServer.listBindings()
      .find(candidate => candidate.id === bindingId && candidate.kind === 'lan');
    if (!binding) {
      failMainOperation('INVALID_BINDING', 'Choose an available trusted network.');
    }

    remoteLastError = null;
    closeRemotePairing();
    const enablePairingGeneration = remotePairingGeneration;
    if (remoteServer.getStatus().enabled) await remoteServer.stop('remote-reconfigured');
    requireRemoteManagementSession(expectedOutputSessionId);
    const sessionId = showState.outputSessionId;
    try {
      await remoteServer.startLoopback();
      await remoteServer.bindLan(binding.id);
      requireRemoteManagementSession(expectedOutputSessionId);
      return await createRemotePairing({
        expectedGeneration: enablePairingGeneration,
        expectedOutputSessionId,
        requireLocalAuthority: true
      });
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
      rootPath: path.join(userDataPath, 'song-library'),
      familyRecoveryAuthority: localSongFamilyRecoveryAuthority
    });
  }
  if (!localSongFamilyReviewStore) {
    localSongFamilyReviewStore = new LocalSongFamilyReviewStore({
      rootPath: path.join(userDataPath, 'song-family-reviews')
    });
  }
  if (!localSongFamilyCommitCoordinator) {
    localSongFamilyCommitCoordinator =
      new LocalSongFamilyCommitCoordinator({
        rootPath: path.join(userDataPath, 'song-library'),
        songLibrary: localSongLibrary,
        reviewStore: localSongFamilyReviewStore,
        recoveryAuthority: localSongFamilyRecoveryAuthority
      });
  }
  if (!communitySongFamilyImportCoordinator) {
    communitySongFamilyImportCoordinator =
      new CommunitySongFamilyImportCoordinator({
        rootPath: path.join(userDataPath, 'song-library'),
        songLibrary: localSongLibrary,
        recoveryAuthority: localSongFamilyRecoveryAuthority
      });
  }
  if (!localSermonLibrary) {
    localSermonLibrary = new LocalSermonLibrary({
      rootPath: path.join(userDataPath, 'sermon-library')
    });
  }
  if (!localSermonSourceStore) {
    localSermonSourceStore = new LocalSermonSourceStore({
      rootPath: path.join(userDataPath, 'sermon-sources')
    });
  }
  if (!localSermonMediaStore) {
    localSermonMediaStore = new LocalSermonMediaStore({
      rootPath: path.join(userDataPath, 'sermon-media')
    });
  }
  if (!communitySermonMediaAttemptStore) {
    communitySermonMediaAttemptStore =
      new CommunitySermonMediaAttemptStore({
        rootPath: path.join(userDataPath, 'community-sermon-media-attempts')
      });
  }
  if (!localSermonExtractionStore) {
    localSermonExtractionStore = new LocalSermonExtractionStore({
      rootPath: path.join(userDataPath, 'sermon-extractions')
    });
  }
  if (!sermonProjectCommitCoordinator) {
    sermonProjectCommitCoordinator = new SermonProjectCommitCoordinator({
      rootPath: path.join(userDataPath, 'prepare-transactions'),
      projectStore: serviceProjectStore,
      sermonLibrary: localSermonLibrary
    });
  }
  if (!localSermonSourceRetention) {
    localSermonSourceRetention = new LocalSermonSourceRetention({
      sourceStore: localSermonSourceStore,
      sermonLibrary: localSermonLibrary,
      projectStore: serviceProjectStore,
      extractionStore: localSermonExtractionStore
    });
  }
  if (!serviceProjectExchange) {
    serviceProjectExchange = new ServiceProjectExchange({
      projectStore: serviceProjectStore,
      songLibrary: localSongLibrary,
      sermonLibrary: localSermonLibrary,
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
  if (!currentShowPackageStore) {
    currentShowPackageStore = new CurrentShowPackageStore({
      rootPath: path.join(userDataPath, 'prepared-service')
    });
  }
  return {
    currentShowPackageStore,
    communitySermonMediaAttemptStore,
    localSermonExtractionStore,
    localSermonLibrary,
    localSermonMediaStore,
    localSermonSourceRetention,
    localSermonSourceStore,
    communitySongFamilyImportCoordinator,
    localSongFamilyCommitCoordinator,
    localSongFamilyReviewStore,
    localSongLibrary,
    sermonProjectCommitCoordinator,
    serviceProjectExchange,
    serviceProjectStore,
    showPackagePublisher
  };
}

async function recoverLocalSongFamilyCommit() {
  const services = getPrepareServices();
  const communityRecovery =
    await services.communitySongFamilyImportCoordinator.recover();
  if (communityRecovery.handled) return communityRecovery;
  return services.localSongFamilyCommitCoordinator.recover();
}

function sermonSourceRetentionCauseCode(error) {
  return typeof error?.code === 'string'
    && /^[A-Z][A-Z0-9_]{0,79}$/.test(error.code)
    ? error.code
    : 'UNKNOWN';
}

function failSermonSourceRetentionOperation(error, action) {
  const causeCode = sermonSourceRetentionCauseCode(error);
  console.warn(`[SermonSourceRetention] ${action} stopped safely: ${causeCode}`);
  if (causeCode === 'CANDIDATE_SET_CHANGED') {
    failMainOperation(
      causeCode,
      'Private sermon storage changed after the check. Check it again before scheduling removal.'
    );
  }
  if (causeCode === 'NO_CLEANUP_CANDIDATES') {
    failMainOperation(
      causeCode,
      'There are no private sermon files old enough to remove.'
    );
  }
  failMainOperation(
    'SERMON_SOURCE_RETENTION_SAFETY_CHECK_FAILED',
    'SyncShow could not prove that private sermon storage is safe to change. No files were removed.',
    { causeCode }
  );
}

async function recoverSermonTransactionsForRetention(services) {
  await services.sermonProjectCommitCoordinator.recover();
}

async function auditPrivateSermonStorage() {
  const services = getPrepareServices();
  await recoverSermonTransactionsForRetention(services);
  const summary = await services.localSermonSourceRetention.audit();
  return {
    schemaVersion: summary.schemaVersion,
    auditedAt: summary.auditedAt,
    retentionDays: summary.retentionDays,
    objectCount: summary.objectCount,
    objectBytes: summary.objectBytes,
    referencedObjectCount: summary.referencedObjectCount,
    referencedBytes: summary.referencedBytes,
    unreferencedObjectCount: summary.unreferencedObjectCount,
    unreferencedBytes: summary.unreferencedBytes,
    waitingObjectCount: summary.waitingObjectCount,
    waitingBytes: summary.waitingBytes,
    eligibleObjectCount: summary.eligibleObjectCount,
    eligibleBytes: summary.eligibleBytes,
    candidateHash: summary.candidateHash,
    startupCleanup: {
      status: sermonSourceRetentionStartup.status,
      causeCode: sermonSourceRetentionStartup.causeCode || null,
      deletedObjectCount: sermonSourceRetentionStartup.deletedObjectCount,
      deletedBytes: sermonSourceRetentionStartup.deletedBytes
    }
  };
}

async function applyConfirmedSermonSourceCleanupAtStartup() {
  try {
    const services = getPrepareServices();
    // Recovery must finish before the cross-store reference audit. This helper
    // runs before any renderer, Community sync, or other writer can start.
    await recoverSermonTransactionsForRetention(services);
    const result = await services.localSermonSourceRetention
      .applyConfirmedStartupPlan();
    sermonSourceRetentionStartup = Object.freeze({
      status: result.applied ? 'applied' : result.skippedReason,
      deletedObjectCount: result.deletedObjectCount,
      deletedBytes: result.deletedBytes
    });
    if (result.applied) {
      console.info(
        `[SermonSourceRetention] Removed ${result.deletedObjectCount} confirmed private source object(s) after startup re-audit.`
      );
    }
    return sermonSourceRetentionStartup;
  } catch (error) {
    const causeCode = sermonSourceRetentionCauseCode(error);
    sermonSourceRetentionStartup = Object.freeze({
      status: 'safety-check-failed',
      causeCode,
      deletedObjectCount: 0,
      deletedBytes: 0
    });
    console.warn(
      `[SermonSourceRetention] Startup cleanup stopped safely: ${causeCode}`
    );
    return sermonSourceRetentionStartup;
  }
}

function currentPreparedServiceBinding(pointer, opened) {
  const roleIds = enabledPresentationRoleIds();
  return validateCurrentShowPackageBinding({
    pointer,
    manifest: opened.manifest,
    manifestSha256: opened.manifestSha256,
    serviceHandoff: opened.serviceHandoff,
    venueProfileId: activeVenueProfile?.id,
    venueProfileRevisionId: preparedServiceVenueRevisionId(activeVenueProfile),
    enabledRoleIds: roleIds,
    presentationRoleIds: Object.keys(opened.presentations)
  });
}

async function restoreCurrentPreparedService() {
  const services = getPrepareServices();
  let pointer = null;
  try {
    pointer = await services.currentShowPackageStore.read();
    if (!pointer) {
      currentPreparedServicePointer = null;
      setCurrentPreparedServiceRestore('none');
      return false;
    }
    currentPreparedServicePointer = pointer;
    const opened = await services.showPackagePublisher.open(pointer.packageId);
    const binding = currentPreparedServiceBinding(pointer, opened);
    installPreparedPresentations(opened.presentations, binding.roleIds);
    setCurrentPreparedServiceRestore('restored', pointer);
    console.log(
      `[PreparedService] Restored ${binding.projectId} at revision ${binding.projectRevision}.`
    );
    return true;
  } catch (error) {
    const status = error?.code === 'CURRENT_SHOW_PACKAGE_PROFILE_INCOMPATIBLE'
      ? 'incompatible'
      : 'corrupt';
    setCurrentPreparedServiceRestore(status, pointer);
    console.warn(
      '[PreparedService] The saved prepared service was not restored:',
      error?.code || error?.name || 'restore-failed'
    );
    return false;
  }
}

async function activateCurrentPreparedService(services, published) {
  const handoffProject = published.serviceHandoff?.project;
  let receipt;
  try {
    receipt = await services.currentShowPackageStore.activateWithReceipt({
      packageId: published.manifest.id,
      packageManifestSha256: published.manifestSha256,
      projectId: published.manifest.projectId,
      projectRevisionId: published.manifest.projectRevisionId,
      projectRevision: published.manifest.projectRevision,
      serviceDate: handoffProject?.serviceDate,
      venueProfileId: activeVenueProfile?.id,
      venueProfileRevisionId: preparedServiceVenueRevisionId(activeVenueProfile)
    });
  } catch (error) {
    if (error?.code === 'CURRENT_SHOW_PACKAGE_ACTIVATION_UNCERTAIN') {
      currentPreparedServicePointer = null;
      if (!appState.activeLaunchPlan) clearInstalledPreparedPresentations();
      setCurrentPreparedServiceRestore('corrupt');
      failMainOperation(
        'PREPARE_ACTIVATION_DURABILITY_UNCERTAIN',
        'SyncShow could not confirm which prepared service will survive a restart. Do not close the app; choose Save & go to Load again after checking this computer’s storage.'
      );
    }
    throw error;
  }
  try {
    currentPreparedServiceBinding(receipt.pointer, published);
  } catch (error) {
    await services.currentShowPackageStore.rollbackActivation(receipt);
    throw error;
  }
  return receipt;
}

async function rollbackCurrentPreparedServiceActivation(services, receipt) {
  const rolledBack = await services.currentShowPackageStore.rollbackActivation(
    receipt
  );
  if (rolledBack) {
    currentPreparedServicePointer = receipt.previousPointer;
    setCurrentPreparedServiceRestore(
      receipt.previousPointer ? 'restored' : 'none',
      receipt.previousPointer
    );
  }
  return rolledBack;
}

async function deactivateCurrentPreparedService({
  clearPresentations = false
} = {}) {
  if (clearPresentations) requireNoActiveShowForPresentationMutation();
  const services = getPrepareServices();
  await services.currentShowPackageStore.clear();
  if (clearPresentations) requireNoActiveShowForPresentationMutation();
  currentPreparedServicePointer = null;
  if (clearPresentations) clearInstalledPreparedPresentations();
  setCurrentPreparedServiceRestore('none');
}

async function verifyCurrentPreparedServiceForStart() {
  const pointer = currentPreparedServicePointer;
  if (!pointer) return null;
  const services = getPrepareServices();
  try {
    const opened = await services.showPackagePublisher.open(pointer.packageId);
    const binding = currentPreparedServiceBinding(pointer, opened);
    for (const roleId of binding.roleIds) {
      const installed = appState.presentations[roleId];
      if (
        installed?.renderer !== 'native-cue'
        || installed.showPackageId !== binding.packageId
      ) {
        failMainOperation(
          'PREPARED_SERVICE_CHANGED',
          'The prepared service in Load no longer matches its verified package. Reopen it in Prepare and choose Save & go to Load again.'
        );
      }
    }
    return { binding, opened };
  } catch (error) {
    // A replacement Start may be inspecting an invalid saved package while an
    // older Show is still live. Preserve that running Show's already-loaded
    // presentation graph; Start will fail before the replacement boundary.
    if (!appState.activeLaunchPlan) clearInstalledPreparedPresentations();
    const status = error?.code === 'CURRENT_SHOW_PACKAGE_PROFILE_INCOMPATIBLE'
      ? 'incompatible'
      : 'corrupt';
    setCurrentPreparedServiceRestore(status, pointer);
    if (error?.code === 'PREPARED_SERVICE_CHANGED') throw error;
    failMainOperation(
      status === 'incompatible'
        ? 'PREPARED_SERVICE_PROFILE_INCOMPATIBLE'
        : 'PREPARED_SERVICE_CORRUPT',
      status === 'incompatible'
        ? 'The prepared service was made for a different venue setup. Reopen it in Prepare and choose Save & go to Load again.'
        : 'The prepared service could not be verified. Reopen its saved project in Prepare and choose Save & go to Load again.'
    );
  }
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
      }),
      serviceDocumentOutbox: new HeritageServiceDocumentOutbox({
        rootPath: path.join(
          app.getPath('userData'),
          'community',
          'service-documents',
          'outbox'
        )
      }),
      serviceDocumentBindingStore: new HeritageServiceDocumentBindingStore({
        rootPath: path.join(
          app.getPath('userData'),
          'community',
          'service-documents',
          'bindings'
        )
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

function communityRequestKeys(value, allowedKeys, label = 'Community request') {
  communityRequest(value);
  const allowed = new Set(allowedKeys);
  if (Object.keys(value).some(key => !allowed.has(key))) {
    failMainOperation(
      'INVALID_COMMUNITY_REQUEST',
      `${label} contains unsupported fields.`
    );
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
  if (![
    'AUTH_REQUIRED',
    'AUTHORIZATION_EXPIRED',
    'PERMISSION_DENIED'
  ].includes(error?.code)) return false;
  communityReconnectRequired = {
    code: error.code,
    message: error.code === 'PERMISSION_DENIED'
      ? 'This Community account no longer has Community-editor permission. Connect again with a manager account.'
      : error.code === 'AUTHORIZATION_EXPIRED'
        ? 'This Community approval expired. Connect this computer again.'
        : 'This Community approval is no longer valid. Connect this computer again.'
  };
  songPublicLinkReviewProposals.clear();
  songPublicLinkActions.clear();
  clearCommunityServicePlanAuthorities();
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
    canReadSongPublicLinks: connection.canReadSongPublicLinks === true,
    canWriteSongPublicLinks: connection.canWriteSongPublicLinks === true,
    canReadSermons: connection.canReadSermons === true,
    canWriteSermons: connection.canWriteSermons === true,
    canReadSermonPublications:
      connection.canReadSermonPublications === true,
    canReadSermonMedia: connection.canReadSermonMedia === true,
    canWriteSermonMedia: connection.canWriteSermonMedia === true,
    canReadServicePlans: connection.canReadServicePlans === true,
    canReadServiceDocuments: connection.canReadServiceDocuments === true,
    canWriteServiceDocuments: connection.canWriteServiceDocuments === true,
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

function communityServicePlanImportOptions() {
  const profileId = activeVenueProfile?.id || 'default';
  return Object.freeze({
    profileId,
    preferredProfileId: profileId,
    channels: nativeProjectChannels()
  });
}

function communityServicePlanImportOptionsKey(options) {
  return JSON.stringify(options);
}

async function communityServicePlanContext({ refreshCapabilities = true } = {}) {
  const summary = await currentCommunityConnectionSummary({
    refreshCapabilities
  });
  if (!summary || communityConnectionExpired(summary)) {
    failMainOperation(
      'COMMUNITY_RECONNECT_REQUIRED',
      'Connect Heritage Community before browsing its service plans.'
    );
  }
  if (communityReconnectRequired) {
    failMainOperation(
      'COMMUNITY_RECONNECT_REQUIRED',
      communityReconnectRequired.message
    );
  }
  if (!summary.canReadServicePlans) {
    const advertised = summary.advertisedScopes
      ?.includes('syncshow:service-plans:read') === true;
    const granted = summary.scopes
      ?.includes('syncshow:service-plans:read') === true;
    if (advertised && !granted) {
      failMainOperation(
        'COMMUNITY_SERVICE_PLAN_RECONNECT_REQUIRED',
        'This Community server now offers service plans, but this computer has not approved the new read permission. Reconnect Community from Admin Settings, review the added service-plan access, then return to Prepare.'
      );
    }
    failMainOperation(
      'COMMUNITY_SERVICE_PLANS_UNAVAILABLE',
      granted
        ? 'This Community server no longer advertises service-plan access. Existing local services are unchanged.'
        : 'This Community server does not currently offer service plans to SyncShow.'
    );
  }
  const { connectionStore, stateStore } = await getCommunityServices();
  const connection = await connectionStore.getConnection(summary.id);
  if (!connection || communityConnectionExpired(connection)) {
    failMainOperation(
      'COMMUNITY_RECONNECT_REQUIRED',
      'This Community approval expired. Connect this computer again before browsing service plans.'
    );
  }
  return {
    connection,
    stateStore,
    services: getPrepareServices(),
    client: communityClientForConnection(connection)
  };
}

async function communityServiceDocumentContext({
  refreshCapabilities = true,
  requireWrite = false
} = {}) {
  const summary = await currentCommunityConnectionSummary({
    refreshCapabilities
  });
  if (!summary || communityConnectionExpired(summary)) {
    failMainOperation(
      'COMMUNITY_RECONNECT_REQUIRED',
      'Connect Heritage Community before opening shared services.'
    );
  }
  if (communityReconnectRequired) {
    failMainOperation(
      'COMMUNITY_RECONNECT_REQUIRED',
      communityReconnectRequired.message
    );
  }
  const requiredScope = requireWrite
    ? 'syncshow:service-documents:write'
    : 'syncshow:service-documents:read';
  const allowed = requireWrite
    ? summary.canWriteServiceDocuments
    : summary.canReadServiceDocuments;
  if (!allowed) {
    const advertised = summary.advertisedScopes?.includes(requiredScope) === true;
    const granted = summary.scopes?.includes(requiredScope) === true;
    if (advertised && !granted) {
      failMainOperation(
        'COMMUNITY_SERVICE_DOCUMENT_RECONNECT_REQUIRED',
        'This Community server now offers shared services. Reconnect Community from Admin Settings and approve the shared-service permission.'
      );
    }
    failMainOperation(
      'COMMUNITY_SERVICE_DOCUMENTS_UNAVAILABLE',
      granted
        ? 'This Community server no longer advertises shared-service access. Existing local services are unchanged.'
        : 'This Community connection does not currently include shared-service access.'
    );
  }
  const services = await getCommunityServices();
  const connection = await services.connectionStore.getConnection(summary.id);
  if (!connection || communityConnectionExpired(connection)) {
    failMainOperation(
      'COMMUNITY_RECONNECT_REQUIRED',
      'This Community approval expired. Connect this computer again before opening shared services.'
    );
  }
  const client = communityClientForConnection(connection);
  const projectStore = getPrepareServices().serviceProjectStore;
  return Object.freeze({
    connection,
    client,
    projectStore,
    outbox: services.serviceDocumentOutbox,
    bindingStore: services.serviceDocumentBindingStore,
    sync: new HeritageServiceDocumentSync({
      client,
      outbox: services.serviceDocumentOutbox,
      serverId: connection.serverId,
      synchronizeAssets: async ({ project, accessToken, signal }) => {
        const current = await projectStore.read(project.id);
        for (const assetId of Object.keys(project.assets).sort()) {
          const declared = project.assets[assetId];
          const local = current.project.assets[assetId];
          if (!local || JSON.stringify(local) !== JSON.stringify(declared)) {
            failMainOperation(
              'SERVICE_DOCUMENT_ASSET_CHANGED',
              `Service image ${assetId} changed before it could be synchronized.`
            );
          }
          const resolved = await projectStore.resolveAssetPath(
            project.id,
            current.revisionId,
            assetId
          );
          const { buffer } = await readFileNoFollow(
            resolved.assetPath,
            declared.kind === 'video' ? MAX_VIDEO_BYTES : MAX_IMAGE_BYTES
          );
          await client.putServiceDocumentAsset({
            asset: declared,
            bytes: buffer,
            accessToken,
            signal
          });
        }
      }
    })
  });
}

function publicServiceDocumentBinding(binding, pending = null) {
  if (!binding) return null;
  return {
    projectId: binding.projectId,
    serverId: binding.serverId,
    syncId: binding.syncId,
    syncVersion: binding.syncVersion,
    documentRevision: binding.documentRevision,
    localRevisionId: binding.localRevisionId,
    status: binding.status,
    changedAt: binding.changedAt,
    pending: pending
      ? {
          mode: pending.mode,
          documentRevision: pending.documentRevision,
          queuedAt: pending.queuedAt
        }
      : null
  };
}

function serviceDocumentSourceForProject(project) {
  return serializeHeritageServiceDocument(
    createHeritageServiceDocument(project)
  );
}

async function readLocalServiceDocument(projectStore, syncId) {
  try {
    const local = await projectStore.read(syncId);
    return Object.freeze({
      ...local,
      documentSource: serviceDocumentSourceForProject(local.project),
      documentRevision: heritageServiceDocumentRevision(
        serviceDocumentSourceForProject(local.project)
      )
    });
  } catch (error) {
    if (error?.code === 'PROJECT_NOT_FOUND') return null;
    throw error;
  }
}

async function saveServiceDocumentBinding({
  bindingStore,
  connection,
  localRevisionId,
  remote
}) {
  return bindingStore.save({
    projectId: remote.syncId,
    serverId: connection.serverId,
    syncId: remote.syncId,
    syncVersion: remote.syncVersion,
    documentRevision: remote.revision,
    localRevisionId,
    status: remote.status,
    changedAt: remote.changedAt
  });
}

function serviceDocumentConflict({ kind, local, remote, binding }) {
  return {
    state: 'conflict',
    conflict: {
      kind,
      local: {
        projectId: local.project.id,
        title: local.project.title,
        serviceDate: local.project.serviceDate,
        revisionId: local.revisionId,
        documentRevision: local.documentRevision
      },
      remote: {
        syncId: remote.syncId,
        title: remote.project.title,
        serviceDate: remote.project.serviceDate,
        syncVersion: remote.syncVersion,
        revision: remote.revision,
        status: remote.status,
        changedAt: remote.changedAt
      },
      base: binding
        ? {
            syncVersion: binding.syncVersion,
            revision: binding.documentRevision,
            localRevisionId: binding.localRevisionId
          }
        : null
    }
  };
}

async function installCommunityServiceDocument(context, remote, local) {
  const assetBuffers = new Map();
  for (const assetId of Object.keys(remote.project.assets).sort()) {
    const asset = remote.project.assets[assetId];
    assetBuffers.set(assetId, await context.client.getServiceDocumentAsset({
      syncId: remote.syncId,
      asset,
      accessToken: context.connection.accessToken
    }));
  }
  const installed = await context.projectStore.installSharedSnapshot(
    remote.project,
    {
      expectedRevisionId: local?.revisionId ?? null,
      reason: 'community-snapshot',
      assetBuffers
    }
  );
  const binding = await saveServiceDocumentBinding({
    ...context,
    localRevisionId: installed.revisionId,
    remote
  });
  return {
    state: 'opened',
    ...projectResult(installed),
    shared: publicServiceDocumentBinding(binding)
  };
}

async function synchronizeLocalServiceDocument(context, local, {
  status = 'planning',
  base = null
} = {}) {
  const result = await context.sync.save({
    documentSource: local.documentSource,
    status,
    base,
    accessToken: context.connection.accessToken
  });
  if (result.state === 'conflict') {
    return serviceDocumentConflict({
      kind: 'concurrent-change',
      local,
      remote: result.remote,
      binding: base && {
        syncVersion: base.syncVersion,
        documentRevision: base.revision,
        localRevisionId: local.revisionId
      }
    });
  }
  if (result.state === 'synced') {
    const binding = await saveServiceDocumentBinding({
      ...context,
      localRevisionId: local.revisionId,
      remote: result.remote
    });
    return {
      state: 'synced',
      shared: publicServiceDocumentBinding(binding)
    };
  }
  const remoteBase = base || { syncVersion: 0, revision: null };
  const binding = await context.bindingStore.save({
    projectId: local.project.id,
    serverId: context.connection.serverId,
    syncId: local.project.id,
    syncVersion: remoteBase.syncVersion,
    documentRevision: remoteBase.revision,
    localRevisionId: local.revisionId,
    status,
    changedAt: base?.changedAt || null
  });
  return {
    state: 'queued',
    reason: result.reason,
    shared: publicServiceDocumentBinding(binding, result.queued)
  };
}

async function resolveCommunityServicePlanBible({
  range,
  translationId,
  channelIds
}) {
  const book = CANONICAL_BIBLE_BOOKS.find(candidate =>
    candidate.id === range.bookId);
  if (!book || range.start.chapter !== range.end.chapter) {
    throw new Error('The requested Bible range is not supported locally.');
  }
  const lookup = await bibleLibrary.lookupCanonicalRange({
    book: book.name,
    startChapter: range.start.chapter,
    startVerse: range.start.verse,
    endChapter: range.end.chapter,
    endVerse: range.end.verse
  }, {
    translationId
  });
  if (lookup?.status !== 'ok' || !lookup.passage) {
    throw new Error(lookup?.message || 'The requested Bible text is unavailable.');
  }
  const passage = {
    ...lookup.passage,
    bookId: range.bookId,
    chapter: range.start.chapter,
    verseStart: range.start.verse,
    verseEnd: range.end.verse,
    translationId
  };
  return {
    passagesByChannel: Object.fromEntries(
      channelIds.map(channelId => [channelId, passage])
    )
  };
}

function communityServicePlanCoordinator(context) {
  return new CommunityServicePlanImportCoordinator({
    serverId: context.connection.serverId,
    connectionId: context.connection.id,
    syncStateStore: context.stateStore,
    songLibrary: context.services.localSongLibrary,
    sermonLibrary: context.services.localSermonLibrary,
    projectStore: context.services.serviceProjectStore,
    bibleResolver: resolveCommunityServicePlanBible
  });
}

function publicCommunityServicePlan(envelope) {
  return {
    syncId: envelope.syncId,
    syncVersion: envelope.syncVersion,
    revision: envelope.revision,
    status: envelope.status,
    changedAt: envelope.changedAt,
    plan: {
      schemaVersion: envelope.plan.schemaVersion,
      id: envelope.plan.id,
      title: envelope.plan.title,
      serviceDate: envelope.plan.serviceDate,
      startTime: envelope.plan.startTime,
      teamNotes: envelope.plan.teamNotes,
      entries: envelope.plan.entries.map(entry => ({
        id: entry.id,
        kind: entry.kind,
        title: entry.title,
        ...(entry.kind === 'scripture'
          ? {
              range: entry.range,
              translationId: entry.translationId,
              ...(envelope.plan.schemaVersion === 2
                ? {
                    sermonReading: entry.sermonReading === null
                      ? null
                      : {
                          sermonEntryId: entry.sermonReading.sermonEntryId,
                          referenceId: entry.sermonReading.referenceId
                        }
                  }
                : {})
            }
          : {}),
        ...(['song', 'sermon'].includes(entry.kind)
          ? {
              syncId: entry.syncId,
              expectedRevision: entry.expectedRevision,
              expectedSyncVersion: entry.expectedSyncVersion
            }
          : {})
      }))
    }
  };
}

function sameCommunityServicePlanEnvelope(left, right) {
  return Boolean(left && right)
    && left.syncId === right.syncId
    && left.syncVersion === right.syncVersion
    && left.revision === right.revision
    && left.status === right.status
    && left.changedAt === right.changedAt
    && left.documentSource === right.documentSource;
}

function communityServicePlanDependencyKey(dependencies) {
  return JSON.stringify(dependencies.map(dependency => ({
    kind: dependency.kind,
    syncId: dependency.syncId,
    expectedSyncVersion: dependency.expectedSyncVersion,
    expectedRevision: dependency.expectedRevision,
    entryIds: [...dependency.entryIds],
    blockerCodes: [...dependency.blockerCodes]
  })));
}

function communityServicePlanStalePinKey(context, envelope) {
  return JSON.stringify([
    context.connection.id,
    context.connection.serverId,
    envelope.syncId,
    envelope.syncVersion,
    envelope.revision
  ]);
}

function pruneCommunityServicePlanStalePins(now = Date.now()) {
  for (const [key, observation] of communityServicePlanStalePins) {
    if (observation.expiresAt <= now) {
      communityServicePlanStalePins.delete(key);
    }
  }
  while (
    communityServicePlanStalePins.size
      > COMMUNITY_SERVICE_PLAN_STALE_PIN_LIMIT
  ) {
    const oldest = communityServicePlanStalePins.keys().next().value;
    communityServicePlanStalePins.delete(oldest);
  }
}

function rememberCommunityServicePlanStalePin({
  context,
  envelope,
  dependency
}) {
  pruneCommunityServicePlanStalePins();
  const key = communityServicePlanStalePinKey(context, envelope);
  let observation = communityServicePlanStalePins.get(key);
  if (!observation) {
    while (
      communityServicePlanStalePins.size
        >= COMMUNITY_SERVICE_PLAN_STALE_PIN_LIMIT
    ) {
      const oldest = communityServicePlanStalePins.keys().next().value;
      communityServicePlanStalePins.delete(oldest);
    }
    observation = {
      expiresAt:
        Date.now() + COMMUNITY_SERVICE_PLAN_STALE_PIN_TTL_MS,
      dependencies: new Map()
    };
    communityServicePlanStalePins.set(key, observation);
  }
  const dependencyKey = communityServicePlanDependencyKey([dependency]);
  observation.dependencies.set(dependencyKey, Object.freeze({
    kind: dependency.kind,
    syncId: dependency.syncId,
    expectedSyncVersion: dependency.expectedSyncVersion,
    expectedRevision: dependency.expectedRevision,
    entryIds: Object.freeze([...dependency.entryIds]),
    blockerCodes: Object.freeze([...dependency.blockerCodes])
  }));
}

function knownCommunityServicePlanStalePins(context, envelope) {
  pruneCommunityServicePlanStalePins();
  const observation = communityServicePlanStalePins.get(
    communityServicePlanStalePinKey(context, envelope)
  );
  return observation
    ? Object.freeze([...observation.dependencies.values()])
    : Object.freeze([]);
}

function applyCommunityServicePlanStalePins(review, dependencies) {
  if (
    !Array.isArray(dependencies)
    || dependencies.length < 1
    || !review
    || !review.proposal
    || review.proposal.remoteStatus !== 'ready'
    || review.proposal.existingProject
    || review.proposal.blockersTruncated
    || !['blocked', 'ready-to-import'].includes(review.proposal.status)
  ) {
    return review;
  }
  const staleByEntry = new Map();
  for (const dependency of dependencies) {
    for (const entryId of dependency.entryIds) {
      staleByEntry.set(entryId, dependency.kind);
    }
  }
  if (staleByEntry.size < 1) return review;

  const staleCodes = new Set([
    'LOCAL_SONG_MISSING',
    'LOCAL_SONG_REMOTE_BEHIND',
    'LOCAL_SERMON_MISSING',
    'LOCAL_SERMON_REMOTE_BEHIND'
  ]);
  const blockers = [];
  const coveredEntries = new Set();
  for (const blocker of review.proposal.blockers) {
    const staleKind = staleByEntry.get(blocker.entryId);
    if (!staleKind || !staleCodes.has(blocker.code)) {
      blockers.push(blocker);
      if (staleKind) coveredEntries.add(blocker.entryId);
      continue;
    }
    coveredEntries.add(blocker.entryId);
    blockers.push(Object.freeze({
      entryId: blocker.entryId,
      kind: staleKind,
      code: staleKind === 'song'
        ? 'SERVICE_PLAN_SONG_PIN_STALE'
        : 'SERVICE_PLAN_SERMON_PIN_STALE',
      message: staleKind === 'song'
        ? 'Community no longer has the exact song revision pinned by this Ready plan. A Community manager must return the plan to Draft, refresh the song pin, review it, and mark it Ready again.'
        : 'Community no longer has the exact sermon revision pinned by this Ready plan. A Community manager must return the plan to Draft, refresh the sermon pin, review it, and mark it Ready again.'
    }));
  }
  for (const [entryId, kind] of staleByEntry) {
    if (coveredEntries.has(entryId)) continue;
    blockers.push(Object.freeze({
      entryId,
      kind,
      code: kind === 'song'
        ? 'SERVICE_PLAN_SONG_PIN_STALE'
        : 'SERVICE_PLAN_SERMON_PIN_STALE',
      message: kind === 'song'
        ? 'Community no longer has the exact song revision pinned by this Ready plan. A Community manager must return the plan to Draft, refresh the song pin, review it, and mark it Ready again.'
        : 'Community no longer has the exact sermon revision pinned by this Ready plan. A Community manager must return the plan to Draft, refresh the sermon pin, review it, and mark it Ready again.'
    }));
  }
  if (blockers.length > COMMUNITY_SERVICE_PLAN_PREPARATION_MAX_ITEMS) {
    return Object.freeze({
      proposal: Object.freeze({
        ...review.proposal,
        status: 'blocked',
        blockerCount: blockers.length,
        blockersTruncated: true,
        blockers: Object.freeze(
          blockers.slice(
            0,
            COMMUNITY_SERVICE_PLAN_PREPARATION_MAX_ITEMS
          )
        ),
        diff: null
      }),
      preparationDependencies: Object.freeze([])
    });
  }
  return Object.freeze({
    proposal: Object.freeze({
      ...review.proposal,
      status: 'blocked',
      blockerCount: blockers.length,
      blockersTruncated: false,
      blockers: Object.freeze(blockers),
      diff: null
    }),
    preparationDependencies: Object.freeze([])
  });
}

function pruneCommunityServicePlanPreparations(now = Date.now()) {
  for (const [token, preparation] of communityServicePlanPreparations) {
    if (preparation.expiresAt <= now) {
      communityServicePlanPreparations.delete(token);
    }
  }
  while (
    communityServicePlanPreparations.size
      >= COMMUNITY_SERVICE_PLAN_PREPARATION_LIMIT
  ) {
    const oldest = communityServicePlanPreparations.keys().next().value;
    communityServicePlanPreparations.delete(oldest);
  }
}

function saveCommunityServicePlanPreparation({
  context,
  envelope,
  options,
  proposal,
  dependencies
}) {
  pruneCommunityServicePlanPreparations();
  if (
    proposal.status !== 'blocked'
    || proposal.remoteStatus !== 'ready'
    || proposal.existingProject
    || !Array.isArray(dependencies)
    || dependencies.length < 1
    || dependencies.length
      > COMMUNITY_SERVICE_PLAN_PREPARATION_MAX_ITEMS
  ) {
    return null;
  }
  for (const [token, existing] of communityServicePlanPreparations) {
    if (
      existing.connectionId === context.connection.id
      && existing.envelope.syncId === envelope.syncId
    ) {
      communityServicePlanPreparations.delete(token);
    }
  }
  const preparationToken = crypto.randomUUID();
  const expiresAt =
    Date.now() + COMMUNITY_SERVICE_PLAN_PREPARATION_TTL_MS;
  const dependencyKey = communityServicePlanDependencyKey(dependencies);
  communityServicePlanPreparations.set(preparationToken, {
    connectionId: context.connection.id,
    serverId: context.connection.serverId,
    envelope,
    options,
    optionsKey: communityServicePlanImportOptionsKey(options),
    dependencies,
    dependencyKey,
    expiresAt
  });
  const songCount = dependencies.filter(
    dependency => dependency.kind === 'song'
  ).length;
  const sermonCount = dependencies.filter(
    dependency => dependency.kind === 'sermon'
  ).length;
  return {
    token: preparationToken,
    expiresAt: new Date(expiresAt).toISOString(),
    itemCount: dependencies.length,
    songCount,
    sermonCount
  };
}

function requireCommunityServicePlanPreparation(preparationToken) {
  pruneCommunityServicePlanPreparations();
  const token = communityText(
    preparationToken,
    'Community service-plan preparation',
    64,
    { required: true }
  );
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(token)) {
    failMainOperation(
      'INVALID_SERVICE_PLAN_PREPARATION',
      'That Community service-plan preparation is invalid.'
    );
  }
  const preparation = communityServicePlanPreparations.get(token);
  if (!preparation) {
    failMainOperation(
      'EXPIRED_SERVICE_PLAN_PREPARATION',
      'That Community service-plan preparation expired. Review the exact plan again.'
    );
  }
  return { token, preparation };
}

async function communityServicePlanReviewResponse({
  context,
  envelope,
  options,
  inspected = null
}) {
  const rawReview = inspected
    || await communityServicePlanCoordinator(context).review(
      envelope,
      options
    );
  const review = applyCommunityServicePlanStalePins(
    rawReview,
    knownCommunityServicePlanStalePins(context, envelope)
  );
  const authority = saveCommunityServicePlanReview({
    context,
    envelope,
    options,
    proposal: review.proposal
  });
  const replacement = saveCommunityServicePlanReplacement({
    context,
    envelope,
    options,
    proposal: review.proposal
  });
  const preparation = saveCommunityServicePlanPreparation({
    context,
    envelope,
    options,
    proposal: review.proposal,
    dependencies: review.preparationDependencies
  });
  return {
    connection: {
      id: context.connection.id,
      serverId: context.connection.serverId,
      serverName: context.connection.serverName
    },
    servicePlan: publicCommunityServicePlan(envelope),
    proposal: review.proposal,
    reviewToken: authority.reviewToken,
    reviewExpiresAt: authority.expiresAt,
    replacementToken: replacement.replacementToken,
    replacementExpiresAt: replacement.expiresAt,
    preparation
  };
}

function pruneCommunityServicePlanReviews(now = Date.now()) {
  for (const [token, review] of communityServicePlanReviews) {
    if (review.expiresAt <= now) communityServicePlanReviews.delete(token);
  }
  while (
    communityServicePlanReviews.size >= COMMUNITY_SERVICE_PLAN_REVIEW_LIMIT
  ) {
    const oldest = communityServicePlanReviews.keys().next().value;
    communityServicePlanReviews.delete(oldest);
  }
}

function saveCommunityServicePlanReview({
  context,
  envelope,
  options,
  proposal
}) {
  pruneCommunityServicePlanReviews();
  if (!['ready-to-import', 'already-imported'].includes(proposal.status)) {
    return { reviewToken: null, expiresAt: null };
  }
  const reviewToken = crypto.randomUUID();
  const expiresAt = Date.now() + COMMUNITY_SERVICE_PLAN_REVIEW_TTL_MS;
  communityServicePlanReviews.set(reviewToken, {
    connectionId: context.connection.id,
    serverId: context.connection.serverId,
    envelope,
    options,
    optionsKey: communityServicePlanImportOptionsKey(options),
    expiresAt
  });
  return {
    reviewToken,
    expiresAt: new Date(expiresAt).toISOString()
  };
}

function requireCommunityServicePlanReview(reviewToken) {
  pruneCommunityServicePlanReviews();
  const token = communityText(
    reviewToken,
    'Community service-plan review',
    64,
    { required: true }
  );
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(token)) {
    failMainOperation(
      'INVALID_SERVICE_PLAN_REVIEW',
      'That Community service-plan review is invalid.'
    );
  }
  const review = communityServicePlanReviews.get(token);
  if (!review) {
    failMainOperation(
      'EXPIRED_SERVICE_PLAN_REVIEW',
      'That Community service-plan review expired. Review the exact plan again before importing it.'
    );
  }
  return { token, review };
}

function communityServicePlanReplacementProposalKey(proposal) {
  return JSON.stringify({
    status: proposal.status,
    projectId: proposal.projectId,
    planId: proposal.planId,
    planRevision: proposal.planRevision,
    remoteStatus: proposal.remoteStatus,
    blockerCount: proposal.blockerCount,
    blockersTruncated: proposal.blockersTruncated,
    blockers: proposal.blockers,
    diff: proposal.diff,
    reconciliation: proposal.reconciliation || null,
    existingProject: proposal.existingProject,
    revisionId: proposal.revisionId || null
  });
}

function pruneCommunityServicePlanReplacements(now = Date.now()) {
  for (const [token, replacement] of communityServicePlanReplacements) {
    if (replacement.expiresAt <= now) {
      communityServicePlanReplacements.delete(token);
    }
  }
  while (
    communityServicePlanReplacements.size
      >= COMMUNITY_SERVICE_PLAN_REPLACEMENT_LIMIT
  ) {
    const oldest = communityServicePlanReplacements.keys().next().value;
    communityServicePlanReplacements.delete(oldest);
  }
}

function saveCommunityServicePlanReplacement({
  context,
  envelope,
  options,
  proposal
}) {
  pruneCommunityServicePlanReplacements();
  if (
    proposal.status !== 'newer-revision'
    || proposal.remoteStatus !== 'ready'
    || proposal.existingProject !== true
    || !/^[a-f0-9]{64}$/.test(proposal.revisionId || '')
    || proposal.reconciliation?.applicable !== true
    || proposal.reconciliation.conflictsTruncated === true
  ) {
    return { replacementToken: null, expiresAt: null };
  }
  const replacementToken = crypto.randomUUID();
  const expiresAt =
    Date.now() + COMMUNITY_SERVICE_PLAN_REPLACEMENT_TTL_MS;
  communityServicePlanReplacements.set(replacementToken, {
    connectionId: context.connection.id,
    serverId: context.connection.serverId,
    envelope,
    planId: envelope.syncId,
    remoteSyncVersion: envelope.syncVersion,
    remoteRevision: envelope.revision,
    localProjectId: proposal.projectId,
    localRevisionId: proposal.revisionId,
    options,
    optionsKey: communityServicePlanImportOptionsKey(options),
    proposalKey: communityServicePlanReplacementProposalKey(proposal),
    expiresAt
  });
  return {
    replacementToken,
    expiresAt: new Date(expiresAt).toISOString()
  };
}

function prepareCommunityServicePlanReconciliationDecisions(
  rawDecisions,
  proposal
) {
  const conflicts = proposal?.reconciliation?.conflicts;
  if (
    !Array.isArray(conflicts)
    || !Number.isSafeInteger(proposal.reconciliation.conflictCount)
    || conflicts.length !== proposal.reconciliation.conflictCount
    || conflicts.length > 500
    || !Array.isArray(rawDecisions)
    || rawDecisions.length !== conflicts.length
  ) {
    failMainOperation(
      'INVALID_SERVICE_PLAN_RECONCILIATION_DECISIONS',
      'Choose Local or Community exactly once for every reviewed conflict.'
    );
  }
  const normalized = rawDecisions.map((decision, index) => {
    const conflict = conflicts[index];
    if (
      !decision
      || typeof decision !== 'object'
      || Array.isArray(decision)
      || Object.keys(decision).length !== 2
      || decision.conflictId !== conflict.conflictId
      || !['keep-local', 'use-community'].includes(decision.choice)
    ) {
      failMainOperation(
        'INVALID_SERVICE_PLAN_RECONCILIATION_DECISIONS',
        'Choose Local or Community exactly once for every reviewed conflict.'
      );
    }
    return {
      conflictId: conflict.conflictId,
      choice: decision.choice
    };
  });
  if (
    proposal.reconciliation.mode === 'legacy-full-replace'
    && (
      normalized.length !== 1
      || normalized[0].choice !== 'use-community'
    )
  ) {
    failMainOperation(
      'LEGACY_PLAN_REPLACEMENT_CONFIRMATION_REQUIRED',
      'This older import cannot be merged safely. Choose Community explicitly to replace the active Planning contents, or keep the local project unchanged.'
    );
  }
  return normalized;
}

function requireCommunityServicePlanReplacement(replacementToken) {
  pruneCommunityServicePlanReplacements();
  const token = communityText(
    replacementToken,
    'Community service-plan replacement',
    64,
    { required: true }
  );
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(token)) {
    failMainOperation(
      'INVALID_SERVICE_PLAN_REPLACEMENT',
      'That Community service-plan replacement review is invalid.'
    );
  }
  const replacement = communityServicePlanReplacements.get(token);
  if (!replacement) {
    failMainOperation(
      'EXPIRED_SERVICE_PLAN_REPLACEMENT',
      'That Community service-plan replacement review expired or was already used. Check the exact Community revision again.'
    );
  }
  return { token, replacement };
}

function clearCommunityServicePlanAuthorities() {
  activeCommunityServicePlanPreparation?.controller.abort();
  communityServicePlanReviews.clear();
  communityServicePlanReplacements.clear();
  communityServicePlanPreparations.clear();
  communityServicePlanStalePins.clear();
}

function requireCommunityServicePlanPreparationScopes(
  connection,
  dependencies
) {
  const required = new Set(
    dependencies.map(dependency => dependency.kind)
  );
  for (const resource of [
    {
      kind: 'song',
      scope: 'syncshow:songs:read',
      allowed: connection.canReadSongs === true,
      label: 'songs'
    },
    {
      kind: 'sermon',
      scope: 'syncshow:sermons:read',
      allowed: connection.canReadSermons === true,
      label: 'sermons'
    }
  ]) {
    if (!required.has(resource.kind) || resource.allowed) continue;
    const advertised =
      connection.advertisedScopes?.includes(resource.scope) === true;
    const granted = connection.scopes?.includes(resource.scope) === true;
    if (advertised && !granted) {
      failMainOperation(
        'COMMUNITY_SERVICE_PLAN_ITEMS_RECONNECT_REQUIRED',
        `Reconnect Community from Admin Settings and approve read access to ${resource.label} before preparing this plan.`
      );
    }
    failMainOperation(
      'COMMUNITY_SERVICE_PLAN_ITEMS_UNAVAILABLE',
      `This Community connection cannot read the ${resource.label} referenced by this plan. Reconnect with the required read access, then review the plan again.`
    );
  }
}

async function currentCommunityConnectionSummary({ refreshCapabilities = false } = {}) {
  const { connectionStore } = await getCommunityServices();
  const connections = await connectionStore.listConnections();
  const connection = connections[0] || null;
  communityCapabilityWarning = connection && !communityConnectionExpired(connection)
    ? communityCapabilityWarningMessage(
        connection.scopes,
        connection.advertisedScopes
      )
    : null;
  if (!connection || !refreshCapabilities || communityConnectionExpired(connection)) {
    return connection;
  }
  return refreshCommunityConnectionCapabilities(connection);
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

async function communityLastSermonSyncFromState(connectionId) {
  if (communityLastSermonSyncSummary) return communityLastSermonSyncSummary;
  if (!connectionId) return null;
  const { stateStore } = await getCommunityServices();
  const state = await stateStore.getConnectionState(connectionId);
  if (!state.lastSermonSyncAt) return null;
  return {
    resource: 'sermons',
    status: 'synced',
    completedAt: state.lastSermonSyncAt,
    conflicts: Object.values(state.sermons)
      .filter(sermon => sermon.conflict).length
  };
}

async function communityStatusPayload({ refreshCapabilities = false } = {}) {
  const connection = await currentCommunityConnectionSummary({ refreshCapabilities });
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
      lastSync: connection.canReadSongs
        ? await communityLastSyncFromState(connection.id)
        : null,
      lastSermonSync: connection.canReadSermons
        ? await communityLastSermonSyncFromState(connection.id)
        : null
    };
  }
  if (connection && !communityConnectionExpired(connection)) {
    return {
      connected: true,
      pending: false,
      status: 'connected',
      connection: publicCommunityConnection(connection),
      warning: [communityConnectionWarning, communityCapabilityWarning]
        .filter(Boolean)
        .join(' ') || null,
      lastSync: connection.canReadSongs
        ? await communityLastSyncFromState(connection.id)
        : null,
      lastSermonSync: connection.canReadSermons
        ? await communityLastSermonSyncFromState(connection.id)
        : null
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
    warning: [communityConnectionWarning, communityCapabilityWarning]
      .filter(Boolean)
      .join(' ') || null,
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

const OPTIONAL_COMMUNITY_APPROVAL_SCOPES = new Set([
  'syncshow:sermon-media:read',
  'syncshow:sermon-media:write'
]);

function communityAuthorizationScopes(discovery, {
  includeSermonMedia = false
} = {}) {
  const scopes = Array.isArray(discovery?.scopes)
    ? [...new Set(discovery.scopes)]
        .filter(scope =>
          includeSermonMedia
          || !OPTIONAL_COMMUNITY_APPROVAL_SCOPES.has(scope))
        .sort()
    : [];
  if (scopes.length < 1) {
    failMainOperation(
      'COMMUNITY_SYNC_UNAVAILABLE',
      'This Community server has not advertised a SyncShow resource lane.'
    );
  }
  return scopes;
}

function sameCommunityScopes(left, right) {
  return JSON.stringify([...(left || [])].sort())
    === JSON.stringify([...(right || [])].sort());
}

function communityCapabilityWarningMessage(grantedScopes, advertisedScopes) {
  const granted = new Set(grantedScopes || []);
  const advertised = new Set(advertisedScopes || []);
  const added = [...advertised].filter(scope => !granted.has(scope));
  const removed = [...granted].filter(scope => !advertised.has(scope));
  if (added.length > 0 && removed.length === 0) {
    return 'This Community server now offers additional SyncShow resources. Connect again to approve them; currently approved resources remain available.';
  }
  if (removed.length > 0 && added.length === 0) {
    return 'This Community server no longer advertises some previously approved SyncShow resources. Those lanes are disabled; remaining resources stay available.';
  }
  if (added.length > 0 || removed.length > 0) {
    return 'This Community server changed its SyncShow resources. Removed lanes are disabled; connect again to approve newly offered lanes.';
  }
  return null;
}

function communitySermonMediaOperationKey(reference) {
  return [
    reference.projectId,
    reference.expectedProjectRevisionId,
    reference.itemId
  ].join('\u0000');
}

function publicCommunitySermonMediaProgress(progress) {
  if (!progress || typeof progress !== 'object') return null;
  return {
    phase: [
      'starting',
      'uploading',
      'finalizing',
      'complete',
      'cancelled',
      'stale'
    ].includes(progress.phase)
      ? progress.phase
      : 'uploading',
    receivedBytes:
      Number.isSafeInteger(progress.receivedBytes) && progress.receivedBytes >= 0
        ? progress.receivedBytes
        : 0,
    totalBytes:
      Number.isSafeInteger(progress.totalBytes) && progress.totalBytes >= 1
        ? progress.totalBytes
        : 1,
    receivedChunks:
      Number.isSafeInteger(progress.receivedChunks)
      && progress.receivedChunks >= 0
        ? progress.receivedChunks
        : 0,
    chunkCount:
      Number.isSafeInteger(progress.chunkCount) && progress.chunkCount >= 1
        ? progress.chunkCount
        : 1,
    percent:
      Number.isSafeInteger(progress.percent)
      && progress.percent >= 0
      && progress.percent <= 100
        ? progress.percent
        : 0,
    complete: progress.complete === true
  };
}

function communitySermonMediaCanCancel({
  status,
  progress = null,
  uploadId = null,
  restartRequired = false
} = {}) {
  return ['uploading', 'error'].includes(status)
    && restartRequired !== true
    && progress?.phase !== 'finalizing'
    && typeof (uploadId || progress?.uploadId) === 'string';
}

function communitySermonMediaRemoteBytesComplete(progress) {
  return progress
    && Number.isSafeInteger(progress.totalBytes)
    && progress.totalBytes >= 1
    && progress.receivedBytes === progress.totalBytes
    && Number.isSafeInteger(progress.chunkCount)
    && progress.chunkCount >= 1
    && progress.receivedChunks === progress.chunkCount;
}

function communitySermonMediaCanResumeWithoutLocal(operation) {
  return operation?.status === 'error'
    && operation.restartRequired !== true
    && operation.resumeEligible !== false
    && (
      operation.progress?.phase === 'finalizing'
      || communitySermonMediaRemoteBytesComplete(operation.progress)
    );
}

function communitySermonMediaFailureDisposition(error, uploadId = null) {
  const acknowledged = typeof uploadId === 'string';
  const remoteStale = error?.cause === 'STALE_SERMON_BINDING';
  const localStaleWithAcknowledgedUpload =
    error?.stale === true && !remoteStale && acknowledged;
  const restartRequired = remoteStale
    || [
      'UPLOAD_EXPIRED',
      'UPLOAD_CANCELLED',
      'UPLOAD_NOT_FOUND',
      'UPLOAD_NOT_WRITABLE'
    ].includes(error?.code)
    || (error?.stale === true && !localStaleWithAcknowledgedUpload);
  return Object.freeze({
    status: error?.stale === true && !localStaleWithAcknowledgedUpload
      ? 'stale'
      : 'error',
    restartRequired,
    preserveForCancellation: localStaleWithAcknowledgedUpload
  });
}

function notifyCommunitySermonMediaProgress(
  reference,
  status,
  progress = null,
  error = null,
  {
    restartRequired = false,
    resumeEligible = true
  } = {}
) {
  if (!controlWindow || controlWindow.isDestroyed()) return;
  try {
    controlWindow.webContents.send('community:sermonMedia:progress', {
      projectId: reference.projectId,
      revisionId: reference.expectedProjectRevisionId,
      itemId: reference.itemId,
      status: [
        'uploading',
        'cancelling',
        'complete',
        'cancelled',
        'stale',
        'error'
      ].includes(status)
        ? status
        : 'error',
      canCancel: communitySermonMediaCanCancel({
        status,
        progress,
        restartRequired
      }),
      canUpload: status === 'cancelled'
        || (status === 'error' && restartRequired),
      canResume: status === 'error'
        && !restartRequired
        && resumeEligible !== false,
      progress: publicCommunitySermonMediaProgress(progress),
      error: error ? publicCommunityError(error) : null
    });
  } catch (sendError) {
    console.warn(
      '[Community] Could not publish sermon-media progress:',
      sendError.message
    );
  }
}

function communitySermonMediaReference(request, label = 'Sermon-media upload') {
  requirePrepareRequest(request, 8 * 1024);
  requireExactPrepareKeys(request, [
    'projectId',
    'expectedRevisionId',
    'itemId'
  ], label);
  return Object.freeze({
    projectId: prepareId(request.projectId, 'Service project'),
    expectedProjectRevisionId: prepareRevision(
      request.expectedRevisionId,
      'Expected service revision'
    ),
    itemId: prepareId(request.itemId, 'Service item')
  });
}

async function resolveLocalSermonMediaUploadBinding(reference) {
  const current = await readExpectedProject({
    projectId: reference.projectId,
    expectedRevisionId: reference.expectedProjectRevisionId
  });
  const item = current.project.items[reference.itemId];
  if (!isSermonSourceTarget(current.project, item)) {
    failMainOperation(
      'INVALID_SERMON_SOURCE_ITEM',
      'Choose a linked sermon cue or sermon outline group before uploading its recording.'
    );
  }
  const linked = resolveSermonSourceLink(current.project, item);
  if (!linked) {
    failMainOperation(
      'SERMON_SOURCE_NOT_LINKED',
      'That service item is not linked to a sermon packet.'
    );
  }
  const document = linked.resource.document;
  const recordingId = `post-service:recording:${document.defaultLanguage}`;
  const recording = (Array.isArray(document.media) ? document.media : [])
    .find(candidate => candidate?.id === recordingId) || null;
  if (!recording
    || recording.kind !== 'audio'
    || !['audio/mpeg', 'audio/mp4'].includes(recording.mediaType)
    || !/^[a-f0-9]{64}$/u.test(String(recording.sha256 || ''))
    || !Number.isSafeInteger(recording.sizeBytes)
    || recording.sizeBytes < 1
    || recording.sizeBytes > 1_073_741_824
    || recording.durationSeconds !== null) {
    failMainOperation(
      'SERMON_MEDIA_NOT_ELIGIBLE',
      'Choose and verify an MP3 or M4A recording before uploading it privately.'
    );
  }

  let currentLibrary;
  try {
    currentLibrary = await current.services.localSermonLibrary.read(document.id);
  } catch (error) {
    if (error?.code === 'SERMON_NOT_FOUND') {
      failMainOperation(
        'SERMON_MEDIA_STALE',
        'This sermon is no longer available in the local library. Relink it before uploading.',
        { stale: true }
      );
    }
    throw error;
  }
  if (currentLibrary.revision !== linked.resource.sha256) {
    failMainOperation(
      'SERMON_MEDIA_STALE',
      'This service is pinned to an older sermon revision. Link the current local revision before uploading.',
      {
        stale: true,
        currentSermonRevisionId: currentLibrary.revision,
        expectedSermonRevisionId: linked.resource.sha256
      }
    );
  }

  return Object.freeze({
    current,
    linked,
    document,
    recording: Object.freeze({
      id: recording.id,
      kind: 'audio',
      language: document.defaultLanguage,
      mediaType: recording.mediaType,
      fileName: recording.fileName,
      sha256: recording.sha256,
      sizeBytes: recording.sizeBytes,
      durationSeconds: null
    })
  });
}

async function communitySermonMediaRecoveryAccess({
  refreshCapabilities = true
} = {}) {
  const summary = await currentCommunityConnectionSummary({
    refreshCapabilities
  });
  if (!summary
    || communityConnectionExpired(summary)
    || communityReconnectRequired) {
    failMainOperation(
      'COMMUNITY_RECONNECT_REQUIRED',
      'Connect Heritage Community before managing a private sermon recording upload.'
    );
  }
  if (!summary.canReadSermons) {
    failMainOperation(
      'COMMUNITY_PERMISSION_DENIED',
      'This Community approval cannot read managed sermon uploads.'
    );
  }
  const { connectionStore } = await getCommunityServices();
  const connection = await connectionStore.getConnection(summary.id);
  if (!connection || communityConnectionExpired(connection)) {
    failMainOperation(
      'COMMUNITY_RECONNECT_REQUIRED',
      'This Community approval expired. Connect this computer again.'
    );
  }
  const client = communityClientForConnection(connection);
  const discovery = await client.discover({ force: refreshCapabilities });
  const identityError = communityDiscoveryIdentityError(connection, discovery);
  if (identityError) {
    failMainOperation(identityError.code, identityError.message);
  }
  const resource = discovery.resources?.sermonMedia || null;
  if (!resource) {
    failMainOperation(
      'SERMON_MEDIA_UPLOAD_UNAVAILABLE',
      'This Community server does not offer managed sermon-recording upload. Local playback and reviewed external recording links remain available.'
    );
  }
  if (!connection.canReadSermonMedia || !connection.canWriteSermonMedia) {
    failMainOperation(
      'SERMON_MEDIA_REAPPROVAL_REQUIRED',
      'Enable private recording upload and approve the added Community permissions before continuing.'
    );
  }
  return Object.freeze({
    connection,
    resource,
    services: getPrepareServices()
  });
}

async function communitySermonMediaContext(reference, {
  requireGrant = true,
  refreshCapabilities = true
} = {}) {
  const local = await resolveLocalSermonMediaUploadBinding(reference);
  const access = await communitySermonMediaRecoveryAccess({
    refreshCapabilities
  });
  if (!access.resource.acceptedMediaTypes.includes(local.recording.mediaType)
    || local.recording.sizeBytes > access.resource.maximumBytes) {
    failMainOperation(
      'SERMON_MEDIA_NOT_ELIGIBLE',
      'This verified recording does not fit the Community managed-upload contract.'
    );
  }
  if (requireGrant
    && (!access.connection.canReadSermonMedia
      || !access.connection.canWriteSermonMedia)) {
    failMainOperation(
      'SERMON_MEDIA_REAPPROVAL_REQUIRED',
      'Enable private recording upload and approve the added Community permissions before continuing.'
    );
  }
  const { stateStore } = await getCommunityServices();
  const sermonState = await stateStore.getSermonState(
    access.connection.id,
    local.document.id
  );
  if (!Number.isSafeInteger(sermonState?.syncVersion)
    || sermonState.syncVersion < 1
    || sermonState.remoteRevision !== local.linked.resource.sha256
    || sermonState.localRevision !== local.linked.resource.sha256
    || sermonState.conflict) {
    failMainOperation(
      'SERMON_MEDIA_NOT_SYNCHRONIZED',
      'Save this exact sermon revision to Community and resolve any sermon conflict before uploading its recording.'
    );
  }
  return Object.freeze({
    connection: access.connection,
    resource: access.resource,
    stateStore,
    services: local.current.services,
    binding: Object.freeze({
      projectId: local.current.project.id,
      projectRevisionId: local.current.revisionId,
      itemId: reference.itemId,
      sermonId: local.document.id,
      sermonRevisionId: local.linked.resource.sha256,
      expectedSyncVersion: sermonState.syncVersion,
      expectedCurrentRevision: sermonState.remoteRevision,
      recording: local.recording
    })
  });
}

function communitySermonMediaUploader(context, reference) {
  return new CommunitySermonMediaUpload({
    client: new CommunityBinaryClient({
      baseUrl: context.connection.baseUrl,
      endpoint: context.resource.endpoint,
      accessToken: context.connection.accessToken
    }),
    mediaStore: context.services.localSermonMediaStore,
    resolveBinding: async () => (
      await communitySermonMediaContext(reference, {
        requireGrant: true,
        refreshCapabilities: false
      })
    ).binding
  });
}

function communitySermonMediaAttemptIdentity(context) {
  return Object.freeze({
    serverId: context.connection.baseUrl,
    communityId: context.connection.serverId
  });
}

function communitySermonMediaAttemptKey(context) {
  return sermonMediaAttemptBindingKey(
    context.binding,
    communitySermonMediaAttemptIdentity(context)
  );
}

function communitySermonMediaRecoveryLocator(reference, context) {
  return sermonMediaAttemptRecoveryLocator({
    projectId: reference.projectId,
    itemId: reference.itemId
  }, communitySermonMediaAttemptIdentity(context));
}

function communitySermonMediaObservedAttemptKey(upload, identity) {
  return sermonMediaAttemptBindingKey({
    sermonId: upload.sermon.syncId,
    sermonRevisionId: upload.sermon.currentRevision,
    expectedSyncVersion: upload.sermon.syncVersion,
    expectedCurrentRevision: upload.sermon.currentRevision,
    recording: upload.recording
  }, identity);
}

async function recoverCommunitySermonMediaOperation(reference, {
  context = null,
  expectedAttemptKey = null,
  allowBindinglessCompletionRecovery = false
} = {}) {
  const key = communitySermonMediaOperationKey(reference);
  const existing = communitySermonMediaUploads.get(key);
  if (existing?.status === 'recovering') {
    return existing.recoveryPromise;
  }
  if (existing) return existing;

  const reservation = {
    status: 'recovering',
    recoveryPromise: null
  };
  reservation.recoveryPromise = (async () => {
    const resolved = context || await communitySermonMediaRecoveryAccess({
      refreshCapabilities: true
    });
    const attemptStore =
      resolved.services.communitySermonMediaAttemptStore;
    const identity = communitySermonMediaAttemptIdentity(resolved);
    const locator = communitySermonMediaRecoveryLocator(reference, resolved);
    const candidates = [
      ...await attemptStore.readRecoverable(locator)
    ];
    if (expectedAttemptKey) {
      const exact = await attemptStore.readAttempt(expectedAttemptKey);
      if (exact
        && !exact.terminal
        && exact.binding
        && !candidates.some(candidate =>
          candidate.attemptKey === expectedAttemptKey)) {
        candidates.unshift(Object.freeze({
          attemptKey: expectedAttemptKey,
          ...exact
        }));
      }
    }
    const uploader = communitySermonMediaUploader(resolved, reference);
    for (const attempt of candidates) {
      let inspected;
      try {
        if (attempt.uploadId) {
          inspected = await uploader.inspect(attempt.uploadId);
        } else {
          inspected = await uploader.recoverInit(
            attempt.binding,
            attempt.attemptId
          );
          await attemptStore.acknowledgeUpload(
            attempt.attemptKey,
            attempt.attemptId,
            inspected.upload.id
          );
        }
      } catch (error) {
        if ([
          'UPLOAD_EXPIRED',
          'UPLOAD_CANCELLED',
          'SERMON_MEDIA_STALE',
          'UPLOAD_NOT_FOUND'
        ].includes(error?.code)) {
          await attemptStore.markTerminal(
            attempt.attemptKey,
            attempt.attemptId
          );
          continue;
        }
        throw error;
      }
      if (communitySermonMediaObservedAttemptKey(
        inspected.upload,
        identity
      ) !== attempt.attemptKey) {
        failMainOperation(
          'INVALID_RESPONSE',
          'Community returned a different recording for a saved private upload.'
        );
      }
      if ([
        'cancelled',
        'expired',
        'internal',
        'superseded'
      ].includes(inspected.upload.state)) {
        await attemptStore.markTerminal(
          attempt.attemptKey,
          attempt.attemptId
        );
        continue;
      }
      if (inspected.upload.state === 'complete'
        && attempt.attemptKey !== expectedAttemptKey) {
        continue;
      }
      const complete = inspected.upload.state === 'complete';
      const uploadId = inspected.upload.id;
      const resumeEligible =
        attempt.attemptKey === expectedAttemptKey
        || (
          allowBindinglessCompletionRecovery
          && (
            inspected.upload.state === 'finalizing'
            || communitySermonMediaRemoteBytesComplete(inspected.progress)
          )
        );
      const recovered = {
        status: complete ? 'complete' : 'error',
        controller: null,
        uploader,
        uploadId,
        progress: inspected.progress,
        error: complete
          ? null
          : {
              code: 'SERMON_MEDIA_UPLOAD_PAUSED',
              message: resumeEligible
                ? 'A previously acknowledged private upload is paused. Resume it or cancel its Community staging copy.'
                : 'An earlier sermon binding still has private Community staging. Cancel it before starting the changed recording.'
            },
        promise: null,
        started: Promise.resolve(),
        attemptKey: attempt.attemptKey,
        attemptId: attempt.attemptId,
        attemptStore,
        attemptIdentity: identity,
        recoveryLocator: locator,
        recoveryBinding: attempt.binding,
        resumeEligible,
        restartRequired: false,
        recovered: true
      };
      if (communitySermonMediaUploads.get(key) === reservation) {
        communitySermonMediaUploads.set(key, recovered);
        return recovered;
      }
      return communitySermonMediaUploads.get(key) || null;
    }
    return null;
  })();
  communitySermonMediaUploads.set(key, reservation);
  try {
    return await reservation.recoveryPromise;
  } finally {
    if (communitySermonMediaUploads.get(key) === reservation) {
      communitySermonMediaUploads.delete(key);
    }
  }
}

async function communitySermonMediaAvailability(reference) {
  let local;
  let localMediaError = null;
  try {
    local = await resolveLocalSermonMediaUploadBinding(reference);
    await local.current.services.localSermonMediaStore.checkMedia(local.recording);
  } catch (error) {
    localMediaError = error;
  }

  const summary = await currentCommunityConnectionSummary({
    refreshCapabilities: true
  });
  if (!summary
    || communityConnectionExpired(summary)
    || communityReconnectRequired
    || !summary.canReadSermons) {
    return {
      status: 'reconnect-required',
      message:
        'Connect Community with sermon read access before enabling private recording upload.',
      canUpload: false,
      canEnable: false,
      progress: null
    };
  }
  const { connectionStore } = await getCommunityServices();
  const connection = await connectionStore.getConnection(summary.id);
  if (!connection || communityConnectionExpired(connection)) {
    return {
      status: 'reconnect-required',
      message:
        'Reconnect Community before enabling private recording upload.',
      canUpload: false,
      canEnable: false,
      progress: null
    };
  }
  const discovery = await communityClientForConnection(connection)
    .discover({ force: true });
  const identityError = communityDiscoveryIdentityError(connection, discovery);
  if (identityError) {
    failMainOperation(identityError.code, identityError.message);
  }
  const resource = discovery.resources?.sermonMedia || null;
  if (!resource) {
    return {
      status: 'unavailable',
      message:
        'Managed upload is unavailable on this Community server. Local playback and reviewed external recording links still work.',
      canUpload: false,
      canEnable: false,
      progress: null
    };
  }
  if (!connection.canReadSermonMedia || !connection.canWriteSermonMedia) {
    return {
      status: 'reapproval-required',
      message:
        'Private upload is available but not approved for this computer. Enable it to review the added permissions.',
      canUpload: false,
      canEnable: true,
      progress: null
    };
  }
  let context;
  let contextError = null;
  try {
    context = await communitySermonMediaContext(reference, {
      requireGrant: true,
      refreshCapabilities: false
    });
  } catch (error) {
    if ([
      'SERMON_MEDIA_NOT_SYNCHRONIZED',
      'SERMON_MEDIA_NOT_ELIGIBLE',
      'SERMON_MEDIA_STALE',
      'SERMON_SOURCE_NOT_LINKED',
      'INVALID_SERMON_SOURCE_ITEM'
    ].includes(error?.code)) {
      contextError = error;
    } else {
      throw error;
    }
  }
  const recoveryContext = context || Object.freeze({
    connection,
    resource,
    services: local?.current?.services || getPrepareServices()
  });
  const active = await recoverCommunitySermonMediaOperation(reference, {
    context: recoveryContext,
    expectedAttemptKey: context
      ? communitySermonMediaAttemptKey(context)
      : null,
    allowBindinglessCompletionRecovery: Boolean(localMediaError)
  });
  if (localMediaError) {
    if (active?.status === 'complete') {
      return {
        status: 'complete',
        message:
          'The verified recording is stored privately in Community. A manager must still review and publish the sermon separately.',
        canUpload: false,
        canEnable: false,
        canResume: false,
        canCancel: false,
        progress: publicCommunitySermonMediaProgress(active.progress)
      };
    }
    if (communitySermonMediaCanResumeWithoutLocal(active)) {
      const finalizing = active.progress?.phase === 'finalizing';
      const canCancel = communitySermonMediaCanCancel({
        status: active.status,
        progress: active.progress,
        uploadId: active.uploadId,
        restartRequired: active.restartRequired
      });
      return {
        status: active.status,
        message: finalizing
          ? 'Community is still securing the private recording. Resume to continue checking it; the missing local file is no longer needed and cancellation is unavailable during finalization.'
          : 'Community already has every verified recording chunk. Resume to secure it without the missing local file, or cancel its staging upload.',
        canUpload: false,
        canEnable: false,
        canResume: true,
        canCancel,
        progress: publicCommunitySermonMediaProgress(active.progress)
      };
    }
    const canCancel = communitySermonMediaCanCancel({
      status: active?.status,
      progress: active?.progress,
      uploadId: active?.uploadId,
      restartRequired: active?.restartRequired
    });
    return {
      status: 'local-error',
      message: canCancel
        ? 'The private local recording could not be verified. Restore or replace it to resume; the previously acknowledged Community staging upload can still be cancelled.'
        : 'The private local recording could not be verified. Restore or replace it before uploading.',
      canUpload: false,
      canEnable: false,
      canResume: false,
      canCancel,
      progress: publicCommunitySermonMediaProgress(active?.progress)
    };
  }
  if (contextError && !active) {
    return {
      status: contextError.code === 'SERMON_MEDIA_NOT_SYNCHRONIZED'
        ? 'sermon-not-synced'
        : 'local-error',
      message: contextError.message,
      canUpload: false,
      canEnable: false,
      canResume: false,
      canCancel: false,
      progress: null
    };
  }
  return {
    status: active?.status || 'ready',
    message: active?.status === 'complete'
      ? 'The verified recording is stored privately in Community. A manager must still review and publish the sermon separately.'
      : active?.status === 'uploading'
        ? active.progress?.phase === 'finalizing'
          ? 'Securing the private recording in Community… cancellation is unavailable during finalization.'
          : 'Private recording upload is in progress.'
        : active?.status === 'cancelling'
          ? 'Cancelling the private recording upload with Community…'
        : active?.status === 'stale'
          ? 'The service, sermon, or recording changed. Reload before starting a new upload.'
        : active?.status === 'error'
            ? active.progress?.phase === 'finalizing'
              ? 'Community is still securing the private recording. Resume to continue checking it; cancellation is unavailable during finalization.'
              : active.resumeEligible === false
                ? 'The local service or recording changed after Community acknowledged its staging upload. Cancel that private staging copy before starting again.'
              : active.restartRequired
              ? `${
                  active.error?.message
                    || 'The prior private upload cannot continue.'
                } Start a new upload explicitly.`
              : active.error?.message
                || 'The private upload paused. Resume it explicitly.'
            : 'Ready to upload this verified recording privately. Nothing starts until you click Upload.',
    canUpload: !active
      || active.status === 'cancelled'
      || (active.status === 'error' && active.restartRequired === true),
    canEnable: false,
    canResume: active?.status === 'error'
      && active.restartRequired !== true
      && active.resumeEligible !== false,
    canCancel: communitySermonMediaCanCancel({
      status: active?.status,
      progress: active?.progress,
      uploadId: active?.uploadId,
      restartRequired: active?.restartRequired
    }),
    progress: publicCommunitySermonMediaProgress(active?.progress)
  };
}

function communityDiscoveryIdentityError(connection, discovery) {
  const savedOrigin = new URL(connection.baseUrl).origin;
  const discoveredOrigin = new URL(discovery.baseUrl).origin;
  if (connection.serverId !== discovery.serverId || savedOrigin !== discoveredOrigin) {
    return {
      code: 'COMMUNITY_SERVER_IDENTITY_CHANGED',
      message: 'The connected Community server identity changed. Connect this computer again before syncing any Community resources.'
    };
  }

  const savedApiBase = new URL(connection.apiBaseUrl);
  const discoveredApiBase = new URL(discovery.apiBaseUrl);
  const savedApiPath = savedApiBase.pathname.replace(/\/+$/, '');
  const discoveredApiPath = discoveredApiBase.pathname.replace(/\/+$/, '');
  if (savedApiBase.origin !== discoveredApiBase.origin
    || savedApiPath !== discoveredApiPath) {
    return {
      code: 'COMMUNITY_API_NAMESPACE_CHANGED',
      message: 'The connected Community server moved its SyncShow API namespace. Connect this computer again before syncing any Community resources.'
    };
  }
  return null;
}

async function refreshCommunityConnectionCapabilities(connection) {
  let discovery;
  try {
    discovery = await communityClientForConnection(connection).discover({ force: true });
  } catch (error) {
    if ([
      'NETWORK_ERROR',
      'REQUEST_TIMEOUT',
      'SERVER_UNAVAILABLE',
      'RATE_LIMITED'
    ].includes(error?.code)) {
      return connection;
    }
    if (!['SYNC_UNSUPPORTED', 'INVALID_DISCOVERY'].includes(error?.code)) throw error;
    discovery = null;
  }

  if (discovery) {
    const identityError = communityDiscoveryIdentityError(connection, discovery);
    if (identityError) {
      communityReconnectRequired = identityError;
      communityCapabilityWarning = null;
      communitySyncAbortController?.abort();
      clearCommunitySyncTimer();
      clearCommunityPeriodicSync();
      clearCommunityServicePlanAuthorities();
      await notifyCommunityStatusChanged();
      return connection;
    }
  }

  const advertisedScopes = discovery
    ? communityAuthorizationScopes(discovery, {
        includeSermonMedia:
          connection.scopes?.includes('syncshow:sermon-media:read') === true
          || connection.scopes?.includes('syncshow:sermon-media:write') === true
      })
    : [];
  const previousScopes = connection.advertisedScopes || connection.scopes || [];
  if (sameCommunityScopes(previousScopes, advertisedScopes)) return connection;

  const { connectionStore } = await getCommunityServices();
  let updated;
  try {
    updated = await connectionStore.updateAdvertisedScopes(connection.id, {
      advertisedScopes,
      expectedUpdatedAt: connection.updatedAt
    });
  } catch (error) {
    if (error?.code !== 'CONNECTION_CONFLICT') throw error;
    updated = await connectionStore.getConnectionSummary(connection.id);
  }
  communityCapabilityWarning = communityCapabilityWarningMessage(
    updated?.scopes || connection.scopes,
    updated?.advertisedScopes || advertisedScopes
  );
  clearCommunityServicePlanAuthorities();
  if (connection.canReadSongs && !updated?.canReadSongs) {
    clearCommunitySyncTimer();
    clearCommunityPeriodicSync();
  }
  if (connection.canReadSongPublicLinks && !updated?.canReadSongPublicLinks) {
    songPublicLinkReviewProposals.clear();
    songPublicLinkActions.clear();
  }
  await notifyCommunityStatusChanged();
  return updated || connection;
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
    familyImportCoordinator:
      getPrepareServices().communitySongFamilyImportCoordinator,
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

async function communitySermonSyncForConnection(connection) {
  const { stateStore, connectionStore } = await getCommunityServices();
  return new CommunitySermonSync({
    client: communityClientForConnection(connection),
    localLibrary: getPrepareServices().localSermonLibrary,
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

function publicCommunitySermonSyncResult(result) {
  const warnings = Array.isArray(result?.warnings)
    ? result.warnings.slice(0, 100).map(warning => {
        const safe = publicCommunityError(warning);
        const syncId = typeof warning?.syncId === 'string'
          && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(warning.syncId)
          ? warning.syncId
          : null;
        return {
          code: safe.code,
          message: safe.message,
          ...(syncId ? { syncId } : {})
        };
      })
    : [];
  return {
    status: ['synced', 'offline', 'conflict'].includes(result?.status)
      ? result.status
      : 'synced',
    pulled: Number.isSafeInteger(result?.pulled) && result.pulled >= 0
      ? result.pulled
      : 0,
    unchanged: Number.isSafeInteger(result?.unchanged) && result.unchanged >= 0
      ? result.unchanged
      : 0,
    conflicts: Number.isSafeInteger(result?.conflicts) && result.conflicts >= 0
      ? result.conflicts
      : (result?.status === 'conflict' ? 1 : 0),
    operation: ['created', 'updated', 'unchanged', 'adopted', 'conflict']
      .includes(result?.operation)
      ? result.operation
      : null,
    syncId: typeof result?.syncId === 'string'
      && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(result.syncId)
      ? result.syncId
      : null,
    revision: typeof result?.revision === 'string'
      && /^[a-f0-9]{64}$/.test(result.revision)
      ? result.revision
      : null,
    syncVersion: Number.isSafeInteger(result?.syncVersion) && result.syncVersion >= 1
      ? result.syncVersion
      : null,
    warnings
  };
}

async function runCommunitySongSync({
  syncId = null,
  visibility = null,
  publishAt = null,
  expectedSyncVersion = null,
  expectedFamilyRevision = null,
  expectedReviewRevision = null,
  sharingReview = null,
  allowWrites = false
} = {}) {
  await recoverLocalSongFamilyCommit();
  const connection = await currentCommunityConnectionSummary({
    refreshCapabilities: true
  });
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
  if (visibility !== null && (!allowWrites || !connection.canWriteSongs)) {
    failMainOperation(
      'COMMUNITY_READ_ONLY',
      allowWrites
        ? 'This Community approval is read-only. Reconnect with a song editor account.'
        : 'Song changes are submitted only through the exact-family review.'
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
            allowWrites: allowWrites && connection.canWriteSongs === true,
            ...(visibility === null
              ? {}
              : {
                  visibilityForSong: () => ({
                    visibility,
                    publishAt,
                    expectedSyncVersion,
                    expectedFamilyRevision,
                    sharingReview: sharingReview
                      ? {
                          ...sharingReview,
                          expectedReviewRevision
                        }
                      : null
                  })
                })
          })
        : await sync.sync({
            signal: controller.signal,
            allowWrites: false
          });
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

async function runCommunitySermonPull() {
  const connection = await currentCommunityConnectionSummary({
    refreshCapabilities: true
  });
  if (communityReconnectRequired) {
    failMainOperation(
      'COMMUNITY_RECONNECT_REQUIRED',
      communityReconnectRequired.message
    );
  }
  if (!connection || communityConnectionExpired(connection)) {
    failMainOperation(
      'COMMUNITY_RECONNECT_REQUIRED',
      'Connect this computer to Heritage Community before syncing sermons.'
    );
  }
  if (!connection.canReadSermons) {
    failMainOperation(
      'COMMUNITY_PERMISSION_DENIED',
      'This Community approval cannot read the shared sermon library.'
    );
  }

  communitySyncAbortController?.abort();
  const controller = new AbortController();
  communitySyncAbortController = controller;
  const epoch = ++communityOperationEpoch;
  try {
    const sync = await communitySermonSyncForConnection(connection);
    let result;
    try {
      result = await sync.pull({ signal: controller.signal });
    } catch (error) {
      if (requireCommunityReconnectFor(error)) {
        await notifyCommunityStatusChanged();
      }
      throw error;
    }
    if (controller.signal.aborted || epoch !== communityOperationEpoch) {
      failMainOperation(
        'COMMUNITY_SYNC_CANCELLED',
        'Community sermon sync was cancelled.'
      );
    }
    communityLastSermonSyncSummary = completeCommunitySyncSummary({
      resource: 'sermons',
      ...publicCommunitySermonSyncResult(result)
    });
    await notifyCommunityStatusChanged();
    return communityLastSermonSyncSummary;
  } finally {
    if (communitySyncAbortController === controller) {
      communitySyncAbortController = null;
    }
  }
}

async function runCommunitySermonPush({
  sermonId,
  expectedSyncVersion,
  expectedLocalRevision
}) {
  const connection = await currentCommunityConnectionSummary({
    refreshCapabilities: true
  });
  if (communityReconnectRequired) {
    failMainOperation(
      'COMMUNITY_RECONNECT_REQUIRED',
      communityReconnectRequired.message
    );
  }
  if (!connection || communityConnectionExpired(connection)) {
    failMainOperation(
      'COMMUNITY_RECONNECT_REQUIRED',
      'Connect this computer to Heritage Community before saving a sermon there.'
    );
  }
  if (!connection.canWriteSermons) {
    failMainOperation(
      'COMMUNITY_READ_ONLY',
      'This Community approval cannot save sermons to Community.'
    );
  }

  communitySyncAbortController?.abort();
  const controller = new AbortController();
  communitySyncAbortController = controller;
  const epoch = ++communityOperationEpoch;
  try {
    const sync = await communitySermonSyncForConnection(connection);
    let result;
    try {
      result = await sync.pushSermon(sermonId, {
        syncId: sermonId,
        expectedSyncVersion,
        expectedLocalRevision,
        signal: controller.signal
      });
    } catch (error) {
      if (requireCommunityReconnectFor(error)) {
        await notifyCommunityStatusChanged();
      }
      throw error;
    }
    if (controller.signal.aborted || epoch !== communityOperationEpoch) {
      failMainOperation(
        'COMMUNITY_SYNC_CANCELLED',
        'Saving the sermon to Community was cancelled.'
      );
    }
    communityLastSermonSyncSummary = completeCommunitySyncSummary({
      resource: 'sermons',
      ...publicCommunitySermonSyncResult(result)
    });
    await notifyCommunityStatusChanged();
    return communityLastSermonSyncSummary;
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
    serializeCommunityOperation(async () => {
      const connection = await currentCommunityConnectionSummary();
      if (
        !connection
        || communityConnectionExpired(connection)
        || communityReconnectRequired
        || !connection.canReadSongs
      ) {
        return null;
      }
      return runCommunitySongSync();
    })
      .then(result => {
        if (!result) return;
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
    serializeCommunityOperation(async () => {
      const connection = await currentCommunityConnectionSummary();
      if (
        !connection
        || communityConnectionExpired(connection)
        || communityReconnectRequired
        || !connection.canReadSongs
      ) {
        return null;
      }
      return runCommunitySongSync();
    })
      .then(result => {
        if (generation !== communityPeriodicSyncGeneration) return;
        if (!result) {
          clearCommunityPeriodicSync();
          return;
        }
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
  await recoverLocalSongFamilyCommit();
  const id = prepareId(songId, 'Song');
  const library = getPrepareServices().localSongLibrary;
  const resolved = await library.withCurrentSnapshot(async session => {
    const local = await session.readCurrent(id);
    if (!local) {
      failMainOperation(
        'SONG_NOT_FOUND',
        `Song ${id} is not in the local library.`
      );
    }
    const familyId = local.song.translationOf || local.song.id;
    const snapshot = await session.snapshotFamily(familyId);
    const documents = [];
    for (const member of snapshot.documents) {
      documents.push(await session.readRevision(
        member.songId,
        member.revision
      ));
    }
    return { local, familyId, documents };
  });
  const { local, familyId, documents } = resolved;
  documents.sort((left, right) =>
    Number(Boolean(left.song.translationOf))
      - Number(Boolean(right.song.translationOf))
    || left.song.id.localeCompare(right.song.id));
  return {
    songId: id,
    familyId,
    local,
    documents,
    familyRevision: songFamilyRevision(documents),
    family: {
      id: familyId,
      documents: documents.map(document => ({
        id: document.song.id,
        title: document.song.title,
        language: document.song.language,
        role: document.song.translationOf ? 'translation' : 'original',
        revision: document.revision,
        license: document.song.license || null,
        source: document.song.source || null,
        attribution: document.song.attribution || null,
        authors: [...(document.song.authors || [])],
        translators: [...(document.song.translators || [])],
        composers: [...(document.song.composers || [])]
      }))
    }
  };
}

function communityRemoteSongFamilyRevision(remote) {
  if (!Array.isArray(remote?.syncDocuments)
    || remote.syncDocuments.length < 1
    || remote.syncDocuments.length > 32) {
    failMainOperation(
      'COMMUNITY_SONG_FAMILY_MISMATCH',
      'Heritage Community did not return a complete exact song family.'
    );
  }
  const documents = remote.syncDocuments.map(document => {
    let song;
    try {
      song = parseSongDocument(document.source, {
        fileName: `${document.id}.md`
      });
    } catch (_error) {
      failMainOperation(
        'COMMUNITY_SONG_FAMILY_MISMATCH',
        'Heritage Community returned a song document that SyncShow could not verify.'
      );
    }
    if (song.id !== document.id) {
      failMainOperation(
        'COMMUNITY_SONG_FAMILY_MISMATCH',
        'A Community song document does not match its saved identity.'
      );
    }
    return {
      song,
      revision: document.revision
    };
  });
  const familyIds = new Set(documents.map(document =>
    document.song.translationOf || document.song.id));
  if (familyIds.size !== 1) {
    failMainOperation(
      'COMMUNITY_SONG_FAMILY_MISMATCH',
      'Heritage Community returned documents from more than one song family.'
    );
  }
  try {
    return songFamilyRevision(documents);
  } catch (_error) {
    failMainOperation(
      'COMMUNITY_SONG_FAMILY_MISMATCH',
      'Heritage Community returned documents from more than one exact song family.'
    );
  }
}

async function requireCommunitySongPublicLinkConnection({
  write = false,
  refreshCapabilities = true
} = {}) {
  const connection = await currentCommunityConnectionSummary({
    refreshCapabilities
  });
  if (!connection
    || communityConnectionExpired(connection)
    || communityReconnectRequired) {
    failMainOperation(
      'COMMUNITY_RECONNECT_REQUIRED',
      'Connect this computer to Heritage Community before managing public song links.'
    );
  }
  const advertised = new Set(connection.advertisedScopes || []);
  const granted = new Set(connection.scopes || []);
  if (!connection.canReadSongs || !connection.canReadSongPublicLinks) {
    if (advertised.has('syncshow:song-public-links:read')
      && !granted.has('syncshow:song-public-links:read')) {
      failMainOperation(
        'COMMUNITY_REAPPROVAL_REQUIRED',
        'Reconnect this computer to approve the newly offered public song-link access.'
      );
    }
    failMainOperation(
      'SONG_PUBLIC_LINKS_UNAVAILABLE',
      'This Heritage Community server has not enabled public song links for SyncShow.'
    );
  }
  if (write && !connection.canWriteSongPublicLinks) {
    if (advertised.has('syncshow:song-public-links:write')
      && !granted.has('syncshow:song-public-links:write')) {
      failMainOperation(
        'COMMUNITY_REAPPROVAL_REQUIRED',
        'Reconnect this computer to approve public song-link creation and revocation.'
      );
    }
    failMainOperation(
      'SONG_PUBLIC_LINKS_READ_ONLY',
      'This Community approval may view public song links but cannot create or revoke them.'
    );
  }
  return connection;
}

async function communitySongPublicLinkClient(connection) {
  const { connectionStore } = await getCommunityServices();
  const current = await connectionStore.getConnection(connection.id);
  if (!current
    || communityConnectionExpired(current)
    || current.id !== connection.id) {
    failMainOperation(
      'COMMUNITY_RECONNECT_REQUIRED',
      'This Community approval expired. Connect this computer again.'
    );
  }
  return {
    client: communityClientForConnection(current),
    accessToken: current.accessToken
  };
}

function pruneSongPublicLinkReviewProposals(now = Date.now(), {
  makeRoom = false
} = {}) {
  for (const [token, entry] of songPublicLinkReviewProposals) {
    if (!entry.applying && entry.expiresAt <= now) {
      songPublicLinkReviewProposals.delete(token);
    }
  }
  while (makeRoom
    && songPublicLinkReviewProposals.size
      >= SONG_PUBLIC_LINK_REVIEW_PROPOSAL_LIMIT) {
    const oldest = [...songPublicLinkReviewProposals.entries()]
      .filter(([, entry]) => !entry.applying)
      .sort((left, right) => left[1].createdAt - right[1].createdAt)[0];
    if (!oldest) {
      failMainOperation(
        'SONG_PUBLIC_LINK_REVIEW_BUSY',
        'Finish an open public-link review before starting another.'
      );
    }
    songPublicLinkReviewProposals.delete(oldest[0]);
  }
}

function holdSongPublicLinkReviewProposal(entry) {
  pruneSongPublicLinkReviewProposals(Date.now(), { makeRoom: true });
  const proposalToken = crypto.randomBytes(24).toString('hex');
  const createdAt = Date.now();
  const held = {
    ...entry,
    idempotencyKey: `song-public-link-create-${crypto.randomBytes(24).toString('base64url')}`,
    createdAt,
    expiresAt: createdAt + SONG_PUBLIC_LINK_REVIEW_PROPOSAL_TTL_MS,
    applying: false
  };
  songPublicLinkReviewProposals.set(proposalToken, held);
  return { proposalToken, entry: held };
}

function requireSongPublicLinkReviewProposal(value) {
  const proposalToken = communityText(
    value,
    'Song public-link review',
    80,
    { required: true }
  );
  if (!/^[a-f0-9]{48}$/.test(proposalToken)) {
    failMainOperation(
      'INVALID_SONG_PUBLIC_LINK_REVIEW',
      'That public-link review is invalid.'
    );
  }
  pruneSongPublicLinkReviewProposals();
  const entry = songPublicLinkReviewProposals.get(proposalToken);
  if (!entry || entry.expiresAt <= Date.now()) {
    songPublicLinkReviewProposals.delete(proposalToken);
    failMainOperation(
      'EXPIRED_SONG_PUBLIC_LINK_REVIEW',
      'That exact-family public-link review expired. Open a fresh review.'
    );
  }
  if (entry.applying) {
    failMainOperation(
      'SONG_PUBLIC_LINK_REVIEW_BUSY',
      'That public-link review is already being applied.'
    );
  }
  return { proposalToken, entry };
}

function pruneSongPublicLinkActions(now = Date.now(), {
  makeRoom = false
} = {}) {
  for (const [token, entry] of songPublicLinkActions) {
    if (!entry.applying && entry.expiresAt <= now) {
      songPublicLinkActions.delete(token);
    }
  }
  while (makeRoom && songPublicLinkActions.size >= SONG_PUBLIC_LINK_ACTION_LIMIT) {
    const oldest = [...songPublicLinkActions.entries()]
      .filter(([, entry]) => !entry.applying)
      .sort((left, right) => left[1].createdAt - right[1].createdAt)[0];
    if (!oldest) {
      failMainOperation(
        'SONG_PUBLIC_LINK_ACTION_BUSY',
        'Finish an open public-link action before loading more links.'
      );
    }
    songPublicLinkActions.delete(oldest[0]);
  }
}

function songPublicLinkStatus(link, now = Date.now()) {
  if (link?.status === 'revoked' || link?.revokedAt) return 'revoked';
  if (link?.status === 'expired'
    || (link?.expiresAt && Date.parse(link.expiresAt) <= now)) {
    return 'expired';
  }
  return 'active';
}

function ambiguousCommunitySongPublicLinkCreateError(error) {
  return [
    'INVALID_RESPONSE',
    'NETWORK_ERROR',
    'PUBLIC_LINK_NOT_APPLIED',
    'RATE_LIMITED',
    'REQUEST_TIMEOUT',
    'RESPONSE_TOO_LARGE',
    'SERVER_UNAVAILABLE',
    'UNSAFE_REDIRECT'
  ].includes(error?.code);
}

function holdSongPublicLinkAction({
  connectionId,
  songId,
  currentFamilyRevision,
  link
}) {
  const status = songPublicLinkStatus(link);
  if (status !== 'active' || typeof link?.shareUrl !== 'string') {
    return null;
  }
  pruneSongPublicLinkActions(Date.now(), { makeRoom: true });
  const actionToken = crypto.randomBytes(24).toString('hex');
  const createdAt = Date.now();
  songPublicLinkActions.set(actionToken, {
    connectionId,
    songId,
    currentFamilyRevision,
    link: { ...link },
    revokeIdempotencyKey:
      `song-public-link-revoke-${crypto.randomBytes(24).toString('base64url')}`,
    createdAt,
    expiresAt: createdAt + SONG_PUBLIC_LINK_ACTION_TTL_MS,
    applying: false
  });
  return actionToken;
}

function requireSongPublicLinkAction(value) {
  const actionToken = communityText(
    value,
    'Song public-link action',
    80,
    { required: true }
  );
  if (!/^[a-f0-9]{48}$/.test(actionToken)) {
    failMainOperation(
      'INVALID_SONG_PUBLIC_LINK_ACTION',
      'That public-link action is invalid.'
    );
  }
  pruneSongPublicLinkActions();
  const entry = songPublicLinkActions.get(actionToken);
  if (!entry || entry.expiresAt <= Date.now()) {
    songPublicLinkActions.delete(actionToken);
    failMainOperation(
      'EXPIRED_SONG_PUBLIC_LINK_ACTION',
      'That public-link action expired. Reload the current links.'
    );
  }
  if (entry.applying) {
    failMainOperation(
      'SONG_PUBLIC_LINK_ACTION_BUSY',
      'That public-link action is already in progress.'
    );
  }
  return { actionToken, entry };
}

function publicSongPublicLink(link, {
  actionToken = null,
  currentFamilyRevision = null
} = {}) {
  const status = songPublicLinkStatus(link);
  return {
    actionToken,
    status,
    label: link.label || null,
    createdAt: link.createdAt,
    expiresAt: link.expiresAt || null,
    revokedAt: link.revokedAt || null,
    familyRevision: link.familyRevision,
    songSyncVersion: link.songSyncVersion,
    olderVersion: typeof currentFamilyRevision === 'string'
      && link.familyRevision !== currentFamilyRevision,
    shareUrl: status === 'active' ? link.shareUrl : null
  };
}

async function exactCommunitySongForPublicLink(connection, local, {
  expectedSyncId = null,
  expectedSyncVersion = null
} = {}) {
  const { client, accessToken } = await communitySongPublicLinkClient(connection);
  const syncId = expectedSyncId || local.familyId;
  const remote = await client.getSong({
    syncId,
    accessToken
  });
  if (remote.archived) {
    failMainOperation(
      'COMMUNITY_SONG_ARCHIVED',
      'The Community song is archived and cannot receive a new public link.'
    );
  }
  if (expectedSyncVersion !== null
    && remote.syncVersion !== expectedSyncVersion) {
    failMainOperation(
      'STATE_CONFLICT',
      'The Community song changed after this public-link review opened.'
    );
  }
  if (communityRemoteSongFamilyRevision(remote) !== local.familyRevision) {
    failMainOperation(
      'COMMUNITY_SONG_FAMILY_MISMATCH',
      'The exact saved family on this Mac does not match Heritage Community. Sync and resolve any differences before creating another link.'
    );
  }
  return { client, accessToken, remote };
}

function pruneSongSharingReviewProposals(now = Date.now(), {
  makeRoom = false
} = {}) {
  for (const [token, entry] of songSharingReviewProposals) {
    if (!entry.applying && entry.expiresAt <= now) {
      songSharingReviewProposals.delete(token);
    }
  }
  while (makeRoom
    && songSharingReviewProposals.size >= SONG_SHARING_REVIEW_PROPOSAL_LIMIT) {
    const oldest = [...songSharingReviewProposals.entries()]
      .filter(([, entry]) => !entry.applying)
      .sort((left, right) => left[1].createdAt - right[1].createdAt)[0];
    if (!oldest) {
      failMainOperation(
        'SONG_SHARING_REVIEW_BUSY',
        'Finish an open song-sharing review before starting another.'
      );
    }
    songSharingReviewProposals.delete(oldest[0]);
  }
}

function communityPendingVisibilitySnapshot(value) {
  if (!value) return null;
  return {
    visibility: value.visibility,
    publishAt: value.publishAt ?? null,
    expectedSyncVersion: value.expectedSyncVersion ?? null
  };
}

function sameCommunityPendingVisibility(left, right) {
  const expected = communityPendingVisibilitySnapshot(left);
  const current = communityPendingVisibilitySnapshot(right);
  return expected?.visibility === current?.visibility
    && expected?.publishAt === current?.publishAt
    && expected?.expectedSyncVersion === current?.expectedSyncVersion;
}

function holdSongSharingReviewProposal(entry) {
  pruneSongSharingReviewProposals(Date.now(), { makeRoom: true });
  const proposalToken = crypto.randomBytes(24).toString('hex');
  const createdAt = Date.now();
  const held = {
    ...entry,
    createdAt,
    expiresAt: createdAt + SONG_SHARING_REVIEW_PROPOSAL_TTL_MS,
    applying: false
  };
  songSharingReviewProposals.set(proposalToken, held);
  return { proposalToken, entry: held };
}

function requireSongSharingReviewProposal(value) {
  const proposalToken = communityText(
    value,
    'Song sharing review',
    80,
    { required: true }
  );
  if (!/^[a-f0-9]{48}$/.test(proposalToken)) {
    failMainOperation(
      'INVALID_SONG_SHARING_REVIEW',
      'That song-sharing review is invalid.'
    );
  }
  pruneSongSharingReviewProposals();
  const entry = songSharingReviewProposals.get(proposalToken);
  if (!entry || entry.expiresAt <= Date.now()) {
    songSharingReviewProposals.delete(proposalToken);
    failMainOperation(
      'EXPIRED_SONG_SHARING_REVIEW',
      'That song family review expired. Open a fresh review before sharing.'
    );
  }
  if (entry.applying) {
    failMainOperation(
      'SONG_SHARING_REVIEW_BUSY',
      'That song family review is already being applied.'
    );
  }
  return { proposalToken, entry };
}

function findCommunitySongState(connectionState, familyId, songId = familyId) {
  return Object.values(connectionState.songs).find(song =>
    song.syncId === familyId
    || song.localFamilyId === familyId
    || Object.hasOwn(song.documents || {}, songId)
  ) || null;
}

function publicCommunitySongState(song, connection, {
  familyId,
  family = null,
  familyRevision = null,
  sharingReview = null,
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
  const reviewStatus = songSharingReviewStatus(sharingReview, {
    familyRevision,
    now: new Date()
  });
  const publicSharingReview = sharingReview
    ? {
        scope: sharingReview.scope,
        basis: sharingReview.basis,
        evidence: sharingReview.evidence,
        validUntil: sharingReview.validUntil,
        reviewedAt: sharingReview.reviewedAt,
        familyRevision: sharingReview.familyRevision,
        status: reviewStatus
      }
    : { status: reviewStatus };
  const memberSharing = song?.memberSharing
    ? {
        receiptVersion: song.memberSharing.receiptVersion,
        songSyncVersion: song.memberSharing.songSyncVersion,
        familyRevision: song.memberSharing.familyRevision,
        reviewRevision: song.memberSharing.reviewRevision,
        visibility: song.memberSharing.visibility,
        publishAt: song.memberSharing.publishAt,
        timeZone: song.memberSharing.timeZone,
        validThrough: song.memberSharing.validThrough,
        reviewedAt: song.memberSharing.reviewedAt,
        confirmedAt: song.memberSharing.confirmedAt,
        receiptRevision: song.memberSharing.receiptRevision
      }
    : null;
  return {
    connected: Boolean(connection),
    canReadSongs: connection?.canReadSongs === true,
    canWriteSongs: connection?.canWriteSongs === true,
    canReadSongPublicLinks: connection?.canReadSongPublicLinks === true,
    canWriteSongPublicLinks: connection?.canWriteSongPublicLinks === true,
    exists: hasRemote,
    status,
    syncId: song?.syncId || familyId,
    localFamilyId: song?.localFamilyId || familyId,
    syncVersion: song?.syncVersion ?? null,
    visibility: pending?.visibility || song?.visibility || 'private',
    publishAt: pending?.publishAt || song?.publishAt || null,
    confirmedVisibility: song?.visibility || 'private',
    confirmedPublishAt: song?.publishAt || null,
    effectiveVisibility:
      ['private', 'public'].includes(song?.effectiveVisibility)
        ? song.effectiveVisibility
        : null,
    memberSharing,
    pendingVisibility: pending
      ? {
          visibility: pending.visibility,
          publishAt: pending.publishAt
        }
      : null,
    archived: song?.archived === true,
    conflict,
    lastSyncedAt: song?.lastSyncedAt || null,
    family: family
      ? {
          id: family.id,
          revision: familyRevision,
          documents: family.documents.map(document => ({ ...document }))
        }
      : null,
    sharingReview: {
      ...publicSharingReview,
      authority: 'local-draft'
    }
  };
}

async function communitySongStatePayload(songId) {
  const local = await resolveCommunitySongFamily(songId);
  const connection = await currentCommunityConnectionSummary();
  const activeConnection = connection
    && !communityConnectionExpired(connection)
    && !communityReconnectRequired
    ? connection
    : null;
  if (!activeConnection) {
    return publicCommunitySongState(null, null, {
      familyId: local.familyId,
      family: local.family,
      familyRevision: local.familyRevision,
      exists: false
    });
  }
  if (!activeConnection.canReadSongs) {
    return publicCommunitySongState(null, activeConnection, {
      familyId: local.familyId,
      family: local.family,
      familyRevision: local.familyRevision,
      exists: false
    });
  }
  const { stateStore } = await getCommunityServices();
  const state = await stateStore.getConnectionState(activeConnection.id);
  const song = findCommunitySongState(state, local.familyId, local.songId);
  return publicCommunitySongState(song, activeConnection, {
    familyId: local.familyId,
    family: local.family,
    familyRevision: local.familyRevision,
    sharingReview: Object.hasOwn(state.songSharingReviews, local.familyId)
      ? state.songSharingReviews[local.familyId]
      : null
  });
}

function emptyPublicCommunitySermonPublication(status) {
  return Object.freeze({
    status,
    publicId: null,
    publishedAt: null,
    publicationVersion: null
  });
}

function publicCommunitySermonPublicationState(publication, {
  expectedSermonId = null,
  unavailableStatus = 'unsupported'
} = {}) {
  if (!publication) {
    return emptyPublicCommunitySermonPublication(unavailableStatus);
  }
  const hashPattern = /^[a-f0-9]{64}$/;
  const publicIdPattern = /^[a-z0-9][a-z0-9._-]{0,95}$/;
  const timestampPattern =
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
  const publicationVersion = publication.publicationVersion;
  const validPublicationVersion = publicationVersion === null
    || (Number.isSafeInteger(publicationVersion) && publicationVersion >= 1);
  const validIdentity = typeof publication.syncId === 'string'
    && (!expectedSermonId || publication.syncId === expectedSermonId);
  const validCurrentRevision = typeof publication.currentRevision === 'string'
    && hashPattern.test(publication.currentRevision);
  const validSyncVersion = Number.isSafeInteger(publication.syncVersion)
    && publication.syncVersion >= 1;
  if (
    !validPublicationVersion
    || !validIdentity
    || !validCurrentRevision
    || !validSyncVersion
  ) {
    return emptyPublicCommunitySermonPublication('unavailable');
  }

  if (publication.publicRevision === null) {
    if (publication.publicId !== null || publication.publishedAt !== null) {
      return emptyPublicCommunitySermonPublication('unavailable');
    }
    return Object.freeze({
      status: publicationVersion === null ? 'never-published' : 'withdrawn',
      publicId: null,
      publishedAt: null,
      publicationVersion
    });
  }

  const validPublicRevision = typeof publication.publicRevision === 'string'
    && hashPattern.test(publication.publicRevision);
  const validPublicId = typeof publication.publicId === 'string'
    && publicIdPattern.test(publication.publicId);
  const validPublishedAt = typeof publication.publishedAt === 'string'
    && timestampPattern.test(publication.publishedAt)
    && Number.isFinite(Date.parse(publication.publishedAt))
    && new Date(publication.publishedAt).toISOString() === publication.publishedAt;
  if (
    !validPublicRevision
    || !validPublicId
    || !validPublishedAt
    || publicationVersion === null
  ) {
    return emptyPublicCommunitySermonPublication('unavailable');
  }
  return Object.freeze({
    status: publication.publicRevision === publication.currentRevision
      ? 'published-current'
      : 'published-older',
    publicId: publication.publicId,
    publishedAt: publication.publishedAt,
    publicationVersion
  });
}

function observeCommunitySermonPublicationVersion({
  connectionId,
  sermonId,
  publicationVersion
}) {
  const key = `${connectionId}\u0000${sermonId}`;
  const previous = communitySermonPublicationVersions.get(key);
  if (
    previous !== undefined
    && (
      (previous !== null && publicationVersion === null)
      || (
        previous !== null
        && publicationVersion !== null
        && publicationVersion < previous
      )
    )
  ) {
    return false;
  }
  communitySermonPublicationVersions.delete(key);
  communitySermonPublicationVersions.set(key, publicationVersion);
  while (
    communitySermonPublicationVersions.size
    > COMMUNITY_SERMON_PUBLICATION_VERSION_LIMIT
  ) {
    communitySermonPublicationVersions.delete(
      communitySermonPublicationVersions.keys().next().value
    );
  }
  return true;
}

function publicCommunitySermonState(sermon, connection, {
  sermonId,
  currentLocalRevision = null,
  publicationState = null,
  remoteStateAhead = false
} = {}) {
  const hasRemote = Number.isSafeInteger(sermon?.syncVersion)
    && sermon.syncVersion >= 1;
  const conflict = sermon?.conflict
    ? {
        code: sermon.conflict.code,
        detectedAt: sermon.conflict.detectedAt,
        remoteSyncVersion: sermon.conflict.remoteSyncVersion
      }
    : null;
  const localChanged = Boolean(
    hasRemote
    && currentLocalRevision
    && sermon?.localRevision
    && currentLocalRevision !== sermon.localRevision
  );
  const missingBaseline = Boolean(
    hasRemote
    && currentLocalRevision
    && !sermon?.localRevision
  );
  let status = 'not-found';
  if (conflict) status = 'conflict';
  else if (remoteStateAhead && hasRemote) status = 'needs-review';
  else if (!currentLocalRevision && hasRemote) status = 'remote-only';
  else if (missingBaseline) status = 'needs-review';
  else if (localChanged) status = 'local-changed';
  else if (hasRemote) status = 'synced';
  else if (currentLocalRevision) status = 'local-only';
  return {
    connected: Boolean(connection),
    canReadSermons: connection?.canReadSermons === true,
    canWriteSermons: connection?.canWriteSermons === true,
    canReadSermonPublications:
      connection?.canReadSermonPublications === true,
    exists: hasRemote,
    status,
    syncId: sermon?.syncId || sermonId,
    syncVersion: hasRemote ? sermon.syncVersion : null,
    localRevision: currentLocalRevision,
    conflict,
    lastSyncedAt: sermon?.lastSyncedAt || null,
    publication: {
      status: publicationState?.status || 'unsupported',
      publicId: publicationState?.publicId || null,
      publishedAt: publicationState?.publishedAt || null,
      publicationVersion: Number.isSafeInteger(
        publicationState?.publicationVersion
      )
        ? publicationState.publicationVersion
        : null
    }
  };
}

async function communitySermonStatePayload(sermonId) {
  let currentLocalRevision = null;
  try {
    const local = await getPrepareServices().localSermonLibrary.read(sermonId);
    currentLocalRevision = local.revision;
  } catch (error) {
    if (error?.code !== 'SERMON_NOT_FOUND') throw error;
  }

  const connection = await currentCommunityConnectionSummary();
  if (!connection || communityConnectionExpired(connection) || communityReconnectRequired) {
    return publicCommunitySermonState(null, null, {
      sermonId,
      currentLocalRevision
    });
  }
  if (!connection.canReadSermons) {
    return publicCommunitySermonState(null, connection, {
      sermonId,
      currentLocalRevision
    });
  }
  const { stateStore, connectionStore } = await getCommunityServices();
  const sermon = await stateStore.getSermonState(connection.id, sermonId);
  let publicationState = publicCommunitySermonPublicationState(null);
  let remoteStateAhead = false;
  if (connection.canReadSermonPublications) {
    publicationState = publicCommunitySermonPublicationState(null, {
      unavailableStatus: 'unavailable'
    });
    try {
      const current = await connectionStore.getConnection(connection.id);
      if (!current || communityConnectionExpired(current)) {
        failMainOperation(
          'AUTH_REQUIRED',
          'This Community approval expired. Connect this computer again.'
        );
      }
      const publication = await communityClientForConnection(current)
        .getSermonPublication({
          syncId: sermonId,
          accessToken: current.accessToken
        });
      publicationState = publicCommunitySermonPublicationState(publication, {
        expectedSermonId: sermonId,
        unavailableStatus: 'unavailable'
      });
      const savedSyncVersion = Number.isSafeInteger(sermon?.syncVersion)
        ? sermon.syncVersion
        : null;
      const sameVersionRevisionMismatch = savedSyncVersion !== null
        && publication.syncVersion === savedSyncVersion
        && publication.currentRevision !== sermon.remoteRevision;
      const publicationStateIsStale = savedSyncVersion !== null
        && publication.syncVersion < savedSyncVersion;
      const publicationResponseInconsistent =
        publicationState.status === 'unavailable'
        || sameVersionRevisionMismatch
        || publicationStateIsStale;
      const publicationVersionMovedBackward = publicationResponseInconsistent
        ? false
        : !observeCommunitySermonPublicationVersion({
          connectionId: connection.id,
          sermonId,
          publicationVersion: publication.publicationVersion
        });
      if (
        publicationResponseInconsistent
        || publicationVersionMovedBackward
      ) {
        publicationState = publicCommunitySermonPublicationState(null, {
          unavailableStatus: 'unavailable'
        });
      } else {
        remoteStateAhead = savedSyncVersion !== null
          && publication.syncVersion > savedSyncVersion;
      }
    } catch (error) {
      if (requireCommunityReconnectFor(error)) {
        await notifyCommunityStatusChanged();
      } else if ([
        'SERMON_PUBLICATIONS_UNSUPPORTED',
        'SERMON_PUBLICATION_SCOPE_UNAVAILABLE'
      ].includes(error?.code)) {
        publicationState = publicCommunitySermonPublicationState(null);
      } else {
        // Publication status is an independent, read-only lane. A malformed
        // or retryable response must not erase the useful local sync result.
        console.warn(
          '[Community] Sermon publication status is unavailable:',
          error?.code || error?.name || 'operation-failed'
        );
      }
    }
  }
  return publicCommunitySermonState(sermon, connection, {
    sermonId,
    currentLocalRevision,
    publicationState,
    remoteStateAhead
  });
}

function communitySermonPublicationManagerUrl(baseUrl, sermonId) {
  const trustedBase = new URL(baseUrl);
  const managerUrl = new URL('/admin/sermon-publications', trustedBase.origin);
  managerUrl.searchParams.set('sermon', sermonId);
  if (managerUrl.origin !== trustedBase.origin) {
    failMainOperation(
      'CORRUPT_COMMUNITY_CONNECTION',
      'The saved Community manager address is invalid.'
    );
  }
  return managerUrl.toString();
}

async function openCommunitySermonPublicationManager({
  sermonId,
  expectedLocalRevision
}) {
  const summary = await currentCommunityConnectionSummary();
  if (
    !summary
    || communityConnectionExpired(summary)
    || communityReconnectRequired
  ) {
    failMainOperation(
      'COMMUNITY_RECONNECT_REQUIRED',
      communityReconnectRequired?.message
        || 'Reconnect Heritage Community before continuing to sermon review.'
    );
  }
  if (!summary.canReadSermons) {
    failMainOperation(
      'COMMUNITY_PERMISSION_DENIED',
      'This Community approval cannot open the shared sermon review.'
    );
  }

  const { connectionStore, stateStore } = await getCommunityServices();
  const current = await connectionStore.getConnection(summary.id);
  if (!current || communityConnectionExpired(current)) {
    failMainOperation(
      'COMMUNITY_RECONNECT_REQUIRED',
      'This Community approval expired. Connect this computer again.'
    );
  }
  if (!current.canReadSermons) {
    failMainOperation(
      'COMMUNITY_PERMISSION_DENIED',
      'This Community approval can no longer read the shared sermon library.'
    );
  }

  const saved = await stateStore.getSermonState(current.id, sermonId);
  if (
    !Number.isSafeInteger(saved?.syncVersion)
    || saved.syncVersion < 1
    || Boolean(saved.conflict)
    || saved.localRevision !== expectedLocalRevision
    || saved.remoteRevision !== expectedLocalRevision
  ) {
    failMainOperation(
      'COMMUNITY_SERMON_REVISION_NOT_SAVED',
      'Save this exact sermon revision to Community before continuing to manager review.'
    );
  }

  let local;
  try {
    local = await getPrepareServices().localSermonLibrary.read(sermonId);
  } catch (error) {
    if (error?.code !== 'SERMON_NOT_FOUND') throw error;
    failMainOperation(
      'SERMON_REVISION_CHANGED',
      'This sermon is no longer the current local library record. Reload it before continuing.'
    );
  }
  if (local.revision !== expectedLocalRevision) {
    failMainOperation(
      'SERMON_REVISION_CHANGED',
      'This sermon changed on this computer. Reload its Community status before continuing.'
    );
  }
  if (!['ready', 'published'].includes(local.sermon.publication.status)) {
    failMainOperation(
      'SERMON_NOT_READY_FOR_PUBLICATION_REVIEW',
      'Mark this sermon Ready before continuing to Community manager review.'
    );
  }

  const managerUrl = communitySermonPublicationManagerUrl(
    current.baseUrl,
    sermonId
  );
  await shell.openExternal(managerUrl);
  return { opened: true };
}

function publicCommunitySermonPublicationVerification(result) {
  const summary = result?.summary;
  const expectedKeys = [
    'status',
    'publicId',
    'publishedAt',
    'publicationVersion',
    'bodyEntryCount',
    'mediaCount',
    'primaryReferenceCount',
    'mentionedReferenceCount'
  ];
  if (
    !summary
    || typeof summary !== 'object'
    || Array.isArray(summary)
    || Object.keys(summary).length !== expectedKeys.length
    || expectedKeys.some(key => !Object.hasOwn(summary, key))
    || !['verified-current', 'verified-older'].includes(summary.status)
    || typeof summary.publicId !== 'string'
    || !/^[a-z0-9][a-z0-9._-]{0,95}$/.test(summary.publicId)
    || typeof summary.publishedAt !== 'string'
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(
      summary.publishedAt
    )
    || !Number.isFinite(Date.parse(summary.publishedAt))
    || new Date(summary.publishedAt).toISOString() !== summary.publishedAt
    || !Number.isSafeInteger(summary.publicationVersion)
    || summary.publicationVersion < 1
    || expectedKeys.slice(4).some(key =>
      !Number.isSafeInteger(summary[key])
      || summary[key] < 0
      || summary[key] > 100_000)
    || summary.primaryReferenceCount < 1
  ) {
    failMainOperation(
      'SERMON_PUBLICATION_VERIFICATION_INVALID',
      'The live sermon verification result was invalid.'
    );
  }
  return Object.freeze({
    status: summary.status,
    publicId: summary.publicId,
    publishedAt: summary.publishedAt,
    publicationVersion: summary.publicationVersion,
    bodyEntryCount: summary.bodyEntryCount,
    mediaCount: summary.mediaCount,
    primaryReferenceCount: summary.primaryReferenceCount,
    mentionedReferenceCount: summary.mentionedReferenceCount
  });
}

async function communitySermonPublicationVerificationPayload(sermonId) {
  const connection = await currentCommunityConnectionSummary();
  if (
    !connection
    || communityConnectionExpired(connection)
    || communityReconnectRequired
  ) {
    failMainOperation(
      'COMMUNITY_RECONNECT_REQUIRED',
      communityReconnectRequired?.message
        || 'Reconnect Heritage Community before verifying the live sermon.'
    );
  }
  if (!connection.canReadSermons) {
    failMainOperation(
      'COMMUNITY_PERMISSION_DENIED',
      'This Community approval cannot read the shared sermon record.'
    );
  }
  if (!connection.canReadSermonPublications) {
    failMainOperation(
      'SERMON_PUBLICATIONS_UNSUPPORTED',
      'This Community approval cannot read sermon publication receipts.'
    );
  }

  const { connectionStore, stateStore } = await getCommunityServices();
  const current = await connectionStore.getConnection(connection.id);
  if (!current || communityConnectionExpired(current)) {
    failMainOperation(
      'COMMUNITY_RECONNECT_REQUIRED',
      'This Community approval expired. Connect this computer again.'
    );
  }

  const saved = await stateStore.getSermonState(connection.id, sermonId);
  let result;
  try {
    result = await verifyDeployedCommunitySermonPublication({
      client: communityClientForConnection(current),
      localLibrary: getPrepareServices().localSermonLibrary,
      syncId: sermonId,
      accessToken: current.accessToken,
      signal: null
    });
  } catch (error) {
    if (requireCommunityReconnectFor(error)) {
      await notifyCommunityStatusChanged();
    }
    throw error;
  }

  const publication = result.publicationState;
  const publicationState = publicCommunitySermonPublicationState(publication, {
    expectedSermonId: sermonId,
    unavailableStatus: 'unavailable'
  });
  const savedSyncVersion = Number.isSafeInteger(saved?.syncVersion)
    ? saved.syncVersion
    : null;
  const inconsistentWithSavedSermon = savedSyncVersion !== null
    && (
      publication.syncVersion < savedSyncVersion
      || (
        publication.syncVersion === savedSyncVersion
        && publication.currentRevision !== saved.remoteRevision
      )
    );
  const publicationVersionMovedBackward =
    !observeCommunitySermonPublicationVersion({
      connectionId: connection.id,
      sermonId,
      publicationVersion: publication.publicationVersion
    });
  if (
    !['published-current', 'published-older'].includes(
      publicationState.status
    )
    || inconsistentWithSavedSermon
    || publicationVersionMovedBackward
  ) {
    failMainOperation(
      'SERMON_PUBLICATION_STATE_CHANGED',
      'The Community sermon publication changed while it was being verified. Refresh and try again.'
    );
  }

  const verification = publicCommunitySermonPublicationVerification(result);
  const expectedStatus = publicationState.status === 'published-current'
    ? 'verified-current'
    : 'verified-older';
  if (
    verification.status !== expectedStatus
    || verification.publicId !== publicationState.publicId
    || verification.publishedAt !== publicationState.publishedAt
    || verification.publicationVersion
      !== publicationState.publicationVersion
  ) {
    failMainOperation(
      'SERMON_PUBLICATION_VERIFICATION_INVALID',
      'The live sermon verification result did not match its publication receipt.'
    );
  }
  return { verification };
}

function sermonConflictFingerprint(value) {
  const hex = crypto
    .createHmac('sha256', sermonConflictUrlProjectionKey)
    .update(value)
    .digest('hex')
    .slice(0, 12)
    .toUpperCase();
  return `${hex.slice(0, 4)}-${hex.slice(4, 8)}-${hex.slice(8, 12)}`;
}

function middleTruncatedText(value, maximum) {
  if (value.length <= maximum) return value;
  const remaining = maximum - 1;
  const left = Math.ceil(remaining / 2);
  const right = Math.floor(remaining / 2);
  return `${value.slice(0, left)}…${value.slice(value.length - right)}`;
}

function publicSermonConflictLink(rawUrl) {
  if (!rawUrl) return null;
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch (_error) {
    failMainOperation(
      'COMMUNITY_CONFLICT_CORRUPT',
      'A saved sermon conflict contains an invalid external link.'
    );
  }
  if (
    !['http:', 'https:'].includes(parsed.protocol)
    || !parsed.hostname
    || parsed.username
    || parsed.password
  ) {
    failMainOperation(
      'COMMUNITY_CONFLICT_CORRUPT',
      'A saved sermon conflict contains an unsafe external link.'
    );
  }
  return {
    origin: parsed.origin,
    pathDisplay: middleTruncatedText(parsed.pathname || '/', 160),
    parametersHidden: Boolean(parsed.search || parsed.hash),
    fingerprint: sermonConflictFingerprint(parsed.toString())
  };
}

function publicSermonConflictMedia(media) {
  const projected = media.map(entry => ({
    kind: entry.kind,
    status: entry.status,
    title: entry.title,
    language: entry.language,
    link: publicSermonConflictLink(entry.url)
  }));
  const setFingerprint = sermonConflictFingerprint(JSON.stringify(
    media.map(entry => ({
      id: entry.id,
      kind: entry.kind,
      status: entry.status,
      title: entry.title,
      language: entry.language,
      url: entry.url
    }))
  ));
  return {
    total: projected.length,
    shown: Math.min(projected.length, SERMON_CONFLICT_MEDIA_LIMIT),
    truncated: projected.length > SERMON_CONFLICT_MEDIA_LIMIT,
    setFingerprint,
    items: projected.slice(0, SERMON_CONFLICT_MEDIA_LIMIT)
  };
}

function publicCommunitySermonConflictCopy(validated) {
  const sermon = validated.sermon || validated.document;
  return {
    id: sermon.id,
    revision: validated.revision,
    title: sermon.titles[sermon.defaultLanguage],
    titles: { ...sermon.titles },
    defaultLanguage: sermon.defaultLanguage,
    speaker: {
      id: sermon.speaker.id || null,
      name: sermon.speaker.name
    },
    serviceDate: sermon.serviceDate,
    series: sermon.series
      ? {
          id: sermon.series.id || null,
          titles: { ...sermon.series.titles }
        }
      : null,
    outline: sermon.outline.map(section => ({
      id: section.id,
      parentId: section.parentId || null,
      kind: section.kind,
      titles: { ...section.titles }
    })),
    body: Array.isArray(sermon.body)
      ? sermon.body.map((entry, index) => ({
          position: index + 1,
          kind: entry.kind,
          language: entry.language,
          text: entry.text,
          metadataFingerprint: sermonConflictFingerprint(JSON.stringify([
            entry.id,
            entry.sourceId,
            entry.sectionId
          ]))
        }))
      : [],
    references: sermon.references.map(reference => ({
      id: reference.id,
      range: { ...reference.range },
      role: reference.role,
      reviewStatus: reference.reviewStatus,
      enteredText: reference.enteredText || '',
      sectionId: reference.sectionId || null
    })),
    publication: {
      status: sermon.publication.status,
      visibility: sermon.publication.visibility,
      publishedAt: sermon.publication.publishedAt,
      canonicalLink: publicSermonConflictLink(sermon.publication.canonicalUrl)
    },
    sourceCount: sermon.sources.length,
    mediaCount: sermon.media.length,
    media: publicSermonConflictMedia(sermon.media)
  };
}

async function communitySermonConflictPayload(sermonId) {
  const connection = await currentCommunityConnectionSummary();
  if (!connection || communityConnectionExpired(connection) || communityReconnectRequired) {
    failMainOperation(
      'COMMUNITY_RECONNECT_REQUIRED',
      communityReconnectRequired?.message
        || 'Reconnect Heritage Community before reviewing this sermon conflict.'
    );
  }
  if (!connection.canReadSermons) {
    failMainOperation(
      'COMMUNITY_PERMISSION_DENIED',
      'This Community approval cannot read the shared sermon copy.'
    );
  }
  const { stateStore } = await getCommunityServices();
  const state = await stateStore.getConnectionState(connection.id);
  const sermonState = Object.hasOwn(state.sermons, sermonId)
    ? state.sermons[sermonId]
    : null;
  if (!sermonState?.conflict) {
    failMainOperation(
      'COMMUNITY_CONFLICT_NOT_FOUND',
      'This sermon no longer has a saved Community conflict.'
    );
  }
  if (sermonState.syncVersion !== sermonState.conflict.remoteSyncVersion) {
    failMainOperation(
      'COMMUNITY_CONFLICT_STALE',
      'Sync sermons again before reviewing this conflict.'
    );
  }

  const library = getPrepareServices().localSermonLibrary;
  const local = await library.read(sermonId);
  const remote = await library.readRevision(
    sermonId,
    sermonState.conflict.remoteRevision
  );
  if (remote.revision !== sermonState.conflict.remoteRevision
    || remote.revision !== sermonState.remoteRevision) {
    failMainOperation(
      'COMMUNITY_CONFLICT_CORRUPT',
      'The saved Community sermon copy could not be verified. Sync sermons again.'
    );
  }
  return {
    syncId: sermonId,
    code: sermonState.conflict.code,
    detectedAt: sermonState.conflict.detectedAt,
    expectedSyncVersion: sermonState.syncVersion,
    expectedLocalRevision: local.revision,
    local: publicCommunitySermonConflictCopy(local),
    community: publicCommunitySermonConflictCopy(remote)
  };
}

function localCommunityFamilyDocuments(documents) {
  return documents.map(document => ({
    id: document.song.id,
    title: document.song.title,
    language: document.song.language,
    translationOf: document.song.translationOf || null,
    revision: document.revision,
    source: document.source
  }));
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
  const connection = await currentCommunityConnectionSummary();
  if (!connection || communityConnectionExpired(connection) || communityReconnectRequired) {
    failMainOperation(
      'COMMUNITY_RECONNECT_REQUIRED',
      communityReconnectRequired?.message
        || 'Reconnect Heritage Community before reviewing this conflict.'
    );
  }
  if (!connection.canReadSongs) {
    failMainOperation(
      'COMMUNITY_PERMISSION_DENIED',
      'This Community approval cannot read the shared song copy.'
    );
  }
  const local = await resolveCommunitySongFamily(songId);
  const { stateStore } = await getCommunityServices();
  const state = await stateStore.getConnectionState(connection.id);
  const song = findCommunitySongState(state, local.familyId, local.songId);
  if (!song?.conflict) {
    failMainOperation(
      'COMMUNITY_CONFLICT_NOT_FOUND',
      'This song no longer has a Community conflict.'
    );
  }
  const localDocuments = localCommunityFamilyDocuments(local.documents);
  return {
    syncId: song.syncId,
    familyId: local.familyId,
    code: song.conflict.code,
    detectedAt: song.conflict.detectedAt,
    expectedSyncVersion: song.syncVersion,
    expectedLocalRevision: local.familyRevision,
    localDocuments,
    communityDocuments: song.conflict.remoteDocuments.map(communityConflictDocument)
  };
}

async function augmentSongLibraryWithCommunity(listing) {
  const connection = await currentCommunityConnectionSummary();
  if (
    !connection
    || communityConnectionExpired(connection)
    || communityReconnectRequired
    || !connection.canReadSongs
  ) {
    return listing;
  }
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

async function pauseCommunitySermonMediaUploads() {
  const active = [...communitySermonMediaUploads.entries()]
    .filter(([, operation]) => operation?.status === 'uploading');
  for (const [, operation] of active) operation.controller?.abort();
  await Promise.allSettled(active.map(([, operation]) => operation.promise));
  for (const [key, operation] of active) {
    if (operation.status === 'uploading') {
      operation.status = 'error';
      operation.error = {
        code: 'REQUEST_CANCELLED',
        message:
          'The private upload paused when SyncShow suspended or closed. Resume it explicitly.'
      };
      communitySermonMediaUploads.set(key, operation);
    }
  }
}

function clearCommunitySermonMediaOperationState() {
  // Upload/session state is private to the pinned server + Community identity.
  // Persisted attempt keys are already identity-scoped; in-memory projections
  // must not survive an actual connection identity change.
  communitySermonMediaUploads.clear();
}

async function cancelCommunityTransientOperations() {
  communityOperationEpoch += 1;
  communitySyncAbortController?.abort();
  communitySyncAbortController = null;
  communityAuthAbortController?.abort();
  communityAuthAbortController = null;
  clearCommunitySyncTimer();
  clearCommunityPeriodicSync();
  await pauseCommunitySermonMediaUploads();
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
    closeSermonRecordingPlayer().catch(error => {
      console.error('[Sermon] Could not finish control-crash playback cleanup:', error);
    });
  });
  controlWindow.on('unresponsive', () => {
    closeSermonRecordingPlayer().catch(error => {
      console.error('[Sermon] Could not finish unresponsive-control playback cleanup:', error);
    });
  });
}

function sermonRecordingPlayerHtml({
  title,
  fileName,
  kind,
  mediaType,
  token
}) {
  const escapeHtml = value => String(value)
    .replace(/&/gu, '&amp;')
    .replace(/</gu, '&lt;')
    .replace(/>/gu, '&gt;')
    .replace(/"/gu, '&quot;')
    .replace(/'/gu, '&#39;');
  const safeTitle = escapeHtml(title || 'Sermon recording');
  const safeFileName = escapeHtml(fileName || 'Private local recording');
  const safeMediaType = escapeHtml(mediaType);
  const source =
    `${SERMON_RECORDING_PLAYBACK_SCHEME}://play/${token}`;
  const media = kind === 'video'
    ? `<video controls autoplay preload="metadata"><source src="${source}" type="${safeMediaType}"></video>`
    : `<audio controls autoplay preload="metadata"><source src="${source}" type="${safeMediaType}"></audio>`;
  return `<!doctype html>
    <html lang="en">
      <head>
        <meta charset="utf-8">
        <meta http-equiv="Content-Security-Policy" content="default-src 'none'; media-src ${SERMON_RECORDING_PLAYBACK_SCHEME}:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'">
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <title>${safeTitle} · private recording</title>
        <style>
          :root { color-scheme: dark; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
          * { box-sizing: border-box; }
          body { margin: 0; min-height: 100vh; display: grid; place-items: center; color: #f6f8ff; background: #0a1020; }
          main { width: min(860px, calc(100vw - 40px)); padding: 30px; border: 1px solid #314264; border-radius: 20px; background: #111b31; box-shadow: 0 24px 70px rgba(0,0,0,.45); }
          p { margin: 0; color: #aebbd4; overflow-wrap: anywhere; }
          .kicker { margin-bottom: 8px; color: #84a9ff; font-size: 12px; font-weight: 800; letter-spacing: .12em; text-transform: uppercase; }
          h1 { margin: 0 0 8px; font-size: 24px; line-height: 1.25; }
          .file { margin-bottom: 24px; font-size: 14px; }
          audio, video { display: block; width: 100%; max-height: 58vh; }
          .privacy { margin-top: 20px; font-size: 13px; line-height: 1.5; }
        </style>
      </head>
      <body>
        <main>
          <p class="kicker">Private local review</p>
          <h1>${safeTitle}</h1>
          <p class="file">${safeFileName}</p>
          ${media}
          <p class="privacy">Playback stays on this computer. This window receives an expiring content token, never a local file path, Community credential, or publication authority.</p>
        </main>
      </body>
    </html>`;
}

function invalidateSermonRecordingPlayer() {
  sermonRecordingPlaybackEpoch += 1;
  const abortController = sermonRecordingPlaybackAbortController;
  sermonRecordingPlaybackAbortController = null;
  abortController?.abort();
  const active = sermonRecordingPlayer;
  sermonRecordingPlayer = null;
  if (active?.window && !active.window.isDestroyed()) {
    active.window.destroy();
  }
  return {
    epoch: sermonRecordingPlaybackEpoch,
    cleanup: Promise.all([
      active
        ? sermonRecordingPlaybackAuthority.revoke(active.token).catch(() => {})
        : Promise.resolve(),
      sermonRecordingPlaybackVerificationTail.catch(() => {})
    ]).then(() => undefined)
  };
}

async function closeSermonRecordingPlayer() {
  const invalidation = invalidateSermonRecordingPlayer();
  await invalidation.cleanup;
}

function requireCurrentSermonRecordingPlayback(epoch) {
  if (epoch !== sermonRecordingPlaybackEpoch) {
    failMainOperation(
      'SERMON_RECORDING_PLAYBACK_CANCELLED',
      'The private sermon recording review was replaced or stopped.'
    );
  }
  if (displayStartInProgress || appState.activeLaunchPlan) {
    failMainOperation(
      'SERMON_RECORDING_PLAYBACK_BLOCKED',
      'Private sermon recording review is unavailable while Show is starting or active.'
    );
  }
}

function verifySermonRecordingForPlayback(operation) {
  const verification = sermonRecordingPlaybackVerificationTail.then(
    operation,
    operation
  );
  sermonRecordingPlaybackVerificationTail = verification.catch(() => {});
  return verification;
}

async function openSermonRecordingPlayer({
  reader,
  binding,
  title,
  fileName,
  playbackEpoch,
  abortController
}) {
  if (!sermonRecordingPlaybackProtocolReady) {
    await reader.close().catch(() => {});
    failMainOperation(
      'SERMON_RECORDING_PLAYBACK_UNAVAILABLE',
      'Private sermon recording playback is unavailable in this SyncShow session.'
    );
  }
  requireCurrentSermonRecordingPlayback(playbackEpoch);
  let entry;
  let playerWindow;
  try {
    entry = await sermonRecordingPlaybackAuthority.issue({
      reader,
      binding
    });
    requireCurrentSermonRecordingPlayback(playbackEpoch);
    const html = sermonRecordingPlayerHtml({
      title,
      fileName,
      kind: entry.kind,
      mediaType: entry.mediaType,
      token: entry.token
    });
    const playerUrl =
      `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
    playerWindow = new BrowserWindow({
      width: entry.kind === 'video' ? 960 : 620,
      height: entry.kind === 'video' ? 680 : 330,
      minWidth: 480,
      minHeight: entry.kind === 'video' ? 420 : 260,
      parent: controlWindow && !controlWindow.isDestroyed()
        ? controlWindow
        : undefined,
      backgroundColor: '#0a1020',
      title: `${title || 'Sermon recording'} · private review`,
      show: false,
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true
      }
    });
    sermonRecordingPlayer = {
      token: entry.token,
      window: playerWindow,
      abortController
    };
    playerWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    playerWindow.webContents.on('will-navigate', (event, url) => {
      if (url !== playerUrl) event.preventDefault();
    });
    playerWindow.once('ready-to-show', () => {
      if (sermonRecordingPlayer?.window === playerWindow) {
        playerWindow.show();
      }
    });
    playerWindow.on('closed', () => {
      if (sermonRecordingPlayer?.window === playerWindow) {
        sermonRecordingPlayer = null;
        sermonRecordingPlaybackEpoch += 1;
        if (sermonRecordingPlaybackAbortController === abortController) {
          sermonRecordingPlaybackAbortController = null;
        }
        abortController.abort();
      }
      sermonRecordingPlaybackAuthority.revoke(entry.token).catch(() => {});
    });
    playerWindow.on('unresponsive', () => {
      if (sermonRecordingPlayer?.window !== playerWindow) return;
      closeSermonRecordingPlayer().catch(error => {
        console.error('[Sermon] Could not finish unresponsive-player cleanup:', error);
      });
    });
    playerWindow.webContents.on('render-process-gone', () => {
      if (sermonRecordingPlayer?.window !== playerWindow) return;
      closeSermonRecordingPlayer().catch(error => {
        console.error('[Sermon] Could not finish player-crash cleanup:', error);
      });
    });
    await playerWindow.loadURL(playerUrl);
    requireCurrentSermonRecordingPlayback(playbackEpoch);
    return {
      opened: true,
      kind: entry.kind,
      mediaType: entry.mediaType,
      sha256: entry.sha256,
      sizeBytes: entry.sizeBytes,
      binding: { ...entry.binding }
    };
  } catch (error) {
    if (sermonRecordingPlayer?.window === playerWindow) {
      sermonRecordingPlayer = null;
    }
    if (playerWindow && !playerWindow.isDestroyed()) playerWindow.destroy();
    if (entry) {
      await sermonRecordingPlaybackAuthority.revoke(entry.token).catch(() => {});
    } else {
      await reader.close().catch(() => {});
    }
    if (
      error?.code === 'SERMON_RECORDING_PLAYBACK_CANCELLED'
      || error?.code === 'SERMON_RECORDING_PLAYBACK_BLOCKED'
    ) {
      throw error;
    }
    failMainOperation(
      'SERMON_RECORDING_PLAYBACK_UNAVAILABLE',
      'The private sermon recording player could not be opened.'
    );
  }
}

function registerSermonRecordingPlaybackProtocol() {
  if (sermonRecordingPlaybackProtocolReady) return;
  if (typeof protocol?.handle !== 'function') {
    throw new Error('Electron protocol handling is unavailable.');
  }
  protocol.handle(
    SERMON_RECORDING_PLAYBACK_SCHEME,
    request => createSermonRecordingPlaybackResponse(
      request,
      sermonRecordingPlaybackAuthority,
      { scheme: SERMON_RECORDING_PLAYBACK_SCHEME }
    )
  );
  sermonRecordingPlaybackProtocolReady = true;
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
    liveCueTransitionCoordinator?.outputFailed({
      outputId: output.id,
      sessionId,
      sender,
      code: 'LIVE_CUE_OUTPUT_UNRESPONSIVE',
      reason: `${output.name || output.id} became unresponsive while changing cues.`
    });
  });
  win.on('responsive', () => {
    if (!isCurrentOutputWindow(win, sessionId, output.id)) return;
    outputHealthTracker.markResponsive(identity);
  });
  sender.on('render-process-gone', (_event, details) => {
    if (!isCurrentOutputWindow(win, sessionId, output.id)) return;
    console.error(`[Display] ${output.name} renderer process exited:`, details);
    outputHealthTracker.markProcessGone(identity);
    liveCueTransitionCoordinator?.outputFailed({
      outputId: output.id,
      sessionId,
      sender,
      code: 'LIVE_CUE_OUTPUT_PROCESS_GONE',
      reason: `${output.name || output.id} stopped while changing cues.`
    });
    handleUnexpectedOutputWindowClose(output.id, 'output-renderer-gone');
  });
}

function handleOutputFrameHealth(event, payload = {}) {
  const acknowledgement = {
    sender: event.sender,
    sessionId: outputSessionId,
    cueIndex: payload?.index,
    ok: payload?.ok
  };
  // Resolve the exact all-output transition before scheduling the health-state
  // publish. On the final frame this queues the navigation commit first, so a
  // transient old-cue state can never advertise enabled Next controls.
  liveCueTransitionCoordinator?.acknowledge({
    ...acknowledgement,
    error: payload?.error
  });
  outputHealthTracker.acknowledge(acknowledgement);
}

// This permanent listener records every current-frame result. Startup also
// installs short-lived waiters, but those only own the reveal barrier and do
// not determine the ongoing public health state.
ipcMain.on('output:frameReady', handleOutputFrameHealth);

ipcMain.on('output:videoState', (event, payload = {}) => {
  const entry = [...outputWindows.values()].find(candidate =>
    candidate?.win
    && !candidate.win.isDestroyed()
    && candidate.win.webContents === event.sender);
  const playback = activeVideoPlayback;
  if (!entry
    || !playback
    || entry.sessionId !== playback.sessionId
    || payload.outputId !== entry.output.id
    || !playback.outputIds.includes(payload.outputId)
    || payload.index !== playback.index
    || payload.index !== appState.currentSlide
    || payload.cueId !== playback.cueId
    || !['armed', 'playing', 'paused', 'ended', 'error'].includes(payload.state)) return;
  playback.state = payload.state;
  if (payload.state === 'error') {
    console.error(
      `[Video] ${payload.outputId} could not play cue ${payload.index + 1}:`,
      typeof payload.error === 'string' ? payload.error.slice(0, 500) : 'unknown error'
    );
  }
});

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
  liveCueTransitionCoordinator?.cancel(
    'The output session ended while changing cues.',
    'OUTPUT_SESSION_REPLACED'
  );
  activeLiveCueNavigation = null;
  activeVideoPlayback = null;
  stopRemoteForShow('show-ended');
  clearVolunteerShowUnlockTimer();
  activeVolunteerShowUnlockGrant = null;
  activeVolunteerShowBinding = null;
  activeShowControlMode = 'full';
  activeShowRehearsalState = Object.freeze({
    status: 'idle',
    currentCue: 0,
    totalCues: 0,
    persisted: false,
    reused: false
  });
  outputSessionId += 1;
  bibleOperationEpoch += 1;
  pendingBibleLookup = null;
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
  activePowerPointShowReceipt = null;
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

function requireCurrentOutputStartup(
  sessionId,
  launchPlan,
  renderingSettings,
  message = 'Output startup was replaced or cancelled before it completed.'
) {
  const exactOutputs = outputWindows.size === launchPlan.outputs.length
    && launchPlan.outputs.every(output => {
      const entry = outputWindows.get(output.id);
      return entry?.output === output
        && entry.sessionId === sessionId
        && isCurrentOutputWindow(entry.win, sessionId, output.id);
    });
  const ownsCurrentStartup = sessionId === outputSessionId
    && appState.activeLaunchPlan === launchPlan;
  if (
    ownsCurrentStartup
    && outputsShouldBeVisible
    && outputLifecyclePhase === 'starting'
    && exactOutputs
    && sameStartRenderingSettings(renderingSettings)
  ) {
    return;
  }

  // A stale Start must never destroy a newer session. It may only clean up
  // the exact private startup transaction that it still owns.
  if (ownsCurrentStartup) destroyOutputWindows();
  failMainOperation('OUTPUT_STARTUP_REPLACED', message);
}

async function rehearseHiddenShowCues({
  sessionId,
  launchPlan,
  evidence,
  renderingSettings
}) {
  const acknowledgements = [];
  const outputIds = launchPlan.outputs.map(output => output.id);
  for (let cueIndex = 0; cueIndex < launchPlan.totalSlides; cueIndex += 1) {
    if (sessionId !== outputSessionId || !outputsShouldBeVisible) {
      throw new Error('Output startup was cancelled during the hidden rehearsal.');
    }
    const framePromises = [...outputWindows.values()].map(({ win, output }) =>
      waitForInitialOutputFrame(win, output, sessionId, cueIndex)
    );
    const applied = goToSlide(cueIndex, {
      publish: false,
      notifyControl: false,
      capturePreviews: false
    });
    if (applied?.accepted !== true) {
      throw new Error(
        applied?.message || `Cue ${cueIndex + 1} could not be rehearsed.`
      );
    }
    await Promise.all(framePromises);
    requireCurrentOutputStartup(
      sessionId,
      launchPlan,
      renderingSettings,
      'Output startup was cancelled during the hidden rehearsal.'
    );
    acknowledgements.push({
      cueId: evidence?.cueIds?.[cueIndex]
        || `cue-${cueIndex + 1}`,
      outputIds: [...outputIds]
    });
    setActiveShowRehearsalState({
      status: 'rehearsing',
      currentCue: cueIndex + 1,
      totalCues: launchPlan.totalSlides,
      persisted: false,
      reused: false
    });
  }
  return acknowledgements;
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
  if (pendingBibleLookup || activeBibleOverlay || pendingBibleOverlay) {
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

function liveCueNavigationFailure(code, message, details = {}) {
  const error = new Error(message);
  error.code = code;
  error.details = details;
  return error;
}

function normalizeLiveCueNavigationFailure(error) {
  const code = typeof error?.code === 'string'
    && /^[A-Z][A-Z0-9_]{2,95}$/.test(error.code)
    ? error.code
    : 'LIVE_CUE_TRANSITION_FAILED';
  const rawMessage = typeof error?.message === 'string'
    ? error.message.replace(/\s+/g, ' ').trim()
    : '';
  return {
    accepted: false,
    code,
    message: rawMessage || 'The cue did not reach every output.',
    details: error?.details && typeof error.details === 'object'
      ? error.details
      : {}
  };
}

function nextOutputRestoreGuardId(sessionId) {
  outputRestoreGuardSequence = (outputRestoreGuardSequence + 1) % Number.MAX_SAFE_INTEGER;
  return `restore-${sessionId}-${outputRestoreGuardSequence}`;
}

function setOutputRestoreGuard({
  outputs,
  sessionId,
  guardId,
  active,
  reveal = false,
  timeoutMs = 5000
}) {
  if (
    !Array.isArray(outputs)
    || outputs.length < 1
    || !Number.isSafeInteger(sessionId)
    || sessionId < 0
    || !/^[A-Za-z0-9_-]{1,128}$/u.test(guardId)
    || (active !== true && active !== false)
    || (active && reveal)
  ) {
    return Promise.reject(liveCueNavigationFailure(
      'LIVE_CUE_RESTORE_GUARD_FAILED',
      'The black Restore guard could not be configured safely.'
    ));
  }

  return new Promise((resolve, reject) => {
    const pending = new Map(outputs.map(output => [output.sender, output]));
    const closeHandlers = [];
    let settled = false;

    const cleanup = () => {
      clearTimeout(timeoutId);
      ipcMain.removeListener('output:restoreGuardReady', handleReady);
      for (const { win, handler } of closeHandlers) {
        win.removeListener('closed', handler);
      }
    };
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      cleanup();
      callback(value);
    };
    const fail = (message, details = {}) => finish(
      reject,
      liveCueNavigationFailure(
        'LIVE_CUE_RESTORE_GUARD_FAILED',
        message,
        details
      )
    );
    const handleReady = (event, payload = {}) => {
      const output = pending.get(event.sender);
      if (!output) return;
      if (
        payload?.guardId !== guardId
        || payload?.outputId !== output.outputId
        || payload?.active !== active
        || payload?.reveal !== reveal
        || (payload?.ok !== true && payload?.ok !== false)
      ) return;

      const entry = outputWindows.get(output.outputId);
      if (
        payload.ok !== true
        || sessionId !== outputSessionId
        || entry?.sessionId !== sessionId
        || entry?.win?.webContents !== event.sender
        || !isCurrentOutputWindow(entry.win, sessionId, output.outputId)
      ) {
        fail(
          `${output.outputId} could not ${active ? 'paint' : 'release'} its black Restore guard.`,
          { rendererError: typeof payload?.error === 'string' ? payload.error : null }
        );
        return;
      }

      pending.delete(event.sender);
      if (pending.size === 0) {
        finish(resolve, Object.freeze({
          guardId,
          active,
          reveal,
          outputIds: Object.freeze(outputs.map(item => item.outputId))
        }));
      }
    };
    const timeoutId = setTimeout(() => {
      fail(`The outputs did not ${active ? 'paint' : 'release'} their black Restore guard in time.`);
    }, timeoutMs);

    ipcMain.on('output:restoreGuardReady', handleReady);
    try {
      for (const output of outputs) {
        const entry = outputWindows.get(output.outputId);
        const win = entry?.win;
        if (
          entry?.sessionId !== sessionId
          || !isCurrentOutputWindow(win, sessionId, output.outputId)
          || win.webContents !== output.sender
          || win.webContents.isDestroyed()
        ) {
          fail(`${output.outputId} was replaced before its black Restore guard was ready.`);
          return;
        }
        const handleClosed = () => {
          fail(`${output.outputId} closed while changing its black Restore guard.`);
        };
        closeHandlers.push({ win, handler: handleClosed });
        win.once('closed', handleClosed);
      }
      for (const output of outputs) {
        output.sender.send('output:restoreGuard', {
          guardId,
          outputId: output.outputId,
          active,
          reveal
        });
      }
    } catch (error) {
      fail(
        `The black Restore guard could not reach every output.`,
        { cause: error instanceof Error ? error.message : String(error) }
      );
    }
  });
}

function currentLiveCueTransitionOutputs() {
  const launchPlan = appState.activeLaunchPlan;
  if (!launchPlan || !Array.isArray(launchPlan.outputs)) {
    return {
      accepted: false,
      code: 'NO_ACTIVE_SHOW',
      message: 'There is no active Show.'
    };
  }
  if (outputWindows.size !== launchPlan.outputs.length) {
    return {
      accepted: false,
      code: 'OUTPUTS_UNAVAILABLE',
      message: 'Every routed output must be available before changing cues.'
    };
  }

  const outputs = [];
  for (const output of launchPlan.outputs) {
    const entry = outputWindows.get(output.id);
    const sender = entry?.win?.webContents;
    const health = sender && entry?.sessionId === outputSessionId
      ? outputHealthTracker?.read(output.id, outputSessionId, sender)
      : null;
    if (
      entry?.output !== output
      || !isCurrentOutputWindow(entry?.win, outputSessionId, output.id)
      || !sender
      || sender.isDestroyed()
      || health?.status !== 'healthy'
    ) {
      return {
        accepted: false,
        code: 'OUTPUTS_NOT_READY',
        message: `${output.name || output.id} is not ready for the next cue.`
      };
    }
    outputs.push(Object.freeze({ outputId: output.id, sender }));
  }

  return {
    accepted: true,
    launchPlan,
    outputs: Object.freeze(outputs)
  };
}

function sameLiveCueTransitionOutputs(expectedOutputs) {
  const current = currentLiveCueTransitionOutputs();
  return current.accepted === true
    && current.outputs.length === expectedOutputs.length
    && current.outputs.every((output, index) =>
      output.outputId === expectedOutputs[index].outputId
      && output.sender === expectedOutputs[index].sender);
}

function markLiveCueTransitionFailure(outputs, sessionId, cueIndex) {
  for (const output of outputs) {
    const health = outputHealthTracker?.read(
      output.outputId,
      sessionId,
      output.sender
    );
    if (health?.expectedCueIndex !== cueIndex || health.status !== 'starting') {
      continue;
    }
    outputHealthTracker.acknowledge({
      sender: output.sender,
      sessionId,
      cueIndex,
      ok: false
    });
  }
}

async function goToSlideConfirmed(slideIndex) {
  const launchPlan = appState.activeLaunchPlan;
  if (!launchPlan) {
    return { accepted: false, code: 'NO_ACTIVE_SHOW', message: 'There is no active Show.' };
  }
  if (!outputsShouldBeVisible || !['live', 'cleared'].includes(outputLifecyclePhase)) {
    return {
      accepted: false,
      code: outputLifecyclePhase === 'locally-stopped'
        ? 'SHOW_STOPPED_LOCALLY'
        : 'SHOW_NOT_READY',
      message: outputLifecyclePhase === 'locally-stopped'
        ? 'The outputs were stopped locally.'
        : 'The outputs are not ready to change cues.'
    };
  }
  if (pendingBibleLookup || activeBibleOverlay || pendingBibleOverlay) {
    return {
      accepted: false,
      code: 'BIBLE_OVERLAY_ACTIVE',
      message: 'Return from the Bible passage before changing cues.'
    };
  }
  if (!Number.isInteger(slideIndex) || slideIndex < 0 || slideIndex >= appState.totalSlides) {
    return { accepted: false, code: 'INVALID_CUE_INDEX', message: 'That cue does not exist.' };
  }
  if (slideIndex === appState.currentSlide) {
    return { accepted: true, applied: false };
  }
  if (
    activeLiveCueNavigation !== null
    || liveCueTransitionCoordinator?.isPending()
  ) {
    return {
      accepted: false,
      code: 'LIVE_CUE_TRANSITION_BUSY',
      message: 'Wait for the current cue to reach every output before advancing again.'
    };
  }

  const outputSnapshot = currentLiveCueTransitionOutputs();
  if (outputSnapshot.accepted !== true) return outputSnapshot;
  const sessionId = outputSessionId;
  const fromCueIndex = appState.currentSlide;
  const outputs = outputSnapshot.outputs;
  const transaction = Object.freeze({
    sessionId,
    launchPlan,
    fromCueIndex,
    toCueIndex: slideIndex,
    outputIds: Object.freeze(outputs.map(output => output.outputId))
  });
  let operation;

  try {
    operation = liveCueTransitionCoordinator.begin({
      sessionId,
      fromCueIndex,
      toCueIndex: slideIndex,
      outputs: [...outputs]
    });
    activeLiveCueNavigation = transaction;

    let dispatched;
    try {
      dispatched = dispatchCueToOutputs(slideIndex, {
        expectedOutputs: outputs
      });
    } catch (error) {
      throw liveCueNavigationFailure(
        'LIVE_CUE_DISPATCH_FAILED',
        'The cue could not be sent safely to every output.',
        { cause: error instanceof Error ? error.message : String(error) }
      );
    }
    if (
      dispatched.accepted !== true
      || dispatched.dispatchedOutputs !== outputs.length
    ) {
      throw liveCueNavigationFailure(
        dispatched.code || 'OUTPUTS_UNAVAILABLE',
        dispatched.message || 'The cue could not be sent to every output.'
      );
    }

    publishShowState('cue-transition-started');
    const receipt = await operation.promise;
    const sameSession = sessionId === outputSessionId
      && appState.activeLaunchPlan === launchPlan
      && outputsShouldBeVisible
      && ['live', 'cleared'].includes(outputLifecyclePhase);
    const exactReceipt = receipt?.kind === LIVE_CUE_TRANSITION_RECEIPT_KIND
      && receipt.schemaVersion === LIVE_CUE_TRANSITION_SCHEMA_VERSION
      && receipt.sessionId === sessionId
      && receipt.fromCueIndex === fromCueIndex
      && receipt.toCueIndex === slideIndex
      && Array.isArray(receipt.outputIds)
      && receipt.outputIds.length === outputs.length
      && receipt.outputIds.every((outputId, index) =>
        outputId === outputs[index].outputId);
    if (
      !sameSession
      || !exactReceipt
      || appState.currentSlide !== fromCueIndex
      || activeLiveCueNavigation !== transaction
      || pendingBibleLookup
      || activeBibleOverlay
      || pendingBibleOverlay
      || !sameLiveCueTransitionOutputs(outputs)
    ) {
      throw liveCueNavigationFailure(
        'LIVE_CUE_TRANSITION_STALE',
        'The Show changed before the cue transition could be committed.'
      );
    }

    // Keep a wrapper-owned pending marker after the coordinator's final ACK
    // until this exact commit point. That closes the microtask-sized gap in
    // which the previous cue could otherwise advertise enabled controls.
    activeLiveCueNavigation = null;
    commitCueNavigation(slideIndex);
    return { accepted: true, applied: true, receipt };
  } catch (error) {
    const failure = normalizeLiveCueNavigationFailure(error);
    if (liveCueTransitionCoordinator?.isPending()) {
      liveCueTransitionCoordinator.cancel(failure.message, failure.code);
    }

    const sameSession = sessionId === outputSessionId
      && appState.activeLaunchPlan === launchPlan
      && outputWindows.size > 0;
    const intentionallyPreempted = failure.code === 'LIVE_CUE_TRANSITION_CANCELLED'
      || failure.code === 'OUTPUT_SESSION_REPLACED';
    if (sameSession && !intentionallyPreempted) {
      markLiveCueTransitionFailure(outputs, sessionId, slideIndex);
      if (
        failure.code === 'LIVE_CUE_OUTPUT_UNRESPONSIVE'
        || failure.code === 'LIVE_CUE_TRANSITION_TIMEOUT'
      ) {
        // Renderer IPC cannot prove a black frame after an unresponsive
        // process or a missing acknowledgement. Stop/hide every routed window
        // rather than claiming Clear succeeded while even one screen may still
        // contain a mixed cue.
        hideDisplayWindows();
      } else {
        clearAllDisplays();
      }
    }
    return failure;
  } finally {
    if (activeLiveCueNavigation === transaction) {
      activeLiveCueNavigation = null;
      if (sessionId === outputSessionId && appState.activeLaunchPlan === launchPlan) {
        publishShowState('cue-transition-finished');
      }
    }
  }
}

async function navigateSlideConfirmed(delta) {
  if (delta !== -1 && delta !== 1) {
    return {
      accepted: false,
      code: 'INVALID_CUE_DIRECTION',
      message: 'Show navigation must move one cue at a time.'
    };
  }
  if (!appState.activeLaunchPlan) {
    return { accepted: false, code: 'NO_ACTIVE_SHOW', message: 'There is no active Show.' };
  }
  const newSlide = appState.currentSlide + delta;
  if (newSlide < 0 || newSlide >= appState.totalSlides) {
    return {
      accepted: false,
      code: delta < 0 ? 'AT_FIRST_CUE' : 'AT_LAST_CUE',
      message: delta < 0
        ? 'The Show is already at the first cue.'
        : 'The Show is already at the last cue.'
    };
  }
  return goToSlideConfirmed(newSlide);
}

function liveCueNavigationWasPreempted(result) {
  return result?.accepted === false
    && (
      result.code === 'LIVE_CUE_TRANSITION_CANCELLED'
      || result.code === 'OUTPUT_SESSION_REPLACED'
    );
}

function goToSlide(
  slideIndex,
  {
    publish = true,
    notifyControl = true,
    capturePreviews = true
  } = {}
) {
  if (!appState.activeLaunchPlan) {
    return { accepted: false, code: 'NO_ACTIVE_SHOW', message: 'There is no active Show.' };
  }
  if (outputLifecyclePhase === 'locally-stopped') {
    return { accepted: false, code: 'SHOW_STOPPED_LOCALLY', message: 'The outputs were stopped locally.' };
  }
  if (pendingBibleLookup || activeBibleOverlay || pendingBibleOverlay) {
    return { accepted: false, code: 'BIBLE_OVERLAY_ACTIVE', message: 'Return from the Bible passage first.' };
  }
  if (!Number.isInteger(slideIndex) || slideIndex < 0 || slideIndex >= appState.totalSlides) {
    return { accepted: false, code: 'INVALID_CUE_INDEX', message: 'That cue does not exist.' };
  }

  const dispatched = dispatchCueToOutputs(slideIndex);
  if (dispatched.accepted !== true) return dispatched;
  commitCueNavigation(slideIndex, {
    publish,
    notifyControl,
    capturePreviews
  });
  return { accepted: true };
}

function dispatchCueToOutputs(slideIndex, { expectedOutputs = null } = {}) {
  if (!Number.isInteger(slideIndex) || slideIndex < 0 || slideIndex >= appState.totalSlides) {
    return { accepted: false, code: 'INVALID_CUE_INDEX', message: 'That cue does not exist.' };
  }

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

  const launchPlan = appState.activeLaunchPlan;
  const routedOutputs = launchPlan?.outputs?.map(output => {
    const entry = outputWindows.get(output.id);
    if (
      entry?.output !== output
      || !isCurrentOutputWindow(entry?.win, entry?.sessionId, output.id)
      || entry.win.webContents.isDestroyed()
    ) return null;
    return entry;
  }) || [];
  if (
    !launchPlan
    || routedOutputs.length !== launchPlan.outputs.length
    || routedOutputs.some(entry => entry === null)
    || (expectedOutputs !== null && (
      !Array.isArray(expectedOutputs)
      || expectedOutputs.length !== routedOutputs.length
      || routedOutputs.some((entry, index) =>
        expectedOutputs[index]?.outputId !== entry.output.id
        || expectedOutputs[index]?.sender !== entry.win.webContents)
    ))
  ) {
    return {
      accepted: false,
      code: 'OUTPUTS_UNAVAILABLE',
      message: 'Every routed output must be available before changing cues.'
    };
  }

  const healthBarriersExist = routedOutputs.every(({ win, output, sessionId }) => {
    const health = outputHealthTracker.read(
      output.id,
      sessionId,
      win.webContents
    );
    return health !== null && health.status !== 'unavailable';
  });
  if (!healthBarriersExist) {
    return {
      accepted: false,
      code: 'OUTPUTS_NOT_READY',
      message: 'Every routed output must be healthy before changing cues.'
    };
  }

  // Arm every exact sender/session/cue expectation before the first renderer
  // sees the new cue. If one health barrier cannot be installed, no output is
  // allowed to advance.
  const expectationsReady = routedOutputs.every(({ win, output, sessionId }) =>
    outputHealthTracker.expectFrame({
      outputId: output.id,
      sessionId,
      sender: win.webContents,
      cueIndex: slideIndex
    }) === true);
  if (!expectationsReady) {
    return {
      accepted: false,
      code: 'OUTPUTS_NOT_READY',
      message: 'Every routed output must be healthy before changing cues.'
    };
  }

  let dispatchedOutputs = 0;
  for (const { win, output } of routedOutputs) {
    dispatchedOutputs += 1;

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

      console.log(
        `[Singer] Sending ${output.name}: slide ${slideIndex + 1}, source ${sourceRoleId}, `
        + `image: ${currentSlideImage ? 'yes' : 'no'}, next text: ${nextSlideText ? 'yes' : 'no'}`
      );

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

  if (dispatchedOutputs === 0) {
    return {
      accepted: false,
      code: 'OUTPUTS_UNAVAILABLE',
      message: 'No current output window could receive that cue.'
    };
  }

  return { accepted: true, dispatchedOutputs };
}

function sceneContainsVideo(scene) {
  if (!scene || typeof scene !== 'object') return false;
  if (scene.layout === 'video') return true;
  return scene.layout === 'singer-current-next' && sceneContainsVideo(scene.current);
}

function videoOutputsForCue(slideIndex) {
  const launchPlan = appState.activeLaunchPlan;
  if (!launchPlan || !Number.isInteger(slideIndex)) return [];
  const matches = [];
  for (const output of launchPlan.outputs) {
    if (output.renderer !== 'native-cue') continue;
    const payload = getNativeCuePayload(output.sourceRoleId, slideIndex, output.nativeVariant);
    if (!sceneContainsVideo(payload?.scene)) continue;
    matches.push({
      outputId: output.id,
      cueId: payload.scene.cueId
    });
  }
  return matches;
}

function armVideoPlaybackForCue(slideIndex) {
  const outputs = videoOutputsForCue(slideIndex);
  activeVideoPlayback = outputs.length > 0
    ? {
        sessionId: outputSessionId,
        index: slideIndex,
        cueId: outputs[0].cueId,
        outputIds: outputs.map(output => output.outputId),
        state: 'armed'
      }
    : null;
  return activeVideoPlayback;
}

function sendActiveVideoControl(action) {
  const playback = activeVideoPlayback;
  if (!playback
    || playback.sessionId !== outputSessionId
    || playback.index !== appState.currentSlide) return 0;
  let sent = 0;
  for (const outputId of playback.outputIds) {
    const entry = outputWindows.get(outputId);
    if (!entry?.win
      || entry.win.isDestroyed()
      || entry.sessionId !== playback.sessionId
      || entry.win.webContents.isDestroyed()) continue;
    entry.win.webContents.send('native-cue:video-control', {
      outputId,
      index: playback.index,
      cueId: playback.cueId,
      action
    });
    sent += 1;
  }
  return sent;
}

function handleCurrentVideoForwardAction(input) {
  if (!['right', 'space'].includes(input)
    || !appState.activeLaunchPlan
    || appState.isCleared
    || outputLifecyclePhase !== 'live') return { handled: false };
  if (!activeVideoPlayback
    || activeVideoPlayback.sessionId !== outputSessionId
    || activeVideoPlayback.index !== appState.currentSlide) {
    armVideoPlaybackForCue(appState.currentSlide);
  }
  const playback = activeVideoPlayback;
  if (!playback) return { handled: false };

  let action = null;
  let nextState = playback.state;
  if (playback.state === 'armed') {
    action = 'play';
    nextState = 'playing';
  } else if (input === 'space' && playback.state === 'playing') {
    action = 'pause';
    nextState = 'paused';
  } else if (input === 'space' && playback.state === 'paused') {
    action = 'play';
    nextState = 'playing';
  }
  if (!action) return { handled: false, videoState: playback.state };
  if (sendActiveVideoControl(action) < 1) {
    return { handled: false, videoState: 'error' };
  }
  playback.state = nextState;
  return { handled: true, videoState: nextState };
}

function commitCueNavigation(
  slideIndex,
  {
    publish = true,
    notifyControl = true,
    capturePreviews = true
  } = {}
) {
  appState.currentSlide = slideIndex;
  armVideoPlaybackForCue(slideIndex);
  // A cue becomes current only after its caller's reveal contract is met.
  // Hidden startup/rehearsal callers commit through their own exact frame
  // barrier; live operator navigation commits after every routed output has
  // acknowledged the same cue.
  appState.isCleared = false;
  if (outputLifecyclePhase !== 'starting') outputLifecyclePhase = 'live';

  // Update control panel
  if (notifyControl && controlWindow && !controlWindow.isDestroyed()) {
    controlWindow.webContents.send('slide:changed', {
      currentSlide: slideIndex,
      totalSlides: appState.totalSlides
    });
  }

  // Capture every output selected for the operator after it has rendered.
  if (capturePreviews) captureOutputPreviews();
  if (publish) publishShowState('cue-changed');
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
  return resolveNativeCuePayload({
    presentation: appState.presentations[roleId],
    cueIndex: slideIndex,
    variant
  });
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
    return text;
  }
  console.log(`[getSlideText] No slide data for ${language} index ${slideIndex}`);
  return '';
}

function hideDisplayWindows() {
  if (activeLiveCueNavigation?.kind === 'restore') {
    activeLiveCueNavigation.stopRequested = true;
  }
  liveCueTransitionCoordinator?.cancel(
    'The outputs were stopped while changing cues.',
    'LIVE_CUE_TRANSITION_CANCELLED'
  );
  stopRemoteForShow('outputs-stopped');
  if (activeBibleOverlay || pendingBibleOverlay) hideBibleOverlay({ restore: false });
  else bibleOperationEpoch += 1;
  pendingBibleLookup = null;
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
  const restoring = activeLiveCueNavigation?.kind === 'restore'
    ? activeLiveCueNavigation
    : null;
  if (restoring) restoring.clearRequested = true;
  liveCueTransitionCoordinator?.cancel(
    'The outputs were cleared while changing cues.',
    'LIVE_CUE_TRANSITION_CANCELLED'
  );
  // Clear is the emergency escape hatch. A temporary Bible overlay is
  // cancelled before every output is blacked, so Return cannot unexpectedly
  // resurrect it later.
  if (activeBibleOverlay || pendingBibleOverlay) hideBibleOverlay({ restore: false });
  else bibleOperationEpoch += 1;
  pendingBibleLookup = null;
  appState.isCleared = true;
  if (
    restoring?.guardReady === true
    || outputLifecyclePhase !== 'locally-stopped'
  ) {
    outputLifecyclePhase = 'cleared';
  }
  let clearDeliveryFailed = false;
  outputWindows.forEach(({ win, output, sessionId }) => {
    if (!win || win.isDestroyed() || win.webContents.isDestroyed()) {
      clearDeliveryFailed = true;
      return;
    }
    try {
      win.webContents.send('display:clear');
      outputHealthTracker?.markCleared({
        outputId: output.id,
        sessionId,
        sender: win.webContents
      });
    } catch (error) {
      clearDeliveryFailed = true;
      console.error(`[Display] Could not clear ${output.name || output.id}:`, error);
      outputHealthTracker?.markUnresponsive({
        outputId: output.id,
        sessionId,
        sender: win.webContents
      });
    }
  });
  if (clearDeliveryFailed) {
    hideDisplayWindows();
    return {
      accepted: false,
      code: 'OUTPUT_CLEAR_FAILED',
      message: 'An output could not be blacked safely, so every output was stopped.'
    };
  }
  if (
    restoring?.guardReady === true
    && restoring.sessionId === outputSessionId
    && activeLiveCueNavigation === restoring
  ) {
    outputsShouldBeVisible = true;
    if (!showExactLiveCueTransitionOutputs(restoring.outputs, restoring.sessionId)) {
      hideDisplayWindows();
      return {
        accepted: false,
        code: 'OUTPUT_CLEAR_FAILED',
        message: 'A guarded output could not remain visibly black, so every output was stopped.'
      };
    }
    restoring.outputsShown = true;
  }
  // Notify control panel
  if (controlWindow && !controlWindow.isDestroyed()) {
    controlWindow.webContents.send('displays:cleared');
  }
  captureOutputPreviews();
  publishShowState('outputs-cleared');
  return { accepted: true };
}

function showExactLiveCueTransitionOutputs(outputs, sessionId) {
  let shown = true;
  for (const output of outputs) {
    const entry = outputWindows.get(output.outputId);
    const win = entry?.win;
    if (
      entry?.sessionId !== sessionId
      || !isCurrentOutputWindow(win, sessionId, output.outputId)
      || win.webContents !== output.sender
      || win.webContents.isDestroyed()
    ) {
      shown = false;
      continue;
    }
    try {
      if (!win.isVisible()) showOutputWindow(win);
    } catch (error) {
      shown = false;
      console.error(
        `[Display] Could not present ${output.outputId} behind the black Restore guard:`,
        error
      );
    }
  }
  return shown;
}

function sameVisibleLiveCueTransitionOutputs(expectedOutputs, sessionId) {
  return sameLiveCueTransitionOutputs(expectedOutputs)
    && expectedOutputs.every(output => {
      const entry = outputWindows.get(output.outputId);
        return entry?.sessionId === sessionId
        && entry.win?.webContents === output.sender
        && entry.win.isVisible() === true;
    });
}

// Restore all displays behind an independently acknowledged black renderer
// guard. A visible Clear stays fullscreen black; a stopped/hidden output is
// shown only after that guard has painted. The authoritative cue is rendered
// underneath it and the guard is released only after every exact frame ACK.
async function showAllDisplays() {
  if (!appState.activeLaunchPlan || outputWindows.size === 0) {
    return { accepted: false, code: 'NO_ACTIVE_SHOW', message: 'There is no active Show.' };
  }
  if (
    activeLiveCueNavigation !== null
    || liveCueTransitionCoordinator?.isPending()
  ) {
    return {
      accepted: false,
      code: 'LIVE_CUE_TRANSITION_BUSY',
      message: 'Wait for the current cue to reach every output before restoring the Show.'
    };
  }
  if (pendingBibleLookup) {
    return {
      accepted: false,
      code: 'BIBLE_OVERLAY_ACTIVE',
      message: 'Wait for the Bible passage request to finish before restoring the Show.'
    };
  }
  if (activeBibleOverlay || pendingBibleOverlay) {
    return {
      accepted: false,
      code: 'BIBLE_OVERLAY_ACTIVE',
      message: 'Return from the Bible passage before restoring the Show.'
    };
  }
  if (outputLifecyclePhase === 'live' && outputsShouldBeVisible && !appState.isCleared) {
    return { accepted: true, applied: false };
  }
  if (!['cleared', 'locally-stopped'].includes(outputLifecyclePhase)) {
    return {
      accepted: false,
      code: 'SHOW_NOT_READY',
      message: 'The outputs are not in a state that can be restored safely.'
    };
  }

  const outputSnapshot = currentLiveCueTransitionOutputs();
  if (outputSnapshot.accepted !== true) return outputSnapshot;
  const launchPlan = outputSnapshot.launchPlan;
  const sessionId = outputSessionId;
  const cueIndex = appState.currentSlide;
  const outputs = outputSnapshot.outputs;
  const initialPhase = outputLifecyclePhase;
  const initiallyVisible = Object.freeze(outputs.map(output => {
    const entry = outputWindows.get(output.outputId);
    return entry?.sessionId === sessionId
      && entry.win?.webContents === output.sender
      && entry.win.isVisible() === true;
  }));
  if (
    (initialPhase === 'cleared' && initiallyVisible.some(visible => !visible))
    || (initialPhase === 'locally-stopped' && initiallyVisible.some(Boolean))
  ) {
    return {
      accepted: false,
      code: 'OUTPUTS_UNAVAILABLE',
      message: 'The routed outputs do not match the expected Clear or Stop state.'
    };
  }
  const guardId = nextOutputRestoreGuardId(sessionId);
  const transaction = {
    kind: 'restore',
    sessionId,
    launchPlan,
    cueIndex,
    outputs,
    initialPhase,
    initiallyVisible,
    outputIds: Object.freeze(outputs.map(output => output.outputId)),
    guardId,
    guardReady: false,
    guardActive: false,
    outputsShown: false,
    guardReadyPromise: null,
    clearRequested: false,
    stopRequested: false
  };

  try {
    activeLiveCueNavigation = transaction;
    transaction.guardReadyPromise = setOutputRestoreGuard({
      outputs: [...outputs],
      sessionId,
      guardId,
      active: true
    });
    await transaction.guardReadyPromise;
    transaction.guardReady = true;
    transaction.guardActive = true;

    if (
      activeLiveCueNavigation !== transaction
      || transaction.stopRequested
      || sessionId !== outputSessionId
      || appState.activeLaunchPlan !== launchPlan
    ) {
      throw liveCueNavigationFailure(
        'LIVE_CUE_TRANSITION_CANCELLED',
        'Restore was stopped before its black output guard was ready.'
      );
    }

    // No window is revealed until its renderer has acknowledged two paint
    // frames of opaque black. Outputs that were already showing Clear stay
    // fullscreen throughout; stopped outputs now return as guarded black.
    if (!showExactLiveCueTransitionOutputs(outputs, sessionId)) {
      throw liveCueNavigationFailure(
        'OUTPUTS_UNAVAILABLE',
        'Every routed output must be available behind the black Restore guard.'
      );
    }
    transaction.outputsShown = true;
    outputsShouldBeVisible = true;
    outputLifecyclePhase = 'cleared';
    appState.isCleared = true;

    if (transaction.clearRequested) {
      throw liveCueNavigationFailure(
        'LIVE_CUE_TRANSITION_CANCELLED',
        'The outputs were cleared while Restore was preparing.'
      );
    }

    const operation = liveCueTransitionCoordinator.beginRefresh({
      sessionId,
      cueIndex,
      outputs: [...outputs]
    });

    let dispatched;
    try {
      dispatched = dispatchCueToOutputs(cueIndex, {
        expectedOutputs: outputs
      });
    } catch (error) {
      throw liveCueNavigationFailure(
        'LIVE_CUE_DISPATCH_FAILED',
        'The current cue could not be sent safely behind every black output guard.',
        { cause: error instanceof Error ? error.message : String(error) }
      );
    }
    if (
      dispatched.accepted !== true
      || dispatched.dispatchedOutputs !== outputs.length
    ) {
      throw liveCueNavigationFailure(
        dispatched.code || 'OUTPUTS_UNAVAILABLE',
        dispatched.message || 'The current cue could not be sent behind every black output guard.'
      );
    }

    publishShowState('outputs-restore-started');
    const receipt = await operation.promise;
    const exactReceipt = receipt?.kind === LIVE_CUE_TRANSITION_RECEIPT_KIND
      && receipt.schemaVersion === LIVE_CUE_TRANSITION_SCHEMA_VERSION
      && receipt.sessionId === sessionId
      && receipt.fromCueIndex === cueIndex
      && receipt.toCueIndex === cueIndex
      && Array.isArray(receipt.outputIds)
      && receipt.outputIds.length === outputs.length
      && receipt.outputIds.every((outputId, index) =>
        outputId === outputs[index].outputId);
    if (
      sessionId !== outputSessionId
      || appState.activeLaunchPlan !== launchPlan
      || appState.currentSlide !== cueIndex
      || activeLiveCueNavigation !== transaction
      || !outputsShouldBeVisible
      || outputLifecyclePhase !== 'cleared'
      || transaction.clearRequested
      || transaction.stopRequested
      || pendingBibleLookup
      || activeBibleOverlay
      || pendingBibleOverlay
      || !exactReceipt
      || !sameVisibleLiveCueTransitionOutputs(outputs, sessionId)
    ) {
      throw liveCueNavigationFailure(
        'LIVE_CUE_TRANSITION_STALE',
        'The Show changed before its current cue could be restored safely.'
      );
    }

    await setOutputRestoreGuard({
      outputs: [...outputs],
      sessionId,
      guardId,
      active: false
    });
    if (
      sessionId !== outputSessionId
      || appState.activeLaunchPlan !== launchPlan
      || appState.currentSlide !== cueIndex
      || activeLiveCueNavigation !== transaction
      || transaction.clearRequested
      || transaction.stopRequested
      || !outputsShouldBeVisible
      || outputLifecyclePhase !== 'cleared'
      || !sameVisibleLiveCueTransitionOutputs(outputs, sessionId)
    ) {
      throw liveCueNavigationFailure(
        'LIVE_CUE_TRANSITION_CANCELLED',
        'The Show changed while its black Restore guard was being released.'
      );
    }

    // The first release phase is only an all-output readiness barrier; every
    // guard remains opaque. Reveal begins only after all exact renderers have
    // confirmed they still own this token and authoritative cue.
    transaction.revealStarted = true;
    await setOutputRestoreGuard({
      outputs: [...outputs],
      sessionId,
      guardId,
      active: false,
      reveal: true
    });
    transaction.guardActive = false;
    if (
      sessionId !== outputSessionId
      || appState.activeLaunchPlan !== launchPlan
      || appState.currentSlide !== cueIndex
      || activeLiveCueNavigation !== transaction
      || transaction.clearRequested
      || transaction.stopRequested
      || !outputsShouldBeVisible
      || outputLifecyclePhase !== 'cleared'
      || !sameVisibleLiveCueTransitionOutputs(outputs, sessionId)
    ) {
      throw liveCueNavigationFailure(
        'LIVE_CUE_TRANSITION_CANCELLED',
        'The Show changed while its authoritative cue was being revealed.'
      );
    }

    appState.isCleared = false;
    outputsShouldBeVisible = true;
    outputLifecyclePhase = 'live';
    activeLiveCueNavigation = null;
    captureOutputPreviews();
    publishShowState('outputs-restored');
    return { accepted: true, applied: true, receipt };
  } catch (error) {
    const failure = normalizeLiveCueNavigationFailure(error);
    if (liveCueTransitionCoordinator?.isPending()) {
      liveCueTransitionCoordinator.cancel(failure.message, failure.code);
    }
    const sameSession = sessionId === outputSessionId
      && appState.activeLaunchPlan === launchPlan
      && outputWindows.size > 0;
    const intentionallyPreempted = transaction.clearRequested
      || transaction.stopRequested
      || failure.code === 'LIVE_CUE_TRANSITION_CANCELLED'
      || failure.code === 'OUTPUT_SESSION_REPLACED';
    let blackGuardProven = transaction.guardReady
      && transaction.guardActive
      && transaction.revealStarted !== true;
    if (
      sameSession
      && transaction.guardReady
      && transaction.revealStarted === true
      && !transaction.stopRequested
    ) {
      try {
        const recoveryGuardId = nextOutputRestoreGuardId(sessionId);
        await setOutputRestoreGuard({
          outputs: [...outputs],
          sessionId,
          guardId: recoveryGuardId,
          active: true
        });
        transaction.guardId = recoveryGuardId;
        transaction.guardActive = true;
        blackGuardProven = true;
      } catch (recoveryError) {
        blackGuardProven = false;
        console.error('[Display] Could not re-cover every output after Restore failed:', recoveryError);
      }
    }
    if (sameSession && transaction.guardReady && blackGuardProven) {
      if (!intentionallyPreempted) {
        markLiveCueTransitionFailure(outputs, sessionId, cueIndex);
      }
      if (transaction.stopRequested) {
        hideDisplayWindows();
      } else {
        // The last proven pixels are the opaque guard. Preserve that visible
        // black state on timeout, rejection, dispatch failure, or emergency
        // Clear instead of exposing the desktop beneath a hidden window.
        appState.isCleared = true;
        outputsShouldBeVisible = true;
        outputLifecyclePhase = 'cleared';
        if (showExactLiveCueTransitionOutputs(outputs, sessionId)) {
          transaction.outputsShown = true;
          publishShowState('outputs-restore-failed-black');
        } else {
          appState.isCleared = false;
          outputLifecyclePhase = 'interrupted';
          publishShowState('outputs-restore-failed-unavailable');
        }
      }
    } else if (sameSession) {
      if (!intentionallyPreempted) {
        markLiveCueTransitionFailure(outputs, sessionId, cueIndex);
      }
      if (transaction.stopRequested) {
        hideDisplayWindows();
      } else if (initialPhase === 'locally-stopped' && !transaction.outputsShown) {
        outputsShouldBeVisible = false;
        outputLifecyclePhase = 'locally-stopped';
      } else {
        // A visible Clear is already opaque black. If renderer guard cover or
        // recovery fails, leave those windows untouched rather than exposing
        // the desktop by hiding them, but report the uncertainty honestly.
        outputsShouldBeVisible = true;
        outputLifecyclePhase = transaction.clearRequested
          ? 'cleared'
          : 'interrupted';
        appState.isCleared = transaction.clearRequested;
      }
      publishShowState('outputs-restore-failed-unavailable');
    }
    return failure;
  } finally {
    if (activeLiveCueNavigation === transaction) {
      activeLiveCueNavigation = null;
      if (sessionId === outputSessionId && appState.activeLaunchPlan === launchPlan) {
        publishShowState('outputs-restore-finished');
      }
    }
  }
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

async function resolveSermonPrimaryReferenceLookupRequest(request) {
  const { query, selectedBook } = normalizeBibleLookupRequest({
    query: request?.query,
    selectedBook: request?.selectedBook,
    translationId: 'BSB'
  });
  return sermonReferenceBibleLibrary.lookup(query, {
    translationId: 'BSB',
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
  pendingBibleLookup = null;
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
  authorizeLocalShowCommand('bible.show');
  if (
    activeLiveCueNavigation !== null
    || liveCueTransitionCoordinator?.isPending()
  ) {
    failMainOperation(
      'LIVE_CUE_TRANSITION_BUSY',
      'Wait for the current cue to reach every output before showing a Bible passage.'
    );
  }
  if (pendingBibleLookup) {
    failMainOperation(
      'BIBLE_OVERLAY_ACTIVE',
      'A Bible passage is already being prepared for the outputs.'
    );
  }
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
  const lookupToken = Object.freeze({
    sessionId,
    operationEpoch,
    targetOutputIds: Object.freeze([...targetOutputIds])
  });
  pendingBibleLookup = lookupToken;
  publishShowState('bible-lookup-started');
  try {
  const lookupResult = await resolveBibleLookupRequest(request);
  if (operationEpoch !== bibleOperationEpoch
    || pendingBibleLookup !== lookupToken
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
  if (pendingBibleLookup !== lookupToken) {
    throw new Error('The Bible send was cancelled before its passage could be prepared');
  }
  pendingBibleOverlay = candidate;
  pendingBibleLookup = null;
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
  } finally {
    if (pendingBibleLookup === lookupToken) {
      pendingBibleLookup = null;
      if (sessionId === outputSessionId && appState.activeLaunchPlan) {
        publishShowState('bible-lookup-finished');
      }
    }
  }
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

function requireExactPrepareKeys(value, allowedKeys, label) {
  const allowed = new Set(allowedKeys);
  const unsupported = Object.keys(value).filter(key => !allowed.has(key));
  if (unsupported.length > 0) {
    failMainOperation(
      'UNSUPPORTED_PREPARE_FIELDS',
      `${label} contains fields SyncShow does not accept.`
    );
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

function prepareProjectedBodyText(
  value,
  label,
  maximum,
  { required = false } = {}
) {
  if (value === undefined || value === null) value = '';
  if (typeof value !== 'string') {
    failMainOperation('INVALID_PREPARE_TEXT', `${label} must be text.`);
  }
  if (
    value.length > maximum
    || Buffer.byteLength(value, 'utf8') > maximum * 3
  ) {
    failMainOperation(
      'PREPARE_TEXT_TOO_LONG',
      `${label} must be ${maximum} characters or fewer.`
    );
  }
  if (!value.trim()) {
    if (required) {
      failMainOperation('MISSING_PREPARE_TEXT', `${label} is required.`);
    }
    return '';
  }
  return value;
}

function preparePostServiceLinkSlot(raw, label, allowedKinds) {
  if (raw === undefined || raw === null) return null;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    failMainOperation(
      'INVALID_POST_SERVICE_LINK',
      `${label} details are invalid.`
    );
  }
  requireExactPrepareKeys(raw, ['kind', 'status', 'url'], `${label} details`);
  const kind = prepareText(raw.kind, `${label} kind`, 16, { required: true });
  const status = prepareText(raw.status, `${label} status`, 16, { required: true });
  if (!allowedKinds.includes(kind) || !['pending', 'ready'].includes(status)) {
    failMainOperation(
      'INVALID_POST_SERVICE_LINK',
      `${label} kind or status is not supported.`
    );
  }
  return {
    kind,
    status,
    url: prepareText(raw.url, `${label} link`, 4096)
  };
}

function prepareLanguageTags(value, label, { maximum = 8 } = {}) {
  const rawTags = Array.isArray(value) ? value : [value];
  if (rawTags.length < 1 || rawTags.length > maximum) {
    failMainOperation(
      'INVALID_SERMON_SOURCE_LANGUAGES',
      `${label} must include between 1 and ${maximum} language tags.`
    );
  }
  const tags = [...new Set(rawTags.map((tag, index) => {
    const normalized = prepareText(
      tag,
      `${label} ${index + 1}`,
      35,
      { required: true }
    ).toLowerCase();
    if (!/^[a-z]{2,3}(?:-[a-z0-9]{2,8})*$/.test(normalized)) {
      failMainOperation(
        'INVALID_SERMON_SOURCE_LANGUAGES',
        `${label} must use BCP-47-style tags such as en or ru.`
      );
    }
    return normalized;
  }))].sort();
  return tags;
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

function prepareSermonDomainId(value, label) {
  const normalized = prepareText(value, label, 128, { required: true });
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(normalized)) {
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
  const transactionRecovery = await services.sermonProjectCommitCoordinator.recover();
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
  return {
    ...current,
    recovery: current.recovery || (
      transactionRecovery.message
        ? {
            source: 'sermon-project-transaction',
            message: transactionRecovery.message
          }
        : null
    ),
    services,
    projectId,
    expectedRevisionId
  };
}

function projectResult(result) {
  const native = !isPowerPointCompanionProject(result.project);
  return {
    project: result.project,
    revisionId: result.revisionId,
    unchanged: result.unchanged === true,
    recovery: result.recovery || null,
    readiness: native
      ? analyzeServiceProjectReadiness(result.project, {
          waivers: result.project.planning?.readinessWaivers || []
        })
      : null,
    runSheet: native && result.project.planning
      ? buildServiceRunSheet(result.project)
      : null
  };
}

function sermonLibrarySummaryResult(summary) {
  return {
    sermonId: summary.id,
    sermonRevisionId: summary.revision,
    title: summary.title,
    titles: { ...summary.titles },
    languages: [...summary.languages],
    defaultLanguage: summary.defaultLanguage,
    speaker: {
      id: summary.speaker.id,
      name: summary.speaker.name
    },
    serviceDate: summary.serviceDate,
    series: summary.series
      ? {
          id: summary.series.id,
          titles: { ...summary.series.titles }
        }
      : null,
    primaryReferenceCount: summary.primaryReferenceCount,
    mentionedReferenceCount: summary.mentionedReferenceCount,
    confirmedReferenceCount: summary.confirmedReferenceCount,
    publication: {
      status: summary.publication.status,
      visibility: summary.publication.visibility,
      publishedAt: summary.publication.publishedAt
    },
    updatedAt: summary.updatedAt
  };
}

function sermonOutlineResult(read) {
  const sermon = read.sermon;
  return {
    sermonId: sermon.id,
    sermonRevisionId: read.revision,
    title: sermon.titles[sermon.defaultLanguage],
    titles: { ...sermon.titles },
    defaultLanguage: sermon.defaultLanguage,
    speaker: {
      id: sermon.speaker.id,
      name: sermon.speaker.name
    },
    serviceDate: sermon.serviceDate,
    outline: sermon.outline.map(section => ({
      id: section.id,
      parentId: section.parentId,
      kind: section.kind,
      titles: { ...section.titles }
    }))
  };
}

function failSermonSourceImport(error) {
  const messages = {
    EMPTY_SOURCE: 'The selected sermon source is empty.',
    SOURCE_TOO_LARGE: 'The selected sermon source is too large to import safely.',
    UNSUPPORTED_SOURCE_TYPE: 'Choose a PDF, DOCX, PPTX, TXT, or Markdown sermon source.',
    SOURCE_TYPE_MISMATCH: 'The selected sermon source does not match its file type.',
    CORRUPT_SOURCE: 'The selected sermon source is incomplete or damaged.',
    UNSAFE_SOURCE: 'The selected sermon source is not a stable regular file.',
    INVALID_SOURCE_PATH: 'Choose the sermon source again.',
    INVALID_SOURCE_METADATA: 'The reviewed sermon source details are invalid.',
    LOCAL_PATH_NOT_ALLOWED: 'The sermon source details cannot contain a local path.',
    STORE_UNAVAILABLE: 'The private sermon source store is unavailable.',
    WRITE_LOCKED: 'Another sermon source import is still finishing.',
    OBJECT_NOT_FOUND: 'The imported sermon source could not be verified.',
    OBJECT_CORRUPT: 'The imported sermon source failed its integrity check.'
  };
  failMainOperation(
    'SERMON_SOURCE_IMPORT_FAILED',
    messages[error?.code] || 'The sermon source could not be imported safely.',
    { cause: typeof error?.code === 'string' ? error.code : 'UNKNOWN' }
  );
}

function failNativeSermonMaterialIntake(error) {
  const messages = {
    ARCHIVED_SERMON:
      'Restore this archived sermon before saving pasted sermon material.',
    MISSING_MATERIAL:
      'Paste the pastor manuscript, the sermon slide notes, or both.',
    MISSING_MATERIAL_TEXT:
      'Each included sermon material field needs complete reviewed text.',
    INVALID_MATERIAL_LANGUAGE:
      'Use one content language tag such as en or ru.',
    INVALID_MATERIAL:
      'The pasted sermon material details are invalid.',
    INVALID_MATERIAL_TEXT:
      'The pasted sermon material must be UTF-8 text.',
    INVALID_MATERIAL_METADATA:
      'The pasted sermon material metadata is invalid.',
    UNSAFE_MATERIAL_TEXT:
      'The pasted sermon material contains an unsupported control character.',
    MATERIAL_TOO_LARGE:
      'Each pasted sermon material field must be 1 MB or smaller.',
    MATERIAL_BODY_TOO_LARGE:
      'The combined pasted sermon material must be 1.5 MB or smaller.',
    MATERIAL_CAPACITY_EXCEEDED:
      'This sermon cannot safely hold the complete pasted material.',
    AMBIGUOUS_MANAGED_MATERIAL:
      'This sermon has conflicting earlier pasted material. Review or remove the duplicate managed entries before saving again.',
    MATERIAL_ID_COLLISION:
      'An unrelated sermon source already uses the identity reserved for this pasted material. Review the sermon sources before saving again.',
    MATERIAL_REVIEW_REQUIRED:
      'Confirm the complete pasted text, its role, and its language before saving.',
    SERMON_REVISION_MISMATCH:
      'The linked sermon changed before the pasted material could be saved.',
    SERMON_RESOURCE_MISMATCH:
      'The selected service item no longer identifies that exact sermon revision.',
    MATERIAL_ALREADY_PRESENT:
      'That exact pasted sermon material is already present.'
  };
  failMainOperation(
    error?.code || 'NATIVE_SERMON_MATERIAL_FAILED',
    messages[error?.code]
      || 'The reviewed pasted sermon material could not be saved safely.',
    error?.details || {}
  );
}

function sameNativeSermonMaterialSource(actual, expected) {
  return Boolean(
    actual
    && expected
    && actual.id === expected.id
    && actual.kind === expected.kind
    && actual.fileName === expected.fileName
    && actual.mediaType === expected.mediaType
    && actual.sha256 === expected.sha256
    && actual.sizeBytes === expected.sizeBytes
    && JSON.stringify(actual.languages) === JSON.stringify(expected.languages)
    && JSON.stringify(actual.provenance) === JSON.stringify(expected.provenance)
  );
}

function failSermonMediaImport(error) {
  const messages = {
    EMPTY_MEDIA: 'The selected recording is empty.',
    MEDIA_TOO_LARGE: 'The selected recording is too large to preserve safely.',
    UNSUPPORTED_MEDIA_TYPE: 'Choose an MP3, M4A, or MP4 sermon recording.',
    MEDIA_TYPE_MISMATCH: 'The selected recording does not match its file type.',
    MEDIA_RESTORE_MISMATCH:
      'Choose the exact same recording file identified by this sermon record.',
    CORRUPT_MEDIA: 'The selected recording is incomplete or damaged.',
    UNSAFE_MEDIA: 'The selected recording is not a stable regular file.',
    INVALID_MEDIA_PATH: 'Choose the sermon recording again.',
    INVALID_MEDIA_METADATA: 'The sermon recording details are invalid.',
    LOCAL_PATH_NOT_ALLOWED: 'Recording details cannot contain a machine-local path.',
    STORE_UNAVAILABLE: 'The private sermon recording store is unavailable.',
    WRITE_LOCKED: 'Another sermon recording import is still finishing.',
    OBJECT_NOT_FOUND: 'The preserved sermon recording could not be verified.',
    OBJECT_CORRUPT: 'The preserved sermon recording failed its integrity check.'
  };
  failMainOperation(
    'SERMON_RECORDING_IMPORT_FAILED',
    messages[error?.code]
      || 'The sermon recording could not be preserved safely.',
    { cause: typeof error?.code === 'string' ? error.code : 'UNKNOWN' }
  );
}

function failSermonRecordingPlayback(error) {
  const messages = {
    INVALID_MEDIA_METADATA:
      'The preserved sermon recording details are invalid.',
    OBJECT_NOT_FOUND:
      'The preserved sermon recording is missing from this computer.',
    OBJECT_CORRUPT:
      'The preserved sermon recording failed its integrity check.',
    MEDIA_TYPE_MISMATCH:
      'The preserved sermon recording no longer matches its file type.',
    CORRUPT_MEDIA:
      'The preserved sermon recording is incomplete or damaged.',
    STORE_UNAVAILABLE:
      'The private sermon recording store is unavailable.'
  };
  failMainOperation(
    'SERMON_RECORDING_PLAYBACK_FAILED',
    messages[error?.code]
      || 'The private sermon recording could not be opened safely.',
    { cause: typeof error?.code === 'string' ? error.code : 'UNKNOWN' }
  );
}

function failServiceSermonPacket(error) {
  const messages = {
    INVALID_SERVICE_SET: 'The current service snapshot is not available for sermon review.',
    INVALID_PACKET_SOURCE: 'One reviewed sermon-packet source is invalid.',
    INVALID_LINKED_SERMON:
      'The exact linked sermon packet is not available for current-service source review.',
    AMBIGUOUS_EXISTING_PACKET_SOURCE:
      'The linked sermon contains duplicate records for one reviewed service file. Review its attached sources before continuing.',
    EXISTING_PACKET_SOURCE_CONFLICT:
      'A reviewed service file is already attached with a different source kind or file identity. Review that source before continuing.',
    DUPLICATE_PACKET_SOURCE_CONFLICT:
      'Two reviewed service files have identical bytes but incompatible source metadata. Reload the verified service set before continuing.',
    UNSUPPORTED_SERVICE_PRESENTATION:
      'This workflow can preserve verified PPTX service presentations, but one current input uses a different format.',
    PINNED_ASSET_UNAVAILABLE:
      'One current service presentation is no longer available in the pinned snapshot.',
    PINNED_ASSET_CHANGED:
      'One current service presentation changed after it was pinned. Reload the service before creating the packet.',
    INVALID_PINNED_SET:
      'The current service snapshot is not compatible with this SyncShow build.'
  };
  failMainOperation(
    'SERVICE_SERMON_PACKET_UNAVAILABLE',
    messages[error?.code]
      || 'The current service files could not be reviewed safely for this sermon packet.',
    { cause: typeof error?.code === 'string' ? error.code : 'UNKNOWN' }
  );
}

function serviceSermonPacketReadingMode(value) {
  const mode = prepareText(
    value,
    'Primary reading choice',
    32,
    { required: true }
  );
  if (!['already-in-service', 'insert-native'].includes(mode)) {
    failMainOperation(
      'INVALID_SERMON_READING_CHOICE',
      'Choose whether the reading is already in the service presentation or should be inserted as native Bible cues using the reviewed output treatments.'
    );
  }
  return mode;
}

async function resolveNewSermonPacketMetadata(request) {
  const title = prepareText(request.title, 'Sermon title', 300, { required: true });
  const speakerName = prepareText(
    request.speakerName,
    'Sermon speaker',
    200,
    { required: true }
  );
  const defaultLanguage = prepareText(
    request.defaultLanguage,
    'Sermon language',
    35,
    { required: true }
  ).toLowerCase();
  if (!/^[a-z]{2,3}(?:-[a-z0-9]{2,8})*$/.test(defaultLanguage)) {
    failMainOperation(
      'INVALID_SERMON_LANGUAGE',
      'Sermon language must be a BCP-47-style language tag such as en or ru.'
    );
  }
  const primaryReference = prepareText(
    request.primaryReference,
    'Primary Bible reference',
    160,
    { required: true }
  );
  const selectedBook = request.selectedBook === undefined
    || request.selectedBook === null
    || request.selectedBook === ''
    ? null
    : prepareText(request.selectedBook, 'Bible book selection', 80, { required: true });

  const lookup = await resolveSermonPrimaryReferenceLookupRequest({
    query: primaryReference,
    ...(selectedBook ? { selectedBook } : {})
  });
  if (lookup?.status !== 'ok' || !lookup.passage) {
    if (lookup?.status === 'ambiguous') {
      failMainOperation(
        'BIBLE_REFERENCE_AMBIGUOUS',
        'Choose which Bible book you meant before creating the sermon packet.',
        { choices: lookup.choices }
      );
    }
    failMainOperation(
      'BIBLE_REFERENCE_INVALID',
      lookup?.message || 'That primary Bible passage could not be confirmed.',
      { status: lookup?.status || 'error', code: lookup?.code || null }
    );
  }

  const passage = lookup.passage;
  const bookId = resolveBookId(passage.book);
  if (!bookId) {
    failMainOperation(
      'BIBLE_REFERENCE_INVALID',
      'That primary Bible passage does not use a canonical Bible book.'
    );
  }
  return {
    title,
    speakerName,
    defaultLanguage,
    primaryReference,
    selectedBook,
    passage,
    bookId
  };
}

function requireNewSermonPacketTarget(current, rawItemId) {
  const itemId = prepareId(rawItemId, 'Service item');
  const item = current.project.items[itemId];
  if (!isSermonSourceTarget(current.project, item)) {
    failMainOperation(
      'INVALID_SERMON_SOURCE_ITEM',
      'Choose a sermon cue or sermon outline group before creating a sermon packet.'
    );
  }
  if (
    isPowerPointCompanionProject(current.project)
    && resolveSermonSourceLink(current.project, item)
  ) {
    failMainOperation(
      'CURRENT_SERVICE_SERMON_ALREADY_LINKED',
      'This PowerPoint service already has an exact sermon packet. Review that linked record instead of starting another.'
    );
  }
  return itemId;
}

async function commitNewSermonPacket({
  current,
  itemId,
  metadata,
  sources = [],
  addPrimaryReading = false,
  readingOutputs = null,
  identities = {},
  reason = 'create-sermon-packet'
} = {}) {
  const sermonId = identities.sermonId || projectItemId('sermon');
  const referenceId = identities.referenceId || projectItemId('reference');
  const sermonDocument = {
    schemaVersion: SERMON_SCHEMA_VERSION,
    kind: 'syncshow-sermon',
    id: sermonId,
    titles: { [metadata.defaultLanguage]: metadata.title },
    defaultLanguage: metadata.defaultLanguage,
    speaker: {
      id: null,
      name: metadata.speakerName
    },
    serviceDate: current.project.serviceDate,
    series: null,
    outline: [],
    sources: sources.map(source => ({
      ...source,
      languages: [...source.languages],
      provenance: { ...source.provenance }
    })),
    references: [{
      id: referenceId,
      range: {
        schemaVersion: 1,
        bookId: metadata.bookId,
        start: {
          chapter: metadata.passage.chapter,
          verse: metadata.passage.verseStart
        },
        end: {
          chapter: metadata.passage.chapter,
          verse: metadata.passage.verseEnd
        }
      },
      role: 'primary',
      source: 'operator',
      reviewStatus: 'confirmed',
      enteredText: metadata.primaryReference,
      sourceId: null,
      sectionId: null,
      startOffset: null,
      endOffset: null
    }],
    media: [],
    publication: {
      status: 'draft',
      visibility: 'private',
      publishedAt: null,
      canonicalUrl: null
    }
  };
  const sermonRevision = sermonDocumentSha256(sermonDocument);
  const withResource = addSermonResource(current.project, sermonDocument, {
    provider: 'local-sermon-library',
    itemId: sermonDocument.id,
    revision: sermonRevision
  });
  let preparedProject = setSermonSourceLink(withResource.project, {
    itemId,
    sermonResourceId: withResource.resourceId,
    sermonSectionId: null
  });
  let preparedReading = null;
  if (addPrimaryReading) {
    const denseReadingOutputs = Array.isArray(readingOutputs)
      ? readingOutputs
      : null;
    const effectiveReadingOutputs = denseReadingOutputs
      || preparedProject.channelIds.map(channelId => ({
        channelId,
        mode: 'translation',
        translationId: 'BSB'
      }));
    preparedReading = analyzeSermonPrimaryReading(preparedProject, {
      itemId,
      referenceId: sermonDocument.references[0].id,
      outputs: effectiveReadingOutputs,
      maxVerses: bibleLibrary.maxVerses
    });
    const orderedItemIds = [];
    for (const chunk of preparedReading.chunks) {
      const resolved = await resolvePreparedBibleOutputs({
        reference: chunk.reference,
        outputs: effectiveReadingOutputs
      });
      const readingItemId = identities.readingItemIds?.[chunk.chunkIndex]
        || projectItemId('bible');
      preparedProject = addBibleItem(preparedProject, {
        id: readingItemId,
        title: `${resolved.firstPassage.reference} (${resolved.translationAbbreviations.join(' / ')})`,
        range: chunk.range,
        passagesByChannel: resolved.passagesByChannel,
        presetId: 'scripture-text',
        operatorNotes: `Primary sermon reading · ${preparedReading.reference}`,
        sermonReading: {
          sermonResourceId: withResource.resourceId,
          referenceId: preparedReading.referenceId,
          ...(denseReadingOutputs
            ? {
                outputs: denseReadingOutputs.map(output => ({
                  ...output
                }))
              }
            : { translationId: 'BSB' }),
          chunkIndex: chunk.chunkIndex,
          chunkCount: preparedReading.chunks.length
        },
        parentId: preparedReading.parentId
      });
      orderedItemIds.push(readingItemId);
    }
    preparedProject = placeBibleReadingItemsBefore(preparedProject, {
      itemIds: orderedItemIds,
      anchorItemId: preparedReading.anchorItemId
    });
  }
  const committed = await current.services.sermonProjectCommitCoordinator.commit({
    project: preparedProject,
    expectedProjectRevisionId: current.expectedRevisionId,
    sermonDocument,
    expectedSermonRevision: null,
    resourceId: withResource.resourceId,
    resourceOwnerId: itemId,
    reason
  });
  const result = {
    ...projectResult(committed.project),
    ...(preparedReading
      ? {
          reading: {
            status: 'ready',
            referenceId: preparedReading.referenceId,
            reference: preparedReading.reference,
            ...(Array.isArray(readingOutputs)
              ? {
                  outputs: readingOutputs.map(output => ({
                    ...output
                  }))
                }
              : { translationId: 'BSB' }),
            cueCount: preparedReading.chunks.length
          }
        }
      : {})
  };
  if (committed.recovery?.message && !result.recovery) {
    result.recovery = {
      source: 'sermon-project-transaction',
      message: committed.recovery.message
    };
  }
  return result;
}

function pruneServiceSermonPacketProposals(now = Date.now(), { makeRoom = false } = {}) {
  for (const [token, proposal] of serviceSermonPacketProposals) {
    if (proposal.expiresAt <= now && proposal.applying !== true) {
      serviceSermonPacketProposals.delete(token);
    }
  }
  if (!makeRoom) return true;
  while (serviceSermonPacketProposals.size >= SERVICE_SERMON_PACKET_PROPOSAL_LIMIT) {
    const evictableToken = [...serviceSermonPacketProposals]
      .find(([, proposal]) => proposal.applying !== true)?.[0];
    if (!evictableToken) return false;
    serviceSermonPacketProposals.delete(evictableToken);
  }
  return true;
}

function holdServiceSermonPacketProposal(entry) {
  if (!pruneServiceSermonPacketProposals(Date.now(), { makeRoom: true })) {
    failMainOperation(
      'SERVICE_SERMON_PACKET_PROPOSALS_BUSY',
      'Active sermon-packet reviews are still being applied. Wait for one to finish.'
    );
  }
  const proposalToken = crypto.randomBytes(24).toString('base64url');
  const createdAt = Date.now();
  const expiresAt = createdAt + SERVICE_SERMON_PACKET_PROPOSAL_TTL_MS;
  const held = {
    ...entry,
    createdAt,
    expiresAt,
    applying: false
  };
  serviceSermonPacketProposals.set(proposalToken, held);
  return {
    proposalToken,
    entry: held
  };
}

function requireServiceSermonPacketProposal(rawToken) {
  const proposalToken = prepareText(
    rawToken,
    'Service sermon packet review',
    64,
    { required: true }
  );
  if (!/^[A-Za-z0-9_-]{32}$/.test(proposalToken)) {
    failMainOperation(
      'INVALID_SERVICE_SERMON_PACKET_PROPOSAL',
      'Review the current service files again before creating the sermon packet.'
    );
  }
  pruneServiceSermonPacketProposals();
  const entry = serviceSermonPacketProposals.get(proposalToken);
  if (!entry || (entry.expiresAt <= Date.now() && entry.applying !== true)) {
    if (entry?.applying !== true) serviceSermonPacketProposals.delete(proposalToken);
    failMainOperation(
      'EXPIRED_SERVICE_SERMON_PACKET_PROPOSAL',
      'This sermon-packet review expired. Review the current service files again.'
    );
  }
  if (entry.applying === true) {
    failMainOperation(
      'SERVICE_SERMON_PACKET_APPLY_IN_PROGRESS',
      'This reviewed sermon packet is already being created.'
    );
  }
  return { proposalToken, entry };
}

async function withServiceSermonPacketApplication(proposalToken, entry, operation) {
  entry.applying = true;
  let succeeded = false;
  try {
    const result = await operation();
    succeeded = true;
    return result;
  } finally {
    if (serviceSermonPacketProposals.get(proposalToken) === entry) {
      if (succeeded) serviceSermonPacketProposals.delete(proposalToken);
      else entry.applying = false;
    }
  }
}

async function currentServiceSetForSermonPacket(current) {
  let manifest;
  try {
    manifest = await readCurrentServiceSet(getServiceSetRoot(), {
      verifyAssets: true
    });
  } catch (error) {
    failServiceSermonPacket(error);
  }
  if (!manifest) {
    failMainOperation(
      'NO_CURRENT_SERVICE_SET',
      'Load a verified service set before reviewing its presentations for a sermon packet.'
    );
  }
  if (
    manifest.serviceDate !== current.project.serviceDate
    || manifest.profileId !== (
      current.project.preferredProfileId || current.project.profileId
    )
  ) {
    failMainOperation(
      'SERVICE_SET_PROJECT_MISMATCH',
      'The loaded presentations belong to a different service date or venue profile.'
    );
  }
  if (current.project.sourceServiceSet) {
    let fingerprint;
    try {
      fingerprint = serviceSetFingerprint(manifest);
    } catch (error) {
      failServiceSermonPacket(error);
    }
    if (
      current.project.sourceServiceSet.id !== manifest.id
      || current.project.sourceServiceSet.fingerprint !== fingerprint
    ) {
      failMainOperation(
        'SERVICE_SET_PROJECT_MISMATCH',
        'This service project is already bound to a different reviewed presentation set.'
      );
    }
  }
  return manifest;
}

async function requireLinkedServiceSermonSourceTarget(current, rawItemId) {
  const itemId = prepareId(rawItemId, 'Service item');
  const item = current.project.items[itemId];
  if (!isSermonSourceTarget(current.project, item)) {
    failMainOperation(
      'INVALID_SERMON_SOURCE_ITEM',
      'Choose a linked sermon cue or sermon outline group before reviewing current service files.'
    );
  }
  const linked = resolveSermonSourceLink(current.project, item);
  if (!linked?.resource || linked.resource.kind !== 'sermon') {
    failMainOperation(
      'SERMON_SOURCE_NOT_LINKED',
      'Link one exact sermon packet before reviewing current service files.'
    );
  }
  if (linked.resource.document.publication?.status === 'archived') {
    failMainOperation(
      'ARCHIVED_SERMON',
      'Restore this archived sermon before attaching current-service files.'
    );
  }
  const sermonRead = await current.services.localSermonLibrary.readCurrent(
    linked.resource.document.id
  );
  if (sermonRead.revision !== linked.resource.sha256) {
    failMainOperation(
      'SERMON_CONFLICT',
      'The local sermon changed after this service pinned it. Review and link the intended exact revision before attaching current service files.',
      {
        currentRevisionId: sermonRead.revision,
        expectedRevisionId: linked.resource.sha256
      }
    );
  }
  return {
    itemId,
    linked,
    sermonRead
  };
}

function pruneLinkedServiceSermonSourceProposals(
  now = Date.now(),
  { makeRoom = false } = {}
) {
  for (const [token, proposal] of linkedServiceSermonSourceProposals) {
    if (proposal.expiresAt <= now && proposal.applying !== true) {
      linkedServiceSermonSourceProposals.delete(token);
    }
  }
  if (!makeRoom) return true;
  while (
    linkedServiceSermonSourceProposals.size
      >= LINKED_SERVICE_SERMON_SOURCE_PROPOSAL_LIMIT
  ) {
    const evictableToken = [...linkedServiceSermonSourceProposals]
      .find(([, proposal]) => proposal.applying !== true)?.[0];
    if (!evictableToken) return false;
    linkedServiceSermonSourceProposals.delete(evictableToken);
  }
  return true;
}

function holdLinkedServiceSermonSourceProposal(entry) {
  if (!pruneLinkedServiceSermonSourceProposals(
    Date.now(),
    { makeRoom: true }
  )) {
    failMainOperation(
      'LINKED_SERVICE_SERMON_SOURCE_PROPOSALS_BUSY',
      'Active current-service source reviews are still being applied. Wait for one to finish.'
    );
  }
  const proposalToken = crypto.randomBytes(24).toString('base64url');
  const createdAt = Date.now();
  const expiresAt =
    createdAt + LINKED_SERVICE_SERMON_SOURCE_PROPOSAL_TTL_MS;
  const held = {
    ...entry,
    createdAt,
    expiresAt,
    applying: false
  };
  linkedServiceSermonSourceProposals.set(proposalToken, held);
  return {
    proposalToken,
    entry: held
  };
}

function requireLinkedServiceSermonSourceProposal(rawToken) {
  const proposalToken = prepareText(
    rawToken,
    'Current-service sermon source review',
    64,
    { required: true }
  );
  if (!/^[A-Za-z0-9_-]{32}$/.test(proposalToken)) {
    failMainOperation(
      'INVALID_LINKED_SERVICE_SERMON_SOURCE_PROPOSAL',
      'Review the current service files again before attaching them.'
    );
  }
  pruneLinkedServiceSermonSourceProposals();
  const entry = linkedServiceSermonSourceProposals.get(proposalToken);
  if (!entry || (entry.expiresAt <= Date.now() && entry.applying !== true)) {
    if (entry?.applying !== true) {
      linkedServiceSermonSourceProposals.delete(proposalToken);
    }
    failMainOperation(
      'EXPIRED_LINKED_SERVICE_SERMON_SOURCE_PROPOSAL',
      'This current-service source review expired. Review the files again.'
    );
  }
  if (entry.applying === true) {
    failMainOperation(
      'LINKED_SERVICE_SERMON_SOURCE_APPLY_IN_PROGRESS',
      'These reviewed current-service files are already being attached.'
    );
  }
  return { proposalToken, entry };
}

async function withLinkedServiceSermonSourceApplication(
  proposalToken,
  entry,
  operation
) {
  entry.applying = true;
  let succeeded = false;
  try {
    const result = await operation();
    succeeded = true;
    return result;
  } finally {
    if (linkedServiceSermonSourceProposals.get(proposalToken) === entry) {
      if (succeeded) {
        linkedServiceSermonSourceProposals.delete(proposalToken);
      } else {
        entry.applying = false;
      }
    }
  }
}

function failSermonSourceExtraction(error) {
  const messages = {
    EMPTY_SOURCE: 'The attached sermon source is empty.',
    SOURCE_TOO_LARGE: 'The attached sermon source is too large to review safely.',
    UNSUPPORTED_SOURCE_TYPE: 'Only PDF, DOCX, PPTX, TXT, and Markdown sermon sources can be reviewed.',
    SOURCE_TYPE_MISMATCH: 'The attached sermon source no longer matches its recorded file type.',
    CORRUPT_SOURCE: 'The attached sermon source is incomplete or damaged.',
    INVALID_UTF8: 'The attached text source is not valid UTF-8.',
    UNSAFE_XML: 'The attached Office document contains XML that cannot be reviewed safely.',
    SOURCE_HASH_MISMATCH: 'The private sermon source failed its integrity check.',
    SOURCE_SIZE_MISMATCH: 'The private sermon source size no longer matches its record.',
    OBJECT_NOT_FOUND: 'This attached source is not available on this computer.',
    OBJECT_CORRUPT: 'This attached source failed its integrity check on this computer.',
    INVALID_SOURCE_METADATA: 'The sermon source record is invalid.',
    LOCAL_PATH_NOT_ALLOWED: 'Sermon extraction metadata cannot contain a local path.',
    STORE_UNAVAILABLE: 'Private sermon extraction evidence is not available on this computer.',
    WRITE_LOCKED: 'Another private sermon extraction update is still finishing. Try again in a moment.',
    SNAPSHOT_TOO_LARGE: 'The extracted sermon evidence is too large to save safely.',
    SNAPSHOT_NOT_FOUND: 'Saved sermon extraction evidence is incomplete on this computer.',
    SNAPSHOT_CORRUPT: 'Saved sermon extraction evidence failed its integrity check.',
    BINDING_INDEX_CORRUPT: 'The saved sermon extraction index failed its integrity check.',
    BINDING_CONFLICT: 'This exact source and extractor produced different evidence. SyncShow preserved the earlier snapshot for review.',
    SNAPSHOT_CAPACITY_REACHED: 'This computer has reached its private sermon extraction evidence limit.',
    REVIEW_INDEX_CORRUPT: 'The saved sermon extraction review index failed its integrity check.',
    REVIEW_EVIDENCE_CORRUPT: 'Saved reviewed extraction evidence could not be validated.',
    REVIEW_RECEIPT_CORRUPT: 'A saved sermon extraction review receipt failed its integrity check.',
    REVIEW_RECEIPT_CAPACITY_REACHED: 'This computer has reached its private sermon extraction review-receipt limit.',
    REVIEW_RECEIPT_SNAPSHOT_CAPACITY_REACHED: 'This sermon extraction has reached its private saved-review limit.',
    REVIEW_INDEX_CAPACITY_REACHED: 'This exact sermon extraction review has reached its saved-receipt limit.',
    REVIEW_STATUS_CAPACITY_EXCEEDED: 'This sermon extraction has too many saved review receipts to inspect safely.',
    EXTRACTION_QUEUE_FULL: 'Several sermon source reviews are already pending. Try again in a moment.'
  };
  failMainOperation(
    'SERMON_SOURCE_EXTRACTION_FAILED',
    messages[error?.code] || 'Suggestions could not be extracted from that sermon source.',
    { cause: typeof error?.code === 'string' ? error.code : 'UNKNOWN' }
  );
}

function publicSermonExtractionSavedReview(snapshotStatus, receipt = null) {
  if (!['saved', 'reused'].includes(snapshotStatus)) {
    const error = new Error('The private extraction snapshot status is invalid.');
    error.code = 'INVALID_EXTRACTION_SNAPSHOT';
    throw error;
  }
  if (receipt === null) {
    return {
      snapshotStatus,
      reviewStatus: 'unreviewed',
      reviewedAt: null,
      outlineSelectionCount: 0,
      referenceSelectionCount: 0
    };
  }
  const reviewedAt = receipt?.reviewedAt;
  const outlineSuggestionIds = receipt?.outlineSuggestionIds;
  const referenceSuggestionIds = receipt?.referenceSuggestionIds;
  if (
    !receipt
    || typeof receipt !== 'object'
    || Array.isArray(receipt)
    || typeof reviewedAt !== 'string'
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(reviewedAt)
    || !Number.isFinite(Date.parse(reviewedAt))
    || new Date(reviewedAt).toISOString() !== reviewedAt
    || !Array.isArray(outlineSuggestionIds)
    || outlineSuggestionIds.length > 500
    || !Array.isArray(referenceSuggestionIds)
    || referenceSuggestionIds.length > 500
    || outlineSuggestionIds.length + referenceSuggestionIds.length < 1
  ) {
    const error = new Error('The private extraction review receipt is invalid.');
    error.code = 'INVALID_EXTRACTION_REVIEW_RECEIPT';
    throw error;
  }
  return {
    snapshotStatus,
    reviewStatus: 'reviewed',
    reviewedAt,
    outlineSelectionCount: outlineSuggestionIds.length,
    referenceSelectionCount: referenceSuggestionIds.length
  };
}

function pruneSermonExtractionProposals(now = Date.now()) {
  for (const [token, proposal] of sermonExtractionProposals) {
    if (proposal.expiresAt <= now && proposal.applying !== true) {
      sermonExtractionProposals.delete(token);
    }
  }
  while (sermonExtractionProposals.size >= SERMON_EXTRACTION_PROPOSAL_LIMIT) {
    const evictableToken = [...sermonExtractionProposals]
      .find(([, proposal]) => proposal.applying !== true)?.[0];
    if (!evictableToken) return false;
    sermonExtractionProposals.delete(evictableToken);
  }
  return true;
}

function holdSermonExtractionProposal(entry) {
  const now = Date.now();
  if (!pruneSermonExtractionProposals(now)) {
    failMainOperation(
      'SERMON_EXTRACTION_PROPOSALS_BUSY',
      'Active sermon source reviews are still being applied. Try again when one finishes.'
    );
  }
  const proposalToken = crypto.randomBytes(24).toString('base64url');
  const expiresAt = now + SERMON_EXTRACTION_PROPOSAL_TTL_MS;
  sermonExtractionProposals.set(proposalToken, {
    ...entry,
    applying: false,
    expiresAt
  });
  return {
    ...entry.publicProposal,
    proposalToken,
    expiresAt: new Date(expiresAt).toISOString()
  };
}

function requireSermonExtractionProposal(rawToken) {
  const proposalToken = prepareText(
    rawToken,
    'Sermon extraction proposal',
    64,
    { required: true }
  );
  if (!/^[A-Za-z0-9_-]{32}$/.test(proposalToken)) {
    failMainOperation(
      'INVALID_SERMON_EXTRACTION_PROPOSAL',
      'Extract this sermon source again before applying suggestions.'
    );
  }
  const entry = sermonExtractionProposals.get(proposalToken);
  if (!entry || (entry.expiresAt <= Date.now() && entry.applying !== true)) {
    if (entry?.applying !== true) sermonExtractionProposals.delete(proposalToken);
    failMainOperation(
      'EXPIRED_SERMON_EXTRACTION_PROPOSAL',
      'This suggestion review expired. Extract the sermon source again.'
    );
  }
  return { proposalToken, entry };
}

function withSermonExtractionProposalApplication(proposalToken, entry, operation) {
  if (entry.applying === true) {
    failMainOperation(
      'SERMON_EXTRACTION_APPLY_IN_PROGRESS',
      'This sermon source review is already being applied.'
    );
  }
  entry.applying = true;
  return Promise.resolve()
    .then(operation)
    .finally(() => {
      if (sermonExtractionProposals.get(proposalToken) === entry) {
        entry.applying = false;
      }
    });
}

function pruneSermonCueReconciliationProposals(
  now = Date.now(),
  { makeRoom = false } = {}
) {
  for (const [token, proposal] of sermonCueReconciliationProposals) {
    if (proposal.expiresAt <= now && proposal.applying !== true) {
      sermonCueReconciliationProposals.delete(token);
    }
  }
  if (!makeRoom) return true;
  while (
    sermonCueReconciliationProposals.size
    >= SERMON_CUE_RECONCILIATION_PROPOSAL_LIMIT
  ) {
    const evictableToken = [...sermonCueReconciliationProposals]
      .find(([, proposal]) => proposal.applying !== true)?.[0];
    if (!evictableToken) return false;
    sermonCueReconciliationProposals.delete(evictableToken);
  }
  return true;
}

function holdSermonCueReconciliationProposal(entry) {
  const now = Date.now();
  if (!pruneSermonCueReconciliationProposals(now, { makeRoom: true })) {
    failMainOperation(
      'SERMON_CUE_RECONCILIATION_BUSY',
      'Active sermon-slide reviews are still being applied. Wait for one to finish.'
    );
  }
  const proposalToken = crypto.randomBytes(24).toString('base64url');
  const expiresAt = now + SERMON_CUE_RECONCILIATION_PROPOSAL_TTL_MS;
  const held = {
    ...entry,
    applying: false,
    expiresAt
  };
  sermonCueReconciliationProposals.set(proposalToken, held);
  return {
    proposalToken,
    expiresAt: new Date(expiresAt).toISOString(),
    proposal: held.proposal
  };
}

function requireSermonCueReconciliationProposal(rawToken) {
  const proposalToken = prepareText(
    rawToken,
    'Sermon slide review',
    64,
    { required: true }
  );
  if (!/^[A-Za-z0-9_-]{32}$/.test(proposalToken)) {
    failMainOperation(
      'INVALID_SERMON_CUE_RECONCILIATION_PROPOSAL',
      'Review the sermon slide sources again before applying reviewed decisions.'
    );
  }
  pruneSermonCueReconciliationProposals();
  const entry = sermonCueReconciliationProposals.get(proposalToken);
  if (!entry || (entry.expiresAt <= Date.now() && entry.applying !== true)) {
    if (entry?.applying !== true) {
      sermonCueReconciliationProposals.delete(proposalToken);
    }
    failMainOperation(
      'EXPIRED_SERMON_CUE_RECONCILIATION_PROPOSAL',
      'This sermon-slide review expired. Review the source mappings again.'
    );
  }
  if (entry.applying === true) {
    failMainOperation(
      'SERMON_CUE_RECONCILIATION_APPLY_IN_PROGRESS',
      'This sermon-slide review is already being applied.'
    );
  }
  return { proposalToken, entry };
}

async function withSermonCueReconciliationApplication(
  proposalToken,
  entry,
  applyIntentHash,
  operation
) {
  if (entry.completedResult) {
    if (entry.applyIntentHash !== applyIntentHash) {
      failMainOperation(
        'SERMON_CUE_RECONCILIATION_REPLAY_MISMATCH',
        'This sermon-slide review was already applied with different decisions.'
      );
    }
    return entry.completedResult;
  }
  entry.applying = true;
  try {
    const result = await operation();
    entry.applyIntentHash = applyIntentHash;
    entry.completedResult = result;
    return result;
  } finally {
    if (sermonCueReconciliationProposals.get(proposalToken) === entry) {
      entry.applying = false;
    }
  }
}

function sermonCueReconciliationApplyIntentHash(request) {
  return crypto.createHash('sha256').update(JSON.stringify({
    projectId: request.projectId,
    expectedRevisionId: request.expectedRevisionId,
    itemId: request.itemId,
    sermonId: request.sermonId,
    sermonRevisionId: request.sermonRevisionId,
    decisions: request.decisions,
    placementIndex: request.placementIndex,
    confirmed: request.confirmed
  })).digest('hex');
}

function pruneCanonicalSermonBodyProjectionProposals(
  now = Date.now(),
  { makeRoom = false } = {}
) {
  for (const [token, proposal] of canonicalSermonBodyProjectionProposals) {
    if (proposal.expiresAt <= now && proposal.applying !== true) {
      canonicalSermonBodyProjectionProposals.delete(token);
    }
  }
  if (!makeRoom) return true;
  while (
    canonicalSermonBodyProjectionProposals.size
    >= CANONICAL_SERMON_BODY_PROJECTION_PROPOSAL_LIMIT
  ) {
    const evictableToken = [...canonicalSermonBodyProjectionProposals]
      .find(([, proposal]) => proposal.applying !== true)?.[0];
    if (!evictableToken) return false;
    canonicalSermonBodyProjectionProposals.delete(evictableToken);
  }
  return true;
}

function holdCanonicalSermonBodyProjectionProposal(proposal) {
  const now = Date.now();
  if (!pruneCanonicalSermonBodyProjectionProposals(now, { makeRoom: true })) {
    failMainOperation(
      'CANONICAL_SERMON_BODY_PROJECTION_BUSY',
      'Active sermon-text reviews are still being applied. Wait for one to finish.'
    );
  }
  const proposalToken = crypto.randomBytes(24).toString('base64url');
  const expiresAt =
    now + CANONICAL_SERMON_BODY_PROJECTION_PROPOSAL_TTL_MS;
  canonicalSermonBodyProjectionProposals.set(proposalToken, {
    proposal,
    applying: false,
    expiresAt,
    completedResult: null,
    applyIntentHash: null
  });
  return {
    proposalToken,
    expiresAt: new Date(expiresAt).toISOString(),
    proposal
  };
}

function requireCanonicalSermonBodyProjectionProposal(rawToken) {
  const proposalToken = prepareText(
    rawToken,
    'Canonical sermon-text review',
    64,
    { required: true }
  );
  if (!/^[A-Za-z0-9_-]{32}$/.test(proposalToken)) {
    failMainOperation(
      'INVALID_CANONICAL_SERMON_BODY_PROJECTION_PROPOSAL',
      'Review the canonical sermon text again before applying decisions.'
    );
  }
  pruneCanonicalSermonBodyProjectionProposals();
  const entry = canonicalSermonBodyProjectionProposals.get(proposalToken);
  if (!entry || (entry.expiresAt <= Date.now() && entry.applying !== true)) {
    if (entry?.applying !== true) {
      canonicalSermonBodyProjectionProposals.delete(proposalToken);
    }
    failMainOperation(
      'EXPIRED_CANONICAL_SERMON_BODY_PROJECTION_PROPOSAL',
      'This canonical sermon-text review expired. Review the mappings again.'
    );
  }
  if (entry.applying === true) {
    failMainOperation(
      'CANONICAL_SERMON_BODY_PROJECTION_APPLY_IN_PROGRESS',
      'This canonical sermon-text review is already being applied.'
    );
  }
  return { proposalToken, entry };
}

async function withCanonicalSermonBodyProjectionApplication(
  proposalToken,
  entry,
  applyIntentHash,
  operation
) {
  if (entry.completedResult) {
    if (entry.applyIntentHash !== applyIntentHash) {
      failMainOperation(
        'CANONICAL_SERMON_BODY_PROJECTION_REPLAY_MISMATCH',
        'This canonical sermon-text review was already applied with different decisions.'
      );
    }
    return entry.completedResult;
  }
  entry.applying = true;
  try {
    const result = await operation();
    entry.applyIntentHash = applyIntentHash;
    entry.completedResult = result;
    return result;
  } finally {
    if (canonicalSermonBodyProjectionProposals.get(proposalToken) === entry) {
      entry.applying = false;
    }
  }
}

function canonicalSermonBodyProjectionApplyIntentHash(request) {
  return crypto.createHash('sha256').update(JSON.stringify({
    projectId: request.projectId,
    expectedRevisionId: request.expectedRevisionId,
    itemId: request.itemId,
    sermonId: request.sermonId,
    sermonRevisionId: request.sermonRevisionId,
    decisions: request.decisions,
    placementIndex: request.placementIndex,
    confirmed: request.confirmed
  })).digest('hex');
}

function prepareCanonicalSermonBodyProjectionDecisions(raw, proposal) {
  const failDecision = message => failMainOperation(
    'INVALID_CANONICAL_SERMON_BODY_PROJECTION_DECISIONS',
    message
  );
  const requireRecord = (value, label) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      failDecision(`${label} must be an object.`);
    }
    return value;
  };
  const requireFields = (value, required, allowed, label) => {
    requireRecord(value, label);
    requireExactPrepareKeys(value, allowed, label);
    if (required.some(key =>
      !Object.prototype.hasOwnProperty.call(value, key))) {
      failDecision(`${label} is incomplete.`);
    }
  };
  const channelIds = proposal.channelMappings.map(mapping => mapping.channelId);
  const channelIdSet = new Set(channelIds);
  const requireChannelMap = (value, label) => {
    requireRecord(value, label);
    const keys = Object.keys(value);
    if (
      keys.length !== channelIds.length
      || keys.some(channelId => !channelIdSet.has(channelId))
    ) {
      failDecision(`${label} must decide every reviewed output exactly once.`);
    }
    return value;
  };

  requireFields(
    raw,
    ['rows', 'skippedParagraphIdsByChannel'],
    ['rows', 'skippedParagraphIdsByChannel'],
    'Canonical sermon body decisions'
  );
  if (!Array.isArray(raw.rows) || raw.rows.length > 512) {
    failDecision('Canonical sermon body decisions may contain at most 512 rows.');
  }
  requireChannelMap(
    raw.skippedParagraphIdsByChannel,
    'Explicit skipped canonical paragraphs'
  );

  const bodyEntryById = new Map(
    proposal.bodyEntries.map(entry => [entry.id, entry])
  );
  const mappingByChannel = new Map(
    proposal.channelMappings.map(mapping => [mapping.channelId, mapping])
  );
  const paragraphIdsByChannel = new Map();
  const accountedParagraphIdsByChannel = new Map();
  for (const channelId of channelIds) {
    const mapping = mappingByChannel.get(channelId);
    const entry = mapping.mode === 'hidden'
      ? null
      : bodyEntryById.get(mapping.bodyEntryId);
    if (mapping.mode !== 'hidden' && !entry) {
      failDecision('A reviewed canonical body entry is no longer available.');
    }
    paragraphIdsByChannel.set(
      channelId,
      new Set((entry?.paragraphs || []).map(paragraph => paragraph.id))
    );
    accountedParagraphIdsByChannel.set(channelId, new Set());
  }

  const existingTargetIds = new Set(
    proposal.existingTargets.map(target => target.itemId)
  );
  const seenRowIds = new Set();
  const seenTargetIds = new Set();
  const rows = raw.rows.map((rawRow, index) => {
    const label = `Canonical sermon body row ${index + 1}`;
    requireRecord(rawRow, label);
    const hasLegacy = Object.prototype.hasOwnProperty.call(
      rawRow,
      'paragraphIdsByChannel'
    );
    const hasTreatments = Object.prototype.hasOwnProperty.call(
      rawRow,
      'treatmentsByChannel'
    );
    if (hasLegacy === hasTreatments) {
      failDecision(
        `${label} must use exactly one supported output-decision shape.`
      );
    }
    const decisionKey = hasTreatments
      ? 'treatmentsByChannel'
      : 'paragraphIdsByChannel';
    requireFields(
      rawRow,
      ['rowId', 'action', decisionKey],
      ['rowId', 'action', 'targetItemId', decisionKey],
      label
    );
    const rowId = prepareId(rawRow.rowId, `${label} id`);
    if (seenRowIds.has(rowId)) {
      failDecision('Each canonical sermon body row id must be unique.');
    }
    seenRowIds.add(rowId);
    if (!['insert', 'update'].includes(rawRow.action)) {
      failDecision(`${label} must explicitly Insert or Update.`);
    }
    const targetItemId = rawRow.targetItemId === undefined
      || rawRow.targetItemId === null
      ? null
      : prepareId(rawRow.targetItemId, `${label} target`);
    if (rawRow.action === 'update') {
      if (
        !targetItemId
        || !existingTargetIds.has(targetItemId)
        || seenTargetIds.has(targetItemId)
      ) {
        failDecision(
          `${label} must select one unused reviewed existing cue.`
        );
      }
      seenTargetIds.add(targetItemId);
    } else if (targetItemId !== null) {
      failDecision('Only an Update row may select an existing cue.');
    }

    const rawByChannel = requireChannelMap(rawRow[decisionKey], `${label} outputs`);
    let visibleCount = 0;
    if (hasLegacy) {
      const paragraphIds = {};
      for (const channelId of channelIds) {
        const mapping = mappingByChannel.get(channelId);
        const rawParagraphId = rawByChannel[channelId];
        if (rawParagraphId === null) {
          paragraphIds[channelId] = null;
          continue;
        }
        if (mapping.mode === 'hidden') {
          failDecision('A Hidden output cannot select canonical text.');
        }
        const paragraphId = prepareSermonDomainId(
          rawParagraphId,
          `${label} ${channelId} paragraph`
        );
        if (!paragraphIdsByChannel.get(channelId).has(paragraphId)) {
          failDecision(
            `${label} selected a paragraph outside the reviewed body entry.`
          );
        }
        if (
          accountedParagraphIdsByChannel.get(channelId).has(paragraphId)
        ) {
          failDecision(
            'One canonical paragraph cannot be used more than once per output.'
          );
        }
        accountedParagraphIdsByChannel.get(channelId).add(paragraphId);
        paragraphIds[channelId] = paragraphId;
        visibleCount += 1;
      }
      if (visibleCount < 1) {
        failDecision(`${label} must show text on at least one output.`);
      }
      return {
        rowId,
        action: rawRow.action,
        targetItemId,
        paragraphIdsByChannel: paragraphIds
      };
    }

    const treatmentsByChannel = {};
    for (const channelId of channelIds) {
      const mapping = mappingByChannel.get(channelId);
      const rawTreatment = rawByChannel[channelId];
      requireRecord(rawTreatment, `${label} ${channelId} treatment`);
      if (rawTreatment.mode === 'hidden') {
        requireFields(
          rawTreatment,
          ['mode'],
          ['mode'],
          `${label} ${channelId} Hidden treatment`
        );
        treatmentsByChannel[channelId] = { mode: 'hidden' };
        continue;
      }
      if (!['exact', 'condensed'].includes(rawTreatment.mode)) {
        failDecision(
          `${label} ${channelId} must choose Exact, Condensed, or Hidden.`
        );
      }
      if (mapping.mode === 'hidden') {
        failDecision('A Hidden output cannot select canonical text.');
      }
      const expectedFields = rawTreatment.mode === 'condensed'
        ? ['mode', 'paragraphId', 'text']
        : ['mode', 'paragraphId'];
      requireFields(
        rawTreatment,
        expectedFields,
        expectedFields,
        `${label} ${channelId} ${rawTreatment.mode} treatment`
      );
      const paragraphId = prepareSermonDomainId(
        rawTreatment.paragraphId,
        `${label} ${channelId} source paragraph`
      );
      if (!paragraphIdsByChannel.get(channelId).has(paragraphId)) {
        failDecision(
          `${label} selected a paragraph outside the reviewed body entry.`
        );
      }
      if (accountedParagraphIdsByChannel.get(channelId).has(paragraphId)) {
        failDecision(
          'One canonical paragraph cannot be used more than once per output.'
        );
      }
      accountedParagraphIdsByChannel.get(channelId).add(paragraphId);
      if (rawTreatment.mode === 'condensed') {
        treatmentsByChannel[channelId] = {
          mode: 'condensed',
          paragraphId,
          text: prepareProjectedBodyText(
            rawTreatment.text,
            `${label} ${channelId} Condensed service text`,
            20_000,
            { required: true }
          )
        };
      } else {
        treatmentsByChannel[channelId] = { mode: 'exact', paragraphId };
      }
      visibleCount += 1;
    }
    if (visibleCount < 1) {
      failDecision(`${label} must show text on at least one output.`);
    }
    return {
      rowId,
      action: rawRow.action,
      targetItemId,
      treatmentsByChannel
    };
  });

  const skippedParagraphIdsByChannel = {};
  for (const channelId of channelIds) {
    const rawIds = raw.skippedParagraphIdsByChannel[channelId];
    if (!Array.isArray(rawIds) || rawIds.length > 256) {
      failDecision(
        `Skipped canonical paragraphs for ${channelId} must be a bounded array.`
      );
    }
    const skipped = [];
    const seenSkippedIds = new Set();
    for (const [index, rawParagraphId] of rawIds.entries()) {
      const paragraphId = prepareSermonDomainId(
        rawParagraphId,
        `${channelId} skipped paragraph ${index + 1}`
      );
      if (
        !paragraphIdsByChannel.get(channelId).has(paragraphId)
        || seenSkippedIds.has(paragraphId)
        || accountedParagraphIdsByChannel.get(channelId).has(paragraphId)
      ) {
        failDecision(
          'Each reviewed canonical paragraph must be used or skipped exactly once.'
        );
      }
      seenSkippedIds.add(paragraphId);
      accountedParagraphIdsByChannel.get(channelId).add(paragraphId);
      skipped.push(paragraphId);
    }
    if (
      accountedParagraphIdsByChannel.get(channelId).size
      !== paragraphIdsByChannel.get(channelId).size
    ) {
      failDecision(
        'Every reviewed canonical paragraph must be used or explicitly skipped.'
      );
    }
    skippedParagraphIdsByChannel[channelId] = skipped;
  }
  return { rows, skippedParagraphIdsByChannel };
}

function failCanonicalSermonBodyProjection(error) {
  const messages = {
    CANONICAL_BODY_REQUIRED:
      'This exact sermon revision does not contain reviewed canonical text.',
    EXPLICIT_CHANNEL_MAPPING_REQUIRED:
      'Choose one exact sermon body entry or Hidden for every output.',
    VISIBLE_BODY_ENTRY_REQUIRED:
      'At least one output must use one exact canonical sermon body entry.',
    MISSING_PARAGRAPH_DECISION:
      'Every paragraph for every mapped output must be placed once or explicitly skipped.',
    CONFIRMATION_REQUIRED:
      'Confirm the complete canonical sermon-text review before applying it.',
    PROJECT_REVISION_MISMATCH:
      'The service changed after review. Review the canonical sermon text again.',
    PROPOSAL_BINDING_MISMATCH:
      'The selected sermon, body text, outputs, or group order changed after review.'
  };
  failMainOperation(
    error?.code || 'CANONICAL_SERMON_BODY_PROJECTION_FAILED',
    messages[error?.code]
      || 'The canonical sermon text could not be projected safely.',
    error?.details || {}
  );
}

function failSermonCueReconciliation(error) {
  const messages = {
    CONFIRMATION_REQUIRED:
      'Confirm every sermon-slide decision before applying it.',
    POWERPOINT_COMPANION_UNSUPPORTED:
      'PowerPoint companion services keep their original sermon slides.',
    INVALID_SERMON_ANCHOR:
      'Choose a linked sermon outline group before building sermon slides.',
    SECTION_PINNED_SERMON_ANCHOR:
      'The sermon resource owner must represent the whole sermon before building slides in its outline groups.',
    SERMON_TREE_TOO_LARGE:
      'This selected group has too many direct children for one safe reconciliation review.',
    SERMON_WINDOW_REQUIRED:
      'The PowerPoint source does not contain one complete supported sermon-slide window.',
    INCOMPLETE_EXTRACTION:
      'The PowerPoint source was only partially extracted and cannot be reconciled safely.',
    UNSUPPORTED_SOURCE:
      'Choose a reviewed PowerPoint slide-notes source.',
    EMPTY_INSERT:
      'Every reviewed Insert or Update row needs at least one visible exact source unit.',
    EMPTY_UPDATE:
      'An updated sermon cue must retain or select at least one visible output.',
    PLACEMENT_REQUIRED:
      'Choose where the reviewed sermon-slide block belongs among the selected group’s direct children.',
    INVALID_PLACEMENT:
      'The reviewed sermon-slide placement is invalid.',
    UNKNOWN_EXISTING_TARGET:
      'One selected existing sermon cue is no longer eligible for update.',
    EXISTING_TARGET_REUSED:
      'One existing sermon cue cannot be updated from more than one reviewed row.',
    PROJECT_REVISION_MISMATCH:
      'This service changed after the sermon-slide review. Review the newest revision.',
    SERMON_BINDING_MISMATCH:
      'The linked sermon changed after review. Review its exact revision again.',
    SNAPSHOT_HASH_MISMATCH:
      'A reviewed slide-note source changed after review. Review the source mappings again.',
    SNAPSHOT_BINDING_MISMATCH:
      'A reviewed slide-note source no longer matches this sermon. Review the source mappings again.',
    PROPOSAL_BINDING_MISMATCH:
      'This sermon-slide proposal no longer matches the exact reviewed service.',
    SOURCE_UNIT_TEXT_MISMATCH:
      'One reviewed sermon-slide row changed. Review every row again.',
    UNKNOWN_SOURCE_UNIT:
      'One reviewed sermon-slide row is no longer available.',
    UNKNOWN_OUTLINE_SECTION:
      'One selected sermon outline section is no longer available.',
    MISSING_ROW_DECISION:
      'Choose Insert, Update, or Skip for every proposed sermon-slide row.',
    DUPLICATE_ROW_DECISION:
      'Each proposed sermon-slide row can be decided only once.',
    INVALID_DECISIONS:
      'The reviewed sermon-slide decisions are invalid.',
    INVALID_SOURCE_MAPPING:
      'Map each output explicitly to one reviewed slide-note source.',
    DUPLICATE_CHANNEL_MAPPING:
      'Each output can be mapped only once.',
    UNKNOWN_CHANNEL:
      'One mapped service output is no longer available.',
    UNKNOWN_SERMON_SOURCE:
      'One mapped sermon source is no longer available.',
    PROPOSAL_TOO_LARGE:
      'The sermon-slide proposal exceeds the safe review limit.',
    PROJECT_MUTATION_FAILED:
      'The reviewed sermon slides could not be added to this service safely.'
  };
  const candidateCode = error?.name === 'SermonCueReconciliationError'
    && typeof error?.code === 'string'
    ? error.code
    : '';
  const code = Object.prototype.hasOwnProperty.call(messages, candidateCode)
    ? candidateCode
    : 'SERMON_CUE_RECONCILIATION_FAILED';
  failMainOperation(
    code,
    messages[code] || 'The reviewed sermon slides could not be reconciled safely.'
  );
}

function failSermonBodyReview(error) {
  const messages = {
    ARCHIVED_SERMON: 'Archived sermons cannot accept reviewed body text.',
    UNSUPPORTED_BODY_SOURCE_KIND:
      'Choose a complete manuscript or transcript source for the reviewed sermon body.',
    PARTIAL_EXTRACTION_SCOPE:
      'Only a whole-source extraction can seed the reviewed sermon body.',
    INCOMPLETE_EXTRACTION:
      'The complete source text could not be extracted safely. Keep the source attached and review it manually.',
    EMPTY_EXTRACTION: 'The attached source has no sermon body text to review.',
    AMBIGUOUS_EXISTING_BODY_SOURCE:
      'This source already has multiple body entries and cannot be replaced automatically.',
    BODY_SOURCE_KIND_MISMATCH:
      'The reviewed body kind must match its attached manuscript or transcript source.',
    BODY_ENTRY_TOO_LARGE:
      'The reviewed sermon body entry is too large to save safely.',
    BODY_TOO_LARGE:
      'The reviewed sermon body is too large to save safely.',
    SERMON_SOURCE_TOO_LARGE:
      'The reviewed sermon body would make the canonical sermon record too large to save safely.',
    BODY_ID_CAPACITY_REACHED:
      'This sermon has no safe identity available for another reviewed body entry.',
    INVALID_BODY_REVIEW_EDITS:
      'The reviewed sermon body edit is invalid.',
    INVALID_BODY_TEXT: 'The reviewed sermon body text is invalid.',
    MISSING_BODY_TEXT: 'The reviewed sermon body text is required.',
    UNSAFE_BODY_TEXT: 'The reviewed sermon body text contains unsupported control characters.',
    INVALID_LANGUAGE: 'The reviewed sermon body language is invalid.',
    SERMON_REVISION_MISMATCH:
      'The sermon changed after this body review began. Review the source again.',
    SOURCE_REVISION_MISMATCH:
      'The attached source changed after this body review began. Review it again.',
    SOURCE_MISMATCH:
      'The saved extraction no longer matches this attached sermon source.',
    INVALID_EXTRACTION_PROPOSAL:
      'The saved source extraction is not safe for sermon body review.',
    EXTRACTION_PROPOSAL_TOO_LARGE:
      'The saved source extraction is too large for sermon body review.',
    EMPTY_SOURCE: 'The attached sermon source is empty.',
    SOURCE_TOO_LARGE: 'The attached sermon source is too large to review safely.',
    UNSUPPORTED_SOURCE_TYPE:
      'Only supported sermon manuscript or transcript files can be reviewed.',
    SOURCE_TYPE_MISMATCH:
      'The attached sermon source no longer matches its recorded file type.',
    CORRUPT_SOURCE: 'The attached sermon source is incomplete or damaged.',
    INVALID_UTF8: 'The attached text source is not valid UTF-8.',
    UNSAFE_XML: 'The attached Office document contains XML that cannot be reviewed safely.',
    SOURCE_HASH_MISMATCH: 'The private sermon source failed its integrity check.',
    SOURCE_SIZE_MISMATCH:
      'The private sermon source size no longer matches its record.',
    OBJECT_NOT_FOUND: 'This attached source is not available on this computer.',
    OBJECT_CORRUPT:
      'This attached source failed its integrity check on this computer.',
    INVALID_SOURCE_METADATA: 'The sermon source record is invalid.',
    LOCAL_PATH_NOT_ALLOWED: 'Sermon body review metadata cannot contain a local path.',
    STORE_UNAVAILABLE:
      'Private sermon extraction evidence is not available on this computer.',
    WRITE_LOCKED:
      'Another private sermon extraction update is still finishing. Try again in a moment.',
    SNAPSHOT_TOO_LARGE: 'The extracted sermon evidence is too large to save safely.',
    SNAPSHOT_NOT_FOUND:
      'Saved sermon extraction evidence is incomplete on this computer.',
    SNAPSHOT_CORRUPT: 'Saved sermon extraction evidence failed its integrity check.',
    BINDING_INDEX_CORRUPT:
      'The saved sermon extraction index failed its integrity check.',
    BINDING_CONFLICT:
      'This exact source produced different saved extraction evidence and requires review.',
    SNAPSHOT_CAPACITY_REACHED:
      'This computer has reached its private sermon extraction evidence limit.',
    EXTRACTION_QUEUE_FULL:
      'Several sermon source reviews are already pending. Try again in a moment.'
  };
  failMainOperation(
    'SERMON_BODY_REVIEW_FAILED',
    messages[error?.code]
      || 'The attached source could not be prepared for sermon body review.',
    { cause: typeof error?.code === 'string' ? error.code : 'UNKNOWN' }
  );
}

function pruneSermonBodyReviewProposals(
  now = Date.now(),
  { makeRoom = false } = {}
) {
  for (const [token, proposal] of sermonBodyReviewProposals) {
    if (proposal.expiresAt <= now && proposal.applying !== true) {
      sermonBodyReviewProposals.delete(token);
    }
  }
  if (!makeRoom) return true;
  while (
    sermonBodyReviewProposals.size
    >= SERMON_BODY_REVIEW_PROPOSAL_LIMIT
  ) {
    const evictableToken = [...sermonBodyReviewProposals]
      .find(([, proposal]) => proposal.applying !== true)?.[0];
    if (!evictableToken) return false;
    sermonBodyReviewProposals.delete(evictableToken);
  }
  return true;
}

function holdSermonBodyReviewProposal(entry, publicProposal) {
  const now = Date.now();
  if (!pruneSermonBodyReviewProposals(now, { makeRoom: true })) {
    failMainOperation(
      'SERMON_BODY_REVIEW_PROPOSALS_BUSY',
      'Active sermon body reviews are still being saved. Try again when one finishes.'
    );
  }
  const proposalToken = crypto.randomBytes(24).toString('base64url');
  const expiresAt = now + SERMON_BODY_REVIEW_PROPOSAL_TTL_MS;
  sermonBodyReviewProposals.set(proposalToken, {
    ...entry,
    applying: false,
    expiresAt
  });
  return {
    proposalToken,
    expiresAt: new Date(expiresAt).toISOString(),
    ...publicProposal
  };
}

function requireSermonBodyReviewProposal(rawToken) {
  const proposalToken = prepareText(
    rawToken,
    'Sermon body review proposal',
    64,
    { required: true }
  );
  if (!/^[A-Za-z0-9_-]{32}$/.test(proposalToken)) {
    failMainOperation(
      'INVALID_SERMON_BODY_REVIEW_PROPOSAL',
      'Review this sermon source again before saving its body text.'
    );
  }
  pruneSermonBodyReviewProposals();
  const entry = sermonBodyReviewProposals.get(proposalToken);
  if (!entry || (entry.expiresAt <= Date.now() && entry.applying !== true)) {
    if (entry?.applying !== true) sermonBodyReviewProposals.delete(proposalToken);
    failMainOperation(
      'EXPIRED_SERMON_BODY_REVIEW_PROPOSAL',
      'This sermon body review expired. Review the source again.'
    );
  }
  if (entry.applying === true) {
    failMainOperation(
      'SERMON_BODY_REVIEW_APPLY_IN_PROGRESS',
      'This reviewed sermon body is already being saved.'
    );
  }
  return { proposalToken, entry };
}

async function withSermonBodyReviewApplication(proposalToken, entry, operation) {
  entry.applying = true;
  let succeeded = false;
  try {
    const result = await operation();
    succeeded = true;
    return result;
  } finally {
    if (sermonBodyReviewProposals.get(proposalToken) === entry) {
      if (succeeded) sermonBodyReviewProposals.delete(proposalToken);
      else entry.applying = false;
    }
  }
}

function pruneSermonReferenceReviewProposals(
  now = Date.now(),
  { makeRoom = false } = {}
) {
  for (const [token, proposal] of sermonReferenceReviewProposals) {
    if (proposal.expiresAt <= now && proposal.applying !== true) {
      sermonReferenceReviewProposals.delete(token);
    }
  }
  if (!makeRoom) return true;
  while (
    sermonReferenceReviewProposals.size
    >= SERMON_REFERENCE_REVIEW_PROPOSAL_LIMIT
  ) {
    const evictableToken = [...sermonReferenceReviewProposals]
      .find(([, proposal]) => proposal.applying !== true)?.[0];
    if (!evictableToken) return false;
    sermonReferenceReviewProposals.delete(evictableToken);
  }
  return true;
}

function holdSermonReferenceReviewProposal(entry, publicProposal) {
  const now = Date.now();
  if (!pruneSermonReferenceReviewProposals(now, { makeRoom: true })) {
    failMainOperation(
      'SERMON_REFERENCE_REVIEW_PROPOSALS_BUSY',
      'Active Scripture-reference reviews are still being saved. Try again when one finishes.'
    );
  }
  const proposalToken = crypto.randomBytes(24).toString('base64url');
  const expiresAt = now + SERMON_REFERENCE_REVIEW_PROPOSAL_TTL_MS;
  sermonReferenceReviewProposals.set(proposalToken, {
    ...entry,
    applying: false,
    completedResult: null,
    expiresAt
  });
  return {
    proposalToken,
    expiresAt: new Date(expiresAt).toISOString(),
    ...publicProposal
  };
}

function requireSermonReferenceReviewProposal(rawToken) {
  const proposalToken = prepareText(
    rawToken,
    'Scripture-reference review',
    64,
    { required: true }
  );
  if (!/^[A-Za-z0-9_-]{32}$/.test(proposalToken)) {
    failMainOperation(
      'INVALID_SERMON_REFERENCE_REVIEW_PROPOSAL',
      'Review these Scripture references again before saving them.'
    );
  }
  pruneSermonReferenceReviewProposals();
  const entry = sermonReferenceReviewProposals.get(proposalToken);
  if (!entry || (entry.expiresAt <= Date.now() && entry.applying !== true)) {
    if (entry?.applying !== true) {
      sermonReferenceReviewProposals.delete(proposalToken);
    }
    failMainOperation(
      'EXPIRED_SERMON_REFERENCE_REVIEW_PROPOSAL',
      'This Scripture-reference review expired. Review the current references again.'
    );
  }
  return { proposalToken, entry };
}

async function withSermonReferenceReviewApplication(entry, operation) {
  if (entry.completedResult) return entry.completedResult;
  if (entry.applying === true) {
    failMainOperation(
      'SERMON_REFERENCE_REVIEW_APPLY_IN_PROGRESS',
      'This Scripture-reference review is already being saved.'
    );
  }
  entry.applying = true;
  try {
    const result = await operation();
    entry.completedResult = result;
    return result;
  } finally {
    entry.applying = false;
  }
}

function requireSermonReferenceTarget(project, rawItemId) {
  const companion = isPowerPointCompanionProject(project);
  const itemId = prepareId(
    rawItemId,
    companion ? 'PowerPoint sermon anchor' : 'Service item'
  );
  if (companion) {
    if (!project.sourceServiceSet?.fingerprint) {
      failMainOperation(
        'CURRENT_SERVICE_COMPANION_INVALID',
        'The PowerPoint service no longer has an exact source binding.'
      );
    }
    const anchorItemId = currentServiceCompanionAnchor(
      project,
      project.sourceServiceSet.fingerprint
    );
    if (itemId !== anchorItemId) {
      failMainOperation(
        'INVALID_SERMON_REFERENCE_ANCHOR',
        'Choose the linked sermon anchor for this PowerPoint service.'
      );
    }
  }
  const item = project.items[itemId];
  if (!isSermonSourceTarget(project, item)) {
    failMainOperation(
      companion
        ? 'INVALID_SERMON_REFERENCE_ANCHOR'
        : 'INVALID_SERMON_SOURCE_ITEM',
      companion
        ? 'The PowerPoint service no longer has an eligible sermon anchor.'
        : 'Choose a linked sermon cue or sermon outline group before reviewing Scripture references.'
    );
  }
  const linked = resolveSermonSourceLink(project, item);
  if (!linked) {
    failMainOperation(
      'SERMON_SOURCE_NOT_LINKED',
      'Link an exact sermon packet before reviewing Scripture references.'
    );
  }
  return { itemId, item, linked };
}

function optionalSermonReferenceReviewId(value, label) {
  if (value === undefined || value === null || value === '') return null;
  return prepareSermonDomainId(value, label);
}

async function prepareSermonReferenceReviewEntries(rawEntries, sermon) {
  if (!Array.isArray(rawEntries) || rawEntries.length < 1 || rawEntries.length > 512) {
    failMainOperation(
      'INVALID_SERMON_REFERENCE_REVIEW',
      'A Scripture-reference review must contain between 1 and 512 ordered references.'
    );
  }
  const existingById = new Map(
    (sermon.references || []).map(reference => [reference.id, reference])
  );
  const outlineIds = new Set(
    (sermon.outline || []).map(section => section.id)
  );
  const usedExistingIds = new Set();
  let lookupCount = 0;
  const prepared = rawEntries.map((raw, index) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      failMainOperation(
        'INVALID_SERMON_REFERENCE_REVIEW',
        `Scripture reference ${index + 1} is invalid.`
      );
    }
    requireExactPrepareKeys(raw, [
      'referenceId',
      'replacementQuery',
      'selectedBook',
      'role',
      'confirmed',
      'sectionId'
    ], `Scripture reference ${index + 1}`);
    const existingReferenceId = optionalSermonReferenceReviewId(
      raw.referenceId,
      `Scripture reference ${index + 1} id`
    );
    const existing = existingReferenceId
      ? existingById.get(existingReferenceId)
      : null;
    if (existingReferenceId && !existing) {
      failMainOperation(
        'UNKNOWN_SERMON_REFERENCE',
        'One reviewed Scripture reference is no longer in this sermon.'
      );
    }
    if (existingReferenceId && usedExistingIds.has(existingReferenceId)) {
      failMainOperation(
        'DUPLICATE_SERMON_REFERENCE',
        'Each existing Scripture reference can appear only once in the reviewed order.'
      );
    }
    if (existingReferenceId) usedExistingIds.add(existingReferenceId);

    const replacementQuery = prepareText(
      raw.replacementQuery,
      `Scripture reference ${index + 1} replacement`,
      160
    );
    if (!existing && !replacementQuery) {
      failMainOperation(
        'MISSING_SERMON_REFERENCE',
        'Every new Scripture reference needs a Bible passage.'
      );
    }
    const selectedBook = raw.selectedBook === undefined
      || raw.selectedBook === null
      || raw.selectedBook === ''
      ? null
      : prepareText(
          raw.selectedBook,
          `Scripture reference ${index + 1} Bible book`,
          80,
          { required: true }
        );
    const role = prepareText(
      raw.role,
      `Scripture reference ${index + 1} role`,
      16,
      { required: true }
    );
    if (!['primary', 'mentioned'].includes(role)) {
      failMainOperation(
        'INVALID_SERMON_REFERENCE_ROLE',
        'Choose Primary or Mentioned for every Scripture reference.'
      );
    }
    if (typeof raw.confirmed !== 'boolean') {
      failMainOperation(
        'INVALID_SERMON_REFERENCE_CONFIRMATION',
        'Every Scripture reference must explicitly say whether it is confirmed.'
      );
    }
    const needsConfirmationPreview = Boolean(
      existing
      && existing.reviewStatus === 'suggested'
      && raw.confirmed === true
    );
    if (replacementQuery || needsConfirmationPreview) lookupCount += 1;
    const sectionId = optionalSermonReferenceReviewId(
      raw.sectionId,
      `Scripture reference ${index + 1} outline section`
    );
    if (sectionId && !outlineIds.has(sectionId)) {
      failMainOperation(
        'UNKNOWN_OUTLINE_SECTION',
        'One reviewed Scripture reference points to an unavailable outline section.'
      );
    }
    return {
      existing,
      existingReferenceId,
      replacementQuery,
      selectedBook,
      role,
      reviewStatus: raw.confirmed ? 'confirmed' : 'suggested',
      needsConfirmationPreview,
      sectionId
    };
  });
  if (lookupCount > 64) {
    failMainOperation(
      'SERMON_REFERENCE_LOOKUP_LIMIT',
      'Review at most 64 new or corrected Bible passages at one time.'
    );
  }

  const previewByReferenceId = new Map();
  const entries = [];
  for (const [index, intent] of prepared.entries()) {
    let range = intent.existing?.range || null;
    let referenceId = intent.existingReferenceId;
    if (intent.replacementQuery || intent.needsConfirmationPreview) {
      const lookup = intent.replacementQuery
        ? await resolveSermonPrimaryReferenceLookupRequest({
            query: intent.replacementQuery,
            ...(intent.selectedBook
              ? { selectedBook: intent.selectedBook }
              : {})
          })
        : await sermonReferenceBibleLibrary.lookupCanonicalRange({
            book: intent.existing.range.bookId,
            startChapter: intent.existing.range.start.chapter,
            startVerse: intent.existing.range.start.verse,
            endChapter: intent.existing.range.end.chapter,
            endVerse: intent.existing.range.end.verse
          }, {
            translationId: 'BSB'
          });
      if (lookup?.status === 'ambiguous') {
        failMainOperation(
          'BIBLE_REFERENCE_AMBIGUOUS',
          `Scripture reference ${index + 1} is ambiguous. Enter its full numbered book name.`,
          { choices: lookup.choices || [] }
        );
      }
      if (lookup?.status !== 'ok' || !lookup.passage) {
        failMainOperation(
          'BIBLE_REFERENCE_INVALID',
          lookup?.message
            || `Scripture reference ${index + 1} could not be confirmed.`,
          { status: lookup?.status || 'error', code: lookup?.code || null }
        );
      }
      const passage = lookup.passage;
      const bookId = resolveBookId(passage.book);
      if (!bookId) {
        failMainOperation(
          'BIBLE_REFERENCE_INVALID',
          `Scripture reference ${index + 1} does not use a canonical Bible book.`
        );
      }
      if (intent.replacementQuery) {
        range = {
          schemaVersion: 1,
          bookId,
          start: {
            chapter: passage.chapter,
            verse: passage.verseStart
          },
          end: {
            chapter: passage.chapter,
            verse: passage.verseEnd
          }
        };
        if (!referenceId) referenceId = projectItemId('reference');
      }
      const previewText = Array.isArray(passage.verses)
        ? passage.verses.map(verse => `${
            Number.isSafeInteger(verse.chapter)
              ? `${verse.chapter}:`
              : ''
          }${verse.number} ${verse.text}`).join(' ')
        : '';
      previewByReferenceId.set(referenceId, {
        reference: String(passage.reference || formatBibleRange(range)),
        translation: String(passage.translation?.abbr || 'BSB'),
        text: previewText.slice(0, 12000),
        truncated: previewText.length > 12000
      });
    }
    entries.push({
      referenceId,
      existingReferenceId: intent.existingReferenceId,
      range,
      replaced: Boolean(intent.replacementQuery),
      enteredText: intent.replacementQuery
        || intent.existing?.enteredText
        || formatBibleRange(range),
      role: intent.role,
      reviewStatus: intent.reviewStatus,
      sectionId: intent.sectionId
    });
  }
  return { entries, previewByReferenceId };
}

function sermonReferenceChangeSummary(previous, next) {
  const previousById = new Map(previous.map(reference => [reference.id, reference]));
  const nextById = new Map(next.map(reference => [reference.id, reference]));
  const addedReferenceIds = next
    .filter(reference => !previousById.has(reference.id))
    .map(reference => reference.id);
  const removedReferenceIds = previous
    .filter(reference => !nextById.has(reference.id))
    .map(reference => reference.id);
  const updatedReferenceIds = next
    .filter(reference => {
      const before = previousById.get(reference.id);
      return before && JSON.stringify(before) !== JSON.stringify(reference);
    })
    .map(reference => reference.id);
  const previousRetainedOrder = previous
    .map(reference => reference.id)
    .filter(referenceId => nextById.has(referenceId));
  const nextRetainedOrder = next
    .map(reference => reference.id)
    .filter(referenceId => previousById.has(referenceId));
  return {
    addedReferenceIds,
    removedReferenceIds,
    updatedReferenceIds,
    reordered: JSON.stringify(previousRetainedOrder)
      !== JSON.stringify(nextRetainedOrder)
  };
}

function publicSermonReferenceReviewProposal({
  before,
  reviewed,
  previewByReferenceId,
  protectedReferenceIds
}) {
  const title = reviewed.document.titles?.[reviewed.document.defaultLanguage];
  if (typeof title !== 'string' || !title) {
    failMainOperation(
      'INVALID_SERMON_REFERENCE_REVIEW_PROPOSAL',
      'The reviewed sermon title is invalid.'
    );
  }
  const changes = sermonReferenceChangeSummary(
    before.references,
    reviewed.document.references
  );
  const beforeById = new Map(
    before.references.map((reference, position) => [
      reference.id,
      { reference, position }
    ])
  );
  const nextIds = new Set(
    reviewed.document.references.map(reference => reference.id)
  );
  const referenceSummary = (reference, position) => ({
    id: reference.id,
    label: formatBibleRange(reference.range),
    role: reference.role,
    reviewStatus: reference.reviewStatus,
    sectionId: reference.sectionId,
    source: reference.source,
    enteredText: reference.enteredText,
    position
  });
  return {
    sermon: {
      id: reviewed.document.id,
      title,
      baseRevisionId: reviewed.previousRevision,
      nextRevisionId: reviewed.revision
    },
    publication: {
      before: before.publication.status,
      after: reviewed.document.publication.status,
      visibility: reviewed.document.publication.visibility,
      reset: reviewed.publicationReset === true
    },
    changes,
    removedReferences: before.references
      .map((reference, position) => ({ reference, position }))
      .filter(({ reference }) => !nextIds.has(reference.id))
      .map(({ reference, position }) =>
        referenceSummary(reference, position)),
    references: reviewed.document.references.map((reference, position) => {
      const previous = beforeById.get(reference.id) || null;
      return {
        ...referenceSummary(reference, position),
        previous: previous
          ? referenceSummary(previous.reference, previous.position)
          : null,
        protectedByReading: protectedReferenceIds.has(reference.id),
        preview: previewByReferenceId.get(reference.id) || null
      };
    })
  };
}

function failSermonReferenceReview(error) {
  const messages = {
    ARCHIVED_SERMON: 'Archived sermons cannot accept Scripture-reference edits.',
    SERMON_REVISION_MISMATCH:
      'The sermon changed after this Scripture-reference review began. Review it again.',
    MISSING_CONFIRMED_PRIMARY_REFERENCE:
      'Keep at least one confirmed Primary passage in the reviewed sermon.',
    DUPLICATE_REFERENCE_RANGE:
      'The reviewed sermon repeats the same passage with the same role.',
    TOO_MANY_REFERENCES:
      'A sermon can contain at most 512 reviewed Scripture references.',
    SERMON_REPIN_READING_MISMATCH:
      'A generated congregational reading uses one changed reference. Remove or rebuild that reading before changing its passage, role, confirmation, or identity.',
    NO_REFERENCE_CHANGES:
      'No Scripture-reference changes were found.'
  };
  const code = typeof error?.code === 'string'
    ? error.code
    : 'SERMON_REFERENCE_REVIEW_FAILED';
  failMainOperation(
    code,
    messages[code]
      || 'The reviewed Scripture references could not be saved safely.'
  );
}

function requireSermonBodyTarget(project, rawItemId) {
  const companion = isPowerPointCompanionProject(project);
  const itemId = prepareId(
    rawItemId,
    companion ? 'PowerPoint sermon anchor' : 'Service item'
  );
  if (companion) {
    if (!project.sourceServiceSet?.fingerprint) {
      failMainOperation(
        'CURRENT_SERVICE_COMPANION_INVALID',
        'The PowerPoint service no longer has an exact source binding.'
      );
    }
    const anchorItemId = currentServiceCompanionAnchor(
      project,
      project.sourceServiceSet.fingerprint
    );
    if (itemId !== anchorItemId) {
      failMainOperation(
        'INVALID_SERMON_BODY_ANCHOR',
        'Choose the linked sermon anchor for this PowerPoint service.'
      );
    }
  }
  const item = project.items[itemId];
  if (!isSermonSourceTarget(project, item)) {
    failMainOperation(
      companion ? 'INVALID_SERMON_BODY_ANCHOR' : 'INVALID_SERMON_SOURCE_ITEM',
      companion
        ? 'The PowerPoint service no longer has an eligible sermon anchor.'
        : 'Choose a linked sermon cue or sermon outline group before reviewing its body text.'
    );
  }
  const linked = resolveSermonSourceLink(project, item);
  if (!linked) {
    failMainOperation(
      'SERMON_SOURCE_NOT_LINKED',
      'Link an exact sermon packet before reviewing its body text.'
    );
  }
  return { itemId, item, linked };
}

function sermonBodyReviewSourceLanguages(source) {
  return [...(source.languages || [source.language || 'und'])];
}

function publicSermonBodyReviewProposal({
  sermon,
  source,
  internalProposal,
  replacesExisting
}) {
  const reviewedEntry = internalProposal.entries.find(candidate =>
    candidate.sourceId === source.id);
  const sourceLanguages = sermonBodyReviewSourceLanguages(source);
  const title = sermon.titles?.[sermon.defaultLanguage];
  if (
    !reviewedEntry
    || internalProposal.entries.filter(candidate =>
      candidate.sourceId === source.id).length !== 1
    || typeof title !== 'string'
    || !title
    || typeof source.fileName !== 'string'
    || !source.fileName
    || source.fileName.includes('/')
    || source.fileName.includes('\\')
  ) {
    const error = new Error('The sermon body review projection is invalid.');
    error.code = 'INVALID_BODY_REVIEW_PROPOSAL';
    throw error;
  }
  return {
    sermon: {
      id: sermon.id,
      title,
      defaultLanguage: sermon.defaultLanguage,
      publicationStatus: sermon.publication.status,
      visibility: sermon.publication.visibility
    },
    source: {
      id: source.id,
      fileName: source.fileName,
      kind: source.kind,
      languages: sourceLanguages
    },
    entry: {
      id: reviewedEntry.id,
      kind: reviewedEntry.kind,
      language: reviewedEntry.language,
      text: reviewedEntry.text
    },
    bodyEntryCount: internalProposal.entries.length,
    replacesExisting: replacesExisting === true
  };
}

function prepareSermonBodyReviewEntry(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    failMainOperation(
      'INVALID_SERMON_BODY_REVIEW_ENTRY',
      'The reviewed sermon body entry is invalid.'
    );
  }
  requireExactPrepareKeys(
    raw,
    ['id', 'kind', 'language', 'text'],
    'Reviewed sermon body entry'
  );
  if (typeof raw.text !== 'string' || !raw.text.trim()) {
    failMainOperation(
      'INVALID_SERMON_BODY_REVIEW_ENTRY',
      'The reviewed sermon body text is required.'
    );
  }
  if (Buffer.byteLength(raw.text, 'utf8') > MAX_SERMON_BODY_ENTRY_BYTES) {
    failMainOperation(
      'SERMON_BODY_REVIEW_ENTRY_TOO_LARGE',
      'The reviewed sermon body entry is too large to save safely.'
    );
  }
  const kind = prepareText(
    raw.kind,
    'Reviewed sermon body kind',
    24,
    { required: true }
  ).toLowerCase();
  if (!['manuscript', 'slide-notes', 'transcript', 'other'].includes(kind)) {
    failMainOperation(
      'INVALID_SERMON_BODY_REVIEW_ENTRY',
      'The reviewed sermon body kind is invalid.'
    );
  }
  const language = prepareText(
    raw.language,
    'Reviewed sermon body language',
    35,
    { required: true }
  ).toLowerCase();
  if (!/^[a-z]{2,3}(?:-[a-z0-9]{2,8})*$/.test(language)) {
    failMainOperation(
      'INVALID_SERMON_BODY_REVIEW_ENTRY',
      'The reviewed sermon body language is invalid.'
    );
  }
  return {
    id: prepareSermonDomainId(raw.id, 'Reviewed sermon body entry'),
    kind,
    language,
    text: raw.text
  };
}

function sermonBodyReviewCoordinatorKey(binding) {
  return `body-${sermonExtractionProposalCoordinatorKey(binding)}`;
}

function prepareSermonSuggestionIds(value, label) {
  if (!Array.isArray(value) || value.length > 500) {
    failMainOperation(
      'INVALID_SERMON_EXTRACTION_SELECTION',
      `${label} must contain at most 500 reviewed suggestion ids.`
    );
  }
  const seen = new Set();
  return value.map((candidate, index) => {
    const suggestionId = prepareId(candidate, `${label} ${index + 1}`);
    if (seen.has(suggestionId)) {
      failMainOperation(
        'INVALID_SERMON_EXTRACTION_SELECTION',
        `${label} cannot repeat a suggestion.`
      );
    }
    seen.add(suggestionId);
    return suggestionId;
  });
}

function sermonExtractionReferenceQuery(suggestion) {
  const bookHint = typeof suggestion?.bookHint === 'string'
    ? suggestion.bookHint.trim()
    : '';
  const rawText = typeof suggestion?.rawText === 'string'
    ? suggestion.rawText.normalize('NFC')
    : '';
  if (!bookHint || !rawText) return null;
  const referencePart = rawText.match(
    /(\d{1,3}\s*:\s*\d{1,3}(?:\s*[-–—]\s*(?:\d{1,3}\s*:\s*)?\d{1,3})?)/u
  )?.[1];
  if (!referencePart) return null;
  const normalizedPart = referencePart
    .replace(/\s+/gu, '')
    .replace(/[–—]/gu, '-');
  // The current Bible resolver deliberately accepts one chapter per bounded
  // range. Do not guess at a cross-chapter citation.
  if (/-\d{1,3}:\d{1,3}$/u.test(normalizedPart)) return null;
  return `${bookHint} ${normalizedPart}`;
}

async function resolveSermonExtractionReference(suggestion) {
  const query = sermonExtractionReferenceQuery(suggestion);
  if (!query) return null;
  const lookup = await resolveSermonPrimaryReferenceLookupRequest({ query });
  if (lookup?.status !== 'ok' || !lookup.passage) return null;
  const passage = lookup.passage;
  const bookId = resolveBookId(passage.book);
  if (!bookId) return null;
  return {
    schemaVersion: 1,
    bookId,
    start: {
      chapter: passage.chapter,
      verse: passage.verseStart
    },
    end: {
      chapter: passage.chapter,
      verse: passage.verseEnd
    }
  };
}

function sermonExtractionCoordinatorKey(source) {
  const metadataDigest = crypto.createHash('sha256').update(JSON.stringify({
    id: source.id,
    kind: source.kind,
    languages: source.languages || [source.language || 'und'],
    mediaType: source.mediaType,
    sizeBytes: source.sizeBytes
  })).digest('hex').slice(0, 24);
  return `sha256:${source.sha256}:${metadataDigest}`;
}

function sermonExtractionProposalCoordinatorKey(binding) {
  const digest = crypto.createHash('sha256').update(JSON.stringify({
    projectId: binding.projectId,
    projectRevisionId: binding.projectRevisionId,
    itemId: binding.itemId,
    resourceId: binding.resourceId,
    sermonId: binding.sermonId,
    sermonRevisionId: binding.sermonRevisionId,
    sourceId: binding.sourceId,
    sourceRevision: binding.sourceRevision
  })).digest('hex');
  return `proposal:${digest}`;
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

function prepareServiceSongItem(project, songRead, rawArrangement) {
  const withResource = addSongResource(project, songRead.song, {
    provider: 'local',
    itemId: songRead.song.id,
    revision: songRead.revision
  });
  const {
    sourceChannelId,
    variants
  } = createDefaultSongChannelVariants(
    withResource.project,
    withResource.resourceId
  );
  const arrangementSections = parseSongArrangement(
    rawArrangement,
    songRead.song
  );
  return {
    project: withResource.project,
    item: {
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
    }
  };
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

async function verifiedPowerPointServiceSetBinding(claim, activeProfileId) {
  try {
    const manifest = await readCurrentServiceSet(getServiceSetRoot(), {
      verifyAssets: true
    });
    if (!manifest) return null;
    const fingerprint = serviceSetFingerprint(manifest);
    return bindVerifiedPowerPointServiceSet({
      claim,
      manifest,
      activeProfileId,
      fingerprint
    });
  } catch (error) {
    console.warn(
      '[PostShow] PowerPoint ServiceSet verification was unavailable:',
      error?.code || error?.name || 'verification-failed'
    );
    return null;
  }
}

async function capturePowerPointServiceSetCandidate(launchPlan) {
  const claim = resolvePowerPointServiceSetClaim({
    launchPlan,
    presentations: appState.presentations
  });
  if (!claim) return null;

  const capturedPresentationRevision = presentationRevision;
  const capturedProfileId = activeVenueProfile?.id || 'default';
  const binding = await verifiedPowerPointServiceSetBinding(
    claim,
    capturedProfileId
  );
  if (!binding
    || presentationRevision !== capturedPresentationRevision
    || (activeVenueProfile?.id || 'default') !== capturedProfileId) {
    return null;
  }
  return Object.freeze({
    claim,
    binding,
    launchPlan,
    presentationRevision: capturedPresentationRevision,
    profileId: capturedProfileId
  });
}

function sealActivePowerPointShowReceipt(candidate, sessionId) {
  if (!candidate
    || outputLifecyclePhase !== 'live'
    || sessionId !== outputSessionId
    || appState.activeLaunchPlan !== candidate.launchPlan
    || presentationRevision !== candidate.presentationRevision
    || (activeVenueProfile?.id || 'default') !== candidate.profileId) {
    activePowerPointShowReceipt = null;
    return null;
  }
  activePowerPointShowReceipt = Object.freeze({
    schemaVersion: 1,
    receiptToken: crypto.randomBytes(24).toString('base64url'),
    claim: candidate.claim,
    binding: candidate.binding,
    presentationRevision: candidate.presentationRevision,
    profileId: candidate.profileId,
    outputSessionId: sessionId
  });
  return activePowerPointShowReceipt;
}

function prunePostShowPowerPointServiceReceipts(
  now = Date.now(),
  { makeRoom = false } = {}
) {
  for (const [token, receipt] of postShowPowerPointServiceReceipts) {
    if (receipt.expiresAt <= now) {
      postShowPowerPointServiceReceipts.delete(token);
    }
  }
  if (!makeRoom) return;
  while (
    postShowPowerPointServiceReceipts.size
    >= POST_SHOW_POWERPOINT_RECEIPT_LIMIT
  ) {
    postShowPowerPointServiceReceipts.delete(
      postShowPowerPointServiceReceipts.keys().next().value
    );
  }
}

function holdPostShowPowerPointServiceReceipt(receipt) {
  const createdAt = Date.now();
  const expiresAt = createdAt + POST_SHOW_POWERPOINT_RECEIPT_TTL_MS;
  prunePostShowPowerPointServiceReceipts(createdAt, { makeRoom: true });
  const stored = Object.freeze({
    ...receipt,
    createdAt,
    expiresAt
  });
  postShowPowerPointServiceReceipts.set(receipt.receiptToken, stored);
  return {
    schemaVersion: 1,
    serviceDate: receipt.binding.serviceDate,
    receiptToken: receipt.receiptToken,
    expiresAt: new Date(expiresAt).toISOString()
  };
}

function requirePostShowPowerPointServiceReceipt(rawToken) {
  const receiptToken = typeof rawToken === 'string' ? rawToken : '';
  if (!/^[A-Za-z0-9_-]{32}$/.test(receiptToken)) {
    failMainOperation(
      'INVALID_POST_SHOW_POWERPOINT_RECEIPT',
      'The exact PowerPoint post-service receipt is invalid. End the intended Show again.'
    );
  }
  prunePostShowPowerPointServiceReceipts();
  const receipt = postShowPowerPointServiceReceipts.get(receiptToken);
  if (!receipt || receipt.expiresAt <= Date.now()) {
    postShowPowerPointServiceReceipts.delete(receiptToken);
    failMainOperation(
      'EXPIRED_POST_SHOW_POWERPOINT_RECEIPT',
      'The exact PowerPoint post-service receipt expired. End the intended Show again.'
    );
  }
  return { receiptToken, receipt };
}

async function finalizePowerPointServiceHandoff(
  receipt,
  endedOutputSessionId
) {
  if (!receipt
    || receipt.schemaVersion !== 1
    || !Number.isSafeInteger(receipt.outputSessionId)
    || !Number.isSafeInteger(endedOutputSessionId)
    || !Number.isSafeInteger(receipt.outputSessionId + 1)
    || receipt.outputSessionId + 1 !== endedOutputSessionId
    || presentationRevision !== receipt.presentationRevision
    || (activeVenueProfile?.id || 'default') !== receipt.profileId
    || outputSessionId !== endedOutputSessionId
    || appState.activeLaunchPlan !== null) {
    return null;
  }
  const binding = await verifiedPowerPointServiceSetBinding(
    receipt.claim,
    receipt.profileId
  );
  if (!binding
    || presentationRevision !== receipt.presentationRevision
    || (activeVenueProfile?.id || 'default') !== receipt.profileId
    || outputSessionId !== endedOutputSessionId
    || appState.activeLaunchPlan !== null
    || !sameCurrentServiceCompanionBinding(binding, receipt.binding)) {
    return null;
  }
  return holdPostShowPowerPointServiceReceipt(receipt);
}

function failCurrentServiceCompanion(error) {
  const messages = {
    INVALID_SERVICE_SET: 'The current PowerPoint service snapshot is invalid.',
    PINNED_ASSET_UNAVAILABLE:
      'One current PowerPoint presentation is no longer available in the local snapshot.',
    PINNED_ASSET_CHANGED:
      'One current PowerPoint presentation changed after it was loaded. Reload the service first.',
    INVALID_PINNED_SET:
      'The current PowerPoint service snapshot is not compatible with this SyncShow build.'
  };
  failMainOperation(
    'CURRENT_SERVICE_COMPANION_UNAVAILABLE',
    messages[error?.code]
      || 'The current PowerPoint service could not be verified for sermon handoff.',
    { cause: typeof error?.code === 'string' ? error.code : 'UNKNOWN' }
  );
}

function publicCurrentServiceCompanionError(error) {
  const rawCode = typeof error?.code === 'string'
    ? error.code
    : 'CURRENT_SERVICE_COMPANION_ERROR';
  const code = /^[A-Z][A-Z0-9_]{2,79}$/.test(rawCode)
    ? rawCode
    : 'CURRENT_SERVICE_COMPANION_ERROR';
  const rawMessage = typeof error?.message === 'string'
    ? error.message.trim()
    : '';
  const message = rawMessage
    && rawMessage.length <= 500
    && !/[\0\r\n]/u.test(rawMessage)
    && !/(?:file:\/\/|[A-Za-z]:\\|\/(?:Users|private|Volumes|home|tmp|var)\/)/u
      .test(rawMessage)
    ? rawMessage
    : 'The PowerPoint service follow-up could not be completed.';
  return { code, message };
}

async function currentServiceCompanionIpcResult(operation) {
  try {
    return { success: true, data: await operation() };
  } catch (error) {
    return {
      success: false,
      error: publicCurrentServiceCompanionError(error)
    };
  }
}

function currentServiceCompanionProjectId(fingerprint) {
  return `pptx-companion-${fingerprint.slice(0, 48)}`;
}

function currentServiceCompanionAnchorId(fingerprint) {
  return `sermon-${fingerprint.slice(0, 24)}`;
}

function pruneCurrentServiceCompanionInspections(
  now = Date.now(),
  { makeRoom = false } = {}
) {
  for (const [token, inspection] of currentServiceCompanionInspections) {
    if (inspection.expiresAt <= now) {
      currentServiceCompanionInspections.delete(token);
    }
  }
  if (!makeRoom) return;
  while (
    currentServiceCompanionInspections.size
    >= CURRENT_SERVICE_COMPANION_INSPECTION_LIMIT
  ) {
    currentServiceCompanionInspections.delete(
      currentServiceCompanionInspections.keys().next().value
    );
  }
}

function holdCurrentServiceCompanionInspection(
  binding,
  { nativeDraftReview = null } = {}
) {
  const createdAt = Date.now();
  pruneCurrentServiceCompanionInspections(createdAt, { makeRoom: true });
  const inspectionToken = crypto.randomBytes(24).toString('base64url');
  const expiresAt = createdAt + CURRENT_SERVICE_COMPANION_INSPECTION_TTL_MS;
  currentServiceCompanionInspections.set(inspectionToken, {
    binding: { ...binding },
    nativeDraftReview,
    createdAt,
    expiresAt
  });
  return {
    inspectionToken,
    expiresAt: new Date(expiresAt).toISOString()
  };
}

function requireCurrentServiceCompanionInspection(rawToken) {
  const inspectionToken = typeof rawToken === 'string' ? rawToken : '';
  if (!/^[A-Za-z0-9_-]{32}$/.test(inspectionToken)) {
    failMainOperation(
      'INVALID_CURRENT_SERVICE_COMPANION_INSPECTION',
      'Refresh the Current PowerPoint service card before opening its sermon handoff.'
    );
  }
  pruneCurrentServiceCompanionInspections();
  const inspection = currentServiceCompanionInspections.get(inspectionToken);
  if (!inspection || inspection.expiresAt <= Date.now()) {
    currentServiceCompanionInspections.delete(inspectionToken);
    failMainOperation(
      'EXPIRED_CURRENT_SERVICE_COMPANION_INSPECTION',
      'The Current PowerPoint service card expired. Refresh Prepare and try again.'
    );
  }
  return { inspectionToken, inspection };
}

function sameCurrentServiceCompanionBinding(left, right) {
  return left?.id === right?.id
    && left?.fingerprint === right?.fingerprint
    && left?.serviceDate === right?.serviceDate
    && left?.profileId === right?.profileId;
}

function currentServiceNativeDraftMatchesVenue(
  project,
  venueProfile = activeVenueProfile
) {
  const expected = nativeProjectChannels(venueProfile) || [];
  const actual = Array.isArray(project?.channelIds)
    ? project.channelIds.map(channelId => ({
        id: channelId,
        label: project.channels?.[channelId]?.label
      }))
    : [];
  return expected.length > 0
    && JSON.stringify(actual) === JSON.stringify(
      expected.map(channel => ({
        id: channel.id,
        label: channel.label
      }))
    );
}

function currentServiceNativeDraftUnavailable(reason) {
  return {
    available: false,
    exists: false,
    projectId: null,
    positionCount: null,
    countsMatch: null,
    sources: [],
    reason
  };
}

function currentServiceNativeDraftLoadedReview(
  context,
  venueProfile = activeVenueProfile
) {
  const roleLabels = new Map(
    (venueProfile?.inputRoles || []).map(role => [
      role.id,
      role.label
    ])
  );
  const enabledDeckRoleIds = new Set(
    (venueProfile?.inputRoles || [])
      .filter(role => role.enabled && role.kind === 'deck')
      .map(role => role.id)
  );
  const manifestRoleIds = new Set(
    Object.keys(context.manifest.inputs || {})
  );
  if (enabledDeckRoleIds.size < 1
    || enabledDeckRoleIds.size > 16
    || manifestRoleIds.size !== enabledDeckRoleIds.size
    || [...enabledDeckRoleIds].some(roleId =>
      !manifestRoleIds.has(roleId))) {
    return {
      review: null,
      public: currentServiceNativeDraftUnavailable(
        'Load one synchronized presentation for every enabled venue channel before creating a native draft.'
      )
    };
  }
  const sources = [];
  for (const input of Object.values(context.manifest.inputs || {})
    .sort((left, right) => left.roleId.localeCompare(right.roleId, 'en'))) {
    if (!enabledDeckRoleIds.has(input.roleId)) {
      return {
        review: null,
        public: currentServiceNativeDraftUnavailable(
          'One saved presentation is not enabled in the current venue profile.'
        )
      };
    }
    const presentation = appState.presentations[input.roleId];
    if (!presentation
      || presentation.renderer === 'native-cue'
      || presentation.sourceType === 'service-project'
      || typeof presentation.cacheDir !== 'string'
      || path.resolve(presentation.cacheDir) !== path.resolve(
        path.join(CONFIG.cacheDir, input.roleId)
      )
      || !Number.isSafeInteger(presentation.slideCount)
      || presentation.slideCount < 1
      || presentation.slideCount > 2000) {
      return {
        review: null,
        public: currentServiceNativeDraftUnavailable(
          'Load every presentation from this saved service before creating its native draft.'
        )
      };
    }
    let restoreContext;
    try {
      restoreContext = normalizeCacheRestoreContext(
        presentation.metadata?.restoreContext,
        { allowNull: false }
      );
    } catch (_error) {
      return {
        review: null,
        public: currentServiceNativeDraftUnavailable(
          'Reload this saved PowerPoint service before creating its native draft.'
        )
      };
    }
    if (restoreContext.sourceKind !== 'service-set'
      || restoreContext.serviceSetId !== context.manifest.id
      || restoreContext.roleId !== input.roleId
      || restoreContext.assetId !== input.assetId) {
      return {
        review: null,
        public: currentServiceNativeDraftUnavailable(
          'The loaded presentations do not all belong to this exact saved service.'
        )
      };
    }
    const fileName = prepareText(
      input.sourceName,
      'Current service file name',
      255,
      { required: true }
    );
    if (
      fileName !== path.basename(fileName)
      || fileName.includes('/')
      || fileName.includes('\\')
    ) {
      failMainOperation(
        'INVALID_CURRENT_SERVICE_FILE',
        'One current PowerPoint presentation has an invalid file name.'
      );
    }
    sources.push({
      roleId: prepareId(input.roleId, 'Current service role'),
      roleLabel: prepareText(
        roleLabels.get(input.roleId) || input.roleId,
        'Current service role label',
        120,
        { required: true }
      ),
      channelId: input.roleId,
      fileName,
      assetId: input.assetId,
      sha256: input.sha256,
      size: input.size,
      slideCount: presentation.slideCount,
      cacheDir: presentation.cacheDir,
      slideMetadataRevisionId: sha256Json(
        presentation.metadata?.slides || []
      ),
      pdfRendererRevisionId: sha256Json(
        presentation.metadata?.pdfRenderer || null
      )
    });
  }
  if (sources.length < 1 || sources.length > 16) {
    return {
      review: null,
      public: currentServiceNativeDraftUnavailable(
        'The saved PowerPoint service has no reviewable presentations.'
      )
    };
  }
  const positionCount = Math.max(
    ...sources.map(source => source.slideCount)
  );
  const countsMatch =
    new Set(sources.map(source => source.slideCount)).size === 1;
  if (!countsMatch) {
    return {
      review: null,
      public: currentServiceNativeDraftUnavailable(
        'The loaded presentations have different slide counts. Keep using PowerPoint until their synchronized positions match.'
      )
    };
  }
  const review = {
    mode: 'create',
    binding: { ...context.binding },
    presentationRevision,
    venueRevisionId:
      preparedServiceVenueRevisionId(venueProfile),
    channels: nativeProjectChannels(venueProfile),
    projectId: nativeDraftProjectId(context.fingerprint),
    positionCount,
    countsMatch,
    sources
  };
  return {
    review,
    public: {
      available: true,
      exists: false,
      projectId: review.projectId,
      positionCount,
      countsMatch,
      sources: sources.map(source => ({
        roleId: source.roleId,
        roleLabel: source.roleLabel,
        fileName: source.fileName,
        slideCount: source.slideCount
      })),
      reason: null
    }
  };
}

async function inspectCurrentServiceNativeDraftSourceReview() {
  const venueProfile = activeVenueProfile;
  const venueRevisionId =
    preparedServiceVenueRevisionId(venueProfile);
  let manifest;
  try {
    manifest = await readCurrentServiceSet(getServiceSetRoot(), {
      verifyAssets: true
    });
  } catch (error) {
    failCurrentServiceCompanion(error);
  }
  if (!manifest) return null;
  const profileId = venueProfile?.id || 'default';
  if (manifest.profileId !== profileId) {
    failMainOperation(
      'CURRENT_SERVICE_PROFILE_MISMATCH',
      'The loaded PowerPoint service belongs to another venue profile.'
    );
  }
  let fingerprint;
  try {
    fingerprint = serviceSetFingerprint(manifest);
  } catch (error) {
    failCurrentServiceCompanion(error);
  }
  const result = currentServiceNativeDraftLoadedReview({
    manifest,
    fingerprint,
    binding: {
      id: manifest.id,
      fingerprint,
      serviceDate: manifest.serviceDate,
      profileId: manifest.profileId
    }
  }, venueProfile);
  if (preparedServiceVenueRevisionId(activeVenueProfile)
    !== venueRevisionId) {
    failMainOperation(
      'CURRENT_SERVICE_NATIVE_DRAFT_CHANGED',
      'The venue profile changed while the PowerPoint native draft was being checked.'
    );
  }
  return result.review;
}

function currentServiceNativeDraftInspection(context) {
  if (context.nativeExisting) {
    return {
      review: {
        mode: 'existing',
        binding: { ...context.binding },
        venueRevisionId:
          preparedServiceVenueRevisionId(activeVenueProfile),
        projectId: context.nativeExisting.project.id,
        revisionId: context.nativeExisting.revisionId
      },
      public: {
        available: true,
        exists: true,
        projectId: context.nativeExisting.project.id,
        positionCount:
          context.nativeExisting.project.rootItemIds?.length || null,
        countsMatch: null,
        sources: context.summary.sources.map(source => ({
          ...source,
          slideCount: null
        })),
        reason: null
      }
    };
  }
  return currentServiceNativeDraftLoadedReview(context);
}

function sameCurrentServiceNativeDraftReview(left, right) {
  if (!left || !right
    || left.mode !== right.mode
    || !sameCurrentServiceCompanionBinding(left.binding, right.binding)
    || left.projectId !== right.projectId) {
    return false;
  }
  if (left.mode === 'existing') {
    return left.revisionId === right.revisionId
      && left.venueRevisionId === right.venueRevisionId;
  }
  return left.presentationRevision === right.presentationRevision
    && left.venueRevisionId === right.venueRevisionId
    && JSON.stringify(left.channels) === JSON.stringify(right.channels)
    && left.positionCount === right.positionCount
    && left.countsMatch === right.countsMatch
    && JSON.stringify(left.sources.map(source => ({
      roleId: source.roleId,
      channelId: source.channelId,
      fileName: source.fileName,
      assetId: source.assetId,
      sha256: source.sha256,
      size: source.size,
      slideCount: source.slideCount,
      slideMetadataRevisionId: source.slideMetadataRevisionId,
      pdfRendererRevisionId: source.pdfRendererRevisionId
    }))) === JSON.stringify(right.sources.map(source => ({
      roleId: source.roleId,
      channelId: source.channelId,
      fileName: source.fileName,
      assetId: source.assetId,
      sha256: source.sha256,
      size: source.size,
      slideCount: source.slideCount,
      slideMetadataRevisionId: source.slideMetadataRevisionId,
      pdfRendererRevisionId: source.pdfRendererRevisionId
    })));
}

async function inspectCurrentServiceNativeDraftImages(review) {
  if (review?.mode !== 'create'
    || !Number.isSafeInteger(review.presentationRevision)
    || review.presentationRevision !== presentationRevision) {
    failMainOperation(
      'CURRENT_SERVICE_NATIVE_DRAFT_CHANGED',
      'The loaded PowerPoint service changed after review. Refresh Prepare and review it again.'
    );
  }
  const sharp = require('sharp');
  const converter = new Converter();
  const domainSources = [];
  const externalByAssetId = new Map();
  for (const source of review.sources) {
    const sourceRoot = path.resolve(source.cacheDir);
    const expectedRoot = path.resolve(
      path.join(CONFIG.cacheDir, source.roleId)
    );
    if (sourceRoot !== expectedRoot) {
      failMainOperation(
        'CURRENT_SERVICE_NATIVE_DRAFT_RENDER_UNAVAILABLE',
        `Reload ${source.roleLabel} before creating the native draft.`
      );
    }
    let rootStats;
    let realRoot;
    let realExpectedRoot;
    let generationMetadata;
    try {
      rootStats = await fs.promises.lstat(sourceRoot);
      realRoot = await fs.promises.realpath(sourceRoot);
      realExpectedRoot = await fs.promises.realpath(expectedRoot);
      if (realRoot !== realExpectedRoot
        || !rootStats.isDirectory()
        || rootStats.isSymbolicLink()) {
        throw new Error('Unsafe conversion cache root.');
      }
      const metadataStats = await fs.promises.lstat(
        path.join(sourceRoot, 'metadata.json')
      );
      if (!metadataStats.isFile() || metadataStats.isSymbolicLink()) {
        throw new Error('Unsafe conversion metadata.');
      }
      generationMetadata = await converter.validateGeneration(
        sourceRoot,
        source.slideCount
      );
      const rootAfter = await fs.promises.lstat(sourceRoot);
      const realRootAfter = await fs.promises.realpath(sourceRoot);
      if (!statIdentityMatches(rootStats, rootAfter)
        || rootAfter.isSymbolicLink()
        || realRootAfter !== realRoot) {
        throw new Error('Conversion cache root changed during validation.');
      }
    } catch (_error) {
      failMainOperation(
        'CURRENT_SERVICE_NATIVE_DRAFT_RENDER_UNAVAILABLE',
        `Reload ${source.roleLabel} before creating the native draft.`
      );
    }
    let generationContext;
    try {
      generationContext = normalizeCacheRestoreContext(
        generationMetadata.restoreContext,
        { allowNull: false }
      );
    } catch (_error) {
      generationContext = null;
    }
    if (!generationContext
      || generationContext.sourceKind !== 'service-set'
      || generationContext.serviceSetId !== review.binding.id
      || generationContext.roleId !== source.roleId
      || generationContext.assetId !== source.assetId
      || sha256Json(generationMetadata.slides || [])
        !== source.slideMetadataRevisionId
      || sha256Json(generationMetadata.pdfRenderer || null)
        !== source.pdfRendererRevisionId) {
      failMainOperation(
        'CURRENT_SERVICE_NATIVE_DRAFT_RENDER_CHANGED',
        `${source.roleLabel} no longer matches the reviewed conversion generation. Reload the service first.`
      );
    }
    const slides = [];
    for (let index = 0; index < source.slideCount; index += 1) {
      const fileName =
        `slide_${String(index + 1).padStart(3, '0')}.jpg`;
      const filePath = path.join(sourceRoot, fileName);
      let sha256;
      let metadata;
      let verifiedImage;
      try {
        verifiedImage = await readFileNoFollow(
          filePath,
          MAX_IMAGE_BYTES
        );
        if (verifiedImage.stats.size < 1
          || path.dirname(verifiedImage.realPath) !== realRoot
          || path.basename(verifiedImage.realPath) !== fileName) {
          throw new Error('Rendered image escaped its conversion generation.');
        }
        sha256 = crypto.createHash('sha256')
          .update(verifiedImage.buffer)
          .digest('hex');
        metadata = await sharp(verifiedImage.buffer, {
          animated: true,
          failOn: 'warning',
          limitInputPixels: 64 * 1000 * 1000
        }).metadata();
      } catch (_error) {
        failMainOperation(
          'CURRENT_SERVICE_NATIVE_DRAFT_RENDER_CHANGED',
          `${source.roleLabel} slide ${index + 1} could not be verified. Reload the service first.`
        );
      }
      if (metadata.format !== 'jpeg'
        || !Number.isSafeInteger(metadata.width)
        || !Number.isSafeInteger(metadata.height)
        || metadata.width < 1
        || metadata.height < 1
        || metadata.width * metadata.height > 64 * 1000 * 1000
        || (metadata.pages !== undefined && metadata.pages !== 1)) {
        failMainOperation(
          'CURRENT_SERVICE_NATIVE_DRAFT_RENDER_CHANGED',
          `${source.roleLabel} slide ${index + 1} changed during verification. Reload the service first.`
        );
      }
      const image = {
        assetId: `sha256:${sha256}`,
        sha256,
        size: verifiedImage.stats.size,
        width: metadata.width,
        height: metadata.height,
        orientation: Number.isSafeInteger(metadata.orientation)
          ? metadata.orientation
          : 1
      };
      slides.push(image);
      if (!externalByAssetId.has(image.assetId)) {
        externalByAssetId.set(image.assetId, {
          assetId: image.assetId,
          sourcePath: filePath,
          sourceRoot
        });
      }
    }
    domainSources.push({
      roleId: source.roleId,
      roleLabel: source.roleLabel,
      channelId: source.channelId,
      fileName: source.fileName,
      slides
    });
  }
  if (review.presentationRevision !== presentationRevision) {
    failMainOperation(
      'CURRENT_SERVICE_NATIVE_DRAFT_CHANGED',
      'The loaded PowerPoint service changed during review. Refresh Prepare and review it again.'
    );
  }
  return {
    domainSources,
    externalSources: [...externalByAssetId.values()]
  };
}

function pruneCurrentServiceNativeDraftReviews(
  now = Date.now(),
  { makeRoom = false } = {}
) {
  for (const [token, entry] of currentServiceNativeDraftReviews) {
    if (entry.expiresAt <= now && entry.applying !== true) {
      currentServiceNativeDraftReviews.delete(token);
    }
  }
  if (!makeRoom) return;
  while (
    currentServiceNativeDraftReviews.size
    >= CURRENT_SERVICE_NATIVE_DRAFT_REVIEW_LIMIT
  ) {
    const removable = [...currentServiceNativeDraftReviews.entries()]
      .find(([, entry]) => entry.applying !== true);
    if (!removable) {
      failMainOperation(
        'CURRENT_SERVICE_NATIVE_DRAFT_BUSY',
        'Another PowerPoint native draft is still being created. Wait for it to finish.'
      );
    }
    currentServiceNativeDraftReviews.delete(removable[0]);
  }
}

function holdCurrentServiceNativeDraftReview(review, summary) {
  const createdAt = Date.now();
  pruneCurrentServiceNativeDraftReviews(createdAt, { makeRoom: true });
  const reviewToken = crypto.randomBytes(24).toString('base64url');
  const expiresAt =
    createdAt + CURRENT_SERVICE_NATIVE_DRAFT_REVIEW_TTL_MS;
  currentServiceNativeDraftReviews.set(reviewToken, {
    review,
    summary,
    createdAt,
    expiresAt,
    applying: false,
    result: null
  });
  return {
    reviewToken,
    expiresAt: new Date(expiresAt).toISOString(),
    ...summary
  };
}

function requireCurrentServiceNativeDraftReview(rawToken) {
  const reviewToken = typeof rawToken === 'string' ? rawToken : '';
  if (!/^[A-Za-z0-9_-]{32}$/.test(reviewToken)) {
    failMainOperation(
      'INVALID_CURRENT_SERVICE_NATIVE_DRAFT_REVIEW',
      'Review the current PowerPoint service again before creating its native draft.'
    );
  }
  pruneCurrentServiceNativeDraftReviews();
  const entry = currentServiceNativeDraftReviews.get(reviewToken);
  if (!entry || entry.expiresAt <= Date.now()) {
    if (entry?.applying !== true) {
      currentServiceNativeDraftReviews.delete(reviewToken);
    }
    failMainOperation(
      'EXPIRED_CURRENT_SERVICE_NATIVE_DRAFT_REVIEW',
      'That PowerPoint native-draft review expired. Review the current service again.'
    );
  }
  return { reviewToken, entry };
}

function pruneCurrentServiceSongRangeEntries(
  entries,
  limit,
  now = Date.now(),
  { makeRoom = false } = {}
) {
  for (const [token, entry] of entries) {
    if (entry.expiresAt <= now && entry.applying !== true) {
      entries.delete(token);
    }
  }
  if (!makeRoom) return;
  while (entries.size >= limit) {
    const removable = [...entries.entries()]
      .find(([, entry]) => entry.applying !== true);
    if (!removable) {
      failMainOperation(
        'CURRENT_SERVICE_SONG_RANGE_BUSY',
        'Another reviewed song range is still being applied. Wait for it to finish.'
      );
    }
    entries.delete(removable[0]);
  }
}

function holdCurrentServiceSongRangeReview(entry, publicReview) {
  const createdAt = Date.now();
  pruneCurrentServiceSongRangeEntries(
    currentServiceSongRangeReviews,
    CURRENT_SERVICE_SONG_RANGE_REVIEW_LIMIT,
    createdAt,
    { makeRoom: true }
  );
  const reviewToken = crypto.randomBytes(24).toString('base64url');
  const expiresAt =
    createdAt + CURRENT_SERVICE_SONG_RANGE_REVIEW_TTL_MS;
  currentServiceSongRangeReviews.set(reviewToken, {
    ...entry,
    createdAt,
    expiresAt,
    applying: false
  });
  return {
    reviewToken,
    expiresAt: new Date(expiresAt).toISOString(),
    ...publicReview
  };
}

function holdCurrentServiceSongRangeProposal(entry, publicProposal) {
  const createdAt = Date.now();
  pruneCurrentServiceSongRangeEntries(
    currentServiceSongRangeProposals,
    CURRENT_SERVICE_SONG_RANGE_PROPOSAL_LIMIT,
    createdAt,
    { makeRoom: true }
  );
  const proposalToken = crypto.randomBytes(24).toString('base64url');
  const expiresAt =
    createdAt + CURRENT_SERVICE_SONG_RANGE_PROPOSAL_TTL_MS;
  currentServiceSongRangeProposals.set(proposalToken, {
    ...entry,
    createdAt,
    expiresAt,
    applying: false,
    result: null
  });
  return {
    proposalToken,
    expiresAt: new Date(expiresAt).toISOString(),
    ...publicProposal
  };
}

function requireCurrentServiceSongRangeToken(
  entries,
  limit,
  rawToken,
  kind
) {
  const token = typeof rawToken === 'string' ? rawToken : '';
  if (!/^[A-Za-z0-9_-]{32}$/.test(token)) {
    failMainOperation(
      `INVALID_CURRENT_SERVICE_SONG_RANGE_${kind}`,
      'Review the exact PowerPoint song range again.'
    );
  }
  pruneCurrentServiceSongRangeEntries(entries, limit);
  const entry = entries.get(token);
  if (!entry || (entry.expiresAt <= Date.now() && entry.applying !== true)) {
    if (entry?.applying !== true) entries.delete(token);
    failMainOperation(
      `EXPIRED_CURRENT_SERVICE_SONG_RANGE_${kind}`,
      'That PowerPoint song-range review expired. Review it again.'
    );
  }
  return { token, entry };
}

function exactProjectItemPlacement(project, itemId) {
  const matches = [];
  const rootIndex = project.rootItemIds.indexOf(itemId);
  if (rootIndex >= 0) {
    matches.push({
      parentId: null,
      index: rootIndex,
      siblings: project.rootItemIds
    });
  }
  for (const item of Object.values(project.items || {})) {
    if (item.kind !== 'group') continue;
    const index = item.childIds.indexOf(itemId);
    if (index >= 0) {
      matches.push({
        parentId: item.id,
        index,
        siblings: item.childIds
      });
    }
  }
  if (matches.length !== 1) {
    failMainOperation(
      'CURRENT_SERVICE_SONG_RANGE_MOVED',
      'The selected PowerPoint picture no longer has one exact rundown position.'
    );
  }
  return matches[0];
}

function sameSongRangeReviewEvidence(left, right) {
  return Boolean(
    left
    && right
    && left.snapshot?.snapshotHash === right.snapshot?.snapshotHash
    && left.receipt?.receiptHash === right.receipt?.receiptHash
    && left.receipt?.familyRevision === right.receipt?.familyRevision
  );
}

async function inspectReviewedCurrentServiceSongRange(
  current,
  { selectedItemId, songId, songRevisionId }
) {
  const project = current.project;
  const binding = project.sourceServiceSet;
  const selected = project.items[selectedItemId];
  if (
    !binding
    || isPowerPointCompanionProject(project)
    || selected?.kind !== 'picture'
    || selected.sourceVisualReview?.schemaVersion !== 1
    || selected.sourceVisualReview.kind !== 'powerpoint-render'
    || selected.sourceVisualReview.serviceSetId !== binding.id
    || selected.sourceVisualReview.serviceSetFingerprint
      !== binding.fingerprint
  ) {
    failMainOperation(
      'CURRENT_SERVICE_SONG_RANGE_SOURCE_REQUIRED',
      'Choose an untouched picture in a reviewed PowerPoint native draft.'
    );
  }

  await recoverLocalSongFamilyCommit();
  const anchorSong = await current.services.localSongLibrary.read(songId, {
    revision: songRevisionId
  });
  let evidence;
  try {
    evidence = await current.services.localSongFamilyReviewStore
      .findByMemberRevisionForServiceSet({
        songId,
        revision: songRevisionId,
        binding: {
          id: binding.id,
          fingerprint: binding.fingerprint,
          serviceDate: binding.serviceDate,
          profileId: binding.profileId
        }
      });
  } catch (error) {
    failMainOperation(
      error?.code || 'CURRENT_SERVICE_SONG_RANGE_REVIEW_UNAVAILABLE',
      error?.message
        || 'The exact saved song-family review could not be validated.'
    );
  }
  if (
    !evidence
    || evidence.reviewStatus?.reviewed !== true
    || evidence.reviewStatus.skippedCorruptReceipts !== 0
  ) {
    failMainOperation(
      'CURRENT_SERVICE_SONG_RANGE_REVIEW_REQUIRED',
      'Capture and save this exact song family from the current PowerPoint service before replacing its pictures.'
    );
  }

  const receipt = evidence.receipt;
  if (
    receipt.serviceSet.id !== binding.id
    || receipt.serviceSet.fingerprint !== binding.fingerprint
    || receipt.serviceSet.serviceDate !== binding.serviceDate
    || receipt.serviceSet.profileId !== binding.profileId
  ) {
    failMainOperation(
      'CURRENT_SERVICE_SONG_RANGE_SERVICE_CHANGED',
      'The song-family review belongs to a different PowerPoint service.'
    );
  }
  if (receipt.occurrences.some(occurrence => occurrence.action === 'exclude')) {
    failMainOperation(
      'CURRENT_SERVICE_SONG_RANGE_EXCLUSIONS_UNSUPPORTED',
      'This first replacement workflow requires every reviewed lyric occurrence to remain in the service. Keep this range as pictures or capture it again without excluded slides.'
    );
  }

  const resultBySongId = new Map(
    receipt.results.map(result => [result.songId, result])
  );
  const rootResult = resultBySongId.get(receipt.rootSongId);
  if (!rootResult || rootResult.captures.length !== 1) {
    failMainOperation(
      'CURRENT_SERVICE_SONG_RANGE_ROOT_CAPTURE_REQUIRED',
      'The reviewed original song needs one exact PowerPoint capture for this replacement.'
    );
  }
  const capturedResults = receipt.results.filter(result =>
    result.captures.length > 0);
  if (
    capturedResults.length < 1
    || capturedResults.some(result =>
      result.captures.length !== 1
      || result.captures[0].selectionOrigin !== 'template-local'
      || !Number.isSafeInteger(result.captures[0].titleSlide)
      || result.captures[0].slides.length !== receipt.occurrences.length)
  ) {
    failMainOperation(
      'CURRENT_SERVICE_SONG_RANGE_TEMPLATE_CAPTURE_REQUIRED',
      'Each projected song language needs one template-local capture with a reviewed title slide and every lyric occurrence.'
    );
  }

  const positionsForCapture = capture => [
    capture.titleSlide,
    ...capture.slides.map(slide => slide.number)
  ];
  const positions = positionsForCapture(rootResult.captures[0]);
  if (
    positions.some((position, index) =>
      !Number.isSafeInteger(position)
      || position < 1
      || (index > 0 && position !== positions[index - 1] + 1))
    || capturedResults.some(result =>
      JSON.stringify(positionsForCapture(result.captures[0]))
        !== JSON.stringify(positions))
  ) {
    failMainOperation(
      'CURRENT_SERVICE_SONG_RANGE_NOT_ALIGNED',
      'The reviewed language decks do not use the same contiguous title-and-lyrics positions. Keep this range as exact pictures.'
    );
  }

  const directByChannel = new Map();
  for (const result of capturedResults) {
    const capture = result.captures[0];
    if (
      !project.channels[capture.roleId]
      || directByChannel.has(capture.roleId)
    ) {
      failMainOperation(
        'CURRENT_SERVICE_SONG_RANGE_CHANNEL_MISMATCH',
        'The captured song languages do not map one-to-one to this draft’s outputs.'
      );
    }
    directByChannel.set(capture.roleId, result);
  }

  const memberReads = [];
  for (const result of receipt.results) {
    let read;
    try {
      read = await current.services.localSongLibrary.read(result.songId, {
        revision: result.resultingRevision
      });
    } catch (_error) {
      failMainOperation(
        'CURRENT_SERVICE_SONG_RANGE_MEMBER_UNAVAILABLE',
        'One exact reviewed song-family revision is no longer available locally.'
      );
    }
    if (
      read.revision !== result.resultingRevision
      || read.song.id !== result.songId
    ) {
      failMainOperation(
        'CURRENT_SERVICE_SONG_RANGE_MEMBER_CHANGED',
        'One exact reviewed song-family revision changed after review.'
      );
    }
    memberReads.push({
      song: read.song,
      revision: read.revision,
      summary: read.summary
    });
  }
  if (
    anchorSong.revision !== songRevisionId
    || !resultBySongId.has(anchorSong.song.id)
  ) {
    failMainOperation(
      'CURRENT_SERVICE_SONG_RANGE_MEMBER_CHANGED',
      'The selected Song Library revision is not part of this exact reviewed family.'
    );
  }

  const sourceItems = [];
  const placements = [];
  let renderRevisionId = null;
  for (const position of positions) {
    const matches = Object.values(project.items).filter(item =>
      item.kind === 'picture'
      && item.sourceVisualReview?.position === position
      && item.sourceVisualReview.serviceSetId === binding.id
      && item.sourceVisualReview.serviceSetFingerprint === binding.fingerprint);
    if (matches.length !== 1) {
      failMainOperation(
        'CURRENT_SERVICE_SONG_RANGE_SOURCE_CHANGED',
        'One reviewed PowerPoint position was edited, duplicated, or already replaced.'
      );
    }
    const source = matches[0];
    if (
      renderRevisionId !== null
      && source.sourceVisualReview.renderRevisionId !== renderRevisionId
    ) {
      failMainOperation(
        'CURRENT_SERVICE_SONG_RANGE_RENDER_CHANGED',
        'The selected PowerPoint pictures do not come from one exact render revision.'
      );
    }
    renderRevisionId = source.sourceVisualReview.renderRevisionId;
    sourceItems.push(source);
    placements.push(exactProjectItemPlacement(project, source.id));
  }
  if (!sourceItems.some(item => item.id === selectedItemId)) {
    failMainOperation(
      'CURRENT_SERVICE_SONG_RANGE_ANCHOR_MISMATCH',
      'The selected picture is not inside this reviewed song range.'
    );
  }
  const firstPlacement = placements[0];
  if (placements.some((placement, index) =>
    placement.parentId !== firstPlacement.parentId
    || placement.siblings !== firstPlacement.siblings
    || placement.index !== firstPlacement.index + index)) {
    failMainOperation(
      'CURRENT_SERVICE_SONG_RANGE_MOVED',
      'The reviewed PowerPoint pictures are no longer one contiguous rundown range.'
    );
  }

  const channels = project.channelIds.map(channelId => {
    const captured = directByChannel.get(channelId);
    if (captured) {
      const read = memberReads.find(member =>
        member.song.id === captured.songId);
      return {
        channelId,
        label: project.channels[channelId].label,
        captured: true,
        locked: true,
        selectedMapping: {
          mode: 'content',
          songId: captured.songId,
          revision: captured.resultingRevision
        },
        options: [{
          mode: 'content',
          songId: captured.songId,
          revision: captured.resultingRevision,
          fromChannelId: null,
          label: `${read.song.title}${read.song.language ? ` · ${read.song.language}` : ''} · exact captured revision`
        }]
      };
    }
    const options = [...directByChannel.entries()].flatMap(
      ([sourceChannelId, result]) => {
        const sourceLabel =
          project.channels[sourceChannelId]?.label || sourceChannelId;
        return [
          {
            mode: 'inherit',
            songId: null,
            revision: null,
            fromChannelId: sourceChannelId,
            label: `Full lyrics from ${sourceLabel}`
          },
          {
            mode: 'derive',
            songId: null,
            revision: null,
            fromChannelId: sourceChannelId,
            label: `Next-line view from ${sourceLabel}`
          }
        ];
      }
    );
    return {
      channelId,
      label: project.channels[channelId].label,
      captured: false,
      locked: false,
      selectedMapping: null,
      options
    };
  });
  if (channels.some(channel => channel.options.length < 1)) {
    failMainOperation(
      'CURRENT_SERVICE_SONG_RANGE_CHANNEL_UNMAPPED',
      'Every output needs an explicit reviewed song mapping.'
    );
  }

  return {
    evidence,
    memberReads,
    range: {
      firstPosition: positions[0],
      lastPosition: positions.at(-1),
      positionCount: positions.length,
      positions,
      sourceItemIds: sourceItems.map(item => item.id),
      parentId: firstPlacement.parentId,
      startIndex: firstPlacement.index,
      renderRevisionId
    },
    channels,
    song: {
      id: anchorSong.song.id,
      revision: anchorSong.revision,
      title: anchorSong.song.title,
      rootSongId: receipt.rootSongId,
      familyRevision: receipt.familyRevision
    }
  };
}

function currentServiceNativeDraftReviewSummary(context, review) {
  return {
    action: review.mode === 'existing' ? 'open-existing' : 'create',
    serviceSet: {
      name: context.summary.serviceSet.name,
      serviceDate: context.summary.serviceSet.serviceDate,
      profileName: context.summary.serviceSet.profileName
    },
    projectId: review.projectId,
    positionCount: review.positionCount || null,
    countsMatch: review.mode === 'create' ? review.countsMatch === true : null,
    sources: review.mode === 'create'
      ? review.sources.map(source => ({
          roleId: source.roleId,
          roleLabel: source.roleLabel,
          fileName: source.fileName,
          slideCount: source.slideCount
        }))
      : context.summary.sources.map(source => ({
          ...source,
          slideCount: null
        }))
  };
}

function currentServiceCompanionSummary(manifest, existing = null) {
  const roleLabels = new Map(
    (activeVenueProfile?.inputRoles || []).map(role => [role.id, role.label])
  );
  const sources = Object.values(manifest.inputs || {})
    .sort((left, right) => left.roleId.localeCompare(right.roleId, 'en'))
    .map(input => {
      const sourceName = prepareText(
        input.sourceName,
        'Current service file name',
        255,
        { required: true }
      );
      if (
        sourceName !== path.basename(sourceName)
        || sourceName.includes('/')
        || sourceName.includes('\\')
      ) {
        failMainOperation(
          'INVALID_CURRENT_SERVICE_FILE',
          'One current PowerPoint presentation has an invalid file name.'
        );
      }
      return {
        roleId: prepareId(input.roleId, 'Current service role'),
        roleLabel: prepareText(
          roleLabels.get(input.roleId) || input.roleId,
          'Current service role label',
          120,
          { required: true }
        ),
        fileName: sourceName
      };
    });
  if (sources.length < 1 || sources.length > 32) {
    failMainOperation(
      'INVALID_CURRENT_SERVICE_FILES',
      'The current PowerPoint service must contain between one and 32 presentations.'
    );
  }
  return {
    available: true,
    serviceSet: {
      name: prepareText(
        manifest.name || `Service ${manifest.serviceDate}`,
        'Current service name',
        300,
        { required: true }
      ),
      serviceDate: manifest.serviceDate,
      profileName: prepareText(
        activeVenueProfile?.name || 'Current venue',
        'Venue profile name',
        200,
        { required: true }
      )
    },
    sources,
    exists: Boolean(existing),
    projectId: existing?.project?.id || null
  };
}

function inspectedCurrentServiceCompanionSummary(context, existing = null) {
  const nativeDraft = currentServiceNativeDraftInspection(context);
  return {
    ...currentServiceCompanionSummary(context.manifest, existing),
    nativeDraft: nativeDraft.public,
    ...holdCurrentServiceCompanionInspection(context.binding, {
      nativeDraftReview: nativeDraft.review
    })
  };
}

function currentServiceCompanionAnchor(project, fingerprint) {
  const expectedId = currentServiceCompanionAnchorId(fingerprint);
  const expected = project.items?.[expectedId];
  if (expected?.kind === 'group' && expected.groupKind === 'sermon') {
    return expected.id;
  }
  const candidates = Object.values(project.items || {}).filter(item =>
    item.kind === 'group' && item.groupKind === 'sermon');
  if (candidates.length !== 1) {
    failMainOperation(
      'CURRENT_SERVICE_COMPANION_INVALID',
      'The saved PowerPoint sermon handoff has no unique sermon anchor.'
    );
  }
  return candidates[0].id;
}

async function inspectCurrentServiceCompanionContext() {
  let manifest;
  try {
    manifest = await readCurrentServiceSet(getServiceSetRoot(), {
      verifyAssets: true
    });
  } catch (error) {
    failCurrentServiceCompanion(error);
  }
  if (!manifest) return null;
  const profileId = activeVenueProfile?.id || 'default';
  if (manifest.profileId !== profileId) {
    failMainOperation(
      'CURRENT_SERVICE_PROFILE_MISMATCH',
      'The loaded PowerPoint service belongs to another venue profile.'
    );
  }
  let fingerprint;
  try {
    fingerprint = serviceSetFingerprint(manifest);
  } catch (error) {
    failCurrentServiceCompanion(error);
  }
  const binding = {
    id: manifest.id,
    fingerprint,
    serviceDate: manifest.serviceDate,
    profileId: manifest.profileId
  };
  const services = getPrepareServices();
  const matches = await services.serviceProjectStore.findByServiceSetBinding(
    binding,
    {
      limit: 2,
      workflowMode: POWERPOINT_COMPANION_WORKFLOW_MODE
    }
  );
  if (matches.length > 1) {
    failMainOperation(
      'DUPLICATE_CURRENT_SERVICE_COMPANIONS',
      'More than one sermon handoff is bound to this exact PowerPoint service. Review the saved projects before continuing.'
    );
  }
  const existing = matches[0] || null;
  if (existing?.recovery) {
    failMainOperation(
      'CURRENT_SERVICE_COMPANION_RECOVERY_REQUIRED',
      'The saved PowerPoint sermon handoff needs explicit project recovery before it can be reused.'
    );
  }
  if (existing && !isPowerPointCompanionProject(existing.project)) {
    failMainOperation(
      'CURRENT_SERVICE_COMPANION_INVALID',
      'The saved PowerPoint sermon handoff is invalid.'
    );
  }
  const deterministicNativeDraftId =
    nativeDraftProjectId(fingerprint);
  let nativeExisting = null;
  try {
    const deterministic = await services.serviceProjectStore.read(
      deterministicNativeDraftId
    );
    if (deterministic.recovery) {
      failMainOperation(
        'CURRENT_SERVICE_NATIVE_DRAFT_RECOVERY_REQUIRED',
        'The saved native draft needs explicit project recovery before it can be reused.'
      );
    }
    if (isPowerPointCompanionProject(deterministic.project)
      || !sameCurrentServiceCompanionBinding(
        deterministic.project.sourceServiceSet,
        binding
      )) {
      failMainOperation(
        'CURRENT_SERVICE_NATIVE_DRAFT_ID_CONFLICT',
        'The reserved native-draft identity belongs to a different saved project.'
      );
    }
    if (!currentServiceNativeDraftMatchesVenue(
      deterministic.project,
      activeVenueProfile
    )) {
      failMainOperation(
        'CURRENT_SERVICE_NATIVE_DRAFT_VENUE_MISMATCH',
        'The saved native draft uses an earlier venue channel layout. Restore that layout or review the saved project explicitly before using it.'
      );
    }
    nativeExisting = deterministic;
  } catch (error) {
    if (error?.code === 'PROJECT_NOT_FOUND') {
      // No deterministic target exists yet.
    } else if (
      error?.code === 'CURRENT_SERVICE_NATIVE_DRAFT_RECOVERY_REQUIRED'
      || error?.code === 'CURRENT_SERVICE_NATIVE_DRAFT_ID_CONFLICT'
      || error?.code === 'CURRENT_SERVICE_NATIVE_DRAFT_VENUE_MISMATCH'
    ) {
      throw error;
    } else {
      failMainOperation(
        'CURRENT_SERVICE_NATIVE_DRAFT_RECOVERY_REQUIRED',
        'The saved native-draft identity contains unreadable project data. Recover or remove it explicitly before creating another draft.'
      );
    }
  }
  return {
    services,
    manifest,
    fingerprint,
    binding,
    existing,
    nativeExisting,
    summary: currentServiceCompanionSummary(manifest, existing)
  };
}

function currentServiceCompanionResult(context, saved) {
  return {
    ...projectResult(saved),
    anchorItemId: currentServiceCompanionAnchor(
      saved.project,
      context.fingerprint
    ),
    companion: inspectedCurrentServiceCompanionSummary(context, saved)
  };
}

function exactCurrentServiceSetClaim(context) {
  return normalizeServiceSetClaim({
    ...context.binding,
    roles: Object.values(context.manifest.inputs || {}).map(input => ({
      roleId: input.roleId,
      assetId: input.assetId
    }))
  });
}

function prunePlanLinkedPowerPointHandoffs(
  now = Date.now(),
  { makeRoom = false } = {}
) {
  for (const [token, entry] of planLinkedPowerPointHandoffs) {
    if (entry.expiresAt <= now) {
      planLinkedPowerPointHandoffs.delete(token);
    }
  }
  if (!makeRoom) return;
  while (
    planLinkedPowerPointHandoffs.size
    >= PLAN_LINKED_POWERPOINT_HANDOFF_LIMIT
  ) {
    planLinkedPowerPointHandoffs.delete(
      planLinkedPowerPointHandoffs.keys().next().value
    );
  }
}

function holdPlanLinkedPowerPointHandoff(handoff, target, summary, action) {
  const createdAt = Date.now();
  prunePlanLinkedPowerPointHandoffs(createdAt, { makeRoom: true });
  const proposalToken = crypto.randomBytes(24).toString('base64url');
  const expiresAt = createdAt + PLAN_LINKED_POWERPOINT_HANDOFF_TTL_MS;
  planLinkedPowerPointHandoffs.set(proposalToken, {
    handoff,
    target,
    createdAt,
    expiresAt,
    consumed: false
  });
  return {
    proposalToken,
    expiresAt: new Date(expiresAt).toISOString(),
    action,
    source: {
      projectTitle: summary.sourceProjectTitle,
      planId: handoff.source.plan.planId,
      planRevision: handoff.source.plan.planRevision
    },
    sermon: {
      id: handoff.sermon.id,
      revisionId: handoff.sermon.revisionId,
      title: handoff.sermon.title,
      speaker: handoff.sermon.speaker
    },
    serviceSet: summary.serviceSet,
    roles: summary.sources.map(source => ({
      roleId: source.roleId,
      roleLabel: source.roleLabel,
      fileName: source.fileName
    }))
  };
}

function requirePlanLinkedPowerPointHandoff(rawToken) {
  const proposalToken = typeof rawToken === 'string' ? rawToken : '';
  if (!/^[A-Za-z0-9_-]{32}$/.test(proposalToken)) {
    failMainOperation(
      'INVALID_PLAN_LINKED_POWERPOINT_HANDOFF',
      'Review the Community sermon and current PowerPoint service again.'
    );
  }
  prunePlanLinkedPowerPointHandoffs();
  const entry = planLinkedPowerPointHandoffs.get(proposalToken);
  if (!entry || entry.expiresAt <= Date.now()) {
    planLinkedPowerPointHandoffs.delete(proposalToken);
    failMainOperation(
      'EXPIRED_PLAN_LINKED_POWERPOINT_HANDOFF',
      'That reviewed PowerPoint sermon handoff expired. Review it again.'
    );
  }
  if (entry.consumed) {
    failMainOperation(
      'REPLAYED_PLAN_LINKED_POWERPOINT_HANDOFF',
      'That reviewed PowerPoint sermon handoff was already used. Review it again before repeating the action.'
    );
  }
  return { proposalToken, entry };
}

async function readExactPlanLinkedPowerPointSource(handoff) {
  const services = getPrepareServices();
  let current;
  try {
    current = await services.serviceProjectStore.read(
      handoff.source.projectId
    );
  } catch (_error) {
    failMainOperation(
      'PLAN_LINKED_POWERPOINT_SOURCE_CHANGED',
      'The imported Community service is no longer available. Open it and review the handoff again.'
    );
  }
  if (current.recovery || current.revisionId !== handoff.source.projectRevisionId) {
    failMainOperation(
      'PLAN_LINKED_POWERPOINT_SOURCE_CHANGED',
      'The imported Community service changed after review. Reload it before linking the PowerPoint service.'
    );
  }
  let currentHandoff;
  try {
    currentHandoff = derivePlanLinkedPowerPointHandoff({
      sourceProject: current.project,
      sourceProjectRevisionId: current.revisionId,
      sourceItemId: handoff.source.itemId,
      serviceSet: handoff.serviceSet
    });
  } catch (_error) {
    failMainOperation(
      'PLAN_LINKED_POWERPOINT_SOURCE_CHANGED',
      'The Community plan, sermon, or reviewed service binding changed after review.'
    );
  }
  if (!samePlanLinkedPowerPointHandoff(currentHandoff, handoff)) {
    failMainOperation(
      'PLAN_LINKED_POWERPOINT_SOURCE_CHANGED',
      'The Community plan or sermon changed after review.'
    );
  }
  return current;
}

async function inspectExactPlanLinkedPowerPointContext(handoff) {
  const context = await inspectCurrentServiceCompanionContext();
  if (!context
    || !sameServiceSetClaim(
      exactCurrentServiceSetClaim(context),
      handoff.serviceSet
    )) {
    failMainOperation(
      'PLAN_LINKED_POWERPOINT_SERVICE_CHANGED',
      'The current PowerPoint files, venue, or service date changed after review.'
    );
  }
  return context;
}

function planLinkedPowerPointDraft(context, sourceProject, handoff) {
  const projectId = currentServiceCompanionProjectId(context.fingerprint);
  const anchorItemId = currentServiceCompanionAnchorId(context.fingerprint);
  const title = context.summary.serviceSet.name.length <= 200
    ? context.summary.serviceSet.name
    : `PowerPoint service ${context.manifest.serviceDate}`;
  let project = createServiceProject({
    id: projectId,
    title,
    serviceDate: context.manifest.serviceDate,
    profileId: context.manifest.profileId,
    channels: nativeProjectChannels()
  });
  project = addGroupItem(project, {
    id: anchorItemId,
    title: 'Sermon',
    groupKind: 'sermon'
  });
  project = bindProjectAsPowerPointCompanion(project, context.binding);
  return {
    anchorItemId,
    applied: applyPlanLinkedPowerPointHandoff({
      companionProject: project,
      anchorItemId,
      sourceProject,
      handoff
    })
  };
}

async function savePlanLinkedPowerPointHandoff(context, source, handoff) {
  const revalidateBeforePointerWrite = async () => {
    await readExactPlanLinkedPowerPointSource(handoff);
    await inspectExactPlanLinkedPowerPointContext(handoff);
  };
  if (context.existing) {
    const anchorItemId = currentServiceCompanionAnchor(
      context.existing.project,
      context.fingerprint
    );
    const applied = applyPlanLinkedPowerPointHandoff({
      companionProject: context.existing.project,
      anchorItemId,
      sourceProject: source.project,
      handoff
    });
    if (applied.unchanged) {
      return {
        anchorItemId,
        saved: context.existing,
        applied
      };
    }
    const saved = await context.services.serviceProjectStore.save(
      applied.project,
      {
        expectedRevisionId: context.existing.revisionId,
        reason: 'community-plan-pptx-link',
        beforePointerWrite: revalidateBeforePointerWrite,
        rollbackCreatedRevisionOnPointerFailure: true
      }
    );
    return { anchorItemId, saved, applied };
  }

  const draft = planLinkedPowerPointDraft(
    context,
    source.project,
    handoff
  );
  const saved = await context.services.serviceProjectStore.save(
    draft.applied.project,
    {
      expectedRevisionId: null,
      reason: 'community-plan-pptx-link',
      beforePointerWrite: revalidateBeforePointerWrite,
      rollbackCreatedRevisionOnPointerFailure: true
    }
  );
  return {
    anchorItemId: draft.anchorItemId,
    saved,
    applied: draft.applied
  };
}

ipcMain.handle(
  'prepare:projects:inspectCurrentServiceCompanion',
  async (event, request = {}) => currentServiceCompanionIpcResult(async () => {
    requireControlSender(event);
    requirePrepareRequest(request, 1024);
    requireExactPrepareKeys(request, [], 'Current PowerPoint service review');
    const context = await inspectCurrentServiceCompanionContext();
    return context
      ? inspectedCurrentServiceCompanionSummary(context, context.existing)
      : { available: false };
  })
);

ipcMain.handle(
  'prepare:projects:reviewCurrentServiceNativeDraft',
  async (event, request = {}) => currentServiceCompanionIpcResult(async () => {
    requireControlSender(event);
    requirePrepareRequest(request, 1024);
    requireExactPrepareKeys(
      request,
      ['inspectionToken'],
      'Current PowerPoint native-draft review'
    );
    const { inspection } = requireCurrentServiceCompanionInspection(
      request.inspectionToken
    );
    let context = await inspectCurrentServiceCompanionContext();
    if (!context
      || !sameCurrentServiceCompanionBinding(
        context.binding,
        inspection.binding
      )) {
      failMainOperation(
        'CURRENT_SERVICE_NATIVE_DRAFT_CHANGED',
        'The loaded PowerPoint service changed after this card was shown. Refresh Prepare and review it again.'
      );
    }
    let fresh = currentServiceNativeDraftInspection(context);
    if (!fresh.public.available || !fresh.review) {
      failMainOperation(
        'CURRENT_SERVICE_NATIVE_DRAFT_UNAVAILABLE',
        fresh.public.reason
          || 'This PowerPoint service is not available for a safe native draft.'
      );
    }
    if (!sameCurrentServiceNativeDraftReview(
      inspection.nativeDraftReview,
      fresh.review
    )) {
      failMainOperation(
        'CURRENT_SERVICE_NATIVE_DRAFT_CHANGED',
        'The native-draft inputs changed after this card was shown. Refresh Prepare and review them again.'
      );
    }
    const createdAt = new Date().toISOString();
    if (fresh.review.mode === 'existing') {
      return holdCurrentServiceNativeDraftReview(
        {
          ...fresh.review,
          createdAt
        },
        currentServiceNativeDraftReviewSummary(context, fresh.review)
      );
    }

    const inspectedImages =
      await inspectCurrentServiceNativeDraftImages(fresh.review);
    const renderRevisionId = sha256Json({
      contract: 'syncshow-current-service-native-draft-v1',
      binding: fresh.review.binding,
      venueRevisionId: fresh.review.venueRevisionId,
      sources: inspectedImages.domainSources
    });
    context = await inspectCurrentServiceCompanionContext();
    fresh = context
      ? currentServiceNativeDraftInspection(context)
      : { review: null };
    if (!sameCurrentServiceNativeDraftReview(
      inspection.nativeDraftReview,
      fresh.review
    )) {
      failMainOperation(
        'CURRENT_SERVICE_NATIVE_DRAFT_CHANGED',
        'The loaded PowerPoint service changed during review. Refresh Prepare and review it again.'
      );
    }
    const heldReview = {
      ...fresh.review,
      createdAt,
      renderRevisionId,
      domainSources: inspectedImages.domainSources,
      externalSources: inspectedImages.externalSources
    };
    return holdCurrentServiceNativeDraftReview(
      heldReview,
      {
        ...currentServiceNativeDraftReviewSummary(context, fresh.review),
        renderRevisionId
      }
    );
  })
);

ipcMain.handle(
  'prepare:projects:commitCurrentServiceNativeDraft',
  async (event, request = {}) => currentServiceCompanionIpcResult(async () => {
    requireControlSender(event);
    requirePrepareRequest(request, 1024);
    requireExactPrepareKeys(
      request,
      ['reviewToken', 'confirmed'],
      'Current PowerPoint native-draft confirmation'
    );
    if (request.confirmed !== true) {
      failMainOperation(
        'CURRENT_SERVICE_NATIVE_DRAFT_CONFIRMATION_REQUIRED',
        'Confirm that the original presentations stay untouched and that this draft begins with exact rendered slides.'
      );
    }
    const { entry } = requireCurrentServiceNativeDraftReview(
      request.reviewToken
    );
    if (entry.result) return entry.result;
    if (entry.applying) {
      failMainOperation(
        'CURRENT_SERVICE_NATIVE_DRAFT_BUSY',
        'This reviewed PowerPoint native draft is already being created.'
      );
    }
    entry.applying = true;
    try {
      let context = await inspectCurrentServiceCompanionContext();
      let fresh = context
        ? currentServiceNativeDraftInspection(context)
        : { review: null };
      const reviewedBase = {
        ...entry.review,
        domainSources: undefined,
        externalSources: undefined,
        renderRevisionId: undefined,
        createdAt: undefined
      };
      if (!sameCurrentServiceNativeDraftReview(
        reviewedBase,
        fresh.review
      )) {
        failMainOperation(
          'CURRENT_SERVICE_NATIVE_DRAFT_CHANGED',
          'The loaded PowerPoint service changed after review. Refresh Prepare and review it again.'
        );
      }

      if (entry.review.mode === 'existing') {
        const existing = context.nativeExisting;
        if (!existing
          || existing.project.id !== entry.review.projectId
          || existing.revisionId !== entry.review.revisionId) {
          failMainOperation(
            'CURRENT_SERVICE_NATIVE_DRAFT_CHANGED',
            'The saved native draft changed after review. Refresh Prepare before opening it.'
          );
        }
        entry.result = {
          ...projectResult(existing),
          sourceItemId: existing.project.rootItemIds[0] || null,
          nativeDraft: entry.summary
        };
        return entry.result;
      }

      const inspectedImages =
        await inspectCurrentServiceNativeDraftImages(fresh.review);
      const renderRevisionId = sha256Json({
        contract: 'syncshow-current-service-native-draft-v1',
        binding: fresh.review.binding,
        venueRevisionId: fresh.review.venueRevisionId,
        sources: inspectedImages.domainSources
      });
      if (renderRevisionId !== entry.review.renderRevisionId) {
        failMainOperation(
          'CURRENT_SERVICE_NATIVE_DRAFT_RENDER_CHANGED',
          'The rendered PowerPoint slides changed after review. Reload the service and review the native draft again.'
        );
      }
      const title = context.summary.serviceSet.name.length <= 200
        ? context.summary.serviceSet.name
        : `PowerPoint service ${context.manifest.serviceDate}`;
      const draft = buildCurrentServiceNativeDraft({
        binding: context.binding,
        title,
        channels: entry.review.channels,
        sources: inspectedImages.domainSources,
        createdAt: entry.review.createdAt,
        renderRevisionId
      });
      const revalidateBeforePointerWrite = async () => {
        const latestReview =
          await inspectCurrentServiceNativeDraftSourceReview();
        if (!sameCurrentServiceNativeDraftReview(
          reviewedBase,
          latestReview
        )) {
          failMainOperation(
            'CURRENT_SERVICE_NATIVE_DRAFT_CHANGED',
            'The loaded PowerPoint service changed before the native draft could be saved.'
          );
        }
      };
      let saved;
      try {
        saved = await context.services.serviceProjectStore
          .createWithExternalImageAssets(
            draft.project,
            inspectedImages.externalSources,
            {
              reason: 'powerpoint-native-draft',
              beforePointerWrite: revalidateBeforePointerWrite
            }
          );
      } catch (error) {
        if (error?.code !== 'PROJECT_CONFLICT') throw error;
        failMainOperation(
          'CURRENT_SERVICE_NATIVE_DRAFT_ALREADY_EXISTS',
          'Another reviewed native draft was saved first. Refresh Prepare and open that exact saved project before continuing.'
        );
      }
      entry.result = {
        ...projectResult(saved),
        sourceItemId: draft.sourceItemId,
        nativeDraft: entry.summary
      };
      return entry.result;
    } finally {
      entry.applying = false;
    }
  })
);

ipcMain.handle(
  'prepare:projects:reviewCurrentServiceSongRangeReplacement',
  async (event, request = {}) => currentServiceCompanionIpcResult(async () => {
    requireControlSender(event);
    requirePrepareRequest(request, 16 * 1024);
    requireExactPrepareKeys(request, [
      'projectId',
      'expectedRevisionId',
      'selectedItemId',
      'songId',
      'songRevisionId'
    ], 'Current PowerPoint song-range review');
    const current = await readExpectedProject(request);
    const selectedItemId = prepareId(
      request.selectedItemId,
      'Selected PowerPoint picture'
    );
    const songId = prepareId(request.songId, 'Reviewed song');
    const songRevisionId = prepareRevision(
      request.songRevisionId,
      'Reviewed song revision'
    );
    const inspection = await inspectReviewedCurrentServiceSongRange(
      current,
      { selectedItemId, songId, songRevisionId }
    );
    return holdCurrentServiceSongRangeReview({
      projectId: current.projectId,
      projectRevisionId: current.revisionId,
      selectedItemId,
      songId,
      songRevisionId,
      inspection
    }, {
      song: inspection.song,
      range: {
        firstPosition: inspection.range.firstPosition,
        lastPosition: inspection.range.lastPosition,
        positionCount: inspection.range.positionCount,
        selectedPosition:
          current.project.items[selectedItemId].sourceVisualReview.position
      },
      channels: inspection.channels
    });
  })
);

ipcMain.handle(
  'prepare:projects:inspectPostShowPowerPointService',
  async (event, request = {}) => currentServiceCompanionIpcResult(async () => {
    requireControlSender(event);
    requirePrepareRequest(request, 1024);
    requireExactPrepareKeys(
      request,
      ['receiptToken'],
      'Exact post-show PowerPoint service review'
    );
    const { receiptToken, receipt } =
      requirePostShowPowerPointServiceReceipt(request.receiptToken);
    const context = await inspectCurrentServiceCompanionContext();
    const rebound = context
      ? bindVerifiedPowerPointServiceSet({
          claim: receipt.claim,
          manifest: context.manifest,
          activeProfileId: receipt.profileId,
          fingerprint: context.fingerprint
        })
      : null;
    if (receipt.expiresAt <= Date.now()) {
      postShowPowerPointServiceReceipts.delete(receiptToken);
      failMainOperation(
        'EXPIRED_POST_SHOW_POWERPOINT_RECEIPT',
        'The exact PowerPoint post-service receipt expired. End the intended Show again.'
      );
    }
    if (!rebound
      || !sameCurrentServiceCompanionBinding(rebound, receipt.binding)) {
      postShowPowerPointServiceReceipts.delete(receiptToken);
      failMainOperation(
        'POST_SHOW_POWERPOINT_SERVICE_CHANGED',
        'The verified PowerPoint service changed after the Show ended. End the intended Show again.'
      );
    }
    return inspectedCurrentServiceCompanionSummary(
      context,
      context.existing
    );
  })
);

ipcMain.handle(
  'prepare:projects:openCurrentServiceCompanion',
  async (event, request = {}) => currentServiceCompanionIpcResult(async () => {
    requireControlSender(event);
    requirePrepareRequest(request, 1024);
    requireExactPrepareKeys(
      request,
      ['inspectionToken'],
      'Current PowerPoint sermon handoff'
    );
    const { inspectionToken, inspection } =
      requireCurrentServiceCompanionInspection(request.inspectionToken);
    const requireInspectedContext = context => {
      if (
        !context
        || !sameCurrentServiceCompanionBinding(
          context.binding,
          inspection.binding
        )
      ) {
        currentServiceCompanionInspections.delete(inspectionToken);
        failMainOperation(
          'CURRENT_SERVICE_COMPANION_CHANGED',
          'The loaded PowerPoint service changed after this card was shown. Refresh Prepare and review the current files.'
        );
      }
      return context;
    };
    const complete = (context, saved) => {
      currentServiceCompanionInspections.delete(inspectionToken);
      return currentServiceCompanionResult(context, saved);
    };
    let context = await inspectCurrentServiceCompanionContext();
    context = requireInspectedContext(context);
    if (context.existing) {
      return complete(context, context.existing);
    }

    const projectId = currentServiceCompanionProjectId(context.fingerprint);
    const anchorItemId = currentServiceCompanionAnchorId(context.fingerprint);
    const title = context.summary.serviceSet.name.length <= 200
      ? context.summary.serviceSet.name
      : `PowerPoint service ${context.manifest.serviceDate}`;
    try {
      const created = await context.services.serviceProjectStore.create({
        id: projectId,
        title,
        serviceDate: context.manifest.serviceDate,
        profileId: context.manifest.profileId,
        channels: nativeProjectChannels()
      }, {
        prepareProject(project) {
          const withAnchor = addGroupItem(project, {
            id: anchorItemId,
            title: 'Sermon',
            groupKind: 'sermon'
          });
          return bindProjectAsPowerPointCompanion(
            withAnchor,
            context.binding
          );
        }
      });
      return complete(context, created);
    } catch (error) {
      if (error?.code !== 'PROJECT_CONFLICT') throw error;
      context = requireInspectedContext(
        await inspectCurrentServiceCompanionContext()
      );
      if (context?.existing) {
        return complete(context, context.existing);
      }
      failMainOperation(
        'CURRENT_SERVICE_COMPANION_ID_CONFLICT',
        'A different saved project already uses this PowerPoint service handoff identity.'
      );
    }
  })
);

ipcMain.handle(
  'prepare:projects:proposePlanLinkedPowerPointHandoff',
  async (event, request = {}) => currentServiceCompanionIpcResult(async () => {
    requireControlSender(event);
    requirePrepareRequest(request, 4 * 1024);
    requireExactPrepareKeys(
      request,
      ['projectId', 'expectedRevisionId', 'itemId', 'inspectionToken'],
      'Community-plan PowerPoint sermon review'
    );
    const { inspectionToken, inspection } =
      requireCurrentServiceCompanionInspection(request.inspectionToken);
    const context = await inspectCurrentServiceCompanionContext();
    if (!context
      || !sameCurrentServiceCompanionBinding(
        context.binding,
        inspection.binding
      )) {
      currentServiceCompanionInspections.delete(inspectionToken);
      failMainOperation(
        'CURRENT_SERVICE_COMPANION_CHANGED',
        'The current PowerPoint files changed before the Community sermon could be reviewed.'
      );
    }
    const source = await readExpectedProject({
      projectId: request.projectId,
      expectedRevisionId: request.expectedRevisionId
    });
    if (source.recovery) {
      failMainOperation(
        'PLAN_LINKED_POWERPOINT_SOURCE_RECOVERY_REQUIRED',
        'Save the recovered Community service explicitly before linking it to PowerPoint.'
      );
    }
    const serviceSet = exactCurrentServiceSetClaim(context);
    const handoff = derivePlanLinkedPowerPointHandoff({
      sourceProject: source.project,
      sourceProjectRevisionId: source.revisionId,
      sourceItemId: prepareId(
        request.itemId,
        'Community plan sermon item'
      ),
      serviceSet
    });
    let action = 'create';
    if (context.existing) {
      const anchorItemId = currentServiceCompanionAnchor(
        context.existing.project,
        context.fingerprint
      );
      const applied = applyPlanLinkedPowerPointHandoff({
        companionProject: context.existing.project,
        anchorItemId,
        sourceProject: source.project,
        handoff
      });
      action = applied.unchanged ? 'already-linked' : 'link';
    }
    const safeServiceSummary = currentServiceCompanionSummary(
      context.manifest,
      context.existing
    );
    return holdPlanLinkedPowerPointHandoff(
      handoff,
      {
        projectId: context.existing?.project?.id
          || currentServiceCompanionProjectId(context.fingerprint),
        revisionId: context.existing?.revisionId || null
      },
      {
        sourceProjectTitle: prepareText(
          source.project.title,
          'Community service title',
          200,
          { required: true }
        ),
        serviceSet: safeServiceSummary.serviceSet,
        sources: safeServiceSummary.sources
      },
      action
    );
  })
);

ipcMain.handle(
  'prepare:projects:commitPlanLinkedPowerPointHandoff',
  async (event, request = {}) => currentServiceCompanionIpcResult(async () => {
    requireControlSender(event);
    requirePrepareRequest(request, 2 * 1024);
    requireExactPrepareKeys(
      request,
      ['proposalToken', 'confirmed'],
      'Confirmed Community-plan PowerPoint sermon handoff'
    );
    if (request.confirmed !== true) {
      failMainOperation(
        'PLAN_LINKED_POWERPOINT_CONFIRMATION_REQUIRED',
        'Confirm the exact Community sermon and current PowerPoint files before linking them.'
      );
    }
    const { entry } = requirePlanLinkedPowerPointHandoff(
      request.proposalToken
    );
    entry.consumed = true;

    const source = await readExactPlanLinkedPowerPointSource(entry.handoff);
    const context = await inspectExactPlanLinkedPowerPointContext(
      entry.handoff
    );
    const targetRevisionId = context.existing?.revisionId || null;
    const targetProjectId = context.existing?.project?.id
      || currentServiceCompanionProjectId(context.fingerprint);
    if (entry.target.projectId !== targetProjectId
      || entry.target.revisionId !== targetRevisionId) {
      failMainOperation(
        'PLAN_LINKED_POWERPOINT_COMPANION_CHANGED',
        'The exact PowerPoint service record changed after review. Review the handoff again.'
      );
    }

    let committed;
    try {
      committed = await savePlanLinkedPowerPointHandoff(
        context,
        source,
        entry.handoff
      );
    } catch (error) {
      if (error?.code !== 'PROJECT_CONFLICT') throw error;
      failMainOperation(
        'PLAN_LINKED_POWERPOINT_COMPANION_CHANGED',
        'The exact PowerPoint service record changed while it was being linked. Review the handoff again.'
      );
    }
    const result = currentServiceCompanionResult(
      context,
      committed.saved
    );
    const linked = resolveSermonSourceLink(
      committed.saved.project,
      committed.saved.project.items[committed.anchorItemId]
    );
    if (!linked
      || linked.resourceId !== entry.handoff.sermon.resourceId
      || linked.resource.document.id !== entry.handoff.sermon.id
      || linked.resource.sha256 !== entry.handoff.sermon.revisionId) {
      failMainOperation(
        'PLAN_LINKED_POWERPOINT_COMMIT_INVALID',
        'The exact Community sermon link could not be verified after saving.'
      );
    }
    return {
      ...result,
      sermon: {
        id: linked.resource.document.id,
        revisionId: linked.resource.sha256,
        resourceId: linked.resourceId
      },
      sourcePlan: {
        planId: entry.handoff.source.plan.planId,
        planRevision: entry.handoff.source.plan.planRevision
      }
    };
  })
);

function failCurrentServiceSongDraft(error) {
  const messages = {
    INVALID_SERVICE_SET:
      'The current PowerPoint service snapshot is invalid.',
    INVALID_PINNED_SET:
      'The current PowerPoint service snapshot is not compatible with this SyncShow build.',
    PINNED_ASSET_UNAVAILABLE:
      'The selected PowerPoint presentation is no longer available in the local snapshot.',
    PINNED_ASSET_CHANGED:
      'The selected PowerPoint presentation changed after it was loaded. Reload the service first.',
    SOURCE_TOO_LARGE:
      'The selected PowerPoint presentation is too large to inspect safely.',
    UNSUPPORTED_SOURCE_TYPE:
      'Song review currently supports PPTX presentations only.'
  };
  failMainOperation(
    'CURRENT_SERVICE_SONG_DRAFT_UNAVAILABLE',
    messages[error?.code]
      || 'The selected PowerPoint presentation could not be reviewed safely for a song draft.',
    { cause: typeof error?.code === 'string' ? error.code : 'UNKNOWN' }
  );
}

function pruneCurrentServiceSongDraftProposals(
  now = Date.now(),
  { makeRoom = false } = {}
) {
  for (const [token, proposal] of currentServiceSongDraftProposals) {
    if (proposal.expiresAt <= now && proposal.applying !== true) {
      currentServiceSongDraftProposals.delete(token);
    }
  }
  if (!makeRoom) return true;
  while (
    currentServiceSongDraftProposals.size
    >= CURRENT_SERVICE_SONG_DRAFT_PROPOSAL_LIMIT
  ) {
    const evictableToken = [...currentServiceSongDraftProposals]
      .find(([, proposal]) => proposal.applying !== true)?.[0];
    if (!evictableToken) return false;
    currentServiceSongDraftProposals.delete(evictableToken);
  }
  return true;
}

function holdCurrentServiceSongDraftProposal(entry) {
  const createdAt = Date.now();
  if (!pruneCurrentServiceSongDraftProposals(createdAt, { makeRoom: true })) {
    failMainOperation(
      'CURRENT_SERVICE_SONG_DRAFT_PROPOSALS_BUSY',
      'Active PowerPoint song reviews are still being built. Wait for one to finish.'
    );
  }
  const proposalToken = crypto.randomBytes(24).toString('base64url');
  const expiresAt =
    createdAt + CURRENT_SERVICE_SONG_DRAFT_PROPOSAL_TTL_MS;
  currentServiceSongDraftProposals.set(proposalToken, {
    ...entry,
    createdAt,
    expiresAt,
    applying: false
  });
  return {
    proposalToken,
    expiresAt: new Date(expiresAt).toISOString()
  };
}

function requireCurrentServiceSongDraftProposal(rawToken) {
  const proposalToken = prepareText(
    rawToken,
    'Current service song review',
    64,
    { required: true }
  );
  if (!/^[A-Za-z0-9_-]{32}$/.test(proposalToken)) {
    failMainOperation(
      'INVALID_CURRENT_SERVICE_SONG_DRAFT_PROPOSAL',
      'Review the current PowerPoint song slides again before building the draft.'
    );
  }
  pruneCurrentServiceSongDraftProposals();
  const entry = currentServiceSongDraftProposals.get(proposalToken);
  if (!entry || (entry.expiresAt <= Date.now() && entry.applying !== true)) {
    if (entry?.applying !== true) {
      currentServiceSongDraftProposals.delete(proposalToken);
    }
    failMainOperation(
      'EXPIRED_CURRENT_SERVICE_SONG_DRAFT_PROPOSAL',
      'This PowerPoint song review expired. Review the slides again.'
    );
  }
  if (entry.applying === true) {
    failMainOperation(
      'CURRENT_SERVICE_SONG_DRAFT_BUILD_IN_PROGRESS',
      'This reviewed PowerPoint song is already being built.'
    );
  }
  return { proposalToken, entry };
}

async function withCurrentServiceSongDraftBuild(
  proposalToken,
  entry,
  operation
) {
  entry.applying = true;
  try {
    return await operation();
  } finally {
    // A confirmed build is deliberately one-shot. Any failure after this
    // point requires a fresh inspection of the exact pinned presentation.
    if (currentServiceSongDraftProposals.get(proposalToken) === entry) {
      currentServiceSongDraftProposals.delete(proposalToken);
    }
  }
}

async function readCurrentServiceSongSource(
  context,
  roleId,
  expected = null
) {
  const input = context?.manifest?.inputs?.[roleId];
  if (!input || input.roleId !== roleId) {
    failMainOperation(
      'CURRENT_SERVICE_SONG_ROLE_UNAVAILABLE',
      'Choose one of the presentations in the current PowerPoint service.'
    );
  }
  if (path.extname(input.pinnedPath).toLowerCase() !== '.pptx') {
    failCurrentServiceSongDraft({ code: 'UNSUPPORTED_SOURCE_TYPE' });
  }
  if (
    !Number.isSafeInteger(input.size)
    || input.size < 1
    || input.size > CURRENT_SERVICE_SONG_DRAFT_MAX_SOURCE_BYTES
  ) {
    failCurrentServiceSongDraft({ code: 'SOURCE_TOO_LARGE' });
  }
  if (
    expected
    && (
      expected.roleId !== roleId
      || expected.inputSha256 !== input.sha256
      || expected.inputSize !== input.size
    )
  ) {
    failMainOperation(
      'CURRENT_SERVICE_SONG_SOURCE_CHANGED',
      'The reviewed PowerPoint presentation changed. Review its song slides again.'
    );
  }

  let read;
  try {
    read = await readFileNoFollow(
      input.pinnedPath,
      CURRENT_SERVICE_SONG_DRAFT_MAX_SOURCE_BYTES
    );
  } catch (error) {
    failCurrentServiceSongDraft(error);
  }
  const inputSha256 = crypto
    .createHash('sha256')
    .update(read.buffer)
    .digest('hex');
  if (
    read.stats.size !== input.size
    || read.buffer.length !== input.size
    || inputSha256 !== input.sha256
    || (expected && inputSha256 !== expected.inputSha256)
  ) {
    failMainOperation(
      'CURRENT_SERVICE_SONG_SOURCE_CHANGED',
      'The reviewed PowerPoint presentation changed. Reload the service and review it again.'
    );
  }
  return {
    buffer: read.buffer,
    input,
    inputSha256
  };
}

function currentServiceSongLaneSummary(rawLane, label) {
  if (!rawLane || typeof rawLane !== 'object' || Array.isArray(rawLane)) {
    failMainOperation(
      'INVALID_CURRENT_SERVICE_SONG_INSPECTION',
      `The ${label} song-slide summary is invalid.`
    );
  }
  const lineCount = rawLane.lineCount;
  if (
    !Number.isSafeInteger(lineCount)
    || lineCount < 0
    || lineCount > 10_000
  ) {
    failMainOperation(
      'INVALID_CURRENT_SERVICE_SONG_INSPECTION',
      `The ${label} song-slide line count is invalid.`
    );
  }
  return {
    preview: prepareText(
      rawLane.preview,
      `${label} song-slide preview`,
      CURRENT_SERVICE_SONG_DRAFT_MAX_PREVIEW_CHARS
    ),
    lineCount
  };
}

function publicCurrentServiceSongSlides(rawInspection) {
  if (
    !rawInspection
    || typeof rawInspection !== 'object'
    || Array.isArray(rawInspection)
    || !Number.isSafeInteger(rawInspection.slideCount)
    || rawInspection.slideCount < 1
    || rawInspection.slideCount > CURRENT_SERVICE_SONG_DRAFT_MAX_INSPECTION_SLIDES
    || !Array.isArray(rawInspection.slides)
    || rawInspection.slides.length !== rawInspection.slideCount
  ) {
    failMainOperation(
      'INVALID_CURRENT_SERVICE_SONG_INSPECTION',
      'The PowerPoint song-slide summary is invalid.'
    );
  }
  const slides = rawInspection.slides.map((slide, index) => {
    if (
      !slide
      || typeof slide !== 'object'
      || Array.isArray(slide)
      || slide.number !== index + 1
    ) {
      failMainOperation(
        'INVALID_CURRENT_SERVICE_SONG_INSPECTION',
        'PowerPoint song-slide summaries must be consecutive and in source order.'
      );
    }
    return {
      number: slide.number,
      lanes: {
        all: currentServiceSongLaneSummary(
          slide.lanes?.all,
          `Slide ${slide.number} all-text`
        ),
        white: currentServiceSongLaneSummary(
          slide.lanes?.white,
          `Slide ${slide.number} white-text`
        ),
        yellow: currentServiceSongLaneSummary(
          slide.lanes?.yellow,
          `Slide ${slide.number} yellow-text`
        )
      }
    };
  });
  const rawCandidates = rawInspection.candidates === undefined
    ? []
    : rawInspection.candidates;
  if (
    !Array.isArray(rawCandidates)
    || rawCandidates.length > CURRENT_SERVICE_SONG_DRAFT_MAX_CANDIDATES
  ) {
    failMainOperation(
      'INVALID_CURRENT_SERVICE_SONG_INSPECTION',
      'The PowerPoint song-review range suggestions are invalid.'
    );
  }
  let previousEndSlide = 0;
  const candidates = rawCandidates.map(rawCandidate => {
    if (
      !rawCandidate
      || typeof rawCandidate !== 'object'
      || Array.isArray(rawCandidate)
      || !rawCandidate.evidence
      || typeof rawCandidate.evidence !== 'object'
      || Array.isArray(rawCandidate.evidence)
      || Object.keys(rawCandidate).sort().join(',') !==
        'endSlide,evidence,id,kind,startSlide,titleSlide'
      || Object.keys(rawCandidate.evidence).sort().join(',') !==
        'bodyShapeName,bodySlideCount,kind,titlePlaceholderIndex,titleShapeName'
    ) {
      failMainOperation(
        'INVALID_CURRENT_SERVICE_SONG_INSPECTION',
        'One PowerPoint song-review range suggestion is invalid.'
      );
    }
    const {
      endSlide,
      startSlide,
      titleSlide
    } = rawCandidate;
    if (
      !/^slides-\d{1,4}-\d{1,4}-\d{1,4}$/u.test(rawCandidate.id)
      || rawCandidate.id !== `slides-${titleSlide}-${startSlide}-${endSlide}`
      || rawCandidate.kind !== 'syncshow-current-service-song-review-range'
      || !Number.isSafeInteger(titleSlide)
      || !Number.isSafeInteger(startSlide)
      || !Number.isSafeInteger(endSlide)
      || titleSlide < 1
      || startSlide !== titleSlide + 1
      || endSlide < startSlide
      || endSlide > rawInspection.slideCount
      || endSlide - startSlide + 1 > CURRENT_SERVICE_SONG_DRAFT_MAX_SLIDES
      || titleSlide <= previousEndSlide
      || slides[titleSlide - 1]?.lanes?.all?.lineCount < 1
      || slides.slice(startSlide - 1, endSlide)
        .some(slide => slide.lanes.all.lineCount < 1)
      || rawCandidate.evidence.kind !== 'template-text-shape-run'
      || rawCandidate.evidence.bodySlideCount !== endSlide - startSlide + 1
      || rawCandidate.evidence.titleShapeName !== 'Content Placeholder 2'
      || rawCandidate.evidence.titlePlaceholderIndex !== '1'
      || rawCandidate.evidence.bodyShapeName !== 'TextBox 3'
    ) {
      failMainOperation(
        'INVALID_CURRENT_SERVICE_SONG_INSPECTION',
        'One PowerPoint song-review range suggestion does not match the inspected slides.'
      );
    }
    previousEndSlide = endSlide;
    return {
      id: rawCandidate.id,
      kind: rawCandidate.kind,
      titleSlide,
      startSlide,
      endSlide,
      evidence: {
        kind: rawCandidate.evidence.kind,
        bodySlideCount: rawCandidate.evidence.bodySlideCount
      }
    };
  });
  return {
    slideCount: rawInspection.slideCount,
    slides,
    candidates
  };
}

function currentServiceSongDraftLane(rawLane) {
  const lane = prepareText(
    rawLane,
    'PowerPoint song text lane',
    16,
    { required: true }
  ).toLowerCase();
  if (!['all', 'white', 'yellow'].includes(lane)) {
    failMainOperation(
      'INVALID_CURRENT_SERVICE_SONG_LANE',
      'Choose all, white, or yellow text for this song draft.'
    );
  }
  return lane;
}

function currentServiceSongDraftLanguage(rawLanguage) {
  const language = prepareText(
    rawLanguage,
    'Song language',
    35,
    { required: true }
  ).toLowerCase();
  if (!/^[a-z]{2,3}(?:-[a-z0-9]{2,8})*$/.test(language)) {
    failMainOperation(
      'INVALID_CURRENT_SERVICE_SONG_LANGUAGE',
      'Song language must be a language tag such as en or ru.'
    );
  }
  return language;
}

function currentServiceSongDraftRange(request, slideCount) {
  const startSlide = request.startSlide;
  const endSlide = request.endSlide;
  if (
    !Number.isSafeInteger(startSlide)
    || !Number.isSafeInteger(endSlide)
    || startSlide < 1
    || endSlide < startSlide
    || endSlide > slideCount
    || endSlide - startSlide + 1 > CURRENT_SERVICE_SONG_DRAFT_MAX_SLIDES
  ) {
    failMainOperation(
      'INVALID_CURRENT_SERVICE_SONG_RANGE',
      `Choose a consecutive range of no more than ${CURRENT_SERVICE_SONG_DRAFT_MAX_SLIDES} slides from this presentation.`
    );
  }
  return { startSlide, endSlide };
}

function currentServiceSongDraftSlideLanes(rawLanes, range) {
  const count = range.endSlide - range.startSlide + 1;
  if (!Array.isArray(rawLanes) || rawLanes.length !== count) {
    failMainOperation(
      'INVALID_CURRENT_SERVICE_SONG_LANES',
      'Choose one text lane for every selected lyric slide.'
    );
  }
  return rawLanes.map(currentServiceSongDraftLane);
}

function currentServiceSongSourceLabel(context, publicSource) {
  const serviceName = context.summary.serviceSet.name
    .replace(/[\0\r\n]+/gu, ' ')
    .trim();
  const serviceDate = context.summary.serviceSet.serviceDate;
  const roleLabel = publicSource.roleLabel
    .replace(/[\0\r\n]+/gu, ' ')
    .trim();
  const fileName = publicSource.fileName
    .replace(/[\0\r\n]+/gu, ' ')
    .trim();
  const fullLabel =
    `${serviceName} (${serviceDate}) — ${roleLabel}: ${fileName}`;
  const boundedLabel = fullLabel.length <= 500
    ? fullLabel
    : `${serviceDate} — ${roleLabel}: ${fileName}`.slice(0, 500).trim();
  return prepareText(
    boundedLabel,
    'PowerPoint song source label',
    500,
    { required: true }
  );
}

ipcMain.handle(
  'prepare:songs:inspectCurrentServiceSource',
  async (event, request = {}) => {
    requireControlSender(event);
    requirePrepareRequest(request, 4 * 1024);
    requireExactPrepareKeys(
      request,
      ['inspectionToken', 'roleId'],
      'Current PowerPoint song review'
    );
    const roleId = prepareId(
      request.roleId,
      'Current PowerPoint service role'
    );
    const { inspectionToken, inspection } =
      requireCurrentServiceCompanionInspection(request.inspectionToken);
    const context = await inspectCurrentServiceCompanionContext();
    if (
      !context
      || !sameCurrentServiceCompanionBinding(
        context.binding,
        inspection.binding
      )
    ) {
      currentServiceCompanionInspections.delete(inspectionToken);
      failMainOperation(
        'CURRENT_SERVICE_SONG_SET_CHANGED',
        'The loaded PowerPoint service changed. Refresh Prepare and review the current files.'
      );
    }

    const publicSource = context.summary.sources.find(
      candidate => candidate.roleId === roleId
    );
    if (!publicSource) {
      failMainOperation(
        'CURRENT_SERVICE_SONG_ROLE_UNAVAILABLE',
        'Choose one of the presentations in the current PowerPoint service.'
      );
    }
    const sourceLabel = currentServiceSongSourceLabel(
      context,
      publicSource
    );
    const source = await readCurrentServiceSongSource(context, roleId);
    let inspectionResult;
    try {
      const rawInspection = await inspectPptxSongSlides(source.buffer);
      if (rawInspection?.deckSha256 !== source.inputSha256) {
        failMainOperation(
          'INVALID_CURRENT_SERVICE_SONG_INSPECTION',
          'The PowerPoint song-slide summary does not match the reviewed presentation.'
        );
      }
      inspectionResult = publicCurrentServiceSongSlides(rawInspection);
    } catch (error) {
      if (error?.code === 'INVALID_CURRENT_SERVICE_SONG_INSPECTION') {
        throw error;
      }
      failCurrentServiceSongDraft(error);
    }
    const held = holdCurrentServiceSongDraftProposal({
      binding: { ...context.binding },
      roleId,
      inputSha256: source.inputSha256,
      inputSize: source.input.size,
      slideCount: inspectionResult.slideCount,
      sourceLabel
    });
    currentServiceCompanionInspections.delete(inspectionToken);

    return {
      ...held,
      serviceSet: {
        name: context.summary.serviceSet.name,
        serviceDate: context.summary.serviceSet.serviceDate
      },
      source: {
        roleId: publicSource.roleId,
        roleLabel: publicSource.roleLabel,
        fileName: publicSource.fileName,
        sha256: source.inputSha256
      },
      ...inspectionResult
    };
  }
);

ipcMain.handle(
  'prepare:songs:buildCurrentServiceDraft',
  async (event, request = {}) => {
    requireControlSender(event);
    requirePrepareRequest(request, 32 * 1024);
    requireExactPrepareKeys(
      request,
      [
        'proposalToken',
        'lane',
        'startSlide',
        'endSlide',
        'slideLanes',
        'title',
        'language',
        'confirmed'
      ],
      'Current PowerPoint song draft'
    );
    if (request.confirmed !== true) {
      failMainOperation(
        'CURRENT_SERVICE_SONG_DRAFT_CONFIRMATION_REQUIRED',
        'Confirm the reviewed source, text lane, and slide range before building this song draft.'
      );
    }
    const { proposalToken, entry } =
      requireCurrentServiceSongDraftProposal(request.proposalToken);
    const lane = currentServiceSongDraftLane(request.lane);
    const title = prepareText(
      request.title,
      'Song title',
      200,
      { required: true }
    );
    const language = currentServiceSongDraftLanguage(request.language);
    const range = currentServiceSongDraftRange(request, entry.slideCount);
    const slideLanes = currentServiceSongDraftSlideLanes(
      request.slideLanes,
      range
    );

    return withCurrentServiceSongDraftBuild(
      proposalToken,
      entry,
      async () => {
        const context = await inspectCurrentServiceCompanionContext();
        if (
          !context
          || !sameCurrentServiceCompanionBinding(
            context.binding,
            entry.binding
          )
        ) {
          failMainOperation(
            'CURRENT_SERVICE_SONG_SET_CHANGED',
            'The loaded PowerPoint service changed. Review the song slides again.'
          );
        }
        const source = await readCurrentServiceSongSource(
          context,
          entry.roleId,
          entry
        );
        try {
          const slideNumbers = Array.from(
            {
              length: range.endSlide - range.startSlide + 1
            },
            (_value, index) => range.startSlide + index
          );
          return await buildPptxSongDraft(source.buffer, {
            slideNumbers,
            slideLanes,
            lane,
            title,
            language,
            sourceLabel: entry.sourceLabel
          });
        } catch (error) {
          failCurrentServiceSongDraft(error);
        }
      }
    );
  }
);

function currentServiceSongFamilyMemberRequest(raw, index) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    failMainOperation(
      'INVALID_CURRENT_SERVICE_SONG_FAMILY',
      `Song-family member ${index + 1} is invalid.`
    );
  }
  requireExactPrepareKeys(raw, [
    'memberKey',
    'proposalToken',
    'songId',
    'title',
    'language',
    'lane',
    'startSlide',
    'endSlide',
    'slideLanes',
    'candidateId'
  ], `Song-family member ${index + 1}`);
  const memberKey = prepareText(
    raw.memberKey,
    `Song-family member ${index + 1} key`,
    16,
    { required: true }
  );
  if (!['root', 'translation'].includes(memberKey)) {
    failMainOperation(
      'INVALID_CURRENT_SERVICE_SONG_FAMILY',
      'Song-family member keys must be root or translation.'
    );
  }
  const proposalToken = prepareText(
    raw.proposalToken,
    `Song-family ${memberKey} source review`,
    64,
    { required: true }
  );
  if (!/^[A-Za-z0-9_-]{32}$/.test(proposalToken)) {
    failMainOperation(
      'INVALID_CURRENT_SERVICE_SONG_DRAFT_PROPOSAL',
      `Review the ${memberKey} PowerPoint source again.`
    );
  }
  if (
    !Number.isSafeInteger(raw.startSlide)
    || !Number.isSafeInteger(raw.endSlide)
    || raw.startSlide < 1
    || raw.endSlide < raw.startSlide
    || raw.endSlide - raw.startSlide + 1
      > CURRENT_SERVICE_SONG_DRAFT_MAX_SLIDES
  ) {
    failMainOperation(
      'INVALID_CURRENT_SERVICE_SONG_RANGE',
      `Choose a consecutive ${memberKey} range of no more than ${CURRENT_SERVICE_SONG_DRAFT_MAX_SLIDES} slides.`
    );
  }
  const range = {
    startSlide: raw.startSlide,
    endSlide: raw.endSlide
  };
  const candidateId = raw.candidateId === null
    ? null
    : prepareText(
        raw.candidateId,
        `Song-family ${memberKey} range suggestion`,
        128,
        { required: true }
      );
  if (
    candidateId !== null
    && !/^slides-\d{1,4}-\d{1,4}-\d{1,4}$/.test(candidateId)
  ) {
    failMainOperation(
      'INVALID_CURRENT_SERVICE_SONG_FAMILY',
      `The ${memberKey} range suggestion is invalid.`
    );
  }
  if (candidateId !== null) {
    const match =
      /^slides-(\d{1,4})-(\d{1,4})-(\d{1,4})$/.exec(candidateId);
    if (
      Number.parseInt(match[1], 10) !== raw.startSlide - 1
      || Number.parseInt(match[2], 10) !== raw.startSlide
      || Number.parseInt(match[3], 10) !== raw.endSlide
    ) {
      failMainOperation(
        'INVALID_CURRENT_SERVICE_SONG_FAMILY',
        `The ${memberKey} range does not match its selected PowerPoint suggestion.`
      );
    }
  }
  return {
    memberKey,
    proposalToken,
    songId: prepareId(raw.songId, `Song-family ${memberKey} song`),
    title: prepareText(
      raw.title,
      `Song-family ${memberKey} title`,
      200,
      { required: true }
    ),
    language: currentServiceSongDraftLanguage(raw.language),
    lane: currentServiceSongDraftLane(raw.lane),
    ...range,
    slideLanes: currentServiceSongDraftSlideLanes(
      raw.slideLanes,
      range
    ),
    candidateId
  };
}

function currentServiceSongFamilyMessageContainsAbsolutePath(message) {
  return /\bfile:/iu.test(message)
    || /(?:^|[^A-Za-z0-9._/\\-])(?:[A-Za-z]:[\\/])/u.test(message)
    || /(?:^|[\s"'`(=,])(?:\\\\[^\\/\s]+[\\/][^\\/\s]+|\/\/[^\\/\s]+\/[^\\/\s]+)/u
      .test(message)
    || /(?:^|[^A-Za-z0-9._/\\-])\/(?!\/)[^\s"'`<>()]+/u
      .test(message);
}

function publicCurrentServiceSongFamilyError(error) {
  const rawCode = typeof error?.code === 'string'
    ? error.code
    : 'CURRENT_SERVICE_SONG_FAMILY_ERROR';
  const code = /^[A-Z][A-Z0-9_]{2,79}$/.test(rawCode)
    ? rawCode
    : 'CURRENT_SERVICE_SONG_FAMILY_ERROR';
  const rawMessage = typeof error?.message === 'string'
    ? error.message.trim()
    : '';
  const message = rawMessage
    && rawMessage.length <= 500
    && !/[\0\r\n]/u.test(rawMessage)
    && !currentServiceSongFamilyMessageContainsAbsolutePath(rawMessage)
    ? rawMessage
    : 'The current-service song-family operation could not be completed.';
  return { code, message };
}

async function currentServiceSongFamilyIpcResult(operation) {
  try {
    return { success: true, data: await operation() };
  } catch (error) {
    return {
      success: false,
      error: publicCurrentServiceSongFamilyError(error)
    };
  }
}

function currentServiceSongFamilyBeginRequest(request) {
  requireExactPrepareKeys(
    request,
    ['rootMemberKey', 'members'],
    'Current PowerPoint song-family review'
  );
  if (request.rootMemberKey !== 'root') {
    failMainOperation(
      'INVALID_CURRENT_SERVICE_SONG_FAMILY',
      'The captured family root must use the root member key.'
    );
  }
  if (
    !Array.isArray(request.members)
    || request.members.length < 1
    || request.members.length > 2
  ) {
    failMainOperation(
      'INVALID_CURRENT_SERVICE_SONG_FAMILY',
      'Capture one root and at most one translation.'
    );
  }
  const members = request.members.map(currentServiceSongFamilyMemberRequest);
  if (
    members[0].memberKey !== 'root'
    || (members.length === 2 && members[1].memberKey !== 'translation')
    || new Set(members.map(member => member.songId)).size !== members.length
    || new Set(members.map(member => member.language)).size !== members.length
  ) {
    failMainOperation(
      'INVALID_CURRENT_SERVICE_SONG_FAMILY',
      'Capture one ordered root and one optional translation with distinct song identities and languages.'
    );
  }
  return members;
}

function pruneCurrentServiceSongFamilyReviews(
  now = Date.now(),
  { makeRoom = false } = {}
) {
  for (const [token, entry] of currentServiceSongFamilyReviews) {
    if (entry.expiresAt <= now && entry.applying !== true) {
      currentServiceSongFamilyReviews.delete(token);
    }
  }
  if (!makeRoom) return true;
  while (
    currentServiceSongFamilyReviews.size
    >= CURRENT_SERVICE_SONG_FAMILY_REVIEW_LIMIT
  ) {
    const evictableToken = [...currentServiceSongFamilyReviews]
      .find(([, entry]) =>
        entry.applying !== true && entry.snapshot === null)?.[0];
    if (!evictableToken) return false;
    currentServiceSongFamilyReviews.delete(evictableToken);
  }
  return true;
}

function holdCurrentServiceSongFamilyReview(prepared) {
  const createdAt = Date.now();
  if (
    !pruneCurrentServiceSongFamilyReviews(createdAt, { makeRoom: true })
  ) {
    failMainOperation(
      'CURRENT_SERVICE_SONG_FAMILY_REVIEWS_BUSY',
      'Active song-family commits are still finishing. Wait for one to complete.'
    );
  }
  const reviewToken = crypto.randomBytes(24).toString('base64url');
  const expiresAt =
    createdAt + CURRENT_SERVICE_SONG_FAMILY_REVIEW_TTL_MS;
  currentServiceSongFamilyReviews.set(reviewToken, {
    prepared,
    binding: {
      id: prepared.serviceSet.id,
      fingerprint: prepared.serviceSet.fingerprint,
      serviceDate: prepared.serviceSet.serviceDate,
      profileId: prepared.serviceSet.profileId
    },
    createdAt,
    expiresAt,
    applying: false,
    intentHash: null,
    snapshot: null,
    snapshotHash: null
  });
  return {
    reviewToken,
    expiresAt: new Date(expiresAt).toISOString()
  };
}

function requireCurrentServiceSongFamilyReview(rawToken) {
  const reviewToken = prepareText(
    rawToken,
    'Current service song-family review',
    64,
    { required: true }
  );
  if (!/^[A-Za-z0-9_-]{32}$/.test(reviewToken)) {
    failMainOperation(
      'INVALID_CURRENT_SERVICE_SONG_FAMILY_REVIEW',
      'Review the PowerPoint song family again before committing it.'
    );
  }
  pruneCurrentServiceSongFamilyReviews();
  const entry = currentServiceSongFamilyReviews.get(reviewToken);
  if (!entry || (entry.expiresAt <= Date.now() && entry.applying !== true)) {
    if (entry?.applying !== true) {
      currentServiceSongFamilyReviews.delete(reviewToken);
    }
    failMainOperation(
      'EXPIRED_CURRENT_SERVICE_SONG_FAMILY_REVIEW',
      'This song-family review expired. Review the PowerPoint slides again.'
    );
  }
  if (entry.applying === true) {
    failMainOperation(
      'CURRENT_SERVICE_SONG_FAMILY_COMMIT_IN_PROGRESS',
      'This reviewed song family is already being committed.'
    );
  }
  return { reviewToken, entry };
}

async function withCurrentServiceSongFamilySourceBuild(
  proposalEntries,
  operation
) {
  const unique = [...new Map(
    proposalEntries.map(({ proposalToken, entry }) => [
      proposalToken,
      entry
    ])
  ).entries()].map(([proposalToken, entry]) => ({
    proposalToken,
    entry
  }));
  for (const { entry } of unique) entry.applying = true;
  try {
    return await operation();
  } finally {
    for (const { proposalToken, entry } of unique) {
      if (currentServiceSongDraftProposals.get(proposalToken) === entry) {
        currentServiceSongDraftProposals.delete(proposalToken);
      }
    }
  }
}

async function currentServiceSongFamilyCurrentDocuments(
  songLibrary,
  rootSongId,
  capturedSongIds
) {
  return songLibrary.withCurrentSnapshot(async session => {
    const family = await session.snapshotFamily(rootSongId);
    const documents = [];
    const seen = new Set();
    for (const reference of family.documents) {
      const current = await session.readRevision(
        reference.songId,
        reference.revision
      );
      documents.push(current);
      seen.add(reference.songId);
    }
    for (const songId of capturedSongIds) {
      if (seen.has(songId)) continue;
      const collision = await session.readCurrent(songId);
      if (collision) {
        documents.push(collision);
        seen.add(songId);
      }
    }
    return documents;
  });
}

function currentServiceSongFamilyTitleCardEvidence(
  rawInspection,
  candidate
) {
  if (!candidate) {
    return {
      kind: 'none',
      slideNumber: null,
      lines: []
    };
  }
  const slide = Array.isArray(rawInspection?.slides)
    ? rawInspection.slides[candidate.titleSlide - 1]
    : null;
  const rawLane = slide?.lanes?.all;
  if (
    !slide
    || slide.number !== candidate.titleSlide
    || !rawLane
    || typeof rawLane !== 'object'
    || Array.isArray(rawLane)
    || !Array.isArray(rawLane.lines)
    || rawLane.lines.length < 1
    || rawLane.lines.length > 10_000
    || rawLane.lineCount !== rawLane.lines.length
  ) {
    failMainOperation(
      'INVALID_CURRENT_SERVICE_SONG_INSPECTION',
      'The template song suggestion has no complete title-card evidence.'
    );
  }
  let totalCharacters = 0;
  let hasText = false;
  const lines = rawLane.lines.map((line, index) => {
    if (
      typeof line !== 'string'
      || line.length > 1_000
      || /[\0\r\n]/u.test(line)
    ) {
      failMainOperation(
        'INVALID_CURRENT_SERVICE_SONG_INSPECTION',
        `Title-card evidence line ${index + 1} is invalid.`
      );
    }
    totalCharacters += line.length;
    if (line.length > 0) hasText = true;
    return line;
  });
  if (
    !hasText
    || totalCharacters > CURRENT_SERVICE_SONG_DRAFT_MAX_PREVIEW_CHARS
  ) {
    failMainOperation(
      'INVALID_CURRENT_SERVICE_SONG_INSPECTION',
      'The template title-card evidence is empty or exceeds its complete-text bound.'
    );
  }
  return {
    kind: 'template-local',
    slideNumber: candidate.titleSlide,
    lines
  };
}

async function buildCurrentServiceSongFamilyMember(
  context,
  request,
  proposal,
  sourceCache
) {
  let cached = sourceCache.get(request.proposalToken);
  if (!cached) {
    const source = await readCurrentServiceSongSource(
      context,
      proposal.entry.roleId,
      proposal.entry
    );
    let inspection;
    let rawInspection;
    try {
      rawInspection = await inspectPptxSongSlides(source.buffer);
      if (rawInspection?.deckSha256 !== source.inputSha256) {
        failMainOperation(
          'INVALID_CURRENT_SERVICE_SONG_INSPECTION',
          'The PowerPoint song-family inspection does not match its exact source deck.'
        );
      }
      inspection = publicCurrentServiceSongSlides(rawInspection);
    } catch (error) {
      if (error?.code === 'INVALID_CURRENT_SERVICE_SONG_INSPECTION') {
        throw error;
      }
      failCurrentServiceSongDraft(error);
    }
    const publicSource = context.summary.sources.find(candidate =>
      candidate.roleId === proposal.entry.roleId);
    if (!publicSource) {
      failMainOperation(
        'CURRENT_SERVICE_SONG_ROLE_UNAVAILABLE',
        'One reviewed song-family presentation is no longer in the current service.'
      );
    }
    cached = {
      source,
      inspection,
      rawInspection,
      publicSource
    };
    sourceCache.set(request.proposalToken, cached);
  }
  const range = currentServiceSongDraftRange(
    request,
    cached.inspection.slideCount
  );
  const slideNumbers = Array.from(
    { length: range.endSlide - range.startSlide + 1 },
    (_value, index) => range.startSlide + index
  );
  const candidate = request.candidateId === null
    ? null
    : cached.inspection.candidates.find(candidate =>
        candidate.id === request.candidateId);
  if (
    request.candidateId !== null
    && (
      !candidate
      || candidate.startSlide !== range.startSlide
      || candidate.endSlide !== range.endSlide
      || candidate.titleSlide !== range.startSlide - 1
    )
  ) {
    failMainOperation(
      'CURRENT_SERVICE_SONG_FAMILY_CANDIDATE_CHANGED',
      `The ${request.memberKey} song range no longer matches that exact PowerPoint suggestion.`
    );
  }
  let draft;
  try {
    draft = await buildPptxSongDraft(cached.source.buffer, {
      slideNumbers,
      slideLanes: request.slideLanes,
      lane: request.lane,
      title: request.title,
      language: request.language,
      sourceLabel: proposal.entry.sourceLabel
    });
  } catch (error) {
    failCurrentServiceSongDraft(error);
  }
  return {
    memberKey: request.memberKey,
    songId: request.songId,
    title: request.title,
    language: request.language,
    source: {
      roleId: proposal.entry.roleId,
      roleLabel: cached.publicSource.roleLabel,
      fileName: cached.publicSource.fileName,
      sourceSizeBytes: cached.source.input.size,
      deckSha256: cached.source.inputSha256,
      deckSlideCount: cached.inspection.slideCount,
      sourceLabel: proposal.entry.sourceLabel
    },
    selection: {
      selectionOrigin: candidate ? 'template-local' : 'manual',
      candidateId: candidate?.id || null,
      titleSlide: candidate?.titleSlide || null,
      slideNumbers,
      slideLanes: request.slideLanes
    },
    titleCardEvidence: currentServiceSongFamilyTitleCardEvidence(
      cached.rawInspection,
      candidate
    ),
    draft
  };
}

ipcMain.handle(
  'prepare:songs:beginCurrentServiceFamilyReview',
  async (event, request = {}) =>
    currentServiceSongFamilyIpcResult(async () => {
      requireControlSender(event);
      requirePrepareRequest(request, 64 * 1024);
      const members = currentServiceSongFamilyBeginRequest(request);
      if (
        !pruneCurrentServiceSongFamilyReviews(Date.now(), { makeRoom: true })
      ) {
        failMainOperation(
          'CURRENT_SERVICE_SONG_FAMILY_REVIEWS_BUSY',
          'Active song-family commits are still finishing. Wait for one to complete.'
        );
      }
      const proposalEntries = members.map(member => ({
        proposalToken: member.proposalToken,
        entry: requireCurrentServiceSongDraftProposal(
          member.proposalToken
        ).entry
      }));
      if (
        members.length === 2
        && (
          members[0].endSlide - members[0].startSlide
          !== members[1].endSlide - members[1].startSlide
        )
      ) {
        failMainOperation(
          'CURRENT_SERVICE_SONG_FAMILY_OCCURRENCE_COUNT_MISMATCH',
          'Root and translation selections must contain the same number of lyric occurrences.'
        );
      }
      if (
        members.length === 2
        && proposalEntries[0].entry.inputSha256
          === proposalEntries[1].entry.inputSha256
        && (
          members[0].startSlide !== members[1].startSlide
          || members[0].endSlide !== members[1].endSlide
        )
      ) {
        failMainOperation(
          'CURRENT_SERVICE_SONG_FAMILY_SHARED_DECK_RANGE_MISMATCH',
          'Two language lanes from one deck must use the same exact slide range.'
        );
      }
      return withCurrentServiceSongFamilySourceBuild(
        proposalEntries,
        async () => {
          const context = await inspectCurrentServiceCompanionContext();
          if (
            !context
            || proposalEntries.some(({ entry }) =>
              !sameCurrentServiceCompanionBinding(
                context.binding,
                entry.binding
              ))
          ) {
            failMainOperation(
              'CURRENT_SERVICE_SONG_SET_CHANGED',
              'The loaded PowerPoint service changed. Review the song-family sources again.'
            );
          }
          const sourceCache = new Map();
          const capturedMembers = [];
          for (const [index, member] of members.entries()) {
            capturedMembers.push(
              await buildCurrentServiceSongFamilyMember(
                context,
                member,
                proposalEntries[index],
                sourceCache
              )
            );
          }
          const services = getPrepareServices();
          await recoverLocalSongFamilyCommit();
          const currentDocuments =
            await currentServiceSongFamilyCurrentDocuments(
              services.localSongLibrary,
              members[0].songId,
              members.map(member => member.songId)
            );
          const prepared = createCurrentServiceSongFamilyReview({
            serviceSet: {
              ...context.binding,
              name: context.summary.serviceSet.name
            },
            members: capturedMembers,
            currentDocuments
          });
          return {
            ...holdCurrentServiceSongFamilyReview(prepared),
            ...prepared.summary
          };
        }
      );
    })
);

function currentServiceSongFamilyDecision(raw, index) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    failMainOperation(
      'INVALID_CURRENT_SERVICE_SONG_FAMILY_REVIEW',
      `Song-family decision ${index + 1} is invalid.`
    );
  }
  requireExactPrepareKeys(raw, [
    'occurrenceId',
    'action',
    'repeatOfOccurrenceId',
    'note'
  ], `Song-family decision ${index + 1}`);
  const action = prepareText(
    raw.action,
    `Song-family decision ${index + 1} action`,
    16,
    { required: true }
  );
  if (!['new', 'repeat', 'exclude'].includes(action)) {
    failMainOperation(
      'INVALID_CURRENT_SERVICE_SONG_FAMILY_REVIEW',
      'Each song-family occurrence must be new, repeat, or exclude.'
    );
  }
  const repeatOfOccurrenceId = raw.repeatOfOccurrenceId === null
    ? null
    : prepareId(
        raw.repeatOfOccurrenceId,
        `Song-family decision ${index + 1} repeat`
      );
  if (
    (action === 'repeat' && repeatOfOccurrenceId === null)
    || (action !== 'repeat' && repeatOfOccurrenceId !== null)
  ) {
    failMainOperation(
      'INVALID_CURRENT_SERVICE_SONG_FAMILY_REVIEW',
      'Only a repeat occurrence can identify a prior occurrence.'
    );
  }
  return {
    occurrenceId: prepareId(
      raw.occurrenceId,
      `Song-family decision ${index + 1} occurrence`
    ),
    action,
    repeatOfOccurrenceId,
    note: prepareText(
      raw.note,
      `Song-family decision ${index + 1} note`,
      500
    )
  };
}

function currentServiceSongFamilyMetadataList(raw, label) {
  if (!Array.isArray(raw) || raw.length > 64) {
    failMainOperation(
      'INVALID_CURRENT_SERVICE_SONG_FAMILY_METADATA',
      `${label} must contain at most 64 values.`
    );
  }
  return raw.map((value, index) =>
    prepareText(value, `${label} ${index + 1}`, 120));
}

function currentServiceSongFamilyLocalServiceRights(raw, index) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    failMainOperation(
      'INVALID_LOCAL_SERVICE_SONG_RIGHTS',
      `Song-family metadata ${index + 1} local-service rights are invalid.`
    );
  }
  requireExactPrepareKeys(raw, [
    'basis',
    'evidence'
  ], `Song-family metadata ${index + 1} local-service rights`);
  try {
    return normalizeLocalServiceSongRightsSelection({
      basis: raw.basis,
      evidence: raw.evidence
    });
  } catch (error) {
    if (error instanceof LocalServiceSongRightsEvidenceError) {
      failMainOperation(error.code, error.message);
    }
    throw error;
  }
}

function currentServiceSongFamilyMetadata(raw, index) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    failMainOperation(
      'INVALID_CURRENT_SERVICE_SONG_FAMILY_METADATA',
      `Song-family metadata ${index + 1} is invalid.`
    );
  }
  requireExactPrepareKeys(raw, [
    'memberKey',
    'license',
    'attribution',
    'tags',
    'authors',
    'translators',
    'composers',
    'localServiceRights'
  ], `Song-family metadata ${index + 1}`);
  return {
    memberKey: prepareText(
      raw.memberKey,
      `Song-family metadata ${index + 1} member`,
      16,
      { required: true }
    ),
    license: prepareText(
      raw.license,
      `Song-family metadata ${index + 1} license`,
      300,
      { required: true }
    ),
    attribution: prepareText(
      raw.attribution,
      `Song-family metadata ${index + 1} attribution`,
      2_048
    ),
    tags: currentServiceSongFamilyMetadataList(
      raw.tags,
      `Song-family metadata ${index + 1} tags`
    ),
    authors: currentServiceSongFamilyMetadataList(
      raw.authors,
      `Song-family metadata ${index + 1} authors`
    ),
    translators: currentServiceSongFamilyMetadataList(
      raw.translators,
      `Song-family metadata ${index + 1} translators`
    ),
    composers: currentServiceSongFamilyMetadataList(
      raw.composers,
      `Song-family metadata ${index + 1} composers`
    ),
    localServiceRights: currentServiceSongFamilyLocalServiceRights(
      raw.localServiceRights,
      index
    )
  };
}

function currentServiceSongFamilyCommitIntent(request) {
  requireExactPrepareKeys(request, [
    'reviewToken',
    'decisions',
    'metadata',
    'sourceConfirmed',
    'rightsConfirmed',
    'localCommitConfirmed'
  ], 'Current PowerPoint song-family commit');
  if (
    request.sourceConfirmed !== true
    || request.rightsConfirmed !== true
    || request.localCommitConfirmed !== true
  ) {
    failMainOperation(
      'CURRENT_SERVICE_SONG_FAMILY_CONFIRMATION_REQUIRED',
      'Confirm the exact source, rights metadata, and local atomic commit before saving this song family.'
    );
  }
  if (
    !Array.isArray(request.decisions)
    || request.decisions.length < 1
    || request.decisions.length > CURRENT_SERVICE_SONG_DRAFT_MAX_SLIDES
    || !Array.isArray(request.metadata)
    || request.metadata.length < 1
    || request.metadata.length > 2
  ) {
    failMainOperation(
      'INVALID_CURRENT_SERVICE_SONG_FAMILY_REVIEW',
      'Song-family decisions or metadata are outside their safe limits.'
    );
  }
  return {
    reviewToken: prepareText(
      request.reviewToken,
      'Current service song-family review',
      64,
      { required: true }
    ),
    decisions: request.decisions.map(currentServiceSongFamilyDecision),
    metadata: request.metadata.map(currentServiceSongFamilyMetadata),
    confirmations: {
      sourceConfirmed: true,
      rightsConfirmed: true,
      localCommitConfirmed: true,
      authorityScope: SONG_FAMILY_REVIEW_CONFIRMATION_AUTHORITY_SCOPE,
      communityAuthorityGranted: false
    }
  };
}

function currentServiceSongFamilyIntentHash(intent) {
  return crypto
    .createHash('sha256')
    .update(JSON.stringify({
      decisions: intent.decisions,
      metadata: intent.metadata,
      confirmations: intent.confirmations
    }))
    .digest('hex');
}

function publicCurrentServiceSongFamilyCommit(commit, snapshot) {
  return {
    familyId: commit.familyId,
    familyRevision: commit.familyRevision,
    members: snapshot.family.members.map(member => ({
      songId: member.songId,
      language: parseSongDocument(member.documentSource, {
        fileName: `${member.songId}.md`
      }).language,
      translationOf: member.translationOf,
      action: member.action,
      resultingRevision: member.reviewedRevision
    })),
    unchanged: commit.unchanged === true,
    recovered: commit.recovered === true
  };
}

ipcMain.handle(
  'prepare:songs:commitCurrentServiceFamilyReview',
  async (event, request = {}) =>
    currentServiceSongFamilyIpcResult(async () => {
      requireControlSender(event);
      requirePrepareRequest(request, 256 * 1024);
      const intent = currentServiceSongFamilyCommitIntent(request);
      const { reviewToken, entry } =
        requireCurrentServiceSongFamilyReview(intent.reviewToken);
      const applied = applyCurrentServiceSongFamilyReview(
        entry.prepared,
        {
          decisions: intent.decisions,
          metadata: intent.metadata
        }
      );
      const intentHash = currentServiceSongFamilyIntentHash(intent);
      if (entry.intentHash !== null && entry.intentHash !== intentHash) {
        failMainOperation(
          'CURRENT_SERVICE_SONG_FAMILY_RETRY_MISMATCH',
          'Retry the same reviewed decisions, metadata, and local-only confirmations for this pending local family commit.'
        );
      }

      entry.applying = true;
      try {
        const context = await inspectCurrentServiceCompanionContext();
        if (
          !context
          || !sameCurrentServiceCompanionBinding(
            context.binding,
            entry.binding
          )
        ) {
          currentServiceSongFamilyReviews.delete(reviewToken);
          failMainOperation(
            'CURRENT_SERVICE_SONG_SET_CHANGED',
            'The loaded PowerPoint service changed. Review the song-family sources again.'
          );
        }
        const verifiedRoles = new Set();
        for (const member of entry.prepared.members) {
          if (verifiedRoles.has(member.source.roleId)) continue;
          verifiedRoles.add(member.source.roleId);
          try {
            await readCurrentServiceSongSource(
              context,
              member.source.roleId,
              {
                roleId: member.source.roleId,
                inputSha256: member.source.deckSha256,
                inputSize: member.source.sourceSizeBytes
              }
            );
          } catch (error) {
            if (
              [
                'CURRENT_SERVICE_SONG_SOURCE_CHANGED',
                'CURRENT_SERVICE_SONG_ROLE_UNAVAILABLE',
                'CURRENT_SERVICE_SONG_DRAFT_UNAVAILABLE'
              ].includes(error?.code)
            ) {
              currentServiceSongFamilyReviews.delete(reviewToken);
            }
            throw error;
          }
        }
        if (!entry.snapshot) {
          const snapshot = currentServiceSongFamilyReviewSnapshot(
            entry.prepared,
            applied,
            {
              reviewedAt: new Date().toISOString(),
              confirmations: intent.confirmations
            }
          );
          entry.intentHash = intentHash;
          entry.snapshot = snapshot;
        }
        const services = getPrepareServices();
        let saved;
        try {
          saved = await services.localSongFamilyReviewStore.saveSnapshot(
            entry.snapshot
          );
        } catch (error) {
          if (
            ['INVALID_REVIEW_SNAPSHOT', 'SNAPSHOT_TOO_LARGE']
              .includes(error?.code)
          ) {
            entry.intentHash = null;
            entry.snapshot = null;
            entry.snapshotHash = null;
          }
          throw error;
        }
        entry.snapshotHash = saved.snapshotHash;
        const commit =
          await services.localSongFamilyCommitCoordinator.commit({
            snapshotHash: saved.snapshotHash
          });
        currentServiceSongFamilyReviews.delete(reviewToken);
        return publicCurrentServiceSongFamilyCommit(
          commit,
          saved.snapshot
        );
      } catch (error) {
        if (currentServiceSongFamilyReviews.get(reviewToken) === entry) {
          entry.applying = false;
        }
        throw error;
      }
    })
);

ipcMain.handle('prepare:projects:list', async (event, request = {}) => {
  requireControlSender(event);
  requirePrepareRequest(request, 16 * 1024);
  const services = getPrepareServices();
  const recovery = await services.sermonProjectCommitCoordinator.recover();
  const projects = await services.serviceProjectStore.list({
    query: prepareText(request.query, 'Project search', 120),
    pageSize: Number.isSafeInteger(request.pageSize) ? request.pageSize : 50,
    offset: Number.isSafeInteger(request.offset) ? request.offset : 0
  });
  return {
    ...projects,
    recovery: recovery?.message
      ? {
          source: 'sermon-project-transaction',
          message: recovery.message
        }
      : null
  };
});

ipcMain.handle('prepare:projects:create', async (event, request = {}) => {
  requireControlSender(event);
  requirePrepareRequest(request, 16 * 1024);
  requireExactPrepareKeys(request, [
    'title',
    'serviceDate',
    'startTime',
    'teamNotes'
  ], 'Create service request');
  const serviceDate = request.serviceDate
    ? prepareText(request.serviceDate, 'Service date', 10, { required: true })
    : serviceDateForTimeZone(new Date(), activeVenueProfile?.timeZone || null);
  const startTime = prepareText(
    request.startTime,
    'Service start time',
    5,
    { required: true }
  );
  const teamNotes = request.teamNotes === undefined
    ? undefined
    : prepareText(request.teamNotes, 'Planning team notes', 4000);
  const created = await getPrepareServices().serviceProjectStore.create({
    id: projectItemId('service'),
    title: prepareText(request.title || 'Sunday Service', 'Service title', 200, { required: true }),
    serviceDate,
    startTime,
    ...(teamNotes !== undefined ? { teamNotes } : {}),
    profileId: activeVenueProfile?.id || 'default',
    channels: nativeProjectChannels()
  });
  return projectResult(created);
});

ipcMain.handle('prepare:projects:planNext', async (event, request = {}) => {
  requireControlSender(event);
  requirePrepareRequest(request, 16 * 1024);
  requireExactPrepareKeys(request, [
    'sourceProjectId',
    'sourceRevisionId',
    'title',
    'serviceDate',
    'startTime',
    'teamNotes'
  ], 'Plan next service request');
  const sourceProjectId = prepareId(
    request.sourceProjectId,
    'Source service project'
  );
  const sourceRevisionId = prepareRevision(
    request.sourceRevisionId,
    'Source service revision'
  );
  const title = prepareText(
    request.title,
    'Planned service title',
    200,
    { required: true }
  );
  const serviceDate = prepareText(
    request.serviceDate,
    'Planned service date',
    10,
    { required: true }
  );
  const startTime = prepareText(
    request.startTime,
    'Planned service start time',
    5,
    { required: true }
  );
  const teamNotes = request.teamNotes === undefined
    ? undefined
    : prepareText(request.teamNotes, 'Planning team notes', 4000);
  const planned = await getPrepareServices().serviceProjectStore.planNextService(
    sourceProjectId,
    {
      sourceRevisionId,
      id: projectItemId('service'),
      title,
      serviceDate,
      startTime,
      ...(teamNotes !== undefined ? { teamNotes } : {})
    }
  );
  return projectResult(planned);
});

ipcMain.handle('prepare:projects:setPlanning', async (event, request = {}) => {
  requireControlSender(event);
  requirePrepareRequest(request, 16 * 1024);
  requireExactPrepareKeys(request, [
    'projectId',
    'expectedRevisionId',
    'status',
    'waivers'
  ], 'Service planning status request');
  const projectId = prepareId(request.projectId, 'Service project');
  const expectedRevisionId = prepareRevision(
    request.expectedRevisionId,
    'Expected service revision'
  );
  const status = prepareText(
    request.status,
    'Service planning status',
    20,
    { required: true }
  );
  if (!['planning', 'ready', 'completed', 'needs-follow-up'].includes(status)) {
    failMainOperation(
      'INVALID_SERVICE_PLAN_STATUS',
      'Choose Planning, Ready, Completed, or Needs follow-up.'
    );
  }
  const current = await readExpectedProject({
    projectId,
    expectedRevisionId
  });
  let reviewedProject = current.project;
  if (request.waivers !== undefined) {
    reviewedProject = updateServicePlanningDetails(reviewedProject, {
      readinessWaivers: request.waivers
    });
  }
  if (status === 'ready') {
    const readiness = analyzeServiceProjectReadiness(reviewedProject, {
      waivers: reviewedProject.planning?.readinessWaivers || []
    });
    if (!readiness.ready) {
      failMainOperation(
        'SERVICE_READINESS_BLOCKED',
        'Review every service readiness blocker before marking this plan Ready.',
        { blockers: readiness.blockers }
      );
    }
  }
  const next = setServicePlanStatus(reviewedProject, status);
  const saved = await current.services.serviceProjectStore.save(next, {
    expectedRevisionId,
    reason: 'prepare-planning-status'
  });
  return projectResult(saved);
});

ipcMain.handle('prepare:projects:updatePlanning', async (event, request = {}) => {
  requireControlSender(event);
  requirePrepareRequest(request, 32 * 1024);
  requireExactPrepareKeys(request, [
    'projectId',
    'expectedRevisionId',
    'startTime',
    'teamNotes',
    'waivers'
  ], 'Service planning details request');
  const projectId = prepareId(request.projectId, 'Service project');
  const expectedRevisionId = prepareRevision(
    request.expectedRevisionId,
    'Expected service revision'
  );
  const details = {};
  if (request.startTime !== undefined) {
    details.startTime = prepareText(
      request.startTime,
      'Planned service start time',
      5,
      { required: true }
    );
  }
  if (request.teamNotes !== undefined) {
    details.teamNotes = prepareText(
      request.teamNotes,
      'Planning team notes',
      4000
    );
  }
  if (request.waivers !== undefined) {
    details.readinessWaivers = request.waivers;
  }
  const current = await readExpectedProject({
    projectId,
    expectedRevisionId
  });
  const next = updateServicePlanningDetails(current.project, details);
  const saved = await current.services.serviceProjectStore.save(next, {
    expectedRevisionId,
    reason: 'prepare-planning-details'
  });
  return projectResult(saved);
});

ipcMain.handle('prepare:projects:updateServing', async (event, request = {}) => {
  requireControlSender(event);
  requirePrepareRequest(request, 256 * 1024);
  requireExactPrepareKeys(request, [
    'projectId',
    'expectedRevisionId',
    'serving'
  ], 'Service serving assignments request');
  const projectId = prepareId(request.projectId, 'Service project');
  const expectedRevisionId = prepareRevision(
    request.expectedRevisionId,
    'Expected service revision'
  );
  const current = await readExpectedProject({
    projectId,
    expectedRevisionId
  });
  const next = updateServicePlanningDetails(current.project, {
    serving: request.serving
  });
  const saved = await current.services.serviceProjectStore.save(next, {
    expectedRevisionId,
    reason: 'prepare-serving-assignments'
  });
  return projectResult(saved);
});

ipcMain.handle('prepare:projects:open', async (event, request = {}) => {
  requireControlSender(event);
  requirePrepareRequest(request, 16 * 1024);
  const projectId = prepareId(request.projectId, 'Service project');
  const revisionId = request.revisionId
    ? prepareRevision(request.revisionId, 'Service revision')
    : 'current';
  const services = getPrepareServices();
  const transactionRecovery = await services.sermonProjectCommitCoordinator.recover();
  const result = projectResult(
    await services.serviceProjectStore.read(projectId, { revisionId })
  );
  if (transactionRecovery.message && !result.recovery) {
    result.recovery = {
      source: 'sermon-project-transaction',
      message: transactionRecovery.message
    };
  }
  return result;
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
  const services = getPrepareServices();
  const selectedProject = await services.serviceProjectStore.read(projectId, {
    revisionId
  });
  if (isPowerPointCompanionProject(selectedProject.project)) {
    failMainOperation(
      'CURRENT_SERVICE_COMPANION_NOT_EXPORTABLE',
      'The PowerPoint sermon handoff references this computer’s exact loaded service and is not a portable native service.'
    );
  }
  const exported = await services.serviceProjectExchange.exportBundle(
    projectId,
    revisionId
  );
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
    sermonLibrary: imported.sermonLibrary,
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
  return communityIpcResult(() => communityStatusPayload({
    refreshCapabilities: true
  }));
});

ipcMain.handle('community:serviceDocuments:list', async (event, request = {}) => {
  requireControlSender(event);
  return communityIpcResult(() => serializeCommunityOperation(async () => {
    communityRequestKeys(request, ['cursor', 'limit'], 'Shared-service list request');
    const context = await communityServiceDocumentContext();
    const limit = Number.isSafeInteger(request.limit)
      ? Math.max(1, Math.min(50, request.limit))
      : 50;
    const page = await context.client.listServiceDocuments({
      cursor: request.cursor ?? null,
      limit,
      accessToken: context.connection.accessToken
    });
    const items = await Promise.all(page.items.map(async item => {
      const binding = await context.bindingStore.get(item.syncId);
      const pending = await context.outbox.get(
        context.connection.serverId,
        item.syncId
      );
      return {
        ...item,
        shared: publicServiceDocumentBinding(binding, pending)
      };
    }));
    return { ...page, items };
  }));
});

ipcMain.handle('community:serviceDocuments:state', async (event, request = {}) => {
  requireControlSender(event);
  return communityIpcResult(() => serializeCommunityOperation(async () => {
    communityRequestKeys(request, ['projectId'], 'Shared-service state request');
    const projectId = prepareId(request.projectId, 'Service project');
    const context = await communityServiceDocumentContext({
      refreshCapabilities: false
    });
    const binding = await context.bindingStore.get(projectId);
    const pending = binding
      ? await context.outbox.get(binding.serverId, binding.syncId)
      : null;
    return { shared: publicServiceDocumentBinding(binding, pending) };
  }));
});

ipcMain.handle('community:serviceDocuments:open', async (event, request = {}) => {
  requireControlSender(event);
  return communityIpcResult(() => serializeCommunityOperation(async () => {
    communityRequestKeys(
      request,
      ['syncId', 'resolution'],
      'Open shared-service request'
    );
    const syncId = prepareId(request.syncId, 'Shared service');
    const resolution = request.resolution ?? null;
    if (![null, 'use-community', 'keep-local'].includes(resolution)) {
      failMainOperation(
        'INVALID_SERVICE_DOCUMENT_RESOLUTION',
        'Choose whether to keep the local service or use Community.'
      );
    }
    const context = await communityServiceDocumentContext({
      requireWrite: resolution === 'keep-local'
    });
    const remote = await context.client.getServiceDocument({
      syncId,
      accessToken: context.connection.accessToken
    });
    const local = await readLocalServiceDocument(context.projectStore, syncId);
    if (!local) return installCommunityServiceDocument(context, remote, null);

    const binding = await context.bindingStore.get(syncId);
    if (resolution === 'use-community') {
      return installCommunityServiceDocument(context, remote, local);
    }
    if (resolution === 'keep-local') {
      const synchronized = await synchronizeLocalServiceDocument(
        context,
        local,
        {
          status: remote.status === 'ready' ? 'planning' : remote.status,
          base: {
            syncVersion: remote.syncVersion,
            revision: remote.revision,
            changedAt: remote.changedAt
          }
        }
      );
      return {
        ...synchronized,
        ...projectResult(local)
      };
    }

    if (local.documentSource === remote.documentSource) {
      // Reinstall the exact content-addressed assets as well as refreshing the
      // binding. Older builds could save matching JSON without the binaries.
      return installCommunityServiceDocument(context, remote, local);
    }
    if (!binding
      || binding.serverId !== context.connection.serverId
      || binding.syncId !== remote.syncId) {
      return serviceDocumentConflict({
        kind: binding ? 'different-community' : 'unbound-local-service',
        local,
        remote,
        binding
      });
    }
    const localChanged = local.documentRevision !== binding.documentRevision;
    const remoteChanged = remote.revision !== binding.documentRevision;
    if (!localChanged && remoteChanged) {
      return installCommunityServiceDocument(context, remote, local);
    }
    const pending = await context.outbox.get(
      context.connection.serverId,
      remote.syncId
    );
    if (localChanged && !remoteChanged) {
      return {
        state: pending ? 'queued' : 'local-newer',
        ...projectResult(local),
        shared: publicServiceDocumentBinding(binding, pending)
      };
    }
    return serviceDocumentConflict({
      kind: 'concurrent-change',
      local,
      remote,
      binding
    });
  }));
});

ipcMain.handle('community:serviceDocuments:save', async (event, request = {}) => {
  requireControlSender(event);
  return communityIpcResult(() => serializeCommunityOperation(async () => {
    communityRequestKeys(
      request,
      ['projectId', 'expectedRevisionId', 'status'],
      'Save shared-service request'
    );
    const context = await communityServiceDocumentContext({
      requireWrite: true,
      refreshCapabilities: false
    });
    const current = await readExpectedProject(request);
    const status = request.status === undefined
      ? 'planning'
      : communityText(request.status, 'Shared-service status', 16, {
          required: true
        });
    if (!['planning', 'ready', 'archived', 'cancelled'].includes(status)) {
      failMainOperation(
        'INVALID_SERVICE_DOCUMENT_STATUS',
        'That shared-service status is invalid.'
      );
    }
    const local = {
      ...current,
      documentSource: serviceDocumentSourceForProject(current.project)
    };
    local.documentRevision = heritageServiceDocumentRevision(
      local.documentSource
    );
    const binding = await context.bindingStore.get(current.projectId);
    if (binding && (binding.serverId !== context.connection.serverId
      || binding.syncId !== current.projectId)) {
      failMainOperation(
        'SERVICE_DOCUMENT_BINDING_MISMATCH',
        'This local service is linked to a different Community record.'
      );
    }
    const base = binding?.syncVersion > 0
      ? {
          syncVersion: binding.syncVersion,
          revision: binding.documentRevision,
          changedAt: binding.changedAt
        }
      : null;
    return synchronizeLocalServiceDocument(context, local, { status, base });
  }));
});

ipcMain.handle('community:serviceDocuments:flush', async (event, request = {}) => {
  requireControlSender(event);
  return communityIpcResult(() => serializeCommunityOperation(async () => {
    communityRequestKeys(request, [], 'Shared-service retry request');
    const context = await communityServiceDocumentContext({
      requireWrite: true,
      refreshCapabilities: false
    });
    const flushed = await context.sync.flush({
      accessToken: context.connection.accessToken
    });
    const results = [];
    for (const result of flushed) {
      if (result.state === 'synced') {
        const local = await readLocalServiceDocument(
          context.projectStore,
          result.syncId
        );
        if (local && local.documentSource === result.remote.documentSource) {
          const binding = await saveServiceDocumentBinding({
            ...context,
            localRevisionId: local.revisionId,
            remote: result.remote
          });
          results.push({
            state: 'synced',
            syncId: result.syncId,
            shared: publicServiceDocumentBinding(binding)
          });
          continue;
        }
      }
      if (result.state === 'conflict' && result.remote) {
        const local = await readLocalServiceDocument(
          context.projectStore,
          result.syncId
        );
        if (local) {
          results.push(serviceDocumentConflict({
            kind: 'concurrent-change',
            local,
            remote: result.remote,
            binding: result.base && {
              syncVersion: result.base.syncVersion,
              documentRevision: result.base.revision,
              localRevisionId: local.revisionId
            }
          }));
          continue;
        }
      }
      results.push({
        state: result.state,
        syncId: result.syncId,
        reason: result.reason || null
      });
    }
    return { results };
  }));
});

ipcMain.handle('community:servicePlans:list', async (event, request = {}) => {
  requireControlSender(event);
  return communityIpcResult(() => serializeCommunityOperation(async () => {
    communityRequestKeys(
      request,
      ['cursor', 'limit'],
      'Community service-plan list request'
    );
    const cursor = request.cursor === undefined || request.cursor === null
      ? null
      : communityText(
          request.cursor,
          'Community service-plan cursor',
          2048,
          { required: true }
        );
    const limit = request.limit === undefined
      ? 50
      : request.limit;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      failMainOperation(
        'INVALID_COMMUNITY_INPUT',
        'Community service-plan page size must be between 1 and 100.'
      );
    }
    const operationEpoch = communityOperationEpoch;
    const context = await communityServicePlanContext();
    const page = await context.client.listServicePlans({
      cursor,
      limit,
      accessToken: context.connection.accessToken
    });
    if (operationEpoch !== communityOperationEpoch) {
      failMainOperation(
        'COMMUNITY_OPERATION_CANCELLED',
        'The Community connection changed while service plans were loading.'
      );
    }
    return {
      connection: {
        id: context.connection.id,
        serverId: context.connection.serverId,
        serverName: context.connection.serverName
      },
      items: page.items,
      nextCursor: page.nextCursor,
      hasMore: page.hasMore
    };
  }));
});

ipcMain.handle('community:servicePlans:review', async (event, request = {}) => {
  requireControlSender(event);
  return communityIpcResult(() => serializeCommunityOperation(async () => {
    communityRequestKeys(
      request,
      ['syncId'],
      'Community service-plan review request'
    );
    const syncId = communityText(
      request.syncId,
      'Community service-plan sync ID',
      128,
      { required: true }
    );
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(syncId)) {
      failMainOperation(
        'INVALID_COMMUNITY_INPUT',
        'Community service-plan sync ID is invalid.'
      );
    }
    const operationEpoch = communityOperationEpoch;
    const context = await communityServicePlanContext();
    const envelope = await context.client.getServicePlan({
      syncId,
      accessToken: context.connection.accessToken
    });
    if (operationEpoch !== communityOperationEpoch) {
      failMainOperation(
        'COMMUNITY_OPERATION_CANCELLED',
        'The Community connection changed while this plan was being reviewed.'
      );
    }
    const options = communityServicePlanImportOptions();
    return communityServicePlanReviewResponse({
      context,
      envelope,
      options
    });
  }));
});

ipcMain.handle('community:servicePlans:checkProjectRevision', async (
  event,
  request = {}
) => {
  requireControlSender(event);
  return communityIpcResult(() => serializeCommunityOperation(async () => {
    communityRequestKeys(
      request,
      ['projectId', 'expectedRevisionId'],
      'Community project revision check request'
    );
    const projectId = prepareId(
      request.projectId,
      'Service project'
    );
    const expectedRevisionId = prepareRevision(
      request.expectedRevisionId,
      'Expected service revision'
    );
    const services = getPrepareServices();
    const readBoundProject = async () => {
      const current = await services.serviceProjectStore.read(projectId);
      if (current.revisionId !== expectedRevisionId) {
        failMainOperation(
          'PROJECT_CONFLICT',
          'This service changed since it was opened. Reload it before checking its Community revision.',
          {
            currentRevisionId: current.revisionId,
            expectedRevisionId
          }
        );
      }
      return current;
    };

    const current = await readBoundProject();
    const source = current.project.planning?.source;
    if (!source || source.kind !== 'community-plan') {
      failMainOperation(
        'COMMUNITY_SERVICE_PLAN_SOURCE_REQUIRED',
        'Only a service imported from Community can check its Community revision.'
      );
    }
    const serverId = prepareId(
      source.serverId,
      'Imported Community server'
    );
    const planId = prepareId(
      source.planId,
      'Imported Community service plan'
    );

    const operationEpoch = communityOperationEpoch;
    const context = await communityServicePlanContext();
    if (context.connection.serverId !== serverId) {
      failMainOperation(
        'COMMUNITY_SERVICE_PLAN_SERVER_MISMATCH',
        'This service came from a different Community server. Connect that server before checking its revision.'
      );
    }
    const envelope = await context.client.getServicePlan({
      syncId: planId,
      accessToken: context.connection.accessToken
    });
    if (operationEpoch !== communityOperationEpoch) {
      failMainOperation(
        'COMMUNITY_OPERATION_CANCELLED',
        'The Community connection changed while this plan revision was being checked.'
      );
    }

    // The remote review must remain bound to the exact local revision that
    // requested it. These current-pointer reads surround the coordinator
    // review as well as the GET boundary; the action never saves or restores
    // a project.
    await readBoundProject();
    const options = communityServicePlanImportOptions();
    const response = await communityServicePlanReviewResponse({
      context,
      envelope,
      options
    });
    await readBoundProject();
    if (response.proposal?.projectId !== projectId) {
      failMainOperation(
        'COMMUNITY_SERVICE_PLAN_PROJECT_MISMATCH',
        'The imported Community identity does not belong to this local service. Nothing was changed.'
      );
    }
    return response;
  }));
});

ipcMain.handle('community:servicePlans:prepare', async (event, request = {}) => {
  requireControlSender(event);
  return communityIpcResult(async () => {
    communityRequestKeys(
      request,
      ['preparationToken', 'confirmed'],
      'Community service-plan preparation request'
    );
    if (request.confirmed !== true) {
      failMainOperation(
        'SERVICE_PLAN_PREPARATION_CONFIRMATION_REQUIRED',
        'Confirm the exact reviewed plan items before preparing them locally.'
      );
    }
    const { token, preparation } =
      requireCommunityServicePlanPreparation(request.preparationToken);
    if (activeCommunityServicePlanPreparation) {
      failMainOperation(
        'COMMUNITY_SERVICE_PLAN_PREPARATION_BUSY',
        'Another Community service-plan preparation is already running.'
      );
    }
    const controller = new AbortController();
    activeCommunityServicePlanPreparation = { token, controller };
    const assertRequested = () => {
      if (controller.signal.aborted) {
        failMainOperation(
          'COMMUNITY_OPERATION_CANCELLED',
          'Community plan-item preparation was stopped or its connection changed. Safely completed items were kept.'
        );
      }
    };

    try {
      return await serializeCommunityOperation(async () => {
        assertRequested();
        let context;
        try {
          context = await communityServicePlanContext({
            refreshCapabilities: true
          });
        } catch (error) {
          assertRequested();
          throw error;
        }
        assertRequested();
        if (
          context.connection.id !== preparation.connectionId
          || context.connection.serverId !== preparation.serverId
        ) {
          communityServicePlanPreparations.delete(token);
          failMainOperation(
            'SERVICE_PLAN_PREPARATION_CONNECTION_CHANGED',
            'The Community connection changed. Review this exact plan again before preparing its items.'
          );
        }
        const currentOptions = communityServicePlanImportOptions();
        if (
          communityServicePlanImportOptionsKey(currentOptions)
            !== preparation.optionsKey
        ) {
          communityServicePlanPreparations.delete(token);
          failMainOperation(
            'SERVICE_PLAN_PREPARATION_PROFILE_CHANGED',
            'The venue profile changed. Review this exact plan again for the current outputs.'
          );
        }

        communitySyncAbortController?.abort();
        communitySyncAbortController = controller;
        const epoch = ++communityOperationEpoch;
        const assertCurrent = () => {
          if (
            controller.signal.aborted
            || epoch !== communityOperationEpoch
          ) {
            failMainOperation(
              'COMMUNITY_OPERATION_CANCELLED',
              'Community plan-item preparation was stopped or its connection changed. Safely completed items were kept.'
            );
          }
        };
        const freshResponse = async (envelope, inspected = null) => {
          communityServicePlanPreparations.delete(token);
          return communityServicePlanReviewResponse({
            context,
            envelope,
            options: preparation.options,
            inspected
          });
        };

        try {
          const before = await context.client.getServicePlan({
            syncId: preparation.envelope.syncId,
            accessToken: context.connection.accessToken,
            signal: controller.signal
          });
          assertCurrent();
          const coordinator = communityServicePlanCoordinator(context);
          const inspectedBefore = applyCommunityServicePlanStalePins(
            await coordinator.review(before, preparation.options),
            knownCommunityServicePlanStalePins(context, before)
          );
          assertCurrent();
          if (!sameCommunityServicePlanEnvelope(before, preparation.envelope)) {
            return freshResponse(before, inspectedBefore);
          }
          if (inspectedBefore.proposal.status === 'ready-to-import') {
            return freshResponse(before, inspectedBefore);
          }
          const originalDependencyKeys = new Set(
            preparation.dependencies.map(dependency =>
              communityServicePlanDependencyKey([dependency])
            )
          );
          const remainingDependencies =
            inspectedBefore.preparationDependencies;
          if (
            remainingDependencies.length < 1
            || remainingDependencies.some(dependency =>
              !originalDependencyKeys.has(
                communityServicePlanDependencyKey([dependency])
              ))
          ) {
            return freshResponse(before, inspectedBefore);
          }

          requireCommunityServicePlanPreparationScopes(
            context.connection,
            remainingDependencies
          );
          let songSync = null;
          let sermonSync = null;
          for (const dependency of remainingDependencies) {
            assertCurrent();
            let result;
            try {
              if (dependency.kind === 'song') {
                songSync ||= await communitySyncForConnection(
                  context.connection
                );
                result = await songSync.pullSong(dependency.syncId, {
                  expectedSyncVersion: dependency.expectedSyncVersion,
                  expectedRevision: dependency.expectedRevision,
                  signal: controller.signal
                });
              } else {
                sermonSync ||= await communitySermonSyncForConnection(
                  context.connection
                );
                result = await sermonSync.pullSermon(dependency.syncId, {
                  expectedSyncVersion: dependency.expectedSyncVersion,
                  expectedRevision: dependency.expectedRevision,
                  signal: controller.signal
                });
              }
            } catch (error) {
              assertCurrent();
              if (error?.code === 'REMOTE_PRECONDITION_FAILED') {
                rememberCommunityServicePlanStalePin({
                  context,
                  envelope: preparation.envelope,
                  dependency
                });
                continue;
              }
              if (requireCommunityReconnectFor(error)) {
                await notifyCommunityStatusChanged();
              }
              throw error;
            }
            assertCurrent();
            if (result?.status === 'offline') {
              failMainOperation(
                'COMMUNITY_SERVICE_PLAN_PREPARATION_OFFLINE',
                'The exact plan items could not all be checked while Community was offline. Successfully prepared items were kept; retry this same action after reconnecting.'
              );
            }
          }

          const after = await context.client.getServicePlan({
            syncId: preparation.envelope.syncId,
            accessToken: context.connection.accessToken,
            signal: controller.signal
          });
          assertCurrent();
          if (
            communityServicePlanImportOptionsKey(
              communityServicePlanImportOptions()
            ) !== preparation.optionsKey
          ) {
            communityServicePlanPreparations.delete(token);
            failMainOperation(
              'SERVICE_PLAN_PREPARATION_PROFILE_CHANGED',
              'The venue profile changed while plan items were being prepared. Review the plan again for the current outputs.'
            );
          }
          const inspectedAfter = applyCommunityServicePlanStalePins(
            await coordinator.review(after, preparation.options),
            knownCommunityServicePlanStalePins(context, after)
          );
          assertCurrent();
          await notifyCommunityStatusChanged();
          return freshResponse(after, inspectedAfter);
        } catch (error) {
          assertCurrent();
          throw error;
        } finally {
          if (communitySyncAbortController === controller) {
            communitySyncAbortController = null;
          }
        }
      });
    } finally {
      if (
        activeCommunityServicePlanPreparation?.controller
          === controller
      ) {
        activeCommunityServicePlanPreparation = null;
      }
    }
  });
});

ipcMain.handle('community:servicePlans:prepareCancel', async (
  event,
  request = {}
) => {
  requireControlSender(event);
  return communityIpcResult(async () => {
    communityRequestKeys(
      request,
      ['preparationToken'],
      'Community service-plan preparation cancellation request'
    );
    const preparationToken = communityText(
      request.preparationToken,
      'Community service-plan preparation',
      64,
      { required: true }
    );
    if (
      !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(
        preparationToken
      )
    ) {
      failMainOperation(
        'INVALID_SERVICE_PLAN_PREPARATION',
        'That Community service-plan preparation is invalid.'
      );
    }
    const active = activeCommunityServicePlanPreparation;
    if (!active || active.token !== preparationToken) {
      return { cancelled: false };
    }
    active.controller.abort();
    return { cancelled: true };
  });
});

ipcMain.handle('community:servicePlans:import', async (event, request = {}) => {
  requireControlSender(event);
  return communityIpcResult(() => serializeCommunityOperation(async () => {
    communityRequestKeys(
      request,
      ['reviewToken', 'confirmed'],
      'Community service-plan import request'
    );
    if (request.confirmed !== true) {
      failMainOperation(
        'SERVICE_PLAN_IMPORT_CONFIRMATION_REQUIRED',
        'Confirm the exact reviewed Community plan before importing it.'
      );
    }
    const { token, review } = requireCommunityServicePlanReview(
      request.reviewToken
    );
    const context = await communityServicePlanContext({
      refreshCapabilities: false
    });
    if (context.connection.id !== review.connectionId
      || context.connection.serverId !== review.serverId) {
      communityServicePlanReviews.delete(token);
      failMainOperation(
        'SERVICE_PLAN_REVIEW_CONNECTION_CHANGED',
        'The Community connection changed. Review this exact plan again before importing it.'
      );
    }
    const currentOptions = communityServicePlanImportOptions();
    if (communityServicePlanImportOptionsKey(currentOptions)
      !== review.optionsKey) {
      communityServicePlanReviews.delete(token);
      failMainOperation(
        'SERVICE_PLAN_REVIEW_PROFILE_CHANGED',
        'The venue profile changed. Review this exact plan again for the current outputs before importing it.'
      );
    }
    // A failed import leaves the exact reviewed envelope available for a safe
    // retry until its original expiry. Once the coordinator confirms either a
    // create or same-revision idempotent result, consume the human approval so
    // it cannot authorize another action.
    const imported = await communityServicePlanCoordinator(context)
      .importPlan(review.envelope, review.options);
    communityServicePlanReviews.delete(token);
    return {
      ...projectResult(imported),
      importStatus: imported.status
    };
  }));
});

ipcMain.handle('community:servicePlans:replace', async (
  event,
  request = {}
) => {
  requireControlSender(event);
  return communityIpcResult(() => serializeCommunityOperation(async () => {
    communityRequestKeys(
      request,
      ['replacementToken', 'confirmed', 'decisions'],
      'Community service-plan reconciliation request'
    );
    if (request.confirmed !== true) {
      failMainOperation(
        'SERVICE_PLAN_REPLACEMENT_CONFIRMATION_REQUIRED',
        'Confirm the reviewed Community reconciliation before saving a new local Planning revision.'
      );
    }
    const { token, replacement } =
      requireCommunityServicePlanReplacement(request.replacementToken);
    const consumeAndFail = (code, message) => {
      communityServicePlanReplacements.delete(token);
      failMainOperation(code, message);
    };
    const context = await communityServicePlanContext({
      refreshCapabilities: false
    });
    if (
      context.connection.id !== replacement.connectionId
      || context.connection.serverId !== replacement.serverId
    ) {
      consumeAndFail(
        'SERVICE_PLAN_REPLACEMENT_CONNECTION_CHANGED',
        'The Community connection changed. Check this exact revision again before replacing the local Planning project.'
      );
    }
    const currentOptions = communityServicePlanImportOptions();
    if (
      communityServicePlanImportOptionsKey(currentOptions)
        !== replacement.optionsKey
    ) {
      consumeAndFail(
        'SERVICE_PLAN_REPLACEMENT_PROFILE_CHANGED',
        'The venue profile changed. Check this exact Community revision again for the current outputs.'
      );
    }

    const envelope = await context.client.getServicePlan({
      syncId: replacement.planId,
      accessToken: context.connection.accessToken
    });
    if (envelope.status !== 'ready') {
      consumeAndFail(
        'SERVICE_PLAN_REPLACEMENT_NOT_READY',
        'The Community plan is no longer Ready. Nothing was replaced; check its current lifecycle and revision again.'
      );
    }
    if (!sameCommunityServicePlanEnvelope(envelope, replacement.envelope)) {
      consumeAndFail(
        'STALE_SERVICE_PLAN_REPLACEMENT',
        'The Community plan changed after this replacement was reviewed. Nothing was replaced; check the current revision again.'
      );
    }

    const coordinator = communityServicePlanCoordinator(context);
    const inspected = await coordinator.review(
      envelope,
      replacement.options
    );
    const proposal = inspected.proposal;
    if (proposal.status === 'blocked') {
      consumeAndFail(
        'SERVICE_PLAN_REPLACEMENT_BLOCKED',
        'The reviewed Community revision can no longer form an exact local Planning project. Nothing was replaced; check its blockers again.'
      );
    }
    if (
      proposal.status !== 'newer-revision'
      || proposal.projectId !== replacement.localProjectId
      || proposal.revisionId !== replacement.localRevisionId
      || proposal.planRevision !== replacement.remoteRevision
      || envelope.syncVersion !== replacement.remoteSyncVersion
      || communityServicePlanReplacementProposalKey(proposal)
        !== replacement.proposalKey
    ) {
      consumeAndFail(
        proposal.revisionId !== replacement.localRevisionId
          ? 'LOCAL_PROJECT_CHANGED'
          : 'STALE_SERVICE_PLAN_REPLACEMENT',
        proposal.revisionId !== replacement.localRevisionId
          ? 'The local Planning project changed after review. Nothing was replaced; check the Community revision again.'
          : 'The reviewed replacement is stale. Nothing was replaced; check the exact Community and local revisions again.'
      );
    }

    const decisions = prepareCommunityServicePlanReconciliationDecisions(
      request.decisions,
      proposal
    );
    let replaced;
    try {
      replaced = await coordinator.replacePlanRevision(
        envelope,
        replacement.options,
        {
          expectedRevisionId: replacement.localRevisionId,
          decisions,
          expectedReconciliation: {
            mode: proposal.reconciliation.mode,
            baselineProjectionSha256:
              proposal.reconciliation.baselineProjectionSha256,
            candidateProjectionSha256:
              proposal.reconciliation.candidateProjectionSha256,
            mergeResultSha256:
              proposal.reconciliation.mergeResultSha256
          }
        }
      );
    } catch (error) {
      if ([
        'LOCAL_PROJECT_CHANGED',
        'PLAN_REPLACEMENT_BLOCKED',
        'PLAN_REPLACEMENT_NOT_READY',
        'PLAN_REPLACEMENT_STALE',
        'PLAN_RECONCILIATION_STALE',
        'COMMUNITY_PLAN_RECONCILIATION_DECISIONS_REQUIRED',
        'INVALID_COMMUNITY_PLAN_RECONCILIATION_DECISIONS',
        'LEGACY_PLAN_REPLACEMENT_CONFIRMATION_REQUIRED'
      ].includes(error?.code)) {
        communityServicePlanReplacements.delete(token);
      }
      throw error;
    }
    communityServicePlanReplacements.delete(token);
    return {
      ...projectResult(replaced),
      replacementStatus: replaced.status,
      previousRevisionId: replaced.previousRevisionId
    };
  }));
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
    const existing = await currentCommunityConnectionSummary({
      refreshCapabilities: true
    });
    if (existing
      && !communityConnectionExpired(existing)
      && !communityReconnectRequired
      && sameCommunityScopes(existing.scopes, existing.advertisedScopes)) {
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
    let requestedScopes;
    try {
      discovery = await client.discover({ signal: controller.signal });
      requestedScopes = communityAuthorizationScopes(discovery);
      authorization = await client.startDeviceAuthorization({
        email,
        deviceName: `SyncShow on ${os.hostname()}`.slice(0, 120),
        scopes: requestedScopes,
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
      requestedScopes,
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
    const requestedScopes = pending.requestedScopes;
    if (requestedScopes.some(scope => !grant.scopes.includes(scope))) {
      await pending.client.revokeAccessToken({
        accessToken: grant.accessToken
      }).catch(() => {});
      failMainOperation(
        'COMMUNITY_SCOPE_UNAVAILABLE',
        'The approved Community account did not grant every advertised SyncShow resource scope.'
      );
    }
    const grantedScopes = grant.scopes.filter(scope => requestedScopes.includes(scope));

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
      clearCommunitySermonMediaOperationState();
      await connectionStore.disconnect(connectionId);
      connectionId = null;
    }
    let savedConnection;
    try {
      savedConnection = await connectionStore.saveConnection({
        ...(connectionId ? { id: connectionId } : {}),
        serverId: pending.discovery.serverId,
        serverName: pending.discovery.serverName,
        baseUrl: pending.discovery.baseUrl,
        apiBaseUrl: pending.discovery.apiBaseUrl,
        account: grant.account,
        scopes: grantedScopes,
        advertisedScopes: requestedScopes,
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
    communityLastSermonSyncSummary = null;
    communityReconnectRequired = null;
    communityCapabilityWarning = null;
    songSharingReviewProposals.clear();
    songPublicLinkReviewProposals.clear();
    songPublicLinkActions.clear();
    clearCommunityServicePlanAuthorities();
    await notifyCommunityStatusChanged();
    if (savedConnection.canReadSongs) {
      scheduleCommunitySongSync('new connection', 250);
      scheduleCommunityPeriodicSync({ resetBackoff: true });
    } else {
      clearCommunitySyncTimer();
      clearCommunityPeriodicSync({ resetBackoff: true });
    }
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
  songSharingReviewProposals.clear();
  songPublicLinkReviewProposals.clear();
  songPublicLinkActions.clear();
  clearCommunityServicePlanAuthorities();
  await pauseCommunitySermonMediaUploads();
  clearCommunitySermonMediaOperationState();
  return communityIpcResult(() => serializeCommunityOperation(async () => {
    await cancelPendingCommunityAuthorizations();
    const summary = await currentCommunityConnectionSummary();
    if (!summary) {
      communityLastSyncSummary = null;
      communityLastSermonSyncSummary = null;
      communityReconnectRequired = null;
      communityCapabilityWarning = null;
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
    communityLastSermonSyncSummary = null;
    communityReconnectRequired = null;
    communityCapabilityWarning = null;
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

ipcMain.handle('community:sermons:sync', async (event) => {
  requireControlSender(event);
  return communityIpcResult(() => serializeCommunityOperation(async () => {
    const summary = await runCommunitySermonPull();
    return { summary, lastSync: summary };
  }));
});

ipcMain.handle('community:sermons:getState', async (event, request = {}) => {
  requireControlSender(event);
  return communityIpcResult(async () => {
    communityRequestKeys(
      request,
      ['sermonId'],
      'Sermon state request'
    );
    const sermonId = prepareSermonDomainId(request.sermonId, 'Sermon');
    return { sermonState: await communitySermonStatePayload(sermonId) };
  });
});

ipcMain.handle('community:sermons:openPublicationManager', async (
  event,
  request = {}
) => {
  requireControlSender(event);
  return communityIpcResult(() => serializeCommunityOperation(async () => {
    communityRequestKeys(
      request,
      ['sermonId', 'expectedLocalRevision'],
      'Sermon publication manager request'
    );
    const sermonId = prepareSermonDomainId(request.sermonId, 'Sermon');
    const expectedLocalRevision = prepareRevision(
      request.expectedLocalRevision,
      'Expected local sermon revision'
    );
    return openCommunitySermonPublicationManager({
      sermonId,
      expectedLocalRevision
    });
  }));
});

ipcMain.handle('community:sermons:verifyPublication', async (event, request = {}) => {
    requireControlSender(event);
    return communityIpcResult(async () => {
      communityRequest(request);
      communityRequestKeys(
        request,
        ['sermonId'],
        'Sermon publication verification request'
      );
      const sermonId = prepareSermonDomainId(request.sermonId, 'Sermon');
      return communitySermonPublicationVerificationPayload(sermonId);
    });
});

ipcMain.handle('community:sermons:getConflict', async (event, request = {}) => {
  requireControlSender(event);
  return communityIpcResult(async () => {
    communityRequest(request);
    const sermonId = prepareSermonDomainId(request.sermonId, 'Sermon');
    return {
      conflict: await communitySermonConflictPayload(sermonId)
    };
  });
});

ipcMain.handle('community:sermons:resolveConflict', async (event, request = {}) => {
  requireControlSender(event);
  return communityIpcResult(() => serializeCommunityOperation(async () => {
    communityRequest(request);
    const sermonId = prepareSermonDomainId(request.sermonId, 'Sermon');
    const strategy = communityText(
      request.strategy,
      'Community sermon conflict choice',
      32,
      { required: true }
    );
    if (!['keep-local', 'keep-remote'].includes(strategy)) {
      failMainOperation(
        'INVALID_COMMUNITY_RESOLUTION',
        'Choose either this Mac’s sermon or the Community sermon.'
      );
    }
    if (!Number.isSafeInteger(request.expectedSyncVersion)
      || request.expectedSyncVersion < 1) {
      failMainOperation(
        'COMMUNITY_RESOLUTION_STALE',
        'Reload this sermon conflict before choosing a copy.'
      );
    }
    const expectedLocalRevision = prepareRevision(
      request.expectedLocalRevision,
      'Expected local sermon revision'
    );
    const conflict = await communitySermonConflictPayload(sermonId);
    if (conflict.expectedSyncVersion !== request.expectedSyncVersion
      || conflict.expectedLocalRevision !== expectedLocalRevision) {
      failMainOperation(
        'COMMUNITY_RESOLUTION_STALE',
        'The sermon changed. Reload both copies before choosing one.'
      );
    }

    const connection = await currentCommunityConnectionSummary();
    if (!connection) {
      failMainOperation(
        'COMMUNITY_RECONNECT_REQUIRED',
        'Reconnect Heritage Community before resolving this sermon conflict.'
      );
    }
    if (strategy === 'keep-local') {
      if (communityReconnectRequired || communityConnectionExpired(connection)) {
        failMainOperation(
          'COMMUNITY_RECONNECT_REQUIRED',
          communityReconnectRequired?.message
            || 'Reconnect Heritage Community before replacing its sermon copy.'
        );
      }
      if (!connection.canWriteSermons) {
        failMainOperation(
          'COMMUNITY_READ_ONLY',
          'This Community approval cannot replace the Community sermon copy.'
        );
      }
    }

    communitySyncAbortController?.abort();
    const controller = new AbortController();
    communitySyncAbortController = controller;
    const epoch = ++communityOperationEpoch;
    let resolved;
    try {
      const sync = await communitySermonSyncForConnection(connection);
      try {
        resolved = await sync.resolveConflict(sermonId, {
          strategy,
          expectedSyncVersion: request.expectedSyncVersion,
          expectedLocalRevision,
          signal: controller.signal
        });
      } catch (error) {
        if (requireCommunityReconnectFor(error)) {
          await notifyCommunityStatusChanged();
        }
        throw error;
      }
      if (controller.signal.aborted || epoch !== communityOperationEpoch) {
        failMainOperation(
          'COMMUNITY_SYNC_CANCELLED',
          'Community sermon conflict resolution was cancelled.'
        );
      }
    } finally {
      if (communitySyncAbortController === controller) {
        communitySyncAbortController = null;
      }
    }

    communityLastSermonSyncSummary = completeCommunitySyncSummary({
      resource: 'sermons',
      status: resolved.resolved === true ? 'synced' : 'conflict',
      operation: resolved.resolved === true ? 'resolved' : 'conflict',
      conflicts: resolved.resolved === true ? 0 : 1,
      syncId: sermonId,
      syncVersion: resolved.syncVersion,
      warnings: resolved.resolved === true
        ? []
        : [{
            code: resolved.warningCode || 'CONFLICT_RETAINED',
            syncId: sermonId,
            message: 'Community changed again; both sermon revisions remain preserved.'
          }]
    });
    await notifyCommunityStatusChanged();
    return {
      resolved,
      sermonState: await communitySermonStatePayload(sermonId),
      lastSync: communityLastSermonSyncSummary
    };
  }));
});

ipcMain.handle('community:sermons:push', async (event, request = {}) => {
  requireControlSender(event);
  return communityIpcResult(() => serializeCommunityOperation(async () => {
    communityRequest(request);
    const sermonId = prepareSermonDomainId(request.sermonId, 'Sermon');
    const expectedSyncVersion = request.expectedSyncVersion;
    const expectedLocalRevision = prepareRevision(
      request.expectedLocalRevision,
      'Expected local sermon revision'
    );
    if (!Object.hasOwn(request, 'expectedSyncVersion')
      || (expectedSyncVersion !== null
        && (!Number.isSafeInteger(expectedSyncVersion) || expectedSyncVersion < 1))) {
      failMainOperation(
        'INVALID_COMMUNITY_VERSION',
        'Reload this sermon before saving it to Community.'
      );
    }
    const summary = await runCommunitySermonPush({
      sermonId,
      expectedSyncVersion,
      expectedLocalRevision
    });
    return {
      summary,
      sermonState: await communitySermonStatePayload(sermonId),
      lastSync: summary
    };
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
    if (strategy === 'keep-local' && !connection?.canWriteSongs) {
      failMainOperation(
        'COMMUNITY_READ_ONLY',
        'This Community approval cannot replace the Community copy with local song content.'
      );
    }
    if (strategy === 'keep-remote' && !connection?.canReadSongs) {
      failMainOperation(
        'COMMUNITY_PERMISSION_DENIED',
        'This Community approval cannot read the shared song copy.'
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

ipcMain.handle('community:songs:listPublicLinks', async (event, request = {}) => {
  requireControlSender(event);
  return communityIpcResult(() => serializeCommunityOperation(async () => {
    communityRequestKeys(request, ['songId'], 'Public-link list request');
    const songId = prepareId(request.songId, 'Song');
    const connection = await requireCommunitySongPublicLinkConnection();
    const local = await resolveCommunitySongFamily(songId);
    const { stateStore } = await getCommunityServices();
    const state = await stateStore.getConnectionState(connection.id);
    const song = findCommunitySongState(state, local.familyId, local.songId);
    const songSyncId = song?.syncId || local.familyId;
    const { client, accessToken } = await communitySongPublicLinkClient(
      connection
    );
    const links = [];
    let cursor = null;
    let hasMore = false;
    const seenCursors = new Set();
    const seenLinkIds = new Set();
    for (let pageNumber = 0; pageNumber < 4; pageNumber += 1) {
      let page;
      try {
        page = await client.listSongPublicLinks({
          songSyncId,
          cursor,
          limit: 50,
          accessToken
        });
      } catch (error) {
        if (requireCommunityReconnectFor(error)) {
          await notifyCommunityStatusChanged();
        }
        throw error;
      }
      const pageItems = Array.isArray(page?.items)
        ? page.items
        : (Array.isArray(page?.links) ? page.links : []);
      for (const link of pageItems) {
        if (seenLinkIds.has(link.linkId)) {
          failMainOperation(
            'INVALID_PUBLIC_LINK_RESPONSE',
            'Heritage Community returned a duplicate public-link identity.'
          );
        }
        seenLinkIds.add(link.linkId);
      }
      links.push(...pageItems);
      hasMore = page?.hasMore === true;
      if (!hasMore) break;
      if (typeof page.nextCursor !== 'string'
        || !page.nextCursor
        || page.nextCursor === cursor
        || seenCursors.has(page.nextCursor)) {
        failMainOperation(
          'INVALID_PUBLIC_LINK_CURSOR',
          'Heritage Community did not advance the public-link list safely.'
        );
      }
      seenCursors.add(page.nextCursor);
      cursor = page.nextCursor;
    }
    if (hasMore) {
      failMainOperation(
        'PUBLIC_LINK_PAGE_LIMIT',
        'This song has too many public links to review safely in SyncShow. Manage older links in Heritage Community admin.'
      );
    }
    const projected = links.map(link => {
      const actionToken = holdSongPublicLinkAction({
        connectionId: connection.id,
        songId: local.songId,
        currentFamilyRevision: local.familyRevision,
        link
      });
      return publicSongPublicLink(link, {
        actionToken,
        currentFamilyRevision: local.familyRevision
      });
    });
    let createBlockedReason = null;
    if (!connection.canWriteSongPublicLinks) {
      createBlockedReason =
        'This Community approval may view links but cannot create another one.';
    } else if (!song || !Number.isSafeInteger(song.syncVersion)) {
      createBlockedReason =
        'Sync this exact song family to Heritage Community before creating a link.';
    } else if (song.archived) {
      createBlockedReason =
        'The Community song is archived. Existing links remain listed, but a new one cannot be created.';
    } else if (song.conflict) {
      createBlockedReason =
        'Resolve the song-content conflict before creating a link for another exact version.';
    }
    return {
      links: projected,
      hasMore,
      canCreate: createBlockedReason === null,
      createBlockedReason
    };
  }));
});

ipcMain.handle('community:songs:beginPublicLinkReview', async (
  event,
  request = {}
) => {
  requireControlSender(event);
  return communityIpcResult(() => serializeCommunityOperation(async () => {
    communityRequestKeys(
      request,
      ['songId'],
      'Public-link review request'
    );
    const songId = prepareId(request.songId, 'Song');
    const connection = await requireCommunitySongPublicLinkConnection({
      write: true
    });
    const local = await resolveCommunitySongFamily(songId);
    const { stateStore } = await getCommunityServices();
    const state = await stateStore.getConnectionState(connection.id);
    const song = findCommunitySongState(state, local.familyId, local.songId);
    if (!song || !Number.isSafeInteger(song.syncVersion)) {
      failMainOperation(
        'COMMUNITY_SONG_NOT_SYNCED',
        'Sync this exact song family to Heritage Community before creating a public link.'
      );
    }
    if (song.archived) {
      failMainOperation(
        'COMMUNITY_SONG_ARCHIVED',
        'The Community song is archived and cannot receive another public link.'
      );
    }
    if (song.conflict) {
      failMainOperation(
        'SONG_SYNC_CONFLICT',
        'Resolve the song-content conflict before creating a link for another exact version.'
      );
    }
    let remote;
    try {
      ({ remote } = await exactCommunitySongForPublicLink(
        connection,
        local,
        { expectedSyncId: song.syncId }
      ));
    } catch (error) {
      if (requireCommunityReconnectFor(error)) {
        await notifyCommunityStatusChanged();
      }
      throw error;
    }
    const review = Object.hasOwn(
      state.songPublicLinkReviews,
      local.familyId
    )
      ? state.songPublicLinkReviews[local.familyId]
      : null;
    const { proposalToken, entry } = holdSongPublicLinkReviewProposal({
      connectionId: connection.id,
      songId: local.songId,
      familyId: local.familyId,
      familyRevision: local.familyRevision,
      songSyncId: remote.syncId,
      songSyncVersion: remote.syncVersion,
      expectedReviewRevision: songPublicLinkReviewRevision(review)
    });
    return {
      proposalToken,
      expiresAt: new Date(entry.expiresAt).toISOString(),
      family: {
        ...local.family,
        revision: local.familyRevision,
        documents: local.family.documents.map(document => ({
          ...document,
          authors: [...document.authors],
          translators: [...document.translators],
          composers: [...document.composers]
        }))
      },
      publicLinkReview: review
        ? {
            scope: review.scope,
            basis: review.basis,
            evidence: review.evidence,
            validUntil: review.validUntil,
            validThrough: review.validThrough || null,
            reviewedAt: review.reviewedAt,
            familyRevision: review.familyRevision,
            status: songPublicLinkReviewStatus(review, {
              familyRevision: local.familyRevision,
              now: new Date()
            })
          }
        : { status: 'missing' }
    };
  }));
});

ipcMain.handle('community:songs:createPublicLink', async (
  event,
  request = {}
) => {
  requireControlSender(event);
  return communityIpcResult(() => serializeCommunityOperation(async () => {
    communityRequestKeys(request, [
      'proposalToken',
      'label',
      'basis',
      'evidence',
      'validUntil',
      'expiresAt',
      'confirmed'
    ], 'Public-link creation request');
    const { proposalToken, entry } = requireSongPublicLinkReviewProposal(
      request.proposalToken
    );
    if (request.confirmed !== true) {
      failMainOperation(
        'SONG_PUBLIC_LINK_REVIEW_REQUIRED',
        'Confirm that the evidence permits anonymous access to every listed version.'
      );
    }
    const label = communityText(
      request.label,
      'Public-link purpose',
      120
    ) || null;
    const basis = communityText(
      request.basis,
      'Public-link permission basis',
      40,
      { required: true }
    );
    if (!SONG_PUBLIC_LINK_REVIEW_BASES.includes(basis)) {
      failMainOperation(
        'INVALID_PUBLIC_LINK_REVIEW',
        'Choose how anonymous public-link access is permitted for this exact family.'
      );
    }
    const evidence = communityText(
      request.evidence,
      'Public-link permission evidence',
      1000,
      { required: true }
    );
    const validUntil = communityText(
      request.validUntil,
      'Public-link review date',
      10
    ) || null;
    let linkExpiresAt = null;
    if (request.expiresAt !== null
      && request.expiresAt !== undefined
      && request.expiresAt !== '') {
      const value = communityText(
        request.expiresAt,
        'Public-link expiry',
        40,
        { required: true }
      );
      if (!Number.isFinite(Date.parse(value))) {
        failMainOperation(
          'INVALID_PUBLIC_LINK_EXPIRY',
          'Choose a valid public-link expiry date and time.'
        );
      }
      linkExpiresAt = new Date(value).toISOString();
      if (Date.parse(linkExpiresAt) <= Date.now()) {
        failMainOperation(
          'INVALID_PUBLIC_LINK_EXPIRY',
          'Choose a public-link expiry in the future.'
        );
      }
    }
    const reviewValidationNow = new Date();
    const recoveringCreate = entry.createRequestStarted === true;
    let preflightReview;
    let reviewStatus;
    try {
      if (recoveringCreate) {
        if (!entry.confirmedReview
          || !entry.confirmedReviewRevision
          || !entry.createIntent) {
          failMainOperation(
            'SONG_PUBLIC_LINK_RETRY_MISMATCH',
            'The exact public-link retry state is no longer available. Refresh the link list and open a fresh review.'
          );
        }
        preflightReview = songPublicLinkReviewForRetry(
          entry.confirmedReview,
          {
            basis,
            evidence,
            validUntil,
            familyRevision: entry.familyRevision
          }
        );
      } else {
        preflightReview = createSongPublicLinkReview({
          basis,
          evidence,
          validUntil
        }, {
          familyRevision: entry.familyRevision,
          reviewedAt: reviewValidationNow.toISOString()
        });
      }
      reviewStatus = songPublicLinkReviewStatus(preflightReview, {
        familyRevision: entry.familyRevision,
        now: reviewValidationNow,
        expiresAt: linkExpiresAt
      });
    } catch (error) {
      failMainOperation(
        error?.code || 'INVALID_PUBLIC_LINK_REVIEW',
        error?.message || 'The public-link review is invalid.'
      );
    }
    if (reviewStatus === 'expired') {
      failMainOperation(
        'INVALID_PUBLIC_LINK_REVIEW',
        'The public-link review date has already passed.'
      );
    }
    if (reviewStatus === 'nonexpiring-after-review') {
      failMainOperation(
        'INVALID_PUBLIC_LINK_EXPIRY',
        'A dated permission review requires a link expiry no later than that date.'
      );
    }
    if (reviewStatus === 'link-after-review') {
      failMainOperation(
        'INVALID_PUBLIC_LINK_EXPIRY',
        'The public link cannot outlive the permission review.'
      );
    }
    const requestedIntent = Object.freeze({
      label,
      basis,
      evidence,
      validUntil,
      expiresAt: linkExpiresAt
    });
    const heldRequestedIntent = entry.createIntent
      ? {
          label: entry.createIntent.label,
          basis: entry.createIntent.basis,
          evidence: entry.createIntent.evidence,
          validUntil: entry.createIntent.validUntil,
          expiresAt: entry.createIntent.expiresAt
        }
      : null;
    if (heldRequestedIntent
      && JSON.stringify(heldRequestedIntent)
        !== JSON.stringify(requestedIntent)) {
      failMainOperation(
        'SONG_PUBLIC_LINK_RETRY_MISMATCH',
        'Retry this public link with the same purpose, evidence, and dates, or open a fresh review.'
      );
    }
    const createIntent = entry.createIntent || Object.freeze({
      ...requestedIntent,
      validThrough: preflightReview.validThrough
    });

    entry.applying = true;
    try {
      const connection = await requireCommunitySongPublicLinkConnection({
        write: true
      });
      if (connection.id !== entry.connectionId) {
        failMainOperation(
          'COMMUNITY_RECONNECT_REQUIRED',
          'The Community connection changed. Open a fresh public-link review.'
        );
      }
      const local = await resolveCommunitySongFamily(entry.songId);
      if (local.familyId !== entry.familyId
        || local.familyRevision !== entry.familyRevision) {
        failMainOperation(
          'SONG_PUBLIC_LINK_REVIEW_STALE',
          'The song family changed after this review opened. Review every current version again.'
        );
      }
      const { stateStore } = await getCommunityServices();
      const currentState = await stateStore.getConnectionState(connection.id);
      const currentReview = Object.hasOwn(
        currentState.songPublicLinkReviews,
        local.familyId
      )
        ? currentState.songPublicLinkReviews[local.familyId]
        : null;
      const expectedCurrentReviewRevision =
        entry.confirmedReviewRevision || entry.expectedReviewRevision;
      if (songPublicLinkReviewRevision(currentReview)
        !== expectedCurrentReviewRevision) {
        failMainOperation(
          'SONG_PUBLIC_LINK_REVIEW_STALE',
          'The saved public-link review changed after this window opened.'
        );
      }
      const currentSong = findCommunitySongState(
        currentState,
        local.familyId,
        local.songId
      );
      if (!currentSong || currentSong.syncId !== entry.songSyncId) {
        failMainOperation(
          'STATE_CONFLICT',
          'The Community song identity changed after this review opened.'
        );
      }
      if (currentSong.conflict) {
        failMainOperation(
          'SONG_SYNC_CONFLICT',
          'The song developed a content conflict. Resolve it before creating another link.'
        );
      }
      const { client, accessToken, remote } =
        await exactCommunitySongForPublicLink(connection, local, {
          expectedSyncId: entry.songSyncId,
          expectedSyncVersion: entry.songSyncVersion
        });
      let confirmedReview = entry.confirmedReview || null;
      let confirmedReviewRevision = entry.confirmedReviewRevision || null;
      if (!confirmedReview) {
        entry.createIntent = createIntent;
        confirmedReview = await stateStore.confirmSongPublicLinkReview(
          connection.id,
          local.familyId,
          {
            basis,
            evidence,
            validUntil,
            validThrough: preflightReview.validThrough,
            familyRevision: local.familyRevision,
            expectedReviewRevision: entry.expectedReviewRevision
          }
        );
        confirmedReviewRevision = songPublicLinkReviewRevision(
          confirmedReview
        );
        entry.confirmedReview = confirmedReview;
        entry.confirmedReviewRevision = confirmedReviewRevision;
      }
      const confirmedReviewStatus = songPublicLinkReviewStatus(
        confirmedReview,
        {
          familyRevision: local.familyRevision,
          now: new Date(),
          expiresAt: linkExpiresAt
        }
      );
      if (confirmedReviewStatus !== 'current') {
        failMainOperation(
          'INVALID_PUBLIC_LINK_REVIEW',
          'The saved public-link review no longer covers the requested link lifetime.'
        );
      }
      entry.createRequestStarted = true;
      const link = await client.createSongPublicLink({
        songSyncId: remote.syncId,
        songSyncVersion: remote.syncVersion,
        familyRevision: local.familyRevision,
        review: confirmedReview,
        reviewRevision: confirmedReviewRevision,
        label,
        expiresAt: linkExpiresAt,
        idempotencyKey: entry.idempotencyKey,
        accessToken
      });
      const actionToken = holdSongPublicLinkAction({
        connectionId: connection.id,
        songId: local.songId,
        currentFamilyRevision: local.familyRevision,
        link
      });
      if (!actionToken) {
        failMainOperation(
          'INVALID_PUBLIC_LINK_RESPONSE',
          'Heritage Community did not return a copyable active link.'
        );
      }
      await notifyCommunityStatusChanged();
      const result = {
        link: publicSongPublicLink(link, {
          actionToken,
          currentFamilyRevision: local.familyRevision
        }),
        publicLinkReview: {
          ...confirmedReview,
          status: 'current'
        }
      };
      songPublicLinkReviewProposals.delete(proposalToken);
      return result;
    } catch (error) {
      entry.applying = false;
      const outcomeUnconfirmed = entry.createRequestStarted
        && ambiguousCommunitySongPublicLinkCreateError(error);
      if (requireCommunityReconnectFor(error)) {
        await notifyCommunityStatusChanged();
      } else if (!outcomeUnconfirmed) {
        songPublicLinkReviewProposals.delete(proposalToken);
      }
      if (outcomeUnconfirmed) {
        failMainOperation(
          'SONG_PUBLIC_LINK_CREATE_UNCONFIRMED',
          'Heritage Community did not confirm whether the public link was created. Retry this same request to reuse its idempotency key, and refresh the link list if needed.'
        );
      }
      throw error;
    }
  }));
});

ipcMain.handle('community:songs:copyPublicLink', async (
  event,
  request = {}
) => {
  requireControlSender(event);
  return communityIpcResult(() => serializeCommunityOperation(async () => {
    communityRequestKeys(
      request,
      ['actionToken'],
      'Public-link copy request'
    );
    const { entry } = requireSongPublicLinkAction(request.actionToken);
    const connection = await requireCommunitySongPublicLinkConnection();
    if (connection.id !== entry.connectionId
      || songPublicLinkStatus(entry.link) !== 'active'
      || typeof entry.link.shareUrl !== 'string') {
      failMainOperation(
        'SONG_PUBLIC_LINK_ACTION_STALE',
        'Reload the current public links before copying this one.'
      );
    }
    clipboard.writeText(entry.link.shareUrl);
    return { copied: true };
  }));
});

ipcMain.handle('community:songs:revokePublicLink', async (
  event,
  request = {}
) => {
  requireControlSender(event);
  return communityIpcResult(() => serializeCommunityOperation(async () => {
    communityRequestKeys(
      request,
      ['actionToken'],
      'Public-link revocation request'
    );
    const { actionToken, entry } = requireSongPublicLinkAction(
      request.actionToken
    );
    entry.applying = true;
    try {
      const connection = await requireCommunitySongPublicLinkConnection({
        write: true
      });
      if (connection.id !== entry.connectionId) {
        failMainOperation(
          'SONG_PUBLIC_LINK_ACTION_STALE',
          'The Community connection changed. Reload the current public links.'
        );
      }
      const { client, accessToken } = await communitySongPublicLinkClient(
        connection
      );
      const revoked = await client.revokeSongPublicLink({
        linkId: entry.link.linkId,
        expectedLinkVersion: entry.link.linkVersion,
        idempotencyKey: entry.revokeIdempotencyKey,
        accessToken
      });
      if (songPublicLinkStatus(revoked) !== 'revoked') {
        failMainOperation(
          'PUBLIC_LINK_REVOCATION_NOT_CONFIRMED',
          'Heritage Community did not confirm revocation. The link may still work.'
        );
      }
      songPublicLinkActions.delete(actionToken);
      return {
        revoked: true,
        link: publicSongPublicLink(revoked, {
          currentFamilyRevision: entry.currentFamilyRevision
        })
      };
    } catch (error) {
      entry.applying = false;
      if (requireCommunityReconnectFor(error)) {
        await notifyCommunityStatusChanged();
      }
      throw error;
    }
  }));
});

ipcMain.handle('community:songs:beginSharingReview', async (event, request = {}) => {
  requireControlSender(event);
  return communityIpcResult(() => serializeCommunityOperation(async () => {
    communityRequestKeys(
      request,
      ['songId'],
      'Song member-sharing review request'
    );
    const songId = prepareId(request.songId, 'Song');
    const connection = await currentCommunityConnectionSummary();
    if (!connection || communityConnectionExpired(connection) || communityReconnectRequired) {
      failMainOperation(
        'COMMUNITY_RECONNECT_REQUIRED',
        'Connect this computer to Heritage Community before reviewing song sharing.'
      );
    }
    if (!connection.canWriteSongs) {
      failMainOperation(
        'COMMUNITY_READ_ONLY',
        'This Community approval cannot share songs.'
      );
    }
    const discovery = await communityClientForConnection(connection).discover({
      force: true
    });
    if (!discovery.resources?.songs?.memberSharing) {
      failMainOperation(
        'SONG_MEMBER_SHARING_UNSUPPORTED',
        'This Community server can stage songs privately but does not support the reviewed member-sharing transaction. Update Heritage Community before making songs member-visible.'
      );
    }
    const local = await resolveCommunitySongFamily(songId);
    const { stateStore } = await getCommunityServices();
    const state = await stateStore.getConnectionState(connection.id);
    const song = findCommunitySongState(state, local.familyId, local.songId);
    const review = Object.hasOwn(state.songSharingReviews, local.familyId)
      ? state.songSharingReviews[local.familyId]
      : null;
    if (song?.archived) {
      failMainOperation(
        'COMMUNITY_SONG_ARCHIVED',
        'The Community copy is archived and cannot be silently republished.'
      );
    }
    const { proposalToken, entry } = holdSongSharingReviewProposal({
      connectionId: connection.id,
      songId: local.songId,
      familyId: local.familyId,
      familyRevision: local.familyRevision,
      expectedSyncVersion: song?.syncVersion ?? null,
      expectedReviewRevision: songSharingReviewRevision(review),
      expectedPendingVisibility: communityPendingVisibilitySnapshot(
        song?.pendingVisibility
      )
    });
    return {
      proposalToken,
      expiresAt: new Date(entry.expiresAt).toISOString(),
      family: {
        ...local.family,
        revision: local.familyRevision,
        documents: local.family.documents.map(document => ({
          ...document,
          authors: [...document.authors],
          translators: [...document.translators],
          composers: [...document.composers]
        }))
      },
      visibility: song?.pendingVisibility?.visibility
        || song?.visibility
        || 'private',
      publishAt: song?.pendingVisibility?.publishAt
        || song?.publishAt
        || null,
      sharingReview: review
        ? {
            scope: review.scope,
            basis: review.basis,
            evidence: review.evidence,
            validUntil: review.validUntil,
            reviewedAt: review.reviewedAt,
            familyRevision: review.familyRevision,
            status: songSharingReviewStatus(review, {
              familyRevision: local.familyRevision,
              now: new Date()
            })
          }
        : { status: 'missing' }
    };
  }));
});

ipcMain.handle('community:songs:applySharingReview', async (event, request = {}) => {
  requireControlSender(event);
  return communityIpcResult(() => serializeCommunityOperation(async () => {
    communityRequestKeys(
      request,
      [
        'proposalToken',
        'visibility',
        'publishAt',
        'basis',
        'evidence',
        'validUntil',
        'confirmed'
      ],
      'Song member-sharing transaction request'
    );
    const { proposalToken, entry } = requireSongSharingReviewProposal(
      request.proposalToken
    );
    if (request.confirmed !== true) {
      failMainOperation(
        'SONG_SHARING_REVIEW_REQUIRED',
        'Confirm that the evidence covers every listed language and version.'
      );
    }
    const visibility = communityText(
      request.visibility,
      'Community song visibility',
      32,
      { required: true }
    );
    if (!['private', 'public', 'scheduled-public'].includes(visibility)) {
      failMainOperation(
        'INVALID_COMMUNITY_VISIBILITY',
        'Choose admins only, member-visible now, or member-visible later.'
      );
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
    const basis = communityText(
      request.basis,
      'Song-sharing basis',
      40,
      { required: true }
    );
    if (!SONG_SHARING_REVIEW_BASES.includes(basis)) {
      failMainOperation(
        'INVALID_SHARING_REVIEW',
        'Choose how member sharing is permitted for this exact song family.'
      );
    }
    const evidence = communityText(
      request.evidence,
      'Song-sharing evidence',
      1000
    );
    const validUntil = communityText(
      request.validUntil,
      'Song-sharing review date',
      10
    );
    const reviewValidationNow = new Date();
    try {
      createSongSharingReview({
        basis,
        evidence,
        validUntil
      }, {
        familyRevision: entry.familyRevision,
        reviewedAt: reviewValidationNow.toISOString()
      });
    } catch (error) {
      failMainOperation(
        error?.code || 'INVALID_SHARING_REVIEW',
        error?.message || 'The song-sharing review is invalid.'
      );
    }
    entry.applying = true;
    try {
      const connection = await currentCommunityConnectionSummary();
      if (!connection
        || connection.id !== entry.connectionId
        || communityConnectionExpired(connection)
        || communityReconnectRequired) {
        failMainOperation(
          'COMMUNITY_RECONNECT_REQUIRED',
          'The Community connection changed. Open a fresh song-sharing review.'
        );
      }
      if (!connection.canWriteSongs) {
        failMainOperation(
          'COMMUNITY_READ_ONLY',
          'This Community approval cannot share songs.'
        );
      }
      const local = await resolveCommunitySongFamily(entry.songId);
      if (local.familyId !== entry.familyId
        || local.familyRevision !== entry.familyRevision) {
        failMainOperation(
          'SONG_SHARING_REVIEW_STALE',
          'The song family changed after the review opened. Review every current language and version again.'
        );
      }
      const { stateStore } = await getCommunityServices();
      const currentState = await stateStore.getConnectionState(connection.id);
      const currentSong = findCommunitySongState(
        currentState,
        local.familyId,
        local.songId
      );
      if ((currentSong?.syncVersion ?? null) !== entry.expectedSyncVersion) {
        failMainOperation(
          'STATE_CONFLICT',
          'The Community song changed after this review opened. Open a fresh review.'
        );
      }
      if (!sameCommunityPendingVisibility(
        entry.expectedPendingVisibility,
        currentSong?.pendingVisibility
      )) {
        failMainOperation(
          'SONG_SHARING_REVIEW_STALE',
          'The queued Community access choice changed after this review opened. Open a fresh review.'
        );
      }
      const currentReview = Object.hasOwn(
        currentState.songSharingReviews,
        local.familyId
      )
        ? currentState.songSharingReviews[local.familyId]
        : null;
      if (songSharingReviewRevision(currentReview)
        !== entry.expectedReviewRevision) {
        failMainOperation(
          'SONG_SHARING_REVIEW_STALE',
          'The saved song-sharing review changed after this review opened. Open a fresh review.'
        );
      }
      if (currentSong?.archived) {
        failMainOperation(
          'COMMUNITY_SONG_ARCHIVED',
          'The Community copy was archived after this review opened and was not republished.'
        );
      }
      if (currentSong?.conflict) {
        const confirmedReview = await stateStore.confirmSongSharingReview(
          connection.id,
          local.familyId,
          {
            basis,
            evidence,
            validUntil,
            familyRevision: local.familyRevision,
            expectedReviewRevision: entry.expectedReviewRevision
          }
        );
        await notifyCommunityStatusChanged();
        return {
          reviewOnly: true,
          queued: false,
          songState: publicCommunitySongState(currentSong, connection, {
            familyId: local.familyId,
            family: local.family,
            familyRevision: local.familyRevision,
            sharingReview: confirmedReview,
            exists: true
          }),
          lastSync: communityLastSyncSummary
        };
      }
      const summary = await runCommunitySongSync({
        syncId: entry.familyId,
        visibility,
        publishAt,
        expectedSyncVersion: entry.expectedSyncVersion,
        expectedFamilyRevision: entry.familyRevision,
        expectedReviewRevision: entry.expectedReviewRevision,
        allowWrites: true,
        sharingReview: {
          basis,
          evidence,
          validUntil
        }
      });
      const songState = await communitySongStatePayload(entry.songId);
      if (songState.conflict || summary.conflicts > 0) {
        failMainOperation(
          'SONG_SYNC_CONFLICT',
          'The Community song changed during review; neither copy was overwritten.'
        );
      }
      if (songState.archived) {
        failMainOperation(
          'COMMUNITY_SONG_ARCHIVED',
          'The Community copy was archived during review and was not republished.'
        );
      }
      if (summary.reviewRequired > 0 || summary.status === 'needs-review') {
        failMainOperation(
          'SONG_SHARING_REVIEW_REQUIRED',
          'The exact family review could not be applied. Open a fresh review.'
        );
      }
      if (summary.status === 'offline') {
        failMainOperation(
          'COMMUNITY_OFFLINE',
          'The exact review was saved locally for recovery, but SyncShow did not receive a current Heritage Community confirmation. The local checkpoint is private; if the connection failed after submission, current server access is unknown. Reconnect and open Review and submit again.'
        );
      }
      const queued = false;
      const intendedPublishTime = publishAt ? Date.parse(publishAt) : null;
      const appliedPublishTime = songState.confirmedPublishAt
        ? Date.parse(songState.confirmedPublishAt)
        : null;
      if (!queued
        && (
          songState.exists !== true
          || songState.pendingVisibility !== null
          || songState.confirmedVisibility !== visibility
          || (visibility !== 'private'
            && songState.memberSharing?.songSyncVersion
              !== songState.syncVersion)
          || (visibility !== 'private'
            && songState.memberSharing?.familyRevision
              !== entry.familyRevision)
          || (visibility !== 'private'
            && songState.memberSharing?.visibility !== visibility)
          || songState.effectiveVisibility === null
          || (visibility === 'scheduled-public'
            && appliedPublishTime !== intendedPublishTime)
        )) {
        failMainOperation(
          'COMMUNITY_VISIBILITY_NOT_APPLIED',
          'Heritage Community did not confirm the reviewed member-access choice. Reload the song before trying again.'
        );
      }
      return {
        queued,
        songState,
        lastSync: summary
      };
    } finally {
      songSharingReviewProposals.delete(proposalToken);
    }
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
    if (visibility !== 'private') {
      failMainOperation(
        'SONG_SHARING_REVIEW_REQUIRED',
        'Use Review and submit to make a song visible to Community members.'
      );
    }
    const publishAt = null;
    if (request.publishAt !== null
      && request.publishAt !== undefined
      && request.publishAt !== '') {
      failMainOperation(
        'INVALID_COMMUNITY_VISIBILITY',
        'Private songs cannot have a publication time.'
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
      expectedSyncVersion: expectedSyncVersion ?? null,
      allowWrites: true
    });
    const songState = await communitySongStatePayload(songId);
    if (summary.status === 'offline') {
      failMainOperation(
        'COMMUNITY_OFFLINE',
        'The song was saved locally and its Community visibility is queued until the server is available.'
      );
    }
    if (songState.archived) {
      failMainOperation(
        'COMMUNITY_SONG_ARCHIVED',
        'The Community copy was archived before the admin-only restriction could be confirmed.'
      );
    }
    if (songState.pendingVisibility !== null
      || songState.confirmedVisibility !== 'private'
      || songState.confirmedPublishAt !== null) {
      failMainOperation(
        'COMMUNITY_VISIBILITY_NOT_APPLIED',
        'Heritage Community did not confirm the admin-only restriction. Reload the song before trying again.'
      );
    }
    return {
      songState,
      lastSync: summary,
      conflictPreserved: Boolean(songState.conflict)
    };
  }));
});

ipcMain.handle('prepare:songs:list', async (event, request = {}) => {
  requireControlSender(event);
  requirePrepareRequest(request, 16 * 1024);
  const services = getPrepareServices();
  const transactionRecovery =
    await recoverLocalSongFamilyCommit();
  const listing = await services.localSongLibrary.list({
    query: prepareText(request.query, 'Song search', 120),
    pageSize: Number.isSafeInteger(request.pageSize) ? request.pageSize : 50,
    offset: Number.isSafeInteger(request.offset) ? request.offset : 0
  });
  const augmented = await augmentSongLibraryWithCommunity(listing);
  return {
    ...augmented,
    recovery: transactionRecovery.recovered
      ? {
          source: 'song-family-transaction',
          message:
            'SyncShow completed an interrupted reviewed song-family save before opening the library.'
        }
      : null
  };
});

ipcMain.handle('prepare:sermons:list', async (event, request = {}) => {
  requireControlSender(event);
  requirePrepareRequest(request, 16 * 1024);
  const services = getPrepareServices();
  const transactionRecovery = await services.sermonProjectCommitCoordinator.recover();
  const listing = await services.localSermonLibrary.list({
    query: prepareText(request.query, 'Sermon search', 120),
    pageSize: Number.isSafeInteger(request.pageSize) ? request.pageSize : 50,
    offset: Number.isSafeInteger(request.offset) ? request.offset : 0
  });
  return {
    items: listing.items.map(sermonLibrarySummaryResult),
    total: listing.total,
    offset: listing.offset,
    nextOffset: listing.nextOffset,
    recovery: transactionRecovery.message
      ? {
          source: 'sermon-project-transaction',
          message: transactionRecovery.message
        }
      : null
  };
});

ipcMain.handle('prepare:sermons:listServices', async (event, request = {}) => {
  requireControlSender(event);
  requirePrepareRequest(request, 4 * 1024);
  requireExactPrepareKeys(
    request,
    ['sermonId', 'pageSize', 'offset'],
    'Sermon service history'
  );
  const sermonId = prepareSermonDomainId(request.sermonId, 'Sermon');
  const pageSize = request.pageSize === undefined ? 20 : request.pageSize;
  const offset = request.offset === undefined ? 0 : request.offset;
  if (
    !Number.isSafeInteger(pageSize)
    || pageSize < 1
    || pageSize > MAX_SERMON_RELATIONSHIP_PAGE_SIZE
  ) {
    failMainOperation(
      'INVALID_SERMON_SERVICE_PAGE',
      `Sermon service history pages must contain 1 to ${MAX_SERMON_RELATIONSHIP_PAGE_SIZE} records.`
    );
  }
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > 5000) {
    failMainOperation(
      'INVALID_SERMON_SERVICE_OFFSET',
      'Sermon service history has an invalid page offset.'
    );
  }
  const listing = await getPrepareServices()
    .serviceProjectStore
    .listSermonServiceRelationships(sermonId, { pageSize, offset });
  return {
    items: listing.items.map(relationship => ({
      schemaVersion: 1,
      sermonId: relationship.sermonId,
      sermonRevisionId: relationship.sermonRevisionId,
      pinnedSermonRevisionIds: [...relationship.pinnedSermonRevisionIds],
      projectId: relationship.projectId,
      projectRevision: relationship.projectRevision,
      projectRevisionId: relationship.projectRevisionId,
      projectTitle: relationship.projectTitle,
      serviceDate: relationship.serviceDate,
      updatedAt: relationship.updatedAt,
      profileId: relationship.profileId,
      workflowMode: relationship.workflowMode,
      anchorItemId: relationship.anchorItemId,
      resourceOwnerId: relationship.resourceOwnerId,
      sourceServiceSet: relationship.sourceServiceSet
        ? { ...relationship.sourceServiceSet }
        : null,
      linkedItemCount: relationship.linkedItemCount,
      resourceOwnerCount: relationship.resourceOwnerCount
    })),
    total: listing.total,
    offset: listing.offset,
    nextOffset: listing.nextOffset
  };
});

ipcMain.handle('prepare:sermons:outline', async (event, request = {}) => {
  requireControlSender(event);
  requirePrepareRequest(request, 16 * 1024);
  const sermonId = prepareSermonDomainId(request.sermonId, 'Sermon');
  const sermonRevisionId = prepareRevision(request.sermonRevisionId, 'Sermon revision');
  const read = await getPrepareServices().localSermonLibrary.readRevision(
    sermonId,
    sermonRevisionId
  );
  return sermonOutlineResult(read);
});

ipcMain.handle('prepare:sermons:lookupPrimaryReference', async (event, request = {}) => {
  requireControlSender(event);
  requirePrepareRequest(request, 16 * 1024);
  return resolveSermonPrimaryReferenceLookupRequest(request);
});

ipcMain.handle('prepare:projects:previewSermonReference', async (event, request = {}) => {
  requireControlSender(event);
  requirePrepareRequest(request, 16 * 1024);
  requireExactPrepareKeys(request, [
    'projectId',
    'revisionId',
    'itemId',
    'sermonId',
    'sermonRevisionId',
    'referenceId'
  ], 'Scripture-reference preview');
  const current = await readExpectedProject({
    projectId: request.projectId,
    expectedRevisionId: request.revisionId
  });
  const target = requireSermonReferenceTarget(current.project, request.itemId);
  const sermonId = prepareSermonDomainId(request.sermonId, 'Sermon');
  const sermonRevisionId = prepareRevision(
    request.sermonRevisionId,
    'Sermon revision'
  );
  if (
    target.linked.resource.document.id !== sermonId
    || target.linked.resource.sha256 !== sermonRevisionId
  ) {
    failMainOperation(
      'SERMON_REFERENCE_REVIEW_BINDING_CHANGED',
      'The linked sermon changed before this Scripture reference could be previewed.'
    );
  }
  const referenceId = prepareSermonDomainId(
    request.referenceId,
    'Scripture reference'
  );
  const reference = target.linked.resource.document.references.find(candidate =>
    candidate.id === referenceId);
  if (!reference) {
    failMainOperation(
      'UNKNOWN_SERMON_REFERENCE',
      'That Scripture reference is no longer in the linked sermon.'
    );
  }
  return sermonReferenceBibleLibrary.lookupCanonicalRange({
    book: reference.range.bookId,
    startChapter: reference.range.start.chapter,
    startVerse: reference.range.start.verse,
    endChapter: reference.range.end.chapter,
    endVerse: reference.range.end.verse
  }, {
    translationId: 'BSB'
  });
});

ipcMain.handle('prepare:projects:sermonAttachmentHealth', async (event, request = {}) => {
  requireControlSender(event);
  requirePrepareRequest(request, 16 * 1024);
  const projectId = prepareId(request.projectId, 'Service project');
  const revisionId = prepareRevision(request.revisionId, 'Service revision');
  const itemId = prepareId(request.itemId, 'Service item');
  const services = getPrepareServices();
  const read = await services.serviceProjectStore.read(projectId, { revisionId });
  const item = read.project.items[itemId];
  if (!isSermonSourceTarget(read.project, item)) {
    failMainOperation(
      'INVALID_SERMON_SOURCE_ITEM',
      'Choose a linked sermon cue or sermon outline group to check its private files.'
    );
  }
  const linked = resolveSermonSourceLink(read.project, item);
  if (!linked) {
    failMainOperation(
      'SERMON_SOURCE_NOT_LINKED',
      'That service item is not linked to a sermon packet.'
    );
  }
  const health = await sermonAttachmentHealthCoordinator.inspect(
    linked.resourceId,
    linked.resource.document,
    services.localSermonSourceStore
  );
  return {
    projectId: read.project.id,
    revisionId: read.revisionId,
    itemId,
    resourceId: linked.resourceId,
    sermonId: linked.resource.document.id,
    sermonRevisionId: linked.resource.sha256,
    health
  };
});

async function beginCommunitySermonMediaApproval(reference) {
  await resolveLocalSermonMediaUploadBinding(reference);
  const existing = await currentCommunityConnectionSummary({
    refreshCapabilities: true
  });
  if (!existing
    || communityConnectionExpired(existing)
    || communityReconnectRequired
    || !existing.canReadSermons) {
    failMainOperation(
      'COMMUNITY_RECONNECT_REQUIRED',
      'Connect Community with sermon read access before enabling private recording upload.'
    );
  }
  if (existing.canReadSermonMedia && existing.canWriteSermonMedia) {
    return {
      connected: true,
      pending: false,
      status: 'already-enabled',
      message: 'Private sermon-recording upload is already approved.'
    };
  }
  if (pendingCommunityAuthorizations.size > 0) {
    failMainOperation(
      'COMMUNITY_AUTHORIZATION_PENDING',
      'Finish or cancel the current Community approval request first.'
    );
  }
  const { connectionStore } = await getCommunityServices();
  await connectionStore.assertSecureStorageAvailable();
  const connection = await connectionStore.getConnection(existing.id);
  if (!connection || communityConnectionExpired(connection)) {
    failMainOperation(
      'COMMUNITY_RECONNECT_REQUIRED',
      'This Community approval expired. Connect this computer again.'
    );
  }
  const client = communityClientForConnection(connection);
  const operationEpoch = communityOperationEpoch;
  const controller = beginCommunityAuthRequest();
  let discovery;
  let authorization;
  let requestedScopes;
  try {
    discovery = await client.discover({
      signal: controller.signal,
      force: true
    });
    const identityError = communityDiscoveryIdentityError(connection, discovery);
    if (identityError) {
      failMainOperation(identityError.code, identityError.message);
    }
    if (!discovery.resources?.sermonMedia) {
      failMainOperation(
        'SERMON_MEDIA_UPLOAD_UNAVAILABLE',
        'This Community server does not offer managed sermon-recording upload.'
      );
    }
    requestedScopes = communityAuthorizationScopes(discovery, {
      includeSermonMedia: true
    });
    if (!requestedScopes.includes('syncshow:sermon-media:read')
      || !requestedScopes.includes('syncshow:sermon-media:write')
      || !requestedScopes.includes('syncshow:sermons:read')) {
      failMainOperation(
        'SERMON_MEDIA_UPLOAD_UNAVAILABLE',
        'This Community server did not advertise the complete private recording permission set.'
      );
    }
    authorization = await client.startDeviceAuthorization({
      email: connection.account.email,
      deviceName: `SyncShow private recording upload on ${os.hostname()}`
        .slice(0, 120),
      scopes: requestedScopes,
      signal: controller.signal
    });
  } finally {
    finishCommunityAuthRequest(controller);
  }
  if (operationEpoch !== communityOperationEpoch) {
    await client.cancelDeviceAuthorization(authorization.authorizationId)
      .catch(() => {});
    failMainOperation(
      'COMMUNITY_AUTHORIZATION_CANCELLED',
      'Community approval was cancelled before it could be saved.'
    );
  }
  pendingCommunityAuthorizations.set(authorization.authorizationId, {
    client,
    discovery,
    email: connection.account.email,
    authorizationId: authorization.authorizationId,
    verificationUri: authorization.verificationUri,
    userCode: authorization.userCode,
    expiresAt: authorization.expiresAt,
    pollIntervalMs: authorization.pollIntervalMs,
    requestedScopes,
    replaceConnectionId: connection.id
  });
  await notifyCommunityStatusChanged();
  return {
    connected: false,
    pending: true,
    status: 'pending',
    authorizationId: authorization.authorizationId,
    serverUrl: discovery.baseUrl,
    adminEmail: connection.account.email,
    verificationUri: authorization.verificationUri,
    userCode: authorization.userCode,
    expiresAt: authorization.expiresAt,
    pollIntervalMs: authorization.pollIntervalMs,
    message:
      'Approve the added private sermon-recording permissions in Community. No upload starts during approval.'
  };
}

async function runCommunitySermonMediaUpload(reference, {
  rotateTerminalAttempt = false
} = {}) {
  const key = communitySermonMediaOperationKey(reference);
  const previous = communitySermonMediaUploads.get(key);
  if (['uploading', 'cancelling', 'recovering'].includes(previous?.status)) {
    failMainOperation(
      'SERMON_MEDIA_UPLOAD_ACTIVE',
      'This private recording upload is already running.'
    );
  }
  const finalizationRecovery = !rotateTerminalAttempt
    && communitySermonMediaCanResumeWithoutLocal(previous)
    && typeof previous.uploadId === 'string'
    && previous.uploader
    && previous.recoveryBinding
    && previous.attemptStore
    && previous.attemptKey
    && previous.attemptId
    ? previous
    : null;
  const controller = new AbortController();
  let resolveStarted;
  let rejectStarted;
  const started = new Promise((resolve, reject) => {
    resolveStarted = resolve;
    rejectStarted = reject;
  });
  started.catch(() => {});
  const operation = {
    status: 'uploading',
    controller,
    uploader: null,
    uploadId: null,
    progress: null,
    error: null,
    promise: null,
    started,
    attemptKey: null,
    attemptId: null,
    attemptStore: null,
    attemptIdentity: null,
    recoveryLocator: null,
    recoveryBinding: null,
    resumeEligible: true,
    restartRequired: false
  };
  // Reserve synchronously before capability discovery or local hashing. A
  // simultaneous Start/Resume IPC therefore cannot launch a second stream.
  communitySermonMediaUploads.set(key, operation);
  notifyCommunitySermonMediaProgress(reference, 'uploading');
  try {
    if (finalizationRecovery) {
      operation.uploader = finalizationRecovery.uploader;
      operation.uploadId = finalizationRecovery.uploadId;
      operation.progress = finalizationRecovery.progress;
      operation.attemptKey = finalizationRecovery.attemptKey;
      operation.attemptId = finalizationRecovery.attemptId;
      operation.attemptStore = finalizationRecovery.attemptStore;
      operation.attemptIdentity = finalizationRecovery.attemptIdentity;
      operation.recoveryLocator = finalizationRecovery.recoveryLocator;
      operation.recoveryBinding = finalizationRecovery.recoveryBinding;
      operation.promise = operation.uploader.resumeFinalization(
        operation.recoveryBinding,
        operation.uploadId,
        {
          signal: controller.signal,
          onProgress(progress) {
            operation.uploadId = progress.uploadId;
            operation.progress = progress;
            resolveStarted();
            notifyCommunitySermonMediaProgress(
              reference,
              progress.complete ? 'complete' : 'uploading',
              progress
            );
          }
        }
      );
    } else {
      const context = await communitySermonMediaContext(reference, {
        requireGrant: true,
        refreshCapabilities: true
      });
      const uploader = communitySermonMediaUploader(context, reference);
      operation.uploader = uploader;
      operation.attemptIdentity =
        communitySermonMediaAttemptIdentity(context);
      operation.attemptKey = communitySermonMediaAttemptKey(context);
      operation.recoveryLocator =
        communitySermonMediaRecoveryLocator(reference, context);
      operation.attemptStore =
        context.services.communitySermonMediaAttemptStore;
      operation.recoveryBinding = {
        sermonId: context.binding.sermonId,
        expectedSyncVersion: context.binding.expectedSyncVersion,
        expectedCurrentRevision:
          context.binding.expectedCurrentRevision,
        recording: context.binding.recording
      };
      const attempt = await operation.attemptStore
        .attemptFor(operation.attemptKey, {
          rotateTerminal: rotateTerminalAttempt,
          recoveryLocator: operation.recoveryLocator,
          recoveryBinding: operation.recoveryBinding
        });
      operation.attemptId = attempt.attemptId;
      operation.uploadId = attempt.uploadId;
      operation.promise = uploader.upload({
        projectId: reference.projectId,
        expectedProjectRevisionId: reference.expectedProjectRevisionId,
        itemId: reference.itemId
      }, {
        attemptId: operation.attemptId,
        signal: controller.signal,
        async onAcknowledged(uploadId) {
          const acknowledged = await operation.attemptStore.acknowledgeUpload(
            operation.attemptKey,
            operation.attemptId,
            uploadId
          );
          operation.uploadId = acknowledged.attempt.uploadId;
        },
        onProgress(progress) {
          operation.uploadId = progress.uploadId;
          operation.progress = progress;
          resolveStarted();
          notifyCommunitySermonMediaProgress(
            reference,
            progress.complete ? 'complete' : 'uploading',
            progress
          );
        }
      });
    }
    operation.promise
      .then(result => {
        operation.status = 'complete';
        operation.restartRequired = false;
        operation.progress = result.progress;
        operation.uploadId = result.upload.id;
        // Keep a successful attempt reusable. After restart the same exact init
        // key must replay the completed private slot instead of attempting to
        // create a conflicting second recording.
        resolveStarted();
        notifyCommunitySermonMediaProgress(
          reference,
          'complete',
          result.progress
        );
      })
      .catch(async error => {
        if (operation.status === 'cancelling') {
          operation.error = publicCommunityError(error);
          rejectStarted(error);
          return;
        }
        const failure = communitySermonMediaFailureDisposition(
          error,
          operation.uploadId
        );
        operation.status = failure.status;
        operation.restartRequired = failure.restartRequired;
        if (failure.preserveForCancellation) {
          operation.resumeEligible = false;
        }
        operation.error = publicCommunityError(error);
        if (failure.restartRequired) {
          operation.uploadId = null;
          await operation.attemptStore
            .markTerminal(operation.attemptKey, operation.attemptId)
            .catch(() => {});
        }
        rejectStarted(error);
        notifyCommunitySermonMediaProgress(
          reference,
          operation.status,
          operation.progress,
          error,
          {
            restartRequired: operation.restartRequired,
            resumeEligible: operation.resumeEligible
          }
        );
      });
    await started;
    return {
      status: operation.status === 'complete' ? 'complete' : 'uploading',
      projectId: reference.projectId,
      revisionId: reference.expectedProjectRevisionId,
      itemId: reference.itemId,
      progress: publicCommunitySermonMediaProgress(operation.progress),
      private: true,
      publicationRequired: true
    };
  } catch (error) {
    const failure = communitySermonMediaFailureDisposition(
      error,
      operation.uploadId
    );
    operation.status = failure.status;
    operation.restartRequired = operation.attemptId === null
      || failure.restartRequired;
    if (failure.preserveForCancellation) {
      operation.resumeEligible = false;
    }
    operation.error = publicCommunityError(error);
    if (operation.restartRequired) operation.uploadId = null;
    rejectStarted(error);
    notifyCommunitySermonMediaProgress(
      reference,
      operation.status,
      operation.progress,
      error,
      {
        restartRequired: operation.restartRequired,
        resumeEligible: operation.resumeEligible
      }
    );
    throw error;
  }
}

async function beginCommunitySermonMediaUpload(reference, {
  resume = false
} = {}) {
  const availability = await communitySermonMediaAvailability(reference);
  const allowed = resume
    ? availability.canResume === true
    : availability.canUpload === true;
  if (!allowed) {
    const active = communitySermonMediaUploads.get(
      communitySermonMediaOperationKey(reference)
    );
    if (active?.status === 'error'
      && active.resumeEligible === false
      && typeof active.uploadId === 'string') {
      failMainOperation(
        'SERMON_MEDIA_UPLOAD_CANCEL_REQUIRED',
        'Cancel the earlier private Community staging upload before starting or resuming this changed recording.'
      );
    }
    if (resume) {
      failMainOperation(
        'SERMON_MEDIA_UPLOAD_NOT_RESUMABLE',
        availability.message
          || 'No paused private Community upload is available to resume.'
      );
    }
    failMainOperation(
      'SERMON_MEDIA_UPLOAD_NOT_STARTABLE',
      availability.message
        || 'This private Community upload cannot be started yet.'
    );
  }
  // Availability performs durable recovery first. With no await between this
  // decision and runCommunitySermonMediaUpload's synchronous reservation, a
  // second IPC cannot replace the recovered or newly starting operation.
  return runCommunitySermonMediaUpload(reference, {
    rotateTerminalAttempt: !resume
  });
}

ipcMain.handle('prepare:communitySermonMedia:getState', async (
  event,
  request = {}
) => {
  requireControlSender(event);
  const reference = communitySermonMediaReference(
    request,
    'Sermon-media upload state'
  );
  return communitySermonMediaAvailability(reference);
});

ipcMain.handle('prepare:communitySermonMedia:enable', async (
  event,
  request = {}
) => {
  requireControlSender(event);
  return communityIpcResult(() => serializeCommunityOperation(async () => {
    const reference = communitySermonMediaReference(
      request,
      'Sermon-media upload approval'
    );
    return beginCommunitySermonMediaApproval(reference);
  }));
});

ipcMain.handle('prepare:communitySermonMedia:start', async (
  event,
  request = {}
) => {
  requireControlSender(event);
  const reference = communitySermonMediaReference(
    request,
    'Sermon-media upload'
  );
  return beginCommunitySermonMediaUpload(reference);
});

ipcMain.handle('prepare:communitySermonMedia:resume', async (
  event,
  request = {}
) => {
  requireControlSender(event);
  const reference = communitySermonMediaReference(
    request,
    'Sermon-media upload resume'
  );
  return beginCommunitySermonMediaUpload(reference, {
    resume: true
  });
});

async function cancelCommunitySermonMediaUpload(reference) {
  const key = communitySermonMediaOperationKey(reference);
  let active = communitySermonMediaUploads.get(key);
  if (!active) {
    active = await recoverCommunitySermonMediaOperation(reference);
  } else if (active.status === 'recovering') {
    active = await active.recoveryPromise;
  }
  if (!active
    || !active.uploader
    || !communitySermonMediaCanCancel({
      status: active.status,
      progress: active.progress,
      uploadId: active.uploadId,
      restartRequired: active.restartRequired
    })) {
    failMainOperation(
      'SERMON_MEDIA_UPLOAD_NOT_CANCELLABLE',
      'No acknowledged private Community upload is available to cancel.'
    );
  }
  // Reserve cancellation synchronously. The body-abort rejection must not
  // reopen Start/Resume while the authoritative DELETE is still in flight.
  active.status = 'cancelling';
  active.restartRequired = false;
  communitySermonMediaUploads.set(key, active);
  notifyCommunitySermonMediaProgress(
    reference,
    'cancelling',
    active.progress
  );
  active.controller?.abort();
  await active.promise?.catch(() => {});
  let cancelled;
  try {
    cancelled = await active.uploader.cancel(active.uploadId);
  } catch (error) {
    let cancellationError = error;
    if ([
      'UPLOAD_ALREADY_COMPLETE',
      'FINALIZATION_IN_PROGRESS'
    ].includes(error?.code)) {
      try {
        const inspected = await active.uploader.inspect(active.uploadId);
        if (!active.attemptIdentity
          || communitySermonMediaObservedAttemptKey(
            inspected.upload,
            active.attemptIdentity
          ) !== active.attemptKey) {
          failMainOperation(
            'INVALID_RESPONSE',
            'Community did not confirm the completed private recording.'
          );
        }
        if (inspected.upload.state === 'complete') {
          active.status = 'complete';
          active.restartRequired = false;
          active.progress = inspected.progress;
          active.error = null;
          notifyCommunitySermonMediaProgress(
            reference,
            'complete',
            inspected.progress
          );
          return {
            status: 'complete',
            projectId: reference.projectId,
            revisionId: reference.expectedProjectRevisionId,
            itemId: reference.itemId,
            progress: publicCommunitySermonMediaProgress(inspected.progress),
            private: true,
            publicationRequired: true
          };
        }
        if (error?.code !== 'FINALIZATION_IN_PROGRESS'
          || inspected.upload.state !== 'finalizing') {
          failMainOperation(
            'INVALID_RESPONSE',
            'Community returned an impossible state after the cancellation race.'
          );
        }
        // The completion claim won the race. Preserve the exact attempt and
        // switch the operator to identity-only finalization recovery.
        active.progress = inspected.progress;
        active.resumeEligible = true;
      } catch (inspectError) {
        // DELETE may race with completion while the authoritative follow-up
        // GET is temporarily unavailable or malformed. Keep the acknowledged
        // attempt retryable instead of stranding the operation in cancelling.
        cancellationError = inspectError;
      }
    }
    const failure = communitySermonMediaFailureDisposition(
      cancellationError,
      active.uploadId
    );
    active.status = failure.status;
    active.restartRequired = failure.restartRequired;
    if (failure.preserveForCancellation) active.resumeEligible = false;
    active.error = publicCommunityError(cancellationError);
    if (failure.restartRequired && active.attemptKey && active.attemptId) {
      active.uploadId = null;
      await active.attemptStore
        .markTerminal(active.attemptKey, active.attemptId)
        .catch(() => {});
    }
    notifyCommunitySermonMediaProgress(
      reference,
      active.status,
      active.progress,
      cancellationError,
      {
        restartRequired: failure.restartRequired,
        resumeEligible: active.resumeEligible
      }
    );
    throw cancellationError;
  }
  active.status = 'cancelled';
  active.progress = cancelled.progress;
  active.error = null;
  if (active.attemptKey && active.attemptId) {
    await active.attemptStore.markTerminal(
      active.attemptKey,
      active.attemptId
    );
  }
  notifyCommunitySermonMediaProgress(
    reference,
    'cancelled',
    cancelled.progress
  );
  return {
    status: 'cancelled',
    projectId: reference.projectId,
    revisionId: reference.expectedProjectRevisionId,
    itemId: reference.itemId,
    progress: publicCommunitySermonMediaProgress(cancelled.progress),
    private: true,
    publicationRequired: true
  };
}

ipcMain.handle('prepare:communitySermonMedia:cancel', async (
  event,
  request = {}
) => {
  requireControlSender(event);
  const reference = communitySermonMediaReference(
    request,
    'Sermon-media upload cancellation'
  );
  return cancelCommunitySermonMediaUpload(reference);
});

ipcMain.handle('prepare:projects:sermonRecordingHealth', async (event, request = {}) => {
  requireControlSender(event);
  requirePrepareRequest(request, 8 * 1024);
  requireExactPrepareKeys(request, [
    'projectId',
    'revisionId',
    'itemId'
  ], 'Sermon recording health');
  const projectId = prepareId(request.projectId, 'Service project');
  const revisionId = prepareRevision(request.revisionId, 'Service revision');
  const itemId = prepareId(request.itemId, 'Service item');
  const services = getPrepareServices();
  const read = await services.serviceProjectStore.read(projectId, { revisionId });
  const item = read.project.items[itemId];
  if (!isSermonSourceTarget(read.project, item)) {
    failMainOperation(
      'INVALID_SERMON_SOURCE_ITEM',
      'Choose a linked sermon cue or sermon outline group to check its local recording.'
    );
  }
  const linked = resolveSermonSourceLink(read.project, item);
  if (!linked) {
    failMainOperation(
      'SERMON_SOURCE_NOT_LINKED',
      'That service item is not linked to a sermon packet.'
    );
  }

  const document = linked.resource.document;
  const recordingId = `post-service:recording:${document.defaultLanguage}`;
  const recording = (Array.isArray(document.media) ? document.media : [])
    .find(media => media?.id === recordingId) || null;
  const recordingDigest = typeof recording?.sha256 === 'string'
    ? recording.sha256.trim().toLowerCase()
    : '';
  let health = { status: 'not-recorded', restorable: false };
  if (recordingDigest) {
    health = await sermonRecordingHealthCoordinator.run(
      `recording:${linked.resourceId}`,
      async () => {
        try {
          await services.localSermonMediaStore.checkMedia(recording);
          return { status: 'verified', restorable: false };
        } catch (error) {
          return {
            status: error?.code === 'OBJECT_NOT_FOUND'
              ? 'missing'
              : [
                  'OBJECT_CORRUPT',
                  'INVALID_OBJECT_ID',
                  'INVALID_MEDIA_METADATA',
                  'UNSUPPORTED_MEDIA_TYPE',
                  'MEDIA_TYPE_MISMATCH',
                  'CORRUPT_MEDIA'
                ].includes(error?.code)
                ? 'corrupt'
                : 'unavailable',
            restorable: ['OBJECT_NOT_FOUND', 'OBJECT_CORRUPT'].includes(
              error?.code
            )
          };
        }
      }
    );
  }
  return {
    projectId: read.project.id,
    revisionId: read.revisionId,
    itemId,
    resourceId: linked.resourceId,
    sermonId: document.id,
    sermonRevisionId: linked.resource.sha256,
    recordingId: recording?.id || null,
    health
  };
});

ipcMain.handle('prepare:projects:playSermonRecording', async (event, request = {}) => {
  requireControlSender(event);
  requirePrepareRequest(request, 8 * 1024);
  requireExactPrepareKeys(request, [
    'projectId',
    'expectedRevisionId',
    'itemId'
  ], 'Sermon recording playback');
  if (displayStartInProgress || appState.activeLaunchPlan) {
    failMainOperation(
      'SERMON_RECORDING_PLAYBACK_BLOCKED',
      'Private sermon recording review is unavailable while Show is starting or active.'
    );
  }
  const playbackAttempt = invalidateSermonRecordingPlayer();
  const abortController = new AbortController();
  sermonRecordingPlaybackAbortController = abortController;
  let reader;
  let adopted = false;
  try {
    await playbackAttempt.cleanup;
    requireCurrentSermonRecordingPlayback(playbackAttempt.epoch);
    const current = await readExpectedProject(request);
    requireCurrentSermonRecordingPlayback(playbackAttempt.epoch);
    const itemId = prepareId(request.itemId, 'Service item');
    const item = current.project.items[itemId];
    if (!isSermonSourceTarget(current.project, item)) {
      failMainOperation(
        'INVALID_SERMON_SOURCE_ITEM',
        'Choose a linked sermon cue or sermon outline group to review its local recording.'
      );
    }
    const linked = resolveSermonSourceLink(current.project, item);
    if (!linked) {
      failMainOperation(
        'SERMON_SOURCE_NOT_LINKED',
        'That service item is not linked to a sermon packet.'
      );
    }
    const document = linked.resource.document;
    const recordingId = `post-service:recording:${document.defaultLanguage}`;
    const recording = (Array.isArray(document.media) ? document.media : [])
      .find(media => media?.id === recordingId) || null;
    if (
      !recording
      || !['audio', 'video'].includes(recording.kind)
      || !/^[a-f0-9]{64}$/u.test(String(recording.sha256 || ''))
    ) {
      failMainOperation(
        'SERMON_RECORDING_NOT_AVAILABLE',
        'This exact sermon revision does not have a preserved local recording to review.'
      );
    }

    try {
      reader = await verifySermonRecordingForPlayback(
        () => current.services.localSermonMediaStore.openMediaReadSession(
          recording,
          { signal: abortController.signal }
        )
      );
    } catch (error) {
      if (abortController.signal.aborted) {
        requireCurrentSermonRecordingPlayback(playbackAttempt.epoch);
      }
      failSermonRecordingPlayback(error);
    }
    requireCurrentSermonRecordingPlayback(playbackAttempt.epoch);

    // The complete hash can take time for a large recording. Re-open the exact
    // expected project afterward so a concurrent project edit can never
    // autoplay media from the now-stale sermon binding.
    const refreshed = await readExpectedProject(request);
    requireCurrentSermonRecordingPlayback(playbackAttempt.epoch);
    const refreshedItem = refreshed.project.items[itemId];
    const refreshedLinked = isSermonSourceTarget(
      refreshed.project,
      refreshedItem
    )
      ? resolveSermonSourceLink(refreshed.project, refreshedItem)
      : null;
    const refreshedDocument = refreshedLinked?.resource?.document || null;
    const refreshedRecording = (
      Array.isArray(refreshedDocument?.media)
        ? refreshedDocument.media
        : []
    ).find(media => media?.id === recordingId) || null;
    if (
      refreshed.revisionId !== current.revisionId
      || refreshedLinked?.resourceId !== linked.resourceId
      || refreshedDocument?.id !== document.id
      || refreshedLinked?.resource?.sha256 !== linked.resource.sha256
      || refreshedRecording?.kind !== recording.kind
      || refreshedRecording?.mediaType !== recording.mediaType
      || refreshedRecording?.fileName !== recording.fileName
      || refreshedRecording?.sha256 !== recording.sha256
      || refreshedRecording?.sizeBytes !== recording.sizeBytes
      || refreshedRecording?.durationSeconds !== recording.durationSeconds
    ) {
      failMainOperation(
        'PROJECT_CONFLICT',
        'This service or sermon recording changed while private review was opening.'
      );
    }

    const title = refreshedDocument.titles?.[refreshedDocument.defaultLanguage]
      || Object.values(refreshedDocument.titles || {}).find(value =>
        typeof value === 'string' && value.trim())
      || refreshedItem.title
      || 'Sermon recording';
    const result = await openSermonRecordingPlayer({
      reader,
      binding: {
        projectId: refreshed.project.id,
        projectRevisionId: refreshed.revisionId,
        itemId,
        sermonId: refreshedDocument.id,
        sermonRevisionId: refreshedLinked.resource.sha256,
        recordingId
      },
      title,
      fileName: refreshedRecording.fileName,
      playbackEpoch: playbackAttempt.epoch,
      abortController
    });
    adopted = true;
    return result;
  } finally {
    if (!adopted) {
      if (sermonRecordingPlaybackAbortController === abortController) {
        sermonRecordingPlaybackAbortController = null;
      }
      abortController.abort();
      await reader?.close().catch(() => {});
    }
  }
});

ipcMain.handle('prepare:projects:stopSermonRecordingPlayback', async event => {
  requireControlSender(event);
  await closeSermonRecordingPlayer();
  return { stopped: true };
});

ipcMain.handle('prepare:songs:read', async (event, request = {}) => {
  requireControlSender(event);
  requirePrepareRequest(request, 16 * 1024);
  const songId = prepareId(request.songId, 'Song');
  const revision = request.revisionId
    ? prepareRevision(request.revisionId, 'Song revision')
    : null;
  const services = getPrepareServices();
  if (!revision) {
    await recoverLocalSongFamilyCommit();
  }
  return services.localSongLibrary.read(songId, {
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
  const services = getPrepareServices();
  await recoverLocalSongFamilyCommit();
  return services.localSongLibrary.validateSource(documentSource, {
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
  const services = getPrepareServices();
  await recoverLocalSongFamilyCommit();
  const library = services.localSongLibrary;
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
  await recoverLocalSongFamilyCommit();
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
  const services = getPrepareServices();
  await recoverLocalSongFamilyCommit();
  const library = services.localSongLibrary;
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
  await recoverLocalSongFamilyCommit();
  const songId = prepareId(request.songId, 'Song');
  const songRevision = request.songRevisionId || request.songRevision;
  const songRead = await current.services.localSongLibrary.read(songId, {
    ...(songRevision ? { revision: prepareRevision(songRevision, 'Song revision') } : {})
  });
  const prepared = prepareServiceSongItem(
    current.project,
    songRead,
    request.arrangement
  );
  const next = addProjectItem(prepared.project, prepared.item, {
    parentId: request.parentId ? prepareId(request.parentId, 'Parent item') : null
  });
  return projectResult(await current.services.serviceProjectStore.save(next, {
    expectedRevisionId: current.expectedRevisionId,
    reason: 'add-song'
  }));
});

ipcMain.handle('prepare:projects:replaceSong', async (event, request = {}) => {
  requireControlSender(event);
  requirePrepareRequest(request, 32 * 1024);
  const current = await readExpectedProject(request);
  const itemId = prepareId(request.itemId, 'Song item');
  projectSongItem(current.project, itemId);
  await recoverLocalSongFamilyCommit();
  const songId = prepareId(request.songId, 'Replacement song');
  const songRevisionId = prepareRevision(
    request.songRevisionId,
    'Replacement song revision'
  );
  const songRead = await current.services.localSongLibrary.read(songId, {
    revision: songRevisionId
  });
  const prepared = prepareServiceSongItem(current.project, songRead);
  const replacementItemId = prepared.item.id;
  const next = replaceSongItem(
    prepared.project,
    itemId,
    prepared.item
  );
  const saved = await current.services.serviceProjectStore.save(next, {
    expectedRevisionId: current.expectedRevisionId,
    reason: 'replace-song'
  });
  return {
    ...projectResult(saved),
    replacementItemId
  };
});

ipcMain.handle('prepare:projects:sourceSermon', async (event, request = {}) => {
  requireControlSender(event);
  requirePrepareRequest(request, 16 * 1024);
  const current = await readExpectedProject(request);
  if (isPowerPointCompanionProject(current.project)) {
    failMainOperation(
      'CURRENT_SERVICE_COMPANION_LINK_LOCKED',
      'Create this PowerPoint service sermon through the reviewed current-files handoff.'
    );
  }
  const itemId = prepareId(request.itemId, 'Service item');
  const sermonId = prepareSermonDomainId(request.sermonId, 'Sermon');
  const sermonRevisionId = prepareRevision(request.sermonRevisionId, 'Sermon revision');
  const sermonSectionId = request.sermonSectionId === undefined
    || request.sermonSectionId === null
    || request.sermonSectionId === ''
    ? null
    : prepareSermonDomainId(request.sermonSectionId, 'Sermon outline section');
  const item = current.project.items[itemId];
  if (!isSermonSourceTarget(current.project, item)) {
    failMainOperation(
      'INVALID_SERMON_SOURCE_ITEM',
      'Choose a sermon cue or sermon outline group before linking a sermon source.'
    );
  }
  const embeddedResource = Object.values(current.project.resources).find(resource =>
    resource.kind === 'sermon'
    && resource.document.id === sermonId
    && resource.sha256 === sermonRevisionId) || null;
  const sermonRead = embeddedResource
    ? null
    : await current.services.localSermonLibrary.readRevision(
        sermonId,
        sermonRevisionId
      );
  const sermonDocument = embeddedResource?.document || sermonRead.sermon;
  if (
    sermonSectionId
    && !sermonDocument.outline.some(section => section.id === sermonSectionId)
  ) {
    failMainOperation(
      'UNKNOWN_SERMON_SECTION',
      'That outline section is not part of the selected sermon revision.'
    );
  }
  const withResource = embeddedResource
    ? {
        project: current.project,
        resourceId: embeddedResource.id
      }
    : addSermonResource(current.project, sermonDocument, {
        provider: 'local-sermon-library',
        itemId: sermonDocument.id,
        revision: sermonRead.revision
      });
  const linked = setSermonSourceLink(withResource.project, {
    itemId,
    sermonResourceId: withResource.resourceId,
    sermonSectionId
  });
  return projectResult(await current.services.serviceProjectStore.save(linked, {
    expectedRevisionId: current.expectedRevisionId,
    reason: 'source-sermon'
  }));
});

ipcMain.handle('prepare:projects:saveSermonText', async (event, request = {}) => {
  requireControlSender(event);
  // JSON escaping can double valid quote/backslash-heavy UTF-8 text. The
  // semantic 1 MiB-per-entry and 1.5 MiB-combined limits remain domain-owned.
  requirePrepareRequest(request, (3 * 1024 * 1024) + (64 * 1024));
  requireExactPrepareKeys(request, [
    'projectId',
    'expectedRevisionId',
    'itemId',
    'sermonId',
    'expectedSermonRevisionId',
    'language',
    'manuscript',
    'slideNotes',
    'confirmed'
  ], 'Native sermon material');
  if (request.confirmed !== true) {
    failMainOperation(
      'NATIVE_SERMON_MATERIAL_REVIEW_REQUIRED',
      'Confirm the complete pasted text and language before saving.'
    );
  }
  const current = await readExpectedProject(request);
  const itemId = prepareId(request.itemId, 'Service item');
  const sermonId = prepareSermonDomainId(request.sermonId, 'Sermon');
  const expectedSermonRevisionId = prepareRevision(
    request.expectedSermonRevisionId,
    'Expected sermon revision'
  );
  const language = prepareText(
    request.language,
    'Sermon material language',
    35,
    { required: true }
  ).toLowerCase();
  if (typeof request.manuscript !== 'string'
    || typeof request.slideNotes !== 'string') {
    failMainOperation(
      'INVALID_NATIVE_SERMON_MATERIAL',
      'Pasted sermon material must be UTF-8 text.'
    );
  }

  const item = current.project.items[itemId];
  if (!isSermonSourceTarget(current.project, item)) {
    failMainOperation(
      'INVALID_SERMON_SOURCE_ITEM',
      'Choose a sermon cue or sermon outline group before saving sermon material.'
    );
  }
  const linked = resolveSermonSourceLink(current.project, item);
  if (
    !linked
    || linked.resource.document.id !== sermonId
    || linked.resource.sha256 !== expectedSermonRevisionId
  ) {
    failMainOperation(
      'SERMON_SOURCE_LINK_CHANGED',
      'This service item is no longer linked to that sermon revision. Reload it before saving sermon material.'
    );
  }
  const sermonRead = await current.services.localSermonLibrary.readCurrent(
    sermonId
  );
  if (sermonRead.revision !== expectedSermonRevisionId) {
    failMainOperation(
      'SERMON_CONFLICT',
      'This sermon changed since it was linked. Reload it before saving sermon material.',
      {
        currentRevisionId: sermonRead.revision,
        expectedRevisionId: expectedSermonRevisionId
      }
    );
  }

  let proposal;
  let commit;
  let application;
  try {
    proposal = buildNativeSermonMaterialProposal({
      sermon: sermonRead.sermon,
      binding: {
        projectId: current.projectId,
        expectedProjectRevisionId: current.expectedRevisionId,
        itemId,
        resourceId: linked.resourceId,
        resourceOwnerId: linked.resourceOwnerId,
        sermonId,
        expectedSermonRevisionId
      },
      materials: {
        manuscript: request.manuscript.trim()
          ? {
              text: request.manuscript,
              language,
              providedBy: sermonRead.sermon.speaker.name
            }
          : null,
        slideNotes: request.slideNotes.trim()
          ? {
              text: request.slideNotes,
              language,
              providedBy: sermonRead.sermon.speaker.name
            }
          : null
      }
    });
    commit = confirmNativeSermonMaterialProposal(
      proposal,
      sermonRead.sermon,
      {
        confirmed: true,
        statementId: NATIVE_SERMON_MATERIAL_REVIEW_STATEMENT_ID,
        reviewFingerprint: proposal.review.reviewFingerprint,
        materials: proposal.review.materials
      }
    );
    application = applyNativeSermonMaterialCommit(
      sermonRead.sermon,
      commit
    );
  } catch (error) {
    failNativeSermonMaterialIntake(error);
  }

  if (!application.requiresCommit) {
    return {
      ...projectResult({
        project: current.project,
        revisionId: current.revisionId,
        unchanged: true,
        recovery: current.recovery || null
      }),
      sermonId,
      sermonRevisionId: sermonRead.revision,
      sourceCount: sermonRead.sermon.sources.length,
      bodyEntryCount: sermonRead.sermon.body?.length || 0,
      material: {
        addedRoles: [],
        replacedRoles: [],
        unchangedRoles: application.unchangedRoles,
        unchanged: true
      }
    };
  }

  const changedSourceIds = new Set(application.changedSourceIds);
  const bodyBySourceId = new Map(
    commit.bodyEntries.map(entry => [entry.sourceId, entry])
  );
  for (const source of commit.sources) {
    if (!changedSourceIds.has(source.id)) continue;
    const body = bodyBySourceId.get(source.id);
    if (!body) {
      failMainOperation(
        'NATIVE_SERMON_MATERIAL_CHANGED',
        'The reviewed pasted sermon material changed before private storage.'
      );
    }
    let imported;
    try {
      imported = await current.services.localSermonSourceStore.importText({
        id: source.id,
        text: body.text,
        fileName: source.fileName,
        kind: source.kind,
        languages: source.languages,
        provenance: source.provenance
      });
    } catch (error) {
      failSermonSourceImport(error);
    }
    if (
      imported.text !== body.text
      || !sameNativeSermonMaterialSource(imported.source, source)
    ) {
      failMainOperation(
        'NATIVE_SERMON_MATERIAL_CHANGED',
        'The reviewed pasted sermon material changed while it was being preserved.'
      );
    }
  }

  const withResource = addSermonResource(
    current.project,
    application.document,
    {
      provider: 'local-sermon-library',
      itemId: application.document.id,
      revision: application.revision
    }
  );
  if (withResource.resourceId !== application.transaction.nextResourceId) {
    failMainOperation(
      'NATIVE_SERMON_MATERIAL_CHANGED',
      'The reviewed pasted sermon revision changed before it could be linked.'
    );
  }
  const repinned = linked.resourceId === withResource.resourceId
    ? withResource.project
    : repinSermonRevision(withResource.project, {
        previousResourceId: linked.resourceId,
        nextResourceId: withResource.resourceId
      });
  const committed = await current.services.sermonProjectCommitCoordinator.commit({
    project: repinned,
    expectedProjectRevisionId: current.expectedRevisionId,
    sermonDocument: application.document,
    expectedSermonRevision: sermonRead.revision,
    resourceId: withResource.resourceId,
    resourceOwnerId: linked.resourceOwnerId,
    reason: application.transaction.reason
  });
  const result = {
    ...projectResult(committed.project),
    sermonId,
    sermonRevisionId: committed.sermon.revision,
    sourceCount: application.document.sources.length,
    bodyEntryCount: application.document.body.length,
    material: {
      addedRoles: application.addedRoles,
      replacedRoles: application.replacedRoles,
      unchangedRoles: application.unchangedRoles,
      unchanged: false
    }
  };
  if (committed.recovery?.message && !result.recovery) {
    result.recovery = {
      source: 'sermon-project-transaction',
      message: committed.recovery.message
    };
  }
  return result;
});

ipcMain.handle('prepare:projects:attachSermonSource', async (event, request = {}) => {
  requireControlSender(event);
  requirePrepareRequest(request, 16 * 1024);
  const current = await readExpectedProject(request);
  const itemId = prepareId(request.itemId, 'Service item');
  const sermonId = prepareSermonDomainId(request.sermonId, 'Sermon');
  const expectedSermonRevisionId = prepareRevision(
    request.expectedSermonRevisionId,
    'Expected sermon revision'
  );
  const sourceKind = prepareText(
    request.kind,
    'Sermon source kind',
    24,
    { required: true }
  ).toLowerCase();
  const allowedSourceKinds = new Set(['manuscript', 'slide-notes', 'transcript', 'other']);
  if (!allowedSourceKinds.has(sourceKind)) {
    failMainOperation(
      'INVALID_SERMON_SOURCE_KIND',
      'Choose manuscript, slide notes, transcript, or other for this sermon source.'
    );
  }
  const languages = prepareLanguageTags(
    request.languages ?? request.language,
    'Sermon source languages'
  );
  const providedBy = prepareText(request.providedBy, 'Sermon source provider', 200);

  const item = current.project.items[itemId];
  if (!isSermonSourceTarget(current.project, item)) {
    failMainOperation(
      'INVALID_SERMON_SOURCE_ITEM',
      'Choose a sermon cue or sermon outline group before attaching a sermon source.'
    );
  }
  const resolvedSource = resolveSermonSourceLink(current.project, item);
  if (
    !resolvedSource
    || resolvedSource.resource.document.id !== sermonId
    || resolvedSource.resource.sha256 !== expectedSermonRevisionId
  ) {
    failMainOperation(
      'SERMON_SOURCE_LINK_CHANGED',
      'This service item is no longer linked to that sermon revision. Reload it before attaching a source.'
    );
  }

  const sermonRead = await current.services.localSermonLibrary.readCurrent(sermonId);
  if (sermonRead.revision !== expectedSermonRevisionId) {
    failMainOperation(
      'SERMON_CONFLICT',
      'This sermon changed since it was linked. Reload it before attaching a source.',
      {
        currentRevisionId: sermonRead.revision,
        expectedRevisionId: expectedSermonRevisionId
      }
    );
  }

  const selected = await dialog.showOpenDialog(controlWindow, {
    title: 'Attach Sermon Source',
    filters: [{
      name: 'Sermon sources',
      extensions: ['pdf', 'docx', 'pptx', 'txt', 'md', 'markdown']
    }],
    properties: ['openFile']
  });
  if (selected.canceled || selected.filePaths.length === 0) return null;
  if (selected.filePaths.length !== 1) {
    failMainOperation(
      'INVALID_SERMON_SOURCE_SELECTION',
      'Choose one sermon source file at a time.'
    );
  }

  let imported;
  try {
    imported = await current.services.localSermonSourceStore.importFile({
      sourcePath: selected.filePaths[0],
      id: projectItemId('source'),
      kind: sourceKind,
      languages,
      provenance: {
        providedBy,
        receivedAt: new Date().toISOString(),
        sourceSystem: 'manual-file-picker'
      }
    });
  } catch (error) {
    failSermonSourceImport(error);
  }

  const existingSourceIndex = sermonRead.sermon.sources.findIndex(source =>
    source.sha256 === imported.source.sha256);
  const updateExistingMetadata = request.updateExistingMetadata === true;
  if (existingSourceIndex >= 0 && !updateExistingMetadata) {
    return projectResult({
      project: current.project,
      revisionId: current.revisionId,
      unchanged: true,
      recovery: current.recovery || null
    });
  }

  const writableSermon = upgradeSermonDocument(sermonRead.sermon);
  const writableSourceIndex = writableSermon.sources.findIndex(source =>
    source.sha256 === imported.source.sha256);
  const nextSources = writableSourceIndex < 0
    ? [...writableSermon.sources, imported.source]
    : writableSermon.sources.map((source, index) => (
        index === writableSourceIndex
          ? {
              ...source,
              kind: imported.source.kind,
              languages: imported.source.languages,
              provenance: {
                ...source.provenance,
                providedBy: imported.source.provenance.providedBy
              }
            }
          : source
      ));
  const correctedSource = writableSourceIndex >= 0
    ? nextSources[writableSourceIndex]
    : null;
  const linkedBodyKindChanged = Boolean(
    correctedSource
    && writableSermon.sources[writableSourceIndex].kind !== correctedSource.kind
    && writableSermon.body.some(entry => entry.sourceId === correctedSource.id)
  );
  if (
    linkedBodyKindChanged
    && writableSermon.publication.status === 'archived'
  ) {
    failMainOperation(
      'ARCHIVED_SERMON',
      'Restore this archived sermon before changing the kind of a source linked to its reviewed body.'
    );
  }
  const nextBody = linkedBodyKindChanged
    ? writableSermon.body.map(entry => (
        entry.sourceId === correctedSource.id
          ? { ...entry, kind: correctedSource.kind }
          : entry
      ))
    : writableSermon.body;
  const nextPublication = linkedBodyKindChanged
    && ['ready', 'published'].includes(writableSermon.publication.status)
    ? {
        ...writableSermon.publication,
        status: 'draft',
        publishedAt: null
      }
    : writableSermon.publication;
  const nextSermonDocument = {
    ...writableSermon,
    sources: nextSources,
    body: nextBody,
    publication: nextPublication
  };
  const nextSermonRevisionId = sermonDocumentSha256(nextSermonDocument);
  const withResource = addSermonResource(current.project, nextSermonDocument, {
    provider: 'local-sermon-library',
    itemId: nextSermonDocument.id,
    revision: nextSermonRevisionId
  });
  const repinned = resolvedSource.resourceId === withResource.resourceId
    ? withResource.project
    : repinSermonRevision(withResource.project, {
        previousResourceId: resolvedSource.resourceId,
        nextResourceId: withResource.resourceId
      });
  const committed = await current.services.sermonProjectCommitCoordinator.commit({
    project: repinned,
    expectedProjectRevisionId: current.expectedRevisionId,
    sermonDocument: nextSermonDocument,
    expectedSermonRevision: sermonRead.revision,
    resourceId: withResource.resourceId,
    resourceOwnerId: resolvedSource.resourceOwnerId,
    reason: 'attach-sermon-source'
  });
  const result = projectResult(committed.project);
  if (committed.recovery?.message && !result.recovery) {
    result.recovery = {
      source: 'sermon-project-transaction',
      message: committed.recovery.message
    };
  }
  return result;
});

ipcMain.handle('prepare:projects:attachSermonRecording', async (event, request = {}) => {
  requireControlSender(event);
  requirePrepareRequest(request, 8 * 1024);
  requireExactPrepareKeys(request, [
    'projectId',
    'expectedRevisionId',
    'itemId',
    'sermonId',
    'expectedSermonRevisionId'
  ], 'Sermon recording intake');

  const current = await readExpectedProject(request);
  const itemId = prepareId(request.itemId, 'Service item');
  const sermonId = prepareSermonDomainId(request.sermonId, 'Sermon');
  const expectedSermonRevisionId = prepareRevision(
    request.expectedSermonRevisionId,
    'Expected sermon revision'
  );
  const item = current.project.items[itemId];
  if (!isSermonSourceTarget(current.project, item)) {
    failMainOperation(
      'INVALID_SERMON_SOURCE_ITEM',
      'Choose a linked sermon cue or sermon outline group before preserving its recording.'
    );
  }
  const linked = resolveSermonSourceLink(current.project, item);
  if (
    !linked
    || linked.resource.document.id !== sermonId
    || linked.resource.sha256 !== expectedSermonRevisionId
  ) {
    failMainOperation(
      'SERMON_SOURCE_LINK_CHANGED',
      'This service item is no longer linked to that sermon revision. Reload it before choosing a recording.'
    );
  }

  const sermonRead = await current.services.localSermonLibrary.readCurrent(
    sermonId
  );
  if (sermonRead.revision !== expectedSermonRevisionId) {
    failMainOperation(
      'SERMON_CONFLICT',
      'This sermon changed since it was linked. Link the current revision before preserving a recording.',
      {
        currentRevisionId: sermonRead.revision,
        expectedRevisionId: expectedSermonRevisionId
      }
    );
  }
  const managedRecordingId =
    `post-service:recording:${sermonRead.sermon.defaultLanguage}`;
  const managedRecording = (Array.isArray(sermonRead.sermon.media)
    ? sermonRead.sermon.media
    : []).find(media => media?.id === managedRecordingId) || null;
  let localRepairNeeded = false;
  if (/^[a-f0-9]{64}$/u.test(String(managedRecording?.sha256 || ''))) {
    try {
      await current.services.localSermonMediaStore.checkMedia(managedRecording);
    } catch (error) {
      localRepairNeeded = ['OBJECT_NOT_FOUND', 'OBJECT_CORRUPT'].includes(
        error?.code
      );
    }
  }
  const publicationLocked = ['published', 'archived'].includes(
    sermonRead.sermon.publication.status
  );
  if (publicationLocked && !localRepairNeeded) {
    failMainOperation(
      'POST_SERVICE_PUBLICATION_LOCKED',
      sermonRead.sermon.publication.status === 'published'
        ? 'Published sermon media cannot be revised here. If this computer loses the exact private copy, SyncShow can restore only the same verified recording.'
        : 'Archived sermon media cannot be revised here. If this computer loses the exact private copy, SyncShow can restore only the same verified recording.'
    );
  }

  const selected = await dialog.showOpenDialog(controlWindow, {
    title: publicationLocked
      ? 'Restore Exact Sermon Recording'
      : localRepairNeeded
        ? 'Restore or Replace Sermon Recording'
        : 'Preserve Sermon Recording',
    filters: [{
      name: 'Sermon recordings',
      extensions: ['mp3', 'm4a', 'mp4']
    }],
    properties: ['openFile']
  });
  if (selected.canceled || selected.filePaths.length === 0) return null;
  if (selected.filePaths.length !== 1) {
    failMainOperation(
      'INVALID_SERMON_RECORDING_SELECTION',
      'Choose one sermon recording file at a time.'
    );
  }

  if (localRepairNeeded) {
    const latest = await readExpectedProject(request);
    const latestLinked = resolveSermonSourceLink(
      latest.project,
      latest.project.items[itemId]
    );
    const latestSermon = await latest.services.localSermonLibrary.readCurrent(
      sermonId
    );
    if (
      latestLinked?.resourceId !== linked.resourceId
      || latestLinked?.resource?.document?.id !== sermonId
      || latestLinked?.resource?.sha256 !== expectedSermonRevisionId
      || latestSermon.revision !== expectedSermonRevisionId
    ) {
      failMainOperation(
        'SERMON_SOURCE_LINK_CHANGED',
        'This service or sermon changed while the recording picker was open. Nothing was restored.'
      );
    }
  }

  let imported;
  let restoredExactRecording = false;
  try {
    if (localRepairNeeded) {
      try {
        imported = await current.services.localSermonMediaStore.restoreFile({
          sourcePath: selected.filePaths[0],
          expectedMedia: {
            kind: managedRecording.kind,
            mediaType: managedRecording.mediaType,
            fileName: managedRecording.fileName,
            sha256: managedRecording.sha256,
            sizeBytes: managedRecording.sizeBytes,
            durationSeconds: managedRecording.durationSeconds
          }
        });
        restoredExactRecording = true;
      } catch (error) {
        if (publicationLocked || error?.code !== 'MEDIA_RESTORE_MISMATCH') {
          throw error;
        }
        imported = await current.services.localSermonMediaStore.importFile({
          sourcePath: selected.filePaths[0]
        });
      }
    } else {
      imported = await current.services.localSermonMediaStore.importFile({
          sourcePath: selected.filePaths[0]
      });
    }
  } catch (error) {
    failSermonMediaImport(error);
  }
  if (
    !imported
    || typeof imported.media?.sha256 !== 'string'
    || imported.objectId !== `sha256:${imported.media.sha256}`
  ) {
    failMainOperation(
      'SERMON_RECORDING_IMPORT_FAILED',
      'The private sermon recording store returned inconsistent content identity.'
    );
  }
  if (restoredExactRecording) {
    return {
      ...projectResult({
        project: current.project,
        revisionId: current.revisionId,
        unchanged: true,
        recovery: current.recovery || null
      }),
      sermonId,
      sermonRevisionId: sermonRead.revision,
      localRecordingRestored: true,
      postServiceReadiness: analyzeSermonPostServiceReadiness(
        sermonRead.sermon
      )
    };
  }

  let reviewed;
  try {
    reviewed = attachLocalSermonRecording(
      sermonRead.sermon,
      imported.media
    );
  } catch (error) {
    failMainOperation(
      error.code || 'INVALID_SERMON_RECORDING',
      error.message || 'That sermon recording could not be attached safely.',
      error.details || {}
    );
  }
  const nextSermonRevisionId = sermonDocumentSha256(reviewed.document);
  if (nextSermonRevisionId === sermonRead.revision) {
    return {
      ...projectResult({
        project: current.project,
        revisionId: current.revisionId,
        unchanged: true,
        recovery: current.recovery || null
      }),
      sermonId,
      sermonRevisionId: sermonRead.revision,
      postServiceReadiness: reviewed.readiness
    };
  }

  const repinned = repinCompatibleSermonDocument(
    current.project,
    reviewed.document,
    {
      previousResourceId: linked.resourceId,
      origin: {
        provider: 'local-sermon-library',
        itemId: reviewed.document.id,
        revision: nextSermonRevisionId
      }
    }
  );
  const committed =
    await current.services.sermonProjectCommitCoordinator.commit({
      project: repinned.project,
      expectedProjectRevisionId: current.expectedRevisionId,
      sermonDocument: reviewed.document,
      expectedSermonRevision: sermonRead.revision,
      resourceId: repinned.resourceId,
      resourceOwnerId: linked.resourceOwnerId,
      reason: 'attach-sermon-recording'
    });
  const result = {
    ...projectResult(committed.project),
    sermonId,
    sermonRevisionId: committed.sermon.revision,
    postServiceReadiness: reviewed.readiness
  };
  if (committed.recovery?.message && !result.recovery) {
    result.recovery = {
      source: 'sermon-project-transaction',
      message: committed.recovery.message
    };
  }
  return result;
});

ipcMain.handle('prepare:projects:reviewSermonPostServiceLinks', async (event, request = {}) => {
  requireControlSender(event);
  requirePrepareRequest(request, 12 * 1024);
  requireExactPrepareKeys(request, [
    'projectId',
    'expectedRevisionId',
    'itemId',
    'sermonId',
    'expectedSermonRevisionId',
    'action',
    'canonicalUrl',
    'recording',
    'text'
  ], 'Post-service sermon review');

  const current = await readExpectedProject(request);
  const itemId = prepareId(request.itemId, 'Service item');
  const sermonId = prepareSermonDomainId(request.sermonId, 'Sermon');
  const expectedSermonRevisionId = prepareRevision(
    request.expectedSermonRevisionId,
    'Expected sermon revision'
  );
  const action = prepareText(
    request.action,
    'Post-service review action',
    24,
    { required: true }
  );
  if (!['save-draft', 'mark-ready'].includes(action)) {
    failMainOperation(
      'INVALID_POST_SERVICE_REVIEW',
      'Choose whether to save these links as a draft or mark the reviewed record ready.'
    );
  }
  const canonicalUrl = prepareText(
    request.canonicalUrl,
    'Canonical sermon page',
    4096
  );
  const recording = preparePostServiceLinkSlot(
    request.recording,
    'Recording',
    ['audio', 'video']
  );
  const textLink = preparePostServiceLinkSlot(
    request.text,
    'Notes or transcript',
    ['document', 'transcript']
  );

  const item = current.project.items[itemId];
  if (!isSermonSourceTarget(current.project, item)) {
    failMainOperation(
      'INVALID_SERMON_SOURCE_ITEM',
      'Choose a linked sermon cue or sermon outline group before reviewing post-service links.'
    );
  }
  const linked = resolveSermonSourceLink(current.project, item);
  if (
    !linked
    || linked.resource.document.id !== sermonId
    || linked.resource.sha256 !== expectedSermonRevisionId
  ) {
    failMainOperation(
      'SERMON_SOURCE_LINK_CHANGED',
      'This service item is no longer linked to that sermon revision. Reload it before reviewing post-service links.'
    );
  }

  const sermonRead = await current.services.localSermonLibrary.readCurrent(sermonId);
  if (sermonRead.revision !== expectedSermonRevisionId) {
    failMainOperation(
      'SERMON_CONFLICT',
      'This sermon changed since it was linked. Link the current revision before reviewing post-service links.',
      {
        currentRevisionId: sermonRead.revision,
        expectedRevisionId: expectedSermonRevisionId
      }
    );
  }

  let reviewed;
  try {
    reviewed = planSermonPostServiceLinks(sermonRead.sermon, {
      action,
      canonicalUrl,
      recording,
      text: textLink
    });
  } catch (error) {
    failMainOperation(
      error.code || 'INVALID_POST_SERVICE_REVIEW',
      error.message || 'Those post-service links could not be reviewed.',
      error.details || {}
    );
  }
  const nextSermonRevisionId = sermonDocumentSha256(reviewed.document);
  if (nextSermonRevisionId === sermonRead.revision) {
    return {
      ...projectResult({
        project: current.project,
        revisionId: current.revisionId,
        unchanged: true,
        recovery: current.recovery || null
      }),
      sermonId,
      sermonRevisionId: sermonRead.revision,
      postServiceReadiness: analyzeSermonPostServiceReadiness(sermonRead.sermon)
    };
  }

  const repinned = repinCompatibleSermonDocument(
    current.project,
    reviewed.document,
    {
      previousResourceId: linked.resourceId,
      origin: {
        provider: 'local-sermon-library',
        itemId: reviewed.document.id,
        revision: nextSermonRevisionId
      }
    }
  );
  const committed = await current.services.sermonProjectCommitCoordinator.commit({
    project: repinned.project,
    expectedProjectRevisionId: current.expectedRevisionId,
    sermonDocument: reviewed.document,
    expectedSermonRevision: sermonRead.revision,
    resourceId: repinned.resourceId,
    resourceOwnerId: linked.resourceOwnerId,
    reason: action === 'mark-ready'
      ? 'mark-sermon-post-service-ready'
      : 'review-sermon-post-service-links'
  });
  const result = {
    ...projectResult(committed.project),
    sermonId,
    sermonRevisionId: committed.sermon.revision,
    postServiceReadiness: reviewed.readiness
  };
  if (committed.recovery?.message && !result.recovery) {
    result.recovery = {
      source: 'sermon-project-transaction',
      message: committed.recovery.message
    };
  }
  return result;
});

async function exactSermonCueExtractionSnapshot(services, {
  sermonId,
  sermonRevisionId,
  source
}) {
  let snapshot;
  try {
    snapshot = await services.localSermonExtractionStore.readExactSnapshot({
      sermonId,
      baseSermonRevisionId: sermonRevisionId,
      sourceId: source.id,
      sourceSha256: source.sha256,
      sourceKind: source.kind,
      extractorId: SERMON_SOURCE_EXTRACTOR_ID,
      extractorVersion: SERMON_SOURCE_EXTRACTOR_VERSION
    });
    if (!snapshot) {
      const extraction = await sermonSourceExtractionCoordinator.run(
        sermonExtractionCoordinatorKey(source),
        async () => {
          const buffer = await services.localSermonSourceStore.readSource(source);
          return extractSermonSourceProposal(buffer, source);
        }
      );
      snapshot = await services.localSermonExtractionStore.saveSnapshot({
        sermonId,
        baseSermonRevisionId: sermonRevisionId,
        extraction
      });
    }
  } catch (error) {
    failSermonSourceExtraction(error);
  }
  return snapshot;
}

ipcMain.handle('prepare:projects:proposeSermonCueReconciliation', async (event, request = {}) => {
    requireControlSender(event);
    requirePrepareRequest(request, 64 * 1024);
    requireExactPrepareKeys(request, [
      'projectId',
      'expectedRevisionId',
      'itemId',
      'sermonId',
      'sermonRevisionId',
      'sourceMappings'
    ], 'Sermon slide reconciliation request');
    const current = await readExpectedProject(request);
    const itemId = prepareId(request.itemId, 'Sermon group');
    const sermonId = prepareSermonDomainId(request.sermonId, 'Sermon');
    const sermonRevisionId = prepareRevision(
      request.sermonRevisionId,
      'Sermon revision'
    );
    if (
      !Array.isArray(request.sourceMappings)
      || request.sourceMappings.length < 1
      || request.sourceMappings.length > 32
    ) {
      failMainOperation(
        'INVALID_SERMON_CUE_SOURCE_MAPPINGS',
        'Choose at least one slide-note source and no more than one source per output.'
      );
    }
    const sourceMappings = request.sourceMappings.map((mapping, index) => {
      if (!mapping || typeof mapping !== 'object' || Array.isArray(mapping)) {
        failMainOperation(
          'INVALID_SERMON_CUE_SOURCE_MAPPINGS',
          `Source mapping ${index + 1} is invalid.`
        );
      }
      requireExactPrepareKeys(
        mapping,
        ['channelId', 'sourceId'],
        `Sermon slide source mapping ${index + 1}`
      );
      return {
        channelId: prepareId(
          mapping.channelId,
          `Sermon slide output ${index + 1}`
        ),
        sourceId: prepareSermonDomainId(
          mapping.sourceId,
          `Sermon slide source ${index + 1}`
        )
      };
    });
    const mappedChannelIds = new Set();
    for (const mapping of sourceMappings) {
      if (!current.project.channelIds.includes(mapping.channelId)) {
        failMainOperation(
          'UNKNOWN_SERMON_CUE_CHANNEL',
          'One selected sermon-slide output is not part of this service.'
        );
      }
      if (mappedChannelIds.has(mapping.channelId)) {
        failMainOperation(
          'DUPLICATE_SERMON_CUE_CHANNEL',
          'Choose at most one slide-note source for each output.'
        );
      }
      mappedChannelIds.add(mapping.channelId);
    }

    try {
      requireSermonCueReconciliationAnchor(
        current.project,
        itemId,
        sermonId,
        sermonRevisionId
      );
    } catch (error) {
      failSermonCueReconciliation(error);
    }

    let sermonRead;
    try {
      sermonRead = await current.services.localSermonLibrary.readRevision(
        sermonId,
        sermonRevisionId
      );
    } catch (_error) {
      failMainOperation(
        'SERMON_REVISION_UNAVAILABLE',
        'This exact sermon revision is not available on this computer.'
      );
    }
    const snapshots = [];
    for (const mapping of sourceMappings) {
      const source = sermonRead.sermon.sources.find(candidate =>
        candidate.id === mapping.sourceId);
      if (!source) {
        failMainOperation(
          'UNKNOWN_SERMON_SOURCE',
          'One selected slide-note source is not part of this exact sermon revision.'
        );
      }
      if (
        source.kind !== 'slide-notes'
        || source.mediaType
          !== 'application/vnd.openxmlformats-officedocument.presentationml.presentation'
      ) {
        failMainOperation(
          'UNSUPPORTED_SERMON_CUE_SOURCE',
          'Build sermon slides only from an attached PowerPoint slide-notes source.'
        );
      }
      snapshots.push({
        channelId: mapping.channelId,
        snapshot: await exactSermonCueExtractionSnapshot(current.services, {
          sermonId,
          sermonRevisionId,
          source
        })
      });
    }

    let proposal;
    try {
      proposal = buildSermonCueReconciliationProposal({
        project: current.project,
        projectRevisionId: current.revisionId,
        anchorItemId: itemId,
        sermonId,
        sermonRevisionId,
        sourceMappings: snapshots,
        now: new Date()
      });
    } catch (error) {
      failSermonCueReconciliation(error);
    }
    return holdSermonCueReconciliationProposal({ proposal });
});

ipcMain.handle('prepare:projects:proposeCanonicalSermonBodyProjection', async (
  event,
  request = {}
) => {
  requireControlSender(event);
  requirePrepareRequest(request, 64 * 1024);
  requireExactPrepareKeys(request, [
    'projectId',
    'expectedRevisionId',
    'itemId',
    'sermonId',
    'sermonRevisionId',
    'channelMappings'
  ], 'Canonical sermon body projection request');
  const current = await readExpectedProject(request);
  const itemId = prepareId(request.itemId, 'Sermon group');
  const sermonId = prepareSermonDomainId(request.sermonId, 'Sermon');
  const sermonRevisionId = prepareRevision(
    request.sermonRevisionId,
    'Sermon revision'
  );
  if (
    !Array.isArray(request.channelMappings)
    || request.channelMappings.length !== current.project.channelIds.length
    || request.channelMappings.length > 32
  ) {
    failMainOperation(
      'EXPLICIT_CHANNEL_MAPPING_REQUIRED',
      'Choose one exact sermon body entry or Hidden for every output.'
    );
  }
  const channelMappings = request.channelMappings.map((mapping, index) => {
    if (!mapping || typeof mapping !== 'object' || Array.isArray(mapping)) {
      failMainOperation(
        'INVALID_CHANNEL_MAPPING',
        `Canonical sermon output mapping ${index + 1} is invalid.`
      );
    }
    requireExactPrepareKeys(
      mapping,
      ['channelId', 'mode', 'bodyEntryId'],
      `Canonical sermon output mapping ${index + 1}`
    );
    const mode = prepareText(
      mapping.mode,
      `Canonical sermon output mapping ${index + 1} mode`,
      16,
      { required: true }
    );
    if (!['body-entry', 'hidden'].includes(mode)) {
      failMainOperation(
        'INVALID_CHANNEL_MAPPING',
        'Each output must select one canonical body entry or Hidden.'
      );
    }
    return {
      channelId: prepareId(
        mapping.channelId,
        `Canonical sermon output ${index + 1}`
      ),
      mode,
      bodyEntryId: mode === 'hidden'
        ? null
        : prepareSermonDomainId(
            mapping.bodyEntryId,
            `Canonical sermon body entry ${index + 1}`
          )
    };
  });
  let proposal;
  try {
    proposal = buildCanonicalSermonBodyProjectionProposal({
      project: current.project,
      projectRevisionId: current.revisionId,
      anchorItemId: itemId,
      sermonId,
      sermonRevisionId,
      channelMappings,
      now: new Date()
    });
  } catch (error) {
    failCanonicalSermonBodyProjection(error);
  }
  return holdCanonicalSermonBodyProjectionProposal(proposal);
});

ipcMain.handle('prepare:projects:applyCanonicalSermonBodyProjection', async (
  event,
  request = {}
) => {
  requireControlSender(event);
  requirePrepareRequest(request, 3 * 1024 * 1024);
  requireExactPrepareKeys(request, [
    'proposalToken',
    'projectId',
    'expectedRevisionId',
    'itemId',
    'sermonId',
    'sermonRevisionId',
    'decisions',
    'placementIndex',
    'confirmed'
  ], 'Canonical sermon body projection apply request');
  const { proposalToken, entry } =
    requireCanonicalSermonBodyProjectionProposal(request.proposalToken);
  const decisions = prepareCanonicalSermonBodyProjectionDecisions(
    request.decisions,
    entry.proposal
  );
  const applyIntentHash =
    canonicalSermonBodyProjectionApplyIntentHash({
      ...request,
      decisions
    });
  return withCanonicalSermonBodyProjectionApplication(
    proposalToken,
    entry,
    applyIntentHash,
    async () => {
      const current = await readExpectedProject(request);
      const itemId = prepareId(request.itemId, 'Sermon group');
      const sermonId = prepareSermonDomainId(request.sermonId, 'Sermon');
      const sermonRevisionId = prepareRevision(
        request.sermonRevisionId,
        'Sermon revision'
      );
      if (
        current.projectId !== entry.proposal.project.id
        || current.revisionId !== entry.proposal.project.revisionId
        || itemId !== entry.proposal.anchor.itemId
        || sermonId !== entry.proposal.sermon.id
        || sermonRevisionId !== entry.proposal.sermon.revisionId
      ) {
        failMainOperation(
          'CANONICAL_SERMON_BODY_PROJECTION_BINDING_CHANGED',
          'The service or sermon changed after review. Review the canonical text again.'
        );
      }

      let recomputed;
      try {
        recomputed = buildCanonicalSermonBodyProjectionProposal({
          project: current.project,
          projectRevisionId: current.revisionId,
          anchorItemId: itemId,
          sermonId,
          sermonRevisionId,
          channelMappings: entry.proposal.channelMappings.map(mapping => ({
            channelId: mapping.channelId,
            mode: mapping.mode,
            bodyEntryId: mapping.bodyEntryId
          })),
          now: entry.proposal.createdAt
        });
      } catch (error) {
        failCanonicalSermonBodyProjection(error);
      }
      if (recomputed.id !== entry.proposal.id) {
        failMainOperation(
          'CANONICAL_SERMON_BODY_PROJECTION_CHANGED',
          'The canonical sermon-text proposal changed after review.'
        );
      }

      let applied;
      try {
        applied = applyCanonicalSermonBodyProjection({
          project: current.project,
          proposal: recomputed,
          decisions,
          placementIndex: request.placementIndex,
          confirmed: request.confirmed,
          idFactory: () => projectItemId('sermon')
        });
      } catch (error) {
        failCanonicalSermonBodyProjection(error);
      }
      const saved = applied.changed
        ? await current.services.serviceProjectStore.save(applied.project, {
            expectedRevisionId: current.expectedRevisionId,
            reason: 'project-canonical-sermon-body'
          })
        : {
            project: current.project,
            revisionId: current.revisionId,
            unchanged: true,
            recovery: current.recovery || null
          };
      return {
        ...projectResult(saved),
        bodyProjection: {
          proposalId: entry.proposal.id,
          insertedItemIds: applied.insertedItemIds,
          updatedItemIds: applied.updatedItemIds,
          skippedParagraphIdsByChannel:
            applied.skippedParagraphIdsByChannel
        }
      };
    }
  );
});

ipcMain.handle('prepare:projects:applySermonCueReconciliation', async (event, request = {}) => {
    requireControlSender(event);
    requirePrepareRequest(request, 3 * 1024 * 1024);
    requireExactPrepareKeys(request, [
      'proposalToken',
      'projectId',
      'expectedRevisionId',
      'itemId',
      'sermonId',
      'sermonRevisionId',
      'decisions',
      'placementIndex',
      'confirmed'
    ], 'Sermon slide reconciliation apply request');
    const { proposalToken, entry } = requireSermonCueReconciliationProposal(
      request.proposalToken
    );
    const applyIntentHash = sermonCueReconciliationApplyIntentHash(request);
    return withSermonCueReconciliationApplication(
      proposalToken,
      entry,
      applyIntentHash,
      async () => {
        const current = await readExpectedProject(request);
        const itemId = prepareId(request.itemId, 'Sermon group');
        const sermonId = prepareSermonDomainId(request.sermonId, 'Sermon');
        const sermonRevisionId = prepareRevision(
          request.sermonRevisionId,
          'Sermon revision'
        );
        if (
          current.projectId !== entry.proposal.project.id
          || current.revisionId !== entry.proposal.project.revisionId
          || itemId !== entry.proposal.anchor.itemId
          || sermonId !== entry.proposal.sermon.id
          || sermonRevisionId !== entry.proposal.sermon.revisionId
        ) {
          failMainOperation(
            'SERMON_CUE_RECONCILIATION_BINDING_CHANGED',
            'The service or sermon changed after review. Review the slide mappings again.'
          );
        }

        for (const channelId of entry.proposal.channelIds) {
          const pool = entry.proposal.sourceOptionsByChannel[channelId];
          let snapshot;
          try {
            snapshot = await current.services.localSermonExtractionStore
              .readExactSnapshot({
                sermonId,
                baseSermonRevisionId: sermonRevisionId,
                sourceId: pool.source.id,
                sourceSha256: pool.source.sha256,
                sourceKind: pool.source.kind,
                extractorId: pool.extractor.id,
                extractorVersion: pool.extractor.version
              });
          } catch (error) {
            failSermonSourceExtraction(error);
          }
          if (!snapshot || snapshot.snapshotHash !== pool.snapshotHash) {
            failMainOperation(
              'SERMON_CUE_EXTRACTION_CHANGED',
              'The exact slide extraction is no longer available. Review the source mappings again.'
            );
          }
        }

        let applied;
        try {
          applied = applySermonCueReconciliation({
            project: current.project,
            proposal: entry.proposal,
            decisions: request.decisions,
            placementIndex: request.placementIndex,
            confirmed: request.confirmed,
            idFactory: () => projectItemId('sermon')
          });
        } catch (error) {
          failSermonCueReconciliation(error);
        }
        const saved = applied.changed
          ? await current.services.serviceProjectStore.save(applied.project, {
              expectedRevisionId: current.expectedRevisionId,
              reason: 'reconcile-sermon-cues'
            })
          : {
              project: current.project,
              revisionId: current.revisionId,
              unchanged: true,
              recovery: current.recovery || null
            };
        return {
          ...projectResult(saved),
          reconciliation: {
            proposalId: entry.proposal.id,
            insertedItemIds: applied.insertedItemIds,
            updatedItemIds: applied.updatedItemIds,
            reorderedItemIds: applied.reorderedItemIds,
            skippedRowIds: applied.skippedRowIds,
            unmappedChannelIds: entry.proposal.unmappedChannelIds
          }
        };
      }
    );
});

ipcMain.handle('prepare:projects:proposeSermonExtraction', async (event, request = {}) => {
  requireControlSender(event);
  requirePrepareRequest(request, 16 * 1024);
  const current = await readExpectedProject({
    ...request,
    expectedRevisionId: request.revisionId
  });
  const itemId = prepareId(request.itemId, 'Service item');
  const sermonId = prepareSermonDomainId(request.sermonId, 'Sermon');
  const sermonRevisionId = prepareRevision(
    request.sermonRevisionId,
    'Sermon revision'
  );
  const sourceId = prepareSermonDomainId(request.sourceId, 'Sermon source');
  const item = current.project.items[itemId];
  if (!isSermonSourceTarget(current.project, item)) {
    failMainOperation(
      'INVALID_SERMON_SOURCE_ITEM',
      'Choose a linked sermon cue or sermon outline group before reviewing a source.'
    );
  }
  const linked = resolveSermonSourceLink(current.project, item);
  if (
    !linked
    || linked.resource.document.id !== sermonId
    || linked.resource.sha256 !== sermonRevisionId
  ) {
    failMainOperation(
      'SERMON_SOURCE_LINK_CHANGED',
      'This service item is no longer linked to that sermon revision. Reload it before extracting suggestions.'
    );
  }

  const sermonRead = await current.services.localSermonLibrary.readCurrent(sermonId);
  if (sermonRead.revision !== sermonRevisionId) {
    failMainOperation(
      'SERMON_CONFLICT',
      'This sermon changed since it was linked. Reload it before extracting suggestions.',
      {
        currentRevisionId: sermonRead.revision,
        expectedRevisionId: sermonRevisionId
      }
    );
  }
  if (sermonRead.sermon.publication.status === 'archived') {
    failMainOperation(
      'ARCHIVED_SERMON',
      'Restore this archived sermon before extracting source suggestions.'
    );
  }
  const source = sermonRead.sermon.sources.find(candidate => candidate.id === sourceId);
  if (!source) {
    failMainOperation(
      'UNKNOWN_SERMON_SOURCE',
      'That attached source is no longer part of this sermon revision.'
    );
  }

  const binding = {
    projectId: current.projectId,
    projectRevisionId: current.revisionId,
    itemId,
    resourceId: linked.resourceId,
    sermonId,
    sermonRevisionId,
    sourceId,
    sourceRevision: source.sha256
  };
  let proposalOperation;
  try {
    proposalOperation = sermonExtractionProposalCoordinator.run(
      sermonExtractionProposalCoordinatorKey(binding),
      async () => {
        let snapshot;
        let snapshotStatus = 'reused';
        let reviewedReceipt = null;
        try {
          const reviewedSnapshot = await current.services.localSermonExtractionStore
            .findReviewedSnapshot({
              sermonId,
              resultingSermonRevisionId: sermonRead.revision,
              sourceId: source.id,
              sourceSha256: source.sha256,
              projectId: current.projectId
            });
          if (reviewedSnapshot) {
            snapshot = reviewedSnapshot.snapshot;
            reviewedReceipt = reviewedSnapshot.receipt;
          } else {
            snapshot = await current.services.localSermonExtractionStore
              .readExactSnapshot({
                sermonId,
                baseSermonRevisionId: sermonRead.revision,
                sourceId: source.id,
                sourceSha256: source.sha256,
                sourceKind: source.kind,
                extractorId: SERMON_SOURCE_EXTRACTOR_ID,
                extractorVersion: SERMON_SOURCE_EXTRACTOR_VERSION
              });
          }
          if (!snapshot) {
            const extraction = await sermonSourceExtractionCoordinator.run(
              sermonExtractionCoordinatorKey(source),
              async () => {
                const buffer = await current.services.localSermonSourceStore.readSource(source);
                return extractSermonSourceProposal(buffer, source);
              }
            );
            snapshot = await current.services.localSermonExtractionStore.saveSnapshot({
              sermonId,
              baseSermonRevisionId: sermonRead.revision,
              extraction
            });
            snapshotStatus = snapshot.unchanged === true ? 'reused' : 'saved';
          }
        } catch (error) {
          failSermonSourceExtraction(error);
        }

        let built;
        try {
          built = await buildSermonExtractionReviewProposal({
            sermon: sermonRead.sermon,
            sermonRevision: sermonRead.revision,
            source,
            extraction: snapshot.extraction,
            proposalId: projectItemId('proposal'),
            resolveReference: resolveSermonExtractionReference
          });
        } catch (error) {
          failSermonSourceExtraction(error);
        }

        return holdSermonExtractionProposal({
          ...binding,
          snapshotHash: snapshot.snapshotHash,
          internalProposal: built.internalProposal,
          publicProposal: {
            ...built.publicProposal,
            savedReview: publicSermonExtractionSavedReview(
              snapshotStatus,
              reviewedReceipt
            )
          },
          appliedRevision: null,
          appliedSelectionSignature: null,
          appliedOutcome: null
        });
      }
    );
  } catch (error) {
    failSermonSourceExtraction(error);
  }
  return proposalOperation;
});

ipcMain.handle('prepare:projects:applySermonExtraction', async (event, request = {}) => {
  requireControlSender(event);
  requirePrepareRequest(request, 64 * 1024);
  const { proposalToken, entry } = requireSermonExtractionProposal(
    request.proposalToken
  );
  return withSermonExtractionProposalApplication(proposalToken, entry, async () => {
  const current = await readExpectedProject(request);
  const itemId = prepareId(request.itemId, 'Service item');
  const sermonId = prepareSermonDomainId(request.sermonId, 'Sermon');
  const expectedSermonRevisionId = prepareRevision(
    request.expectedSermonRevisionId,
    'Expected sermon revision'
  );
  const outlineSuggestionIds = prepareSermonSuggestionIds(
    request.outlineSuggestionIds,
    'Outline suggestions'
  );
  const referenceSuggestionIds = prepareSermonSuggestionIds(
    request.referenceSuggestionIds,
    'Reference suggestions'
  );
  if (outlineSuggestionIds.length + referenceSuggestionIds.length < 1) {
    failMainOperation(
      'EMPTY_SERMON_EXTRACTION_SELECTION',
      'Check at least one reviewed suggestion before applying.'
    );
  }
  if (
    entry.projectId !== current.projectId
    || entry.projectRevisionId !== current.expectedRevisionId
    || entry.itemId !== itemId
    || entry.sermonId !== sermonId
    || entry.sermonRevisionId !== expectedSermonRevisionId
  ) {
    failMainOperation(
      'SERMON_EXTRACTION_BINDING_CHANGED',
      'The service or sermon revision changed after extraction. Extract a fresh proposal.'
    );
  }

  const item = current.project.items[itemId];
  if (!isSermonSourceTarget(current.project, item)) {
    failMainOperation(
      'INVALID_SERMON_SOURCE_ITEM',
      'Choose a linked sermon cue or sermon outline group before applying suggestions.'
    );
  }
  const linked = resolveSermonSourceLink(current.project, item);
  if (
    !linked
    || linked.resourceId !== entry.resourceId
    || linked.resource.document.id !== sermonId
    || linked.resource.sha256 !== expectedSermonRevisionId
  ) {
    failMainOperation(
      'SERMON_SOURCE_LINK_CHANGED',
      'The linked sermon changed after extraction. Extract a fresh proposal.'
    );
  }

  const sermonRead = await current.services.localSermonLibrary.readCurrent(sermonId);
  const selectionSignature = JSON.stringify({
    outlineSuggestionIds: [...outlineSuggestionIds].sort(),
    referenceSuggestionIds: [...referenceSuggestionIds].sort()
  });
  if (
    sermonRead.revision !== expectedSermonRevisionId
    && (
      entry.appliedRevision !== sermonRead.revision
      || entry.appliedSelectionSignature !== selectionSignature
    )
  ) {
    failMainOperation(
      'SERMON_CONFLICT',
      'This sermon changed after extraction. Extract a fresh proposal before applying suggestions.',
      {
        currentRevisionId: sermonRead.revision,
        expectedRevisionId: expectedSermonRevisionId
      }
    );
  }
  const source = sermonRead.sermon.sources.find(candidate =>
    candidate.id === entry.sourceId);
  if (!source || source.sha256 !== entry.sourceRevision) {
    failMainOperation(
      'SERMON_SOURCE_CHANGED',
      'The attached sermon source changed after extraction. Extract it again.'
    );
  }

  const reviewed = applySermonExtractionReview(
    sermonRead.sermon,
    entry.internalProposal,
    {
      outlineSuggestionIds,
      referenceSuggestionIds
    }
  );
  const reviewedSermon = {
    sermon: reviewed.document,
    revision: reviewed.revision
  };

  const withResource = addSermonResource(current.project, reviewedSermon.sermon, {
    provider: 'local-sermon-library',
    itemId: reviewedSermon.sermon.id,
    revision: reviewedSermon.revision
  });
  const repinned = linked.resourceId === withResource.resourceId
    ? withResource.project
    : repinSermonRevision(withResource.project, {
        previousResourceId: linked.resourceId,
        nextResourceId: withResource.resourceId
      });
  const reviewedAt = entry.reviewedAt || new Date().toISOString();
  entry.reviewedAt = reviewedAt;
  const committed = await current.services.sermonProjectCommitCoordinator.commit({
    project: repinned,
    expectedProjectRevisionId: current.expectedRevisionId,
    sermonDocument: reviewedSermon.sermon,
    expectedSermonRevision: sermonRead.revision,
    resourceId: withResource.resourceId,
    resourceOwnerId: linked.resourceOwnerId,
    reason: 'apply-sermon-extraction'
  });
  const savedSermon = committed.sermon;
  const applied = reviewed.changed
    ? reviewed.applied
    : (entry.appliedOutcome || reviewed.applied);
  let savedReview = null;
  let reviewPersistenceWarning = null;
  try {
    const savedReceipt = await current.services.localSermonExtractionStore
      .saveReviewReceipt({
        snapshotHash: entry.snapshotHash,
        projectId: current.projectId,
        resultingSermonRevisionId: savedSermon.revision,
        resultingProjectRevisionId: committed.project.revisionId,
        reviewedAt,
        outlineSuggestionIds,
        referenceSuggestionIds
      });
    savedReview = publicSermonExtractionSavedReview(
      'reused',
      savedReceipt.receipt
    );
  } catch (_error) {
    reviewPersistenceWarning = {
      code: 'SERMON_EXTRACTION_REVIEW_NOT_SAVED',
      message: 'The sermon and service were saved, but the private extraction review record was not. This source may need review again after restarting SyncShow.'
    };
  }
  entry.appliedRevision = savedSermon.revision;
  entry.appliedSelectionSignature = selectionSignature;
  entry.appliedOutcome = applied;
  if (sermonExtractionProposals.get(proposalToken) === entry) {
    sermonExtractionProposals.delete(proposalToken);
  }
  const result = {
    ...projectResult(committed.project),
    sermonId,
    sermonRevisionId: savedSermon.revision,
    applied,
    ...(savedReview ? { savedReview } : {}),
    ...(reviewPersistenceWarning ? { reviewPersistenceWarning } : {})
  };
  if (committed.recovery?.message && !result.recovery) {
    result.recovery = {
      source: 'sermon-project-transaction',
      message: committed.recovery.message
    };
  }
  return result;
  });
});

ipcMain.handle('prepare:projects:proposeSermonReferences', async (event, request = {}) => {
  requireControlSender(event);
  requirePrepareRequest(request, 256 * 1024);
  requireExactPrepareKeys(request, [
    'projectId',
    'revisionId',
    'itemId',
    'sermonId',
    'sermonRevisionId',
    'references'
  ], 'Scripture-reference review');
  const current = await readExpectedProject({
    projectId: request.projectId,
    expectedRevisionId: request.revisionId
  });
  const target = requireSermonReferenceTarget(current.project, request.itemId);
  const sermonId = prepareSermonDomainId(request.sermonId, 'Sermon');
  const sermonRevisionId = prepareRevision(
    request.sermonRevisionId,
    'Sermon revision'
  );
  if (
    target.linked.resource.document.id !== sermonId
    || target.linked.resource.sha256 !== sermonRevisionId
  ) {
    failMainOperation(
      'SERMON_REFERENCE_REVIEW_BINDING_CHANGED',
      'The linked sermon changed before its Scripture references could be reviewed.'
    );
  }
  const sermonRead = await current.services.localSermonLibrary.readCurrent(
    sermonId
  );
  if (sermonRead.revision !== sermonRevisionId) {
    failMainOperation(
      'SERMON_CONFLICT',
      'This sermon changed before its Scripture references could be reviewed.',
      {
        currentRevisionId: sermonRead.revision,
        expectedRevisionId: sermonRevisionId
      }
    );
  }
  if (sermonRead.sermon.publication.status === 'archived') {
    failMainOperation(
      'ARCHIVED_SERMON',
      'Restore this archived sermon before editing its Scripture references.'
    );
  }

  const prepared = await prepareSermonReferenceReviewEntries(
    request.references,
    sermonRead.sermon
  );
  let reviewed;
  let withResource;
  try {
    reviewed = applySermonReferenceReview(
      sermonRead.sermon,
      {
        baseSermonRevisionId: sermonRevisionId,
        entries: prepared.entries
      }
    );
    if (!reviewed.changed) {
      failMainOperation(
        'NO_REFERENCE_CHANGES',
        'No Scripture-reference changes were found.'
      );
    }
    withResource = addSermonResource(current.project, reviewed.document, {
      provider: 'local-sermon-library',
      itemId: reviewed.document.id,
      revision: reviewed.revision
    });
    repinSermonRevision(withResource.project, {
      previousResourceId: target.linked.resourceId,
      nextResourceId: withResource.resourceId
    });
  } catch (error) {
    if (error?.code === 'NO_REFERENCE_CHANGES') throw error;
    failSermonReferenceReview(error);
  }

  const protectedReferenceIds = new Set(
    Object.values(current.project.items)
      .filter(item =>
        item?.kind === 'bible'
        && item.sermonReading?.sermonResourceId === target.linked.resourceId)
      .map(item => item.sermonReading.referenceId)
  );
  return holdSermonReferenceReviewProposal(
    {
      projectId: current.projectId,
      projectRevisionId: current.revisionId,
      itemId: target.itemId,
      resourceId: target.linked.resourceId,
      resourceOwnerId: target.linked.resourceOwnerId,
      sermonId,
      sermonRevisionId,
      nextResourceId: withResource.resourceId,
      entries: prepared.entries
    },
    publicSermonReferenceReviewProposal({
      before: sermonRead.sermon,
      reviewed,
      previewByReferenceId: prepared.previewByReferenceId,
      protectedReferenceIds
    })
  );
});

ipcMain.handle('prepare:projects:applySermonReferences', async (event, request = {}) => {
  requireControlSender(event);
  requirePrepareRequest(request, 16 * 1024);
  requireExactPrepareKeys(
    request,
    ['proposalToken', 'confirmed'],
    'Scripture-reference review confirmation'
  );
  if (request.confirmed !== true) {
    failMainOperation(
      'SERMON_REFERENCE_REVIEW_CONFIRMATION_REQUIRED',
      'Confirm the complete canonical Scripture-reference list before saving it.'
    );
  }
  const { entry } = requireSermonReferenceReviewProposal(
    request.proposalToken
  );
  return withSermonReferenceReviewApplication(entry, async () => {
    const current = await readExpectedProject({
      projectId: entry.projectId,
      expectedRevisionId: entry.projectRevisionId
    });
    const target = requireSermonReferenceTarget(
      current.project,
      entry.itemId
    );
    if (
      target.linked.resourceId !== entry.resourceId
      || target.linked.resourceOwnerId !== entry.resourceOwnerId
      || target.linked.resource.document.id !== entry.sermonId
      || target.linked.resource.sha256 !== entry.sermonRevisionId
    ) {
      failMainOperation(
        'SERMON_REFERENCE_REVIEW_BINDING_CHANGED',
        'The linked service or sermon changed after review. Review the current references again.'
      );
    }
    const sermonRead = await current.services.localSermonLibrary.readCurrent(
      entry.sermonId
    );
    if (sermonRead.revision !== entry.sermonRevisionId) {
      failMainOperation(
        'SERMON_CONFLICT',
        'This sermon changed after Scripture-reference review. Review the current revision again.',
        {
          currentRevisionId: sermonRead.revision,
          expectedRevisionId: entry.sermonRevisionId
        }
      );
    }

    let reviewed;
    let withResource;
    let repinned;
    try {
      reviewed = applySermonReferenceReview(
        sermonRead.sermon,
        {
          baseSermonRevisionId: entry.sermonRevisionId,
          entries: entry.entries
        }
      );
      withResource = addSermonResource(current.project, reviewed.document, {
        provider: 'local-sermon-library',
        itemId: reviewed.document.id,
        revision: reviewed.revision
      });
      if (withResource.resourceId !== entry.nextResourceId) {
        failMainOperation(
          'SERMON_REFERENCE_REVIEW_PROPOSAL_CHANGED',
          'The canonical Scripture-reference result changed after review.'
        );
      }
      repinned = repinSermonRevision(withResource.project, {
        previousResourceId: entry.resourceId,
        nextResourceId: withResource.resourceId
      });
    } catch (error) {
      if (error?.code === 'SERMON_REFERENCE_REVIEW_PROPOSAL_CHANGED') throw error;
      failSermonReferenceReview(error);
    }
    const committed = await current.services.sermonProjectCommitCoordinator
      .commit({
        project: repinned,
        expectedProjectRevisionId: current.expectedRevisionId,
        sermonDocument: reviewed.document,
        expectedSermonRevision: sermonRead.revision,
        resourceId: withResource.resourceId,
        resourceOwnerId: target.linked.resourceOwnerId,
        reason: 'apply-sermon-reference-review'
      });
    const result = {
      ...projectResult(committed.project),
      sermonId: entry.sermonId,
      sermonRevisionId: committed.sermon.revision,
      references: {
        total: reviewed.document.references.length,
        confirmedPrimary: reviewed.document.references.filter(reference =>
          reference.role === 'primary'
          && reference.reviewStatus === 'confirmed').length,
        confirmedMentioned: reviewed.document.references.filter(reference =>
          reference.role === 'mentioned'
          && reference.reviewStatus === 'confirmed').length,
        suggested: reviewed.document.references.filter(reference =>
          reference.reviewStatus === 'suggested').length,
        publicationStatus: reviewed.document.publication.status
      }
    };
    if (committed.recovery?.message && !result.recovery) {
      result.recovery = {
        source: 'sermon-project-transaction',
        message: committed.recovery.message
      };
    }
    return result;
  });
});

ipcMain.handle('prepare:projects:proposeSermonBody', async (event, request = {}) => {
  requireControlSender(event);
  requirePrepareRequest(request, 16 * 1024);
  requireExactPrepareKeys(request, [
    'projectId',
    'revisionId',
    'itemId',
    'sermonId',
    'sermonRevisionId',
    'sourceId'
  ], 'Sermon body review');

  const current = await readExpectedProject({
    projectId: request.projectId,
    expectedRevisionId: request.revisionId
  });
  const { itemId, linked } = requireSermonBodyTarget(
    current.project,
    request.itemId
  );
  const sermonId = prepareSermonDomainId(request.sermonId, 'Sermon');
  const sermonRevisionId = prepareRevision(
    request.sermonRevisionId,
    'Sermon revision'
  );
  const sourceId = prepareSermonDomainId(request.sourceId, 'Sermon source');
  if (
    linked.resource.document.id !== sermonId
    || linked.resource.sha256 !== sermonRevisionId
  ) {
    failMainOperation(
      'SERMON_SOURCE_LINK_CHANGED',
      'This service item is no longer linked to that sermon revision. Reload it before reviewing body text.'
    );
  }

  const sermonRead = await current.services.localSermonLibrary.readCurrent(
    sermonId
  );
  if (sermonRead.revision !== sermonRevisionId) {
    failMainOperation(
      'SERMON_CONFLICT',
      'This sermon changed since it was linked. Reload it before reviewing body text.',
      {
        currentRevisionId: sermonRead.revision,
        expectedRevisionId: sermonRevisionId
      }
    );
  }
  const source = sermonRead.sermon.sources.find(candidate =>
    candidate.id === sourceId);
  if (!source) {
    failMainOperation(
      'UNKNOWN_SERMON_SOURCE',
      'That attached source is no longer part of this sermon revision.'
    );
  }
  if (!['manuscript', 'transcript'].includes(source.kind)) {
    failMainOperation(
      'UNSUPPORTED_SERMON_BODY_SOURCE',
      'Choose a manuscript or transcript source for the reviewed sermon body.'
    );
  }

  const sourceLanguages = sermonBodyReviewSourceLanguages(source);
  const binding = {
    projectId: current.projectId,
    projectRevisionId: current.revisionId,
    itemId,
    resourceId: linked.resourceId,
    resourceOwnerId: linked.resourceOwnerId,
    sermonId,
    sermonRevisionId,
    sourceId,
    sourceRevision: source.sha256,
    sourceKind: source.kind,
    sourceMediaType: source.mediaType,
    sourceLanguages
  };
  try {
    return await sermonExtractionProposalCoordinator.run(
      sermonBodyReviewCoordinatorKey(binding),
      async () => {
        let snapshot;
        try {
          snapshot = await current.services.localSermonExtractionStore
            .readExactSnapshot({
              sermonId,
              baseSermonRevisionId: sermonRevisionId,
              sourceId: source.id,
              sourceSha256: source.sha256,
              sourceKind: source.kind,
              extractorId: SERMON_SOURCE_EXTRACTOR_ID,
              extractorVersion: SERMON_SOURCE_EXTRACTOR_VERSION
            });
          if (!snapshot) {
            const extraction = await sermonSourceExtractionCoordinator.run(
              sermonExtractionCoordinatorKey(source),
              async () => {
                const buffer = await current.services.localSermonSourceStore
                  .readSource(source);
                return extractSermonSourceProposal(buffer, source);
              }
            );
            snapshot = await current.services.localSermonExtractionStore
              .saveSnapshot({
                sermonId,
                baseSermonRevisionId: sermonRevisionId,
                extraction
              });
          }
        } catch (error) {
          failSermonBodyReview(error);
        }

        let internalProposal;
        try {
          internalProposal = buildSermonBodyReviewProposal({
            sermon: sermonRead.sermon,
            baseSermonRevisionId: sermonRevisionId,
            sourceId: source.id,
            snapshotHash: snapshot.snapshotHash,
            extraction: snapshot.extraction
          });
        } catch (error) {
          failSermonBodyReview(error);
        }
        const reviewedEntry = internalProposal.entries.find(candidate =>
          candidate.sourceId === source.id);
        if (!reviewedEntry) {
          failMainOperation(
            'INVALID_SERMON_BODY_REVIEW_PROPOSAL',
            'The complete source could not be prepared as a reviewed body entry.'
          );
        }
        const replacesExisting = sermonRead.sermon.schemaVersion === SERMON_SCHEMA_VERSION
          && sermonRead.sermon.body.some(candidate =>
            candidate.sourceId === source.id);
        let publicProposal;
        try {
          publicProposal = publicSermonBodyReviewProposal({
            sermon: sermonRead.sermon,
            source,
            internalProposal,
            replacesExisting
          });
        } catch (error) {
          failSermonBodyReview(error);
        }
        return holdSermonBodyReviewProposal({
          ...binding,
          snapshotHash: snapshot.snapshotHash,
          bodyEntryId: reviewedEntry.id,
          internalProposal
        }, publicProposal);
      }
    );
  } catch (error) {
    if ([
      'SERMON_BODY_REVIEW_FAILED',
      'SERMON_BODY_REVIEW_PROPOSALS_BUSY',
      'INVALID_SERMON_BODY_REVIEW_PROPOSAL'
    ].includes(error?.code)) {
      throw error;
    }
    failSermonBodyReview(error);
  }
});

ipcMain.handle('prepare:projects:applySermonBody', async (event, request = {}) => {
  requireControlSender(event);
  requirePrepareRequest(
    request,
    (MAX_SERMON_BODY_ENTRY_BYTES * 2) + (64 * 1024)
  );
  requireExactPrepareKeys(request, [
    'proposalToken',
    'projectId',
    'expectedRevisionId',
    'itemId',
    'sermonId',
    'expectedSermonRevisionId',
    'entry',
    'confirmed'
  ], 'Reviewed sermon body');
  if (request.confirmed !== true) {
    failMainOperation(
      'SERMON_BODY_REVIEW_CONFIRMATION_REQUIRED',
      'Confirm the complete reviewed sermon body before saving it.'
    );
  }
  const reviewedEntry = prepareSermonBodyReviewEntry(request.entry);
  const { proposalToken, entry } = requireSermonBodyReviewProposal(
    request.proposalToken
  );
  return withSermonBodyReviewApplication(proposalToken, entry, async () => {
    const current = await readExpectedProject({
      projectId: request.projectId,
      expectedRevisionId: request.expectedRevisionId
    });
    const target = requireSermonBodyTarget(current.project, request.itemId);
    const sermonId = prepareSermonDomainId(request.sermonId, 'Sermon');
    const expectedSermonRevisionId = prepareRevision(
      request.expectedSermonRevisionId,
      'Expected sermon revision'
    );
    if (
      entry.projectId !== current.projectId
      || entry.projectRevisionId !== current.expectedRevisionId
      || entry.itemId !== target.itemId
      || entry.resourceId !== target.linked.resourceId
      || entry.resourceOwnerId !== target.linked.resourceOwnerId
      || entry.sermonId !== sermonId
      || entry.sermonRevisionId !== expectedSermonRevisionId
      || target.linked.resource.document.id !== sermonId
      || target.linked.resource.sha256 !== expectedSermonRevisionId
    ) {
      failMainOperation(
        'SERMON_BODY_REVIEW_BINDING_CHANGED',
        'The service or linked sermon changed after body review. Review the source again.'
      );
    }

    const sermonRead = await current.services.localSermonLibrary.readCurrent(
      sermonId
    );
    if (sermonRead.revision !== expectedSermonRevisionId) {
      failMainOperation(
        'SERMON_CONFLICT',
        'This sermon changed after body review. Review the source again.',
        {
          currentRevisionId: sermonRead.revision,
          expectedRevisionId: expectedSermonRevisionId
        }
      );
    }
    const source = sermonRead.sermon.sources.find(candidate =>
      candidate.id === entry.sourceId);
    if (
      !source
      || source.sha256 !== entry.sourceRevision
      || source.kind !== entry.sourceKind
      || source.mediaType !== entry.sourceMediaType
      || JSON.stringify(sermonBodyReviewSourceLanguages(source))
        !== JSON.stringify(entry.sourceLanguages)
    ) {
      failMainOperation(
        'SERMON_SOURCE_CHANGED',
        'The attached sermon source changed after body review. Review it again.'
      );
    }

    let snapshot;
    let verifiedProposal;
    try {
      snapshot = await current.services.localSermonExtractionStore
        .readExactSnapshot({
          sermonId,
          baseSermonRevisionId: expectedSermonRevisionId,
          sourceId: source.id,
          sourceSha256: source.sha256,
          sourceKind: source.kind,
          extractorId: SERMON_SOURCE_EXTRACTOR_ID,
          extractorVersion: SERMON_SOURCE_EXTRACTOR_VERSION
        });
      if (!snapshot || snapshot.snapshotHash !== entry.snapshotHash) {
        failMainOperation(
          'SERMON_BODY_REVIEW_SNAPSHOT_CHANGED',
          'The saved source extraction changed after body review. Review the source again.'
        );
      }
      verifiedProposal = buildSermonBodyReviewProposal({
        sermon: sermonRead.sermon,
        baseSermonRevisionId: expectedSermonRevisionId,
        sourceId: source.id,
        snapshotHash: snapshot.snapshotHash,
        extraction: snapshot.extraction
      });
    } catch (error) {
      if (error?.code === 'SERMON_BODY_REVIEW_SNAPSHOT_CHANGED') throw error;
      failSermonBodyReview(error);
    }
    if (
      JSON.stringify(verifiedProposal)
        !== JSON.stringify(entry.internalProposal)
      || reviewedEntry.id !== entry.bodyEntryId
    ) {
      failMainOperation(
        'SERMON_BODY_REVIEW_PROPOSAL_CHANGED',
        'The complete sermon body proposal changed after review. Review the source again.'
      );
    }

    const trustedEntry = verifiedProposal.entries.find(candidate =>
      candidate.id === entry.bodyEntryId
      && candidate.sourceId === entry.sourceId);
    if (!trustedEntry) {
      failMainOperation(
        'SERMON_BODY_REVIEW_PROPOSAL_CHANGED',
        'The reviewed sermon body entry no longer matches its source.'
      );
    }
    const editedEntries = verifiedProposal.entries.map(candidate =>
      candidate.id === trustedEntry.id
        ? {
            ...candidate,
            kind: reviewedEntry.kind,
            language: reviewedEntry.language,
            text: reviewedEntry.text
          }
        : candidate);
    let reviewed;
    try {
      reviewed = applySermonBodyReview(
        sermonRead.sermon,
        verifiedProposal,
        { entries: editedEntries }
      );
    } catch (error) {
      failSermonBodyReview(error);
    }
    const appliedEntry = reviewed.document.body.find(candidate =>
      candidate.id === trustedEntry.id);
    if (!appliedEntry) {
      failMainOperation(
        'INVALID_SERMON_BODY_REVIEW_RESULT',
        'The reviewed sermon body did not contain its exact source entry.'
      );
    }

    const withResource = addSermonResource(
      current.project,
      reviewed.document,
      {
        provider: 'local-sermon-library',
        itemId: reviewed.document.id,
        revision: reviewed.revision
      }
    );
    const repinned = target.linked.resourceId === withResource.resourceId
      ? withResource.project
      : repinSermonRevision(withResource.project, {
          previousResourceId: target.linked.resourceId,
          nextResourceId: withResource.resourceId
        });
    const committed = await current.services.sermonProjectCommitCoordinator
      .commit({
        project: repinned,
        expectedProjectRevisionId: current.expectedRevisionId,
        sermonDocument: reviewed.document,
        expectedSermonRevision: sermonRead.revision,
        resourceId: withResource.resourceId,
        resourceOwnerId: target.linked.resourceOwnerId,
        reason: 'apply-sermon-body-review'
      });
    const result = {
      ...projectResult(committed.project),
      sermonId,
      sermonRevisionId: committed.sermon.revision,
      body: {
        entryId: appliedEntry.id,
        sourceId: appliedEntry.sourceId,
        kind: appliedEntry.kind,
        language: appliedEntry.language,
        bodyEntryCount: reviewed.document.body.length,
        publicationStatus: reviewed.document.publication.status,
        visibility: reviewed.document.publication.visibility
      }
    };
    if (committed.recovery?.message && !result.recovery) {
      result.recovery = {
        source: 'sermon-project-transaction',
        message: committed.recovery.message
      };
    }
    return result;
  });
});

ipcMain.handle('prepare:projects:proposeServiceSermonPacket', async (event, request = {}) => {
  requireControlSender(event);
  requirePrepareRequest(request, 16 * 1024);
  requireExactPrepareKeys(request, [
    'projectId',
    'expectedRevisionId',
    'itemId',
    'title',
    'speakerName',
    'defaultLanguage',
    'primaryReference',
    'selectedBook',
    'manuscriptLanguages',
    'readingMode',
    'readingOutputs'
  ], 'Service sermon packet review');

  const current = await readExpectedProject(request);
  const itemId = requireNewSermonPacketTarget(current, request.itemId);
  const metadata = await resolveNewSermonPacketMetadata(request);
  const manuscriptLanguages = prepareLanguageTags(
    request.manuscriptLanguages ?? ['und'],
    'Manuscript languages'
  );
  const readingMode = serviceSermonPacketReadingMode(request.readingMode);
  if (isPowerPointCompanionProject(current.project)
    && readingMode !== 'already-in-service') {
    failMainOperation(
      'CURRENT_SERVICE_READING_ALREADY_PRESENT',
      'This PowerPoint service keeps the congregational reading already present in the loaded presentations.'
    );
  }
  if (readingMode !== 'insert-native'
    && request.readingOutputs !== undefined) {
    failMainOperation(
      'INVALID_BIBLE_OUTPUTS',
      'Bible output treatments are allowed only when inserting a native sermon reading.'
    );
  }
  const readingOutputs = readingMode === 'insert-native'
    && Array.isArray(request.readingOutputs)
    ? prepareBibleOutputSelections(request.readingOutputs, current.project)
    : null;
  const manifest = await currentServiceSetForSermonPacket(current);

  const selected = await dialog.showOpenDialog(controlWindow, {
    title: 'Choose the Pastor Manuscript',
    filters: [{
      name: 'Sermon manuscripts and notes',
      extensions: ['pdf', 'docx', 'txt', 'md', 'markdown']
    }],
    properties: ['openFile']
  });
  if (selected.canceled || selected.filePaths.length === 0) return null;
  if (selected.filePaths.length !== 1) {
    failMainOperation(
      'INVALID_SERMON_SOURCE_SELECTION',
      'Choose one sermon manuscript at a time.'
    );
  }

  let manuscript;
  try {
    manuscript = await current.services.localSermonSourceStore.inspectFile({
      sourcePath: selected.filePaths[0]
    });
  } catch (error) {
    failSermonSourceImport(error);
  }

  const receivedAt = new Date().toISOString();
  let sourcePlan;
  try {
    sourcePlan = buildServiceSermonPacketSourcePlan({
      manifest,
      manuscript,
      manuscriptPath: selected.filePaths[0],
      manuscriptLanguages,
      manuscriptProvidedBy: metadata.speakerName,
      receivedAt,
      createSourceId: () => projectItemId('source')
    });
  } catch (error) {
    failServiceSermonPacket(error);
  }

  const identities = {
    sermonId: projectItemId('sermon'),
    referenceId: projectItemId('reference'),
    readingItemIds: Array.from({ length: 13 }, () => projectItemId('bible'))
  };
  const requestSnapshot = {
    title: metadata.title,
    speakerName: metadata.speakerName,
    defaultLanguage: metadata.defaultLanguage,
    primaryReference: metadata.primaryReference,
    selectedBook: metadata.selectedBook
  };
  const { proposalToken, entry } = holdServiceSermonPacketProposal({
    projectId: current.projectId,
    expectedProjectRevisionId: current.expectedRevisionId,
    itemId,
    requestSnapshot,
    readingMode,
    readingOutputs,
    sourcePlan,
    identities
  });
  return {
    proposalToken,
    expiresAt: new Date(entry.expiresAt).toISOString(),
    serviceSet: { ...sourcePlan.serviceSet },
    sermon: {
      title: metadata.title,
      speakerName: metadata.speakerName,
      defaultLanguage: metadata.defaultLanguage,
      primaryReference: metadata.passage.reference,
      readingMode,
      ...(readingOutputs
        ? { readingOutputs: readingOutputs.map(output => ({ ...output })) }
        : {})
    },
    sources: sourcePlan.publicSources.map(source => ({
      ...source,
      languages: [...source.languages]
    }))
  };
});

ipcMain.handle('prepare:projects:commitServiceSermonPacket', async (event, request = {}) => {
  requireControlSender(event);
  requirePrepareRequest(request, 4 * 1024);
  requireExactPrepareKeys(
    request,
    ['proposalToken', 'confirmed'],
    'Service sermon packet confirmation'
  );
  if (request.confirmed !== true) {
    failMainOperation(
      'SERVICE_SERMON_PACKET_CONFIRMATION_REQUIRED',
      'Confirm the reviewed service files before copying and linking the sermon packet.'
    );
  }
  const { proposalToken, entry } = requireServiceSermonPacketProposal(
    request.proposalToken
  );
  return withServiceSermonPacketApplication(proposalToken, entry, async () => {
    const current = await readExpectedProject({
      projectId: entry.projectId,
      expectedRevisionId: entry.expectedProjectRevisionId
    });
    if (isPowerPointCompanionProject(current.project)
      && entry.readingMode !== 'already-in-service') {
      failMainOperation(
        'CURRENT_SERVICE_READING_ALREADY_PRESENT',
        'This PowerPoint service keeps the congregational reading already present in the loaded presentations.'
      );
    }
    const itemId = requireNewSermonPacketTarget(current, entry.itemId);
    const metadata = await resolveNewSermonPacketMetadata(entry.requestSnapshot);
    const manifest = await currentServiceSetForSermonPacket(current);
    let currentFingerprint;
    try {
      currentFingerprint = serviceSetFingerprint(manifest);
    } catch (error) {
      failServiceSermonPacket(error);
    }
    if (
      currentFingerprint !== entry.sourcePlan.serviceSetFingerprint
      || manifest.id !== entry.sourcePlan.serviceSet.id
    ) {
      failMainOperation(
        'SERVICE_SERMON_PACKET_SET_CHANGED',
        'The current service presentations changed after review. Review the files again.'
      );
    }

    const manuscriptPlan = entry.sourcePlan.importPlans.find(
      plan => plan.key === 'manuscript'
    );
    let inspectedManuscript;
    try {
      inspectedManuscript = await current.services.localSermonSourceStore.inspectFile({
        sourcePath: manuscriptPlan.sourcePath
      });
    } catch (error) {
      failSermonSourceImport(error);
    }
    if (
      inspectedManuscript.fileName !== manuscriptPlan.expected.fileName
      || inspectedManuscript.mediaType !== manuscriptPlan.expected.mediaType
      || inspectedManuscript.sha256 !== manuscriptPlan.expected.sha256
      || inspectedManuscript.sizeBytes !== manuscriptPlan.expected.sizeBytes
    ) {
      failMainOperation(
        'SERVICE_SERMON_PACKET_MANUSCRIPT_CHANGED',
        'The selected manuscript changed after review. Choose and review it again.'
      );
    }

    const importedSources = [];
    for (const plan of entry.sourcePlan.importPlans) {
      let imported;
      try {
        imported = await current.services.localSermonSourceStore.importFile({
          sourcePath: plan.sourcePath,
          ...plan.importOptions
        });
      } catch (error) {
        failSermonSourceImport(error);
      }
      if (!importedSourceMatchesPlan(imported, plan)) {
        failMainOperation(
          'SERVICE_SERMON_PACKET_SOURCE_CHANGED',
          'A reviewed service file changed while it was being copied. Review the files again.'
        );
      }
      importedSources.push(imported.source);
    }

    let boundProject;
    try {
      boundProject = bindProjectToServiceSet(current.project, {
        id: manifest.id,
        fingerprint: currentFingerprint,
        serviceDate: manifest.serviceDate,
        profileId: manifest.profileId
      });
    } catch (error) {
      failMainOperation(
        'SERVICE_SET_PROJECT_MISMATCH',
        error?.code === 'SERVICE_SET_BINDING_CONFLICT'
          ? 'This service project is already bound to a different reviewed presentation set.'
          : 'The reviewed presentations could not be bound to this service project.',
        { cause: typeof error?.code === 'string' ? error.code : 'UNKNOWN' }
      );
    }
    const result = await commitNewSermonPacket({
      current: {
        ...current,
        project: boundProject
      },
      itemId,
      metadata,
      sources: importedSources,
      addPrimaryReading: entry.readingMode === 'insert-native',
      readingOutputs: entry.readingOutputs,
      identities: entry.identities,
      reason: 'create-service-sermon-packet'
    });
    return {
      ...result,
      sourceCount: importedSources.length,
      serviceSetId: entry.sourcePlan.serviceSet.id,
      readingMode: entry.readingMode
    };
  });
});

ipcMain.handle(
  'prepare:projects:proposeLinkedSermonServiceSources',
  async (event, request = {}) => {
    requireControlSender(event);
    requirePrepareRequest(request, 8 * 1024);
    requireExactPrepareKeys(request, [
      'projectId',
      'expectedRevisionId',
      'itemId',
      'manuscriptLanguages'
    ], 'Linked sermon current-service source review');

    const current = await readExpectedProject(request);
    if (isPowerPointCompanionProject(current.project)) {
      failMainOperation(
        'CURRENT_SERVICE_COMPANION_LINK_LOCKED',
        'The PowerPoint companion already preserves its reviewed current-service handoff.'
      );
    }
    const target = await requireLinkedServiceSermonSourceTarget(
      current,
      request.itemId
    );
    const manuscriptLanguages = prepareLanguageTags(
      request.manuscriptLanguages
        ?? [target.sermonRead.sermon.defaultLanguage || 'und'],
      'Manuscript languages'
    );
    const manifest = await currentServiceSetForSermonPacket(current);
    const selected = await dialog.showOpenDialog(controlWindow, {
      title: 'Choose the Pastor Manuscript',
      filters: [{
        name: 'Sermon manuscripts and notes',
        extensions: ['pdf', 'docx', 'txt', 'md', 'markdown']
      }],
      properties: ['openFile']
    });
    if (selected.canceled || selected.filePaths.length === 0) return null;
    if (selected.filePaths.length !== 1) {
      failMainOperation(
        'INVALID_SERMON_SOURCE_SELECTION',
        'Choose one sermon manuscript at a time.'
      );
    }

    let manuscript;
    try {
      manuscript = await current.services.localSermonSourceStore.inspectFile({
        sourcePath: selected.filePaths[0]
      });
    } catch (error) {
      failSermonSourceImport(error);
    }

    let sourcePlan;
    let dispositions;
    try {
      sourcePlan = buildServiceSermonPacketSourcePlan({
        manifest,
        manuscript,
        manuscriptPath: selected.filePaths[0],
        manuscriptLanguages,
        manuscriptProvidedBy: target.sermonRead.sermon.speaker.name,
        receivedAt: new Date().toISOString(),
        createSourceId: () => projectItemId('source')
      });
      dispositions = serviceSermonPacketSourceDispositions(
        target.sermonRead.sermon,
        sourcePlan
      );
    } catch (error) {
      failServiceSermonPacket(error);
    }

    const { proposalToken, entry } =
      holdLinkedServiceSermonSourceProposal({
        projectId: current.projectId,
        expectedProjectRevisionId: current.expectedRevisionId,
        itemId: target.itemId,
        resourceId: target.linked.resourceId,
        resourceOwnerId: target.linked.resourceOwnerId,
        sermonId: target.sermonRead.sermon.id,
        sermonRevisionId: target.sermonRead.revision,
        sourcePlan,
        dispositions
      });
    const sermon = target.sermonRead.sermon;
    return {
      proposalToken,
      expiresAt: new Date(entry.expiresAt).toISOString(),
      serviceSet: { ...sourcePlan.serviceSet },
      sermon: {
        title: sermon.titles[sermon.defaultLanguage]
          || Object.values(sermon.titles)[0],
        speakerName: sermon.speaker.name
      },
      sources: dispositions.map(source => ({
        ...source,
        languages: [...source.languages]
      }))
    };
  }
);

ipcMain.handle(
  'prepare:projects:commitLinkedSermonServiceSources',
  async (event, request = {}) => {
    requireControlSender(event);
    requirePrepareRequest(request, 4 * 1024);
    requireExactPrepareKeys(
      request,
      ['proposalToken', 'confirmed'],
      'Linked sermon current-service source confirmation'
    );
    if (request.confirmed !== true) {
      failMainOperation(
        'LINKED_SERVICE_SERMON_SOURCE_CONFIRMATION_REQUIRED',
        'Confirm the reviewed current-service files before attaching them to the linked sermon.'
      );
    }
    const { proposalToken, entry } =
      requireLinkedServiceSermonSourceProposal(request.proposalToken);
    return withLinkedServiceSermonSourceApplication(
      proposalToken,
      entry,
      async () => {
        const current = await readExpectedProject({
          projectId: entry.projectId,
          expectedRevisionId: entry.expectedProjectRevisionId
        });
        if (isPowerPointCompanionProject(current.project)) {
          failMainOperation(
            'CURRENT_SERVICE_COMPANION_LINK_LOCKED',
            'The PowerPoint companion already preserves its reviewed current-service handoff.'
          );
        }
        const target = await requireLinkedServiceSermonSourceTarget(
          current,
          entry.itemId
        );
        if (
          target.linked.resourceId !== entry.resourceId
          || target.linked.resourceOwnerId !== entry.resourceOwnerId
          || target.sermonRead.sermon.id !== entry.sermonId
          || target.sermonRead.revision !== entry.sermonRevisionId
        ) {
          failMainOperation(
            'LINKED_SERVICE_SERMON_SOURCE_BINDING_CHANGED',
            'The service or linked sermon changed after file review. Review the current service files again.'
          );
        }

        const manifest = await currentServiceSetForSermonPacket(current);
        let currentFingerprint;
        try {
          currentFingerprint = serviceSetFingerprint(manifest);
        } catch (error) {
          failServiceSermonPacket(error);
        }
        if (
          currentFingerprint !== entry.sourcePlan.serviceSetFingerprint
          || manifest.id !== entry.sourcePlan.serviceSet.id
        ) {
          failMainOperation(
            'LINKED_SERVICE_SERMON_SOURCE_SET_CHANGED',
            'The current service presentations changed after review. Review the files again.'
          );
        }

        const manuscriptPlan = entry.sourcePlan.importPlans.find(
          plan => plan.key === 'manuscript'
        );
        let inspectedManuscript;
        try {
          inspectedManuscript =
            await current.services.localSermonSourceStore.inspectFile({
              sourcePath: manuscriptPlan.sourcePath
            });
        } catch (error) {
          failSermonSourceImport(error);
        }
        if (
          inspectedManuscript.fileName !== manuscriptPlan.expected.fileName
          || inspectedManuscript.mediaType
            !== manuscriptPlan.expected.mediaType
          || inspectedManuscript.sha256 !== manuscriptPlan.expected.sha256
          || inspectedManuscript.sizeBytes
            !== manuscriptPlan.expected.sizeBytes
        ) {
          failMainOperation(
            'LINKED_SERVICE_SERMON_SOURCE_MANUSCRIPT_CHANGED',
            'The selected manuscript changed after review. Choose and review it again.'
          );
        }

        let dispositions;
        try {
          dispositions = serviceSermonPacketSourceDispositions(
            target.sermonRead.sermon,
            entry.sourcePlan
          );
        } catch (error) {
          failServiceSermonPacket(error);
        }
        if (JSON.stringify(dispositions) !== JSON.stringify(entry.dispositions)) {
          failMainOperation(
            'LINKED_SERVICE_SERMON_SOURCE_DISPOSITION_CHANGED',
            'The linked sermon sources changed after review. Review the current service files again.'
          );
        }
        const dispositionByKey = new Map(
          dispositions.map(disposition => [disposition.key, disposition])
        );
        const importedSources = [];
        for (const plan of entry.sourcePlan.importPlans) {
          if (dispositionByKey.get(plan.key)?.disposition === 'reuse') {
            continue;
          }
          let imported;
          try {
            imported = await current.services.localSermonSourceStore
              .importFile({
                sourcePath: plan.sourcePath,
                ...plan.importOptions
              });
          } catch (error) {
            failSermonSourceImport(error);
          }
          if (!importedSourceMatchesPlan(imported, plan)) {
            failMainOperation(
              'LINKED_SERVICE_SERMON_SOURCE_CHANGED',
              'A reviewed service file changed while it was being copied. Review the files again.'
            );
          }
          importedSources.push(imported.source);
        }

        let boundProject;
        try {
          boundProject = bindProjectToServiceSet(current.project, {
            id: manifest.id,
            fingerprint: currentFingerprint,
            serviceDate: manifest.serviceDate,
            profileId: manifest.profileId
          });
        } catch (error) {
          failMainOperation(
            'SERVICE_SET_PROJECT_MISMATCH',
            error?.code === 'SERVICE_SET_BINDING_CONFLICT'
              ? 'This service project is already bound to a different reviewed presentation set.'
              : 'The reviewed presentations could not be bound to this service project.',
            { cause: typeof error?.code === 'string' ? error.code : 'UNKNOWN' }
          );
        }

        const reusedSourceCount = dispositions.filter(source =>
          source.disposition === 'reuse').length;
        const resultDetails = {
          sermonId: target.sermonRead.sermon.id,
          sourceCount:
            target.sermonRead.sermon.sources.length + importedSources.length,
          addedSourceCount: importedSources.length,
          reusedSourceCount,
          serviceSetId: entry.sourcePlan.serviceSet.id
        };
        if (importedSources.length === 0) {
          if (current.project.sourceServiceSet) {
            return {
              ...projectResult({
                ...current,
                unchanged: true
              }),
              sermonRevisionId: target.sermonRead.revision,
              ...resultDetails
            };
          }
          const saved = await current.services.serviceProjectStore.save(
            boundProject,
            {
              expectedRevisionId: current.expectedRevisionId,
              reason: 'bind-linked-sermon-service-sources'
            }
          );
          return {
            ...projectResult(saved),
            sermonRevisionId: target.sermonRead.revision,
            ...resultDetails
          };
        }

        const writableSermon = upgradeSermonDocument(
          target.sermonRead.sermon
        );
        const nextSermonDocument = {
          ...writableSermon,
          sources: [
            ...writableSermon.sources,
            ...importedSources
          ]
        };
        const nextSermonRevisionId =
          sermonDocumentSha256(nextSermonDocument);
        const withResource = addSermonResource(
          boundProject,
          nextSermonDocument,
          {
            provider: 'local-sermon-library',
            itemId: nextSermonDocument.id,
            revision: nextSermonRevisionId
          }
        );
        const repinned = target.linked.resourceId === withResource.resourceId
          ? withResource.project
          : repinSermonRevision(withResource.project, {
              previousResourceId: target.linked.resourceId,
              nextResourceId: withResource.resourceId
            });
        const committed =
          await current.services.sermonProjectCommitCoordinator.commit({
            project: repinned,
            expectedProjectRevisionId: current.expectedRevisionId,
            sermonDocument: nextSermonDocument,
            expectedSermonRevision: target.sermonRead.revision,
            resourceId: withResource.resourceId,
            resourceOwnerId: target.linked.resourceOwnerId,
            reason: 'attach-linked-sermon-service-sources'
          });
        const result = {
          ...projectResult(committed.project),
          sermonRevisionId: committed.sermon.revision,
          ...resultDetails
        };
        if (committed.recovery?.message && !result.recovery) {
          result.recovery = {
            source: 'sermon-project-transaction',
            message: committed.recovery.message
          };
        }
        return result;
      }
    );
  }
);

ipcMain.handle('prepare:projects:createSermonPacket', async (event, request = {}) => {
  requireControlSender(event);
  requirePrepareRequest(request, 16 * 1024);
  requireExactPrepareKeys(request, [
    'projectId',
    'expectedRevisionId',
    'itemId',
    'title',
    'speakerName',
    'defaultLanguage',
    'primaryReference',
    'selectedBook',
    'addPrimaryReading',
    'readingOutputs'
  ], 'Sermon packet');
  const current = await readExpectedProject(request);
  const itemId = requireNewSermonPacketTarget(current, request.itemId);
  if (isPowerPointCompanionProject(current.project)) {
    failMainOperation(
      'CURRENT_SERVICE_REVIEW_REQUIRED',
      'Review the exact current presentations and pastor manuscript before creating this PowerPoint service sermon record.'
    );
  }
  const metadata = await resolveNewSermonPacketMetadata(request);
  const addPrimaryReading = request.addPrimaryReading === true;
  if (!addPrimaryReading && request.readingOutputs !== undefined) {
    failMainOperation(
      'INVALID_BIBLE_OUTPUTS',
      'Bible output treatments are allowed only when adding the primary sermon reading.'
    );
  }
  const readingOutputs = addPrimaryReading
    ? prepareBibleOutputSelections(
        Array.isArray(request.readingOutputs)
          ? request.readingOutputs
          : current.project.channelIds.map(channelId => ({
              channelId,
              mode: 'translation',
              translationId: 'BSB'
            })),
        current.project
      )
    : null;
  return commitNewSermonPacket({
    current,
    itemId,
    metadata,
    addPrimaryReading,
    readingOutputs,
    reason: 'create-sermon-packet'
  });
});

ipcMain.handle('prepare:projects:addSermonReading', async (event, request = {}) => {
  requireControlSender(event);
  requirePrepareRequest(request, 32 * 1024);
  requireExactPrepareKeys(request, [
    'projectId',
    'expectedRevisionId',
    'itemId',
    'referenceId',
    'outputs'
  ], 'Sermon reading');
  const current = await readExpectedProject(request);
  if (isPowerPointCompanionProject(current.project)) {
    failMainOperation(
      'CURRENT_SERVICE_READING_ALREADY_PRESENT',
      'This PowerPoint service keeps the congregational reading already present in the loaded presentations.'
    );
  }
  const itemId = prepareId(request.itemId, 'Service item');
  const referenceId = prepareSermonDomainId(
    request.referenceId,
    'Sermon primary reference'
  );
  const outputs = prepareBibleOutputSelections(
    request.outputs,
    current.project
  );

  let reading;
  try {
    reading = analyzeSermonPrimaryReading(current.project, {
      itemId,
      referenceId,
      outputs,
      maxVerses: bibleLibrary.maxVerses
    });
  } catch (error) {
    failMainOperation(
      error.code || 'SERMON_READING_INVALID',
      error.message || 'The linked sermon reading could not be prepared.',
      error.details || {}
    );
  }

  if (reading.status === 'ready') {
    return {
      ...projectResult(current),
      unchanged: true,
      reading: {
        status: 'ready',
        referenceId: reading.referenceId,
        reference: reading.reference,
        outputs,
        cueCount: reading.chunks.length
      }
    };
  }
  if (reading.reviewItemIds.length > 0) {
    failMainOperation(
      'SERMON_READING_REVIEW_REQUIRED',
      'Another generated reading for this sermon is already in the rundown, or an existing generated cue no longer matches its reviewed passage. Review or remove those cues before rebuilding it.',
      { itemIds: reading.reviewItemIds }
    );
  }

  let next = current.project;
  const orderedItemIds = [];
  for (const chunk of reading.chunks) {
    if (chunk.itemId) {
      orderedItemIds.push(chunk.itemId);
      continue;
    }
    const resolved = await resolvePreparedBibleOutputs({
      reference: chunk.reference,
      outputs
    });
    const itemIdForChunk = projectItemId('bible');
    next = addBibleItem(next, {
      id: itemIdForChunk,
      title: `${resolved.firstPassage.reference} (${resolved.translationAbbreviations.join(' / ')})`,
      range: chunk.range,
      passagesByChannel: resolved.passagesByChannel,
      presetId: 'scripture-text',
      operatorNotes: `Primary sermon reading · ${reading.reference}`,
      sermonReading: {
        sermonResourceId: reading.sermonResourceId,
        referenceId: reading.referenceId,
        outputs: outputs.map(output => ({ ...output })),
        chunkIndex: chunk.chunkIndex,
        chunkCount: reading.chunks.length
      },
      parentId: reading.parentId
    });
    orderedItemIds.push(itemIdForChunk);
  }
  next = placeBibleReadingItemsBefore(next, {
    itemIds: orderedItemIds,
    anchorItemId: reading.anchorItemId
  });
  const saved = await current.services.serviceProjectStore.save(next, {
    expectedRevisionId: current.expectedRevisionId,
    reason: 'add-sermon-reading'
  });
  return {
    ...projectResult(saved),
    reading: {
      status: 'ready',
      referenceId: reading.referenceId,
      reference: reading.reference,
      outputs,
      cueCount: reading.chunks.length
    }
  };
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
      const projectedText = prepareProjectedBodyText(
        entry.text,
        'Projected text',
        20000
      );
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
  if (request.plannedDurationSeconds !== undefined) {
    const withoutPlanningTiming = value => {
      const comparable = JSON.parse(JSON.stringify(value));
      delete comparable.updatedAt;
      delete comparable.plannedDurationSeconds;
      return comparable;
    };
    if (
      JSON.stringify(withoutPlanningTiming(next.items[itemId]))
        === JSON.stringify(withoutPlanningTiming(item))
    ) {
      next = current.project;
    }
    next = updateProjectItemTiming(next, {
      itemId,
      plannedDurationSeconds: request.plannedDurationSeconds
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
  await recoverLocalSongFamilyCommit();
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

ipcMain.handle('prepare:projects:setSongOutputTreatment', async (event, request = {}) => {
  requireControlSender(event);
  requirePrepareRequest(request, 16 * 1024);
  requireExactPrepareKeys(request, [
    'projectId',
    'expectedRevisionId',
    'itemId',
    'channelId',
    'mode',
    'sourceChannelId'
  ], 'Song output treatment');
  const current = await readExpectedProject(request);
  const itemId = prepareId(request.itemId, 'Song item');
  const channelId = prepareId(request.channelId, 'Song output');
  projectSongItem(current.project, itemId);
  const mode = prepareText(
    request.mode,
    'Song output treatment',
    32,
    { required: true }
  );
  if (!['inherit', 'derive-next-text', 'hidden'].includes(mode)) {
    failMainOperation(
      'INVALID_SONG_TREATMENT',
      'Choose inherit, current plus next text, or hidden for this song output.'
    );
  }
  let sourceChannelId;
  if (mode === 'hidden') {
    if (request.sourceChannelId !== undefined
      && request.sourceChannelId !== null
      && request.sourceChannelId !== '') {
      failMainOperation(
        'INVALID_SONG_TREATMENT',
        'A hidden song output cannot identify a source output.'
      );
    }
  } else {
    sourceChannelId = prepareId(
      request.sourceChannelId,
      'Song treatment source output'
    );
  }
  const next = setSongChannelTreatment(current.project, {
    itemId,
    channelId,
    mode,
    ...(sourceChannelId ? { sourceChannelId } : {})
  });
  return projectResult(await current.services.serviceProjectStore.save(next, {
    expectedRevisionId: current.expectedRevisionId,
    reason: 'song-output-treatment'
  }));
});

ipcMain.handle('prepare:projects:resetSongTranslation', async (event, request = {}) => {
  requireControlSender(event);
  requirePrepareRequest(request, 16 * 1024);
  requireExactPrepareKeys(request, [
    'projectId',
    'expectedRevisionId',
    'itemId',
    'channelId'
  ], 'Song translation reset');
  const current = await readExpectedProject(request);
  const itemId = prepareId(request.itemId, 'Song item');
  const channelId = prepareId(request.channelId, 'Output language');
  const channel = current.project.channels[channelId];
  if (!channel) {
    failMainOperation('UNKNOWN_PROJECT_CHANNEL', 'That output language is not part of this service.');
  }
  const sourceChannelId = resolveAuthoritativeSongSource(
    current.project,
    projectSongItem(current.project, itemId)
  ).channelId;
  const next = setSongChannelTreatment(current.project, {
    itemId,
    channelId,
    mode: 'inherit',
    sourceChannelId
  });
  return projectResult(await current.services.serviceProjectStore.save(next, {
    expectedRevisionId: current.expectedRevisionId,
    reason: 'reset-song-translation'
  }));
});

function prepareBibleOutputSelections(rawOutputs, project) {
  if (!Array.isArray(rawOutputs)
    || rawOutputs.length !== project.channelIds.length) {
    failMainOperation(
      'INVALID_BIBLE_OUTPUTS',
      'Include exactly one Bible treatment for every configured output.'
    );
  }
  const byChannelId = new Map();
  for (const [index, raw] of rawOutputs.entries()) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      failMainOperation(
        'INVALID_BIBLE_OUTPUT',
        `Bible output ${index + 1} is invalid.`
      );
    }
    const mode = prepareText(
      raw.mode,
      `Bible output ${index + 1} mode`,
      16,
      { required: true }
    );
    const allowedKeys = mode === 'translation'
      ? ['channelId', 'mode', 'translationId']
      : ['channelId', 'mode'];
    requireExactPrepareKeys(raw, allowedKeys, `Bible output ${index + 1}`);
    if (!['translation', 'hidden'].includes(mode)) {
      failMainOperation(
        'INVALID_BIBLE_OUTPUT_MODE',
        'A Bible output must use a translation or stay hidden.'
      );
    }
    const channelId = prepareId(
      raw.channelId,
      `Bible output ${index + 1}`
    );
    if (!project.channels[channelId]) {
      failMainOperation(
        'UNKNOWN_PROJECT_CHANNEL',
        'That Bible output is not part of this service.',
        { channelId }
      );
    }
    if (byChannelId.has(channelId)) {
      failMainOperation(
        'DUPLICATE_BIBLE_OUTPUT',
        'Each configured Bible output must appear exactly once.',
        { channelId }
      );
    }
    if (mode === 'hidden') {
      byChannelId.set(channelId, { channelId, mode });
      continue;
    }
    const translationId = prepareText(
      raw.translationId,
      `${project.channels[channelId].label || channelId} Bible translation`,
      12,
      { required: true }
    ).toUpperCase();
    if (!['BSB', 'LSV'].includes(translationId)) {
      failMainOperation(
        'UNSUPPORTED_BIBLE_TRANSLATION',
        'Choose a Bible translation available on this computer.',
        { channelId, translationId }
      );
    }
    byChannelId.set(channelId, {
      channelId,
      mode,
      translationId
    });
  }
  const missingChannelIds = project.channelIds.filter(channelId =>
    !byChannelId.has(channelId));
  if (missingChannelIds.length > 0) {
    failMainOperation(
      'MISSING_BIBLE_OUTPUT',
      'Include exactly one Bible treatment for every configured output.',
      { channelIds: missingChannelIds }
    );
  }
  const ordered = project.channelIds.map(channelId => byChannelId.get(channelId));
  if (!ordered.some(output => output.mode === 'translation')) {
    failMainOperation(
      'BIBLE_OUTPUTS_ALL_HIDDEN',
      'Show the Bible passage on at least one output.'
    );
  }
  return ordered;
}

function requirePreparedBibleLookup(lookup) {
  if (lookup?.status === 'ok' && lookup.passage) return lookup.passage;
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

function preparedBibleCanonicalRange(passage) {
  return {
    book: passage.book,
    startChapter: passage.chapter,
    startVerse: passage.verseStart,
    endChapter: passage.chapter,
    endVerse: passage.verseEnd
  };
}

function preparedBiblePassageMatchesRange(passage, range) {
  const start = passage.start || {
    chapter: passage.chapter,
    verse: passage.verseStart
  };
  const end = passage.end || {
    chapter: passage.chapter,
    verse: passage.verseEnd
  };
  return passage.book === range.book
    && start.chapter === range.startChapter
    && start.verse === range.startVerse
    && end.chapter === range.endChapter
    && end.verse === range.endVerse;
}

function preparedBibleProjectPassage(passage, range) {
  const bookId = resolveBookId(range.book);
  if (!bookId) {
    failMainOperation(
      'BIBLE_REFERENCE_INVALID',
      'That Bible passage does not use a canonical Bible book.'
    );
  }
  return {
    ...passage,
    bookId,
    book: range.book,
    chapter: range.startChapter,
    verseStart: range.startVerse,
    verseEnd: range.endVerse
  };
}

async function resolvePreparedBibleOutputs({
  reference,
  selectedBookId,
  outputs
}) {
  const visibleOutputs = outputs.filter(output => output.mode === 'translation');
  const firstTranslationId = visibleOutputs[0].translationId;
  const firstPassage = requirePreparedBibleLookup(
    await resolveBibleLookupRequest({
      query: reference,
      translationId: firstTranslationId,
      ...(selectedBookId ? { selectedBook: selectedBookId } : {})
    })
  );
  const canonicalRange = preparedBibleCanonicalRange(firstPassage);
  const passagesByTranslation = new Map([[
    firstTranslationId,
    preparedBibleProjectPassage(firstPassage, canonicalRange)
  ]]);
  const remainingTranslationIds = [...new Set(
    visibleOutputs
      .map(output => output.translationId)
      .filter(translationId => translationId !== firstTranslationId)
  )];
  const resolvedTranslations = await Promise.all(
    remainingTranslationIds.map(async translationId => {
      const passage = requirePreparedBibleLookup(
        await bibleLibrary.lookupCanonicalRange(canonicalRange, { translationId })
      );
      if (!preparedBiblePassageMatchesRange(passage, canonicalRange)) {
        failMainOperation(
          'BIBLE_RANGE_MISMATCH',
          'The selected Bible translations did not resolve to the same passage.',
          { translationId }
        );
      }
      return [
        translationId,
        preparedBibleProjectPassage(passage, canonicalRange)
      ];
    })
  );
  for (const [translationId, passage] of resolvedTranslations) {
    passagesByTranslation.set(translationId, passage);
  }
  return {
    canonicalRange,
    passagesByChannel: Object.fromEntries(
      visibleOutputs.map(output => [
        output.channelId,
        passagesByTranslation.get(output.translationId)
      ])
    ),
    translationAbbreviations: [...new Set(
      visibleOutputs.map(output =>
        passagesByTranslation.get(output.translationId).translation.abbr)
    )],
    firstPassage: passagesByTranslation.get(firstTranslationId)
  };
}

ipcMain.handle('prepare:projects:addBible', async (event, request = {}) => {
  requireControlSender(event);
  requirePrepareRequest(request, 32 * 1024);
  requireExactPrepareKeys(request, [
    'projectId',
    'expectedRevisionId',
    'reference',
    'selectedBookId',
    'parentId',
    'outputs'
  ], 'Bible passage');
  const current = await readExpectedProject(request);
  const reference = prepareText(request.reference, 'Bible reference', 160, { required: true });
  const selectedBookId = request.selectedBookId
    ? prepareText(request.selectedBookId, 'Bible book selection', 80, { required: true })
    : null;
  const parentId = request.parentId
    ? prepareId(request.parentId, 'Parent item')
    : null;
  const outputs = prepareBibleOutputSelections(
    request.outputs,
    current.project
  );
  const resolved = await resolvePreparedBibleOutputs({
    reference,
    selectedBookId,
    outputs
  });
  const next = addBibleItem(current.project, {
    id: projectItemId('bible'),
    title: `${resolved.firstPassage.reference} (${resolved.translationAbbreviations.join(' / ')})`,
    passagesByChannel: resolved.passagesByChannel,
    presetId: 'scripture-text',
    operatorNotes: '',
    parentId
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
          prepareProjectedBodyText(
            request.text,
            'Projected text',
            20000,
            { required: true }
          )
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

ipcMain.handle('prepare:projects:addVideo', async (event, request = {}) => {
  requireControlSender(event);
  requirePrepareRequest(request, 32 * 1024);
  const current = await readExpectedProject(request);
  const title = prepareText(request.title || 'Video', 'Video title', 200, { required: true });
  const fit = request.fit === 'fill' || request.fit === 'stretch' ? request.fit : 'fit';
  const parentId = request.parentId ? prepareId(request.parentId, 'Parent item') : null;
  const result = await dialog.showOpenDialog(controlWindow, {
    title: 'Add Video to Service',
    filters: [{ name: 'Videos', extensions: ['mp4', 'webm'] }],
    properties: ['openFile']
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  const added = await current.services.serviceProjectStore.importVideoAndUpdateProject(
    current.projectId,
    {
      sourcePath: result.filePaths[0],
      expectedRevisionId: current.expectedRevisionId,
      reason: 'add-video'
    },
    (project, asset) => addProjectItem(project, {
      id: projectItemId('video'),
      kind: 'video',
      title,
      assetId: asset.id,
      channelIds: [...project.channelIds],
      audioChannelId: project.channelIds[0],
      fit,
      presetId: 'video-fullscreen',
      operatorNotes: ''
    }, { parentId })
  );
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
  if (isPowerPointCompanionProject(selected.project)) {
    failMainOperation(
      'CURRENT_SERVICE_COMPANION_NOT_PUBLISHABLE',
      'This is a sermon record for the loaded PowerPoints. Return to Load to show the original presentations.'
    );
  }
  const readiness = analyzeServiceProjectReadiness(selected.project, {
    waivers: selected.project.planning?.readinessWaivers || []
  });
  if (selected.project.planning?.status !== undefined) {
    if (selected.project.planning.status !== 'ready') {
      failMainOperation(
        'SERVICE_PLAN_NOT_READY',
        'Mark this reviewed service plan Ready before preparing its Show Package.'
      );
    }
    if (!readiness.ready) {
      failMainOperation(
        'SERVICE_READINESS_BLOCKED',
        'This service changed after readiness review. Resolve its blockers before preparing Load.',
        { blockers: readiness.blockers }
      );
    }
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
  const activationReceipt = await activateCurrentPreparedService(
    services,
    published
  );
  if (publishGeneration !== preparePublishGeneration
    || presentationRevision !== presentationRevisionAtStart
    || outputSessionId !== outputSessionIdAtStart
    || activeVenueProfile !== venueProfileAtStart
    || isConverting
    || conversionQueue.length > 0
    || appState.activeLaunchPlan) {
    const rolledBack = await rollbackCurrentPreparedServiceActivation(
      services,
      activationReceipt
    ).catch(error => {
      console.warn(
        '[PreparedService] Could not roll back a stale activation:',
        error?.code || error?.name || 'clear-failed'
      );
      currentPreparedServicePointer = null;
      if (!appState.activeLaunchPlan) clearInstalledPreparedPresentations();
      setCurrentPreparedServiceRestore('corrupt', activationReceipt.pointer);
      failMainOperation(
        'PREPARE_PUBLISH_ROLLBACK_FAILED',
        'Load changed while the service was being activated, and SyncShow could not confirm the previous restart selection. Do not close the app; review Load and prepare the intended service again.'
      );
    });
    if (!rolledBack) {
      console.log(
        '[PreparedService] A newer activation superseded the stale publish; it was left unchanged.'
      );
    }
    failMainOperation(
      'PREPARE_PUBLISH_STALE',
      'The service package was prepared safely, but Load or Show changed before activation finished. Return to Prepare and choose Save & go to Load again.'
    );
  }
  const currentPointer = activationReceipt.pointer;
  const binding = currentPreparedServiceBinding(currentPointer, published);
  installPreparedPresentations(published.presentations, binding.roleIds);
  currentPreparedServicePointer = currentPointer;
  setCurrentPreparedServiceRestore('restored', currentPointer);
  return {
    success: true,
    showPackage: {
      id: published.manifest.id,
      projectId,
      revisionId,
      cueCount: published.manifest.cueCount,
      roles: Object.keys(published.presentations)
    },
    readiness
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
  requireNoActiveShowForPresentationMutation();
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

    const result = {
      success: true,
      cacheDir: outputDir,
      slideCount,
      metadata
    };

    // Loading a PowerPoint is an explicit service boundary. Clear only the
    // durable current-package pointer; immutable packages remain available
    // for an intentional future Prepare activation.
    const releasePresentationMutation = beginPresentationMutation();
    try {
      await deactivateCurrentPreparedService({ clearPresentations: true });
      installPresentation(language, result);
    } finally {
      releasePresentationMutation();
    }
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

  try {
    return await new Promise((resolve, reject) => {
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
  } catch (error) {
    return serializeConversionFailure(error);
  }
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
  const serviceHandoff = normalizedPresentationHandoff(presentation);

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

    const semantics = rendererSlideSemantics(presentation, index, serviceHandoff);
    return {
      index: index,
      imagePath: imagePath,
      thumbnailPath: thumbPath,
      thumbnailBase64: thumbnailBase64,  // New: base64 for thumbnails
      text: rendererSafeText(
        presentation.metadata?.slides?.[index]?.text || '',
        12000,
        { multiline: true }
      ),
      ...semantics
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
  if (displayStartInProgress) {
    failMainOperation(
      'LOAD_BUSY',
      'Wait for the Show that is already starting.'
    );
  }
  displayStartInProgress = true;

  try {
  // Fail quickly for an ordinary locked replacement, then authorize the exact
  // still-current session again at the irreversible replacement boundary
  // after every asynchronous preflight has completed.
  if (appState.activeLaunchPlan) authorizeLocalShowCommand('session.end');
  if (isConverting || conversionQueue.length > 0 || presentationMutationInProgress) {
    failMainOperation(
      'LOAD_BUSY',
      'Wait for the presentation currently being loaded before starting the Show.'
    );
  }
  const presentationRevisionForStart = presentationRevision;
  const venueProfileForStart = activeVenueProfile;
  const renderingSettings = normalizeStartRenderingSettings(settings);

  // A prepared native service is re-opened and rebound at the last safe
  // boundary before any output window is touched. This catches package/font
  // tampering and committed venue-role drift after Load was first populated.
  const preparedService = await verifyCurrentPreparedServiceForStart();

  // Resolve and freeze all per-service decisions before touching the active
  // output session. A malformed or incomplete Start therefore leaves the
  // currently running show intact.
  const launchPlan = resolveLaunchPlan({
    presentations: appState.presentations,
    outputs,
    decisions,
    preferredTimelineRoleId
  });
  const powerPointServiceCandidate =
    await capturePowerPointServiceSetCandidate(launchPlan);
  updateDisplayList();
  const requestedShowControlMode =
    activeVenueProfile?.operator?.showControlMode === 'volunteer'
      ? 'volunteer'
      : 'full';
  const rehearsalEvidence = requestedShowControlMode === 'volunteer'
      ? await showRehearsalEvidenceForStart({
        preparedService,
        launchPlan,
        decisions,
        renderingSettings
      })
    : null;
  const savedRehearsalReceipt = requestedShowControlMode === 'volunteer'
    ? await matchingSavedRehearsalReceipt(rehearsalEvidence)
    : null;

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

  if (
    presentationRevision !== presentationRevisionForStart
    || activeVenueProfile !== venueProfileForStart
    || isConverting
    || conversionQueue.length > 0
    || presentationMutationInProgress
  ) {
    failMainOperation(
      'SHOW_START_STALE',
      'Load or the venue setup changed while Start was being checked. Review the current service and start again.'
    );
  }
  if (appState.activeLaunchPlan) authorizeLocalShowCommand('session.end');

  // A private sermon review must never keep playing underneath the audience
  // outputs. Stop it at the same last-safe boundary used for the exact Show.
  await closeSermonRecordingPlayer();

  // Reconcile every Start from a clean output session. This destroys windows
  // hidden by Back/Stop as well as any partially-created windows from a rapid
  // repeated Start, so no unreferenced fullscreen windows survive.
  destroyOutputWindows();
  const sessionId = outputSessionId;
  activeShowControlMode = requestedShowControlMode;
  setActiveShowRehearsalState(
    activeShowControlMode !== 'volunteer'
      ? {
          status: 'not-required',
          currentCue: 0,
          totalCues: launchPlan.totalSlides,
          persisted: false,
          reused: false
        }
      : savedRehearsalReceipt
        ? {
            status: 'ready',
            currentCue: launchPlan.totalSlides,
            totalCues: launchPlan.totalSlides,
            persisted: true,
            reused: true
          }
        : {
            status: 'rehearsing',
            currentCue: 0,
            totalCues: launchPlan.totalSlides,
            persisted: false,
            reused: false
          }
  );
  outputsShouldBeVisible = true;
  outputLifecyclePhase = 'starting';
  appState.isCleared = false;
  const readyPromises = [];

  // Apply the exact normalized settings already included in receipt evidence.
  appState.fadeDuration = renderingSettings.fadeDuration;
  appState.syncMode = renderingSettings.syncMode;
  appState.singerFontSize = renderingSettings.singerFontSize;
  appState.singerCharLimit = renderingSettings.singerCharLimit;
  appState.singerTextPadding = renderingSettings.singerTextPadding;

  appState.activeLaunchPlan = launchPlan;
  appState.currentSlide = 0;
  appState.totalSlides = launchPlan.totalSlides;
  const startingShowState = showGateway.beginSession();
  activeVolunteerShowBinding = createActiveVolunteerShowBinding(
    launchPlan,
    startingShowState.outputSessionId
  );

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

  requireCurrentOutputStartup(
    sessionId,
    launchPlan,
    renderingSettings,
    'Output startup was cancelled before the windows became ready.'
  );

  let rehearsalAcknowledgements = null;
  if (
    activeShowControlMode === 'volunteer'
    && !savedRehearsalReceipt
  ) {
    try {
      rehearsalAcknowledgements = await rehearseHiddenShowCues({
        sessionId,
        launchPlan,
        evidence: rehearsalEvidence,
        renderingSettings
      });
    } catch (error) {
      if (sessionId === outputSessionId) destroyOutputWindows();
      throw error;
    }
  }

  const initialFramePromises = [...outputWindows.values()].map(({ win, output }) =>
    waitForInitialOutputFrame(win, output, sessionId, 0)
  );

  console.log('[Display] Output windows ready; preparing initial goToSlide(0) while hidden');
  goToSlide(0, {
    publish: false,
    notifyControl: false,
    capturePreviews: false
  });

  try {
    await Promise.all(initialFramePromises);
  } catch (error) {
    if (sessionId === outputSessionId) destroyOutputWindows();
    throw error;
  }

  requireCurrentOutputStartup(
    sessionId,
    launchPlan,
    renderingSettings,
    'Output startup was cancelled before the first frame became ready.'
  );

  let confirmedRehearsalEvidence = rehearsalEvidence;
  if (activeShowControlMode === 'volunteer') {
    try {
      let confirmedPreparedService = preparedService;
      if (preparedService) {
        confirmedPreparedService =
          await verifyCurrentPreparedServiceForStart();
        requireCurrentOutputStartup(
          sessionId,
          launchPlan,
          renderingSettings,
          'The Show changed while its prepared package was being reverified.'
        );
        if (!samePreparedServiceVerification(
          preparedService,
          confirmedPreparedService
        )) {
          destroyOutputWindows();
          failMainOperation(
            'PREPARED_SERVICE_CHANGED',
            'The prepared Show package changed during rehearsal. Reopen it in Prepare and choose Save & go to Load again.'
          );
        }
      }
      confirmedRehearsalEvidence = await showRehearsalEvidenceForStart({
        preparedService: confirmedPreparedService,
        launchPlan,
        decisions,
        renderingSettings
      });
    } catch (error) {
      if (
        sessionId === outputSessionId
        && appState.activeLaunchPlan === launchPlan
      ) {
        destroyOutputWindows();
      }
      throw error;
    }
    requireCurrentOutputStartup(
      sessionId,
      launchPlan,
      renderingSettings,
      'The Show changed while its exact rehearsal evidence was being confirmed.'
    );
    if (!sameShowRehearsalEvidence(
      rehearsalEvidence,
      confirmedRehearsalEvidence
    )) {
      destroyOutputWindows();
      failMainOperation(
        'SHOW_REHEARSAL_EVIDENCE_CHANGED',
        'The Show content, venue routing, or rendering settings changed during rehearsal. Review Load and start again.'
      );
    }
  }

  if (
    activeShowControlMode === 'volunteer'
    && !savedRehearsalReceipt
  ) {
    let persisted = false;
    if (confirmedRehearsalEvidence) {
      const receipt = {
        schemaVersion: SHOW_REHEARSAL_RECEIPT_SCHEMA_VERSION,
        kind: SHOW_REHEARSAL_RECEIPT_KIND,
        ...confirmedRehearsalEvidence,
        acknowledgements: rehearsalAcknowledgements
      };
      try {
        await getShowRehearsalReceiptStore().write(receipt);
        requireCurrentOutputStartup(
          sessionId,
          launchPlan,
          renderingSettings,
          'The Show changed while its rehearsal receipt was being saved.'
        );
        persisted = true;
      } catch (error) {
        if (sessionId === outputSessionId) destroyOutputWindows();
        throw error;
      }
    }
    setActiveShowRehearsalState({
      status: 'ready',
      currentCue: launchPlan.totalSlides,
      totalCues: launchPlan.totalSlides,
      persisted,
      reused: false
    });
  }

  requireCurrentOutputStartup(
    sessionId,
    launchPlan,
    renderingSettings,
    'Output startup was replaced before the rehearsed Show could be revealed.'
  );

  // Reveal only after every output has loaded its first frame. A slow or
  // failed output can no longer expose a partial set of fullscreen windows.
  outputWindows.forEach(({ win }) => showOutputWindow(win));
  outputLifecyclePhase = 'live';
  const showState = publishShowState('show-started');
  sealActivePowerPointShowReceipt(powerPointServiceCandidate, sessionId);

  return {
    success: true,
    totalSlides: appState.totalSlides,
    plan: launchPlan,
    outputSessionId: showState?.outputSessionId || null,
    showState
  };
  } finally {
    displayStartInProgress = false;
  }
});

ipcMain.handle('display:stop', async (event) => {
  requireControlSender(event);
  authorizeLocalShowCommand('output.stop');
  const result = hideDisplayWindows();
  // unregisterGlobalShortcuts(); // deprecated
  return { success: result.accepted !== false, showState: showGateway.getState() };
});

// Show displays - re-show windows and current slide
ipcMain.handle('display:show', async (event) => {
  requireControlSender(event);
  authorizeLocalShowCommand('output.restore');
  const result = await restoreOutputsForRemote();
  if (result.accepted === false) failMainOperation(result.code, result.message);
  // registerGlobalShortcuts(); // deprecated
  return { success: true, showState: showGateway.getState() };
});

// Clear displays - show black screens but keep windows open
ipcMain.handle('display:clear', async (event) => {
  requireControlSender(event);
  authorizeLocalShowCommand('output.clear');
  const result = clearAllDisplays();
  if (result.accepted === false) failMainOperation(result.code, result.message);
  return { success: true, showState: showGateway.getState() };
});

// End the output session rather than merely hiding it. Back to Load uses this
// boundary so no retained window, launch plan, or future Remote grant can
// restore a service the local operator intentionally left.
ipcMain.handle('display:endSession', async (event) => {
  requireControlSender(event);
  authorizeLocalShowCommand('session.end');
  const endedPowerPointShowReceipt = activePowerPointShowReceipt;
  destroyOutputWindows();
  const endedOutputSessionId = outputSessionId;
  const powerPointServiceHandoff = await finalizePowerPointServiceHandoff(
    endedPowerPointShowReceipt,
    endedOutputSessionId
  );
  return {
    success: true,
    showState: showGateway.getState(),
    powerPointServiceHandoff
  };
});

// Set fade duration for transitions
ipcMain.handle('display:setFade', async (event, duration) => {
  requireControlSender(event);
  if (appState.activeLaunchPlan) authorizeLocalShowCommand('output.configure');
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
  if (appState.activeLaunchPlan) authorizeLocalShowCommand('output.configure');
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
  if (appState.activeLaunchPlan) authorizeLocalShowCommand('output.configure');
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
  if (appState.activeLaunchPlan) authorizeLocalShowCommand('output.configure');
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
  if (appState.activeLaunchPlan) authorizeLocalShowCommand('output.configure');
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
  authorizeLocalShowCommand('output.stop');
  hideDisplayWindows();
  return { success: true };
});

ipcMain.handle('show:navigateTo', async (event, slideIndex) => {
  requireControlSender(event);
  authorizeLocalShowCommand('cue.jump');
  const result = await goToSlideConfirmed(slideIndex);
  if (liveCueNavigationWasPreempted(result)) {
    return { success: true, applied: false, showState: showGateway.getState() };
  }
  if (result?.accepted === false) failMainOperation(result.code, result.message);
  if (!result || result.accepted !== true) {
    failMainOperation('SHOW_NAVIGATION_FAILED', 'The Show could not change to that cue.');
  }
  return {
    success: true,
    applied: result.applied !== false,
    showState: showGateway.getState()
  };
});

ipcMain.handle('show:navigateBy', async (event, delta, options = {}) => {
  requireControlSender(event);
  if (delta !== -1 && delta !== 1) {
    failMainOperation('INVALID_CUE_DIRECTION', 'Show navigation must move one cue at a time.');
  }
  authorizeLocalShowCommand(delta === 1 ? 'cue.next' : 'cue.previous');
  if (delta === 1) {
    const video = handleCurrentVideoForwardAction(
      options?.input === 'space' ? 'space' : 'right'
    );
    if (video.handled) {
      return {
        success: true,
        applied: false,
        videoHandled: true,
        videoState: video.videoState,
        showState: showGateway.getState()
      };
    }
  }
  const result = await navigateSlideConfirmed(delta);
  if (liveCueNavigationWasPreempted(result)) {
    return { success: true, applied: false, showState: showGateway.getState() };
  }
  if (result?.code === 'AT_FIRST_CUE' || result?.code === 'AT_LAST_CUE') {
    return { success: true, applied: false, showState: showGateway.getState() };
  }
  if (result?.accepted === false) failMainOperation(result.code, result.message);
  if (!result || result.accepted !== true) {
    failMainOperation('SHOW_NAVIGATION_FAILED', 'The Show could not change cues.');
  }
  return {
    success: true,
    applied: result.applied !== false,
    showState: showGateway.getState()
  };
});

ipcMain.handle('show:unlockVolunteerControls', async (event) => {
  requireControlSender(event);
  if (!appState.activeLaunchPlan || !activeVolunteerShowBinding) {
    failMainOperation(
      'NO_ACTIVE_SHOW',
      'Start the Show before unlocking operator controls.'
    );
  }
  if (activeShowControlMode !== 'volunteer') {
    return {
      confirmed: false,
      alreadyFullControl: true,
      showState: showGateway.getState()
    };
  }

  const expectedBinding = activeVolunteerShowBinding;
  const result = await dialog.showMessageBox(controlWindow, {
    type: 'warning',
    title: 'Unlock volunteer Show controls?',
    message: 'Unlock live operator controls for two minutes?',
    detail:
      'This permits Previous, slide jumps, restoring black outputs, Bible and Remote setup, and leaving the Show. The unlock applies only to this exact running Show.',
    buttons: ['Unlock for 2 minutes', 'Keep volunteer controls'],
    defaultId: 1,
    cancelId: 1,
    noLink: true
  });
  if (result.response !== 0) {
    return { confirmed: false, showState: showGateway.getState() };
  }
  if (
    expectedBinding !== activeVolunteerShowBinding
    || !appState.activeLaunchPlan
    || activeShowControlMode !== 'volunteer'
  ) {
    failMainOperation(
      'OUTPUT_SESSION_REPLACED',
      'The Show changed while operator unlock was being confirmed.'
    );
  }

  const issuedAtMs = Date.now();
  const grant = createVolunteerShowUnlockGrant({
    confirmed: true,
    token: crypto.randomBytes(32).toString('base64url'),
    binding: expectedBinding,
    issuedAt: new Date(issuedAtMs).toISOString(),
    expiresAt: new Date(issuedAtMs + 2 * 60 * 1000).toISOString()
  });
  clearVolunteerShowUnlockTimer();
  activeVolunteerShowUnlockGrant = grant;
  volunteerShowUnlockTimer = setTimeout(() => {
    if (activeVolunteerShowUnlockGrant !== grant) return;
    const changed = relockVolunteerShowControls();
    if (changed) publishShowState('volunteer-controls-relocked');
  }, Math.max(1, Date.parse(grant.expiresAt) - Date.now()));
  volunteerShowUnlockTimer.unref?.();
  return {
    confirmed: true,
    showState: publishShowState('volunteer-controls-unlocked')
  };
});

ipcMain.handle('show:lockVolunteerControls', async (event) => {
  requireControlSender(event);
  const changed = relockVolunteerShowControls();
  return {
    success: true,
    changed,
    showState: changed
      ? publishShowState('volunteer-controls-relocked')
      : showGateway.getState()
  };
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
  authorizeLocalShowCommand('remote.manage');
  if (!request || typeof request !== 'object' || Array.isArray(request)
    || Object.keys(request).some(key => key !== 'bindingId')
    || typeof request.bindingId !== 'string'
    || request.bindingId.length > 96) {
    throw new TypeError('Choose a valid Remote Control network.');
  }
  const expectedOutputSessionId = showGateway.getState().outputSessionId;
  if (!expectedOutputSessionId) {
    failMainOperation('NO_ACTIVE_SHOW', 'Start the Show before turning on Remote Control.');
  }
  return enableRemoteControl(request.bindingId, expectedOutputSessionId);
});

ipcMain.handle('remote:rotatePairing', async (event) => {
  requireControlSender(event);
  authorizeLocalShowCommand('remote.manage');
  const expectedOutputSessionId = showGateway.getState().outputSessionId;
  if (!expectedOutputSessionId) {
    failMainOperation('NO_ACTIVE_SHOW', 'Start the Show before pairing a phone.');
  }
  const expectedGeneration = remotePairingGeneration;
  remoteLastError = null;
  return queueRemoteOperation(() => createRemotePairing({
    expectedGeneration,
    expectedOutputSessionId,
    requireLocalAuthority: true
  }));
});

ipcMain.handle('remote:closePairing', async (event) => {
  requireControlSender(event);
  authorizeLocalShowCommand('remote.closePairing');
  closeRemotePairing();
  return remoteManagementState();
});

ipcMain.handle('remote:revokeAll', async (event) => {
  requireControlSender(event);
  authorizeLocalShowCommand('remote.manage');
  const expectedOutputSessionId = showGateway.getState().outputSessionId;
  if (!expectedOutputSessionId) {
    failMainOperation('NO_ACTIVE_SHOW', 'Start the Show before changing Remote Control access.');
  }
  return queueRemoteOperation(async () => {
    requireRemoteManagementSession(expectedOutputSessionId);
    closeRemotePairing();
    remoteServer.revokeAll('operator-revoked');
    emitRemoteState();
    return remoteManagementState();
  });
});

ipcMain.handle('remote:disable', async (event) => {
  requireControlSender(event);
  authorizeLocalShowCommand('remote.manage');
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
    serviceHandoff: installedServiceHandoff(),
    preparedServiceRestore: currentPreparedServiceRestore,
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
  requireNoActiveShowForPresentationMutation();
  const previousPreparedVenueRevisionId = preparedServiceVenueRevisionId(
    activeVenueProfile
  );
  const normalized = saveUserSettings(settings);
  const nextPreparedVenueRevisionId = preparedServiceVenueRevisionId(
    activeVenueProfile
  );
  const preparedServiceInvalidated = Boolean(
    currentPreparedServicePointer
    && currentPreparedServiceRestore.status === 'restored'
    && (
      previousPreparedVenueRevisionId !== nextPreparedVenueRevisionId
      || currentPreparedServicePointer.venueProfileRevisionId
        !== nextPreparedVenueRevisionId
    )
  );
  if (preparedServiceInvalidated) {
    clearInstalledPreparedPresentations();
    setCurrentPreparedServiceRestore(
      'incompatible',
      currentPreparedServicePointer
    );
  }
  settingsRecoveryWarning = null;
  return { success: true, preparedServiceInvalidated, ...normalized };
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

ipcMain.handle('maintenance:sermonSources:audit', async (event) => {
  requireControlSender(event);
  try {
    return await auditPrivateSermonStorage();
  } catch (error) {
    failSermonSourceRetentionOperation(error, 'Private sermon storage check');
  }
});

ipcMain.handle(
  'maintenance:sermonSources:scheduleCleanup',
  async (event, request = {}) => {
    requireControlSender(event);
    requirePrepareRequest(request, 1024);
    requireExactPrepareKeys(
      request,
      ['candidateHash', 'confirmed'],
      'Private sermon storage cleanup request'
    );
    if (request.confirmed !== true) {
      failMainOperation(
        'SERMON_SOURCE_RETENTION_CONFIRMATION_REQUIRED',
        'Confirm the reviewed private sermon storage cleanup before scheduling it.'
      );
    }
    const candidateHash = prepareRevision(
      request.candidateHash,
      'Private sermon storage check'
    );
    try {
      const services = getPrepareServices();
      await recoverSermonTransactionsForRetention(services);
      return await services.localSermonSourceRetention.confirmStartupPlan({
        candidateHash
      });
    } catch (error) {
      failSermonSourceRetentionOperation(error, 'Private sermon cleanup scheduling');
    }
  }
);

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

  // Restoring PowerPoint is an explicit replacement of any prepared native
  // service, including across the next process restart.
  const releasePresentationMutation = beginPresentationMutation();
  try {
    await deactivateCurrentPreparedService({ clearPresentations: true });
    installPresentation(language, result);
  } finally {
    releasePresentationMutation();
  }
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

  app.whenReady().then(async () => {
    // Ensure cache directory exists now that app is ready
    ensureCacheDir();
    registerSermonRecordingPlaybackProtocol();
    loadAndApplyUserSettings();
    await applyConfirmedSermonSourceCleanupAtStartup();
    await restoreCurrentPreparedService();

    createControlWindow();
    scheduleCommunitySongSync('app startup', 2000);
    scheduleCommunityPeriodicSync({ resetBackoff: true });
    // Don't register shortcuts on startup - only when presentation starts

    // Handle display changes
    screen.on('display-added', () => updateDisplayList());
    screen.on('display-removed', (event, display) => handleDisplayRemoved(display));
    screen.on('display-metrics-changed', () => updateDisplayList());
    powerMonitor.on('suspend', () => {
      closeSermonRecordingPlayer().catch(error => {
        console.error('[Sermon] Could not finish recording playback cleanup:', error);
      });
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
  closeSermonRecordingPlayer().catch(() => {});
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
  clearSermonExtractionProposals();
  clearSermonBodyReviewProposals();
  clearSermonCueReconciliationProposals();
  clearCanonicalSermonBodyProjectionProposals();
  clearServiceSermonPacketProposals();
  approvedServiceFolders.clear();
  approvedDriveConnections.clear();
  googleDriveAccessTokens.clear();
  approvedPresentationPaths.clear();
});
