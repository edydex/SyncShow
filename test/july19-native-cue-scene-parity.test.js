'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const JSZip = require('jszip');

const {
  compileServiceProject,
  cueTextForChannel,
  meaningfulFirstLine,
  normalizeServiceProject,
  resolveNativeTextPreset,
  splitLeadingScriptureReference
} = require('../src/services/project');
const {
  compileNativeCueScene,
  deriveNativeSingerScene,
  normalizeNativeCueScene,
  sceneAssetIds,
  serializeNativeCueScene
} = require('../src/services/show/NativeCueScene');

const servicePath = path.join(
  __dirname,
  '..',
  'dist',
  '2026-07-19-07-19-2026-service-native-import.syncshow-service'
);
const browserRendererPath = path.join(
  __dirname,
  '..',
  'src',
  'renderer',
  'native-cue-renderer.js'
);

function shiftedExplicitSpans(textBlocks) {
  const bodyParts = [];
  const spans = [];
  let offset = 0;
  for (const block of textBlocks.filter(candidate => candidate.role !== 'title')) {
    if (!block.text) continue;
    if (bodyParts.length > 0) offset += 2;
    bodyParts.push(block.text);
    for (const span of block.spans || []) {
      spans.push({
        ...span,
        start: span.start + offset,
        end: span.end + offset
      });
    }
    offset += block.text.length;
  }
  return { body: bodyParts.join('\n\n'), spans };
}

function leadingReferenceSpans(text, preset) {
  if (preset.leadingReferenceStyle !== 'scripture') return [];
  const spans = [];
  let offset = 0;
  for (const line of text.split(/\r\n|\r|\n/)) {
    const reference = splitLeadingScriptureReference(line);
    if (reference) {
      const start = offset + reference.leadingWhitespace.length;
      spans.push({
        start,
        end: start + reference.reference.length,
        foreground: preset.leadingReferenceForeground || '#ffc000',
        weight: preset.leadingReferenceWeight || '700'
      });
    }
    offset += line.length;
    const newline = text.slice(offset).match(/^(\r\n|\r|\n)/)?.[0] || '';
    offset += newline.length;
  }
  return spans;
}

function expectedSemanticScene(cue, channelId) {
  const channel = cue.channels[channelId];
  if (!channel
    || channel.mode === 'hide'
    || channel.blocks.some(block => block.type === 'blank')) {
    return { layout: 'blank' };
  }
  const picture = channel.blocks.find(block => block.type === 'image');
  if (picture) {
    return {
      layout: 'picture',
      picture: {
        assetId: picture.assetId,
        fit: picture.fit,
        focalPoint: picture.focalPoint,
        altText: picture.altText,
        attribution: picture.attribution || ''
      }
    };
  }
  const bible = channel.blocks.find(block => block.type === 'bible');
  if (bible) {
    const body = bible.verses.map(verse => `${verse.number} ${verse.text}`).join('\n');
    const preset = resolveNativeTextPreset(cue.presetId).render;
    return {
      layout: 'text',
      title: bible.reference,
      body,
      bodySpans: leadingReferenceSpans(body, preset)
    };
  }
  const textBlocks = channel.blocks.filter(block => block.type === 'text');
  const localizedTitle = textBlocks.find(block => block.role === 'title')?.text || '';
  if (cue.kind === 'song' && localizedTitle) {
    return {
      layout: 'song-title',
      title: localizedTitle,
      subtitle: textBlocks.find(block => block.role === 'subtitle')?.text || '',
      credit: textBlocks.find(block => block.role === 'credit')?.text || ''
    };
  }
  const compiledBody = shiftedExplicitSpans(textBlocks);
  const title = cue.kind === 'song'
    ? ''
    : (cue.kind === 'sermon' || cue.kind === 'notice'
        ? localizedTitle
        : (localizedTitle || cue.title));
  // NativeSlideRenderer passes the localized title as its body fallback, then
  // falls back to the projected title inside _renderTextSlide.
  const body = compiledBody.body || localizedTitle || title;
  const preset = resolveNativeTextPreset(cue.presetId).render;
  return {
    layout: 'text',
    title,
    body,
    bodySpans: compiledBody.spans.length > 0
      ? compiledBody.spans
      : leadingReferenceSpans(body, preset)
  };
}

