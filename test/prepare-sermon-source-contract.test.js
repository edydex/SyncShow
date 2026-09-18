'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsPromises = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');

const {
  LocalSermonLibrary,
  ServiceProjectStore,
  addGroupItem,
  addSermonResource,
  createServiceProject,
  isPowerPointCompanionProject,
  isSermonSourceTarget,
  setSermonSourceLink
} = require('../src/services/project');

const root = path.join(__dirname, '..');
const mainSource = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
const preloadSource = fs.readFileSync(path.join(root, 'preload.js'), 'utf8');

const PROJECT_REVISION = 'a'.repeat(64);
const SERMON_REVISION = 'b'.repeat(64);

function plain(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function loadPreloadBridge() {
  const calls = [];
  let api = null;
  const ipcRenderer = {
    invoke(channel, payload) {
      calls.push({ channel, payload: plain(payload) });
      return Promise.resolve({ ok: true });
    },
    send() {},
    on() {},
    removeListener() {},
    removeAllListeners() {}
  };
  const contextBridge = {
    exposeInMainWorld(name, value) {
      if (name === 'api') api = value;
    }
  };
  vm.runInNewContext(preloadSource, {
    require(moduleId) {
      if (moduleId === 'electron') return { contextBridge, ipcRenderer };
      throw new Error(`Unexpected preload dependency: ${moduleId}`);
    },
    console
  }, { filename: path.join(root, 'preload.js') });
  assert.ok(api, 'preload must expose the renderer API');
  return { api, calls };
}

function sourceBetween(startMarker, endMarker) {
  const start = mainSource.indexOf(startMarker);
  assert.notEqual(start, -1, `${startMarker} must exist`);
  const end = mainSource.indexOf(endMarker, start + startMarker.length);
  assert.notEqual(end, -1, `${endMarker} must follow ${startMarker}`);
  return mainSource.slice(start, end);
}

function handlerSource(channel) {
  const marker = `ipcMain.handle('${channel}'`;
  const start = mainSource.indexOf(marker);
  assert.notEqual(start, -1, `${channel} must be implemented`);
  const next = mainSource.indexOf("ipcMain.handle('", start + marker.length);
  return mainSource.slice(start, next === -1 ? mainSource.length : next);
}

function sermonDocument(title) {
  return {
    schemaVersion: 1,
    kind: 'syncshow-sermon',
    id: 'sermon-2026-07-26-prayer',
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

async function tempDirectory(t, prefix) {
  const directory = await fsPromises.mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(() => fsPromises.rm(directory, { recursive: true, force: true }));
  return fsPromises.realpath(directory);
}

test('sermon preload methods forward only whitelisted semantic identifiers', async () => {
  const { api, calls } = loadPreloadBridge();
  const hostile = {
    document: { hostile: true },
    sermon: { hostile: true },
    resource: { hostile: true },
    resources: { hostile: true },
    origin: { provider: 'renderer' },
    path: '/private/sermon.json',
    filePath: '/private/sermon.pdf',
    sourcePath: '/private/sermon.pptx'
  };

  await api.listSermonLibrary({
    ...hostile,
    query: 'prayer',
    pageSize: 25,
    offset: 50
  });
  await api.readSermonOutline({
    ...hostile,
    sermonId: 'sermon-2026-07-26-prayer',
    sermonRevisionId: SERMON_REVISION
  });
  await api.sourceSermonForServiceItem({
    ...hostile,
    projectId: 'service-2026-07-26',
    expectedRevisionId: PROJECT_REVISION,
    itemId: 'sermon-group',
    sermonId: 'sermon-2026-07-26-prayer',
    sermonRevisionId: SERMON_REVISION,
    sermonSectionId: 'foundation'
  });

  assert.deepEqual(calls, [{
    channel: 'prepare:sermons:list',
    payload: { query: 'prayer', pageSize: 25, offset: 50 }
  }, {
    channel: 'prepare:sermons:outline',
    payload: {
      sermonId: 'sermon-2026-07-26-prayer',
      sermonRevisionId: SERMON_REVISION
    }
  }, {
    channel: 'prepare:projects:sourceSermon',
    payload: {
      projectId: 'service-2026-07-26',
      expectedRevisionId: PROJECT_REVISION,
      itemId: 'sermon-group',
      sermonId: 'sermon-2026-07-26-prayer',
      sermonRevisionId: SERMON_REVISION,
      sermonSectionId: 'foundation'
    }
  }]);
});

test('main owns sermon storage, sanitized reads, exact revision pinning, and project CAS', () => {
  const services = sourceBetween('function getPrepareServices()', 'async function getCommunityServices()');
  assert.match(services, /new LocalSermonLibrary\(\{\s*rootPath: path\.join\(userDataPath, 'sermon-library'\)/);
  assert.match(services, /localSermonLibrary,/);

  const list = handlerSource('prepare:sermons:list');
  assert.match(list, /requireControlSender\(event\)/);
  assert.match(list, /requirePrepareRequest\(request, 16 \* 1024\)/);
  assert.match(list, /localSermonLibrary\.list\(/);
  assert.match(list, /listing\.items\.map\(sermonLibrarySummaryResult\)/);

  const summarySanitizer = sourceBetween(
    'function sermonLibrarySummaryResult(summary)',
    'function sermonOutlineResult(read)'
  );
  const outlineSanitizer = sourceBetween(
    'function sermonOutlineResult(read)',
    'function failSermonSourceImport(error)'
  );
  for (const sanitizer of [summarySanitizer, outlineSanitizer]) {
    assert.doesNotMatch(
      sanitizer,
      /\b(?:sources|references|media|documentSource|source|path|filePath|origin)\b/,
      'renderer sermon reads must not disclose source records, raw documents, or storage locations'
    );
  }

  const outline = handlerSource('prepare:sermons:outline');
  assert.match(outline, /requireControlSender\(event\)/);
  assert.match(outline, /requirePrepareRequest\(request, 16 \* 1024\)/);
  assert.match(outline, /prepareRevision\(request\.sermonRevisionId, 'Sermon revision'\)/);
  assert.match(outline, /localSermonLibrary\.readRevision\(\s*sermonId,\s*sermonRevisionId\s*\)/);
  assert.match(outline, /return sermonOutlineResult\(read\)/);

  const source = handlerSource('prepare:projects:sourceSermon');
  assert.match(source, /requireControlSender\(event\)/);
  assert.match(source, /requirePrepareRequest\(request, 16 \* 1024\)/);
  assert.match(source, /readExpectedProject\(request\)/);
  assert.match(source, /isPowerPointCompanionProject\(current\.project\)/);
  assert.match(source, /CURRENT_SERVICE_COMPANION_LINK_LOCKED/);
  assert.match(source, /isSermonSourceTarget\(current\.project, item\)/);
  assert.match(source, /'INVALID_SERMON_SOURCE_ITEM'/);
  assert.match(source, /const embeddedResource = Object\.values\(current\.project\.resources\)\.find/);
  assert.match(source, /localSermonLibrary\.readRevision\(\s*sermonId,\s*sermonRevisionId\s*\)/);
  assert.match(source, /addSermonResource\(current\.project, sermonDocument,/);
  assert.match(source, /provider: 'local-sermon-library'/);
  assert.match(source, /revision: sermonRead\.revision/);
  assert.match(source, /setSermonSourceLink\(withResource\.project,/);
  assert.match(source, /sermonResourceId: withResource\.resourceId/);
  assert.match(source, /serviceProjectStore\.save\(linked,/);
  assert.match(source, /expectedRevisionId: current\.expectedRevisionId/);
  assert.match(source, /return projectResult\(/);
  assert.doesNotMatch(
    source,
    /request\.(?:document|sermon|resource|resources|origin|path|filePath|sourcePath)\b/,
    'the linker must never accept renderer-owned sermon documents, resources, origins, or paths'
  );
});

test('an embedded portable sermon revision can be relinked without a local-library copy', async () => {
  const pinned = addSermonResource(createServiceProject({
    id: 'portable-service',
    title: 'Portable Service',
    serviceDate: '2026-07-26',
    profileId: 'portable'
  }), sermonDocument('Portable historical sermon'));
  const project = addGroupItem(pinned.project, {
    id: 'sermon-group',
    title: 'Sermon',
    groupKind: 'sermon',
    sermonResourceId: pinned.resourceId
  });
  let registeredHandler = null;
  let savedProject = null;
  const source = handlerSource('prepare:projects:sourceSermon');
  vm.runInNewContext(source, {
    ipcMain: {
      handle(channel, handler) {
        assert.equal(channel, 'prepare:projects:sourceSermon');
        registeredHandler = handler;
      }
    },
    requireControlSender() {},
    requirePrepareRequest() {},
    async readExpectedProject() {
      return {
        project,
        expectedRevisionId: PROJECT_REVISION,
        services: {
          localSermonLibrary: {
            async readRevision() {
              throw new Error('embedded revisions must not depend on the local library');
            }
          },
          serviceProjectStore: {
            async save(next, options) {
              savedProject = next;
              assert.deepEqual(plain(options), {
                expectedRevisionId: PROJECT_REVISION,
                reason: 'source-sermon'
              });
              return {
                project: next,
                revisionId: 'c'.repeat(64),
                unchanged: false,
                recovery: null
              };
            }
          }
        }
      };
    },
    prepareId: value => String(value),
    prepareSermonDomainId: value => String(value),
    prepareRevision: value => String(value),
    failMainOperation(code, message) {
      const error = new Error(message);
      error.code = code;
      throw error;
    },
    addSermonResource() {
      throw new Error('the already-validated embedded resource must be reused');
    },
    isPowerPointCompanionProject,
    isSermonSourceTarget,
    setSermonSourceLink,
    projectResult: result => ({
      project: result.project,
      revisionId: result.revisionId,
      unchanged: result.unchanged === true,
      recovery: result.recovery || null
    })
  }, { filename: 'embedded-sermon-source-handler.js' });

  const result = await registeredHandler({}, {
    projectId: project.id,
    expectedRevisionId: PROJECT_REVISION,
    itemId: 'sermon-group',
    sermonId: pinned.project.resources[pinned.resourceId].document.id,
    sermonRevisionId: pinned.project.resources[pinned.resourceId].sha256,
    sermonSectionId: 'foundation'
  });
  assert.equal(result.revisionId, 'c'.repeat(64));
  assert.equal(savedProject.items['sermon-group'].sermonResourceId, pinned.resourceId);
  assert.equal(savedProject.items['sermon-group'].sermonSectionId, 'foundation');
});

test('an exact historical sermon revision pins immutably and the project save rejects stale CAS', async t => {
  const storageRoot = await tempDirectory(t, 'syncshow-sermon-ipc-');
  const library = new LocalSermonLibrary({
    rootPath: path.join(storageRoot, 'sermons')
  });
  const store = new ServiceProjectStore({
    rootPath: path.join(storageRoot, 'projects'),
    clock: () => new Date('2026-07-27T12:00:00.000Z')
  });

  const first = await library.saveDocument(
    sermonDocument('The Prayer That Transforms the Church'),
    { expectedRevision: null }
  );
  const latest = await library.saveDocument(
    sermonDocument('A Newer Working Title'),
    {
      expectedSermonId: first.sermon.id,
      expectedRevision: first.revision
    }
  );
  assert.notEqual(first.revision, latest.revision);

  const created = await store.create({
    id: 'service-2026-07-26',
    title: 'Sunday Service',
    serviceDate: '2026-07-26',
    profileId: 'main-sanctuary'
  });
  const withGroup = addGroupItem(created.project, {
    id: 'sermon-group',
    title: 'Sermon',
    groupKind: 'sermon'
  });
  const grouped = await store.save(withGroup, {
    expectedRevisionId: created.revisionId,
    reason: 'add-group'
  });

  const exact = await library.readRevision(first.sermon.id, first.revision);
  const withResource = addSermonResource(grouped.project, exact.sermon, {
    provider: 'local-sermon-library',
    itemId: exact.sermon.id,
    revision: exact.revision
  });
  const linked = setSermonSourceLink(withResource.project, {
    itemId: 'sermon-group',
    sermonResourceId: withResource.resourceId,
    sermonSectionId: 'foundation'
  });
  const saved = await store.save(linked, {
    expectedRevisionId: grouped.revisionId,
    reason: 'source-sermon'
  });

  const resource = saved.project.resources[withResource.resourceId];
  assert.equal(withResource.resourceId, `sha256:${first.revision}`);
  assert.equal(resource.document.titles.en, 'The Prayer That Transforms the Church');
  assert.notEqual(resource.document.titles.en, latest.sermon.titles.en);
  assert.deepEqual(resource.origin, {
    provider: 'local-sermon-library',
    providerId: null,
    itemId: first.sermon.id,
    revision: first.revision
  });
  assert.equal(saved.project.items['sermon-group'].sermonResourceId, withResource.resourceId);
  assert.equal(saved.project.items['sermon-group'].sermonSectionId, 'foundation');

  await assert.rejects(
    store.save(linked, {
      expectedRevisionId: grouped.revisionId,
      reason: 'stale-source-sermon'
    }),
    error => {
      assert.equal(error.code, 'PROJECT_CONFLICT');
      return true;
    }
  );
});
