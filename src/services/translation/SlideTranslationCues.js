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
  if (start) return { phase: 'live', segmentId: start.id };
  const next = cues[index + 1];
  if (next?.translationAction === 'start') return { phase: 'prepare', segmentId: next.id };
  return null;
}

class SlideTranslationCues {
  constructor({ send, resolve, changed }) {
    this.send = send; this.resolve = resolve; this.changed = changed;
    this.sequence = 0; this.last = null; this.status = { phase: 'idle' };
  }
  report(status) { this.status = status; this.changed(); }
  async navigate(presentation, index) {
    const generation = ++this.sequence;
    const cues = presentation?.translationCues || [];
    const intent = translationIntent(cues, index);
    if (!intent) { this.stop(); return; }
    try {
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
    if (!this.last) return;
    const command = { ...this.last, phase: 'idle' };
    this.last = null;
    Promise.resolve(this.send(command)).catch(error => this.report({ phase: 'error', message: error.message }));
  }
}
module.exports = { translationIntent, SlideTranslationCues };
