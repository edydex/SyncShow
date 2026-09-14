'use strict';

const SERVICE_PROJECT_SERVING_SCHEMA_VERSION = 1;
const MAX_SERVICE_PROJECT_SERVING_ASSIGNMENTS = 250;
const MAX_SERVICE_PROJECT_SERVING_ROLE_LENGTH = 120;
const MAX_SERVICE_PROJECT_SERVING_PERSON_NAME_LENGTH = 120;
const MAX_SERVICE_PROJECT_SERVING_NOTE_LENGTH = 500;
const SERVICE_PROJECT_SERVING_STATUSES = Object.freeze([
  'open',
  'assigned',
  'confirmed',
  'declined'
]);

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const CALL_TIME_PATTERN = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
const RESERVED_IDS = new Set(['__proto__', 'prototype', 'constructor']);

class ServiceProjectServingError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'ServiceProjectServingError';
    this.code = code;
    this.details = details;
  }
}

function fail(code, message, details = {}) {
  throw new ServiceProjectServingError(code, message, details);
}

function isRecord(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactKeys(value, expected, label) {
  if (!isRecord(value)) {
    fail(
      'INVALID_SERVICE_PROJECT_SERVING',
      `${label} must be an object.`
    );
  }
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (
    actual.length !== wanted.length
    || actual.some((key, index) => key !== wanted[index])
  ) {
    fail(
      'INVALID_SERVICE_PROJECT_SERVING_FIELDS',
      `${label} contains unsupported or missing fields.`,
      { actual, expected: wanted }
    );
  }
}

function hasUnpairedSurrogate(value) {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xD800 && code <= 0xDBFF) {
      if (index + 1 >= value.length) return true;
      const next = value.charCodeAt(index + 1);
      if (next < 0xDC00 || next > 0xDFFF) return true;
      index += 1;
    } else if (code >= 0xDC00 && code <= 0xDFFF) {
      return true;
    }
  }
  return false;
}

function boundedSingleLine(value, label, maximum, { required = true } = {}) {
  if (typeof value !== 'string' || hasUnpairedSurrogate(value)) {
    fail(
      'INVALID_SERVICE_PROJECT_SERVING_TEXT',
      `${label} must be valid text.`
    );
  }
  const normalized = value.trim().normalize('NFC');
  if (
    (required && !normalized)
    || normalized.length > maximum
    || /[\p{Cc}\p{Zl}\p{Zp}]/u.test(normalized)
  ) {
    fail(
      'INVALID_SERVICE_PROJECT_SERVING_TEXT',
      `${label} must be ${required ? 'non-empty ' : ''}single-line text of ${maximum} characters or fewer.`,
      { maximum }
    );
  }
  return normalized;
}

function boundedMultiline(value, label, maximum) {
  if (typeof value !== 'string' || hasUnpairedSurrogate(value)) {
    fail(
      'INVALID_SERVICE_PROJECT_SERVING_TEXT',
      `${label} must be valid text.`
    );
  }
  const normalized = value.replace(/\r\n?/g, '\n').normalize('NFC');
  if (
    normalized.length > maximum
    || /[\p{Cc}\p{Zl}\p{Zp}]/u.test(normalized.replace(/\n/g, ''))
  ) {
    fail(
      'INVALID_SERVICE_PROJECT_SERVING_TEXT',
      `${label} must contain ${maximum} characters or fewer.`,
      { maximum }
    );
  }
  return normalized;
}

function canonicalId(value, label) {
  const normalized = boundedSingleLine(value, label, 128);
  if (!ID_PATTERN.test(normalized) || RESERVED_IDS.has(normalized)) {
    fail(
      'INVALID_SERVICE_PROJECT_SERVING_ID',
      `${label} must be a canonical identifier.`,
      { value: normalized }
    );
  }
  return normalized;
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) {
    return value;
  }
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}

