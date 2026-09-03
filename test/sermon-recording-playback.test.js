'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  SermonRecordingPlaybackAuthority,
  SermonRecordingPlaybackError,
  createSermonRecordingPlaybackResponse,
  parsePlaybackRange
} = require('../src/services/sermon/SermonRecordingPlayback');

const TOKEN_BYTES = Buffer.alloc(32, 0x2a);
const TOKEN = TOKEN_BYTES.toString('hex');
const BYTES = Buffer.from('exact private sermon recording bytes', 'utf8');

function binding(overrides = {}) {
  return {
    projectId: 'service-project',
    projectRevisionId: 'a'.repeat(64),
    itemId: 'sermon-item',
    sermonId: 'sermon-record',
    sermonRevisionId: 'b'.repeat(64),
    recordingId: 'post-service:recording:en',
    ...overrides
  };
}

function reader(bytes = BYTES) {
  let closed = false;
  return {
    kind: 'audio',
    mediaType: 'audio/mpeg',
    sha256: 'c'.repeat(64),
    sizeBytes: bytes.length,
    calls: [],
    get closed() {
      return closed;
    },
    async read(offset, length) {
      if (closed) throw new Error('closed');
      this.calls.push({ offset, length });
      return bytes.subarray(offset, offset + length);
    },
    async close() {
      closed = true;
    }
  };
}

function authority(options = {}) {
  return new SermonRecordingPlaybackAuthority({
    randomBytes: () => TOKEN_BYTES,
    ...options
  });
}

async function bodyBytes(response) {
  return Buffer.from(await response.arrayBuffer());
}

test('range parsing supports complete, bounded, open, and suffix requests', () => {
  assert.deepEqual(parsePlaybackRange(null, 100), {
    start: 0,
    end: 99,
    partial: false
  });
  assert.deepEqual(parsePlaybackRange('bytes=10-19', 100), {
    start: 10,
    end: 19,
    partial: true
  });
  assert.deepEqual(parsePlaybackRange('bytes=90-', 100), {
    start: 90,
    end: 99,
    partial: true
  });
  assert.deepEqual(parsePlaybackRange('bytes=-10', 100), {
    start: 90,
    end: 99,
    partial: true
  });
  assert.deepEqual(parsePlaybackRange('bytes=-500', 100), {
    start: 0,
    end: 99,
    partial: true
  });
  assert.equal(parsePlaybackRange('bytes=100-', 100), null);
  assert.equal(parsePlaybackRange('bytes=20-10', 100), null);
  assert.equal(parsePlaybackRange('bytes=0-1,4-5', 100), null);
  assert.equal(parsePlaybackRange('items=0-1', 100), null);
});

test('authority issues one expiring path-free token and closes replaced readers', async () => {
  let now = 1_000_000;
  const firstReader = reader();
  const secondReader = reader();
  const playback = authority({ now: () => now, ttlMs: 60_000 });
  const first = await playback.issue({
    reader: firstReader,
    binding: binding()
  });
  assert.equal(first.token, TOKEN);
  assert.deepEqual(first.binding, binding());
  assert.equal(Object.isFrozen(first), true);
  assert.equal(Object.isFrozen(first.binding), true);
  assert.doesNotMatch(
    JSON.stringify(first),
    /(?:sourcePath|filePath|localPath|\/private\/)/u
  );

  await playback.issue({
    reader: secondReader,
    binding: binding({ itemId: 'another-sermon-item' })
  });
  assert.equal(firstReader.closed, true);
  assert.equal(secondReader.closed, false);

  now += 60_000;
  assert.equal(await playback.resolve(TOKEN), null);
  assert.equal(secondReader.closed, true);
});

test('authority rejects caller-controlled paths and malformed exact bindings', async () => {
  const playback = authority();
  const mediaReader = reader();
  await assert.rejects(
    playback.issue({
      reader: mediaReader,
      binding: {
        ...binding(),
        projectId: '/private/service-project'
      }
    }),
    error => (
      error instanceof SermonRecordingPlaybackError
      && error.code === 'INVALID_PLAYBACK_BINDING'
    )
  );
  assert.equal(mediaReader.closed, true);
});

