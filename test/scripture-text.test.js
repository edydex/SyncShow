'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { scriptureFlowText } = require('../src/services/bible/ScriptureText');
const { cueTextForChannel } = require('../src/services/project/NativeSlideRenderer');
const { compileNativeCueScene } = require('../src/services/show/NativeCueScene');

const verses = [{ number: 16, text: 'First verse\ncontinues here.' }, { number: 17, text: 'Второй стих без разрыва строки.' }];
const expected = '¹⁶\u2060First verse continues here. ¹⁷\u2060Второй стих без разрыва строки.';
test('Scripture uses small raised numbers in one naturally wrapping paragraph', () => {
  const original = JSON.stringify(verses);
  assert.equal(scriptureFlowText(verses), expected);
  assert.equal(scriptureFlowText([{ number: 100, text: '<text> & literal' }]), '¹⁰⁰\u2060<text> & literal');
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

test('verse markers have no visible separator while saved emphasis offsets and source words survive', () => {
  const {scriptureDisplay} = require('../src/services/project/SlideFormatting');
  const {verseWordRanges} = require('../packages/service-core/node/services/project/PresentationText');
  const {textWidth} = require('../src/services/project/SlideTypography');
  const text = '¹⁶\u00a0First verse. ¹⁷\u00a0Второй стих.';
  const spans = [{start:3,end:8,weight:'700'}];
  const saved = {displayText:text,displaySpans:spans};
  const display = scriptureDisplay(saved,'wotbc-reading');
  assert.equal(display.text,'¹⁶\u2060First verse. ¹⁷\u2060Второй стих.');
  assert.equal(display.text.length,text.length);
  assert.deepEqual(display.spans,spans);
  assert.equal(display.text.slice(spans[0].start,spans[0].end),'First');
  assert.equal(saved.displayText,text);
  assert.deepEqual(verseWordRanges(display.text).map(r=>display.text.slice(r.start,r.end)),['¹⁶\u2060First','¹⁷\u2060Второй']);
  assert.equal(textWidth('¹⁶\u2060First',80),textWidth('¹⁶First',80));
  const single = scriptureDisplay({reference:'John 3:16',translationId:'BSB',verses:[{number:16,text:'First verse.'}],spans},'wotbc-sermon-scripture');
  assert.equal(single.text,'John 3:16 First verse.');
  assert.equal(single.text.slice(single.spans[1].start,single.spans[1].end),'First');
});
