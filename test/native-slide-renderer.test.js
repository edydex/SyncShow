'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const sharp = require('sharp');

const {
  MAX_RENDER_PIXELS,
  NativeSlideRenderer,
  cueTextForChannel,
  escapePango,
  focalGravity,
  markupLeadingScriptureReferences,
  markupTextSpans,
  nativeCueSingerNext,
  normalizeSafeTextSpans,
  normalizeScriptureBookToken,
  splitLeadingScriptureReference,
  meaningfulFirstLine
} = require('../src/services/project/NativeSlideRenderer');

const FONT_PATH = path.resolve(__dirname, '../assets/fonts/NotoSans-Variable.ttf');

function textCue(text, overrides = {}) {
  return {
    id: 'cue-notice',
    kind: 'notice',
    title: 'Welcome',
    groupPath: ['Sunday Service'],
    presetId: 'notice-text',
    channels: {
      primary: {
        mode: 'content',
        blocks: [{ type: 'text', role: 'caption', text }]
      }
    },
    ...overrides
  };
}

test('Pango text, metadata helpers, and focal positions treat operator content as literal data', () => {
  assert.equal(
    escapePango('<b "x">Tom & Jerry\'s</b>'),
    '&lt;b &quot;x&quot;&gt;Tom &amp; Jerry&apos;s&lt;/b&gt;'
  );
  assert.equal(meaningfulFirstLine('\n  \nFirst visible line\nSecond'), 'First visible line');
  assert.equal(focalGravity({ x: 0.1, y: 0.1 }), 'northwest');
  assert.equal(focalGravity({ x: 0.9, y: 0.9 }), 'southeast');
  assert.equal(focalGravity({ x: 0.5, y: 0.5 }), 'centre');
});

test('leading Scripture references are parsed narrowly and escaped into renderer-owned markup', () => {
  assert.deepEqual(splitLeadingScriptureReference('Еф.3:1 Для этого-то я, Павел'), {
    leadingWhitespace: '',
    reference: 'Еф.3:1',
    remainder: ' Для этого-то я, Павел'
  });
  assert.deepEqual(splitLeadingScriptureReference('  Кол.1:24 Ныне радуюсь'), {
    leadingWhitespace: '  ',
    reference: 'Кол.1:24',
    remainder: ' Ныне радуюсь'
  });
  assert.deepEqual(splitLeadingScriptureReference('Eph. 3:1–4 For this reason'), {
    leadingWhitespace: '',
    reference: 'Eph. 3:1–4',
    remainder: ' For this reason'
  });
  assert.deepEqual(splitLeadingScriptureReference('1 Pet. 1:4 An inheritance'), {
    leadingWhitespace: '',
    reference: '1 Pet. 1:4',
    remainder: ' An inheritance'
  });
  assert.deepEqual(splitLeadingScriptureReference('1Петр.4:10 Служите друг другу'), {
    leadingWhitespace: '',
    reference: '1Петр.4:10',
    remainder: ' Служите друг другу'
  });
  assert.equal(splitLeadingScriptureReference('Plan 3:1 is a ratio, not a Bible reference'), null);
  assert.equal(splitLeadingScriptureReference('Meet at 12:30 after service'), null);
  assert.equal(splitLeadingScriptureReference('Eph. 99:1 is not a real chapter'), null);
  assert.equal(splitLeadingScriptureReference('Еф.99:1 тоже не настоящая глава'), null);
  assert.equal(splitLeadingScriptureReference('Eph.3:4-2 is a reversed range'), null);
  assert.equal(normalizeScriptureBookToken('  1 Пет. '), '1пет');

  assert.equal(
    markupLeadingScriptureReferences('Еф.3:1 <b>literal & safe</b>\nPlan 3:1 stays plain', {
      paragraphGap: true
    }),
    '<span foreground="#ffc000" weight="700">Еф.3:1</span> '
      + '&lt;b&gt;literal &amp; safe&lt;/b&gt;\n\nPlan 3:1 stays plain'
  );
  assert.equal(
    markupLeadingScriptureReferences('Eph.3:1 <span foreground="red">not markup</span>', {
      foreground: 'javascript:bad',
      weight: 'bold'
    }),
    '<span foreground="#ffc000" weight="700">Eph.3:1</span> '
      + '&lt;span foreground=&quot;red&quot;&gt;not markup&lt;/span&gt;'
  );
});

