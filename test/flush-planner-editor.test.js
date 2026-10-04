'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const vm=require('node:vm');
const {flushPlannerEditor}=require('../src/services/community/FlushPlannerEditor');
function fixture(onFlush) {
  const listeners=new Set(),frames=new Map();let nextId=0;
  const window={location:{origin:'https://community.test'},
    requestAnimationFrame:callback=>{frames.set(++nextId,callback);return nextId;},
    cancelAnimationFrame:id=>frames.delete(id),
    addEventListener:(name,receive)=>listeners.add(receive),removeEventListener:(name,receive)=>listeners.delete(receive),
    postMessage:data=>{queueMicrotask(()=>{for(const receive of listeners)receive({source:window,data});if(data.type==='heritage-editor:flush')onFlush(window,data);});}};
  const frame=window.requestAnimationFrame,cancel=window.cancelAnimationFrame;
  const context=vm.createContext({window,performance,setTimeout,clearTimeout,Promise,Map});
  vm.runInContext(`this.flush=${flushPlannerEditor.toString()}`,context);
  return {window,frame,cancel,frames,context};
}
test('hidden editor flush commits and confirms without waiting for a native paint frame',async()=>{
  let commits=0;const f=fixture((window,data)=>window.requestAnimationFrame(()=>{commits++;window.postMessage({type:'heritage-editor:flushed',requestId:data.requestId,ok:true,serviceDocument:{syncId:'service'}});}));
  const start=performance.now(),result=await f.context.flush('request');
  assert.equal(result.ok,true);assert.equal(commits,1);assert(performance.now()-start<500);
  assert.equal(f.window.requestAnimationFrame,f.frame);assert.equal(f.window.cancelAnimationFrame,f.cancel);
  assert.equal(f.frames.size,0);
});
test('a cancelled editor frame does not run through its fallback, and native delivery cannot duplicate a callback',async()=>{
  let cancelled=0,commits=0;
  const f=fixture((window,data)=>{
    const id=window.requestAnimationFrame(()=>cancelled++);window.cancelAnimationFrame(id);
    window.requestAnimationFrame(()=>{commits++;window.postMessage({type:'heritage-editor:flushed',requestId:data.requestId,ok:true});});
    const delivery=[...f.frames.values()][0];delivery(performance.now());delivery(performance.now());
  });
  assert.equal((await f.context.flush('request')).ok,true);
  await new Promise(resolve=>setTimeout(resolve,60));
  assert.equal(cancelled,0);assert.equal(commits,1);
  assert.equal(f.window.requestAnimationFrame,f.frame);assert.equal(f.window.cancelAnimationFrame,f.cancel);
});
