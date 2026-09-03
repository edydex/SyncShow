'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');

const {
  CommunitySermonMediaWireError,
  buildSermonMediaInitBody,
  normalizeSermonMediaChunkResponse,
  normalizeSermonMediaUploadResponse,
  sermonMediaIdempotencyKey
} = require('../src/services/community/CommunitySermonMediaWire');

const fixturePath = path.join(
  __dirname,
  'fixtures',
  'community-sermon-media-wire-v1.json'
);

async function fixture() {
  return JSON.parse(await fs.readFile(fixturePath, 'utf8'));
}

test('shared v1 fixture is accepted byte-for-field by the SyncShow wire codec', async () => {
  const vector = await fixture();
  assert.deepEqual(
    buildSermonMediaInitBody({
      syncId: vector.initRequest.sermon.syncId,
      expectedSyncVersion:
        vector.initRequest.sermon.expectedSyncVersion,
      expectedCurrentRevision:
        vector.initRequest.sermon.expectedCurrentRevision,
      recording: vector.initRequest.recording
    }),
    vector.initRequest
  );

  const uploading =
    normalizeSermonMediaUploadResponse(vector.uploadingResponse);
  assert.equal(uploading.state, 'uploading');
  assert.equal(uploading.chunkCount, 2);
  assert.deepEqual(uploading.receivedChunks, []);

  const receipt =
    normalizeSermonMediaChunkResponse(vector.firstChunkResponse);
  assert.equal(receipt.chunk.index, 0);
  assert.equal(receipt.chunk.sha256, vector.firstChunkResponse.chunk.sha256);
  assert.deepEqual(receipt.upload.receivedChunks, [0]);

  const finalizing =
    normalizeSermonMediaUploadResponse(vector.finalizingResponse);
  assert.equal(finalizing.state, 'finalizing');
  assert.deepEqual(finalizing.receivedChunks, [0, 1]);
  assert.equal(finalizing.receivedBytes, finalizing.recording.sizeBytes);
  assert.equal(finalizing.completedAt, null);

  const complete =
    normalizeSermonMediaUploadResponse(vector.completeResponse);
  assert.equal(complete.state, 'complete');
  assert.equal(complete.completedAt, '2026-08-02T18:32:00.000Z');

  const cancelled =
    normalizeSermonMediaUploadResponse(vector.cancelledResponse);
  assert.equal(cancelled.state, 'cancelled');
  assert.equal(cancelled.completedAt, null);
});

test('wire codec rejects extra fields and impossible completion/chunk state', async () => {
  const vector = await fixture();
  const cases = [
    {
      ...vector.uploadingResponse,
      publicUrl: 'https://community.example.test/sermons/unsafe'
    },
    {
      ...vector.uploadingResponse,
      upload: {
        ...vector.uploadingResponse.upload,
        state: 'complete'
      }
    },
    {
      ...vector.uploadingResponse,
      upload: {
        ...vector.uploadingResponse.upload,
        state: 'finalizing'
      }
    },
    {
      ...vector.uploadingResponse,
      upload: {
        ...vector.uploadingResponse.upload,
        receivedChunks: [1, 0]
      }
    },
    {
      ...vector.uploadingResponse,
      upload: {
        ...vector.uploadingResponse.upload,
        receivedChunks: [0],
        receivedBytes: 0
      }
    },
    {
      ...vector.uploadingResponse,
      upload: {
        ...vector.uploadingResponse.upload,
        id: '../private-file'
      }
    }
  ];

  for (const payload of cases) {
    assert.throws(
      () => normalizeSermonMediaUploadResponse(payload),
      error => {
        assert.ok(error instanceof CommunitySermonMediaWireError);
        assert.equal(error.code, 'INVALID_RESPONSE');
        return true;
      }
    );
  }

  assert.throws(
    () => normalizeSermonMediaChunkResponse({
      ...vector.firstChunkResponse,
      chunk: {
        ...vector.firstChunkResponse.chunk,
        unexpected: true
      }
    }),
    error => error?.code === 'INVALID_RESPONSE'
  );
});

test('idempotency keys are stable for a retry and distinct for a new attempt', () => {
  const first = sermonMediaIdempotencyKey('init', {
    attemptId: '11111111-1111-4111-8111-111111111111',
    body: { schemaVersion: 1 }
  });
  const retry = sermonMediaIdempotencyKey('init', {
    attemptId: '11111111-1111-4111-8111-111111111111',
    body: { schemaVersion: 1 }
  });
  const restarted = sermonMediaIdempotencyKey('init', {
    attemptId: '22222222-2222-4222-8222-222222222222',
    body: { schemaVersion: 1 }
  });

  assert.equal(first, retry);
  assert.notEqual(first, restarted);
  assert.match(first, /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/u);
});
