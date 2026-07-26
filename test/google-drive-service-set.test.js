'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');

const {
  GOOGLE_SLIDES_MIME_TYPE,
  PPT_MIME_TYPE,
  PPTX_MIME_TYPE,
  ServiceSetError,
  checkSourceChanges,
  pinRemoteServiceSet,
  readCurrentServiceSet,
  scanDriveServiceFiles,
  validatePinnedManifest,
  verifyPinnedServiceSet
} = require('../src/services/service-set');

const roles = [
  {
    id: 'russian',
    label: 'Russian',
    filenameMatchers: ['russian', 'rus', 'рус'],
    datePolicy: 'service-date'
  },
  {
    id: 'english',
    label: 'English',
    filenameMatchers: ['english', 'eng'],
    datePolicy: 'service-date'
  },
  {
    id: 'media',
    label: 'Singers Screen',
    filenameMatchers: ['media', 'singer'],
    datePolicy: 'warn-if-stale'
  }
];

async function tempDirectory(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'syncshow-drive-service-set-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return directory;
}

function driveFile({
  id,
  name,
  mimeType = PPTX_MIME_TYPE,
  bytes = Buffer.from('pptx'),
  modifiedTime = '2026-07-23T10:00:00.000Z',
  relativePath,
  version = '7',
  resourceKey = null,
  canDownload = true,
  checksum = true,
  extra = {}
}) {
  return {
    id,
    name,
    mimeType,
    modifiedTime,
    relativePath: relativePath || name,
    version,
    resourceKey,
    capabilities: { canDownload },
    ...(mimeType === GOOGLE_SLIDES_MIME_TYPE ? {} : { size: String(bytes.length) }),
    ...(checksum && mimeType !== GOOGLE_SLIDES_MIME_TYPE
      ? { sha256Checksum: crypto.createHash('sha256').update(bytes).digest('hex') }
      : {}),
    ...extra
  };
}

function scan(files, options = {}) {
  return scanDriveServiceFiles({
    sourceType: options.sourceType || 'google-drive-private',
    folderId: 'folder_1234567890',
    folderResourceKey: options.folderResourceKey || null,
    files,
    inputRoles: options.inputRoles || roles,
    requiredRoleIds: options.requiredRoleIds || ['russian', 'english', 'media'],
    requestedDate: options.requestedDate || '2026-07-27',
    scannedAt: '2026-07-23T12:00:00.000Z'
  });
}

test('Drive metadata uses the existing coherent role/date resolver for PPT, PPTX, and Google Slides', () => {
  const privateMarker = 'must-not-survive-sanitization';
  const result = scan([
    driveFile({
      id: 'russian_file_123',
      name: 'Russian.pptx',
      relativePath: '2026-07-27/Russian.pptx',
      resourceKey: 'resource_key_123',
      extra: { accessToken: privateMarker, arbitraryProviderField: privateMarker }
    }),
    driveFile({
      id: 'english_file_123',
      name: '07-27-2026 English',
      mimeType: GOOGLE_SLIDES_MIME_TYPE,
      bytes: Buffer.from('exported-pptx')
    }),
    driveFile({
      id: 'media_file_123',
      name: '07-27-2026 Media.ppt',
      mimeType: PPT_MIME_TYPE,
      bytes: Buffer.from('legacy-ppt')
    }),
    driveFile({
      id: 'temporary_file_123',
      name: '~$07-27-2026 English.pptx'
    }),
    driveFile({
      id: 'unsupported_file_123',
      name: '07-27-2026 notes.pdf',
      mimeType: 'application/pdf'
    })
  ]);

  assert.equal(result.source.type, 'google-drive-private');
  assert.equal(result.recommendedSetId, '2026-07-27');
  assert.equal(result.sets[0].complete, true);
  assert.equal(result.sets[0].inputs.russian.serviceDateSource, 'folder-name');
  assert.equal(result.sets[0].inputs.english.extension, '.pptx');
  assert.equal(result.sets[0].inputs.english.nativeGoogleSlides, true);
  assert.equal(result.sets[0].inputs.english.exportMimeType, PPTX_MIME_TYPE);
  assert.equal(result.sets[0].inputs.media.extension, '.ppt');
  assert.deepEqual(result.ignoredFiles.map(entry => entry.reason), ['temporary', 'unsupported-type']);
  assert.equal(JSON.stringify(result).includes(privateMarker), false);
});

