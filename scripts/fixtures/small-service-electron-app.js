'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const electron = require('electron');
const {app, BrowserWindow} = electron;
app.on('web-contents-created', (_event, contents) => {
  contents.on('console-message', details => {
    if (['warning', 'error'].includes(details.level)) console.log('Renderer diagnostic:', String(details.message).slice(0, 600));
  });
  const execute = contents.executeJavaScript.bind(contents);
  contents.executeJavaScript = async (source, ...args) => {
    try { return await execute(source, ...args); }
    catch (error) { error.stack += `\nFixture script: ${String(source).slice(0, 180)}`; throw error; }
  };
});
const resultPath = process.env.SYNCSHOW_SMALL_SERVICE_RESULT;
const screenshots = process.env.SYNCSHOW_SMALL_SERVICE_SCREENSHOTS;
const count = Number(process.env.SYNCSHOW_SMALL_SERVICE_DISPLAYS ?? 1);
const chosen = process.env.SYNCSHOW_SMALL_SERVICE_SCREEN || 'english';
const fakeDisplays = Array.from({length:count+1}, (_,i) => ({id:i+1,label:`Rehearsal monitor ${i}`,internal:i===0,bounds:{x:i*1400,y:0,width:1400,height:900},workArea:{x:i*1400,y:0,width:1400,height:900},size:{width:1400,height:900},workAreaSize:{width:1400,height:900},scaleFactor:1,rotation:0,touchSupport:'unknown',monochrome:false,colorDepth:24,depthPerComponent:8,displayFrequency:60}));
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
  await waitFor(()=>renderer("state.workflowStage==='show' && !state.isStarting && !showAdjustOpen"),'blank Show');
  await renderer("document.querySelector('[data-show-add=songs]').click();true");
  const planner=await waitFor(()=>electron.webContents.getAllWebContents().find(contents=>contents.getURL().includes('/syncshow-local/adjust/index.html?service=')&&!contents.isLoading()),'local editor');
  await waitFor(()=>planner.executeJavaScript("document.body.innerText.includes('Thursday homegroup')"),'presentation rendered');
  const appState=await renderer('window.api.getAppState()');
  assert.equal(appState.presentationScreens.localOnly,true);
  assert.deepEqual(appState.presentationScreens.screenIds,chosen.split(','));
  assert.equal(await renderer('JSON.stringify(state.profile)'),profileBefore,'saved venue setup stays intact');
  const previewOnly=count<chosen.split(',').length;
  assert.equal(appState.previewOnly,previewOnly);
  await waitFor(()=>renderer("showAdjustOpen"),'direct add-song Adjust');
  assert.equal(appState.activeLaunchPlan.outputs.length,chosen.split(',').length);
  assert.ok(appState.activeLaunchPlan.outputs.every(output=>output.displayId!==1));
  if(previewOnly) {
    assert.ok(BrowserWindow.getAllWindows().filter(win=>win.syncShowPreviewOnly).every(win=>!win.isVisible()&&!win.isFullScreen()&&win.webContents.isOffscreen()));
    assert.equal(await renderer('elements.showPreviewOnly.hidden'),false);
  }
  await waitFor(()=>renderer("!document.getElementById('showAdjustStatus')?.textContent.includes('Opening')"),'Adjust ready');
  await delay(350);
  await fs.writeFile(path.join(screenshots,'02-local-editor.png'),(await control.capturePage()).toPNG());
  // Add-song opens the same library; the desktop creator needs no online form.
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
  {
    assert.equal(finalState.currentSlide,0,'adding a song backstage keeps the audience blank');
    await renderer('toggleShowAdjust()');
    await waitFor(()=>renderer('state.community.plannerShowDraftReady'),'draft package ready');
    await waitFor(()=>renderer("Boolean(document.querySelector('.thumbnail-item[data-index=\"1\"]'))"),'new song thumbnail is rendered');
    await renderer("document.querySelector('.thumbnail-item[data-index=\"1\"]').click();true");
    await waitFor(()=>renderer('state.currentSlide===1 && state.totalSlides>1 && !state.cueNavigationBusy'),'take local song');
  }
  // The temporary Bible tool must render the same style on every output and
  // return to the exact song cue. It also exercises hidden preview renderers.
  await renderer("elements.btnOpenBible.click();elements.bibleReference.value='John 3:16';elements.bibleTranslation.value='BSB';elements.btnLookupBible.click();true");
  await waitFor(()=>renderer('Boolean(state.bible.passage) && !state.bible.busy'),'Bible passage lookup');
  await renderer("[...elements.bibleTargetList.querySelectorAll('input[type=checkbox]')].forEach(input=>{input.checked=true;input.dispatchEvent(new Event('change',{bubbles:true}));});elements.btnSendBibleLive.click();true");
  await waitFor(()=>renderer('state.bible.isLive && !state.bible.sending'),'Bible overlay live');
  const displayWindows=BrowserWindow.getAllWindows().filter(win=>win.webContents.getURL().endsWith('/display.html')||win.webContents.getURL().endsWith('/singer.html'));
  for(const win of displayWindows) {
    console.log('Verify Bible output', win.id);
    const colors=await win.webContents.executeJavaScript(`(() => {const overlay=[...document.querySelectorAll('.bible-overlay')].find(node=>!node.hidden&&!node.classList.contains('staging'));return overlay ? {background:getComputedStyle(overlay).backgroundColor,reference:getComputedStyle(overlay.querySelector('.bible-reference')).color,words:getComputedStyle(overlay.querySelector('.bible-verses')).color,text:overlay.innerText}:null;})()`);
    assert.ok(colors,'overlay present');assert.equal(colors.background,'rgb(0, 0, 0)');assert.equal(colors.reference,'rgb(255, 192, 0)');assert.equal(colors.words,'rgb(255, 255, 255)');
    assert.match(colors.text,/God/);
    await fs.writeFile(path.join(screenshots,`04-bible-${win.id}.png`),(await win.webContents.capturePage()).toPNG());
  }
  await renderer('elements.btnReturnFromBible.click();true');
  await waitFor(()=>renderer('!state.bible.isLive && !state.bible.sending'),'Bible return');
  assert.equal(await renderer('state.currentSlide'),1);
  await renderer("elements.bibleDialog.close();true");
  await renderer('window.api.clearDisplays()');
  await waitFor(()=>renderer("state.showState?.phase==='cleared'"),'Clear');
  const restored=await renderer('window.api.showDisplays()');
  assert.equal(restored.success,true,JSON.stringify(restored));
  await waitFor(()=>renderer("state.showState?.phase==='live'"),'Restore');
  if(previewOnly) assert.ok(displayWindows.every(win=>!win.isVisible()&&!win.isFullScreen()),'preview never projects during Restore');
  await renderer('window.api.stopPresentation()');
  await waitFor(()=>renderer("state.showState?.phase==='hidden'"),'Stop');
  assert.equal((await renderer('window.api.showDisplays()')).success,true);
  await waitFor(()=>renderer("state.showState?.phase==='live'"),'Restore after Stop');
  // Direct Add Passage must reopen the active Show and select Scripture.
  await renderer("document.querySelector('[data-show-add=scripture]').click();true");
  await waitFor(()=>planner.executeJavaScript("Boolean(document.querySelector('.heritage-add-workbench[data-category=scripture]'))"),'direct Add Passage');
  await planner.executeJavaScript(`(() => {
    const field=document.querySelector('.heritage-add-scripture input[type=text]');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(field,'John 3:16');
    field.dispatchEvent(new Event('input',{bubbles:true}));
  })();true`);
  await waitFor(()=>planner.executeJavaScript("!document.querySelector('.heritage-add-scripture .heritage-add-primary').disabled"),'valid passage reference');
  await planner.executeJavaScript("document.querySelector('.heritage-add-scripture .heritage-add-primary').click();true");
  await waitFor(()=>planner.executeJavaScript("!document.querySelector('.heritage-add-dialog[open]')"),'passage inserted backstage');
  assert.equal((await renderer('window.api.flushCommunityPlanner()')).success,true);
  assert.equal(await renderer('state.currentSlide'),1,'adding a passage preserves the current song cue');
  // A second and third addition must be reachable without closing Adjust.
  // Check actual hit coordinates and the native child-view boundary, not just
  // DOM .click() on the toolbar hidden underneath the editor.
  for (const category of ['songs', 'media']) {
    console.log('Verify repeated backstage Add', category);
    await waitFor(()=>renderer('!showAdjustOpening && !showAdjustBusy'),'backstage toolbar ready');
    const point = await renderer(`(() => {
      const button=document.querySelector('#showAdjustPanel [data-show-add=${category}]');
      const rect=button.getBoundingClientRect(), viewport=elements.showAdjustViewport.getBoundingClientRect();
      const x=Math.round(rect.left+rect.width/2),y=Math.round(rect.top+rect.height/2);
      return {x,y,disabled:button.disabled,hit:document.elementFromPoint(x,y)===button,aboveEditor:rect.bottom<=viewport.top};
    })()`);
    assert.deepEqual({disabled:point.disabled,hit:point.hit,aboveEditor:point.aboveEditor}, {disabled:false,hit:true,aboveEditor:true});
    const nativeEditor=control.contentView.children.find(view=>view.webContents===planner);
    assert.ok(nativeEditor && point.y<nativeEditor.getBounds().y,'native editor cannot intercept the add toolbar');
    control.webContents.sendInputEvent({type:'mouseDown',x:point.x,y:point.y,button:'left',clickCount:1});
    control.webContents.sendInputEvent({type:'mouseUp',x:point.x,y:point.y,button:'left',clickCount:1});
    await waitFor(()=>planner.executeJavaScript(`Boolean(document.querySelector('.heritage-add-workbench[data-category=${category}]'))`),`repeated add ${category}`);
    assert.equal(await renderer('state.currentSlide'),1,'reopening Add remains backstage');
  }
  await fs.writeFile(path.join(screenshots,'05-repeated-add-toolbar.png'),(await control.capturePage()).toPNG());
  await renderer('closeShowAdjust()');
  await waitFor(()=>renderer('state.community.plannerShowDraftReady'),'passage draft ready');
  if(previewOnly) {
    const first=displayWindows[0];
    first.webContents.forcefullyCrashRenderer();
    await waitFor(()=>renderer("state.showState?.recovery"),'preview recovery begins');
    await waitFor(()=>renderer("state.showState?.phase==='live' && !state.showState?.recovery && state.showState.outputs.every(output=>output.status==='healthy')"),'preview recovery ready');
    assert.equal(await renderer('state.currentSlide'),1);
    assert.ok(BrowserWindow.getAllWindows().filter(win=>win.syncShowPreviewOnly).every(win=>!win.isVisible()&&!win.isFullScreen()),'recovery never projects preview renderers');
  }
  const plannerBody = await planner.executeJavaScript('document.body.innerText');
  if (process.env.SYNCSHOW_SMALL_SERVICE_SCREEN_REGRESSION === '1') {
    console.log('Verify changed monitor ID and mode');
    assert.ok(count >= 3 && !previewOnly, 'screen regression requires three simulated external monitors');
    const removed={...fakeDisplays[1]};
    fakeDisplays[1]={...removed,id:202,scaleFactor:1.5,rotation:90};
    electron.screen.emit('display-removed',{},removed);
    electron.screen.emit('display-added',{},fakeDisplays[1]);
    await waitFor(()=>renderer('Boolean(state.showState?.recovery)'),'unplug recovery begins');
    await waitFor(()=>renderer("state.showState?.phase==='live' && !state.showState?.recovery && state.showState.outputs.every(output=>output.status==='healthy')"),'renumbered and rotated monitor recovers');
    assert.equal(await renderer('state.currentSlide'),1,'screen recovery retains the current cue');
    electron.powerMonitor.emit('suspend');
    electron.powerMonitor.emit('resume');
    console.log('Verify Start-time rescan');
    await renderer('backToSetup()');
    await waitFor(()=>renderer("state.workflowStage==='load' && !state.showEndSessionBusy"),'Load before rechecking screens');
    // OS knows the monitors are back, but Load deliberately has a stale empty
    // snapshot. Clicking Start must rescan before deciding anything is missing.
    await renderer('state.displays=[];startPresentation();true');
    await waitFor(()=>renderer('state.displays.length===4 && !state.queuedStart'),'Start uses a fresh OS screen snapshot');
    // With every input already chosen, Start launches automatically. Merely
    // seeing a startAttempt is not completion: wait for every output's startup
    // barrier before exporting diagnostics or taking further UI actions.
    await waitFor(()=>renderer("state.workflowStage==='show' && state.isPresenting && !state.isStarting && !state.startAttempt"),'fresh Start finishes on every output after re-scan');
    const diagnosticFile=path.join(screenshots,'screen-diagnostics.json');
    console.log('Verify diagnostic export');
    electron.dialog.showSaveDialog=async()=>{
      console.log('Diagnostic destination selected');
      return {canceled:false,filePath:diagnosticFile};
    };
    const getGpuInfo=app.getGPUInfo.bind(app);
    app.getGPUInfo=async type=>{
      console.log('Diagnostic GPU query started');
      const value=await getGpuInfo(type);
      console.log('Diagnostic GPU query finished');
      return value;
    };
    assert.equal((await renderer('window.api.exportSupportDiagnostics()')).saved,true);
    console.log('Diagnostic export completed');
    const diagnostics=JSON.parse(await fs.readFile(diagnosticFile,'utf8'));
    assert.equal(diagnostics.schemaVersion,2);
    const reasons=diagnostics.screenHistory.events.map(event=>event.reason);
    for (const reason of ['app-startup','display-removed','display-added','recovery-succeeded','computer-suspend','computer-resume','start-rescan','diagnostics-export']) assert.ok(reasons.includes(reason),`diagnostics include ${reason}`);
    assert.ok(diagnostics.screenHistory.events.some(event=>event.activeOutputs.some(output=>output.displayId==='202')),'journal records the reconnected output target');
    assert.equal(diagnostics.screenHistory.persistenceError,null);
  }
  // The three-output fixture uses simulated placement and hidden windows.
  // Its native frame/route assertions do not depend on optional screenshots.
  if (process.env.SYNCSHOW_SMALL_SERVICE_SCREEN_REGRESSION !== '1') {
    await fs.writeFile(path.join(screenshots,'05-show.png'),(await control.capturePage()).toPNG());
  }
  if (process.env.SYNCSHOW_SMALL_SERVICE_HOLD_SHOW === '1') {
    await fs.writeFile(resultPath,JSON.stringify({phase:'review-show'}));
    while (!(await fs.stat('/private/tmp/small-service-show-reviewed').catch(()=>null))) await delay(200);
  }
  console.log('Verify interface preference persistence');
  await renderer("elements.showStartBlankPreference.checked=false;elements.showStartBlankPreference.dispatchEvent(new Event('change'));true");
  await waitFor(()=>renderer('elements.btnStartBlank.hidden'),'Start Blank hide preference');
  console.log('Write final rehearsal evidence');
  await fs.writeFile(resultPath,JSON.stringify({ok:true,chosen,count,localOnly:true,profilePreserved:true,previewOnly,quickAdd:true,bibleOverlayVerified:true,createdSongOffline:true,body:plannerBody,appState:await renderer('window.api.getAppState()')},null,2));
}
run().then(()=>app.exit(0)).catch(async error=>{await fs.writeFile(resultPath,JSON.stringify({ok:false,error:error.stack,windows:await Promise.all(electron.webContents.getAllWebContents().map(async w=>({url:w.getURL(),type:w.getType(),body:await w.executeJavaScript('document.body.innerText').catch(()=>''),state:w.getURL().includes('/src/renderer/index.html')?await w.executeJavaScript('({stage:state.workflowStage,busy:state.community.handoffBusy,warning:state.prepareLoadWarning,error:state.nativeLoadError})').catch(()=>null):null})))},null,2));app.exit(1);});
