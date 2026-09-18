'use strict';

const crypto = require('crypto');
const { Readable } = require('stream');

const {
  CommunityBinaryClientError
} = require('./CommunityBinaryClient');
const {
  CommunitySermonMediaWireError,
  SERMON_MEDIA_CHUNK_SIZE_BYTES,
  SERMON_MEDIA_MAXIMUM_BYTES,
  SERMON_MEDIA_TYPES,
  buildSermonMediaInitBody,
  normalizeSermonMediaChunkResponse,
  normalizeSermonMediaUploadResponse,
  sermonMediaIdempotencyKey
} = require('./CommunitySermonMediaWire');

const REVISION_PATTERN = /^[a-f0-9]{64}$/u;
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const UPLOAD_ID_PATTERN = /^[A-Za-z0-9_-]{32,128}$/u;
const MEDIA_READ_BYTES = 1024 * 1024;
const SERMON_MEDIA_CONTROL_REQUEST_TIMEOUT_MS = 30_000;
const SERMON_MEDIA_CHUNK_REQUEST_TIMEOUT_MS = 15 * 60_000;
const SERMON_MEDIA_COMPLETE_REQUEST_TIMEOUT_MS = 60_000;
const SERMON_MEDIA_FINALIZATION_MAX_WAIT_MS = 20 * 60_000;
const SERMON_MEDIA_FINALIZATION_POLL_INITIAL_MS = 1_000;
const SERMON_MEDIA_FINALIZATION_POLL_MAX_MS = 15_000;
const SERMON_MEDIA_FINALIZATION_REPLAY_INTERVAL_MS = 60_000;

class CommunitySermonMediaUploadError extends Error {
  constructor(code, message, {
    retryable = false,
    stale = false,
    cause = null
  } = {}) {
    super(message);
    this.name = 'CommunitySermonMediaUploadError';
    this.code = code;
    this.retryable = retryable;
    this.stale = stale;
    this.cause = cause;
  }
}

function fail(code, message, options = {}) {
  throw new CommunitySermonMediaUploadError(code, message, options);
}

function abortableDelay(delayMs, signal) {
  if (signal?.aborted) {
    return Promise.reject(new CommunitySermonMediaUploadError(
      'REQUEST_CANCELLED',
      'The sermon-recording upload request was stopped.'
    ));
  }
  return new Promise((resolve, reject) => {
    let settled = false;
    const abort = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener?.('abort', abort);
      reject(new CommunitySermonMediaUploadError(
        'REQUEST_CANCELLED',
        'The sermon-recording upload request was stopped.'
      ));
    };
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener?.('abort', abort);
      resolve();
    }, delayMs);
    timer.unref?.();
    signal?.addEventListener?.('abort', abort, { once: true });
  });
}

function exactObject(value, keys, label) {
  const expected = [...keys].sort();
  const actual = value && typeof value === 'object' && !Array.isArray(value)
    ? Object.keys(value).sort()
    : [];
  if (!value
    || typeof value !== 'object'
    || Array.isArray(value)
    || actual.length !== expected.length
    || actual.some((key, index) => key !== expected[index])) {
    fail('INVALID_BINDING', `${label} is invalid.`);
  }
  return value;
}

function stableId(value, label) {
  if (typeof value !== 'string' || !ID_PATTERN.test(value)) {
    fail('INVALID_BINDING', `${label} is invalid.`);
  }
  return value;
}

function revision(value, label) {
  if (typeof value !== 'string' || !REVISION_PATTERN.test(value)) {
    fail('INVALID_BINDING', `${label} is invalid.`);
  }
  return value;
}

