'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { TranslationScreens } = require('../src/services/translation/TranslationScreens');
const { TranslationProjection } = require('../src/services/translation/TranslationProjection');
const { resolveOutputDisplay } = require('../src/renderer/service-output-plan');

function fixture(t, options = {}) {
  const created = [];
  class Window extends EventEmitter {
    constructor(settings) {
      super(); this.settings = settings; this.sent = []; created.push(this);
      this.webContents = new EventEmitter();
      this.webContents.setWindowOpenHandler = handler => { this.popup = handler; };
      this.webContents.send = (channel, frame) => this.sent.push({ channel, frame });
    }
    loadFile(file) {
      this.file = file;
      return new Promise((resolve, reject) => { this.loaded = resolve; this.failed = reject; });
    }
    setIgnoreMouseEvents() {}
    setAlwaysOnTop() {}
    setFullScreen(value) { this.fullscreen = value; }
    showInactive() { this.shown = true; }
    isDestroyed() { return this.destroyed === true; }
    destroy() { this.destroyed = true; this.emit('closed'); }
  }
  const projection = new TranslationProjection();
  const context = { outputs: [
    { id: 'english', name: 'English', enabled: true, legacyDisplayId: 2, displayFingerprint: 'screen-2' },
    { id: 'russian', name: 'Russian', enabled: true, legacyDisplayId: 3, displayFingerprint: 'screen-3' }
  ], displays: [1, 2, 3].map(id => ({ id, fingerprint: `screen-${id}`, bounds: { x: id * 100, y: 0, width: 100, height: 80 } })),
  controlDisplayId: 1, showActive: false };
  projection.configure('english', { language: 'en', layout: 'full-screen' });
  projection.configure('russian', { language: 'ru', layout: 'ticker' });
  let notifications = 0;
  const screens = new TranslationScreens({ BrowserWindow: Window, projection,
    context: () => context, changed: () => notifications++, ...options });
  t.after(() => screens.closeAll());
  return { screens, context, projection, created, notifications: () => notifications };
}

test('translation screens open without presentation data and receive the existing captions', async t => {
  const { screens, projection, created } = fixture(t);
  projection.override('english', 'Grace and peace.');
  projection.override('russian', 'Благодать вам и мир.');
  const openings = [screens.open('english'), screens.open('russian')];
  assert.equal(created.length, 2);
  assert.equal(created[0].shown, undefined, 'remain hidden until content is loaded');
  created.forEach(win => win.loaded());
  await Promise.all(openings);
  assert.deepEqual(created.map(win => win.sent[0].frame.phrases[0].text), ['Grace and peace.', 'Благодать вам и мир.']);
  assert.ok(created.every(win => win.shown && win.fullscreen));
  assert.equal(created[0].settings.webPreferences.sandbox, true);
  assert.match(created[0].settings.webPreferences.preload, /translation-screen-preload.js$/);
  assert.equal(created[0].popup().action, 'deny');
  projection.configure('english', { layout: 'hidden' });
  screens.sendFrames();
  assert.equal(created[0].sent.at(-1).frame.layout, 'hidden');
  assert.equal(screens.availability('english').open, true, 'hide retains the black screen until explicit close');
  screens.close('english');
  assert.equal(created[0].destroyed, true);
  assert.equal(created[1].destroyed, undefined, 'other language output is independent');
  assert.equal(projection.frame('russian').phrases[0].text, 'Благодать вам и мир.');
});

test('screen routing rejects operator, disconnected, disabled, hidden and occupied outputs', async t => {
  const { screens, context, projection, created } = fixture(t);
  await assert.rejects(screens.open('unknown'), /configured/);
  context.outputs[0].legacyDisplayId = 1;
  context.outputs[0].displayFingerprint = 'screen-1';
  await assert.rejects(screens.open('english'), /operator screen/);
  context.outputs[0].legacyDisplayId = 99;
  context.outputs[0].displayFingerprint = null;
  await assert.rejects(screens.open('english'), /connected screen/);
  context.outputs[0].legacyDisplayId = 2;
  context.outputs[0].enabled = false;
  await assert.rejects(screens.open('english'), /configured/);
  context.outputs[0].enabled = true;
  projection.configure('english', { layout: 'hidden' });
  await assert.rejects(screens.open('english'), /visible.*layout/);
  projection.configure('english', { layout: 'lower-third' });
  const opening = screens.open('english');
  created[0].loaded(); await opening;
  context.outputs[1].legacyDisplayId = 2; context.outputs[1].displayFingerprint = null;
  await assert.rejects(screens.open('russian'), /already using/);
  assert.equal(created.length, 1);
});

