#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const {
  readPlistValue,
  verifyMacRemoteNetworkMetadata
} = require('./lib/mac-network-privacy');

const REQUEST_TIMEOUT_MS = 5000;
const EVENT_TIMEOUT_MS = 5000;
const MAX_RESPONSE_BYTES = 5 * 1024 * 1024;

function fail(code, message, cause = null) {
  const error = new Error(message);
  error.name = 'PackagedRemoteLanSmokeError';
  error.code = code;
  if (cause) error.cause = cause;
  throw error;
}

function physicalBundleFilesystem({
  electron = Boolean(process.versions.electron),
  loadModule = require
} = {}) {
  // Electron patches `fs` so a physical app.asar is exposed as a virtual
  // directory. Bundle validation needs the real on-disk file type, while the
  // Remote smoke that follows still needs Electron's normal ASAR-aware `fs`.
  return electron ? loadModule('original-fs') : fs;
}

function resolvePackagedApp(rawAppPath) {
  if (process.platform !== 'darwin') {
    fail('MACOS_REQUIRED', 'The packaged real-LAN Remote gate must run on macOS.');
  }
  if (typeof rawAppPath !== 'string' || rawAppPath.trim().length === 0) {
    fail(
      'APP_PATH_REQUIRED',
      'Usage: node scripts/verify-packaged-remote-lan.js /absolute/path/SyncShow.app'
    );
  }

  const bundleFs = physicalBundleFilesystem();
  const requested = path.resolve(rawAppPath);
  let appPath;
  try {
    appPath = bundleFs.realpathSync(requested);
  } catch (cause) {
    fail('APP_NOT_FOUND', 'The packaged SyncShow app could not be opened.', cause);
  }
  if (!appPath.endsWith('.app') || !bundleFs.statSync(appPath).isDirectory()) {
    fail('INVALID_APP_BUNDLE', 'Choose a packaged macOS .app directory.');
  }

  const contentsPath = path.join(appPath, 'Contents');
  const infoPlistPath = path.join(contentsPath, 'Info.plist');
  const resourcesPath = path.join(contentsPath, 'Resources');
  const archivePath = path.join(resourcesPath, 'app.asar');
  for (const requiredPath of [infoPlistPath, archivePath]) {
    if (
      !bundleFs.existsSync(requiredPath)
      || !bundleFs.statSync(requiredPath).isFile()
    ) {
      fail('INCOMPLETE_APP_BUNDLE', 'The app bundle is missing required packaged content.');
    }
  }

  verifyMacRemoteNetworkMetadata(infoPlistPath);
  const executableName = readPlistValue(infoPlistPath, 'CFBundleExecutable');
  if (!/^[A-Za-z0-9][A-Za-z0-9 ._-]{0,127}$/.test(executableName)) {
    fail('INVALID_APP_EXECUTABLE', 'The packaged app has an invalid executable name.');
  }
  const executablePath = path.join(contentsPath, 'MacOS', executableName);
  if (
    !bundleFs.existsSync(executablePath)
    || !bundleFs.statSync(executablePath).isFile()
  ) {
    fail('APP_EXECUTABLE_MISSING', 'The packaged app executable is missing.');
  }

  return Object.freeze({
    appPath,
    archivePath,
    executablePath: bundleFs.realpathSync(executablePath),
    infoPlistPath
  });
}

function runThroughPackagedElectron(paths, rawAppPath) {
  const result = spawnSync(
    paths.executablePath,
    [__filename, rawAppPath],
    {
      cwd: path.resolve(__dirname, '..'),
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: '1'
      },
      stdio: 'inherit',
      timeout: 60 * 1000
    }
  );
  if (result.error) {
    fail(
      'PACKAGED_ELECTRON_LAUNCH_FAILED',
      'The packaged Electron runtime could not start the Remote gate.',
      result.error
    );
  }
  if (result.signal) {
    fail(
      'PACKAGED_ELECTRON_SIGNAL',
      `The packaged Electron runtime ended with signal ${result.signal}.`
    );
  }
  if (result.status !== 0) {
    fail(
      'PACKAGED_REMOTE_GATE_FAILED',
      `The packaged Remote gate exited with status ${result.status}.`
    );
  }
}

