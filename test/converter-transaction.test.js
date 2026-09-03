const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { fileURLToPath } = require('node:url');

const Converter = require('../src/services/converter/Converter');
const LibreOfficeStrategy = require('../src/services/converter/strategies/LibreOfficeStrategy');
const PowerPointStrategy = require('../src/services/converter/strategies/PowerPointStrategy');
const { PDF_RENDERER_PROVENANCE } = require('../src/services/pdf/PdfEngine');

async function writeGeneration(directory, marker, slideCount = 2) {
  await fs.mkdir(directory, { recursive: true });

  const slides = [];
  for (let index = 1; index <= slideCount; index++) {
    const number = String(index).padStart(3, '0');
    await fs.writeFile(path.join(directory, `slide_${number}.jpg`), `${marker}-slide-${index}`);
    await fs.writeFile(
      path.join(directory, `slide_${number}_thumb.jpg`),
      `${marker}-thumbnail-${index}`
    );
    slides.push({ text: `${marker} ${index}`, firstLine: marker });
  }

  await fs.writeFile(
    path.join(directory, 'metadata.json'),
    JSON.stringify({
      sourceFile: `${marker}.pptx`,
      originalFile: `${marker}.pptx`,
      slideCount,
      slides
    })
  );
}

async function makeTempDirectory(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'syncshow-converter-test-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return directory;
}

test('generation validation requires contiguous slides, thumbnails, and matching metadata', async t => {
  const root = await makeTempDirectory(t);
  const generation = path.join(root, 'generation');
  const converter = new Converter();
  await writeGeneration(generation, 'valid', 3);

  const metadata = await converter._validateGeneration(generation, 3);
  assert.equal(metadata.slideCount, 3);

  await fs.rm(path.join(generation, 'slide_002_thumb.jpg'));
  await assert.rejects(
    converter._validateGeneration(generation, 3),
    /thumbnails.*missing, extra, or not contiguously numbered/i
  );

  await fs.writeFile(path.join(generation, 'slide_002_thumb.jpg'), 'restored-thumbnail');
  await fs.writeFile(path.join(generation, 'leftover.pdf'), 'partial-pdf');
  await assert.rejects(
    converter._validateGeneration(generation, 3),
    /unexpected artifacts.*leftover\.pdf/i
  );
});

test('generation validation rejects mismatched metadata without an explicit expected count', async t => {
  const root = await makeTempDirectory(t);
  const generation = path.join(root, 'generation');
  const converter = new Converter();
  await writeGeneration(generation, 'mismatch', 2);

  const metadataPath = path.join(generation, 'metadata.json');
  const metadata = JSON.parse(await fs.readFile(metadataPath, 'utf8'));
  metadata.slides = [];
  await fs.writeFile(metadataPath, JSON.stringify(metadata));

  await assert.rejects(
    converter._validateGeneration(generation),
    /metadata contains 0 slide entries; expected 2/i
  );
});

test('generation validation never follows generation, metadata, or artifact symlinks', async t => {
  const root = await makeTempDirectory(t);
  const generation = path.join(root, 'generation');
  const converter = new Converter();
  await writeGeneration(generation, 'safe-links', 2);

  const outsideMetadata = path.join(root, 'outside-metadata.json');
  await fs.writeFile(outsideMetadata, JSON.stringify({
    slideCount: 2,
    slides: [{ text: '', firstLine: '' }, { text: '', firstLine: '' }]
  }));
  await fs.rm(path.join(generation, 'metadata.json'));
  await fs.symlink(outsideMetadata, path.join(generation, 'metadata.json'));
  await assert.rejects(
    converter.validateGeneration(generation, 2),
    /invalid conversion metadata/i
  );

  await fs.rm(path.join(generation, 'metadata.json'));
  await writeGeneration(generation, 'safe-links', 2);
  const outsideSlide = path.join(root, 'outside-slide.jpg');
  await fs.writeFile(outsideSlide, 'outside-slide');
  await fs.rm(path.join(generation, 'slide_001.jpg'));
  await fs.symlink(outsideSlide, path.join(generation, 'slide_001.jpg'));
  await assert.rejects(
    converter.validateGeneration(generation, 2),
    /empty or not a file/i
  );

  const linkedGeneration = path.join(root, 'linked-generation');
  await fs.symlink(generation, linkedGeneration);
  await assert.rejects(
    converter.validateGeneration(linkedGeneration, 2),
    /invalid conversion metadata/i
  );
});