test('Drive candidates remain distinct when one folder contains duplicate display names', () => {
  const result = scan([
    driveFile({
      id: 'english_duplicate_1',
      name: '07-27-2026 English.pptx',
      bytes: Buffer.from('one')
    }),
    driveFile({
      id: 'english_duplicate_2',
      name: '07-27-2026 English.pptx',
      bytes: Buffer.from('two'),
      modifiedTime: '2026-07-23T11:00:00.000Z'
    })
  ], {
    inputRoles: [roles[1]],
    requiredRoleIds: ['english']
  });

  assert.equal(result.files.length, 2);
  assert.notEqual(result.files[0].relativePath, result.files[1].relativePath);
  assert.equal(result.sets[0].inputs.english.fileId, 'english_duplicate_2');
  assert.equal(result.sets[0].alternates.english.length, 1);
});

test('remote pinning materializes into a hashed offline snapshot without credential metadata', async t => {
  const store = await tempDirectory(t);
  const bytes = Buffer.from('downloaded private pptx bytes');
  const result = scan([
    driveFile({
      id: 'english_private_file',
      name: '07-27-2026 English.pptx',
      bytes,
      resourceKey: 'private_resource_key'
    })
  ], {
    inputRoles: [roles[1]],
    requiredRoleIds: ['english']
  });
  const phases = [];

  const pinned = await pinRemoteServiceSet({
    scan: result,
    setId: '2026-07-27',
    destinationRoot: store,
    profileId: 'main',
    profileName: 'Main Sanctuary',
    timeZone: 'America/Los_Angeles',
    maxFileBytes: 1024,
    maxTotalBytes: 2048,
    checkCandidateUnchanged: async (candidate, { phase }) => {
      phases.push(`${candidate.fileId}:${phase}`);
      return true;
    },
    materialize: async ({ candidate, destinationPath, maximumBytes }) => {
      assert.equal(candidate.fileId, 'english_private_file');
      assert.equal(maximumBytes, 1024);
      await fs.writeFile(destinationPath, bytes, { flag: 'wx', mode: 0o600 });
    }
  });

  assert.equal(pinned.source.type, 'google-drive-private');
  assert.equal(pinned.source.locator, null);
  assert.equal(pinned.inputs.english.sourcePath, null);
  assert.equal(pinned.inputs.english.remote.fileId, 'english_private_file');
  assert.equal(pinned.inputs.english.remote.resourceKey, 'private_resource_key');
  assert.equal(
    pinned.inputs.english.sha256,
    crypto.createHash('sha256').update(bytes).digest('hex')
  );
  assert.deepEqual(phases, [
    'english_private_file:before',
    'english_private_file:after'
  ]);
  assert.deepEqual(await fs.readFile(pinned.inputs.english.pinnedPath), bytes);
  assert.equal((await readCurrentServiceSet(store, { verifyAssets: true })).id, pinned.id);
  assert.equal((await verifyPinnedServiceSet(pinned, store)).id, pinned.id);
  assert.deepEqual(await checkSourceChanges(pinned), []);
  assert.equal(JSON.stringify(pinned).includes('Bearer '), false);
});

test('Google Slides exports may differ from Drive metadata size but still obey local byte limits', async t => {
  const store = await tempDirectory(t);
  const exported = Buffer.from('native Google Slides exported to pptx');
  const result = scan([
    driveFile({
      id: 'native_slides_file',
      name: '07-27-2026 English',
      mimeType: GOOGLE_SLIDES_MIME_TYPE,
      bytes: exported
    })
  ], {
    sourceType: 'google-drive-public',
    inputRoles: [roles[1]],
    requiredRoleIds: ['english']
  });

  const pinned = await pinRemoteServiceSet({
    scan: result,
    setId: '2026-07-27',
    destinationRoot: store,
    profileId: 'main',
    profileName: 'Main',
    timeZone: null,
    maxFileBytes: 100,
    maxTotalBytes: 100,
    materialize: async ({ destinationPath }) => {
      await fs.writeFile(destinationPath, exported, { flag: 'wx' });
    }
  });

  assert.equal(path.extname(pinned.inputs.english.pinnedPath), '.pptx');
  assert.equal(pinned.inputs.english.remote.sourceSize, null);
  assert.equal(pinned.inputs.english.remote.exportMimeType, PPTX_MIME_TYPE);
  assert.equal(pinned.inputs.english.size, exported.length);
});

