'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const source=fs.readFileSync(path.join(__dirname,'../src/renderer/app.js'),'utf8');
const implementation=source.slice(source.indexOf('let backstageRefreshPromise = null;'),source.indexOf('function renderCommunityPrepare()'));
function deferred() {let resolve;const promise=new Promise(done=>{resolve=done;});return {promise,resolve};}
function harness() {
  const pending=new Map(),renders=[];
  const context=vm.createContext({
    state:{workflowStage:'show',activeLaunchPlan:{timelineRoleId:'english'},serviceHandoff:{project:{id:'service',revisionId:'live-a'}},currentSlide:1,showState:{currentCue:{id:'b'}},community:{}},
    window:{api:{getBackstagePreview:key=>{const job=deferred();pending.set(key,job);return job.promise;}}},
    communityCheckedResult:result=>result.data,
    elements:{thumbnailsGrid:{scrollTop:240}},document:{activeElement:null},
    renderThumbnails:()=>renders.push(true),setStatus:()=>{},cueAt:()=>({id:'b'})
  });
  vm.runInContext(implementation+'\nthis.refresh=refreshBackstagePreview;this.preview=showBackstagePreview;this.clear=clearBackstagePreview;this.currentIndex=thumbnailCurrentIndex;',context);
  const result=key=>({success:true,data:{key,projectId:'service',sessionId:8,cueIds:['a','inserted','b'],slidesByRole:{}}});
  return {context,pending,renders,result};
}

test('a refreshed equivalent live plan cannot discard a saved preview in flight',async()=>{
  const h=harness(),request=h.context.refresh('draft-a');
  h.context.state.activeLaunchPlan={timelineRoleId:'english'};
  h.pending.get('draft-a').resolve(h.result('draft-a'));await request;
  assert.equal(h.context.preview().key,'draft-a');
  assert.equal(h.context.currentIndex(),2,'The live marker follows the cue identity after an inserted slide');
  assert.equal(h.context.elements.thumbnailsGrid.scrollTop,240);
});

test('a late older preview cannot replace the more recent saved draft',async()=>{
  const h=harness(),old=h.context.refresh('draft-a'),newer=h.context.refresh('draft-b');
  h.pending.get('draft-b').resolve(h.result('draft-b'));await newer;
  h.pending.get('draft-a').resolve(h.result('draft-a'));await old;
  assert.equal(h.context.preview().key,'draft-b');assert.equal(h.renders.length,1);
});

test('a new live revision or closed Show rejects a pending old preview',async()=>{
  for(const change of [h=>{h.context.state.serviceHandoff.project.revisionId='live-b';},h=>{h.context.state.workflowStage='load';h.context.clear();}]) {
    const h=harness(),request=h.context.refresh('draft-a');change(h);
    h.pending.get('draft-a').resolve(h.result('draft-a'));await request;
    assert.equal(h.context.preview(),null);assert.equal(h.renders.length,0);
  }
});

test('a removed live cue cannot highlight its previous ordinal in the draft',async()=>{
  const h=harness(),request=h.context.refresh('draft-a'),response=h.result('draft-a');
  response.data.cueIds=['a','replacement'];h.pending.get('draft-a').resolve(response);await request;
  assert.equal(h.context.currentIndex(),-1);
});
