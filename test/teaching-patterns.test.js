'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { palette, inkAt, family, convert } = require('../src/remote/teaching-patterns');
const { TeachingSurface } = require('../src/services/show/TeachingSurface');
test('every teaching color has a distinct named monochrome tile', () => {
  const tiles = palette.map((item,index) => Array.from({length:64},(_,p)=>Number(inkAt(index,p%8,Math.floor(p/8)))).join(''));
  assert.equal(new Set(tiles).size, palette.length);
  assert.deepEqual(palette.slice(0,4).map(item => family(...item.color.slice(1).match(/../g).map(n=>parseInt(n,16)))),[0,1,2,3]);
});
test('conversion keeps source pixels and alpha intact, preserves neutral text, and outlines thin colored marks', () => {
  const width=24,height=24,data=new Uint8ClampedArray(width*height*4);
  for(let p=0;p<width*height;p++) data.set([255,255,255,255],p*4);
  for(let x=2;x<22;x++)data.set([239,68,68,200],(10*width+x)*4);
  data.set([40,40,40,120],0);
  const before=Buffer.from(data),result=convert(data,width,height);
  assert.deepEqual(Buffer.from(data),before);
  assert.deepEqual([...result.slice(0,4)],[40,40,40,120]);
  for(let x=2;x<22;x++)assert.deepEqual([...result.slice((10*width+x)*4,(10*width+x)*4+4)],[17,17,17,200]);
  for(let i=0;i<result.length;i+=4){assert.equal(result[i],result[i+1]);assert.equal(result[i+1],result[i+2]);assert.equal(result[i+3],data[i+3]);}
});
test('legend is derived from current output ink, survives cue return, and disappears with undo', () => {
  const context={sessionId:'show',cueKey:'one',ready:true,outputs:[{id:'en'},{id:'ru'}]};
  const surface=new TeachingSurface({readContext:()=>context});
  const stroke={id:'11111111-1111-4111-8111-111111111111',tool:'pen',color:'#ef4444',width:.008,points:[[.1,.2],[.8,.2]],finished:true};
  const before=JSON.stringify(stroke);
  surface.apply({operation:'stroke',surfaceId:surface.state('en').frame.surfaceId,outputId:'en',stroke});
  assert.deepEqual(surface.state('en').frame.inkColors,['#ef4444']);assert.deepEqual(surface.state('ru').frame.inkColors,[]);
  context.cueKey='two';assert.deepEqual(surface.state('en').frame.inkColors,[]);
  context.cueKey='one';assert.deepEqual(surface.state('en').frame.inkColors,['#ef4444']);
  assert.deepEqual(surface.frame('en').strokes[0],JSON.parse(before));
  surface.apply({operation:'undo',surfaceId:surface.state('en').frame.surfaceId,outputId:'en'});
  assert.deepEqual(surface.state('en').frame.inkColors,[]);
});
