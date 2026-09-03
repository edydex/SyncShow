'use strict';

const OUTPUT_HEALTH_STATUSES = Object.freeze({
  STARTING: 'starting',
  HEALTHY: 'healthy',
  UNAVAILABLE: 'unavailable'
});

function isValidSessionId(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

/**
 * Bounded, main-process-only health ledger for output renderers.
 *
 * A renderer is never considered healthy merely because its BrowserWindow is
 * visible. It must acknowledge the frame currently expected for the active
 * output session. Sender identity, the private numeric session ID, and the cue
 * index all have to match so a late renderer cannot make a replacement window
 * look healthy.
 */
class OutputHealthTracker {
  constructor({ maximumEntries = 32, onChange = null } = {}) {
    if (!Number.isSafeInteger(maximumEntries) || maximumEntries < 1 || maximumEntries > 256) {
      throw new TypeError('maximumEntries must be an integer between 1 and 256');
    }
    if (onChange !== null && typeof onChange !== 'function') {
      throw new TypeError('onChange must be a function');
    }
    this.maximumEntries = maximumEntries;
    this.onChange = onChange;
    this.entries = new Map();
    this.entriesBySender = new WeakMap();
  }

  clear() {
    this.entries.clear();
    // WeakMap has no clear operation. Replacing it also ensures a late IPC
    // event from the previous output session cannot find its former record.
    this.entriesBySender = new WeakMap();
  }

  register({ outputId, sessionId, sender }) {
    if (typeof outputId !== 'string' || outputId.length === 0) {
      throw new TypeError('outputId must be a non-empty string');
    }
    if (!isValidSessionId(sessionId)) {
      throw new TypeError('sessionId must be a non-negative safe integer');
    }
    if (!sender || (typeof sender !== 'object' && typeof sender !== 'function')) {
      throw new TypeError('sender must be an object');
    }

    if (this.entries.has(outputId)) this.entries.delete(outputId);
    while (this.entries.size >= this.maximumEntries) {
      this.entries.delete(this.entries.keys().next().value);
    }

    const entry = {
      outputId,
      sessionId,
      sender,
      expectedCueIndex: null,
      frameState: 'pending',
      unresponsive: false,
      processGone: false
    };
    this.entries.set(outputId, entry);
    this.entriesBySender.set(sender, entry);
    return this.read(outputId, sessionId, sender);
  }

  expectFrame({ outputId, sessionId, sender, cueIndex }) {
    if (!Number.isSafeInteger(cueIndex) || cueIndex < 0) return false;
    const entry = this._find(outputId, sessionId, sender);
    if (!entry || entry.processGone) return false;
    const before = this._status(entry);
    entry.expectedCueIndex = cueIndex;
    entry.frameState = 'pending';
    this._notifyIfChanged(entry, before, 'frame-pending');
    return true;
  }

  acknowledge({ sender, sessionId, cueIndex, ok }) {
    if (!isValidSessionId(sessionId) || !Number.isSafeInteger(cueIndex) || cueIndex < 0) {
      return false;
    }
    const entry = this.entriesBySender.get(sender);
    if (!entry
      || this.entries.get(entry.outputId) !== entry
      || entry.sessionId !== sessionId
      || entry.sender !== sender
      || entry.processGone
      || entry.expectedCueIndex !== cueIndex
      || (ok !== true && ok !== false)) {
      return false;
    }

    const before = this._status(entry);
    entry.frameState = ok ? 'ready' : 'failed';
    this._notifyIfChanged(entry, before, ok ? 'frame-ready' : 'frame-failed');
    return true;
  }

  markCleared({ outputId, sessionId, sender }) {
    const entry = this._find(outputId, sessionId, sender);
    if (!entry || this._status(entry) === OUTPUT_HEALTH_STATUSES.UNAVAILABLE) {
      return false;
    }
    const before = this._status(entry);
    entry.expectedCueIndex = null;
    entry.frameState = 'ready';
    this._notifyIfChanged(entry, before, 'output-cleared');
    return true;
  }

  markUnresponsive({ outputId, sessionId, sender }) {
    const entry = this._find(outputId, sessionId, sender);
    if (!entry || entry.processGone) return false;
    const before = this._status(entry);
    entry.unresponsive = true;
    this._notifyIfChanged(entry, before, 'renderer-unresponsive');
    return true;
  }

  markResponsive({ outputId, sessionId, sender }) {
    const entry = this._find(outputId, sessionId, sender);
    if (!entry || entry.processGone) return false;
    const before = this._status(entry);
    entry.unresponsive = false;
    this._notifyIfChanged(entry, before, 'renderer-responsive');
    return true;
  }

  markProcessGone({ outputId, sessionId, sender }) {
    const entry = this._find(outputId, sessionId, sender);
    if (!entry) return false;
    const before = this._status(entry);
    entry.processGone = true;
    this._notifyIfChanged(entry, before, 'renderer-process-gone');
    return true;
  }

  read(outputId, sessionId, sender = null) {
    const entry = this._find(outputId, sessionId, sender);
    if (!entry) return null;
    return Object.freeze({
      status: this._status(entry),
      expectedCueIndex: entry.expectedCueIndex
    });
  }

  _find(outputId, sessionId, sender) {
    if (typeof outputId !== 'string' || !isValidSessionId(sessionId)) return null;
    const entry = this.entries.get(outputId);
    if (!entry || entry.sessionId !== sessionId) return null;
    if (sender !== null && entry.sender !== sender) return null;
    return entry;
  }

  _status(entry) {
    if (entry.processGone || entry.unresponsive || entry.frameState === 'failed') {
      return OUTPUT_HEALTH_STATUSES.UNAVAILABLE;
    }
    if (entry.frameState === 'ready') return OUTPUT_HEALTH_STATUSES.HEALTHY;
    return OUTPUT_HEALTH_STATUSES.STARTING;
  }

  _notifyIfChanged(entry, before, reason) {
    const status = this._status(entry);
    if (status === before || !this.onChange) return;
    this.onChange(Object.freeze({
      outputId: entry.outputId,
      sessionId: entry.sessionId,
      status,
      reason
    }));
  }
}

module.exports = {
  OUTPUT_HEALTH_STATUSES,
  OutputHealthTracker
};
