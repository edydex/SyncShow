'use strict';

/** Observe only this embedded planner's document requests. Loading after Prepare
 * must wait for Save and fetch that same service, never the previous package. */
class CommunityPlannerHandoff {
  constructor({ origin, webContentsId, timeoutMs = 30000 }) {
    this.origin = origin; this.webContentsId = webContentsId; this.timeoutMs = timeoutMs;
    this.serviceId = null; this.pending = new Map(); this.failure = null;
  }
  begin(details) {
    if (details.webContentsId !== this.webContentsId || !['GET', 'PUT'].includes(details.method)) return;
    let url;
    try { url = new URL(details.url); } catch { return; }
    const match = /^\/api\/community\/service-documents\/([A-Za-z0-9][A-Za-z0-9._:-]{0,127})$/.exec(url.pathname);
    if (url.origin !== this.origin || url.search || !match) return;
    if (this.serviceId !== match[1] || details.method === 'PUT') this.failure = null;
    this.serviceId = match[1];
    this.pending.set(details.id, { serviceId: match[1], method: details.method });
  }
  finish(details) {
    const request = this.pending.get(details.id);
    if (!request) return;
    this.pending.delete(details.id);
    const successful = details.statusCode >= 200 && details.statusCode < 300
      || (request.method === 'GET' && details.statusCode === 304);
    // A cancelled/cached background GET must not block Load's own fresh read.
    // A failed Save does block it: fetching the old revision would lose intent.
    if (request.method === 'PUT' && request.serviceId === this.serviceId && (details.error || !successful)) {
      this.failure = 'The service did not save. Return to Prepare and resolve the save error before loading it.';
    }
  }
  async ready() {
    const deadline = Date.now() + this.timeoutMs;
    while (this.pending.size) {
      if (Date.now() >= deadline) throw new Error('Prepare is still saving or loading. Wait for it to finish before going to Load.');
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    if (this.failure) throw new Error(this.failure);
    return { serviceId: this.serviceId };
  }
}
module.exports = { CommunityPlannerHandoff };
