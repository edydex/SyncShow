'use strict';

/** Compute state from the destination, so skipping over a cue is well-defined. */
function translationIntent(cues, index) {
  if (!Number.isInteger(index) || index < 0 || index >= cues.length) return null;
  let start = null;
  for (let position = 0; position <= index; position++) {
    const cue = cues[position];
    if (cue.translationAction === 'start') start = cue;
    else if (cue.translationAction === 'stop') start = null;
  }
  if (start) return { phase: 'live', segmentId: start.id, ...(start.translationSettings ? {settings:start.translationSettings}: {}) };
  const next = cues[index + 1];
  if (next?.translationAction === 'start') return { phase: 'prepare', segmentId: next.id, ...(next.translationSettings ? {settings:next.translationSettings}: {}) };
  return null;
}

class SlideTranslationCues {
  constructor({ send, resolve, changed }) {
    this.send = send; this.resolve = resolve; this.changed = changed;
    this.sequence = 0; this.last = null; this.status = { phase: 'idle' };
    this.stopCommand = null; this.stopPending = null;
  }
  report(status) { this.status = status; this.changed(); }
  async navigate(presentation, index) {
    const generation = ++this.sequence;
    const cues = presentation?.translationCues || [];
    const intent = translationIntent(cues, index);
    if (!intent) { await this.stop().catch(() => {}); return; }
    try {
      await this.flushStop();
      if (generation !== this.sequence) return;
      const binding = await this.resolve(presentation);
      if (generation !== this.sequence) return;
      const command = { ...binding, ...intent };
      if (JSON.stringify(command) === JSON.stringify(this.last) && this.status.phase !== 'error') return;
      this.last = command;
      this.report({ phase: intent.phase === 'prepare' ? 'preparing' : 'starting' });
      await this.send(command);
    } catch (error) {
      if (generation === this.sequence) this.report({ phase: 'error', message: error.message });
    }
  }
  stop() {
    ++this.sequence;
    if (this.last) this.stopCommand = { ...this.last, phase: 'idle' };
    this.last = null;
    return this.flushStop();
  }
  flushStop() {
    if (this.stopPending) return this.stopPending;
    if (!this.stopCommand) return Promise.resolve();
    const command = this.stopCommand;
    this.report({ phase: 'stopping' });
    this.stopPending = Promise.resolve().then(() => this.send(command)).then(() => {
      this.stopCommand = null;
      this.report({ phase: 'idle' });
    }).catch(error => {
      this.report({ phase: 'error', message: error.message });
      throw error;
    }).finally(() => { this.stopPending = null; });
    return this.stopPending;
  }
}
module.exports = { translationIntent, SlideTranslationCues };
