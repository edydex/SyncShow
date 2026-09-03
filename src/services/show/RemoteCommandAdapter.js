'use strict';

const crypto = require('crypto');
const {
  authorizeVolunteerShowCommand,
  normalizeVolunteerShowMode
} = require('./VolunteerShowPolicy');

const COMMAND_TYPES = new Set([
  'cue.previous',
  'cue.next',
  'cue.jump',
  'output.restore',
  'output.clear'
]);

const SHOW_PHASES = new Set([
  'idle',
  'live',
  'cleared',
  'hidden',
  'interrupted'
]);

const OUTPUT_STATUSES = new Set([
  'healthy',
  'cleared',
  'hidden',
  'starting',
  'unavailable'
]);

class RemoteCommandError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'RemoteCommandError';
    this.code = code;
    this.details = details;
  }
}

function fail(code, message, details) {
  throw new RemoteCommandError(code, message, details);
}

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function boundedText(value, maximum = 800) {
  if (typeof value !== 'string') return '';
  const normalized = value.replace(/\s+/g, ' ').trim();
  return normalized.length > maximum ? `${normalized.slice(0, maximum - 1)}…` : normalized;
}

function sanitizeCue(cue, totalSlides) {
  if (!isRecord(cue) || !Number.isInteger(cue.index)) return null;
  if (cue.index < 0 || cue.index >= totalSlides) return null;
  const requestedId = typeof cue.id === 'string' ? cue.id : '';
  const stableId = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(requestedId)
    && !['__proto__', 'prototype', 'constructor'].includes(requestedId)
    ? requestedId
    : `cue-${cue.index + 1}`;
  return {
    id: stableId,
    index: cue.index,
    number: cue.index + 1,
    label: boundedText(cue.label || cue.text, 120) || `Cue ${cue.index + 1}`,
    text: boundedText(cue.text),
    thumbnailAvailable: cue.thumbnailAvailable === true
  };
}

function sanitizeBible(rawBible) {
  const bible = isRecord(rawBible) ? rawBible : {};
  const phase = bible.phase === 'preparing' || bible.phase === 'live'
    ? bible.phase
    : 'idle';
  return {
    phase,
    reference: phase === 'idle' ? '' : boundedText(bible.reference, 160),
    translationId: phase === 'idle' ? '' : boundedText(bible.translationId, 24),
    targetOutputIds: phase === 'idle' || !Array.isArray(bible.targetOutputIds)
      ? []
      : bible.targetOutputIds
        .filter(value => typeof value === 'string' && value.length > 0)
        .slice(0, 32)
  };
}

function sanitizeOutput(output) {
  if (!isRecord(output) || typeof output.id !== 'string' || output.id.length === 0) return null;
  return {
    id: boundedText(output.id, 80),
    name: boundedText(output.name || output.id, 120),
    renderer: output.renderer === 'singer-current-next' ? 'singer-current-next' : 'slides',
    status: OUTPUT_STATUSES.has(output.status) ? output.status : 'unavailable',
    visible: output.visible === true
  };
}

function sanitizeLocalOperatorState(rawOperator, hasSession) {
  const operator = isRecord(rawOperator) ? rawOperator : {};
  const mode = hasSession && operator.mode === 'volunteer'
    ? 'volunteer'
    : 'full';
  const authority = mode === 'volunteer' && operator.authority === 'unlocked'
    ? 'unlocked'
    : 'locked';
  const unlockExpiresAt =
    authority === 'unlocked'
    && typeof operator.unlockExpiresAt === 'string'
    && Number.isFinite(Date.parse(operator.unlockExpiresAt))
    && new Date(Date.parse(operator.unlockExpiresAt)).toISOString()
      === operator.unlockExpiresAt
      ? operator.unlockExpiresAt
      : null;
  const rawControls = hasSession && isRecord(operator.controls)
    ? operator.controls
    : {};
  const rawRehearsal = hasSession && isRecord(operator.rehearsal)
    ? operator.rehearsal
    : {};
  const rehearsalStatus = [
    'idle',
    'rehearsing',
    'ready',
    'not-required'
  ].includes(rawRehearsal.status)
    ? rawRehearsal.status
    : 'idle';
  return {
    mode,
    authority,
    unlockExpiresAt,
    rehearsal: {
      status: rehearsalStatus,
      currentCue: Number.isSafeInteger(rawRehearsal.currentCue)
        && rawRehearsal.currentCue >= 0
        ? rawRehearsal.currentCue
        : 0,
      totalCues: Number.isSafeInteger(rawRehearsal.totalCues)
        && rawRehearsal.totalCues >= 0
        ? rawRehearsal.totalCues
        : 0,
      persisted: rawRehearsal.persisted === true,
      reused: rawRehearsal.reused === true
    },
    controls: {
      canPrevious: rawControls.canPrevious === true,
      canNext: rawControls.canNext === true,
      canJump: rawControls.canJump === true,
      canRestore: rawControls.canRestore === true,
      canClear: rawControls.canClear === true,
      canStop: rawControls.canStop === true,
      canEndSession: rawControls.canEndSession === true,
      canShowBible: rawControls.canShowBible === true,
      canManageRemote: rawControls.canManageRemote === true
    }
  };
}

