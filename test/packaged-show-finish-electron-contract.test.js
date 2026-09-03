'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const verifierPath = path.join(
  root,
  'scripts',
  'verify-packaged-show-finish-electron.js'
);
const fixturePath = path.join(
  root,
  'scripts',
  'fixtures',
  'live-cue-navigation-electron-app.js'
);
const preloadPath = path.join(
  root,
  'scripts',
  'fixtures',
  'packaged-live-cue-navigation-preload.js'
);
const verifierSource = fs.readFileSync(verifierPath, 'utf8');
const fixtureSource = fs.readFileSync(fixturePath, 'utf8');
const preloadSource = fs.readFileSync(preloadPath, 'utf8');
const {
  CONTRACT,
  FIXTURE_CONTRACT,
  assertPackagedFixtureResult,
  parseArguments
} = require('../scripts/verify-packaged-show-finish-electron');

function validOptions() {
  return [
    '--app', '/private/tmp/proof/SyncShow.app',
    '--package-proof', '/private/tmp/proof/package-proof.json',
    '--package-proof-sha256', 'a'.repeat(64),
    '--proof-root', '/private/tmp/evidence'
  ];
}

function validFixtureResult(paths, nonce) {
  return {
    ok: true,
    contract: FIXTURE_CONTRACT,
    profileIsolated: true,
    productionMainPreloadOutputRenderer: true,
    syntheticDisplayConfinedToFixture: true,
    fullscreenSuppressedForTest: true,
    cueCount: 4,
    outputCount: 3,
    outputRoutes: [
      {
        outputId: 'front-projector',
        displayId: 880_001,
        renderer: 'native-cue',
        sourceRoleId: 'front'
      },
      {
        outputId: 'translation-projector',
        displayId: 880_002,
        renderer: 'native-cue',
        sourceRoleId: 'translation'
      },
      {
        outputId: 'singers-monitor',
        displayId: 880_003,
        renderer: 'native-cue',
        sourceRoleId: 'singers'
      }
    ],
    packagedInstrumentation: {
      mode: 'node-options-browser-process-preload',
      nonceSha256: require('node:crypto')
        .createHash('sha256')
        .update(nonce)
        .digest('hex'),
      appIsPackaged: true,
      resourcesPath: path.join(paths.appPath, 'Contents', 'Resources'),
      appPath: paths.archivePath,
      executablePath: paths.executablePath,
      sourceMainImported: false,
      privilegedExternalInstrumentation: true,
      faultInjected: true,
      uninstrumentedPackageProof: false,
      physicalDisplayProof: false,
      fullscreenProof: false,
      venueProof: false,
      releaseProof: false
    },
    delayedAcknowledgement: {
      secondAdvanceRejected: true,
      committedAfterRelease: true
    },
    negativeAcknowledgement: {
      phase: 'interrupted',
      authoritativeCueRetained: true
    },
    clearAndLateAcknowledgement: { navigationApplied: false },
    restoreFromClear: { allRendererGuardsOpaqueBlackWhileReceiptHeld: true },
    restorePreemptedByClear: { lateFrameReceiptDidNotReveal: true },
    timeout: {
      timeoutMessageMatched: true,
      elapsedMs: 15_001,
      lateReceiptDidNotCommit: true
    },
    restoreAfterTimeout: { staleTimedOutCueReplacedOnEveryOutput: true },
    operatorFinish: {
      start: {
        before: { ready: true, handoffVisible: true },
        showStage: true,
        activeLaunchPlan: { outputs: [{}, {}, {}] }
      },
      routes: [
        {
          id: 'front-projector',
          displayId: 880_001,
          renderer: 'native-cue',
          sourceRoleId: 'front'
        },
        {
          id: 'translation-projector',
          displayId: 880_002,
          renderer: 'native-cue',
          sourceRoleId: 'translation'
        },
        {
          id: 'singers-monitor',
          displayId: 880_003,
          renderer: 'native-cue',
          sourceRoleId: 'singers'
        }
      ],
      advances: [{ targetIndex: 1 }, { targetIndex: 2 }, { targetIndex: 3 }],
      finalCueOutputStatuses: {
        'front-projector': 'healthy',
        'translation-projector': 'healthy',
        'singers-monitor': 'healthy'
      },
      finalCueAllOutputsVisible: true,
      finalCueWindowVisibilities: {
        'front-projector': true,
        'translation-projector': true,
        'singers-monitor': true
      },
      finalCueAllWindowsVisible: true,
      finalCueRenderedOnEveryOutput: true,
      button: { text: 'Finish service…', visible: true },
      afterFirstClick: {
        text: 'Finishing service…',
        ariaBusy: 'true',
        disabled: true,
        showEndSessionBusy: true
      },
      secondClickIssuedWhileDisabled: true,
      secondClickIssuedWhileBusy: true,
      synchronousDoubleClickBarrierObserved: true,
      load: {
        loadStage: true,
        dialogMode: 'native',
        dialogTitleFocused: true,
        handoffBadge: 'Ready'
      },
      showPhase: 'idle',
      outputSessionId: null,
      outputWindowCount: 0,
      projectStatus: 'ready',
      projectRevisionUnchanged: true,
      dialogClosed: true,
      loadFocusedAfterClose: true
    }
  };
}