test('failed remote materialization leaves the previous current snapshot untouched', async t => {
  const store = await tempDirectory(t);
  const original = Buffer.from('original');
  const baselineScan = scan([
    driveFile({
      id: 'baseline_english_file',
      name: '07-27-2026 English.pptx',
      bytes: original
    })
  ], {
    inputRoles: [roles[1]],
    requiredRoleIds: ['english']
  });
  const baseline = await pinRemoteServiceSet({
    scan: baselineScan,
    setId: '2026-07-27',
    destinationRoot: store,
    profileId: 'main',
    profileName: 'Main',
    timeZone: null,
    maxFileBytes: 100,
    maxTotalBytes: 200,
    materialize: async ({ destinationPath }) => {
      await fs.writeFile(destinationPath, original, { flag: 'wx' });
    }
  });

  const nextScan = scan([
    driveFile({
      id: 'next_english_file',
      name: '07-27-2026 English.pptx',
      bytes: Buffer.from('next english')
    }),
    driveFile({
      id: 'next_russian_file',
      name: '07-27-2026 Russian.pptx',
      bytes: Buffer.from('next russian')
    })
  ], {
    inputRoles: [roles[1], roles[0]],
    requiredRoleIds: ['english', 'russian']
  });

  await assert.rejects(
    pinRemoteServiceSet({
      scan: nextScan,
      setId: '2026-07-27',
      destinationRoot: store,
      profileId: 'main',
      profileName: 'Main',
      timeZone: null,
      maxFileBytes: 100,
      maxTotalBytes: 200,
      materialize: async ({ candidate, destinationPath }) => {
        if (candidate.fileId === 'next_russian_file') throw new Error('network interrupted');
        await fs.writeFile(destinationPath, Buffer.from('next english'), { flag: 'wx' });
      }
    }),
    error => error instanceof ServiceSetError && error.code === 'REMOTE_MATERIALIZE_FAILED'
  );

  assert.equal((await readCurrentServiceSet(store, { verifyAssets: true })).id, baseline.id);
  assert.equal((await fs.readdir(store)).some(name => name.startsWith('.staging-')), false);
});

test('remote byte limits, empty downloads, and metadata races fail closed', async t => {
  const oversizedStore = await tempDirectory(t);
  const oversizedBytes = Buffer.from('12345');
  const oversizedScan = scan([
    driveFile({
      id: 'oversized_english_file',
      name: '07-27-2026 English.pptx',
      bytes: oversizedBytes
    })
  ], {
    inputRoles: [roles[1]],
    requiredRoleIds: ['english']
  });
  await assert.rejects(
    pinRemoteServiceSet({
      scan: oversizedScan,
      setId: '2026-07-27',
      destinationRoot: oversizedStore,
      profileId: 'main',
      profileName: 'Main',
      timeZone: null,
      maxFileBytes: 4,
      maxTotalBytes: 4,
      materialize: async ({ destinationPath }) => {
        await fs.writeFile(destinationPath, oversizedBytes, { flag: 'wx' });
      }
    }),
    error => error instanceof ServiceSetError && error.code === 'REMOTE_FILE_TOO_LARGE'
  );
  assert.deepEqual(await fs.readdir(oversizedStore), []);

  const emptyStore = await tempDirectory(t);
  await assert.rejects(
    pinRemoteServiceSet({
      scan: oversizedScan,
      setId: '2026-07-27',
      destinationRoot: emptyStore,
      profileId: 'main',
      profileName: 'Main',
      timeZone: null,
      maxFileBytes: 10,
      maxTotalBytes: 10,
      materialize: async ({ destinationPath }) => {
        await fs.writeFile(destinationPath, Buffer.alloc(0), { flag: 'wx' });
      }
    }),
    error => error instanceof ServiceSetError && error.code === 'REMOTE_MATERIALIZE_INVALID'
  );

  const changedStore = await tempDirectory(t);
  await assert.rejects(
    pinRemoteServiceSet({
      scan: oversizedScan,
      setId: '2026-07-27',
      destinationRoot: changedStore,
      profileId: 'main',
      profileName: 'Main',
      timeZone: null,
      maxFileBytes: 10,
      maxTotalBytes: 10,
      checkCandidateUnchanged: async (_candidate, { phase }) => phase !== 'after',
      materialize: async ({ destinationPath }) => {
        await fs.writeFile(destinationPath, oversizedBytes, { flag: 'wx' });
      }
    }),
    error => error instanceof ServiceSetError && error.code === 'SOURCE_CHANGED'
  );
  assert.deepEqual(await fs.readdir(changedStore), []);
});

