'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const asar = require('@electron/asar');
const { Arch } = require('builder-util');

const {
  PDFJS_NOTICE_PATHS,
  RELEASE_BLOCKERS,
  buildLegalBundle
} = require('../scripts/package-legal-bundle');
const {
  main: verifyReleaseLegal,
  verifyLegalBundle
} = require('../scripts/verify-release-legal');
const {
  PACKAGE_TARGETS,
  packageTarget
} = require('../scripts/lib/package-targets');

async function writeFile(root, relativePath, contents = relativePath) {
  const target = path.join(root, relativePath);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, contents);
  return target;
}

async function writeJson(root, relativePath, value) {
  return writeFile(root, relativePath, `${JSON.stringify(value)}\n`);
}

function lockRecord(version) {
  return {
    version,
    integrity: `sha512-${Buffer.from(`integrity-${version}`).toString('base64')}`
  };
}

async function legalFixture(t, {
  appVersion = '1.4.0-preview.21'
} = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'syncshow-legal-bundle-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const projectDir = path.join(root, 'project');
  const appOutDir = path.join(root, 'dist', 'mac-arm64');
  const resourcesRoot = path.join(
    appOutDir,
    'SyncShow.app',
    'Contents',
    'Resources'
  );
  const archivePath = path.join(resourcesRoot, 'app.asar');
  const unpackedRoot = `${archivePath}.unpacked`;
  const asarSource = path.join(root, 'asar-source');

  await writeJson(asarSource, 'package.json', {
    name: 'sync-show',
    version: appVersion,
    license: 'MIT'
  });
  await writeJson(asarSource, 'node_modules/pdfjs-dist/package.json', {
    name: 'pdfjs-dist',
    version: '6.2.108',
    license: 'Apache-2.0'
  });
  for (const relativePath of PDFJS_NOTICE_PATHS) {
    await writeFile(
      asarSource,
      `node_modules/pdfjs-dist/${relativePath}`,
      `PDF.js notice ${relativePath}\n`
    );
  }
  await fs.mkdir(resourcesRoot, { recursive: true });
  await asar.createPackage(asarSource, archivePath);

  await writeJson(unpackedRoot, 'node_modules/@napi-rs/canvas/package.json', {
    name: '@napi-rs/canvas',
    version: '1.0.3'
  });
  await writeFile(
    unpackedRoot,
    'node_modules/@napi-rs/canvas/LICENSE',
    'Canvas MIT license\n'
  );
  await writeJson(
    unpackedRoot,
    'node_modules/@napi-rs/canvas-darwin-arm64/package.json',
    {
      name: '@napi-rs/canvas-darwin-arm64',
      version: '1.0.3'
    }
  );
  await writeFile(
    unpackedRoot,
    'node_modules/@napi-rs/canvas-darwin-arm64/skia.darwin-arm64.node',
    'fixture native canvas'
  );
  await writeJson(unpackedRoot, 'node_modules/sharp/package.json', {
    name: 'sharp',
    version: '0.35.3'
  });
  await writeFile(
    unpackedRoot,
    'node_modules/sharp/LICENSE',
    'Sharp Apache license\n'
  );
  await writeJson(
    unpackedRoot,
    'node_modules/@img/sharp-darwin-arm64/package.json',
    {
      name: '@img/sharp-darwin-arm64',
      version: '0.35.3'
    }
  );
  await writeFile(
    unpackedRoot,
    'node_modules/@img/sharp-darwin-arm64/LICENSE',
    'Sharp target license\n'
  );
  await writeFile(
    unpackedRoot,
    'node_modules/@img/sharp-darwin-arm64/lib/sharp-darwin-arm64-0.35.3.node',
    'fixture native sharp'
  );
  await writeJson(
    unpackedRoot,
    'node_modules/@img/sharp-libvips-darwin-arm64/package.json',
    {
      name: '@img/sharp-libvips-darwin-arm64',
      version: '1.3.2'
    }
  );
  await writeFile(
    unpackedRoot,
    'node_modules/@img/sharp-libvips-darwin-arm64/lib/libvips-cpp.8.18.3.dylib',
    'fixture native libvips'
  );
  await writeFile(
    unpackedRoot,
    'assets/fonts/OFL-NotoSans.txt',
    'Noto Sans OFL fixture\n'
  );
  await writeFile(
    appOutDir,
    'SyncShow.app/Contents/Frameworks/Electron Framework.framework/'
      + 'Versions/A/Libraries/libffmpeg.dylib',
    'fixture Electron FFmpeg'
  );

  await writeFile(projectDir, 'LICENSE.txt', 'SyncShow MIT license\n');
  await writeJson(projectDir, 'node_modules/electron/package.json', {
    name: 'electron',
    version: '43.2.0'
  });
  await writeFile(
    projectDir,
    'node_modules/electron/dist/LICENSE',
    'Electron MIT license\n'
  );
  await writeFile(
    projectDir,
    'node_modules/electron/dist/LICENSES.chromium.html',
    '<html>Chromium and FFmpeg notices</html>\n'
  );
  await writeFile(
    projectDir,
    'node_modules/@napi-rs/canvas-darwin-arm64/README.md',
    'Canvas target provenance only\n'
  );
  await writeFile(
    projectDir,
    'node_modules/@img/sharp-darwin-arm64/README.md',
    'Sharp native target provenance only\n'
  );
  await writeFile(
    projectDir,
    'node_modules/@img/sharp-libvips-darwin-arm64/README.md',
    'libvips provenance only\n'
  );
  await writeJson(
    projectDir,
    'node_modules/@img/sharp-libvips-darwin-arm64/versions.json',
    {
      vips: '8.18.3',
      cairo: '1.18.4'
    }
  );

  const packages = {
    'node_modules/@napi-rs/canvas': lockRecord('1.0.3'),
    'node_modules/@napi-rs/canvas-darwin-arm64': lockRecord('1.0.3'),
    'node_modules/pdfjs-dist': lockRecord('6.2.108'),
    'node_modules/sharp': lockRecord('0.35.3'),
    'node_modules/@img/sharp-darwin-arm64': lockRecord('0.35.3'),
    'node_modules/@img/sharp-libvips-darwin-arm64': lockRecord('1.3.2'),
    'node_modules/electron': lockRecord('43.2.0')
  };
  await writeJson(projectDir, 'package-lock.json', {
    lockfileVersion: 3,
    packages
  });

  const context = {
    appOutDir,
    electronPlatformName: 'darwin',
    arch: Arch.arm64,
    packager: {
      projectDir,
      appInfo: {
        version: appVersion
      },
      config: {},
      info: {
        framework: {
          version: '43.2.0'
        }
      },
      getResourcesDir: () => resourcesRoot
    }
  };
  return {
    appOutDir,
    context,
    manifestPath: path.join(resourcesRoot, 'legal', 'manifest.json'),
    resourcesRoot,
    root
  };
}

