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
let offline = false, saved;
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
async function body(request) { const chunks = []; for await (const chunk of request) chunks.push(chunk); return JSON.parse(Buffer.concat(chunks)); }
const plannerHtml = `<!doctype html><html><head><style>body{margin:0;background:#121a2d;color:white;font:16px system-ui;padding:30px}input,button{font:inherit;margin:8px;padding:10px}section{margin-top:25px}</style></head><body><h1>Prepare service · offline fixture</h1><input id="text" value="Original slide"><button id="save">Save</button><p id="status"></p><section id="preview"></section><script>
let service, dirty=false;
const endpoint='/api/community/service-documents';
async function open(id){service=(await (await fetch(endpoint+'/'+id,{headers:{Accept:'application/json'}})).json()).serviceDocument;document.getElementById('text').value=service.project.items.point.textByChannel.english;document.getElementById('preview').textContent=service.project.title;dirty=false;}
document.getElementById('text').oninput=()=>dirty=true;
async function save(){if(dirty){const project=structuredClone(service.project);for(const channel of project.channelIds)project.items.point.textByChannel[channel]=document.getElementById('text').value;project.revision++;project.updatedAt=new Date().toISOString();const doc={...service.document,project};function stable(v){if(Array.isArray(v))return v.map(stable);if(v&&typeof v==='object')return Object.fromEntries(Object.keys(v).sort().map(k=>[k,stable(v[k])]));return v};const source=JSON.stringify(stable(doc))+'\\n';const response=await fetch(endpoint+'/'+service.syncId,{method:'PUT',headers:{'Content-Type':'application/json',Accept:'application/json'},body:JSON.stringify({schemaVersion:1,requestId:crypto.randomUUID(),syncId:service.syncId,baseRevision:service.revision,baseSyncVersion:service.syncVersion,documentSource:source,status:'planning',saveKind:'manual'})});if(!response.ok)throw new Error('Save failed '+response.status);service=(await response.json()).serviceDocument;dirty=false;}document.getElementById('status').textContent=service.desktop?.pending?'Saved locally':'Saved';return service;}
document.getElementById('save').onclick=()=>save().catch(error=>document.getElementById('status').textContent=error.message);window.addEventListener('message',async event=>{if(event.source!==window||event.origin!==location.origin)return;const value=event.data;if(value.type==='heritage-editor:open')await open(value.syncId);if(value.type==='heritage-editor:flush'){try{const serviceDocument=await save();window.postMessage({type:'heritage-editor:flushed',requestId:value.requestId,ok:true,serviceDocument},location.origin)}catch(error){window.postMessage({type:'heritage-editor:flushed',requestId:value.requestId,ok:false,error:error.message},location.origin)}}});open('service-fixture');
</script></body></html>`;
const server = http.createServer(async (request, response) => {
  const url = new URL(request.url, `http://127.0.0.1:${server.address().port}`);
  if (offline) return json(response, { error: 'offline' }, 503);
  if (url.pathname === '/admin/plan-service') { response.writeHead(200, { 'Content-Type': 'text/html' }); response.end(plannerHtml); return; }
  if (url.pathname === '/.well-known/heritage-community.json') return json(response, {
    schemaVersion: 1, server: { id: 'fixture-community', name: 'Fixture Community' }, integrations: { syncShow: {
      schemaVersion: 2, apiBaseUrl: `http://127.0.0.1:${server.address().port}/api/community/syncshow/v1`, deviceAuthorization: true,
      resources: { serviceDocuments: { schemaVersion: 1, endpoint: 'service-documents', changesEndpoint: 'service-documents/changes', scopes } }
    } }
  });
  if (url.pathname.endsWith('/service-documents')) return json(response, { nextCursor: null, hasMore: false, items: [{ syncId: saved.syncId, title: saved.project.title, serviceDate: saved.project.serviceDate, status: saved.status, revision: saved.revision, syncVersion: saved.syncVersion, changedAt: saved.changedAt }] });
  if (url.pathname.endsWith('/service-documents/service-fixture')) {
    if (request.method === 'PUT') {
      const raw = await body(request);
      if (raw.baseRevision !== saved.revision) return json(response, { error: 'conflict' }, 412);
      const validated = core.validateHeritageServiceDocumentSource(raw.documentSource);
      saved = { ...validated, syncId: raw.syncId, syncVersion: saved.syncVersion + 1, status: raw.status, changedAt: new Date().toISOString() };
    }
    return json(response, { schemaVersion: 1, serviceDocument: saved });
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
      for (let slide = 0; slide < 7; slide++) {
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
  control.webContents.on('console-message', (_event, level, message) => { if (level >= 2) console.error('[renderer]', message); });
  const renderer = source => control.webContents.executeJavaScript(source);
  await renderer(`window.fixtureStages=[];const original=setWorkflowStage;setWorkflowStage=function(...args){window.fixtureStages.push({stage:args[0],stack:new Error().stack});return original(...args)};true`);
  await renderer(`refreshCommunityStatus();`);
  await renderer(`document.getElementById('btnStagePrepare').click();`);
  const planner = await waitFor(() => electron.webContents.getAllWebContents().find(contents => contents.getURL() === `${baseUrl}admin/plan-service` && !contents.isLoading()), 'same planner');
  await waitFor(() => planner.executeJavaScript('Boolean(service?.project)'), 'service open');
  const tabs = await renderer(`getComputedStyle(document.querySelector('.prepare-mode-tabs')).display`);
  assert.equal(tabs, 'none');
  const handoff = await renderer(`window.api.prepareCommunityPlannerForLoad()`);
  assert.equal(handoff.data.serviceId, project.id);
  const opened = await renderer(`window.api.openCommunityServiceDocument({syncId:'service-fixture'})`);
  assert.equal(opened.success, true, JSON.stringify(opened));
  const published = await renderer(`window.api.publishServiceProject({projectId:'service-fixture',revisionId:${JSON.stringify(opened.data.revisionId)}})`);
  assert.equal(published.success, true);
  await renderer(`refreshPublishedProject({},{});`);
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
  await fs.writeFile(resultPath, JSON.stringify({ ok: false, error: error.stack }, null, 2)); server.close(); app.exit(1);
});
