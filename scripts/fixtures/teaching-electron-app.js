'use strict';
// Real main/preload/output/remote browser proof. Only displays and profile are
// synthetic. The production remote listener is bound to loopback in this fixture.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { app, BrowserWindow, screen } = require('electron');
const { RemoteControlServer } = require('../../src/services/remote');
let remote;
const getStatus = RemoteControlServer.prototype.getStatus;
RemoteControlServer.prototype.getStatus = function () { remote = this; return getStatus.call(this); };
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function waitFor(read, label) {
  let last;
  for (let i = 0; i < 160; i++) {
    try { const value = await read(); if (value) return value; } catch (error) { last = error; }
    await pause(50);
  }
  throw new Error(`Timed out: ${label}${last ? ': ' + last.message : ''}`);
}
const rendererInvoke = (win, source) => win.webContents.executeJavaScript(`(async () => {${source}})()`);
BrowserWindow.prototype.setFullScreen = function () {};
app.once('ready', () => {
  const original = screen.getAllDisplays.bind(screen);
  screen.getAllDisplays = () => {
    const displays = original(), edge = Math.max(...displays.map(d => d.bounds.x + d.bounds.width));
    return [...displays, ...OUTPUT_ROUTES.map((route, i) => {
      const bounds = { x: edge + 200 + i * 700, y: 0, width: 640, height: 360 };
      return { ...displays[0], id: route.displayId, bounds, workArea: bounds,
        size: { width: 640, height: 360 }, workAreaSize: { width: 640, height: 360 },
        scaleFactor: 1, internal: false, label: route.name };
    })];
  };
});
const OUTPUT_ROUTES = Object.freeze([
  Object.freeze({
    id: 'front-projector',
    name: 'Front Projector',
    kind: 'normal',
    roleId: 'front',
    roleLabel: 'Front',
    displayId: 880_001,
    operatorPreview: false
  }),
  Object.freeze({
    id: 'translation-projector',
    name: 'Translation Projector',
    kind: 'normal',
    roleId: 'translation',
    roleLabel: 'Translation',
    displayId: 880_002,
    operatorPreview: false
  }),
  Object.freeze({
    id: 'singers-monitor',
    name: 'Singers Monitor',
    kind: 'singer',
    roleId: 'singers',
    roleLabel: 'Singers',
    displayId: 880_003,
    operatorPreview: true
  })
]);
const OUTPUT_IDS = Object.freeze(OUTPUT_ROUTES.map(route => route.id));
const EARLY_ACK_OUTPUT_IDS = Object.freeze(OUTPUT_IDS.slice(0, 2));
const SINGER_OUTPUT_ID = OUTPUT_IDS[2];
const AUTHORITATIVE_RESTORE_TEXT = 'Grace and peace to you';
const STALE_TIMEOUT_TEXT = 'Acknowledged cue three';
const FINAL_CUE_TEXT = 'Acknowledged cue four';
const READINESS_WAIVERS = Object.freeze([
  Object.freeze({
    checkId: 'song-present',
    reason: 'This isolated navigation proof intentionally contains text cues only.'
  }),
  Object.freeze({
    checkId: 'exact-sermon-link',
    reason: 'This isolated navigation proof does not represent a Sunday sermon.'
  }),
  Object.freeze({
    checkId: 'linked-sermon-material',
    reason: 'No sermon material is needed for this isolated navigation proof.'
  }),
  Object.freeze({
    checkId: 'sermon-reading-before-material',
    reason: 'No sermon reading is needed for this isolated navigation proof.'
  })
]);

