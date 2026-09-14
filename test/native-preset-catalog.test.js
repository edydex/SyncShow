'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const {
  DEFAULT_NATIVE_TEXT_PRESET_ID,
  NATIVE_PRESET_CATALOG_VERSION,
  NATIVE_PRESETS,
  NATIVE_RENDERER_VERSION,
  NativeSlideRenderer,
  getNativePreset,
  isNativePresetAllowed,
  listNativePresets,
  resolveNativeTextPreset
} = require('../src/services/project');

const FONT_PATH = path.resolve(__dirname, '../assets/fonts/NotoSans-Variable.ttf');

function textCue(presetId, kind, title, text) {
  return {
    id: `cue-${presetId}`,
    kind,
    title,
    groupPath: ['Sunday Service'],
    presetId,
    channels: {
      primary: {
        mode: 'content',
        blocks: [{ type: 'text', role: 'body', text }]
      }
    }
  };
}

test('the built-in preset catalog is validated, immutable, and keeps original render tokens stable', () => {
  assert.equal(NATIVE_PRESET_CATALOG_VERSION, 4);
  assert.equal(NATIVE_RENDERER_VERSION, 11);
  assert.equal(DEFAULT_NATIVE_TEXT_PRESET_ID, 'default-text');
  assert.ok(Object.isFrozen(NATIVE_PRESETS));
  assert.ok(NATIVE_PRESETS.every(preset => Object.isFrozen(preset) && Object.isFrozen(preset.render)));

  assert.deepEqual(getNativePreset('song-lyrics').render, {
    mode: 'text',
    background: '#04070d',
    bodySize: 76,
    bodyHeight: 760,
    bodyMinimumSize: 34,
    titleSize: 34,
    titleMinimumSize: 24,
    showTitle: false,
    bodyWeight: '600'
  });
  assert.deepEqual(getNativePreset('scripture-text').render, {
    mode: 'text',
    background: '#071326',
    bodySize: 52,
    bodyHeight: 690,
    bodyMinimumSize: 28,
    titleSize: 42,
    titleMinimumSize: 24,
    showTitle: true,
    bodyWeight: '500'
  });
  assert.deepEqual(getNativePreset('sermon-point').render, {
    mode: 'text',
    background: '#101a33',
    bodySize: 68,
    bodyHeight: 690,
    bodyMinimumSize: 34,
    titleSize: 38,
    titleMinimumSize: 24,
    showTitle: true,
    bodyWeight: '500'
  });
  assert.deepEqual(getNativePreset('sermon-notes').render, {
    mode: 'text',
    background: '#000000',
    bodySize: 64,
    bodyHeight: 720,
    bodyMinimumSize: 28,
    titleSize: 64,
    titleMinimumSize: 32,
    showTitle: true,
    bodyWeight: '500',
    titleForeground: '#ffc000',
    bodyForeground: '#f8fafc',
    titleWeight: '700',
    titleAlign: 'left',
    bodyAlign: 'left',
    bodyWidthPercent: 96,
    titleTopPercent: 4,
    bodyTopPercent: 17,
    bodyPosition: 'top',
    lineSpacingPercent: 25,
    paragraphGap: true,
    leadingReferenceStyle: 'scripture',
    leadingReferenceForeground: '#ffc000',
    leadingReferenceWeight: '700'
  });
  assert.deepEqual(getNativePreset('notice-text').render, {
    mode: 'text',
    background: '#15223f',
    bodySize: 62,
    bodyHeight: 690,
    bodyMinimumSize: 34,
    titleSize: 38,
    titleMinimumSize: 24,
    showTitle: true,
    bodyWeight: '500'
  });
  assert.deepEqual(getNativePreset('video-fullscreen').render, {
    mode: 'video'
  });
  assert.equal(isNativePresetAllowed('video-fullscreen', 'video'), true);
  assert.deepEqual(getNativePreset('song-title').render, {
    mode: 'text',
    background: '#04070d',
    bodySize: 82,
    bodyHeight: 690,
    bodyMinimumSize: 34,
    titleSize: 40,
    titleMinimumSize: 24,
    showTitle: true,
    bodyWeight: '500'
  });
  assert.deepEqual(resolveNativeTextPreset('unknown-legacy-id'), getNativePreset('default-text'));
});

test('preset choices are kind-scoped and include the focused large-text additions', () => {
  assert.deepEqual(
    listNativePresets('sermon').map(preset => preset.id),
    ['wotbc-sermon-title', 'wotbc-sermon-quote', 'wotbc-sermon', 'sermon-title', 'sermon-point', 'sermon-notes']
  );
  assert.deepEqual(
    listNativePresets('bible').map(preset => preset.id),
    ['wotbc-sermon-verse', 'wotbc-reading', 'scripture-text', 'scripture-large']
  );
  assert.deepEqual(
    listNativePresets('song').map(preset => preset.id),
    ['wotbc-song-stacked', 'wotbc-song-lyrics', 'wotbc-song-title', 'song-title', 'song-lyrics', 'song-lyrics-large']
  );
  assert.equal(isNativePresetAllowed('sermon-title', 'sermon'), true);
  assert.equal(isNativePresetAllowed('sermon-title', 'notice'), false);
  assert.equal(isNativePresetAllowed('default-text', 'notice'), false);
  assert.equal(getNativePreset('picture-fullscreen').render.mode, 'picture');
  assert.equal(getNativePreset('blank-black').render.mode, 'blank');
  assert.equal(getNativePreset('legacy-slide').render.mode, 'legacy');
});

test('the native renderer consumes the large catalog presets without changing output dimensions', async () => {
  const renderer = new NativeSlideRenderer({
    width: 640,
    height: 360,
    fontPath: FONT_PATH,
    jpegQuality: 88
  });
  const cases = [
    {
      normal: textCue('sermon-point', 'sermon', 'Grace', 'Grace changes the whole person.'),
      large: textCue('sermon-title', 'sermon', 'Grace', 'Grace changes the whole person.')
    },
    {
      normal: textCue('scripture-text', 'bible', 'John 3:16', '16 For God so loved the world.'),
      large: textCue('scripture-large', 'bible', 'John 3:16', '16 For God so loved the world.')
    },
    {
      normal: textCue('song-lyrics', 'song', 'Song', 'Holy, holy, holy'),
      large: textCue('song-lyrics-large', 'song', 'Song', 'Holy, holy, holy')
    }
  ];

  for (const pair of cases) {
    const normal = await renderer.renderCue(pair.normal, 'primary');
    const large = await renderer.renderCue(pair.large, 'primary');
    assert.equal(normal.info.format, 'jpeg');
    assert.equal(large.info.format, 'jpeg');
    assert.equal(normal.info.width, 640);
    assert.equal(large.info.width, 640);
    assert.equal(normal.info.height, 360);
    assert.equal(large.info.height, 360);
    assert.notDeepEqual(normal.info.data, large.info.data);
  }
});
