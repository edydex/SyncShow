'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const source = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
const start = source.indexOf('async function takeBackstageServiceCue(');
const end = source.indexOf("ipcMain.handle('community:planner:showMode'", start);
const implementation = source.slice(start, end);

function harness({ flush = async () => ({ok:true,serviceDocument:{syncId:'service'}}), publish, activation, cueIds = ['a', 'inserted', 'b'], unlocked = true } = {}) {
  const events = [];
  const oldPlan = {timelineRoleId:'english',outputs:[{id:'front',name:'Front',displayId:2,sourceRoleId:'english'}]};
  const published = {manifest:{cueIds,cueCount:cueIds.length},presentations:{english:{metadata:{slides:cueIds.map(cueId=>({cueId}))}}}};
  const services = {showPackagePublisher:{publish:async () => {events.push('compile');return publish ? publish(published) : published;}}};
  const context = vm.createContext({
    crypto,
    backstageDraftRevision:remote=>crypto.createHash('sha256').update(JSON.stringify(remote.project)).digest('hex'),
    prepareBackstageShowPackage:async()=>services.showPackagePublisher.publish(),
    captureOutputPreviews:()=>events.push('capture'),
    communityActiveAdjust:null,
    require: name => name.endsWith('/ServiceProject') ? {serializeServiceProject:JSON.stringify} : require('../src/services/show/BackstageCueTarget'),
    communityPlannerCache:{envelope:()=>({project:{id:'service',title:'New draft'}})},
    currentPreparedServicePointer:{projectId:'service',projectRevisionId:'previous'},
    appState:{activeLaunchPlan:oldPlan,currentSlide:0,totalSlides:2,isCleared:false,
      presentations:{english:{metadata:{slides:[{cueId:'a'},{cueId:'b'}]}}}},
    communityPlannerView:{webContents:{isDestroyed:()=>false}},
    activeBibleOverlay:null,pendingBibleOverlay:null,pendingBibleLookup:null,
    showAdjustInProgress:false,outputSessionId:8,presentationRevision:3,bibleOperationEpoch:4,
    outputLifecyclePhase:'live',outputsShouldBeVisible:true,activeLiveCueNavigation:null,outputRecovery:null,
    flushEmbeddedPlanner:flush,
    localShowCommandAllowed:()=>unlocked,
    authorizeLocalShowCommand:()=>events.push('authorize'),
    currentLiveCueTransitionOutputs:()=>({accepted:true}),
    communityServiceDocumentContext:async()=>({projectStore:{}}),
    readLocalServiceDocument:async()=>({}),installBackstageServiceDocument:async()=>({project:{id:'service'},revisionId:'new'}),
    getPrepareServices:()=>services,nativeProjectRoleMapping:()=>({english:'english'}),
    CONFIG:{displayWidth:1920,displayHeight:1080,thumbnailWidth:320},
    outputWindows:new Map([['front',{win:{}}]]),
    resolveLaunchPlan:()=>({...oldPlan,totalSlides:cueIds.length,outputs:[{...oldPlan.outputs[0],renderer:'native-cue'}]}),
    activateCurrentPreparedService:async()=>{events.push('activate');return activation ? activation() : {pointer:{projectId:'service',projectRevisionId:'new'}};},
    rollbackCurrentPreparedServiceActivation:async()=>events.push('rollback'),
    createActiveVolunteerShowBinding:()=>({}),showGateway:{getState:()=>({outputSessionId:8})},
    activeVolunteerShowBinding:null,relockVolunteerShowControls:()=>events.push('relock'),setCurrentPreparedServiceRestore:()=>{},
    goToSlideConfirmed:async(index,options)=>{events.push(['take',index,options]);return {accepted:true,applied:true};},
    publishShowState:()=>events.push('publish'),notifyCommunityPlannerState:()=>{}
  });
  vm.runInContext(`${implementation}\nthis.take = takeBackstageServiceCue`,context);
  return {context,events,oldPlan,published};
}

