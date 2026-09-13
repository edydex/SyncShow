'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { TranslationPreferences } = require('../src/services/translation/TranslationPreferences');

test('venue preferences persist separately without captions, audio choices, or tokens', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'translation-preferences-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const store = new TranslationPreferences(directory);
  assert.equal((await store.read('church-a')).size, 0);
  const output = { language: 'ru', layout: 'ticker', fontScale: 1.25 };
  await store.write('church-a', new Map([['screen', output]]));
  assert.deepEqual([...await new TranslationPreferences(directory).read('church-a')], [['screen', output]]);
  assert.equal((await store.read('church-b')).size, 0);
  await assert.rejects(store.write('church-a', new Map([['screen', { ...output, token: 'not-allowed' }]])));
});

test('unsafe settings targets are rejected without overwriting them', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'translation-preferences-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const store = new TranslationPreferences(directory);
  const target = path.join(directory, 'preserve.txt');
  await fs.writeFile(target, 'preserve');
  await fs.symlink(target, store.file('church-a'));
  await assert.rejects(store.read('church-a'));
  await assert.rejects(store.write('church-a', new Map()));
  assert.equal(await fs.readFile(target, 'utf8'), 'preserve');
});
