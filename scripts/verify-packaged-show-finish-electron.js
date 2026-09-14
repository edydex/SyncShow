#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const { getCurrentFuseWire } = require('@electron/fuses');
const {
  assertEvidenceResultDisjoint,
  bundleManifest,
  bundleManifestSummary,
  createCancellationController,
  processGroupState,
  resolvePackageProof,
  resolvePackagedApp,
  sourceClosureManifest,
  terminateLaunch,
  writeEvidence
} = require('./verify-packaged-operational-planning-electron');

const CONTRACT = 'syncshow-packaged-show-finish-instrumented-v1';
const FIXTURE_CONTRACT = 'syncshow-live-cue-navigation-real-electron-v3';
const RESULT_FILE = 'packaged-show-finish-instrumented.json';
const FIXTURE_RESULT_FILE = 'live-cue-navigation-electron.json';
const PROFILE_MARKER = '.syncshow-isolated-test-user-data';
const PROFILE_MARKER_SOURCE = 'SyncShow isolated test user data v1\n';
const REPOSITORY_ROOT = path.resolve(__dirname, '..');
const FIXTURE_PATH = path.resolve(
  __dirname,
  'fixtures',
  'live-cue-navigation-electron-app.js'
);
const PRELOAD_PATH = path.resolve(
  __dirname,
  'fixtures',
  'packaged-live-cue-navigation-preload.js'
);
const MAX_LOG_BYTES = 256 * 1024;
const MAX_FIXTURE_RESULT_BYTES = 2 * 1024 * 1024;
const RUN_TIMEOUT_MS = 180_000;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const TEMP_PREFIX = 'syncshow-packaged-show-finish-';
const RETIRED_INSTRUMENTATION_MODE = 'node-options-browser-process-preload';
const UNSUPPORTED_NODE_OPTIONS_MESSAGE =
  'Electron packaged applications reject NODE_OPTIONS --require before Node loads the requested module. This retired verifier will not launch the package or claim Show/Finish evidence.';
const FUSE_NAMES = Object.freeze([
  'RunAsNode',
  'EnableCookieEncryption',
  'EnableNodeOptionsEnvironmentVariable',
  'EnableNodeCliInspectArguments',
  'EnableEmbeddedAsarIntegrityValidation',
  'OnlyLoadAppFromAsar',
  'LoadBrowserProcessSpecificV8Snapshot',
  'GrantFileProtocolExtraPrivileges',
  'WasmTrapHandlers'
]);

class PackagedShowFinishVerificationError extends Error {
  constructor(code, message, cause = null) {
    super(message);
    this.name = 'PackagedShowFinishVerificationError';
    this.code = code;
    if (cause) this.cause = cause;
  }
}

function fail(code, message, cause = null) {
  throw new PackagedShowFinishVerificationError(code, message, cause);
}

function serializeError(error) {
  return {
    name: error?.name || 'Error',
    code: typeof error?.code === 'string' ? error.code : null,
    message: error?.message || String(error),
    stack: typeof error?.stack === 'string' ? error.stack : null
  };
}

function parseArguments(argv) {
  if (!Array.isArray(argv) || argv.length !== 8) {
    fail('INVALID_ARGUMENTS', 'Exactly four option/value pairs are required.');
  }
  const allowed = new Set([
    '--app',
    '--package-proof',
    '--package-proof-sha256',
    '--proof-root'
  ]);
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const option = argv[index];
    const value = argv[index + 1];
    if (
      !allowed.has(option)
      || values.has(option)
      || typeof value !== 'string'
      || value.length === 0
      || value.length > 4096
      || value.startsWith('--')
    ) {
      fail(
        'INVALID_ARGUMENTS',
        'Usage: node scripts/verify-packaged-show-finish-electron.js --app /absolute/path/SyncShow.app --package-proof /absolute/path/package-proof.json --package-proof-sha256 <64-lowercase-hex> --proof-root /absolute/path/to/empty-owner-only-directory'
      );
    }
    values.set(option, value);
  }
  for (const option of ['--app', '--package-proof', '--proof-root']) {
    if (!path.isAbsolute(values.get(option))) {
      fail('ABSOLUTE_PATH_REQUIRED', `${option} must be an absolute path.`);
    }
  }
  const packageProofSha256 = values.get('--package-proof-sha256');
  if (!SHA256_PATTERN.test(packageProofSha256)) {
    fail(
      'INVALID_PACKAGE_PROOF_SHA256',
      '--package-proof-sha256 must be exactly 64 lowercase hexadecimal characters.'
    );
  }
  return Object.freeze({
    appPath: values.get('--app'),
    packageProofPath: values.get('--package-proof'),
    packageProofSha256,
    proofRoot: values.get('--proof-root')
  });
}

