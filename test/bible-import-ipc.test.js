'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const { InstalledBibleLibrary } = require('../src/services/bible/InstalledBibleLibrary');
const { readFileNoFollow } = require('../src/services/project/StorageSafety');
const { BibleImportError, MAX_BIBLE_IMPORT_BYTES } = require('../packages/bible-import');
const main = fs.readFileSync(path.join(__dirname, '../main.js'), 'utf8');
const handlersSource = main.slice(main.indexOf('let pendingBibleImport = null;'), main.indexOf("ipcMain.handle('bible:lookup'"));

test('native chooser preview binds exact source, permission and expiry to the trusted control sender', async t => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'syncshow-import-ipc-'));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const chosen = path.join(root, 'chosen.json');
  await fsp.copyFile(path.join(__dirname, '../assets/bible-import-example.json'), chosen);
  const library = new InstalledBibleLibrary({ rootPath: path.join(root, 'installed') });
  const handlers = new Map(), sender = {}, event = { sender }; let now = Date.now(), choices = 0;
  const context = vm.createContext({ fs, path, crypto, TextDecoder, BibleImportError, MAX_BIBLE_IMPORT_BYTES, readFileNoFollow,
    Date: { now: () => now }, __dirname: path.join(__dirname, '..'), controlWindow: {}, bundledBibleTranslations: [],
    requireControlSender(input) { if (input !== event) throw new Error('untrusted sender'); },
    getInstalledBibleLibrary: () => library,
    ipcMain: { handle: (name, callback) => handlers.set(name, callback) },
    dialog: { showOpenDialog: async () => { choices++; return { canceled: false, filePaths: [chosen] }; }, showSaveDialog: async () => ({ canceled: true }) }
  });
  vm.runInContext(handlersSource, context);
  const invoke = (name, request) => handlers.get(`bible:${name}`)(event, request);
  for (const name of ['translations', 'importPreview', 'importInstall', 'importExample']) {
    await assert.rejects(handlers.get(`bible:${name}`)({ sender: {} }, {}), /untrusted/);
  }
  assert.throws(() => handlers.get('bible:importCancel')({ sender: {} }), /untrusted/);
  assert.equal(choices, 0);
  const preview = await invoke('importPreview');
  assert.equal(preview.preview.id, 'BSB-DEMO');
  assert.equal(preview.source, undefined);
  assert.equal(preview.filePath, undefined);
  const request = { token: preview.token, permissionConfirmed: true, permissionReference: 'Private permission receipt' };
  assert.match((await invoke('importInstall', { ...request, source: 'unreviewed source' })).error, /preview/);
  assert.match((await invoke('importInstall', { ...request, permissionConfirmed: false })).error, /permission/);
  assert.equal((await library.list()).editions.length, 0);
  now += 16 * 60_000;
  assert.match((await invoke('importInstall', request)).error, /preview/);
  const latest = await invoke('importPreview');
  await invoke('importCancel');
  assert.match((await invoke('importInstall', { ...request, token: latest.token })).error, /preview/);
  const accepted = await invoke('importPreview');
  await fsp.writeFile(chosen, '{}'); // Installing uses exactly the reviewed snapshot, not changed disk contents.
  assert.equal((await invoke('importInstall', { ...request, token: accepted.token })).installed, true);
  assert.match((await invoke('importInstall', { ...request, token: accepted.token })).error, /preview/);
  const catalog = await invoke('translations');
  assert.equal(catalog.translations[0].id, 'BSB-DEMO');
  assert.equal(JSON.stringify(catalog).includes('Private permission receipt'), false);
  await fsp.writeFile(chosen, Buffer.from([0x7b, 0x22, 0xff, 0x22, 0x7d]));
  assert.match((await invoke('importPreview')).error, /UTF-8/);
});
