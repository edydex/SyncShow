'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const electronPath = require('electron');

const RESULT_FILE = 'native-weekly-electron-rehearsal.json';
const MAX_CHILD_LOG_BYTES = 256 * 1024;
const TIMEOUT_MS = 180_000;
const RESOLUTION_MATRIX = Object.freeze([
  Object.freeze({ width: 640, height: 360, label: 'supported minimum' }),
  Object.freeze({ width: 1920, height: 1080, label: 'standard 1080p' })
]);
const DERIVED_SINGER_NEXT_STATES = Object.freeze([
  'text',
  'text',
  'text',
  'blank',
  'text',
  'text',
  'text',
  'blank',
  'end'
]);
const SERMON_READING_OUTPUTS = Object.freeze([
  Object.freeze({
    channelId: 'primary',
    mode: 'translation',
    translationId: 'BSB'
  }),
  Object.freeze({
    channelId: 'secondary',
    mode: 'translation',
    translationId: 'LSV'
  }),
  Object.freeze({
    channelId: 'media',
    mode: 'hidden'
  })
]);
const BSB_READING_BODY = [
  '10 His purpose was that now, through the church, the manifold wisdom of God should be made known to the rulers and authorities in the heavenly realms,',
  '11 according to the eternal purpose that He accomplished in Christ Jesus our Lord.',
  '12 In Him and through faith in Him we may enter God’s presence with boldness and confidence.'
].join('\n');
const LSV_READING_BODY = [
  '10 that there might be made known now to the principalities and the authorities in the heavenly [places], through the Assembly, the manifold wisdom of God,',
  '11 according to a purpose of the ages, which He made in Christ Jesus our Lord,',
  '12 in whom we have the freedom and the access in confidence through the faith of Him,'
].join('\n');
const BSB_READING_SHA256 =
  '96f81e43fa93a52726a565f8f26856ea99d0893d369beefbbe38ef3811273f08';
const LSV_READING_SHA256 =
  'a6b5b9fb98bfdeca7987e07fecb19dcba80092271e484e61b7021d24da642fb1';
const PRIMARY_SERMON_SOURCE_TEXT =
  'Церковь показывает Божью мудрость.';
const CONDENSED_SERMON_TEXT = 'The church displays God’s wisdom.';
const PRIMARY_SERMON_SHA256 =
  '2db805dd7a229966aa98e06734eacaffb757547826be655d95054a1fc509abef';
const CONDENSED_SERMON_SHA256 =
  '82d05e2e7a96464669a79d8af826d366ef04cfa3b53b4d67cb72810cc927cd60';

function verifyBibleOutputUnion(result, expectedOutputIds) {
  assert.deepEqual(result.bibleSourceOutputs, SERMON_READING_OUTPUTS);
  assert.deepEqual(result.bibleBodySha256ByRole, {
    front: BSB_READING_SHA256,
    translation: LSV_READING_SHA256,
    singers: null
  });
  assert.notEqual(
    result.bibleBodySha256ByRole.front,
    result.bibleBodySha256ByRole.translation
  );
  assert.deepEqual(
    result.bibleChecks.map(check => check.outputId),
    expectedOutputIds
  );
  const byOutputId = new Map(
    result.bibleChecks.map(check => [check.outputId, check])
  );
  const front = byOutputId.get('front-projector');
  const translation = byOutputId.get('translation-projector');
  assert.deepEqual({
    mode: front?.mode,
    translationId: front?.translationId,
    layout: front?.layout,
    bodyText: front?.bodyText,
    bodySha256: front?.bodySha256
  }, {
    mode: 'translation',
    translationId: 'BSB',
    layout: 'text',
    bodyText: BSB_READING_BODY,
    bodySha256: BSB_READING_SHA256
  });
  assert.deepEqual({
    mode: translation?.mode,
    translationId: translation?.translationId,
    layout: translation?.layout,
    bodyText: translation?.bodyText,
    bodySha256: translation?.bodySha256
  }, {
    mode: 'translation',
    translationId: 'LSV',
    layout: 'text',
    bodyText: LSV_READING_BODY,
    bodySha256: LSV_READING_SHA256
  });
  assert.notEqual(front.bodyText, translation.bodyText);
  for (const check of [front, translation]) {
    assert.equal(check.cueIndex, 5);
    assert.ok(check.bodyScrollWidth <= check.bodyClientWidth + 2);
    assert.ok(check.bodyScrollHeight <= check.bodyClientHeight + 2);
  }
  if (expectedOutputIds.includes('singers-monitor')) {
    assert.deepEqual(byOutputId.get('singers-monitor'), {
      outputId: 'singers-monitor',
      cueIndex: 5,
      mode: 'hidden',
      translationId: null,
      layout: 'blank',
      bodyText: '',
      bodySha256: null
    });
  } else {
    assert.equal(byOutputId.has('singers-monitor'), false);
  }
}

