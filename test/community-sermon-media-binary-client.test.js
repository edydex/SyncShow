'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Readable } = require('node:stream');

const {
  CommunityBinaryClient,
  CommunityBinaryClientError,
  DEFAULT_TIMEOUT_MS,
  MAX_REQUEST_TIMEOUT_MS
} = require('../src/services/community/CommunityBinaryClient');

const BASE_URL = 'https://community.example.test/';
const ENDPOINT =
  'https://community.example.test/api/community/syncshow/v1/sermon-media';
const ACCESS_TOKEN = 'community-private-access-token-000001';

function response(payload, status = 200, headers = {}) {
  return new Response(
    payload === null ? null : JSON.stringify(payload),
    {
      status,
      headers: {
        'Content-Type': 'application/json',
        ...headers
      }
    }
  );
}

function client(fetchImpl, options = {}) {
  return new CommunityBinaryClient({
    baseUrl: BASE_URL,
    endpoint: ENDPOINT,
    accessToken: ACCESS_TOKEN,
    fetchImpl,
    ...options
  });
}

function fakeClock() {
  let now = 0;
  let sequence = 0;
  const timers = new Map();
  return {
    setTimeoutImpl(callback, delayMs) {
      const token = {
        id: ++sequence,
        unref() {}
      };
      timers.set(token.id, {
        callback,
        dueAt: now + delayMs
      });
      return token;
    },
    clearTimeoutImpl(token) {
      timers.delete(token?.id);
    },
    advance(delayMs) {
      now += delayMs;
      for (const [id, timer] of [...timers.entries()]) {
        if (timer.dueAt <= now) {
          timers.delete(id);
          timer.callback();
        }
      }
    },
    get pending() {
      return [...timers.values()].map(timer => timer.dueAt - now);
    }
  };
}

test('binary helper pins every request to the exact same-origin API endpoint', async () => {
  assert.throws(
    () => new CommunityBinaryClient({
      baseUrl: BASE_URL,
      endpoint:
        'https://attacker.example/api/community/syncshow/v1/sermon-media',
      accessToken: ACCESS_TOKEN,
      fetchImpl: async () => response({})
    }),
    /pinned API origin/
  );

  const calls = [];
  const binary = client(async (input, options) => {
    calls.push({ input, options });
    return response({ schemaVersion: 1, upload: {} });
  });
  await binary.requestJson({
    path: 'uploads',
    method: 'POST',
    body: { schemaVersion: 1 },
    headers: { 'Idempotency-Key': 'syncshow-media-init:12345678' }
  });

  assert.equal(
    calls[0].input,
    `${ENDPOINT}/uploads`
  );
  assert.equal(calls[0].options.redirect, 'manual');
  assert.equal(
    calls[0].options.headers.Authorization,
    `SyncShow ${ACCESS_TOKEN}`
  );
  assert.equal(calls[0].options.headers.Accept, 'application/json');
  assert.equal(calls[0].options.headers['Content-Type'], 'application/json');
  assert.equal(
    calls[0].options.headers['Content-Length'],
    String(Buffer.byteLength(calls[0].options.body))
  );
  assert.deepEqual(JSON.parse(calls[0].options.body), { schemaVersion: 1 });
  for (const reservedHeader of [
    { Authorization: 'Bearer attacker' },
    { authorization: 'Bearer attacker' },
    { ACCEPT: 'text/html' }
  ]) {
    await assert.rejects(
      binary.requestJson({
        path: 'uploads',
        headers: reservedHeader
      }),
      /Community binary headers are invalid/
    );
  }
  assert.equal(calls.length, 1);

  for (const invalid of [
    '../outside',
    'uploads?redirect=https://attacker.example',
    'uploads\\outside',
    'uploads/./outside'
  ]) {
    assert.throws(
      () => binary._url(invalid),
      /request path is invalid/
    );
  }
});

