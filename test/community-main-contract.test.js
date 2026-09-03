'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const mainSource = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
const preloadSource = fs.readFileSync(path.join(root, 'preload.js'), 'utf8');

function functionBlock(source, name) {
  const start = source.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `expected function ${name}`);
  const parameters = source.indexOf('(', start);
  let parameterDepth = 0;
  let bodyStart = -1;
  for (let index = parameters; index < source.length; index += 1) {
    if (source[index] === '(') parameterDepth += 1;
    if (source[index] === ')') {
      parameterDepth -= 1;
      if (parameterDepth === 0) {
        bodyStart = source.indexOf('{', index);
        break;
      }
    }
  }
  assert.notEqual(bodyStart, -1, `expected body for function ${name}`);
  let depth = 0;
  for (let index = bodyStart; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1;
    if (source[index] === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(start, index + 1);
    }
  }
  throw new Error(`unterminated function ${name}`);
}

function mainSermonProjectionExports() {
  const source = `
    'use strict';
    const communitySermonPublicationVersions = new Map();
    const COMMUNITY_SERMON_PUBLICATION_VERSION_LIMIT = 1000;
    ${functionBlock(mainSource, 'emptyPublicCommunitySermonPublication')}
    ${functionBlock(mainSource, 'publicCommunitySermonPublicationState')}
    ${functionBlock(mainSource, 'observeCommunitySermonPublicationVersion')}
    ${functionBlock(mainSource, 'publicCommunitySermonState')}
    globalThis.projections = {
      observeCommunitySermonPublicationVersion,
      publicCommunitySermonPublicationState,
      publicCommunitySermonState
    };
  `;
  const context = {};
  vm.runInNewContext(source, context, {
    filename: 'community-main-sermon-projections.js'
  });
  return context.projections;
}

function mainSermonVerificationProjectionExport() {
  const source = `
    'use strict';
    function failMainOperation(code, message) {
      const error = new Error(message);
      error.code = code;
      throw error;
    }
    ${functionBlock(
      mainSource,
      'publicCommunitySermonPublicationVerification'
    )}
    globalThis.projectVerification =
      publicCommunitySermonPublicationVerification;
  `;
  const context = {};
  vm.runInNewContext(source, context, {
    filename: 'community-main-sermon-verification-projection.js'
  });
  return context.projectVerification;
}

const channels = [
  'community:status',
  'community:connectStart',
  'community:connectPoll',
  'community:connectCancel',
  'community:connectOpenApproval',
  'community:connectCopyCode',
  'community:disconnect',
  'community:songs:sync',
  'community:sermons:sync',
  'community:sermons:getState',
  'community:sermons:openPublicationManager',
  'community:sermons:verifyPublication',
  'community:sermons:getConflict',
  'community:sermons:resolveConflict',
  'community:sermons:push',
  'community:songs:getState',
  'community:songs:listPublicLinks',
  'community:songs:beginPublicLinkReview',
  'community:songs:createPublicLink',
  'community:songs:copyPublicLink',
  'community:songs:revokePublicLink',
  'community:songs:getConflict',
  'community:songs:resolveConflict',
  'community:songs:beginSharingReview',
  'community:songs:applySharingReview',
  'community:songs:setVisibility'
];

test('every Community operation is restricted to the exact control main frame', () => {
  for (const channel of channels) {
    const start = mainSource.indexOf(`ipcMain.handle('${channel}'`);
    assert.notEqual(start, -1, `${channel} must be implemented`);
    assert.match(
      mainSource.slice(start, start + 220),
      /requireControlSender\(event\)/,
      `${channel} must reject non-control senders`
    );
  }
});

test('the preload exposes semantic Community actions without credential fields', () => {
  for (const method of [
    'getCommunityStatus',
    'startCommunityConnection',
    'pollCommunityConnection',
    'cancelCommunityConnection',
    'openCommunityApproval',
    'copyCommunityApprovalCode',
    'disconnectCommunity',
    'syncCommunitySongs',
    'syncCommunitySermons',
    'getCommunitySermonState',
    'openCommunitySermonPublicationManager',
    'verifyCommunitySermonPublication',
    'getCommunitySermonConflict',
    'resolveCommunitySermonConflict',
    'pushCommunitySermon',
    'getCommunitySongState',
    'listCommunitySongPublicLinks',
    'beginCommunitySongPublicLinkReview',
    'createCommunitySongPublicLink',
    'copyCommunitySongPublicLink',
    'revokeCommunitySongPublicLink',
    'getCommunitySongConflict',
    'resolveCommunitySongConflict',
    'beginCommunitySongSharingReview',
    'applyCommunitySongSharingReview',
    'setCommunitySongVisibility',
    'onCommunityStatus'
  ]) {
    assert.match(preloadSource, new RegExp(`${method}:`), `${method} must be bridged`);
  }
  const start = preloadSource.indexOf('// Heritage Community library integration');
  const end = preloadSource.indexOf('// Coherent service-folder discovery', start);
  const bridge = preloadSource.slice(start, end);
  assert.doesNotMatch(bridge, /accessToken|refreshToken|deviceSecret|codeVerifier|clientSecret/);
  assert.doesNotMatch(bridge, /documentSource|remoteDocumentSource|sourceObjects/);
  assert.doesNotMatch(bridge, /\bpassword\b/i);
});

