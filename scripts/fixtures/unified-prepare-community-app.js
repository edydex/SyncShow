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
let device;
const fixtureServiceId = `desktop-${Date.now()}`;
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
const server = http.createServer(async (request, response) => {
  const url = new URL(request.url, `http://127.0.0.1:${server.address().port}`);
  if (offline) return json(response, { error: 'offline' }, 503);
  if (url.pathname === '/.well-known/heritage-community.json') return json(response, {
    schemaVersion: 1, server: { id: 'fixture-community', name: 'Fixture Community' }, integrations: { syncShow: {
      schemaVersion: 2, apiBaseUrl: `http://127.0.0.1:${server.address().port}/api/community/syncshow/v1`, deviceAuthorization: true,
      resources: { serviceDocuments: { schemaVersion: 1, endpoint: 'service-documents', changesEndpoint: 'service-documents/changes', scopes } }
    } }
  });
  const chunks = []; for await (const chunk of request) chunks.push(chunk);
  const upstream = await fetch(`${device.baseUrl}${url.pathname}${url.search}`, { method: request.method,
    headers: request.headers, ...(chunks.length ? { body: Buffer.concat(chunks) } : {}) });
  const headers = Object.fromEntries([...upstream.headers].filter(([key]) => !['content-encoding','content-length','transfer-encoding'].includes(key)));
  response.writeHead(upstream.status, headers); response.end(Buffer.from(await upstream.arrayBuffer())); return;

});

