#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const asar = require('@electron/asar');

const REQUIRED_CORE_ENTRIES = Object.freeze([
  '/packages/service-core/package.json',
  '/packages/service-core/index.js',
  '/packages/service-core/node.js',
  '/packages/service-core/node/services/project/ServiceProject.js'
]);

class PackagedServiceCoreVerificationError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'PackagedServiceCoreVerificationError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new PackagedServiceCoreVerificationError(code, message);
}

function parseArguments(argv) {
  if (!Array.isArray(argv) || argv.length !== 2 || argv[0] !== '--root' || !argv[1]) {
    fail('INVALID_ARGUMENTS', 'Usage: node scripts/verify-packaged-service-core.js --root /absolute/or/relative/package-root');
  }
  return { root: path.resolve(argv[1]) };
}

async function findAppArchives(root) {
  const matches = [];
  async function visit(directory) {
    const entries = await fsp.readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const candidate = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) await visit(candidate);
      else if (entry.isFile() && entry.name === 'app.asar') matches.push(candidate);
    }
  }
  await visit(root);
  return matches.sort();
}

function readManifest(archivePath) {
  try {
    return JSON.parse(asar.extractFile(archivePath, 'package.json').toString('utf8'));
  } catch (error) {
    fail('INVALID_APP_ARCHIVE', `Could not read the packaged application manifest: ${error.message}`);
  }
}

function packagedRuntime(archivePath, manifest) {
  const resourcesRoot = path.dirname(archivePath);
  const applicationRoot = path.dirname(resourcesRoot);
  const productName = manifest.build?.productName || manifest.productName || 'SyncShow';
  if (process.platform === 'darwin') {
    if (path.basename(applicationRoot) !== 'Contents') {
      fail('INVALID_PACKAGE_LAYOUT', 'The macOS app archive is outside an application bundle.');
    }
    return path.join(applicationRoot, 'MacOS', productName);
  }
  if (process.platform === 'win32') return path.join(applicationRoot, `${productName}.exe`);
  if (process.platform === 'linux') return path.join(applicationRoot, manifest.name);
  fail('UNSUPPORTED_HOST', `Packaged service-core smoke does not support ${process.platform}.`);
}

async function requireExecutable(filePath) {
  const stats = await fsp.lstat(filePath).catch(() => null);
  if (!stats?.isFile() || stats.isSymbolicLink() || stats.size < 1) {
    fail('PACKAGED_RUNTIME_MISSING', `Packaged Electron runtime is missing: ${filePath}`);
  }
  if (process.platform !== 'win32') await fsp.access(filePath, fs.constants.X_OK);
}

function serviceCoreSmokeSource(corePath) {
  return `'use strict';
    const assert = require('node:assert/strict');
    const core = require(${JSON.stringify(corePath)});
    const now = '2026-07-26T16:00:00.000Z';
    const channels = [
      { id: 'english', label: 'English', language: 'en' },
      { id: 'russian', label: 'Russian', language: 'ru' },
      { id: 'media', label: 'Media', language: 'zxx' }
    ];
    let project = core.createServiceProject({
      id: 'packaged-core-smoke',
      title: 'Packaged Core Smoke',
      serviceDate: '2026-07-26',
      profileId: 'pilot-venue',
      channels,
      now
    });
    project = core.addProjectItem(project, {
      id: 'opening-blank',
      kind: 'blank',
      title: 'Opening blank',
      createdAt: now,
      updatedAt: now,
      operatorNotes: 'Right Arrow or Space advances from this safe opening cue.',
      channelIds: channels.map(channel => channel.id),
      presetId: 'blank-black'
    }, { now });
    project = core.normalizeServiceProject({ ...project, revision: 1, updatedAt: now }, { now: new Date(now) });
    const document = core.createHeritageServiceDocument(project);
    const source = core.serializeHeritageServiceDocument(document);
    const reparsed = core.parseHeritageServiceDocumentSource(source);
    const compiled = core.compileServiceProject(reparsed.project);
    assert.equal(reparsed.id, project.id);
    assert.equal(reparsed.project.revision, 1);
    assert.equal(compiled.projectId, project.id);
    assert.equal(compiled.projectRevision, 1);
    assert.equal(compiled.cueIds.length, 1);
    assert.deepEqual(Object.keys(compiled.cues[compiled.cueIds[0]].channels).sort(), ['english', 'media', 'russian']);
    console.log(JSON.stringify({
      marker: 'SYNCSHOW_PACKAGED_SERVICE_CORE_OK',
      documentId: document.id,
      projectRevision: compiled.projectRevision,
      cueCount: compiled.cueIds.length,
      outputs: Object.keys(compiled.cues[compiled.cueIds[0]].channels).sort()
    }));`;
}

async function verifyPackagedServiceCore({ root }) {
  const stats = await fsp.lstat(root).catch(() => null);
  if (!stats?.isDirectory() || stats.isSymbolicLink()) {
    fail('INVALID_PACKAGE_ROOT', 'Package root must be a real directory.');
  }
  const archives = await findAppArchives(root);
  if (archives.length !== 1) {
    fail('APP_ARCHIVE_INVENTORY', `Expected exactly one app.asar; found ${archives.length}.`);
  }
  const [archivePath] = archives;
  const entries = new Set(asar.listPackage(archivePath));
  for (const entry of REQUIRED_CORE_ENTRIES) {
    if (!entries.has(entry)) fail('PACKAGED_SERVICE_CORE_MISSING', `app.asar is missing ${entry}.`);
  }
  const manifest = readManifest(archivePath);
  if (manifest.dependencies?.['@syncshow/service-core'] !== 'file:packages/service-core') {
    fail('PACKAGED_SERVICE_CORE_VERSION', 'Packaged manifest does not pin the local shared service core.');
  }
  const runtimePath = packagedRuntime(archivePath, manifest);
  await requireExecutable(runtimePath);
  const corePath = path.join(archivePath, 'packages', 'service-core', 'node.js');
  const result = spawnSync(runtimePath, ['-e', serviceCoreSmokeSource(corePath)], {
    encoding: 'utf8',
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    maxBuffer: 1024 * 1024,
    timeout: 60_000
  });
  if (result.error || result.status !== 0) {
    fail('PACKAGED_SERVICE_CORE_RUNTIME', `${result.error?.message || result.stderr || result.stdout}`.trim().slice(-3000));
  }
  const record = result.stdout.trim().split(/\r?\n/u).map(line => {
    try { return JSON.parse(line); } catch (_error) { return null; }
  }).find(value => value?.marker === 'SYNCSHOW_PACKAGED_SERVICE_CORE_OK');
  if (!record) fail('PACKAGED_SERVICE_CORE_RESULT', 'Packaged shared core did not return its expected smoke result.');
  return { archivePath, runtimePath, record };
}

async function main(argv = process.argv.slice(2), stdout = process.stdout) {
  const result = await verifyPackagedServiceCore(parseArguments(argv));
  stdout.write(`${JSON.stringify({
    archive: result.archivePath,
    runtime: result.runtimePath,
    serviceDocument: 'round-tripped',
    projectRevision: result.record.projectRevision,
    cueCount: result.record.cueCount,
    outputs: result.record.outputs,
    runtimeSmoke: 'passed'
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
  PackagedServiceCoreVerificationError,
  REQUIRED_CORE_ENTRIES,
  main,
  parseArguments,
  serviceCoreSmokeSource,
  verifyPackagedServiceCore
};
