'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { constants } = require('node:fs');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { CommunityPlannerCache } = require('../src/services/community/CommunityPlannerCache');
const { ServiceProjectStore } = require('../src/services/project/ServiceProjectStore');
const core = require('../src/services/community/HeritageServiceDocument');

async function fixture(t, overrides = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'planner-durability-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const cache = new CommunityPlannerCache({ rootPath: path.join(root, 'cache'), origin: 'https://heritage.test',
    fetch: async () => { throw new Error('offline'); }, inspectImage: async () => ({ width: 10, height: 10 }), ...overrides });
  await cache.loaded;
  cache.offline = true;
  const { project } = await new ServiceProjectStore({ rootPath: path.join(root, 'projects') })
    .create({ id: 'active-service', title: 'Local service', serviceDate: '2026-10-04', profileId: 'main-sanctuary' });
  const validated = core.validateHeritageServiceDocumentSource(core.serializeHeritageServiceDocument(core.createHeritageServiceDocument(project)));
  const envelope = { ...validated, schemaVersion: 1, syncId: project.id, syncVersion: 7, status: 'ready', changedAt: project.updatedAt };
  cache.state.documents[project.id] = envelope;
  return { cache, envelope };
}

async function publishedFlushes(rootPath, operation, fail = () => false) {
  const originalOpen = fs.open;
  const flushed = [];
  fs.open = async function(candidate, flags, ...args) {
    const handle = await originalOpen.call(fs, candidate, flags, ...args);
    // The published-file barrier uses a read/write descriptor. Staging writes
    // and directory barriers must not be mistaken for publication durability.
    if (typeof flags !== 'number' || !(flags & constants.O_RDWR) || !String(candidate).startsWith(rootPath)) return handle;
    const relative = path.relative(rootPath, String(candidate)).split(path.sep).join('/');
    return new Proxy(handle, { get(target, property) {
      if (property === 'sync') return async () => {
        if (fail(relative)) throw Object.assign(new Error('Published file flush failed'), { code: 'EIO' });
        await target.sync();
        flushed.push(relative);
      };
      const value = Reflect.get(target, property);
      return typeof value === 'function' ? value.bind(target) : value;
    } });
  };
  try { await operation(flushed); }
  finally { fs.open = originalOpen; }
  return flushed;
}

test('a planner journal is flushed by its published name before reporting a local save', async t => {
  const { cache } = await fixture(t);
  await publishedFlushes(cache.rootPath, async flushed => {
    let notifications = 0;
    cache.onState = () => { assert.equal(flushed.at(-1), 'journal.json'); notifications++; };
    await cache.persist();
    cache.state.workspaceLanguage = 'ru';
    await cache.persist();
    assert.equal(notifications, 2);
    assert.deepEqual(flushed, ['journal.json', 'journal.json']);
  });
  assert.equal(JSON.parse(await fs.readFile(path.join(cache.rootPath, 'journal.json'))).workspaceLanguage, 'ru');
});

test('a failed published journal flush is not acknowledged and later writes can recover', async t => {
  const { cache } = await fixture(t);
  let notifications = 0;
  cache.onState = () => { notifications++; };
  await publishedFlushes(cache.rootPath, async () => {
    await assert.rejects(cache.persist(), { code: 'EIO' });
    assert.equal(notifications, 0);
  }, relative => relative === 'journal.json');
  await cache.persist();
  assert.equal(notifications, 1);
  assert.equal((await fs.readdir(cache.rootPath)).some(name => name.endsWith('.tmp')), false);
});

test('offline media and version checkpoints are flushed before the journal can reference them', async t => {
  const { cache, envelope } = await fixture(t);
  const bytes = Buffer.from('fixture-image-bytes');
  const id = `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`;
  const flushed = await publishedFlushes(cache.rootPath, async entries => {
    const checkpoint = await cache.appendHistory(envelope.syncId, 'manual');
    assert.deepEqual(entries, [`history/${checkpoint.id}.json`]);
    const result = await cache.saveAsset(new Request('https://heritage.test/asset', { method: 'PUT', headers: { 'Content-Type': 'image/png' }, body: bytes }), id);
    assert.equal(result.status, 201);
    assert.deepEqual(entries.slice(-2), [`assets/${id.slice(7)}`, 'journal.json']);
  });
  assert.equal(flushed.length, 3);
  const saved = JSON.parse(await fs.readFile(path.join(cache.rootPath, 'journal.json')));
  assert.equal(saved.assets[id].pending, true);
  assert.equal(saved.history[envelope.syncId].length, 1);
});

test('a failed checkpoint flush cannot add an unusable version to history', async t => {
  const { cache, envelope } = await fixture(t);
  await publishedFlushes(cache.rootPath, async () => {
    await assert.rejects(cache.appendHistory(envelope.syncId, 'manual'), { code: 'EIO' });
    assert.equal(cache.state.history[envelope.syncId], undefined);
  }, relative => relative.startsWith('history/'));
});

test('a failed conflict archive flush preserves both pending choices before resolution', async t => {
  const { cache, envelope } = await fixture(t);
  cache.state.conflicts[envelope.syncId] = { message: 'Review both copies' };
  cache.state.pending[envelope.syncId] = { documentSource: envelope.documentSource };
  cache.fetch = async () => new Response(JSON.stringify({ serviceDocument: envelope }));
  await publishedFlushes(cache.rootPath, async entries => {
    await assert.rejects(cache.resolveConflict(envelope.syncId, 'use-community', envelope.revision), { code: 'EIO' });
    assert.ok(cache.state.conflicts[envelope.syncId]);
    assert.ok(cache.state.pending[envelope.syncId]);
    assert.equal(entries.includes('journal.json'), false);
  }, relative => relative.startsWith('conflict-copies/'));
});
