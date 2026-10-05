'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {applyTimelineTypography, normalizeTextStyle} = require('../packages/service-core/node/services/project/SlideTypography');

test('song fitting stays within the valid font range at the minimum setting', () => {
  const project = {items: {song: {id: 'song', textStyle: {bodySize: 32}}}};
  const cues = {one: {itemId: 'song', kind: 'song', presetId: 'wotbc-song-lyrics', channels: {
    english: {mode: 'content', blocks: [{type: 'text', role: 'lyrics', text: 'A '.repeat(150)}]}
  }}};
  applyTimelineTypography(project, cues, {groupPathByItemId: {}});
  assert.equal(cues.one.textStyle.bodySize, 32);
  assert.doesNotThrow(() => normalizeTextStyle(cues.one.textStyle));
});

test('short song slides may grow modestly without enlarging a dense verse or a manual size', () => {
  const project = {items:{song:{id:'song'}}};
  const lyricCue = text => ({itemId:'song',kind:'song',presetId:'wotbc-song-stacked',channels:{english:{mode:'content',blocks:[
    {type:'text',role:'lyrics',text},
    {type:'text',role:'lyrics',text,spans:[{start:0,end:text.length,fontScale:.85,foreground:'#ffc000'}]}
  ]}}});
  const cues = {dense:lyricCue(Array(6).fill('Sing in faith').join('\n')),short:lyricCue('Sing in faith\nSing in love')};
  applyTimelineTypography(project,cues,{groupPathByItemId:{}});
  assert.ok(cues.short.textStyle.bodySize > cues.dense.textStyle.bodySize);
  assert.ok(cues.short.textStyle.bodySize <= Math.round(cues.dense.textStyle.bodySize * 1.2));
  project.items.song.textStyle={bodySize:64};
  applyTimelineTypography(project,cues,{groupPathByItemId:{}});
  assert.equal(cues.short.textStyle.bodySize,64);
  assert.equal(cues.dense.textStyle.bodySize,64);
});
