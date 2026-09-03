#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { pathToFileURL } = require('node:url');

const asar = require('@electron/asar');

const sourceManifest = require('../package.json');
const { readPlistValue } = require('./lib/mac-network-privacy');
const { binaryArchitecture } = require('./verify-package-smoke');
const {
  ISOLATED_TEST_USER_DATA_MARKER
} = require('../src/services/runtime/IsolatedTestUserData');
const {
  NATIVE_WEEKLY_TITLE,
  READY_PROJECT_ID,
  WEEKLY_CHECK_IDS,
  seedTrackedPlanningProfile
} = require('./fixtures/packaged-operational-planning-seed');

const SEED_SCRIPT_PATH = require.resolve(
  './fixtures/packaged-operational-planning-seed'
);
const TRACKED_FIXTURE_PATH = require.resolve(
  '../test/fixtures/native-weekly-service'
);

const CONTRACT = 'syncshow-packaged-operational-planning-restart-v1';
const RESULT_FILE = 'packaged-operational-planning-restart.json';
const PROFILE_MARKER_SOURCE = 'SyncShow isolated test user data v1\n';
const EXPECTED_PRODUCT_NAME = 'SyncShow';
const EXPECTED_BUNDLE_ID = 'com.church.syncshow';
const EXPECTED_PREPARED_CUE_COUNT = 9;
const EXPECTED_PREPARED_ROLE_IDS = Object.freeze([
  'english',
  'media',
  'russian'
]);
const REPOSITORY_ROOT = path.resolve(__dirname, '..');
const SOURCE_CLOSURE_ROOTS = Object.freeze([
  'src',
  'packages/service-core',
  'scripts',
  'test/fixtures',
  'package.json',
  'package-lock.json',
  'assets/fonts/NotoSans-Variable.ttf'
]);
const MAX_LOG_BYTES = 256 * 1024;
const MAX_HTTP_BYTES = 1024 * 1024;
const MAX_PACKAGE_PROOF_BYTES = 1024 * 1024;
const DISCOVERY_TIMEOUT_MS = 45_000;
const UI_TIMEOUT_MS = 90_000;
const CLOSE_TIMEOUT_MS = 30_000;
const CDP_CALL_TIMEOUT_MS = 20_000;
const GROUP_TERM_TIMEOUT_MS = 5_000;
const GROUP_KILL_TIMEOUT_MS = 5_000;
const MAX_SOURCE_CLOSURE_FILES = 5_000;
const MAX_SOURCE_CLOSURE_BYTES = 256 * 1024 * 1024;
const MAX_PROFILE_SNAPSHOT_ENTRIES = 20_000;
const MAX_PROFILE_SNAPSHOT_BYTES = 2 * 1024 * 1024 * 1024;
const MAX_DIRECT_JSON_BYTES = 16 * 1024 * 1024;
const MAX_DIRECT_PACKAGE_FILES = 2_000;
const MAX_DIRECT_PACKAGE_BYTES = 2 * 1024 * 1024 * 1024;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const SHOW_PACKAGE_PATTERN = /^show-[a-f0-9]{64}$/u;
const READY_PROJECT_STORAGE_DIRECTORY =
  'project-8c0d4de1f35c3ee10f4dc6e060487824cd0df9cb0212e3ba8393cbb6235ce625';
const IN_PAGE_VISIBLE_PREDICATE = `element => {
  if (!(element instanceof Element) || element.getClientRects().length === 0) return false;
  const rect = element.getBoundingClientRect();
  for (let current = element; current instanceof Element; current = current.parentElement) {
    const style = window.getComputedStyle(current);
    if (
      style.display === 'none'
      || style.visibility !== 'visible'
      || !(Number.parseFloat(style.opacity) > 0)
    ) return false;
  }
  const viewportWidth = Math.max(document.documentElement.clientWidth, window.innerWidth || 0);
  const viewportHeight = Math.max(document.documentElement.clientHeight, window.innerHeight || 0);
  return rect.width > 0
    && rect.height > 0
    && viewportWidth > 0
    && viewportHeight > 0
    && rect.right > 0
    && rect.bottom > 0
    && rect.left < viewportWidth
    && rect.top < viewportHeight;
}`;
const IN_PAGE_SCROLL_INTO_OWNER_PREDICATE = `(owner, target) => {
  if (!(owner instanceof Element) || !(target instanceof Element)) return false;
  target.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  const ownerRect = owner.getBoundingClientRect();
  const targetRect = target.getBoundingClientRect();
  return isVisible(target)
    && targetRect.top >= ownerRect.top - 1
    && targetRect.bottom <= ownerRect.bottom + 1
    && targetRect.left >= ownerRect.left - 1
    && targetRect.right <= ownerRect.right + 1;
}`;

class PackagedPlanningVerificationError extends Error {
  constructor(code, message, cause = null) {
    super(message);
    this.name = 'PackagedPlanningVerificationError';
    this.code = code;
    if (cause) this.cause = cause;
  }
}

class RetryableDiscoveryTransportError extends Error {
  constructor(message, cause = null) {
    super(message);
    this.name = 'RetryableDiscoveryTransportError';
    this.code = 'RETRYABLE_DISCOVERY_TRANSPORT';
    this.retryableWait = true;
    if (cause) this.cause = cause;
  }
}

class FatalCdpEvaluationError extends PackagedPlanningVerificationError {
  constructor(code, message, cause = null) {
    super(code, message, cause);
    this.name = 'FatalCdpEvaluationError';
    this.fatalWait = true;
  }
}

function fail(code, message, cause = null) {
  throw new PackagedPlanningVerificationError(code, message, cause);
}

function parseArguments(argv) {
  if (!Array.isArray(argv)) {
    throw new TypeError('Verifier arguments must be an array.');
  }
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const option = argv[index];
    const value = argv[index + 1];
    if (
      ![
        '--app',
        '--package-proof',
        '--package-proof-sha256',
        '--proof-root'
      ].includes(option)
      || typeof value !== 'string'
      || value.length === 0
      || value.startsWith('--')
      || values.has(option)
    ) {
      fail(
        'INVALID_ARGUMENTS',
        'Usage: node scripts/verify-packaged-operational-planning-electron.js --app /absolute/path/SyncShow.app --package-proof /absolute/path/package-proof.json --package-proof-sha256 <64-lowercase-hex> --proof-root /absolute/path/to/empty-or-new-evidence-directory'
      );
    }
    values.set(option, value);
  }
  if (values.size !== 4 || argv.length !== 8) {
    fail(
      'INVALID_ARGUMENTS',
      '--app, --package-proof, --package-proof-sha256, and --proof-root are required exactly once.'
    );
  }
  for (const option of ['--app', '--package-proof', '--proof-root']) {
    const value = values.get(option);
    if (!path.isAbsolute(value) || value.length > 4096) {
      fail('ABSOLUTE_PATH_REQUIRED', `${option} requires a bounded absolute path.`);
    }
  }
  const packageProofSha256 = values.get('--package-proof-sha256');
  if (!/^[a-f0-9]{64}$/u.test(packageProofSha256)) {
    fail(
      'INVALID_PACKAGE_PROOF_SHA256',
      '--package-proof-sha256 requires exactly 64 lowercase hexadecimal characters.'
    );
  }
  return Object.freeze({
    appPath: values.get('--app'),
    packageProofPath: values.get('--package-proof'),
    packageProofSha256,
    proofRoot: values.get('--proof-root')
  });
}

async function regularPath(candidatePath, kind, expectedKind) {
  const stats = await fsp.lstat(candidatePath).catch(error => {
    if (error?.code === 'ENOENT') {
      fail('PACKAGE_PATH_MISSING', `${kind} is missing: ${candidatePath}`);
    }
    throw error;
  });
  if (stats.isSymbolicLink()) {
    fail('UNSAFE_PACKAGE_PATH', `${kind} must not be a symbolic link.`);
  }
  if (expectedKind === 'file' && (!stats.isFile() || stats.size < 1)) {
    fail('INVALID_PACKAGE_FILE', `${kind} must be a non-empty regular file.`);
  }
  if (expectedKind === 'directory' && !stats.isDirectory()) {
    fail('INVALID_PACKAGE_DIRECTORY', `${kind} must be a real directory.`);
  }
  return stats;
}

async function sha256File(filePath) {
  await regularPath(filePath, 'hashed file', 'file');
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);
    stream.once('error', reject);
    stream.on('data', bytes => hash.update(bytes));
    stream.once('end', () => resolve(hash.digest('hex')));
  });
}

function recordsDigest(records) {
  return sha256Bytes(Buffer.from(
    `${records.map(record => JSON.stringify(record)).join('\n')}\n`,
    'utf8'
  ));
}

async function bundleManifest(appRoot) {
  const records = [];
  async function visit(relative) {
    const absolute = relative ? path.join(appRoot, relative) : appRoot;
    const stats = await fsp.lstat(absolute);
    const safe = relative.split(path.sep).join('/');
    if (relative && stats.isSymbolicLink()) {
      const target = await fsp.readlink(absolute);
      const resolved = path.resolve(path.dirname(absolute), target);
      const inside = path.relative(appRoot, resolved);
      if (
        inside === '..'
        || inside.startsWith(`..${path.sep}`)
        || path.isAbsolute(inside)
      ) {
        fail('BUNDLE_SYMLINK_ESCAPE', `Bundle symlink escapes the app: ${safe}`);
      }
      records.push({ path: safe, type: 'link', mode: stats.mode & 0o777, target });
      return;
    }
    if (stats.isDirectory()) {
      if (relative) {
        records.push({ path: safe, type: 'directory', mode: stats.mode & 0o777 });
      }
      const entries = await fsp.readdir(absolute);
      entries.sort((left, right) => left.localeCompare(right, 'en'));
      for (const entry of entries) await visit(path.join(relative, entry));
      return;
    }
    if (!stats.isFile()) {
      fail('UNSUPPORTED_BUNDLE_ENTRY', `Unsupported bundle entry: ${safe}`);
    }
    const bytes = await fsp.readFile(absolute);
    records.push({
      path: safe,
      type: 'file',
      mode: stats.mode & 0o777,
      size: stats.size,
      sha256: sha256Bytes(bytes)
    });
  }
  await visit('');
  records.sort((left, right) => left.path.localeCompare(right.path, 'en'));
  if (new Set(records.map(record => record.path)).size !== records.length) {
    fail('DUPLICATE_BUNDLE_PATH', 'The selected app bundle has duplicate paths.');
  }
  return {
    fileCount: records.filter(record => record.type === 'file').length,
    directoryCount: records.filter(record => record.type === 'directory').length,
    linkCount: records.filter(record => record.type === 'link').length,
    totalFileBytes: records.reduce((sum, record) => sum + (record.size || 0), 0),
    recordsSha256: recordsDigest(records),
    records
  };
}

function bundleManifestSummary(manifest) {
  return Object.freeze({
    fileCount: manifest.fileCount,
    directoryCount: manifest.directoryCount,
    linkCount: manifest.linkCount,
    totalFileBytes: manifest.totalFileBytes,
    recordsSha256: manifest.recordsSha256
  });
}

function repositoryRelative(absolutePath) {
  const relative = path.relative(REPOSITORY_ROOT, absolutePath);
  if (
    !relative
    || path.isAbsolute(relative)
    || relative === '..'
    || relative.startsWith(`..${path.sep}`)
  ) {
    fail('SOURCE_CLOSURE_ESCAPE', `Source closure path escaped the repository: ${absolutePath}`);
  }
  return relative.split(path.sep).join('/');
}

async function sourceClosureManifest() {
  const records = [];
  let totalBytes = 0;
  async function visit(absolutePath) {
    const stats = await fsp.lstat(absolutePath);
    const relative = repositoryRelative(absolutePath);
    if (stats.isSymbolicLink()) {
      fail('UNSAFE_SOURCE_CLOSURE', `Source closure contains a symbolic link: ${relative}`);
    }
    if (stats.isDirectory()) {
      const entries = await fsp.readdir(absolutePath);
      entries.sort((left, right) => left.localeCompare(right, 'en'));
      for (const entry of entries) await visit(path.join(absolutePath, entry));
      return;
    }
    if (!stats.isFile()) {
      fail('UNSAFE_SOURCE_CLOSURE', `Source closure contains an unsupported entry: ${relative}`);
    }
    if (records.length >= MAX_SOURCE_CLOSURE_FILES) {
      fail('SOURCE_CLOSURE_TOO_LARGE', 'Source closure file count exceeded its bound.');
    }
    totalBytes += stats.size;
    if (totalBytes > MAX_SOURCE_CLOSURE_BYTES) {
      fail('SOURCE_CLOSURE_TOO_LARGE', 'Source closure byte count exceeded its bound.');
    }
    const bytes = await fsp.readFile(absolutePath);
    assert.equal(bytes.length, stats.size);
    records.push({
      path: relative,
      mode: stats.mode & 0o777,
      size: stats.size,
      sha256: sha256Bytes(bytes)
    });
  }

  for (const relativeRoot of SOURCE_CLOSURE_ROOTS) {
    await visit(path.join(REPOSITORY_ROOT, relativeRoot));
  }
  records.sort((left, right) => left.path.localeCompare(right.path, 'en'));
  assert.equal(new Set(records.map(record => record.path)).size, records.length);
  const recordPaths = new Set(records.map(record => record.path));
  const loadedLocalModules = Object.keys(require.cache)
    .map(modulePath => path.resolve(modulePath))
    .filter(modulePath => {
      const relative = path.relative(REPOSITORY_ROOT, modulePath);
      return relative
        && !path.isAbsolute(relative)
        && relative !== '..'
        && !relative.startsWith(`..${path.sep}`)
        && !relative.split(path.sep).includes('node_modules');
    })
    .map(repositoryRelative)
    .sort((left, right) => left.localeCompare(right, 'en'));
  for (const loadedPath of loadedLocalModules) {
    assert.equal(
      recordPaths.has(loadedPath),
      true,
      `Loaded first-party module is outside the source closure: ${loadedPath}`
    );
  }
  return Object.freeze({
    roots: SOURCE_CLOSURE_ROOTS,
    fileCount: records.length,
    totalBytes,
    recordsSha256: recordsDigest(records),
    loadedLocalModules,
    records
  });
}

async function resolveHarnessProvenance() {
  const definitions = {
    verifier: {
      path: __filename,
      role: 'packaged-lifecycle-verifier'
    },
    externalSeed: {
      path: SEED_SCRIPT_PATH,
      role: 'external-test-seed-not-packaged-behavior'
    },
    trackedFixture: {
      path: TRACKED_FIXTURE_PATH,
      role: 'tracked-source-fixture-input'
    }
  };
  const files = {};
  for (const [name, definition] of Object.entries(definitions)) {
    await regularPath(definition.path, `${name} harness source`, 'file');
    const realPath = await fsp.realpath(definition.path);
    files[name] = Object.freeze({
      path: realPath,
      role: definition.role,
      sha256: await sha256File(realPath)
    });
  }
  return Object.freeze({
    processVersion: process.version,
    files: Object.freeze(files)
  });
}

async function rehashHarnessProvenance(provenance) {
  const finalFiles = {};
  for (const [name, record] of Object.entries(provenance.files)) {
    const finalSha256 = await sha256File(record.path);
    assert.equal(finalSha256, record.sha256);
    finalFiles[name] = Object.freeze({ ...record, finalSha256 });
  }
  assert.equal(process.version, provenance.processVersion);
  return Object.freeze({
    processVersion: provenance.processVersion,
    files: Object.freeze(finalFiles)
  });
}

