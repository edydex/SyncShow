'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');

const {
  DEFAULT_MAX_MEDIA_BYTES,
  LocalSermonMediaStore,
  LocalSermonMediaStoreError,
  MEDIA_IO_CHUNK_BYTES
} = require('../src/services/sermon/LocalSermonMediaStore');

async function tempDirectory(t, prefix = 'syncshow-sermon-media-') {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return fs.realpath(directory);
}

function expectStoreCode(code, forbiddenText = []) {
  return error => {
    assert.ok(error instanceof LocalSermonMediaStoreError);
    assert.equal(error.code, code);
    for (const text of forbiddenText) {
      assert.equal(error.message.includes(text), false);
    }
    return true;
  };
}

function mp3Frame() {
  const frame = Buffer.alloc(417);
  Buffer.from([0xff, 0xfb, 0x90, 0x64]).copy(frame);
  return frame;
}

function validMp3(frameCount = 3, { id3 = false } = {}) {
  const frames = Buffer.concat(Array.from({ length: frameCount }, mp3Frame));
  if (!id3) return frames;
  const tagBody = Buffer.from('SyncShow sermon recording', 'utf8');
  const size = tagBody.length;
  const sizeBytes = Buffer.from([
    (size >>> 21) & 0x7f,
    (size >>> 14) & 0x7f,
    (size >>> 7) & 0x7f,
    size & 0x7f
  ]);
  return Buffer.concat([
    Buffer.from([0x49, 0x44, 0x33, 0x04, 0x00, 0x00]),
    sizeBytes,
    tagBody,
    frames
  ]);
}

function isoBox(type, payload = Buffer.alloc(0)) {
  assert.equal(Buffer.byteLength(type, 'latin1'), 4);
  const header = Buffer.alloc(8);
  header.writeUInt32BE(8 + payload.length, 0);
  header.write(type, 4, 4, 'latin1');
  return Buffer.concat([header, payload]);
}

function validIsoMedia({ audio = false, video = false, majorBrand = 'isom' } = {}) {
  const handlers = [];
  if (audio) handlers.push('soun');
  if (video) handlers.push('vide');
  const tracks = handlers.map(handlerType => {
    const handler = Buffer.alloc(12);
    handler.write(handlerType, 8, 4, 'latin1');
    return isoBox('trak', isoBox('mdia', isoBox('hdlr', handler)));
  });
  const ftyp = isoBox('ftyp', Buffer.concat([
    Buffer.from(majorBrand, 'latin1'),
    Buffer.alloc(4),
    Buffer.from('isom', 'latin1')
  ]));
  return Buffer.concat([
    ftyp,
    isoBox('moov', Buffer.concat(tracks)),
    isoBox('mdat', Buffer.from('recorded-sermon-media'))
  ]);
}

function objectPath(rootPath, digest) {
  return path.join(rootPath, 'objects', digest.slice(0, 2), digest);
}

async function readAll(iterable) {
  const chunks = [];
  for await (const chunk of iterable) chunks.push(chunk);
  return Buffer.concat(chunks);
}

test('media store requires a private absolute root and defaults to a 1 GiB ceiling', async t => {
  assert.equal(DEFAULT_MAX_MEDIA_BYTES, 1024 * 1024 * 1024);
  assert.throws(
    () => new LocalSermonMediaStore({ rootPath: 'relative-media' }),
    /requires an absolute rootPath/
  );
  assert.throws(
    () => new LocalSermonMediaStore({
      rootPath: path.resolve('media'),
      maximumBytes: DEFAULT_MAX_MEDIA_BYTES + 1
    }),
    /maximumBytes/
  );

  const parent = await tempDirectory(t);
  const rootPath = path.join(parent, 'store');
  await fs.mkdir(rootPath, { mode: 0o777 });
  if (process.platform !== 'win32') await fs.chmod(rootPath, 0o777);
  const store = await new LocalSermonMediaStore({ rootPath }).initialize();

  assert.equal(store.maximumBytes, DEFAULT_MAX_MEDIA_BYTES);
  assert.equal(store.rootPath, await fs.realpath(rootPath));
  for (const directory of [
    rootPath,
    path.join(rootPath, 'objects'),
    path.join(rootPath, '.staging')
  ]) {
    const stats = await fs.lstat(directory);
    assert.equal(stats.isDirectory(), true);
    assert.equal(stats.isSymbolicLink(), false);
    if (process.platform !== 'win32') assert.equal(stats.mode & 0o777, 0o700);
  }
});

