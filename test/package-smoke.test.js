'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const asar = require('@electron/asar');

const { packageTarget } = require('../scripts/lib/package-targets');
const {
  binaryArchitecture,
  expectedArtifactNames,
  verifyPackageSmoke
} = require('../scripts/verify-package-smoke');
const {
  buildSharpSmokeSource,
  parseArguments: parseSharpArguments
} = require('../scripts/verify-packaged-sharp');

const SOURCE_REVISION = 'a'.repeat(40);
const APPLICATION = Object.freeze({
  name: 'sync-show',
  productName: 'SyncShow',
  version: '1.4.0-preview.21'
});

function binaryBytes(format, architecture) {
  const bytes = Buffer.alloc(256);
  if (format === 'pe') {
    bytes.write('MZ', 0, 'ascii');
    bytes.writeUInt32LE(0x80, 0x3c);
    bytes.write('PE\0\0', 0x80, 'binary');
    bytes.writeUInt16LE(architecture === 'x64' ? 0x8664 : 0xaa64, 0x84);
    return bytes;
  }
  if (format === 'elf') {
    bytes.set([0x7f, 0x45, 0x4c, 0x46, 2, 1], 0);
    bytes.writeUInt16LE(architecture === 'x64' ? 62 : 183, 18);
    return bytes;
  }
  if (format === 'macho') {
    bytes.writeUInt32LE(0xfeedfacf, 0);
    bytes.writeUInt32LE(
      architecture === 'x64' ? 0x01000007 : 0x0100000c,
      4
    );
    return bytes;
  }
  throw new Error(`Unsupported fixture format: ${format}`);
}

function targetFormat(platform) {
  if (platform === 'win32') return 'pe';
  if (platform === 'linux') return 'elf';
  return 'macho';
}

async function writeFile(root, relativePath, contents) {
  const destination = path.join(root, relativePath);
  await fs.mkdir(path.dirname(destination), { recursive: true });
  await fs.writeFile(destination, contents);
  return destination;
}

async function packageFixture(t, targetKey, {
  manifestVersion = APPLICATION.version,
  privateConfig = false,
  runtimeArchitecture = null
} = {}) {
  const [platform, arch] = targetKey.split('-');
  const target = packageTarget(platform, arch);
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'syncshow-package-smoke-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const appOutDirectoryName = target.platform === 'darwin'
    ? `mac-${target.arch}`
    : target.platform === 'win32'
      ? 'win-unpacked'
      : 'linux-unpacked';
  const appOutDir = path.join(root, appOutDirectoryName);
  const resourcesRoot = target.platform === 'darwin'
    ? path.join(appOutDir, 'SyncShow.app', 'Contents', 'Resources')
    : path.join(appOutDir, 'resources');
  const archivePath = path.join(resourcesRoot, 'app.asar');
  const asarSource = path.join(root, 'asar-source');
  await writeFile(
    asarSource,
    'package.json',
    `${JSON.stringify({
      name: APPLICATION.name,
      version: manifestVersion
    })}\n`
  );
  await writeFile(
    asarSource,
    'packages/service-core/package.json',
    '{"name":"@syncshow/service-core","version":"0.2.0-pilot.1"}\n'
  );
  await writeFile(asarSource, 'packages/service-core/node.js', "'use strict';\n");
  await writeFile(
    asarSource,
    'packages/service-core/node/services/project/ServiceProject.js',
    "'use strict';\n"
  );
  if (privateConfig) {
    await writeFile(
      asarSource,
      'assets/google-drive-config.json',
      '{"clientId":"must-not-ship"}\n'
    );
  }
  await fs.mkdir(resourcesRoot, { recursive: true });
  await asar.createPackage(asarSource, archivePath);

  const format = targetFormat(target.platform);
  const binary = binaryBytes(format, target.arch);
  const runtimeBinary = binaryBytes(
    format,
    runtimeArchitecture || target.arch
  );
  const runtimePath = target.platform === 'darwin'
    ? path.join(appOutDir, 'SyncShow.app', 'Contents', 'MacOS', 'SyncShow')
    : target.platform === 'win32'
      ? path.join(appOutDir, 'SyncShow.exe')
      : path.join(appOutDir, APPLICATION.name);
  await fs.mkdir(path.dirname(runtimePath), { recursive: true });
  await fs.writeFile(runtimePath, runtimeBinary);

  for (const artifact of target.nativePackageArtifacts) {
    await writeFile(
      `${archivePath}.unpacked`,
      artifact.suffix,
      binary
    );
  }
  const ffmpegPath = target.platform === 'darwin'
    ? path.join(
      appOutDir,
      'SyncShow.app',
      'Contents',
      'Frameworks',
      'Electron Framework.framework',
      'Versions',
      'A',
      'Libraries',
      target.electronFfmpeg
    )
    : path.join(appOutDir, target.electronFfmpeg);
  await fs.mkdir(path.dirname(ffmpegPath), { recursive: true });
  await fs.writeFile(ffmpegPath, binary);

  for (const artifactName of expectedArtifactNames(target, APPLICATION)) {
    await fs.writeFile(
      path.join(root, artifactName),
      artifactName.endsWith('.AppImage') ? binary : Buffer.from(artifactName)
    );
  }
  return {
    arch,
    manifest: path.join(root, `package-smoke-${targetKey}.json`),
    platform,
    root,
    target
  };
}

