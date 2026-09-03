'use strict';

const LIVE_CUE_TRANSITION_KIND = 'syncshow-live-cue-transition';
const LIVE_CUE_TRANSITION_RECEIPT_KIND =
  'syncshow-live-cue-transition-receipt';
const LIVE_CUE_TRANSITION_SCHEMA_VERSION = 1;
const DEFAULT_LIVE_CUE_TRANSITION_TIMEOUT_MS = 15_000;
const MAX_LIVE_CUE_TRANSITION_TIMEOUT_MS = 60_000;
const MAX_LIVE_CUE_TRANSITION_OUTPUTS = 32;

const SAFE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const FORBIDDEN_IDS = new Set(['__proto__', 'prototype', 'constructor']);

class LiveCueTransitionError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'LiveCueTransitionError';
    this.code = code;
    this.details = Object.freeze({ ...details });
  }
}

function fail(code, message, details = {}) {
  throw new LiveCueTransitionError(code, message, details);
}

function isPlainRecord(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function safeInteger(value, field) {
  if (!Number.isSafeInteger(value) || value < 0) {
    fail(
      'INVALID_LIVE_CUE_TRANSITION',
      `${field} must be a non-negative safe integer.`,
      { field }
    );
  }
  return value;
}

function safeOutputId(value, index) {
  if (
    typeof value !== 'string'
    || !SAFE_ID_PATTERN.test(value)
    || FORBIDDEN_IDS.has(value)
  ) {
    fail(
      'INVALID_LIVE_CUE_TRANSITION',
      `outputs[${index}].outputId is invalid.`,
      { field: `outputs[${index}].outputId` }
    );
  }
  return value;
}

function normalizeTimeoutMs(value) {
  if (
    !Number.isSafeInteger(value)
    || value < 1
    || value > MAX_LIVE_CUE_TRANSITION_TIMEOUT_MS
  ) {
    fail(
      'INVALID_LIVE_CUE_TRANSITION_TIMEOUT',
      `Live cue transition timeout must be between 1 and ${MAX_LIVE_CUE_TRANSITION_TIMEOUT_MS} milliseconds.`,
      { timeoutMs: Number.isSafeInteger(value) ? value : null }
    );
  }
  return value;
}

function readClock(clock) {
  const value = clock();
  if (!Number.isFinite(value) || value < 0) {
    fail(
      'INVALID_LIVE_CUE_TRANSITION_TIME',
      'Live cue transition clock must return a non-negative finite millisecond value.'
    );
  }
  return value;
}

function normalizeOutputs(rawOutputs) {
  if (
    !Array.isArray(rawOutputs)
    || rawOutputs.length < 1
    || rawOutputs.length > MAX_LIVE_CUE_TRANSITION_OUTPUTS
  ) {
    fail(
      'INVALID_LIVE_CUE_TRANSITION',
      `A live cue transition requires between 1 and ${MAX_LIVE_CUE_TRANSITION_OUTPUTS} outputs.`,
      { outputCount: Array.isArray(rawOutputs) ? rawOutputs.length : null }
    );
  }

  const outputIds = new Set();
  const senders = new Set();
  return rawOutputs.map((rawOutput, index) => {
    if (!isPlainRecord(rawOutput)) {
      fail(
        'INVALID_LIVE_CUE_TRANSITION',
        `outputs[${index}] must be a plain object.`,
        { field: `outputs[${index}]` }
      );
    }
    const keys = Object.keys(rawOutput).sort();
    if (
      keys.length !== 2
      || keys[0] !== 'outputId'
      || keys[1] !== 'sender'
    ) {
      fail(
        'INVALID_LIVE_CUE_TRANSITION',
        `outputs[${index}] must contain exactly outputId and sender.`,
        { field: `outputs[${index}]`, fields: keys }
      );
    }

    const outputId = safeOutputId(rawOutput.outputId, index);
    const sender = rawOutput.sender;
    if (!sender || (typeof sender !== 'object' && typeof sender !== 'function')) {
      fail(
        'INVALID_LIVE_CUE_TRANSITION',
        `outputs[${index}].sender must be an object.`,
        { field: `outputs[${index}].sender` }
      );
    }
    if (outputIds.has(outputId)) {
      fail(
        'DUPLICATE_LIVE_CUE_OUTPUT',
        `Output "${outputId}" appears more than once in the transition.`,
        { outputId }
      );
    }
    if (senders.has(sender)) {
      fail(
        'DUPLICATE_LIVE_CUE_OUTPUT_SENDER',
        'Each live output must have a distinct sender identity.',
        { outputId }
      );
    }
    outputIds.add(outputId);
    senders.add(sender);
    return Object.freeze({ outputId, sender });
  });
}

function freezeTransition({
  sessionId,
  fromCueIndex,
  toCueIndex,
  outputs,
  startedAt,
  deadlineAt
}) {
  return Object.freeze({
    schemaVersion: LIVE_CUE_TRANSITION_SCHEMA_VERSION,
    kind: LIVE_CUE_TRANSITION_KIND,
    sessionId,
    fromCueIndex,
    toCueIndex,
    outputIds: Object.freeze(outputs.map(output => output.outputId)),
    startedAt,
    deadlineAt
  });
}

function normalizeFailureCode(value, fallback) {
  return typeof value === 'string' && /^[A-Z][A-Z0-9_]{2,95}$/.test(value)
    ? value
    : fallback;
}

function boundedReason(value, fallback) {
  if (typeof value !== 'string') return fallback;
  const reason = value.replace(/\s+/g, ' ').trim();
  if (!reason) return fallback;
  return reason.length <= 500 ? reason : `${reason.slice(0, 499)}…`;
}

class LiveCueTransitionCoordinator {
  constructor({
    timeoutMs = DEFAULT_LIVE_CUE_TRANSITION_TIMEOUT_MS,
    clock = Date.now,
    setTimer = setTimeout,
    clearTimer = clearTimeout
  } = {}) {
    if (typeof clock !== 'function') {
      throw new TypeError('LiveCueTransitionCoordinator clock must be a function');
    }
    if (typeof setTimer !== 'function' || typeof clearTimer !== 'function') {
      throw new TypeError('LiveCueTransitionCoordinator timers must be functions');
    }
    this.timeoutMs = normalizeTimeoutMs(timeoutMs);
    this.clock = clock;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.active = null;
  }

  begin(rawRequest = {}) {
    this._requireIdle();
    if (!isPlainRecord(rawRequest)) {
      fail(
        'INVALID_LIVE_CUE_TRANSITION',
        'Live cue transition request must be a plain object.'
      );
    }
    const keys = Object.keys(rawRequest).sort();
    const expectedKeys = [
      'fromCueIndex',
      'outputs',
      'sessionId',
      'toCueIndex'
    ];
    if (
      keys.length !== expectedKeys.length
      || keys.some((key, index) => key !== expectedKeys[index])
    ) {
      fail(
        'INVALID_LIVE_CUE_TRANSITION',
        'Live cue transition request contains unsupported or missing fields.',
        { fields: keys }
      );
    }

    const sessionId = safeInteger(rawRequest.sessionId, 'sessionId');
    const fromCueIndex = safeInteger(rawRequest.fromCueIndex, 'fromCueIndex');
    const toCueIndex = safeInteger(rawRequest.toCueIndex, 'toCueIndex');
    if (fromCueIndex === toCueIndex) {
      fail(
        'INVALID_LIVE_CUE_TRANSITION',
        'A live cue transition must move to a different cue.',
        { fromCueIndex, toCueIndex }
      );
    }
    return this._beginValidated({
      sessionId,
      fromCueIndex,
      toCueIndex,
      outputs: normalizeOutputs(rawRequest.outputs)
    });
  }

  beginRefresh(rawRequest = {}) {
    this._requireIdle();
    if (!isPlainRecord(rawRequest)) {
      fail(
        'INVALID_LIVE_CUE_TRANSITION',
        'Live cue refresh request must be a plain object.'
      );
    }
    const keys = Object.keys(rawRequest).sort();
    const expectedKeys = ['cueIndex', 'outputs', 'sessionId'];
    if (
      keys.length !== expectedKeys.length
      || keys.some((key, index) => key !== expectedKeys[index])
    ) {
      fail(
        'INVALID_LIVE_CUE_TRANSITION',
        'Live cue refresh request contains unsupported or missing fields.',
        { fields: keys }
      );
    }

    const sessionId = safeInteger(rawRequest.sessionId, 'sessionId');
    const cueIndex = safeInteger(rawRequest.cueIndex, 'cueIndex');
    return this._beginValidated({
      sessionId,
      fromCueIndex: cueIndex,
      toCueIndex: cueIndex,
      outputs: normalizeOutputs(rawRequest.outputs)
    });
  }

  _requireIdle() {
    if (this.active) {
      fail(
        'LIVE_CUE_TRANSITION_BUSY',
        'Wait for the current cue to reach every output before advancing again.',
        {
          sessionId: this.active.transition.sessionId,
          fromCueIndex: this.active.transition.fromCueIndex,
          toCueIndex: this.active.transition.toCueIndex
        }
      );
    }
  }

  _beginValidated({ sessionId, fromCueIndex, toCueIndex, outputs }) {
    const startedAt = readClock(this.clock);
    const deadlineAt = startedAt + this.timeoutMs;
    if (!Number.isSafeInteger(deadlineAt)) {
      fail(
        'INVALID_LIVE_CUE_TRANSITION_TIME',
        'Live cue transition deadline exceeds the supported time range.'
      );
    }
    const transition = freezeTransition({
      sessionId,
      fromCueIndex,
      toCueIndex,
      outputs,
      startedAt,
      deadlineAt
    });

    let resolvePromise;
    let rejectPromise;
    const promise = new Promise((resolve, reject) => {
      resolvePromise = resolve;
      rejectPromise = reject;
    });
    // Main normally awaits this promise immediately. The internal handler also
    // prevents a timer or synchronous cancellation from producing a process-
    // level unhandled rejection if a caller abandons the returned promise.
    promise.catch(() => {});

    const outputsBySender = new Map(outputs.map(output => [
      output.sender,
      {
        outputId: output.outputId,
        sender: output.sender,
        acknowledgedAt: null
      }
    ]));
    const active = {
      transition,
      outputs,
      outputsBySender,
      pendingCount: outputs.length,
      resolve: resolvePromise,
      reject: rejectPromise,
      timer: null
    };
    this.active = active;
    let timer;
    try {
      timer = this.setTimer(() => {
        if (this.active !== active) return;
        this._rejectActive(new LiveCueTransitionError(
          'LIVE_CUE_TRANSITION_TIMEOUT',
          `Cue ${toCueIndex + 1} did not reach every output within ${this.timeoutMs / 1000} seconds.`,
          {
            sessionId,
            fromCueIndex,
            toCueIndex,
            pendingOutputIds: Object.freeze(this._pendingOutputIds(active))
          }
        ));
      }, this.timeoutMs);
    } catch (error) {
      this.active = null;
      throw error;
    }
    if (this.active === active) active.timer = timer;
    else this.clearTimer(timer);

    return Object.freeze({ transition, promise });
  }

  acknowledge(rawAcknowledgement = {}) {
    const active = this.active;
    if (!active || !isPlainRecord(rawAcknowledgement)) return false;
    const {
      sender,
      sessionId,
      cueIndex,
      ok
    } = rawAcknowledgement;
    if (
      sessionId !== active.transition.sessionId
      || cueIndex !== active.transition.toCueIndex
      || (ok !== true && ok !== false)
    ) {
      return false;
    }
    const output = active.outputsBySender.get(sender);
    if (!output || output.acknowledgedAt !== null) return false;

    if (ok === false) {
      const reason = boundedReason(
        rawAcknowledgement.error,
        `${output.outputId} could not prepare cue ${cueIndex + 1}.`
      );
      this._rejectActive(new LiveCueTransitionError(
        'LIVE_CUE_OUTPUT_REJECTED',
        reason,
        {
          sessionId,
          outputId: output.outputId,
          cueIndex
        }
      ));
      return true;
    }

    let acknowledgedAt;
    try {
      acknowledgedAt = readClock(this.clock);
    } catch (error) {
      this._rejectActive(error);
      return true;
    }
    output.acknowledgedAt = acknowledgedAt;
    active.pendingCount -= 1;
    if (active.pendingCount === 0) this._resolveActive(active);
    return true;
  }

  outputFailed(rawFailure = {}) {
    const active = this.active;
    if (!active || !isPlainRecord(rawFailure)) return false;
    const {
      sessionId,
      outputId,
      sender
    } = rawFailure;
    if (sessionId !== active.transition.sessionId) return false;
    const output = active.outputsBySender.get(sender);
    if (
      !output
      || output.outputId !== outputId
    ) {
      return false;
    }
    const code = normalizeFailureCode(
      rawFailure.code,
      'LIVE_CUE_OUTPUT_FAILED'
    );
    const reason = boundedReason(
      rawFailure.reason,
      `${outputId} became unavailable while changing cues.`
    );
    this._rejectActive(new LiveCueTransitionError(code, reason, {
      sessionId,
      outputId,
      cueIndex: active.transition.toCueIndex
    }));
    return true;
  }

  cancel(reason = 'The live cue transition was cancelled.', code = 'LIVE_CUE_TRANSITION_CANCELLED') {
    if (!this.active) return false;
    const normalizedCode = normalizeFailureCode(
      code,
      'LIVE_CUE_TRANSITION_CANCELLED'
    );
    const normalizedReason = boundedReason(
      reason,
      'The live cue transition was cancelled.'
    );
    const transition = this.active.transition;
    this._rejectActive(new LiveCueTransitionError(
      normalizedCode,
      normalizedReason,
      {
        sessionId: transition.sessionId,
        fromCueIndex: transition.fromCueIndex,
        toCueIndex: transition.toCueIndex
      }
    ));
    return true;
  }

  isPending() {
    return this.active !== null;
  }

  read() {
    const active = this.active;
    if (!active) return null;
    return Object.freeze({
      ...active.transition,
      pendingOutputIds: Object.freeze(this._pendingOutputIds(active)),
      acknowledgedOutputIds: Object.freeze(
        active.outputs
          .filter(output => active.outputsBySender.get(output.sender).acknowledgedAt !== null)
          .map(output => output.outputId)
      )
    });
  }

  _pendingOutputIds(active) {
    return active.outputs
      .filter(output => active.outputsBySender.get(output.sender).acknowledgedAt === null)
      .map(output => output.outputId);
  }

  _resolveActive(active) {
    if (this.active !== active) return;
    let completedAt;
    try {
      completedAt = readClock(this.clock);
    } catch (error) {
      this._rejectActive(error);
      return;
    }
    const receipt = Object.freeze({
      schemaVersion: LIVE_CUE_TRANSITION_SCHEMA_VERSION,
      kind: LIVE_CUE_TRANSITION_RECEIPT_KIND,
      sessionId: active.transition.sessionId,
      fromCueIndex: active.transition.fromCueIndex,
      toCueIndex: active.transition.toCueIndex,
      outputIds: active.transition.outputIds,
      startedAt: active.transition.startedAt,
      completedAt
    });
    this._clearActive(active);
    active.resolve(receipt);
  }

  _rejectActive(error) {
    const active = this.active;
    if (!active) return;
    this._clearActive(active);
    active.reject(error);
  }

  _clearActive(active) {
    if (active.timer !== null) this.clearTimer(active.timer);
    active.timer = null;
    if (this.active === active) this.active = null;
  }
}

module.exports = {
  DEFAULT_LIVE_CUE_TRANSITION_TIMEOUT_MS,
  LIVE_CUE_TRANSITION_KIND,
  LIVE_CUE_TRANSITION_RECEIPT_KIND,
  LIVE_CUE_TRANSITION_SCHEMA_VERSION,
  MAX_LIVE_CUE_TRANSITION_OUTPUTS,
  MAX_LIVE_CUE_TRANSITION_TIMEOUT_MS,
  LiveCueTransitionCoordinator,
  LiveCueTransitionError
};
