'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const {
  SERMON_SCHEMA_VERSION,
  SermonAttachmentHealthCoordinator,
  addGroupItem,
  addSermonResource,
  createServiceProject,
  isSermonSourceTarget,
  resolveSermonSourceLink,
  setSermonSourceLink
} = require('../src/services/project');

const root = path.join(__dirname, '..');
const mainSource = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
const preloadSource = fs.readFileSync(path.join(root, 'preload.js'), 'utf8');
const PROJECT_REVISION = 'a'.repeat(64);
const RECORDING_SHA256 = 'c'.repeat(64);

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
  vm.runInNewContext(preloadSource, {
    require(moduleId) {
      if (moduleId !== 'electron') {
        throw new Error(`Unexpected preload dependency: ${moduleId}`);
      }
      return {
        contextBridge: {
          exposeInMainWorld(name, value) {
            if (name === 'api') api = value;
          }
        },
        ipcRenderer: {
          invoke(channel, payload) {
            calls.push({ channel, payload: plain(payload) });
            return Promise.resolve(null);
          },
          send() {},
          on() {},
          removeListener() {},
          removeAllListeners() {}
        }
      };
    },
    console
  }, { filename: 'preload.js' });
  assert.ok(api);
  return { api, calls };
}

function recording(overrides = {}) {
  return {
    id: 'post-service:recording:en',
    kind: 'audio',
    status: 'pending',
    title: 'Sermon audio',
    language: 'en',
    mediaType: 'audio/mpeg',
    fileName: 'Sunday sermon.mp3',
    sha256: RECORDING_SHA256,
    sizeBytes: 12_345,
    durationSeconds: null,
    url: null,
    ...overrides
  };
}

function sermon(media = [recording()]) {
  return {
    schemaVersion: SERMON_SCHEMA_VERSION,
    kind: 'syncshow-sermon',
    id: 'sermon-recording-health',
    titles: { en: 'Recording health sermon' },
    defaultLanguage: 'en',
    speaker: { id: null, name: 'Pastor' },
    serviceDate: '2026-07-27',
    series: null,
    outline: [],
    sources: [],
    references: [],
    media,
    body: [],
    publication: {
      status: 'draft',
      visibility: 'private',
      publishedAt: null,
      canonicalUrl: null
    }
  };
}

function linkedProject(document = sermon()) {
  let project = createServiceProject({
    id: 'service-recording-health',
    title: 'Sunday Service',
    serviceDate: '2026-07-27',
    profileId: 'main-sanctuary'
  });
  project = addGroupItem(project, {
    id: 'sermon-owner',
    title: 'Sermon',
    groupKind: 'sermon'
  });
  project = addGroupItem(project, {
    id: 'sermon-child',
    title: 'Application',
    groupKind: 'point',
    parentId: 'sermon-owner'
  });
  const embedded = addSermonResource(project, document);
  project = setSermonSourceLink(embedded.project, {
    itemId: 'sermon-owner',
    sermonResourceId: embedded.resourceId
  });
  return {
    project,
    resourceId: embedded.resourceId
  };
}

function loadHandler({ project, checkMedia, onRead = () => {} }) {
  let registered = null;
  const failMainOperation = (code, message, details = {}) => {
    const error = new Error(message);
    error.code = code;
    error.details = details;
    throw error;
  };
  vm.runInNewContext(
    handlerSource('prepare:projects:sermonRecordingHealth'),
    {
      ipcMain: {
        handle(channel, handler) {
          assert.equal(channel, 'prepare:projects:sermonRecordingHealth');
          registered = handler;
        }
      },
      requireControlSender(event) {
        assert.equal(event.trusted, true);
      },
      requirePrepareRequest(_request, maximumBytes) {
        assert.equal(maximumBytes, 8 * 1024);
      },
      requireExactPrepareKeys(value, allowed) {
        const supported = new Set(allowed);
        if (Object.keys(value).some(key => !supported.has(key))) {
          failMainOperation(
            'UNSUPPORTED_PREPARE_FIELDS',
            'Sermon recording health contains unsupported fields.'
          );
        }
      },
      prepareId: value => String(value),
      prepareRevision: value => String(value),
      getPrepareServices() {
        return {
          serviceProjectStore: {
            async read(projectId, options) {
              onRead(projectId, plain(options));
              return {
                project,
                revisionId: PROJECT_REVISION,
                recovery: null
              };
            }
          },
          localSermonMediaStore: {
            checkMedia
          }
        };
      },
      failMainOperation,
      isSermonSourceTarget,
      sermonRecordingHealthCoordinator:
        new SermonAttachmentHealthCoordinator(),
      resolveSermonSourceLink
    },
    { filename: 'sermon-recording-health-handler.js' }
  );
  assert.equal(typeof registered, 'function');
  return registered;
}

function request(overrides = {}) {
  return {
    projectId: 'service-recording-health',
    revisionId: PROJECT_REVISION,
    itemId: 'sermon-child',
    ...overrides
  };
}

test('preload sends only the exact project revision and service item identities', async () => {
  const { api, calls } = loadPreloadBridge();
  await api.getSermonRecordingHealthForServiceItem({
    ...request(),
    path: '/renderer-owned/recording.mp3',
    filePath: '/renderer-owned/recording.mp3',
    objectId: `sha256:${RECORDING_SHA256}`,
    recording: {
      sha256: RECORDING_SHA256,
      path: '/renderer-owned/recording.mp3'
    }
  });

  assert.deepEqual(calls, [{
    channel: 'prepare:projects:sermonRecordingHealth',
    payload: request()
  }]);
});

