'use strict';
const { app, BrowserWindow, dialog } = require('electron');
const fs = require('node:fs/promises'), path = require('node:path'), assert = require('node:assert/strict');
const { ShowPackagePublisher } = require('../../src/services/project/ShowPackagePublisher');
const root = process.env.SYNCSHOW_RASTER_TEST_ROOT;
if (!root) throw new Error('An isolated test directory is required.');
const originalPublish = ShowPackagePublisher.prototype.publish;
let fault = false, prompts = 0;
ShowPackagePublisher.prototype.publish = async function (...args) {
  if (!fault) return originalPublish.apply(this, args);
  const error = new Error('Slide 1 on english: synthetic rendering failure');
  error.code = 'TEXT_OVERFLOW';
  throw error;
};
dialog.showMessageBox = async (_win, options) => {
  assert.equal(options.title, 'Use PowerPoint fallback?');
  prompts += 1;
  return { response: 0 };
};
require('../../main');
async function waitFor(read) {
  const start = Date.now();
  while (Date.now() - start < 30_000) {
    const value = await read();
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error('The isolated control renderer did not initialize.');
}
app.whenReady().then(async () => {
  const control = await waitFor(() => BrowserWindow.getAllWindows().find(win => /index.html/.test(win.webContents.getURL())));
  await waitFor(() => control.webContents.executeJavaScript('typeof window.api?.createServiceProject === "function" && typeof refreshPublishedProject === "function" && !state.initializingLoad'));
  const invoke = source => control.webContents.executeJavaScript(`(async () => {${source}})()`);
  let current = await invoke('return window.api.createServiceProject({title:"Fallback UI rehearsal", serviceDate:"2026-10-04", startTime:"10:30", teamNotes:"Isolated test"});');
  current = await invoke(`return window.api.addTextToService({projectId:${JSON.stringify(current.project.id)}, expectedRevisionId:${JSON.stringify(current.revisionId)}, kind:"notice", title:"Welcome", text:"Exact selected service", parentId:null});`);
  const waivers = ['song-present', 'exact-sermon-link', 'linked-sermon-material', 'sermon-reading-before-material'].map(checkId => ({ checkId, reason: 'Isolated presentation fallback test.' }));
  current = await invoke(`return window.api.setServicePlanningStatus({projectId:${JSON.stringify(current.project.id)}, expectedRevisionId:${JSON.stringify(current.revisionId)}, status:"ready", waivers:${JSON.stringify(waivers)}});`);
  assert.equal(current.readiness.ready, true);
  fault = true;
  const result = await invoke(`beginNativeServiceLoad(${JSON.stringify(current.project.id)}); const result=await window.api.publishServiceProject({projectId:${JSON.stringify(current.project.id)},revisionId:${JSON.stringify(current.revisionId)}});await refreshPublishedProject(result,{project:${JSON.stringify(current.project)},revisionId:${JSON.stringify(current.revisionId)}});state.nativeLoadBusy=false;checkReadyState();return {result,mode:state.loadMode,ready:getReadinessState().isReady,loaded:Object.values(state.presentations).filter(x=>x.loaded).map(x=>x.slideCount),error:state.nativeLoadError,caption:document.getElementById("loadActionMessage").textContent};`);
  assert.equal(prompts, 1);
  assert.equal(result.result.legacyFallback.projectId, current.project.id);
  assert.equal(result.mode, 'pptx');
  assert.equal(result.error, null);
  assert.ok(result.loaded.length >= 2);
  assert.ok(result.loaded.every(count => count === 1));
  assert.match(result.caption, /converted slides/);
  await fs.writeFile(path.join(root, 'flow-result.json'), JSON.stringify({ ...result, prompts }));
  app.exit(0);
}).catch(error => { console.error(error.stack); app.exit(1); });
