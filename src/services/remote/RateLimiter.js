'use strict';

class SlidingWindowRateLimiter {
  constructor({ limit, windowMs, maxKeys = 1024, now = Date.now } = {}) {
    if (!Number.isSafeInteger(limit) || limit < 1) throw new TypeError('Rate limit must be positive');
    if (!Number.isSafeInteger(windowMs) || windowMs < 1) throw new TypeError('Rate window must be positive');
    if (!Number.isSafeInteger(maxKeys) || maxKeys < 1) throw new TypeError('Rate key limit must be positive');
    if (typeof now !== 'function') throw new TypeError('Rate limiter clock must be a function');
    this.limit = limit;
    this.windowMs = windowMs;
    this.maxKeys = maxKeys;
    this.now = now;
    this.entries = new Map();
  }

  consume(key) {
    const normalizedKey = String(key);
    const timestamp = this.now();
    const cutoff = timestamp - this.windowMs;
    const previous = this.entries.get(normalizedKey) || [];
    const recent = previous.filter(value => value > cutoff);

    if (recent.length >= this.limit) {
      this._remember(normalizedKey, recent);
      return {
        allowed: false,
        remaining: 0,
        retryAfterMs: Math.max(1, recent[0] + this.windowMs - timestamp)
      };
    }

    recent.push(timestamp);
    this._remember(normalizedKey, recent);
    return {
      allowed: true,
      remaining: Math.max(0, this.limit - recent.length),
      retryAfterMs: 0
    };
  }

  reset(key) {
    this.entries.delete(String(key));
  }

  clear() {
    this.entries.clear();
  }

  _remember(key, timestamps) {
    this.entries.delete(key);
    this.entries.set(key, timestamps);
    while (this.entries.size > this.maxKeys) {
      this.entries.delete(this.entries.keys().next().value);
    }
  }
}

module.exports = { SlidingWindowRateLimiter };