test('package target map is exact for every supported release architecture', () => {
  assert.deepEqual(Object.keys(PACKAGE_TARGETS).sort(), [
    'darwin-arm64',
    'darwin-x64',
    'linux-x64',
    'win32-x64'
  ]);
  assert.equal(
    packageTarget('darwin', 'arm64').canvasPackage,
    'canvas-darwin-arm64'
  );
  assert.equal(
    packageTarget('win32', 'x64').libvipsPackage,
    null
  );
  assert.throws(
    () => packageTarget('linux', 'arm64'),
    /Unsupported packaged application target/u
  );
});

test('afterPack legal evidence is target-specific, complete for its stated scope, and tamper-evident', async t => {
  const fixture = await legalFixture(t);
  const built = await buildLegalBundle(fixture.context);
  assert.equal(built.legalRoot, path.dirname(fixture.manifestPath));
  assert.equal(built.manifest.releaseLegalStatus, 'blocked');
  assert.deepEqual(
    built.manifest.releaseReadinessBlockers.map(blocker => blocker.id),
    RELEASE_BLOCKERS.map(blocker => blocker.id)
  );
  assert.equal(built.manifest.target.key, 'darwin-arm64');
  assert.equal(
    built.manifest.nativeArtifacts.some(record => (
      record.package === 'electron-ffmpeg'
      && record.path.endsWith('/libffmpeg.dylib')
      && record.hashStage === 'after-pack-before-platform-signing'
      && /^[a-f0-9]{64}$/u.test(record.preSigningSha256)
    )),
    true
  );
  assert.equal(
    JSON.stringify(built.manifest).includes(fixture.root),
    false,
    'manifest must never disclose build-host absolute paths'
  );

  const verified = await verifyLegalBundle(
    fixture.manifestPath,
    { requireComplete: false }
  );
  assert.equal(verified.evidenceVerification, 'passed');
  assert.equal(verified.releaseLegalStatus, 'blocked');
  await assert.rejects(
    verifyLegalBundle(fixture.manifestPath),
    error => (
      error.code === 'RELEASE_LEGAL_BLOCKED'
      && error.details.blockerIds.length === 3
    )
  );

  const output = [];
  await verifyReleaseLegal(
    ['--root', path.join(fixture.root, 'dist'), '--evidence-only'],
    { write: value => output.push(value) }
  );
  assert.match(output.join(''), /"evidenceVerification": "passed"/u);

  const copiedLicense = path.join(
    fixture.resourcesRoot,
    'legal',
    'notices',
    'napi-rs-canvas-1.0.3',
    'LICENSE'
  );
  await fs.appendFile(copiedLicense, 'tampered\n');
  await assert.rejects(
    verifyLegalBundle(fixture.manifestPath, { requireComplete: false }),
    error => error.code === 'LEGAL_EVIDENCE_CHANGED'
  );
});

