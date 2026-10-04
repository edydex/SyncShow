'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path');
const {CommunityPlannerCache}=require('../src/services/community/CommunityPlannerCache');
const origin='https://response-cache.test';
const request=new Request(`${origin}/api/community/service-documents/library/songs/known`,{headers:{Accept:'application/json'}});
const response=version=>new Response(JSON.stringify({version,text:`lyrics ${version}`}),{headers:{'Content-Type':'application/json','X-Version':String(version)}});
async function fixture(t,fetch=async()=>response(9)){
  const rootPath=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'planner-response-')));
  t.after(()=>fs.rm(rootPath,{recursive:true,force:true}));
  const cache=new CommunityPlannerCache({rootPath,origin,fetch});await cache.loaded;
  return cache;
}

test('a catalog-prefetch writer cannot expose truncated metadata or a mismatched response body',async t=>{
  const cache=await fixture(t);await cache.cacheResponse(request,response(1));
  const target=cache.cachePath(request),rename=fs.rename,writeFile=fs.writeFile,readFile=fs.readFile;
  let unblock,announce,intercepted=false;
  const blocked=new Promise(resolve=>{announce=resolve;}),gate=new Promise(resolve=>{unblock=resolve;});
  t.after(()=>{unblock();fs.rename=rename;fs.writeFile=writeFile;fs.readFile=readFile;});
  fs.rename=async(from,to)=>{if(to===`${target}.response`){intercepted=true;announce();await gate;}return rename(from,to);};
  // Also reproduces the old two-file writer deterministically: it used to
  // truncate the metadata while a detached catalog-prefetch write ran.
  fs.writeFile=async(file,bytes,options)=>{
    if(file===`${target}.json`){await writeFile(file,'',options);intercepted=true;announce();await gate;}
    return writeFile(file,bytes,options);
  };
  fs.readFile=async(file,...options)=>file===`${target}.json`&&intercepted?Buffer.alloc(0):readFile(file,...options);
  const writing=cache.cacheResponse(request,response(2));await blocked;
  const restarted=new CommunityPlannerCache({rootPath:cache.rootPath,origin,fetch:async()=>response(9)});await restarted.loaded;
  const reading=Promise.all([cache,restarted].map(async reader=>{
    const value=await reader.cachedResponse(request);
    assert.ok(value,'The previously committed response remains available during replacement');
    const body=await value.json();assert.equal(value.headers.get('x-version'),String(body.version));
    assert.equal(body.version,1,'Blocked replacement still exposes the complete previous snapshot');
  }));
  let timer;
  try { await Promise.race([reading,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('Cached reads waited for the blocked writer')),1000);})]); }
  finally { clearTimeout(timer);unblock();await writing; }
  assert.equal((await(await cache.cachedResponse(request)).json()).version,2);
});

test('parallel same-key refreshes remain complete and survive a new cache instance',async t=>{
  const cache=await fixture(t);await cache.cacheResponse(request,response(0));
  await Promise.all(Array.from({length:12},async(_,index)=>{
    await cache.cacheResponse(request,response(index+1));
    const observed=await cache.cachedResponse(request);
    // A path replacement detected by StorageSafety is a transient cache miss,
    // never a partially assembled response or a leaked filesystem error.
    if(!observed)return;
    const body=await observed.json();assert.equal(observed.headers.get('x-version'),String(body.version));
  }));
  const restarted=new CommunityPlannerCache({rootPath:cache.rootPath,origin,fetch:async()=>{throw new Error('offline');}});
  await restarted.loaded;const observed=await restarted.cachedResponse(request);assert.ok(observed);
  assert.equal(observed.headers.get('x-version'),String((await observed.json()).version));
});

test('old valid cache pairs are readable, while incomplete metadata/body and oversized entries are cache misses',async t=>{
  const cache=await fixture(t),target=cache.cachePath(request);
  await fs.mkdir(path.dirname(target),{recursive:true});
  const metadata=JSON.stringify({status:200,headers:[['Content-Type','application/json']]});
  await fs.writeFile(`${target}.json`,metadata);await fs.writeFile(target,'{"version":1}');
  assert.equal((await(await cache.cachedResponse(request)).json()).version,1);
  await fs.writeFile(`${target}.json`,'');assert.equal(await cache.cachedResponse(request),null);
  await fs.writeFile(`${target}.json`,metadata);await fs.writeFile(target,'{"version":');
  assert.equal(await cache.cachedResponse(request),null);
  await fs.unlink(target);assert.equal(await cache.cachedResponse(request),null);
  const file=await fs.open(target,'w');await file.truncate(32*1024*1024+1);await file.close();
  assert.equal(await cache.cachedResponse(request),null);
});

