'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');

const {
  CommunityBinaryClientError
} = require('../src/services/community/CommunityBinaryClient');
const {
  CommunitySermonMediaUpload,
  CommunitySermonMediaUploadError,
  SERMON_MEDIA_CHUNK_REQUEST_TIMEOUT_MS,
  SERMON_MEDIA_COMPLETE_REQUEST_TIMEOUT_MS,
  SERMON_MEDIA_CONTROL_REQUEST_TIMEOUT_MS,
  SERMON_MEDIA_FINALIZATION_MAX_WAIT_MS,
  SERMON_MEDIA_FINALIZATION_REPLAY_INTERVAL_MS
} = require('../src/services/community/CommunitySermonMediaUpload');

const fixturePath = path.join(
  __dirname,
  'fixtures',
  'community-sermon-media-wire-v1.json'
);
const PROJECT_REVISION = '1'.repeat(64);
const ATTEMPT_ID = '11111111-1111-4111-8111-111111111111';
const NEW_ATTEMPT_ID = '22222222-2222-4222-8222-222222222222';

async function fixture() {
  return JSON.parse(await fs.readFile(fixturePath, 'utf8'));
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function reference() {
  return {
    projectId: 'service-project',
    expectedProjectRevisionId: PROJECT_REVISION,
    itemId: 'sermon-cue'
  };
}

function binding(vector, overrides = {}) {
  return {
    projectId: 'service-project',
    projectRevisionId: PROJECT_REVISION,
    itemId: 'sermon-cue',
    sermonId: vector.initRequest.sermon.syncId,
    sermonRevisionId:
      vector.initRequest.sermon.expectedCurrentRevision,
    expectedSyncVersion:
      vector.initRequest.sermon.expectedSyncVersion,
    expectedCurrentRevision:
      vector.initRequest.sermon.expectedCurrentRevision,
    recording: clone(vector.initRequest.recording),
    ...overrides
  };
}

function receivedBytes(vector, receivedChunks) {
  return receivedChunks.reduce((total, index) => (
    total + (index === 0
      ? vector.discoveryResource.chunkSizeBytes
      : vector.initRequest.recording.sizeBytes
        - vector.discoveryResource.chunkSizeBytes)
  ), 0);
}

function uploadEnvelope(vector, {
  state = 'uploading',
  receivedChunks = []
} = {}) {
  const envelope = clone(vector.uploadingResponse);
  envelope.upload.state = state;
  envelope.upload.receivedChunks = [...receivedChunks].sort((a, b) => a - b);
  envelope.upload.receivedBytes = receivedBytes(vector, receivedChunks);
  envelope.upload.completedAt = state === 'complete'
    ? vector.completeResponse.upload.completedAt
    : null;
  return envelope;
}

function chunkEnvelope(vector, index, receivedChunks) {
  const source = index === 0
    ? vector.firstChunkResponse.chunk
    : {
        index: vector.secondChunk.index,
        sha256: vector.secondChunk.sha256,
        sizeBytes: vector.secondChunk.sizeBytes,
        receivedAt: '2026-08-02T18:31:30.000Z'
      };
  return {
    schemaVersion: 1,
    chunk: clone(source),
    upload: uploadEnvelope(vector, { receivedChunks }).upload
  };
}

function mediaStore(vector, bytes, {
  shortRead = false
} = {}) {
  let sessions = 0;
  let closed = 0;
  return {
    get sessions() {
      return sessions;
    },
    get closed() {
      return closed;
    },
    async checkMedia() {
      return {
        sha256: vector.initRequest.recording.sha256,
        sizeBytes: bytes.length,
        kind: 'audio',
        mediaType: 'audio/mpeg'
      };
    },
    async openMediaReadSession() {
      sessions += 1;
      return {
        sha256: vector.initRequest.recording.sha256,
        sizeBytes: bytes.length,
        kind: 'audio',
        mediaType: 'audio/mpeg',
        async read(offset, length) {
          if (shortRead) {
            return bytes.subarray(offset, offset + Math.max(0, length - 1));
          }
          return bytes.subarray(offset, offset + length);
        },
        async close() {
          closed += 1;
        }
      };
    }
  };
}

function fakeServer(vector, {
  initialReceived = [],
  initState = 'uploading',
  onBinary = null,
  completionMode = 'synchronous',
  completionFailures = 0,
  finalizingPolls = 0,
  onCompleteClaim = null,
  onInitResponse = null
} = {}) {
  const calls = [];
  let received = [...initialReceived];
  let completionClaimed = initState === 'finalizing';
  let remainingFinalizingPolls = finalizingPolls;
  let remainingCompletionFailures = completionFailures;
  let completionResponseLost = completionMode === 'lost-202';
  const envelopeForState = state => uploadEnvelope(vector, {
    state,
    receivedChunks: ['complete', 'finalizing'].includes(state)
      ? [0, 1]
      : received
  });
  return {
    calls,
    client: {
      async requestJson(options) {
        calls.push({ type: 'json', ...options });
        if (options.method === 'POST' && options.path === 'uploads') {
          const result = {
            status: initState === 'complete' ? 200 : 201,
            payload: envelopeForState(initState)
          };
          await onInitResponse?.(options, result);
          return result;
        }
        if (options.method === 'GET') {
          if (completionClaimed || initState === 'finalizing') {
            if (remainingFinalizingPolls > 0) {
              remainingFinalizingPolls -= 1;
              return {
                status: 200,
                payload: envelopeForState('finalizing')
              };
            }
            return {
              status: 200,
              payload: envelopeForState('complete')
            };
          }
          return {
            status: 200,
            payload: envelopeForState(
              initState === 'complete' ? 'complete' : 'uploading'
            )
          };
        }
        if (options.method === 'POST' && options.path.endsWith('/complete')) {
          if (remainingCompletionFailures > 0) {
            remainingCompletionFailures -= 1;
            throw new CommunityBinaryClientError(
              'SERVER_UNAVAILABLE',
              'The completion claim did not reach Community.',
              { status: 524, retryable: true }
            );
          }
          completionClaimed = true;
          await onCompleteClaim?.(options);
          if (completionResponseLost) {
            completionResponseLost = false;
            throw new CommunityBinaryClientError(
              'SERVER_UNAVAILABLE',
              'The proxy lost the durable completion response.',
              { status: 524, retryable: true }
            );
          }
          if (completionMode !== 'synchronous') {
            return {
              status: 202,
              payload: envelopeForState('finalizing')
            };
          }
          return {
            status: 200,
            payload: envelopeForState('complete')
          };
        }
        if (options.method === 'DELETE') {
          return {
            status: 200,
            payload: uploadEnvelope(vector, {
              state: 'cancelled',
              receivedChunks: received
            })
          };
        }
        throw new Error(`Unexpected JSON call: ${options.method} ${options.path}`);
      },
      async requestBinary(options) {
        calls.push({ type: 'binary', ...options });
        if (onBinary) await onBinary(options);
        const parts = [];
        for await (const part of options.body) parts.push(Buffer.from(part));
        const body = Buffer.concat(parts);
        const index = Number(options.path.split('/').pop());
        assert.equal(body.length, options.contentLength);
        assert.equal(
          crypto.createHash('sha256').update(body).digest('hex'),
          options.sha256
        );
        if (!received.includes(index)) {
          received = [...received, index].sort((a, b) => a - b);
        }
        return {
          status: 201,
          payload: chunkEnvelope(vector, index, received)
        };
      }
    }
  };
}

test('resume trusts server state, sends only missing chunks, then completes privately', async () => {
  const vector = await fixture();
  const bytes = Buffer.alloc(vector.initRequest.recording.sizeBytes, 0x61);
  const local = mediaStore(vector, bytes);
  const server = fakeServer(vector, { initialReceived: [0] });
  let resolveCount = 0;
  const progress = [];
  const uploader = new CommunitySermonMediaUpload({
    client: server.client,
    mediaStore: local,
    resolveBinding: async () => {
      resolveCount += 1;
      return binding(vector);
    }
  });

  const result = await uploader.upload(reference(), {
    attemptId: ATTEMPT_ID,
    onProgress: value => progress.push(value)
  });

  assert.equal(result.upload.state, 'complete');
  assert.equal(result.progress.complete, true);
  assert.equal(result.progress.percent, 100);
  assert.ok(resolveCount >= 7, 'binding is re-resolved around each remote step');
  assert.equal(local.sessions, 1, 'the confirmed first chunk is never reopened');
  assert.equal(local.closed, 1);

  const binaryCalls = server.calls.filter(call => call.type === 'binary');
  assert.equal(binaryCalls.length, 1);
  assert.match(binaryCalls[0].path, /\/chunks\/1$/u);
  assert.equal(binaryCalls[0].contentLength, 6);
  assert.equal(
    binaryCalls[0].contentRange,
    vector.secondChunk.contentRange
  );
  assert.equal(binaryCalls[0].sha256, vector.secondChunk.sha256);
  assert.equal(
    binaryCalls[0].timeoutMs,
    SERMON_MEDIA_CHUNK_REQUEST_TIMEOUT_MS
  );
  assert.match(
    binaryCalls[0].idempotencyKey,
    /^syncshow-media-chunk:[a-f0-9]{64}$/u
  );

  const init = server.calls.find(call =>
    call.type === 'json'
    && call.method === 'POST'
    && call.path === 'uploads');
  assert.deepEqual(init.body, vector.initRequest);
  assert.match(
    init.headers['Idempotency-Key'],
    /^syncshow-media-init:[a-f0-9]{64}$/u
  );
  assert.equal(init.timeoutMs, SERMON_MEDIA_CONTROL_REQUEST_TIMEOUT_MS);
  const completion = server.calls.find(call =>
    call.type === 'json'
    && call.method === 'POST'
    && call.path.endsWith('/complete'));
  assert.deepEqual(completion.expectedStatuses, [200, 202]);
  assert.equal(
    completion.timeoutMs,
    SERMON_MEDIA_COMPLETE_REQUEST_TIMEOUT_MS
  );
  for (const call of server.calls.filter(candidate =>
    candidate.type === 'json' && candidate !== completion)) {
    assert.equal(
      call.timeoutMs,
      SERMON_MEDIA_CONTROL_REQUEST_TIMEOUT_MS
    );
  }
  assert.equal(
    server.calls.some(call => call.method === 'DELETE'),
    false,
    'success never invokes a publication or cancellation route'
  );
  assert.deepEqual(
    progress.map(item => item.phase),
    ['starting', 'uploading', 'uploading', 'complete']
  );
});

test('202 completion polls by identity and tolerates local loss after claim', async () => {
  const vector = await fixture();
  const bytes = Buffer.alloc(vector.initRequest.recording.sizeBytes, 0x61);
  let localAvailable = true;
  let bindingAvailable = true;
  const baseMedia = mediaStore(vector, bytes);
  const local = {
    get sessions() {
      return baseMedia.sessions;
    },
    async checkMedia(recording) {
      if (!localAvailable) throw new Error('recording disappeared after claim');
      return baseMedia.checkMedia(recording);
    },
    async openMediaReadSession(recording, options) {
      if (!localAvailable) throw new Error('recording disappeared after claim');
      return baseMedia.openMediaReadSession(recording, options);
    }
  };
  const server = fakeServer(vector, {
    completionMode: 'asynchronous',
    finalizingPolls: 2,
    onCompleteClaim() {
      localAvailable = false;
      bindingAvailable = false;
    }
  });
  let nowMs = 0;
  const delays = [];
  const progress = [];
  const uploader = new CommunitySermonMediaUpload({
    client: server.client,
    mediaStore: local,
    resolveBinding: async () => {
      if (!bindingAvailable) {
        throw new Error('service moved after durable completion claim');
      }
      return binding(vector);
    },
    async waitForFinalizationPoll(delayMs, signal) {
      assert.equal(signal?.aborted, false);
      delays.push(delayMs);
      nowMs += delayMs;
    },
    now: () => nowMs
  });

  const result = await uploader.upload(reference(), {
    attemptId: ATTEMPT_ID,
    signal: new AbortController().signal,
    onProgress: value => progress.push(value)
  });

  assert.equal(result.upload.state, 'complete');
  assert.equal(result.progress.complete, true);
  assert.deepEqual(delays, [1_000, 2_000, 4_000]);
  assert.equal(baseMedia.sessions, 2, 'only the two source chunks are opened');
  assert.deepEqual(
    server.calls
      .filter(call => call.method === 'GET')
      .slice(-3)
      .map(call => call.timeoutMs),
    [
      SERMON_MEDIA_CONTROL_REQUEST_TIMEOUT_MS,
      SERMON_MEDIA_CONTROL_REQUEST_TIMEOUT_MS,
      SERMON_MEDIA_CONTROL_REQUEST_TIMEOUT_MS
    ]
  );
  assert.ok(
    progress.some(item => item.phase === 'finalizing'),
    'the asynchronous claim is visible while cancellation is unavailable'
  );
});

test('lost 202 completion response reconciles through authoritative polling', async () => {
  const vector = await fixture();
  const bytes = Buffer.alloc(vector.initRequest.recording.sizeBytes, 0x61);
  const server = fakeServer(vector, {
    completionMode: 'lost-202',
    finalizingPolls: 1
  });
  let nowMs = 0;
  const uploader = new CommunitySermonMediaUpload({
    client: server.client,
    mediaStore: mediaStore(vector, bytes),
    resolveBinding: async () => binding(vector),
    async waitForFinalizationPoll(delayMs) {
      nowMs += delayMs;
    },
    now: () => nowMs
  });

  const result = await uploader.upload(reference(), {
    attemptId: ATTEMPT_ID
  });

  assert.equal(result.upload.state, 'complete');
  assert.equal(
    server.calls.filter(call =>
      call.method === 'POST' && call.path.endsWith('/complete')).length,
    1,
    'a successful identity GET prevents an unsafe completion re-POST'
  );
  assert.ok(
    server.calls.some(call =>
      call.method === 'GET'
      && call.path ===
        'uploads/ABCDEFGHIJKLMNOPQRSTUVWX12345678'),
    'a lost response is reconciled with identity-only authoritative GET'
  );
});

test('restart during finalization skips local revalidation after init replay', async () => {
  const vector = await fixture();
  const bytes = Buffer.alloc(vector.initRequest.recording.sizeBytes, 0x61);
  let localAvailable = true;
  const baseMedia = mediaStore(vector, bytes);
  const server = fakeServer(vector, {
    initialReceived: [0, 1],
    initState: 'finalizing',
    finalizingPolls: 1,
    onInitResponse() {
      localAvailable = false;
    }
  });
  let nowMs = 0;
  const uploader = new CommunitySermonMediaUpload({
    client: server.client,
    mediaStore: {
      async checkMedia(recording) {
        if (!localAvailable) {
          throw new Error('local file must not be rechecked after init replay');
        }
        return baseMedia.checkMedia(recording);
      },
      async openMediaReadSession() {
        throw new Error('finalizing replay must not reopen local bytes');
      }
    },
    resolveBinding: async () => binding(vector),
    async waitForFinalizationPoll(delayMs) {
      nowMs += delayMs;
    },
    now: () => nowMs
  });

  const result = await uploader.upload(reference(), {
    attemptId: ATTEMPT_ID
  });

  assert.equal(result.upload.state, 'complete');
  assert.equal(baseMedia.sessions, 0);
  assert.equal(
    server.calls.filter(call => call.type === 'binary').length,
    0
  );
  assert.equal(
    `${server.calls[0].method} ${server.calls[0].path}`,
    'POST uploads'
  );
  assert.ok(
    server.calls.slice(1).length >= 2
      && server.calls.slice(1).every(call =>
        call.method === 'GET'
        && call.path ===
          'uploads/ABCDEFGHIJKLMNOPQRSTUVWX12345678'),
    'restart reconciliation uses only identity GETs after init replay'
  );
});

test('persisted finalization recovery needs no project binding or local bytes', async () => {
  const vector = await fixture();
  const server = fakeServer(vector, {
    initialReceived: [0, 1],
    initState: 'finalizing',
    finalizingPolls: 1
  });
  let nowMs = 0;
  const progress = [];
  const uploader = new CommunitySermonMediaUpload({
    client: server.client,
    mediaStore: {
      async checkMedia() {
        throw new Error('persisted finalization must not check local media');
      },
      async openMediaReadSession() {
        throw new Error('persisted finalization must not open local media');
      }
    },
    resolveBinding: async () => {
      throw new Error('persisted finalization must not resolve the project');
    },
    async waitForFinalizationPoll(delayMs) {
      nowMs += delayMs;
    },
    now: () => nowMs
  });

  const result = await uploader.resumeFinalization({
    sermonId: vector.initRequest.sermon.syncId,
    expectedSyncVersion:
      vector.initRequest.sermon.expectedSyncVersion,
    expectedCurrentRevision:
      vector.initRequest.sermon.expectedCurrentRevision,
    recording: clone(vector.initRequest.recording)
  }, vector.uploadingResponse.upload.id, {
    onProgress: value => progress.push(value)
  });

  assert.equal(result.upload.state, 'complete');
  assert.equal(progress[0].phase, 'finalizing');
  assert.ok(progress.every(item =>
    ['finalizing', 'complete'].includes(item.phase)));
  assert.ok(server.calls.every(call => call.method === 'GET'));
});

test('all durable chunks can be claimed after local media disappears', async () => {
  const vector = await fixture();
  const bytes = Buffer.alloc(vector.initRequest.recording.sizeBytes, 0x61);
  const baseMedia = mediaStore(vector, bytes);
  let localAvailable = true;
  const server = fakeServer(vector, {
    completionMode: 'asynchronous',
    completionFailures: 2,
    finalizingPolls: 1
  });
  let nowMs = 0;
  const progress = [];
  const uploader = new CommunitySermonMediaUpload({
    client: server.client,
    mediaStore: {
      async checkMedia(recording) {
        if (!localAvailable) {
          throw new Error('completion recovery must not recheck local media');
        }
        return baseMedia.checkMedia(recording);
      },
      async openMediaReadSession(recording, options) {
        if (!localAvailable) {
          throw new Error('completion recovery must not reopen local media');
        }
        return baseMedia.openMediaReadSession(recording, options);
      }
    },
    resolveBinding: async () => {
      if (!localAvailable) {
        throw new Error('completion recovery must not resolve the project');
      }
      return binding(vector);
    },
    async waitForFinalizationPoll(delayMs) {
      nowMs += delayMs;
    },
    now: () => nowMs
  });

  await assert.rejects(
    uploader.upload(reference(), {
      attemptId: ATTEMPT_ID,
      onProgress: value => progress.push(value)
    }),
    error => error?.code === 'SERVER_UNAVAILABLE'
      && error.retryable === true
  );
  assert.equal(progress.at(-1).phase, 'uploading');
  assert.equal(progress.at(-1).receivedBytes, bytes.length);
  assert.equal(progress.at(-1).receivedChunks, 2);
  assert.equal(
    progress.some(item => item.phase === 'finalizing'),
    false,
    'an uncommitted completion request never disables cancellation'
  );

  localAvailable = false;
  const callsBeforeResume = server.calls.length;
  const resumedProgress = [];
  const resumed = await uploader.resumeFinalization({
    sermonId: vector.initRequest.sermon.syncId,
    expectedSyncVersion:
      vector.initRequest.sermon.expectedSyncVersion,
    expectedCurrentRevision:
      vector.initRequest.sermon.expectedCurrentRevision,
    recording: clone(vector.initRequest.recording)
  }, vector.uploadingResponse.upload.id, {
    onProgress: value => resumedProgress.push(value)
  });

  assert.equal(resumed.upload.state, 'complete');
  assert.equal(baseMedia.sessions, 2);
  assert.deepEqual(
    server.calls.slice(callsBeforeResume).map(call =>
      `${call.method} ${call.path}`),
    [
      'GET uploads/ABCDEFGHIJKLMNOPQRSTUVWX12345678',
      'POST uploads/ABCDEFGHIJKLMNOPQRSTUVWX12345678/complete',
      'GET uploads/ABCDEFGHIJKLMNOPQRSTUVWX12345678',
      'GET uploads/ABCDEFGHIJKLMNOPQRSTUVWX12345678'
    ]
  );
  assert.equal(resumedProgress[0].phase, 'finalizing');
  assert.equal(resumedProgress.at(-1).phase, 'complete');
});

test('identity-only recovery refuses a partial remote upload without local bytes', async () => {
  const vector = await fixture();
  const server = fakeServer(vector, {
    initialReceived: [0]
  });
  const uploader = new CommunitySermonMediaUpload({
    client: server.client,
    mediaStore: {
      async checkMedia() {
        throw new Error('partial identity recovery must not check local media');
      },
      async openMediaReadSession() {
        throw new Error('partial identity recovery must not open local media');
      }
    },
    resolveBinding: async () => {
      throw new Error('partial identity recovery must not resolve the project');
    }
  });

  await assert.rejects(
    uploader.resumeFinalization({
      sermonId: vector.initRequest.sermon.syncId,
      expectedSyncVersion:
        vector.initRequest.sermon.expectedSyncVersion,
      expectedCurrentRevision:
        vector.initRequest.sermon.expectedCurrentRevision,
      recording: clone(vector.initRequest.recording)
    }, vector.uploadingResponse.upload.id),
    error => error?.code === 'REMOTE_UPLOAD_INCOMPLETE'
      && error.retryable === true
  );
  assert.deepEqual(
    server.calls.map(call => `${call.method} ${call.path}`),
    ['GET uploads/ABCDEFGHIJKLMNOPQRSTUVWX12345678']
  );
});

test('long finalization periodically replays the exact completion claim', async () => {
  const vector = await fixture();
  const bytes = Buffer.alloc(vector.initRequest.recording.sizeBytes, 0x61);
  const server = fakeServer(vector, {
    completionMode: 'asynchronous',
    finalizingPolls: 9
  });
  let nowMs = 0;
  const uploader = new CommunitySermonMediaUpload({
    client: server.client,
    mediaStore: mediaStore(vector, bytes),
    resolveBinding: async () => binding(vector),
    async waitForFinalizationPoll(delayMs) {
      nowMs += delayMs;
    },
    now: () => nowMs
  });

  const result = await uploader.upload(reference(), {
    attemptId: ATTEMPT_ID
  });

  assert.equal(result.upload.state, 'complete');
  const claims = server.calls.filter(call =>
    call.method === 'POST' && call.path.endsWith('/complete'));
  assert.ok(nowMs >= SERMON_MEDIA_FINALIZATION_REPLAY_INTERVAL_MS);
  assert.ok(claims.length >= 2);
  assert.ok(claims.every(call =>
    call.timeoutMs === SERMON_MEDIA_COMPLETE_REQUEST_TIMEOUT_MS
    && call.headers['Idempotency-Key']
      === claims[0].headers['Idempotency-Key']));
});

test('finalization polling has a hard total wait bound', async () => {
  const vector = await fixture();
  const bytes = Buffer.alloc(vector.initRequest.recording.sizeBytes, 0x61);
  const server = fakeServer(vector, {
    completionMode: 'asynchronous',
    finalizingPolls: 10_000
  });
  let nowMs = 0;
  const uploader = new CommunitySermonMediaUpload({
    client: server.client,
    mediaStore: mediaStore(vector, bytes),
    resolveBinding: async () => binding(vector),
    async waitForFinalizationPoll(delayMs) {
      nowMs += delayMs;
    },
    now: () => nowMs
  });

  await assert.rejects(
    uploader.upload(reference(), { attemptId: ATTEMPT_ID }),
    error => error?.code === 'FINALIZATION_TIMEOUT'
      && error.retryable === true
  );
  assert.equal(nowMs, SERMON_MEDIA_FINALIZATION_MAX_WAIT_MS);
});

test('an exact completed server slot is recognized under a new local attempt', async () => {
  const vector = await fixture();
  const bytes = Buffer.alloc(vector.initRequest.recording.sizeBytes, 0x61);
  const server = fakeServer(vector, {
    initialReceived: [0, 1],
    initState: 'complete'
  });
  const uploader = new CommunitySermonMediaUpload({
    client: server.client,
    mediaStore: mediaStore(vector, bytes),
    resolveBinding: async () => binding(vector)
  });

  const result = await uploader.upload(reference(), {
    attemptId: NEW_ATTEMPT_ID
  });

  assert.equal(result.upload.state, 'complete');
  assert.equal(server.calls.filter(call => call.type === 'binary').length, 0);
  assert.equal(
    server.calls.filter(call =>
      call.method === 'POST' && call.path.endsWith('/complete')).length,
    0
  );
  assert.deepEqual(
    server.calls.map(call => `${call.method} ${call.path}`),
    [
      'POST uploads',
      'GET uploads/ABCDEFGHIJKLMNOPQRSTUVWX12345678'
    ]
  );
});

test('remote upload identity is acknowledged before progress or chunk reads', async () => {
  const vector = await fixture();
  const bytes = Buffer.alloc(vector.initRequest.recording.sizeBytes, 0x61);
  const local = mediaStore(vector, bytes);
  const server = fakeServer(vector, {
    initialReceived: [0, 1],
    initState: 'complete'
  });
  const events = [];
  const uploader = new CommunitySermonMediaUpload({
    client: server.client,
    mediaStore: local,
    resolveBinding: async () => binding(vector)
  });

  await uploader.upload(reference(), {
    attemptId: ATTEMPT_ID,
    async onAcknowledged(uploadId) {
      events.push(`ack:${uploadId}`);
      await Promise.resolve();
    },
    onProgress(progress) {
      events.push(`progress:${progress.phase}`);
    }
  });

  assert.equal(
    events[0],
    'ack:ABCDEFGHIJKLMNOPQRSTUVWX12345678'
  );
  assert.deepEqual(events.slice(1), [
    'progress:complete',
    'progress:complete'
  ]);
  assert.equal(local.sessions, 0);
});

test('identity-only init replay recovers an upload without reading local bytes', async () => {
  const vector = await fixture();
  const bytes = Buffer.alloc(vector.initRequest.recording.sizeBytes, 0x61);
  const local = mediaStore(vector, bytes);
  const server = fakeServer(vector);
  const uploader = new CommunitySermonMediaUpload({
    client: server.client,
    mediaStore: local,
    resolveBinding: async () => {
      throw new Error('local binding must not be resolved');
    }
  });

  const recovered = await uploader.recoverInit({
    sermonId: vector.initRequest.sermon.syncId,
    expectedSyncVersion:
      vector.initRequest.sermon.expectedSyncVersion,
    expectedCurrentRevision:
      vector.initRequest.sermon.expectedCurrentRevision,
    recording: clone(vector.initRequest.recording)
  }, ATTEMPT_ID);

  assert.equal(
    recovered.upload.id,
    'ABCDEFGHIJKLMNOPQRSTUVWX12345678'
  );
  assert.equal(recovered.upload.state, 'uploading');
  assert.equal(local.sessions, 0);
  assert.deepEqual(
    server.calls.map(call => `${call.method} ${call.path}`),
    ['POST uploads']
  );
});

test('identity-only status inspection never reads or resolves local media', async () => {
  const vector = await fixture();
  const bytes = Buffer.alloc(vector.initRequest.recording.sizeBytes, 0x61);
  const local = mediaStore(vector, bytes);
  const server = fakeServer(vector, {
    initialReceived: [0]
  });
  const uploader = new CommunitySermonMediaUpload({
    client: server.client,
    mediaStore: local,
    resolveBinding: async () => {
      throw new Error('local binding must not be resolved');
    }
  });

  const inspected = await uploader.inspect(
    'ABCDEFGHIJKLMNOPQRSTUVWX12345678'
  );
  assert.equal(inspected.upload.state, 'uploading');
  assert.equal(inspected.progress.receivedChunks, 1);
  assert.equal(local.sessions, 0);
  assert.deepEqual(
    server.calls.map(call => `${call.method} ${call.path}`),
    ['GET uploads/ABCDEFGHIJKLMNOPQRSTUVWX12345678']
  );
});

test('412 stale binding fails closed and never auto-cancels the remote session', async () => {
  const vector = await fixture();
  const bytes = Buffer.alloc(vector.initRequest.recording.sizeBytes, 0x61);
  const server = fakeServer(vector, {
    onBinary: async () => {
      throw new CommunityBinaryClientError(
        'STALE_SERMON_BINDING',
        'The exact sermon changed.',
        { status: 412, retryable: false }
      );
    }
  });
  const uploader = new CommunitySermonMediaUpload({
    client: server.client,
    mediaStore: mediaStore(vector, bytes),
    resolveBinding: async () => binding(vector)
  });

  await assert.rejects(
    uploader.upload(reference(), { attemptId: ATTEMPT_ID }),
    error => {
      assert.ok(error instanceof CommunitySermonMediaUploadError);
      assert.equal(error.code, 'SERMON_MEDIA_STALE');
      assert.equal(error.stale, true);
      return true;
    }
  );
  assert.equal(
    server.calls.some(call => call.method === 'DELETE'),
    false
  );
});

test('retryable transfer failure preserves the remote session for explicit resume', async () => {
  const vector = await fixture();
  const bytes = Buffer.alloc(vector.initRequest.recording.sizeBytes, 0x61);
  const server = fakeServer(vector, {
    onBinary: async () => {
      throw new CommunityBinaryClientError(
        'NETWORK_ERROR',
        'Community could not be reached.',
        { retryable: true }
      );
    }
  });
  const uploader = new CommunitySermonMediaUpload({
    client: server.client,
    mediaStore: mediaStore(vector, bytes),
    resolveBinding: async () => binding(vector)
  });

  await assert.rejects(
    uploader.upload(reference(), { attemptId: ATTEMPT_ID }),
    error => {
      assert.equal(error.code, 'NETWORK_ERROR');
      assert.equal(error.retryable, true);
      return true;
    }
  );
  assert.equal(
    server.calls.some(call => call.method === 'DELETE'),
    false
  );
});

test('local revision is re-resolved after each chunk and stale data blocks completion', async () => {
  const vector = await fixture();
  const bytes = Buffer.alloc(vector.initRequest.recording.sizeBytes, 0x61);
  let current = binding(vector);
  const server = fakeServer(vector, {
    initialReceived: [0],
    onBinary: async () => {
      current = binding(vector, {
        projectRevisionId: '2'.repeat(64)
      });
    }
  });
  const uploader = new CommunitySermonMediaUpload({
    client: server.client,
    mediaStore: mediaStore(vector, bytes),
    resolveBinding: async () => current
  });

  await assert.rejects(
    uploader.upload(reference(), { attemptId: ATTEMPT_ID }),
    error => error?.code === 'SERMON_MEDIA_STALE' && error.stale === true
  );
  assert.equal(
    server.calls.some(call =>
      call.method === 'POST' && call.path.endsWith('/complete')),
    false
  );
  assert.equal(
    server.calls.some(call => call.method === 'DELETE'),
    false
  );
});

test('empty or short local reads fail promptly instead of looping or sending bytes', async () => {
  const vector = await fixture();
  const bytes = Buffer.alloc(vector.initRequest.recording.sizeBytes, 0x61);
  const local = mediaStore(vector, bytes, { shortRead: true });
  const server = fakeServer(vector);
  const uploader = new CommunitySermonMediaUpload({
    client: server.client,
    mediaStore: local,
    resolveBinding: async () => binding(vector)
  });

  await assert.rejects(
    Promise.race([
      uploader.upload(reference(), { attemptId: ATTEMPT_ID }),
      new Promise((_, reject) => setTimeout(
        () => reject(new Error('uploader hung on a short read')),
        1000
      ))
    ]),
    error => error?.code === 'LOCAL_RECORDING_CHANGED'
      && error.stale === true
  );
  assert.equal(local.sessions, 1);
  assert.equal(local.closed, 1);
  assert.equal(server.calls.filter(call => call.type === 'binary').length, 0);
});

test('explicit cancellation uses the acknowledged upload when local media is missing', async () => {
  const vector = await fixture();
  const server = fakeServer(vector, { initialReceived: [0] });
  let mediaChecks = 0;
  let bindingResolutions = 0;
  const uploader = new CommunitySermonMediaUpload({
    client: server.client,
    mediaStore: {
      async checkMedia() {
        mediaChecks += 1;
        const error = new Error('local recording is missing');
        error.code = 'ENOENT';
        throw error;
      },
      async openMediaReadSession() {
        throw new Error('missing local media must not be opened during cancel');
      }
    },
    resolveBinding: async () => {
      bindingResolutions += 1;
      throw new Error('changed local service must not be resolved during cancel');
    }
  });

  const result = await uploader.cancel(vector.uploadingResponse.upload.id);
  assert.equal(result.upload.state, 'cancelled');
  assert.equal(result.progress.phase, 'cancelled');
  assert.equal(mediaChecks, 0);
  assert.equal(bindingResolutions, 0);
  const deletes = server.calls.filter(call => call.method === 'DELETE');
  assert.equal(deletes.length, 1);
  assert.match(
    deletes[0].headers['Idempotency-Key'],
    /^syncshow-media-cancel:[a-f0-9]{64}$/u
  );
});

test('explicit cancellation rejects a response for another upload ID', async () => {
  const vector = await fixture();
  const server = fakeServer(vector, { initialReceived: [0] });
  const client = {
    ...server.client,
    async requestJson(options) {
      const response = await server.client.requestJson(options);
      response.payload.upload.id = 'ZYXWVUTSRQPONMLKJIHGFEDCBA876543';
      return response;
    }
  };
  const uploader = new CommunitySermonMediaUpload({
    client,
    mediaStore: mediaStore(
      vector,
      Buffer.alloc(vector.initRequest.recording.sizeBytes, 0x61)
    ),
    resolveBinding: async () => binding(vector)
  });

  await assert.rejects(
    uploader.cancel(vector.uploadingResponse.upload.id),
    error => error?.code === 'INVALID_RESPONSE'
  );
  assert.equal(
    server.calls.filter(call => call.method === 'DELETE').length,
    1
  );
});
