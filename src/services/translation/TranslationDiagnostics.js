'use strict';
const fs = require('node:fs');
const path = require('node:path');

const WARNING_DELAY_MS = 7000;
const LOG_INTERVAL_MS = 15000;
const MAX_LOG_BYTES = 1024 * 1024;
const id = value => typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,128}$/.test(value) ? value : null;
const number = value => Number.isSafeInteger(value) && value >= 0 ? value : null;

/** Local, bounded operational metadata only: never captions, audio, URLs or errors. */
class TranslationDiagnostics {
  constructor({ directory, now = Date.now, maxBytes = MAX_LOG_BYTES }) {
    Object.assign(this, { directory, now, maxBytes });
    this.connectionLostAt = null;
    this.warning = false;
    this.signature = '';
    this.lastLoggedAt = -Infinity;
    this.renderedAt = new Map();
  }

  observe(state) {
    const phase = state.automation?.phase || 'idle';
    const interrupted = phase === 'live' && ['disconnected', 'connecting'].includes(state.status);
    if (!interrupted) this.connectionLostAt = null;
    else if (this.connectionLostAt === null) this.connectionLostAt = this.now();
    this.warning = interrupted && this.now() - this.connectionLostAt >= WARNING_DELAY_MS;
    const metadata = {
      sessionId: id(state.sessionId), status: id(state.status), phase: id(phase),
      connectionWarning: this.warning,
      outputs: (state.outputs || []).slice(0, 32).map(output => ({
        id: id(output.id), layout: id(output.layout), language: id(output.language), active: output.active === true
      }))
    };
    const signature = JSON.stringify(metadata);
    if (signature !== this.signature || (phase !== 'idle' && this.now() - this.lastLoggedAt >= LOG_INTERVAL_MS)) {
      this.signature = signature;
      this.lastLoggedAt = this.now();
      metadata.captions = ['en', 'ru'].map(language => {
        const latest = state.captions?.[language]?.at(-1);
        return { language, sequence: number(latest?.sequence), revision: number(latest?.revision),
          characters: typeof latest?.text === 'string' ? latest.text.length : 0 };
      });
      this.write('state', metadata);
    }
    return this.warning;
  }

  rendered(outputId, report) {
    if (!id(outputId) || !report || this.now() - (this.renderedAt.get(outputId) ?? -Infinity) < 5000) return;
    this.renderedAt.set(outputId, this.now());
    this.write('rendered', { outputId, sessionId: id(report.sessionId),
      sequence: number(report.sequence), revision: number(report.revision),
      characters: number(report.characters), visible: report.visible === true });
  }

  outputEvent(outputId, event) {
    if (id(outputId) && ['unresponsive', 'responsive', 'process-gone'].includes(event)) {
      this.write('output', { outputId, event });
    }
  }

  write(event, metadata) {
    try {
      const directory = typeof this.directory === 'function' ? this.directory() : this.directory;
      fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
      const file = path.join(directory, 'translation.jsonl');
      const line = JSON.stringify({ at: new Date(this.now()).toISOString(), event, ...metadata }) + '\n';
      if (fs.existsSync(file) && fs.statSync(file).size + Buffer.byteLength(line) > this.maxBytes) {
        fs.renameSync(file, path.join(directory, 'translation.previous.jsonl'));
      }
      fs.appendFileSync(file, line, { mode: 0o600 });
    } catch (_) { /* Diagnostics must never interrupt a live service. */ }
  }
}

module.exports = { TranslationDiagnostics, WARNING_DELAY_MS };
