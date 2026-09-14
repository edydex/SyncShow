'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { TeachingSurface } = require('../src/services/show/TeachingSurface');
const stroke = (overrides = {}) => ({ id: '11111111-1111-4111-8111-111111111111', tool: 'pen', color: '#ef4444', width: .008, points: [[.1,.2],[.4,.6]], finished: true, ...overrides });
function fixture() {
  const context = { sessionId: 'show-1', cueKey: 'cue-1', ready: true, outputs: [{ id:'en', name:'English', size:[1920,1080] }, { id:'ru', name:'Russian', size:[1920,1080] }] };
  const frames = [];
  const surface = new TeachingSurface({ readContext: () => context, changed: (model, state) => frames.push(model.frame('en', state)) });
  const request = extra => ({surfaceId: surface.state('en').frame.surfaceId, outputId:'en', operation:'stroke', stroke:stroke(), ...extra});
  return {context, frames, surface, request};
}
test('ink is output-specific, restores on the previous cue, and is discarded at the end of the Show', () => {
  const {context, surface, request} = fixture();
  const old = request(); surface.apply(old);
  assert.equal(surface.frame('en').strokes.length,1); assert.equal(surface.frame('ru').strokes.length,0);
  context.cueKey='cue-2'; assert.equal(surface.frame('en').strokes.length,0);
  assert.throws(() => surface.apply(old), /slide changed/);
  context.cueKey='cue-1'; assert.equal(surface.frame('en').strokes.length,1);
  context.sessionId='show-2'; assert.equal(surface.frame('en').strokes.length,0);
});
test('clear, undo, resize and blackout fence delayed strokes; completed strokes are idempotent', () => {
  const {context, surface, request} = fixture();
  const old=request(); surface.apply(old); surface.apply(old);
  assert.equal(surface.frame('en').strokes.length,1);
  surface.apply(request({operation:'undo'})); assert.equal(surface.frame('en').strokes.length,0);
  assert.throws(() => surface.apply(old), /slide changed/);
  const current=request(); surface.apply(current);
  surface.apply(request({operation:'clear'})); assert.throws(() => surface.apply(current), /slide changed/);
  const beforeResize=request(); context.outputs[0].size=[1280,720]; assert.throws(() => surface.apply(beforeResize), /slide changed/);
  context.ready=false; assert.equal(surface.frame('en').visible,false); assert.throws(() => surface.apply(request()), /settled slide/);
});
test('rejects invalid coordinates, arbitrary colors, unsupported outputs and unbounded payloads', () => {
  const {surface, request}=fixture();
  for(const changes of [{points:[[NaN,0]]},{points:[[1.1,0]]},{points:[[0,0,0]]},{color:'url(bad)'},{width:10},{tool:'html'},{points:Array(1025).fill([0,0])}])
    assert.throws(() => surface.apply(request({stroke:stroke(changes)})), /Invalid drawing/);
  assert.throws(() => surface.apply(request({outputId:'stage'})), /available slide output/);
  assert.equal(surface.frame('en').strokes.length,0);
});
test('pointer expires per point without consuming ink or returning on an earlier slide', () => {
  const {surface, request, context} = fixture();
  let now = 10000; surface.now = () => now;
  surface.apply(request());
  const revision = surface.revision;
  const pointer = request({stroke: stroke({tool:'pointer', ages:[700,0]})});
  surface.apply(pointer);
  assert.equal(surface.revision, revision);
  assert.equal(surface.state('en').frame.strokeCount, 1);
  assert.deepEqual(surface.frame('en').trails[0].times, [9300,10000]);
  assert.equal(surface.frame('ru').trails.length, 0);
  now += 1001;
  assert.equal(surface.frame('en').trails.length, 0);
  now += 1000; surface.apply(pointer);
  context.cueKey='cue-2'; surface.sync(); context.cueKey='cue-1';
  assert.equal(surface.frame('en').trails.length, 0);
  assert.equal(surface.frame('en').strokes.length, 1);
  for (const ages of [[0,20],[NaN,0],[-1,0],[1001,0],[0]])
    assert.throws(() => surface.apply(request({stroke:stroke({tool:'pointer',ages})})), /pointer timing/);
});
test('pointer renderer clips expired fragments and stops scheduling after one second', () => {
  const {paintTrail} = require('../src/renderer/teaching-trail');
  const lines = [];
  const context = {beginPath(){},moveTo(x,y){lines.push([x,y]);},lineTo(x,y){lines.push([x,y]);},stroke(){},arc(){},fill(){}};
  const trail = {color:'#ef4444',width:.008,points:[[0,.5],[.5,.5],[1,.5]],times:[0,500,1000]};
  assert.equal(paintTrail(context,trail,100,100,1750),true);
  assert.deepEqual(lines,[[75,50],[100,50]],'only the most recent quarter of the line remains');
  lines.length=0;
  assert.equal(paintTrail(context,trail,100,100,2000),false);
  assert.equal(lines.length,0);
});