function cloneState(value) {
  return JSON.parse(JSON.stringify(value));
}

/**
 * Main-process boundary shared by the trusted local controller and the future
 * LAN transport. The transport never receives BrowserWindow objects, display
 * IDs, role IDs, cache paths, or other setup/admin state.
 */
class RemoteCommandAdapter {
  constructor({
    readRuntimeState,
    readCueCatalog,
    readCueThumbnail,
    readShowPolicyState = () => ({ mode: 'full' }),
    authorizeShowCommand = authorizeVolunteerShowCommand,
    commands = {},
    createSessionId
  } = {}) {
    if (typeof readRuntimeState !== 'function') {
      throw new TypeError('RemoteCommandAdapter requires readRuntimeState');
    }
    if (typeof readShowPolicyState !== 'function') {
      throw new TypeError('RemoteCommandAdapter requires readShowPolicyState to be a function');
    }
    if (typeof authorizeShowCommand !== 'function') {
      throw new TypeError('RemoteCommandAdapter requires authorizeShowCommand to be a function');
    }
    this.readRuntimeState = readRuntimeState;
    this.readCueCatalogSource = typeof readCueCatalog === 'function'
      ? readCueCatalog
      : () => this.readRuntimeState()?.cues;
    this.readCueThumbnailSource = typeof readCueThumbnail === 'function'
      ? readCueThumbnail
      : null;
    this.readShowPolicyState = readShowPolicyState;
    this.authorizeShowCommand = authorizeShowCommand;
    this.commands = commands;
    this.createSessionId = typeof createSessionId === 'function'
      ? createSessionId
      : () => crypto.randomUUID();
    this.publicSessionId = null;
    this.stateRevision = 0;
    this.listeners = new Set();
  }

  beginSession() {
    const nextId = this.createSessionId();
    if (typeof nextId !== 'string' || nextId.length < 16 || nextId.length > 128) {
      throw new Error('Remote output session IDs must be random non-empty strings');
    }
    this.publicSessionId = nextId;
    return this.publish('session-starting');
  }

  endSession(reason = 'session-ended') {
    if (this.publicSessionId === null) return this.getState();
    this.publicSessionId = null;
    return this.publish(reason);
  }

