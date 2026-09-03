'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const JSZip = require('jszip');

const {
  addBibleItem,
  addGroupItem,
  addProjectItem,
  addSermonResource,
  addSongResource,
  attachLocalServicePlanning,
  bindProjectAsPowerPointCompanion,
  compileServiceProject,
  normalizeServiceProject,
  serializeServiceProject
} = require('../src/services/project/ServiceProject');
const { parseSongDocument } = require('../src/services/project/SongDocument');
const {
  MAX_BUNDLE_BYTES,
  ProjectExchangeError,
  ServiceProjectExchange,
  inspectZipStructure,
  serializeManifest
} = require('../src/services/project/ServiceProjectExchange');
const {
  ServiceProjectStore,
  projectStorageKey
} = require('../src/services/project/ServiceProjectStore');
const { LocalSongLibrary } = require('../src/services/project/LocalSongLibrary');
const { LocalSermonLibrary } = require('../src/services/sermon/LocalSermonLibrary');

const NOW = '2026-07-23T18:00:00.000Z';
const IMAGE_METADATA = Object.freeze({
  format: 'png',
  width: 640,
  height: 360,
  pages: 1,
  orientation: 1
});

test('portable service archives use a conservative main-process memory ceiling', () => {
  assert.equal(MAX_BUNDLE_BYTES, 128 * 1024 * 1024);
});

test('a first local Planning service keeps its schedule and item duration through portable export and import', async t => {
  const sourceStore = new ServiceProjectStore({
    rootPath: await tempDirectory(t, 'syncshow-local-plan-export-source-'),
    clock: () => new Date(NOW)
  });
  const created = await sourceStore.create({
    id: 'portable-first-local-plan',
    title: 'First local Planning service',
    serviceDate: '2026-07-26',
    profileId: 'main-sanctuary'
  }, {
    prepareProject(project) {
      const planned = attachLocalServicePlanning(project, {
        startTime: '10:30',
        teamNotes: 'Sound check at 09:45.'
      });
      return addGroupItem(planned, {
        id: 'opening',
        title: 'Opening',
        groupKind: 'section',
        plannedDurationSeconds: 300,
        now: NOW
      });
    }
  });
  const exported = await new ServiceProjectExchange({
    projectStore: sourceStore,
    appVersion: '1.4.0-test'
  }).exportBundle(created.project.id, created.revisionId);

  const targetStore = new ServiceProjectStore({
    rootPath: await tempDirectory(t, 'syncshow-local-plan-import-target-')
  });
  const imported = await new ServiceProjectExchange({
    projectStore: targetStore,
    appVersion: '1.4.0-test'
  }).importBundle(exported.buffer);

  assert.equal(imported.imported, true);
  assert.deepEqual(imported.project.planning, {
    schemaVersion: 4,
    status: 'planning',
    startTime: '10:30',
    origin: 'local-created',
    teamNotes: 'Sound check at 09:45.'
  });
  assert.equal(
    imported.project.items.opening.plannedDurationSeconds,
    300
  );
  assert.equal(
    serializeServiceProject((await targetStore.read(imported.project.id)).project),
    serializeServiceProject(imported.project)
  );
});

async function tempDirectory(t, prefix = 'syncshow-project-exchange-') {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return fs.realpath(directory);
}

test('portable import rejects a handcrafted local PowerPoint companion', async t => {
  const sourceRoot = await tempDirectory(t, 'syncshow-companion-export-source-');
  const sourceStore = new ServiceProjectStore({
    rootPath: sourceRoot,
    clock: () => new Date(NOW)
  });
  const created = await sourceStore.create({
    id: 'crafted-companion',
    title: 'Crafted companion',
    serviceDate: '2026-07-26',
    profileId: 'main-sanctuary'
  });
  const withAnchor = addGroupItem(created.project, {
    id: 'sermon-anchor',
    title: 'Sermon',
    groupKind: 'sermon',
    now: NOW
  });
  const saved = await sourceStore.save(withAnchor, {
    expectedRevisionId: created.revisionId,
    reason: 'add-sermon-anchor'
  });
  const sourceExchange = new ServiceProjectExchange({
    projectStore: sourceStore
  });
  const exported = await sourceExchange.exportBundle(
    saved.project.id,
    saved.revisionId
  );
  const companion = bindProjectAsPowerPointCompanion(saved.project, {
    id: 'set-2026-07-26-main',
    fingerprint: 'a'.repeat(64),
    serviceDate: '2026-07-26',
    profileId: 'main-sanctuary'
  });
  const companionBuffer = Buffer.from(
    serializeServiceProject(companion),
    'utf8'
  );
  const craftedBundle = await rewriteBundle(
    exported.buffer,
    async zip => {
      const manifest = JSON.parse(
        await zip.file('manifest.json').async('string')
      );
      refreshManifestProject(manifest, companionBuffer);
      zip.file(manifest.project.path, companionBuffer, {
        compression: 'STORE',
        createFolders: false
      });
      zip.file('manifest.json', serializeManifest(manifest), {
        compression: 'STORE',
        createFolders: false
      });
    }
  );

  const targetRoot = await tempDirectory(t, 'syncshow-companion-import-target-');
  const targetStore = new ServiceProjectStore({
    rootPath: targetRoot,
    clock: () => new Date(NOW)
  });
  const targetExchange = new ServiceProjectExchange({
    projectStore: targetStore
  });
  await assert.rejects(
    targetExchange.importBundle(craftedBundle),
    expectExchangeCode('COMPANION_PROJECT_NOT_IMPORTABLE')
  );
  await assert.rejects(
    targetStore.read(companion.id),
    error => error.code === 'PROJECT_NOT_FOUND'
  );
});

