'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {NativeSlideRenderer}=require('../src/services/project/NativeSlideRenderer');
const {compileNativeCueScene}=require('../src/services/show/NativeCueScene');
const {scriptureDisplay}=require('../src/services/project/SlideFormatting');
const passage={type:'bible',reference:'Ephesians 4:25',translationId:'BSB',verses:[{number:25,text:'Therefore each of you must put off falsehood.'}],attribution:'Berean Standard Bible'};
const cue={id:'passage',kind:'bible',title:'Passage',presetId:'wotbc-sermon-scripture',channels:{english:{mode:'content',blocks:[{type:'text',role:'title',text:'I. Therefore'},passage]}}};
test('native scene and rendered frame retain current point and inline gold Scripture reference',async()=>{
 const scene=compileNativeCueScene(cue,'english',{width:1920,height:1080});
 assert.equal(scene.title,'I. Therefore');
 assert.equal(scene.body,scriptureDisplay(passage,cue.presetId).text);
 assert.equal(scene.bodySpans[0].foreground,'#ffc000');
 assert.equal(scene.style.titleAlign,'center');
 assert.equal(scene.style.bodyAlign,'left');
 const frame=await new NativeSlideRenderer().renderCue(cue,'english');
 assert.equal(frame.metadata.text,scriptureDisplay(passage,'wotbc-reading').text);
 assert.ok(frame.info.data.length>1000);
});
test('mid-service Scripture stays flowing without an inline reference heading',()=>{
 const reading={...cue,presetId:'wotbc-reading',channels:{english:{mode:'content',blocks:[passage]}}};
 const scene=compileNativeCueScene(reading,'english',{width:1920,height:1080});
 assert.equal(scene.style.showTitle,false);
 assert.ok(scene.body.startsWith('²⁵'));
 assert.equal(scene.body.includes('Ephesians'),false);
});
