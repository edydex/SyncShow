'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { CommunityPlannerCache } = require('../src/services/community/CommunityPlannerCache');
const { createOfflinePlannerBible } = require('../src/services/community/OfflinePlannerBible');
const core = require('../src/services/community/HeritageServiceDocument');
const origin = 'https://community.test';
const endpoint = `${origin}/api/community/service-documents`;
const response = value => new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } });
const mutation = (id, raw, method = 'PUT') => new Request(method === 'POST' ? endpoint : `${endpoint}/${id}`, {
  method, headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify(raw)
});

async function setup(t) {
  const rootPath = await fs.mkdtemp(path.join(os.tmpdir(), 'planner-cache-'));
  t.after(() => fs.rm(rootPath, { recursive: true, force: true }));
  let online = true, reject = false, saved;
  const writes = [];
  const fetch = async request => {
    if (!online) throw new Error('offline');
    if (request.method === 'POST') {
      const raw = await request.json(); writes.push(raw);
      const now = new Date().toISOString();
      const project = { schemaVersion: 1, kind: 'syncshow-service-project', id: raw.syncId, title: raw.title,
        serviceDate: raw.serviceDate, createdAt: now, updatedAt: now, revision: 1, preferredProfileId: 'main-sanctuary', channelIds: ['english', 'russian', 'media'],
        channels: { english: { id: 'english', label: 'English', language: 'en' }, russian: { id: 'russian', label: 'Russian', language: 'ru' }, media: { id: 'media', label: 'Media', language: 'und' } },
        rootItemIds: [], items: {}, resources: {}, assets: {}, presetPack: { id: 'main-sanctuary', version: 1, sha256: null } };
      const validated = core.validateHeritageServiceDocumentSource(core.serializeHeritageServiceDocument(core.createHeritageServiceDocument(project)));
      saved = { ...validated, schemaVersion: 1, syncId: raw.syncId, syncVersion: 7, status: 'planning', changedAt: now };
      return response({ serviceDocument: saved });
    }
    if (request.method === 'PUT') {
      const raw = await request.json(); writes.push(raw);
      if (reject || raw.baseRevision !== saved.revision || raw.baseSyncVersion !== saved.syncVersion) return responseError(412);
      const validated = core.validateHeritageServiceDocumentSource(raw.documentSource);
      saved = { ...validated, schemaVersion: 1, syncId: raw.syncId, syncVersion: saved.syncVersion + 1, status: raw.status, changedAt: new Date().toISOString() };
      return response({ serviceDocument: saved });
    }
    return response({ serviceDocument: saved });
  };
  const cache = new CommunityPlannerCache({ rootPath, origin, fetch });
  await cache.loaded;
  return { cache, rootPath, fetch, writes, online: value => online = value, reject: value => reject = value,
    saved: () => saved, updateServer: title => {
      const project = structuredClone(saved.project); project.title = title; project.revision += 1;
      const validated = core.validateHeritageServiceDocumentSource(core.serializeHeritageServiceDocument(core.createHeritageServiceDocument(project)));
      saved = { ...saved, ...validated, syncVersion: saved.syncVersion + 1 };
      return saved;
    } };
}
function responseError(status) { return new Response(JSON.stringify({ error: 'conflict' }), { status }); }
async function create(cache) {
  const result = await cache.request(mutation('service-2026-10-04', { schemaVersion: 1, requestId: 'create-test-123', syncId: 'service-2026-10-04', title: 'Sunday', serviceDate: '2026-10-04' }, 'POST'));
  assert.equal(result.status, 201);
  return (await result.json()).serviceDocument;
}
async function edit(cache, saved, title, saveKind = 'manual') {
  const project = structuredClone(saved.project); project.title = title; project.revision += 1;
  const documentSource = core.serializeHeritageServiceDocument(core.createHeritageServiceDocument(project));
  const result = await cache.request(mutation(saved.syncId, { schemaVersion: 1, requestId: `save-${project.revision}-123`, syncId: saved.syncId,
    baseRevision: saved.revision, baseSyncVersion: saved.syncVersion, documentSource, status: 'planning', saveKind }));
  assert.equal(result.status, 200);
  return (await result.json()).serviceDocument;
}

