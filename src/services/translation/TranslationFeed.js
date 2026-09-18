'use strict';

function communityOrigin(value) {
  const url = new URL(value);
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  const loopback = hostname === 'localhost' || hostname === '::1' || /^127(?:\.\d{1,3}){3}$/.test(hostname);
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/'
    || (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback))) {
    throw new Error('Translation requires a trusted HTTPS Community address.');
  }
  return url.origin;
}

/** A single public socket in the main process fans captions out to every display. */
class TranslationFeed {
  constructor({ projection, changed, WebSocketClass = globalThis.WebSocket, setTimer = setTimeout, clearTimer = clearTimeout }) {
    this.projection = projection;
    this.changed = changed;
    this.WebSocketClass = WebSocketClass;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.generation = 0;
    this.socket = null;
    this.timer = null;
    this.watchdog = null;
    this.publishTimer = null;
    this.origin = null;
    this.retry = 0;
  }

  connect(address) {
    const origin = communityOrigin(address);
    if (origin === this.origin) return;
    this.stop();
    this.origin = origin;
    this.retry = 0;
    this.open(this.generation);
  }

  stop() {
    this.generation++;
    this.origin = null;
    this.clearTimer(this.timer);
    this.clearTimer(this.watchdog);
    this.clearTimer(this.publishTimer);
    this.timer = this.watchdog = this.publishTimer = null;
    const socket = this.socket;
    this.socket = null;
    socket?.close();
    this.projection.reset();
    this.changed();
  }

  open(generation) {
    if (generation !== this.generation || !this.origin) return;
    this.projection.setConnection('connecting');
    this.changed();
    const url = new URL('/translation/api/public/events', this.origin);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    let socket;
    const disconnected = () => {
      if (generation !== this.generation || this.socket !== socket) return;
      this.socket = null;
      this.clearTimer(this.watchdog);
      socket?.close();
      this.projection.setConnection('disconnected');
      this.changed();
      this.timer = this.setTimer(() => this.open(generation), Math.min(10000, 1000 * 2 ** Math.min(this.retry++, 4)));
      this.timer?.unref?.();
    };
    try {
      socket = new this.WebSocketClass(url.href);
      this.socket = socket;
      const armWatchdog = () => {
        this.clearTimer(this.watchdog);
        this.watchdog = this.setTimer(disconnected, 30000);
        this.watchdog?.unref?.();
      };
      armWatchdog();
      socket.addEventListener('message', event => {
        if (generation !== this.generation || this.socket !== socket
          || typeof event.data !== 'string' || event.data.length > 128000) return;
        let data;
        try { data = JSON.parse(event.data); } catch (_error) { return; }
        if (this.projection.accept(data)) {
          if (data.type === 'public-state') { this.retry = 0; armWatchdog(); }
          // Coalesce replay bursts before displays choose their first phrase.
          if (!this.publishTimer) {
            this.publishTimer = this.setTimer(() => {
              this.publishTimer = null;
              if (generation === this.generation) this.changed();
            }, 50);
            this.publishTimer?.unref?.();
          }
        }
      });
      socket.addEventListener('close', disconnected);
      socket.addEventListener('error', disconnected);
    } catch (_error) {
      this.socket = socket;
      disconnected();
    }
  }
}

module.exports = { TranslationFeed, communityOrigin };
