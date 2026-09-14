'use strict';

const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const root = path.resolve(__dirname, '..');
const main = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
const preload = fs.readFileSync(path.join(root, 'preload.js'), 'utf8');
const app = fs.readFileSync(path.join(root, 'src', 'renderer', 'app.js'), 'utf8');
const html = fs.readFileSync(path.join(root, 'src', 'renderer', 'index.html'), 'utf8');

test('Prepare embeds the connected Community server as its shared planner source', () => {
  assert.match(main, /currentCommunityConnectionSummary\(\{\s*refreshCapabilities: true\s*\}\)/u);
  assert.match(main, /parsed\.pathname = '\/admin\/plan-service'/u);
  assert.match(main, /const plannerUrl = safeCommunityPlannerUrl\(connection\.baseUrl\)/u);
  assert.match(main, /const planner = new WebContentsView/u);
  assert.match(main, /controlWindow\.contentView\.addChildView\(planner\)/u);
  assert.match(main, /await planner\.webContents\.loadURL\(plannerUrl\.href\)/u);
  assert.match(html, /id="communityPlannerViewport"/u);
  assert.doesNotMatch(
    main,
    /openCommunityPlannerWindow\([^)]*url/u,
    'the renderer must not choose an arbitrary planner URL'
  );
});

test('embedded Community planner keeps Electron privileges and navigation locked down', () => {
  assert.match(main, /nodeIntegration: false/u);
  assert.match(main, /contextIsolation: true/u);
  assert.match(main, /sandbox: true/u);
  assert.match(main, /partition: 'syncshow-community-planner'/u);
  assert.doesNotMatch(main, /partition: 'persist:syncshow-community-planner'/u);
  assert.match(main, /setPermissionRequestHandler\([\s\S]*callback\(false\)/u);
  assert.match(main, /setPermissionCheckHandler\(\(\) => false\)/u);
  assert.match(main, /setWindowOpenHandler\(\(\) => \(\{ action: 'deny' \}\)\)/u);
  assert.match(main, /connection\.canReadServiceDocuments !== true[\s\S]*connection\.canWriteServiceDocuments !== true/u);
  assert.match(main, /connectionStore\.getConnection\(connection\.id\)/u);
  assert.match(main, /target\.origin !== plannerOrigin \|\| !serviceDocumentApi/u);
  assert.match(main, /target\.pathname === '\/api\/community\/service-documents'/u);
  assert.match(main, /target\.pathname\.startsWith\('\/api\/community\/service-documents\/'\)/u);
  assert.match(main, /requestHeaders\.Authorization = `SyncShow \$\{accessToken\}`/u);
  assert.match(main, /webRequest\.onBeforeSendHeaders\(null\)/u);
  assert.doesNotMatch(main, /executeJavaScript\([\s\S]{0,300}accessToken/u);
  assert.match(main, /if \(targetOrigin !== plannerOrigin\) event\.preventDefault\(\)/u);
  assert.match(main, /on\('will-redirect', preventUntrustedPlannerNavigation\)/u);
  assert.match(main, /parsed\.protocol !== 'https:'/u);
  assert.match(main, /parsed\.protocol === 'http:' && loopback/u);
  assert.match(main, /if \(parsed\.username \|\| parsed\.password\)/u);
});

test('renderer receives only narrow planner open and status capabilities', () => {
  assert.match(preload, /openCommunityPlanner: \(\) => ipcRenderer\.invoke\('community:planner:open'\)/u);
  assert.match(preload, /getCommunityPlannerState: \(\) => ipcRenderer\.invoke\('community:planner:state'\)/u);
  assert.match(preload, /onCommunityPlannerState: \(callback\) =>/u);
  assert.match(preload, /layoutCommunityPlanner: \(request = \{\}\) => ipcRenderer\.invoke\('community:planner:layout'/u);
  assert.match(main, /ipcMain\.handle\('community:planner:open'/u);
  assert.match(main, /ipcMain\.handle\('community:planner:state'/u);
  assert.match(main, /ipcMain\.handle\('community:planner:layout'/u);
  assert.match(main, /bounds\.width < 640 \|\| bounds\.height < 420/u);
  assert.match(app, /elements\.communityPlannerViewport\.getBoundingClientRect\(\)/u);
});

test('closing Community Prepare clears the stale open status', () => {
  assert.match(
    app,
    /const wasOpen = state\.community\.plannerOpen;[\s\S]*?wasOpen && !state\.community\.plannerOpen[\s\S]*?setStatus\('Community Prepare closed'\)/u
  );
});

test('Prepare offers explicit shared and offline workspaces without a computer password', () => {
  assert.match(html, /Uses only your Heritage Community admin account[^<]*never the computer.s system password/u);
  assert.match(html, /id="btnPrepareModeCommunity"[\s\S]*Heritage Community/u);
  assert.match(html, /id="btnPrepareModeLocal"[\s\S]*This computer[\s\S]*Works offline/u);
  assert.match(app, /const requestedMode = activationOptions\?\.localTools === true[\s\S]*communityIsConnected\(\)[\s\S]*: 'local'/u);
  assert.match(app, /if \(local\) \{[\s\S]*prepareController\?\.activate/u);
  assert.match(app, /return openCommunityPrepare\(\)/u);
});