  getState() {
    const raw = this.readRuntimeState() || {};
    const totalSlides = Number.isInteger(raw.totalSlides) && raw.totalSlides > 0
      ? raw.totalSlides
      : 0;
    const currentIndex = totalSlides > 0 && Number.isInteger(raw.currentSlide)
      ? Math.max(0, Math.min(totalSlides - 1, raw.currentSlide))
      : null;
    const hasSession = this.publicSessionId !== null && raw.hasActiveShow === true;
    const outputs = hasSession && Array.isArray(raw.outputs)
      ? raw.outputs.map(sanitizeOutput).filter(Boolean).slice(0, 32)
      : [];
    const hasUnavailableOutput = outputs.some(output => output.status === 'unavailable');
    const hasPendingOutput = outputs.some(output => output.status === 'starting');
    const rawPhase = hasUnavailableOutput
      ? 'interrupted'
      : raw.phase === 'starting' || raw.phase === 'locally-stopped'
      ? 'hidden'
      : raw.phase;
    const phase = hasSession && SHOW_PHASES.has(rawPhase) ? rawPhase : 'idle';
    const bible = hasSession ? sanitizeBible(raw.bible) : sanitizeBible(null);
    const navigationPending = raw.navigationPending === true;
    const navigationAvailable = hasSession
      && (phase === 'live' || phase === 'cleared')
      && !navigationPending
      && !hasPendingOutput
      && bible.phase === 'idle';
    const outputActionsAvailable = hasSession && (phase === 'live' || phase === 'cleared');
    const outputRestoreAvailable = outputActionsAvailable
      && !navigationPending
      && !hasPendingOutput;
    const policyControls = this._policyControls();
    const localOperator = sanitizeLocalOperatorState(raw.operator, hasSession);
    const localPolicyControls = localOperator.controls;

    return {
      protocolVersion: 1,
      revision: this.stateRevision,
      outputSessionId: hasSession ? this.publicSessionId : null,
      phase,
      profileName: hasSession ? boundedText(raw.profileName, 120) : '',
      totalCues: hasSession ? totalSlides : 0,
      currentCue: hasSession ? sanitizeCue(raw.currentCue, totalSlides) : null,
      nextCue: hasSession ? sanitizeCue(raw.nextCue, totalSlides) : null,
      outputs,
      bible,
      operator: {
        ...localOperator,
        controls: {
          canPrevious:
            navigationAvailable
            && currentIndex > 0
            && localPolicyControls.canPrevious,
          canNext:
            navigationAvailable
            && currentIndex !== null
            && currentIndex < totalSlides - 1
            && localPolicyControls.canNext,
          canJump:
            navigationAvailable
            && totalSlides > 0
            && localPolicyControls.canJump,
          canRestore:
            outputRestoreAvailable
            && localPolicyControls.canRestore,
          canClear:
            outputActionsAvailable
            && localPolicyControls.canClear,
          canStop:
            hasSession
            && localPolicyControls.canStop,
          canEndSession:
            hasSession
            && localPolicyControls.canEndSession,
          canShowBible:
            hasSession
            && phase === 'live'
            && localPolicyControls.canShowBible,
          canManageRemote:
            hasSession
            && localPolicyControls.canManageRemote
        }
      },
      controls: {
        canPrevious:
          navigationAvailable
          && currentIndex > 0
          && policyControls.canPrevious,
        canNext:
          navigationAvailable
          && currentIndex !== null
          && currentIndex < totalSlides - 1
          && policyControls.canNext,
        canJump:
          navigationAvailable
          && totalSlides > 0
          && policyControls.canJump,
        canRestore: outputRestoreAvailable && policyControls.canRestore,
        canClear: outputActionsAvailable && policyControls.canClear
      },
      permissions: {
        canOpenBiblePicker: hasSession && raw.permissions?.canOpenBiblePicker === true
      }
    };
  }

  publish(reason = 'state-changed') {
    this.stateRevision += 1;
    const state = this.getState();
    const event = Object.freeze({ reason, state: cloneState(state) });
    const listeners = [...this.listeners];

    // A slow or broken UI/network subscriber must never delay slide timing.
    queueMicrotask(() => {
      for (const listener of listeners) {
        try {
          listener(event);
        } catch (error) {
          console.error('[ShowState] Subscriber failed:', error);
        }
      }
    });
    return state;
  }