test('binary architecture parser recognizes every supported package format', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'syncshow-binary-arch-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  for (const [format, architecture] of [
    ['pe', 'x64'],
    ['pe', 'arm64'],
    ['elf', 'x64'],
    ['elf', 'arm64'],
    ['macho', 'x64'],
    ['macho', 'arm64']
  ]) {
    const filePath = path.join(root, `${format}-${architecture}`);
    await fs.writeFile(filePath, binaryBytes(format, architecture));
    assert.equal(await binaryArchitecture(filePath), architecture);
  }
});

test('QA evidence binds exact artifacts and native architecture for all four targets', async t => {
  for (const targetKey of [
    'darwin-arm64',
    'darwin-x64',
    'linux-x64',
    'win32-x64'
  ]) {
    await t.test(targetKey, async child => {
      const fixture = await packageFixture(child, targetKey);
      const result = await verifyPackageSmoke({
        ...fixture,
        sourceRevision: SOURCE_REVISION,
        enforceHost: false
      });
      assert.equal(result.evidence.target.key, targetKey);
      assert.equal(result.evidence.sourceRevision, SOURCE_REVISION);
      assert.equal(result.evidence.privateGoogleDriveConfig, 'absent');
      assert.deepEqual(
        result.evidence.artifacts.map(record => path.basename(record.path)).sort(),
        expectedArtifactNames(fixture.target, APPLICATION)
      );
      assert.equal(
        result.evidence.nativeArtifacts.every(
          record => record.architecture === fixture.arch
        ),
        true
      );
      assert.equal(result.evidence.runtime.architecture, fixture.arch);
      for (const record of [
        result.evidence.appArchive,
        result.evidence.runtime,
        ...result.evidence.nativeArtifacts,
        ...result.evidence.artifacts
      ]) {
        assert.match(record.sha256, /^[a-f0-9]{64}$/u);
        assert.ok(record.size > 0);
        assert.equal(path.isAbsolute(record.path), false);
      }
      const written = JSON.parse(await fs.readFile(fixture.manifest, 'utf8'));
      assert.deepEqual(written, result.evidence);
    });
  }
});

