'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs/promises'), path = require('node:path'), os = require('node:os');
const JSZip = require('jszip'), sharp = require('sharp');
const { ServiceProjectStore } = require('../src/services/project/ServiceProjectStore');
const { addProjectItem } = require('../src/services/project');
const { LegacyServiceFallback } = require('../src/services/project/LegacyServiceFallback');
const { imagePowerPoint } = require('../src/services/project/ImagePowerPoint');

async function fixture(t) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'fallback-test-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = new ServiceProjectStore({ rootPath: path.join(root, 'projects') });
  const created = await store.create({ id: 'test-service', title: 'Today', serviceDate: '2026-10-04', profileId: 'test-venue' });
  const project = addProjectItem(created.project, { id: 'greeting', kind: 'notice', title: 'Welcome',
    textByChannel: { primary: 'Welcome', media: 'Добро пожаловать' }, presetId: 'notice-text' });
  const saved = await store.save(project, { expectedRevisionId: created.revisionId });
  const image = await sharp({ create: { width: 1920, height: 1080, channels: 3, background: '#346789' } }).jpeg().toBuffer();
  const renders = [];
  let disposed = 0;
  const service = new LegacyServiceFallback({ rootPath: path.join(root, 'exports'), cacheRoot: path.join(root, 'cache'),
    projectStore: store, rendererFactory: () => ({ renderScene: async scene => { renders.push(scene); return { info: { data: image } }; },
      dispose: async () => { disposed += 1; } }) });
  return { root, service, store, saved, renders, image, disposed: () => disposed,
    request: { projectId: saved.project.id, revisionId: saved.revisionId, roleMapping: { english: 'primary', russian: 'media' } } };
}

test('fallback exports and loads every exact selected output with matching cue counts', async t => {
  const f = await fixture(t), built = await f.service.build(f.request);
  assert.equal(f.disposed(), 1);
  assert.deepEqual(f.renders.map(scene => scene.body), ['Welcome', 'Добро пожаловать']);
  for (const role of ['english', 'russian']) {
    const presentation = built.presentations[role];
    const archive = await JSZip.loadAsync(await fs.readFile(presentation.metadata.originalFile));
    assert.deepEqual(await archive.file('ppt/media/image1.jpg').async('nodebuffer'), f.image);
    assert.match(await archive.file('ppt/slides/slide1.xml').async('string'), /<p:pic>/);
    assert.equal(presentation.metadata.nativeFallback.revisionId, f.saved.revisionId);
    assert.equal(presentation.metadata.restoreContext.groupId, path.basename(built.directory));
  }
  await f.service.activate(built);
  for (const role of ['english', 'russian']) {
    assert.equal(built.presentations[role].cacheDir, path.join(f.root, 'cache', role));
    await f.service.converter.validateGeneration(built.presentations[role].cacheDir, 1);
  }
});

test('conversion failure never replaces the previous decks and removes incomplete output', async t => {
  const f = await fixture(t), cache = path.join(f.root, 'cache', 'english');
  await fs.mkdir(cache, { recursive: true }); await fs.writeFile(path.join(cache, 'old.txt'), 'last week');
  f.service.rendererFactory = () => ({ renderScene: async () => { throw new Error('Cannot fit'); }, dispose: async () => {} });
  await assert.rejects(f.service.build(f.request), /Cannot fit/);
  assert.equal(await fs.readFile(path.join(cache, 'old.txt'), 'utf8'), 'last week');
  assert.deepEqual(await fs.readdir(path.join(f.root, 'exports')), []);
});

test('stale revisions are rejected before conversion', async t => {
  const f = await fixture(t);
  await assert.rejects(f.service.build({ ...f.request, revisionId: 'old-revision' }), /changed/);
  assert.equal(f.renders.length, 0);
});

test('a partial cache activation rolls back previously replaced roles', async t => {
  const f = await fixture(t), built = await f.service.build(f.request);
  const cache = path.join(f.root, 'cache'); await fs.mkdir(path.join(cache, 'english'), { recursive: true });
  await fs.writeFile(path.join(cache, 'english', 'old.txt'), 'last week');
  await fs.writeFile(path.join(cache, 'russian'), 'not a directory');
  await assert.rejects(f.service.activate(built), /unsafe/);
  assert.equal(await fs.readFile(path.join(cache, 'english', 'old.txt'), 'utf8'), 'last week');
  assert.equal(await fs.readFile(path.join(cache, 'russian'), 'utf8'), 'not a directory');
});

test('activation uses only cache-volume renames even when exports are on another drive', async t => {
  const f = await fixture(t), built = await f.service.build(f.request);
  const rename = fs.rename;
  t.after(() => { fs.rename = rename; });
  fs.rename = async (source, destination) => {
    if (!source.startsWith(`${f.service.cacheRoot}${path.sep}`)) {
      throw Object.assign(new Error('cross-device rename'), { code: 'EXDEV' });
    }
    return rename(source, destination);
  };
  await f.service.activate(built);
  for (const role of ['english', 'russian']) {
    await f.service.converter.validateGeneration(built.presentations[role].cacheDir, 1);
  }
  assert.equal((await fs.readdir(f.service.cacheRoot)).some(name => name.startsWith('.fallback-')), false);
});

test('PowerPoint export validates input and escapes its title XML', async t => {
  const f = await fixture(t);
  await assert.rejects(imagePowerPoint([]), /count/);
  const archive = await JSZip.loadAsync(await imagePowerPoint([{ image: f.image, title: 'A < B & "test"' }]));
  assert.match(await archive.file('ppt/slides/slide1.xml').async('string'), /A &lt; B &amp; &quot;test&quot;/);
});
