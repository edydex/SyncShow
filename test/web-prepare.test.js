'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const JSZip = require('jszip');
const { ServiceProjectExchange, suggestedFileName, portableServiceExportPath, BUNDLE_FILE_EXTENSIONS, serializeManifest } = require('../src/services/project/ServiceProjectExchange');
const { serializeServiceProject } = require('../src/services/project/ServiceProject');
const root = path.resolve(__dirname, '..');
test.before(async () => { await import('../scripts/build-web-prepare.mjs'); });

async function browser() {
  const context = vm.createContext({ TextEncoder, TextDecoder, Uint8Array, ArrayBuffer, DataView, crypto: crypto.webcrypto });
  for (const file of ['service-core.js', 'portable.js', 'editor-model.js']) vm.runInContext(await fs.readFile(path.join(root, 'web-prepare/dist', file), 'utf8'), context);
  return context;
}
function project(context) {
  return vm.runInContext(`SyncShowCore.addProjectItem(SyncShowCore.createServiceProject({id:'browser-test',title:'Local service',serviceDate:'2026-10-25',profileId:'test-profile'}),{id:'welcome',kind:'notice',title:'Welcome',textByChannel:{primary:'Welcome — Добро пожаловать'},operatorNotes:'Private local note',createdAt:'2026-10-23T00:00:00.000Z',updatedAt:'2026-10-23T00:00:00.000Z',presetId:'notice-text'})`, context);
}
const native = value => JSON.parse(JSON.stringify(value));
function receiver() {
  return new ServiceProjectExchange({ projectStore: {
    read() {}, resolveAssetPath() {},
    async importPortableProject(project, assets) { return { imported: true, project, assets }; },
  } });
}

test('browser-created service enters the real desktop portable importer without a schema conversion', async () => {
  const context = await browser(), value = project(context);
  const exported = context.SyncShowPortable.writeBundle(value);
  assert.match(exported.fileName, /\.libreshow$/);
  const imported = await receiver().importBundle(Buffer.from(exported.bytes));
  assert.equal(imported.imported, true);
  assert.equal(serializeServiceProject(imported.project), serializeServiceProject(native(value)));
});

test('desktop-exported bundle enters browser and returns with its full project and image bytes intact', async t => {
  const context = await browser();
  const image = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl1sAAAAASUVORK5CYII=', 'base64');
  const hash = crypto.createHash('sha256').update(image).digest('hex'), id = `sha256:${hash}`;
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'libre-browser-roundtrip-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const imagePath = path.join(directory, `${hash}.png`); await fs.writeFile(imagePath, image);
  context.imageAsset = { id, kind: 'image', fileName: 'original.png', storedName: `${hash}.png`, mediaType: 'image/png', sha256: hash, size: image.length, width: 1, height: 1 };
  context.inputProject = native(project(context));
  const withImage = vm.runInContext(`(() => { const value=JSON.parse(JSON.stringify(inputProject)); value.assets[imageAsset.id]=JSON.parse(JSON.stringify(imageAsset)); return SyncShowCore.normalizeServiceProject(value); })()`, context);
  const canonical = serializeServiceProject(native(withImage));
  const revisionId = crypto.createHash('sha256').update(canonical).digest('hex');
  const desktop = new ServiceProjectExchange({ appVersion: '2.1.0', projectStore: {
    async read() { return { project: native(withImage), revisionId }; },
    async resolveAssetPath() { return { assetPath: imagePath }; },
    importPortableProject() {},
  } });
  const exported = await desktop.exportBundle(withImage.id, revisionId);
  const loaded = context.SyncShowPortable.readBundle(new Uint8Array(exported.buffer));
  const returned = context.SyncShowPortable.writeBundle(loaded.project, loaded.assets);
  const imported = await receiver().importBundle(Buffer.from(returned.bytes));
  assert.equal(serializeServiceProject(imported.project), canonical);
  assert.deepEqual(Buffer.from(imported.assets.get(id)), image);
});

test('browser rejects changed checksums, undeclared entries and oversized files without a partial import', async () => {
  const context = await browser(), original = context.SyncShowPortable.writeBundle(project(context));
  for (const mutate of [
    async zip => zip.file('project.json', (await zip.file('project.json').async('string')).replace('Welcome', 'Changed')),
    async zip => zip.file('undeclared.txt', 'must not disappear'),
    async zip => zip.file('../outside', 'must not be extracted'),
  ]) {
    const zip = await JSZip.loadAsync(Buffer.from(original.bytes)); await mutate(zip);
    const changed = await zip.generateAsync({ type: 'nodebuffer', compression: 'STORE', platform: 'UNIX' });
    assert.throws(() => context.SyncShowPortable.readBundle(new Uint8Array(changed)));
  }
  assert.throws(() => context.SyncShowPortable.readBundle(new Uint8Array(32 * 1024 * 1024 + 1)), /32 MiB/);
  const reopened = context.SyncShowPortable.readBundle(original.bytes);
  assert.equal(reopened.project.items.welcome.textByChannel.primary, 'Welcome — Добро пожаловать');
});