function expectExchangeCode(code) {
  return error => {
    assert.ok(error instanceof ProjectExchangeError, `expected ProjectExchangeError, got ${error?.constructor?.name}`);
    assert.equal(error.code, code);
    return true;
  };
}

function hash(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, stableValue(value[key])]));
}

function refreshManifestProject(manifest, projectBuffer) {
  const digest = hash(projectBuffer);
  manifest.project.revisionId = digest;
  manifest.project.sha256 = digest;
  manifest.project.size = projectBuffer.length;
  const base = {
    kind: manifest.kind,
    schemaVersion: manifest.schemaVersion,
    createdBy: manifest.createdBy,
    project: manifest.project,
    assets: manifest.assets
  };
  manifest.bundleId = hash(Buffer.from(`${JSON.stringify(stableValue(base))}\n`, 'utf8'));
}

async function generateStoredZip(zip) {
  return zip.generateAsync({
    type: 'nodebuffer',
    compression: 'STORE',
    platform: 'UNIX',
    streamFiles: false
  });
}

async function rewriteBundle(bundle, operation) {
  const zip = await JSZip.loadAsync(bundle, { createFolders: false });
  await operation(zip);
  return generateStoredZip(zip);
}

function songDocument() {
  return parseSongDocument([
    '---',
    'id: portable-grace',
    'title: Portable Grace',
    'language: en',
    'license: Public domain',
    '---',
    '^1',
    'Grace travels with the service'
  ].join('\n'));
}

function sermonDocument(
  title = 'The Prayer That Transforms the Church',
  { body = null } = {}
) {
  const document = {
    schemaVersion: body === null ? 1 : 3,
    kind: 'syncshow-sermon',
    id: 'portable-prayer-sermon',
    titles: { en: title },
    defaultLanguage: 'en',
    speaker: { id: 'paul-lvutin', name: 'Paul Lvutin' },
    serviceDate: '2026-07-26',
    series: null,
    outline: [{
      id: 'foundation',
      parentId: null,
      kind: 'section',
      titles: { en: 'The Foundation of the Prayer' }
    }],
    sources: [],
    references: [{
      id: 'primary-ephesians-3',
      range: {
        schemaVersion: 1,
        bookId: 'Eph',
        start: { chapter: 3, verse: 14 },
        end: { chapter: 3, verse: 21 }
      },
      role: 'primary',
      source: 'operator',
      reviewStatus: 'confirmed',
      enteredText: 'Ephesians 3:14-21',
      sourceId: null,
      sectionId: null,
      startOffset: null,
      endOffset: null
    }],
    media: [],
    publication: {
      status: 'draft',
      visibility: 'private',
      publishedAt: null,
      canonicalUrl: null
    }
  };
  if (body !== null) document.body = body;
  return document;
}

function portableReviewedBody() {
  return [{
    id: 'portable-manuscript-foundation-en',
    kind: 'manuscript',
    language: 'en',
    sourceId: null,
    sectionId: 'foundation',
    text: 'The full reviewed sermon manuscript travels with its exact portable pin.'
  }, {
    id: 'portable-slide-notes-foundation-en',
    kind: 'slide-notes',
    language: 'en',
    sourceId: null,
    sectionId: 'foundation',
    text: 'Reviewed slide notes remain the second ordered body entry.'
  }];
}

function passage() {
  return {
    translation: {
      id: 'BSB',
      suggestedCredit: 'Berean Standard Bible'
    },
    book: 'John',
    chapter: 3,
    verseStart: 16,
    verseEnd: 16,
    reference: 'John 3:16',
    verses: [{ number: 16, text: 'Pinned portable Bible text.' }]
  };
}

