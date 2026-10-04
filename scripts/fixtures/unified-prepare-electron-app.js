'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const http = require('node:http');
const electron = require('electron');
const { app, BrowserWindow } = electron;
const core = require('../../src/services/community/HeritageServiceDocument');
const { CommunityConnectionStore } = require('../../src/services/community/CommunityConnectionStore');
const { AppLocalCredentialStorage } = require('../../src/services/community/AppLocalCredentialStorage');
const root = process.env.SYNCSHOW_TEST_USER_DATA_DIR;
const resultPath = process.env.SYNCSHOW_UNIFIED_RESULT;
let offline = false, saved, holdChecks = false, holdWrites = false;
const heldWrites = [];
const editingFixture = process.env.SYNCSHOW_ADJUST_EDITING_FIXTURE;
const serverRequests=[];
const heldChecks = [];
const loadQueueFixture = process.env.SYNCSHOW_LOAD_QUEUE_FIXTURE === '1';
if (loadQueueFixture || editingFixture) {
  // Test renderers stay hidden: no rehearsal can cover the operator's screen.
  BrowserWindow.prototype.show = function () {};
  BrowserWindow.prototype.showInactive = function () {};
  BrowserWindow.prototype.setFullScreen = function () {};
}
const scopes = ['syncshow:service-documents:read', 'syncshow:service-documents:write'];
const fakeDisplays = [
  { id: 1, internal: true, bounds: { x: 0, y: 0, width: 1400, height: 900 } },
  { id: 2, internal: false, bounds: { x: 1400, y: 0, width: 1920, height: 1080 } },
  { id: 3, internal: false, bounds: { x: 3320, y: 0, width: 1920, height: 1080 } },
  { id: 4, internal: false, bounds: { x: 5240, y: 0, width: 1920, height: 1080 } }
].map(display => ({ ...display, size: { width: display.bounds.width, height: display.bounds.height },
  workArea: display.bounds, workAreaSize: { width: display.bounds.width, height: display.bounds.height },
  scaleFactor: 1, rotation: 0, touchSupport: 'unknown', monochrome: false, colorDepth: 24, depthPerComponent: 8, displayFrequency: 60 }));
