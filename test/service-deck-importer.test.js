'use strict';

const assert = require('node:assert/strict');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const test = require('node:test');

const JSZip = require('jszip');
const sharp = require('sharp');

const {
  compileServiceProject,
  LocalSongLibrary,
  OUTPUT_ONLY_SONG_PROVIDER,
  reachableSongResources,
  ServiceProjectStore
} = require('../src/services/project');
const {
  PptxDeckExtractor,
  ServiceDeckImportError,
  assertSafeOutputRoot,
  buildImportPlan,
  extractParagraphsFromSlideXml,
  extractStyledParagraphsFromSlideXml,
  importServiceDecks,
  normalizeExtractedSongText,
  projectedStyledTextFromParagraphs,
  projectedTextFromParagraphs,
  resolveSafeOutputRoot
} = require('../scripts/lib/service-deck-importer');

async function tempDirectory(t, prefix = 'syncshow-deck-import-') {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return fs.realpath(directory);
}

function xmlText(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function slideXml(lines, options = {}) {
  const background = options.image
    ? '<p:bg><p:bgPr><a:blipFill><a:blip r:embed="rIdImage"/></a:blipFill></p:bgPr></p:bg>'
    : '';
  const paragraphs = lines.map(line => {
    const runs = String(line).split('\n').map((part, index) =>
      `${index > 0 ? '<a:br/>' : ''}<a:r><a:t>${xmlText(part)}</a:t></a:r>`).join('');
    return `<a:p>${runs}</a:p>`;
  }).join('');
  return [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    '<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"',
    ' xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"',
    ' xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">',
    `<p:cSld>${background}<p:spTree><p:sp><p:txBody>${paragraphs}</p:txBody></p:sp></p:spTree></p:cSld>`,
    '</p:sld>'
  ].join('');
}

function coloredSlideXml() {
  return [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    '<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"',
    ' xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"',
    ' xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">',
    '<p:cSld><p:spTree><p:sp><p:txBody><a:p>',
    '<a:r><a:rPr><a:solidFill><a:srgbClr val="FFFFFF"/></a:solidFill></a:rPr><a:t>Primary first</a:t></a:r>',
    '<a:br/>',
    '<a:r><a:rPr><a:solidFill><a:srgbClr val="FFFF00"/></a:solidFill></a:rPr><a:t>Secondary first</a:t></a:r>',
    '<a:br/>',
    '<a:r><a:rPr><a:solidFill><a:prstClr val="white"/></a:solidFill></a:rPr><a:t>Primary second</a:t></a:r>',
    '<a:br/>',
    '<a:r><a:rPr><a:solidFill><a:srgbClr val="FFFF00"/></a:solidFill></a:rPr><a:t>Secondary second</a:t></a:r>',
    '</a:p></p:txBody></p:sp></p:spTree></p:cSld>',
    '</p:sld>'
  ].join('');
}

function emphasizedSermonSlideXml() {
  return [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    '<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"',
    ' xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"',
    ' xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">',
    '<p:cSld><p:spTree><p:sp><p:txBody>',
    '<a:p>',
    '<a:r><a:rPr b="1"><a:solidFill><a:srgbClr val="FFC000"/></a:solidFill></a:rPr><a:t>Sermon Heading</a:t></a:r>',
    '</a:p>',
    '<a:p>',
    '<a:r><a:rPr b="1"><a:solidFill><a:srgbClr val="FFC000"/></a:solidFill></a:rPr><a:t>Eph. 3:9</a:t></a:r>',
    '<a:r><a:rPr><a:solidFill><a:srgbClr val="FFC000"/></a:solidFill></a:rPr><a:t> </a:t></a:r>',
    '<a:r><a:rPr><a:solidFill><a:srgbClr val="FFFFFF"/></a:solidFill></a:rPr><a:t>literal &lt;span&gt;&amp; </a:t></a:r>',
    '<a:r><a:rPr><a:solidFill><a:srgbClr val="FFC000"/></a:solidFill></a:rPr><a:t>mystery</a:t></a:r>',
    '<a:r><a:rPr><a:solidFill><a:srgbClr val="FFFFFF"/></a:solidFill></a:rPr><a:t>.</a:t></a:r>',
    '</a:p>',
    '<a:p>',
    '<a:r><a:rPr><a:solidFill><a:srgbClr val="FFFFFF"/></a:solidFill></a:rPr><a:t>God gives </a:t></a:r>',
    '<a:r><a:rPr b="0"><a:solidFill><a:srgbClr val="FFC000"/></a:solidFill></a:rPr><a:t>administration</a:t></a:r>',
    '</a:p>',
    '</p:txBody></p:sp></p:spTree></p:cSld>',
    '</p:sld>'
  ].join('');
}

function superscriptVerseSlideXml() {
  return [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    '<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"',
    ' xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"',
    ' xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">',
    '<p:cSld><p:spTree><p:sp><p:txBody>',
    '<a:p>',
    '<a:r><a:rPr baseline="30000"/><a:t>14</a:t></a:r>',
    '<a:r><a:t>Который</a:t></a:r>',
    '<a:r><a:t> </a:t></a:r>',
    '<a:r><a:rPr baseline="-25000"/><a:t>2</a:t></a:r>',
    '<a:r><a:t>Lowered</a:t></a:r>',
    '<a:r><a:t> </a:t></a:r>',
    '<a:r><a:rPr baseline="30000"/><a:t>3</a:t></a:r>',
    '<a:r><a:t>.</a:t></a:r>',
    '<a:r><a:t> </a:t></a:r>',
    '<a:r><a:rPr baseline="30000"/><a:t>4</a:t></a:r>',
    '<a:r><a:t> Already spaced</a:t></a:r>',
    '</a:p>',
    '<a:p>',
    '<a:r><a:rPr baseline="30000"/><a:t>13</a:t></a:r>',
    '<a:r><a:t>In Him</a:t></a:r>',
    '</a:p>',
    '</p:txBody></p:sp></p:spTree></p:cSld>',
    '</p:sld>'
  ].join('');
}

function sermonManifest(options = {}) {
  const result = manifest();
  result.items = [{
    id: 'fixture-sermon',
    kind: 'sermon',
    title: 'Fixture Sermon',
    presetId: 'sermon-notes',
    ...(options.emphasisColors === undefined
      ? {}
      : { emphasisColors: options.emphasisColors }),
    channels: {
      primary: {
        deck: 'rus',
        slides: 1,
        title: 'Configured sermon heading'
      }
    }
  }];
  return result;
}

async function writeFixtureDeck(filePath, options = {}) {
  const zip = new JSZip();
  const picture = await sharp({
    create: {
      width: 4,
      height: 3,
      channels: 3,
      background: options.pictureColor || '#345678'
    }
  }).png().toBuffer();
  // The physical part numbers intentionally disagree with the presentation
  // order so the fixture catches importers that assume slideN.xml is ordinal N.
  zip.file('ppt/presentation.xml', [
    '<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"',
    ' xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">',
    '<p:sldIdLst>',
    '<p:sldId id="256" r:id="rIdFirst"/>',
    '<p:sldId id="257" r:id="rIdSecond"/>',
    '</p:sldIdLst>',
    '</p:presentation>'
  ].join(''));
  zip.file('ppt/_rels/presentation.xml.rels', [
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">',
    '<Relationship Id="rIdFirst" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide2.xml"/>',
    '<Relationship Id="rIdSecond" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide1.xml"/>',
    '</Relationships>'
  ].join(''));
  zip.file(
    'ppt/slides/slide2.xml',
    options.firstSlideXml || slideXml(options.lines || ['Fixture line one\nFixture line two'])
  );
  zip.file('ppt/slides/slide1.xml', slideXml(['Fixture picture'], { image: true }));
  zip.file('ppt/slides/_rels/slide1.xml.rels', [
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">',
    '<Relationship Id="rIdImage" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/fixture.png"/>',
    '</Relationships>'
  ].join(''));
  zip.file('ppt/media/fixture.png', picture);
  await fs.writeFile(filePath, await zip.generateAsync({ type: 'nodebuffer' }));
}

function manifest() {
  return {
    schemaVersion: 1,
    project: {
      id: 'fixture-service',
      title: 'Fixture Service',
      serviceDate: '2026-07-26',
      preferredProfileId: 'default',
      channels: [
        { id: 'primary', label: 'Primary', language: 'ru' },
        { id: 'secondary', label: 'Secondary', language: 'en' },
        { id: 'media', label: 'Singers', language: 'ru' }
      ]
    },
    items: [
      {
        id: 'worship',
        kind: 'group',
        title: 'Worship',
        groupKind: 'section'
      },
      {
        id: 'worship-songs',
        kind: 'group',
        title: 'Songs',
        groupKind: 'section',
        parentId: 'worship'
      },
      {
        id: 'fixture-song-item',
        kind: 'song',
        title: 'Fixture Song',
        parentId: 'worship-songs',
        primaryChannelId: 'primary',
        channels: {
          primary: {
            deck: 'rus',
            song: {
              id: 'fixture-song',
              title: 'Fixture Song',
              language: 'ru'
            }
          },
          secondary: {
            deck: 'eng',
            song: {
              id: 'fixture-song-en',
              title: 'Fixture Song',
              language: 'en'
            }
          },
          media: {
            mode: 'derive',
            from: 'primary',
            maxLines: 2
          }
        },
        sections: [
          {
            id: 'verse-1',
            marker: '1',
            label: 'Verse 1',
            slides: {
              rus: 1,
              eng: 1
            }
          }
        ]
      },
      {
        id: 'localized-intro',
        kind: 'picture',
        title: 'Localized intro',
        parentId: 'worship',
        slide: 2,
        altText: 'A generated fixture background',
        channels: {
          primary: { deck: 'rus' },
          secondary: { deck: 'eng' }
        }
      }
    ]
  };
}

function expectImportCode(code) {
  return error => {
    assert.ok(error instanceof ServiceDeckImportError);
    assert.equal(error.code, code);
    return true;
  };
}

test('PPTX extraction follows presentation order and reads embedded images without rendering', async t => {
  const root = await tempDirectory(t);
  const deckPath = path.join(root, 'fixture.pptx');
  await writeFixtureDeck(deckPath);

  assert.equal(PptxDeckExtractor.prototype.extractSlideStyledText.length, 2);
  const extractor = await PptxDeckExtractor.open(deckPath);
  assert.equal(extractor.slideCount, 2);
  assert.deepEqual(await extractor.extractSlideText(1), ['Fixture line one\nFixture line two']);
  const image = await extractor.extractSlideImage(2);
  assert.equal(image.format, 'png');
  assert.ok(image.buffer.length > 0);
});

test('run-color filtering separates white and yellow text without manifest content', async t => {
  const xml = coloredSlideXml();
  assert.deepEqual(
    extractParagraphsFromSlideXml(xml, { includeColors: ['#FFFFFF'] }),
    ['Primary first\nPrimary second']
  );
  assert.deepEqual(
    extractParagraphsFromSlideXml(xml, { includeColors: ['#FFFF00'] }),
    ['Secondary first\nSecondary second']
  );
  assert.deepEqual(
    extractParagraphsFromSlideXml(xml, { excludeColors: ['#FFFF00'] }),
    ['Primary first\nPrimary second']
  );

  const root = await tempDirectory(t);
  const deckPath = path.join(root, 'bilingual.pptx');
  const outputRoot = path.join(root, 'color-output');
  await writeFixtureDeck(deckPath, { firstSlideXml: xml });
  const filteredManifest = manifest();
  filteredManifest.items = filteredManifest.items.slice(0, 3);
  const filteredSong = filteredManifest.items.find(item => item.id === 'fixture-song-item');
  filteredSong.channels.primary.includeColors = ['#FFFFFF'];
  filteredSong.channels.secondary.includeColors = ['#FFFF00'];
  const result = await importServiceDecks({
    manifest: filteredManifest,
    decks: { rus: deckPath, eng: deckPath },
    dryRun: false,
    outputRoot
  });
  assert.equal(result.applied.project.imported, true);

  const library = new LocalSongLibrary({ rootPath: path.join(outputRoot, 'song-library') });
  assert.deepEqual(
    (await library.read('fixture-song')).song.sections[0].slides[0].lines,
    ['Primary first', 'Primary second']
  );
  assert.deepEqual(
    (await library.read('fixture-song-en')).song.sections[0].slides[0].lines,
    ['Secondary first', 'Secondary second']
  );
});

test('opt-in Ukrainian homoglyph normalization is narrow, counted, and deterministic', async () => {
  assert.deepEqual(
    normalizeExtractedSongText(
      'O, Tвoє cлoвo i Jesus Christ',
      'ukrainian-cyrillic-homoglyphs-v1'
    ),
    {
      text: 'О, Твоє слово і Jesus Christ',
      replacementCount: 7
    }
  );
  assert.deepEqual(
    normalizeExtractedSongText('Only Jesus', undefined),
    { text: 'Only Jesus', replacementCount: 0 }
  );
  assert.deepEqual(
    normalizeExtractedSongText(
      'Only Jesus',
      'ukrainian-cyrillic-homoglyphs-v1'
    ),
    { text: 'Only Jesus', replacementCount: 0 }
  );
  assert.throws(
    () => normalizeExtractedSongText('Text', 'guess-everything'),
    expectImportCode('INVALID_TEXT_NORMALIZATION')
  );

  const normalizedManifest = manifest();
  normalizedManifest.items = normalizedManifest.items.slice(0, 3);
  const songItem = normalizedManifest.items.find(item => item.id === 'fixture-song-item');
  songItem.channels.primary.textNormalization = 'ukrainian-cyrillic-homoglyphs-v1';
  const fakeExtractor = {
    slideCount: 1,
    async extractSlideText(_slideNumber, options) {
      return options.includeColors?.includes('#FFFF00')
        ? ['Only Jesus']
        : ['Tвoє cлoвo i'];
    },
    async extractSlideImage() {
      throw new Error('No image expected');
    }
  };
  const plan = await buildImportPlan({
    manifest: normalizedManifest,
    decks: { rus: '/fixtures/rus.pptx', eng: '/fixtures/eng.pptx' },
    extractorFactory: async () => fakeExtractor
  });
  const primaryResourceId = plan.project.items['fixture-song-item'].variants.primary.resourceId;
  assert.deepEqual(
    plan.project.resources[primaryResourceId].document.sections[0].slides[0].lines,
    ['Твоє слово і']
  );
  assert.equal(plan.summary.extracted.normalizedCharacters, 6);
  assert.deepEqual(plan.summary.extracted.normalizedCharactersByScope, {
    'fixture-song-item:primary:ukrainian-cyrillic-homoglyphs-v1': 6
  });
});

test('generic Cyrillic homoglyph normalization touches only lookalikes inside Cyrillic tokens', async () => {
  assert.deepEqual(
    normalizeExtractedSongText(
      'Cердце телo Твоeй Oмывшая Only Jesus O C e аs',
      'cyrillic-homoglyphs-v1'
    ),
    {
      text: 'Сердце тело Твоей Омывшая Only Jesus O C e аs',
      replacementCount: 4
    }
  );
  assert.deepEqual(
    normalizeExtractedSongText('Only Jesus and O Come', 'cyrillic-homoglyphs-v1'),
    { text: 'Only Jesus and O Come', replacementCount: 0 }
  );
  assert.deepEqual(
    normalizeExtractedSongText('O C e', 'cyrillic-homoglyphs-v1'),
    { text: 'O C e', replacementCount: 0 }
  );

  const normalizedManifest = manifest();
  normalizedManifest.items = normalizedManifest.items.slice(0, 3);
  const songItem = normalizedManifest.items.find(item => item.id === 'fixture-song-item');
  songItem.channels.primary.textNormalization = 'cyrillic-homoglyphs-v1';
  const fakeExtractor = {
    slideCount: 1,
    async extractSlideText(_slideNumber, options) {
      return options.includeColors?.includes('#FFFF00')
        ? ['Only Jesus']
        : ['Cердце телo'];
    },
    async extractSlideImage() {
      throw new Error('No image expected');
    }
  };
  const plan = await buildImportPlan({
    manifest: normalizedManifest,
    decks: { rus: '/fixtures/rus.pptx', eng: '/fixtures/eng.pptx' },
    extractorFactory: async () => fakeExtractor
  });
  const primaryResourceId = plan.project.items['fixture-song-item'].variants.primary.resourceId;
  assert.deepEqual(
    plan.project.resources[primaryResourceId].document.sections[0].slides[0].lines,
    ['Сердце тело']
  );
  assert.equal(plan.summary.extracted.normalizedCharacters, 2);
  assert.deepEqual(plan.summary.extracted.normalizedCharactersByScope, {
    'fixture-song-item:primary:cyrillic-homoglyphs-v1': 2
  });
});

test('Latin homoglyph normalization touches only Cyrillic lookalikes inside Latin tokens', async () => {
  assert.deepEqual(
    normalizeExtractedSongText(
      'аs Only Jesus а с е о р х',
      'latin-homoglyphs-v1'
    ),
    {
      text: 'as Only Jesus а с е о р х',
      replacementCount: 1
    }
  );
  assert.deepEqual(
    normalizeExtractedSongText('Русский текст', 'latin-homoglyphs-v1'),
    { text: 'Русский текст', replacementCount: 0 }
  );
  assert.deepEqual(
    normalizeExtractedSongText('а с е о р х', 'latin-homoglyphs-v1'),
    { text: 'а с е о р х', replacementCount: 0 }
  );

  const normalizedManifest = manifest();
  normalizedManifest.items = normalizedManifest.items.slice(0, 3);
  const songItem = normalizedManifest.items.find(item => item.id === 'fixture-song-item');
  songItem.channels.secondary.textNormalization = 'latin-homoglyphs-v1';
  const plan = await buildImportPlan({
    manifest: normalizedManifest,
    decks: { rus: '/fixtures/rus.pptx', eng: '/fixtures/eng.pptx' },
    extractorFactory: async (_filePath, deckKey) => ({
      slideCount: 1,
      async extractSlideText() {
        return deckKey === 'eng' ? ['аs we sing'] : ['Русский текст'];
      },
      async extractSlideImage() {
        throw new Error('No image expected');
      }
    })
  });
  const secondaryResourceId =
    plan.project.items['fixture-song-item'].variants.secondary.resourceId;
  assert.deepEqual(
    plan.project.resources[secondaryResourceId].document.sections[0].slides[0].lines,
    ['as we sing']
  );
  assert.equal(plan.summary.extracted.normalizedCharacters, 1);
  assert.deepEqual(plan.summary.extracted.normalizedCharactersByScope, {
    'fixture-song-item:secondary:latin-homoglyphs-v1': 1
  });
});

test('repeat-marker normalization changes only a standalone Cyrillic suffix marker', async () => {
  assert.deepEqual(
    normalizeExtractedSongText('Repeat х 2', 'repeat-marker-multiplication-v1'),
    { text: 'Repeat × 2', replacementCount: 1 }
  );
  assert.deepEqual(
    normalizeExtractedSongText('х 2', 'repeat-marker-multiplication-v1'),
    { text: '× 2', replacementCount: 1 }
  );
  for (const unchanged of [
    'текстовых 2',
    'Repeat х 3',
    'Repeat х2',
    'Repeat х 2 more',
    'Repeat х',
    'Repeat x 2'
  ]) {
    assert.deepEqual(
      normalizeExtractedSongText(unchanged, 'repeat-marker-multiplication-v1'),
      { text: unchanged, replacementCount: 0 }
    );
  }

  const normalizedManifest = manifest();
  normalizedManifest.items = normalizedManifest.items.slice(0, 3);
  const songItem = normalizedManifest.items.find(item => item.id === 'fixture-song-item');
  songItem.channels.secondary.textNormalization = 'repeat-marker-multiplication-v1';
  const plan = await buildImportPlan({
    manifest: normalizedManifest,
    decks: { rus: '/fixtures/rus.pptx', eng: '/fixtures/eng.pptx' },
    extractorFactory: async (_filePath, deckKey) => ({
      slideCount: 1,
      async extractSlideText() {
        return deckKey === 'eng' ? ['Repeat х 2'] : ['Русский текст'];
      },
      async extractSlideImage() {
        throw new Error('No image expected');
      }
    })
  });
  const secondaryResourceId =
    plan.project.items['fixture-song-item'].variants.secondary.resourceId;
  assert.deepEqual(
    plan.project.resources[secondaryResourceId].document.sections[0].slides[0].lines,
    ['Repeat × 2']
  );
  assert.equal(plan.summary.extracted.normalizedCharacters, 1);
  assert.deepEqual(plan.summary.extracted.normalizedCharactersByScope, {
    'fixture-song-item:secondary:repeat-marker-multiplication-v1': 1
  });
});

test('explicit PowerPoint emphasis stays as bounded ranges over literal plain text', () => {
  const paragraphs = extractStyledParagraphsFromSlideXml(emphasizedSermonSlideXml(), {
    emphasisColors: ['#FFC000']
  });
  assert.deepEqual(paragraphs[0], {
    text: 'Sermon Heading',
    spans: [{ start: 0, end: 14, foreground: '#ffc000', weight: '700' }]
  });
  assert.equal(paragraphs[1].text, 'Eph. 3:9 literal <span>& mystery.');
  assert.deepEqual(paragraphs[1].spans, [
    { start: 0, end: 8, foreground: '#ffc000', weight: '700' },
    { start: 8, end: 9, foreground: '#ffc000' },
    {
      start: paragraphs[1].text.indexOf('mystery'),
      end: paragraphs[1].text.indexOf('mystery') + 'mystery'.length,
      foreground: '#ffc000'
    }
  ]);
  assert.deepEqual(paragraphs[2], {
    text: 'God gives administration',
    spans: [{
      start: 'God gives '.length,
      end: 'God gives administration'.length,
      foreground: '#ffc000',
      weight: '400'
    }]
  });

  const projected = projectedStyledTextFromParagraphs(
    paragraphs,
    'Configured sermon heading',
    { preferFirstParagraphTitle: true }
  );
  assert.equal(projected.title, 'Sermon Heading');
  assert.deepEqual(
    projected.paragraphs.map(paragraph => paragraph.text),
    ['Eph. 3:9 literal <span>& mystery.', 'God gives administration']
  );
});

test('raised digit-only runs retain one narrow no-break boundary before an adjacent word', () => {
  assert.deepEqual(
    extractParagraphsFromSlideXml(superscriptVerseSlideXml()),
    [
      '14\u202fКоторый 2Lowered 3. 4 Already spaced',
      '13\u202fIn Him'
    ]
  );
});

test('sermon-notes defaults to explicit source emphasis and supports a manifest opt-out', async t => {
  const root = await tempDirectory(t);
  const deckPath = path.join(root, 'sermon.pptx');
  await writeFixtureDeck(deckPath, { firstSlideXml: emphasizedSermonSlideXml() });

  const plan = await buildImportPlan({
    manifest: sermonManifest(),
    decks: { rus: deckPath }
  });
  const item = plan.project.items['fixture-sermon'];
  const body = [
    'Eph. 3:9 literal <span>& mystery.',
    'God gives administration'
  ].join('\n');
  const semanticStart = body.indexOf('mystery');
  const administrationStart = body.indexOf('administration');
  assert.equal(item.textByChannel.primary, body);
  assert.equal(item.titlesByChannel.primary, 'Sermon Heading');
  assert.deepEqual(item.spansByChannel.primary, [
    { start: 0, end: 8, foreground: '#ffc000', weight: '700' },
    { start: 8, end: 9, foreground: '#ffc000' },
    { start: semanticStart, end: semanticStart + 7, foreground: '#ffc000' },
    {
      start: administrationStart,
      end: administrationStart + 'administration'.length,
      foreground: '#ffc000',
      weight: '400'
    }
  ]);

  const timeline = compileServiceProject(plan.project);
  const cue = timeline.cues[timeline.cueIds[0]];
  assert.equal(cue.channels.primary.blocks[0].text, 'Sermon Heading');
  assert.equal(cue.channels.primary.blocks[0].spans, undefined);
  assert.equal(cue.channels.primary.blocks[1].text, body);
  assert.deepEqual(cue.channels.primary.blocks[1].spans, item.spansByChannel.primary);

  const plainPlan = await buildImportPlan({
    manifest: sermonManifest({ emphasisColors: [] }),
    decks: { rus: deckPath }
  });
  assert.equal(plainPlan.project.items['fixture-sermon'].spansByChannel, undefined);

  await assert.rejects(
    buildImportPlan({
      manifest: sermonManifest({ emphasisColors: ['#ffc000\"><span weight=\"999999'] }),
      decks: { rus: deckPath }
    }),
    expectImportCode('INVALID_COLOR_FILTER')
  );
  await assert.rejects(
    buildImportPlan({
      manifest: sermonManifest({
        emphasisColors: Array.from(
          { length: 17 },
          (_unused, index) => `#${index.toString(16).padStart(6, '0')}`
        )
      }),
      decks: { rus: deckPath }
    }),
    expectImportCode('INVALID_COLOR_FILTER')
  );
});

test('native text projection removes repeated slide headings without losing title-only slides', () => {
  assert.deepEqual(
    projectedTextFromParagraphs(
      ['Psalm 143', 'Legacy Standard Bible'],
      'Psalm 143 · Legacy Standard Bible'
    ),
    {
      title: null,
      paragraphs: ['Psalm 143', 'Legacy Standard Bible']
    }
  );
  assert.deepEqual(
    projectedTextFromParagraphs(
      ['Ephesians 3:1-13', 'Legacy Standard Bible', 'Verse text'],
      'Ephesians 3:1-13 · Legacy Standard Bible'
    ),
    {
      title: 'Ephesians 3:1-13 · Legacy Standard Bible',
      paragraphs: ['Verse text']
    }
  );
  assert.deepEqual(
    projectedTextFromParagraphs(
      ['Why the Church Is So Precious', 'I. The Cost of the Church'],
      'I. The Cost of the Church',
      { preferFirstParagraphTitle: true }
    ),
    {
      title: 'Why the Church Is So Precious',
      paragraphs: ['I. The Cost of the Church']
    }
  );
});

test('dry-run reveals only hashes/counts and never creates an output root', async t => {
  const root = await tempDirectory(t);
  const rusPath = path.join(root, 'rus.pptx');
  const engPath = path.join(root, 'eng.pptx');
  const outputRoot = path.join(root, 'not-created');
  await Promise.all([
    writeFixtureDeck(rusPath),
    writeFixtureDeck(engPath, {
      lines: ['English fixture one\nEnglish fixture two'],
      pictureColor: '#876543'
    })
  ]);

  const result = await importServiceDecks({
    manifest: manifest(),
    decks: { rus: rusPath, eng: engPath },
    outputRoot
  });
  assert.equal(result.dryRun, true);
  assert.equal(result.summary.project.itemCount, 4);
  assert.equal(result.summary.project.assetCount, 2);
  assert.equal(result.summary.songs.length, 2);
  assert.equal(result.summary.extracted.textSlides, 2);
  assert.equal(result.summary.extracted.imageSlides, 2);
  assert.equal(JSON.stringify(result).includes('English fixture one'), false);
  await assert.rejects(fs.stat(outputRoot), error => error.code === 'ENOENT');
});

test('apply writes a separate compatible root idempotently and preserves differing existing data', async t => {
  const root = await tempDirectory(t);
  const outputRoot = path.join(root, 'import-output');
  const rusPath = path.join(root, 'rus.pptx');
  const engPath = path.join(root, 'eng.pptx');
  await Promise.all([
    writeFixtureDeck(rusPath),
    writeFixtureDeck(engPath, {
      lines: ['English fixture one\nEnglish fixture two'],
      pictureColor: '#876543'
    })
  ]);
  const options = {
    manifest: manifest(),
    decks: { rus: rusPath, eng: engPath },
    dryRun: false,
    outputRoot
  };

  const first = await importServiceDecks(options);
  assert.equal(first.applied.project.imported, true);
  assert.equal(first.applied.project.forked, false);
  assert.equal(first.applied.songs.every(song => song.unchanged === false), true);

  const library = new LocalSongLibrary({ rootPath: path.join(outputRoot, 'song-library') });
  const projectStore = new ServiceProjectStore({ rootPath: path.join(outputRoot, 'service-projects') });
  const song = await library.read('fixture-song');
  const project = await projectStore.read('fixture-service');
  assert.deepEqual(song.song.sections[0].slides[0].lines, ['Fixture line one', 'Fixture line two']);
  assert.deepEqual(project.project.rootItemIds, ['worship']);
  assert.deepEqual(project.project.items.worship.childIds, ['worship-songs', 'localized-intro']);
  assert.deepEqual(project.project.items['worship-songs'].childIds, ['fixture-song-item']);
  assert.equal(Object.keys(project.project.assets).length, 2);
  assert.equal(project.project.items['localized-intro'].assetIdsByChannel.primary.startsWith('sha256:'), true);

  const second = await importServiceDecks(options);
  assert.equal(second.applied.project.unchanged, true);
  assert.equal(second.applied.songs.every(saved => saved.unchanged), true);
  assert.equal((await projectStore.list()).total, 1);
  assert.equal((await library.list()).total, 2);

  await writeFixtureDeck(rusPath, { lines: ['A changed fixture line'] });
  await assert.rejects(importServiceDecks(options), expectImportCode('SONG_CONFLICT'));
  assert.deepEqual(
    (await library.read('fixture-song')).song.sections[0].slides[0].lines,
    ['Fixture line one', 'Fixture line two']
  );
  assert.equal((await projectStore.list()).total, 1);
});

test('output-only song content stays pinned and renderable without entering the reusable catalog', async t => {
  const root = await tempDirectory(t);
  const outputRoot = path.join(root, 'output-only');
  const rusPath = path.join(root, 'rus.pptx');
  const engPath = path.join(root, 'eng.pptx');
  const mediaPath = path.join(root, 'media.pptx');
  await Promise.all([
    writeFixtureDeck(rusPath),
    writeFixtureDeck(engPath, { lines: ['English fixture one\nEnglish fixture two'] }),
    writeFixtureDeck(mediaPath, { lines: ['Custom next line\nCustom Media note'] })
  ]);
  const outputManifest = manifest();
  const songItem = outputManifest.items.find(item => item.id === 'fixture-song-item');
  songItem.channels.media = {
    mode: 'content',
    deck: 'media',
    catalog: false,
    song: {
      id: 'fixture-song-media',
      title: 'Fixture Song — operator output',
      language: 'ru',
      translationOf: 'fixture-song'
    }
  };
  songItem.sections[0].slides.media = 1;

  const imported = await importServiceDecks({
    manifest: outputManifest,
    decks: { rus: rusPath, eng: engPath, media: mediaPath },
    dryRun: false,
    outputRoot
  });
  assert.deepEqual(
    imported.summary.songs.map(song => song.id),
    ['fixture-song', 'fixture-song-en']
  );

  const store = new ServiceProjectStore({ rootPath: path.join(outputRoot, 'service-projects') });
  const saved = await store.read('fixture-service');
  const mediaResourceId = saved.project.items['fixture-song-item'].variants.media.resourceId;
  assert.equal(
    saved.project.resources[mediaResourceId].origin.provider,
    OUTPUT_ONLY_SONG_PROVIDER
  );
  assert.deepEqual(
    saved.project.resources[mediaResourceId].document.sections[0].slides[0].lines,
    ['Custom next line', 'Custom Media note']
  );
  const timeline = compileServiceProject(saved.project);
  assert.equal(timeline.cueIds.length, 3);
  assert.equal(
    timeline.cueIds.some(cueId =>
      timeline.cues[cueId].channels.media.blocks.some(block =>
        block.type === 'text' && block.text.includes('Custom Media note'))),
    true
  );
  assert.equal(
    reachableSongResources(saved.project).some(resource =>
      resource.document.id === 'fixture-song-media'),
    false
  );

  const library = new LocalSongLibrary({ rootPath: path.join(outputRoot, 'song-library') });
  assert.equal((await library.list()).total, 2);
  await assert.rejects(
    library.read('fixture-song-media'),
    error => error?.code === 'SONG_NOT_FOUND'
  );
});

test('authored custom Media song content remains catalog eligible by default or explicit opt-in', async t => {
  const root = await tempDirectory(t);
  const rusPath = path.join(root, 'rus.pptx');
  const engPath = path.join(root, 'eng.pptx');
  const mediaPath = path.join(root, 'media.pptx');
  await Promise.all([
    writeFixtureDeck(rusPath),
    writeFixtureDeck(engPath, { lines: ['English fixture one\nEnglish fixture two'] }),
    writeFixtureDeck(mediaPath, { lines: ['Authored Media one\nAuthored Media two'] })
  ]);
  for (const explicitCatalogValue of [undefined, true]) {
    const outputManifest = manifest();
    outputManifest.project.id = `media-catalog-${explicitCatalogValue === true ? 'explicit' : 'default'}`;
    const songItem = outputManifest.items.find(item => item.id === 'fixture-song-item');
    songItem.channels.media = {
      mode: 'content',
      deck: 'media',
      ...(explicitCatalogValue === undefined ? {} : { catalog: explicitCatalogValue }),
      song: {
        id: 'fixture-song-media-authored',
        title: 'Fixture Song — authored Media',
        language: 'ru',
        translationOf: 'fixture-song'
      }
    };
    songItem.sections[0].slides.media = 1;
    const plan = await buildImportPlan({
      manifest: outputManifest,
      decks: { rus: rusPath, eng: engPath, media: mediaPath }
    });
    assert.equal(
      plan.orderedSongSources.some(entry => entry.song.id === 'fixture-song-media-authored'),
      true
    );
    const mediaResourceId = plan.project.items['fixture-song-item'].variants.media.resourceId;
    assert.equal(plan.project.resources[mediaResourceId].origin.provider, 'pptx-service-import');
  }
});

test('injected extraction supports generated fixtures and manifests cannot carry lyric bodies', async () => {
  const fakeExtractor = {
    slideCount: 5,
    async extractSlideText() {
      return ['Generated fixture text'];
    },
    async extractSlideImage() {
      return {
        buffer: await sharp({
          create: {
            width: 2,
            height: 2,
            channels: 3,
            background: '#123456'
          }
        }).png().toBuffer(),
        imagePart: 'ppt/media/generated.png',
        format: 'png',
        mediaType: 'image/png',
        extension: 'png'
      };
    }
  };
  const result = await importServiceDecks({
    manifest: manifest(),
    decks: {
      rus: '/fixtures/rus.pptx',
      eng: '/fixtures/eng.pptx'
    },
    extractorFactory: async () => fakeExtractor
  });
  assert.equal(result.dryRun, true);

  const hostile = manifest();
  hostile.items.find(item => item.id === 'fixture-song-item').lyrics = ['Content must not live in a manifest'];
  await assert.rejects(
    importServiceDecks({
      manifest: hostile,
      decks: {
        rus: '/fixtures/rus.pptx',
        eng: '/fixtures/eng.pptx'
      },
      extractorFactory: async () => fakeExtractor
    }),
    expectImportCode('EMBEDDED_CONTENT_NOT_ALLOWED')
  );
});

test('localized picture channels accept explicit rendered images without storing source paths', async t => {
  const root = await tempDirectory(t);
  const outputRoot = path.join(root, 'rendered-output');
  const russianImage = path.join(root, 'intro-russian.png');
  const englishImage = path.join(root, 'intro-english.png');
  await Promise.all([
    sharp({
      create: {
        width: 16,
        height: 9,
        channels: 3,
        background: '#112233'
      }
    }).png().toFile(russianImage),
    sharp({
      create: {
        width: 16,
        height: 9,
        channels: 3,
        background: '#445566'
      }
    }).png().toFile(englishImage)
  ]);
  const renderedManifest = manifest();
  renderedManifest.items.find(item => item.id === 'localized-intro').channels = {
    primary: { image: 'intro-rus' },
    secondary: { image: 'intro-eng' }
  };
  const fakeExtractor = {
    slideCount: 2,
    async extractSlideText() {
      return ['Generated fixture text'];
    },
    async extractSlideImage() {
      throw new Error('rendered-image test must not extract an embedded image');
    }
  };
  const result = await importServiceDecks({
    manifest: renderedManifest,
    decks: {
      rus: '/fixtures/rus.pptx',
      eng: '/fixtures/eng.pptx'
    },
    images: {
      'intro-rus': russianImage,
      'intro-eng': englishImage
    },
    extractorFactory: async () => fakeExtractor,
    dryRun: false,
    outputRoot
  });
  assert.deepEqual(result.summary.renderedImages, ['intro-eng', 'intro-rus']);
  assert.equal(JSON.stringify(result).includes(russianImage), false);
  assert.equal(JSON.stringify(result).includes(englishImage), false);

  const store = new ServiceProjectStore({ rootPath: path.join(outputRoot, 'service-projects') });
  const saved = await store.read('fixture-service');
  const picture = saved.project.items['localized-intro'];
  assert.notEqual(picture.assetIdsByChannel.primary, picture.assetIdsByChannel.secondary);
  assert.equal(
    saved.project.assets[picture.assetIdsByChannel.primary].fileName,
    'intro-russian.png'
  );
  assert.equal(
    saved.project.assets[picture.assetIdsByChannel.secondary].fileName,
    'intro-english.png'
  );
  assert.equal(JSON.stringify(saved.project).includes(root), false);
});

test('live SyncShow user data needs a separate explicit approval flag', () => {
  const liveRoot = path.join(os.homedir(), 'Library', 'Application Support', 'sync-show');
  assert.throws(
    () => assertSafeOutputRoot(liveRoot),
    expectImportCode('LIVE_USER_DATA_APPROVAL_REQUIRED')
  );
  assert.equal(
    assertSafeOutputRoot(liveRoot, { liveUserDataApproved: true }),
    path.resolve(liveRoot)
  );
});

test('live-data approval cannot be bypassed through a symlinked output root', async t => {
  const root = await tempDirectory(t);
  const liveRoot = path.join(os.homedir(), 'Library', 'Application Support', 'sync-show');
  try {
    await fs.stat(liveRoot);
  } catch (error) {
    if (error.code === 'ENOENT') return;
    throw error;
  }
  const linkPath = path.join(root, 'review-output');
  await fs.symlink(liveRoot, linkPath);
  await assert.rejects(
    resolveSafeOutputRoot(linkPath),
    expectImportCode('LIVE_USER_DATA_APPROVAL_REQUIRED')
  );
});
