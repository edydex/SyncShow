'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const sharp = require('sharp');

const {
  MAX_IMAGE_BYTES,
  POWERPOINT_COMPANION_WORKFLOW_MODE,
  ServiceProjectStore,
  addGroupItem,
  addSermonResource,
  attachCommunityServicePlanning,
  bindProjectAsPowerPointCompanion,
  bindProjectToServiceSet,
  buildCurrentServiceNativeDraft,
  createServiceProject,
  isPowerPointCompanionProject,
  nativeDraftProjectId,
  preparedServiceVenueRevisionId,
  resolveSermonSourceLink
} = require('../src/services/project');
const { Converter } = require('../src/services/converter');
const {
  normalizeCacheRestoreContext
} = require('../src/services/show');
const {
  hashFileNoFollow,
  readFileNoFollow,
  statIdentityMatches
} = require('../src/services/project/StorageSafety');
const {
  serviceSetFingerprint
} = require('../src/services/sermon/ServiceSermonPacket');
const {
  bindVerifiedPowerPointServiceSet
} = require('../src/services/show/PowerPointServiceHandoff');
const {
  applyPlanLinkedPowerPointHandoff,
  derivePlanLinkedPowerPointHandoff,
  normalizeServiceSetClaim,
  samePlanLinkedPowerPointHandoff,
  sameServiceSetClaim
} = require('../src/services/show/PlanLinkedPowerPointHandoff');

const root = path.join(__dirname, '..');
const mainSource = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
const preloadSource = fs.readFileSync(path.join(root, 'preload.js'), 'utf8');
const controllerPath = path.join(root, 'src', 'renderer', 'prepare-controller.js');
const controllerSource = fs.readFileSync(controllerPath, 'utf8');
const htmlSource = fs.readFileSync(path.join(root, 'src', 'renderer', 'index.html'), 'utf8');
const NOW = '2026-07-26T16:00:00.000Z';
const REVISION_ID = 'f'.repeat(64);