app.once('ready', () => {
  electron.screen.getPrimaryDisplay = () => fakeDisplays[0];
  electron.screen.getAllDisplays = () => fakeDisplays;
  electron.screen.getDisplayMatching = bounds => fakeDisplays.find(display => bounds.x >= display.bounds.x && bounds.x < display.bounds.x + display.bounds.width) || fakeDisplays[0];
});
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function waitFor(callback, label) {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) { const value = await callback(); if (value) return value; await delay(50); }
  throw new Error(`Timed out: ${label}`);
}
function json(response, body, status = 200) { response.writeHead(status, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(body)); }
function serviceWire() { const {syncId,syncVersion,revision,documentSource,status,changedAt}=saved;return {serviceDocument:{syncId,syncVersion,revision,documentSource,status,changedAt}}; }
async function body(request) { const chunks = []; for await (const chunk of request) chunks.push(chunk); return JSON.parse(Buffer.concat(chunks)); }
const plannerHtml = `<!doctype html><html><head><style>body{margin:0;background:#121a2d;color:white;font:16px system-ui;padding:30px}input,button{font:inherit;margin:8px;padding:10px}section{margin-top:25px}</style></head><body><h1>Prepare service · offline fixture</h1><input id="text" value="Original slide"><button id="save">Save</button><p id="status"></p><section id="preview"></section><script>
let service, dirty=false;
const endpoint='/api/community/service-documents';
async function open(id){service=(await (await fetch(endpoint+'/'+id,{headers:{Accept:'application/json'}})).json()).serviceDocument;service.project ||= JSON.parse(service.documentSource).project;document.getElementById('text').value=service.project.items.point.textByChannel.english;document.getElementById('preview').textContent=service.project.title;dirty=false;}
document.getElementById('text').oninput=()=>dirty=true;
async function save(){if(dirty){const project=structuredClone(service.project);for(const channel of project.channelIds)project.items.point.textByChannel[channel]=document.getElementById('text').value;project.revision++;project.updatedAt=new Date().toISOString();const doc={...service.document,project};function stable(v){if(Array.isArray(v))return v.map(stable);if(v&&typeof v==='object')return Object.fromEntries(Object.keys(v).sort().map(k=>[k,stable(v[k])]));return v};const source=JSON.stringify(stable(doc))+'\\n';const response=await fetch(endpoint+'/'+service.syncId,{method:'PUT',headers:{'Content-Type':'application/json',Accept:'application/json'},body:JSON.stringify({schemaVersion:1,requestId:crypto.randomUUID(),syncId:service.syncId,baseRevision:service.revision,baseSyncVersion:service.syncVersion,documentSource:source,status:'planning',saveKind:'manual'})});if(!response.ok)throw new Error('Save failed '+response.status);service=(await response.json()).serviceDocument;dirty=false;}document.getElementById('status').textContent=service.desktop?.pending?'Saved locally':'Saved';return service;}
document.getElementById('save').onclick=()=>save().catch(error=>document.getElementById('status').textContent=error.message);window.addEventListener('message',async event=>{if(event.source!==window||event.origin!==location.origin)return;const value=event.data;if(value.type==='heritage-editor:open')await open(value.syncId);if(value.type==='heritage-editor:flush'){try{if(window.fixtureFlushMode==='ignore')return;if(window.fixtureFlushMode==='fail')throw new Error('Fixture save failed');const serviceDocument=await save();window.postMessage({type:'heritage-editor:flushed',requestId:value.requestId,ok:true,serviceDocument},location.origin)}catch(error){window.postMessage({type:'heritage-editor:flushed',requestId:value.requestId,ok:false,error:error.message},location.origin)}}});open('service-fixture');
</script></body></html>`;
const server = http.createServer(async (request, response) => {
  const url = new URL(request.url, `http://127.0.0.1:${server.address().port}`);
  serverRequests.push({method:request.method,path:url.pathname});
  if (offline) return json(response, { error: 'offline' }, 503);
  if (editingFixture && url.pathname.startsWith('/assets/')) { const file=path.join(editingFixture,url.pathname);response.writeHead(200,{'Content-Type':file.endsWith('.css')?'text/css':'application/javascript'});response.end(await fs.readFile(file));return; }
  if (editingFixture && url.pathname === '/admin/plan-service') { response.writeHead(200,{'Content-Type':'text/html'});response.end(await fs.readFile(path.join(editingFixture,'community-server/tests/browser/native-adjust.html')));return; }
  if (url.pathname === '/admin/plan-service') { response.writeHead(200, { 'Content-Type': 'text/html' }); response.end(plannerHtml); return; }
  if (url.pathname === '/.well-known/heritage-community.json') return json(response, {
    schemaVersion: 1, server: { id: 'fixture-community', name: 'Fixture Community' }, integrations: { syncShow: {
      schemaVersion: 2, apiBaseUrl: `http://127.0.0.1:${server.address().port}/api/community/syncshow/v1`, deviceAuthorization: true,
      resources: { serviceDocuments: { schemaVersion: 1, endpoint: 'service-documents', changesEndpoint: 'service-documents/changes', scopes } }
    } }
  });
  if (url.pathname.endsWith('/service-documents')) return json(response, { nextCursor: null, hasMore: false, items: [{ syncId: saved.syncId, title: saved.project.title, serviceDate: saved.project.serviceDate, status: saved.status, revision: saved.revision, syncVersion: saved.syncVersion, changedAt: saved.changedAt }] });
  if (url.pathname.endsWith('/service-documents/service-fixture')) {
    if (holdChecks && request.method === 'GET') { heldChecks.push(response); return; }
    if (request.method === 'PUT') {
      if(holdWrites) await new Promise(resolve=>heldWrites.push(resolve));
      const raw = await body(request);
      if (raw.baseRevision !== saved.revision) return json(response, { error: 'conflict' }, 412);
      const validated = core.validateHeritageServiceDocumentSource(raw.documentSource);
      saved = { ...validated, syncId: raw.syncId, syncVersion: saved.syncVersion + 1, status: raw.status, changedAt: new Date().toISOString() };
    }
    return json(response, serviceWire());
  }
  return json(response, { error: 'not found' }, 404);
});