async function resolvePackagedApp(rawAppPath) {
  if (process.platform !== 'darwin' || process.arch !== 'arm64') {
    fail(
      'DARWIN_ARM64_REQUIRED',
      'This exact packaged lifecycle verifier must run on the reviewed macOS arm64 host.'
    );
  }
  await regularPath(rawAppPath, 'selected app bundle', 'directory');
  const appPath = await fsp.realpath(rawAppPath);
  if (path.basename(appPath) !== `${EXPECTED_PRODUCT_NAME}.app`) {
    fail('WRONG_APP_BUNDLE', 'Choose the exact SyncShow.app bundle directory.');
  }

  const contentsPath = path.join(appPath, 'Contents');
  const infoPlistPath = path.join(contentsPath, 'Info.plist');
  const archivePath = path.join(contentsPath, 'Resources', 'app.asar');
  await regularPath(contentsPath, 'app Contents directory', 'directory');
  await regularPath(infoPlistPath, 'app Info.plist', 'file');
  await regularPath(archivePath, 'packaged app.asar', 'file');

  const executableName = readPlistValue(infoPlistPath, 'CFBundleExecutable');
  const bundleId = readPlistValue(infoPlistPath, 'CFBundleIdentifier');
  const version = readPlistValue(infoPlistPath, 'CFBundleShortVersionString');
  const buildVersion = readPlistValue(infoPlistPath, 'CFBundleVersion');
  assert.equal(executableName, EXPECTED_PRODUCT_NAME);
  assert.equal(bundleId, EXPECTED_BUNDLE_ID);
  assert.equal(version, sourceManifest.version);
  assert.equal(buildVersion, sourceManifest.build.buildVersion);

  const executablePath = path.join(contentsPath, 'MacOS', executableName);
  await regularPath(executablePath, 'packaged executable', 'file');
  await fsp.access(executablePath, fs.constants.X_OK);
  const executableRealPath = await fsp.realpath(executablePath);
  assert.equal(await binaryArchitecture(executableRealPath), 'arm64');

  let packagedManifest;
  let entries;
  try {
    packagedManifest = JSON.parse(
      asar.extractFile(archivePath, 'package.json').toString('utf8')
    );
    entries = new Set(asar.listPackage(archivePath));
  } catch (cause) {
    fail('INVALID_APP_ARCHIVE', 'The selected app.asar could not be read.', cause);
  }
  assert.equal(packagedManifest.name, sourceManifest.name);
  assert.equal(packagedManifest.version, sourceManifest.version);
  assert.equal(packagedManifest.main, 'main.js');
  for (const requiredEntry of [
    '/main.js',
    '/preload.js',
    '/src/renderer/index.html',
    '/src/renderer/app.js',
    '/src/services/runtime/IsolatedTestUserData.js',
    '/packages/service-core/package.json',
    '/packages/service-core/node.js',
    '/packages/service-core/node/services/project/ServiceProject.js'
  ]) {
    assert.equal(entries.has(requiredEntry), true, `app.asar is missing ${requiredEntry}`);
  }
  assert.equal(
    [...entries].some(entry => /^\/(?:scripts|test)(?:\/|$)/u.test(entry)),
    false,
    'Source verifier and test files must not be present in the packaged app.'
  );

  return Object.freeze({
    appPath,
    archivePath,
    executablePath: executableRealPath,
    expectedControlUrl: pathToFileURL(
      path.join(archivePath, 'src', 'renderer', 'index.html')
    ).href,
    identity: Object.freeze({
      bundleId,
      executableName,
      name: packagedManifest.name,
      version,
      buildVersion,
      main: packagedManifest.main,
      architecture: 'arm64'
    }),
    hashes: Object.freeze({
      appAsarSha256: await sha256File(archivePath),
      executableSha256: await sha256File(executableRealPath)
    }),
    bundleManifest: await bundleManifest(appPath)
  });
}

async function resolvePackageProof(rawProofPath, expectedSha256, paths) {
  const proofStats = await regularPath(
    rawProofPath,
    'retained audited package proof',
    'file'
  );
  if (
    path.basename(rawProofPath) !== 'package-proof.json'
    || proofStats.size > MAX_PACKAGE_PROOF_BYTES
  ) {
    fail(
      'INVALID_PACKAGE_PROOF_FILE',
      'The retained audited package proof must be a bounded package-proof.json file.'
    );
  }
  const proofPath = await fsp.realpath(rawProofPath);
  const proofBytes = await fsp.readFile(proofPath);
  if (proofBytes.length < 1 || proofBytes.length > MAX_PACKAGE_PROOF_BYTES) {
    fail('INVALID_PACKAGE_PROOF_FILE', 'The retained package proof has an invalid size.');
  }
  const actualSha256 = sha256Bytes(proofBytes);
  if (actualSha256 !== expectedSha256) {
    fail(
      'PACKAGE_PROOF_HASH_MISMATCH',
      `Retained package proof hash mismatch: expected ${expectedSha256}, found ${actualSha256}.`
    );
  }

  let retainedProof;
  try {
    retainedProof = JSON.parse(proofBytes.toString('utf8'));
  } catch (cause) {
    fail('INVALID_PACKAGE_PROOF_JSON', 'The retained package proof is not valid JSON.', cause);
  }
  if (!retainedProof || typeof retainedProof !== 'object' || Array.isArray(retainedProof)) {
    fail('INVALID_PACKAGE_PROOF_JSON', 'The retained package proof must be a JSON object.');
  }
  assert.equal(retainedProof.schemaVersion, 1);
  assert.equal(retainedProof.label, 'syncshow-current-package-qa-proof-v1');
  assert.equal(retainedProof.verified, true);
  assert.equal(typeof retainedProof.proofRoot, 'string');
  assert.equal(path.isAbsolute(retainedProof.proofRoot), true);
  await regularPath(retainedProof.proofRoot, 'retained package proof root', 'directory');
  const retainedProofRoot = await fsp.realpath(retainedProof.proofRoot);
  const proofRelative = path.relative(retainedProofRoot, proofPath);
  assert.equal(Boolean(proofRelative), true);
  assert.equal(path.isAbsolute(proofRelative), false);
  assert.notEqual(proofRelative, '..');
  assert.equal(proofRelative.startsWith(`..${path.sep}`), false);

  const retainedPackage = retainedProof.package;
  assert.equal(Boolean(retainedPackage && typeof retainedPackage === 'object'), true);
  assert.equal(typeof retainedPackage.appRoot, 'string');
  assert.equal(path.isAbsolute(retainedPackage.appRoot), true);
  await regularPath(retainedPackage.appRoot, 'retained proof app bundle', 'directory');
  const retainedAppRoot = await fsp.realpath(retainedPackage.appRoot);
  assert.equal(retainedAppRoot, paths.appPath);
  assert.equal(retainedPackage.asarSha256, paths.hashes.appAsarSha256);
  assert.equal(retainedPackage.bundleId, paths.identity.bundleId);
  assert.equal(retainedPackage.version, paths.identity.version);
  assert.equal(retainedPackage.buildVersion, paths.identity.buildVersion);
  assert.equal(retainedPackage.architecture, paths.identity.architecture);

  const retainedBundle = retainedProof.bundle;
  assert.equal(Boolean(retainedBundle && typeof retainedBundle === 'object'), true);
  assert.match(retainedBundle.recordsSha256, /^[a-f0-9]{64}$/u);
  assert.equal(Array.isArray(retainedBundle.records), true);
  assert.equal(recordsDigest(retainedBundle.records), retainedBundle.recordsSha256);
  assert.deepEqual(paths.bundleManifest, retainedBundle);
  const executableRecords = retainedBundle.records.filter(
    record => record?.path === 'Contents/MacOS/SyncShow'
  );
  assert.equal(executableRecords.length, 1);
  const executableRecord = executableRecords[0];
  assert.equal(executableRecord.type, 'file');
  assert.equal(executableRecord.sha256, paths.hashes.executableSha256);

  return Object.freeze({
    path: proofPath,
    proofRoot: retainedProofRoot,
    sha256: actualSha256,
    schemaVersion: retainedProof.schemaVersion,
    label: retainedProof.label,
    verified: retainedProof.verified,
    package: Object.freeze({
      appRoot: retainedAppRoot,
      asarSha256: retainedPackage.asarSha256,
      bundleId: retainedPackage.bundleId,
      version: retainedPackage.version,
      buildVersion: retainedPackage.buildVersion,
      architecture: retainedPackage.architecture,
      signing: retainedPackage.signing,
      notarized: retainedPackage.notarized,
      distributionArtifact: retainedPackage.distributionArtifact
    }),
    bundle: Object.freeze({
      recordsSha256: retainedBundle.recordsSha256,
      executableRecord: Object.freeze({
        path: executableRecord.path,
        type: executableRecord.type,
        mode: executableRecord.mode,
        size: executableRecord.size,
        sha256: executableRecord.sha256
      })
    })
  });
}

async function resolveProofRoot(rawProofRoot) {
  const rawStats = await regularPath(rawProofRoot, 'proof root', 'directory');
  if ((rawStats.mode & 0o777) !== 0o700) {
    fail('UNSAFE_PROOF_ROOT_MODE', 'The dedicated proof root must have exact mode 0700.');
  }
  const proofRoot = await fsp.realpath(rawProofRoot);
  const proofRootStats = await fsp.lstat(proofRoot);
  if (
    !proofRootStats.isDirectory()
    || proofRootStats.isSymbolicLink()
    || (proofRootStats.mode & 0o777) !== 0o700
  ) {
    fail('UNSAFE_PROOF_ROOT', 'The proof root must resolve to a real owner-only directory.');
  }
  const initialEntries = await fsp.readdir(proofRoot);
  if (initialEntries.length !== 0) {
    fail('PROOF_ROOT_NOT_EMPTY', 'The dedicated proof root must be empty at verifier start.');
  }
  const resultPath = path.join(proofRoot, RESULT_FILE);
  const relative = path.relative(proofRoot, resultPath);
  if (
    relative !== RESULT_FILE
    || path.isAbsolute(relative)
    || relative.startsWith(`..${path.sep}`)
  ) {
    fail('UNSAFE_PROOF_PATH', 'The result file escaped the selected proof root.');
  }
  return Object.freeze({
    proofRoot,
    resultPath,
    mode: proofRootStats.mode & 0o777,
    initialEntryCount: initialEntries.length,
    initiallyEmpty: true
  });
}

function pathEqualsOrIsNested(candidatePath, boundaryPath) {
  if (!path.isAbsolute(candidatePath) || !path.isAbsolute(boundaryPath)) {
    throw new TypeError('Publication paths and boundaries must be absolute.');
  }
  const relative = path.relative(boundaryPath, candidatePath);
  return relative === '' || (
    !path.isAbsolute(relative)
    && relative !== '..'
    && !relative.startsWith(`..${path.sep}`)
  );
}

function assertEvidenceResultDisjoint(resultPath, boundaries) {
  if (!path.isAbsolute(resultPath) || !Array.isArray(boundaries)) {
    throw new TypeError('Evidence disjointness requires an absolute result and boundaries.');
  }
  for (const boundary of boundaries) {
    if (
      !boundary
      || typeof boundary.label !== 'string'
      || !path.isAbsolute(boundary.path)
    ) {
      throw new TypeError('Each evidence boundary requires a label and absolute path.');
    }
    if (pathEqualsOrIsNested(resultPath, boundary.path)) {
      fail(
        'EVIDENCE_RESULT_OVERLAP',
        `Evidence result must not equal or be nested inside ${boundary.label}: ${boundary.path}`
      );
    }
  }
  return true;
}

async function staticEvidenceBoundaries(paths, packageProof) {
  const repositoryRoot = await fsp.realpath(REPOSITORY_ROOT);
  const sourceClosure = [];
  for (const relativeRoot of SOURCE_CLOSURE_ROOTS) {
    sourceClosure.push(Object.freeze({
      label: `source closure ${relativeRoot}`,
      path: await fsp.realpath(path.join(repositoryRoot, relativeRoot))
    }));
  }
  return Object.freeze([
    Object.freeze({ label: 'selected app bundle', path: paths.appPath }),
    Object.freeze({ label: 'repository root', path: repositoryRoot }),
    ...sourceClosure,
    Object.freeze({ label: 'retained package proof file', path: packageProof.path }),
    Object.freeze({ label: 'retained package proof root', path: packageProof.proofRoot })
  ]);
}

async function preflightEvidenceBoundaries(rawAppPath) {
  const repositoryRoot = await fsp.realpath(REPOSITORY_ROOT);
  const appPath = await fsp.realpath(rawAppPath);
  return Object.freeze([
    Object.freeze({ label: 'preflight selected app bundle', path: appPath }),
    Object.freeze({ label: 'preflight repository root', path: repositoryRoot })
  ]);
}

async function recheckProofRootForPublication(proof) {
  const canonicalRoot = await fsp.realpath(proof.proofRoot);
  assert.equal(canonicalRoot, proof.proofRoot);
  const stats = await fsp.lstat(canonicalRoot);
  assert.equal(stats.isDirectory(), true);
  assert.equal(stats.isSymbolicLink(), false);
  assert.equal(stats.mode & 0o777, 0o700);
  const entries = await fsp.readdir(canonicalRoot);
  assert.deepEqual(entries, [], 'The dedicated proof root changed before publication.');
  assert.equal(path.join(canonicalRoot, RESULT_FILE), proof.resultPath);
  return Object.freeze({
    proofRoot: canonicalRoot,
    mode: stats.mode & 0o777,
    entryCount: entries.length,
    resultPath: proof.resultPath
  });
}

function confinedTempChild(temporaryRoot, candidatePath) {
  const relative = path.relative(temporaryRoot, candidatePath);
  return Boolean(relative)
    && !path.isAbsolute(relative)
    && relative !== '..'
    && !relative.startsWith(`..${path.sep}`);
}

async function createIsolatedProfile() {
  const temporaryRoot = await fsp.realpath(os.tmpdir());
  const testRoot = await fsp.mkdtemp(path.join(
    temporaryRoot,
    'syncshow-packaged-operational-planning-'
  ));
  const realTestRoot = await fsp.realpath(testRoot);
  if (!confinedTempChild(temporaryRoot, realTestRoot)) {
    fail('UNSAFE_TEMP_ROOT', 'The verifier temp root escaped the OS temporary directory.');
  }
  const profilePath = path.join(realTestRoot, 'profile');
  await fsp.mkdir(profilePath, { mode: 0o700 });
  if (process.platform !== 'win32') await fsp.chmod(profilePath, 0o700);
  await fsp.writeFile(
    path.join(profilePath, ISOLATED_TEST_USER_DATA_MARKER),
    PROFILE_MARKER_SOURCE,
    { encoding: 'utf8', flag: 'wx', mode: 0o600 }
  );
  return Object.freeze({ temporaryRoot, testRoot: realTestRoot, profilePath });
}

