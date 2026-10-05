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
  const fontPath = path.resolve(__dirname, '../../assets/fonts/NotoSans-Variable.ttf');
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