async function sha256File(filePath) {
  const stats = await fsp.lstat(filePath);
  if (!stats.isFile() || stats.isSymbolicLink() || stats.size < 1) {
    fail('UNSAFE_HASH_PATH', `Hashed path must be a non-empty regular file: ${filePath}`);
  }
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);
    stream.once('error', reject);
    stream.on('data', bytes => hash.update(bytes));
    stream.once('end', () => resolve(hash.digest('hex')));
  });
}

function sha256Text(value) {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
}

async function resolveProofRoot(rawRoot, rawAppPath) {
  const stats = await fsp.lstat(rawRoot).catch(error => {
    if (error?.code === 'ENOENT') {
      fail('PROOF_ROOT_MISSING', 'Create a new empty owner-only proof root first.');
    }
    throw error;
  });
  if (
    !stats.isDirectory()
    || stats.isSymbolicLink()
    || (stats.mode & 0o777) !== 0o700
  ) {
    fail('UNSAFE_PROOF_ROOT', 'The proof root must be a real directory with exact mode 0700.');
  }
  const proofRoot = await fsp.realpath(rawRoot);
  if (proofRoot !== rawRoot) {
    fail('NONCANONICAL_PROOF_ROOT', 'The proof root must be supplied in canonical form.');
  }
  const entries = await fsp.readdir(proofRoot);
  if (entries.length !== 0) {
    fail('PROOF_ROOT_NOT_EMPTY', 'The proof root must be empty before the run.');
  }
  const resultPath = path.join(proofRoot, RESULT_FILE);
  const appPath = await fsp.realpath(rawAppPath);
  const repositoryRoot = await fsp.realpath(REPOSITORY_ROOT);
  assertEvidenceResultDisjoint(resultPath, [
    { label: 'selected app bundle', path: appPath },
    { label: 'repository root', path: repositoryRoot }
  ]);
  return Object.freeze({ proofRoot, resultPath, mode: 0o700 });
}

function evidenceBoundaries(paths, packageProof, temp = null) {
  return Object.freeze([
    Object.freeze({ label: 'selected app bundle', path: paths.appPath }),
    Object.freeze({ label: 'repository root', path: REPOSITORY_ROOT }),
    Object.freeze({ label: 'retained package proof file', path: packageProof.path }),
    Object.freeze({ label: 'retained package proof root', path: packageProof.proofRoot }),
    ...(temp ? [Object.freeze({ label: 'isolated test profile root', path: temp.testRoot })] : [])
  ]);
}

async function verifyHarnessFiles() {
  const definitions = {
    verifier: __filename,
    fixture: FIXTURE_PATH,
    preload: PRELOAD_PATH,
    packageVerifierHelper: require.resolve(
      './verify-packaged-operational-planning-electron'
    ),
    fuseReader: require.resolve('@electron/fuses'),
    fuseReaderPackage: require.resolve('@electron/fuses/package.json')
  };
  const files = {};
  for (const [name, candidate] of Object.entries(definitions)) {
    const realPath = await fsp.realpath(candidate);
    files[name] = Object.freeze({
      path: realPath,
      sha256: await sha256File(realPath)
    });
  }
  return Object.freeze({ nodeVersion: process.version, files: Object.freeze(files) });
}

async function rehashHarness(harness) {
  assert.equal(process.version, harness.nodeVersion);
  const files = {};
  for (const [name, record] of Object.entries(harness.files)) {
    const finalSha256 = await sha256File(record.path);
    assert.equal(finalSha256, record.sha256, `${name} changed during the run.`);
    files[name] = Object.freeze({ ...record, finalSha256 });
  }
  return Object.freeze({ nodeVersion: harness.nodeVersion, files: Object.freeze(files) });
}

