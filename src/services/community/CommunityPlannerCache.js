'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const core = require('./HeritageServiceDocument');
const { atomicWriteFile, ensurePrivateDirectory } = require('../project/StorageSafety');

const ENDPOINT = '/api/community/service-documents';
const MAX_BYTES = 32 * 1024 * 1024;
const idPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
function serviceEnvelope(raw) {
  const validated = core.validateHeritageServiceDocumentSource(raw.documentSource);
  if (raw.syncId !== validated.project.id || raw.revision !== validated.revision) throw new Error('Community returned an invalid service revision.');
  return { ...raw, ...validated };
}
const json = (value, status = 200) => new Response(JSON.stringify(value), {
  status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }
});

/** The same Community editor runs online and offline. Its assets and private
 * document journal belong to one approved connection, never another account.
 * Pending writes retain their first remote base; reconnect cannot silently
 * replace a newer server revision. No presentation state is changed here. */
class CommunityPlannerCache {
  constructor({ rootPath, origin, fetch, onState = () => {}, localRequest = async () => null, inspectImage, backgroundSync = false }) {
    this.rootPath = rootPath;
    this.origin = new URL(origin).origin;
    this.fetch = request => fetch(new Request(request, {
      signal: AbortSignal.timeout(new URL(request.url).pathname.includes('/assets/') ? 60000 : 8000)
    }));
    this.onState = onState;
    this.localRequest = localRequest;
    this.inspectImage = inspectImage;
    this.backgroundSync = backgroundSync;
    this.syncQueue = Promise.resolve();
    this.state = { schemaVersion: 1, documents: {}, remoteBases: {}, pending: {}, conflicts: {}, assets: {}, history: {} };
    this.offline = false;
    this.queue = Promise.resolve();
    this.persistQueue = Promise.resolve();
    this.loaded = this.load();
  }

