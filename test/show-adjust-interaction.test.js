'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require.resolve('../src/renderer/app.js'), 'utf8');
const adjust = source.slice(source.indexOf('async function toggleShowAdjust('), source.indexOf('let backstageRefreshPromise'));
function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }
function fixture({ opening, saving } = {}) {
  const calls = [], state = {workflowStage:'show',currentSlide:1,serviceHandoff:{project:{id:'service'},cueIds:['first','current']},community:{plannerOpen:true}};
  const elements = {showAdjustPanel:{hidden:true},showAdjustViewport:{getBoundingClientRect:()=>({left:0,top:100,width:1000,height:600})},btnShowAdjust:{setAttribute(){},focus(options){calls.push(['focus',options.preventScroll]);}},showAdjustStatus:{}};
  const context = vm.createContext({state,elements,
    window:{api:{async setPlannerShowMode(enabled){calls.push(['mode',enabled]);},async openActiveShowAdjust(request){if(opening)await opening.promise;calls.push(['active-local',request.bounds]);return {opened:true};},
      async layoutCommunityPlanner(request){calls.push(['layout',request.visible]);},async flushCommunityPlanner(){calls.push(['flush']);return saving ? saving.promise : {};}}},
    async openCommunityPrepare(){if(opening)await opening.promise;state.community.plannerOpen=true;},
    renderShowAdjustStatus(){},renderVolunteerShowControls(){},communityCheckedResult:value=>value,
    async syncCommunityPlannerLayout(){calls.push(['visible-layout']);},updateThumbnailHighlight(options){calls.push(['scroll-current',options.behavior]);},
    scheduleCommunityPlannerLayout(){calls.push(['schedule']);},setStatus:message=>calls.push(['status',message])
  });
  vm.runInContext(`let showAdjustOpen=false,showAdjustBusy=false,showAdjustGeneration=0;\n${adjust}\nthis.isOpen=()=>showAdjustOpen;`, context);
  return {context,state,elements,calls};
}

test('Adjust uses ordinary selection and editing without allowing live slide takes', async () => {
  const f=fixture();await f.context.toggleShowAdjust();
  assert.equal(f.context.isOpen(),true);
  assert.deepEqual(JSON.parse(JSON.stringify(f.calls.find(call=>call[0]==='active-local'))),['active-local',{x:0,y:100,width:1000,height:600}]);
  assert.ok(f.calls.some(call=>call[0]==='visible-layout'));
  assert.deepEqual(f.calls.filter(call=>call[0]==='mode'),[]);
});

test('closing Adjust removes its native input surface before a pending save finishes', async () => {
  const saving=deferred(),f=fixture({saving});await f.context.toggleShowAdjust();
  const closing=f.context.closeShowAdjust();
  assert.equal(f.elements.showAdjustPanel.hidden,true);
  assert.equal(f.context.isOpen(),false);
  assert.deepEqual(f.calls.find(call=>call[0]==='layout'),['layout',false]);
  saving.resolve({});await closing;
  assert.deepEqual(f.calls.find(call=>call[0]==='scroll-current'),['scroll-current','instant']);
  assert.deepEqual(f.calls.find(call=>call[0]==='focus'),['focus',true]);
});

test('a late Adjust open cannot resurface over thumbnails after it was closed', async () => {
  const opening=deferred(),f=fixture({opening});
  const pending=f.context.toggleShowAdjust();await f.context.closeShowAdjust();
  const before=f.calls.length;opening.resolve();await pending;
  assert.equal(f.context.isOpen(),false);
  assert.equal(f.elements.showAdjustPanel.hidden,true);
  assert.equal(f.calls.filter(call=>call[0]==='schedule').length,1,'No late layout can resurface the editor');
  assert.equal(f.calls.some(call=>call[0]==='visible-layout'),false);
});
