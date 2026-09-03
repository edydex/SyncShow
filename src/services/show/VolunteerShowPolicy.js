'use strict';

const crypto = require('crypto');

const VOLUNTEER_SHOW_MODES = Object.freeze([
  'full',
  'volunteer'
]);
const OPERATOR_AUTHORITY_STATES = Object.freeze([
  'locked',
  'unlocked'
]);
const SHOW_COMMAND_SOURCES = Object.freeze([
  'local',
  'remote'
]);
const SHOW_COMMAND_CLASSIFICATIONS = Object.freeze({
  STANDARD: 'standard',
  EMERGENCY: 'emergency',
  PRIVILEGED: 'privileged'
});
const VOLUNTEER_UNLOCK_GRANT_KIND =
  'syncshow-volunteer-show-unlock-grant';
const VOLUNTEER_UNLOCK_GRANT_SCHEMA_VERSION = 1;
const MAX_VOLUNTEER_UNLOCK_TTL_MS = 5 * 60 * 1000;

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{15,127}$/;
const UNLOCK_TOKEN_PATTERN = /^[A-Za-z0-9_-]{32,128}$/;
const FORBIDDEN_IDS = new Set(['__proto__', 'prototype', 'constructor']);

const LOCAL_COMMANDS = Object.freeze({
  'cue.next': SHOW_COMMAND_CLASSIFICATIONS.STANDARD,
  'cue.previous': SHOW_COMMAND_CLASSIFICATIONS.PRIVILEGED,
  'cue.jump': SHOW_COMMAND_CLASSIFICATIONS.PRIVILEGED,
  'output.clear': SHOW_COMMAND_CLASSIFICATIONS.EMERGENCY,
  'output.restore': SHOW_COMMAND_CLASSIFICATIONS.PRIVILEGED,
  'output.stop': SHOW_COMMAND_CLASSIFICATIONS.EMERGENCY,
  'output.configure': SHOW_COMMAND_CLASSIFICATIONS.PRIVILEGED,
  'session.end': SHOW_COMMAND_CLASSIFICATIONS.PRIVILEGED,
  'bible.show': SHOW_COMMAND_CLASSIFICATIONS.PRIVILEGED,
  'remote.closePairing': SHOW_COMMAND_CLASSIFICATIONS.EMERGENCY,
  'remote.manage': SHOW_COMMAND_CLASSIFICATIONS.PRIVILEGED
});

const REMOTE_COMMANDS = Object.freeze({
  'cue.next': SHOW_COMMAND_CLASSIFICATIONS.STANDARD,
  'cue.previous': SHOW_COMMAND_CLASSIFICATIONS.PRIVILEGED,
  'cue.jump': SHOW_COMMAND_CLASSIFICATIONS.PRIVILEGED,
  'output.clear': SHOW_COMMAND_CLASSIFICATIONS.EMERGENCY,
  'output.restore': SHOW_COMMAND_CLASSIFICATIONS.PRIVILEGED
});

const BINDING_KEYS = Object.freeze([
  'outputSessionId',
  'showFingerprint',
  'showId',
  'venueFingerprint',
  'venueProfileId'
]);
const GRANT_KEYS = Object.freeze([
  'binding',
  'expiresAt',
  'issuedAt',
  'kind',
  'schemaVersion',
  'token'
]);

class VolunteerShowPolicyError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'VolunteerShowPolicyError';
    this.code = code;
    this.details = details;
  }
}

function fail(code, message, details = {}) {
  throw new VolunteerShowPolicyError(code, message, details);
}

function isPlainRecord(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function requireExactDataProperties(value, keys, field, code) {
  if (!isPlainRecord(value)) {
    fail(code, `${field} must be a plain object.`);
  }
  const actualKeys = Reflect.ownKeys(value);
  if (actualKeys.some(key => typeof key !== 'string')) {
    fail(code, `${field} must not contain symbol properties.`);
  }
  const expectedKeys = [...keys].sort();
  const sortedActualKeys = [...actualKeys].sort();
  if (
    sortedActualKeys.length !== expectedKeys.length
    || sortedActualKeys.some((key, index) => key !== expectedKeys[index])
  ) {
    fail(code, `${field} must contain exactly the supported fields.`, {
      fields: sortedActualKeys
    });
  }
  for (const key of sortedActualKeys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
      fail(code, `${field}.${key} must be an own data property.`);
    }
  }
}

