'use strict';

const projectCore = require('./node/services/project/ServiceProject');

const HERITAGE_SERVICE_DOCUMENT_KIND = 'heritage-service-document';
const HERITAGE_SERVICE_DOCUMENT_SCHEMA_VERSION = 1;
const HERITAGE_SERVICE_PROJECT_KIND = 'syncshow-service-project';
const HERITAGE_SERVICE_PROJECT_SCHEMA_VERSION = 1;
const HERITAGE_SERVICE_DOCUMENT_STATUSES = Object.freeze([
  'planning',
  'ready',
  'archived',
  'cancelled'
]);
const MAX_HERITAGE_SERVICE_DOCUMENT_BYTES = 16 * 1024 * 1024;
const MAX_HERITAGE_SERVICE_DOCUMENT_PAGE_ITEMS = 100;
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const REVISION_PATTERN = /^[a-f0-9]{64}$/;
const TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

class HeritageServiceDocumentError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'HeritageServiceDocumentError';
    this.code = code;
    this.details = details;
  }
}

function fail(code, message, details = {}) {
  throw new HeritageServiceDocumentError(code, message, details);
}

function isRecord(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactKeys(value, expected, label) {
  if (!isRecord(value)) fail('INVALID_DOCUMENT', `${label} must be an object.`);
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length
    || actual.some((key, index) => key !== wanted[index])) {
    fail('INVALID_DOCUMENT_FIELDS', `${label} has unsupported or missing fields.`, {
      actual,
      expected: wanted
    });
  }
}

function identifier(value, label) {
  if (typeof value !== 'string'
    || !ID_PATTERN.test(value)
    || ['__proto__', 'prototype', 'constructor'].includes(value)) {
    fail('INVALID_DOCUMENT_ID', `${label} is invalid.`);
  }
  return value;
}

function positiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 1) {
    fail('INVALID_SYNC_VERSION', `${label} must be a positive integer.`);
  }
  return value;
}

function timestamp(value, label) {
  if (typeof value !== 'string'
    || !TIMESTAMP_PATTERN.test(value)
    || Number.isNaN(Date.parse(value))
    || new Date(value).toISOString() !== value) {
    fail('INVALID_TIMESTAMP', `${label} is invalid.`);
  }
  return value;
}

function revision(value, label) {
  if (typeof value !== 'string' || !REVISION_PATTERN.test(value)) {
    fail('INVALID_REVISION', `${label} must be a lowercase SHA-256.`);
  }
  return value;
}

function status(value) {
  if (!HERITAGE_SERVICE_DOCUMENT_STATUSES.includes(value)) {
    fail(
      'INVALID_DOCUMENT_STATUS',
      `Service document status must be one of ${HERITAGE_SERVICE_DOCUMENT_STATUSES.join(', ')}.`
    );
  }
  return value;
}

function deepClone(value) {
  return JSON.parse(JSON.stringify(value));
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.keys(value).sort().map(key => [key, stableValue(value[key])])
  );
}

function utf8Length(value) {
  if (typeof TextEncoder === 'function') return new TextEncoder().encode(value).length;
  // TextEncoder is present in supported browsers and Node 22. This fallback is
  // deliberately conservative for older embedding environments.
  return unescape(encodeURIComponent(value)).length;
}

function normalizeProjectShape(raw) {
  const project = projectCore.normalizeServiceProject(raw, { now: new Date(0) });
  if (project.revision < 1) {
    fail(
      'UNSAVED_SERVICE_PROJECT',
      'A shared service document must identify a saved native project revision.'
    );
  }
  return project;
}

