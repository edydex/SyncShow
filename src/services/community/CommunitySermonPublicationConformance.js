'use strict';

const crypto = require('crypto');

const {
  parseSermonDocument
} = require('../sermon/SermonDocument');
const {
  buildSermonPublicPassageIndex,
  buildSermonPublicProjection,
  parseSermonPublicCatalog,
  parseSermonPublicDetail,
  parseSermonPublicPassageIndex,
  serializeSermonPublicPassageIndex,
  verifySermonPublicDetailForCatalogItem
} = require('../sermon/SermonPublicProjection');
const {
  normalizeSermonPublicationState
} = require('./CommunitySermonPublicationWire');

const CONFORMANCE_REQUEST_KEYS = [
  'documentSource',
  'publicationState',
  'detailSource',
  'catalogSource',
  'passageIndexSource'
];

class CommunitySermonPublicationConformanceError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'CommunitySermonPublicationConformanceError';
    this.code = code;
    this.details = details;
  }
}

function fail(code, message, details = {}) {
  throw new CommunitySermonPublicationConformanceError(code, message, details);
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
      'INVALID_PUBLICATION_CONFORMANCE_REQUEST',
      'Community sermon publication conformance input must be a plain object.'
    );
  }
  const expected = new Set(CONFORMANCE_REQUEST_KEYS);
  for (const key of CONFORMANCE_REQUEST_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) {
      fail(
        'INVALID_PUBLICATION_CONFORMANCE_REQUEST',
        `Community sermon publication conformance input is missing ${key}.`,
        { field: key }
      );
    }
  }
  for (const key of Object.keys(value)) {
    if (!expected.has(key)) {
      fail(
        'INVALID_PUBLICATION_CONFORMANCE_REQUEST',
        'Community sermon publication conformance input contains an unsupported field.',
        { field: key }
      );
    }
  }
}

function checked(operation, code, message) {
  try {
    return operation();
  } catch (error) {
    if (error instanceof CommunitySermonPublicationConformanceError) throw error;
    fail(code, message, { causeCode: error?.code || null });
  }
}

function sha256(source) {
  return crypto.createHash('sha256').update(source, 'utf8').digest('hex');
}

function assertSourceHash(source, expected, code, label) {
  if (sha256(source) !== expected) {
    fail(code, `${label} do not match the authenticated publication state.`);
  }
}

function orderedSelection(documentItems, selectedIds) {
  const selected = new Set(selectedIds);
  return documentItems
    .filter(item => selected.has(item.id))
    .map(item => item.id);
}

function sameList(left, right) {
  return left.length === right.length
    && left.every((value, index) => value === right[index]);
}

/**
 * Pure cross-repository receipt verifier.
 *
 * This binds one authenticated, read-only Community publication state to the
 * exact immutable sermon revision and anonymous detail/catalog/passage-index
 * bytes. It performs no network request, persistence, authentication, or
 * publication-state mutation.
 */