async function createPortableFixture(t, options = {}) {
  const rootPath = await tempDirectory(t, 'syncshow-exchange-source-');
  const sourceDirectory = await tempDirectory(t, 'syncshow-exchange-image-');
  const sourcePath = path.join(sourceDirectory, 'portable.png');
  const imageBytes = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.from('portable-service-image')
  ]);
  await fs.writeFile(sourcePath, imageBytes);
  const store = new ServiceProjectStore({
    rootPath,
    clock: () => new Date(NOW),
    imageInspector: async () => IMAGE_METADATA
  });
  const created = await store.create({
    id: options.projectId || 'portable-service',
    title: options.title || 'Portable Sunday Service',
    serviceDate: '2026-07-26',
    profileId: 'main-sanctuary'
  });
  const importedImage = await store.importImage(created.project.id, {
    sourcePath,
    expectedRevisionId: created.revisionId,
    altText: 'A portable fixture image',
    attribution: 'Fixture archive'
  });

  let project = importedImage.project;
  const pinnedSong = addSongResource(project, songDocument(), {
    provider: 'local',
    itemId: 'portable-grace',
    revision: 'source-song-revision'
  });
  project = pinnedSong.project;
  project = addProjectItem(project, {
    id: 'portable-song',
    kind: 'song',
    title: 'Portable Grace',
    variants: {
      primary: { mode: 'content', resourceId: pinnedSong.resourceId },
      secondary: { mode: 'inherit', from: 'primary' },
      media: {
        mode: 'derive',
        from: 'primary',
        transform: { id: 'first-lines', version: 1, maxLines: 2 }
      }
    },
    arrangement: [{ id: 'portable-arrangement', sectionId: 'verse-1' }],
    titlePresetId: 'song-title',
    lyricsPresetId: 'song-lyrics',
    operatorNotes: ''
  }, { now: NOW });
  const pinnedSermon = addSermonResource(project, sermonDocument(
    'The Prayer That Transforms the Church',
    { body: portableReviewedBody() }
  ), {
    provider: 'local-sermon-library',
    itemId: 'portable-prayer-sermon'
  });
  project = pinnedSermon.project;
  project = addGroupItem(project, {
    id: 'portable-sermon-group',
    title: 'Sermon',
    groupKind: 'sermon',
    sermonResourceId: pinnedSermon.resourceId,
    sermonSectionId: 'foundation',
    now: NOW
  });
  project = addBibleItem(project, {
    id: 'portable-bible',
    passagesByChannel: Object.fromEntries(project.channelIds.map(channelId => [channelId, passage()])),
    now: NOW
  });
  project = addProjectItem(project, {
    id: 'portable-picture',
    kind: 'picture',
    title: 'Portable picture',
    assetId: importedImage.asset.id,
    channelIds: [...project.channelIds],
    fit: 'fit',
    focalPoint: { x: 0.5, y: 0.5 },
    altText: importedImage.asset.altText,
    attribution: importedImage.asset.attribution,
    presetId: 'picture-fullscreen',
    operatorNotes: ''
  }, { now: NOW });
  const saved = await store.save(project, {
    expectedRevisionId: importedImage.revisionId,
    reason: 'portable-fixture'
  });
  return { rootPath, sourcePath, imageBytes, store, saved, asset: importedImage.asset };
}

test('a song, pinned Bible passage, and picture round-trip offline through one verified bundle', async t => {
  const fixture = await createPortableFixture(t);
  const exchange = new ServiceProjectExchange({
    projectStore: fixture.store,
    appVersion: '1.4.0-test'
  });
  const exported = await exchange.exportBundle(fixture.saved.project.id, fixture.saved.revisionId);
  assert.match(exported.fileName, /^2026-07-26-portable-sunday-service\.syncshow-service$/);
  assert.equal(exported.assetCount, 1);
  assert.equal(exported.manifest.project.revisionId, fixture.saved.revisionId);
  assert.deepEqual([...inspectZipStructure(exported.buffer).keys()], [
    'manifest.json',
    'project.json',
    `assets/${fixture.asset.storedName}`
  ]);

  await fs.unlink(fixture.sourcePath);
  const importedRoot = await tempDirectory(t, 'syncshow-exchange-target-');
  const targetStore = new ServiceProjectStore({
    rootPath: importedRoot,
    imageInspector: async () => IMAGE_METADATA
  });
  const targetExchange = new ServiceProjectExchange({ projectStore: targetStore, appVersion: '1.4.0-test' });
  const imported = await targetExchange.importBundle(exported.buffer);

  assert.equal(imported.imported, true);
  assert.equal(imported.forked, false);
  assert.equal(imported.project.id, fixture.saved.project.id);
  assert.equal(
    Object.values(imported.project.resources).find(resource => resource.kind === 'song').document.title,
    'Portable Grace'
  );
  assert.equal(imported.project.items['portable-bible'].passagesByChannel.primary.verses[0].text, 'Pinned portable Bible text.');
  assert.equal(compileServiceProject(imported.project).cueIds.length, 4);
  const resolved = await targetStore.resolveAssetPath(imported.project.id, imported.revisionId, fixture.asset.id);
  assert.deepEqual(await fs.readFile(resolved.assetPath), fixture.imageBytes);

  const repeated = await targetExchange.importBundle(exported.buffer);
  assert.equal(repeated.imported, false);
  assert.equal(repeated.unchanged, true);
  assert.equal(repeated.forked, false);
  assert.equal(repeated.revisionId, imported.revisionId);
  assert.equal((await targetStore.list()).total, 1);
});

