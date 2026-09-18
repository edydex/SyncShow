'use strict';

const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createServiceProject,
  serializeServiceProject
} = require('../src/services/project/ServiceProject');
const {
  ServiceProjectStore
} = require('../src/services/project/ServiceProjectStore');

test('installs an exact shared project snapshot without manufacturing a local edit', async t => {
  const temporaryRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), 'syncshow-shared-snapshot-')
  );
  const rootPath = await fs.realpath(temporaryRoot);
  t.after(() => fs.rm(rootPath, { recursive: true, force: true }));
  const store = new ServiceProjectStore({
    rootPath,
    clock: () => new Date('2026-08-13T20:00:00.000Z')
  });
  const draft = createServiceProject({
    id: 'service-2026-08-16',
    title: 'Sunday Service',
    serviceDate: '2026-08-16',
    profileId: 'main-sanctuary',
    now: '2026-08-13T19:00:00.000Z',
    channels: [
      { id: 'english', label: 'English', language: 'en' },
      { id: 'russian', label: 'Russian', language: 'ru' },
      { id: 'media', label: 'Media', language: 'und' }
    ]
  });
  const shared = JSON.parse(serializeServiceProject(draft));
  shared.revision = 9;
  shared.updatedAt = '2026-08-13T19:30:00.000Z';

  const installed = await store.installSharedSnapshot(shared, {
    expectedRevisionId: null
  });

  assert.equal(installed.project.revision, 9);
  assert.equal(installed.project.updatedAt, '2026-08-13T19:30:00.000Z');
  assert.equal(
    serializeServiceProject(installed.project),
    serializeServiceProject(shared)
  );
});

test('rejects a Community draft that was never assigned a saved project revision', async t => {
  const temporaryRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), 'syncshow-shared-snapshot-')
  );
  const rootPath = await fs.realpath(temporaryRoot);
  t.after(() => fs.rm(rootPath, { recursive: true, force: true }));
  const store = new ServiceProjectStore({ rootPath });
  const draft = createServiceProject({
    id: 'service-2026-08-16',
    title: 'Sunday Service',
    serviceDate: '2026-08-16',
    profileId: 'main-sanctuary',
    now: '2026-08-13T19:00:00.000Z',
    channels: [{ id: 'english', label: 'English', language: 'en' }]
  });

  await assert.rejects(
    store.installSharedSnapshot(draft, { expectedRevisionId: null }),
    error => error?.code === 'INVALID_SHARED_SNAPSHOT'
  );
});