async function readFusePolicy(appPath) {
  const wire = await getCurrentFuseWire(appPath);
  assert.equal(wire.version, '1');
  assert.deepEqual(
    Object.keys(wire).sort(),
    ['0', '1', '2', '3', '4', '5', '6', '7', '8', 'version'].sort()
  );
  const states = {};
  for (let index = 0; index < FUSE_NAMES.length; index += 1) {
    const value = wire[index];
    assert.ok(value === 48 || value === 49, `Fuse ${index} has an unexpected value.`);
    states[FUSE_NAMES[index]] = value === 49;
  }
  assert.deepEqual(states, {
    RunAsNode: true,
    EnableCookieEncryption: false,
    EnableNodeOptionsEnvironmentVariable: true,
    EnableNodeCliInspectArguments: true,
    EnableEmbeddedAsarIntegrityValidation: false,
    OnlyLoadAppFromAsar: false,
    LoadBrowserProcessSpecificV8Snapshot: false,
    GrantFileProtocolExtraPrivileges: true,
    WasmTrapHandlers: true
  });
  return Object.freeze({
    version: wire.version,
    raw: Object.freeze(Object.fromEntries(
      Array.from({ length: FUSE_NAMES.length }, (_, index) => [index, wire[index]])
    )),
    states: Object.freeze(states),
    packagedNodeOptionsBoundary: Object.freeze({
      nodeOptionsFuseEnabled: states.EnableNodeOptionsEnvironmentVariable,
      requestedMode: RETIRED_INSTRUMENTATION_MODE,
      requireAllowedInPackagedApp: false,
      fuseOverridesPackagedAllowlist: false
    }),
    releaseSecurityAccepted: false
  });
}

async function createIsolatedProfile() {
  const temporaryRoot = await fsp.realpath(os.tmpdir());
  const created = await fsp.mkdtemp(path.join(temporaryRoot, TEMP_PREFIX));
  const testRoot = await fsp.realpath(created);
  const relative = path.relative(temporaryRoot, testRoot);
  if (
    !relative
    || path.isAbsolute(relative)
    || relative === '..'
    || relative.startsWith(`..${path.sep}`)
    || !path.basename(testRoot).startsWith(TEMP_PREFIX)
  ) {
    fail('UNSAFE_TEMP_ROOT', 'The isolated profile root escaped the OS temporary directory.');
  }
  const profilePath = path.join(testRoot, 'profile');
  await fsp.mkdir(profilePath, { mode: 0o700 });
  await fsp.chmod(profilePath, 0o700);
  await fsp.writeFile(
    path.join(profilePath, PROFILE_MARKER),
    PROFILE_MARKER_SOURCE,
    { encoding: 'utf8', flag: 'wx', mode: 0o600 }
  );
  return Object.freeze({ temporaryRoot, testRoot, profilePath });
}

function boundedCollector(stream) {
  let value = '';
  stream.setEncoding('utf8');
  stream.on('data', chunk => {
    value += chunk;
    while (Buffer.byteLength(value, 'utf8') > MAX_LOG_BYTES) {
      value = value.slice(Math.max(1, Math.floor(value.length / 8)));
    }
  });
  return () => value;
}

