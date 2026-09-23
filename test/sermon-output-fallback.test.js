'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const core = require('../src/services/project');
const {NativeSlideRenderer, cueMetadataForChannel} = require('../src/services/project/NativeSlideRenderer');
const {compileNativeCueScene, normalizeNativeCueScene, resolveNativeCuePayload} = require('../src/services/show');
function project(item) {
  return core.addProjectItem(core.createServiceProject({id:'output-fallback',title:'Sunday',serviceDate:'2026-09-20',
    preferredProfileId:'main-sanctuary',presetPack:{id:'main-sanctuary',version:1,sha256:null},channels:[
      {id:'english',label:'English',language:'en'}, {id:'russian',label:'Russian',language:'ru'}, {id:'media',label:'Stage',language:'ru'}]}), item);
}
function compile(item) {const timeline=core.compileServiceProject(project(item)); return timeline.cues[timeline.cueIds[0]];}
const quote = {id:'quote',kind:'sermon',sermonTemplate:'quote',presetId:'wotbc-sermon-quote',title:'Operator label',
  titlesByChannel:{english:'Full heading'},textByChannel:{english:'Complete quotation',russian:'',media:''},
  spansByChannel:{english:[{start:0,end:8,weight:'700',foreground:'#ffc000'}]},quoteSourcesByChannel:{english:'Source'}};
test('missing sermon outputs inherit complete blocks with provenance and identical thumbnails', async()=>{
  const cue=compile(quote);
  for(const channel of ['russian','media']) {
    assert.deepEqual(cue.channels[channel].blocks,cue.channels.english.blocks);
    assert.equal(cue.channels[channel].fallbackFromChannelId,'english');
    assert.equal(cueMetadataForChannel(cue,channel).fallbackFromChannelId,'english');
    assert.deepEqual(compileNativeCueScene(cue,channel),compileNativeCueScene(cue,'english'));
  }
  const renderer=new NativeSlideRenderer({width:640,height:360,fontPath:path.resolve(__dirname,'../assets/fonts/NotoSans-Variable.ttf')});
  const [en,ru]=await Promise.all(['english','russian'].map(id=>renderer.renderCue(cue,id)));
  assert.deepEqual(en.info.data,ru.info.data);
  const authored=compile({...quote,textByChannel:{english:'Complete quotation',russian:'Полная цитата',media:''}});
  assert.equal(authored.channels.russian.fallbackFromChannelId,undefined);
  assert.equal(authored.channels.media.fallbackFromChannelId,'russian');
  assert.deepEqual(core.normalizeCueTimeline(core.compileServiceProject(project(quote))).cues,core.compileServiceProject(project(quote)).cues);
});
test('intentionally hidden titles and explicitly hidden channels are never filled from an operator label',()=>{
  const cue=compile({...quote,quoteSourcesByChannel:undefined,sermonTemplate:'title',presetId:'wotbc-sermon-title',sermonPresentation:{showText:false,darkenBackground:false}});
  for(const channel of Object.values(cue.channels)) assert.deepEqual(channel.blocks,[]);
  assert.equal(compileNativeCueScene(cue,'english').layout,'blank');
  const withoutRussian=compile({...quote,textByChannel:{english:'English only'}});
  assert.equal(withoutRussian.channels.russian.mode,'hide');
  const backgroundCue={...cue,channels:{english:{mode:'content',blocks:[{type:'image',role:'background',assetId:'sha256:'+'a'.repeat(64),dimOpacity:0}]}}};
  const scene=compileNativeCueScene(backgroundCue,'english');
  assert.equal(scene.body,'');assert.equal(scene.title,'');assert.equal(scene.backgroundDimOpacity,0);
  assert.deepEqual(normalizeNativeCueScene(scene),scene);
});
test('Stage blanks retain the next clue, audience blanks remain blank and the last cue means end',()=>{
  const blank=compileNativeCueScene({id:'blank',kind:'blank',channels:{media:{mode:'content',blocks:[{type:'blank'}]}}},'media');
  const next=compileNativeCueScene(compile(quote),'english');
  const presentation={renderer:'native-cue',scenes:[blank,next,blank],assetPaths:{}};
  assert.equal(resolveNativeCuePayload({presentation,cueIndex:0}).scene.layout,'blank');
  const stage=resolveNativeCuePayload({presentation,cueIndex:0,stageFacing:true}).scene;
  assert.equal(stage.current.layout,'blank');assert.deepEqual(stage.next,{state:'text',text:'Full heading'});
  assert.deepEqual(resolveNativeCuePayload({presentation,cueIndex:2,stageFacing:true}).scene.next,{state:'end',text:''});
  assert.equal(resolveNativeCuePayload({presentation,cueIndex:1,stageFacing:true}).scene,next);
  const imageNext={...next,title:'',body:'',backgroundAssetId:'sha256:'+'a'.repeat(64),bodySpans:[]};
  presentation.scenes[1]=imageNext; presentation.metadata={slides:[{}, {firstLine:'Next sermon'}]};
  assert.deepEqual(resolveNativeCuePayload({presentation,cueIndex:0,stageFacing:true}).scene.next,{state:'text',text:'Next sermon'});
});
