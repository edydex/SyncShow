'use strict';

const crypto = require('crypto');

const {
  MAX_SERMON_SOURCE_BYTES,
  parseSermonDocument,
  serializeSermonDocument
} = require('../sermon/SermonDocument');

const COMMUNITY_SERMON_WIRE_SCHEMA_VERSION = 1;
const MAX_SERMON_CHANGE_ITEMS = 100;
const MAX_SERMON_CURSOR_BYTES = 2048;
const MAX_SERMON_SOURCE_OBJECTS = 512;
const SYNC_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/;

class CommunitySermonWireError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'CommunitySermonWireError';
    this.code = code;
    this.details = details;
  }
}

function fail(code, message, details = {}) {
  throw new CommunitySermonWireError(code, message, details);
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

function protocolText(value, label, maximumBytes, {
  code,
  pattern = null
}) {
  if (typeof value !== 'string'
    || value.length === 0
    || Buffer.byteLength(value, 'utf8') > maximumBytes
    || /[\u0000-\u001f\u007f]/.test(value)
    || (pattern && !pattern.test(value))) {
    fail(code, `${label} is invalid.`);
  }
  return value;
}

function normalizeSyncId(value, code) {
  return protocolText(value, 'Sermon sync ID', 128, {
    code,
    pattern: SYNC_ID_PATTERN
  });
}

function normalizeRevision(value, code) {
  return protocolText(value, 'Sermon revision', 64, {
    code,
    pattern: SHA256_PATTERN
  });
}

function normalizeSyncVersion(value, code) {
  if (!Number.isSafeInteger(value) || value < 1) {
    fail(code, 'Sermon sync version must be a positive safe integer.');
  }
  return value;
}

function normalizeArchived(value, code) {
  if (typeof value !== 'boolean') {
    fail(code, 'Sermon archived state must be a boolean.');
  }
  return value;
}

function normalizeTimestamp(value, code) {
  if (typeof value !== 'string' || value.length > 40) {
    fail(code, 'Sermon update time must be an ISO-8601 timestamp.');
  }
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|([+-])(\d{2}):(\d{2}))$/.exec(value);
  if (!match) fail(code, 'Sermon update time must be an ISO-8601 timestamp.');

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
  if (month < 1
    || month > 12
    || day < 1
    || day > daysInMonth[month - 1]
    || hour > 23
    || minute > 59
    || second > 59
    || offsetHours > 23
    || offsetMinutes > 59) {
    fail(code, 'Sermon update time must be an ISO-8601 timestamp.');
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
    fail(code, 'Sermon update time must be an ISO-8601 timestamp.');
  }
  const canonical = new Date(parsedTimestamp).toISOString();
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(canonical)) {
    fail(code, 'Sermon update time must resolve to a four-digit UTC year.');
  }
  return canonical;
}

function normalizeSummaryFields(value, code) {
  return {
    syncId: normalizeSyncId(value.syncId, code),
    syncVersion: normalizeSyncVersion(value.syncVersion, code),
    revision: normalizeRevision(value.revision, code),
    archived: normalizeArchived(value.archived, code),
    updatedAt: normalizeTimestamp(value.updatedAt, code)
  };
}

function normalizeSermonChangeSummary(value) {
  const code = 'INVALID_RESPONSE';
  assertExactKeys(
    value,
    ['syncId', 'syncVersion', 'revision', 'archived', 'updatedAt'],
    'Community sermon change summary',
    code
  );
  return deepFreeze(normalizeSummaryFields(value, code));
}

function normalizeCursor(value, code) {
  if (value === null) return null;
  return protocolText(value, 'Sermon change cursor', MAX_SERMON_CURSOR_BYTES, { code });
}

