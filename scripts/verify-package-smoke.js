'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');

const asar = require('@electron/asar');

const { packageTarget } = require('./lib/package-targets');
const sourceManifest = require('../package.json');

const PACKAGE_SMOKE_SCHEMA_VERSION = 1;
const SOURCE_APPLICATION = Object.freeze({
  name: sourceManifest.name,
  productName: sourceManifest.build?.productName || sourceManifest.productName,
  version: sourceManifest.version
});
const DISTRIBUTABLE_EXTENSIONS = Object.freeze([
  '.AppImage',
  '.deb',
  '.dmg',
  '.exe',
  '.zip'
]);

class PackageSmokeVerificationError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'PackageSmokeVerificationError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new PackageSmokeVerificationError(code, message);
}

function posixPath(value) {
  return value.split(path.sep).join('/');
}

function isContained(basePath, candidatePath) {
  const relative = path.relative(basePath, candidatePath);
  return relative === '' || (
    relative !== '..'
    && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative)
  );
}

function pathInside(root, candidate, kind) {
  const resolvedRoot = path.resolve(root);
  const resolvedCandidate = path.resolve(candidate);
  if (!isContained(resolvedRoot, resolvedCandidate)) {
    fail('UNSAFE_PACKAGE_PATH', `${kind} escaped the QA package root.`);
  }
  return resolvedCandidate;
}

async function regularFile(filePath, kind) {
  const stats = await fsp.lstat(filePath).catch(error => {
    if (error.code === 'ENOENT') {
      fail('PACKAGE_FILE_MISSING', `${kind} is missing: ${filePath}`);
    }
    throw error;
  });
  if (!stats.isFile() || stats.isSymbolicLink() || stats.size < 1) {
    fail('UNSAFE_PACKAGE_FILE', `${kind} is not a non-empty regular file: ${filePath}`);
  }
  return stats;
}

async function sha256File(filePath) {
  await regularFile(filePath, 'hashed package file');
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const input = fs.createReadStream(filePath);
    input.on('error', reject);
    input.on('data', chunk => hash.update(chunk));
    input.on('end', () => resolve(hash.digest('hex')));
  });
}

async function fileRecord(root, filePath, kind, extra = {}) {
  const safePath = pathInside(root, filePath, kind);
  const stats = await regularFile(safePath, kind);
  return {
    path: posixPath(path.relative(root, safePath)),
    size: stats.size,
    sha256: await sha256File(safePath),
    ...extra
  };
}

async function findFilesNamed(root, fileName) {
  const matches = [];
  async function visit(directory) {
    const entries = await fsp.readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const candidate = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        // Electron's macOS frameworks contain reviewed internal symlinks.
        // Never follow them while locating evidence; exact recorded files are
        // independently required to be regular non-symlink files.
        continue;
      }
      if (entry.isDirectory()) {
        await visit(candidate);
      } else if (entry.isFile() && entry.name === fileName) {
        matches.push(candidate);
      }
    }
  }
  await visit(root);
  return matches.sort();
}

function readAsarJson(archivePath, entryPath) {
  try {
    return JSON.parse(asar.extractFile(archivePath, entryPath).toString('utf8'));
  } catch (error) {
    fail(
      'PACKAGE_ARCHIVE_INVALID',
      `Could not read ${entryPath} from app.asar: ${error.message}`
    );
  }
}

function normalizedApplicationIdentity(manifest) {
  const name = manifest?.name;
  const version = manifest?.version;
  // electron-builder deliberately removes the top-level build configuration
  // from the packaged package.json. Use the checked-out source identity only
  // when the packaged npm name is already an exact match.
  const productName = manifest?.build?.productName
    || manifest?.productName
    || (name === SOURCE_APPLICATION.name ? SOURCE_APPLICATION.productName : null);
  if (
    name !== SOURCE_APPLICATION.name
    || version !== SOURCE_APPLICATION.version
    || productName !== SOURCE_APPLICATION.productName
  ) {
    fail(
      'PACKAGE_IDENTITY_INVALID',
      'Packaged application identity does not match the checked-out source.'
    );
  }
  return { name, productName, version };
}