test('compiled emphasis spans preserve untrimmed offsets and cannot inject renderer markup', () => {
  const text = '  Mystery <tag> 😀 stays literal';
  const start = text.indexOf('Mystery');
  const end = text.indexOf(' 😀');
  const spans = [{
    start,
    end,
    foreground: '#ffc000',
    weight: '400'
  }];
  assert.deepEqual(normalizeSafeTextSpans(text, spans), spans);
  assert.equal(
    markupTextSpans(text, spans),
    '  <span foreground="#ffc000" weight="400">Mystery &lt;tag&gt;</span> 😀 stays literal'
  );

  const emojiIndex = text.indexOf('😀');
  for (const invalid of [
    [{ start: emojiIndex + 1, end: emojiIndex + 2, foreground: '#ffc000' }],
    [{ start: 2, end: 10, foreground: '#ffc000' }, { start: 9, end: 12, weight: '700' }],
    [{ start: 2, end: 10, foreground: '#FFC000' }],
    [{ start: 2, end: 10, foreground: '#ffc000', markup: '<b>' }],
    [{ start: 2, end: 10 }]
  ]) {
    assert.throws(
      () => normalizeSafeTextSpans(text, invalid),
      error => error.code === 'INVALID_TEXT_SPANS'
    );
  }
});

test('real Sharp rendering is byte-deterministic, escapes markup, and preserves compatible cue metadata', async () => {
  const renderer = new NativeSlideRenderer({
    width: 640,
    height: 360,
    fontPath: FONT_PATH,
    jpegQuality: 88
  });
  const literalText = '5 < 7 & <b>literal</b> "quoted" — Привіт';
  const cue = textCue(literalText);

  const first = await renderer.renderCue(cue, 'primary');
  const second = await renderer.renderCue(cue, 'primary');
  const markupAsPlainText = await renderer.renderCue(textCue('5 < 7 & literal "quoted" — Привіт'), 'primary');

  assert.equal(first.info.format, 'jpeg');
  assert.equal(first.info.width, 640);
  assert.equal(first.info.height, 360);
  assert.ok(Buffer.isBuffer(first.info.data));
  assert.ok(first.info.data.length > 1000);
  assert.deepEqual(first.info.data, second.info.data);
  assert.notDeepEqual(first.info.data, markupAsPlainText.info.data,
    'literal angle-bracket text must remain visible instead of becoming Pango markup');
  assert.deepEqual(first.metadata, {
    cueId: 'cue-notice',
    title: 'Welcome',
    kind: 'notice',
    groupPath: ['Sunday Service'],
    text: literalText,
    firstLine: literalText
  });
});

test('song intro thumbnails render bilingual titles and an isolated lower-right credit', async () => {
  const renderer = new NativeSlideRenderer({
    width: 1600,
    height: 900,
    fontPath: FONT_PATH,
    jpegQuality: 96
  });
  const rendered = await renderer.renderCue({
    id: 'cue-song-title',
    kind: 'song',
    title: 'Operator song label',
    groupPath: ['Worship', 'My Soul Will Wait'],
    presetId: 'song-title',
    channels: {
      primary: {
        mode: 'content',
        blocks: [
          { type: 'text', role: 'title', text: 'ДУША МОЯ ТАК ЖДЁТ ТЕБЯ' },
          { type: 'text', role: 'subtitle', text: 'My Soul Will Wait' },
          {
            type: 'text',
            role: 'credit',
            text: 'Слова и музыка:\nBob Kauflin / Keaton Bunting'
          }
        ]
      }
    }
  }, 'primary');

  assert.equal(rendered.metadata.text, 'ДУША МОЯ ТАК ЖДЁТ ТЕБЯ');
  assert.equal(rendered.metadata.firstLine, 'ДУША МОЯ ТАК ЖДЁТ ТЕБЯ');
  const decoded = await sharp(rendered.info.data).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  let centeredWhitePixels = 0;
  let yellowPixels = 0;
  const creditPixels = [];
  for (let y = 0; y < decoded.info.height; y += 1) {
    for (let x = 0; x < decoded.info.width; x += 1) {
      const offset = (y * decoded.info.width + x) * decoded.info.channels;
      const red = decoded.data[offset];
      const green = decoded.data[offset + 1];
      const blue = decoded.data[offset + 2];
      if (y >= 180 && y <= 650 && red > 180 && green > 180 && blue > 180) {
        centeredWhitePixels += 1;
      }
      if (y >= 180 && y <= 700 && red > 180 && green > 180 && blue < 90) {
        yellowPixels += 1;
      }
      if (y >= 690 && x >= 650 && red > 180 && green > 180 && blue > 180) {
        creditPixels.push({ x, y });
      }
    }
  }
  assert.ok(centeredWhitePixels > 5000, 'the main title must remain centered and white');
  assert.ok(yellowPixels > 1500, 'the linked title must remain visibly yellow');
  assert.ok(creditPixels.length > 1000, 'the credit must render independently at lower right');
  assert.ok(Math.max(...creditPixels.map(pixel => pixel.x)) >= 1500, 'the credit must approach the right edge');
  assert.ok(Math.max(...creditPixels.map(pixel => pixel.y)) >= 850, 'the credit must approach the bottom edge');
});