function normalizeSermonChangePage(value) {
  const code = 'INVALID_RESPONSE';
  assertExactKeys(
    value,
    ['schemaVersion', 'items', 'nextCursor', 'hasMore'],
    'Community sermon change page',
    code
  );
  if (value.schemaVersion !== COMMUNITY_SERMON_WIRE_SCHEMA_VERSION) {
    fail(code, 'Community sermon change page uses an unsupported schema version.');
  }
  if (!Array.isArray(value.items) || value.items.length > MAX_SERMON_CHANGE_ITEMS) {
    fail(
      code,
      `Community sermon change pages may contain at most ${MAX_SERMON_CHANGE_ITEMS} items.`
    );
  }
  if (typeof value.hasMore !== 'boolean') {
    fail(code, 'Community sermon change page hasMore must be a boolean.');
  }
  const nextCursor = normalizeCursor(value.nextCursor, code);
  if (!nextCursor) {
    fail(code, 'A Community sermon change page needs a durable next cursor.');
  }
  if (value.hasMore && value.items.length === 0) {
    fail(code, 'A continuing Community sermon change page needs at least one item.');
  }

  const items = value.items.map(normalizeSermonChangeSummary);
  const seen = new Set();
  for (const item of items) {
    if (seen.has(item.syncId)) {
      fail(code, 'Community sermon change page repeats a sermon sync ID.', {
        syncId: item.syncId
      });
    }
    seen.add(item.syncId);
  }
  return deepFreeze({
    schemaVersion: COMMUNITY_SERMON_WIRE_SCHEMA_VERSION,
    items,
    nextCursor,
    hasMore: value.hasMore
  });
}

function inspectCanonicalDocumentSource({
  syncId,
  revision = null,
  documentSource
}, code) {
  const normalizedSyncId = normalizeSyncId(syncId, code);
  if (typeof documentSource !== 'string'
    || Buffer.byteLength(documentSource, 'utf8') > MAX_SERMON_SOURCE_BYTES) {
    fail(code, 'Community sermon documentSource is invalid or too large.');
  }

  let document;
  let canonicalSource;
  try {
    document = parseSermonDocument(documentSource);
    canonicalSource = serializeSermonDocument(document);
  } catch (error) {
    fail(code, 'Community sermon documentSource is not a valid sermon document.', {
      causeCode: error?.code || null
    });
  }
  if (canonicalSource !== documentSource) {
    fail(
      code,
      'Community sermon documentSource must be the exact canonical serialization, including its trailing newline.'
    );
  }
  if (document.sources.length > MAX_SERMON_SOURCE_OBJECTS) {
    fail(
      code,
      `Community sermons may describe at most ${MAX_SERMON_SOURCE_OBJECTS} source objects.`
    );
  }
  if (document.id !== normalizedSyncId) {
    fail(code, 'Community sermon sync ID does not match its document identity.');
  }

  const actualRevision = crypto.createHash('sha256')
    .update(documentSource, 'utf8')
    .digest('hex');
  if (revision !== null) {
    const normalizedRevision = normalizeRevision(revision, code);
    if (normalizedRevision !== actualRevision) {
      fail(code, 'Community sermon revision does not match documentSource.');
    }
  }
  return {
    syncId: normalizedSyncId,
    revision: actualRevision,
    documentSource,
    document
  };
}

function normalizeSourceObjects(value, document, code) {
  if (!Array.isArray(value) || value.length > MAX_SERMON_SOURCE_OBJECTS) {
    fail(
      code,
      `Community sermons may describe at most ${MAX_SERMON_SOURCE_OBJECTS} source objects.`
    );
  }
  if (value.length !== document.sources.length) {
    fail(
      code,
      'Community sermon sourceObjects must describe every canonical sermon source exactly once.'
    );
  }

  const byId = new Map();
  for (const raw of value) {
    assertExactKeys(
      raw,
      ['sourceId', 'sha256', 'sizeBytes', 'available'],
      'Community sermon source object',
      code
    );
    const sourceId = normalizeSyncId(raw.sourceId, code);
    if (byId.has(sourceId)) {
      fail(code, 'Community sermon sourceObjects repeat a source ID.', { sourceId });
    }
    const sha256 = normalizeRevision(raw.sha256, code);
    if (!Number.isSafeInteger(raw.sizeBytes) || raw.sizeBytes < 0) {
      fail(code, 'Community sermon source object sizeBytes is invalid.', { sourceId });
    }
    if (typeof raw.available !== 'boolean') {
      fail(code, 'Community sermon source object available must be a boolean.', { sourceId });
    }
    byId.set(sourceId, {
      sourceId,
      sha256,
      sizeBytes: raw.sizeBytes,
      available: raw.available
    });
  }

  const normalized = [];
  for (const source of document.sources) {
    const remote = byId.get(source.id);
    if (!remote) {
      fail(code, 'Community sermon sourceObjects omit a canonical sermon source.', {
        sourceId: source.id
      });
    }
    if (remote.sha256 !== source.sha256 || remote.sizeBytes !== source.sizeBytes) {
      fail(code, 'Community sermon source object metadata conflicts with the canonical document.', {
        sourceId: source.id
      });
    }
    normalized.push(remote);
    byId.delete(source.id);
  }
  if (byId.size > 0) {
    fail(code, 'Community sermon sourceObjects include an unknown source.', {
      sourceId: byId.keys().next().value
    });
  }
  return normalized;
}