test('QA evidence rejects extra artifacts, wrong architecture, and private Drive config', async t => {
  await t.test('extra artifact', async child => {
    const fixture = await packageFixture(child, 'darwin-arm64');
    await fs.writeFile(path.join(fixture.root, 'unexpected.zip'), 'extra');
    await assert.rejects(
      verifyPackageSmoke({
        ...fixture,
        sourceRevision: SOURCE_REVISION,
        enforceHost: false
      }),
      error => error.code === 'PACKAGE_ARTIFACT_INVENTORY'
    );
  });

  await t.test('wrong runtime architecture', async child => {
    const fixture = await packageFixture(child, 'win32-x64', {
      runtimeArchitecture: 'arm64'
    });
    await assert.rejects(
      verifyPackageSmoke({
        ...fixture,
        sourceRevision: SOURCE_REVISION,
        enforceHost: false
      }),
      error => error.code === 'PACKAGE_ARCHITECTURE_MISMATCH'
    );
  });

  await t.test('private config', async child => {
    const fixture = await packageFixture(child, 'linux-x64', {
      privateConfig: true
    });
    await assert.rejects(
      verifyPackageSmoke({
        ...fixture,
        sourceRevision: SOURCE_REVISION,
        enforceHost: false
      }),
      error => error.code === 'PRIVATE_DRIVE_CONFIG_PACKAGED'
    );
  });

  await t.test('source identity drift', async child => {
    const fixture = await packageFixture(child, 'darwin-x64', {
      manifestVersion: '99.0.0'
    });
    await assert.rejects(
      verifyPackageSmoke({
        ...fixture,
        sourceRevision: SOURCE_REVISION,
        enforceHost: false
      }),
      error => error.code === 'PACKAGE_IDENTITY_INVALID'
    );
  });
});

test('packaged Sharp smoke is explicit and arguments remain path-only', () => {
  const parsed = parseSharpArguments([
    '--root',
    'dist',
    '--archive',
    'dist/app.asar'
  ]);
  assert.equal(parsed.root, path.resolve('dist'));
  assert.equal(parsed.archive, path.resolve('dist/app.asar'));
  const source = buildSharpSmokeSource('/package/app.asar/node_modules/sharp');
  assert.match(source, /SYNCSHOW_SHARP_SMOKE_OK/u);
  assert.match(source, /sharp\.versions\?\.vips/u);
  assert.match(source, /resolveWithObject/u);
  assert.doesNotMatch(source, /google|credential|token/iu);
});

test('package-smoke workflow is four-target, non-publishing, and evidence-gated', async () => {
  const root = path.resolve(__dirname, '..');
  const workflow = await fs.readFile(
    path.join(root, '.github', 'workflows', 'package-smoke.yml'),
    'utf8'
  );
  const packageJson = JSON.parse(
    await fs.readFile(path.join(root, 'package.json'), 'utf8')
  );

  for (const target of [
    'windows-x64',
    'linux-x64',
    'macos-arm64',
    'macos-x64'
  ]) {
    assert.match(workflow, new RegExp(`target: ${target}`, 'u'));
  }
  for (const runner of [
    'windows-latest',
    'ubuntu-latest',
    'macos-15',
    'macos-15-intel'
  ]) {
    assert.match(workflow, new RegExp(`runner: ${runner}`, 'u'));
  }
  assert.match(workflow, /^  pull_request:/mu);
  assert.match(workflow, /^  workflow_dispatch:/mu);
  assert.doesNotMatch(workflow, /^  push:/mu);
  assert.match(workflow, /permissions:\s*\n\s+contents: read/u);
  assert.doesNotMatch(
    workflow,
    /contents: write|secrets\.|softprops|action-gh-release|environment:/u
  );
  assert.match(workflow, /run: npm ci/u);
  assert.match(workflow, /run: npm run ci/u);
  assert.match(workflow, /build:verify-pdf-engine/u);
  assert.match(workflow, /build:verify-sharp/u);
  assert.match(workflow, /build:verify-release-legal -- --root dist --evidence-only/u);
  assert.match(workflow, /build:verify-package-smoke/u);
  assert.match(workflow, /if-no-files-found: error/u);
  assert.match(workflow, /retention-days: 7/u);
  assert.doesNotMatch(workflow, /SYNCSHOW_PACKAGE_GOOGLE_DRIVE_CONFIG/u);
  assert.ok(
    workflow.indexOf('Write exact QA artifact evidence')
      < workflow.indexOf('Upload short-lived QA package evidence')
  );

  assert.equal(
    packageJson.scripts['build:verify-sharp'],
    'node scripts/verify-packaged-sharp.js'
  );
  assert.equal(
    packageJson.scripts['build:verify-package-smoke'],
    'node scripts/verify-package-smoke.js'
  );
});