test('truncated or corrupted atomic envelopes fall back to a fresh upstream resource',async t=>{
  const cache=await fixture(t);cache.activeServiceId='active';await cache.cacheResponse(request,response(1));
  const target=`${cache.cachePath(request)}.response`,valid=await fs.readFile(target);
  for(const broken of [Buffer.alloc(0),valid.subarray(0,20),valid.subarray(0,valid.length-1),Buffer.from(valid)]){
    if(broken.length===valid.length)broken[broken.length-1]^=1;
    await fs.writeFile(target,broken);assert.equal(await cache.cachedResponse(request),null);
  }
  assert.equal((await(await cache.request(request)).json()).version,9);
});

test('oversized chunked responses never replace the last usable cached response',async t=>{
  const cache=await fixture(t);await cache.cacheResponse(request,response(1));
  const chunk=Buffer.alloc(64*1024);let sent=0;
  const oversized=new Response(new ReadableStream({pull(controller){controller.enqueue(chunk);if(++sent===514)controller.close();}}));
  await cache.cacheResponse(request,oversized);
  await oversized.body.cancel();
  assert.equal((await(await cache.cachedResponse(request)).json()).version,1);
  assert(sent<=514,'Reading stops at the cache byte bound');
});

test('bodyless successful responses retain their status without creating an invalid Response',async t=>{
  const cache=await fixture(t);await cache.cacheResponse(request,new Response(null,{status:204}));
  assert.equal((await cache.cachedResponse(request)).status,204);
});

test('a slow earlier response body cannot replace a later committed refresh',async t=>{
  const cache=await fixture(t);let controller;
  const slow=new Response(new ReadableStream({start(value){controller=value;}}),{headers:{'Content-Type':'application/json','X-Version':'1'}});
  const earlier=cache.cacheResponse(request,slow);
  await cache.cacheResponse(request,response(2));
  controller.enqueue(Buffer.from(JSON.stringify({version:1,text:'lyrics 1'})));controller.close();await earlier;
  assert.equal((await(await cache.cachedResponse(request)).json()).version,2);
});

for(const kind of ['songs','sermons'])test(`a late ${kind} prefetch cannot replace the newer explicit library read`,async t=>{
  let finish,announce,count=0;const started=new Promise(resolve=>{announce=resolve;});
  const cache=await fixture(t,async()=>++count===1?new Promise(resolve=>{finish=resolve;announce();}):response(2));
  cache.activeServiceId='active';
  const detail=kind==='songs'?request:new Request(`${origin}/api/community/sermon-presentations/known`,{headers:{Accept:'application/json'}});
  const prefetch=kind==='songs'?cache.prefetchSongs([{syncId:'known'}]):cache.prefetchSermons([{syncId:'known'}]);
  await started;assert.equal((await(await cache.request(detail)).json()).version,2);
  finish(response(1));await prefetch;
  assert.equal((await(await cache.cachedResponse(detail)).json()).version,2);
});

test('a failed later fetch does not prevent the earlier valid prefetch becoming the offline copy',async t=>{
  let finish,announce,count=0;const started=new Promise(resolve=>{announce=resolve;});
  const cache=await fixture(t,async()=>++count===1?new Promise(resolve=>{finish=resolve;announce();}):Promise.reject(new Error('offline')));
  cache.activeServiceId='active';await cache.cacheResponse(request,response(0));
  const prefetch=cache.prefetchSongs([{syncId:'known'}]);await started;
  assert.equal((await(await cache.request(request)).json()).version,0);
  finish(response(1));await prefetch;
  assert.equal((await(await cache.cachedResponse(request)).json()).version,1);
});

test('malformed or empty upstream JSON cannot replace the last usable cache snapshot',async t=>{
  const cache=await fixture(t);await cache.cacheResponse(request,response(1));
  for(const body of ['','{"version":','this is not JSON']){
    await cache.cacheResponse(request,new Response(body,{headers:{'Content-Type':'application/json'}}));
    assert.equal((await(await cache.cachedResponse(request)).json()).version,1);
  }
});

test('a failed later publication leaves an earlier valid response eligible to update the cache',async t=>{
  const cache=await fixture(t);await cache.cacheResponse(request,response(0));let controller;
  const slow=new Response(new ReadableStream({start(value){controller=value;}}),{headers:{'Content-Type':'application/json'}});
  const earlier=cache.cacheResponse(request,slow),rename=fs.rename;
  fs.rename=async()=>{throw Object.assign(new Error('fixture publication failed'),{code:'EACCES'});};
  try{await assert.rejects(cache.cacheResponse(request,response(2)),/publication failed/);}
  finally{fs.rename=rename;}
  controller.enqueue(Buffer.from('{"version":1}'));controller.close();await earlier;
  assert.equal((await(await cache.cachedResponse(request)).json()).version,1);
});