function sha256Bytes(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

async function directorySnapshot(rootPath) {
  const records = [];
  let totalBytes = 0;

  const rootStats = await fsp.lstat(rootPath).catch(error => {
    if (error?.code === 'ENOENT') return null;
    throw error;
  });
  if (!rootStats) {
    return Object.freeze({
      exists: false,
      rootMode: null,
      entryCount: 0,
      totalBytes: 0,
      sha256: sha256Bytes(Buffer.from('[]', 'utf8')),
      records
    });
  }
  if (!rootStats.isDirectory() || rootStats.isSymbolicLink()) {
    fail('UNSAFE_SNAPSHOT_PATH', 'Snapshot root must be a real directory.');
  }

  async function walk(directoryPath, relativeDirectory = '') {
    let children;
    try {
      children = await fsp.readdir(directoryPath, { withFileTypes: true });
    } catch (error) {
      if (error?.code === 'ENOENT' && relativeDirectory === '') return false;
      throw error;
    }
    children.sort((left, right) => left.name.localeCompare(right.name, 'en'));
    for (const child of children) {
      const relativePath = relativeDirectory
        ? `${relativeDirectory}/${child.name}`
        : child.name;
      const childPath = path.join(directoryPath, child.name);
      const stats = await fsp.lstat(childPath);
      if (stats.isSymbolicLink()) {
        fail('UNSAFE_SNAPSHOT_PATH', `Snapshot path contains a symbolic link: ${relativePath}`);
      }
      if (records.length >= MAX_PROFILE_SNAPSHOT_ENTRIES) {
        fail('SNAPSHOT_TOO_LARGE', 'Snapshot entry count exceeded its bound.');
      }
      if (stats.isDirectory() && child.isDirectory()) {
        records.push({
          path: relativePath,
          kind: 'directory',
          mode: stats.mode & 0o777
        });
        await walk(childPath, relativePath);
      } else if (stats.isFile() && child.isFile()) {
        const bytes = await fsp.readFile(childPath);
        assert.equal(bytes.length, stats.size);
        totalBytes += bytes.length;
        if (totalBytes > MAX_PROFILE_SNAPSHOT_BYTES) {
          fail('SNAPSHOT_TOO_LARGE', 'Snapshot byte count exceeded its bound.');
        }
        records.push({
          path: relativePath,
          kind: 'file',
          mode: stats.mode & 0o777,
          size: bytes.length,
          sha256: sha256Bytes(bytes)
        });
      } else {
        fail('UNSAFE_SNAPSHOT_PATH', `Snapshot path has an unsupported entry: ${relativePath}`);
      }
    }
    return true;
  }

  await walk(rootPath);
  return Object.freeze({
    exists: true,
    rootMode: rootStats.mode & 0o777,
    entryCount: records.length,
    totalBytes,
    sha256: sha256Bytes(Buffer.from(JSON.stringify(records), 'utf8')),
    records
  });
}

async function externalWorkflowSnapshot(profilePath) {
  return Object.freeze({
    community: await directorySnapshot(path.join(profilePath, 'community')),
    communityMediaAttempts: await directorySnapshot(path.join(
      profilePath,
      'community-sermon-media-attempts'
    )),
    powerPointSlideCache: await directorySnapshot(path.join(profilePath, 'slide-cache'))
  });
}

function assertPrivateDirectorySnapshot(snapshot, label) {
  if (!snapshot.exists) return snapshot;
  assert.equal(snapshot.rootMode, 0o700, `${label} root mode changed.`);
  assert.equal(
    snapshot.records
      .filter(record => record.kind === 'directory')
      .every(record => record.mode === 0o700),
    true,
    `${label} contains a non-private managed directory.`
  );
  return snapshot;
}

async function durableWorkflowSnapshot(profilePath) {
  const snapshots = {
    projects: await directorySnapshot(path.join(profilePath, 'service-projects')),
    preparedService: await directorySnapshot(path.join(profilePath, 'prepared-service')),
    showPackages: await directorySnapshot(path.join(profilePath, 'show-packages')),
    songLibrary: await directorySnapshot(path.join(profilePath, 'song-library'))
  };
  for (const [name, snapshot] of Object.entries(snapshots)) {
    assertPrivateDirectorySnapshot(snapshot, `durable ${name}`);
  }
  return Object.freeze(snapshots);
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

function serializeError(error) {
  return {
    name: error?.name || 'Error',
    code: typeof error?.code === 'string' ? error.code : null,
    message: error?.message || String(error),
    stack: typeof error?.stack === 'string' ? error.stack : null
  };
}

function processGroupState(launch) {
  const processGroupId = launch?.processGroupId;
  if (
    launch?.processGroupBound !== true
    || !Number.isSafeInteger(processGroupId)
    || processGroupId <= 1
    || processGroupId === process.pid
    || launch?.pid !== processGroupId
  ) {
    return {
      processGroupId: processGroupId || null,
      status: 'absence-unproven',
      absent: false,
      error: 'invalid or unsafe process-group id'
    };
  }
  try {
    process.kill(-processGroupId, 0);
    return { processGroupId, status: 'present', absent: false, error: null };
  } catch (error) {
    if (error?.code === 'ESRCH') {
      return { processGroupId, status: 'absent', absent: true, error: null };
    }
    return {
      processGroupId,
      status: 'absence-unproven',
      absent: false,
      error: `${error?.code || error?.name || 'Error'}: ${error?.message || error}`
    };
  }
}

function signalProcessGroup(launch, signal) {
  const before = processGroupState(launch);
  if (before.absent || before.status === 'absence-unproven') {
    return { ...before, signal, sent: false };
  }
  try {
    process.kill(-launch.processGroupId, signal);
    return {
      processGroupId: launch.processGroupId,
      status: 'signal-sent',
      absent: false,
      signal,
      sent: true,
      error: null
    };
  } catch (error) {
    if (error?.code === 'ESRCH') {
      return {
        processGroupId: launch.processGroupId,
        status: 'absent',
        absent: true,
        signal,
        sent: false,
        error: null
      };
    }
    return {
      processGroupId: launch.processGroupId,
      status: 'absence-unproven',
      absent: false,
      signal,
      sent: false,
      error: `${error?.code || error?.name || 'Error'}: ${error?.message || error}`
    };
  }
}

async function waitForProcessGroupAbsent(launch, timeoutMs) {
  const startedAt = Date.now();
  let state = processGroupState(launch);
  while (!state.absent && Date.now() - startedAt < timeoutMs) {
    await delay(50);
    state = processGroupState(launch);
  }
  const result = Object.freeze({
    ...state,
    status: state.absent
      ? 'absent'
      : state.status === 'present'
        ? 'present-after-timeout'
        : 'absence-unproven',
    checkedAt: new Date().toISOString(),
    waitedMs: Date.now() - startedAt
  });
  launch.processGroupAbsence = result;
  return result;
}

function cancellationError(cancellation, label = 'the packaged verification') {
  return new PackagedPlanningVerificationError(
    'VERIFIER_CANCELLED',
    `${label} was cancelled by ${cancellation.signal || 'a termination signal'}.`
  );
}

function throwIfCancelled(cancellation, label) {
  if (cancellation?.requested) throw cancellationError(cancellation, label);
}

async function raceCancellation(promise, cancellation, label) {
  throwIfCancelled(cancellation, label);
  if (!cancellation) return promise;
  return Promise.race([
    promise,
    cancellation.requestedPromise.then(() => {
      throw cancellationError(cancellation, label);
    })
  ]);
}

function createCancellationController(launches) {
  let resolveRequested;
  const cancellation = {
    requested: false,
    signal: null,
    requestedAt: null,
    groupSignalAttempts: [],
    handlersRemoved: false,
    requestedPromise: new Promise(resolve => {
      resolveRequested = resolve;
    })
  };
  const handlers = new Map();
  const request = signal => {
    if (!cancellation.requested) {
      cancellation.requested = true;
      cancellation.signal = signal;
      cancellation.requestedAt = new Date().toISOString();
      resolveRequested(signal);
    }
    for (const launch of launches) {
      if (launch.processGroupAbsence?.absent) continue;
      cancellation.groupSignalAttempts.push({
        phase: launch.phase,
        requestedBy: signal,
        at: new Date().toISOString(),
        ...signalProcessGroup(launch, 'SIGTERM')
      });
    }
  };
  cancellation.request = request;
  for (const signal of ['SIGINT', 'SIGTERM']) {
    const handler = () => request(signal);
    handlers.set(signal, handler);
    process.on(signal, handler);
  }
  cancellation.dispose = () => {
    if (cancellation.handlersRemoved) return;
    for (const [signal, handler] of handlers) process.removeListener(signal, handler);
    cancellation.handlersRemoved = true;
  };
  cancellation.evidence = () => ({
    requested: cancellation.requested,
    signal: cancellation.signal,
    requestedAt: cancellation.requestedAt,
    groupSignalAttempts: cancellation.groupSignalAttempts,
    handlersRemoved: cancellation.handlersRemoved
  });
  return cancellation;
}

async function prepareDevToolsActivePort(profilePath, phase, priorLaunch = null) {
  await assertDirectDirectory(profilePath, 'isolated profile before DevTools launch');
  if (phase === 'restart') {
    assert.equal(
      priorLaunch?.processGroupAbsence?.absent,
      true,
      'The first packaged process group must be absent before clearing its DevTools port file.'
    );
  }
  const portPath = path.join(profilePath, 'DevToolsActivePort');
  const before = await fsp.lstat(portPath).catch(error => {
    if (error?.code === 'ENOENT') return null;
    throw error;
  });
  if (!before) {
    return Object.freeze({
      phase,
      path: portPath,
      status: 'absent-before-launch',
      staleFileRemoved: false
    });
  }
  if (phase !== 'restart') {
    fail(
      'UNEXPECTED_DEVTOOLS_PORT_FILE',
      'DevToolsActivePort existed before the first isolated packaged launch.'
    );
  }
  const stale = await readDirectFile(
    portPath,
    4096,
    'stale restart DevToolsActivePort'
  );
  assert.equal(stale.mode & 0o133, 0, 'Stale DevToolsActivePort permissions are unsafe.');
  const lines = stale.bytes.toString('utf8').split(/\r?\n/u);
  assert.match(lines[0] || '', /^\d{1,5}$/u);
  const stalePort = Number.parseInt(lines[0], 10);
  assert.equal(stalePort >= 1 && stalePort <= 65535, true);
  assert.match(lines[1] || '', /^\/devtools\/browser\/[A-Za-z0-9._-]+$/u);
  await fsp.unlink(portPath);
  await fsyncDirectory(profilePath);
  const after = await fsp.lstat(portPath).catch(error => {
    if (error?.code === 'ENOENT') return null;
    throw error;
  });
  assert.equal(after, null, 'The stale DevToolsActivePort file was not removed.');
  return Object.freeze({
    phase,
    path: portPath,
    status: 'stale-file-removed-before-restart',
    staleFileRemoved: true,
    staleMode: stale.mode,
    staleSize: stale.size,
    staleSha256: stale.sha256
  });
}

function launchPackagedApp(paths, profilePath, phase, cancellation) {
  throwIfCancelled(cancellation, `launching packaged ${phase}`);
  const environment = { ...process.env };
  delete environment.ELECTRON_RUN_AS_NODE;
  delete environment.NODE_OPTIONS;
  delete environment.NODE_PATH;
  delete environment.SYNCSHOW_GOOGLE_CLIENT_ID;
  delete environment.SYNCSHOW_GOOGLE_CLIENT_SECRET;
  delete environment.SYNCSHOW_GOOGLE_API_KEY;
  delete environment.SYNCSHOW_PACKAGE_GOOGLE_DRIVE_CONFIG;
  environment.SYNCSHOW_TEST_USER_DATA_DIR = profilePath;

  const args = [
    '--syncshow-test-user-data',
    `--user-data-dir=${profilePath}`,
    '--remote-debugging-port=0',
    '--remote-debugging-address=127.0.0.1',
    '--remote-allow-origins=*'
  ];
  const detached = true;
  const child = spawn(paths.executablePath, args, {
    cwd: path.dirname(paths.appPath),
    detached,
    env: environment,
    stdio: ['ignore', 'pipe', 'pipe']
  });
  const stdout = boundedCollector(child.stdout);
  const stderr = boundedCollector(child.stderr);
  const processGroupId = Number.isSafeInteger(child.pid) ? child.pid : null;
  const launch = {
    phase,
    child,
    args,
    pid: child.pid,
    processGroupId,
    processGroupBound: process.platform === 'darwin'
      && detached
      && Number.isSafeInteger(child.pid)
      && child.pid === processGroupId,
    processGroupAbsence: null,
    cancellation,
    startedAt: new Date().toISOString(),
    spawnError: null,
    exit: null,
    stdout,
    stderr
  };
  launch.closed = new Promise(resolve => {
    child.once('close', (code, signal) => {
      launch.exit = {
        code,
        signal: signal || null,
        finishedAt: new Date().toISOString()
      };
      resolve(launch.exit);
    });
  });
  child.once('error', error => {
    launch.spawnError = serializeError(error);
  });
  return launch;
}

function delay(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

async function withTimeout(promise, timeoutMs, message, cancellation = null) {
  let timer;
  try {
    return await raceCancellation(Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
      })
    ]), cancellation, message);
  } finally {
    clearTimeout(timer);
  }
}

async function waitFor(callback, label, launch, timeoutMs = UI_TIMEOUT_MS) {
  const startedAt = Date.now();
  let lastError = null;
  while (Date.now() - startedAt < timeoutMs) {
    throwIfCancelled(launch?.cancellation, `waiting for ${label}`);
    if (launch?.spawnError) {
      fail('PACKAGED_APP_SPAWN_FAILED', launch.spawnError.message);
    }
    if (launch?.exit) {
      fail(
        'PACKAGED_APP_EXITED_EARLY',
        `${phaseLabel(launch)} exited before ${label}; code ${launch.exit.code}, signal ${launch.exit.signal || 'none'}.`
      );
    }
    try {
      const value = await raceCancellation(
        Promise.resolve().then(callback),
        launch?.cancellation,
        `waiting for ${label}`
      );
      if (value !== null && value !== undefined) {
        if (value === false || value === 0 || value === '') {
          fail(
            'INVALID_WAIT_RESULT',
            `Wait callback for ${label} returned a falsy value instead of explicit null.`
          );
        }
        return value;
      }
    } catch (error) {
      if (error?.retryableWait !== true) throw error;
      lastError = error;
    }
    await raceCancellation(
      delay(75),
      launch?.cancellation,
      `waiting for ${label}`
    );
  }
  const detail = lastError ? ` Last error: ${lastError.message}` : '';
  fail('VERIFIER_TIMEOUT', `Timed out waiting for ${label}.${detail}`);
}

function phaseLabel(launch) {
  return launch?.phase ? `Packaged ${launch.phase}` : 'The packaged app';
}

async function readDevToolsEndpoint(profilePath, launch) {
  const portFile = path.join(profilePath, 'DevToolsActivePort');
  return waitFor(async () => {
    let source = '';
    let file;
    const visibleStats = await fsp.lstat(portFile).catch(error => {
      if (error?.code === 'ENOENT') return null;
      throw error;
    });
    if (!visibleStats) return null;
    if (
      visibleStats.isFile()
      && !visibleStats.isSymbolicLink()
      && visibleStats.size === 0
    ) return null;
    try {
      file = await readDirectFile(portFile, 4096, 'active DevToolsActivePort');
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      file = null;
    }
    if (file) {
      if ((file.mode & 0o133) !== 0) {
        fail('UNSAFE_DEVTOOLS_PORT_FILE', 'DevToolsActivePort permissions are unsafe.');
      }
      source = file.bytes.toString('utf8');
    }
    let port = Number.parseInt(source.split(/\r?\n/u)[0], 10);
    let browserWebSocketPath = source.split(/\r?\n/u)[1] || '';
    if (!Number.isSafeInteger(port) || port < 1 || port > 65535) {
      const match = launch.stderr().match(
        /DevTools listening on ws:\/\/(?:127\.0\.0\.1|localhost):(\d+)(\/devtools\/browser\/[^\s]+)/u
      );
      if (!match) return null;
      port = Number.parseInt(match[1], 10);
      browserWebSocketPath = match[2];
    }
    if (!/^\/devtools\/browser\/[A-Za-z0-9._-]+$/u.test(browserWebSocketPath)) {
      return null;
    }
    return { port, browserWebSocketPath };
  }, 'the loopback DevToolsActivePort endpoint', launch, DISCOVERY_TIMEOUT_MS);
}

async function fetchJson(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 3000);
  try {
    let response;
    try {
      response = await fetch(url, { signal: controller.signal });
    } catch (cause) {
      throw new RetryableDiscoveryTransportError(
        `DevTools discovery transport failed for ${url}.`,
        cause
      );
    }
    if (!response.ok) {
      throw new RetryableDiscoveryTransportError(
        `DevTools discovery returned HTTP ${response.status}.`
      );
    }
    let source;
    try {
      source = await response.text();
    } catch (cause) {
      throw new RetryableDiscoveryTransportError(
        'DevTools discovery response transport ended before its body was complete.',
        cause
      );
    }
    if (Buffer.byteLength(source, 'utf8') > MAX_HTTP_BYTES) {
      fail('DEVTOOLS_RESPONSE_TOO_LARGE', 'DevTools target response exceeded its byte limit.');
    }
    try {
      return JSON.parse(source);
    } catch (cause) {
      throw new RetryableDiscoveryTransportError(
        'DevTools discovery returned incomplete or invalid JSON.',
        cause
      );
    }
  } finally {
    clearTimeout(timer);
  }
}

