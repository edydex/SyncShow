'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const {
  RemoteControlServer,
  RemoteProtocolError
} = require('../src/services/remote');

const OUTPUT_SESSION_ID = '4c480506-4436-4e72-90d2-6e3fca88e775';

function cue(index) {
  return {
    id: `cue-${index + 1}`,
    index,
    number: index + 1,
    text: `Cue ${index + 1}`,
    thumbnailAvailable: true
  };
}

class FakeShowGateway {
  constructor() {
    this.state = {
      protocolVersion: 1,
      revision: 1,
      outputSessionId: OUTPUT_SESSION_ID,
      phase: 'live',
      profileName: 'Test Sanctuary',
      currentCue: cue(0),
      nextCue: cue(1),
      totalCues: 3,
      cues: [cue(0), cue(1), cue(2)],
      outputs: [{
        id: 'main',
        name: 'Main Screen',
        renderer: 'slides',
        status: 'healthy',
        visible: true
      }],
      bible: { phase: 'idle', reference: '', translationId: '', targetOutputIds: [] },
      controls: {
        canPrevious: false,
        canNext: true,
        canJump: true,
        canRestore: true,
        canClear: true
      },
      permissions: { canOpenBiblePicker: false }
    };
    this.listeners = new Set();
    this.calls = [];
    this.thumbnailCalls = [];
  }

  getState() {
    return JSON.parse(JSON.stringify(this.state));
  }

  getCueCatalog(outputSessionId) {
    assert.equal(outputSessionId, this.state.outputSessionId);
    return JSON.parse(JSON.stringify(this.state.cues));
  }

  subscribe(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async execute(envelope, context) {
    this.calls.push({ envelope: JSON.parse(JSON.stringify(envelope)), context: { ...context } });
    assert.equal(envelope.protocolVersion, 1);
    assert.equal(Object.hasOwn(envelope, 'sequence'), false);
    assert.equal(Object.hasOwn(envelope, 'commandId'), false);
    assert.equal(envelope.outputSessionId, this.state.outputSessionId);
    assert.equal(envelope.expectedRevision, this.state.revision);

    const currentIndex = this.state.currentCue.index;
    if (envelope.command.type === 'cue.next') {
      assert.equal(envelope.expectedCueIndex, currentIndex);
      this._moveTo(currentIndex + 1);
    } else if (envelope.command.type === 'cue.previous') {
      assert.equal(envelope.expectedCueIndex, currentIndex);
      this._moveTo(currentIndex - 1);
    } else if (envelope.command.type === 'cue.jump') {
      assert.equal(Object.hasOwn(envelope, 'expectedCueIndex'), false);
      this._moveTo(envelope.command.cueIndex);
    } else if (envelope.command.type === 'output.clear') {
      assert.equal(Object.hasOwn(envelope, 'expectedCueIndex'), false);
      this.state.phase = 'cleared';
      this._advanceRevision();
    } else if (envelope.command.type === 'output.restore') {
      assert.equal(Object.hasOwn(envelope, 'expectedCueIndex'), false);
      this.state.phase = 'live';
      this._advanceRevision();
    }
    return { applied: true, state: this.getState() };
  }

  async readCueThumbnail(sessionId, index) {
    this.thumbnailCalls.push({ sessionId, index });
    if (sessionId !== this.state.outputSessionId || index < 0 || index >= this.state.totalCues) {
      return null;
    }
    return {
      data: Buffer.from([0xff, 0xd8, 0xff, index]),
      contentType: 'image/jpeg'
    };
  }

  publishExternalChange() {
    this._moveTo(2);
  }

  _moveTo(index) {
    const bounded = Math.max(0, Math.min(this.state.totalCues - 1, index));
    this.state.currentCue = cue(bounded);
    this.state.nextCue = bounded + 1 < this.state.totalCues ? cue(bounded + 1) : null;
    this.state.controls.canPrevious = bounded > 0;
    this.state.controls.canNext = bounded < this.state.totalCues - 1;
    this._advanceRevision();
  }

  _advanceRevision() {
    this.state.revision += 1;
    const event = { reason: 'test-change', state: this.getState() };
    for (const listener of [...this.listeners]) listener(event);
  }
}

function request(port, {
  requestPath = '/',
  method = 'GET',
  host = `127.0.0.1:${port}`,
  origin,
  cookie,
  body,
  rawBody,
  contentType = 'application/json'
} = {}) {
  return new Promise((resolve, reject) => {
    const data = rawBody !== undefined
      ? Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(String(rawBody))
      : body !== undefined
        ? Buffer.from(JSON.stringify(body), 'utf8')
        : null;
    const headers = { Host: host, Connection: 'close' };
    if (origin !== undefined) headers.Origin = origin;
    if (cookie) headers.Cookie = cookie;
    if (data) {
      headers['Content-Type'] = contentType;
      headers['Content-Length'] = data.length;
    }
    const outgoing = http.request({
      hostname: '127.0.0.1',
      port,
      path: requestPath,
      method,
      headers,
      agent: false
    }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => {
        const responseBody = Buffer.concat(chunks);
        let json = null;
        if (String(response.headers['content-type'] || '').startsWith('application/json')) {
          json = JSON.parse(responseBody.toString('utf8'));
        }
        resolve({
          status: response.statusCode,
          headers: response.headers,
          body: responseBody,
          text: responseBody.toString('utf8'),
          json
        });
      });
    });
    outgoing.on('error', reject);
    outgoing.setTimeout(5000, () => outgoing.destroy(new Error('HTTP test request timed out')));
    if (data) outgoing.write(data);
    outgoing.end();
  });
}

