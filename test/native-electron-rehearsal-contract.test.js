'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const {
  DERIVED_SINGER_NEXT_STATES,
  RESOLUTION_MATRIX
} = require('../scripts/verify-native-weekly-electron-rehearsal');

const fixtureSource = fs.readFileSync(path.join(
  __dirname,
  '../scripts/fixtures/native-weekly-electron-rehearsal-app.js'
), 'utf8');
const verifierSource = fs.readFileSync(path.join(
  __dirname,
  '../scripts/verify-native-weekly-electron-rehearsal.js'
), 'utf8');
const mainSource = fs.readFileSync(path.join(__dirname, '../main.js'), 'utf8');

test('real Electron native rehearsal locks the supported-minimum and 1080p matrix', () => {
  assert.deepEqual(
    RESOLUTION_MATRIX.map(({ width, height }) => ({ width, height })),
    [
      { width: 640, height: 360 },
      { width: 1920, height: 1080 }
    ]
  );
  assert.match(verifierSource, /assert\.equal\(acknowledgementCount, 54\)/);
  assert.match(verifierSource, /assert\.equal\(captureCount, 18\)/);
  assert.match(verifierSource, /new Set\(results\.map\(result => result\.packageId\)\)/);
  assert.match(
    verifierSource,
    /new Set\(results\.map\(result => result\.manifestSha256\)\)/
  );
});

test('real Electron native rehearsal proves the generated BSB, LSV, and hidden reading union plus fail-closed overflow', () => {
  assert.match(fixtureSource, /assert\.deepEqual\(bibleCueIndexes, \[5\]\)/);
  assert.match(
    fixtureSource,
    /96f81e43fa93a52726a565f8f26856ea99d0893d369beefbbe38ef3811273f08/
  );
  assert.match(
    fixtureSource,
    /a6b5b9fb98bfdeca7987e07fecb19dcba80092271e484e61b7021d24da642fb1/
  );
  assert.match(fixtureSource, /readingItem\.sermonReading\.outputs/);
  assert.match(fixtureSource, /translationId, 'BSB'/);
  assert.match(fixtureSource, /translationId, 'LSV'/);
  assert.match(fixtureSource, /singersBibleScene\.layout, 'blank'/);
  assert.match(fixtureSource, /packagedBibleCue\.sourceReference\.outputs/);
  assert.match(fixtureSource, /inspectRenderedBibleFrame/);
  assert.match(fixtureSource, /native-scene-blank/);
  assert.match(fixtureSource, /bodyScrollHeight <= metrics\.bodyClientHeight \+ 2/);
  assert.match(fixtureSource, /'Overflow '\.repeat\(1300\)/);
  assert.match(
    fixtureSource,
    /Native cue text does not fit the selected preset/
  );
  assert.match(fixtureSource, /candidateRemoved: true/);
  assert.match(
    verifierSource,
    /syncshow-native-weekly-real-electron-rehearsal-v2/
  );
  assert.match(verifierSource, /verifyBibleOutputUnion/);
  assert.match(verifierSource, /mode: 'hidden'/);
  assert.match(verifierSource, /outputId: 'front-projector'/);
});

test('real Electron native rehearsal proves exact, operator-condensed, and hidden sermon outputs', () => {
  assert.match(fixtureSource, /assert\.deepEqual\(sermonCueIndexes, \[6, 7\]\)/);
  assert.match(fixtureSource, /sourceBodyProjection\.schemaVersion, 2/);
  assert.match(fixtureSource, /channels\.secondary\.mode,\s*'condensed'/);
  assert.match(fixtureSource, /inspectRenderedSermonFrame/);
  assert.match(fixtureSource, /sermonTreatmentForRole/);
  assert.match(verifierSource, /The church displays God’s wisdom\./);
  assert.match(verifierSource, /verifySermonOutputUnion/);
  assert.match(verifierSource, /mode: 'exact'/);
  assert.match(verifierSource, /mode: 'condensed'/);
  assert.match(verifierSource, /mode: 'hidden'/);
});

test('derived Singer rehearsal stays route-distinct and locks both resolution totals', () => {
  assert.deepEqual(DERIVED_SINGER_NEXT_STATES, [
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
  assert.match(
    fixtureSource,
    /'singers-monitor': \{\s*mode: 'derive-next-text',\s*sourceRole: 'front'/
  );
  assert.match(fixtureSource, /resolveNativeCuePayload\(\{/);
  assert.match(fixtureSource, /inspectRenderedDerivedSingerFrame/);
  assert.match(fixtureSource, /receiptRejectsDirectEvidence/);
  assert.match(
    verifierSource,
    /assert\.equal\(derivedAcknowledgementCount, 54\)/
  );
  assert.match(verifierSource, /assert\.equal\(derivedCaptureCount, 18\)/);
  assert.match(
    verifierSource,
    /assert\.equal\(combinedAcknowledgementCount, 108\)/
  );
  assert.match(verifierSource, /assert\.equal\(combinedCaptureCount, 36\)/);
  assert.match(verifierSource, /assert\.equal\(combinedReceiptCount, 4\)/);
});

test('production Show uses the same fail-closed native payload resolver as rehearsal', () => {
  assert.match(
    mainSource,
    /resolveNativeCuePayload,\s*[\s\S]*\}\s*=\s*require\('\.\/src\/services\/show'\)/
  );
  const start = mainSource.indexOf('function getNativeCuePayload(');
  const end = mainSource.indexOf('\nfunction getSlideText(', start);
  assert.ok(start >= 0 && end > start);
  const resolver = mainSource.slice(start, end);
  assert.match(resolver, /return resolveNativeCuePayload\(\{/);
  assert.match(resolver, /presentation:\s*appState\.presentations\[roleId\]/);
  assert.match(resolver, /cueIndex:\s*slideIndex/);
  assert.match(resolver, /\bvariant\b/);
  assert.doesNotMatch(
    resolver,
    /deriveNativeSingerScene|nativeSceneSinger(?:Line|Next)|sceneAssetIds/
  );
});
