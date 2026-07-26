'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const overlaySource = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'renderer', 'bible-overlay.js'),
  'utf8'
);

class FakeClassList {
  constructor(initial = []) {
    this.values = new Set(initial);
  }

  add(...names) {
    names.forEach(name => this.values.add(name));
  }

  remove(...names) {
    names.forEach(name => this.values.delete(name));
  }

  toggle(name, force) {
    const enabled = force === undefined ? !this.values.has(name) : Boolean(force);
    if (enabled) this.values.add(name);
    else this.values.delete(name);
    return enabled;
  }

  contains(name) {
    return this.values.has(name);
  }
}

class FakeElement {
  constructor(id = '', classes = []) {
    this.id = id;
    this.className = '';
    this.classList = new FakeClassList(classes);
    this.attributes = new Map();
    this.children = [];
    this.hidden = false;
    this.clientWidth = 1920;
    this.clientHeight = 1080;
    this.scrollWidth = 1920;
    this.scrollHeight = 1080;
    this._textContent = '';
    this._footer = null;
  }

  get offsetHeight() {
    return this.clientHeight;
  }

  get textContent() {
    return this._textContent;
  }

  set textContent(value) {
    this._textContent = String(value);
    this.children = [];
  }

  setAttribute(name, value) {
    this.attributes.set(name, String(value));
  }

  querySelector(selector) {
    return selector === '.bible-footer' ? this._footer : null;
  }

  replaceChildren(...children) {
    this.children = [...children];
  }

  append(...children) {
    this.children.push(...children);
  }

  appendChild(child) {
    this.children.push(child);
    return child;
  }
}

function createHarness({ overflow = false } = {}) {
  const elements = new Map();
  for (const suffix of ['', 'Staging']) {
    const overlay = new FakeElement(`bibleOverlay${suffix}`, ['bible-overlay']);
    const footer = new FakeElement(`bibleFooter${suffix}`, ['bible-footer']);
    overlay._footer = footer;
    if (overflow) overlay.scrollHeight = 1800;
    elements.set(overlay.id, overlay);
    elements.set(`bibleReference${suffix}`, new FakeElement(`bibleReference${suffix}`));
    elements.set(`bibleVerses${suffix}`, new FakeElement(`bibleVerses${suffix}`));
    elements.set(`bibleTranslation${suffix}`, new FakeElement(`bibleTranslation${suffix}`));
    elements.set(`bibleAttribution${suffix}`, new FakeElement(`bibleAttribution${suffix}`));
  }

  const timers = new Map();
  let nextTimer = 1;
  const window = {};
  const context = {
    window,
    document: {
      getElementById: id => elements.get(id) || null,
      createElement: () => new FakeElement(),
      createTextNode: text => ({ nodeType: 3, textContent: String(text) })
    },
    requestAnimationFrame: callback => {
      callback();
      return 1;
    },
    setTimeout: (callback, delay) => {
      const id = nextTimer++;
      timers.set(id, { callback, delay });
      return id;
    },
    clearTimeout: id => timers.delete(id),
    Date: class extends Date {
      static now() {
        return 1000;
      }
    }
  };

  vm.runInNewContext(overlaySource, context, { filename: 'bible-overlay.js' });
  return {
    elements,
    createController: window.createBibleOverlayController,
    pendingTimers: () => [...timers.values()],
    runTimers: () => {
      const callbacks = [...timers.values()].map(timer => timer.callback);
      timers.clear();
      callbacks.forEach(callback => callback());
    }
  };
}

function passage(reference = 'Psalm 23:1-2') {
  return {
    reference,
    translationId: 'BSB',
    attribution: 'The Holy Bible, Berean Standard Bible, BSB',
    verses: [
      { number: 1, text: 'The LORD is my shepherd; I shall not want.' },
      { number: 2, text: 'He makes me lie down in green pastures.' }
    ]
  };
}

test('the overlay prepares offscreen, waits for the shared deadline, and reports its actual reveal', () => {
  const harness = createHarness();
  const ready = [];
  const revealed = [];
  const controller = harness.createController({
    onReady: event => ready.push(event),
    onReveal: event => revealed.push(event)
  });

  controller.prepare({ overlayId: 'overlay-1', passage: passage() });
  assert.equal(ready.length, 1);
  assert.equal(ready[0].overlayId, 'overlay-1');
  assert.equal(ready[0].ok, true);
  assert.equal(harness.elements.get('bibleOverlay').hidden, true);
  assert.equal(harness.elements.get('bibleOverlayStaging').hidden, false);
  assert.equal(harness.elements.get('bibleOverlayStaging').classList.contains('staging'), true);

  controller.reveal({ overlayId: 'overlay-1', revealAt: 1120 });
  assert.equal(revealed.length, 0);
  assert.equal(harness.pendingTimers()[0].delay, 120);
  harness.runTimers();

  assert.equal(revealed.length, 1);
  assert.equal(revealed[0].overlayId, 'overlay-1');
  assert.equal(harness.elements.get('bibleOverlayStaging').hidden, false);
  assert.equal(harness.elements.get('bibleOverlayStaging').classList.contains('staging'), false);
  assert.equal(harness.elements.get('bibleReferenceStaging').textContent, 'Psalm 23:1-2');
  assert.equal(harness.elements.get('bibleVersesStaging').children.length, 2);
});

test('replacement is double-buffered, stale hides are ignored, and overflow is rejected', () => {
  const harness = createHarness();
  const ready = [];
  const hidden = [];
  const controller = harness.createController({
    onReady: event => ready.push(event),
    onHide: event => hidden.push(event.overlayId)
  });

  controller.prepare({ overlayId: 'old', passage: passage('Psalm 23:1') });
  controller.reveal({ overlayId: 'old' });
  controller.prepare({ overlayId: 'new', passage: passage('John 3:16') });

  // The old passage remains visible while the new one is measured offscreen.
  assert.equal(harness.elements.get('bibleOverlayStaging').hidden, false);
  assert.equal(harness.elements.get('bibleOverlay').hidden, false);
  assert.equal(harness.elements.get('bibleOverlay').classList.contains('staging'), true);

  controller.reveal({ overlayId: 'new' });
  controller.hide({ overlayId: 'old' });
  assert.equal(harness.elements.get('bibleOverlay').hidden, false);
  assert.equal(harness.elements.get('bibleReference').textContent, 'John 3:16');
  assert.deepEqual(hidden, []);

  controller.hide({ overlayId: 'new' });
  assert.equal(harness.elements.get('bibleOverlay').hidden, true);
  assert.deepEqual(hidden, ['new']);
  assert.deepEqual(ready.map(event => event.ok), [true, true]);

  const overflowHarness = createHarness({ overflow: true });
  const overflowReady = [];
  const overflowController = overflowHarness.createController({
    onReady: event => overflowReady.push(event)
  });
  overflowController.prepare({ overlayId: 'too-long', passage: passage() });
  assert.equal(overflowReady[0].ok, false);
  assert.match(overflowReady[0].error, /does not fit/i);
});