test('generation validation treats restore provenance as part of the atomic cache contract', async t => {
  const root = await makeTempDirectory(t);
  const generation = path.join(root, 'generation');
  const converter = new Converter();
  await writeGeneration(generation, 'restore-context', 2);
  const metadataPath = path.join(generation, 'metadata.json');
  const metadata = JSON.parse(await fs.readFile(metadataPath, 'utf8'));
  metadata.restoreContext = {
    schemaVersion: 1,
    groupId: 'service-a',
    sourceKind: 'service-set',
    roleId: 'english',
    serviceSetId: 'service-a',
    assetId: `sha256:${'a'.repeat(64)}`
  };
  await fs.writeFile(metadataPath, JSON.stringify(metadata));

  assert.equal(
    (await converter.validateGeneration(generation)).restoreContext.groupId,
    'service-a'
  );

  metadata.restoreContext.roleId = '../escape';
  await fs.writeFile(metadataPath, JSON.stringify(metadata));
  await assert.rejects(
    converter.validateGeneration(generation),
    /restore context is invalid/i
  );
});

test('generation validation accepts legacy caches and validates new PDF renderer provenance', async t => {
  const root = await makeTempDirectory(t);
  const generation = path.join(root, 'generation');
  const converter = new Converter();
  await writeGeneration(generation, 'renderer-provenance', 2);
  const metadataPath = path.join(generation, 'metadata.json');

  const legacy = await converter.validateGeneration(generation);
  assert.equal(Object.hasOwn(legacy, 'pdfRenderer'), false);

  const metadata = JSON.parse(await fs.readFile(metadataPath, 'utf8'));
  metadata.pdfRenderer = { ...PDF_RENDERER_PROVENANCE };
  await fs.writeFile(metadataPath, JSON.stringify(metadata));
  assert.deepEqual(
    (await converter.validateGeneration(generation)).pdfRenderer,
    PDF_RENDERER_PROVENANCE
  );

  metadata.pdfRenderer.localPath = '/private/pdf-engine';
  await fs.writeFile(metadataPath, JSON.stringify(metadata));
  await assert.rejects(
    converter.validateGeneration(generation),
    /invalid PDF renderer provenance.*unexpected fields/i
  );
});

test('publishing installs a complete generation and preserves the previous last-good cache', async t => {
  const root = await makeTempDirectory(t);
  const active = path.join(root, 'english');
  const staging = path.join(root, 'english.staging-test');
  const converter = new Converter();
  await writeGeneration(active, 'old');
  await writeGeneration(staging, 'new');

  await converter._replaceActiveGeneration(staging, active);

  assert.equal(
    await fs.readFile(path.join(active, 'slide_001.jpg'), 'utf8'),
    'new-slide-1'
  );
  assert.equal(
    await fs.readFile(path.join(`${active}.last-good`, 'slide_001.jpg'), 'utf8'),
    'old-slide-1'
  );
  await assert.rejects(fs.access(staging), error => error.code === 'ENOENT');

  const secondStaging = path.join(root, 'english.staging-second');
  await writeGeneration(secondStaging, 'newest');
  await converter._replaceActiveGeneration(secondStaging, active);

  assert.equal(
    await fs.readFile(path.join(active, 'slide_001.jpg'), 'utf8'),
    'newest-slide-1'
  );
  assert.equal(
    await fs.readFile(path.join(`${active}.last-good`, 'slide_001.jpg'), 'utf8'),
    'new-slide-1'
  );
  const siblings = await fs.readdir(root);
  assert.equal(siblings.some(name => name.includes('.old-') || name.includes('.rollback-')), false);
});

test('concurrent publications to the same cache are serialized in invocation order', async t => {
  const root = await makeTempDirectory(t);
  const active = path.join(root, 'english');
  const firstStaging = path.join(root, 'english.staging-first');
  const secondStaging = path.join(root, 'english.staging-second');
  const firstConverter = new Converter();
  const secondConverter = new Converter();
  await writeGeneration(active, 'original');
  await writeGeneration(firstStaging, 'first');
  await writeGeneration(secondStaging, 'second');

  await Promise.all([
    firstConverter._replaceActiveGeneration(firstStaging, active),
    secondConverter._replaceActiveGeneration(secondStaging, active)
  ]);

  assert.equal(
    await fs.readFile(path.join(active, 'slide_001.jpg'), 'utf8'),
    'second-slide-1'
  );
  assert.equal(
    await fs.readFile(path.join(`${active}.last-good`, 'slide_001.jpg'), 'utf8'),
    'first-slide-1'
  );
  const siblings = await fs.readdir(root);
  assert.equal(siblings.some(name => name.includes('.old-') || name.includes('.rollback-')), false);
});

