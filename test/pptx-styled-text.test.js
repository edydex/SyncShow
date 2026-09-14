'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  MAX_PPTX_TEXT_SPANS,
  PptxStyledTextError,
  normalizePptxTextSpans,
  normalizeStyledText
} = require('../src/services/sermon/PptxStyledText');

function expectCode(code) {
  return error => {
    assert.ok(error instanceof PptxStyledTextError);
    assert.equal(error.code, code);
    return true;
  };
}

test('styled normalization rebases direct formatting through NFC, whitespace, and trimming', () => {
  const raw = '  E\u0301  middle  😀  ';
  const emojiStart = raw.indexOf('😀');
  const normalized = normalizeStyledText(raw, [{
    start: 2,
    end: 4,
    foreground: '#ffc000',
    weight: '700'
  }, {
    start: emojiStart,
    end: emojiStart + '😀'.length,
    foreground: '#ffc000',
    weight: '400'
  }]);

  assert.equal(normalized.text, 'É middle 😀');
  assert.deepEqual(normalized.spans, [{
    start: 0,
    end: 1,
    foreground: '#ffc000',
    weight: '700'
  }, {
    start: normalized.text.indexOf('😀'),
    end: normalized.text.indexOf('😀') + 2,
    foreground: '#ffc000',
    weight: '400'
  }]);
  assert.equal(normalized.textTruncated, false);
  assert.equal(normalized.spansTruncated, false);
});

test('span validation rejects overlap, surrogate splits, unsupported style, and excess ranges', () => {
  const text = 'A😀BC';
  const candidates = [[{
    start: 1,
    end: 2,
    foreground: '#ffc000'
  }], [{
    start: 0,
    end: 2,
    foreground: '#ffc000'
  }, {
    start: 1,
    end: 3,
    foreground: '#ffc000'
  }], [{
    start: 0,
    end: 1,
    foreground: '#ffffff'
  }], [{
    start: 0,
    end: 1,
    foreground: '#ffc000',
    weight: '500'
  }]];

  for (const spans of candidates) {
    assert.throws(
      () => normalizePptxTextSpans(spans, text),
      expectCode('INVALID_TEXT_SPANS')
    );
  }

  assert.throws(
    () => normalizePptxTextSpans(
      Array.from({ length: MAX_PPTX_TEXT_SPANS + 1 }, (_value, index) => ({
        start: index * 2,
        end: (index * 2) + 1,
        foreground: '#ffc000'
      })),
      'x '.repeat(MAX_PPTX_TEXT_SPANS + 1)
    ),
    expectCode('TEXT_SPANS_TOO_LARGE')
  );
});

test('UTF-16 truncation never emits half of a surrogate pair', () => {
  const tooShort = normalizeStyledText('😀X', [{
    start: 0,
    end: 2,
    foreground: '#ffc000',
    weight: '700'
  }], {
    maximumChars: 1
  });
  assert.equal(tooShort.text, '');
  assert.equal(tooShort.spans, undefined);
  assert.equal(tooShort.textTruncated, true);

  const exact = normalizeStyledText('😀X', [{
    start: 0,
    end: 2,
    foreground: '#ffc000',
    weight: '700'
  }], {
    maximumChars: 2
  });
  assert.equal(exact.text, '😀');
  assert.deepEqual(exact.spans, [{
    start: 0,
    end: 2,
    foreground: '#ffc000',
    weight: '700'
  }]);
  assert.equal(exact.textTruncated, true);
});