function assertPackagedElectronRuntime(paths) {
  if (!process.versions.electron) {
    fail('PACKAGED_ELECTRON_REQUIRED', 'The Remote gate is not using Electron.');
  }
  let runningExecutable;
  try {
    runningExecutable = fs.realpathSync(process.execPath);
  } catch (cause) {
    fail('PACKAGED_ELECTRON_REQUIRED', 'The running Electron executable could not be verified.', cause);
  }
  if (runningExecutable !== paths.executablePath) {
    fail(
      'WRONG_ELECTRON_RUNTIME',
      'The Remote gate must execute through the selected packaged app.'
    );
  }
}

function selectRealLanBinding(bindings, isPrivateIpv4) {
  if (!Array.isArray(bindings) || typeof isPrivateIpv4 !== 'function') {
    throw new TypeError('Real LAN binding selection requires the packaged binding catalog.');
  }
  const candidates = bindings
    .filter(binding => binding?.kind === 'lan'
      && binding.address !== '127.0.0.1'
      && isPrivateIpv4(binding.address))
    .sort((left, right) => left.address.localeCompare(right.address));
  if (candidates.length === 0) {
    fail(
      'REAL_LAN_BINDING_REQUIRED',
      'No RFC1918 IPv4 interface is available; the packaged Remote gate will not fall back to loopback.'
    );
  }
  return candidates[0];
}

function request(origin, {
  requestPath = '/',
  method = 'GET',
  originHeader = null,
  cookie = null,
  body = null
} = {}) {
  return new Promise((resolve, reject) => {
    const target = new URL(requestPath, origin);
    const payload = body === null
      ? null
      : Buffer.from(JSON.stringify(body), 'utf8');
    const headers = { Connection: 'close' };
    if (originHeader) headers.Origin = originHeader;
    if (cookie) headers.Cookie = cookie;
    if (payload) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = payload.length;
    }

    const outgoing = http.request({
      hostname: target.hostname,
      port: target.port,
      path: `${target.pathname}${target.search}`,
      method,
      headers,
      agent: false
    }, response => {
      const chunks = [];
      let length = 0;
      response.on('data', chunk => {
        length += chunk.length;
        if (length > MAX_RESPONSE_BYTES) {
          outgoing.destroy(new Error('Packaged Remote response exceeded the smoke-test limit.'));
          return;
        }
        chunks.push(chunk);
      });
      response.on('end', () => {
        resolve({
          status: response.statusCode,
          headers: response.headers,
          body: Buffer.concat(chunks, length)
        });
      });
    });
    outgoing.once('error', reject);
    outgoing.setTimeout(REQUEST_TIMEOUT_MS, () => {
      outgoing.destroy(new Error('Packaged Remote request timed out.'));
    });
    if (payload) outgoing.write(payload);
    outgoing.end();
  });
}

function jsonResponse(response, expectedStatus = 200) {
  assert.equal(response.status, expectedStatus, response.body.toString('utf8'));
  const contentType = String(response.headers['content-type'] || '');
  assert.match(contentType, /^application\/json(?:;|$)/);
  return JSON.parse(response.body.toString('utf8'));
}

function buildSmokeCommandBody({
  state,
  sequence,
  type,
  expectedCueIndex = null
}) {
  if (!state || typeof state !== 'object' || Array.isArray(state)) {
    throw new TypeError('The packaged Remote command needs an authoritative state.');
  }
  if (!Number.isSafeInteger(sequence) || sequence < 1) {
    throw new TypeError('The packaged Remote command sequence is invalid.');
  }
  if (![
    'cue.next',
    'cue.previous',
    'output.clear',
    'output.restore'
  ].includes(type)) {
    throw new TypeError('The packaged Remote smoke command is not allowed.');
  }
  const relative = type === 'cue.next' || type === 'cue.previous';
  if (relative && !Number.isSafeInteger(expectedCueIndex)) {
    throw new TypeError('Relative packaged Remote navigation needs the current cue index.');
  }
  return {
    version: 1,
    outputSessionId: state.outputSessionId,
    sequence,
    commandId: crypto.randomUUID(),
    expectedRevision: state.revision,
    expectedCueIndex: relative ? expectedCueIndex : null,
    command: { type }
  };
}