test('portable import adds pinned songs to the editable library and repeated import is idempotent', async t => {
  const fixture = await createPortableFixture(t);
  const exported = await new ServiceProjectExchange({ projectStore: fixture.store }).exportBundle(
    fixture.saved.project.id,
    fixture.saved.revisionId
  );
  const targetStore = new ServiceProjectStore({
    rootPath: await tempDirectory(t, 'syncshow-exchange-song-project-'),
    imageInspector: async () => IMAGE_METADATA
  });
  const songLibrary = new LocalSongLibrary({
    rootPath: await tempDirectory(t, 'syncshow-exchange-song-library-')
  });
  const exchange = new ServiceProjectExchange({
    projectStore: targetStore,
    songLibrary,
    appVersion: '1.4.0-test'
  });

  const imported = await exchange.importBundle(exported.buffer);
  assert.deepEqual(imported.songLibrary, {
    available: true,
    discovered: 1,
    added: 1,
    unchanged: 0,
    conflicts: 0,
    failed: 0,
    warnings: [],
    omittedWarnings: 0
  });
  const editable = await songLibrary.read('portable-grace');
  assert.equal(editable.song.title, 'Portable Grace');
  assert.equal(editable.song.sections[0].slides[0].lines[0], 'Grace travels with the service');

  const repeated = await exchange.importBundle(exported.buffer);
  assert.equal(repeated.project.id, imported.project.id);
  assert.deepEqual(repeated.songLibrary, {
    available: true,
    discovered: 1,
    added: 0,
    unchanged: 1,
    conflicts: 0,
    failed: 0,
    warnings: [],
    omittedWarnings: 0
  });
  assert.equal((await songLibrary.list()).total, 1);
});

test('portable import hydrates an exact pinned sermon revision and repeated import is a no-op', async t => {
  const fixture = await createPortableFixture(t);
  const portableSermon = Object.values(fixture.saved.project.resources)
    .find(resource => resource.kind === 'sermon');
  const exported = await new ServiceProjectExchange({ projectStore: fixture.store }).exportBundle(
    fixture.saved.project.id,
    fixture.saved.revisionId
  );
  const targetStore = new ServiceProjectStore({
    rootPath: await tempDirectory(t, 'syncshow-exchange-sermon-project-'),
    imageInspector: async () => IMAGE_METADATA
  });
  const sermonLibrary = new LocalSermonLibrary({
    rootPath: await tempDirectory(t, 'syncshow-exchange-sermon-library-'),
    clock: () => new Date('2026-07-27T12:00:00.000Z')
  });
  const exchange = new ServiceProjectExchange({
    projectStore: targetStore,
    sermonLibrary,
    appVersion: '1.4.0-test'
  });

  const imported = await exchange.importBundle(exported.buffer);
  assert.deepEqual(imported.sermonLibrary, {
    available: true,
    discovered: 1,
    added: 1,
    unchanged: 0,
    conflicts: 0,
    failed: 0,
    warnings: [],
    omittedWarnings: 0
  });
  const editable = await sermonLibrary.read('portable-prayer-sermon');
  const importedSermon = Object.values(imported.project.resources)
    .find(resource => resource.kind === 'sermon');
  assert.equal(editable.revision, portableSermon.sha256);
  assert.equal(importedSermon.sha256, portableSermon.sha256);
  assert.equal(editable.sermon.titles.en, 'The Prayer That Transforms the Church');
  assert.equal(editable.sermon.outline[0].id, 'foundation');
  assert.deepEqual(editable.sermon.body, portableReviewedBody());
  assert.deepEqual(importedSermon.document.body, portableReviewedBody());
  assert.deepEqual(portableSermon.document.body, portableReviewedBody());
  const firstUpdatedAt = editable.updatedAt;

  const repeated = await exchange.importBundle(exported.buffer);
  assert.equal(repeated.project.id, imported.project.id);
  assert.deepEqual(repeated.sermonLibrary, {
    available: true,
    discovered: 1,
    added: 0,
    unchanged: 1,
    conflicts: 0,
    failed: 0,
    warnings: [],
    omittedWarnings: 0
  });
  const afterRepeat = await sermonLibrary.read('portable-prayer-sermon');
  assert.equal(afterRepeat.revision, portableSermon.sha256);
  assert.equal(afterRepeat.updatedAt, firstUpdatedAt);
  assert.equal((await sermonLibrary.list()).total, 1);
});