test('normal advance compiles latest draft and takes inserted successor through forced ACK refresh', async () => {
  const {context,events}=harness();
  const result=await context.take({advance:1});
  assert.equal(result.preparedChanged,true,JSON.stringify(result));
  const take=events.find(event=>Array.isArray(event));
  assert.equal(take[1],1);
  assert.equal(take[2].forceRefresh,true);
  assert.equal(take[2].skipBackstage,true);
  assert.equal(take[2].instantRefresh,false,'Advancing retains the normal transition');
  assert.ok(events.indexOf('activate')<events.indexOf(take));
});
test('retaking the displayed edited slide cuts immediately and refreshes the operator preview', async () => {
  const {context,events}=harness();
  assert.equal((await context.take({targetIndex:0})).preparedChanged,true);
  const take=events.find(event=>Array.isArray(event));
  assert.equal(take[1],0);
  assert.equal(take[2].instantRefresh,true);
  assert.ok(events.indexOf('capture')>events.indexOf(take));
});
test('the active Show draft remains authoritative when its view closes or Prepare opens another draft', async () => {
  for (const otherCache of [null,{envelope(){throw new Error('Prepare must not replace the active Show draft');}}]) {
    const h=harness({flush(){throw new Error('A different view must not be flushed for a live take');}});
    h.context.communityActiveAdjust={sessionId:8,projectId:'service',cache:h.context.communityPlannerCache};
    h.context.communityPlannerCache=otherCache;
    assert.equal((await h.context.take({advance:1})).preparedChanged,true);
  }
});
test('Clear during editor flush cancels even an unchanged or unavailable draft before any take', async () => {
  for (const remote of [null,{project:{id:'service',title:'Old draft'}}]) {
    let context;
    const h=harness({flush:async()=>{context.bibleOperationEpoch++;context.appState.isCleared=true;context.outputLifecyclePhase='cleared';return {ok:true};}});
    context=h.context;
    context.communityPlannerCache.envelope=()=>remote;
    if(remote)context.currentPreparedServicePointer.projectRevisionId=crypto.createHash('sha256').update(JSON.stringify(remote.project)).digest('hex');
    const result=await context.take({cueId:'b'});
    assert.equal(result.code,'LIVE_CUE_TRANSITION_CANCELLED');
    assert.equal(h.events.includes('compile'),false);
    assert.equal(h.events.some(event=>Array.isArray(event)),false);
    assert.equal(context.appState.activeLaunchPlan,h.oldPlan);
  }
});
test('Clear while compilation is pending preserves the old graph and skips pointer activation', async () => {
  let context;
  const h=harness({publish:async published=>{context.bibleOperationEpoch++;context.appState.isCleared=true;return published;}});
  context=h.context;
  assert.equal((await context.take({advance:1})).accepted,false);
  assert.equal(h.events.includes('compile'),true);
  assert.equal(h.events.includes('activate'),false);
  assert.equal(context.appState.activeLaunchPlan,h.oldPlan);
});
test('session change during pointer activation rolls back before replacing output graph', async () => {
  let context;
  const h=harness({activation:async()=>{context.outputSessionId++;return {pointer:{projectId:'service',projectRevisionId:'new'}};}});
  context=h.context;
  assert.equal((await context.take({advance:1})).accepted,false);
  assert.equal(h.events.includes('rollback'),true);
  assert.equal(context.appState.activeLaunchPlan,h.oldPlan);
  assert.equal(h.events.some(event=>Array.isArray(event)),false);
});
test('removed live cue blocks advance but explicit valid draft tile can replace it', async () => {
  const h=harness({cueIds:['replacement','b']});
  assert.equal((await h.context.take({advance:1})).code,'DRAFT_CUE_REMOVED');
  assert.equal(h.events.includes('activate'),false);
  assert.equal((await h.context.take({cueId:'replacement'})).accepted,true);
  assert.equal(h.events.find(event=>Array.isArray(event))[1],0);
});
test('locked volunteer continues verified graph without publishing unreviewed draft', async () => {
  const h=harness({unlocked:false});
  assert.equal(await h.context.take({advance:1}),null);
  assert.equal(h.events.includes('compile'),false);
  assert.equal(h.context.appState.activeLaunchPlan,h.oldPlan);
});
