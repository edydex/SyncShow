'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

test('screen rehearsal bounds helper cleanup and never waits indefinitely for an inherited pipe', () => {
  const runner = fs.readFileSync(require.resolve('../scripts/verify-screen-recognition-electron'), 'utf8');
  assert.match(runner, /child\.once\('exit', resolve\)/u);
  assert.doesNotMatch(runner, /child\.once\('close', resolve\)/u);
  assert.match(runner, /process\.kill\(-child\.pid, 'SIGKILL'\)/u);
  assert.match(runner, /taskkill.*\/T.*\/F/u);
  assert.match(runner, /reject\(new Error\(`Screen rehearsal exceeded 160 seconds/u);
  assert.match(runner, /child\.stdout\.destroy\(\)/u);
  assert.match(runner, /child\.stderr\.destroy\(\)/u);
});

test('screen rehearsal exercises real hit targets, native view boundaries and exported history', () => {
  const fixture = fs.readFileSync(require.resolve('../scripts/fixtures/small-service-electron-app'), 'utf8');
  assert.match(fixture, /document\.elementFromPoint\(x,y\)===button/u);
  assert.match(fixture, /nativeEditor\.getBounds\(\)\.y/u);
  assert.match(fixture, /sendInputEvent\(\{type:'mouseDown'/u);
  assert.match(fixture, /screen\.emit\('display-removed'/u);
  assert.match(fixture, /state\.displays=\[\];startPresentation\(\)/u);
  assert.match(fixture, /window\.api\.exportSupportDiagnostics\(\)/u);
  assert.match(fixture, /'recovery-succeeded'/u);
  assert.match(fixture, /!state\.isStarting && !state\.startAttempt/u);
  assert.match(fixture, /body:plannerBody/u);
  assert.doesNotMatch(fixture, /body:await planner\.executeJavaScript/u);
});
