'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const sharp = require('sharp');
const core = require('../src/services/project');
const { NativeSlideRenderer } = require('../src/services/project/NativeSlideRenderer');
function project() {
  return core.createServiceProject({id:'sermon-templates',title:'Sunday',serviceDate:'2026-09-06',
    profileId:'main-sanctuary',preferredProfileId:'main-sanctuary',presetPack:{id:'main-sanctuary',version:1,sha256:null},
    channels:[{id:'english',label:'English',language:'en'},{id:'russian',label:'Russian',language:'ru'},{id:'media',label:'Singers',language:'ru'}]});
}
function cue(project) { const timeline=core.compileServiceProject(project); return timeline.cues[timeline.cueIds[0]]; }
test('sermon image controls and empty on-slide fields survive native serialization',()=>{
  const value=core.addProjectItem(project(),{id:'title',kind:'sermon',title:'Sermon title',sermonTemplate:'title',
    textByChannel:{english:'',russian:'',media:''},sermonPresentation:{showText:false,darkenBackground:false},presetId:'wotbc-sermon-title'});
  const reopened=JSON.parse(core.serializeServiceProject(value));
  assert.deepEqual(reopened.items.title.sermonPresentation,{showText:false,darkenBackground:false});
  assert.deepEqual(cue(reopened).channels.english.blocks,[]);
  const point=core.addProjectItem(project(),{id:'point',kind:'sermon',title:'Main point',sermonTemplate:'point',
    pendingPointChannels:['english','russian','media'],textByChannel:{english:'I. Love',russian:'',media:''},presetId:'wotbc-sermon'});
  assert.deepEqual(JSON.parse(core.serializeServiceProject(point)).items.point.pendingPointChannels,['english','russian','media']);
  assert.equal(cue(point).channels.english.blocks[0].text,'I. Love');
  assert.throws(()=>core.addProjectItem(project(),{id:'bad',kind:'sermon',title:'Bad',sermonTemplate:'point',
    pendingPointChannels:['unknown'],textByChannel:{english:''},presetId:'wotbc-sermon'}),/outputs/);
});
test('picture-only sermon output is undimmed; text and darkening switch independently',async()=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'sermon-render-test-'));
  try {
    const imagePath=path.join(dir,'image.png');
    await sharp({create:{width:320,height:180,channels:3,background:'#c8a064'}}).png().toFile(imagePath);
    const assetId='sha256:'+ 'a'.repeat(64);
    const base=JSON.parse(JSON.stringify(project()));
    base.assets[assetId]={id:assetId,kind:'image',sha256:'a'.repeat(64),fileName:'image.png',storedName:'a'.repeat(64)+'.png',
      mediaType:'image/png',size:(await fs.stat(imagePath)).size,width:320,height:180,orientation:1,altText:'Background',attribution:''};
    const value=JSON.parse(JSON.stringify(core.addProjectItem(base,{id:'title',kind:'sermon',title:'Operator-only title',sermonTemplate:'title',
      textByChannel:{english:'Subtitle'},titlesByChannel:{english:'Visible title'},
      spansByChannel:{english:[{start:0,end:3,underline:true}]},
      backgroundAssetId:assetId,sermonPresentation:{showText:false,darkenBackground:false},presetId:'wotbc-sermon-title'})));
    const renderer=new NativeSlideRenderer({width:640,height:360,fontPath:path.resolve(__dirname,'../assets/fonts/NotoSans-Variable.ttf'),resolveAsset:async()=>imagePath});
    const bright=await renderer.renderCue(cue(value),'english');
    const brightStats=await sharp(bright.info.data).stats();
    assert.ok(brightStats.channels[0].mean>190);
    value.items.title.sermonPresentation.darkenBackground=true;
    const dark=await renderer.renderCue(cue(value),'english');
    const darkStats=await sharp(dark.info.data).stats();
    assert.ok(darkStats.channels[0].mean>80 && darkStats.channels[0].mean<100);
    value.items.title.sermonPresentation.showText=true;
    const visibleCue=cue(value);
    assert.ok(visibleCue.channels.english.blocks[1].spans.every(span=>span.fontScale===0.65),'all subtitle runs retain their smaller size');
    const visible=await renderer.renderCue(visibleCue,'english');
    assert.notDeepEqual(visible.info.data,dark.info.data);
    value.items.title.sermonPresentation.showText=false;
    assert.deepEqual((await renderer.renderCue(cue(value),'english')).info.data,dark.info.data,'hiding text keeps the image and dim choice');
  } finally { await fs.rm(dir,{recursive:true,force:true}); }
});
