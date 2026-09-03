'use strict';

const crypto = require('crypto');

const SERMON_MEDIA_SCHEMA_VERSION = 1;
const SERMON_MEDIA_CHUNK_SIZE_BYTES = 8_388_608;
const SERMON_MEDIA_MAXIMUM_BYTES = 1_073_741_824;
const SERMON_MEDIA_SESSION_TTL_SECONDS = 604_800;
const SERMON_MEDIA_TYPES = Object.freeze(['audio/mp4', 'audio/mpeg']);
const SERMON_MEDIA_UPLOAD_STATES = new Set([
  'uploading',
  'finalizing',
  'internal',
  'complete',
  'cancelled',
  'superseded',
  'expired'
]);
const SAFE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const CANONICAL_TIMESTAMP_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;

class CommunitySermonMediaWireError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'CommunitySermonMediaWireError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new CommunitySermonMediaWireError(code, message);
}

function exactObject(value, keys, label, code = 'INVALID_RESPONSE') {
  const expected = [...keys].sort();
  const actual = value && typeof value === 'object' && !Array.isArray(value)
    ? Object.keys(value).sort()
    : [];
  if (!value
    || typeof value !== 'object'
    || Array.isArray(value)
    || actual.length !== expected.length
    || actual.some((key, index) => key !== expected[index])) {
    fail(code, `${label} is invalid.`);
  }
  return value;
}

function safeText(value, label, maximum, {
  pattern = null,
  code = 'INVALID_RESPONSE'
} = {}) {
  if (typeof value !== 'string'
    || value.length < 1
    || value.length > maximum
    || value.trim() !== value
    || /[\u0000-\u001f\u007f]/u.test(value)
    || (pattern && !pattern.test(value))) {
    fail(code, `${label} is invalid.`);
  }
  return value;
}

function canonicalTimestamp(value, label, {
  nullable = false
} = {}) {
  if (value === null && nullable) return null;
  if (typeof value !== 'string'
    || !CANONICAL_TIMESTAMP_PATTERN.test(value)
    || Number.isNaN(Date.parse(value))
    || new Date(value).toISOString() !== value) {
    fail('INVALID_RESPONSE', `${label} is invalid.`);
  }
  return value;
}

