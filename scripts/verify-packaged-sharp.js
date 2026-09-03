'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const asar = require('@electron/asar');

const { packageTarget } = require('./lib/package-targets');

class PackagedSharpVerificationError extends Error {
  constructor(message) {
    super(`Packaged Sharp verification failed: ${message}`);
    this.name = 'PackagedSharpVerificationError';
  }
}

function fail(message) {
  throw new PackagedSharpVerificationError(message);
}

function parseArguments(argv) {
  let root = path.resolve('dist');
  let archive = null;
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--root' && argv[index + 1]) {
      root = path.resolve(argv[++index]);
    } else if (argv[index] === '--archive' && argv[index + 1]) {
      archive = path.resolve(argv[++index]);
    } else {
      fail(`Unknown or incomplete argument: ${argv[index]}`);
    }
  }
  return { archive, root };
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

function readAsarJson(archivePath, entryPath) {
  try {
    return JSON.parse(asar.extractFile(archivePath, entryPath).toString('utf8'));
  } catch (error) {
    fail(`could not read ${entryPath} from app.asar: ${error.message}`);
  }
}

async function requireRegularFile(filePath) {
  const stats = await fsp.lstat(filePath).catch(() => null);
  if (!stats?.isFile() || stats.isSymbolicLink() || stats.size < 1) {
    fail(`required packaged file is missing or unsafe: ${filePath}`);
  }
}

async function locateRuntime(archivePath, manifest) {
  const resourcesDirectory = path.dirname(archivePath);
  const applicationRoot = path.dirname(resourcesDirectory);
  const productName = manifest.build?.productName || manifest.productName || 'SyncShow';
  const candidates = [];

  if (process.platform === 'darwin') {
    candidates.push(path.join(applicationRoot, 'MacOS', productName));
  } else if (process.platform === 'win32') {
    candidates.push(path.join(applicationRoot, `${productName}.exe`));
  } else if (process.platform === 'linux') {
    candidates.push(
      path.join(applicationRoot, manifest.name || 'sync-show'),
      path.join(applicationRoot, productName)
    );
  }

  for (const candidate of candidates) {
    try {
      await fsp.access(candidate, fs.constants.X_OK);
      return candidate;
    } catch (_error) {
      // Try the next exact platform convention.
    }
  }
  fail(`could not locate the packaged Electron runtime for ${process.platform}.`);
}

function buildSharpSmokeSource(sharpPath) {
  return `
    const sharp = require(${JSON.stringify(sharpPath)});
    (async () => {
      const rendered = await sharp({
        create: {
          width: 3,
          height: 2,
          channels: 4,
          background: { r: 24, g: 96, b: 160, alpha: 1 }
        }
      }).png().toBuffer({ resolveWithObject: true });
      const metadata = await sharp(rendered.data).metadata();
      if (rendered.info.format !== 'png' ||
          rendered.info.width !== 3 ||
          rendered.info.height !== 2 ||
          metadata.format !== 'png' ||
          metadata.width !== 3 ||
          metadata.height !== 2 ||
          rendered.data.subarray(1, 4).toString('ascii') !== 'PNG' ||
          typeof sharp.versions?.vips !== 'string' ||
          sharp.versions.vips.length < 1) {
        throw new Error('Packaged Sharp returned an unexpected smoke result.');
      }
      console.log('SYNCSHOW_SHARP_SMOKE_OK');
    })().catch(error => {
      console.error(error);
      process.exitCode = 1;
    });
  `;
}

function runPackagedRuntimeSmoke(runtimePath, archivePath) {
  const sharpPath = path.join(archivePath, 'node_modules', 'sharp');
  const result = spawnSync(
    runtimePath,
    ['-e', buildSharpSmokeSource(sharpPath)],
    {
      encoding: 'utf8',
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: '1'
      },
      maxBuffer: 1024 * 1024,
      timeout: 60_000
    }
  );

  if (result.error) fail(`packaged runtime could not start: ${result.error.message}`);
  if (
    result.status !== 0
    || !result.stdout.includes('SYNCSHOW_SHARP_SMOKE_OK')
  ) {
    const diagnostic = `${result.stdout}\n${result.stderr}`.trim().slice(-2000);
    fail(`packaged runtime smoke failed.\n${diagnostic}`);
  }
}

async function verifyArchive(archivePath) {
  const entries = asar.listPackage(archivePath);
  const entrySet = new Set(entries);
  for (const requiredEntry of [
    '/package.json',
    '/node_modules/sharp/LICENSE',
    '/node_modules/sharp/package.json',
    '/node_modules/sharp/dist/index.cjs'
  ]) {
    if (!entrySet.has(requiredEntry)) {
      fail(`app.asar is missing ${requiredEntry}.`);
    }
  }

  const manifest = readAsarJson(archivePath, 'package.json');
  if (manifest.dependencies?.sharp !== '0.35.3') {
    fail('packaged manifest does not declare the reviewed Sharp version.');
  }

  let target;
  try {
    target = packageTarget(process.platform, process.arch);
  } catch (_error) {
    fail(`unsupported verification target ${process.platform}-${process.arch}.`);
  }

  const unpackedRoot = `${archivePath}.unpacked`;
  const sharpRoot = path.join(unpackedRoot, 'node_modules', 'sharp');
  for (const requiredFile of [
    path.join(sharpRoot, 'LICENSE'),
    path.join(sharpRoot, 'package.json'),
    path.join(sharpRoot, 'dist', 'index.cjs')
  ]) {
    await requireRegularFile(requiredFile);
  }

  const imageScope = path.join(unpackedRoot, 'node_modules', '@img');
  const packagedTargets = (await fsp.readdir(imageScope, { withFileTypes: true }))
    .filter(entry => entry.isDirectory() && entry.name.startsWith('sharp-'))
    .map(entry => entry.name)
    .sort();
  const expectedTargets = [
    target.sharpPackage,
    ...(target.libvipsPackage ? [target.libvipsPackage] : [])
  ].sort();
  if (
    packagedTargets.length !== expectedTargets.length
    || packagedTargets.some(
      (packagedTarget, index) => packagedTarget !== expectedTargets[index]
    )
  ) {
    fail(
      `wrong native Sharp package set: ${packagedTargets.join(', ') || 'none'}.`
    );
  }

  for (const artifact of target.nativePackageArtifacts.filter(
    record => record.package.startsWith('@img/')
  )) {
    await requireRegularFile(path.join(unpackedRoot, artifact.suffix));
  }

  const runtimePath = await locateRuntime(archivePath, manifest);
  runPackagedRuntimeSmoke(runtimePath, archivePath);
  return {
    archive: archivePath,
    nativeTarget: target.sharpPackage,
    sharp: 'sharp@0.35.3',
    runtimeSmoke: 'passed'
  };
}

async function main(argv = process.argv.slice(2), stdout = process.stdout) {
  const options = parseArguments(argv);
  let archivePath = options.archive;
  if (!archivePath) {
    const archives = await findFilesNamed(options.root, 'app.asar');
    if (archives.length !== 1) {
      fail(
        `expected exactly one app.asar under ${options.root}; found ${archives.length}.`
      );
    }
    [archivePath] = archives;
  }

  const result = await verifyArchive(archivePath);
  stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  return result;
}

if (require.main === module) {
  main().catch(error => {
    process.stderr.write(`${error.stack || error.message}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  PackagedSharpVerificationError,
  buildSharpSmokeSource,
  findFilesNamed,
  main,
  parseArguments,
  verifyArchive
};
