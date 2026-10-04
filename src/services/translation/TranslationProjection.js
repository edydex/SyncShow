'use strict';

const LAYOUTS = new Set(['hidden', 'full-screen', 'lower-third', 'ticker']);
const LANGUAGES = new Set(['en', 'ru']);
const MAX_PHRASES = 80;
const STALE_AFTER_MS = 30000;
const identifier = value => typeof value === 'string'
  && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(value);

function normalizeOutput(value = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some(key => !['language', 'layout', 'fontScale'].includes(key))) {
    throw new Error('Translation output settings are invalid.');
  }
  const settings = {
    language: value.language ?? 'en',
    layout: value.layout ?? 'hidden',
    fontScale: value.fontScale ?? 1
  };
  if (!LANGUAGES.has(settings.language) || !LAYOUTS.has(settings.layout)
    || !Number.isFinite(settings.fontScale) || settings.fontScale < 0.75
    || settings.fontScale > 1.5) {
    throw new Error('Choose English or Russian and a supported translation layout.');
  }
  return settings;
}

/** Public captions only. Projection changes never mutate the processor session. */
class TranslationProjection {
  constructor({ now = Date.now } = {}) {
    this.now = now;
    this.connection = 'disconnected';
    this.lastStateAt = null;
    this.state = { active: false, sessionId: null, languages: [] };
    this.phrases = new Map();
    this.outputs = new Map();
    this.manual = new Map();
    this.version = 0;
  }

  reset() {
    this.connection = 'disconnected';
    this.lastStateAt = null;
    this.state = { active: false, sessionId: null, languages: [] };
    this.phrases.clear();
    this.manual.clear();
    this.version++;
  }

  setConnection(value) {
    if (!['connecting', 'disconnected'].includes(value)) throw new Error('Invalid connection state.');
    this.connection = value;
    this.version++;
  }

  accept(event) {
    if (event?.type === 'public-state') {
      const value = event.state;
      if (!value || typeof value.active !== 'boolean'
        || !Number.isFinite(value.serverTimeUnixMs)
        || (value.active && !identifier(value.sessionId))
        || !Array.isArray(value.languages) || value.languages.length > 32) return false;
      const sessionId = value.active ? value.sessionId : null;
      const languages = [];
      for (const item of value.languages) {
        if (!item || typeof item.language !== 'string' || typeof item.available !== 'boolean') return false;
        if (LANGUAGES.has(item.language) && !languages.some(language => language.language === item.language)) {
          languages.push({ language: item.language, available: item.available, audioAvailable: item.audioAvailable === true });
        }
      }
      if (sessionId !== this.state.sessionId) {
        this.phrases.clear();
        this.manual.clear();
      }
      this.state = { active: value.active, sessionId, languages };
      this.connection = 'connected';
      this.lastStateAt = this.now();
      this.version++;
      return true;
    }
    if (event?.type !== 'transcript') return false;
    const segment = event.segment;
    if (!segment || !this.state.active || segment.sessionId !== this.state.sessionId
      || !identifier(segment.channelId) || !LANGUAGES.has(segment.language)
      || !this.state.languages.some(item => item.language === segment.language)
      || !Number.isSafeInteger(segment.sequence) || segment.sequence < 0
      || segment.sequence > 1000000000 || typeof segment.final !== 'boolean'
      || typeof segment.text !== 'string' || segment.text.length > 12000
      || !segment.text.trim()) return false;
    const revision = segment.revision ?? 0;
    if (!Number.isSafeInteger(revision) || revision < 0) return false;
    const phrases = this.phrases.get(segment.language) ?? new Map();
    const key = `${segment.channelId}:${segment.sequence}`;
    const previous = phrases.get(key);
    if (previous && ((previous.final && !segment.final)
      || (previous.final === segment.final && revision < previous.revision)
      || (revision === previous.revision && previous.final === segment.final))) return false;
    if (!previous && phrases.size >= MAX_PHRASES
      && segment.sequence < Math.min(...[...phrases.values()].map(item => item.sequence))) return false;
    phrases.set(key, {
      key: `${segment.sessionId}:${key}`,
      sequence: segment.sequence,
      revision,
      final: segment.final,
      streaming: segment.delivery === 'streaming',
      text: segment.text,
      language: segment.language
    });
    const ordered = [...phrases.entries()].sort((a, b) => a[1].sequence - b[1].sequence);
    this.phrases.set(segment.language, new Map(ordered.slice(-MAX_PHRASES)));
    this.version++;
    return true;
  }

  configure(outputId, value) {
    if (!identifier(outputId)) throw new Error('Select a valid output.');
    this.outputs.set(outputId, normalizeOutput(value));
    this.manual.delete(outputId);
    this.version++;
  }

  override(outputId, text) {
    if (!this.outputs.has(outputId)) throw new Error('Configure this translation output first.');
    if (text !== null && (typeof text !== 'string' || !text.trim() || text.length > 1000)) {
      throw new Error('Manual text must contain between 1 and 1000 characters.');
    }
    if (text === null) this.manual.delete(outputId);
    else this.manual.set(outputId, { text, version: ++this.version });
    this.version++;
  }

  snapshot() {
    const stale = this.connection !== 'connected' || this.lastStateAt === null
      || this.now() - this.lastStateAt > STALE_AFTER_MS;
    return {
      version: this.version,
      status: stale ? this.connection === 'connecting' ? 'connecting' : 'disconnected'
        : this.state.active ? 'live' : 'idle',
      sessionId: this.state.sessionId,
      languages: this.state.languages.map(value => ({ ...value })),
      // Native interpreter revisions are append-only and safe to stream. ASR
      // drafts still stay off the projector until finalized.
      captions: Object.fromEntries([...this.phrases].map(([language, phrases]) => [
        language, [...phrases.values()].slice(-8).map(value => ({ ...value }))
      ]))
    };
  }

  frame(outputId) {
    const settings = this.outputs.get(outputId) ?? normalizeOutput();
    const snapshot = this.snapshot();
    const manual = this.manual.get(outputId);
    const available = snapshot.languages.some(item => item.language === settings.language && item.available);
    return {
      outputId,
      ...settings,
      status: snapshot.status,
      sessionId: snapshot.sessionId,
      manual: Boolean(manual),
      moving: snapshot.status === 'live' || Boolean(manual),
      phrases: manual ? [{ key: `manual:${outputId}:${manual.version}`, text: manual.text, final: true, revision: manual.version }]
        : available ? (snapshot.captions[settings.language] ?? []).filter(item => item.final || item.streaming) : []
    };
  }
}

module.exports = { TranslationProjection, normalizeOutput, STALE_AFTER_MS };