test('binary helper sends a raw stream with exact transfer integrity headers', async () => {
  const source = Buffer.from('private sermon bytes');
  const calls = [];
  const binary = client(async (input, options) => {
    const parts = [];
    for await (const part of options.body) parts.push(Buffer.from(part));
    calls.push({ input, options, body: Buffer.concat(parts) });
    return response({ accepted: true }, 201);
  });

  const result = await binary.requestBinary({
    path: 'uploads/ABCDEFGHIJKLMNOPQRSTUVWX12345678/chunks/0',
    body: Readable.from([source]),
    contentLength: source.length,
    contentRange: `bytes 0-${source.length - 1}/${source.length}`,
    sha256: 'a'.repeat(64),
    idempotencyKey: 'syncshow-media-chunk:12345678',
    expectedStatuses: [201]
  });

  assert.equal(result.status, 201);
  assert.deepEqual(result.payload, { accepted: true });
  assert.deepEqual(calls[0].body, source);
  assert.equal(calls[0].options.duplex, 'half');
  assert.equal(
    calls[0].options.headers['Content-Type'],
    'application/octet-stream'
  );
  assert.equal(
    calls[0].options.headers['Content-Length'],
    String(source.length)
  );
  assert.equal(
    calls[0].options.headers['Content-Range'],
    `bytes 0-${source.length - 1}/${source.length}`
  );
  assert.equal(calls[0].options.headers['X-Content-SHA256'], 'a'.repeat(64));
  assert.equal(
    calls[0].options.headers['Idempotency-Key'],
    'syncshow-media-chunk:12345678'
  );
});

test('binary helper rejects redirects, oversized JSON, and exact server errors', async () => {
  await assert.rejects(
    client(async () => response({}, 302)).requestJson({ path: 'uploads' }),
    error => {
      assert.equal(error.code, 'UNSAFE_REDIRECT');
      return true;
    }
  );

  await assert.rejects(
    client(
      async () => response({}, 200, { 'Content-Length': '4096' }),
      { maximumJsonBytes: 1024 }
    ).requestJson({ path: 'uploads' }),
    error => {
      assert.equal(error.code, 'RESPONSE_TOO_LARGE');
      return true;
    }
  );

  await assert.rejects(
    client(async () => response({
      schemaVersion: 1,
      error: {
        code: 'STALE_SERMON_BINDING',
        message: 'The exact sermon changed.',
        retryable: false
      }
    }, 412)).requestJson({ path: 'uploads' }),
    error => {
      assert.ok(error instanceof CommunityBinaryClientError);
      assert.equal(error.code, 'STALE_SERMON_BINDING');
      assert.equal(error.status, 412);
      assert.equal(error.retryable, false);
      return true;
    }
  );
});

test('chunked JSON without Content-Length stops at the cap and cancels the body', async () => {
  let reads = 0;
  let cancellations = 0;
  const body = new ReadableStream({
    pull(controller) {
      reads += 1;
      controller.enqueue(new Uint8Array(700).fill(0x20));
      if (reads === 3) controller.close();
    },
    cancel() {
      cancellations += 1;
    }
  }, {
    highWaterMark: 0
  });
  const oversized = new Response(body, {
    status: 200,
    headers: {
      'Content-Type': 'application/json'
    }
  });
  assert.equal(oversized.headers.get('Content-Length'), null);

  await assert.rejects(
    client(
      async () => oversized,
      { maximumJsonBytes: 1024 }
    ).requestJson({ path: 'uploads' }),
    error => {
      assert.equal(error.code, 'RESPONSE_TOO_LARGE');
      return true;
    }
  );
  assert.equal(reads, 2, 'the third response chunk is never requested');
  assert.equal(cancellations, 1, 'the oversized response stream is cancelled');
});

