'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const core = require('../src/services/project/ServiceProject');
const { parseSongDocument } = require('../src/services/project/SongDocument');
const { compileNativeCueScene } = require('../src/services/show/NativeCueScene');
const { NativeSlideRenderer } = require('../src/services/project/NativeSlideRenderer');

function songProject() {
  let project = core.createServiceProject({ id: 'church-test', title: 'Sunday', serviceDate: '2026-08-23',
    preferredProfileId:'main-sanctuary', presetPack:{id:'main-sanctuary',version:1,sha256:null},
    channels: [{ id:'english', label:'English', language:'en' }, { id:'russian',label:'Russian',language:'ru' }, { id:'media',label:'Singers',language:'ru' }] });
  const resources = {};
  for (const [channel, title, lines] of [['english','Song','English one\nEnglish two'],['russian','Песня','Первая строка\nВторая строка']]) {
    const added = core.addSongResource(project, parseSongDocument('---\nid: song-' + channel + '\ntranslationOf: song\ntitle: ' + title + '\nlanguage: ' + (channel === 'english' ? 'en' : 'ru') + '\n---\n\n^1\n' + lines, {fileName:channel+'.md'}));
    project = added.project; resources[channel] = added.resourceId;
  }
  return core.addProjectItem(project, { id:'song',kind:'song',title:'Song',
    variants: {english:{mode:'content',resourceId:resources.english},russian:{mode:'content',resourceId:resources.russian},
      media:{mode:'derive',from:'russian',transform:{id:'first-lines',version:1,maxLines:2},titleCardMode:'simple'}},
    primaryChannelId:'english',arrangement:[{id:'one',sectionId:'verse-1'}],
    songPresentation:{stackedTranslation:true,primaryChannelId:'russian',secondaryChannelId:'english',credits:'Writer Name'},
    titlePresetId:'wotbc-song-title',lyricsPresetId:'wotbc-song-stacked' });
}

test('church stacked compile, scene and raster preserve shared language order and orange secondary text', async () => {
  const project = songProject();
  const timeline = core.compileServiceProject(project);
  const title = timeline.cues[timeline.cueIds[0]], lyric = timeline.cues[timeline.cueIds[1]];
  assert.deepEqual(title.channels.english.blocks,title.channels.russian.blocks);
  assert.deepEqual(lyric.channels.english.blocks,lyric.channels.russian.blocks);
  assert.equal(title.channels.english.blocks[0].text,'Песня');
  assert.equal(title.channels.english.blocks[2].text,'Writer Name');
  assert.equal(lyric.channels.media.blocks.length,1);
  const scene = compileNativeCueScene(lyric,'english',{width:1920,height:1080});
  assert.equal(scene.body,'Первая строка\nВторая строка\nEnglish one\nEnglish two');
  assert.equal(scene.body.slice(scene.bodySpans[0].start),'English one\nEnglish two');
  assert.equal(scene.bodySpans[0].foreground,'#ffc000');
  assert.equal(scene.style.bodyWidthPercent,98);
  const intro = compileNativeCueScene(title,'english',{width:1920,height:1080});
  assert.equal(intro.style.subtitleForeground,'#ffc000');
  assert.equal(intro.style.creditRightPercent,2);
  const renderer = new NativeSlideRenderer();
  for (const cue of [title,lyric]) {
    const frame = await renderer.renderCue(cue,'english');
    assert.equal(frame.info.width,1920);
    assert.equal(frame.info.height,1080);
  }
  const off = JSON.parse(JSON.stringify(project)); off.items.song.songPresentation.stackedTranslation = false;
  const single = core.compileServiceProject(off);
  const singleLyrics = single.cues[single.cueIds[1]];
  assert.equal(singleLyrics.channels.english.blocks.length,1);
  assert.notEqual(singleLyrics.channels.english.blocks[0].text,singleLyrics.channels.russian.blocks[0].text);
});

test('church readings and sermons have separate wide layouts without changing stable presets', () => {
  const base = { id:'cue-0123456789abcdef01234567',kind:'sermon',title:'Operator title',
    presetId:'wotbc-sermon',channels:{english:{mode:'content',blocks:[
      {type:'text',role:'title',text:'Sermon heading'},
      {type:'text',role:'body',text:'Eph.4:1 Therefore...',spans:[{start:0,end:7,foreground:'#ffc000',weight:'700'}]}]}} };
  const scene = compileNativeCueScene(base,'english',{width:1920,height:1080});
  assert.equal(scene.style.titleForeground,'#ffc000');
  assert.equal(scene.style.titleAlign,'center');
  assert.equal(scene.style.bodyAlign,'left');
  assert.equal(scene.style.bodyWidthPercent,98);
  assert.equal(scene.style.bodyTopPercent,15);
  const old = compileNativeCueScene({...base,presetId:'sermon-point'},'english',{width:1920,height:1080});
  assert.equal(old.style.bodyWidthPercent,82);
  assert.equal(old.style.bodyAlign,'center');
});
