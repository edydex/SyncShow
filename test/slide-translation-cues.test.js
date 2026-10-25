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
  await new Promise(resolve => setImmediate(resolve));
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
  await controller.stop();
  assert.deepEqual(sent.map(command => command.phase), ['live', 'idle']);
});
test('the exact segment settings travel through preparation, live navigation and stop', async()=>{
  const settings={sourceLanguage:'ru',targetLanguage:'en',voice:'marin',speechEnabled:false,captionStyle:'lower-third',captionChannel:'english'};
  const configured=cues.map(cue=>cue.id==='b'?{...cue,translationSettings:settings}:cue);
  const sent=[];
  const controller=new SlideTranslationCues({resolve:async()=>({serviceId:'test',serviceRevision:'a'.repeat(64)}),send:async command=>sent.push(command),changed(){}});
  await controller.navigate({translationCues:configured},0);
  await controller.navigate({translationCues:configured},2);
  await controller.navigate({translationCues:configured},3);
  assert.deepEqual(sent.map(command=>command.phase),['prepare','live','idle']);
  assert.ok(sent.every(command=>JSON.stringify(command.settings)===JSON.stringify(settings)));
});

test('Stop is awaited, and an immediate restart waits for server acknowledgement', async () => {
  let confirm;
  const sent = [];
  const controller = new SlideTranslationCues({ resolve: async () => ({ serviceId: 'service', serviceRevision: 'a'.repeat(64) }),
    send: async command => { sent.push(command.phase); if (command.phase === 'idle') await new Promise(resolve => { confirm = resolve; }); }, changed() {} });
  await controller.navigate({ translationCues: cues }, 1);
  const stop = controller.stop();
  const restart = controller.navigate({ translationCues: cues }, 1);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(sent, ['live', 'idle']);
  confirm(); await stop; await restart;
  assert.deepEqual(sent, ['live', 'idle', 'live']);
});

test('failed Stop retains ownership for retry instead of claiming the server is idle', async () => {
  let fail = true;
  const controller = new SlideTranslationCues({ resolve: async () => ({ serviceId: 'service', serviceRevision: 'a'.repeat(64) }),
    send: async command => { if (command.phase === 'idle' && fail) throw new Error('Network down'); }, changed() {} });
  await controller.navigate({ translationCues: cues }, 1);
  await assert.rejects(controller.stop(), /Network down/);
  assert.equal(controller.status.phase, 'error');
  fail = false; await controller.stop();
  assert.equal(controller.status.phase, 'idle');
});

test('manual translation survives slides and stops when Show ends', async () => {
  const sent = [];
  const controller = new SlideTranslationCues({ resolve: async () => { throw new Error('manual must not resolve a service'); }, send: async command => sent.push(command), changed() {} });
  await controller.startManual({ sourceLanguage: 'en', transcriptionProvider: 'openai', speechEnabled: false });
  await controller.navigate({ translationCues: cues }, 0);
  await controller.navigate({ translationCues: cues }, 1);
  await controller.navigate({ translationCues: cues }, 4);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].manual, true);
  await controller.stop();
  assert.deepEqual(sent.map(value => value.phase), ['live', 'idle']);
});
test('translation started in the console takes manual ownership in Show', async () => {
  const sent = [];
  const controller = new SlideTranslationCues({ resolve: async () => ({}), send: async command => sent.push(command), changed() {} });
  controller.report({ phase: 'live', manual: true });
  await controller.navigate({ translationCues: cues }, 1);
  assert.equal(sent.length, 0);
  await controller.stop();
  assert.equal(sent[0].phase, 'idle');
  assert.equal(sent[0].manual, true);
});