test('renderer enforces output pixel bounds before allocating an image', () => {
  assert.equal(MAX_RENDER_PIXELS, 3840 * 2160);
  assert.throws(
    () => new NativeSlideRenderer({ width: 639, height: 360, fontPath: FONT_PATH }),
    RangeError
  );
  assert.throws(
    () => new NativeSlideRenderer({ width: 3840, height: 2161, fontPath: FONT_PATH }),
    RangeError
  );
});

test('sermon notes use validated gold and left-aligned text options without changing legacy defaults', async () => {
  const renderer = new NativeSlideRenderer({
    width: 640,
    height: 360,
    fontPath: FONT_PATH
  });
  const calls = [];
  renderer._textLayer = async (value, options) => {
    calls.push({ value, options });
    return null;
  };

  await renderer._renderTextSlide({
    title: 'Eph. 3:13',
    body: 'Therefore I ask you not to lose heart.',
    presetId: 'sermon-notes'
  });
  assert.equal(calls.length, 2);
  assert.deepEqual(
    {
      foreground: calls[0].options.foreground,
      weight: calls[0].options.weight,
      align: calls[0].options.align
    },
    { foreground: '#ffc000', weight: '700', align: 'left' }
  );
  assert.deepEqual(
    {
      foreground: calls[1].options.foreground,
      weight: calls[1].options.weight,
      align: calls[1].options.align,
      lineSpacingPercent: calls[1].options.lineSpacingPercent,
      paragraphGap: calls[1].options.paragraphGap,
      leadingReferenceStyle: calls[1].options.leadingReferenceStyle,
      leadingReferenceForeground: calls[1].options.leadingReferenceForeground,
      leadingReferenceWeight: calls[1].options.leadingReferenceWeight
    },
    {
      foreground: '#f8fafc',
      weight: '500',
      align: 'left',
      lineSpacingPercent: 25,
      paragraphGap: true,
      leadingReferenceStyle: 'scripture',
      leadingReferenceForeground: '#ffc000',
      leadingReferenceWeight: '700'
    }
  );
  assert.equal(calls[0].options.fontSize, 64);
  assert.equal(calls[1].options.fontSize, 64);
  assert.equal(calls[1].options.width, 640 * 0.96);

  calls.length = 0;
  const importedBody = 'Eph.3:1 Imported formatting is authoritative.';
  const importedSpans = [{
    start: importedBody.indexOf('Imported'),
    end: importedBody.indexOf(' formatting'),
    foreground: '#ffc000',
    weight: '400'
  }];
  await renderer._renderTextSlide({
    title: 'Imported sermon',
    body: importedBody,
    bodySpans: importedSpans,
    presetId: 'sermon-notes'
  });
  assert.deepEqual(calls[1].options.spans, importedSpans);
  assert.equal(
    calls[1].options.leadingReferenceStyle,
    undefined,
    'explicit imported spans must replace automatic reference recognition'
  );

  calls.length = 0;
  const authoredBody = 'Grace <b>stays literal</b> and this phrase is gold.';
  const goldStart = authoredBody.indexOf('this phrase');
  const authoredSpans = [{
    start: goldStart,
    end: goldStart + 'this phrase'.length,
    foreground: '#ffc000'
  }];
  await renderer._renderTextSlide({
    title: 'Prepared sermon',
    body: authoredBody,
    bodySpans: authoredSpans,
    presetId: 'sermon-notes'
  });
  assert.deepEqual(calls[1].options.spans, authoredSpans);
  assert.equal(calls[1].value, authoredBody);
  assert.equal(calls[1].options.leadingReferenceStyle, undefined);

  calls.length = 0;
  await renderer._renderTextSlide({
    title: 'Welcome',
    body: 'Legacy preset defaults stay centered.',
    presetId: 'notice-text'
  });
  assert.deepEqual(
    {
      foreground: calls[0].options.foreground,
      weight: calls[0].options.weight,
      align: calls[0].options.align
    },
    { foreground: '#93b4ff', weight: '650', align: 'center' }
  );
  assert.deepEqual(
    {
      foreground: calls[1].options.foreground,
      weight: calls[1].options.weight,
      align: calls[1].options.align
    },
    { foreground: '#f8fafc', weight: '500', align: 'center' }
  );
});

