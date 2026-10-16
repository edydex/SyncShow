'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const {previewDisplayMap, outputIsPresented} = require('../src/services/show/PreviewShow');

test('preview renderers never inherit physical display IDs or saved screen geometry', () => {
  const outputs=[{id:'english',displayId:42},{id:'media',displayId:7}];
  const displays=previewDisplayMap(outputs);
  assert.deepEqual([...displays.keys()],['preview-output:english','preview-output:media']);
  assert.ok([...displays.values()].every(display=>display.previewOnly&&display.bounds.width===1920&&display.bounds.height===1080));
  assert.equal(outputs[0].displayId,42);
});

test('only intentional offscreen preview renderers count as active while hidden', () => {
  const win={isDestroyed:()=>false,isVisible:()=>false};
  assert.equal(outputIsPresented(win,true),false);
  win.syncShowPreviewOnly=true;
  assert.equal(outputIsPresented(win,true),true);
  assert.equal(outputIsPresented(win,false),false);
  win.isDestroyed=()=>true;
  assert.equal(outputIsPresented(win,true),false);
});