function requireAllowedDataProperties(
  value,
  allowedKeys,
  requiredKeys,
  field,
  code
) {
  if (!isPlainRecord(value)) {
    fail(code, `${field} must be a plain object.`);
  }
  const allowed = new Set(allowedKeys);
  const actualKeys = Reflect.ownKeys(value);
  if (
    actualKeys.some(key => typeof key !== 'string' || !allowed.has(key))
    || requiredKeys.some(key => !actualKeys.includes(key))
  ) {
    fail(code, `${field} contains unsupported or missing fields.`, {
      fields: actualKeys.filter(key => typeof key === 'string').sort()
    });
  }
  for (const key of actualKeys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
      fail(code, `${field}.${String(key)} must be an own data property.`);
    }
  }
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function exactId(value, field) {
  if (
    typeof value !== 'string'
    || !ID_PATTERN.test(value)
    || FORBIDDEN_IDS.has(value)
  ) {
    fail(
      'INVALID_VOLUNTEER_SHOW_BINDING',
      `${field} is invalid.`,
      { field }
    );
  }
  return value;
}

function exactFingerprint(value, field) {
  if (typeof value !== 'string' || !SHA256_PATTERN.test(value)) {
    fail(
      'INVALID_VOLUNTEER_SHOW_BINDING',
      `${field} must be a lowercase SHA-256 digest.`,
      { field }
    );
  }
  return value;
}

function exactOutputSessionId(value) {
  if (
    typeof value !== 'string'
    || !SESSION_ID_PATTERN.test(value)
    || FORBIDDEN_IDS.has(value)
  ) {
    fail(
      'INVALID_VOLUNTEER_SHOW_BINDING',
      'outputSessionId must identify one exact active Show session.'
    );
  }
  return value;
}

function exactUnlockToken(value, field = 'unlockToken') {
  if (typeof value !== 'string' || !UNLOCK_TOKEN_PATTERN.test(value)) {
    fail(
      'INVALID_VOLUNTEER_UNLOCK_AUTHORITY',
      `${field} must be an opaque random token.`,
      { field }
    );
  }
  return value;
}

function canonicalTimestamp(value, field) {
  if (typeof value !== 'string') {
    fail(
      'INVALID_VOLUNTEER_UNLOCK_GRANT',
      `${field} must be a canonical UTC timestamp.`,
      { field }
    );
  }
  const milliseconds = Date.parse(value);
  if (
    !Number.isFinite(milliseconds)
    || new Date(milliseconds).toISOString() !== value
  ) {
    fail(
      'INVALID_VOLUNTEER_UNLOCK_GRANT',
      `${field} must be a canonical UTC timestamp.`,
      { field }
    );
  }
  return { value, milliseconds };
}

function exactNow(value) {
  const milliseconds = value instanceof Date
    ? value.getTime()
    : typeof value === 'string'
      ? Date.parse(value)
      : value;
  if (!Number.isFinite(milliseconds)) {
    fail(
      'INVALID_VOLUNTEER_UNLOCK_TIME',
      'A valid current time is required to use volunteer unlock authority.'
    );
  }
  return milliseconds;
}

function normalizeVolunteerShowMode(rawMode) {
  const mode = rawMode === undefined || rawMode === null || rawMode === ''
    ? 'full'
    : rawMode;
  if (typeof mode !== 'string' || !VOLUNTEER_SHOW_MODES.includes(mode)) {
    fail(
      'INVALID_VOLUNTEER_SHOW_MODE',
      'Show control mode must be full or volunteer.',
      { mode: typeof mode === 'string' ? mode : null }
    );
  }
  return mode;
}