function normalizeHeritageServiceDocument(raw, {
  normalizeProject = normalizeProjectShape
} = {}) {
  exactKeys(raw, ['schemaVersion', 'kind', 'id', 'project'], 'Heritage service document');
  if (raw.schemaVersion !== HERITAGE_SERVICE_DOCUMENT_SCHEMA_VERSION
    || raw.kind !== HERITAGE_SERVICE_DOCUMENT_KIND) {
    fail(
      'UNSUPPORTED_DOCUMENT',
      `Service documents must use ${HERITAGE_SERVICE_DOCUMENT_KIND} schema v${HERITAGE_SERVICE_DOCUMENT_SCHEMA_VERSION}.`
    );
  }
  const id = identifier(raw.id, 'Heritage service document id');
  let project;
  try {
    project = normalizeProject(raw.project);
  } catch (error) {
    if (error instanceof HeritageServiceDocumentError) throw error;
    fail('INVALID_SERVICE_PROJECT', error.message || 'Service project is invalid.', {
      cause: error.code || error.name
    });
  }
  if (!isRecord(project) || project.id !== id) {
    fail(
      'DOCUMENT_PROJECT_ID_MISMATCH',
      'Heritage service document identity does not match its service content.'
    );
  }
  const normalized = {
    schemaVersion: HERITAGE_SERVICE_DOCUMENT_SCHEMA_VERSION,
    kind: HERITAGE_SERVICE_DOCUMENT_KIND,
    id,
    project: deepClone(project)
  };
  const source = `${JSON.stringify(stableValue(normalized))}\n`;
  if (utf8Length(source) > MAX_HERITAGE_SERVICE_DOCUMENT_BYTES) {
    fail(
      'DOCUMENT_TOO_LARGE',
      `A service document can use at most ${MAX_HERITAGE_SERVICE_DOCUMENT_BYTES} bytes.`
    );
  }
  return deepFreeze(normalized);
}

function createHeritageServiceDocument(project, options = {}) {
  return normalizeHeritageServiceDocument({
    schemaVersion: HERITAGE_SERVICE_DOCUMENT_SCHEMA_VERSION,
    kind: HERITAGE_SERVICE_DOCUMENT_KIND,
    id: project?.id,
    project
  }, options);
}

function serializeHeritageServiceDocument(raw, options = {}) {
  const document = normalizeHeritageServiceDocument(raw, options);
  return `${JSON.stringify(stableValue(document))}\n`;
}

function parseHeritageServiceDocumentSource(source, {
  requireCanonical = true,
  ...options
} = {}) {
  if (typeof source !== 'string'
    || utf8Length(source) < 2
    || utf8Length(source) > MAX_HERITAGE_SERVICE_DOCUMENT_BYTES) {
    fail('INVALID_DOCUMENT_SOURCE', 'Service document source is invalid.');
  }
  let raw;
  try {
    raw = JSON.parse(source);
  } catch (_error) {
    fail('INVALID_DOCUMENT_JSON', 'Service document source is not valid JSON.');
  }
  const document = normalizeHeritageServiceDocument(raw, options);
  const documentSource = serializeHeritageServiceDocument(document, options);
  if (requireCanonical && documentSource !== source) {
    fail('NONCANONICAL_DOCUMENT_SOURCE', 'Service document source is not canonical.');
  }
  return document;
}

function replaceHeritageServiceProject(rawDocument, rawProject, options = {}) {
  const document = normalizeHeritageServiceDocument(rawDocument, options);
  return normalizeHeritageServiceDocument({
    ...document,
    project: rawProject
  }, options);
}

function normalizeHeritageServiceDocumentEnvelope(raw, {
  revisionForSource,
  ...options
} = {}) {
  exactKeys(
    raw,
    ['syncId', 'syncVersion', 'revision', 'documentSource', 'status', 'changedAt'],
    'Heritage service document envelope'
  );
  const document = parseHeritageServiceDocumentSource(raw.documentSource, options);
  const syncId = identifier(raw.syncId, 'Heritage service document sync id');
  if (document.id !== syncId) {
    fail('DOCUMENT_SYNC_ID_MISMATCH', 'Service document source does not match its sync identity.');
  }
  const normalizedRevision = revision(raw.revision, 'Heritage service document revision');
  if (typeof revisionForSource === 'function'
    && revisionForSource(raw.documentSource) !== normalizedRevision) {
    fail('DOCUMENT_REVISION_MISMATCH', 'Service document source does not match its revision.');
  }
  return deepFreeze({
    syncId,
    syncVersion: positiveInteger(raw.syncVersion, 'Heritage service document sync version'),
    revision: normalizedRevision,
    documentSource: raw.documentSource,
    document,
    project: document.project,
    status: status(raw.status),
    changedAt: timestamp(raw.changedAt, 'Heritage service document change time')
  });
}

function normalizeHeritageServiceDocumentSummary(raw) {
  exactKeys(
    raw,
    ['syncId', 'syncVersion', 'revision', 'status', 'title', 'serviceDate', 'changedAt'],
    'Heritage service document summary'
  );
  const title = typeof raw.title === 'string' ? raw.title.trim() : '';
  if (!title || title.length > 200) fail('INVALID_DOCUMENT_SUMMARY', 'Service document title is invalid.');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw.serviceDate || '')) {
    fail('INVALID_DOCUMENT_SUMMARY', 'Service document date is invalid.');
  }
  return deepFreeze({
    syncId: identifier(raw.syncId, 'Heritage service document summary id'),
    syncVersion: positiveInteger(raw.syncVersion, 'Heritage service document summary sync version'),
    revision: revision(raw.revision, 'Heritage service document summary revision'),
    status: status(raw.status),
    title,
    serviceDate: raw.serviceDate,
    changedAt: timestamp(raw.changedAt, 'Heritage service document summary change time')
  });
}

