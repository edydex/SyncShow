'use strict';

const crypto = require('crypto');
const {
  MAX_SERMON_SOURCE_BYTES
} = require('../sermon/SermonDocument');
const {
  MAX_PUBLIC_SERMON_CATALOG_BYTES,
  MAX_PUBLIC_SERMON_DETAIL_BYTES,
  MAX_PUBLIC_SERMON_PASSAGE_INDEX_BYTES,
  SERMON_PUBLIC_CATALOG_PATH,
  SERMON_PUBLIC_CONTENT_BASE_PATH,
  SERMON_PUBLIC_PASSAGE_INDEX_PATH
} = require('../sermon/SermonPublicProjection');
const {
  CommunitySermonWireError,
  MAX_SERMON_CHANGE_ITEMS,
  MAX_SERMON_CURSOR_BYTES,
  MAX_SERMON_SOURCE_OBJECTS,
  buildSermonCreateBody,
  buildSermonIdempotencyHeaders,
  buildSermonIfMatchHeaders,
  buildSermonUpdateBody,
  normalizeRemoteSermonEnvelope,
  normalizeSermonChangePage
} = require('./CommunitySermonWire');
const {
  CommunitySermonPublicationWireError,
  normalizeSermonPublicationState
} = require('./CommunitySermonPublicationWire');
const {
  CommunitySongPublicLinkReviewError,
  normalizeSongPublicLinkReview: normalizeSongPublicLinkReviewRecord,
  songPublicLinkReviewRevision,
  songPublicLinkReviewStatus
} = require('./CommunitySongPublicLinkReview');
const {
  CommunitySongMemberSharingError,
  buildSongMemberSharingRequest,
  normalizeSongMemberSharingReceipt,
  normalizeSongMemberSharingResponse
} = require('./CommunitySongMemberSharing');
const {
  CommunityServicePlanError,
  MAX_COMMUNITY_SERVICE_PLAN_CURSOR_BYTES,
  MAX_COMMUNITY_SERVICE_PLAN_PAGE_ITEMS,
  MAX_COMMUNITY_SERVICE_PLAN_SOURCE_BYTES,
  normalizeCommunityServicePlanEnvelope,
  normalizeCommunityServicePlanPage
} = require('./CommunityServicePlan');
const {
  HERITAGE_SERVICE_DOCUMENT_STATUSES,
  HeritageServiceDocumentError,
  MAX_HERITAGE_SERVICE_DOCUMENT_BYTES,
  MAX_HERITAGE_SERVICE_DOCUMENT_PAGE_ITEMS,
  normalizeHeritageServiceDocumentEnvelope,
  normalizeHeritageServiceDocumentChangePage,
  normalizeHeritageServiceDocumentPage,
  validateHeritageServiceDocumentSource
} = require('./HeritageServiceDocument');

const DISCOVERY_PATH = '/.well-known/heritage-community.json';
const DEFAULT_API_PATH = '/api/community/syncshow/v1';
const DEFAULT_TIMEOUT_MS = 15000;
const DEFAULT_JSON_LIMIT = 4 * 1024 * 1024;
const AUTHORIZATION_RECOVERY_GRACE_MS = 15 * 60 * 1000;
const MAX_DOCUMENT_BYTES = 512 * 1024;
const MAX_DOCUMENTS = 32;
const MAX_DOCUMENT_TOTAL_BYTES = 2 * 1024 * 1024;
const MAX_SONG_PUBLIC_LINK_ITEMS = 50;
const MAX_SONG_PUBLIC_LINK_RESPONSE_BYTES = 512 * 1024;
const MAX_SONG_MEMBER_SHARING_RESPONSE_BYTES = 128 * 1024;
const MAX_SERMON_PUBLICATION_RESPONSE_BYTES = 128 * 1024;
const MAX_COMMUNITY_SERVICE_PLAN_RESPONSE_BYTES =
  (MAX_COMMUNITY_SERVICE_PLAN_SOURCE_BYTES * 2) + (64 * 1024);
const MAX_HERITAGE_SERVICE_DOCUMENT_CURSOR_BYTES = 2048;
const MAX_HERITAGE_SERVICE_DOCUMENT_RESPONSE_BYTES =
  (MAX_HERITAGE_SERVICE_DOCUMENT_BYTES * 2) + (64 * 1024);
const MAX_HERITAGE_SERVICE_ASSET_BYTES = 75 * 1024 * 1024;
const MAX_HERITAGE_SERVICE_VIDEO_BYTES = 250 * 1024 * 1024;
// A canonical sermon document is already JSON. Embedding it in a wire
// envelope can double every quote or backslash. Reserve a bounded additional
// 512 bytes for each source-availability record and 64 KiB for the envelope,
// headers, and scalar metadata.
const MAX_SERMON_TRANSFER_JSON_BYTES = (MAX_SERMON_SOURCE_BYTES * 2)
  + (MAX_SERMON_SOURCE_OBJECTS * 512)
  + (64 * 1024);
const SYNC_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SERMON_PUBLIC_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,95}$/;
const TOKEN_PATTERN = /^[^\s\u0000-\u001f\u007f]{16,16384}$/;
const SONG_SCOPES = Object.freeze([
  'syncshow:songs:read',
  'syncshow:songs:write'
]);
const SONG_PUBLIC_LINK_SCOPES = Object.freeze([
  'syncshow:song-public-links:read',
  'syncshow:song-public-links:write'
]);
const SERMON_SCOPES = Object.freeze([
  'syncshow:sermons:read',
  'syncshow:sermons:write'
]);
const SERMON_SOURCE_SCOPES = Object.freeze([
  'syncshow:sermon-sources:read',
  'syncshow:sermon-sources:write'
]);
const SERMON_PUBLICATION_SCOPES = Object.freeze([
  'syncshow:sermon-publications:read'
]);
const SERMON_MEDIA_SCOPES = Object.freeze([
  'syncshow:sermon-media:read',
  'syncshow:sermon-media:write'
]);
const SERVICE_PLAN_SCOPES = Object.freeze([
  'syncshow:service-plans:read'
]);
const SERVICE_DOCUMENT_SCOPES = Object.freeze([
  'syncshow:service-documents:read',
  'syncshow:service-documents:write'
]);
const KNOWN_SCOPES = new Set([
  ...SONG_SCOPES,
  ...SONG_PUBLIC_LINK_SCOPES,
  ...SERMON_SCOPES,
  ...SERMON_SOURCE_SCOPES,
  ...SERMON_PUBLICATION_SCOPES,
  ...SERMON_MEDIA_SCOPES,
  ...SERVICE_PLAN_SCOPES,
  ...SERVICE_DOCUMENT_SCOPES
]);
const VISIBILITIES = new Set(['private', 'public', 'scheduled-public']);
const SONG_RIGHTS_STATUSES = new Set([
  'needs-review',
  'metadata-only',
  'public-domain',
  'licensed',
  'permission-granted',
  'community-translation',
  'mixed'
]);
const SONG_PUBLIC_LINK_ID_PATTERN = /^[A-Za-z0-9_-]{32,128}$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/;
const CANONICAL_TIMESTAMP_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

class CommunityClientError extends Error {
  constructor(code, message, {
    status = null,
    retryable = false,
    cause = null
  } = {}) {
    super(message);
    this.name = 'CommunityClientError';
    this.code = code;
    this.status = status;
    this.retryable = retryable;
    this.cause = cause;
  }
}

function fail(code, message, options = {}) {
  throw new CommunityClientError(code, message, options);
}

function sermonWire(operation) {
  try {
    return operation();
  } catch (error) {
    if (error instanceof CommunitySermonWireError) {
      fail(error.code, error.message, {
        retryable: false,
        cause: error.code
      });
    }
    throw error;
  }
}

function sermonPublicationWire(operation) {
  try {
    return operation();
  } catch (error) {
    if (error instanceof CommunitySermonPublicationWireError) {
      fail(error.code, error.message, {
        retryable: false,
        cause: error.code
      });
    }
    throw error;
  }
}

function servicePlanWire(operation) {
  try {
    return operation();
  } catch (error) {
    if (error instanceof CommunityServicePlanError) {
      fail(error.code, error.message, {
        retryable: false,
        cause: error.code
      });
    }
    throw error;
  }
}

function serviceDocumentWire(operation) {
  try {
    return operation();
  } catch (error) {
    if (error instanceof HeritageServiceDocumentError) {
      fail(error.code, error.message, {
        retryable: false,
        cause: error.code
      });
    }
    throw error;
  }
}

function songMemberSharingWire(operation, {
  response = false
} = {}) {
  try {
    return operation();
  } catch (error) {
    if (error instanceof CommunitySongMemberSharingError) {
      fail(response ? 'INVALID_RESPONSE' : error.code, error.message, {
        retryable: false,
        cause: error.code
      });
    }
    throw error;
  }
}

function normalizeSermonResponse(value) {
  if (!value
    || typeof value !== 'object'
    || Array.isArray(value)
    || Object.keys(value).length !== 1
    || !Object.prototype.hasOwnProperty.call(value, 'sermon')) {
    fail('INVALID_RESPONSE', 'Community returned an invalid sermon response.');
  }
  return sermonWire(() => normalizeRemoteSermonEnvelope(value.sermon));
}

function normalizeSermonPublicationResponse(value) {
  if (!value
    || typeof value !== 'object'
    || Array.isArray(value)
    || Object.keys(value).length !== 1
    || !Object.prototype.hasOwnProperty.call(value, 'publication')) {
    fail(
      'INVALID_RESPONSE',
      'Community returned an invalid sermon publication response.'
    );
  }
  return sermonPublicationWire(() =>
    normalizeSermonPublicationState(value.publication));
}

function normalizeServicePlanResponse(value) {
  if (!value
    || typeof value !== 'object'
    || Array.isArray(value)
    || Object.keys(value).length !== 1
    || !Object.prototype.hasOwnProperty.call(value, 'plan')) {
    fail(
      'INVALID_RESPONSE',
      'Community returned an invalid service-plan response.'
    );
  }
  return servicePlanWire(() => normalizeCommunityServicePlanEnvelope(value.plan));
}

function normalizeServiceDocumentResponse(value) {
  if (!value
    || typeof value !== 'object'
    || Array.isArray(value)
    || Object.keys(value).length !== 1
    || !Object.prototype.hasOwnProperty.call(value, 'serviceDocument')) {
    fail(
      'INVALID_RESPONSE',
      'Community returned an invalid service-document response.'
    );
  }
  return serviceDocumentWire(() =>
    normalizeHeritageServiceDocumentEnvelope(value.serviceDocument));
}

function normalizeServiceDocumentMutation({
  syncId,
  documentSource,
  status = 'planning'
} = {}) {
  const id = boundedText(syncId, 'Community service-document sync ID', 128, {
    required: true,
    pattern: SYNC_ID_PATTERN
  });
  if (!HERITAGE_SERVICE_DOCUMENT_STATUSES.includes(status)) {
    fail('INVALID_INPUT', 'Community service-document status is invalid.');
  }
  const validated = serviceDocumentWire(() =>
    validateHeritageServiceDocumentSource(documentSource));
  if (validated.document.id !== id) {
    fail(
      'DOCUMENT_SYNC_ID_MISMATCH',
      'Service-document content does not match its sync identity.'
    );
  }
  return Object.freeze({
    syncId: id,
    documentSource: validated.documentSource,
    status,
    revision: validated.revision
  });
}

function normalizeServiceDocumentCursor(cursor) {
  if (cursor === null || cursor === undefined) return null;
  if (typeof cursor !== 'string'
    || cursor.length < 1
    || Buffer.byteLength(cursor, 'utf8')
      > MAX_HERITAGE_SERVICE_DOCUMENT_CURSOR_BYTES
    || /[\u0000-\u001f\u007f]/.test(cursor)) {
    fail('INVALID_INPUT', 'Community service-document cursor is invalid.');
  }
  return cursor;
}

function boundedText(value, label, maximum, {
  required = false,
  pattern = null,
  fallback = null
} = {}) {
  if (value === undefined || value === null || value === '') {
    if (required) fail('INVALID_INPUT', `${label} is required.`);
    return fallback;
  }
  if (typeof value !== 'string') fail('INVALID_INPUT', `${label} must be text.`);
  const normalized = value.trim();
  if (!normalized
    || normalized.length > maximum
    || /[\u0000-\u001f\u007f]/.test(normalized)
    || (pattern && !pattern.test(normalized))) {
    fail('INVALID_INPUT', `${label} is invalid.`);
  }
  return normalized;
}

function isLoopbackHostname(hostname) {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  return normalized === 'localhost'
    || normalized === '::1'
    || /^127(?:\.\d{1,3}){3}$/.test(normalized);
}

function normalizeBaseUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch (_error) {
    throw new TypeError('Community server URL is invalid');
  }
  const secure = url.protocol === 'https:';
  const loopbackDevelopment = url.protocol === 'http:' && isLoopbackHostname(url.hostname);
  if ((!secure && !loopbackDevelopment)
    || url.username
    || url.password
    || url.search
    || url.hash
    || url.pathname !== '/') {
    throw new TypeError('Community server URL must be an HTTPS origin or loopback development origin');
  }
  url.pathname = '/';
  return url;
}

function normalizeScopeArray(value, {
  fallback = null,
  allowedScopes = KNOWN_SCOPES,
  allowEmpty = false,
  code = 'INVALID_SCOPE',
  label = 'Community access scopes'
} = {}) {
  const scopes = value === undefined ? fallback : value;
  if (!Array.isArray(scopes)
    || (!allowEmpty && scopes.length < 1)
    || scopes.length > allowedScopes.size) {
    fail(code, `${label} are invalid.`);
  }
  const result = [...new Set(scopes)];
  if (result.some(scope => typeof scope !== 'string' || !allowedScopes.has(scope))) {
    fail(code, `${label} are invalid.`);
  }
  return result.sort();
}