test('portable sermon conflicts preserve the local current revision and imported exact pin', async t => {
  const fixture = await createPortableFixture(t);
  const portableSermon = Object.values(fixture.saved.project.resources)
    .find(resource => resource.kind === 'sermon');
  const exported = await new ServiceProjectExchange({ projectStore: fixture.store }).exportBundle(
    fixture.saved.project.id,
    fixture.saved.revisionId
  );
  const targetStore = new ServiceProjectStore({
    rootPath: await tempDirectory(t, 'syncshow-exchange-sermon-conflict-project-'),
    imageInspector: async () => IMAGE_METADATA
  });
  const sermonLibrary = new LocalSermonLibrary({
    rootPath: await tempDirectory(t, 'syncshow-exchange-sermon-conflict-library-')
  });
  const local = await sermonLibrary.saveDocument(sermonDocument('Keep This Local Sermon'));
  const exchange = new ServiceProjectExchange({
    projectStore: targetStore,
    sermonLibrary,
    appVersion: '1.4.0-test'
  });

  const imported = await exchange.importBundle(exported.buffer);
  assert.equal(imported.imported, true);
  assert.equal(imported.sermonLibrary.discovered, 1);
  assert.equal(imported.sermonLibrary.added, 0);
  assert.equal(imported.sermonLibrary.unchanged, 0);
  assert.equal(imported.sermonLibrary.conflicts, 1);
  assert.equal(imported.sermonLibrary.failed, 0);
  assert.deepEqual(imported.sermonLibrary.warnings.map(warning => warning.code), [
    'PORTABLE_SERMON_CONFLICT'
  ]);
  const importedPin = Object.values(imported.project.resources)
    .find(resource => resource.kind === 'sermon');
  assert.equal(importedPin.sha256, portableSermon.sha256);
  assert.equal(importedPin.document.titles.en, 'The Prayer That Transforms the Church');

  const preserved = await sermonLibrary.read('portable-prayer-sermon');
  assert.equal(preserved.revision, local.revision);
  assert.notEqual(preserved.revision, portableSermon.sha256);
  assert.equal(preserved.sermon.titles.en, 'Keep This Local Sermon');
});

test('portable song conflicts preserve both the imported project and the existing library song', async t => {
  const fixture = await createPortableFixture(t);
  const exported = await new ServiceProjectExchange({ projectStore: fixture.store }).exportBundle(
    fixture.saved.project.id,
    fixture.saved.revisionId
  );
  const targetStore = new ServiceProjectStore({
    rootPath: await tempDirectory(t, 'syncshow-exchange-conflict-project-'),
    imageInspector: async () => IMAGE_METADATA
  });
  const songLibrary = new LocalSongLibrary({
    rootPath: await tempDirectory(t, 'syncshow-exchange-conflict-library-')
  });
  const local = await songLibrary.saveSource([
    '---',
    'id: portable-grace',
    'title: Local Grace',
    'language: en',
    '---',
    '^1',
    'Keep this local song unchanged'
  ].join('\n'));
  const exchange = new ServiceProjectExchange({
    projectStore: targetStore,
    songLibrary,
    appVersion: '1.4.0-test'
  });

  const imported = await exchange.importBundle(exported.buffer);
  assert.equal(imported.imported, true);
  assert.equal(
    Object.values(imported.project.resources).find(resource => resource.kind === 'song').document.title,
    'Portable Grace'
  );
  assert.equal((await targetStore.list()).total, 1);
  assert.equal(imported.songLibrary.discovered, 1);
  assert.equal(imported.songLibrary.added, 0);
  assert.equal(imported.songLibrary.unchanged, 0);
  assert.equal(imported.songLibrary.conflicts, 1);
  assert.equal(imported.songLibrary.failed, 0);
  assert.deepEqual(imported.songLibrary.warnings.map(warning => warning.code), [
    'PORTABLE_SONG_CONFLICT'
  ]);

  const preserved = await songLibrary.read('portable-grace');
  assert.equal(preserved.revision, local.revision);
  assert.equal(preserved.song.title, 'Local Grace');
  assert.equal(preserved.song.sections[0].slides[0].lines[0], 'Keep this local song unchanged');
});

