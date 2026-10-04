'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const vm=require('node:vm');
const {focusPlannerCue}=require('../src/services/community/PlannerCueFocus');
function fixture({stageFacing=false,delayedCommit=false,coldActive=false}={}) {
  const calls=[],picker={value:'service',disabled:false};let rows,activeReady=!coldActive;
  if(coldActive)setTimeout(()=>{activeReady=true;},75);
  const row=(id,number,onClick)=>({dataset:{slideId:id},hasAttribute:()=>false,querySelector:selector=>({textContent:selector.endsWith('__kind')?(number?String(number):'▸'):(number?`${number}. Section`:id)}),
    dispatchEvent:e=>{calls.push(['click',id,e.ctrlKey]);if(delayedCommit)setTimeout(onClick,75);else onClick();},scrollIntoView:()=>calls.push(['scroll',id]),focus:()=>calls.push(['focus',id])});
  const target=row('live-cue',27,()=>{target.dataset.active='true';});
  const nested=row('nested',0,()=>{rows=[outer,nested,target];});
  const outer=row('outer',0,()=>{rows=[outer,nested];});
  rows=[outer];
  const outputTabs=[0,1,2].map(index=>({getAttribute:()=>String(index===(stageFacing?2:1)),click:()=>calls.push(['audience-output',index])}));
  const document={activeElement:{closest:()=>true,blur:()=>calls.push(['commit'])},
    querySelector:selector=>selector.includes('service-picker')?(coldActive?null:picker):selector==='[data-active-service]'?(coldActive&&activeReady?{dataset:{activeService:'service'}}:null):selector.includes('__views')?{click:()=>calls.push(['edit'])}:null,
    querySelectorAll:selector=>selector.includes('__output-tabs')?outputTabs:rows};
  const context=vm.createContext({document,window:{location:{origin:'https://community.test',pathname:coldActive?'/syncshow-local/adjust/index.html':'/admin/plan-service'},postMessage:message=>calls.push(['message',message.type])},MouseEvent:class {constructor(type,options){Object.assign(this,options)}},requestAnimationFrame:cb=>setImmediate(cb),cancelAnimationFrame:clearImmediate,clearTimeout,setTimeout,Date,Promise,Number,Set});
  vm.runInContext(`this.focus=${focusPlannerCue.toString()}`,context);
  return {calls,target,context};
}
test('Adjust reveals the current slide through nested collapsed sections and opens Edit without reloading or taking',async()=>{
  const f=fixture();const result=await f.context.focus({syncId:'service',cueId:'live-cue',number:27,sectionIds:['outer','nested']});
  assert.equal(result.focused,true);
  assert.deepEqual(f.calls,[['commit'],['edit'],['click','outer',true],['click','nested',true],['click','live-cue',false],['scroll','live-cue'],['focus','live-cue']]);
});
test('a section title selects only its own slide rather than all its descendants',async()=>{
  const f=fixture();f.target.hasAttribute=()=>true;
  assert.equal((await f.context.focus({syncId:'service',cueId:'live-cue',number:27,sectionIds:['outer','nested']})).focused,true);
  assert.ok(f.calls.some(value=>value[0]==='click'&&value[1]==='live-cue'&&value[2]===true));
});
test('a missing draft slide cannot trigger a live take or alter its text',async()=>{
  const f=fixture();const result=await f.context.focus({syncId:'service',cueId:'removed-cue',number:28,sectionIds:['outer','nested']});
  assert.equal(result.focused,false);
  assert.equal(f.calls.some(x=>x[0]==='message'),false);
});
test('reopening a derived stage-facing preview chooses an editable audience output',async()=>{
  const f=fixture({stageFacing:true});
  assert.equal((await f.context.focus({syncId:'service',cueId:'live-cue',number:27,sectionIds:['outer','nested']})).focused,true);
  assert.deepEqual(f.calls.filter(value=>value[0]==='audience-output'),[['audience-output',0]]);
});
test('an existing Russian audience tab stays selected when opening Adjust',async()=>{
  const f=fixture();
  await f.context.focus({syncId:'service',cueId:'live-cue',number:27,sectionIds:['outer','nested']});
  assert.equal(f.calls.some(value=>value[0]==='audience-output'),false);
});
test('a cold React commit after the first frame cannot skip the containing section or current slide',async()=>{
  const f=fixture({delayedCommit:true});
  const result=await f.context.focus({syncId:'service',cueId:'live-cue',number:27,sectionIds:['outer','nested']});
  assert.equal(result.focused,true);
  assert.deepEqual(f.calls.filter(value=>value[0]==='click'),[['click','outer',true],['click','nested',true],['click','live-cue',false]]);
  assert.deepEqual(f.calls.slice(-2),[['scroll','live-cue'],['focus','live-cue']]);
});
test('a bundled cold Adjust waits for its mount load without opening the service a second time',async()=>{
  const f=fixture({coldActive:true,delayedCommit:true});
  const result=await f.context.focus({syncId:'service',cueId:'live-cue',number:27,sectionIds:['outer','nested']});
  assert.equal(result.focused,true);
  assert.equal(f.calls.some(value=>value[0]==='message'),false,'A second async service load can reset the freshly focused slide');
  assert.deepEqual(f.calls.slice(-2),[['scroll','live-cue'],['focus','live-cue']]);
});
