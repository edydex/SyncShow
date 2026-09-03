'use strict';

const crypto = require('crypto');
const {
  MEDIA_IO_CHUNK_BYTES
} = require('./LocalSermonMediaStore');

const DEFAULT_PLAYBACK_TTL_MS = 2 * 60 * 60 * 1000;
const PLAYBACK_TOKEN_PATTERN = /^[a-f0-9]{64}$/u;

class SermonRecordingPlaybackError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'SermonRecordingPlaybackError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new SermonRecordingPlaybackError(code, message);
}

function playbackToken(value) {
  const token = typeof value === 'string' ? value : '';
  if (!PLAYBACK_TOKEN_PATTERN.test(token)) {
    fail('INVALID_PLAYBACK_TOKEN', 'The sermon recording playback token is invalid.');
  }
  return token;
}

function playbackBinding(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail('INVALID_PLAYBACK_BINDING', 'The sermon recording playback binding is invalid.');
  }
  const expectedKeys = [
    'projectId',
    'projectRevisionId',
    'itemId',
    'sermonId',
    'sermonRevisionId',
    'recordingId'
  ];
  if (
    Object.keys(value).length !== expectedKeys.length
    || expectedKeys.some(key => !Object.hasOwn(value, key))
    || expectedKeys.some(key => (
      typeof value[key] !== 'string'
      || value[key].length < 1
      || value[key].length > 160
      || /[\u0000-\u001f\u007f/\\]/u.test(value[key])
    ))
    || !/^[a-f0-9]{64}$/u.test(value.projectRevisionId)
    || !/^[a-f0-9]{64}$/u.test(value.sermonRevisionId)
  ) {
    fail('INVALID_PLAYBACK_BINDING', 'The sermon recording playback binding is invalid.');
  }
  return Object.freeze(Object.fromEntries(
    expectedKeys.map(key => [key, value[key]])
  ));
}

function playbackReader(value) {
  if (
    !value
    || typeof value !== 'object'
    || typeof value.read !== 'function'
    || typeof value.close !== 'function'
    || !['audio', 'video'].includes(value.kind)
    || !['audio/mpeg', 'audio/mp4', 'video/mp4'].includes(value.mediaType)
    || !/^[a-f0-9]{64}$/u.test(value.sha256 || '')
    || !Number.isSafeInteger(value.sizeBytes)
    || value.sizeBytes < 1
  ) {
    fail('INVALID_PLAYBACK_READER', 'The sermon recording playback reader is invalid.');
  }
  return value;
}

class SermonRecordingPlaybackAuthority {
  constructor(options = {}) {
    this.now = options.now || (() => Date.now());
    this.randomBytes = options.randomBytes || crypto.randomBytes;
    this.scheduleExpiry = options.scheduleExpiry
      || ((callback, delay) => setTimeout(callback, delay));
    this.cancelExpiry = options.cancelExpiry || (timer => clearTimeout(timer));
    this.ttlMs = options.ttlMs ?? DEFAULT_PLAYBACK_TTL_MS;
    if (
      typeof this.now !== 'function'
      || typeof this.randomBytes !== 'function'
      || typeof this.scheduleExpiry !== 'function'
      || typeof this.cancelExpiry !== 'function'
      || !Number.isSafeInteger(this.ttlMs)
      || this.ttlMs < 60_000
      || this.ttlMs > DEFAULT_PLAYBACK_TTL_MS
    ) {
      throw new TypeError('SermonRecordingPlaybackAuthority options are invalid');
    }
    this.entries = new Map();
    this.expiryTimers = new Map();
    this.operationTail = Promise.resolve();
  }