test('a failed publication restores the active cache', async t => {
  const root = await makeTempDirectory(t);
  const active = path.join(root, 'media');
  const missingStaging = path.join(root, 'media.staging-missing');
  const converter = new Converter();
  await writeGeneration(active, 'current');

  await assert.rejects(
    converter._replaceActiveGeneration(missingStaging, active),
    error => error.code === 'ENOENT'
  );

  assert.equal(
    await fs.readFile(path.join(active, 'slide_001.jpg'), 'utf8'),
    'current-slide-1'
  );
  const siblings = await fs.readdir(root);
  assert.equal(siblings.some(name => name.startsWith('media.rollback-')), false);
});

test('a non-empty previous cache that cannot validate is retained for recovery', async t => {
  const root = await makeTempDirectory(t);
  const active = path.join(root, 'russian');
  const staging = path.join(root, 'russian.staging-test');
  const converter = new Converter();
  await writeGeneration(active, 'recoverable');
  await writeGeneration(staging, 'replacement');

  const metadataPath = path.join(active, 'metadata.json');
  const metadata = JSON.parse(await fs.readFile(metadataPath, 'utf8'));
  metadata.slides = [];
  await fs.writeFile(metadataPath, JSON.stringify(metadata));

  await converter._replaceActiveGeneration(staging, active);

  assert.equal(
    await fs.readFile(path.join(active, 'slide_001.jpg'), 'utf8'),
    'replacement-slide-1'
  );
  const siblings = await fs.readdir(root);
  const rollback = siblings.find(name => name.startsWith('russian.rollback-'));
  assert.ok(rollback);
  assert.equal(
    await fs.readFile(path.join(root, rollback, 'slide_001.jpg'), 'utf8'),
    'recoverable-slide-1'
  );
});

test('a preexisting PowerPoint process falls back to isolated LibreOffice', async () => {
  const converter = new Converter();
  const progress = [];
  const originalDetect = LibreOfficeStrategy.detect;
  const originalConvert = LibreOfficeStrategy.prototype.convertToPdf;

  converter.strategy = new PowerPointStrategy('POWERPNT.EXE');
  converter.strategy._getRunningPowerPointProcessIds = async () => [4242];
  converter.on('progress', event => progress.push(event));

  LibreOfficeStrategy.detect = async () => ({ path: '/fake/soffice', isFlatpak: false });
  LibreOfficeStrategy.prototype.convertToPdf = async () => ({ pdfPath: '/tmp/fallback.pdf' });

  try {
    const result = await converter._convertToPdf('/tmp/input.pptx', '/tmp/staging');
    assert.equal(result.pdfPath, '/tmp/fallback.pdf');
    assert.equal(progress.length, 1);
    assert.equal(progress[0].fallbackFrom, 'PowerPoint');
    assert.equal(progress[0].converter, 'LibreOffice');
    assert.match(progress[0].message, /PowerPoint is already running/i);
  } finally {
    LibreOfficeStrategy.detect = originalDetect;
    LibreOfficeStrategy.prototype.convertToPdf = originalConvert;
  }
});

test('PowerPoint-in-use stays classified when no LibreOffice fallback is installed', async () => {
  const converter = new Converter();
  const originalDetect = LibreOfficeStrategy.detect;

  converter.strategy = new PowerPointStrategy('POWERPNT.EXE');
  converter.strategy._getRunningPowerPointProcessIds = async () => [4242];
  LibreOfficeStrategy.detect = async () => null;

  try {
    await assert.rejects(
      converter._convertToPdf('/tmp/input.pptx', '/tmp/staging'),
      error => error.code === PowerPointStrategy.POWERPOINT_IN_USE_CODE
    );
  } finally {
    LibreOfficeStrategy.detect = originalDetect;
  }
});

