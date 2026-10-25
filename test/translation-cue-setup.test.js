'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createServiceProject } = require('../src/services/project/ServiceProject');
const { resolveCueBinding, cueOutputSettings } = require('../src/services/translation/TranslationCueSetup');
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
test('a cue reveals its configured caption band even if saved defaults hide captions', () => {
  const output = {sourceRoleId:'english'};
  const saved = {language:'en',layout:'hidden',fontScale:1.25};
  const settings = {targetLanguage:'ru',captionStyle:'lower-third',captionChannel:'both'};
  assert.deepEqual(cueOutputSettings(output,{phase:'prepare',settings},{},saved),{language:'ru',layout:'hidden',fontScale:1.25});
  assert.deepEqual(cueOutputSettings(output,{phase:'live',settings},{},saved),{language:'ru',layout:'lower-third',fontScale:1.25});
  assert.equal(cueOutputSettings({...output,kind:'singer'},{phase:'live',settings},{},saved).layout,'hidden');
  assert.deepEqual(cueOutputSettings(output,{phase:'live',manual:true},{},saved),saved);
});