test('main resolves the inherited exact sermon and returns path-free verified health', async () => {
  const fixture = linkedProject();
  const checked = [];
  const reads = [];
  const handler = loadHandler({
    project: fixture.project,
    onRead(projectId, options) {
      reads.push({ projectId, options });
    },
    async checkMedia(media) {
      checked.push(plain(media));
      return {
        objectId: `sha256:${media.sha256}`,
        path: '/private/sermon-media/object',
        sha256: media.sha256,
        sizeBytes: media.sizeBytes
      };
    }
  });

  const result = await handler({ trusted: true }, request());
  assert.deepEqual(reads, [{
    projectId: fixture.project.id,
    options: { revisionId: PROJECT_REVISION }
  }]);
  assert.deepEqual(checked, [recording()]);
  assert.deepEqual(plain(result), {
    projectId: fixture.project.id,
    revisionId: PROJECT_REVISION,
    itemId: 'sermon-child',
    resourceId: fixture.resourceId,
    sermonId: 'sermon-recording-health',
    sermonRevisionId: fixture.resourceId.slice('sha256:'.length),
    recordingId: 'post-service:recording:en',
    health: {
      status: 'verified',
      restorable: false
    }
  });
  const serialized = JSON.stringify(result);
  assert.doesNotMatch(
    serialized,
    /(?:renderer-owned|\/private\/|filePath|objectId|localPath|absolutePath)/i
  );
});

test('concurrent inherited-item checks coalesce one serialized object verification', async () => {
  const fixture = linkedProject();
  let checkCalls = 0;
  let releaseCheck;
  const checkGate = new Promise(resolve => {
    releaseCheck = resolve;
  });
  const handler = loadHandler({
    project: fixture.project,
    async checkMedia() {
      checkCalls += 1;
      await checkGate;
      return { sha256: RECORDING_SHA256 };
    }
  });

  const childResult = handler({ trusted: true }, request());
  const ownerResult = handler({ trusted: true }, request({
    itemId: 'sermon-owner'
  }));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(checkCalls, 1);
  releaseCheck();
  const [child, owner] = await Promise.all([childResult, ownerResult]);
  assert.equal(child.itemId, 'sermon-child');
  assert.equal(owner.itemId, 'sermon-owner');
  assert.deepEqual(plain(child.health), plain(owner.health));
});

test('main maps missing, corrupt metadata, corrupt objects, and store failures without leaking errors', async t => {
  const fixture = linkedProject();
  const cases = [
    ['OBJECT_NOT_FOUND', 'missing', true],
    ['OBJECT_CORRUPT', 'corrupt', true],
    ['INVALID_MEDIA_METADATA', 'corrupt', false],
    ['STORE_UNAVAILABLE', 'unavailable', false]
  ];

  for (const [code, expectedStatus, restorable] of cases) {
    await t.test(`${code} becomes ${expectedStatus}`, async () => {
      const handler = loadHandler({
        project: fixture.project,
        async checkMedia() {
          const error = new Error('private store failure');
          error.code = code;
          error.path = '/private/sermon-media/object';
          error.objectId = `sha256:${RECORDING_SHA256}`;
          throw error;
        }
      });
      const result = await handler({ trusted: true }, request());
      assert.deepEqual(plain(result.health), {
        status: expectedStatus,
        restorable
      });
      assert.doesNotMatch(
        JSON.stringify(result),
        /(?:private store failure|\/private\/|objectId|path)/i
      );
    });
  }
});

test('managed URL-only and absent recordings are not-recorded and never query the local store', async t => {
  const fixtures = [
    {
      name: 'managed recording without a content hash',
      linked: linkedProject(sermon([recording({
        mediaType: '',
        fileName: null,
        sha256: null,
        sizeBytes: null,
        status: 'ready',
        url: 'https://media.example/sermon.mp3'
      })])),
      recordingId: 'post-service:recording:en'
    },
    {
      name: 'no managed recording',
      linked: linkedProject(sermon([])),
      recordingId: null
    }
  ];

  for (const fixture of fixtures) {
    await t.test(fixture.name, async () => {
      let checked = false;
      const handler = loadHandler({
        project: fixture.linked.project,
        async checkMedia() {
          checked = true;
          throw new Error('must not check a recording without local bytes');
        }
      });
      const result = await handler({ trusted: true }, request());
      assert.equal(checked, false);
      assert.equal(result.recordingId, fixture.recordingId);
      assert.deepEqual(plain(result.health), {
        status: 'not-recorded',
        restorable: false
      });
    });
  }
});

test('main rejects renderer-controlled paths and object identities before reading a project', async () => {
  const fixture = linkedProject();
  let read = false;
  const handler = loadHandler({
    project: fixture.project,
    onRead() {
      read = true;
    },
    async checkMedia() {
      throw new Error('must not inspect media for an invalid request');
    }
  });

  await assert.rejects(
    handler({ trusted: true }, request({
      path: '/renderer-owned/recording.mp3',
      objectId: `sha256:${RECORDING_SHA256}`
    })),
    error => error?.code === 'UNSUPPORTED_PREPARE_FIELDS'
  );
  assert.equal(read, false);

  const source = handlerSource('prepare:projects:sermonRecordingHealth');
  assert.match(source, /requireExactPrepareKeys\(request,/);
  assert.match(source, /serviceProjectStore\.read\(projectId, \{ revisionId \}\)/);
  assert.match(source, /resolveSermonSourceLink\(read\.project, item\)/);
  assert.match(source, /localSermonMediaStore\.checkMedia\(recording\)/);
  assert.doesNotMatch(
    source,
    /request\.(?:path|filePath|localPath|absolutePath|objectId|sha256|recording)\b/
  );
});
