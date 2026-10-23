'use strict';
// Isolated local acceptance. Never attaches to an existing browser or church.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const http = require('node:http');
const { chromium } = require(process.env.SYNCSHOW_PLAYWRIGHT_MODULE || 'playwright');
const { ServiceProjectExchange } = require('../src/services/project/ServiceProjectExchange');
const { serializeServiceProject } = require('../src/services/project/ServiceProject');
const root = path.resolve(__dirname, '..');
const artifactRoot = path.resolve(process.env.SYNCSHOW_BROWSER_TEST_OUTPUT || path.join(root, 'test-results/web-prepare'));
const results = [], requests = [], external = [], runtimeErrors = [];
let browser, server, context, page;
function desktopReader() {
  return new ServiceProjectExchange({ projectStore: {
    read() {}, resolveAssetPath() {},
    async importPortableProject(project, assets) { return { imported: true, project, assets }; },
  } });
}
async function check(name, action) { await action(); results.push({ name, status: 'passed' }); console.log(`PASS ${name}`); }
async function state(target = page) { return target.evaluate(() => {
  const state = LibreShowWorkspace.state();
  return { project: state.project, selected: state.selected, changed: state.changed, formDirty: state.formDirty, workspaceId: state.workspaceId };
}); }
async function saved(target = page) { await target.waitForFunction(() => document.getElementById('recovery-status').textContent.startsWith('Recovery copy saved')); }
async function start(title, target = page) {
  await target.locator('#start').click(); await target.locator('#new-title').fill(title); await target.locator('#new-date').fill('2026-10-25');
  await target.locator('#create button[type=submit]').click(); await target.waitForFunction(() => Boolean(LibreShowWorkspace.state().project));
}
async function keyboardFocus(id, target = page) {
  for (let count = 0; count < 80; count += 1) {
    if (await target.evaluate(value => document.activeElement.id === value, id)) return;
    await target.keyboard.press('Tab');
  }
  throw new Error(`Keyboard could not reach #${id}`);
}
async function downloaded(extension) {
  await page.locator('#extension').selectOption(extension);
  const pending = page.waitForEvent('download'); await page.locator('#download').click(); const file = await pending;
  const target = path.join(artifactRoot, file.suggestedFilename()); await file.saveAs(target);
  return { name: file.suggestedFilename(), bytes: await fs.readFile(target) };
}
function attachDialogs(target) { target.on('dialog', dialog => dialog.accept()); target.on('pageerror', error => runtimeErrors.push(error.message)); }