test('sermon notes render source-backed top geometry and gold references without adding a bottom rule', async () => {
  const renderer = new NativeSlideRenderer({
    width: 1600,
    height: 900,
    fontPath: FONT_PATH,
    jpegQuality: 96
  });
  const sourceBody = [
    'Еф.3:1 Для этого-то я, Павел, [сделался] узником Иисуса Христа за вас язычников.',
    'Кол.1:24 Ныне радуюсь в страданиях моих за вас и восполняю недостаток в плоти моей скорбей Христовых за Тело Его, которое есть Церковь'
  ].join('\n');
  const rendered = await renderer.renderCue(textCue(sourceBody, {
    id: 'cue-sermon-source-style',
    kind: 'sermon',
    title: 'Operator-only title',
    presetId: 'sermon-notes',
    channels: {
      primary: {
        mode: 'content',
        blocks: [
          { type: 'text', role: 'title', text: 'I. Цена Церкви' },
          { type: 'text', role: 'body', text: sourceBody }
        ]
      }
    }
  }), 'primary');
  const decoded = await sharp(rendered.info.data)
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const goldPixels = [];
  let bodyLightMaximumX = -1;
  let bottomNonBlackPixels = 0;
  for (let y = 0; y < decoded.info.height; y += 1) {
    for (let x = 0; x < decoded.info.width; x += 1) {
      const offset = (y * decoded.info.width + x) * decoded.info.channels;
      const red = decoded.data[offset];
      const green = decoded.data[offset + 1];
      const blue = decoded.data[offset + 2];
      if (red > 175 && green > 95 && green < 235 && blue < 110) goldPixels.push({ x, y });
      if (y >= 120 && red > 175 && green > 175 && blue > 175) {
        bodyLightMaximumX = Math.max(bodyLightMaximumX, x);
      }
      if (y >= decoded.info.height - 12 && (red > 35 || green > 35 || blue > 35)) {
        bottomNonBlackPixels += 1;
      }
    }
  }
  const titleGold = goldPixels.filter(pixel => pixel.y < 130);
  const bodyGold = goldPixels.filter(pixel => pixel.y >= 130);
  assert.ok(titleGold.length > 2000, 'the source-style title must remain gold');
  assert.ok(bodyGold.length > 1500, 'both leading Scripture references must render in gold');
  assert.ok(Math.min(...titleGold.map(pixel => pixel.y)) <= 45, 'the title must begin near the source top');
  assert.ok(Math.min(...bodyGold.map(pixel => pixel.y)) >= 145, 'body references must begin below the title');
  assert.ok(Math.min(...bodyGold.map(pixel => pixel.x)) <= 45, 'the wide body must begin near the source left edge');
  assert.ok(bodyLightMaximumX >= 1450, 'the wide body must use the source-like horizontal span');
  assert.equal(bottomNonBlackPixels, 0, 'the authoritative source has no bottom rule');

  const plain = await renderer.renderCue(textCue(
    'Plan 3:1 is an outline ratio, not a Bible reference.',
    {
      id: 'cue-sermon-plain-ratio',
      kind: 'sermon',
      presetId: 'sermon-notes'
    }
  ), 'primary');
  const plainPixels = await sharp(plain.info.data).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  let plainBodyGold = 0;
  for (let y = 120; y < plainPixels.info.height; y += 1) {
    for (let x = 0; x < plainPixels.info.width; x += 1) {
      const offset = (y * plainPixels.info.width + x) * plainPixels.info.channels;
      const red = plainPixels.data[offset];
      const green = plainPixels.data[offset + 1];
      const blue = plainPixels.data[offset + 2];
      if (red > 175 && green > 95 && green < 235 && blue < 110) plainBodyGold += 1;
    }
  }
  assert.equal(plainBodyGold, 0, 'non-reference leading text must remain in the normal body color');

  const emphasizedText = '  Source-owned emphasis <b>stays literal</b>';
  const emphasisStart = emphasizedText.indexOf('Source-owned');
  const emphasisEnd = emphasizedText.indexOf(' <b>');
  const emphasized = await renderer.renderCue(textCue('unused', {
    id: 'cue-sermon-explicit-emphasis',
    kind: 'sermon',
    presetId: 'sermon-notes',
    channels: {
      primary: {
        mode: 'content',
        blocks: [
          { type: 'text', role: 'body', text: 'Plain paragraph.' },
          {
            type: 'text',
            role: 'body',
            text: emphasizedText,
            spans: [{
              start: emphasisStart,
              end: emphasisEnd,
              foreground: '#ffc000',
              weight: '400'
            }]
          }
        ]
      }
    }
  }), 'primary');
  assert.equal(
    emphasized.metadata.text,
    `Plain paragraph.\n\n${emphasizedText}`,
    'span offsets must not alter the authoritative plain text'
  );
  const emphasizedPixels = await sharp(emphasized.info.data)
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  let emphasizedGold = 0;
  for (let y = 120; y < emphasizedPixels.info.height; y += 1) {
    for (let x = 0; x < emphasizedPixels.info.width; x += 1) {
      const offset = (y * emphasizedPixels.info.width + x) * emphasizedPixels.info.channels;
      const red = emphasizedPixels.data[offset];
      const green = emphasizedPixels.data[offset + 1];
      const blue = emphasizedPixels.data[offset + 2];
      if (red > 175 && green > 95 && green < 235 && blue < 110) emphasizedGold += 1;
    }
  }
  assert.ok(emphasizedGold > 250, 'validated explicit emphasis must reach the rendered body');
});

