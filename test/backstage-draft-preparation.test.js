'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {BackstageDraftPreparation}=require('../src/services/show/BackstageDraftPreparation');
function deferred() {let resolve;const promise=new Promise(done=>{resolve=done;});return {promise,resolve};}

test('a take reuses the exact background build and does not repeat compilation',async()=>{
  const cache=new BackstageDraftPreparation(),build=deferred();let count=0;
  const operation=()=>{count++;return build.promise;};
  const warming=cache.prepare('revision-a',operation);
  const take=cache.prepare('revision-a',operation,{required:true});
  assert.equal(take,warming);build.resolve({revision:'a'});
  assert.deepEqual(await take,{revision:'a'});
  assert.deepEqual(await cache.prepare('revision-a',operation,{required:true}),{revision:'a'});
  assert.equal(count,1);
});

test('superseded queued edits are skipped but a requested revision is retained',async()=>{
  const cache=new BackstageDraftPreparation(),first=deferred(),calls=[];
  const a=cache.prepare('a',()=>{calls.push('a');return first.promise;},{required:true});
  const b=cache.prepare('b',()=>{calls.push('b');return 'b';});
  const c=cache.prepare('c',()=>{calls.push('c');return 'c';});
  const take=cache.prepare('b',()=>assert.fail('duplicate build'),{required:true});
  const d=cache.prepare('d',()=>{calls.push('d');return 'd';});
  first.resolve('a');await a;assert.equal(await b,'b');assert.equal(await take,'b');
  assert.equal(await c,null);assert.equal(await d,'d');assert.deepEqual(calls,['a','b','d']);
});

test('a failed warm build is retryable and does not block the next revision',async()=>{
  const cache=new BackstageDraftPreparation();
  await assert.rejects(cache.prepare('a',()=>{throw new Error('storage busy');}),/storage busy/);
  assert.equal(await cache.prepare('a',()=> 'retry',{required:true}),'retry');
  assert.equal(await cache.prepare('b',()=> 'next'),'next');
});
