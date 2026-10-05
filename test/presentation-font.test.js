'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {presentationFont}=require('../src/services/project/PresentationFont');
test('Arial needs all four installed faces; missing faces use the complete bundled fallback',()=>{
 const fallback=presentationFont({platform:'linux',exists:()=>false});
 assert.equal(fallback.family,'Liberation Sans');
 assert.equal(fallback.faces.length,4);
 for(const face of fallback.faces) assert.ok(fs.statSync(face.path).size>100000);
 const arial=presentationFont({platform:'win32',systemRoot:'C:/Windows',exists:()=>true});
 assert.equal(arial.family,'Arial');
 assert.match(arial.fontPath,/arial\.ttf$/);
 assert.deepEqual(arial.faces.map(face=>path.basename(face.path)),['arial.ttf','arialbd.ttf','ariali.ttf','arialbi.ttf']);
 const incomplete=presentationFont({platform:'darwin',exists:file=>file.endsWith('Arial.ttf')});
 assert.equal(incomplete.family,'Liberation Sans');
});