function normalizeRemoteSermonEnvelope(value) {
  const code = 'INVALID_RESPONSE';
  assertExactKeys(
    value,
    [
      'syncId',
      'syncVersion',
      'revision',
      'documentSource',
      'archived',
      'updatedAt',
      'sourceObjects'
    ],
    'Community sermon envelope',
    code
  );
  const summary = normalizeSummaryFields(value, code);
  const inspected = inspectCanonicalDocumentSource({
    syncId: summary.syncId,
    revision: summary.revision,
    documentSource: value.documentSource
  }, code);
  const documentArchived = inspected.document.publication.status === 'archived';
  if (summary.archived !== documentArchived) {
    fail(
      code,
      'Community sermon archived state conflicts with its canonical document.'
    );
  }
  const sourceObjects = normalizeSourceObjects(
    value.sourceObjects,
    inspected.document,
    code
  );
  return deepFreeze({
    syncId: summary.syncId,
    syncVersion: summary.syncVersion,
    revision: inspected.revision,
    documentSource: inspected.documentSource,
    archived: summary.archived,
    updatedAt: summary.updatedAt,
    sourceObjects
  });
}

function buildSermonWriteBody(value) {
  const code = 'INVALID_INPUT';
  assertExactKeys(
    value,
    ['syncId', 'documentSource'],
    'Community sermon write input',
    code
  );
  const inspected = inspectCanonicalDocumentSource({
    syncId: value.syncId,
    documentSource: value.documentSource
  }, code);
  return deepFreeze({
    syncId: inspected.syncId,
    revision: inspected.revision,
    documentSource: inspected.documentSource
  });
}

function buildSermonCreateBody(value) {
  return buildSermonWriteBody(value);
}

function buildSermonUpdateBody(value) {
  return buildSermonWriteBody(value);
}

function buildSermonIfMatchHeaders(value) {
  const code = 'INVALID_INPUT';
  assertExactKeys(
    value,
    ['syncId', 'expectedSyncVersion'],
    'Community sermon If-Match input',
    code
  );
  const syncId = normalizeSyncId(value.syncId, code);
  const expectedSyncVersion = normalizeSyncVersion(value.expectedSyncVersion, code);
  return deepFreeze({
    'If-Match': `"sermon:${syncId}:${expectedSyncVersion}"`
  });
}

function buildSermonIdempotencyHeaders(value) {
  const code = 'INVALID_INPUT';
  const idempotencyKey = protocolText(value, 'Sermon idempotency key', 128, {
    code,
    pattern: IDEMPOTENCY_KEY_PATTERN
  });
  return deepFreeze({
    'Idempotency-Key': idempotencyKey
  });
}

module.exports = {
  COMMUNITY_SERMON_WIRE_SCHEMA_VERSION,
  CommunitySermonWireError,
  MAX_SERMON_CHANGE_ITEMS,
  MAX_SERMON_CURSOR_BYTES,
  MAX_SERMON_SOURCE_OBJECTS,
  buildSermonCreateBody,
  buildSermonIdempotencyHeaders,
  buildSermonIfMatchHeaders,
  buildSermonUpdateBody,
  normalizeRemoteSermonEnvelope,
  normalizeSermonChangePage,
  normalizeSermonChangeSummary
};
