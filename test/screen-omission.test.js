'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const omission = require('../src/renderer/screen-omission');
const routing = require('../src/renderer/service-screen-routing');

const all = {screenIds: ['english', 'russian', 'media'], hintScreenIds: ['media']};

test('leaving a screen out changes only this run, never the saved choice, and never removes every screen', () => {
  const before = JSON.stringify(all);
  assert.deepEqual(omission.withoutScreens(all, ['media']), {screenIds: ['english', 'russian'], hintScreenIds: []});
  assert.deepEqual(omission.withoutScreens(all, ['english']), {screenIds: ['russian', 'media'], hintScreenIds: ['media']});
  assert.equal(omission.withoutScreens(all, []), all);
  assert.equal(omission.withoutScreens(null, ['media']), null);
  assert.equal(omission.withoutScreens(all, ['english', 'russian', 'media']), all, 'at least one screen stays');
  assert.equal(JSON.stringify(all), before);
  assert.deepEqual(omission.cleanLeftOut(all, ['media', 'media', 'missing']), ['media']);
  assert.deepEqual(omission.cleanLeftOut(all, ['english', 'russian', 'media']), []);
  assert.deepEqual(omission.cleanLeftOut({screenIds: ['english']}, ['russian']), []);
});

test('two TVs for a three-screen service: one screen must be left out, the stage screen by default', () => {
  assert.equal(omission.missingScreenCount(all, 2), 1);
  assert.equal(omission.missingScreenCount(all, 3), 0);
  assert.equal(omission.missingScreenCount(all, 0), 0, 'no TV at all is a different problem');
  assert.equal(omission.missingScreenCount(null, 1), 0);
  assert.deepEqual(omission.suggestLeftOut(all, 1), ['media']);
  assert.deepEqual(omission.suggestLeftOut(all, 1, ['russian']), ['russian'], 'a screen whose TV is missing comes first');
  assert.deepEqual(omission.suggestLeftOut(all, 2), ['media', 'english']);
  assert.deepEqual(omission.suggestLeftOut({screenIds: ['english']}, 1), []);
  assert.deepEqual(omission.suggestLeftOut({screenIds: ['english', 'russian']}, 5), ['english']);
});

test('with the stage screen left out, both remaining outputs get the two connected TVs', () => {
  const presentations = Object.fromEntries(['english', 'russian', 'media'].map(id => [id, {presentationScreenId: id}]));
  const outputs = ['english', 'russian', 'media'].map((id, index) => ({id, expectedRole: id, displayId: index + 20}));
  const displays = [{id: 1, isControl: true}, {id: 2}, {id: 3}];
  const full = routing.presentationOutputs(outputs, presentations, all, displays, true)
  assert.equal(full.filter(output => output.displayId === null).length, 1, 'three screens on two TVs leaves one without a TV');
  const run = routing.presentationOutputs(outputs, presentations, omission.withoutScreens(all, ['media']), displays, true);
  assert.deepEqual(run.map(output => [output.expectedRole, output.displayId]), [['english', 2], ['russian', 3]]);
});