function plain(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function companionData(envelope) {
  assert.equal(envelope?.success, true);
  assert.ok(envelope.data && typeof envelope.data === 'object');
  return envelope.data;
}

function companionErrorCode(envelope) {
  assert.equal(envelope?.success, false);
  assert.ok(envelope.error && typeof envelope.error === 'object');
  return envelope.error.code;
}

function sourceBetween(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  assert.notEqual(start, -1, `${startMarker} must be implemented`);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.notEqual(end, -1, `${endMarker} must follow ${startMarker}`);
  return source.slice(start, end);
}

function loadPreloadBridge() {
  const calls = [];
  let api = null;
  vm.runInNewContext(preloadSource, {
    require(moduleId) {
      if (moduleId === 'electron') {
        return {
          contextBridge: {
            exposeInMainWorld(name, value) {
              if (name === 'api') api = value;
            }
          },
          ipcRenderer: {
            invoke(channel, payload) {
              calls.push({ channel, payload: plain(payload) });
              return Promise.resolve({ ok: true });
            },
            send() {},
            on() {},
            removeListener() {},
            removeAllListeners() {}
          }
        };
      }
      throw new Error(`Unexpected preload dependency: ${moduleId}`);
    },
    console
  }, { filename: path.join(root, 'preload.js') });
  return { api, calls };
}

function rendererExports() {
  const window = {};
  vm.runInNewContext(controllerSource, { console, window }, { filename: controllerPath });
  return window.SyncShowPrepare;
}

function currentManifest(overrides = {}) {
  return {
    schemaVersion: 1,
    id: '2026-07-26-main',
    name: 'Sunday Service',
    profileId: 'main-sanctuary',
    serviceDate: '2026-07-26',
    createdAt: '2026-07-26T14:00:00.000Z',
    inputs: {
      russian: {
        roleId: 'russian',
        assetId: `sha256:${'b'.repeat(64)}`,
        sourceName: '07-26-2026 Служение RUS.pptx',
        sourcePath: '/private/source/07-26-2026 Служение RUS.pptx',
        pinnedPath: '/private/pinned/russian.pptx',
        size: 1002,
        sha256: 'b'.repeat(64)
      },
      media: {
        roleId: 'media',
        assetId: `sha256:${'c'.repeat(64)}`,
        sourceName: '07-26-2026 Media.pptx',
        sourcePath: '/private/source/07-26-2026 Media.pptx',
        pinnedPath: '/private/pinned/media.pptx',
        size: 1003,
        sha256: 'c'.repeat(64)
      },
      english: {
        roleId: 'english',
        assetId: `sha256:${'a'.repeat(64)}`,
        sourceName: '07-26-2026 Service ENG.pptx',
        sourcePath: '/private/source/07-26-2026 Service ENG.pptx',
        pinnedPath: '/private/pinned/english.pptx',
        size: 1001,
        sha256: 'a'.repeat(64)
      }
    },
    ...overrides
  };
}

function communityPlanSourceRecord({
  revisionId = 'd'.repeat(64),
  planRevision = 'e'.repeat(64)
} = {}) {
  let project = createServiceProject({
    id: 'community-plan-current-service',
    title: 'Sunday Community Plan',
    serviceDate: '2026-07-26',
    profileId: 'main-sanctuary',
    channels: [
      { id: 'primary', label: 'English', language: 'en' },
      { id: 'secondary', label: 'Russian', language: 'ru' }
    ],
    now: NOW
  });
  const sermon = {
    schemaVersion: 2,
    kind: 'syncshow-sermon',
    id: 'sermon-prayer',
    titles: { en: 'The Prayer That Transforms the Church' },
    defaultLanguage: 'en',
    speaker: { id: null, name: 'Pastor Example' },
    serviceDate: '2026-07-26',
    series: null,
    outline: [],
    sources: [],
    references: [],
    media: [],
    publication: {
      status: 'draft',
      visibility: 'private',
      publishedAt: null,
      canonicalUrl: null
    }
  };
  const added = addSermonResource(project, sermon, {
    provider: 'local-sermon-library',
    providerId: 'wotbc-community',
    itemId: sermon.id,
    revision: 'a'.repeat(64)
  });
  project = addGroupItem(added.project, {
    id: 'community-sermon-entry',
    title: 'Sermon',
    groupKind: 'sermon',
    sermonResourceId: added.resourceId,
    now: NOW
  });
  project = attachCommunityServicePlanning(project, {
    serverId: 'wotbc-community',
    planId: 'plan-2026-07-26',
    planRevision,
    importedAt: NOW,
    startTime: '10:30'
  });
  project = bindProjectToServiceSet(project, {
    id: currentManifest().id,
    fingerprint: serviceSetFingerprint(currentManifest()),
    serviceDate: currentManifest().serviceDate,
    profileId: currentManifest().profileId
  });
  return {
    project,
    revisionId,
    unchanged: false,
    recovery: null
  };
}

function hasLocalPath(value) {
  if (typeof value === 'string') {
    return value.includes('/private/')
      || value.includes('/Users/')
      || /^[A-Za-z]:[\\/]/.test(value);
  }
  if (!value || typeof value !== 'object') return false;
  return Object.values(value).some(hasLocalPath);
}

function loadCompanionHandlers({
  manifest = currentManifest(),
  profile = {
    id: 'main-sanctuary',
    name: 'Main Sanctuary',
    inputRoles: [
      { id: 'russian', label: 'Russian' },
      { id: 'english', label: 'English' },
      { id: 'media', label: 'Singers' }
    ]
  },
  initialMatches = [],
  sourceRecords = [],
  projectStore = null,
  nativeRuntime = null
} = {}) {
  const handlers = new Map();
  const events = [];
  let currentManifestValue = manifest;
  let matches = [...initialMatches];
  const sources = new Map(
    sourceRecords.map(record => [record.project.id, record])
  );
  let createCount = 0;
  let saveCount = 0;
  const postShowPowerPointServiceReceipts = new Map();
  const planLinkedPowerPointHandoffs = new Map();

  const failMainOperation = (code, message, details = {}) => {
    const error = new Error(message);
    error.code = code;
    error.details = details;
    throw error;
  };
  const prepareText = (value, _label, maximum, { required = false } = {}) => {
    if (value === undefined || value === null) value = '';
    if (typeof value !== 'string') {
      failMainOperation('INVALID_PREPARE_TEXT', 'Expected text.');
    }
    const normalized = value.trim().normalize('NFC');
    if (required && !normalized) {
      failMainOperation('MISSING_PREPARE_TEXT', 'Required text is missing.');
    }
    if (normalized.length > maximum) {
      failMainOperation('PREPARE_TEXT_TOO_LONG', 'Text is too long.');
    }
    return normalized;
  };
  const prepareId = (value, label) => {
    const id = prepareText(value, label, 128, { required: true });
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(id)) {
      failMainOperation('INVALID_PREPARE_ID', `${label} is invalid.`);
    }
    return id;
  };

  const defaultServiceProjectStore = {
    async findByServiceSetBinding(binding, options) {
      events.push({
        type: 'find',
        binding: plain(binding),
        options: plain(options)
      });
      const filtered = options?.workflowMode
        ? matches.filter(record =>
            record.project.workflowMode === options.workflowMode)
        : matches;
      return Number.isSafeInteger(options?.limit)
        ? filtered.slice(0, options.limit)
        : filtered;
    },
    async create(options, hooks) {
      createCount += 1;
      events.push({
        type: 'create',
        options: plain(options),
        hasPrepareProject: typeof hooks?.prepareProject === 'function'
      });
      const base = createServiceProject({
        ...options,
        now: NOW
      });
      const project = hooks.prepareProject(base);
      const saved = {
        project,
        revisionId: REVISION_ID,
        unchanged: false,
        recovery: null
      };
      matches = [saved];
      return saved;
    },
    async read(projectId) {
      events.push({ type: 'read-project', projectId });
      const source = sources.get(projectId);
      if (source) return source;
      const match = matches.find(record => record.project.id === projectId);
      if (match) return match;
      const error = new Error('missing project');
      error.code = 'PROJECT_NOT_FOUND';
      throw error;
    },
    async save(project, options = {}) {
      saveCount += 1;
      events.push({
        type: 'save',
        projectId: project.id,
        options: {
          expectedRevisionId: options.expectedRevisionId,
          reason: options.reason,
          beforePointerWrite:
            typeof options.beforePointerWrite === 'function',
          rollbackCreatedRevisionOnPointerFailure:
            options.rollbackCreatedRevisionOnPointerFailure === true
        }
      });
      const existing = matches.find(record => record.project.id === project.id)
        || null;
      if ((existing?.revisionId || null)
        !== (options.expectedRevisionId ?? null)) {
        const error = new Error('project changed');
        error.code = 'PROJECT_CONFLICT';
        throw error;
      }
      if (typeof options.beforePointerWrite === 'function') {
        await options.beforePointerWrite();
      }
      const revisionId = crypto.createHash('sha256')
        .update(JSON.stringify(project))
        .digest('hex');
      const saved = {
        project,
        revisionId,
        unchanged: existing
          ? JSON.stringify(existing.project) === JSON.stringify(project)
          : false,
        recovery: null
      };
      matches = [saved];
      return saved;
    }
  };
  const serviceProjectStore = projectStore || defaultServiceProjectStore;
  const services = { serviceProjectStore };
  const companionSource = sourceBetween(
    mainSource,
    'async function verifiedPowerPointServiceSetBinding',
    "ipcMain.handle('prepare:projects:list'"
  );

  vm.runInNewContext(companionSource, {
    POWERPOINT_COMPANION_WORKFLOW_MODE,
    CURRENT_SERVICE_COMPANION_INSPECTION_LIMIT: 12,
    CURRENT_SERVICE_COMPANION_INSPECTION_TTL_MS: 15 * 60 * 1000,
    CURRENT_SERVICE_NATIVE_DRAFT_REVIEW_LIMIT: 4,
    CURRENT_SERVICE_NATIVE_DRAFT_REVIEW_TTL_MS: 15 * 60 * 1000,
    PLAN_LINKED_POWERPOINT_HANDOFF_LIMIT: 12,
    PLAN_LINKED_POWERPOINT_HANDOFF_TTL_MS: 15 * 60 * 1000,
    POST_SHOW_POWERPOINT_RECEIPT_LIMIT: 12,
    POST_SHOW_POWERPOINT_RECEIPT_TTL_MS: 15 * 60 * 1000,
    activeVenueProfile: profile,
    addGroupItem,
    appState: nativeRuntime?.appState || { presentations: {} },
    applyPlanLinkedPowerPointHandoff,
    bindVerifiedPowerPointServiceSet,
    bindProjectAsPowerPointCompanion,
    buildCurrentServiceNativeDraft,
    CONFIG: nativeRuntime?.CONFIG || { cacheDir: '/private/cache' },
    console,
    Converter,
    crypto,
    currentServiceCompanionInspections: new Map(),
    currentServiceNativeDraftReviews: new Map(),
    planLinkedPowerPointHandoffs,
    createServiceProject,
    derivePlanLinkedPowerPointHandoff,
    fs,
    postShowPowerPointServiceReceipts,
    failMainOperation,
    getPrepareServices() {
      return services;
    },
    getServiceSetRoot() {
      return '/private/service-set-root';
    },
    ipcMain: {
      handle(channel, handler) {
        handlers.set(channel, handler);
      }
    },
    isPowerPointCompanionProject,
    MAX_IMAGE_BYTES,
    nativeDraftProjectId,
    normalizeCacheRestoreContext,
    normalizeServiceSetClaim,
    nativeProjectChannels(candidateProfile = profile) {
      const enabled = (candidateProfile?.inputRoles || [])
        .filter(role => role.enabled === true && role.kind === 'deck')
        .map(role => ({
          id: role.id,
          label: role.label,
          language: 'und'
        }));
      return enabled.length > 0
        ? enabled
        : [
            { id: 'primary', label: 'English', language: 'en' },
            { id: 'secondary', label: 'Russian', language: 'ru' },
            { id: 'media', label: 'Singers', language: 'und' }
          ];
    },
    path,
    presentationRevision: nativeRuntime?.presentationRevision || 0,
    prepareId,
    prepareText,
    preparedServiceVenueRevisionId,
    readFileNoFollow,
    async readExpectedProject(request) {
      const current = await serviceProjectStore.read(request.projectId);
      if (current.revisionId !== request.expectedRevisionId) {
        failMainOperation(
          'PROJECT_CONFLICT',
          'This service changed since it was opened.'
        );
      }
      return {
        ...current,
        services,
        projectId: request.projectId,
        expectedRevisionId: request.expectedRevisionId
      };
    },
    projectResult(saved) {
      return {
        project: saved.project,
        revisionId: saved.revisionId,
        unchanged: saved.unchanged === true,
        recovery: saved.recovery || null
      };
    },
    async readCurrentServiceSet(_rootPath, options) {
      events.push({ type: 'read-current', options: plain(options) });
      return currentManifestValue;
    },
    requireControlSender(event) {
      if (event?.trusted !== true) {
        failMainOperation('UNTRUSTED_SENDER', 'The sender is not trusted.');
      }
    },
    requireExactPrepareKeys(request, allowed) {
      const unknown = Object.keys(request).filter(key => !allowed.includes(key));
      if (unknown.length > 0) {
        failMainOperation('INVALID_PREPARE_REQUEST', 'The request contains unsupported fields.');
      }
    },
    requirePrepareRequest(request) {
      if (!request || typeof request !== 'object' || Array.isArray(request)) {
        failMainOperation('INVALID_PREPARE_REQUEST', 'The request must be an object.');
      }
    },
    resolveSermonSourceLink,
    require,
    samePlanLinkedPowerPointHandoff,
    sameServiceSetClaim,
    serviceSetFingerprint,
    sha256Json(value) {
      return crypto.createHash('sha256')
        .update(JSON.stringify(value))
        .digest('hex');
    },
    statIdentityMatches
  }, { filename: 'current-service-companion-handlers.js' });

  return {
    handlers,
    events,
    planLinkedPowerPointHandoffs,
    postShowPowerPointServiceReceipts,
    get createCount() {
      return createCount;
    },
    get saveCount() {
      return saveCount;
    },
    setManifest(nextManifest) {
      currentManifestValue = nextManifest;
    },
    setSource(record) {
      sources.set(record.project.id, record);
    }
  };
}

