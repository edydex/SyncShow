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

test('singer lyrics use one independent song-wide size and do not constrain another song or its title', () => {
  const {singerSourceCue} = require('../packages/service-core/node/services/project/SingerPresentation');
  const cue = (itemId, text) => ({itemId,kind:'song',presetId:'wotbc-song-lyrics',channels:{
    english:{mode:'content',blocks:[{type:'text',role:'lyrics',text}]},
    media:{mode:'condensed',sourceChannelId:'english',sourceBlocks:[{type:'text',role:'lyrics',text}],blocks:[]}
  }});
  const project = {items:{song:{id:'song'},other:{id:'other'}}};
  const cues = {dense:cue('song',Array(6).fill('We sing Your praise together').join('\n')),short:cue('song','Praise'),other:cue('other','Praise')};
  cues.title = {...cue('song','A title'),presetId:'wotbc-song-title'};
  applyTimelineTypography(project,cues,{groupPathByItemId:{}});
  assert.equal(cues.short.textStyle.bodySize,cues.dense.textStyle.bodySize);
  assert.equal(cues.short.singerTextStyle.bodySize,cues.dense.singerTextStyle.bodySize);
  assert.ok(cues.other.singerTextStyle.bodySize>cues.dense.singerTextStyle.bodySize);
  assert.equal(singerSourceCue(cues.short,'english').textStyle.bodySize,cues.short.singerTextStyle.bodySize);
  assert.equal(cues.title.textStyle,undefined);
});

test('all song lyric slides keep the largest shared size, including short verses and manual sizes', () => {
  const project = {items:{song:{id:'song'}}};
  const lyricCue = text => ({itemId:'song',kind:'song',presetId:'wotbc-song-stacked',channels:{english:{mode:'content',blocks:[
    {type:'text',role:'lyrics',text},
    {type:'text',role:'lyrics',text,spans:[{start:0,end:text.length,fontScale:.85,foreground:'#ffc000'}]}
  ]}}});
  const cues = {dense:lyricCue(Array(6).fill('Sing in faith').join('\n')),short:lyricCue('Sing in faith\nSing in love')};
  applyTimelineTypography(project,cues,{groupPathByItemId:{}});
  assert.equal(cues.short.textStyle.bodySize, cues.dense.textStyle.bodySize);
  const {groupFontSize} = require('../packages/service-core/node/services/project/SlideTypography');
  const size = cues.dense.textStyle.bodySize;
  assert.equal(groupFontSize(Object.values(cues), size + 1, size), size, 'A larger size must fail on the dense verse');
  project.items.song.textStyle={bodySize:64};
  applyTimelineTypography(project,cues,{groupPathByItemId:{}});
  assert.equal(cues.short.textStyle.bodySize,64);
  assert.equal(cues.dense.textStyle.bodySize,64);
});