test('packaged Show/Finish verifier requires exact absolute package inputs', () => {
  const parsed = parseArguments(validOptions());
  assert.equal(parsed.appPath, '/private/tmp/proof/SyncShow.app');
  assert.equal(parsed.packageProofSha256, 'a'.repeat(64));
  assert.throws(
    () => parseArguments(validOptions().slice(0, -2)),
    /Exactly four option\/value pairs/u
  );
  assert.throws(
    () => parseArguments([
      ...validOptions().slice(0, 6),
      '--proof-root', 'relative'
    ]),
    /must be an absolute path/u
  );
});

test('retired packaged preload remains test-only and is not treated as reachable', () => {
  assert.match(preloadSource, /process\.type === 'browser'/u);
  assert.match(
    preloadSource,
    /SYNCSHOW_PACKAGED_LIVE_CUE_INSTRUMENTATION === '1'/u
  );
  assert.match(preloadSource, /require\('\.\/live-cue-navigation-electron-app'\)/u);
  assert.doesNotMatch(preloadSource, /\.\.\/\.\.\/main/u);
  assert.match(fixtureSource, /if \(!PACKAGED_INSTRUMENTATION\) require\('\.\.\/\.\.\/main'\);/u);
  assert.match(fixtureSource, /assert\.equal\(process\.type, 'browser'\)/u);
  assert.match(fixtureSource, /assert\.equal\(app\.isPackaged, true\)/u);
  assert.match(fixtureSource, /sourceMainImported: false/u);
  assert.match(
    fixtureSource,
    /window\.api\.openServiceProject\(\{\s*projectId:[\s\S]*?\}\)/u
  );
  assert.doesNotMatch(
    fixtureSource,
    /window\.api\.openServiceProject\(\{\s*projectId:[\s\S]*?revisionId:/u
  );
  assert.match(verifierSource, /status: 'unsupported-not-launched'/u);
  assert.match(verifierSource, /packageLaunchAttempted: false/u);
  assert.match(verifierSource, /fixtureLoaded: false/u);
});

test('runner rechecks exact package, proof, source, harness, and fuses after cleanup even on failure', () => {
  assert.match(verifierSource, /resolvePackagedApp\(options\.appPath\)/u);
  assert.match(verifierSource, /resolvePackageProof\(/u);
  assert.match(verifierSource, /sourceClosureManifest\(\)/u);
  assert.match(verifierSource, /verifyHarnessFiles\(\)/u);
  assert.match(verifierSource, /const finalPaths = await resolvePackagedApp/u);
  assert.match(verifierSource, /assert\.deepEqual\(finalPaths\.bundleManifest, paths\.bundleManifest\)/u);
  assert.match(verifierSource, /assert\.deepEqual\(finalSourceClosure, sourceClosure\)/u);
  assert.match(verifierSource, /rehashHarness\(harness\)/u);
  assert.match(verifierSource, /fuseWireUnchanged = true/u);
  assert.match(verifierSource, /status: 'verified-unchanged'/u);
  assert.match(verifierSource, /status: 'not-run-cleanup-unproven'/u);
  const cleanupIndex = verifierSource.lastIndexOf('cleanupProfile(temp, launch)');
  const finalPathsIndex = verifierSource.lastIndexOf(
    'const finalPaths = await resolvePackagedApp'
  );
  assert.ok(cleanupIndex > 0);
  assert.ok(finalPathsIndex > cleanupIndex);
});

test('runner records all nine current fuses without claiming the fuse permits require', () => {
  for (const name of [
    'RunAsNode',
    'EnableCookieEncryption',
    'EnableNodeOptionsEnvironmentVariable',
    'EnableNodeCliInspectArguments',
    'EnableEmbeddedAsarIntegrityValidation',
    'OnlyLoadAppFromAsar',
    'LoadBrowserProcessSpecificV8Snapshot',
    'GrantFileProtocolExtraPrivileges',
    'WasmTrapHandlers'
  ]) assert.match(verifierSource, new RegExp(name, 'u'));
  assert.match(verifierSource, /releaseSecurityAccepted: false/u);
  assert.match(verifierSource, /requireAllowedInPackagedApp: false/u);
  assert.match(verifierSource, /fuseOverridesPackagedAllowlist: false/u);
  assert.match(verifierSource, /does not override Electron\\'s packaged-app NODE_OPTIONS allowlist/u);
  assert.doesNotMatch(verifierSource, /accept same-user NODE_OPTIONS preloading/u);
});

test('runner fails closed before the retired require can create a profile or launch a package', () => {
  assert.match(verifierSource, /environment\.NODE_OPTIONS = `--require=\$\{preloadPath\}`/u);
  assert.match(verifierSource, /UNSUPPORTED_PACKAGED_NODE_OPTIONS_PRELOAD/u);
  assert.match(verifierSource, /will not launch the package or claim Show\/Finish evidence/u);
  const mainIndex = verifierSource.indexOf('async function main');
  const rejectionIndex = verifierSource.indexOf(
    "'UNSUPPORTED_PACKAGED_NODE_OPTIONS_PRELOAD'",
    mainIndex
  );
  const fuseBaselineIndex = verifierSource.indexOf(
    'fuses = await readFusePolicy(paths.appPath)',
    mainIndex
  );
  const profileIndex = verifierSource.indexOf(
    'temp = await createIsolatedProfile()',
    mainIndex
  );
  const launchIndex = verifierSource.indexOf(
    'launch = launchPackagedApp(paths, temp, nonce, cancellation)',
    mainIndex
  );
  assert.ok(rejectionIndex > mainIndex);
  assert.ok(fuseBaselineIndex > mainIndex);
  assert.ok(rejectionIndex > fuseBaselineIndex);
  assert.ok(profileIndex > rejectionIndex);
  assert.ok(launchIndex > rejectionIndex);
  assert.match(verifierSource, /createCancellationController\(launches\)/u);
  assert.match(verifierSource, /terminateLaunch\(launch\)/u);
});

test('runner publishes owner-only evidence only after process and profile cleanup', () => {
  const terminationIndex = verifierSource.lastIndexOf('terminateLaunch(launch)');
  const cleanupIndex = verifierSource.lastIndexOf('cleanupProfile(temp, launch)');
  const integrityIndex = verifierSource.lastIndexOf(
    'const finalPaths = await resolvePackagedApp'
  );
  const disposeIndex = verifierSource.lastIndexOf('cancellation.dispose()');
  const publicationIndex = verifierSource.lastIndexOf(
    'writeEvidence(proof.resultPath, evidence)'
  );
  const lateCancellationIndex = verifierSource.lastIndexOf(
    'if (cancellation.requested) {'
  );
  assert.ok(terminationIndex > 0);
  assert.ok(cleanupIndex > terminationIndex);
  assert.ok(integrityIndex > cleanupIndex);
  assert.ok(disposeIndex > integrityIndex);
  assert.ok(lateCancellationIndex > disposeIndex);
  assert.ok(publicationIndex > disposeIndex);
  assert.ok(publicationIndex > lateCancellationIndex);
  assert.match(verifierSource, /PROFILE_MARKER_SOURCE/u);
  assert.match(verifierSource, /retained-process-group-absence-unproven/u);
  assert.match(verifierSource, /assertEvidenceResultDisjoint/u);
  assert.match(verifierSource, /afterProcessGroupAndProfileCleanup: true/u);
  assert.match(verifierSource, /const finalPaths = await resolvePackagedApp/u);
  assert.match(verifierSource, /const finalSourceClosure = await sourceClosureManifest/u);
  assert.match(
    verifierSource,
    /cancellation\.dispose\(\);[\s\S]*?if \(cancellation\.requested\) \{[\s\S]*?evidence\.ok = false/u
  );
  assert.match(verifierSource, /await recheckProofRoot\(proof\)/u);
});

test('result validator rejects any softened Finish or package boundary', () => {
  const paths = {
    appPath: '/private/tmp/package/SyncShow.app',
    archivePath: '/private/tmp/package/SyncShow.app/Contents/Resources/app.asar',
    executablePath: '/private/tmp/package/SyncShow.app/Contents/MacOS/SyncShow'
  };
  const nonce = 'b'.repeat(64);
  const valid = validFixtureResult(paths, nonce);
  assert.equal(
    assertPackagedFixtureResult({ result: valid }, paths, nonce),
    valid
  );

  const wrongFinish = structuredClone(valid);
  wrongFinish.operatorFinish.showPhase = 'live';
  assert.throws(
    () => assertPackagedFixtureResult({ result: wrongFinish }, paths, nonce)
  );

  const missingBarrier = structuredClone(valid);
  missingBarrier.operatorFinish.synchronousDoubleClickBarrierObserved = false;
  assert.throws(
    () => assertPackagedFixtureResult({ result: missingBarrier }, paths, nonce)
  );

  const wrongBoundary = structuredClone(valid);
  wrongBoundary.packagedInstrumentation.uninstrumentedPackageProof = true;
  assert.throws(
    () => assertPackagedFixtureResult({ result: wrongBoundary }, paths, nonce)
  );

  const wrongOutputs = structuredClone(valid);
  wrongOutputs.operatorFinish.routes[0].displayId = 880_003;
  assert.throws(
    () => assertPackagedFixtureResult({ result: wrongOutputs }, paths, nonce)
  );

  const hiddenFinalOutput = structuredClone(valid);
  hiddenFinalOutput.operatorFinish.finalCueWindowVisibilities['singers-monitor'] = false;
  assert.throws(
    () => assertPackagedFixtureResult({ result: hiddenFinalOutput }, paths, nonce)
  );
});

test('contract names the retired unsupported attempt without Show or release overclaim', () => {
  assert.equal(CONTRACT, 'syncshow-packaged-show-finish-instrumented-v1');
  assert.equal(FIXTURE_CONTRACT, 'syncshow-live-cue-navigation-real-electron-v3');
  assert.match(verifierSource, /Retired exact-package Show\/Finish attempt/u);
  assert.match(verifierSource, /earns no Show\/Finish evidence/u);
  assert.match(verifierSource, /no packaged Show\/Finish execution or fixture-load claim/u);
  assert.match(verifierSource, /no uninstrumented packaged Show claim/u);
  assert.match(verifierSource, /no physical display, pixels, cabling, fullscreen/u);
  assert.match(verifierSource, /no volunteer or human confirmation claim/u);
});
