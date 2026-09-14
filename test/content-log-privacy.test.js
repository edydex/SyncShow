'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const mainSource = fs.readFileSync(
  path.resolve(__dirname, '../main.js'),
  'utf8'
).replace(/\r\n/g, '\n');

test('known slide-content log paths expose only counts and presence', () => {
  assert.doesNotMatch(mainSource, /First slide text sample/);
  assert.doesNotMatch(
    mainSource,
    /console\.(?:log|warn|error|debug)\([^)]*\b(?:firstLine|text)\??\.substring/s
  );
  assert.doesNotMatch(
    mainSource,
    /console\.(?:log|warn|error|debug)\([^)]*\bnextSlideText\??\.substring/s
  );
  assert.doesNotMatch(
    mainSource,
    /console\.(?:log|warn|error|debug)\([^)]*\bmetadata\.slides\s*\[[^\]]+\]\s*\.(?:firstLine|text)\b/s
  );
  assert.doesNotMatch(
    mainSource,
    /console\.(?:log|warn|error|debug)\([^)]*\bJSON\.stringify\(\s*(?:metadata|nextSlideText)\b/s
  );
  assert.doesNotMatch(
    mainSource,
    /console\.(?:log|warn|error|debug)\([^)]*\$\{\s*nextSlideText\s*\}/s
  );
  assert.match(
    mainSource,
    /next text: \$\{nextSlideText \? 'yes' : 'no'\}/
  );
});