function normalizeItemIdContext(rawOptions, { required = false } = {}) {
  const options = rawOptions === undefined ? {} : rawOptions;
  if (!isRecord(options)) {
    fail(
      'INVALID_SERVICE_PROJECT_SERVING_OPTIONS',
      'Service serving options must be an object.'
    );
  }
  const unexpected = Object.keys(options).filter(key => key !== 'itemIds');
  if (unexpected.length > 0) {
    fail(
      'INVALID_SERVICE_PROJECT_SERVING_OPTIONS',
      'Service serving options contain unsupported fields.',
      { fields: unexpected.sort() }
    );
  }
  if (required && options.itemIds === undefined) {
    fail(
      'INVALID_SERVICE_PROJECT_SERVING_ITEM_CONTEXT',
      'The current service item IDs are required.'
    );
  }
  if (options.itemIds === undefined) return new Set();
  if (!Array.isArray(options.itemIds) && !(options.itemIds instanceof Set)) {
    fail(
      'INVALID_SERVICE_PROJECT_SERVING_ITEM_CONTEXT',
      'Service item IDs must be an array or Set.'
    );
  }

  const itemIds = new Set();
  for (const [index, rawItemId] of [...options.itemIds].entries()) {
    const itemId = canonicalId(rawItemId, `Service item ID ${index + 1}`);
    if (itemIds.has(itemId)) {
      fail(
        'DUPLICATE_SERVICE_PROJECT_SERVING_ITEM_CONTEXT',
        `Service item ID ${itemId} appears more than once.`,
        { itemId }
      );
    }
    itemIds.add(itemId);
  }
  return itemIds;
}

function normalizeScope(rawScope, index, itemIds, validateItemScopes) {
  const label = `Serving assignment ${index + 1} scope`;
  exactKeys(rawScope, ['kind', 'itemId'], label);
  if (rawScope.kind === 'service') {
    if (rawScope.itemId !== null) {
      fail(
        'INVALID_SERVICE_PROJECT_SERVING_SCOPE',
        `${label} must use a null itemId for the whole service.`
      );
    }
    return { kind: 'service', itemId: null };
  }
  if (rawScope.kind !== 'item') {
    fail(
      'INVALID_SERVICE_PROJECT_SERVING_SCOPE',
      `${label} kind must be service or item.`,
      { kind: rawScope.kind }
    );
  }
  const itemId = canonicalId(rawScope.itemId, `${label} itemId`);
  if (validateItemScopes && !itemIds.has(itemId)) {
    fail(
      'UNKNOWN_SERVICE_PROJECT_SERVING_ITEM',
      `Serving assignment ${index + 1} refers to missing service item ${itemId}.`,
      { index, itemId }
    );
  }
  return { kind: 'item', itemId };
}

function normalizeAssignment(rawAssignment, index, itemIds, validateItemScopes) {
  const label = `Serving assignment ${index + 1}`;
  exactKeys(
    rawAssignment,
    [
      'id',
      'role',
      'personName',
      'scope',
      'status',
      'required',
      'callTime',
      'note'
    ],
    label
  );
  const id = canonicalId(rawAssignment.id, `${label} id`);
  const role = boundedSingleLine(
    rawAssignment.role,
    `${label} role`,
    MAX_SERVICE_PROJECT_SERVING_ROLE_LENGTH
  );
  if (!SERVICE_PROJECT_SERVING_STATUSES.includes(rawAssignment.status)) {
    fail(
      'INVALID_SERVICE_PROJECT_SERVING_STATUS',
      `${label} status must be one of ${SERVICE_PROJECT_SERVING_STATUSES.join(', ')}.`,
      { id, status: rawAssignment.status }
    );
  }
  const personName = rawAssignment.personName === null
    ? null
    : boundedSingleLine(
        rawAssignment.personName,
        `${label} person name`,
        MAX_SERVICE_PROJECT_SERVING_PERSON_NAME_LENGTH
      );
  if (rawAssignment.status === 'open' && personName !== null) {
    fail(
      'INVALID_SERVICE_PROJECT_SERVING_PERSON',
      `${label} must not name a person while it is open.`,
      { id }
    );
  }
  if (rawAssignment.status !== 'open' && personName === null) {
    fail(
      'INVALID_SERVICE_PROJECT_SERVING_PERSON',
      `${label} must name a person unless it is open.`,
      { id }
    );
  }
  if (typeof rawAssignment.required !== 'boolean') {
    fail(
      'INVALID_SERVICE_PROJECT_SERVING_REQUIRED',
      `${label} required must be a boolean.`,
      { id }
    );
  }
  if (
    rawAssignment.callTime !== null
    && (
      typeof rawAssignment.callTime !== 'string'
      || !CALL_TIME_PATTERN.test(rawAssignment.callTime)
    )
  ) {
    fail(
      'INVALID_SERVICE_PROJECT_SERVING_CALL_TIME',
      `${label} callTime must be null or local venue time as HH:mm.`,
      { id }
    );
  }

  return {
    id,
    role,
    personName,
    scope: normalizeScope(
      rawAssignment.scope,
      index,
      itemIds,
      validateItemScopes
    ),
    status: rawAssignment.status,
    required: rawAssignment.required,
    callTime: rawAssignment.callTime,
    note: boundedMultiline(
      rawAssignment.note,
      `${label} note`,
      MAX_SERVICE_PROJECT_SERVING_NOTE_LENGTH
    )
  };
}

