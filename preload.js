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

function postServiceLinkSlotIntent(value) {
  if (value === undefined || value === null) return null;
  return {
    kind: value?.kind,
    status: value?.status,
    url: value?.url
  };
}

const SERMON_BODY_REVIEW_TEXT_MAX_BYTES = 1024 * 1024;
const SERMON_CUE_TEXT_MAX_CHARACTERS = 20_000;
const SERMON_CUE_TEXT_MAX_BYTES = SERMON_CUE_TEXT_MAX_CHARACTERS * 3;

function boundedUtf8Text(value, maximumBytes) {
  if (typeof value !== 'string' || value.length > maximumBytes) return null;
  try {
    return new TextEncoder().encode(value).byteLength <= maximumBytes
      ? value
      : null;
  } catch (_error) {
    return null;
  }
}

function boundedSermonCueText(value) {
  if (
    typeof value !== 'string'
    || value.length > SERMON_CUE_TEXT_MAX_CHARACTERS
  ) {
    return null;
  }
  return boundedUtf8Text(value, SERMON_CUE_TEXT_MAX_BYTES);
}

function sermonBodyReviewEntryIntent(value) {
  return {
    id: value?.id,
    kind: boundedUtf8Text(value?.kind, 24),
    language: boundedUtf8Text(value?.language, 35),
    text: boundedUtf8Text(
      value?.text,
      SERMON_BODY_REVIEW_TEXT_MAX_BYTES
    )
  };
}

function sermonReferenceReviewIntents(value) {
  if (!Array.isArray(value)) return value;
  return value.slice(0, 512).map(reference => ({
    referenceId: reference?.referenceId ?? null,
    replacementQuery: boundedUtf8Text(reference?.replacementQuery, 640),
    selectedBook: reference?.selectedBook ?? null,
    role: reference?.role,
    confirmed: typeof reference?.confirmed === 'boolean'
      ? reference.confirmed
      : null,
    sectionId: reference?.sectionId ?? null
  }));
}

function serviceReadinessWaiversIntent(value) {
  if (!Array.isArray(value)) return value;
  return value.slice(0, 5).map(waiver => ({
    checkId: waiver?.checkId,
    reason: typeof waiver?.reason === 'string' && waiver.reason.length <= 500
      ? boundedUtf8Text(waiver.reason, 2000)
      : null
  }));
}

function serviceServingIntent(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  return {
    schemaVersion: value?.schemaVersion,
    assignments: Array.isArray(value?.assignments)
      ? value.assignments.slice(0, 250).map(assignment => ({
          id: assignment?.id,
          role: assignment?.role,
          personName: assignment?.personName,
          scope: {
            kind: assignment?.scope?.kind,
            itemId: assignment?.scope?.itemId
          },
          status: assignment?.status,
          required: assignment?.required,
          callTime: assignment?.callTime,
          note: assignment?.note
        }))
      : value?.assignments
  };
}

function bibleOutputIntents(value) {
  if (!Array.isArray(value)) return value;
  return value.slice(0, 32).map(output =>
    output?.mode === 'translation'
      ? {
          channelId: output?.channelId,
          mode: output?.mode,
          translationId: output?.translationId
        }
      : {
          channelId: output?.channelId,
          mode: output?.mode
        });
}

function sermonCueSourceMappingsIntent(value) {
  if (!Array.isArray(value)) return value;
  return value.slice(0, 32).map(mapping => ({
    channelId: mapping?.channelId,
    sourceId: mapping?.sourceId
  }));
}

function sermonCueDecisionsIntent(value) {
  if (!Array.isArray(value)) return value;
  return value.slice(0, 256).map(decision => {
    const unitsByChannel = {};
    if (
      decision?.unitsByChannel
      && typeof decision.unitsByChannel === 'object'
      && !Array.isArray(decision.unitsByChannel)
    ) {
      for (const [channelId, selection] of Object.entries(
        decision.unitsByChannel
      ).slice(0, 32)) {
        unitsByChannel[channelId] = selection === null
          ? null
          : {
              unitId: selection?.unitId,
              text: boundedSermonCueText(selection?.text)
            };
      }
    }
    return {
      rowId: decision?.rowId,
      action: decision?.action,
      targetItemId: decision?.targetItemId ?? null,
      sectionId: decision?.sectionId ?? null,
      unitsByChannel
    };
  });
}

function canonicalSermonBodyChannelMappingsIntent(value) {
  if (!Array.isArray(value)) return value;
  return value.slice(0, 32).map(mapping => ({
    channelId: mapping?.channelId,
    mode: mapping?.mode,
    bodyEntryId: mapping?.bodyEntryId ?? null
  }));
}

