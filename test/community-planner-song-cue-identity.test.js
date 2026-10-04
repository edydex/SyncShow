'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
const core=require('../src/services/project');
const heritage=require('../src/services/community/HeritageServiceDocument');
const {CommunityPlannerCache}=require('../src/services/community/CommunityPlannerCache');
const origin='https://community.test';

function originalSong() {
  let project=core.createServiceProject({id:'song-correction',title:'Song correction',serviceDate:'2026-10-04',preferredProfileId:'main-sanctuary',presetPack:{id:'main-sanctuary',version:1,sha256:null},channels:[
    {id:'english',label:'English',language:'en'},{id:'russian',label:'Russian',language:'ru'}]});
  const song=core.parseSongDocument('---\nid: original-song\ntitle: Original song\nlanguage: en\n---\n^chorus\nOriginal words\n');
  const added=core.addSongResource(project,song);project=added.project;
  return core.addProjectItem(project,{id:'song',kind:'song',title:'Original song',primaryChannelId:'english',
    variants:{english:{mode:'content',resourceId:added.resourceId},russian:{mode:'content',resourceId:added.resourceId}},
    arrangement:[{id:'first',sectionId:'chorus'},{id:'repeat',sectionId:'chorus'}]});
}
function correctedSong(original) {
  let next=structuredClone(original);
  for(const channelId of next.channelIds) {
    const originalResource=original.resources[original.items.song.variants[channelId].resourceId];
    const document=structuredClone(originalResource.document),section=structuredClone(document.sections[0]);
    section.id='local-occurrence-1';section.marker=section.id;
    if(channelId==='english')section.slides[0].lines=['Corrected words'];
    document.sections.push(section);
    const added=core.addSongResource(next,document);next=structuredClone(added.project);
    next.items.song.variants[channelId].resourceId=added.resourceId;
  }
  next.items.song.arrangement[0]={id:'first',sectionId:'local-occurrence-1',cueSectionId:'chorus'};
  next.revision++;
  return core.normalizeServiceProject(next);
}
function structurallyEditedSong(original) {
  const next=structuredClone(original),song=next.items.song;
  const first=structuredClone(song),title=structuredClone(song);
  first.id='song-page';first.cueItemId='song';first.showTitle=false;
  first.arrangement=[{...song.arrangement[0],cueSourceLeafKey:'first/chorus-slide-1'}];
  title.id='song-title';title.cueItemId='song';title.showTitle=true;title.arrangement=[];
  next.items.song={id:'song',kind:'group',groupKind:'section',title:song.title,childIds:[title.id,first.id]};
  next.items[first.id]=first;next.items[title.id]=title;next.revision++;
  return core.normalizeServiceProject(next);
}
function envelope(project,syncVersion=1) {
  return {...heritage.validateHeritageServiceDocumentSource(heritage.serializeHeritageServiceDocument(heritage.createHeritageServiceDocument(project))),
    schemaVersion:1,syncId:project.id,syncVersion,status:'planning',changedAt:new Date().toISOString()};
}
function cueIds(project){return core.compileServiceProject(project).cueIds;}

