'use strict';

const {
  MAX_SERMON_BODY_ENTRIES
} = require('../sermon/SermonDocument');
const {
  MAX_PUBLIC_SERMON_MEDIA,
  deriveSermonPublicId
} = require('../sermon/SermonPublicProjection');

// These pure validators define manager-transaction intent and read-only state
// shapes. Constructing a valid intent does not authorize publication. A
// Community server must independently authenticate a manager and apply the
// transition atomically; SyncShow exposes only the read-only state lane.
const COMMUNITY_SERMON_PUBLICATION_SCHEMA_VERSION = 1;
const MAX_SERMON_PUBLICATION_ID_BYTES = 128;
const MAX_SERMON_PUBLICATION_BODY_SELECTIONS = MAX_SERMON_BODY_ENTRIES;
const MAX_SERMON_PUBLICATION_MEDIA_SELECTIONS = MAX_PUBLIC_SERMON_MEDIA;

const SYNC_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;

const PUBLISH_INTENT_KEYS = [
  'schemaVersion',
  'action',
  'syncId',
  'expectedSyncVersion',
  'expectedCurrentRevision',
  'expectedPublicationVersion',
  'expectedPublicRevision',
  'selectedBodyEntryIds',
  'selectedMediaIds',
  'publicAudienceConfirmed',
  'canonicalLinkConfirmed'
];

const WITHDRAW_INTENT_KEYS = [
  'schemaVersion',
  'action',
  'syncId',
  'expectedSyncVersion',
  'expectedCurrentRevision',
  'expectedPublicationVersion',
  'expectedPublicRevision'
];

const PUBLICATION_STATE_KEYS = [
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
  'publishedAt',
  'selectedBodyEntryIds',
  'selectedMediaIds'
];

class CommunitySermonPublicationWireError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'CommunitySermonPublicationWireError';
    this.code = code;
    this.details = details;
  }
}

function fail(code, message, details = {}) {
  throw new CommunitySermonPublicationWireError(code, message, details);
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function assertRecord(value, label, code) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail(code, `${label} must be an object.`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    fail(code, `${label} must be a plain object.`);
  }
}