async function configureThreeOutputProfile(control) {
  const routes = OUTPUT_ROUTES.map(route => ({
    id: route.id,
    name: route.name,
    kind: route.kind,
    roleId: route.roleId,
    roleLabel: route.roleLabel,
    displayId: route.displayId,
    operatorPreview: route.operatorPreview
  }));
  const saved = await rendererInvoke(control, `
    const template = await window.api.getDefaultVenueProfile();
    const routes = ${JSON.stringify(routes)};
    const venueProfile = {
      ...template,
      id: 'electron-three-output-proof',
      name: 'Electron Three Output Proof',
      inputRoles: routes.map((route, index) => ({
        ...template.inputRoles[index],
        id: route.roleId,
        label: route.roleLabel,
        enabled: true,
        kind: 'deck'
      })),
      outputs: routes.map((route, index) => ({
        ...template.outputs[index],
        id: route.id,
        name: route.name,
        enabled: true,
        kind: route.kind,
        expectedRoleId: route.roleId,
        mode: 'role',
        renderer: 'slides',
        sourceRoleId: route.roleId,
        sourceOutputId: null,
        displayFingerprint: null,
        legacyDisplayId: route.displayId,
        operatorPreview: route.operatorPreview,
        fallback: null
      })),
      previewOutputIds: routes
        .filter(route => route.operatorPreview)
        .map(route => route.id),
      singer: {
        ...template.singer,
        fallbackSourceRoleId: 'front'
      },
      operator: {
        ...template.operator,
        showControlMode: 'full',
        previewOpenOutputIds: ['singers-monitor']
      }
    };
    const saved = await window.api.saveSettings({ venueProfile });
    if (saved?.success && typeof loadSavedSettings === 'function') {
      await loadSavedSettings();
      renderProfileEditor();
      checkReadyState();
    }
    return saved;
  `);
  assert.equal(saved.success, true);
  assert.deepEqual(
    saved.venueProfile.inputRoles.map(role => role.id),
    OUTPUT_ROUTES.map(route => route.roleId)
  );
  return saved.venueProfile;
}

async function createAndPublishService(control) {
  let current = await rendererInvoke(control, `
    return window.api.createServiceProject({
      title: 'Acknowledged Navigation Electron Proof',
      serviceDate: '2026-08-16',
      startTime: '10:30',
      teamNotes: 'Isolated automated proof only.'
    });
  `);
  const cueBodies = [
    'Acknowledged cue one',
    AUTHORITATIVE_RESTORE_TEXT,
    STALE_TIMEOUT_TEXT,
    'Acknowledged cue four'
  ];
  for (const [index, text] of cueBodies.entries()) {
    current = await rendererInvoke(control, `
      return window.api.addTextToService({
        projectId: ${JSON.stringify(current.project.id)},
        expectedRevisionId: ${JSON.stringify(current.revisionId)},
        kind: 'notice',
        title: ${JSON.stringify(`Navigation cue ${index + 1}`)},
        text: ${JSON.stringify(text)},
        parentId: null
      });
    `);
  }
  current = await rendererInvoke(control, `
    return window.api.setServicePlanningStatus({
      projectId: ${JSON.stringify(current.project.id)},
      expectedRevisionId: ${JSON.stringify(current.revisionId)},
      status: 'ready',
      waivers: ${JSON.stringify(READINESS_WAIVERS)}
    });
  `);
  assert.equal(current.readiness.ready, true);
  assert.equal(current.readiness.cueCount, 4);
  const published = await rendererInvoke(control, `
    return window.api.publishServiceProject({
      projectId: ${JSON.stringify(current.project.id)},
      revisionId: ${JSON.stringify(current.revisionId)}
    });
  `);
  return {
    ...published,
    project: current.project,
    revisionId: current.revisionId
  };
}

async function startShow(control) {
  const outputs = OUTPUT_ROUTES.map(route => ({
    id: route.id,
    name: route.name,
    kind: route.kind,
    displayId: route.displayId,
    expectedRole: route.roleId,
    enabled: true,
    operatorPreview: route.operatorPreview
  }));
  return rendererInvoke(control, `
    return window.api.startPresentation({
      outputs: ${JSON.stringify(outputs)},
      decisions: {},
      preferredTimelineRoleId: 'front',
      settings: {
        fadeDuration: 0,
        syncMode: false,
        singerFontSize: 36,
        singerCharLimit: 70,
        singerTextPadding: 4
      }
    });
  `);
}