async function nativeDraftRuntimeFixture(t, manifest, profile) {
  const root = await fs.promises.mkdtemp(
    path.join(os.tmpdir(), 'syncshow-native-draft-main-test-')
  );
  t.after(() => fs.promises.rm(root, { recursive: true, force: true }));
  const cacheRoot = path.join(root, 'cache');
  const appState = { presentations: {} };
  const palette = {
    english: { r: 33, g: 78, b: 120 },
    russian: { r: 117, g: 48, b: 67 },
    media: { r: 61, g: 104, b: 77 }
  };
  for (const role of profile.inputRoles) {
    const input = manifest.inputs[role.id];
    const cacheDir = path.join(cacheRoot, role.id);
    await fs.promises.mkdir(cacheDir, { recursive: true });
    const slides = [];
    for (let index = 1; index <= 2; index += 1) {
      const number = String(index).padStart(3, '0');
      const color = palette[role.id];
      const full = await sharp({
        create: {
          width: 640,
          height: 360,
          channels: 3,
          background: {
            r: Math.min(255, color.r + index),
            g: Math.min(255, color.g + index),
            b: Math.min(255, color.b + index)
          }
        }
      }).jpeg({ quality: 90 }).toBuffer();
      const thumbnail = await sharp(full)
        .resize({ width: 160 })
        .jpeg({ quality: 80 })
        .toBuffer();
      await fs.promises.writeFile(
        path.join(cacheDir, `slide_${number}.jpg`),
        full
      );
      await fs.promises.writeFile(
        path.join(cacheDir, `slide_${number}_thumb.jpg`),
        thumbnail
      );
      slides.push({
        text: `${role.label} ${index}`,
        firstLine: `${role.label} ${index}`
      });
    }
    const metadata = {
      sourceFile: input.sourceName,
      originalFile: input.sourceName,
      slideCount: 2,
      slides,
      restoreContext: {
        schemaVersion: 1,
        groupId: manifest.id,
        sourceKind: 'service-set',
        roleId: role.id,
        serviceSetId: manifest.id,
        assetId: input.assetId
      }
    };
    await fs.promises.writeFile(
      path.join(cacheDir, 'metadata.json'),
      JSON.stringify(metadata)
    );
    appState.presentations[role.id] = {
      renderer: 'jpeg',
      sourceType: 'service-set',
      cacheDir,
      slideCount: 2,
      metadata
    };
  }
  return {
    appState,
    cacheRoot,
    projectStore: new ServiceProjectStore({
      rootPath: path.join(root, 'projects')
    })
  };
}

test('preload exposes a zero-authority inspection and forwards only its opaque open token', async () => {
  const { api, calls } = loadPreloadBridge();

  await api.inspectCurrentServiceCompanion({
    projectId: 'renderer-controlled',
    sourcePath: '/private/service.pptx'
  });
  await api.inspectPostShowPowerPointService({
    receiptToken: 'r'.repeat(32),
    serviceSetId: 'renderer-controlled',
    sourcePath: '/private/service.pptx'
  });
  await api.openCurrentServiceCompanion({
    inspectionToken: 'x'.repeat(32),
    profileId: 'renderer-controlled',
    serviceSetId: 'renderer-controlled'
  });
  await api.reviewCurrentServiceNativeDraft({
    inspectionToken: 'n'.repeat(32),
    sourcePath: '/private/rendered-slide.jpg',
    projectId: 'renderer-controlled'
  });
  await api.commitCurrentServiceNativeDraft({
    reviewToken: 'v'.repeat(32),
    confirmed: true,
    sourcePaths: ['/private/rendered-slide.jpg'],
    title: 'Renderer controlled'
  });
  await api.proposePlanLinkedPowerPointHandoff({
    projectId: 'community-plan-current-service',
    expectedRevisionId: 'd'.repeat(64),
    itemId: 'community-sermon-entry',
    inspectionToken: 'i'.repeat(32),
    sourcePath: '/private/sermon.pdf',
    communityToken: 'secret'
  });
  await api.commitPlanLinkedPowerPointHandoff({
    proposalToken: 'p'.repeat(32),
    confirmed: true,
    publish: true,
    communityToken: 'secret'
  });

  assert.deepEqual(calls, [
    {
      channel: 'prepare:projects:inspectCurrentServiceCompanion',
      payload: {}
    },
    {
      channel: 'prepare:projects:inspectPostShowPowerPointService',
      payload: { receiptToken: 'r'.repeat(32) }
    },
    {
      channel: 'prepare:projects:openCurrentServiceCompanion',
      payload: { inspectionToken: 'x'.repeat(32) }
    },
    {
      channel: 'prepare:projects:reviewCurrentServiceNativeDraft',
      payload: { inspectionToken: 'n'.repeat(32) }
    },
    {
      channel: 'prepare:projects:commitCurrentServiceNativeDraft',
      payload: {
        reviewToken: 'v'.repeat(32),
        confirmed: true
      }
    },
    {
      channel: 'prepare:projects:proposePlanLinkedPowerPointHandoff',
      payload: {
        projectId: 'community-plan-current-service',
        expectedRevisionId: 'd'.repeat(64),
        itemId: 'community-sermon-entry',
        inspectionToken: 'i'.repeat(32)
      }
    },
    {
      channel: 'prepare:projects:commitPlanLinkedPowerPointHandoff',
      payload: {
        proposalToken: 'p'.repeat(32),
        confirmed: true
      }
    }
  ]);
});

test('main review and commit create one runnable path-free native draft and retry idempotently', async t => {
  const manifest = currentManifest();
  const profile = {
    id: 'main-sanctuary',
    name: 'Main Sanctuary',
    inputRoles: [
      {
        id: 'russian',
        label: 'Russian',
        enabled: true,
        kind: 'deck'
      },
      {
        id: 'english',
        label: 'English',
        enabled: true,
        kind: 'deck'
      },
      {
        id: 'media',
        label: 'Singers',
        enabled: true,
        kind: 'deck'
      }
    ]
  };
  const runtime = await nativeDraftRuntimeFixture(t, manifest, profile);
  const harness = loadCompanionHandlers({
    manifest,
    profile,
    projectStore: runtime.projectStore,
    nativeRuntime: {
      appState: runtime.appState,
      CONFIG: { cacheDir: runtime.cacheRoot },
      presentationRevision: 17
    }
  });
  const inspection = companionData(await harness.handlers.get(
    'prepare:projects:inspectCurrentServiceCompanion'
  )({ trusted: true }, {}));
  assert.equal(inspection.nativeDraft.available, true);
  assert.equal(inspection.nativeDraft.exists, false);
  assert.equal(inspection.nativeDraft.positionCount, 2);
  assert.equal(hasLocalPath(inspection), false);

  const reviewed = companionData(await harness.handlers.get(
    'prepare:projects:reviewCurrentServiceNativeDraft'
  )({ trusted: true }, {
    inspectionToken: inspection.inspectionToken
  }));
  assert.equal(reviewed.action, 'create');
  assert.equal(reviewed.positionCount, 2);
  assert.equal(reviewed.sources.every(source =>
    source.slideCount === 2), true);
  assert.equal(hasLocalPath(reviewed), false);

  const committed = companionData(await harness.handlers.get(
    'prepare:projects:commitCurrentServiceNativeDraft'
  )({ trusted: true }, {
    reviewToken: reviewed.reviewToken,
    confirmed: true
  }));
  assert.equal(committed.project.rootItemIds.length, 2);
  assert.equal(committed.project.rootItemIds.every(itemId =>
    committed.project.items[itemId].kind === 'picture'), true);
  assert.deepEqual(
    committed.project.channelIds,
    ['russian', 'english', 'media']
  );
  assert.equal(hasLocalPath(committed), false);
  const saved = await runtime.projectStore.read(committed.project.id);
  assert.equal(saved.revisionId, committed.revisionId);
  assert.equal(saved.recovery, null);

  const retried = companionData(await harness.handlers.get(
    'prepare:projects:commitCurrentServiceNativeDraft'
  )({ trusted: true }, {
    reviewToken: reviewed.reviewToken,
    confirmed: true
  }));
  assert.equal(retried.revisionId, committed.revisionId);
  assert.deepEqual(plain(retried.project), plain(committed.project));
});

