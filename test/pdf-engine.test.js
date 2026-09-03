'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const sharp = require('sharp');

const PdfToImageConverter = require('../src/services/converter/PdfToImageConverter');
const {
  PDF_RENDERER_PROVENANCE,
  PDFJS_RESOURCE_PATHS,
  normalizePdfRendererProvenance,
  openPdf
} = require('../src/services/pdf/PdfEngine');

function pdfEscape(value) {
  return value.replace(/\\/gu, '\\\\').replace(/\(/gu, '\\(').replace(/\)/gu, '\\)');
}

function buildPdfFixture(pageSpecs) {
  const objects = [];
  let nextObjectId = 3;
  const pages = pageSpecs.map(spec => {
    const pageObjectId = nextObjectId++;
    const contentObjectId = nextObjectId++;
    const annotationObjectId = spec.annotation ? nextObjectId++ : null;
    return {
      ...spec,
      pageObjectId,
      contentObjectId,
      annotationObjectId
    };
  });
  const fontObjectId = nextObjectId++;

  objects[1] = '<< /Type /Catalog /Pages 2 0 R >>';
  objects[2] = '<< /Type /Pages '
    + `/Kids [${pages.map(page => `${page.pageObjectId} 0 R`).join(' ')}] `
    + `/Count ${pages.length} >>`;

  for (const [index, page] of pages.entries()) {
    const mediaBox = page.mediaBox || [0, 0, 612, 792];
    const cropBox = page.cropBox ? `/CropBox [${page.cropBox.join(' ')}] ` : '';
    const rotation = page.rotation ? `/Rotate ${page.rotation} ` : '';
    const annotations = page.annotation
      ? `/Annots [${page.annotationObjectId} 0 R] `
      : '';
    const firstLine = page.text || `Fixture page ${index + 1}`;
    const content = [
      'q 1 1 1 rg 180 260 180 120 re f Q',
      `BT /F1 18 Tf 80 720 Td (${pdfEscape(firstLine)}) Tj`,
      `0 -24 Td (${pdfEscape(`Line ${index + 1}`)}) Tj ET`
    ].join(' ');

    objects[page.pageObjectId] = '<< /Type /Page '
      + '/Parent 2 0 R '
      + `/MediaBox [${mediaBox.join(' ')}] `
      + cropBox
      + rotation
      + `/Resources << /Font << /F1 ${fontObjectId} 0 R >> >> `
      + `/Contents ${page.contentObjectId} 0 R `
      + annotations
      + '>>';
    objects[page.contentObjectId] =
      `<< /Length ${Buffer.byteLength(content, 'ascii')} >>\n`
      + `stream\n${content}\nendstream`;

    if (page.annotation) {
      objects[page.annotationObjectId] = '<< /Type /Annot /Subtype /Square '
        + '/Rect [40 40 160 160] /C [1 0 0] /Border [0 0 10] /F 4 >>';
    }
  }

  objects[fontObjectId] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>';

  const parts = [Buffer.from('%PDF-1.4\n', 'ascii')];
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

async function makeTempDirectory(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'syncshow-pdf-engine-test-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return directory;
}

const ORIENTATION_FIXTURE = buildPdfFixture([
  { mediaBox: [0, 0, 600, 800], annotation: true, text: 'Portrait annotation' },
  { mediaBox: [0, 0, 800, 600], text: 'Landscape' },
  { mediaBox: [0, 0, 600, 800], rotation: 90, text: 'Rotated landscape' },
  {
    mediaBox: [0, 0, 800, 800],
    cropBox: [100, 200, 700, 600],
    text: 'Cropped landscape'
  }
]);

test('shared PDF engine bounds portrait, landscape, rotated, and cropped pages', async () => {
  const originalHash = Buffer.from(ORIENTATION_FIXTURE);
  const document = await openPdf(ORIENTATION_FIXTURE);

  try {
    assert.equal(document.pageCount, 4);
    const expectedDimensions = [
      [135, 180],
      [240, 180],
      [240, 180],
      [270, 180]
    ];

    for (let index = 0; index < expectedDimensions.length; index += 1) {
      const rendered = await document.renderPageToPng(index, {
        maximumWidth: 320,
        maximumHeight: 180
      });
      assert.deepEqual([rendered.width, rendered.height], expectedDimensions[index]);
      const metadata = await sharp(rendered.png).metadata();
      assert.equal(metadata.format, 'png');
      assert.equal(metadata.width, rendered.width);
      assert.equal(metadata.height, rendered.height);
    }

    const annotationPage = await document.renderPageToPng(0, {
      maximumWidth: 320,
      maximumHeight: 180
    });
    const { data, info } = await sharp(annotationPage.png)
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    let redPixels = 0;
    for (let offset = 0; offset < data.length; offset += info.channels) {
      if (data[offset] > 160 && data[offset + 1] < 100 && data[offset + 2] < 100) {
        redPixels += 1;
      }
    }
    assert.ok(redPixels > 20, 'expected the red square annotation to be rendered');

    const extracted = await document.extractPageText(0, {
      maximumCharacters: 100
    });
    assert.match(extracted.text, /Portrait annotation/u);
    assert.equal(extracted.truncated, false);
  } finally {
    await document.close();
  }

  assert.deepEqual(ORIENTATION_FIXTURE, originalHash);
  await document.close();
  await assert.rejects(
    document.renderPageToPng(0, { maximumWidth: 320, maximumHeight: 180 }),
    /already closed/i
  );
});

test('PDF-to-image conversion preserves naming, progress, dimensions, and opaque output', async t => {
  const root = await makeTempDirectory(t);
  const pdfPath = path.join(root, 'fixture.pdf');
  const outputDir = path.join(root, 'slides');
  await fs.mkdir(outputDir);
  await fs.writeFile(pdfPath, ORIENTATION_FIXTURE);

  const converter = new PdfToImageConverter({
    width: 320,
    height: 180,
    quality: 92
  });
  const progress = [];
  converter.on('progress', event => progress.push(event));

  const result = await converter.convert(pdfPath, outputDir);
  assert.deepEqual(result, {
    slideCount: 4,
    pdfRenderer: { ...PDF_RENDERER_PROVENANCE }
  });
  assert.deepEqual(progress, [
    { percent: 25, current: 1, total: 4 },
    { percent: 50, current: 2, total: 4 },
    { percent: 75, current: 3, total: 4 },
    { percent: 100, current: 4, total: 4 }
  ]);
  assert.deepEqual(await fs.readdir(outputDir), [
    'slide_001.jpg',
    'slide_002.jpg',
    'slide_003.jpg',
    'slide_004.jpg'
  ]);

  const expectedDimensions = [
    [135, 180],
    [240, 180],
    [240, 180],
    [270, 180]
  ];
  for (let index = 0; index < expectedDimensions.length; index += 1) {
    const slidePath = path.join(
      outputDir,
      `slide_${String(index + 1).padStart(3, '0')}.jpg`
    );
    const metadata = await sharp(slidePath).metadata();
    assert.equal(metadata.format, 'jpeg');
    assert.equal(metadata.hasAlpha, false);
    assert.deepEqual([metadata.width, metadata.height], expectedDimensions[index]);
  }

  const transparentPng = await sharp({
    create: {
      width: 2,
      height: 2,
      channels: 4,
      background: { r: 0, g: 0, b: 0, alpha: 0 }
    }
  }).png().toBuffer();
  const flattenedPath = path.join(root, 'flattened.jpg');
  await PdfToImageConverter.writeFlattenedJpeg(transparentPng, flattenedPath, 100);
  const corner = await sharp(flattenedPath)
    .extract({ left: 0, top: 0, width: 1, height: 1 })
    .removeAlpha()
    .raw()
    .toBuffer();
  assert.ok(
    corner[0] < 12 && corner[1] < 12 && corner[2] < 12,
    `expected a black flattened corner, received ${[...corner].join(',')}`
  );
});

test('PDF engine rejects corrupt input, invalid bounds, and malformed provenance', async () => {
  assert.equal(
    Object.values(PDFJS_RESOURCE_PATHS).every(resourcePath => resourcePath.endsWith('/')),
    true
  );
  await assert.rejects(openPdf(Buffer.from('%PDF-1.4\nnot-a-document')), /PDF|document/i);

  const document = await openPdf(ORIENTATION_FIXTURE);
  try {
    await assert.rejects(
      document.renderPageToPng(4, { maximumWidth: 320, maximumHeight: 180 }),
      /outside/i
    );
    await assert.rejects(
      document.renderPageToPng(0, { maximumWidth: 0, maximumHeight: 180 }),
      /maximumWidth/i
    );
    await assert.rejects(
      document.extractPageText(0, { maximumCharacters: -1 }),
      /maximumCharacters/i
    );
  } finally {
    await document.close();
  }

  assert.deepEqual(
    normalizePdfRendererProvenance(PDF_RENDERER_PROVENANCE),
    PDF_RENDERER_PROVENANCE
  );
  assert.throws(
    () => normalizePdfRendererProvenance({
      ...PDF_RENDERER_PROVENANCE,
      unexpected: true
    }),
    /unexpected fields/i
  );
});
