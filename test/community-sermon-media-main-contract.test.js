'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsPromises = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const {
  CommunitySermonMediaAttemptStore,
  sermonMediaAttemptBindingKey,
  sermonMediaAttemptRecoveryLocator
} = require('../src/services/community/CommunitySermonMediaAttemptStore');

const root = path.resolve(__dirname, '..');
const mainSource = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
const preloadSource = fs.readFileSync(path.join(root, 'preload.js'), 'utf8');

function functionBlock(source, name) {
  const functionStart = source.indexOf(`function ${name}(`);
  assert.notEqual(functionStart, -1, `expected function ${name}`);
  const start = source.slice(functionStart - 6, functionStart) === 'async '
    ? functionStart - 6
    : functionStart;
  const bodyStart = source.indexOf('{', source.indexOf(')', start));
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

function handlerSource(channel) {
  const marker = `ipcMain.handle('${channel}'`;
  const start = mainSource.indexOf(marker);
  assert.notEqual(start, -1, `${channel} must be implemented`);
  const next = mainSource.indexOf("ipcMain.handle('", start + marker.length);
  return mainSource.slice(start, next === -1 ? mainSource.length : next);
}

function preloadBridge() {
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
            calls.push({
              channel,
              payload: JSON.parse(JSON.stringify(payload))
            });
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

test('sermon-media scopes are optional by default and explicit at first use', () => {
  const optional = mainSource.slice(
    mainSource.indexOf('const OPTIONAL_COMMUNITY_APPROVAL_SCOPES'),
    mainSource.indexOf('function communityAuthorizationScopes')
  );
  assert.match(optional, /syncshow:sermon-media:read/);
  assert.match(optional, /syncshow:sermon-media:write/);

  const authorization = functionBlock(
    mainSource,
    'communityAuthorizationScopes'
  );
  assert.match(authorization, /includeSermonMedia = false/);
  assert.match(
    authorization,
    /includeSermonMedia\s*\|\|\s*!OPTIONAL_COMMUNITY_APPROVAL_SCOPES\.has/
  );

  const approval = functionBlock(
    mainSource,
    'beginCommunitySermonMediaApproval'
  );
  assert.match(approval, /includeSermonMedia: true/);
  assert.match(approval, /startDeviceAuthorization/);
  assert.match(approval, /No upload starts during approval/);
  assert.ok(
    approval.indexOf('startDeviceAuthorization')
      < approval.indexOf('pendingCommunityAuthorizations.set')
  );
});

test('main reserves an upload synchronously and releases IPC after session progress', () => {
  const run = functionBlock(mainSource, 'runCommunitySermonMediaUpload');
  const reserve = run.indexOf('communitySermonMediaUploads.set(key, operation)');
  const firstAwait = run.indexOf('await communitySermonMediaContext');
  assert.ok(reserve >= 0 && reserve < firstAwait);
  assert.match(run, /operation\.promise = uploader\.upload/);
  assert.match(run, /\['uploading', 'cancelling', 'recovering'\]\.includes/);
  assert.match(run, /async onAcknowledged\(uploadId\)/);
  assert.match(run, /acknowledgeUpload/);
  const ordinaryUpload = run.slice(
    run.indexOf('operation.promise = uploader.upload')
  );
  assert.ok(
    ordinaryUpload.indexOf('async onAcknowledged(uploadId)')
      < ordinaryUpload.indexOf('onProgress(progress)')
  );
  assert.match(run, /resumeFinalization/);
  assert.match(run, /recoveryBinding/);
  assert.match(run, /operation\.promise\s*\.then/);
  assert.match(run, /await started/);
  assert.ok(
    run.indexOf('await started') < run.indexOf("status: operation.status")
  );

  const success = run.slice(
    run.indexOf('operation.promise'),
    run.indexOf('.catch(async error')
  );
  assert.doesNotMatch(
    success,
    /markTerminal/,
    'a successful init key must replay complete after app restart'
  );
  const failure = run.slice(run.indexOf('.catch(async error'));
  assert.match(failure, /restartRequired/);
  assert.match(failure, /markTerminal/);

  const availability = functionBlock(
    mainSource,
    'communitySermonMediaAvailability'
  );
  assert.match(
    availability,
    /communitySermonMediaCanResumeWithoutLocal/
  );
  assert.match(
    availability,
    /active\.status === 'error' && active\.restartRequired === true/
  );
});

test('suspend and shutdown pause uploads without remote deletion', () => {
  const pause = functionBlock(
    mainSource,
    'pauseCommunitySermonMediaUploads'
  );
  assert.match(pause, /operation\.controller\?\.abort\(\)/);
  assert.match(pause, /Promise\.allSettled/);
  assert.doesNotMatch(pause, /\.cancel\(|method:\s*'DELETE'/);

  const transient = functionBlock(
    mainSource,
    'cancelCommunityTransientOperations'
  );
  assert.match(transient, /await pauseCommunitySermonMediaUploads\(\)/);

  const cancel = functionBlock(
    mainSource,
    'cancelCommunitySermonMediaUpload'
  );
  assert.match(cancel, /active\.controller\?\.abort\(\)/);
  assert.ok(
    cancel.indexOf("active.status = 'cancelling'")
      < cancel.indexOf('active.controller?.abort()')
  );
  assert.match(cancel, /await active\.promise\?\.catch/);
  assert.match(
    cancel,
    /await active\.uploader\.cancel\(active\.uploadId\)/
  );
  assert.doesNotMatch(
    cancel,
    /communitySermonMediaContext|communitySermonMediaUploader/,
    'cancel must retain its pinned client when local state changes'
  );
  assert.match(cancel, /markTerminal/);
  assert.match(
    handlerSource('prepare:communitySermonMedia:cancel'),
    /return cancelCommunitySermonMediaUpload\(reference\)/
  );

  const disconnect = handlerSource('community:disconnect');
  assert.ok(
    disconnect.indexOf('await pauseCommunitySermonMediaUploads()')
      < disconnect.indexOf('clearCommunitySermonMediaOperationState()')
  );
  const connectPoll = handlerSource('community:connectPoll');
  assert.match(
    connectPoll,
    /if \(changingServers\) \{\s*clearCommunitySermonMediaOperationState\(\)/
  );
});

test('disconnect clears Community A terminal state before Community B can reuse the local key', () => {
  const source = `
    const communitySermonMediaUploads = new Map();
    ${functionBlock(mainSource, 'clearCommunitySermonMediaOperationState')}
    globalThis.contract = {
      communitySermonMediaUploads,
      clearCommunitySermonMediaOperationState
    };
  `;
  const context = { Map };
  vm.runInNewContext(source, context, {
    filename: 'community-sermon-media-connection-boundary.js'
  });
  const localKey = ['project-one', 'a'.repeat(64), 'sermon-cue'].join('\0');
  const communityA = {
    communityId: 'church-a',
    status: 'complete'
  };
  context.contract.communitySermonMediaUploads.set(localKey, communityA);

  context.contract.clearCommunitySermonMediaOperationState();
  assert.equal(context.contract.communitySermonMediaUploads.size, 0);

  const communityB = {
    communityId: 'church-b',
    status: 'ready'
  };
  context.contract.communitySermonMediaUploads.set(localKey, communityB);
  assert.notEqual(
    context.contract.communitySermonMediaUploads.get(localKey),
    communityA
  );
  assert.equal(
    context.contract.communitySermonMediaUploads.get(localKey).status,
    'ready'
  );
});

test('mid-transfer Main cancel survives missing media and local revision changes', async () => {
  const source = `
    const events = [];
    const notifications = [];
    const communitySermonMediaUploads = new Map();
    const context = {
      binding: {},
      connection: {
        baseUrl: 'https://community.example.test/',
        serverId: 'wotbc'
      },
      services: {
        communitySermonMediaAttemptStore: {
          async attemptFor() {
            return {
              attemptId: '11111111-1111-4111-8111-111111111111',
              uploadId: null
            };
          },
          async acknowledgeUpload(key, attemptId, uploadId) {
            events.push(['acknowledge', key, attemptId, uploadId]);
            return {
              attempt: {
                attemptId,
                uploadId,
                terminal: false
              }
            };
          },
          async markTerminal(key, attemptId) {
            events.push(['terminal', key, attemptId]);
          }
        }
      }
    };
    let finishDelete;
    let nextDeleteError = null;
    let nextInspectError = null;
    let nextInspectState = 'complete';
    let localFailure = null;
    let contextCalls = 0;
    let rejectActiveUpload = null;
    const deleteGate = new Promise(resolve => {
      finishDelete = resolve;
    });
    const uploader = {
      upload(_reference, { signal, onAcknowledged, onProgress }) {
        events.push(['upload-open']);
        return new Promise((_resolve, reject) => {
          rejectActiveUpload = reject;
          signal.addEventListener('abort', () => {
            events.push(['abort']);
            const error = new Error('request stopped');
            error.code = 'REQUEST_CANCELLED';
            reject(error);
          }, { once: true });
          queueMicrotask(() => {
            onAcknowledged('ABCDEFGHIJKLMNOPQRSTUVWX12345678')
              .then(() => {
                events.push(['progress']);
                onProgress({
                  phase: 'uploading',
                  uploadId: 'ABCDEFGHIJKLMNOPQRSTUVWX12345678',
                  receivedBytes: 8,
                  totalBytes: 16,
                  receivedChunks: 1,
                  chunkCount: 2,
                  percent: 50,
                  complete: false
                });
              })
              .catch(reject);
          });
        });
      },
      async cancel(uploadId) {
        events.push(['delete', uploadId]);
        await deleteGate;
        if (nextDeleteError) {
          const error = nextDeleteError;
          nextDeleteError = null;
          throw error;
        }
        return {
          upload: {
            id: uploadId
          },
          progress: {
            phase: 'cancelled',
            uploadId,
            receivedBytes: 8,
            totalBytes: 16,
            receivedChunks: 1,
            chunkCount: 2,
            percent: 50,
            complete: false
          }
        };
      },
      async inspect(uploadId) {
        events.push(['inspect', uploadId]);
        if (nextInspectError) {
          const error = nextInspectError;
          nextInspectError = null;
          throw error;
        }
        const state = nextInspectState;
        nextInspectState = 'complete';
        return {
          upload: {
            id: uploadId,
            state
          },
          progress: {
            phase: state,
            uploadId,
            receivedBytes: 16,
            totalBytes: 16,
            receivedChunks: 2,
            chunkCount: 2,
            percent: 100,
            complete: state === 'complete'
          }
        };
      }
    };
    function communitySermonMediaOperationKey(reference) {
      return [
        reference.projectId,
        reference.expectedProjectRevisionId,
        reference.itemId
      ].join('\\0');
    }
    async function communitySermonMediaContext() {
      contextCalls += 1;
      if (localFailure) {
        const error = new Error(localFailure);
        error.code = localFailure;
        error.stale = true;
        throw error;
      }
      return context;
    }
    function communitySermonMediaUploader() {
      return uploader;
    }
    function communitySermonMediaAttemptIdentity() {
      return {
        serverId: 'https://community.example.test/',
        communityId: 'wotbc'
      };
    }
    function communitySermonMediaAttemptKey() {
      return '${'f'.repeat(64)}';
    }
    function communitySermonMediaRecoveryLocator() {
      return '${'e'.repeat(64)}';
    }
    function communitySermonMediaObservedAttemptKey() {
      return '${'f'.repeat(64)}';
    }
    function publicCommunityError(error) {
      return { code: error.code || 'ERROR', message: error.message };
    }
    function publicCommunitySermonMediaProgress(progress) {
      if (!progress) return null;
      const { uploadId: _uploadId, ...safe } = progress;
      return safe;
    }
    function notifyCommunitySermonMediaProgress(_reference, status) {
      notifications.push(status);
    }
    function failMainOperation(code, message) {
      const error = new Error(message);
      error.code = code;
      throw error;
    }
    ${functionBlock(mainSource, 'communitySermonMediaRemoteBytesComplete')}
    ${functionBlock(mainSource, 'communitySermonMediaCanResumeWithoutLocal')}
    ${functionBlock(mainSource, 'communitySermonMediaFailureDisposition')}
    ${functionBlock(mainSource, 'runCommunitySermonMediaUpload')}
    ${functionBlock(mainSource, 'communitySermonMediaCanCancel')}
    ${functionBlock(mainSource, 'cancelCommunitySermonMediaUpload')}
    globalThis.contract = {
      runCommunitySermonMediaUpload,
      cancelCommunitySermonMediaUpload,
      communitySermonMediaUploads,
      events,
      notifications,
      finishDelete,
      get contextCalls() {
        return contextCalls;
      },
      invalidateLocal(code) {
        localFailure = code;
      },
      restoreLocal() {
        localFailure = null;
      },
      failNextDelete() {
        const error = new Error('cancel transport failed');
        error.code = 'NETWORK_ERROR';
        error.retryable = true;
        nextDeleteError = error;
      },
      completeBeforeNextDelete() {
        const error = new Error('upload completed before cancellation');
        error.code = 'UPLOAD_ALREADY_COMPLETE';
        nextDeleteError = error;
        nextInspectState = 'complete';
      },
      finalizeBeforeNextDelete() {
        const error = new Error('upload entered finalization');
        error.code = 'FINALIZATION_IN_PROGRESS';
        error.retryable = true;
        nextDeleteError = error;
        nextInspectState = 'finalizing';
      },
      failNextInspect() {
        const error = new Error('completion status transport failed');
        error.code = 'NETWORK_ERROR';
        error.retryable = true;
        nextInspectError = error;
      },
      failActiveUploadWithLocalStale() {
        const error = new Error('the local recording changed after ACK');
        error.code = 'LOCAL_RECORDING_CHANGED';
        error.stale = true;
        rejectActiveUpload(error);
      }
    };
  `;
  const context = {
    AbortController,
    Error,
    Map,
    Object,
    Promise,
    queueMicrotask
  };
  vm.runInNewContext(source, context, {
    filename: 'community-sermon-media-main-cancel-race.js'
  });
  const reference = {
    projectId: 'project-one',
    expectedProjectRevisionId: 'a'.repeat(64),
    itemId: 'sermon-cue'
  };

  const started = await context.contract
    .runCommunitySermonMediaUpload(reference, {
      rotateTerminalAttempt: true
    });
  assert.equal(started.status, 'uploading');
  assert.deepEqual(
    JSON.parse(JSON.stringify(started.progress)),
    {
      phase: 'uploading',
      receivedBytes: 8,
      totalBytes: 16,
      receivedChunks: 1,
      chunkCount: 2,
      percent: 50,
      complete: false
    }
  );
  assert.equal(
    context.contract.events.some(event => event[0] === 'delete'),
    false,
    'Start returns while the body is still active and before DELETE'
  );
  assert.equal(context.contract.contextCalls, 1);

  context.contract.invalidateLocal('LOCAL_RECORDING_MISSING');
  const pendingCancel = context.contract
    .cancelCommunitySermonMediaUpload(reference);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(
    context.contract.communitySermonMediaUploads.values().next().value.status,
    'cancelling'
  );
  await assert.rejects(
    context.contract.runCommunitySermonMediaUpload(reference),
    error => error?.code === 'SERMON_MEDIA_UPLOAD_ACTIVE'
  );
  assert.equal(
    context.contract.communitySermonMediaUploads.size,
    1,
    'a concurrent Start/Resume cannot replace the cancelling reservation'
  );
  context.contract.finishDelete();
  const cancelled = await pendingCancel;
  assert.equal(cancelled.status, 'cancelled');
  const names = context.contract.events.map(event => event[0]);
  assert.ok(names.indexOf('progress') < names.indexOf('abort'));
  assert.ok(names.indexOf('abort') < names.indexOf('delete'));
  assert.ok(names.indexOf('delete') < names.indexOf('terminal'));
  assert.equal(names.filter(name => name === 'delete').length, 1);
  assert.equal(names.filter(name => name === 'terminal').length, 1);
  assert.equal(
    context.contract.contextCalls,
    1,
    'missing local media cannot force cancel through local revalidation'
  );
  assert.equal(
    context.contract.communitySermonMediaUploads.values().next().value.status,
    'cancelled'
  );

  context.contract.restoreLocal();
  await context.contract.runCommunitySermonMediaUpload(reference, {
    rotateTerminalAttempt: true
  });
  assert.equal(context.contract.contextCalls, 2);
  context.contract.invalidateLocal('SERMON_MEDIA_STALE');
  const changedRevisionCancel = await context.contract
    .cancelCommunitySermonMediaUpload(reference);
  assert.equal(changedRevisionCancel.status, 'cancelled');
  assert.equal(
    context.contract.contextCalls,
    2,
    'a local revision change after progress cannot block remote DELETE'
  );
  assert.equal(
    context.contract.events.filter(event => event[0] === 'delete').length,
    2
  );
  assert.equal(
    context.contract.events.filter(event => event[0] === 'terminal').length,
    2,
    'each authoritative cancellation marks its attempt terminal exactly once'
  );

  context.contract.restoreLocal();
  await context.contract.runCommunitySermonMediaUpload(reference, {
    rotateTerminalAttempt: true
  });
  context.contract.failNextDelete();
  await assert.rejects(
    context.contract.cancelCommunitySermonMediaUpload(reference),
    error => error?.code === 'NETWORK_ERROR' && error.retryable === true
  );
  const retryable = context.contract.communitySermonMediaUploads
    .values().next().value;
  assert.equal(retryable.status, 'error');
  assert.equal(retryable.restartRequired, false);
  assert.equal(
    context.contract.events.filter(event => event[0] === 'terminal').length,
    2,
    'an unconfirmed DELETE keeps the same attempt resumable'
  );

  context.contract.completeBeforeNextDelete();
  const completedRace = await context.contract
    .cancelCommunitySermonMediaUpload(reference);
  assert.equal(completedRace.status, 'complete');
  assert.equal(
    context.contract.communitySermonMediaUploads.values().next().value.status,
    'complete'
  );
  assert.equal(
    context.contract.events.filter(event => event[0] === 'inspect').length,
    1
  );
  assert.equal(
    context.contract.events.filter(event => event[0] === 'terminal').length,
    2,
    'a completed race preserves the successful replay attempt'
  );

  context.contract.restoreLocal();
  await context.contract.runCommunitySermonMediaUpload(reference, {
    rotateTerminalAttempt: true
  });
  context.contract.completeBeforeNextDelete();
  context.contract.failNextInspect();
  await assert.rejects(
    context.contract.cancelCommunitySermonMediaUpload(reference),
    error => error?.code === 'NETWORK_ERROR' && error.retryable === true
  );
  const inspectRetryable = context.contract.communitySermonMediaUploads
    .values().next().value;
  assert.equal(inspectRetryable.status, 'error');
  assert.equal(inspectRetryable.restartRequired, false);
  assert.equal(
    typeof inspectRetryable.uploadId,
    'string',
    'a failed authoritative GET preserves the opaque ID for retry'
  );
  assert.equal(
    context.contract.notifications.at(-1),
    'error',
    'a failed authoritative GET cannot strand the UI in cancelling'
  );

  context.contract.restoreLocal();
  await context.contract.runCommunitySermonMediaUpload(reference, {
    rotateTerminalAttempt: true
  });
  const locallyStaleOperation =
    context.contract.communitySermonMediaUploads.values().next().value;
  const terminalCountBeforeLocalStale = context.contract.events
    .filter(event => event[0] === 'terminal').length;
  context.contract.failActiveUploadWithLocalStale();
  await assert.rejects(
    locallyStaleOperation.promise,
    error => error?.code === 'LOCAL_RECORDING_CHANGED'
      && error.stale === true
  );
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(locallyStaleOperation.status, 'error');
  assert.equal(locallyStaleOperation.restartRequired, false);
  assert.equal(locallyStaleOperation.resumeEligible, false);
  assert.equal(
    locallyStaleOperation.uploadId,
    'ABCDEFGHIJKLMNOPQRSTUVWX12345678'
  );
  assert.equal(
    context.contract.events.filter(event => event[0] === 'terminal').length,
    terminalCountBeforeLocalStale,
    'local staleness cannot invent a remotely terminal upload'
  );

  context.contract.invalidateLocal('LOCAL_RECORDING_MISSING');
  const cancelledAfterLocalStale = await context.contract
    .cancelCommunitySermonMediaUpload(reference);
  assert.equal(cancelledAfterLocalStale.status, 'cancelled');
  assert.equal(
    context.contract.contextCalls,
    5,
    'cancel after local staleness uses only the acknowledged upload identity'
  );
  assert.equal(
    context.contract.events.filter(event => event[0] === 'terminal').length,
    terminalCountBeforeLocalStale + 1
  );

  context.contract.restoreLocal();
  await context.contract.runCommunitySermonMediaUpload(reference, {
    rotateTerminalAttempt: true
  });
  const terminalCountBeforeFinalizationRace = context.contract.events
    .filter(event => event[0] === 'terminal').length;
  context.contract.finalizeBeforeNextDelete();
  await assert.rejects(
    context.contract.cancelCommunitySermonMediaUpload(reference),
    error => error?.code === 'FINALIZATION_IN_PROGRESS'
      && error.retryable === true
  );
  const finalizationRace = context.contract.communitySermonMediaUploads
    .values().next().value;
  assert.equal(finalizationRace.status, 'error');
  assert.equal(finalizationRace.progress.phase, 'finalizing');
  assert.equal(finalizationRace.resumeEligible, true);
  assert.equal(finalizationRace.restartRequired, false);
  assert.equal(
    finalizationRace.uploadId,
    'ABCDEFGHIJKLMNOPQRSTUVWX12345678'
  );
  assert.equal(
    context.contract.events.filter(event => event[0] === 'terminal').length,
    terminalCountBeforeFinalizationRace,
    'a finalization race preserves the successful replay attempt'
  );
});

test('Start and Resume enforce recovered stale-upload gates in Main', async () => {
  const source = `
    const communitySermonMediaUploads = new Map();
    const reference = {
      projectId: 'project-one',
      expectedProjectRevisionId: '${'a'.repeat(64)}',
      itemId: 'sermon-cue'
    };
    const key = [
      reference.projectId,
      reference.expectedProjectRevisionId,
      reference.itemId
    ].join('\\0');
    let state = {
      canUpload: false,
      canResume: false,
      message: 'Cancel old staging first.'
    };
    let runCalls = 0;
    function communitySermonMediaOperationKey() {
      return key;
    }
    async function communitySermonMediaAvailability() {
      return state;
    }
    async function runCommunitySermonMediaUpload(_reference, options) {
      runCalls += 1;
      return options;
    }
    function failMainOperation(code, message) {
      const error = new Error(message);
      error.code = code;
      throw error;
    }
    ${functionBlock(mainSource, 'beginCommunitySermonMediaUpload')}
    globalThis.contract = {
      beginCommunitySermonMediaUpload,
      communitySermonMediaUploads,
      reference,
      setState(next) {
        state = next;
      },
      get runCalls() {
        return runCalls;
      }
    };
  `;
  const context = { Error, Map };
  vm.runInNewContext(source, context, {
    filename: 'community-sermon-media-main-action-gate.js'
  });
  context.contract.communitySermonMediaUploads.set(
    [
      context.contract.reference.projectId,
      context.contract.reference.expectedProjectRevisionId,
      context.contract.reference.itemId
    ].join('\0'),
    {
      status: 'error',
      resumeEligible: false,
      uploadId: 'ABCDEFGHIJKLMNOPQRSTUVWX12345678'
    }
  );
  await assert.rejects(
    context.contract.beginCommunitySermonMediaUpload(
      context.contract.reference
    ),
    error => error?.code === 'SERMON_MEDIA_UPLOAD_CANCEL_REQUIRED'
  );
  await assert.rejects(
    context.contract.beginCommunitySermonMediaUpload(
      context.contract.reference,
      { resume: true }
    ),
    error => error?.code === 'SERMON_MEDIA_UPLOAD_CANCEL_REQUIRED'
  );
  assert.equal(context.contract.runCalls, 0);

  context.contract.communitySermonMediaUploads.clear();
  context.contract.setState({
    canUpload: false,
    canResume: true,
    message: 'Resume the exact paused upload.'
  });
  await assert.rejects(
    context.contract.beginCommunitySermonMediaUpload(
      context.contract.reference
    ),
    error => error?.code === 'SERMON_MEDIA_UPLOAD_NOT_STARTABLE'
  );
  const resumed = await context.contract.beginCommunitySermonMediaUpload(
    context.contract.reference,
    { resume: true }
  );
  assert.equal(resumed.rotateTerminalAttempt, false);
  assert.equal(context.contract.runCalls, 1);

  assert.match(
    handlerSource('prepare:communitySermonMedia:start'),
    /return beginCommunitySermonMediaUpload\(reference\)/
  );
  assert.match(
    handlerSource('prepare:communitySermonMedia:resume'),
    /return beginCommunitySermonMediaUpload\(reference,\s*\{\s*resume: true/
  );
});

test('Main claims persisted all-byte staging without project or local-media access', async () => {
  const source = `
    const events = [];
    const communitySermonMediaUploads = new Map();
    const reference = {
      projectId: 'project-one',
      expectedProjectRevisionId: '${'a'.repeat(64)}',
      itemId: 'sermon-cue'
    };
    function communitySermonMediaOperationKey(value) {
      return [
        value.projectId,
        value.expectedProjectRevisionId,
        value.itemId
      ].join('\\\\0');
    }
    function failMainOperation(code, message) {
      const error = new Error(message);
      error.code = code;
      throw error;
    }
    async function communitySermonMediaContext() {
      events.push(['unexpected-context']);
      throw new Error('finalization resume must not read the project');
    }
    function communitySermonMediaUploader() {
      throw new Error('finalization resume must retain the pinned uploader');
    }
    function communitySermonMediaAttemptIdentity() {
      throw new Error('finalization resume must retain attempt identity');
    }
    function communitySermonMediaAttemptKey() {
      throw new Error('finalization resume must retain the attempt key');
    }
    function communitySermonMediaRecoveryLocator() {
      throw new Error('finalization resume must retain the locator');
    }
    function publicCommunityError(error) {
      return { code: error.code || 'ERROR', message: error.message };
    }
    function publicCommunitySermonMediaProgress(progress) {
      if (!progress) return null;
      const { uploadId: _uploadId, ...safe } = progress;
      return safe;
    }
    function notifyCommunitySermonMediaProgress(
      _reference,
      status,
      progress
    ) {
      events.push(['notify', status, progress?.phase || null]);
    }
    const recoveryBinding = {
      sermonId: 'sermon-one',
      expectedSyncVersion: 1,
      expectedCurrentRevision: '${'b'.repeat(64)}',
      recording: {
        id: 'post-service:recording:en',
        kind: 'audio',
        language: 'en',
        mediaType: 'audio/mpeg',
        fileName: 'sermon.mp3',
        sha256: '${'c'.repeat(64)}',
        sizeBytes: 16,
        durationSeconds: null
      }
    };
    let finishFinalization;
    const finalizationGate = new Promise(resolve => {
      finishFinalization = resolve;
    });
    const uploader = {
      async resumeFinalization(binding, uploadId, { onProgress }) {
        events.push(['resume-finalization', binding, uploadId]);
        onProgress({
          phase: 'finalizing',
          uploadId,
          receivedBytes: 16,
          totalBytes: 16,
          receivedChunks: 2,
          chunkCount: 2,
          percent: 100,
          complete: false
        });
        await finalizationGate;
        return {
          upload: { id: uploadId },
          progress: {
            phase: 'complete',
            uploadId,
            receivedBytes: 16,
            totalBytes: 16,
            receivedChunks: 2,
            chunkCount: 2,
            percent: 100,
            complete: true
          }
        };
      },
      async upload() {
        events.push(['unexpected-upload']);
        throw new Error('finalization resume must not restart upload');
      }
    };
    const key = communitySermonMediaOperationKey(reference);
    communitySermonMediaUploads.set(key, {
      status: 'error',
      controller: null,
      uploader,
      uploadId: 'ABCDEFGHIJKLMNOPQRSTUVWX12345678',
      progress: {
        phase: 'uploading',
        uploadId: 'ABCDEFGHIJKLMNOPQRSTUVWX12345678',
        receivedBytes: 16,
        totalBytes: 16,
        receivedChunks: 2,
        chunkCount: 2,
        percent: 100,
        complete: false
      },
      error: { code: 'REQUEST_CANCELLED', message: 'paused' },
      promise: null,
      started: Promise.resolve(),
      attemptKey: '${'d'.repeat(64)}',
      attemptId: '11111111-1111-4111-8111-111111111111',
      attemptStore: {
        async markTerminal() {
          events.push(['unexpected-terminal']);
        }
      },
      attemptIdentity: {
        serverId: 'https://community.example.test/',
        communityId: 'wotbc'
      },
      recoveryLocator: '${'e'.repeat(64)}',
      recoveryBinding,
      resumeEligible: true,
      restartRequired: false
    });
    ${functionBlock(mainSource, 'communitySermonMediaRemoteBytesComplete')}
    ${functionBlock(mainSource, 'communitySermonMediaCanResumeWithoutLocal')}
    ${functionBlock(mainSource, 'communitySermonMediaFailureDisposition')}
    ${functionBlock(mainSource, 'runCommunitySermonMediaUpload')}
    globalThis.contract = {
      events,
      reference,
      recoveryBinding,
      finishFinalization,
      communitySermonMediaUploads,
      runCommunitySermonMediaUpload
    };
  `;
  const context = {
    AbortController,
    Error,
    Map,
    Object,
    Promise
  };
  vm.runInNewContext(source, context, {
    filename: 'community-sermon-media-main-finalization-resume.js'
  });

  const started = await context.contract.runCommunitySermonMediaUpload(
    context.contract.reference,
    { rotateTerminalAttempt: false }
  );
  assert.equal(started.progress.phase, 'finalizing');
  const operation = context.contract.communitySermonMediaUploads
    .values().next().value;
  context.contract.finishFinalization();
  await operation.promise;
  assert.equal(operation.status, 'complete');
  assert.equal(
    context.contract.events.some(event =>
      ['unexpected-context', 'unexpected-upload', 'unexpected-terminal']
        .includes(event[0])),
    false
  );
  const resume = context.contract.events.find(event =>
    event[0] === 'resume-finalization');
  assert.deepEqual(
    JSON.parse(JSON.stringify(resume[1])),
    JSON.parse(JSON.stringify(context.contract.recoveryBinding))
  );
  assert.equal(resume[2], 'ABCDEFGHIJKLMNOPQRSTUVWX12345678');
});

test('restart offers bindingless Resume only for complete remote geometry', async () => {
  const source = `
    const communitySermonMediaUploads = new Map();
    let remoteComplete = true;
    const attemptStore = {
      async readRecoverable() {
        return [{
          attemptKey: '${'f'.repeat(64)}',
          attemptId: '11111111-1111-4111-8111-111111111111',
          uploadId: 'ABCDEFGHIJKLMNOPQRSTUVWX12345678',
          terminal: false,
          binding: {
            sermonId: 'sermon-one',
            expectedSyncVersion: 1,
            expectedCurrentRevision: '${'b'.repeat(64)}',
            recording: {
              id: 'post-service:recording:en',
              kind: 'audio',
              language: 'en',
              mediaType: 'audio/mpeg',
              fileName: 'sermon.mp3',
              sha256: '${'c'.repeat(64)}',
              sizeBytes: 16,
              durationSeconds: null
            }
          }
        }];
      },
      async readAttempt() {
        throw new Error('there is no exact local binding while media is missing');
      },
      async acknowledgeUpload() {
        throw new Error('the recovered attempt already has an upload ID');
      },
      async markTerminal() {
        throw new Error('uploading staging is not terminal');
      }
    };
    const resolved = {
      connection: {
        baseUrl: 'https://community.example.test/',
        serverId: 'wotbc'
      },
      services: { communitySermonMediaAttemptStore: attemptStore }
    };
    const uploader = {
      async inspect(uploadId) {
        return {
          upload: {
            id: uploadId,
            state: 'uploading',
            sermon: {
              syncId: 'sermon-one',
              syncVersion: 1,
              currentRevision: '${'b'.repeat(64)}'
            },
            recording: {
              id: 'post-service:recording:en',
              kind: 'audio',
              language: 'en',
              mediaType: 'audio/mpeg',
              fileName: 'sermon.mp3',
              sha256: '${'c'.repeat(64)}',
              sizeBytes: 16,
              durationSeconds: null
            }
          },
          progress: {
            phase: 'uploading',
            uploadId,
            receivedBytes: remoteComplete ? 16 : 8,
            totalBytes: 16,
            receivedChunks: remoteComplete ? 2 : 1,
            chunkCount: 2,
            percent: remoteComplete ? 100 : 50,
            complete: false
          }
        };
      }
    };
    function communitySermonMediaOperationKey(reference) {
      return [
        reference.projectId,
        reference.expectedProjectRevisionId,
        reference.itemId
      ].join('\\\\0');
    }
    async function communitySermonMediaRecoveryAccess() {
      throw new Error('the supplied recovery context must be retained');
    }
    function communitySermonMediaAttemptIdentity() {
      return {
        serverId: 'https://community.example.test/',
        communityId: 'wotbc'
      };
    }
    function communitySermonMediaRecoveryLocator() {
      return '${'e'.repeat(64)}';
    }
    function communitySermonMediaUploader() {
      return uploader;
    }
    function communitySermonMediaObservedAttemptKey() {
      return '${'f'.repeat(64)}';
    }
    function publicCommunityError(error) {
      return { code: error.code || 'ERROR', message: error.message };
    }
    ${functionBlock(mainSource, 'communitySermonMediaRemoteBytesComplete')}
    ${functionBlock(mainSource, 'recoverCommunitySermonMediaOperation')}
    globalThis.contract = {
      communitySermonMediaUploads,
      recoverCommunitySermonMediaOperation,
      resolved,
      setRemoteComplete(value) {
        remoteComplete = value;
      }
    };
  `;
  const context = {
    Error,
    Map,
    Object,
    Promise
  };
  vm.runInNewContext(source, context, {
    filename: 'community-sermon-media-bindingless-recovery.js'
  });
  const reference = {
    projectId: 'project-one',
    expectedProjectRevisionId: 'a'.repeat(64),
    itemId: 'sermon-cue'
  };
  const complete = await context.contract
    .recoverCommunitySermonMediaOperation(reference, {
      context: context.contract.resolved,
      expectedAttemptKey: null,
      allowBindinglessCompletionRecovery: true
    });
  assert.equal(complete.resumeEligible, true);

  context.contract.communitySermonMediaUploads.clear();
  context.contract.setRemoteComplete(false);
  const partial = await context.contract
    .recoverCommunitySermonMediaOperation(reference, {
      context: context.contract.resolved,
      expectedAttemptKey: null,
      allowBindinglessCompletionRecovery: true
    });
  assert.equal(partial.resumeEligible, false);
  assert.equal(partial.progress.receivedBytes, 8);
});

test('restart can cancel an acknowledged upload when local media is missing', async () => {
  const source = `
    const events = [];
    const communitySermonMediaUploads = new Map();
    const reference = {
      projectId: 'project-one',
      expectedProjectRevisionId: '${'a'.repeat(64)}',
      itemId: 'sermon-cue'
    };
    const attemptStore = {
      async readRecoverable(key) {
        events.push(['read-attempt', key]);
        return [{
          attemptKey: '${'f'.repeat(64)}',
          attemptId: '11111111-1111-4111-8111-111111111111',
          uploadId: 'ABCDEFGHIJKLMNOPQRSTUVWX12345678',
          binding: {
            sermonId: 'sermon-one',
            expectedSyncVersion: 1,
            expectedCurrentRevision: '${'a'.repeat(64)}',
            recording: {}
          },
          terminal: false
        }];
      },
      async markTerminal(key, attemptId) {
        events.push(['terminal', key, attemptId]);
      }
    };
    const resolvedContext = {
      binding: {},
      connection: {
        baseUrl: 'https://community.example.test/',
        serverId: 'wotbc'
      },
      services: {
        communitySermonMediaAttemptStore: attemptStore,
        localSermonMediaStore: {
          async checkMedia() {
            events.push(['unexpected-local-check']);
            throw new Error('recording is missing');
          }
        }
      }
    };
    const uploader = {
      async inspect(uploadId) {
        events.push(['inspect', uploadId]);
        return {
          upload: {
            id: uploadId,
            state: 'uploading',
            sermon: {
              syncId: 'sermon-one',
              syncVersion: 1,
              currentRevision: '${'a'.repeat(64)}'
            },
            recording: {}
          },
          progress: {
            phase: 'uploading',
            uploadId,
            receivedBytes: 0,
            totalBytes: 16,
            receivedChunks: 0,
            chunkCount: 2,
            percent: 0,
            complete: false
          }
        };
      },
      async cancel(uploadId) {
        events.push(['delete', uploadId]);
        return {
          upload: { id: uploadId },
          progress: {
            phase: 'cancelled',
            uploadId,
            receivedBytes: 0,
            totalBytes: 16,
            receivedChunks: 0,
            chunkCount: 2,
            percent: 0,
            complete: false
          }
        };
      }
    };
    function communitySermonMediaOperationKey(value) {
      return [
        value.projectId,
        value.expectedProjectRevisionId,
        value.itemId
      ].join('\\\\0');
    }
    async function communitySermonMediaContext() {
      events.push(['context-without-local-byte-check']);
      return resolvedContext;
    }
    async function communitySermonMediaRecoveryAccess() {
      events.push(['recovery-access-without-local-byte-check']);
      return resolvedContext;
    }
    function communitySermonMediaAttemptIdentity() {
      return {
        serverId: 'https://community.example.test/',
        communityId: 'wotbc'
      };
    }
    function communitySermonMediaRecoveryLocator() {
      return '${'e'.repeat(64)}';
    }
    function communitySermonMediaObservedAttemptKey() {
      return '${'f'.repeat(64)}';
    }
    function communitySermonMediaAttemptKey() {
      return '${'f'.repeat(64)}';
    }
    function communitySermonMediaUploader() {
      return uploader;
    }
    function publicCommunityError(error) {
      return { code: error.code || 'ERROR', message: error.message };
    }
    function publicCommunitySermonMediaProgress(progress) {
      if (!progress) return null;
      const { uploadId: _uploadId, ...safe } = progress;
      return safe;
    }
    function notifyCommunitySermonMediaProgress(_reference, status) {
      events.push(['notify', status]);
    }
    function failMainOperation(code, message) {
      const error = new Error(message);
      error.code = code;
      throw error;
    }
    ${functionBlock(mainSource, 'communitySermonMediaRemoteBytesComplete')}
    ${functionBlock(mainSource, 'recoverCommunitySermonMediaOperation')}
    ${functionBlock(mainSource, 'communitySermonMediaCanCancel')}
    ${functionBlock(mainSource, 'communitySermonMediaFailureDisposition')}
    ${functionBlock(mainSource, 'cancelCommunitySermonMediaUpload')}
    globalThis.contract = {
      reference,
      events,
      communitySermonMediaUploads,
      cancelCommunitySermonMediaUpload
    };
  `;
  const context = {
    Error,
    Map,
    Object,
    Promise
  };
  vm.runInNewContext(source, context, {
    filename: 'community-sermon-media-restart-cancel.js'
  });

  const cancelled = await context.contract
    .cancelCommunitySermonMediaUpload(context.contract.reference);
  assert.equal(cancelled.status, 'cancelled');
  assert.equal(
    context.contract.events.some(event =>
      event[0] === 'unexpected-local-check'),
    false
  );
  assert.deepEqual(
    JSON.parse(JSON.stringify(
      context.contract.events
        .filter(event =>
          ['read-attempt', 'delete', 'terminal'].includes(event[0]))
        .map(event => event[0])
    )),
    ['read-attempt', 'delete', 'terminal']
  );
  const operation = context.contract.communitySermonMediaUploads
    .values().next().value;
  assert.equal(operation.status, 'cancelled');
  assert.equal(operation.uploadId, 'ABCDEFGHIJKLMNOPQRSTUVWX12345678');
});

test('real v3 locator replays a missing ACK and cancels after binding drift', async t => {
  const temporaryRoot = await fsPromises.mkdtemp(
    path.join(os.tmpdir(), 'syncshow-main-media-recovery-')
  );
  const rootPath = await fsPromises.realpath(temporaryRoot);
  t.after(() => fsPromises.rm(rootPath, {
    recursive: true,
    force: true
  }));
  const identity = {
    serverId: 'https://community.example.test/',
    communityId: 'wotbc'
  };
  const reference = {
    projectId: 'project-one',
    expectedProjectRevisionId: '9'.repeat(64),
    itemId: 'sermon-cue'
  };
  const recording = {
    id: 'post-service:recording:en',
    kind: 'audio',
    language: 'en',
    mediaType: 'audio/mpeg',
    fileName: 'old-sermon.mp3',
    sha256: 'b'.repeat(64),
    sizeBytes: 8_388_614,
    durationSeconds: null
  };
  const oldBinding = {
    projectId: reference.projectId,
    projectRevisionId: '1'.repeat(64),
    itemId: reference.itemId,
    sermonId: 'old-sermon',
    sermonRevisionId: 'a'.repeat(64),
    expectedSyncVersion: 7,
    expectedCurrentRevision: 'a'.repeat(64),
    recording
  };
  const attemptKey = sermonMediaAttemptBindingKey(oldBinding, identity);
  const locator = sermonMediaAttemptRecoveryLocator(oldBinding, identity);
  const attemptStore = new CommunitySermonMediaAttemptStore({
    rootPath,
    randomUUID: () => '11111111-1111-4111-8111-111111111111',
    now: () => new Date('2026-08-02T18:30:00.000Z')
  });
  const attempt = await attemptStore.attemptFor(attemptKey, {
    recoveryLocator: locator,
    recoveryBinding: {
      sermonId: oldBinding.sermonId,
      expectedSyncVersion: oldBinding.expectedSyncVersion,
      expectedCurrentRevision: oldBinding.expectedCurrentRevision,
      recording
    }
  });

  const inspectedUpload = {
    id: 'ABCDEFGHIJKLMNOPQRSTUVWX12345678',
    state: 'uploading',
    sermon: {
      syncId: oldBinding.sermonId,
      syncVersion: oldBinding.expectedSyncVersion,
      currentRevision: oldBinding.expectedCurrentRevision
    },
    recording
  };
  let recoverInitCalls = 0;
  const uploader = {
    async recoverInit(savedBinding, attemptId) {
      recoverInitCalls += 1;
      assert.deepEqual(savedBinding, {
        sermonId: oldBinding.sermonId,
        expectedSyncVersion: oldBinding.expectedSyncVersion,
        expectedCurrentRevision: oldBinding.expectedCurrentRevision,
        recording
      });
      assert.equal(attemptId, attempt.attemptId);
      return {
        upload: inspectedUpload,
        progress: {
          phase: 'uploading',
          uploadId: inspectedUpload.id,
          receivedBytes: 0,
          totalBytes: recording.sizeBytes,
          receivedChunks: 0,
          chunkCount: 2,
          percent: 0,
          complete: false
        }
      };
    },
    async inspect() {
      throw new Error('missing local ACK must replay init first');
    },
    async cancel(uploadId) {
      return {
        upload: { id: uploadId, state: 'cancelled' },
        progress: {
          phase: 'cancelled',
          uploadId,
          receivedBytes: 0,
          totalBytes: recording.sizeBytes,
          receivedChunks: 0,
          chunkCount: 2,
          percent: 0,
          complete: false
        }
      };
    }
  };
  const source = `
    const communitySermonMediaUploads = new Map();
    const resolvedContext = {
      connection: {
        baseUrl: 'https://community.example.test/',
        serverId: 'wotbc'
      },
      resource: { endpoint: 'sermon-media' },
      services: {
        communitySermonMediaAttemptStore: injectedAttemptStore
      }
    };
    function communitySermonMediaOperationKey(value) {
      return [
        value.projectId,
        value.expectedProjectRevisionId,
        value.itemId
      ].join('\\\\0');
    }
    async function communitySermonMediaRecoveryAccess() {
      return resolvedContext;
    }
    function communitySermonMediaUploader() {
      return injectedUploader;
    }
    function publicCommunityError(error) {
      return { code: error.code || 'ERROR', message: error.message };
    }
    function publicCommunitySermonMediaProgress(progress) {
      if (!progress) return null;
      const { uploadId: _uploadId, ...safe } = progress;
      return safe;
    }
    function notifyCommunitySermonMediaProgress() {}
    function failMainOperation(code, message) {
      const error = new Error(message);
      error.code = code;
      throw error;
    }
    ${functionBlock(mainSource, 'communitySermonMediaAttemptIdentity')}
    ${functionBlock(mainSource, 'communitySermonMediaRecoveryLocator')}
    ${functionBlock(mainSource, 'communitySermonMediaObservedAttemptKey')}
    ${functionBlock(mainSource, 'communitySermonMediaRemoteBytesComplete')}
    ${functionBlock(mainSource, 'recoverCommunitySermonMediaOperation')}
    ${functionBlock(mainSource, 'communitySermonMediaCanCancel')}
    ${functionBlock(mainSource, 'communitySermonMediaFailureDisposition')}
    ${functionBlock(mainSource, 'cancelCommunitySermonMediaUpload')}
    globalThis.contract = {
      cancelCommunitySermonMediaUpload,
      communitySermonMediaUploads
    };
  `;
  const context = {
    Error,
    Map,
    Object,
    Promise,
    injectedAttemptStore: attemptStore,
    injectedUploader: uploader,
    sermonMediaAttemptBindingKey,
    sermonMediaAttemptRecoveryLocator
  };
  vm.runInNewContext(source, context, {
    filename: 'community-sermon-media-real-locator-recovery.js'
  });

  const result = await context.contract
    .cancelCommunitySermonMediaUpload(reference);
  assert.equal(result.status, 'cancelled');
  assert.equal(recoverInitCalls, 1);
  const savedAttempt = await attemptStore.readAttempt(attemptKey);
  assert.equal(savedAttempt.terminal, true);
  assert.equal(
    savedAttempt.uploadId,
    'ABCDEFGHIJKLMNOPQRSTUVWX12345678'
  );
  assert.equal(
    context.contract.communitySermonMediaUploads.values().next().value.status,
    'cancelled'
  );
});

test('renderer may send stable IDs and revisions but never paths, tokens, or URLs', async () => {
  const { api, calls } = preloadBridge();
  const request = {
    projectId: 'project-one',
    expectedRevisionId: 'a'.repeat(64),
    itemId: 'sermon-cue',
    filePath: '/private/sermon.mp3',
    accessToken: 'must-not-cross',
    uploadId: 'must-not-cross',
    publicUrl: 'https://attacker.example/'
  };
  await api.getCommunitySermonMediaStateForServiceItem(request);
  await api.enableCommunitySermonMediaForServiceItem(request);
  await api.uploadCommunitySermonMediaForServiceItem(request);
  await api.resumeCommunitySermonMediaForServiceItem(request);
  await api.cancelCommunitySermonMediaForServiceItem(request);

  assert.deepEqual(
    calls.map(call => call.channel),
    [
      'prepare:communitySermonMedia:getState',
      'prepare:communitySermonMedia:enable',
      'prepare:communitySermonMedia:start',
      'prepare:communitySermonMedia:resume',
      'prepare:communitySermonMedia:cancel'
    ]
  );
  for (const call of calls) {
    assert.deepEqual(
      Object.keys(call.payload).sort(),
      ['expectedRevisionId', 'itemId', 'projectId']
    );
  }

  const reference = functionBlock(
    mainSource,
    'communitySermonMediaReference'
  );
  assert.match(reference, /requireExactPrepareKeys/);
  assert.doesNotMatch(reference, /file|path|token|url|uploadId/i);

  const projection = functionBlock(
    mainSource,
    'publicCommunitySermonMediaProgress'
  );
  assert.doesNotMatch(projection, /uploadId|file|path|token|url/i);
});

test('progress events expose cancellation and restart semantics without upload IDs', () => {
  const notify = functionBlock(
    mainSource,
    'notifyCommunitySermonMediaProgress'
  );
  assert.match(notify, /canCancel:/);
  assert.match(notify, /canUpload:/);
  assert.match(notify, /canResume:/);
  assert.match(notify, /publicCommunitySermonMediaProgress/);
  assert.doesNotMatch(notify, /accessToken|filePath|publicUrl/);

  const source = `
    const sent = [];
    const controlWindow = {
      isDestroyed() { return false; },
      webContents: {
        send(channel, payload) {
          sent.push([channel, payload]);
        }
      }
    };
    function publicCommunityError(error) { return error; }
    function publicCommunitySermonMediaProgress() { return null; }
    ${functionBlock(mainSource, 'communitySermonMediaCanCancel')}
    ${notify}
    globalThis.contract = {
      notifyCommunitySermonMediaProgress,
      sent
    };
  `;
  const context = { console };
  vm.runInNewContext(source, context, {
    filename: 'community-sermon-media-progress-restart.js'
  });
  const reference = {
    projectId: 'project-one',
    expectedProjectRevisionId: 'a'.repeat(64),
    itemId: 'sermon-cue'
  };
  const progress = {
    uploadId: 'ABCDEFGHIJKLMNOPQRSTUVWX12345678'
  };
  context.contract.notifyCommunitySermonMediaProgress(
    reference,
    'error',
    progress,
    { code: 'UPLOAD_EXPIRED', message: 'expired' },
    { restartRequired: true }
  );
  context.contract.notifyCommunitySermonMediaProgress(
    reference,
    'error',
    progress,
    { code: 'NETWORK_ERROR', message: 'offline' },
    { restartRequired: false }
  );
  context.contract.notifyCommunitySermonMediaProgress(
    reference,
    'uploading',
    { ...progress, phase: 'finalizing' },
    null,
    { restartRequired: false }
  );
  context.contract.notifyCommunitySermonMediaProgress(
    reference,
    'error',
    { ...progress, phase: 'uploading' },
    { code: 'LOCAL_RECORDING_CHANGED', message: 'changed' },
    { restartRequired: false, resumeEligible: false }
  );
  assert.equal(context.contract.sent[0][1].canCancel, false);
  assert.equal(context.contract.sent[0][1].canUpload, true);
  assert.equal(context.contract.sent[1][1].canCancel, true);
  assert.equal(context.contract.sent[1][1].canResume, true);
  assert.equal(
    context.contract.sent[2][1].canCancel,
    false,
    'a live finalization lease never offers a guaranteed-failing Cancel action'
  );
  assert.equal(context.contract.sent[3][1].canCancel, true);
  assert.equal(
    context.contract.sent[3][1].canResume,
    false,
    'local staleness preserves Cancel but cannot offer Resume'
  );
});

test('finalization cancellation gate is state-derived in every Main path', () => {
  const source = `
    ${functionBlock(mainSource, 'communitySermonMediaCanCancel')}
    ${functionBlock(mainSource, 'communitySermonMediaRemoteBytesComplete')}
    ${functionBlock(mainSource, 'communitySermonMediaCanResumeWithoutLocal')}
    ${functionBlock(mainSource, 'communitySermonMediaFailureDisposition')}
    globalThis.canCancel = communitySermonMediaCanCancel;
    globalThis.canResumeWithoutLocal =
      communitySermonMediaCanResumeWithoutLocal;
    globalThis.failureDisposition =
      communitySermonMediaFailureDisposition;
  `;
  const context = {};
  vm.runInNewContext(source, context, {
    filename: 'community-sermon-media-finalization-cancel-gate.js'
  });
  const uploadId = 'ABCDEFGHIJKLMNOPQRSTUVWX12345678';
  assert.equal(context.canCancel({
    status: 'uploading',
    uploadId,
    progress: { phase: 'uploading' }
  }), true);
  assert.equal(context.canCancel({
    status: 'uploading',
    uploadId,
    progress: { phase: 'finalizing' }
  }), false);
  assert.equal(context.canCancel({
    status: 'error',
    uploadId,
    progress: { phase: 'finalizing' }
  }), false);
  assert.equal(context.canCancel({
    status: 'error',
    uploadId,
    progress: { phase: 'uploading' },
    restartRequired: true
  }), false);
  const fullRemoteProgress = {
    phase: 'uploading',
    uploadId,
    receivedBytes: 16,
    totalBytes: 16,
    receivedChunks: 2,
    chunkCount: 2
  };
  assert.equal(context.canResumeWithoutLocal({
    status: 'error',
    uploadId,
    progress: fullRemoteProgress,
    resumeEligible: true,
    restartRequired: false
  }), true, 'missing local media may resume when Community has every byte');
  assert.equal(context.canCancel({
    status: 'error',
    uploadId,
    progress: fullRemoteProgress
  }), true, 'unclaimed all-byte staging remains cancellable');
  assert.equal(context.canResumeWithoutLocal({
    status: 'error',
    uploadId,
    progress: {
      ...fullRemoteProgress,
      receivedBytes: 8,
      receivedChunks: 1
    },
    resumeEligible: true,
    restartRequired: false
  }), false, 'partial remote staging is cancel-only when local media is missing');
  assert.deepEqual(
    JSON.parse(JSON.stringify(context.failureDisposition({
      code: 'LOCAL_RECORDING_CHANGED',
      stale: true,
      cause: null
    }, uploadId))),
    {
      status: 'error',
      restartRequired: false,
      preserveForCancellation: true
    }
  );
  assert.deepEqual(
    JSON.parse(JSON.stringify(context.failureDisposition({
      code: 'SERMON_MEDIA_STALE',
      stale: true,
      cause: 'STALE_SERMON_BINDING'
    }, uploadId))),
    {
      status: 'stale',
      restartRequired: true,
      preserveForCancellation: false
    }
  );

  const availability = functionBlock(
    mainSource,
    'communitySermonMediaAvailability'
  );
  const cancel = functionBlock(
    mainSource,
    'cancelCommunitySermonMediaUpload'
  );
  assert.match(availability, /communitySermonMediaCanCancel/);
  assert.match(
    availability,
    /active\?\.status === 'complete'[\s\S]*local file is no longer needed/
  );
  assert.match(
    availability,
    /Community already has every verified recording chunk/
  );
  assert.match(cancel, /communitySermonMediaCanCancel/);
});

test('recovery GET identity derives the exact persisted attempt key', () => {
  const source = `
    ${functionBlock(mainSource, 'communitySermonMediaObservedAttemptKey')}
    globalThis.observed = communitySermonMediaObservedAttemptKey;
  `;
  const context = { sermonMediaAttemptBindingKey };
  vm.runInNewContext(source, context, {
    filename: 'community-sermon-media-observed-key.js'
  });
  const identity = {
    serverId: 'https://community.example.test/',
    communityId: 'wotbc'
  };
  const recording = {
    id: 'post-service:recording:en',
    kind: 'audio',
    language: 'en',
    mediaType: 'audio/mpeg',
    fileName: 'sermon.mp3',
    sha256: 'b'.repeat(64),
    sizeBytes: 8_388_614,
    durationSeconds: null
  };
  const expected = sermonMediaAttemptBindingKey({
    sermonId: 'sermon-one',
    sermonRevisionId: 'a'.repeat(64),
    expectedSyncVersion: 7,
    expectedCurrentRevision: 'a'.repeat(64),
    recording
  }, identity);
  const observed = context.observed({
    sermon: {
      syncId: 'sermon-one',
      syncVersion: 7,
      currentRevision: 'a'.repeat(64)
    },
    recording
  }, identity);
  assert.equal(observed, expected);
});
