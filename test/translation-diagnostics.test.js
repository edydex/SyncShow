'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { TranslationDiagnostics } = require('../src/services/translation/TranslationDiagnostics');

function fixture(t, options = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'translation-diagnostics-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  let now = 0;
  const diagnostics = new TranslationDiagnostics({ directory, now: () => now, ...options });
  return { diagnostics, directory, time: value => { now = value; },
    logs: () => fs.readdirSync(directory).flatMap(file => fs.readFileSync(path.join(directory, file), 'utf8').trim().split('\n').map(JSON.parse)) };
}
const live = { sessionId: 'service-1', status: 'live', automation: { phase: 'live' }, captions: {} };
const disconnected = { ...live, status: 'disconnected' };

test('connection warning requires seven uninterrupted seconds and resets after recovery or Stop', t => {
  const f = fixture(t);
  assert.equal(f.diagnostics.observe(live), false);
  assert.equal(f.diagnostics.observe(disconnected), false);
  f.time(6999);
  assert.equal(f.diagnostics.observe(disconnected), false);
  f.time(7000);
  assert.equal(f.diagnostics.observe(disconnected), true);
  assert.equal(f.diagnostics.observe(live), false);
  f.time(8000);
  assert.equal(f.diagnostics.observe(disconnected), false);
  f.time(14999);
  assert.equal(f.diagnostics.observe(disconnected), false, 'A new interruption gets its own grace period');
  assert.equal(f.diagnostics.observe({ ...disconnected, automation: { phase: 'stopping' } }), false);
});

test('silence and brief reconnects do not produce a frozen-translation warning', t => {
  const f = fixture(t);
  f.diagnostics.observe(live);
  f.time(60000);
  assert.equal(f.diagnostics.observe(live), false, 'No new words is not evidence of a stalled connection');
  f.diagnostics.observe(disconnected);
  f.time(66000);
  assert.equal(f.diagnostics.observe(live), false);
  assert.equal(f.logs().some(row => row.connectionWarning), false);
});

test('diagnostics retain only bounded metadata, throttle reports, and rotate files', t => {
  const f = fixture(t, { maxBytes: 1200 });
  const sensitive = 'PRIVATE-CAPTION-OR-TOKEN';
  const state = { ...live, origin: sensitive, automation: { phase: 'live', message: sensitive },
    captions: { ru: [{ sequence: 2, revision: 10, text: sensitive }] },
    outputs: [{ id: 'screen', name: sensitive, language: 'ru', layout: 'ticker', active: true }] };
  f.diagnostics.observe(state);
  f.diagnostics.observe(state);
  assert.equal(f.logs().length, 1);
  assert.equal(f.logs()[0].captions[1].characters, sensitive.length);
  const report = { sessionId: 'service-1', sequence: 2, revision: 10, characters: 30, visible: true, text: sensitive };
  f.diagnostics.rendered('screen', report);
  f.diagnostics.rendered('screen', report);
  assert.equal(f.logs().filter(row => row.event === 'rendered').length, 1);
  for (let n = 1; n <= 20; n++) { f.time(n * 15000); f.diagnostics.observe(state); f.diagnostics.rendered('screen', report); }
  assert.deepEqual(fs.readdirSync(f.directory).sort(), ['translation.jsonl', 'translation.previous.jsonl']);
  for (const file of fs.readdirSync(f.directory)) {
    const text = fs.readFileSync(path.join(f.directory, file), 'utf8');
    assert.equal(text.includes(sensitive), false);
    assert.ok(Buffer.byteLength(text) <= 1200);
  }
});

test('unwritable diagnostics never interrupt translation', t => {
  const f = fixture(t);
  const file = path.join(f.directory, 'not-a-directory');
  fs.writeFileSync(file, 'occupied');
  const diagnostics = new TranslationDiagnostics({ directory: file });
  assert.doesNotThrow(() => diagnostics.observe(live));
  assert.doesNotThrow(() => diagnostics.outputEvent('screen', 'process-gone'));
});