function normalizeOperatorAuthority(rawAuthority) {
  if (
    rawAuthority === undefined
    || rawAuthority === null
    || rawAuthority === 'locked'
  ) {
    return Object.freeze({ state: 'locked' });
  }
  if (rawAuthority === 'unlocked') {
    fail(
      'INVALID_VOLUNTEER_UNLOCK_AUTHORITY',
      'Unlocked operator authority requires an opaque unlock token.'
    );
  }
  if (!isPlainRecord(rawAuthority)) {
    fail(
      'INVALID_VOLUNTEER_UNLOCK_AUTHORITY',
      'Operator authority must be locked or an explicit unlock authority.'
    );
  }
  const stateDescriptor = Object.getOwnPropertyDescriptor(rawAuthority, 'state');
  if (!stateDescriptor
    || !Object.prototype.hasOwnProperty.call(stateDescriptor, 'value')) {
    fail(
      'INVALID_VOLUNTEER_UNLOCK_AUTHORITY',
      'Operator authority state must be an own data property.'
    );
  }
  const state = stateDescriptor.value;
  if (state === 'locked') {
    requireExactDataProperties(
      rawAuthority,
      ['state'],
      'Locked operator authority',
      'INVALID_VOLUNTEER_UNLOCK_AUTHORITY'
    );
    return Object.freeze({ state: 'locked' });
  }
  if (state !== 'unlocked') {
    fail(
      'INVALID_VOLUNTEER_UNLOCK_AUTHORITY',
      'Operator authority must be locked or unlocked.'
    );
  }
  requireExactDataProperties(
    rawAuthority,
    ['state', 'unlockToken'],
    'Unlocked operator authority',
    'INVALID_VOLUNTEER_UNLOCK_AUTHORITY'
  );
  return Object.freeze({
    state: 'unlocked',
    unlockToken: exactUnlockToken(rawAuthority.unlockToken)
  });
}

function normalizeVolunteerShowBinding(rawBinding) {
  requireExactDataProperties(
    rawBinding,
    BINDING_KEYS,
    'Volunteer Show binding',
    'INVALID_VOLUNTEER_SHOW_BINDING'
  );
  return Object.freeze({
    showId: exactId(rawBinding.showId, 'showId'),
    showFingerprint: exactFingerprint(
      rawBinding.showFingerprint,
      'showFingerprint'
    ),
    venueProfileId: exactId(rawBinding.venueProfileId, 'venueProfileId'),
    venueFingerprint: exactFingerprint(
      rawBinding.venueFingerprint,
      'venueFingerprint'
    ),
    outputSessionId: exactOutputSessionId(rawBinding.outputSessionId)
  });
}

function sameVolunteerShowBinding(left, right) {
  let normalizedLeft;
  let normalizedRight;
  try {
    normalizedLeft = normalizeVolunteerShowBinding(left);
    normalizedRight = normalizeVolunteerShowBinding(right);
  } catch (_error) {
    return false;
  }
  return BINDING_KEYS.every(key => normalizedLeft[key] === normalizedRight[key]);
}

