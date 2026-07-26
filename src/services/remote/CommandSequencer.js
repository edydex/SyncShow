'use strict';

const { RemoteProtocolError } = require('./RemoteProtocol');

class CommandSequencer {
  constructor({ replayLimit = 64 } = {}) {
    if (!Number.isSafeInteger(replayLimit) || replayLimit < 1 || replayLimit > 1024) {
      throw new TypeError('Replay limit must be between 1 and 1024');
    }
    this.replayLimit = replayLimit;
    this.lastAccepted = 0;
    this.accepted = new Map();
    this.commandIds = new Map();
  }

  get nextSequence() {
    return this.lastAccepted < Number.MAX_SAFE_INTEGER
      ? this.lastAccepted + 1
      : null;
  }

  async dispatch({ envelope, fingerprint, precondition, execute, getState }) {
    if (!envelope || !Number.isSafeInteger(envelope.sequence)) {
      throw new TypeError('A parsed command envelope is required');
    }
    if (typeof fingerprint !== 'string' || fingerprint.length === 0) {
      throw new TypeError('A command fingerprint is required');
    }
    if (typeof precondition !== 'function'
      || typeof execute !== 'function'
      || typeof getState !== 'function') {
      throw new TypeError('Command dispatch callbacks are required');
    }

    if (envelope.sequence <= this.lastAccepted) {
      const previous = this.accepted.get(envelope.sequence);
      if (previous
        && previous.commandId === envelope.commandId
        && previous.fingerprint === fingerprint) {
        return {
          accepted: true,
          duplicate: true,
          applied: previous.applied,
          nextSequence: this.nextSequence,
          state: await getState()
        };
      }
      throw new RemoteProtocolError(
        'SEQUENCE_REPLAY',
        'That remote command sequence was already used',
        409,
        { nextSequence: this.nextSequence }
      );
    }

    if (this.nextSequence === null || envelope.sequence !== this.nextSequence) {
      throw new RemoteProtocolError(
        'SEQUENCE_GAP',
        'Remote commands must be sent in order',
        409,
        { nextSequence: this.nextSequence }
      );
    }

    const earlierSequence = this.commandIds.get(envelope.commandId);
    if (earlierSequence !== undefined) {
      throw new RemoteProtocolError(
        'COMMAND_ID_REUSED',
        'That remote command ID was already used',
        409,
        { nextSequence: this.nextSequence }
      );
    }

    await precondition();
    const result = await execute();
    const applied = result?.applied !== false;

    // Commit replay identity before obtaining the response snapshot. If state
    // serialization fails after the Show command succeeds, a retry must still
    // be recognized and must never apply the command twice.
    this.lastAccepted = envelope.sequence;
    this.accepted.set(envelope.sequence, {
      commandId: envelope.commandId,
      fingerprint,
      applied
    });
    this.commandIds.set(envelope.commandId, envelope.sequence);
    this._trimReplayHistory();

    return {
      accepted: true,
      duplicate: false,
      applied,
      nextSequence: this.nextSequence,
      state: await getState()
    };
  }

  _trimReplayHistory() {
    while (this.accepted.size > this.replayLimit) {
      const oldestSequence = this.accepted.keys().next().value;
      const oldest = this.accepted.get(oldestSequence);
      this.accepted.delete(oldestSequence);
      if (oldest && this.commandIds.get(oldest.commandId) === oldestSequence) {
        this.commandIds.delete(oldest.commandId);
      }
    }
  }
}

module.exports = { CommandSequencer };
