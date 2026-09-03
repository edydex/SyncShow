'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');

const asar = require('@electron/asar');
const { Arch } = require('builder-util');

const { packageTarget } = require('./lib/package-targets');

const LEGAL_SCHEMA_VERSION = 1;
const MAX_NOTICE_BYTES = 32 * 1024 * 1024;
const RELEASE_BLOCKERS = Object.freeze([
  Object.freeze({
    id: 'canvas-native-source-and-third-party-notices',
    summary: '@napi-rs/canvas lacks a target-specific Skia/Rust notice, source, and reproducible-build set tied to the shipped native binary.'
  }),
  Object.freeze({
    id: 'sharp-libvips-lgpl-corresponding-source',
    summary: 'The sharp/libvips bundle lacks complete target-specific license terms, exact corresponding source, build configuration, and tested relinking materials.'
  }),
  Object.freeze({
    id: 'electron-ffmpeg-corresponding-source-and-build-config',
    summary: 'Electron Chromium notices identify FFmpeg, but exact source, configuration, and tested replacement instructions tied to the shipped FFmpeg binary are absent.'
  })
]);
const PDFJS_NOTICE_PATHS = Object.freeze([
  'LICENSE',
  'cmaps/LICENSE',
  'iccs/LICENSE',
  'standard_fonts/LICENSE_FOXIT',
  'standard_fonts/LICENSE_LIBERATION',
  'wasm/LICENSE_JBIG2',
  'wasm/LICENSE_OPENJPEG',
  'wasm/LICENSE_PDFJS_JBIG2',
  'wasm/LICENSE_PDFJS_OPENJPEG',
  'wasm/LICENSE_PDFJS_QCMS',
  'wasm/LICENSE_QCMS'
]);

class LegalBundleError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'LegalBundleError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new LegalBundleError(code, message);
}

function posixPath(value) {
  return value.split(path.sep).join('/');
}

function stableJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function isContained(basePath, candidatePath) {
  const relative = path.relative(basePath, candidatePath);
  return relative === '' || (
    relative !== '..'
    && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative)
  );
}

function resolveInside(basePath, relativePath) {
  if (
    typeof relativePath !== 'string'
    || relativePath.length < 1
    || relativePath.includes('\0')
    || path.isAbsolute(relativePath)
  ) {
    fail('UNSAFE_LEGAL_PATH', 'A legal bundle path was not a safe relative path.');
  }
  const resolved = path.resolve(basePath, relativePath);
  if (!isContained(path.resolve(basePath), resolved)) {
    fail('UNSAFE_LEGAL_PATH', 'A legal bundle path escaped its reviewed root.');
  }
  return resolved;
}

async function regularFile(filePath, { maximumBytes = null } = {}) {
  const stats = await fsp.lstat(filePath).catch(error => {
    if (error.code === 'ENOENT') {
      fail('LEGAL_INPUT_MISSING', `Required legal input is missing: ${filePath}`);
    }
    throw error;
  });
  if (!stats.isFile() || stats.isSymbolicLink() || stats.size < 1) {
    fail('UNSAFE_LEGAL_INPUT', `Required legal input is not a non-empty regular file: ${filePath}`);
  }
  if (maximumBytes !== null && stats.size > maximumBytes) {
    fail('LEGAL_INPUT_TOO_LARGE', `Required legal input exceeds its reviewed size bound: ${filePath}`);
  }
  return stats;
}

async function sha256File(filePath) {
  await regularFile(filePath);
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const input = fs.createReadStream(filePath);
    input.on('error', reject);
    input.on('data', chunk => hash.update(chunk));
    input.on('end', () => resolve(hash.digest('hex')));
  });
}

