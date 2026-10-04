'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path');
const {CommunityPlannerCache}=require('../src/services/community/CommunityPlannerCache');
const origin='https://fixture.test',endpoint=`${origin}/api/community/service-documents`;
const json=value=>new Response(JSON.stringify(value),{headers:{'Content-Type':'application/json'}});
const read=url=>new Request(url,{headers:{Accept:'application/json'}});
async function fixture(t) {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'adjust-resources-'));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const requests=[];
  let upstream=async()=>json({items:[]});
  const cache=new CommunityPlannerCache({rootPath:root,origin,fetch:request=>{requests.push([request.method,request.url]);return upstream(request);}});
  await cache.loaded;cache.activeServiceId='active-show';
  return {cache,requests,fetch:fn=>{upstream=fn;}};
}

test('explicit Add-song reads discover new songs and revised lyrics without a service GET',async t=>{
  const f=await fixture(t),catalog=read(`${endpoint}/library/songs`),detail=read(`${endpoint}/library/songs/known`);
  await f.cache.cacheResponse(catalog,json({items:[{syncId:'known',title:'Known song'}]}));
  await f.cache.cacheResponse(detail,json({item:{syncId:'known',syncVersion:1,syncDocuments:[{source:'old lyrics'}]}}));
  f.fetch(async request=>request.url===catalog.url
    ? json({items:[{syncId:'known',title:'Revised title'},{syncId:'new-song',title:'Newly created song'}]})
    : json({item:{syncId:'known',syncVersion:2,syncDocuments:[{source:'new lyrics'}]}}));
  const songs=await(await f.cache.request(catalog)).json();
  assert(songs.items.some(item=>item.syncId==='new-song'));
  const song=await(await f.cache.request(detail)).json();
  assert.equal(song.item.syncDocuments[0].source,'new lyrics');
  assert(f.requests.every(([,url])=>url.startsWith(`${endpoint}/library/`)));
  // Cache-only and upstream catalog reads cannot alter the pinned Show graph.
  assert.equal(f.cache.activeServiceId,'active-show');assert.deepEqual(f.cache.state.documents,{});
});

test('offline Add-slide reads fall back to the downloaded Prepare library',async t=>{
  const f=await fixture(t),catalog=read(`${endpoint}/library/slides`);
  f.cache.resourceCache={cachedResponse:async()=>json({items:[{id:'welcome',title:'Welcome'}]})};
  f.fetch(async()=>{throw new Error('offline');});
  const result=await(await f.cache.request(catalog)).json();
  assert.equal(result.items[0].title,'Welcome');assert.equal(f.cache.offline,true);
  assert.equal(f.requests.length,1);
});

test('a stalled explicit resource refresh cancels and uses its local copy promptly',async t=>{
  const f=await fixture(t),catalog=read(`${endpoint}/library/songs`);
  await f.cache.cacheResponse(catalog,json({items:[{title:'Cached song'}]}));
  let aborted=false;
  f.fetch(request=>new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('Fixture abort did not fire')),3000);const abort=()=>{clearTimeout(timer);aborted=true;reject(request.signal.reason);};if(request.signal.aborted)abort();else request.signal.addEventListener('abort',abort,{once:true});}));
  const start=performance.now(),result=await(await f.cache.request(catalog)).json();
  assert.equal(result.items[0].title,'Cached song');assert.equal(aborted,true);
  assert(performance.now()-start<2000,'A cached library refresh must not wait for the ordinary 8-second request timeout');
});

test('a caller cancellation is retained instead of replaced by the ordinary cache timeout',async t=>{
  const f=await fixture(t),controller=new AbortController();let aborted=false;
  f.fetch(request=>new Promise((resolve,reject)=>{const abort=()=>{aborted=true;reject(request.signal.reason);};if(request.signal.aborted)abort();else request.signal.addEventListener('abort',abort,{once:true});}));
  const opening=f.cache.request(new Request(`${endpoint}/library/songs`,{signal:controller.signal}));
  await new Promise(resolve=>setImmediate(resolve));controller.abort();
  assert.equal((await opening).status,503);assert.equal(aborted,true);
});

test('successful song-layout and reusable-slide writes update offline resource copies',async t=>{
  const f=await fixture(t),detail=read(`${endpoint}/library/songs/known`),catalog=read(`${endpoint}/library/slides`);
  await f.cache.cacheResponse(detail,json({schemaVersion:1,item:{syncId:'known',projectionStyle:{bodySize:42}}}));
  await f.cache.cacheResponse(catalog,json({items:[{id:'welcome',title:'Old welcome'}]}));
  f.fetch(async request=>request.method==='POST' ? json({saved:true,projectionStyle:{bodySize:72}})
    : json({items:[{id:'welcome',title:'Updated welcome'}]}));
  assert.equal((await f.cache.request(new Request(`${detail.url}/layout`,{method:'POST',body:JSON.stringify({bodySize:72})}))).status,200);
  assert.equal((await f.cache.request(new Request(`${endpoint}/library/slides/welcome`,{method:'PUT',body:JSON.stringify({title:'Updated welcome'})}))).status,200);
  f.fetch(async()=>{throw new Error('offline');});
  assert.equal((await(await f.cache.request(detail)).json()).item.projectionStyle.bodySize,72);
  assert.equal((await(await f.cache.request(catalog)).json()).items[0].title,'Updated welcome');
});

test('content-hashed resource media remains instant and makes no upstream request',async t=>{
  const f=await fixture(t),asset=read(`${endpoint}/library/slides/welcome/assets/sha256:${'a'.repeat(64)}`);
  await f.cache.cacheResponse(asset,new Response('fingerprinted bytes',{headers:{'Content-Type':'image/png'}}));
  f.fetch(async()=>{throw new Error('The immutable resource must not be fetched');});
  assert.equal(await(await f.cache.request(asset)).text(),'fingerprinted bytes');assert.equal(f.requests.length,0);
});
