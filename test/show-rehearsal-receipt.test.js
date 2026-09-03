'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  MAX_SHOW_REHEARSAL_ASSETS,
  MAX_SHOW_REHEARSAL_CUES,
  MAX_SHOW_REHEARSAL_OUTPUTS,
  MAX_SHOW_REHEARSAL_RECEIPT_BYTES,
  SHOW_REHEARSAL_RECEIPT_KIND,
  SHOW_REHEARSAL_RECEIPT_SCHEMA_VERSION,
  ShowRehearsalReceiptError,
  assertShowRehearsalReceiptMatches,
  normalizeShowRehearsalEvidence,
  normalizeShowRehearsalReceipt,
  parseShowRehearsalReceipt,
  serializeShowRehearsalReceipt,
  showRehearsalReceiptMatches
} = require('../src/services/show');

const HASHES = Object.freeze({
  package: '1'.repeat(64),
  manifest: '2'.repeat(64),
  primary: '3'.repeat(64),
  picture: '4'.repeat(64),
  venue: '5'.repeat(64),
  serviceSet: '6'.repeat(64),
  stage: '7'.repeat(64)
});

function clone(value) {
  return structuredClone(value);
}

function nativeReceipt() {
  return {
    schemaVersion: SHOW_REHEARSAL_RECEIPT_SCHEMA_VERSION,
    kind: SHOW_REHEARSAL_RECEIPT_KIND,
    show: {
      kind: 'show-package',
      packageId: `show-${HASHES.package}`,
      manifestRevisionId: HASHES.manifest,
      assets: [
        {
          assetId: 'picture-welcome',
          revisionId: HASHES.picture
        },
        {
          assetId: 'channel-primary',
          revisionId: HASHES.primary
        }
      ]
    },
    venueProfile: {
      id: 'wotbc-sanctuary',
      revisionId: HASHES.venue
    },
    routing: [
      {
        outputId: 'stage',
        displayId: 'stage-display',
        decision: 'derive-next-text',
        sourceRoleId: 'primary',
        sourceAssetId: 'channel-primary',
        renderer: 'native-cue',
        nativeVariant: 'singer-current-next',
        operatorPreview: true
      },
      {
        outputId: 'front',
        displayId: 2,
        decision: 'direct',
        sourceRoleId: 'primary',
        sourceAssetId: 'channel-primary',
        renderer: 'native-cue',
        nativeVariant: null,
        operatorPreview: false
      }
    ],
    cueCount: 2,
    cueIds: [
      'cue-0123456789abcdef01234567',
      'cue-89abcdef0123456701234567'
    ],
    acknowledgements: [
      {
        cueId: 'cue-89abcdef0123456701234567',
        outputIds: ['stage', 'front']
      },
      {
        cueId: 'cue-0123456789abcdef01234567',
        outputIds: ['stage', 'front']
      }
    ]
  };
}

function serviceSetReceipt() {
  const receipt = nativeReceipt();
  receipt.show = {
    kind: 'service-set',
    serviceSetId: '2026-07-27-wotbc-1722100000000-ab12cd34',
    fingerprint: HASHES.serviceSet,
    assets: [
      {
        assetId: `sha256:${HASHES.stage}`,
        revisionId: HASHES.stage
      },
      {
        assetId: `sha256:${HASHES.primary}`,
        revisionId: HASHES.primary
      }
    ]
  };
  receipt.routing = [
    {
      outputId: 'stage',
      displayId: 3,
      decision: 'derive-next-text',
      sourceRoleId: 'primary',
      sourceAssetId: `sha256:${HASHES.primary}`,
      renderer: 'singer-current-next',
      nativeVariant: null,
      operatorPreview: true
    },
    {
      outputId: 'front',
      displayId: 2,
      decision: 'direct',
      sourceRoleId: 'primary',
      sourceAssetId: `sha256:${HASHES.primary}`,
      renderer: 'slides',
      nativeVariant: null,
      operatorPreview: false
    }
  ];
  return receipt;
}

function evidenceFor(receipt) {
  return {
    show: clone(receipt.show),
    venueProfile: clone(receipt.venueProfile),
    routing: clone(receipt.routing),
    cueCount: receipt.cueCount,
    cueIds: [...receipt.cueIds]
  };
}