test('same editor saves offline, survives restart, and reconnects from oldest remote base', async t => {
  const fixture = await setup(t), { cache } = fixture;
  let saved = await create(cache); const base = fixture.saved();
  fixture.online(false);
  saved = await edit(cache, saved, 'First offline edit');
  saved = await edit(cache, saved, 'Second offline edit');
  assert.equal(saved.desktop.pending, true);
  const reopened = new CommunityPlannerCache({ rootPath: fixture.rootPath, origin, fetch: fixture.fetch });
  await reopened.loaded;
  assert.equal(reopened.envelope(saved.syncId).project.title, 'Second offline edit');
  fixture.online(true); await reopened.flush();
  const last = fixture.writes.at(-1);
  const firstReplay = fixture.writes.find(value => value.documentSource?.includes("First offline edit"));
  assert.equal(firstReplay.baseRevision, base.revision); assert.equal(firstReplay.baseSyncVersion, base.syncVersion);
  assert.equal(last.saveKind, 'manual');
  assert.equal(reopened.summary().pending, 0);
  assert.equal(fixture.saved().project.title, 'Second offline edit');
});

test('concurrent remote edits keep both copies and never retry an overwrite', async t => {
  const fixture = await setup(t); let saved = await create(fixture.cache);
  fixture.online(false); saved = await edit(fixture.cache, saved, 'Local pastor edit');
  fixture.online(true); fixture.reject(true);
  const remoteTitle = fixture.saved().project.title;
  await fixture.cache.flush(); const count = fixture.writes.length;
  await fixture.cache.flush();
  assert.equal(fixture.writes.length, count);
  assert.equal(fixture.saved().project.title, remoteTitle);
  assert.equal(fixture.cache.envelope(saved.syncId).project.title, 'Local pastor edit');
  assert.deepEqual(fixture.cache.summary().conflicts, [saved.syncId]);
});

test('a service created offline is created once and its later edits sync', async t => {
  const fixture = await setup(t); fixture.online(false);
  let saved = await create(fixture.cache); saved = await edit(fixture.cache, saved, 'Offline new service');
  fixture.online(true); await fixture.cache.flush();
  assert.equal(fixture.writes.filter(value => value.title).length, 1);
  assert.equal(fixture.saved().project.title, 'Offline new service');
  assert.equal(fixture.cache.summary().pending, 0);
});

test('offline history groups automatic saves and keeps manual checkpoints during replay', async t => {
  const fixture = await setup(t); let saved = await create(fixture.cache);
  const initialWrites = fixture.writes.length;
  fixture.online(false);
  saved = await edit(fixture.cache, saved, 'Automatic one', 'automatic');
  saved = await edit(fixture.cache, saved, 'Automatic two', 'automatic');
  saved = await edit(fixture.cache, saved, 'Manual checkpoint', 'manual');
  saved = await edit(fixture.cache, saved, 'Latest automatic', 'automatic');
  const history = await (await fixture.cache.request(new Request(`${endpoint}/${saved.syncId}/history`))).json();
  assert.deepEqual(history.groups.slice(0, 3).map(group => [group.saveKind, group.entries.length]),
    [['automatic', 1], ['manual', 1], ['automatic', 3]]);
  const selected = history.groups[1].entries[0];
  const restored = await (await fixture.cache.request(new Request(`${endpoint}/${saved.syncId}/history/${selected.syncVersion}`))).json();
  assert.equal(restored.serviceDocument.project.title, 'Manual checkpoint');
  fixture.online(true); await fixture.cache.flush();
  assert.deepEqual(fixture.writes.slice(initialWrites).filter(write => write.documentSource).map(write => write.saveKind), ['manual', 'automatic']);
  assert.equal(fixture.saved().project.title, 'Latest automatic');
  const next = await edit(fixture.cache, saved, 'Continued without reopening', 'automatic');
  assert.equal(next.pending, false, 'the editor can continue from its acknowledged local version');
  assert.equal(next.conflict, false);
  assert.equal(fixture.saved().project.title, 'Continued without reopening');
});