function expectedArtifactNames(target, application) {
  if (target.key === 'win32-x64') {
    return [`${application.productName} Setup ${application.version}.exe`];
  }
  if (target.key === 'darwin-arm64' || target.key === 'darwin-x64') {
    return [
      `${application.productName}-${application.version}-${target.arch}.dmg`,
      `${application.productName}-${application.version}-${target.arch}.zip`
    ].sort();
  }
  if (target.key === 'linux-x64') {
    return [
      `${application.productName}-${application.version}.AppImage`,
      `${application.name}_${application.version}_amd64.deb`
    ].sort();
  }
  fail('PACKAGE_TARGET_UNSUPPORTED', `Unsupported QA artifact target: ${target.key}.`);
}

async function exactDistributableArtifacts(root, expectedNames) {
  const entries = await fsp.readdir(root, { withFileTypes: true });
  const artifacts = [];
  for (const entry of entries) {
    const candidate = path.join(root, entry.name);
    if (
      DISTRIBUTABLE_EXTENSIONS.some(extension => entry.name.endsWith(extension))
    ) {
      if (entry.isSymbolicLink() || !entry.isFile()) {
        fail(
          'PACKAGE_ARTIFACT_UNSAFE',
          `QA distributable is not a regular file: ${entry.name}`
        );
      }
      artifacts.push(entry.name);
    }
  }
  artifacts.sort();
  const expected = [...expectedNames].sort();
  if (
    artifacts.length !== expected.length
    || artifacts.some((artifact, index) => artifact !== expected[index])
  ) {
    fail(
      'PACKAGE_ARTIFACT_INVENTORY',
      `Expected QA artifacts ${expected.join(', ')}; found ${artifacts.join(', ') || 'none'}.`
    );
  }
  return artifacts.map(name => path.join(root, name));
}

