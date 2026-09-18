'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const JSZip = require('jszip');

const {
  buildPptxSongDraft: buildRealPptxSongDraft,
  inspectPptxSongSlides: inspectRealPptxSongSlides
} = require('../src/services/project');

const root = path.join(__dirname, '..');
const mainSource = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
const preloadSource = fs.readFileSync(path.join(root, 'preload.js'), 'utf8');
const SOURCE_BUFFER = Buffer.from('reviewed-current-service-pptx');
const SOURCE_SHA256 = crypto
  .createHash('sha256')
  .update(SOURCE_BUFFER)
  .digest('hex');
const BINDING = Object.freeze({
  id: '2026-07-26-main',
  fingerprint: 'f'.repeat(64),
  serviceDate: '2026-07-26',
  profileId: 'main-sanctuary'
});

function plain(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function sourceBetween(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  assert.notEqual(start, -1, `${startMarker} must be implemented`);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.notEqual(end, -1, `${endMarker} must follow ${startMarker}`);
  return source.slice(start, end);
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

function loadPreloadBridge() {
  const calls = [];
  let api = null;
  vm.runInNewContext(preloadSource, {
    require(moduleId) {
      if (moduleId !== 'electron') {
        throw new Error(`Unexpected preload dependency: ${moduleId}`);
      }
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
    },
    console,
    TextEncoder
  }, { filename: path.join(root, 'preload.js') });
  return { api, calls };
}

function rawInspection() {
  const lane = (preview, lineCount) => ({ preview, lineCount });
  return {
    deckSha256: SOURCE_SHA256,
    slideCount: 3,
    slides: [
      {
        number: 1,
        lanes: {
          all: lane('Come Thou Fount', 1),
          white: lane('Come Thou Fount', 1),
          yellow: lane('', 0)
        },
        nativePath: '/private/must-not-cross-ipc'
      },
      {
        number: 2,
        lanes: {
          all: lane('Tune my heart to sing Thy grace', 2),
          white: lane('Tune my heart', 1),
          yellow: lane('to sing Thy grace', 1)
        }
      },
      {
        number: 3,
        lanes: {
          all: lane('Streams of mercy', 1),
          white: lane('Streams of mercy', 1),
          yellow: lane('', 0)
        }
      }
    ],
    candidates: [{
      id: 'slides-1-2-3',
      kind: 'syncshow-current-service-song-review-range',
      titleSlide: 1,
      startSlide: 2,
      endSlide: 3,
      evidence: {
        kind: 'template-text-shape-run',
        bodySlideCount: 2,
        titleShapeName: 'Content Placeholder 2',
        titlePlaceholderIndex: '1',
        bodyShapeName: 'TextBox 3'
      }
    }],
    sourcePath: '/private/must-not-cross-ipc'
  };
}

async function buildSeamPptx() {
  const zip = new JSZip();
  const slide = text =>
    '<?xml version="1.0" encoding="UTF-8"?>'
      + '<p:sld xmlns:p="urn:p" xmlns:a="urn:a"><p:cSld><p:spTree>'
      + `<a:p><a:r><a:rPr><a:solidFill><a:srgbClr val="FFFFFF"/></a:solidFill></a:rPr><a:t>${text}</a:t></a:r></a:p>`
      + '</p:spTree></p:cSld></p:sld>';
  zip.file('ppt/slides/slide1.xml', slide('First exact line'));
  zip.file('ppt/slides/slide2.xml', slide('Second exact line'));
  zip.file(
    'ppt/presentation.xml',
    '<p:presentation xmlns:p="urn:p" xmlns:r="urn:r"><p:sldIdLst>'
      + '<p:sldId id="256" r:id="rId1"/>'
      + '<p:sldId id="257" r:id="rId2"/>'
      + '</p:sldIdLst></p:presentation>'
  );
  zip.file(
    'ppt/_rels/presentation.xml.rels',
    '<Relationships>'
      + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide1.xml"/>'
      + '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide2.xml"/>'
      + '</Relationships>'
  );
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

function loadHandlers(options = {}) {
  const sourceBuffer = Buffer.from(options.sourceBuffer || SOURCE_BUFFER);
  const sourceSha256 = crypto
    .createHash('sha256')
    .update(sourceBuffer)
    .digest('hex');
  const inspectImplementation = options.inspectPptxSongSlides
    || (async () => rawInspection());
  const buildImplementation = options.buildPptxSongDraft
    || (async (buffer, buildOptions) => ({
      song: {
        titles: { en: buildOptions.title },
        defaultLanguage: buildOptions.language
      },
      warnings: [{ code: 'PROVISIONAL_SECTION' }],
      provenance: {
        sourceSha256: crypto
          .createHash('sha256')
          .update(buffer)
          .digest('hex')
      }
    }));
  const handlers = new Map();
  const currentServiceCompanionInspections = new Map();
  const currentServiceSongDraftProposals = new Map();
  const reads = [];
  const buildCalls = [];
  let now = Date.parse('2026-07-26T16:00:00.000Z');
  let currentBuffer = Buffer.from(sourceBuffer);
  let currentBinding = { ...BINDING };

  class FakeDate extends Date {
    constructor(...args) {
      super(...(args.length > 0 ? args : [now]));
    }

    static now() {
      return now;
    }
  }

  const failMainOperation = (code, message, details = {}) => {
    const error = new Error(message);
    error.code = code;
    error.details = details;
    throw error;
  };
  const prepareText = (value, label, maximum, { required = false } = {}) => {
    if (value === undefined || value === null) value = '';
    if (typeof value !== 'string') {
      failMainOperation('INVALID_PREPARE_TEXT', `${label} must be text.`);
    }
    const normalized = value.trim();
    if (required && !normalized) {
      failMainOperation('MISSING_PREPARE_TEXT', `${label} is required.`);
    }
    if (normalized.length > maximum) {
      failMainOperation('PREPARE_TEXT_TOO_LONG', `${label} is too long.`);
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
  const input = () => ({
    roleId: 'english',
    sourceName: '07-26-2026 Service ENG.pptx',
    pinnedPath: '/private/pinned/english.pptx',
    size: sourceBuffer.length,
    sha256: sourceSha256
  });
  const context = () => ({
    binding: { ...currentBinding },
    manifest: {
      ...currentBinding,
      inputs: { english: input() }
    },
    summary: {
      serviceSet: {
        name: 'Sunday Service',
        serviceDate: '2026-07-26'
      },
      sources: [{
        roleId: 'english',
        roleLabel: 'English',
        fileName: '07-26-2026 Service ENG.pptx'
      }]
    }
  });
  const handlerSource = sourceBetween(
    mainSource,
    'function failCurrentServiceSongDraft',
    "ipcMain.handle('prepare:projects:list'"
  );

  vm.runInNewContext(handlerSource, {
    Buffer,
    CURRENT_SERVICE_SONG_DRAFT_MAX_INSPECTION_SLIDES: 1000,
    CURRENT_SERVICE_SONG_DRAFT_MAX_CANDIDATES: 256,
    CURRENT_SERVICE_SONG_DRAFT_MAX_PREVIEW_CHARS: 32_000,
    CURRENT_SERVICE_SONG_DRAFT_MAX_SLIDES: 200,
    CURRENT_SERVICE_SONG_DRAFT_MAX_SOURCE_BYTES: 128 * 1024 * 1024,
    CURRENT_SERVICE_SONG_DRAFT_PROPOSAL_LIMIT: 12,
    CURRENT_SERVICE_SONG_DRAFT_PROPOSAL_TTL_MS: 15 * 60 * 1000,
    Date: FakeDate,
    async buildPptxSongDraft(buffer, options) {
      buildCalls.push({
        sha256: crypto.createHash('sha256').update(buffer).digest('hex'),
        options: plain(options)
      });
      return buildImplementation(buffer, options);
    },
    console,
    crypto,
    currentServiceCompanionInspections,
    currentServiceSongDraftProposals,
    failMainOperation,
    async inspectCurrentServiceCompanionContext() {
      return context();
    },
    async inspectPptxSongSlides(buffer) {
      return inspectImplementation(buffer);
    },
    ipcMain: {
      handle(channel, handler) {
        handlers.set(channel, handler);
      }
    },
    path,
    prepareId,
    prepareText,
    async readFileNoFollow(filePath, maximumBytes) {
      reads.push({ filePath, maximumBytes });
      return {
        buffer: Buffer.from(currentBuffer),
        stats: { size: currentBuffer.length },
        realPath: filePath
      };
    },
    requireControlSender(event) {
      if (event?.trusted !== true) {
        failMainOperation('UNTRUSTED_SENDER', 'Untrusted sender.');
      }
    },
    requireCurrentServiceCompanionInspection(rawToken) {
      const inspection = currentServiceCompanionInspections.get(rawToken);
      if (!inspection || inspection.expiresAt <= FakeDate.now()) {
        currentServiceCompanionInspections.delete(rawToken);
        failMainOperation(
          'EXPIRED_CURRENT_SERVICE_COMPANION_INSPECTION',
          'Inspection expired.'
        );
      }
      return { inspectionToken: rawToken, inspection };
    },
    requireExactPrepareKeys(request, allowed) {
      if (Object.keys(request).some(key => !allowed.includes(key))) {
        failMainOperation(
          'UNSUPPORTED_PREPARE_FIELDS',
          'Unsupported Prepare fields.'
        );
      }
    },
    requirePrepareRequest(request) {
      if (!request || typeof request !== 'object' || Array.isArray(request)) {
        failMainOperation('INVALID_PREPARE_REQUEST', 'Invalid request.');
      }
    },
    sameCurrentServiceCompanionBinding(left, right) {
      return left?.id === right?.id
        && left?.fingerprint === right?.fingerprint
        && left?.serviceDate === right?.serviceDate
        && left?.profileId === right?.profileId;
    }
  }, { filename: 'current-service-song-draft-handlers.js' });

  let inspectionSequence = 0;
  return {
    handlers,
    reads,
    buildCalls,
    currentServiceCompanionInspections,
    currentServiceSongDraftProposals,
    addInspection() {
      inspectionSequence += 1;
      const token = `${String(inspectionSequence).padStart(2, '0')}${'I'.repeat(30)}`;
      currentServiceCompanionInspections.set(token, {
        binding: { ...BINDING },
        expiresAt: now + 15 * 60 * 1000
      });
      return token;
    },
    advance(milliseconds) {
      now += milliseconds;
    },
    changeBinding() {
      currentBinding = {
        ...currentBinding,
        fingerprint: 'e'.repeat(64)
      };
    },
    tamperSource() {
      currentBuffer = Buffer.from(sourceBuffer);
      currentBuffer[0] ^= 0xff;
    }
  };
}

test('preload exposes only semantic current-service song review fields', async () => {
  const { api, calls } = loadPreloadBridge();

  await api.inspectCurrentServiceSongSource({
    inspectionToken: 'i'.repeat(32),
    roleId: 'english',
    pinnedPath: '/private/pinned/english.pptx',
    sourcePath: '/private/source/english.pptx'
  });
  await api.buildCurrentServiceSongDraft({
    proposalToken: 'p'.repeat(32),
    lane: 'white',
    startSlide: 8,
    endSlide: 13,
    slideLanes: ['white', 'yellow', 'white', 'yellow', 'all', 'white'],
    title: 'Come Thou Fount',
    language: 'en',
    confirmed: true,
    projectId: 'renderer-controlled',
    communityVisibility: 'public',
    destinationPath: '/private/library/song.json'
  });

  assert.deepEqual(calls, [
    {
      channel: 'prepare:songs:inspectCurrentServiceSource',
      payload: {
        inspectionToken: 'i'.repeat(32),
        roleId: 'english'
      }
    },
    {
      channel: 'prepare:songs:buildCurrentServiceDraft',
      payload: {
        proposalToken: 'p'.repeat(32),
        lane: 'white',
        startSlide: 8,
        endSlide: 13,
        slideLanes: ['white', 'yellow', 'white', 'yellow', 'all', 'white'],
        title: 'Come Thou Fount',
        language: 'en',
        confirmed: true
      }
    }
  ]);
  assert.equal(hasLocalPath(calls), false);
});

test('inspection is sender-guarded, exact, path-free, and bound to verified bytes', async () => {
  const harness = loadHandlers();
  const inspect = harness.handlers.get(
    'prepare:songs:inspectCurrentServiceSource'
  );
  const inspectionToken = harness.addInspection();

  await assert.rejects(
    inspect({ trusted: false }, { inspectionToken, roleId: 'english' }),
    error => error.code === 'UNTRUSTED_SENDER'
  );
  await assert.rejects(
    inspect(
      { trusted: true },
      {
        inspectionToken,
        roleId: 'english',
        pinnedPath: '/private/renderer-controlled.pptx'
      }
    ),
    error => error.code === 'UNSUPPORTED_PREPARE_FIELDS'
  );

  const reviewed = await inspect(
    { trusted: true },
    { inspectionToken, roleId: 'english' }
  );
  assert.match(reviewed.proposalToken, /^[A-Za-z0-9_-]{32}$/);
  assert.equal(Number.isFinite(Date.parse(reviewed.expiresAt)), true);
  assert.deepEqual(plain({
    serviceSet: reviewed.serviceSet,
    source: reviewed.source,
    slideCount: reviewed.slideCount,
    slides: reviewed.slides,
    candidates: reviewed.candidates
  }), {
    serviceSet: {
      name: 'Sunday Service',
      serviceDate: '2026-07-26'
    },
    source: {
      roleId: 'english',
      roleLabel: 'English',
      fileName: '07-26-2026 Service ENG.pptx',
      sha256: SOURCE_SHA256
    },
    slideCount: 3,
    slides: rawInspection().slides.map(({ number, lanes }) => ({
      number,
      lanes
    })),
    candidates: [{
      id: 'slides-1-2-3',
      kind: 'syncshow-current-service-song-review-range',
      titleSlide: 1,
      startSlide: 2,
      endSlide: 3,
      evidence: {
        kind: 'template-text-shape-run',
        bodySlideCount: 2
      }
    }]
  });
  assert.equal(hasLocalPath(reviewed), false);
  assert.deepEqual(harness.reads, [{
    filePath: '/private/pinned/english.pptx',
    maximumBytes: 128 * 1024 * 1024
  }]);
  assert.equal(
    harness.currentServiceCompanionInspections.has(inspectionToken),
    false
  );
  assert.equal(
    harness.currentServiceSongDraftProposals.has(reviewed.proposalToken),
    true
  );
});

test('main inspection and build handlers compose with the real PPTX song core', async () => {
  const sourceBuffer = await buildSeamPptx();
  const sourceSha256 = crypto
    .createHash('sha256')
    .update(sourceBuffer)
    .digest('hex');
  const harness = loadHandlers({
    sourceBuffer,
    inspectPptxSongSlides: inspectRealPptxSongSlides,
    buildPptxSongDraft: buildRealPptxSongDraft
  });
  const inspect = harness.handlers.get(
    'prepare:songs:inspectCurrentServiceSource'
  );
  const build = harness.handlers.get(
    'prepare:songs:buildCurrentServiceDraft'
  );

  const reviewed = await inspect(
    { trusted: true },
    {
      inspectionToken: harness.addInspection(),
      roleId: 'english'
    }
  );
  assert.equal(reviewed.source.sha256, sourceSha256);
  assert.deepEqual(
    plain(reviewed.slides.map(slide => slide.lanes.white.preview)),
    ['First exact line', 'Second exact line']
  );

  const result = await build(
    { trusted: true },
    {
      proposalToken: reviewed.proposalToken,
      lane: 'white',
      startSlide: 1,
      endSlide: 2,
      slideLanes: ['white', 'white'],
      title: 'Real Seam Song',
      language: 'en',
      confirmed: true
    }
  );
  assert.equal(result.song.title, 'Real Seam Song');
  assert.equal(result.song.language, 'en');
  assert.deepEqual(
    plain(result.song.sections.map(section => section.slides[0].lines)),
    [['First exact line'], ['Second exact line']]
  );
  assert.deepEqual(
    plain(result.warnings.map(warning => warning.code)),
    ['PROVISIONAL_SECTION_LABELS', 'CREDITS_AND_RIGHTS_NOT_INFERRED']
  );
  assert.equal(result.provenance.deckSha256, sourceSha256);
  assert.deepEqual(plain(result.provenance.slideNumbers), [1, 2]);
  assert.equal(result.provenance.lane, 'white');
  assert.equal(
    result.song.extraMetadata.syncshow_capture_deck_sha256,
    sourceSha256
  );
  assert.equal(
    result.song.source,
    'Sunday Service (2026-07-26) — English: 07-26-2026 Service ENG.pptx'
  );
  assert.equal(hasLocalPath(result), false);
});

test('inspection rejects a core hash mismatch before issuing a proposal', async () => {
  const harness = loadHandlers({
    async inspectPptxSongSlides() {
      return {
        ...rawInspection(),
        deckSha256: '0'.repeat(64)
      };
    }
  });
  const inspect = harness.handlers.get(
    'prepare:songs:inspectCurrentServiceSource'
  );
  await assert.rejects(
    inspect(
      { trusted: true },
      {
        inspectionToken: harness.addInspection(),
        roleId: 'english'
      }
    ),
    error =>
      error.code === 'INVALID_CURRENT_SERVICE_SONG_INSPECTION'
      && hasLocalPath(error.details) === false
  );
  assert.equal(harness.currentServiceSongDraftProposals.size, 0);
});

test('a proposal rejects a concurrent confirmed build and remains one-shot', async () => {
  let releaseBuild;
  let reportBuildStarted;
  const buildStarted = new Promise(resolve => {
    reportBuildStarted = resolve;
  });
  const buildReleased = new Promise(resolve => {
    releaseBuild = resolve;
  });
  const harness = loadHandlers({
    async buildPptxSongDraft(buffer, options) {
      reportBuildStarted();
      await buildReleased;
      return {
        song: {
          titles: { en: options.title },
          defaultLanguage: options.language
        },
        warnings: [],
        provenance: {
          sourceSha256: crypto
            .createHash('sha256')
            .update(buffer)
            .digest('hex')
        }
      };
    }
  });
  const inspect = harness.handlers.get(
    'prepare:songs:inspectCurrentServiceSource'
  );
  const build = harness.handlers.get(
    'prepare:songs:buildCurrentServiceDraft'
  );
  const reviewed = await inspect(
    { trusted: true },
    {
      inspectionToken: harness.addInspection(),
      roleId: 'english'
    }
  );
  const request = {
    proposalToken: reviewed.proposalToken,
    lane: 'white',
    startSlide: 1,
    endSlide: 2,
    slideLanes: ['white', 'white'],
    title: 'One Shot',
    language: 'en',
    confirmed: true
  };
  const firstBuild = build({ trusted: true }, request);
  await buildStarted;
  await assert.rejects(
    build({ trusted: true }, request),
    error => error.code === 'CURRENT_SERVICE_SONG_DRAFT_BUILD_IN_PROGRESS'
  );
  releaseBuild();
  await firstBuild;
  assert.equal(
    harness.currentServiceSongDraftProposals.has(reviewed.proposalToken),
    false
  );
});

test('confirmed draft build revalidates the binding and hash, then consumes its token', async () => {
  const harness = loadHandlers();
  const inspect = harness.handlers.get(
    'prepare:songs:inspectCurrentServiceSource'
  );
  const build = harness.handlers.get(
    'prepare:songs:buildCurrentServiceDraft'
  );
  const reviewed = await inspect(
    { trusted: true },
    {
      inspectionToken: harness.addInspection(),
      roleId: 'english'
    }
  );

  await assert.rejects(
    build(
      { trusted: false },
      {
        proposalToken: reviewed.proposalToken,
        lane: 'white',
        startSlide: 1,
        endSlide: 2,
        title: 'Come Thou Fount',
        language: 'en',
        confirmed: true
      }
    ),
    error => error.code === 'UNTRUSTED_SENDER'
  );
  await assert.rejects(
    build(
      { trusted: true },
      {
        proposalToken: reviewed.proposalToken,
        lane: 'white',
        startSlide: 1,
        endSlide: 2,
        title: 'Come Thou Fount',
        language: 'en',
        confirmed: true,
        sourcePath: '/private/renderer-controlled.pptx'
      }
    ),
    error => error.code === 'UNSUPPORTED_PREPARE_FIELDS'
  );
  await assert.rejects(
    build(
      { trusted: true },
      {
        proposalToken: reviewed.proposalToken,
        lane: 'white',
        startSlide: 1,
        endSlide: 2,
        title: 'Come Thou Fount',
        language: 'en',
        confirmed: false
      }
    ),
    error => error.code === 'CURRENT_SERVICE_SONG_DRAFT_CONFIRMATION_REQUIRED'
  );
  await assert.rejects(
    build(
      { trusted: true },
      {
        proposalToken: reviewed.proposalToken,
        lane: 'white',
        startSlide: 1,
        endSlide: 4,
        title: 'Come Thou Fount',
        language: 'en',
        confirmed: true
      }
    ),
    error => error.code === 'INVALID_CURRENT_SERVICE_SONG_RANGE'
  );
  await assert.rejects(
    build(
      { trusted: true },
      {
        proposalToken: reviewed.proposalToken,
        lane: 'white',
        startSlide: 1,
        endSlide: 2,
        slideLanes: ['white'],
        title: 'Come Thou Fount',
        language: 'en',
        confirmed: true
      }
    ),
    error => error.code === 'INVALID_CURRENT_SERVICE_SONG_LANES'
  );
  await assert.rejects(
    build(
      { trusted: true },
      {
        proposalToken: reviewed.proposalToken,
        lane: 'white',
        startSlide: 1,
        endSlide: 2,
        title: 'Come Thou Fount',
        language: 'en',
        confirmed: true
      }
    ),
    error => error.code === 'INVALID_CURRENT_SERVICE_SONG_LANES'
  );
  assert.equal(
    harness.currentServiceSongDraftProposals.has(reviewed.proposalToken),
    true
  );

  const result = await build(
    { trusted: true },
    {
      proposalToken: reviewed.proposalToken,
      lane: 'white',
      startSlide: 1,
      endSlide: 2,
      slideLanes: ['white', 'yellow'],
      title: 'Come Thou Fount',
      language: 'en',
      confirmed: true
    }
  );
  assert.deepEqual(plain(result), {
    song: {
      titles: { en: 'Come Thou Fount' },
      defaultLanguage: 'en'
    },
    warnings: [{ code: 'PROVISIONAL_SECTION' }],
    provenance: { sourceSha256: SOURCE_SHA256 }
  });
  assert.deepEqual(harness.buildCalls, [{
    sha256: SOURCE_SHA256,
    options: {
      slideNumbers: [1, 2],
      slideLanes: ['white', 'yellow'],
      lane: 'white',
      title: 'Come Thou Fount',
      language: 'en',
      sourceLabel:
        'Sunday Service (2026-07-26) — English: 07-26-2026 Service ENG.pptx'
    }
  }]);
  assert.equal(harness.reads.length, 2);
  assert.equal(
    harness.currentServiceSongDraftProposals.has(reviewed.proposalToken),
    false
  );
  await assert.rejects(
    build(
      { trusted: true },
      {
        proposalToken: reviewed.proposalToken,
        lane: 'white',
        startSlide: 1,
        endSlide: 2,
        title: 'Come Thou Fount',
        language: 'en',
        confirmed: true
      }
    ),
    error => error.code === 'EXPIRED_CURRENT_SERVICE_SONG_DRAFT_PROPOSAL'
  );
});

test('expired, stale-service, and changed-byte proposals fail closed and are consumed', async () => {
  const expiryHarness = loadHandlers();
  const expiryInspect = expiryHarness.handlers.get(
    'prepare:songs:inspectCurrentServiceSource'
  );
  const expiryBuild = expiryHarness.handlers.get(
    'prepare:songs:buildCurrentServiceDraft'
  );
  const expiring = await expiryInspect(
    { trusted: true },
    {
      inspectionToken: expiryHarness.addInspection(),
      roleId: 'english'
    }
  );
  expiryHarness.advance(15 * 60 * 1000 + 1);
  await assert.rejects(
    expiryBuild(
      { trusted: true },
      {
        proposalToken: expiring.proposalToken,
        lane: 'all',
        startSlide: 1,
        endSlide: 3,
        title: 'Expired',
        language: 'en',
        confirmed: true
      }
    ),
    error => error.code === 'EXPIRED_CURRENT_SERVICE_SONG_DRAFT_PROPOSAL'
  );
  assert.equal(
    expiryHarness.currentServiceSongDraftProposals.has(
      expiring.proposalToken
    ),
    false
  );

  const staleHarness = loadHandlers();
  const staleInspect = staleHarness.handlers.get(
    'prepare:songs:inspectCurrentServiceSource'
  );
  const staleBuild = staleHarness.handlers.get(
    'prepare:songs:buildCurrentServiceDraft'
  );
  const stale = await staleInspect(
    { trusted: true },
    {
      inspectionToken: staleHarness.addInspection(),
      roleId: 'english'
    }
  );
  staleHarness.changeBinding();
  await assert.rejects(
    staleBuild(
      { trusted: true },
      {
        proposalToken: stale.proposalToken,
        lane: 'all',
        startSlide: 1,
        endSlide: 3,
        slideLanes: ['all', 'all', 'all'],
        title: 'Stale',
        language: 'en',
        confirmed: true
      }
    ),
    error => error.code === 'CURRENT_SERVICE_SONG_SET_CHANGED'
  );
  assert.equal(
    staleHarness.currentServiceSongDraftProposals.has(stale.proposalToken),
    false
  );

  const hashHarness = loadHandlers();
  const hashInspect = hashHarness.handlers.get(
    'prepare:songs:inspectCurrentServiceSource'
  );
  const hashBuild = hashHarness.handlers.get(
    'prepare:songs:buildCurrentServiceDraft'
  );
  const changed = await hashInspect(
    { trusted: true },
    {
      inspectionToken: hashHarness.addInspection(),
      roleId: 'english'
    }
  );
  hashHarness.tamperSource();
  await assert.rejects(
    hashBuild(
      { trusted: true },
      {
        proposalToken: changed.proposalToken,
        lane: 'yellow',
        startSlide: 1,
        endSlide: 3,
        slideLanes: ['yellow', 'yellow', 'yellow'],
        title: 'Changed bytes',
        language: 'ru',
        confirmed: true
      }
    ),
    error => error.code === 'CURRENT_SERVICE_SONG_SOURCE_CHANGED'
  );
  assert.equal(hashHarness.buildCalls.length, 0);
  assert.equal(
    hashHarness.currentServiceSongDraftProposals.has(changed.proposalToken),
    false
  );
});

test('main contract has bounded one-shot tokens and no renderer-controlled native paths', () => {
  const handlers = sourceBetween(
    mainSource,
    'function failCurrentServiceSongDraft',
    "ipcMain.handle('prepare:projects:list'"
  );
  const singleDraftHandlers = sourceBetween(
    mainSource,
    'function failCurrentServiceSongDraft',
    'function currentServiceSongFamilyMemberRequest'
  );
  assert.match(
    mainSource,
    /CURRENT_SERVICE_SONG_DRAFT_PROPOSAL_TTL_MS = 15 \* 60 \* 1000/
  );
  assert.match(
    mainSource,
    /CURRENT_SERVICE_SONG_DRAFT_PROPOSAL_LIMIT = 12/
  );
  assert.match(
    mainSource,
    /CURRENT_SERVICE_SONG_DRAFT_MAX_SOURCE_BYTES = 128 \* 1024 \* 1024/
  );
  assert.match(
    handlers,
    /readFileNoFollow\(\s*input\.pinnedPath,\s*CURRENT_SERVICE_SONG_DRAFT_MAX_SOURCE_BYTES\s*\)/
  );
  assert.match(
    handlers,
    /inspectPptxSongSlides\(source\.buffer\)/
  );
  assert.match(
    handlers,
    /buildPptxSongDraft\(source\.buffer,\s*\{\s*slideNumbers,\s*slideLanes,\s*lane,\s*title,\s*language,\s*sourceLabel: entry\.sourceLabel\s*\}\)/
  );
  assert.match(
    handlers,
    /const slideLanes = currentServiceSongDraftSlideLanes\(\s*request\.slideLanes,\s*range\s*\)/
  );
  for (const channel of [
    'prepare:songs:inspectCurrentServiceSource',
    'prepare:songs:buildCurrentServiceDraft'
  ]) {
    const start = handlers.indexOf(`'${channel}'`);
    assert.notEqual(start, -1, `${channel} must be registered`);
    assert.match(
      handlers.slice(start, start + 500),
      /requireControlSender\(event\)/
    );
  }
  assert.doesNotMatch(
    singleDraftHandlers,
    /request\.(?:filePath|sourcePath|pinnedPath|destinationPath|projectId|songId)/
  );
  assert.doesNotMatch(
    singleDraftHandlers,
    /(?:localSongLibrary|serviceProjectStore|Community|community|save|publish)\s*\./
  );
});
