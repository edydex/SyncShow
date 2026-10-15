'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
const flow=require('../packages/service-core/node/services/project/PresentationText');
const {compileNativeCueScene,normalizeNativeCueScene}=require('../src/services/show/NativeCueScene');
const {markupTextSpans}=require('../src/services/project/NativeSlideRenderer');
const context=vm.createContext({window:{}});vm.runInContext(fs.readFileSync(path.join(__dirname,'../src/renderer/native-cue-renderer.js'),'utf8'),context);
const body='I. Main point\n\u00a0\u00a0\u00a0\u00a0A. Long point with a continuation\ncontinued wording\n    Б. Русский подпункт\nII. Final point';
const cue={id:'cue-outline-fixture',kind:'sermon',title:'Operator',presetId:'wotbc-sermon',channels:{russian:{mode:'content',blocks:[{type:'text',role:'body',text:body,spans:[{start:28,end:33,underline:true}]}]}}};
test('one paragraph parser preserves Roman, numeric, Latin and Cyrillic prefix offsets and explicit continuation lines',()=>{
 const rows=flow.outlineParagraphs(body);assert.equal(rows.length,4);assert.equal(body.slice(rows[1].start,rows[1].prefixEnd),'\u00a0\u00a0\u00a0\u00a0A. ');assert.match(body.slice(rows[1].prefixEnd,rows[1].end),/\ncontinued wording$/);assert.equal(body.slice(rows[2].start,rows[2].prefixEnd),'    Б. ');
 assert.equal(rows.map(r=>body.slice(r.start,r.end)).join('\n'),body);
});
test('outline indentation survives native scene and browser validation, while old scene versions stay readable',()=>{
 const scene=compileNativeCueScene(cue,'russian');assert.deepEqual(scene.bodyOutline,flow.outlineParagraphs(body));assert.deepEqual(normalizeNativeCueScene(scene),scene);assert.equal(context.window.SyncShowNativeCueRenderer.validateScene(scene).bodyOutline.length,4);
 assert.equal(compileNativeCueScene(cue,'russian',{rendererVersion:20}).bodyOutline,undefined);
 for(const change of [rows=>rows[0].prefixEnd=9999,rows=>rows[1].start++,rows=>rows.at(-1).end--]){const invalid=structuredClone(scene);change(invalid.bodyOutline);assert.throws(()=>normalizeNativeCueScene(invalid));assert.throws(()=>context.window.SyncShowNativeCueRenderer.validateScene(invalid));}
});
test('verse numbers and the first word remain an unbroken Pango atom across emphasis runs without changing text offsets',()=>{
 const text='word ¹⁸\u00a0будучи помрачены ²⁰\u00a0Но вы';const atoms=flow.verseWordRanges(text);assert.deepEqual(atoms.map(r=>text.slice(r.start,r.end)),['¹⁸\u00a0будучи','²⁰\u00a0Но']);
 const start=text.indexOf('будучи');const markup=markupTextSpans(text,[{start,end:start+6,weight:'700'}]);assert.match(markup,/<span allow_breaks="false">¹⁸\u00a0<span weight="700">будучи<\/span><\/span>/);assert.equal(markup.replace(/<[^>]*>/g,''),text);
});

test('native raster continuation lines stay in the indented text column, with the source characters intact',async()=>{
 const sharp=require('sharp');const {NativeSlideRenderer}=require('../src/services/project/NativeSlideRenderer');
 const text='I. Main point\n    A. A long subpoint that continues onto another line and must retain the same left edge when its text wraps over.';
 const value={...cue,channels:{russian:{mode:'content',blocks:[{type:'text',role:'body',text}]}}};
 const rendered=await new NativeSlideRenderer({width:640,height:360}).renderCue(value,'russian');
 const {data,info}=await sharp(rendered.info.data).raw().toBuffer({resolveWithObject:true});const lines=[];let line=null;
 for(let y=0;y<info.height;y++){let left=Infinity;for(let x=0;x<info.width;x++){const i=(y*info.width+x)*info.channels;if(data[i]>180&&data[i+1]>180&&data[i+2]>180)left=Math.min(left,x)}if(left<Infinity){if(!line){line={left};lines.push(line)}line.left=Math.min(line.left,left)}else line=null;}
 assert.ok(lines.length>=3,'the fixture wraps across at least three visible lines');
 assert.ok(lines.at(-1).left>40,'continuation text stays after the four-space indent and the letter marker');
 assert.ok(lines[0].left<20,'main point remains at the outer margin');
});