test('a competing native-draft publication never adopts an unreviewed winner', async t => {
  const manifest = currentManifest();
  const profile = {
    id: 'main-sanctuary',
    name: 'Main Sanctuary',
    inputRoles: [
      {
        id: 'russian',
        label: 'Russian',
        enabled: true,
        kind: 'deck'
      },
      {
        id: 'english',
        label: 'English',
        enabled: true,
        kind: 'deck'
      },
      {
        id: 'media',
        label: 'Singers',
        enabled: true,
        kind: 'deck'
      }
    ]
  };
  const runtime = await nativeDraftRuntimeFixture(t, manifest, profile);
  runtime.projectStore.createWithExternalImageAssets = async () => {
    const error = new Error('another reviewed draft won');
    error.code = 'PROJECT_CONFLICT';
    throw error;
  };
  const harness = loadCompanionHandlers({
    manifest,
    profile,
    projectStore: runtime.projectStore,
    nativeRuntime: {
      appState: runtime.appState,
      CONFIG: { cacheDir: runtime.cacheRoot },
      presentationRevision: 23
    }
  });
  const inspection = companionData(await harness.handlers.get(
    'prepare:projects:inspectCurrentServiceCompanion'
  )({ trusted: true }, {}));
  const reviewed = companionData(await harness.handlers.get(
    'prepare:projects:reviewCurrentServiceNativeDraft'
  )({ trusted: true }, {
    inspectionToken: inspection.inspectionToken
  }));
  const conflict = await harness.handlers.get(
    'prepare:projects:commitCurrentServiceNativeDraft'
  )({ trusted: true }, {
    reviewToken: reviewed.reviewToken,
    confirmed: true
  });
  assert.equal(
    companionErrorCode(conflict),
    'CURRENT_SERVICE_NATIVE_DRAFT_ALREADY_EXISTS'
  );
  assert.equal(hasLocalPath(conflict), false);
});

test('native-draft review equality preserves both conversion-generation digests', () => {
  const context = {
    result: null,
    sameCurrentServiceCompanionBinding(left, right) {
      return JSON.stringify(left) === JSON.stringify(right);
    }
  };
  vm.runInNewContext(
    sourceBetween(
      mainSource,
      'function sameCurrentServiceNativeDraftReview',
      'async function inspectCurrentServiceNativeDraftImages'
    ),
    context,
    { filename: 'current-service-native-draft-review-equality.js' }
  );
  const review = {
    mode: 'create',
    binding: {
      id: '2026-07-26-main',
      fingerprint: 'a'.repeat(64),
      serviceDate: '2026-07-26',
      profileId: 'main-sanctuary'
    },
    projectId: `pptx-native-draft-${'a'.repeat(48)}`,
    presentationRevision: 42,
    venueRevisionId: 'b'.repeat(64),
    channels: [{
      id: 'english',
      label: 'English',
      language: 'und'
    }],
    positionCount: 3,
    countsMatch: true,
    sources: [{
      roleId: 'english',
      channelId: 'english',
      fileName: 'service.pptx',
      assetId: `sha256:${'c'.repeat(64)}`,
      sha256: 'c'.repeat(64),
      size: 1024,
      slideCount: 3,
      slideMetadataRevisionId: 'd'.repeat(64),
      pdfRendererRevisionId: 'e'.repeat(64)
    }]
  };

  assert.equal(
    context.sameCurrentServiceNativeDraftReview(review, structuredClone(review)),
    true
  );
  const changedSlides = structuredClone(review);
  changedSlides.sources[0].slideMetadataRevisionId = 'f'.repeat(64);
  assert.equal(
    context.sameCurrentServiceNativeDraftReview(review, changedSlides),
    false
  );
  const changedRenderer = structuredClone(review);
  changedRenderer.sources[0].pdfRendererRevisionId = '0'.repeat(64);
  assert.equal(
    context.sameCurrentServiceNativeDraftReview(review, changedRenderer),
    false
  );
  const changedChannels = structuredClone(review);
  changedChannels.channels[0].label = 'English screen';
  assert.equal(
    context.sameCurrentServiceNativeDraftReview(review, changedChannels),
    false
  );

  const existing = {
    mode: 'existing',
    binding: review.binding,
    projectId: review.projectId,
    revisionId: '1'.repeat(64),
    venueRevisionId: review.venueRevisionId
  };
  assert.equal(
    context.sameCurrentServiceNativeDraftReview(
      existing,
      structuredClone(existing)
    ),
    true
  );
  const changedVenue = structuredClone(existing);
  changedVenue.venueRevisionId = '2'.repeat(64);
  assert.equal(
    context.sameCurrentServiceNativeDraftReview(existing, changedVenue),
    false
  );
});

test('main inspection requires a trusted empty request and returns a verified path-free summary', async () => {
  const harness = loadCompanionHandlers();
  const inspect = harness.handlers.get(
    'prepare:projects:inspectCurrentServiceCompanion'
  );

  assert.equal(
    companionErrorCode(await inspect({ trusted: false }, {})),
    'UNTRUSTED_SENDER'
  );
  assert.equal(
    companionErrorCode(await inspect(
      { trusted: true },
      { projectId: 'renderer-controlled' }
    )),
    'INVALID_PREPARE_REQUEST'
  );

  const summary = companionData(await inspect({ trusted: true }, {}));
  assert.match(summary.inspectionToken, /^[A-Za-z0-9_-]{32}$/);
  assert.equal(Number.isFinite(Date.parse(summary.expiresAt)), true);
  const { inspectionToken: _inspectionToken, expiresAt: _expiresAt, ...publicSummary } =
    plain(summary);
  assert.deepEqual(publicSummary, {
    available: true,
    serviceSet: {
      name: 'Sunday Service',
      serviceDate: '2026-07-26',
      profileName: 'Main Sanctuary'
    },
    sources: [
      {
        roleId: 'english',
        roleLabel: 'English',
        fileName: '07-26-2026 Service ENG.pptx'
      },
      {
        roleId: 'media',
        roleLabel: 'Singers',
        fileName: '07-26-2026 Media.pptx'
      },
      {
        roleId: 'russian',
        roleLabel: 'Russian',
        fileName: '07-26-2026 Служение RUS.pptx'
      }
    ],
    exists: false,
    projectId: null,
    nativeDraft: {
      available: false,
      exists: false,
      projectId: null,
      positionCount: null,
      countsMatch: null,
      sources: [],
      reason:
        'Load one synchronized presentation for every enabled venue channel before creating a native draft.'
    }
  });
  assert.equal(hasLocalPath(summary), false);
  assert.deepEqual(
    harness.events.filter(event => event.type === 'read-current'),
    [{ type: 'read-current', options: { verifyAssets: true } }]
  );
});

test('post-show inspection redeems only a live exact receipt and preserves typed failures', async () => {
  const manifest = currentManifest();
  const harness = loadCompanionHandlers({ manifest });
  const inspect = harness.handlers.get(
    'prepare:projects:inspectPostShowPowerPointService'
  );
  const receiptToken = 'r'.repeat(32);
  const binding = {
    id: manifest.id,
    fingerprint: serviceSetFingerprint(manifest),
    serviceDate: manifest.serviceDate,
    profileId: manifest.profileId
  };
  const claim = {
    serviceSetId: manifest.id,
    roleAssets: Object.values(manifest.inputs).map(input => ({
      roleId: input.roleId,
      assetId: input.assetId
    }))
  };
  harness.postShowPowerPointServiceReceipts.set(receiptToken, {
    schemaVersion: 1,
    receiptToken,
    binding,
    claim,
    profileId: manifest.profileId,
    expiresAt: Date.now() + 60_000
  });

  assert.equal(
    companionErrorCode(await inspect(
      { trusted: true },
      { receiptToken, serviceSetId: manifest.id }
    )),
    'INVALID_PREPARE_REQUEST'
  );
  assert.equal(
    companionErrorCode(await inspect(
      { trusted: true },
      { receiptToken: 'renderer-controlled' }
    )),
    'INVALID_POST_SHOW_POWERPOINT_RECEIPT'
  );

  const summary = companionData(await inspect(
    { trusted: true },
    { receiptToken }
  ));
  assert.equal(summary.available, true);
  assert.equal(summary.serviceSet.serviceDate, manifest.serviceDate);
  assert.match(summary.inspectionToken, /^[A-Za-z0-9_-]{32}$/);
  assert.equal(hasLocalPath(summary), false);
  assert.equal(harness.postShowPowerPointServiceReceipts.has(receiptToken), true);

  harness.setManifest(currentManifest({
    id: '2026-08-02-main',
    serviceDate: '2026-08-02'
  }));
  assert.equal(
    companionErrorCode(await inspect(
      { trusted: true },
      { receiptToken }
    )),
    'POST_SHOW_POWERPOINT_SERVICE_CHANGED'
  );
  assert.equal(harness.postShowPowerPointServiceReceipts.has(receiptToken), false);

  const expiredToken = 'e'.repeat(32);
  harness.postShowPowerPointServiceReceipts.set(expiredToken, {
    schemaVersion: 1,
    receiptToken: expiredToken,
    binding,
    claim,
    profileId: manifest.profileId,
    expiresAt: Date.now() - 1
  });
  assert.equal(
    companionErrorCode(await inspect(
      { trusted: true },
      { receiptToken: expiredToken }
    )),
    'EXPIRED_POST_SHOW_POWERPOINT_RECEIPT'
  );
  assert.equal(harness.postShowPowerPointServiceReceipts.has(expiredToken), false);
});