function expectError(
  callback,
  code = 'INVALID_SHOW_REHEARSAL_RECEIPT',
  message
) {
  assert.throws(callback, error => {
    assert.ok(error instanceof ShowRehearsalReceiptError);
    assert.equal(error.code, code);
    return true;
  }, message);
}

test('normalizes a deterministic, deeply frozen exact native Show receipt', () => {
  const normalized = normalizeShowRehearsalReceipt(nativeReceipt());

  assert.deepEqual(
    normalized.show.assets.map(asset => asset.assetId),
    ['channel-primary', 'picture-welcome']
  );
  assert.deepEqual(
    normalized.routing.map(route => route.outputId),
    ['front', 'stage']
  );
  assert.deepEqual(
    normalized.acknowledgements.map(item => item.cueId),
    normalized.cueIds
  );
  assert.deepEqual(
    normalized.acknowledgements[0].outputIds,
    ['front', 'stage']
  );
  assert.ok(Object.isFrozen(normalized));
  assert.ok(Object.isFrozen(normalized.show.assets[0]));
  assert.ok(Object.isFrozen(normalized.routing[0]));
  assert.ok(Object.isFrozen(normalized.acknowledgements[0].outputIds));

  const source = serializeShowRehearsalReceipt(nativeReceipt());
  assert.equal(source, serializeShowRehearsalReceipt(normalized));
  assert.ok(source.endsWith('\n'));
  assert.deepEqual(parseShowRehearsalReceipt(source), normalized);
});

test('supports an exact PowerPoint ServiceSet and its content-addressed assets', () => {
  const normalized = normalizeShowRehearsalReceipt(serviceSetReceipt());

  assert.equal(normalized.show.kind, 'service-set');
  assert.equal(normalized.show.fingerprint, HASHES.serviceSet);
  assert.deepEqual(
    normalized.routing.map(route => [
      route.outputId,
      route.renderer,
      route.sourceAssetId
    ]),
    [
      ['front', 'slides', `sha256:${HASHES.primary}`],
      ['stage', 'singer-current-next', `sha256:${HASHES.primary}`]
    ]
  );
  assert.deepEqual(
    parseShowRehearsalReceipt(
      serializeShowRehearsalReceipt(normalized)
    ),
    normalized
  );
});

test('canonical parsing rejects altered bytes even when JSON meaning is valid', () => {
  const canonical = serializeShowRehearsalReceipt(nativeReceipt());
  const reordered = JSON.parse(canonical);
  reordered.acknowledgements.reverse();

  for (const source of [
    canonical.slice(0, -1),
    ` ${canonical}`,
    JSON.stringify(JSON.parse(canonical), null, 4),
    `${JSON.stringify(reordered, null, 2)}\n`
  ]) {
    expectError(
      () => parseShowRehearsalReceipt(source),
      'SHOW_REHEARSAL_RECEIPT_NONCANONICAL'
    );
  }
  expectError(
    () => parseShowRehearsalReceipt('{not-json}\n'),
    'INVALID_SHOW_REHEARSAL_RECEIPT'
  );
});

test('any exact Show, asset, venue, route, or cue mismatch invalidates a receipt', () => {
  const receipt = normalizeShowRehearsalReceipt(nativeReceipt());
  const current = evidenceFor(receipt);
  assert.equal(showRehearsalReceiptMatches(receipt, current), true);
  assert.deepEqual(
    assertShowRehearsalReceiptMatches(receipt, current),
    receipt
  );

  const mutations = [
    evidence => {
      evidence.show.packageId = `show-${'8'.repeat(64)}`;
    },
    evidence => {
      evidence.show.manifestRevisionId = '8'.repeat(64);
    },
    evidence => {
      evidence.show.assets[0].revisionId = '8'.repeat(64);
    },
    evidence => {
      evidence.venueProfile.id = 'other-sanctuary';
    },
    evidence => {
      evidence.venueProfile.revisionId = '8'.repeat(64);
    },
    evidence => {
      evidence.routing[0].displayId = 9;
    },
    evidence => {
      evidence.routing[0].decision = 'mirror';
    },
    evidence => {
      evidence.routing[0].sourceRoleId = 'secondary';
    },
    evidence => {
      evidence.routing[0].sourceAssetId = 'picture-welcome';
    },
    evidence => {
      evidence.routing[0].operatorPreview =
        !evidence.routing[0].operatorPreview;
    },
    evidence => {
      evidence.cueIds.reverse();
    }
  ];

  for (const mutate of mutations) {
    const changed = clone(current);
    mutate(changed);
    assert.equal(showRehearsalReceiptMatches(receipt, changed), false);
    expectError(
      () => assertShowRehearsalReceiptMatches(receipt, changed),
      'SHOW_REHEARSAL_RECEIPT_MISMATCH'
    );
  }

  const otherKind = evidenceFor(
    normalizeShowRehearsalReceipt(serviceSetReceipt())
  );
  expectError(
    () => assertShowRehearsalReceiptMatches(receipt, otherKind),
    'SHOW_REHEARSAL_RECEIPT_MISMATCH'
  );
});

