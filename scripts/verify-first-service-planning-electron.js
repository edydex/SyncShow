'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const electronPath = require('electron');
const TIMEOUT_MS = 75_000;
const MAX_LOG_BYTES = 256 * 1024;

function boundedCollector(stream) {
  let value = '';
  stream.setEncoding('utf8');
  stream.on('data', chunk => {
    value += chunk;
    if (Buffer.byteLength(value, 'utf8') > MAX_LOG_BYTES) {
      value = value.slice(-MAX_LOG_BYTES);
    }
  });
  return () => value;
}

function runElectron({ profilePath, resultPath, screenshotPath }) {
  const entryPath = path.resolve(
    __dirname,
    'fixtures',
    'first-service-planning-electron-app.js'
  );
  const environment = { ...process.env };
  delete environment.ELECTRON_RUN_AS_NODE;
  environment.SYNCSHOW_TEST_USER_DATA_DIR = profilePath;
  environment.SYNCSHOW_FIRST_SERVICE_PLANNING_RESULT = resultPath;
  if (screenshotPath) {
    environment.SYNCSHOW_FIRST_SERVICE_PLANNING_SCREENSHOT = screenshotPath;
  }
  environment.ELECTRON_DISABLE_SECURITY_WARNINGS = 'true';

  return new Promise((resolve, reject) => {
    const child = spawn(electronPath, [
      entryPath,
      '--syncshow-test-user-data',
      '--headless'
    ], {
      cwd: path.resolve(__dirname, '..'),
      env: environment,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    const stdout = boundedCollector(child.stdout);
    const stderr = boundedCollector(child.stderr);
    let timedOut = false;
    let forceKillTimer = null;
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      forceKillTimer = setTimeout(() => child.kill('SIGKILL'), 5_000);
    }, TIMEOUT_MS);

    child.once('error', error => {
      clearTimeout(timeout);
      if (forceKillTimer) clearTimeout(forceKillTimer);
      reject(error);
    });
    child.once('close', (code, signal) => {
      clearTimeout(timeout);
      if (forceKillTimer) clearTimeout(forceKillTimer);
      resolve({
        code,
        signal,
        timedOut,
        stdout: stdout(),
        stderr: stderr()
      });
    });
  });
}

async function main() {
  const screenshotOptionIndex = process.argv.indexOf('--screenshot');
  const screenshotPath = screenshotOptionIndex >= 0
    ? process.argv[screenshotOptionIndex + 1]
    : '';
  if (
    screenshotOptionIndex >= 0
    && (
      !screenshotPath
      || !path.isAbsolute(screenshotPath)
      || !/\.(?:jpe?g|png)$/i.test(screenshotPath)
    )
  ) {
    throw new Error('--screenshot requires an absolute .png, .jpg, or .jpeg path.');
  }
  const root = await fs.mkdtemp(path.join(
    os.tmpdir(),
    'syncshow-first-service-planning-'
  ));
  const profilePath = path.join(root, 'profile');
  const resultPath = path.join(root, 'result.json');
  await fs.mkdir(profilePath, { mode: 0o700 });

  try {
    const child = await runElectron({
      profilePath,
      resultPath,
      screenshotPath
    });
    let result = null;
    try {
      result = JSON.parse(await fs.readFile(resultPath, 'utf8'));
    } catch (error) {
      throw new Error([
        'The Electron first-service planning verifier did not produce a result.',
        `Exit code: ${child.code}; signal: ${child.signal || 'none'}; timed out: ${child.timedOut}.`,
        child.stdout ? `stdout:\n${child.stdout}` : '',
        child.stderr ? `stderr:\n${child.stderr}` : '',
        `Result read error: ${error.message}`
      ].filter(Boolean).join('\n'));
    }
    assert.equal(child.timedOut, false);
    assert.equal(child.code, 0, child.stderr || child.stdout);
    assert.equal(result.ok, true, result.error || 'Electron verification failed.');
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
