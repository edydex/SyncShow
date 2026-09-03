#!/usr/bin/env node
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const asar = require('@electron/asar');

const DISCOVERY_TIMEOUT_MS = 45_000;
const EXIT_TIMEOUT_MS = 15_000;
const PROFILE_MARKER = '.syncshow-isolated-test-user-data';
const PROFILE_MARKER_SOURCE = 'SyncShow isolated test user data v1\n';

class PackagedAppLaunchVerificationError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'PackagedAppLaunchVerificationError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new PackagedAppLaunchVerificationError(code, message);
}

function parseArguments(argv) {
  if (!Array.isArray(argv) || argv.length !== 2 || argv[0] !== '--root' || !argv[1]) {
    fail('INVALID_ARGUMENTS', 'Usage: node scripts/verify-packaged-app-launch.js --root /absolute/or/relative/package-root');
  }
  return { root: path.resolve(argv[1]) };
}

async function findAppArchives(root) {
  const matches = [];
  async function visit(directory) {
    const entries = await fsp.readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const candidate = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) await visit(candidate);
      else if (entry.isFile() && entry.name === 'app.asar') matches.push(candidate);
    }
  }
  await visit(root);
  return matches.sort();
}

function readManifest(archivePath) {
  try {
    return JSON.parse(asar.extractFile(archivePath, 'package.json').toString('utf8'));
  } catch (error) {
    fail('INVALID_APP_ARCHIVE', `Could not read the packaged application manifest: ${error.message}`);
  }
}

function packagedExecutable(archivePath, manifest) {
  const resourcesRoot = path.dirname(archivePath);
  const applicationRoot = path.dirname(resourcesRoot);
  const productName = manifest.build?.productName || manifest.productName || 'SyncShow';
  if (process.platform === 'darwin') {
    if (path.basename(applicationRoot) !== 'Contents') {
      fail('INVALID_PACKAGE_LAYOUT', 'The macOS app archive is outside an application bundle.');
    }
    return path.join(applicationRoot, 'MacOS', productName);
  }
  if (process.platform === 'win32') return path.join(applicationRoot, `${productName}.exe`);
  if (process.platform === 'linux') return path.join(applicationRoot, manifest.name);
  fail('UNSUPPORTED_HOST', `Packaged launch smoke does not support ${process.platform}.`);
}

async function sha256File(filePath) {
  const hash = crypto.createHash('sha256');
  await new Promise((resolve, reject) => {
    const stream = fs.createReadStream(filePath);
    stream.once('error', reject);
    stream.on('data', bytes => hash.update(bytes));
    stream.once('end', resolve);
  });
  return hash.digest('hex');
}

async function reserveLoopbackPort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  if (!address || typeof address === 'string') fail('PORT_RESERVATION_FAILED', 'Could not reserve a loopback port.');
  return address.port;
}

function getJson(port, route) {
  return new Promise((resolve, reject) => {
    const request = http.get({ host: '127.0.0.1', port, path: route, timeout: 2000 }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.once('end', () => {
        if (response.statusCode !== 200) return reject(new Error(`HTTP ${response.statusCode}`));
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
        catch (error) { reject(error); }
      });
    });
    request.once('timeout', () => request.destroy(new Error('loopback discovery timeout')));
    request.once('error', reject);
  });
}

async function waitForPage(port, child, timeoutMs = DISCOVERY_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      fail('PACKAGED_APP_EXITED', `Packaged app exited before its control window loaded (${child.exitCode ?? child.signalCode}).`);
    }
    try {
      const pages = await getJson(port, '/json/list');
      const page = pages.find(record => record?.type === 'page'
        && typeof record.url === 'string'
        && record.url.includes('/src/renderer/index.html'));
      if (page) return page;
      lastError = new Error('SyncShow control page is not present yet.');
    } catch (error) {
      lastError = error;
    }
    await new Promise(resolve => setTimeout(resolve, 150));
  }
  fail('PACKAGED_APP_LAUNCH_TIMEOUT', `Timed out waiting for SyncShow's packaged control window: ${lastError?.message || 'unknown discovery state'}`);
}

async function closeBrowser(port) {
  const version = await getJson(port, '/json/version');
  if (!version?.webSocketDebuggerUrl) return false;
  return new Promise(resolve => {
    const socket = new WebSocket(version.webSocketDebuggerUrl);
    const timeout = setTimeout(() => {
      try { socket.close(); } catch (_error) {}
      resolve(false);
    }, 3000);
    socket.addEventListener('open', () => {
      socket.send(JSON.stringify({ id: 1, method: 'Browser.close' }));
    }, { once: true });
    socket.addEventListener('close', () => {
      clearTimeout(timeout);
      resolve(true);
    }, { once: true });
    socket.addEventListener('error', () => {
      clearTimeout(timeout);
      resolve(false);
    }, { once: true });
  });
}