function normalizeVolunteerShowUnlockGrant(rawGrant) {
  requireExactDataProperties(
    rawGrant,
    GRANT_KEYS,
    'Volunteer unlock grant',
    'INVALID_VOLUNTEER_UNLOCK_GRANT'
  );
  if (
    rawGrant.schemaVersion !== VOLUNTEER_UNLOCK_GRANT_SCHEMA_VERSION
    || rawGrant.kind !== VOLUNTEER_UNLOCK_GRANT_KIND
  ) {
    fail(
      'INVALID_VOLUNTEER_UNLOCK_GRANT',
      'Volunteer unlock grant version or kind is unsupported.'
    );
  }
  let token;
  try {
    token = exactUnlockToken(rawGrant.token, 'token');
  } catch (error) {
    if (error instanceof VolunteerShowPolicyError) {
      fail('INVALID_VOLUNTEER_UNLOCK_GRANT', 'Volunteer unlock grant token is invalid.');
    }
    throw error;
  }
  const issuedAt = canonicalTimestamp(rawGrant.issuedAt, 'issuedAt');
  const expiresAt = canonicalTimestamp(rawGrant.expiresAt, 'expiresAt');
  const ttl = expiresAt.milliseconds - issuedAt.milliseconds;
  if (ttl <= 0 || ttl > MAX_VOLUNTEER_UNLOCK_TTL_MS) {
    fail(
      'INVALID_VOLUNTEER_UNLOCK_GRANT',
      `Volunteer unlock grants must expire within ${MAX_VOLUNTEER_UNLOCK_TTL_MS / 60000} minutes.`
    );
  }
  let binding;
  try {
    binding = normalizeVolunteerShowBinding(rawGrant.binding);
  } catch (error) {
    if (error instanceof VolunteerShowPolicyError) {
      fail(
        'INVALID_VOLUNTEER_UNLOCK_GRANT',
        'Volunteer unlock grant Show binding is invalid.'
      );
    }
    throw error;
  }
  return deepFreeze({
    schemaVersion: VOLUNTEER_UNLOCK_GRANT_SCHEMA_VERSION,
    kind: VOLUNTEER_UNLOCK_GRANT_KIND,
    token,
    binding,
    issuedAt: issuedAt.value,
    expiresAt: expiresAt.value
  });
}

/**
 * The caller supplies the random token and timestamps so this domain policy
 * remains deterministic and side-effect free. The complete grant stays on the
 * trusted side; only authorityForVolunteerShowUnlockGrant(grant) should cross
 * an untrusted UI or Remote boundary.
 */
function createVolunteerShowUnlockGrant(rawRequest = {}) {
  requireExactDataProperties(
    rawRequest,
    ['binding', 'confirmed', 'expiresAt', 'issuedAt', 'token'],
    'Volunteer unlock request',
    'INVALID_VOLUNTEER_UNLOCK_GRANT'
  );
  const {
    confirmed,
    token,
    binding,
    issuedAt,
    expiresAt
  } = rawRequest;
  if (confirmed !== true) {
    fail(
      'VOLUNTEER_UNLOCK_NOT_CONFIRMED',
      'Unlocking volunteer Show controls requires an explicit confirmation.'
    );
  }
  return normalizeVolunteerShowUnlockGrant({
    schemaVersion: VOLUNTEER_UNLOCK_GRANT_SCHEMA_VERSION,
    kind: VOLUNTEER_UNLOCK_GRANT_KIND,
    token,
    binding,
    issuedAt,
    expiresAt
  });
}

function authorityForVolunteerShowUnlockGrant(rawGrant) {
  const grant = normalizeVolunteerShowUnlockGrant(rawGrant);
  return Object.freeze({
    state: 'unlocked',
    unlockToken: grant.token
  });
}

function classifyShowCommand(rawCommand = {}) {
  requireExactDataProperties(
    rawCommand,
    ['source', 'type'],
    'Show command classification',
    'INVALID_SHOW_COMMAND'
  );
  const { source, type } = rawCommand;
  if (!SHOW_COMMAND_SOURCES.includes(source)) {
    fail(
      'INVALID_SHOW_COMMAND_SOURCE',
      'Show commands must come from the local controller or Remote Control.',
      { source: typeof source === 'string' ? source : null }
    );
  }
  if (typeof type !== 'string') {
    fail('UNSUPPORTED_SHOW_COMMAND', 'Show command type is invalid.');
  }
  const classification = (source === 'local' ? LOCAL_COMMANDS : REMOTE_COMMANDS)[type];
  if (!classification) {
    fail(
      'UNSUPPORTED_SHOW_COMMAND',
      `The ${source} Show command is not part of the volunteer policy.`,
      { source, type }
    );
  }
  return Object.freeze({
    source,
    type,
    classification,
    requiresUnlock:
      classification === SHOW_COMMAND_CLASSIFICATIONS.PRIVILEGED
  });
}

