'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const zlib = require('zlib');
const JSZip = require('jszip');

const {
  CANONICAL_BIBLE_BOOKS,
  MAX_EXTRACTION_UNITS,
  MAX_REFERENCE_SUGGESTIONS,
  MAX_TOTAL_TEXT_CHARS,
  MAX_UNIT_TEXT_CHARS,
  SERMON_SOURCE_EXTRACTION_KIND,
  SermonSourceExtractionError,
  extractSermonSourceProposal
} = require('../src/services/sermon');
const { openPdf } = require('../src/services/pdf/PdfEngine');

const MEDIA_TYPES = Object.freeze({
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  txt: 'text/plain',
  md: 'text/markdown'
});

function sourceMetadata(buffer, {
  id = 'source-test',
  kind = 'manuscript',
  fileName = 'sermon.txt',
  mediaType = MEDIA_TYPES.txt,
  languages = ['en', 'ru']
} = {}) {
  return {
    id,
    kind,
    fileName,
    mediaType,
    languages,
    sha256: crypto.createHash('sha256').update(buffer).digest('hex'),
    sizeBytes: buffer.length,
    provenance: {
      providedBy: 'test'
    }
  };
}

function xmlEscape(value) {
  return value
    .replace(/&/gu, '&amp;')
    .replace(/</gu, '&lt;')
    .replace(/>/gu, '&gt;')
    .replace(/"/gu, '&quot;')
    .replace(/'/gu, '&apos;');
}

async function buildDocx(lines, { unsafeDocumentPrefix = '' } = {}) {
  const zip = new JSZip();
  zip.file(
    '[Content_Types].xml',
    '<?xml version="1.0" encoding="UTF-8"?>'
      + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
      + '<Override PartName="/word/document.xml" '
      + 'ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>'
      + '</Types>'
  );
  zip.file(
    '_rels/.rels',
    '<?xml version="1.0" encoding="UTF-8"?>'
      + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
      + '<Relationship Id="rId1" '
      + 'Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" '
      + 'Target="word/document.xml"/>'
      + '</Relationships>'
  );
  zip.file(
    'word/document.xml',
    `${unsafeDocumentPrefix}<?xml version="1.0" encoding="UTF-8"?>`
      + '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">'
      + '<w:body>'
      + lines.map(line => (
        `<w:p><w:r><w:t xml:space="preserve">${xmlEscape(line)}</w:t></w:r></w:p>`
      )).join('')
      + '</w:body></w:document>'
  );
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

function slideXml(lines) {
  return '<?xml version="1.0" encoding="UTF-8"?>'
    + '<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" '
    + 'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">'
    + '<p:cSld><p:spTree>'
    + lines.map(line => (
      `<a:p><a:r><a:t>${xmlEscape(line)}</a:t></a:r></a:p>`
    )).join('')
    + '</p:spTree></p:cSld></p:sld>';
}

function styledSlideXml(paragraphs) {
  return '<?xml version="1.0" encoding="UTF-8"?>'
    + '<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" '
    + 'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">'
    + '<p:cSld><p:spTree>'
    + paragraphs.map(paragraph => `<a:p>${paragraph}</a:p>`).join('')
    + '</p:spTree></p:cSld></p:sld>';
}

function textRun(text, { color = null, bold = null, fill = 'srgb' } = {}) {
  const attributes = bold === null ? '' : ` b="${bold}"`;
  let colorXml = '';
  if (color && fill === 'srgb') {
    colorXml = `<a:solidFill><a:srgbClr val="${color}"/></a:solidFill>`;
  } else if (color && fill === 'scheme') {
    colorXml = `<a:solidFill><a:schemeClr val="${color}"/></a:solidFill>`;
  }
  return `<a:r><a:rPr${attributes}>${colorXml}</a:rPr>`
    + `<a:t>${xmlEscape(text)}</a:t></a:r>`;
}

async function buildPptx(orderedSlides, {
  relationshipTarget = null
} = {}) {
  const zip = new JSZip();
  const slideIds = [];
  const relationships = [];
  for (let index = 0; index < orderedSlides.length; index += 1) {
    const slide = orderedSlides[index];
    const relationshipId = `rId${index + 1}`;
    slideIds.push(`<p:sldId id="${256 + index}" r:id="${relationshipId}"/>`);
    relationships.push(
      '<Relationship '
        + `Id="${relationshipId}" `
        + 'Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" '
        + `Target="${index === 0 && relationshipTarget ? relationshipTarget : slide.part.slice(4)}"/>`
    );
    zip.file(slide.part, slide.xml || slideXml(slide.lines));
  }
  zip.file(
    '[Content_Types].xml',
    '<?xml version="1.0" encoding="UTF-8"?>'
      + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
      + '<Override PartName="/ppt/presentation.xml" '
      + 'ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>'
      + '</Types>'
  );
  zip.file(
    '_rels/.rels',
    '<?xml version="1.0" encoding="UTF-8"?>'
      + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
      + '<Relationship Id="rIdOffice" '
      + 'Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" '
      + 'Target="ppt/presentation.xml"/>'
      + '</Relationships>'
  );
  zip.file(
    'ppt/presentation.xml',
    '<?xml version="1.0" encoding="UTF-8"?>'
      + '<p:presentation '
      + 'xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" '
      + 'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
      + `<p:sldIdLst>${slideIds.join('')}</p:sldIdLst>`
      + '</p:presentation>'
  );
  zip.file(
    'ppt/_rels/presentation.xml.rels',
    '<?xml version="1.0" encoding="UTF-8"?>'
      + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
      + relationships.join('')
      + '</Relationships>'
  );
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

function pdfEscape(value) {
  return value.replace(/\\/gu, '\\\\').replace(/\(/gu, '\\(').replace(/\)/gu, '\\)');
}

function buildPdf(pages) {
  const objects = [];
  const pageObjectIds = pages.map((_page, index) => 3 + (index * 2));
  const fontObjectId = 3 + (pages.length * 2);
  objects[1] = '<< /Type /Catalog /Pages 2 0 R >>';
  objects[2] = `<< /Type /Pages /Kids [${pageObjectIds.map(id => `${id} 0 R`).join(' ')}] /Count ${pages.length} >>`;
  pages.forEach((lines, index) => {
    const pageObjectId = pageObjectIds[index];
    const contentObjectId = pageObjectId + 1;
    const content = 'BT /F1 12 Tf 72 720 Td '
      + lines.map((line, lineIndex) => (
        `${lineIndex ? '0 -18 Td ' : ''}(${pdfEscape(line)}) Tj`
      )).join(' ')
      + ' ET';
    objects[pageObjectId] = '<< /Type /Page '
      + '/Parent 2 0 R '
      + '/MediaBox [0 0 612 792] '
      + `/Resources << /Font << /F1 ${fontObjectId} 0 R >> >> `
      + `/Contents ${contentObjectId} 0 R >>`;
    objects[contentObjectId] = `<< /Length ${Buffer.byteLength(content, 'ascii')} >>\n`
      + `stream\n${content}\nendstream`;
  });
  objects[fontObjectId] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>';

  const parts = [Buffer.from('%PDF-1.4\n', 'ascii')];
  const offsets = [0];
  for (let id = 1; id < objects.length; id += 1) {
    offsets[id] = parts.reduce((sum, part) => sum + part.length, 0);
    parts.push(Buffer.from(`${id} 0 obj\n${objects[id]}\nendobj\n`, 'ascii'));
  }
  const xrefOffset = parts.reduce((sum, part) => sum + part.length, 0);
  const xref = [
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
  ].join('\n');
  parts.push(Buffer.from(xref, 'ascii'));
  return Buffer.concat(parts);
}

function buildUnicodePdf(version) {
  const content = 'BT /F1 12 Tf 10 55 Td '
    + '<00010002000300040005000600030007> Tj '
    + '0 -18 Td <0008000900020003000A000B000A000C000D000E000F> Tj ET';
  const cmap = [
    '/CIDInit /ProcSet findresource begin',
    '12 dict begin',
    'begincmap',
    '/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def',
    '/CMapName /Fixture-UCS def',
    '/CMapType 2 def',
    '1 begincodespacerange',
    '<0001> <000F>',
    'endcodespacerange',
    '15 beginbfchar',
    '<0001> <0049>',
    '<0002> <002E>',
    '<0003> <0020>',
    '<0004> <041C>',
    '<0005> <0438>',
    '<0006> <0440>',
    '<0007> <D83DDE00>',
    '<0008> <0415>',
    '<0009> <0444>',
    '<000A> <0031>',
    '<000B> <003A>',
    '<000C> <0039>',
    '<000D> <2013>',
    '<000E> <0032>',
    '<000F> <0030>',
    'endbfchar',
    'endcmap',
    'CMapName currentdict /CMap defineresource pop',
    'end',
    'end'
  ].join('\n');
  const objects = [
    null,
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 144 72] '
      + '/Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    `<< /Length ${Buffer.byteLength(content, 'ascii')} >>\n`
      + `stream\n${content}\nendstream`,
    '<< /Type /Font /Subtype /Type0 /BaseFont /Fixture /Encoding /Identity-H '
      + '/DescendantFonts [6 0 R] /ToUnicode 7 0 R >>',
    '<< /Type /Font /Subtype /CIDFontType2 /BaseFont /Fixture '
      + '/CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> '
      + '/FontDescriptor 8 0 R /CIDToGIDMap /Identity /DW 600 >>',
    `<< /Length ${Buffer.byteLength(cmap, 'ascii')} >>\nstream\n${cmap}\nendstream`,
    '<< /Type /FontDescriptor /FontName /Fixture /Flags 4 '
      + '/FontBBox [0 -200 1000 800] /ItalicAngle 0 /Ascent 800 '
      + '/Descent -200 /CapHeight 700 /StemV 80 >>'
  ];

  const parts = [Buffer.from(`%PDF-${version}\n`, 'ascii')];
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

function buildCompressedPdf(text) {
  const content = Buffer.from(
    `BT /F1 0.01 Tf 72 720 Td (${pdfEscape(text)}) Tj ET`,
    'ascii'
  );
  const compressed = zlib.deflateSync(content);
  const objects = [
    null,
    Buffer.from('<< /Type /Catalog /Pages 2 0 R >>', 'ascii'),
    Buffer.from('<< /Type /Pages /Kids [3 0 R] /Count 1 >>', 'ascii'),
    Buffer.from(
      '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] '
        + '/Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
      'ascii'
    ),
    Buffer.concat([
      Buffer.from(
        `<< /Length ${compressed.length} /Filter /FlateDecode >>\nstream\n`,
        'ascii'
      ),
      compressed,
      Buffer.from('\nendstream', 'ascii')
    ]),
    Buffer.from('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>', 'ascii')
  ];
  const parts = [Buffer.from('%PDF-1.4\n', 'ascii')];
  const offsets = [0];
  for (let id = 1; id < objects.length; id += 1) {
    offsets[id] = parts.reduce((sum, part) => sum + part.length, 0);
    parts.push(Buffer.concat([
      Buffer.from(`${id} 0 obj\n`, 'ascii'),
      objects[id],
      Buffer.from('\nendobj\n', 'ascii')
    ]));
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

function expectExtractionCode(code) {
  return error => {
    assert.ok(error instanceof SermonSourceExtractionError);
    assert.equal(error.code, code);
    return true;
  };
}

test('extracts frozen bilingual review suggestions from UTF-8 text without paths', async () => {
  const buffer = Buffer.from([
    'I. Основание молитвы / The Foundation of the Prayer',
    'А. Укрепились во внутреннем человеке / To Be Strengthened in the Inner Being',
    'Еф. 1:19–20 and Eph. 1:19-20',
    'II. Содержание молитвы / The Content of the Prayer',
    'В. Познать любовь / To Know Love',
    'Рим. 8:28 and Romans 8:28',
    'III. Результат молитвы / The Result of the Prayer',
    'С. Исполниться полнотой / To Be Filled with Fullness',
    'Wrapped: Еф. 2:1–',
    '6'
  ].join('\n'), 'utf8');
  const metadata = sourceMetadata(buffer, {
    fileName: 'notes.md',
    mediaType: MEDIA_TYPES.md
  });

  const proposal = await extractSermonSourceProposal(buffer, metadata);
  const repeated = await extractSermonSourceProposal(buffer, metadata);

  assert.equal(proposal.kind, SERMON_SOURCE_EXTRACTION_KIND);
  assert.deepEqual(repeated, proposal);
  assert.equal(proposal.suggestionScope.strategy, 'whole-source');
  assert.equal(proposal.source.id, metadata.id);
  assert.equal(proposal.source.sha256, metadata.sha256);
  assert.equal(Object.prototype.hasOwnProperty.call(proposal.source, 'fileName'), false);
  assert.equal(Object.isFrozen(proposal), true);
  assert.equal(Object.isFrozen(proposal.units), true);
  assert.equal(Object.isFrozen(proposal.outlineSuggestions[0].titles), true);
  assert.throws(() => {
    proposal.source.id = 'changed';
  }, TypeError);

  const sectionI = proposal.outlineSuggestions.find(item => item.id === 'outline-i');
  assert.deepEqual(Object.keys(sectionI.titles), ['en', 'ru']);
  assert.deepEqual(sectionI.titles, {
    en: 'The Foundation of the Prayer',
    ru: 'Основание молитвы'
  });
  const pointA = proposal.outlineSuggestions.find(item => item.id === 'outline-i-a');
  assert.equal(pointA.parentId, 'outline-i');
  assert.equal(pointA.parentSuggestionId, 'outline-i');
  assert.equal(pointA.marker, 'A');
  const pointB = proposal.outlineSuggestions.find(item => item.id === 'outline-ii-b');
  assert.equal(pointB.marker, 'B');
  const pointC = proposal.outlineSuggestions.find(item => item.id === 'outline-iii-c');
  assert.equal(pointC.marker, 'C');

  const rawReferences = proposal.scriptureReferenceSuggestions.map(item => item.rawText);
  assert.ok(rawReferences.includes('Еф. 1:19–20'));
  assert.ok(rawReferences.includes('Eph. 1:19-20'));
  assert.ok(rawReferences.includes('Рим. 8:28'));
  assert.ok(rawReferences.includes('Romans 8:28'));
  assert.ok(rawReferences.includes('Еф. 2:1–6'));
  assert.match(proposal.textPreview, /Еф\. 2:1–\n6/u);

  const serialized = JSON.stringify(proposal);
  assert.equal(serialized.includes(metadata.fileName), false);
  assert.equal(serialized.includes('/Users/'), false);
  assert.equal(serialized.includes('filePath'), false);
  assert.equal(serialized.includes('localPath'), false);
});

test('recognizes all 66 canonical English book names with OSIS-resolvable hints', async () => {
  const buffer = Buffer.from(
    CANONICAL_BIBLE_BOOKS.map(book => `${book.name} 1:1`).join('\n'),
    'utf8'
  );
  const proposal = await extractSermonSourceProposal(buffer, sourceMetadata(buffer, {
    languages: ['en']
  }));

  assert.equal(proposal.scriptureReferenceSuggestions.length, 66);
  assert.deepEqual(
    proposal.scriptureReferenceSuggestions.map(suggestion => suggestion.bookHint),
    CANONICAL_BIBLE_BOOKS.map(book => book.id)
  );
});

test('recognizes practical English and Russian aliases without partial-word guesses', async () => {
  const buffer = Buffer.from([
    'John 3:16',
    'Acts 2:42',
    'Psalm 23:1',
    '1 Jn. 4:8',
    '2 Tim. 3:16',
    'Ин. 3:16',
    'Деян. 2:42',
    'Пс. 23:1',
    '1 Кор. 13:4–7',
    '3 Цар. 18:21',
    'remark 3:16',
    'Johnathan 3:16',
    'Actsish 2:42',
    'is 3:16',
    'ПсевдоПс 23:1',
    'Инна 3:16',
    '1 Иоаннович 4:8',
    'John 3:16ish'
  ].join('\n'), 'utf8');
  const proposal = await extractSermonSourceProposal(buffer, sourceMetadata(buffer));

  assert.deepEqual(
    proposal.scriptureReferenceSuggestions.map(suggestion => [
      suggestion.rawText,
      suggestion.language,
      suggestion.bookHint
    ]),
    [
      ['John 3:16', 'en', 'John'],
      ['Acts 2:42', 'en', 'Acts'],
      ['Psalm 23:1', 'en', 'Ps'],
      ['1 Jn. 4:8', 'en', '1John'],
      ['2 Tim. 3:16', 'en', '2Tim'],
      ['Ин. 3:16', 'ru', 'John'],
      ['Деян. 2:42', 'ru', 'Acts'],
      ['Пс. 23:1', 'ru', 'Ps'],
      ['1 Кор. 13:4–7', 'ru', '1Cor'],
      ['3 Цар. 18:21', 'ru', '1Kgs']
    ]
  );
});

test('uses declared heading languages and skips titles too long for canonical review', async () => {
  const spanish = Buffer.from('I. Fundamento', 'utf8');
  const spanishProposal = await extractSermonSourceProposal(spanish, sourceMetadata(spanish, {
    languages: ['es']
  }));
  assert.deepEqual(spanishProposal.outlineSuggestions[0].titles, {
    es: 'Fundamento'
  });

  const ukrainian = Buffer.from('I. Основа', 'utf8');
  const ukrainianProposal = await extractSermonSourceProposal(
    ukrainian,
    sourceMetadata(ukrainian, { languages: ['uk'] })
  );
  assert.deepEqual(ukrainianProposal.outlineSuggestions[0].titles, {
    uk: 'Основа'
  });

  const ambiguous = Buffer.from('I. Foundation', 'utf8');
  const ambiguousProposal = await extractSermonSourceProposal(
    ambiguous,
    sourceMetadata(ambiguous, { languages: ['en', 'es'] })
  );
  assert.deepEqual(ambiguousProposal.outlineSuggestions[0].titles, {
    und: 'Foundation'
  });

  const excessive = Buffer.from(`I. ${'x'.repeat(501)}\nA. Child`, 'utf8');
  const excessiveProposal = await extractSermonSourceProposal(
    excessive,
    sourceMetadata(excessive, { languages: ['en'] })
  );
  assert.deepEqual(excessiveProposal.outlineSuggestions, []);
});

test('uses presentation relationship order, scopes to I-II-III, and dedupes cumulative headings', async () => {
  const slides = [
    { part: 'ppt/slides/slide10.xml', lines: ['Reading outside sermon: Romans 1:1'] },
    { part: 'ppt/slides/slide4.xml', lines: [] },
    { part: 'ppt/slides/slide8.xml', lines: ['Sermon title'] },
    { part: 'ppt/slides/slide2.xml', lines: ['Sermon passage: Eph 3:14'] },
    { part: 'ppt/slides/slide11.xml', lines: ['Sermon title'] },
    { part: 'ppt/slides/slide6.xml', lines: ['I. Основание / Foundation'] },
    {
      part: 'ppt/slides/slide1.xml',
      lines: ['I. Основание / Foundation', 'А. Укрепиться / Be Strengthened']
    },
    {
      part: 'ppt/slides/slide9.xml',
      lines: [
        'I. Основание / Foundation',
        'А. Укрепиться / Be Strengthened',
        'II. Содержание / Content'
      ]
    },
    {
      part: 'ppt/slides/slide5.xml',
      lines: [
        'I. Основание / Foundation',
        'А. Укрепиться / Be Strengthened',
        'II. Содержание / Content',
        'В. Познать любовь / To Know Love'
      ]
    },
    {
      part: 'ppt/slides/slide3.xml',
      lines: [
        'I. Основание / Foundation',
        'A. Be Strengthened / Укрепиться',
        'II. Содержание / Content',
        'B. To Know Love / Познать любовь',
        'III. Результат / Result',
        'С. Исполниться / Be Filled',
        'Eph 3:16'
      ]
    },
    {
      part: 'ppt/slides/slide7.xml',
      lines: ['I. Announcements', 'Reading outside sermon: Rom 8:28']
    }
  ];
  const buffer = await buildPptx(slides);
  const proposal = await extractSermonSourceProposal(buffer, sourceMetadata(buffer, {
    kind: 'slide-notes',
    fileName: 'service.pptx',
    mediaType: MEDIA_TYPES.pptx
  }));

  assert.match(proposal.units[0].text, /Romans 1:1/u);
  assert.equal(proposal.units[1].text, '');
  assert.match(proposal.units[5].text, /^I\. Основание/u);
  assert.deepEqual(proposal.suggestionScope, {
    strategy: 'pptx-roman-outline-window',
    startUnitId: 'pptx-slide-2',
    endUnitId: 'pptx-slide-10',
    startOrdinal: 2,
    endOrdinal: 10
  });

  const sectionI = proposal.outlineSuggestions.find(item => item.id === 'outline-i');
  assert.equal(sectionI.occurrenceCount, 5);
  assert.deepEqual(sectionI.sourceUnitIds, [
    'pptx-slide-6',
    'pptx-slide-7',
    'pptx-slide-8',
    'pptx-slide-9',
    'pptx-slide-10'
  ]);
  const pointA = proposal.outlineSuggestions.find(item => item.id === 'outline-i-a');
  assert.equal(pointA.occurrenceCount, 4);
  assert.deepEqual(pointA.titles, {
    en: 'Be Strengthened',
    ru: 'Укрепиться'
  });
  const pointB = proposal.outlineSuggestions.find(item => item.id === 'outline-ii-b');
  assert.equal(pointB.occurrenceCount, 2);
  assert.deepEqual(pointB.titles, {
    en: 'To Know Love',
    ru: 'Познать любовь'
  });

  assert.deepEqual(
    proposal.scriptureReferenceSuggestions.map(item => item.rawText),
    ['Eph 3:14', 'Eph 3:16']
  );
  assert.equal(proposal.textPreview.includes('Romans 1:1'), false);
  assert.match(proposal.textPreview, /Sermon title/u);
});

test('PPTX extraction schema v2 preserves only direct gold run emphasis over exact normalized text', async () => {
  const slides = [{
    part: 'ppt/slides/slide3.xml',
    xml: styledSlideXml([
      textRun('I. Foundation'),
      textRun('  Eph. 3:9  ', { color: 'FFC000', bold: '1' })
        + textRun('plain', { bold: '1' }),
      textRun('administration', { color: 'FFC000', bold: 'false' })
    ])
  }, {
    part: 'ppt/slides/slide1.xml',
    xml: styledSlideXml([
      textRun('II. Content'),
      textRun('😀Faith', { color: 'FFC000', bold: 'true' }),
      textRun('Inherited', { color: 'accent4', bold: 'true', fill: 'scheme' })
    ])
  }, {
    part: 'ppt/slides/slide2.xml',
    xml: styledSlideXml([
      textRun('III. Result'),
      textRun('C. Filled')
    ])
  }];
  const buffer = await buildPptx(slides);
  const proposal = await extractSermonSourceProposal(buffer, sourceMetadata(buffer, {
    kind: 'slide-notes',
    fileName: 'styled-sermon.pptx',
    mediaType: MEDIA_TYPES.pptx
  }));

  assert.equal(proposal.schemaVersion, 2);
  assert.equal(proposal.extractor.version, 3);
  assert.equal(proposal.suggestionScope.strategy, 'pptx-roman-outline-window');

  const first = proposal.units[0];
  assert.equal(
    first.text,
    'I. Foundation\nEph. 3:9 plain\nadministration'
  );
  assert.deepEqual(first.spans.map(span => ({
    text: first.text.slice(span.start, span.end),
    foreground: span.foreground,
    weight: span.weight
  })), [{
    text: 'Eph. 3:9 ',
    foreground: '#ffc000',
    weight: '700'
  }, {
    text: 'administration',
    foreground: '#ffc000',
    weight: '400'
  }]);

  const second = proposal.units[1];
  assert.deepEqual(second.spans, [{
    start: second.text.indexOf('😀Faith'),
    end: second.text.indexOf('😀Faith') + '😀Faith'.length,
    foreground: '#ffc000',
    weight: '700'
  }]);
  assert.equal(second.spans[0].end - second.spans[0].start, 7);
  assert.equal(
    second.spans.some(span => second.text.slice(span.start, span.end).includes('Inherited')),
    false
  );
  assert.equal(Object.isFrozen(first.spans), true);
});

test('does not treat a non-cumulative whole-service PPTX as sermon metadata', async () => {
  const buffer = await buildPptx([
    { part: 'ppt/slides/slide3.xml', lines: ['I. Song stanza'] },
    { part: 'ppt/slides/slide1.xml', lines: ['II. Song stanza', 'Rom 8:28'] },
    { part: 'ppt/slides/slide2.xml', lines: ['III. Song stanza'] }
  ]);
  const proposal = await extractSermonSourceProposal(buffer, sourceMetadata(buffer, {
    kind: 'slide-notes',
    fileName: 'whole-service.pptx',
    mediaType: MEDIA_TYPES.pptx
  }));

  assert.deepEqual(proposal.suggestionScope, {
    strategy: 'pptx-no-sermon-window',
    startUnitId: null,
    endUnitId: null,
    startOrdinal: null,
    endOrdinal: null
  });
  assert.deepEqual(proposal.outlineSuggestions, []);
  assert.deepEqual(proposal.scriptureReferenceSuggestions, []);
  assert.match(proposal.textPreview, /Rom 8:28/u);
});

test('extracts ordered DOCX document chunks and raw Russian references', async () => {
  const buffer = await buildDocx([
    'II. Содержание / Content',
    'В. Познать любовь / To Know Love',
    'Ссылка Рим. 8:28'
  ]);
  const proposal = await extractSermonSourceProposal(buffer, sourceMetadata(buffer, {
    fileName: 'manuscript.docx',
    mediaType: MEDIA_TYPES.docx
  }));

  assert.equal(proposal.units[0].kind, 'document');
  assert.match(proposal.units[0].text, /^II\. Содержание \/ Content\nВ\./u);
  const pointB = proposal.outlineSuggestions.find(item => item.id === 'outline-ii-b');
  assert.equal(pointB.parentId, 'outline-ii');
  assert.deepEqual(
    proposal.scriptureReferenceSuggestions.map(item => item.rawText),
    ['Рим. 8:28']
  );
});

test('extracts text page-by-page from a deterministic PDF', async () => {
  const buffer = buildPdf([
    ['I. Foundation', 'Eph. 1:19-20'],
    ['II. Content', 'Rom. 8:28']
  ]);
  const proposal = await extractSermonSourceProposal(buffer, sourceMetadata(buffer, {
    languages: ['en'],
    fileName: 'manuscript.pdf',
    mediaType: MEDIA_TYPES.pdf
  }));

  assert.equal(proposal.units.length, 2);
  assert.equal(proposal.units[0].kind, 'page');
  assert.match(proposal.units[0].text, /I\. Foundation/u);
  assert.match(proposal.units[1].text, /II\. Content/u);
  assert.deepEqual(
    proposal.scriptureReferenceSuggestions.map(item => item.bookHint),
    ['Eph', 'Rom']
  );

  const compressed = buildCompressedPdf('x'.repeat(MAX_UNIT_TEXT_CHARS + 10_000));
  const bounded = await extractSermonSourceProposal(compressed, sourceMetadata(compressed, {
    languages: ['en'],
    fileName: 'compressed.pdf',
    mediaType: MEDIA_TYPES.pdf
  }));
  assert.ok(bounded.units[0].text.length <= MAX_UNIT_TEXT_CHARS);
  assert.equal(bounded.units[0].truncated, true);
  assert.equal(bounded.truncated.text, true);
});

test('extracts exact Cyrillic, punctuation, and emoji text from PDF 1.7 and 2.0', async () => {
  const expectedText = 'I. Мир 😀\nЕф. 1:19–20';

  for (const version of ['1.7', '2.0']) {
    const buffer = buildUnicodePdf(version);
    const proposal = await extractSermonSourceProposal(buffer, sourceMetadata(buffer, {
      languages: ['ru', 'en'],
      fileName: `unicode-${version}.pdf`,
      mediaType: MEDIA_TYPES.pdf
    }));

    assert.equal(proposal.extractor.version, 3);
    assert.equal(proposal.units[0].text, expectedText);
    assert.deepEqual(
      proposal.scriptureReferenceSuggestions.map(item => item.bookHint),
      ['Eph']
    );
  }

  const document = await openPdf(buildUnicodePdf('2.0'));
  try {
    const bounded = await document.extractPageText(0, {
      maximumCharacters: 8
    });
    assert.equal(bounded.text, 'I. Мир ');
    assert.equal(bounded.truncated, true);
    assert.doesNotMatch(bounded.text, /[\ud800-\udbff]$/u);
  } finally {
    await document.close();
  }
});

test('enforces typed integrity, path, UTF-8, XML, unit, text, and suggestion limits', async () => {
  const ordinary = Buffer.from('I. Foundation\nEph 1:1', 'utf8');
  const metadata = sourceMetadata(ordinary);
  await assert.rejects(
    extractSermonSourceProposal(
      ordinary,
      { ...metadata, sizeBytes: ordinary.length + 1 }
    ),
    expectExtractionCode('SOURCE_SIZE_MISMATCH')
  );
  await assert.rejects(
    extractSermonSourceProposal(
      ordinary,
      { ...metadata, sha256: '0'.repeat(64) }
    ),
    expectExtractionCode('SOURCE_HASH_MISMATCH')
  );
  await assert.rejects(
    extractSermonSourceProposal(
      ordinary,
      { ...metadata, provenance: { sourcePath: '/private/sermon.txt' } }
    ),
    expectExtractionCode('LOCAL_PATH_NOT_ALLOWED')
  );

  const invalidUtf8 = Buffer.from([0xc3, 0x28]);
  await assert.rejects(
    extractSermonSourceProposal(invalidUtf8, sourceMetadata(invalidUtf8)),
    expectExtractionCode('SOURCE_TYPE_MISMATCH')
  );

  const unsafeDocx = await buildDocx(['I. Foundation'], {
    unsafeDocumentPrefix: '<!DOCTYPE document [<!ENTITY x "unsafe">]>'
  });
  await assert.rejects(
    extractSermonSourceProposal(unsafeDocx, sourceMetadata(unsafeDocx, {
      fileName: 'unsafe.docx',
      mediaType: MEDIA_TYPES.docx
    })),
    expectExtractionCode('CORRUPT_SOURCE')
  );

  const unsafePptx = await buildPptx([
    { part: 'ppt/slides/slide1.xml', lines: ['I. Foundation'] }
  ], {
    relationshipTarget: '../slides/slide1.xml'
  });
  await assert.rejects(
    extractSermonSourceProposal(unsafePptx, sourceMetadata(unsafePptx, {
      kind: 'slide-notes',
      fileName: 'unsafe.pptx',
      mediaType: MEDIA_TYPES.pptx
    })),
    expectExtractionCode('CORRUPT_SOURCE')
  );

  const manyReferences = Buffer.from(
    Array.from({ length: MAX_REFERENCE_SUGGESTIONS + 44 }, (_value, index) => (
      `Eph ${index + 1}:1`
    )).join('\n'),
    'utf8'
  );
  const referenceProposal = await extractSermonSourceProposal(
    manyReferences,
    sourceMetadata(manyReferences)
  );
  assert.equal(referenceProposal.scriptureReferenceSuggestions.length, MAX_REFERENCE_SUGGESTIONS);
  assert.equal(referenceProposal.truncated.scriptureReferences, true);

  const manyBlocks = Buffer.from(
    Array.from({ length: 130 }, (_value, index) => (
      `${String(index).padStart(3, '0')}-${'x'.repeat(13_000)}`
    )).join('\n\n'),
    'utf8'
  );
  const boundedProposal = await extractSermonSourceProposal(
    manyBlocks,
    sourceMetadata(manyBlocks)
  );
  assert.equal(boundedProposal.units.length, MAX_EXTRACTION_UNITS);
  assert.equal(boundedProposal.truncated.units, true);
  assert.equal(boundedProposal.truncated.text, true);

  const largePptx = await buildPptx([
    { part: 'ppt/slides/slide1.xml', lines: ['x'.repeat(MAX_UNIT_TEXT_CHARS + 100)] }
  ]);
  const largePptxProposal = await extractSermonSourceProposal(
    largePptx,
    sourceMetadata(largePptx, {
      kind: 'slide-notes',
      fileName: 'large.pptx',
      mediaType: MEDIA_TYPES.pptx
    })
  );
  assert.ok(largePptxProposal.units[0].text.length <= MAX_UNIT_TEXT_CHARS);
  assert.equal(largePptxProposal.units[0].truncated, true);
  assert.equal(largePptxProposal.truncated.text, true);

  const largeDocx = await buildDocx([
    'x'.repeat(MAX_TOTAL_TEXT_CHARS + 100)
  ]);
  const largeDocxProposal = await extractSermonSourceProposal(
    largeDocx,
    sourceMetadata(largeDocx, {
      fileName: 'large.docx',
      mediaType: MEDIA_TYPES.docx
    })
  );
  assert.ok(
    largeDocxProposal.units.reduce((sum, unit) => sum + unit.text.length, 0)
      <= MAX_TOTAL_TEXT_CHARS
  );
  assert.equal(largeDocxProposal.truncated.text, true);
});