test('every cue must acknowledge every active output exactly once', () => {
  const cases = [];

  const missingCue = nativeReceipt();
  missingCue.acknowledgements.pop();
  cases.push(missingCue);

  const duplicateCue = nativeReceipt();
  duplicateCue.acknowledgements[1].cueId =
    duplicateCue.acknowledgements[0].cueId;
  cases.push(duplicateCue);

  const unknownCue = nativeReceipt();
  unknownCue.acknowledgements[0].cueId = 'cue-unknown';
  cases.push(unknownCue);

  const missingOutput = nativeReceipt();
  missingOutput.acknowledgements[0].outputIds.pop();
  cases.push(missingOutput);

  const duplicateOutput = nativeReceipt();
  duplicateOutput.acknowledgements[0].outputIds = ['front', 'front'];
  cases.push(duplicateOutput);

  const unknownOutput = nativeReceipt();
  unknownOutput.acknowledgements[0].outputIds = ['front', 'removed'];
  cases.push(unknownOutput);

  const extraOutput = nativeReceipt();
  extraOutput.acknowledgements[0].outputIds.push('removed');
  cases.push(extraOutput);

  const extraCue = nativeReceipt();
  extraCue.acknowledgements.push({
    cueId: 'cue-extra',
    outputIds: ['front', 'stage']
  });
  cases.push(extraCue);

  for (const [index, candidate] of cases.entries()) {
    expectError(
      () => normalizeShowRehearsalReceipt(candidate),
      'INVALID_SHOW_REHEARSAL_RECEIPT',
      `acknowledgement candidate ${index}`
    );
  }
});

test('duplicates and unknown routing identities fail closed', () => {
  const duplicateAsset = nativeReceipt();
  duplicateAsset.show.assets[1].assetId =
    duplicateAsset.show.assets[0].assetId;

  const duplicateOutput = nativeReceipt();
  duplicateOutput.routing[1].outputId =
    duplicateOutput.routing[0].outputId;

  const duplicateDisplay = nativeReceipt();
  duplicateDisplay.routing[0].displayId = '2';
  duplicateDisplay.routing[1].displayId = 2;

  const unknownAsset = nativeReceipt();
  unknownAsset.routing[0].sourceAssetId = 'missing-asset';

  const duplicateCue = nativeReceipt();
  duplicateCue.cueIds[1] = duplicateCue.cueIds[0];

  for (const candidate of [
    duplicateAsset,
    duplicateOutput,
    duplicateDisplay,
    unknownAsset,
    duplicateCue
  ]) {
    expectError(() => normalizeShowRehearsalReceipt(candidate));
  }
});

test('closed records, dense arrays, and own data properties reject hidden input', () => {
  const candidates = [];

  const topExtra = nativeReceipt();
  topExtra.secret = 'no';
  candidates.push(topExtra);

  const showExtra = nativeReceipt();
  showExtra.show.path = '/private/service.pptx';
  candidates.push(showExtra);

  const assetExtra = nativeReceipt();
  assetExtra.show.assets[0].sourcePath = '/private/picture.png';
  candidates.push(assetExtra);

  const venueExtra = nativeReceipt();
  venueExtra.venueProfile.name = 'Unreviewed';
  candidates.push(venueExtra);

  const routeExtra = nativeReceipt();
  routeExtra.routing[0].sessionToken = 'secret';
  candidates.push(routeExtra);

  const acknowledgementExtra = nativeReceipt();
  acknowledgementExtra.acknowledgements[0].at = 'later';
  candidates.push(acknowledgementExtra);

  const arrayExtra = nativeReceipt();
  arrayExtra.cueIds.hidden = true;
  candidates.push(arrayExtra);

  const sparse = nativeReceipt();
  delete sparse.acknowledgements[0];
  candidates.push(sparse);

  const symbol = nativeReceipt();
  symbol.show[Symbol('hidden')] = true;
  candidates.push(symbol);

  const accessor = nativeReceipt();
  Object.defineProperty(accessor.routing[0], 'decision', {
    configurable: true,
    enumerable: true,
    get() {
      return 'direct';
    }
  });
  candidates.push(accessor);

  for (const candidate of candidates) {
    expectError(() => normalizeShowRehearsalReceipt(candidate));
  }

  const current = evidenceFor(nativeReceipt());
  current.extra = true;
  expectError(
    () => normalizeShowRehearsalEvidence(current),
    'INVALID_SHOW_REHEARSAL_EVIDENCE'
  );
  expectError(
    () => assertShowRehearsalReceiptMatches(nativeReceipt(), current),
    'SHOW_REHEARSAL_RECEIPT_MISMATCH'
  );
});