test('browser artifact uses local scripts and blocks network uploads without changing a church origin', async () => {
  const headers = await fs.readFile(path.join(root, 'web-prepare/_headers'), 'utf8');
  assert.match(headers, /connect-src 'none'/);
  assert.match(headers, /form-action 'none'/);
  const app = await fs.readFile(path.join(root, 'web-prepare/app.js'), 'utf8');
  assert.doesNotMatch(app, /\b(?:fetch|XMLHttpRequest|WebSocket|sendBeacon)\s*\(/);
  assert.doesNotMatch(app, /wotbc\.heritage\.faith|heritage\.faith/);
  const html = await fs.readFile(path.join(root, 'web-prepare/index.html'), 'utf8');
  assert.match(html, /Recovery copies, including pending text changes/i);
  assert.match(app, /confirm-download/);
});

test('new and legacy filename choices keep identical archives and desktop path normalization accepts both', async () => {
  const context = await browser(), value = project(context);
  const branded = context.SyncShowPortable.writeBundle(value);
  const legacy = context.SyncShowPortable.writeBundle(value, undefined, { fileExtension: '.syncshow-service' });
  assert.deepEqual(Buffer.from(branded.bytes), Buffer.from(legacy.bytes));
  assert.match(branded.fileName, /\.libreshow$/); assert.match(legacy.fileName, /\.syncshow-service$/);
  assert.deepEqual(BUNDLE_FILE_EXTENSIONS, ['libreshow', 'syncshow-service']);
  for (const name of ['/tmp/service.libreshow', '/tmp/service.syncshow-service', '/tmp/SERVICE.LIBRESHOW']) assert.equal(portableServiceExportPath(name), name);
  assert.equal(portableServiceExportPath('/tmp/service'), '/tmp/service.libreshow');
  assert.throws(() => suggestedFileName(value, '.zip'), /Choose/);
  assert.match(suggestedFileName(value), /\.syncshow-service$/); // Existing API callers retain their default.
  const nativeProject = native(value), source = serializeServiceProject(nativeProject);
  const revisionId = crypto.createHash('sha256').update(source).digest('hex');
  const exporter = new ServiceProjectExchange({ appVersion: 'test', projectStore: {
    async read() { return { project: nativeProject, revisionId }; }, resolveAssetPath() {}, importPortableProject() {},
  } });
  const nativeNew = await exporter.exportBundle(value.id, revisionId, { fileExtension: '.libreshow' });
  const nativeOld = await exporter.exportBundle(value.id, revisionId);
  assert.match(nativeNew.fileName, /\.libreshow$/); assert.match(nativeOld.fileName, /\.syncshow-service$/);
  assert.deepEqual(nativeNew.buffer, nativeOld.buffer);
  const main = await fs.readFile(path.join(root, 'main.js'), 'utf8');
  assert.match(main, /fileExtension: LIBRESHOW_EXTENSION/);
  assert.equal((main.match(/extensions: \[\.\.\.BUNDLE_FILE_EXTENSIONS\]/g) || []).length, 2);
  assert.match(main, /portableServiceExportPath\(selected\.filePath\)/);
});

test('unknown future fields are rejected even with internally consistent archive checksums', async () => {
  const context = await browser(), original = context.SyncShowPortable.writeBundle(project(context));
  const zip = await JSZip.loadAsync(Buffer.from(original.bytes));
  const rawProject = JSON.parse(await zip.file('project.json').async('string'));
  rawProject.futureFeature = { privateContent: 'must not be discarded' };
  const source = JSON.stringify(rawProject, null, 2) + '\n';
  const digest = crypto.createHash('sha256').update(source).digest('hex');
  const manifest = JSON.parse(await zip.file('manifest.json').async('string'));
  manifest.project.size = Buffer.byteLength(source); manifest.project.sha256 = digest; manifest.project.revisionId = digest;
  const stable = value => Array.isArray(value) ? value.map(stable) : value && typeof value === 'object'
    ? Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])])) : value;
  const { bundleId, ...base } = manifest;
  manifest.bundleId = crypto.createHash('sha256').update(JSON.stringify(stable(base)) + '\n').digest('hex');
  zip.file('project.json', source); zip.file('manifest.json', serializeManifest(manifest));
  const bytes = await zip.generateAsync({ type: 'nodebuffer', compression: 'STORE', platform: 'UNIX' });
  assert.throws(() => context.SyncShowPortable.readBundle(new Uint8Array(bytes)), /canonical|unsupported|invalid/i);
  await assert.rejects(receiver().importBundle(bytes), /canonical|unsupported|invalid/i);
});

test('browser ordering, duplication and compiled preview use maintained core mutations', async () => {
  const context = await browser();
  context.currentProject = project(context);
  const result = vm.runInContext(`(() => {
    const added=LibreShowEditor.add(currentProject,'blank',null);
    const moved=LibreShowEditor.move(added.project,added.selected,-1);
    const duplicated=LibreShowEditor.duplicate(moved,'welcome');
    return {moved,duplicated,preview:LibreShowEditor.preview(duplicated.project,'welcome','primary')};
  })()`, context);
  assert.equal(result.moved.rootItemIds[1], 'welcome');
  assert.equal(result.duplicated.project.rootItemIds.length, 3);
  assert.equal(result.duplicated.project.items.welcome.textByChannel.primary, 'Welcome — Добро пожаловать');
  assert.equal(result.preview[0].blocks[0].text, 'Welcome — Добро пожаловать');
});