function openEventStream(origin, cookie) {
  return new Promise((resolve, reject) => {
    const target = new URL('/api/v1/events', origin);
    const queuedEvents = [];
    const waiters = [];
    let buffer = '';
    let closedResolve;
    const closed = new Promise(resolveClosed => {
      closedResolve = resolveClosed;
    });
    const outgoing = http.request({
      hostname: target.hostname,
      port: target.port,
      path: target.pathname,
      method: 'GET',
      headers: {
        Accept: 'text/event-stream',
        Connection: 'keep-alive',
        Cookie: cookie,
        Origin: origin
      },
      agent: false
    }, response => {
      if (response.statusCode !== 200) {
        response.resume();
        reject(new Error(`Packaged Remote event stream returned ${response.statusCode}.`));
        return;
      }
      response.setEncoding('utf8');
      const pushEvent = event => {
        const waiter = waiters.shift();
        if (waiter) waiter(event);
        else queuedEvents.push(event);
      };
      response.on('data', chunk => {
        buffer += chunk;
        if (Buffer.byteLength(buffer, 'utf8') > MAX_RESPONSE_BYTES) {
          outgoing.destroy(new Error('Packaged Remote event stream exceeded the smoke-test limit.'));
          return;
        }
        let boundary;
        while ((boundary = buffer.indexOf('\n\n')) >= 0) {
          const block = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          if (!block || block.startsWith(':')) continue;
          const eventName = block.match(/^event: ([^\n]+)$/m)?.[1] || 'message';
          const data = block.match(/^data: (.+)$/m)?.[1];
          pushEvent({
            eventName,
            data: data ? JSON.parse(data) : null
          });
        }
      });
      response.once('end', closedResolve);
      response.once('close', closedResolve);
      response.once('error', closedResolve);
      resolve({
        closed,
        close() {
          outgoing.destroy();
          response.destroy();
        },
        nextEvent(timeoutMs = EVENT_TIMEOUT_MS) {
          if (queuedEvents.length > 0) return Promise.resolve(queuedEvents.shift());
          return new Promise((resolveEvent, rejectEvent) => {
            const timer = setTimeout(() => {
              rejectEvent(new Error('Timed out waiting for packaged Remote state.'));
            }, timeoutMs);
            waiters.push(event => {
              clearTimeout(timer);
              resolveEvent(event);
            });
          });
        }
      });
    });
    outgoing.once('error', reject);
    outgoing.setTimeout(REQUEST_TIMEOUT_MS, () => {
      outgoing.destroy(new Error('Packaged Remote event stream timed out while opening.'));
    });
    outgoing.end();
  });
}

async function nextMatchingState(stream, predicate) {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const event = await stream.nextEvent();
    if (event.eventName === 'state' && predicate(event.data?.state)) return event.data;
  }
  fail('REMOTE_STATE_NOT_OBSERVED', 'The expected packaged Remote state was not observed.');
}

function waitFor(promise, timeoutMs, message) {
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      const timer = setTimeout(() => reject(new Error(message)), timeoutMs);
      timer.unref?.();
    })
  ]);
}

async function assertListenerStopped(origin) {
  try {
    await request(origin);
  } catch (error) {
    if (['ECONNREFUSED', 'EHOSTUNREACH', 'ENETUNREACH'].includes(error?.code)) return;
    throw error;
  }
  fail('REMOTE_LISTENER_STILL_RUNNING', 'The packaged Remote listener stayed reachable after Stop.');
}