test('opening creates one exact group-only companion atomically and reopening is idempotent', async () => {
  const manifest = currentManifest();
  const harness = loadCompanionHandlers({ manifest });
  const open = harness.handlers.get(
    'prepare:projects:openCurrentServiceCompanion'
  );
  const inspected = companionData(await harness.handlers.get(
    'prepare:projects:inspectCurrentServiceCompanion'
  )({ trusted: true }, {}));

  assert.equal(
    companionErrorCode(await open(
      { trusted: false },
      { inspectionToken: inspected.inspectionToken }
    )),
    'UNTRUSTED_SENDER'
  );
  assert.equal(
    companionErrorCode(await open({ trusted: true }, {
      inspectionToken: inspected.inspectionToken,
      profileId: 'renderer-controlled'
    })),
    'INVALID_PREPARE_REQUEST'
  );
  assert.equal(harness.createCount, 0);

  const first = companionData(await open(
    { trusted: true },
    { inspectionToken: inspected.inspectionToken }
  ));
  assert.equal(harness.createCount, 1);
  assert.equal(first.anchorItemId.startsWith('sermon-'), true);
  assert.equal(first.companion.exists, true);
  assert.equal(first.companion.projectId, first.project.id);
  assert.equal(isPowerPointCompanionProject(first.project), true);
  assert.equal(first.project.workflowMode, POWERPOINT_COMPANION_WORKFLOW_MODE);
  assert.deepEqual(plain(first.project.sourceServiceSet), {
    id: manifest.id,
    fingerprint: serviceSetFingerprint(manifest),
    serviceDate: manifest.serviceDate,
    profileId: manifest.profileId
  });
  assert.deepEqual(plain(first.project.rootItemIds), [first.anchorItemId]);
  assert.equal(Object.keys(first.project.items).length, 1);
  const anchor = first.project.items[first.anchorItemId];
  assert.deepEqual(plain({
    id: anchor.id,
    kind: anchor.kind,
    title: anchor.title,
    groupKind: anchor.groupKind,
    childIds: anchor.childIds,
    operatorNotes: anchor.operatorNotes
  }), {
    id: first.anchorItemId,
    kind: 'group',
    title: 'Sermon',
    groupKind: 'sermon',
    childIds: [],
    operatorNotes: ''
  });
  assert.equal(anchor.sermonResourceId, undefined);
  assert.equal(anchor.sermonSectionId, undefined);
  assert.equal(Number.isFinite(Date.parse(anchor.createdAt)), true);
  assert.equal(anchor.updatedAt, anchor.createdAt);
  assert.deepEqual(plain(first.project.resources), {});
  assert.deepEqual(plain(first.project.assets), {});
  assert.equal(
    harness.events.find(event => event.type === 'create')?.hasPrepareProject,
    true
  );
  assert.deepEqual(
    harness.events.find(event => event.type === 'find'),
    {
      type: 'find',
      binding: {
        id: manifest.id,
        fingerprint: serviceSetFingerprint(manifest),
        serviceDate: manifest.serviceDate,
        profileId: manifest.profileId
      },
      options: {
        limit: 2,
        workflowMode: POWERPOINT_COMPANION_WORKFLOW_MODE
      }
    }
  );

  const second = companionData(await open(
    { trusted: true },
    { inspectionToken: first.companion.inspectionToken }
  ));
  assert.equal(harness.createCount, 1);
  assert.equal(second.project.id, first.project.id);
  assert.equal(second.revisionId, first.revisionId);
  assert.equal(second.anchorItemId, first.anchorItemId);
  assert.equal(second.companion.exists, true);
});

test('reviewed Community sermon links to the exact companion once and reopens idempotently', async () => {
  const sourceRecord = communityPlanSourceRecord();
  const harness = loadCompanionHandlers({
    sourceRecords: [sourceRecord]
  });
  const inspect = harness.handlers.get(
    'prepare:projects:inspectCurrentServiceCompanion'
  );
  const propose = harness.handlers.get(
    'prepare:projects:proposePlanLinkedPowerPointHandoff'
  );
  const commit = harness.handlers.get(
    'prepare:projects:commitPlanLinkedPowerPointHandoff'
  );
  const inspected = companionData(await inspect({ trusted: true }, {}));
  const proposal = companionData(await propose({ trusted: true }, {
    projectId: sourceRecord.project.id,
    expectedRevisionId: sourceRecord.revisionId,
    itemId: 'community-sermon-entry',
    inspectionToken: inspected.inspectionToken
  }));

  assert.match(proposal.proposalToken, /^[A-Za-z0-9_-]{32}$/);
  assert.equal(proposal.action, 'create');
  assert.equal(proposal.sermon.id, 'sermon-prayer');
  assert.equal(proposal.source.planId, 'plan-2026-07-26');
  assert.deepEqual(plain(proposal.roles.map(role => role.roleId)), [
    'english',
    'media',
    'russian'
  ]);
  assert.equal(hasLocalPath(proposal), false);
  assert.equal(
    companionErrorCode(await commit({ trusted: true }, {
      proposalToken: proposal.proposalToken,
      confirmed: false
    })),
    'PLAN_LINKED_POWERPOINT_CONFIRMATION_REQUIRED'
  );

  const linked = companionData(await commit({ trusted: true }, {
    proposalToken: proposal.proposalToken,
    confirmed: true
  }));
  const resolved = resolveSermonSourceLink(
    linked.project,
    linked.project.items[linked.anchorItemId]
  );
  const sourceResolved = resolveSermonSourceLink(
    sourceRecord.project,
    sourceRecord.project.items['community-sermon-entry']
  );
  assert.equal(harness.saveCount, 1);
  assert.equal(linked.sermon.id, sourceResolved.resource.document.id);
  assert.equal(linked.sermon.revisionId, sourceResolved.resource.sha256);
  assert.equal(linked.sermon.resourceId, sourceResolved.resourceId);
  assert.equal(resolved.resourceId, sourceResolved.resourceId);
  assert.equal(resolved.resource.document.id, 'sermon-prayer');
  assert.equal(isPowerPointCompanionProject(linked.project), true);
  assert.equal(hasLocalPath(linked), false);
  assert.deepEqual(
    harness.events.find(event => event.type === 'save')?.options,
    {
      expectedRevisionId: null,
      reason: 'community-plan-pptx-link',
      beforePointerWrite: true,
      rollbackCreatedRevisionOnPointerFailure: true
    }
  );

  assert.equal(
    companionErrorCode(await commit({ trusted: true }, {
      proposalToken: proposal.proposalToken,
      confirmed: true
    })),
    'REPLAYED_PLAN_LINKED_POWERPOINT_HANDOFF'
  );

  const repeatProposal = companionData(await propose({ trusted: true }, {
    projectId: sourceRecord.project.id,
    expectedRevisionId: sourceRecord.revisionId,
    itemId: 'community-sermon-entry',
    inspectionToken: linked.companion.inspectionToken
  }));
  assert.equal(repeatProposal.action, 'already-linked');
  const repeated = companionData(await commit({ trusted: true }, {
    proposalToken: repeatProposal.proposalToken,
    confirmed: true
  }));
  assert.equal(repeated.project.id, linked.project.id);
  assert.equal(repeated.revisionId, linked.revisionId);
  assert.equal(repeated.sermon.id, linked.sermon.id);
  assert.equal(repeated.sermon.revisionId, linked.sermon.revisionId);
  assert.equal(harness.saveCount, 1);
});

