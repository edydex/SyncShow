'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { InstalledBibleLibrary } = require('../src/services/bible/InstalledBibleLibrary');
const { BibleLibrary } = require('../src/services/bible/BibleLibrary');

const source = JSON.stringify({ schemaVersion: 1, kind: 'heritage-bible-translation', translation: {
  id: 'CHURCH-DEMO', name: 'Test edition', language: 'en', edition: 'Acceptance fixture',
  attribution: 'Fixture credit © Test publisher', sourceUrl: 'https://example.org/bible', license: 'Test permission'
}, books: [{ id: 'Rom', chapters: [{ number: 1, verses: [{ number: 1, text: 'Exact words—«punctuation».' }, { number: 2, text: 'Second verse.' }] }] }] });
async function fixture(t) {
  const rootPath = await fs.mkdtemp(path.join(os.tmpdir(), 'syncshow-bible-import-'));
  t.after(() => fs.rm(rootPath, { recursive: true, force: true }));
  const installed = new InstalledBibleLibrary({ rootPath });
  const preview = await installed.preview(source);
  const request = { source, digest: preview.digest, permissionConfirmed: true, permissionReference: 'Fixture grant' };
  return { rootPath, installed, preview, request };
}

test('preview is read-only; explicit install survives restart and resolves exact partial-edition verses', async t => {
  const f = await fixture(t);
  assert.deepEqual((await f.installed.list()).editions, []);
  await assert.rejects(f.installed.install({ ...f.request, permissionConfirmed: false }), { code: 'BIBLE_IMPORT_PERMISSION' });
  await assert.rejects(f.installed.install({ ...f.request, digest: '0'.repeat(64) }), { code: 'BIBLE_IMPORT_CHANGED' });
  await f.installed.install(f.request);
  const restarted = new InstalledBibleLibrary({ rootPath: f.rootPath });
  const catalog = await restarted.list();
  assert.equal(catalog.editions.length, 1);
  assert.equal(catalog.editions[0].verseCount, 2);
  assert.equal(JSON.stringify(catalog).includes('Exact words'), false);
  assert.equal(JSON.stringify(catalog).includes('Fixture grant'), false);
  if (process.platform !== 'win32') assert.equal((await fs.stat(path.join(f.rootPath, 'CHURCH-DEMO.json'))).mode & 0o777, 0o600);
  const library = new BibleLibrary({ installedLibrary: restarted });
  const result = await library.lookup('Rom 1 1-2', { translationId: 'CHURCH-DEMO' });
  assert.equal(result.status, 'ok');
  assert.equal(result.passage.verses[0].text, 'Exact words—«punctuation».');
  assert.equal(result.passage.translation.attribution, f.preview.preview.attribution);
  assert.equal((await library.lookup('Rom 1 1-3', { translationId: 'CHURCH-DEMO' })).code, 'verse-not-found');
  const canonical = await library.lookupCanonicalRange({ book: 'Rom', startChapter: 1, startVerse: 1, endChapter: 1, endVerse: 2 }, { translationId: 'CHURCH-DEMO' });
  assert.equal(canonical.status, 'ok');
  assert.equal(canonical.passage.verses[1].text, 'Second verse.');
  assert.equal((await library.lookup('John 3:16', { translationId: 'BSB' })).status, 'ok');
});

test('duplicate installs are idempotent and conflicting editions cannot overwrite the first', async t => {
  const f = await fixture(t);
  await f.installed.install(f.request);
  const first = await fs.readFile(path.join(f.rootPath, 'CHURCH-DEMO.json'));
  await f.installed.install(f.request);
  assert.deepEqual(await fs.readFile(path.join(f.rootPath, 'CHURCH-DEMO.json')), first);
  const changed = source.replace('Second verse.', 'Different words.');
  const preview = await f.installed.preview(changed);
  assert.equal(preview.conflict, true);
  await assert.rejects(f.installed.install({ ...f.request, source: changed, digest: preview.digest }), { code: 'BIBLE_EDITION_CONFLICT' });
  assert.deepEqual(await fs.readFile(path.join(f.rootPath, 'CHURCH-DEMO.json')), first);
  await assert.rejects(f.installed.translation('../CHURCH-DEMO'), { code: 'INVALID_BIBLE_ID' });
});

test('damaged or linked editions fail closed without falling back to another text', async t => {
  const f = await fixture(t);
  await f.installed.install(f.request);
  const file = path.join(f.rootPath, 'CHURCH-DEMO.json');
  await fs.writeFile(file, (await fs.readFile(file, 'utf8')).replace('Second verse.', 'Tampered text.'));
  assert.equal((await f.installed.list()).editions.length, 0);
  assert.equal((await f.installed.list()).warnings.length, 1);
  const library = new BibleLibrary({ installedLibrary: f.installed });
  assert.equal((await library.lookup('Rom 1:1', { translationId: 'CHURCH-DEMO' })).code, 'translation-data-unavailable');
  if (process.platform !== 'win32') {
    await fs.symlink(file, path.join(f.rootPath, 'LINKED-EDITION.json'));
    await assert.rejects(f.installed.translation('LINKED-EDITION'), { code: 'BIBLE_STORAGE' });
  }
});
