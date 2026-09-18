'use strict';
(function exposeCanvasLayout(root) {
const TYPES = ['text', 'image', 'brace', 'circle'];
const COLOR = /^#[0-9a-f]{6}$/i;
const BRACE_PATH = 'M 10 2 C 42 2 42 8 42 22 L 42 34 C 42 45 62 49 90 50 C 62 51 42 55 42 66 L 42 78 C 42 92 42 98 10 98';
function normalizeCanvasObjects(raw, fail, normalizeSpans) {
  if (!Array.isArray(raw) || raw.length > 64) fail('INVALID_CANVAS', 'A slide can contain at most 64 objects.');
  const ids = new Set();
  const number = (v, low, high, label) => {
    if (typeof v !== 'number' || !Number.isFinite(v) || v < low || v > high) fail('INVALID_CANVAS', `Invalid ${label}.`);
    return Math.round(v * 1000000) / 1000000;
  };
  const color = v => { if (!COLOR.test(v || '')) fail('INVALID_CANVAS', 'Choose a six-digit color.'); return v.toLowerCase(); };
  return raw.map(object => {
    if (!object || !TYPES.includes(object.type) || !/^[a-zA-Z0-9_-]{1,100}$/.test(object.id || '') || ids.has(object.id)) fail('INVALID_CANVAS', 'Slide objects need distinct IDs and supported types.');
    ids.add(object.id);
    const frame = object.frame || {};
    const result = { id: object.id, type: object.type, frame: {
      x: number(frame.x, 0, 1, 'horizontal position'), y: number(frame.y, 0, 1, 'vertical position'),
      width: number(frame.width, .01, 1, 'object width'), height: number(frame.height, .01, 1, 'object height'),
      rotation: number(frame.rotation ?? 0, -180, 180, 'rotation')
    } };
    if (result.frame.x + result.frame.width > 1.000001 || result.frame.y + result.frame.height > 1.000001) fail('INVALID_CANVAS', 'Keep the object inside the slide.');
    if (object.type === 'image') {
      if (!/^sha256:[a-f0-9]{64}$/.test(object.assetId || '')) fail('INVALID_CANVAS', 'Choose a saved image.');
      result.assetId = object.assetId;
      result.altText = String(object.altText || '').slice(0, 500);
    } else {
      result.color = color(object.color || '#ffffff');
      if (object.type === 'text') {
        if (typeof object.text !== 'string' || object.text.length > 4000) fail('INVALID_CANVAS', 'Keep a text box within 4,000 characters.');
        result.text = object.text; result.spans = normalizeSpans(object.spans, object.text, 'Canvas text');
        result.fontSize = number(object.fontSize ?? 64, 16, 240, 'font size');
        if (!['left','center','right'].includes(object.align || 'left')) fail('INVALID_CANVAS', 'Choose a text alignment.');
        result.align = object.align || 'left';
      } else {
        result.lineWidth = number(object.lineWidth ?? 4, 1, 30, 'line width');
        result.filled = object.type === 'circle' && object.filled === true;
      }
    }
    return result;
  });
}
function canvasAssetIds(item) {
  return [...new Set(Object.values(item.objectsByChannel || {}).flat().filter(object => object.type === 'image').map(object => object.assetId))];
}
function canvasText(objects) { return (objects || []).map(object => object.type === 'text' ? object.text : object.type === 'image' ? object.altText : '').filter(Boolean).join('\n'); }
const api = { normalizeCanvasObjects, canvasAssetIds, canvasText, BRACE_PATH };
if (typeof module === 'object' && module.exports) module.exports = api;
else root.SyncShowCanvasLayout = api;
})(typeof globalThis === 'object' ? globalThis : this);