test('reviewed Community sermon authority fails closed on source, files, target, expiry, and extra fields', async () => {
  const sourceRecord = communityPlanSourceRecord();
  const makeProposal = async harness => {
    const inspected = companionData(await harness.handlers.get(
      'prepare:projects:inspectCurrentServiceCompanion'
    )({ trusted: true }, {}));
    return {
      inspected,
      proposal: companionData(await harness.handlers.get(
        'prepare:projects:proposePlanLinkedPowerPointHandoff'
      )({ trusted: true }, {
        projectId: sourceRecord.project.id,
        expectedRevisionId: sourceRecord.revisionId,
        itemId: 'community-sermon-entry',
        inspectionToken: inspected.inspectionToken
      }))
    };
  };

  const sourceChanged = loadCompanionHandlers({
    sourceRecords: [sourceRecord]
  });
  const sourceReview = await makeProposal(sourceChanged);
  sourceChanged.setSource({
    ...sourceRecord,
    revisionId: '9'.repeat(64)
  });
  assert.equal(
    companionErrorCode(await sourceChanged.handlers.get(
      'prepare:projects:commitPlanLinkedPowerPointHandoff'
    )({ trusted: true }, {
      proposalToken: sourceReview.proposal.proposalToken,
      confirmed: true
    })),
    'PLAN_LINKED_POWERPOINT_SOURCE_CHANGED'
  );

  const filesChanged = loadCompanionHandlers({
    sourceRecords: [sourceRecord]
  });
  const filesReview = await makeProposal(filesChanged);
  filesChanged.setManifest(currentManifest({
    inputs: {
      ...currentManifest().inputs,
      english: {
        ...currentManifest().inputs.english,
        assetId: `sha256:${'8'.repeat(64)}`,
        sha256: '8'.repeat(64)
      }
    }
  }));
  assert.equal(
    companionErrorCode(await filesChanged.handlers.get(
      'prepare:projects:commitPlanLinkedPowerPointHandoff'
    )({ trusted: true }, {
      proposalToken: filesReview.proposal.proposalToken,
      confirmed: true
    })),
    'PLAN_LINKED_POWERPOINT_SERVICE_CHANGED'
  );

  const targetChanged = loadCompanionHandlers({
    sourceRecords: [sourceRecord]
  });
  const targetReview = await makeProposal(targetChanged);
  companionData(await targetChanged.handlers.get(
    'prepare:projects:openCurrentServiceCompanion'
  )({ trusted: true }, {
    inspectionToken: targetReview.inspected.inspectionToken
  }));
  assert.equal(
    companionErrorCode(await targetChanged.handlers.get(
      'prepare:projects:commitPlanLinkedPowerPointHandoff'
    )({ trusted: true }, {
      proposalToken: targetReview.proposal.proposalToken,
      confirmed: true
    })),
    'PLAN_LINKED_POWERPOINT_COMPANION_CHANGED'
  );

  const expired = loadCompanionHandlers({
    sourceRecords: [sourceRecord]
  });
  const expiredReview = await makeProposal(expired);
  expired.planLinkedPowerPointHandoffs.get(
    expiredReview.proposal.proposalToken
  ).expiresAt = Date.now() - 1;
  assert.equal(
    companionErrorCode(await expired.handlers.get(
      'prepare:projects:commitPlanLinkedPowerPointHandoff'
    )({ trusted: true }, {
      proposalToken: expiredReview.proposal.proposalToken,
      confirmed: true
    })),
    'EXPIRED_PLAN_LINKED_POWERPOINT_HANDOFF'
  );
  assert.equal(
    companionErrorCode(await expired.handlers.get(
      'prepare:projects:commitPlanLinkedPowerPointHandoff'
    )({ trusted: true }, {
      proposalToken: 'x'.repeat(32),
      confirmed: true,
      publish: true
    })),
    'INVALID_PREPARE_REQUEST'
  );
});

test('companion handlers reject duplicates, recovered records, profile mismatch, and a missing current set', async () => {
  const duplicateProject = bindProjectAsPowerPointCompanion(
    addGroupItem(createServiceProject({
      id: 'duplicate-companion',
      title: 'Duplicate',
      serviceDate: '2026-07-26',
      profileId: 'main-sanctuary',
      now: NOW
    }), {
      id: 'sermon-anchor',
      title: 'Sermon',
      groupKind: 'sermon',
      now: NOW
    }),
    {
      id: '2026-07-26-main',
      fingerprint: serviceSetFingerprint(currentManifest()),
      serviceDate: '2026-07-26',
      profileId: 'main-sanctuary'
    }
  );
  const duplicateRecord = {
    project: duplicateProject,
    revisionId: REVISION_ID,
    unchanged: false,
    recovery: null
  };
  const duplicates = loadCompanionHandlers({
    initialMatches: [
      duplicateRecord,
      {
        ...duplicateRecord,
        project: {
          ...duplicateProject,
          id: 'duplicate-companion-2'
        }
      }
    ]
  });
  assert.equal(
    companionErrorCode(await duplicates.handlers.get(
      'prepare:projects:inspectCurrentServiceCompanion'
    )({ trusted: true }, {})),
    'DUPLICATE_CURRENT_SERVICE_COMPANIONS'
  );

  const recovered = loadCompanionHandlers({
    initialMatches: [{
      ...duplicateRecord,
      recovery: {
        source: 'revision-scan',
        message: 'Recovered newest revision.'
      }
    }]
  });
  assert.equal(
    companionErrorCode(await recovered.handlers.get(
      'prepare:projects:inspectCurrentServiceCompanion'
    )({ trusted: true }, {})),
    'CURRENT_SERVICE_COMPANION_RECOVERY_REQUIRED'
  );

  const binding = {
    id: '2026-07-26-main',
    fingerprint: serviceSetFingerprint(currentManifest()),
    serviceDate: '2026-07-26',
    profileId: 'main-sanctuary'
  };
  const ordinaryBoundProject = bindProjectToServiceSet(
    createServiceProject({
      id: 'ordinary-community-plan',
      title: 'Ordinary Community plan',
      serviceDate: binding.serviceDate,
      profileId: binding.profileId,
      now: NOW
    }),
    binding
  );
  const ordinaryBound = loadCompanionHandlers({
    initialMatches: [{
      project: ordinaryBoundProject,
      revisionId: REVISION_ID,
      unchanged: false,
      recovery: null
    }]
  });
  const ordinarySummary = companionData(await ordinaryBound.handlers.get(
    'prepare:projects:inspectCurrentServiceCompanion'
  )({ trusted: true }, {}));
  assert.equal(ordinarySummary.nativeDraft.exists, false);

  const deterministicId = nativeDraftProjectId(binding.fingerprint);
  const recoveredNative = loadCompanionHandlers({
    initialMatches: [{
      project: bindProjectToServiceSet(
        createServiceProject({
          id: deterministicId,
          title: 'Recovered native draft',
          serviceDate: binding.serviceDate,
          profileId: binding.profileId,
          now: NOW
        }),
        binding
      ),
      revisionId: REVISION_ID,
      unchanged: false,
      recovery: {
        source: 'revision-scan',
        message: 'Recovered newest revision.'
      }
    }]
  });
  assert.equal(
    companionErrorCode(await recoveredNative.handlers.get(
      'prepare:projects:inspectCurrentServiceCompanion'
    )({ trusted: true }, {})),
    'CURRENT_SERVICE_NATIVE_DRAFT_RECOVERY_REQUIRED'
  );

  const conflictingNative = loadCompanionHandlers({
    initialMatches: [{
      project: bindProjectToServiceSet(
        createServiceProject({
          id: deterministicId,
          title: 'Conflicting reserved identity',
          serviceDate: binding.serviceDate,
          profileId: binding.profileId,
          now: NOW
        }),
        {
          ...binding,
          fingerprint: '9'.repeat(64)
        }
      ),
      revisionId: REVISION_ID,
      unchanged: false,
      recovery: null
    }]
  });
  assert.equal(
    companionErrorCode(await conflictingNative.handlers.get(
      'prepare:projects:inspectCurrentServiceCompanion'
    )({ trusted: true }, {})),
    'CURRENT_SERVICE_NATIVE_DRAFT_ID_CONFLICT'
  );

  const currentVenueProfile = {
    id: 'main-sanctuary',
    name: 'Main Sanctuary',
    inputRoles: [
      {
        id: 'russian',
        label: 'Russian',
        enabled: true,
        kind: 'deck'
      },
      {
        id: 'english',
        label: 'English',
        enabled: true,
        kind: 'deck'
      },
      {
        id: 'media',
        label: 'Singers',
        enabled: true,
        kind: 'deck'
      }
    ]
  };
  const earlierVenueDraft = loadCompanionHandlers({
    profile: currentVenueProfile,
    initialMatches: [{
      project: bindProjectToServiceSet(
        createServiceProject({
          id: deterministicId,
          title: 'Earlier venue native draft',
          serviceDate: binding.serviceDate,
          profileId: binding.profileId,
          channels: [
            { id: 'russian', label: 'Russian' },
            { id: 'english', label: 'English (old)' },
            { id: 'media', label: 'Singers' }
          ],
          now: NOW
        }),
        binding
      ),
      revisionId: REVISION_ID,
      unchanged: false,
      recovery: null
    }]
  });
  assert.equal(
    companionErrorCode(await earlierVenueDraft.handlers.get(
      'prepare:projects:inspectCurrentServiceCompanion'
    )({ trusted: true }, {})),
    'CURRENT_SERVICE_NATIVE_DRAFT_VENUE_MISMATCH'
  );

  const wrongProfile = loadCompanionHandlers({
    manifest: currentManifest({ profileId: 'chapel' })
  });
  assert.equal(
    companionErrorCode(await wrongProfile.handlers.get(
      'prepare:projects:inspectCurrentServiceCompanion'
    )({ trusted: true }, {})),
    'CURRENT_SERVICE_PROFILE_MISMATCH'
  );

  const noSet = loadCompanionHandlers({ manifest: null });
  assert.deepEqual(
    plain(companionData(await noSet.handlers.get(
      'prepare:projects:inspectCurrentServiceCompanion'
    )({ trusted: true }, {}))),
    { available: false }
  );
  assert.equal(
    companionErrorCode(await noSet.handlers.get(
      'prepare:projects:openCurrentServiceCompanion'
    )({ trusted: true }, {})),
    'INVALID_CURRENT_SERVICE_COMPANION_INSPECTION'
  );
});

