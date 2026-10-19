'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

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
    '--syncshow-test-user-data', '--headless'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  for (const stream of [child.stdout, child.stderr]) stream.on('data', bytes => { log = (log + bytes).slice(-256 * 1024); });
  const timeout = setTimeout(() => child.kill(), 160_000);
  const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); }).finally(() => clearTimeout(timeout));
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
