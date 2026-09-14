'use strict';

const crypto = require('crypto');

const {
  buildSermonPublicationTransition
} = require('../sermon/SermonPublicationTransition');
const {
  buildSermonPublicPassageIndex,
  parseSermonPublicCatalog,
  parseSermonPublicPassageIndex,
  serializeSermonPublicCatalog,
  serializeSermonPublicPassageIndex
} = require('../sermon/SermonPublicProjection');
const {
  normalizeSermonPublicationState,
  normalizeSermonPublishIntent
} = require('./CommunitySermonPublicationWire');
const {
  verifyCommunitySermonPublicationConformance
} = require('./CommunitySermonPublicationConformance');

const FIRST_PUBLICATION_REQUEST_KEYS = [
  'readyDocumentSource',
  'publishedDocumentSource',
  'preState',
  'publishIntent',
  'serverPublishedAt',
  'preCatalogAuthority',
  'postState',
  'postDetailSource',
  'postCatalogAuthority'
];

const CATALOG_AUTHORITY_KEYS = [
  'schemaVersion',
  'generation',
  'changedAt',
  'checksum',
  'source',
  'passageIndexChecksum',
  'passageIndexSource'
];

const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const CANONICAL_TIMESTAMP_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

class CommunitySermonFirstPublicationTransactionConformanceError
  extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name =
      'CommunitySermonFirstPublicationTransactionConformanceError';
    this.code = code;
    this.details = details;
  }
}

function fail(code, message, details = {}) {
  throw new CommunitySermonFirstPublicationTransactionConformanceError(
    code,
    message,
    details
  );
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function isPlainRecord(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertExactKeys(value, keys, label, code) {
  if (!isPlainRecord(value)) {
    fail(code, `${label} must be a plain object.`);
  }
  const expected = new Set(keys);
  for (const key of keys) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) {
      fail(code, `${label} is missing ${key}.`, { field: key });
    }
  }
  for (const key of Object.keys(value)) {
    if (!expected.has(key)) {
      fail(code, `${label} contains an unsupported field.`, { field: key });
    }
  }
}

function assertExactRequest(value) {
  assertExactKeys(
    value,
    FIRST_PUBLICATION_REQUEST_KEYS,
    'Community sermon first-publication transaction input',
    'INVALID_FIRST_PUBLICATION_TRANSACTION_REQUEST'
  );
}

function checked(operation, code, message) {
  try {
    return operation();
  } catch (error) {
    if (
      error
      instanceof CommunitySermonFirstPublicationTransactionConformanceError
    ) {
      throw error;
    }
    fail(code, message, { causeCode: error?.code || null });
  }
}

function sha256(source) {
  return crypto.createHash('sha256').update(source, 'utf8').digest('hex');
}

function requireEqual(actual, expected, field, code, message) {
  if (actual !== expected) {
    fail(code, message, { field });
  }
}

function sameList(left, right) {
  return left.length === right.length
    && left.every((value, index) => value === right[index]);
}

function nextVersion(value, field) {
  if (value === Number.MAX_SAFE_INTEGER) {
    fail(
      'FIRST_PUBLICATION_TRANSACTION_VERSION_EXHAUSTED',
      'Community sermon first publication cannot safely increment its version.',
      { field }
    );
  }
  return value + 1;
}

function normalizeCanonicalTimestamp(value, label, code) {
  if (
    typeof value !== 'string'
    || !CANONICAL_TIMESTAMP_PATTERN.test(value)
    || !Number.isFinite(Date.parse(value))
  ) {
    fail(code, `${label} must be an exact canonical UTC timestamp.`);
  }
  let canonical = null;
  try {
    canonical = new Date(value).toISOString();
  } catch (_error) {
    // The canonical equality below handles dates outside the supported range.
  }
  if (canonical !== value) {
    fail(code, `${label} must be an exact canonical UTC timestamp.`);
  }
  return value;
}

function nextCanonicalTimestamp(previous, candidate) {
  const previousMs = Date.parse(previous);
  const candidateMs = Date.parse(candidate);
  return new Date(Math.max(candidateMs, previousMs + 1)).toISOString();
}

