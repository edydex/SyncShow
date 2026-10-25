'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createServiceProject } = require('../src/services/project/ServiceProject');
const { resolveCueBinding, cueOutputSettings, cueScopedFrame } = require('../src/services/translation/TranslationCueSetup');
const { TranslationProjection } = require('../src/services/translation/TranslationProjection');
const { heritageServiceDocumentRevision, createHeritageServiceDocument } = require('../src/services/community/HeritageServiceDocument');
test('a loaded Community document resolves by content even when its local package marker changes', () => {
  const project = createServiceProject({ id: 'sunday', title: 'Sunday', serviceDate: '2026-10-25', profileId: 'church', now: '2026-10-25T12:00:00.000Z', channels: [{id:'english',label:'English',language:'en'}] });
  const presentation = { projectId:project.id, projectRevisionId:'b'.repeat(64), serviceHandoff:{project} };
  const binding = { serverId:'church', syncId:'sunday', documentRevision:'c'.repeat(64), localRevisionId:'a'.repeat(64) };
  const result = resolveCueBinding(presentation, binding, {serverId:'church'});
  assert.equal(result.serviceId, 'sunday');
  assert.equal(result.serviceRevision, heritageServiceDocumentRevision(createHeritageServiceDocument(project)));
  const changed = resolveCueBinding({...presentation,serviceHandoff:{project:{...project,title:'Changed'}}},binding,{serverId:'church'});
  assert.notEqual(changed.serviceRevision, result.serviceRevision, 'remote exact-revision verification still detects changed service content');
});
test('saved layouts and late captions cannot paint outside the Show cue region', () => {
  const cues = [{id:'opening'}, {id:'before'}, {id:'start',translationAction:'start'}, {id:'sermon'}, {id:'stop',translationAction:'stop'}, {id:'song'}];
  const projection = new TranslationProjection();
  const settings = {language:'ru',layout:'lower-third',fontScale:1.25};
  projection.configure('english', settings);
  projection.accept({type:'public-state',state:{active:true,sessionId:'service',serverTimeUnixMs:Date.now(),languages:[{language:'ru',available:true}]}});
  projection.accept({type:'transcript',segment:{sessionId:'service',channelId:'ru',language:'ru',sequence:1,final:true,text:'Late caption'}});
  const frame = projection.frame('english');
  for (const index of [0, 1, 4, 5, 0]) {
    const scoped = cueScopedFrame(frame,{showActive:true,manual:false,cues,index});
    assert.equal(scoped.layout,'hidden');
    assert.equal(scoped.moving,false);
    assert.deepEqual(scoped.phrases,[]);
  }
  for (const index of [2, 3]) assert.equal(cueScopedFrame(frame,{showActive:true,cues,index}),frame);
  assert.deepEqual(projection.outputs.get('english'),settings,'cue visibility never overwrites the saved layout');
  assert.equal(cueScopedFrame(frame,{showActive:true,manual:true,cues,index:5}),frame,'Translate remains available outside the cue region');
  assert.equal(cueScopedFrame(frame,{showActive:false,cues,index:5}),frame,'standalone translation screens keep their selected layout');
});
test('a cue reveals its configured caption band even if saved defaults hide captions', () => {
  const output = {sourceRoleId:'english'};
  const saved = {language:'en',layout:'hidden',fontScale:1.25};
  const settings = {targetLanguage:'ru',captionStyle:'lower-third',captionChannel:'both'};
  assert.deepEqual(cueOutputSettings(output,{phase:'prepare',settings},{},saved),{language:'ru',layout:'hidden',fontScale:1.25});
  assert.deepEqual(cueOutputSettings(output,{phase:'live',settings},{},saved),{language:'ru',layout:'lower-third',fontScale:1.25});
  assert.equal(cueOutputSettings({...output,kind:'singer'},{phase:'live',settings},{},saved).layout,'hidden');
  assert.deepEqual(cueOutputSettings(output,{phase:'live',manual:true},{},saved),saved);
});
