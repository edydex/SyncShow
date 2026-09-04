'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const electronPath = require('electron');
const {
  ISOLATED_TEST_USER_DATA_MARKER
} = require('../src/services/runtime/IsolatedTestUserData');
const {
  validateHeritageServiceDocumentSource
} = require('../src/services/community/HeritageServiceDocument');

const TIMEOUT_MS = 600_000;
const MAX_LOG_BYTES = 512 * 1024;

function argument(name) {
  const index = process.argv.indexOf(name);
  return index < 0 ? '' : process.argv[index + 1] || '';
}

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

async function collectFiles(rootPath) {
  const files = [];
  async function walk(currentPath) {
    for (const entry of await fs.readdir(currentPath, { withFileTypes: true })) {
      const entryPath = path.join(currentPath, entry.name);
      if (entry.isDirectory()) await walk(entryPath);
      else if (entry.isFile()) files.push(entryPath);
    }
  }
  await walk(rootPath);
  return files;
}

function sendJson(response, value, status = 200) {
  const bytes = Buffer.from(JSON.stringify(value));
  response.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': String(bytes.length),
    'Cache-Control': 'no-store'
  });
  response.end(bytes);
}

async function startCommunityServer({ documentSource, project, assets }) {
  const documentRevision = crypto
    .createHash('sha256')
    .update(documentSource)
    .digest('hex');
  let offline = false;
  const requests = [];
  const changedAt = '2026-09-03T18:00:00.000Z';
  const server = http.createServer((request, response) => {
    const baseUrl = `http://127.0.0.1:${server.address().port}/`;
    const url = new URL(request.url, baseUrl);
    requests.push(`${request.method} ${url.pathname}`);

    if (url.pathname === '/__verification/offline' && request.method === 'POST') {
      offline = true;
      return sendJson(response, { offline: true });
    }
    if (url.pathname === '/__verification/status') {
      return sendJson(response, { offline, requestCount: requests.length });
    }
    if (offline) {
      return sendJson(response, { error: 'verification-server-offline' }, 503);
    }

    if (url.pathname === '/.well-known/heritage-community.json') {
      return sendJson(response, {
        schemaVersion: 1,
        server: {
          id: 'wotbc-community-verification',
          name: 'WOTBC Community Verification'
        },
        integrations: {
          syncShow: {
            schemaVersion: 2,
            apiBaseUrl: `${baseUrl}api/community/syncshow/v1`,
            deviceAuthorization: true,
            resources: {
              serviceDocuments: {
                schemaVersion: 1,
                endpoint: 'service-documents',
                changesEndpoint: 'service-documents/changes',
                scopes: [
                  'syncshow:service-documents:read',
                  'syncshow:service-documents:write'
                ]
              }
            }
          }
        }
      });
    }

    if (url.pathname.endsWith('/auth/device/start') && request.method === 'POST') {
      return sendJson(response, {
        deviceId: 'device-aug23-verification',
        deviceSecret: 'verification-device-secret-0000000000001',
        userCode: 'AUG23-OK',
        verificationUri: `${baseUrl}admin/syncshow/approve`,
        expiresAt: '2026-09-04T23:00:00.000Z',
        pollIntervalMs: 1000
      }, 201);
    }
    if (url.pathname.endsWith('/auth/device/status') && request.method === 'POST') {
      return sendJson(response, { status: 'approved' });
    }
    if (url.pathname.endsWith('/auth/device/token') && request.method === 'POST') {
      return sendJson(response, {
        accessToken: 'verification-access-token-0000000000001',
        refreshToken: 'verification-refresh-token-000000000001',
        expiresAt: '2026-09-04T23:00:00.000Z',
        scopes: [
          'syncshow:service-documents:read',
          'syncshow:service-documents:write'
        ],
        account: {
          id: 'wotbc-admin-verification',
          email: 'admin@wotbc.example',
          name: 'WOTBC verification admin'
        }
      });
    }
    if (url.pathname.endsWith('/auth/device/cancel')
      || url.pathname.endsWith('/auth/revoke')) {
      return sendJson(response, { ok: true });
    }

    const serviceRoot = '/api/community/syncshow/v1/service-documents';
    if (url.pathname === `${serviceRoot}/changes`) {
      return sendJson(response, { items: [], nextCursor: null, hasMore: false });
    }
    if (url.pathname === serviceRoot && request.method === 'GET') {
      return sendJson(response, {
        items: [{
          syncId: project.id,
          syncVersion: 8,
          revision: documentRevision,
          status: 'ready',
          title: project.title,
          serviceDate: project.serviceDate,
          changedAt
        }],
        nextCursor: null,
        hasMore: false
      });
    }
    if (url.pathname === `${serviceRoot}/${encodeURIComponent(project.id)}`
      && request.method === 'GET') {
      return sendJson(response, {
        serviceDocument: {
          syncId: project.id,
          syncVersion: 8,
          revision: documentRevision,
          documentSource,
          status: 'ready',
          changedAt
        }
      });
    }
    const assetPrefix = `${serviceRoot}/${encodeURIComponent(project.id)}/assets/`;
    if (url.pathname.startsWith(assetPrefix) && request.method === 'GET') {
      const assetId = decodeURIComponent(url.pathname.slice(assetPrefix.length));
      const entry = assets.get(assetId);
      if (!entry) return sendJson(response, { error: 'asset-not-found' }, 404);
      response.writeHead(200, {
        'Content-Type': entry.mediaType,
        'Content-Length': String(entry.bytes.length),
        'Cache-Control': 'no-store'
      });
      return response.end(entry.bytes);
    }
    return sendJson(response, { error: 'not-found', path: url.pathname }, 404);
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return {
    server,
    baseUrl: `http://127.0.0.1:${server.address().port}/`,
    requests
  };
}

function runElectron({ profilePath, resultPath, baseUrl, serviceId, screenshotRoot }) {
  const entryPath = path.resolve(
    __dirname,
    'fixtures',
    'community-service-electron-app.js'
  );
  const environment = { ...process.env };
  delete environment.ELECTRON_RUN_AS_NODE;
  environment.SYNCSHOW_TEST_USER_DATA_DIR = profilePath;
  environment.SYNCSHOW_COMMUNITY_SERVICE_RESULT = resultPath;
  environment.SYNCSHOW_COMMUNITY_SERVICE_BASE_URL = baseUrl;
  environment.SYNCSHOW_COMMUNITY_SERVICE_ID = serviceId;
  environment.SYNCSHOW_COMMUNITY_SERVICE_SCREENSHOT_ROOT = screenshotRoot;
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
    let forceKill = null;
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      forceKill = setTimeout(() => child.kill('SIGKILL'), 5000);
    }, TIMEOUT_MS);
    child.once('error', error => {
      clearTimeout(timeout);
      if (forceKill) clearTimeout(forceKill);
      reject(error);
    });
    child.once('close', (code, signal) => {
      clearTimeout(timeout);
      if (forceKill) clearTimeout(forceKill);
      resolve({ code, signal, timedOut, stdout: stdout(), stderr: stderr() });
    });
  });
}

