'use strict';

const {
  verifyCommunitySermonPublicationConformance
} = require('./CommunitySermonPublicationConformance');
const {
  normalizeSermonPublicationState
} = require('./CommunitySermonPublicationWire');

const SYNC_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const ARTIFACT_KEYS = Object.freeze([
  'detailSource',
  'catalogSource',
  'passageIndexSource'
]);
const PUBLICATION_STATE_SCALAR_KEYS = Object.freeze([
  'schemaVersion',
  'syncId',
  'currentRevision',
  'syncVersion',
  'publicationVersion',
  'publicRevision',
  'publicId',
  'detailChecksum',
  'catalogChecksum',
  'passageIndexChecksum',
  'publishedAt'
]);
const PUBLICATION_STATE_LIST_KEYS = Object.freeze([
  'selectedBodyEntryIds',
  'selectedMediaIds'
]);

class CommunitySermonPublicationProbeError extends Error {
  constructor(code, message, { cause = null, details = {} } = {}) {
    super(message);
    this.name = 'CommunitySermonPublicationProbeError';
    this.code = code;
    this.cause = cause;
    this.details = details;
  }
}

function fail(code, message, cause = null, details = {}) {
  throw new CommunitySermonPublicationProbeError(code, message, {
    cause,
    details
  });
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function assertNotAborted(signal) {
  if (!signal?.aborted) return;
  if (signal.reason instanceof Error) throw signal.reason;
  const error = new Error('Community sermon publication verification was cancelled.');
  error.name = 'AbortError';
  error.code = 'PUBLICATION_PROBE_CANCELLED';
  throw error;
}

function rethrowAbort(error, signal) {
  if (signal?.aborted) assertNotAborted(signal);
  if (error?.name === 'AbortError' || error?.code === 'ABORT_ERR') throw error;
}

function normalizeSyncId(value) {
  if (typeof value !== 'string' || !SYNC_ID_PATTERN.test(value)) {
    fail('INVALID_PUBLICATION_PROBE', 'Sermon publication verification requires a valid sermon ID.');
  }
  return value;
}

function normalizePublicationState(value, expectedSyncId = null) {
  let publicationState;
  try {
    publicationState = normalizeSermonPublicationState(value);
  } catch (error) {
    fail(
      'INVALID_PUBLICATION_STATE',
      'Community returned an invalid sermon publication state.',
      error,
      { causeCode: error?.code || null }
    );
  }
  if (expectedSyncId !== null && publicationState.syncId !== expectedSyncId) {
    fail(
      'PUBLICATION_ID_MISMATCH',
      'Community returned publication state for a different sermon.'
    );
  }
  return publicationState;
}

function sameOrderedList(left, right) {
  return left.length === right.length
    && left.every((value, index) => value === right[index]);
}

function samePublicationState(left, right) {
  return PUBLICATION_STATE_SCALAR_KEYS.every(key => left[key] === right[key])
    && PUBLICATION_STATE_LIST_KEYS.every(key =>
      sameOrderedList(left[key], right[key]));
}

function normalizeArtifacts(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail(
      'INVALID_PUBLICATION_ARTIFACTS',
      'Community returned an invalid public sermon artifact set.'
    );
  }
  const expected = new Set(ARTIFACT_KEYS);
  for (const key of ARTIFACT_KEYS) {
    if (typeof value[key] !== 'string') {
      fail(
        'INVALID_PUBLICATION_ARTIFACTS',
        `Community public sermon artifacts are missing ${key}.`,
        null,
        { field: key }
      );
    }
  }
  for (const key of Object.keys(value)) {
    if (!expected.has(key)) {
      fail(
        'INVALID_PUBLICATION_ARTIFACTS',
        'Community public sermon artifacts contain an unsupported field.',
        null,
        { field: key }
      );
    }
  }
  return value;
}

function localDocumentSource(value, publicRevision) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail(
      'PUBLIC_REVISION_UNAVAILABLE',
      'The exact public sermon revision is unavailable in the local immutable library.',
      null,
      { publicRevision }
    );
  }
  if (value.revision !== publicRevision) {
    fail(
      'PUBLIC_REVISION_UNAVAILABLE',
      'The local sermon revision does not match Community’s exact public revision.',
      null,
      { publicRevision }
    );
  }
  if (
    typeof value.documentSource === 'string'
    && typeof value.source === 'string'
    && value.documentSource !== value.source
  ) {
    fail(
      'PUBLIC_REVISION_UNAVAILABLE',
      'The local immutable sermon revision contains conflicting source bytes.',
      null,
      { publicRevision }
    );
  }
  const source = typeof value.documentSource === 'string'
    ? value.documentSource
    : value.source;
  if (typeof source !== 'string') {
    fail(
      'PUBLIC_REVISION_UNAVAILABLE',
      'The exact public sermon revision has no canonical local source.',
      null,
      { publicRevision }
    );
  }
  return source;
}