function validateScopeDependencies(result, {
  code = 'INVALID_SCOPE',
  label = 'Community access scopes'
} = {}) {
  if (result.includes('syncshow:songs:write') && !result.includes('syncshow:songs:read')) {
    fail(code, 'Song write access also requires song read access.');
  }
  if (result.includes('syncshow:sermons:write')
    && !result.includes('syncshow:sermons:read')) {
    fail(code, 'Sermon write access also requires sermon read access.');
  }
  if (result.includes('syncshow:sermon-sources:read')
    && !result.includes('syncshow:sermons:read')) {
    fail(code, 'Sermon source access also requires sermon read access.');
  }
  if (result.includes('syncshow:sermon-sources:write')
    && (!result.includes('syncshow:sermon-sources:read')
      || !result.includes('syncshow:sermons:write'))) {
    fail(code, 'Sermon source write access requires source read and sermon write access.');
  }
  if (result.includes('syncshow:sermon-publications:read')
    && !result.includes('syncshow:sermons:read')) {
    fail(code, 'Sermon publication read access also requires sermon read access.');
  }
  if (result.includes('syncshow:sermon-media:read')
    && !result.includes('syncshow:sermons:read')) {
    fail(code, 'Sermon media read access also requires sermon read access.');
  }
  if (result.includes('syncshow:sermon-media:write')
    && (!result.includes('syncshow:sermon-media:read')
      || !result.includes('syncshow:sermons:read'))) {
    fail(
      code,
      'Sermon media write access requires media read and sermon read access.'
    );
  }
  if (result.includes('syncshow:song-public-links:read')
    && !result.includes('syncshow:songs:read')) {
    fail(code, 'Song public-link read access also requires song read access.');
  }
  if (result.includes('syncshow:song-public-links:write')
    && (!result.includes('syncshow:song-public-links:read')
      || !result.includes('syncshow:songs:read'))) {
    fail(
      code,
      'Song public-link write access requires public-link read and song read access.'
    );
  }
  if (result.includes('syncshow:service-documents:write')
    && !result.includes('syncshow:service-documents:read')) {
    fail(code, 'Service-document write access also requires read access.');
  }
  if (result.length < 1) fail(code, `${label} are invalid.`);
  return result.sort();
}

function normalizeScopes(value, options = {}) {
  return validateScopeDependencies(normalizeScopeArray(value, {
    ...options
  }), options);
}

function normalizeResourceEndpoint(value, {
  origin,
  apiPath,
  label
}) {
  if (typeof value !== 'string') {
    fail('INVALID_DISCOVERY', `${label} is invalid.`);
  }
  const endpoint = value.trim();
  if (!endpoint
    || endpoint.length > 2048
    || /[\u0000-\u001f\u007f]/.test(endpoint)) {
    fail('INVALID_DISCOVERY', `${label} is invalid.`);
  }
  return pinnedUrl(endpoint, {
    origin,
    apiPath,
    label,
    fallback: endpoint
  });
}

function normalizeSongResource(value, {
  origin,
  apiPath
}) {
  if (value === undefined) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail('INVALID_DISCOVERY', 'Community song resource details are invalid.');
  }
  if (value.schemaVersion !== 1) {
    fail('SYNC_UNSUPPORTED', 'This Community server uses an unsupported song protocol.');
  }
  const scopes = normalizeScopeArray(value.scopes, {
    allowedScopes: new Set(SONG_SCOPES),
    code: 'INVALID_DISCOVERY',
    label: 'Community song scopes'
  });
  validateScopeDependencies(scopes, {
    code: 'INVALID_DISCOVERY',
    label: 'Community song scopes'
  });
  let memberSharing;
  if (Object.prototype.hasOwnProperty.call(value, 'memberSharing')) {
    const descriptor = value.memberSharing;
    const keys = ['schemaVersion', 'endpoint', 'reviewScope'];
    if (!descriptor
      || typeof descriptor !== 'object'
      || Array.isArray(descriptor)
      || Object.keys(descriptor).length !== keys.length
      || keys.some(key =>
        !Object.prototype.hasOwnProperty.call(descriptor, key))) {
      fail(
        'INVALID_DISCOVERY',
        'Community song member-sharing details are invalid.'
      );
    }
    if (descriptor.schemaVersion !== 1
      || descriptor.reviewScope !== 'community-members') {
      fail(
        'SYNC_UNSUPPORTED',
        'This Community server uses an unsupported song member-sharing protocol.'
      );
    }
    memberSharing = Object.freeze({
      schemaVersion: 1,
      endpoint: normalizeResourceEndpoint(descriptor.endpoint, {
        origin,
        apiPath,
        label: 'Song member-sharing endpoint'
      }),
      reviewScope: 'community-members'
    });
  }
  return Object.freeze({
    schemaVersion: 1,
    endpoint: normalizeResourceEndpoint(value.endpoint, {
      origin,
      apiPath,
      label: 'Song resource endpoint'
    }),
    scopes: Object.freeze(scopes),
    ...(memberSharing ? { memberSharing } : {})
  });
}

function normalizePublicBaseUrl(value, {
  origin,
  label = 'Song public-link base URL'
} = {}) {
  if (typeof value !== 'string') {
    fail('INVALID_DISCOVERY', `${label} is invalid.`);
  }
  const raw = value.trim();
  if (!raw
    || raw.length > 2048
    || /[\u0000-\u001f\u007f]/.test(raw)
    || raw.includes('?')
    || raw.includes('#')) {
    fail('INVALID_DISCOVERY', `${label} is invalid.`);
  }
  let url;
  try {
    url = new URL(raw, `${origin}/`);
  } catch (_error) {
    fail('INVALID_DISCOVERY', `${label} is invalid.`);
  }
  if (url.origin !== origin
    || url.username
    || url.password
    || url.search
    || url.hash
    || url.pathname === '/') {
    fail('INVALID_DISCOVERY', `${label} must stay on the Community server.`);
  }
  url.pathname = `${url.pathname.replace(/\/+$/, '')}/`;
  return url.toString();
}

function normalizeSongPublicLinkResource(value, {
  origin,
  apiPath
}) {
  if (value === undefined) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail('INVALID_DISCOVERY', 'Community song public-link resource details are invalid.');
  }
  if (value.schemaVersion !== 1) {
    fail('SYNC_UNSUPPORTED', 'This Community server uses an unsupported song public-link protocol.');
  }
  const scopes = normalizeScopeArray(value.scopes, {
    allowedScopes: new Set(SONG_PUBLIC_LINK_SCOPES),
    code: 'INVALID_DISCOVERY',
    label: 'Community song public-link scopes'
  });
  if (scopes.includes('syncshow:song-public-links:write')
    && !scopes.includes('syncshow:song-public-links:read')) {
    fail(
      'INVALID_DISCOVERY',
      'Song public-link write access also requires public-link read access.'
    );
  }
  return Object.freeze({
    schemaVersion: 1,
    endpoint: normalizeResourceEndpoint(value.endpoint, {
      origin,
      apiPath,
      label: 'Song public-link resource endpoint'
    }),
    publicBaseUrl: normalizePublicBaseUrl(value.publicBaseUrl, {
      origin
    }),
    scopes: Object.freeze(scopes)
  });
}

function normalizeSermonResource(value, {
  origin,
  apiPath
}) {
  if (value === undefined) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail('INVALID_DISCOVERY', 'Community sermon resource details are invalid.');
  }
  if (value.schemaVersion !== 1) {
    fail('SYNC_UNSUPPORTED', 'This Community server uses an unsupported sermon protocol.');
  }
  const scopes = normalizeScopeArray(value.scopes, {
    allowedScopes: new Set(SERMON_SCOPES),
    code: 'INVALID_DISCOVERY',
    label: 'Community sermon scopes'
  });
  const sourceObjectScopes = normalizeScopeArray(value.sourceObjectScopes, {
    fallback: [],
    allowedScopes: new Set(SERMON_SOURCE_SCOPES),
    allowEmpty: true,
    code: 'INVALID_DISCOVERY',
    label: 'Community sermon source scopes'
  });
  validateScopeDependencies([...scopes, ...sourceObjectScopes], {
    code: 'INVALID_DISCOVERY',
    label: 'Community sermon scopes'
  });
  return Object.freeze({
    schemaVersion: 1,
    endpoint: normalizeResourceEndpoint(value.endpoint, {
      origin,
      apiPath,
      label: 'Sermon resource endpoint'
    }),
    scopes: Object.freeze(scopes),
    sourceObjectScopes: Object.freeze(sourceObjectScopes)
  });
}

function normalizeSermonPublicationResource(value, {
  origin,
  apiPath
}) {
  if (value === undefined) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail(
      'INVALID_DISCOVERY',
      'Community sermon publication resource details are invalid.'
    );
  }
  if (value.schemaVersion !== 1) {
    fail(
      'SYNC_UNSUPPORTED',
      'This Community server uses an unsupported sermon publication protocol.'
    );
  }
  const scopes = normalizeScopeArray(value.scopes, {
    allowedScopes: new Set(SERMON_PUBLICATION_SCOPES),
    code: 'INVALID_DISCOVERY',
    label: 'Community sermon publication scopes'
  });
  return Object.freeze({
    schemaVersion: 1,
    endpoint: normalizeResourceEndpoint(value.endpoint, {
      origin,
      apiPath,
      label: 'Sermon publication resource endpoint'
    }),
    scopes: Object.freeze(scopes)
  });
}

function normalizeSermonMediaResource(value, {
  origin,
  apiPath
}) {
  if (value === undefined) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail(
      'INVALID_DISCOVERY',
      'Community sermon-media resource details are invalid.'
    );
  }
  const expectedKeys = [
    'acceptedMediaTypes',
    'chunkSizeBytes',
    'endpoint',
    'maximumBytes',
    'schemaVersion',
    'scopes',
    'sessionTtlSeconds'
  ].sort();
  const actualKeys = Object.keys(value).sort();
  if (actualKeys.length !== expectedKeys.length
    || actualKeys.some((key, index) => key !== expectedKeys[index])) {
    fail(
      'INVALID_DISCOVERY',
      'Community sermon-media resource details contain unsupported fields.'
    );
  }
  if (value.schemaVersion !== 1) {
    fail(
      'SYNC_UNSUPPORTED',
      'This Community server uses an unsupported sermon-media protocol.'
    );
  }
  if (value.endpoint !== 'sermon-media') {
    fail(
      'INVALID_DISCOVERY',
      'Community sermon-media endpoint is invalid.'
    );
  }
  const scopes = normalizeScopeArray(value.scopes, {
    allowedScopes: new Set(SERMON_MEDIA_SCOPES),
    code: 'INVALID_DISCOVERY',
    label: 'Community sermon-media scopes'
  });
  if (JSON.stringify(scopes) !== JSON.stringify([...SERMON_MEDIA_SCOPES].sort())) {
    fail(
      'INVALID_DISCOVERY',
      'Community sermon-media scopes are incomplete.'
    );
  }
  const acceptedMediaTypes = Array.isArray(value.acceptedMediaTypes)
    ? [...new Set(value.acceptedMediaTypes)].sort()
    : [];
  if (value.acceptedMediaTypes?.length !== 2
    || JSON.stringify(acceptedMediaTypes)
    !== JSON.stringify(['audio/mp4', 'audio/mpeg'])) {
    fail(
      'INVALID_DISCOVERY',
      'Community sermon-media types are unsupported.'
    );
  }
  if (value.chunkSizeBytes !== 8_388_608
    || value.maximumBytes !== 1_073_741_824
    || value.sessionTtlSeconds !== 604_800) {
    fail(
      'SYNC_UNSUPPORTED',
      'This Community server uses unsupported sermon-media transfer limits.'
    );
  }
  return Object.freeze({
    schemaVersion: 1,
    endpoint: normalizeResourceEndpoint(value.endpoint, {
      origin,
      apiPath,
      label: 'Sermon-media resource endpoint'
    }),
    scopes: Object.freeze(scopes),
    chunkSizeBytes: 8_388_608,
    maximumBytes: 1_073_741_824,
    acceptedMediaTypes: Object.freeze(acceptedMediaTypes),
    sessionTtlSeconds: 604_800
  });
}

function normalizeServicePlanResource(value, {
  origin,
  apiPath
}) {
  if (value === undefined) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail(
      'INVALID_DISCOVERY',
      'Community service-plan resource details are invalid.'
    );
  }
  const expectedKeys = ['schemaVersion', 'endpoint', 'scopes'].sort();
  const actualKeys = Object.keys(value).sort();
  if (actualKeys.length !== expectedKeys.length
    || actualKeys.some((key, index) => key !== expectedKeys[index])) {
    fail(
      'INVALID_DISCOVERY',
      'Community service-plan resource details contain unsupported fields.'
    );
  }
  if (value.schemaVersion !== 1 && value.schemaVersion !== 2) {
    fail(
      'SYNC_UNSUPPORTED',
      'This Community server uses an unsupported service-plan protocol.'
    );
  }
  const scopes = normalizeScopeArray(value.scopes, {
    allowedScopes: new Set(SERVICE_PLAN_SCOPES),
    code: 'INVALID_DISCOVERY',
    label: 'Community service-plan scopes'
  });
  return Object.freeze({
    schemaVersion: value.schemaVersion,
    endpoint: normalizeResourceEndpoint(value.endpoint, {
      origin,
      apiPath,
      label: 'Service-plan resource endpoint'
    }),
    scopes: Object.freeze(scopes)
  });
}

function normalizeServiceDocumentResource(value, {
  origin,
  apiPath
}) {
  if (value === undefined) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail(
      'INVALID_DISCOVERY',
      'Community service-document resource details are invalid.'
    );
  }
  const expectedKeys = [
    'schemaVersion',
    'endpoint',
    'changesEndpoint',
    'scopes'
  ].sort();
  const actualKeys = Object.keys(value).sort();
  if (actualKeys.length !== expectedKeys.length
    || actualKeys.some((key, index) => key !== expectedKeys[index])) {
    fail(
      'INVALID_DISCOVERY',
      'Community service-document resource details contain unsupported fields.'
    );
  }
  if (value.schemaVersion !== 1) {
    fail(
      'SYNC_UNSUPPORTED',
      'This Community server uses an unsupported service-document protocol.'
    );
  }
  const scopes = normalizeScopeArray(value.scopes, {
    allowedScopes: new Set(SERVICE_DOCUMENT_SCOPES),
    code: 'INVALID_DISCOVERY',
    label: 'Community service-document scopes'
  });
  validateScopeDependencies(scopes, {
    code: 'INVALID_DISCOVERY',
    label: 'Community service-document scopes'
  });
  return Object.freeze({
    schemaVersion: 1,
    endpoint: normalizeResourceEndpoint(value.endpoint, {
      origin,
      apiPath,
      label: 'Service-document resource endpoint'
    }),
    changesEndpoint: normalizeResourceEndpoint(value.changesEndpoint, {
      origin,
      apiPath,
      label: 'Service-document change-feed endpoint'
    }),
    scopes: Object.freeze(scopes)
  });
}