  subscribe(listener) {
    if (typeof listener !== 'function') throw new TypeError('Show-state listener must be a function');
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  getCueCatalog(outputSessionId) {
    const before = this.getState();
    if (!before.outputSessionId || before.outputSessionId !== outputSessionId) {
      fail('STALE_OUTPUT_SESSION', 'That cue list belongs to an older Show.');
    }
    const rawCues = this.readCueCatalogSource();
    const cues = Array.isArray(rawCues)
      ? rawCues
        .map(cue => sanitizeCue(cue, before.totalCues))
        .filter(Boolean)
        .slice(0, 2000)
      : [];
    const after = this.getState();
    if (after.outputSessionId !== outputSessionId) {
      fail('OUTPUT_SESSION_REPLACED', 'The Show changed while loading the cue list.');
    }
    return cues;
  }

  async readCueThumbnail(outputSessionId, cueIndex) {
    const before = this.getState();
    if (!before.outputSessionId || before.outputSessionId !== outputSessionId) {
      fail('STALE_OUTPUT_SESSION', 'That cue belongs to an older Show.');
    }
    if (!Number.isInteger(cueIndex) || cueIndex < 0 || cueIndex >= before.totalCues) {
      fail('INVALID_CUE_INDEX', 'Choose a cue that exists in the active Show.');
    }
    if (!this.readCueThumbnailSource) {
      fail('THUMBNAIL_UNAVAILABLE', 'That cue preview is unavailable.');
    }

    const thumbnail = await this.readCueThumbnailSource(cueIndex);
    const after = this.getState();
    if (after.outputSessionId !== outputSessionId) {
      fail('OUTPUT_SESSION_REPLACED', 'The Show changed while loading that cue preview.');
    }
    return thumbnail;
  }

  async execute(envelope) {
    const command = this._validateEnvelope(envelope);
    const before = this.getState();

    if (!before.outputSessionId) {
      fail('NO_ACTIVE_SHOW', 'There is no active Show to control.');
    }
    if (envelope.outputSessionId !== before.outputSessionId) {
      fail('STALE_OUTPUT_SESSION', 'This command belongs to an older Show.', {
        requestedOutputSessionId: envelope.outputSessionId
      });
    }
    if (envelope.expectedRevision !== before.revision) {
      fail('STALE_SHOW_STATE', 'The Show changed before this command arrived. Refresh and try again.', {
        expectedRevision: envelope.expectedRevision,
        currentRevision: before.revision
      });
    }
    if (before.phase === 'hidden') {
      fail('SHOW_STOPPED_LOCALLY', 'The local operator stopped the outputs.');
    }
    if (before.phase === 'interrupted' || before.phase === 'idle') {
      fail('SHOW_NOT_CONTROLLABLE', 'The Show is not ready for remote control.', { phase: before.phase });
    }

    this._requirePolicyAuthorization(command.type);

    const isNavigation = command.type.startsWith('cue.');
    if (isNavigation && before.bible.phase !== 'idle') {
      fail('BIBLE_OVERLAY_ACTIVE', 'Return from the Bible passage before changing cues.');
    }
    if (isNavigation && command.type !== 'cue.jump') {
      if (!Number.isSafeInteger(envelope.expectedCueIndex)) {
        fail('INVALID_REMOTE_COMMAND', 'Relative navigation requires the expected current cue.');
      }
      if (before.currentCue?.index !== envelope.expectedCueIndex) {
        fail('STALE_CURRENT_CUE', 'The current cue changed before this command arrived.', {
          expectedCueIndex: envelope.expectedCueIndex,
          currentCueIndex: before.currentCue?.index ?? null
        });
      }
    }
    const currentCueIndex = before.currentCue?.index;
    if (
      command.type === 'cue.previous'
      && (!Number.isInteger(currentCueIndex) || currentCueIndex <= 0)
    ) {
      fail('AT_FIRST_CUE', 'The Show is already at the first cue.');
    }
    if (
      command.type === 'cue.next'
      && (
        !Number.isInteger(currentCueIndex)
        || currentCueIndex >= before.totalCues - 1
      )
    ) {
      fail('AT_LAST_CUE', 'The Show is already at the last cue.');
    }
    if (command.type === 'cue.jump') {
      if (!Number.isInteger(command.cueIndex) || command.cueIndex < 0 || command.cueIndex >= before.totalCues) {
        fail('INVALID_CUE_INDEX', 'Choose a cue that exists in the active Show.', {
          cueIndex: command.cueIndex,
          totalCues: before.totalCues
        });
      }
      if (before.currentCue?.index === command.cueIndex) {
        return { success: true, applied: false, state: before };
      }
    }

    const handlerName = {
      'cue.previous': 'previous',
      'cue.next': 'next',
      'cue.jump': 'jump',
      'output.restore': 'restore',
      'output.clear': 'clear'
    }[command.type];
    const handler = this.commands[handlerName];
    if (typeof handler !== 'function') {
      fail('COMMAND_UNAVAILABLE', 'That Show command is not available in this build.', {
        command: command.type
      });
    }

    const revisionBeforeCommand = this.stateRevision;
    const result = command.type === 'cue.jump'
      ? await handler(command.cueIndex)
      : await handler();
    if (this.publicSessionId !== envelope.outputSessionId) {
      fail('OUTPUT_SESSION_REPLACED', 'The Show was replaced while applying this command.');
    }
    if (result && result.accepted === false) {
      fail(result.code || 'COMMAND_REJECTED', result.message || 'The Show command was rejected.');
    }
    if (this.stateRevision === revisionBeforeCommand) this.publish(`remote:${command.type}`);

    return {
      success: true,
      applied: true,
      state: this.getState()
    };
  }

  _validateEnvelope(envelope) {
    if (!isRecord(envelope)) fail('INVALID_REMOTE_COMMAND', 'The remote command must be an object.');
    const allowedEnvelopeKeys = new Set([
      'protocolVersion',
      'outputSessionId',
      'expectedRevision',
      'expectedCueIndex',
      'command'
    ]);
    for (const key of Object.keys(envelope)) {
      if (!allowedEnvelopeKeys.has(key)) {
        fail('INVALID_REMOTE_COMMAND', `Unknown remote command field "${key}".`);
      }
    }
    if (envelope.protocolVersion !== 1) {
      fail('UNSUPPORTED_REMOTE_PROTOCOL', 'This remote protocol version is not supported.');
    }
    if (typeof envelope.outputSessionId !== 'string' || envelope.outputSessionId.length > 128) {
      fail('INVALID_REMOTE_COMMAND', 'The output session ID is invalid.');
    }
    if (!Number.isSafeInteger(envelope.expectedRevision) || envelope.expectedRevision < 0) {
      fail('INVALID_REMOTE_COMMAND', 'The expected Show revision is invalid.');
    }
    if (!isRecord(envelope.command)) {
      fail('INVALID_REMOTE_COMMAND', 'The remote command payload is invalid.');
    }

    const type = envelope.command.type;
    if (!COMMAND_TYPES.has(type)) {
      fail('FORBIDDEN_REMOTE_COMMAND', 'That operation is not available to Remote Control.', {
        command: type
      });
    }
    const allowedCommandKeys = type === 'cue.jump'
      ? new Set(['type', 'cueIndex'])
      : new Set(['type']);
    for (const key of Object.keys(envelope.command)) {
      if (!allowedCommandKeys.has(key)) {
        fail('INVALID_REMOTE_COMMAND', `Unknown field "${key}" for ${type}.`);
      }
    }
    if (type === 'cue.jump' && !Number.isSafeInteger(envelope.command.cueIndex)) {
      fail('INVALID_CUE_INDEX', 'The cue index must be an integer.');
    }
    if (type !== 'cue.previous' && type !== 'cue.next' && envelope.expectedCueIndex !== undefined) {
      fail('INVALID_REMOTE_COMMAND', 'Only relative navigation accepts expectedCueIndex.');
    }
    return { type, ...(type === 'cue.jump' ? { cueIndex: envelope.command.cueIndex } : {}) };
  }

  _readShowPolicyMode() {
    const policyState = this.readShowPolicyState();
    if (typeof policyState === 'string') {
      if (policyState.length === 0) {
        throw new TypeError('Show policy state must provide an explicit mode');
      }
      return normalizeVolunteerShowMode(policyState);
    }
    if (!isRecord(policyState)) {
      throw new TypeError('Show policy state must provide an explicit mode');
    }
    const descriptor = Object.getOwnPropertyDescriptor(policyState, 'mode');
    if (
      !descriptor
      || !Object.prototype.hasOwnProperty.call(descriptor, 'value')
      || descriptor.value === undefined
      || descriptor.value === null
      || descriptor.value === ''
    ) {
      throw new TypeError('Show policy state mode must be an own data property');
    }
    return normalizeVolunteerShowMode(descriptor.value);
  }

  _policyAllows(type, mode) {
    try {
      const decision = this.authorizeShowCommand(Object.freeze({
        mode,
        authority: 'locked',
        source: 'remote',
        type
      }));
      if (decision && typeof decision.then === 'function') {
        Promise.resolve(decision).catch(() => {});
        return false;
      }
      return Boolean(decision && decision.allowed === true);
    } catch (_error) {
      return false;
    }
  }

  _policyControls() {
    let mode;
    try {
      mode = this._readShowPolicyMode();
    } catch (_error) {
      return {
        canPrevious: false,
        canNext: false,
        canJump: false,
        canRestore: false,
        canClear: false
      };
    }
    return {
      canPrevious: this._policyAllows('cue.previous', mode),
      canNext: this._policyAllows('cue.next', mode),
      canJump: this._policyAllows('cue.jump', mode),
      canRestore: this._policyAllows('output.restore', mode),
      canClear: this._policyAllows('output.clear', mode)
    };
  }

  _requirePolicyAuthorization(type) {
    let mode;
    try {
      mode = this._readShowPolicyMode();
    } catch (_error) {
      fail(
        'COMMAND_FORBIDDEN_BY_SHOW_POLICY',
        'That Remote command is not allowed by the current Show control policy.',
        { command: type }
      );
    }
    if (!this._policyAllows(type, mode)) {
      fail(
        'COMMAND_FORBIDDEN_BY_SHOW_POLICY',
        'That Remote command is not allowed by the current Show control policy.',
        { command: type }
      );
    }
  }
}

module.exports = {
  COMMAND_TYPES,
  RemoteCommandAdapter,
  RemoteCommandError
};