function assertExactKeys(value, expectedKeys, label, code) {
  assertRecord(value, label, code);
  const expected = new Set(expectedKeys);
  for (const key of expectedKeys) {
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

function protocolText(value, label, maximumBytes, pattern, code) {
  if (
    typeof value !== 'string'
    || value.length === 0
    || Buffer.byteLength(value, 'utf8') > maximumBytes
    || /[\u0000-\u001f\u007f]/u.test(value)
    || !pattern.test(value)
  ) {
    fail(code, `${label} is invalid.`);
  }
  return value;
}

function normalizeSyncId(value, code) {
  return protocolText(
    value,
    'Community sermon sync ID',
    MAX_SERMON_PUBLICATION_ID_BYTES,
    SYNC_ID_PATTERN,
    code
  );
}

function normalizeSelectionId(value, label, code) {
  return protocolText(
    value,
    label,
    MAX_SERMON_PUBLICATION_ID_BYTES,
    SYNC_ID_PATTERN,
    code
  );
}

function normalizeSha256(value, label, code) {
  return protocolText(value, label, 64, SHA256_PATTERN, code);
}

function normalizeNullableSha256(value, label, code) {
  return value === null ? null : normalizeSha256(value, label, code);
}

function normalizePositiveVersion(value, label, code, { nullable = false } = {}) {
  if (nullable && value === null) return null;
  if (!Number.isSafeInteger(value) || value < 1) {
    fail(code, `${label} must be a positive safe integer${nullable ? ' or null' : ''}.`);
  }
  return value;
}

function normalizeSchemaVersion(value, label, code) {
  if (value !== COMMUNITY_SERMON_PUBLICATION_SCHEMA_VERSION) {
    fail(code, `${label} uses an unsupported schema version.`);
  }
  return COMMUNITY_SERMON_PUBLICATION_SCHEMA_VERSION;
}

function normalizeSelectionIds(value, label, maximum, code) {
  if (!Array.isArray(value) || value.length > maximum) {
    fail(code, `${label} must contain at most ${maximum} IDs.`);
  }
  const seen = new Set();
  return value.map((rawId, index) => {
    const id = normalizeSelectionId(rawId, `${label} item ${index + 1}`, code);
    if (seen.has(id)) {
      fail(code, `${label} repeats an ID.`, { id });
    }
    seen.add(id);
    return id;
  });
}

function normalizeExpectedPublicationPointer(value, code, { requireActive = false } = {}) {
  const expectedPublicationVersion = normalizePositiveVersion(
    value.expectedPublicationVersion,
    'Expected sermon publication version',
    code,
    { nullable: true }
  );
  const expectedPublicRevision = normalizeNullableSha256(
    value.expectedPublicRevision,
    'Expected public sermon revision',
    code
  );
  if (expectedPublicRevision !== null && expectedPublicationVersion === null) {
    fail(
      code,
      'An expected public sermon revision requires an expected publication version.'
    );
  }
  if (
    requireActive
    && (expectedPublicationVersion === null || expectedPublicRevision === null)
  ) {
    fail(
      code,
      'Withdrawing a sermon requires its active publication version and public revision.'
    );
  }
  return { expectedPublicationVersion, expectedPublicRevision };
}

function normalizeSermonPublishIntent(value) {
  const code = 'INVALID_PUBLICATION_INTENT';
  assertExactKeys(
    value,
    PUBLISH_INTENT_KEYS,
    'Community sermon publish intent',
    code
  );
  normalizeSchemaVersion(
    value.schemaVersion,
    'Community sermon publish intent',
    code
  );
  if (value.action !== 'publish') {
    fail(code, 'Community sermon publish intent action must be publish.');
  }
  if (
    value.publicAudienceConfirmed !== true
    || value.canonicalLinkConfirmed !== true
  ) {
    fail(
      code,
      'Publishing requires explicit public-audience and canonical-link confirmation.'
    );
  }
  const pointer = normalizeExpectedPublicationPointer(value, code);
  return deepFreeze({
    schemaVersion: COMMUNITY_SERMON_PUBLICATION_SCHEMA_VERSION,
    action: 'publish',
    syncId: normalizeSyncId(value.syncId, code),
    expectedSyncVersion: normalizePositiveVersion(
      value.expectedSyncVersion,
      'Expected sermon sync version',
      code
    ),
    expectedCurrentRevision: normalizeSha256(
      value.expectedCurrentRevision,
      'Expected current sermon revision',
      code
    ),
    expectedPublicationVersion: pointer.expectedPublicationVersion,
    expectedPublicRevision: pointer.expectedPublicRevision,
    selectedBodyEntryIds: normalizeSelectionIds(
      value.selectedBodyEntryIds,
      'Selected public sermon body entries',
      MAX_SERMON_PUBLICATION_BODY_SELECTIONS,
      code
    ),
    selectedMediaIds: normalizeSelectionIds(
      value.selectedMediaIds,
      'Selected public sermon media',
      MAX_SERMON_PUBLICATION_MEDIA_SELECTIONS,
      code
    ),
    publicAudienceConfirmed: true,
    canonicalLinkConfirmed: true
  });
}

function normalizeSermonWithdrawIntent(value) {
  const code = 'INVALID_PUBLICATION_INTENT';
  assertExactKeys(
    value,
    WITHDRAW_INTENT_KEYS,
    'Community sermon withdraw intent',
    code
  );
  normalizeSchemaVersion(
    value.schemaVersion,
    'Community sermon withdraw intent',
    code
  );
  if (value.action !== 'withdraw') {
    fail(code, 'Community sermon withdraw intent action must be withdraw.');
  }
  const pointer = normalizeExpectedPublicationPointer(value, code, {
    requireActive: true
  });
  return deepFreeze({
    schemaVersion: COMMUNITY_SERMON_PUBLICATION_SCHEMA_VERSION,
    action: 'withdraw',
    syncId: normalizeSyncId(value.syncId, code),
    expectedSyncVersion: normalizePositiveVersion(
      value.expectedSyncVersion,
      'Expected sermon sync version',
      code
    ),
    expectedCurrentRevision: normalizeSha256(
      value.expectedCurrentRevision,
      'Expected current sermon revision',
      code
    ),
    expectedPublicationVersion: pointer.expectedPublicationVersion,
    expectedPublicRevision: pointer.expectedPublicRevision
  });
}

function normalizeSermonPublicationIntent(value) {
  const code = 'INVALID_PUBLICATION_INTENT';
  assertRecord(value, 'Community sermon publication intent', code);
  if (value.action === 'publish') return normalizeSermonPublishIntent(value);
  if (value.action === 'withdraw') return normalizeSermonWithdrawIntent(value);
  fail(code, 'Community sermon publication intent action is unsupported.');
}

function normalizeTimestamp(value, code) {
  if (typeof value !== 'string' || value.length > 40) {
    fail(code, 'Sermon publishedAt must be an ISO-8601 timestamp.');
  }
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|([+-])(\d{2}):(\d{2}))$/.exec(value);
  if (!match) {
    fail(code, 'Sermon publishedAt must be an ISO-8601 timestamp.');
  }

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const milliseconds = Number((match[7] || '').padEnd(3, '0'));
  const offsetHours = match[8] === 'Z' ? 0 : Number(match[10]);
  const offsetMinutes = match[8] === 'Z' ? 0 : Number(match[11]);
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [
    31,
    leapYear ? 29 : 28,
    31,
    30,
    31,
    30,
    31,
    31,
    30,
    31,
    30,
    31
  ];
  if (
    month < 1
    || month > 12
    || day < 1
    || day > daysInMonth[month - 1]
    || hour > 23
    || minute > 59
    || second > 59
    || offsetHours > 23
    || offsetMinutes > 59
  ) {
    fail(code, 'Sermon publishedAt must be an ISO-8601 timestamp.');
  }

  const wallClock = new Date(0);
  wallClock.setUTCFullYear(year, month - 1, day);
  wallClock.setUTCHours(hour, minute, second, milliseconds);
  const offset = match[8] === 'Z'
    ? 0
    : (match[9] === '+' ? 1 : -1) * ((offsetHours * 60) + offsetMinutes);
  const expectedTimestamp = wallClock.getTime() - (offset * 60 * 1000);
  const parsedTimestamp = Date.parse(value);
  if (!Number.isFinite(parsedTimestamp) || parsedTimestamp !== expectedTimestamp) {
    fail(code, 'Sermon publishedAt must be an ISO-8601 timestamp.');
  }
  const canonical = new Date(parsedTimestamp).toISOString();
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(canonical)) {
    fail(code, 'Sermon publishedAt must resolve to a four-digit UTC year.');
  }
  return canonical;
}

