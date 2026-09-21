'use strict';
const { randomUUID } = require('node:crypto');
const { RemoteProtocolError } = require('../remote/RemoteProtocol');
const COLORS = ['#ef4444', '#2563eb', '#16a34a', '#eab308', '#ffffff', '#111827'];
function reject(message, status = 409) { throw new RemoteProtocolError('TEACHING_REJECTED', message, status); }
function parseStroke(raw) {
  if (!raw || typeof raw !== 'object' || !/^[a-f0-9-]{36}$/.test(raw.id)
    || !['pen', 'highlight', 'pointer'].includes(raw.tool) || !COLORS.includes(raw.color)
    || ![0.004, 0.008, 0.016, 0.035].includes(raw.width)
    || typeof raw.finished !== 'boolean' || !Array.isArray(raw.points)
    || raw.points.length < 1 || raw.points.length > 1024
    || raw.points.some(point => !Array.isArray(point) || point.length !== 2
      || point.some(n => !Number.isFinite(n) || n < 0 || n > 1))) reject('Invalid drawing stroke.', 400);
  if (raw.tool === 'pointer' && (raw.points.length > 128 || !Array.isArray(raw.ages)
    || raw.ages.length !== raw.points.length || raw.ages.some((age, index) =>
      !Number.isFinite(age) || age < 0 || age > 1000 || (index && age > raw.ages[index - 1]))))
    reject('Invalid pointer timing.', 400);
  return { id: raw.id, tool: raw.tool, color: raw.color, width: raw.width,
    finished: raw.finished, points: raw.points.map(point => [...point]),
    ...(raw.tool === 'pointer' ? { ages: [...raw.ages] } : {}) };
}

// Ink belongs to a Show/cue/output, never to the immutable slide package.
class TeachingSurface {
  constructor({ readContext, changed = () => {}, now = Date.now }) {
    this.readContext = readContext; this.changed = changed; this.now = now;
    this.session = null; this.identity = ''; this.generation = randomUUID();
    this.pages = new Map(); this.trails = new Map(); this.revision = 0;
  }
  sync() {
    const context = this.readContext();
    if (this.session !== context.sessionId) { this.pages.clear(); this.session = context.sessionId; }
    const identity = JSON.stringify([context.sessionId, context.cueKey, context.ready, context.outputs]);
    if (identity !== this.identity) {
      this.trails.clear();
      this.identity = identity; this.generation = randomUUID(); this.revision++;
      this.changed(this, context);
    }
    return context;
  }
  key(context, outputId) { return JSON.stringify([context.cueKey, outputId]); }
  frame(outputId, context = this.sync()) {
    const output = context.outputs.find(item => item.id === outputId);
    const serverNow = this.now();
    const trails = (this.trails.get(outputId) || []).filter(trail => trail.times.at(-1) > serverNow - 1000);
    return { frameId: `${this.generation}:${this.revision}`, surfaceId: this.generation, outputId,
      visible: context.ready && Boolean(output),
      serverNow, trails: context.ready && output ? trails : [],
      strokes: context.ready && output ? (this.pages.get(this.key(context, outputId)) || []) : [] };
  }
  state(outputId) {
    const context = this.sync();
    const { strokes, trails, serverNow, ...frame } = this.frame(outputId, context);
    return { available: context.ready, message: context.message || '', outputs: context.outputs,
      cue: context.cueLabel || '', ...(outputId ? { frame: { ...frame, strokeCount: strokes.length,
        inkColors: [...new Set(strokes.map(stroke => stroke.color))] } } : {}) };
  }
  apply(request) {
    const context = this.sync();
    if (!context.ready) reject(context.message || 'Wait for a visible, settled slide.');
    if (!request || request.surfaceId !== this.generation) reject('The slide changed. Refresh before drawing.');
    if (!context.outputs.some(output => output.id === request.outputId)) reject('Choose an available slide output.');
    const key = this.key(context, request.outputId);
    let strokes = this.pages.get(key) || [];
    if (request.operation === 'stroke') {
      const stroke = parseStroke(request.stroke);
      if (stroke.tool === 'pointer') {
        const now = this.now();
        const { ages, ...trail } = stroke;
        // Transient points use host time, never permanent ink or the tablet's clock.
        const active = (this.trails.get(request.outputId) || [])
          .filter(item => item.id !== trail.id && item.times.at(-1) > now - 1000).slice(-3);
        this.trails.set(request.outputId, [...active, { ...trail, times: ages.map(age => now - age) }]);
        this.changed(this, context);
        return this.state(request.outputId);
      }
      const old = strokes.find(item => item.id === stroke.id);
      if (old?.finished || (old && stroke.points.length < old.points.length)) return this.state(request.outputId);
      if (!old && strokes.length >= 160) reject('This slide has reached its ink limit. Clear ink to continue.');
      if (strokes.reduce((sum, item) => sum + item.points.length, 0) - (old?.points.length || 0) + stroke.points.length > 8192)
        reject('This slide has reached its ink limit. Clear ink to continue.');
      strokes = old ? strokes.map(item => item.id === stroke.id ? stroke : item) : [...strokes, stroke];
    } else if (request.operation === 'undo' || request.operation === 'clear') {
      this.trails.clear();
      strokes = request.operation === 'undo' ? strokes.slice(0, -1) : [];
      this.generation = randomUUID(); // Delayed pen updates cannot resurrect removed ink.
    } else reject('Unknown teaching operation.', 400);
    if (!this.pages.has(key) && this.pages.size >= 64) this.pages.delete(this.pages.keys().next().value);
    this.pages.set(key, strokes); this.revision++; this.changed(this, context);
    return this.state(request.outputId);
  }
}
module.exports = { TeachingSurface, parseStroke, COLORS };
