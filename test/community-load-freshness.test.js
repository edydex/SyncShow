'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const main = fs.readFileSync(require.resolve('../main.js'), 'utf8');
const controllerSource = fs.readFileSync(require.resolve('../src/renderer/community-service-document-controller.js'), 'utf8');
const id = 'service-sunday', revision = 'a'.repeat(64);
function deferred() { let resolve; const promise = new Promise(r => {resolve=r;}); return {promise, resolve}; }
function mainFixture(options = {}) {
  let handoff = {project: {id, revisionId: revision}};
  const cached = options.cached === undefined ? {revision:'old-cache', project:{id}} : options.cached;
  const remote = {syncId:id, revision:options.remoteRevision || 'new-remote', documentSource:options.remoteSource || 'remote-source', project:{id, title:'Sunday', assets:{}}, syncVersion:20};
  const local = {project:{id, title:'Sunday'}, revisionId:options.localRevisionId || revision, documentSource:options.localSource || 'old-source', documentRevision: options.localRevision || 'old-base'};
  const binding = {serverId:'church', syncId:id, documentRevision:options.baseRevision || 'old-base', localRevisionId:revision};
  const fetches=[], installs=[], bindings=[], requests=[];
  const context = {connection:{serverId:'church', accessToken:'fixture-only'}, client:{async getServiceDocument(request) {requests.push(request);fetches.push(id); if(options.wait) await options.wait; return remote;}}, projectStore:{}, bindingStore:{async get(){return binding;}}, outbox:{async get(){return options.nativePending || null;}}};
  const sandbox = vm.createContext({appState:{activeLaunchPlan:options.live ? {} : null}, installedServiceHandoff:()=>handoff,
    communityRequestKeys(){}, prepareId:value=>value, prepareRevision:value=>value,
    failMainOperation(code,message){throw Object.assign(new Error(message), {code});},
    communityServiceDocumentContext:async()=>context, communityPlannerCache:{envelope:()=>cached},
    readLocalServiceDocument:async()=>local, projectResult:value=>value,
    saveServiceDocumentBinding:async value=>{bindings.push(value);return binding;}, publicServiceDocumentBinding:value=>value,
    installCommunityServiceDocument:async(ctx,r,l,opts)=>{installs.push({remote:r,local:l,opts});return{state:'opened',project:r.project,revisionId:'b'.repeat(64)};},
    serviceDocumentConflict:value=>({state:'conflict',conflict:value})
  });
  const start=main.indexOf('async function openSharedServiceDocument('), end=main.indexOf("\nipcMain.handle('community:serviceDocuments:open'",start);
  vm.runInContext(main.slice(start,end),sandbox);
  return {fetches, installs, bindings, requests, remote, local, setLoaded(value){handoff=value;},
    open:request=>sandbox.openSharedServiceDocument({syncId:id, fresh:true, expectedLoadedRevisionId:revision, ...request})};
}
test('Load fetches the selected service directly instead of the old Prepare cache',async()=>{
  const f=mainFixture(); const result=await f.open();
  assert.equal(result.state,'opened'); assert.deepEqual(f.fetches,[id]);
  assert.equal(f.installs[0].remote,f.remote); assert.equal(f.installs[0].opts.usePlannerCache,false);
});
test('the exact latest loaded content is checked without downloading assets or rebuilding',async()=>{
  const f=mainFixture({localSource:'same',remoteSource:'same'});
  assert.equal((await f.open()).state,'current'); assert.equal(f.fetches.length,1); assert.equal(f.installs.length,0);
  assert.equal(f.bindings[0].remote,f.remote);
});
test('pending Prepare saves and conflict copies remain untouched',async()=>{
  for(const cached of [{pending:true},{conflict:true}]) {
    const f=mainFixture({cached}); assert.equal((await f.open()).state,'prepare-pending');
    assert.equal(f.fetches.length,0); assert.equal(f.installs.length,0);
  }
});
test('confirmed Prepare handoff can still use its exact cached offline edit',async()=>{
  const f=mainFixture(); assert.equal((await f.open({fresh:false})).state,'opened');
  assert.equal(f.fetches.length,0); assert.equal(f.installs[0].opts.usePlannerCache,true);
});
test('concurrent native and Community changes require review',async()=>{
  const f=mainFixture({localRevision:'local-edit',localRevisionId:'c'.repeat(64)});
  assert.equal((await f.open()).state,'conflict'); assert.equal(f.installs.length,0);
});
test('changing the loaded service while its server check runs cannot replace it',async()=>{
  const wait=deferred(), f=mainFixture({wait:wait.promise}); const opening=f.open();
  await new Promise(resolve=>setImmediate(resolve)); f.setLoaded({project:{id:'another-service', revisionId:revision}});
  wait.resolve(); assert.equal((await opening).state,'superseded'); assert.equal(f.installs.length,0);
});
test('an active Show is never refreshed in the background',async()=>{
  const f=mainFixture({live:true}); assert.equal((await f.open()).state,'superseded'); assert.equal(f.fetches.length,0);
});
function controllerFixture(result={state:'current'}, options={}) {
  const nodes=new Map(); const get=id=>{if(!nodes.has(id))nodes.set(id,{textContent:'',dataset:{},hidden:false,open:false,disabled:false,
    listeners:{}, addEventListener(name,fn){this.listeners[name]=fn;},setAttribute(){},replaceChildren(){},appendChild(){},
    showModal(){this.open=true; this.opens=(this.opens||0)+1;},close(){this.open=false;}});return nodes.get(id);};
  let active=true; const calls=[], published=[], loaded=[], progress=[];
  const api={getCommunityStatus:async()=>({connected:true,connection:{canReadServiceDocuments:true}}),
    listCommunityServiceDocuments:async()=>({items:[]}), getCommunityServiceDocumentState:async()=>({shared:options.unshared?null:{syncId:id}}),
    openCommunityServiceDocument:async request=>{calls.push(request); if(options.wait) await options.wait;
      if(options.error)throw new Error('offline'); return result;},
    saveCommunityServiceDocument(){},flushCommunityServiceDocuments(){},publishServiceProject:async request=>{published.push(request);
      if(options.buildError)throw new Error('Missing media');return{};}};
  const window={api}; const sandbox=vm.createContext({window,document:{getElementById:get,createElement:()=>({})}});
  vm.runInContext(controllerSource,sandbox);
  const controller=window.SyncShowSharedServices.createController({api,prepareController:{},onLoaded:async()=>loaded.push(id)}).initialize();
  return {nodes,calls,published,loaded,progress, deactivate(){active=false;},
    refresh:()=>controller.refreshLoaded(id,revision,{isCurrent:()=>active,progress:value=>progress.push(value)}),
    open:()=>controller.openById(id)};
}
test('automatic latest check quietly builds a newer exact service without opening the picker',async()=>{
  const f=controllerFixture({state:'opened',project:{id,title:'Sunday'},revisionId:'b'.repeat(64)});
  assert.equal((await f.refresh()).state,'updated'); assert.equal(f.calls[0].fresh,true);
  assert.equal(f.calls[0].expectedLoadedRevisionId,revision); assert.equal(f.published.length,1); assert.equal(f.loaded.length,1);
  assert.equal(f.nodes.get('sharedServicesDialog').opens,undefined); assert.match(f.progress.at(-1),/Preparing Sunday/);
});
test('a current package and an unshared local service do not rebuild',async()=>{
  const current=controllerFixture(); assert.equal((await current.refresh()).state,'current'); assert.equal(current.published.length,0);
  const local=controllerFixture({}, {unshared:true}); assert.equal((await local.refresh()).state,'unshared'); assert.equal(local.calls.length,0);
});
test('offline and failed builds leave the previously loaded package intact',async()=>{
  for(const options of [{error:true},{buildError:true}]) {
    const f=controllerFixture({state:'opened',project:{id},revisionId:revision},options);
    assert.equal((await f.refresh()).state,'unavailable'); assert.equal(f.loaded.length,0); assert.equal(f.nodes.get('sharedServicesDialog').open,false);
  }
});
test('duplicate checks and leaving Load do not publish obsolete results',async()=>{
  const wait=deferred(),f=controllerFixture({state:'opened',project:{id},revisionId:revision},{wait:wait.promise});
  const first=f.refresh(); await new Promise(resolve=>setImmediate(resolve));
  assert.equal((await f.refresh()).state,'busy'); f.deactivate(); wait.resolve();
  assert.equal((await first).state,'superseded'); assert.equal(f.published.length,0); assert.equal(f.calls.length,1);
});
test('only an actual conflict opens the review dialog',async()=>{
  const f=controllerFixture({state:'conflict',conflict:{kind:'concurrent-change',local:{},remote:{}}});
  assert.equal((await f.refresh()).state,'conflict'); assert.equal(f.nodes.get('sharedServicesDialog').opens,1); assert.equal(f.published.length,0);
});
const appSource=fs.readFileSync(require.resolve('../src/renderer/app.js'),'utf8');
function appFixture() {
  const wait=deferred(),calls=[],notice={dataset:{}};
  const state={serviceHandoff:{project:{id,revisionId:revision}},loadFreshness:{busy:false,message:'',kind:''},workflowStage:'load',loadMode:'syncshow',community:{}};
  const warning={hidden:true,textContent:''};
  const sandbox=vm.createContext({state,elements:{loadPrepareWarning:warning},setPrepareLoadWarning(message){warning.hidden=!message;warning.textContent=message;},document:{getElementById:()=>notice},checkReadyState(){},
    sharedServiceController:{async refreshLoaded(syncId,rev,options){calls.push({syncId,rev,options}); options.progress('Checking Community…');return wait.promise;}}});
  vm.runInContext('let loadFreshnessPromise=null;\n'+appSource.slice(appSource.indexOf('function renderLoadFreshness('),appSource.indexOf('function planningStatusLabel(')),sandbox);
  return{state,calls,notice,wait,warning,refresh:()=>sandbox.refreshLoadedService()};
}
test('the Load status checks only the selected service and coalesces repeated navigation',async()=>{
  const f=appFixture(), first=f.refresh(),second=f.refresh();
  assert.equal(f.calls.length,1);assert.equal(f.calls[0].syncId,id);assert.equal(f.state.loadFreshness.busy,true);
  f.wait.resolve({state:'current'});await Promise.all([first,second]);
  assert.equal(f.state.loadFreshness.busy,false); assert.match(f.notice.textContent,/Latest Community version checked/);
});
test('Load exposes offline uncertainty without claiming the saved package is latest',async()=>{
  const f=appFixture(),opening=f.refresh();f.wait.resolve({state:'unavailable'});await opening;
  assert.match(f.notice.textContent,/available offline.*latest version has not been verified/);assert.equal(f.notice.dataset.kind,'warning');
});
test('background refresh does not run from Prepare or during a live session',async()=>{
  for(const change of [{workflowStage:'prepare'},{activeLaunchPlan:{id:'live'}},{startAttempt:{id:'starting'}}]) {
    const f=appFixture();Object.assign(f.state,change);await f.refresh();assert.equal(f.calls.length,0);
  }
});

