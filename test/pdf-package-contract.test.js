'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');

const root = path.resolve(__dirname, '..');

test('PDF engine dependencies, lock entries, and native unpack rules stay exact', async () => {
  const packageJson = JSON.parse(
    await fs.readFile(path.join(root, 'package.json'), 'utf8')
  );
  const packageLock = JSON.parse(
    await fs.readFile(path.join(root, 'package-lock.json'), 'utf8')
  );

  assert.equal(packageJson.engines.node, '>=22.13.0');
  assert.equal(packageJson.dependencies['pdfjs-dist'], '6.2.108');
  assert.equal(packageJson.dependencies['@napi-rs/canvas'], '1.0.3');
  for (const dependencySection of [
    packageJson.dependencies,
    packageJson.devDependencies,
    packageJson.optionalDependencies
  ]) {
    assert.equal(Object.hasOwn(dependencySection || {}, 'mupdf'), false);
  }
  assert.equal(JSON.stringify(packageLock).includes('"mupdf"'), false);

  const lockedRoot = packageLock.packages[''];
  assert.equal(lockedRoot.engines.node, '>=22.13.0');
  assert.equal(lockedRoot.dependencies['pdfjs-dist'], '6.2.108');
  assert.equal(lockedRoot.dependencies['@napi-rs/canvas'], '1.0.3');

  const lockedPdfjs = packageLock.packages['node_modules/pdfjs-dist'];
  assert.equal(lockedPdfjs.version, '6.2.108');
  assert.equal(lockedPdfjs.license, 'Apache-2.0');
  const lockedCanvas = packageLock.packages['node_modules/@napi-rs/canvas'];
  assert.equal(lockedCanvas.version, '1.0.3');
  assert.equal(lockedCanvas.license, 'MIT');

  for (const targetPackage of [
    '@napi-rs/canvas-darwin-arm64',
    '@napi-rs/canvas-darwin-x64',
    '@napi-rs/canvas-linux-x64-gnu',
    '@napi-rs/canvas-win32-x64-msvc'
  ]) {
    assert.equal(lockedCanvas.optionalDependencies[targetPackage], '1.0.3');
    assert.equal(
      packageLock.packages[`node_modules/${targetPackage}`].version,
      '1.0.3'
    );
  }

  assert.ok(packageJson.build.files.includes('node_modules/**/*'));
  assert.equal(
    packageJson.build.files.filter(
      entry => entry === '!node_modules/@img/sharp-wasm32/**'
    ).length,
    1
  );
  assert.ok(
    packageJson.build.files.indexOf('!node_modules/@img/sharp-wasm32/**')
      > packageJson.build.files.indexOf('node_modules/**/*')
  );
  assert.ok(packageJson.build.asarUnpack.includes('node_modules/@napi-rs/**'));
  assert.equal(
    packageJson.scripts['build:verify-pdf-engine'],
    'node scripts/verify-packaged-pdf-engine.js'
  );
});

test('installed PDF.js resources are local and runtime source has no MuPDF import', async () => {
  for (const relativePath of [
    'node_modules/pdfjs-dist/LICENSE',
    'node_modules/pdfjs-dist/cmaps/LICENSE',
    'node_modules/pdfjs-dist/iccs/LICENSE',
    'node_modules/pdfjs-dist/standard_fonts/LICENSE_FOXIT',
    'node_modules/pdfjs-dist/wasm/LICENSE_OPENJPEG',
    'node_modules/pdfjs-dist/legacy/build/pdf.mjs'
  ]) {
    const stats = await fs.stat(path.join(root, relativePath));
    assert.equal(stats.isFile(), true, `${relativePath} must be installed`);
    assert.ok(stats.size > 0, `${relativePath} must not be empty`);
  }

  for (const relativePath of [
    'src/services/pdf/PdfEngine.js',
    'src/services/converter/PdfToImageConverter.js',
    'src/services/sermon/SermonSourceExtraction.js'
  ]) {
    const source = await fs.readFile(path.join(root, relativePath), 'utf8');
    assert.doesNotMatch(source, /(?:require|import)\s*\(\s*['"]mupdf['"]\s*\)/u);
  }
});

test('every release package runs the packaged runtime PDF smoke gate', async () => {
  const workflow = await fs.readFile(
    path.join(root, '.github/workflows/build.yml'),
    'utf8'
  );
  assert.equal(
    (workflow.match(/- name: Verify packaged PDF engine/gu) || []).length,
    3
  );
  assert.equal(
    (workflow.match(/run: npm run build:verify-pdf-engine/gu) || []).length,
    3
  );

  const verifier = await fs.readFile(
    path.join(root, 'scripts/verify-packaged-pdf-engine.js'),
    'utf8'
  );
  assert.match(verifier, /ELECTRON_RUN_AS_NODE/u);
  assert.match(verifier, /SYNCSHOW_PDF_ENGINE_SMOKE_OK/u);
  assert.match(verifier, /const unpackedRoot =/u);
  assert.match(verifier, /app\.asar still contains MuPDF/u);
  assert.match(verifier, /wrong native canvas package set/u);
});