function launchPackagedApp(paths, temp, nonce, cancellation) {
  const environment = { ...process.env };
  for (const name of [
    'ELECTRON_RUN_AS_NODE',
    'NODE_OPTIONS',
    'NODE_PATH',
    'SYNCSHOW_GOOGLE_CLIENT_ID',
    'SYNCSHOW_GOOGLE_CLIENT_SECRET',
    'SYNCSHOW_GOOGLE_API_KEY',
    'SYNCSHOW_PACKAGE_GOOGLE_DRIVE_CONFIG',
    'GH_TOKEN',
    'GITHUB_TOKEN',
    'CSC_LINK',
    'CSC_KEY_PASSWORD'
  ]) delete environment[name];

  const preloadPath = fs.realpathSync(PRELOAD_PATH);
  environment.NODE_OPTIONS = `--require=${preloadPath}`;
  environment.SYNCSHOW_PACKAGED_LIVE_CUE_INSTRUMENTATION = '1';
  environment.SYNCSHOW_PACKAGED_LIVE_CUE_NONCE = nonce;
  environment.SYNCSHOW_EXPECTED_PACKAGED_RESOURCES = path.join(
    paths.appPath,
    'Contents',
    'Resources'
  );
  environment.SYNCSHOW_EXPECTED_PACKAGED_APP_PATH = paths.archivePath;
  environment.SYNCSHOW_EXPECTED_PACKAGED_EXECUTABLE = paths.executablePath;
  environment.SYNCSHOW_EXPECTED_PACKAGED_PRELOAD = preloadPath;
  environment.SYNCSHOW_TEST_USER_DATA_DIR = temp.profilePath;
  environment.SYNCSHOW_LIVE_CUE_NAVIGATION_RESULT = path.join(
    temp.profilePath,
    FIXTURE_RESULT_FILE
  );
  environment.ELECTRON_DISABLE_SECURITY_WARNINGS = 'true';

  const args = [
    '--syncshow-test-user-data',
    `--user-data-dir=${temp.profilePath}`,
    '--headless'
  ];
  const detached = true;
  const child = spawn(paths.executablePath, args, {
    cwd: path.dirname(paths.appPath),
    detached,
    env: environment,
    stdio: ['ignore', 'pipe', 'pipe']
  });
  const launch = {
    phase: 'instrumented-packaged-show-finish',
    child,
    args,
    pid: child.pid,
    processGroupId: Number.isSafeInteger(child.pid) ? child.pid : null,
    processGroupBound: process.platform === 'darwin'
      && detached
      && Number.isSafeInteger(child.pid),
    processGroupAbsence: null,
    cancellation,
    startedAt: new Date().toISOString(),
    spawnError: null,
    exit: null,
    stdout: boundedCollector(child.stdout),
    stderr: boundedCollector(child.stderr)
  };
  launch.closed = new Promise(resolve => {
    child.once('close', (code, signal) => {
      launch.exit = Object.freeze({
        code,
        signal: signal || null,
        finishedAt: new Date().toISOString()
      });
      resolve(launch.exit);
    });
  });
  child.once('error', error => {
    launch.spawnError = serializeError(error);
  });
  return launch;
}

async function waitForLaunch(launch, cancellation) {
  let timer;
  try {
    return await Promise.race([
      launch.closed,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new PackagedShowFinishVerificationError(
          'PACKAGED_SHOW_TIMEOUT',
          'The instrumented packaged Show/Finish rehearsal exceeded three minutes.'
        )), RUN_TIMEOUT_MS);
      }),
      cancellation.requestedPromise.then(signal => {
        throw new PackagedShowFinishVerificationError(
          'VERIFIER_CANCELLED',
          `The packaged Show/Finish rehearsal was cancelled by ${signal}.`
        );
      })
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function readFixtureResult(temp) {
  const resultPath = path.join(temp.profilePath, FIXTURE_RESULT_FILE);
  const stats = await fsp.lstat(resultPath).catch(error => {
    if (error?.code === 'ENOENT') {
      fail('FIXTURE_RESULT_MISSING', 'The packaged fixture did not write its bounded result.');
    }
    throw error;
  });
  if (
    !stats.isFile()
    || stats.isSymbolicLink()
    || (stats.mode & 0o777) !== 0o600
    || stats.size < 2
    || stats.size > MAX_FIXTURE_RESULT_BYTES
  ) {
    fail('UNSAFE_FIXTURE_RESULT', 'The packaged fixture result is not a bounded owner-only file.');
  }
  const realParent = await fsp.realpath(path.dirname(resultPath));
  assert.equal(realParent, temp.profilePath);
  let result;
  try {
    result = JSON.parse(await fsp.readFile(resultPath, 'utf8'));
  } catch (cause) {
    fail('INVALID_FIXTURE_RESULT', 'The packaged fixture result is not valid JSON.', cause);
  }
  return Object.freeze({
    path: resultPath,
    size: stats.size,
    sha256: await sha256File(resultPath),
    result
  });
}

