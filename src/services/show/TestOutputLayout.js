'use strict';

function normalizeTestOutputSettings(value = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Test Output settings must be an object.');
  if (value.enabled !== undefined && typeof value.enabled !== 'boolean') throw new TypeError('Test Output enabled must be true or false.');
  if (value.layout !== undefined && !['vertical', 'horizontal'].includes(value.layout)) throw new TypeError('Choose a vertical or horizontal Test Output layout.');
  if (value.rotation !== undefined && ![0, 90, 270].includes(value.rotation)) throw new TypeError('Choose no rotation, clockwise 90°, or counterclockwise 90°.');
  const displayId = value.displayId == null ? null : String(value.displayId);
  if (displayId !== null && !/^-?\d{1,16}$/.test(displayId)) throw new TypeError('Choose a connected Test Output screen.');
  return Object.freeze({ enabled: value.enabled === true, layout: value.layout || 'vertical', rotation: value.rotation || 0, displayId });
}

function rotateRect(rect, physical, rotation) {
  if (rotation === 90) return { x: physical.x + physical.width - rect.y - rect.height, y: physical.y + rect.x, width: rect.height, height: rect.width };
  if (rotation === 270) return { x: physical.x + rect.y, y: physical.y + physical.height - rect.x - rect.width, width: rect.height, height: rect.width };
  return { ...rect, x: physical.x + rect.x, y: physical.y + rect.y };
}

// Quantize to whole 16:9 units so native window rounding cannot stretch a tile.
function testOutputTiles(bounds, outputs, layout = 'vertical', rotation = 0) {
  if (!Array.isArray(outputs) || !outputs.length || outputs.length > 16) throw new Error('Test Output needs between 1 and 16 screens.');
  if (!['vertical', 'horizontal'].includes(layout)) throw new Error('Invalid Test Output layout.');
  if (!bounds || !['x', 'y', 'width', 'height'].every(key => Number.isFinite(bounds[key]))) throw new Error('Invalid Test Output screen bounds.');
  if (![0, 90, 270].includes(rotation)) throw new Error('Invalid Test Output rotation.');
  const physical = bounds;
  bounds = { x: 0, y: 0, width: rotation ? physical.height : physical.width, height: rotation ? physical.width : physical.height };
  const gap = 12, label = 24, margin = 16;
  const columns = layout === 'horizontal' ? outputs.length : 1;
  const rows = layout === 'vertical' ? outputs.length : 1;
  const cellWidth = (bounds.width - 2 * margin - (columns - 1) * gap) / columns;
  const cellHeight = (bounds.height - 2 * margin - (rows - 1) * gap) / rows;
  const unit = Math.floor(Math.min(cellWidth / 16, (cellHeight - label) / 9));
  if (unit < 4) throw new Error('This layout is too small for the configured screens. Choose another layout or a larger display.');
  const width = unit * 16, height = unit * 9;
  return outputs.map((output, index) => {
    const column = layout === 'horizontal' ? index : 0;
    const row = layout === 'vertical' ? index : 0;
    const x = Math.round(bounds.x + margin + column * (cellWidth + gap) + (cellWidth - width) / 2);
    const y = Math.round(bounds.y + margin + row * (cellHeight + gap) + (cellHeight - height - label) / 2);
    return {
      outputId: output.id, name: output.name, rotation,
      viewport: { width, height },
      label: { ...rotateRect({ x, y, width, height: label }, physical, rotation), textWidth: width, textHeight: label },
      bounds: rotateRect({ x, y: y + label, width, height }, physical, rotation)
    };
  });
}

function buildTestOutputDisplayMap({ settings, outputs, displays, controlDisplayId }) {
  const normalized = normalizeTestOutputSettings(settings);
  if (!normalized.enabled) throw new Error('Enable Test Output in Admin Settings first.');
  const target = displays.find(display => String(display.id) === normalized.displayId);
  if (!target) throw new Error('Choose a connected Test Output screen in Admin Settings.');
  if (String(target.id) === String(controlDisplayId)) throw new Error('Choose an external screen for Test Output so the controls stay visible.');
  const tiles = testOutputTiles(target.bounds, outputs, normalized.layout, normalized.rotation);
  return { target, tiles, displays: new Map(tiles.map(tile => [
    `test-output:${tile.outputId}`,
    { ...target, bounds: tile.bounds, testOutput: true, testOutputRotation: normalized.rotation }
  ])) };
}

module.exports = { normalizeTestOutputSettings, testOutputTiles, buildTestOutputDisplayMap };