require('../../main');
app.whenReady().then(async () => {
  try {
    const evidence = process.env.SYNCSHOW_TEACHING_EVIDENCE;
    assert.equal(fs.realpathSync(app.getPath('userData')), fs.realpathSync(process.env.SYNCSHOW_TEST_USER_DATA_DIR));
    if (app.dock) app.dock.hide();
    const control = await waitFor(() => BrowserWindow.getAllWindows().find(w => w.webContents.getURL().endsWith('/index.html') && !w.webContents.isLoading()), 'control');
    await configureThreeOutputProfile(control);
    assert.equal((await createAndPublishService(control)).success, true);
    assert.equal((await startShow(control)).success, true);
    await waitFor(async () => (await rendererInvoke(control, 'return window.api.getShowState();')).phase === 'live', 'live Show');
    await rendererInvoke(control, 'return window.api.getRemoteState();');
    assert.ok(remote);
    await remote.startLoopback();
    const grant = remote.openPairing();
    const tablet = new BrowserWindow({ width: 1100, height: 1000, show: false, webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false } });
    tablet.webContents.on('console-message', (_event, _level, message) => { if (/Error|error/.test(message)) console.log('Remote console:', message); });
    await tablet.loadURL(remote.origin);
    tablet.showInactive();
    await rendererInvoke(tablet, `document.getElementById('deviceName').value='Teaching rehearsal'; document.getElementById('pairCode').value=${JSON.stringify(grant.code)}; document.getElementById('pairingForm').requestSubmit();`);
    await waitFor(() => rendererInvoke(tablet, "return !document.getElementById('showView').hidden"), 'paired browser');
    await rendererInvoke(tablet, "document.getElementById('teachingPanel').open=true;");
    const ready = () => waitFor(() => rendererInvoke(tablet, "return document.getElementById('teachingCanvasWrap').dataset.ready === 'true';"), 'teaching preview');
    await ready();
    const state = id => remote.teachingGateway.state(id || 'front-projector');
    assert.equal(state().available, true);
    assert.equal(state().outputs.length, 2, 'stage-facing output is excluded');
    const windows = BrowserWindow.getAllWindows().filter(w => /renderer\/display.html/.test(w.webContents.getURL()));
    const inkPixels = win => rendererInvoke(win, `const canvas=document.querySelector('.teaching-ink'); if (!canvas) return 0; const data=canvas.getContext('2d').getImageData(0,0,canvas.width,canvas.height).data; let count=0; for(let i=3;i<data.length;i+=4) if(data[i]) count++; return count;`);
    async function draw() {
      const box = await rendererInvoke(tablet, "const r=document.getElementById('teachingCanvas').getBoundingClientRect(); return {x:Math.round(r.x+r.width*.15),y:Math.round(r.y+r.height*.4),width:Math.round(r.width*.65)};");
      tablet.webContents.sendInputEvent({ type:'mouseDown', x:box.x, y:box.y, button:'left', clickCount:1 });
      for (let i=1; i<=12; i++) { tablet.webContents.sendInputEvent({ type:'mouseMove', x:Math.round(box.x+box.width*i/12), y:box.y }); await pause(25); }
      tablet.webContents.sendInputEvent({ type:'mouseUp', x:box.x+box.width, y:box.y, button:'left', clickCount:1 });
      await pause(350);
    }
    await draw(); await ready();
    assert.equal(state().frame.strokeCount, 1, 'actual pointer input reaches main-process ink');
    const painted = await Promise.all(windows.map(inkPixels));
    assert.equal(painted.filter(n => n > 100).length, 1, 'ink reaches selected output only');
    assert.equal(state('translation-projector').frame.strokeCount, 0);
    fs.writeFileSync(path.join(evidence,'tablet-teaching.png'), (await tablet.webContents.capturePage()).toPNG());
    fs.writeFileSync(path.join(evidence,'teaching-output.png'), (await windows[painted.findIndex(n => n>100)].webContents.capturePage()).toPNG());
    await rendererInvoke(tablet, "document.getElementById('teachingPenOnly').checked=true;");
    await draw(); assert.equal(state().frame.strokeCount, 1, 'stylus-only rejects real mouse drawing');
    await rendererInvoke(tablet, "document.getElementById('teachingPenOnly').checked=false; document.getElementById('teachingTool').value='highlight'; document.getElementById('teachingColor').value='#eab308';");
    await draw(); await ready(); assert.equal(state().frame.strokeCount, 2);
    await rendererInvoke(tablet, "document.getElementById('teaching-undo').click();");
    await waitFor(() => state().frame.strokeCount === 1, 'undo'); await ready();
    const first = state().frame.surfaceId;
    await rendererInvoke(tablet, "document.getElementById('btnNext').click();");
    await waitFor(() => state().frame.surfaceId !== first && state().available, 'next'); await ready();
    assert.equal(state().frame.strokeCount, 0);
    await rendererInvoke(tablet, "document.getElementById('btnPrevious').click();");
    await waitFor(() => state().frame.strokeCount === 1, 'previous restores ink'); await ready();
    await rendererInvoke(tablet, "document.getElementById('btnClear').click();");
    await waitFor(() => !state().available, 'blackout');
    for (const win of windows) assert.equal(await rendererInvoke(win, "return getComputedStyle(document.querySelector('.teaching-ink')).display;"), 'none');
    await rendererInvoke(tablet, "document.getElementById('btnRestore').click();");
    await waitFor(() => state().available, 'restore'); await ready(); assert.equal(state().frame.strokeCount,1);
    await new Promise(resolve => { tablet.webContents.once('did-finish-load', resolve); tablet.reload(); });
    await waitFor(() => rendererInvoke(tablet, "return !document.getElementById('showView').hidden"), 'reconnect cookie');
    await rendererInvoke(tablet, "document.getElementById('teachingPanel').open=true;"); await ready();
    assert.equal(state().frame.strokeCount,1);
    await rendererInvoke(tablet, "document.getElementById('teaching-clear').click();");
    await waitFor(() => state().frame.strokeCount === 0, 'clear ink'); await ready();
    assert.ok((await Promise.all(windows.map(inkPixels))).every(n => n===0));
    await rendererInvoke(control, 'return window.api.endPresentation();');
    assert.equal(state().available,false);
    const result={passed:true,productionMainPreloadOutputRemote:true,isolatedProfile:true,loopbackOnly:true,
      checks:['paired browser and captured preview','actual pointer drawing reaches one output','stage output excluded','stylus-only rejects mouse','highlighter and Undo','cue navigation restores ink','Clear to black and Restore','browser reconnect','Clear ink','Show end'],
      limitations:['No physical tablet or stylus','Synthetic local service and displays','Source app, not packaged release']};
    fs.writeFileSync(path.join(evidence,'teaching.json'), JSON.stringify(result,null,2));
    console.log(JSON.stringify({...result,evidence})); app.exit(0);
  } catch(error) {
    console.error(error);
    console.log('Teaching state', remote?.teachingGateway.state('front-projector'));
    for (const win of BrowserWindow.getAllWindows()) {
      console.log('Window diagnostic', win.webContents.getURL(), await rendererInvoke(win, "return {status:document.getElementById('teachingStatus')?.textContent,canvas:!!document.querySelector('.teaching-ink'),api:!!window.api?.onTeachingFrame,output:document.getElementById('teachingOutput')?.value,ready:document.getElementById('teachingCanvasWrap')?.dataset.ready};"));
    }
    app.exit(1);
  }
});