function assertPackagedFixtureResult(record, paths, nonce) {
  const result = record.result;
  assert.equal(result.ok, true, result.stack || result.error);
  assert.equal(result.contract, FIXTURE_CONTRACT);
  assert.equal(result.profileIsolated, true);
  assert.equal(result.productionMainPreloadOutputRenderer, true);
  assert.equal(result.syntheticDisplayConfinedToFixture, true);
  assert.equal(result.fullscreenSuppressedForTest, true);
  assert.equal(result.cueCount, 4);
  assert.equal(result.outputCount, 3);
  assert.deepEqual(result.outputRoutes.map(route => ({
    outputId: route.outputId,
    displayId: route.displayId,
    renderer: route.renderer,
    sourceRoleId: route.sourceRoleId
  })), [
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
  ]);
  const instrumentation = result.packagedInstrumentation;
  assert.deepEqual(instrumentation, {
    mode: 'node-options-browser-process-preload',
    nonceSha256: sha256Text(nonce),
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
  });
  assert.equal(result.delayedAcknowledgement.secondAdvanceRejected, true);
  assert.equal(result.delayedAcknowledgement.committedAfterRelease, true);
  assert.equal(result.negativeAcknowledgement.phase, 'interrupted');
  assert.equal(result.negativeAcknowledgement.authoritativeCueRetained, true);
  assert.equal(result.clearAndLateAcknowledgement.navigationApplied, false);
  assert.equal(result.restoreFromClear.allRendererGuardsOpaqueBlackWhileReceiptHeld, true);
  assert.equal(result.restorePreemptedByClear.lateFrameReceiptDidNotReveal, true);
  assert.equal(result.timeout.timeoutMessageMatched, true);
  assert.ok(result.timeout.elapsedMs >= 14_000 && result.timeout.elapsedMs < 30_000);
  assert.equal(result.timeout.lateReceiptDidNotCommit, true);
  assert.equal(result.restoreAfterTimeout.staleTimedOutCueReplacedOnEveryOutput, true);
  const finish = result.operatorFinish;
  assert.equal(finish.start.before.ready, true);
  assert.equal(finish.start.before.handoffVisible, true);
  assert.equal(finish.start.showStage, true);
  assert.equal(finish.start.activeLaunchPlan.outputs.length, 3);
  assert.deepEqual(finish.routes, [
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
  ]);
  assert.deepEqual(finish.advances.map(entry => entry.targetIndex), [1, 2, 3]);
  assert.deepEqual(finish.finalCueOutputStatuses, {
    'front-projector': 'healthy',
    'translation-projector': 'healthy',
    'singers-monitor': 'healthy'
  });
  assert.equal(finish.finalCueAllOutputsVisible, true);
  assert.deepEqual(finish.finalCueWindowVisibilities, {
    'front-projector': true,
    'translation-projector': true,
    'singers-monitor': true
  });
  assert.equal(finish.finalCueAllWindowsVisible, true);
  assert.equal(finish.finalCueRenderedOnEveryOutput, true);
  assert.equal(finish.button.text, 'Finish service…');
  assert.equal(finish.button.visible, true);
  assert.equal(finish.afterFirstClick.text, 'Finishing service…');
  assert.equal(finish.afterFirstClick.ariaBusy, 'true');
  assert.equal(finish.afterFirstClick.disabled, true);
  assert.equal(finish.afterFirstClick.showEndSessionBusy, true);
  assert.equal(finish.secondClickIssuedWhileDisabled, true);
  assert.equal(finish.secondClickIssuedWhileBusy, true);
  assert.equal(finish.synchronousDoubleClickBarrierObserved, true);
  assert.equal(finish.load.loadStage, true);
  assert.equal(finish.load.dialogMode, 'native');
  assert.equal(finish.load.dialogTitleFocused, true);
  assert.equal(finish.load.handoffBadge, 'Ready');
  assert.equal(finish.showPhase, 'idle');
  assert.equal(finish.outputSessionId, null);
  assert.equal(finish.outputWindowCount, 0);
  assert.equal(finish.projectStatus, 'ready');
  assert.equal(finish.projectRevisionUnchanged, true);
  assert.equal(finish.dialogClosed, true);
  assert.equal(finish.loadFocusedAfterClose, true);
  return result;
}

function launchEvidence(launch) {
  return {
    phase: launch.phase,
    pid: launch.pid,
    processGroupId: launch.processGroupId,
    processGroupBound: launch.processGroupBound,
    args: launch.args,
    startedAt: launch.startedAt,
    exit: launch.exit,
    spawnError: launch.spawnError,
    stdout: launch.stdout(),
    stderr: launch.stderr()
  };
}