function canonicalSermonBodyDecisionsIntent(value) {
  const fail = message => {
    throw new TypeError(`Invalid canonical sermon body decisions: ${message}`);
  };
  const record = (candidate, label) => {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
      fail(`${label} must be an object.`);
    }
    return candidate;
  };
  const exactKeys = (candidate, required, optional, label) => {
    record(candidate, label);
    const allowed = new Set([...required, ...optional]);
    if (Object.keys(candidate).some(key => !allowed.has(key))) {
      fail(`${label} contains unsupported fields.`);
    }
    if (required.some(key =>
      !Object.prototype.hasOwnProperty.call(candidate, key))) {
      fail(`${label} is incomplete.`);
    }
  };
  const channelEntries = (candidate, label) => {
    record(candidate, label);
    const entries = Object.entries(candidate);
    if (entries.length < 1 || entries.length > 32) {
      fail(`${label} must contain between 1 and 32 outputs.`);
    }
    return entries;
  };
  const identifier = (candidate, label) => {
    if (typeof candidate !== 'string' || !candidate.trim()) {
      fail(`${label} must be a non-empty id.`);
    }
    return candidate;
  };

  exactKeys(
    value,
    ['rows', 'skippedParagraphIdsByChannel'],
    [],
    'decision set'
  );
  if (!Array.isArray(value.rows) || value.rows.length > 512) {
    fail('rows must be an array of at most 512 decisions.');
  }
  const rows = value.rows.map((row, rowIndex) => {
    record(row, `row ${rowIndex + 1}`);
    const hasLegacy = Object.prototype.hasOwnProperty.call(
      row,
      'paragraphIdsByChannel'
    );
    const hasTreatments = Object.prototype.hasOwnProperty.call(
      row,
      'treatmentsByChannel'
    );
    if (hasLegacy === hasTreatments) {
      fail(
        `row ${rowIndex + 1} must use exactly one supported output-decision shape.`
      );
    }
    const decisionKey = hasTreatments
      ? 'treatmentsByChannel'
      : 'paragraphIdsByChannel';
    exactKeys(
      row,
      ['rowId', 'action', decisionKey],
      ['targetItemId'],
      `row ${rowIndex + 1}`
    );
    const prepared = {
      rowId: identifier(row.rowId, `row ${rowIndex + 1} id`),
      action: row.action,
      targetItemId: row.targetItemId ?? null
    };
    if (hasLegacy) {
      const paragraphIdsByChannel = Object.create(null);
      for (const [channelId, paragraphId] of channelEntries(
        row.paragraphIdsByChannel,
        `row ${rowIndex + 1} legacy outputs`
      )) {
        identifier(channelId, `row ${rowIndex + 1} output`);
        if (
          paragraphId !== null
          && (typeof paragraphId !== 'string' || !paragraphId.trim())
        ) {
          fail(`row ${rowIndex + 1} has an invalid paragraph id.`);
        }
        paragraphIdsByChannel[channelId] = paragraphId;
      }
      prepared.paragraphIdsByChannel = paragraphIdsByChannel;
      return prepared;
    }

    const treatmentsByChannel = Object.create(null);
    for (const [channelId, treatment] of channelEntries(
      row.treatmentsByChannel,
      `row ${rowIndex + 1} output treatments`
    )) {
      identifier(channelId, `row ${rowIndex + 1} output`);
      record(treatment, `row ${rowIndex + 1} ${channelId} treatment`);
      if (treatment.mode === 'hidden') {
        exactKeys(
          treatment,
          ['mode'],
          [],
          `row ${rowIndex + 1} ${channelId} Hidden treatment`
        );
        treatmentsByChannel[channelId] = { mode: 'hidden' };
      } else if (treatment.mode === 'exact') {
        exactKeys(
          treatment,
          ['mode', 'paragraphId'],
          [],
          `row ${rowIndex + 1} ${channelId} Exact treatment`
        );
        treatmentsByChannel[channelId] = {
          mode: 'exact',
          paragraphId: identifier(
            treatment.paragraphId,
            `row ${rowIndex + 1} ${channelId} paragraph`
          )
        };
      } else if (treatment.mode === 'condensed') {
        exactKeys(
          treatment,
          ['mode', 'paragraphId', 'text'],
          [],
          `row ${rowIndex + 1} ${channelId} Condensed treatment`
        );
        const text = boundedSermonCueText(treatment.text);
        if (text === null || !text.trim()) {
          fail(
            `row ${rowIndex + 1} ${channelId} Condensed text must be non-empty and bounded.`
          );
        }
        treatmentsByChannel[channelId] = {
          mode: 'condensed',
          paragraphId: identifier(
            treatment.paragraphId,
            `row ${rowIndex + 1} ${channelId} source paragraph`
          ),
          text
        };
      } else {
        fail(
          `row ${rowIndex + 1} ${channelId} treatment mode is unsupported.`
        );
      }
    }
    prepared.treatmentsByChannel = treatmentsByChannel;
    return prepared;
  });

  const skippedParagraphIdsByChannel = Object.create(null);
  for (const [channelId, paragraphIds] of channelEntries(
    value.skippedParagraphIdsByChannel,
    'explicit skipped paragraphs'
  )) {
    identifier(channelId, 'Skipped-paragraph output');
    if (!Array.isArray(paragraphIds) || paragraphIds.length > 256) {
      fail(`Skipped paragraphs for ${channelId} must be a bounded array.`);
    }
    skippedParagraphIdsByChannel[channelId] = paragraphIds.map(
      (paragraphId, index) => identifier(
        paragraphId,
        `${channelId} skipped paragraph ${index + 1}`
      )
    );
  }
  return { rows, skippedParagraphIdsByChannel };
}

function reviewedSongRangeChannelMappingsIntent(value) {
  if (!Array.isArray(value)) return value;
  return value.slice(0, 32).map(mapping => ({
    channelId: mapping?.channelId,
    mode: mapping?.mode,
    songId: mapping?.songId ?? null,
    revision: mapping?.revision ?? null,
    fromChannelId: mapping?.fromChannelId ?? null
  }));
}

