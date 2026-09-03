'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const asar = require('@electron/asar');

const { packageTarget } = require('./lib/package-targets');
const { verifyLegalBundle } = require('./verify-release-legal');

const REQUIRED_PDFJS_ENTRIES = Object.freeze([
  '/node_modules/pdfjs-dist/LICENSE',
  '/node_modules/pdfjs-dist/cmaps/LICENSE',
  '/node_modules/pdfjs-dist/iccs/LICENSE',
  '/node_modules/pdfjs-dist/legacy/build/pdf.mjs',
  '/node_modules/pdfjs-dist/standard_fonts/LICENSE_FOXIT',
  '/node_modules/pdfjs-dist/standard_fonts/LICENSE_LIBERATION',
  '/node_modules/pdfjs-dist/wasm/LICENSE_JBIG2',
  '/node_modules/pdfjs-dist/wasm/LICENSE_OPENJPEG',
  '/node_modules/pdfjs-dist/wasm/LICENSE_PDFJS_JBIG2',
  '/node_modules/pdfjs-dist/wasm/LICENSE_PDFJS_OPENJPEG',
  '/node_modules/pdfjs-dist/wasm/LICENSE_PDFJS_QCMS',
  '/node_modules/pdfjs-dist/wasm/LICENSE_QCMS'
]);

function fail(message) {
  throw new Error(`Packaged PDF engine verification failed: ${message}`);
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
  return matches;
}

function readAsarJson(archivePath, entryPath) {
  try {
    return JSON.parse(asar.extractFile(archivePath, entryPath).toString('utf8'));
  } catch (error) {
    fail(`could not read ${entryPath} from app.asar: ${error.message}`);
  }
}

function buildSmokePdf() {
  const content = 'BT /F1 18 Tf 72 120 Td (Packaged PDF engine smoke) Tj ET';
  const objects = [
    null,
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 320 180] '
      + '/Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    `<< /Length ${Buffer.byteLength(content, 'ascii')} >>\n`
      + `stream\n${content}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'
  ];
  const parts = [Buffer.from('%PDF-1.7\n', 'ascii')];
  const offsets = [0];
  for (let id = 1; id < objects.length; id += 1) {
    offsets[id] = parts.reduce((sum, part) => sum + part.length, 0);
    parts.push(Buffer.from(`${id} 0 obj\n${objects[id]}\nendobj\n`, 'ascii'));
  }
  const xrefOffset = parts.reduce((sum, part) => sum + part.length, 0);
  parts.push(Buffer.from([
    'xref',
    `0 ${objects.length}`,
    '0000000000 65535 f ',
    ...offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n `),
    'trailer',
    `<< /Size ${objects.length} /Root 1 0 R >>`,
    'startxref',
    String(xrefOffset),
    '%%EOF',
    ''
  ].join('\n'), 'ascii'));
  return Buffer.concat(parts);
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

function runPackagedRuntimeSmoke(runtimePath, archivePath) {
  const enginePath = path.join(archivePath, 'src', 'services', 'pdf', 'PdfEngine.js');
  const fixture = buildSmokePdf().toString('base64');
  const smokeSource = `
    const engine = require(${JSON.stringify(enginePath)});
    (async () => {
      const callerBytes = Buffer.from(${JSON.stringify(fixture)}, 'base64');
      const callerLength = callerBytes.length;
      const document = await engine.openPdf(callerBytes);
      try {
        const text = await document.extractPageText(0, { maximumCharacters: 256 });
        const rendered = await document.renderPageToPng(0, {
          maximumWidth: 320,
          maximumHeight: 180
        });
        if (document.pageCount !== 1 ||
            text.text !== 'Packaged PDF engine smoke' ||
            rendered.width !== 320 ||
            rendered.height !== 180 ||
            rendered.png.subarray(1, 4).toString('ascii') !== 'PNG' ||
            callerBytes.length !== callerLength ||
            engine.PDF_RENDERER_PROVENANCE.version !== '6.2.108') {
          throw new Error('Packaged PDF engine returned an unexpected smoke result.');
        }
      } finally {
        await document.close();
      }
      console.log('SYNCSHOW_PDF_ENGINE_SMOKE_OK');
    })().catch(error => {
      console.error(error);
      process.exitCode = 1;
    });
  `;
  const result = spawnSync(runtimePath, ['-e', smokeSource], {
    encoding: 'utf8',
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1'
    },
    maxBuffer: 1024 * 1024,
    timeout: 60_000
  });

  if (result.error) fail(`packaged runtime could not start: ${result.error.message}`);
  if (result.status !== 0 ||
      !result.stdout.includes('SYNCSHOW_PDF_ENGINE_SMOKE_OK')) {
    const diagnostic = `${result.stdout}\n${result.stderr}`.trim().slice(-2000);
    fail(`packaged runtime smoke failed.\n${diagnostic}`);
  }
}

