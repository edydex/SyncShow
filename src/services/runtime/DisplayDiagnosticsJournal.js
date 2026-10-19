'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { safeError } = require('./SupportDiagnostics');
const { matchOutputDisplay } = require('../../renderer/service-output-plan');

const MAX_EVENTS = 200;
const MAX_BYTES = 2 * 1024 * 1024;
const text = value => safeError({ message: String(value ?? '') }).message.slice(0, 180);
const number = value => Number.isFinite(value) ? value : null;
// Do not trust arbitrary strings from an old profile as diagnostic identity.
const fingerprint = value => /^display-v[12]:[a-z0-9:._-]+$/iu.test(value || '')
  ? String(value).slice(0, 240) : value ? '[legacy identity]' : null;
const bounds = value => Object.fromEntries(['x', 'y', 'width', 'height'].map(key => [key, number(value?.[key])]));

function sanitizeEvent(value) {
  const displays = (Array.isArray(value?.displays) ? value.displays : []).slice(0, 16).map(display => ({
    id: text(display.id), fingerprint: fingerprint(display.fingerprint),
    legacyFingerprint: fingerprint(display.legacyFingerprint), bounds: bounds(display.bounds),
    isPrimary: display.isPrimary === true, isControl: display.isControl === true,
    internal: display.internal === true, scaleFactor: number(display.scaleFactor),
    rotation: number(display.rotation), displayFrequency: number(display.displayFrequency),
    detected: typeof display.detected === 'boolean' ? display.detected : null
  }));
  return {
    at: text(value?.at), session: text(value?.session), version: text(value?.version),
    reason: text(value?.reason), uptimeSeconds: number(value?.uptimeSeconds),
    osUptimeSeconds: number(value?.osUptimeSeconds),
    displays,
    phase: text(value?.phase), cleared: value?.cleared === true, previewOnly: value?.previewOnly === true,
    activeOutputs: (Array.isArray(value?.activeOutputs) ? value.activeOutputs : []).slice(0, 32).map(output => ({
      id: text(output.id), displayId: text(output.displayId), renderer: text(output.renderer)
    })),
    outputs: (Array.isArray(value?.outputs) ? value.outputs : []).slice(0, 32).map(output => ({
      id: text(output.id), enabled: output.enabled === true,
      legacyDisplayId: output.legacyDisplayId == null ? null : text(output.legacyDisplayId),
      displayFingerprint: fingerprint(output.displayFingerprint),
      matchedDisplayId: output.matchedDisplayId == null ? null : text(output.matchedDisplayId),
      matchReason: text(output.matchReason),
      candidateIds: (Array.isArray(output.candidateIds) ? output.candidateIds : []).slice(0, 16).map(text),
      operatorScreen: output.operatorScreen === true
    })),
    changedDisplayId: value?.changedDisplayId == null ? null : text(value.changedDisplayId),
    changedMetrics: (Array.isArray(value?.changedMetrics) ? value.changedMetrics : []).slice(0, 12).map(text),
    ...(value?.error ? { error: safeError(value.error) } : {})
  };
}

// Small, local-only, private journal. Survives app/PC restarts so reassigning
// screens does not erase the evidence. No console/slide/account data is read.
class DisplayDiagnosticsJournal {
  constructor({ filePath, version, session = randomUUID() }) {
    this.filePath = filePath;
    this.version = version;
    this.session = session;
    this.events = [];
    this.persistenceError = null;
    try {
      if (fs.statSync(filePath).size > MAX_BYTES) throw new Error('Screen history exceeded its read limit');
      const stored = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      if (stored.schemaVersion !== 1 || !Array.isArray(stored.events)) throw new Error('Screen history format is invalid');
      this.events = stored.events.slice(-MAX_EVENTS).map(sanitizeEvent);
    } catch (error) {
      if (error.code !== 'ENOENT') this.persistenceError = safeError(error);
    }
  }

  record(reason, { displays = [], outputs = [], ...details } = {}) {
    const event = sanitizeEvent({ ...details, reason, displays,
      at: new Date().toISOString(), session: this.session, version: this.version,
      uptimeSeconds: Math.round(process.uptime()),
      outputs: outputs.map(output => {
        const match = matchOutputDisplay(output, displays);
        return { ...output, matchedDisplayId: match.display?.id,
          matchReason: match.reason, candidateIds: match.candidateIds,
          operatorScreen: match.display?.isControl === true };
      })
    });
    this.events.push(event);
    this.events = this.events.slice(-MAX_EVENTS);
    // Persist immediately: failure evidence must survive a crash/power loss.
    // The cap also bounds work during noisy display-driver events.
    this.flush();
    return event;
  }

  flush() {
    const temporary = `${this.filePath}.${process.pid}.tmp`;
    try {
      let serialized = JSON.stringify({ schemaVersion: 1, events: this.events });
      while (Buffer.byteLength(serialized) > MAX_BYTES && this.events.length > 1) {
        this.events.shift();
        serialized = JSON.stringify({ schemaVersion: 1, events: this.events });
      }
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      fs.writeFileSync(temporary, serialized, { mode: 0o600 });
      fs.renameSync(temporary, this.filePath);
      this.persistenceError = null;
    } catch (error) {
      this.persistenceError = safeError(error);
      try { fs.unlinkSync(temporary); } catch {}
    }
  }

  snapshot() {
    return { schemaVersion: 1, maxEvents: MAX_EVENTS, persistenceError: this.persistenceError,
      events: this.events.map(sanitizeEvent) };
  }
}

module.exports = { DisplayDiagnosticsJournal, MAX_EVENTS, MAX_BYTES };
