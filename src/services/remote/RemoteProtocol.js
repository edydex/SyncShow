'use strict';

const crypto = require('crypto');

const PROTOCOL_VERSION = 1;
const COOKIE_NAME = 'syncshow_remote';
const PAIR_TICKET_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const PAIR_CODE_PATTERN = /^\d{6}$/;
const OUTPUT_SESSION_PATTERN = /^[A-Za-z0-9:._-]{1,64}$/;
const COMMAND_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const REMOTE_PHASES = new Set([
  'idle',
  'live',
  'cleared',
  'hidden',
  'interrupted'
]);
const OUTPUT_STATUS_VALUES = new Set([
  'healthy',
  'starting',
  'unavailable',
  'hidden',
  'cleared'
]);
const COMMAND_TYPES = new Set([
  'cue.previous',
  'cue.next',
  'cue.jump',
  'output.restore',
  'output.clear'
]);

class RemoteProtocolError extends Error {
  constructor(code, message, status = 400, details = null) {
    super(message);
    this.name = 'RemoteProtocolError';
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function requirePlainObject(value, label) {
  if (!isPlainObject(value)) {
    throw new RemoteProtocolError('INVALID_REQUEST', `${label} must be an object`);
  }
  return value;
}

function requireExactKeys(value, allowedKeys, requiredKeys, label) {
  const keys = Object.keys(value);
  const allowed = new Set(allowedKeys);
  const unknown = keys.find(key => !allowed.has(key));
  if (unknown) {
    throw new RemoteProtocolError('UNKNOWN_FIELD', `${label} contains an unsupported field`);
  }
  const missing = requiredKeys.find(key => !Object.hasOwn(value, key));
  if (missing) {
    throw new RemoteProtocolError('MISSING_FIELD', `${label} is missing ${missing}`);
  }
}

function requireVersion(value) {
  if (value !== PROTOCOL_VERSION) {
    throw new RemoteProtocolError(
      'UNSUPPORTED_PROTOCOL',
      `Remote protocol version ${PROTOCOL_VERSION} is required`
    );
  }
}

function countCodePoints(value) {
  return Array.from(value).length;
}

function requireText(value, label, { min = 1, max = 128, pattern = null } = {}) {
  if (typeof value !== 'string') {
    throw new RemoteProtocolError('INVALID_FIELD', `${label} must be text`);
  }
  const length = countCodePoints(value);
  if (length < min || length > max || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new RemoteProtocolError('INVALID_FIELD', `${label} is not valid`);
  }
  if (pattern && !pattern.test(value)) {
    throw new RemoteProtocolError('INVALID_FIELD', `${label} is not valid`);
  }
  return value;
}

function requireSafeInteger(value, label, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new RemoteProtocolError('INVALID_FIELD', `${label} must be a safe integer`);
  }
  return value;
}

function normalizeOutputSessionId(value) {
  const normalized = typeof value === 'number' && Number.isSafeInteger(value)
    ? String(value)
    : value;
  return requireText(normalized, 'outputSessionId', {
    max: 64,
    pattern: OUTPUT_SESSION_PATTERN
  });
}

function parsePairRequest(value) {
  const request = requirePlainObject(value, 'Pair request');
  requireExactKeys(
    request,
    ['version', 'deviceName', 'ticket', 'code'],
    ['version', 'deviceName'],
    'Pair request'
  );
  requireVersion(request.version);

  if (typeof request.deviceName !== 'string') {
    throw new RemoteProtocolError('INVALID_FIELD', 'deviceName must be text');
  }
  const deviceName = requireText(request.deviceName.trim(), 'deviceName', { max: 48 });
  const hasTicket = Object.hasOwn(request, 'ticket');
  const hasCode = Object.hasOwn(request, 'code');
  if (hasTicket === hasCode) {
    throw new RemoteProtocolError(
      'INVALID_PAIR_CREDENTIAL',
      'Provide either the QR ticket or the short code'
    );
  }

  if (hasTicket) {
    return {
      version: PROTOCOL_VERSION,
      deviceName,
      ticket: requireText(request.ticket, 'ticket', {
        min: 43,
        max: 43,
        pattern: PAIR_TICKET_PATTERN
      })
    };
  }

  return {
    version: PROTOCOL_VERSION,
    deviceName,
    code: requireText(request.code, 'code', {
      min: 6,
      max: 6,
      pattern: PAIR_CODE_PATTERN
    })
  };
}

function parseCommand(value) {
  const command = requirePlainObject(value, 'command');
  if (typeof command.type !== 'string' || !COMMAND_TYPES.has(command.type)) {
    throw new RemoteProtocolError('COMMAND_NOT_ALLOWED', 'That remote command is not allowed', 403);
  }

  if (command.type === 'cue.jump') {
    requireExactKeys(command, ['type', 'cueIndex'], ['type', 'cueIndex'], 'command');
    return {
      type: command.type,
      cueIndex: requireSafeInteger(command.cueIndex, 'cueIndex', { max: 100000 })
    };
  }

  requireExactKeys(command, ['type'], ['type'], 'command');
  return { type: command.type };
}

function parseCommandEnvelope(value) {
  const envelope = requirePlainObject(value, 'Command request');
  requireExactKeys(
    envelope,
    [
      'version',
      'outputSessionId',
      'sequence',
      'commandId',
      'expectedRevision',
      'expectedCueIndex',
      'command'
    ],
    [
      'version',
      'outputSessionId',
      'sequence',
      'commandId',
      'expectedRevision',
      'expectedCueIndex',
      'command'
    ],
    'Command request'
  );
  requireVersion(envelope.version);

  const expectedCueIndex = envelope.expectedCueIndex === null
    ? null
    : requireSafeInteger(envelope.expectedCueIndex, 'expectedCueIndex', { max: 100000 });
  const command = parseCommand(envelope.command);
  if ((command.type === 'cue.previous' || command.type === 'cue.next')
    && expectedCueIndex === null) {
    throw new RemoteProtocolError(
      'INVALID_FIELD',
      'expectedCueIndex is required for relative cue commands'
    );
  }
  if (command.type !== 'cue.previous'
    && command.type !== 'cue.next'
    && expectedCueIndex !== null) {
    throw new RemoteProtocolError(
      'INVALID_FIELD',
      'expectedCueIndex must be null for non-relative commands'
    );
  }

  return {
    version: PROTOCOL_VERSION,
    outputSessionId: normalizeOutputSessionId(envelope.outputSessionId),
    sequence: requireSafeInteger(envelope.sequence, 'sequence', { min: 1 }),
    commandId: requireText(envelope.commandId, 'commandId', {
      min: 36,
      max: 36,
      pattern: COMMAND_ID_PATTERN
    }).toLowerCase(),
    expectedRevision: requireSafeInteger(envelope.expectedRevision, 'expectedRevision'),
    expectedCueIndex,
    command
  };
}

function commandFingerprint(envelope) {
  const canonical = JSON.stringify([
    envelope.version,
    envelope.outputSessionId,
    envelope.sequence,
    envelope.commandId,
    envelope.expectedRevision,
    envelope.expectedCueIndex,
    envelope.command.type,
    envelope.command.type === 'cue.jump' ? envelope.command.cueIndex : null
  ]);
  return crypto.createHash('sha256').update(canonical, 'utf8').digest('base64url');
}

function cleanStateText(value, max) {
  if (typeof value !== 'string') return '';
  const withoutControls = value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, '');
  return Array.from(withoutControls).slice(0, max).join('');
}

