'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),vm=require('node:vm');
const sharp=require('sharp');
const core=require('../src/services/project/ServiceProject');
const {NativeSlideRenderer,markupTextSpans}=require('../src/services/project/NativeSlideRenderer');
const {compileNativeCueScene,serializeNativeCueScene,sceneAssetIds,nativeSceneSingerLine}=require('../src/services/show/NativeCueScene');
const {canvasText}=require('../src/services/project/CanvasLayout');
function fixture(){
 const assetId=`sha256:${'a'.repeat(64)}`,frame={x:.08,y:.12,width:.7,height:.18,rotation:0};
 const objects=[{id:'text',type:'text',frame,text:'Love is patient · Любовь долготерпит',fontSize:64,color:'#ffffff',align:'left',spans:[{start:0,end:4,background:'#8a5a00',weight:'700'}]},
 {id:'photo',type:'image',frame:{x:.05,y:.4,width:.25,height:.4,rotation:15},assetId,altText:'Solid blue picture'},
 {id:'brace',type:'brace',frame:{x:.4,y:.4,width:.08,height:.4,rotation:0},color:'#ffc000',lineWidth:8},
 {id:'outline',type:'circle',frame:{x:.55,y:.45,width:.18,height:.32,rotation:0},color:'#ffc000',lineWidth:8,filled:false},
 {id:'filled',type:'circle',frame:{x:.77,y:.45,width:.18,height:.32,rotation:0},color:'#25b080',lineWidth:4,filled:true}];
 let project=core.createServiceProject({id:'canvas',title:'Sunday',serviceDate:'2026-09-16',preferredProfileId:'main-sanctuary',presetPack:{id:'main-sanctuary',version:1,sha256:null},channels:[{id:'english',label:'English',language:'en'},{id:'russian',label:'Russian',language:'ru'}]});
 project=JSON.parse(JSON.stringify(project));project.assets[assetId]={id:assetId,sha256:'a'.repeat(64),kind:'image',storedName:'a'.repeat(64)+'.png',fileName:'canvas.png',mediaType:'image/png',size:1000,width:640,height:360,orientation:1};
 project=core.addProjectItem(project,{id:'other',kind:'sermon',title:'Other',sermonTemplate:'other',presetId:'wotbc-sermon',textByChannel:{english:'',russian:''},objectsByChannel:{english:objects,russian:objects}});
 const timeline=core.compileServiceProject(project);return {cue:timeline.cues[timeline.cueIds[0]],assetId,objects,project};
}
test('canvas objects compile to validated desktop/browser scenes with offline image dependencies',async t=>{
 const {cue,assetId,objects}=fixture(),scene=compileNativeCueScene(cue,'english',{width:1280,height:720});
 assert.equal(scene.layout,'canvas');assert.equal(scene.objects.length,5);assert.deepEqual(sceneAssetIds(scene),[assetId]);
 assert.equal(nativeSceneSingerLine(scene),objects[0].text);assert.ok(serializeNativeCueScene(scene).includes('background'));
 const browser=vm.createContext({});browser.window=browser;
 for(const name of ['canvas-layout.js','native-cue-renderer.js'])vm.runInContext(fs.readFileSync(path.join(__dirname,'../src/renderer',name),'utf8'),browser);
 assert.equal(JSON.stringify(browser.SyncShowNativeCueRenderer.validateScene(scene)),JSON.stringify(scene));
 const bad=JSON.parse(JSON.stringify(scene));bad.objects[0].frame.rotation=Infinity;
 assert.throws(()=>browser.SyncShowNativeCueRenderer.validateScene(bad));
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'syncshow-canvas-'));t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
 const imagePath=path.join(directory,'picture.png');await sharp({create:{width:640,height:360,channels:3,background:'#3050d0'}}).png().toFile(imagePath);
 const renderer=new NativeSlideRenderer({width:1280,height:720,resolveAsset:()=>imagePath});
 const result=await renderer.renderCue(cue,'english');assert.equal(result.metadata.text,canvasText(objects));
 const pixels=await sharp(result.info.data).raw().toBuffer({resolveWithObject:true});
 const pixel=(x,y)=>[...pixels.data.subarray((y*pixels.info.width+x)*pixels.info.channels,(y*pixels.info.width+x)*pixels.info.channels+3)];
 assert.ok(pixel(1110,445)[1]>100,'filled green circle occupies its chosen position');
 assert.ok(pixel(819,438).every(value=>value<20),'outline circle keeps its center empty');
 assert.match(markupTextSpans('Love',[{start:0,end:4,background:'#8a5a00'}]),/background="#8a5a00"/);
});
module.exports={fixture};

test('canvas image and highlighted text remain available from an offline Show package',async t=>{
 const {ServiceProjectStore}=require('../src/services/project/ServiceProjectStore');
 const {ShowPackagePublisher}=require('../src/services/project/ShowPackagePublisher');
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'syncshow-canvas-package-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const store=new ServiceProjectStore({rootPath:path.join(dir,'projects')});
 const created=await store.create({id:'canvas-offline',title:'Canvas offline',serviceDate:'2026-09-16',profileId:'main-sanctuary'});
 const imagePath=path.join(dir,'picture.png');await sharp({create:{width:640,height:360,channels:3,background:'#3050d0'}}).png().toFile(imagePath);
 const imported=await store.importImage(created.project.id,{sourcePath:imagePath,expectedRevisionId:created.revisionId,altText:'Blue teaching diagram'});
 const objects=fixture().objects.map(value=>value.type==='image'?{...value,assetId:imported.asset.id}:value);
 const project=core.addProjectItem(imported.project,{id:'other',kind:'sermon',title:'Other',sermonTemplate:'other',presetId:'wotbc-sermon',textByChannel:Object.fromEntries(imported.project.channelIds.map(id=>[id,''])),objectsByChannel:Object.fromEntries(imported.project.channelIds.map(id=>[id,objects]))});
 const saved=await store.save(project,{expectedRevisionId:imported.revisionId});
 const publisher=new ShowPackagePublisher({projectStore:store,rootPath:path.join(dir,'packages')});
 const published=await publisher.publish({projectId:project.id,revisionId:saved.revisionId,roleMapping:{main:'primary',singers:'media'},width:1280,height:720,thumbnailWidth:160});
 fs.rmSync(path.join(dir,'projects'),{recursive:true,force:true});fs.unlinkSync(imagePath);
 const reopened=await publisher.open(published.manifest.id);
 assert.equal(reopened.presentations.main.scenes[0].layout,'canvas');
 assert.equal(reopened.presentations.main.scenes[0].objects[0].spans[0].background,'#8a5a00');
 assert(fs.existsSync(reopened.presentations.main.assetPaths[imported.asset.id]));
 assert.equal(reopened.presentations.singers.scenes[0].layout,'canvas');
});