function verifyCommunitySermonPublicationConformance(options = {}) {
  assertExactRequest(options);

  const publicationState = checked(
    () => normalizeSermonPublicationState(options.publicationState),
    'INVALID_PUBLICATION_CONFORMANCE_STATE',
    'Community sermon publication state is invalid.'
  );
  if (publicationState.publicRevision === null) {
    fail(
      'INACTIVE_PUBLICATION_CONFORMANCE',
      'Only an active public sermon revision has anonymous publication artifacts.'
    );
  }

  const projection = checked(
    () => buildSermonPublicProjection({
      documentSource: options.documentSource,
      publicRevision: publicationState.publicRevision,
      selectedBodyEntryIds: publicationState.selectedBodyEntryIds,
      selectedMediaIds: publicationState.selectedMediaIds
    }),
    'INVALID_PUBLICATION_CONFORMANCE_SOURCE',
    'The exact public sermon revision or its selected content is invalid.'
  );
  const document = checked(
    () => parseSermonDocument(options.documentSource),
    'INVALID_PUBLICATION_CONFORMANCE_SOURCE',
    'The exact public sermon revision is invalid.'
  );

  if (projection.detail.sermonId !== publicationState.syncId) {
    fail(
      'PUBLICATION_CONFORMANCE_ID_MISMATCH',
      'The exact public sermon revision does not match the publication identity.'
    );
  }
  if (projection.detail.publicId !== publicationState.publicId) {
    fail(
      'PUBLICATION_CONFORMANCE_PUBLIC_ID_MISMATCH',
      'The deterministic public content ID does not match the publication state.'
    );
  }
  if (document.publication.publishedAt !== publicationState.publishedAt) {
    fail(
      'PUBLICATION_CONFORMANCE_TIME_MISMATCH',
      'The exact public sermon revision does not match the publication time.'
    );
  }
  if (
    !sameList(
      publicationState.selectedBodyEntryIds,
      orderedSelection(document.body || [], publicationState.selectedBodyEntryIds)
    )
    || !sameList(
      publicationState.selectedMediaIds,
      orderedSelection(document.media, publicationState.selectedMediaIds)
    )
  ) {
    fail(
      'PUBLICATION_CONFORMANCE_SELECTION_ORDER_MISMATCH',
      'Public body and media selections must use canonical sermon document order.'
    );
  }
  checked(
    () => parseSermonPublicDetail(options.detailSource),
    'INVALID_PUBLICATION_CONFORMANCE_DETAIL',
    'The anonymous sermon detail is invalid or noncanonical.'
  );
  if (projection.detailSource !== options.detailSource) {
    fail(
      'PUBLICATION_CONFORMANCE_DETAIL_MISMATCH',
      'The anonymous sermon detail differs from the exact selected public revision.'
    );
  }
  if (projection.checksum !== publicationState.detailChecksum) {
    fail(
      'PUBLICATION_CONFORMANCE_DETAIL_CHECKSUM_MISMATCH',
      'The anonymous sermon detail checksum differs from the publication state.'
    );
  }

  const catalog = checked(
    () => parseSermonPublicCatalog(options.catalogSource),
    'INVALID_PUBLICATION_CONFORMANCE_CATALOG',
    'The anonymous sermon catalog is invalid or noncanonical.'
  );
  assertSourceHash(
    options.catalogSource,
    publicationState.catalogChecksum,
    'PUBLICATION_CONFORMANCE_CATALOG_CHECKSUM_MISMATCH',
    'The anonymous sermon catalog bytes'
  );
  const catalogItem = catalog.items.find(item =>
    item.id === publicationState.publicId);
  if (!catalogItem) {
    fail(
      'PUBLICATION_CONFORMANCE_CATALOG_ITEM_MISSING',
      'The anonymous sermon catalog omits the active public sermon.'
    );
  }
  checked(
    () => verifySermonPublicDetailForCatalogItem(
      catalogItem,
      options.detailSource
    ),
    'PUBLICATION_CONFORMANCE_CATALOG_DETAIL_MISMATCH',
    'The anonymous sermon catalog and detail do not describe the same exact revision.'
  );

  const passageIndex = checked(
    () => parseSermonPublicPassageIndex(options.passageIndexSource),
    'INVALID_PUBLICATION_CONFORMANCE_PASSAGE_INDEX',
    'The anonymous sermon passage index is invalid or noncanonical.'
  );
  assertSourceHash(
    options.passageIndexSource,
    publicationState.passageIndexChecksum,
    'PUBLICATION_CONFORMANCE_PASSAGE_INDEX_CHECKSUM_MISMATCH',
    'The anonymous sermon passage-index bytes'
  );
  const expectedPassageIndexSource = serializeSermonPublicPassageIndex(
    buildSermonPublicPassageIndex(catalog)
  );
  if (expectedPassageIndexSource !== options.passageIndexSource) {
    fail(
      'PUBLICATION_CONFORMANCE_PASSAGE_INDEX_MISMATCH',
      'The anonymous sermon passage index does not match the exact catalog snapshot.'
    );
  }
  const passageIndexItem = passageIndex.items.find(item =>
    item.publicId === publicationState.publicId);
  if (!passageIndexItem) {
    fail(
      'PUBLICATION_CONFORMANCE_PASSAGE_INDEX_ITEM_MISSING',
      'The anonymous sermon passage index omits the active public sermon.'
    );
  }

  return deepFreeze({
    publicationState,
    detail: projection.detail,
    catalog,
    passageIndex,
    catalogItem,
    passageIndexItem
  });
}

module.exports = {
  CommunitySermonPublicationConformanceError,
  verifyCommunitySermonPublicationConformance
};