test('operator rundown titles are projected only when an output has an explicit title block', async () => {
  const renderer = new NativeSlideRenderer({
    width: 640,
    height: 360,
    fontPath: FONT_PATH
  });
  const calls = [];
  renderer._textLayer = async value => {
    calls.push(value);
    return null;
  };

  await renderer.renderCue(textCue('Projected body', {
    title: 'Operator-only rundown title'
  }), 'primary');
  assert.deepEqual(calls, ['Projected body']);

  calls.length = 0;
  await renderer.renderCue(textCue('unused', {
    title: 'Operator-only rundown title',
    channels: {
      primary: {
        mode: 'content',
        blocks: [
          { type: 'text', role: 'title', text: 'Projected heading' },
          { type: 'text', role: 'caption', text: 'Projected body' }
        ]
      }
    }
  }), 'primary');
  assert.deepEqual(calls, ['Projected heading', 'Projected body']);
});

test('text that cannot fit the selected preset fails closed with a structured overflow error', async () => {
  const renderer = new NativeSlideRenderer({ width: 640, height: 360, fontPath: FONT_PATH });
  for (const content of ['Longword '.repeat(100), 'x'.repeat(12001)]) {
    await assert.rejects(renderer.renderCue(textCue(content), 'primary'), error => {
      assert.equal(error.code, 'TEXT_OVERFLOW');
      assert.match(error.message, /more text than .* display safely/i);
      assert.equal(error.details.width, 524);
      assert.ok(error.details.maxHeight > 0);
      assert.ok(error.details.minimumFontSize >= 14);
      return true;
    });
  }
});