async function readPrefix(filePath, size = 4096) {
  const handle = await fsp.open(filePath, 'r');
  try {
    const buffer = Buffer.alloc(size);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

function machineArchitecture(machine) {
  if (machine === 0x8664 || machine === 0x01000007 || machine === 62) {
    return 'x64';
  }
  if (machine === 0xaa64 || machine === 0x0100000c || machine === 183) {
    return 'arm64';
  }
  return null;
}

async function binaryArchitecture(filePath) {
  await regularFile(filePath, 'architecture input');
  const prefix = await readPrefix(filePath);
  if (prefix.length < 64) {
    fail('PACKAGE_ARCHITECTURE_UNKNOWN', `Binary is too small: ${filePath}`);
  }

  if (prefix[0] === 0x4d && prefix[1] === 0x5a) {
    const peOffset = prefix.readUInt32LE(0x3c);
    let header = prefix.subarray(peOffset, peOffset + 6);
    if (header.length < 6) {
      const handle = await fsp.open(filePath, 'r');
      try {
        const peHeader = Buffer.alloc(6);
        const { bytesRead } = await handle.read(peHeader, 0, peHeader.length, peOffset);
        header = peHeader.subarray(0, bytesRead);
      } finally {
        await handle.close();
      }
    }
    if (
      header.length !== 6
      || header.subarray(0, 4).toString('binary') !== 'PE\0\0'
    ) {
      fail('PACKAGE_ARCHITECTURE_UNKNOWN', `Invalid PE header: ${filePath}`);
    }
    const architecture = machineArchitecture(header.readUInt16LE(4));
    if (!architecture) {
      fail('PACKAGE_ARCHITECTURE_UNKNOWN', `Unsupported PE machine: ${filePath}`);
    }
    return architecture;
  }

  if (
    prefix[0] === 0x7f
    && prefix[1] === 0x45
    && prefix[2] === 0x4c
    && prefix[3] === 0x46
  ) {
    if (prefix[4] !== 2 || ![1, 2].includes(prefix[5])) {
      fail('PACKAGE_ARCHITECTURE_UNKNOWN', `Unsupported ELF class: ${filePath}`);
    }
    const machine = prefix[5] === 1
      ? prefix.readUInt16LE(18)
      : prefix.readUInt16BE(18);
    const architecture = machineArchitecture(machine);
    if (!architecture) {
      fail('PACKAGE_ARCHITECTURE_UNKNOWN', `Unsupported ELF machine: ${filePath}`);
    }
    return architecture;
  }

  const magicLe = prefix.readUInt32LE(0);
  const magicBe = prefix.readUInt32BE(0);
  let cpuType = null;
  if (magicLe === 0xfeedfacf) {
    cpuType = prefix.readUInt32LE(4);
  } else if (magicBe === 0xfeedfacf) {
    cpuType = prefix.readUInt32BE(4);
  } else if (
    magicBe === 0xcafebabe
    || magicBe === 0xcafebabf
    || magicLe === 0xcafebabe
    || magicLe === 0xcafebabf
  ) {
    fail(
      'PACKAGE_ARCHITECTURE_MIXED',
      `QA package requires a thin target binary, not a universal Mach-O: ${filePath}`
    );
  }
  if (cpuType !== null) {
    const architecture = machineArchitecture(cpuType);
    if (!architecture) {
      fail('PACKAGE_ARCHITECTURE_UNKNOWN', `Unsupported Mach-O CPU: ${filePath}`);
    }
    return architecture;
  }

  fail('PACKAGE_ARCHITECTURE_UNKNOWN', `Unrecognized binary format: ${filePath}`);
}

function packageLayout(archivePath, target, application) {
  const resourcesRoot = path.dirname(archivePath);
  if (path.basename(resourcesRoot).toLowerCase() !== 'resources') {
    fail('PACKAGE_LAYOUT_INVALID', 'app.asar is outside a packaged resources directory.');
  }
  if (target.platform === 'darwin') {
    const contentsRoot = path.dirname(resourcesRoot);
    const applicationBundle = path.dirname(contentsRoot);
    if (
      path.basename(contentsRoot) !== 'Contents'
      || !path.basename(applicationBundle).endsWith('.app')
    ) {
      fail('PACKAGE_LAYOUT_INVALID', 'macOS app.asar is outside an application bundle.');
    }
    return {
      applicationRoot: applicationBundle,
      runtimePath: path.join(
        contentsRoot,
        'MacOS',
        application.productName
      )
    };
  }
  const applicationRoot = path.dirname(resourcesRoot);
  return {
    applicationRoot,
    runtimePath: target.platform === 'win32'
      ? path.join(applicationRoot, `${application.productName}.exe`)
      : path.join(applicationRoot, application.name)
  };
}

async function exactFileNamed(root, fileName, kind) {
  const matches = await findFilesNamed(root, fileName);
  if (matches.length !== 1) {
    fail(
      'PACKAGE_FILE_INVENTORY',
      `Expected exactly one ${kind} named ${fileName}; found ${matches.length}.`
    );
  }
  return matches[0];
}

async function architectureRecord(root, filePath, kind, expectedArchitecture, extra = {}) {
  const architecture = await binaryArchitecture(filePath);
  if (architecture !== expectedArchitecture) {
    fail(
      'PACKAGE_ARCHITECTURE_MISMATCH',
      `${kind} is ${architecture}; expected ${expectedArchitecture}: ${filePath}`
    );
  }
  return fileRecord(root, filePath, kind, { architecture, ...extra });
}

function parseArguments(argv) {
  const options = {
    root: path.resolve('dist'),
    platform: null,
    arch: null,
    manifest: null,
    sourceRevision: null
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const value = argv[index + 1];
    if (argument === '--root' && value) {
      options.root = path.resolve(value);
      index += 1;
    } else if (argument === '--platform' && value) {
      options.platform = value;
      index += 1;
    } else if (argument === '--arch' && value) {
      options.arch = value;
      index += 1;
    } else if (argument === '--manifest' && value) {
      options.manifest = path.resolve(value);
      index += 1;
    } else if (argument === '--source-revision' && value) {
      options.sourceRevision = value;
      index += 1;
    } else {
      fail('INVALID_ARGUMENT', `Unknown or incomplete argument: ${argument}`);
    }
  }
  if (!options.platform || !options.arch || !options.sourceRevision) {
    fail(
      'INVALID_ARGUMENT',
      '--platform, --arch, and --source-revision are required.'
    );
  }
  if (!options.manifest) {
    options.manifest = path.join(
      options.root,
      `package-smoke-${options.platform}-${options.arch}.json`
    );
  }
  return options;
}

async function verifyPackageSmoke({
  root,
  platform,
  arch,
  manifest,
  sourceRevision,
  enforceHost = true
}) {
  const resolvedRoot = path.resolve(root);
  const rootStats = await fsp.lstat(resolvedRoot).catch(() => null);
  if (!rootStats?.isDirectory() || rootStats.isSymbolicLink()) {
    fail('PACKAGE_ROOT_INVALID', 'QA package root must be a real directory.');
  }
  if (!/^[a-f0-9]{40}$/u.test(sourceRevision || '')) {
    fail('SOURCE_REVISION_INVALID', 'QA source revision must be a full Git SHA.');
  }
  let target;
  try {
    target = packageTarget(platform, arch);
  } catch (_error) {
    fail('PACKAGE_TARGET_UNSUPPORTED', `Unsupported QA target: ${platform}-${arch}.`);
  }
  if (
    enforceHost
    && (process.platform !== target.platform || process.arch !== target.arch)
  ) {
    fail(
      'PACKAGE_HOST_MISMATCH',
      `QA verifier host ${process.platform}-${process.arch} does not match ${target.key}.`
    );
  }

  const archives = await findFilesNamed(resolvedRoot, 'app.asar');
  if (archives.length !== 1) {
    fail(
      'PACKAGE_ARCHIVE_INVENTORY',
      `Expected exactly one app.asar under ${resolvedRoot}; found ${archives.length}.`
    );
  }
  const [archivePath] = archives;
  const archiveEntries = new Set(asar.listPackage(archivePath));
  for (const requiredEntry of [
    '/packages/service-core/package.json',
    '/packages/service-core/node.js',
    '/packages/service-core/node/services/project/ServiceProject.js'
  ]) {
    if (!archiveEntries.has(requiredEntry)) {
      fail(
        'PACKAGE_SHARED_CORE_MISSING',
        `Packaged application is missing the shared service core entry ${requiredEntry}.`
      );
    }
  }
  if (archiveEntries.has('/assets/google-drive-config.json')) {
    fail(
      'PRIVATE_DRIVE_CONFIG_PACKAGED',
      'Ordinary QA package contains a private Google Drive configuration.'
    );
  }
  const loosePrivateConfigs = await findFilesNamed(
    resolvedRoot,
    'google-drive-config.json'
  );
  if (loosePrivateConfigs.length > 0) {
    fail(
      'PRIVATE_DRIVE_CONFIG_PACKAGED',
      'Ordinary QA package contains a loose private Google Drive configuration.'
    );
  }

  const packagedManifest = readAsarJson(archivePath, 'package.json');
  const application = normalizedApplicationIdentity(packagedManifest);
  const artifactPaths = await exactDistributableArtifacts(
    resolvedRoot,
    expectedArtifactNames(target, application)
  );
  const layout = packageLayout(archivePath, target, application);

  const runtime = await architectureRecord(
    resolvedRoot,
    layout.runtimePath,
    'packaged Electron runtime',
    target.arch
  );
  const nativeArtifacts = [];
  const unpackedRoot = `${archivePath}.unpacked`;
  for (const expected of target.nativePackageArtifacts) {
    const nativePath = path.join(unpackedRoot, expected.suffix);
    nativeArtifacts.push(await architectureRecord(
      resolvedRoot,
      nativePath,
      `native artifact ${expected.package}`,
      target.arch,
      { package: expected.package }
    ));
  }
  const ffmpegPath = await exactFileNamed(
    layout.applicationRoot,
    target.electronFfmpeg,
    'Electron FFmpeg binary'
  );
  nativeArtifacts.push(await architectureRecord(
    resolvedRoot,
    ffmpegPath,
    'Electron FFmpeg binary',
    target.arch,
    { package: 'electron-ffmpeg' }
  ));
  nativeArtifacts.sort((left, right) => left.path.localeCompare(right.path, 'en'));

  const artifacts = [];
  for (const artifactPath of artifactPaths) {
    const architecture = artifactPath.endsWith('.AppImage')
      ? await binaryArchitecture(artifactPath)
      : null;
    if (architecture !== null && architecture !== target.arch) {
      fail(
        'PACKAGE_ARCHITECTURE_MISMATCH',
        `AppImage is ${architecture}; expected ${target.arch}.`
      );
    }
    artifacts.push(await fileRecord(
      resolvedRoot,
      artifactPath,
      'QA distributable',
      architecture ? { architecture } : {}
    ));
  }
  artifacts.sort((left, right) => left.path.localeCompare(right.path, 'en'));

  const evidence = {
    schemaVersion: PACKAGE_SMOKE_SCHEMA_VERSION,
    sourceRevision,
    application,
    target: {
      key: target.key,
      platform: target.platform,
      arch: target.arch
    },
    appArchive: await fileRecord(
      resolvedRoot,
      archivePath,
      'packaged application archive'
    ),
    runtime,
    nativeArtifacts,
    artifacts,
    privateGoogleDriveConfig: 'absent',
    packagedPdfRuntimeGate: 'required-by-workflow',
    packagedSharpRuntimeGate: 'required-by-workflow',
    legalEvidenceGate: 'required-by-workflow'
  };

  const manifestPath = pathInside(
    resolvedRoot,
    manifest || path.join(
      resolvedRoot,
      `package-smoke-${target.platform}-${target.arch}.json`
    ),
    'QA evidence manifest'
  );
  await fsp.mkdir(path.dirname(manifestPath), { recursive: true });
  await fsp.writeFile(
    manifestPath,
    `${JSON.stringify(evidence, null, 2)}\n`,
    { flag: 'wx' }
  ).catch(error => {
    if (error.code === 'EEXIST') {
      fail(
        'PACKAGE_MANIFEST_EXISTS',
        `QA evidence manifest already exists: ${manifestPath}`
      );
    }
    throw error;
  });
  return {
    manifest: manifestPath,
    evidence
  };
}

async function main(argv = process.argv.slice(2), stdout = process.stdout) {
  const options = parseArguments(argv);
  const result = await verifyPackageSmoke(options);
  stdout.write(`${JSON.stringify({
    manifest: result.manifest,
    target: result.evidence.target.key,
    artifacts: result.evidence.artifacts.map(record => record.path),
    architectureVerification: 'passed',
    hashManifest: 'written'
  }, null, 2)}\n`);
  return result;
}

if (require.main === module) {
  main().catch(error => {
    process.stderr.write(`${error.code || error.name}: ${error.message}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  DISTRIBUTABLE_EXTENSIONS,
  PACKAGE_SMOKE_SCHEMA_VERSION,
  PackageSmokeVerificationError,
  binaryArchitecture,
  exactDistributableArtifacts,
  expectedArtifactNames,
  main,
  parseArguments,
  verifyPackageSmoke
};