async function main() {
  await import('../scripts/build-web-prepare.mjs'); await fs.mkdir(artifactRoot, { recursive: true });
  const staticRoot = process.env.SYNCSHOW_BROWSER_STATIC_ROOT ? path.resolve(process.env.SYNCSHOW_BROWSER_STATIC_ROOT) : path.join(root, 'web-prepare/dist');
  const preparePath = process.env.SYNCSHOW_BROWSER_PREPARE_PATH || '/';
  const policy = Object.fromEntries((await fs.readFile(path.join(staticRoot, '_headers'), 'utf8')).split('\n').slice(1).filter(line => line.includes(':')).map(line => {
    const at = line.indexOf(':'); return [line.slice(0, at).trim(), line.slice(at + 1).trim()];
  }));
  server = http.createServer(async (request, response) => {
    requests.push({ method: request.method, path: request.url });
    if (!['GET', 'HEAD'].includes(request.method)) { response.writeHead(405).end(); return; }
    const location = new URL(request.url, 'http://127.0.0.1').pathname;
    const file = path.resolve(staticRoot, '.' + decodeURIComponent(location.endsWith('/') ? location + 'index.html' : location));
    if (!file.startsWith(staticRoot + path.sep)) { response.writeHead(403).end(); return; }
    try {
      const bytes = await fs.readFile(file);
      const type = { '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.xml': 'application/xml', '.txt': 'text/plain' }[path.extname(file)] || 'application/octet-stream';
      response.writeHead(200, { ...policy, 'Content-Type': type }); response.end(request.method === 'HEAD' ? undefined : bytes);
    } catch { response.writeHead(404).end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ executablePath: process.env.SYNCSHOW_BROWSER_EXECUTABLE || undefined, headless: true, chromiumSandbox: true,
    args: ['--disable-background-networking', '--disable-component-update', '--disable-sync', '--no-first-run'] });
  async function isolatedContext(options = {}) {
    const result = await browser.newContext({ acceptDownloads: true, serviceWorkers: 'block', ...options });
    await result.route('**/*', route => {
      if (new URL(route.request().url()).origin === origin) return route.continue();
      external.push(route.request().url()); return route.abort();
    });
    return result;
  }
  context = await isolatedContext(); page = await context.newPage();
  let dismissNext = false;
  page.on('dialog', dialog => { if (dismissNext) { dismissNext = false; void dialog.dismiss(); } else void dialog.accept(); });
  page.on('pageerror', error => runtimeErrors.push(error.message)); page.setDefaultTimeout(10000);
  if (preparePath !== '/') {
    await page.goto(origin);
    await check('landing offers the verified public download and the packaged preview entry', async () => {
      assert.equal(await page.locator('#prepare-online').getAttribute('href'), preparePath);
      assert.equal(await page.locator('#download-syncshow').getAttribute('href'), 'https://github.com/edydex/SyncShow/releases/latest');
      assert.match(await page.locator('.note').textContent(), /preview|focused set/i);
      await page.waitForFunction(() => [...document.images].every(image => image.complete && image.naturalWidth > 0));
      await page.screenshot({ path: path.join(artifactRoot, 'landing-desktop.png'), fullPage: true });
    });
    await check('keyboard skip link and Prepare action reach the nested editor', async () => {
      await page.keyboard.press('Tab'); assert.equal(await page.locator('.skip').evaluate(node => node === document.activeElement), true);
      await page.keyboard.press('Enter'); assert.equal(await page.evaluate(() => document.activeElement.id), 'main');
      await keyboardFocus('prepare-online'); await page.keyboard.press('Enter'); await page.waitForURL(origin + preparePath);
      await page.keyboard.press('Tab'); assert.equal(await page.locator('.skip').evaluate(node => node === document.activeElement), true);
      await page.keyboard.press('Enter'); assert.equal(await page.evaluate(() => document.activeElement.id), 'prepare-main');
    });
    await check('keyboard create dialog traps focus and creates a local service', async () => {
      await keyboardFocus('start'); await page.keyboard.press('Enter');
      assert.equal(await page.evaluate(() => document.activeElement.id), 'new-title');
      await page.keyboard.press('Shift+Tab'); assert.equal(await page.evaluate(() => document.activeElement.id), 'close-new');
      await page.keyboard.press('Tab'); await page.keyboard.press('Control+A'); await page.keyboard.type('Keyboard service');
      await page.keyboard.press('Tab'); assert.equal(await page.evaluate(() => document.activeElement.id), 'new-date');
      await page.locator('#new-date').fill('2026-10-25'); await keyboardFocus('create-service'); await page.keyboard.press('Enter');
      assert.equal((await state()).project.title, 'Keyboard service');
    });
    await check('export instructions default to the current public desktop suffix', async () => {
      assert.equal(await page.locator('#extension').inputValue(), '.syncshow-service');
      await page.locator('.save-help summary').click();
      assert.match(await page.locator('.save-help').textContent(), /current public desktop download/);
      assert.match(await page.locator('.save-help').textContent(), /Import service/);
      assert.match(await page.locator('.save-help').textContent(), /display mapping/);
    });
  } else await page.goto(origin + preparePath);

  await check('create and edit bilingual content using the shared core and compiler', async () => {
    await start('Browser acceptance service'); await page.locator('#section').click();
    await page.locator('#item-title').fill('Opening'); await page.locator('#edit button[type=submit]').click();
    await page.locator('#notice').click(); await page.locator('#item-title').fill('Welcome');
    await page.locator('[data-channel=english]').fill('Welcome to our service'); await page.locator('[data-channel=russian]').fill('Добро пожаловать');
    await page.locator('#edit button[type=submit]').click();
    assert.match(await page.locator('#preview').textContent(), /Welcome to our service/);
    await page.locator('#preview-output').selectOption('russian'); assert.match(await page.locator('#preview').textContent(), /Добро пожаловать/);
    await saved();
    await page.screenshot({ path: path.join(artifactRoot, 'prepare-editor-desktop.png'), fullPage: true });
  });
  let recoveryId;
  await check('unsaved item edits survive refused navigation and block an incomplete download', async () => {
    await page.locator('#item-notes').fill('Pending operator note, not yet accepted');
    dismissNext = true; await page.locator('.outline-item').first().click();
    assert.equal((await state()).formDirty, true); assert.equal(await page.locator('#item-notes').inputValue(), 'Pending operator note, not yet accepted');
    await page.locator('#download').click(); assert.match(await page.locator('#message').textContent(), /Save or cancel/);
    await saved(); recoveryId = (await state()).workspaceId;
  });
  await check('IndexedDB recovery restores accepted content and pending text after a reload', async () => {
    await page.reload(); await page.waitForFunction(id => [...document.getElementById('recovery-list').options].some(option => option.value === id), recoveryId);
    await page.locator('#recovery-list').selectOption(recoveryId); await page.locator('#restore').click();
    await page.waitForFunction(() => LibreShowWorkspace.state().formDirty);
    assert.equal(await page.locator('#item-notes').inputValue(), 'Pending operator note, not yet accepted');
    await page.locator('#edit button[type=submit]').click();
    assert.equal(Object.values((await state()).project.items).find(item => item.kind === 'notice').operatorNotes, 'Pending operator note, not yet accepted');
  });
  let branded, legacy;
  await check('both download extensions open through the actual desktop importer and retain pending-save protection', async () => {
    branded = await downloaded('.libreshow'); assert.match(branded.name, /\.libreshow$/); assert.equal((await state()).changed, true);
    await page.locator('#confirm-download').click(); assert.equal((await state()).changed, false);
    legacy = await downloaded('.syncshow-service'); assert.match(legacy.name, /\.syncshow-service$/);
    await page.locator('#confirm-download').click();
    const a = (await desktopReader().importBundle(branded.bytes)).project, b = (await desktopReader().importBundle(legacy.bytes)).project;
    assert.deepEqual(a.items, b.items); assert.deepEqual(a.resources, b.resources); assert.deepEqual(a.assets, b.assets);
  });
  await check('old and new file-input names import without a conversion', async () => {
    for (const file of [branded, legacy]) {
      await page.locator('#file').setInputFiles({ name: file.name, mimeType: 'application/octet-stream', buffer: file.bytes });
      await page.waitForFunction(() => document.getElementById('message').textContent.startsWith('Service opened locally.'));
      assert.equal((await state()).project.title, 'Browser acceptance service');
    }
  });
  if (preparePath !== '/') await check('keyboard Open action imports an existing service through the real file chooser', async () => {
    await keyboardFocus('open'); const pending = page.waitForEvent('filechooser'); await page.keyboard.press('Enter');
    await (await pending).setFiles({ name: legacy.name, mimeType: 'application/octet-stream', buffer: legacy.bytes });
    await page.waitForFunction(() => document.getElementById('message').textContent.startsWith('Service opened locally.'));
    assert.equal((await state()).project.title, 'Browser acceptance service');
  });
  await check('invalid archives leave the current service and its recovery identity unchanged', async () => {
    const before = await state();
    await page.locator('#file').setInputFiles({ name: 'invalid.libreshow', mimeType: 'application/octet-stream', buffer: Buffer.from('not a service') });
    await page.waitForFunction(() => document.getElementById('message').textContent.startsWith('Could not open'));
    const after = await state(); assert.deepEqual(after.project, before.project); assert.equal(after.workspaceId, before.workspaceId);
  });
  await check('ordering, duplicate, explicit remove and undo preserve the original bilingual item', async () => {
    const before = (await state()).project;
    const notice = Object.values(before.items).find(item => item.kind === 'notice');
    await page.locator('.outline-item').filter({ hasText: 'Welcome' }).first().click();
    await page.locator('#duplicate').click(); assert.equal(Object.values((await state()).project.items).filter(item => item.kind === 'notice').length, 2);
    await page.locator('#move-up').click(); await page.locator('#remove').click(); await page.locator('#undo').click();
    assert.deepEqual((await state()).project.items[notice.id], before.items[notice.id]);
    await page.screenshot({ path: path.join(artifactRoot, 'desktop-editor.png'), fullPage: true });
  });
  await check('pinned images are previewed locally and retained byte-for-byte through download', async () => {
    const fixture = await page.evaluate(() => {
      const canvas = document.createElement('canvas'); canvas.width = 1; canvas.height = 1; canvas.getContext('2d').fillRect(0, 0, 1, 1);
      const bytes = Uint8Array.from(atob(canvas.toDataURL('image/png').split(',')[1]), value => value.charCodeAt(0));
      const hash = SyncShowSharedRuntime.sha256Hex(bytes), id = `sha256:${hash}`;
      let project = SyncShowCore.createServiceProject({ id: 'browser-image-fixture', title: 'Image fixture', serviceDate: '2026-10-25', profileId: 'fixture' });
      const raw = JSON.parse(JSON.stringify(project)); raw.assets[id] = { id, kind: 'image', fileName: 'fixture.png', storedName: `${hash}.png`, mediaType: 'image/png', sha256: hash, size: bytes.length, width: 1, height: 1 };
      project = SyncShowCore.normalizeServiceProject(raw);
      project = SyncShowCore.addProjectItem(project, { id: 'picture', kind: 'picture', title: 'Pinned picture', altText: 'Synthetic test image', assetId: id, operatorNotes: '', presetId: 'picture-fit', createdAt: '2026-10-23T00:00:00.000Z', updatedAt: '2026-10-23T00:00:00.000Z' });
      return { archive: [...SyncShowPortable.writeBundle(project, new Map([[id, bytes]])).bytes], image: [...bytes], id };
    });
    await page.locator('#file').setInputFiles({ name: 'images.libreshow', mimeType: 'application/octet-stream', buffer: Buffer.from(fixture.archive) });
    await page.waitForFunction(() => LibreShowWorkspace.state().project.id === 'browser-image-fixture');
    await page.locator('.outline-item').click(); await page.locator('#preview img').waitFor();
    assert.equal(await page.locator('#item-title').isDisabled(), true);
    const exported = await downloaded('.libreshow'), imported = await desktopReader().importBundle(exported.bytes);
    assert.deepEqual(Buffer.from(imported.assets.get(fixture.id)), Buffer.from(fixture.image));
    await page.locator('#confirm-download').click();
  });
  await check('independent tabs do not overwrite one another’s recovery copies', async () => {
    await saved(); const first = (await state()).workspaceId;
    const secondPage = await context.newPage(); attachDialogs(secondPage); await secondPage.goto(origin + preparePath); await start('Separate tab draft', secondPage); await saved(secondPage);
    const second = (await state(secondPage)).workspaceId; assert.notEqual(second, first);
    const ids = await secondPage.evaluate(async () => (await LibreShowRecovery.createRecoveryStore().list()).map(copy => copy.id));
    assert.ok(ids.includes(first)); assert.ok(ids.includes(second)); await secondPage.close();
  });
  await check('unavailable storage warns while editing and verified downloads still work', async () => {
    const privateContext = await isolatedContext(); await privateContext.addInitScript(() => Object.defineProperty(globalThis, 'indexedDB', { value: undefined }));
    const target = await privateContext.newPage(); attachDialogs(target); await target.goto(origin + preparePath); await start('Storage unavailable', target);
    await target.waitForFunction(() => document.getElementById('recovery-status').textContent.includes('could not be saved'));
    await target.locator('#notice').click(); await target.locator('#extension').selectOption('.libreshow');
    const download = target.waitForEvent('download'); await target.locator('#download').click();
    assert.match((await download).suggestedFilename(), /\.libreshow$/); await privateContext.close();
  });
  await check('quota failure preserves the active service and displays a recovery warning', async () => {
    const quotaContext = await isolatedContext(); await quotaContext.addInitScript(() => {
      const original = IDBObjectStore.prototype.put;
      IDBObjectStore.prototype.put = function (...args) { if (this.name === 'drafts') throw new DOMException('Synthetic storage quota', 'QuotaExceededError'); return original.apply(this, args); };
    });
    const target = await quotaContext.newPage(); attachDialogs(target); await target.goto(origin + preparePath); await start('Quota draft', target);
    await target.waitForFunction(() => document.getElementById('recovery-status').textContent.includes('Synthetic storage quota'));
    assert.equal((await state(target)).project.title, 'Quota draft'); assert.equal((await state(target)).changed, true); await quotaContext.close();
  });
  await check('CSP prevents even a synthetic same-origin POST and no external request occurs', async () => {
    assert.equal(await page.evaluate(async () => { try { await fetch('/forbidden-upload', { method: 'POST', body: 'synthetic test only' }); return false; } catch { return true; } }), true);
    assert.equal(requests.some(request => request.method === 'POST'), false); assert.deepEqual(external, []); assert.deepEqual(runtimeErrors, []);
  });
  await check('mobile viewport fits without horizontal overflow', async () => {
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.screenshot({ path: path.join(artifactRoot, 'mobile-editor.png'), fullPage: true });
  });
  if (preparePath !== '/') await check('mobile landing and dark theme fit, and the editor links back to the landing', async () => {
    assert.equal(await page.locator('header .brand').getAttribute('href'), '/');
    await page.goto(origin); assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.screenshot({ path: path.join(artifactRoot, 'landing-mobile.png'), fullPage: true });
    await page.emulateMedia({ colorScheme: 'dark' }); await page.setViewportSize({ width: 1280, height: 900 });
    await page.screenshot({ path: path.join(artifactRoot, 'landing-dark.png'), fullPage: true });
    await page.locator('#prepare-online').click(); await page.waitForURL(origin + preparePath);
    assert.equal(await page.locator('#start').isVisible(), true);
  });
  await fs.writeFile(path.join(artifactRoot, 'results.json'), JSON.stringify({ browser: browser.version(), sandboxEnabled: true, tests: results, requestMethods: [...new Set(requests.map(request => request.method))], externalRequests: external, runtimeErrors }, null, 2) + '\n');
}
main().catch(async error => {
  console.error(error.stack); process.exitCode = 1;
  if (page) { try { await fs.writeFile(path.join(artifactRoot, 'failure.html'), await page.content()); await page.screenshot({ path: path.join(artifactRoot, 'failure.png'), fullPage: true }); } catch {} }
}).finally(async () => { if (browser) await browser.close(); if (server) await new Promise(resolve => server.close(resolve)); });