function normalizeRecording(value) {
  exactObject(value, [
    'durationSeconds',
    'fileName',
    'id',
    'kind',
    'language',
    'mediaType',
    'sha256',
    'sizeBytes'
  ], 'Managed sermon recording');
  const fileName = typeof value.fileName === 'string' ? value.fileName : '';
  if (value.kind !== 'audio'
    || !SERMON_MEDIA_TYPES.includes(value.mediaType)
    || typeof value.language !== 'string'
    || !/^[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*$/u.test(value.language)
    || !ID_PATTERN.test(value.id || '')
    || value.id !== `post-service:recording:${value.language}`
    || !REVISION_PATTERN.test(value.sha256 || '')
    || !Number.isSafeInteger(value.sizeBytes)
    || value.sizeBytes < 1
    || value.sizeBytes > SERMON_MEDIA_MAXIMUM_BYTES
    || value.durationSeconds !== null
    || !fileName
    || fileName !== fileName.trim()
    || fileName.length > 255
    || fileName.includes('/')
    || fileName.includes('\\')
    || /^[A-Za-z]:/u.test(fileName)) {
    fail(
      'INVALID_BINDING',
      'The exact managed sermon recording is not eligible for private upload.'
    );
  }
  return Object.freeze({
    id: value.id,
    kind: 'audio',
    language: value.language.toLowerCase(),
    mediaType: value.mediaType,
    fileName,
    sha256: value.sha256,
    sizeBytes: value.sizeBytes,
    durationSeconds: null
  });
}

function normalizeReference(value) {
  exactObject(
    value,
    ['expectedProjectRevisionId', 'itemId', 'projectId'],
    'Sermon-media upload reference'
  );
  return Object.freeze({
    projectId: stableId(value.projectId, 'Service project ID'),
    expectedProjectRevisionId: revision(
      value.expectedProjectRevisionId,
      'Service project revision'
    ),
    itemId: stableId(value.itemId, 'Service item ID')
  });
}

function normalizeBinding(value) {
  exactObject(value, [
    'expectedCurrentRevision',
    'expectedSyncVersion',
    'itemId',
    'projectId',
    'projectRevisionId',
    'recording',
    'sermonId',
    'sermonRevisionId'
  ], 'Sermon-media upload binding');
  if (!Number.isSafeInteger(value.expectedSyncVersion)
    || value.expectedSyncVersion < 1) {
    fail('INVALID_BINDING', 'Community sermon sync version is invalid.');
  }
  const binding = {
    projectId: stableId(value.projectId, 'Service project ID'),
    projectRevisionId: revision(
      value.projectRevisionId,
      'Service project revision'
    ),
    itemId: stableId(value.itemId, 'Service item ID'),
    sermonId: stableId(value.sermonId, 'Sermon ID'),
    sermonRevisionId: revision(value.sermonRevisionId, 'Sermon revision'),
    expectedSyncVersion: value.expectedSyncVersion,
    expectedCurrentRevision: revision(
      value.expectedCurrentRevision,
      'Community sermon revision'
    ),
    recording: normalizeRecording(value.recording)
  };
  if (binding.expectedCurrentRevision !== binding.sermonRevisionId) {
    fail(
      'SERMON_NOT_SYNCHRONIZED',
      'Upload requires the exact local sermon revision already saved in Community.'
    );
  }
  return Object.freeze(binding);
}

function normalizeRecoveryBinding(value) {
  exactObject(value, [
    'expectedCurrentRevision',
    'expectedSyncVersion',
    'recording',
    'sermonId'
  ], 'Sermon-media finalization recovery binding');
  const body = buildSermonMediaInitBody({
    syncId: value.sermonId,
    expectedSyncVersion: value.expectedSyncVersion,
    expectedCurrentRevision: value.expectedCurrentRevision,
    recording: value.recording
  });
  return Object.freeze({
    sermonId: body.sermon.syncId,
    expectedSyncVersion: body.sermon.expectedSyncVersion,
    expectedCurrentRevision: body.sermon.expectedCurrentRevision,
    recording: body.recording
  });
}

function bindingFingerprint(binding) {
  return JSON.stringify({
    projectId: binding.projectId,
    projectRevisionId: binding.projectRevisionId,
    itemId: binding.itemId,
    sermonId: binding.sermonId,
    sermonRevisionId: binding.sermonRevisionId,
    expectedSyncVersion: binding.expectedSyncVersion,
    expectedCurrentRevision: binding.expectedCurrentRevision,
    recording: binding.recording
  });
}

function sameBinding(left, right) {
  return bindingFingerprint(left) === bindingFingerprint(right);
}

function publicProgress(upload, phase) {
  const complete = upload.state === 'complete';
  return Object.freeze({
    phase: complete
      ? 'complete'
      : upload.state === 'cancelled'
        ? 'cancelled'
        : upload.state === 'superseded'
          ? 'stale'
          : upload.state === 'finalizing'
            ? 'finalizing'
          : phase,
    uploadId: upload.id,
    receivedBytes: upload.receivedBytes,
    totalBytes: upload.recording.sizeBytes,
    receivedChunks: upload.receivedChunks.length,
    chunkCount: upload.chunkCount,
    percent: upload.recording.sizeBytes > 0
      ? Math.min(
          100,
          Math.floor((upload.receivedBytes / upload.recording.sizeBytes) * 100)
        )
      : 0,
    complete
  });
}

function mapError(error) {
  if (error instanceof CommunitySermonMediaUploadError) return error;
  if (error instanceof CommunityBinaryClientError) {
    if (error.status === 412 || error.code === 'STALE_SERMON_BINDING') {
      return new CommunitySermonMediaUploadError(
        'SERMON_MEDIA_STALE',
        'The service, sermon, or exact recording changed. This upload was superseded and cannot be resumed.',
        { stale: true, retryable: false, cause: error.code }
      );
    }
    return new CommunitySermonMediaUploadError(error.code, error.message, {
      retryable: error.retryable,
      cause: error.code
    });
  }
  if (error instanceof CommunitySermonMediaWireError) {
    return new CommunitySermonMediaUploadError(
      error.code,
      error.message,
      { retryable: false, cause: error.code }
    );
  }
  return error;
}

class CommunitySermonMediaUpload {
  constructor({
    client,
    mediaStore,
    resolveBinding,
    waitForFinalizationPoll = abortableDelay,
    now = Date.now
  } = {}) {
    if (!client
      || typeof client.requestJson !== 'function'
      || typeof client.requestBinary !== 'function') {
      throw new TypeError('Community sermon-media upload requires a binary client');
    }
    if (!mediaStore
      || typeof mediaStore.checkMedia !== 'function'
      || typeof mediaStore.openMediaReadSession !== 'function') {
      throw new TypeError('Community sermon-media upload requires a local media store');
    }
    if (typeof resolveBinding !== 'function') {
      throw new TypeError('Community sermon-media upload requires a binding resolver');
    }
    if (typeof waitForFinalizationPoll !== 'function'
      || typeof now !== 'function') {
      throw new TypeError(
        'Community sermon-media finalization timing is invalid'
      );
    }
    this.client = client;
    this.mediaStore = mediaStore;
    this.resolveBinding = resolveBinding;
    this.waitForFinalizationPoll = waitForFinalizationPoll;
    this.now = now;
  }

  async _resolve(reference, expected = null) {
    const resolved = normalizeBinding(await this.resolveBinding(reference));
    if (resolved.projectId !== reference.projectId
      || resolved.projectRevisionId !== reference.expectedProjectRevisionId
      || resolved.itemId !== reference.itemId
      || (expected && !sameBinding(resolved, expected))) {
      fail(
        'SERMON_MEDIA_STALE',
        'The service, sermon, or exact recording changed. Reload before uploading.',
        { stale: true }
      );
    }
    return resolved;
  }

  _assertUploadIdentity(upload, binding) {
    if (upload.sermon.syncId !== binding.sermonId
      || upload.sermon.syncVersion !== binding.expectedSyncVersion
      || upload.sermon.currentRevision !== binding.expectedCurrentRevision
      || JSON.stringify(upload.recording) !== JSON.stringify(binding.recording)) {
      fail(
        'INVALID_RESPONSE',
        'Community returned upload state for a different sermon recording.'
      );
    }
    return upload;
  }

  _assertUpload(upload, binding) {
    this._assertUploadIdentity(upload, binding);
    if (upload.state === 'superseded') {
      fail(
        'SERMON_MEDIA_STALE',
        'The Community sermon binding changed. This upload cannot continue.',
        { stale: true }
      );
    }
    if (upload.state === 'expired') {
      fail(
        'UPLOAD_EXPIRED',
        'The private recording upload expired. Start it again.',
        { retryable: false }
      );
    }
    return upload;
  }

  async _verifiedBinding(reference, expected = null) {
    const binding = await this._resolve(reference, expected);
    const checked = await this.mediaStore.checkMedia(binding.recording);
    if (checked.sha256 !== binding.recording.sha256
      || checked.sizeBytes !== binding.recording.sizeBytes
      || checked.kind !== binding.recording.kind
      || checked.mediaType !== binding.recording.mediaType) {
      fail(
        'LOCAL_RECORDING_CHANGED',
        'The preserved local recording no longer matches this sermon revision.',
        { stale: true }
      );
    }
    return binding;
  }

  async _init(reference, expected, attemptId, signal) {
    const binding = await this._verifiedBinding(reference, expected);
    const body = buildSermonMediaInitBody({
      syncId: binding.sermonId,
      expectedSyncVersion: binding.expectedSyncVersion,
      expectedCurrentRevision: binding.expectedCurrentRevision,
      recording: binding.recording
    });
    const idempotencyKey = sermonMediaIdempotencyKey('init', {
      attemptId,
      body
    });
    const response = await this.client.requestJson({
      path: 'uploads',
      method: 'POST',
      headers: { 'Idempotency-Key': idempotencyKey },
      body,
      expectedStatuses: [200, 201],
      signal,
      timeoutMs: SERMON_MEDIA_CONTROL_REQUEST_TIMEOUT_MS
    });
    return this._assertUpload(
      normalizeSermonMediaUploadResponse(response.payload),
      binding
    );
  }

  async _state(reference, expected, uploadId, signal) {
    const binding = await this._verifiedBinding(reference, expected);
    const response = await this.client.requestJson({
      path: `uploads/${encodeURIComponent(uploadId)}`,
      method: 'GET',
      expectedStatuses: [200],
      signal,
      timeoutMs: SERMON_MEDIA_CONTROL_REQUEST_TIMEOUT_MS
    });
    return this._assertUpload(
      normalizeSermonMediaUploadResponse(response.payload),
      binding
    );
  }

  async _chunkBytes(reference, expected, chunkIndex, signal) {
    const binding = await this._resolve(reference, expected);
    const offset = chunkIndex * SERMON_MEDIA_CHUNK_SIZE_BYTES;
    const length = Math.min(
      SERMON_MEDIA_CHUNK_SIZE_BYTES,
      binding.recording.sizeBytes - offset
    );
    if (length < 1) {
      fail('INVALID_CHUNK', 'The requested sermon-media chunk is invalid.');
    }
    const reader = await this.mediaStore.openMediaReadSession(
      binding.recording,
      { signal }
    );
    const parts = [];
    const hash = crypto.createHash('sha256');
    let consumed = 0;
    try {
      if (reader.sha256 !== binding.recording.sha256
        || reader.sizeBytes !== binding.recording.sizeBytes
        || reader.kind !== binding.recording.kind
        || reader.mediaType !== binding.recording.mediaType) {
        fail(
          'LOCAL_RECORDING_CHANGED',
          'The preserved local recording changed before its next chunk.',
          { stale: true }
        );
      }
      while (consumed < length) {
        const readLength = Math.min(MEDIA_READ_BYTES, length - consumed);
        const bytes = await reader.read(offset + consumed, readLength);
        if ((!Buffer.isBuffer(bytes) && !(bytes instanceof Uint8Array))
          || bytes.length !== readLength) {
          fail(
            'LOCAL_RECORDING_CHANGED',
            'The preserved local recording ended or changed during upload.',
            { stale: true }
          );
        }
        parts.push(bytes);
        hash.update(bytes);
        consumed += bytes.length;
      }
    } finally {
      await reader.close().catch(() => {});
    }
    await this._resolve(reference, binding);
    return Object.freeze({
      binding,
      offset,
      length,
      sha256: hash.digest('hex'),
      body: Readable.from(parts)
    });
  }

  _now() {
    const value = this.now();
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new TypeError('Community sermon-media finalization clock is invalid');
    }
    return value;
  }

  _assertFinalizationState(upload, binding, {
    allowUploading = false
  } = {}) {
    this._assertUpload(upload, binding);
    if (upload.state === 'complete' || upload.state === 'finalizing') {
      return upload;
    }
    if (upload.state === 'cancelled') {
      fail(
        'UPLOAD_CANCELLED',
        'This private recording upload was cancelled. Start a new upload.'
      );
    }
    if (upload.state === 'internal') {
      fail(
        'UPLOAD_NOT_WRITABLE',
        'Community could not finish securing this private recording. Start it again explicitly.'
      );
    }
    if (allowUploading && upload.state === 'uploading') return upload;
    fail(
      'INVALID_RESPONSE',
      'Community returned an impossible private-recording finalization state.'
    );
  }

  async _inspectFinalization(uploadId, binding, signal, {
    allowUploading = false
  } = {}) {
    const inspected = await this.inspect(uploadId, { signal });
    return this._assertFinalizationState(inspected.upload, binding, {
      allowUploading
    });
  }

  async _postCompletion(uploadId, binding, signal) {
    const response = await this.client.requestJson({
      path: `uploads/${encodeURIComponent(uploadId)}/complete`,
      method: 'POST',
      headers: {
        'Idempotency-Key': sermonMediaIdempotencyKey('complete', {
          uploadId,
          sha256: binding.recording.sha256,
          sizeBytes: binding.recording.sizeBytes
        })
      },
      body: { schemaVersion: 1 },
      expectedStatuses: [200, 202],
      signal,
      timeoutMs: SERMON_MEDIA_COMPLETE_REQUEST_TIMEOUT_MS
    });
    const upload = this._assertUpload(
      normalizeSermonMediaUploadResponse(response.payload),
      binding
    );
    if ((response.status === 200 && upload.state !== 'complete')
      || (response.status === 202 && upload.state !== 'finalizing')) {
      fail(
        'INVALID_RESPONSE',
        'Community returned an invalid private-recording completion acknowledgement.'
      );
    }
    return upload;
  }

  async _claimCompletion(uploadId, binding, signal) {
    let lastError = null;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        return await this._postCompletion(uploadId, binding, signal);
      } catch (error) {
        if (error?.retryable !== true) throw error;
        lastError = error;
      }
      try {
        const observed = await this._inspectFinalization(
          uploadId,
          binding,
          signal,
          { allowUploading: true }
        );
        if (observed.state !== 'uploading') return observed;
      } catch (error) {
        if (error?.retryable !== true) throw error;
        lastError = error;
      }
    }
    throw lastError || new CommunitySermonMediaUploadError(
      'REMOTE_COMPLETION_UNCONFIRMED',
      'Community did not confirm the private recording finalization.',
      { retryable: true }
    );
  }

  _assertCompletionReady(upload, binding) {
    this._assertUpload(upload, binding);
    if (upload.receivedChunks.length !== upload.chunkCount
      || upload.receivedBytes !== binding.recording.sizeBytes) {
      fail(
        'REMOTE_UPLOAD_INCOMPLETE',
        'Community still needs the missing local recording chunks. Restore the recording to resume, or cancel its staging upload.',
        { retryable: true }
      );
    }
    return upload;
  }

  async _pollFinalization(
    initialUpload,
    binding,
    signal,
    onProgress
  ) {
    let upload = this._assertFinalizationState(initialUpload, binding);
    if (upload.state === 'complete') return upload;
    const startedAt = this._now();
    let delayMs = SERMON_MEDIA_FINALIZATION_POLL_INITIAL_MS;
    let lastReplayAt = startedAt;
    onProgress(publicProgress(upload, 'finalizing'));
    while (upload.state === 'finalizing') {
      const elapsedMs = this._now() - startedAt;
      if (elapsedMs >= SERMON_MEDIA_FINALIZATION_MAX_WAIT_MS) {
        fail(
          'FINALIZATION_TIMEOUT',
          'Community is still securing the private recording. Resume later to continue checking it.',
          { retryable: true }
        );
      }
      await this.waitForFinalizationPoll(
        Math.min(
          delayMs,
          SERMON_MEDIA_FINALIZATION_MAX_WAIT_MS - elapsedMs
        ),
        signal
      );
      try {
        upload = await this._inspectFinalization(
          upload.id,
          binding,
          signal
        );
      } catch (error) {
        if (error?.retryable !== true) throw error;
        delayMs = Math.min(
          delayMs * 2,
          SERMON_MEDIA_FINALIZATION_POLL_MAX_MS
        );
        continue;
      }
      onProgress(publicProgress(upload, 'finalizing'));
      const afterPollAt = this._now();
      if (upload.state === 'finalizing'
        && afterPollAt - lastReplayAt
          >= SERMON_MEDIA_FINALIZATION_REPLAY_INTERVAL_MS) {
        lastReplayAt = afterPollAt;
        try {
          upload = await this._postCompletion(upload.id, binding, signal);
          onProgress(publicProgress(upload, 'finalizing'));
        } catch (error) {
          if (error?.retryable !== true) throw error;
        }
      }
      delayMs = Math.min(
        delayMs * 2,
        SERMON_MEDIA_FINALIZATION_POLL_MAX_MS
      );
    }
    return upload;
  }

  async upload(rawReference, {
    attemptId,
    signal = null,
    onAcknowledged = async () => {},
    onProgress = () => {}
  } = {}) {
    if (typeof onAcknowledged !== 'function') {
      throw new TypeError(
        'Sermon-media acknowledgement callback is invalid'
      );
    }
    if (typeof onProgress !== 'function') {
      throw new TypeError('Sermon-media progress callback is invalid');
    }
    if (typeof attemptId !== 'string'
      || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u
        .test(attemptId)) {
      throw new TypeError('Sermon-media upload attempt identity is invalid');
    }
    const reference = normalizeReference(rawReference);
    try {
      const initialBinding = await this._resolve(reference);
      let upload = await this._init(
        reference,
        initialBinding,
        attemptId,
        signal
      );
      // Community has durably assigned this opaque upload identity. Persist it
      // before exposing progress or reading another byte so an app restart can
      // still issue an authoritative DELETE even if the local recording later
      // goes missing.
      await onAcknowledged(upload.id);
      onProgress(publicProgress(upload, 'starting'));
      upload = ['complete', 'finalizing'].includes(upload.state)
        ? await this._inspectFinalization(
            upload.id,
            initialBinding,
            signal
          )
        : await this._state(
            reference,
            initialBinding,
            upload.id,
            signal
          );
      onProgress(publicProgress(upload, 'uploading'));

      if (upload.state === 'complete') {
        return Object.freeze({
          binding: initialBinding,
          upload,
          progress: publicProgress(upload, 'complete')
        });
      }
      if (upload.state === 'finalizing') {
        upload = await this._pollFinalization(
          upload,
          initialBinding,
          signal,
          onProgress
        );
        const progress = publicProgress(upload, 'complete');
        onProgress(progress);
        return Object.freeze({
          binding: initialBinding,
          upload,
          progress
        });
      }
      if (upload.state === 'cancelled') {
        fail(
          'UPLOAD_CANCELLED',
          'This private recording upload was cancelled. Start a new upload.'
        );
      }
      if (!['uploading'].includes(upload.state)) {
        fail(
          'UPLOAD_NOT_WRITABLE',
          'Community is not ready to receive this private recording.'
        );
      }

      for (let index = 0; index < upload.chunkCount; index += 1) {
        if (upload.receivedChunks.includes(index)) continue;
        const chunk = await this._chunkBytes(
          reference,
          initialBinding,
          index,
          signal
        );
        const refreshedBinding = await this._resolve(reference, initialBinding);
        const response = await this.client.requestBinary({
          path: `uploads/${encodeURIComponent(upload.id)}/chunks/${index}`,
          method: 'PUT',
          body: chunk.body,
          contentLength: chunk.length,
          contentRange:
            `bytes ${chunk.offset}-${chunk.offset + chunk.length - 1}/${refreshedBinding.recording.sizeBytes}`,
          sha256: chunk.sha256,
          idempotencyKey: sermonMediaIdempotencyKey('chunk', {
            uploadId: upload.id,
            index,
            sha256: chunk.sha256,
            sizeBytes: chunk.length
          }),
          expectedStatuses: [200, 201],
          signal,
          timeoutMs: SERMON_MEDIA_CHUNK_REQUEST_TIMEOUT_MS
        });
        const receipt = normalizeSermonMediaChunkResponse(response.payload);
        if (receipt.chunk.index !== index
          || receipt.chunk.sha256 !== chunk.sha256
          || receipt.chunk.sizeBytes !== chunk.length) {
          fail(
            'INVALID_RESPONSE',
            'Community returned a mismatched sermon-media chunk receipt.'
          );
        }
        upload = this._assertUpload(receipt.upload, initialBinding);
        onProgress(publicProgress(upload, 'uploading'));
      }

      upload = await this._state(
        reference,
        initialBinding,
        upload.id,
        signal
      );
      this._assertCompletionReady(upload, initialBinding);
      const finalBinding = await this._verifiedBinding(
        reference,
        initialBinding
      );
      upload = await this._claimCompletion(
        upload.id,
        finalBinding,
        signal
      );
      if (upload.state === 'finalizing') {
        upload = await this._pollFinalization(
          upload,
          initialBinding,
          signal,
          onProgress
        );
      }
      if (upload.state !== 'complete'
        || upload.receivedBytes !== initialBinding.recording.sizeBytes) {
        fail(
          'INVALID_RESPONSE',
          'Community did not confirm the complete private recording.'
        );
      }
      const progress = publicProgress(upload, 'complete');
      onProgress(progress);
      return Object.freeze({
        binding: initialBinding,
        upload,
        progress
      });
    } catch (error) {
      throw mapError(error);
    }
  }

  async resumeFinalization(rawBinding, uploadId, {
    signal = null,
    onProgress = () => {}
  } = {}) {
    if (typeof uploadId !== 'string' || !UPLOAD_ID_PATTERN.test(uploadId)) {
      fail('INVALID_UPLOAD_ID', 'The private recording upload ID is invalid.');
    }
    if (typeof onProgress !== 'function') {
      throw new TypeError('Sermon-media progress callback is invalid');
    }
    const binding = normalizeRecoveryBinding(rawBinding);
    try {
      let upload = await this._inspectFinalization(
        uploadId,
        binding,
        signal,
        { allowUploading: true }
      );
      if (upload.state === 'uploading') {
        this._assertCompletionReady(upload, binding);
        upload = await this._claimCompletion(
          upload.id,
          binding,
          signal
        );
      }
      onProgress(publicProgress(upload, 'finalizing'));
      if (upload.state === 'finalizing') {
        upload = await this._pollFinalization(
          upload,
          binding,
          signal,
          onProgress
        );
      }
      if (upload.state !== 'complete'
        || upload.receivedBytes !== binding.recording.sizeBytes) {
        fail(
          'INVALID_RESPONSE',
          'Community did not confirm the complete private recording.'
        );
      }
      const progress = publicProgress(upload, 'complete');
      onProgress(progress);
      return Object.freeze({
        binding,
        upload,
        progress
      });
    } catch (error) {
      throw mapError(error);
    }
  }

  async cancel(uploadId, {
    signal = null
  } = {}) {
    if (typeof uploadId !== 'string' || !UPLOAD_ID_PATTERN.test(uploadId)) {
      fail('INVALID_UPLOAD_ID', 'The private recording upload ID is invalid.');
    }
    try {
      const response = await this.client.requestJson({
        path: `uploads/${encodeURIComponent(uploadId)}`,
        method: 'DELETE',
        headers: {
          'Idempotency-Key': sermonMediaIdempotencyKey('cancel', {
            uploadId
          })
        },
        expectedStatuses: [200],
        signal,
        timeoutMs: SERMON_MEDIA_CONTROL_REQUEST_TIMEOUT_MS
      });
      const upload = normalizeSermonMediaUploadResponse(response.payload);
      if (upload.id !== uploadId || upload.state !== 'cancelled') {
        fail(
          'INVALID_RESPONSE',
          'Community did not confirm cancellation of the private recording upload.'
        );
      }
      return Object.freeze({
        upload,
        progress: publicProgress(upload, 'cancelled')
      });
    } catch (error) {
      throw mapError(error);
    }
  }

  async recoverInit(binding, attemptId, {
    signal = null
  } = {}) {
    if (typeof attemptId !== 'string'
      || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u
        .test(attemptId)) {
      throw new TypeError('Sermon-media upload attempt identity is invalid');
    }
    try {
      const body = buildSermonMediaInitBody({
        syncId: binding?.sermonId,
        expectedSyncVersion: binding?.expectedSyncVersion,
        expectedCurrentRevision: binding?.expectedCurrentRevision,
        recording: binding?.recording
      });
      const response = await this.client.requestJson({
        path: 'uploads',
        method: 'POST',
        headers: {
          'Idempotency-Key': sermonMediaIdempotencyKey('init', {
            attemptId,
            body
          })
        },
        body,
        expectedStatuses: [200, 201],
        signal,
        timeoutMs: SERMON_MEDIA_CONTROL_REQUEST_TIMEOUT_MS
      });
      const upload = normalizeSermonMediaUploadResponse(response.payload);
      this._assertUploadIdentity(upload, {
        sermonId: body.sermon.syncId,
        expectedSyncVersion: body.sermon.expectedSyncVersion,
        expectedCurrentRevision: body.sermon.expectedCurrentRevision,
        recording: body.recording
      });
      return Object.freeze({
        upload,
        progress: publicProgress(
          upload,
          upload.state === 'finalizing' ? 'finalizing' : 'uploading'
        )
      });
    } catch (error) {
      throw mapError(error);
    }
  }

  async inspect(uploadId, {
    signal = null
  } = {}) {
    if (typeof uploadId !== 'string' || !UPLOAD_ID_PATTERN.test(uploadId)) {
      fail('INVALID_UPLOAD_ID', 'The private recording upload ID is invalid.');
    }
    try {
      const response = await this.client.requestJson({
        path: `uploads/${encodeURIComponent(uploadId)}`,
        method: 'GET',
        expectedStatuses: [200],
        signal,
        timeoutMs: SERMON_MEDIA_CONTROL_REQUEST_TIMEOUT_MS
      });
      const upload = normalizeSermonMediaUploadResponse(response.payload);
      if (upload.id !== uploadId) {
        fail(
          'INVALID_RESPONSE',
          'Community returned state for a different private recording upload.'
        );
      }
      return Object.freeze({
        upload,
        progress: publicProgress(
          upload,
          upload.state === 'finalizing' ? 'finalizing' : 'uploading'
        )
      });
    } catch (error) {
      throw mapError(error);
    }
  }
}

module.exports = {
  CommunitySermonMediaUpload,
  CommunitySermonMediaUploadError,
  SERMON_MEDIA_CHUNK_REQUEST_TIMEOUT_MS,
  SERMON_MEDIA_COMPLETE_REQUEST_TIMEOUT_MS,
  SERMON_MEDIA_CONTROL_REQUEST_TIMEOUT_MS,
  SERMON_MEDIA_FINALIZATION_MAX_WAIT_MS,
  SERMON_MEDIA_FINALIZATION_POLL_INITIAL_MS,
  SERMON_MEDIA_FINALIZATION_POLL_MAX_MS,
  SERMON_MEDIA_FINALIZATION_REPLAY_INTERVAL_MS,
  normalizeSermonMediaUploadBinding: normalizeBinding,
  normalizeSermonMediaUploadReference: normalizeReference
};