function normalizeSermonPublicationState(value) {
  const code = 'INVALID_PUBLICATION_STATE';
  assertExactKeys(
    value,
    PUBLICATION_STATE_KEYS,
    'Community sermon publication state',
    code
  );
  normalizeSchemaVersion(
    value.schemaVersion,
    'Community sermon publication state',
    code
  );

  const syncId = normalizeSyncId(value.syncId, code);
  const currentRevision = normalizeSha256(
    value.currentRevision,
    'Current sermon revision',
    code
  );
  const syncVersion = normalizePositiveVersion(
    value.syncVersion,
    'Sermon sync version',
    code
  );
  const publicationVersion = normalizePositiveVersion(
    value.publicationVersion,
    'Sermon publication version',
    code,
    { nullable: true }
  );
  const publicRevision = normalizeNullableSha256(
    value.publicRevision,
    'Public sermon revision',
    code
  );
  const selectedBodyEntryIds = normalizeSelectionIds(
    value.selectedBodyEntryIds,
    'Selected public sermon body entries',
    MAX_SERMON_PUBLICATION_BODY_SELECTIONS,
    code
  );
  const selectedMediaIds = normalizeSelectionIds(
    value.selectedMediaIds,
    'Selected public sermon media',
    MAX_SERMON_PUBLICATION_MEDIA_SELECTIONS,
    code
  );

  let publicId = null;
  let detailChecksum = null;
  let catalogChecksum = null;
  let passageIndexChecksum = null;
  let publishedAt = null;

  if (publicRevision === null) {
    for (const field of [
      'publicId',
      'detailChecksum',
      'catalogChecksum',
      'passageIndexChecksum',
      'publishedAt'
    ]) {
      if (value[field] !== null) {
        fail(code, `Unpublished sermon state requires ${field} to be null.`, {
          field
        });
      }
    }
    if (selectedBodyEntryIds.length > 0 || selectedMediaIds.length > 0) {
      fail(code, 'Unpublished sermon state cannot retain public body or media selections.');
    }
  } else {
    if (publicationVersion === null) {
      fail(code, 'A public sermon revision requires a publication version.');
    }
    if (value.publicId === null
      || value.detailChecksum === null
      || value.catalogChecksum === null
      || value.passageIndexChecksum === null
      || value.publishedAt === null) {
      fail(code, 'Published sermon state requires every public projection field.');
    }
    const expectedPublicId = deriveSermonPublicId(syncId);
    if (value.publicId !== expectedPublicId) {
      fail(code, 'Public sermon ID does not match its stable sermon identity.');
    }
    publicId = expectedPublicId;
    detailChecksum = normalizeSha256(
      value.detailChecksum,
      'Public sermon detail checksum',
      code
    );
    catalogChecksum = normalizeSha256(
      value.catalogChecksum,
      'Public sermon catalog checksum',
      code
    );
    passageIndexChecksum = normalizeSha256(
      value.passageIndexChecksum,
      'Public sermon passage-index checksum',
      code
    );
    publishedAt = normalizeTimestamp(value.publishedAt, code);
  }

  return deepFreeze({
    schemaVersion: COMMUNITY_SERMON_PUBLICATION_SCHEMA_VERSION,
    syncId,
    currentRevision,
    syncVersion,
    publicationVersion,
    publicRevision,
    publicId,
    detailChecksum,
    catalogChecksum,
    passageIndexChecksum,
    publishedAt,
    selectedBodyEntryIds,
    selectedMediaIds
  });
}

module.exports = {
  COMMUNITY_SERMON_PUBLICATION_SCHEMA_VERSION,
  CommunitySermonPublicationWireError,
  MAX_SERMON_PUBLICATION_BODY_SELECTIONS,
  MAX_SERMON_PUBLICATION_ID_BYTES,
  MAX_SERMON_PUBLICATION_MEDIA_SELECTIONS,
  normalizeSermonPublicationIntent,
  normalizeSermonPublicationState,
  normalizeSermonPublishIntent,
  normalizeSermonWithdrawIntent
};
