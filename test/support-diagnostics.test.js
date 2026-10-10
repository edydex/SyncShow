'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  diagnosticFileName,
  inspectFontFaces,
  safeError,
  sanitizeGpuInfo,
  sanitizeRendererFontDiagnostics
} = require('../src/services/runtime/SupportDiagnostics');

const root = path.join(__dirname, '..');

test('font diagnostics prove bundled faces are readable without exposing paths', async () => {
  const fontsRoot = path.join(root, 'assets', 'fonts');
  const font = require('../src/services/project/PresentationFont').fontForPath(
    path.join(fontsRoot, 'LiberationSans-Regular.ttf')
  );
  const result = await inspectFontFaces(font, 'bundled');

  assert.equal(result.family, 'Liberation Sans');
  assert.equal(result.source, 'bundled');
  assert.equal(result.faces.length, 4);
  for (const face of result.faces) {
    assert.equal(face.readable, true);
    assert.equal(face.file, true);
    assert.ok(face.size > 100_000);
    assert.match(face.sha256, /^[a-f0-9]{64}$/u);
    assert.doesNotMatch(JSON.stringify(face), /\/Users\/|[A-Z]:\\/u);
  }
});

test('renderer and GPU diagnostics use bounded allowlisted fields', () => {
  const renderer = sanitizeRendererFontDiagnostics({
    family: 'SyncShow Presentation',
    documentProtocol: 'file:',
    fontSetStatus: 'loaded',
    cssCheck: false,
    available: false,
    token: 'must-not-leak',
    faces: [{
      fileName: 'C:\\Windows\\Fonts\\arial.ttf',
      weight: '100 500',
      style: 'normal',
      status: 'failed',
      path: 'C:\\Users\\Person\\secret',
      error: { name: 'NetworkError', message: 'Font unavailable', stack: 'private stack' }
    }]
  });
  assert.deepEqual(renderer.faces[0], {
    fileName: 'arial.ttf',
    weight: '100 500',
    style: 'normal',
    status: 'failed',
    error: { name: 'NetworkError', message: 'Font unavailable' }
  });
  assert.equal(renderer.cssCheck, false);
  assert.doesNotMatch(JSON.stringify(renderer), /must-not-leak|Person|private stack/u);

  const gpu = sanitizeGpuInfo({
    machineModelName: 'do-not-copy',
    gpuDevice: [{ active: true, vendorId: 1, deviceId: 2, vendorString: 'Vendor',
      deviceString: 'GPU', driverVendor: 'Driver', driverVersion: '3.4', secret: 'no' }]
  });
  assert.equal(gpu.devices.length, 1);
  assert.doesNotMatch(JSON.stringify(gpu), /do-not-copy|secret/u);

  const error = safeError({
    name: 'Error',
    message: 'Could not read C:\\Users\\Person\\service.json for admin@example.com; token=abc123'
  });
  assert.equal(
    error.message,
    'Could not read [path] for [email]; token=[redacted]'
  );
});

test('diagnostic export is reachable from a failed Start without broad renderer access', () => {
  const html = fs.readFileSync(path.join(root, 'src', 'renderer', 'index.html'), 'utf8');
  const appSource = fs.readFileSync(path.join(root, 'src', 'renderer', 'app.js'), 'utf8');
  const displaySource = fs.readFileSync(path.join(root, 'src', 'renderer', 'display.js'), 'utf8');
  const preloadSource = fs.readFileSync(path.join(root, 'preload.js'), 'utf8');
  const mainSource = fs.readFileSync(path.join(root, 'main.js'), 'utf8');

  assert.match(html, /id="btnSaveDiagnostics"/u);
  assert.match(html, /never passwords or slide contents/u);
  assert.match(appSource, /attempt\.diagnosticsAvailable = true/u);
  assert.match(appSource, /window\.api\.exportSupportDiagnostics\(\)/u);
  assert.match(preloadSource,
    /exportSupportDiagnostics:\s*\(\)\s*=>\s*ipcRenderer\.invoke\('support:exportDiagnostics'\)/u);
  assert.match(mainSource, /ipcMain\.handle\('support:exportDiagnostics'/u);
  assert.match(mainSource, /mode:\s*0o600/u);
  assert.match(mainSource,
    /fontPath:\s*outputWindowFont\.fontPath,\s*fontFaces:\s*outputWindowFont\.faces/u,
    'the output readiness barrier must use the app-owned fallback family');
  assert.match(displaySource, /diagnostics:\s*fontDiagnostics/u);
});

test('diagnostic filenames are stable and filesystem-safe', () => {
  assert.equal(
    diagnosticFileName(new Date('2026-10-10T20:21:22.123Z')),
    'SyncShow-diagnostics-20261010T202122Z.json'
  );
});