test('the rebuilt July 19 service preserves every native cue scene and Singer semantic', {
  skip: fs.existsSync(servicePath)
    ? false
    : 'Ignored local July 19 review artifact is not present in this checkout.'
}, async () => {
  const archive = await JSZip.loadAsync(await fsp.readFile(servicePath), {
    createFolders: false
  });
  const project = normalizeServiceProject(JSON.parse(
    await archive.file('project.json').async('string')
  ));
  const browserContext = vm.createContext({ window: {} });
  vm.runInContext(await fsp.readFile(browserRendererPath, 'utf8'), browserContext, {
    filename: browserRendererPath
  });
  const browserSceneValidator =
    browserContext.window.SyncShowNativeCueRenderer.validateScene;
  const timeline = compileServiceProject(project);
  const layoutCounts = {};
  const sourceKindCounts = {};
  const referencedAssetIds = new Set();
  let styledSceneCount = 0;
  let styledSpanCount = 0;
  let emptySingerNextLineCount = 0;

  assert.equal(timeline.cueIds.length, 114);
  assert.deepEqual(project.channelIds, ['primary', 'secondary', 'media']);

  for (const [cueIndex, cueId] of timeline.cueIds.entries()) {
    const cue = timeline.cues[cueId];
    const nextCueId = timeline.cueIds[cueIndex + 1];
    const nextCue = nextCueId ? timeline.cues[nextCueId] : null;
    for (const channelId of project.channelIds) {
      const expected = expectedSemanticScene(cue, channelId);
      const scene = compileNativeCueScene(cue, channelId, {
        width: 1920,
        height: 1080,
        nextCue
      });
      assert.equal(scene.cueId, cue.id);
      assert.equal(scene.sourceKind, cue.kind);
      assert.deepEqual(scene.canvas, { width: 1920, height: 1080 });
      assert.equal(scene.layout, expected.layout);
      assert.deepEqual(
        normalizeNativeCueScene(JSON.parse(serializeNativeCueScene(scene)), {
          cueId: cue.id,
          layout: expected.layout
        }),
        scene
      );
      assert.equal(
        JSON.stringify(browserSceneValidator(JSON.parse(JSON.stringify(scene)), cue.id)),
        JSON.stringify(scene),
        `browser and main scene schemas drifted for ${cue.id}/${channelId}`
      );

      if (scene.layout === 'text') {
        assert.equal(scene.title, expected.title);
        assert.equal(scene.body, expected.body);
        assert.deepEqual(scene.bodySpans, expected.bodySpans);
        if (scene.bodySpans.length > 0) {
          styledSceneCount += 1;
          styledSpanCount += scene.bodySpans.length;
        }
      } else if (scene.layout === 'song-title') {
        assert.equal(scene.title, expected.title);
        assert.equal(scene.subtitle, expected.subtitle);
        assert.equal(scene.credit, expected.credit);
      } else if (scene.layout === 'picture') {
        assert.deepEqual(scene.picture, expected.picture);
      }
      for (const assetId of sceneAssetIds(scene)) referencedAssetIds.add(assetId);

      const nextLine = meaningfulFirstLine(cueTextForChannel(nextCue, channelId));
      const singer = deriveNativeSingerScene(scene, nextLine);
      assert.equal(singer.layout, 'singer-current-next');
      assert.deepEqual(singer.current, scene);
      assert.equal(singer.nextLine, nextLine);
      assert.equal(
        JSON.stringify(browserSceneValidator(JSON.parse(JSON.stringify(singer)), cue.id)),
        JSON.stringify(singer),
        `browser and main Singer scene schemas drifted for ${cue.id}/${channelId}`
      );
      if (!nextLine) emptySingerNextLineCount += 1;

      layoutCounts[scene.layout] = (layoutCounts[scene.layout] || 0) + 1;
      sourceKindCounts[scene.sourceKind] = (sourceKindCounts[scene.sourceKind] || 0) + 1;
    }
  }

  assert.deepEqual(layoutCounts, {
    picture: 9,
    text: 288,
    'song-title': 18,
    blank: 27
  });
  assert.deepEqual(sourceKindCounts, {
    picture: 9,
    song: 183,
    blank: 27,
    notice: 30,
    sermon: 93
  });
  assert.equal(styledSceneCount, 66);
  assert.equal(styledSpanCount, 156);
  assert.equal(emptySingerNextLineCount, 36);
  assert.deepEqual(
    [...referencedAssetIds].sort(),
    Object.keys(project.assets).sort()
  );
});