function sanitizeCue(value) {
  if (!isPlainObject(value) || !Number.isSafeInteger(value.index) || value.index < 0) return null;
  const thumbnailUrl = typeof value.thumbnailUrl === 'string'
    && value.thumbnailUrl.startsWith('/api/v1/')
    && !value.thumbnailUrl.includes('\\')
    && value.thumbnailUrl.length <= 512
    ? value.thumbnailUrl
    : null;
  return {
    id: cleanStateText(value.id, 80) || `cue-${value.index + 1}`,
    index: value.index,
    number: Number.isSafeInteger(value.number) && value.number > 0
      ? value.number
      : value.index + 1,
    label: cleanStateText(value.label, 120) || `Cue ${value.index + 1}`,
    text: cleanStateText(value.text, 800),
    thumbnailAvailable: value.thumbnailAvailable === true,
    thumbnailUrl
  };
}

function sanitizeCueCatalog(value, totalCues) {
  if (!Array.isArray(value)) {
    throw new RemoteProtocolError('INVALID_GATEWAY_STATE', 'Show cue catalog is unavailable', 500);
  }
  const maximum = Number.isSafeInteger(totalCues) && totalCues >= 0
    ? Math.min(totalCues, 2000)
    : 2000;
  return value.slice(0, maximum).map(item => {
    const cue = sanitizeCue(item);
    if (!cue || cue.index >= maximum) return null;
    return {
      ...cue,
      text: cleanStateText(item.text, 240),
      thumbnailUrl: null
    };
  }).filter(Boolean);
}

