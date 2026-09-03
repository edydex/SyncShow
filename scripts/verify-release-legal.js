'use strict';

const fsp = require('node:fs/promises');
const path = require('node:path');
const asar = require('@electron/asar');

const {
  LEGAL_SCHEMA_VERSION,
  PDFJS_NOTICE_PATHS,
  RELEASE_BLOCKERS,
  resolveInside,
  sha256File
} = require('./package-legal-bundle');
const { packageTarget } = require('./lib/package-targets');

class ReleaseLegalVerificationError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'ReleaseLegalVerificationError';
    this.code = code;
    this.details = details;
  }
}

function fail(code, message, details = {}) {
  throw new ReleaseLegalVerificationError(code, message, details);
}

function parseArguments(argv) {
  let root = path.resolve('dist');
  let manifest = null;
  let evidenceOnly = false;
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--root' && argv[index + 1]) {
      root = path.resolve(argv[++index]);
    } else if (argv[index] === '--manifest' && argv[index + 1]) {
      manifest = path.resolve(argv[++index]);
    } else if (argv[index] === '--evidence-only') {
      evidenceOnly = true;
    } else {
      fail('INVALID_ARGUMENT', `Unknown or incomplete argument: ${argv[index]}`);
    }
  }
  return { evidenceOnly, manifest, root };
}

async function findFilesNamed(root, fileName) {
  const matches = [];
  async function visit(directory) {
    const entries = await fsp.readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const target = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        await visit(target);
      } else if (entry.isFile() && entry.name === fileName) {
        matches.push(target);
      }
    }
  }
  await visit(root);
  return matches.sort();
}

async function readJson(filePath) {
  const stats = await fsp.lstat(filePath).catch(error => {
    if (error.code === 'ENOENT') {
      fail('LEGAL_MANIFEST_MISSING', `Legal manifest is missing: ${filePath}`);
    }
    throw error;
  });
  if (!stats.isFile() || stats.isSymbolicLink() || stats.size < 1 || stats.size > 4 * 1024 * 1024) {
    fail('LEGAL_MANIFEST_UNSAFE', `Legal manifest is not a safe regular file: ${filePath}`);
  }
  try {
    return JSON.parse(await fsp.readFile(filePath, 'utf8'));
  } catch (_error) {
    fail('LEGAL_MANIFEST_INVALID', `Legal manifest is invalid JSON: ${filePath}`);
  }
}

function packageOutputRoot(manifestPath, platform) {
  const legalRoot = path.dirname(manifestPath);
  const resourcesRoot = path.dirname(legalRoot);
  if (path.basename(resourcesRoot).toLowerCase() !== 'resources') {
    fail('LEGAL_MANIFEST_LOCATION', 'Legal manifest is not under a packaged resources/legal directory.');
  }
  if (platform === 'darwin') {
    const contentsRoot = path.dirname(resourcesRoot);
    const applicationBundle = path.dirname(contentsRoot);
    if (
      path.basename(contentsRoot) !== 'Contents'
      || !path.basename(applicationBundle).endsWith('.app')
    ) {
      fail('LEGAL_MANIFEST_LOCATION', 'macOS legal manifest is outside an application bundle.');
    }
    return path.dirname(applicationBundle);
  }
  return path.dirname(resourcesRoot);
}

function safeRecordPath(root, value, kind) {
  if (
    typeof value !== 'string'
    || value.length < 1
    || value.includes('\\')
    || value.includes('\0')
  ) {
    fail('LEGAL_RECORD_PATH_INVALID', `${kind} contains an unsafe path.`);
  }
  try {
    return resolveInside(root, value);
  } catch (_error) {
    fail('LEGAL_RECORD_PATH_INVALID', `${kind} escaped its reviewed root.`);
  }
}

