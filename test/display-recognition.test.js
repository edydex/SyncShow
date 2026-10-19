'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { describeDisplay } = require('../src/services/runtime/DisplayDescriptor');
const { DisplayDiagnosticsJournal, MAX_EVENTS, MAX_BYTES } = require('../src/services/runtime/DisplayDiagnosticsJournal');
const { matchOutputDisplay, resolveOutputDisplay } = require('../src/renderer/service-output-plan');

function descriptor(overrides = {}) {
  const display = { id: 2, internal: false, label: 'Church HDMI',
    bounds: { x: 1920, y: 0, width: 1920, height: 1080 },
    size: { width: 1920, height: 1080 }, scaleFactor: 1, rotation: 0, touchSupport: 'unknown',
    displayFrequency: 60, ...overrides };
  return describeDisplay(display, 1, { platform: 'win32', primaryId: 1, controlId: 1 });
}

test('new remembered identity survives resolution, DPI, rotation, position and refresh changes', () => {
  const before = descriptor();
  const after = descriptor({ size: { width: 1280, height: 720 },
    bounds: { x: -1280, y: 100, width: 1280, height: 720 }, scaleFactor: 1.5, rotation: 90, displayFrequency: 30 });
  assert.equal(before.fingerprint, after.fingerprint);
  assert.notEqual(before.legacyFingerprint, after.legacyFingerprint);
  assert.doesNotMatch(before.fingerprint, /Church HDMI/iu);
  assert.equal(resolveOutputDisplay({ legacyDisplayId: 2, displayFingerprint: before.fingerprint }, [after]), after);
});

test('2.0.3 mode fingerprints migrate safely using the same OS ID without rewriting the profile', () => {
  const before = descriptor();
  const after = descriptor({ scaleFactor: 1.5, rotation: 90 });
  const output = { legacyDisplayId: 2, displayFingerprint: before.legacyFingerprint };
  const original = structuredClone(output);
  const match = matchOutputDisplay(output, [after]);
  assert.equal(match.display, after);
  assert.equal(match.reason, 'saved-id-mode-changed');
  assert.deepEqual(output, original);
});

test('platform labels reconnect a uniquely named monitor when its OS ID changes', () => {
  const before = descriptor();
  const after = descriptor({ id: 44, scaleFactor: 2 });
  const match = matchOutputDisplay({ legacyDisplayId: 2, displayFingerprint: before.fingerprint }, [after]);
  assert.equal(match.display, after);
  assert.equal(match.reason, 'unique-fingerprint');
});

test('identical monitors never get guessed by array order, position or operator exclusion', () => {
  const a = descriptor({ id: 22 }), b = { ...descriptor({ id: 33 }), isControl: true };
  const saved = { legacyDisplayId: 2, displayFingerprint: a.fingerprint };
  const match = matchOutputDisplay(saved, [b, a]);
  assert.equal(match.display, null);
  assert.equal(match.reason, 'ambiguous-fingerprint');
  assert.deepEqual(match.candidateIds, ['33', '22']);
  assert.equal(resolveOutputDisplay({ ...saved, legacyDisplayId: 22 }, [b, a]), a);
});

test('a changed named monitor on a reused ID is not silently accepted', () => {
  const before = descriptor(), replacement = descriptor({ label: 'Different projector' });
  const match = matchOutputDisplay({ legacyDisplayId: 2, displayFingerprint: before.fingerprint }, [replacement]);
  assert.equal(match.display, null);
  assert.equal(match.reason, 'identity-changed');
});

test('missing, invalid, unified and uncertain identities remain unresolved', () => {
  const before = descriptor();
  const output = { legacyDisplayId: 2, displayFingerprint: before.legacyFingerprint };
  assert.equal(matchOutputDisplay(output, []).reason, 'not-connected');
  assert.equal(resolveOutputDisplay(output, [descriptor({ id: 3, rotation: 90 })]), null);
  for (const id of [-1, -10]) assert.equal(resolveOutputDisplay({ legacyDisplayId: id }, [{ ...before, id }]), null);
  assert.equal(resolveOutputDisplay({ legacyDisplayId: 2, displayFingerprint: 'display-v1:darwin:internal:1920x1080:scale-1:rotation-0:touch-unknown' }, [before]), null);
});