test('portable image installation revalidates real decoded metadata before publishing the project pointer', async t => {
  const sharp = require('sharp');
  const sourceRoot = await tempDirectory(t, 'syncshow-exchange-real-source-');
  const sourceImageRoot = await tempDirectory(t, 'syncshow-exchange-real-image-');
  const sourcePath = path.join(sourceImageRoot, 'real.png');
  const bytes = await sharp({
    create: {
      width: 32,
      height: 18,
      channels: 4,
      background: { r: 20, g: 40, b: 80, alpha: 1 }
    }
  }).png().toBuffer();
  await fs.writeFile(sourcePath, bytes);
  const sourceStore = new ServiceProjectStore({ rootPath: sourceRoot });
  const created = await sourceStore.create({
    id: 'portable-real-image',
    title: 'Real image service',
    serviceDate: '2026-07-26',
    profileId: 'main-sanctuary'
  });
  const withImage = await sourceStore.importImage(created.project.id, {
    sourcePath,
    expectedRevisionId: created.revisionId,
    altText: 'A real decoded PNG'
  });
  const exported = await new ServiceProjectExchange({ projectStore: sourceStore }).exportBundle(
    withImage.project.id,
    withImage.revisionId
  );

  const targetStore = new ServiceProjectStore({
    rootPath: await tempDirectory(t, 'syncshow-exchange-real-target-')
  });
  const imported = await new ServiceProjectExchange({ projectStore: targetStore }).importBundle(exported.buffer);
  const asset = imported.project.assets[withImage.asset.id];
  assert.equal(asset.width, 32);
  assert.equal(asset.height, 18);
  const resolved = await targetStore.resolveAssetPath(imported.project.id, imported.revisionId, asset.id);
  assert.deepEqual(await fs.readFile(resolved.assetPath), bytes);
});

test('divergent project-id collisions fork safely and never overwrite the local project', async t => {
  const fixture = await createPortableFixture(t);
  const exported = await new ServiceProjectExchange({ projectStore: fixture.store }).exportBundle(
    fixture.saved.project.id,
    fixture.saved.revisionId
  );
  const targetRoot = await tempDirectory(t, 'syncshow-exchange-collision-');
  let nextId = 0;
  const targetStore = new ServiceProjectStore({
    rootPath: targetRoot,
    randomUUID: () => `00000000-0000-4000-8000-${String(++nextId).padStart(12, '0')}`,
    imageInspector: async () => IMAGE_METADATA
  });
  const local = await targetStore.create({
    id: fixture.saved.project.id,
    title: 'Do not overwrite me',
    serviceDate: '2026-07-26',
    profileId: 'main-sanctuary'
  });

  const imported = await new ServiceProjectExchange({ projectStore: targetStore }).importBundle(exported.buffer);
  assert.equal(imported.imported, true);
  assert.equal(imported.forked, true);
  assert.notEqual(imported.project.id, local.project.id);
  assert.match(imported.project.title, /\(Imported copy\)$/);
  assert.equal((await targetStore.read(local.project.id)).project.title, 'Do not overwrite me');
  assert.equal((await targetStore.list()).total, 2);
});

test('an unreadable local project with the same id is preserved while the import forks', async t => {
  const fixture = await createPortableFixture(t);
  const exported = await new ServiceProjectExchange({ projectStore: fixture.store }).exportBundle(
    fixture.saved.project.id,
    fixture.saved.revisionId
  );
  const targetRoot = await tempDirectory(t, 'syncshow-exchange-corrupt-collision-');
  let nextId = 100;
  const targetStore = new ServiceProjectStore({
    rootPath: targetRoot,
    randomUUID: () => `00000000-0000-4000-8000-${String(++nextId).padStart(12, '0')}`,
    imageInspector: async () => IMAGE_METADATA
  });
  const local = await targetStore.create({
    id: fixture.saved.project.id,
    title: 'Damaged local evidence',
    serviceDate: '2026-07-26',
    profileId: 'main-sanctuary'
  });
  const revisionPath = path.join(
    targetRoot,
    projectStorageKey(local.project.id),
    'revisions',
    `${local.revisionId}.json`
  );
  await fs.writeFile(revisionPath, '{ preserved damaged revision }\n');
  const damagedEvidence = await fs.readFile(revisionPath);

  const imported = await new ServiceProjectExchange({ projectStore: targetStore }).importBundle(exported.buffer);
  assert.equal(imported.forked, true);
  assert.notEqual(imported.project.id, local.project.id);
  assert.deepEqual(await fs.readFile(revisionPath), damagedEvidence);
});