function normalizeServing(raw, itemIds, { validateItemScopes = true } = {}) {
  exactKeys(raw, ['schemaVersion', 'assignments'], 'Service serving plan');
  if (raw.schemaVersion !== SERVICE_PROJECT_SERVING_SCHEMA_VERSION) {
    fail(
      'UNSUPPORTED_SERVICE_PROJECT_SERVING',
      `Service serving plans must use schema v${SERVICE_PROJECT_SERVING_SCHEMA_VERSION}.`,
      { schemaVersion: raw.schemaVersion }
    );
  }
  if (!Array.isArray(raw.assignments)) {
    fail(
      'INVALID_SERVICE_PROJECT_SERVING_ASSIGNMENTS',
      'Service serving assignments must be an array.'
    );
  }
  if (raw.assignments.length > MAX_SERVICE_PROJECT_SERVING_ASSIGNMENTS) {
    fail(
      'TOO_MANY_SERVICE_PROJECT_SERVING_ASSIGNMENTS',
      `A service may contain at most ${MAX_SERVICE_PROJECT_SERVING_ASSIGNMENTS} serving assignments.`,
      { maximum: MAX_SERVICE_PROJECT_SERVING_ASSIGNMENTS }
    );
  }

  const assignments = [];
  const assignmentIds = new Set();
  for (let index = 0; index < raw.assignments.length; index += 1) {
    if (!Object.prototype.hasOwnProperty.call(raw.assignments, index)) {
      fail(
        'INVALID_SERVICE_PROJECT_SERVING_ASSIGNMENTS',
        'Service serving assignments must be a dense array.',
        { index }
      );
    }
    const assignment = normalizeAssignment(
      raw.assignments[index],
      index,
      itemIds,
      validateItemScopes
    );
    if (assignmentIds.has(assignment.id)) {
      fail(
        'DUPLICATE_SERVICE_PROJECT_SERVING_ASSIGNMENT',
        `Serving assignment ${assignment.id} appears more than once.`,
        { assignmentId: assignment.id }
      );
    }
    assignmentIds.add(assignment.id);
    assignments.push(assignment);
  }

  return deepFreeze({
    schemaVersion: SERVICE_PROJECT_SERVING_SCHEMA_VERSION,
    assignments
  });
}

function normalizeServiceProjectServing(raw, options = {}) {
  return normalizeServing(raw, normalizeItemIdContext(options));
}

/**
 * "Filled" means assigned or confirmed. A declined required slot remains open
 * work for the planner, so requiredOpen includes required open and declined
 * assignments. uniquePeople counts only people still assigned to serve.
 */