function openEventStream(port, { cookie, origin }) {
  return new Promise((resolve, reject) => {
    const events = [];
    const waiters = [];
    let buffer = '';
    let closedResolve;
    const closed = new Promise(resolveClosed => { closedResolve = resolveClosed; });
    const outgoing = http.request({
      hostname: '127.0.0.1',
      port,
      path: '/api/v1/events',
      method: 'GET',
      headers: {
        Host: `127.0.0.1:${port}`,
        Origin: origin,
        Cookie: cookie,
        Accept: 'text/event-stream'
      },
      agent: false
    }, response => {
      if (response.statusCode !== 200) {
        response.resume();
        reject(new Error(`SSE returned ${response.statusCode}`));
        return;
      }
      response.setEncoding('utf8');
      const push = event => {
        const waiter = waiters.shift();
        if (waiter) waiter(event);
        else events.push(event);
      };
      response.on('data', chunk => {
        buffer += chunk;
        let boundary;
        while ((boundary = buffer.indexOf('\n\n')) >= 0) {
          const block = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          if (!block || block.startsWith(':')) continue;
          const eventName = block.match(/^event: ([^\n]+)$/m)?.[1] || 'message';
          const data = block.match(/^data: (.+)$/m)?.[1];
          push({ eventName, data: data ? JSON.parse(data) : null, raw: block });
        }
      });
      response.once('end', closedResolve);
      response.once('close', closedResolve);
      resolve({
        response,
        outgoing,
        closed,
        nextEvent(timeoutMs = 2000) {
          if (events.length > 0) return Promise.resolve(events.shift());
          return new Promise((resolveEvent, rejectEvent) => {
            const timer = setTimeout(() => rejectEvent(new Error('Timed out waiting for SSE state')), timeoutMs);
            waiters.push(event => {
              clearTimeout(timer);
              resolveEvent(event);
            });
          });
        },
        close() {
          outgoing.destroy();
          response.destroy();
        }
      });
    });
    outgoing.on('error', reject);
    outgoing.end();
  });
}

function cookieFrom(response) {
  const setCookie = response.headers['set-cookie'];
  assert.ok(Array.isArray(setCookie) && setCookie.length === 1);
  return setCookie[0].split(';')[0];
}

function commandBody({
  sequence = 1,
  commandId = '00000000-0000-4000-8000-000000000001',
  expectedRevision = 1,
  expectedCueIndex = 0,
  outputSessionId = OUTPUT_SESSION_ID,
  command = { type: 'cue.next' }
} = {}) {
  return {
    version: 1,
    outputSessionId,
    sequence,
    commandId,
    expectedRevision,
    expectedCueIndex,
    command
  };
}

