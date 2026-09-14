'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const core = require('../src/services/project');
function fixture() {
  const base = core.createServiceProject({id:'single-song-slides',title:'Sunday',serviceDate:'2026-08-23',profileId:'main-sanctuary',
    channels:[{id:'english',label:'English',language:'en'},{id:'media',label:'Singers',language:'en'}]});
  const pinned = core.addSongResource(base,core.parseSongDocument('---\nid: song\ntitle: Grace\nlanguage: en\n---\n^1\nFirst line\nSecond line\n'));
  return core.addProjectItem(pinned.project,{id:'song',kind:'song',title:'Grace',variants:{
    english:{mode:'content',resourceId:pinned.resourceId},
    media:{mode:'derive',from:'english',transform:{id:'first-lines',version:1,maxLines:1}}},
    arrangement:[{id:'verse',sectionId:'verse-1'}],primaryChannelId:'english'});
}
function cues(project) { const timeline=core.compileServiceProject(project); return timeline.cueIds.map(id=>timeline.cues[id]); }
test('single lyric and title items compile independently and survive serialization',()=>{
  const original=fixture(), expected=cues(original);
  assert.equal(expected.length,2);
  const lyrics=JSON.parse(JSON.stringify(original)); lyrics.items.song.showTitle=false;
  const reopened=JSON.parse(core.serializeServiceProject(lyrics));
  assert.equal(reopened.items.song.showTitle,false);
  assert.equal(cues(reopened).length,1);
  assert.deepEqual(cues(reopened)[0].channels,expected[1].channels);
  assert.equal(cues(reopened)[0].channels.media.sourceBlocks[0].text,'First line\nSecond line');
  const title=JSON.parse(JSON.stringify(original)); title.items.song.showTitle=true; title.items.song.arrangement=[];
  assert.equal(cues(title).length,1);
  assert.deepEqual(cues(title)[0].channels,expected[0].channels);
});
test('legacy songs still show titles and invalid empty or ambiguous modes are rejected',()=>{
  const project=fixture();
  assert.equal(cues(project).length,2);
  for (const mode of ['false',null,0]) {
    const changed=JSON.parse(JSON.stringify(project)); changed.items.song.showTitle=mode;
    assert.throws(()=>core.normalizeServiceProject(changed),error=>error.code==='INVALID_SONG_TITLE_MODE');
  }
  for (const mode of [undefined,false]) {
    const changed=JSON.parse(JSON.stringify(project)); changed.items.song.arrangement=[]; changed.items.song.showTitle=mode;
    assert.throws(()=>core.normalizeServiceProject(changed),error=>error.code==='INVALID_ARRANGEMENT');
  }
});

