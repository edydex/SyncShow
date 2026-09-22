'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { translationIntent, SlideTranslationCues } = require('../src/services/translation/SlideTranslationCues');
const cues = [{ id: 'a' }, { id: 'b', translationAction: 'start' }, { id: 'c' }, { id: 'd', translationAction: 'stop' }, { id: 'e' }];
test('previous slide prewarms; direct jumps infer the destination range', () => {
  assert.deepEqual(translationIntent(cues, 0), { phase: 'prepare', segmentId: 'b' });
  for (const index of [1, 2]) assert.deepEqual(translationIntent(cues, index), { phase: 'live', segmentId: 'b' });
  for (const index of [3, 4, -1, 9]) assert.equal(translationIntent(cues, index), null);
});
test('late binding lookup cannot start after navigation skipped past Stop', async () => {
  let resolve;
  const sent = [];
  const controller = new SlideTranslationCues({ resolve: () => new Promise(done => { resolve = done; }),
    send: async command => { sent.push(command); }, changed() {} });
  const pending = controller.navigate({ translationCues: cues }, 1);
  await controller.navigate({ translationCues: cues }, 4);
  resolve({ serviceId: 'service', serviceRevision: 'a'.repeat(64) }); await pending;
  assert.deepEqual(sent, []);
});
test('staying within a live range does not send repeated starts, ending Show sends Stop', async () => {
  const sent = [];
  const controller = new SlideTranslationCues({ resolve: async () => ({ serviceId: 'service', serviceRevision: 'a'.repeat(64) }),
    send: async command => { sent.push(command); }, changed() {} });
  await controller.navigate({ translationCues: cues }, 1);
  await controller.navigate({ translationCues: cues }, 2);
  controller.stop();
  assert.deepEqual(sent.map(command => command.phase), ['live', 'idle']);
});