test('MP3, M4A, and MP4 imports are content-addressed, path-free, private, and readable in chunks', async t => {
  const rootPath = await tempDirectory(t);
  const selectedRoot = await tempDirectory(t, 'syncshow-selected-recordings-');
  const fixtures = [{
    fileName: 'Sunday sermon.mp3',
    bytes: validMp3(3, { id3: true }),
    kind: 'audio',
    mediaType: 'audio/mpeg'
  }, {
    fileName: 'Sunday sermon.m4a',
    bytes: validIsoMedia({ audio: true, majorBrand: 'M4A ' }),
    kind: 'audio',
    mediaType: 'audio/mp4'
  }, {
    fileName: 'Sunday sermon.mp4',
    bytes: validIsoMedia({ audio: true, video: true }),
    kind: 'video',
    mediaType: 'video/mp4'
  }];
  const store = new LocalSermonMediaStore({ rootPath });

  for (const fixture of fixtures) {
    const sourcePath = path.join(selectedRoot, fixture.fileName);
    await fs.writeFile(sourcePath, fixture.bytes);
    const imported = await store.importFile({ sourcePath });
    const digest = crypto.createHash('sha256').update(fixture.bytes).digest('hex');

    assert.equal(imported.objectId, `sha256:${digest}`);
    assert.deepEqual(imported.media, {
      kind: fixture.kind,
      mediaType: fixture.mediaType,
      fileName: fixture.fileName,
      sha256: digest,
      sizeBytes: fixture.bytes.length,
      durationSeconds: null
    });
    assert.equal(Object.isFrozen(imported), true);
    assert.equal(Object.isFrozen(imported.media), true);
    assert.deepEqual(Object.keys(imported.media), [
      'kind',
      'mediaType',
      'fileName',
      'sha256',
      'sizeBytes',
      'durationSeconds'
    ]);
    assert.doesNotMatch(
      JSON.stringify(imported),
      new RegExp(selectedRoot.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'))
    );

    const storedPath = objectPath(rootPath, digest);
    const storedStats = await fs.lstat(storedPath);
    assert.equal(storedStats.isFile(), true);
    assert.equal(storedStats.isSymbolicLink(), false);
    if (process.platform !== 'win32') {
      assert.equal(storedStats.mode & 0o777, 0o600);
      assert.equal(
        (await fs.lstat(path.dirname(storedPath))).mode & 0o777,
        0o700
      );
    }

    await fs.unlink(sourcePath);
    assert.deepEqual(await store.checkObject(imported.objectId, {
      sizeBytes: fixture.bytes.length,
      mediaType: fixture.mediaType
    }), {
      objectId: imported.objectId,
      sha256: digest,
      sizeBytes: fixture.bytes.length
    });
    assert.equal((await store.checkMedia(imported.media)).objectId, imported.objectId);
    assert.deepEqual(
      await readAll(store.readObject(imported.objectId, {
        sizeBytes: fixture.bytes.length,
        mediaType: fixture.mediaType
      })),
      fixture.bytes
    );
  }
});

test('large MP3 import and read stay chunked and deduplicate by SHA-256', async t => {
  const rootPath = await tempDirectory(t);
  const selectedRoot = await tempDirectory(t, 'syncshow-large-recording-');
  const sourcePath = path.join(selectedRoot, 'long-sermon.mp3');
  const frame = mp3Frame();
  const frameCount = Math.ceil(((MEDIA_IO_CHUNK_BYTES * 2) + 50_000) / frame.length);
  const bytes = Buffer.concat(Array.from({ length: frameCount }, () => frame));
  await fs.writeFile(sourcePath, bytes);
  const store = new LocalSermonMediaStore({ rootPath });

  const first = await store.importFile({ sourcePath });
  const second = await store.importFile({ sourcePath });
  assert.deepEqual(second, first);
  const prefixDirectory = path.dirname(objectPath(rootPath, first.media.sha256));
  assert.deepEqual(await fs.readdir(prefixDirectory), [first.media.sha256]);

  const chunks = [];
  for await (const chunk of store.readObject(first.objectId, {
    sizeBytes: bytes.length,
    mediaType: 'audio/mpeg'
  })) {
    chunks.push(chunk);
    assert.ok(chunk.length <= MEDIA_IO_CHUNK_BYTES);
  }
  assert.ok(chunks.length >= 3);
  assert.deepEqual(Buffer.concat(chunks), bytes);
});

test('verified playback sessions read bounded exact ranges and close without exposing paths', async t => {
  const rootPath = await tempDirectory(t);
  const selectedRoot = await tempDirectory(t, 'syncshow-playback-recording-');
  const sourcePath = path.join(selectedRoot, 'Sunday sermon.mp3');
  const bytes = validMp3(8, { id3: true });
  await fs.writeFile(sourcePath, bytes);
  const store = new LocalSermonMediaStore({ rootPath });
  const imported = await store.importFile({ sourcePath });
  await fs.unlink(sourcePath);

  const session = await store.openMediaReadSession(imported.media);
  assert.equal(Object.isFrozen(session), true);
  assert.deepEqual(Object.keys(session), [
    'objectId',
    'kind',
    'mediaType',
    'sha256',
    'sizeBytes',
    'read',
    'close'
  ]);
  assert.equal(session.objectId, imported.objectId);
  assert.equal(session.kind, 'audio');
  assert.equal(session.mediaType, 'audio/mpeg');
  assert.equal(session.sha256, imported.media.sha256);
  assert.equal(session.sizeBytes, bytes.length);
  assert.doesNotMatch(
    JSON.stringify(session),
    new RegExp(
      [selectedRoot, rootPath]
        .map(value => value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'))
        .join('|')
    )
  );

  assert.deepEqual(await session.read(0, 17), bytes.subarray(0, 17));
  assert.deepEqual(
    await session.read(bytes.length - 23, 23),
    bytes.subarray(bytes.length - 23)
  );
  await assert.rejects(
    session.read(-1, 1),
    expectStoreCode('INVALID_READ_RANGE')
  );
  await assert.rejects(
    session.read(0, MEDIA_IO_CHUNK_BYTES + 1),
    expectStoreCode('INVALID_READ_RANGE')
  );
  await assert.rejects(
    session.read(bytes.length - 1, 2),
    expectStoreCode('INVALID_READ_RANGE')
  );

  await session.close();
  await session.close();
  await assert.rejects(
    session.read(0, 1),
    expectStoreCode('READ_SESSION_CLOSED')
  );

  const playbackAbort = new AbortController();
  const abortable = await store.openMediaReadSession(imported.media, {
    signal: playbackAbort.signal
  });
  playbackAbort.abort();
  await assert.rejects(
    abortable.read(0, 1),
    expectStoreCode('READ_SESSION_CLOSED')
  );
  await abortable.close();

  const alreadyAborted = new AbortController();
  alreadyAborted.abort();
  await assert.rejects(
    store.openMediaReadSession(imported.media, {
      signal: alreadyAborted.signal
    }),
    expectStoreCode('READ_ABORTED')
  );
});

test('playback session creation fails closed for corrupt bytes and inconsistent metadata', async t => {
  const rootPath = await tempDirectory(t);
  const selectedRoot = await tempDirectory(t, 'syncshow-playback-corrupt-');
  const sourcePath = path.join(selectedRoot, 'Sunday sermon.m4a');
  const bytes = validIsoMedia({ audio: true, majorBrand: 'M4A ' });
  await fs.writeFile(sourcePath, bytes);
  const store = new LocalSermonMediaStore({ rootPath });
  const imported = await store.importFile({ sourcePath });

  await assert.rejects(
    store.openMediaReadSession({
      ...imported.media,
      mediaType: 'video/mp4'
    }),
    expectStoreCode('INVALID_MEDIA_METADATA')
  );

  const storedPath = objectPath(rootPath, imported.media.sha256);
  const corrupt = Buffer.from(bytes);
  corrupt[corrupt.length - 1] ^= 0x01;
  await fs.writeFile(storedPath, corrupt, { mode: 0o600 });
  if (process.platform !== 'win32') await fs.chmod(storedPath, 0o600);
  await assert.rejects(
    store.openMediaReadSession(imported.media),
    expectStoreCode('OBJECT_CORRUPT', [storedPath, rootPath])
  );
});

test('extension-only impostors and mismatched audio/video MP4 tracks fail closed', async t => {
  const rootPath = await tempDirectory(t);
  const selectedRoot = await tempDirectory(t, 'syncshow-impostor-recordings-');
  const store = new LocalSermonMediaStore({ rootPath });
  const fixtures = [{
    fileName: 'text.mp3',
    bytes: Buffer.from('This is not an MP3 recording.'),
    code: 'MEDIA_TYPE_MISMATCH'
  }, {
    fileName: 'mp4-renamed.mp3',
    bytes: validIsoMedia({ video: true }),
    code: 'MEDIA_TYPE_MISMATCH'
  }, {
    fileName: 'video-renamed.m4a',
    bytes: validIsoMedia({ audio: true, video: true, majorBrand: 'M4A ' }),
    code: 'MEDIA_TYPE_MISMATCH'
  }, {
    fileName: 'audio-renamed.mp4',
    bytes: validIsoMedia({ audio: true }),
    code: 'MEDIA_TYPE_MISMATCH'
  }, {
    fileName: 'no-media-data.m4a',
    bytes: Buffer.concat([
      isoBox('ftyp', Buffer.concat([
        Buffer.from('M4A ', 'latin1'),
        Buffer.alloc(4),
        Buffer.from('isom', 'latin1')
      ])),
      isoBox('moov', Buffer.alloc(0))
    ]),
    code: 'CORRUPT_MEDIA'
  }];

  for (const fixture of fixtures) {
    const sourcePath = path.join(selectedRoot, fixture.fileName);
    await fs.writeFile(sourcePath, fixture.bytes);
    await assert.rejects(
      store.importFile({ sourcePath }),
      expectStoreCode(fixture.code, [sourcePath, selectedRoot, rootPath])
    );
  }
  assert.deepEqual(await fs.readdir(path.join(rootPath, '.staging')), []);
});

test('unsupported, empty, oversized, symlink, and non-regular selections are rejected', async t => {
  const rootPath = await tempDirectory(t);
  const selectedRoot = await tempDirectory(t, 'syncshow-unsafe-recordings-');
  const validPath = path.join(selectedRoot, 'sermon.mp3');
  const bytes = validMp3();
  await fs.writeFile(validPath, bytes);
  const store = new LocalSermonMediaStore({
    rootPath,
    maximumBytes: bytes.length - 1
  });

  await assert.rejects(
    store.importFile({ sourcePath: 'relative.mp3' }),
    expectStoreCode('INVALID_MEDIA_PATH')
  );
  const unsupportedPath = path.join(selectedRoot, 'sermon.wav');
  await fs.writeFile(unsupportedPath, bytes);
  await assert.rejects(
    store.importFile({ sourcePath: unsupportedPath }),
    expectStoreCode('UNSUPPORTED_MEDIA_TYPE')
  );
  const emptyPath = path.join(selectedRoot, 'empty.mp3');
  await fs.writeFile(emptyPath, Buffer.alloc(0));
  await assert.rejects(
    store.importFile({ sourcePath: emptyPath }),
    expectStoreCode('EMPTY_MEDIA')
  );
  await assert.rejects(
    store.importFile({ sourcePath: validPath }),
    expectStoreCode('MEDIA_TOO_LARGE')
  );
  const directoryPath = path.join(selectedRoot, 'directory.mp3');
  await fs.mkdir(directoryPath);
  await assert.rejects(
    store.importFile({ sourcePath: directoryPath }),
    expectStoreCode('UNSAFE_MEDIA')
  );
  if (process.platform !== 'win32') {
    const linkPath = path.join(selectedRoot, 'linked.mp3');
    await fs.symlink(validPath, linkPath);
    await assert.rejects(
      store.importFile({ sourcePath: linkPath }),
      expectStoreCode('UNSAFE_MEDIA', [validPath, linkPath, selectedRoot])
    );
  }
});

test('a source changed during import is rejected and its partial staging file is removed', async t => {
  const rootPath = await tempDirectory(t);
  const selectedRoot = await tempDirectory(t, 'syncshow-changing-recording-');
  const sourcePath = path.join(selectedRoot, 'changing.mp3');
  await fs.writeFile(sourcePath, validMp3(3000));
  const store = new LocalSermonMediaStore({ rootPath });
  await store.initialize();

  const originalOpen = fs.open;
  let sourceReadCount = 0;
  let changed = false;
  fs.open = async (...args) => {
    const handle = await originalOpen(...args);
    if (args[0] !== sourcePath) return handle;
    const originalRead = handle.read.bind(handle);
    handle.read = async (...readArgs) => {
      const result = await originalRead(...readArgs);
      sourceReadCount += 1;
      if (!changed && sourceReadCount === 3) {
        changed = true;
        const writer = await originalOpen(sourcePath, 'a');
        try {
          await writer.write(Buffer.from([0x00]));
          await writer.sync();
        } finally {
          await writer.close();
        }
      }
      return result;
    };
    return handle;
  };
  try {
    await assert.rejects(
      store.importFile({ sourcePath }),
      expectStoreCode('UNSAFE_MEDIA', [sourcePath, selectedRoot, rootPath])
    );
  } finally {
    fs.open = originalOpen;
  }
  assert.equal(changed, true);
  assert.deepEqual(await fs.readdir(path.join(rootPath, '.staging')), []);
  assert.deepEqual(await fs.readdir(path.join(rootPath, 'objects')), []);
});

test('tampered or over-permissive stored objects fail integrity checks and are never overwritten', async t => {
  const rootPath = await tempDirectory(t);
  const selectedRoot = await tempDirectory(t, 'syncshow-tampered-recording-');
  const sourcePath = path.join(selectedRoot, 'sermon.mp3');
  const bytes = validMp3();
  await fs.writeFile(sourcePath, bytes);
  const store = new LocalSermonMediaStore({ rootPath });
  const imported = await store.importFile({ sourcePath });
  const storedPath = objectPath(rootPath, imported.media.sha256);

  const tampered = Buffer.from(bytes);
  tampered[tampered.length - 1] ^= 0x01;
  await fs.writeFile(storedPath, tampered, { mode: 0o600 });
  if (process.platform !== 'win32') await fs.chmod(storedPath, 0o600);
  await assert.rejects(
    store.checkObject(imported.objectId, { sizeBytes: bytes.length }),
    expectStoreCode('OBJECT_CORRUPT')
  );
  await assert.rejects(
    store.importFile({ sourcePath }),
    expectStoreCode('OBJECT_CORRUPT')
  );
  assert.deepEqual(await fs.readFile(storedPath), tampered);

  await fs.writeFile(storedPath, bytes, { mode: 0o600 });
  if (process.platform !== 'win32') {
    await fs.chmod(storedPath, 0o644);
    await assert.rejects(
      store.checkObject(imported.objectId),
      expectStoreCode('OBJECT_CORRUPT')
    );
  }
});

test('exact restore recreates a missing device object without changing canonical media metadata', async t => {
  const rootPath = await tempDirectory(t);
  const selectedRoot = await tempDirectory(t, 'syncshow-restore-missing-');
  const sourcePath = path.join(selectedRoot, 'Sunday sermon.mp3');
  const bytes = validMp3(4, { id3: true });
  await fs.writeFile(sourcePath, bytes);
  const store = new LocalSermonMediaStore({ rootPath });
  const imported = await store.importFile({ sourcePath });
  const renamedPath = path.join(selectedRoot, 'Sunday sermon (1).mp3');
  await fs.rename(sourcePath, renamedPath);
  await fs.unlink(objectPath(rootPath, imported.media.sha256));

  const restored = await store.restoreFile({
    sourcePath: renamedPath,
    expectedMedia: imported.media
  });
  assert.deepEqual(restored, imported);
  assert.equal(restored.media.fileName, 'Sunday sermon.mp3');
  assert.deepEqual(
    await readAll(store.readObject(restored.objectId, {
      sizeBytes: restored.media.sizeBytes,
      mediaType: restored.media.mediaType
    })),
    bytes
  );
  assert.deepEqual(await fs.readdir(path.join(rootPath, '.staging')), []);
  assert.deepEqual(
    await fs.readdir(path.dirname(objectPath(rootPath, imported.media.sha256))),
    [imported.media.sha256]
  );
});

test('exact restore repairs a corrupt object while ordinary import continues to fail closed', async t => {
  const rootPath = await tempDirectory(t);
  const selectedRoot = await tempDirectory(t, 'syncshow-restore-corrupt-');
  const sourcePath = path.join(selectedRoot, 'Sunday sermon.m4a');
  const bytes = validIsoMedia({ audio: true, majorBrand: 'M4A ' });
  await fs.writeFile(sourcePath, bytes);
  const store = new LocalSermonMediaStore({ rootPath });
  const imported = await store.importFile({ sourcePath });
  const storedPath = objectPath(rootPath, imported.media.sha256);
  const corrupt = Buffer.from(bytes);
  corrupt[corrupt.length - 1] ^= 0x01;
  await fs.writeFile(storedPath, corrupt, { mode: 0o600 });
  if (process.platform !== 'win32') await fs.chmod(storedPath, 0o600);

  await assert.rejects(
    store.importFile({ sourcePath }),
    expectStoreCode('OBJECT_CORRUPT')
  );
  assert.deepEqual(await fs.readFile(storedPath), corrupt);

  const restored = await store.restoreFile({
    sourcePath,
    expectedMedia: imported.media
  });
  assert.deepEqual(restored, imported);
  assert.deepEqual(await fs.readFile(storedPath), bytes);
  assert.deepEqual(
    await fs.readdir(path.dirname(storedPath)),
    [imported.media.sha256]
  );
  assert.deepEqual(await fs.readdir(path.join(rootPath, '.staging')), []);
});

test('restore requires exact canonical type and bytes while allowing a renamed backup', async t => {
  const rootPath = await tempDirectory(t);
  const selectedRoot = await tempDirectory(t, 'syncshow-restore-mismatch-');
  const sourcePath = path.join(selectedRoot, 'Sunday sermon.mp3');
  const bytes = validMp3();
  await fs.writeFile(sourcePath, bytes);
  const store = new LocalSermonMediaStore({ rootPath });
  const imported = await store.importFile({ sourcePath });
  const mutations = [
    { ...imported.media, kind: 'video' },
    { ...imported.media, mediaType: 'video/mp4' },
    { ...imported.media, sha256: 'a'.repeat(64) },
    { ...imported.media, sizeBytes: imported.media.sizeBytes + 1 },
    { ...imported.media, durationSeconds: 1 },
    { ...imported.media, localPath: sourcePath }
  ];
  for (const expectedMedia of mutations) {
    await assert.rejects(
      store.restoreFile({ sourcePath, expectedMedia }),
      expectStoreCode('MEDIA_RESTORE_MISMATCH', [sourcePath, selectedRoot, rootPath])
    );
  }

  const wrongTypePath = path.join(selectedRoot, 'Sunday sermon (1).mp4');
  await fs.writeFile(wrongTypePath, bytes);
  await assert.rejects(
    store.restoreFile({
      sourcePath: wrongTypePath,
      expectedMedia: imported.media
    }),
    expectStoreCode('MEDIA_RESTORE_MISMATCH', [
      wrongTypePath,
      selectedRoot,
      rootPath
    ])
  );

  const differentRoot = await tempDirectory(t, 'syncshow-restore-different-bytes-');
  const differentPath = path.join(differentRoot, imported.media.fileName);
  const differentBytes = Buffer.from(bytes);
  differentBytes[differentBytes.length - 1] ^= 0x01;
  await fs.writeFile(differentPath, differentBytes);
  await assert.rejects(
    store.restoreFile({
      sourcePath: differentPath,
      expectedMedia: imported.media
    }),
    expectStoreCode('MEDIA_RESTORE_MISMATCH', [
      differentPath,
      differentRoot,
      rootPath
    ])
  );
  assert.deepEqual(await fs.readdir(path.join(rootPath, '.staging')), []);
});

test('failed corrupt-object repair rolls the prior object back and cleans staging and quarantine', async t => {
  const rootPath = await tempDirectory(t);
  const selectedRoot = await tempDirectory(t, 'syncshow-restore-rollback-');
  const sourcePath = path.join(selectedRoot, 'Sunday sermon.mp4');
  const bytes = validIsoMedia({ audio: true, video: true });
  await fs.writeFile(sourcePath, bytes);
  const store = new LocalSermonMediaStore({ rootPath });
  const imported = await store.importFile({ sourcePath });
  const storedPath = objectPath(rootPath, imported.media.sha256);
  const corrupt = Buffer.from(bytes);
  corrupt[corrupt.length - 1] ^= 0x01;
  await fs.writeFile(storedPath, corrupt, { mode: 0o600 });
  if (process.platform !== 'win32') await fs.chmod(storedPath, 0o600);

  const originalLink = fs.link;
  fs.link = async () => {
    const error = new Error('injected object-install failure');
    error.code = 'EIO';
    throw error;
  };
  try {
    await assert.rejects(
      store.restoreFile({
        sourcePath,
        expectedMedia: imported.media
      }),
      expectStoreCode('STORE_UNAVAILABLE', [
        sourcePath,
        selectedRoot,
        rootPath,
        'injected object-install failure'
      ])
    );
  } finally {
    fs.link = originalLink;
  }
  assert.deepEqual(await fs.readFile(storedPath), corrupt);
  assert.deepEqual(await fs.readdir(path.dirname(storedPath)), [
    imported.media.sha256
  ]);
  assert.deepEqual(await fs.readdir(path.join(rootPath, '.staging')), []);
});

test('stored prefix symlinks and inconsistent media metadata are rejected without path disclosure', async t => {
  const rootPath = await tempDirectory(t);
  const selectedRoot = await tempDirectory(t, 'syncshow-linked-media-prefix-');
  const sourcePath = path.join(selectedRoot, 'sermon.m4a');
  await fs.writeFile(sourcePath, validIsoMedia({ audio: true, majorBrand: 'M4A ' }));
  const store = new LocalSermonMediaStore({ rootPath });
  const imported = await store.importFile({ sourcePath });

  await assert.rejects(
    store.checkMedia({
      ...imported.media,
      fileName: '/private/sermon.m4a'
    }),
    expectStoreCode('INVALID_MEDIA_METADATA', ['/private/sermon.m4a'])
  );
  await assert.rejects(
    store.checkMedia({
      ...imported.media,
      mediaType: 'video/mp4'
    }),
    expectStoreCode('INVALID_MEDIA_METADATA')
  );
  await assert.rejects(
    store.checkObject('sha256:not-a-digest'),
    expectStoreCode('INVALID_OBJECT_ID')
  );

  if (process.platform !== 'win32') {
    const prefixPath = path.join(rootPath, 'objects', imported.media.sha256.slice(0, 2));
    const displacedPath = path.join(selectedRoot, 'displaced-prefix');
    await fs.rename(prefixPath, displacedPath);
    await fs.symlink(displacedPath, prefixPath, 'dir');
    await assert.rejects(
      store.checkObject(imported.objectId),
      expectStoreCode('OBJECT_CORRUPT', [
        prefixPath,
        displacedPath,
        selectedRoot,
        rootPath
      ])
    );
  }
});

test('initialization failures are typed and do not disclose local storage paths', async t => {
  const parent = await tempDirectory(t);
  const rootPath = path.join(parent, 'occupied');
  await fs.writeFile(rootPath, 'not a directory');
  await assert.rejects(
    new LocalSermonMediaStore({ rootPath }).initialize(),
    expectStoreCode('STORE_UNAVAILABLE', [rootPath, parent])
  );
});
