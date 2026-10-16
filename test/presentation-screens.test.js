'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const core = require('../src/services/project');
const {normalizePresentationScreens} = require('../packages/service-core/node/services/project/PresentationScreens');
const routing = require('../src/renderer/service-screen-routing');
const {compileNativeCueScene} = require('../src/services/show');
const {LocalPlannerSongs} = require('../src/services/community/LocalPlannerSongs');
const {CommunityPlannerCache} = require('../src/services/community/CommunityPlannerCache');
const documentCore = require('../src/services/community/HeritageServiceDocument');

test('screen choices are canonical, survive compilation, and leave legacy project bytes alone', () => {
  assert.equal(normalizePresentationScreens(undefined), undefined);
  const settings = normalizePresentationScreens({screenIds:['media','english']});
  assert.deepEqual(settings, {screenIds:['english','media'],hintScreenIds:['media']});
  for (const value of [{screenIds:[]},{screenIds:['english','english']},{screenIds:['missing']},{screenIds:['english'],hintScreenIds:['media']}]) assert.throws(() => normalizePresentationScreens(value));
  const project = core.createServiceProject({id:'small-service',title:'Homegroup',serviceDate:'2026-10-15',profileId:'main-sanctuary',presentation:{...settings,localOnly:true}});
  const withSlide = core.addProjectItem(project,{id:'welcome',kind:'notice',title:'Welcome',textByChannel:{primary:'Welcome'},presetId:'notice-text'});
  assert.deepEqual(core.compileServiceProject(withSlide).presentation, {...settings,localOnly:true});
  assert.deepEqual(core.normalizeServiceProject(JSON.parse(core.serializeServiceProject(withSlide))).presentation, {...settings,localOnly:true});
  assert.equal(Object.hasOwn(core.createServiceProject({id:'legacy',title:'Sunday',serviceDate:'2026-10-15',profileId:'main-sanctuary'}),'presentation'),false);
});

test('one, two, and three selected screens route without changing Sunday assignments or using controls', () => {
  const presentations = Object.fromEntries(['english','russian','media'].map(id => [id,{presentationScreenId:id}]));
  const outputs = ['english','russian','media'].map((id,index) => ({id,expectedRole:id,displayId:index+20}));
  const before = JSON.stringify(outputs);
  const displays = [{id:1,isControl:true},{id:2},{id:3},{id:4}];
  for (const screenIds of [['english'],['media'],['english','media'],['english','russian','media']]) {
    const selected = routing.presentationOutputs(outputs,presentations,{screenIds},displays,true);
    assert.equal(selected.length,screenIds.length);
    assert.deepEqual(selected.map(output=>output.expectedRole),screenIds);
    assert.equal(new Set(selected.map(output=>output.displayId)).size,screenIds.length);
    assert.ok(selected.every(output=>output.displayId!==1 && !output.usesOperatorDisplay));
  }
  assert.equal(JSON.stringify(outputs),before);
  const short = routing.presentationOutputs(outputs,presentations,{screenIds:['english','russian','media']},displays.slice(0,2),true);
  assert.equal(short.filter(output=>output.displayId===null).length,2);
});

test('audience hint preserves current content, uses semantic next text, and keeps intentional blanks blank', () => {
  const cue = {id:'cue-0123456789abcdef01234567',kind:'notice',title:'Welcome',presetId:'notice-text',channels:{english:{mode:'content',blocks:[{type:'text',role:'body',text:'Welcome everyone',spans:[]}]}}};
  const nextCue = {...cue,id:'cue-123456789abcdef012345678',title:'Next song',channels:{english:{mode:'content',blocks:[{type:'text',role:'body',text:'Next lyric',spans:[]}]}}};
  const options = {width:1920,height:1080,nextCue,presentation:{screenIds:['english'],hintScreenIds:['english']}};
  const scene = compileNativeCueScene(cue,'english',options);
  assert.equal(scene.layout,'singer-current-next');
  assert.equal(scene.current.body,'Welcome everyone');
  assert.ok(scene.next);
  assert.notEqual(compileNativeCueScene(cue,'english',{...options,rendererVersion:21}).layout,'singer-current-next');
  assert.notEqual(compileNativeCueScene({...cue,showNextSlideHints:false},'english',options).layout,'singer-current-next');
  const blank = {...cue,kind:'blank',presetId:'blank-black',channels:{english:{mode:'blank'}}};
  assert.equal(compileNativeCueScene(blank,'english',options).layout,'blank');
});

