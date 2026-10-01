'use strict';
// Reuse only a marked disposable profile produced by the real-editor fixture.
// The identical loopback origin now returns 503 for every upstream request.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const http = require('node:http');
const electron = require('electron');
const { app, BrowserWindow } = electron;
const profile = process.env.SYNCSHOW_TEST_USER_DATA_DIR;
const resultPath = process.env.SYNCSHOW_UNIFIED_RESULT;
const previousPath = process.env.SYNCSHOW_PREVIOUS_REHEARSAL;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function waitFor(callback, label) {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) { const result = await callback(); if (result) return result; await delay(50); }
  throw new Error(`Timed out: ${label}`);
}
const server = http.createServer((_request, response) => {
  response.writeHead(503, {'Content-Type':'application/json'});
  response.end(JSON.stringify({error:'Disposable server disconnected'}));
});
require('../../main');
async function run() {
  const previous = JSON.parse(await fs.readFile(previousPath, 'utf8'));
  assert.equal(previous.ok, true); assert.ok(Number.isInteger(previous.proxyPort));
  await new Promise(resolve => server.listen(previous.proxyPort, '127.0.0.1', resolve));
  await app.whenReady();
  const control = await waitFor(() => BrowserWindow.getAllWindows().find(win => win.webContents.getURL().endsWith('/src/renderer/index.html') && !win.webContents.isLoading()), 'restarted control');
  const renderer = source => control.webContents.executeJavaScript(source);
  await renderer('refreshCommunityStatus()');
  const appState = await renderer('window.api.getAppState()');
  const serviceId = appState.serviceHandoff?.project?.id;
  assert.ok(serviceId, 'prepared service survives process restart');
  await renderer("document.getElementById('btnStagePrepare').click();true");
  const planner = await waitFor(() => electron.webContents.getAllWebContents().find(contents => contents.getURL() === `http://127.0.0.1:${previous.proxyPort}/admin/plan-service` && !contents.isLoading()), 'original editor offline after restart');
  const opened = await renderer(`window.api.openPlannerService(${JSON.stringify(serviceId)})`);
  assert.equal(opened.success, true, JSON.stringify(opened));
  await waitFor(() => planner.executeJavaScript("document.body.innerText.includes('Second backstage edit')"), 'durable saved caption');
  await planner.executeJavaScript("document.querySelector('.heritage-workspace-toolbar__views button:nth-child(2)').click();true");
  await waitFor(() => planner.executeJavaScript("Boolean(document.querySelector('.heritage-service-planner__stage [data-role=caption][contenteditable]'))"), 'offline edit surface');
  await planner.executeJavaScript("{const field=document.querySelector('.heritage-service-planner__stage [data-role=caption][contenteditable]');field.focus();field.textContent='Edited after offline app restart';field.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertText'}));}true");
  // Ctrl+S is handled by the actual shared editor, including focused text.
  planner.sendInputEvent({type:'keyDown',keyCode:'S',modifiers:['control']});
  planner.sendInputEvent({type:'keyUp',keyCode:'S',modifiers:['control']});
  await waitFor(() => planner.executeJavaScript("document.body.innerText.includes('Saved on this computer')"), 'restarted offline Ctrl+S');
  const flushed = await renderer('window.api.flushCommunityPlanner()');
  assert.equal(flushed.success, true, JSON.stringify(flushed));
  const journal = JSON.parse(await fs.readFile(`${profile}/community/planner/fixture-connection/journal.json`, 'utf8'));
  assert.equal(journal.documents[serviceId].project.items.point.textByChannel.english, 'Edited after offline app restart');
  assert.ok(journal.pending[serviceId]);
  await fs.writeFile(resultPath, JSON.stringify({ok:true,processRestartOffline:true,sameEditor:true,preparedServicePreserved:true,focusedCtrlS:true,durablePendingEdit:true},null,2));
}
run().then(() => {server.close();app.exit(0);}).catch(async error => {
  await fs.writeFile(resultPath, JSON.stringify({ok:false,error:error.stack},null,2));server.close();app.exit(1);
});
