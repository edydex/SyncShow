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

  // Verses 10, 20, 30... need a superscript zero. Liberation Sans has none, so the
  // bundled one-glyph face must supply it at the width of the superscript one.
  const tens = compileNativeCueScene({id:'tens',kind:'bible',title:'Reading',presetId:'wotbc-reading',channels:{english:{mode:'content',blocks:[{
    type:'bible',reference:'John 3:10–20',translationId:'BSB',verses:[{number:10,text:'Ten.'},{number:20,text:'Twenty.'}]
  }]}}},'english');
  const zeros = await win.webContents.executeJavaScript(`(async()=>{
    await Promise.all(['400','700'].map(weight=>document.fonts.load(weight+' 16px "SyncShow Superscript Zero"','\\u2070')));
    const view=SyncShowNativeCueRenderer.buildScene(${JSON.stringify(tens)});
    Object.assign(view.element.style,{position:'fixed',inset:'0',zIndex:'999'});
    document.body.append(view.element);await view.prepare();view.relayout();
    const rows=[...view.element.querySelectorAll('.native-verse-start')].map(atom=>{
      const text=atom.firstChild,box=index=>{const range=document.createRange();range.setStart(text,index);range.setEnd(text,index+1);return range.getBoundingClientRect();};
      const lead=box(0),zero=box(1),word=box(3);
      return {text:atom.textContent,lead:lead.width,zero:zero.width,top:zero.top-lead.top,gap:word.left-zero.right};
    });
    view.destroy();view.element.remove();return rows;
  })()`);
  assert.deepEqual(zeros.map(row=>row.text),['¹⁰\u2060Ten.','²⁰\u2060Twenty.']);
  for (const row of zeros) {
    assert.ok(Math.abs(row.zero-row.lead)<=1 && Math.abs(row.top)<=1 && Math.abs(row.gap)<=1,`Superscript zero must match its neighbour: ${JSON.stringify(row)}`);
  }

  // While a caption band is shown, every lyric slide of a song uses the song's
  // precomputed caption size instead of shrinking slide by slide.
  const plain = (id,text) => ({id,itemId:'captioned',kind:'song',title:'Praise',presetId:'wotbc-song-lyrics',channels:{
    english:{mode:'content',blocks:[{type:'text',role:'lyrics',text}]}}});
  const captioned = {dense:plain('cap-dense',Array(9).fill('Holy holy holy Lord').join('\n')),middle:plain('cap-middle',Array(6).fill('Holy holy holy Lord').join('\n')),short:plain('cap-short','Holy holy holy')};
  applyTimelineTypography({items:{captioned:{id:'captioned'}}},captioned,{groupPathByItemId:{}});
  const captionSizes = captioned.dense.captionTextSizes;
  assert.ok(captionSizes?.ticker && captionSizes?.lowerThird,`The dense song needs caption sizes: ${JSON.stringify(captionSizes)}`);
  const captionScenes = Object.values(captioned).map(cue=>compileNativeCueScene(cue,'english'));
  const captionRows = await win.webContents.executeJavaScript(`(async()=>{
    const rows=[];
    try {
      for (const reservation of [0,.12,.29]) {
        SyncShowNativeCueRenderer.setCaptionReservation(reservation);
        for (const scene of ${JSON.stringify(captionScenes)}) {
          const view=SyncShowNativeCueRenderer.buildScene(scene);
          Object.assign(view.element.style,{position:'fixed',inset:'0',zIndex:'999'});
          document.body.append(view.element);await view.prepare();view.relayout();
          const body=view.element.querySelector('.native-scene-body'),surface=view.element.querySelector('.native-scene-surface');
          rows.push({reservation,cueId:scene.cueId,size:parseFloat(getComputedStyle(body).fontSize),scale:surface.clientWidth/1920,
            width:body.clientWidth,scrollWidth:body.scrollWidth,height:body.clientHeight,scrollHeight:body.scrollHeight});
          view.destroy();view.element.remove();
        }
      }
    } finally { SyncShowNativeCueRenderer.setCaptionReservation(0); }
    return rows;
  })()`);
  for (const [reservation,expected] of [[0,captioned.dense.textStyle.bodySize],[.12,captionSizes.ticker],[.29,captionSizes.lowerThird]]) {
    const rows = captionRows.filter(row=>row.reservation===reservation);
    assert.equal(rows.length,3);
    for (const row of rows) {
      assert.ok(Math.abs(row.size-expected*row.scale)<=.5,`Caption ${reservation}: ${row.cueId} must use the song size ${expected}: ${JSON.stringify(row)}`);
      assert.ok(row.scrollWidth<=row.width+1 && row.scrollHeight<=row.height+2,`Caption ${reservation}: ${row.cueId} overflows: ${JSON.stringify(row)}`);
    }
  }
  console.log('[Electron rehearsal] Song-wide audience/singer/caption sizes and gapless verse markers passed.',JSON.stringify({results,verse,zeros,captionSizes,captionRows}));
}
module.exports = {rehearseTypography};
