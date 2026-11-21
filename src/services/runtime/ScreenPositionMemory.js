'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { safeError } = require('./SupportDiagnostics');

const MAX_OUTPUTS = 32;
const MAX_BYTES = 64 * 1024;
const integer = value => Number.isInteger(value) ? value : null;
const shortText = value => typeof value === 'string' && value.length <= 240 ? value : null;

function sanitizeEntry(value) {
  if (!value || typeof value !== 'object') return null;
  const bounds = value.bounds && typeof value.bounds === 'object'
    ? { x: integer(value.bounds.x), y: integer(value.bounds.y),
        width: integer(value.bounds.width), height: integer(value.bounds.height) }
    : null;
  if (!bounds || bounds.x === null || bounds.y === null) return null;
  const legacyDisplayId = value.legacyDisplayId === null || value.legacyDisplayId === undefined
    ? null : shortText(String(value.legacyDisplayId));
  return { legacyDisplayId, displayFingerprint: shortText(value.displayFingerprint), bounds,
    at: shortText(value.at) };
}

// Remembers where in the operating system's screen layout each output last
// ran, separately from the venue profile so recording it never changes the
// profile revision (which would invalidate a prepared service). An entry only
// counts while the output still has the same saved screen choice.
class ScreenPositionMemory {
  constructor({ filePath }) {
    this.filePath = filePath;
    this.outputs = {};
    this.persistenceError = null;
    try {
      if (fs.statSync(filePath).size > MAX_BYTES) throw new Error('Screen positions exceeded their read limit');
      const stored = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      if (stored.schemaVersion !== 1 || !stored.outputs || typeof stored.outputs !== 'object') {
        throw new Error('Screen positions format is invalid');
      }
      for (const [outputId, entry] of Object.entries(stored.outputs).slice(0, MAX_OUTPUTS)) {
        const clean = sanitizeEntry(entry);
        if (clean && shortText(outputId)) this.outputs[outputId] = clean;
      }
    } catch (error) {
      if (error.code !== 'ENOENT') this.persistenceError = safeError(error);
    }
  }

  // `output` is the saved profile output (its screen choice); `bounds` is
  // where that output is actually shown now.
  remember(outputs) {
    let changed = false;
    for (const { output, bounds } of outputs) {
      if (!output || typeof output.id !== 'string' || !bounds) continue;
      if ((output.legacyDisplayId === null || output.legacyDisplayId === undefined) && !output.displayFingerprint) continue;
      const entry = sanitizeEntry({ legacyDisplayId: output.legacyDisplayId,
        displayFingerprint: output.displayFingerprint || null, bounds, at: new Date().toISOString() });
      if (!entry) continue;
      const previous = this.outputs[output.id];
      if (previous && previous.legacyDisplayId === entry.legacyDisplayId
        && previous.displayFingerprint === entry.displayFingerprint
        && previous.bounds.x === entry.bounds.x && previous.bounds.y === entry.bounds.y
        && previous.bounds.width === entry.bounds.width && previous.bounds.height === entry.bounds.height) continue;
      if (!previous && Object.keys(this.outputs).length >= MAX_OUTPUTS) continue;
      this.outputs[output.id] = entry;
      changed = true;
    }
    if (changed) this.flush();
    return changed;
  }

  // Tell each screen which outputs last ran at its position.
  annotate(displays) {
    const entries = Object.entries(this.outputs);
    return displays.map(display => ({ ...display,
      rememberedFor: entries
        .filter(([, entry]) => entry.bounds.x === display.bounds?.x && entry.bounds.y === display.bounds?.y)
        .map(([outputId, entry]) => ({ outputId, legacyDisplayId: entry.legacyDisplayId,
          displayFingerprint: entry.displayFingerprint }))
    }));
  }

  flush() {
    const temporary = `${this.filePath}.${process.pid}.tmp`;
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      fs.writeFileSync(temporary, JSON.stringify({ schemaVersion: 1, outputs: this.outputs }) + '\n', { mode: 0o600 });
      fs.renameSync(temporary, this.filePath);
      this.persistenceError = null;
    } catch (error) {
      this.persistenceError = safeError(error);
      try { fs.unlinkSync(temporary); } catch {}
    }
  }
}

module.exports = { ScreenPositionMemory, MAX_OUTPUTS };