function sameOpaqueToken(left, right) {
  if (
    typeof left !== 'string'
    || typeof right !== 'string'
    || Buffer.byteLength(left) !== Buffer.byteLength(right)
  ) {
    return false;
  }
  return crypto.timingSafeEqual(Buffer.from(left), Buffer.from(right));
}

function requireValidUnlock({
  authority,
  unlockGrant,
  binding,
  now
}) {
  if (authority.state !== 'unlocked') {
    fail(
      'VOLUNTEER_COMMAND_LOCKED',
      'That Show command requires an explicit operator unlock.'
    );
  }
  if (!unlockGrant) {
    fail(
      'VOLUNTEER_UNLOCK_GRANT_REQUIRED',
      'That Show command requires the trusted unlock grant.'
    );
  }
  const grant = normalizeVolunteerShowUnlockGrant(unlockGrant);
  const currentBinding = normalizeVolunteerShowBinding(binding);
  if (
    !sameOpaqueToken(authority.unlockToken, grant.token)
    || !sameVolunteerShowBinding(grant.binding, currentBinding)
  ) {
    fail(
      'VOLUNTEER_UNLOCK_GRANT_MISMATCH',
      'The unlock authority belongs to another Show, venue, or output session.'
    );
  }
  const currentTime = exactNow(now);
  const issuedAt = Date.parse(grant.issuedAt);
  const expiresAt = Date.parse(grant.expiresAt);
  if (currentTime < issuedAt) {
    fail(
      'VOLUNTEER_UNLOCK_GRANT_NOT_ACTIVE',
      'The volunteer unlock grant is not active yet.'
    );
  }
  if (currentTime >= expiresAt) {
    fail(
      'VOLUNTEER_UNLOCK_GRANT_EXPIRED',
      'The volunteer unlock grant expired.'
    );
  }
  return grant;
}

function authorizeVolunteerShowCommand(rawRequest = {}) {
  requireAllowedDataProperties(
    rawRequest,
    [
      'authority',
      'binding',
      'mode',
      'now',
      'source',
      'type',
      'unlockGrant'
    ],
    ['source', 'type'],
    'Volunteer Show authorization',
    'INVALID_SHOW_AUTHORIZATION'
  );
  const {
    mode: rawMode,
    authority: rawAuthority,
    source,
    type,
    binding = null,
    unlockGrant = null,
    now = null
  } = rawRequest;
  const mode = normalizeVolunteerShowMode(rawMode);
  const authority = normalizeOperatorAuthority(rawAuthority);
  const command = classifyShowCommand({ source, type });

  if (
    mode === 'full'
    || command.classification !== SHOW_COMMAND_CLASSIFICATIONS.PRIVILEGED
  ) {
    return deepFreeze({
      allowed: true,
      mode,
      authority: authority.state,
      command,
      unlockUsed: false
    });
  }

  requireValidUnlock({
    authority,
    unlockGrant,
    binding,
    now
  });
  return deepFreeze({
    allowed: true,
    mode,
    authority: authority.state,
    command,
    unlockUsed: true
  });
}

module.exports = {
  LOCAL_COMMANDS,
  MAX_VOLUNTEER_UNLOCK_TTL_MS,
  OPERATOR_AUTHORITY_STATES,
  REMOTE_COMMANDS,
  SHOW_COMMAND_CLASSIFICATIONS,
  SHOW_COMMAND_SOURCES,
  VOLUNTEER_SHOW_MODES,
  VOLUNTEER_UNLOCK_GRANT_KIND,
  VOLUNTEER_UNLOCK_GRANT_SCHEMA_VERSION,
  VolunteerShowPolicyError,
  authorityForVolunteerShowUnlockGrant,
  authorizeVolunteerShowCommand,
  classifyShowCommand,
  createVolunteerShowUnlockGrant,
  normalizeOperatorAuthority,
  normalizeVolunteerShowBinding,
  normalizeVolunteerShowMode,
  normalizeVolunteerShowUnlockGrant,
  sameVolunteerShowBinding
};
