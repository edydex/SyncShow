'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), vm = require('node:vm');
const sharp = require('sharp');
const core = require('../src/services/project/ServiceProject');
const { NativeSlideRenderer, markupTextSpans } = require('../src/services/project/NativeSlideRenderer');
const { compileNativeCueScene, sceneAssetIds } = require('../src/services/show/NativeCueScene');
const format = require('../src/services/project/SlideFormatting');

test('templates retain text emphasis and image assets through native scene and raster output', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(),'syncshow-template-'));
  t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
  const imagePath=path.join(directory,'title.png');
  await sharp({create:{width:640,height:360,channels:3,background:'#506080'}}).png().toFile(imagePath);
  let project=core.createServiceProject({id:'template',title:'Sunday',serviceDate:'2026-09-06',preferredProfileId:'main-sanctuary',
    presetPack:{id:'main-sanctuary',version:1,sha256:null}, channels:[{id:'english',label:'English',language:'en'}]});
  const sha='a'.repeat(64), assetId='sha256:'+sha;
  project=JSON.parse(JSON.stringify(project));
  project.assets[assetId]={id:assetId,sha256:sha,kind:'image',storedName:sha+'.png',fileName:'title.png',mediaType:'image/png',size:1000,width:640,height:360,orientation:1};
  project=core.addProjectItem(project,{id:'title',kind:'sermon',title:'Operator title',presetId:'wotbc-sermon-title',
    backgroundAssetId:assetId,textByChannel:{english:'Walk in love'},spansByChannel:{english:[{start:0,end:4,italic:true,underline:true,weight:'700',foreground:'#ffc000'}]}});
  const timeline=core.compileServiceProject(project), cue=timeline.cues[timeline.cueIds[0]];
  const scene=compileNativeCueScene(cue,'english',{width:640,height:360});
  assert.equal(scene.layout,'text');assert.equal(scene.body,'Walk in love');assert.equal(scene.backgroundAssetId,assetId);
  assert.deepEqual(sceneAssetIds(scene),[assetId]);assert.equal(scene.bodySpans[0].italic,true);
  const browser=vm.createContext({window:{}});
  vm.runInContext(fs.readFileSync(path.join(__dirname,'../src/renderer/native-cue-renderer.js'),'utf8'),browser);
  assert.equal(browser.window.SyncShowNativeCueRenderer.validateScene(scene).backgroundAssetId,assetId);
  const frame=await new NativeSlideRenderer({width:640,height:360,resolveAsset:()=>imagePath}).renderCue(cue,'english');
  assert.equal(frame.metadata.text,'Walk in love');
  const pixel=await sharp(frame.info.data).extract({left:0,top:0,width:1,height:1}).raw().toBuffer();
  assert.ok(pixel[0]>10&&pixel[2]>pixel[0],'image remains visible behind the title');
  const markup=markupTextSpans('Walk in love',scene.bodySpans);
  assert.match(markup,/style="italic"/);assert.match(markup,/underline="single"/);
  const invalid=JSON.parse(JSON.stringify(scene));invalid.bodySpans[0].italic='yes';
  assert.throws(()=>browser.window.SyncShowNativeCueRenderer.validateScene(invalid));
});

test('Scripture style ranges use the same superscript text in web and native renderers',()=>{
  const verses=[{number:16,text:'First verse.'},{number:17,text:'Second verse.'}];
  const body=format.scriptureFlowText(verses);
  const cue={id:'cue-0123456789abcdef01234567',kind:'bible',title:'Psalm 18',presetId:'wotbc-sermon-verse',channels:{english:{mode:'content',blocks:[{
    type:'bible',reference:'Psalm 18:16–17',translationId:'BSB',attribution:'',verses,
    spans:[{start:0,end:body.length,italic:true,underline:true,foreground:'#ffc000'}]
  }]}}};
  const scene=compileNativeCueScene(cue,'english');
  assert.equal(scene.body,body);assert.equal(scene.bodySpans[0].end,body.length);
  assert.equal(scene.style.titleForeground,'#ffc000');
});
