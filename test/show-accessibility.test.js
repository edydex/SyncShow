'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.join(__dirname, '..');
const accessibility = require(path.join(root, 'src', 'renderer', 'show-accessibility.js'));
const appSource = fs.readFileSync(path.join(root, 'src', 'renderer', 'app.js'), 'utf8');
const html = fs.readFileSync(path.join(root, 'src', 'renderer', 'index.html'), 'utf8');
const styles = fs.readFileSync(path.join(root, 'src', 'renderer', 'styles.css'), 'utf8');

function element(tagName, {
  id = '',
  parentElement = null,
  attributes = {},
  isContentEditable = false
} = {}) {
  return {
    tagName,
    id,
    parentElement,
    isContentEditable,
    getAttribute(name) {
      return attributes[name] ?? null;
    }
  };
}

test('global Show shortcuts stay safe while focus remains on controls', () => {
  const body = element('DIV');
  const nextButton = element('BUTTON', { id: 'btnNextSlide', parentElement: body });
  const nextIcon = element('SPAN', { parentElement: nextButton });
  const clearButton = element('BUTTON', { id: 'btnClearDisplays', parentElement: body });
  const thumbnail = element('BUTTON', {
    parentElement: body,
    attributes: { 'data-show-transport': 'true' }
  });
  const unrelatedButton = element('BUTTON', { id: 'btnOpenBible', parentElement: body });
  const input = element('INPUT', { parentElement: body });
  const editableChild = element('SPAN', {
    parentElement: element('DIV', {
      parentElement: body,
      attributes: { contenteditable: 'true' }
    })
  });

  assert.equal(
    accessibility.shouldHandleGlobalShowShortcut({ key: 'ArrowRight', target: nextIcon }),
    true,
    'arrow navigation remains available after clicking Next'
  );
  assert.equal(
    accessibility.shouldHandleGlobalShowShortcut({ key: 'Escape', target: clearButton }),
    true,
    'the global clear shortcut remains available on Show transport controls'
  );
  assert.equal(
    accessibility.shouldHandleGlobalShowShortcut({ key: ' ', target: nextButton }),
    false,
    'Space must activate the focused button instead of also firing a global command'
  );
  assert.equal(
    accessibility.shouldHandleGlobalShowShortcut({ key: 'Enter', target: nextButton }),
    false,
    'Enter remains native button activation'
  );
  assert.equal(
    accessibility.shouldHandleGlobalShowShortcut({ key: 'ArrowRight', target: thumbnail }),
    true,
    'arrow navigation remains available after jumping with a thumbnail'
  );
  assert.equal(
    accessibility.shouldHandleGlobalShowShortcut({ key: ' ', target: thumbnail }),
    false,
    'Space still activates the focused thumbnail once'
  );
  assert.equal(
    accessibility.shouldHandleGlobalShowShortcut({ key: 'ArrowRight', target: unrelatedButton }),
    false,
    'unrelated buttons keep ownership of their keyboard input'
  );
  assert.equal(
    accessibility.shouldHandleGlobalShowShortcut({ key: 'ArrowRight', target: input }),
    false
  );
  assert.equal(
    accessibility.shouldHandleGlobalShowShortcut({ key: 'ArrowRight', target: editableChild }),
    false
  );
  assert.equal(
    accessibility.shouldHandleGlobalShowShortcut(
      { key: 'ArrowRight', target: body },
      { dialogOpen: true }
    ),
    false,
    'open dialogs suppress background Show shortcuts'
  );
  assert.equal(
    accessibility.shouldHandleGlobalShowShortcut({ key: 'Tab', target: body }),
    false,
    'keys without a Show command are ignored'
  );
});

test('thumbnail current state is announced without moving keyboard focus', () => {
  const attributes = new Map();
  const classes = new Set();
  let focusCalls = 0;
  const thumbnail = {
    classList: {
      toggle(name, enabled) {
        if (enabled) classes.add(name);
        else classes.delete(name);
      }
    },
    setAttribute(name, value) {
      attributes.set(name, value);
    },
    removeAttribute(name) {
      attributes.delete(name);
    },
    focus() {
      focusCalls += 1;
    }
  };

  accessibility.setThumbnailCurrentState(thumbnail, true);
  assert.equal(classes.has('active'), true);
  assert.equal(attributes.get('aria-current'), 'true');
  assert.equal(focusCalls, 0, 'slide changes must not steal focus from the operator');

  accessibility.setThumbnailCurrentState(thumbnail, false);
  assert.equal(classes.has('active'), false);
  assert.equal(attributes.has('aria-current'), false);
  assert.equal(focusCalls, 0);
});

test('thumbnail action names are compact and useful', () => {
  assert.equal(
    accessibility.thumbnailActionLabel(4, '  First line\nSecond   line  '),
    'Go to slide 5: First line Second line'
  );
  assert.equal(accessibility.thumbnailActionLabel(0, '—'), 'Go to slide 1');
});

test('Show renders native, focus-visible thumbnail buttons and uses the shortcut guard', () => {
  const helperScript = html.indexOf('<script src="show-accessibility.js"></script>');
  const appScript = html.indexOf('<script src="app.js"></script>');
  assert.ok(helperScript >= 0 && helperScript < appScript, 'accessibility helper loads before app.js');
  assert.match(html, /id="thumbnailsGrid"[^>]*aria-label="Slides"/);

  const renderStart = appSource.indexOf('function renderThumbnails()');
  const keyboardStart = appSource.indexOf('function handleKeyboard(event)', renderStart);
  const renderSource = appSource.slice(renderStart, keyboardStart);
  assert.match(renderSource, /document\.createElement\('button'\)/);
  assert.match(renderSource, /item\.type = 'button'/);
  assert.match(renderSource, /item\.dataset\.showTransport = 'true'/);
  assert.match(renderSource, /thumbnailActionLabel\(i, text\)/);
  assert.match(renderSource, /setThumbnailCurrentState\(item, isCurrent\)/);
  assert.match(renderSource, /item\.addEventListener\('click',[\s\S]*goToSlide\(i\)/);
  assert.doesNotMatch(renderSource, /addEventListener\('keydown'/);

  const keyboardSource = appSource.slice(keyboardStart, appSource.indexOf('// Utility Functions', keyboardStart));
  assert.match(keyboardSource, /shouldHandleGlobalShowShortcut\(event/);
  assert.match(keyboardSource, /dialogOpen: Boolean\(document\.querySelector\('dialog\[open\]'\)\)/);

  assert.match(styles, /\.thumbnail-item:focus-visible\s*\{/);
  assert.match(styles, /\.thumbnail-item\s*\{[\s\S]*appearance: none/);
});

test('thumbnail content selectors announce selection and retain focus when rebuilt', () => {
  assert.match(
    html,
    /id="thumbnailRoleSelector"[^>]*role="group"[^>]*aria-label="Thumbnail content"/
  );
  const selectorStart = appSource.indexOf('function renderThumbnailRoleSelector');
  const selectorEnd = appSource.indexOf('function renderThumbnails', selectorStart);
  const selectorSource = appSource.slice(selectorStart, selectorEnd);
  assert.match(selectorSource, /setAttribute\('aria-pressed'/);
  assert.match(selectorSource, /setAttribute\('aria-controls', 'thumbnailsGrid'\)/);
  assert.match(selectorSource, /setAttribute\('aria-label', `Show \$\{roleLabel\} thumbnails`\)/);

  assert.match(
    appSource,
    /thumbnailRoleSelector\.addEventListener\('click'[\s\S]*renderThumbnails\(\)[\s\S]*replacement\?\.focus\(\)/
  );
});