async function verifyFileRecord(root, record, kind) {
  if (
    !record
    || typeof record !== 'object'
    || Array.isArray(record)
    || !Number.isSafeInteger(record.size)
    || record.size < 1
    || !/^[a-f0-9]{64}$/u.test(record.sha256 || '')
  ) {
    fail('LEGAL_RECORD_INVALID', `${kind} has invalid size/hash metadata.`);
  }
  const filePath = safeRecordPath(root, record.path, kind);
  const stats = await fsp.lstat(filePath).catch(error => {
    if (error.code === 'ENOENT') {
      fail('LEGAL_EVIDENCE_MISSING', `${kind} is missing: ${record.path}`);
    }
    throw error;
  });
  if (!stats.isFile() || stats.isSymbolicLink() || stats.size !== record.size) {
    fail('LEGAL_EVIDENCE_CHANGED', `${kind} size or file type changed: ${record.path}`);
  }
  const digest = await sha256File(filePath);
  if (digest !== record.sha256) {
    fail('LEGAL_EVIDENCE_CHANGED', `${kind} hash changed: ${record.path}`);
  }
}

async function verifyNativeArtifactRecord(root, record) {
  if (
    !record
    || typeof record !== 'object'
    || Array.isArray(record)
    || typeof record.package !== 'string'
    || record.hashStage !== 'after-pack-before-platform-signing'
    || !Number.isSafeInteger(record.preSigningSize)
    || record.preSigningSize < 1
    || !/^[a-f0-9]{64}$/u.test(record.preSigningSha256 || '')
  ) {
    fail('NATIVE_INVENTORY_INCOMPLETE', 'Legal manifest native artifact provenance is invalid.');
  }
  const filePath = safeRecordPath(root, record.path, 'native artifact');
  const stats = await fsp.lstat(filePath).catch(error => {
    if (error.code === 'ENOENT') {
      fail('LEGAL_EVIDENCE_MISSING', `Native artifact is missing: ${record.path}`);
    }
    throw error;
  });
  if (!stats.isFile() || stats.isSymbolicLink() || stats.size < 1) {
    fail('LEGAL_EVIDENCE_CHANGED', `Native artifact is no longer a regular file: ${record.path}`);
  }
}

function exactBlockers(manifest) {
  const expected = RELEASE_BLOCKERS;
  const actual = manifest.releaseReadinessBlockers;
  return (
    Array.isArray(actual)
    && actual.length === expected.length
    && actual.every((blocker, index) => (
      blocker?.id === expected[index].id
      && blocker?.summary === expected[index].summary
      && Object.keys(blocker).sort().join(',') === 'id,summary'
    ))
  );
}

function exactRecordPaths(records, expectedPaths, kind) {
  if (!Array.isArray(records)) {
    fail('LEGAL_RECORD_INVALID', `Legal manifest ${kind} inventory is missing.`);
  }
  const actual = records.map(record => record?.path).sort();
  const expected = [...expectedPaths].sort();
  if (
    actual.length !== expected.length
    || actual.some((value, index) => value !== expected[index])
  ) {
    fail('LEGAL_RECORD_INVALID', `Legal manifest ${kind} inventory does not match the reviewed target set.`);
  }
}

async function packagedApplicationIdentity(legalRoot) {
  const archivePath = path.join(path.dirname(legalRoot), 'app.asar');
  const stats = await fsp.lstat(archivePath).catch(error => {
    if (error.code === 'ENOENT') {
      fail('LEGAL_EVIDENCE_MISSING', 'Packaged application archive is missing.');
    }
    throw error;
  });
  if (!stats.isFile() || stats.isSymbolicLink() || stats.size < 1) {
    fail('LEGAL_EVIDENCE_CHANGED', 'Packaged application archive is not a safe regular file.');
  }
  let packageJson;
  try {
    packageJson = JSON.parse(
      asar.extractFile(archivePath, 'package.json').toString('utf8')
    );
  } catch (_error) {
    fail(
      'LEGAL_COMPONENT_INVENTORY',
      'Packaged application identity could not be read from app.asar.'
    );
  }
  if (
    packageJson?.name !== 'sync-show'
    || typeof packageJson.version !== 'string'
    || packageJson.version.length < 1
    || packageJson.version.length > 100
  ) {
    fail(
      'LEGAL_COMPONENT_INVENTORY',
      'Packaged application identity is invalid.'
    );
  }
  return {
    name: packageJson.name,
    version: packageJson.version
  };
}