require('../../main');
async function run() {
  await app.whenReady();
  device = JSON.parse(await fs.readFile(process.env.SYNCSHOW_REAL_COMMUNITY_FIXTURE, 'utf8'));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}/`;
  const project = { schemaVersion: 1, kind: 'syncshow-service-project', id: fixtureServiceId, title: 'Desktop offline rehearsal', serviceDate: '2026-10-04',
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), revision: 1, preferredProfileId: 'main-sanctuary',
    channelIds: ['english', 'russian', 'media'], channels: { english: { id: 'english', label: 'English', language: 'en' }, russian: { id: 'russian', label: 'Russian', language: 'ru' }, media: { id: 'media', label: 'Media', language: 'und' } },
    rootItemIds: ['point', 'following'], items: { following: {id:'following',kind:'notice',title:'Following',textByChannel:{english:'Following slide',russian:'Следующий слайд',media:'Следующий слайд'},presetId:'notice-text',operatorNotes:''}, point: { id: 'point', kind: 'notice', title: 'Point', textByChannel: { english: 'Original slide', russian: 'Original slide', media: 'Original slide' }, presetId: 'notice-text', operatorNotes: '' } }, resources: {}, assets: {}, presetPack: { id: 'main-sanctuary', version: 1, sha256: null } };
  const validated = core.validateHeritageServiceDocumentSource(core.serializeHeritageServiceDocument(core.createHeritageServiceDocument(project)));
  saved = { ...validated, syncId: project.id, syncVersion: 1, status: 'planning', changedAt: new Date().toISOString() };
  const api = `${device.baseUrl}/api/community/service-documents`;
  const authHeaders = { Authorization: `SyncShow ${device.token}`, 'Content-Type': 'application/json', Accept: 'application/json' };
  const createdResponse = await fetch(api, {method:'POST',headers:authHeaders,body:JSON.stringify({schemaVersion:1,requestId:require('node:crypto').randomUUID(),syncId:project.id,title:project.title,serviceDate:project.serviceDate})});
  assert.equal(createdResponse.status, 201);
  const created = (await createdResponse.json()).serviceDocument;
  const seedResponse = await fetch(`${api}/${project.id}`, {method:'PUT',headers:authHeaders,body:JSON.stringify({schemaVersion:1,requestId:require('node:crypto').randomUUID(),syncId:project.id,baseRevision:created.revision,baseSyncVersion:created.syncVersion,documentSource:saved.documentSource,status:'planning',saveKind:'manual'})});
  assert.equal(seedResponse.status,200);
  saved = (await seedResponse.json()).serviceDocument;
  const storageRoot = path.join(root, 'community');
  const store = new CommunityConnectionStore({ storageRoot, safeStorage: new AppLocalCredentialStorage({ storageRoot: path.join(storageRoot, 'credentials') }) });
  await store.saveConnection({ id: 'fixture-connection', serverId: 'fixture-community', serverName: 'Fixture Community', baseUrl,
    apiBaseUrl: `${baseUrl}api/community/syncshow/v1`, account: { id: 'fixture-admin', email: 'fixture@example.test', name: 'Fixture' }, scopes,
    accessToken: device.token, refreshToken: null, expiresAt: device.expiresAt });
  const control = await waitFor(() => BrowserWindow.getAllWindows().find(win => win.webContents.getURL().endsWith('/src/renderer/index.html') && !win.webContents.isLoading()), 'control');
  control.webContents.on('console-message', (_event, level, message) => { if (level >= 2) console.error('[renderer]', message); });
  const renderer = source => control.webContents.executeJavaScript(source);
  await renderer(`window.fixtureStages=[];const original=setWorkflowStage;setWorkflowStage=function(...args){window.fixtureStages.push({stage:args[0],stack:new Error().stack});return original(...args)};true`);
  await renderer(`refreshCommunityStatus();`);
  await renderer(`document.getElementById('btnStagePrepare').click();`);
  const planner = await waitFor(() => electron.webContents.getAllWebContents().find(contents => contents.getURL() === `${baseUrl}admin/plan-service` && !contents.isLoading()), 'same planner');
  const open = await renderer(`window.api.openPlannerService(${JSON.stringify(project.id)})`);
  assert.equal(open.success,true,JSON.stringify(open));
  await waitFor(() => planner.executeJavaScript(`Boolean(document.querySelector('.heritage-workspace-toolbar__views button:nth-child(2):not([disabled])'))`), 'actual document open');
  await planner.executeJavaScript(`document.querySelector('.heritage-workspace-toolbar__views button:nth-child(2)').click();true`);
  await waitFor(() => planner.executeJavaScript(`Boolean(document.querySelector('.heritage-service-planner__stage [data-role="caption"][contenteditable]'))`), 'actual notice edit');
  const tabs = await renderer(`getComputedStyle(document.querySelector('.prepare-mode-tabs')).display`);
  assert.equal(tabs, 'none');
  const handoff = await renderer(`window.api.prepareCommunityPlannerForLoad()`);
  assert.equal(handoff.data.serviceId, project.id);
  const opened = await renderer(`window.api.openCommunityServiceDocument({syncId:${JSON.stringify(project.id)}})`);
  assert.equal(opened.success, true, JSON.stringify(opened));
  const published = await renderer(`window.api.publishServiceProject({projectId:${JSON.stringify(project.id)},revisionId:${JSON.stringify(opened.data.revisionId)}})`);
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
  planner.on('console-message', event => console.error('[planner]', event.message));
  await renderer(`document.getElementById('btnShowAdjust').click();`);
  await waitFor(() => renderer(`document.getElementById('showAdjustPanel').hidden === false`), 'Adjust');
  await delay(500);
  offline = true;
  await planner.executeJavaScript(`const field=document.querySelector('.heritage-service-planner__stage [data-role="caption"][contenteditable]');field.focus();field.textContent='Backstage offline edit';field.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertText'}));field.blur();document.querySelector('button[aria-label="Save service"]').click();true`);
  await waitFor(() => planner.executeJavaScript(`document.body.textContent.includes('Saved on this computer')||document.body.textContent.includes('Waiting to sync')`), 'actual offline save');
  const unchanged = await renderer(`window.api.getAppState()`);
  assert.equal(unchanged.serviceHandoff.project.revisionId, before.serviceHandoff.project.revisionId);
  let display;
  for (const win of BrowserWindow.getAllWindows().filter(win => win.webContents.getURL().includes('display.html'))) {
    if (await win.webContents.executeJavaScript('displayState.language') === 'fixture-english') display = win;
  }
  assert.ok(display, 'English output exists');
  const languageOutputs = new Map();
  for (const win of BrowserWindow.getAllWindows().filter(win => win.webContents.getURL().includes('display.html'))) languageOutputs.set(await win.webContents.executeJavaScript('displayState.language'),win);
  assert.ok(languageOutputs.has('fixture-russian')); assert.ok(languageOutputs.has('fixture-media'));
  assert.equal(await display.webContents.executeJavaScript("document.body.textContent.includes('Original slide')"), true);
  assert.equal(await renderer(`Boolean(document.getElementById('btnApplyShowAdjust'))`), false, 'No extra Apply step');
  await renderer(`document.querySelector('#outputPreviewList button:not([hidden])').click();true`);
  await waitFor(async () => (await renderer(`window.api.getAppState()`)).serviceHandoff.project.revisionId !== before.serviceHandoff.project.revisionId, 'visible Live preview retake');
  const after = await renderer(`window.api.getAppState()`);
  assert.notEqual(after.serviceHandoff.project.revisionId, before.serviceHandoff.project.revisionId);
  assert.equal(after.currentSlide, before.currentSlide);
  await waitFor(() => display.webContents.executeJavaScript(`document.body.textContent.includes('Backstage offline edit')`), 'actual display retaken');
  assert.equal(await renderer(`state.workflowStage`), 'show', JSON.stringify(await renderer('window.fixtureStages')));
  await delay(300);
  // Shared Adjust thumbnail takes are enabled only in Show mode.
  await planner.executeJavaScript(`document.querySelector('.heritage-workspace-toolbar__views button:first-child').click();true`);
  await waitFor(() => planner.executeJavaScript(`Boolean(document.querySelector('[data-show-mode="true"]'))`), 'scoped Show thumbnail mode');
  await planner.executeJavaScript(`window.fixtureTakes=[];window.addEventListener('message',event=>{if(event.data?.type==='heritage-editor:taken')window.fixtureTakes.push(event.data)});document.querySelector('[data-preview-tile]').click();true`);
  await waitFor(() => planner.executeJavaScript(`Boolean(document.querySelector('[data-preview-tile][data-live="true"]'))`), 'acknowledged Live tile marker');
  const tileTake = await waitFor(() => planner.executeJavaScript(`window.fixtureTakes.at(-1)`), 'trusted shared thumbnail take');
  assert.equal(tileTake.ok,true,JSON.stringify(tileTake));
  await delay(300);
  assert.equal((await renderer(`window.api.getAppState()`)).currentSlide, 0);
  await planner.executeJavaScript(`window.postMessage({type:'heritage-editor:take',syncId:${JSON.stringify(project.id)},cueId:'cue-missing-for-rehearsal'},window.location.origin);true`);
  const rejectedTake = await waitFor(() => planner.executeJavaScript(`window.fixtureTakes.at(-1)?.ok === false && window.fixtureTakes.at(-1)`), 'rejected tile take reply');
  await waitFor(() => planner.executeJavaScript(`document.body.innerText.includes(${JSON.stringify(rejectedTake.error)})`), 'visible shared take failure');
  assert.equal((await renderer(`window.api.getAppState()`)).currentSlide,0,'rejected tile must keep old output');
  assert.equal(await display.webContents.executeJavaScript(`document.body.textContent.includes('Backstage offline edit')`),true);
  // Edit remains backstage until normal visible Next, with no Apply step.
  await planner.executeJavaScript(`document.querySelector('.heritage-workspace-toolbar__views button:nth-child(2)').click();true`);
  await waitFor(() => planner.executeJavaScript(`Boolean(document.querySelector('.heritage-service-planner__stage [data-role="caption"][contenteditable]'))`), 'second edit view');
  await planner.executeJavaScript(`{const field=document.querySelector('.heritage-service-planner__stage [data-role="caption"][contenteditable]');field.focus();field.textContent='Second backstage edit';field.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertText'}));}true`);
  assert.equal(await display.webContents.executeJavaScript(`document.body.textContent.includes('Backstage offline edit')`), true);
  await renderer(`document.getElementById('btnNextSlide').click();true`);
  await waitFor(async () => (await renderer(`window.api.getAppState()`)).currentSlide === 1, 'visible Next publishes latest draft');
  await waitFor(() => display.webContents.executeJavaScript(`document.body.textContent.includes('Following slide')`), 'actual next output');
  await planner.executeJavaScript(`document.querySelector('.heritage-workspace-toolbar__views button:first-child').click();true`);
  await waitFor(() => planner.executeJavaScript(`document.querySelector('[data-preview-tile][data-live="true"] .heritage-service-preview__tile-caption')?.textContent.includes('Following')`), 'Live marker follows native Next');
  for (const id of ['fixture-russian','fixture-media']) await waitFor(() => languageOutputs.get(id).webContents.executeJavaScript(`document.body.textContent.includes('Следующий слайд')`), `${id} native bilingual output`);
  const screenshot = path.join(root, 'adjust.png');
  await fs.writeFile(screenshot, (await control.capturePage()).toPNG());
  await fs.writeFile(path.join(root, 'actual-editor.png'), (await planner.capturePage()).toPNG());
  await renderer(`closeShowAdjust()`);
  assert.equal(await renderer(`showAdjustOpen`), false, 'Close must save backstage while a Show is active');
  // A fresh page load while disconnected uses the saved original editor assets.
  await planner.reload();
  await waitFor(() => !planner.isLoading() && planner.executeJavaScript(`document.body.textContent.includes('Desktop offline rehearsal')`), 'offline editor reopen');
  await renderer(`window.api.openPlannerService(${JSON.stringify(project.id)})`);
  await waitFor(() => planner.executeJavaScript(`Boolean(document.querySelector('.heritage-service-planner__stage [data-role="caption"][contenteditable]'))`), 'offline saved document reopen');
  assert.equal(await planner.executeJavaScript(`document.querySelector('.heritage-service-planner__stage [data-role="caption"][contenteditable]').textContent`), 'Second backstage edit');
  offline = false;
  await delay(16000);
  saved = (await (await fetch(`${api}/${project.id}`,{headers:authHeaders})).json()).serviceDocument;
  assert.equal(core.validateHeritageServiceDocumentSource(saved.documentSource).project.items.point.textByChannel.english, 'Second backstage edit');
  await fs.writeFile(resultPath, JSON.stringify({ ok: true, sameEditorOffline: true, showStableWhileEditing: true,
    actualOutputAfterRetake: true, sharedThumbnailTake: true, liveMarkerAndVisibleTakeFailure: true, actualNextPublishesDraft: true, nativeRussianAndStageVerified: true, currentCuePreserved: true, reconnectSynced: true, proxyPort:server.address().port, screenshot }, null, 2));
}
run().then(() => { server.close(); app.exit(0); }).catch(async error => {
  const pages = [];
  for (const contents of electron.webContents.getAllWebContents()) {
    if (!contents.getURL().startsWith('http://127.0.0.1:')) continue;
    try { pages.push({url:contents.getURL(),text:await contents.executeJavaScript('document.body.innerText.slice(0,8000)'),fields:await contents.executeJavaScript('Array.from(document.querySelectorAll("[contenteditable]")).map(e=>({role:e.dataset.role,text:e.textContent}))')}); } catch {}
  }
  await fs.writeFile(resultPath, JSON.stringify({ ok: false, error: error.stack, pages }, null, 2)); server.close(); app.exit(1);
});