  async _serialize(operation) {
    let release;
    const previous = this.operationTail;
    this.operationTail = new Promise(resolve => {
      release = resolve;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }

  async _revokeUnlocked(token) {
    const entry = this.entries.get(token);
    if (!entry) return false;
    this.entries.delete(token);
    const timer = this.expiryTimers.get(token);
    this.expiryTimers.delete(token);
    if (timer !== undefined) this.cancelExpiry(timer);
    await entry.reader.close().catch(() => {});
    return true;
  }

  async _revokeAllUnlocked() {
    const entries = [...this.entries.values()];
    this.entries.clear();
    for (const timer of this.expiryTimers.values()) {
      this.cancelExpiry(timer);
    }
    this.expiryTimers.clear();
    await Promise.all(entries.map(entry => entry.reader.close().catch(() => {})));
  }

  async issue({ reader, binding } = {}) {
    const checkedReader = playbackReader(reader);
    let adopted = false;
    try {
      const checkedBinding = playbackBinding(binding);
      return await this._serialize(async () => {
        await this._revokeAllUnlocked();
        let token;
        for (let attempt = 0; attempt < 4; attempt += 1) {
          const random = this.randomBytes(32);
          const candidate = Buffer.isBuffer(random)
            ? random.toString('hex')
            : '';
          if (
            PLAYBACK_TOKEN_PATTERN.test(candidate)
            && !this.entries.has(candidate)
          ) {
            token = candidate;
            break;
          }
        }
        if (!token) {
          fail(
            'PLAYBACK_TOKEN_UNAVAILABLE',
            'SyncShow could not create a private recording playback token.'
          );
        }
        const issuedAt = this.now();
        if (!Number.isSafeInteger(issuedAt) || issuedAt < 0) {
          fail(
            'PLAYBACK_CLOCK_UNAVAILABLE',
            'SyncShow could not create a private recording playback session.'
          );
        }
        const expiresAt = issuedAt + this.ttlMs;
        if (!Number.isSafeInteger(expiresAt)) {
          fail(
            'PLAYBACK_CLOCK_UNAVAILABLE',
            'SyncShow could not create a private recording playback session.'
          );
        }
        const entry = Object.freeze({
          token,
          binding: checkedBinding,
          kind: checkedReader.kind,
          mediaType: checkedReader.mediaType,
          sha256: checkedReader.sha256,
          sizeBytes: checkedReader.sizeBytes,
          expiresAt,
          reader: checkedReader
        });
        this.entries.set(token, entry);
        let timer;
        try {
          timer = this.scheduleExpiry(
            () => this.revoke(token).catch(() => {}),
            this.ttlMs
          );
        } catch (error) {
          this.entries.delete(token);
          throw error;
        }
        timer?.unref?.();
        this.expiryTimers.set(token, timer);
        adopted = true;
        return entry;
      });
    } finally {
      if (!adopted) await checkedReader.close().catch(() => {});
    }
  }

  async resolve(value) {
    const token = playbackToken(value);
    return this._serialize(async () => {
      const entry = this.entries.get(token) || null;
      if (!entry) return null;
      if (entry.expiresAt <= this.now()) {
        await this._revokeUnlocked(token);
        return null;
      }
      return entry;
    });
  }

  async revoke(value) {
    const token = playbackToken(value);
    return this._serialize(() => this._revokeUnlocked(token));
  }

  async revokeAll() {
    return this._serialize(() => this._revokeAllUnlocked());
  }
}

function parsePlaybackRange(value, sizeBytes) {
  if (
    !Number.isSafeInteger(sizeBytes)
    || sizeBytes < 1
  ) {
    fail('INVALID_PLAYBACK_SIZE', 'The sermon recording playback size is invalid.');
  }
  if (value === null || value === undefined || value === '') {
    return Object.freeze({
      start: 0,
      end: sizeBytes - 1,
      partial: false
    });
  }
  if (typeof value !== 'string' || value.length > 100 || value.includes(',')) {
    return null;
  }
  const match = /^bytes=(\d*)-(\d*)$/u.exec(value.trim());
  if (!match || (!match[1] && !match[2])) return null;

  let start;
  let end;
  if (!match[1]) {
    const suffixLength = Number(match[2]);
    if (
      !Number.isSafeInteger(suffixLength)
      || suffixLength < 1
    ) {
      return null;
    }
    start = Math.max(0, sizeBytes - suffixLength);
    end = sizeBytes - 1;
  } else {
    start = Number(match[1]);
    if (!Number.isSafeInteger(start) || start >= sizeBytes) return null;
    end = match[2] ? Number(match[2]) : sizeBytes - 1;
    if (!Number.isSafeInteger(end) || end < start) return null;
    end = Math.min(end, sizeBytes - 1);
  }
  return Object.freeze({ start, end, partial: true });
}

function emptyPlaybackResponse(status, headers = {}) {
  return new Response(null, {
    status,
    headers: {
      'Cache-Control': 'private, no-store',
      'X-Content-Type-Options': 'nosniff',
      ...headers
    }
  });
}

function playbackStream(entry, range) {
  let offset = range.start;
  return new ReadableStream({
    async pull(controller) {
      if (offset > range.end) {
        controller.close();
        return;
      }
      const length = Math.min(
        MEDIA_IO_CHUNK_BYTES,
        range.end - offset + 1
      );
      try {
        const chunk = await entry.reader.read(offset, length);
        if (
          !Buffer.isBuffer(chunk)
          || chunk.length !== length
        ) {
          throw new Error('Playback reader returned an invalid chunk.');
        }
        offset += chunk.length;
        controller.enqueue(Uint8Array.from(chunk));
        if (offset > range.end) controller.close();
      } catch (_error) {
        controller.error(new Error('The private sermon recording became unavailable.'));
      }
    }
  });
}

async function createSermonRecordingPlaybackResponse(
  request,
  authority,
  { scheme = 'syncshow-sermon-media' } = {}
) {
  if (
    !request
    || typeof request !== 'object'
    || !(authority instanceof SermonRecordingPlaybackAuthority)
    || !/^[a-z][a-z0-9+.-]{1,31}$/u.test(scheme)
  ) {
    return emptyPlaybackResponse(404);
  }
  if (!['GET', 'HEAD'].includes(request.method)) {
    return emptyPlaybackResponse(405, { Allow: 'GET, HEAD' });
  }

  let url;
  try {
    url = new URL(request.url);
  } catch (_error) {
    return emptyPlaybackResponse(404);
  }
  const token = url.pathname.startsWith('/')
    ? url.pathname.slice(1)
    : '';
  if (
    url.protocol !== `${scheme}:`
    || url.hostname !== 'play'
    || url.port
    || url.username
    || url.password
    || url.search
    || url.hash
    || !PLAYBACK_TOKEN_PATTERN.test(token)
  ) {
    return emptyPlaybackResponse(404);
  }

  const entry = await authority.resolve(token);
  if (!entry) return emptyPlaybackResponse(404);
  const range = parsePlaybackRange(
    request.headers?.get?.('range') || null,
    entry.sizeBytes
  );
  if (!range) {
    return emptyPlaybackResponse(416, {
      'Accept-Ranges': 'bytes',
      'Content-Range': `bytes */${entry.sizeBytes}`
    });
  }
  const length = range.end - range.start + 1;
  const headers = {
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'private, no-store',
    'Content-Length': String(length),
    'Content-Type': entry.mediaType,
    'X-Content-Type-Options': 'nosniff',
    ...(range.partial
      ? {
          'Content-Range':
            `bytes ${range.start}-${range.end}/${entry.sizeBytes}`
        }
      : {})
  };
  return new Response(
    request.method === 'HEAD' ? null : playbackStream(entry, range),
    {
      status: range.partial ? 206 : 200,
      headers
    }
  );
}

module.exports = {
  DEFAULT_PLAYBACK_TTL_MS,
  PLAYBACK_TOKEN_PATTERN,
  SermonRecordingPlaybackAuthority,
  SermonRecordingPlaybackError,
  createSermonRecordingPlaybackResponse,
  parsePlaybackRange
};