test('newly published local edits keep their sync warning after replacing the handoff',async()=>{
  for (const outcome of ['queued','local-newer']) {
    const f=appFixture(),opening=f.refresh();
    f.state.serviceHandoff={project:{id,revisionId:'b'.repeat(64)}};
    f.wait.resolve({state:outcome});await opening;
    assert.match(f.notice.textContent,/edits.*sync with Community/);assert.equal(f.notice.dataset.kind,'warning');
  }
});

test('a coalesced server counter does not invent a concurrent local edit',async()=>{
  const f=mainFixture({localRevision:'local-counter-alias',baseRevision:'new-remote'});
  assert.equal((await f.open()).state,'opened');assert.equal(f.installs[0].remote,f.remote);
});
test('a successful latest check makes an earlier Prepare save warning accurate',async()=>{
  const f=appFixture();f.warning.hidden=false;f.warning.textContent='Prepare’s latest edits have not been loaded.';
  const opening=f.refresh();f.wait.resolve({state:'current'});await opening;
  assert.match(f.warning.textContent,/latest saved version is loaded.*pending edits/);
  assert.doesNotMatch(f.warning.textContent,/latest edits have not been loaded/);
});

test('the loaded bound revision uses a conditional check and skips all installation on 304',async()=>{
 const f=mainFixture();f.remote.notModified=true;
 assert.equal((await f.open()).state,'current');assert.equal(f.requests[0].knownRevision,'old-base');assert.equal(f.installs.length,0);
});
test('Prepare-to-Load reuses the already loaded exact cached snapshot',async()=>{
 const f=mainFixture({cached:{documentSource:'old-source',project:{id}}});
 assert.equal((await f.open({fresh:false})).state,'current');assert.equal(f.fetches.length,0);assert.equal(f.installs.length,0);
});

test('queued native edits are retained before a conditional server read',async()=>{
 const f=mainFixture({cached:null,nativePending:{revision:'local-outbox'}});
 assert.equal((await f.open()).state,'queued');assert.equal(f.fetches.length,0);assert.equal(f.installs.length,0);
});
