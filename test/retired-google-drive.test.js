'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const {scanServiceFolder, pinServiceSet, readCurrentServiceSet, checkSourceChanges} = require('../src/services/service-set');

test('Google Drive runtime, UI, OAuth bridge and build injection are retired', async () => {
  const main = await fs.readFile(path.join(root,'main.js'),'utf8');
  const preload = await fs.readFile(path.join(root,'preload.js'),'utf8');
  const html = await fs.readFile(path.join(root,'src/renderer/index.html'),'utf8');
  const renderer = await fs.readFile(path.join(root,'src/renderer/app.js'),'utf8');
  const manifest = JSON.parse(await fs.readFile(path.join(root,'package.json'),'utf8'));
  assert.doesNotMatch(main, /google-drive|GoogleDrive|ipcMain\.handle\('drive:/);
  assert.doesNotMatch(preload, /ipcRenderer\.(?:invoke|on)\('drive:|getDriveStatus|connectPrivateDrive/);
  assert.doesNotMatch(html, /Google Drive|google-drive|driveOAuth/);
  assert.doesNotMatch(renderer, /getDriveStatus|connectPrivateDrive|SyncShowGoogleDrive|state\.drive/);
  assert.match(html, /id="settingsTabPptx"/);
  assert.match(html, /Folder on this computer/);
  assert.ok(manifest.build.files.includes('!assets/google-drive-config.json'), 'Never package an old maintainer credential file');
  assert.equal(Object.keys(manifest.scripts).some(key=>key.includes('google-drive')),false);
  assert.equal(require('../src/services/service-set').pinRemoteServiceSet,undefined);
  await assert.rejects(fs.access(path.join(root,'src/services/google-drive/index.js')), {code:'ENOENT'});
});

test('local-folder pinning and old Drive-origin offline copies retain byte verification', async t => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(),'syncshow-retired-drive-'));
  t.after(()=>fs.rm(temp,{recursive:true,force:true}));
  const folder=path.join(temp,'source'), store=path.join(temp,'saved');
  await fs.mkdir(folder);
  await fs.writeFile(path.join(folder,'2026-10-18 English.pptx'),'saved presentation bytes');
  const scan=await scanServiceFolder({folderPath:folder,inputRoles:[{id:'english',label:'English',filenameMatchers:['english']}],requiredRoleIds:['english'],requestedDate:'2026-10-18'});
  const manifest=await pinServiceSet({scan,setId:scan.recommendedSetId,destinationRoot:store,profileId:'church',profileName:'Church'});
  assert.equal((await readCurrentServiceSet(store,{verifyAssets:true})).inputs.english.sha256,manifest.inputs.english.sha256);
  // Recreate the metadata format of a previously downloaded and pinned copy.
  manifest.source={type:'google-drive-private',locator:null};
  manifest.inputs.english.sourcePath=null;
  manifest.inputs.english.remote={fileId:'legacy-file-12345',resourceKey:null,version:null,mimeType:null,exportMimeType:null,sourceSize:null,checksumAlgorithm:null,checksum:null};
  await fs.writeFile(path.join(store,'current.json'),JSON.stringify(manifest));
  const restored=await readCurrentServiceSet(store,{verifyAssets:true});
  assert.equal(restored.inputs.english.sha256,manifest.inputs.english.sha256);
  assert.deepEqual(await checkSourceChanges(restored),[], 'A retired provider does not attempt a network refresh');
  await fs.writeFile(manifest.inputs.english.pinnedPath,'tampered presentation bytes');
  await assert.rejects(readCurrentServiceSet(store,{verifyAssets:true}));
});