function verifyCatalogAuthority(raw, phase) {
  const code = `INVALID_FIRST_PUBLICATION_${phase}_CATALOG_AUTHORITY`;
  const label = `${phase === 'PRE' ? 'Pre' : 'Post'}-transaction sermon catalog authority`;
  assertExactKeys(raw, CATALOG_AUTHORITY_KEYS, label, code);
  if (raw.schemaVersion !== 1) {
    fail(code, `${label} uses an unsupported schema version.`);
  }
  if (!Number.isSafeInteger(raw.generation) || raw.generation < 1) {
    fail(code, `${label} generation must be a positive safe integer.`);
  }
  const changedAt = normalizeCanonicalTimestamp(
    raw.changedAt,
    `${label} changedAt`,
    code
  );
  if (
    typeof raw.checksum !== 'string'
    || !SHA256_PATTERN.test(raw.checksum)
    || typeof raw.passageIndexChecksum !== 'string'
    || !SHA256_PATTERN.test(raw.passageIndexChecksum)
  ) {
    fail(code, `${label} checksums are invalid.`);
  }
  if (
    typeof raw.source !== 'string'
    || typeof raw.passageIndexSource !== 'string'
  ) {
    fail(code, `${label} artifact sources are invalid.`);
  }

  const catalog = checked(
    () => parseSermonPublicCatalog(raw.source),
    code,
    `${label} catalog source is invalid or noncanonical.`
  );
  const passageIndex = checked(
    () => parseSermonPublicPassageIndex(raw.passageIndexSource),
    code,
    `${label} passage-index source is invalid or noncanonical.`
  );
  if (
    sha256(raw.source) !== raw.checksum
    || sha256(raw.passageIndexSource) !== raw.passageIndexChecksum
  ) {
    fail(code, `${label} checksums do not match its exact artifact bytes.`);
  }
  const expectedPassageIndexSource = serializeSermonPublicPassageIndex(
    buildSermonPublicPassageIndex(catalog)
  );
  if (raw.passageIndexSource !== expectedPassageIndexSource) {
    fail(
      code,
      `${label} passage index is not the exact derivative of its catalog.`
    );
  }

  return {
    authority: deepFreeze({
      schemaVersion: 1,
      generation: raw.generation,
      changedAt,
      checksum: raw.checksum,
      source: raw.source,
      passageIndexChecksum: raw.passageIndexChecksum,
      passageIndexSource: raw.passageIndexSource
    }),
    catalog,
    passageIndex
  };
}

/**
 * Pure parity gate for one server-side first publication transaction.
 *
 * `preCatalogAuthority` must be the exact, validated singleton row read while
 * the Community server holds its catalog lock. That server-owned generation
 * is the independent authority for global "before" bytes because a
 * never-published sermon correctly has no catalog checksum of its own.
 * `postCatalogAuthority` must be the exact row stored by the same transaction.
 *
 * This verifier binds those records but does not authenticate their caller,
 * authorize publication, persist data, or perform network access.
 */