test('concurrent issuance keeps only the newest reader and token active', async () => {
  const firstReader = reader();
  const secondReader = reader();
  const randomValues = [
    Buffer.alloc(32, 0x11),
    Buffer.alloc(32, 0x22)
  ];
  const playback = new SermonRecordingPlaybackAuthority({
    randomBytes: () => randomValues.shift(),
    ttlMs: 60_000
  });
  const [first, second] = await Promise.all([
    playback.issue({ reader: firstReader, binding: binding() }),
    playback.issue({
      reader: secondReader,
      binding: binding({ itemId: 'newest-sermon-item' })
    })
  ]);

  assert.notEqual(first.token, second.token);
  assert.equal(firstReader.closed, true);
  assert.equal(secondReader.closed, false);
  assert.equal(await playback.resolve(first.token), null);
  assert.equal((await playback.resolve(second.token))?.binding.itemId, 'newest-sermon-item');
});

test('idle playback expires and closes its reader without another request', async () => {
  let expiryCallback;
  const cancelled = [];
  const mediaReader = reader();
  const playback = authority({
    ttlMs: 60_000,
    scheduleExpiry(callback, delay) {
      assert.equal(delay, 60_000);
      expiryCallback = callback;
      return 'expiry-timer';
    },
    cancelExpiry(timer) {
      cancelled.push(timer);
    }
  });
  await playback.issue({ reader: mediaReader, binding: binding() });

  await expiryCallback();
  assert.equal(mediaReader.closed, true);
  assert.equal(await playback.resolve(TOKEN), null);
  assert.deepEqual(cancelled, ['expiry-timer']);
});

test('protocol response streams the exact complete object and byte ranges', async () => {
  const mediaReader = reader();
  const playback = authority();
  await playback.issue({ reader: mediaReader, binding: binding() });

  const complete = await createSermonRecordingPlaybackResponse(
    new Request(`syncshow-sermon-media://play/${TOKEN}`),
    playback
  );
  assert.equal(complete.status, 200);
  assert.equal(complete.headers.get('content-type'), 'audio/mpeg');
  assert.equal(complete.headers.get('content-length'), String(BYTES.length));
  assert.equal(complete.headers.get('accept-ranges'), 'bytes');
  assert.equal(complete.headers.get('cache-control'), 'private, no-store');
  assert.deepEqual(await bodyBytes(complete), BYTES);

  const partial = await createSermonRecordingPlaybackResponse(
    new Request(`syncshow-sermon-media://play/${TOKEN}`, {
      headers: { Range: 'bytes=6-12' }
    }),
    playback
  );
  assert.equal(partial.status, 206);
  assert.equal(
    partial.headers.get('content-range'),
    `bytes 6-12/${BYTES.length}`
  );
  assert.equal(partial.headers.get('content-length'), '7');
  assert.deepEqual(await bodyBytes(partial), BYTES.subarray(6, 13));
  assert.deepEqual(mediaReader.calls, [
    { offset: 0, length: BYTES.length },
    { offset: 6, length: 7 }
  ]);
});

test('protocol response supports HEAD and fails closed for invalid or unknown requests', async () => {
  const playback = authority();
  await playback.issue({ reader: reader(), binding: binding() });

  const head = await createSermonRecordingPlaybackResponse(
    new Request(`syncshow-sermon-media://play/${TOKEN}`, { method: 'HEAD' }),
    playback
  );
  assert.equal(head.status, 200);
  assert.equal(head.body, null);
  assert.equal(head.headers.get('content-length'), String(BYTES.length));

  const unsatisfied = await createSermonRecordingPlaybackResponse(
    new Request(`syncshow-sermon-media://play/${TOKEN}`, {
      headers: { Range: `bytes=${BYTES.length}-` }
    }),
    playback
  );
  assert.equal(unsatisfied.status, 416);
  assert.equal(
    unsatisfied.headers.get('content-range'),
    `bytes */${BYTES.length}`
  );

  const unknown = await createSermonRecordingPlaybackResponse(
    new Request(
      `syncshow-sermon-media://play/${'f'.repeat(64)}`
    ),
    playback
  );
  assert.equal(unknown.status, 404);

  const queryRejected = await createSermonRecordingPlaybackResponse(
    new Request(
      `syncshow-sermon-media://play/${TOKEN}?path=/private/recording.mp3`
    ),
    playback
  );
  assert.equal(queryRejected.status, 404);

  const fragmentRejected = await createSermonRecordingPlaybackResponse(
    {
      method: 'GET',
      url: `syncshow-sermon-media://play/${TOKEN}#recording`,
      headers: new Headers()
    },
    playback
  );
  assert.equal(fragmentRejected.status, 404);

  const methodRejected = await createSermonRecordingPlaybackResponse(
    new Request(`syncshow-sermon-media://play/${TOKEN}`, {
      method: 'POST'
    }),
    playback
  );
  assert.equal(methodRejected.status, 405);
  assert.equal(methodRejected.headers.get('allow'), 'GET, HEAD');
});