function summaryFromVerification(publicationState, verified) {
  let primaryReferenceCount = 0;
  let mentionedReferenceCount = 0;
  for (const reference of verified.detail.references) {
    if (reference.role === 'primary') primaryReferenceCount += 1;
    else if (reference.role === 'mentioned') mentionedReferenceCount += 1;
  }
  return deepFreeze({
    status: publicationState.publicRevision === publicationState.currentRevision
      ? 'verified-current'
      : 'verified-older',
    publicId: publicationState.publicId,
    publishedAt: publicationState.publishedAt,
    publicationVersion: publicationState.publicationVersion,
    bodyEntryCount: verified.detail.body.length,
    mediaCount: verified.detail.media.length,
    primaryReferenceCount,
    mentionedReferenceCount
  });
}

async function verifyDeployedCommunitySermonPublication({
  client,
  localLibrary,
  syncId,
  accessToken,
  signal = null
} = {}) {
  if (
    !client
    || typeof client.getSermonPublication !== 'function'
    || typeof client.getSermonPublicationArtifacts !== 'function'
  ) {
    throw new TypeError(
      'Community sermon publication verification requires a compatible Community client.'
    );
  }
  if (!localLibrary || typeof localLibrary.readRevision !== 'function') {
    throw new TypeError(
      'Community sermon publication verification requires a compatible local sermon library.'
    );
  }

  const sermonId = normalizeSyncId(syncId);
  assertNotAborted(signal);
  const publicationState = normalizePublicationState(
    await client.getSermonPublication({
      syncId: sermonId,
      accessToken,
      signal
    }),
    sermonId
  );
  assertNotAborted(signal);
  if (publicationState.publicRevision === null) {
    fail(
      'PUBLICATION_NOT_ACTIVE',
      'This sermon does not have an active public Community revision.'
    );
  }

  let localRevision;
  try {
    localRevision = await localLibrary.readRevision(
      sermonId,
      publicationState.publicRevision
    );
  } catch (error) {
    rethrowAbort(error, signal);
    fail(
      'PUBLIC_REVISION_UNAVAILABLE',
      'The exact public sermon revision is unavailable in the local immutable library.',
      error,
      {
        publicRevision: publicationState.publicRevision,
        causeCode: error?.code || null
      }
    );
  }
  assertNotAborted(signal);
  const documentSource = localDocumentSource(
    localRevision,
    publicationState.publicRevision
  );

  const artifacts = normalizeArtifacts(
    await client.getSermonPublicationArtifacts({
      publicId: publicationState.publicId,
      signal
    })
  );
  assertNotAborted(signal);

  const stablePublicationState = normalizePublicationState(
    await client.getSermonPublication({
      syncId: sermonId,
      accessToken,
      signal
    })
  );
  assertNotAborted(signal);
  if (!samePublicationState(publicationState, stablePublicationState)) {
    fail(
      'PUBLICATION_STATE_CHANGED',
      'The Community sermon publication changed while its public files were being verified. Refresh and try again.'
    );
  }

  let verified;
  try {
    verified = verifyCommunitySermonPublicationConformance({
      documentSource,
      publicationState: stablePublicationState,
      detailSource: artifacts.detailSource,
      catalogSource: artifacts.catalogSource,
      passageIndexSource: artifacts.passageIndexSource
    });
  } catch (error) {
    rethrowAbort(error, signal);
    fail(
      'PUBLICATION_CONFORMANCE_FAILED',
      'The deployed public sermon does not match Community’s authenticated publication state.',
      error,
      { causeCode: error?.code || null }
    );
  }

  return deepFreeze({
    publicationState: verified.publicationState,
    summary: summaryFromVerification(verified.publicationState, verified)
  });
}

module.exports = {
  CommunitySermonPublicationProbeError,
  verifyDeployedCommunitySermonPublication
};