test('project, song, Bible, manifest, and asset tampering all fail before store publication', async t => {
  const fixture = await createPortableFixture(t);
  const exported = await new ServiceProjectExchange({ projectStore: fixture.store }).exportBundle(
    fixture.saved.project.id,
    fixture.saved.revisionId
  );
  const targetStore = new ServiceProjectStore({
    rootPath: await tempDirectory(t, 'syncshow-exchange-tamper-target-'),
    imageInspector: async () => IMAGE_METADATA
  });
  const exchange = new ServiceProjectExchange({ projectStore: targetStore });

  const projectHashTamper = await rewriteBundle(exported.buffer, async zip => {
    const source = await zip.file('project.json').async('string');
    zip.file('project.json', source.replace('Portable Sunday Service', 'Tampered Sunday Service'), {
      compression: 'STORE',
      createFolders: false
    });
  });
  await assert.rejects(exchange.importBundle(projectHashTamper), expectExchangeCode('BUNDLE_PROJECT_HASH_MISMATCH'));

  const manifestTamper = await rewriteBundle(exported.buffer, async zip => {
    const manifest = JSON.parse(await zip.file('manifest.json').async('string'));
    manifest.createdBy.version = 'tampered';
    zip.file('manifest.json', serializeManifest(manifest), { compression: 'STORE', createFolders: false });
  });
  await assert.rejects(exchange.importBundle(manifestTamper), expectExchangeCode('BUNDLE_MANIFEST_HASH_MISMATCH'));

  const assetTamper = await rewriteBundle(exported.buffer, async zip => {
    zip.file(exported.manifest.assets[0].path, Buffer.from('changed image bytes'), {
      compression: 'STORE',
      createFolders: false
    });
  });
  await assert.rejects(exchange.importBundle(assetTamper), expectExchangeCode('BUNDLE_ASSET_SIZE_MISMATCH'));

  for (const kind of ['song', 'bible']) {
    const contentTamper = await rewriteBundle(exported.buffer, async zip => {
      const project = JSON.parse(await zip.file('project.json').async('string'));
      if (kind === 'song') {
        project.resources[Object.keys(project.resources)[0]].document.title = 'Tampered embedded song';
      } else {
        project.items['portable-bible'].passagesByChannel.primary.verses[0].text = 'Tampered Bible text';
      }
      const projectBuffer = Buffer.from(`${JSON.stringify(project, null, 2)}\n`, 'utf8');
      const manifest = JSON.parse(await zip.file('manifest.json').async('string'));
      refreshManifestProject(manifest, projectBuffer);
      zip.file('project.json', projectBuffer, { compression: 'STORE', createFolders: false });
      zip.file('manifest.json', serializeManifest(manifest), { compression: 'STORE', createFolders: false });
    });
    await assert.rejects(
      exchange.importBundle(contentTamper),
      error => {
        assert.ok(error instanceof ProjectExchangeError);
        assert.equal(error.code, 'INVALID_BUNDLE_PROJECT');
        assert.match(error.message, kind === 'song' ? /content hash/i : /pinned checksum/i);
        return true;
      }
    );
  }
  assert.equal((await targetStore.list()).total, 0);
});

test('an internally self-consistent non-image payload cannot masquerade as a PNG', async t => {
  const fixture = await createPortableFixture(t);
  const exported = await new ServiceProjectExchange({ projectStore: fixture.store }).exportBundle(
    fixture.saved.project.id,
    fixture.saved.revisionId
  );
  const hostile = await rewriteBundle(exported.buffer, async zip => {
    const oldAsset = exported.manifest.assets[0];
    const bytes = Buffer.from('not actually a png');
    const digest = hash(bytes);
    const storedName = `${digest}.png`;
    const assetId = `sha256:${digest}`;
    const project = JSON.parse(await zip.file('project.json').async('string'));
    const asset = project.assets[oldAsset.id];
    delete project.assets[oldAsset.id];
    project.assets[assetId] = {
      ...asset,
      id: assetId,
      sha256: digest,
      storedName,
      size: bytes.length
    };
    project.items['portable-picture'].assetId = assetId;
    const canonicalProject = normalizeServiceProject(project);
    const projectBuffer = Buffer.from(serializeServiceProject(canonicalProject), 'utf8');
    const manifest = JSON.parse(await zip.file('manifest.json').async('string'));
    manifest.assets = [{
      ...manifest.assets[0],
      id: assetId,
      path: `assets/${storedName}`,
      storedName,
      sha256: digest,
      size: bytes.length
    }];
    refreshManifestProject(manifest, projectBuffer);
    zip.remove(oldAsset.path);
    zip.file(`assets/${storedName}`, bytes, { compression: 'STORE', createFolders: false });
    zip.file('project.json', projectBuffer, { compression: 'STORE', createFolders: false });
    zip.file('manifest.json', serializeManifest(manifest), { compression: 'STORE', createFolders: false });
  });

  const targetStore = new ServiceProjectStore({
    rootPath: await tempDirectory(t, 'syncshow-exchange-type-target-'),
    imageInspector: async () => IMAGE_METADATA
  });
  await assert.rejects(
    new ServiceProjectExchange({ projectStore: targetStore }).importBundle(hostile),
    expectExchangeCode('BUNDLE_ASSET_TYPE_MISMATCH')
  );
  assert.equal((await targetStore.list()).total, 0);
});

