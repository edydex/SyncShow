'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const mainSource = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
const preloadSource = fs.readFileSync(path.join(root, 'preload.js'), 'utf8');

function plain(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function handlerSource(channel) {
  const marker = `ipcMain.handle('${channel}'`;
  const start = mainSource.indexOf(marker);
  assert.notEqual(start, -1, `${channel} must be implemented`);
  const next = mainSource.indexOf("ipcMain.handle('", start + marker.length);
  return mainSource.slice(start, next === -1 ? mainSource.length : next);
}

function functionSource(name) {
  const marker = `function ${name}(`;
  const start = mainSource.indexOf(marker);
  assert.notEqual(start, -1, `${name} must be implemented`);
  const next = mainSource.indexOf('\nfunction ', start + marker.length);
  return mainSource.slice(start, next === -1 ? mainSource.length : next);
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
            return Promise.resolve(null);
          },
          send() {},
          on() {},
          removeListener() {},
          removeAllListeners() {}
        }
      };
    },
    console
  }, { filename: 'preload.js' });
  assert.ok(api);
  return { api, calls };
}

test('Electron registers a least-privilege private streaming scheme before readiness', () => {
  const registration = mainSource.indexOf(
    'protocol.registerSchemesAsPrivileged'
  );
  const readiness = mainSource.indexOf('app.whenReady()');
  assert.ok(registration > -1 && readiness > registration);
  const block = mainSource.slice(
    registration,
    mainSource.indexOf('// Native UI smoke tests', registration)
  );
  assert.match(block, /scheme: SERMON_RECORDING_PLAYBACK_SCHEME/);
  assert.match(block, /secure: true/);
  assert.match(block, /standard: true/);
  assert.match(block, /stream: true/);
  assert.doesNotMatch(block, /bypassCSP|supportFetchAPI|serviceWorkers/);

  const register = functionSource(
    'registerSermonRecordingPlaybackProtocol'
  );
  assert.match(register, /protocol\.handle\(/);
  assert.match(
    register,
    /createSermonRecordingPlaybackResponse\(\s*request,\s*sermonRecordingPlaybackAuthority/
  );
});

test('playback IPC resolves all recording identity in trusted main and returns no capability URL', () => {
  const source = handlerSource(
    'prepare:projects:playSermonRecording'
  );
  assert.match(source, /requireControlSender\(event\)/);
  assert.match(
    source,
    /requireExactPrepareKeys\(request,\s*\[\s*'projectId',\s*'expectedRevisionId',\s*'itemId'\s*\]/
  );
  assert.match(source, /readExpectedProject\(request\)/);
  assert.match(source, /resolveSermonSourceLink\(current\.project, item\)/);
  assert.match(
    source,
    /`post-service:recording:\$\{document\.defaultLanguage\}`/
  );
  assert.match(
    source,
    /verifySermonRecordingForPlayback\([\s\S]*localSermonMediaStore\.openMediaReadSession\(\s*recording,\s*\{ signal: abortController\.signal \}/
  );
  assert.match(
    source,
    /displayStartInProgress \|\| appState\.activeLaunchPlan/
  );
  assert.match(source, /invalidateSermonRecordingPlayer\(\)/);
  assert.match(
    source,
    /requireCurrentSermonRecordingPlayback\(playbackAttempt\.epoch\)[\s\S]*openMediaReadSession\([\s\S]*requireCurrentSermonRecordingPlayback\(playbackAttempt\.epoch\)/
  );
  assert.equal(
    (source.match(/readExpectedProject\(request\)/gu) || []).length,
    2,
    'project and sermon binding must be re-read after the complete media verification'
  );
  assert.match(source, /openSermonRecordingPlayer\(\{/);
  assert.doesNotMatch(
    source,
    /request\.(?:sermonId|sermonRevisionId|recordingId|sha256|objectId|path|filePath|sourcePath)/
  );

  const player = functionSource('openSermonRecordingPlayer');
  assert.match(player, /nodeIntegration: false/);
  assert.match(player, /contextIsolation: true/);
  assert.match(player, /sandbox: true/);
  assert.match(player, /setWindowOpenHandler\(\(\) => \(\{ action: 'deny' \}\)\)/);
  assert.match(player, /webContents\.on\('will-navigate'/);
  assert.match(player, /sermonRecordingPlaybackAuthority\.issue/);
  assert.doesNotMatch(
    player,
    /(?:sourcePath|filePath|localPath|objectId)/
  );

  const html = functionSource('sermonRecordingPlayerHtml');
  assert.match(
    html,
    /default-src 'none'; media-src \$\{SERMON_RECORDING_PLAYBACK_SCHEME\}:/
  );
  assert.match(html, /never a local file path, Community credential, or publication authority/);
  assert.doesNotMatch(html, /file:|blob:|https?:/);
});

test('preload forwards only exact project intent and owns a path-free stop command', async () => {
  const { api, calls } = loadPreloadBridge();
  await api.playSermonRecordingForServiceItem({
    projectId: 'service',
    expectedRevisionId: 'a'.repeat(64),
    itemId: 'sermon-item',
    sermonId: 'renderer-controlled-sermon',
    sermonRevisionId: 'b'.repeat(64),
    recordingId: 'renderer-controlled-recording',
    sha256: 'c'.repeat(64),
    objectId: 'sha256:renderer-controlled',
    playbackUrl: 'file:///private/recording.mp3',
    filePath: '/private/recording.mp3'
  });
  await api.stopSermonRecordingPlayback({
    token: 'renderer-controlled-token'
  });

  assert.deepEqual(calls, [{
    channel: 'prepare:projects:playSermonRecording',
    payload: {
      projectId: 'service',
      expectedRevisionId: 'a'.repeat(64),
      itemId: 'sermon-item'
    }
  }, {
    channel: 'prepare:projects:stopSermonRecordingPlayback',
    payload: undefined
  }]);
});

test('playback is revoked on close, crash, suspend, Show start, and app quit', () => {
  const invalidate = functionSource('invalidateSermonRecordingPlayer');
  assert.match(invalidate, /sermonRecordingPlaybackEpoch \+= 1/);
  assert.match(invalidate, /abortController\?\.abort\(\)/);
  assert.match(invalidate, /active\?\.window[\s\S]*\.destroy\(\)/);
  assert.match(
    invalidate,
    /sermonRecordingPlaybackAuthority\.revoke\(active\.token\)/
  );
  assert.match(invalidate, /sermonRecordingPlaybackVerificationTail\.catch/);
  const close = functionSource('closeSermonRecordingPlayer');
  assert.match(close, /invalidateSermonRecordingPlayer\(\)/);
  assert.match(close, /await invalidation\.cleanup/);

  const player = functionSource('openSermonRecordingPlayer');
  assert.match(
    player,
    /playerWindow\.on\('closed'[\s\S]*sermonRecordingPlaybackAuthority\.revoke\(entry\.token\)/
  );
  assert.match(
    player,
    /playerWindow\.on\('unresponsive'[\s\S]*closeSermonRecordingPlayer\(\)/
  );
  assert.match(
    player,
    /playerWindow\.webContents\.on\('render-process-gone'[\s\S]*closeSermonRecordingPlayer\(\)/
  );
  assert.match(
    mainSource,
    /controlWindow\.webContents\.on\('render-process-gone'[\s\S]{0,360}closeSermonRecordingPlayer\(\)/
  );
  assert.match(
    mainSource,
    /controlWindow\.on\('unresponsive'[\s\S]{0,260}closeSermonRecordingPlayer\(\)/
  );
  assert.match(
    mainSource,
    /powerMonitor\.on\('suspend'[\s\S]{0,300}closeSermonRecordingPlayer\(\)/
  );
  const showStart = handlerSource('display:start');
  assert.match(
    showStart,
    /await closeSermonRecordingPlayer\(\)[\s\S]*destroyOutputWindows\(\)/
  );
  assert.match(
    showStart,
    /displayStartInProgress = true[\s\S]*finally \{\s*displayStartInProgress = false/
  );
  assert.match(
    mainSource,
    /app\.on\('will-quit'[\s\S]{0,160}closeSermonRecordingPlayer\(\)/
  );
});
