'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const {
  NATIVE_CUE_SCENE_SCHEMA_VERSION,
  compileNativeCueScene,
  deriveNativeSingerScene,
  nativeCueSingerNext,
  nativeSceneSingerLine,
  nativeSceneSingerNext,
  normalizeNativeCueScene,
  sceneAssetIds,
  serializeNativeCueScene
} = require('../src/services/show');

const CUE_ID = 'cue-0123456789abcdef01234567';
const CANVAS = { width: 1920, height: 1080 };
const browserContext = vm.createContext({ window: {} });
vm.runInContext(
  fs.readFileSync(path.join(__dirname, '../src/renderer/native-cue-renderer.js'), 'utf8'),
  browserContext
);
const validateBrowserScene =
  browserContext.window.SyncShowNativeCueRenderer.validateScene;

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

  const singer = deriveNativeSingerScene(sermon, nativeSceneSingerNext(bible));
  assert.equal(singer.layout, 'singer-current-next');
  assert.deepEqual(singer.current, sermon);
  assert.deepEqual(singer.next, {
    state: 'text',
    text: '16 For God so loved the world'
  });
  assert.equal(nativeSceneSingerLine(singer), 'Projected title');
});

test('Singer next descriptors distinguish text, intentional blank, and presentation end', () => {
  const nextTextCue = compiledTextCue({
    id: 'cue-next-text',
    channels: {
      primary: {
        mode: 'content',
        blocks: [
          { type: 'text', role: 'body', text: '\n  Next meaningful line  \nSecond line', spans: [] }
        ]
      }
    }
  });
  const blankCue = compiledTextCue({
    id: 'cue-next-blank',
    kind: 'blank',
    channels: {
      primary: { mode: 'content', blocks: [{ type: 'blank' }] }
    }
  });
  const textScene = compileNativeCueScene(nextTextCue, 'primary', CANVAS);
  const blankScene = compileNativeCueScene(blankCue, 'primary', CANVAS);

  assert.deepEqual(nativeCueSingerNext(nextTextCue, 'primary'), {
    state: 'text',
    text: 'Next meaningful line'
  });
  assert.deepEqual(nativeCueSingerNext(blankCue, 'primary'), {
    state: 'blank',
    text: ''
  });
  assert.deepEqual(nativeCueSingerNext(null, 'primary'), {
    state: 'end',
    text: ''
  });
  assert.deepEqual(nativeSceneSingerNext(textScene), {
    state: 'text',
    text: 'Next meaningful line'
  });
  assert.deepEqual(nativeSceneSingerNext(blankScene), {
    state: 'blank',
    text: ''
  });
  assert.deepEqual(nativeSceneSingerNext(null), {
    state: 'end',
    text: ''
  });

  const singer = deriveNativeSingerScene(textScene, nativeSceneSingerNext(blankScene));
  assert.equal(
    JSON.stringify(validateBrowserScene(JSON.parse(JSON.stringify(singer)), singer.cueId)),
    JSON.stringify(singer)
  );
  for (const next of [
    { state: 'text', text: '' },
    { state: 'text', text: 'two\nlines' },
    { state: 'blank', text: 'not blank' },
    { state: 'end', text: 'End of presentation' }
  ]) {
    assert.throws(
      () => validateBrowserScene({ ...singer, next }, singer.cueId),
      /scene\.next/
    );
  }
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
  assert.throws(
    () => normalizeNativeCueScene({
      ...scene,
      style: {
        ...scene.style,
        bodyMinimumSize: scene.style.bodySize + 1
      }
    }),
    /minimum text sizes cannot exceed/
  );

  const emojiScene = {
    ...scene,
    body: 'A😀B',
    bodySpans: [{ start: 1, end: 2, weight: '700' }]
  };
  assert.throws(() => normalizeNativeCueScene(emojiScene), /invalid text boundaries/);

  const singer = deriveNativeSingerScene(scene, { state: 'text', text: 'Next' });
  assert.throws(
    () => normalizeNativeCueScene({
      ...singer,
      current: { ...singer.current, canvas: { width: 1280, height: 720 } }
    }),
    /matching non-Singer/
  );
  for (const next of [
    { state: 'text', text: '' },
    { state: 'text', text: 'two\nlines' },
    { state: 'text', text: ' padded ' },
    { state: 'blank', text: 'not blank' },
    { state: 'end', text: 'End of presentation' },
    { state: 'later', text: '' }
  ]) {
    assert.throws(
      () => normalizeNativeCueScene({ ...singer, next }),
      /scene\.next/
    );
  }
  assert.throws(
    () => normalizeNativeCueScene({
      ...singer,
      nextLine: 'legacy ambiguity'
    }),
    /unsupported or missing fields/
  );
});