function normalizeHeritageServiceDocumentPage(raw, {
  maximumItems = MAX_HERITAGE_SERVICE_DOCUMENT_PAGE_ITEMS
} = {}) {
  exactKeys(raw, ['items', 'nextCursor', 'hasMore'], 'Heritage service document page');
  if (!Number.isSafeInteger(maximumItems)
    || maximumItems < 1
    || maximumItems > MAX_HERITAGE_SERVICE_DOCUMENT_PAGE_ITEMS
    || !Array.isArray(raw.items)
    || raw.items.length > maximumItems
    || typeof raw.hasMore !== 'boolean'
    || (raw.nextCursor !== null && typeof raw.nextCursor !== 'string')) {
    fail('INVALID_DOCUMENT_PAGE', 'Heritage service document page is invalid.');
  }
  const nextCursor = raw.nextCursor === null ? null : raw.nextCursor.trim();
  if ((raw.hasMore && !nextCursor) || (!raw.hasMore && nextCursor !== null)) {
    fail('INVALID_DOCUMENT_PAGE', 'Heritage service document cursor state is inconsistent.');
  }
  const items = raw.items.map(normalizeHeritageServiceDocumentSummary);
  if (new Set(items.map(item => item.syncId)).size !== items.length) {
    fail('INVALID_DOCUMENT_PAGE', 'Heritage service document page contains duplicate items.');
  }
  return deepFreeze({ items, nextCursor, hasMore: raw.hasMore });
}

function normalizeHeritageServiceDocumentChangePage(raw, {
  maximumItems = MAX_HERITAGE_SERVICE_DOCUMENT_PAGE_ITEMS
} = {}) {
  exactKeys(raw, ['items', 'nextCursor', 'hasMore'], 'Heritage service document change page');
  if (!Number.isSafeInteger(maximumItems)
    || maximumItems < 1
    || maximumItems > MAX_HERITAGE_SERVICE_DOCUMENT_PAGE_ITEMS
    || !Array.isArray(raw.items)
    || raw.items.length > maximumItems
    || typeof raw.hasMore !== 'boolean'
    || typeof raw.nextCursor !== 'string') {
    fail('INVALID_DOCUMENT_CHANGE_PAGE', 'Heritage service document change page is invalid.');
  }
  const nextCursor = raw.nextCursor.trim();
  if (!nextCursor
    || utf8Length(nextCursor) > 2048
    || /[\u0000-\u001f\u007f]/.test(nextCursor)) {
    fail('INVALID_DOCUMENT_CHANGE_PAGE', 'Heritage service document change checkpoint is invalid.');
  }
  const items = raw.items.map(normalizeHeritageServiceDocumentSummary);
  if (new Set(items.map(item => item.syncId)).size !== items.length) {
    fail(
      'INVALID_DOCUMENT_CHANGE_PAGE',
      'Heritage service document change page contains duplicate items.'
    );
  }
  return deepFreeze({ items, nextCursor, hasMore: raw.hasMore });
}

module.exports = {
  ...projectCore,
  HERITAGE_SERVICE_DOCUMENT_KIND,
  HERITAGE_SERVICE_DOCUMENT_SCHEMA_VERSION,
  HERITAGE_SERVICE_DOCUMENT_STATUSES,
  HERITAGE_SERVICE_PROJECT_KIND,
  HERITAGE_SERVICE_PROJECT_SCHEMA_VERSION,
  HeritageServiceDocumentError,
  MAX_HERITAGE_SERVICE_DOCUMENT_BYTES,
  MAX_HERITAGE_SERVICE_DOCUMENT_PAGE_ITEMS,
  createHeritageServiceDocument,
  normalizeHeritageServiceDocument,
  normalizeHeritageServiceDocumentEnvelope,
  normalizeHeritageServiceDocumentChangePage,
  normalizeHeritageServiceDocumentPage,
  normalizeHeritageServiceDocumentSummary,
  parseHeritageServiceDocumentSource,
  replaceHeritageServiceProject,
  serializeHeritageServiceDocument
};