test('real loopback lifecycle enforces security, pairing, commands, replay, SSE, revoke, and stop', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'syncshow-remote-http-'));
  const scriptPath = path.join(directory, 'app.js');
  await fs.writeFile(scriptPath, "document.body.dataset.ready = 'yes';\n", 'utf8');
  const gateway = new FakeShowGateway();
  const server = new RemoteControlServer({
    showGateway: gateway,
    staticRoutes: {
      '/': { body: '<!doctype html><script src="/app.js"></script>' },
      '/app.js': { filePath: scriptPath, contentType: 'text/javascript; charset=utf-8' },
      '/styles.css': { body: 'body { color: white; }', contentType: 'text/css; charset=utf-8' }
    }
  });
  t.after(async () => {
    await server.destroy().catch(() => {});
    await fs.rm(directory, { recursive: true, force: true });
  });

  assert.equal(server.getStatus().mode, 'off');
  assert.equal(server.getStatus().enabled, false);
  const status = await server.startLoopback();
  assert.equal(status.mode, 'loopback');
  assert.equal(status.binding.address, '127.0.0.1');
  const port = status.binding.port;
  const origin = status.origin;

  const page = await request(port);
  assert.equal(page.status, 200);
  assert.match(page.text, /app\.js/);
  assert.match(page.headers['content-security-policy'], /frame-ancestors 'none'/);
  assert.equal(page.headers['access-control-allow-origin'], undefined);
  const script = await request(port, { requestPath: '/app.js' });
  assert.equal(script.status, 200);
  assert.match(script.text, /dataset\.ready/);
  const normalizedPath = await request(port, { requestPath: '/not-a-route/../' });
  assert.equal(normalizedPath.status, 400);
  assert.equal(normalizedPath.json.error.code, 'INVALID_REQUEST_TARGET');

  const badHost = await request(port, { host: `127.0.0.1.evil:${port}` });
  assert.equal(badHost.status, 421);
  assert.equal(badHost.json.error.code, 'INVALID_HOST');

  const grant = server.openPairing();
  assert.equal(grant.pairingUrl, `${origin}/#pair=${grant.ticket}`);
  const badOrigin = await request(port, {
    requestPath: '/api/v1/pair',
    method: 'POST',
    origin: 'http://evil.example',
    body: { version: 1, deviceName: 'Phone', ticket: grant.ticket }
  });
  assert.equal(badOrigin.status, 403);
  assert.equal(badOrigin.json.error.code, 'INVALID_ORIGIN');

  const paired = await request(port, {
    requestPath: '/api/v1/pair',
    method: 'POST',
    origin,
    body: { version: 1, deviceName: 'Phone', ticket: grant.ticket }
  });
  assert.equal(paired.status, 200);
  assert.equal(paired.json.nextSequence, 1);
  assert.match(paired.headers['set-cookie'][0], /HttpOnly/);
  assert.match(paired.headers['set-cookie'][0], /SameSite=Strict/);
  assert.match(paired.headers['set-cookie'][0], /Path=\/api\/v1/);
  assert.doesNotMatch(paired.headers['set-cookie'][0], /Secure/);
  const cookie = cookieFrom(paired);

  const stateResponse = await request(port, {
    requestPath: '/api/v1/state',
    cookie
  });
  assert.equal(stateResponse.status, 200);
  assert.equal(stateResponse.json.state.revision, 1);
  assert.equal(Object.hasOwn(stateResponse.json.state, 'cues'), false);
  assert.equal(stateResponse.json.state.currentCue.thumbnailUrl,
    `/api/v1/cues/0/thumbnail?outputSessionId=${OUTPUT_SESSION_ID}`);
  assert.equal(stateResponse.headers['access-control-allow-origin'], undefined);

  const firstCuePage = await request(port, {
    requestPath: `/api/v1/cues?outputSessionId=${OUTPUT_SESSION_ID}&offset=0&limit=2`,
    cookie
  });
  assert.equal(firstCuePage.status, 200);
  assert.equal(firstCuePage.json.cues.length, 2);
  assert.equal(firstCuePage.json.cues[0].text, 'Cue 1');
  assert.equal(firstCuePage.json.nextOffset, 2);
  assert.equal(firstCuePage.json.cues[0].thumbnailUrl,
    `/api/v1/cues/0/thumbnail?outputSessionId=${OUTPUT_SESSION_ID}`);

  const finalCuePage = await request(port, {
    requestPath: `/api/v1/cues?outputSessionId=${OUTPUT_SESSION_ID}&offset=2&limit=2`,
    cookie
  });
  assert.equal(finalCuePage.status, 200);
  assert.equal(finalCuePage.json.cues.length, 1);
  assert.equal(finalCuePage.json.nextOffset, null);

  const thumbnail = await request(port, {
    requestPath: stateResponse.json.state.currentCue.thumbnailUrl,
    cookie
  });
  assert.equal(thumbnail.status, 200);
  assert.equal(thumbnail.headers['content-type'], 'image/jpeg');
  assert.deepEqual([...thumbnail.body], [0xff, 0xd8, 0xff, 0]);
  assert.deepEqual(gateway.thumbnailCalls, [{ sessionId: OUTPUT_SESSION_ID, index: 0 }]);

  const badThumbnailSession = await request(port, {
    requestPath: '/api/v1/cues/0/thumbnail?outputSessionId=old-session',
    cookie
  });
  assert.equal(badThumbnailSession.status, 409);
  assert.equal(badThumbnailSession.json.error.code, 'STALE_OUTPUT_SESSION');

  const nextCommand = commandBody();
  const next = await request(port, {
    requestPath: '/api/v1/commands',
    method: 'POST',
    origin,
    cookie,
    body: nextCommand
  });
  assert.equal(next.status, 200);
  assert.equal(next.json.duplicate, false);
  assert.equal(next.json.nextSequence, 2);
  assert.equal(next.json.state.currentCue.index, 1);
  assert.equal(gateway.calls.length, 1);
  assert.deepEqual(gateway.calls[0].envelope, {
    protocolVersion: 1,
    outputSessionId: OUTPUT_SESSION_ID,
    expectedRevision: 1,
    command: { type: 'cue.next' },
    expectedCueIndex: 0
  });

  const exactRetry = await request(port, {
    requestPath: '/api/v1/commands',
    method: 'POST',
    origin,
    cookie,
    body: nextCommand
  });
  assert.equal(exactRetry.status, 200);
  assert.equal(exactRetry.json.duplicate, true);
  assert.equal(exactRetry.json.state.revision, 2);
  assert.equal(gateway.calls.length, 1);

  const alteredReplay = await request(port, {
    requestPath: '/api/v1/commands',
    method: 'POST',
    origin,
    cookie,
    body: commandBody({ commandId: '00000000-0000-4000-8000-000000000099' })
  });
  assert.equal(alteredReplay.status, 409);
  assert.equal(alteredReplay.json.error.code, 'SEQUENCE_REPLAY');
  assert.equal(alteredReplay.json.nextSequence, 2);
  assert.equal(alteredReplay.json.state.currentCue.index, 1);

  const clear = await request(port, {
    requestPath: '/api/v1/commands',
    method: 'POST',
    origin,
    cookie,
    body: commandBody({
      sequence: 2,
      commandId: '00000000-0000-4000-8000-000000000002',
      expectedRevision: 2,
      expectedCueIndex: null,
      command: { type: 'output.clear' }
    })
  });
  assert.equal(clear.status, 200);
  assert.equal(clear.json.state.phase, 'cleared');
  assert.equal(Object.hasOwn(gateway.calls[1].envelope, 'expectedCueIndex'), false);

  const oversized = await request(port, {
    requestPath: '/api/v1/commands',
    method: 'POST',
    origin,
    cookie,
    rawBody: Buffer.alloc(5000, 0x20)
  });
  assert.equal(oversized.status, 413);
  assert.equal(oversized.json.error.code, 'BODY_TOO_LARGE');

  const stream = await openEventStream(port, { cookie, origin });
  const initialEvent = await stream.nextEvent();
  assert.equal(initialEvent.eventName, 'state');
  assert.equal(initialEvent.data.state.phase, 'cleared');
  assert.equal(initialEvent.data.nextSequence, 3);

  gateway.publishExternalChange();
  let changedEvent;
  do {
    changedEvent = await stream.nextEvent();
  } while (changedEvent.data.state.revision < 4);
  assert.equal(changedEvent.eventName, 'state');
  assert.equal(changedEvent.data.state.currentCue.index, 2);

  server.revokeAll('test-revoke');
  await stream.closed;
  const revoked = await request(port, {
    requestPath: '/api/v1/state',
    cookie
  });
  assert.equal(revoked.status, 401);

  const codeGrant = server.openPairing();
  const codePair = await request(port, {
    requestPath: '/api/v1/pair',
    method: 'POST',
    origin,
    body: { version: 1, deviceName: 'Tablet', code: codeGrant.code }
  });
  assert.equal(codePair.status, 200);

  await server.stop();
  assert.equal(server.getStatus().mode, 'off');
  assert.equal(server.getStatus().enabled, false);
  await assert.rejects(request(port), error => error.code === 'ECONNREFUSED');
});