async function cleanupProfile(temp, launch) {
  if (!temp) return { status: 'not-created', removed: true };
  const group = launch ? processGroupState(launch) : {
    status: 'absent-no-launch',
    absent: true
  };
  if (!group.absent) {
    return {
      status: 'retained-process-group-absence-unproven',
      removed: false,
      testRoot: temp.testRoot,
      processGroup: group
    };
  }
  const temporaryRoot = await fsp.realpath(os.tmpdir());
  const testRoot = await fsp.realpath(temp.testRoot).catch(error => {
    if (error?.code === 'ENOENT') return null;
    throw error;
  });
  if (!testRoot) return { status: 'already-removed', removed: true, processGroup: group };
  const relative = path.relative(temporaryRoot, testRoot);
  const markerPath = path.join(temp.profilePath, PROFILE_MARKER);
  const marker = await fsp.readFile(markerPath, 'utf8').catch(() => null);
  if (
    temporaryRoot !== temp.temporaryRoot
    || testRoot !== temp.testRoot
    || !relative
    || path.isAbsolute(relative)
    || relative === '..'
    || relative.startsWith(`..${path.sep}`)
    || !path.basename(testRoot).startsWith(TEMP_PREFIX)
    || marker !== PROFILE_MARKER_SOURCE
  ) {
    return {
      status: 'retained-unsafe-or-unmarked-profile',
      removed: false,
      testRoot,
      processGroup: group
    };
  }
  await fsp.rm(testRoot, { recursive: true, force: false });
  const remains = await fsp.lstat(testRoot).catch(error => {
    if (error?.code === 'ENOENT') return null;
    throw error;
  });
  return {
    status: remains ? 'cleanup-failed' : 'removed',
    removed: !remains,
    processGroup: group
  };
}

async function recheckProofRoot(proof) {
  const stats = await fsp.lstat(proof.proofRoot);
  assert.equal(stats.isDirectory(), true);
  assert.equal(stats.isSymbolicLink(), false);
  assert.equal(stats.mode & 0o777, 0o700);
  assert.deepEqual(await fsp.readdir(proof.proofRoot), []);
  return true;
}

