'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const {
  addGroupItem,
  addSermonResource,
  createServiceProject,
  isSermonSourceTarget,
  resolveSermonSourceLink,
  SermonAttachmentHealthCoordinator,
  setSermonSourceLink
} = require('../src/services/project');

const root = path.join(__dirname, '..');
const mainSource = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
const preloadSource = fs.readFileSync(path.join(root, 'preload.js'), 'utf8');
const PROJECT_REVISION = 'a'.repeat(64);

function plain(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function handlerSource(channel) {
  const marker = `ipcMain.handle('${channel}'`;
  const start = mainSource.indexOf(marker);
  assert.notEqual(start, -1, `${channel} must be implemented`);
  const next = mainSource.indexOf("ipcMain.handle('", start + marker.length);
  return mainSource.slice(start, next === -1 ? mainSource.length : next);
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
  return { api, calls };
}

function attachment(id, suffix, fileName = `${id}.md`) {
  return {
    id,
    kind: 'manuscript',
    fileName,
    mediaType: 'text/markdown',
    languages: ['en'],
    sha256: suffix.repeat(64),
    sizeBytes: 64,
    provenance: {
      providedBy: 'Pastor Example',
      receivedAt: '2026-07-27T12:00:00.000Z',
      sourceSystem: 'manual-file-picker',
      externalId: ''
    }
  };
}

function linkedProject() {
  let project = createServiceProject({
    id: 'service-health-check',
    title: 'Health Check Service',
    serviceDate: '2026-07-27',
    profileId: 'main-sanctuary'
  });
  project = addGroupItem(project, {
    id: 'sermon-parent',
    title: 'Sermon',
    groupKind: 'sermon'
  });
  project = addGroupItem(project, {
    id: 'sermon-child',
    title: 'Application',
    groupKind: 'point',
    parentId: 'sermon-parent'
  });
  const sermon = {
    schemaVersion: 2,
    kind: 'syncshow-sermon',
    id: 'sermon-health',
    titles: { en: 'Health Check Sermon' },
    defaultLanguage: 'en',
    speaker: { id: null, name: 'Pastor Example' },
    serviceDate: '2026-07-27',
    series: null,
    outline: [],
    sources: [
      attachment('available', '1'),
      attachment('missing', '2'),
      attachment('corrupt', '3'),
      attachment('unverified', '4')
    ],
    references: [],
    media: [],
    publication: {
      status: 'draft',
      visibility: 'private',
      publishedAt: null,
      canonicalUrl: null
    }
  };
  const pinned = addSermonResource(project, sermon, {
    provider: 'local-sermon-library',
    itemId: sermon.id
  });
  project = setSermonSourceLink(pinned.project, {
    itemId: 'sermon-parent',
    sermonResourceId: pinned.resourceId
  });
  return {
    project,
    resourceId: pinned.resourceId
  };
}

test('attachment health preload accepts only exact service identities', async () => {
  const { api, calls } = loadPreloadBridge();
  await api.getSermonAttachmentHealthForServiceItem({
    projectId: 'service-health-check',
    revisionId: PROJECT_REVISION,
    itemId: 'sermon-child',
    source: { sha256: 'renderer-owned' },
    sources: [{ path: '/private/source.pdf' }],
    path: '/private/source.pdf',
    filePath: '/private/source.pdf',
    objectId: 'sha256:renderer-owned'
  });
  assert.deepEqual(calls, [{
    channel: 'prepare:projects:sermonAttachmentHealth',
    payload: {
      projectId: 'service-health-check',
      revisionId: PROJECT_REVISION,
      itemId: 'sermon-child'
    }
  }]);
});

test('main checks an inherited exact pinned resource and returns only aggregate host health', async () => {
  const fixture = linkedProject();
  const checkedIds = [];
  let handler = null;
  const sermonAttachmentHealthCoordinator = new SermonAttachmentHealthCoordinator();
  const failMainOperation = (code, message) => {
    const error = new Error(message);
    error.code = code;
    throw error;
  };

  vm.runInNewContext(handlerSource('prepare:projects:sermonAttachmentHealth'), {
    ipcMain: {
      handle(channel, callback) {
        assert.equal(channel, 'prepare:projects:sermonAttachmentHealth');
        handler = callback;
      }
    },
    requireControlSender(event) {
      assert.equal(event.trusted, true);
    },
    requirePrepareRequest(_request, maximumBytes) {
      assert.equal(maximumBytes, 16 * 1024);
    },
    prepareId(value) {
      return String(value);
    },
    prepareRevision(value) {
      return String(value);
    },
    getPrepareServices() {
      return {
        serviceProjectStore: {
          async read(projectId, options) {
            assert.equal(projectId, fixture.project.id);
            assert.deepEqual(plain(options), { revisionId: PROJECT_REVISION });
            return {
              project: fixture.project,
              revisionId: PROJECT_REVISION,
              recovery: null
            };
          }
        },
        localSermonSourceStore: {
          async checkSource(source) {
            checkedIds.push(source.id);
            if (source.id === 'available') return { sha256: source.sha256 };
            const error = new Error('must not escape the main process');
            error.code = source.id === 'missing'
              ? 'OBJECT_NOT_FOUND'
              : source.id === 'corrupt'
                ? 'OBJECT_CORRUPT'
                : 'STORE_UNAVAILABLE';
            error.path = '/private/sermon-source-object';
            throw error;
          }
        }
      };
    },
    failMainOperation,
    sermonAttachmentHealthCoordinator,
    isSermonSourceTarget,
    resolveSermonSourceLink
  }, { filename: 'sermon-attachment-health-handler.js' });

  const result = await handler({ trusted: true }, {
    projectId: fixture.project.id,
    revisionId: PROJECT_REVISION,
    itemId: 'sermon-child',
    path: '/renderer-owned/source.pdf',
    source: { hostile: true }
  });
  assert.deepEqual(checkedIds, ['available', 'missing', 'corrupt', 'unverified']);
  assert.equal(result.resourceId, fixture.resourceId);
  assert.equal(result.sermonId, 'sermon-health');
  assert.equal(result.sermonRevisionId, fixture.resourceId.slice('sha256:'.length));
  assert.deepEqual(plain(result.health), {
    totalCount: 4,
    checkedCount: 4,
    verifiedCount: 1,
    missingCount: 1,
    corruptCount: 1,
    unverifiedCount: 1
  });
  const serialized = JSON.stringify(result);
  assert.doesNotMatch(serialized, /private|renderer-owned|objectId|filePath|path/i);

  const source = handlerSource('prepare:projects:sermonAttachmentHealth');
  assert.match(source, /serviceProjectStore\.read\(projectId, \{ revisionId \}\)/);
  assert.match(source, /resolveSermonSourceLink\(read\.project, item\)/);
  assert.match(
    source,
    /sermonAttachmentHealthCoordinator\.inspect\(\s*linked\.resourceId,/
  );
  assert.doesNotMatch(
    source,
    /request\.(?:source|sources|path|filePath|sourcePath|objectId)\b/
  );
});