function verifySermonOutputUnion(result, expectedOutputIds) {
  assert.equal(result.sermonCueIndex, 6);
  assert.deepEqual(
    result.sermonChecks.map(check => check.outputId),
    expectedOutputIds
  );
  const byOutputId = new Map(
    result.sermonChecks.map(check => [check.outputId, check])
  );
  assert.deepEqual(byOutputId.get('front-projector'), {
    outputId: 'front-projector',
    cueIndex: 6,
    mode: 'exact',
    layout: 'text',
    bodyText: PRIMARY_SERMON_SOURCE_TEXT,
    bodySha256: PRIMARY_SERMON_SHA256
  });
  assert.deepEqual(byOutputId.get('translation-projector'), {
    outputId: 'translation-projector',
    cueIndex: 6,
    mode: 'condensed',
    layout: 'text',
    bodyText: CONDENSED_SERMON_TEXT,
    bodySha256: CONDENSED_SERMON_SHA256
  });
  if (expectedOutputIds.includes('singers-monitor')) {
    assert.deepEqual(byOutputId.get('singers-monitor'), {
      outputId: 'singers-monitor',
      cueIndex: 6,
      mode: 'hidden',
      layout: 'blank',
      bodyText: '',
      bodySha256: null
    });
  } else {
    assert.equal(byOutputId.has('singers-monitor'), false);
  }
}

function boundedCollector(stream) {
  let value = '';
  stream.setEncoding('utf8');
  stream.on('data', chunk => {
    value = `${value}${chunk}`;
    if (Buffer.byteLength(value, 'utf8') > MAX_CHILD_LOG_BYTES) {
      value = value.slice(-MAX_CHILD_LOG_BYTES);
    }
  });
  return () => value;
}

function runElectron({
  profilePath,
  resultPath,
  width,
  height,
  route = 'direct'
}) {
  const entryPath = path.resolve(
    __dirname,
    'fixtures/native-weekly-electron-rehearsal-app.js'
  );
  const childEnvironment = { ...process.env };
  delete childEnvironment.ELECTRON_RUN_AS_NODE;
  childEnvironment.SYNCSHOW_TEST_USER_DATA_DIR = profilePath;
  childEnvironment.SYNCSHOW_ELECTRON_REHEARSAL_RESULT = resultPath;
  childEnvironment.SYNCSHOW_ELECTRON_REHEARSAL_WIDTH = String(width);
  childEnvironment.SYNCSHOW_ELECTRON_REHEARSAL_HEIGHT = String(height);
  childEnvironment.SYNCSHOW_ELECTRON_REHEARSAL_ROUTE = route;
  childEnvironment.ELECTRON_DISABLE_SECURITY_WARNINGS = 'true';

  return new Promise((resolve, reject) => {
    const child = spawn(electronPath, [
      entryPath,
      '--syncshow-test-user-data',
      '--headless'
    ], {
      cwd: path.resolve(__dirname, '..'),
      env: childEnvironment,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    const stdout = boundedCollector(child.stdout);
    const stderr = boundedCollector(child.stderr);
    let timedOut = false;
    let forceKill = null;
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      forceKill = setTimeout(() => {
        child.kill('SIGKILL');
      }, 5_000);
    }, TIMEOUT_MS);
    child.once('error', error => {
      clearTimeout(timeout);
      if (forceKill) clearTimeout(forceKill);
      reject(error);
    });
    child.once('close', (code, signal) => {
      clearTimeout(timeout);
      if (forceKill) clearTimeout(forceKill);
      resolve({
        code,
        signal,
        timedOut,
        stdout: stdout(),
        stderr: stderr()
      });
    });
  });
}