function sanitizeOutput(value) {
  if (!isPlainObject(value)) return null;
  const id = cleanStateText(value.id, 64);
  const name = cleanStateText(value.name, 120);
  if (!id || !name || !OUTPUT_STATUS_VALUES.has(value.status)) return null;
  return {
    id,
    name,
    renderer: value.renderer === 'singer-current-next' ? 'singer-current-next' : 'slides',
    status: value.status,
    visible: value.visible === true
  };
}

function sanitizeRemoteState(value) {
  if (!isPlainObject(value)) {
    throw new RemoteProtocolError('INVALID_GATEWAY_STATE', 'Show state is unavailable', 500);
  }
  if (value.protocolVersion !== PROTOCOL_VERSION) {
    throw new RemoteProtocolError('INVALID_GATEWAY_STATE', 'Show protocol version is invalid', 500);
  }
  if (!Number.isSafeInteger(value.revision) || value.revision < 0) {
    throw new RemoteProtocolError('INVALID_GATEWAY_STATE', 'Show state revision is invalid', 500);
  }
  if (!REMOTE_PHASES.has(value.phase)) {
    throw new RemoteProtocolError('INVALID_GATEWAY_STATE', 'Show status is invalid', 500);
  }

  let outputSessionId;
  if (value.outputSessionId === null && value.phase === 'idle') {
    outputSessionId = null;
  } else {
    try {
      outputSessionId = normalizeOutputSessionId(value.outputSessionId);
    } catch (_error) {
      throw new RemoteProtocolError('INVALID_GATEWAY_STATE', 'Show session is invalid', 500);
    }
  }

  const outputs = Array.isArray(value.outputs)
    ? value.outputs.slice(0, 32).map(sanitizeOutput).filter(Boolean)
    : [];
  const bible = isPlainObject(value.bible) ? value.bible : {};
  const controls = isPlainObject(value.controls) ? value.controls : {};
  const permissions = isPlainObject(value.permissions) ? value.permissions : {};

  const totalCues = Number.isSafeInteger(value.totalCues) && value.totalCues >= 0
    ? Math.min(value.totalCues, 100000)
    : 0;

  return {
    protocolVersion: PROTOCOL_VERSION,
    revision: value.revision,
    outputSessionId,
    phase: value.phase,
    profileName: cleanStateText(value.profileName, 120),
    currentCue: sanitizeCue(value.currentCue),
    nextCue: sanitizeCue(value.nextCue),
    totalCues,
    outputs,
    bible: {
      phase: bible.phase === 'preparing' || bible.phase === 'live' ? bible.phase : 'idle',
      reference: cleanStateText(bible.reference, 160),
      translationId: cleanStateText(bible.translationId, 40),
      targetOutputIds: Array.isArray(bible.targetOutputIds)
        ? bible.targetOutputIds
          .map(value => cleanStateText(value, 80))
          .filter(Boolean)
          .slice(0, 32)
        : []
    },
    controls: {
      canPrevious: controls.canPrevious === true,
      canNext: controls.canNext === true,
      canJump: controls.canJump === true,
      canRestore: controls.canRestore === true,
      canClear: controls.canClear === true
    },
    permissions: {
      canOpenBiblePicker: permissions.canOpenBiblePicker === true
    }
  };
}

module.exports = {
  COMMAND_TYPES,
  COMMAND_ID_PATTERN,
  COOKIE_NAME,
  OUTPUT_STATUS_VALUES,
  PAIR_CODE_PATTERN,
  PAIR_TICKET_PATTERN,
  PROTOCOL_VERSION,
  REMOTE_PHASES,
  RemoteProtocolError,
  commandFingerprint,
  isPlainObject,
  normalizeOutputSessionId,
  parseCommandEnvelope,
  parsePairRequest,
  sanitizeCueCatalog,
  sanitizeRemoteState
};
