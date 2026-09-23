'use strict';

// Run with Electron, not Node: these regressions depend on Chromium's actual
// line boxes and the bundled font, including overflow beyond tight leading.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {pathToFileURL} = require('node:url');
const {app, BrowserWindow} = require('electron');
const root = path.resolve(__dirname, '../..');
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'syncshow-text-fit-'));
app.setPath('userData', temporary);

const scene = {
  schemaVersion: 3, kind: 'syncshow-native-cue-scene', cueId: 'reading-test',
  sourceKind: 'bible', layout: 'text', canvas: {width: 1920, height: 1080},
  background: '#000000', title: '', body: '', bodySpans: [],
  style: {
    bodyAlign: 'left', bodyForeground: '#ffffff', bodyHeight: 1015,
    bodyMinimumSize: 85, bodyPosition: 'top', bodyRegionHeightPercent: 90,
    bodySize: 85, bodyTopPercent: 2, bodyWeight: '500', bodyWidthPercent: 98,
    lineSpacingPercent: 8, paragraphGap: false, showTitle: false,
    titleAlign: 'center', titleForeground: '#ffffff', titleMinimumSize: 24,
    titleSize: 34, titleTopPercent: 9, titleWeight: '650', titleWidthPercent: 98
  }
};

app.whenReady().then(async () => {
  let win;
  try {
    const css = fs.readFileSync(path.join(root, 'src/renderer/display.html'), 'utf8')
      .match(/<style>([\s\S]*?)<\/style>/)[1];
    const html = path.join(temporary, 'renderer.html');
    fs.writeFileSync(html, `<style>${css} #probe {position:absolute;inset:0}</style><div id="probe"></div>`);
    win = new BrowserWindow({show: false, webPreferences: {backgroundThrottling: false}});
    await win.loadFile(html);
    await win.webContents.executeJavaScript(fs.readFileSync(path.join(root, 'src/renderer/native-cue-renderer.js'), 'utf8'));
    const fontUrl = pathToFileURL(path.join(root, 'assets/fonts/NotoSans-Variable.ttf')).href;
    await win.webContents.executeJavaScript(`(async () => {
      const font = new FontFace('SyncShow Noto Sans', 'url(${fontUrl})', {weight: '100 900'});
      await font.load(); document.fonts.add(font);
    })()`);
    let checked = 0;
    for (const [width, height] of [[1920, 1080], [1280, 720], [640, 360], [585, 329]]) {
      win.setContentSize(width, height);
      for (const lines of [2, 11, 12]) {
        const candidate = {...scene, body: Array.from({length: lines}, (_, index) =>
          `${index + 1} Faithfulness and truth. Верность и истина.`).join('\n')};
        const result = await win.webContents.executeJavaScript(`(async () => {
          const host = document.getElementById('probe'); host.replaceChildren();
          const renderer = window.SyncShowNativeCueRenderer.buildScene(${JSON.stringify(candidate)});
          host.append(renderer.element);
          let error = ''; try { await renderer.prepare(); } catch (failure) {error = failure.message;}
          const body = host.querySelector('.native-scene-body');
          const region = host.querySelector('.native-scene-body-region');
          const surface = host.querySelector('.native-scene-surface');
          return {error, font: parseFloat(getComputedStyle(body).fontSize),
            scrollHeight: body.scrollHeight, height: body.clientHeight,
            bottom: region.getBoundingClientRect().bottom,
            surfaceBottom: surface.getBoundingClientRect().bottom,
            scale: Math.min(host.clientWidth / 1920, host.clientHeight / 1080)};
        })()`);
        if (lines === 12) {
          assert.match(result.error, /does not fit/, 'A genuinely overfull fixed-size page must still fail');
        } else {
          assert.equal(result.error, '', `${width}x${height}, ${lines} lines`);
          assert.ok(Math.abs(result.font - 85 * result.scale) < .02, 'Short and full pages keep the same saved size');
          assert.ok(result.scrollHeight <= result.height + 1, 'Final text is not clipped');
          assert.ok(result.bottom <= result.surfaceBottom - 24 * result.scale + 1, 'Preserve the planner bottom inset');
        }
        checked++;
      }
    }
    console.log(JSON.stringify({passed: true, checked}));
  } finally {
    win?.destroy();
  }
}).then(() => {
  fs.rmSync(temporary, {recursive: true, force: true});
  app.exit(0);
}).catch(error => {
  console.error(error);
  fs.rmSync(temporary, {recursive: true, force: true});
  app.exit(1);
});