test('duplicate opens reuse one window and closing during load fences a late reveal', async t => {
  const { screens, created } = fixture(t);
  const first = screens.open('english');
  const second = screens.open('english');
  const rejected = [assert.rejects(first, /closed/), assert.rejects(second, /closed/)];
  screens.close('english');
  created[0].loaded();
  await Promise.all(rejected);
  assert.equal(created.length, 1);
  assert.equal(created[0].shown, undefined);
  assert.equal(screens.windows.size, 0);
});

test('failed or stalled windows are destroyed and may be opened again', async t => {
  const { screens, created } = fixture(t, { timeoutMs: 15 });
  const failed = screens.open('english');
  created[0].failed(new Error('renderer load failed'));
  await assert.rejects(failed, /renderer load failed/);
  assert.equal(created[0].destroyed, true);
  await assert.rejects(screens.open('english'), /did not become ready/);
  assert.equal(created[1].destroyed, true);
  const retry = screens.open('english'); created[2].loaded(); await retry;
  created[2].webContents.emit('render-process-gone');
  assert.equal(screens.windows.size, 0);
});

test('Show preflight preserves visible translation but blocks new windows and final takeover closes them', async t => {
  const { screens, context, created } = fixture(t);
  const opening = screens.open('english'); created[0].loaded(); await opening;
  context.showActive = true;
  screens.reconcile();
  assert.equal(created[0].destroyed, undefined, 'failed Show preflight must preserve the current screen');
  await assert.rejects(screens.open('russian'), /Show controls/);
  screens.closeAll();
  assert.equal(created[0].destroyed, true);
  context.showActive = false;
  const pending = screens.open('russian');
  context.showActive = true; created[1].loaded();
  await assert.rejects(pending, /Show controls/);
  assert.equal(created[1].shown, undefined);
});

test('unplug, control-screen move and venue reassignment cannot strand an output on the wrong display', async t => {
  const { screens, context, created } = fixture(t);
  for (const change of [
    () => { context.displays = context.displays.filter(display => display.id !== 2); },
    () => { context.controlDisplayId = 2; },
    () => { context.outputs[0].legacyDisplayId = 3; context.outputs[0].displayFingerprint = 'screen-3'; }
  ]) {
    context.displays = [1, 2, 3].map(id => ({ id, fingerprint: `screen-${id}`, bounds: { x: id * 100, y: 0, width: 100, height: 80 } }));
    context.controlDisplayId = 1;
    context.outputs[0].legacyDisplayId = 2; context.outputs[0].displayFingerprint = 'screen-2';
    const opening = screens.open('english'); created.at(-1).loaded(); await opening;
    change(); screens.reconcile();
    assert.equal(created.at(-1).destroyed, true);
  }
});

test('saved display identity uses the same conservative matching for Show and translation', () => {
  const displays = [{ id: 2, fingerprint: 'same' }, { id: 3, fingerprint: 'same' }, { id: 4, fingerprint: 'unique' }];
  assert.equal(resolveOutputDisplay({ legacyDisplayId: 2, displayFingerprint: 'same' }, displays).id, 2);
  assert.equal(resolveOutputDisplay({ legacyDisplayId: 99, displayFingerprint: 'same' }, displays), null);
  assert.equal(resolveOutputDisplay({ legacyDisplayId: 99, displayFingerprint: 'unique' }, displays).id, 4);
  assert.equal(resolveOutputDisplay({ legacyDisplayId: 2, displayFingerprint: 'missing' }, displays), null);
});