function summarizeServiceProjectServing(raw, options = {}) {
  const serving = normalizeServiceProjectServing(raw, options);
  const people = new Set();
  let filled = 0;
  let open = 0;
  let declined = 0;
  let requiredOpen = 0;

  for (const assignment of serving.assignments) {
    const isFilled = ['assigned', 'confirmed'].includes(assignment.status);
    if (isFilled) {
      filled += 1;
      people.add(assignment.personName);
    } else if (assignment.status === 'open') {
      open += 1;
    } else {
      declined += 1;
    }
    if (assignment.required && !isFilled) requiredOpen += 1;
  }

  return deepFreeze({
    filled,
    open,
    declined,
    requiredOpen,
    uniquePeople: people.size
  });
}

function pruneMissingServiceProjectServingItemScopes(raw, options = {}) {
  const itemIds = normalizeItemIdContext(options, { required: true });
  const serving = normalizeServing(
    raw,
    itemIds,
    { validateItemScopes: false }
  );
  return normalizeServing(
    {
      schemaVersion: SERVICE_PROJECT_SERVING_SCHEMA_VERSION,
      assignments: serving.assignments.filter(assignment =>
        assignment.scope.kind === 'service'
        || itemIds.has(assignment.scope.itemId))
    },
    itemIds
  );
}

function normalizeItemRebindings(rawRebindings, itemIds) {
  const entries = rawRebindings instanceof Map
    ? [...rawRebindings.entries()]
    : isRecord(rawRebindings)
      ? Object.entries(rawRebindings)
      : fail(
          'INVALID_SERVICE_PROJECT_SERVING_REBINDINGS',
          'Serving item rebindings must be an object or Map.'
        );
  const rebindings = new Map();
  for (const [index, [rawSourceId, rawTargetId]] of entries.entries()) {
    const sourceId = canonicalId(
      rawSourceId,
      `Serving item rebinding ${index + 1} source`
    );
    const targetId = canonicalId(
      rawTargetId,
      `Serving item rebinding ${index + 1} target`
    );
    if (rebindings.has(sourceId)) {
      fail(
        'DUPLICATE_SERVICE_PROJECT_SERVING_REBINDING',
        `Service item ${sourceId} is rebound more than once.`,
        { sourceId }
      );
    }
    if (!itemIds.has(targetId)) {
      fail(
        'UNKNOWN_SERVICE_PROJECT_SERVING_REBINDING_TARGET',
        `Serving item rebinding target ${targetId} does not exist.`,
        { sourceId, targetId }
      );
    }
    rebindings.set(sourceId, targetId);
  }
  return rebindings;
}

function rebindServiceProjectServingItemScopes(
  raw,
  rawRebindings,
  options = {}
) {
  const itemIds = normalizeItemIdContext(options, { required: true });
  const rebindings = normalizeItemRebindings(rawRebindings, itemIds);
  const serving = normalizeServing(
    raw,
    itemIds,
    { validateItemScopes: false }
  );
  return normalizeServing(
    {
      schemaVersion: SERVICE_PROJECT_SERVING_SCHEMA_VERSION,
      assignments: serving.assignments.map(assignment => {
        if (assignment.scope.kind !== 'item') return assignment;
        return {
          ...assignment,
          scope: {
            kind: 'item',
            itemId: rebindings.get(assignment.scope.itemId)
              || assignment.scope.itemId
          }
        };
      })
    },
    itemIds
  );
}

module.exports = {
  MAX_SERVICE_PROJECT_SERVING_ASSIGNMENTS,
  MAX_SERVICE_PROJECT_SERVING_NOTE_LENGTH,
  MAX_SERVICE_PROJECT_SERVING_PERSON_NAME_LENGTH,
  MAX_SERVICE_PROJECT_SERVING_ROLE_LENGTH,
  SERVICE_PROJECT_SERVING_SCHEMA_VERSION,
  SERVICE_PROJECT_SERVING_STATUSES,
  ServiceProjectServingError,
  normalizeServiceProjectServing,
  pruneMissingServiceProjectServingItemScopes,
  rebindServiceProjectServingItemScopes,
  summarizeServiceProjectServing
};