async function readElectronResult({
  child,
  resultPath,
  resolution,
  route
}) {
  let result = null;
  try {
    result = JSON.parse(await fs.readFile(resultPath, 'utf8'));
  } catch (error) {
    const detail = [
      `${route} ${resolution.width}×${resolution.height} Electron verifier exited `
        + `with code ${child.code} and signal ${child.signal || 'none'}.`,
      child.timedOut
        ? `It exceeded the ${TIMEOUT_MS / 1000}-second limit.`
        : '',
      child.stdout ? `stdout:\n${child.stdout}` : '',
      child.stderr ? `stderr:\n${child.stderr}` : '',
      `result error: ${error.message}`
    ].filter(Boolean).join('\n');
    throw new Error(detail);
  }

  if (child.code !== 0 || result.ok !== true) {
    throw new Error([
      `${route} ${resolution.width}×${resolution.height}: `
        + (result.error || `Electron verifier exited with code ${child.code}.`),
      result.stack || '',
      child.stdout ? `stdout:\n${child.stdout}` : '',
      child.stderr ? `stderr:\n${child.stderr}` : ''
    ].filter(Boolean).join('\n'));
  }
  return result;
}

function verifyElectronResult(result, resolution) {
  assert.equal(
    result.contract,
    'syncshow-native-weekly-real-electron-rehearsal-v2'
  );
  assert.equal(result.route, 'direct');
  assert.equal(result.isolatedProfile, true);
  assert.equal(result.physicalDisplayRoutingUsed, false);
  assert.equal(result.visibleWindowCount, 0);
  assert.equal(result.browserWindowCount, 3);
  assert.equal(result.width, resolution.width);
  assert.equal(result.height, resolution.height);
  assert.equal(result.cueCount, 9);
  assert.deepEqual(result.outputIds, [
    'front-projector',
    'translation-projector',
    'singers-monitor'
  ]);
  assert.equal(result.acknowledgementCount, 27);
  assert.equal(result.captureCount, 9);
  assert.equal(result.captureDigests.length, 9);
  assert.equal(new Set(result.captureDigests).size > 1, true);
  assert.ok(result.minimumCaptureBytes > 500);
  assert.equal(result.bibleCueIndex, 5);
  assert.equal(result.bibleChecks.length, 3);
  verifyBibleOutputUnion(result, [
    'front-projector',
    'translation-projector',
    'singers-monitor'
  ]);
  verifySermonOutputUnion(result, [
    'front-projector',
    'translation-projector',
    'singers-monitor'
  ]);
  if (resolution.width === 640 && resolution.height === 360) {
    assert.deepEqual(result.overflowProbe, {
      outputId: 'front-projector',
      cueIndex: 9001,
      error: 'Native cue text does not fit the selected preset',
      candidateRemoved: true
    });
  } else {
    assert.equal(result.overflowProbe, null);
  }
  assert.equal(result.receiptPersistedAndReopened, true);
  assert.equal(result.receiptRejectsDirectEvidence, null);
  assert.deepEqual(result.derivedSingerChecks, []);
  assert.deepEqual(result.derivedSingerNextStates, []);
}

