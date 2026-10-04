'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),vm=require('node:vm');
const source=fs.readFileSync(require.resolve('../main.js'),'utf8');
const start=source.indexOf("ipcMain.handle('community:planner:openActiveAdjust'");
const end=source.indexOf("ipcMain.handle('community:planner:openService'",start);
async function openFixture({replaceDuringOpen=false}={}) {
  const project={id:'service',assets:{},items:{},updatedAt:'2026-10-04T00:00:00.000Z'};
  let handoff={project:{id:'service'},cueIds:['a','b']},handler,focused;
  const state={activeLaunchPlan:{},currentSlide:1};
  const sandbox=vm.createContext({
    ipcMain:{handle:(name,callback)=>handler=callback},requireControlSender(){},communityIpcResult:fn=>fn(),
    requirePrepareRequest(){},requireExactPrepareKeys(){},communityPlannerBounds:value=>value,
    installedServiceHandoff:()=>handoff,currentPreparedServicePointer:{projectId:'service',projectRevisionId:'old',packageId:'old-package'},
    appState:state,outputSessionId:8,communityAdjustSession:null,
    getPrepareServices:()=>({serviceProjectStore:{read:async()=>({project})}}),serviceDocumentSourceForProject:()=>'',
    getCommunityServices:async()=>({serviceDocumentBindingStore:{get:async()=>null}}),
    require:name=>name.endsWith('PlannerCueFocus') ? {focusPlannerCue: function focusPlannerCue(args) {return {focused:true,...args};}}
      : {validateHeritageServiceDocumentSource:()=>({project,revision:'document-revision'})},
    openCommunityPlannerWindow:async()=>{if(replaceDuringOpen){handoff={project:{id:'service'},cueIds:['a','inserted','b']};state.currentSlide=2;}},
    communityPlannerView:{setBounds(){},webContents:{executeJavaScript:async code=>{focused=vm.runInNewContext(code);return focused;}}},
    communityPlannerShowMode:false,notifyPlannerShowMode(){},communityPlannerCache:{envelope:()=>({project})},
    compileServiceProject:()=>({cueIds:['a','inserted','b'],cues:{a:{itemId:'a'},inserted:{itemId:'inserted'},b:{itemId:'b'}}}),
    path:{},Response,Map,JSON,Error
  });
  vm.runInContext(source.slice(start,end),sandbox);
  await handler({},{});
  return focused;
}
test('opening Adjust selects the current stable live cue',async()=>{
  const focused=await openFixture();assert.equal(focused.cueId,'b');assert.equal(focused.number,3);
});
test('a saved graph taken while Adjust opens cannot select an old ordinal',async()=>{
  const focused=await openFixture({replaceDuringOpen:true});assert.equal(focused.cueId,'b');assert.equal(focused.number,3);
});