async function discoverControlTarget(paths, profilePath, launch) {
  const endpoint = await readDevToolsEndpoint(profilePath, launch);
  const origin = `http://127.0.0.1:${endpoint.port}`;
  const discovered = await waitFor(async () => {
    const targets = await fetchJson(`${origin}/json/list`);
    if (!Array.isArray(targets)) {
      fail('INVALID_DEVTOOLS_TARGET_LIST', 'DevTools target list is not an array.');
    }
    const pages = targets.filter(target => target?.type === 'page');
    const outputPages = pages.filter(target =>
      /\/src\/renderer\/(?:display|singer)\.html(?:$|[?#])/u.test(target.url || '')
    );
    if (outputPages.length !== 0) {
      fail('UNEXPECTED_OUTPUT_WINDOW', 'An output renderer existed during the no-Show package proof.');
    }
    const control = pages.find(target => target.url === paths.expectedControlUrl);
    if (!control || typeof control.webSocketDebuggerUrl !== 'string') return null;
    return { control, pageCount: pages.length, outputPageCount: outputPages.length };
  }, 'the exact packaged control renderer target', launch, DISCOVERY_TIMEOUT_MS);
  return Object.freeze({ endpoint, origin, ...discovered });
}

class CdpSession {
  constructor(webSocketUrl, cancellation = null) {
    this.webSocketUrl = webSocketUrl;
    this.cancellation = cancellation;
    this.socket = null;
    this.nextId = 1;
    this.pending = new Map();
  }

  async connect() {
    if (typeof WebSocket !== 'function') {
      fail('WEBSOCKET_UNAVAILABLE', 'Node.js WebSocket support is required for CDP.');
    }
    const socket = new WebSocket(this.webSocketUrl);
    this.socket = socket;
    socket.addEventListener('message', event => this.handleMessage(event));
    socket.addEventListener('close', () => this.rejectPending(
      new Error('The packaged renderer CDP connection closed.')
    ));
    socket.addEventListener('error', () => this.rejectPending(
      new Error('The packaged renderer CDP connection failed.')
    ));
    await withTimeout(new Promise((resolve, reject) => {
      socket.addEventListener('open', resolve, { once: true });
      socket.addEventListener('error', reject, { once: true });
    }), CDP_CALL_TIMEOUT_MS, 'Timed out connecting to packaged renderer CDP.', this.cancellation);
    await this.call('Runtime.enable');
    await this.call('Page.enable');
    return this;
  }

  handleMessage(event) {
    let message;
    try {
      message = JSON.parse(String(event.data));
    } catch (_error) {
      return;
    }
    if (!Number.isSafeInteger(message.id)) return;
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    clearTimeout(pending.timer);
    if (message.error) {
      pending.reject(new Error(
        `${pending.method} failed: ${message.error.message || 'unknown CDP error'}`
      ));
    } else {
      pending.resolve(message.result || {});
    }
  }

  rejectPending(error) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  call(method, params = {}, timeoutMs = CDP_CALL_TIMEOUT_MS) {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error(`CDP is not connected for ${method}.`));
    }
    const id = this.nextId++;
    return raceCancellation(new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Timed out waiting for ${method}.`));
      }, timeoutMs);
      this.pending.set(id, { method, resolve, reject, timer });
      this.socket.send(JSON.stringify({ id, method, params }));
    }), this.cancellation, `waiting for CDP ${method}`);
  }

  async evaluate(expression) {
    let response;
    try {
      response = await this.call('Runtime.evaluate', {
        expression,
        awaitPromise: true,
        returnByValue: true,
        allowUnsafeEvalBlockedByCSP: true
      });
    } catch (cause) {
      if (cause instanceof PackagedPlanningVerificationError) throw cause;
      throw new FatalCdpEvaluationError(
        'CDP_EVALUATION_CALL_FAILED',
        `Runtime.evaluate failed: ${cause?.message || cause}`,
        cause
      );
    }
    if (response.exceptionDetails) {
      const description = response.exceptionDetails.exception?.description
        || response.exceptionDetails.text
        || 'Renderer evaluation failed.';
      throw new FatalCdpEvaluationError(
        'CDP_EVALUATION_EXCEPTION',
        description
      );
    }
    return response.result?.value;
  }

  close() {
    if (!this.socket) return;
    try {
      this.socket.close();
    } catch (_error) {
      // The page commonly closes the CDP socket before the controller can.
    }
    this.socket = null;
  }
}

async function waitForEvaluation(cdp, expression, label, launch, timeoutMs = UI_TIMEOUT_MS) {
  return waitFor(
    async () => cdp.evaluate(expression),
    label,
    launch,
    timeoutMs
  );
}

async function connectPackagedControl(paths, profilePath, launch) {
  const discovery = await discoverControlTarget(paths, profilePath, launch);
  const cdp = await new CdpSession(
    discovery.control.webSocketDebuggerUrl,
    launch.cancellation
  ).connect();
  const surface = await waitForEvaluation(cdp, `
    (() => {
      const isVisible = ${IN_PAGE_VISIBLE_PREDICATE};
      const controlSurface = document.querySelector('.app-container');
      const stagePrepare = document.querySelector('#btnStagePrepare');
      if (
        document.readyState !== 'complete'
        || location.href !== ${JSON.stringify(paths.expectedControlUrl)}
        || typeof window.api?.getAppState !== 'function'
        || !isVisible(controlSurface)
        || !isVisible(stagePrepare)
      ) return null;
      return {
        url: location.href,
        title: document.title,
        hasTrustedPreloadApi: true,
        bodyClass: document.body.className
      };
    })()
  `, 'the packaged control renderer and trusted preload bridge', launch);
  return { cdp, discovery, surface };
}

function projectStateEvidence(stored) {
  return {
    projectId: stored.project.id,
    title: stored.project.title,
    projectRevision: stored.project.revision,
    revisionId: stored.revisionId,
    planningStatus: stored.project.planning.status
  };
}

function projectedAppState(appState) {
  return {
    currentSlide: appState.currentSlide,
    totalSlides: appState.totalSlides,
    displayCount: Array.isArray(appState.displays) ? appState.displays.length : -1,
    preparedServiceRestore: appState.preparedServiceRestore,
    serviceHandoff: appState.serviceHandoff
      ? {
          projectId: appState.serviceHandoff.project?.id,
          projectRevision: appState.serviceHandoff.project?.revision,
          projectRevisionId: appState.serviceHandoff.project?.revisionId,
          planningStatus: appState.serviceHandoff.planning?.status,
          cueCount: appState.serviceHandoff.cueIds?.length
        }
      : null,
    presentations: appState.presentations,
    showState: appState.showState
  };
}

function assertIdleNoDisplayBoundary(appState) {
  assert.equal(Array.isArray(appState.displays), true);
  assert.equal(
    appState.displays.length,
    1,
    'This bounded verifier requires exactly one operator display and must not start Show.'
  );
  assert.equal(appState.showState?.phase, 'idle');
  assert.equal(appState.showState?.outputSessionId, null);
}

function assertExactObjectKeys(value, expectedKeys, label) {
  assert.equal(Boolean(value && typeof value === 'object' && !Array.isArray(value)), true);
  assert.deepEqual(Object.keys(value).sort(), [...expectedKeys].sort(), `${label} keys changed.`);
}

function assertPreparedLoadState(appState) {
  assertIdleNoDisplayBoundary(appState);
  assert.equal(
    appState.totalSlides,
    0,
    'Load must keep the live Show slide counter at zero until Show starts.'
  );
  assert.equal(Array.isArray(appState.serviceHandoff?.cueIds), true);
  assert.equal(
    appState.serviceHandoff.cueIds.length,
    EXPECTED_PREPARED_CUE_COUNT
  );
  assertExactObjectKeys(
    appState.presentations,
    EXPECTED_PREPARED_ROLE_IDS,
    'prepared Load presentations'
  );
  for (const roleId of EXPECTED_PREPARED_ROLE_IDS) {
    assert.equal(appState.presentations[roleId]?.loaded, true);
    assert.equal(
      appState.presentations[roleId]?.slideCount,
      EXPECTED_PREPARED_CUE_COUNT
    );
  }
}

function statIdentity(stats) {
  return {
    dev: stats.dev,
    ino: stats.ino,
    mode: stats.mode,
    size: stats.size,
    mtimeMs: stats.mtimeMs
  };
}

async function assertDirectDirectory(directoryPath, label, expectedMode = 0o700) {
  const stats = await fsp.lstat(directoryPath);
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    fail('UNSAFE_DIRECT_DIRECTORY', `${label} must be a real directory.`);
  }
  assert.equal(await fsp.realpath(directoryPath), directoryPath);
  assert.equal(stats.mode & 0o777, expectedMode, `${label} mode changed.`);
  return Object.freeze({
    path: directoryPath,
    mode: stats.mode & 0o777
  });
}

async function readDirectFile(filePath, maximumBytes, label) {
  const before = await fsp.lstat(filePath);
  if (
    !before.isFile()
    || before.isSymbolicLink()
    || before.size < 1
    || before.size > maximumBytes
  ) {
    fail('UNSAFE_DIRECT_READ', `${label} must be a bounded regular file.`);
  }
  assert.equal(await fsp.realpath(filePath), filePath);
  const noFollowFlags = fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW;
  const handle = await fsp.open(filePath, noFollowFlags);
  try {
    const opened = await handle.stat();
    assert.deepEqual(statIdentity(opened), statIdentity(before));
    const bytes = await handle.readFile();
    assert.equal(bytes.length, before.size);
    const afterHandle = await handle.stat();
    assert.deepEqual(statIdentity(afterHandle), statIdentity(before));
    const afterPath = await fsp.lstat(filePath);
    assert.deepEqual(statIdentity(afterPath), statIdentity(before));
    return Object.freeze({
      path: filePath,
      mode: before.mode & 0o777,
      size: bytes.length,
      sha256: sha256Bytes(bytes),
      statIdentity: Object.freeze(statIdentity(before)),
      bytes
    });
  } finally {
    await handle.close();
  }
}

async function readDirectJson(filePath, maximumBytes, label) {
  const file = await readDirectFile(filePath, maximumBytes, label);
  const source = file.bytes.toString('utf8');
  let value;
  try {
    value = JSON.parse(source);
  } catch (cause) {
    fail('INVALID_DIRECT_JSON', `${label} is not valid JSON.`, cause);
  }
  return Object.freeze({ ...file, bytes: undefined, source, value });
}

function projectStorageDirectory(profilePath, projectId) {
  const storageKey = crypto.createHash('sha256').update(String(projectId)).digest('hex');
  return path.join(profilePath, 'service-projects', `project-${storageKey}`);
}

async function inspectSeededPlanningStorage(profilePath, expectedStorage) {
  assert.equal(Boolean(expectedStorage?.pointer && expectedStorage?.revision), true);
  const projectDirectory = projectStorageDirectory(profilePath, READY_PROJECT_ID);
  assert.equal(path.basename(projectDirectory), READY_PROJECT_STORAGE_DIRECTORY);
  await assertDirectDirectory(profilePath, 'seeded isolated profile root');
  await assertDirectDirectory(path.join(profilePath, 'service-projects'), 'seeded projects root');
  await assertDirectDirectory(projectDirectory, 'seeded project directory');
  await assertDirectDirectory(
    path.join(projectDirectory, 'revisions'),
    'seeded project revisions directory'
  );
  const pointerPath = path.join(projectDirectory, 'current.json');
  const revisionPath = path.join(
    projectDirectory,
    'revisions',
    `${expectedStorage.revision.sha256}.json`
  );
  assert.equal(expectedStorage.pointer.path, pointerPath);
  assert.equal(expectedStorage.revision.path, revisionPath);
  const pointer = await readDirectJson(pointerPath, 64 * 1024, 'seeded planning pointer');
  const revision = await readDirectJson(
    revisionPath,
    MAX_DIRECT_JSON_BYTES,
    'seeded immutable planning revision'
  );
  for (const [actual, expected, label] of [
    [pointer, expectedStorage.pointer, 'seeded pointer'],
    [revision, expectedStorage.revision, 'seeded revision']
  ]) {
    assert.equal(actual.mode, 0o600, `${label} mode changed.`);
    assert.equal(actual.size, expected.size, `${label} size changed.`);
    assert.equal(actual.sha256, expected.sha256, `${label} hash changed.`);
    assert.equal(actual.source, expected.source, `${label} bytes changed.`);
    assert.deepEqual(actual.statIdentity, expected.statIdentity, `${label} identity changed.`);
    assert.deepEqual(actual.value, expected.value, `${label} value changed.`);
  }
  assert.equal(revision.sha256, expectedStorage.revision.sha256);
  return Object.freeze({
    pointer: Object.freeze({
      path: pointer.path,
      mode: pointer.mode,
      size: pointer.size,
      sha256: pointer.sha256,
      statIdentity: pointer.statIdentity
    }),
    revision: Object.freeze({
      path: revision.path,
      mode: revision.mode,
      size: revision.size,
      sha256: revision.sha256,
      statIdentity: revision.statIdentity
    }),
    exactSeededStorageIdentity: true
  });
}

async function inspectSeededPlanningRevision(profilePath, expectedRevision) {
  const expectedPath = path.join(
    projectStorageDirectory(profilePath, READY_PROJECT_ID),
    'revisions',
    `${expectedRevision.sha256}.json`
  );
  assert.equal(expectedRevision.path, expectedPath);
  const revision = await readDirectJson(
    expectedPath,
    MAX_DIRECT_JSON_BYTES,
    'retained immutable seeded planning revision'
  );
  assert.equal(revision.mode, 0o600);
  assert.equal(revision.size, expectedRevision.size);
  assert.equal(revision.sha256, expectedRevision.sha256);
  assert.equal(revision.source, expectedRevision.source);
  assert.deepEqual(revision.statIdentity, expectedRevision.statIdentity);
  assert.deepEqual(revision.value, expectedRevision.value);
  return Object.freeze({
    path: revision.path,
    mode: revision.mode,
    size: revision.size,
    sha256: revision.sha256,
    statIdentity: revision.statIdentity,
    exactSeededRevisionIdentity: true
  });
}

function assertReadyContinuity(planningStored, readyStored) {
  const planning = planningStored?.project;
  const ready = readyStored?.project;
  assert.equal(Boolean(planning && ready), true);
  assert.equal(planning.revision, 3);
  assert.equal(planning.planning?.status, 'planning');
  assert.equal(ready.revision, planning.revision + 1);
  assert.equal(ready.revision, 4);
  assert.equal(ready.planning?.status, 'ready');
  assert.notEqual(readyStored.revisionId, planningStored.revisionId);
  assert.equal(readyStored.pointer?.value?.updatedAt, ready.updatedAt);
  for (const timestamp of [planning.updatedAt, ready.updatedAt]) {
    assert.equal(new Date(timestamp).toISOString(), timestamp);
  }
  assert.equal(Date.parse(ready.updatedAt) >= Date.parse(planning.updatedAt), true);
  const normalizedReady = structuredClone(ready);
  normalizedReady.revision = planning.revision;
  normalizedReady.updatedAt = planning.updatedAt;
  normalizedReady.planning.status = planning.planning.status;
  assert.deepEqual(
    normalizedReady,
    planning,
    'Ready changed seeded project content beyond revision, updatedAt, and planning status.'
  );
  return Object.freeze({
    fromRevision: planning.revision,
    toRevision: ready.revision,
    fromStatus: planning.planning.status,
    toStatus: ready.planning.status,
    onlyIntendedReadyTransition: true
  });
}

async function inspectStoredReadyProject(profilePath, expectedPlanningPointer) {
  const projectDirectory = projectStorageDirectory(profilePath, READY_PROJECT_ID);
  assert.equal(path.basename(projectDirectory), READY_PROJECT_STORAGE_DIRECTORY);
  await assertDirectDirectory(profilePath, 'isolated profile root');
  await assertDirectDirectory(
    path.join(profilePath, 'service-projects'),
    'service-projects root'
  );
  await assertDirectDirectory(projectDirectory, 'ready project directory');
  await assertDirectDirectory(
    path.join(projectDirectory, 'revisions'),
    'ready project revisions directory'
  );
  const pointer = await readDirectJson(
    path.join(projectDirectory, 'current.json'),
    64 * 1024,
    'ready project current pointer'
  );
  assertExactObjectKeys(
    pointer.value,
    ['schemaVersion', 'projectId', 'revisionId', 'projectRevision', 'updatedAt', 'reason'],
    'ready project current pointer'
  );
  assert.equal(pointer.value.schemaVersion, 1);
  assert.equal(pointer.value.projectId, READY_PROJECT_ID);
  assert.match(pointer.value.revisionId, SHA256_PATTERN);
  assert.equal(pointer.value.projectRevision, 4);
  assert.equal(pointer.value.reason, 'prepare-planning-status');
  assert.equal(pointer.mode, 0o600);

  const backup = await readDirectFile(
    path.join(projectDirectory, 'current.json.bak'),
    64 * 1024,
    'ready project previous pointer'
  );
  assert.equal(backup.size, expectedPlanningPointer.size);
  assert.equal(backup.sha256, expectedPlanningPointer.sha256);
  assert.equal(backup.bytes.toString('utf8'), expectedPlanningPointer.source);
  assert.equal(backup.mode, 0o600);

  const revision = await readDirectJson(
    path.join(
      projectDirectory,
      'revisions',
      `${pointer.value.revisionId}.json`
    ),
    MAX_DIRECT_JSON_BYTES,
    'ready immutable project revision'
  );
  assert.equal(revision.sha256, pointer.value.revisionId);
  assert.equal(revision.mode, 0o600);
  assert.equal(revision.value.schemaVersion, 1);
  assert.equal(revision.value.kind, 'syncshow-service-project');
  assert.equal(revision.value.id, READY_PROJECT_ID);
  assert.equal(revision.value.title, NATIVE_WEEKLY_TITLE);
  assert.equal(revision.value.revision, 4);
  assert.equal(revision.value.planning?.status, 'ready');
  assert.doesNotMatch(
    JSON.stringify(revision.value),
    /\.pptx?\b|imported-deck|legacy-deck/iu
  );
  return Object.freeze({
    project: revision.value,
    revisionId: pointer.value.revisionId,
    projectRevision: revision.value.revision,
    planningStatus: revision.value.planning.status,
    pointer: Object.freeze({
      sha256: pointer.sha256,
      mode: pointer.mode,
      size: pointer.size,
      value: pointer.value
    }),
    previousPointer: Object.freeze({
      sha256: backup.sha256,
      mode: backup.mode,
      size: backup.size,
      byteEqualToSeededRevision3Pointer: true
    }),
    revisionFile: Object.freeze({
      sha256: revision.sha256,
      mode: revision.mode,
      size: revision.size
    })
  });
}

function safePackageRelativePath(relativePath) {
  if (
    typeof relativePath !== 'string'
    || !relativePath
    || path.posix.isAbsolute(relativePath)
    || relativePath.includes('\\')
    || path.posix.normalize(relativePath) !== relativePath
    || relativePath === '..'
    || relativePath.startsWith('../')
    || !/^[A-Za-z0-9._/-]+$/u.test(relativePath)
  ) {
    fail('UNSAFE_PACKAGE_ARTIFACT_PATH', `Unsafe package artifact path: ${relativePath}`);
  }
  return relativePath;
}

async function directPackageManifest(packagePath) {
  const records = [];
  let totalBytes = 0;
  async function visit(directoryPath, relativeDirectory = '') {
    const entries = await fsp.readdir(directoryPath, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name, 'en'));
    for (const entry of entries) {
      const relative = relativeDirectory
        ? `${relativeDirectory}/${entry.name}`
        : entry.name;
      safePackageRelativePath(relative);
      const absolute = path.join(directoryPath, entry.name);
      const stats = await fsp.lstat(absolute);
      if (stats.isSymbolicLink()) {
        fail('UNSAFE_PACKAGE_ENTRY', `Show package contains a symbolic link: ${relative}`);
      }
      if (records.length >= MAX_DIRECT_PACKAGE_FILES) {
        fail('DIRECT_PACKAGE_TOO_LARGE', 'Show package entry count exceeded its bound.');
      }
      if (stats.isDirectory() && entry.isDirectory()) {
        records.push({ path: relative, type: 'directory', mode: stats.mode & 0o777 });
        await visit(absolute, relative);
      } else if (stats.isFile() && entry.isFile()) {
        const file = await readDirectFile(
          absolute,
          MAX_DIRECT_PACKAGE_BYTES - totalBytes,
          `Show package artifact ${relative}`
        );
        totalBytes += file.size;
        records.push({
          path: relative,
          type: 'file',
          mode: file.mode,
          size: file.size,
          sha256: file.sha256
        });
      } else {
        fail('UNSAFE_PACKAGE_ENTRY', `Show package contains an unsupported entry: ${relative}`);
      }
    }
  }
  const rootStats = await fsp.lstat(packagePath);
  assert.equal(rootStats.isDirectory(), true);
  assert.equal(rootStats.isSymbolicLink(), false);
  assert.equal(await fsp.realpath(packagePath), packagePath);
  await visit(packagePath);
  records.sort((left, right) => left.path.localeCompare(right.path, 'en'));
  assert.equal(new Set(records.map(record => record.path)).size, records.length);
  return Object.freeze({
    rootMode: rootStats.mode & 0o777,
    entryCount: records.length,
    fileCount: records.filter(record => record.type === 'file').length,
    directoryCount: records.filter(record => record.type === 'directory').length,
    totalBytes,
    recordsSha256: recordsDigest(records),
    records
  });
}

async function inspectPublishedPackage(paths, profilePath, readyStored) {
  await assertDirectDirectory(
    path.join(profilePath, 'prepared-service'),
    'prepared-service root'
  );
  await assertDirectDirectory(
    path.join(profilePath, 'show-packages'),
    'show-packages root'
  );
  const pointerRead = await readDirectJson(
    path.join(profilePath, 'prepared-service', 'current.json'),
    16 * 1024,
    'prepared-service current pointer'
  );
  const pointer = pointerRead.value;
  assert.equal(pointerRead.mode, 0o600);
  assertExactObjectKeys(pointer, [
    'schemaVersion',
    'kind',
    'packageId',
    'packageManifestSha256',
    'projectId',
    'projectRevisionId',
    'projectRevision',
    'serviceDate',
    'venueProfileId',
    'venueProfileRevisionId',
    'activationId',
    'activatedAt'
  ], 'prepared-service current pointer');
  assert.equal(pointer.schemaVersion, 1);
  assert.equal(pointer.kind, 'syncshow-current-show-package');
  assert.equal(pointer.projectId, READY_PROJECT_ID);
  assert.equal(pointer.projectRevision, readyStored.projectRevision);
  assert.equal(pointer.projectRevisionId, readyStored.revisionId);
  assert.match(pointer.packageId, SHOW_PACKAGE_PATTERN);
  assert.match(pointer.packageManifestSha256, SHA256_PATTERN);

  const packagePath = path.join(profilePath, 'show-packages', pointer.packageId);
  const files = await directPackageManifest(packagePath);
  assert.equal(files.rootMode, 0o700);
  assert.equal(
    files.records
      .filter(record => record.type === 'directory')
      .every(record => record.mode === 0o700),
    true
  );
  const fileByPath = new Map(
    files.records
      .filter(record => record.type === 'file')
      .map(record => [record.path, record])
  );
  const manifestRead = await readDirectJson(
    path.join(packagePath, 'manifest.json'),
    MAX_DIRECT_JSON_BYTES,
    'native Show package manifest'
  );
  const manifest = manifestRead.value;
  assert.equal(manifestRead.mode, 0o600);
  assert.equal(manifestRead.sha256, pointer.packageManifestSha256);
  assert.equal(fileByPath.get('manifest.json')?.sha256, manifestRead.sha256);
  assert.equal(manifest.schemaVersion, 3);
  assert.equal(manifest.kind, 'syncshow-show-package');
  assert.equal(manifest.id, pointer.packageId);
  assert.equal(manifest.projectId, READY_PROJECT_ID);
  assert.equal(manifest.projectRevision, readyStored.projectRevision);
  assert.equal(manifest.projectRevisionId, readyStored.revisionId);
  assert.equal(manifest.projectContentHash, readyStored.revisionId);
  assert.equal(manifest.compilerVersion, 3);
  assert.equal(manifest.rendererVersion, 8);
  assert.equal(manifest.cueCount, 9);
  assert.equal(Array.isArray(manifest.cueIds), true);
  assert.equal(manifest.cueIds.length, 9);
  assert.equal(new Set(manifest.cueIds).size, 9);
  assert.equal(manifest.cueIds.every(cueId => /^cue-[a-f0-9]{24}$/u.test(cueId)), true);
  assert.match(manifest.font?.sha256, SHA256_PATTERN);
  assert.equal(manifest.font.family, 'Noto Sans');
  assert.equal(manifest.font.license, 'SIL Open Font License 1.1');
  assert.deepEqual(manifest.renderOptions, {
    height: 1080,
    jpegQuality: 92,
    thumbnailWidth: 300,
    width: 1920
  });
  assert.deepEqual(manifest.roleMapping, {
    english: 'secondary',
    media: 'media',
    russian: 'primary'
  });
  assert.equal(Array.isArray(manifest.artifacts), true);
  assert.equal(manifest.artifacts.length, 60);
  assert.equal(Array.isArray(manifest.assets), true);
  assert.equal(manifest.assets.length, 1);
  assert.equal(Array.isArray(manifest.channels), true);
  assert.equal(manifest.channels.length, 3);

  const packagedFont = await readDirectFile(
    path.join(
      paths.appPath,
      'Contents',
      'Resources',
      'app.asar.unpacked',
      'assets',
      'fonts',
      'NotoSans-Variable.ttf'
    ),
    16 * 1024 * 1024,
    'selected packaged Noto Sans font'
  );
  assert.equal(packagedFont.mode, 0o644);
  assert.equal(packagedFont.mode & 0o133, 0);
  assert.equal(packagedFont.sha256, manifest.font.sha256);

  const artifactByPath = new Map();
  for (const artifact of manifest.artifacts) {
    assertExactObjectKeys(artifact, ['path', 'sha256', 'size'], 'manifest artifact');
    const artifactPath = safePackageRelativePath(artifact.path);
    assert.match(artifact.sha256, SHA256_PATTERN);
    assert.equal(Number.isSafeInteger(artifact.size) && artifact.size > 0, true);
    assert.equal(artifactByPath.has(artifactPath), false);
    const fileRecord = fileByPath.get(artifactPath);
    assert.ok(fileRecord, `Manifest artifact is missing: ${artifactPath}`);
    assert.equal(fileRecord.size, artifact.size);
    assert.equal(fileRecord.sha256, artifact.sha256);
    artifactByPath.set(artifactPath, artifact);
  }
  const expectedFiles = new Set(['manifest.json', ...artifactByPath.keys()]);
  assert.deepEqual([...fileByPath.keys()].sort(), [...expectedFiles].sort());
  const thumbnailRecords = [...fileByPath.values()].filter(record =>
    /\/slide_\d{3}_thumb\.jpg$/u.test(record.path)
  );
  const privateFileRecords = [...fileByPath.values()].filter(record =>
    !/\/slide_\d{3}_thumb\.jpg$/u.test(record.path)
  );
  assert.equal(thumbnailRecords.length, 27);
  assert.equal(thumbnailRecords.every(record => record.mode === 0o644), true);
  assert.equal(thumbnailRecords.every(record => (record.mode & 0o133) === 0), true);
  assert.equal(privateFileRecords.length, 34);
  assert.equal(privateFileRecords.every(record => record.mode === 0o600), true);
  const expectedDirectories = new Set();
  for (const filePath of expectedFiles) {
    let parent = path.posix.dirname(filePath);
    while (parent !== '.') {
      expectedDirectories.add(parent);
      parent = path.posix.dirname(parent);
    }
  }
  assert.deepEqual(
    files.records.filter(record => record.type === 'directory').map(record => record.path).sort(),
    [...expectedDirectories].sort()
  );

  for (const asset of manifest.assets) {
    assert.match(asset?.sha256, SHA256_PATTERN);
    assert.equal(asset.id, `sha256:${asset.sha256}`);
    const artifact = artifactByPath.get(safePackageRelativePath(asset.path));
    assert.ok(artifact);
    assert.equal(artifact.sha256, asset.sha256);
    assert.equal(artifact.size, asset.size);
  }

  const parsedJsonArtifacts = new Map();
  for (const artifactPath of artifactByPath.keys()) {
    if (!artifactPath.endsWith('.json')) continue;
    const parsed = await readDirectJson(
      path.join(packagePath, ...artifactPath.split('/')),
      MAX_DIRECT_JSON_BYTES,
      `Show package JSON artifact ${artifactPath}`
    );
    assert.equal(parsed.sha256, artifactByPath.get(artifactPath).sha256);
    assert.doesNotMatch(
      JSON.stringify(parsed.value),
      /\.pptx?\b|imported-deck|legacy-deck/iu
    );
    parsedJsonArtifacts.set(artifactPath, parsed.value);
  }

  const timeline = parsedJsonArtifacts.get('timeline.json');
  assert.ok(timeline);
  assert.equal(artifactByPath.get('timeline.json').sha256, manifest.timelineSha256);
  assert.equal(timeline.kind, 'syncshow-cue-timeline');
  assert.equal(timeline.projectId, READY_PROJECT_ID);
  assert.equal(timeline.projectRevision, readyStored.projectRevision);
  assert.equal(timeline.projectContentHash, readyStored.revisionId);
  assert.deepEqual(timeline.cueIds, manifest.cueIds);

  assert.equal(manifest.handoffPath, 'handoff.json');
  const serviceHandoff = parsedJsonArtifacts.get(manifest.handoffPath);
  assert.ok(serviceHandoff);
  assert.equal(
    artifactByPath.get(manifest.handoffPath).sha256,
    manifest.handoffSha256
  );
  assert.equal(serviceHandoff.kind, 'syncshow-service-handoff');
  assert.equal(serviceHandoff.project?.id, READY_PROJECT_ID);
  assert.equal(serviceHandoff.project?.revisionId, readyStored.revisionId);
  assert.equal(serviceHandoff.project?.revision, readyStored.projectRevision);
  assert.equal(serviceHandoff.project?.contentHash, readyStored.revisionId);
  assert.equal(serviceHandoff.project?.title, NATIVE_WEEKLY_TITLE);
  assert.equal(serviceHandoff.planning?.status, 'ready');
  assert.equal(serviceHandoff.readiness?.ready, true);
  assertExactObjectKeys(
    serviceHandoff.readiness,
    ['ready', 'checks', 'waivedCheckIds'],
    'service handoff readiness summary'
  );
  assert.deepEqual(serviceHandoff.cueIds, manifest.cueIds);
  assert.deepEqual(
    serviceHandoff.readiness.checks.map(check => [check.id, check.status]),
    WEEKLY_CHECK_IDS.map(checkId => [checkId, 'pass'])
  );

  const roles = [];
  const expectedScenePaths = new Set();
  const expectedThumbnailPaths = new Set();
  for (const channel of manifest.channels) {
    const expectedDirectory = `channel-${sha256Bytes(
      Buffer.from(channel.roleId, 'utf8')
    ).slice(0, 24)}`;
    assert.equal(channel.renderer, 'native-cue');
    assert.equal(manifest.roleMapping[channel.roleId], channel.channelId);
    assert.equal(channel.directory, expectedDirectory);
    assert.equal(channel.metadataPath, `${expectedDirectory}/metadata.json`);
    const metadata = parsedJsonArtifacts.get(channel.metadataPath);
    assert.ok(metadata);
    assert.equal(metadata.sourceType, 'service-project');
    assert.equal(metadata.projectId, READY_PROJECT_ID);
    assert.equal(metadata.projectRevisionId, readyStored.revisionId);
    assert.equal(metadata.channelId, channel.channelId);
    assert.equal(metadata.roleId, channel.roleId);
    assert.equal(metadata.slideCount, 9);
    assert.equal(Array.isArray(metadata.slides) && metadata.slides.length === 9, true);
    assert.deepEqual(metadata.slides.map(slide => slide?.cueId), manifest.cueIds);
    for (const [cueIndex, cueId] of manifest.cueIds.entries()) {
      const number = String(cueIndex + 1).padStart(3, '0');
      const scenePath = `${expectedDirectory}/scene_${number}.json`;
      const thumbnailPath = `${expectedDirectory}/slide_${number}_thumb.jpg`;
      expectedScenePaths.add(scenePath);
      expectedThumbnailPaths.add(thumbnailPath);
      assert.ok(artifactByPath.has(scenePath), `Missing ordered scene artifact ${scenePath}`);
      assert.ok(
        artifactByPath.has(thumbnailPath),
        `Missing ordered thumbnail artifact ${thumbnailPath}`
      );
      const scene = parsedJsonArtifacts.get(scenePath);
      assert.ok(scene, `Missing parsed ordered scene ${scenePath}`);
      assert.equal(scene.cueId, cueId, `Scene ${scenePath} has the wrong ordered cue.`);
    }
    roles.push(channel.roleId);
  }
  roles.sort();
  assert.deepEqual(roles, ['english', 'media', 'russian']);

  const sceneEntries = [...parsedJsonArtifacts.entries()]
    .filter(([artifactPath]) => /\/scene_\d{3}\.json$/u.test(artifactPath));
  assert.deepEqual(
    sceneEntries.map(([artifactPath]) => artifactPath).sort(),
    [...expectedScenePaths].sort()
  );
  assert.deepEqual(
    thumbnailRecords.map(record => record.path).sort(),
    [...expectedThumbnailPaths].sort()
  );
  const scenes = sceneEntries.map(([, scene]) => scene);
  assert.equal(scenes.length, 27);
  assert.equal(scenes.every(scene => manifest.cueIds.includes(scene.cueId)), true);
  assert.equal(scenes.some(scene => scene.layout === 'legacy-deck'), false);
  assert.doesNotMatch(
    JSON.stringify({ project: readyStored.project, manifest, serviceHandoff, timeline }),
    /\.pptx?\b|imported-deck|legacy-deck/iu
  );

  return Object.freeze({
    packageId: pointer.packageId,
    manifestSha256: pointer.packageManifestSha256,
    pointerSha256: pointerRead.sha256,
    projectId: pointer.projectId,
    projectRevision: pointer.projectRevision,
    projectRevisionId: pointer.projectRevisionId,
    cueCount: manifest.cueCount,
    roles,
    sourceTypes: ['service-project'],
    renderers: ['native-cue'],
    legacySceneCount: 0,
    containsPowerPointReference: false,
    packagedFontSha256: packagedFont.sha256,
    fileManifest: files
  });
}

async function closePackagedApp(cdp, launch) {
  let pageCloseError = null;
  try {
    await cdp.call('Page.close', {}, 10_000);
  } catch (error) {
    pageCloseError = serializeError(error);
  } finally {
    cdp.close();
  }
  const exit = await withTimeout(
    launch.closed,
    CLOSE_TIMEOUT_MS,
    `${phaseLabel(launch)} did not exit after its control window closed.`,
    launch.cancellation
  );
  assert.equal(exit.signal, null, `${phaseLabel(launch)} ended by signal.`);
  assert.equal(exit.code, 0, launch.stderr() || launch.stdout());
  const processGroup = await waitForProcessGroupAbsent(launch, GROUP_TERM_TIMEOUT_MS);
  if (!processGroup.absent) {
    fail(
      'PROCESS_GROUP_REMAINS_AFTER_CLOSE',
      `${phaseLabel(launch)} process-group absence was not proven after clean close.`
    );
  }
  return { exit, pageCloseError, processGroup };
}

async function runPlanningToLoad(paths, profilePath, seed, launch) {
  const connected = await connectPackagedControl(paths, profilePath, launch);
  const { cdp, discovery, surface } = connected;
  let closed = false;
  try {
    const initialState = await waitForEvaluation(cdp, `
      (async () => {
        const appState = await window.api.getAppState();
        if (
          !Array.isArray(appState.displays)
          || appState.displays.length !== 1
          || appState.showState?.phase !== 'idle'
          || appState.showState?.outputSessionId !== null
          || appState.preparedServiceRestore?.status !== 'none'
        ) return null;
        return appState;
      })()
    `, 'the first launch exact one-display idle state', launch);
    assertIdleNoDisplayBoundary(initialState);
    assert.equal(initialState.preparedServiceRestore?.status, 'none');

    const prepareClicked = await cdp.evaluate(`
      (() => {
        const isVisible = ${IN_PAGE_VISIBLE_PREDICATE};
        const button = document.querySelector('#btnStagePrepare');
        if (!isVisible(button) || button.disabled) return false;
        button.click();
        return true;
      })()
    `);
    assert.equal(prepareClicked, true);
    await waitForEvaluation(cdp, `
      (() => {
        const isVisible = ${IN_PAGE_VISIBLE_PREDICATE};
        const search = document.querySelector('#prepareProjectSearch');
        if (
          !document.body.classList.contains('prepare-stage')
          || !isVisible(search)
          || search.disabled
        ) {
          return null;
        }
        search.value = ${JSON.stringify(NATIVE_WEEKLY_TITLE)};
        search.dispatchEvent(new Event('input', { bubbles: true }));
        return true;
      })()
    `, 'Prepare to expose the project search', launch);

    await waitForEvaluation(cdp, `
      (() => {
        const isVisible = ${IN_PAGE_VISIBLE_PREDICATE};
        const button = [...document.querySelectorAll(
          '#prepareProjectList button[data-project-id]'
        )].find(candidate =>
          candidate.dataset.projectId === ${JSON.stringify(READY_PROJECT_ID)}
        );
        if (!isVisible(button) || button.disabled) return null;
        button.click();
        return true;
      })()
    `, 'the deterministic Planning project in the packaged project list', launch);

    const planningSurface = await waitForEvaluation(cdp, `
      (() => {
        const isVisible = ${IN_PAGE_VISIBLE_PREDICATE};
        const exposeWithin = ${IN_PAGE_SCROLL_INTO_OWNER_PREDICATE};
        const scrollOwner = document.querySelector('.prepare-rundown-pane');
        const rundownList = document.querySelector('#prepareRundownList');
        const primary = document.querySelector('#btnContinueWeeklySetup');
        const checks = [...document.querySelectorAll(
          '#prepareServiceReadinessChecks > li'
        )];
        const headingElement = document.querySelector('#preparePlanningHeading');
        const heading = headingElement?.textContent?.trim() || '';
        const scrollOwnerStyle = scrollOwner
          ? window.getComputedStyle(scrollOwner)
          : null;
        const rundownListStyle = rundownList
          ? window.getComputedStyle(rundownList)
          : null;
        if (
          heading !== ${JSON.stringify(`Planning · ${NATIVE_WEEKLY_TITLE}`)}
          || !isVisible(scrollOwner)
          || !['auto', 'scroll'].includes(scrollOwnerStyle?.overflowY)
          || ['auto', 'scroll'].includes(rundownListStyle?.overflowY)
          || scrollOwner.scrollHeight <= scrollOwner.clientHeight
          || primary.disabled
          || primary.dataset.workflowContinuation !== 'review-ready'
          || primary.textContent.trim() !== 'Review & mark Ready'
          || checks.length !== 6
          || checks.some(check => check.dataset.status !== 'pass')
        ) return null;
        const sequentialTargets = [];
        if (!exposeWithin(scrollOwner, headingElement) || !isVisible(headingElement)) {
          return null;
        }
        sequentialTargets.push('planning-heading');
        for (const [index, check] of checks.entries()) {
          if (!exposeWithin(scrollOwner, check) || !isVisible(check)) return null;
          sequentialTargets.push('weekly-check-' + (index + 1));
        }
        if (!exposeWithin(scrollOwner, primary) || !isVisible(primary)) return null;
        sequentialTargets.push('review-ready-primary');
        return {
          heading,
          primaryText: primary.textContent.trim(),
          primaryKind: primary.dataset.workflowContinuation,
          checkIds: checks.map(check => check.dataset.checkId ||
            check.querySelector('[data-weekly-readiness-action]')?.dataset.weeklyReadinessAction || ''),
          checkStatuses: checks.map(check => check.dataset.status),
          badge: document.querySelector('#prepareServiceReadinessBadge')?.textContent?.trim() || '',
          openDialogs: [...document.querySelectorAll('dialog[open]')].map(item => item.id),
          accessibility: {
            scrollOwner: 'prepare-rundown-pane',
            overflowY: scrollOwnerStyle.overflowY,
            nestedRundownOverflowY: rundownListStyle.overflowY,
            clientHeight: scrollOwner.clientHeight,
            scrollHeight: scrollOwner.scrollHeight,
            sequentialTargets
          }
        };
      })()
    `, 'the user-scrollable six clear packaged Planning checks', launch);
    assert.deepEqual(planningSurface.checkStatuses, Array(6).fill('pass'));
    assert.equal(planningSurface.badge, 'Checks clear');
    assert.deepEqual(planningSurface.openDialogs, []);
    assert.deepEqual(planningSurface.accessibility.sequentialTargets, [
      'planning-heading',
      ...Array.from({ length: 6 }, (_, index) => `weekly-check-${index + 1}`),
      'review-ready-primary'
    ]);
    assert.equal(planningSurface.accessibility.overflowY, 'auto');
    assert.equal(planningSurface.accessibility.nestedRundownOverflowY, 'visible');
    assert.ok(
      planningSurface.accessibility.scrollHeight
        > planningSurface.accessibility.clientHeight
    );

    await raceCancellation(
      delay(500),
      launch.cancellation,
      'waiting for the Planning surface to remain stable'
    );
    const externalBefore = await externalWorkflowSnapshot(profilePath);
    const reviewClicked = await cdp.evaluate(`
      (() => {
        const isVisible = ${IN_PAGE_VISIBLE_PREDICATE};
        const button = document.querySelector('#btnContinueWeeklySetup');
        if (!isVisible(button) || button.disabled || button.dataset.workflowContinuation !== 'review-ready') {
          return false;
        }
        button.click();
        return true;
      })()
    `);
    assert.equal(reviewClicked, true);

    const confirmationControl = await waitForEvaluation(cdp, `
      (() => {
        const isVisible = ${IN_PAGE_VISIBLE_PREDICATE};
        const exposeWithin = ${IN_PAGE_SCROLL_INTO_OWNER_PREDICATE};
        const dialog = document.querySelector('#serviceReadinessDialog');
        const title = document.querySelector('#serviceReadinessTitle');
        const cardList = document.querySelector('#serviceReadinessReviewChecks');
        const cards = [...document.querySelectorAll(
          '#serviceReadinessReviewChecks [data-readiness-check-id]'
        )];
        const confirmed = document.querySelector('#serviceReadinessConfirmed');
        const markReady = document.querySelector('#btnMarkServiceReady');
        const activeElementId = document.activeElement?.id || '';
        const dialogStyle = dialog ? window.getComputedStyle(dialog) : null;
        const cardListStyle = cardList ? window.getComputedStyle(cardList) : null;
        if (
          !dialog?.open
          || !isVisible(dialog)
          || !['auto', 'scroll'].includes(dialogStyle?.overflowY)
          || ['auto', 'scroll'].includes(cardListStyle?.overflowY)
          || dialog.scrollHeight <= dialog.clientHeight
          || activeElementId !== 'serviceReadinessTitle'
          || cards.length !== 6
          || cards.some(card => card.dataset.status !== 'pass')
          || confirmed?.checked !== false
          || markReady?.disabled !== true
        ) return null;
        const sequentialTargets = [];
        if (!exposeWithin(dialog, title) || !isVisible(title)) return null;
        sequentialTargets.push('review-title');
        for (const [index, card] of cards.entries()) {
          if (!exposeWithin(dialog, card) || !isVisible(card)) return null;
          sequentialTargets.push('review-card-' + (index + 1));
        }
        if (!exposeWithin(dialog, confirmed) || !isVisible(confirmed)) return null;
        sequentialTargets.push('operator-confirmation');
        if (!exposeWithin(dialog, markReady) || !isVisible(markReady)) return null;
        sequentialTargets.push('mark-ready-action');
        return {
          activeElementId,
          checkIds: cards.map(card => card.dataset.readinessCheckId),
          statuses: cards.map(card => card.dataset.status),
          badge: document.querySelector('#serviceReadinessDialogBadge')?.textContent?.trim() || '',
          confirmationChecked: confirmed.checked,
          markReadyDisabled: markReady.disabled,
          openDialogs: [...document.querySelectorAll('dialog[open]')].map(item => item.id),
          accessibility: {
            scrollOwner: 'serviceReadinessDialog',
            overflowY: dialogStyle.overflowY,
            nestedCardListOverflowY: cardListStyle.overflowY,
            clientHeight: dialog.clientHeight,
            scrollHeight: dialog.scrollHeight,
            sequentialTargets
          }
        };
      })()
    `, 'the packaged explicit operator confirmation control', launch);
    assert.deepEqual(confirmationControl.checkIds, WEEKLY_CHECK_IDS);
    assert.deepEqual(confirmationControl.statuses, Array(6).fill('pass'));
    assert.equal(confirmationControl.badge, 'Checks clear');
    assert.deepEqual(confirmationControl.openDialogs, ['serviceReadinessDialog']);
    assert.deepEqual(confirmationControl.accessibility.sequentialTargets, [
      'review-title',
      ...Array.from({ length: 6 }, (_, index) => `review-card-${index + 1}`),
      'operator-confirmation',
      'mark-ready-action'
    ]);
    assert.equal(confirmationControl.accessibility.overflowY, 'auto');
    assert.equal(confirmationControl.accessibility.nestedCardListOverflowY, 'visible');
    assert.ok(
      confirmationControl.accessibility.scrollHeight
        > confirmationControl.accessibility.clientHeight
    );

    const confirmationAction = await cdp.evaluate(`
      (() => {
        const isVisible = ${IN_PAGE_VISIBLE_PREDICATE};
        const exposeWithin = ${IN_PAGE_SCROLL_INTO_OWNER_PREDICATE};
        const dialog = document.querySelector('#serviceReadinessDialog');
        const confirmed = document.querySelector('#serviceReadinessConfirmed');
        const markReady = document.querySelector('#btnMarkServiceReady');
        if (
          !dialog?.open
          || !isVisible(dialog)
          || confirmed.checked
          || !markReady.disabled
        ) return null;
        if (!exposeWithin(dialog, confirmed) || !isVisible(confirmed)) return null;
        confirmed.click();
        if (
          !confirmed.checked
          || markReady.disabled
          || !exposeWithin(dialog, markReady)
          || !isVisible(markReady)
        ) return null;
        markReady.click();
        return {
          actor: 'automation',
          humanPresent: false,
          confirmationChecked: true,
          markReadyEnabledBeforeClick: true,
          clicked: true
        };
      })()
    `);
    assert.deepEqual(confirmationAction, {
      actor: 'automation',
      humanPresent: false,
      confirmationChecked: true,
      markReadyEnabledBeforeClick: true,
      clicked: true
    });

    const readySurface = await waitForEvaluation(cdp, `
      (() => {
        const isVisible = ${IN_PAGE_VISIBLE_PREDICATE};
        const exposeWithin = ${IN_PAGE_SCROLL_INTO_OWNER_PREDICATE};
        const dialog = document.querySelector('#serviceReadinessDialog');
        const scrollOwner = document.querySelector('.prepare-rundown-pane');
        const primary = document.querySelector('#btnContinueWeeklySetup');
        const headingElement = document.querySelector('#preparePlanningHeading');
        const heading = headingElement?.textContent?.trim() || '';
        const error = document.querySelector('#serviceReadinessError');
        const scrollOwnerStyle = scrollOwner
          ? window.getComputedStyle(scrollOwner)
          : null;
        if (dialog?.open && error && !error.hidden && error.textContent.trim()) {
          throw new Error(error.textContent.trim());
        }
        if (
          dialog?.open
          || heading !== ${JSON.stringify(`Ready · ${NATIVE_WEEKLY_TITLE}`)}
          || !isVisible(scrollOwner)
          || !['auto', 'scroll'].includes(scrollOwnerStyle?.overflowY)
          || primary.disabled
          || primary.dataset.workflowContinuation !== 'publish-load'
          || primary.textContent.trim() !== 'Save & go to Load'
          || document.activeElement?.id !== 'btnContinueWeeklySetup'
        ) return null;
        if (!exposeWithin(scrollOwner, headingElement) || !isVisible(headingElement)) {
          return null;
        }
        if (!exposeWithin(scrollOwner, primary) || !isVisible(primary)) return null;
        return {
          heading,
          primaryText: primary.textContent.trim(),
          primaryKind: primary.dataset.workflowContinuation,
          activeElementId: document.activeElement.id,
          openDialogs: [...document.querySelectorAll('dialog[open]')].map(item => item.id),
          accessibility: {
            scrollOwner: 'prepare-rundown-pane',
            overflowY: scrollOwnerStyle.overflowY,
            sequentialTargets: ['ready-heading', 'publish-load-primary']
          }
        };
      })()
    `, 'the exact project revision to become Ready', launch);
    assert.deepEqual(readySurface.accessibility, {
      scrollOwner: 'prepare-rundown-pane',
      overflowY: 'auto',
      sequentialTargets: ['ready-heading', 'publish-load-primary']
    });

    const readyStored = await inspectStoredReadyProject(
      profilePath,
      seed.expectedPlanningPointer
    );
    const readyContinuity = assertReadyContinuity(seed.planningStored, readyStored);
    const seededRevisionAfterReady = await inspectSeededPlanningRevision(
      profilePath,
      seed.expectedPlanningStorage.revision
    );

    const publishClicked = await cdp.evaluate(`
      (() => {
        const isVisible = ${IN_PAGE_VISIBLE_PREDICATE};
        const button = document.querySelector('#btnContinueWeeklySetup');
        if (!isVisible(button) || button.disabled || button.dataset.workflowContinuation !== 'publish-load') {
          return false;
        }
        button.click();
        return true;
      })()
    `);
    assert.equal(publishClicked, true);

    const loadSurface = await waitForEvaluation(cdp, `
      (() => {
        const isVisible = ${IN_PAGE_VISIBLE_PREDICATE};
        const handoff = document.querySelector('#loadServiceHandoff');
        const titleElement = document.querySelector('#loadServiceHandoffTitle');
        const badgeElement = document.querySelector('#loadServiceHandoffBadge');
        const scheduleElement = document.querySelector('#loadServiceHandoffSchedule');
        const statusElement = document.querySelector('#statusMessage');
        const title = titleElement?.textContent?.trim() || '';
        const badge = badgeElement?.textContent?.trim() || '';
        const schedule = scheduleElement?.textContent?.trim() || '';
        const status = statusElement?.textContent?.trim() || '';
        if (
          !document.body.classList.contains('load-stage')
          || handoff?.hidden !== false
          || !isVisible(handoff)
          || !isVisible(titleElement)
          || !isVisible(badgeElement)
          || !isVisible(scheduleElement)
          || !isVisible(statusElement)
          || title !== ${JSON.stringify(NATIVE_WEEKLY_TITLE)}
          || badge !== 'Ready'
          || !schedule.includes('9 cues')
          || !schedule.includes('exact revision 4')
          || !status.includes('ready in Load')
        ) return null;
        return {
          bodyClass: document.body.className,
          title,
          badge,
          schedule,
          status,
          handoffVisible: true,
          startDisabled: document.querySelector('#btnStartPresentation')?.disabled === true,
          showStageDisabled: document.querySelector('#btnStageShow')?.disabled === true,
          openDialogs: [...document.querySelectorAll('dialog[open]')].map(item => item.id)
        };
      })()
    `, 'the packaged native publish path to finish in Load', launch);
    assert.equal(loadSurface.startDisabled, true);
    assert.equal(loadSurface.showStageDisabled, true);
    assert.deepEqual(loadSurface.openDialogs, []);

    const unchangedAfterPublish = await inspectStoredReadyProject(
      profilePath,
      seed.expectedPlanningPointer
    );
    assert.deepEqual(unchangedAfterPublish, readyStored);
    const currentPackage = await inspectPublishedPackage(
      paths,
      profilePath,
      readyStored
    );
    const externalAfter = await externalWorkflowSnapshot(profilePath);
    assert.deepEqual(externalAfter, externalBefore);

    const finalAppState = await cdp.evaluate('(async () => window.api.getAppState())()');
    assertPreparedLoadState(finalAppState);
    assert.equal(finalAppState.preparedServiceRestore?.status, 'restored');
    assert.equal(finalAppState.serviceHandoff?.project?.id, READY_PROJECT_ID);
    assert.equal(finalAppState.serviceHandoff?.project?.revision, 4);

    const close = await closePackagedApp(cdp, launch);
    closed = true;
    return {
      packageEntry: surface,
      devTools: {
        portWasEphemeral: true,
        pageCount: discovery.pageCount,
        outputPageCount: discovery.outputPageCount
      },
      initialAppState: projectedAppState(initialState),
      planning: {
        ...projectStateEvidence(seed.planningStored),
        surface: planningSurface
      },
      confirmationControl,
      confirmationAction,
      ready: {
        ...projectStateEvidence(readyStored),
        surface: readySurface,
        continuity: readyContinuity
      },
      seededRevisionAfterReady,
      load: loadSurface,
      projectRevisionUnchanged: true,
      currentPackage,
      finalAppState: projectedAppState(finalAppState),
      watchedExternalBytes: {
        before: externalBefore,
        after: externalAfter,
        watchedExternalBytesUnchanged: true
      },
      close
    };
  } finally {
    if (!closed) cdp.close();
  }
}

async function runRestartProof(
  paths,
  profilePath,
  seed,
  expectedReady,
  expectedPackage,
  expectedDurableSnapshot,
  expectedExternalSnapshot,
  launch
) {
  const connected = await connectPackagedControl(paths, profilePath, launch);
  const { cdp, discovery, surface } = connected;
  let closed = false;
  try {
    const restored = await waitForEvaluation(cdp, `
      (async () => {
        const isVisible = ${IN_PAGE_VISIBLE_PREDICATE};
        const appState = await window.api.getAppState();
        const handoff = document.querySelector('#loadServiceHandoff');
        const titleElement = document.querySelector('#loadServiceHandoffTitle');
        const badgeElement = document.querySelector('#loadServiceHandoffBadge');
        const scheduleElement = document.querySelector('#loadServiceHandoffSchedule');
        const statusElement = document.querySelector('#statusMessage');
        const title = titleElement?.textContent?.trim() || '';
        const badge = badgeElement?.textContent?.trim() || '';
        const schedule = scheduleElement?.textContent?.trim() || '';
        const status = statusElement?.textContent?.trim() || '';
        const presentationRoleIds = Object.keys(appState.presentations || {}).sort();
        const expectedPresentationRoleIds = ${JSON.stringify(EXPECTED_PREPARED_ROLE_IDS)};
        const preparedPresentationsReady =
          JSON.stringify(presentationRoleIds) === JSON.stringify(expectedPresentationRoleIds)
          && presentationRoleIds.every(roleId => {
            const presentation = appState.presentations[roleId];
            return presentation?.loaded === true
              && presentation.slideCount === ${EXPECTED_PREPARED_CUE_COUNT};
          });
        if (
          !Array.isArray(appState.displays)
          || appState.displays.length !== 1
          || appState.preparedServiceRestore?.status !== 'restored'
          || appState.serviceHandoff?.project?.id !== ${JSON.stringify(READY_PROJECT_ID)}
          || appState.serviceHandoff?.project?.revision !== 4
          || !Array.isArray(appState.serviceHandoff?.cueIds)
          || appState.serviceHandoff.cueIds.length !== ${EXPECTED_PREPARED_CUE_COUNT}
          || appState.totalSlides !== 0
          || !preparedPresentationsReady
          || !document.body.classList.contains('load-stage')
          || handoff?.hidden !== false
          || !isVisible(handoff)
          || !isVisible(titleElement)
          || !isVisible(badgeElement)
          || !isVisible(scheduleElement)
          || !isVisible(statusElement)
          || title !== ${JSON.stringify(NATIVE_WEEKLY_TITLE)}
          || badge !== 'Ready'
          || !schedule.includes('9 cues')
          || !schedule.includes('exact revision 4')
          || !status.includes('was restored and is ready in Load')
        ) return null;
        return {
          appState,
          load: {
            bodyClass: document.body.className,
            title,
            badge,
            schedule,
            status,
            startDisabled: document.querySelector('#btnStartPresentation')?.disabled === true,
            showStageDisabled: document.querySelector('#btnStageShow')?.disabled === true,
            openDialogs: [...document.querySelectorAll('dialog[open]')].map(item => item.id)
          }
        };
      })()
    `, 'the packaged app to restore the exact prepared service after restart', launch);
    assertPreparedLoadState(restored.appState);
    assert.equal(restored.load.startDisabled, true);
    assert.equal(restored.load.showStageDisabled, true);
    assert.deepEqual(restored.load.openDialogs, []);
    assert.equal(restored.appState.showState?.phase, 'idle');
    assert.equal(restored.appState.showState?.outputSessionId, null);

    const reopenedReady = await inspectStoredReadyProject(
      profilePath,
      seed.expectedPlanningPointer
    );
    assert.deepEqual(reopenedReady, expectedReady);
    const reopenedPackage = await inspectPublishedPackage(
      paths,
      profilePath,
      reopenedReady
    );
    assert.deepEqual(reopenedPackage, expectedPackage);
    const seededRevisionAfterRestart = await inspectSeededPlanningRevision(
      profilePath,
      seed.expectedPlanningStorage.revision
    );
    const durableBeforeClose = await durableWorkflowSnapshot(profilePath);
    const externalBeforeClose = await externalWorkflowSnapshot(profilePath);
    assert.deepEqual(durableBeforeClose, expectedDurableSnapshot);
    assert.deepEqual(externalBeforeClose, expectedExternalSnapshot);

    const close = await closePackagedApp(cdp, launch);
    closed = true;
    const durableAfterClose = await durableWorkflowSnapshot(profilePath);
    const externalAfterClose = await externalWorkflowSnapshot(profilePath);
    assert.deepEqual(durableAfterClose, expectedDurableSnapshot);
    assert.deepEqual(externalAfterClose, expectedExternalSnapshot);

    return {
      packageEntry: surface,
      devTools: {
        portWasEphemeral: true,
        pageCount: discovery.pageCount,
        outputPageCount: discovery.outputPageCount
      },
      appState: projectedAppState(restored.appState),
      load: restored.load,
      readyProject: projectStateEvidence(reopenedReady),
      currentPackage: reopenedPackage,
      seededRevisionAfterRestart,
      exactDurableBytesUnchanged: true,
      watchedExternalBytesUnchanged: true,
      noShowAutoResurrection: true,
      close
    };
  } finally {
    if (!closed) cdp.close();
  }
}

function launchEvidence(launch) {
  return {
    phase: launch.phase,
    pid: launch.pid,
    detachedProcessGroup: launch.processGroupBound,
    processGroupId: launch.processGroupId,
    processGroupAbsence: launch.processGroupAbsence,
    devToolsActivePortPreparation: launch.devToolsActivePortPreparation,
    args: launch.args,
    startedAt: launch.startedAt,
    exit: launch.exit,
    spawnError: launch.spawnError,
    stdout: launch.stdout(),
    stderr: launch.stderr()
  };
}

async function terminateLaunch(launch) {
  const initialGroup = processGroupState(launch);
  if (initialGroup.absent) {
    launch.processGroupAbsence = Object.freeze({
      ...initialGroup,
      checkedAt: new Date().toISOString(),
      waitedMs: 0
    });
    return {
      phase: launch.phase,
      status: launch.exit ? 'already-exited-group-absent' : 'group-already-absent',
      exit: launch.exit,
      processGroup: launch.processGroupAbsence
    };
  }
  if (initialGroup.status === 'absence-unproven') {
    launch.processGroupAbsence = Object.freeze({
      ...initialGroup,
      checkedAt: new Date().toISOString(),
      waitedMs: 0
    });
    return {
      phase: launch.phase,
      status: 'group-absence-unproven',
      exit: launch.exit,
      processGroup: launch.processGroupAbsence
    };
  }

  const term = signalProcessGroup(launch, 'SIGTERM');
  const termExitPromise = launch.exit
    ? Promise.resolve(launch.exit)
    : withTimeout(
        launch.closed,
        GROUP_TERM_TIMEOUT_MS,
        `${phaseLabel(launch)} direct process ignored group SIGTERM.`
      ).catch(error => ({ waitError: serializeError(error) }));
  const [termExit, afterTerm] = await Promise.all([
    termExitPromise,
    waitForProcessGroupAbsent(launch, GROUP_TERM_TIMEOUT_MS)
  ]);
  if (afterTerm.absent) {
    return {
      phase: launch.phase,
      status: 'terminated-group-absent',
      term,
      exit: launch.exit || termExit,
      processGroup: afterTerm
    };
  }

  const kill = signalProcessGroup(launch, 'SIGKILL');
  const killExitPromise = launch.exit
    ? Promise.resolve(launch.exit)
    : withTimeout(
        launch.closed,
        GROUP_KILL_TIMEOUT_MS,
        `${phaseLabel(launch)} direct process remained after group SIGKILL.`
      ).catch(error => ({ waitError: serializeError(error) }));
  const [killExit, afterKill] = await Promise.all([
    killExitPromise,
    waitForProcessGroupAbsent(launch, GROUP_KILL_TIMEOUT_MS)
  ]);
  return {
    phase: launch.phase,
    status: afterKill.absent ? 'killed-group-absent' : 'group-absence-unproven',
    term,
    kill,
    exit: launch.exit || killExit,
    processGroup: afterKill
  };
}

async function cleanupTempProfile(temp, launches) {
  if (!temp) return { status: 'not-created', removed: false };
  const processGroups = [];
  for (const launch of launches) {
    processGroups.push({
      phase: launch.phase,
      ...(await waitForProcessGroupAbsent(launch, 250))
    });
  }
  const unresolvedGroups = processGroups.filter(group => !group.absent);
  if (unresolvedGroups.length > 0) {
    return {
      status: 'retained-process-group-absence-unproven',
      removed: false,
      testRoot: temp.testRoot,
      processGroups
    };
  }
  const temporaryRoot = await fsp.realpath(os.tmpdir());
  const testRoot = await fsp.realpath(temp.testRoot).catch(error => {
    if (error?.code === 'ENOENT') return null;
    throw error;
  });
  if (!testRoot) return { status: 'already-removed', removed: true };
  if (
    temporaryRoot !== temp.temporaryRoot
    || testRoot !== temp.testRoot
    || !confinedTempChild(temporaryRoot, testRoot)
    || !path.basename(testRoot).startsWith('syncshow-packaged-operational-planning-')
  ) {
    return {
      status: 'retained-unsafe-path',
      removed: false,
      testRoot
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
    processGroups
  };
}

async function fsyncDirectory(directoryPath) {
  const handle = await fsp.open(directoryPath, fs.constants.O_RDONLY);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function writeAllAndSync(handle, bytes) {
  await handle.truncate(0);
  let offset = 0;
  while (offset < bytes.length) {
    const { bytesWritten } = await handle.write(
      bytes,
      offset,
      bytes.length - offset,
      offset
    );
    if (!Number.isSafeInteger(bytesWritten) || bytesWritten < 1) {
      fail('EVIDENCE_WRITE_STALLED', 'Atomic evidence temp write made no progress.');
    }
    offset += bytesWritten;
  }
  await handle.sync();
}

async function writeEvidence(resultPath, evidence) {
  const directoryPath = path.dirname(resultPath);
  const resultName = path.basename(resultPath);
  const tempName = `.${resultName}.${process.pid}.${crypto.randomBytes(12).toString('hex')}.tmp`;
  const tempPath = path.join(directoryPath, tempName);
  const relativeTemp = path.relative(directoryPath, tempPath);
  if (
    relativeTemp !== tempName
    || path.isAbsolute(relativeTemp)
    || relativeTemp.startsWith(`..${path.sep}`)
  ) {
    fail('UNSAFE_EVIDENCE_TEMP_PATH', 'Atomic evidence temp path escaped its directory.');
  }

  const bytes = Buffer.from(`${JSON.stringify(evidence, null, 2)}\n`, 'utf8');
  let handle = null;
  let tempExists = false;
  try {
    handle = await fsp.open(tempPath, 'wx', 0o600);
    tempExists = true;
    await handle.chmod(0o600);
    await writeAllAndSync(handle, bytes);
    await handle.close();
    handle = null;

    // A same-directory hard link atomically publishes the fully fsynced inode
    // and fails with EEXIST instead of replacing any prior evidence.
    await fsp.link(tempPath, resultPath);
    await fsyncDirectory(directoryPath);
    await fsp.unlink(tempPath);
    tempExists = false;
    await fsyncDirectory(directoryPath);
    return Object.freeze({
      resultPath,
      bytes: bytes.length,
      sha256: sha256Bytes(bytes),
      mode: 0o600,
      publication: 'fsynced-owner-only-temp-hard-link-no-overwrite'
    });
  } finally {
    if (handle) await handle.close().catch(() => {});
    if (tempExists) {
      await fsp.unlink(tempPath).catch(() => {});
      await fsyncDirectory(directoryPath).catch(() => {});
    }
  }
}

async function publishEvidenceIfAllowed(resultPath, evidence, allowed) {
  if (allowed !== true) return null;
  return writeEvidence(resultPath, evidence);
}

async function main(argv = process.argv.slice(2), stdout = process.stdout) {
  const options = parseArguments(argv);
  const proof = await resolveProofRoot(options.proofRoot);
  const evidence = {
    ok: false,
    contract: CONTRACT,
    proofBoundary:
      'Exact packaged macOS app: external deterministic Planning input, automation exercising the explicit operator confirmation control, packaged Planning-to-Ready-to-Load publish, clean close, and same-profile startup restore. No human operator was present. No Show, Finish, phone, venue, install, notarization, DMG, ZIP, or adoption claim.',
    startedAt: new Date().toISOString(),
    package: null,
    packageProof: {
      path: options.packageProofPath,
      expectedSha256: options.packageProofSha256,
      verified: false
    },
    harness: null,
    seed: null,
    planningToLoad: null,
    restart: null,
    durableSnapshot: null,
    packageBytesUnchanged: false,
    packageProofBytesUnchanged: false,
    harnessBytesUnchanged: false,
    launches: [],
    termination: [],
    cancellation: null,
    cleanup: { status: 'pending', removed: false },
    evidencePublication: {
      method: 'fsynced-owner-only-temp-hard-link-no-overwrite',
      resultPath: proof.resultPath,
      proofRootMode: proof.mode,
      proofRootInitialEntryCount: proof.initialEntryCount,
      proofRootInitiallyEmpty: proof.initiallyEmpty,
      disjointBoundaries: [],
      allowed: false,
      published: false,
      finalCanonicalRecheck: null
    },
    error: null
  };
  const launches = [];
  const cancellation = createCancellationController(launches);
  evidence.cancellation = cancellation.evidence();
  let temp = null;
  let primaryError = null;
  let paths = null;
  let packageProof = null;
  let publicationBoundaries = null;
  let profileBoundary = null;
  let harness = null;
  let evidencePublicationAllowed = false;
  let evidencePublished = false;
  const applyCancellation = () => {
    if (!cancellation.requested) return;
    const error = cancellationError(cancellation);
    if (!primaryError) primaryError = error;
    evidence.error = serializeError(primaryError);
    evidence.ok = false;
  };

  try {
    throwIfCancelled(cancellation, 'package resolution');
    const preflightBoundaries = await preflightEvidenceBoundaries(options.appPath);
    assertEvidenceResultDisjoint(proof.resultPath, preflightBoundaries);
    evidence.evidencePublication.disjointBoundaries = preflightBoundaries;
    paths = await resolvePackagedApp(options.appPath);
    throwIfCancelled(cancellation, 'package resolution');
    evidence.package = {
      appPath: paths.appPath,
      archivePath: paths.archivePath,
      executablePath: paths.executablePath,
      expectedControlUrl: paths.expectedControlUrl,
      identity: paths.identity,
      hashes: paths.hashes,
      bundle: bundleManifestSummary(paths.bundleManifest)
    };
    packageProof = await resolvePackageProof(
      options.packageProofPath,
      options.packageProofSha256,
      paths
    );
    evidence.packageProof = packageProof;
    publicationBoundaries = await staticEvidenceBoundaries(paths, packageProof);
    assertEvidenceResultDisjoint(proof.resultPath, publicationBoundaries);
    evidence.evidencePublication.disjointBoundaries = publicationBoundaries;
    evidencePublicationAllowed = true;
    harness = await resolveHarnessProvenance();
    evidence.harness = harness;
    throwIfCancelled(cancellation, 'pre-launch provenance verification');

    evidencePublicationAllowed = false;
    temp = await createIsolatedProfile();
    profileBoundary = Object.freeze({
      label: 'isolated temporary profile',
      path: await fsp.realpath(temp.profilePath)
    });
    assertEvidenceResultDisjoint(proof.resultPath, [profileBoundary]);
    evidence.evidencePublication.disjointBoundaries = Object.freeze([
      ...publicationBoundaries,
      profileBoundary
    ]);
    evidencePublicationAllowed = true;
    const sourceClosureBeforeSeed = await sourceClosureManifest();
    const seed = await seedTrackedPlanningProfile(temp.profilePath);
    const sourceClosureAfterSeed = await sourceClosureManifest();
    assert.deepEqual(sourceClosureAfterSeed, sourceClosureBeforeSeed);
    const rawPlanningStorage = await inspectSeededPlanningStorage(
      temp.profilePath,
      seed.expectedPlanningStorage
    );
    const prelaunchProfileSnapshot = await directorySnapshot(temp.profilePath);
    assertPrivateDirectorySnapshot(
      prelaunchProfileSnapshot,
      'full prelaunch isolated profile'
    );
    evidence.seed = {
      ...seed.evidence,
      sourceClosure: {
        before: sourceClosureBeforeSeed,
        after: sourceClosureAfterSeed,
        prePostEqual: true
      },
      rawPlanningStorage,
      prelaunchProfileSnapshot
    };
    throwIfCancelled(cancellation, 'external test-profile setup');

    const firstPortPreparation = await prepareDevToolsActivePort(
      temp.profilePath,
      'planning-to-load'
    );
    const firstLaunch = launchPackagedApp(
      paths,
      temp.profilePath,
      'planning-to-load',
      cancellation
    );
    firstLaunch.devToolsActivePortPreparation = firstPortPreparation;
    launches.push(firstLaunch);
    evidence.planningToLoad = await runPlanningToLoad(
      paths,
      temp.profilePath,
      seed,
      firstLaunch
    );
    const readyStored = await inspectStoredReadyProject(
      temp.profilePath,
      seed.expectedPlanningPointer
    );
    const durableSnapshot = await durableWorkflowSnapshot(temp.profilePath);
    const externalSnapshot = await externalWorkflowSnapshot(temp.profilePath);
    evidence.durableSnapshot = durableSnapshot;
    throwIfCancelled(cancellation, 'the Planning-to-Load phase');

    const restartPortPreparation = await prepareDevToolsActivePort(
      temp.profilePath,
      'restart',
      firstLaunch
    );
    const restartLaunch = launchPackagedApp(
      paths,
      temp.profilePath,
      'restart',
      cancellation
    );
    restartLaunch.devToolsActivePortPreparation = restartPortPreparation;
    launches.push(restartLaunch);
    evidence.restart = await runRestartProof(
      paths,
      temp.profilePath,
      seed,
      readyStored,
      evidence.planningToLoad.currentPackage,
      durableSnapshot,
      externalSnapshot,
      restartLaunch
    );
    const sourceClosureAfterRestart = await sourceClosureManifest();
    assert.deepEqual(sourceClosureAfterRestart, sourceClosureBeforeSeed);
    evidence.seed.sourceClosure.afterRestart = sourceClosureAfterRestart;
    evidence.seed.sourceClosure.preSeedToPostRestartEqual = true;
    throwIfCancelled(cancellation, 'the restart phase');

    const finalHashes = {
      appAsarSha256: await sha256File(paths.archivePath),
      executableSha256: await sha256File(paths.executablePath)
    };
    assert.deepEqual(finalHashes, paths.hashes);
    const finalBundleManifest = await bundleManifest(paths.appPath);
    assert.deepEqual(finalBundleManifest, paths.bundleManifest);
    evidence.package.finalHashes = finalHashes;
    evidence.package.finalBundle = bundleManifestSummary(finalBundleManifest);
    evidence.packageBytesUnchanged = true;
    const finalPackageProofSha256 = await sha256File(packageProof.path);
    assert.equal(finalPackageProofSha256, packageProof.sha256);
    evidence.packageProof = {
      ...packageProof,
      finalSha256: finalPackageProofSha256
    };
    evidence.packageProofBytesUnchanged = true;
    evidence.harness = await rehashHarnessProvenance(harness);
    evidence.harnessBytesUnchanged = true;
    throwIfCancelled(cancellation, 'the post-launch byte verification');
    evidence.ok = true;
  } catch (error) {
    primaryError = error;
    evidence.error = serializeError(error);
  } finally {
    applyCancellation();
    for (const launch of launches) {
      try {
        evidence.termination.push(await terminateLaunch(launch));
      } catch (error) {
        evidence.termination.push({
          phase: launch.phase,
          status: 'failed',
          error: serializeError(error)
        });
      }
    }
    evidence.launches = launches.map(launchEvidence);
    try {
      evidence.cleanup = await cleanupTempProfile(temp, launches);
    } catch (error) {
      evidence.cleanup = {
        status: 'failed',
        removed: false,
        testRoot: temp?.testRoot || null,
        error: serializeError(error)
      };
    }
    if (!evidence.cleanup.removed) {
      evidence.ok = false;
      if (!evidence.error) {
        evidence.error = serializeError(new PackagedPlanningVerificationError(
          'CLEANUP_INCOMPLETE',
          'The isolated test profile was not safely removed.'
        ));
      }
    }
    if (evidencePublicationAllowed) {
      evidencePublicationAllowed = false;
      try {
        const finalPublicationBoundaries = await staticEvidenceBoundaries(
          paths,
          packageProof
        );
        assert.deepEqual(finalPublicationBoundaries, publicationBoundaries);
        assertEvidenceResultDisjoint(proof.resultPath, finalPublicationBoundaries);
        if (profileBoundary) {
          assertEvidenceResultDisjoint(proof.resultPath, [profileBoundary]);
        }
        const proofRootRecheck = await recheckProofRootForPublication(proof);
        evidence.evidencePublication.disjointBoundaries = Object.freeze([
          ...finalPublicationBoundaries,
          ...(profileBoundary ? [profileBoundary] : [])
        ]);
        evidence.evidencePublication.finalCanonicalRecheck = Object.freeze({
          ...proofRootRecheck,
          boundariesEqual: true,
          resultDisjoint: true
        });
        evidencePublicationAllowed = true;
      } catch (error) {
        if (!primaryError) primaryError = error;
        evidence.error = serializeError(primaryError);
        evidence.ok = false;
      }
    }
    // Finalize cancellation only after every packaged process group is proven
    // absent and the isolated profile cleanup is complete. Once handlers are
    // removed, a later OS signal terminates normally; atomic publication can
    // then leave either no final record or one complete final record.
    applyCancellation();
    cancellation.dispose();
    evidence.cancellation = cancellation.evidence();
    evidence.evidencePublication.allowed = evidencePublicationAllowed;
    evidence.evidencePublication.published = evidencePublicationAllowed;
    evidence.finishedAt = new Date().toISOString();
    const publication = await publishEvidenceIfAllowed(
      proof.resultPath,
      evidence,
      evidencePublicationAllowed
    );
    evidencePublished = Boolean(publication);
  }

  if (!evidence.ok || !evidencePublished) {
    const error = primaryError || new PackagedPlanningVerificationError(
      evidence.error?.code || (evidence.ok
        ? 'EVIDENCE_NOT_PUBLISHED'
        : 'PACKAGED_PLANNING_VERIFICATION_FAILED'),
      evidence.error?.message || (evidence.ok
        ? 'Packaged planning verification completed but safe evidence was not published.'
        : 'Packaged planning verification failed.')
    );
    if (evidencePublished) {
      error.message = `${error.message}\nEvidence: ${proof.resultPath}`;
    }
    throw error;
  }
  stdout.write(`${JSON.stringify({
    ok: true,
    contract: CONTRACT,
    evidence: proof.resultPath,
    package: evidence.package.hashes,
    packageProofSha256: evidence.packageProof.sha256,
    planningRevision: evidence.planningToLoad.planning.projectRevision,
    readyRevision: evidence.planningToLoad.ready.projectRevision,
    cueCount: evidence.planningToLoad.currentPackage.cueCount,
    restartRestored: evidence.restart.appState.preparedServiceRestore.status,
    cleanup: evidence.cleanup.status,
    boundary: 'packaged Planning-to-Load plus restart only; no Show or Finish claim'
  }, null, 2)}\n`);
  return evidence;
}

if (require.main === module) {
  main().catch(error => {
    process.stderr.write(`${error.code || error.name}: ${error.message}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  CONTRACT,
  PROFILE_MARKER_SOURCE,
  RESULT_FILE,
  CdpSession,
  FatalCdpEvaluationError,
  PackagedPlanningVerificationError,
  RetryableDiscoveryTransportError,
  assertReadyContinuity,
  assertPreparedLoadState,
  assertEvidenceResultDisjoint,
  cleanupTempProfile,
  bundleManifest,
  bundleManifestSummary,
  confinedTempChild,
  createCancellationController,
  directorySnapshot,
  inspectPublishedPackage,
  inspectSeededPlanningRevision,
  inspectSeededPlanningStorage,
  inspectStoredReadyProject,
  main,
  parseArguments,
  pathEqualsOrIsNested,
  prepareDevToolsActivePort,
  processGroupState,
  raceCancellation,
  recordsDigest,
  readDirectFile,
  rehashHarnessProvenance,
  resolvePackageProof,
  resolvePackagedApp,
  resolveHarnessProvenance,
  resolveProofRoot,
  sourceClosureManifest,
  terminateLaunch,
  waitFor,
  waitForEvaluation,
  publishEvidenceIfAllowed,
  writeEvidence
};