function verifyDerivedSingerResult(result, resolution) {
  assert.equal(
    result.contract,
    'syncshow-native-weekly-real-electron-derived-singer-rehearsal-v2'
  );
  assert.equal(result.route, 'derived-singer');
  assert.equal(result.isolatedProfile, true);
  assert.equal(result.physicalDisplayRoutingUsed, false);
  assert.equal(result.visibleWindowCount, 0);
  assert.equal(result.browserWindowCount, 3);
  assert.equal(result.width, resolution.width);
  assert.equal(result.height, resolution.height);
  assert.equal(result.cueCount, 9);
  assert.deepEqual(result.outputIds, [
    'front-projector',
    'translation-projector',
    'singers-monitor'
  ]);
  assert.deepEqual(result.routes, [{
    outputId: 'front-projector',
    sourceRoleId: 'front',
    renderer: 'native-cue',
    nativeVariant: null
  }, {
    outputId: 'translation-projector',
    sourceRoleId: 'translation',
    renderer: 'native-cue',
    nativeVariant: null
  }, {
    outputId: 'singers-monitor',
    sourceRoleId: 'front',
    renderer: 'native-cue',
    nativeVariant: 'singer-current-next'
  }]);
  assert.equal(result.acknowledgementCount, 27);
  assert.equal(result.captureCount, 9);
  assert.equal(result.captureDigests.length, 9);
  assert.equal(new Set(result.captureDigests).size, 9);
  assert.ok(result.minimumCaptureBytes > 500);
  assert.equal(result.bibleCueIndex, 5);
  verifyBibleOutputUnion(result, [
    'front-projector',
    'translation-projector'
  ]);
  verifySermonOutputUnion(result, [
    'front-projector',
    'translation-projector'
  ]);
  assert.equal(result.derivedSingerChecks.length, 9);
  assert.deepEqual(
    result.derivedSingerChecks.map(check => check.cueIndex),
    [0, 1, 2, 3, 4, 5, 6, 7, 8]
  );
  assert.deepEqual(
    result.derivedSingerChecks.map(check => check.outputId),
    Array(9).fill('singers-monitor')
  );
  assert.deepEqual(
    result.derivedSingerNextStates,
    DERIVED_SINGER_NEXT_STATES
  );
  assert.deepEqual(
    result.derivedSingerChecks.map(check => check.nextClass),
    DERIVED_SINGER_NEXT_STATES.map(state => `native-singer-${state}`)
  );
  assert.equal(
    result.derivedSingerChecks[0].next.text,
    'Церковь возносит хвалу Христу'
  );
  assert.equal(
    result.derivedSingerChecks[4].next.text,
    '10 His purpose was that now, through the church, the manifold wisdom of God should be made known to the rulers and authorities in the heavenly realms,'
  );
  assert.equal(
    result.derivedSingerChecks[6].next.text,
    'Во Христе мы с дерзновением приходим к Богу.'
  );
  assert.equal(result.derivedSingerChecks[3].next.text, '');
  assert.equal(result.derivedSingerChecks[7].next.text, '');
  assert.equal(result.derivedSingerChecks[8].next.text, '');
  assert.equal(result.overflowProbe, null);
  assert.equal(result.receiptPersistedAndReopened, true);
  assert.equal(result.receiptRejectsDirectEvidence, true);
}

async function runResolutionMatrix(temporaryRoot, route, verify) {
  const results = [];
  for (const resolution of RESOLUTION_MATRIX) {
    const profilePath = path.join(
      temporaryRoot,
      `profile-${route}-${resolution.width}x${resolution.height}`
    );
    const resultPath = path.join(profilePath, RESULT_FILE);
    await fs.mkdir(profilePath, { mode: 0o700 });
    const child = await runElectron({
      profilePath,
      resultPath,
      width: resolution.width,
      height: resolution.height,
      route
    });
    const result = await readElectronResult({
      child,
      resultPath,
      resolution,
      route
    });
    verify(result, resolution);
    results.push(result);
  }
  return results;
}

