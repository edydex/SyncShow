'use strict';

const crypto = require('crypto');

const {
  buildSermonPublicationTransition
} = require('../sermon/SermonPublicationTransition');
const {
  buildSermonPublicPassageIndex,
  parseSermonPublicCatalog,
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

const TRANSACTION_REQUEST_KEYS = [
  'readyDocumentSource',
  'publishedDocumentSource',
  'preState',
  'publishIntent',
  'serverPublishedAt',
  'prePublishedDocumentSource',
  'preDetailSource',
  'preCatalogSource',
  'prePassageIndexSource',
  'postState',
  'postDetailSource',
  'postCatalogSource',
  'postPassageIndexSource'
];

class CommunitySermonPublicationTransactionConformanceError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'CommunitySermonPublicationTransactionConformanceError';
    this.code = code;
    this.details = details;
  }
}

function fail(code, message, details = {}) {
  throw new CommunitySermonPublicationTransactionConformanceError(
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

function assertExactRequest(value) {
  if (!isPlainRecord(value)) {
    fail(
      'INVALID_PUBLICATION_TRANSACTION_REQUEST',
      'Community sermon publication transaction input must be a plain object.'
    );
  }
  const expected = new Set(TRANSACTION_REQUEST_KEYS);
  for (const key of TRANSACTION_REQUEST_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) {
      fail(
        'INVALID_PUBLICATION_TRANSACTION_REQUEST',
        `Community sermon publication transaction input is missing ${key}.`,
        { field: key }
      );
    }
  }
  for (const key of Object.keys(value)) {
    if (!expected.has(key)) {
      fail(
        'INVALID_PUBLICATION_TRANSACTION_REQUEST',
        'Community sermon publication transaction input contains an unsupported field.',
        { field: key }
      );
    }
  }
}

function checked(operation, code, message) {
  try {
    return operation();
  } catch (error) {
    if (
      error
      instanceof CommunitySermonPublicationTransactionConformanceError
    ) {
      throw error;
    }
    fail(code, message, { causeCode: error?.code || null });
  }
}

function sha256(source) {
  return crypto.createHash('sha256').update(source, 'utf8').digest('hex');
}

function sameList(left, right) {
  return left.length === right.length
    && left.every((value, index) => value === right[index]);
}

function requireEqual(actual, expected, field, code, message) {
  if (actual !== expected) {
    fail(code, message, { field });
  }
}

function nextVersion(value, field) {
  if (value === null) return 1;
  if (value === Number.MAX_SAFE_INTEGER) {
    fail(
      'PUBLICATION_TRANSACTION_VERSION_EXHAUSTED',
      'Community sermon publication transaction cannot safely increment its version.',
      { field }
    );
  }
  return value + 1;
}

function verifyPrePublicationSnapshot({
  preState,
  prePublishedDocumentSource,
  preDetailSource,
  preCatalogSource,
  prePassageIndexSource
}) {
  if (preState.publicRevision === null) {
    fail(
      'PUBLICATION_TRANSACTION_REPUBLISH_REQUIRED',
      'This parity gate requires an active prior publication. First publication needs a separately authenticated global catalog generation.'
    );
  }
  const conformance = checked(
    () => verifyCommunitySermonPublicationConformance({
      documentSource: prePublishedDocumentSource,
      publicationState: preState,
      detailSource: preDetailSource,
      catalogSource: preCatalogSource,
      passageIndexSource: prePassageIndexSource
    }),
    'INVALID_PUBLICATION_TRANSACTION_PRE_CONFORMANCE',
    'The exact prior Published sermon, authenticated state, and global anonymous artifacts are not conformant.'
  );
  return {
    preCatalog: conformance.catalog,
    prePassageIndex: conformance.passageIndex,
    preDetail: conformance.detail,
    preConformance: conformance
  };
}

/**
 * Pure parity gate for one server-side active republish transaction.
 *
 * The caller must supply `serverPublishedAt` from its trusted transaction
 * clock. This verifier binds that value but does not authenticate its author.
 * A first publication needs its own gate with an independently authenticated
 * global catalog generation; it cannot use this active-republish vector.
 * It performs no authentication, persistence, network access, or publication.
 */
function verifyCommunitySermonPublicationTransactionConformance(options = {}) {
  assertExactRequest(options);

  const publishIntent = checked(
    () => normalizeSermonPublishIntent(options.publishIntent),
    'INVALID_PUBLICATION_TRANSACTION_INTENT',
    'The Community sermon publish intent is invalid.'
  );
  const preState = checked(
    () => normalizeSermonPublicationState(options.preState),
    'INVALID_PUBLICATION_TRANSACTION_PRE_STATE',
    'The pre-transaction Community sermon publication state is invalid.'
  );
  const postState = checked(
    () => normalizeSermonPublicationState(options.postState),
    'INVALID_PUBLICATION_TRANSACTION_POST_STATE',
    'The post-transaction Community sermon publication state is invalid.'
  );

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
      preState.publicationVersion
    ],
    [
      'expectedPublicRevision',
      publishIntent.expectedPublicRevision,
      preState.publicRevision
    ]
  ];
  for (const [field, actual, expected] of casFields) {
    requireEqual(
      actual,
      expected,
      field,
      'PUBLICATION_TRANSACTION_CAS_MISMATCH',
      'The publish intent does not match the exact pre-transaction compare-and-swap state.'
    );
  }
  if (
    preState.publicRevision !== null
    && preState.publicRevision === preState.currentRevision
  ) {
    fail(
      'PUBLICATION_TRANSACTION_READY_PUBLIC_REVISION_COLLISION',
      'An active republish must start from a Ready current revision distinct from the older public revision.'
    );
  }

  const transition = checked(
    () => buildSermonPublicationTransition({
      documentSource: options.readyDocumentSource,
      publishedAt: options.serverPublishedAt,
      selectedBodyEntryIds: publishIntent.selectedBodyEntryIds,
      selectedMediaIds: publishIntent.selectedMediaIds
    }),
    'INVALID_PUBLICATION_TRANSACTION_TRANSITION',
    'The exact Ready sermon revision cannot produce the requested publication transition.'
  );
  requireEqual(
    transition.baseRevision,
    preState.currentRevision,
    'preState.currentRevision',
    'PUBLICATION_TRANSACTION_BASE_REVISION_MISMATCH',
    'The canonical Ready source is not the exact current revision guarded by the transaction.'
  );
  requireEqual(
    transition.document.id,
    preState.syncId,
    'preState.syncId',
    'PUBLICATION_TRANSACTION_ID_MISMATCH',
    'The canonical Ready source does not match the stable sermon identity.'
  );
  requireEqual(
    options.publishedDocumentSource,
    transition.documentSource,
    'publishedDocumentSource',
    'PUBLICATION_TRANSACTION_PUBLISHED_SOURCE_MISMATCH',
    'The persisted Published sermon source is not the exact server-authored transition result.'
  );

  const preSnapshot = verifyPrePublicationSnapshot({
    preState,
    prePublishedDocumentSource: options.prePublishedDocumentSource,
    preDetailSource: options.preDetailSource,
    preCatalogSource: options.preCatalogSource,
    prePassageIndexSource: options.prePassageIndexSource
  });
  if (transition.publicRevision === preState.publicRevision) {
    fail(
      'PUBLICATION_TRANSACTION_PUBLIC_REVISION_UNCHANGED',
      'An active republish must produce a new exact Published sermon revision.'
    );
  }
  if (Date.parse(options.serverPublishedAt) <= Date.parse(preState.publishedAt)) {
    fail(
      'PUBLICATION_TRANSACTION_TIME_NOT_MONOTONIC',
      'An active republish must use a server publication time later than the prior publication.'
    );
  }

  const expectedSyncVersion = nextVersion(
    preState.syncVersion,
    'postState.syncVersion'
  );
  const expectedPublicationVersion = nextVersion(
    preState.publicationVersion,
    'postState.publicationVersion'
  );
  const postFields = [
    ['syncId', postState.syncId, preState.syncId],
    ['currentRevision', postState.currentRevision, transition.publicRevision],
    ['syncVersion', postState.syncVersion, expectedSyncVersion],
    [
      'publicationVersion',
      postState.publicationVersion,
      expectedPublicationVersion
    ],
    ['publicRevision', postState.publicRevision, transition.publicRevision],
    ['publicId', postState.publicId, transition.projection.detail.publicId],
    ['detailChecksum', postState.detailChecksum, transition.projection.checksum],
    ['publishedAt', postState.publishedAt, options.serverPublishedAt]
  ];
  for (const [field, actual, expected] of postFields) {
    requireEqual(
      actual,
      expected,
      `postState.${field}`,
      field === 'syncVersion' || field === 'publicationVersion'
        ? 'PUBLICATION_TRANSACTION_VERSION_MISMATCH'
        : 'PUBLICATION_TRANSACTION_POST_STATE_MISMATCH',
      field === 'syncVersion' || field === 'publicationVersion'
        ? 'The publication transaction did not increment its version exactly once.'
        : 'The post-transaction state does not match the exact publication transition.'
    );
  }
  if (
    !sameList(postState.selectedBodyEntryIds, transition.selectedBodyEntryIds)
    || !sameList(postState.selectedMediaIds, transition.selectedMediaIds)
  ) {
    fail(
      'PUBLICATION_TRANSACTION_SELECTION_MISMATCH',
      'The post-transaction selections are not the requested IDs in canonical document order.'
    );
  }
  requireEqual(
    options.postDetailSource,
    transition.projection.detailSource,
    'postDetailSource',
    'PUBLICATION_TRANSACTION_POST_DETAIL_MISMATCH',
    'The post-transaction detail bytes differ from the exact publication transition.'
  );

  const expectedPostCatalogSource = checked(
    () => serializeSermonPublicCatalog({
      schemaVersion: preSnapshot.preCatalog.schemaVersion,
      contentType: preSnapshot.preCatalog.contentType,
      items: [
        ...preSnapshot.preCatalog.items.filter(item =>
          item.id !== transition.projection.detail.publicId),
        transition.projection.catalogItem
      ]
    }),
    'INVALID_PUBLICATION_TRANSACTION_POST_CATALOG',
    'The publication transition cannot regenerate the global sermon catalog.'
  );
  requireEqual(
    options.postCatalogSource,
    expectedPostCatalogSource,
    'postCatalogSource',
    'PUBLICATION_TRANSACTION_POST_CATALOG_MISMATCH',
    'The post-transaction catalog is not an exact target replacement preserving every unrelated row.'
  );
  const expectedPostPassageIndexSource = checked(
    () => serializeSermonPublicPassageIndex(
      buildSermonPublicPassageIndex(
        parseSermonPublicCatalog(expectedPostCatalogSource)
      )
    ),
    'INVALID_PUBLICATION_TRANSACTION_POST_PASSAGE_INDEX',
    'The publication transition cannot regenerate the global sermon passage index.'
  );
  requireEqual(
    options.postPassageIndexSource,
    expectedPostPassageIndexSource,
    'postPassageIndexSource',
    'PUBLICATION_TRANSACTION_POST_PASSAGE_INDEX_MISMATCH',
    'The post-transaction passage index is not the exact derivative of the regenerated catalog.'
  );
  requireEqual(
    sha256(options.postCatalogSource),
    postState.catalogChecksum,
    'postState.catalogChecksum',
    'PUBLICATION_TRANSACTION_POST_CATALOG_CHECKSUM_MISMATCH',
    'The post-transaction global catalog checksum does not match its exact bytes.'
  );
  requireEqual(
    sha256(options.postPassageIndexSource),
    postState.passageIndexChecksum,
    'postState.passageIndexChecksum',
    'PUBLICATION_TRANSACTION_POST_PASSAGE_INDEX_CHECKSUM_MISMATCH',
    'The post-transaction global passage-index checksum does not match its exact bytes.'
  );

  const conformance = checked(
    () => verifyCommunitySermonPublicationConformance({
      documentSource: options.publishedDocumentSource,
      publicationState: postState,
      detailSource: options.postDetailSource,
      catalogSource: options.postCatalogSource,
      passageIndexSource: options.postPassageIndexSource
    }),
    'INVALID_PUBLICATION_TRANSACTION_POST_CONFORMANCE',
    'The post-transaction state and anonymous publication artifacts are not conformant.'
  );

  return deepFreeze({
    publishIntent,
    preState,
    postState,
    transition,
    preDetail: preSnapshot.preDetail,
    preCatalog: preSnapshot.preCatalog,
    prePassageIndex: preSnapshot.prePassageIndex,
    preConformance: preSnapshot.preConformance,
    conformance
  });
}

module.exports = {
  CommunitySermonPublicationTransactionConformanceError,
  verifyCommunitySermonPublicationTransactionConformance
};
