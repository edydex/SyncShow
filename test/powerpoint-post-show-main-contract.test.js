'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.join(__dirname, '..');
const mainSource = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
const preloadSource = fs.readFileSync(path.join(root, 'preload.js'), 'utf8');

function sourceBetween(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  assert.notEqual(start, -1, `${startMarker} must exist`);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.notEqual(end, -1, `${endMarker} must follow ${startMarker}`);
  return source.slice(start, end);
}

function functionSource(name, nextMarker = '\nfunction ') {
  const start = mainSource.indexOf(`function ${name}`);
  assert.notEqual(start, -1, `${name} must exist`);
  const next = mainSource.indexOf(nextMarker, start + 10);
  return mainSource.slice(start, next === -1 ? mainSource.length : next);
}

function asyncFunctionSource(name) {
  const start = mainSource.indexOf(`async function ${name}`);
  assert.notEqual(start, -1, `${name} must exist`);
  const tail = mainSource.slice(start + 10);
  const next = tail.match(/\n(?:async\s+)?function\s+[A-Za-z_$]/u);
  const end = next ? start + 10 + next.index : mainSource.length;
  return mainSource.slice(start, end);
}

test('PowerPoint provenance is main-owned, opaque, bounded, and path-free', () => {
  assert.match(mainSource, /bindVerifiedPowerPointServiceSet,/);
  assert.match(mainSource, /resolvePowerPointServiceSetClaim,/);
  assert.match(mainSource, /const POST_SHOW_POWERPOINT_RECEIPT_LIMIT = 12;/);
  assert.match(mainSource, /const POST_SHOW_POWERPOINT_RECEIPT_TTL_MS = 15 \* 60 \* 1000;/);
  assert.match(mainSource, /const postShowPowerPointServiceReceipts = new Map\(\);/);
  assert.match(mainSource, /let activePowerPointShowReceipt = null;/);

  const held = functionSource('holdPostShowPowerPointServiceReceipt');
  assert.match(held, /receiptToken: receipt\.receiptToken/);
  assert.match(held, /serviceDate: receipt\.binding\.serviceDate/);
  assert.match(held, /expiresAt: new Date\(expiresAt\)\.toISOString\(\)/);
  assert.doesNotMatch(
    held,
    /binding:|claim:|profileId:|fingerprint:|sourcePath|pinnedPath|cacheDir/u
  );
});

test('Start seals eligibility only after every first frame is live', () => {
  const start = sourceBetween(
    mainSource,
    "ipcMain.handle('display:start'",
    "ipcMain.handle('display:stop'"
  );
  const resolveIndex = start.indexOf('const launchPlan = resolveLaunchPlan(');
  const candidateIndex = start.indexOf(
    'await capturePowerPointServiceSetCandidate(launchPlan)'
  );
  const destroyIndex = start.indexOf('destroyOutputWindows();');
  const firstFramesIndex = start.indexOf('await Promise.all(initialFramePromises)');
  const liveIndex = start.indexOf("outputLifecyclePhase = 'live';");
  const sealIndex = start.indexOf(
    'sealActivePowerPointShowReceipt(powerPointServiceCandidate, sessionId)'
  );
  assert.ok(resolveIndex >= 0);
  assert.ok(candidateIndex > resolveIndex);
  assert.ok(destroyIndex > candidateIndex);
  assert.ok(firstFramesIndex > destroyIndex);
  assert.ok(liveIndex > firstFramesIndex);
  assert.ok(sealIndex > liveIndex);

  const seal = functionSource('sealActivePowerPointShowReceipt');
  assert.match(seal, /outputLifecyclePhase !== 'live'/);
  assert.match(seal, /sessionId !== outputSessionId/);
  assert.match(seal, /appState\.activeLaunchPlan !== candidate\.launchPlan/);
  assert.match(seal, /presentationRevision !== candidate\.presentationRevision/);
  assert.match(seal, /crypto\.randomBytes\(24\)\.toString\('base64url'\)/);
});