async function main(argv = process.argv.slice(2), stdout = process.stdout) {
  const options = parseArguments(argv);
  const proof = await resolveProofRoot(options.proofRoot, options.appPath);
  const evidence = {
    ok: false,
    contract: CONTRACT,
    proofBoundary: 'Retired exact-package Show/Finish attempt. Electron packaged applications reject the planned external NODE_OPTIONS --require browser-process preload before the fixture can load, so this verifier fails closed before package launch and earns no Show/Finish evidence.',
    securityBoundary: 'An enabled NodeOptions fuse does not override Electron\'s packaged-app NODE_OPTIONS allowlist and does not permit --require. RunAsNode, Node CLI inspection, ASAR integrity, and other fuse settings remain separate release-security concerns; none makes this preload route valid.',
    nonClaims: [
      'no packaged Show/Finish execution or fixture-load claim',
      'no uninstrumented packaged Show claim',
      'no physical display, pixels, cabling, fullscreen, macOS Spaces, or venue claim',
      'no volunteer or human confirmation claim',
      'no phone, firewall, installation, notarization, Gatekeeper, distribution, release, or adoption claim'
    ],
    startedAt: new Date().toISOString(),
    package: null,
    packageProof: null,
    sourceClosure: null,
    harness: null,
    fuses: null,
    fixture: null,
    launch: null,
    termination: null,
    cleanup: null,
    cancellation: null,
    instrumentationBoundary: {
      requestedMode: RETIRED_INSTRUMENTATION_MODE,
      status: 'unsupported-not-launched',
      packageLaunchAttempted: false,
      fixtureLoaded: false,
      reason: UNSUPPORTED_NODE_OPTIONS_MESSAGE
    },
    postRunIntegrity: {
      status: 'not-run',
      afterProcessGroupAndProfileCleanup: false
    },
    packageBytesUnchanged: false,
    packageProofBytesUnchanged: false,
    sourceClosureBytesUnchanged: false,
    harnessBytesUnchanged: false,
    fuseWireUnchanged: false,
    finishedAt: null,
    error: null
  };
  let paths = null;
  let packageProof = null;
  let sourceClosure = null;
  let harness = null;
  let fuses = null;
  let temp = null;
  let launch = null;
  let primaryError = null;
  let publicationAllowed = false;
  const launches = [];
  const cancellation = createCancellationController(launches);

  try {
    paths = await resolvePackagedApp(options.appPath);
    packageProof = await resolvePackageProof(
      options.packageProofPath,
      options.packageProofSha256,
      paths
    );
    assertEvidenceResultDisjoint(
      proof.resultPath,
      evidenceBoundaries(paths, packageProof)
    );
    publicationAllowed = true;
    sourceClosure = await sourceClosureManifest();
    harness = await verifyHarnessFiles();
    fuses = await readFusePolicy(paths.appPath);
    evidence.package = {
      path: paths.appPath,
      identity: paths.identity,
      hashes: paths.hashes,
      bundle: bundleManifestSummary(paths.bundleManifest)
    };
    evidence.packageProof = { ...packageProof, finalSha256: null };
    evidence.sourceClosure = {
      fileCount: sourceClosure.fileCount,
      totalBytes: sourceClosure.totalBytes,
      recordsSha256: sourceClosure.recordsSha256
    };
    evidence.harness = harness;
    evidence.fuses = { before: fuses, after: null };

    fail(
      'UNSUPPORTED_PACKAGED_NODE_OPTIONS_PRELOAD',
      UNSUPPORTED_NODE_OPTIONS_MESSAGE
    );

    temp = await createIsolatedProfile();
    assertEvidenceResultDisjoint(
      proof.resultPath,
      evidenceBoundaries(paths, packageProof, temp)
    );
    const nonce = crypto.randomBytes(32).toString('hex');
    launch = launchPackagedApp(paths, temp, nonce, cancellation);
    launches.push(launch);
    const exit = await waitForLaunch(launch, cancellation);
    if (launch.spawnError) {
      fail('PACKAGED_APP_SPAWN_FAILED', launch.spawnError.message);
    }
    assert.equal(exit.signal, null);
    assert.equal(exit.code, 0, launch.stderr() || launch.stdout());
    const fixtureRecord = await readFixtureResult(temp);
    assertPackagedFixtureResult(fixtureRecord, paths, nonce);
    evidence.fixture = fixtureRecord;

    if (cancellation.requested) {
      fail('VERIFIER_CANCELLED', `The verifier was cancelled by ${cancellation.signal}.`);
    }
    evidence.ok = true;
  } catch (error) {
    primaryError = error;
    evidence.error = serializeError(error);
    evidence.ok = false;
  } finally {
    if (launch) {
      try {
        evidence.termination = await terminateLaunch(launch);
      } catch (error) {
        evidence.termination = {
          status: 'failed',
          error: serializeError(error)
        };
      }
      evidence.launch = launchEvidence(launch);
    }
    try {
      evidence.cleanup = await cleanupProfile(temp, launch);
    } catch (error) {
      evidence.cleanup = {
        status: 'failed',
        removed: false,
        testRoot: temp?.testRoot || null,
        error: serializeError(error)
      };
    }
    if (!evidence.cleanup?.removed) {
      evidence.ok = false;
      if (!evidence.error) {
        evidence.error = serializeError(new PackagedShowFinishVerificationError(
          'CLEANUP_INCOMPLETE',
          'The isolated packaged Show/Finish profile was retained because cleanup safety was not proven.'
        ));
      }
    }
    if (publicationAllowed) {
      try {
        assertEvidenceResultDisjoint(
          proof.resultPath,
          evidenceBoundaries(paths, packageProof, temp)
        );
      } catch (error) {
        publicationAllowed = false;
        evidence.ok = false;
        if (!primaryError) primaryError = error;
        evidence.error = serializeError(primaryError);
      }
    }
    if (
      publicationAllowed
      && evidence.cleanup?.removed
      && paths
      && packageProof
      && sourceClosure
      && harness
      && fuses
    ) {
      try {
        const finalPaths = await resolvePackagedApp(options.appPath);
        const finalPackageProof = await resolvePackageProof(
          options.packageProofPath,
          options.packageProofSha256,
          finalPaths
        );
        const finalSourceClosure = await sourceClosureManifest();
        const finalHarness = await rehashHarness(harness);
        const finalFuses = await readFusePolicy(finalPaths.appPath);
        assert.deepEqual(finalPaths.hashes, paths.hashes);
        assert.deepEqual(finalPaths.bundleManifest, paths.bundleManifest);
        assert.deepEqual(finalPackageProof, packageProof);
        assert.deepEqual(finalSourceClosure, sourceClosure);
        assert.deepEqual(finalFuses, fuses);
        evidence.package.finalHashes = finalPaths.hashes;
        evidence.package.finalBundle = bundleManifestSummary(finalPaths.bundleManifest);
        evidence.packageBytesUnchanged = true;
        evidence.packageProof.finalSha256 = finalPackageProof.sha256;
        evidence.packageProofBytesUnchanged = true;
        evidence.sourceClosure.finalRecordsSha256 = finalSourceClosure.recordsSha256;
        evidence.sourceClosureBytesUnchanged = true;
        evidence.harness = finalHarness;
        evidence.harnessBytesUnchanged = true;
        evidence.fuses.after = finalFuses;
        evidence.fuseWireUnchanged = true;
        evidence.postRunIntegrity = {
          status: 'verified-unchanged',
          afterProcessGroupAndProfileCleanup: true,
          packageBundleRecordsSha256: finalPaths.bundleManifest.recordsSha256,
          packageProofSha256: finalPackageProof.sha256,
          sourceClosureRecordsSha256: finalSourceClosure.recordsSha256,
          harness: finalHarness,
          fuses: finalFuses
        };
        evidence.publicationRecheck = evidence.postRunIntegrity;
      } catch (error) {
        evidence.ok = false;
        evidence.postRunIntegrity = {
          status: 'failed',
          afterProcessGroupAndProfileCleanup: true,
          error: serializeError(error)
        };
        if (!primaryError) {
          primaryError = new PackagedShowFinishVerificationError(
            'POST_RUN_INTEGRITY_RECHECK_FAILED',
            'Post-run package, proof, source, harness, or fuse integrity could not be verified.',
            error
          );
          evidence.error = serializeError(primaryError);
        }
      }
    } else if (!evidence.cleanup?.removed) {
      evidence.postRunIntegrity = {
        status: 'not-run-cleanup-unproven',
        afterProcessGroupAndProfileCleanup: false
      };
    } else {
      evidence.postRunIntegrity = {
        status: 'not-run-baseline-incomplete',
        afterProcessGroupAndProfileCleanup: true
      };
    }
    if (publicationAllowed) {
      try {
        await recheckProofRoot(proof);
      } catch (error) {
        publicationAllowed = false;
        evidence.ok = false;
        if (!primaryError) primaryError = error;
        evidence.error = serializeError(primaryError);
      }
    }
    cancellation.dispose();
    evidence.cancellation = cancellation.evidence();
    if (cancellation.requested) {
      evidence.ok = false;
      if (!primaryError) {
        primaryError = new PackagedShowFinishVerificationError(
          'VERIFIER_CANCELLED',
          `The verifier was cancelled by ${cancellation.signal} before evidence publication.`
        );
      }
      evidence.error = serializeError(primaryError);
    }
    evidence.finishedAt = new Date().toISOString();
    if (publicationAllowed) await writeEvidence(proof.resultPath, evidence);
  }

  const error = primaryError || new PackagedShowFinishVerificationError(
    evidence.error?.code || 'PACKAGED_SHOW_FINISH_UNSUPPORTED',
    evidence.error?.message || UNSUPPORTED_NODE_OPTIONS_MESSAGE
  );
  if (publicationAllowed) {
    error.message = `${error.message}\nEvidence: ${proof.resultPath}`;
  }
  throw error;
}

if (require.main === module) {
  main().catch(error => {
    process.stderr.write(`${error.code || error.name}: ${error.message}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  CONTRACT,
  FIXTURE_CONTRACT,
  FUSE_NAMES,
  PackagedShowFinishVerificationError,
  assertPackagedFixtureResult,
  cleanupProfile,
  evidenceBoundaries,
  main,
  parseArguments,
  readFusePolicy,
  resolveProofRoot
};
