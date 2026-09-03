'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const JSZip = require('jszip');

const {
  CurrentServiceSongDraftWorkerError,
  buildPptxSongDraftInWorker,
  inspectPptxSongSlidesInWorker
} = require('../src/services/project');

async function songDeck() {
  const zip = new JSZip();
  zip.file(
    'ppt/presentation.xml',
    '<p:presentation xmlns:p="urn:p" xmlns:r="urn:r">'
      + '<p:sldIdLst><p:sldId id="256" r:id="rId1"/></p:sldIdLst>'
      + '</p:presentation>'
  );
  zip.file(
    'ppt/_rels/presentation.xml.rels',
    '<Relationships>'
      + '<Relationship Id="rId1" '
      + 'Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" '
      + 'Target="slides/slide1.xml"/>'
      + '</Relationships>'
  );
  zip.file(
    'ppt/slides/slide1.xml',
    '<p:sld xmlns:p="urn:p" xmlns:a="urn:a"><p:cSld><p:spTree>'
      + '<a:p><a:r><a:rPr><a:solidFill><a:srgbClr val="FFFFFF"/>'
      + '</a:solidFill></a:rPr><a:t>Worker lyric</a:t></a:r></a:p>'
      + '</p:spTree></p:cSld></p:sld>'
  );
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

test('song draft worker isolates inspection and returns a frozen bounded result', async () => {
  const inspected = await inspectPptxSongSlidesInWorker(await songDeck());

  assert.equal(inspected.slideCount, 1);
  assert.equal(inspected.slides[0].lanes.white.preview, 'Worker lyric');
  assert.equal(Object.isFrozen(inspected), true);
  assert.equal(Object.isFrozen(inspected.slides), true);
  assert.equal(Object.isFrozen(inspected.slides[0].lanes.white), true);
});

test('song draft worker isolates draft construction and preserves source errors', async () => {
  const buffer = await songDeck();
  const draft = await buildPptxSongDraftInWorker(buffer, {
    slideNumbers: [1],
    lane: 'white',
    title: 'Worker Song',
    language: 'en',
    sourceLabel: 'Verified worker deck'
  });

  assert.equal(draft.song.title, 'Worker Song');
  assert.deepEqual(
    draft.song.sections[0].slides[0].lines,
    ['Worker lyric']
  );
  assert.equal(Object.isFrozen(draft), true);

  await assert.rejects(
    inspectPptxSongSlidesInWorker(Buffer.from('not a deck')),
    error =>
      error instanceof CurrentServiceSongDraftWorkerError
      && error.code === 'CORRUPT_PPTX'
  );
});