async function verifyArchive(archivePath) {
  const entries = asar.listPackage(archivePath);
  const entrySet = new Set(entries);
  for (const requiredEntry of [
    '/package.json',
    '/src/services/pdf/PdfEngine.js',
    ...REQUIRED_PDFJS_ENTRIES
  ]) {
    if (!entrySet.has(requiredEntry)) fail(`app.asar is missing ${requiredEntry}.`);
  }
  if (entries.some(entry => /\/node_modules\/mupdf(?:\/|$)/u.test(entry))) {
    fail('app.asar still contains MuPDF.');
  }
  if (entries.some(entry => /\/node_modules\/@img\/sharp-wasm32(?:\/|$)/u.test(entry))) {
    fail('app.asar contains the unnecessary sharp WASM package.');
  }

  const manifest = readAsarJson(archivePath, 'package.json');
  if (manifest.dependencies?.['pdfjs-dist'] !== '6.2.108' ||
      manifest.dependencies?.['@napi-rs/canvas'] !== '1.0.3') {
    fail('packaged dependency versions do not match the reviewed PDF engine.');
  }
  if (Object.hasOwn(manifest.dependencies || {}, 'mupdf')) {
    fail('packaged manifest still declares MuPDF.');
  }

  let nativeTarget;
  try {
    nativeTarget = packageTarget(process.platform, process.arch);
  } catch (_error) {
    fail(`unsupported verification target ${process.platform}-${process.arch}.`);
  }
  const unpackedRoot = `${archivePath}.unpacked`;
  const napiRoot = path.join(unpackedRoot, 'node_modules', '@napi-rs');
  const wrapperPath = path.join(napiRoot, 'canvas');
  const nativePackagePath = path.join(napiRoot, nativeTarget.canvasPackage);
  const nativeBinaryPath = path.join(nativePackagePath, nativeTarget.canvasBinary);

  for (const requiredFile of [
    path.join(wrapperPath, 'index.js'),
    path.join(wrapperPath, 'LICENSE'),
    path.join(wrapperPath, 'package.json'),
    path.join(nativePackagePath, 'package.json'),
    nativeBinaryPath
  ]) {
    const stats = await fsp.stat(requiredFile).catch(() => null);
    if (!stats?.isFile() || stats.size < 1) {
      fail(`native canvas package is missing ${requiredFile}.`);
    }
  }

  const packagedTargets = (await fsp.readdir(napiRoot, { withFileTypes: true }))
    .filter(entry => entry.isDirectory() && entry.name.startsWith('canvas-'))
    .map(entry => entry.name)
    .sort();
  if (packagedTargets.length !== 1 ||
      packagedTargets[0] !== nativeTarget.canvasPackage) {
    fail(
      `wrong native canvas package set: ${packagedTargets.join(', ') || 'none'}.`
    );
  }

  const imgRoot = path.join(unpackedRoot, 'node_modules', '@img');
  const packagedSharpTargets = (await fsp.readdir(imgRoot, { withFileTypes: true }))
    .filter(entry => entry.isDirectory() && entry.name.startsWith('sharp-'))
    .map(entry => entry.name)
    .sort();
  const expectedSharpTargets = [
    nativeTarget.sharpPackage,
    ...(nativeTarget.libvipsPackage ? [nativeTarget.libvipsPackage] : [])
  ].sort();
  if (
    packagedSharpTargets.length !== expectedSharpTargets.length
    || packagedSharpTargets.some(
      (target, index) => target !== expectedSharpTargets[index]
    )
  ) {
    fail(
      `wrong native sharp package set: ${packagedSharpTargets.join(', ') || 'none'}.`
    );
  }

  const canvas = require(wrapperPath);
  const probe = canvas.createCanvas(2, 2).toBuffer('image/png');
  if (probe.subarray(1, 4).toString('ascii') !== 'PNG') {
    fail('native canvas addon did not produce a PNG.');
  }

  const runtimePath = await locateRuntime(archivePath, manifest);
  runPackagedRuntimeSmoke(runtimePath, archivePath);
  const legalEvidence = await verifyLegalBundle(
    path.join(path.dirname(archivePath), 'legal', 'manifest.json'),
    { requireComplete: false }
  );

  return {
    archive: archivePath,
    nativeTarget: nativeTarget.canvasPackage,
    pdfRenderer: 'pdfjs-dist@6.2.108',
    runtimeSmoke: 'passed',
    legalEvidence: legalEvidence.evidenceVerification,
    releaseLegalStatus: legalEvidence.releaseLegalStatus
  };
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  let archivePath = options.archive;
  if (!archivePath) {
    const archives = await findFilesNamed(options.root, 'app.asar');
    if (archives.length !== 1) {
      fail(`expected exactly one app.asar under ${options.root}; found ${archives.length}.`);
    }
    [archivePath] = archives;
  }

  const result = await verifyArchive(archivePath);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

main().catch(error => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 1;
});