test('parent cancellation aborts the active request without following up', async () => {
  const controller = new AbortController();
  let calls = 0;
  const binary = client((_input, options) => {
    calls += 1;
    return new Promise((resolve, reject) => {
      options.signal.addEventListener('abort', () => {
        const error = new Error('aborted');
        error.name = 'AbortError';
        reject(error);
      }, { once: true });
    });
  });
  const pending = binary.requestJson({
    path: 'uploads/ABCDEFGHIJKLMNOPQRSTUVWX12345678',
    signal: controller.signal
  });
  controller.abort();

  await assert.rejects(pending, error => {
    assert.equal(error.code, 'REQUEST_CANCELLED');
    assert.equal(error.retryable, false);
    return true;
  });
  assert.equal(calls, 1);
});

test('ordinary requests keep the 30-second bound and clean timer/listener state', async () => {
  const clock = fakeClock();
  let added = 0;
  let removed = 0;
  const parentSignal = {
    aborted: false,
    reason: undefined,
    addEventListener(type) {
      assert.equal(type, 'abort');
      added += 1;
    },
    removeEventListener(type) {
      assert.equal(type, 'abort');
      removed += 1;
    }
  };
  const binary = client(async () => response({ accepted: true }), {
    setTimeoutImpl: clock.setTimeoutImpl,
    clearTimeoutImpl: clock.clearTimeoutImpl
  });

  const result = await binary.requestJson({
    path: 'uploads',
    signal: parentSignal
  });

  assert.equal(result.status, 200);
  assert.deepEqual(result.payload, { accepted: true });
  assert.equal(DEFAULT_TIMEOUT_MS, 30_000);
  assert.equal(added, 1);
  assert.equal(removed, 1);
  assert.deepEqual(clock.pending, []);
});

test('an explicit request deadline can outlive the legacy 30-second bound', async () => {
  const clock = fakeClock();
  let settleFetch;
  let requestSignal;
  const binary = client((_input, options) => {
    requestSignal = options.signal;
    return new Promise(resolve => {
      settleFetch = resolve;
    });
  }, {
    setTimeoutImpl: clock.setTimeoutImpl,
    clearTimeoutImpl: clock.clearTimeoutImpl
  });
  const pending = binary.requestJson({
    path: 'uploads',
    timeoutMs: 5 * 60_000
  });
  await Promise.resolve();

  assert.deepEqual(clock.pending, [5 * 60_000]);
  clock.advance(DEFAULT_TIMEOUT_MS + 1);
  assert.equal(requestSignal.aborted, false);
  settleFetch(response({ accepted: true }));

  const result = await pending;
  assert.deepEqual(result.payload, { accepted: true });
  assert.deepEqual(clock.pending, []);
});

test('invalid or excessive per-request deadlines fail before fetch', async () => {
  let calls = 0;
  const binary = client(async () => {
    calls += 1;
    return response({ accepted: true });
  });

  for (const timeoutMs of [
    999,
    MAX_REQUEST_TIMEOUT_MS + 1,
    Number.NaN,
    1.5,
    null
  ]) {
    await assert.rejects(
      binary.requestJson({ path: 'uploads', timeoutMs }),
      /Community binary request timeout is invalid/
    );
  }
  assert.equal(calls, 0);
});

test('HTML and malformed 5xx responses retain bounded status retryability', async () => {
  for (const [status, payload, headers] of [
    [524, '<html>Cloudflare timeout</html>', { 'Content-Type': 'text/html' }],
    [503, '{not-json', { 'Content-Type': 'application/json' }],
    [
      502,
      'x'.repeat(2048),
      {
        'Content-Type': 'text/html',
        'Content-Length': '2048'
      }
    ]
  ]) {
    const binary = client(async () => new Response(payload, {
      status,
      headers
    }), {
      maximumJsonBytes: 1024
    });
    await assert.rejects(
      binary.requestJson({ path: 'uploads' }),
      error => {
        assert.ok(error instanceof CommunityBinaryClientError);
        assert.equal(error.code, 'SERVER_UNAVAILABLE');
        assert.equal(error.status, status);
        assert.equal(error.retryable, true);
        assert.doesNotMatch(error.message, /Cloudflare|not-json|xxx/u);
        return true;
      }
    );
  }
});