require('../../main');
async function run() {
  await app.whenReady();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}/`;
  const project = { schemaVersion: 1, kind: 'syncshow-service-project', id: 'service-fixture', title: 'Offline rehearsal', serviceDate: '2026-10-04',
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), revision: 1, preferredProfileId: 'main-sanctuary',
    channelIds: ['english', 'russian', 'media'], channels: { english: { id: 'english', label: 'English', language: 'en' }, russian: { id: 'russian', label: 'Russian', language: 'ru' }, media: { id: 'media', label: 'Media', language: 'und' } },
    rootItemIds: ['point'], items: { point: { id: 'point', kind: 'notice', title: 'Point', textByChannel: { english: 'Original slide', russian: 'Original slide', media: 'Original slide' }, presetId: 'notice-text', operatorNotes: '' } }, resources: {}, assets: {}, presetPack: { id: 'main-sanctuary', version: 1, sha256: null } };
  if (process.env.SYNCSHOW_GRID_REHEARSAL === '1') {
    project.rootItemIds = [];
    for (const [index, title] of ['Opening', 'Worship', 'Sermon', 'Closing'].entries()) {
      const id = `section-${index}`, childIds = [];
      for (let slide = 0; slide < (editingFixture ? 24 : 7); slide++) {
        const itemId = index === 0 && slide === 0 ? 'point' : `${id}-${slide}`;
        childIds.push(itemId);
        if (itemId !== 'point') project.items[itemId] = {id:itemId,kind:'notice',title:`${title} ${slide + 1}`,textByChannel:{english:`${title}\nSlide ${slide + 1}`,russian:`${title}\nСлайд ${slide + 1}`,media:`${title}\nСлайд ${slide + 1}`},presetId:'notice-text',operatorNotes:''};
      }
      project.items[id] = {id,kind:'group',groupKind:'section',title,childIds,operatorNotes:''};
      project.rootItemIds.push(id);
    }
  }
  const validated = core.validateHeritageServiceDocumentSource(core.serializeHeritageServiceDocument(core.createHeritageServiceDocument(project)));
  saved = { ...validated, syncId: project.id, syncVersion: 1, status: 'planning', changedAt: new Date().toISOString() };
  const storageRoot = path.join(root, 'community');
  const store = new CommunityConnectionStore({ storageRoot, safeStorage: new AppLocalCredentialStorage({ storageRoot: path.join(storageRoot, 'credentials') }) });
  await store.saveConnection({ id: 'fixture-connection', serverId: 'fixture-community', serverName: 'Fixture Community', baseUrl,
    apiBaseUrl: `${baseUrl}api/community/syncshow/v1`, account: { id: 'fixture-admin', email: 'fixture@example.test', name: 'Fixture' }, scopes,
    accessToken: 'fixture-token-12345678901234567890', refreshToken: null, expiresAt: '2027-01-01T00:00:00.000Z' });
  const control = await waitFor(() => BrowserWindow.getAllWindows().find(win => win.webContents.getURL().endsWith('/src/renderer/index.html') && !win.webContents.isLoading()), 'control');
  if (loadQueueFixture) control.webContents.setBackgroundThrottling(false);
  control.webContents.on('console-message', event => { if (event.level >= 2) console.error('[renderer]', event.message); });
  const renderer = source => control.webContents.executeJavaScript(source);
  const settledScreenshot = async name => {
    await renderer('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
    await fs.writeFile(path.join(root, name), (await control.capturePage()).toPNG());
  };
  await renderer(`window.fixtureStages=[];const original=setWorkflowStage;setWorkflowStage=function(...args){window.fixtureStages.push({stage:args[0],stack:new Error().stack});return original(...args)};true`);
  await renderer(`refreshCommunityStatus();`);
  await renderer(`document.getElementById('btnStagePrepare').click();`);
  let planner = await waitFor(() => electron.webContents.getAllWebContents().find(contents => contents.getURL() === `${baseUrl}admin/plan-service` && !contents.isLoading()), 'same planner');
  if(editingFixture) await renderer("window.api.openPlannerService('service-fixture')");
  await waitFor(() => planner.executeJavaScript(editingFixture ? 'Boolean(document.querySelector(".heritage-service-planner__rows"))' : 'Boolean(service?.project)'), 'service open');
  const tabs = await renderer(`getComputedStyle(document.querySelector('.prepare-mode-tabs')).display`);
  assert.equal(tabs, 'none');
  if (process.env.SYNCSHOW_LOAD_NAVIGATION_FIXTURE === '1') {
    await planner.executeJavaScript("window.fixtureFlushMode='ignore';true");
    const started = Date.now();
    await renderer("void navigateWorkflowStage('load');true");
    assert.equal(await renderer('state.workflowStage'), 'load');
    assert.equal(await renderer('elements.btnStageLoad.disabled'), false);
    await waitFor(() => renderer("elements.loadPrepareWarning.textContent.includes('not confirmed saving')"), 'bounded save warning');
    assert(Date.now() - started < 6000, 'Legacy editor must not hold Load for thirty seconds');
    const screenshot = path.join(root, 'load-save-warning.png');
    await fs.writeFile(screenshot, (await control.webContents.capturePage()).toPNG());
    await renderer("navigateWorkflowStage('prepare')");
    await planner.executeJavaScript("window.fixtureFlushMode='fail';true");
    await renderer("navigateWorkflowStage('load')");
    assert.equal(await renderer('state.workflowStage'), 'load');
    assert.match(await renderer('elements.loadPrepareWarning.textContent'), /Fixture save failed/);
    await renderer("navigateWorkflowStage('prepare')");
    await planner.executeJavaScript("window.fixtureFlushMode='ignore';true");
    await renderer("void navigateWorkflowStage('load');true");
    await renderer("navigateWorkflowStage('prepare')");
    await delay(3500);
    assert.equal(await renderer('state.workflowStage'), 'prepare');
    await planner.executeJavaScript("window.fixtureFlushMode='normal';true");
    await renderer("navigateWorkflowStage('load')");
    assert.equal(await renderer('elements.loadPrepareWarning.hidden'), true);
    assert.equal(await renderer('state.serviceHandoff.project.id'), project.id);
    await fs.writeFile(resultPath, JSON.stringify({ok:true,immediateLoad:true,legacySaveWarning:true,failedSaveWarning:true,returnToPrepare:true,confirmedServiceLoaded:true,screenshot},null,2));
    return;
  }
  const handoff = await renderer(`window.api.prepareCommunityPlannerForLoad()`);
  assert.equal(handoff.data.serviceId, project.id);
  const opened = await renderer(`window.api.openCommunityServiceDocument({syncId:'service-fixture'})`);
  assert.equal(opened.success, true, JSON.stringify(opened));
  const published = await renderer(`window.api.publishServiceProject({projectId:'service-fixture',revisionId:${JSON.stringify(opened.data.revisionId)}})`);
  assert.equal(published.success, true);
  await renderer(`refreshPublishedProject({},{});`);
  if (loadQueueFixture) {
    await renderer("state.presentationMode='single';setWorkflowStage('load');true");
    await waitFor(() => renderer('!state.initializingLoad && !state.loadFreshness.busy'), 'initial check');
    holdChecks = true;
    await renderer('state.loadFreshness.checkedAt=0;void refreshLoadedService();true');
    await waitFor(() => heldChecks.length, 'held version check');
    assert.equal(await renderer('elements.btnStartPresentation.disabled'), false);
    await renderer('elements.btnStartPresentation.click();true');
    assert.equal(await renderer('Boolean(state.queuedStart)'), true);
    assert.equal(await renderer('elements.btnStartPresentation.getAttribute("aria-busy")'), 'true');
    assert.match(await renderer('elements.loadActionMessage.textContent'), /continue automatically/);
    await settledScreenshot('queued-start.png');
    await renderer('elements.btnCancelLoadAction.click();true');
    holdChecks = false;
    for (const response of heldChecks.splice(0)) json(response, serviceWire());
    await waitFor(() => renderer('!state.loadFreshness.busy'), 'cancelled check finished');
    assert.equal(Boolean((await renderer('window.api.getAppState()')).activeLaunchPlan), false);
    assert.equal(await renderer('state.startAttempt'), null);
    assert.match(await renderer('elements.loadActionMessage.textContent'), /cancelled/);

    // A stalled network must fall back in four seconds, then continue directly
    // into the existing language/output chooser without a second Start click.
    holdChecks = true;
    await renderer('state.loadFreshness.checkedAt=0;elements.btnStartPresentation.click();true');
    const offlineStarted = Date.now();
    await waitFor(() => renderer('!state.queuedStart'), 'bounded offline queued start');
    assert(Date.now() - offlineStarted < 6000);
    assert.match(await renderer('offlineLaunchNotice()'), /saved local copy.*could not be checked/);
    assert.equal(await renderer('elements.startPreflightDialog.open'), true);
    assert.match(await renderer('elements.preflightLoadNotice.textContent'), /saved local copy/);
    await settledScreenshot('offline-local-copy.png');
    await renderer('cancelStartAttempt();true');
    holdChecks = false;
    for (const response of heldChecks.splice(0)) response.destroy();
  }
  const state = await renderer(`window.api.getAppState()`);
  const presentations = state.presentations;
  const roles = Object.keys(presentations);
  const launch = roles.map((id, index) => ({ id: `fixture-${id}`, name: id, kind: id === 'singer' ? 'singer' : 'normal', expectedRole: id, displayId: index + 2 }));
  const started = await renderer(`window.api.startPresentation({outputs:${JSON.stringify(launch)},settings:{}})`);
  assert.equal(started.success, true);
  await renderer(`state.activeLaunchPlan=${JSON.stringify(started.plan)};renderOutputPreviews(state.activeLaunchPlan);window.api.requestOutputPreviews();true`);
  await renderer(`(async()=>{handleShowStateChanged((await window.api.getAppState()).showState);setWorkflowStage('show');await loadAppState();})()`);
  const before = await renderer(`window.api.getAppState()`);
  assert.equal(await renderer(`state.workflowStage`), 'show');

  if (editingFixture) {
    planner.close();
    offline=true;
    const requestCount=serverRequests.length;
    await renderer('goToSlide(70)');
    const liveState=await renderer('window.api.getAppState()');
    const cueId=liveState.serviceHandoff.cueIds[70];
    const assertShowSlideVisible=async label=>{
      const box=await renderer(`(()=>{const grid=elements.thumbnailsGrid,row=grid.querySelector('.thumbnail-item.active'),r=row.getBoundingClientRect(),g=grid.getBoundingClientRect();return {top:r.top,bottom:r.bottom,gridTop:g.top,gridBottom:g.bottom,scrollTop:grid.scrollTop,index:row.dataset.index};})()`);
      assert(box.top>=box.gridTop && box.bottom<=box.gridBottom,`${label}: ${JSON.stringify(box)}`);
    };
    const assertAdjustSlideVisible=async id=>{
      const box=await planner.executeJavaScript(`(()=>{const row=document.querySelector('[data-slide-id="${id}"]'),r=row.getBoundingClientRect(),sidebar=row.closest('aside').getBoundingClientRect();return {top:r.top,bottom:r.bottom,sidebarTop:sidebar.top,sidebarBottom:sidebar.bottom,viewport:innerHeight,selected:row.dataset.active};})()`);
      assert.equal(box.selected,'true');
      assert(box.top>=Math.max(0,box.sidebarTop) && box.bottom<=Math.min(box.viewport,box.sidebarBottom),`Adjust slide visibility: ${JSON.stringify(box)}`);
    };
    await renderer('toggleShowAdjust()');
    planner=await waitFor(()=>electron.webContents.getAllWebContents().find(contents=>contents.getURL().includes('/syncshow-local/adjust/index.html')&&!contents.isLoading()),'bundled local Adjust');
    await waitFor(()=>planner.executeJavaScript(`document.querySelector('[data-slide-id="${cueId}"]')?.dataset.active === 'true'`),'Adjust selects live cue');
    assert.equal(serverRequests.length,requestCount,`Opening Adjust must not ask Heritage: ${JSON.stringify(serverRequests.slice(requestCount))}`);
    assert.equal(await planner.executeJavaScript("!!document.querySelector('.heritage-service-planner__service-picker')"),false,'No service selector in Adjust');
    assert.equal(await planner.executeJavaScript("document.querySelectorAll('.heritage-service-planner__row[data-selected=true]').length"),1,'Adjust selects only the current slide');
    const focus=await planner.executeJavaScript(`(()=>{const row=document.querySelector('[data-slide-id="${cueId}"]'),r=row.getBoundingClientRect(),sidebar=row.closest('aside').getBoundingClientRect();return {top:r.top,bottom:r.bottom,sidebarTop:sidebar.top,sidebarBottom:sidebar.bottom,viewport:innerHeight,edit:!!document.querySelector('.heritage-service-planner__stage [contenteditable]')};})()`);
    assert(focus.top>=Math.max(0,focus.sidebarTop)&&focus.bottom<=Math.min(focus.viewport,focus.sidebarBottom),JSON.stringify(focus));assert.equal(focus.edit,true);
    const outputs=BrowserWindow.getAllWindows().filter(win=>win.webContents.getURL().includes('display.html'));
    let english;
    for(const win of outputs) if(await win.webContents.executeJavaScript('displayState.language')==='fixture-english') english=win;
    assert(english);
    await renderer("elements.outputPreviewSelect.value='fixture-english';selectOutputPreview();state.thumbnailSelection='english';renderThumbnails();true");
    const originalPreview=await waitFor(()=>renderer("outputPreviewElements.get('fixture-english')?.image.getAttribute('src')"),'actual operator preview before edit');
    const originalThumbnail=await renderer(`document.querySelector('.thumbnail-item[data-index="70"] img').src`);
    const originalShowRevision=liveState.serviceHandoff.project.revisionId;
    offline=false;
    holdWrites=true;
    const saveStart=performance.now();
    await planner.executeJavaScript(`{const field=document.querySelector('.heritage-service-planner__stage [data-role="caption"][contenteditable]');field.focus();field.textContent+=' test';field.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertText'}));field.blur();document.querySelector('button[aria-label="Save service"]').click();}true`);
    await waitFor(()=>planner.executeJavaScript("document.body.innerText.includes('Saved on this computer')"),'durable local save without waiting for server');
    const localSaveMs=performance.now()-saveStart;
    assert(localSaveMs<1500,`local save took ${localSaveMs}ms`);
    const adjustJournals=path.join(root,'community','planner-adjust','fixture-connection');
    const journal=JSON.parse(await fs.readFile(path.join(adjustJournals,(await fs.readdir(adjustJournals))[0],'journal.json'),'utf8'));
    assert(journal.documents['service-fixture'].project.items['section-2-22'].textByChannel.english.endsWith(' test'),'Saved text must be durable before taking it');
    assert.equal(await english.webContents.executeJavaScript("document.body.textContent.includes(' test')"),false,'Audience unchanged while editing');
    await waitFor(()=>renderer(`document.querySelector('.thumbnail-item[data-cue-id="${cueId}"] .thumb-text')?.textContent.includes(' test')`),'saved text appears in Show grid before any live take');
    assert.notEqual(await renderer(`document.querySelector('.thumbnail-item[data-cue-id="${cueId}"] img').src`),originalThumbnail,'Saved text must update the actual grid image');
    assert.equal((await renderer('window.api.getAppState()')).serviceHandoff.project.revisionId,originalShowRevision,'Draft preview cannot activate the saved package');
    assert.equal(await renderer("outputPreviewElements.get('fixture-english')?.image.getAttribute('src')"),originalPreview,'LIVE OUTPUT still mirrors the unchanged audience');
    assert.equal(await english.webContents.executeJavaScript("document.body.textContent.includes(' test')"),false,'Background preview refresh cannot project edits');
    await renderer(`document.querySelector('.thumbnail-item[data-cue-id="${cueId}"]').click();true`);
    assert.equal(await english.webContents.executeJavaScript("document.body.textContent.includes(' test')"),false,'Selecting a draft thumbnail while Adjust is open must not take it live');
    await renderer('elements.thumbnailsGrid.scrollTo({top:0,behavior:"instant"});true');
    const closeStart=performance.now();await renderer('closeShowAdjust()');const closeMs=performance.now()-closeStart;assert(closeMs<1500,`close waited ${closeMs}ms`);
    await assertShowSlideVisible('Closing Adjust returns to the live slide after preview rebuild');
    const takeStart=performance.now();
    await renderer(`document.querySelector('.thumbnail-item[data-cue-id="${cueId}"]').click();true`);
    await waitFor(()=>english.webContents.executeJavaScript("document.body.textContent.includes(' test')"),'edited text on actual native output');
    const takeMs=performance.now()-takeStart;assert(takeMs<2000,`text edit take took ${takeMs}ms`);
    const previewStart=performance.now();
    await waitFor(async()=>{const source=await renderer("outputPreviewElements.get('fixture-english')?.image.getAttribute('src')");return source && source!==originalPreview;},'operator preview refresh after edited take');
    const previewAfterTakeMs=performance.now()-previewStart;
    assert(previewAfterTakeMs<500,`operator preview lagged ${previewAfterTakeMs}ms`);
    for(const output of outputs)assert.equal(await output.webContents.executeJavaScript('displayState.currentSlide'),70);
    holdWrites=false;heldWrites.splice(0).forEach(resolve=>resolve());
    await waitFor(()=>saved.project.items['section-2-22'].textByChannel.english.endsWith(' test'),'background upload eventually syncs');
    await waitFor(()=>renderer('state.activeLaunchPlan?.outputs.length===3 && !state.cueNavigationBusy'),'active route remains available after a saved take');
    await renderer('toggleShowAdjust()');await waitFor(()=>planner.executeJavaScript(`document.querySelector('[data-slide-id="${cueId}"]')?.dataset.active === 'true'`),'Reopening Adjust follows the displayed cue');
    assert.equal(await planner.executeJavaScript("document.querySelector('.heritage-service-planner__stage [data-role=caption][contenteditable]').textContent.endsWith(' test')"),true);
    await planner.executeJavaScript(`{const field=document.querySelector('.heritage-service-planner__stage [data-role="caption"][contenteditable]');field.textContent+=' warm';field.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertText'}));document.querySelector('button[aria-label="Save service"]').click();}true`);
    await waitFor(async()=> (await renderer('window.api.getCommunityPlannerState()')).data?.showDraftReady,'background package ready while Adjust remains open');
    await waitFor(()=>renderer(`document.querySelector('.thumbnail-item[data-cue-id="${cueId}"] .thumb-text')?.textContent.includes(' warm')`),'further saved edits update previews without switching slides');
    assert.equal(await english.webContents.executeJavaScript("document.body.textContent.includes(' warm')"),false,'A ready backstage package must not change the audience');
    await renderer('closeShowAdjust()');
    const readyTakeStart=performance.now();await renderer('goToSlide(70)');
    await waitFor(()=>english.webContents.executeJavaScript("document.body.textContent.includes(' warm')"),'prepared edit on actual output');
    const readyTakeMs=performance.now()-readyTakeStart;assert(readyTakeMs<500,`ready edit take took ${readyTakeMs}ms`);
    await renderer('toggleShowAdjust()');
    const previousCueId=liveState.serviceHandoff.cueIds[69];
    await planner.executeJavaScript(`document.querySelector('[data-slide-id="${previousCueId}"]').click();document.querySelector('.heritage-add-slide').click();true`);
    await waitFor(()=>planner.executeJavaScript("!document.querySelector('.heritage-add-workspace').hidden"),'add slide palette');
    await planner.executeJavaScript("document.querySelector('.heritage-add-utilities button').click();true");
    await planner.executeJavaScript("document.querySelector('button[aria-label=\"Save service\"]').click();true");
    await waitFor(()=>renderer(`backstagePreview?.cueIds.length===97 && document.querySelector('.thumbnail-item.active')?.dataset.cueId==='${cueId}'`),'draft preview follows the stable live cue after insertion');
    assert.equal(await renderer(`document.querySelector('.thumbnail-item.active').dataset.index`),'71','The draft position changes while the live cue identity stays highlighted');
    assert.equal((await renderer('window.api.getAppState()')).currentSlide,70,'Browsing the inserted draft cannot move the audience');
    await renderer('closeShowAdjust()');
    await renderer(`document.querySelector('.thumbnail-item[data-cue-id="${cueId}"]').click();true`);
    await waitFor(()=>renderer(`!state.cueNavigationBusy && state.showState?.currentCue?.id==='${cueId}' && state.showState.currentCue.index===71 && state.totalSlides===97`),'draft thumbnail takes by stable cue identity after insertion');
    for(const output of outputs)assert.equal(await output.webContents.executeJavaScript('displayState.currentSlide'),71);
    assert.equal(await english.webContents.executeJavaScript("document.body.textContent.includes(' warm')"),true,'Taking the shifted draft tile must retain the intended content');
    // Reuse the native editor after browsing elsewhere and resizing while it is
    // hidden. Selection alone is insufficient: the slide must be in view in
    // both panes, without any audience take during the transitions.
    for(const index of [19,87,19]) {
      control.setSize(index===87?1400:1200,index===87?900:700);
      await renderer(`goToSlide(${index})`);
      const id=(await renderer('window.api.getAppState()')).serviceHandoff.cueIds[index];
      await renderer('toggleShowAdjust()');
      await assertAdjustSlideVisible(id);
      await planner.executeJavaScript("document.querySelector('.heritage-service-planner aside').scrollTop=0;true");
      await renderer('elements.thumbnailsGrid.scrollTo({top:0,behavior:"instant"});renderThumbnails();true');
      await renderer('closeShowAdjust()');
      await assertShowSlideVisible(`Returning from Adjust at slide ${index+1}`);
      assert.equal((await renderer('window.api.getAppState()')).currentSlide,index,'Scrolling/focusing must not take another slide');
    }
    assert.equal(serverRequests.slice(requestCount).some(request=>request.method==='GET' && request.path.startsWith('/api/community/service-documents') && !request.path.includes('/library/')),false,'Edits and live takes must not fetch service documents from Heritage; explicitly opened libraries may load resources');
    await fs.writeFile(resultPath,JSON.stringify({ok:true,actualSharedEditor:true,bundledColdOfflineAdjust:true,noServiceSelector:true,noServerReadsDuringAdjust:true,slideCount:96,focusedSlide:71,localSaveMs,closeMs,takeMs,readyTakeMs,previewAfterTakeMs,savedThumbnailUpdatesWithoutTake:true,livePreviewStableUntilTake:true,draftPreviewDoesNotActivatePackage:true,insertedSlidePreservesLiveCueIdentity:true,adjustScrollTransitions:[20,88,20],audienceStableWhileEditing:true,threeOutputsAcknowledged:true,backgroundSyncCompleted:true},null,2));return;
  }
  if (loadQueueFixture) {
    const clickSlide = async index => {
      const box = await renderer(`(()=>{const button=document.querySelector('.thumbnail-item[data-index="${index}"]');button.scrollIntoView({block:'center'});const r=button.getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2),disabled:button.disabled};})()`);
      assert.equal(box.disabled, false, 'The selected thumbnail must accept a mouse click');
      control.webContents.sendInputEvent({type:'mouseDown',button:'left',x:box.x,y:box.y,clickCount:1});
      control.webContents.sendInputEvent({type:'mouseUp',button:'left',x:box.x,y:box.y,clickCount:1});
      await waitFor(async () => (await renderer('window.api.getAppState()')).currentSlide === index, `mouse take ${index}`);
      assert.equal(await renderer('state.currentSlide'), index);
      assert.equal(await renderer('document.querySelector(".thumbnail-item.active").dataset.index'), String(index));
      const outputs = BrowserWindow.getAllWindows().filter(win => win.webContents.getURL().includes('display.html'));
      assert.equal(outputs.length, 3);
      for (const output of outputs) assert.equal(await output.webContents.executeJavaScript(`document.body.textContent.includes('Slide ${index % 7 + 1}') || document.body.textContent.includes('Слайд ${index % 7 + 1}')`), true);
    };
    await clickSlide(9);
    await clickSlide(17);
    await renderer('elements.btnShowAdjust.click();true');
    await waitFor(() => renderer('showAdjustOpen && state.community.plannerOpen'), 'Adjust open');
    await renderer(`document.querySelector('.thumbnail-item[data-index="2"]').click();true`);
    assert.equal((await renderer('window.api.getAppState()')).currentSlide, 17, 'Editing mode must not take a slide live');
    await renderer('closeShowAdjust()');
    await clickSlide(2);
    await settledScreenshot('show-mouse-take.png');
    await fs.writeFile(resultPath, JSON.stringify({ok:true,queuedClick:true,cancelPreventsLaunch:true,offlineBoundedFallback:true,offlinePreflightNotice:true,mouseTakes:[9,17,2],allThreeOutputsConfirmed:true},null,2));
    return;
  }
  await delay(300);
  await fs.writeFile(path.join(root, 'show.png'), (await control.capturePage()).toPNG());
  planner.on('console-message', event => console.error('[planner]', event.message));
  await renderer(`document.getElementById('btnShowAdjust').click();`);
  await waitFor(() => renderer(`document.getElementById('showAdjustPanel').hidden === false`), 'Adjust');
  await delay(500);
  offline = true;
  await planner.executeJavaScript(`document.getElementById('text').value='Backstage offline edit';document.getElementById('text').dispatchEvent(new Event('input'));document.getElementById('save').click();`);
  await waitFor(async () => {const status=await planner.executeJavaScript(`document.getElementById('status').textContent`);if(status.startsWith('Save failed'))throw new Error(status);return status==='Saved locally';}, 'offline save');
  const unchanged = await renderer(`window.api.getAppState()`);
  assert.equal(unchanged.serviceHandoff.project.revisionId, before.serviceHandoff.project.revisionId);
  const display = BrowserWindow.getAllWindows().find(win => win.webContents.getURL().includes('display.html'));
  assert.equal(await display.webContents.executeJavaScript("document.body.textContent.includes('Original slide')"), true);
  assert.equal(await renderer(`Boolean(document.getElementById('btnApplyShowAdjust'))`), false, 'No extra Apply step');
  await renderer(`goToSlide(state.currentSlide)`);
  const after = await renderer(`window.api.getAppState()`);
  assert.notEqual(after.serviceHandoff.project.revisionId, before.serviceHandoff.project.revisionId);
  assert.equal(after.currentSlide, before.currentSlide);
  await waitFor(() => display.webContents.executeJavaScript(`document.body.textContent.includes('Backstage offline edit')`), 'actual display retaken');
  assert.equal(await renderer(`state.workflowStage`), 'show', JSON.stringify(await renderer('window.fixtureStages')));
  await delay(300);
  const screenshot = path.join(root, 'adjust.png');
  await fs.writeFile(screenshot, (await control.capturePage()).toPNG());
  await renderer(`closeShowAdjust()`);
  await delay(300);
  await fs.writeFile(path.join(root, 'show-retaken.png'), (await control.capturePage()).toPNG());
  assert.equal(await renderer(`showAdjustOpen`), false, 'Close must save backstage while a Show is active');
  // A fresh page load while disconnected uses the saved original editor assets.
  await planner.reload();
  await waitFor(() => !planner.isLoading() && planner.executeJavaScript(`Boolean(service?.project)`), 'offline editor reopen');
  assert.equal(await planner.executeJavaScript(`document.getElementById('text').value`), 'Backstage offline edit');
  offline = false;
  await delay(16000);
  assert.equal(saved.project.items.point.textByChannel.english, 'Backstage offline edit');
  await fs.writeFile(resultPath, JSON.stringify({ ok: true, sameEditorOffline: true, showStableWhileEditing: true,
    actualOutputAfterRetake: true, currentCuePreserved: true, reconnectSynced: true, screenshot }, null, 2));
}
run().then(() => { server.close(); app.exit(0); }).catch(async error => {
  const pages=[];for(const contents of electron.webContents.getAllWebContents()){try{if(contents.getURL().startsWith('http://127.0.0.1:'))pages.push({url:contents.getURL(),text:await contents.executeJavaScript('document.body.innerText.slice(0,4000)')});else if(contents.getURL().endsWith('/src/renderer/index.html'))pages.push({url:contents.getURL(),state:await contents.executeJavaScript(`({community:{showDraft:state.community.plannerShowDraft,ready:state.community.plannerShowDraftReady,key:state.community.plannerShowDraftPreviewKey},stage:state.workflowStage,project:state.serviceHandoff?.project,preview:backstagePreview && {key:backstagePreview.key,projectId:backstagePreview.projectId,count:backstagePreview.cueIds.length},previewKey:backstagePreviewKey,status:elements.statusMessage.textContent,livePhase:state.showState?.phase,rows:[...document.querySelectorAll('.thumbnail-item')].slice(69,72).map(item=>({index:item.dataset.index,cueId:item.dataset.cueId,text:item.querySelector('.thumb-text')?.textContent}))})`)});}catch{}}
  await fs.writeFile(resultPath, JSON.stringify({ ok: false, error: error.stack,pages }, null, 2)); server.close(); app.exit(1);
});
