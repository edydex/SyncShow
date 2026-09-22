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
