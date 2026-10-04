'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { resolveBackstageCueTarget: resolve } = require('../src/services/show/BackstageCueTarget');
const previousCueIds = ['title', 'point', 'reading', 'closing'];
test('re-take follows the selected cue identity after insertions and reordering', () => {
  const nextCueIds = ['new', 'reading', 'title', 'point', 'closing'];
  assert.equal(resolve({ previousCueIds, nextCueIds, currentIndex: 1, targetIndex: 1 }).targetIndex, 3);
  assert.equal(resolve({ previousCueIds, nextCueIds, currentIndex: 1, targetIndex: 2 }).targetIndex, 1);
});
test('advance takes newly inserted next slides in the saved draft', () => {
  const result = resolve({ previousCueIds, nextCueIds: ['title', 'point', 'new', 'reading', 'closing'], currentIndex: 1, advance: 1 });
  assert.equal(result.cueId, 'new');
  assert.equal(result.targetIndex, 2);
});
test('a removed current or selected cue never falls back to its old ordinal', () => {
  const nextCueIds = ['title', 'replacement', 'reading', 'closing'];
  assert.equal(resolve({ previousCueIds, nextCueIds, currentIndex: 1, targetIndex: 1 }).code, 'DRAFT_CUE_REMOVED');
  assert.equal(resolve({ previousCueIds, nextCueIds, currentIndex: 1, advance: 1 }).code, 'DRAFT_CUE_REMOVED');
  assert.equal(resolve({ previousCueIds, nextCueIds, currentIndex: 1, targetIndex: 2 }).cueId, 'reading');
});
test('advance at the old last cue can take an appended draft slide', () => {
  assert.equal(resolve({ previousCueIds, nextCueIds: [...previousCueIds, 'new'], currentIndex: 3, advance: 1 }).cueId, 'new');
  assert.equal(resolve({ previousCueIds, nextCueIds: previousCueIds, currentIndex: 3, advance: 1 }).code, 'AT_LAST_CUE');
});
test('ambiguous draft cue identity is rejected before activation', () => {
  assert.equal(resolve({ previousCueIds, nextCueIds: ['title', 'title'], currentIndex: 0, targetIndex: 0 }).code, 'DRAFT_CUE_IDENTITIES_INVALID');
});

test('Adjust editor can take a new draft cue directly by its compiled stable ID', () => {
  const result = resolve({previousCueIds,nextCueIds:['title','new','point','reading','closing'],currentIndex:1,cueId:'new'});
  assert.equal(result.cueId, 'new');
  assert.equal(result.currentIndex, 2);
});