function sha256Bytes(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

async function writeBundleFile(bundleRoot, relativePath, bytes) {
  const destination = resolveInside(bundleRoot, relativePath);
  await fsp.mkdir(path.dirname(destination), { recursive: true });
  await fsp.writeFile(destination, bytes, { flag: 'wx' });
  const stats = await regularFile(destination);
  return {
    path: posixPath(relativePath),
    size: stats.size,
    sha256: sha256Bytes(bytes)
  };
}

async function copyBundleFile(bundleRoot, relativePath, sourcePath) {
  const stats = await regularFile(sourcePath, { maximumBytes: MAX_NOTICE_BYTES });
  const bytes = await fsp.readFile(sourcePath);
  if (bytes.length !== stats.size) {
    fail('LEGAL_COPY_CHANGED', `Legal input changed while it was copied: ${sourcePath}`);
  }
  return writeBundleFile(bundleRoot, relativePath, bytes);
}

function extractAsarFile(archivePath, entryPath) {
  let bytes;
  try {
    bytes = asar.extractFile(archivePath, entryPath);
  } catch (error) {
    fail('LEGAL_ASAR_INPUT_MISSING', `Required staged ASAR input is missing: ${entryPath} (${error.message})`);
  }
  if (!Buffer.isBuffer(bytes) || bytes.length < 1 || bytes.length > MAX_NOTICE_BYTES) {
    fail('UNSAFE_LEGAL_INPUT', `Required staged ASAR input has an unsafe size: ${entryPath}`);
  }
  return bytes;
}

function readAsarJson(archivePath, entryPath) {
  try {
    return JSON.parse(extractAsarFile(archivePath, entryPath).toString('utf8'));
  } catch (error) {
    if (error instanceof LegalBundleError) throw error;
    fail('INVALID_STAGED_METADATA', `Staged metadata is invalid: ${entryPath}`);
  }
}

async function readJsonFile(filePath) {
  await regularFile(filePath, { maximumBytes: 2 * 1024 * 1024 });
  try {
    return JSON.parse(await fsp.readFile(filePath, 'utf8'));
  } catch (_error) {
    fail('INVALID_STAGED_METADATA', `Staged metadata is invalid: ${filePath}`);
  }
}

async function packageDirectories(scopePath, prefix) {
  const entries = await fsp.readdir(scopePath, { withFileTypes: true }).catch(error => {
    if (error.code === 'ENOENT') {
      fail('NATIVE_PACKAGE_SET_MISSING', `Staged native package scope is missing: ${scopePath}`);
    }
    throw error;
  });
  const names = [];
  for (const entry of entries) {
    if (entry.isSymbolicLink()) {
      fail('UNSAFE_NATIVE_PACKAGE', `Staged native package entry is a symbolic link: ${entry.name}`);
    }
    if (entry.isDirectory() && entry.name.startsWith(prefix)) names.push(entry.name);
  }
  return names.sort();
}

async function assertExactNativePackageSet(unpackedRoot, target) {
  const napiRoot = path.join(unpackedRoot, 'node_modules', '@napi-rs');
  const imgRoot = path.join(unpackedRoot, 'node_modules', '@img');
  const canvasPackages = await packageDirectories(napiRoot, 'canvas-');
  const sharpPackages = await packageDirectories(imgRoot, 'sharp-');
  const expectedSharpPackages = [
    target.sharpPackage,
    ...(target.libvipsPackage ? [target.libvipsPackage] : [])
  ].sort();
  if (
    canvasPackages.length !== 1
    || canvasPackages[0] !== target.canvasPackage
  ) {
    fail(
      'NATIVE_PACKAGE_TARGET_MISMATCH',
      `Staged canvas package set does not match ${target.key}: ${canvasPackages.join(', ') || 'none'}.`
    );
  }
  if (
    sharpPackages.length !== expectedSharpPackages.length
    || sharpPackages.some((name, index) => name !== expectedSharpPackages[index])
  ) {
    fail(
      'NATIVE_PACKAGE_TARGET_MISMATCH',
      `Staged sharp package set does not match ${target.key}: ${sharpPackages.join(', ') || 'none'}.`
    );
  }
}

function nativeArtifactName(name) {
  return (
    name.endsWith('.node')
    || name.endsWith('.dll')
    || name.endsWith('.dylib')
    || name.endsWith('.so')
    || name.includes('.so.')
  );
}

async function findNativeArtifacts(directory, appOutDir, packageName) {
  const artifacts = [];
  async function visit(currentPath) {
    const entries = await fsp.readdir(currentPath, { withFileTypes: true });
    for (const entry of entries) {
      const candidate = path.join(currentPath, entry.name);
      if (entry.isSymbolicLink()) {
        fail('UNSAFE_NATIVE_ARTIFACT', `Staged native package contains a symbolic link: ${candidate}`);
      }
      if (entry.isDirectory()) {
        await visit(candidate);
      } else if (entry.isFile() && nativeArtifactName(entry.name)) {
        const stats = await regularFile(candidate);
        artifacts.push({
          package: packageName,
          path: posixPath(path.relative(appOutDir, candidate)),
          hashStage: 'after-pack-before-platform-signing',
          preSigningSize: stats.size,
          preSigningSha256: await sha256File(candidate)
        });
      }
    }
  }
  await visit(directory);
  return artifacts.sort((left, right) => left.path.localeCompare(right.path, 'en'));
}

async function findFilesNamed(rootPath, expectedName) {
  const matches = [];
  async function visit(currentPath) {
    const entries = await fsp.readdir(currentPath, { withFileTypes: true });
    for (const entry of entries) {
      const candidate = path.join(currentPath, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (entry.name !== 'legal') await visit(candidate);
      } else if (entry.isFile() && entry.name === expectedName) {
        matches.push(candidate);
      }
    }
  }
  await visit(rootPath);
  return matches.sort();
}

async function packageMetadata(packageRoot, expectedVersion = null) {
  const metadata = await readJsonFile(path.join(packageRoot, 'package.json'));
  if (
    typeof metadata.name !== 'string'
    || typeof metadata.version !== 'string'
    || (expectedVersion !== null && metadata.version !== expectedVersion)
  ) {
    fail('NATIVE_PACKAGE_VERSION_MISMATCH', `Staged package metadata is not the reviewed version: ${packageRoot}`);
  }
  return metadata;
}

function installedPackageRecord(lock, packageName, expectedVersion) {
  const key = `node_modules/${packageName}`;
  const record = lock.packages?.[key];
  if (
    !record
    || record.version !== expectedVersion
    || typeof record.integrity !== 'string'
  ) {
    fail('PACKAGE_LOCK_MISMATCH', `Package lock is missing the reviewed record for ${packageName}@${expectedVersion}.`);
  }
  return {
    name: packageName,
    version: record.version,
    integrity: record.integrity
  };
}

function legalIndexHtml(appVersion, target) {
  const blockers = RELEASE_BLOCKERS
    .map(blocker => `<li><code>${blocker.id}</code>: ${blocker.summary}</li>`)
    .join('\n');
  return Buffer.from(`<!doctype html>
<html lang="en">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>SyncShow ${appVersion} legal materials</title>
<style>body{font:16px/1.5 system-ui,sans-serif;max-width:58rem;margin:3rem auto;padding:0 1rem}code{font-size:.9em}strong{color:#8a1c1c}</style>
<h1>SyncShow ${appVersion} legal materials</h1>
<p>Package target: <code>${target.key}</code>.</p>
<p><strong>This is a diagnostic QA package, not a public-release clearance.</strong></p>
<p>The copied notices and hashes in this directory are useful evidence, but the audited runtime inventory and corresponding-source/relinking set are incomplete. SyncShow's release workflow rejects this package while any blocker remains.</p>
<p>Native-binary hashes are explicitly labeled <code>after-pack-before-platform-signing</code>. Platform signing can rewrite those binaries after this in-package manifest is sealed; the final package signature, not this pre-signing digest, protects the signed bytes.</p>
<h2>Current blockers</h2>
<ul>${blockers}</ul>
<p>See <code>manifest.json</code>, <code>THIRD_PARTY_NOTICES.txt</code>, <code>SOURCE_AVAILABILITY.txt</code>, and <code>RELINKING.md</code>.</p>
</html>
`, 'utf8');
}

function thirdPartyNoticeText(target) {
  return Buffer.from(`SyncShow third-party notice evidence
Target: ${target.key}

This package contains third-party software under separate license terms.
The files under notices/ are copied from the exact staged application or the
matching installed Electron/native package used to make this target.

Native artifact digests in manifest.json are pre-signing provenance. macOS and
Windows signing may rewrite the native files after the afterPack hook. They are
not represented as final signed-file hashes.

Audited notice groups currently included:
- PDF.js 6.2.108 and its bundled CMap, ICC, standard-font, and WASM notices
- @napi-rs/canvas 1.0.3 wrapper license
- sharp 0.35.3 wrapper and target-package licenses
- target-specific sharp-libvips package provenance when applicable
- Electron 43.2.0 and Chromium third-party notices
- SyncShow's bundled Noto Sans font license

This is intentionally not described as a complete notice inventory. See
manifest.json for hashed evidence and the blockers that prevent distribution.
`, 'utf8');
}

function sourceAvailabilityText(target) {
  return Buffer.from(`SyncShow source availability status
Target: ${target.key}

No complete, immutable corresponding-source archive is currently declared for
this binary. In particular, the package lacks reviewed target-specific source
and build materials for @napi-rs/canvas/Skia, sharp/libvips and its bundled
dependencies, and Electron's FFmpeg library.

This file is not a written offer and does not authorize public distribution.
The release verification command exits with RELEASE_LEGAL_BLOCKED until exact
source archive URLs, hashes, retention, and replacement instructions have been
reviewed and locked to the shipped native binaries.
`, 'utf8');
}

function relinkingText(target) {
  return Buffer.from(`# SyncShow relinking status

Target: \`${target.key}\`

The practical replacement/relinking procedure for the LGPL components in this
package has not yet been completed or tested. A public release must provide the
exact corresponding source and build configuration, plus instructions that let
a recipient rebuild or replace the relevant libraries on this target. On
signed platforms, those instructions must also cover the signing implications.

The release gate treats this missing procedure as a hard blocker.
`, 'utf8');
}

function partialComponents(components, target) {
  return Buffer.from(stableJson({
    schemaVersion: 1,
    inventoryStatus: 'partial-audited-components-only',
    warning: 'This is not a complete SPDX inventory and must not be used as public-release clearance.',
    target: target.key,
    components
  }), 'utf8');
}

async function buildLegalBundle(context) {
  if (
    !context
    || typeof context.appOutDir !== 'string'
    || !context.packager
    || typeof context.packager.getResourcesDir !== 'function'
    || typeof context.packager.projectDir !== 'string'
  ) {
    fail('INVALID_PACK_CONTEXT', 'Legal bundle generation requires an electron-builder afterPack context.');
  }
  const arch = typeof context.arch === 'string' ? context.arch : Arch[context.arch];
  const target = packageTarget(context.electronPlatformName, arch);
  const appOutDir = path.resolve(context.appOutDir);
  const resourcesRoot = path.resolve(context.packager.getResourcesDir(appOutDir));
  if (!isContained(appOutDir, resourcesRoot)) {
    fail('UNSAFE_RESOURCES_PATH', 'The packaged resources path escaped the application output directory.');
  }

  const archivePath = path.join(resourcesRoot, 'app.asar');
  await regularFile(archivePath);
  const unpackedRoot = `${archivePath}.unpacked`;
  await assertExactNativePackageSet(unpackedRoot, target);

  const appManifest = readAsarJson(archivePath, 'package.json');
  const pdfManifest = readAsarJson(
    archivePath,
    'node_modules/pdfjs-dist/package.json'
  );
  if (
    appManifest.version !== context.packager.appInfo?.version
    || pdfManifest.version !== '6.2.108'
  ) {
    fail('PACKAGE_VERSION_MISMATCH', 'The staged application/PDF.js versions do not match the packager context.');
  }

  const projectDir = path.resolve(context.packager.projectDir);
  const packageLock = await readJsonFile(path.join(projectDir, 'package-lock.json'));
  const canvasRoot = path.join(unpackedRoot, 'node_modules', '@napi-rs', 'canvas');
  const canvasTargetRoot = path.join(
    unpackedRoot,
    'node_modules',
    '@napi-rs',
    target.canvasPackage
  );
  const sharpRoot = path.join(unpackedRoot, 'node_modules', 'sharp');
  const sharpTargetRoot = path.join(
    unpackedRoot,
    'node_modules',
    '@img',
    target.sharpPackage
  );
  const libvipsTargetRoot = target.libvipsPackage
    ? path.join(unpackedRoot, 'node_modules', '@img', target.libvipsPackage)
    : null;

  const canvasMetadata = await packageMetadata(canvasRoot, '1.0.3');
  const canvasTargetMetadata = await packageMetadata(canvasTargetRoot, '1.0.3');
  const sharpMetadata = await packageMetadata(sharpRoot, '0.35.3');
  const sharpTargetMetadata = await packageMetadata(sharpTargetRoot, '0.35.3');
  const libvipsMetadata = libvipsTargetRoot
    ? await packageMetadata(libvipsTargetRoot, '1.3.2')
    : null;

  const frameworkVersion = context.packager.info?.framework?.version;
  if (frameworkVersion !== '43.2.0') {
    fail('ELECTRON_VERSION_MISMATCH', 'The packaged Electron framework is not the reviewed 43.2.0 version.');
  }
  if (context.packager.config?.electronDist) {
    fail('CUSTOM_ELECTRON_DIST_UNREVIEWED', 'A custom Electron distribution cannot use the reviewed legal evidence path.');
  }
  const installedElectron = await packageMetadata(
    path.join(projectDir, 'node_modules', 'electron'),
    frameworkVersion
  );

  const lockRecords = [
    installedPackageRecord(packageLock, '@napi-rs/canvas', canvasMetadata.version),
    installedPackageRecord(
      packageLock,
      `@napi-rs/${target.canvasPackage}`,
      canvasTargetMetadata.version
    ),
    installedPackageRecord(packageLock, 'pdfjs-dist', pdfManifest.version),
    installedPackageRecord(packageLock, 'sharp', sharpMetadata.version),
    installedPackageRecord(
      packageLock,
      `@img/${target.sharpPackage}`,
      sharpTargetMetadata.version
    ),
    installedPackageRecord(packageLock, 'electron', installedElectron.version)
  ];
  if (target.libvipsPackage && libvipsMetadata) {
    lockRecords.push(installedPackageRecord(
      packageLock,
      `@img/${target.libvipsPackage}`,
      libvipsMetadata.version
    ));
  }
  lockRecords.sort((left, right) => left.name.localeCompare(right.name, 'en'));

  const legalRoot = path.join(resourcesRoot, 'legal');
  const stagingRoot = path.join(resourcesRoot, '.syncshow-legal-staging');
  for (const generatedPath of [stagingRoot, legalRoot]) {
    if (!isContained(resourcesRoot, generatedPath)) {
      fail('UNSAFE_LEGAL_PATH', 'A generated legal path escaped the resources directory.');
    }
    const existing = await fsp.lstat(generatedPath).catch(error => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (existing?.isSymbolicLink()) {
      fail('UNSAFE_LEGAL_PATH', 'A generated legal path is a symbolic link.');
    }
  }
  await fsp.rm(stagingRoot, { recursive: true, force: true });
  await fsp.mkdir(stagingRoot, { recursive: false });

  const notices = [];
  const provenance = [];
  notices.push(await copyBundleFile(
    stagingRoot,
    'notices/syncshow/LICENSE.txt',
    path.join(projectDir, 'LICENSE.txt')
  ));
  for (const relativePath of PDFJS_NOTICE_PATHS) {
    notices.push(await writeBundleFile(
      stagingRoot,
      `notices/pdfjs-dist-6.2.108/${relativePath}`,
      extractAsarFile(
        archivePath,
        `node_modules/pdfjs-dist/${relativePath}`
      )
    ));
  }
  notices.push(await copyBundleFile(
    stagingRoot,
    'notices/napi-rs-canvas-1.0.3/LICENSE',
    path.join(canvasRoot, 'LICENSE')
  ));
  notices.push(await copyBundleFile(
    stagingRoot,
    'notices/sharp-0.35.3/LICENSE',
    path.join(sharpRoot, 'LICENSE')
  ));
  notices.push(await copyBundleFile(
    stagingRoot,
    `notices/${target.sharpPackage}-${sharpTargetMetadata.version}/LICENSE`,
    path.join(sharpTargetRoot, 'LICENSE')
  ));

  const electronNoticeRoot = target.platform === 'darwin'
    ? path.join(projectDir, 'node_modules', 'electron', 'dist')
    : appOutDir;
  const electronLicenseName = target.platform === 'darwin'
    ? 'LICENSE'
    : 'LICENSE.electron.txt';
  notices.push(await copyBundleFile(
    stagingRoot,
    'notices/electron-43.2.0/LICENSE',
    path.join(electronNoticeRoot, electronLicenseName)
  ));
  notices.push(await copyBundleFile(
    stagingRoot,
    'notices/electron-43.2.0/LICENSES.chromium.html',
    path.join(electronNoticeRoot, 'LICENSES.chromium.html')
  ));

  const fontLicense = path.join(
    unpackedRoot,
    'assets',
    'fonts',
    'OFL-NotoSans.txt'
  );
  notices.push(await copyBundleFile(
    stagingRoot,
    'notices/fonts/NotoSans-OFL.txt',
    fontLicense
  ));

  const canvasSourceTargetRoot = path.join(
    projectDir,
    'node_modules',
    '@napi-rs',
    target.canvasPackage
  );
  const sharpSourceTargetRoot = path.join(
    projectDir,
    'node_modules',
    '@img',
    target.sharpPackage
  );
  provenance.push(await copyBundleFile(
    stagingRoot,
    `provenance/${target.canvasPackage}/README.md`,
    path.join(canvasSourceTargetRoot, 'README.md')
  ));
  provenance.push(await copyBundleFile(
    stagingRoot,
    `provenance/${target.sharpPackage}/README.md`,
    path.join(sharpSourceTargetRoot, 'README.md')
  ));
  if (target.platform === 'win32') {
    provenance.push(await copyBundleFile(
      stagingRoot,
      `provenance/${target.sharpPackage}/versions.json`,
      path.join(sharpSourceTargetRoot, 'versions.json')
    ));
  }
  if (target.libvipsPackage) {
    const sourceLibvipsRoot = path.join(
      projectDir,
      'node_modules',
      '@img',
      target.libvipsPackage
    );
    provenance.push(await copyBundleFile(
      stagingRoot,
      `provenance/${target.libvipsPackage}/README.md`,
      path.join(sourceLibvipsRoot, 'README.md')
    ));
    provenance.push(await copyBundleFile(
      stagingRoot,
      `provenance/${target.libvipsPackage}/versions.json`,
      path.join(sourceLibvipsRoot, 'versions.json')
    ));
  }

  const nativeArtifacts = [
    ...await findNativeArtifacts(canvasTargetRoot, appOutDir, `@napi-rs/${target.canvasPackage}`),
    ...await findNativeArtifacts(sharpTargetRoot, appOutDir, `@img/${target.sharpPackage}`)
  ];
  if (libvipsTargetRoot) {
    nativeArtifacts.push(...await findNativeArtifacts(
      libvipsTargetRoot,
      appOutDir,
      `@img/${target.libvipsPackage}`
    ));
  }
  const ffmpegMatches = await findFilesNamed(appOutDir, target.electronFfmpeg);
  if (ffmpegMatches.length !== 1) {
    fail(
      'ELECTRON_FFMPEG_SET_MISMATCH',
      `Expected exactly one ${target.electronFfmpeg} in the staged application; found ${ffmpegMatches.length}.`
    );
  }
  const ffmpegStats = await regularFile(ffmpegMatches[0]);
  nativeArtifacts.push({
    package: 'electron-ffmpeg',
    path: posixPath(path.relative(appOutDir, ffmpegMatches[0])),
    hashStage: 'after-pack-before-platform-signing',
    preSigningSize: ffmpegStats.size,
    preSigningSha256: await sha256File(ffmpegMatches[0])
  });
  nativeArtifacts.sort((left, right) => left.path.localeCompare(right.path, 'en'));

  const libvipsComponents = target.libvipsPackage
    ? await readJsonFile(path.join(
      projectDir,
      'node_modules',
      '@img',
      target.libvipsPackage,
      'versions.json'
    ))
    : await readJsonFile(path.join(sharpSourceTargetRoot, 'versions.json'));
  const components = {
    application: {
      name: appManifest.name,
      version: appManifest.version,
      license: appManifest.license
    },
    electron: installedElectron.version,
    pdfjs: pdfManifest.version,
    canvas: canvasMetadata.version,
    canvasTarget: canvasTargetMetadata.version,
    sharp: sharpMetadata.version,
    sharpTarget: sharpTargetMetadata.version,
    libvipsTarget: libvipsMetadata?.version || sharpTargetMetadata.version,
    packageLockRecords: lockRecords,
    libvipsComponents
  };

  const documents = [];
  documents.push(await writeBundleFile(
    stagingRoot,
    'INDEX.html',
    legalIndexHtml(appManifest.version, target)
  ));
  documents.push(await writeBundleFile(
    stagingRoot,
    'THIRD_PARTY_NOTICES.txt',
    thirdPartyNoticeText(target)
  ));
  documents.push(await writeBundleFile(
    stagingRoot,
    'SOURCE_AVAILABILITY.txt',
    sourceAvailabilityText(target)
  ));
  documents.push(await writeBundleFile(
    stagingRoot,
    'RELINKING.md',
    relinkingText(target)
  ));
  documents.push(await writeBundleFile(
    stagingRoot,
    'COMPONENTS.partial.json',
    partialComponents(components, target)
  ));

  const manifest = {
    schemaVersion: LEGAL_SCHEMA_VERSION,
    releaseLegalStatus: 'blocked',
    inventoryScope: 'partial-audited-components-only',
    nativeArtifactHashScope: 'after-pack-before-platform-signing',
    target: {
      platform: target.platform,
      arch: target.arch,
      key: target.key
    },
    components,
    documents: documents.sort((left, right) => left.path.localeCompare(right.path, 'en')),
    notices: notices.sort((left, right) => left.path.localeCompare(right.path, 'en')),
    provenance: provenance.sort((left, right) => left.path.localeCompare(right.path, 'en')),
    nativeArtifacts,
    releaseReadinessBlockers: RELEASE_BLOCKERS
  };
  await writeBundleFile(
    stagingRoot,
    'manifest.json',
    Buffer.from(stableJson(manifest), 'utf8')
  );

  const checksumFiles = [];
  async function collectChecksums(directory, prefix = '') {
    const entries = await fsp.readdir(directory, { withFileTypes: true });
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name, 'en'))) {
      const candidate = path.join(directory, entry.name);
      const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) {
        fail('UNSAFE_LEGAL_OUTPUT', `Generated legal bundle contains a symbolic link: ${relativePath}`);
      }
      if (entry.isDirectory()) {
        await collectChecksums(candidate, relativePath);
      } else if (entry.isFile()) {
        checksumFiles.push({
          path: relativePath,
          sha256: await sha256File(candidate)
        });
      }
    }
  }
  await collectChecksums(stagingRoot);
  const sums = checksumFiles
    .sort((left, right) => left.path.localeCompare(right.path, 'en'))
    .map(record => `${record.sha256}  ${record.path}`)
    .join('\n');
  await writeBundleFile(
    stagingRoot,
    'SHA256SUMS',
    Buffer.from(`${sums}\n`, 'utf8')
  );

  await fsp.rm(legalRoot, { recursive: true, force: true });
  await fsp.rename(stagingRoot, legalRoot);
  return {
    legalRoot,
    manifest
  };
}

module.exports = {
  LEGAL_SCHEMA_VERSION,
  LegalBundleError,
  PDFJS_NOTICE_PATHS,
  RELEASE_BLOCKERS,
  buildLegalBundle,
  resolveInside,
  sha256File
};