function verifyComponentInventory(manifest, target, packagedApplication) {
  const components = manifest.components;
  const expectedLockRecords = [
    ['@img/' + target.sharpPackage, '0.35.3'],
    ['@napi-rs/canvas', '1.0.3'],
    ['@napi-rs/' + target.canvasPackage, '1.0.3'],
    ['electron', '43.2.0'],
    ['pdfjs-dist', '6.2.108'],
    ['sharp', '0.35.3'],
    ...(target.libvipsPackage
      ? [['@img/' + target.libvipsPackage, '1.3.2']]
      : [])
  ].sort((left, right) => left[0].localeCompare(right[0], 'en'));
  if (
    !components
    || typeof components !== 'object'
    || Array.isArray(components)
    || components.application?.name !== packagedApplication.name
    || components.application?.version !== packagedApplication.version
    || components.application?.license !== 'MIT'
    || components.electron !== '43.2.0'
    || components.pdfjs !== '6.2.108'
    || components.canvas !== '1.0.3'
    || components.canvasTarget !== '1.0.3'
    || components.sharp !== '0.35.3'
    || components.sharpTarget !== '0.35.3'
    || components.libvipsTarget !== (
      target.libvipsPackage ? '1.3.2' : '0.35.3'
    )
    || !components.libvipsComponents
    || typeof components.libvipsComponents !== 'object'
    || Array.isArray(components.libvipsComponents)
    || Object.keys(components.libvipsComponents).length < 1
    || !Array.isArray(components.packageLockRecords)
    || components.packageLockRecords.length !== expectedLockRecords.length
  ) {
    fail('LEGAL_COMPONENT_INVENTORY', 'Legal manifest component inventory is incomplete or not the reviewed version set.');
  }
  const actualLockRecords = components.packageLockRecords
    .map(record => [record?.name, record?.version, record?.integrity])
    .sort((left, right) => String(left[0]).localeCompare(String(right[0]), 'en'));
  for (const [index, expected] of expectedLockRecords.entries()) {
    const actual = actualLockRecords[index];
    if (
      actual?.[0] !== expected[0]
      || actual?.[1] !== expected[1]
      || typeof actual?.[2] !== 'string'
      || !/^sha512-[A-Za-z0-9+/]+={0,2}$/u.test(actual[2])
    ) {
      fail('LEGAL_COMPONENT_INVENTORY', 'Legal manifest package-lock provenance is incomplete or not the reviewed target set.');
    }
  }
}

async function verifyChecksumFile(legalRoot) {
  const checksumPath = path.join(legalRoot, 'SHA256SUMS');
  const contents = await fsp.readFile(checksumPath, 'utf8').catch(error => {
    if (error.code === 'ENOENT') {
      fail('LEGAL_CHECKSUMS_MISSING', 'Legal bundle SHA256SUMS is missing.');
    }
    throw error;
  });
  const lines = contents.trimEnd().split('\n');
  if (lines.length < 1 || lines.some(line => !/^[a-f0-9]{64}  [^\0\r\n]+$/u.test(line))) {
    fail('LEGAL_CHECKSUMS_INVALID', 'Legal bundle SHA256SUMS has an invalid format.');
  }
  const records = lines.map(line => ({
    sha256: line.slice(0, 64),
    path: line.slice(66)
  }));
  const paths = records.map(record => record.path);
  if (
    new Set(paths).size !== paths.length
    || paths.includes('SHA256SUMS')
    || [...paths].sort((left, right) => left.localeCompare(right, 'en'))
      .some((value, index) => value !== paths[index])
  ) {
    fail('LEGAL_CHECKSUMS_INVALID', 'Legal bundle SHA256SUMS paths are duplicated or unsorted.');
  }

  const actualPaths = [];
  async function visit(directory, prefix = '') {
    const entries = await fsp.readdir(directory, { withFileTypes: true });
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name, 'en'))) {
      const candidate = path.join(directory, entry.name);
      const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) {
        fail('LEGAL_EVIDENCE_CHANGED', `Legal bundle contains a symbolic link: ${relativePath}`);
      }
      if (entry.isDirectory()) {
        await visit(candidate, relativePath);
      } else if (entry.isFile() && relativePath !== 'SHA256SUMS') {
        actualPaths.push(relativePath);
      }
    }
  }
  await visit(legalRoot);
  actualPaths.sort((left, right) => left.localeCompare(right, 'en'));
  if (
    actualPaths.length !== paths.length
    || actualPaths.some((value, index) => value !== paths[index])
  ) {
    fail('LEGAL_CHECKSUMS_INVALID', 'Legal bundle SHA256SUMS does not cover every bundled file exactly once.');
  }
  for (const record of records) {
    const filePath = safeRecordPath(legalRoot, record.path, 'checksum record');
    if (await sha256File(filePath) !== record.sha256) {
      fail('LEGAL_EVIDENCE_CHANGED', `Legal checksum failed: ${record.path}`);
    }
  }
}

