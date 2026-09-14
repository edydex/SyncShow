'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { app, BrowserWindow } = require('electron');

const { compileNativeCueScene } = require('../../src/services/show/NativeCueScene');

app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
app.disableHardwareAcceleration();

async function main() {
  const videoPath = process.env.SYNCSHOW_VIDEO_SMOKE_MEDIA;
  const resultPath = process.env.SYNCSHOW_VIDEO_SMOKE_RESULT;
  if (!path.isAbsolute(videoPath || '') || !path.isAbsolute(resultPath || '')) {
    throw new Error('Video smoke paths must be absolute.');
  }
  const assetId = `sha256:${'c'.repeat(64)}`;
  const scene = compileNativeCueScene({
    id: 'cue-video-electron-smoke',
    kind: 'video',
    title: 'Electron video smoke',
    presetId: 'video-fullscreen',
    channels: {
      primary: {
        mode: 'content',
        blocks: [{ type: 'video', assetId, fit: 'fit', muted: false }]
      }
    }
  }, 'primary', { width: 640, height: 360 });
  const rendererUrl = pathToFileURL(path.resolve(
    __dirname,
    '../../src/renderer/native-cue-renderer.js'
  )).href;
  const htmlPath = path.join(path.dirname(resultPath), 'video-smoke.html');
  await fs.writeFile(htmlPath, `<!doctype html>
<html><body style="margin:0;width:640px;height:360px;background:#000">
<script src="${rendererUrl}"></script>
<script>
window.runVideoSmoke = async (scene, videoUrl) => {
  const states = [];
  const waitFor = async (condition, label, timeoutMs = 5000) => {
    const startedAt = performance.now();
    while (!condition()) {
      if (performance.now() - startedAt > timeoutMs) throw new Error(label);
      await new Promise(resolve => setTimeout(resolve, 25));
    }
  };
  const renderer = window.SyncShowNativeCueRenderer.buildScene(scene, {
    resolveAssetUrl: () => videoUrl,
    onVideoState: value => states.push(value.state),
  });
  document.body.appendChild(renderer.element);
  await renderer.prepare();
  const video = renderer.element.querySelector('video');
  const armed = renderer.videoState();
  await renderer.playVideo();
  await waitFor(() => video.currentTime > 0.05, 'Video did not advance.');
  const playingTime = video.currentTime;
  renderer.pauseVideo();
  const pausedTime = video.currentTime;
  await new Promise(resolve => setTimeout(resolve, 150));
  const pausedHeld = Math.abs(video.currentTime - pausedTime) < 0.04;
  await renderer.playVideo();
  await waitFor(() => renderer.videoState() === 'ended', 'Video did not end.', 7000);
  const endedTime = video.currentTime;
  renderer.stopVideo();
  const stopped = renderer.videoState();
  renderer.destroy();
  return {
    armed,
    playingTime,
    pausedHeld,
    endedTime,
    stopped,
    muted: video.muted,
    states,
  };
};
</script></body></html>`, 'utf8');

  const window = new BrowserWindow({
    show: false,
    width: 640,
    height: 360,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  await window.loadFile(htmlPath);
  const result = await window.webContents.executeJavaScript(
    `window.runVideoSmoke(${JSON.stringify(scene)}, ${JSON.stringify(pathToFileURL(videoPath).href)})`,
    true,
  );
  await fs.writeFile(resultPath, `${JSON.stringify({ ok: true, ...result })}\n`, 'utf8');
  window.destroy();
  app.quit();
}

app.whenReady().then(main).catch(async error => {
  const resultPath = process.env.SYNCSHOW_VIDEO_SMOKE_RESULT;
  if (path.isAbsolute(resultPath || '')) {
    await fs.writeFile(resultPath, `${JSON.stringify({
      ok: false,
      error: error?.message || String(error),
      stack: error?.stack || '',
    })}\n`, 'utf8').catch(() => undefined);
  }
  app.exit(1);
});