async function runPackagedRemoteLanSmoke(paths) {
  assertPackagedElectronRuntime(paths);

  const remote = require(path.join(paths.archivePath, 'src/services/remote'));
  const {
    RemoteCommandAdapter
  } = require(path.join(paths.archivePath, 'src/services/show/RemoteCommandAdapter'));
  const {
    RemoteControlServer,
    isPrivateIpv4
  } = remote;
  if (typeof RemoteControlServer !== 'function'
    || typeof RemoteCommandAdapter !== 'function'
    || typeof isPrivateIpv4 !== 'function') {
    fail('PACKAGED_REMOTE_MODULES_MISSING', 'The packaged Remote modules are incomplete.');
  }

  let currentCueIndex = 0;
  let phase = 'live';
  const cues = Object.freeze([0, 1, 2].map(index => Object.freeze({
    id: `cue-${index + 1}`,
    index,
    label: `Cue ${index + 1}`,
    text: `Cue ${index + 1}`,
    thumbnailAvailable: false
  })));
  const readRuntimeState = () => ({
    hasActiveShow: true,
    phase,
    profileName: 'Packaged real-LAN smoke',
    currentSlide: currentCueIndex,
    totalSlides: cues.length,
    currentCue: cues[currentCueIndex],
    nextCue: cues[currentCueIndex + 1] || null,
    cues,
    outputs: [{
      id: 'main',
      name: 'Main output',
      renderer: 'slides',
      status: 'healthy',
      visible: true
    }],
    bible: { phase: 'idle' },
    permissions: { canOpenBiblePicker: false }
  });
  const adapter = new RemoteCommandAdapter({
    readRuntimeState,
    readCueCatalog: () => cues,
    commands: {
      previous: () => {
        currentCueIndex -= 1;
        return { accepted: true };
      },
      next: () => {
        currentCueIndex += 1;
        return { accepted: true };
      },
      jump: index => {
        currentCueIndex = index;
        return { accepted: true };
      },
      clear: () => {
        phase = 'cleared';
        return { accepted: true };
      },
      restore: () => {
        phase = 'live';
        return { accepted: true };
      }
    }
  });
  adapter.beginSession();

  const staticFiles = {
    '/': {
      filePath: path.join(paths.archivePath, 'src/remote/index.html'),
      contentType: 'text/html; charset=utf-8'
    },
    '/styles.css': {
      filePath: path.join(paths.archivePath, 'src/remote/remote.css'),
      contentType: 'text/css; charset=utf-8'
    },
    '/app.js': {
      filePath: path.join(paths.archivePath, 'src/remote/remote.js'),
      contentType: 'text/javascript; charset=utf-8'
    }
  };
  const expectedStaticBytes = new Map(
    Object.entries(staticFiles).map(([route, entry]) => [
      route,
      fs.readFileSync(entry.filePath)
    ])
  );
  const server = new RemoteControlServer({
    showGateway: adapter,
    staticRoutes: staticFiles
  });
  let stream = null;

  try {
    await server.startLoopback();
    const binding = selectRealLanBinding(server.listBindings(), isPrivateIpv4);
    const status = await server.bindLan(binding.id);
    assert.equal(status.mode, 'lan');
    assert.equal(status.binding.address, binding.address);
    assert.notEqual(status.binding.address, '127.0.0.1');
    assert.equal(status.origin, `http://${binding.address}:${status.binding.port}`);

    for (const [route, expectedBytes] of expectedStaticBytes) {
      const response = await request(status.origin, { requestPath: route });
      assert.equal(response.status, 200);
      assert.deepEqual(response.body, expectedBytes);
    }

    const grant = server.openPairing();
    const pairResponse = await request(status.origin, {
      requestPath: '/api/v1/pair',
      method: 'POST',
      originHeader: status.origin,
      body: {
        version: 1,
        deviceName: 'Packaged Mac self-smoke',
        ticket: grant.ticket
      }
    });
    const pair = jsonResponse(pairResponse);
    assert.equal(pair.ok, true);
    assert.equal(pair.paired, true);
    assert.equal(pair.nextSequence, 1);
    assert.equal(pair.state.currentCue.index, 0);
    const setCookie = pairResponse.headers['set-cookie'];
    assert.ok(Array.isArray(setCookie) && setCookie.length === 1);
    assert.match(setCookie[0], /HttpOnly/);
    assert.match(setCookie[0], /SameSite=Strict/);
    const cookie = setCookie[0].split(';', 1)[0];

    stream = await openEventStream(status.origin, cookie);
    const initialEvent = await stream.nextEvent();
    assert.equal(initialEvent.eventName, 'state');
    assert.equal(initialEvent.data.state.currentCue.index, 0);
    assert.equal(initialEvent.data.nextSequence, 1);

    let nextSequence = 1;
    let currentState = pair.state;
    const sendCommand = async ({ type, expectedCueIndex = null }) => {
      const body = buildSmokeCommandBody({
        state: currentState,
        sequence: nextSequence,
        type,
        expectedCueIndex
      });
      const response = await request(status.origin, {
        requestPath: '/api/v1/commands',
        method: 'POST',
        originHeader: status.origin,
        cookie,
        body
      });
      const result = jsonResponse(response);
      assert.equal(result.ok, true);
      assert.equal(result.accepted, true);
      assert.equal(result.duplicate, false);
      assert.equal(result.applied, true);
      currentState = result.state;
      nextSequence = result.nextSequence;
      return result;
    };

    const next = await sendCommand({
      type: 'cue.next',
      expectedCueIndex: 0
    });
    assert.equal(next.state.currentCue.index, 1);
    await nextMatchingState(
      stream,
      state => state?.revision >= next.state.revision && state.currentCue?.index === 1
    );

    const cleared = await sendCommand({ type: 'output.clear' });
    assert.equal(cleared.state.phase, 'cleared');
    await nextMatchingState(
      stream,
      state => state?.revision >= cleared.state.revision && state.phase === 'cleared'
    );

    const restored = await sendCommand({ type: 'output.restore' });
    assert.equal(restored.state.phase, 'live');
    await nextMatchingState(
      stream,
      state => state?.revision >= restored.state.revision && state.phase === 'live'
    );

    server.revokeAll('packaged-real-lan-smoke');
    await waitFor(
      stream.closed,
      EVENT_TIMEOUT_MS,
      'The packaged Remote event stream stayed open after revocation.'
    );
    const revoked = jsonResponse(await request(status.origin, {
      requestPath: '/api/v1/state',
      cookie
    }), 401);
    assert.equal(revoked.error.code, 'AUTH_REQUIRED');

    const stoppedOrigin = status.origin;
    await server.stop('packaged-real-lan-smoke-complete');
    assert.equal(server.getStatus().mode, 'off');
    assert.equal(server.getStatus().enabled, false);
    await assertListenerStopped(stoppedOrigin);

    process.stdout.write(`${JSON.stringify({
      ok: true,
      gate: 'packaged-remote-real-lan',
      electron: process.versions.electron,
      arch: process.arch,
      binding: {
        kind: 'lan',
        interfaceName: binding.interfaceName,
        address: binding.address
      },
      packagedAssets: [...expectedStaticBytes.keys()],
      stateStream: true,
      commands: ['cue.next', 'output.clear', 'output.restore'],
      revoke: true,
      stop: true,
      proofBoundary: 'same-Mac package/runtime self-smoke; no browser, phone, firewall, or venue claim'
    })}\n`);
  } finally {
    stream?.close();
    await server.destroy().catch(() => {});
  }
}

async function main(argv = process.argv.slice(2)) {
  if (argv.length !== 1) {
    fail(
      'INVALID_ARGUMENTS',
      'Usage: node scripts/verify-packaged-remote-lan.js /absolute/path/SyncShow.app'
    );
  }
  const paths = resolvePackagedApp(argv[0]);
  if (!process.versions.electron) {
    runThroughPackagedElectron(paths, paths.appPath);
    return;
  }
  await runPackagedRemoteLanSmoke(paths);
}

if (require.main === module) {
  main().catch(error => {
    const code = typeof error?.code === 'string' ? error.code : 'PACKAGED_REMOTE_GATE_FAILED';
    process.stderr.write(`[${code}] ${error?.message || 'Packaged Remote gate failed.'}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  assertPackagedElectronRuntime,
  buildSmokeCommandBody,
  main,
  physicalBundleFilesystem,
  resolvePackagedApp,
  runPackagedRemoteLanSmoke,
  selectRealLanBinding
};