test('song sharing review uses an opaque proposal and main-owned family guards', () => {
  const beginStart = mainSource.indexOf(
    "ipcMain.handle('community:songs:beginSharingReview'"
  );
  const applyStart = mainSource.indexOf(
    "ipcMain.handle('community:songs:applySharingReview'",
    beginStart
  );
  const visibilityStart = mainSource.indexOf(
    "ipcMain.handle('community:songs:setVisibility'",
    applyStart
  );
  assert.ok(beginStart >= 0 && applyStart > beginStart && visibilityStart > applyStart);
  const begin = mainSource.slice(beginStart, applyStart);
  const apply = mainSource.slice(applyStart, visibilityStart);
  const restrict = mainSource.slice(
    visibilityStart,
    mainSource.indexOf("ipcMain.handle('prepare:songs:list'", visibilityStart)
  );

  assert.match(begin, /const local = await resolveCommunitySongFamily\(songId\)/);
  assert.match(
    begin,
    /holdSongSharingReviewProposal\(\{\s*connectionId: connection\.id,\s*songId: local\.songId,\s*familyId: local\.familyId,\s*familyRevision: local\.familyRevision,\s*expectedSyncVersion: song\?\.syncVersion \?\? null,\s*expectedReviewRevision: songSharingReviewRevision\(review\),\s*expectedPendingVisibility: communityPendingVisibilitySnapshot\(\s*song\?\.pendingVisibility\s*\)\s*\}\)/s
  );
  assert.match(begin, /proposalToken/);
  assert.match(begin, /family:\s*\{\s*\.\.\.local\.family/s);

  assert.match(
    apply,
    /requireSongSharingReviewProposal\(\s*request\.proposalToken\s*\)/
  );
  assert.match(apply, /const local = await resolveCommunitySongFamily\(entry\.songId\)/);
  assert.match(
    apply,
    /local\.familyId !== entry\.familyId\s*\|\|\s*local\.familyRevision !== entry\.familyRevision/
  );
  assert.match(apply, /expectedSyncVersion: entry\.expectedSyncVersion/);
  assert.match(apply, /expectedFamilyRevision: entry\.familyRevision/);
  assert.match(apply, /expectedReviewRevision: entry\.expectedReviewRevision/);
  assert.match(
    apply,
    /songSharingReviewRevision\(currentReview\)\s*!== entry\.expectedReviewRevision/
  );
  assert.match(
    apply,
    /sameCommunityPendingVisibility\(\s*entry\.expectedPendingVisibility,\s*currentSong\?\.pendingVisibility\s*\)/
  );
  assert.match(apply, /songState\.archived/);
  assert.match(apply, /songState\.pendingVisibility !== null/);
  assert.match(apply, /songState\.exists !== true/);
  assert.match(apply, /songState\.confirmedVisibility !== visibility/);
  assert.match(apply, /songState\.confirmedPublishAt/);
  assert.match(apply, /songState\.conflict \|\| summary\.conflicts > 0/);
  assert.match(apply, /COMMUNITY_VISIBILITY_NOT_APPLIED/);
  assert.match(apply, /!Number\.isFinite\(Date\.parse\(publishAt\)\)/);
  assert.doesNotMatch(
    apply,
    /Date\.parse\(publishAt\) <= Date\.now\(\)/,
    'the workstation may validate timestamp syntax but Community decides the schedule boundary'
  );
  assert.match(apply, /songState\.memberSharing\?\.songSyncVersion/);
  assert.match(apply, /songState\.effectiveVisibility === null/);
  assert.match(apply, /createSongSharingReview\(/);
  assert.match(
    apply,
    /if \(currentSong\?\.conflict\)[\s\S]*confirmSongSharingReview\([\s\S]*familyRevision: local\.familyRevision[\s\S]*reviewOnly: true/,
    'a conflict may record the exact-family review without overwriting either copy'
  );
  assert.match(apply, /songSharingReviewProposals\.delete\(proposalToken\)/);
  assert.doesNotMatch(
    apply,
    /request\.(?:songId|familyRevision|reviewedAt|expectedSyncVersion)/,
    'the renderer may provide review intent, never canonical identity, revision, time, or CAS authority'
  );
  assert.match(restrict, /songState\.pendingVisibility !== null/);
  assert.match(restrict, /songState\.confirmedVisibility !== 'private'/);
  assert.match(restrict, /songState\.confirmedPublishAt !== null/);
  assert.match(mainSource, /Object\.hasOwn\(song\.documents \|\| \{\}, songId\)/);

  const beginBridgeStart = preloadSource.indexOf('beginCommunitySongSharingReview:');
  const applyBridgeStart = preloadSource.indexOf(
    'applyCommunitySongSharingReview:',
    beginBridgeStart
  );
  const visibilityBridgeStart = preloadSource.indexOf(
    'setCommunitySongVisibility:',
    applyBridgeStart
  );
  assert.ok(
    beginBridgeStart >= 0
      && applyBridgeStart > beginBridgeStart
      && visibilityBridgeStart > applyBridgeStart
  );
  const beginBridge = preloadSource.slice(beginBridgeStart, applyBridgeStart);
  const applyBridge = preloadSource.slice(applyBridgeStart, visibilityBridgeStart);
  assert.match(beginBridge, /songId: request\?\.songId/);
  for (const field of [
    'proposalToken',
    'visibility',
    'publishAt',
    'basis',
    'evidence',
    'validUntil',
    'confirmed'
  ]) {
    assert.match(
      applyBridge,
      new RegExp(`${field}: request\\?\\.${field}`),
      `${field} must be the explicit review intent bridged to main`
    );
  }
  assert.doesNotMatch(
    applyBridge,
    /\b(?:songId|familyId|familyRevision|reviewedAt|expectedSyncVersion)\s*:/,
    'the apply bridge must remain an opaque proposal plus operator-entered intent'
  );

  const holdProposal = functionBlock(mainSource, 'holdSongSharingReviewProposal');
  const requireProposal = functionBlock(mainSource, 'requireSongSharingReviewProposal');
  assert.match(
    holdProposal,
    /pruneSongSharingReviewProposals\(Date\.now\(\), \{ makeRoom: true \}\)/
  );
  assert.match(requireProposal, /pruneSongSharingReviewProposals\(\)/);
  assert.doesNotMatch(
    requireProposal,
    /makeRoom/,
    'opening the maximum number of proposals must not evict a token merely because it is being applied'
  );
});

test('public status and song/sermon projections omit credentials and preserved remote sources', () => {
  const connectionProjection = functionBlock(mainSource, 'publicCommunityConnection');
  const songProjection = functionBlock(mainSource, 'publicCommunitySongState');
  const songStatePayload = functionBlock(mainSource, 'communitySongStatePayload');
  const sermonProjection = functionBlock(mainSource, 'publicCommunitySermonState');
  const sermonPublicationProjection = functionBlock(
    mainSource,
    'publicCommunitySermonPublicationState'
  );
  const sermonStatePayload = functionBlock(mainSource, 'communitySermonStatePayload');
  const sermonConflictProjection = functionBlock(
    mainSource,
    'publicCommunitySermonConflictCopy'
  );
  for (const source of [
    connectionProjection,
    songProjection,
    sermonProjection,
    sermonPublicationProjection
  ]) {
    assert.doesNotMatch(source, /accessToken|refreshToken|deviceSecret|codeVerifier|apiBaseUrl/);
  }
  assert.doesNotMatch(songProjection, /remoteDocuments|documentSource|\bsource:/);
  assert.match(songProjection, /confirmedVisibility: song\?\.visibility/);
  assert.match(songProjection, /confirmedPublishAt: song\?\.publishAt/);
  assert.match(songProjection, /canReadSongs/);
  assert.match(songStatePayload, /if \(!activeConnection\.canReadSongs\)/);
  assert.ok(
    songStatePayload.indexOf('if (!activeConnection.canReadSongs)')
      < songStatePayload.indexOf('stateStore.getConnectionState(activeConnection.id)'),
    'cached song state must remain behind the effective song-read lane'
  );
  assert.match(
    songStatePayload,
    /publicCommunitySongState\(null, activeConnection,[\s\S]*family: local\.family/
  );
  assert.match(sermonStatePayload, /if \(!connection\.canReadSermons\)/);
  assert.ok(
    sermonStatePayload.indexOf('if (!connection.canReadSermons)')
      < sermonStatePayload.indexOf('stateStore.getSermonState(connection.id, sermonId)'),
    'cached sermon state must remain behind the effective sermon-read lane'
  );
  assert.match(
    sermonStatePayload,
    /publicCommunitySermonState\(null, connection,[\s\S]*currentLocalRevision/
  );
  assert.doesNotMatch(
    sermonProjection,
    /remoteDocumentSource|documentSource|sourceObjects|\bsource:/
  );
  assert.doesNotMatch(
    sermonConflictProjection,
    /remoteDocumentSource|documentSource|sourceObjects|fileName|provenance|\bsource:/
  );
  assert.match(connectionProjection, /canReadSongs/);
  assert.match(connectionProjection, /canWriteSongs/);
  assert.match(connectionProjection, /canReadSermons/);
  assert.match(connectionProjection, /canWriteSermons/);
  assert.match(connectionProjection, /canReadSermonPublications/);
  assert.match(sermonProjection, /canReadSermons/);
  assert.match(sermonProjection, /canWriteSermons/);
  assert.match(sermonProjection, /canReadSermonPublications/);
  assert.match(sermonProjection, /publicationState\?\.status/);
  assert.match(sermonProjection, /'remote-only'/);
  assert.match(sermonProjection, /missingBaseline/);
  assert.match(sermonProjection, /'needs-review'/);
  for (const status of [
    'unsupported',
    'unavailable',
    'never-published',
    'withdrawn',
    'published-current',
    'published-older'
  ]) {
    assert.match(
      `${sermonProjection}\n${sermonPublicationProjection}`,
      new RegExp(status)
    );
  }
  for (const field of ['publicId', 'publishedAt', 'publicationVersion']) {
    assert.match(sermonProjection, new RegExp(field));
  }
  assert.doesNotMatch(
    sermonPublicationProjection,
    /accessToken|documentSource|sourceObjects|selectedBodyEntryIds|selectedMediaIds|detailChecksum|catalogChecksum|passageIndexChecksum/
  );
});

test('sermon publication status is an isolated read-only lane with monotonic guards', () => {
  const payload = functionBlock(mainSource, 'communitySermonStatePayload');
  const observeVersion = functionBlock(
    mainSource,
    'observeCommunitySermonPublicationVersion'
  );
  const projection = functionBlock(
    mainSource,
    'publicCommunitySermonPublicationState'
  );
  const capabilityGuard = payload.indexOf(
    'if (connection.canReadSermonPublications)'
  );
  const publicationRead = payload.indexOf('.getSermonPublication({');
  assert.ok(capabilityGuard >= 0 && publicationRead > capabilityGuard);
  assert.match(
    payload,
    /const sermon = await stateStore\.getSermonState\(connection\.id, sermonId\)[\s\S]*connectionStore\.getConnection\(connection\.id\)[\s\S]*accessToken: current\.accessToken/
  );
  assert.match(payload, /expectedSermonId: sermonId/);
  assert.match(payload, /requireCommunityReconnectFor\(error\)/);
  assert.match(
    payload,
    /malformed[\s\S]*retryable response must not erase the useful local sync result/
  );
  assert.ok(
    payload.indexOf('const sermon = await stateStore.getSermonState')
      < payload.indexOf('try {', capabilityGuard),
    'publication-read failure must not replace the already loaded sync state'
  );
  assert.match(
    payload,
    /publication\.syncVersion === savedSyncVersion[\s\S]*publication\.currentRevision !== sermon\.remoteRevision/
  );
  assert.match(
    payload,
    /publication\.syncVersion < savedSyncVersion/
  );
  assert.match(
    payload,
    /publication\.syncVersion > savedSyncVersion/
  );
  assert.match(payload, /remoteStateAhead/);
  assert.match(
    observeVersion,
    /publicationVersion < previous[\s\S]*return false/
  );
  assert.match(
    observeVersion,
    /COMMUNITY_SERMON_PUBLICATION_VERSION_LIMIT/
  );
  assert.doesNotMatch(
    `${payload}\n${projection}`,
    /selectedBodyEntryIds|selectedMediaIds|detailChecksum|catalogChecksum|passageIndexChecksum|documentSource|sourceObjects/
  );
  assert.doesNotMatch(
    mainSource,
    /ipcMain\.handle\('community:sermons:(?:publish|withdraw)'/,
    'Prepare may read publication state but must not mutate it'
  );

  const handlerStart = mainSource.indexOf(
    "ipcMain.handle('community:sermons:getState'"
  );
  const handlerEnd = mainSource.indexOf(
    "ipcMain.handle('community:sermons:openPublicationManager'",
    handlerStart
  );
  const handler = mainSource.slice(handlerStart, handlerEnd);
  assert.match(handler, /requireControlSender\(event\)/);
  assert.match(
    handler,
    /communityRequestKeys\(\s*request,\s*\['sermonId'\],\s*'Sermon state request'\s*\)/s
  );
  assert.match(
    handler,
    /prepareSermonDomainId\(request\.sermonId, 'Sermon'\)/
  );
  assert.match(
    handler,
    /communitySermonStatePayload\(sermonId\)/
  );
  assert.doesNotMatch(
    handler,
    /serializeCommunityOperation|runCommunitySermonPush|publishCommunitySermon|withdrawCommunitySermon/
  );
});

test('live sermon verification stays main-owned and returns only bounded evidence', () => {
  const verificationPayload = functionBlock(
    mainSource,
    'communitySermonPublicationVerificationPayload'
  );
  const projection = functionBlock(
    mainSource,
    'publicCommunitySermonPublicationVerification'
  );
  assert.match(
    verificationPayload,
    /verifyDeployedCommunitySermonPublication\(\{[\s\S]*localLibrary:[\s\S]*syncId: sermonId,[\s\S]*accessToken: current\.accessToken/
  );
  assert.match(
    verificationPayload,
    /publication\.syncVersion < savedSyncVersion/
  );
  assert.match(
    verificationPayload,
    /publication\.currentRevision !== saved\.remoteRevision/
  );
  assert.match(
    verificationPayload,
    /observeCommunitySermonPublicationVersion/
  );
  assert.match(
    verificationPayload,
    /publicCommunitySermonPublicationVerification\(result\)/
  );
  assert.doesNotMatch(
    projection,
    /accessToken|documentSource|sourceObjects|selectedBodyEntryIds|selectedMediaIds|detailChecksum|catalogChecksum|passageIndexChecksum|publicRevision|currentRevision/
  );

  const project = mainSermonVerificationProjectionExport();
  const exact = {
    summary: {
      status: 'verified-older',
      publicId: 'sermon-live',
      publishedAt: '2026-07-28T20:00:00.000Z',
      publicationVersion: 4,
      bodyEntryCount: 1,
      mediaCount: 1,
      primaryReferenceCount: 1,
      mentionedReferenceCount: 3
    }
  };
  assert.deepEqual(
    JSON.parse(JSON.stringify(project(exact))),
    exact.summary
  );
  assert.throws(
    () => project({
      summary: {
        ...exact.summary,
        detailChecksum: 'a'.repeat(64)
      }
    }),
    error => error.code === 'SERMON_PUBLICATION_VERIFICATION_INVALID'
  );

  const handlerStart = mainSource.indexOf(
    "ipcMain.handle('community:sermons:verifyPublication'"
  );
  const handlerEnd = mainSource.indexOf(
    "ipcMain.handle('community:sermons:getConflict'",
    handlerStart
  );
  const handler = mainSource.slice(handlerStart, handlerEnd);
  assert.match(handler, /requireControlSender\(event\)/);
  assert.match(handler, /communityRequestKeys\(\s*request,\s*\['sermonId'\]/s);
  assert.match(
    handler,
    /communitySermonPublicationVerificationPayload\(sermonId\)/
  );
  assert.doesNotMatch(
    handler,
    /accessToken|documentSource|detailChecksum|catalogChecksum|passageIndexChecksum/
  );

  const bridgeStart = preloadSource.indexOf(
    'verifyCommunitySermonPublication:'
  );
  const bridgeEnd = preloadSource.indexOf(
    'getCommunitySermonConflict:',
    bridgeStart
  );
  const bridge = preloadSource.slice(bridgeStart, bridgeEnd);
  assert.match(bridge, /sermonId: request\?\.sermonId/);
  assert.doesNotMatch(
    bridge,
    /accessToken|publicRevision|documentSource|detailChecksum|catalogChecksum|passageIndexChecksum/
  );
});

test('main publication projection distinguishes live pointers and rejects rollback', () => {
  const {
    observeCommunitySermonPublicationVersion,
    publicCommunitySermonPublicationState,
    publicCommunitySermonState
  } = mainSermonProjectionExports();
  const currentRevision = 'a'.repeat(64);
  const base = {
    syncId: 'sermon-one',
    currentRevision,
    syncVersion: 7,
    publicationVersion: 4,
    publicRevision: currentRevision,
    publicId: 'sermon-one',
    publishedAt: '2026-07-27T20:00:00.000Z',
    selectedBodyEntryIds: ['private-body'],
    detailChecksum: 'b'.repeat(64)
  };
  const current = publicCommunitySermonPublicationState(base, {
    expectedSermonId: 'sermon-one',
    unavailableStatus: 'unavailable'
  });
  assert.equal(current.status, 'published-current');
  assert.deepEqual(
    Array.from(Object.keys(current)),
    ['status', 'publicId', 'publishedAt', 'publicationVersion']
  );
  assert.equal(
    publicCommunitySermonPublicationState({
      ...base,
      publicRevision: 'c'.repeat(64)
    }, {
      expectedSermonId: 'sermon-one'
    }).status,
    'published-older'
  );
  assert.equal(
    publicCommunitySermonPublicationState({
      ...base,
      syncId: 'different-sermon'
    }, {
      expectedSermonId: 'sermon-one'
    }).status,
    'unavailable'
  );

  assert.equal(observeCommunitySermonPublicationVersion({
    connectionId: 'connection-one',
    sermonId: 'sermon-one',
    publicationVersion: null
  }), true);
  assert.equal(observeCommunitySermonPublicationVersion({
    connectionId: 'connection-one',
    sermonId: 'sermon-one',
    publicationVersion: null
  }), true);
  assert.equal(observeCommunitySermonPublicationVersion({
    connectionId: 'connection-one',
    sermonId: 'sermon-one',
    publicationVersion: 4
  }), true);
  assert.equal(observeCommunitySermonPublicationVersion({
    connectionId: 'connection-one',
    sermonId: 'sermon-one',
    publicationVersion: 3
  }), false);

  const saved = {
    syncId: 'sermon-one',
    syncVersion: 7,
    localRevision: currentRevision,
    remoteRevision: currentRevision,
    lastSyncedAt: '2026-07-27T19:00:00.000Z',
    conflict: null
  };
  const connection = {
    canReadSermons: true,
    canWriteSermons: true,
    canReadSermonPublications: true
  };
  assert.equal(publicCommunitySermonState(saved, connection, {
    sermonId: 'sermon-one',
    currentLocalRevision: currentRevision,
    publicationState: current
  }).status, 'synced');
  assert.equal(publicCommunitySermonState(saved, connection, {
    sermonId: 'sermon-one',
    currentLocalRevision: currentRevision,
    publicationState: current,
    remoteStateAhead: true
  }).status, 'needs-review');
});

test('device approval keeps private grant material in main while providing a recovery path', () => {
  const pollStart = mainSource.indexOf("ipcMain.handle('community:connectPoll'");
  const pollEnd = mainSource.indexOf("ipcMain.handle('community:connectCancel'", pollStart);
  const poll = mainSource.slice(pollStart, pollEnd);
  assert.match(poll, /const grant = result\.grant/);
  assert.match(poll, /connectionStore\.saveConnection/);
  assert.match(poll, /return communityStatusPayload\(\)/);
  assert.doesNotMatch(poll, /return\s+\{[^}]*grant/s);

  assert.match(mainSource, /verificationUri: authorization\.verificationUri/);
  assert.match(mainSource, /userCode: authorization\.userCode/);
  assert.match(mainSource, /shell\.openExternal\(pending\.verificationUri\)/);
  assert.match(mainSource, /clipboard\.writeText\(pending\.userCode\)/);
});

test('sync is offline-first, CAS-guarded, cancellable, and conflict-resolvable', () => {
  const songSync = functionBlock(mainSource, 'runCommunitySongSync');
  const familyRecovery = functionBlock(
    mainSource,
    'recoverLocalSongFamilyCommit'
  );
  const songResolveStart = mainSource.indexOf(
    "ipcMain.handle('community:songs:resolveConflict'"
  );
  const songResolve = mainSource.slice(
    songResolveStart,
    mainSource.indexOf(
      "ipcMain.handle('community:songs:beginSharingReview'",
      songResolveStart
    )
  );
  assert.match(mainSource, /new CommunityConnectionStore\(\{[\s\S]*maximumConnections: 1/);
  assert.match(mainSource, /new CommunitySyncStateStore/);
  assert.match(mainSource, /new CommunitySongSync/);
  assert.match(mainSource, /new CommunitySongFamilyImportCoordinator/);
  assert.match(
    mainSource,
    /familyImportCoordinator:\s*getPrepareServices\(\)\.communitySongFamilyImportCoordinator/
  );
  assert.match(mainSource, /new CommunitySermonSync/);
  assert.match(mainSource, /communitySyncAbortController\?\.abort\(\)/);
  assert.match(mainSource, /communityAuthAbortController\?\.abort\(\)/);
  assert.match(mainSource, /client\.discover\(\{ signal: controller\.signal \}\)/);
  assert.match(mainSource, /pollDeviceAuthorization\(authorizationId, \{\s*signal: controller\.signal/s);
  assert.match(mainSource, /expectedSyncVersion: expectedSyncVersion \?\? null/);
  assert.match(mainSource, /sync\.resolveConflict\(conflict\.syncId/);
  assert.match(mainSource, /strategy,\s*expectedSyncVersion:/s);
  assert.match(mainSource, /scheduleCommunitySongSync\('local song saved'/);
  assert.match(mainSource, /augmentSongLibraryWithCommunity\(listing\)/);
  assert.match(
    songSync,
    /allowWrites: allowWrites && connection\.canWriteSongs === true/,
    'only an explicit reviewed operation may enter the remote write phase'
  );
  assert.match(
    songSync,
    /allowWrites = false/,
    'ordinary and background Community refreshes must default to pull-only'
  );
  assert.match(
    songResolve,
    /strategy === 'keep-local' && !connection\?\.canWriteSongs/
  );
  assert.match(
    songResolve,
    /strategy === 'keep-remote' && !connection\?\.canReadSongs/
  );
  assert.ok(
    familyRecovery.indexOf('communitySongFamilyImportCoordinator.recover()')
      < familyRecovery.indexOf('localSongFamilyCommitCoordinator.recover()'),
    'the shared journal must dispatch Community authority before reviewed-family recovery'
  );
  assert.match(
    familyRecovery,
    /if \(communityRecovery\.handled\) return communityRecovery/
  );
});

test('device approval requests exactly the independently advertised resource lanes', () => {
  const scopes = functionBlock(mainSource, 'communityAuthorizationScopes');
  assert.match(scopes, /Array\.isArray\(discovery\?\.scopes\)/);
  assert.match(scopes, /new Set\(discovery\.scopes\)/);
  assert.doesNotMatch(scopes, /resources|songScopes|syncshow:/);

  const connectStart = mainSource.slice(
    mainSource.indexOf("ipcMain.handle('community:connectStart'"),
    mainSource.indexOf("ipcMain.handle('community:connectPoll'")
  );
  assert.match(connectStart, /requestedScopes = communityAuthorizationScopes\(discovery\)/);
  assert.match(connectStart, /scopes: requestedScopes/);
  assert.match(connectStart, /requestedScopes,/);

  const connectPoll = mainSource.slice(
    mainSource.indexOf("ipcMain.handle('community:connectPoll'"),
    mainSource.indexOf("ipcMain.handle('community:connectCancel'")
  );
  assert.match(connectPoll, /const requestedScopes = pending\.requestedScopes/);
  assert.match(connectPoll, /requestedScopes\.some\(scope => !grant\.scopes\.includes\(scope\)\)/);
  assert.match(connectPoll, /'COMMUNITY_SCOPE_UNAVAILABLE'/);
  assert.doesNotMatch(connectPoll, /requested Community editor access/);
  assert.match(connectPoll, /scopes: grantedScopes/);
  assert.match(connectPoll, /advertisedScopes: requestedScopes/);
  assert.match(
    connectPoll,
    /if \(savedConnection\.canReadSongs\)[\s\S]*scheduleCommunitySongSync\('new connection'/
  );
});

test('capability refresh preserves grants and keeps surviving resource lanes active', () => {
  const refresh = functionBlock(mainSource, 'refreshCommunityConnectionCapabilities');
  const current = functionBlock(mainSource, 'currentCommunityConnectionSummary');
  const warning = functionBlock(mainSource, 'communityCapabilityWarningMessage');
  const statusStart = mainSource.indexOf("ipcMain.handle('community:status'");
  const statusEnd = mainSource.indexOf("ipcMain.handle('community:connectStart'", statusStart);
  const status = mainSource.slice(statusStart, statusEnd);
  const connectStart = mainSource.slice(
    mainSource.indexOf("ipcMain.handle('community:connectStart'"),
    mainSource.indexOf("ipcMain.handle('community:connectPoll'")
  );

  assert.match(current, /refreshCapabilities/);
  assert.match(
    current,
    /communityCapabilityWarningMessage\(\s*connection\.scopes,\s*connection\.advertisedScopes\s*\)/s
  );
  assert.doesNotMatch(current, /communityReconnectRequired\s*=/);
  assert.match(current, /refreshCommunityConnectionCapabilities\(connection\)/);
  assert.match(refresh, /discover\(\{ force: true \}\)/);
  assert.match(refresh, /connection\.advertisedScopes \|\| connection\.scopes/);
  assert.match(refresh, /connectionStore\.updateAdvertisedScopes/);
  assert.match(refresh, /advertisedScopes,\s*expectedUpdatedAt: connection\.updatedAt/s);
  const laneUpdate = refresh.slice(refresh.indexOf('const advertisedScopes'));
  assert.doesNotMatch(laneUpdate, /communityReconnectRequired\s*=/);
  assert.match(
    laneUpdate,
    /communityCapabilityWarningMessage\(\s*updated\?\.scopes \|\| connection\.scopes,\s*updated\?\.advertisedScopes \|\| advertisedScopes\s*\)/s
  );
  assert.match(
    laneUpdate,
    /if \(connection\.canReadSongs && !updated\?\.canReadSongs\) \{\s*clearCommunitySyncTimer\(\);\s*clearCommunityPeriodicSync\(\);/s
  );
  assert.match(warning, /currently approved resources remain available/);
  assert.match(warning, /Those lanes are disabled; remaining resources stay available/);
  assert.match(status, /communityStatusPayload\(\{\s*refreshCapabilities: true\s*\}\)/s);
  assert.match(
    connectStart,
    /&& sameCommunityScopes\(existing\.scopes, existing\.advertisedScopes\)/
  );

  for (const functionName of [
    'runCommunitySongSync',
    'runCommunitySermonPull',
    'runCommunitySermonPush'
  ]) {
    assert.match(
      functionBlock(mainSource, functionName),
      /currentCommunityConnectionSummary\(\{\s*refreshCapabilities: true\s*\}\)/s
    );
  }
});

test('capability refresh pins server identity, origin, and API namespace', () => {
  const identity = functionBlock(mainSource, 'communityDiscoveryIdentityError');
  const refresh = functionBlock(mainSource, 'refreshCommunityConnectionCapabilities');

  assert.match(identity, /connection\.serverId !== discovery\.serverId/);
  assert.match(identity, /new URL\(connection\.baseUrl\)\.origin/);
  assert.match(identity, /new URL\(discovery\.baseUrl\)\.origin/);
  assert.match(identity, /code: 'COMMUNITY_SERVER_IDENTITY_CHANGED'/);
  assert.match(identity, /new URL\(connection\.apiBaseUrl\)/);
  assert.match(identity, /new URL\(discovery\.apiBaseUrl\)/);
  assert.match(identity, /savedApiPath !== discoveredApiPath/);
  assert.match(identity, /code: 'COMMUNITY_API_NAMESPACE_CHANGED'/);

  assert.ok(
    refresh.indexOf('communityDiscoveryIdentityError(connection, discovery)')
      < refresh.indexOf('const advertisedScopes'),
    'identity must be pinned before advertised scopes can be persisted'
  );
  assert.match(
    refresh,
    /if \(identityError\) \{[\s\S]*communityReconnectRequired = identityError;[\s\S]*return connection;/
  );
});

test('the exact saved sermon opens only in the trusted Community manager origin', () => {
  const openManager = functionBlock(
    mainSource,
    'openCommunitySermonPublicationManager'
  );
  const buildUrl = functionBlock(
    mainSource,
    'communitySermonPublicationManagerUrl'
  );
  assert.match(
    openManager,
    /currentCommunityConnectionSummary\(\)/
  );
  assert.match(
    openManager,
    /communityConnectionExpired\(summary\)[\s\S]*communityReconnectRequired/
  );
  assert.match(openManager, /!summary\.canReadSermons/);
  assert.match(
    openManager,
    /connectionStore\.getConnection\(summary\.id\)/
  );
  assert.match(openManager, /communityConnectionExpired\(current\)/);
  assert.match(openManager, /!current\.canReadSermons/);
  assert.match(
    openManager,
    /stateStore\.getSermonState\(current\.id, sermonId\)/
  );
  assert.match(
    openManager,
    /saved\.remoteRevision !== expectedLocalRevision/
  );
  assert.match(openManager, /Boolean\(saved\.conflict\)/);
  assert.match(
    openManager,
    /saved\.localRevision !== expectedLocalRevision/
  );
  assert.match(
    openManager,
    /localSermonLibrary\.read\(sermonId\)/
  );
  assert.match(
    openManager,
    /local\.revision !== expectedLocalRevision/
  );
  assert.match(
    openManager,
    /!\['ready', 'published'\]\.includes\(local\.sermon\.publication\.status\)/
  );
  assert.match(
    openManager,
    /SERMON_NOT_READY_FOR_PUBLICATION_REVIEW/
  );
  assert.ok(
    openManager.indexOf('stateStore.getSermonState(current.id, sermonId)')
      < openManager.indexOf('localSermonLibrary.read(sermonId)'),
    'the current local revision must be resolved after the saved remote pin'
  );
  assert.match(
    openManager,
    /communitySermonPublicationManagerUrl\(\s*current\.baseUrl,\s*sermonId\s*\)/s
  );
  assert.match(openManager, /shell\.openExternal\(managerUrl\)/);
  assert.doesNotMatch(
    openManager,
    /communityClientForConnection|pushSermon|publishCommunity|withdrawCommunity|accessToken/
  );

  const context = { URL };
  vm.runInNewContext(`
    function failMainOperation(code, message) {
      const error = new Error(message);
      error.code = code;
      throw error;
    }
    ${buildUrl}
    globalThis.buildManagerUrl = communitySermonPublicationManagerUrl;
  `, context, {
    filename: 'community-sermon-publication-manager-url.js'
  });
  const built = new URL(context.buildManagerUrl(
    'https://community.example.org/untrusted/path?ignored=yes',
    'constructor:john.3'
  ));
  assert.equal(built.origin, 'https://community.example.org');
  assert.equal(built.pathname, '/admin/sermon-publications');
  assert.equal(built.searchParams.get('sermon'), 'constructor:john.3');
  assert.deepEqual([...built.searchParams.keys()], ['sermon']);

  const handlerStart = mainSource.indexOf(
    "ipcMain.handle('community:sermons:openPublicationManager'"
  );
  const handlerEnd = mainSource.indexOf(
    "ipcMain.handle('community:sermons:verifyPublication'",
    handlerStart
  );
  const handler = mainSource.slice(handlerStart, handlerEnd);
  assert.match(handler, /requireControlSender\(event\)/);
  assert.match(handler, /serializeCommunityOperation/);
  assert.match(
    handler,
    /communityRequestKeys\(\s*request,\s*\['sermonId', 'expectedLocalRevision'\],\s*'Sermon publication manager request'\s*\)/s
  );
  assert.match(
    handler,
    /prepareSermonDomainId\(request\.sermonId, 'Sermon'\)/
  );
  assert.match(
    handler,
    /prepareRevision\(\s*request\.expectedLocalRevision,\s*'Expected local sermon revision'\s*\)/s
  );
  assert.match(
    handler,
    /openCommunitySermonPublicationManager\(\{\s*sermonId,\s*expectedLocalRevision\s*\}\)/s
  );
  assert.doesNotMatch(
    handler,
    /request\.(?:baseUrl|url|path|action|publish|withdraw)/
  );

  const bridgeStart = preloadSource.indexOf(
    'openCommunitySermonPublicationManager:'
  );
  const bridgeEnd = preloadSource.indexOf(
    'verifyCommunitySermonPublication:',
    bridgeStart
  );
  const bridge = preloadSource.slice(bridgeStart, bridgeEnd);
  assert.match(
    bridge,
    /ipcRenderer\.invoke\('community:sermons:openPublicationManager'/
  );
  assert.match(bridge, /sermonId: request\?\.sermonId/);
  assert.match(
    bridge,
    /expectedLocalRevision: request\?\.expectedLocalRevision/
  );
  assert.doesNotMatch(
    bridge,
    /baseUrl|url|path|action|publish|withdraw|accessToken/
  );
});

test('sermon synchronization is pull-only by default and an explicit exact-ID CAS push', () => {
  const pull = functionBlock(mainSource, 'runCommunitySermonPull');
  const push = functionBlock(mainSource, 'runCommunitySermonPush');
  const projection = functionBlock(mainSource, 'publicCommunitySermonSyncResult');
  assert.match(pull, /connection\.canReadSermons/);
  assert.match(pull, /sync\.pull\(\{ signal: controller\.signal \}\)/);
  assert.match(push, /connection\.canWriteSermons/);
  assert.match(
    push,
    /sync\.pushSermon\(sermonId, \{\s*syncId: sermonId,\s*expectedSyncVersion,\s*expectedLocalRevision,/s
  );
  assert.match(pull, /communitySyncAbortController\?\.abort\(\)/);
  assert.match(push, /communitySyncAbortController\?\.abort\(\)/);
  assert.doesNotMatch(projection, /documentSource|remoteDocumentSource|sourceObjects/);
  assert.doesNotMatch(mainSource, /scheduleCommunitySermon/);
  assert.ok(
    pull.indexOf('if (!connection.canReadSermons)')
      < pull.indexOf('communitySermonSyncForConnection(connection)'),
    'a song-only connection must fail before constructing a sermon sync'
  );
  assert.ok(
    push.indexOf('if (!connection.canWriteSermons)')
      < push.indexOf('communitySermonSyncForConnection(connection)'),
    'a song-only connection must fail before attempting a sermon push'
  );

  const handlerStart = mainSource.indexOf("ipcMain.handle('community:sermons:push'");
  const handlerEnd = mainSource.indexOf("ipcMain.handle('community:songs:getState'", handlerStart);
  const handler = mainSource.slice(handlerStart, handlerEnd);
  assert.match(handler, /serializeCommunityOperation/);
  assert.match(
    handler,
    /const sermonId = prepareSermonDomainId\(request\.sermonId, 'Sermon'\)/
  );
  assert.match(handler, /!Object\.hasOwn\(request, 'expectedSyncVersion'\)/);
  assert.match(handler, /expectedSyncVersion !== null/);
  assert.match(
    handler,
    /prepareRevision\(\s*request\.expectedLocalRevision,\s*'Expected local sermon revision'\s*\)/s
  );
  assert.match(
    handler,
    /runCommunitySermonPush\(\{\s*sermonId,\s*expectedSyncVersion,\s*expectedLocalRevision\s*\}\)/s
  );
  assert.doesNotMatch(handler, /documentSource|remoteDocumentSource|sourceObjects/);

  const bridgeStart = preloadSource.indexOf('pushCommunitySermon:');
  const bridgeEnd = preloadSource.indexOf('getCommunitySongState:', bridgeStart);
  const bridge = preloadSource.slice(bridgeStart, bridgeEnd);
  assert.match(bridge, /sermonId: request\?\.sermonId/);
  assert.match(bridge, /expectedSyncVersion: request\?\.expectedSyncVersion/);
  assert.match(bridge, /expectedLocalRevision: request\?\.expectedLocalRevision/);
  assert.doesNotMatch(bridge, /syncId|documentSource|remoteDocumentSource|sourceObjects/);
});

test('sermon-domain IPC uses the canonical ID grammar without object-key exclusions', () => {
  const validator = functionBlock(mainSource, 'prepareSermonDomainId');
  assert.match(validator, /\^\[A-Za-z0-9\]\[A-Za-z0-9\._:-\]\{0,127\}\$/);
  assert.doesNotMatch(validator, /__proto__|prototype|constructor/);
  for (const channel of [
    'community:sermons:getState',
    'community:sermons:openPublicationManager',
    'community:sermons:verifyPublication',
    'community:sermons:getConflict',
    'community:sermons:resolveConflict',
    'community:sermons:push',
    'prepare:sermons:outline',
    'prepare:projects:sourceSermon',
    'prepare:projects:attachSermonSource',
    'prepare:projects:proposeSermonExtraction',
    'prepare:projects:applySermonExtraction'
  ]) {
    const start = mainSource.indexOf(`ipcMain.handle('${channel}'`);
    assert.notEqual(start, -1, channel);
    const next = mainSource.indexOf('\nipcMain.handle(', start + 1);
    const handler = mainSource.slice(start, next < 0 ? mainSource.length : next);
    assert.match(
      handler,
      /prepareSermonDomainId\(request\.sermonId, 'Sermon'\)/,
      `${channel} must accept every canonical sermon ID`
    );
  }
});

test('sermon conflicts expose safe projections and require both CAS guards to resolve', () => {
  const payload = functionBlock(mainSource, 'communitySermonConflictPayload');
  const projection = functionBlock(mainSource, 'publicCommunitySermonConflictCopy');
  assert.match(payload, /communityConnectionExpired\(connection\)/);
  assert.match(payload, /communityReconnectRequired/);
  assert.match(payload, /if \(!connection\.canReadSermons\)/);
  assert.ok(
    payload.indexOf('if (!connection.canReadSermons)')
      < payload.indexOf('stateStore.getConnectionState(connection.id)'),
    'cached sermon conflict data must remain behind the current read capability'
  );
  assert.match(payload, /library\.read\(sermonId\)/);
  assert.match(payload, /library\.readRevision/);
  assert.match(payload, /remote\.revision !== sermonState\.conflict\.remoteRevision/);
  assert.match(payload, /expectedSyncVersion: sermonState\.syncVersion/);
  assert.match(payload, /expectedLocalRevision: local\.revision/);
  assert.doesNotMatch(
    projection,
    /remoteDocumentSource|documentSource|sourceObjects|fileName|provenance|\bsource:/
  );
  assert.match(projection, /body: Array\.isArray\(sermon\.body\)/);
  assert.match(
    projection,
    /metadataFingerprint: sermonConflictFingerprint\(JSON\.stringify\(\[\s*entry\.id,\s*entry\.sourceId,\s*entry\.sectionId/
  );
  assert.doesNotMatch(
    projection,
    /(?:id|sourceId|sectionId): entry\.(?:id|sourceId|sectionId)/
  );

  const getStart = mainSource.indexOf(
    "ipcMain.handle('community:sermons:getConflict'"
  );
  const resolveStart = mainSource.indexOf(
    "ipcMain.handle('community:sermons:resolveConflict'"
  );
  const pushStart = mainSource.indexOf(
    "ipcMain.handle('community:sermons:push'",
    resolveStart
  );
  assert.ok(getStart >= 0 && resolveStart > getStart && pushStart > resolveStart);
  const resolve = mainSource.slice(resolveStart, pushStart);
  assert.match(resolve, /serializeCommunityOperation/);
  assert.match(resolve, /\['keep-local', 'keep-remote'\]/);
  assert.match(resolve, /request\.expectedSyncVersion/);
  assert.match(resolve, /request\.expectedLocalRevision/);
  assert.match(resolve, /sync\.resolveConflict\(sermonId,/);
  assert.doesNotMatch(resolve, /remoteDocumentSource|documentSource|sourceObjects/);

  const bridgeStart = preloadSource.indexOf('getCommunitySermonConflict:');
  const bridgeEnd = preloadSource.indexOf('pushCommunitySermon:', bridgeStart);
  const bridge = preloadSource.slice(bridgeStart, bridgeEnd);
  assert.match(bridge, /resolveCommunitySermonConflict:/);
  assert.match(bridge, /expectedSyncVersion: request\?\.expectedSyncVersion/);
  assert.match(bridge, /expectedLocalRevision: request\?\.expectedLocalRevision/);
  assert.doesNotMatch(bridge, /remoteDocumentSource|documentSource|sourceObjects/);
});

test('cached song conflicts require active read authority and reuse the complete resolved family', () => {
  const payload = functionBlock(mainSource, 'communitySongConflictPayload');
  const projection = functionBlock(mainSource, 'localCommunityFamilyDocuments');
  assert.match(payload, /communityConnectionExpired\(connection\)/);
  assert.match(payload, /communityReconnectRequired/);
  assert.match(payload, /if \(!connection\.canReadSongs\)/);
  assert.ok(
    payload.indexOf('if (!connection.canReadSongs)')
      < payload.indexOf('stateStore.getConnectionState(connection.id)'),
    'cached Community lyrics must remain behind the current song-read capability'
  );
  assert.match(payload, /localCommunityFamilyDocuments\(local\.documents\)/);
  assert.match(payload, /expectedLocalRevision: local\.familyRevision/);
  assert.doesNotMatch(projection, /library\.list|pageSize|offset/);
  assert.match(projection, /documents\.map/);
  assert.match(projection, /source: document\.source/);
});

test('song and sermon last-sync summaries recover independently after restart', () => {
  const songRecovery = functionBlock(mainSource, 'communityLastSyncFromState');
  const sermonRecovery = functionBlock(
    mainSource,
    'communityLastSermonSyncFromState'
  );
  const status = functionBlock(mainSource, 'communityStatusPayload');
  const sermonPull = functionBlock(mainSource, 'runCommunitySermonPull');
  const sermonPush = functionBlock(mainSource, 'runCommunitySermonPush');

  assert.match(songRecovery, /state\.lastSyncAt/);
  assert.match(songRecovery, /Object\.values\(state\.songs\)/);
  assert.doesNotMatch(songRecovery, /lastSermonSyncAt|state\.sermons/);
  assert.match(sermonRecovery, /state\.lastSermonSyncAt/);
  assert.match(sermonRecovery, /Object\.values\(state\.sermons\)/);
  assert.match(sermonRecovery, /resource: 'sermons'/);
  assert.match(
    status,
    /lastSync: connection\.canReadSongs[\s\S]*communityLastSyncFromState\(connection\.id\)/
  );
  assert.match(
    status,
    /lastSermonSync: connection\.canReadSermons[\s\S]*communityLastSermonSyncFromState\(connection\.id\)/
  );
  assert.match(
    sermonPull,
    /communityLastSermonSyncSummary = completeCommunitySyncSummary/
  );
  assert.match(
    sermonPush,
    /communityLastSermonSyncSummary = completeCommunitySyncSummary/
  );
  assert.doesNotMatch(sermonPull, /communityLastSyncSummary =/);
  assert.doesNotMatch(sermonPush, /communityLastSyncSummary =/);
});

test('revoked manager authority enters a replaceable reconnect state', () => {
  assert.match(mainSource, /function requireCommunityReconnectFor/);
  assert.match(
    mainSource,
    /'AUTH_REQUIRED',\s*'AUTHORIZATION_EXPIRED',\s*'PERMISSION_DENIED'/
  );
  assert.match(mainSource, /status: 'reconnect-required'/);
  const connectStart = mainSource.slice(
    mainSource.indexOf("ipcMain.handle('community:connectStart'"),
    mainSource.indexOf("ipcMain.handle('community:connectPoll'")
  );
  assert.match(connectStart, /&& !communityReconnectRequired/);
  assert.match(mainSource, /communityReconnectRequired = null/);
  const connectPoll = mainSource.slice(
    mainSource.indexOf("ipcMain.handle('community:connectPoll'"),
    mainSource.indexOf("ipcMain.handle('community:connectCancel'")
  );
  assert.match(connectPoll, /terminalCommunityAuthorizationError\(error\)/);
  assert.match(connectPoll, /pendingCommunityAuthorizations\.delete\(authorizationId\)/);
  assert.match(connectPoll, /previousConnection\.serverId === pending\.discovery\.serverId/);
  assert.match(connectPoll, /new URL\(previousConnection\.baseUrl\)\.origin/);
  assert.match(connectPoll, /revokeAccessToken\(\{ accessToken: previousConnection\.accessToken \}\)/);
  assert.match(connectPoll, /communityConnectionWarning/);
});

test('remote song edits refresh periodically with bounded quiet backoff', () => {
  const queued = functionBlock(mainSource, 'scheduleCommunitySongSync');
  const periodic = functionBlock(mainSource, 'scheduleCommunityPeriodicSync');
  assert.match(mainSource, /COMMUNITY_PERIODIC_SYNC_BASE_MS = 5 \* 60 \* 1000/);
  assert.match(mainSource, /COMMUNITY_PERIODIC_SYNC_MAX_MS = 30 \* 60 \* 1000/);
  for (const scheduler of [queued, periodic]) {
    assert.match(scheduler, /currentCommunityConnectionSummary\(\)/);
    assert.match(scheduler, /!connection\.canReadSongs/);
    assert.ok(
      scheduler.indexOf('!connection.canReadSongs')
        < scheduler.indexOf('return runCommunitySongSync()'),
      'a timer must prove the stored effective song lane before entering song sync'
    );
  }
  assert.match(periodic, /result\.status === 'offline'/);
  assert.match(periodic, /Math\.random\(\)/);
  assert.match(periodic, /scheduleCommunityPeriodicSync\(\)/);
  assert.match(periodic, /if \(!result\)[\s\S]*clearCommunityPeriodicSync\(\)/);
  assert.match(mainSource, /scheduleCommunityPeriodicSync\(\{ resetBackoff: true \}\)/);
  assert.match(mainSource, /clearCommunityPeriodicSync\(\{ resetBackoff: true \}\)/);
  const cancellation = functionBlock(mainSource, 'cancelCommunityTransientOperations');
  assert.match(cancellation, /clearCommunityPeriodicSync\(\)/);
});
