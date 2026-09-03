'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const {
  applyCurrentServiceSongFamilyReview,
  createCurrentServiceSongFamilyReview,
  currentServiceSongFamilyReviewSnapshot,
  LocalServiceSongRightsEvidenceError,
  normalizeLocalServiceSongRightsSelection,
  normalizeSongDocument,
  parseSongDocument,
  serializeSongDocument,
  SONG_FAMILY_REVIEW_CONFIRMATION_AUTHORITY_SCOPE
} = require('../src/services/project');

const root = path.join(__dirname, '..');
const mainSource = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
const preloadSource = fs.readFileSync(path.join(root, 'preload.js'), 'utf8');
const controllerSource = fs.readFileSync(
  path.join(root, 'src', 'renderer', 'prepare-controller.js'),
  'utf8'
);
const BINDING = Object.freeze({
  id: 'service-2026-07-28',
  fingerprint: 'f'.repeat(64),
  serviceDate: '2026-07-28',
  profileId: 'main-sanctuary'
});

function sourceBetween(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  assert.notEqual(start, -1, `${startMarker} must be implemented`);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.notEqual(end, -1, `${endMarker} must follow ${startMarker}`);
  return source.slice(start, end);
}

function plain(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function currentSong({
  id,
  language,
  translationOf = null
}) {
  const song = normalizeSongDocument({
    schemaVersion: 1,
    id,
    title: id,
    language,
    translationOf,
    license: 'Reviewed local license',
    tags: [],
    authors: [],
    translators: [],
    composers: [],
    source: 'Existing local song',
    attribution: '',
    extraMetadata: {},
    sections: [{
      id: 'p1',
      marker: 'P1',
      label: 'P1',
      slides: [{
        id: 'p1-slide-1',
        lines: ['Existing line one']
      }]
    }, {
      id: 'p2',
      marker: 'P2',
      label: 'P2',
      slides: [{
        id: 'p2-slide-1',
        lines: ['Existing line two']
      }]
    }]
  });
  const documentSource = serializeSongDocument(song);
  return {
    song,
    documentSource,
    revision: crypto.createHash('sha256')
      .update(documentSource)
      .digest('hex')
  };
}

function checkedFamilyIpcResult(rawResult) {
  const result = plain(rawResult);
  if (result?.success === false) {
    const error = new Error(
      result.error?.message || 'The family operation failed.'
    );
    error.code = result.error?.code;
    throw error;
  }
  assert.equal(result?.success, true);
  assert.deepEqual(Object.keys(result).sort(), ['data', 'success']);
  return result.data;
}

function checkedFamilyHandler(handler) {
  return async (...args) =>
    checkedFamilyIpcResult(await handler(...args));
}

function rendererExports() {
  const window = {};
  vm.runInNewContext(
    controllerSource,
    { console, window },
    { filename: path.join(root, 'src', 'renderer', 'prepare-controller.js') }
  );
  return window.SyncShowPrepare;
}

function hasForbiddenAuthority(value) {
  if (typeof value === 'string') {
    return value.includes('/private/')
      || value.includes('/Users/')
      || value.includes('deckSha256')
      || value.includes('documentSource')
      || value.includes('pinnedPath')
      || value.includes('communityVisibility');
  }
  if (!value || typeof value !== 'object') return false;
  return Object.entries(value).some(([key, child]) =>
    [
      'deckSha256',
      'documentSource',
      'pinnedPath',
      'sourcePath',
      'destinationPath',
      'communityVisibility'
    ].includes(key) || hasForbiddenAuthority(child));
}

function loadPreloadBridge(invokeHandler = null) {
  const calls = [];
  let api = null;
  vm.runInNewContext(preloadSource, {
    require(moduleId) {
      assert.equal(moduleId, 'electron');
      return {
        contextBridge: {
          exposeInMainWorld(name, value) {
            if (name === 'api') api = value;
          }
        },
        ipcRenderer: {
          invoke(channel, payload) {
            calls.push({ channel, payload: plain(payload) });
            return invokeHandler
              ? Promise.resolve().then(() =>
                  invokeHandler(channel, plain(payload)))
              : Promise.resolve({ ok: true });
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

function loadFamilyHandlers() {
  const handlers = new Map();
  const currentServiceSongDraftProposals = new Map();
  const currentServiceSongFamilyReviews = new Map();
  const sourceReads = [];
  const savedSnapshots = [];
  const commitCalls = [];
  const sourceCatalog = {
    english: {
      roleId: 'english',
      roleLabel: 'English',
      fileName: 'Service ENG.pptx',
      deckSha256: 'a'.repeat(64),
      sourceBytes: Buffer.from('exact-reviewed-family-pptx-english')
    },
    russian: {
      roleId: 'russian',
      roleLabel: 'Russian',
      fileName: 'Service RUS.pptx',
      deckSha256: 'b'.repeat(64),
      sourceBytes: Buffer.from('exact-reviewed-family-pptx-russian')
    }
  };
  const { deckSha256, sourceBytes } = sourceCatalog.english;
  let now = Date.parse('2026-07-28T18:00:00.000Z');
  let currentBinding = { ...BINDING };
  let sourceChanged = false;
  let nextCommitError = null;
  let nextReviewStoreError = null;
  let nextSnapshotError = null;
  let titleEvidenceLinesOverride = null;
  let currentDocuments = [];

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
  const prepareText = (
    value,
    label,
    maximum,
    { required = false } = {}
  ) => {
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
  const requireExactPrepareKeys = (value, allowed) => {
    if (Object.keys(value).some(key => !allowed.includes(key))) {
      failMainOperation(
        'UNSUPPORTED_PREPARE_FIELDS',
        'Unsupported Prepare fields.'
      );
    }
  };
  const context = () => ({
    binding: { ...currentBinding },
    manifest: {
      ...currentBinding,
      inputs: {
        english: {
          roleId: 'english',
          sourceName: 'Service ENG.pptx',
          pinnedPath: '/private/main-owned/service-eng.pptx',
          size: sourceCatalog.english.sourceBytes.length,
          sha256: sourceCatalog.english.deckSha256
        },
        russian: {
          roleId: 'russian',
          sourceName: 'Service RUS.pptx',
          pinnedPath: '/private/main-owned/service-rus.pptx',
          size: sourceCatalog.russian.sourceBytes.length,
          sha256: sourceCatalog.russian.deckSha256
        }
      }
    },
    summary: {
      serviceSet: {
        name: 'Sunday Service',
        serviceDate: BINDING.serviceDate
      },
      sources: [{
        roleId: 'english',
        roleLabel: 'English',
        fileName: 'Service ENG.pptx'
      }, {
        roleId: 'russian',
        roleLabel: 'Russian',
        fileName: 'Service RUS.pptx'
      }]
    }
  });
  const services = {
    localSongLibrary: {
      async withCurrentSnapshot(operation) {
        return operation({
          async snapshotFamily(familyId) {
            const family = currentDocuments.filter(current =>
              current.song.id === familyId
              || current.song.translationOf === familyId);
            return {
              familyId,
              snapshotHash: '0'.repeat(64),
              familyRevision: null,
              documents: family.map(current => ({
                songId: current.song.id,
                revision: current.revision
              }))
            };
          },
          async readRevision(songId, revision) {
            const current = currentDocuments.find(candidate =>
              candidate.song.id === songId
              && candidate.revision === revision);
            if (!current) throw new Error('No current family member revision');
            return current;
          },
          async readCurrent(songId) {
            return currentDocuments.find(candidate =>
              candidate.song.id === songId) || null;
          }
        });
      }
    },
    localSongFamilyReviewStore: {
      async saveSnapshot(snapshot) {
        if (nextReviewStoreError) {
          const error = nextReviewStoreError;
          nextReviewStoreError = null;
          throw error;
        }
        savedSnapshots.push(snapshot);
        return {
          snapshotHash: '9'.repeat(64),
          snapshot,
          unchanged: savedSnapshots.length > 1
        };
      }
    },
    localSongFamilyCommitCoordinator: {
      async commit(request) {
        commitCalls.push(request);
        if (nextCommitError) {
          const error = nextCommitError;
          nextCommitError = null;
          throw error;
        }
        return {
          familyId: savedSnapshots.at(-1).family.rootSongId,
          familyRevision: '8'.repeat(64),
          unchanged: commitCalls.length > 1,
          recovered: commitCalls.length > 1
        };
      }
    }
  };

  const familySource = sourceBetween(
    mainSource,
    'function currentServiceSongFamilyMemberRequest',
    "ipcMain.handle('prepare:projects:list'"
  );
  vm.runInNewContext(familySource, {
    Buffer,
    CURRENT_SERVICE_SONG_DRAFT_MAX_PREVIEW_CHARS: 32_000,
    CURRENT_SERVICE_SONG_DRAFT_MAX_SLIDES: 200,
    CURRENT_SERVICE_SONG_FAMILY_REVIEW_LIMIT: 12,
    CURRENT_SERVICE_SONG_FAMILY_REVIEW_TTL_MS: 15 * 60 * 1000,
    SONG_FAMILY_REVIEW_CONFIRMATION_AUTHORITY_SCOPE,
    LocalServiceSongRightsEvidenceError,
    Date: FakeDate,
    applyCurrentServiceSongFamilyReview,
    async buildPptxSongDraft(buffer, options) {
      const source = Object.values(sourceCatalog).find(candidate =>
        candidate.sourceBytes.equals(buffer));
      assert.ok(source, 'build must receive one exact main-owned source');
      return {
        song: normalizeSongDocument({
          schemaVersion: 1,
          id: 'worker-draft',
          title: options.title,
          language: options.language,
          translationOf: null,
          license: '',
          tags: [],
          authors: [],
          translators: [],
          composers: [],
          source: options.sourceLabel,
          attribution: '',
          extraMetadata: {},
          sections: options.slideNumbers.map((number, index) => ({
            id: `p${index + 1}`,
            marker: `P${index + 1}`,
            label: `P${index + 1}`,
            slides: [{
              id: `p${index + 1}-slide-1`,
              lines: [`${source.roleLabel} exact line ${number}`]
            }]
          }))
        }),
        warnings: [{
          code: 'CREDITS_AND_RIGHTS_NOT_INFERRED',
          message: 'Review rights before committing.'
        }],
        provenance: {
          deckSha256: source.deckSha256,
          deckSlideCount: 3,
          slideNumbers: options.slideNumbers,
          slideLanes: options.slideLanes
        }
      };
    },
    createCurrentServiceSongFamilyReview,
    crypto,
    currentServiceSongDraftLane(raw) {
      const lane = prepareText(raw, 'Lane', 16, { required: true });
      if (!['all', 'white', 'yellow'].includes(lane)) {
        failMainOperation('INVALID_CURRENT_SERVICE_SONG_LANE', 'Bad lane.');
      }
      return lane;
    },
    currentServiceSongDraftLanguage(raw) {
      const language = prepareText(
        raw,
        'Language',
        35,
        { required: true }
      ).toLowerCase();
      if (!/^[a-z]{2,3}(?:-[a-z0-9]{2,8})*$/.test(language)) {
        failMainOperation(
          'INVALID_CURRENT_SERVICE_SONG_LANGUAGE',
          'Bad language.'
        );
      }
      return language;
    },
    currentServiceSongDraftRange(request, slideCount) {
      if (
        !Number.isSafeInteger(request.startSlide)
        || !Number.isSafeInteger(request.endSlide)
        || request.startSlide < 1
        || request.endSlide < request.startSlide
        || request.endSlide > slideCount
      ) {
        failMainOperation(
          'INVALID_CURRENT_SERVICE_SONG_RANGE',
          'Bad range.'
        );
      }
      return {
        startSlide: request.startSlide,
        endSlide: request.endSlide
      };
    },
    currentServiceSongDraftSlideLanes(raw, range) {
      const count = range.endSlide - range.startSlide + 1;
      if (!Array.isArray(raw) || raw.length !== count) {
        failMainOperation(
          'INVALID_CURRENT_SERVICE_SONG_LANES',
          'Bad lanes.'
        );
      }
      return raw.map(value => String(value));
    },
    currentServiceSongDraftProposals,
    currentServiceSongFamilyReviewSnapshot(...args) {
      if (nextSnapshotError) {
        const error = nextSnapshotError;
        nextSnapshotError = null;
        throw error;
      }
      return currentServiceSongFamilyReviewSnapshot(...args);
    },
    normalizeLocalServiceSongRightsSelection,
    currentServiceSongFamilyReviews,
    failCurrentServiceSongDraft(error) {
      if (error?.code) throw error;
      failMainOperation(
        'CURRENT_SERVICE_SONG_DRAFT_UNAVAILABLE',
        'Draft failed.'
      );
    },
    failMainOperation,
    getPrepareServices() {
      return services;
    },
    async inspectCurrentServiceCompanionContext() {
      return context();
    },
    async inspectPptxSongSlides(buffer) {
      const source = Object.values(sourceCatalog).find(candidate =>
        candidate.sourceBytes.equals(buffer));
      assert.ok(source, 'inspection must receive one exact main-owned source');
      return {
        deckSha256: source.deckSha256,
        slideCount: 3,
        slides: [{
          number: 1,
          lanes: {
            all: {
              lines: titleEvidenceLinesOverride || [
                `${source.roleLabel} reviewed title`,
                `${source.roleLabel} title-card credits`
              ],
              lineCount: titleEvidenceLinesOverride
                ? titleEvidenceLinesOverride.length
                : 2
            }
          }
        }, {
          number: 2,
          lanes: {
            all: {
              lines: [`${source.roleLabel} exact line 2`],
              lineCount: 1
            }
          }
        }, {
          number: 3,
          lanes: {
            all: {
              lines: [`${source.roleLabel} exact line 3`],
              lineCount: 1
            }
          }
        }],
        candidates: [{
          id: 'slides-1-2-3',
          titleSlide: 1,
          startSlide: 2,
          endSlide: 3
        }]
      };
    },
    ipcMain: {
      handle(channel, handler) {
        handlers.set(channel, handler);
      }
    },
    parseSongDocument,
    prepareId,
    prepareText,
    publicCurrentServiceSongSlides(value) {
      return value;
    },
    async readCurrentServiceSongSource(_context, roleId, expected) {
      sourceReads.push({ roleId, expected: plain(expected) });
      if (sourceChanged) {
        failMainOperation(
          'CURRENT_SERVICE_SONG_SOURCE_CHANGED',
          'Source changed.'
        );
      }
      const source = sourceCatalog[roleId];
      if (!source) {
        failMainOperation(
          'CURRENT_SERVICE_SONG_ROLE_UNAVAILABLE',
          'Missing role.'
        );
      }
      return {
        buffer: Buffer.from(source.sourceBytes),
        input: {
          roleId,
          size: source.sourceBytes.length,
          sha256: source.deckSha256
        },
        inputSha256: source.deckSha256
      };
    },
    async recoverLocalSongFamilyCommit() {},
    requireControlSender(event) {
      if (event?.trusted !== true) {
        failMainOperation('UNTRUSTED_SENDER', 'Untrusted sender.');
      }
    },
    requireCurrentServiceSongDraftProposal(rawToken) {
      const entry = currentServiceSongDraftProposals.get(rawToken);
      if (!entry || entry.expiresAt <= FakeDate.now()) {
        failMainOperation(
          'EXPIRED_CURRENT_SERVICE_SONG_DRAFT_PROPOSAL',
          'Expired proposal.'
        );
      }
      if (entry.applying) {
        failMainOperation(
          'CURRENT_SERVICE_SONG_DRAFT_BUILD_IN_PROGRESS',
          'Busy proposal.'
        );
      }
      return { proposalToken: rawToken, entry };
    },
    requireExactPrepareKeys,
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
  }, { filename: 'current-service-song-family-handlers.js' });

  function addProposal(roleId = 'english') {
    const source = sourceCatalog[roleId];
    assert.ok(source, `Unknown proposal role ${roleId}`);
    const token = `${String(currentServiceSongDraftProposals.size + 1)
      .padStart(2, '0')}${'P'.repeat(30)}`;
    currentServiceSongDraftProposals.set(token, {
      binding: { ...BINDING },
      roleId,
      inputSha256: source.deckSha256,
      inputSize: source.sourceBytes.length,
      slideCount: 3,
      sourceLabel:
        `Sunday Service (2026-07-28) — ${source.roleLabel}: ${source.fileName}`,
      createdAt: now,
      expiresAt: now + 15 * 60 * 1000,
      applying: false
    });
    return token;
  }

  return {
    handlers,
    currentServiceSongDraftProposals,
    currentServiceSongFamilyReviews,
    sourceReads,
    savedSnapshots,
    commitCalls,
    addProposal,
    advance(milliseconds) {
      now += milliseconds;
    },
    changeBinding() {
      currentBinding = {
        ...currentBinding,
        fingerprint: 'e'.repeat(64)
      };
    },
    changeSource() {
      sourceChanged = true;
    },
    shareDeckHashAcrossRoles() {
      sourceCatalog.russian.deckSha256 =
        sourceCatalog.english.deckSha256;
    },
    setTitleEvidenceLines(lines) {
      titleEvidenceLinesOverride = lines;
    },
    setCurrentDocuments(documents) {
      currentDocuments = documents;
    },
    failNextCommit(
      code = 'WRITE_LOCKED',
      message = 'Transient commit failure.'
    ) {
      const error = new Error(message);
      error.code = code;
      nextCommitError = error;
    },
    failNextReviewStore(
      code = 'INVALID_REVIEW_SNAPSHOT',
      message = 'The reviewed snapshot is invalid.'
    ) {
      const error = new Error(message);
      error.code = code;
      nextReviewStoreError = error;
    },
    failNextSnapshot(
      code = 'CURRENT_SERVICE_SONG_FAMILY_STRUCTURE_MISMATCH'
    ) {
      const error = new Error('Correct the reviewed family structure.');
      error.code = code;
      nextSnapshotError = error;
    }
  };
}

function beginRequest(proposalToken, overrides = {}) {
  return {
    rootMemberKey: 'root',
    members: [{
      memberKey: 'root',
      proposalToken,
      songId: 'reviewed-family',
      title: 'Reviewed Family',
      language: 'en',
      lane: 'white',
      startSlide: 2,
      endSlide: 3,
      slideLanes: ['white', 'yellow'],
      candidateId: 'slides-1-2-3'
    }],
    ...overrides
  };
}

function commitRequest(reviewed, overrides = {}) {
  return {
    reviewToken: reviewed.reviewToken,
    decisions: reviewed.occurrences.map(occurrence =>
      occurrence.suggestedDecision),
    metadata: reviewed.family.members.map(member => ({
      memberKey: member.memberKey,
      license: member.metadata.license || 'CCLI',
      attribution: member.metadata.attribution,
      tags: member.metadata.tags,
      authors: member.metadata.authors,
      translators: member.metadata.translators,
      composers: member.metadata.composers,
      localServiceRights: {
        basis: member.memberKey === 'translation'
          ? 'direct-permission'
          : 'ccli-service-license',
        evidence: member.memberKey === 'translation'
          ? 'Written translation permission reviewed for this local service.'
          : 'CCLI service license and exact SongSelect entry reviewed.'
      }
    })),
    sourceConfirmed: true,
    rightsConfirmed: true,
    localCommitConfirmed: true,
    ...overrides
  };
}

test('preload forwards only semantic family selections, decisions, and metadata', async () => {
  const { api, calls } = loadPreloadBridge();
  await api.beginCurrentServiceSongFamilyReview({
    rootMemberKey: 'root',
    members: [{
      memberKey: 'root',
      proposalToken: 'p'.repeat(32),
      songId: 'reviewed-family',
      title: 'Reviewed Family',
      language: 'en',
      lane: 'white',
      startSlide: 2,
      endSlide: 3,
      slideLanes: ['white', 'yellow'],
      candidateId: 'slides-1-2-3',
      pinnedPath: '/private/forged.pptx',
      deckSha256: 'f'.repeat(64)
    }],
    communityVisibility: 'public'
  });
  await api.commitCurrentServiceSongFamilyReview({
    reviewToken: 'r'.repeat(32),
    decisions: [{
      occurrenceId: 'occurrence-1',
      action: 'new',
      repeatOfOccurrenceId: null,
      note: ''
    }],
    metadata: [{
      memberKey: 'root',
      license: 'CCLI',
      attribution: '',
      tags: ['congregational'],
      authors: ['A. Writer'],
      translators: [],
      composers: [],
      localServiceRights: {
        basis: 'ccli-service-license',
        evidence: 'CCLI service license and exact SongSelect entry reviewed.',
        scope: 'community-members',
        communityVisibility: 'public'
      },
      documentSource: 'forged'
    }],
    sourceConfirmed: true,
    rightsConfirmed: true,
    localCommitConfirmed: true,
    destinationPath: '/private/forged.md',
    communityVisibility: 'public'
  });

  assert.deepEqual(calls.map(call => call.channel), [
    'prepare:songs:beginCurrentServiceFamilyReview',
    'prepare:songs:commitCurrentServiceFamilyReview'
  ]);
  assert.equal(hasForbiddenAuthority(calls), false);
  assert.deepEqual(calls[0].payload.members[0], {
    memberKey: 'root',
    proposalToken: 'p'.repeat(32),
    songId: 'reviewed-family',
    title: 'Reviewed Family',
    language: 'en',
    lane: 'white',
    startSlide: 2,
    endSlide: 3,
    slideLanes: ['white', 'yellow'],
    candidateId: 'slides-1-2-3'
  });
  assert.deepEqual(calls[1].payload.metadata[0].localServiceRights, {
    basis: 'ccli-service-license',
    evidence: 'CCLI service license and exact SongSelect entry reviewed.'
  });
});

test('serialized main and preload envelopes preserve editable and stale renderer dispositions', async () => {
  const harness = loadFamilyHandlers();
  const renderer = rendererExports();
  const { api, calls } = loadPreloadBridge(async (channel, payload) => {
    const handler = harness.handlers.get(channel);
    assert.ok(handler, `Missing main handler for ${channel}`);
    return plain(await handler({ trusted: true }, payload));
  });
  const reviewed = renderer.checkedResult(
    await api.beginCurrentServiceSongFamilyReview(
      beginRequest(harness.addProposal())
    )
  );
  const editableRequest = commitRequest(reviewed);
  editableRequest.decisions[1] = {
    occurrenceId: reviewed.occurrences[1].occurrenceId,
    action: 'repeat',
    repeatOfOccurrenceId: reviewed.occurrences[0].occurrenceId,
    note: 'Operator-proposed repeat.'
  };
  const editableEnvelope =
    await api.commitCurrentServiceSongFamilyReview(editableRequest);
  assert.deepEqual(Object.keys(editableEnvelope).sort(), [
    'error',
    'success'
  ]);
  assert.equal(editableEnvelope.success, false);
  let editableError = null;
  assert.throws(
    () => renderer.checkedResult(editableEnvelope),
    error => {
      editableError = error;
      return error?.code === 'REPEAT_TEXT_MISMATCH';
    }
  );
  assert.deepEqual(
    plain(renderer.currentServiceSongFamilyFailureState(editableError)),
    {
      retryAction: 'edit',
      keepPendingRequest: false,
      stageTwoEditable: true,
      mustRestart: false
    }
  );
  assert.equal(
    harness.currentServiceSongFamilyReviews.has(reviewed.reviewToken),
    true
  );

  harness.changeSource();
  const staleEnvelope = await api.commitCurrentServiceSongFamilyReview(
    commitRequest(reviewed)
  );
  assert.equal(staleEnvelope.success, false);
  let staleError = null;
  assert.throws(
    () => renderer.checkedResult(staleEnvelope),
    error => {
      staleError = error;
      return error?.code === 'CURRENT_SERVICE_SONG_SOURCE_CHANGED';
    }
  );
  assert.deepEqual(
    plain(renderer.currentServiceSongFamilyFailureState(staleError)),
    {
      retryAction: 'restart',
      keepPendingRequest: false,
      stageTwoEditable: false,
      mustRestart: true
    }
  );
  assert.equal(
    harness.currentServiceSongFamilyReviews.has(reviewed.reviewToken),
    false
  );
  assert.deepEqual(calls.map(call => call.channel), [
    'prepare:songs:beginCurrentServiceFamilyReview',
    'prepare:songs:commitCurrentServiceFamilyReview',
    'prepare:songs:commitCurrentServiceFamilyReview'
  ]);
});

test('family IPC envelopes retain safe sender and storage codes without path leakage', async () => {
  const harness = loadFamilyHandlers();
  const rawBegin = harness.handlers.get(
    'prepare:songs:beginCurrentServiceFamilyReview'
  );
  const rawCommit = harness.handlers.get(
    'prepare:songs:commitCurrentServiceFamilyReview'
  );
  const proposalToken = harness.addProposal();
  const denied = plain(await rawBegin(
    { trusted: false },
    beginRequest(proposalToken)
  ));
  assert.deepEqual(denied, {
    success: false,
    error: {
      code: 'UNTRUSTED_SENDER',
      message: 'Untrusted sender.'
    }
  });
  assert.equal(
    harness.currentServiceSongDraftProposals.has(proposalToken),
    true
  );

  const reviewed = checkedFamilyIpcResult(await rawBegin(
    { trusted: true },
    beginRequest(proposalToken)
  ));
  harness.failNextCommit(
    'EACCES',
    'EACCES: permission denied, open /Users/operator/private-family.md'
  );
  const storageFailure = plain(await rawCommit(
    { trusted: true },
    commitRequest(reviewed)
  ));
  assert.deepEqual(storageFailure, {
    success: false,
    error: {
      code: 'EACCES',
      message:
        'The current-service song-family operation could not be completed.'
    }
  });
  assert.equal(hasForbiddenAuthority(storageFailure), false);
});

test('family IPC error envelopes redact every absolute local path form', async () => {
  const unsafeMessages = [
    'EACCES: open /etc/syncshow/private-family.md',
    'EACCES: open /root/.config/SyncShow/private-family.md',
    'EACCES: open /opt/syncshow/private-family.md',
    'EACCES:/etc/syncshow/private-family.md',
    String.raw`EACCES: open C:\SyncShow\private-family.md`,
    'EACCES: open C:/SyncShow/private-family.md',
    String.raw`EACCES: open \\server\church\private-family.md`,
    'EACCES: open //server/church/private-family.md',
    'EACCES: open file:///etc/syncshow/private-family.md',
    'EACCES: open file://server/church/private-family.md'
  ];
  for (const unsafeMessage of unsafeMessages) {
    const harness = loadFamilyHandlers();
    const begin = checkedFamilyHandler(harness.handlers.get(
      'prepare:songs:beginCurrentServiceFamilyReview'
    ));
    const rawCommit = harness.handlers.get(
      'prepare:songs:commitCurrentServiceFamilyReview'
    );
    const reviewed = await begin(
      { trusted: true },
      beginRequest(harness.addProposal())
    );
    harness.failNextCommit('EACCES', unsafeMessage);
    const failure = plain(await rawCommit(
      { trusted: true },
      commitRequest(reviewed)
    ));
    assert.equal(
      failure.error.message,
      'The current-service song-family operation could not be completed.',
      unsafeMessage
    );
  }

  const safeHarness = loadFamilyHandlers();
  const safeBegin = checkedFamilyHandler(safeHarness.handlers.get(
    'prepare:songs:beginCurrentServiceFamilyReview'
  ));
  const safeRawCommit = safeHarness.handlers.get(
    'prepare:songs:commitCurrentServiceFamilyReview'
  );
  const safeReview = await safeBegin(
    { trusted: true },
    beginRequest(safeHarness.addProposal())
  );
  const safeMessage =
    'The service root/translation check could not reach https://example.test/path.';
  safeHarness.failNextCommit('NETWORK_UNAVAILABLE', safeMessage);
  const safeFailure = plain(await safeRawCommit(
    { trusted: true },
    commitRequest(safeReview)
  ));
  assert.equal(safeFailure.error.message, safeMessage);
});

test('begin rejects an over-cap prospective family before holding a review token', async () => {
  const harness = loadFamilyHandlers();
  const rawBegin = harness.handlers.get(
    'prepare:songs:beginCurrentServiceFamilyReview'
  );
  harness.setCurrentDocuments([
    currentSong({
      id: 'reviewed-family',
      language: 'English'
    }),
    ...Array.from({ length: 31 }, (_value, index) =>
      currentSong({
        id: `reviewed-family-translation-${index + 1}`,
        language: `Language ${index + 1}`,
        translationOf: 'reviewed-family'
      }))
  ]);
  const rootProposal = harness.addProposal('english');
  const translationProposal = harness.addProposal('russian');
  const result = plain(await rawBegin(
    { trusted: true },
    {
      rootMemberKey: 'root',
      members: [{
        ...beginRequest(rootProposal).members[0]
      }, {
        memberKey: 'translation',
        proposalToken: translationProposal,
        songId: 'reviewed-family-new-translation',
        title: 'Reviewed translation',
        language: 'ru',
        lane: 'yellow',
        startSlide: 2,
        endSlide: 3,
        slideLanes: ['yellow', 'white'],
        candidateId: 'slides-1-2-3'
      }]
    }
  ));

  assert.equal(result.success, false);
  assert.equal(
    result.error.code,
    'CURRENT_SERVICE_SONG_FAMILY_MEMBER_LIMIT'
  );
  assert.equal(harness.currentServiceSongFamilyReviews.size, 0);
});

test('begin binds the fresh candidate and returns a bounded path-free review', async () => {
  const harness = loadFamilyHandlers();
  const begin = checkedFamilyHandler(harness.handlers.get(
    'prepare:songs:beginCurrentServiceFamilyReview'
  ));
  const proposalToken = harness.addProposal();
  const reviewed = await begin(
    { trusted: true },
    beginRequest(proposalToken)
  );

  assert.match(reviewed.reviewToken, /^[A-Za-z0-9_-]{32}$/);
  assert.equal(reviewed.family.members[0].familyRole, 'root');
  assert.equal(reviewed.family.members[0].saveDisposition, 'create');
  assert.equal(reviewed.family.members[0].currentIdentity, null);
  assert.deepEqual(reviewed.family.members[0].titleCardEvidence, {
    kind: 'template-local',
    slideNumber: 1,
    lines: [
      'English reviewed title',
      'English title-card credits'
    ]
  });
  assert.deepEqual(reviewed.family.members[0].metadata, {
    license: '',
    attribution: '',
    tags: [],
    authors: [],
    translators: [],
    composers: []
  });
  assert.deepEqual(reviewed.retainedTranslations, []);
  assert.equal(reviewed.occurrences.length, 2);
  assert.equal(reviewed.occurrences[0].members[0].slideNumber, 2);
  assert.deepEqual(
    reviewed.occurrences[0].members[0].lines,
    ['English exact line 2']
  );
  assert.equal(hasForbiddenAuthority(reviewed), false);
  assert.equal(
    harness.currentServiceSongDraftProposals.has(proposalToken),
    false
  );
  assert.equal(harness.sourceReads.length, 1);
});

test('main rejects malformed or oversized title-card evidence before review', async () => {
  for (const lines of [
    ['x'.repeat(1_001)],
    Array.from({ length: 33 }, () => 'x'.repeat(1_000))
  ]) {
    const harness = loadFamilyHandlers();
    harness.setTitleEvidenceLines(lines);
    const begin = checkedFamilyHandler(harness.handlers.get(
      'prepare:songs:beginCurrentServiceFamilyReview'
    ));
    await assert.rejects(
      begin(
        { trusted: true },
        beginRequest(harness.addProposal())
      ),
      error =>
        error.code === 'INVALID_CURRENT_SERVICE_SONG_INSPECTION'
        && !/\/private\/|\/Users\/|documentSource/u.test(error.message)
    );
  }
});

test('main pairs distinct source roles by ordinal while retaining actual slide numbers', async () => {
  const harness = loadFamilyHandlers();
  const begin = checkedFamilyHandler(harness.handlers.get(
    'prepare:songs:beginCurrentServiceFamilyReview'
  ));
  const commit = checkedFamilyHandler(harness.handlers.get(
    'prepare:songs:commitCurrentServiceFamilyReview'
  ));
  const rootProposal = harness.addProposal('english');
  const translationProposal = harness.addProposal('russian');
  const reviewed = await begin(
    { trusted: true },
    {
      rootMemberKey: 'root',
      members: [{
        ...beginRequest(rootProposal).members[0]
      }, {
        memberKey: 'translation',
        proposalToken: translationProposal,
        songId: 'reviewed-family-ru',
        title: 'Проверенная песня',
        language: 'ru',
        lane: 'yellow',
        startSlide: 1,
        endSlide: 2,
        slideLanes: ['yellow', 'white'],
        candidateId: null
      }]
    }
  );

  assert.deepEqual(
    plain(reviewed.family.members.map(member => member.source.roleId)),
    ['english', 'russian']
  );
  assert.equal(
    reviewed.family.members[1].titleCardEvidence.kind,
    'none'
  );
  assert.deepEqual(
    plain(reviewed.occurrences.map(occurrence =>
      occurrence.members.map(member => member.slideNumber))),
    [[2, 1], [3, 2]]
  );
  assert.deepEqual(
    harness.sourceReads.map(read => read.roleId),
    ['english', 'russian']
  );

  await commit({ trusted: true }, commitRequest(reviewed));
  assert.deepEqual(
    harness.sourceReads.map(read => read.roleId),
    ['english', 'russian', 'english', 'russian']
  );
  assert.deepEqual(
    harness.savedSnapshots[0].serviceSet.decks.map(deck => deck.roleId),
    ['english', 'russian']
  );
});

test('main treats identical deck bytes as one deck even across distinct roles', async () => {
  const harness = loadFamilyHandlers();
  harness.shareDeckHashAcrossRoles();
  const begin = checkedFamilyHandler(harness.handlers.get(
    'prepare:songs:beginCurrentServiceFamilyReview'
  ));
  const rootProposal = harness.addProposal('english');
  const translationProposal = harness.addProposal('russian');

  await assert.rejects(
    begin(
      { trusted: true },
      {
        rootMemberKey: 'root',
        members: [{
          ...beginRequest(rootProposal).members[0]
        }, {
          memberKey: 'translation',
          proposalToken: translationProposal,
          songId: 'reviewed-family-ru',
          title: 'Проверенная песня',
          language: 'ru',
          lane: 'yellow',
          startSlide: 1,
          endSlide: 2,
          slideLanes: ['yellow', 'white'],
          candidateId: null
        }]
      }
    ),
    error =>
      error?.code
      === 'CURRENT_SERVICE_SONG_FAMILY_SHARED_DECK_RANGE_MISMATCH'
  );
  assert.equal(harness.sourceReads.length, 0);
  assert.equal(
    harness.currentServiceSongDraftProposals.has(rootProposal),
    true
  );
  assert.equal(
    harness.currentServiceSongDraftProposals.has(translationProposal),
    true
  );
});

test('validation and confirmation failures keep review tokens retryable', async () => {
  const harness = loadFamilyHandlers();
  const begin = checkedFamilyHandler(harness.handlers.get(
    'prepare:songs:beginCurrentServiceFamilyReview'
  ));
  const commit = checkedFamilyHandler(harness.handlers.get(
    'prepare:songs:commitCurrentServiceFamilyReview'
  ));
  const reviewed = await begin(
    { trusted: true },
    beginRequest(harness.addProposal())
  );

  await assert.rejects(
    commit(
      { trusted: true },
      commitRequest(reviewed, { rightsConfirmed: false })
    ),
    error =>
      error.code ===
        'CURRENT_SERVICE_SONG_FAMILY_CONFIRMATION_REQUIRED'
  );
  assert.equal(
    harness.currentServiceSongFamilyReviews.has(reviewed.reviewToken),
    true
  );
  const invalidLocalServiceRights = structuredClone(commitRequest(reviewed));
  invalidLocalServiceRights.metadata[0].localServiceRights.basis =
    'ccli-songselect';
  await assert.rejects(
    commit({ trusted: true }, invalidLocalServiceRights),
    error => error.code === 'INVALID_LOCAL_SERVICE_SONG_RIGHTS'
  );
  assert.equal(
    harness.currentServiceSongFamilyReviews.has(reviewed.reviewToken),
    true
  );
  const blankLicense = structuredClone(commitRequest(reviewed));
  blankLicense.metadata[0].license = '';
  await assert.rejects(
    commit({ trusted: true }, blankLicense),
    error => error.code === 'MISSING_PREPARE_TEXT'
  );
  assert.equal(
    harness.currentServiceSongFamilyReviews.has(reviewed.reviewToken),
    true
  );
  const invalid = structuredClone(commitRequest(reviewed));
  invalid.decisions[0].action = 'repeat';
  invalid.decisions[0].repeatOfOccurrenceId = 'missing';
  await assert.rejects(
    commit({ trusted: true }, invalid),
    error => error.code === 'REPEAT_REFERENCE_NOT_PRIOR'
  );
  assert.equal(
    harness.currentServiceSongFamilyReviews.has(reviewed.reviewToken),
    true
  );
  assert.equal(harness.sourceReads.length, 1);
});

test('snapshot validation failures keep the review editable before durable intent is locked', async () => {
  const harness = loadFamilyHandlers();
  const begin = checkedFamilyHandler(harness.handlers.get(
    'prepare:songs:beginCurrentServiceFamilyReview'
  ));
  const commit = checkedFamilyHandler(harness.handlers.get(
    'prepare:songs:commitCurrentServiceFamilyReview'
  ));
  const reviewed = await begin(
    { trusted: true },
    beginRequest(harness.addProposal())
  );
  const original = commitRequest(reviewed);
  harness.failNextSnapshot();

  await assert.rejects(
    commit({ trusted: true }, original),
    error =>
      error?.code
      === 'CURRENT_SERVICE_SONG_FAMILY_STRUCTURE_MISMATCH'
  );
  const held = harness.currentServiceSongFamilyReviews.get(
    reviewed.reviewToken
  );
  assert.equal(held.intentHash, null);
  assert.equal(held.snapshot, null);

  const edited = commitRequest(reviewed, {
    decisions: original.decisions.map((decision, index) => ({
      ...decision,
      note: index === 0 ? 'Reviewed after correcting structure.' : decision.note
    }))
  });
  const result = await commit({ trusted: true }, edited);
  assert.equal(result.familyId, reviewed.family.rootSongId);
  assert.equal(
    harness.currentServiceSongFamilyReviews.has(reviewed.reviewToken),
    false
  );
});

test('durable snapshot rejection clears the pending intent instead of locking a futile retry', async () => {
  const harness = loadFamilyHandlers();
  const begin = checkedFamilyHandler(harness.handlers.get(
    'prepare:songs:beginCurrentServiceFamilyReview'
  ));
  const commit = checkedFamilyHandler(harness.handlers.get(
    'prepare:songs:commitCurrentServiceFamilyReview'
  ));
  const reviewed = await begin(
    { trusted: true },
    beginRequest(harness.addProposal())
  );
  const request = commitRequest(reviewed);
  harness.failNextReviewStore();

  await assert.rejects(
    commit({ trusted: true }, request),
    error => error.code === 'INVALID_REVIEW_SNAPSHOT'
  );
  const held = harness.currentServiceSongFamilyReviews.get(
    reviewed.reviewToken
  );
  assert.equal(held.intentHash, null);
  assert.equal(held.snapshot, null);
  assert.equal(held.snapshotHash, null);
});

test('commit revalidates ServiceSet bytes, saves strict evidence, and grants no Community authority', async () => {
  const harness = loadFamilyHandlers();
  const begin = checkedFamilyHandler(harness.handlers.get(
    'prepare:songs:beginCurrentServiceFamilyReview'
  ));
  const commit = checkedFamilyHandler(harness.handlers.get(
    'prepare:songs:commitCurrentServiceFamilyReview'
  ));
  const reviewed = await begin(
    { trusted: true },
    beginRequest(harness.addProposal())
  );
  const result = await commit(
    { trusted: true },
    commitRequest(reviewed)
  );

  assert.equal(harness.sourceReads.length, 2);
  assert.equal(harness.savedSnapshots.length, 1);
  assert.equal(harness.commitCalls.length, 1);
  assert.equal(
    harness.savedSnapshots[0].family.occurrences[0].evidence[0].slideNumber,
    2
  );
  assert.deepEqual(
    plain(harness.savedSnapshots[0].confirmations),
    {
      sourceConfirmed: true,
      rightsConfirmed: true,
      localCommitConfirmed: true,
      authorityScope: 'local-song-library-only',
      communityAuthorityGranted: false
    }
  );
  assert.deepEqual(
    plain(
      harness.savedSnapshots[0].family.members[0].localServiceRights
    ),
    {
      scope: 'local-service-song-intake',
      basis: 'ccli-service-license',
      evidence: 'CCLI service license and exact SongSelect entry reviewed.',
      reviewedAt: harness.savedSnapshots[0].reviewedAt
    }
  );
  assert.deepEqual(Object.keys(result).sort(), [
    'familyId',
    'familyRevision',
    'members',
    'recovered',
    'unchanged'
  ]);
  assert.match(result.familyRevision, /^[a-f0-9]{64}$/);
  assert.equal(result.members[0].action, 'create');
  assert.equal(hasForbiddenAuthority(result), false);
  assert.equal(
    harness.currentServiceSongFamilyReviews.has(reviewed.reviewToken),
    false
  );
});

test('a transient durable failure keeps the same snapshot retryable and rejects changed intent', async () => {
  const harness = loadFamilyHandlers();
  const begin = checkedFamilyHandler(harness.handlers.get(
    'prepare:songs:beginCurrentServiceFamilyReview'
  ));
  const commit = checkedFamilyHandler(harness.handlers.get(
    'prepare:songs:commitCurrentServiceFamilyReview'
  ));
  const reviewed = await begin(
    { trusted: true },
    beginRequest(harness.addProposal())
  );
  const request = commitRequest(reviewed);
  harness.failNextCommit();
  await assert.rejects(
    commit({ trusted: true }, request),
    error => error.code === 'WRITE_LOCKED'
  );
  assert.equal(
    harness.currentServiceSongFamilyReviews.has(reviewed.reviewToken),
    true
  );
  const changed = structuredClone(request);
  changed.metadata[0].localServiceRights.evidence =
    'A different local-service license review.';
  await assert.rejects(
    commit({ trusted: true }, changed),
    error =>
      error.code === 'CURRENT_SERVICE_SONG_FAMILY_RETRY_MISMATCH'
  );
  const retried = await commit({ trusted: true }, request);
  assert.equal(retried.recovered, true);
  assert.equal(retried.unchanged, true);
  assert.equal(harness.savedSnapshots.length, 2);
  assert.equal(
    harness.savedSnapshots[0].reviewedAt,
    harness.savedSnapshots[1].reviewedAt
  );
});

test('changed service binding or source bytes consume a stale review before commit', async () => {
  const bindingHarness = loadFamilyHandlers();
  const bindingBegin = checkedFamilyHandler(bindingHarness.handlers.get(
    'prepare:songs:beginCurrentServiceFamilyReview'
  ));
  const bindingCommit = checkedFamilyHandler(bindingHarness.handlers.get(
    'prepare:songs:commitCurrentServiceFamilyReview'
  ));
  const bindingReview = await bindingBegin(
    { trusted: true },
    beginRequest(bindingHarness.addProposal())
  );
  bindingHarness.changeBinding();
  await assert.rejects(
    bindingCommit(
      { trusted: true },
      commitRequest(bindingReview)
    ),
    error => error.code === 'CURRENT_SERVICE_SONG_SET_CHANGED'
  );
  assert.equal(
    bindingHarness.currentServiceSongFamilyReviews.has(
      bindingReview.reviewToken
    ),
    false
  );

  const sourceHarness = loadFamilyHandlers();
  const sourceBegin = checkedFamilyHandler(sourceHarness.handlers.get(
    'prepare:songs:beginCurrentServiceFamilyReview'
  ));
  const sourceCommit = checkedFamilyHandler(sourceHarness.handlers.get(
    'prepare:songs:commitCurrentServiceFamilyReview'
  ));
  const sourceReview = await sourceBegin(
    { trusted: true },
    beginRequest(sourceHarness.addProposal())
  );
  sourceHarness.changeSource();
  await assert.rejects(
    sourceCommit(
      { trusted: true },
      commitRequest(sourceReview)
    ),
    error => error.code === 'CURRENT_SERVICE_SONG_SOURCE_CHANGED'
  );
  assert.equal(
    sourceHarness.currentServiceSongFamilyReviews.has(
      sourceReview.reviewToken
    ),
    false
  );
});

test('main family contract is bounded, sender-guarded, and has no Community publication call', () => {
  const familySource = sourceBetween(
    mainSource,
    'function currentServiceSongFamilyMemberRequest',
    "ipcMain.handle('prepare:projects:list'"
  );
  assert.match(
    mainSource,
    /CURRENT_SERVICE_SONG_FAMILY_REVIEW_LIMIT = 12/
  );
  assert.match(
    mainSource,
    /CURRENT_SERVICE_SONG_FAMILY_REVIEW_TTL_MS = 15 \* 60 \* 1000/
  );
  for (const channel of [
    'prepare:songs:beginCurrentServiceFamilyReview',
    'prepare:songs:commitCurrentServiceFamilyReview'
  ]) {
    const start = familySource.indexOf(`'${channel}'`);
    assert.notEqual(start, -1);
    assert.match(
      familySource.slice(start, start + 500),
      /requireControlSender\(event\)/
    );
  }
  assert.doesNotMatch(
    familySource,
    /scheduleCommunitySongSync|runCommunitySongSync|communitySongSync|request\.(?:pinnedPath|sourcePath|destinationPath|deckSha256|documentSource)/
  );
  assert.match(
    familySource,
    /readCurrentServiceSongSource\(\s*context,\s*member\.source\.roleId/
  );
  assert.match(
    familySource,
    /localSongFamilyCommitCoordinator\.commit\(\{/
  );
});
