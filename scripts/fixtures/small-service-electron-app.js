'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const electron = require('electron');
const {app, BrowserWindow} = electron;
const resultPath = process.env.SYNCSHOW_SMALL_SERVICE_RESULT;
const screenshots = process.env.SYNCSHOW_SMALL_SERVICE_SCREENSHOTS;
const count = Number(process.env.SYNCSHOW_SMALL_SERVICE_DISPLAYS ?? 1);
const chosen = process.env.SYNCSHOW_SMALL_SERVICE_SCREEN || 'english';
const fakeDisplays = Array.from({length:count+1}, (_,i) => ({id:i+1,internal:i===0,bounds:{x:i*1400,y:0,width:1400,height:900},workArea:{x:i*1400,y:0,width:1400,height:900},size:{width:1400,height:900},workAreaSize:{width:1400,height:900},scaleFactor:1,rotation:0,touchSupport:'unknown',monochrome:false,colorDepth:24,depthPerComponent:8,displayFrequency:60}));
app.once('ready',()=>{
  electron.screen.getPrimaryDisplay=()=>fakeDisplays[0];
  electron.screen.getAllDisplays=()=>fakeDisplays;
  electron.screen.getDisplayMatching=bounds=>fakeDisplays.find(d=>bounds.x>=d.bounds.x&&bounds.x<d.bounds.x+1400)||fakeDisplays[0];
});
const realShow=BrowserWindow.prototype.show, realVisible=BrowserWindow.prototype.isVisible, realHide=BrowserWindow.prototype.hide;
BrowserWindow.prototype.show=function(){this.fixtureRequestedVisible=true;if(process.env.SYNCSHOW_SMALL_SERVICE_VISIBLE==='1' && this.webContents.getURL().endsWith('/src/renderer/index.html'))return realShow.call(this);};
BrowserWindow.prototype.showInactive=function(){this.fixtureRequestedVisible=true;};
BrowserWindow.prototype.hide=function(){this.fixtureRequestedVisible=false;return realHide.call(this);};
BrowserWindow.prototype.isVisible=function(){return this.fixtureRequestedVisible ?? realVisible.call(this);};
BrowserWindow.prototype.setFullScreen=function(){};
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function waitFor(callback,label){const deadline=Date.now()+45000;let last;while(Date.now()<deadline){try{const value=await callback();if(value)return value;}catch(error){last=error;}await delay(80);}throw new Error(`Timed out: ${label}${last?' '+last.message:''}`);}
const realHandle = electron.ipcMain.handle.bind(electron.ipcMain);
electron.ipcMain.handle = (name, handler) => realHandle(name, async (...args) => {
  if (/quickStart|publish|openLocalService|prepareLoad|planner:flush/.test(name)) console.log('IPC begin', name);
  try {const result = await handler(...args); if (/quickStart|publish|openLocalService|prepareLoad|planner:flush/.test(name)) console.log('IPC end', name);return result;}
  catch(error) {console.log('IPC failed',name,error.message);throw error;}
});
setTimeout(async()=>{console.error('Rehearsal exceeded its deadline');app.exit(1);},120000).unref();
require('../../main');
async function run(){
  await app.whenReady();await fs.mkdir(screenshots,{recursive:true});
  const control=await waitFor(()=>BrowserWindow.getAllWindows().find(win=>win.webContents.getURL().endsWith('/src/renderer/index.html')&&!win.webContents.isLoading()),'control');
  const renderer=source=>control.webContents.executeJavaScript(source);
  await waitFor(()=>renderer("Boolean(window.api && state.profile && quickStartPicker)"),'initialized control');
  const profileBefore=await renderer('JSON.stringify(state.profile)');
  if (process.env.SYNCSHOW_SMALL_SERVICE_RESTART === '1') {
    await waitFor(()=>renderer('state.serviceHandoff?.cueIds.length>1'),'restored local service');
    assert.equal(await renderer('elements.btnStartBlank.hidden'),true,'hidden preference survives restart');
    await renderer("document.getElementById('btnStagePrepare').click();true");
    const editor=await waitFor(()=>electron.webContents.getAllWebContents().find(contents=>contents.getURL().includes('/syncshow-local/adjust/index.html?service=')&&!contents.isLoading()),'reopened local Prepare');
    await waitFor(()=>editor.executeJavaScript("document.body.innerText.includes('Homegroup grace')"),'local song survives restart');
    await fs.writeFile(resultPath,JSON.stringify({ok:true,restart:true,hiddenPreference:true,localSongPreserved:true,localPresentationPreserved:true},null,2));
    return;
  }

  await renderer("document.getElementById('btnStartBlank').click();true");
  await waitFor(()=>renderer("document.getElementById('startBlankDialog').open"),'screen chooser');
  await renderer(`quickStartPicker.setValue({screenIds:${JSON.stringify(chosen.split(','))},hintScreenIds:${JSON.stringify(chosen.split(',').filter(id=>id==='english'||id==='media'))}});document.getElementById('startBlankName').value='Thursday homegroup';true`);
  await delay(350);
  await fs.writeFile(path.join(screenshots,'01-screen-chooser.png'),(await control.capturePage()).toPNG());
  console.log('Create blank');
  await renderer("document.getElementById('btnConfirmStartBlank').click();true");
  const planner=await waitFor(()=>electron.webContents.getAllWebContents().find(contents=>contents.getURL().includes('/syncshow-local/adjust/index.html?service=')&&!contents.isLoading()),'local editor');
  await waitFor(()=>planner.executeJavaScript("document.body.innerText.includes('Thursday homegroup')"),'presentation rendered');
  const appState=await renderer('window.api.getAppState()');
  assert.equal(appState.presentationScreens.localOnly,true);
  assert.deepEqual(appState.presentationScreens.screenIds,chosen.split(','));
  assert.equal(await renderer('JSON.stringify(state.profile)'),profileBefore,'saved venue setup stays intact');
  if(count>=chosen.split(',').length){
    await waitFor(()=>renderer('state.workflowStage===\'show\' && showAdjustOpen'),'quick Adjust');
    assert.equal(appState.activeLaunchPlan.outputs.length,chosen.split(',').length);
    assert.ok(appState.activeLaunchPlan.outputs.every(output=>output.displayId!==1));
  }else await waitFor(()=>renderer("state.workflowStage==='prepare'"),'offline Prepare');
  await waitFor(()=>renderer("!document.getElementById('showAdjustStatus')?.textContent.includes('Opening')"),'Adjust ready');
  await delay(350);
  await fs.writeFile(path.join(screenshots,'02-local-editor.png'),(await control.capturePage()).toPNG());
  // Add-song opens the same library; the desktop creator needs no online form.
  await planner.executeJavaScript("document.querySelector('.heritage-add-slide')?.click();true");
  await waitFor(()=>planner.executeJavaScript("Boolean(document.querySelector('.heritage-add-create-song > button'))"),'local song action');
  await planner.executeJavaScript("document.querySelector('.heritage-add-create-song > button').click();true");
  await waitFor(()=>planner.executeJavaScript("Boolean(document.querySelector('.local-song-editor form'))"),'local song form');
  await planner.executeJavaScript(`(() => {
    const form=document.querySelector('.local-song-editor form'), fields=form.querySelectorAll('input'), lyrics=form.querySelectorAll('textarea');
    const set=(field,value)=>{Object.getOwnPropertyDescriptor(field.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype,'value').set.call(field,value);field.dispatchEvent(new Event('input',{bubbles:true}));};
    set(fields[0],'Благодать');set(fields[1],'Homegroup grace');set(lyrics[0],'Благодать\\nИ мир\\n\\nНаш Господь');set(lyrics[1],'Grace and peace\\nFor all\\n\\nOur Lord');set(fields[2],'Example author');
  })();true`);
  await delay(150);
  if(process.env.SYNCSHOW_SMALL_SERVICE_VISIBLE==='1') await fs.writeFile(path.join(screenshots,'03-local-song-form.png'),(await control.capturePage()).toPNG());
  if (process.env.SYNCSHOW_SMALL_SERVICE_HOLD_FORM === '1') {
    await fs.writeFile(resultPath,JSON.stringify({phase:'review-song-form'}));
    while (!(await fs.stat('/private/tmp/small-service-form-reviewed').catch(()=>null))) await delay(200);
  }
  await planner.executeJavaScript("document.querySelector('.local-song-editor button[type=submit]').click();true");
  await waitFor(()=>planner.executeJavaScript("!document.querySelector('.local-song-editor') && document.body.innerText.includes('Song saved')"),'song saved offline');
  await planner.executeJavaScript("document.querySelector('.heritage-add-preview .heritage-add-primary').click();true");
  await waitFor(()=>planner.executeJavaScript("!document.querySelector('.heritage-add-dialog[open]') && document.body.innerText.includes('Homegroup grace')"),'song added');
  console.log('Flushing song');
  const flushed=await renderer('window.api.flushCommunityPlanner()');
  console.log('Flushed song');
  assert.equal(flushed.success,true,JSON.stringify(flushed));
  const finalState=await renderer('window.api.getAppState()');
  if(count>=chosen.split(',').length) {
    assert.equal(finalState.currentSlide,0,'adding a song backstage keeps the audience blank');
    await renderer('toggleShowAdjust()');
    await waitFor(()=>renderer('state.community.plannerShowDraftReady'),'draft package ready');
    await renderer("document.querySelector('.thumbnail-item[data-index=\"1\"]').click();true");
    await waitFor(()=>renderer('state.currentSlide===1 && state.totalSlides>1 && !state.cueNavigationBusy'),'take local song');
  } else {
    console.log('Go to Load');
    await renderer("document.getElementById('btnStageLoad').click();true");
    console.log('Clicked Load');
    await waitFor(()=>renderer("!state.community.handoffBusy && state.serviceHandoff?.cueIds.length>1"),'local Prepare save to Load');
  }
  await renderer("elements.showStartBlankPreference.checked=false;elements.showStartBlankPreference.dispatchEvent(new Event('change'));true");
  await waitFor(()=>renderer('elements.btnStartBlank.hidden'),'Start Blank hide preference');
  await fs.writeFile(resultPath,JSON.stringify({ok:true,chosen,count,localOnly:true,profilePreserved:true,autoAdjust:count>=chosen.split(',').length,createdSongOffline:true,body:await planner.executeJavaScript('document.body.innerText'),appState:await renderer('window.api.getAppState()')},null,2));
}
run().then(()=>app.exit(0)).catch(async error=>{await fs.writeFile(resultPath,JSON.stringify({ok:false,error:error.stack,windows:await Promise.all(electron.webContents.getAllWebContents().map(async w=>({url:w.getURL(),type:w.getType(),body:await w.executeJavaScript('document.body.innerText').catch(()=>''),state:w.getURL().includes('/src/renderer/index.html')?await w.executeJavaScript('({stage:state.workflowStage,busy:state.community.handoffBusy,warning:state.prepareLoadWarning,error:state.nativeLoadError})').catch(()=>null):null})))},null,2));app.exit(1);});