test('conflict resolution rechecks the reviewed version and archives both copies', async t => {
  const fixture = await setup(t); let saved = await create(fixture.cache);
  fixture.online(false); saved = await edit(fixture.cache, saved, 'Local pastor edit');
  const remote = fixture.updateServer('Community pastor edit');
  fixture.online(true); await fixture.cache.flush();
  const review = await fixture.cache.reviewConflict(saved.syncId);
  assert.equal(review.local.project.title, 'Local pastor edit');
  assert.equal(review.remote.project.title, 'Community pastor edit');
  fixture.updateServer('Community changed after review');
  await assert.rejects(fixture.cache.resolveConflict(saved.syncId, 'keep-local', remote.revision), /changed again/);
  const refreshed = await fixture.cache.reviewConflict(saved.syncId);
  const chosen = await fixture.cache.resolveConflict(saved.syncId, 'keep-local', refreshed.remote.revision);
  assert.equal(chosen.conflict, false); assert.equal(chosen.pending, false);
  assert.equal(fixture.saved().project.title, 'Local pastor edit');
  const archives = await fs.readdir(path.join(fixture.rootPath, 'conflict-copies'));
  assert.equal(archives.length, 1);
  const archive = JSON.parse(await fs.readFile(path.join(fixture.rootPath, 'conflict-copies', archives[0]), 'utf8'));
  assert.equal(archive.remote.project.title, 'Community changed after review');
  assert.equal(archive.local.project.title, 'Local pastor edit');
});

test('choosing Community preserves a recovery copy and does not send a local overwrite', async t => {
  const fixture = await setup(t); let saved = await create(fixture.cache);
  fixture.online(false); saved = await edit(fixture.cache, saved, 'Local edit');
  const remote = fixture.updateServer('Community choice');
  fixture.online(true); await fixture.cache.flush();
  const writeCount = fixture.writes.length;
  const chosen = await fixture.cache.resolveConflict(saved.syncId, 'use-community', remote.revision);
  assert.equal(chosen.project.title, 'Community choice'); assert.equal(chosen.pending, false);
  assert.equal(fixture.writes.length, writeCount);
  assert.equal((await fs.readdir(path.join(fixture.rootPath, 'conflict-copies'))).length, 1);
});

test('offline insertion resolves uncached English and Russian passage text from bundled sources', async () => {
  const lookup = createOfflinePlannerBible();
  const result = await lookup({ schemaVersion: 1, bookId: 'John', chapter: 1, startVerse: 1, endVerse: 12,
    translations: { english: 'BSB', russian: 'SYNO-W' } });
  assert.equal(result.passagesByChannel.english.verses.length, 12);
  assert.equal(result.passagesByChannel.russian.verses.length, 12);
  assert.match(result.passagesByChannel.russian.verses[0].text, /В начале было Слово/);
});

test('downloaded song library details remain available when adding songs offline', async t => {
  const fixture = await setup(t);
  let online = true;
  const song = { schemaVersion: 1, song: {syncId:'fixture-song',documentSource:'original pinned song source'} };
  const cache = new CommunityPlannerCache({rootPath:fixture.rootPath,origin,fetch:async request=>{
    if(!online)throw new Error('offline');
    return response(request.url.endsWith('/library/songs') ? {items:[{syncId:'fixture-song',title:'Rehearsal song'}]} : song);
  }});
  const catalog = new Request(`${endpoint}/library/songs`,{headers:{Accept:'application/json'}});
  await cache.request(catalog);
  await cache.prefetchSongs([{syncId:'fixture-song'}]);
  online=false;
  const detail=await (await cache.request(new Request(`${endpoint}/library/songs/fixture-song`,{headers:{Accept:'application/json'}}))).json();
  assert.deepEqual(detail,song);
  assert.equal((await (await cache.request(catalog)).json()).items[0].title,'Rehearsal song');
});

test('a delayed read cannot replace an acknowledged newer local save', async t => {
  const fixture = await setup(t);let saved=await create(fixture.cache);
  const old=structuredClone(fixture.saved());let release;let started;
  const began=new Promise(resolve=>started=resolve);
  const originalFetch=fixture.cache.fetch;
  fixture.cache.fetch=async request=>{
    if(request.method==='GET') {started();await new Promise(resolve=>release=resolve);return response({serviceDocument:old});}
    return originalFetch(request);
  };
  const reading=fixture.cache.request(new Request(`${endpoint}/${saved.syncId}`,{headers:{Accept:'application/json'}}));
  await began;saved=await edit(fixture.cache,saved,'A newer acknowledged save');release();
  const read=await (await reading).json();
  assert.equal(read.serviceDocument.project.title,'A newer acknowledged save');
  assert.equal(fixture.cache.envelope(saved.syncId).project.title,'A newer acknowledged save');
});


