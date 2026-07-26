const { contextBridge, ipcRenderer } = require('electron');

// Sandboxed Electron preloads expose only a subset of Node built-ins on some
// versions, so `url.pathToFileURL` is not reliably available. Encode paths
// locally while preserving POSIX roots, Windows drive letters, and UNC paths.
function filePathToUrl(filePath) {
  const normalized = filePath.replace(/\\/g, '/');
  const encodePath = value => value
    .split('/')
    .map(segment => encodeURIComponent(segment))
    .join('/');

  if (/^[A-Za-z]:\//.test(normalized)) {
    return `file:///${normalized.slice(0, 2)}${encodePath(normalized.slice(2))}`;
  }
  if (normalized.startsWith('//')) {
    return `file:${encodePath(normalized)}`;
  }
  if (normalized.startsWith('/')) {
    return `file://${encodePath(normalized)}`;
  }
  return `file:///${encodePath(normalized)}`;
}

// Expose protected methods that allow the renderer process to use
// the ipcRenderer without exposing the entire object
contextBridge.exposeInMainWorld('api', {
  // Dialog operations
  openPptxDialog: (language) => ipcRenderer.invoke('dialog:openPptx', language),
  chooseServiceFolder: () => ipcRenderer.invoke('dialog:openServiceFolder'),

  // Google Drive connections are established and used entirely in the main
  // process. The renderer sees only a sanitized folder/account summary and an
  // opaque connection ID that can be saved in the venue profile.
  getDriveStatus: () => ipcRenderer.invoke('drive:status'),
  connectPrivateDrive: () => ipcRenderer.invoke('drive:connectPrivate'),
  getPrivateDriveOAuthState: () => ipcRenderer.invoke('drive:privateOAuthState'),
  copyPrivateDriveOAuthLink: () => ipcRenderer.invoke('drive:copyPrivateOAuthUrl'),
  cancelPrivateDriveOAuth: () => ipcRenderer.invoke('drive:cancelPrivateOAuth'),
  linkPublicDrive: (request = {}) => ipcRenderer.invoke('drive:linkPublic', {
    url: request?.url
  }),
  setDrivePublishingEnabled: (enabled) => ipcRenderer.invoke('drive:setPublishingEnabled', {
    enabled: enabled === true
  }),
  disconnectDrive: (request = {}) => ipcRenderer.invoke('drive:disconnect', {
    connectionId: request?.connectionId
  }),

  // Heritage Community song-library integration. Approval credentials and
  // network requests stay in the main process; this bridge exposes only
  // connection summaries, sync results, and per-song sharing policy.
  getCommunityStatus: () => ipcRenderer.invoke('community:status'),
  startCommunityConnection: (request = {}) => ipcRenderer.invoke('community:connectStart', {
    serverUrl: request?.serverUrl,
    email: request?.email
  }),
  pollCommunityConnection: (request = {}) => ipcRenderer.invoke('community:connectPoll', {
    authorizationId: request?.authorizationId
  }),
  cancelCommunityConnection: (request = {}) => ipcRenderer.invoke('community:connectCancel', {
    authorizationId: request?.authorizationId
  }),
  openCommunityApproval: (request = {}) => ipcRenderer.invoke('community:connectOpenApproval', {
    authorizationId: request?.authorizationId
  }),
  copyCommunityApprovalCode: (request = {}) => ipcRenderer.invoke('community:connectCopyCode', {
    authorizationId: request?.authorizationId
  }),
  disconnectCommunity: () => ipcRenderer.invoke('community:disconnect'),
  syncCommunitySongs: () => ipcRenderer.invoke('community:songs:sync'),
  getCommunitySongState: (request = {}) => ipcRenderer.invoke('community:songs:getState', {
    songId: request?.songId
  }),
  getCommunitySongConflict: (request = {}) => ipcRenderer.invoke('community:songs:getConflict', {
    songId: request?.songId
  }),
  resolveCommunitySongConflict: (request = {}) => ipcRenderer.invoke('community:songs:resolveConflict', {
    songId: request?.songId,
    strategy: request?.strategy,
    expectedSyncVersion: request?.expectedSyncVersion,
    expectedLocalRevision: request?.expectedLocalRevision
  }),
  setCommunitySongVisibility: (request = {}) => ipcRenderer.invoke('community:songs:setVisibility', {
    songId: request?.songId,
    visibility: request?.visibility,
    publishAt: request?.publishAt,
    expectedSyncVersion: request?.expectedSyncVersion
  }),

  // Coherent service-folder discovery and offline snapshots. Folder paths are
  // never accepted here: the main process scans only the committed venue
  // source, whether that is local or an approved Google Drive connection.
  scanServiceFolder: (request = {}) => ipcRenderer.invoke('service-folder:scan', {
    requestedDate: request?.requestedDate
  }),
  pinServiceSet: (request = {}) => ipcRenderer.invoke('service-set:pin', {
    scanToken: request?.scanToken,
    setId: request?.setId
  }),
  getCurrentServiceSet: () => ipcRenderer.invoke('service-set:current'),
  checkServiceSetChanges: () => ipcRenderer.invoke('service-set:checkChanges'),
  
  // PPTX conversion
  convertPptx: (filePath, language, restoreGroupId = null) => ipcRenderer.invoke('pptx:convert', {
    filePath,
    language,
    restoreGroupId
  }),
  
  // Slide operations
  getSlideList: (language) => ipcRenderer.invoke('slides:getList', language),
  navigateToSlide: (slideIndex) => ipcRenderer.invoke('show:navigateTo', slideIndex),
  nextSlide: () => ipcRenderer.invoke('show:navigateBy', 1),
  prevSlide: () => ipcRenderer.invoke('show:navigateBy', -1),
  
  // Display operations
  startPresentation: (displays) => ipcRenderer.invoke('display:start', displays),
  stopPresentation: () => ipcRenderer.invoke('display:stop'),
  endPresentation: () => ipcRenderer.invoke('display:endSession'),
  showDisplays: () => ipcRenderer.invoke('display:show'),
  clearDisplays: () => ipcRenderer.invoke('display:clear'),
  hideDisplays: () => ipcRenderer.invoke('display:hide'),
  refreshDisplays: () => ipcRenderer.invoke('displays:refresh'),
  identifyDisplays: () => ipcRenderer.invoke('displays:identify'),
  setFadeDuration: (duration) => ipcRenderer.invoke('display:setFade', duration),
  setSyncMode: (enabled) => ipcRenderer.invoke('display:setSyncMode', enabled),
  setSingerFontSize: (size) => ipcRenderer.invoke('singer:setFontSize', size),
  setSingerCharLimit: (limit) => ipcRenderer.invoke('singer:setCharLimit', limit),
  setSingerTextPadding: (padding) => ipcRenderer.invoke('singer:setTextPadding', padding),

  // Show-only LAN Remote Control. The renderer receives opaque network IDs;
  // binding addresses and all device authority remain in the main process.
  listRemoteBindings: () => ipcRenderer.invoke('remote:listBindings'),
  getRemoteState: () => ipcRenderer.invoke('remote:getState'),
  enableRemote: (bindingId) => ipcRenderer.invoke('remote:enable', { bindingId }),
  rotateRemotePairing: () => ipcRenderer.invoke('remote:rotatePairing'),
  closeRemotePairing: () => ipcRenderer.invoke('remote:closePairing'),
  revokeRemoteDevices: () => ipcRenderer.invoke('remote:revokeAll'),
  disableRemote: () => ipcRenderer.invoke('remote:disable'),

  // Bible lookup and temporary live overlay
  lookupBiblePassage: (request) => ipcRenderer.invoke('bible:lookup', request),
  showBiblePassage: (request) => ipcRenderer.invoke('bible:show', request),
  hideBiblePassage: () => ipcRenderer.invoke('bible:hide'),

  // Prepare workspace. The renderer receives only validated project/library
  // records; native import paths and storage locations stay in the main process.
  listServiceProjects: (request = {}) => ipcRenderer.invoke('prepare:projects:list', {
    query: request?.query,
    pageSize: request?.pageSize,
    offset: request?.offset
  }),
  createServiceProject: (request = {}) => ipcRenderer.invoke('prepare:projects:create', {
    title: request?.title,
    serviceDate: request?.serviceDate
  }),
  openServiceProject: (request = {}) => ipcRenderer.invoke('prepare:projects:open', {
    projectId: request?.projectId,
    revisionId: request?.revisionId
  }),
  importServiceProject: () => ipcRenderer.invoke('prepare:projects:import'),
  exportServiceProject: (request = {}) => ipcRenderer.invoke('prepare:projects:export', {
    projectId: request?.projectId,
    revisionId: request?.revisionId
  }),
  listServiceProjectHistory: (request = {}) => ipcRenderer.invoke('prepare:projects:history', {
    projectId: request?.projectId,
    limit: request?.limit
  }),
  restoreServiceProjectRevision: (request = {}) => ipcRenderer.invoke('prepare:projects:restoreRevision', {
    projectId: request?.projectId,
    expectedRevisionId: request?.expectedRevisionId,
    targetRevisionId: request?.targetRevisionId
  }),
  listNativePresets: () => ipcRenderer.invoke('prepare:presets:list'),
  previewServiceItem: (request = {}) => ipcRenderer.invoke('prepare:projects:previewItem', {
    projectId: request?.projectId,
    expectedRevisionId: request?.expectedRevisionId,
    itemId: request?.itemId,
    channelId: request?.channelId,
    cueOffset: request?.cueOffset
  }),
  listSongLibrary: (request = {}) => ipcRenderer.invoke('prepare:songs:list', {
    query: request?.query,
    pageSize: request?.pageSize,
    offset: request?.offset
  }),
  readSongDocument: (request = {}) => ipcRenderer.invoke('prepare:songs:read', {
    songId: request?.songId,
    revisionId: request?.revisionId
  }),
  validateSongDocument: (request = {}) => ipcRenderer.invoke('prepare:songs:validate', {
    documentSource: request?.documentSource,
    editingSongId: request?.editingSongId
  }),
  saveSongDocument: (request = {}) => ipcRenderer.invoke('prepare:songs:save', {
    songId: request?.songId,
    expectedRevisionId: request?.expectedRevisionId,
    documentSource: request?.documentSource
  }),
  listSongTranslationsForServiceItem: (request = {}) => ipcRenderer.invoke('prepare:songs:translationsForItem', {
    projectId: request?.projectId,
    expectedRevisionId: request?.expectedRevisionId,
    itemId: request?.itemId
  }),
  importSongDocument: () => ipcRenderer.invoke('prepare:songs:import'),
  addSongToService: (request = {}) => ipcRenderer.invoke('prepare:projects:addSong', {
    projectId: request?.projectId,
    expectedRevisionId: request?.expectedRevisionId,
    songId: request?.songId,
    songRevisionId: request?.songRevisionId,
    arrangement: request?.arrangement,
    parentId: request?.parentId
  }),
  createServiceGroup: (request = {}) => ipcRenderer.invoke('prepare:projects:addGroup', {
    projectId: request?.projectId,
    expectedRevisionId: request?.expectedRevisionId,
    title: request?.title,
    groupKind: request?.groupKind,
    parentId: request?.parentId
  }),
  updateServiceItem: (request = {}) => ipcRenderer.invoke('prepare:projects:updateItem', {
    projectId: request?.projectId,
    expectedRevisionId: request?.expectedRevisionId,
    itemId: request?.itemId,
    title: request?.title,
    groupKind: request?.groupKind,
    textByChannel: Array.isArray(request?.textByChannel)
      ? request.textByChannel.map(entry => ({
          channelId: entry?.channelId,
          text: entry?.text
        }))
      : undefined,
    titlesByChannel: Array.isArray(request?.titlesByChannel)
      ? request.titlesByChannel.map(entry => ({
          channelId: entry?.channelId,
          title: entry?.title
        }))
      : request?.titlesByChannel === null
        ? null
        : undefined,
    spansByChannel: Array.isArray(request?.spansByChannel)
      ? request.spansByChannel.map(entry => ({
          channelId: entry?.channelId,
          spans: Array.isArray(entry?.spans)
            ? entry.spans.map(span => ({
                start: span?.start,
                end: span?.end,
                gold: span?.gold === true
              }))
            : entry?.spans
        }))
      : request?.spansByChannel === null
        ? null
        : request?.spansByChannel === undefined
          ? undefined
          : [],
    presetId: request?.presetId,
    altText: request?.altText,
    fit: request?.fit,
    attribution: request?.attribution,
    operatorNotes: request?.operatorNotes
  }),
  updatePictureOutput: (request = {}) => ipcRenderer.invoke('prepare:projects:updatePictureOutput', {
    projectId: request?.projectId,
    expectedRevisionId: request?.expectedRevisionId,
    itemId: request?.itemId,
    channelId: request?.channelId,
    action: request?.action
  }),
  duplicateServiceItem: (request = {}) => ipcRenderer.invoke('prepare:projects:duplicateItem', {
    projectId: request?.projectId,
    expectedRevisionId: request?.expectedRevisionId,
    itemId: request?.itemId
  }),
  updateSongArrangement: (request = {}) => ipcRenderer.invoke('prepare:projects:updateSongArrangement', {
    projectId: request?.projectId,
    expectedRevisionId: request?.expectedRevisionId,
    itemId: request?.itemId,
    arrangement: request?.arrangement
  }),
  linkSongTranslation: (request = {}) => ipcRenderer.invoke('prepare:projects:linkSongTranslation', {
    projectId: request?.projectId,
    expectedRevisionId: request?.expectedRevisionId,
    itemId: request?.itemId,
    channelId: request?.channelId,
    songId: request?.songId,
    songRevisionId: request?.songRevisionId
  }),
  resetSongTranslation: (request = {}) => ipcRenderer.invoke('prepare:projects:resetSongTranslation', {
    projectId: request?.projectId,
    expectedRevisionId: request?.expectedRevisionId,
    itemId: request?.itemId,
    channelId: request?.channelId
  }),
  addBiblePassageToService: (request = {}) => ipcRenderer.invoke('prepare:projects:addBible', {
    projectId: request?.projectId,
    expectedRevisionId: request?.expectedRevisionId,
    reference: request?.reference,
    translationId: request?.translationId,
    selectedBookId: request?.selectedBookId,
    parentId: request?.parentId
  }),
  addTextToService: (request = {}) => ipcRenderer.invoke('prepare:projects:addText', {
    projectId: request?.projectId,
    expectedRevisionId: request?.expectedRevisionId,
    kind: request?.kind,
    title: request?.title,
    text: request?.text,
    parentId: request?.parentId
  }),
  addPictureToService: (request = {}) => ipcRenderer.invoke('prepare:projects:addPicture', {
    projectId: request?.projectId,
    expectedRevisionId: request?.expectedRevisionId,
    altText: request?.altText,
    attribution: request?.attribution,
    fit: request?.fit,
    parentId: request?.parentId
  }),
  removeServiceItem: (request = {}) => ipcRenderer.invoke('prepare:projects:removeItem', {
    projectId: request?.projectId,
    expectedRevisionId: request?.expectedRevisionId,
    itemId: request?.itemId
  }),
  moveServiceItem: (request = {}) => ipcRenderer.invoke('prepare:projects:moveItem', {
    projectId: request?.projectId,
    expectedRevisionId: request?.expectedRevisionId,
    itemId: request?.itemId,
    targetParentId: request?.targetParentId,
    targetIndex: request?.targetIndex
  }),
  publishServiceProject: (request = {}) => ipcRenderer.invoke('prepare:projects:publish', {
    projectId: request?.projectId,
    revisionId: request?.revisionId
  }),
  
  // App state
  getAppState: () => ipcRenderer.invoke('app:getState'),
  getShowState: () => ipcRenderer.invoke('show:getState'),
  
  // User settings (persisted)
  loadSettings: () => ipcRenderer.invoke('settings:load'),
  saveSettings: (settings) => ipcRenderer.invoke('settings:save', settings),
  getDefaultVenueProfile: () => ipcRenderer.invoke('settings:defaultProfile'),
  setSettingsDraftState: (draftState = {}) => ipcRenderer.send('settings:draftState', {
    dirty: draftState?.dirty === true,
    saving: draftState?.saving === true
  }),
  
  // Cache operations (for restoring previous presentations)
  checkCache: (language) => ipcRenderer.invoke('cache:check', language),
  getCacheRestorePlan: () => ipcRenderer.invoke('cache:restorePlan'),
  loadFromCache: (language, restoreContract = {}) => ipcRenderer.invoke('cache:load', {
    language,
    groupId: restoreContract?.groupId,
    legacy: restoreContract?.legacy === true
  }),
  
  // Event listeners
  onDisplaysUpdated: (callback) => {
    ipcRenderer.on('displays:updated', (event, displays) => callback(displays));
  },
  
  onConversionProgress: (callback) => {
    ipcRenderer.on('conversion:progress', (event, data) => callback(data));
  },
  
  onSlideChanged: (callback) => {
    ipcRenderer.on('slide:changed', (event, data) => callback(data));
  },

  onDisplaysCleared: (callback) => {
    ipcRenderer.on('displays:cleared', (event) => callback());
  },

  onDisplayInterrupted: (callback) => {
    ipcRenderer.on('display:interrupted', (event, data) => callback(data));
  },

  onShowStateChanged: (callback) => {
    const listener = (event, data) => callback(data);
    ipcRenderer.on('show:stateChanged', listener);
    return () => ipcRenderer.removeListener('show:stateChanged', listener);
  },

  onRemoteStateChanged: (callback) => {
    const listener = (event, data) => callback(data);
    ipcRenderer.on('remote:stateChanged', listener);
    return () => ipcRenderer.removeListener('remote:stateChanged', listener);
  },

  onServiceFolderChanged: (callback) => {
    const listener = (event, data) => callback(data);
    ipcRenderer.on('service-folder:changed', listener);
    return () => ipcRenderer.removeListener('service-folder:changed', listener);
  },

  onPrivateDriveOAuthStateChanged: (callback) => {
    const listener = (_event, data) => callback({
      active: data?.active === true,
      revision: Number.isSafeInteger(data?.revision) ? data.revision : 0
    });
    ipcRenderer.on('drive:privateOAuthStateChanged', listener);
    return () => ipcRenderer.removeListener('drive:privateOAuthStateChanged', listener);
  },

  onCommunityStatus: (callback) => {
    const listener = (_event, data) => callback(data);
    ipcRenderer.on('community:statusChanged', listener);
    return () => ipcRenderer.removeListener('community:statusChanged', listener);
  },

  onPreparePublishProgress: (callback) => {
    const listener = (event, data) => callback(data);
    ipcRenderer.on('prepare:publishProgress', listener);
    return () => ipcRenderer.removeListener('prepare:publishProgress', listener);
  },
  
  // Display window specific
  onDisplayInit: (callback) => {
    ipcRenderer.on('display:init', (event, data) => callback(data));
  },
  
  onSlideGoto: (callback) => {
    ipcRenderer.on('slide:goto', (event, data) => callback(data));
  },

  onNativeCueGoto: (callback) => {
    ipcRenderer.on('native-cue:goto', (event, data) => callback(data));
  },
  
  onDisplayClear: (callback) => {
    ipcRenderer.on('display:clear', (event) => callback());
  },

  onFadeUpdate: (callback) => {
    ipcRenderer.on('display:fadeUpdate', (event, duration) => callback(duration));
  },

  onSyncModeUpdate: (callback) => {
    ipcRenderer.on('display:syncModeUpdate', (event, enabled) => callback(enabled));
  },

  reportOutputFrameReady: (data) => {
    ipcRenderer.send('output:frameReady', data);
  },

  // Singer screen specific
  onSingerUpdate: (callback) => {
    ipcRenderer.on('singer:update', (event, data) => callback(data));
  },

  onSingerFontSize: (callback) => {
    ipcRenderer.on('singer:fontSizeUpdate', (event, size) => callback(size));
  },

  onSingerCharLimit: (callback) => {
    ipcRenderer.on('singer:charLimitUpdate', (event, limit) => callback(limit));
  },

  onSingerTextPadding: (callback) => {
    ipcRenderer.on('singer:textPaddingUpdate', (event, padding) => callback(padding));
  },

  onBibleOverlayPrepare: (callback) => {
    ipcRenderer.on('bible:prepare', (event, data) => callback(data));
  },

  onBibleOverlayReveal: (callback) => {
    ipcRenderer.on('bible:reveal', (event, data) => callback(data));
  },

  onBibleOverlayHide: (callback) => {
    ipcRenderer.on('bible:hide', (event, data) => callback(data));
  },

  reportBibleOverlayReady: (data) => {
    ipcRenderer.send('bible:ready', data);
  },

  reportBibleOverlayRevealed: (data) => {
    ipcRenderer.send('bible:revealed', data);
  },

  reportBibleOverlayHidden: (data) => {
    ipcRenderer.send('bible:hidden', data);
  },

  onBibleStateChanged: (callback) => {
    ipcRenderer.on('bible:stateChanged', (event, data) => callback(data));
  },

  onSingerPreview: (callback) => {
    ipcRenderer.on('singer:preview', (event, dataUrl) => callback(dataUrl));
  },

  requestSingerPreview: () => ipcRenderer.send('singer:requestPreview'),

  onOutputPreview: (callback) => {
    ipcRenderer.on('output:preview', (event, data) => callback(data));
  },

  requestOutputPreviews: () => ipcRenderer.send('output:requestPreviews'),

  setPreviewSubscriptions: (outputIds) => {
    ipcRenderer.send('output:setPreviewSubscriptions', Array.isArray(outputIds) ? outputIds : []);
  },
  
  // Remove listeners (for cleanup)
  removeAllListeners: (channel) => {
    ipcRenderer.removeAllListeners(channel);
  }
});

// Expose path utilities for image loading
contextBridge.exposeInMainWorld('pathUtils', {
  // Convert file path to file:// URL for image loading
  toFileUrl: (filePath) => {
    if (typeof filePath !== 'string' || filePath.length === 0) return '';
    return filePathToUrl(filePath);
  }
});