function waitForExit(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise(resolve => {
    const timeout = setTimeout(() => {
      child.removeListener('exit', onExit);
      resolve(false);
    }, timeoutMs);
    const onExit = () => {
      clearTimeout(timeout);
      resolve(true);
    };
    child.once('exit', onExit);
  });
}

async function verifyPackagedAppLaunch({ root }) {
  const rootStats = await fsp.lstat(root).catch(() => null);
  if (!rootStats?.isDirectory() || rootStats.isSymbolicLink()) fail('INVALID_PACKAGE_ROOT', 'Package root must be a real directory.');
  const archives = await findAppArchives(root);
  if (archives.length !== 1) fail('APP_ARCHIVE_INVENTORY', `Expected exactly one app.asar; found ${archives.length}.`);
  const [archivePath] = archives;
  const manifest = readManifest(archivePath);
  const executablePath = packagedExecutable(archivePath, manifest);
  const executableStats = await fsp.lstat(executablePath).catch(() => null);
  if (!executableStats?.isFile() || executableStats.isSymbolicLink() || executableStats.size < 1) {
    fail('PACKAGED_EXECUTABLE_MISSING', `Packaged executable is missing: ${executablePath}`);
  }
  if (process.platform !== 'win32') await fsp.access(executablePath, fs.constants.X_OK);

  const profileRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'syncshow-package-launch-'));
  await fsp.chmod(profileRoot, 0o700);
  const port = await reserveLoopbackPort();
  let stdout = '';
  let stderr = '';
  const child = spawn(executablePath, [
    '--syncshow-test-user-data',
    `--user-data-dir=${profileRoot}`,
    `--remote-debugging-port=${port}`,
    '--remote-debugging-address=127.0.0.1',
    '--remote-allow-origins=*'
  ], {
    env: { ...process.env, SYNCSHOW_TEST_USER_DATA_DIR: profileRoot },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true
  });
  child.stdout.on('data', bytes => { stdout = `${stdout}${bytes}`.slice(-8192); });
  child.stderr.on('data', bytes => { stderr = `${stderr}${bytes}`.slice(-8192); });

  let page;
  let launchError = null;
  try {
    page = await waitForPage(port, child);
    const marker = await fsp.readFile(path.join(profileRoot, PROFILE_MARKER), 'utf8');
    if (marker !== PROFILE_MARKER_SOURCE) fail('ISOLATED_PROFILE_UNMARKED', 'Packaged app did not confirm its isolated test profile.');
  } catch (error) {
    error.message = `${error.message}\nstdout: ${stdout}\nstderr: ${stderr}`.slice(-6000);
    launchError = error;
  } finally {
    await closeBrowser(port).catch(() => false);
    if (!await waitForExit(child, EXIT_TIMEOUT_MS)) {
      child.kill();
      await waitForExit(child, 5000);
    }
  }
  if (child.exitCode === null && child.signalCode === null) {
    launchError = launchError || new PackagedAppLaunchVerificationError(
      'PACKAGED_APP_DID_NOT_CLOSE',
      'Packaged app remained after the bounded close request.',
    );
  }
  await fsp.rm(profileRoot, { recursive: true, force: false });
  if (launchError) throw launchError;
  const result = {
    schemaVersion: 1,
    target: `${process.platform}-${process.arch}`,
    archive: path.relative(root, archivePath).split(path.sep).join('/'),
    archiveSha256: await sha256File(archivePath),
    executable: path.relative(root, executablePath).split(path.sep).join('/'),
    executableSha256: await sha256File(executablePath),
    controlPage: { title: page.title, url: page.url },
    isolatedProfile: 'confirmed-and-removed',
    launch: 'passed'
  };
  const evidencePath = path.join(root, `packaged-launch-${process.platform}-${process.arch}.json`);
  await fsp.writeFile(evidencePath, `${JSON.stringify(result, null, 2)}\n`, { flag: 'wx' });
  return { evidencePath, result };
}

async function main(argv = process.argv.slice(2), stdout = process.stdout) {
  const verified = await verifyPackagedAppLaunch(parseArguments(argv));
  stdout.write(`${JSON.stringify({ ...verified.result, evidence: verified.evidencePath }, null, 2)}\n`);
  return verified;
}

if (require.main === module) {
  main().catch(error => {
    process.stderr.write(`${error.code || error.name}: ${error.message}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  DISCOVERY_TIMEOUT_MS,
  PackagedAppLaunchVerificationError,
  main,
  packagedExecutable,
  parseArguments,
  verifyPackagedAppLaunch,
  waitForPage
};