function communityServicePlanReconciliationDecisionsIntent(value) {
  if (!Array.isArray(value)) return value;
  return value.slice(0, 500).map(decision => ({
    conflictId: decision?.conflictId,
    choice: decision?.choice
  }));
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

  // Heritage Community library integration. Approval credentials and
  // network requests stay in the main process; this bridge exposes only
  // connection summaries, sync results, and narrow song/sermon state.
  getCommunityStatus: () => ipcRenderer.invoke('community:status'),
  openCommunityPlanner: () => ipcRenderer.invoke('community:planner:open'),
  getCommunityPlannerState: () => ipcRenderer.invoke('community:planner:state'),
  layoutCommunityPlanner: (request = {}) => ipcRenderer.invoke('community:planner:layout', {
    visible: request?.visible === true,
    bounds: request?.bounds
  }),
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
  syncCommunitySermons: () => ipcRenderer.invoke('community:sermons:sync'),
  listCommunityServiceDocuments: (request = {}) =>
    ipcRenderer.invoke('community:serviceDocuments:list', {
      cursor: request?.cursor ?? null,
      limit: request?.limit
    }),
  getCommunityServiceDocumentState: (request = {}) =>
    ipcRenderer.invoke('community:serviceDocuments:state', {
      projectId: request?.projectId
    }),
  openCommunityServiceDocument: (request = {}) =>
    ipcRenderer.invoke('community:serviceDocuments:open', {
      syncId: request?.syncId,
      resolution: request?.resolution ?? null
    }),
  saveCommunityServiceDocument: (request = {}) =>
    ipcRenderer.invoke('community:serviceDocuments:save', {
      projectId: request?.projectId,
      expectedRevisionId: request?.expectedRevisionId,
      status: request?.status
    }),
  flushCommunityServiceDocuments: () =>
    ipcRenderer.invoke('community:serviceDocuments:flush', {}),
  listCommunityServicePlans: (request = {}) =>
    ipcRenderer.invoke('community:servicePlans:list', {
      cursor: request?.cursor ?? null,
      limit: request?.limit
    }),
  reviewCommunityServicePlan: (request = {}) =>
    ipcRenderer.invoke('community:servicePlans:review', {
      syncId: request?.syncId
    }),
  checkCommunityServicePlanRevision: (request = {}) =>
    ipcRenderer.invoke('community:servicePlans:checkProjectRevision', {
      projectId: request?.projectId,
      expectedRevisionId: request?.expectedRevisionId
    }),
  prepareCommunityServicePlan: (request = {}) =>
    ipcRenderer.invoke('community:servicePlans:prepare', {
      preparationToken: request?.preparationToken,
      confirmed: request?.confirmed === true
    }),
  cancelCommunityServicePlanPreparation: (request = {}) =>
    ipcRenderer.invoke('community:servicePlans:prepareCancel', {
      preparationToken: request?.preparationToken
    }),
  importReviewedCommunityServicePlan: (request = {}) =>
    ipcRenderer.invoke('community:servicePlans:import', {
      reviewToken: request?.reviewToken,
      confirmed: request?.confirmed === true
    }),
  replaceReviewedCommunityServicePlan: (request = {}) =>
    ipcRenderer.invoke('community:servicePlans:replace', {
      replacementToken: request?.replacementToken,
      confirmed: request?.confirmed === true,
      decisions: communityServicePlanReconciliationDecisionsIntent(
        request?.decisions
      )
    }),
  getCommunitySermonState: (request = {}) => ipcRenderer.invoke('community:sermons:getState', {
    sermonId: request?.sermonId
  }),
  openCommunitySermonPublicationManager: (request = {}) =>
    ipcRenderer.invoke('community:sermons:openPublicationManager', {
      sermonId: request?.sermonId,
      expectedLocalRevision: request?.expectedLocalRevision
    }),
  verifyCommunitySermonPublication: (request = {}) =>
    ipcRenderer.invoke('community:sermons:verifyPublication', {
      sermonId: request?.sermonId
    }),
  getCommunitySermonConflict: (request = {}) => ipcRenderer.invoke('community:sermons:getConflict', {
    sermonId: request?.sermonId
  }),
  resolveCommunitySermonConflict: (request = {}) =>
    ipcRenderer.invoke('community:sermons:resolveConflict', {
      sermonId: request?.sermonId,
      strategy: request?.strategy,
      expectedSyncVersion: request?.expectedSyncVersion,
      expectedLocalRevision: request?.expectedLocalRevision
    }),
  pushCommunitySermon: (request = {}) => ipcRenderer.invoke('community:sermons:push', {
    sermonId: request?.sermonId,
    expectedSyncVersion: request?.expectedSyncVersion,
    expectedLocalRevision: request?.expectedLocalRevision
  }),
  getCommunitySongState: (request = {}) => ipcRenderer.invoke('community:songs:getState', {
    songId: request?.songId
  }),
  listCommunitySongPublicLinks: (request = {}) =>
    ipcRenderer.invoke('community:songs:listPublicLinks', {
      songId: request?.songId
    }),
  beginCommunitySongPublicLinkReview: (request = {}) =>
    ipcRenderer.invoke('community:songs:beginPublicLinkReview', {
      songId: request?.songId
    }),
  createCommunitySongPublicLink: (request = {}) =>
    ipcRenderer.invoke('community:songs:createPublicLink', {
      proposalToken: request?.proposalToken,
      label: request?.label,
      basis: request?.basis,
      evidence: request?.evidence,
      validUntil: request?.validUntil,
      expiresAt: request?.expiresAt,
      confirmed: request?.confirmed === true
    }),
  copyCommunitySongPublicLink: (request = {}) =>
    ipcRenderer.invoke('community:songs:copyPublicLink', {
      actionToken: request?.actionToken
    }),
  revokeCommunitySongPublicLink: (request = {}) =>
    ipcRenderer.invoke('community:songs:revokePublicLink', {
      actionToken: request?.actionToken
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
  beginCommunitySongSharingReview: (request = {}) =>
    ipcRenderer.invoke('community:songs:beginSharingReview', {
      songId: request?.songId
    }),
  applyCommunitySongSharingReview: (request = {}) =>
    ipcRenderer.invoke('community:songs:applySharingReview', {
      proposalToken: request?.proposalToken,
      visibility: request?.visibility,
      publishAt: request?.publishAt,
      basis: request?.basis,
      evidence: request?.evidence,
      validUntil: request?.validUntil,
      confirmed: request?.confirmed === true
    }),
  setCommunitySongVisibility: (request = {}) => ipcRenderer.invoke('community:songs:setVisibility', {
    songId: request?.songId,
    visibility: request?.visibility,
    publishAt: request?.publishAt,
    expectedSyncVersion: request?.expectedSyncVersion
  }),

  // Private sermon source maintenance. The renderer receives aggregate counts
  // and an opaque candidate hash only; local paths and object identities stay
  // in the main process. Confirmation schedules a startup re-audit, never a
  // live deletion.
  checkPrivateSermonStorage: () =>
    ipcRenderer.invoke('maintenance:sermonSources:audit'),
  schedulePrivateSermonStorageCleanup: (request = {}) =>
    ipcRenderer.invoke('maintenance:sermonSources:scheduleCleanup', {
      candidateHash: request?.candidateHash,
      confirmed: request?.confirmed === true
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
  nextSlide: (input = 'right') => ipcRenderer.invoke('show:navigateBy', 1, {
    input: input === 'space' ? 'space' : 'right'
  }),
  prevSlide: () => ipcRenderer.invoke('show:navigateBy', -1),
  unlockVolunteerControls: () =>
    ipcRenderer.invoke('show:unlockVolunteerControls'),
  lockVolunteerControls: () =>
    ipcRenderer.invoke('show:lockVolunteerControls'),
  
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
    serviceDate: request?.serviceDate,
    startTime: request?.startTime,
    teamNotes: request?.teamNotes
  }),
  planNextServiceProject: (request = {}) => ipcRenderer.invoke('prepare:projects:planNext', {
    sourceProjectId: request?.sourceProjectId,
    sourceRevisionId: request?.sourceRevisionId,
    title: request?.title,
    serviceDate: request?.serviceDate,
    startTime: request?.startTime,
    teamNotes: request?.teamNotes
  }),
  setServicePlanningStatus: (request = {}) => ipcRenderer.invoke(
    'prepare:projects:setPlanning',
    {
      projectId: request?.projectId,
      expectedRevisionId: request?.expectedRevisionId,
      status: request?.status,
      waivers: serviceReadinessWaiversIntent(request?.waivers)
    }
  ),
  updateServicePlanning: (request = {}) => ipcRenderer.invoke(
    'prepare:projects:updatePlanning',
    {
      projectId: request?.projectId,
      expectedRevisionId: request?.expectedRevisionId,
      startTime: request?.startTime,
      teamNotes: request?.teamNotes,
      waivers: serviceReadinessWaiversIntent(request?.waivers)
    }
  ),
  updateServiceServing: (request = {}) => ipcRenderer.invoke(
    'prepare:projects:updateServing',
    {
      projectId: request?.projectId,
      expectedRevisionId: request?.expectedRevisionId,
      serving: serviceServingIntent(request?.serving)
    }
  ),
  inspectCurrentServiceCompanion: () => ipcRenderer.invoke(
    'prepare:projects:inspectCurrentServiceCompanion',
    {}
  ),
  reviewCurrentServiceNativeDraft: (request = {}) => ipcRenderer.invoke(
    'prepare:projects:reviewCurrentServiceNativeDraft',
    { inspectionToken: request?.inspectionToken }
  ),
  commitCurrentServiceNativeDraft: (request = {}) => ipcRenderer.invoke(
    'prepare:projects:commitCurrentServiceNativeDraft',
    {
      reviewToken: request?.reviewToken,
      confirmed: request?.confirmed === true
    }
  ),
  reviewCurrentServiceSongRangeReplacement: (request = {}) => ipcRenderer.invoke(
    'prepare:projects:reviewCurrentServiceSongRangeReplacement',
    {
      projectId: request?.projectId,
      expectedRevisionId: request?.expectedRevisionId,
      selectedItemId: request?.selectedItemId,
      songId: request?.songId,
      songRevisionId: request?.songRevisionId
    }
  ),
  proposeCurrentServiceSongRangeReplacement: (request = {}) => ipcRenderer.invoke(
    'prepare:projects:proposeCurrentServiceSongRangeReplacement',
    {
      reviewToken: request?.reviewToken,
      channelMappings: reviewedSongRangeChannelMappingsIntent(
        request?.channelMappings
      )
    }
  ),
  previewCurrentServiceSongRangeReplacement: (request = {}) => ipcRenderer.invoke(
    'prepare:projects:previewCurrentServiceSongRangeReplacement',
    {
      proposalToken: request?.proposalToken,
      cueOffset: request?.cueOffset,
      channelId: request?.channelId
    }
  ),
  commitCurrentServiceSongRangeReplacement: (request = {}) => ipcRenderer.invoke(
    'prepare:projects:commitCurrentServiceSongRangeReplacement',
    {
      proposalToken: request?.proposalToken,
      confirmed: request?.confirmed === true
    }
  ),
  inspectPostShowPowerPointService: (request = {}) => ipcRenderer.invoke(
    'prepare:projects:inspectPostShowPowerPointService',
    { receiptToken: request?.receiptToken }
  ),
  openCurrentServiceCompanion: (request = {}) => ipcRenderer.invoke(
    'prepare:projects:openCurrentServiceCompanion',
    { inspectionToken: request?.inspectionToken }
  ),
  proposePlanLinkedPowerPointHandoff: (request = {}) => ipcRenderer.invoke(
    'prepare:projects:proposePlanLinkedPowerPointHandoff',
    {
      projectId: request?.projectId,
      expectedRevisionId: request?.expectedRevisionId,
      itemId: request?.itemId,
      inspectionToken: request?.inspectionToken
    }
  ),
  commitPlanLinkedPowerPointHandoff: (request = {}) => ipcRenderer.invoke(
    'prepare:projects:commitPlanLinkedPowerPointHandoff',
    {
      proposalToken: request?.proposalToken,
      confirmed: request?.confirmed === true
    }
  ),
  inspectCurrentServiceSongSource: (request = {}) => ipcRenderer.invoke(
    'prepare:songs:inspectCurrentServiceSource',
    {
      inspectionToken: request?.inspectionToken,
      roleId: request?.roleId
    }
  ),
  buildCurrentServiceSongDraft: (request = {}) => ipcRenderer.invoke(
    'prepare:songs:buildCurrentServiceDraft',
    {
      proposalToken: request?.proposalToken,
      lane: request?.lane,
      startSlide: request?.startSlide,
      endSlide: request?.endSlide,
      slideLanes: Array.isArray(request?.slideLanes)
        ? request.slideLanes.map(value => String(value || ''))
        : undefined,
      title: request?.title,
      language: request?.language,
      confirmed: request?.confirmed === true
    }
  ),
  beginCurrentServiceSongFamilyReview: (request = {}) => ipcRenderer.invoke(
    'prepare:songs:beginCurrentServiceFamilyReview',
    {
      rootMemberKey: request?.rootMemberKey,
      members: Array.isArray(request?.members)
        ? request.members.map(member => ({
            memberKey: member?.memberKey,
            proposalToken: member?.proposalToken,
            songId: member?.songId,
            title: member?.title,
            language: member?.language,
            lane: member?.lane,
            startSlide: member?.startSlide,
            endSlide: member?.endSlide,
            slideLanes: Array.isArray(member?.slideLanes)
              ? member.slideLanes.map(value => String(value || ''))
              : undefined,
            candidateId: member?.candidateId ?? null
          }))
        : undefined
    }
  ),
  commitCurrentServiceSongFamilyReview: (request = {}) => ipcRenderer.invoke(
    'prepare:songs:commitCurrentServiceFamilyReview',
    {
      reviewToken: request?.reviewToken,
      decisions: Array.isArray(request?.decisions)
        ? request.decisions.map(decision => ({
            occurrenceId: decision?.occurrenceId,
            action: decision?.action,
            repeatOfOccurrenceId: decision?.repeatOfOccurrenceId ?? null,
            note: decision?.note
          }))
        : undefined,
      metadata: Array.isArray(request?.metadata)
        ? request.metadata.map(member => ({
            memberKey: member?.memberKey,
            license: member?.license,
            attribution: member?.attribution,
            tags: Array.isArray(member?.tags)
              ? member.tags.map(value => String(value || ''))
              : undefined,
            authors: Array.isArray(member?.authors)
              ? member.authors.map(value => String(value || ''))
              : undefined,
            translators: Array.isArray(member?.translators)
              ? member.translators.map(value => String(value || ''))
              : undefined,
            composers: Array.isArray(member?.composers)
              ? member.composers.map(value => String(value || ''))
              : undefined,
            localServiceRights: member?.localServiceRights
              ? {
                  basis: member.localServiceRights.basis,
                  evidence: member.localServiceRights.evidence
                }
              : undefined
          }))
        : undefined,
      sourceConfirmed: request?.sourceConfirmed === true,
      rightsConfirmed: request?.rightsConfirmed === true,
      localCommitConfirmed: request?.localCommitConfirmed === true
    }
  ),
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
  listSermonLibrary: (request = {}) => ipcRenderer.invoke('prepare:sermons:list', {
    query: request?.query,
    pageSize: request?.pageSize,
    offset: request?.offset
  }),
  listSermonServiceRelationships: (request = {}) => (
    ipcRenderer.invoke('prepare:sermons:listServices', {
      sermonId: request?.sermonId,
      pageSize: request?.pageSize,
      offset: request?.offset
    })
  ),
  readSermonOutline: (request = {}) => ipcRenderer.invoke('prepare:sermons:outline', {
    sermonId: request?.sermonId,
    sermonRevisionId: request?.sermonRevisionId
  }),
  lookupSermonPrimaryReference: (request = {}) => (
    ipcRenderer.invoke('prepare:sermons:lookupPrimaryReference', {
      query: request?.query,
      selectedBook: request?.selectedBook
    })
  ),
  previewSermonReferenceForServiceItem: (request = {}) => (
    ipcRenderer.invoke('prepare:projects:previewSermonReference', {
      projectId: request?.projectId,
      revisionId: request?.revisionId,
      itemId: request?.itemId,
      sermonId: request?.sermonId,
      sermonRevisionId: request?.sermonRevisionId,
      referenceId: request?.referenceId
    })
  ),
  getSermonAttachmentHealthForServiceItem: (request = {}) => (
    ipcRenderer.invoke('prepare:projects:sermonAttachmentHealth', {
      projectId: request?.projectId,
      revisionId: request?.revisionId,
      itemId: request?.itemId
    })
  ),
  getSermonRecordingHealthForServiceItem: (request = {}) => (
    ipcRenderer.invoke('prepare:projects:sermonRecordingHealth', {
      projectId: request?.projectId,
      revisionId: request?.revisionId,
      itemId: request?.itemId
    })
  ),
  playSermonRecordingForServiceItem: (request = {}) => (
    ipcRenderer.invoke('prepare:projects:playSermonRecording', {
      projectId: request?.projectId,
      expectedRevisionId: request?.expectedRevisionId,
      itemId: request?.itemId
    })
  ),
  stopSermonRecordingPlayback: () => (
    ipcRenderer.invoke('prepare:projects:stopSermonRecordingPlayback')
  ),
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
  replaceSongInService: (request = {}) => ipcRenderer.invoke('prepare:projects:replaceSong', {
    projectId: request?.projectId,
    expectedRevisionId: request?.expectedRevisionId,
    itemId: request?.itemId,
    songId: request?.songId,
    songRevisionId: request?.songRevisionId
  }),
  sourceSermonForServiceItem: (request = {}) => ipcRenderer.invoke('prepare:projects:sourceSermon', {
    projectId: request?.projectId,
    expectedRevisionId: request?.expectedRevisionId,
    itemId: request?.itemId,
    sermonId: request?.sermonId,
    sermonRevisionId: request?.sermonRevisionId,
    sermonSectionId: request?.sermonSectionId
  }),
  saveSermonTextForServiceItem: (request = {}) => (
    ipcRenderer.invoke('prepare:projects:saveSermonText', {
      projectId: request?.projectId,
      expectedRevisionId: request?.expectedRevisionId,
      itemId: request?.itemId,
      sermonId: request?.sermonId,
      expectedSermonRevisionId: request?.expectedSermonRevisionId,
      language: boundedUtf8Text(request?.language, 35),
      manuscript: boundedUtf8Text(
        request?.manuscript,
        SERMON_BODY_REVIEW_TEXT_MAX_BYTES
      ),
      slideNotes: boundedUtf8Text(
        request?.slideNotes,
        SERMON_BODY_REVIEW_TEXT_MAX_BYTES
      ),
      confirmed: request?.confirmed === true
    })
  ),
  attachSermonSourceForServiceItem: (request = {}) => ipcRenderer.invoke('prepare:projects:attachSermonSource', {
    projectId: request?.projectId,
    expectedRevisionId: request?.expectedRevisionId,
    itemId: request?.itemId,
    sermonId: request?.sermonId,
    expectedSermonRevisionId: request?.expectedSermonRevisionId,
    kind: request?.kind,
    languages: Array.isArray(request?.languages)
      ? request.languages.slice(0, 8)
      : request?.languages,
    providedBy: request?.providedBy,
    ...(request?.updateExistingMetadata === true
      ? { updateExistingMetadata: true }
      : {})
  }),
  attachSermonRecordingForServiceItem: (request = {}) => (
    ipcRenderer.invoke('prepare:projects:attachSermonRecording', {
      projectId: request?.projectId,
      expectedRevisionId: request?.expectedRevisionId,
      itemId: request?.itemId,
      sermonId: request?.sermonId,
      expectedSermonRevisionId: request?.expectedSermonRevisionId
    })
  ),
  getCommunitySermonMediaStateForServiceItem: (request = {}) => (
    ipcRenderer.invoke('prepare:communitySermonMedia:getState', {
      projectId: request?.projectId,
      expectedRevisionId: request?.expectedRevisionId,
      itemId: request?.itemId
    })
  ),
  enableCommunitySermonMediaForServiceItem: (request = {}) => (
    ipcRenderer.invoke('prepare:communitySermonMedia:enable', {
      projectId: request?.projectId,
      expectedRevisionId: request?.expectedRevisionId,
      itemId: request?.itemId
    })
  ),
  uploadCommunitySermonMediaForServiceItem: (request = {}) => (
    ipcRenderer.invoke('prepare:communitySermonMedia:start', {
      projectId: request?.projectId,
      expectedRevisionId: request?.expectedRevisionId,
      itemId: request?.itemId
    })
  ),
  resumeCommunitySermonMediaForServiceItem: (request = {}) => (
    ipcRenderer.invoke('prepare:communitySermonMedia:resume', {
      projectId: request?.projectId,
      expectedRevisionId: request?.expectedRevisionId,
      itemId: request?.itemId
    })
  ),
  cancelCommunitySermonMediaForServiceItem: (request = {}) => (
    ipcRenderer.invoke('prepare:communitySermonMedia:cancel', {
      projectId: request?.projectId,
      expectedRevisionId: request?.expectedRevisionId,
      itemId: request?.itemId
    })
  ),
  reviewSermonPostServiceLinksForServiceItem: (request = {}) => (
    ipcRenderer.invoke('prepare:projects:reviewSermonPostServiceLinks', {
      projectId: request?.projectId,
      expectedRevisionId: request?.expectedRevisionId,
      itemId: request?.itemId,
      sermonId: request?.sermonId,
      expectedSermonRevisionId: request?.expectedSermonRevisionId,
      action: request?.action,
      canonicalUrl: request?.canonicalUrl,
      recording: postServiceLinkSlotIntent(request?.recording),
      text: postServiceLinkSlotIntent(request?.text)
    })
  ),
  proposeSermonCueReconciliationForServiceItem: (request = {}) => (
    ipcRenderer.invoke('prepare:projects:proposeSermonCueReconciliation', {
      projectId: request?.projectId,
      expectedRevisionId: request?.expectedRevisionId,
      itemId: request?.itemId,
      sermonId: request?.sermonId,
      sermonRevisionId: request?.sermonRevisionId,
      sourceMappings: sermonCueSourceMappingsIntent(request?.sourceMappings)
    })
  ),
  applySermonCueReconciliationForServiceItem: (request = {}) => (
    ipcRenderer.invoke('prepare:projects:applySermonCueReconciliation', {
      proposalToken: request?.proposalToken,
      projectId: request?.projectId,
      expectedRevisionId: request?.expectedRevisionId,
      itemId: request?.itemId,
      sermonId: request?.sermonId,
      sermonRevisionId: request?.sermonRevisionId,
      decisions: sermonCueDecisionsIntent(request?.decisions),
      placementIndex: request?.placementIndex ?? null,
      confirmed: request?.confirmed === true
    })
  ),
  proposeCanonicalSermonBodyProjectionForServiceItem: (request = {}) => (
    ipcRenderer.invoke('prepare:projects:proposeCanonicalSermonBodyProjection', {
      projectId: request?.projectId,
      expectedRevisionId: request?.expectedRevisionId,
      itemId: request?.itemId,
      sermonId: request?.sermonId,
      sermonRevisionId: request?.sermonRevisionId,
      channelMappings: canonicalSermonBodyChannelMappingsIntent(
        request?.channelMappings
      )
    })
  ),
  applyCanonicalSermonBodyProjectionForServiceItem: (request = {}) => (
    ipcRenderer.invoke('prepare:projects:applyCanonicalSermonBodyProjection', {
      proposalToken: request?.proposalToken,
      projectId: request?.projectId,
      expectedRevisionId: request?.expectedRevisionId,
      itemId: request?.itemId,
      sermonId: request?.sermonId,
      sermonRevisionId: request?.sermonRevisionId,
      decisions: canonicalSermonBodyDecisionsIntent(request?.decisions),
      placementIndex: request?.placementIndex ?? null,
      confirmed: request?.confirmed === true
    })
  ),
  proposeSermonExtractionForServiceItem: (request = {}) => (
    ipcRenderer.invoke('prepare:projects:proposeSermonExtraction', {
      projectId: request?.projectId,
      revisionId: request?.revisionId,
      itemId: request?.itemId,
      sermonId: request?.sermonId,
      sermonRevisionId: request?.sermonRevisionId,
      sourceId: request?.sourceId
    })
  ),
  applySermonExtractionForServiceItem: (request = {}) => (
    ipcRenderer.invoke('prepare:projects:applySermonExtraction', {
      proposalToken: request?.proposalToken,
      projectId: request?.projectId,
      expectedRevisionId: request?.expectedRevisionId,
      itemId: request?.itemId,
      sermonId: request?.sermonId,
      expectedSermonRevisionId: request?.expectedSermonRevisionId,
      outlineSuggestionIds: Array.isArray(request?.outlineSuggestionIds)
        ? request.outlineSuggestionIds.slice(0, 500)
            .map(value => typeof value === 'string' ? value : null)
        : request?.outlineSuggestionIds,
      referenceSuggestionIds: Array.isArray(request?.referenceSuggestionIds)
        ? request.referenceSuggestionIds.slice(0, 500)
            .map(value => typeof value === 'string' ? value : null)
        : request?.referenceSuggestionIds
    })
  ),
  proposeSermonReferenceReviewForServiceItem: (request = {}) => (
    ipcRenderer.invoke('prepare:projects:proposeSermonReferences', {
      projectId: request?.projectId,
      revisionId: request?.revisionId,
      itemId: request?.itemId,
      sermonId: request?.sermonId,
      sermonRevisionId: request?.sermonRevisionId,
      references: sermonReferenceReviewIntents(request?.references)
    })
  ),
  applySermonReferenceReviewForServiceItem: (request = {}) => (
    ipcRenderer.invoke('prepare:projects:applySermonReferences', {
      proposalToken: request?.proposalToken,
      confirmed: request?.confirmed === true
    })
  ),
  proposeSermonBodyForServiceItem: (request = {}) => (
    ipcRenderer.invoke('prepare:projects:proposeSermonBody', {
      projectId: request?.projectId,
      revisionId: request?.revisionId,
      itemId: request?.itemId,
      sermonId: request?.sermonId,
      sermonRevisionId: request?.sermonRevisionId,
      sourceId: request?.sourceId
    })
  ),
  applySermonBodyForServiceItem: (request = {}) => (
    ipcRenderer.invoke('prepare:projects:applySermonBody', {
      proposalToken: request?.proposalToken,
      projectId: request?.projectId,
      expectedRevisionId: request?.expectedRevisionId,
      itemId: request?.itemId,
      sermonId: request?.sermonId,
      expectedSermonRevisionId: request?.expectedSermonRevisionId,
      entry: sermonBodyReviewEntryIntent(request?.entry),
      confirmed: request?.confirmed === true
    })
  ),
  createSermonPacketForServiceItem: (request = {}) => ipcRenderer.invoke('prepare:projects:createSermonPacket', {
    projectId: request?.projectId,
    expectedRevisionId: request?.expectedRevisionId,
    itemId: request?.itemId,
    title: request?.title,
    speakerName: request?.speakerName,
    defaultLanguage: request?.defaultLanguage,
    primaryReference: request?.primaryReference,
    selectedBook: request?.selectedBook,
    ...(typeof request?.addPrimaryReading === 'boolean'
      ? { addPrimaryReading: request.addPrimaryReading }
      : {}),
    ...(Array.isArray(request?.readingOutputs)
      ? { readingOutputs: bibleOutputIntents(request.readingOutputs) }
      : {})
  }),
  proposeServiceSermonPacket: (request = {}) => ipcRenderer.invoke(
    'prepare:projects:proposeServiceSermonPacket',
    {
      projectId: request?.projectId,
      expectedRevisionId: request?.expectedRevisionId,
      itemId: request?.itemId,
      title: request?.title,
      speakerName: request?.speakerName,
      defaultLanguage: request?.defaultLanguage,
      primaryReference: request?.primaryReference,
      selectedBook: request?.selectedBook,
      manuscriptLanguages: request?.manuscriptLanguages,
      readingMode: request?.readingMode,
      ...(Array.isArray(request?.readingOutputs)
        ? { readingOutputs: bibleOutputIntents(request.readingOutputs) }
        : {})
    }
  ),
  commitServiceSermonPacket: (request = {}) => ipcRenderer.invoke(
    'prepare:projects:commitServiceSermonPacket',
    {
      proposalToken: request?.proposalToken,
      confirmed: request?.confirmed
    }
  ),
  proposeLinkedSermonServiceSources: (request = {}) => ipcRenderer.invoke(
    'prepare:projects:proposeLinkedSermonServiceSources',
    {
      projectId: request?.projectId,
      expectedRevisionId: request?.expectedRevisionId,
      itemId: request?.itemId,
      manuscriptLanguages: request?.manuscriptLanguages
    }
  ),
  commitLinkedSermonServiceSources: (request = {}) => ipcRenderer.invoke(
    'prepare:projects:commitLinkedSermonServiceSources',
    {
      proposalToken: request?.proposalToken,
      confirmed: request?.confirmed === true
    }
  ),
  addSermonReadingToService: (request = {}) => ipcRenderer.invoke('prepare:projects:addSermonReading', {
    projectId: request?.projectId,
    expectedRevisionId: request?.expectedRevisionId,
    itemId: request?.itemId,
    referenceId: request?.referenceId,
    outputs: bibleOutputIntents(request?.outputs)
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
    operatorNotes: request?.operatorNotes,
    plannedDurationSeconds: request?.plannedDurationSeconds
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
  setSongOutputTreatment: (request = {}) => ipcRenderer.invoke(
    'prepare:projects:setSongOutputTreatment',
    {
      projectId: request?.projectId,
      expectedRevisionId: request?.expectedRevisionId,
      itemId: request?.itemId,
      channelId: request?.channelId,
      mode: request?.mode,
      ...(request?.mode === 'hidden'
        ? {}
        : { sourceChannelId: request?.sourceChannelId })
    }
  ),
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
    selectedBookId: request?.selectedBookId,
    parentId: request?.parentId,
    outputs: bibleOutputIntents(request?.outputs)
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
  addVideoToService: (request = {}) => ipcRenderer.invoke('prepare:projects:addVideo', {
    projectId: request?.projectId,
    expectedRevisionId: request?.expectedRevisionId,
    title: request?.title,
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

  onShowRehearsalProgress: (callback) => {
    const listener = (event, data) => callback(data);
    ipcRenderer.on('show:rehearsalProgress', listener);
    return () => ipcRenderer.removeListener('show:rehearsalProgress', listener);
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

  onCommunityPlannerState: (callback) => {
    const listener = (_event, data) => callback(data);
    ipcRenderer.on('community:plannerStateChanged', listener);
    return () => ipcRenderer.removeListener(
      'community:plannerStateChanged',
      listener
    );
  },

  onCommunitySermonMediaProgress: (callback) => {
    const listener = (_event, data) => callback(data);
    ipcRenderer.on('community:sermonMedia:progress', listener);
    return () => ipcRenderer.removeListener(
      'community:sermonMedia:progress',
      listener
    );
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

  onNativeCueVideoControl: (callback) => {
    ipcRenderer.on('native-cue:video-control', (event, data) => callback(data));
  },
  
  onDisplayClear: (callback) => {
    ipcRenderer.on('display:clear', (event) => callback());
  },

  onOutputRestoreGuard: (callback) => {
    ipcRenderer.on('output:restoreGuard', (event, data) => callback(data));
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

  reportOutputVideoState: (data) => {
    ipcRenderer.send('output:videoState', data);
  },

  reportOutputRestoreGuardReady: (data) => {
    ipcRenderer.send('output:restoreGuardReady', data);
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