function normalizeTimestamp(value, label, { required = false } = {}) {
  if (value === undefined || value === null || value === '') {
    if (required) fail('INVALID_RESPONSE', `${label} is missing.`);
    return null;
  }
  if (typeof value !== 'string' || value.length > 40 || Number.isNaN(Date.parse(value))) {
    fail('INVALID_RESPONSE', `${label} is invalid.`);
  }
  return new Date(value).toISOString();
}

function normalizeCanonicalTimestamp(value, label, {
  required = false,
  response = false
} = {}) {
  const code = response ? 'INVALID_RESPONSE' : 'INVALID_INPUT';
  if (value === undefined || value === null || value === '') {
    if (required) fail(code, `${label} is missing.`);
    return null;
  }
  if (typeof value !== 'string'
    || value.length > 40
    || !CANONICAL_TIMESTAMP_PATTERN.test(value)
    || Number.isNaN(Date.parse(value))
    || new Date(value).toISOString() !== value) {
    fail(code, `${label} is invalid.`);
  }
  return value;
}

function normalizeSha256(value, label, {
  response = false
} = {}) {
  const code = response ? 'INVALID_RESPONSE' : 'INVALID_INPUT';
  if (typeof value !== 'string' || !SHA256_PATTERN.test(value)) {
    fail(code, `${label} is invalid.`);
  }
  return value;
}

function normalizeServiceDocumentAsset(value, { bytes = null } = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail('INVALID_INPUT', 'Service media metadata is invalid.');
  }
  const sha256 = normalizeSha256(value.sha256, 'Service media digest');
  const isImage = value.kind === 'image';
  const isVideo = value.kind === 'video';
  const maximumBytes = isVideo
    ? MAX_HERITAGE_SERVICE_VIDEO_BYTES
    : MAX_HERITAGE_SERVICE_ASSET_BYTES;
  if (value.id !== `sha256:${sha256}`
    || (!isImage && !isVideo)
    || !(isVideo
      ? ['video/mp4', 'video/webm']
      : ['image/png', 'image/jpeg', 'image/webp']).includes(value.mediaType)
    || !Number.isSafeInteger(value.size)
    || value.size < 1
    || value.size > maximumBytes
    || (isImage && (!Number.isSafeInteger(value.width)
      || value.width < 1
      || value.width > 32768
      || !Number.isSafeInteger(value.height)
      || value.height < 1
      || value.height > 32768
      || !Number.isSafeInteger(value.orientation)
      || value.orientation < 1
      || value.orientation > 8))) {
    fail('INVALID_INPUT', 'Service media metadata is invalid.');
  }
  if (bytes !== null) {
    if (!Buffer.isBuffer(bytes)
      || bytes.length !== value.size
      || crypto.createHash('sha256').update(bytes).digest('hex') !== sha256) {
      fail('INVALID_INPUT', 'Service media bytes do not match their content identity.');
    }
  }
  return Object.freeze({
    id: value.id,
    kind: value.kind,
    sha256,
    mediaType: value.mediaType,
    size: value.size,
    ...(isImage
      ? {
          width: value.width,
          height: value.height,
          orientation: value.orientation
        }
      : {})
  });
}

function normalizeSongPublicLinkId(value, {
  response = false
} = {}) {
  const code = response ? 'INVALID_RESPONSE' : 'INVALID_INPUT';
  if (typeof value !== 'string' || !SONG_PUBLIC_LINK_ID_PATTERN.test(value)) {
    fail(code, 'Song public-link ID is invalid.');
  }
  const decoded = Buffer.from(value, 'base64url');
  if (decoded.length < 24 || decoded.toString('base64url') !== value) {
    fail(code, 'Song public-link ID is invalid.');
  }
  return value;
}

function normalizeSongPublicLinkLabel(value, {
  response = false
} = {}) {
  const code = response ? 'INVALID_RESPONSE' : 'INVALID_INPUT';
  if (value === undefined || value === null || value === '') {
    if (response && value !== null) {
      fail(code, 'Song public-link label is invalid.');
    }
    return null;
  }
  if (typeof value !== 'string') fail(code, 'Song public-link label is invalid.');
  const label = value.trim();
  if (!label
    || label.length > 120
    || /[\u0000-\u001f\u007f]/.test(label)
    || (response && label !== value)) {
    fail(code, 'Song public-link label is invalid.');
  }
  return label;
}

function normalizeSongPublicLinkReview(value, {
  familyRevision,
  reviewRevision
} = {}) {
  let review;
  try {
    review = normalizeSongPublicLinkReviewRecord(value, { required: true });
  } catch (error) {
    if (error instanceof CommunitySongPublicLinkReviewError) {
      fail('INVALID_INPUT', error.message);
    }
    throw error;
  }
  if (review.familyRevision !== familyRevision) {
    fail('INVALID_INPUT', 'Song public-link review does not cover this exact song family.');
  }
  if (songPublicLinkReviewRevision(review) !== reviewRevision) {
    fail('INVALID_INPUT', 'Song public-link review revision is invalid.');
  }
  return review;
}

function normalizeSongPublicLinkCursor(value, {
  response = false
} = {}) {
  if (value === undefined || value === null) return null;
  const code = response ? 'INVALID_RESPONSE' : 'INVALID_INPUT';
  if (typeof value !== 'string'
    || value.length < 1
    || Buffer.byteLength(value, 'utf8') > 2048
    || /[\u0000-\u001f\u007f]/.test(value)) {
    fail(code, 'Song public-link cursor is invalid.');
  }
  return value;
}

function normalizeIdempotencyKey(value) {
  if (typeof value !== 'string' || !IDEMPOTENCY_KEY_PATTERN.test(value)) {
    fail('INVALID_INPUT', 'Idempotency key is invalid.');
  }
  return value;
}

function normalizeSongPublicLinkItem(value, {
  resource,
  now
} = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail('INVALID_RESPONSE', 'Community returned an invalid song public-link record.');
  }
  const keys = [
    'schemaVersion',
    'linkId',
    'linkVersion',
    'songSyncId',
    'songSyncVersion',
    'familyRevision',
    'reviewRevision',
    'label',
    'createdAt',
    'expiresAt',
    'revokedAt'
  ];
  if (Object.keys(value).length !== keys.length
    || keys.some(key => !Object.prototype.hasOwnProperty.call(value, key))) {
    fail('INVALID_RESPONSE', 'Community returned an invalid song public-link record.');
  }
  if (value.schemaVersion !== 1) {
    fail('INVALID_RESPONSE', 'Community returned an unsupported song public-link record.');
  }
  const linkId = normalizeSongPublicLinkId(value.linkId, { response: true });
  if (!Number.isSafeInteger(value.linkVersion) || value.linkVersion < 1) {
    fail('INVALID_RESPONSE', 'Community song public-link version is invalid.');
  }
  let songSyncId;
  try {
    songSyncId = boundedText(value.songSyncId, 'Song sync ID', 128, {
      required: true,
      pattern: SYNC_ID_PATTERN
    });
  } catch (error) {
    if (error instanceof CommunityClientError) {
      fail('INVALID_RESPONSE', 'Community song public-link identity is invalid.');
    }
    throw error;
  }
  if (songSyncId !== value.songSyncId) {
    fail('INVALID_RESPONSE', 'Community song public-link identity is invalid.');
  }
  if (!Number.isSafeInteger(value.songSyncVersion) || value.songSyncVersion < 1) {
    fail('INVALID_RESPONSE', 'Community song public-link song version is invalid.');
  }
  const createdAt = normalizeCanonicalTimestamp(
    value.createdAt,
    'Song public-link creation time',
    { required: true, response: true }
  );
  const expiresAt = normalizeCanonicalTimestamp(
    value.expiresAt,
    'Song public-link expiration time',
    { response: true }
  );
  const revokedAt = normalizeCanonicalTimestamp(
    value.revokedAt,
    'Song public-link revocation time',
    { response: true }
  );
  if (expiresAt && Date.parse(expiresAt) <= Date.parse(createdAt)) {
    fail('INVALID_RESPONSE', 'Community song public-link expiration is invalid.');
  }
  if (revokedAt && Date.parse(revokedAt) < Date.parse(createdAt)) {
    fail('INVALID_RESPONSE', 'Community song public-link revocation is invalid.');
  }
  const current = now instanceof Date ? now : new Date(now);
  if (Number.isNaN(current.getTime())) {
    throw new TypeError('Community client clock is invalid');
  }
  const status = revokedAt
    ? 'revoked'
    : expiresAt && Date.parse(expiresAt) <= current.getTime()
      ? 'expired'
      : 'active';
  return Object.freeze({
    schemaVersion: 1,
    linkId,
    linkVersion: value.linkVersion,
    songSyncId,
    songSyncVersion: value.songSyncVersion,
    familyRevision: normalizeSha256(
      value.familyRevision,
      'Song public-link family revision',
      { response: true }
    ),
    reviewRevision: normalizeSha256(
      value.reviewRevision,
      'Song public-link review revision',
      { response: true }
    ),
    label: normalizeSongPublicLinkLabel(value.label, { response: true }),
    createdAt,
    expiresAt,
    revokedAt,
    status,
    shareUrl: status === 'active'
      ? new URL(encodeURIComponent(linkId), resource.publicBaseUrl).toString()
      : null
  });
}

function normalizeSongPublicLinkResponse(value, options) {
  if (!value
    || typeof value !== 'object'
    || Array.isArray(value)
    || Object.keys(value).length !== 1
    || !Object.prototype.hasOwnProperty.call(value, 'link')) {
    fail('INVALID_RESPONSE', 'Community returned an invalid song public-link response.');
  }
  return normalizeSongPublicLinkItem(value.link, options);
}

function normalizeVisibility(value, publishAt = null, {
  defaultVisibility = 'private',
  response = false
} = {}) {
  const normalized = value || defaultVisibility;
  const code = response ? 'INVALID_RESPONSE' : 'INVALID_INPUT';
  if (!VISIBILITIES.has(normalized)) fail(code, 'Song visibility is invalid.');
  let scheduledAt = null;
  if (publishAt !== undefined && publishAt !== null && publishAt !== '') {
    if (typeof publishAt !== 'string' || publishAt.length > 40 || Number.isNaN(Date.parse(publishAt))) {
      fail(code, 'Scheduled publication time is invalid.');
    }
    scheduledAt = new Date(publishAt).toISOString();
  }
  if (normalized === 'scheduled-public' && !scheduledAt) {
    fail(code, 'Scheduled-public songs require a publication time.');
  }
  if (normalized !== 'scheduled-public' && scheduledAt) {
    fail(code, 'Only scheduled-public songs may have a publication time.');
  }
  return { visibility: normalized, publishAt: scheduledAt };
}

function normalizePrivateSongWriteVisibility(value, publishAt = null) {
  const normalizedVisibility = value || 'private';
  const hasPublishAt = publishAt !== undefined
    && publishAt !== null
    && publishAt !== '';
  if (normalizedVisibility !== 'private' || hasPublishAt) {
    fail(
      'SONG_MEMBER_SHARING_TRANSACTION_REQUIRED',
      'Public or scheduled member access must use the reviewed Heritage Community member-sharing transaction.'
    );
  }
  return normalizeVisibility(normalizedVisibility, null);
}

function normalizeReviewedSongRights(rightsStatus, rightsNotes) {
  if (rightsStatus === undefined && rightsNotes === undefined) return {};
  if (!SONG_RIGHTS_STATUSES.has(rightsStatus)) {
    fail('INVALID_INPUT', 'Reviewed song rights status is invalid.');
  }
  return {
    rightsStatus,
    rightsNotes: boundedText(
      rightsNotes,
      'Reviewed song rights evidence',
      10000,
      { required: true }
    )
  };
}

function normalizeSyncVersion(value, { required = true } = {}) {
  if ((value === undefined || value === null) && !required) return null;
  if (!Number.isSafeInteger(value) || value < 1) {
    fail('INVALID_RESPONSE', 'Community song sync version is invalid.');
  }
  return value;
}