test('a failed LibreOffice fallback retains the PowerPoint-in-use root cause', async () => {
  const converter = new Converter();
  const originalDetect = LibreOfficeStrategy.detect;
  const originalConvert = LibreOfficeStrategy.prototype.convertToPdf;

  converter.strategy = new PowerPointStrategy('POWERPNT.EXE');
  converter.strategy._getRunningPowerPointProcessIds = async () => [4242];
  LibreOfficeStrategy.detect = async () => ({ path: '/fake/soffice', isFlatpak: false });
  LibreOfficeStrategy.prototype.convertToPdf = async () => {
    throw new Error('LibreOffice test failure');
  };

  try {
    await assert.rejects(
      converter._convertToPdf('/tmp/input.pptx', '/tmp/staging'),
      error => {
        assert.equal(error.code, 'PRESENTATION_CONVERSION_FALLBACK_FAILED');
        assert.equal(
          error.powerPointError.code,
          PowerPointStrategy.POWERPOINT_IN_USE_CODE
        );
        return true;
      }
    );
  } finally {
    LibreOfficeStrategy.detect = originalDetect;
    LibreOfficeStrategy.prototype.convertToPdf = originalConvert;
  }
});

test('LibreOffice profiles are removed immediately and PDF directories have explicit cleanup', async t => {
  const strategy = new LibreOfficeStrategy('/fake/soffice');
  let profilePath;

  strategy._runConversion = async (command, args) => {
    assert.equal(command, '/fake/soffice');
    const outputIndex = args.indexOf('--outdir');
    const outputDirectory = args[outputIndex + 1];
    const profileArgument = args.find(argument => argument.startsWith('-env:UserInstallation='));
    profilePath = fileURLToPath(profileArgument.slice('-env:UserInstallation='.length));
    await fs.writeFile(path.join(outputDirectory, 'example.pdf'), 'pdf-data');
    return { stdout: 'converted', stderr: '' };
  };

  const result = await strategy.convertToPdf('/tmp/example.pptx', '/tmp/unused');
  const pdfDirectory = path.dirname(result.pdfPath);
  t.after(() => result.cleanup());

  assert.equal(await fs.readFile(result.pdfPath, 'utf8'), 'pdf-data');
  await assert.rejects(fs.access(profilePath), error => error.code === 'ENOENT');

  await result.cleanup();
  await assert.rejects(fs.access(pdfDirectory), error => error.code === 'ENOENT');
});

test('LibreOffice timeout terminates its isolated process tree and settles promptly', async () => {
  const strategy = new LibreOfficeStrategy('/fake/soffice');
  const startedAt = Date.now();

  await assert.rejects(
    strategy._runConversion(
      process.execPath,
      ['-e', 'setInterval(() => {}, 1000)'],
      50,
      250
    ),
    /timed out/i
  );

  assert.ok(Date.now() - startedAt < 2000);
});

test('PowerPoint automation refuses any preexisting POWERPNT process', async () => {
  const strategy = new PowerPointStrategy('POWERPNT.EXE');
  strategy._getRunningPowerPointProcessIds = async () => [4242, 4343];

  await assert.rejects(
    strategy._assertNoPreexistingPowerPoint(),
    error => {
      assert.equal(error.code, PowerPointStrategy.POWERPOINT_IN_USE_CODE);
      assert.deepEqual(error.processIds, [4242, 4343]);
      return true;
    }
  );
});

test('PowerPoint automation proceeds only when the preflight process list is empty', async () => {
  const strategy = new PowerPointStrategy('POWERPNT.EXE');
  strategy._getRunningPowerPointProcessIds = async () => [];

  await strategy._assertNoPreexistingPowerPoint();
});

test('PowerPoint safety source never invokes taskkill and guards Quit with exclusive ownership', async () => {
  const source = await fs.readFile(
    require.resolve('../src/services/converter/strategies/PowerPointStrategy'),
    'utf8'
  );

  assert.doesNotMatch(source, /['"]taskkill['"]/i);
  assert.ok(
    source.indexOf('$preexistingPowerPointPids') <
      source.indexOf('New-Object -ComObject PowerPoint.Application')
  );
  assert.match(source, /if \(\$stillExclusive\) \{\s*try \{ \$pptApp\.Quit\(\) \}/);
  assert.match(source, /\$pptApp\.Presentations\.Count -eq 0/);
  assert.match(source, /\$safeToClosePresentation = \(\$presentation\.Saved -ne 0\)/);
});