test('opening fails closed when the loaded service changes after inspection', async () => {
  const harness = loadCompanionHandlers();
  const inspect = harness.handlers.get(
    'prepare:projects:inspectCurrentServiceCompanion'
  );
  const open = harness.handlers.get(
    'prepare:projects:openCurrentServiceCompanion'
  );
  const inspected = companionData(await inspect({ trusted: true }, {}));
  harness.setManifest(currentManifest({
    id: '2026-08-02-main',
    name: 'Next Sunday Service',
    serviceDate: '2026-08-02',
    inputs: Object.fromEntries(
      Object.entries(currentManifest().inputs).map(([roleId, input]) => [
        roleId,
        {
          ...input,
          sourceName: input.sourceName.replace('07-26-2026', '08-02-2026'),
          sha256: roleId === 'english'
            ? 'd'.repeat(64)
            : roleId === 'russian'
              ? 'e'.repeat(64)
              : 'f'.repeat(64)
        }
      ])
    )
  }));

  assert.equal(
    companionErrorCode(await open(
      { trusted: true },
      { inspectionToken: inspected.inspectionToken }
    )),
    'CURRENT_SERVICE_COMPANION_CHANGED'
  );
  assert.equal(harness.createCount, 0);
});

test('renderer companion handoff decision distinguishes new, linked, and broken records', () => {
  const { resolveCurrentServiceCompanionHandoff } = rendererExports();
  const unlinked = {
    workflowMode: POWERPOINT_COMPANION_WORKFLOW_MODE,
    rootItemIds: ['sermon-anchor'],
    items: {
      'sermon-anchor': {
        id: 'sermon-anchor',
        kind: 'group',
        groupKind: 'sermon',
        title: 'Sermon',
        childIds: []
      }
    },
    resources: {}
  };
  const start = resolveCurrentServiceCompanionHandoff(
    unlinked,
    'sermon-anchor'
  );
  assert.equal(start.mode, 'start-unlinked');
  assert.equal(start.linked, null);

  const resourceId = `sha256:${'d'.repeat(64)}`;
  const linked = {
    ...unlinked,
    items: {
      'sermon-anchor': {
        ...unlinked.items['sermon-anchor'],
        sermonResourceId: resourceId
      }
    },
    resources: {
      [resourceId]: {
        kind: 'sermon',
        sha256: 'd'.repeat(64),
        document: { id: 'sermon-prayer' }
      }
    }
  };
  const resume = resolveCurrentServiceCompanionHandoff(
    linked,
    'sermon-anchor'
  );
  assert.equal(resume.mode, 'resume-linked');
  assert.equal(resume.linked.resourceId, resourceId);

  assert.throws(
    () => resolveCurrentServiceCompanionHandoff({
      ...linked,
      resources: {}
    }, 'sermon-anchor'),
    /broken sermon packet link/
  );
  assert.throws(
    () => resolveCurrentServiceCompanionHandoff(
      { ...unlinked, workflowMode: 'native' },
      'sermon-anchor'
    ),
    /verified sermon handoff anchor/
  );
});

test('main rejects native export, publication, and generated readings for companions before side effects', () => {
  const exportSource = sourceBetween(
    mainSource,
    "ipcMain.handle('prepare:projects:export'",
    "ipcMain.handle('prepare:projects:import'"
  );
  assert.match(exportSource, /isPowerPointCompanionProject\(selectedProject\.project\)/);
  assert.match(exportSource, /CURRENT_SERVICE_COMPANION_NOT_EXPORTABLE/);
  assert.ok(
    exportSource.indexOf('CURRENT_SERVICE_COMPANION_NOT_EXPORTABLE')
      < exportSource.indexOf('serviceProjectExchange.exportBundle')
  );

  const publishSource = sourceBetween(
    mainSource,
    "ipcMain.handle('prepare:projects:publish'",
    "ipcMain.handle('dialog:openPptx'"
  );
  assert.match(publishSource, /isPowerPointCompanionProject\(selected\.project\)/);
  assert.match(publishSource, /CURRENT_SERVICE_COMPANION_NOT_PUBLISHABLE/);
  assert.ok(
    publishSource.indexOf('CURRENT_SERVICE_COMPANION_NOT_PUBLISHABLE')
      < publishSource.indexOf('showPackagePublisher.publish')
  );

  const proposeSource = sourceBetween(
    mainSource,
    "ipcMain.handle('prepare:projects:proposeServiceSermonPacket'",
    "ipcMain.handle('prepare:projects:commitServiceSermonPacket'"
  );
  assert.match(
    proposeSource,
    /isPowerPointCompanionProject\(current\.project\)[\s\S]*readingMode !== 'already-in-service'[\s\S]*CURRENT_SERVICE_READING_ALREADY_PRESENT/
  );
  assert.ok(
    proposeSource.indexOf('requireNewSermonPacketTarget(current, request.itemId)')
      < proposeSource.indexOf('dialog.showOpenDialog'),
    'an already-linked companion must fail before the manuscript picker opens'
  );

  const commitSource = sourceBetween(
    mainSource,
    "ipcMain.handle('prepare:projects:commitServiceSermonPacket'",
    "ipcMain.handle('prepare:projects:createSermonPacket'"
  );
  assert.match(
    commitSource,
    /isPowerPointCompanionProject\(current\.project\)[\s\S]*entry\.readingMode !== 'already-in-service'[\s\S]*CURRENT_SERVICE_READING_ALREADY_PRESENT/
  );

  const createSource = sourceBetween(
    mainSource,
    "ipcMain.handle('prepare:projects:createSermonPacket'",
    "ipcMain.handle('prepare:projects:addSermonReading'"
  );
  assert.match(
    createSource,
    /isPowerPointCompanionProject\(current\.project\)[\s\S]*CURRENT_SERVICE_REVIEW_REQUIRED/
  );
  assert.ok(
    createSource.indexOf('CURRENT_SERVICE_REVIEW_REQUIRED')
      < createSource.indexOf('resolveNewSermonPacketMetadata')
  );

  const addReadingSource = sourceBetween(
    mainSource,
    "ipcMain.handle('prepare:projects:addSermonReading'",
    "ipcMain.handle('prepare:projects:addGroup'"
  );
  assert.match(
    addReadingSource,
    /isPowerPointCompanionProject\(current\.project\)[\s\S]*CURRENT_SERVICE_READING_ALREADY_PRESENT/
  );

  const sourceSermon = sourceBetween(
    mainSource,
    "ipcMain.handle('prepare:projects:sourceSermon'",
    "ipcMain.handle('prepare:projects:attachSermonSource'"
  );
  assert.match(
    sourceSermon,
    /isPowerPointCompanionProject\(current\.project\)[\s\S]*CURRENT_SERVICE_COMPANION_LINK_LOCKED/
  );
});