function normalizeRevision(value, label = 'Song revision', { required = true } = {}) {
  return boundedText(value, label, 256, {
    required,
    pattern: /^[A-Za-z0-9][A-Za-z0-9._:"/-]{0,255}$/
  });
}

function normalizeSyncDocuments(value, {
  allowMissing = false,
  response = false
} = {}) {
  if ((value === undefined || value === null) && allowMissing) return null;
  const code = response ? 'INVALID_RESPONSE' : 'INVALID_INPUT';
  if (!Array.isArray(value) || value.length > MAX_DOCUMENTS) {
    fail(code, `A synced song family may contain at most ${MAX_DOCUMENTS} documents.`);
  }
  const seen = new Set();
  let totalBytes = 0;
  return value.map(document => {
    if (!document || typeof document !== 'object' || Array.isArray(document)) {
      fail(code, 'A synced song document is invalid.');
    }
    let id;
    try {
      id = boundedText(document.id, 'Song document ID', 128, {
        required: true,
        pattern: SYNC_ID_PATTERN
      });
    } catch (error) {
      if (response && error instanceof CommunityClientError) {
        fail('INVALID_RESPONSE', 'Community returned an invalid song document.');
      }
      throw error;
    }
    if (seen.has(id)) fail(code, 'A synced song family repeats a document ID.');
    seen.add(id);
    if (typeof document.source !== 'string') fail(code, 'Song document source must be text.');
    const sourceBytes = Buffer.byteLength(document.source, 'utf8');
    totalBytes += sourceBytes;
    if (sourceBytes > MAX_DOCUMENT_BYTES || totalBytes > MAX_DOCUMENT_TOTAL_BYTES) {
      fail(code, 'Synced song documents exceed the safe transfer limit.');
    }
    const revision = normalizeRevision(document.revision, 'Song document revision');
    if (revision !== crypto.createHash('sha256').update(document.source).digest('hex')) {
      fail(
        response ? 'INVALID_RESPONSE' : 'INVALID_INPUT',
        'Community song document checksum does not match its source.'
      );
    }
    return Object.freeze({
      id,
      source: document.source,
      revision
    });
  });
}

function normalizeRemoteSong(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail('INVALID_RESPONSE', 'Community returned an invalid song record.');
  }
  const syncId = boundedText(value.syncId || value.id, 'Song sync ID', 128, {
    required: true,
    pattern: SYNC_ID_PATTERN
  });
  const normalizedSyncVersion = normalizeSyncVersion(value.syncVersion);
  const syncDocuments = normalizeSyncDocuments(value.syncDocuments, {
    allowMissing: true,
    response: true
  });
  const normalizedVisibility = normalizeVisibility(value.visibility, value.publishAt, {
    response: true
  });
  const advertisedAlternateTitles = Array.isArray(value.alternateTitles)
    ? value.alternateTitles.slice(0, 32).map(title =>
      boundedText(title, 'Alternate title', 240, { required: true }))
    : [];
  const alternateTitles = [...new Set([
    ...advertisedAlternateTitles,
    boundedText(value.russianTitle, 'Russian song title', 240),
    boundedText(value.englishTitle, 'English song title', 240)
  ].filter(Boolean))].slice(0, 32);
  const memberSharing = value.memberSharing === undefined
    || value.memberSharing === null
    ? null
    : songMemberSharingWire(
        () => normalizeSongMemberSharingReceipt(value.memberSharing),
        { response: true }
      );
  let effectiveVisibility = null;
  if (value.effectiveVisibility !== undefined
    && value.effectiveVisibility !== null) {
    if (!['private', 'public'].includes(value.effectiveVisibility)) {
      fail(
        'INVALID_RESPONSE',
        'Community returned an invalid effective song visibility.'
      );
    }
    effectiveVisibility = value.effectiveVisibility;
  }
  if (memberSharing
    && (
      memberSharing.songSyncId !== syncId
      || memberSharing.songSyncVersion !== normalizedSyncVersion
      || memberSharing.visibility !== normalizedVisibility.visibility
      || memberSharing.publishAt !== normalizedVisibility.publishAt
      || effectiveVisibility === null
    )) {
    fail(
      'INVALID_RESPONSE',
      'Community returned a member-sharing receipt for a different current song state.'
    );
  }
  if (effectiveVisibility === 'public' && !memberSharing) {
    fail(
      'INVALID_RESPONSE',
      'Community reported member access without the current member-sharing receipt.'
    );
  }
  return Object.freeze({
    syncId,
    syncVersion: normalizedSyncVersion,
    revision: normalizeRevision(
      value.revision || `song:${syncId}:${value.syncVersion}`,
      'Remote song revision'
    ),
    syncDocuments,
    metadataOnly: !syncDocuments || syncDocuments.length === 0,
    archived: value.archived === true || value.deleted === true || value.tombstone === true,
    ...normalizedVisibility,
    memberSharing,
    effectiveVisibility,
    title: boundedText(value.title, 'Song title', 240),
    rightsStatus: SONG_RIGHTS_STATUSES.has(value.rightsStatus)
      ? value.rightsStatus
      : 'needs-review',
    rightsNotes: boundedText(
      value.rightsNotes,
      'Reviewed song rights evidence',
      10000
    ),
    alternateTitles: Object.freeze(alternateTitles),
    updatedAt: normalizeTimestamp(value.updatedAt, 'Song update time')
  });
}

function validateLimit(value, fallback, minimum, maximum, label) {
  if (value === undefined || value === null) return fallback;
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new TypeError(`${label} must be between ${minimum} and ${maximum}`);
  }
  return value;
}

function pinnedUrl(value, {
  origin,
  apiPath,
  label,
  fallback
}) {
  let url;
  try {
    url = new URL(value || fallback, `${origin}${apiPath.replace(/\/?$/, '/')}`);
  } catch (_error) {
    fail('INVALID_DISCOVERY', `${label} is invalid.`);
  }
  const normalizedApiPath = apiPath.replace(/\/+$/, '');
  if (url.origin !== origin
    || url.username
    || url.password
    || url.search
    || url.hash
    || (url.pathname !== normalizedApiPath
      && !url.pathname.startsWith(`${normalizedApiPath}/`))) {
    fail('INVALID_DISCOVERY', `${label} escaped the Community server API.`);
  }
  return url.toString();
}

async function readResponseBuffer(response, maximumBytes) {
  const contentLength = Number(response.headers?.get?.('content-length'));
  if (Number.isFinite(contentLength) && contentLength > maximumBytes) {
    fail('RESPONSE_TOO_LARGE', 'Community server response is too large.');
  }
  if (response.body && typeof response.body.getReader === 'function') {
    const reader = response.body.getReader();
    const chunks = [];
    let length = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        length += value.byteLength;
        if (length > maximumBytes) {
          await reader.cancel().catch(() => {});
          fail('RESPONSE_TOO_LARGE', 'Community server response is too large.');
        }
        chunks.push(Buffer.from(value));
      }
    } finally {
      reader.releaseLock?.();
    }
    return Buffer.concat(chunks, length);
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length > maximumBytes) fail('RESPONSE_TOO_LARGE', 'Community server response is too large.');
  return buffer;
}

function timeoutSignal(timeoutMs, callerSignal) {
  const controller = new AbortController();
  let timedOut = false;
  let callerAbort = null;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort(new Error('request timeout'));
  }, timeoutMs);
  timer.unref?.();
  if (callerSignal) {
    if (callerSignal.aborted) controller.abort(callerSignal.reason);
    else {
      callerAbort = () => controller.abort(callerSignal.reason);
      callerSignal.addEventListener('abort', callerAbort, { once: true });
    }
  }
  return {
    signal: controller.signal,
    timedOut: () => timedOut,
    dispose() {
      clearTimeout(timer);
      if (callerAbort) callerSignal.removeEventListener('abort', callerAbort);
    }
  };
}

class CommunityClient {
  constructor({
    baseUrl,
    fetchImpl = globalThis.fetch,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    maximumJsonBytes = DEFAULT_JSON_LIMIT,
    randomBytes = crypto.randomBytes,
    randomUUID = crypto.randomUUID,
    now = () => new Date()
  } = {}) {
    if (typeof fetchImpl !== 'function') throw new TypeError('Community client requires fetch');
    if (typeof randomBytes !== 'function'
      || typeof randomUUID !== 'function'
      || typeof now !== 'function') {
      throw new TypeError('Community client dependencies are invalid');
    }
    this.baseUrl = normalizeBaseUrl(baseUrl);
    this.fetchImpl = fetchImpl;
    this.timeoutMs = validateLimit(timeoutMs, DEFAULT_TIMEOUT_MS, 1000, 120000, 'timeoutMs');
    this.maximumJsonBytes = validateLimit(
      maximumJsonBytes,
      DEFAULT_JSON_LIMIT,
      1024,
      16 * 1024 * 1024,
      'maximumJsonBytes'
    );
    this.randomBytes = randomBytes;
    this.randomUUID = randomUUID;
    this.now = now;
    this.discovery = null;
    this.authorizationFlows = new Map();
  }

  async _request(url, {
    method = 'GET',
    body = null,
    accessToken = null,
    expectedStatuses = [200],
    headers = {},
    signal = null,
    allowEmpty = false,
    maximumRequestBytes = MAX_DOCUMENT_TOTAL_BYTES + (64 * 1024),
    maximumResponseBytes = this.maximumJsonBytes
  } = {}) {
    const target = new URL(url);
    if (target.origin !== this.baseUrl.origin
      || target.username
      || target.password
      || target.hash) {
      fail('UNSAFE_ENDPOINT', 'Community request escaped the connected server.');
    }
    const requestHeaders = {
      Accept: 'application/json',
      ...headers
    };
    let serializedBody;
    if (body !== null && body !== undefined) {
      serializedBody = JSON.stringify(body);
      if (Buffer.byteLength(serializedBody, 'utf8') > maximumRequestBytes) {
        fail('REQUEST_TOO_LARGE', 'Community request is too large.');
      }
      requestHeaders['Content-Type'] = 'application/json';
    }
    if (accessToken !== null) {
      const token = boundedText(accessToken, 'Community access token', 16384, {
        required: true,
        pattern: TOKEN_PATTERN
      });
      requestHeaders.Authorization = `SyncShow ${token}`;
    }
    const timeout = timeoutSignal(this.timeoutMs, signal);
    let response;
    try {
      response = await this.fetchImpl(target.toString(), {
        method,
        headers: requestHeaders,
        body: serializedBody,
        redirect: 'manual',
        signal: timeout.signal
      });
    } catch (error) {
      timeout.dispose();
      if (timeout.signal.aborted) {
        if (timeout.timedOut()) {
          fail('REQUEST_TIMEOUT', 'Community server did not respond in time.', {
            retryable: true
          });
        }
        fail('REQUEST_CANCELLED', 'Community request was cancelled.');
      }
      fail('NETWORK_ERROR', 'SyncShow could not reach the Community server.', {
        retryable: true,
        cause: error?.code || error?.name || 'network-error'
      });
    }
    try {
      if (response.redirected
        || (response.status >= 300 && response.status < 400)
        || (response.url && new URL(response.url).origin !== target.origin)) {
        fail('UNSAFE_REDIRECT', 'Community server returned an unsafe redirect.', {
          status: response.status
        });
      }
      const buffer = await readResponseBuffer(response, maximumResponseBytes);
      let payload = null;
      let source = '';
      if (buffer.length > 0) {
        const contentType = response.headers?.get?.('content-type') || '';
        if (contentType && !/(?:application\/json|\+json)(?:;|$)/i.test(contentType)) {
          fail('INVALID_RESPONSE', 'Community server returned an unexpected response type.', {
            status: response.status
          });
        }
        source = buffer.toString('utf8');
        if (!Buffer.from(source, 'utf8').equals(buffer)) {
          fail('INVALID_RESPONSE', 'Community server returned invalid UTF-8.', {
            status: response.status
          });
        }
        try {
          payload = JSON.parse(source);
        } catch (_error) {
          fail('INVALID_RESPONSE', 'Community server returned invalid JSON.', {
            status: response.status
          });
        }
      } else if (!allowEmpty && expectedStatuses.includes(response.status)) {
        fail('INVALID_RESPONSE', 'Community server returned an empty response.', {
          status: response.status
        });
      }
      if (!expectedStatuses.includes(response.status)) {
        const statusMap = {
          400: ['BAD_REQUEST', 'Community server rejected the request.', false],
          401: ['AUTH_REQUIRED', 'Community authorization is required.', false],
          403: ['PERMISSION_DENIED', 'This Community account does not have permission.', false],
          404: ['NOT_FOUND', 'The Community resource was not found.', false],
          409: ['REVISION_CONFLICT', 'The Community record changed before this update.', false],
          410: ['AUTHORIZATION_EXPIRED', 'Community authorization expired.', false],
          412: ['REVISION_CONFLICT', 'The Community record changed before this update.', false],
          429: ['RATE_LIMITED', 'Community server is temporarily busy.', true]
        };
        const mapped = statusMap[response.status]
          || (response.status >= 500
            ? ['SERVER_UNAVAILABLE', 'Community server is temporarily unavailable.', true]
            : ['REQUEST_FAILED', 'Community server could not complete the request.', false]);
        fail(mapped[0], mapped[1], {
          status: response.status,
          retryable: mapped[2]
        });
      }
      return { payload, response, source };
    } finally {
      timeout.dispose();
    }
  }

  async _binaryRequest(url, {
    method = 'GET',
    body = null,
    accessToken = null,
    expectedStatuses = [200],
    headers = {},
    signal = null,
    maximumRequestBytes = MAX_HERITAGE_SERVICE_ASSET_BYTES,
    maximumResponseBytes = MAX_HERITAGE_SERVICE_ASSET_BYTES
  } = {}) {
    const target = new URL(url);
    if (target.origin !== this.baseUrl.origin
      || target.username
      || target.password
      || target.hash) {
      fail('UNSAFE_ENDPOINT', 'Community request escaped the connected server.');
    }
    let requestBody = null;
    if (body !== null && body !== undefined) {
      requestBody = Buffer.isBuffer(body) ? body : Buffer.from(body);
      if (requestBody.length < 1 || requestBody.length > maximumRequestBytes) {
        fail('REQUEST_TOO_LARGE', 'Community service media is too large.');
      }
    }
    const requestHeaders = {
      Accept: 'application/octet-stream, application/json',
      ...headers
    };
    if (accessToken !== null) {
      const token = boundedText(accessToken, 'Community access token', 16384, {
        required: true,
        pattern: TOKEN_PATTERN
      });
      requestHeaders.Authorization = `SyncShow ${token}`;
    }
    const timeout = timeoutSignal(this.timeoutMs, signal);
    let response;
    try {
      response = await this.fetchImpl(target.toString(), {
        method,
        headers: requestHeaders,
        body: requestBody,
        redirect: 'manual',
        signal: timeout.signal
      });
    } catch (error) {
      timeout.dispose();
      if (timeout.signal.aborted) {
        if (timeout.timedOut()) {
          fail('REQUEST_TIMEOUT', 'Community server did not respond in time.', {
            retryable: true
          });
        }
        fail('REQUEST_CANCELLED', 'Community request was cancelled.');
      }
      fail('NETWORK_ERROR', 'SyncShow could not reach the Community server.', {
        retryable: true,
        cause: error?.code || error?.name || 'network-error'
      });
    }
    try {
      if (response.redirected
        || (response.status >= 300 && response.status < 400)
        || (response.url && new URL(response.url).origin !== target.origin)) {
        fail('UNSAFE_REDIRECT', 'Community server returned an unsafe redirect.', {
          status: response.status
        });
      }
      const buffer = await readResponseBuffer(response, maximumResponseBytes);
      if (!expectedStatuses.includes(response.status)) {
        const statusMap = {
          400: ['BAD_REQUEST', false],
          401: ['AUTH_REQUIRED', false],
          403: ['PERMISSION_DENIED', false],
          404: ['NOT_FOUND', false],
          409: ['REVISION_CONFLICT', false],
          413: ['REQUEST_TOO_LARGE', false],
          422: ['INVALID_SERVICE_ASSET', false],
          429: ['RATE_LIMITED', true]
        };
        const mapped = statusMap[response.status]
          || (response.status >= 500
            ? ['SERVER_UNAVAILABLE', true]
            : ['REQUEST_FAILED', false]);
        let message = 'Community server could not transfer the service image.';
        const contentType = response.headers?.get?.('content-type') || '';
        if (buffer.length && /(?:application\/json|\+json)(?:;|$)/i.test(contentType)) {
          try {
            const payload = JSON.parse(buffer.toString('utf8'));
            if (typeof payload?.error === 'string' && payload.error) message = payload.error;
          } catch (_error) {
            // Preserve the bounded generic error for an invalid error body.
          }
        }
        fail(mapped[0], message, {
          status: response.status,
          retryable: mapped[1]
        });
      }
      return { buffer, response };
    } finally {
      timeout.dispose();
    }
  }

