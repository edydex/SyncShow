'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require.resolve('../src/renderer/translation-display.js'), 'utf8');

// Execute the actual isolated output renderer. The DOM model supplies a bounded
// text area; browser rehearsal covers real font wrapping and rendered colors.
function display(capacity = 1000, { lineWidth, reducedMotion = false } = {}) {
  let receive, tick, resize, time = 0, cleared = false;
  const reports = [];
  const animations = [];
  const height = text => lineWidth ? Math.ceil([...text].length / lineWidth) * 10 : [...text].length;
  class Element {
    children = []; dataset = {}; attributes = {}; style = {}; hidden = false; value = '';
    classes = new Set();
    classList = { contains: name => name === 'cleared' ? cleared : this.classes.has(name),
      add: name => this.classes.add(name), remove: name => this.classes.delete(name) };
    setAttribute(key, value) { this.attributes[key] = value; }
    append(child) { child.parent = this; this.children.push(child); }
    prepend(child) { child.parent = this; this.children.unshift(child); }
    replaceChildren(...children) { this.value = ''; this.children = []; children.forEach(child => this.append(child)); }
    remove() { this.parent.children = this.parent.children.filter(value => value !== this); }
    set textContent(value) { this.children = []; this.value = value; }
    get textContent() { return this.value + this.children.map(child => child.textContent).join(''); }
    get clientHeight() { return capacity; }
    get scrollHeight() { return height(this.textContent); }
    get clientWidth() { return 100; }
    get scrollWidth() { return this.textContent.length; }
    get offsetTop() {
      const before = this.parent?.children.slice(0, this.parent.children.indexOf(this)).map(child => child.textContent).join('') || '';
      return lineWidth ? Math.floor([...before].length / lineWidth) * 10 : 0;
    }
    getBoundingClientRect() {
      const before = this.parent?.children.slice(0, this.parent.children.indexOf(this)).map(child => child.textContent).join('') || '';
      const lineTop = lineWidth ? Math.floor([...before].length / lineWidth) * 10 : 0;
      return { width: this.scrollWidth,
        height: this.className === 'translation-lines' ? this.scrollHeight : capacity,
        top: (this.parent?.getBoundingClientRect().top || 0) + (this.parent?.className === 'translation-lines' ? lineTop : 0)
          + (parseFloat(this.style.transform?.match(/translateY\(([-\d.]+)/)?.[1]) || 0) };
    }
    animate(keyframes, options) {
      const animation = { keyframes, options, cancelled: false, cancel() { this.cancelled = true; } };
      animations.push(animation);
      return animation;
    }
  }
  const container = new Element();
  vm.runInNewContext(source, {
    Intl, console,
    getComputedStyle: element => ({ fontSize: '10px', height: String(element.getBoundingClientRect().height),
      transform: `matrix(1, 0, 0, 1, 0, ${parseFloat(element.style.transform?.match(/translateY\(([-\d.]+)/)?.[1]) || 0})` }),
    document: { getElementById: () => container, createElement: () => new Element(),
      documentElement: { style: { setProperty() {} } }, body: { clientHeight: 100 } },
    window: { matchMedia: () => ({ matches: reducedMotion }),
      api: { onTranslationFrame: fn => { receive = fn; }, reportTranslationRendered: report => reports.push(report) } },
    requestAnimationFrame: fn => { tick = fn; },
    ResizeObserver: class { constructor(fn) { resize = fn; } observe() {} }
  });
  const layer = container.children[0], copy = layer.children[0];
  const spans = () => copy.children[0]?.className === 'translation-lines' ? copy.children[0].children : copy.children;
  let last;
  return {
    layer, copy, reports, animations,
    current: () => spans().find(child => child.attributes['aria-current'] === 'true')?.textContent,
    previous: () => spans().filter(child => child.className.includes('previous')).map(child => child.textContent.trim()),
    send(phrases, options = {}) {
      last = { outputId: 'ru', sessionId: 'one', language: 'en', layout: 'lower-third', fontScale: 1,
        moving: true, manual: false, ...options,
        phrases: phrases.map((text, index) => typeof text === 'string' ? { key: String(index), revision: 0, text } : text) };
      receive(last);
    },
    update(options) { last = { ...last, ...options }; receive(last); },
    advance(ms) { for (let i = 0; i < ms; i += 50) tick(time += 50); },
    resize(value) { capacity = value; resize(); },
    clear(value) { cleared = value; }
  };
}

test('rendering heartbeat records progress without caption text, including cleared outputs', () => {
  const d = display();
  d.send([{ key: '1', sequence: 8, revision: 5, text: 'Private sermon words.', streaming: true }]);
  d.advance(1000);
  assert.equal(d.reports.length, 1);
  assert.equal(d.reports[0].sequence, 8);
  assert.equal(d.reports[0].revision, 5);
  assert.equal(d.reports[0].visible, true);
  assert.equal(JSON.stringify(d.reports).includes('Private'), false);
  d.clear(true);
  d.advance(5000);
  assert.equal(d.reports.length, 2);
  assert.equal(d.reports[1].visible, false);
});

test('a multi-sentence chunk advances one sentence at a time; old text grays and rolls out', () => {
  const d = display(29);
  d.send(['First is here. Next is here. Last is here.'], { layout: 'full-screen' });
  assert.equal(d.current(), 'First is here.');
  assert.deepEqual(d.previous(), []);
  d.advance(1500);
  assert.equal(d.current(), 'Next is here.');
  assert.deepEqual(d.previous(), ['First is here.']);
  d.advance(1500);
  assert.equal(d.current(), 'Last is here.');
  assert.deepEqual(d.previous(), ['Next is here.']);
  d.advance(15000);
  assert.equal(d.current(), 'Last is here.', 'No blank interval while waiting for the next sentence');
});

test('Russian punctuation, quotations, decimals and common English honorifics stay faithful', () => {
  const d = display();
  d.send(['Мир вам. Он сказал: «Не бойтесь». Число 3.14.'], { language: 'ru' });
  assert.equal(d.current(), 'Мир вам.');
  d.advance(1500);
  assert.equal(d.current(), 'Он сказал: «Не бойтесь».');
  d.advance(1500);
  assert.equal(d.current(), 'Число 3.14.');
  d.send(['Dr. Smith reads John 3:16. GOD. We listen.'], { sessionId: 'two' });
  assert.equal(d.current(), 'Dr. Smith reads John 3:16.');
  d.advance(2000);
  assert.equal(d.current(), 'GOD.');
});

test('new chunks queue behind the current sentence without replaying duplicate or completed revisions', () => {
  const d = display();
  const one = { key: '1', revision: 0, text: 'First thought. Second thought.' };
  const two = { key: '2', revision: 0, text: 'Third thought.' };
  d.send([one]);
  d.send([one, two]);
  assert.equal(d.current(), 'First thought.');
  d.advance(1500);
  assert.equal(d.current(), 'Second thought.');
  d.advance(1500);
  assert.equal(d.current(), 'Third thought.');
  d.send([{ ...one, revision: 1, text: 'Corrected older thought.' }, two]);
  d.advance(10000);
  assert.equal(d.current(), 'Third thought.');
});

test('mid-sermon joins show history in gray and start at the latest chunk', () => {
  const d = display();
  d.send(['Long past. Earlier sentence.', 'Latest sentence. Coming next.'], { layout: 'full-screen' });
  assert.equal(d.current(), 'Latest sentence.');
  assert.deepEqual(d.previous(), ['Long past.', 'Earlier sentence.']);
  d.advance(1500);
  assert.equal(d.current(), 'Coming next.');
});

test('freeze/disconnection and cleared outputs pause progression; sessions and manual overrides reset it', () => {
  const d = display();
  d.send(['First. Second.'], { moving: false });
  d.advance(10000);
  assert.equal(d.current(), 'First.');
  d.update({ moving: true });
  d.clear(true);
  d.advance(10000);
  assert.equal(d.current(), 'First.');
  d.clear(false);
  d.advance(1500);
  assert.equal(d.current(), 'Second.');
  d.send(['New service.'], { sessionId: 'two' });
  assert.deepEqual(d.previous(), []);
  d.send(['Operator announcement.'], { manual: true });
  assert.equal(d.current(), 'Operator announcement.');
  d.send([], { layout: 'hidden' });
  assert.equal(d.layer.hidden, true);
  assert.equal(d.copy.textContent, '');
});

test('oversized sentences continue at word boundaries without losing text', () => {
  const d = display(25);
  const text = 'This long sentence has enough words to require several continuation views without losing any of them.';
  d.send([text]);
  const parts = [d.current()];
  for (let i = 0; i < 20; i++) {
    d.advance(1500);
    if (parts.at(-1) !== d.current()) parts.push(d.current());
  }
  assert.ok(parts.length > 2);
  assert.equal(parts.join(''), text);
});

test('font and viewport changes keep the current position rather than restarting the chunk', () => {
  const d = display();
  d.send(['First sentence. Second sentence. Third sentence.']);
  d.advance(1500);
  assert.equal(d.current(), 'Second sentence.');
  d.update({ fontScale: 1.2 });
  assert.equal(d.current(), 'Second sentence.');
  d.resize(80);
  assert.equal(d.current(), 'Second sentence.');
});

test('ticker text remains continuous and does not use sentence pacing', () => {
  const d = display();
  d.send(['First sentence. Next sentence.'], { layout: 'ticker' });
  assert.equal(d.copy.textContent.trim(), 'First sentence. Next sentence.');
  d.advance(1500);
  assert.equal(d.copy.textContent.trim(), 'First sentence. Next sentence.');
  assert.ok(d.copy.style.transform.startsWith('translateX('));
});

test('ticker appends live sentences without blank gaps, reset or duplicate final text', () => {
  const d = display();
  const first = { key: 'a', revision: 1, streaming: true, text: 'First '.repeat(25) };
  d.send([first], { layout: 'ticker' });
  d.advance(200);
  const position = d.copy.style.transform;
  const second = { key: 'b', revision: 1, streaming: true, text: 'Next partial' };
  d.send([first, second], { layout: 'ticker' });
  assert.equal(d.copy.style.transform, position, 'new text must not restart at the right edge');
  assert.ok(d.copy.textContent.endsWith('Next partial  '));
  d.send([first, { ...second, revision: 2, final: true, text: 'Next partial sentence.' }], { layout: 'ticker' });
  assert.equal(d.copy.children.length, 2);
  assert.ok(d.copy.textContent.endsWith('Next partial sentence.  '));
  d.advance(20000);
  assert.ok(d.copy.textContent.includes('Next partial sentence.'), 'retain the tail while waiting for more speech');
  d.send([first, { ...second, revision: 2, final: true, text: 'Next partial sentence.' }, { key: 'c', revision: 1, text: 'New words '.repeat(20), streaming: true }], { layout: 'ticker' });
  d.advance(20000);
  assert.ok(!d.copy.textContent.includes('First'), 'consumed sentences are removed without losing following text');
});

test('ticker smoothly catches up with backlog and pauses when disconnected or cleared', () => {
  const small = display(), large = display();
  small.send(['x'.repeat(300)], { layout: 'ticker' });
  large.send(['x'.repeat(1800)], { layout: 'ticker' });
  small.advance(1000); large.advance(1000);
  const offset = d => -parseFloat(d.copy.style.transform.slice(11));
  assert.ok(offset(large) > offset(small) * 1.5, 'more queued text increases travel speed');
  large.update({ moving: false });
  const frozen = large.copy.style.transform;
  large.advance(3000);
  assert.equal(large.copy.style.transform, frozen);
  large.update({ moving: true }); large.clear(true); large.advance(3000);
  assert.equal(large.copy.style.transform, frozen);
  large.clear(false); large.advance(200);
  assert.notEqual(large.copy.style.transform, frozen);
  large.send(['Fresh'], { layout: 'ticker', sessionId: 'next' });
  assert.equal(large.copy.textContent.trim(), 'Fresh');
  assert.equal(large.copy.style.transform, 'translateX(0px)');
});


test('continuous interpreter revisions show immediately without a sentence dwell queue', () => {
  const d = display();
  const a = { key: 'a', revision: 1, streaming: true, text: 'Мир' };
  d.send([a], { language: 'ru' });
  assert.equal(d.current(), 'Мир');
  const complete = { ...a, revision: 2, text: 'Мир вам.' };
  d.send([complete], { language: 'ru' });
  assert.equal(d.current(), 'Мир вам.');
  const b = { key: 'b', revision: 1, streaming: true, text: 'Благодать' };
  d.send([complete, b], { language: 'ru' });
  assert.equal(d.current(), 'Благодать');
  assert.deepEqual(d.previous(), ['Мир вам.']);
  d.send([complete, { ...b, revision: 2, text: 'Благодать вам и мир.' }], { language: 'ru' });
  assert.equal(d.current(), 'Благодать вам и мир.');
  d.advance(20000);
  assert.equal(d.current(), 'Благодать вам и мир.');
});

test('three wrapped lines remain until the fourth arrives, then move up without waiting for punctuation', () => {
  const d = display(30, { lineWidth: 10 });
  const phrase = { key: 'a', revision: 1, streaming: true, text: 'abcdefghij'.repeat(3) };
  d.send([phrase]);
  assert.equal(d.animations.length, 0);
  assert.equal(d.current(), phrase.text);
  d.send([{ ...phrase, revision: 2, text: phrase.text + 'k' }]);
  assert.equal(d.current(), phrase.text + 'k', 'partial text is not held for sentence completion');
  assert.equal(d.animations.length, 1);
  assert.equal(d.animations[0].keyframes[0].transform, 'translateY(0px)');
  assert.equal(d.animations[0].keyframes[1].transform, 'translateY(-10px)');
  assert.ok(d.animations[0].options.duration <= 250, 'movement must not introduce a reading queue');
  d.send([{ ...phrase, revision: 3, text: phrase.text + 'klmnop' }]);
  assert.equal(d.animations.length, 1, 'words on the same line do not restart movement');
  assert.equal(d.animations[0].cancelled, false);
  d.animations[0].onfinish();
  assert.equal(d.copy.classList.contains('rolling'), false);
});

test('rolling history can expire without replay, and new sessions clear it', () => {
  const d = display(30, { lineWidth: 10 });
  const a = { key: 'a', revision: 1, streaming: true, text: 'A'.repeat(19) + '.' };
  const b = { key: 'b', revision: 1, streaming: true, text: 'B'.repeat(19) + '.' };
  d.send([a, b]);
  assert.equal(d.animations.length, 0, 'join at the current text without replay');
  d.send([b, { key: 'c', revision: 1, streaming: true, text: 'C'.repeat(30) }]);
  assert.equal(d.current(), 'C'.repeat(30));
  assert.ok(!d.copy.textContent.includes('A'));
  assert.equal(d.animations.length, 1);
  assert.ok(parseFloat(d.animations[0].keyframes[0].transform.slice(11)) > parseFloat(d.animations[0].keyframes[1].transform.slice(11)));
  d.send([{ ...a, text: 'New session.' }], { sessionId: 'next' });
  assert.equal(d.animations[0].cancelled, true);
  assert.equal(d.copy.textContent, 'New session.');
  assert.deepEqual(d.previous(), []);
});

test('reduced motion, resize, and hidden layouts do not leave a moving caption behind', () => {
  const d = display(30, { lineWidth: 10, reducedMotion: true });
  const phrase = { key: 'a', revision: 1, streaming: true, text: 'abcdefghij'.repeat(3) };
  d.send([phrase]);
  d.send([{ ...phrase, revision: 2, text: phrase.text + 'k' }]);
  assert.equal(d.animations.length, 0);
  assert.equal(d.copy.children[0].style.transform, 'translateY(-10px)');
  d.resize(20);
  assert.equal(d.copy.children[0].style.transform, 'translateY(-20px)');
  assert.equal(d.current(), phrase.text + 'k');
  d.send([], { layout: 'hidden' });
  assert.equal(d.layer.hidden, true);
  assert.equal(d.copy.textContent, '');
});