test('platforms without a monitor label retain legacy migration and exact-ID mode tolerance', () => {
  const before = descriptor({ label: '' }), after = descriptor({ label: '', rotation: 90 });
  assert.equal(before.fingerprint, before.legacyFingerprint);
  assert.equal(resolveOutputDisplay({ legacyDisplayId: 2, displayFingerprint: before.fingerprint }, [after]), after);
});

test('screen journal survives restart and reassignment with old and new matching decisions', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'syncshow-screen-journal-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, 'screen-diagnostics.json');
  const a = new DisplayDiagnosticsJournal({ filePath, version: '2.1.0', session: 'session-a' });
  const display = descriptor();
  a.record('app-startup', { displays: [], outputs: [{ id: 'russian', enabled: true, legacyDisplayId: 2, displayFingerprint: display.fingerprint }] });
  a.record('display-added', { displays: [display], changedDisplayId: 2, changedMetrics: ['bounds'],
    outputs: [{ id: 'russian', enabled: true, legacyDisplayId: 2, displayFingerprint: display.fingerprint }] });
  const b = new DisplayDiagnosticsJournal({ filePath, version: '2.1.1', session: 'session-b' });
  b.record('saved-screen-setup-applied', { displays: [display], outputs: [{ id: 'russian', enabled: true, legacyDisplayId: 99, displayFingerprint: display.fingerprint }] });
  const snapshot = b.snapshot();
  assert.equal(snapshot.persistenceError, null);
  assert.equal(snapshot.events.length, 3);
  assert.equal(snapshot.events[0].outputs[0].matchReason, 'not-connected');
  assert.equal(snapshot.events[1].outputs[0].matchReason, 'saved-id-and-fingerprint');
  assert.equal(snapshot.events[2].outputs[0].matchReason, 'unique-fingerprint');
  assert.equal(snapshot.events[0].session, 'session-a');
  assert.equal(snapshot.events[2].session, 'session-b');
  if (process.platform !== 'win32') assert.equal(fs.statSync(filePath).mode & 0o777, 0o600);
});

test('diagnostic history is bounded and redacts injected content and credentials, including when reloaded', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'syncshow-screen-private-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, 'screen-diagnostics.json');
  const journal = new DisplayDiagnosticsJournal({ filePath, version: '2.1.0' });
  journal.record('start-failed', { displays: [{ ...descriptor(), label: 'Private slide wording', token: 'secret' }],
    outputs: [{ id: 'russian', legacyDisplayId: 2, displayFingerprint: '/Users/private/song.txt', name: 'Private sermon', password: 'secret' }],
    error: { message: 'C:\\Users\\Church\\secret.json admin@example.com token=abc', stack: 'Private stack' } });
  assert.doesNotMatch(JSON.stringify(journal.snapshot()), /Private|private|Church|example\.com|secret|\/Users\//u);
  for (let i = 0; i < MAX_EVENTS; i++) journal.record('screen-snapshot');
  assert.equal(journal.snapshot().events.length, MAX_EVENTS);
  journal.record('start-failed', { error: { message: 'admin@example.com password=secret /Users/person/file' } });
  const reloaded = new DisplayDiagnosticsJournal({ filePath, version: '2.1.0' });
  const serialized = JSON.stringify(reloaded.snapshot());
  assert.doesNotMatch(serialized, /Private|private|Church|example\.com|secret|\/Users\//u);
  assert.ok(fs.statSync(filePath).size <= MAX_BYTES);
});

test('unwritable or corrupt history is reported without breaking presentation startup', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'syncshow-screen-corrupt-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, 'screen-diagnostics.json');
  fs.writeFileSync(filePath, 'broken JSON');
  const journal = new DisplayDiagnosticsJournal({ filePath, version: '2.1.0' });
  assert.ok(journal.snapshot().persistenceError);
  assert.doesNotThrow(() => journal.record('app-startup'));
  assert.equal(journal.snapshot().events.length, 1);
  const blocked = new DisplayDiagnosticsJournal({ filePath: path.join(filePath, 'blocked'), version: '2.1.0' });
  assert.doesNotThrow(() => blocked.record('app-startup'));
  assert.ok(blocked.snapshot().persistenceError);
});