for(const structural of [false,true])for(const oldServer of [false,true])test(`stable ${structural?'structural':'repeated'}-song identity survives local history, restart and ${oldServer?'an older server rejecting the extension':'canonical background synchronization'}`,async t=>{
  const rootPath=await fs.mkdtemp(path.join(os.tmpdir(),'song-cue-cache-'));
  t.after(()=>fs.rm(rootPath,{recursive:true,force:true}));
  const original=originalSong(),correction=correctedSong(original),corrected=structural?structurallyEditedSong(correction):correction;
  const ids=structural?cueIds(original).slice(0,2):cueIds(original);
  assert.deepEqual(cueIds(corrected),ids);
  let remote=envelope(original),lastWrite;
  const fetch=async request=>{
    lastWrite=await request.json();
    const validated=heritage.validateHeritageServiceDocumentSource(lastWrite.documentSource);
    if(oldServer) {
      const stripped=structuredClone(validated.project);
      for(const item of Object.values(stripped.items))if(item.kind==='song'){
        delete item.cueItemId;
        for(const entry of item.arrangement){delete entry.cueSectionId;delete entry.cueSourceLeafKey;}
      }
      assert.notEqual(envelope(stripped).documentSource,lastWrite.documentSource,'An older canonical-source endpoint rejects this extension instead of silently changing cues');
      return new Response(JSON.stringify({error:'The service content is not canonical.'}),{status:400});
    }
    remote={...remote,...validated,syncVersion:remote.syncVersion+1};
    return new Response(JSON.stringify({serviceDocument:remote}),{headers:{'Content-Type':'application/json'}});
  };
  const cache=new CommunityPlannerCache({rootPath,origin,fetch,backgroundSync:true});
  await cache.pinActiveShow(remote,remote);cache.offline=true;
  const documentSource=envelope(corrected).documentSource;
  const response=await cache.request(new Request(`${origin}/api/community/service-documents/${original.id}`,{method:'PUT',
    headers:{'Content-Type':'application/json'},body:JSON.stringify({schemaVersion:1,requestId:'correct-repeat-1',syncId:original.id,
      baseRevision:remote.revision,baseSyncVersion:remote.syncVersion,documentSource,status:'planning',saveKind:'manual'})}));
  assert.equal(response.status,200);assert.equal((await response.json()).serviceDocument.desktop.pending,true);
  assert.deepEqual(cueIds(cache.envelope(original.id).project),ids);
  const history=JSON.parse(await fs.readFile(path.join(rootPath,'history',`${cache.state.history[original.id][0].id}.json`),'utf8'));
  assert.deepEqual(cueIds(history.project),ids);
  const restarted=new CommunityPlannerCache({rootPath,origin,fetch,backgroundSync:true});
  await restarted.loaded;assert.deepEqual(cueIds(restarted.envelope(original.id).project),ids);
  await restarted.flush();
  assert.equal(lastWrite.documentSource,documentSource);
  const firstItem=structural?'song-page':'song';
  assert.equal(restarted.envelope(original.id).project.items[firstItem].arrangement[0].cueSectionId,'chorus');
  if(structural){
    assert.equal(restarted.envelope(original.id).project.items[firstItem].cueItemId,'song');
    assert.equal(restarted.envelope(original.id).project.items[firstItem].arrangement[0].cueSourceLeafKey,'first/chorus-slide-1');
  }
  assert.deepEqual(cueIds(restarted.envelope(original.id).project),ids);
  if(oldServer) {
    assert.equal(restarted.summary().pending,1);
    assert.equal(restarted.envelope(original.id).desktop.conflict,true);
    assert.deepEqual(remote.project,original,'Rejected synchronization never alters the server copy');
  } else {
    assert.equal(restarted.summary().pending,0);
    assert.equal(remote.project.items[firstItem].arrangement[0].cueSectionId,'chorus');
    assert.deepEqual(cueIds(remote.project),ids);
  }
  assert.equal(core.compileServiceProject(corrected).cues[ids[1]].channels.english.blocks[0].text,'Corrected words');
  if(!structural)assert.equal(core.compileServiceProject(corrected).cues[ids[2]].channels.english.blocks[0].text,'Original words');
});

test('service-local cue identity is bounded to one emitted song slide and copies receive fresh identities',()=>{
  const original=originalSong(),corrected=structurallyEditedSong(correctedSong(original)),ids=cueIds(corrected);
  const copy=core.duplicateProjectItem(corrected,{itemId:'song-page',randomUUID:()=> 'unique-page-copy'});
  assert.equal(copy.items[copy.rootItemIds.at(-1)].cueItemId,undefined);
  const duplicated=cueIds(copy);
  assert.deepEqual(duplicated.slice(0,ids.length),ids);
  assert(!ids.includes(duplicated.at(-1)));
  const invalid=structuredClone(original);invalid.items.song.cueItemId='song';
  assert.throws(()=>core.normalizeServiceProject(invalid),error=>error.code==='INVALID_SONG_CUE_IDENTITY');
  for(const key of ['title','../verse','first/page/extra','first/'+'x'.repeat(300)]){
    const invalid=structuredClone(corrected);invalid.items['song-page'].arrangement[0].cueSourceLeafKey=key;
    assert.throws(()=>core.normalizeServiceProject(invalid));
  }
  const invalidPages=structuredClone(corrected),pageItem=invalidPages.items['song-page'];
  const document=structuredClone(invalidPages.resources[pageItem.variants.english.resourceId].document);
  document.sections.find(section=>section.id===pageItem.arrangement[0].sectionId).slides.push({lines:['Another page']});
  const repinned=core.addSongResource(invalidPages,document),multiPage=structuredClone(repinned.project);
  multiPage.items['song-page'].variants.english.resourceId=repinned.resourceId;
  assert.throws(()=>core.normalizeServiceProject(multiPage),error=>error.code==='INVALID_SONG_CUE_IDENTITY');
  const collision=structuredClone(corrected),page=structuredClone(collision.items['song-page']);
  page.id='colliding-page';collision.items[page.id]=page;collision.rootItemIds.push(page.id);
  assert.throws(()=>core.compileServiceProject(collision),error=>error.code==='CUE_ID_COLLISION');
});
