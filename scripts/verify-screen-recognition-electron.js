'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawn, execFile } = require('node:child_process');

async function rehearse({ count, chosen, screenRegression }) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ss-screen-'));
  const profile = path.join(directory, 'profile');
  await fs.mkdir(profile);
  const result = path.join(directory, 'result.json');
  const env = { ...process.env, SYNCSHOW_TEST_USER_DATA_DIR: profile,
    SYNCSHOW_SMALL_SERVICE_RESULT: result,
    SYNCSHOW_SMALL_SERVICE_SCREENSHOTS: path.join(directory, 'screenshots'),
    SYNCSHOW_SMALL_SERVICE_DISPLAYS: String(count),
    SYNCSHOW_SMALL_SERVICE_SCREEN: chosen,
    SYNCSHOW_SMALL_SERVICE_SCREEN_REGRESSION: screenRegression ? '1' : '0' };
  delete env.ELECTRON_RUN_AS_NODE;
  // os.tmpdir() on Windows can contain a DOS short-name alias. Electron tests
  // use the canonical path for the isolated-profile confinement boundary.
  env.SYNCSHOW_TEST_USER_DATA_DIR = await fs.realpath(profile);
  let log = '';
  const child = spawn(require('electron'), [path.join(__dirname, 'fixtures', 'small-service-electron-app.js'),
    '--syncshow-test-user-data', '--headless'], { env, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
  for (const stream of [child.stdout, child.stderr]) stream.on('data', bytes => { log = (log + bytes).slice(-256 * 1024); });
  let timeout;
  const code = await new Promise((resolve, reject) => {
    child.once('error', reject);
    // A Chromium helper can retain the stdio pipe after the browser exits.
    // Do not wait forever for close; the actual browser exit is authoritative.
    child.once('exit', resolve);
    timeout = setTimeout(() => {
      if (process.platform === 'win32') {
        execFile('taskkill', ['/pid', String(child.pid), '/T', '/F'], { timeout: 5000 }, () => {});
      } else {
        try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
      }
      reject(new Error(`Screen rehearsal exceeded 160 seconds (${count} external displays).\n${log}\nEvidence: ${directory}`));
    }, 160_000);
  }).finally(() => {
    clearTimeout(timeout);
    child.stdout.destroy();
    child.stderr.destroy();
    child.unref();
  });
  try {
    const report = JSON.parse(await fs.readFile(result, 'utf8'));
    assert.equal(code, 0, report.error || log);
    assert.equal(report.ok, true, report.error);
    console.log(`PASS: ${count} external displays — repeated backstage additions, offline Show, ${screenRegression ? 'ID/mode change recovery, Start rescan and diagnostics export' : 'preview-only crash recovery'}`);
  } catch (error) {
    console.error(log);
    console.error(`Isolated rehearsal evidence: ${directory}`);
    throw error;
  }
}

(async () => {
  await rehearse({ count: 0, chosen: 'english' });
  await rehearse({ count: 3, chosen: 'english,russian,media', screenRegression: true });
})().catch(error => { console.error(error.stack); process.exitCode = 1; });
