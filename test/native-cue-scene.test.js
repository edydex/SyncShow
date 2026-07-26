'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  NATIVE_CUE_SCENE_SCHEMA_VERSION,
  compileNativeCueScene,
  deriveNativeSingerScene,
  nativeSceneSingerLine,
  normalizeNativeCueScene,
  sceneAssetIds,
  serializeNativeCueScene
} = require('../src/services/show');

const CUE_ID = 'cue-0123456789abcdef01234567';
const CANVAS = { width: 1920, height: 1080 };

function compiledTextCue(overrides = {}) {
  return {
    id: CUE_ID,
    kind: 'sermon',
    title: 'Operator title',
    presetId: 'sermon-notes',
    channels: {
      primary: {
        mode: 'content',
        blocks: [
          { type: 'text', role: 'title', text: 'Projected title', spans: [] },
          {
            type: 'text',
            role: 'body',
            text: 'Body <is text> & never markup',
            spans: [{ start: 0, end: 4, foreground: '#ffc000', weight: '700' }]
          }
        ]
      }
    },
    ...overrides
  };
}

test('compiles a constrained canonical text scene and preserves semantic styling', () => {
  const scene = compileNativeCueScene(compiledTextCue(), 'primary', CANVAS);

  assert.equal(scene.layout, 'text');
  assert.equal(scene.title, 'Projected title');
  assert.equal(scene.body, 'Body <is text> & never markup');
  assert.deepEqual(scene.bodySpans, [{
    start: 0,
    end: 4,
    foreground: '#ffc000',
    weight: '700'
  }]);
  assert.equal(scene.style.bodyPosition, 'top');
  assert.deepEqual(normalizeNativeCueScene(JSON.parse(serializeNativeCueScene(scene))), scene);
  assert.doesNotMatch(serializeNativeCueScene(scene), /<span|innerHTML|javascript:/i);
});

test('picture scenes expose only their content-addressed asset', () => {
  const assetId = `sha256:${'a'.repeat(64)}`;
  const cue = {
    id: CUE_ID,
    kind: 'picture',
    title: 'Welcome picture',
    presetId: 'picture-full',
    channels: {
      primary: {
        mode: 'content',
        blocks: [{
          type: 'image',
          assetId,
          fit: 'fill',
          focalPoint: { x: 0.25, y: 0.75 },
          altText: 'A safe local picture',
          attribution: 'Church archive'
        }]
      }
    }
  };

  const scene = compileNativeCueScene(cue, 'primary', CANVAS);
  assert.equal(scene.layout, 'picture');
  assert.deepEqual(sceneAssetIds(scene), [assetId]);
  assert.deepEqual(scene.picture.focalPoint, { x: 0.25, y: 0.75 });
});

test('Singer next-line semantics match compiled channels instead of operator metadata', () => {
  const sermon = compileNativeCueScene(compiledTextCue(), 'primary', CANVAS);
  assert.equal(nativeSceneSingerLine(sermon), 'Projected title');

  const bible = normalizeNativeCueScene({
    schemaVersion: NATIVE_CUE_SCENE_SCHEMA_VERSION,
    kind: 'syncshow-native-cue-scene',
    cueId: CUE_ID,
    sourceKind: 'bible',
    canvas: CANVAS,
    layout: 'text',
    background: '#000000',
    title: 'John 3:16',
    body: '16 For God so loved the world',
    bodySpans: [],
    style: sermon.style
  });
  assert.equal(nativeSceneSingerLine(bible), '16 For God so loved the world');

  const singer = deriveNativeSingerScene(sermon, nativeSceneSingerLine(bible));
  assert.equal(singer.layout, 'singer-current-next');
  assert.equal(singer.nextLine, '16 For God so loved the world');
  assert.equal(nativeSceneSingerLine(singer), 'Projected title');
});

test('song title scenes keep the localized title and credit in distinct constrained regions', () => {
  const cue = {
    id: CUE_ID,
    kind: 'song',
    title: 'Operator song name',
    presetId: 'song-title',
    channels: {
      primary: {
        mode: 'content',
        blocks: [
          { type: 'text', role: 'title', text: 'Душа моя так ждёт Тебя' },
          { type: 'text', role: 'subtitle', text: 'My Soul Will Wait' },
          {
            type: 'text',
            role: 'credit',
            text: 'Слова и музыка: Bob Kauflin / Keaton Bunting'
          }
        ]
      }
    }
  };
  const scene = compileNativeCueScene(cue, 'primary', CANVAS);

  assert.equal(scene.layout, 'song-title');
  assert.equal(scene.title, 'Душа моя так ждёт Тебя');
  assert.equal(scene.subtitle, 'My Soul Will Wait');
  assert.equal(scene.credit, 'Слова и музыка: Bob Kauflin / Keaton Bunting');
  assert.equal(scene.style.creditWidthPercent, 56);
  assert.equal(nativeSceneSingerLine(scene), 'Душа моя так ждёт Тебя');
  assert.deepEqual(normalizeNativeCueScene(JSON.parse(serializeNativeCueScene(scene))), scene);
});

test('rejects unknown scene fields, split surrogate spans, and inconsistent nested Singer scenes', () => {
  const scene = compileNativeCueScene(compiledTextCue(), 'primary', CANVAS);
  assert.throws(
    () => normalizeNativeCueScene({ ...scene, html: '<script>bad()</script>' }),
    /unsupported or missing fields/
  );

  const emojiScene = {
    ...scene,
    body: 'A😀B',
    bodySpans: [{ start: 1, end: 2, weight: '700' }]
  };
  assert.throws(() => normalizeNativeCueScene(emojiScene), /invalid text boundaries/);

  const singer = deriveNativeSingerScene(scene, 'Next');
  assert.throws(
    () => normalizeNativeCueScene({
      ...singer,
      current: { ...singer.current, canvas: { width: 1280, height: 720 } }
    }),
    /matching non-Singer/
  );
});
