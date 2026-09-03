'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');

const JSZip = require('jszip');

const {
  CURRENT_SERVICE_SONG_DRAFT_PROVENANCE_KIND,
  CURRENT_SERVICE_SONG_REVIEW_CANDIDATE_KIND,
  CURRENT_SERVICE_SONG_SLIDES_KIND,
  CurrentServiceSongDraftError,
  buildPptxSongDraft,
  inspectPptxSongSlides,
  parseSongDocument,
  serializeSongDocument
} = require('../src/services/project');

function xmlEscape(value) {
  return String(value)
    .replace(/&/gu, '&amp;')
    .replace(/</gu, '&lt;')
    .replace(/>/gu, '&gt;')
    .replace(/"/gu, '&quot;')
    .replace(/'/gu, '&apos;');
}

function textRun(value, { color = null, preset = false } = {}) {
  const colorXml = color
    ? `<a:solidFill><a:${preset ? 'prstClr' : 'srgbClr'} val="${color}"/></a:solidFill>`
    : '';
  return `<a:r><a:rPr>${colorXml}</a:rPr><a:t>${xmlEscape(value)}</a:t></a:r>`;
}

function rawTextRun(xmlText, { color = null } = {}) {
  const colorXml = color
    ? `<a:solidFill><a:srgbClr val="${color}"/></a:solidFill>`
    : '';
  return `<a:r><a:rPr>${colorXml}</a:rPr><a:t>${xmlText}</a:t></a:r>`;
}

function paragraph(...runs) {
  return `<a:p>${runs.join('')}</a:p>`;
}

function slideXml(paragraphs, { prefix = '' } = {}) {
  return `${prefix}<?xml version="1.0" encoding="UTF-8"?>`
    + '<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" '
    + 'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">'
    + `<p:cSld><p:spTree>${paragraphs.join('')}</p:spTree></p:cSld>`
    + '</p:sld>';
}

function textShape({
  name,
  paragraphs,
  placeholderIndex = '',
  textBox = false
}) {
  const placeholder = placeholderIndex
    ? `<p:ph idx="${placeholderIndex}"/>`
    : '';
  return '<p:sp>'
    + '<p:nvSpPr>'
    + `<p:cNvPr id="2" name="${xmlEscape(name)}"/>`
    + `<p:cNvSpPr${textBox ? ' txBox="1"' : ''}/>`
    + `<p:nvPr>${placeholder}</p:nvPr>`
    + '</p:nvSpPr>'
    + `<p:txBody>${paragraphs.join('')}</p:txBody>`
    + '</p:sp>';
}

async function buildPptx(slides, {
  order = slides.map(slide => slide.part),
  targetOverrides = {}
} = {}) {
  const zip = new JSZip();
  for (const slide of slides) zip.file(slide.part, slide.xml);
  const slideIds = [];
  const relationships = [];
  for (const [index, part] of order.entries()) {
    const relationshipId = `rId${index + 1}`;
    slideIds.push(`<p:sldId id="${256 + index}" r:id="${relationshipId}"/>`);
    relationships.push(
      '<Relationship '
        + `Id="${relationshipId}" `
        + 'Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" '
        + `Target="${targetOverrides[index] || part.slice(4)}"/>`
    );
  }
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

async function buildOrderOnlyPptx(slideCount) {
  const zip = new JSZip();
  const slideIds = [];
  const relationships = [];
  for (let index = 0; index < slideCount; index += 1) {
    const relationshipId = `rId${index + 1}`;
    slideIds.push(`<p:sldId id="${256 + index}" r:id="${relationshipId}"/>`);
    relationships.push(
      '<Relationship '
        + `Id="${relationshipId}" `
        + 'Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" '
        + `Target="slides/slide${index + 1}.xml"/>`
    );
  }
  zip.file(
    'ppt/presentation.xml',
    '<p:presentation xmlns:p="urn:p" xmlns:r="urn:r">'
      + `<p:sldIdLst>${slideIds.join('')}</p:sldIdLst>`
      + '</p:presentation>'
  );
  zip.file(
    'ppt/_rels/presentation.xml.rels',
    `<Relationships>${relationships.join('')}</Relationships>`
  );
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

function forgeDeclaredUncompressedSize(buffer, entryName, declaredSize) {
  const forged = Buffer.from(buffer);
  const signature = Buffer.from([0x50, 0x4b, 0x01, 0x02]);
  let offset = 0;
  while ((offset = forged.indexOf(signature, offset)) !== -1) {
    const fileNameLength = forged.readUInt16LE(offset + 28);
    const extraLength = forged.readUInt16LE(offset + 30);
    const commentLength = forged.readUInt16LE(offset + 32);
    const fileName = forged
      .subarray(offset + 46, offset + 46 + fileNameLength)
      .toString('utf8');
    if (fileName === entryName) {
      forged.writeUInt32LE(declaredSize, offset + 24);
      const localOffset = forged.readUInt32LE(offset + 42);
      assert.equal(forged.readUInt32LE(localOffset), 0x04034b50);
      forged.writeUInt32LE(declaredSize, localOffset + 22);
      return forged;
    }
    offset += 46 + fileNameLength + extraLength + commentLength;
  }
  throw new Error(`ZIP entry ${entryName} was not found.`);
}

function forgeZipEntryCount(buffer, entryCount) {
  const forged = Buffer.from(buffer);
  const signature = Buffer.from([0x50, 0x4b, 0x05, 0x06]);
  const offset = forged.lastIndexOf(signature);
  if (offset < 0) throw new Error('ZIP end-of-central-directory was not found.');
  forged.writeUInt16LE(entryCount, offset + 8);
  forged.writeUInt16LE(entryCount, offset + 10);
  return forged;
}

async function expectCode(promise, code) {
  await assert.rejects(
    promise,
    error => error instanceof CurrentServiceSongDraftError && error.code === code
  );
}

test('inspection follows presentation order and exposes exact all, white, and yellow lanes', async () => {
  const entityText = 'Faith & <hope> 😀';
  const slides = [
    {
      part: 'ppt/slides/slide1.xml',
      xml: slideXml([paragraph(textRun('Physical slide one', { color: 'FFFFFF' }))])
    },
    {
      part: 'ppt/slides/slide7.xml',
      xml: slideXml([
        paragraph(rawTextRun('Faith &amp; &lt;hope&gt; &#x1F600;', { color: 'FFFFFF' })),
        paragraph(textRun('Preset white', { color: 'white', preset: true })),
        paragraph(textRun('Жёлтый текст', { color: 'FFFF00' })),
        paragraph(textRun('Inherited theme text'))
      ])
    }
  ];
  const buffer = await buildPptx(slides, {
    order: ['ppt/slides/slide7.xml', 'ppt/slides/slide1.xml']
  });

  const inspected = await inspectPptxSongSlides(buffer);

  assert.deepEqual(Object.keys(inspected), [
    'schemaVersion',
    'kind',
    'deckSha256',
    'slideCount',
    'slides',
    'candidates'
  ]);
  assert.equal(inspected.schemaVersion, 1);
  assert.equal(inspected.kind, CURRENT_SERVICE_SONG_SLIDES_KIND);
  assert.equal(
    inspected.deckSha256,
    crypto.createHash('sha256').update(buffer).digest('hex')
  );
  assert.equal(inspected.slideCount, 2);
  assert.deepEqual(Object.keys(inspected.slides[0]), ['number', 'lanes']);
  assert.deepEqual(Object.keys(inspected.slides[0].lanes), ['all', 'white', 'yellow']);
  assert.deepEqual(Object.keys(inspected.slides[0].lanes.white), [
    'lines',
    'preview',
    'lineCount'
  ]);
  assert.deepEqual(inspected.slides[0].lanes.all.lines, [
    entityText,
    'Preset white',
    'Жёлтый текст',
    'Inherited theme text'
  ]);
  assert.deepEqual(inspected.slides[0].lanes.white.lines, [
    entityText,
    'Preset white'
  ]);
  assert.deepEqual(inspected.slides[0].lanes.yellow.lines, ['Жёлтый текст']);
  assert.equal(inspected.slides[0].lanes.white.preview, `${entityText}\nPreset white`);
  assert.equal(inspected.slides[0].lanes.white.lineCount, 2);
  assert.deepEqual(
    inspected.slides[1].lanes.all.lines,
    ['Physical slide one']
  );
  assert.deepEqual(inspected.candidates, []);
});

test('inspection suggests only exact template title and lyric shape runs', async () => {
  const titleShape = textShape({
    name: 'Content Placeholder 2',
    placeholderIndex: '1',
    paragraphs: [
      paragraph(textRun('Reviewed title')),
      paragraph(textRun('Possible alternate title'))
    ]
  });
  const body = text => textShape({
    name: 'TextBox 3',
    textBox: true,
    paragraphs: [paragraph(textRun(text, { color: 'FFFFFF' }))]
  });
  const unrelatedTitle = textShape({
    name: 'TextBox 4',
    textBox: true,
    paragraphs: [paragraph(textRun('John 3:16'))]
  });
  const buffer = await buildPptx([
    {
      part: 'ppt/slides/slide1.xml',
      xml: slideXml([unrelatedTitle])
    },
    {
      part: 'ppt/slides/slide2.xml',
      xml: slideXml([titleShape])
    },
    {
      part: 'ppt/slides/slide3.xml',
      xml: slideXml([body('First lyric')])
    },
    {
      part: 'ppt/slides/slide4.xml',
      xml: slideXml([body('Second lyric')])
    },
    {
      part: 'ppt/slides/slide5.xml',
      xml: slideXml([])
    }
  ]);

  const inspected = await inspectPptxSongSlides(buffer);

  assert.deepEqual(inspected.candidates, [{
    id: 'slides-2-3-4',
    kind: CURRENT_SERVICE_SONG_REVIEW_CANDIDATE_KIND,
    titleSlide: 2,
    startSlide: 3,
    endSlide: 4,
    evidence: {
      kind: 'template-text-shape-run',
      bodySlideCount: 2,
      titleShapeName: 'Content Placeholder 2',
      titlePlaceholderIndex: '1',
      bodyShapeName: 'TextBox 3'
    }
  }]);
  assert.equal(Object.isFrozen(inspected.candidates), true);
  assert.equal(Object.isFrozen(inspected.candidates[0].evidence), true);
});

test('inspection exposes the complete bounded lane text used by draft build', async () => {
  const completeLine = `${'Long reviewed lyric '.repeat(25)}😀`;
  assert.ok(completeLine.length > 400);
  const buffer = await buildPptx([{
    part: 'ppt/slides/slide1.xml',
    xml: slideXml([paragraph(textRun(completeLine, { color: 'FFFFFF' }))])
  }]);

  const inspected = await inspectPptxSongSlides(buffer);
  assert.equal(inspected.slides[0].lanes.white.preview, completeLine);

  const draft = await buildPptxSongDraft(buffer, {
    slideNumbers: [1],
    lane: 'white',
    title: 'Complete Preview',
    language: 'en',
    sourceLabel: 'Verified service deck'
  });
  assert.deepEqual(
    draft.song.sections[0].slides[0].lines,
    [completeLine]
  );
});

test('draft supports increasing noncontiguous selections and preserves every source slide as P1/P2', async () => {
  const slides = [
    {
      part: 'ppt/slides/slide1.xml',
      xml: slideXml([
        paragraph(textRun('First source line', { color: 'FFFFFF' })),
        paragraph(textRun('First translated line', { color: 'FFFF00' }))
      ])
    },
    {
      part: 'ppt/slides/slide2.xml',
      xml: slideXml([paragraph(textRun('Not selected', { color: 'FFFFFF' }))])
    },
    {
      part: 'ppt/slides/slide3.xml',
      xml: slideXml([
        paragraph(textRun('Second source line', { color: 'FFFFFF' })),
        paragraph(textRun('Second translated line', { color: 'FFFF00' }))
      ])
    }
  ];
  const buffer = await buildPptx(slides);

  const draft = await buildPptxSongDraft(buffer, {
    slideNumbers: [1, 3],
    lane: 'white',
    title: 'Reviewed Song',
    language: 'en',
    sourceLabel: '07-26-2026 Service ENG.pptx'
  });

  assert.deepEqual(Object.keys(draft), ['song', 'warnings', 'provenance']);
  assert.deepEqual(Object.keys(draft.song), [
    'schemaVersion',
    'id',
    'title',
    'language',
    'translationOf',
    'license',
    'tags',
    'authors',
    'translators',
    'composers',
    'source',
    'attribution',
    'extraMetadata',
    'sections'
  ]);
  assert.equal(draft.song.id, 'reviewed-song');
  assert.equal(draft.song.title, 'Reviewed Song');
  assert.equal(draft.song.language, 'en');
  assert.equal(draft.song.translationOf, null);
  assert.equal(draft.song.license, '');
  assert.deepEqual(draft.song.authors, []);
  assert.deepEqual(draft.song.translators, []);
  assert.deepEqual(draft.song.composers, []);
  assert.equal(draft.song.attribution, '');
  assert.equal(draft.song.source, '07-26-2026 Service ENG.pptx');
  assert.deepEqual(draft.song.extraMetadata, {
    syncshow_capture_kind: 'current-service-pptx',
    syncshow_capture_deck_sha256:
      crypto.createHash('sha256').update(buffer).digest('hex'),
    syncshow_capture_deck_slides: '3',
    syncshow_capture_selected_slides: '1,3',
    syncshow_capture_text_sha256: crypto
      .createHash('sha256')
      .update(JSON.stringify([
        ['First source line'],
        ['Second source line']
      ]))
      .digest('hex'),
    syncshow_capture_text_lane: 'white',
    syncshow_capture_slide_lanes: '1:w,3:w'
  });
  assert.deepEqual(
    draft.song.sections.map(section => ({
      id: section.id,
      marker: section.marker,
      label: section.label,
      slideCount: section.slides.length,
      lines: section.slides[0].lines
    })),
    [
      {
        id: 'p1',
        marker: 'P1',
        label: 'P1',
        slideCount: 1,
        lines: ['First source line']
      },
      {
        id: 'p2',
        marker: 'P2',
        label: 'P2',
        slideCount: 1,
        lines: ['Second source line']
      }
    ]
  );
  assert.deepEqual(
    draft.warnings.map(warning => warning.code),
    ['PROVISIONAL_SECTION_LABELS', 'CREDITS_AND_RIGHTS_NOT_INFERRED']
  );
  assert.deepEqual(Object.keys(draft.warnings[0]), ['code', 'message']);
  assert.deepEqual(Object.keys(draft.provenance), [
    'schemaVersion',
    'kind',
    'deckSha256',
    'deckSlideCount',
    'slideNumbers',
    'textSha256',
    'lane',
    'slideLanes',
    'sourceLabel'
  ]);
  assert.equal(draft.provenance.kind, CURRENT_SERVICE_SONG_DRAFT_PROVENANCE_KIND);
  assert.equal(draft.provenance.deckSlideCount, 3);
  assert.deepEqual(draft.provenance.slideNumbers, [1, 3]);
  assert.equal(
    draft.provenance.textSha256,
    draft.song.extraMetadata.syncshow_capture_text_sha256
  );
  assert.equal(draft.provenance.lane, 'white');
  assert.deepEqual(draft.provenance.slideLanes, ['white', 'white']);

  const roundTripped = parseSongDocument(
    serializeSongDocument(draft.song),
    { fileName: 'reviewed-song.md' }
  );
  assert.deepEqual(
    roundTripped.sections.map(section => section.slides[0].lines),
    [['First source line'], ['Second source line']]
  );
  assert.deepEqual(roundTripped.extraMetadata, draft.song.extraMetadata);

  const mixedLanes = await buildPptxSongDraft(buffer, {
    slideNumbers: [1, 3],
    slideLanes: ['white', 'yellow'],
    lane: 'white',
    title: 'Reviewed Mixed Lanes',
    language: 'en',
    sourceLabel: '07-26-2026 Service ENG.pptx'
  });
  assert.deepEqual(
    mixedLanes.song.sections.map(section => section.slides[0].lines),
    [['First source line'], ['Second translated line']]
  );
  assert.equal(mixedLanes.song.extraMetadata.syncshow_capture_text_lane, 'per-slide');
  assert.equal(mixedLanes.song.extraMetadata.syncshow_capture_slide_lanes, '1:w,3:y');
  assert.notEqual(
    mixedLanes.provenance.textSha256,
    draft.provenance.textSha256
  );
  assert.equal(mixedLanes.provenance.lane, 'per-slide');
  assert.deepEqual(mixedLanes.provenance.slideLanes, ['white', 'yellow']);
  assert.equal(
    mixedLanes.warnings.some(warning => warning.code === 'PER_SLIDE_TEXT_LANES'),
    true
  );
});

test('inspection and draft results are deeply immutable', async () => {
  const buffer = await buildPptx([{
    part: 'ppt/slides/slide1.xml',
    xml: slideXml([paragraph(textRun('Immutable lyric', { color: 'FFFFFF' }))])
  }]);
  const inspected = await inspectPptxSongSlides(buffer);
  const draft = await buildPptxSongDraft(buffer, {
    slideNumbers: [1],
    lane: 'white',
    title: 'Immutable Song',
    language: 'en',
    sourceLabel: 'Verified service deck'
  });

  for (const value of [
    inspected,
    inspected.slides,
    inspected.slides[0],
    inspected.slides[0].lanes,
    inspected.slides[0].lanes.white,
    inspected.slides[0].lanes.white.lines,
    draft,
    draft.song,
    draft.song.sections,
    draft.song.sections[0],
    draft.song.sections[0].slides,
    draft.song.sections[0].slides[0].lines,
    draft.warnings,
    draft.warnings[0],
    draft.provenance,
    draft.provenance.slideNumbers,
    draft.provenance.slideLanes
  ]) {
    assert.equal(Object.isFrozen(value), true);
  }
  assert.throws(() => inspected.slides.push({}), TypeError);
  assert.throws(() => draft.song.sections[0].slides[0].lines[0] = 'Changed', TypeError);
});

test('draft rejects empty lanes, unsupported option keys, and ambiguous source order', async () => {
  const buffer = await buildPptx([{
    part: 'ppt/slides/slide1.xml',
    xml: slideXml([paragraph(textRun('White only', { color: 'FFFFFF' }))])
  }]);
  const validOptions = {
    slideNumbers: [1],
    lane: 'white',
    title: 'Reviewed Song',
    language: 'en',
    sourceLabel: 'Verified service deck'
  };

  await expectCode(
    buildPptxSongDraft(buffer, { ...validOptions, lane: 'yellow' }),
    'EMPTY_SELECTED_LANE'
  );
  await expectCode(
    buildPptxSongDraft(buffer, { ...validOptions, extra: true }),
    'INVALID_DRAFT_OPTIONS'
  );
  await expectCode(
    buildPptxSongDraft(buffer, { ...validOptions, slideNumbers: [1, 1] }),
    'INVALID_SLIDE_SELECTION'
  );
  await expectCode(
    buildPptxSongDraft(buffer, { ...validOptions, slideNumbers: [2, 1] }),
    'INVALID_SLIDE_SELECTION'
  );
  await expectCode(
    buildPptxSongDraft(buffer, { ...validOptions, slideNumbers: [2] }),
    'INVALID_SLIDE_SELECTION'
  );
  await expectCode(
    buildPptxSongDraft(buffer, { ...validOptions, slideLanes: [] }),
    'INVALID_DRAFT_OPTIONS'
  );
  await expectCode(
    buildPptxSongDraft(buffer, {
      ...validOptions,
      slideLanes: ['blue']
    }),
    'INVALID_DRAFT_OPTIONS'
  );
  await expectCode(
    buildPptxSongDraft(buffer, {
      ...validOptions,
      slideNumbers: Array.from({ length: 201 }, (_value, index) => index + 1)
    }),
    'INVALID_SLIDE_SELECTION'
  );
});

test('corrupt, unsafe, and oversized PowerPoint sources fail closed', async () => {
  await expectCode(
    inspectPptxSongSlides(Buffer.from('not a PowerPoint package')),
    'CORRUPT_PPTX'
  );

  const ordinarySlide = {
    part: 'ppt/slides/slide1.xml',
    xml: slideXml([paragraph(textRun('Safe lyric', { color: 'FFFFFF' }))])
  };
  const traversal = await buildPptx([ordinarySlide], {
    targetOverrides: { 0: '../slides/slide1.xml' }
  });
  await expectCode(inspectPptxSongSlides(traversal), 'UNSAFE_PPTX');

  const unsafeXml = await buildPptx([{
    part: 'ppt/slides/slide1.xml',
    xml: slideXml(
      [paragraph(textRun('Unsafe lyric', { color: 'FFFFFF' }))],
      { prefix: '<!DOCTYPE x [<!ENTITY secret "nope">]>' }
    )
  }]);
  await expectCode(inspectPptxSongSlides(unsafeXml), 'UNSAFE_PPTX');

  const oversizedXml = await buildPptx([{
    part: 'ppt/slides/slide1.xml',
    xml: slideXml([
      paragraph(textRun('x'.repeat((16 * 1024 * 1024) + 1), { color: 'FFFFFF' }))
    ])
  }]);
  await expectCode(inspectPptxSongSlides(oversizedXml), 'PPTX_XML_TOO_LARGE');
  const forgedSize = forgeDeclaredUncompressedSize(
    oversizedXml,
    'ppt/slides/slide1.xml',
    1
  );
  await expectCode(inspectPptxSongSlides(forgedSize), 'PPTX_XML_TOO_LARGE');
  await expectCode(
    inspectPptxSongSlides(forgeZipEntryCount(oversizedXml, 10_001)),
    'PPTX_TOO_LARGE'
  );

  const tooManySlides = await buildOrderOnlyPptx(1_001);
  await expectCode(inspectPptxSongSlides(tooManySlides), 'PPTX_TOO_MANY_SLIDES');

  const tooMuchSlideText = await buildPptx([{
    part: 'ppt/slides/slide1.xml',
    xml: slideXml([
      paragraph(textRun('x'.repeat(32_001), { color: 'FFFFFF' }))
    ])
  }]);
  await expectCode(inspectPptxSongSlides(tooMuchSlideText), 'PPTX_TEXT_TOO_LARGE');
});