  async discover({ signal = null, force = false } = {}) {
    if (this.discovery && !force) return this.discovery;
    const discoveryUrl = new URL(DISCOVERY_PATH, this.baseUrl);
    const { payload } = await this._request(discoveryUrl, { signal });
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      fail('INVALID_DISCOVERY', 'This is not a compatible Heritage Community server.');
    }
    const integration = payload.integrations?.syncShow;
    const legacyCapability = payload.capabilities?.syncShowSongLibrary === true;
    const integrationIsObject = integration
      && typeof integration === 'object'
      && !Array.isArray(integration);
    if (!integrationIsObject && !legacyCapability) {
      fail('SYNC_UNSUPPORTED', 'This Heritage Community server does not support SyncShow.');
    }
    const configured = integrationIsObject ? integration : {};
    const schemaVersion = configured.schemaVersion === undefined
      ? 1
      : configured.schemaVersion;
    if (schemaVersion !== 1 && schemaVersion !== 2) {
      fail('SYNC_UNSUPPORTED', 'This Community server uses an unsupported SyncShow protocol.');
    }
    if (configured.deviceAuthorization === false
      || (schemaVersion === 2 && configured.deviceAuthorization !== true)) {
      fail('SYNC_UNSUPPORTED', 'This Community server has not enabled SyncShow authorization.');
    }
    if (schemaVersion === 1 && configured.songLibrary === false) {
      fail('SYNC_UNSUPPORTED', 'This Community server has not enabled SyncShow song synchronization.');
    }
    const apiBase = pinnedUrl(configured.apiBaseUrl, {
      origin: this.baseUrl.origin,
      apiPath: DEFAULT_API_PATH,
      label: 'Community API URL',
      fallback: DEFAULT_API_PATH
    });
    const apiPath = new URL(apiBase).pathname.replace(/\/+$/, '');
    const endpoints = configured.endpoints === undefined ? {} : configured.endpoints;
    if (!endpoints || typeof endpoints !== 'object' || Array.isArray(endpoints)) {
      fail('INVALID_DISCOVERY', 'Community endpoint details are invalid.');
    }
    const resources = configured.resources === undefined ? {} : configured.resources;
    if (!resources || typeof resources !== 'object' || Array.isArray(resources)) {
      fail('INVALID_DISCOVERY', 'Community resource details are invalid.');
    }
    const songResource = schemaVersion === 1
      ? normalizeSongResource({
        schemaVersion: 1,
        endpoint: endpoints.songs === undefined ? 'songs' : endpoints.songs,
        scopes: configured.scopes === undefined ? SONG_SCOPES : configured.scopes
      }, {
        origin: this.baseUrl.origin,
        apiPath
      })
      : normalizeSongResource(resources.songs, {
        origin: this.baseUrl.origin,
        apiPath
      });
    const sermonResource = normalizeSermonResource(resources.sermons, {
      origin: this.baseUrl.origin,
      apiPath
    });
    const sermonPublicationResource = schemaVersion === 2
      ? normalizeSermonPublicationResource(resources.sermonPublications, {
        origin: this.baseUrl.origin,
        apiPath
      })
      : null;
    const songPublicLinkResource = schemaVersion === 2
      ? normalizeSongPublicLinkResource(resources.songPublicLinks, {
        origin: this.baseUrl.origin,
        apiPath
      })
      : null;
    const servicePlanResource = schemaVersion === 2
      ? normalizeServicePlanResource(resources.servicePlans, {
        origin: this.baseUrl.origin,
        apiPath
      })
      : null;
    const serviceDocumentResource = schemaVersion === 2
      ? normalizeServiceDocumentResource(resources.serviceDocuments, {
        origin: this.baseUrl.origin,
        apiPath
      })
      : null;
    const sermonMediaResource = schemaVersion === 2
      ? normalizeSermonMediaResource(resources.sermonMedia, {
        origin: this.baseUrl.origin,
        apiPath
      })
      : null;
    if (songPublicLinkResource && !songResource) {
      fail(
        'INVALID_DISCOVERY',
        'Song public-link support also requires a Community song resource.'
      );
    }
    if (sermonPublicationResource && !sermonResource) {
      fail(
        'INVALID_DISCOVERY',
        'Sermon publication support also requires a Community sermon resource.'
      );
    }
    if (sermonMediaResource && !sermonResource) {
      fail(
        'INVALID_DISCOVERY',
        'Sermon-media support also requires a Community sermon resource.'
      );
    }
    if (!songResource
      && !sermonResource
      && !songPublicLinkResource
      && !sermonPublicationResource
      && !sermonMediaResource
      && !servicePlanResource
      && !serviceDocumentResource) {
      fail(
        'SYNC_UNSUPPORTED',
        'This Community server has not enabled a supported SyncShow resource.'
      );
    }
    const songScopes = songResource?.scopes || [];
    const scopes = validateScopeDependencies([
      ...songScopes,
      ...(songPublicLinkResource?.scopes || []),
      ...(sermonResource?.scopes || []),
      ...(sermonResource?.sourceObjectScopes || []),
      ...(sermonPublicationResource?.scopes || []),
      ...(sermonMediaResource?.scopes || []),
      ...(servicePlanResource?.scopes || []),
      ...(serviceDocumentResource?.scopes || [])
    ], {
      code: 'INVALID_DISCOVERY'
    });
    const normalized = Object.freeze({
      schemaVersion,
      serverId: boundedText(payload.server?.id || payload.id, 'Community server ID', 128, {
        required: true,
        pattern: /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
      }),
      serverName: boundedText(
        payload.server?.name || payload.name,
        'Community server name',
        160,
        { fallback: 'Heritage Community' }
      ),
      baseUrl: this.baseUrl.toString(),
      apiBaseUrl: apiBase.replace(/\/+$/, ''),
      // Protocol v1 is normalized from its root song fields; protocol v2
      // supplies the same descriptor under resources.songs. Keep this alias
      // while callers migrate to the resource-lane shape.
      songScopes: Object.freeze(songScopes),
      scopes: Object.freeze(scopes),
      capabilities: Object.freeze({
        deviceAuthorization: true,
        songs: songResource !== null,
        songPublicLinks: songPublicLinkResource !== null,
        sermons: sermonResource !== null,
        sermonSources: Boolean(sermonResource?.sourceObjectScopes.length),
        sermonPublications: sermonPublicationResource !== null,
        sermonMedia: sermonMediaResource !== null,
        servicePlans: servicePlanResource !== null,
        serviceDocuments: serviceDocumentResource !== null
      }),
      resources: Object.freeze({
        songs: songResource,
        songPublicLinks: songPublicLinkResource,
        sermons: sermonResource,
        sermonPublications: sermonPublicationResource,
        sermonMedia: sermonMediaResource,
        servicePlans: servicePlanResource,
        serviceDocuments: serviceDocumentResource
      }),
      endpoints: Object.freeze({
        deviceStart: pinnedUrl(endpoints.deviceStart, {
          origin: this.baseUrl.origin,
          apiPath,
          label: 'Device authorization start endpoint',
          fallback: 'auth/device/start'
        }),
        deviceStatus: pinnedUrl(endpoints.deviceStatus, {
          origin: this.baseUrl.origin,
          apiPath,
          label: 'Device authorization status endpoint',
          fallback: 'auth/device/status'
        }),
        deviceToken: pinnedUrl(endpoints.deviceToken, {
          origin: this.baseUrl.origin,
          apiPath,
          label: 'Device token endpoint',
          fallback: 'auth/device/token'
        }),
        deviceCancel: pinnedUrl(endpoints.deviceCancel, {
          origin: this.baseUrl.origin,
          apiPath,
          label: 'Device authorization cancel endpoint',
          fallback: 'auth/device/cancel'
        }),
        revoke: pinnedUrl(endpoints.revoke, {
          origin: this.baseUrl.origin,
          apiPath,
          label: 'Token revocation endpoint',
          fallback: 'auth/revoke'
        }),
        // Compatibility alias for existing song callers. New capability-aware
        // callers should inspect resources.songs before invoking song methods.
        songs: songResource?.endpoint || null
      })
    });
    this.discovery = normalized;
    return normalized;
  }

  _authorizationId() {
    const id = String(this.randomUUID());
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{7,99}$/.test(id)) {
      throw new TypeError('Community authorization ID generator returned an invalid value');
    }
    return id;
  }

  async startDeviceAuthorization({
    email,
    deviceName,
    scopes,
    signal = null
  } = {}) {
    const discovery = await this.discover({ signal });
    const requestedScopes = normalizeScopes(
      scopes === undefined
        ? discovery.scopes.filter(scope => scope.endsWith(':read'))
        : scopes
    );
    if (requestedScopes.some(scope => !discovery.scopes.includes(scope))) {
      fail('SCOPE_UNAVAILABLE', 'This Community server did not offer the requested access.');
    }
    const normalizedEmail = boundedText(email, 'Administrator email', 320, {
      required: true,
      pattern: /^[^\s@]{1,128}@[^\s@]{1,190}$/
    });
    const normalizedDeviceName = boundedText(deviceName, 'Device name', 120, {
      required: true
    });
    if (this.authorizationFlows.size >= 8) {
      fail('TOO_MANY_AUTHORIZATIONS', 'Finish or cancel the current Community connection first.');
    }
    const verifierBuffer = this.randomBytes(32);
    if (!Buffer.isBuffer(verifierBuffer) || verifierBuffer.length < 32) {
      throw new TypeError('Community PKCE random generator returned too little data');
    }
    const codeVerifier = verifierBuffer.toString('base64url');
    const codeChallenge = crypto.createHash('sha256').update(codeVerifier).digest('base64url');
    const { payload } = await this._request(discovery.endpoints.deviceStart, {
      method: 'POST',
      body: {
        email: normalizedEmail,
        deviceName: normalizedDeviceName,
        scopes: requestedScopes,
        codeChallenge,
        codeChallengeMethod: 'S256'
      },
      expectedStatuses: [200, 201],
      signal
    });
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      fail('INVALID_RESPONSE', 'Community returned invalid device authorization details.');
    }
    const authorizationId = this._authorizationId();
    const deviceId = boundedText(payload.deviceId, 'Device authorization ID', 256, {
      required: true
    });
    const deviceSecret = boundedText(payload.deviceSecret, 'Device authorization secret', 16384, {
      required: true,
      pattern: TOKEN_PATTERN
    });
    const userCode = boundedText(payload.userCode, 'Device authorization code', 32, {
      required: true,
      pattern: /^[A-Z0-9][A-Z0-9-]{3,31}$/i
    });
    const verificationUri = pinnedUrl(payload.verificationUri, {
      origin: this.baseUrl.origin,
      apiPath: '/',
      label: 'Device verification URL',
      fallback: '/'
    });
    const expiresAt = normalizeTimestamp(payload.expiresAt, 'Device authorization expiration', {
      required: true
    });
    const pollIntervalMs = validateLimit(
      payload.pollIntervalMs,
      3000,
      1000,
      30000,
      'pollIntervalMs'
    );
    this.authorizationFlows.set(authorizationId, {
      authorizationId,
      deviceId,
      deviceSecret,
      codeVerifier,
      scopes: requestedScopes,
      expiresAt,
      pollIntervalMs,
      nextPollAt: 0
    });
    return Object.freeze({
      authorizationId,
      userCode,
      verificationUri,
      expiresAt,
      pollIntervalMs
    });
  }

  _flow(authorizationId) {
    const id = boundedText(authorizationId, 'Authorization ID', 100, {
      required: true,
      pattern: /^[A-Za-z0-9][A-Za-z0-9_-]{7,99}$/
    });
    const flow = this.authorizationFlows.get(id);
    if (!flow) fail('AUTHORIZATION_NOT_FOUND', 'Community authorization was not found.');
    // Ask the server once during its short deterministic token-recovery
    // window. A token exchange may have committed just before the displayed
    // approval expiry even if that HTTP response never reached SyncShow.
    if (Date.parse(flow.expiresAt) + AUTHORIZATION_RECOVERY_GRACE_MS
      <= new Date(this.now()).getTime()) {
      this.authorizationFlows.delete(id);
      fail('AUTHORIZATION_EXPIRED', 'Community authorization expired.');
    }
    return flow;
  }

  async pollDeviceAuthorization(authorizationId, { signal = null } = {}) {
    const flow = this._flow(authorizationId);
    const now = new Date(this.now()).getTime();
    if (now < flow.nextPollAt) {
      return Object.freeze({
        status: 'pending',
        retryAfterMs: Math.max(1, flow.nextPollAt - now)
      });
    }
    flow.nextPollAt = now + flow.pollIntervalMs;
    const discovery = await this.discover({ signal });
    const { payload } = await this._request(discovery.endpoints.deviceStatus, {
      method: 'POST',
      body: {
        deviceId: flow.deviceId,
        deviceSecret: flow.deviceSecret
      },
      expectedStatuses: [200, 202],
      signal
    });
    const status = payload?.status;
    if (status === 'pending') {
      const retryAfterMs = validateLimit(
        payload.retryAfterMs,
        flow.pollIntervalMs,
        1000,
        30000,
        'retryAfterMs'
      );
      flow.nextPollAt = now + retryAfterMs;
      return Object.freeze({ status: 'pending', retryAfterMs });
    }
    if (status === 'denied' || status === 'expired' || status === 'cancelled') {
      this.authorizationFlows.delete(flow.authorizationId);
      const codes = {
        denied: ['AUTHORIZATION_DENIED', 'Community authorization was denied.'],
        expired: ['AUTHORIZATION_EXPIRED', 'Community authorization expired.'],
        cancelled: ['AUTHORIZATION_CANCELLED', 'Community authorization was cancelled.']
      };
      fail(codes[status][0], codes[status][1]);
    }
    // A server may have committed the deterministic token exchange even when
    // the first response was lost. "consumed" tells this same device-secret +
    // PKCE holder to retry that idempotent exchange instead of abandoning it.
    if (status !== 'approved' && status !== 'consumed') {
      fail('INVALID_RESPONSE', 'Community returned an invalid authorization status.');
    }
    const tokenResult = await this._request(discovery.endpoints.deviceToken, {
      method: 'POST',
      body: {
        deviceId: flow.deviceId,
        deviceSecret: flow.deviceSecret,
        codeVerifier: flow.codeVerifier
      },
      expectedStatuses: [200, 201],
      signal
    });
    this.authorizationFlows.delete(flow.authorizationId);
    const token = tokenResult.payload;
    if (!token || typeof token !== 'object' || Array.isArray(token)) {
      fail('INVALID_RESPONSE', 'Community returned invalid credentials.');
    }
    const grantedScopes = normalizeScopes(token.scopes, {
      code: 'INVALID_RESPONSE',
      label: 'Granted Community access scopes'
    });
    if (grantedScopes.some(scope => !flow.scopes.includes(scope))) {
      fail('INVALID_RESPONSE', 'Community granted an unexpected access scope.');
    }
    const account = token.account;
    if (!account || typeof account !== 'object' || Array.isArray(account)) {
      fail('INVALID_RESPONSE', 'Community returned an invalid account.');
    }
    return Object.freeze({
      status: 'authorized',
      grant: Object.freeze({
        accessToken: boundedText(token.accessToken, 'Community access token', 16384, {
          required: true,
          pattern: TOKEN_PATTERN
        }),
        refreshToken: boundedText(token.refreshToken, 'Community refresh token', 16384),
        expiresAt: normalizeTimestamp(token.expiresAt, 'Access expiration time', {
          required: true
        }),
        scopes: Object.freeze(grantedScopes),
        account: Object.freeze({
          id: boundedText(account.id, 'Account ID', 256, { required: true }),
          email: boundedText(account.email, 'Account email', 320, {
            required: true,
            pattern: /^[^\s@]{1,128}@[^\s@]{1,190}$/
          }),
          name: boundedText(account.name, 'Account name', 160)
        })
      })
    });
  }

  async cancelDeviceAuthorization(authorizationId, { signal = null } = {}) {
    const flow = this._flow(authorizationId);
    this.authorizationFlows.delete(flow.authorizationId);
    const discovery = await this.discover({ signal });
    try {
      await this._request(discovery.endpoints.deviceCancel, {
        method: 'POST',
        body: {
          deviceId: flow.deviceId,
          deviceSecret: flow.deviceSecret
        },
        expectedStatuses: [200, 204, 404, 410],
        allowEmpty: true,
        signal
      });
    } catch (error) {
      if (!(error instanceof CommunityClientError) || !error.retryable) throw error;
      return Object.freeze({ cancelled: true, remoteCancelled: false });
    }
    return Object.freeze({ cancelled: true, remoteCancelled: true });
  }

  async revokeAccessToken({ accessToken, signal = null } = {}) {
    const discovery = await this.discover({ signal });
    try {
      await this._request(discovery.endpoints.revoke, {
        method: 'POST',
        accessToken,
        expectedStatuses: [200, 204, 401],
        allowEmpty: true,
        signal
      });
      return Object.freeze({ revoked: true });
    } catch (error) {
      if (error instanceof CommunityClientError && error.retryable) {
        return Object.freeze({ revoked: false, warningCode: 'REMOTE_REVOCATION_FAILED' });
      }
      throw error;
    }
  }

  async _sermonResource(signal = null, {
    requiredScope = 'syncshow:sermons:read'
  } = {}) {
    const discovery = await this.discover({ signal });
    const resource = discovery.resources?.sermons;
    if (!resource) {
      fail(
        'SERMON_SYNC_UNSUPPORTED',
        'This Community server has not enabled sermon synchronization.'
      );
    }
    if (!SERMON_SCOPES.includes(requiredScope)
      || !resource.scopes.includes(requiredScope)) {
      fail(
        'SERMON_SCOPE_UNAVAILABLE',
        requiredScope === 'syncshow:sermons:write'
          ? 'This Community server no longer permits SyncShow to save sermons.'
          : 'This Community server no longer permits SyncShow to read sermons.'
      );
    }
    return resource;
  }

  async _sermonPublicationResource(signal = null) {
    const discovery = await this.discover({ signal });
    const resource = discovery.resources?.sermonPublications;
    if (!resource) {
      fail(
        'SERMON_PUBLICATIONS_UNSUPPORTED',
        'This Community server has not enabled sermon publication reads.'
      );
    }
    if (!resource.scopes.includes('syncshow:sermon-publications:read')) {
      fail(
        'SERMON_PUBLICATION_SCOPE_UNAVAILABLE',
        'This Community server no longer permits SyncShow to read sermon publications.'
      );
    }
    return resource;
  }

  async _servicePlanResource(signal = null) {
    const discovery = await this.discover({ signal });
    const resource = discovery.resources?.servicePlans;
    if (!resource) {
      fail(
        'SERVICE_PLANS_UNSUPPORTED',
        'This Community server has not enabled service-plan reads.'
      );
    }
    if (!resource.scopes.includes('syncshow:service-plans:read')) {
      fail(
        'SERVICE_PLAN_SCOPE_UNAVAILABLE',
        'This Community server no longer permits SyncShow to read service plans.'
      );
    }
    return resource;
  }

  async _serviceDocumentResource(signal = null, {
    requiredScope = 'syncshow:service-documents:read'
  } = {}) {
    const discovery = await this.discover({ signal });
    const resource = discovery.resources?.serviceDocuments;
    if (!resource) {
      fail(
        'SERVICE_DOCUMENTS_UNSUPPORTED',
        'This Community server has not enabled shared service documents.'
      );
    }
    if (!SERVICE_DOCUMENT_SCOPES.includes(requiredScope)
      || !resource.scopes.includes(requiredScope)) {
      fail(
        'SERVICE_DOCUMENT_SCOPE_UNAVAILABLE',
        requiredScope === 'syncshow:service-documents:write'
          ? 'This Community server no longer permits SyncShow to save service documents.'
          : 'This Community server no longer permits SyncShow to read service documents.'
      );
    }
    return resource;
  }

  async _songResource(signal = null, {
    requiredScope = 'syncshow:songs:read'
  } = {}) {
    const discovery = await this.discover({ signal });
    const resource = discovery.resources?.songs;
    if (!resource) {
      fail(
        'SONG_SYNC_UNSUPPORTED',
        'This Community server has not enabled song synchronization.'
      );
    }
    if (!SONG_SCOPES.includes(requiredScope)
      || !resource.scopes.includes(requiredScope)) {
      fail(
        'SONG_SCOPE_UNAVAILABLE',
        requiredScope === 'syncshow:songs:write'
          ? 'This Community server no longer permits SyncShow to save songs.'
          : 'This Community server no longer permits SyncShow to read songs.'
      );
    }
    return resource;
  }

  async _songMemberSharingResource(signal = null) {
    const songs = await this._songResource(signal, {
      requiredScope: 'syncshow:songs:write'
    });
    if (!songs.memberSharing) {
      fail(
        'SONG_MEMBER_SHARING_UNSUPPORTED',
        'This Community server can stage songs privately but does not support reviewed member sharing. Update Heritage Community before making songs member-visible.'
      );
    }
    return songs.memberSharing;
  }

  async _songPublicLinkResource(signal = null, {
    requiredScope = 'syncshow:song-public-links:read'
  } = {}) {
    const discovery = await this.discover({ signal });
    const resource = discovery.resources?.songPublicLinks;
    if (!resource) {
      fail(
        'SONG_PUBLIC_LINKS_UNSUPPORTED',
        'This Community server has not enabled anonymous song public links.'
      );
    }
    if (!SONG_PUBLIC_LINK_SCOPES.includes(requiredScope)
      || !resource.scopes.includes(requiredScope)) {
      fail(
        'SONG_PUBLIC_LINK_SCOPE_UNAVAILABLE',
        requiredScope === 'syncshow:song-public-links:write'
          ? 'This Community server no longer permits SyncShow to manage song public links.'
          : 'This Community server no longer permits SyncShow to read song public links.'
      );
    }
    return resource;
  }

  async listSongPublicLinks({
    songSyncId,
    cursor = null,
    limit = MAX_SONG_PUBLIC_LINK_ITEMS,
    accessToken,
    signal = null
  } = {}) {
    const resource = await this._songPublicLinkResource(signal, {
      requiredScope: 'syncshow:song-public-links:read'
    });
    const id = boundedText(songSyncId, 'Song sync ID', 128, {
      required: true,
      pattern: SYNC_ID_PATTERN
    });
    const normalizedCursor = normalizeSongPublicLinkCursor(cursor);
    const pageLimit = validateLimit(
      limit,
      MAX_SONG_PUBLIC_LINK_ITEMS,
      1,
      MAX_SONG_PUBLIC_LINK_ITEMS,
      'limit'
    );
    const url = new URL(resource.endpoint);
    url.searchParams.set('songSyncId', id);
    if (normalizedCursor !== null) url.searchParams.set('cursor', normalizedCursor);
    url.searchParams.set('limit', String(pageLimit));
    const { payload } = await this._request(url, {
      accessToken,
      signal,
      maximumResponseBytes: MAX_SONG_PUBLIC_LINK_RESPONSE_BYTES
    });
    if (!payload
      || typeof payload !== 'object'
      || Array.isArray(payload)
      || Object.keys(payload).length !== 3
      || !['items', 'nextCursor', 'hasMore']
        .every(key => Object.prototype.hasOwnProperty.call(payload, key))
      || !Array.isArray(payload.items)
      || payload.items.length > pageLimit) {
      fail('INVALID_RESPONSE', 'Community returned an invalid song public-link page.');
    }
    const nextCursor = normalizeSongPublicLinkCursor(payload.nextCursor, {
      response: true
    });
    if (payload.hasMore !== true && payload.hasMore !== false) {
      fail('INVALID_RESPONSE', 'Community returned an invalid song public-link page.');
    }
    if ((payload.hasMore && nextCursor === null)
      || (!payload.hasMore && nextCursor !== null)) {
      fail('INVALID_RESPONSE', 'Community returned an inconsistent song public-link cursor.');
    }
    const now = new Date(this.now());
    const items = payload.items.map(item => normalizeSongPublicLinkItem(item, {
      resource,
      now
    }));
    if (new Set(items.map(item => item.linkId)).size !== items.length) {
      fail(
        'INVALID_RESPONSE',
        'Community returned duplicate song public-link identities.'
      );
    }
    if (items.some(item => item.songSyncId !== id)) {
      fail(
        'INVALID_RESPONSE',
        'Community returned a song public link for a different song.'
      );
    }
    return Object.freeze({
      items: Object.freeze(items),
      nextCursor,
      hasMore: payload.hasMore
    });
  }

  async createSongPublicLink({
    songSyncId,
    songSyncVersion,
    familyRevision,
    review,
    reviewRevision,
    label = null,
    expiresAt = null,
    idempotencyKey,
    accessToken,
    signal = null
  } = {}) {
    const resource = await this._songPublicLinkResource(signal, {
      requiredScope: 'syncshow:song-public-links:write'
    });
    const id = boundedText(songSyncId, 'Song sync ID', 128, {
      required: true,
      pattern: SYNC_ID_PATTERN
    });
    if (!Number.isSafeInteger(songSyncVersion) || songSyncVersion < 1) {
      fail('INVALID_INPUT', 'Expected Community song version is invalid.');
    }
    const normalizedFamilyRevision = normalizeSha256(
      familyRevision,
      'Song-family revision'
    );
    const normalizedReviewRevision = normalizeSha256(
      reviewRevision,
      'Song public-link review revision'
    );
    const normalizedReview = normalizeSongPublicLinkReview(review, {
      familyRevision: normalizedFamilyRevision,
      reviewRevision: normalizedReviewRevision
    });
    const normalizedLabel = normalizeSongPublicLinkLabel(label);
    const normalizedExpiresAt = normalizeCanonicalTimestamp(
      expiresAt,
      'Song public-link expiration time'
    );
    const now = new Date(this.now());
    if (Number.isNaN(now.getTime())) {
      throw new TypeError('Community client clock is invalid');
    }
    if (normalizedExpiresAt && Date.parse(normalizedExpiresAt) <= now.getTime()) {
      fail('INVALID_INPUT', 'Song public-link expiration time must be in the future.');
    }
    const reviewStatus = songPublicLinkReviewStatus(normalizedReview, {
      familyRevision: normalizedFamilyRevision,
      now,
      expiresAt: normalizedExpiresAt
    });
    if (reviewStatus !== 'current') {
      const message = reviewStatus === 'expired'
        ? 'Song public-link rights review has expired.'
        : 'Song public-link expiration cannot outlast its rights review.';
      fail('INVALID_INPUT', message);
    }
    const normalizedIdempotencyKey = normalizeIdempotencyKey(idempotencyKey);
    const body = {
      songSyncId: id,
      familyRevision: normalizedFamilyRevision,
      review: normalizedReview,
      reviewRevision: normalizedReviewRevision,
      label: normalizedLabel,
      expiresAt: normalizedExpiresAt
    };
    const { payload } = await this._request(resource.endpoint, {
      method: 'POST',
      accessToken,
      headers: {
        'Idempotency-Key': normalizedIdempotencyKey,
        'If-Match': `"song:${id}:${songSyncVersion}"`
      },
      body,
      expectedStatuses: [200, 201],
      signal,
      maximumResponseBytes: MAX_SONG_PUBLIC_LINK_RESPONSE_BYTES
    });
    const link = normalizeSongPublicLinkResponse(payload, { resource, now });
    if (link.songSyncId !== id
      || link.songSyncVersion !== songSyncVersion
      || link.familyRevision !== normalizedFamilyRevision
      || link.reviewRevision !== normalizedReviewRevision
      || link.label !== normalizedLabel
      || link.expiresAt !== normalizedExpiresAt
      || link.status !== 'active') {
      fail(
        'PUBLIC_LINK_NOT_APPLIED',
        'Heritage Community did not confirm the exact song public link.'
      );
    }
    return link;
  }

  async revokeSongPublicLink({
    linkId,
    expectedLinkVersion,
    idempotencyKey,
    accessToken,
    signal = null
  } = {}) {
    const resource = await this._songPublicLinkResource(signal, {
      requiredScope: 'syncshow:song-public-links:write'
    });
    const id = normalizeSongPublicLinkId(linkId);
    if (!Number.isSafeInteger(expectedLinkVersion) || expectedLinkVersion < 1) {
      fail('INVALID_INPUT', 'Expected song public-link version is invalid.');
    }
    const normalizedIdempotencyKey = normalizeIdempotencyKey(idempotencyKey);
    const url = `${resource.endpoint.replace(/\/+$/, '')}/${encodeURIComponent(id)}`;
    const { payload } = await this._request(url, {
      method: 'DELETE',
      accessToken,
      headers: {
        'Idempotency-Key': normalizedIdempotencyKey,
        'If-Match': `"song-public-link:${id}:${expectedLinkVersion}"`
      },
      expectedStatuses: [200, 202],
      signal,
      maximumResponseBytes: MAX_SONG_PUBLIC_LINK_RESPONSE_BYTES
    });
    const link = normalizeSongPublicLinkResponse(payload, {
      resource,
      now: new Date(this.now())
    });
    if (link.linkId !== id
      || link.linkVersion <= expectedLinkVersion
      || link.status !== 'revoked'
      || link.revokedAt === null) {
      fail(
        'PUBLIC_LINK_NOT_REVOKED',
        'Heritage Community did not confirm that the song public link was revoked.'
      );
    }
    return link;
  }

  async listSongChanges({
    cursor = null,
    limit = 100,
    accessToken,
    signal = null
  } = {}) {
    const resource = await this._songResource(signal, {
      requiredScope: 'syncshow:songs:read'
    });
    const normalizedCursor = cursor !== null && cursor !== undefined
      ? boundedText(cursor, 'Sync cursor', 2048, { required: true })
      : null;
    let pageLimit = validateLimit(limit, 100, 1, 100, 'limit');
    while (pageLimit >= 1) {
      const url = new URL(resource.endpoint);
      if (normalizedCursor !== null) url.searchParams.set('cursor', normalizedCursor);
      url.searchParams.set('limit', String(pageLimit));
      let payload;
      try {
        ({ payload } = await this._request(url, { accessToken, signal }));
      } catch (error) {
        if (error instanceof CommunityClientError
          && error.code === 'RESPONSE_TOO_LARGE'
          && pageLimit > 1) {
          pageLimit = Math.max(1, Math.floor(pageLimit / 2));
          continue;
        }
        throw error;
      }
      const items = payload?.items || payload?.songs;
      if (!Array.isArray(items) || items.length > pageLimit) {
        fail('INVALID_RESPONSE', 'Community returned an invalid song change page.');
      }
      return Object.freeze({
        items: Object.freeze(items.map(normalizeRemoteSong)),
        nextCursor: boundedText(payload.nextCursor, 'Next sync cursor', 2048),
        hasMore: payload.hasMore === true
      });
    }
    fail('RESPONSE_TOO_LARGE', 'A Community song is too large to synchronize safely.');
  }

  async listServicePlans({
    cursor = null,
    limit = 50,
    accessToken,
    signal = null
  } = {}) {
    const resource = await this._servicePlanResource(signal);
    let normalizedCursor = null;
    if (cursor !== null && cursor !== undefined) {
      if (typeof cursor !== 'string'
        || cursor.length < 1
        || Buffer.byteLength(cursor, 'utf8') > MAX_COMMUNITY_SERVICE_PLAN_CURSOR_BYTES
        || /[\u0000-\u001f\u007f]/.test(cursor)) {
        fail('INVALID_INPUT', 'Community service-plan cursor is invalid.');
      }
      normalizedCursor = cursor;
    }
    const pageLimit = validateLimit(
      limit,
      50,
      1,
      MAX_COMMUNITY_SERVICE_PLAN_PAGE_ITEMS,
      'limit'
    );
    const url = new URL(resource.endpoint);
    if (normalizedCursor !== null) {
      url.searchParams.set('cursor', normalizedCursor);
    }
    url.searchParams.set('limit', String(pageLimit));
    const { payload } = await this._request(url, {
      accessToken,
      signal,
      maximumResponseBytes: MAX_COMMUNITY_SERVICE_PLAN_RESPONSE_BYTES
    });
    return servicePlanWire(() => normalizeCommunityServicePlanPage(payload, {
      maximumItems: pageLimit
    }));
  }

  async getServicePlan({ syncId, accessToken, signal = null } = {}) {
    const resource = await this._servicePlanResource(signal);
    const id = boundedText(syncId, 'Community service-plan sync ID', 128, {
      required: true,
      pattern: SYNC_ID_PATTERN
    });
    const url = `${resource.endpoint.replace(/\/+$/, '')}/${encodeURIComponent(id)}`;
    const { payload } = await this._request(url, {
      accessToken,
      signal,
      maximumResponseBytes: MAX_COMMUNITY_SERVICE_PLAN_RESPONSE_BYTES
    });
    const plan = normalizeServicePlanResponse(payload);
    if (resource.schemaVersion === 1 && plan.plan.schemaVersion !== 1) {
      fail(
        'SERVICE_PLAN_SCHEMA_MISMATCH',
        'Community returned service-plan schema v2 after advertising service-plan protocol v1.'
      );
    }
    if (plan.syncId !== id) {
      fail(
        'INVALID_RESPONSE',
        'Community service-plan identity does not match the requested plan.'
      );
    }
    return plan;
  }

  async listServiceDocuments({
    cursor = null,
    limit = 50,
    accessToken,
    signal = null
  } = {}) {
    const resource = await this._serviceDocumentResource(signal);
    const normalizedCursor = normalizeServiceDocumentCursor(cursor);
    const pageLimit = validateLimit(
      limit,
      50,
      1,
      MAX_HERITAGE_SERVICE_DOCUMENT_PAGE_ITEMS,
      'limit'
    );
    const url = new URL(resource.endpoint);
    if (normalizedCursor !== null) {
      url.searchParams.set('cursor', normalizedCursor);
    }
    url.searchParams.set('limit', String(pageLimit));
    const { payload } = await this._request(url, {
      accessToken,
      signal,
      maximumResponseBytes: MAX_HERITAGE_SERVICE_DOCUMENT_RESPONSE_BYTES
    });
    return serviceDocumentWire(() => normalizeHeritageServiceDocumentPage(
      payload,
      { maximumItems: pageLimit }
    ));
  }

  async listServiceDocumentChanges({
    cursor = null,
    limit = 50,
    accessToken,
    signal = null
  } = {}) {
    const resource = await this._serviceDocumentResource(signal);
    const normalizedCursor = normalizeServiceDocumentCursor(cursor);
    const pageLimit = validateLimit(
      limit,
      50,
      1,
      MAX_HERITAGE_SERVICE_DOCUMENT_PAGE_ITEMS,
      'limit'
    );
    const url = new URL(resource.changesEndpoint);
    if (normalizedCursor !== null) {
      url.searchParams.set('cursor', normalizedCursor);
    }
    url.searchParams.set('limit', String(pageLimit));
    const { payload } = await this._request(url, {
      accessToken,
      signal,
      maximumResponseBytes: MAX_HERITAGE_SERVICE_DOCUMENT_RESPONSE_BYTES
    });
    return serviceDocumentWire(() => normalizeHeritageServiceDocumentChangePage(
      payload,
      { maximumItems: pageLimit }
    ));
  }

  async getServiceDocument({ syncId, accessToken, signal = null } = {}) {
    const resource = await this._serviceDocumentResource(signal);
    const id = boundedText(syncId, 'Community service-document sync ID', 128, {
      required: true,
      pattern: SYNC_ID_PATTERN
    });
    const url = `${resource.endpoint.replace(/\/+$/, '')}/${encodeURIComponent(id)}`;
    const { payload } = await this._request(url, {
      accessToken,
      signal,
      maximumResponseBytes: MAX_HERITAGE_SERVICE_DOCUMENT_RESPONSE_BYTES
    });
    const document = normalizeServiceDocumentResponse(payload);
    if (document.syncId !== id) {
      fail(
        'INVALID_RESPONSE',
        'Community service-document identity does not match the requested document.'
      );
    }
    return document;
  }

  async createServiceDocument({
    syncId,
    documentSource,
    status = 'planning',
    accessToken,
    idempotencyKey,
    signal = null
  } = {}) {
    const resource = await this._serviceDocumentResource(signal, {
      requiredScope: 'syncshow:service-documents:write'
    });
    const mutation = normalizeServiceDocumentMutation({
      syncId,
      documentSource,
      status
    });
    const key = boundedText(
      idempotencyKey,
      'Service-document idempotency key',
      128,
      { required: true, pattern: IDEMPOTENCY_KEY_PATTERN }
    );
    const { payload } = await this._request(resource.endpoint, {
      method: 'POST',
      accessToken,
      headers: { 'Idempotency-Key': key },
      body: {
        syncId: mutation.syncId,
        documentSource: mutation.documentSource,
        status: mutation.status
      },
      expectedStatuses: [200, 201],
      signal,
      maximumRequestBytes: MAX_HERITAGE_SERVICE_DOCUMENT_RESPONSE_BYTES,
      maximumResponseBytes: MAX_HERITAGE_SERVICE_DOCUMENT_RESPONSE_BYTES
    });
    return normalizeServiceDocumentResponse(payload);
  }

  async updateServiceDocument({
    syncId,
    documentSource,
    status = 'planning',
    baseSyncVersion,
    baseRevision,
    accessToken,
    idempotencyKey,
    signal = null
  } = {}) {
    const resource = await this._serviceDocumentResource(signal, {
      requiredScope: 'syncshow:service-documents:write'
    });
    const mutation = normalizeServiceDocumentMutation({
      syncId,
      documentSource,
      status
    });
    if (!Number.isSafeInteger(baseSyncVersion) || baseSyncVersion < 1) {
      fail('INVALID_INPUT', 'Service-document base sync version is invalid.');
    }
    const revision = normalizeSha256(
      baseRevision,
      'Service-document base revision'
    );
    const key = boundedText(
      idempotencyKey,
      'Service-document idempotency key',
      128,
      { required: true, pattern: IDEMPOTENCY_KEY_PATTERN }
    );
    const url = `${resource.endpoint.replace(/\/+$/, '')}/${encodeURIComponent(mutation.syncId)}`;
    const { payload } = await this._request(url, {
      method: 'PUT',
      accessToken,
      headers: {
        'Idempotency-Key': key,
        'If-Match': `"${revision}"`,
        'X-Heritage-Base-Sync-Version': String(baseSyncVersion)
      },
      body: {
        syncId: mutation.syncId,
        baseSyncVersion,
        baseRevision: revision,
        documentSource: mutation.documentSource,
        status: mutation.status
      },
      signal,
      maximumRequestBytes: MAX_HERITAGE_SERVICE_DOCUMENT_RESPONSE_BYTES,
      maximumResponseBytes: MAX_HERITAGE_SERVICE_DOCUMENT_RESPONSE_BYTES
    });
    return normalizeServiceDocumentResponse(payload);
  }

  async putServiceDocumentAsset({
    asset,
    bytes,
    accessToken,
    signal = null
  } = {}) {
    const resource = await this._serviceDocumentResource(signal, {
      requiredScope: 'syncshow:service-documents:write'
    });
    const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes || []);
    const normalized = normalizeServiceDocumentAsset(asset, { bytes: buffer });
    const url = `${resource.endpoint.replace(/\/+$/, '')}/assets/${encodeURIComponent(normalized.id)}`;
    const metadataHeaders = normalized.kind === 'image'
      ? {
          'X-Heritage-Asset-Width': String(normalized.width),
          'X-Heritage-Asset-Height': String(normalized.height),
          'X-Heritage-Asset-Orientation': String(normalized.orientation)
        }
      : {};
    await this._binaryRequest(url, {
      method: 'PUT',
      body: buffer,
      accessToken,
      expectedStatuses: [200, 201, 204],
      headers: {
        'Content-Type': normalized.mediaType,
        'Content-Length': String(normalized.size),
        ...metadataHeaders
      },
      signal,
      maximumRequestBytes: normalized.kind === 'video'
        ? MAX_HERITAGE_SERVICE_VIDEO_BYTES
        : MAX_HERITAGE_SERVICE_ASSET_BYTES,
      maximumResponseBytes: 64 * 1024
    });
    return normalized;
  }

  async getServiceDocumentAsset({
    syncId,
    asset,
    accessToken,
    signal = null
  } = {}) {
    const resource = await this._serviceDocumentResource(signal);
    const id = boundedText(syncId, 'Community service-document sync ID', 128, {
      required: true,
      pattern: SYNC_ID_PATTERN
    });
    const normalized = normalizeServiceDocumentAsset(asset);
    const url = `${resource.endpoint.replace(/\/+$/, '')}/${encodeURIComponent(id)}/assets/${encodeURIComponent(normalized.id)}`;
    const { buffer, response } = await this._binaryRequest(url, {
      accessToken,
      signal,
      maximumResponseBytes: Math.max(normalized.size, 64 * 1024)
    });
    const mediaType = String(response.headers?.get?.('content-type') || '')
      .split(';', 1)[0]
      .trim()
      .toLowerCase();
    if (mediaType !== normalized.mediaType
      || buffer.length !== normalized.size
      || crypto.createHash('sha256').update(buffer).digest('hex')
        !== normalized.sha256) {
      fail(
        'INVALID_RESPONSE',
        'Community returned service media bytes that do not match the shared document.'
      );
    }
    return buffer;
  }

  async getSong({ syncId, accessToken, signal = null } = {}) {
    const resource = await this._songResource(signal, {
      requiredScope: 'syncshow:songs:read'
    });
    const id = boundedText(syncId, 'Song sync ID', 128, {
      required: true,
      pattern: SYNC_ID_PATTERN
    });
    const url = `${resource.endpoint.replace(/\/+$/, '')}/${encodeURIComponent(id)}`;
    const { payload } = await this._request(url, { accessToken, signal });
    return normalizeRemoteSong(payload?.song || payload);
  }

  async createSong({
    syncId,
    syncDocuments,
    visibility = 'private',
    publishAt = null,
    rightsStatus,
    rightsNotes,
    accessToken,
    idempotencyKey = null,
    signal = null
  } = {}) {
    const resource = await this._songResource(signal, {
      requiredScope: 'syncshow:songs:write'
    });
    const id = boundedText(syncId, 'Song sync ID', 128, {
      required: true,
      pattern: SYNC_ID_PATTERN
    });
    const documents = normalizeSyncDocuments(syncDocuments);
    if (documents.length < 1) fail('INVALID_INPUT', 'A new community song requires at least one document.');
    const normalizedVisibility = normalizePrivateSongWriteVisibility(
      visibility,
      publishAt
    );
    const requestHeaders = {};
    if (idempotencyKey) {
      requestHeaders['Idempotency-Key'] = boundedText(
        idempotencyKey,
        'Idempotency key',
        128,
        { required: true, pattern: /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/ }
      );
    }
    const { payload } = await this._request(resource.endpoint, {
      method: 'POST',
      accessToken,
      headers: requestHeaders,
      body: {
        syncId: id,
        syncDocuments: documents,
        ...normalizedVisibility,
        ...normalizeReviewedSongRights(rightsStatus, rightsNotes)
      },
      expectedStatuses: [200, 201],
      signal
    });
    return normalizeRemoteSong(payload?.song || payload);
  }

  async updateSong({
    syncId,
    syncDocuments,
    visibility,
    publishAt,
    rightsStatus,
    rightsNotes,
    expectedSyncVersion,
    accessToken,
    signal = null
  } = {}) {
    const resource = await this._songResource(signal, {
      requiredScope: 'syncshow:songs:write'
    });
    const id = boundedText(syncId, 'Song sync ID', 128, {
      required: true,
      pattern: SYNC_ID_PATTERN
    });
    if (!Number.isSafeInteger(expectedSyncVersion) || expectedSyncVersion < 1) {
      fail('INVALID_INPUT', 'Expected song sync version is invalid.');
    }
    const body = {};
    if (syncDocuments !== undefined) {
      const documents = normalizeSyncDocuments(syncDocuments);
      if (documents.length < 1) fail('INVALID_INPUT', 'A song update cannot erase all synced documents.');
      body.syncDocuments = documents;
    }
    if (visibility !== undefined || publishAt !== undefined) {
      Object.assign(
        body,
        normalizePrivateSongWriteVisibility(visibility, publishAt)
      );
    }
    Object.assign(body, normalizeReviewedSongRights(rightsStatus, rightsNotes));
    if (Object.keys(body).length === 0) fail('INVALID_INPUT', 'Song update has no changes.');
    const url = `${resource.endpoint.replace(/\/+$/, '')}/${encodeURIComponent(id)}`;
    const { payload } = await this._request(url, {
      method: 'PUT',
      accessToken,
      headers: { 'If-Match': `"song:${id}:${expectedSyncVersion}"` },
      body,
      signal
    });
    return normalizeRemoteSong(payload?.song || payload);
  }

  async shareSongWithMembers({
    syncId,
    expectedSyncVersion,
    familyRevision,
    review,
    reviewRevision,
    visibility,
    publishAt = null,
    accessToken,
    signal = null
  } = {}) {
    const resource = await this._songMemberSharingResource(signal);
    const request = songMemberSharingWire(() =>
      buildSongMemberSharingRequest({
        syncId,
        expectedSyncVersion,
        familyRevision,
        review,
        reviewRevision,
        visibility,
        publishAt
      }));
    const url = `${resource.endpoint.replace(/\/+$/, '')}/${
      encodeURIComponent(request.syncId)
    }`;
    const { payload } = await this._request(url, {
      method: 'POST',
      accessToken,
      headers: {
        'If-Match': `"song:${request.syncId}:${request.expectedSyncVersion}"`,
        'Idempotency-Key': request.idempotencyKey
      },
      body: request.body,
      expectedStatuses: [200, 201],
      signal,
      maximumResponseBytes: MAX_SONG_MEMBER_SHARING_RESPONSE_BYTES
    });
    const receipt = songMemberSharingWire(
      () => normalizeSongMemberSharingResponse(payload, {
        expected: request,
        review: request.body.review
      }),
      { response: true }
    );
    // The transaction response is an immutable receipt. Re-read the song so
    // an idempotent replay cannot make an older receipt look like current
    // state after a later manager action.
    const song = await this.getSong({
      syncId: request.syncId,
      accessToken,
      signal
    });
    if (song.syncVersion !== receipt.songSyncVersion
      || song.visibility !== receipt.visibility
      || song.publishAt !== receipt.publishAt
      || !['private', 'public'].includes(song.effectiveVisibility)
      || song.memberSharing?.receiptRevision !== receipt.receiptRevision) {
      fail(
        'MEMBER_SHARING_CURRENT_STATE_MISMATCH',
        'Heritage Community returned a valid member-sharing receipt, but the song is no longer at that exact confirmed state.'
      );
    }
    return Object.freeze({ receipt, song });
  }

  async archiveSong({
    syncId,
    expectedSyncVersion,
    accessToken,
    signal = null
  } = {}) {
    const resource = await this._songResource(signal, {
      requiredScope: 'syncshow:songs:write'
    });
    const id = boundedText(syncId, 'Song sync ID', 128, {
      required: true,
      pattern: SYNC_ID_PATTERN
    });
    if (!Number.isSafeInteger(expectedSyncVersion) || expectedSyncVersion < 1) {
      fail('INVALID_INPUT', 'Expected song sync version is invalid.');
    }
    const url = `${resource.endpoint.replace(/\/+$/, '')}/${encodeURIComponent(id)}`;
    const { payload } = await this._request(url, {
      method: 'DELETE',
      accessToken,
      headers: { 'If-Match': `"song:${id}:${expectedSyncVersion}"` },
      expectedStatuses: [200, 202],
      signal
    });
    return normalizeRemoteSong(payload?.song || payload);
  }

  async listSermonChanges({
    cursor = null,
    limit = MAX_SERMON_CHANGE_ITEMS,
    accessToken,
    signal = null
  } = {}) {
    const resource = await this._sermonResource(signal, {
      requiredScope: 'syncshow:sermons:read'
    });
    let normalizedCursor = null;
    if (cursor !== null && cursor !== undefined) {
      if (typeof cursor !== 'string'
        || cursor.length === 0
        || Buffer.byteLength(cursor, 'utf8') > MAX_SERMON_CURSOR_BYTES
        || /[\u0000-\u001f\u007f]/.test(cursor)) {
        fail('INVALID_INPUT', 'Sermon change cursor is invalid.');
      }
      normalizedCursor = cursor;
    }
    const pageLimit = validateLimit(
      limit,
      MAX_SERMON_CHANGE_ITEMS,
      1,
      MAX_SERMON_CHANGE_ITEMS,
      'limit'
    );
    const url = new URL(resource.endpoint);
    if (normalizedCursor !== null) url.searchParams.set('cursor', normalizedCursor);
    url.searchParams.set('limit', String(pageLimit));
    const { payload } = await this._request(url, { accessToken, signal });
    const page = sermonWire(() => normalizeSermonChangePage(payload));
    if (page.items.length > pageLimit) {
      fail(
        'INVALID_RESPONSE',
        'Community sermon change page exceeds the requested limit.'
      );
    }
    return page;
  }

  async getSermon({ syncId, accessToken, signal = null } = {}) {
    const resource = await this._sermonResource(signal, {
      requiredScope: 'syncshow:sermons:read'
    });
    const id = boundedText(syncId, 'Sermon sync ID', 128, {
      required: true,
      pattern: SYNC_ID_PATTERN
    });
    const url = `${resource.endpoint.replace(/\/+$/, '')}/${encodeURIComponent(id)}`;
    const { payload } = await this._request(url, {
      accessToken,
      signal,
      maximumResponseBytes: MAX_SERMON_TRANSFER_JSON_BYTES
    });
    return normalizeSermonResponse(payload);
  }

  async getSermonPublication({ syncId, accessToken, signal = null } = {}) {
    const resource = await this._sermonPublicationResource(signal);
    const id = boundedText(syncId, 'Sermon sync ID', 128, {
      required: true,
      pattern: SYNC_ID_PATTERN
    });
    const url = `${resource.endpoint.replace(/\/+$/, '')}/${encodeURIComponent(id)}`;
    const { payload } = await this._request(url, {
      accessToken,
      signal,
      maximumResponseBytes: MAX_SERMON_PUBLICATION_RESPONSE_BYTES
    });
    const publication = normalizeSermonPublicationResponse(payload);
    if (publication.syncId !== id) {
      fail(
        'INVALID_RESPONSE',
        'Community sermon publication identity does not match the requested sermon.'
      );
    }
    return publication;
  }

  async getSermonPublicationArtifacts({ publicId, signal = null } = {}) {
    await this._sermonPublicationResource(signal);
    const id = boundedText(publicId, 'Public sermon ID', 96, {
      required: true,
      pattern: SERMON_PUBLIC_ID_PATTERN
    });
    const catalogUrl = new URL(SERMON_PUBLIC_CATALOG_PATH, this.baseUrl);
    const detailUrl = new URL(
      `${SERMON_PUBLIC_CONTENT_BASE_PATH}/${encodeURIComponent(id)}`,
      this.baseUrl
    );
    const passageIndexUrl = new URL(
      SERMON_PUBLIC_PASSAGE_INDEX_PATH,
      this.baseUrl
    );
    const [catalog, detail, passageIndex] = await Promise.all([
      this._request(catalogUrl, {
        signal,
        maximumResponseBytes: MAX_PUBLIC_SERMON_CATALOG_BYTES
      }),
      this._request(detailUrl, {
        signal,
        maximumResponseBytes: MAX_PUBLIC_SERMON_DETAIL_BYTES
      }),
      this._request(passageIndexUrl, {
        signal,
        maximumResponseBytes: MAX_PUBLIC_SERMON_PASSAGE_INDEX_BYTES
      })
    ]);
    return Object.freeze({
      detailSource: detail.source,
      catalogSource: catalog.source,
      passageIndexSource: passageIndex.source
    });
  }

  async createSermon({
    syncId,
    documentSource,
    accessToken,
    idempotencyKey,
    signal = null
  } = {}) {
    const resource = await this._sermonResource(signal, {
      requiredScope: 'syncshow:sermons:write'
    });
    const body = sermonWire(() => buildSermonCreateBody({
      syncId,
      documentSource
    }));
    const headers = sermonWire(() =>
      buildSermonIdempotencyHeaders(idempotencyKey));
    const { payload } = await this._request(resource.endpoint, {
      method: 'POST',
      accessToken,
      headers,
      body,
      expectedStatuses: [200, 201],
      signal,
      maximumRequestBytes: MAX_SERMON_TRANSFER_JSON_BYTES,
      maximumResponseBytes: MAX_SERMON_TRANSFER_JSON_BYTES
    });
    return normalizeSermonResponse(payload);
  }

  async updateSermon({
    syncId,
    documentSource,
    expectedSyncVersion,
    accessToken,
    signal = null
  } = {}) {
    const resource = await this._sermonResource(signal, {
      requiredScope: 'syncshow:sermons:write'
    });
    const body = sermonWire(() => buildSermonUpdateBody({
      syncId,
      documentSource
    }));
    const headers = sermonWire(() => buildSermonIfMatchHeaders({
      syncId,
      expectedSyncVersion
    }));
    const url = `${resource.endpoint.replace(/\/+$/, '')}/${encodeURIComponent(body.syncId)}`;
    const { payload } = await this._request(url, {
      method: 'PUT',
      accessToken,
      headers,
      body,
      signal,
      maximumRequestBytes: MAX_SERMON_TRANSFER_JSON_BYTES,
      maximumResponseBytes: MAX_SERMON_TRANSFER_JSON_BYTES
    });
    return normalizeSermonResponse(payload);
  }
}

