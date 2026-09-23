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