async function verifyLegalBundle(manifestPath, { requireComplete = true } = {}) {
  const resolvedManifest = path.resolve(manifestPath);
  const legalRoot = path.dirname(resolvedManifest);
  const manifest = await readJson(resolvedManifest);
  if (
    manifest.schemaVersion !== LEGAL_SCHEMA_VERSION
    || manifest.inventoryScope !== 'partial-audited-components-only'
    || manifest.nativeArtifactHashScope !== 'after-pack-before-platform-signing'
    || !manifest.target
  ) {
    fail('LEGAL_MANIFEST_SCHEMA', 'Legal manifest schema or inventory scope is not reviewed.');
  }
  let target;
  try {
    target = packageTarget(manifest.target.platform, manifest.target.arch);
  } catch (_error) {
    fail('LEGAL_MANIFEST_TARGET', 'Legal manifest target is unsupported.');
  }
  if (manifest.target.key !== target.key) {
    fail('LEGAL_MANIFEST_TARGET', 'Legal manifest target fields disagree.');
  }
  if (
    manifest.releaseLegalStatus !== 'blocked'
    || !exactBlockers(manifest)
  ) {
    fail('LEGAL_STATUS_INVALID', 'Legal manifest does not preserve the reviewed blocked status and blocker set.');
  }
  const packagedApplication = await packagedApplicationIdentity(legalRoot);
  verifyComponentInventory(manifest, target, packagedApplication);

  const packageRoot = packageOutputRoot(resolvedManifest, target.platform);
  const expectedDocumentPaths = [
    'COMPONENTS.partial.json',
    'INDEX.html',
    'RELINKING.md',
    'SOURCE_AVAILABILITY.txt',
    'THIRD_PARTY_NOTICES.txt'
  ];
  const expectedNoticePaths = [
    'notices/syncshow/LICENSE.txt',
    ...PDFJS_NOTICE_PATHS.map(relativePath => (
      `notices/pdfjs-dist-6.2.108/${relativePath}`
    )),
    'notices/napi-rs-canvas-1.0.3/LICENSE',
    'notices/sharp-0.35.3/LICENSE',
    `notices/${target.sharpPackage}-0.35.3/LICENSE`,
    'notices/electron-43.2.0/LICENSE',
    'notices/electron-43.2.0/LICENSES.chromium.html',
    'notices/fonts/NotoSans-OFL.txt'
  ];
  const expectedProvenancePaths = [
    `provenance/${target.canvasPackage}/README.md`,
    `provenance/${target.sharpPackage}/README.md`,
    ...(target.libvipsPackage
      ? [
        `provenance/${target.libvipsPackage}/README.md`,
        `provenance/${target.libvipsPackage}/versions.json`
      ]
      : [`provenance/${target.sharpPackage}/versions.json`])
  ];
  exactRecordPaths(manifest.documents, expectedDocumentPaths, 'document');
  exactRecordPaths(manifest.notices, expectedNoticePaths, 'notice');
  exactRecordPaths(manifest.provenance, expectedProvenancePaths, 'provenance');
  const legalRecords = [];
  const seenPaths = new Set();
  for (const [kind, records] of [
    ['document', manifest.documents],
    ['notice', manifest.notices],
    ['provenance record', manifest.provenance]
  ]) {
    if (!Array.isArray(records) || records.length < 1) {
      fail('LEGAL_RECORD_INVALID', `Legal manifest ${kind} inventory is empty.`);
    }
    for (const record of records) {
      if (seenPaths.has(record?.path)) {
        fail('LEGAL_RECORD_INVALID', `Legal manifest path is duplicated: ${record?.path}`);
      }
      seenPaths.add(record?.path);
      legalRecords.push({ kind, record });
    }
  }
  for (const { kind, record } of legalRecords) {
    await verifyFileRecord(legalRoot, record, kind);
  }

  const expectedNativeArtifacts = [
    ...target.nativePackageArtifacts,
    {
      package: 'electron-ffmpeg',
      suffix: target.electronFfmpeg
    }
  ];
  if (
    !Array.isArray(manifest.nativeArtifacts)
    || manifest.nativeArtifacts.length !== expectedNativeArtifacts.length
  ) {
    fail('NATIVE_INVENTORY_INCOMPLETE', 'Legal manifest native artifact inventory is incomplete.');
  }
  const nativePaths = new Set();
  for (const record of manifest.nativeArtifacts) {
    if (
      typeof record?.package !== 'string'
      || nativePaths.has(record.path)
    ) {
      fail('NATIVE_INVENTORY_INCOMPLETE', 'Legal manifest native artifact inventory is duplicated or invalid.');
    }
    nativePaths.add(record.path);
    await verifyNativeArtifactRecord(packageRoot, record);
  }
  for (const expected of expectedNativeArtifacts) {
    const matches = manifest.nativeArtifacts.filter(record => (
      record.package === expected.package
      && (
        expected.package === 'electron-ffmpeg'
          ? path.posix.basename(record.path) === expected.suffix
          : record.path.endsWith(`/app.asar.unpacked/${expected.suffix}`)
      )
    ));
    if (matches.length !== 1) {
      fail('NATIVE_INVENTORY_INCOMPLETE', `Legal manifest does not identify exact native artifact ${expected.package}/${expected.suffix}.`);
    }
  }

  await verifyChecksumFile(legalRoot);
  if (requireComplete) {
    const blockerIds = manifest.releaseReadinessBlockers.map(blocker => blocker.id);
    fail(
      'RELEASE_LEGAL_BLOCKED',
      `Public release is blocked by incomplete native-component legal materials: ${blockerIds.join(', ')}.`,
      { blockerIds }
    );
  }
  return {
    manifest: resolvedManifest,
    target: target.key,
    releaseLegalStatus: manifest.releaseLegalStatus,
    blockerIds: manifest.releaseReadinessBlockers.map(blocker => blocker.id),
    evidenceVerification: 'passed'
  };
}

async function main(argv = process.argv.slice(2), stdout = process.stdout) {
  const options = parseArguments(argv);
  let manifestPath = options.manifest;
  if (!manifestPath) {
    const manifests = (await findFilesNamed(options.root, 'manifest.json'))
      .filter(candidate => path.basename(path.dirname(candidate)) === 'legal');
    if (manifests.length !== 1) {
      fail(
        'LEGAL_MANIFEST_COUNT',
        `Expected exactly one packaged legal/manifest.json under ${options.root}; found ${manifests.length}.`
      );
    }
    [manifestPath] = manifests;
  }
  const result = await verifyLegalBundle(manifestPath, {
    requireComplete: !options.evidenceOnly
  });
  stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  return result;
}

if (require.main === module) {
  main().catch(error => {
    process.stderr.write(`${error.code || error.name}: ${error.message}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  ReleaseLegalVerificationError,
  findFilesNamed,
  main,
  packageOutputRoot,
  parseArguments,
  verifyLegalBundle
};
