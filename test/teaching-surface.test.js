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