test('Bible attribution survives package scenes and stage derivation without changing spoken text', () => {
  const credit = 'Licensed edition © Example & Publisher <literal>.';
  const scene = compileNativeCueScene({ id: CUE_ID, kind: 'bible', title: 'Romans 1:1', presetId: 'scripture-text',
    channels: { primary: { mode: 'content', blocks: [{ type: 'bible', reference: 'Romans 1:1', translationId: 'TEST', attribution: credit, verses: [{ number: 1, text: 'Exact supplied verse.' }] }] } } }, 'primary', CANVAS);
  assert.equal(scene.credit, credit);
  assert.equal(scene.body, '¹\u00a0Exact supplied verse.');
  assert.equal(nativeSceneSingerLine(scene), '¹\u00a0Exact supplied verse.');
  assert.equal(deriveNativeSingerScene(scene, { state: 'end', text: '' }).current.credit, credit);
  assert.deepEqual(JSON.parse(JSON.stringify(validateBrowserScene(scene))), scene);
  assert.equal(normalizeNativeCueScene(JSON.parse(serializeNativeCueScene(scene))).credit, credit);
  assert.throws(() => normalizeNativeCueScene({ ...scene, credit: 'x'.repeat(501) }));
  assert.throws(() => validateBrowserScene({ ...scene, credit: 'x'.repeat(501) }));
});

test('quotation sources have a separate right-aligned layout in live and validated scenes', () => {
  const cue=compiledTextCue({presetId:'wotbc-sermon-quote'});
  cue.channels.primary.blocks.push({type:'text',role:'credit',text:'Author, source'});
  const scene=compileNativeCueScene(cue,'primary',CANVAS);
  assert.equal(scene.credit,'Author, source');assert.equal(scene.quoteCredit,true);
  assert.equal(scene.body,'Body <is text> & never markup');assert.equal(scene.style.bodyAlign,'left');
  const validated=JSON.parse(JSON.stringify(validateBrowserScene(JSON.parse(serializeNativeCueScene(scene)))));
  assert.deepEqual(validated,scene);
});

test('an edited Scripture excerpt survives native scene compilation without changing source words', () => {
  const cue=compiledTextCue({kind:'bible',presetId:'wotbc-sermon-scripture'});
  cue.channels.primary.blocks=[{type:'text',role:'title',text:'Current point'},{type:'bible',reference:'John 8:31–32,44',translationId:'BSB',verses:[{number:31,text:'Original words.'}],displayText:'John 8:31–32,44 Selected words… [context]',displaySpans:[{start:15,end:23,background:'#ffff00'}]}];
  const scene=compileNativeCueScene(cue,'primary',CANVAS);
  assert.equal(scene.body,cue.channels.primary.blocks[1].displayText);assert.equal(scene.title,'Current point');
  assert.deepEqual(scene.bodySpans,cue.channels.primary.blocks[1].displaySpans);
  assert.equal(cue.channels.primary.blocks[1].verses[0].text,'Original words.');
  assert.deepEqual(JSON.parse(JSON.stringify(validateBrowserScene(scene))),scene);
});


test('compiled group typography and alignments survive both native scene validators', () => {
  const scene = compileNativeCueScene(compiledTextCue({presetId:'wotbc-sermon-quote',textStyle:{bodySize:68,bodyAlign:'right',titleAlign:'left',creditAlign:'center'}}), 'primary', CANVAS);
  assert.equal(scene.style.bodySize,68); assert.equal(scene.style.bodyMinimumSize,68);
  assert.equal(scene.style.bodyAlign,'right'); assert.equal(scene.style.titleAlign,'left'); assert.equal(scene.style.creditAlign,'center');
  assert.equal(validateBrowserScene(JSON.parse(serializeNativeCueScene(scene))).style.creditAlign,'center');
  assert.throws(()=>validateBrowserScene({...scene,style:{...scene.style,creditAlign:'justify'}}),/creditAlign/);
  const title = compileNativeCueScene(compiledTextCue({kind:'song',presetId:'wotbc-song-title',textStyle:{titleAlign:'left',bodyAlign:'right',creditAlign:'center'}}),'primary',CANVAS);
  assert.equal(title.style.titleAlign,'left');assert.equal(title.style.subtitleAlign,'right');assert.equal(title.style.creditAlign,'center');
  assert.equal(validateBrowserScene(JSON.parse(serializeNativeCueScene(title))).style.titleAlign,'left');
});

test('planned captions reserve full-width content space only on the selected audience outputs', () => {
  const original = compiledTextCue({translationSettings: {captionStyle:'lower-third',captionChannel:'both'}});
  original.channels.english = original.channels.primary;
  original.channels.media = original.channels.primary;
  const before = JSON.stringify(original);
  const scene = compileNativeCueScene(original, 'english');
  assert.deepEqual(scene.canvas, CANVAS);
  assert.equal(scene.captionReservation, .29);
  assert.equal(scene.style.bodySize, compileNativeCueScene({...original,translationSettings:undefined},'english').style.bodySize);
  assert.equal(JSON.stringify(validateBrowserScene(scene)), JSON.stringify(scene));
  assert.equal(compileNativeCueScene(original, 'media').captionReservation, undefined);
  assert.equal(compileNativeCueScene(original, 'english', {rendererVersion:17}).captionReservation, undefined);
  assert.throws(()=>normalizeNativeCueScene({...scene,captionReservation:.9}), /reservation/);
  assert.throws(()=>validateBrowserScene({...scene,captionReservation:-1}), /reservation/);
  assert.equal(JSON.stringify(original),before);
});