test('approved device locale survives restart and applies before offline editor mounts', async t => {
  const { rootPath } = await setup(t);
  let online = true;
  const cache = new CommunityPlannerCache({ rootPath, origin, fetch: async request => {
    if (!online) throw new Error('offline');
    if (new URL(request.url).pathname === '/admin/plan-service') return new Response('<!doctype html><html lang="en"><body>Editor</body></html>', {headers:{'Content-Type':'text/html'}});
    return response({items:[],workspaceLanguage:'ru',workspaceLanguageSource:'device'});
  }});
  const page = new Request(`${origin}/admin/plan-service`,{headers:{Accept:'text/html'}});
  await cache.request(page);
  assert.equal((await (await cache.request(new Request(endpoint))).json()).workspaceLanguage, 'ru');
  online = false;
  const reopened = new CommunityPlannerCache({rootPath,origin,fetch:cache.fetch});
  const html = await (await reopened.request(page)).text();
  assert.match(html, /<html lang="ru">/);
  assert.equal((await (await reopened.request(new Request(endpoint))).json()).workspaceLanguageSource, 'device');
});

function gate() { let resolve; const promise=new Promise(done=>resolve=done);return {promise,resolve}; }
test('durable local saves and manual checkpoints continue while an older server upload is stalled', async t => {
  const f=await setup(t);let saved=await create(f.cache);f.cache.backgroundSync=true;
  const started=gate(),release=gate();let first=true;
  f.cache.fetch=async request=>{if(request.method==='PUT'&&first){first=false;started.resolve();await release.promise;}return f.fetch(request);};
  const start=performance.now();saved=await edit(f.cache,saved,'First edit','automatic');
  await started.promise;
  saved=await edit(f.cache,saved,'Manual while syncing','manual');
  saved=await edit(f.cache,saved,'Latest edit','automatic');
  assert(performance.now()-start<1500,'local save must not wait for the held upload');
  assert.equal(f.cache.envelope(saved.syncId).project.title,'Latest edit');
  const persisted=JSON.parse(await fs.readFile(path.join(f.rootPath,'journal.json'),'utf8'));
  assert.equal(persisted.documents[saved.syncId].project.title,'Latest edit');
  assert.equal(persisted.pending[saved.syncId].attempt.body.saveKind,'automatic');
  release.resolve();await f.cache.flush();
  assert.equal(f.saved().project.title,'Latest edit');
  assert.equal(f.cache.summary().pending,0);
  assert.equal(f.cache.summary().conflicts.length,0);
  assert(f.writes.some(write=>write.saveKind==='manual'&&JSON.parse(write.documentSource).project.title==='Manual while syncing'));
});
test('a lost server acknowledgement is replayed before newer background edits, including after restart', async t => {
  const f=await setup(t);let saved=await create(f.cache);f.cache.backgroundSync=true;
  let lose=true;const replies=new Map();
  const fetch=async request=>{
    const raw=await request.clone().json();
    if(replies.has(raw.requestId))return replies.get(raw.requestId).clone();
    const result=await f.fetch(request);replies.set(raw.requestId,result.clone());
    if(lose){lose=false;throw new Error('Committed, but response lost');}return result;
  };
  f.cache.fetch=fetch;
  saved=await edit(f.cache,saved,'Committed first','automatic');await f.cache.syncQueue;
  f.cache.offline=true;
  saved=await edit(f.cache,saved,'Newer local edit','automatic');
  const restored=new CommunityPlannerCache({rootPath:f.rootPath,origin,fetch,backgroundSync:true});
  await restored.loaded;await restored.flush();
  assert.equal(f.saved().project.title,'Newer local edit');
  assert.equal(restored.envelope(saved.syncId).project.title,'Newer local edit');
  assert.equal(restored.summary().pending,0);
  assert.deepEqual(restored.summary().conflicts,[]);
});
