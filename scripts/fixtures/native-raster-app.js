'use strict';
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs/promises'), path = require('node:path'), assert = require('node:assert/strict');
const sharp = require('sharp');
const { ServiceProjectStore } = require('../../src/services/project/ServiceProjectStore');
const { addProjectItem, compileServiceProject } = require('../../src/services/project');
const { compileNativeCueScene } = require('../../src/services/show/NativeCueScene');
const { NativeSlideRenderer } = require('../../src/services/project/NativeSlideRenderer');
const { BrowserSlideRenderer } = require('../../src/services/project/BrowserSlideRenderer');
const { LegacyServiceFallback } = require('../../src/services/project/LegacyServiceFallback');
const root = process.env.SYNCSHOW_RASTER_TEST_ROOT;
if (!root) throw new Error('An isolated raster test directory is required.');
app.setPath('userData', path.join(root, 'profile'));
app.on('window-all-closed', () => {});
app.whenReady().then(async () => {
  const fontPath = require('../../src/services/project/PresentationFont').presentationFont().fontPath;
  const store = new ServiceProjectStore({ rootPath: path.join(root, 'projects') });
  const created = await store.create({ id: 'raster-rehearsal', title: 'Rendering rehearsal', serviceDate: '2026-10-04', profileId: 'test-venue' });
  const project = addProjectItem(created.project, { id: 'notice', kind: 'notice', title: '',
    textByChannel: { primary: Array(8).fill('English slide text with several words.').join('\n'),
      media: Array(8).fill('Русский текст с несколькими словами.').join('\n') }, presetId: 'wotbc-song-lyrics',
    textStyle: { bodySize: 86 } });
  const saved = await store.save(project, { expectedRevisionId: created.revisionId });
  const rendererFactory = options => new BrowserSlideRenderer({ ...options, BrowserWindow, fontPath });
  const renderer = rendererFactory({ width: 1920, height: 1080, resolveAsset: () => {} });
  const timeline = compileServiceProject(saved.project);
  const cue = timeline.cues[timeline.cueIds[0]];
  const metrics = [];
  const pango = new NativeSlideRenderer({ fontPath, fontConfigCachePath: path.join(root, 'fonts') });
  try {
    const bilingual = {
      ...cue, kind: 'song', presetId: 'wotbc-song-stacked', textStyle: {bodySize: 90},
      channels: { primary: {mode:'content', blocks:[
        {type:'text', role:'lyrics', text:'Славим Тебя\nВо всех делах'},
        {type:'text', role:'lyrics', text:'We praise You\nIn all we do', spans:[{start:0,end:26,fontScale:.85,foreground:'#ffc000'}]}
      ]} }
    };
    await renderer.renderScene(compileNativeCueScene(bilingual,'primary',{width:1920,height:1080}));
    const layout = await renderer.win.webContents.executeJavaScript(`(() => {
      const primary=document.querySelector('.native-song-primary'), secondary=document.querySelector('.native-song-secondary');
      return {main:parseFloat(getComputedStyle(primary).fontSize), translation:parseFloat(getComputedStyle(secondary.querySelector('span')).fontSize),
        gap:secondary.getBoundingClientRect().top-primary.getBoundingClientRect().bottom,
        lineHeight:parseFloat(getComputedStyle(secondary.querySelector('span')).lineHeight)};
    })()`);
    assert.ok(Math.abs(layout.translation-layout.main*.85)<.1);
    assert.ok(Math.abs(layout.gap-layout.main*.22)<.1);
    assert.ok(Math.abs(layout.lineHeight-layout.translation*1.05)<.1);
        for (const channel of ['primary', 'media']) {
      try { const rendered = await pango.renderCue(cue, channel); metrics.push({ channel, pango: 'passed', bytes: rendered.info.data.length }); }
      catch (error) { metrics.push({ channel, pango: error.code, details: error.details }); }
      const rendered = await renderer.renderScene(compileNativeCueScene(cue, channel, { width: 1920, height: 1080 }));
      const statistics = await sharp(rendered.info.data).stats();
      assert.ok(statistics.entropy > 0.1, 'A text slide must not be a blank screenshot.');
      assert.equal((await sharp(rendered.info.data).metadata()).width, 1920);
    }
  } finally { await renderer.dispose(); }
  const fallback = new LegacyServiceFallback({ rootPath: path.join(root, 'fallbacks'), cacheRoot: path.join(root, 'cache'), projectStore: store, rendererFactory });
  const built = await fallback.build({ projectId: saved.project.id, revisionId: saved.revisionId, roleMapping: { english: 'primary', russian: 'media' } });
  await fallback.activate(built);
  for (const presentation of Object.values(built.presentations)) await fallback.converter.validateGeneration(presentation.cacheDir, 1);
  await fs.writeFile(path.join(root, 'result.json'), JSON.stringify({ platform: process.platform, native: true, fallback: true, cacheValidated: true, metrics }));
  app.quit();
}).catch(error => { console.error(error.stack); app.exit(1); });