test('ZIP validation rejects traversal, duplicates, directories, links, compression, and undeclared entries', async t => {
  const traversal = new JSZip();
  traversal.file('manifest.json', '{}', { compression: 'STORE', createFolders: false });
  traversal.file('../project.json', '{}', { compression: 'STORE', createFolders: false });
  await assert.rejects(
    Promise.resolve().then(async () => inspectZipStructure(await generateStoredZip(traversal))),
    expectExchangeCode('INVALID_BUNDLE_ZIP')
  );

  const directory = new JSZip();
  directory.file('manifest.json', '{}', { compression: 'STORE', createFolders: false });
  directory.folder('project.json');
  await assert.rejects(
    Promise.resolve().then(async () => inspectZipStructure(await generateStoredZip(directory))),
    expectExchangeCode('INVALID_BUNDLE_ZIP')
  );

  const link = new JSZip();
  link.file('manifest.json', '{}', { compression: 'STORE', createFolders: false, unixPermissions: 0o120777 });
  link.file('project.json', '{}', { compression: 'STORE', createFolders: false });
  await assert.rejects(
    Promise.resolve().then(async () => inspectZipStructure(await generateStoredZip(link))),
    expectExchangeCode('INVALID_BUNDLE_ZIP')
  );

  const compressed = new JSZip();
  compressed.file('manifest.json', '{}');
  compressed.file('project.json', '{}');
  const compressedBuffer = await compressed.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
  assert.throws(() => inspectZipStructure(compressedBuffer), expectExchangeCode('INVALID_BUNDLE_ZIP'));

  const duplicateZip = new JSZip();
  duplicateZip.file('one.txt', 'one', { createFolders: false });
  duplicateZip.file('two.txt', 'two', { createFolders: false });
  const duplicateBuffer = await generateStoredZip(duplicateZip);
  let duplicateOffset = 0;
  while ((duplicateOffset = duplicateBuffer.indexOf('two.txt', duplicateOffset, 'utf8')) >= 0) {
    duplicateBuffer.write('one.txt', duplicateOffset, 'utf8');
    duplicateOffset += 7;
  }
  assert.throws(() => inspectZipStructure(duplicateBuffer), expectExchangeCode('INVALID_BUNDLE_ZIP'));

  const fixture = await createPortableFixture(t);
  const exported = await new ServiceProjectExchange({ projectStore: fixture.store }).exportBundle(
    fixture.saved.project.id,
    fixture.saved.revisionId
  );
  const extra = await rewriteBundle(exported.buffer, async zip => {
    zip.file('undeclared.txt', 'hidden', { compression: 'STORE', createFolders: false });
  });
  const targetStore = new ServiceProjectStore({
    rootPath: await tempDirectory(t, 'syncshow-exchange-extra-target-'),
    imageInspector: async () => IMAGE_METADATA
  });
  await assert.rejects(
    new ServiceProjectExchange({ projectStore: targetStore }).importBundle(extra),
    expectExchangeCode('UNEXPECTED_BUNDLE_ENTRY')
  );
});

test('custom preset metadata is never misrepresented as a portable service', async t => {
  const fixture = await createPortableFixture(t);
  const raw = JSON.parse(serializeServiceProject(fixture.saved.project));
  raw.presetPack.sha256 = 'a'.repeat(64);
  const custom = await fixture.store.save(raw, {
    expectedRevisionId: fixture.saved.revisionId,
    reason: 'custom-preset'
  });
  await assert.rejects(
    new ServiceProjectExchange({ projectStore: fixture.store }).exportBundle(custom.project.id, custom.revisionId),
    expectExchangeCode('UNSUPPORTED_PORTABLE_PRESET_PACK')
  );
});