test('quick presentation and new songs persist offline without sending Community writes', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(),'quick-presentation-'));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const catalog = new LocalPlannerSongs({rootPath:path.join(root,'songs')});
  const raw = {english:{title:'Grace',sections:[{label:'Verse 1',lines:['Amazing grace']}]},russian:{title:'Благодать',sections:[{label:'Куплет 1',lines:['Благодать']}]},authors:['Example author']};
  const saved = await catalog.create(raw);
  assert.equal(saved.syncDocuments.length,2);
  const reopened = new LocalPlannerSongs({rootPath:path.join(root,'songs')});
  assert.deepEqual(await reopened.read(saved.syncId),saved);
  const project = core.createServiceProject({id:'quick-local',title:'Homegroup',serviceDate:'2026-10-15',profileId:'main-sanctuary',presentation:{screenIds:['english'],hintScreenIds:[],localOnly:true}});
  const validated = documentCore.validateHeritageServiceDocumentSource(documentCore.serializeHeritageServiceDocument(documentCore.createHeritageServiceDocument(project)));
  const envelope = {...validated,schemaVersion:1,syncId:project.id,syncVersion:1,status:'planning'};
  const requests = [];
  const origin = 'https://syncshow.local';
  const cache = new CommunityPlannerCache({rootPath:path.join(root,'cache'),origin,localOnly:true,backgroundSync:true,
    localRequest:request=>reopened.request(request),fetch:async request=>{requests.push(request.method);throw new Error('offline')}});
  await cache.pinActiveShow(envelope);
  const changed = {...project,title:'Changed offline'};
  const documentSource = documentCore.serializeHeritageServiceDocument(documentCore.createHeritageServiceDocument(changed));
  const response = await cache.request(new Request(`${origin}/api/community/service-documents/${project.id}`,{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({schemaVersion:1,syncId:project.id,baseRevision:envelope.revision,baseSyncVersion:1,documentSource,status:'planning',saveKind:'manual'})}));
  assert.equal(response.status,200);
  assert.equal((await response.json()).serviceDocument.pending,false);
  await cache.flush();
  assert.deepEqual(requests,[]);
  const listing = await cache.request(new Request(`${origin}/api/community/service-documents/library/songs`));
  assert.equal((await listing.json()).items[0].syncId,saved.syncId);
  const detail = await cache.request(new Request(`${origin}/api/community/service-documents/library/songs/${saved.syncId}`));
  assert.equal((await detail.json()).item.syncDocuments.length,2);
  assert.deepEqual(requests,['GET']);
  const restarted = new CommunityPlannerCache({rootPath:path.join(root,'cache'),origin,localOnly:true,fetch:async()=>{throw new Error('must stay local')}});
  await restarted.loaded;
  assert.equal(restarted.envelope(project.id).project.title,'Changed offline');
  assert.equal(restarted.summary().pending,0);
});

test('Prepare follows newer committed local Show edits while preserving its own unfinished draft', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(),'local-presentation-checkpoint-'));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const project = core.createServiceProject({id:'local-checkpoint',title:'First',serviceDate:'2026-10-15',profileId:'main-sanctuary',presentation:{screenIds:['english'],hintScreenIds:[],localOnly:true}});
  const envelope = title => {
    const validated = documentCore.validateHeritageServiceDocumentSource(documentCore.serializeHeritageServiceDocument(documentCore.createHeritageServiceDocument({...project,title})));
    return {...validated,syncId:project.id,syncVersion:1,status:'planning'};
  };
  const cache = new CommunityPlannerCache({rootPath:root,origin:'https://syncshow.local',localOnly:true,fetch:async()=>{throw new Error('No server')}});
  await cache.pinActiveShow(envelope('First'),null,null,{refreshCommitted:true});
  await cache.pinActiveShow(envelope('Changed in Show'),null,null,{refreshCommitted:true});
  assert.equal(cache.envelope(project.id).project.title,'Changed in Show');
  cache.state.documents[project.id]=envelope('Unfinished in Prepare');
  await cache.pinActiveShow(envelope('Another Show edit'),null,null,{refreshCommitted:true});
  assert.equal(cache.envelope(project.id).project.title,'Unfinished in Prepare');
});


test('explicit Stage-Facing selection temporarily includes a disabled venue output', () => {
  const outputs = [{id:'english',enabled:true,expectedRoleId:'english'},{id:'singer',enabled:false,expectedRoleId:'media'}];
  const presentations = {english:{presentationScreenId:'english'},media:{presentationScreenId:'media'}};
  assert.deepEqual(routing.enabledOutputs(outputs,presentations,null).map(output=>output.id),['english']);
  assert.deepEqual(routing.enabledOutputs(outputs,presentations,{screenIds:['english','media']}).map(output=>output.id),['english','singer']);
  assert.equal(outputs[1].enabled,false);
});
