'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const test = require('node:test');
const {captureFreshFrame} = require('../scripts/lib/capture-fresh-frame');

const hash = text => crypto.createHash('sha256').update(text).digest('hex');
const image = text => ({toPNG: () => Buffer.from(text)});

test('a compositor replay is retried until the newly acknowledged frame is actually captured', async () => {
  const seen = new Set([hash('previous')]);
  let captures = 0;
  let waits = 0;
  const result = await captureFreshFrame(
    async () => image(++captures < 3 ? 'previous' : 'current'),
    seen,
    {wait: async () => { waits += 1; }}
  );
  assert.equal(captures, 3);
  assert.equal(waits, 2);
  assert.equal(result.png.toString(), 'current');
  assert.ok(seen.has(hash('current')));
});

test('a frozen surface still fails after the bounded capture attempts', async () => {
  let captures = 0;
  await assert.rejects(captureFreshFrame(
    async () => { captures += 1; return image('previous'); },
    new Set([hash('previous')]),
    {attempts: 3, wait: async () => {}}
  ), /never produced a fresh/);
  assert.equal(captures, 3);
});
