'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { testOutputTiles, buildTestOutputDisplayMap, normalizeTestOutputSettings } = require('../src/services/show/TestOutputLayout');
const outputs = ['English', 'Russian', 'Stage-facing'].map((name, id) => ({ id: String(id), name }));
for (const bounds of [{ x: 1512, y: 0, width: 1080, height: 1920 }, { x: -1920, y: -1080, width: 1920, height: 1080 }]) {
  for (const layout of ['horizontal', 'vertical']) {
    test(`${layout} demo keeps three exact 16:9 tiles inside ${bounds.width}×${bounds.height}`, () => {
      const tiles = testOutputTiles(bounds, outputs, layout);
      tiles.forEach(({ bounds: box, label }, index) => {
        assert.equal(box.width * 9, box.height * 16);
        assert.ok(box.x >= bounds.x && box.y >= bounds.y);
        assert.ok(box.x + box.width <= bounds.x + bounds.width);
        assert.ok(box.y + box.height <= bounds.y + bounds.height);
        assert.equal(label.y + label.height, box.y);
        if (index) {
          const previous = tiles[index - 1].bounds;
          assert.ok(layout === 'vertical' ? previous.y + previous.height < label.y : previous.x + previous.width < box.x);
        }
      });
    });
  }
}
test('one connected external monitor supports three logical outputs without changing assignments', () => {
  const displays = [ { id: 1, bounds: {x: 0, y: 0, width: 1512, height: 982} }, { id: 2, bounds: {x: 1512, y: 0, width: 1080, height: 1920} } ];
  const options = { settings: { enabled: true, displayId: '2', layout: 'vertical' }, displays, outputs, controlDisplayId: 1 };
  const result = buildTestOutputDisplayMap(options);
  assert.equal(result.displays.size, 3);
  assert.deepEqual([...result.displays.values()].map(display => display.id), [2, 2, 2]);
  assert.throws(() => buildTestOutputDisplayMap({...options, settings: {...options.settings, displayId: '1'}}), /external screen/);
  assert.throws(() => buildTestOutputDisplayMap({...options, settings: {...options.settings, displayId: '3'}}), /connected/);
  assert.throws(() => buildTestOutputDisplayMap({...options, settings: {...options.settings, enabled: false}}), /Enable/);
  assert.deepEqual(outputs.map(output => output.displayId), [undefined, undefined, undefined]);
});
test('malformed demo settings and unusable layouts fail before opening windows', () => {
  assert.throws(() => normalizeTestOutputSettings({enabled: 'true'}), /true or false/);
  assert.throws(() => normalizeTestOutputSettings({layout: 'stretch'}), /vertical or horizontal/);
  assert.throws(() => normalizeTestOutputSettings({displayId: '../1'}), /connected/);
  assert.throws(() => testOutputTiles({x:0,y:0,width:80,height:60}, outputs), /too small/);
});
for (const rotation of [90, 270]) {
  for (const layout of ['vertical', 'horizontal']) {
    test(`${rotation}° ${layout} rotates all tiles and labels inside the physical monitor`, () => {
      const monitor = { x: -1920, y: 110, width: 1920, height: 1080 };
      const tiles = testOutputTiles(monitor, outputs, layout, rotation);
      for (const tile of tiles) {
        assert.equal(tile.viewport.width * 9, tile.viewport.height * 16);
        assert.equal(tile.bounds.width, tile.viewport.height);
        assert.equal(tile.bounds.height, tile.viewport.width);
        for (const box of [tile.bounds, tile.label]) {
          assert.ok(box.x >= monitor.x && box.y >= monitor.y);
          assert.ok(box.x + box.width <= monitor.x + monitor.width);
          assert.ok(box.y + box.height <= monitor.y + monitor.height);
        }
        // Labels and pictures stay adjacent after rotating the entire layout.
        assert.equal(tile.label.height, tile.bounds.height);
        assert.equal(tile.label.y, tile.bounds.y);
        if (rotation === 90) assert.equal(tile.bounds.x + tile.bounds.width, tile.label.x);
        else assert.equal(tile.label.x + tile.label.width, tile.bounds.x);
      }
      for (let a = 0; a < tiles.length; a++) for (let b = a + 1; b < tiles.length; b++) {
        const x = tiles[a].bounds, y = tiles[b].bounds;
        assert.ok(x.x + x.width < y.x || y.x + y.width < x.x || x.y + x.height < y.y || y.y + y.height < x.y);
      }
    });
  }
}
test('rotation defaults safely for existing settings and rejects arbitrary angles', () => {
  assert.equal(normalizeTestOutputSettings({enabled:true}).rotation, 0);
  assert.equal(normalizeTestOutputSettings({rotation:270}).rotation, 270);
  assert.throws(() => normalizeTestOutputSettings({rotation:45}), /rotation/);
  assert.throws(() => normalizeTestOutputSettings({rotation:'90'}), /rotation/);
});