test('renderer companion card uses path-safe summaries, clear CTA copy, and guarded native controls', () => {
  for (const id of [
    'prepareCurrentServiceCompanion',
    'prepareCurrentServiceCompanionHeading',
    'prepareCurrentServiceCompanionMeta',
    'prepareCurrentServiceCompanionFiles',
    'btnOpenCurrentServiceCompanion'
  ]) {
    assert.match(htmlSource, new RegExp(`id="${id}"`));
  }
  assert.match(
    htmlSource,
    /The original presentations remain untouched and stay the current Show source\. A native draft copies the exact rendered slides already on this computer; replace only ranges you review\./
  );
  assert.match(htmlSource, /id="btnCreateCurrentServiceNativeDraft"/);

  const { normalizeCurrentServiceCompanionSummary } = rendererExports();
  const normalized = normalizeCurrentServiceCompanionSummary({
    available: true,
    serviceSet: {
      name: 'Sunday Service',
      serviceDate: '2026-07-26',
      profileName: 'Main Sanctuary'
    },
    sources: [
      {
        roleId: 'english',
        roleLabel: 'English',
        fileName: '/Users/operator/Church/07-26 Service ENG.pptx'
      },
      {
        roleId: 'russian',
        roleLabel: 'Russian',
        fileName: 'C:\\Church\\07-26 Service RUS.pptx'
      }
    ],
    exists: true,
    projectId: 'pptx-companion-example',
    inspectionToken: 'x'.repeat(32),
    expiresAt: '2026-07-26T16:15:00.000Z',
    nativeDraft: null
  });
  assert.deepEqual(plain(normalized), {
    available: true,
    serviceSet: {
      name: 'Sunday Service',
      serviceDate: '2026-07-26',
      profileName: 'Main Sanctuary'
    },
    sources: [
      {
        roleId: 'english',
        roleLabel: 'English',
        fileName: '07-26 Service ENG.pptx'
      },
      {
        roleId: 'russian',
        roleLabel: 'Russian',
        fileName: '07-26 Service RUS.pptx'
      }
    ],
    exists: true,
    projectId: 'pptx-companion-example',
    inspectionToken: 'x'.repeat(32),
    expiresAt: '2026-07-26T16:15:00.000Z',
    nativeDraft: null
  });
  assert.equal(hasLocalPath(normalized), false);
  assert.throws(
    () => normalizeCurrentServiceCompanionSummary({
      available: true,
      serviceSet: {
        name: 'Sunday Service',
        serviceDate: '2026-07-26',
        profileName: 'Main Sanctuary'
      },
      inspectionToken: 'x'.repeat(32),
      expiresAt: '2026-07-26T16:15:00.000Z',
      sources: []
    }),
    /could not be summarized/
  );

  const renderSource = sourceBetween(
    controllerSource,
    'function renderCurrentServiceCompanion()',
    'async function loadCurrentServiceCompanion()'
  );
  for (const copy of [
    'Service follow-up is ready',
    'Review this PowerPoint service',
    'Continue sermon handoff',
    'Open sermon handoff',
    'Start sermon handoff'
  ]) {
    assert.match(renderSource, new RegExp(copy));
  }
  const openSource = sourceBetween(
    controllerSource,
    'async function openCurrentServiceCompanion()',
    'function renderProjectList()'
  );
  assert.match(
    openSource,
    /resolveCurrentServiceCompanionHandoff\(\s*candidateProject,\s*anchorItemId\s*\)/
  );
  assert.match(
    openSource,
    /normalizeCurrentServiceCompanionSummary\(\s*result\.companion\s*\)/
  );
  assert.match(
    openSource,
    /api\.openCurrentServiceCompanion\(\{\s*inspectionToken\s*\}\)/
  );
  assert.match(
    openSource,
    /const linked = handoff\.linked/
  );
  assert.ok(
    openSource.indexOf('resolveCurrentServiceCompanionHandoff(')
      < openSource.indexOf('applyProjectResult(result)'),
    'the returned companion must be validated before it replaces renderer state'
  );
  assert.ok(
    openSource.indexOf('normalizeCurrentServiceCompanionSummary(')
      < openSource.indexOf('applyProjectResult(result)'),
    'the companion summary must be validated before it replaces renderer state'
  );
  assert.match(openSource, /openPacket = !linked/);
  assert.match(openSource, /linkedResumeContext = linked/);
  assert.match(
    openSource,
    /if \(openPacket\) \{\s*openSermonPacketDialog\(\);\s*\} else if \(linkedResumeContext\) \{[\s\S]*loadSelectedSermonCommunityState\(\{ force: true \}\)[\s\S]*btnReviewSermonPostService/
  );
  assert.match(
    openSource,
    /if \(!resumeStillSelected\(\)\) return;[\s\S]*setTimeout\(\(\) => \{\s*if \(!resumeStillSelected\(\)\) return;/
  );

  const controls = sourceBetween(
    controllerSource,
    'function updateControlStates()',
    'function renderCurrentServiceCompanion()'
  );
  for (const pattern of [
    /btnExportProject\.hidden = companionProject/,
    /btnExportProject\.disabled = !projectOpen \|\| companionProject \|\| locked/,
    /btnPublish\.disabled =[\s\S]*?!projectOpen[\s\S]*?\|\| companionProject/,
    /btnAddText\.disabled = !projectOpen \|\| companionProject \|\| locked/,
    /btnAddPicture\.disabled = !projectOpen \|\| companionProject \|\| locked/,
    /btnAddGroup\.disabled = !projectOpen \|\| companionProject \|\| locked/,
    /btnAddText\.hidden = companionProject/,
    /btnAddPicture\.hidden = companionProject/,
    /btnAddGroup\.hidden = companionProject/,
    /btnAddBible\.disabled = !projectOpen[\s\S]*companionProject/,
    /btnMoveUp\.disabled = !row \|\| companionProject/,
    /btnRemove\.disabled = !row \|\| companionProject/,
    /if \(companionProject\) elements\.sermonPacketAddReading\.checked = false/,
    /btnAddSermonReading\.disabled = companionProject/,
    /sermonSource\.disabled = !sermonEligible[\s\S]*companionProject/,
    /btnLinkSermonSource\.disabled = !sermonEligible[\s\S]*companionProject/,
    /btnReviewLinkedSermonServiceSources\.disabled =[\s\S]*companionProject/,
    /btnConfirmSermonPacket\.disabled =[\s\S]*\(companionProject && !state\.sermonPacketProposal\)/,
    /Review files first/
  ]) {
    assert.match(controls, pattern);
  }

  const createPacketGuard = controls.match(
    /elements\.btnCreateSermonPacket\.disabled =[\s\S]*?;/
  )?.[0];
  assert.ok(createPacketGuard);
  assert.match(
    createPacketGuard,
    /\|\| Boolean\(linkedSermon\)/
  );

  const packetDialogSource = sourceBetween(
    controllerSource,
    'function openSermonPacketDialog()',
    'function closeSermonPacketDialog()'
  );
  assert.match(
    packetDialogSource,
    /if \(linked\) return/
  );

  const rundownSource = sourceBetween(
    controllerSource,
    'function renderRundown()',
    'function renderInspector()'
  );
  assert.match(
    rundownSource,
    /const locked = state\.mutationBusy \|\| state\.publishBusy \|\| companionProject/
  );
  assert.match(rundownSource, /listItem\.draggable = !locked/);

  const inspectorSource = sourceBetween(
    controllerSource,
    'function renderInspector()',
    'function renderPreview()'
  );
  assert.doesNotMatch(inspectorSource, /\bopened\b/);
});