function verifyCommunitySermonFirstPublicationTransactionConformance(
  options = {}
) {
  assertExactRequest(options);

  const publishIntent = checked(
    () => normalizeSermonPublishIntent(options.publishIntent),
    'INVALID_FIRST_PUBLICATION_TRANSACTION_INTENT',
    'The Community sermon first-publication intent is invalid.'
  );
  const preState = checked(
    () => normalizeSermonPublicationState(options.preState),
    'INVALID_FIRST_PUBLICATION_TRANSACTION_PRE_STATE',
    'The pre-transaction Community sermon publication state is invalid.'
  );
  const postState = checked(
    () => normalizeSermonPublicationState(options.postState),
    'INVALID_FIRST_PUBLICATION_TRANSACTION_POST_STATE',
    'The post-transaction Community sermon publication state is invalid.'
  );

  if (
    preState.publicationVersion !== null
    || preState.publicRevision !== null
  ) {
    fail(
      'FIRST_PUBLICATION_TRANSACTION_REQUIRED',
      'This parity gate only accepts a sermon that has never been published.'
    );
  }

  const casFields = [
    ['syncId', publishIntent.syncId, preState.syncId],
    ['expectedSyncVersion', publishIntent.expectedSyncVersion, preState.syncVersion],
    [
      'expectedCurrentRevision',
      publishIntent.expectedCurrentRevision,
      preState.currentRevision
    ],
    [
      'expectedPublicationVersion',
      publishIntent.expectedPublicationVersion,
      null
    ],
    ['expectedPublicRevision', publishIntent.expectedPublicRevision, null]
  ];
  for (const [field, actual, expected] of casFields) {
    requireEqual(
      actual,
      expected,
      field,
      'FIRST_PUBLICATION_TRANSACTION_CAS_MISMATCH',
      'The publish intent does not match the exact never-published compare-and-swap state.'
    );
  }

  const transition = checked(
    () => buildSermonPublicationTransition({
      documentSource: options.readyDocumentSource,
      publishedAt: options.serverPublishedAt,
      selectedBodyEntryIds: publishIntent.selectedBodyEntryIds,
      selectedMediaIds: publishIntent.selectedMediaIds
    }),
    'INVALID_FIRST_PUBLICATION_TRANSACTION_TRANSITION',
    'The exact Ready sermon revision cannot produce the requested first-publication transition.'
  );
  requireEqual(
    transition.baseRevision,
    preState.currentRevision,
    'preState.currentRevision',
    'FIRST_PUBLICATION_TRANSACTION_BASE_REVISION_MISMATCH',
    'The canonical Ready source is not the exact current revision guarded by the transaction.'
  );
  requireEqual(
    transition.document.id,
    preState.syncId,
    'preState.syncId',
    'FIRST_PUBLICATION_TRANSACTION_ID_MISMATCH',
    'The canonical Ready source does not match the stable sermon identity.'
  );
  requireEqual(
    options.publishedDocumentSource,
    transition.documentSource,
    'publishedDocumentSource',
    'FIRST_PUBLICATION_TRANSACTION_PUBLISHED_SOURCE_MISMATCH',
    'The persisted Published sermon source is not the exact server-authored transition result.'
  );

  const preAuthority = verifyCatalogAuthority(
    options.preCatalogAuthority,
    'PRE'
  );
  const targetPublicId = transition.projection.detail.publicId;
  if (preAuthority.catalog.items.some(item =>
    item.id === targetPublicId || item.sermonId === preState.syncId)) {
    fail(
      'FIRST_PUBLICATION_TRANSACTION_TARGET_ALREADY_PUBLIC',
      'A first publication cannot replace an existing public catalog identity.'
    );
  }

  const expectedSyncVersion = nextVersion(
    preState.syncVersion,
    'postState.syncVersion'
  );
  const postFields = [
    ['syncId', postState.syncId, preState.syncId],
    ['currentRevision', postState.currentRevision, transition.publicRevision],
    ['syncVersion', postState.syncVersion, expectedSyncVersion],
    ['publicationVersion', postState.publicationVersion, 1],
    ['publicRevision', postState.publicRevision, transition.publicRevision],
    ['publicId', postState.publicId, targetPublicId],
    ['detailChecksum', postState.detailChecksum, transition.projection.checksum],
    ['publishedAt', postState.publishedAt, options.serverPublishedAt]
  ];
  for (const [field, actual, expected] of postFields) {
    requireEqual(
      actual,
      expected,
      `postState.${field}`,
      field === 'syncVersion' || field === 'publicationVersion'
        ? 'FIRST_PUBLICATION_TRANSACTION_VERSION_MISMATCH'
        : 'FIRST_PUBLICATION_TRANSACTION_POST_STATE_MISMATCH',
      field === 'syncVersion' || field === 'publicationVersion'
        ? 'The first-publication transaction did not advance to the exact first version.'
        : 'The post-transaction state does not match the exact first-publication transition.'
    );
  }
  if (
    !sameList(postState.selectedBodyEntryIds, transition.selectedBodyEntryIds)
    || !sameList(postState.selectedMediaIds, transition.selectedMediaIds)
  ) {
    fail(
      'FIRST_PUBLICATION_TRANSACTION_SELECTION_MISMATCH',
      'The post-transaction selections are not the requested IDs in canonical document order.'
    );
  }
  requireEqual(
    options.postDetailSource,
    transition.projection.detailSource,
    'postDetailSource',
    'FIRST_PUBLICATION_TRANSACTION_POST_DETAIL_MISMATCH',
    'The post-transaction detail bytes differ from the exact first-publication transition.'
  );

  const expectedPostCatalogSource = checked(
    () => serializeSermonPublicCatalog({
      schemaVersion: preAuthority.catalog.schemaVersion,
      contentType: preAuthority.catalog.contentType,
      items: [
        ...preAuthority.catalog.items,
        transition.projection.catalogItem
      ]
    }),
    'INVALID_FIRST_PUBLICATION_TRANSACTION_POST_CATALOG',
    'The first-publication transaction cannot regenerate the global sermon catalog.'
  );
  const expectedPostPassageIndexSource = checked(
    () => serializeSermonPublicPassageIndex(
      buildSermonPublicPassageIndex(
        parseSermonPublicCatalog(expectedPostCatalogSource)
      )
    ),
    'INVALID_FIRST_PUBLICATION_TRANSACTION_POST_PASSAGE_INDEX',
    'The first-publication transaction cannot regenerate the global sermon passage index.'
  );
  const postAuthority = verifyCatalogAuthority(
    options.postCatalogAuthority,
    'POST'
  );

  requireEqual(
    postAuthority.authority.generation,
    nextVersion(
      preAuthority.authority.generation,
      'postCatalogAuthority.generation'
    ),
    'postCatalogAuthority.generation',
    'FIRST_PUBLICATION_TRANSACTION_CATALOG_GENERATION_MISMATCH',
    'The catalog authority generation did not advance exactly once.'
  );
  requireEqual(
    postAuthority.authority.changedAt,
    nextCanonicalTimestamp(
      preAuthority.authority.changedAt,
      options.serverPublishedAt
    ),
    'postCatalogAuthority.changedAt',
    'FIRST_PUBLICATION_TRANSACTION_CATALOG_TIME_MISMATCH',
    'The catalog authority time is not the exact monotonic transaction time.'
  );
  requireEqual(
    postAuthority.authority.source,
    expectedPostCatalogSource,
    'postCatalogAuthority.source',
    'FIRST_PUBLICATION_TRANSACTION_POST_CATALOG_MISMATCH',
    'The post-transaction catalog is not an exact insertion preserving every prior row.'
  );
  requireEqual(
    postAuthority.authority.passageIndexSource,
    expectedPostPassageIndexSource,
    'postCatalogAuthority.passageIndexSource',
    'FIRST_PUBLICATION_TRANSACTION_POST_PASSAGE_INDEX_MISMATCH',
    'The post-transaction passage index is not the exact derivative of the inserted catalog.'
  );
  requireEqual(
    postState.catalogChecksum,
    postAuthority.authority.checksum,
    'postState.catalogChecksum',
    'FIRST_PUBLICATION_TRANSACTION_POST_CATALOG_CHECKSUM_MISMATCH',
    'The post-transaction state does not bind the stored catalog authority checksum.'
  );
  requireEqual(
    postState.passageIndexChecksum,
    postAuthority.authority.passageIndexChecksum,
    'postState.passageIndexChecksum',
    'FIRST_PUBLICATION_TRANSACTION_POST_PASSAGE_INDEX_CHECKSUM_MISMATCH',
    'The post-transaction state does not bind the stored passage-index authority checksum.'
  );

  const conformance = checked(
    () => verifyCommunitySermonPublicationConformance({
      documentSource: options.publishedDocumentSource,
      publicationState: postState,
      detailSource: options.postDetailSource,
      catalogSource: postAuthority.authority.source,
      passageIndexSource: postAuthority.authority.passageIndexSource
    }),
    'INVALID_FIRST_PUBLICATION_TRANSACTION_POST_CONFORMANCE',
    'The first-published state and anonymous publication artifacts are not conformant.'
  );

  return deepFreeze({
    publishIntent,
    preState,
    postState,
    transition,
    preCatalogAuthority: preAuthority.authority,
    preCatalog: preAuthority.catalog,
    prePassageIndex: preAuthority.passageIndex,
    postCatalogAuthority: postAuthority.authority,
    conformance
  });
}

module.exports = {
  CommunitySermonFirstPublicationTransactionConformanceError,
  verifyCommunitySermonFirstPublicationTransactionConformance
};
