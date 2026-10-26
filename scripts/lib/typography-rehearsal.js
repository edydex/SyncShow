'use strict';
const assert = require('node:assert/strict');
const {applyTimelineTypography} = require('../../packages/service-core/node/services/project/SlideTypography');
const {compileNativeCueScene} = require('../../src/services/show/NativeCueScene');

// Use the real output window, CSS, fonts and renderer at both rehearsal sizes.
async function rehearseTypography(win) {
  const lyric = (id,text) => ({id,itemId:'song',kind:'song',title:'Praise',presetId:'wotbc-song-stacked',channels:{
    english:{mode:'content',blocks:[{type:'text',role:'lyrics',text},
      {type:'text',role:'lyrics',text,spans:[{start:0,end:text.length,fontScale:.85,foreground:'#ffc000'}]}]},
    media:{mode:'condensed',sourceChannelId:'english',sourceBlocks:[{type:'text',role:'lyrics',text}],blocks:[{type:'text',role:'lyrics',text:'Next cue'}]}
  }});
  const cues = {dense:lyric('dense',Array(6).fill('Мы славим Тебя / Sing Your praise').join('\n')),short:lyric('short','Sing Your praise')};
  applyTimelineTypography({items:{song:{id:'song'}}},cues,{groupPathByItemId:{}});
  const scenes = ['english','media'].flatMap(channel => Object.values(cues).map(cue=>({channel,scene:compileNativeCueScene(cue,channel)})));
  const results = await win.webContents.executeJavaScript(`(async () => {
    await document.fonts.ready;
    const results=[];
    for (const {channel,scene} of ${JSON.stringify(scenes)}) {
      const view=SyncShowNativeCueRenderer.buildScene(scene);
      Object.assign(view.element.style,{position:'fixed',inset:'0',zIndex:'999'});
      document.body.append(view.element);
      try {await view.prepare();view.relayout();} catch(error) {
        const body=view.element.querySelector('.native-scene-body');
        throw new Error(JSON.stringify({channel,scene,body:body && {width:body.clientWidth,scrollWidth:body.scrollWidth,height:body.clientHeight,scrollHeight:body.scrollHeight,size:getComputedStyle(body).fontSize}},null,2));
      }
      const body=view.element.querySelector('.native-scene-body');
      results.push({channel,size:parseFloat(getComputedStyle(body).fontSize),width:body.clientWidth,scrollWidth:body.scrollWidth,height:body.clientHeight,scrollHeight:body.scrollHeight});
      view.destroy();view.element.remove();
    }
    return results;
  })()`);
  for (const channel of ['english','media']) {
    const [dense,short] = results.filter(row=>row.channel===channel);
    assert.equal(dense.size,short.size,`${channel}: the short verse must keep the song size`);
    for (const row of [dense,short]) {
      assert.ok(row.scrollWidth<=row.width+1,`${channel}: lyric width overflow ${JSON.stringify(row)}`);
      assert.ok(row.scrollHeight<=row.height+1,`${channel}: lyric height overflow ${JSON.stringify(row)}`);
    }
  }
  const bible = compileNativeCueScene({id:'verse',kind:'bible',title:'Reading',presetId:'wotbc-reading',channels:{english:{mode:'content',blocks:[{
    type:'bible',reference:'John 3:16–17',translationId:'BSB',verses:[{number:16,text:'First verse.'},{number:17,text:'Second verse.'}],spans:[{start:3,end:8,weight:'700'}]
  }]}}},'english');
  const verse = await win.webContents.executeJavaScript(`(async()=>{
    const view=SyncShowNativeCueRenderer.buildScene(${JSON.stringify(bible)});
    Object.assign(view.element.style,{position:'fixed',inset:'0',zIndex:'999'});
    document.body.append(view.element);await view.prepare();view.relayout();
    const atom=view.element.querySelector('.native-verse-start');
    const marker=document.createRange();marker.setStart(atom.firstChild,0);marker.setEnd(atom.firstChild,2);
    const first=document.createRange();first.setStart(atom.children[0].firstChild,0);first.setEnd(atom.children[0].firstChild,1);
    const result={gap:first.getBoundingClientRect().left-marker.getBoundingClientRect().right,text:atom.textContent};
    view.destroy();view.element.remove();return result;
  })()`);
  assert.equal(verse.text,'¹⁶\u2060First');
  assert.ok(Math.abs(verse.gap)<=1,`The verse separator must have zero visual width: ${JSON.stringify(verse)}`);
  console.log('[Electron rehearsal] Song-wide audience/singer sizes and gapless verse markers passed.',JSON.stringify({results,verse}));
}
module.exports = {rehearseTypography};
