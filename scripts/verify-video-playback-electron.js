'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const electronPath = require('electron');

async function main() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'syncshow-video-electron-'));
  const videoPath = path.join(root, 'video-smoke.mp4');
  const resultPath = path.join(root, 'result.json');
  try {
    const generated = spawnSync('ffmpeg', [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-f', 'lavfi', '-i', 'color=c=#174734:s=640x360:r=30',
      '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000',
      '-t', '1.4', '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-movflags', '+faststart', videoPath,
    ], { encoding: 'utf8' });
    assert.equal(generated.status, 0, generated.stderr || 'ffmpeg failed');

    const environment = { ...process.env };
    delete environment.ELECTRON_RUN_AS_NODE;
    environment.SYNCSHOW_VIDEO_SMOKE_MEDIA = videoPath;
    environment.SYNCSHOW_VIDEO_SMOKE_RESULT = resultPath;
    environment.ELECTRON_DISABLE_SECURITY_WARNINGS = 'true';
    const child = spawn(electronPath, [
      path.resolve(__dirname, 'fixtures/video-playback-electron-app.js'),
      '--headless',
    ], {
      cwd: path.resolve(__dirname, '..'),
      env: environment,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => { stdout = `${stdout}${chunk}`.slice(-64 * 1024); });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', chunk => { stderr = `${stderr}${chunk}`.slice(-64 * 1024); });
    const exit = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        child.kill('SIGTERM');
        reject(new Error('Electron video playback verification timed out.'));
      }, 30_000);
      child.once('error', reject);
      child.once('close', (code, signal) => {
        clearTimeout(timeout);
        resolve({ code, signal });
      });
    });
    assert.equal(
      exit.code,
      0,
      [stderr, stdout, `Electron exited with ${exit.signal || `code ${exit.code}`}.`]
        .filter(Boolean)
        .join('\n'),
    );
    const result = JSON.parse(await fs.readFile(resultPath, 'utf8'));
    assert.equal(result.ok, true, result.stack || result.error);
    assert.equal(result.armed, 'armed');
    assert.ok(result.playingTime > 0.05);
    assert.equal(result.pausedHeld, true);
    assert.ok(result.endedTime > 1);
    assert.equal(result.stopped, 'armed');
    assert.equal(result.muted, false);
    assert.ok(result.states.includes('playing'));
    assert.ok(result.states.includes('paused'));
    assert.ok(result.states.includes('ended'));
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

main().catch(error => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 1;
});
