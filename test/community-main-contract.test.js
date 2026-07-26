'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..');
const mainSource = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
const preloadSource = fs.readFileSync(path.join(root, 'preload.js'), 'utf8');

function functionBlock(source, name) {
  const start = source.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `expected function ${name}`);
  const brace = source.indexOf('{', start);
  let depth = 0;
  for (let index = brace; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1;
    if (source[index] === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(start, index + 1);
    }
  }
  throw new Error(`unterminated function ${name}`);
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
  'community:songs:getState',
  'community:songs:getConflict',
  'community:songs:resolveConflict',
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
    'getCommunitySongState',
    'getCommunitySongConflict',
    'resolveCommunitySongConflict',
    'setCommunitySongVisibility',
    'onCommunityStatus'
  ]) {
    assert.match(preloadSource, new RegExp(`${method}:`), `${method} must be bridged`);
  }
  const start = preloadSource.indexOf('// Heritage Community song-library integration');
  const end = preloadSource.indexOf('// Coherent service-folder discovery', start);
  const bridge = preloadSource.slice(start, end);
  assert.doesNotMatch(bridge, /accessToken|refreshToken|deviceSecret|codeVerifier|clientSecret/);
  assert.doesNotMatch(bridge, /\bpassword\b/i);
});

test('public status and song projections omit credentials and preserved remote sources', () => {
  const connectionProjection = functionBlock(mainSource, 'publicCommunityConnection');
  const songProjection = functionBlock(mainSource, 'publicCommunitySongState');
  for (const source of [connectionProjection, songProjection]) {
    assert.doesNotMatch(source, /accessToken|refreshToken|deviceSecret|codeVerifier|apiBaseUrl/);
  }
  assert.doesNotMatch(songProjection, /remoteDocuments|documentSource|\bsource:/);
  assert.match(connectionProjection, /canReadSongs/);
  assert.match(connectionProjection, /canWriteSongs/);
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
  assert.match(mainSource, /new CommunityConnectionStore\(\{[\s\S]*maximumConnections: 1/);
  assert.match(mainSource, /new CommunitySyncStateStore/);
  assert.match(mainSource, /new CommunitySongSync/);
  assert.match(mainSource, /communitySyncAbortController\?\.abort\(\)/);
  assert.match(mainSource, /communityAuthAbortController\?\.abort\(\)/);
  assert.match(mainSource, /client\.discover\(\{ signal: controller\.signal \}\)/);
  assert.match(mainSource, /pollDeviceAuthorization\(authorizationId, \{\s*signal: controller\.signal/s);
  assert.match(mainSource, /expectedSyncVersion: expectedSyncVersion \?\? null/);
  assert.match(mainSource, /sync\.resolveConflict\(conflict\.syncId/);
  assert.match(mainSource, /strategy,\s*expectedSyncVersion:/s);
  assert.match(mainSource, /scheduleCommunitySongSync\('local song saved'/);
  assert.match(mainSource, /augmentSongLibraryWithCommunity\(listing\)/);
});

test('revoked manager authority enters a replaceable reconnect state', () => {
  assert.match(mainSource, /function requireCommunityReconnectFor/);
  assert.match(mainSource, /\['AUTH_REQUIRED', 'PERMISSION_DENIED'\]/);
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
  const periodic = functionBlock(mainSource, 'scheduleCommunityPeriodicSync');
  assert.match(mainSource, /COMMUNITY_PERIODIC_SYNC_BASE_MS = 5 \* 60 \* 1000/);
  assert.match(mainSource, /COMMUNITY_PERIODIC_SYNC_MAX_MS = 30 \* 60 \* 1000/);
  assert.match(periodic, /serializeCommunityOperation\(\(\) => runCommunitySongSync\(\)\)/);
  assert.match(periodic, /result\.status === 'offline'/);
  assert.match(periodic, /Math\.random\(\)/);
  assert.match(periodic, /scheduleCommunityPeriodicSync\(\)/);
  assert.match(mainSource, /scheduleCommunityPeriodicSync\(\{ resetBackoff: true \}\)/);
  assert.match(mainSource, /clearCommunityPeriodicSync\(\{ resetBackoff: true \}\)/);
  const cancellation = functionBlock(mainSource, 'cancelCommunityTransientOperations');
  assert.match(cancellation, /clearCommunityPeriodicSync\(\)/);
});
