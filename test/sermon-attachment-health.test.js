'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const {
  LocalSermonLibrary,
  LocalSermonSourceStore,
  SERMON_SCHEMA_VERSION,
  SermonAttachmentHealthCoordinator,
  inspectSermonAttachmentHealth
} = require('../src/services/sermon');

async function tempDirectory(t, prefix) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return fs.realpath(directory);
}

function sermonDocument(source) {
  return {
    schemaVersion: SERMON_SCHEMA_VERSION,
    kind: 'syncshow-sermon',
    id: 'sermon-attachment-restart',
    titles: { en: 'Attachment restart check' },
    defaultLanguage: 'en',
    speaker: { id: null, name: 'Pastor Example' },
    serviceDate: '2026-07-27',
    series: null,
    outline: [],
    sources: [source],
    references: [],
    media: [],
    publication: {
      status: 'draft',
      visibility: 'private',
      publishedAt: null,
      canonicalUrl: null
    }
  };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

test('attachment health coordinator shares one in-flight Promise and result per resource', async () => {
  const gate = deferred();
  const result = Object.freeze({ verifiedCount: 1 });
  const calls = [];
  const coordinator = new SermonAttachmentHealthCoordinator({
    async inspectHealth(sermon, sourceStore) {
      calls.push({ sermon, sourceStore });
      await gate.promise;
      return result;
    }
  });
  const sermon = { id: 'shared-sermon' };
  const sourceStore = { id: 'private-store' };

  const first = coordinator.inspect('sha256:shared-resource', sermon, sourceStore);
  const duplicate = coordinator.inspect(
    'sha256:shared-resource',
    { id: 'must-not-replace-first-input' },
    { id: 'must-not-run' }
  );
  assert.equal(duplicate, first);
  await Promise.resolve();
  assert.deepEqual(calls, [{ sermon, sourceStore }]);

  gate.resolve();
  assert.equal(await first, result);
  assert.equal(await duplicate, result);

  const rerun = coordinator.inspect('sha256:shared-resource', sermon, sourceStore);
  assert.notEqual(rerun, first);
  assert.equal(await rerun, result);
  assert.equal(calls.length, 2);
});

test('attachment health coordinator globally serializes distinct resource checks', async () => {
  const firstGate = deferred();
  const order = [];
  const coordinator = new SermonAttachmentHealthCoordinator();
  const first = coordinator.run('resource-a', async () => {
    order.push('a:start');
    await firstGate.promise;
    order.push('a:end');
    return 'a';
  });
  const second = coordinator.run('resource-b', async () => {
    order.push('b:start');
    order.push('b:end');
    return 'b';
  });

  await Promise.resolve();
  assert.deepEqual(order, ['a:start']);
  firstGate.resolve();
  assert.equal(await first, 'a');
  assert.equal(await second, 'b');
  assert.deepEqual(order, ['a:start', 'a:end', 'b:start', 'b:end']);
});

test('attachment health coordinator cleans settled work and continues after rejection', async () => {
  const failure = new Error('expected health failure');
  const order = [];
  const coordinator = new SermonAttachmentHealthCoordinator();
  const first = coordinator.run('resource-a', async () => {
    order.push('a:first');
    throw failure;
  });
  const duplicate = coordinator.run('resource-a', () => {
    assert.fail('duplicate resource operation must not run');
  });
  const queued = coordinator.run('resource-b', async () => {
    order.push('b');
    return 'recovered';
  });

  assert.equal(duplicate, first);
  await assert.rejects(first, error => error === failure);
  assert.equal(await queued, 'recovered');

  const rerun = coordinator.run('resource-a', async () => {
    order.push('a:second');
    return 'fresh';
  });
  assert.notEqual(rerun, first);
  assert.equal(await rerun, 'fresh');
  assert.deepEqual(order, ['a:first', 'b', 'a:second']);
});

test('attachment health checks actual objects after restart and distinguishes missing from corrupt', async t => {
  const objectRoot = await tempDirectory(t, 'syncshow-sermon-health-objects-');
  const libraryRoot = await tempDirectory(t, 'syncshow-sermon-health-library-');
  const inputRoot = await tempDirectory(t, 'syncshow-sermon-health-input-');
  const manuscriptPath = path.join(inputRoot, 'sermon.md');
  await fs.writeFile(manuscriptPath, '# Sermon manuscript\n\nContent preserved for restart.\n');

  const firstStore = new LocalSermonSourceStore({ rootPath: objectRoot });
  const imported = await firstStore.importFile({
    sourcePath: manuscriptPath,
    id: 'manuscript',
    kind: 'manuscript',
    languages: ['en'],
    provenance: {
      providedBy: 'Pastor Example',
      receivedAt: '2026-07-27T12:00:00.000Z',
      sourceSystem: 'manual-file-picker'
    }
  });
  const firstLibrary = new LocalSermonLibrary({ rootPath: libraryRoot });
  await firstLibrary.saveDocument(sermonDocument(imported.source), {
    expectedRevision: null
  });

  const restartedLibrary = new LocalSermonLibrary({ rootPath: libraryRoot });
  const restartedStore = new LocalSermonSourceStore({ rootPath: objectRoot });
  const restarted = await restartedLibrary.readCurrent('sermon-attachment-restart');
  assert.deepEqual(
    await inspectSermonAttachmentHealth(restarted.sermon, restartedStore),
    {
      totalCount: 1,
      checkedCount: 1,
      verifiedCount: 1,
      missingCount: 0,
      corruptCount: 0,
      unverifiedCount: 0
    }
  );

  const emptyTargetStore = new LocalSermonSourceStore({
    rootPath: await tempDirectory(t, 'syncshow-sermon-health-empty-target-')
  });
  assert.deepEqual(
    await inspectSermonAttachmentHealth(restarted.sermon, emptyTargetStore),
    {
      totalCount: 1,
      checkedCount: 1,
      verifiedCount: 0,
      missingCount: 1,
      corruptCount: 0,
      unverifiedCount: 0
    }
  );

  const objectPath = path.join(
    objectRoot,
    'objects',
    imported.source.sha256.slice(0, 2),
    imported.source.sha256
  );
  const bytes = await fs.readFile(objectPath);
  bytes[bytes.length - 2] ^= 0x01;
  await fs.writeFile(objectPath, bytes);
  assert.deepEqual(
    await inspectSermonAttachmentHealth(restarted.sermon, restartedStore),
    {
      totalCount: 1,
      checkedCount: 1,
      verifiedCount: 0,
      missingCount: 0,
      corruptCount: 1,
      unverifiedCount: 0
    }
  );
});