  async load() {
    this.rootPath = await ensurePrivateDirectory(this.rootPath);
    try {
      const saved = JSON.parse(await fs.readFile(path.join(this.rootPath, 'journal.json'), 'utf8'));
      if (saved.schemaVersion === 1) this.state = { ...saved, workspaceLanguage: ['en', 'ru'].includes(saved.workspaceLanguage) ? saved.workspaceLanguage : null, remoteBases: saved.remoteBases || {}, assets: saved.assets || {}, history: saved.history || {} };
      for (const [id, raw] of Object.entries(this.state.documents)) this.state.documents[id] = serviceEnvelope(raw);
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }

  async persist() {
    const target = path.join(this.rootPath, 'journal.json');
    const snapshot = JSON.stringify(this.state);
    const operation = this.persistQueue.then(async () => {
      // The shared writer verifies and flushes the published filename too.
      // Windows cannot use a directory fsync as the rename durability barrier.
      await atomicWriteFile(target, snapshot, { rootPath: this.rootPath });
      this.onState(this.summary());
    });
    this.persistQueue = operation.catch(() => {});
    return operation;
  }

  summary() {
    return { offline: this.offline, pending: Object.keys(this.state.pending).length,
      conflicts: Object.keys(this.state.conflicts), availableOffline: Boolean(this.state.editorReady), workspaceLanguage: this.state.workspaceLanguage || null };
  }

  cachePath(request) {
    const headers = request.headers;
    // Next serves HTML and RSC payloads at the same URL; keep them distinct.
    const key = [request.url, new URL(request.url).pathname.includes('/assets/') ? '' : headers.get('accept'), headers.get('rsc'),
      headers.get('next-router-state-tree'), headers.get('next-url')].join('\n');
    return path.join(this.rootPath, 'responses', crypto.createHash('sha256').update(key).digest('hex'));
  }

  async cacheResponse(request, response) {
    if (!response.ok || request.method !== 'GET') return;
    const bytes = Buffer.from(await response.clone().arrayBuffer());
    if (bytes.length > MAX_BYTES) return;
    const target = this.cachePath(request);
    await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    const headers = [...response.headers].filter(([key]) => !['set-cookie', 'content-encoding', 'content-length'].includes(key));
    await fs.writeFile(`${target}.json`, JSON.stringify({ status: response.status, headers }), { mode: 0o600 });
    await fs.writeFile(target, bytes, { mode: 0o600 });
    if (new URL(request.url).pathname === '/admin/plan-service' && response.headers.get('content-type')?.includes('text/html')) {
      this.state.editorReady = true;
      await this.persist();
    }
  }

  async cachedResponse(request) {
    const target = this.cachePath(request);
    try {
      const metadata = JSON.parse(await fs.readFile(`${target}.json`, 'utf8'));
      let bytes = await fs.readFile(target);
      if (new URL(request.url).pathname === '/admin/plan-service'
        && new Headers(metadata.headers).get('content-type')?.includes('text/html')
        && ['en', 'ru'].includes(this.state.workspaceLanguage)) {
        bytes = Buffer.from(bytes.toString('utf8').replace(/(<html\b[^>]*?)\slang="[^"]*"/, `$1 lang="${this.state.workspaceLanguage}"`));
      }
      return new Response(bytes, metadata);
    } catch (error) { if (error.code !== 'ENOENT') throw error; return null; }
  }

  async request(request) {
    await this.loaded;
    const url = new URL(request.url);
    if (url.origin !== this.origin) return this.fetch(request);
    if (url.pathname.startsWith('/syncshow-local/adjust/') || (this.activeServiceId && url.pathname==='/fonts/NotoSans-Variable.ttf')) return this.localRequest(request);
    if (this.activeServiceId) {
      if (request.method === 'GET' && url.pathname === ENDPOINT) return this.listResponse({schemaVersion:1,items:[]});
      if (request.method === 'GET' && url.pathname === `${ENDPOINT}/${this.activeServiceId}`) return json({schemaVersion:1,serviceDocument:this.envelope(this.activeServiceId)});
      if (request.method === 'GET' && url.pathname.includes('/assets/')) {
        const local=await this.localAssetLoader?.(request);
        if(local)return local;
      }
      if (request.method === 'POST' && url.pathname === `${ENDPOINT}/library/bible-passage`) {
        const local=await this.localRequest(request.clone());
        if(local?.ok)return local;
      }
      if(request.method==='GET' && (url.pathname.startsWith(`${ENDPOINT}/library/`) || url.pathname.startsWith('/api/community/sermon-presentations'))) {
        const cached=await this.cachedResponse(request) || await this.resourceCache?.cachedResponse(request);
        if(cached)return cached;
      }
      // Resource reads are explicit Add-slide actions. The service itself is
      // always the pinned local show; it never follows a remote GET.
      if (url.pathname === ENDPOINT && request.method === 'POST') return json({error:'Adjust edits the active service.'},400);
      const service=/^\/api\/community\/service-documents\/([^/]+)$/.exec(url.pathname);
      if(service && idPattern.test(service[1]) && service[1] !== this.activeServiceId)return json({error:'Adjust edits the active service.'},409);
    }
    const historyMatch = new RegExp(`^${ENDPOINT}/([^/]+)/history(?:/(local-[a-f0-9-]+)(?:/assets/(.+))?)?$`).exec(url.pathname);
    if (request.method === 'GET' && historyMatch) return this.historyResponse(request, historyMatch);
    const assetMatch = new RegExp(`^${ENDPOINT}/(?:[^/]+/)?assets/(sha256(?::|%3A)[a-f0-9]{64})$`, 'i').exec(url.pathname);
    if (assetMatch) {
      const assetId = decodeURIComponent(assetMatch[1]);
      if (request.method === 'PUT') return this.saveAsset(request, assetId);
      if (request.method === 'GET' && this.state.assets[assetId]) {
        return new Response(await fs.readFile(this.assetPath(assetId)), { headers: { 'Content-Type': this.state.assets[assetId].metadata.mediaType } });
      }
    }
    const documentId = url.pathname.startsWith(`${ENDPOINT}/`)
      ? url.pathname.slice(ENDPOINT.length + 1) : null;
    const isDocument = documentId && idPattern.test(documentId);
    if (isDocument && request.method === 'PUT' || url.pathname === ENDPOINT && request.method === 'POST') {
      const operation = this.queue.then(() => this.save(request, isDocument ? documentId : null));
      this.queue = operation.catch(() => {});
      return operation;
    }
    if (request.method === 'GET' && isDocument && this.state.pending[documentId]) {
      return json({ schemaVersion: 1, serviceDocument: this.envelope(documentId) });
    }
    if (request.method === 'GET' && url.pathname === ENDPOINT && Object.keys(this.state.pending).length) {
      try { await this.flush(); } catch { /* Continue with the protected local journal. */ }
    }
    const observedDocument = isDocument ? this.state.documents[documentId] : null;
    try {
      const response = await this.fetch(request.clone());
      if (response.status >= 500) throw new Error('Community is temporarily unavailable.');
      this.offline = false;
      if (response.ok && request.method === 'GET') {
        await this.cacheResponse(request, response);
        if (url.pathname === `${ENDPOINT}/library/songs`) {
          const library = await response.clone().json();
          // Download each exact song while online so adding songs stays useful offline.
          this.prefetchSongs(library.items || []).catch(() => {});
        }
        if (url.pathname === '/api/community/sermon-presentations') {
          const library = await response.clone().json();
          this.prefetchSermons(library.items || []).catch(() => {});
        }
        if (isDocument) {
          const payload = await response.clone().json();
          if (payload.serviceDocument) {
            // A GET started before a local save must never replace its journal.
            if (this.state.pending[documentId] || (this.state.documents[documentId] && this.state.documents[documentId] !== observedDocument)) {
              return json({ schemaVersion: 1, serviceDocument: this.envelope(documentId) });
            }
            this.state.documents[documentId] = serviceEnvelope(payload.serviceDocument);
            this.state.remoteBases[documentId] = { revision: payload.serviceDocument.revision, syncVersion: payload.serviceDocument.syncVersion };
            await this.persist();
            // Ensure media referenced by an opened service is available too.
            for (const assetId of Object.keys(payload.serviceDocument.project?.assets || payload.serviceDocument.document?.project?.assets || {})) {
              const assetRequest = new Request(`${this.origin}${ENDPOINT}/${documentId}/assets/${assetId}`);
              try { const asset = await this.fetch(assetRequest); await this.cacheResponse(assetRequest, asset); } catch { /* Show build checks exact missing assets. */ }
            }
          }
        }
      }
      if (request.method === 'GET' && url.pathname === ENDPOINT && response.ok) {
        return this.listResponse(await response.json());
      }
      this.onState(this.summary());
      return response;
    } catch (error) {
      this.offline = true;
      this.onState(this.summary());
      const local = await this.localRequest(request.clone());
      if (local) return local;
      if (request.method === 'GET' && isDocument && this.state.documents[documentId]) {
        return json({ schemaVersion: 1, serviceDocument: this.envelope(documentId) });
      }
      const cached = request.method === 'GET' ? await this.cachedResponse(request) : null;
      if (cached) {
        if (url.pathname === ENDPOINT) return this.listResponse(await cached.json());
        return cached;
      }
      if (request.method === 'GET' && url.pathname === ENDPOINT) return this.listResponse({ schemaVersion: 1, items: [] });
      return json({ code: 'COMMUNITY_OFFLINE', error: 'This resource is not saved on this computer yet. Reconnect Community to download it.' }, 503);
    }
  }

  async appendHistory(id, saveKind) {
    const entry = { id: `local-${crypto.randomUUID()}`, syncVersion: null,
      revision: this.state.documents[id].revision, savedAt: new Date().toISOString(),
      saveKind, savedBy: 'This computer' };
    entry.syncVersion = entry.id;
    const folder = path.join(this.rootPath, 'history');
    await atomicWriteFile(path.join(folder, `${entry.id}.json`), JSON.stringify(this.state.documents[id]), { rootPath: this.rootPath });
    (this.state.history[id] ||= []).push(entry);
    return entry;
  }

  async historyResponse(request, match) {
    const [, id, localId, assetId] = match;
    if (localId) {
      if (!(this.state.history[id] || []).some(entry => entry.id === localId)) return json({ error: 'Local version not found.' }, 404);
      const serviceDocument = JSON.parse(await fs.readFile(path.join(this.rootPath, 'history', `${localId}.json`), 'utf8'));
      if (assetId) {
        const bytes = await this.asset(id, decodeURIComponent(assetId));
        const metadata = serviceDocument.project.assets[decodeURIComponent(assetId)];
        return new Response(bytes, { headers: { 'Content-Type': metadata?.mediaType || 'application/octet-stream' } });
      }
      return json({ schemaVersion: 1, serviceDocument });
    }
    let payload = { schemaVersion: 1, groups: [], hasNextPage: false };
    try {
      if (this.activeServiceId) throw new Error('Use local Show history.');
      const response = await this.fetch(request.clone());
      if (!response.ok) throw new Error('offline');
      await this.cacheResponse(request, response);
      payload = await response.json();
    } catch {
      const cached = await this.cachedResponse(request);
      if (cached) payload = await cached.json();
    }
    if (new URL(request.url).searchParams.get('page') && new URL(request.url).searchParams.get('page') !== '1') return json(payload);
    const groups = [];
    const remoteVersions = new Set((payload.groups || []).flatMap(group => (group.entries || []).map(entry => entry.syncVersion)));
    for (const entry of this.state.history[id] || []) {
      if (entry.remoteSyncVersion && remoteVersions.has(entry.remoteSyncVersion)) continue;
      const prior = groups.at(-1);
      if (entry.saveKind === 'automatic' && prior?.saveKind === 'automatic'
        && Date.parse(entry.savedAt) - Date.parse(prior.startedAt) < 300000) {
        prior.entries.push(entry); prior.savedAt = entry.savedAt;
      } else groups.push({ id: entry.id, saveKind: entry.saveKind, savedBy: entry.savedBy,
        startedAt: entry.savedAt, savedAt: entry.savedAt, entries: [entry] });
    }
    return json({ ...payload, groups: [...groups.reverse().map(group => ({ ...group, entries: group.entries.reverse() })), ...(payload.groups || [])] });
  }

  envelope(id) {
    const saved = this.state.documents[id];
    if (!saved) return null;
    return { ...saved, savedLocally: true, pending: Boolean(this.state.pending[id]), conflict: Boolean(this.state.conflicts[id]), desktop: { savedLocally: true, pending: Boolean(this.state.pending[id]),
      conflict: Boolean(this.state.conflicts[id]) } };
  }

  async pinActiveShow(envelope, remoteBase, assetLoader) {
    await this.loaded;
    this.activeServiceId=envelope.syncId;
    this.localAssetLoader=assetLoader;
    // Each exact Show starts with its own journal, separate from Prepare.
    // Reopening Adjust retains any later local edits in that same journal.
    if (!this.state.documents[envelope.syncId]) {
      this.state.documents[envelope.syncId]=serviceEnvelope(envelope);
      if(remoteBase)this.state.remoteBases[envelope.syncId]=remoteBase;
      await this.persist();
    }
  }

  async listResponse(payload) {
    if (payload.workspaceLanguageSource === 'device' && ['en', 'ru'].includes(payload.workspaceLanguage)
      && this.state.workspaceLanguage !== payload.workspaceLanguage) {
      this.state.workspaceLanguage = payload.workspaceLanguage;
      await this.persist();
    }
    const locale = this.state.workspaceLanguage ? { workspaceLanguage: this.state.workspaceLanguage, workspaceLanguageSource: 'device' } : {};
    const items = new Map((payload.items || []).map(item => [item.syncId, item]));
    for (const [id, saved] of Object.entries(this.state.documents)) {
      const project = saved.project || saved.document?.project;
      if (!project || (!this.state.pending[id] && items.has(id))) continue;
      items.set(id, { syncId: id, syncVersion: saved.syncVersion, revision: saved.revision,
        title: project.title, serviceDate: project.serviceDate, status: saved.status, changedAt: saved.changedAt,
        desktop: { pending: Boolean(this.state.pending[id]), conflict: Boolean(this.state.conflicts[id]) } });
    }
    return json({ ...payload, ...locale, items: [...items.values()].sort((a, b) => b.serviceDate.localeCompare(a.serviceDate)) });
  }

  async save(request, id) {
    const raw = await request.json();
    id ||= raw.syncId;
    if (!idPattern.test(id || '') || raw.schemaVersion !== 1 || raw.syncId !== id) {
      return json({ error: 'Service identity is invalid.' }, 400);
    }
    const previous = this.state.documents[id];
    if (request.method === 'POST' && previous) return json({ error: 'This service already exists. Open it instead.' }, 409);
    if (request.method === 'PUT' && (!previous || raw.baseRevision !== previous.revision || raw.baseSyncVersion !== previous.syncVersion)) {
      return json({ error: 'The local service changed. Reopen it before saving.', code: 'REVISION_CONFLICT' }, 412);
    }
    let validated;
    try {
      if (request.method === 'POST') {
        const now = new Date().toISOString();
        const project = { schemaVersion: 1, kind: 'syncshow-service-project', id,
          title: String(raw.title || '').trim(), serviceDate: raw.serviceDate,
          createdAt: now, updatedAt: now, revision: 1, preferredProfileId: 'main-sanctuary',
          channelIds: ['english', 'russian', 'media'],
          channels: { english: { id: 'english', label: 'English', language: 'en' }, russian: { id: 'russian', label: 'Russian', language: 'ru' }, media: { id: 'media', label: 'Media', language: 'und' } },
          rootItemIds: [], items: {}, resources: {}, assets: {}, presetPack: { id: 'main-sanctuary', version: 1, sha256: null } };
        validated = core.validateHeritageServiceDocumentSource(core.serializeHeritageServiceDocument(core.createHeritageServiceDocument(project)));
      } else validated = core.validateHeritageServiceDocumentSource(raw.documentSource);
      if (validated.project.id !== id) throw new Error('Service identity does not match.');
    } catch (error) { return json({ error: error.message }, 400); }
    const pending = this.state.pending[id];
    const remoteBase = this.state.remoteBases[id] || previous;
    this.state.pending[id] = { mode: pending?.mode || (request.method === 'POST' ? 'create' : 'update'),
      create: pending?.create || (request.method === 'POST' ? raw : null),
      baseSyncVersion: pending?.baseSyncVersion || remoteBase?.syncVersion || null,
      baseRevision: pending?.baseRevision || remoteBase?.revision || null,
      requestId: raw.requestId || crypto.randomUUID(), saveKind: raw.saveKind || 'automatic',
      documentSource: validated.documentSource, status: raw.status || 'planning', checkpoints: pending?.checkpoints || [],
      ...(pending?.attempt ? { attempt: pending.attempt } : {}) };
    this.state.documents[id] = { schemaVersion: 1, syncId: id, syncVersion: (previous?.syncVersion || 0) + 1,
      revision: validated.revision, documentSource: validated.documentSource, document: validated.document,
      project: validated.project, status: raw.status || 'planning', changedAt: new Date().toISOString() };
    const checkpoint = await this.appendHistory(id, raw.saveKind || 'automatic');
    if (['manual', 'restore'].includes(raw.saveKind)) this.state.pending[id].checkpoints.push(checkpoint.id);
    await this.persist(); // Durable before reporting success, including a network failure or crash.
    if (!this.offline) {
      if (this.backgroundSync) void this.flush().catch(() => {});
      else await this.flushOne(id);
    }
    return json({ schemaVersion: 1, serviceDocument: this.envelope(id) }, request.method === 'POST' ? 201 : 200);
  }

  async prefetchSongs(items) {
    for (let offset = 0; offset < items.length; offset += 4) {
      await Promise.all(items.slice(offset, offset + 4).map(async item => {
        if (!idPattern.test(item.syncId)) return;
        const request = new Request(`${this.origin}${ENDPOINT}/library/songs/${item.syncId}`, { headers: { Accept: 'application/json' } });
        try { const response = await this.fetch(request); await this.cacheResponse(request, response); } catch { /* Explicit availability on offline access. */ }
      }));
    }
  }

  async prefetchSermons(items) {
    for (let offset = 0; offset < items.length; offset += 4) {
      await Promise.all(items.slice(offset, offset + 4).map(async item => {
        if (!idPattern.test(item.syncId)) return;
        const request = new Request(`${this.origin}/api/community/sermon-presentations/${item.syncId}`, { headers: { Accept: 'application/json' } });
        try { const response = await this.fetch(request); await this.cacheResponse(request, response); } catch { /* Availability is reported on access. */ }
      }));
    }
  }

  assetPath(id) { return path.join(this.rootPath, 'assets', id.slice(7)); }

  async saveAsset(request, id) {
    const bytes = Buffer.from(await request.arrayBuffer());
    const mediaType = request.headers.get('content-type');
    const video = ['video/mp4', 'video/webm'].includes(mediaType);
    if (!bytes.length || bytes.length > (video ? 250 : 75) * 1024 * 1024
      || crypto.createHash('sha256').update(bytes).digest('hex') !== id.slice(7)
      || !['image/png', 'image/jpeg', 'image/webp', 'video/mp4', 'video/webm'].includes(mediaType)) return json({ error: 'Media upload failed validation.' }, 400);
    const metadata = { id, sha256: id.slice(7), kind: video ? 'video' : 'image', mediaType, size: bytes.length };
    if (!video) {
      const image = await this.inspectImage(bytes);
      if (!image.width || !image.height || image.width * image.height > 100000000) return json({ error: 'Choose a valid picture.' }, 400);
      Object.assign(metadata, { width: image.width, height: image.height, orientation: image.orientation || 1 });
    }
    await atomicWriteFile(this.assetPath(id), bytes, { rootPath: this.rootPath });
    this.state.assets[id] = { metadata, pending: true };
    await this.persist();
    if (!this.offline) {
      if (this.backgroundSync) void this.flush().catch(() => {});
      else await this.flushAssets();
    }
    return json({ schemaVersion: 1, asset: metadata }, 201);
  }

  async flushAssets() {
    for (const [id, asset] of Object.entries(this.state.assets)) {
      if (!asset.pending) continue;
      try {
        const response = await this.fetch(new Request(`${this.origin}${ENDPOINT}/assets/${encodeURIComponent(id)}`, {
          method: 'PUT', headers: { 'Content-Type': asset.metadata.mediaType }, body: await fs.readFile(this.assetPath(id))
        }));
        if (!response.ok) { if (response.status >= 500) this.offline = true; return false; }
        asset.pending = false;
        await this.persist();
      } catch { this.offline = true; this.onState(this.summary()); return false; }
    }
    return true;
  }

  async flushOne(id) {
    // A response can disappear after Community commits. Retry that exact
    // persisted request before rebasing any newer local changes.
    const attempt = this.backgroundSync && this.state.pending[id]?.attempt;
    if (attempt && !this.state.conflicts[id]) {
      try {
        const response = await this.fetch(new Request(attempt.url, {
          method: attempt.method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(attempt.body)
        }));
        if (!response.ok) return this.failedSync(id, response);
        const remote = serviceEnvelope((await response.json()).serviceDocument);
        this.offline = false;
        await this.acknowledgeRemote(id, remote, attempt.checkpointId);
      } catch { this.offline = true; this.onState(this.summary()); return; }
    }
    // Network work uses an immutable snapshot. Further local saves must remain
    // durable and editable while this older snapshot is uploading.
    const pending = this.backgroundSync && this.state.pending[id]
      ? structuredClone(this.state.pending[id]) : this.state.pending[id];
    if (!pending || this.state.conflicts[id]) return;
    if (!await this.flushAssets()) return;
    let response;
    try {
      if (pending.mode === 'create') {
        response = await this.syncRequest(id, `${this.origin}${ENDPOINT}`, 'POST', pending.create);
        if (!response.ok) return this.failedSync(id, response);
        const created = serviceEnvelope((await response.json()).serviceDocument);
        this.state.remoteBases[id] = { revision: created.revision, syncVersion: created.syncVersion };
        pending.mode = 'update'; pending.baseRevision = created.revision; pending.baseSyncVersion = created.syncVersion;
        if (this.backgroundSync) await this.acknowledgeRemote(id, created);
        await this.persist();
        if (!this.state.pending[id]) return;
        if (!this.backgroundSync && created.revision === this.state.documents[id].revision) {
          delete this.state.pending[id]; await this.persist(); return;
        }
      }
      for (const checkpointId of [...(pending.checkpoints || [])]) {
        const checkpoint = JSON.parse(await fs.readFile(path.join(this.rootPath, 'history', `${checkpointId}.json`), 'utf8'));
        response = await this.syncRequest(id, `${this.origin}${ENDPOINT}/${id}`, 'PUT', { schemaVersion: 1,
            requestId: checkpointId, syncId: id, baseRevision: pending.baseRevision, baseSyncVersion: pending.baseSyncVersion,
            documentSource: checkpoint.documentSource, status: checkpoint.status,
            saveKind: (this.state.history[id] || []).find(entry => entry.id === checkpointId)?.saveKind || 'manual' }, checkpointId);
        if (!response.ok) return this.failedSync(id, response);
        const remote = serviceEnvelope((await response.json()).serviceDocument);
        this.state.remoteBases[id] = { revision: remote.revision, syncVersion: remote.syncVersion };
        const historyEntry = (this.state.history[id] || []).find(entry => entry.id === checkpointId);
        if (historyEntry) historyEntry.remoteSyncVersion = remote.syncVersion;
        this.offline = false;
        pending.baseRevision = remote.revision; pending.baseSyncVersion = remote.syncVersion;
        pending.checkpoints.shift();
        if (this.backgroundSync) await this.acknowledgeRemote(id, remote, checkpointId);
        await this.persist();
        if (!this.state.pending[id]) return;
        if (!this.backgroundSync && !pending.checkpoints.length && pending.documentSource === remote.documentSource && pending.status === remote.status) {
          delete this.state.pending[id]; await this.persist(); return;
        }
      }
      response = await this.syncRequest(id, `${this.origin}${ENDPOINT}/${id}`, 'PUT', {
          schemaVersion: 1, requestId: pending.requestId, syncId: id,
          baseRevision: pending.baseRevision, baseSyncVersion: pending.baseSyncVersion,
          documentSource: pending.documentSource, status: pending.status, saveKind: pending.saveKind
        });
      if (!response.ok) return this.failedSync(id, response);
      this.offline = false;
      const remote = serviceEnvelope((await response.json()).serviceDocument);
      // The open editor holds the local version we acknowledged. Coalesced
      // server history has a different counter; preserve the local CAS counter
      // and remember the server base separately so editing can continue.
      this.state.remoteBases[id] = { revision: remote.revision, syncVersion: remote.syncVersion };
      const latest = (this.state.history[id] || []).at(-1);
      if (latest?.revision === remote.revision) latest.remoteSyncVersion = remote.syncVersion;
      if (this.backgroundSync) await this.acknowledgeRemote(id, remote);
      else delete this.state.pending[id];
      await this.persist();
    } catch { this.offline = true; this.onState(this.summary()); }
  }

  async syncRequest(id, url, method, body, checkpointId) {
    if (this.backgroundSync) await this.withDocumentLock(async () => {
      this.state.pending[id].attempt = { url, method, body, ...(checkpointId ? { checkpointId } : {}) };
      await this.persist();
    });
    return this.fetch(new Request(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }));
  }

  async acknowledgeRemote(id, remote, checkpointId) {
    return this.withDocumentLock(async () => {
      this.state.remoteBases[id] = { revision: remote.revision, syncVersion: remote.syncVersion };
      const latest = this.state.pending[id];
      if (!latest) return;
      latest.mode = 'update';
      latest.baseRevision = remote.revision;
      latest.baseSyncVersion = remote.syncVersion;
      delete latest.attempt;
      if (checkpointId) latest.checkpoints = (latest.checkpoints || []).filter(value => value !== checkpointId);
      if (!latest.checkpoints?.length && latest.documentSource === remote.documentSource && latest.status === remote.status) delete this.state.pending[id];
      await this.persist();
    });
  }

  async failedSync(id, response) {
    if (response.status === 409 || response.status === 412) {
      this.state.conflicts[id] = { at: new Date().toISOString(), message: 'Community and this computer both changed. Review both copies before syncing.' };
      await this.persist();
    } else if (response.status >= 500) { this.offline = true; this.onState(this.summary()); }
    else {
      // Permission/validation errors are never misrepresented as a synced save.
      this.state.conflicts[id] = { at: new Date().toISOString(), message: `Community rejected synchronization (${response.status}). Your local edits are preserved.` };
      await this.persist();
    }
  }

  async withDocumentLock(operation) {
    await this.loaded;
    const queued = this.queue.then(operation);
    this.queue = queued.catch(() => {});
    return queued;
  }

  async flush() {
    await this.loaded;
    const operation = (this.backgroundSync ? this.syncQueue : this.queue).then(async () => {
      if (this.backgroundSync) await this.queue;
      for (const id of Object.keys(this.state.pending)) await this.flushOne(id);
      return this.summary();
    });
    if (this.backgroundSync) this.syncQueue = operation.catch(() => {});
    else this.queue = operation.catch(() => {});
    return operation;
  }

  async reviewConflict(id) {
    await this.loaded;
    if (!this.state.conflicts[id]) throw new Error('This service has no pending conflict.');
    const response = await this.fetch(new Request(`${this.origin}${ENDPOINT}/${id}`, { headers: { Accept: 'application/json' } }));
    if (!response.ok) throw new Error('Reconnect Community before comparing versions.');
    const remote = serviceEnvelope((await response.json()).serviceDocument);
    const local = this.envelope(id);
    return { syncId: id, local, remote };
  }

  async resolveConflict(id, resolution, expectedRemoteRevision) {
    await this.loaded;
    const operation = this.queue.then(() => this.resolveConflictNow(id, resolution, expectedRemoteRevision));
    this.queue = operation.catch(() => {});
    return operation;
  }

  async resolveConflictNow(id, resolution, expectedRemoteRevision) {
    const review = await this.reviewConflict(id);
    if (review.remote.revision !== expectedRemoteRevision) throw new Error('Community changed again. Review the new version before choosing.');
    const archive = path.join(this.rootPath, 'conflict-copies');
    await atomicWriteFile(path.join(archive, `${crypto.randomUUID()}.json`), JSON.stringify(review), { rootPath: this.rootPath });
    if (resolution === 'use-community') {
      this.state.documents[id] = review.remote;
      this.state.remoteBases[id] = { revision: review.remote.revision, syncVersion: review.remote.syncVersion };
      delete this.state.pending[id]; delete this.state.conflicts[id];
    } else if (resolution === 'keep-local') {
      const pending = this.state.pending[id];
      if (!pending) throw new Error('There is no local change to synchronize.');
      Object.assign(pending, { mode: 'update', baseRevision: review.remote.revision,
        baseSyncVersion: review.remote.syncVersion, requestId: crypto.randomUUID(), saveKind: 'manual' });
      delete pending.attempt;
      delete this.state.conflicts[id];
      await this.persist();
      if (this.backgroundSync) void this.flush().catch(() => {});
      else await this.flushOne(id);
    } else throw new Error('Choose the version to keep.');
    await this.persist();
    return this.envelope(id);
  }

  async asset(id, assetId) {
    const request = new Request(`${this.origin}${ENDPOINT}/${id}/assets/${assetId}`);
    const response = await this.request(request);
    if (!response.ok) throw new Error(`Service asset ${assetId} is not available offline.`);
    return Buffer.from(await response.arrayBuffer());
  }
}

module.exports = { CommunityPlannerCache };