test('LAN binding requires prior loopback start and revokes credentials on rebind', async t => {
  const gateway = new FakeShowGateway();
  const loopback = {
    id: 'opaque-loopback',
    interfaceName: 'Loopback',
    label: 'This computer only',
    address: '127.0.0.1',
    kind: 'loopback'
  };
  const lan = {
    id: 'opaque-lan-choice',
    interfaceName: 'Test LAN',
    label: 'Test LAN',
    // The lifecycle is tested on a real loopback socket; the production
    // NetworkBindingCatalog never classifies this address as LAN.
    address: '127.0.0.1',
    kind: 'lan'
  };
  const bindingCatalog = {
    list: () => [loopback, lan].map(value => ({ ...value })),
    loopback: () => ({ ...loopback }),
    resolve: (id, options = {}) => id === lan.id && (!options.kind || options.kind === 'lan')
      ? { ...lan }
      : null
  };
  const server = new RemoteControlServer({ showGateway: gateway, bindingCatalog });
  t.after(() => server.destroy().catch(() => {}));

  await assert.rejects(server.bindLan(lan.id), error => {
    assert.ok(error instanceof RemoteProtocolError);
    assert.equal(error.code, 'LOOPBACK_REQUIRED');
    return true;
  });

  const localStatus = await server.startLoopback();
  const localOrigin = localStatus.origin;
  const grant = server.openPairing();
  const paired = await request(localStatus.binding.port, {
    requestPath: '/api/v1/pair',
    method: 'POST',
    origin: localOrigin,
    body: { version: 1, deviceName: 'Phone', ticket: grant.ticket }
  });
  const cookie = cookieFrom(paired);

  const lanStatus = await server.bindLan(lan.id);
  assert.equal(lanStatus.mode, 'lan');
  assert.equal(lanStatus.binding.id, lan.id);
  const oldCredential = await request(lanStatus.binding.port, {
    requestPath: '/api/v1/state',
    cookie
  });
  assert.equal(oldCredential.status, 401);
  assert.match(server.openPairing().pairingUrl, new RegExp(`^${lanStatus.origin.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/#pair=`));
});

test('pairing attempts are rate-limited globally and per peer', async t => {
  const gateway = new FakeShowGateway();
  const server = new RemoteControlServer({
    showGateway: gateway,
    limits: { pairPerIp: 1, pairGlobal: 10 }
  });
  t.after(() => server.destroy().catch(() => {}));
  const status = await server.startLoopback();
  const grant = server.openPairing();
  const first = await request(status.binding.port, {
    requestPath: '/api/v1/pair',
    method: 'POST',
    origin: status.origin,
    body: { version: 1, deviceName: 'Attacker', code: '999999' }
  });
  assert.equal(first.status, 401);

  const limited = await request(status.binding.port, {
    requestPath: '/api/v1/pair',
    method: 'POST',
    origin: status.origin,
    body: { version: 1, deviceName: 'Phone', code: grant.code }
  });
  assert.equal(limited.status, 429);
  assert.equal(limited.json.error.code, 'RATE_LIMITED');
  assert.equal(limited.headers['retry-after'], '60');
});