test('unsafe identities, digests, displays, and incompatible routes are rejected', () => {
  const cases = [];

  const poisonCue = nativeReceipt();
  poisonCue.cueIds[0] = '__proto__';
  cases.push(poisonCue);

  const unsafeSet = serviceSetReceipt();
  unsafeSet.show.serviceSetId = '../outside';
  cases.push(unsafeSet);

  const uppercaseDigest = nativeReceipt();
  uppercaseDigest.show.assets[0].revisionId = 'A'.repeat(64);
  cases.push(uppercaseDigest);

  for (const displayId of [
    ' leading-space',
    'line\nbreak',
    'e\u0301',
    '\ud800',
    -0,
    2.5,
    Number.MAX_SAFE_INTEGER
  ]) {
    const unsafeDisplay = nativeReceipt();
    unsafeDisplay.routing[0].displayId = displayId;
    cases.push(unsafeDisplay);
  }

  const packageRaster = nativeReceipt();
  packageRaster.routing[0].renderer = 'slides';
  cases.push(packageRaster);

  const packageMissingVariant = nativeReceipt();
  packageMissingVariant.routing[0].nativeVariant = null;
  cases.push(packageMissingVariant);

  const serviceNative = serviceSetReceipt();
  serviceNative.routing[0].renderer = 'native-cue';
  cases.push(serviceNative);

  const serviceWrongDerivedRenderer = serviceSetReceipt();
  serviceWrongDerivedRenderer.routing[0].renderer = 'slides';
  cases.push(serviceWrongDerivedRenderer);

  for (const [index, candidate] of cases.entries()) {
    expectError(
      () => normalizeShowRehearsalReceipt(candidate),
      'INVALID_SHOW_REHEARSAL_RECEIPT',
      `unsafe candidate ${index}`
    );
  }
});

test('receipt collections and canonical source bytes have hard limits', () => {
  const tooManyAssets = nativeReceipt();
  tooManyAssets.show.assets = Array.from(
    { length: MAX_SHOW_REHEARSAL_ASSETS + 1 },
    (_, index) => ({
      assetId: `asset-${index}`,
      revisionId: HASHES.primary
    })
  );
  expectError(() => normalizeShowRehearsalReceipt(tooManyAssets));

  const tooManyOutputs = nativeReceipt();
  tooManyOutputs.routing = Array.from(
    { length: MAX_SHOW_REHEARSAL_OUTPUTS + 1 },
    (_, index) => ({
      outputId: `output-${index}`,
      displayId: index,
      decision: 'direct',
      sourceRoleId: 'primary',
      sourceAssetId: 'channel-primary',
      renderer: 'native-cue',
      nativeVariant: null,
      operatorPreview: false
    })
  );
  expectError(() => normalizeShowRehearsalReceipt(tooManyOutputs));

  for (const cueCount of [0, MAX_SHOW_REHEARSAL_CUES + 1]) {
    const invalidCount = nativeReceipt();
    invalidCount.cueCount = cueCount;
    expectError(() => normalizeShowRehearsalReceipt(invalidCount));
  }

  const oversized = `"${'x'.repeat(MAX_SHOW_REHEARSAL_RECEIPT_BYTES)}"`;
  expectError(
    () => parseShowRehearsalReceipt(oversized),
    'SHOW_REHEARSAL_RECEIPT_TOO_LARGE'
  );
  expectError(
    () => parseShowRehearsalReceipt(Buffer.from('{}')),
    'INVALID_SHOW_REHEARSAL_RECEIPT'
  );
});