async function main() {
  const documentPath = path.resolve(argument('--document'));
  const assetRoot = path.resolve(argument('--assets'));
  assert.equal(path.isAbsolute(documentPath), true, '--document must be absolute');
  assert.equal(path.isAbsolute(assetRoot), true, '--assets must be absolute');

  const documentSource = await fs.readFile(documentPath, 'utf8');
  const { project } = validateHeritageServiceDocumentSource(documentSource);
  const files = await collectFiles(assetRoot);
  const bySha256 = new Map();
  for (const filePath of files) {
    const bytes = await fs.readFile(filePath);
    bySha256.set(crypto.createHash('sha256').update(bytes).digest('hex'), bytes);
  }
  const assets = new Map();
  for (const asset of Object.values(project.assets)) {
    const bytes = bySha256.get(asset.sha256);
    assert.ok(bytes, `Missing exact bytes for ${asset.id}`);
    assert.equal(bytes.length, asset.size, `Size changed for ${asset.id}`);
    assets.set(asset.id, { bytes, mediaType: asset.mediaType });
  }

  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'syncshow-community-aug23-'));
  const profilePath = path.join(root, 'profile');
  const resultPath = path.join(root, 'result.json');
  const screenshotRoot = path.join(root, 'screenshots');
  await fs.mkdir(profilePath, { mode: 0o700 });
  await fs.mkdir(screenshotRoot, { mode: 0o700 });
  await fs.writeFile(
    path.join(profilePath, ISOLATED_TEST_USER_DATA_MARKER),
    'SyncShow isolated test user data v1\n',
    { mode: 0o600 }
  );
  await fs.writeFile(path.join(profilePath, 'settings.json'), JSON.stringify({
    advancedWarningAcknowledged: true,
    displayAssignments: { russian: 2, english: 3, singer: 4 },
    outputNames: {
      russian: 'Russian Screen',
      english: 'English Screen',
      singer: 'Stage-Facing Screen'
    },
    previewOpenRu: false,
    previewOpenEn: false,
    previewOpenSinger: false,
    friendlyMode: true
  }, null, 2), { mode: 0o600 });

  const community = await startCommunityServer({
    documentSource,
    project,
    assets
  });
  try {
    const child = await runElectron({
      profilePath,
      resultPath,
      baseUrl: community.baseUrl,
      serviceId: project.id,
      screenshotRoot
    });
    let result;
    try {
      result = JSON.parse(await fs.readFile(resultPath, 'utf8'));
    } catch (error) {
      throw new Error([
        'The Electron Community service verifier did not produce a result.',
        `Exit code: ${child.code}; signal: ${child.signal || 'none'}; timed out: ${child.timedOut}.`,
        child.stdout ? `stdout:\n${child.stdout}` : '',
        child.stderr ? `stderr:\n${child.stderr}` : '',
        `Result read error: ${error.message}`
      ].filter(Boolean).join('\n'));
    }
    assert.equal(child.timedOut, false);
    assert.equal(child.code, 0, [
      result?.error || '',
      `Evidence root: ${root}`,
      `Mock requests:\n${community.requests.join('\n')}`,
      child.stderr || '',
      child.stdout || ''
    ].filter(Boolean).join('\n'));
    assert.equal(result.ok, true, [
      result.error,
      `Evidence root: ${root}`,
      `Mock requests:\n${community.requests.join('\n')}`
    ].join('\n'));
    result.evidenceRoot = root;
    result.mockRequestCount = community.requests.length;
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    error.message = `${error.message}\nEvidence root: ${root}\nMock requests:\n${community.requests.join('\n')}`;
    throw error;
  } finally {
    await new Promise(resolve => community.server.close(resolve));
  }
}

main().catch(error => {
  console.error(error?.stack || error);
  process.exitCode = 1;
});