test('hidden and blank channels render deterministic black frames without exposing text', async () => {
  const renderer = new NativeSlideRenderer({ width: 640, height: 360, fontPath: FONT_PATH });
  const hiddenCue = textCue('must not appear', {
    id: 'cue-hidden',
    channels: { primary: { mode: 'hide', blocks: [] } }
  });
  const blankCue = textCue('must not appear', {
    id: 'cue-blank',
    kind: 'blank',
    channels: { primary: { mode: 'content', blocks: [{ type: 'blank' }] } }
  });

  const hidden = await renderer.renderCue(hiddenCue, 'primary');
  const blank = await renderer.renderCue(blankCue, 'primary');

  assert.deepEqual(hidden.info.data, blank.info.data);
  assert.equal(hidden.metadata.text, '');
  assert.equal(hidden.metadata.firstLine, 'Welcome');
  assert.equal(blank.metadata.text, '');
});

test('Singer Prepare preview keeps every current lyric line, adds its divider, and previews one next line', async () => {
  const renderer = new NativeSlideRenderer({
    width: 640,
    height: 360,
    fontPath: FONT_PATH,
    jpegQuality: 92
  });
  const currentCue = textCue('Current one\nCurrent two\nCurrent three\nCurrent four', {
    id: 'cue-song-current',
    kind: 'song',
    title: 'Song — Verse 1',
    presetId: 'song-lyrics'
  });
  const nextCue = textCue('\nNext slide first line\nNext slide second line', {
    id: 'cue-song-next',
    kind: 'song',
    title: 'Song — Chorus',
    presetId: 'song-lyrics'
  });

  assert.equal(cueTextForChannel(nextCue, 'primary'), '\nNext slide first line\nNext slide second line');
  const preview = await renderer.renderSingerPreview(currentCue, 'primary', nextCue);
  assert.equal(preview.info.width, 640);
  assert.equal(preview.info.height, 360);
  assert.equal(preview.metadata.layout, 'singer-current-next');
  assert.equal(preview.metadata.text, 'Current one\nCurrent two\nCurrent three\nCurrent four');
  assert.deepEqual(preview.metadata.next, {
    state: 'text',
    text: 'Next slide first line'
  });

  const decoded = await sharp(preview.info.data).raw().toBuffer({ resolveWithObject: true });
  let cyanPixels = 0;
  for (let y = 289; y <= 299; y += 1) {
    for (let x = 0; x < decoded.info.width; x += 1) {
      const offset = (y * decoded.info.width + x) * decoded.info.channels;
      const red = decoded.data[offset];
      const green = decoded.data[offset + 1];
      const blue = decoded.data[offset + 2];
      if (red < 130 && green > 120 && blue > 140) cyanPixels += 1;
    }
  }
  assert.ok(cyanPixels > 100, 'the Singer-style cyan separator must be present');
});

test('Singer Prepare preview keeps intentional blank distinct from presentation end', async () => {
  const renderer = new NativeSlideRenderer({
    width: 640,
    height: 360,
    fontPath: FONT_PATH,
    jpegQuality: 92
  });
  const currentCue = textCue('Current lyric', {
    id: 'cue-singer-state-current',
    kind: 'song',
    title: 'Song — Verse 1',
    presetId: 'song-lyrics'
  });
  const blankCue = textCue('must not appear', {
    id: 'cue-singer-state-blank',
    kind: 'blank',
    channels: {
      primary: { mode: 'content', blocks: [{ type: 'blank' }] }
    }
  });

  assert.deepEqual(nativeCueSingerNext(blankCue, 'primary'), {
    state: 'blank',
    text: ''
  });
  assert.deepEqual(nativeCueSingerNext(null, 'primary'), {
    state: 'end',
    text: ''
  });

  const blank = await renderer.renderSingerPreview(currentCue, 'primary', blankCue);
  const end = await renderer.renderSingerPreview(currentCue, 'primary', null);
  assert.deepEqual(blank.metadata.next, { state: 'blank', text: '' });
  assert.deepEqual(end.metadata.next, { state: 'end', text: '' });
  assert.equal(
    blank.info.data.equals(end.info.data),
    false,
    'only the terminal state should paint the End of presentation label'
  );
});
