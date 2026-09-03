'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const mainSource = fs.readFileSync(path.join(root, 'main.js'), 'utf8');

function functionSource(name) {
  const markers = [`function ${name}(`, `async function ${name}(`];
  const start = markers
    .map(marker => mainSource.indexOf(marker))
    .filter(index => index >= 0)
    .sort((left, right) => left - right)[0];
  assert.notEqual(start, undefined, `${name} must exist`);
  const tail = mainSource.slice(start + 1);
  const next = tail.match(/\n(?:async\s+)?function\s+[A-Za-z_$][\w$]*\s*\(/u);
  return mainSource.slice(
    start,
    next ? start + 1 + next.index : mainSource.length
  );
}

const lifecycleSource = [
  functionSource('sealActivePowerPointShowReceipt'),
  functionSource('prunePostShowPowerPointServiceReceipts'),
  functionSource('holdPostShowPowerPointServiceReceipt'),
  functionSource('finalizePowerPointServiceHandoff'),
  functionSource('sameCurrentServiceCompanionBinding'),
  `
    globalThis.lifecycleExports = {
      sealActivePowerPointShowReceipt,
      finalizePowerPointServiceHandoff
    };
  `
].join('\n');

function lifecycleHarness() {
  const launchPlan = Object.freeze({
    timelineRoleId: 'english',
    totalSlides: 12,
    outputs: Object.freeze([
      Object.freeze({
        id: 'main',
        renderer: 'slides',
        sourceRoleId: 'english'
      })
    ])
  });
  const claim = Object.freeze({
    serviceSetId: '2026-07-27-main',
    roleAssets: Object.freeze([
      Object.freeze({
        roleId: 'english',
        assetId: `sha256:${'a'.repeat(64)}`
      })
    ])
  });
  const binding = Object.freeze({
    id: '2026-07-27-main',
    fingerprint: 'b'.repeat(64),
    serviceDate: '2026-07-27',
    profileId: 'main-sanctuary'
  });
  const context = {
    POST_SHOW_POWERPOINT_RECEIPT_LIMIT: 12,
    POST_SHOW_POWERPOINT_RECEIPT_TTL_MS: 15 * 60 * 1000,
    activePowerPointShowReceipt: null,
    activeVenueProfile: { id: binding.profileId },
    appState: { activeLaunchPlan: launchPlan },
    crypto,
    outputLifecyclePhase: 'live',
    outputSessionId: 41,
    postShowPowerPointServiceReceipts: new Map(),
    presentationRevision: 9,
    reboundBinding: binding,
    verificationHook: null
  };
  context.verifiedPowerPointServiceSetBinding = async () => {
    if (typeof context.verificationHook === 'function') {
      await context.verificationHook();
    }
    return context.reboundBinding;
  };

  vm.runInNewContext(lifecycleSource, context, {
    filename: 'powerpoint-post-show-lifecycle.js'
  });

  const candidate = Object.freeze({
    claim,
    binding,
    launchPlan,
    presentationRevision: context.presentationRevision,
    profileId: binding.profileId
  });
  const receipt = context.lifecycleExports
    .sealActivePowerPointShowReceipt(candidate, context.outputSessionId);
  assert.ok(receipt, 'the live exact candidate must seal before End');
  assert.equal(context.activePowerPointShowReceipt, receipt);

  return {
    binding,
    context,
    receipt,
    async endAtNextSession() {
      const endedOutputSessionId = receipt.outputSessionId + 1;
      context.appState.activeLaunchPlan = null;
      context.outputSessionId = endedOutputSessionId;
      return context.lifecycleExports.finalizePowerPointServiceHandoff(
        receipt,
        endedOutputSessionId
      );
    }
  };
}

test('clean N to N+1 End stores one exact post-show receipt', async () => {
  const harness = lifecycleHarness();

  const publicReceipt = await harness.endAtNextSession();

  assert.ok(publicReceipt);
  assert.equal(publicReceipt.receiptToken, harness.receipt.receiptToken);
  assert.equal(publicReceipt.serviceDate, harness.binding.serviceDate);
  assert.match(publicReceipt.expiresAt, /^\d{4}-\d{2}-\d{2}T/u);
  assert.equal(harness.context.postShowPowerPointServiceReceipts.size, 1);
  assert.equal(
    harness.context.postShowPowerPointServiceReceipts
      .get(publicReceipt.receiptToken)
      .binding.fingerprint,
    harness.binding.fingerprint
  );
});

test('a concurrent session advance from N+1 to N+2 stores no receipt', async () => {
  const harness = lifecycleHarness();
  harness.context.verificationHook = async () => {
    harness.context.outputSessionId = harness.receipt.outputSessionId + 2;
  };

  const publicReceipt = await harness.endAtNextSession();

  assert.equal(publicReceipt, null);
  assert.equal(harness.context.postShowPowerPointServiceReceipts.size, 0);
});

test('presentation revision drift during End-time verification stores no receipt', async () => {
  const harness = lifecycleHarness();
  harness.context.verificationHook = async () => {
    harness.context.presentationRevision += 1;
  };

  const publicReceipt = await harness.endAtNextSession();

  assert.equal(publicReceipt, null);
  assert.equal(harness.context.postShowPowerPointServiceReceipts.size, 0);
});

test('venue profile drift during End-time verification stores no receipt', async () => {
  const harness = lifecycleHarness();
  harness.context.verificationHook = async () => {
    harness.context.activeVenueProfile = { id: 'chapel' };
  };

  const publicReceipt = await harness.endAtNextSession();

  assert.equal(publicReceipt, null);
  assert.equal(harness.context.postShowPowerPointServiceReceipts.size, 0);
});

test('a rebound ServiceSet fingerprint mismatch stores no receipt', async () => {
  const harness = lifecycleHarness();
  harness.context.reboundBinding = Object.freeze({
    ...harness.binding,
    fingerprint: 'c'.repeat(64)
  });

  const publicReceipt = await harness.endAtNextSession();

  assert.equal(publicReceipt, null);
  assert.equal(harness.context.postShowPowerPointServiceReceipts.size, 0);
});