test('legal verification reads the evolving application version from packaged app.asar', async t => {
  const fixture = await legalFixture(t, {
    appVersion: '1.4.0-preview.22'
  });
  await buildLegalBundle(fixture.context);
  const verified = await verifyLegalBundle(
    fixture.manifestPath,
    { requireComplete: false }
  );
  assert.equal(verified.evidenceVerification, 'passed');
});

test('legal evidence generation rejects a staged native target mismatch', async t => {
  const fixture = await legalFixture(t);
  await fs.rename(
    path.join(
      `${path.join(fixture.resourcesRoot, 'app.asar')}.unpacked`,
      'node_modules',
      '@napi-rs',
      'canvas-darwin-arm64'
    ),
    path.join(
      `${path.join(fixture.resourcesRoot, 'app.asar')}.unpacked`,
      'node_modules',
      '@napi-rs',
      'canvas-darwin-x64'
    )
  );
  await assert.rejects(
    buildLegalBundle(fixture.context),
    error => error.code === 'NATIVE_PACKAGE_TARGET_MISMATCH'
  );
});

test('legal evidence generation rejects a staged Sharp WASM fallback', async t => {
  const fixture = await legalFixture(t);
  const wasmRoot = path.join(
    `${path.join(fixture.resourcesRoot, 'app.asar')}.unpacked`,
    'node_modules',
    '@img',
    'sharp-wasm32'
  );
  await fs.mkdir(wasmRoot, { recursive: false });
  await fs.writeFile(path.join(wasmRoot, 'package.json'), '{}\n');
  await assert.rejects(
    buildLegalBundle(fixture.context),
    error => error.code === 'NATIVE_PACKAGE_TARGET_MISMATCH'
  );
});

test('release workflow enforces blocked legal evidence before every artifact upload', async () => {
  const root = path.resolve(__dirname, '..');
  const packageJson = JSON.parse(
    await fs.readFile(path.join(root, 'package.json'), 'utf8')
  );
  const workflow = await fs.readFile(
    path.join(root, '.github', 'workflows', 'build.yml'),
    'utf8'
  );
  const promotionWorkflow = await fs.readFile(
    path.join(root, '.github', 'workflows', 'promote-release.yml'),
    'utf8'
  );
  const afterPack = await fs.readFile(
    path.join(root, 'scripts', 'afterPack.js'),
    'utf8'
  );
  assert.equal(
    packageJson.scripts['build:verify-release-legal'],
    'node scripts/verify-release-legal.js'
  );
  assert.equal(
    (workflow.match(/- name: Enforce public-release legal materials/gu) || []).length,
    3
  );
  assert.equal(
    (workflow.match(/run: npm run build:verify-release-legal/gu) || []).length,
    3
  );
  const gates = [...workflow.matchAll(
    /run: npm run build:verify-release-legal/gu
  )].map(match => match.index);
  const uploads = [
    '- name: Upload Windows artifact',
    '- name: Upload macOS artifact',
    '- name: Upload Linux artifact'
  ].map(label => workflow.indexOf(label));
  assert.deepEqual(
    gates.map((gate, index) => gate < uploads[index]),
    [true, true, true]
  );
  assert.ok(
    afterPack.indexOf('await buildLegalBundle(context)')
      < afterPack.indexOf("context.electronPlatformName !== 'darwin'")
  );
  assert.doesNotMatch(promotionWorkflow, /\bgit tag\b|--tags|gh workflow run/u);
  assert.match(
    promotionWorkflow,
    /build workflow owns the\s+# release tag/u
  );
});