function normalizeRecording(value, {
  code = 'INVALID_RESPONSE'
} = {}) {
  exactObject(value, [
    'durationSeconds',
    'fileName',
    'id',
    'kind',
    'language',
    'mediaType',
    'sha256',
    'sizeBytes'
  ], 'Community sermon-media recording', code);
  const mediaType = safeText(
    value.mediaType,
    'Community sermon-media type',
    32,
    { code }
  );
  if (!SERMON_MEDIA_TYPES.includes(mediaType)) {
    fail(code, 'Community sermon-media type is unsupported.');
  }
  if (value.kind !== 'audio') {
    fail(code, 'Community sermon-media kind is unsupported.');
  }
  if (!Number.isSafeInteger(value.sizeBytes)
    || value.sizeBytes < 1
    || value.sizeBytes > SERMON_MEDIA_MAXIMUM_BYTES
    || value.durationSeconds !== null) {
    fail(code, 'Community sermon-media recording size is invalid.');
  }
  const fileName = safeText(
    value.fileName,
    'Community sermon-media file name',
    255,
    { code }
  );
  if (fileName.includes('/')
    || fileName.includes('\\')
    || /^[A-Za-z]:/u.test(fileName)) {
    fail(code, 'Community sermon-media file name is invalid.');
  }
  return Object.freeze({
    id: safeText(value.id, 'Community sermon-media recording ID', 128, {
      pattern: SAFE_ID_PATTERN,
      code
    }),
    kind: 'audio',
    language: safeText(
      value.language,
      'Community sermon-media language',
      35,
      {
        pattern: /^[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*$/u,
        code
      }
    ).toLowerCase(),
    mediaType,
    fileName,
    sha256: safeText(value.sha256, 'Community sermon-media hash', 64, {
      pattern: SHA256_PATTERN,
      code
    }),
    sizeBytes: value.sizeBytes,
    durationSeconds: null
  });
}

function buildSermonMediaInitBody({
  syncId,
  expectedSyncVersion,
  expectedCurrentRevision,
  recording
} = {}) {
  if (!Number.isSafeInteger(expectedSyncVersion) || expectedSyncVersion < 1) {
    fail('INVALID_INPUT', 'Community sermon sync version is invalid.');
  }
  return Object.freeze({
    schemaVersion: SERMON_MEDIA_SCHEMA_VERSION,
    sermon: Object.freeze({
      syncId: safeText(syncId, 'Community sermon sync ID', 128, {
        pattern: SAFE_ID_PATTERN,
        code: 'INVALID_INPUT'
      }),
      expectedSyncVersion,
      expectedCurrentRevision: safeText(
        expectedCurrentRevision,
        'Community sermon revision',
        64,
        { pattern: SHA256_PATTERN, code: 'INVALID_INPUT' }
      )
    }),
    recording: normalizeRecording(recording, { code: 'INVALID_INPUT' })
  });
}

function normalizeUpload(value) {
  exactObject(value, [
    'chunkCount',
    'chunkSizeBytes',
    'completedAt',
    'expiresAt',
    'id',
    'receivedBytes',
    'receivedChunks',
    'recording',
    'sermon',
    'state'
  ], 'Community sermon-media upload');
  exactObject(
    value.sermon,
    ['currentRevision', 'syncId', 'syncVersion'],
    'Community sermon-media sermon'
  );
  const recording = normalizeRecording(value.recording);
  if (value.chunkSizeBytes !== SERMON_MEDIA_CHUNK_SIZE_BYTES) {
    fail('INVALID_RESPONSE', 'Community sermon-media chunk size is invalid.');
  }
  const expectedChunkCount = Math.ceil(
    recording.sizeBytes / SERMON_MEDIA_CHUNK_SIZE_BYTES
  );
  if (value.chunkCount !== expectedChunkCount
    || !Number.isSafeInteger(value.receivedBytes)
    || value.receivedBytes < 0
    || value.receivedBytes > recording.sizeBytes
    || !Array.isArray(value.receivedChunks)
    || value.receivedChunks.length > expectedChunkCount
    || value.receivedChunks.some((index, position) =>
      !Number.isSafeInteger(index)
      || index < 0
      || index >= expectedChunkCount
      || (position > 0 && value.receivedChunks[position - 1] >= index))) {
    fail('INVALID_RESPONSE', 'Community sermon-media chunk state is invalid.');
  }
  const expectedReceivedBytes = value.receivedChunks.reduce(
    (total, index) => total + Math.min(
      SERMON_MEDIA_CHUNK_SIZE_BYTES,
      recording.sizeBytes - (index * SERMON_MEDIA_CHUNK_SIZE_BYTES)
    ),
    0
  );
  if (value.receivedBytes !== expectedReceivedBytes
    || (['complete', 'finalizing'].includes(value.state)
      && (
        value.receivedChunks.length !== expectedChunkCount
        || value.receivedBytes !== recording.sizeBytes
      ))) {
    fail(
      'INVALID_RESPONSE',
      'Community sermon-media received-byte state is invalid.'
    );
  }
  if (!SERMON_MEDIA_UPLOAD_STATES.has(value.state)) {
    fail('INVALID_RESPONSE', 'Community sermon-media upload state is invalid.');
  }
  const completedAt = canonicalTimestamp(
    value.completedAt,
    'Community sermon-media completion time',
    { nullable: true }
  );
  if ((value.state === 'complete') !== Boolean(completedAt)) {
    fail('INVALID_RESPONSE', 'Community sermon-media completion state is invalid.');
  }
  return Object.freeze({
    id: safeText(value.id, 'Community sermon-media upload ID', 128, {
      pattern: /^[A-Za-z0-9_-]{32,128}$/u
    }),
    state: value.state,
    sermon: Object.freeze({
      syncId: safeText(
        value.sermon.syncId,
        'Community sermon-media sermon ID',
        128,
        { pattern: SAFE_ID_PATTERN }
      ),
      syncVersion: Number.isSafeInteger(value.sermon.syncVersion)
        && value.sermon.syncVersion >= 1
        ? value.sermon.syncVersion
        : fail(
            'INVALID_RESPONSE',
            'Community sermon-media sermon version is invalid.'
          ),
      currentRevision: safeText(
        value.sermon.currentRevision,
        'Community sermon-media sermon revision',
        64,
        { pattern: SHA256_PATTERN }
      )
    }),
    recording,
    chunkSizeBytes: SERMON_MEDIA_CHUNK_SIZE_BYTES,
    chunkCount: expectedChunkCount,
    receivedChunks: Object.freeze([...value.receivedChunks]),
    receivedBytes: value.receivedBytes,
    expiresAt: canonicalTimestamp(
      value.expiresAt,
      'Community sermon-media expiration time'
    ),
    completedAt
  });
}

function normalizeSermonMediaUploadResponse(value) {
  exactObject(
    value,
    ['schemaVersion', 'upload'],
    'Community sermon-media response'
  );
  if (value.schemaVersion !== SERMON_MEDIA_SCHEMA_VERSION) {
    fail('INVALID_RESPONSE', 'Community sermon-media response schema is unsupported.');
  }
  return normalizeUpload(value.upload);
}

function normalizeSermonMediaChunkResponse(value) {
  exactObject(
    value,
    ['chunk', 'schemaVersion', 'upload'],
    'Community sermon-media chunk response'
  );
  if (value.schemaVersion !== SERMON_MEDIA_SCHEMA_VERSION) {
    fail('INVALID_RESPONSE', 'Community sermon-media chunk schema is unsupported.');
  }
  const upload = normalizeUpload(value.upload);
  exactObject(
    value.chunk,
    ['index', 'receivedAt', 'sha256', 'sizeBytes'],
    'Community sermon-media chunk receipt'
  );
  if (!Number.isSafeInteger(value.chunk.index)
    || value.chunk.index < 0
    || value.chunk.index >= upload.chunkCount
    || !Number.isSafeInteger(value.chunk.sizeBytes)
    || value.chunk.sizeBytes < 1
    || value.chunk.sizeBytes > upload.chunkSizeBytes) {
    fail('INVALID_RESPONSE', 'Community sermon-media chunk receipt is invalid.');
  }
  const expectedSizeBytes = Math.min(
    upload.chunkSizeBytes,
    upload.recording.sizeBytes - (value.chunk.index * upload.chunkSizeBytes)
  );
  if (value.chunk.sizeBytes !== expectedSizeBytes
    || !upload.receivedChunks.includes(value.chunk.index)) {
    fail(
      'INVALID_RESPONSE',
      'Community sermon-media chunk receipt does not match upload state.'
    );
  }
  return Object.freeze({
    chunk: Object.freeze({
      index: value.chunk.index,
      sha256: safeText(
        value.chunk.sha256,
        'Community sermon-media chunk hash',
        64,
        { pattern: SHA256_PATTERN }
      ),
      sizeBytes: value.chunk.sizeBytes,
      receivedAt: canonicalTimestamp(
        value.chunk.receivedAt,
        'Community sermon-media chunk receipt time'
      )
    }),
    upload
  });
}

function sermonMediaIdempotencyKey(operation, values) {
  const label = safeText(
    operation,
    'Sermon-media operation',
    24,
    {
      pattern: /^[a-z][a-z0-9-]{1,23}$/u,
      code: 'INVALID_INPUT'
    }
  );
  const source = JSON.stringify(values);
  return `syncshow-media-${label}:${crypto
    .createHash('sha256')
    .update(source)
    .digest('hex')}`;
}

module.exports = {
  CommunitySermonMediaWireError,
  SERMON_MEDIA_CHUNK_SIZE_BYTES,
  SERMON_MEDIA_MAXIMUM_BYTES,
  SERMON_MEDIA_SCHEMA_VERSION,
  SERMON_MEDIA_SESSION_TTL_SECONDS,
  SERMON_MEDIA_TYPES,
  buildSermonMediaInitBody,
  normalizeSermonMediaChunkResponse,
  normalizeSermonMediaUploadResponse,
  sermonMediaIdempotencyKey
};