module.exports = {
  CommunityClient,
  CommunityClientError,
  DEFAULT_API_PATH,
  DISCOVERY_PATH,
  KNOWN_SCOPES,
  SERVICE_DOCUMENT_SCOPES,
  SERVICE_PLAN_SCOPES,
  SONG_PUBLIC_LINK_SCOPES,
  SERMON_PUBLICATION_SCOPES,
  SERMON_MEDIA_SCOPES,
  SERMON_SCOPES,
  SERMON_SOURCE_SCOPES,
  SONG_SCOPES,
  MAX_DOCUMENTS,
  MAX_DOCUMENT_BYTES,
  MAX_DOCUMENT_TOTAL_BYTES,
  MAX_COMMUNITY_SERVICE_PLAN_RESPONSE_BYTES,
  MAX_HERITAGE_SERVICE_DOCUMENT_RESPONSE_BYTES,
  MAX_HERITAGE_SERVICE_ASSET_BYTES,
  MAX_HERITAGE_SERVICE_VIDEO_BYTES,
  MAX_SONG_PUBLIC_LINK_ITEMS,
  MAX_SERMON_PUBLICATION_RESPONSE_BYTES,
  MAX_SERMON_TRANSFER_JSON_BYTES,
  VISIBILITIES,
  normalizeBaseUrl,
  normalizeRemoteSong,
  normalizeSongPublicLinkItem,
  normalizeSongPublicLinkReview,
  normalizeSyncDocuments
};
