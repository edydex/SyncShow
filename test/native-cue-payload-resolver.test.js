'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  NATIVE_CUE_SCENE_KIND,
  NATIVE_CUE_SCENE_SCHEMA_VERSION,
  compileNativeCueScene,
  normalizeNativeCueScene,
  resolveNativeCuePayload
} = require('../src/services/show');

const CANVAS = Object.freeze({ width: 640, height: 360 });

function textScene() {
  return compileNativeCueScene({
    id: 'cue-native-payload-text',
    kind: 'sermon',
    title: 'Operator title',
    presetId: 'sermon-notes',
    channels: {
      primary: {
        mode: 'content',
        blocks: [{
          type: 'text',
          role: 'body',
          text: 'Current exact text',
          spans: []
        }]
      }
    }
  }, 'primary', CANVAS);
}

function blankScene() {
  return normalizeNativeCueScene({
    schemaVersion: NATIVE_CUE_SCENE_SCHEMA_VERSION,
    kind: NATIVE_CUE_SCENE_KIND,
    cueId: 'cue-native-payload-blank',
    sourceKind: 'blank',
    canvas: CANVAS,
    layout: 'blank',
    background: '#000000'
  });
}

test('direct and derived payloads preserve exact scenes and distinguish blank from end', () => {
  const current = textScene();
  const blank = blankScene();
  const presentation = {
    renderer: 'native-cue',
    scenes: [current, blank],
    assetPaths: {}
  };

  const direct = resolveNativeCuePayload({
    presentation,
    cueIndex: 0
  });
  assert.equal(direct.scene, current);
  assert.deepEqual(direct.assetPaths, {});

  const beforeBlank = resolveNativeCuePayload({
    presentation,
    cueIndex: 0,
    variant: 'singer-current-next'
  });
  assert.deepEqual(beforeBlank.scene.current, current);
  assert.deepEqual(beforeBlank.scene.next, {
    state: 'blank',
    text: ''
  });

  const atEnd = resolveNativeCuePayload({
    presentation,
    cueIndex: 1,
    variant: 'singer-current-next'
  });
  assert.deepEqual(atEnd.scene.current, blank);
  assert.deepEqual(atEnd.scene.next, {
    state: 'end',
    text: ''
  });
});

test('picture payloads retain only exact absolute regular-file assets', async t => {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), 'syncshow-native-payload-')
  );
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const assetPath = path.join(directory, 'picture.png');
  await fs.writeFile(assetPath, Buffer.from('exact fixture bytes'));
  const assetId = `sha256:${'a'.repeat(64)}`;
  const picture = normalizeNativeCueScene({
    schemaVersion: NATIVE_CUE_SCENE_SCHEMA_VERSION,
    kind: NATIVE_CUE_SCENE_KIND,
    cueId: 'cue-native-payload-picture',
    sourceKind: 'picture',
    canvas: CANVAS,
    layout: 'picture',
    background: '#000000',
    picture: {
      assetId,
      fit: 'fit',
      focalPoint: { x: 0.5, y: 0.5 },
      altText: 'Fixture picture',
      attribution: ''
    }
  });
  const presentation = {
    renderer: 'native-cue',
    scenes: [picture],
    assetPaths: { [assetId]: assetPath }
  };

  assert.deepEqual(resolveNativeCuePayload({
    presentation,
    cueIndex: 0
  }), {
    scene: picture,
    assetPaths: { [assetId]: assetPath }
  });
  assert.equal(resolveNativeCuePayload({
    presentation: {
      ...presentation,
      assetPaths: { [assetId]: 'relative-picture.png' }
    },
    cueIndex: 0
  }), null);
  assert.equal(resolveNativeCuePayload({
    presentation: {
      ...presentation,
      assetPaths: { [assetId]: path.join(directory, 'missing.png') }
    },
    cueIndex: 0
  }), null);
  assert.equal(resolveNativeCuePayload({
    presentation: {
      ...presentation,
      assetPaths: { [assetId]: directory }
    },
    cueIndex: 0
  }), null);
});

test('invalid presentations, variants, indexes, and scenes fail closed', () => {
  const current = textScene();
  const presentation = {
    renderer: 'native-cue',
    scenes: [current],
    assetPaths: {}
  };

  for (const request of [
    {},
    { presentation: { ...presentation, renderer: 'slides' }, cueIndex: 0 },
    { presentation: { ...presentation, assetPaths: null }, cueIndex: 0 },
    { presentation, cueIndex: -1 },
    { presentation, cueIndex: 1 },
    { presentation, cueIndex: 0, variant: 'unknown-native-variant' },
    {
      presentation: {
        ...presentation,
        scenes: [{ ...current, unsupported: true }]
      },
      cueIndex: 0
    }
  ]) {
    assert.equal(resolveNativeCuePayload(request), null);
  }
});
