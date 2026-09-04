/**
 * SyncShow Load and Show workflow
 */

// Application State
const state = {
  workflowStage: 'load',
  presentations: {},
  presentationConversionRecovery: {},
  profile: null,
  profileDraft: null,
  profileDirty: false,
  profileSaveInFlight: false,
  profileRecoveryWarning: null,
  currentSlide: 0,
  totalSlides: 0,
  displays: [],
  isPresenting: false,
  activeLaunchPlan: null,
  showState: null,
  showActionRequest: 0,
  showEndSessionBusy: false,
  cueNavigationBusy: false,
  volunteerControlBusy: false,
  isStarting: false,
  isApplyingSettings: false,
  requireDisplayReassignment: false,
  friendlyMode: true,
  advancedWarningAcknowledged: false,
  advancedWarningAction: null,
  settingsTab: 'community',
  prepareMode: 'community',
  loadMode: 'syncshow',
  loadLocalServices: {
    items: [],
    busy: false,
    error: null
  },
  prepareAddTab: 'songs',
  cachedPresentations: null,
  cachedRestorePlan: null,
  restoreGroupId: null,
  startAttempt: null,
  serviceHandoff: null,
  preparedServiceRestore: { status: 'none' },
  preparedServiceDateConfirmations: new Set(),
  postShowOutcome: null,
  showHandoffBusy: false,
  showHandoffMode: null,
  postShowPowerPointHandoff: null,
  // Per-service output choices are intentionally renderer-memory only. They
  // never flow back into the saved venue profile.
  serviceOutputDecisions: {},
  singleServiceRoleId: null,
  serviceFolder: {
    requestedDate: '',
    scan: null,
    scanToken: null,
    selectedSetId: null,
    current: null,
    sourceChanges: [],
    scanning: false,
    loading: false,
    error: null,
    conversionError: null,
    conversionFailedRoleIds: [],
    folderChangedSinceLoad: false,
    staleRoleIds: [],
    scanVersion: 0,
    scanEpoch: null,
    changeEpoch: 0,
    changeTimer: null
  },
  drive: {
    status: null,
    busy: false,
    error: null,
    oauth: window.SyncShowGoogleDriveOAuthState.createInitialState()
  },
  community: {
    status: null,
    plannerOpen: false,
    plannerBusy: false,
    plannerError: null,
    authorizationId: null,
    busy: false,
    syncing: false,
    sermonSyncing: false,
    error: null,
    lastSync: null,
    lastSermonSync: null,
    pollGeneration: 0,
    approvalActionBusy: false,
    approvalActionMessage: ''
  },
  sermonStorage: {
    summary: null,
    checking: false,
    scheduling: false,
    scheduled: false,
    error: null,
    actionMessage: ''
  },
  bible: {
    query: '',
    translationId: 'BSB',
    selectedBook: null,
    passage: null,
    choices: [],
    lookupVersion: 0,
    busy: false,
    sending: false,
    sendVersion: 0,
    isLive: false,
    liveOutputIds: []
  },
  remote: {
    status: null,
    bindings: [],
    busy: false,
    error: null
  },
  thumbnailSelection: 'all',
  thumbnailZoom: 100,  // percentage, 50-200
  singerFontSize: 36,   // px, 12-120
  singerCharLimit: 70,  // characters, 10-500
  singerTextPadding: 4  // px, 0-80
};

function parseIntegerOr(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function normalizeCommunityServerAddress(value) {
  const entered = String(value || '').trim();
  if (!entered) throw new TypeError('Community server address is required');
  const candidate = /^[a-z][a-z0-9+.-]*:\/\//i.test(entered)
    ? entered
    : `https://${entered}`;
  const parsed = new URL(candidate);
  const hostname = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  const loopback = hostname === 'localhost'
    || hostname === '::1'
    || /^127(?:\.\d{1,3}){3}$/.test(hostname);
  if (parsed.protocol !== 'https:'
    && !(parsed.protocol === 'http:' && loopback)) {
    throw new TypeError('Community server address must use HTTPS');
  }
  if (parsed.username || parsed.password) {
    throw new TypeError('Community server address must not include credentials');
  }
  return parsed.origin;
}

function setSelectValuePreservingCustomOption(select, value, formatLabel) {
  const normalizedValue = String(value);
  for (const option of [...select.options]) {
    if (option.dataset.customValue === 'true') option.remove();
  }
  if (![...select.options].some(option => option.value === normalizedValue)) {
    const option = document.createElement('option');
    option.value = normalizedValue;
    option.textContent = formatLabel(normalizedValue);
    option.dataset.customValue = 'true';
    select.appendChild(option);
  }
  select.value = normalizedValue;
}

// DOM Elements
const elements = {
  appSubtitle: document.getElementById('appSubtitle'),
  btnStagePrepare: document.getElementById('btnStagePrepare'),
  btnStageLoad: document.getElementById('btnStageLoad'),
  btnStageShow: document.getElementById('btnStageShow'),
  communityPrepareShell: document.getElementById('communityPrepareShell'),
  legacyPrepareShell: document.getElementById('legacyPrepareShell'),
  btnPrepareModeCommunity: document.getElementById('btnPrepareModeCommunity'),
  btnPrepareModeLocal: document.getElementById('btnPrepareModeLocal'),
  communityPlannerViewport: document.getElementById('communityPlannerViewport'),
  communityPrepareHeading: document.getElementById('communityPrepareHeading'),
  communityPrepareStatus: document.getElementById('communityPrepareStatus'),
  inputCards: document.getElementById('inputCards'),
  serviceFolderCard: document.getElementById('serviceFolderCard'),
  serviceFolderStateBadge: document.getElementById('serviceFolderStateBadge'),
  serviceFolderLocation: document.getElementById('serviceFolderLocation'),
  serviceFolderName: document.getElementById('serviceFolderName'),
  serviceFolderPath: document.getElementById('serviceFolderPath'),
  driveSetupNotice: document.getElementById('driveSetupNotice'),
  driveOAuthDialog: document.getElementById('driveOAuthDialog'),
  driveOAuthActionStatus: document.getElementById('driveOAuthActionStatus'),
  btnCopyDriveOAuthLink: document.getElementById('btnCopyDriveOAuthLink'),
  btnCancelDriveOAuth: document.getElementById('btnCancelDriveOAuth'),
  btnConnectPrivateDrive: document.getElementById('btnConnectPrivateDrive'),
  privateDriveSourceHelp: document.getElementById('privateDriveSourceHelp'),
  publicDriveSourceOption: document.getElementById('publicDriveSourceOption'),
  publicDriveSourceHelp: document.getElementById('publicDriveSourceHelp'),
  publicDriveFolderUrl: document.getElementById('publicDriveFolderUrl'),
  btnLinkPublicDrive: document.getElementById('btnLinkPublicDrive'),
  btnDisconnectServiceSource: document.getElementById('btnDisconnectServiceSource'),
  drivePublishingControl: document.getElementById('drivePublishingControl'),
  drivePublishingEnabled: document.getElementById('drivePublishingEnabled'),
  drivePublishingHelp: document.getElementById('drivePublishingHelp'),
  serviceFolderDate: document.getElementById('serviceFolderDate'),
  serviceFolderScanStatus: document.getElementById('serviceFolderScanStatus'),
  serviceSetResults: document.getElementById('serviceSetResults'),
  serviceSetChoiceRow: document.getElementById('serviceSetChoiceRow'),
  serviceSetSelect: document.getElementById('serviceSetSelect'),
  serviceSetRoleSummary: document.getElementById('serviceSetRoleSummary'),
  serviceSetWarnings: document.getElementById('serviceSetWarnings'),
  serviceSetOfflineState: document.getElementById('serviceSetOfflineState'),
  serviceSetChangedNotice: document.getElementById('serviceSetChangedNotice'),
  btnChooseServiceFolder: document.getElementById('btnChooseServiceFolder'),
  btnRefreshServiceFolder: document.getElementById('btnRefreshServiceFolder'),
  btnLoadServiceSet: document.getElementById('btnLoadServiceSet'),
  communityConnectionSection: document.getElementById('communityConnectionSection'),
  communityConnectionForm: document.getElementById('communityConnectionForm'),
  communityConnectionBadge: document.getElementById('communityConnectionBadge'),
  communityServerUrl: document.getElementById('communityServerUrl'),
  communityAdminEmail: document.getElementById('communityAdminEmail'),
  communityConnectionHelp: document.getElementById('communityConnectionHelp'),
  communityConnectionStatus: document.getElementById('communityConnectionStatus'),
  communityConnectionStatusTitle: document.getElementById('communityConnectionStatusTitle'),
  communityConnectionStatusDetail: document.getElementById('communityConnectionStatusDetail'),
  communityApprovalRecovery: document.getElementById('communityApprovalRecovery'),
  communityApprovalCode: document.getElementById('communityApprovalCode'),
  communityApprovalActionStatus: document.getElementById('communityApprovalActionStatus'),
  communityLastSyncSummary: document.getElementById('communityLastSyncSummary'),
  communityLastSermonSyncSummary: document.getElementById('communityLastSermonSyncSummary'),
  communitySongPublicLinkSummary: document.getElementById('communitySongPublicLinkSummary'),
  communitySongPublicLinkBadge: document.getElementById('communitySongPublicLinkBadge'),
  btnConnectCommunity: document.getElementById('btnConnectCommunity'),
  btnCancelCommunityConnection: document.getElementById('btnCancelCommunityConnection'),
  btnOpenCommunityApproval: document.getElementById('btnOpenCommunityApproval'),
  btnCopyCommunityApprovalCode: document.getElementById('btnCopyCommunityApprovalCode'),
  btnDisconnectCommunity: document.getElementById('btnDisconnectCommunity'),
  btnSyncCommunitySongs: document.getElementById('btnSyncCommunitySongs'),
  btnSyncCommunitySermons: document.getElementById('btnSyncCommunitySermons'),
  sermonStorageBadge: document.getElementById('sermonStorageBadge'),
  sermonStorageStatus: document.getElementById('sermonStorageStatus'),
  sermonStorageStatusTitle: document.getElementById('sermonStorageStatusTitle'),
  sermonStorageStatusDetail: document.getElementById('sermonStorageStatusDetail'),
  sermonStorageSummary: document.getElementById('sermonStorageSummary'),
  sermonStorageTotal: document.getElementById('sermonStorageTotal'),
  sermonStorageProtected: document.getElementById('sermonStorageProtected'),
  sermonStorageWaiting: document.getElementById('sermonStorageWaiting'),
  sermonStorageEligible: document.getElementById('sermonStorageEligible'),
  sermonStorageActionStatus: document.getElementById('sermonStorageActionStatus'),
  btnCheckSermonStorage: document.getElementById('btnCheckSermonStorage'),
  btnScheduleSermonStorageCleanup: document.getElementById('btnScheduleSermonStorageCleanup'),
  inputRoleSettingsList: document.getElementById('inputRoleSettingsList'),
  outputSettingsList: document.getElementById('outputSettingsList'),
  outputHealthSummary: document.getElementById('outputHealthSummary'),
  profileName: document.getElementById('profileName'),
  profileServiceFolder: document.getElementById('profileServiceFolder'),
  profileTimeZone: document.getElementById('profileTimeZone'),
  profileServiceDateOrder: document.getElementById('profileServiceDateOrder'),
  profileShowControlMode: document.getElementById('profileShowControlMode'),
  btnChooseProfileServiceFolder: document.getElementById('btnChooseProfileServiceFolder'),
  profileEditorStatus: document.getElementById('profileEditorStatus'),
  btnAddInputRole: document.getElementById('btnAddInputRole'),
  btnAddOutput: document.getElementById('btnAddOutput'),
  btnResetProfileDraft: document.getElementById('btnResetProfileDraft'),
  btnCancelProfileChanges: document.getElementById('btnCancelProfileChanges'),
  btnSaveProfile: document.getElementById('btnSaveProfile'),
  singerLanguage: document.getElementById('singerLanguage'),
  fadeDuration: document.getElementById('fadeDuration'),
  syncMode: document.getElementById('syncMode'),
  friendlyMode: document.getElementById('friendlyMode'),
  btnOpenCommunityServiceFromLoad: document.getElementById('btnOpenCommunityServiceFromLoad'),
  btnImportSyncShowFileFromLoad: document.getElementById('btnImportSyncShowFileFromLoad'),
  btnOpenPptxImportFromLoad: document.getElementById('btnOpenPptxImportFromLoad'),
  loadModeTabs: Array.from(document.querySelectorAll('[data-load-tab]')),
  loadModePanels: Array.from(document.querySelectorAll('[data-load-panel]')),
  loadLocalServiceList: document.getElementById('loadLocalServiceList'),
  btnRefreshLocalServices: document.getElementById('btnRefreshLocalServices'),
  inputCardsHostLoad: document.getElementById('inputCardsHostLoad'),
  inputCardsHostScreens: document.getElementById('inputCardsHostScreens'),
  loadAutoStatus: document.getElementById('loadAutoStatus'),
  loadServiceHandoff: document.getElementById('loadServiceHandoff'),
  loadServiceHandoffTitle: document.getElementById('loadServiceHandoffTitle'),
  loadServiceHandoffSchedule: document.getElementById('loadServiceHandoffSchedule'),
  loadServiceHandoffBadge: document.getElementById('loadServiceHandoffBadge'),
  loadServiceHandoffNotes: document.getElementById('loadServiceHandoffNotes'),
  loadServiceHandoffRunSheet: document.getElementById('loadServiceHandoffRunSheet'),
  loadServiceHandoffTeam: document.getElementById('loadServiceHandoffTeam'),
  loadServiceHandoffReview: document.getElementById('loadServiceHandoffReview'),
  loadServiceReviewDetails: document.getElementById('loadServiceReviewDetails'),
  btnEditLoadedService: document.getElementById('btnEditLoadedService'),
  btnLoadedServiceScreens: document.getElementById('btnLoadedServiceScreens'),
  adminSettingsTabs: Array.from(document.querySelectorAll('[data-settings-tab]')),
  adminSettingsPanels: Array.from(document.querySelectorAll('[data-settings-panel]')),
  prepareAddTabs: Array.from(document.querySelectorAll('[data-prepare-add-tab]')),
  prepareAddPanels: Array.from(document.querySelectorAll('[data-prepare-add-panel]')),
  advancedSetupDetails: document.getElementById('advancedSetupDetails'),
  btnCloseAdminSettings: document.getElementById('btnCloseAdminSettings'),
  advancedWarningDialog: document.getElementById('advancedWarningDialog'),
  btnCancelAdvanced: document.getElementById('btnCancelAdvanced'),
  btnConfirmAdvanced: document.getElementById('btnConfirmAdvanced'),
  startPreflightDialog: document.getElementById('startPreflightDialog'),
  preflightForm: document.getElementById('preflightForm'),
  preflightProgress: document.getElementById('preflightProgress'),
  preflightTitle: document.getElementById('preflightTitle'),
  preflightDescription: document.getElementById('preflightDescription'),
  preflightError: document.getElementById('preflightError'),
  preflightChoices: document.getElementById('preflightChoices'),
  preflightReview: document.getElementById('preflightReview'),
  btnCancelPreflight: document.getElementById('btnCancelPreflight'),
  btnPreflightBack: document.getElementById('btnPreflightBack'),
  btnPreflightContinue: document.getElementById('btnPreflightContinue'),
  bibleDialog: document.getElementById('bibleDialog'),
  bibleForm: document.getElementById('bibleForm'),
  bibleReference: document.getElementById('bibleReference'),
  bibleTranslation: document.getElementById('bibleTranslation'),
  btnLookupBible: document.getElementById('btnLookupBible'),
  btnOpenBible: document.getElementById('btnOpenBible'),
  btnCloseBible: document.getElementById('btnCloseBible'),
  btnCancelBible: document.getElementById('btnCancelBible'),
  btnSendBibleLive: document.getElementById('btnSendBibleLive'),
  btnReturnFromBible: document.getElementById('btnReturnFromBible'),
  bibleError: document.getElementById('bibleError'),
  bibleAmbiguity: document.getElementById('bibleAmbiguity'),
  bibleAmbiguityChoices: document.getElementById('bibleAmbiguityChoices'),
  biblePreview: document.getElementById('biblePreview'),
  biblePreviewReference: document.getElementById('biblePreviewReference'),
  biblePreviewTranslation: document.getElementById('biblePreviewTranslation'),
  biblePreviewVerses: document.getElementById('biblePreviewVerses'),
  biblePreviewAttribution: document.getElementById('biblePreviewAttribution'),
  bibleTargets: document.getElementById('bibleTargets'),
  bibleTargetList: document.getElementById('bibleTargetList'),
  remoteDialog: document.getElementById('remoteDialog'),
  remoteDialogBadge: document.getElementById('remoteDialogBadge'),
  remoteDialogStatus: document.getElementById('remoteDialogStatus'),
  remoteError: document.getElementById('remoteError'),
  remoteOffView: document.getElementById('remoteOffView'),
  remoteOnView: document.getElementById('remoteOnView'),
  remoteInterfaceSelect: document.getElementById('remoteInterfaceSelect'),
  remoteNetworkHelp: document.getElementById('remoteNetworkHelp'),
  remoteNetworkSummary: document.getElementById('remoteNetworkSummary'),
  remotePairingCard: document.getElementById('remotePairingCard'),
  remotePairQr: document.getElementById('remotePairQr'),
  remotePairCode: document.getElementById('remotePairCode'),
  remotePairExpiry: document.getElementById('remotePairExpiry'),
  remotePairAddress: document.getElementById('remotePairAddress'),
  remotePairExpired: document.getElementById('remotePairExpired'),
  remotePairClosedTitle: document.getElementById('remotePairClosedTitle'),
  remotePairClosedText: document.getElementById('remotePairClosedText'),
  remoteDeviceSummary: document.getElementById('remoteDeviceSummary'),
  remoteTileSummary: document.getElementById('remoteTileSummary'),
  remoteTileStatus: document.getElementById('remoteTileStatus'),
  remoteLiveStrip: document.getElementById('remoteLiveStrip'),
  remoteLiveDeviceCount: document.getElementById('remoteLiveDeviceCount'),
  btnOpenRemote: document.getElementById('btnOpenRemote'),
  btnOpenRemoteStatus: document.getElementById('btnOpenRemoteStatus'),
  btnCloseRemote: document.getElementById('btnCloseRemote'),
  btnDoneRemote: document.getElementById('btnDoneRemote'),
  btnRefreshRemoteInterfaces: document.getElementById('btnRefreshRemoteInterfaces'),
  btnEnableRemote: document.getElementById('btnEnableRemote'),
  btnRotateRemotePairing: document.getElementById('btnRotateRemotePairing'),
  btnCreateRemotePairing: document.getElementById('btnCreateRemotePairing'),
  btnRevokeRemoteDevices: document.getElementById('btnRevokeRemoteDevices'),
  btnRemoteOff: document.getElementById('btnRemoteOff'),
  btnRemoteOffDialog: document.getElementById('btnRemoteOffDialog'),
  
  // Control buttons
  btnRefreshDisplays: document.getElementById('btnRefreshDisplays'),
  btnIdentifyDisplays: document.getElementById('btnIdentifyDisplays'),
  btnOpenSettings: document.getElementById('btnOpenSettings'),
  btnStartPresentation: document.getElementById('btnStartPresentation'),
  btnRestorePrevious: document.getElementById('btnRestorePrevious'),
  btnShowDisplays: document.getElementById('btnShowDisplays'),
  btnClearDisplays: document.getElementById('btnClearDisplays'),
  btnStopDisplays: document.getElementById('btnStopDisplays'),
  btnBackToSetup: document.getElementById('btnBackToSetup'),
  btnPrevSlide: document.getElementById('btnPrevSlide'),
  btnNextSlide: document.getElementById('btnNextSlide'),
  volunteerControlBar: document.getElementById('volunteerControlBar'),
  volunteerControlTitle: document.getElementById('volunteerControlTitle'),
  volunteerControlDetail: document.getElementById('volunteerControlDetail'),
  btnUnlockVolunteerControls: document.getElementById('btnUnlockVolunteerControls'),
  btnLockVolunteerControls: document.getElementById('btnLockVolunteerControls'),
  showOutputState: document.getElementById('showOutputState'),
  showOutputStateTitle: document.getElementById('showOutputStateTitle'),
  showOutputStateDetail: document.getElementById('showOutputStateDetail'),
  showCueContext: document.getElementById('showCueContext'),
  showCueContextPath: document.getElementById('showCueContextPath'),
  showCueContextTitle: document.getElementById('showCueContextTitle'),
  showCueContextMeta: document.getElementById('showCueContextMeta'),
  showCueContextNote: document.getElementById('showCueContextNote'),
  showCueContextNext: document.getElementById('showCueContextNext'),
  showHandoffDialog: document.getElementById('showHandoffDialog'),
  showHandoffTitle: document.getElementById('showHandoffTitle'),
  showHandoffDescription: document.getElementById('showHandoffDescription'),
  showHandoffServiceTitle: document.getElementById('showHandoffServiceTitle'),
  showHandoffServiceMeta: document.getElementById('showHandoffServiceMeta'),
  showHandoffError: document.getElementById('showHandoffError'),
  btnShowHandoffCompleted: document.getElementById('btnShowHandoffCompleted'),
  btnShowHandoffFollowUp: document.getElementById('btnShowHandoffFollowUp'),
  btnOpenShowSermonHandoff: document.getElementById('btnOpenShowSermonHandoff'),
  btnCloseShowHandoff: document.getElementById('btnCloseShowHandoff'),
  
  // Panels
  preparePanel: document.getElementById('preparePanel'),
  setupPanel: document.getElementById('setupPanel'),
  mainContent: document.getElementById('mainContent'),
  setupHeader: document.getElementById('setupHeader'),
  readinessCard: document.querySelector('.readiness-card'),
  readinessIcon: document.getElementById('readinessIcon'),
  readinessTitle: document.getElementById('readinessTitle'),
  readinessSummary: document.getElementById('readinessSummary'),
  readinessIssues: document.getElementById('readinessIssues'),
  restoreSummary: document.getElementById('restoreSummary'),
  
  // Slide displays
  currentSlideNum: document.getElementById('currentSlideNum'),
  totalSlides: document.getElementById('totalSlides'),
  thumbnailsGrid: document.getElementById('thumbnailsGrid'),
  thumbnailRoleSelector: document.getElementById('thumbnailRoleSelector'),

  // Zoom controls
  zoomIn: document.getElementById('zoomIn'),
  zoomOut: document.getElementById('zoomOut'),
  zoomLevel: document.getElementById('zoomLevel'),

  previewBox: document.getElementById('previewBox'),
  outputPreviewList: document.getElementById('outputPreviewList'),

  // Singer font size
  singerFontSize: document.getElementById('singerFontSize'),
  singerFontUp: document.getElementById('singerFontUp'),
  singerFontDown: document.getElementById('singerFontDown'),

  // Singer char limit
  singerCharLimit: document.getElementById('singerCharLimit'),
  singerCharLimitUp: document.getElementById('singerCharLimitUp'),
  singerCharLimitDown: document.getElementById('singerCharLimitDown'),

  // Singer text padding
  singerTextPadding: document.getElementById('singerTextPadding'),
  singerTextPaddingUp: document.getElementById('singerTextPaddingUp'),
  singerTextPaddingDown: document.getElementById('singerTextPaddingDown'),

  // Status bar
  statusMessage: document.getElementById('statusMessage')
};

const FALLBACK_ROLE_LABELS = {
  russian: 'Russian',
  english: 'English',
  media: 'Stage-Facing Screen / Media'
};

const presentationElements = {};
const outputPreviewElements = new Map();
let profilePreferenceSaveQueue = Promise.resolve();
let profilePreferenceRevision = 0;
let remoteExpiryInterval = null;
let remoteDialogGeneration = 0;
let remoteDialogOpener = null;
let prepareController = null;
let sharedServiceController = null;
let communityPollTimer = null;
let communityStatusUnsubscribe = null;
let communityPlannerStateUnsubscribe = null;
let communityPlannerLayoutFrame = null;

function setTextIfChanged(element, value) {
  const text = String(value ?? '');
  if (element.textContent !== text) element.textContent = text;
}

function cloneValue(value) {
  return JSON.parse(JSON.stringify(value));
}

function getRole(roleId, { draft = false } = {}) {
  const profile = draft ? state.profileDraft : state.profile;
  return profile?.inputRoles?.find(role => role.id === roleId) || null;
}

function getRoleLabel(roleId, options) {
  return getRole(roleId, options)?.label || FALLBACK_ROLE_LABELS[roleId] || roleId;
}

function getDeckRoles(profile = state.profile) {
  return (profile?.inputRoles || []).filter(role => role.enabled && role.kind === 'deck');
}

function emptyPresentation() {
  return { loaded: false, pending: false, path: null, slides: [], source: 'none' };
}

function resetServiceOutputChoices({ refresh = false } = {}) {
  state.serviceOutputDecisions = {};
  state.singleServiceRoleId = null;
  if (refresh) {
    refreshServiceRoleActions();
    checkReadyState();
  }
}

// Initialize the application
async function init() {
  if (window.SyncShowPrepare?.createController) {
    prepareController = window.SyncShowPrepare.createController({
      api: window.api,
      onPublished: refreshPublishedProject,
      onStatus: setStatus,
      onProjectChanged: result => {
        refreshLoadLocalServices();
        return sharedServiceController?.projectChanged?.(result);
      }
    }).initialize();
  }
  if (window.SyncShowSharedServices?.createController && prepareController) {
    sharedServiceController = window.SyncShowSharedServices.createController({
      api: window.api,
      prepareController,
      onStatus: setStatus,
      onLoaded: refreshPublishedProject
    }).initialize();
  }
  setupEventListeners();
  renderPrivateSermonStorage();
  setWorkflowStage('load');

  // Establish the generic message first. More useful state discovered during
  // startup (cached files, display problems, etc.) is then allowed to replace
  // it instead of being overwritten at the end of initialization.
  setStatus('Choose today’s slideshows to begin');

  // Set up IPC listeners
  window.api.onDisplaysUpdated(handleDisplaysUpdated);
  window.api.onConversionProgress(handleConversionProgress);
  window.api.onSlideChanged(handleSlideChanged);
  window.api.onDisplaysCleared(handleDisplaysCleared);
  window.api.onDisplayInterrupted(handleDisplayInterrupted);
  if (typeof window.api.onShowStateChanged === 'function') {
    window.api.onShowStateChanged(handleShowStateChanged);
  }
  if (typeof window.api.onShowRehearsalProgress === 'function') {
    window.api.onShowRehearsalProgress(handleShowRehearsalProgress);
  }
  if (typeof window.api.onRemoteStateChanged === 'function') {
    window.api.onRemoteStateChanged(handleRemoteStateChanged);
  }
  window.api.onOutputPreview(handleOutputPreview);
  window.api.onBibleStateChanged(handleBibleStateChanged);
  if (typeof window.api.onServiceFolderChanged === 'function') {
    window.api.onServiceFolderChanged(handleServiceFolderChanged);
  }
  if (typeof window.api.onPrivateDriveOAuthStateChanged === 'function') {
    window.api.onPrivateDriveOAuthStateChanged(handlePrivateDriveOAuthStateChanged);
  }
  if (typeof window.api.onCommunityStatus === 'function') {
    const unsubscribe = window.api.onCommunityStatus(handleCommunityStatusChanged);
    if (typeof unsubscribe === 'function') communityStatusUnsubscribe = unsubscribe;
  }
  if (typeof window.api.onCommunityPlannerState === 'function') {
    const unsubscribe = window.api.onCommunityPlannerState(
      handleCommunityPlannerStateChanged
    );
    if (typeof unsubscribe === 'function') {
      communityPlannerStateUnsubscribe = unsubscribe;
    }
  }

  // Register main-process listeners before requesting initial state so a
  // display-change notification cannot be lost during startup.
  await refreshPrivateDriveOAuthState();
  await refreshCommunityStatus();
  await refreshCommunityPlannerState();
  await loadAppState();
  await refreshRemoteControl({ refreshBindings: true });
  await initializeServiceFolder();
}

function setupEventListeners() {
  // Workflow navigation. Load remains the safe startup stage; Show becomes
  // available only after an output session has actually started.
  elements.btnStagePrepare.addEventListener('click', () => navigateWorkflowStage('prepare'));
  elements.btnStageLoad.addEventListener('click', () => navigateWorkflowStage('load'));
  elements.btnStageShow.addEventListener('click', () => navigateWorkflowStage('show'));
  elements.btnPrepareModeCommunity.addEventListener('click', () => activatePrepareMode('community'));
  elements.btnPrepareModeLocal.addEventListener('click', () => activatePrepareMode('local'));
  elements.btnOpenCommunityServiceFromLoad.addEventListener('click', async () => {
    elements.btnOpenCommunityServiceFromLoad.disabled = true;
    try {
      const opened = await sharedServiceController?.open?.();
      if (!opened) {
        setStatus('Connect Heritage Community in Admin Settings to open a shared service');
        openSettings('community');
      }
    } finally {
      elements.btnOpenCommunityServiceFromLoad.disabled = false;
    }
  });
  elements.btnImportSyncShowFileFromLoad.addEventListener('click', async () => {
    await setWorkflowStage('prepare', { localTools: true });
    await prepareController?.importProject?.();
  });
  elements.btnOpenPptxImportFromLoad.addEventListener('click', () => {
    openSettings('google-drive');
  });
  elements.loadModeTabs.forEach(tab => {
    tab.addEventListener('click', () => activateLoadMode(tab.dataset.loadTab));
    tab.addEventListener('keydown', handleLoadModeKeydown);
  });
  elements.btnRefreshLocalServices.addEventListener('click', refreshLoadLocalServices);
  elements.btnEditLoadedService.addEventListener('click', openLoadedServiceInPrepare);
  elements.btnLoadedServiceScreens.addEventListener('click', () => openSettings('screens'));

  // Display controls
  elements.btnRefreshDisplays.addEventListener('click', refreshDisplays);
  elements.btnIdentifyDisplays.addEventListener('click', identifyDisplays);
  elements.btnOpenSettings.addEventListener('click', () => openSettings());
  elements.btnCloseAdminSettings.addEventListener('click', closeSettings);
  elements.adminSettingsTabs.forEach(tab => {
    tab.addEventListener('click', () => activateSettingsTab(tab.dataset.settingsTab));
    tab.addEventListener('keydown', handleSettingsTabKeydown);
  });
  elements.prepareAddTabs.forEach(tab => {
    tab.addEventListener('click', () => activatePrepareAddTab(tab.dataset.prepareAddTab));
    tab.addEventListener('keydown', handlePrepareAddTabKeydown);
  });
  elements.btnStartPresentation.addEventListener('click', startPresentation);
  elements.btnRestorePrevious.addEventListener('click', restoreCachedPresentations);
  elements.btnChooseServiceFolder.addEventListener('click', chooseAndLinkServiceFolder);
  elements.btnConnectPrivateDrive.addEventListener('click', connectPrivateDrive);
  elements.btnCopyDriveOAuthLink.addEventListener('click', copyPrivateDriveOAuthLink);
  elements.btnCancelDriveOAuth.addEventListener('click', cancelPrivateDriveOAuth);
  elements.driveOAuthDialog.addEventListener('cancel', event => {
    event.preventDefault();
    cancelPrivateDriveOAuth();
  });
  elements.driveOAuthDialog.addEventListener('close', () => {
    if (!state.drive.oauth.active) return;
    window.setTimeout(() => {
      if (state.drive.oauth.active && !elements.driveOAuthDialog.open) {
        elements.driveOAuthDialog.showModal();
      }
    }, 0);
  });
  elements.btnLinkPublicDrive.addEventListener('click', linkPublicDrive);
  elements.publicDriveFolderUrl.addEventListener('keydown', event => {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    if (elements.publicDriveFolderUrl.disabled || elements.btnLinkPublicDrive.disabled) return;
    linkPublicDrive();
  });
  elements.btnDisconnectServiceSource.addEventListener('click', disconnectServiceSource);
  elements.drivePublishingEnabled.addEventListener('change', updateDrivePublishingPreference);
  elements.btnRefreshServiceFolder.addEventListener('click', () => scanLinkedServiceFolder({ reason: 'manual' }));
  elements.btnLoadServiceSet.addEventListener('click', loadSelectedServiceSet);
  elements.communityConnectionForm.addEventListener('submit', startCommunityConnection);
  elements.btnCancelCommunityConnection.addEventListener('click', cancelCommunityConnection);
  elements.btnOpenCommunityApproval.addEventListener('click', openCommunityApproval);
  elements.btnCopyCommunityApprovalCode.addEventListener('click', copyCommunityApprovalCode);
  elements.btnDisconnectCommunity.addEventListener('click', disconnectCommunity);
  elements.btnSyncCommunitySongs.addEventListener('click', syncCommunitySongs);
  elements.btnSyncCommunitySermons.addEventListener('click', syncCommunitySermons);
  elements.btnCheckSermonStorage.addEventListener('click', checkPrivateSermonStorage);
  elements.btnScheduleSermonStorageCleanup.addEventListener(
    'click',
    schedulePrivateSermonStorageCleanup
  );
  elements.serviceSetSelect.addEventListener('change', () => {
    state.serviceFolder.selectedSetId = elements.serviceSetSelect.value || null;
    renderServiceFolder();
  });
  elements.serviceFolderDate.addEventListener('change', () => {
    state.serviceFolder.requestedDate = elements.serviceFolderDate.value;
    recheckLoadedPresentationDates();
    renderServiceFolder();
    checkReadyState();
    if (hasConfiguredServiceSource()) scanLinkedServiceFolder({ reason: 'date' });
  });
  elements.btnShowDisplays.addEventListener('click', showDisplays);
  elements.btnClearDisplays.addEventListener('click', clearDisplays);
  elements.btnStopDisplays.addEventListener('click', stopDisplays);
  elements.btnBackToSetup.addEventListener('click', () => backToSetup('load'));
  elements.btnShowHandoffCompleted.addEventListener(
    'click',
    completeAndOpenPostShowSermonHandoff
  );
  elements.btnShowHandoffFollowUp.addEventListener('click', () =>
    savePostShowPlanningStatus('needs-follow-up')
  );
  elements.btnOpenShowSermonHandoff.addEventListener('click', openPostShowSermonHandoff);
  elements.btnCloseShowHandoff.addEventListener('click', closeShowHandoffDialog);
  elements.showHandoffDialog.addEventListener('cancel', event => {
    event.preventDefault();
    if (!state.showHandoffBusy) closeShowHandoffDialog();
  });
  
  // Fade duration change (can be changed while presenting)
  elements.fadeDuration.addEventListener('change', handleFadeDurationChange);
  
  // Sync mode toggle (can be changed while presenting)
  elements.syncMode.addEventListener('change', handleSyncModeChange);
  elements.singerLanguage.addEventListener('change', stageProfilePreferencesFromControls);

  elements.profileName.addEventListener('input', () => {
    if (!state.profileDraft) return;
    state.profileDraft.name = elements.profileName.value;
    markProfileDirty();
  });
  elements.profileTimeZone.addEventListener('input', () => {
    if (!state.profileDraft) return;
    state.profileDraft.timeZone = elements.profileTimeZone.value.trim() || null;
    markProfileDirty('Time zone changed in the draft. Save to apply it to service dates.');
  });
  elements.profileServiceDateOrder.addEventListener('change', () => {
    if (!state.profileDraft) return;
    state.profileDraft.serviceDateOrder = elements.profileServiceDateOrder.value;
    markProfileDirty('Filename date order changed in the draft. Save to apply it to folder matching and warnings.');
  });
  elements.profileShowControlMode.addEventListener('change', () => {
    if (!state.profileDraft) return;
    state.profileDraft.operator.showControlMode = elements.profileShowControlMode.value;
    markProfileDirty(
      'Show handoff controls changed in the draft. Save to apply them to the next Show.'
    );
  });
  elements.btnChooseProfileServiceFolder.addEventListener('click', () => {
    activateSettingsTab('google-drive', { focusTab: true });
  });
  elements.btnAddInputRole.addEventListener('click', addInputRoleDraft);
  elements.btnAddOutput.addEventListener('click', addOutputDraft);
  elements.btnResetProfileDraft.addEventListener('click', resetProfileDraft);
  elements.btnCancelProfileChanges.addEventListener('click', discardProfileChanges);
  elements.btnSaveProfile.addEventListener('click', saveProfileChanges);
  elements.inputRoleSettingsList.addEventListener('input', handleProfileEditorInput);
  elements.inputRoleSettingsList.addEventListener('change', handleProfileEditorInput);
  elements.inputRoleSettingsList.addEventListener('click', handleProfileEditorAction);
  elements.outputSettingsList.addEventListener('input', handleProfileEditorInput);
  elements.outputSettingsList.addEventListener('change', handleProfileEditorInput);
  elements.outputSettingsList.addEventListener('click', handleProfileEditorAction);

  elements.friendlyMode.addEventListener('change', handleFriendlyModeChange);
  elements.btnCancelAdvanced.addEventListener('click', cancelAdvancedMode);
  elements.btnConfirmAdvanced.addEventListener('click', confirmAdvancedMode);
  elements.advancedWarningDialog.addEventListener('cancel', event => {
    event.preventDefault();
    cancelAdvancedMode();
  });
  elements.preflightForm.addEventListener('submit', handlePreflightSubmit);
  elements.btnCancelPreflight.addEventListener('click', cancelStartAttempt);
  elements.btnPreflightBack.addEventListener('click', goBackInPreflight);
  elements.startPreflightDialog.addEventListener('cancel', (event) => {
    event.preventDefault();
    cancelStartAttempt();
  });
  elements.startPreflightDialog.addEventListener('close', () => {
    const attempt = state.startAttempt;
    if (attempt && attempt.status !== 'uploading' && attempt.status !== 'launching') {
      cancelStartAttempt();
    }
  });
  elements.advancedSetupDetails.addEventListener('cancel', event => {
    event.preventDefault();
    closeSettings();
  });
  elements.advancedSetupDetails.addEventListener('close', () => {
    elements.btnOpenSettings.focus();
  });
  window.addEventListener('beforeunload', disposeCommunityConnectionUi);
  window.addEventListener('resize', scheduleCommunityPlannerLayout);
  window.addEventListener('scroll', scheduleCommunityPlannerLayout, true);

  elements.btnOpenBible.addEventListener('click', openBibleDialog);
  elements.btnCloseBible.addEventListener('click', closeBibleDialog);
  elements.btnCancelBible.addEventListener('click', closeBibleDialog);
  elements.bibleForm.addEventListener('submit', lookupBiblePassage);
  elements.btnSendBibleLive.addEventListener('click', sendBibleLive);
  elements.btnReturnFromBible.addEventListener('click', returnFromBible);
  elements.bibleReference.addEventListener('input', handleBibleLookupInputChanged);
  elements.bibleTranslation.addEventListener('change', handleBibleLookupInputChanged);
  elements.bibleTargetList.addEventListener('change', updateBibleActions);
  elements.bibleAmbiguityChoices.addEventListener('keydown', handleBibleChoiceKeyboard);
  elements.bibleDialog.addEventListener('cancel', event => {
    event.preventDefault();
    closeBibleDialog();
  });

  elements.btnOpenRemote.addEventListener('click', openRemoteDialog);
  elements.btnOpenRemoteStatus.addEventListener('click', openRemoteDialog);
  elements.btnCloseRemote.addEventListener('click', () => closeRemoteDialog());
  elements.btnDoneRemote.addEventListener('click', () => closeRemoteDialog());
  elements.btnRefreshRemoteInterfaces.addEventListener('click', refreshRemoteBindings);
  elements.btnEnableRemote.addEventListener('click', enableRemoteControl);
  elements.btnRotateRemotePairing.addEventListener('click', rotateRemotePairing);
  elements.btnCreateRemotePairing.addEventListener('click', rotateRemotePairing);
  elements.btnRevokeRemoteDevices.addEventListener('click', revokeRemoteDevices);
  elements.btnRemoteOff.addEventListener('click', turnRemoteOff);
  elements.btnRemoteOffDialog.addEventListener('click', turnRemoteOff);
  elements.remoteInterfaceSelect.addEventListener('change', renderRemoteControl);
  elements.remoteDialog.addEventListener('cancel', event => {
    event.preventDefault();
    closeRemoteDialog();
  });

  // Navigation
  elements.btnPrevSlide.addEventListener('click', () => navigateSlide(-1));
  elements.btnNextSlide.addEventListener('click', () => navigateSlide(1, 'right'));
  elements.btnUnlockVolunteerControls.addEventListener(
    'click',
    unlockVolunteerControls
  );
  elements.btnLockVolunteerControls.addEventListener(
    'click',
    lockVolunteerControls
  );
  
  // Keyboard shortcuts (as backup for global shortcuts)
  document.addEventListener('keydown', handleKeyboard);
  
  elements.thumbnailRoleSelector.addEventListener('click', event => {
    const button = event.target.closest('button[data-role-selection]');
    if (!button) return;
    state.thumbnailSelection = button.dataset.roleSelection;
    renderThumbnails();
    const replacement = [...elements.thumbnailRoleSelector.querySelectorAll('button[data-role-selection]')]
      .find(candidate => candidate.dataset.roleSelection === state.thumbnailSelection);
    replacement?.focus();
  });
  
  // Thumbnail zoom controls
  elements.zoomIn.addEventListener('click', () => adjustThumbnailZoom(10));
  elements.zoomOut.addEventListener('click', () => adjustThumbnailZoom(-10));

  // Singer font size controls
  elements.singerFontUp.addEventListener('click', () => adjustSingerFontSize(2));
  elements.singerFontDown.addEventListener('click', () => adjustSingerFontSize(-2));
  elements.singerFontSize.addEventListener('change', () => {
    const val = Math.max(12, Math.min(240, parseIntegerOr(elements.singerFontSize.value, 36)));
    state.singerFontSize = val;
    elements.singerFontSize.value = val;
    stageProfilePreferencesFromControls();
  });

  // Singer char limit controls
  elements.singerCharLimitUp.addEventListener('click', () => adjustSingerCharLimit(5));
  elements.singerCharLimitDown.addEventListener('click', () => adjustSingerCharLimit(-5));
  elements.singerCharLimit.addEventListener('change', () => {
    const val = Math.max(10, Math.min(500, parseIntegerOr(elements.singerCharLimit.value, 70)));
    state.singerCharLimit = val;
    elements.singerCharLimit.value = val;
    stageProfilePreferencesFromControls();
  });

  // Singer text padding controls
  elements.singerTextPaddingUp.addEventListener('click', () => adjustSingerTextPadding(2));
  elements.singerTextPaddingDown.addEventListener('click', () => adjustSingerTextPadding(-2));
  elements.singerTextPadding.addEventListener('change', () => {
    const val = Math.max(0, Math.min(80, parseIntegerOr(elements.singerTextPadding.value, 4)));
    state.singerTextPadding = val;
    elements.singerTextPadding.value = val;
    stageProfilePreferencesFromControls();
  });

  // View controls (grid/list)
  document.querySelectorAll('.view-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      document.querySelectorAll('.view-btn').forEach(b => b.classList.remove('active'));
      e.target.classList.add('active');
      // Could implement different view modes here
    });
  });
}

function storageBytesLabel(value) {
  if (!Number.isSafeInteger(value) || value < 0) return 'Unknown size';
  if (value < 1024) return `${value.toLocaleString()} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let amount = value;
  let unit = 'B';
  for (const candidate of units) {
    amount /= 1024;
    unit = candidate;
    if (amount < 1024 || candidate === units.at(-1)) break;
  }
  return `${new Intl.NumberFormat(undefined, {
    maximumFractionDigits: amount < 10 ? 1 : 0
  }).format(amount)} ${unit}`;
}

function storageCountAndBytes(count, bytes) {
  const files = `${count.toLocaleString()} ${count === 1 ? 'file' : 'files'}`;
  return `${files} · ${storageBytesLabel(bytes)}`;
}

function normalizeSermonStorageSummary(value) {
  const countFields = [
    'objectCount',
    'objectBytes',
    'referencedObjectCount',
    'referencedBytes',
    'unreferencedObjectCount',
    'unreferencedBytes',
    'waitingObjectCount',
    'waitingBytes',
    'eligibleObjectCount',
    'eligibleBytes'
  ];
  if (
    !value
    || typeof value !== 'object'
    || Array.isArray(value)
    || value.schemaVersion !== 1
    || !Number.isSafeInteger(value.retentionDays)
    || value.retentionDays < 30
    || value.retentionDays > 3650
    || typeof value.auditedAt !== 'string'
    || !Number.isFinite(Date.parse(value.auditedAt))
    || !/^[a-f0-9]{64}$/.test(value.candidateHash || '')
    || countFields.some(field => (
      !Number.isSafeInteger(value[field]) || value[field] < 0
    ))
    || value.objectCount
      !== value.referencedObjectCount + value.unreferencedObjectCount
    || value.objectBytes !== value.referencedBytes + value.unreferencedBytes
    || value.unreferencedObjectCount
      !== value.waitingObjectCount + value.eligibleObjectCount
    || value.unreferencedBytes !== value.waitingBytes + value.eligibleBytes
    || (value.eligibleObjectCount === 0) !== (value.eligibleBytes === 0)
  ) {
    throw new Error('SyncShow returned an invalid private sermon storage summary.');
  }
  const startup = value.startupCleanup;
  const startupCleanup = startup && typeof startup === 'object'
    && !Array.isArray(startup)
    && typeof startup.status === 'string'
    && Number.isSafeInteger(startup.deletedObjectCount)
    && startup.deletedObjectCount >= 0
    && Number.isSafeInteger(startup.deletedBytes)
    && startup.deletedBytes >= 0
    ? {
        status: startup.status,
        causeCode: typeof startup.causeCode === 'string'
          && /^[A-Z][A-Z0-9_]{0,79}$/.test(startup.causeCode)
          ? startup.causeCode
          : null,
        deletedObjectCount: startup.deletedObjectCount,
        deletedBytes: startup.deletedBytes
      }
    : null;
  return {
    schemaVersion: 1,
    auditedAt: new Date(value.auditedAt).toISOString(),
    retentionDays: value.retentionDays,
    objectCount: value.objectCount,
    objectBytes: value.objectBytes,
    referencedObjectCount: value.referencedObjectCount,
    referencedBytes: value.referencedBytes,
    unreferencedObjectCount: value.unreferencedObjectCount,
    unreferencedBytes: value.unreferencedBytes,
    waitingObjectCount: value.waitingObjectCount,
    waitingBytes: value.waitingBytes,
    eligibleObjectCount: value.eligibleObjectCount,
    eligibleBytes: value.eligibleBytes,
    candidateHash: value.candidateHash,
    startupCleanup
  };
}

function renderPrivateSermonStorage() {
  const storage = state.sermonStorage;
  const summary = storage.summary;
  elements.btnCheckSermonStorage.disabled =
    storage.checking || storage.scheduling || storage.scheduled;
  elements.btnCheckSermonStorage.textContent = storage.scheduled
    ? 'Restart to recheck storage'
    : storage.checking
      ? 'Checking private storage…'
      : 'Check private sermon storage';

  if (!summary) {
    elements.sermonStorageSummary.hidden = true;
    elements.btnScheduleSermonStorageCleanup.hidden = true;
    elements.btnScheduleSermonStorageCleanup.disabled = true;
    if (storage.checking) {
      elements.sermonStorageBadge.textContent = 'Checking…';
      elements.sermonStorageStatus.dataset.kind = 'idle';
      elements.sermonStorageStatusTitle.textContent = 'Checking saved references';
      elements.sermonStorageStatusDetail.textContent =
        'SyncShow is verifying private source objects and every saved sermon, service-plan, and extraction reference.';
      elements.sermonStorageActionStatus.textContent =
        'This is a read-only check. No files are being removed.';
    } else if (storage.error) {
      elements.sermonStorageBadge.textContent = 'Check stopped';
      elements.sermonStorageStatus.dataset.kind = 'error';
      elements.sermonStorageStatusTitle.textContent = 'Storage was left unchanged';
      elements.sermonStorageStatusDetail.textContent = storage.error;
      elements.sermonStorageActionStatus.textContent =
        'Run the check again after resolving the storage warning. Removal remains unavailable.';
    } else {
      elements.sermonStorageBadge.textContent = 'Not checked';
      elements.sermonStorageStatus.dataset.kind = 'idle';
      elements.sermonStorageStatusTitle.textContent = 'Storage has not been checked';
      elements.sermonStorageStatusDetail.textContent =
        'Run a read-only check to count protected files and files no longer referenced.';
      elements.sermonStorageActionStatus.textContent =
        'The check never removes files. Unreferenced files must remain continuously unreferenced for at least 90 days before removal can be offered.';
    }
    return;
  }

  elements.sermonStorageSummary.hidden = false;
  elements.sermonStorageTotal.textContent = storageCountAndBytes(
    summary.objectCount,
    summary.objectBytes
  );
  elements.sermonStorageProtected.textContent = storageCountAndBytes(
    summary.referencedObjectCount,
    summary.referencedBytes
  );
  elements.sermonStorageWaiting.textContent = storageCountAndBytes(
    summary.waitingObjectCount,
    summary.waitingBytes
  );
  elements.sermonStorageEligible.textContent = storageCountAndBytes(
    summary.eligibleObjectCount,
    summary.eligibleBytes
  );

  const eligible = summary.eligibleObjectCount > 0
    && summary.eligibleBytes > 0
    && /^[a-f0-9]{64}$/.test(summary.candidateHash);
  elements.btnScheduleSermonStorageCleanup.hidden = !eligible || storage.scheduled;
  elements.btnScheduleSermonStorageCleanup.disabled =
    !eligible || storage.checking || storage.scheduling || storage.scheduled;
  elements.btnScheduleSermonStorageCleanup.textContent = storage.scheduling
    ? 'Scheduling for restart…'
    : 'Remove after restart';

  if (storage.scheduled) {
    elements.sermonStorageBadge.textContent = 'Restart required';
    elements.sermonStorageStatus.dataset.kind = 'attention';
    elements.sermonStorageStatusTitle.textContent = 'Removal is scheduled';
    elements.sermonStorageStatusDetail.textContent =
      'Nothing was removed while SyncShow was open. The exact file set will be checked again during the next startup.';
    elements.sermonStorageActionStatus.textContent = storage.actionMessage;
    return;
  }

  if (eligible) {
    elements.sermonStorageBadge.textContent = 'Review';
    elements.sermonStorageStatus.dataset.kind = 'attention';
    elements.sermonStorageStatusTitle.textContent =
      `${summary.eligibleObjectCount.toLocaleString()} ${summary.eligibleObjectCount === 1 ? 'file is' : 'files are'} eligible`;
    elements.sermonStorageStatusDetail.textContent =
      `These files remained unreferenced through the ${summary.retentionDays}-day wait. Review the count before scheduling restart-only removal.`;
    elements.sermonStorageActionStatus.textContent = storage.actionMessage
      || 'Remove after restart schedules a second full safety check. Nothing is deleted from the running app.';
    return;
  }

  elements.sermonStorageBadge.textContent = 'Checked';
  elements.sermonStorageStatus.dataset.kind = 'ready';
  elements.sermonStorageStatusTitle.textContent = 'No files are ready for removal';
  elements.sermonStorageStatusDetail.textContent = summary.waitingObjectCount > 0
    ? `${summary.waitingObjectCount.toLocaleString()} unreferenced ${summary.waitingObjectCount === 1 ? 'file is' : 'files are'} still inside the ${summary.retentionDays}-day protection period.`
    : 'Every private source file is still protected by saved history.';
  if (storage.actionMessage) {
    elements.sermonStorageActionStatus.textContent = storage.actionMessage;
  } else if (
    summary.startupCleanup?.status === 'applied'
    && summary.startupCleanup.deletedObjectCount > 0
  ) {
    elements.sermonStorageActionStatus.textContent =
      `${storageCountAndBytes(
        summary.startupCleanup.deletedObjectCount,
        summary.startupCleanup.deletedBytes
      )} from a previously confirmed plan were removed safely during this startup.`;
  } else if (summary.startupCleanup?.status === 'safety-check-failed') {
    elements.sermonStorageActionStatus.textContent =
      'A previously scheduled startup cleanup stopped at a safety check. This read-only check succeeded, but no files were removed.';
  } else {
    elements.sermonStorageActionStatus.textContent =
      'No removal is available. Run this check again later if storage use becomes a concern.';
  }
}

async function checkPrivateSermonStorage() {
  if (state.sermonStorage.checking || state.sermonStorage.scheduling) return;
  state.sermonStorage.checking = true;
  state.sermonStorage.error = null;
  state.sermonStorage.actionMessage = '';
  renderPrivateSermonStorage();
  try {
    const result = await window.api.checkPrivateSermonStorage();
    state.sermonStorage.summary = normalizeSermonStorageSummary(result);
  } catch (error) {
    state.sermonStorage.summary = null;
    state.sermonStorage.error = operatorErrorMessage(
      error,
      'SyncShow could not safely check private sermon storage. No files were removed.'
    );
  } finally {
    state.sermonStorage.checking = false;
    renderPrivateSermonStorage();
  }
}

async function schedulePrivateSermonStorageCleanup() {
  const summary = state.sermonStorage.summary;
  if (
    state.sermonStorage.checking
    || state.sermonStorage.scheduling
    || state.sermonStorage.scheduled
    || !summary
    || summary.eligibleObjectCount < 1
    || summary.eligibleBytes < 1
    || !/^[a-f0-9]{64}$/.test(summary.candidateHash)
  ) {
    return;
  }
  const quantity = storageCountAndBytes(
    summary.eligibleObjectCount,
    summary.eligibleBytes
  );
  const confirmed = window.confirm(
    `Schedule ${quantity} for removal after SyncShow restarts? Nothing will be removed now. On the next startup, SyncShow will recover pending work and recheck the exact file set before deleting anything.`
  );
  if (!confirmed) return;

  state.sermonStorage.scheduling = true;
  state.sermonStorage.error = null;
  state.sermonStorage.actionMessage = '';
  renderPrivateSermonStorage();
  try {
    const result = await window.api.schedulePrivateSermonStorageCleanup({
      candidateHash: summary.candidateHash,
      confirmed: true
    });
    if (
      !result
      || result.scheduled !== true
      || result.requiresRestart !== true
      || result.candidateHash !== summary.candidateHash
      || result.eligibleObjectCount !== summary.eligibleObjectCount
      || result.eligibleBytes !== summary.eligibleBytes
    ) {
      throw new Error('SyncShow did not confirm the restart cleanup plan.');
    }
    state.sermonStorage.scheduled = true;
    state.sermonStorage.actionMessage =
      `${quantity} ${summary.eligibleObjectCount === 1 ? 'is' : 'are'} scheduled for the next startup. Nothing was removed while SyncShow remained open.`;
  } catch (error) {
    state.sermonStorage.summary = null;
    state.sermonStorage.error = operatorErrorMessage(
      error,
      'The restart cleanup could not be scheduled. No files were removed.'
    );
  } finally {
    state.sermonStorage.scheduling = false;
    renderPrivateSermonStorage();
  }
}

function activatePrepareAddTab(tabId, { focusTab = false } = {}) {
  const requestedTab = typeof tabId === 'string' ? tabId : '';
  const activeTab = elements.prepareAddTabs.find(
    tab => tab.dataset.prepareAddTab === requestedTab
  ) || elements.prepareAddTabs[0];
  if (!activeTab) return;

  const activeTabId = activeTab.dataset.prepareAddTab;
  state.prepareAddTab = activeTabId;
  elements.prepareAddTabs.forEach(tab => {
    const selected = tab === activeTab;
    tab.setAttribute('aria-selected', String(selected));
    tab.tabIndex = selected ? 0 : -1;
  });
  elements.prepareAddPanels.forEach(panel => {
    panel.hidden = panel.dataset.prepareAddPanel !== activeTabId;
  });
  if (focusTab) activeTab.focus();
}

function handlePrepareAddTabKeydown(event) {
  const tabs = elements.prepareAddTabs;
  const currentIndex = tabs.indexOf(event.currentTarget);
  if (currentIndex < 0) return;

  let nextIndex = currentIndex;
  if (event.key === 'ArrowRight') nextIndex = (currentIndex + 1) % tabs.length;
  else if (event.key === 'ArrowLeft') nextIndex = (currentIndex - 1 + tabs.length) % tabs.length;
  else if (event.key === 'Home') nextIndex = 0;
  else if (event.key === 'End') nextIndex = tabs.length - 1;
  else return;

  event.preventDefault();
  activatePrepareAddTab(tabs[nextIndex].dataset.prepareAddTab, { focusTab: true });
}

function activateLoadMode(mode, { focusTab = false } = {}) {
  const activeTab = elements.loadModeTabs.find(tab => tab.dataset.loadTab === mode)
    || elements.loadModeTabs[0];
  if (!activeTab) return;
  state.loadMode = activeTab.dataset.loadTab;
  elements.loadModeTabs.forEach(tab => {
    const selected = tab === activeTab;
    tab.classList.toggle('is-active', selected);
    tab.setAttribute('aria-selected', String(selected));
    tab.tabIndex = selected ? 0 : -1;
  });
  elements.loadModePanels.forEach(panel => {
    panel.hidden = panel.dataset.loadPanel !== state.loadMode;
  });
  placeServiceInputCards();
  if (state.loadMode === 'syncshow') refreshLoadLocalServices();
  if (focusTab) activeTab.focus();
}

function handleLoadModeKeydown(event) {
  const currentIndex = elements.loadModeTabs.indexOf(event.currentTarget);
  if (currentIndex < 0) return;
  let nextIndex = currentIndex;
  if (event.key === 'ArrowRight') nextIndex = (currentIndex + 1) % elements.loadModeTabs.length;
  else if (event.key === 'ArrowLeft') nextIndex = (currentIndex - 1 + elements.loadModeTabs.length) % elements.loadModeTabs.length;
  else if (event.key === 'Home') nextIndex = 0;
  else if (event.key === 'End') nextIndex = elements.loadModeTabs.length - 1;
  else return;
  event.preventDefault();
  activateLoadMode(elements.loadModeTabs[nextIndex].dataset.loadTab, { focusTab: true });
}

function renderLoadLocalServices() {
  elements.loadLocalServiceList.replaceChildren();
  if (state.loadLocalServices.busy) {
    elements.loadLocalServiceList.appendChild(
      createElement('p', 'local-service-empty', 'Loading saved services…')
    );
    return;
  }
  if (state.loadLocalServices.error) {
    elements.loadLocalServiceList.appendChild(
      createElement('p', 'local-service-empty is-error', state.loadLocalServices.error)
    );
    return;
  }
  if (state.loadLocalServices.items.length === 0) {
    elements.loadLocalServiceList.appendChild(
      createElement('p', 'local-service-empty', 'No SyncShow services are saved here yet. Import a file or start in Prepare.')
    );
    return;
  }
  for (const project of state.loadLocalServices.items) {
    const row = createElement('div', 'local-service-row');
    row.dataset.projectId = project.id;
    row.setAttribute('role', 'listitem');
    const copy = createElement('span', 'local-service-row-copy');
    copy.append(
      createElement('strong', '', project.title || 'Untitled service'),
      createElement(
        'small',
        '',
        [
          formatServiceDate(project.serviceDate),
          `version ${project.revision}`,
          project.planning?.status ? planningStatusLabel(project.planning.status) : 'Saved locally'
        ].filter(Boolean).join(' · ')
      )
    );
    const actions = createElement('span', 'local-service-row-actions');
    const loadButton = createElement('button', 'btn btn-primary btn-compact', 'Load');
    loadButton.type = 'button';
    loadButton.addEventListener('click', () => loadLocalService(project, loadButton));
    const editButton = createElement('button', 'btn btn-quiet btn-compact', 'Edit');
    editButton.type = 'button';
    editButton.addEventListener('click', () => openLocalServiceInPrepare(project.id));
    actions.append(loadButton, editButton);
    row.append(copy, actions);
    elements.loadLocalServiceList.appendChild(row);
  }
}

async function refreshLoadLocalServices() {
  if (state.loadLocalServices.busy || typeof window.api?.listServiceProjects !== 'function') return;
  state.loadLocalServices.busy = true;
  state.loadLocalServices.error = null;
  renderLoadLocalServices();
  try {
    const result = await window.api.listServiceProjects({
      query: '',
      pageSize: 8,
      offset: 0
    });
    state.loadLocalServices.items = Array.isArray(result?.items) ? result.items : [];
  } catch (error) {
    state.loadLocalServices.items = [];
    state.loadLocalServices.error = operatorErrorMessage(
      error,
      'Saved services could not be listed.'
    );
  } finally {
    state.loadLocalServices.busy = false;
    renderLoadLocalServices();
  }
}

async function openLocalServiceInPrepare(projectId) {
  await setWorkflowStage('prepare', { localTools: true });
  await prepareController?.openProjectById?.(projectId);
}

async function loadLocalService(project, button) {
  if (!project?.id || !project?.revisionId || button.disabled) return;
  button.disabled = true;
  const previousLabel = button.textContent;
  button.textContent = 'Loading…';
  setStatus(`Preparing ${project.title || 'saved service'} for offline Show…`);
  try {
    const result = await window.api.publishServiceProject({
      projectId: project.id,
      revisionId: project.revisionId
    });
    await refreshPublishedProject(result, { project });
  } catch (error) {
    console.error('[Load] Saved SyncShow service could not be loaded:', error);
    setStatus(`Could not load ${project.title || 'that service'}: ${operatorErrorMessage(
      error,
      'Review it in Prepare and try again.'
    )}`);
  } finally {
    button.disabled = false;
    button.textContent = previousLabel;
  }
}

async function openLoadedServiceInPrepare() {
  const projectId = state.serviceHandoff?.project?.id;
  if (!projectId) return;
  await openLocalServiceInPrepare(projectId);
}

function activateSettingsTab(tabId, { focusTab = false } = {}) {
  const requestedTab = typeof tabId === 'string' ? tabId : '';
  const activeTab = elements.adminSettingsTabs.find(
    tab => tab.dataset.settingsTab === requestedTab
  ) || elements.adminSettingsTabs[0];
  if (!activeTab) return;

  const activeTabId = activeTab.dataset.settingsTab;
  state.settingsTab = activeTabId;
  elements.adminSettingsTabs.forEach(tab => {
    const selected = tab === activeTab;
    tab.setAttribute('aria-selected', String(selected));
    tab.tabIndex = selected ? 0 : -1;
  });
  elements.adminSettingsPanels.forEach(panel => {
    panel.hidden = panel.dataset.settingsPanel !== activeTabId;
  });
  if (focusTab) activeTab.focus();
}

function handleSettingsTabKeydown(event) {
  const tabs = elements.adminSettingsTabs;
  const currentIndex = tabs.indexOf(event.currentTarget);
  if (currentIndex < 0) return;

  let nextIndex = currentIndex;
  if (event.key === 'ArrowRight') nextIndex = (currentIndex + 1) % tabs.length;
  else if (event.key === 'ArrowLeft') nextIndex = (currentIndex - 1 + tabs.length) % tabs.length;
  else if (event.key === 'Home') nextIndex = 0;
  else if (event.key === 'End') nextIndex = tabs.length - 1;
  else return;

  event.preventDefault();
  activateSettingsTab(tabs[nextIndex].dataset.settingsTab, { focusTab: true });
}

function openSettings(tabId = state.settingsTab) {
  activateSettingsTab(tabId);
  refreshCommunityStatus();
  if (elements.advancedSetupDetails.open) return;
  if (!state.advancedWarningAcknowledged) {
    state.advancedWarningAction = 'open-admin';
    elements.btnCancelAdvanced.textContent = 'Go back';
    elements.btnConfirmAdvanced.textContent = 'Open Admin Settings';
    elements.advancedWarningDialog.showModal();
    return;
  }
  elements.advancedSetupDetails.showModal();
  window.setTimeout(() => elements.btnCloseAdminSettings.focus(), 80);
}

function closeSettings() {
  if (!elements.advancedSetupDetails.open) return;
  if (state.profileDirty) {
    elements.profileEditorStatus.textContent = 'Save or discard the venue changes before closing Admin Settings.';
    elements.btnSaveProfile.focus();
    return;
  }
  elements.advancedSetupDetails.close();
}

function applyFriendlyMode() {
  document.body.classList.toggle('friendly-mode', state.friendlyMode);
  elements.friendlyMode.checked = state.friendlyMode;
  renderLoadSourceSummary();
  if (state.profile) checkReadyState();
}

function handleFriendlyModeChange() {
  if (state.profileSaveInFlight) {
    elements.friendlyMode.checked = state.friendlyMode;
    setStatus('Wait for the venue profile to finish saving');
    return;
  }
  if (elements.friendlyMode.checked) {
    if (state.profileDirty) {
      elements.friendlyMode.checked = false;
      elements.profileEditorStatus.textContent = 'Save or discard the venue changes before turning Friendly Mode back on.';
      setStatus('Venue setup changes are still waiting to be saved or discarded');
      return;
    }
    state.friendlyMode = true;
    applyFriendlyMode();
    persistFriendlyPreference();
    return;
  }

  // Keep the safe mode active until the operator explicitly confirms. Native
  // <dialog> provides focus trapping and Escape handling for keyboard users.
  if (!state.advancedWarningAcknowledged) {
    state.advancedWarningAction = 'disable-friendly';
    elements.friendlyMode.checked = true;
    elements.btnCancelAdvanced.textContent = 'Keep Friendly Mode';
    elements.btnConfirmAdvanced.textContent = 'Show advanced Load details';
    elements.advancedWarningDialog.showModal();
    return;
  }

  state.friendlyMode = false;
  applyFriendlyMode();
  persistFriendlyPreference();
}

function cancelAdvancedMode() {
  const action = state.advancedWarningAction;
  state.advancedWarningAction = null;
  if (action === 'disable-friendly') {
    state.friendlyMode = true;
    applyFriendlyMode();
  }
  elements.advancedWarningDialog.close();
  (action === 'open-admin' ? elements.btnOpenSettings : elements.friendlyMode).focus();
}

function confirmAdvancedMode() {
  const action = state.advancedWarningAction;
  state.advancedWarningAction = null;
  state.advancedWarningAcknowledged = true;
  elements.advancedWarningDialog.close();
  if (action === 'open-admin') {
    persistFriendlyPreference();
    elements.advancedSetupDetails.showModal();
    window.setTimeout(() => elements.btnCloseAdminSettings.focus(), 80);
    return;
  }
  state.friendlyMode = false;
  applyFriendlyMode();
  persistFriendlyPreference();
  elements.friendlyMode.focus();
}

function updateWorkflowNavigationAvailability() {
  const liveShowSession = state.workflowStage === 'show'
    && Boolean(state.isPresenting || state.activeLaunchPlan);
  elements.btnStagePrepare.disabled = liveShowSession;
  elements.btnStageLoad.disabled = liveShowSession;
  elements.btnStageShow.disabled = state.workflowStage !== 'show'
    && !state.isPresenting
    && !state.activeLaunchPlan;
}

function setWorkflowStage(stage) {
  const activationOptions = arguments[1] && typeof arguments[1] === 'object'
    ? arguments[1]
    : undefined;
  if (!['prepare', 'load', 'show'].includes(stage)) return Promise.resolve(false);
  state.workflowStage = stage;
  for (const candidate of ['prepare', 'load', 'show']) {
    document.body.classList.toggle(`${candidate}-stage`, candidate === stage);
  }

  const stageButtons = {
    prepare: elements.btnStagePrepare,
    load: elements.btnStageLoad,
    show: elements.btnStageShow
  };
  for (const [candidate, button] of Object.entries(stageButtons)) {
    const active = candidate === stage;
    button.classList.toggle('active', active);
    if (active) button.setAttribute('aria-current', 'step');
    else button.removeAttribute('aria-current');
  }

  const stageLabels = {
    prepare: { title: 'SyncShow — Prepare', subtitle: 'Plan the service' },
    load: { title: 'SyncShow — Load', subtitle: 'Load today’s service' },
    show: { title: 'SyncShow — Show', subtitle: 'Control the live service' }
  };
  document.title = stageLabels[stage].title;
  elements.appSubtitle.textContent = stageLabels[stage].subtitle;
  updateWorkflowNavigationAvailability();

  let activation = Promise.resolve(true);
  if (stage === 'prepare') {
    const requestedMode = activationOptions?.localTools === true
      ? 'local'
      : communityIsConnected()
        ? state.prepareMode
        : 'local';
    activation = activatePrepareMode(requestedMode, activationOptions);
  } else if (stage === 'load') {
    scheduleCommunityPlannerLayout();
    resumeServiceFolderScanOnLoad();
    activateLoadMode(state.loadMode);
  } else {
    scheduleCommunityPlannerLayout();
  }
  return activation;
}

async function navigateWorkflowStage(stage) {
  if (stage === state.workflowStage) {
    if (stage === 'prepare' && state.prepareMode === 'community') {
      await openCommunityPrepare();
    }
    return;
  }
  if (state.workflowStage === 'prepare' && prepareController?.isBusy?.()) {
    setStatus('Wait for the current Prepare change to finish before leaving this screen');
    return;
  }
  if (state.workflowStage === 'show' && (state.isPresenting || state.activeLaunchPlan)) {
    setStatus('Use the Show finish action to end the live session safely');
    elements.btnBackToSetup.focus();
    return;
  }
  if (stage === 'show') {
    if (!state.isPresenting && !state.activeLaunchPlan) {
      setStatus('Load the service and choose Start Show before opening live controls');
      elements.btnStartPresentation.focus();
      return;
    }
    setWorkflowStage('show');
    return;
  }

  setWorkflowStage(stage);
}

async function loadAppState() {
  try {
    // Profile names and role IDs define the rest of the renderer, so load the
    // validated main-process profile before asking for runtime presentation
    // state or caches.
    await loadSavedSettings();
    const appState = await window.api.getAppState();
    state.currentSlide = appState.currentSlide;
    state.totalSlides = appState.totalSlides;
    state.displays = appState.displays;
    applyServiceHandoff(appState.serviceHandoff);
    state.preparedServiceRestore = appState.preparedServiceRestore || {
      status: 'none'
    };
    applyRuntimePresentationState(appState.presentations);
    if (appState.showState) handleShowStateChanged(appState.showState);
    renderInputCards();
    await loadSlidesIfNeeded();
    renderThumbnails();
    renderProfileEditor();
    renderOutputHealth();
    checkReadyState();

    // Check for cached presentations from previous session
    await checkForCachedPresentations();
    renderPreparedServiceRestoreStatus();
  } catch (error) {
    console.error('Failed to load app state:', error);
  }
}

function renderPreparedServiceRestoreStatus() {
  const status = String(state.preparedServiceRestore?.status || 'none');
  if (status === 'restored') {
    const title = state.serviceHandoff?.project?.title || 'The prepared service';
    setStatus(`${title} was restored and is ready in Load`);
    return;
  }
  if (status === 'incompatible') {
    setStatus(
      'The prepared service was kept, but it was made for a different venue setup. Open that service in Prepare and choose Save & go to Load again.'
    );
    return;
  }
  if (status === 'corrupt') {
    setStatus(
      'The prepared service could not be verified. Open its saved project in Prepare and choose Save & go to Load again.'
    );
  }
}

function applyRuntimePresentationState(presentations = {}, options = {}) {
  for (const role of getDeckRoles()) {
    const summary = presentations?.[role.id];
    if (!summary?.loaded || !(summary.slideCount > 0)) {
      state.presentations[role.id] = emptyPresentation();
      continue;
    }
    const previous = options.replaceSource
      ? emptyPresentation()
      : (state.presentations[role.id] || emptyPresentation());
    const sameSlideCount = previous.loaded && previous.slideCount === summary.slideCount;
    state.presentations[role.id] = {
      ...previous,
      loaded: true,
      pending: false,
      path: previous.path || null,
      displayPath: previous.displayPath
        || summary.displayName
        || summary.label
        || options.displayName
        || 'Prepared service',
      prepared: previous.prepared === true || !previous.path,
      source: options.replaceSource
        ? 'prepared'
        : (previous.source && previous.source !== 'none'
          ? previous.source
          : (!previous.path ? 'prepared' : 'restored')),
      slideCount: summary.slideCount,
      cacheDir: summary.cacheDir || previous.cacheDir || null,
      slides: sameSlideCount && Array.isArray(previous.slides) ? previous.slides : []
    };
  }
}

function applyServiceHandoff(rawHandoff) {
  const previousKey = state.serviceHandoff
    ? `${state.serviceHandoff.project.id}:${state.serviceHandoff.project.revisionId}`
    : null;
  if (rawHandoff === null || rawHandoff === undefined) {
    state.serviceHandoff = null;
  } else {
    try {
      const normalize = window.SyncShowServiceHandoff?.normalizeServiceHandoff;
      if (typeof normalize !== 'function') {
        throw new Error('Service handoff validation is unavailable.');
      }
      state.serviceHandoff = normalize(rawHandoff);
    } catch (error) {
      console.warn('[ServiceHandoff] Ignoring an invalid runtime handoff:', error);
      state.serviceHandoff = null;
    }
  }
  const nextKey = state.serviceHandoff
    ? `${state.serviceHandoff.project.id}:${state.serviceHandoff.project.revisionId}`
    : null;
  if (previousKey !== nextKey) state.postShowOutcome = null;
  renderLoadServiceHandoff();
  renderShowCueContext();
}

function planningStatusLabel(status) {
  return {
    planning: 'Planning',
    ready: 'Ready',
    completed: 'Completed',
    'needs-follow-up': 'Needs follow-up'
  }[status] || 'Reviewed';
}

function formatServiceStartTime(value) {
  const match = typeof value === 'string'
    ? value.match(/^([01]\d|2[0-3]):([0-5]\d)$/)
    : null;
  if (!match) return '';
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  const suffix = hour >= 12 ? 'PM' : 'AM';
  return `${hour % 12 || 12}:${String(minute).padStart(2, '0')} ${suffix}`;
}

function formatRunSheetDuration(value) {
  if (!Number.isSafeInteger(value) || value < 0) return '';
  if (value === 0) return '0 sec';
  const hours = Math.floor(value / 3600);
  const minutes = Math.floor((value % 3600) / 60);
  const seconds = value % 60;
  return [
    hours ? `${hours} hr` : '',
    minutes ? `${minutes} min` : '',
    seconds ? `${seconds} sec` : ''
  ].filter(Boolean).join(' ');
}

function formatRunSheetClock(value) {
  if (!value || typeof value.time !== 'string') return '';
  const time = formatServiceStartTime(value.time.slice(0, 5));
  if (!time) return '';
  if (value.dayOffset === 1) return `${time} next day`;
  if (Number.isSafeInteger(value.dayOffset) && value.dayOffset > 1) {
    return `${time} · ${value.date}`;
  }
  return time;
}

function summarizeHandoffServing(rawServing) {
  const assignments = Array.isArray(rawServing?.assignments)
    ? rawServing.assignments
    : [];
  const filled = assignments.filter(assignment =>
    ['assigned', 'confirmed'].includes(assignment.status));
  const open = assignments.filter(assignment =>
    assignment.status === 'open');
  const declined = assignments.filter(assignment =>
    assignment.status === 'declined');
  const requiredOpen = [...open, ...declined].filter(assignment =>
    assignment.required);
  return {
    assignments,
    filled,
    open,
    declined,
    requiredOpen
  };
}

function runSheetLoadSummary(runSheet) {
  if (!runSheet) return '';
  if (!runSheet.complete) {
    const enteredSeconds = runSheet.rows
      .filter(row => row.depth === 0 && row.effectiveDurationSeconds !== null)
      .reduce((total, row) => total + row.effectiveDurationSeconds, 0);
    const entered = enteredSeconds > 0
      ? `${formatRunSheetDuration(enteredSeconds)} entered`
      : 'No durations entered';
    const missing = runSheet.missingItemIds.length;
    return `Run sheet: ${entered} · ${missing} ${
      missing === 1 ? 'moment' : 'moments'
    } untimed · finish unknown.`;
  }
  const parts = [
    `Run sheet: ${formatRunSheetDuration(runSheet.totalDurationSeconds)}`,
    `expected finish ${formatRunSheetClock(runSheet.expectedFinish)}`
  ];
  if (!runSheet.breakdownComplete) {
    const count = runSheet.unestimatedItemIds.length;
    parts.push(`${count} internal ${count === 1 ? 'moment' : 'moments'} untimed`);
  }
  if (runSheet.overruns.length > 0) {
    const count = runSheet.overruns.length;
    parts.push(`${count} ${count === 1 ? 'section is' : 'sections are'} over budget`);
  }
  return `${parts.join(' · ')}.`;
}

function servingLoadSummary(rawServing) {
  const summary = summarizeHandoffServing(rawServing);
  if (summary.assignments.length === 0) return '';
  const counts = [
    `${summary.filled.length} filled`,
    `${summary.open.length} open`
  ];
  if (summary.requiredOpen.length > 0) {
    counts.push(`${summary.requiredOpen.length} required open`);
  }
  if (summary.declined.length > 0) {
    counts.push(`${summary.declined.length} declined`);
  }
  const people = summary.filled.slice(0, 4).map(assignment =>
    `${assignment.role} — ${assignment.personName}`);
  if (summary.filled.length > people.length) {
    people.push(`+${summary.filled.length - people.length} more`);
  }
  const sentence = `Serving team: ${counts.join(' · ')}${
    people.length > 0 ? `. ${people.join('; ')}` : ''
  }`;
  return /[.!?]$/u.test(sentence) ? sentence : `${sentence}.`;
}

function renderLoadServiceHandoff() {
  const handoff = state.serviceHandoff;
  elements.loadServiceHandoff.hidden = !handoff;
  placeServiceInputCards();
  if (!handoff) return;

  const planning = handoff.planning;
  const schedule = [
    formatServiceDate(handoff.project.serviceDate),
    planning?.startTime ? formatServiceStartTime(planning.startTime) : '',
    `${handoff.cueIds.length} ${handoff.cueIds.length === 1 ? 'cue' : 'cues'}`,
    `exact revision ${handoff.project.revision}`
  ].filter(Boolean);
  elements.loadServiceHandoffTitle.textContent = handoff.project.title;
  elements.loadServiceHandoffSchedule.textContent = schedule.join(' · ');
  elements.loadServiceHandoffBadge.textContent = planning
    ? planningStatusLabel(state.postShowOutcome?.status || planning.status)
    : 'Verified package';
  elements.loadServiceHandoffNotes.hidden = !planning?.teamNotes;
  elements.loadServiceHandoffNotes.textContent = planning?.teamNotes
    ? `Team note: ${planning.teamNotes}`
    : '';
  let hasReviewDetails = Boolean(planning?.teamNotes);
  if (elements.loadServiceHandoffRunSheet) {
    const runSheetSummary = runSheetLoadSummary(handoff.runSheet);
    elements.loadServiceHandoffRunSheet.hidden = !runSheetSummary;
    elements.loadServiceHandoffRunSheet.textContent = runSheetSummary;
    hasReviewDetails = hasReviewDetails || Boolean(runSheetSummary);
  }
  if (elements.loadServiceHandoffTeam) {
    const teamSummary = servingLoadSummary(planning?.serving);
    elements.loadServiceHandoffTeam.hidden = !teamSummary;
    elements.loadServiceHandoffTeam.textContent = teamSummary;
    hasReviewDetails = hasReviewDetails || Boolean(teamSummary);
  }

  const waivers = planning?.readinessWaivers || [];
  const readinessSummary = waivers.length > 0
    ? `Reviewed ${waivers.length} ${waivers.length === 1 ? 'exception' : 'exceptions'}: ${
        waivers.map(waiver => waiver.reason).join(' · ')
      }`
    : '';
  const outcomeSummary = state.postShowOutcome
    ? ` After Show, the local plan was marked ${planningStatusLabel(
        state.postShowOutcome.status
      )} in a newer revision.`
    : '';
  const reviewText = `${readinessSummary}${outcomeSummary}`.trim();
  elements.loadServiceHandoffReview.hidden = !reviewText;
  elements.loadServiceHandoffReview.textContent = reviewText;
  hasReviewDetails = hasReviewDetails || Boolean(reviewText);
  elements.loadServiceReviewDetails.hidden = !hasReviewDetails;
}

function placeServiceInputCards() {
  const preparedService = Boolean(state.serviceHandoff)
    || Object.values(state.presentations).some(
      presentation => presentation?.loaded && presentation?.source === 'prepared'
    );
  const loadingLegacyPptx = state.workflowStage === 'load'
    && state.loadMode === 'pptx';
  const target = preparedService && !loadingLegacyPptx
    ? elements.inputCardsHostScreens
    : elements.inputCardsHostLoad;
  if (elements.inputCards.parentElement !== target) target.appendChild(elements.inputCards);
  elements.inputCardsHostScreens.hidden = target !== elements.inputCardsHostScreens;
  elements.inputCardsHostLoad.hidden = target !== elements.inputCardsHostLoad;
}

function handoffCueAt(index) {
  if (!state.serviceHandoff || !Number.isInteger(index) || index < 0) return null;
  const cueId = state.serviceHandoff.cueIds[index];
  return cueId ? state.serviceHandoff.cues[cueId] || null : null;
}

function legacyCueAt(index) {
  if (!Number.isInteger(index) || index < 0) return null;
  const preferredRole = state.activeLaunchPlan?.timelineRoleId;
  const roleIds = [
    preferredRole,
    ...getDeckRoles().map(role => role.id)
  ].filter((roleId, candidateIndex, roleList) =>
    roleId && roleList.indexOf(roleId) === candidateIndex
  );
  for (const roleId of roleIds) {
    const slide = state.presentations[roleId]?.slides?.[index];
    if (!slide) continue;
    const firstLine = String(slide.text || '')
      .split(/\r?\n/u)
      .map(line => line.trim())
      .find(Boolean) || '';
    return {
      title: slide.title || firstLine || `Slide ${index + 1}`,
      kind: slide.kind || '',
      groupPath: Array.isArray(slide.groupPath) ? slide.groupPath : [],
      operatorNotes: slide.operatorNotes || ''
    };
  }
  return null;
}

function cueAt(index) {
  return handoffCueAt(index) || legacyCueAt(index);
}

function renderShowCueContext() {
  if (!elements.showCueContext) return;
  const current = cueAt(state.currentSlide);
  const next = cueAt(state.currentSlide + 1);
  const currentNumber = Math.max(1, state.currentSlide + 1);
  const kind = current?.kind
    ? `${current.kind.charAt(0).toUpperCase()}${current.kind.slice(1)}`
    : 'Current cue';
  const groupPath = current?.groupPath?.length
    ? current.groupPath.join(' › ')
    : '';

  elements.showCueContextPath.textContent = groupPath || `${kind} ${currentNumber}`;
  elements.showCueContextTitle.textContent = current?.title
    || (state.totalSlides > 0 ? `Slide ${currentNumber}` : 'Waiting for the service');
  if (elements.showCueContextMeta) {
    const handoff = state.serviceHandoff;
    const row = current?.itemId
      ? handoff?.runSheet?.rows.find(candidate =>
          candidate.itemId === current.itemId)
      : null;
    const meta = [];
    if (row?.start) {
      meta.push(`Scheduled ${formatRunSheetClock(row.start)}`);
    }
    if (row?.effectiveDurationSeconds !== null
      && row?.effectiveDurationSeconds !== undefined) {
      meta.push(`Slot ${formatRunSheetDuration(row.effectiveDurationSeconds)}`);
    }
    const itemPathIds = Array.isArray(current?.itemPathIds)
      ? current.itemPathIds
      : current?.itemId
        ? [current.itemId]
        : [];
    const relevantAssignments = summarizeHandoffServing(
      handoff?.planning?.serving
    ).assignments.filter(assignment =>
      assignment.scope.kind === 'service'
      || itemPathIds.includes(assignment.scope.itemId));
    const assignmentLabels = relevantAssignments.slice(0, 3).map(assignment =>
      `${assignment.role}: ${
        ['assigned', 'confirmed'].includes(assignment.status)
          ? assignment.personName
          : assignment.status === 'declined'
            ? `${assignment.personName} declined`
            : assignment.required
              ? 'open · required'
              : 'open'
      }`);
    meta.push(...assignmentLabels);
    if (relevantAssignments.length > assignmentLabels.length) {
      meta.push(`+${relevantAssignments.length - assignmentLabels.length} more assignments`);
    }
    elements.showCueContextMeta.hidden = meta.length === 0;
    elements.showCueContextMeta.textContent = meta.join(' · ');
  }
  elements.showCueContextNote.hidden = !current?.operatorNotes;
  elements.showCueContextNote.textContent = current?.operatorNotes
    ? `Operator note: ${current.operatorNotes}`
    : '';
  elements.showCueContextNext.textContent = next?.title
    || (state.totalSlides > 0 && state.currentSlide >= state.totalSlides - 1
      ? 'End of service'
      : '—');
  renderShowFinishAction();
}

function renderShowFinishAction() {
  const atFinalCue = state.totalSlides > 0
    && state.currentSlide >= state.totalSlides - 1;
  elements.btnBackToSetup.textContent = state.showEndSessionBusy
    ? 'Finishing service…'
    : atFinalCue
      ? 'Finish service…'
      : 'Back to Load';
  elements.btnBackToSetup.title = atFinalCue
    ? 'End outputs safely, return to Load, and review the exact service handoff'
    : 'Stop outputs and return to the Load screen';
  elements.btnBackToSetup.setAttribute(
    'aria-label',
    atFinalCue
      ? 'Finish service and return safely to Load'
      : 'Back to Load'
  );
}

async function refreshPublishedProject(_publishResult, context = {}) {
  try {
    resetServiceOutputChoices();
    state.presentationConversionRecovery = {};
    const appState = await window.api.getAppState();
    state.currentSlide = appState.currentSlide;
    state.totalSlides = appState.totalSlides;
    state.displays = appState.displays;
    applyServiceHandoff(appState.serviceHandoff);
    state.preparedServiceRestore = appState.preparedServiceRestore || {
      status: 'none'
    };
    applyRuntimePresentationState(appState.presentations, {
      displayName: context.project?.title || 'Prepared service',
      replaceSource: true
    });
    state.serviceFolder.staleRoleIds = [];
    if (appState.showState) handleShowStateChanged(appState.showState);
    renderInputCards();
    await loadSlidesIfNeeded();
    renderThumbnails();
    renderProfileEditor();
    renderOutputHealth();
    checkReadyState();
    refreshLoadLocalServices();
    setStatus(`${context.project?.title || 'Prepared service'} is ready in Load`);
  } catch (error) {
    console.error('[Prepare] Published service could not be refreshed in Load:', error);
    setStatus(`The service was prepared, but Load could not refresh: ${error.message}`);
  } finally {
    setWorkflowStage('load');
  }
}

// Load saved user settings
async function loadSavedSettings() {
  state.isApplyingSettings = true;
  try {
    const settings = await window.api.loadSettings();
    applyCommittedProfile(settings.venueProfile);
    state.profileRecoveryWarning = settings.recoveryWarning || null;
    if (state.profileRecoveryWarning) setStatus(state.profileRecoveryWarning);
    console.log('[Settings] Loaded saved settings:', settings);
  } catch (error) {
    console.error('Failed to load saved settings:', error);
    setStatus(`Could not load the venue profile: ${error.message}`);
  } finally {
    state.isApplyingSettings = false;
  }
}

function applyCommittedProfile(profile) {
  resetServiceOutputChoices();
  state.profile = cloneValue(profile);
  state.profileDraft = cloneValue(profile);
  state.profileDirty = false;
  syncProfileDraftCloseState();
  state.friendlyMode = profile.friendlyModeDefault !== false;
  state.advancedWarningAcknowledged = profile.operator?.advancedWarningAcknowledged === true;
  if (!state.serviceFolder.requestedDate) {
    state.serviceFolder.requestedDate = serviceDateForProfile(profile);
    elements.serviceFolderDate.value = state.serviceFolder.requestedDate;
  }

  const nextPresentations = {};
  const activeRoleIds = new Set();
  for (const role of getDeckRoles(profile)) {
    activeRoleIds.add(role.id);
    nextPresentations[role.id] = state.presentations[role.id] || emptyPresentation();
  }
  state.presentations = nextPresentations;
  state.presentationConversionRecovery = Object.fromEntries(
    Object.entries(state.presentationConversionRecovery)
      .filter(([roleId]) => activeRoleIds.has(roleId))
  );
  state.serviceFolder.staleRoleIds = [...new Set(state.serviceFolder.staleRoleIds)]
    .filter(roleId => activeRoleIds.has(roleId));

  applyProfilePreferencesToControls(profile);
  applyFriendlyMode();
  renderInputCards();
  renderProfileEditor();
  renderOutputHealth();
  renderServiceFolder();
  checkReadyState();
}

function applyProfilePreferencesToControls(profile) {
  state.thumbnailZoom = profile.operator?.thumbnailZoomPercent || 100;
  state.singerFontSize = profile.singer?.fontSizePx || 36;
  state.singerCharLimit = profile.singer?.charLimit || 70;
  state.singerTextPadding = profile.singer?.textPaddingPx ?? 4;
  setSelectValuePreservingCustomOption(
    elements.fadeDuration,
    profile.transition?.fadeDurationMs ?? 300,
    value => `Custom (${value}ms)`
  );
  elements.syncMode.checked = profile.transition?.syncMode === true;
  elements.singerFontSize.value = state.singerFontSize;
  elements.singerCharLimit.value = state.singerCharLimit;
  elements.singerTextPadding.value = state.singerTextPadding;
  populateSingerSourceOptions(profile.singer?.fallbackSourceRoleId);
  applyThumbnailZoom();
}

function queueProfilePreferenceSave(update, label) {
  if (!state.profile || state.isApplyingSettings || state.profileDirty) return false;
  if (state.profileRecoveryWarning) {
    setStatus(`${label} will be saved after the venue profile is repaired`);
    return false;
  }

  update(state.profile);
  update(state.profileDraft);
  const revision = ++profilePreferenceRevision;
  const snapshot = cloneValue(state.profile);
  profilePreferenceSaveQueue = profilePreferenceSaveQueue
    .catch(() => {})
    .then(async () => {
      const result = await window.api.saveSettings({ venueProfile: snapshot });
      if (!result.success || !result.venueProfile) throw new Error('No validated profile was returned');
      if (revision === profilePreferenceRevision) {
        state.profile = cloneValue(result.venueProfile);
        if (!state.profileDirty) state.profileDraft = cloneValue(result.venueProfile);
      }
    })
    .catch(error => {
      console.error(`Could not save ${label}:`, error);
      setStatus(`Could not save ${label}: ${error.message}`);
    });
  return true;
}

function persistFriendlyPreference() {
  queueProfilePreferenceSave(profile => {
    profile.friendlyModeDefault = state.friendlyMode;
    profile.operator.advancedWarningAcknowledged = state.advancedWarningAcknowledged;
  }, 'Friendly Mode');
}

function createElement(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

function roleInitials(label) {
  const words = String(label || '').trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return '?';
  return words.slice(0, 2).map(word => word[0]).join('').toUpperCase();
}

function serviceFolderApiAvailable() {
  return ['chooseServiceFolder', 'scanServiceFolder', 'pinServiceSet', 'getCurrentServiceSet', 'checkServiceSetChanges']
    .every(method => typeof window.api?.[method] === 'function');
}

function driveApiAvailable() {
  return [
    'getDriveStatus',
    'connectPrivateDrive',
    'getPrivateDriveOAuthState',
    'copyPrivateDriveOAuthLink',
    'cancelPrivateDriveOAuth',
    'linkPublicDrive',
    'setDrivePublishingEnabled',
    'disconnectDrive'
  ].every(method => typeof window.api?.[method] === 'function');
}

const COMMUNITY_POLL_INTERVAL_MS = 2000;
const COMMUNITY_POLL_TIMEOUT_MS = 15 * 60 * 1000;
const COMMUNITY_MAX_POLL_BACKOFF_MS = 30 * 1000;

function communityApiAvailable() {
  return [
    'getCommunityStatus',
    'startCommunityConnection',
    'pollCommunityConnection',
    'cancelCommunityConnection',
    'disconnectCommunity',
    'syncCommunitySongs',
    'getCommunitySongState',
    'setCommunitySongVisibility'
  ].every(method => typeof window.api?.[method] === 'function');
}

function communitySermonSyncAvailable() {
  return typeof window.api?.syncCommunitySermons === 'function';
}

function communityCheckedResult(result) {
  if (result?.success === false) {
    const details = result.error && typeof result.error === 'object' ? result.error : null;
    const rawMessage = details?.message
      || (typeof result.error === 'string' ? result.error : '')
      || result.message;
    const error = new Error(rawMessage || 'The Community operation could not be completed.');
    error.code = details?.code || result.code;
    throw error;
  }
  return result?.data && typeof result.data === 'object' ? result.data : (result || {});
}

function communityErrorMessage(error, fallback) {
  const message = typeof error?.message === 'string' ? error.message.trim() : '';
  return message || fallback;
}

function projectCommunityConnection(connection) {
  if (!connection || typeof connection !== 'object') return null;
  return {
    id: connection.id,
    serverId: connection.serverId,
    serverName: connection.serverName,
    baseUrl: connection.baseUrl || connection.serverUrl || connection.origin,
    account: connection.account && typeof connection.account === 'object'
      ? {
          id: connection.account.id,
          email: connection.account.email,
          name: connection.account.name
        }
      : null,
    canReadSongs: connection.canReadSongs === true,
    canWriteSongs: connection.canWriteSongs === true,
    canReadSongPublicLinks: connection.canReadSongPublicLinks === true,
    canWriteSongPublicLinks: connection.canWriteSongPublicLinks === true,
    canReadSermons: connection.canReadSermons === true,
    canWriteSermons: connection.canWriteSermons === true,
    canReadServicePlans: connection.canReadServicePlans === true,
    canReadServiceDocuments: connection.canReadServiceDocuments === true,
    expiresAt: connection.expiresAt,
    createdAt: connection.createdAt,
    updatedAt: connection.updatedAt
  };
}

function projectCommunityStatus(status) {
  if (!status || typeof status !== 'object') return {};
  const directConnection = status.id && (status.baseUrl || status.serverUrl)
    ? status
    : null;
  const connection = projectCommunityConnection(
    status.connection && typeof status.connection === 'object'
      ? status.connection
      : directConnection
  );
  const scalarStatus = typeof status.status === 'string' ? status.status : undefined;
  const scalarState = typeof status.state === 'string' ? status.state : undefined;
  return {
    connected: status.connected === true
      || (status.connected !== false && Boolean(connection?.id && connection?.baseUrl)),
    pending: status.pending === true,
    status: scalarStatus,
    state: scalarState,
    authorizationId: communityAuthorizationIdOf(status),
    expiresAt: status.expiresAt,
    retryAfterMs: status.retryAfterMs,
    pollIntervalMs: status.pollIntervalMs,
    userCode: communityUserCodeOf(status),
    serverUrl: status.serverUrl || status.baseUrl || connection?.baseUrl,
    adminEmail: status.adminEmail || status.email || connection?.account?.email,
    message: typeof status.message === 'string'
      ? status.message
      : (typeof status.error?.message === 'string' ? status.error.message : undefined),
    warning: typeof status.warning === 'string' ? status.warning : undefined,
    lastSync: status.lastSync || status.lastSyncSummary || status.sync?.lastSync || status.sync?.summary,
    lastSermonSync: status.lastSermonSync || status.sync?.lastSermonSync,
    connection
  };
}

function communityStatusKey(status = state.community.status) {
  return String(
    status?.status
    || status?.state
    || status?.connection?.status
    || status?.connection?.state
    || ''
  ).trim().toLowerCase();
}

function communityIsConnected(status = state.community.status) {
  if (status?.connected === true || status?.connection?.connected === true) return true;
  return ['approved', 'authorized', 'connected', 'ready'].includes(communityStatusKey(status));
}

function communityIsPending(status = state.community.status) {
  if (status?.pending === true || status?.connection?.pending === true) return true;
  if (state.community.authorizationId) return true;
  return ['authorizing', 'pending', 'waiting', 'waiting-for-approval'].includes(communityStatusKey(status));
}

function communityAuthorizationIdOf(status) {
  const value = status?.authorizationId || status?.authorization?.id;
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function communityUserCodeOf(status) {
  const value = status?.userCode || status?.authorization?.userCode;
  return typeof value === 'string' && value.trim()
    ? value.trim().slice(0, 64)
    : '';
}

function communityTerminalAuthorizationState(status) {
  return ['cancelled', 'denied', 'expired', 'failed', 'rejected'].includes(communityStatusKey(status));
}

function communityTerminalAuthorizationError(error) {
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

function communityConnectionServerUrl(status = state.community.status) {
  return status?.serverUrl
    || status?.baseUrl
    || status?.connection?.serverUrl
    || status?.connection?.baseUrl
    || status?.connection?.origin
    || '';
}

function communityConnectionEmail(status = state.community.status) {
  return status?.adminEmail
    || status?.email
    || status?.account?.email
    || status?.connection?.adminEmail
    || status?.connection?.email
    || status?.connection?.account?.email
    || '';
}

function communityServerLabel(status = state.community.status) {
  const configuredName = status?.serverName || status?.connection?.serverName;
  if (configuredName) return configuredName;
  const rawUrl = communityConnectionServerUrl(status);
  try {
    return new URL(rawUrl).hostname || rawUrl;
  } catch (_error) {
    return rawUrl || 'Heritage Community';
  }
}

function numericCommunityCount(source, keys) {
  for (const key of keys) {
    const count = Number(source?.[key]);
    if (Number.isSafeInteger(count) && count >= 0) return count;
  }
  return 0;
}

function communityConflictCount(summary) {
  const source = summary?.counts && typeof summary.counts === 'object' ? summary.counts : summary;
  return numericCommunityCount(source, ['conflicts', 'conflictCount']);
}

function formatCommunitySyncSummary(summary) {
  if (!summary) return 'Not synced on this computer yet.';
  if (typeof summary === 'string') return summary;
  if (typeof summary?.message === 'string' && !summary.counts && !summary.summary) {
    return summary.message;
  }
  if (summary.summary && typeof summary.summary === 'string') return summary.summary;
  const source = summary.summary && typeof summary.summary === 'object'
    ? summary.summary
    : (summary.counts && typeof summary.counts === 'object' ? summary.counts : summary);
  const pulled = numericCommunityCount(source, ['pulled', 'downloaded', 'received']);
  const pushed = numericCommunityCount(source, ['pushed', 'uploaded', 'sent']);
  const archived = numericCommunityCount(source, ['archived']);
  const unchanged = numericCommunityCount(source, ['unchanged', 'skipped']);
  const conflicts = communityConflictCount(source);
  const reviewRequired = numericCommunityCount(source, ['reviewRequired']);
  const failed = numericCommunityCount(source, ['failed', 'errors', 'errorCount']);
  const warnings = Array.isArray(summary.warnings)
    ? summary.warnings.length
    : numericCommunityCount(source, ['warnings', 'warningCount']);
  const parts = [
    summary.status === 'offline' ? 'Server unavailable' : '',
    pulled ? `${pulled} received` : '',
    pushed ? `${pushed} sent` : '',
    archived ? `${archived} archived` : '',
    unchanged ? `${unchanged} unchanged` : '',
    conflicts ? `${conflicts} ${conflicts === 1 ? 'conflict needs' : 'conflicts need'} review` : '',
    reviewRequired
      ? `${reviewRequired} ${reviewRequired === 1 ? 'song family needs' : 'song families need'} sharing review`
      : '',
    failed ? `${failed} failed` : '',
    warnings ? `${warnings} ${warnings === 1 ? 'warning' : 'warnings'}` : ''
  ].filter(Boolean);
  const timestamp = summary.completedAt
    || summary.finishedAt
    || summary.syncedAt
    || summary.updatedAt
    || source.completedAt
    || source.finishedAt
    || source.syncedAt;
  let when = '';
  if (timestamp && Number.isFinite(Date.parse(timestamp))) {
    try {
      when = new Intl.DateTimeFormat(undefined, {
        month: 'short',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit'
      }).format(new Date(timestamp));
    } catch (_error) {
      when = '';
    }
  }
  if (parts.length === 0 && typeof summary?.message === 'string') parts.push(summary.message);
  if (parts.length === 0) parts.push('Sync finished');
  return `${parts.join(' · ')}${when ? ` · ${when}` : ''}.`;
}

function mergeCommunityStatus(previous, incoming) {
  if (!previous || typeof previous !== 'object') return incoming;
  if (!incoming || typeof incoming !== 'object') return previous;
  return {
    ...previous,
    ...incoming,
    connection: incoming.connection && typeof incoming.connection === 'object'
      ? { ...(previous.connection || {}), ...incoming.connection }
      : previous.connection
  };
}

function applyCommunityStatus(rawStatus, { replace = false } = {}) {
  let rawPayload;
  try {
    rawPayload = communityCheckedResult(rawStatus);
  } catch (error) {
    state.community.error = communityErrorMessage(error, 'Community status is unavailable.');
    renderCommunitySettings();
    renderCommunityPrepare();
    return false;
  }
  const status = projectCommunityStatus(rawPayload);
  state.community.status = replace
    ? status
    : mergeCommunityStatus(state.community.status, status);
  const authorizationId = communityAuthorizationIdOf(status);
  if (authorizationId) state.community.authorizationId = authorizationId;
  const lastSync = status.lastSync
    || status.lastSyncSummary
    || status.sync?.lastSync
    || status.sync?.summary;
  const lastSermonSync = status.lastSermonSync
    || status.sync?.lastSermonSync;
  if (lastSermonSync) {
    state.community.lastSermonSync = lastSermonSync;
  }
  if (lastSync?.resource === 'sermons') {
    state.community.lastSermonSync = lastSync;
  } else if (lastSync) {
    state.community.lastSync = lastSync;
  }
  if (communityIsConnected(state.community.status)) {
    state.community.error = null;
    stopCommunityAuthorizationPolling({ clearAuthorization: true });
  } else if (communityTerminalAuthorizationState(status)) {
    stopCommunityAuthorizationPolling({ clearAuthorization: true });
  }
  const serverUrl = communityConnectionServerUrl(state.community.status);
  const email = communityConnectionEmail(state.community.status);
  if (serverUrl && document.activeElement !== elements.communityServerUrl) {
    elements.communityServerUrl.value = serverUrl;
  }
  if (email && document.activeElement !== elements.communityAdminEmail) {
    elements.communityAdminEmail.value = email;
  }
  renderCommunitySettings();
  renderCommunityPrepare();
  return true;
}

function renderCommunitySettings() {
  const available = communityApiAvailable();
  const connected = available && communityIsConnected();
  const pending = available && !connected && communityIsPending();
  const busy = state.community.busy;
  const syncing = state.community.syncing || state.community.sermonSyncing;
  const canReadSongs = connected
    && state.community.status?.connection?.canReadSongs === true;
  const canReadSermons = connected
    && state.community.status?.connection?.canReadSermons === true;
  const canReadSongPublicLinks = connected
    && state.community.status?.connection?.canReadSongPublicLinks === true;
  const canWriteSongPublicLinks = canReadSongPublicLinks
    && state.community.status?.connection?.canWriteSongPublicLinks === true;
  const canReadServicePlans = connected
    && state.community.status?.connection?.canReadServicePlans === true;
  const canReadServiceDocuments = connected
    && state.community.status?.connection?.canReadServiceDocuments === true;
  const badge = elements.communityConnectionBadge;
  badge.classList.remove('ready', 'attention', 'scanning');

  if (!available) {
    badge.textContent = 'Not included';
    badge.classList.add('attention');
    elements.communityConnectionStatus.dataset.kind = 'error';
    elements.communityConnectionStatusTitle.textContent = 'Community sync is not included in this build';
    elements.communityConnectionStatusDetail.textContent = 'Install or open a newer SyncShow build to connect the shared Community library.';
    elements.communityConnectionHelp.textContent = 'Load and Show still work normally. No Community password, song, or sermon data is sent from this build.';
  } else if (connected) {
    badge.textContent = 'Connected';
    badge.classList.add('ready');
    elements.communityConnectionStatus.dataset.kind = 'connected';
    elements.communityConnectionStatusTitle.textContent = `Connected to ${communityServerLabel()}`;
    elements.communityConnectionStatusDetail.textContent = state.community.status?.warning
      || (syncing
        ? (state.community.sermonSyncing
          ? 'Pulling Community sermon updates into the local library…'
          : 'Syncing the local and Community song libraries…')
        : canReadServiceDocuments
          ? 'Services prepared in Community are available from Load. An opened service remains available locally for offline Show.'
          : canReadServicePlans
            ? 'Community service plans are available in Prepare and remain local after import.'
            : canReadSongs && canReadSermons
          ? 'Songs and sermon records remain available locally. Conflicts are held for review instead of being overwritten.'
          : canReadSongs
            ? 'This connection includes the shared song library. Sermon synchronization is not currently available.'
            : canReadSermons
              ? 'This connection includes the shared sermon library. Song synchronization is not currently available.'
              : 'No currently approved Community library resource is available on this connection.');
    elements.communityConnectionHelp.textContent = canReadServiceDocuments
      ? 'Use Open from Heritage Community in Load. SyncShow downloads the exact revision and replaces the current Load service only after its offline package is complete.'
      : canReadServicePlans
        ? 'Use Browse plans in Prepare to review and import a Community plan.'
        : canReadSongs && canReadSermons
          ? 'This computer can read both Community libraries. Local sermons are shared only from the explicit button in Prepare.'
          : canReadSongs
            ? 'This computer can read the Community song library. Other resource lanes remain independent.'
            : canReadSermons
              ? 'This computer can read the Community sermon library. Local sermons are shared only from the explicit button in Prepare.'
              : 'Reconnect to approve a resource the server currently advertises. Local library work remains available.';
  } else if (pending) {
    badge.textContent = 'Waiting';
    badge.classList.add('scanning');
    elements.communityConnectionStatus.dataset.kind = 'pending';
    elements.communityConnectionStatusTitle.textContent = 'Check the admin email';
    elements.communityConnectionStatusDetail.textContent = state.community.error
      || state.community.status?.message
      || 'Open the approval link, approve this computer, and keep SyncShow open. This check stops automatically.';
    elements.communityConnectionHelp.textContent = 'The approval link expires. Cancel this request if the wrong email or server was entered.';
  } else {
    badge.textContent = 'Not connected';
    if (state.community.error) badge.classList.add('attention');
    elements.communityConnectionStatus.dataset.kind = state.community.error ? 'error' : 'idle';
    elements.communityConnectionStatusTitle.textContent = state.community.error
      ? 'Community connection needs attention'
      : 'This computer is not connected';
    elements.communityConnectionStatusDetail.textContent = state.community.error
      || state.community.status?.message
      || 'Enter the server address and an admin email to connect the shared Community library.';
    elements.communityConnectionHelp.textContent = 'Connecting emails an approval link to the Community admin account and remembers this computer. SyncShow never asks for the computer’s system password.';
  }

  const inputsDisabled = !available || connected || pending || busy;
  elements.communityServerUrl.disabled = inputsDisabled;
  elements.communityAdminEmail.disabled = inputsDisabled;
  elements.btnConnectCommunity.hidden = connected || pending;
  elements.btnConnectCommunity.disabled = !available || busy || syncing;
  elements.btnConnectCommunity.textContent = busy ? 'Connecting…' : 'Connect';
  elements.btnCancelCommunityConnection.hidden = !pending;
  elements.btnCancelCommunityConnection.disabled = busy;
  const openApprovalAvailable = typeof window.api?.openCommunityApproval === 'function';
  const copyApprovalAvailable = typeof window.api?.copyCommunityApprovalCode === 'function';
  const approvalActionAvailable = openApprovalAvailable && copyApprovalAvailable;
  const authorizationId = state.community.authorizationId
    || communityAuthorizationIdOf(state.community.status);
  const userCode = communityUserCodeOf(state.community.status);
  elements.communityApprovalRecovery.hidden = !pending;
  elements.communityApprovalCode.textContent = pending ? (userCode || 'Code unavailable') : '';
  elements.btnOpenCommunityApproval.hidden = !pending;
  elements.btnCopyCommunityApprovalCode.hidden = !pending;
  elements.btnOpenCommunityApproval.disabled = !pending
    || !authorizationId
    || !openApprovalAvailable
    || state.community.approvalActionBusy;
  elements.btnCopyCommunityApprovalCode.disabled = !pending
    || !authorizationId
    || !userCode
    || !copyApprovalAvailable
    || state.community.approvalActionBusy;
  elements.communityApprovalActionStatus.textContent = pending
    ? (state.community.approvalActionMessage
      || (approvalActionAvailable
        ? 'The email link is still the simplest option; this code is a recovery path.'
        : 'Approval recovery is not included in this build.'))
    : '';
  elements.btnDisconnectCommunity.hidden = !connected;
  elements.btnDisconnectCommunity.disabled = busy || syncing;
  elements.btnSyncCommunitySongs.disabled = !canReadSongs || busy || syncing;
  elements.btnSyncCommunitySongs.textContent = state.community.syncing
    ? 'Syncing songs…'
    : 'Sync songs now';
  elements.btnSyncCommunitySermons.disabled = !canReadSermons
    || !communitySermonSyncAvailable()
    || busy
    || syncing;
  elements.btnSyncCommunitySermons.textContent = state.community.sermonSyncing
    ? 'Syncing sermons…'
    : 'Sync sermons now';
  elements.communityLastSyncSummary.textContent = canReadSongs
    ? formatCommunitySyncSummary(state.community.lastSync)
    : connected
      ? 'Song synchronization is not available for this connection.'
      : 'Sync Community songs after this computer is connected.';
  elements.communityLastSermonSyncSummary.textContent = canReadSermons
    ? formatCommunitySyncSummary(state.community.lastSermonSync)
    : connected
      ? 'Sermon synchronization is not available for this connection.'
      : 'Pull Community sermon updates after this computer is connected.';
  elements.communitySongPublicLinkBadge.classList.remove(
    'ready',
    'attention',
    'scanning'
  );
  if (canWriteSongPublicLinks) {
    elements.communitySongPublicLinkBadge.textContent = 'Manage';
    elements.communitySongPublicLinkBadge.classList.add('ready');
    elements.communitySongPublicLinkSummary.textContent =
      'This approval can list, copy, create, and revoke anonymous song links. Open an exact saved song in Prepare to manage them.';
  } else if (canReadSongPublicLinks) {
    elements.communitySongPublicLinkBadge.textContent = 'Read only';
    elements.communitySongPublicLinkBadge.classList.add('attention');
    elements.communitySongPublicLinkSummary.textContent =
      'This approval can list and copy server-confirmed links, but cannot create or revoke them.';
  } else if (connected) {
    elements.communitySongPublicLinkBadge.textContent = 'Not approved';
    elements.communitySongPublicLinkBadge.classList.add('attention');
    elements.communitySongPublicLinkSummary.textContent =
      'Anonymous links are a separate capability. If this server offers them, reconnect to approve that scope; existing links may still need Community admin.';
  } else {
    elements.communitySongPublicLinkBadge.textContent = 'Not connected';
    elements.communitySongPublicLinkSummary.textContent =
      'Connect Heritage Community first. Public links never inherit ordinary song or member-sharing permission.';
  }
}

function renderCommunityPrepare() {
  const available = typeof window.api?.openCommunityPlanner === 'function';
  const connected = available && communityIsConnected();

  elements.communityPrepareStatus.dataset.kind = '';
  if (!available) {
    elements.communityPrepareStatus.dataset.kind = 'error';
    elements.communityPrepareStatus.textContent =
      'This SyncShow build cannot open the shared Community planner.';
  } else if (!connected) {
    elements.communityPrepareStatus.dataset.kind = 'warning';
    elements.communityPrepareStatus.textContent =
      'Connect Heritage Community from Admin Settings on the Load page, or use This computer.';
  } else if (state.community.plannerError) {
    elements.communityPrepareStatus.dataset.kind = 'error';
    elements.communityPrepareStatus.textContent = state.community.plannerError;
  } else if (state.community.plannerBusy) {
    elements.communityPrepareStatus.textContent =
      'Opening the planner supplied by Heritage Community…';
  } else if (state.community.plannerOpen) {
    elements.communityPrepareStatus.dataset.kind = 'success';
    elements.communityPrepareStatus.textContent =
      'Connected. Loading the shared planner…';
  } else {
    elements.communityPrepareStatus.textContent =
      'Loading the shared planner…';
  }
  scheduleCommunityPlannerLayout();
}

function communityPlannerShouldBeVisible() {
  return state.workflowStage === 'prepare'
    && state.prepareMode === 'community'
    && communityIsConnected()
    && state.community.plannerOpen
    && !elements.communityPrepareShell.hidden;
}

async function syncCommunityPlannerLayout() {
  if (typeof window.api?.layoutCommunityPlanner !== 'function') return;
  if (!communityPlannerShouldBeVisible()) {
    await window.api.layoutCommunityPlanner({ visible: false }).catch(() => {});
    return;
  }
  const rect = elements.communityPlannerViewport.getBoundingClientRect();
  if (rect.width < 640 || rect.height < 420) {
    await window.api.layoutCommunityPlanner({ visible: false }).catch(() => {});
    return;
  }
  try {
    await window.api.layoutCommunityPlanner({
      visible: true,
      bounds: {
        x: Math.max(0, Math.round(rect.left)),
        y: Math.max(0, Math.round(rect.top)),
        width: Math.round(rect.width),
        height: Math.round(rect.height)
      }
    });
  } catch (error) {
    state.community.plannerError = communityErrorMessage(
      error,
      'Embedded Community Prepare could not be positioned.'
    );
    renderCommunityPrepare();
  }
}

function scheduleCommunityPlannerLayout() {
  if (communityPlannerLayoutFrame !== null) return;
  communityPlannerLayoutFrame = window.requestAnimationFrame(() => {
    communityPlannerLayoutFrame = null;
    syncCommunityPlannerLayout();
  });
}

async function activatePrepareMode(mode, options = {}) {
  const selected = mode === 'local' ? 'local' : 'community';
  state.prepareMode = selected;
  const local = selected === 'local';
  elements.communityPrepareShell.hidden = local;
  elements.legacyPrepareShell.hidden = !local;
  elements.btnPrepareModeCommunity.classList.toggle('is-active', !local);
  elements.btnPrepareModeCommunity.setAttribute('aria-selected', String(!local));
  elements.btnPrepareModeCommunity.tabIndex = local ? -1 : 0;
  elements.btnPrepareModeLocal.classList.toggle('is-active', local);
  elements.btnPrepareModeLocal.setAttribute('aria-selected', String(local));
  elements.btnPrepareModeLocal.tabIndex = local ? 0 : -1;
  elements.preparePanel.setAttribute(
    'aria-labelledby',
    local ? 'prepareHeading' : 'communityPrepareHeading'
  );
  scheduleCommunityPlannerLayout();
  if (local) {
    const activated = await prepareController?.activate(options).catch(error => {
      console.error('[Prepare] Could not activate local tools:', error);
      setStatus(`Local Prepare could not open: ${error.message}`);
      return false;
    });
    window.setTimeout(() => elements.legacyPrepareShell.querySelector('h2')?.focus(), 0);
    return activated;
  }
  window.setTimeout(() => elements.communityPrepareHeading.focus(), 0);
  return openCommunityPrepare();
}

function handleCommunityPlannerStateChanged(payload = {}) {
  const wasOpen = state.community.plannerOpen;
  state.community.plannerOpen = payload?.open === true;
  state.community.plannerBusy = false;
  state.community.plannerError = typeof payload?.error?.message === 'string'
    ? payload.error.message
    : null;
  renderCommunityPrepare();
  if (wasOpen && !state.community.plannerOpen && !state.community.plannerError) {
    setStatus('Community Prepare closed');
  }
}

async function refreshCommunityPlannerState() {
  if (typeof window.api?.getCommunityPlannerState !== 'function') {
    renderCommunityPrepare();
    return null;
  }
  try {
    const payload = communityCheckedResult(
      await window.api.getCommunityPlannerState()
    );
    handleCommunityPlannerStateChanged(payload);
    return payload;
  } catch (error) {
    state.community.plannerError = communityErrorMessage(
      error,
      'Community Prepare status is unavailable.'
    );
    renderCommunityPrepare();
    return null;
  }
}

async function openCommunityPrepare() {
  if (state.community.plannerBusy) return false;
  if (!communityIsConnected()) {
    state.community.plannerError = null;
    renderCommunityPrepare();
    setStatus('Connect Heritage Community before opening Prepare');
    openSettings('community');
    return false;
  }
  state.community.plannerBusy = true;
  state.community.plannerError = null;
  renderCommunityPrepare();
  try {
    const result = communityCheckedResult(
      await window.api.openCommunityPlanner()
    );
    state.community.plannerOpen = result.opened === true;
    const destination = result.serverName || communityServerLabel();
    setStatus(`${destination} Prepare is embedded in SyncShow`);
    scheduleCommunityPlannerLayout();
    return state.community.plannerOpen;
  } catch (error) {
    state.community.plannerOpen = false;
    state.community.plannerError = communityErrorMessage(
      error,
      'Community Prepare could not open.'
    );
    setStatus(state.community.plannerError);
    if (error?.code === 'COMMUNITY_RECONNECT_REQUIRED') {
      openSettings('community');
    }
    return false;
  } finally {
    state.community.plannerBusy = false;
    renderCommunityPrepare();
  }
}

function handleCommunityStatusChanged(payload) {
  applyCommunityStatus(payload);
  resumeCommunityAuthorizationPolling();
  prepareController?.refreshSongs?.().catch(() => {
    // Community badges can retry when the Song Library is opened or refreshed.
  });
  prepareController?.refreshSongCommunityState?.().catch(() => {
    // The open song editor can retry when the song is reopened.
  });
  prepareController?.refreshSermonCommunityState?.().catch(() => {
    // The narrow Prepare status can retry when the sermon is reselected.
  });
}

async function refreshCommunityStatus() {
  if (!communityApiAvailable()) {
    state.community.status = null;
    state.community.error = null;
    renderCommunitySettings();
    renderCommunityPrepare();
    return null;
  }
  try {
    const status = await window.api.getCommunityStatus();
    state.community.error = null;
    applyCommunityStatus(status, { replace: true });
    resumeCommunityAuthorizationPolling();
    return state.community.status;
  } catch (error) {
    state.community.error = communityErrorMessage(error, 'Community status is unavailable.');
    renderCommunitySettings();
    renderCommunityPrepare();
    return null;
  }
}

function stopCommunityAuthorizationPolling({ clearAuthorization = false } = {}) {
  state.community.pollGeneration += 1;
  if (communityPollTimer !== null) {
    window.clearTimeout(communityPollTimer);
    communityPollTimer = null;
  }
  if (clearAuthorization) state.community.authorizationId = null;
  if (clearAuthorization) {
    state.community.approvalActionBusy = false;
    state.community.approvalActionMessage = '';
  }
}

function resumeCommunityAuthorizationPolling() {
  const authorizationId = state.community.authorizationId
    || communityAuthorizationIdOf(state.community.status);
  if (communityPollTimer === null
    && authorizationId
    && communityIsPending()) {
    startCommunityAuthorizationPolling(authorizationId);
  }
}

function startCommunityAuthorizationPolling(authorizationId) {
  stopCommunityAuthorizationPolling();
  state.community.authorizationId = authorizationId;
  const generation = state.community.pollGeneration;
  const startedAt = Date.now();
  let consecutiveFailures = 0;

  const poll = async () => {
    if (generation !== state.community.pollGeneration
      || state.community.authorizationId !== authorizationId) return;
    if (Date.now() - startedAt >= COMMUNITY_POLL_TIMEOUT_MS) {
      stopCommunityAuthorizationPolling();
      state.community.error = 'The approval request timed out. Start a new connection when you are ready.';
      renderCommunitySettings();
      try {
        communityCheckedResult(
          await window.api.cancelCommunityConnection({ authorizationId })
        );
      } catch (_error) {
        // Main still clears the in-memory request during app lifecycle cleanup.
      }
      stopCommunityAuthorizationPolling({ clearAuthorization: true });
      await refreshCommunityStatus();
      state.community.error = 'The approval request timed out. Start a new connection when you are ready.';
      renderCommunitySettings();
      return;
    }
    let nextPollDelayMs = COMMUNITY_POLL_INTERVAL_MS;
    try {
      const result = communityCheckedResult(await window.api.pollCommunityConnection({ authorizationId }));
      if (generation !== state.community.pollGeneration) return;
      consecutiveFailures = 0;
      state.community.error = null;
      applyCommunityStatus(result);
      if (communityIsConnected()) {
        stopCommunityAuthorizationPolling({ clearAuthorization: true });
        await refreshCommunityStatus();
        setStatus('Heritage Community is connected. Approved library resources are now available.');
        return;
      }
      if (communityTerminalAuthorizationState(result)) {
        const terminalState = communityStatusKey(result);
        stopCommunityAuthorizationPolling({ clearAuthorization: true });
        state.community.error = result.message
          || `The Community connection was ${terminalState}. Start again when you are ready.`;
        renderCommunitySettings();
        return;
      }
      if (Number.isFinite(result.retryAfterMs)) {
        nextPollDelayMs = Math.max(
          COMMUNITY_POLL_INTERVAL_MS,
          Math.min(Number(result.retryAfterMs), COMMUNITY_MAX_POLL_BACKOFF_MS)
        );
      }
    } catch (error) {
      if (generation !== state.community.pollGeneration) return;
      if (communityTerminalAuthorizationError(error)) {
        stopCommunityAuthorizationPolling({ clearAuthorization: true });
        state.community.error = communityErrorMessage(
          error,
          'The Community approval request ended. Start a new connection when you are ready.'
        );
        await refreshCommunityStatus();
        renderCommunitySettings();
        return;
      }
      consecutiveFailures += 1;
      state.community.error = communityErrorMessage(error, 'Could not check the Community approval yet.');
      nextPollDelayMs = Math.min(
        COMMUNITY_POLL_INTERVAL_MS * (2 ** Math.min(consecutiveFailures, 4)),
        COMMUNITY_MAX_POLL_BACKOFF_MS
      );
      renderCommunitySettings();
    }
    if (generation !== state.community.pollGeneration) return;
    communityPollTimer = window.setTimeout(poll, nextPollDelayMs);
  };

  renderCommunitySettings();
  communityPollTimer = window.setTimeout(poll, COMMUNITY_POLL_INTERVAL_MS);
}

async function startCommunityConnection(event) {
  event.preventDefault();
  if (!communityApiAvailable()
    || communityIsConnected()
    || communityIsPending()
    || state.community.busy
    || state.community.syncing
    || state.community.sermonSyncing) return;
  if (!elements.communityConnectionForm.reportValidity()) return;
  let serverUrl;
  try {
    serverUrl = normalizeCommunityServerAddress(elements.communityServerUrl.value);
    elements.communityServerUrl.value = serverUrl;
  } catch (_error) {
    state.community.error = 'Enter a Community server address such as community.example.org. SyncShow adds https:// automatically.';
    renderCommunitySettings();
    elements.communityServerUrl.focus();
    return;
  }
  const email = elements.communityAdminEmail.value.trim();
  state.community.busy = true;
  state.community.error = null;
  state.community.approvalActionMessage = '';
  renderCommunitySettings();
  try {
    const result = communityCheckedResult(await window.api.startCommunityConnection({ serverUrl, email }));
    applyCommunityStatus({
      serverUrl,
      adminEmail: email,
      ...result
    });
    if (communityIsConnected()) {
      await refreshCommunityStatus();
      setStatus('Heritage Community is connected.');
      return;
    }
    const authorizationId = communityAuthorizationIdOf(result);
    if (!authorizationId) {
      throw new Error('The server did not return an approval request. Check the address and try again.');
    }
    state.community.error = null;
    startCommunityAuthorizationPolling(authorizationId);
    setStatus('Community approval email sent. Keep SyncShow open while the admin approves this computer.');
  } catch (error) {
    stopCommunityAuthorizationPolling({ clearAuthorization: true });
    state.community.error = communityErrorMessage(error, 'The Community connection could not be started.');
    setStatus(`Could not connect Heritage Community: ${state.community.error}`);
  } finally {
    state.community.busy = false;
    renderCommunitySettings();
  }
}

async function openCommunityApproval() {
  const authorizationId = state.community.authorizationId
    || communityAuthorizationIdOf(state.community.status);
  if (!authorizationId
    || !communityIsPending()
    || state.community.approvalActionBusy
    || typeof window.api?.openCommunityApproval !== 'function') return;
  state.community.approvalActionBusy = true;
  state.community.approvalActionMessage = 'Opening the Community approval page…';
  renderCommunitySettings();
  try {
    const result = communityCheckedResult(
      await window.api.openCommunityApproval({ authorizationId })
    );
    state.community.approvalActionMessage = result.opened === false
      ? 'The approval page could not be opened. Use the link in the admin email instead.'
      : 'Approval page opened. Enter the public code shown here.';
  } catch (error) {
    state.community.approvalActionMessage = communityErrorMessage(
      error,
      'The approval page could not be opened. Use the link in the admin email instead.'
    );
  } finally {
    state.community.approvalActionBusy = false;
    renderCommunitySettings();
  }
}

async function copyCommunityApprovalCode() {
  const authorizationId = state.community.authorizationId
    || communityAuthorizationIdOf(state.community.status);
  const userCode = communityUserCodeOf(state.community.status);
  if (!authorizationId
    || !userCode
    || !communityIsPending()
    || state.community.approvalActionBusy
    || typeof window.api?.copyCommunityApprovalCode !== 'function') return;
  state.community.approvalActionBusy = true;
  state.community.approvalActionMessage = 'Copying the public one-time code…';
  renderCommunitySettings();
  try {
    const result = communityCheckedResult(
      await window.api.copyCommunityApprovalCode({ authorizationId })
    );
    state.community.approvalActionMessage = result.copied === false
      ? 'The approval code was no longer available. Start a new connection.'
      : 'Code copied. Paste it into the Community approval page.';
  } catch (error) {
    state.community.approvalActionMessage = communityErrorMessage(
      error,
      'The approval code could not be copied.'
    );
  } finally {
    state.community.approvalActionBusy = false;
    renderCommunitySettings();
  }
}

async function cancelCommunityConnection() {
  const authorizationId = state.community.authorizationId
    || communityAuthorizationIdOf(state.community.status);
  if (!authorizationId || state.community.busy || !communityApiAvailable()) return;
  state.community.busy = true;
  stopCommunityAuthorizationPolling();
  renderCommunitySettings();
  try {
    communityCheckedResult(await window.api.cancelCommunityConnection({ authorizationId }));
    state.community.authorizationId = null;
    state.community.error = null;
    await refreshCommunityStatus();
    setStatus('Community connection cancelled.');
  } catch (error) {
    state.community.authorizationId = null;
    state.community.error = communityErrorMessage(error, 'The approval request could not be cancelled.');
    setStatus(`Could not cancel Community connection: ${state.community.error}`);
  } finally {
    state.community.busy = false;
    renderCommunitySettings();
  }
}

async function disconnectCommunity() {
  if (!communityApiAvailable()
    || state.community.busy
    || state.community.syncing
    || state.community.sermonSyncing) return;
  state.community.busy = true;
  stopCommunityAuthorizationPolling({ clearAuthorization: true });
  renderCommunitySettings();
  try {
    const result = communityCheckedResult(await window.api.disconnectCommunity());
    state.community.status = {
      connected: false,
      status: 'disconnected',
      warning: typeof result.warning === 'string' ? result.warning : undefined
    };
    await refreshCommunityStatus();
    const warning = typeof result.warning === 'string'
      ? result.warning
      : (typeof state.community.status?.warning === 'string'
        ? state.community.status.warning
        : '');
    state.community.error = warning || null;
    setStatus(warning
      ? `Heritage Community disconnected locally. ${warning}`
      : 'Heritage Community disconnected. Local library work is still available.');
  } catch (error) {
    state.community.error = communityErrorMessage(error, 'Heritage Community could not be disconnected.');
    setStatus(`Could not disconnect Heritage Community: ${state.community.error}`);
  } finally {
    state.community.busy = false;
    renderCommunitySettings();
  }
}

async function syncCommunitySongs() {
  const canReadSongs = state.community.status?.connection?.canReadSongs === true;
  if (!communityApiAvailable()
    || !communityIsConnected()
    || !canReadSongs
    || state.community.busy
    || state.community.syncing
    || state.community.sermonSyncing) return;
  state.community.syncing = true;
  state.community.error = null;
  renderCommunitySettings();
  try {
    const result = communityCheckedResult(await window.api.syncCommunitySongs());
    state.community.lastSync = result.lastSync || result.summary || result;
    const conflicts = communityConflictCount(result.summary || result);
    const offline = result.status === 'offline';
    const summary = formatCommunitySyncSummary(state.community.lastSync);
    setStatus(offline
      ? 'Community server is unavailable. Local songs were not changed.'
      : conflicts > 0
        ? `Song sync finished with ${conflicts} ${conflicts === 1 ? 'conflict' : 'conflicts'} to review.`
        : `Community songs synced. ${summary}`);
    if (prepareController?.refreshSongs) {
      try {
        await prepareController.refreshSongs();
      } catch (_error) {
        // The sync itself succeeded; Prepare can refresh when it is reopened.
      }
    }
    await refreshCommunityStatus();
  } catch (error) {
    state.community.error = communityErrorMessage(error, 'The song libraries could not be synced.');
    setStatus(`Community song sync needs attention: ${state.community.error}`);
  } finally {
    state.community.syncing = false;
    renderCommunitySettings();
  }
}

async function syncCommunitySermons() {
  const canReadSermons = state.community.status?.connection?.canReadSermons === true;
  if (!communityApiAvailable()
    || !communitySermonSyncAvailable()
    || !communityIsConnected()
    || !canReadSermons
    || state.community.busy
    || state.community.syncing
    || state.community.sermonSyncing) return;
  state.community.sermonSyncing = true;
  state.community.error = null;
  renderCommunitySettings();
  try {
    const result = communityCheckedResult(await window.api.syncCommunitySermons());
    state.community.lastSermonSync = result.lastSync || result.summary || result;
    const conflicts = communityConflictCount(result.summary || result);
    const offline = result.status === 'offline' || result.summary?.status === 'offline';
    const summary = formatCommunitySyncSummary(state.community.lastSermonSync);
    setStatus(offline
      ? 'Community server is unavailable. Local sermon records were not changed.'
      : conflicts > 0
        ? `Sermon sync finished with ${conflicts} ${conflicts === 1 ? 'conflict' : 'conflicts'} to review.`
        : `Community sermon updates pulled. ${summary}`);
    if (prepareController?.refreshSermons) {
      try {
        await prepareController.refreshSermons();
        await prepareController.refreshSermonCommunityState?.();
      } catch (_error) {
        // The pull itself succeeded; Prepare can refresh when it is reopened.
      }
    }
    await refreshCommunityStatus();
  } catch (error) {
    state.community.error = communityErrorMessage(error, 'The sermon library could not be synced.');
    setStatus(`Community sermon sync needs attention: ${state.community.error}`);
  } finally {
    state.community.sermonSyncing = false;
    renderCommunitySettings();
  }
}

function disposeCommunityConnectionUi() {
  stopCommunityAuthorizationPolling({ clearAuthorization: true });
  if (communityPlannerLayoutFrame !== null) {
    window.cancelAnimationFrame(communityPlannerLayoutFrame);
    communityPlannerLayoutFrame = null;
  }
  window.api?.layoutCommunityPlanner?.({ visible: false }).catch(() => {});
  if (typeof communityStatusUnsubscribe === 'function') communityStatusUnsubscribe();
  communityStatusUnsubscribe = null;
  if (typeof communityPlannerStateUnsubscribe === 'function') {
    communityPlannerStateUnsubscribe();
  }
  communityPlannerStateUnsubscribe = null;
}

function renderPrivateDriveOAuthDialog() {
  const oauth = state.drive.oauth;
  elements.btnCopyDriveOAuthLink.disabled = !oauth.active || oauth.actionBusy;
  elements.btnCancelDriveOAuth.disabled = !oauth.active || oauth.actionBusy;
  elements.driveOAuthActionStatus.textContent = oauth.actionMessage
    || (oauth.active ? 'Waiting for Google sign-in…' : 'Google sign-in has finished.');

  if (oauth.active) {
    if (!elements.driveOAuthDialog.open) elements.driveOAuthDialog.showModal();
  } else if (elements.driveOAuthDialog.open) {
    elements.driveOAuthDialog.close();
  }
}

function handlePrivateDriveOAuthStateChanged(payload) {
  const transition = window.SyncShowGoogleDriveOAuthState.applyLifecycleState(
    state.drive.oauth,
    payload
  );
  if (!transition.accepted) return;
  state.drive.oauth = transition.state;
  state.drive.oauth.actionMessage = transition.becameActive
    ? 'Waiting for Google sign-in…'
    : '';
  renderPrivateDriveOAuthDialog();
}

async function refreshPrivateDriveOAuthState() {
  if (typeof window.api?.getPrivateDriveOAuthState !== 'function') return;
  try {
    handlePrivateDriveOAuthStateChanged(await window.api.getPrivateDriveOAuthState());
  } catch (_error) {
    // The lifecycle event remains authoritative; never log an authorization URL.
  }
}

async function copyPrivateDriveOAuthLink() {
  if (!state.drive.oauth.active || state.drive.oauth.actionBusy) return;
  state.drive.oauth.actionBusy = true;
  state.drive.oauth.actionMessage = 'Copying the one-time sign-in link…';
  renderPrivateDriveOAuthDialog();
  try {
    const result = await window.api.copyPrivateDriveOAuthLink();
    state.drive.oauth.actionMessage = result?.copied === true
      ? 'Copied. Paste the link into another browser on this computer.'
      : 'The sign-in link was no longer available.';
  } catch (error) {
    state.drive.oauth.actionMessage = driveErrorMessage(
      error,
      'The sign-in link could not be copied.'
    );
  } finally {
    state.drive.oauth.actionBusy = false;
    renderPrivateDriveOAuthDialog();
  }
}

async function cancelPrivateDriveOAuth() {
  if (!state.drive.oauth.active || state.drive.oauth.actionBusy) return;
  state.drive.oauth.actionBusy = true;
  state.drive.oauth.actionMessage = 'Cancelling Google sign-in…';
  renderPrivateDriveOAuthDialog();
  try {
    await window.api.cancelPrivateDriveOAuth();
  } catch (error) {
    state.drive.oauth.actionMessage = driveErrorMessage(
      error,
      'Google sign-in could not be cancelled.'
    );
  } finally {
    state.drive.oauth.actionBusy = false;
    await refreshPrivateDriveOAuthState();
    renderPrivateDriveOAuthDialog();
  }
}

function privateDriveIsConfigured() {
  return state.drive.status?.configuration?.privateOAuthConfigured === true;
}

function publicDriveIsConfigured() {
  return state.drive.status?.configuration?.publicApiKeyConfigured === true;
}

function driveErrorMessage(error, fallback) {
  return window.SyncShowErrorMessages?.humanizeIpcError(error, fallback) || fallback;
}

function hasConfiguredServiceSource(profile = state.profile) {
  return Boolean(profile?.localServiceFolder || profile?.driveConnectionId);
}

function activeDriveConnection() {
  const connection = state.drive.status?.connection || null;
  if (!connection || connection.id !== state.profile?.driveConnectionId) return null;
  return connection;
}

// Keep this projection aligned with the main process's scan-token signature.
// If any of these fields changes, the old scan describes a different venue
// contract and must not remain actionable in the renderer.
function serviceFolderScanProfileSignature(profile) {
  if (!profile) return null;
  return JSON.stringify({
    id: profile.id,
    timeZone: profile.timeZone,
    serviceDateOrder: profile.serviceDateOrder,
    localServiceFolder: profile.localServiceFolder,
    driveConnectionId: profile.driveConnectionId,
    inputRoles: (profile.inputRoles || []).map(role => ({
      id: role.id,
      label: role.label,
      enabled: role.enabled,
      kind: role.kind,
      required: role.required,
      filenameMatchers: role.filenameMatchers,
      datePolicy: role.datePolicy
    })),
    outputs: (profile.outputs || []).map(output => ({
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

function invalidateServiceFolderScan() {
  state.serviceFolder.scanVersion += 1;
  state.serviceFolder.scan = null;
  state.serviceFolder.scanToken = null;
  state.serviceFolder.selectedSetId = null;
  state.serviceFolder.scanEpoch = null;
  state.serviceFolder.scanning = false;
}

function folderBaseName(folderPath) {
  const normalized = String(folderPath || '').replace(/[\\/]+$/, '').replace(/\\/g, '/');
  return normalized.split('/').pop() || normalized || 'Service folder';
}

function serviceDateForProfile(profile = state.profile, date = new Date()) {
  const options = {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    ...(profile?.timeZone ? { timeZone: profile.timeZone } : {})
  };
  try {
    const parts = Object.fromEntries(
      new Intl.DateTimeFormat('en-US', options)
        .formatToParts(date)
        .filter(part => part.type !== 'literal')
        .map(part => [part.type, part.value])
    );
    return `${parts.year}-${parts.month}-${parts.day}`;
  } catch (error) {
    console.warn('[ServiceFolder] Invalid profile time zone; using the computer date:', error);
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  }
}

function formatServiceDate(value, { includeYear = true } = {}) {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return 'Undated files';
  const [year, month, day] = value.split('-').map(Number);
  return new Intl.DateTimeFormat('en-US', {
    month: 'long',
    day: 'numeric',
    ...(includeYear ? { year: 'numeric' } : {})
  }).format(new Date(Date.UTC(year, month - 1, day, 12)));
}

function isLoadStage() {
  return document.body.classList.contains('load-stage');
}

async function refreshDriveStatus() {
  if (!driveApiAvailable()) {
    state.drive.status = {
      configured: false,
      connection: null,
      message: 'This build does not include direct Google Drive connections.'
    };
    return state.drive.status;
  }
  try {
    const status = await window.api.getDriveStatus();
    state.drive.status = status && typeof status === 'object'
      ? status
      : { configured: false, connection: null };
    state.drive.error = null;
  } catch (error) {
    console.warn('[GoogleDrive] Could not read connection status:', error);
    state.drive.status = { configured: false, connection: null };
    state.drive.error = driveErrorMessage(error, 'Google Drive status is unavailable.');
  }
  return state.drive.status;
}

function requireCleanProfileForSourceChange() {
  if (!state.profileDirty) return true;
  openSettings('screens');
  elements.profileEditorStatus.textContent = 'Save or discard the venue changes before changing the automatic loading source.';
  setStatus('Venue setup changes are waiting to be saved or discarded');
  return false;
}

async function saveAutomaticLoadingSource({ localServiceFolder = null, driveConnectionId = null }) {
  const profileToSave = cloneValue(state.profile);
  profileToSave.localServiceFolder = localServiceFolder;
  profileToSave.driveConnectionId = driveConnectionId;
  const result = await window.api.saveSettings({ venueProfile: profileToSave });
  if (!result?.success || !result.venueProfile) {
    throw new Error('The automatic loading source could not be saved');
  }
  applyCommittedProfile(result.venueProfile);
  invalidateServiceFolderScan();
  state.serviceFolder.error = null;
  state.serviceFolder.folderChangedSinceLoad = Boolean(state.serviceFolder.current);
  return result.venueProfile;
}

async function activateDriveConnection(result, label) {
  const connection = result?.connection || result;
  if (!connection || typeof connection.id !== 'string') {
    throw new Error('Google Drive did not return a usable folder connection.');
  }
  const previousDriveId = state.profile?.driveConnectionId || null;
  try {
    await saveAutomaticLoadingSource({ driveConnectionId: connection.id });
  } catch (error) {
    await window.api.disconnectDrive({ connectionId: connection.id }).catch(() => {});
    throw error;
  }
  if (previousDriveId && previousDriveId !== connection.id) {
    await window.api.disconnectDrive({ connectionId: previousDriveId }).catch(error => {
      console.warn('[GoogleDrive] The previous connection could not be removed:', error);
    });
  }
  await refreshDriveStatus();
  setStatus(`${label} connected for automatic loading`);
  await scanLinkedServiceFolder({ reason: 'linked' });
}

async function connectPrivateDrive() {
  if (!driveApiAvailable() || state.drive.busy || state.serviceFolder.loading) return;
  if (!privateDriveIsConfigured()) {
    state.drive.error = 'Private Google Drive sign-in is not enabled in this copy of SyncShow.';
    renderServiceFolder();
    return;
  }
  if (!requireCleanProfileForSourceChange()) return;
  state.drive.busy = true;
  state.drive.error = null;
  renderServiceFolder();
  setStatus('Opening Google sign-in in your browser…');
  try {
    const result = await window.api.connectPrivateDrive();
    if (!result) {
      setStatus('Google Drive connection cancelled');
      return;
    }
    await activateDriveConnection(result, 'Private Google Drive folder');
  } catch (error) {
    const message = driveErrorMessage(error, 'Google Drive could not be connected.');
    if (/cancel(?:led|ed)/i.test(message)) {
      state.drive.error = null;
      setStatus('Google Drive connection cancelled');
    } else {
      console.error('[GoogleDrive] Private connection failed:', message);
      state.drive.error = message;
      setStatus(`Could not connect Google Drive: ${state.drive.error}`);
    }
  } finally {
    await refreshPrivateDriveOAuthState();
    state.drive.busy = false;
    renderServiceFolder();
  }
}

async function linkPublicDrive() {
  if (!driveApiAvailable() || state.drive.busy || state.serviceFolder.loading) return;
  if (!publicDriveIsConfigured()) {
    state.drive.error = 'Public Google Drive links are not enabled in this copy of SyncShow.';
    renderServiceFolder();
    return;
  }
  if (!requireCleanProfileForSourceChange()) return;
  const url = elements.publicDriveFolderUrl.value.trim();
  if (!url) {
    state.drive.error = 'Paste a public Google Drive folder link first.';
    renderServiceFolder();
    elements.publicDriveFolderUrl.focus();
    return;
  }
  state.drive.busy = true;
  state.drive.error = null;
  renderServiceFolder();
  setStatus('Checking the public Google Drive folder…');
  try {
    const result = await window.api.linkPublicDrive({ url });
    await activateDriveConnection(result, 'Public Google Drive folder');
    elements.publicDriveFolderUrl.value = '';
  } catch (error) {
    console.error('[GoogleDrive] Public link failed:', error);
    state.drive.error = driveErrorMessage(
      error,
      'That public Google Drive folder could not be connected.'
    );
    setStatus(`Could not use the public Drive folder: ${state.drive.error}`);
  } finally {
    state.drive.busy = false;
    renderServiceFolder();
  }
}

async function disconnectServiceSource() {
  if (state.drive.busy || state.serviceFolder.loading || !hasConfiguredServiceSource()) return;
  if (!requireCleanProfileForSourceChange()) return;
  const driveConnectionId = state.profile?.driveConnectionId || null;
  state.drive.busy = true;
  renderServiceFolder();
  try {
    await saveAutomaticLoadingSource({});
    if (driveConnectionId) {
      await window.api.disconnectDrive({ connectionId: driveConnectionId });
      await refreshDriveStatus();
    }
    setStatus('Automatic loading disconnected; the verified offline service copy was kept');
  } catch (error) {
    console.error('[ServiceSource] Disconnect failed:', error);
    state.drive.error = driveErrorMessage(
      error,
      'The automatic loading source could not be disconnected.'
    );
    setStatus(`Could not disconnect automatic loading: ${state.drive.error}`);
  } finally {
    state.drive.busy = false;
    renderServiceFolder();
  }
}

async function updateDrivePublishingPreference() {
  const connection = activeDriveConnection();
  if (!connection || connection.mode !== 'private' || state.drive.busy) return;
  const requested = elements.drivePublishingEnabled.checked;
  state.drive.busy = true;
  renderServiceFolder();
  try {
    const status = await window.api.setDrivePublishingEnabled(requested);
    state.drive.status = status && typeof status === 'object' ? status : state.drive.status;
    state.drive.error = null;
    setStatus(requested
      ? 'Drive publishing allowed; SyncShow will still change files only after an explicit Publish action'
      : 'Drive publishing turned off');
  } catch (error) {
    state.drive.error = driveErrorMessage(
      error,
      'The Drive publishing preference could not be changed.'
    );
    await refreshDriveStatus();
    setStatus(`Could not change Drive publishing: ${state.drive.error}`);
  } finally {
    state.drive.busy = false;
    renderServiceFolder();
  }
}

async function initializeServiceFolder() {
  state.serviceFolder.requestedDate = serviceDateForProfile();
  elements.serviceFolderDate.value = state.serviceFolder.requestedDate;
  await refreshDriveStatus();
  renderServiceFolder();
  if (!serviceFolderApiAvailable()) {
    state.serviceFolder.error = 'This build does not include automatic folder loading. You can still choose files on the Load cards.';
    renderServiceFolder();
    return;
  }

  try {
    const changeResult = await window.api.checkServiceSetChanges();
    state.serviceFolder.current = changeResult?.current || null;
    state.serviceFolder.sourceChanges = Array.isArray(changeResult?.changes) ? changeResult.changes : [];
    state.serviceFolder.folderChangedSinceLoad = state.serviceFolder.sourceChanges.length > 0;
  } catch (changeError) {
    // A source-drive problem should not make a verified offline snapshot
    // disappear. The fallback call still verifies the pinned local assets.
    console.warn('[ServiceFolder] Could not compare the source folder:', changeError);
    try {
      state.serviceFolder.current = await window.api.getCurrentServiceSet();
      state.serviceFolder.sourceChanges = [];
      state.serviceFolder.folderChangedSinceLoad = false;
    } catch (currentError) {
      console.warn('[ServiceFolder] The saved offline service could not be restored:', currentError);
      state.serviceFolder.current = null;
    }
  }

  renderServiceFolder();
  if (hasConfiguredServiceSource()) {
    await scanLinkedServiceFolder({ reason: 'startup' });
  } else {
    await maybeAutoLoadServiceSet('startup');
  }
}

async function chooseAndLinkServiceFolder() {
  if (!serviceFolderApiAvailable() || state.serviceFolder.loading) return;
  if (!requireCleanProfileForSourceChange()) return;

  elements.btnChooseServiceFolder.disabled = true;
  try {
    const folderPath = await window.api.chooseServiceFolder();
    if (!folderPath) return;
    const previousDriveId = state.profile?.driveConnectionId || null;
    await saveAutomaticLoadingSource({ localServiceFolder: folderPath });
    if (previousDriveId) {
      await window.api.disconnectDrive({ connectionId: previousDriveId }).catch(error => {
        console.warn('[GoogleDrive] The previous connection could not be removed:', error);
      });
      await refreshDriveStatus();
    }
    setStatus(`Linked ${folderBaseName(folderPath)} as the service folder`);
    await scanLinkedServiceFolder({ reason: 'linked' });
  } catch (error) {
    console.error('[ServiceFolder] Could not link folder:', error);
    state.serviceFolder.error = error.message || 'The service folder could not be linked.';
    renderServiceFolder();
    setStatus(`Could not link the service folder: ${state.serviceFolder.error}`);
  } finally {
    elements.btnChooseServiceFolder.disabled = false;
  }
}

async function chooseProfileServiceFolder() {
  if (!serviceFolderApiAvailable() || !state.profileDraft || state.profileSaveInFlight) return;
  try {
    const folderPath = await window.api.chooseServiceFolder();
    if (!folderPath) return;
    state.profileDraft.localServiceFolder = folderPath;
    state.profileDraft.driveConnectionId = null;
    elements.profileServiceFolder.value = folderPath;
    elements.profileServiceFolder.title = folderPath;
    markProfileDirty('Service folder changed in the draft. Save to let volunteers use it.');
  } catch (error) {
    elements.profileEditorStatus.textContent = `Could not choose the folder: ${error.message}`;
  }
}

async function scanLinkedServiceFolder({ reason = 'manual' } = {}) {
  if (!hasConfiguredServiceSource() || !serviceFolderApiAvailable()) {
    renderServiceFolder();
    return;
  }
  if (!isLoadStage()) {
    state.serviceFolder.folderChangedSinceLoad = true;
    renderServiceFolder();
    return;
  }
  if (state.serviceFolder.loading) {
    state.serviceFolder.folderChangedSinceLoad = true;
    renderServiceFolder();
    return;
  }

  const requestVersion = ++state.serviceFolder.scanVersion;
  const requestChangeEpoch = state.serviceFolder.changeEpoch;
  state.serviceFolder.scanning = true;
  state.serviceFolder.error = null;
  state.serviceFolder.requestedDate = elements.serviceFolderDate.value || serviceDateForProfile();
  elements.serviceFolderDate.value = state.serviceFolder.requestedDate;
  renderServiceFolder();
  if (reason !== 'startup') setStatus('Checking the automatic loading source for matching slideshows…');

  try {
    const scan = await window.api.scanServiceFolder({
      requestedDate: state.serviceFolder.requestedDate
    });
    if (requestVersion !== state.serviceFolder.scanVersion) return;
    if (scan?.success === false) throw new Error(scan.error || scan.message || 'The service folder could not be scanned');
    if (!scan || !Array.isArray(scan.sets) || typeof scan.scanToken !== 'string') {
      throw new Error('SyncShow received an incomplete service-folder scan');
    }

    state.serviceFolder.scan = scan;
    state.serviceFolder.scanToken = scan.scanToken;
    state.serviceFolder.scanEpoch = requestChangeEpoch;
    const previousSelectionExists = scan.sets.some(set => set.id === state.serviceFolder.selectedSetId);
    state.serviceFolder.selectedSetId = previousSelectionExists
      ? state.serviceFolder.selectedSetId
      : (scan.recommendedSetId || scan.sets[0]?.id || null);
    state.serviceFolder.error = null;
    const selected = getSelectedServiceSet();
    if (selected) {
      setStatus(selected.complete
        ? `Found a complete service for ${formatServiceDate(selected.serviceDate)}`
        : `Found service files for ${formatServiceDate(selected.serviceDate)}; review what is missing`);
    } else {
      setStatus('No matching slideshow files were found for that service date');
    }
  } catch (error) {
    if (requestVersion !== state.serviceFolder.scanVersion) return;
    console.error('[ServiceFolder] Scan failed:', error);
    state.serviceFolder.error = driveErrorMessage(error, 'The service folder is unavailable.');
    setStatus(`Could not check the service folder: ${state.serviceFolder.error}`);
  } finally {
    if (requestVersion === state.serviceFolder.scanVersion) {
      state.serviceFolder.scanning = false;
      renderServiceFolder();
    }
  }
  await maybeAutoLoadServiceSet(reason);
}

function handleServiceFolderChanged(event = {}) {
  const linkedFolder = state.profile?.localServiceFolder;
  if (!linkedFolder || (event.folderPath && event.folderPath !== linkedFolder)) return;
  state.serviceFolder.changeEpoch += 1;
  const hasLoadedService = Boolean(state.serviceFolder.current)
    || Object.values(state.presentations).some(presentation => presentation.loaded);
  if (hasLoadedService || state.serviceFolder.loading) {
    state.serviceFolder.folderChangedSinceLoad = true;
  }
  renderServiceFolder();

  if (!isLoadStage()) {
    setStatus('Newer service-folder files were detected. The live Show was not changed.');
    return;
  }
  if (state.serviceFolder.loading) {
    setStatus('Service-folder files changed while loading. The saved service will be rechecked before it replaces anything live.');
    return;
  }

  window.clearTimeout(state.serviceFolder.changeTimer);
  state.serviceFolder.changeTimer = window.setTimeout(() => {
    state.serviceFolder.changeTimer = null;
    scanLinkedServiceFolder({ reason: 'folder-change' });
  }, 450);
}

function resumeServiceFolderScanOnLoad() {
  if (!state.serviceFolder.folderChangedSinceLoad || !hasConfiguredServiceSource()) return;
  window.clearTimeout(state.serviceFolder.changeTimer);
  state.serviceFolder.changeTimer = window.setTimeout(() => {
    state.serviceFolder.changeTimer = null;
    scanLinkedServiceFolder({ reason: 'return-to-load' });
  }, 100);
}

function getSelectedServiceSet() {
  return state.serviceFolder.scan?.sets?.find(set => set.id === state.serviceFolder.selectedSetId) || null;
}

function setServiceScanStatus(kind, message) {
  elements.serviceFolderScanStatus.className = `service-scan-status${kind ? ` ${kind}` : ''}`;
  const copy = elements.serviceFolderScanStatus.querySelector('span:last-child');
  if (copy) copy.textContent = message;
}

function setServiceStateBadge(kind, message) {
  elements.serviceFolderStateBadge.className = `service-state-badge${kind ? ` ${kind}` : ''}`;
  elements.serviceFolderStateBadge.textContent = message;
}

function refreshServiceFolderConversionError() {
  const activeRoleIds = new Set(getDeckRoles().map(role => role.id));
  const failedRoleIds = [...new Set(state.serviceFolder.conversionFailedRoleIds)]
    .filter(roleId => activeRoleIds.has(roleId));
  state.serviceFolder.conversionFailedRoleIds = failedRoleIds;

  if (failedRoleIds.length === 0) {
    state.serviceFolder.conversionError = null;
    return null;
  }

  const labels = failedRoleIds.map(getRoleLabel);
  state.serviceFolder.conversionError =
    `${labels.join(', ')} could not be converted. ` +
    `Retry ${labels.length === 1 ? 'that slideshow' : 'those slideshows'} or choose another file.`;
  return state.serviceFolder.conversionError;
}

function serviceFolderErrorMessage() {
  return state.serviceFolder.error || state.serviceFolder.conversionError || null;
}

function serviceSetHasLoadableInput(serviceSet) {
  return Boolean(serviceSet && Object.values(serviceSet.inputs || {}).some(input => input?.available));
}

function presentationConversionInFlight() {
  return Object.values(state.presentations).some(presentation => presentation.pending);
}

function serviceSetHasUnavailableInput(serviceSet) {
  return Boolean(serviceSet && (
    serviceSet.unavailableRoleIds?.length > 0
    || Object.values(serviceSet.inputs || {}).some(input => input && input.available !== true)
  ));
}

function selectedServiceSetCanBePinned(serviceSet) {
  return Boolean(
    serviceSet
    && !state.serviceFolder.error
    && typeof state.serviceFolder.scanToken === 'string'
    && state.serviceFolder.scanEpoch === state.serviceFolder.changeEpoch
    && serviceSetHasLoadableInput(serviceSet)
    && !serviceSetHasUnavailableInput(serviceSet)
  );
}

function shouldUseSavedServiceFallback(serviceSet) {
  return Boolean(state.serviceFolder.current && !selectedServiceSetCanBePinned(serviceSet));
}

async function maybeAutoLoadServiceSet(reason) {
  const automaticLoadReasons = new Set(['startup', 'linked', 'date', 'profile-save']);
  const hasOperatorOwnedPresentation = Object.values(state.presentations).some(
    presentation => presentation?.loaded
      && (presentation.source === 'manual' || presentation.source === 'prepared')
  );
  if (!automaticLoadReasons.has(reason)
    || state.serviceFolder.loading
    || presentationConversionInFlight()
    || hasOperatorOwnedPresentation
    || state.isPresenting
    || !isLoadStage()) return false;

  const selectedSet = getSelectedServiceSet();
  const ambiguous = Boolean(selectedSet?.warnings?.some(
    warning => warning?.code === 'AMBIGUOUS_ROLE_FILES'
  ));
  const selectedDateIsSafe = Boolean(selectedSet && (
    selectedSet.dateStatus === 'matches'
    || selectedSet.dateStatus === 'not-applicable'
  ));
  const savedDateIsSafe = Boolean(
    state.serviceFolder.current
    && state.serviceFolder.current.serviceDate === state.serviceFolder.requestedDate
  );
  const canLoadFresh = selectedDateIsSafe
    && !ambiguous
    && selectedServiceSetCanBePinned(selectedSet);
  const canLoadSaved = !canLoadFresh
    && savedDateIsSafe
    && shouldUseSavedServiceFallback(selectedSet);
  if (!canLoadFresh && !canLoadSaved) return false;

  await loadSelectedServiceSet();
  return true;
}

function renderServiceSetChoices(scan, selectedSet) {
  elements.serviceSetChoiceRow.hidden = scan.sets.length < 2;
  elements.serviceSetSelect.replaceChildren();
  for (const serviceSet of scan.sets) {
    const option = document.createElement('option');
    option.value = serviceSet.id;
    const dateLabel = formatServiceDate(serviceSet.serviceDate);
    option.textContent = serviceSet.complete ? `${dateLabel} — all expected files` : `${dateLabel} — some files missing`;
    option.selected = serviceSet.id === selectedSet?.id;
    elements.serviceSetSelect.appendChild(option);
  }
}

function renderServiceRoleSummary(scan, selectedSet) {
  elements.serviceSetRoleSummary.replaceChildren();
  for (const role of scan.inputRoles || []) {
    const candidate = selectedSet.inputs?.[role.id] || null;
    const availabilityClass = !candidate ? 'missing' : (candidate.available ? 'ready' : 'unavailable');
    const item = createElement('li', `service-role-file ${availabilityClass}`);
    const mark = createElement('span', 'role-dot', roleInitials(role.label));
    mark.setAttribute('aria-hidden', 'true');
    const copy = createElement('span', 'service-role-file-copy');
    copy.append(
      createElement('strong', '', role.label),
      createElement('small', '', candidate?.name || (role.required ? 'Expected file not found' : 'Optional file not found'))
    );
    const status = createElement(
      'span',
      'service-role-state',
      !candidate ? 'Missing' : (candidate.available ? 'Found' : 'Needs download')
    );
    item.append(mark, copy, status);
    elements.serviceSetRoleSummary.appendChild(item);
  }
}

function serviceSetWarnings(scan, selectedSet) {
  const warnings = [];
  if (selectedSet.dateStatus !== 'not-applicable'
    && selectedSet.serviceDate !== scan.requestedDate) {
    warnings.push({
      kind: 'warning',
      text: selectedSet.serviceDate
        ? `These files are dated ${formatServiceDate(selectedSet.serviceDate)}, not the selected service date (${formatServiceDate(scan.requestedDate)}).`
        : `These files have no recognized date. Confirm that they are for ${formatServiceDate(scan.requestedDate)} before starting.`
    });
  }

  if (selectedSet.missingRoleIds?.length) {
    warnings.push({
      kind: 'warning',
      text: `${selectedSet.missingRoleIds.map(roleId => getRoleLabel(roleId)).join(', ')} ${selectedSet.missingRoleIds.length === 1 ? 'was' : 'were'} not found for this date. Load what is available, then choose any missing file on its Load card.`
    });
  }
  if (selectedSet.unavailableRoleIds?.length) {
    warnings.push({
      kind: 'warning',
      text: `${selectedSet.unavailableRoleIds.map(roleId => getRoleLabel(roleId)).join(', ')} must finish downloading before SyncShow can make an offline copy.`
    });
    if (state.serviceFolder.current) {
      warnings.push({
        kind: 'info',
        text: `Load saved service will use the verified offline copy from ${formatServiceDate(state.serviceFolder.current.serviceDate)} until those files finish downloading.`
      });
    }
  }
  if (state.serviceFolder.scanEpoch !== state.serviceFolder.changeEpoch) {
    warnings.push({
      kind: 'info',
      text: state.serviceFolder.current
        ? 'The folder changed after these results were found. SyncShow is rechecking it; the saved service remains available.'
        : 'The folder changed after these results were found. Wait for SyncShow to finish rechecking before loading.'
    });
  }

  for (const warning of selectedSet.warnings || []) {
    if (warning.code === 'MULTIPLE_ROLE_FILES') {
      warnings.push({
        kind: 'info',
        text: `More than one ${getRoleLabel(warning.roleId)} file matched. SyncShow will use ${warning.selected}.`
      });
    }
    if (warning.code === 'AMBIGUOUS_ROLE_FILES') {
      warnings.push({
        kind: 'info',
        text: 'Some slideshows could not be assigned confidently. Choose those files on their Load cards.'
      });
    }
  }
  return warnings;
}

function serviceSourceView() {
  const localPath = state.profile?.localServiceFolder || null;
  if (localPath) {
    return {
      linked: true,
      kind: 'local',
      name: folderBaseName(localPath),
      detail: localPath,
      scanLabel: folderBaseName(localPath)
    };
  }
  if (state.profile?.driveConnectionId) {
    const connection = activeDriveConnection();
    if (!connection) {
      return {
        linked: true,
        kind: 'drive-missing',
        name: 'Google Drive needs reconnecting',
        detail: 'The saved connection is unavailable on this computer.',
        scanLabel: 'Google Drive'
      };
    }
    const isPublic = connection.mode === 'public';
    const account = connection.accountEmail || connection.accountLabel || null;
    const folderName = connection.folderName || connection.name || 'Google Drive folder';
    return {
      linked: true,
      kind: isPublic ? 'drive-public' : 'drive-private',
      name: folderName,
      detail: isPublic
        ? 'Public link · view-only'
        : `${account ? `${account} · ` : ''}${connection.canWrite ? 'Can publish' : 'Load only'}`,
      scanLabel: folderName,
      connection
    };
  }
  return {
    linked: false,
    kind: 'none',
    name: 'No source connected',
    detail: 'Choose Google Drive or a folder on this computer.',
    scanLabel: 'shared folder'
  };
}

function renderLoadSourceSummary() {
  if (!elements.loadAutoStatus) return;
  let kind = '';
  let message = 'Automatic loading is not set up';
  const automaticPresentationLoaded = Object.values(state.presentations)
    .some(presentation => presentation.loaded && presentation.source === 'folder');

  if (state.serviceFolder.loading) {
    kind = 'working';
    message = 'Loading synced slideshows…';
  } else if (state.serviceFolder.scanning) {
    kind = 'working';
    message = 'Checking the shared folder…';
  } else if (state.serviceFolder.folderChangedSinceLoad) {
    kind = 'attention';
    message = 'New synced files need review';
  } else if (serviceFolderErrorMessage()) {
    kind = 'attention';
    message = state.serviceFolder.current && automaticPresentationLoaded
      ? 'Using the saved service copy'
      : 'Automatic loading needs Admin Settings';
  } else if (state.serviceFolder.current && automaticPresentationLoaded) {
    kind = 'ready';
    message = `Loaded automatically · ${formatServiceDate(state.serviceFolder.current.serviceDate, { includeYear: false })}`;
  } else if (state.serviceFolder.current) {
    kind = 'attention';
    message = state.serviceFolder.current.serviceDate === state.serviceFolder.requestedDate
      ? 'Saved service is ready to load'
      : `Saved service is from ${formatServiceDate(state.serviceFolder.current.serviceDate, { includeYear: false })}`;
  } else if (hasConfiguredServiceSource()) {
    kind = 'ready';
    message = 'Automatic loading is ready';
  }

  elements.loadAutoStatus.className = `load-auto-status${kind ? ` ${kind}` : ''}`;
  elements.loadAutoStatus.textContent = message;
}

function renderServiceFolder() {
  renderLoadSourceSummary();
  const source = serviceSourceView();
  const folderLinked = source.linked;
  const privateDriveReady = privateDriveIsConfigured();
  const publicDriveReady = publicDriveIsConfigured();
  const conversionInFlight = presentationConversionInFlight();
  const serviceError = serviceFolderErrorMessage();
  const sourceBusy = state.profileSaveInFlight
    || state.drive.busy
    || state.serviceFolder.scanning
    || state.serviceFolder.loading;
  elements.btnRefreshServiceFolder.disabled = !folderLinked || sourceBusy;
  elements.btnChooseServiceFolder.disabled = sourceBusy;
  elements.btnConnectPrivateDrive.disabled = sourceBusy || !privateDriveReady;
  elements.btnConnectPrivateDrive.classList.toggle('is-unavailable', !privateDriveReady);
  elements.privateDriveSourceHelp.textContent = privateDriveReady
    ? 'Sign in and choose one folder'
    : 'Not enabled in this copy of SyncShow';
  elements.publicDriveFolderUrl.disabled = sourceBusy || !publicDriveReady;
  elements.btnLinkPublicDrive.disabled = sourceBusy || !publicDriveReady;
  elements.btnLinkPublicDrive.textContent = publicDriveReady ? 'Connect' : 'Unavailable';
  elements.publicDriveFolderUrl.placeholder = publicDriveReady
    ? 'Paste a public Google Drive folder link'
    : 'Public Drive is not enabled';
  elements.publicDriveSourceOption.classList.toggle('is-unavailable', !publicDriveReady);
  elements.publicDriveSourceOption.setAttribute('aria-disabled', String(!publicDriveReady));
  elements.publicDriveSourceHelp.textContent = publicDriveReady
    ? 'No sign-in · view-only'
    : 'Not enabled in this copy of SyncShow';
  elements.btnDisconnectServiceSource.hidden = !folderLinked;
  elements.btnDisconnectServiceSource.disabled = sourceBusy;
  elements.serviceFolderDate.disabled = state.serviceFolder.scanning || state.serviceFolder.loading;
  elements.serviceFolderLocation.classList.toggle('is-linked', folderLinked);
  elements.serviceFolderName.textContent = source.name;
  elements.serviceFolderPath.textContent = source.detail;
  elements.serviceFolderLocation.title = source.detail;

  const connection = source.connection || null;
  const publishingAvailable = Boolean(
    connection
    && connection.mode === 'private'
    && connection.canWrite === true
  );
  elements.drivePublishingControl.hidden = !publishingAvailable;
  elements.drivePublishingEnabled.disabled = sourceBusy;
  elements.drivePublishingEnabled.checked = publishingAvailable
    && connection.publishingEnabled === true;
  elements.drivePublishingHelp.textContent = publishingAvailable
    ? (connection.publishingEnabled
      ? 'Allowed for explicit Publish actions. Background loading never changes Drive files.'
      : 'Off by default. Background loading never changes Drive files.')
    : 'This Drive connection can load files but cannot publish to the selected folder.';

  const configurationMessages = [];
  if (!privateDriveReady && !publicDriveReady) {
    configurationMessages.push(
      'Google Drive is not enabled in this copy of SyncShow. Install a Drive-enabled build, or choose a folder on this computer.'
    );
  } else if (!privateDriveReady) {
    configurationMessages.push('Private Google Drive sign-in is not enabled in this copy of SyncShow.');
  } else if (!publicDriveReady) {
    configurationMessages.push('Public Google Drive links are not enabled in this copy of SyncShow.');
  }
  if (state.drive.status?.configurationError) {
    configurationMessages.push('The Google Drive setup in this copy of SyncShow is invalid.');
  }
  if (state.drive.error) configurationMessages.push(state.drive.error);
  elements.driveSetupNotice.hidden = configurationMessages.length === 0;
  elements.driveSetupNotice.textContent = configurationMessages.join(' ');

  if (!folderLinked) {
    elements.serviceFolderCard.dataset.state = 'unlinked';
    const current = state.serviceFolder.current;
    setServiceStateBadge(current ? 'ready' : '', current ? 'Offline copy saved' : 'Not linked');
    setServiceScanStatus(
      current ? 'ready' : '',
      current
        ? `${formatServiceDate(current.serviceDate)} is saved locally. Link the shared folder to check for newer files.`
        : 'Connect a source once, then SyncShow will populate the volunteer Load cards automatically.'
    );
    elements.serviceSetResults.hidden = !current;
    elements.serviceSetChoiceRow.hidden = true;
    elements.serviceSetRoleSummary.replaceChildren();
    elements.serviceSetWarnings.replaceChildren();
    elements.btnLoadServiceSet.disabled = !current || state.serviceFolder.loading || conversionInFlight;
    elements.btnLoadServiceSet.textContent = current ? 'Load saved service' : 'Load found service';
    elements.serviceSetOfflineState.hidden = !current;
    if (current) {
      elements.serviceSetOfflineState.textContent = `✓ ${formatServiceDate(current.serviceDate)} is saved locally and can run without the shared folder.`;
    }
    elements.serviceSetChangedNotice.hidden = true;
    return;
  }

  if (state.serviceFolder.loading) {
    elements.serviceFolderCard.dataset.state = 'scanning';
    setServiceStateBadge('scanning', 'Loading service…');
    setServiceScanStatus('scanning', 'Saving a local copy, then preparing each slideshow. The previous loaded files stay safe until replacements are ready.');
  } else if (state.serviceFolder.scanning) {
    elements.serviceFolderCard.dataset.state = 'scanning';
    setServiceStateBadge('scanning', 'Checking files…');
    setServiceScanStatus('scanning', `Checking ${source.scanLabel} for ${formatServiceDate(state.serviceFolder.requestedDate)}…`);
  } else if (serviceError) {
    elements.serviceFolderCard.dataset.state = 'error';
    setServiceStateBadge('attention', 'Needs attention');
    setServiceScanStatus('error', serviceError);
  }

  const scan = state.serviceFolder.scan;
  const selectedSet = getSelectedServiceSet();
  if (!scan || !selectedSet) {
    if (!state.serviceFolder.scanning && !state.serviceFolder.loading && !serviceError) {
      elements.serviceFolderCard.dataset.state = 'attention';
      setServiceStateBadge('attention', 'No service found');
      setServiceScanStatus('attention', `No matching PowerPoints were found for ${formatServiceDate(state.serviceFolder.requestedDate)}. Choose files on their Load cards or try another date.`);
    }
    elements.serviceSetResults.hidden = !state.serviceFolder.current && !state.serviceFolder.folderChangedSinceLoad;
    elements.serviceSetRoleSummary.replaceChildren();
    elements.serviceSetWarnings.replaceChildren();
    elements.btnLoadServiceSet.disabled = !state.serviceFolder.current
      || state.serviceFolder.loading
      || conversionInFlight;
  } else {
    elements.serviceSetResults.hidden = false;
    if (!state.serviceFolder.scanning && !state.serviceFolder.loading && !serviceError) {
      const ready = selectedSet.complete
        && (selectedSet.dateStatus === 'matches' || selectedSet.dateStatus === 'not-applicable');
      elements.serviceFolderCard.dataset.state = ready ? 'ready' : 'attention';
      setServiceStateBadge(ready ? 'ready' : 'attention', ready ? 'Ready to load' : 'Review files');
      const foundCount = Object.values(selectedSet.inputs || {}).filter(Boolean).length;
      setServiceScanStatus(
        ready ? 'ready' : 'attention',
        `Found ${foundCount} ${foundCount === 1 ? 'slideshow' : 'slideshows'} together for ${formatServiceDate(selectedSet.serviceDate)}.`
      );
    }
    renderServiceSetChoices(scan, selectedSet);
    renderServiceRoleSummary(scan, selectedSet);
    elements.serviceSetWarnings.replaceChildren(...serviceSetWarnings(scan, selectedSet).map(warning =>
      createElement('p', `service-set-warning${warning.kind === 'info' ? ' info' : ''}`, warning.text)
    ));
    const canPinSelectedSet = selectedServiceSetCanBePinned(selectedSet);
    const canLoadSavedFallback = Boolean(state.serviceFolder.current && !canPinSelectedSet);
    elements.btnLoadServiceSet.disabled = state.serviceFolder.scanning
      || state.serviceFolder.loading
      || conversionInFlight
      || (!canPinSelectedSet && !canLoadSavedFallback);
  }

  const current = state.serviceFolder.current;
  elements.serviceSetOfflineState.hidden = !current;
  if (current) {
    elements.serviceSetOfflineState.textContent = `✓ ${formatServiceDate(current.serviceDate)} is saved locally and can run if the linked folder goes offline.`;
  }

  const changes = state.serviceFolder.sourceChanges;
  elements.serviceSetChangedNotice.hidden = !state.serviceFolder.folderChangedSinceLoad;
  if (state.serviceFolder.folderChangedSinceLoad) {
    elements.serviceSetChangedNotice.textContent = changes.length > 0
      ? `${changes.length === 1 ? changes[0].sourceName : `${changes.length} source files`} changed since the saved service was loaded. Review and load again to use the newer version.`
      : 'Newer files were detected in the linked folder. The loaded service was not replaced; review and load again when you are ready.';
  }

  const usesSavedFallback = shouldUseSavedServiceFallback(selectedSet);
  elements.btnLoadServiceSet.textContent = state.serviceFolder.loading
    ? 'Loading service…'
    : (usesSavedFallback ? 'Load saved service' : 'Load found service');
}

function clearPresentationRole(roleId, message = 'Not included in this service') {
  state.presentations[roleId] = emptyPresentation();
  delete state.presentationConversionRecovery[roleId];
  state.serviceFolder.conversionFailedRoleIds =
    state.serviceFolder.conversionFailedRoleIds
      .filter(failedRoleId => failedRoleId !== roleId);
  refreshServiceFolderConversionError();
  state.serviceFolder.staleRoleIds = state.serviceFolder.staleRoleIds
    .filter(staleRoleId => staleRoleId !== roleId);

  const roleElements = presentationElements[roleId];
  if (!roleElements) return;
  roleElements.path.value = '';
  roleElements.path.title = '';
  roleElements.dateWarning.style.display = 'none';
  updateConversionStatus(roleId, message, false);
  renderPresentationConversionRecovery(roleId);
  refreshServiceRoleActions();
}

async function loadSelectedServiceSet() {
  const selectedSet = getSelectedServiceSet();
  const canPinSelectedSet = selectedServiceSetCanBePinned(selectedSet);
  const useSavedFallback = shouldUseSavedServiceFallback(selectedSet);
  if ((!canPinSelectedSet && !useSavedFallback)
    || state.serviceFolder.loading
    || presentationConversionInFlight()
    || state.isPresenting
    || !isLoadStage()) return;
  const loadedScanEpoch = state.serviceFolder.scanEpoch;
  resetServiceOutputChoices({ refresh: true });
  state.serviceFolder.loading = true;
  state.serviceFolder.error = null;
  state.serviceFolder.conversionError = null;
  state.serviceFolder.conversionFailedRoleIds = [];
  setManualFileControlsDisabled(true);
  setProfileEditorSaving(true);
  renderServiceFolder();
  setStatus(useSavedFallback
    ? 'Loading the saved offline service…'
    : 'Saving a local copy of the service files…');

  try {
    const manifest = useSavedFallback
      ? state.serviceFolder.current
      : await window.api.pinServiceSet({
        scanToken: state.serviceFolder.scanToken,
        setId: selectedSet.id
      });
    if (manifest?.success === false) throw new Error(manifest.error || manifest.message || 'The service could not be saved locally');
    if (!manifest?.inputs || typeof manifest.inputs !== 'object') {
      throw new Error('SyncShow did not receive the saved service files');
    }
    const activeRoles = getDeckRoles();
    const orderedInputs = activeRoles
      .map(role => manifest.inputs[role.id])
      .filter(Boolean);
    if (orderedInputs.length === 0) {
      throw new Error('The saved service does not contain any inputs used by this venue profile. Refresh the folder or choose files manually.');
    }
    state.serviceFolder.current = manifest;
    state.restoreGroupId = manifest.id;

    // Selecting a new service is an explicit boundary. Roles omitted from an
    // incomplete set must become genuinely unloaded; otherwise an older deck
    // could be mistaken for part of today's service. Missing outputs are then
    // handled by the Start dialog's upload, mirror, next-text, or disable choices.
    const manifestRoleIds = new Set(orderedInputs.map(input => input.roleId));
    const omittedRoles = activeRoles.filter(role => !manifestRoleIds.has(role.id));
    for (const role of omittedRoles) {
      clearPresentationRole(role.id, 'Not included in this service · choose manually or decide at Start');
    }

    let loadedCount = 0;
    const failedLabels = [];
    const staleRoleIds = new Set(state.serviceFolder.staleRoleIds);
    for (const input of orderedInputs) {
      const previousPresentation = state.presentations[input.roleId];
      const wouldPreserveDifferentFile = previousPresentation?.loaded
        && previousPresentation.path !== input.pinnedPath;
      const loaded = await loadPresentationFile(input.roleId, input.pinnedPath, {
        displayPath: input.sourceName,
        dateSource: input.sourceName,
        offline: true,
        source: 'folder',
        restoreGroupId: manifest.id
      });
      if (loaded) {
        loadedCount += 1;
        staleRoleIds.delete(input.roleId);
      } else {
        failedLabels.push(getRoleLabel(input.roleId));
        if (wouldPreserveDifferentFile) staleRoleIds.add(input.roleId);
      }
    }
    state.serviceFolder.staleRoleIds = [...staleRoleIds];
    renderThumbnails();

    if (!useSavedFallback) {
      const noNewerFolderEvent = loadedScanEpoch !== null
        && loadedScanEpoch === state.serviceFolder.changeEpoch;
      if (noNewerFolderEvent) {
        state.serviceFolder.sourceChanges = [];
        state.serviceFolder.folderChangedSinceLoad = false;
      } else {
        state.serviceFolder.folderChangedSinceLoad = true;
      }
    }
    if (failedLabels.length > 0) {
      refreshServiceFolderConversionError();
      setStatus(`Loaded ${loadedCount} service ${loadedCount === 1 ? 'slideshow' : 'slideshows'}; ${failedLabels.join(', ')} needs attention`);
    } else if (omittedRoles.length > 0) {
      setStatus(`Service loaded: ${loadedCount} ready; ${omittedRoles.map(role => role.label).join(', ')} will be chosen manually or decided at Start`);
    } else {
      setStatus(`Service loaded: ${loadedCount} ${loadedCount === 1 ? 'slideshow' : 'slideshows'} ready from the local copy`);
    }
  } catch (error) {
    console.error('[ServiceFolder] Could not load selected service:', error);
    state.serviceFolder.error = driveErrorMessage(error, 'The service could not be loaded.');
    state.serviceFolder.folderChangedSinceLoad = true;
    setStatus(`Could not load the found service: ${state.serviceFolder.error}`);
  } finally {
    state.serviceFolder.loading = false;
    setManualFileControlsDisabled(false);
    setProfileEditorSaving(false);
    renderServiceFolder();
    checkReadyState();
    if (state.serviceFolder.folderChangedSinceLoad
      && hasConfiguredServiceSource()
      && isLoadStage()) {
      window.clearTimeout(state.serviceFolder.changeTimer);
      state.serviceFolder.changeTimer = window.setTimeout(() => {
        state.serviceFolder.changeTimer = null;
        scanLinkedServiceFolder({ reason: 'post-load-change' });
      }, 100);
    }
  }
}

function decisionSourceRole(output, decision) {
  if (!decision || decision.mode === 'disabled') return null;
  return decision.mode === 'direct' ? output.expectedRole : decision.sourceRole;
}

function getServiceOutputDecision(output) {
  const decision = window.SyncShowServiceOutputPlan.resolveDecision(
    output,
    state.presentations,
    state.serviceOutputDecisions
  );
  if (!decision || decision.mode === 'disabled') return decision;
  const sourceRole = decisionSourceRole(output, decision);
  return state.presentations[sourceRole]?.loaded ? decision : null;
}

function useOnlyRoleForService(roleId) {
  const presentation = state.presentations[roleId];
  const outputs = getConfiguredOutputs();
  if (!presentation?.loaded || !outputs.some(output => output.expectedRole === roleId)) return;

  if (state.singleServiceRoleId === roleId) {
    resetServiceOutputChoices({ refresh: true });
    setStatus('Using the configured screens for this service');
    return;
  }

  state.serviceOutputDecisions = window.SyncShowServiceOutputPlan
    .createOnlyRoleDecisions(outputs, roleId);
  state.singleServiceRoleId = roleId;
  refreshServiceRoleActions();
  checkReadyState();
  setStatus(`Using only the ${getRoleLabel(roleId)} slideshow for this service`);
}

function addServiceRouteOption(select, value, text) {
  const option = document.createElement('option');
  option.value = value;
  option.textContent = text;
  select.appendChild(option);
}

function setSingerServiceRoute(output, routeValue) {
  const decision = window.SyncShowServiceOutputPlan.routeValueToDecision(routeValue);
  if (decision) {
    state.serviceOutputDecisions[output.id] = decision;
  } else {
    delete state.serviceOutputDecisions[output.id];
  }

  if (state.singleServiceRoleId) {
    const sourceRole = decisionSourceRole(output, decision);
    if (!decision || (sourceRole && sourceRole !== state.singleServiceRoleId)) {
      state.singleServiceRoleId = null;
    }
  }

  refreshServiceRoleActions();
  checkReadyState();
  const effective = getServiceOutputDecision(output);
  setStatus(`${output.name}: ${describePreflightDecision(output, effective)}`);
}

function renderRoleServiceActions(role, container) {
  if (!container) return;
  container.replaceChildren();

  const roleElements = presentationElements[role.id];
  const presentation = state.presentations[role.id];
  const outputs = getConfiguredOutputs();
  const assignedOutputs = outputs.filter(output => output.expectedRole === role.id);
  const singerOutputs = assignedOutputs.filter(output => output.kind === 'singer');
  const selectedOnly = state.singleServiceRoleId === role.id;
  const excludedByPreset = Boolean(state.singleServiceRoleId && !selectedOnly);
  roleElements?.card?.classList.toggle('service-role-excluded', excludedByPreset);

  if (assignedOutputs.length > 0 && presentation?.loaded) {
    const onlyButton = createElement(
      'button',
      `btn btn-quiet btn-compact service-only-button${selectedOnly ? ' active' : ''}`,
      selectedOnly ? 'Use all configured slideshows' : 'Use only this slideshow today'
    );
    onlyButton.type = 'button';
    onlyButton.disabled = !presentation?.loaded || state.isPresenting || state.isStarting;
    onlyButton.setAttribute(
      'aria-label',
      selectedOnly
        ? 'Restore the configured slideshows for this service'
        : `Use only the ${role.label} slideshow for this service`
    );
    onlyButton.addEventListener('click', () => useOnlyRoleForService(role.id));
    container.appendChild(onlyButton);

    const note = createElement(
      'small',
      'service-choice-note',
      excludedByPreset
        ? 'Off for this service. The loaded file and Admin Settings stay unchanged.'
        : selectedOnly
          ? 'Other slideshow outputs are off for this service only.'
          : 'Affects this service only—not Admin Settings.'
    );
    container.appendChild(note);
  }

  if (singerOutputs.length === 0) return;
  const loadedRoles = getLoadedRoles();
  const textRoles = getLoadedRoles({ requireExtractedText: true });

  for (const output of singerOutputs) {
    const label = createElement('label', 'service-singer-route');
    const title = createElement('span', '', output.name);
    const select = createElement('select', 'display-dropdown');
    select.setAttribute('aria-label', `${output.name} source for this service`);

    addServiceRouteOption(
      select,
      'default',
      presentation?.loaded
        ? `Use the loaded ${role.label} slideshow`
        : 'Choose when Start Show is clicked'
    );
    for (const sourceRole of loadedRoles) {
      if (textRoles.includes(sourceRole)) {
        addServiceRouteOption(
          select,
          `derive-next-text:${sourceRole}`,
          `Next-text view from ${getRoleLabel(sourceRole)}`
        );
      }
      addServiceRouteOption(
        select,
        `mirror:${sourceRole}`,
        `Show ${getRoleLabel(sourceRole)} slides as-is`
      );
    }
    addServiceRouteOption(select, 'disabled', `Turn off ${output.name} for this service`);

    const explicit = state.serviceOutputDecisions[output.id];
    const routeValue = explicit?.mode === 'direct' && presentation?.loaded
      ? 'default'
      : window.SyncShowServiceOutputPlan.decisionToRouteValue(explicit);
    if ([...select.options].some(option => option.value === routeValue)) {
      select.value = routeValue;
    }
    select.disabled = state.isPresenting || state.isStarting;
    select.addEventListener('change', () => setSingerServiceRoute(output, select.value));
    label.append(title, select);
    container.appendChild(label);
  }
}

function refreshServiceRoleActions() {
  for (const role of getDeckRoles()) {
    renderRoleServiceActions(role, presentationElements[role.id]?.serviceActions);
  }
}

function renderInputCards() {
  elements.inputCards.replaceChildren();
  for (const key of Object.keys(presentationElements)) delete presentationElements[key];

  const fragment = document.createDocumentFragment();
  getDeckRoles().forEach((role, index) => {
    const card = createElement('article', 'setup-card deck-card');
    card.dataset.roleId = role.id;
    card.style.setProperty('--role-accent-index', String(index % 6));

    const heading = createElement('div', 'card-heading');
    const mark = createElement('span', 'language-mark role-mark', roleInitials(role.label));
    mark.setAttribute('aria-hidden', 'true');
    const copy = createElement('div');
    const title = createElement('h3', '', role.label);
    const description = createElement(
      'p',
      '',
      role.required === 'optional'
        ? 'Optional slideshow'
        : 'Service slideshow'
    );
    copy.append(title, description);
    const stateBadge = createElement('span', 'card-state-badge', 'Needs a slideshow');
    heading.append(mark, copy, stateBadge);

    const selector = createElement('div', 'file-selector');
    const pathInput = createElement('input', 'file-path');
    pathInput.type = 'text';
    pathInput.readOnly = true;
    pathInput.placeholder = 'No slideshow loaded';
    pathInput.setAttribute('aria-label', `${role.label} selected file`);
    const selectButton = createElement('button', 'btn btn-outline', 'Choose slideshow');
    selectButton.type = 'button';
    selectButton.setAttribute('aria-label', `Choose ${role.label} slideshow`);
    selectButton.addEventListener('click', () => selectFile(role.id));
    selector.append(pathInput, selectButton);

    const status = createElement('div', 'conversion-status');
    status.setAttribute('aria-live', 'polite');
    const statusText = createElement('span', 'status-text', 'Choose one now, or decide when starting.');
    const progressBar = createElement('div', 'progress-bar');
    progressBar.style.display = 'none';
    const progress = createElement('div', 'progress-fill');
    progressBar.appendChild(progress);
    const conversionRecovery = createElement('div', 'conversion-recovery');
    conversionRecovery.hidden = true;
    const retryConversionButton = createElement(
      'button',
      'btn btn-outline btn-compact',
      'I closed PowerPoint — retry'
    );
    retryConversionButton.type = 'button';
    retryConversionButton.setAttribute(
      'aria-label',
      `Retry the ${role.label} slideshow after closing PowerPoint`
    );
    retryConversionButton.addEventListener(
      'click',
      () => retryPresentationConversion(role.id)
    );
    conversionRecovery.appendChild(retryConversionButton);
    status.append(statusText, progressBar, conversionRecovery);
    const dateWarning = createElement('div', 'date-warning');
    dateWarning.style.display = 'none';
    const serviceActions = createElement('div', 'service-role-actions');

    card.append(heading, selector, status, dateWarning, serviceActions);
    fragment.appendChild(card);
    presentationElements[role.id] = {
      path: pathInput,
      selectButton,
      status,
      progress,
      conversionRecovery,
      retryConversionButton,
      dateWarning,
      card,
      stateBadge,
      serviceActions
    };

    const presentation = state.presentations[role.id];
    if (presentation?.path || presentation?.prepared) {
      const displayName = presentation.displayPath || presentation.path;
      pathInput.value = presentation.prepared ? displayName : folderBaseName(displayName);
      pathInput.title = presentation.prepared
        ? `${presentation.displayPath || 'Prepared service'} — built in SyncShow`
        : presentation.offline
        ? `${presentation.displayPath || presentation.path} — saved locally`
        : presentation.path;
    }
    if (presentation?.loaded) {
      selectButton.textContent = 'Change';
      updateConversionStatus(
        role.id,
        presentation.prepared
          ? `✓ Ready · ${presentation.slideCount} slides · Prepared in SyncShow`
          : presentation.source === 'folder' || presentation.offline
          ? `✓ Ready · ${presentation.slideCount} slides · Loaded automatically`
          : presentation.source === 'restored'
          ? `✓ Ready · ${presentation.slideCount} slides · Restored from the last session`
          : `✓ Ready · ${presentation.slideCount} slides · Chosen on this computer`,
        false
      );
      if (presentation.path) checkFilenameDate(role.id, presentation.dateSource || presentation.path);
    }
    const recovery = state.presentationConversionRecovery[role.id];
    if (recovery) {
      const stillUsing = presentation?.loaded
        ? ` Still using ${presentation.slideCount} previously loaded slides.`
        : '';
      updateConversionStatus(role.id, `✗ ${recovery.message}${stillUsing}`, false);
    }
    renderPresentationConversionRecovery(role.id);
  });
  elements.inputCards.appendChild(fragment);
  placeServiceInputCards();
  refreshServiceRoleActions();
}

function populateSingerSourceOptions(selectedRoleId) {
  const previous = selectedRoleId || elements.singerLanguage.value;
  elements.singerLanguage.replaceChildren();
  for (const role of getDeckRoles(state.profileDraft || state.profile)) {
    const option = document.createElement('option');
    option.value = role.id;
    option.textContent = `${role.label} slides`;
    elements.singerLanguage.appendChild(option);
  }
  if ([...elements.singerLanguage.options].some(option => option.value === previous)) {
    elements.singerLanguage.value = previous;
  }
}

function resolveOutputDisplay(output) {
  if (!output) return null;
  const hasLegacyId = output.legacyDisplayId !== null && output.legacyDisplayId !== undefined;
  const byId = hasLegacyId
    ? state.displays.find(display => String(display.id) === String(output.legacyDisplayId))
    : null;
  if (output.displayFingerprint) {
    const matches = state.displays.filter(display => display.fingerprint === output.displayFingerprint);
    if (byId && byId.fingerprint === output.displayFingerprint) return byId;
    if (matches.length === 1) return matches[0];
    return null;
  }
  return byId;
}

function createEditorField(labelText, control) {
  const label = createElement('label', 'field-group profile-field');
  label.append(createElement('span', '', labelText), control);
  return label;
}

function createProfileAction(action, label, { disabled = false, quiet = true } = {}) {
  const button = createElement('button', quiet ? 'btn btn-quiet btn-compact' : 'btn btn-outline btn-compact', label);
  button.type = 'button';
  button.dataset.action = action;
  button.disabled = disabled;
  return button;
}

function bindProfileControl(control, type, id, field) {
  control.dataset.profileType = type;
  control.dataset.profileId = id;
  control.dataset.field = field;
  return control;
}

function renderInputRoleEditor() {
  elements.inputRoleSettingsList.replaceChildren();
  const roles = state.profileDraft?.inputRoles || [];
  roles.forEach((role, index) => {
    const item = createElement('li', 'profile-row input-role-row');
    item.dataset.profileId = role.id;
    const fieldset = document.createElement('fieldset');
    const legend = createElement('legend', '', `Input ${index + 1}: ${role.label}`);

    const labelInput = bindProfileControl(createElement('input', 'text-input'), 'input', role.id, 'label');
    labelInput.type = 'text';
    labelInput.maxLength = 120;
    labelInput.value = role.label;

    const filenameMatchers = bindProfileControl(createElement('input', 'text-input'), 'input', role.id, 'filenameMatchers');
    filenameMatchers.type = 'text';
    filenameMatchers.maxLength = 500;
    filenameMatchers.value = (role.filenameMatchers || []).join(', ');
    filenameMatchers.placeholder = 'Example: eng, english';

    const required = bindProfileControl(createElement('select', 'display-dropdown'), 'input', role.id, 'required');
    for (const [value, text] of [
      ['if-used-by-enabled-output', 'When an enabled screen uses it'],
      ['always', 'Always expected'],
      ['optional', 'Optional']
    ]) {
      const option = document.createElement('option');
      option.value = value;
      option.textContent = text;
      required.appendChild(option);
    }
    required.value = role.required;

    const datePolicy = bindProfileControl(createElement('select', 'display-dropdown'), 'input', role.id, 'datePolicy');
    for (const [value, text] of [
      ['service-date', 'Use the service date'],
      ['warn-if-stale', 'Warn when dated differently'],
      ['none', 'Reusable — no date required']
    ]) {
      const option = document.createElement('option');
      option.value = value;
      option.textContent = text;
      datePolicy.appendChild(option);
    }
    datePolicy.value = role.datePolicy;

    const enabled = bindProfileControl(document.createElement('input'), 'input', role.id, 'enabled');
    enabled.type = 'checkbox';
    enabled.checked = role.enabled;
    const enabledLabel = createElement('label', 'check-card compact-check');
    enabledLabel.append(enabled, createElement('span', '', 'Available on Load'));

    const actions = createElement('div', 'profile-row-actions');
    for (const button of [
      createProfileAction('move-up', `Move ${role.label} up`, { disabled: index === 0 }),
      createProfileAction('move-down', `Move ${role.label} down`, { disabled: index === roles.length - 1 }),
      createProfileAction('remove', `Remove ${role.label}`, { disabled: roles.length === 1 })
    ]) {
      button.dataset.profileType = 'input';
      button.dataset.profileId = role.id;
      actions.appendChild(button);
    }

    const grid = createElement('div', 'profile-row-grid input-role-grid');
    grid.append(
      createEditorField('Name shown to volunteers', labelInput),
      createEditorField('Words used to find its file', filenameMatchers),
      createEditorField('When it is expected', required),
      createEditorField('Date handling', datePolicy),
      enabledLabel
    );
    fieldset.append(legend, grid, actions);
    item.appendChild(fieldset);
    elements.inputRoleSettingsList.appendChild(item);
  });
}

function buildDisplaySelect(output) {
  const select = bindProfileControl(createElement('select', 'display-dropdown'), 'output', output.id, 'display');
  const empty = document.createElement('option');
  empty.value = '';
  empty.textContent = 'Choose a screen';
  select.appendChild(empty);
  const matched = resolveOutputDisplay(output);
  for (const display of state.displays) {
    const option = document.createElement('option');
    option.value = String(display.id);
    option.textContent = display.isControl
      ? `${display.label} — Operator controls (not available for output)`
      : display.label;
    option.disabled = display.isControl === true;
    select.appendChild(option);
  }
  if (matched) {
    select.value = String(matched.id);
  } else if (output.legacyDisplayId !== null || output.displayFingerprint) {
    const missing = document.createElement('option');
    missing.value = '__missing__';
    missing.textContent = 'Saved screen is not connected';
    select.appendChild(missing);
    select.value = '__missing__';
    select.classList.add('field-warning');
  }
  return select;
}

function renderOutputEditor() {
  elements.outputSettingsList.replaceChildren();
  const profile = state.profileDraft;
  const outputs = profile?.outputs || [];
  outputs.forEach((output, index) => {
    const item = createElement('li', 'profile-row output-profile-row');
    item.dataset.profileId = output.id;
    const fieldset = document.createElement('fieldset');
    const legend = createElement('legend', '', `Output ${index + 1}: ${output.name}`);

    const name = bindProfileControl(createElement('input', 'text-input'), 'output', output.id, 'name');
    name.type = 'text';
    name.maxLength = 120;
    name.value = output.name;

    const display = buildDisplaySelect(output);

    const roleSelect = bindProfileControl(createElement('select', 'display-dropdown'), 'output', output.id, 'expectedRoleId');
    for (const role of getDeckRoles(profile)) {
      const option = document.createElement('option');
      option.value = role.id;
      option.textContent = `${role.label} slides`;
      roleSelect.appendChild(option);
    }
    roleSelect.value = output.expectedRoleId || '';

    const kind = bindProfileControl(createElement('select', 'display-dropdown'), 'output', output.id, 'kind');
    for (const [value, label] of [['normal', 'Slides as-is'], ['singer', 'Singer / stage screen']]) {
      const option = document.createElement('option');
      option.value = value;
      option.textContent = label;
      kind.appendChild(option);
    }
    kind.value = output.kind;

    const enabled = bindProfileControl(document.createElement('input'), 'output', output.id, 'enabled');
    enabled.type = 'checkbox';
    enabled.checked = output.enabled;
    const enabledLabel = createElement('label', 'check-card compact-check');
    enabledLabel.append(enabled, createElement('span', '', 'Enabled'));

    const preview = bindProfileControl(document.createElement('input'), 'output', output.id, 'operatorPreview');
    preview.type = 'checkbox';
    preview.checked = output.operatorPreview;
    const previewLabel = createElement('label', 'check-card compact-check');
    const previewCopy = createElement('span');
    previewCopy.append(createElement('strong', '', 'Show preview'), createElement('small', '', 'On the operator’s Show screen'));
    previewLabel.append(preview, previewCopy);

    const actions = createElement('div', 'profile-row-actions');
    const actionSpecs = [
      ['move-up', `Move ${output.name} up`, index === 0],
      ['move-down', `Move ${output.name} down`, index === outputs.length - 1],
      ['duplicate', `Duplicate ${output.name}`, false],
      ['remove', `Remove ${output.name}`, outputs.length === 1]
    ];
    for (const [action, label, disabled] of actionSpecs) {
      const button = createProfileAction(action, label, { disabled });
      button.dataset.profileType = 'output';
      button.dataset.profileId = output.id;
      actions.appendChild(button);
    }

    const quickGrid = createElement('div', 'profile-row-grid output-quick-grid');
    quickGrid.append(
      createEditorField('Physical screen', display),
      createEditorField('Slideshow shown here', roleSelect)
    );
    const more = document.createElement('details');
    more.className = 'output-row-more';
    const moreSummary = document.createElement('summary');
    moreSummary.append(
      createElement('span', '', 'More options'),
      createElement('small', '', 'Name, behavior, preview, and remove')
    );
    const moreGrid = createElement('div', 'profile-row-grid output-row-grid');
    moreGrid.append(
      createEditorField('Output name', name),
      createEditorField('Screen behavior', kind),
      enabledLabel,
      previewLabel
    );
    more.append(moreSummary, moreGrid, actions);
    fieldset.appendChild(legend);
    if (!isEditableOutputRoute(output)) {
      const warning = createElement('div', 'profile-route-warning');
      warning.appendChild(createElement(
        'span',
        '',
        'This imported route is not editable in this preview, so SyncShow will not guess how to run it.'
      ));
      const useDirect = createProfileAction(
        'use-direct-route',
        `Use ${getRoleLabel(output.expectedRoleId, { draft: true })} slides directly`,
        { quiet: false }
      );
      useDirect.dataset.profileType = 'output';
      useDirect.dataset.profileId = output.id;
      warning.appendChild(useDirect);
      fieldset.appendChild(warning);
    }
    fieldset.append(quickGrid, more);
    item.appendChild(fieldset);
    elements.outputSettingsList.appendChild(item);
  });
}

function isEditableOutputRoute(output) {
  return output.mode === 'role'
    && output.renderer === 'slides'
    && output.sourceOutputId === null
    && output.sourceRoleId === output.expectedRoleId;
}

function renderProfileEditor() {
  if (!state.profileDraft) return;
  const focusDescriptor = captureProfileEditorFocus();
  elements.profileName.value = state.profileDraft.name || '';
  const driveConnection = state.profileDraft.driveConnectionId
    ? activeDriveConnection()
    : null;
  const automaticSourceLabel = state.profileDraft.localServiceFolder
    || (state.profileDraft.driveConnectionId
      ? `Google Drive · ${driveConnection?.folderName || driveConnection?.name || 'connected folder'}`
      : '');
  elements.profileServiceFolder.value = automaticSourceLabel;
  elements.profileServiceFolder.title = automaticSourceLabel;
  elements.profileTimeZone.value = state.profileDraft.timeZone || '';
  elements.profileServiceDateOrder.value = state.profileDraft.serviceDateOrder || 'mdy';
  elements.profileShowControlMode.value =
    state.profileDraft.operator?.showControlMode || 'full';
  populateSingerSourceOptions(state.profileDraft.singer?.fallbackSourceRoleId);
  renderInputRoleEditor();
  renderOutputEditor();
  updateProfileEditorButtons();
  restoreProfileEditorFocus(focusDescriptor);
}

function captureProfileEditorFocus() {
  const active = document.activeElement;
  if (!active?.closest?.('#expertSettingsSection')) return null;
  if (!active.dataset.profileType || !active.dataset.profileId) return null;
  return {
    type: active.dataset.profileType,
    id: active.dataset.profileId,
    field: active.dataset.field || null,
    action: active.dataset.action || null,
    selectionStart: typeof active.selectionStart === 'number' ? active.selectionStart : null,
    selectionEnd: typeof active.selectionEnd === 'number' ? active.selectionEnd : null
  };
}

function findProfileEditorControl({ type, id, field = null, action = null }) {
  return [...document.querySelectorAll('[data-profile-type][data-profile-id]')].find(control =>
    control.dataset.profileType === type
    && control.dataset.profileId === id
    && (field === null || control.dataset.field === field)
    && (action === null || control.dataset.action === action)
  ) || null;
}

function restoreProfileEditorFocus(descriptor) {
  if (!descriptor) return;
  let control = findProfileEditorControl(descriptor);
  if (!control || control.disabled) {
    control = findProfileEditorControl({
      type: descriptor.type,
      id: descriptor.id,
      field: descriptor.type === 'input' ? 'label' : 'name'
    });
  }
  if (!control || control.disabled) return;
  control.focus({ preventScroll: true });
  if (descriptor.selectionStart !== null && typeof control.setSelectionRange === 'function') {
    control.setSelectionRange(descriptor.selectionStart, descriptor.selectionEnd);
  }
}

function markProfileDirty(message = 'Unsaved venue profile changes.') {
  if (!state.profileDraft || !state.profile) return;
  state.profileDirty = JSON.stringify(state.profileDraft) !== JSON.stringify(state.profile);
  syncProfileDraftCloseState();
  elements.profileEditorStatus.textContent = state.profileDirty ? message : 'No unsaved profile changes.';
  updateProfileEditorButtons();
  checkReadyState();
}

function updateProfileEditorButtons() {
  elements.btnSaveProfile.disabled = !state.profileDirty;
  elements.btnCancelProfileChanges.disabled = !state.profileDirty;
}

function stageProfilePreferencesFromControls() {
  if (!state.profileDraft) return;
  state.singerFontSize = Math.max(12, Math.min(240, parseIntegerOr(elements.singerFontSize.value, 36)));
  state.singerCharLimit = Math.max(10, Math.min(500, parseIntegerOr(elements.singerCharLimit.value, 70)));
  state.singerTextPadding = Math.max(0, Math.min(80, parseIntegerOr(elements.singerTextPadding.value, 4)));
  state.profileDraft.transition.fadeDurationMs = parseIntegerOr(elements.fadeDuration.value, 300);
  state.profileDraft.transition.syncMode = elements.syncMode.checked;
  state.profileDraft.singer.fallbackSourceRoleId = elements.singerLanguage.value || getDeckRoles(state.profileDraft)[0]?.id || null;
  state.profileDraft.singer.fontSizePx = state.singerFontSize;
  state.profileDraft.singer.charLimit = state.singerCharLimit;
  state.profileDraft.singer.textPaddingPx = state.singerTextPadding;
  state.profileDraft.operator.thumbnailZoomPercent = state.thumbnailZoom;
  markProfileDirty();
}

function nextStableId(prefix, records) {
  const used = new Set(records.map(record => record.id));
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const token = globalThis.crypto?.randomUUID
      ? globalThis.crypto.randomUUID().slice(0, 8)
      : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const candidate = `${prefix}-${token}`;
    if (!used.has(candidate)) return candidate;
  }
  throw new Error(`Could not create a unique ${prefix} ID`);
}

function addInputRoleDraft() {
  const roles = state.profileDraft.inputRoles;
  const id = nextStableId('input', roles);
  roles.push({
    id,
    label: `Input ${roles.length + 1}`,
    enabled: true,
    kind: 'deck',
    acceptedTypes: ['pptx', 'ppt', 'service-project'],
    required: 'if-used-by-enabled-output',
    filenameMatchers: [],
    datePolicy: 'service-date'
  });
  renderProfileEditor();
  restoreProfileEditorFocus({ type: 'input', id, field: 'label' });
  markProfileDirty(`Added ${roles.at(-1).label}. Save the profile when the setup is ready.`);
}

function addOutputDraft(sourceOutput = null) {
  const outputs = state.profileDraft.outputs;
  const source = sourceOutput || outputs.at(-1);
  const id = nextStableId('output', outputs);
  const firstRoleId = getDeckRoles(state.profileDraft)[0]?.id || null;
  const output = source ? cloneValue(source) : {
    name: 'New Output',
    enabled: true,
    kind: 'normal',
    expectedRoleId: firstRoleId,
    mode: 'role',
    renderer: 'slides',
    sourceRoleId: firstRoleId,
    sourceOutputId: null,
    fallback: null
  };
  output.id = id;
  output.name = source ? `${source.name} copy` : `Output ${outputs.length + 1}`;
  output.legacyDisplayId = null;
  output.displayFingerprint = null;
  output.operatorPreview = false;
  outputs.push(output);
  renderProfileEditor();
  restoreProfileEditorFocus({ type: 'output', id, field: 'name' });
  markProfileDirty(`Added ${output.name}. Choose its screen, then save the profile.`);
}

function handleProfileEditorInput(event) {
  const control = event.target.closest('[data-profile-type][data-profile-id][data-field]');
  if (!control || !state.profileDraft) return;
  const collection = control.dataset.profileType === 'input'
    ? state.profileDraft.inputRoles
    : state.profileDraft.outputs;
  const record = collection.find(item => item.id === control.dataset.profileId);
  if (!record) return;
  const field = control.dataset.field;
  const value = control.type === 'checkbox' ? control.checked : control.value;

  if (control.dataset.profileType === 'input' && field === 'enabled' && value === false) {
    const dependents = state.profileDraft.outputs.filter(output =>
      output.enabled
      && (
        output.expectedRoleId === record.id
        || output.sourceRoleId === record.id
        || output.fallback?.sourceRoleId === record.id
      )
    );
    if (dependents.length > 0) {
      control.checked = true;
      elements.profileEditorStatus.textContent = `${record.label} is used by ${dependents.map(output => output.name).join(', ')}. Turn those outputs off or reassign them first.`;
      return;
    }
  }

  if (field === 'display') {
    if (value === '__missing__') return;
    const display = state.displays.find(item => String(item.id) === value);
    record.legacyDisplayId = display ? display.id : null;
    record.displayFingerprint = display?.fingerprint || null;
  } else if (control.dataset.profileType === 'input' && field === 'filenameMatchers') {
    record.filenameMatchers = value
      .split(',')
      .map(item => item.trim())
      .filter((item, index, items) => item.length > 0 && items.indexOf(item) === index);
  } else {
    record[field] = value;
    if (control.dataset.profileType === 'output' && field === 'expectedRoleId') {
      record.sourceRoleId = value;
      record.sourceOutputId = null;
      record.mode = 'role';
      record.renderer = 'slides';
    }
    if (
      control.dataset.profileType === 'output'
      && field === 'enabled'
      && value === true
      && record.mode === 'disabled'
    ) {
      record.mode = 'role';
      record.renderer = 'slides';
      record.sourceRoleId = record.expectedRoleId || getDeckRoles(state.profileDraft)[0]?.id || null;
      record.sourceOutputId = null;
    }
    if (control.dataset.profileType === 'output' && field === 'kind' && value === 'singer' && !record.fallback) {
      record.fallback = {
        mode: 'derive-next-text',
        sourceRoleId: state.profileDraft.singer.fallbackSourceRoleId,
        sourceOutputId: null,
        renderer: 'singer-current-next'
      };
    }
  }
  if (control.dataset.profileType === 'input' && field === 'enabled') renderProfileEditor();
  markProfileDirty();
}

function moveRecord(records, index, direction) {
  const target = index + direction;
  if (index < 0 || target < 0 || target >= records.length) return;
  [records[index], records[target]] = [records[target], records[index]];
}

function handleProfileEditorAction(event) {
  const button = event.target.closest('button[data-action][data-profile-type][data-profile-id]');
  if (!button || button.disabled) return;
  const type = button.dataset.profileType;
  const records = type === 'input' ? state.profileDraft.inputRoles : state.profileDraft.outputs;
  const index = records.findIndex(record => record.id === button.dataset.profileId);
  if (index < 0) return;
  const record = records[index];
  let focusAfterChange = null;

  if (button.dataset.action === 'use-direct-route' && type === 'output') {
    record.mode = 'role';
    record.renderer = 'slides';
    record.sourceRoleId = record.expectedRoleId || getDeckRoles(state.profileDraft)[0]?.id || null;
    record.sourceOutputId = null;
    renderProfileEditor();
    restoreProfileEditorFocus({ type: 'output', id: record.id, field: 'expectedRoleId' });
    markProfileDirty(`${record.name} will use its expected slideshow directly after Save.`);
    return;
  }

  if (button.dataset.action === 'move-up') moveRecord(records, index, -1);
  if (button.dataset.action === 'move-down') moveRecord(records, index, 1);
  if (button.dataset.action === 'duplicate' && type === 'output') {
    addOutputDraft(record);
    return;
  }
  if (button.dataset.action === 'remove') {
    if (type === 'input') {
      const used = state.profileDraft.outputs.some(output =>
        output.expectedRoleId === record.id
        || output.sourceRoleId === record.id
        || output.fallback?.sourceRoleId === record.id
      ) || state.profileDraft.singer?.fallbackSourceRoleId === record.id;
      if (used) {
        elements.profileEditorStatus.textContent = `${record.label} is still used by an output. Reassign that output before removing it.`;
        return;
      }
    }
    if (type === 'output') {
      const usedBy = state.profileDraft.outputs.filter(output =>
        output.id !== record.id
        && (output.sourceOutputId === record.id || output.fallback?.sourceOutputId === record.id)
      );
      if (usedBy.length > 0) {
        elements.profileEditorStatus.textContent = `${record.name} is still used by ${usedBy.map(output => output.name).join(', ')}. Reassign those outputs before removing it.`;
        return;
      }
    }
    if (records.length > 1) {
      records.splice(index, 1);
      if (type === 'output') {
        state.profileDraft.operator.previewOpenOutputIds =
          state.profileDraft.operator.previewOpenOutputIds.filter(outputId => outputId !== record.id);
      }
      const adjacent = records[Math.min(index, records.length - 1)];
      focusAfterChange = adjacent
        ? { type, id: adjacent.id, field: type === 'input' ? 'label' : 'name' }
        : null;
    }
  }
  renderProfileEditor();
  restoreProfileEditorFocus(focusAfterChange);
  markProfileDirty(`${record.name || record.label} changed in the draft. Save to apply it.`);
}

async function resetProfileDraft() {
  try {
    state.profileDraft = cloneValue(await window.api.getDefaultVenueProfile());
    state.profileDraft.id = state.profile?.id || state.profileDraft.id;
    state.profileDraft.name = state.profile?.name || state.profileDraft.name;
    applyProfilePreferencesToControls(state.profileDraft);
    renderProfileEditor();
    markProfileDirty('Safe defaults are staged. Nothing changes until you save.');
  } catch (error) {
    elements.profileEditorStatus.textContent = `Could not create safe defaults: ${error.message}`;
  }
}

function discardProfileChanges() {
  state.profileDraft = cloneValue(state.profile);
  applyProfilePreferencesToControls(state.profileDraft);
  renderProfileEditor();
  markProfileDirty('Draft discarded. The saved venue profile is unchanged.');
}

async function saveProfileChanges() {
  if (!state.profileDirty || !state.profileDraft || state.profileSaveInFlight) return;
  stageProfilePreferencesFromControls();
  const duplicateBindings = new Map();
  for (const output of state.profileDraft.outputs.filter(item => item.enabled)) {
    const display = resolveOutputDisplay(output);
    if (display?.isControl) {
      elements.profileEditorStatus.textContent = `${output.name} uses the operator screen. Choose a presentation screen before saving.`;
      return;
    }
    const bindingKey = display
      ? `display:${display.id}`
      : output.legacyDisplayId !== null && output.legacyDisplayId !== undefined
        ? `saved:${output.legacyDisplayId}`
        : null;
    if (!bindingKey) continue;
    const previous = duplicateBindings.get(bindingKey);
    if (previous) {
      elements.profileEditorStatus.textContent = `${previous.name} and ${output.name} use the same physical screen. Choose a different screen for one of them.`;
      return;
    }
    duplicateBindings.set(bindingKey, output);
  }

  const previousFolder = state.profile?.localServiceFolder || null;
  const previousDriveConnectionId = state.profile?.driveConnectionId || null;
  const previousTimeZone = state.profile?.timeZone || null;
  const previousScanProfileSignature = serviceFolderScanProfileSignature(state.profile);
  const profileToSave = cloneValue(state.profileDraft);
  state.profileSaveInFlight = true;
  syncProfileDraftCloseState();
  setProfileEditorSaving(true);
  elements.profileEditorStatus.textContent = 'Validating and saving the venue profile…';
  try {
    await profilePreferenceSaveQueue;
    const result = await window.api.saveSettings({ venueProfile: profileToSave });
    if (!result.success || !result.venueProfile) throw new Error('No validated profile was returned');
    const scanProfileChanged = previousScanProfileSignature
      !== serviceFolderScanProfileSignature(result.venueProfile);
    state.profileRecoveryWarning = null;
    if (result.preparedServiceInvalidated === true) {
      applyServiceHandoff(null);
      for (const [roleId, presentation] of Object.entries(state.presentations)) {
        if (presentation?.source === 'prepared') {
          state.presentations[roleId] = emptyPresentation();
        }
      }
      state.preparedServiceRestore = { status: 'incompatible' };
    }
    applyCommittedProfile(result.venueProfile);
    if (previousDriveConnectionId
      && previousDriveConnectionId !== result.venueProfile.driveConnectionId) {
      await window.api.disconnectDrive({ connectionId: previousDriveConnectionId }).catch(error => {
        console.warn('[GoogleDrive] The previous connection could not be removed:', error);
      });
      await refreshDriveStatus();
    }
    await checkForCachedPresentations();
    if (scanProfileChanged) {
      if (previousFolder !== result.venueProfile.localServiceFolder
        || previousDriveConnectionId !== result.venueProfile.driveConnectionId
        || previousTimeZone !== result.venueProfile.timeZone) {
        state.serviceFolder.requestedDate = serviceDateForProfile(result.venueProfile);
        elements.serviceFolderDate.value = state.serviceFolder.requestedDate;
        recheckLoadedPresentationDates();
      }
      invalidateServiceFolderScan();
      state.serviceFolder.error = null;
      if (hasConfiguredServiceSource(result.venueProfile)) {
        await scanLinkedServiceFolder({ reason: 'profile-save' });
      } else {
        renderServiceFolder();
      }
    }
    elements.profileEditorStatus.textContent = result.preparedServiceInvalidated === true
      ? 'Venue profile saved. Reprepare the reviewed native service for this venue setup.'
      : 'Venue profile saved. Volunteers will use these defaults.';
    if (result.preparedServiceInvalidated === true) {
      renderPreparedServiceRestoreStatus();
    } else {
      setStatus('Venue profile saved');
    }
  } catch (error) {
    elements.profileEditorStatus.textContent = `Could not save: ${error.message}`;
    setStatus(`Venue profile needs attention: ${error.message}`);
  } finally {
    state.profileSaveInFlight = false;
    syncProfileDraftCloseState();
    setProfileEditorSaving(false);
    renderServiceFolder();
  }
}

function syncProfileDraftCloseState() {
  if (typeof window.api.setSettingsDraftState !== 'function') return;
  window.api.setSettingsDraftState({
    dirty: state.profileDirty,
    saving: state.profileSaveInFlight
  });
}

function setProfileEditorSaving(saving) {
  for (const control of document.querySelectorAll('#expertSettingsSection button, #expertSettingsSection input, #expertSettingsSection select')) {
    if (saving) {
      control.dataset.disabledBeforeProfileSave = control.disabled ? 'true' : 'false';
      control.disabled = true;
    } else if (control.dataset.disabledBeforeProfileSave) {
      control.disabled = control.dataset.disabledBeforeProfileSave === 'true';
      delete control.dataset.disabledBeforeProfileSave;
    }
  }
  if (!saving) updateProfileEditorButtons();
}

function renderOutputHealth() {
  if (!state.profile) return;
  elements.outputHealthSummary.replaceChildren();
  const enabled = state.profile.outputs.filter(output => output.enabled);
  const connected = enabled.filter(output => resolveOutputDisplay(output));
  const summary = createElement(
    'p',
    'output-health-lead',
    `${enabled.length} ${enabled.length === 1 ? 'output' : 'outputs'} configured · ${connected.length} connected`
  );
  elements.outputHealthSummary.appendChild(summary);
  const list = createElement('ul', 'output-health-list');
  const assignmentCounts = new Map();
  for (const output of enabled) {
    const display = resolveOutputDisplay(output);
    if (display) assignmentCounts.set(String(display.id), (assignmentCounts.get(String(display.id)) || 0) + 1);
  }
  for (const output of state.profile.outputs) {
    const display = resolveOutputDisplay(output);
    const hasConflict = display && assignmentCounts.get(String(display.id)) > 1;
    const className = !output.enabled
      ? 'inactive'
      : (!display || display.isControl || hasConflict ? 'attention' : 'healthy');
    const status = !output.enabled
      ? 'Off in this profile'
      : !display
        ? 'Needs a connected screen'
        : display.isControl
          ? 'Operator screen cannot be used as an output'
          : hasConflict
            ? 'This screen is assigned to more than one output'
            : display.label;
    const item = createElement('li', className);
    item.append(
      createElement('strong', '', output.name),
      createElement('span', '', status)
    );
    list.appendChild(item);
  }
  elements.outputHealthSummary.appendChild(list);
}

// Check for cached presentations from previous session
async function checkForCachedPresentations() {
  try {
    const roles = getDeckRoles();
    const plan = typeof window.api.getCacheRestorePlan === 'function'
      ? await window.api.getCacheRestorePlan()
      : {
          groupId: null,
          legacy: true,
          caches: Object.fromEntries(await Promise.all(roles.map(async role => [
            role.id,
            await window.api.checkCache(role.id)
          ]))),
          excludedRoleIds: []
        };
    state.cachedRestorePlan = plan;
    state.cachedPresentations = plan?.caches && typeof plan.caches === 'object'
      ? plan.caches
      : {};
    const available = roles.map(role => {
      const cache = state.cachedPresentations[role.id];
      return cache?.exists ? `${role.label} (${cache.slideCount} slides)` : null;
    }).filter(Boolean);
    const preparedServiceLoaded = Object.values(state.presentations).some(
      presentation => presentation?.loaded && presentation.source === 'prepared'
    );

    if (available.length > 0 && !preparedServiceLoaded) {
      elements.btnRestorePrevious.hidden = false;
      elements.restoreSummary.hidden = false;
      const separatedCount = Array.isArray(plan.excludedRoleIds) ? plan.excludedRoleIds.length : 0;
      elements.restoreSummary.textContent = separatedCount > 0
        ? `Last compatible service available: ${available.join(' and ')}. ${separatedCount} older ${separatedCount === 1 ? 'input was' : 'inputs were'} kept separate for safety.`
        : `Last service available: ${available.join(' and ')}.`;
      elements.btnRestorePrevious.title = `Restore ${available.join(' and ')}`;
      setStatus(`Last service is available to restore: ${available.join(' and ')}`);
    } else {
      elements.btnRestorePrevious.hidden = true;
      elements.restoreSummary.hidden = true;
    }
  } catch (error) {
    console.error('Failed to check for cached presentations:', error);
  }
}

async function restoreCachedPresentations() {
  if (!state.cachedPresentations || !state.cachedRestorePlan) return;
  elements.btnRestorePrevious.disabled = true;
  try {
    state.restoreGroupId = state.cachedRestorePlan.groupId || createManualRestoreGroupId();
    await restorePreviousPresentation(state.cachedPresentations, {
      groupId: state.cachedRestorePlan.groupId,
      legacy: state.cachedRestorePlan.legacy === true
    });
    elements.btnRestorePrevious.hidden = true;
    elements.restoreSummary.hidden = true;
  } finally {
    elements.btnRestorePrevious.disabled = false;
  }
}

// Restore previous presentation from cache
async function restorePreviousPresentation(caches, restoreContract) {
  try {
    resetServiceOutputChoices({ refresh: true });
    applyServiceHandoff(null);
    setStatus('Restoring previous presentation...');

    // Restore is an explicit service boundary. Anything omitted from the
    // compatible restore plan must stay unloaded instead of surviving from a
    // different manual or ServiceSet generation already in memory.
    for (const role of Object.keys(presentationElements)) {
      if (!caches[role]?.exists) clearPresentationRole(role, 'Not part of the compatible saved service');
    }

    for (const role of Object.keys(presentationElements)) {
      const cache = caches[role];
      if (!cache?.exists) continue;

      const result = await window.api.loadFromCache(role, restoreContract);
      if (!result.success) continue;

      state.presentations[role] = {
        loaded: true,
        pending: false,
        path: cache.originalFile || 'Cached',
        source: 'restored',
        slideCount: result.slideCount,
        cacheDir: result.cacheDir,
        slides: []
      };
      delete state.presentationConversionRecovery[role];
      state.serviceFolder.staleRoleIds = state.serviceFolder.staleRoleIds
        .filter(roleId => roleId !== role);

      presentationElements[role].path.value = cache.originalFile
        ? folderBaseName(cache.originalFile)
        : '[Cached presentation]';
      presentationElements[role].selectButton.textContent = 'Change';
      if (cache.originalFile) checkFilenameDate(role, cache.originalFile);
      updateConversionStatus(role, `✓ Ready · ${result.slideCount} slides · Restored from the last session`, false);
      renderPresentationConversionRecovery(role);
      await loadSlideList(role);
    }

    refreshServiceRoleActions();
    checkReadyState();
    setStatus('Previous presentation restored successfully');
  } catch (error) {
    console.error('Failed to restore previous presentation:', error);
    setStatus('Error restoring previous presentation');
  }
}

function createManualRestoreGroupId() {
  const token = globalThis.crypto?.randomUUID
    ? globalThis.crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 14)}`;
  return `manual:${token}`;
}

function ensureManualRestoreGroupId() {
  if (!state.restoreGroupId) state.restoreGroupId = createManualRestoreGroupId();
  return state.restoreGroupId;
}

// File Selection and Conversion
async function selectFile(language) {
  if (!presentationElements[language]) throw new TypeError('Unknown presentation role');
  const filePath = await window.api.openPptxDialog(language);
  if (!filePath) return false;
  return loadPresentationFile(language, filePath, {
    restoreGroupId: ensureManualRestoreGroupId()
  });
}

function renderPresentationConversionRecovery(language) {
  const roleElements = presentationElements[language];
  if (!roleElements?.conversionRecovery || !roleElements.retryConversionButton) return;

  const request = state.presentationConversionRecovery[language] || null;
  roleElements.conversionRecovery.hidden = !request;
  roleElements.retryConversionButton.disabled = !request
    || state.serviceFolder.loading
    || state.presentations[language]?.pending === true;
}

async function retryPresentationConversion(language) {
  const request = state.presentationConversionRecovery[language];
  if (!request
    || state.serviceFolder.loading
    || state.presentations[language]?.pending === true) {
    return false;
  }

  setStatus(`Retrying ${getRoleLabel(language)}; SyncShow will leave PowerPoint untouched…`);
  return loadPresentationFile(language, request.filePath, request.options);
}

function setManualFileControlsDisabled(disabled) {
  for (const [language, roleElements] of Object.entries(presentationElements)) {
    roleElements.selectButton.disabled = disabled;
    roleElements.retryConversionButton.disabled = disabled
      || !state.presentationConversionRecovery[language]
      || state.presentations[language]?.pending === true;
  }
}

async function loadPresentationFile(language, filePath, {
  displayPath = filePath,
  dateSource = displayPath,
  offline = false,
  source = 'manual',
  restoreGroupId = null
} = {}) {
  const roleElements = presentationElements[language];
  if (!roleElements) throw new TypeError('Unknown presentation role');
  if (typeof filePath !== 'string' || filePath.length === 0) return false;

  const { path: pathInput, selectButton, dateWarning } = roleElements;
  const previousPresentation = state.presentations[language] || emptyPresentation();
  const previousPathValue = pathInput.value;
  const retryRequest = {
    filePath,
    options: {
      displayPath,
      dateSource,
      offline,
      source,
      restoreGroupId
    }
  };
  delete state.presentationConversionRecovery[language];
  renderPresentationConversionRecovery(language);

  try {
    selectButton.disabled = true;
    pathInput.value = folderBaseName(displayPath);
    pathInput.title = offline ? `${displayPath} — saved locally` : filePath;
    checkFilenameDate(language, dateSource);

    // Keep the last-good deck available for rollback, but never allow Start
    // while the filename shown in Load is still being converted.
    state.presentations[language] = {
      ...previousPresentation,
      pending: true
    };
    renderServiceFolder();
    checkReadyState();

    setStatus(`Converting ${getRoleLabel(language)} presentation…`);
    updateConversionStatus(language, offline ? 'Loading automatically…' : 'Loading slideshow…', true);

    const result = await window.api.convertPptx(filePath, language, restoreGroupId);
    if (!result?.success) {
      const failure = window.SyncShowErrorMessages
        ?.normalizePresentationConversionFailure(
          result,
          'The presentation could not be converted.'
        ) || {
          code: 'PRESENTATION_CONVERSION_FAILED',
          message: 'The presentation could not be converted.',
          recoveryAction: null
        };
      const conversionError = new Error(failure.message);
      conversionError.code = failure.code;
      conversionError.recoveryAction = failure.recoveryAction;
      throw conversionError;
    }

    // A manually converted deck is no longer the exact immutable native
    // package described by the previous handoff.
    applyServiceHandoff(null);
    for (const [roleId, presentation] of Object.entries(state.presentations)) {
      if (presentation?.source === 'prepared') {
        clearPresentationRole(
          roleId,
          'Not part of the PowerPoint service · choose a slideshow or decide at Start'
        );
      }
    }
    state.presentations[language] = {
      loaded: true,
      pending: false,
      path: filePath,
      displayPath,
      dateSource,
      offline,
      source,
      slideCount: result.slideCount,
      cacheDir: result.cacheDir,
      slides: []
    };
    state.serviceFolder.conversionFailedRoleIds =
      state.serviceFolder.conversionFailedRoleIds
        .filter(roleId => roleId !== language);
    refreshServiceFolderConversionError();
    state.serviceFolder.staleRoleIds = state.serviceFolder.staleRoleIds
      .filter(roleId => roleId !== language);

    updateConversionStatus(
      language,
      source === 'folder' || offline
        ? `✓ Ready · ${result.slideCount} slides · Loaded automatically`
        : `✓ Ready · ${result.slideCount} slides · Chosen on this computer`,
      false
    );
    selectButton.textContent = 'Change';
    // Re-check after conversion so the warning is not lost during the
    // asynchronous status/progress updates.
    checkFilenameDate(language, dateSource);
    setStatus(`${getRoleLabel(language)} presentation loaded successfully`);

    await loadSlideList(language);
    refreshServiceRoleActions();
    checkReadyState();
    return true;
  } catch (error) {
    console.error(`Error loading ${language} file:`, error);
    const errorMessage = window.SyncShowErrorMessages?.humanizeIpcError(
      error,
      'The presentation could not be converted.'
    ) || 'The presentation could not be converted.';
    state.presentations[language] = previousPresentation;
    pathInput.value = previousPathValue;
    pathInput.title = previousPresentation.path || '';
    if (source === 'folder') {
      state.serviceFolder.conversionFailedRoleIds = [
        ...new Set([
          ...state.serviceFolder.conversionFailedRoleIds,
          language
        ])
      ];
      refreshServiceFolderConversionError();
    }
    if (error?.recoveryAction
      === window.SyncShowErrorMessages?.CLOSE_POWERPOINT_AND_RETRY_ACTION) {
      state.presentationConversionRecovery[language] = {
        ...retryRequest,
        message: errorMessage
      };
    }
    const recovery = state.presentationConversionRecovery[language] || null;

    if (previousPresentation.loaded) {
      if (previousPresentation.dateSource || previousPresentation.path) {
        checkFilenameDate(language, previousPresentation.dateSource || previousPresentation.path);
      }
      updateConversionStatus(
        language,
        recovery
          ? `✗ ${recovery.message} Still using ${previousPresentation.slideCount} previously loaded slides.`
          : `✗ New file failed; still using ${previousPresentation.slideCount} previously loaded slides`,
        false
      );
      setStatus(`Could not replace ${getRoleLabel(language)}; the previous presentation is still loaded`);
    } else {
      dateWarning.style.display = 'none';
      updateConversionStatus(language, `✗ Error: ${errorMessage}`, false);
      selectButton.textContent = 'Choose slideshow';
      setStatus(`Error loading ${getRoleLabel(language)} presentation`);
    }
    renderPresentationConversionRecovery(language);
    return false;
  } finally {
    selectButton.disabled = state.serviceFolder.loading;
    if (!state.presentations[language]?.loaded) selectButton.textContent = 'Choose slideshow';
    renderPresentationConversionRecovery(language);
    renderServiceFolder();
    checkReadyState();
  }
}

// Extract a date from a filename, handling many common formats.
// Returns a { year, month, day } object (1-based month/day) or null.
function parseDateFromFilename(filePath) {
  // Use only the basename
  const basename = filePath.replace(/\\/g, '/').split('/').pop() || '';

  // Patterns ordered from most-specific to least-specific to avoid false positives.
  // Each entry: [regex, handler(match) -> {year,month,day} | null]
  const patterns = [
    // ISO / unambiguous: 2025-03-26, 2025.03.26, 2025_03_26, 20250326
    [/\b(20\d{2})[-._]?(\d{2})[-._]?(\d{2})\b/, (m) => ({ year: +m[1], month: +m[2], day: +m[3] })],
    // Written month name: March 26 2025 / 26 March 2025 / Mar-26-2025 etc.
    [/\b(\d{1,2})[-.\s_]*(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*[-.\s_]*(\d{4})\b/i,
      (m) => ({ year: +m[3], month: monthNameToNumber(m[2]), day: +m[1] })],
    [/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*[-.\s_]*(\d{1,2})[-.\s_]*(\d{4})\b/i,
      (m) => ({ year: +m[3], month: monthNameToNumber(m[1]), day: +m[2] })],
    // Numeric with separators — try both M/D and D/M ambiguity resolved below
    [/\b(\d{1,2})[\/\-._](\d{1,2})[\/\-._](\d{4})\b/, (m) => resolveNumericDate(+m[1], +m[2], +m[3])],
    [/\b(\d{4})[\/\-._](\d{1,2})[\/\-._](\d{1,2})\b/, (m) => ({ year: +m[1], month: +m[2], day: +m[3] })],
    // Short year last: 3/26/25 or 26/3/25
    [/\b(\d{1,2})[\/\-._](\d{1,2})[\/\-._](\d{2})\b/, (m) => resolveNumericDate(+m[1], +m[2], 2000 + +m[3])],
  ];

  for (const [regex, handler] of patterns) {
    const match = basename.match(regex);
    if (match) {
      const result = handler(match);
      if (result && isValidDate(result)) return result;
    }
  }
  return null;
}

function monthNameToNumber(name) {
  const months = { jan:1, feb:2, mar:3, apr:4, may:5, jun:6,
                   jul:7, aug:8, sep:9, oct:10, nov:11, dec:12 };
  return months[name.toLowerCase().slice(0, 3)] || 0;
}

// For ambiguous numeric dates (e.g. 3/26 vs 26/3), pick the one that makes sense.
// If first number > 12, it must be the day (European DD/MM). Otherwise assume M/D (US).
function resolveNumericDate(a, b, year) {
  if (a > 12) return { year, month: b, day: a };   // a can only be day
  if (b > 12) return { year, month: a, day: b };   // b can only be day
  // Both are plausible months. Follow the venue profile instead of the
  // computer locale so every operator gets the same warning.
  return state.profile?.serviceDateOrder === 'dmy'
    ? { year, month: b, day: a }
    : { year, month: a, day: b };
}

function isValidDate({ year, month, day }) {
  if (month < 1 || month > 12 || day < 1 || day > 31) return false;
  const d = new Date(year, month - 1, day);
  return d.getFullYear() === year && d.getMonth() === month - 1 && d.getDate() === day;
}

function setRoleCardState(roleId, kind, label) {
  const roleElements = presentationElements[roleId];
  if (!roleElements?.card || !roleElements.stateBadge) return;
  roleElements.card.dataset.state = kind;
  roleElements.stateBadge.className = `card-state-badge${kind ? ` ${kind}` : ''}`;
  roleElements.stateBadge.textContent = label;
}

function checkFilenameDate(language, filePath) {
  const warningEl = presentationElements[language]?.dateWarning;
  if (!warningEl) return;
  if (getRole(language)?.datePolicy === 'none') {
    warningEl.style.display = 'none';
    if (state.presentations[language]?.loaded) setRoleCardState(language, 'ready', 'Ready');
    return;
  }
  const parsed = parseDateFromFilename(filePath);
  if (!parsed) {
    warningEl.style.display = 'none';
    if (state.presentations[language]?.loaded) setRoleCardState(language, 'ready', 'Ready');
    return;
  }
  const expectedDate = state.serviceFolder.requestedDate || serviceDateForProfile();
  const [expectedYear, expectedMonth, expectedDay] = expectedDate.split('-').map(Number);
  const match = parsed.year === expectedYear
    && parsed.month === expectedMonth
    && parsed.day === expectedDay;
  if (match) {
    warningEl.style.display = 'none';
    setRoleCardState(language, 'ready', 'Ready');
  } else {
    const fileDate = new Date(parsed.year, parsed.month - 1, parsed.day)
      .toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
    warningEl.textContent = `⚠ File date (${fileDate}) does not match the selected service date`;
    warningEl.style.display = 'block';
    setRoleCardState(language, 'attention', 'May be old');
  }
}

function recheckLoadedPresentationDates() {
  for (const role of getDeckRoles()) {
    const presentation = state.presentations[role.id];
    if (!presentation?.loaded || presentation.pending) continue;
    checkFilenameDate(
      role.id,
      presentation.dateSource || presentation.displayPath || presentation.path || ''
    );
  }
}

function updateConversionStatus(language, message, showProgress) {
  const statusEl = presentationElements[language]?.status;
  if (!statusEl) return;
  const progressBar = statusEl.querySelector('.progress-bar');
  const statusText = statusEl.querySelector('.status-text');

  statusText.textContent = message;
  statusText.className = 'status-text';

  if (message.startsWith('✓')) {
    statusText.classList.add('success');
    setRoleCardState(language, 'ready', 'Ready');
  } else if (message.startsWith('✗')) {
    statusText.classList.add('error');
    setRoleCardState(language, 'error', 'Couldn’t load');
  } else if (showProgress) {
    setRoleCardState(language, 'working', 'Loading…');
  } else {
    setRoleCardState(language, '', 'Needs a slideshow');
  }

  progressBar.style.display = showProgress ? 'block' : 'none';
}

function handleConversionProgress({ language, progress, converter, fallbackFrom, message }) {
  const progressEl = presentationElements[language]?.progress;
  if (!progressEl) return;
  progressEl.style.width = `${progress}%`;

  if (fallbackFrom && converter) {
    updateConversionStatus(
      language,
      `${fallbackFrom} unavailable; using ${converter}...`,
      true
    );
    setStatus(
      `${fallbackFrom} could not be used${message ? ` (${message})` : ''}. Continuing with ${converter}.`
    );
  }
}

async function loadSlideList(language, { render = true } = {}) {
  try {
    const slides = await window.api.getSlideList(language);
    console.log(`[loadSlideList] Loaded ${slides.length} slides for ${language}`);
    if (slides[0]) {
      console.log(`[loadSlideList] First slide keys:`, Object.keys(slides[0]));
      console.log(`[loadSlideList] Has thumbnailBase64:`, !!slides[0].thumbnailBase64);
      console.log(`[loadSlideList] thumbnailBase64 length:`, slides[0].thumbnailBase64?.length || 0);
    }
    state.presentations[language].slides = slides;
    renderShowCueContext();

    if (render) renderThumbnails();
  } catch (error) {
    console.error(`Error loading slide list for ${language}:`, error);
  }
}

// Display Management
function handleDisplaysUpdated(displays) {
  state.displays = displays;
  renderProfileEditor();
  renderOutputHealth();
  checkReadyState();
}

async function refreshDisplays() {
  try {
    const displays = await window.api.refreshDisplays();
    state.displays = displays;
    renderProfileEditor();
    renderOutputHealth();
    checkReadyState();
    setStatus(`Found ${displays.length} displays`);
  } catch (error) {
    console.error('Error refreshing displays:', error);
    setStatus('Error detecting displays');
  }
}

async function identifyDisplays() {
  try {
    const result = await window.api.identifyDisplays();
    setStatus(`Identifying ${result.count} connected ${result.count === 1 ? 'screen' : 'screens'} for a few seconds`);
  } catch (error) {
    console.error('Could not identify displays:', error);
    setStatus(`Could not identify screens: ${error.message}`);
  }
}

// Presentation Control
function getConfiguredOutputs() {
  return (state.profile?.outputs || [])
    .filter(output => output.enabled)
    .map(output => {
      const display = resolveOutputDisplay(output);
      return {
        id: output.id,
        name: output.name,
        kind: output.kind,
        enabled: true,
        expectedRole: output.expectedRoleId,
        displayId: display?.id ?? null,
        usesOperatorDisplay: display?.isControl === true,
        hasUnsupportedProfileRoute: !isEditableOutputRoute(output),
        operatorPreview: output.operatorPreview
      };
    });
}

function getLoadedRoles({ requireExtractedText = false } = {}) {
  return Object.keys(presentationElements).filter(role => {
    const presentation = state.presentations[role];
    if (!presentation.loaded || presentation.pending || !(presentation.slideCount > 0)) return false;
    if (!requireExtractedText) return true;
    return (presentation.slides || []).some(slide => String(slide.text || '').trim().length > 0);
  });
}

function getReadinessState() {
  const outputs = getConfiguredOutputs();
  const routes = outputs.map(output => ({
    output,
    decision: getServiceOutputDecision(output)
  }));
  const activeRoutes = routes.filter(route => route.decision?.mode !== 'disabled');
  const activeOutputs = activeRoutes.map(route => route.output);
  const conversionPending = Object.values(state.presentations).some(presentation => presentation.pending);
  const missingDisplays = activeOutputs.filter(output => output.displayId === null);
  const operatorDisplayOutputs = activeOutputs.filter(output => output.usesOperatorDisplay);
  const unsupportedProfileRoutes = activeOutputs.filter(output => output.hasUnsupportedProfileRoute);
  const assignments = activeOutputs
    .filter(output => output.displayId !== null)
    .map(output => output.displayId);
  const hasDisplayConflict = new Set(assignments).size !== assignments.length;
  const directRoles = [...new Set(activeRoutes
    .map(route => decisionSourceRole(route.output, route.decision))
    .filter(role => role && state.presentations[role]?.loaded))];
  const directCounts = directRoles.map(role => state.presentations[role].slideCount || 0);
  const slideCountsMatch = new Set(directCounts).size <= 1;
  const needsChoices = activeRoutes
    .filter(route => route.decision === null)
    .map(route => route.output);
  const issues = [];

  if (outputs.length === 0) issues.push('Choose at least one output screen in Admin Settings');
  if (outputs.length > 0 && activeOutputs.length === 0) {
    issues.push('Use at least one configured screen for this service');
  }
  if (conversionPending) issues.push('Wait for the selected file to finish loading');
  if (!slideCountsMatch) {
    const summary = directRoles
      .map(role => `${getRoleLabel(role)} ${state.presentations[role].slideCount}`)
      .join(', ');
    issues.push(`Slideshows assigned as-is have different slide counts: ${summary}`);
  }
  if (hasDisplayConflict) issues.push('Assign each enabled output to a different screen');
  for (const output of operatorDisplayOutputs) {
    issues.push(`${output.name} is assigned to the operator screen; choose a presentation screen`);
  }
  for (const output of unsupportedProfileRoutes) {
    issues.push(`${output.name} has an imported route that must be changed to a direct slideshow in Admin Settings`);
  }
  for (const output of missingDisplays) issues.push(`${output.name} needs a connected screen`);
  if (state.profileDirty) issues.push('Save or discard the venue profile changes');
  if (state.profileRecoveryWarning) issues.push('Review and save a valid venue profile before starting');
  if (state.serviceFolder.staleRoleIds.length > 0) {
    issues.push(
      `Finish reloading ${state.serviceFolder.staleRoleIds.map(roleId => getRoleLabel(roleId)).join(', ')} so files from different services are not mixed`
    );
  }
  if (state.isStarting) issues.push('Output windows are starting');
  if (state.startAttempt && !state.isStarting) issues.push('Finish or cancel the current Start Show choices');

  const isReady = activeOutputs.length > 0
    && !conversionPending
    && !state.isStarting
    && !state.startAttempt
    && slideCountsMatch
    && !hasDisplayConflict
    && operatorDisplayOutputs.length === 0
    && unsupportedProfileRoutes.length === 0
    && missingDisplays.length === 0
    && !state.profileDirty
    && !state.profileRecoveryWarning
    && state.serviceFolder.staleRoleIds.length === 0;

  return {
    isReady,
    issues,
    outputs,
    activeOutputs,
    needsChoices,
    missingDisplays,
    operatorDisplayOutputs,
    unsupportedProfileRoutes,
    hasDisplayConflict,
    slideCountsMatch,
    conversionPending
  };
}

function renderReadiness(readiness) {
  const {
    isReady,
    issues,
    activeOutputs,
    needsChoices,
    slideCountsMatch,
    conversionPending
  } = readiness;
  elements.readinessCard.classList.toggle('ready', isReady);
  elements.readinessIssues.replaceChildren();
  elements.readinessIssues.hidden = state.friendlyMode;
  elements.readinessCard.hidden = state.friendlyMode && isReady && needsChoices.length === 0;

  if (isReady) {
    if (needsChoices.length > 0) {
      elements.readinessIcon.textContent = '→';
      elements.readinessTitle.textContent = 'Ready for a quick choice';
      elements.readinessSummary.textContent = `Start Show will ask what to use for ${needsChoices.length === 1 ? needsChoices[0].name : `${needsChoices.length} outputs`}.`;
    } else {
      elements.readinessIcon.textContent = '✓';
      elements.readinessTitle.textContent = 'Ready to start';
      elements.readinessSummary.textContent = `${activeOutputs.length} ${activeOutputs.length === 1 ? 'output is' : 'outputs are'} assigned and ready for this service.`;
    }
    return;
  }

  if (state.friendlyMode) {
    elements.readinessIcon.textContent = conversionPending ? '…' : '!';
    if (conversionPending) {
      elements.readinessTitle.textContent = 'Loading slideshows';
      elements.readinessSummary.textContent = 'Start Show will unlock when the cards finish loading.';
    } else if (!slideCountsMatch) {
      elements.readinessTitle.textContent = 'Slideshows do not match';
      elements.readinessSummary.textContent = issues.find(issue => issue.startsWith('Slideshows assigned')) || 'Choose matching files before starting.';
    } else if (state.serviceFolder.staleRoleIds.length > 0) {
      elements.readinessTitle.textContent = 'Finish loading today’s files';
      elements.readinessSummary.textContent = 'A newer service is only partly loaded. The previous service will not be mixed into it.';
    } else {
      elements.readinessTitle.textContent = 'Admin setup needed';
      elements.readinessSummary.textContent = 'An output screen needs attention. Open Admin Settings to finish the venue setup.';
    }
    return;
  }

  elements.readinessIcon.textContent = String(issues.length);
  elements.readinessTitle.textContent = issues.length === 1
    ? 'One thing needs attention'
    : `${issues.length} things need attention`;
  elements.readinessSummary.textContent = 'Start Show will unlock when these are resolved:';

  const fragment = document.createDocumentFragment();
  for (const issue of issues) {
    const item = document.createElement('li');
    item.textContent = issue;
    fragment.appendChild(item);
  }
  elements.readinessIssues.appendChild(fragment);
}

function checkReadyState() {
  const readiness = getReadinessState();
  const {
    isReady,
    hasDisplayConflict,
    slideCountsMatch,
    conversionPending,
    needsChoices
  } = readiness;

  elements.btnStartPresentation.disabled = !isReady;
  renderReadiness(readiness);

  // Display rescans and preference saves can occur while Show is live. Keep
  // those background readiness updates from replacing the operator's live
  // status message with Load-screen guidance.
  if (state.isPresenting) return;

  if (isReady) {
    setStatus(needsChoices.length > 0
      ? 'Ready — Start Show will help choose what each missing output should display'
      : 'Ready to start the show');
  } else if (hasDisplayConflict) {
    setStatus('Each output must use a different physical display');
  } else if (!slideCountsMatch) {
    setStatus('Slideshows assigned as-is must have matching slide counts');
  } else if (conversionPending) {
    setStatus('Finish converting the selected presentation before starting');
  } else if (state.isStarting) {
    setStatus('Starting output windows...');
  }
}

function confirmPreparedServiceDate() {
  const selectedDate = state.serviceFolder.requestedDate
    || serviceDateForProfile();
  const guard = window.SyncShowPreparedServiceGuard.preparedServiceDateGuard({
    presentations: state.presentations,
    serviceHandoff: state.serviceHandoff,
    selectedDate,
    confirmedKeys: state.preparedServiceDateConfirmations
  });
  if (!guard.requiresConfirmation) return true;

  const title = state.serviceHandoff.project.title || 'This prepared service';
  const confirmed = window.confirm(
    `${title} is dated ${formatServiceDate(guard.serviceDate)}, but Load is set to ${formatServiceDate(guard.selectedDate)}. Start this exact prepared service anyway?`
  );
  if (confirmed) {
    state.preparedServiceDateConfirmations.add(guard.key);
    return true;
  }
  setStatus(
    'Start cancelled. Choose the intended service date or prepare the correct service before opening output screens.'
  );
  return false;
}

async function startPresentation() {
  const readiness = getReadinessState();
  if (!readiness.isReady) return;
  if (!confirmPreparedServiceDate()) return;

  const serviceDecisions = window.SyncShowServiceOutputPlan.filterDecisionsForOutputs(
    readiness.outputs,
    state.serviceOutputDecisions
  );
  const decisions = {};
  for (const output of readiness.outputs) {
    const serviceDecision = getServiceOutputDecision(output);
    if (serviceDecisions[output.id] && serviceDecision) {
      decisions[output.id] = { ...serviceDecision, explicit: true };
    } else if (state.presentations[output.expectedRole]?.loaded) {
      decisions[output.id] = { mode: 'direct', explicit: false };
    }
  }

  const loadedRoles = getLoadedRoles();
  const preferredRole = elements.singerLanguage.value;
  state.startAttempt = {
    id: Date.now(),
    status: 'question',
    snapshot: {
      outputs: readiness.outputs,
      settings: {
        fadeDuration: parseIntegerOr(elements.fadeDuration.value, 300),
        syncMode: elements.syncMode.checked || false,
        singerFontSize: state.singerFontSize,
        singerCharLimit: state.singerCharLimit,
        singerTextPadding: state.singerTextPadding
      },
      preferredTimelineRoleId: loadedRoles.includes(preferredRole) ? preferredRole : loadedRoles[0]
    },
    decisions,
    questionIds: readiness.needsChoices.map(output => output.id),
    cursor: 0,
    error: null
  };

  checkReadyState();
  if (state.startAttempt.questionIds.length === 0) {
    await launchStartAttempt();
    return;
  }

  renderStartPreflight();
  elements.startPreflightDialog.showModal();
}

function getAttemptOutput(attempt) {
  const outputId = attempt.questionIds[attempt.cursor];
  return attempt.snapshot.outputs.find(output => output.id === outputId) || null;
}

function createPreflightChoice({ value, title, description, checked = false, disabled = false }) {
  const label = document.createElement('label');
  label.className = 'preflight-choice';

  const input = document.createElement('input');
  input.type = 'radio';
  input.name = 'preflightAction';
  input.value = value;
  input.checked = checked;
  input.disabled = disabled;

  const copy = document.createElement('span');
  const heading = document.createElement('strong');
  heading.textContent = title;
  const detail = document.createElement('small');
  detail.textContent = description;
  copy.append(heading, detail);
  label.append(input, copy);
  elements.preflightChoices.appendChild(label);
  return input;
}

function createPreflightSourceSelect(mode, roles, selectedRole) {
  const label = document.createElement('label');
  label.className = 'preflight-source';
  label.dataset.forMode = mode;
  label.textContent = 'Slideshow to use';

  const select = document.createElement('select');
  select.id = `preflight-${mode}-source`;
  select.className = 'display-dropdown';
  for (const role of roles) {
    const option = document.createElement('option');
    option.value = role;
    option.textContent = `${getRoleLabel(role)} slideshow`;
    select.appendChild(option);
  }
  if (roles.includes(selectedRole)) select.value = selectedRole;
  label.appendChild(select);
  elements.preflightChoices.appendChild(label);
  return select;
}

function updatePreflightSourceVisibility() {
  const selectedMode = elements.preflightChoices
    .querySelector('input[name="preflightAction"]:checked')?.value;
  elements.preflightChoices.querySelectorAll('.preflight-source').forEach(label => {
    label.hidden = label.dataset.forMode !== selectedMode;
  });
}

function renderStartPreflight() {
  const attempt = state.startAttempt;
  if (!attempt) return;

  const isReview = attempt.status === 'review';
  elements.preflightChoices.replaceChildren();
  elements.preflightReview.replaceChildren();
  elements.preflightChoices.hidden = isReview;
  elements.preflightReview.hidden = !isReview;
  elements.preflightError.hidden = !attempt.error;
  elements.preflightError.textContent = attempt.error || '';

  if (isReview) {
    elements.preflightProgress.textContent = 'REVIEW';
    elements.preflightTitle.textContent = 'Ready to start the show?';
    elements.preflightDescription.textContent = 'These choices apply only to this show. Your saved screen setup will not change.';

    const list = document.createElement('ul');
    list.className = 'preflight-review-list';
    for (const output of attempt.snapshot.outputs) {
      const decision = attempt.decisions[output.id];
      const item = document.createElement('li');
      const name = document.createElement('strong');
      name.textContent = output.name;
      const route = document.createElement('span');
      route.textContent = describePreflightDecision(output, decision);
      item.append(name, route);
      list.appendChild(item);
    }
    const note = document.createElement('p');
    note.className = 'preflight-note';
    note.textContent = 'You can return to Load at any time to change files or screens.';
    elements.preflightReview.append(list, note);
    elements.btnPreflightBack.hidden = attempt.questionIds.length === 0;
    elements.btnPreflightContinue.textContent = 'Start Show';
    window.setTimeout(() => elements.btnPreflightContinue.focus(), 0);
    return;
  }

  const output = getAttemptOutput(attempt);
  if (!output) {
    attempt.status = 'review';
    renderStartPreflight();
    return;
  }

  const existing = attempt.decisions[output.id];
  const loadedRoles = getLoadedRoles();
  const textRoles = getLoadedRoles({ requireExtractedText: true });
  const expectedLoaded = loadedRoles.includes(output.expectedRole);
  const preferredRole = attempt.snapshot.preferredTimelineRoleId;
  const defaultMirrorRole = loadedRoles.includes(existing?.sourceRole)
    ? existing.sourceRole
    : (loadedRoles.includes(preferredRole) ? preferredRole : loadedRoles[0]);
  const defaultTextRole = textRoles.includes(existing?.sourceRole)
    ? existing.sourceRole
    : (textRoles.includes(preferredRole) ? preferredRole : textRoles[0]);
  const defaultMode = existing?.mode
    || (output.kind === 'singer' && textRoles.length > 0
      ? 'derive-next-text'
      : (loadedRoles.length > 0 ? 'mirror' : 'upload'));

  elements.preflightProgress.textContent = `DECISION ${attempt.cursor + 1} OF ${attempt.questionIds.length}`;
  elements.preflightTitle.textContent = `What should the ${output.name} show?`;
  elements.preflightDescription.textContent = output.kind === 'singer'
    ? `No ${getRoleLabel(output.expectedRole)} slideshow was loaded for this service. Choose what the ${output.name} should do this time.`
    : `No ${getRoleLabel(output.expectedRole)} slideshow was loaded for this service. Choose what this screen should do this time.`;

  if (expectedLoaded) {
    createPreflightChoice({
      value: 'direct',
      title: `Use the loaded ${getRoleLabel(output.expectedRole)} slideshow`,
      description: 'Show the expected slideshow as-is.',
      checked: defaultMode === 'direct'
    });
  }

  createPreflightChoice({
    value: 'upload',
    title: `Upload ${getRoleLabel(output.expectedRole)} slideshow`,
    description: output.kind === 'singer'
      ? `Choose the prepared ${getRoleLabel(output.expectedRole)} PowerPoint and show it as-is.`
      : 'Choose and load the expected PowerPoint.',
    checked: defaultMode === 'upload'
  });

  if (output.kind === 'singer') {
    createPreflightChoice({
      value: 'derive-next-text',
      title: 'Create next-text view',
      description: textRoles.length > 0
        ? 'Show the current slide plus text extracted from the next slide.'
        : 'Load a slideshow with extractable text before using this option.',
      checked: defaultMode === 'derive-next-text' && textRoles.length > 0,
      disabled: textRoles.length === 0
    });
    if (textRoles.length > 0) {
      createPreflightSourceSelect('derive-next-text', textRoles, defaultTextRole);
    }
  }

  createPreflightChoice({
    value: 'mirror',
    title: 'Show another slideshow as-is',
    description: loadedRoles.length > 0
      ? 'Use one of the slideshows that is already loaded.'
      : 'Load a slideshow before using this option.',
    checked: defaultMode === 'mirror' && loadedRoles.length > 0,
    disabled: loadedRoles.length === 0
  });
  if (loadedRoles.length > 0) {
    createPreflightSourceSelect('mirror', loadedRoles, defaultMirrorRole);
  }

  createPreflightChoice({
    value: 'disabled',
    title: `Turn off ${output.name} for this service`,
    description: 'Continue without this output; your saved screen setup will not change.',
    checked: defaultMode === 'disabled'
  });

  elements.preflightChoices.querySelectorAll('input[name="preflightAction"]').forEach(input => {
    input.addEventListener('change', updatePreflightSourceVisibility);
  });
  updatePreflightSourceVisibility();
  elements.btnPreflightBack.hidden = attempt.cursor === 0;
  elements.btnPreflightContinue.textContent = 'Continue';
  window.setTimeout(() => {
    elements.preflightChoices.querySelector('input[name="preflightAction"]:checked')?.focus();
  }, 0);
}

function describePreflightDecision(output, decision) {
  if (!decision) return 'Needs a choice';
  if (decision.mode === 'disabled') return 'Off for this service';
  if (decision.mode === 'derive-next-text') {
    return `Next-text view from ${getRoleLabel(decision.sourceRole)} slideshow`;
  }
  const role = decision.mode === 'direct' ? output.expectedRole : decision.sourceRole;
  const suffix = decision.mode === 'mirror' ? ' as-is, for this service' : ' slideshow';
  return `${getRoleLabel(role)}${suffix}`;
}

async function handlePreflightSubmit(event) {
  event.preventDefault();
  const attempt = state.startAttempt;
  if (!attempt) return;

  attempt.error = null;
  if (attempt.status === 'review') {
    await launchStartAttempt();
    return;
  }

  const output = getAttemptOutput(attempt);
  const selectedMode = elements.preflightChoices
    .querySelector('input[name="preflightAction"]:checked')?.value;
  if (!output || !selectedMode) {
    attempt.error = 'Choose an option to continue.';
    renderStartPreflight();
    return;
  }

  if (selectedMode === 'upload') {
    await uploadForPreflight(attempt, output);
    return;
  }

  const decision = { mode: selectedMode, explicit: true };
  if (selectedMode === 'mirror' || selectedMode === 'derive-next-text') {
    const source = document.getElementById(`preflight-${selectedMode}-source`)?.value;
    if (!source || !state.presentations[source]?.loaded) {
      attempt.error = 'Choose a loaded slideshow to use.';
      renderStartPreflight();
      return;
    }
    decision.sourceRole = source;
  }
  if (selectedMode === 'direct' && !state.presentations[output.expectedRole]?.loaded) {
    attempt.error = 'That slideshow is no longer loaded. Upload it or choose another source.';
    renderStartPreflight();
    return;
  }

  attempt.decisions[output.id] = decision;
  attempt.cursor += 1;
  attempt.status = attempt.cursor >= attempt.questionIds.length ? 'review' : 'question';
  renderStartPreflight();
}

async function uploadForPreflight(attempt, output) {
  attempt.status = 'uploading';
  if (elements.startPreflightDialog.open) elements.startPreflightDialog.close();
  setStatus(`Choose and load the ${getRoleLabel(output.expectedRole)} slideshow`);

  const loaded = await selectFile(output.expectedRole);
  if (state.startAttempt !== attempt) return;

  attempt.status = 'question';
  if (loaded) {
    attempt.decisions[output.id] = { mode: 'direct', explicit: true };
    if (!attempt.snapshot.preferredTimelineRoleId) {
      attempt.snapshot.preferredTimelineRoleId = output.expectedRole;
    }
    attempt.cursor += 1;
    attempt.status = attempt.cursor >= attempt.questionIds.length ? 'review' : 'question';
  } else {
    attempt.error = 'No slideshow was loaded. You can try again or choose another option.';
  }

  renderStartPreflight();
  elements.startPreflightDialog.showModal();
}

function goBackInPreflight() {
  const attempt = state.startAttempt;
  if (!attempt || attempt.questionIds.length === 0) return;
  attempt.error = null;
  if (attempt.status === 'review') {
    attempt.cursor = attempt.questionIds.length - 1;
  } else if (attempt.cursor > 0) {
    attempt.cursor -= 1;
  }
  attempt.status = 'question';
  renderStartPreflight();
}

function cancelStartAttempt() {
  if (elements.startPreflightDialog.open) elements.startPreflightDialog.close();
  state.startAttempt = null;
  state.isStarting = false;
  checkReadyState();
  elements.btnStartPresentation.focus();
}

async function launchStartAttempt() {
  const attempt = state.startAttempt;
  if (!attempt || state.isStarting) return;

  state.isStarting = true;
  attempt.status = 'launching';
  attempt.error = null;
  checkReadyState();
  if (elements.startPreflightDialog.open) elements.startPreflightDialog.close();

  try {
    for (const role of Object.keys(presentationElements)) {
      if (state.presentations[role].path) {
        checkFilenameDate(role, state.presentations[role].dateSource || state.presentations[role].path);
      }
    }

    const decisions = Object.fromEntries(Object.entries(attempt.decisions).map(([outputId, decision]) => [
      outputId,
      {
        mode: decision.mode,
        ...(decision.sourceRole ? { sourceRole: decision.sourceRole } : {})
      }
    ]));
    const launchRequest = {
      outputs: attempt.snapshot.outputs,
      decisions,
      preferredTimelineRoleId: attempt.snapshot.preferredTimelineRoleId,
      settings: attempt.snapshot.settings
    };

    setStatus('Starting presentation...');
    const result = await window.api.startPresentation(launchRequest);
    if (!result.success) throw new Error(result.error || 'The output windows could not be started');

    state.startAttempt = null;
    state.isStarting = false;
    state.isPresenting = true;
    state.activeLaunchPlan = result.plan || null;
    if (result.showState) handleShowStateChanged(result.showState);
    state.bible.isLive = false;
    state.bible.liveOutputIds = [];
    elements.bibleTargetList.replaceChildren();
    updateBibleLiveIndicator();
    state.totalSlides = result.totalSlides;
    state.currentSlide = 0;

    setWorkflowStage('show');
    renderOutputPreviews(state.activeLaunchPlan);

    await loadSlidesIfNeeded();
    renderThumbnails();
    updateSlideCounter();
    window.api.requestOutputPreviews();
    setStatus('Presentation started');
    window.setTimeout(() => {
      const target = !elements.btnNextSlide.disabled
        ? elements.btnNextSlide
        : elements.btnClearDisplays;
      target?.focus({ preventScroll: true });
    }, 0);
  } catch (error) {
    console.error('Error starting presentation:', error);
    state.isStarting = false;
    if (state.startAttempt !== attempt) return;
    attempt.status = 'review';
    attempt.error = error.message;
    renderStartPreflight();
    if (!elements.startPreflightDialog.open) elements.startPreflightDialog.showModal();
    checkReadyState();
    setStatus(`Could not start: ${error.message}`);
  }
}

// Spontaneous Bible display -------------------------------------------------
// Bible passages are temporary overlays. They never mutate the prepared slide
// order, so Return to slides reveals the exact cue that was underneath.
function openBibleDialog() {
  if (!state.isPresenting || !state.activeLaunchPlan) {
    setStatus('Start the show before sending a Bible passage live');
    return;
  }

  renderBibleTargets();
  renderBibleLookupState();
  if (!elements.bibleDialog.open) elements.bibleDialog.showModal();
  window.setTimeout(() => elements.bibleReference.focus(), 0);
}

function closeBibleDialog() {
  if (elements.bibleDialog.open) elements.bibleDialog.close();
  elements.btnOpenBible.focus();
}

function handleBibleLookupInputChanged() {
  state.bible.lookupVersion += 1;
  state.bible.query = elements.bibleReference.value.trim();
  state.bible.translationId = elements.bibleTranslation.value;
  state.bible.selectedBook = null;
  state.bible.passage = null;
  state.bible.choices = [];
  state.bible.busy = false;
  showBibleError('');
  renderBibleLookupState();
}

async function lookupBiblePassage(event) {
  event?.preventDefault();
  await performBibleLookup(state.bible.selectedBook);
}

async function performBibleLookup(selectedBook = null) {
  const query = elements.bibleReference.value.trim();
  const translationId = elements.bibleTranslation.value;
  if (!query) {
    showBibleError('Type a Bible reference first.');
    elements.bibleReference.focus();
    return;
  }

  state.bible.query = query;
  state.bible.translationId = translationId;
  state.bible.selectedBook = selectedBook;
  state.bible.passage = null;
  state.bible.choices = [];
  showBibleError('');
  const lookupVersion = ++state.bible.lookupVersion;
  setBibleBusy(true);
  renderBibleLookupState();

  try {
    if (typeof window.api.lookupBiblePassage !== 'function') {
      throw new Error('Bible lookup is not available in this build');
    }
    const result = await window.api.lookupBiblePassage({
      query,
      translationId,
      ...(selectedBook ? { selectedBook } : {})
    });
    if (lookupVersion !== state.bible.lookupVersion) return;

    if (result?.status === 'ambiguous') {
      state.bible.choices = Array.isArray(result.choices) ? result.choices : [];
      state.bible.selectedBook = null;
    } else if (result?.status === 'ok' && result.passage) {
      state.bible.passage = result.passage;
      state.bible.choices = [];
    } else {
      throw new Error(result?.message || 'That reference could not be found');
    }
  } catch (error) {
    if (lookupVersion !== state.bible.lookupVersion) return;
    showBibleError(error.message || 'The passage could not be loaded');
  } finally {
    if (lookupVersion === state.bible.lookupVersion) {
      setBibleBusy(false);
      renderBibleLookupState();
    }
  }
}

function setBibleBusy(busy) {
  state.bible.busy = busy;
  applyBibleControlLock();
  elements.btnLookupBible.textContent = busy ? 'Finding…' : 'Find passage';
}

function setBibleSending(sending) {
  state.bible.sending = sending;
  applyBibleControlLock();
  elements.btnSendBibleLive.textContent = sending ? 'Preparing screens…' : 'Send Live';
  updateBibleActions();
}

function applyBibleControlLock() {
  const locked = state.bible.busy
    || state.bible.sending
    || state.showEndSessionBusy;
  elements.bibleReference.disabled = locked;
  elements.bibleTranslation.disabled = locked;
  elements.btnLookupBible.disabled = locked;
  elements.bibleTargets.disabled = locked || !state.bible.passage;
  elements.btnReturnFromBible.disabled = state.bible.sending
    || state.showEndSessionBusy;
}

function showBibleError(message) {
  elements.bibleError.hidden = !message;
  elements.bibleError.textContent = message || '';
}

function bibleChoiceName(choice) {
  if (typeof choice === 'string') return choice;
  return choice?.name || choice?.book || choice?.label || '';
}

function renderBibleLookupState() {
  const { choices, passage, busy } = state.bible;

  elements.bibleAmbiguity.hidden = choices.length === 0;
  elements.bibleAmbiguityChoices.replaceChildren();
  if (choices.length > 0) {
    const fragment = document.createDocumentFragment();
    choices.forEach((choice, index) => {
      const name = bibleChoiceName(choice);
      if (!name) return;
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'bible-book-choice';
      button.textContent = name;
      button.dataset.bookName = name;
      button.setAttribute('role', 'option');
      button.setAttribute('aria-selected', index === 0 ? 'true' : 'false');
      button.tabIndex = index === 0 ? 0 : -1;
      button.addEventListener('focus', () => selectBibleChoiceButton(button));
      button.addEventListener('click', () => performBibleLookup(name));
      fragment.appendChild(button);
    });
    elements.bibleAmbiguityChoices.appendChild(fragment);
    window.setTimeout(() => elements.bibleAmbiguityChoices.querySelector('button')?.focus(), 0);
  }

  elements.biblePreview.hidden = !passage;
  elements.biblePreviewVerses.replaceChildren();
  if (passage) {
    elements.biblePreviewReference.textContent = passage.reference || 'Bible passage';
    elements.biblePreviewTranslation.textContent = passage.translationId
      || passage.translation?.id
      || state.bible.translationId;

    const verses = Array.isArray(passage.verses) ? passage.verses : [];
    if (verses.length > 0) {
      for (const verse of verses) {
        const paragraph = document.createElement('p');
        const number = document.createElement('sup');
        number.className = 'bible-preview-verse-number';
        number.textContent = String(verse.number ?? '');
        paragraph.append(number, document.createTextNode(String(verse.text || '')));
        elements.biblePreviewVerses.appendChild(paragraph);
      }
    } else {
      elements.biblePreviewVerses.textContent = passage.text || '';
    }

    const attribution = passage.attribution || passage.translation?.attribution || '';
    elements.biblePreviewAttribution.hidden = !attribution;
    elements.biblePreviewAttribution.textContent = attribution;
    if (!busy) window.setTimeout(() => elements.biblePreviewReference.focus(), 0);
  }

  elements.bibleTargets.disabled = !passage || busy || state.bible.sending;
  applyBibleControlLock();
  updateBibleActions();
}

function selectBibleChoiceButton(button) {
  elements.bibleAmbiguityChoices.querySelectorAll('.bible-book-choice').forEach(choice => {
    choice.setAttribute('aria-selected', choice === button ? 'true' : 'false');
    choice.tabIndex = choice === button ? 0 : -1;
  });
}

function handleBibleChoiceKeyboard(event) {
  const choices = [...elements.bibleAmbiguityChoices.querySelectorAll('.bible-book-choice')];
  if (choices.length === 0) return;
  const currentIndex = Math.max(0, choices.indexOf(document.activeElement));
  let nextIndex = currentIndex;
  if (event.key === 'ArrowDown' || event.key === 'ArrowRight') {
    nextIndex = (currentIndex + 1) % choices.length;
  } else if (event.key === 'ArrowUp' || event.key === 'ArrowLeft') {
    nextIndex = (currentIndex - 1 + choices.length) % choices.length;
  } else if (event.key === 'Enter' || event.key === ' ') {
    event.preventDefault();
    choices[currentIndex].click();
    return;
  } else {
    return;
  }
  event.preventDefault();
  choices[nextIndex].focus();
}

function renderBibleTargets() {
  const existingOptions = [...elements.bibleTargetList.querySelectorAll('input[type="checkbox"]')];
  const hadExistingOptions = existingOptions.length > 0;
  const previousSelection = new Set(existingOptions.filter(input => input.checked).map(input => input.value));
  const outputs = state.activeLaunchPlan?.outputs || [];
  const defaultSelection = state.bible.isLive
    ? new Set(state.bible.liveOutputIds)
    : (hadExistingOptions ? previousSelection : new Set(outputs.map(output => output.id)));

  const fragment = document.createDocumentFragment();
  for (const output of outputs) {
    const label = document.createElement('label');
    label.className = 'bible-target-option';
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.value = output.id;
    input.checked = defaultSelection.has(output.id);
    const copy = document.createElement('span');
    copy.textContent = output.name;
    label.append(input, copy);
    fragment.appendChild(label);
  }
  elements.bibleTargetList.replaceChildren(fragment);
  updateBibleActions();
}

function getSelectedBibleTargetIds() {
  return [...elements.bibleTargetList.querySelectorAll('input[type="checkbox"]:checked')]
    .map(input => input.value);
}

function updateBibleActions() {
  const hasTargets = getSelectedBibleTargetIds().length > 0;
  elements.btnSendBibleLive.disabled = state.bible.busy
    || state.bible.sending
    || state.showEndSessionBusy
    || !state.bible.passage
    || !hasTargets
    || volunteerControlsAreLocked();
  elements.btnReturnFromBible.hidden = !state.bible.isLive;
  elements.btnReturnFromBible.disabled = state.showEndSessionBusy;
  updateBibleLiveIndicator();
}

function updateBibleLiveIndicator() {
  elements.btnOpenBible.classList.toggle('is-live', state.bible.isLive);
  const controls = state.showState?.operator?.controls
    || state.showState?.controls
    || {};
  elements.btnOpenBible.disabled =
    state.showEndSessionBusy
    || (!state.bible.isLive && controls.canShowBible === false);
  elements.btnPrevSlide.disabled =
    state.showEndSessionBusy
    || state.bible.isLive
    || state.cueNavigationBusy
    || controls.canPrevious === false;
  elements.btnNextSlide.disabled =
    state.showEndSessionBusy
    || state.bible.isLive
    || state.cueNavigationBusy
    || controls.canNext === false;
  const detail = elements.btnOpenBible.querySelector('small');
  if (detail) detail.textContent = state.bible.isLive ? 'Passage is live' : 'Show a passage now';
}

async function sendBibleLive() {
  if (
    state.showEndSessionBusy
    || !state.bible.passage
    || state.bible.busy
    || state.bible.sending
  ) return;
  const targetOutputIds = getSelectedBibleTargetIds();
  if (targetOutputIds.length === 0) {
    showBibleError('Choose at least one output screen.');
    return;
  }

  const sendVersion = ++state.bible.sendVersion;
  const request = {
    query: state.bible.query,
    translationId: state.bible.translationId,
    ...(state.bible.selectedBook ? { selectedBook: state.bible.selectedBook } : {}),
    targetOutputIds: [...targetOutputIds]
  };
  showBibleError('');
  setBibleSending(true);
  try {
    const result = await window.api.showBiblePassage(request);
    if (sendVersion !== state.bible.sendVersion) return;
    if (!result?.success) throw new Error(result?.message || 'The passage could not be shown');
    if (result.passage) state.bible.passage = result.passage;
    state.bible.isLive = true;
    state.bible.liveOutputIds = [...targetOutputIds];
    updateBibleActions();
    const reference = state.bible.passage?.reference || state.bible.query;
    setStatus(`${reference} is live on ${targetOutputIds.length} ${targetOutputIds.length === 1 ? 'output' : 'outputs'}`);
    closeBibleDialog();
  } catch (error) {
    if (sendVersion !== state.bible.sendVersion) return;
    showBibleError(error.message || 'The passage could not be shown');
  } finally {
    if (sendVersion === state.bible.sendVersion) setBibleSending(false);
  }
}

async function returnFromBible() {
  if (state.showEndSessionBusy) return;
  try {
    await window.api.hideBiblePassage();
    state.bible.isLive = false;
    state.bible.liveOutputIds = [];
    updateBibleActions();
    setStatus('Returned to the current service slides');
    closeBibleDialog();
  } catch (error) {
    showBibleError(error.message || 'Could not return to the service slides');
  }
}

// Show-only LAN Remote Control ---------------------------------------------
// The desktop renderer can ask the main process to open or close a pairing
// window, but it never receives a device token or an arbitrary bind address.
function remoteApiAvailable() {
  return [
    'listRemoteBindings',
    'getRemoteState',
    'enableRemote',
    'rotateRemotePairing',
    'closeRemotePairing',
    'revokeRemoteDevices',
    'disableRemote'
  ].every(method => typeof window.api?.[method] === 'function');
}

function remoteErrorMessage(error, fallback = 'Remote Control could not complete that action.') {
  const message = typeof error?.message === 'string' ? error.message : '';
  return message
    .replace(/^Error invoking remote method '[^']+':\s*/u, '')
    .replace(/^Error:\s*/u, '')
    .trim() || fallback;
}

function remoteShowIsControllable() {
  const show = state.showState;
  return Boolean(show?.outputSessionId && (show.phase === 'live' || show.phase === 'cleared'));
}

function handleRemoteStateChanged(next) {
  if (!next || typeof next !== 'object' || typeof next.enabled !== 'boolean') return;
  const incomingRevision = Number.isSafeInteger(next.managementRevision)
    ? next.managementRevision
    : 0;
  const currentRevision = Number.isSafeInteger(state.remote.status?.managementRevision)
    ? state.remote.status.managementRevision
    : -1;
  if (incomingRevision < currentRevision) return;
  state.remote.status = next;
  if (next.lastError) state.remote.error = String(next.lastError);
  renderRemoteControl();
}

async function refreshRemoteControl({ refreshBindings = false } = {}) {
  if (!remoteApiAvailable()) {
    state.remote.error = 'This build does not include phone Remote Control.';
    renderRemoteControl();
    return;
  }
  try {
    const [status, bindings] = await Promise.all([
      window.api.getRemoteState(),
      refreshBindings ? window.api.listRemoteBindings() : Promise.resolve(null)
    ]);
    handleRemoteStateChanged(status);
    if (Array.isArray(bindings)) {
      state.remote.bindings = bindings;
      renderRemoteBindingOptions();
    }
  } catch (error) {
    state.remote.error = remoteErrorMessage(error, 'Remote Control status is unavailable.');
    renderRemoteControl();
  }
}

async function refreshRemoteBindings() {
  if (!remoteApiAvailable() || state.remote.busy) return;
  state.remote.busy = true;
  state.remote.error = null;
  renderRemoteControl();
  try {
    const bindings = await window.api.listRemoteBindings();
    state.remote.bindings = Array.isArray(bindings) ? bindings : [];
    renderRemoteBindingOptions();
  } catch (error) {
    state.remote.error = remoteErrorMessage(error, 'SyncShow could not inspect the local networks.');
  } finally {
    state.remote.busy = false;
    renderRemoteControl();
  }
}

function renderRemoteBindingOptions() {
  const previous = elements.remoteInterfaceSelect.value;
  const bindings = state.remote.bindings;
  const options = [];
  if (bindings.length === 0) {
    const option = document.createElement('option');
    option.value = '';
    option.disabled = true;
    option.selected = true;
    option.textContent = 'No private network found';
    options.push(option);
  } else {
    if (bindings.length > 1) {
      const placeholder = document.createElement('option');
      placeholder.value = '';
      placeholder.disabled = true;
      placeholder.selected = true;
      placeholder.textContent = 'Choose the phone network…';
      options.push(placeholder);
    }
    for (const binding of bindings) {
      if (!binding || typeof binding.id !== 'string' || typeof binding.label !== 'string') continue;
      const option = document.createElement('option');
      option.value = binding.id;
      option.textContent = binding.label;
      options.push(option);
    }
  }
  elements.remoteInterfaceSelect.replaceChildren(...options);
  const preserved = bindings.some(binding => binding.id === previous);
  if (preserved) elements.remoteInterfaceSelect.value = previous;
  else if (bindings.length === 1) elements.remoteInterfaceSelect.value = bindings[0].id;
  renderRemoteControl();
}

async function openRemoteDialog(event) {
  const opener = event?.currentTarget;
  if (opener && typeof opener.focus === 'function') remoteDialogOpener = opener;
  const dialogGeneration = ++remoteDialogGeneration;
  state.remote.error = null;
  if (!elements.remoteDialog.open) elements.remoteDialog.showModal();
  renderRemoteControl();
  await refreshRemoteControl({ refreshBindings: true });
  if (dialogGeneration !== remoteDialogGeneration || !elements.remoteDialog.open) return;

  if (!remoteShowIsControllable()) {
    state.remote.error = 'Start or restore the Show before turning on Remote Control.';
    renderRemoteControl();
    return;
  }
}

function closeRemoteDialog() {
  remoteDialogGeneration += 1;
  if (elements.remoteDialog.open) elements.remoteDialog.close();
  stopRemoteExpiryClock();
  // Always send cancellation: the main process may still be generating the
  // initial QR code even though the last renderer snapshot still says Off.
  if (typeof window.api.closeRemotePairing === 'function') {
    window.api.closeRemotePairing().catch(error => {
      console.warn('[Remote] Could not close the unused pairing code:', error);
    });
  }
  const opener = remoteDialogOpener;
  remoteDialogOpener = null;
  if (opener?.isConnected && typeof opener.focus === 'function') opener.focus();
  else elements.btnOpenRemote.focus();
}

async function enableRemoteControl() {
  if (!remoteApiAvailable() || state.remote.busy) return;
  const bindingId = elements.remoteInterfaceSelect.value;
  if (!bindingId) {
    state.remote.error = 'Choose the Wi-Fi or wired network used by the phone.';
    renderRemoteControl();
    return;
  }
  if (!remoteShowIsControllable()) {
    state.remote.error = 'Start or restore the Show before turning on Remote Control.';
    renderRemoteControl();
    return;
  }

  state.remote.busy = true;
  state.remote.error = null;
  renderRemoteControl();
  try {
    handleRemoteStateChanged(await window.api.enableRemote(bindingId));
    if (!elements.remoteDialog.open) {
      await window.api.closeRemotePairing();
      return;
    }
    setStatus('Remote Control is ready for a phone on the trusted local network');
  } catch (error) {
    state.remote.error = remoteErrorMessage(error, 'Remote Control could not use that network.');
  } finally {
    state.remote.busy = false;
    renderRemoteControl();
  }
}

async function rotateRemotePairing() {
  if (!remoteApiAvailable() || state.remote.busy || !state.remote.status?.enabled) return;
  state.remote.busy = true;
  state.remote.error = null;
  renderRemoteControl();
  try {
    handleRemoteStateChanged(await window.api.rotateRemotePairing());
  } catch (error) {
    state.remote.error = remoteErrorMessage(error, 'SyncShow could not create a new pair code.');
  } finally {
    state.remote.busy = false;
    renderRemoteControl();
  }
}

async function revokeRemoteDevices() {
  if (!remoteApiAvailable() || state.remote.busy) return;
  const count = state.remote.status?.pairedDeviceCount || 0;
  if (count === 0) return;
  if (!window.confirm(`Disconnect ${count === 1 ? 'the paired phone' : `all ${count} paired phones`}?`)) return;

  state.remote.busy = true;
  state.remote.error = null;
  renderRemoteControl();
  try {
    handleRemoteStateChanged(await window.api.revokeRemoteDevices());
    setStatus('All Remote Control phones were disconnected');
  } catch (error) {
    state.remote.error = remoteErrorMessage(error, 'The paired phones could not be disconnected.');
  } finally {
    state.remote.busy = false;
    renderRemoteControl();
  }
}

async function turnRemoteOff() {
  if (!remoteApiAvailable() || state.remote.busy) return;
  state.remote.busy = true;
  state.remote.error = null;
  renderRemoteControl();
  try {
    handleRemoteStateChanged(await window.api.disableRemote());
    setStatus('Remote Control is off');
  } catch (error) {
    state.remote.error = remoteErrorMessage(error, 'Remote Control could not be turned off cleanly.');
  } finally {
    state.remote.busy = false;
    renderRemoteControl();
  }
}

function phoneCountLabel(status, { live = false } = {}) {
  const paired = Math.max(0, Number(status?.pairedDeviceCount) || 0);
  const connected = Math.max(0, Number(status?.connectedDeviceCount) || 0);
  if (live) {
    if (connected > 0) return `${connected} ${connected === 1 ? 'phone' : 'phones'} open · ${paired} paired`;
    return paired > 0
      ? `No phone open now · ${paired} paired`
      : 'No phones connected';
  }
  if (paired === 0) return 'No phones paired';
  const names = Array.isArray(status?.devices)
    ? status.devices.map(device => String(device?.name || '')).filter(Boolean).slice(0, 3)
    : [];
  const nameText = names.length > 0 ? ` · ${names.join(', ')}` : '';
  return `${paired} ${paired === 1 ? 'phone' : 'phones'} paired · ${connected} open now${nameText}`;
}

function stopRemoteExpiryClock() {
  if (remoteExpiryInterval) window.clearInterval(remoteExpiryInterval);
  remoteExpiryInterval = null;
}

function syncRemoteExpiryClock(pairing) {
  const shouldRun = Boolean(
    elements.remoteDialog.open
    && pairing
    && !pairing.expired
    && Number.isFinite(pairing.expiresAt)
    && pairing.expiresAt > Date.now()
  );
  if (!shouldRun) {
    stopRemoteExpiryClock();
    return;
  }
  if (!remoteExpiryInterval) {
    remoteExpiryInterval = window.setInterval(renderRemoteControl, 1000);
  }
}

function renderRemoteControl() {
  const status = state.remote.status || {};
  const enabled = status.enabled === true;
  const paired = Math.max(0, Number(status.pairedDeviceCount) || 0);
  const pairing = status.pairing || null;
  const pairingExpired = !pairing
    || pairing.expired === true
    || !Number.isFinite(pairing.expiresAt)
    || pairing.expiresAt <= Date.now();
  const controllable = remoteShowIsControllable();

  elements.remoteOffView.hidden = enabled;
  elements.remoteOnView.hidden = !enabled;
  elements.remoteLiveStrip.hidden = !enabled;
  setTextIfChanged(elements.remoteTileStatus, enabled ? 'On' : 'Off');
  elements.remoteTileStatus.classList.toggle('is-on', enabled);
  elements.btnOpenRemote.classList.toggle('is-on', enabled);
  elements.remoteDialogBadge.textContent = state.remote.busy ? 'Working…' : (enabled ? 'On' : 'Off');
  elements.remoteDialogBadge.classList.toggle('is-on', enabled);
  setTextIfChanged(elements.remoteTileSummary, enabled
    ? phoneCountLabel(status, { live: true })
    : 'Off · Control this Show from a phone');
  setTextIfChanged(elements.remoteLiveDeviceCount, phoneCountLabel(status, { live: true }));
  setTextIfChanged(elements.remoteDeviceSummary, phoneCountLabel(status));

  setTextIfChanged(elements.remoteDialogStatus, state.remote.busy
    ? 'Applying the Remote Control change…'
    : enabled
      ? 'Remote Control is on for this Show. Local controls remain authoritative.'
      : controllable
        ? 'Remote Control is off.'
        : 'Start or restore the Show to make Remote Control available.');
  const displayedError = state.remote.error || status.lastError || '';
  elements.remoteError.hidden = !displayedError;
  elements.remoteError.textContent = displayedError;

  const hasBindings = state.remote.bindings.length > 0;
  elements.remoteNetworkHelp.textContent = hasBindings
    ? 'Phones must use this same trusted Wi-Fi or wired network. SyncShow never opens Remote to the internet.'
    : 'No private Wi-Fi or wired network was found. Connect this computer to the same trusted network as the phone, then refresh.';
  elements.remoteInterfaceSelect.disabled = state.remote.busy || enabled || !hasBindings;
  elements.btnRefreshRemoteInterfaces.disabled = state.remote.busy || enabled;
  elements.btnEnableRemote.disabled = state.remote.busy
    || enabled
    || !controllable
    || !elements.remoteInterfaceSelect.value;
  elements.btnEnableRemote.textContent = state.remote.busy && !enabled ? 'Turning on…' : 'Turn on Remote';

  elements.remoteNetworkSummary.textContent = status.binding?.label
    ? `${status.binding.label} · ${status.origin || 'local network'}`
    : 'Same-network phones can connect while this Show is open.';
  elements.btnRevokeRemoteDevices.disabled = state.remote.busy || paired === 0;
  elements.btnRotateRemotePairing.disabled = state.remote.busy;
  elements.btnCreateRemotePairing.disabled = state.remote.busy;
  elements.btnRemoteOff.disabled = state.remote.busy;
  elements.btnRemoteOffDialog.disabled = state.remote.busy;

  elements.remotePairingCard.hidden = !enabled || pairingExpired;
  elements.remotePairExpired.hidden = !enabled || !pairingExpired;
  if (enabled && pairingExpired) {
    const genuinelyExpired = Boolean(pairing?.expired || pairing?.expiresAt);
    elements.remotePairClosedTitle.textContent = genuinelyExpired
      ? 'Pairing code expired'
      : paired > 0
        ? 'Phone connected'
        : 'No pair code open';
    elements.remotePairClosedText.textContent = paired > 0
      ? 'Connected phones still work. Create a new code only when another phone needs access.'
      : 'Create a one-time code when a trusted phone is ready to connect.';
  }
  if (enabled && !pairingExpired) {
    const code = String(pairing.code || '').replace(/\D/g, '').slice(0, 6);
    const formattedCode = code.length === 6 ? `${code.slice(0, 3)} ${code.slice(3)}` : '— — —';
    const seconds = Math.max(0, Math.ceil((pairing.expiresAt - Date.now()) / 1000));
    const minutes = Math.floor(seconds / 60);
    const remainder = String(seconds % 60).padStart(2, '0');
    elements.remotePairCode.textContent = formattedCode;
    elements.remotePairCode.setAttribute('aria-label', code.length === 6
      ? `Pairing code ${code.split('').join(' ')}`
      : 'Pairing code not ready');
    elements.remotePairExpiry.textContent = `Expires in ${minutes}:${remainder}`;
    elements.remotePairAddress.textContent = status.origin || '';
    const qrDataUrl = typeof pairing.qrDataUrl === 'string' ? pairing.qrDataUrl : '';
    if (qrDataUrl.startsWith('data:image/png;base64,') && qrDataUrl.length < 500000) {
      elements.remotePairQr.src = qrDataUrl;
    } else {
      elements.remotePairQr.removeAttribute('src');
    }
  } else {
    elements.remotePairCode.textContent = '— — —';
    elements.remotePairCode.setAttribute('aria-label', 'Pairing code not ready');
    elements.remotePairExpiry.textContent = 'Create a code when another phone needs access.';
    elements.remotePairAddress.textContent = status.origin || '';
    elements.remotePairQr.removeAttribute('src');
  }
  syncRemoteExpiryClock(pairingExpired ? null : pairing);
}

// Helper to ensure slides are loaded
async function loadSlidesIfNeeded() {
  for (const role of Object.keys(presentationElements)) {
    if (state.presentations[role].loaded && state.presentations[role].slides.length === 0) {
      await loadSlideList(role, { render: false });
    }
  }
}

function beginShowOutputAction() {
  state.showActionRequest += 1;
  return {
    id: state.showActionRequest,
    revision: Number.isInteger(state.showState?.revision) ? state.showState.revision : -1
  };
}

function updateShowEndSessionBarrier() {
  const controls = state.showState?.operator?.controls
    || state.showState?.controls
    || {};
  elements.btnShowDisplays.disabled =
    state.showEndSessionBusy || controls.canRestore === false;
  elements.btnClearDisplays.disabled =
    state.showEndSessionBusy || controls.canClear === false;
  elements.btnStopDisplays.disabled =
    state.showEndSessionBusy || controls.canStop === false;
  elements.btnBackToSetup.disabled =
    state.showEndSessionBusy || controls.canEndSession === false;
  elements.btnOpenRemote.disabled =
    state.showEndSessionBusy || controls.canManageRemote === false;
  applyBibleControlLock();
  updateBibleActions();
  renderShowFinishAction();
}

function showEndSessionBlocksAction() {
  if (!state.showEndSessionBusy) return false;
  setStatus('Finishing the service safely; wait for Load and the service handoff');
  return true;
}

function applyShowOutputActionResult(action, result) {
  const stateApplied = result?.showState
    ? handleShowStateChanged(result.showState)
    : true;
  return action.id === state.showActionRequest && stateApplied;
}

function showOutputActionCanReportError(action) {
  const currentRevision = Number.isInteger(state.showState?.revision)
    ? state.showState.revision
    : -1;
  return action.id === state.showActionRequest && currentRevision <= action.revision;
}

// Show displays - re-show the display windows and current slide
async function showDisplays() {
  if (showEndSessionBlocksAction()) return;
  const action = beginShowOutputAction();
  try {
    const result = await window.api.showDisplays();
    if (!applyShowOutputActionResult(action, result)) return;
    if (!result?.showState) state.isPresenting = true;
    setStatus('Displays shown');
  } catch (error) {
    console.error('Error showing displays:', error);
    if (showOutputActionCanReportError(action)) {
      showOutputActionError('Could not restore the outputs', error);
    }
  }
}

// Clear displays - show black screens
async function clearDisplays() {
  if (showEndSessionBlocksAction()) return;
  const action = beginShowOutputAction();
  try {
    const result = await window.api.clearDisplays();
    if (!applyShowOutputActionResult(action, result)) return;
    if (!result?.showState) setPreviewsBlacked(true);
    setStatus('Displays cleared (black screens)');
  } catch (error) {
    console.error('Error clearing displays:', error);
    if (showOutputActionCanReportError(action)) {
      showOutputActionError('Could not clear the outputs', error);
    }
  }
}

// Handle fade duration change
async function handleFadeDurationChange() {
  const duration = parseIntegerOr(elements.fadeDuration.value, 0);
  stageProfilePreferencesFromControls();
  setStatus(duration === 0
    ? 'Transition change staged: Instant — save the venue profile to apply it'
    : `Transition change staged: ${duration}ms — save the venue profile to apply it`);
}

// Handle sync mode toggle
async function handleSyncModeChange() {
  const enabled = elements.syncMode.checked;
  stageProfilePreferencesFromControls();
  setStatus(enabled
    ? 'Experimental synchronized reveal staged — save and test it before service'
    : 'Experimental synchronized reveal will be off after the profile is saved');
}

// Stop displays - hide windows and unregister keyboard shortcuts
async function stopDisplays() {
  if (showEndSessionBlocksAction()) return;
  const action = beginShowOutputAction();
  try {
    const result = await window.api.stopPresentation();
    if (!applyShowOutputActionResult(action, result)) return;
    if (!result?.showState) state.isPresenting = false;
    setStatus('Presentation stopped - keyboard shortcuts disabled');
  } catch (error) {
    console.error('Error stopping displays:', error);
    if (showOutputActionCanReportError(action)) {
      showOutputActionError('Could not stop the outputs', error);
    }
  }
}

function setShowHandoffBusy(busy) {
  state.showHandoffBusy = busy;
  elements.btnShowHandoffCompleted.disabled = busy;
  elements.btnShowHandoffFollowUp.disabled = busy;
  elements.btnOpenShowSermonHandoff.disabled = busy;
  elements.btnCloseShowHandoff.disabled = busy;
}

function setShowHandoffError(message = '') {
  elements.showHandoffError.hidden = !message;
  elements.showHandoffError.textContent = message;
}

function normalizePowerPointServiceHandoff(rawHandoff, now = Date.now()) {
  if (
    !rawHandoff
    || typeof rawHandoff !== 'object'
    || Array.isArray(rawHandoff)
  ) {
    return null;
  }
  const exactKeys = [
    'expiresAt',
    'receiptToken',
    'schemaVersion',
    'serviceDate'
  ];
  if (
    Object.keys(rawHandoff).sort().join('\n') !== exactKeys.join('\n')
    || rawHandoff.schemaVersion !== 1
  ) {
    return null;
  }
  const serviceDate = String(rawHandoff.serviceDate || '').trim();
  const receiptToken = String(rawHandoff.receiptToken || '').trim();
  const expiresAt = String(rawHandoff.expiresAt || '').trim();
  const expiry = Date.parse(expiresAt);
  if (
    !/^\d{4}-\d{2}-\d{2}$/u.test(serviceDate)
    || !/^[A-Za-z0-9_-]{32}$/u.test(receiptToken)
    || !Number.isFinite(expiry)
    || expiry <= Number(now)
  ) {
    return null;
  }
  return Object.freeze({
    schemaVersion: 1,
    serviceDate,
    receiptToken,
    expiresAt
  });
}

function resetShowHandoffContext() {
  state.showHandoffMode = null;
  state.postShowPowerPointHandoff = null;
  delete elements.showHandoffDialog.dataset.mode;
}

function openShowHandoffDialog(rawPowerPointHandoff = null) {
  const handoff = state.serviceHandoff;
  if (elements.showHandoffDialog.open) return false;
  const nativeHandoff = handoff?.planning ? handoff : null;
  const powerPointHandoff = nativeHandoff
    ? null
    : normalizePowerPointServiceHandoff(rawPowerPointHandoff);
  if (!nativeHandoff && !powerPointHandoff) return false;

  const powerPointMode = Boolean(powerPointHandoff);
  state.showHandoffMode = powerPointMode ? 'powerpoint' : 'native';
  state.postShowPowerPointHandoff = powerPointHandoff;
  elements.showHandoffDialog.dataset.mode = state.showHandoffMode;
  elements.showHandoffDescription.textContent = powerPointMode
    ? 'Open the sermon follow-up for the exact verified PowerPoint service that just ended. The original presentations stay unchanged, and nothing here publishes to Community.'
    : 'Complete this exact reviewed service and open its sermon handoff, choose follow-up, or open the handoff without changing status. Nothing here publishes to Community.';
  elements.btnShowHandoffCompleted.hidden = powerPointMode;
  elements.btnShowHandoffFollowUp.hidden = powerPointMode;
  elements.btnOpenShowSermonHandoff.textContent = powerPointMode
    ? 'Open sermon follow-up'
    : 'Open sermon handoff';
  elements.btnOpenShowSermonHandoff.classList.toggle('btn-primary', powerPointMode);
  elements.btnOpenShowSermonHandoff.classList.toggle('btn-outline', !powerPointMode);
  elements.btnCloseShowHandoff.textContent = powerPointMode
    ? 'Not now'
    : 'Keep current status';

  if (powerPointMode) {
    elements.showHandoffServiceTitle.textContent = 'PowerPoint service';
    elements.showHandoffServiceMeta.textContent =
      `${formatServiceDate(powerPointHandoff.serviceDate)} · exact verified service set`;
  } else {
    const schedule = [
      formatServiceDate(nativeHandoff.project.serviceDate),
      formatServiceStartTime(nativeHandoff.planning.startTime),
      `revision ${nativeHandoff.project.revision}`
    ].filter(Boolean);
    elements.showHandoffServiceTitle.textContent = nativeHandoff.project.title;
    elements.showHandoffServiceMeta.textContent =
      `${schedule.join(' · ')} · exact package ${nativeHandoff.project.revisionId.slice(0, 10)}`;
  }
  setShowHandoffError('');
  setShowHandoffBusy(false);
  elements.showHandoffDialog.showModal();
  window.setTimeout(() => elements.showHandoffTitle.focus(), 0);
  return true;
}

function closeShowHandoffDialog() {
  if (state.showHandoffBusy || !elements.showHandoffDialog.open) return;
  setShowHandoffError('');
  elements.showHandoffDialog.close();
  resetShowHandoffContext();
  elements.btnStageLoad.focus();
}

async function savePostShowPlanningStatus(status, {
  openSermonHandoff = false
} = {}) {
  const handoff = state.serviceHandoff;
  const completeAndOpen = status === 'completed'
    && openSermonHandoff === true;
  if (
    state.showHandoffBusy
    || state.showHandoffMode !== 'native'
    || !handoff?.planning
    || !['completed', 'needs-follow-up'].includes(status)
  ) {
    return;
  }

  setShowHandoffBusy(true);
  setShowHandoffError('');
  try {
    const result = await window.api.setServicePlanningStatus({
      projectId: handoff.project.id,
      expectedRevisionId: handoff.project.revisionId,
      status
    });
    if (
      result?.project?.id !== handoff.project.id
      || result?.project?.planning?.status !== status
      || typeof result?.revisionId !== 'string'
      || !/^[a-f0-9]{64}$/u.test(result.revisionId)
    ) {
      throw new Error('SyncShow did not confirm the saved post-service planning state.');
    }

    state.postShowOutcome = {
      status,
      revisionId: result.revisionId
    };
    renderLoadServiceHandoff();
    if (completeAndOpen) {
      let opened = null;
      try {
        await prepareController.activate();
        opened = await prepareController.openServiceHandoff({
          project: {
            id: result.project.id,
            revisionId: result.revisionId
          }
        });
      } catch (error) {
        console.error(
          '[ServiceHandoff] Service completed, but its exact sermon handoff did not open:',
          error
        );
      }

      setShowHandoffBusy(false);
      if (elements.showHandoffDialog.open) elements.showHandoffDialog.close();
      resetShowHandoffContext();
      setWorkflowStage('prepare', { localTools: true });
      if (opened?.sermonOpened) {
        setStatus('Service marked Completed and its exact sermon handoff opened in Prepare');
      } else if (opened?.opened) {
        setStatus('Service marked Completed and its exact revision opened; no linked sermon packet was found');
      } else {
        setStatus('Service marked Completed, but the sermon handoff changed before it opened; review the newest revision in Prepare');
      }
      return result;
    }

    setShowHandoffBusy(false);
    elements.showHandoffDialog.close();
    resetShowHandoffContext();
    const label = planningStatusLabel(status);
    setStatus(
      `Service marked ${label}. The Show package remains preserved as the exact revision that ran.`
    );
  } catch (error) {
    console.error('[ServiceHandoff] Could not save post-service status:', error);
    setShowHandoffError(operatorErrorMessage(
      error,
      'The service changed or could not be updated. Nothing was guessed; open Prepare and review the newest revision.'
    ));
    setShowHandoffBusy(false);
  }
}

async function completeAndOpenPostShowSermonHandoff() {
  return savePostShowPlanningStatus('completed', {
    openSermonHandoff: true
  });
}

async function openPostShowSermonHandoff() {
  if (state.showHandoffMode === 'powerpoint') {
    const handoff = state.postShowPowerPointHandoff;
    if (state.showHandoffBusy || !handoff) return;
    if (Date.parse(handoff.expiresAt) <= Date.now()) {
      setShowHandoffError(
        'This exact PowerPoint follow-up has expired. Close this message, open Prepare, and review the Current PowerPoint service before continuing.'
      );
      return;
    }
    if (typeof prepareController?.openCurrentServiceCompanion !== 'function') {
      setShowHandoffError(
        'This build cannot open the exact PowerPoint sermon follow-up in Prepare.'
      );
      return;
    }

    setShowHandoffBusy(true);
    setShowHandoffError('');
    let result = null;
    try {
      await prepareController.activate({
        exactPostShowHandoff: true
      });
      result = await prepareController.openCurrentServiceCompanion({
        receiptToken: handoff.receiptToken,
        expectedServiceDate: handoff.serviceDate,
        exactPostShowHandoff: true
      });
      if (!result?.opened) {
        throw new Error(
          result?.error
          || 'The exact PowerPoint service changed or the follow-up receipt expired.'
        );
      }
      if (elements.showHandoffDialog.open) elements.showHandoffDialog.close();
      resetShowHandoffContext();
      setWorkflowStage('prepare', {
        localTools: true,
        exactPostShowHandoff: true
      });
      setStatus(result.sermonOpened
        ? 'Opened the exact PowerPoint sermon follow-up in Prepare'
        : 'Opened the exact PowerPoint service record to finish the sermon handoff');
    } catch (error) {
      console.error('[ServiceHandoff] Could not open PowerPoint sermon follow-up:', error);
      setShowHandoffError(operatorErrorMessage(
        error,
        'The exact PowerPoint service changed or the follow-up receipt expired. Nothing else was opened or guessed.'
      ));
      window.setTimeout(() => elements.showHandoffTitle.focus(), 0);
    } finally {
      setShowHandoffBusy(false);
    }
    return;
  }

  const handoff = state.serviceHandoff;
  if (
    state.showHandoffBusy
    || state.showHandoffMode !== 'native'
    || !handoff?.planning
  ) return;
  if (typeof prepareController?.openServiceHandoff !== 'function') {
    setShowHandoffError('This build cannot open the exact sermon handoff in Prepare.');
    return;
  }

  setShowHandoffBusy(true);
  setShowHandoffError('');
  let result = null;
  try {
    await prepareController.activate();
    result = await prepareController.openServiceHandoff(handoff);
  } catch (error) {
    console.error('[ServiceHandoff] Could not open sermon handoff:', error);
  } finally {
    setShowHandoffBusy(false);
    if (elements.showHandoffDialog.open) elements.showHandoffDialog.close();
    resetShowHandoffContext();
    setWorkflowStage('prepare', { localTools: true });
  }

  if (result?.sermonOpened) {
    setStatus('Opened the exact sermon handoff in Prepare');
  } else if (result?.opened) {
    setStatus('Opened the exact service revision; no linked sermon packet was found');
  } else {
    setStatus('The service changed after this Show package was prepared; review the newest revision');
  }
}

// Back to setup - stop presentation and go back to setup screen
async function backToSetup(targetStage = 'load') {
  if (state.showEndSessionBusy) return;
  state.showEndSessionBusy = true;
  if (state.bible.sending) {
    state.bible.sendVersion += 1;
    setBibleSending(false);
  }
  elements.btnBackToSetup.setAttribute('aria-busy', 'true');
  updateShowEndSessionBarrier();
  const action = beginShowOutputAction();
  try {
    // Back ends the output session. Stop merely hides it so Show/Restore can be
    // used locally; retaining that hidden session after returning to Load would
    // let a stale future Remote client bring an old service back on screen.
    let result;
    if (typeof window.api.endPresentation === 'function') {
      result = await window.api.endPresentation();
    } else {
      if (state.bible.isLive) await window.api.hideBiblePassage();
      result = await window.api.stopPresentation();
    }
    if (!applyShowOutputActionResult(action, result)) return;
    
    state.isPresenting = false;
    state.activeLaunchPlan = null;
    state.bible.isLive = false;
    state.bible.liveOutputIds = [];
    if (elements.bibleDialog.open) elements.bibleDialog.close();
    updateBibleLiveIndicator();
    
    setWorkflowStage(targetStage === 'prepare' ? 'prepare' : 'load');
    
    setStatus(targetStage === 'prepare' ? 'Returned to Prepare' : 'Returned to Load');
    if (targetStage === 'prepare') {
      elements.btnStagePrepare.focus();
    } else if (!openShowHandoffDialog(result?.powerPointServiceHandoff || null)) {
      elements.btnStageLoad.focus();
    }
  } catch (error) {
    console.error('Error returning to setup:', error);
    if (showOutputActionCanReportError(action)) {
      showOutputActionError('Could not return to Load safely', error);
    }
  } finally {
    state.showEndSessionBusy = false;
    elements.btnBackToSetup.removeAttribute('aria-busy');
    updateShowEndSessionBarrier();
  }
}

// Slide Navigation
async function navigateSlide(delta, forwardInput = 'right') {
  if (showEndSessionBlocksAction()) return;
  if (state.bible.isLive) {
    setStatus('Return from the live Bible passage before changing slides');
    return;
  }
  if (delta !== -1 && delta !== 1) return;
  if (state.cueNavigationBusy) return;
  state.cueNavigationBusy = true;
  elements.btnPrevSlide.setAttribute('aria-busy', 'true');
  elements.btnNextSlide.setAttribute('aria-busy', 'true');
  updateBibleLiveIndicator();
  const action = beginShowOutputAction();
  try {
    const result = await (delta < 0
      ? window.api.prevSlide()
      : window.api.nextSlide(forwardInput));
    applyShowOutputActionResult(action, result);
    if (result?.videoHandled) {
      setStatus(result.videoState === 'playing'
        ? 'Video playing — Space pauses; Right skips to the next cue'
        : 'Video paused — Space resumes; Right skips to the next cue');
    }
  } catch (error) {
    console.error('Error changing slides:', error);
    // The transition itself publishes a pending revision before it can fail.
    // Keep that authoritative state update, but still explain a timeout or
    // output rejection when no newer local action (Clear/Stop/etc.) replaced
    // this one.
    if (action.id === state.showActionRequest) {
      showOutputActionError('Could not change slides', error);
    }
  } finally {
    state.cueNavigationBusy = false;
    elements.btnPrevSlide.removeAttribute('aria-busy');
    elements.btnNextSlide.removeAttribute('aria-busy');
    updateBibleLiveIndicator();
    if (showUsesVolunteerControls() && !elements.btnNextSlide.disabled) {
      elements.btnNextSlide.focus({ preventScroll: true });
    }
  }
}

async function goToSlide(slideIndex) {
  if (showEndSessionBlocksAction()) return;
  if (state.bible.isLive) {
    setStatus('Return from the live Bible passage before changing slides');
    return;
  }
  if (slideIndex < 0 || slideIndex >= state.totalSlides) return;
  if (state.cueNavigationBusy) return;

  state.cueNavigationBusy = true;
  elements.btnPrevSlide.setAttribute('aria-busy', 'true');
  elements.btnNextSlide.setAttribute('aria-busy', 'true');
  updateBibleLiveIndicator();
  const action = beginShowOutputAction();
  try {
    const result = await window.api.navigateToSlide(slideIndex);
    applyShowOutputActionResult(action, result);
  } catch (error) {
    console.error('Error changing slides:', error);
    if (action.id === state.showActionRequest) {
      showOutputActionError('Could not change slides', error);
    }
  } finally {
    state.cueNavigationBusy = false;
    elements.btnPrevSlide.removeAttribute('aria-busy');
    elements.btnNextSlide.removeAttribute('aria-busy');
    updateBibleLiveIndicator();
  }
}

function handleSlideChanged({ currentSlide, totalSlides }) {
  state.currentSlide = currentSlide;
  state.totalSlides = totalSlides;

  setPreviewsBlacked(false);
  updateSlideCounter();
  updateThumbnailHighlight();
}

function showUsesVolunteerControls(showState = state.showState) {
  return showState?.operator?.mode === 'volunteer';
}

function volunteerControlsAreLocked(showState = state.showState) {
  return showUsesVolunteerControls(showState)
    && showState?.operator?.authority !== 'unlocked';
}

function handleShowRehearsalProgress(progress = {}) {
  if (progress.status === 'rehearsing') {
    const current = Number.isInteger(progress.currentCue)
      ? progress.currentCue
      : 0;
    const total = Number.isInteger(progress.totalCues)
      ? progress.totalCues
      : 0;
    elements.preflightProgress.textContent =
      `REHEARSING ${current} OF ${total}`;
    setStatus(
      `Checking every cue on every output before volunteer handoff: ${current} of ${total}`
    );
  } else if (progress.status === 'ready') {
    elements.preflightProgress.textContent = 'VOLUNTEER READY';
    setStatus(
      progress.reused
        ? 'Exact-show rehearsal receipt verified'
        : 'Every cue was acknowledged by every output'
    );
  }
}

function renderVolunteerShowControls(showState = state.showState) {
  const volunteer = showUsesVolunteerControls(showState);
  const locked = volunteerControlsAreLocked(showState);
  const expiresAt = volunteer && !locked
    ? Date.parse(showState?.operator?.unlockExpiresAt || '')
    : Number.NaN;
  const remainingSeconds = Number.isFinite(expiresAt)
    ? Math.max(0, Math.ceil((expiresAt - Date.now()) / 1000))
    : 0;

  document.body.classList.toggle('volunteer-show-locked', locked);
  elements.volunteerControlBar.hidden = !volunteer;
  elements.btnUnlockVolunteerControls.hidden = !volunteer || !locked;
  elements.btnLockVolunteerControls.hidden = !volunteer || locked;
  elements.btnUnlockVolunteerControls.disabled = state.volunteerControlBusy;
  elements.btnLockVolunteerControls.disabled = state.volunteerControlBusy;
  elements.btnOpenBible.closest('.live-tools-box')?.classList.toggle(
    'volunteer-cleanup-visible',
    locked && state.bible.isLive
  );

  if (volunteer) {
    const rehearsal = showState?.operator?.rehearsal || {};
    const readinessDetail = rehearsal.status === 'ready'
      ? rehearsal.persisted
        ? rehearsal.reused
          ? ' Exact-show rehearsal receipt verified.'
          : ' Every cue passed and the exact-show receipt was saved.'
        : ' Every cue passed for this output session.'
      : rehearsal.status === 'rehearsing'
        ? ` Rehearsing cue ${rehearsal.currentCue || 0} of ${rehearsal.totalCues || 0}.`
        : '';
    elements.volunteerControlTitle.textContent = locked
      ? 'Volunteer controls locked'
      : 'Operator controls temporarily unlocked';
    elements.volunteerControlDetail.textContent = locked
      ? `Advance with Right arrow or Space. Clear stays available for emergencies.${readinessDetail}`
      : `Full live controls are available${remainingSeconds > 0
        ? ` for about ${remainingSeconds} seconds`
        : ''}. Relock before handing the computer back.${readinessDetail}`;
  }

  if (locked) {
    if (elements.bibleDialog.open && !state.bible.isLive) closeBibleDialog();
    if (elements.remoteDialog.open) closeRemoteDialog();
  }

  const canJump = (
    showState?.operator?.controls
    || showState?.controls
  )?.canJump === true;
  for (const thumbnail of elements.thumbnailsGrid.querySelectorAll('.thumbnail-item')) {
    thumbnail.disabled = !canJump;
  }
  const hints = document.querySelector('.hints-box');
  if (hints) {
    hints.textContent = locked
      ? 'Right arrow or Space advances · Esc clears'
      : '← / → navigate · Space advances · Esc clears';
  }
}

async function unlockVolunteerControls() {
  if (
    state.volunteerControlBusy
    || typeof window.api?.unlockVolunteerControls !== 'function'
  ) return;
  state.volunteerControlBusy = true;
  renderVolunteerShowControls();
  try {
    const result = await window.api.unlockVolunteerControls();
    if (result?.showState) handleShowStateChanged(result.showState);
    if (result?.confirmed === true) {
      setStatus('Operator controls unlocked for this Show. Relock before volunteer handoff.');
    }
  } catch (error) {
    showOutputActionError(
      'Could not unlock operator controls',
      error
    );
  } finally {
    state.volunteerControlBusy = false;
    renderVolunteerShowControls();
  }
}

async function lockVolunteerControls() {
  if (
    state.volunteerControlBusy
    || typeof window.api?.lockVolunteerControls !== 'function'
  ) return;
  state.volunteerControlBusy = true;
  renderVolunteerShowControls();
  try {
    const result = await window.api.lockVolunteerControls();
    if (result?.showState) handleShowStateChanged(result.showState);
    setStatus('Volunteer controls relocked');
  } catch (error) {
    showOutputActionError(
      'Could not relock volunteer controls',
      error
    );
  } finally {
    state.volunteerControlBusy = false;
    renderVolunteerShowControls();
  }
}

function handleShowStateChanged(payload = {}) {
  const next = payload?.state || payload;
  if (!next || next.protocolVersion !== 1 || !Number.isInteger(next.revision)) return false;
  if (state.showState && next.revision < state.showState.revision) return false;

  state.showState = next;
  if (next.currentCue && Number.isInteger(next.currentCue.index)) {
    state.currentSlide = next.currentCue.index;
  }
  if (Number.isInteger(next.totalCues)) state.totalSlides = next.totalCues;

  if (next.phase === 'live' || next.phase === 'cleared') {
    state.isPresenting = true;
  } else if (next.phase === 'hidden' || next.phase === 'idle' || next.phase === 'interrupted') {
    state.isPresenting = false;
  }
  updateWorkflowNavigationAvailability();

  const bible = next.bible || {};
  state.bible.isLive = bible.phase === 'live';
  state.bible.liveOutputIds = state.bible.isLive && Array.isArray(bible.targetOutputIds)
    ? [...bible.targetOutputIds]
    : [];

  updateShowEndSessionBarrier();
  renderVolunteerShowControls(next);
  setPreviewsBlacked(next.phase === 'cleared' || next.phase === 'hidden' || next.phase === 'idle');
  updateSlideCounter();
  updateThumbnailHighlight();
  updateBibleActions();
  renderShowOutputState(next);
  renderRemoteControl();
  return true;
}

function operatorErrorMessage(error, fallback) {
  return window.SyncShowErrorMessages?.humanizeIpcError(error, fallback)
    || (typeof error?.message === 'string' && error.message.trim())
    || fallback;
}

function renderShowOutputState(showState = state.showState) {
  if (!elements.showOutputState) return;
  const phase = String(showState?.phase || 'idle');
  const cueTransitionPending = Array.isArray(showState?.outputs)
    && showState.outputs.some(output => output?.status === 'starting');
  const cueNumber = Number.isInteger(showState?.currentCue?.index)
    ? showState.currentCue.index + 1
    : state.currentSlide + 1;
  const total = Number.isInteger(showState?.totalCues) ? showState.totalCues : state.totalSlides;
  const descriptions = {
    live: {
      title: state.bible.isLive ? 'Bible passage live' : 'Outputs live',
      detail: state.bible.isLive
        ? 'Return to slides to reveal the current service cue.'
        : `Showing slide ${Math.max(1, cueNumber)} of ${Math.max(0, total)}.`
    },
    cleared: {
      title: 'Outputs black',
      detail: 'Clear is active. Show / Restore returns the current slide.'
    },
    hidden: {
      title: 'Outputs stopped',
      detail: 'Output windows are hidden and keyboard control is off.'
    },
    interrupted: {
      title: 'Outputs interrupted',
      detail: 'A display disconnected. Return to Load and confirm its screen assignment.'
    },
    idle: {
      title: 'Outputs idle',
      detail: 'Start Show from Load when the service is ready.'
    }
  };
  const description = cueTransitionPending
    ? {
        title: 'Changing cue…',
        detail: 'Waiting for every routed output to confirm the same rendered cue.'
      }
    : descriptions[phase] || descriptions.idle;
  elements.showOutputState.dataset.phase = descriptions[phase] ? phase : 'idle';
  elements.showOutputState.setAttribute('aria-busy', String(cueTransitionPending));
  elements.showOutputStateTitle.textContent = description.title;
  elements.showOutputStateDetail.textContent = description.detail;
}

function showOutputActionError(action, error) {
  const message = operatorErrorMessage(error, 'SyncShow could not complete that live action.');
  if (elements.showOutputState) {
    elements.showOutputState.dataset.phase = 'error';
    elements.showOutputStateTitle.textContent = action;
    elements.showOutputStateDetail.textContent = message;
  }
  setStatus(`${action}: ${message}`);
}

// Called when Escape is pressed globally (via main process notification)
function handleDisplaysCleared() {
  state.bible.isLive = false;
  state.bible.liveOutputIds = [];
  updateBibleActions();
  setPreviewsBlacked(true);
  renderShowOutputState({
    phase: 'cleared',
    currentCue: { index: state.currentSlide },
    totalCues: state.totalSlides
  });
  setStatus('Displays cleared (black screens)');
}

function handleBibleStateChanged({ isLive = false, passage = null, targetOutputIds = [] } = {}) {
  state.bible.isLive = Boolean(isLive);
  state.bible.liveOutputIds = state.bible.isLive && Array.isArray(targetOutputIds)
    ? [...targetOutputIds]
    : [];
  if (passage) state.bible.passage = passage;
  if (!state.bible.isLive && state.bible.sending) setBibleSending(false);
  updateBibleActions();
  renderVolunteerShowControls();
  if (elements.bibleDialog.open) renderBibleTargets();
}

function handleDisplayInterrupted({ affectedOutputs = [] } = {}) {
  state.isPresenting = false;
  state.activeLaunchPlan = null;
  state.isStarting = false;
  state.requireDisplayReassignment = true;
  state.bible.isLive = false;
  state.bible.liveOutputIds = [];
  if (elements.bibleDialog.open) elements.bibleDialog.close();
  updateBibleLiveIndicator();
  renderRemoteControl();
  setPreviewsBlacked(true);

  setWorkflowStage('load');

  renderProfileEditor();
  renderOutputHealth();
  checkReadyState();
  const affectedNames = affectedOutputs.map(outputId =>
    state.profile?.outputs.find(output => output.id === outputId)?.name || outputId
  );
  const names = affectedNames.length > 0 ? ` (${affectedNames.join(', ')})` : '';
  renderShowOutputState({ phase: 'interrupted' });
  setStatus(`Presentation stopped: an assigned display was disconnected${names}. The saved binding was preserved.`);
}

function renderOutputPreviews(plan = state.activeLaunchPlan) {
  outputPreviewElements.clear();
  elements.outputPreviewList.replaceChildren();
  const outputs = (plan?.outputs || []).filter(output => output.operatorPreview);
  elements.previewBox.hidden = outputs.length === 0;

  for (const output of outputs) {
    const details = createElement('details', 'preview-accordion');
    details.open = state.profile?.operator?.previewOpenOutputIds?.includes(output.id) !== false;
    const summary = createElement('summary', 'preview-accordion-header');
    summary.append(
      document.createTextNode(`${output.name} preview `),
      createElement('span', 'preview-info-icon', 'ⓘ')
    );
    const body = createElement('div', 'mini-preview');
    const imageWrap = createElement('div', 'mini-preview-img');
    const image = document.createElement('img');
    image.alt = `${output.name} output`;
    imageWrap.appendChild(image);
    body.appendChild(imageWrap);
    details.append(summary, body);
    details.addEventListener('toggle', () => {
      syncPreviewSubscriptions();
      persistPreviewOpenPreference(output.id, details.open);
    });
    elements.outputPreviewList.appendChild(details);
    outputPreviewElements.set(output.id, { details, image });
  }
  syncPreviewSubscriptions();
}

function syncPreviewSubscriptions() {
  const outputIds = [...outputPreviewElements.entries()]
    .filter(([, preview]) => preview.details.open)
    .map(([outputId]) => outputId);
  window.api.setPreviewSubscriptions(outputIds);
}

function persistPreviewOpenPreference(outputId, open) {
  queueProfilePreferenceSave(profile => {
    const openIds = new Set(profile.operator.previewOpenOutputIds || []);
    if (open) openIds.add(outputId);
    else openIds.delete(outputId);
    profile.operator.previewOpenOutputIds = profile.outputs
      .map(output => output.id)
      .filter(id => openIds.has(id));
  }, 'preview visibility');
}

function handleOutputPreview({ outputId, outputName, dataUrl, cleared } = {}) {
  const preview = outputPreviewElements.get(outputId);
  if (!preview) return;
  if (cleared) {
    preview.image.removeAttribute('src');
    return;
  }
  if (!preview.details.open || !dataUrl) return;
  preview.image.alt = `${outputName || outputId} output`;
  preview.image.src = dataUrl;
}

function setPreviewsBlacked(blacked) {
  for (const { image } of outputPreviewElements.values()) {
    image.style.visibility = blacked ? 'hidden' : '';
  }
}

function updateSlideCounter() {
  elements.currentSlideNum.textContent = state.currentSlide + 1;
  elements.totalSlides.textContent = state.totalSlides;
  renderShowCueContext();
}

function updateThumbnailHighlight() {
  document.querySelectorAll('.thumbnail-item').forEach(item => {
    const index = Number.parseInt(item.dataset.index, 10);
    window.SyncShowShowAccessibility.setThumbnailCurrentState(
      item,
      index === state.currentSlide
    );
  });
  
  // Scroll active thumbnail into view - scroll earlier when in lower third of viewport
  const activeThumb = document.querySelector('.thumbnail-item.active');
  const grid = elements.thumbnailsGrid;
  
  if (activeThumb && grid) {
    const gridRect = grid.getBoundingClientRect();
    const thumbRect = activeThumb.getBoundingClientRect();
    
    // Scroll down early: when thumbnail enters the bottom 40% of the grid
    const lowerThreshold = gridRect.top + gridRect.height * 0.6;

    // Scroll up only when the thumbnail's top has left the viewport
    if (thumbRect.top > lowerThreshold || thumbRect.top < gridRect.top) {
      const scrollOffset = activeThumb.offsetTop - (grid.offsetHeight / 2) + (activeThumb.offsetHeight / 2);
      grid.scrollTo({
        top: Math.max(0, scrollOffset),
        behavior: 'smooth'
      });
    }
  }
}

// Singer font size
function adjustSingerFontSize(delta) {
  state.singerFontSize = Math.max(12, Math.min(240, state.singerFontSize + delta));
  elements.singerFontSize.value = state.singerFontSize;
  stageProfilePreferencesFromControls();
}

// Singer char limit
function adjustSingerCharLimit(delta) {
  state.singerCharLimit = Math.max(10, Math.min(500, state.singerCharLimit + delta));
  elements.singerCharLimit.value = state.singerCharLimit;
  stageProfilePreferencesFromControls();
}

// Singer text padding
function adjustSingerTextPadding(delta) {
  state.singerTextPadding = Math.max(0, Math.min(80, state.singerTextPadding + delta));
  elements.singerTextPadding.value = state.singerTextPadding;
  stageProfilePreferencesFromControls();
}

// Thumbnail zoom
function adjustThumbnailZoom(delta) {
  state.thumbnailZoom = Math.max(50, Math.min(200, state.thumbnailZoom + delta));
  applyThumbnailZoom();
  updateThumbnailHighlight();
  persistThumbnailZoom();
}

function persistThumbnailZoom() {
  queueProfilePreferenceSave(profile => {
    profile.operator.thumbnailZoomPercent = state.thumbnailZoom;
  }, 'thumbnail size');
}

function applyThumbnailZoom() {
  const zoom = state.thumbnailZoom / 100;
  const imgHeight = Math.round(150 * zoom);
  const itemMinHeight = Math.round(175 * zoom);
  const minWidth = Math.round(250 * zoom);

  elements.zoomLevel.textContent = `${state.thumbnailZoom}%`;
  elements.thumbnailsGrid.style.gridTemplateColumns = `repeat(auto-fill, minmax(${minWidth}px, 1fr))`;

  // Update existing DOM elements in-place instead of rebuilding innerHTML
  const grid = elements.thumbnailsGrid;
  for (const item of grid.querySelectorAll('.thumbnail-item')) {
    item.style.minHeight = `${itemMinHeight}px`;
  }
  for (const container of grid.querySelectorAll('.thumb-images')) {
    container.style.height = `${imgHeight}px`;
    container.style.minHeight = `${imgHeight}px`;
  }
  for (const div of grid.querySelectorAll('.thumb-images > div')) {
    div.style.height = `${imgHeight}px`;
    div.style.minHeight = `${imgHeight}px`;
  }
  for (const img of grid.querySelectorAll('.thumb-images img')) {
    img.style.maxHeight = `${imgHeight}px`;
  }
}

function createThumbnailImage(language, thumbnail, slideNumber, imgHeight) {
  const wrapper = document.createElement('div');
  Object.assign(wrapper.style, {
    flex: '1',
    height: `${imgHeight}px`,
    minHeight: `${imgHeight}px`,
    background: thumbnail ? '#000' : '#0a0a15',
    overflow: 'hidden',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    color: '#444'
  });

  if (!thumbnail) {
    wrapper.textContent = language;
    return wrapper;
  }

  const image = document.createElement('img');
  image.src = thumbnail;
  image.loading = 'lazy';
  image.decoding = 'async';
  image.alt = `${language} ${slideNumber}`;
  Object.assign(image.style, {
    maxWidth: '100%',
    maxHeight: `${imgHeight}px`,
    objectFit: 'contain',
    display: 'block'
  });
  wrapper.appendChild(image);
  return wrapper;
}

function getThumbnailSelection() {
  const roleOrder = getDeckRoles().map(role => role.id);
  const slidesByRole = Object.fromEntries(roleOrder.map(role => [
    role,
    state.presentations[role]?.slides || []
  ]));
  const routedRoles = state.activeLaunchPlan
    ? new Set(state.activeLaunchPlan.outputs.map(output => output.sourceRoleId))
    : null;
  const availableRoles = roleOrder.filter(role =>
    slidesByRole[role].length > 0 && (!routedRoles || routedRoles.has(role))
  );
  let selection = state.thumbnailSelection;
  if (selection === 'all' && availableRoles.length < 2) {
    selection = availableRoles.includes(state.activeLaunchPlan?.timelineRoleId)
      ? state.activeLaunchPlan.timelineRoleId
      : availableRoles[0];
  } else if (selection !== 'all' && !availableRoles.includes(selection)) {
    selection = availableRoles.length > 1
      ? 'all'
      : (availableRoles.includes(state.activeLaunchPlan?.timelineRoleId)
        ? state.activeLaunchPlan.timelineRoleId
        : availableRoles[0]);
  }
  state.thumbnailSelection = selection || 'all';
  renderThumbnailRoleSelector(availableRoles);

  const selectedRoles = state.thumbnailSelection === 'all'
    ? availableRoles
    : (availableRoles.includes(state.thumbnailSelection) ? [state.thumbnailSelection] : []);
  return { slidesByRole, selectedRoles };
}

function renderThumbnailRoleSelector(availableRoles) {
  const buttons = [];
  if (availableRoles.length > 1) {
    const all = createElement('button', `lang-btn${state.thumbnailSelection === 'all' ? ' active' : ''}`, 'Together');
    all.type = 'button';
    all.dataset.roleSelection = 'all';
    all.setAttribute('aria-label', 'Show all slide thumbnails together');
    all.setAttribute('aria-pressed', state.thumbnailSelection === 'all' ? 'true' : 'false');
    all.setAttribute('aria-controls', 'thumbnailsGrid');
    buttons.push(all);
  }
  for (const roleId of availableRoles) {
    const roleLabel = getRoleLabel(roleId);
    const button = createElement(
      'button',
      `lang-btn${state.thumbnailSelection === roleId ? ' active' : ''}`,
      roleInitials(roleLabel)
    );
    button.type = 'button';
    button.dataset.roleSelection = roleId;
    button.title = `${roleLabel} thumbnails`;
    button.setAttribute('aria-label', `Show ${roleLabel} thumbnails`);
    button.setAttribute('aria-pressed', state.thumbnailSelection === roleId ? 'true' : 'false');
    button.setAttribute('aria-controls', 'thumbnailsGrid');
    buttons.push(button);
  }
  elements.thumbnailRoleSelector.replaceChildren(...buttons);
}

// Thumbnail Rendering - Using Base64 images
function renderThumbnails() {
  const grid = elements.thumbnailsGrid;
  const { slidesByRole, selectedRoles } = getThumbnailSelection();
  const roleMarks = Object.fromEntries(selectedRoles.map(role => [
    role,
    roleInitials(getRoleLabel(role))
  ]));
  const count = selectedRoles.length > 0
    ? Math.max(...selectedRoles.map(role => slidesByRole[role].length))
    : 0;
  
  if (count === 0) {
    const message = document.createElement('div');
    message.className = 'no-slides-message';
    message.textContent = 'No slides loaded yet.';
    grid.replaceChildren(message);
    return;
  }
  
  // Compute pixel heights from zoom level
  const zoom = state.thumbnailZoom / 100;
  const imgHeight = Math.round(150 * zoom);
  const itemMinHeight = Math.round(175 * zoom);

  const fragment = document.createDocumentFragment();

  for (let i = 0; i < count; i++) {
    const slides = selectedRoles.map(role => ({ role, slide: slidesByRole[role][i] }));
    const text = (slides.find(({ slide }) => slide?.text)?.slide.text || '').substring(0, 80) || '—';
    const isCurrent = i === state.currentSlide;

    const item = document.createElement('button');
    item.type = 'button';
    item.className = 'thumbnail-item';
    item.dataset.index = String(i);
    item.dataset.showTransport = 'true';
    item.disabled = (
      state.showState?.operator?.controls
      || state.showState?.controls
    )?.canJump !== true;
    item.style.minHeight = `${itemMinHeight}px`;
    item.setAttribute(
      'aria-label',
      window.SyncShowShowAccessibility.thumbnailActionLabel(i, text)
    );
    window.SyncShowShowAccessibility.setThumbnailCurrentState(item, isCurrent);

    const header = document.createElement('div');
    header.className = 'thumb-header';
    Object.assign(header.style, {
      padding: '6px 10px',
      background: '#252535',
      fontSize: '12px',
      display: 'flex',
      justifyContent: 'space-between'
    });
    const number = document.createElement('span');
    number.className = 'thumb-num';
    number.textContent = String(i + 1);
    const flags = document.createElement('span');
    flags.className = 'thumb-flags';
    flags.textContent = selectedRoles.map(role => roleMarks[role]).join(' | ');
    header.append(number, flags);

    const images = document.createElement('div');
    images.className = `thumb-images${selectedRoles.length === 1 ? ' single-lang' : ''}`;
    Object.assign(images.style, {
      display: 'flex',
      gap: '2px',
      padding: '2px',
      background: '#000',
      height: `${imgHeight}px`,
      minHeight: `${imgHeight}px`
    });
    for (const { role, slide } of slides) {
      images.appendChild(createThumbnailImage(
        roleMarks[role],
        slide?.thumbnailBase64 || '',
        i + 1,
        imgHeight
      ));
    }

    const label = document.createElement('div');
    label.className = 'thumb-text';
    Object.assign(label.style, {
      padding: '6px 10px',
      fontSize: '11px',
      color: '#888',
      whiteSpace: 'nowrap',
      overflow: 'hidden',
      textOverflow: 'ellipsis'
    });
    label.textContent = text;

    item.append(header, images, label);
    item.addEventListener('click', () => {
      goToSlide(i);
    });
    fragment.appendChild(item);
  }

  grid.replaceChildren(fragment);
}

// Keyboard Handling
function handleKeyboard(event) {
  // Dialogs and editable controls own their keys. In particular, Escape must
  // close the Bible/preflight palette without also blacking every output.
  if (!state.isPresenting) return;
  if (!window.SyncShowShowAccessibility.shouldHandleGlobalShowShortcut(event, {
    dialogOpen: Boolean(document.querySelector('dialog[open]'))
  })) return;
  const volunteerLocked = volunteerControlsAreLocked();

  if (
    (event.key === 'ArrowRight' || event.key === ' ')
    && (state.cueNavigationBusy || (volunteerLocked && event.repeat === true))
  ) {
    event.preventDefault();
    return;
  }
  
  switch (event.key) {
    case 'ArrowRight':
      event.preventDefault();
      navigateSlide(1, 'right');
      break;
    case ' ':
      event.preventDefault();
      navigateSlide(1, 'space');
      break;
    case 'ArrowLeft':
      event.preventDefault();
      if (volunteerLocked) break;
      navigateSlide(-1);
      break;
    case 'Home':
      event.preventDefault();
      if (volunteerLocked) break;
      goToSlide(0);
      break;
    case 'End':
      event.preventDefault();
      if (volunteerLocked) break;
      goToSlide(state.totalSlides - 1);
      break;
    case 'Escape':
      event.preventDefault();
      clearDisplays();
      break;
  }
}

// Utility Functions
function setStatus(message) {
  elements.statusMessage.textContent = message;
  console.log('[Status]', message);
}

// Initialize when DOM is ready
document.addEventListener('DOMContentLoaded', init);