test('Back destroys outputs before any End-time verification and binds one exact session', () => {
  const end = sourceBetween(
    mainSource,
    "ipcMain.handle('display:endSession'",
    "ipcMain.handle('display:setFade'"
  );
  const captureIndex = end.indexOf(
    'const endedPowerPointShowReceipt = activePowerPointShowReceipt'
  );
  const destroyIndex = end.indexOf('destroyOutputWindows();');
  const boundaryIndex = end.indexOf('const endedOutputSessionId = outputSessionId;');
  const verifyIndex = end.indexOf('await finalizePowerPointServiceHandoff(');
  assert.ok(captureIndex >= 0);
  assert.ok(destroyIndex > captureIndex);
  assert.ok(boundaryIndex > destroyIndex);
  assert.ok(verifyIndex > boundaryIndex);
  assert.doesNotMatch(end.slice(captureIndex, destroyIndex), /\bawait\b/u);
  assert.match(end, /powerPointServiceHandoff/);

  const destroy = functionSource('destroyOutputWindows');
  assert.match(destroy, /activePowerPointShowReceipt = null;/);

  const finalize = asyncFunctionSource('finalizePowerPointServiceHandoff');
  assert.match(
    finalize,
    /receipt\.outputSessionId \+ 1 !== endedOutputSessionId/
  );
  assert.match(finalize, /Number\.isSafeInteger\(receipt\.outputSessionId\)/);
  assert.match(finalize, /presentationRevision !== receipt\.presentationRevision/g);
  assert.match(finalize, /outputSessionId !== endedOutputSessionId/g);
  assert.match(finalize, /appState\.activeLaunchPlan !== null/g);
  assert.match(finalize, /await verifiedPowerPointServiceSetBinding\(/);
  assert.match(
    finalize,
    /sameCurrentServiceCompanionBinding\(binding, receipt\.binding\)/
  );
});

test('End and receipt redemption both hash-verify the captured exact current ServiceSet', () => {
  const verify = asyncFunctionSource('verifiedPowerPointServiceSetBinding');
  assert.match(
    verify,
    /readCurrentServiceSet\(getServiceSetRoot\(\), \{\s*verifyAssets: true\s*\}\)/
  );
  assert.match(verify, /serviceSetFingerprint\(manifest\)/);
  assert.match(verify, /bindVerifiedPowerPointServiceSet\(\{/);

  const handler = sourceBetween(
    mainSource,
    "'prepare:projects:inspectPostShowPowerPointService'",
    "'prepare:projects:openCurrentServiceCompanion'"
  );
  assert.match(handler, /currentServiceCompanionIpcResult\(async \(\) => \{/);
  assert.match(handler, /requireControlSender\(event\)/);
  assert.match(
    handler,
    /requireExactPrepareKeys\(\s*request,\s*\['receiptToken'\]/
  );
  assert.match(
    handler,
    /requirePostShowPowerPointServiceReceipt\(request\.receiptToken\)/
  );
  assert.match(handler, /await inspectCurrentServiceCompanionContext\(\)/);
  assert.match(handler, /claim: receipt\.claim/);
  assert.match(handler, /manifest: context\.manifest/);
  assert.match(handler, /fingerprint: context\.fingerprint/);
  assert.match(
    handler,
    /sameCurrentServiceCompanionBinding\(rebound, receipt\.binding\)/
  );
  assert.match(handler, /inspectedCurrentServiceCompanionSummary\(/);
});

test('companion IPC preserves typed error codes and preload grants no identity authority', () => {
  const inspect = sourceBetween(
    mainSource,
    "'prepare:projects:inspectCurrentServiceCompanion'",
    "'prepare:projects:inspectPostShowPowerPointService'"
  );
  const open = sourceBetween(
    mainSource,
    "'prepare:projects:openCurrentServiceCompanion'",
    'function failCurrentServiceSongDraft'
  );
  assert.match(inspect, /currentServiceCompanionIpcResult\(async \(\) => \{/);
  assert.match(open, /currentServiceCompanionIpcResult\(async \(\) => \{/);
  assert.match(
    asyncFunctionSource('currentServiceCompanionIpcResult'),
    /success: false,\s*error: publicCurrentServiceCompanionError\(error\)/
  );

  assert.match(
    preloadSource,
    /inspectPostShowPowerPointService: \(request = \{\}\) => ipcRenderer\.invoke\(\s*'prepare:projects:inspectPostShowPowerPointService',\s*\{ receiptToken: request\?\.receiptToken \}\s*\)/
  );
  const preloadHandoff = sourceBetween(
    preloadSource,
    'inspectPostShowPowerPointService:',
    'openCurrentServiceCompanion:'
  );
  assert.doesNotMatch(
    preloadHandoff,
    /serviceSetId|fingerprint|profileId|sourcePath|pinnedPath|serviceDate/u
  );
});