async function main() {
  const temporaryRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), 'syncshow-native-electron-rehearsal-')
  );
  try {
    const results = await runResolutionMatrix(
      temporaryRoot,
      'direct',
      verifyElectronResult
    );

    assert.equal(new Set(results.map(result => result.packageId)).size, 2);
    assert.equal(new Set(results.map(result => result.manifestSha256)).size, 2);
    const acknowledgementCount = results.reduce(
      (sum, result) => sum + result.acknowledgementCount,
      0
    );
    const captureCount = results.reduce(
      (sum, result) => sum + result.captureCount,
      0
    );
    assert.equal(acknowledgementCount, 54);
    assert.equal(captureCount, 18);

    console.log('Real Electron native weekly resolution matrix passed.');
    console.log(
      `Electron ${results[0].electronVersion} / Chromium `
      + `${results[0].chromeVersion}`
    );
    console.log(
      `${RESOLUTION_MATRIX.map(item => `${item.width}×${item.height}`).join(' + ')}; `
      + `9 cues × 3 hidden BrowserWindows × ${results.length} resolutions `
      + `= ${acknowledgementCount} sender-bound ACKs`
    );
    console.log(
      `${captureCount} rendered surface captures; exact generated reading `
      + 'proved as BSB on Front, LSV on Translation, and hidden on Singer; '
      + 'sermon text proved exact on Front, operator-condensed on Translation, '
      + 'and hidden on Singer; '
      + 'minimum-resolution overflow rejected; '
      + 'both exact rehearsal receipts persisted and reopened'
    );

    const derivedResults = await runResolutionMatrix(
      temporaryRoot,
      'derived-singer',
      verifyDerivedSingerResult
    );
    assert.equal(
      new Set(derivedResults.map(result => result.packageId)).size,
      2
    );
    assert.equal(
      new Set(derivedResults.map(result => result.manifestSha256)).size,
      2
    );
    const derivedAcknowledgementCount = derivedResults.reduce(
      (sum, result) => sum + result.acknowledgementCount,
      0
    );
    const derivedCaptureCount = derivedResults.reduce(
      (sum, result) => sum + result.captureCount,
      0
    );
    assert.equal(derivedAcknowledgementCount, 54);
    assert.equal(derivedCaptureCount, 18);

    console.log('Real Electron derived Singer resolution matrix passed.');
    console.log(
      `${RESOLUTION_MATRIX.map(item => `${item.width}×${item.height}`).join(' + ')}; `
      + `9 cues × 3 hidden BrowserWindows × ${derivedResults.length} resolutions `
      + `= ${derivedAcknowledgementCount} sender-bound ACKs`
    );
    console.log(
      `${derivedCaptureCount} derived Singer captures; exact current/next `
      + 'text, blank, and end states; BSB/LSV package provenance retained; '
      + 'both route-bound receipts persisted and reopened'
    );

    const combinedAcknowledgementCount =
      acknowledgementCount + derivedAcknowledgementCount;
    const combinedCaptureCount = captureCount + derivedCaptureCount;
    const combinedReceiptCount = results.length + derivedResults.length;
    assert.equal(combinedAcknowledgementCount, 108);
    assert.equal(combinedCaptureCount, 36);
    assert.equal(combinedReceiptCount, 4);
    console.log(
      `Combined native matrices: ${combinedAcknowledgementCount} ACKs, `
      + `${combinedCaptureCount} captures, ${combinedReceiptCount} `
      + 'persisted/reopened receipts.'
    );
  } finally {
    await fs.rm(temporaryRoot, { recursive: true, force: true });
  }
}

if (require.main === module) {
  main().catch(error => {
    console.error(error instanceof Error ? error.stack : error);
    process.exitCode = 1;
  });
}

module.exports = {
  DERIVED_SINGER_NEXT_STATES,
  main,
  RESOLUTION_MATRIX,
  runElectron,
  verifyDerivedSingerResult,
  verifyElectronResult
};
