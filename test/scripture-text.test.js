'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { scriptureFlowText } = require('../src/services/bible/ScriptureText');
const { cueTextForChannel } = require('../src/services/project/NativeSlideRenderer');
const { compileNativeCueScene } = require('../src/services/show/NativeCueScene');

const verses = [{ number: 16, text: 'First verse\ncontinues here.' }, { number: 17, text: 'Второй стих без разрыва строки.' }];
const expected = '¹⁶\u00a0First verse continues here. ¹⁷\u00a0Второй стих без разрыва строки.';
test('Scripture uses small raised numbers in one naturally wrapping paragraph', () => {
  const original = JSON.stringify(verses);
  assert.equal(scriptureFlowText(verses), expected);
  assert.equal(scriptureFlowText([{ number: 100, text: '<text> & literal' }]), '¹⁰⁰\u00a0<text> & literal');
  assert.equal(JSON.stringify(verses), original);
});
test('live scene and raster text paths share the same verse formatting', () => {
  const cue = { id: 'cue-0123456789abcdef01234567', kind: 'bible', title: 'Psalms', presetId: 'scripture-large',
    channels: { english: { mode: 'content', blocks: [{ type: 'bible', reference: 'Psalms 18:16–17', translationId: 'BSB', verses }] } } };
  assert.equal(cueTextForChannel(cue, 'english'), expected);
  const scene = compileNativeCueScene(cue, 'english', { width: 1920, height: 1080 });
  assert.equal(scene.body, expected);
  assert.equal(scene.title, 'Psalms 18:16–17');
  assert.equal(scene.body.includes('\n'), false);
});