test('remote pinning rejects same-size checksum corruption and aggregate overrun', async t => {
  const corruptStore = await tempDirectory(t);
  const expected = Buffer.from('correct1');
  const tampered = Buffer.from('tamperd1');
  const corruptScan = scan([
    driveFile({
      id: 'checksum_remote_file',
      name: '07-27-2026 English.pptx',
      bytes: expected
    })
  ], {
    inputRoles: [roles[1]],
    requiredRoleIds: ['english']
  });
  await assert.rejects(
    pinRemoteServiceSet({
      scan: corruptScan,
      setId: '2026-07-27',
      destinationRoot: corruptStore,
      profileId: 'main',
      profileName: 'Main',
      timeZone: null,
      maxFileBytes: 10,
      maxTotalBytes: 10,
      materialize: async ({ destinationPath }) => {
        await fs.writeFile(destinationPath, tampered, { flag: 'wx' });
      }
    }),
    error => error instanceof ServiceSetError && error.code === 'REMOTE_CHECKSUM_MISMATCH'
  );
  assert.deepEqual(await fs.readdir(corruptStore), []);

  const aggregateStore = await tempDirectory(t);
  const fourBytes = Buffer.from('1234');
  const aggregateScan = scan([
    driveFile({
      id: 'aggregate_english_file',
      name: '07-27-2026 English.pptx',
      bytes: fourBytes
    }),
    driveFile({
      id: 'aggregate_russian_file',
      name: '07-27-2026 Russian.pptx',
      bytes: fourBytes
    })
  ], {
    inputRoles: [roles[1], roles[0]],
    requiredRoleIds: ['english', 'russian']
  });
  await assert.rejects(
    pinRemoteServiceSet({
      scan: aggregateScan,
      setId: '2026-07-27',
      destinationRoot: aggregateStore,
      profileId: 'main',
      profileName: 'Main',
      timeZone: null,
      maxFileBytes: 4,
      maxTotalBytes: 6,
      materialize: async ({ destinationPath }) => {
        await fs.writeFile(destinationPath, fourBytes, { flag: 'wx' });
      }
    }),
    error => error instanceof ServiceSetError && error.code === 'REMOTE_FILE_TOO_LARGE'
  );
  assert.deepEqual(await fs.readdir(aggregateStore), []);
});

test('remote manifest validation permits nullable source paths but rejects credential fields', async t => {
  const store = await tempDirectory(t);
  const bytes = Buffer.from('validated');
  const result = scan([
    driveFile({
      id: 'validated_remote_file',
      name: '07-27-2026 English.pptx',
      bytes
    })
  ], {
    inputRoles: [roles[1]],
    requiredRoleIds: ['english']
  });
  const pinned = await pinRemoteServiceSet({
    scan: result,
    setId: '2026-07-27',
    destinationRoot: store,
    profileId: 'main',
    profileName: 'Main',
    timeZone: null,
    maxFileBytes: 100,
    maxTotalBytes: 100,
    materialize: async ({ destinationPath }) => {
      await fs.writeFile(destinationPath, bytes, { flag: 'wx' });
    }
  });
  assert.equal(validatePinnedManifest(pinned, store), pinned);

  const leaked = structuredClone(pinned);
  leaked.inputs.english.remote.refreshToken = 'should-never-be-here';
  assert.throws(
    () => validatePinnedManifest(leaked, store),
    error => error instanceof ServiceSetError && error.code === 'INVALID_PINNED_SET'
  );

  const localPathClaim = structuredClone(pinned);
  localPathClaim.inputs.english.sourcePath = '/tmp/not-a-drive-source.pptx';
  assert.throws(
    () => validatePinnedManifest(localPathClaim, store),
    error => error instanceof ServiceSetError && error.code === 'INVALID_PINNED_SET'
  );
});
