'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const {
  SERMON_SCHEMA_VERSION,
  addGroupItem,
  addSermonResource,
  analyzeSermonPostServiceReadiness,
  attachLocalSermonRecording,
  createServiceProject,
  isSermonSourceTarget,
  normalizeServiceProject,
  repinCompatibleSermonDocument,
  resolveSermonSourceLink,
  sermonDocumentSha256,
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

function sermon(overrides = {}) {
  return {
    schemaVersion: SERMON_SCHEMA_VERSION,
    kind: 'syncshow-sermon',
    id: 'sermon-recording-contract',
    titles: { en: 'A sermon to hear again' },
    defaultLanguage: 'en',
    speaker: { id: null, name: 'Pastor' },
    serviceDate: '2026-07-27',
    series: null,
    outline: [],
    sources: [],
    references: [{
      id: 'primary',
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
    body: [],
    publication: {
      status: 'draft',
      visibility: 'private',
      publishedAt: null,
      canonicalUrl: null
    },
    ...overrides
  };
}

function linkedProject(document = sermon()) {
  let project = createServiceProject({
    id: 'service-recording-contract',
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
    title: 'Sermon point',
    groupKind: 'point',
    parentId: 'sermon-owner'
  });
  const embedded = addSermonResource(project, document);
  project = setSermonSourceLink(embedded.project, {
    itemId: 'sermon-owner',
    sermonResourceId: embedded.resourceId
  });
  return { project, resourceId: embedded.resourceId };
}

function completedPlanningProject(project) {
  const raw = plain(project);
  raw.planning = {
    schemaVersion: 1,
    status: 'completed',
    startTime: '10:30',
    templateSource: {
      projectId: 'service-recording-template',
      sourceRevisionId: 'b'.repeat(64)
    },
    readinessWaivers: [{
      checkId: 'song-present',
      reason: 'The service used an unaccompanied response.'
    }]
  };
  return normalizeServiceProject(raw);
}

function loadHandler(dependencies = {}) {
  let registered = null;
  const failMainOperation = (code, message, details = {}) => {
    const error = new Error(message);
    error.code = code;
    error.details = details;
    throw error;
  };
  vm.runInNewContext(
    handlerSource('prepare:projects:attachSermonRecording'),
    {
      ipcMain: {
        handle(channel, handler) {
          assert.equal(channel, 'prepare:projects:attachSermonRecording');
          registered = handler;
        }
      },
      requireControlSender() {},
      requirePrepareRequest(_request, maximumBytes) {
        assert.equal(maximumBytes, 8 * 1024);
      },
      requireExactPrepareKeys(value, allowed) {
        const supported = new Set(allowed);
        if (Object.keys(value).some(key => !supported.has(key))) {
          failMainOperation(
            'UNSUPPORTED_PREPARE_FIELDS',
            'Sermon recording intake contains unsupported fields.'
          );
        }
      },
      prepareId: value => String(value),
      prepareSermonDomainId: value => String(value),
      prepareRevision: value => String(value),
      failMainOperation,
      failSermonMediaImport(error) {
        throw error;
      },
      isSermonSourceTarget,
      resolveSermonSourceLink,
      attachLocalSermonRecording,
      analyzeSermonPostServiceReadiness,
      sermonDocumentSha256,
      addSermonResource,
      repinCompatibleSermonDocument,
      controlWindow: {},
      projectResult(result) {
        return {
          project: result.project,
          revisionId: result.revisionId,
          unchanged: result.unchanged === true,
          recovery: result.recovery || null
        };
      },
      ...dependencies
    },
    { filename: 'attach-sermon-recording-handler.js' }
  );
  assert.equal(typeof registered, 'function');
  return registered;
}

function request(overrides = {}) {
  return {
    projectId: 'service-recording-contract',
    expectedRevisionId: PROJECT_REVISION,
    itemId: 'sermon-child',
    sermonId: 'sermon-recording-contract',
    expectedSermonRevisionId: sermonDocumentSha256(sermon()),
    ...overrides
  };
}

function localRecordingMedia(overrides = {}) {
  return {
    kind: 'audio',
    mediaType: 'audio/mpeg',
    fileName: 'Sunday sermon.mp3',
    sha256: RECORDING_SHA256,
    sizeBytes: 12_345,
    durationSeconds: null,
    ...overrides
  };
}

test('preload exposes only exact sermon identities and never a renderer path', async () => {
  const { api, calls } = loadPreloadBridge();
  await api.attachSermonRecordingForServiceItem({
    ...request(),
    sourcePath: '/private/recording.mp3',
    filePath: '/private/recording.mp3',
    path: '/private/recording.mp3',
    media: { sha256: 'renderer-owned' },
    objectId: 'sha256:renderer-owned',
    kind: 'video',
    status: 'ready',
    url: 'https://renderer.example/recording'
  });
  assert.deepEqual(calls, [{
    channel: 'prepare:projects:attachSermonRecording',
    payload: request()
  }]);
});

test('main owns selection, immutable import, exact repin, and journaled commit', async () => {
  const document = sermon();
  const exactSermonRevision = sermonDocumentSha256(document);
  const linked = linkedProject(document);
  const project = completedPlanningProject(linked.project);
  const { resourceId } = linked;
  const importCalls = [];
  const commits = [];
  const handler = loadHandler({
    async readExpectedProject() {
      return {
        project,
        revisionId: PROJECT_REVISION,
        expectedRevisionId: PROJECT_REVISION,
        recovery: null,
        services: {
          localSermonLibrary: {
            async readCurrent(sermonId) {
              assert.equal(sermonId, document.id);
              return { sermon: document, revision: exactSermonRevision };
            }
          },
          localSermonMediaStore: {
            async importFile(options) {
              importCalls.push(plain(options));
              return {
                objectId: `sha256:${RECORDING_SHA256}`,
                media: {
                  kind: 'audio',
                  mediaType: 'audio/mpeg',
                  fileName: 'Sunday sermon.mp3',
                  sha256: RECORDING_SHA256,
                  sizeBytes: 12_345,
                  durationSeconds: null
                }
              };
            }
          },
          sermonProjectCommitCoordinator: {
            async commit(payload) {
              commits.push(payload);
              return {
                project: {
                  project: payload.project,
                  revisionId: 'd'.repeat(64)
                },
                sermon: {
                  sermon: payload.sermonDocument,
                  revision: sermonDocumentSha256(payload.sermonDocument)
                },
                recovery: null
              };
            }
          }
        }
      };
    },
    dialog: {
      async showOpenDialog(window, options) {
        assert.deepEqual(window, {});
        assert.equal(options.title, 'Preserve Sermon Recording');
        assert.deepEqual(plain(options.filters[0].extensions), [
          'mp3',
          'm4a',
          'mp4'
        ]);
        assert.deepEqual(plain(options.properties), ['openFile']);
        return {
          canceled: false,
          filePaths: ['/main-owned/Sunday sermon.mp3']
        };
      }
    }
  });

  const result = await handler({}, request());
  assert.deepEqual(importCalls, [{
    sourcePath: '/main-owned/Sunday sermon.mp3'
  }]);
  assert.equal(commits.length, 1);
  const committed = commits[0];
  assert.equal(committed.expectedProjectRevisionId, PROJECT_REVISION);
  assert.equal(committed.expectedSermonRevision, exactSermonRevision);
  assert.equal(committed.resourceOwnerId, 'sermon-owner');
  assert.equal(committed.reason, 'attach-sermon-recording');
  assert.equal(committed.project.planning.status, 'completed');
  assert.deepEqual(
    committed.project.planning.readinessWaivers,
    project.planning.readinessWaivers
  );
  assert.notEqual(committed.resourceId, resourceId);
  assert.equal(
    committed.project.items['sermon-owner'].sermonResourceId,
    committed.resourceId
  );
  assert.equal(
    committed.project.items['sermon-child'].sermonResourceId,
    undefined
  );
  const recording = committed.sermonDocument.media.find(media =>
    media.id === 'post-service:recording:en');
  assert.ok(recording);
  assert.equal(recording.status, 'pending');
  assert.equal(recording.url, null);
  assert.equal(recording.sha256, RECORDING_SHA256);
  assert.equal(recording.fileName, 'Sunday sermon.mp3');
  assert.equal(result.project.id, project.id);
  assert.equal(result.sermonId, document.id);
  assert.equal(result.sermonRevisionId, sermonDocumentSha256(
    committed.sermonDocument
  ));
  assert.equal(result.postServiceReadiness.recordingReady, false);
});

test('cancel returns before importing or mutating anything', async () => {
  const document = sermon();
  const exactSermonRevision = sermonDocumentSha256(document);
  const { project } = linkedProject(document);
  let imported = false;
  let committed = false;
  const handler = loadHandler({
    async readExpectedProject() {
      return {
        project,
        revisionId: PROJECT_REVISION,
        expectedRevisionId: PROJECT_REVISION,
        recovery: null,
        services: {
          localSermonLibrary: {
            async readCurrent() {
              return { sermon: document, revision: exactSermonRevision };
            }
          },
          localSermonMediaStore: {
            async importFile() {
              imported = true;
            }
          },
          sermonProjectCommitCoordinator: {
            async commit() {
              committed = true;
            }
          }
        }
      };
    },
    dialog: {
      async showOpenDialog() {
        return { canceled: true, filePaths: [] };
      }
    }
  });
  assert.equal(await handler({}, request()), null);
  assert.equal(imported, false);
  assert.equal(committed, false);
});

test('stale links and publication locks fail before the native picker', async () => {
  const document = sermon();
  const { project } = linkedProject(document);
  let pickerCalls = 0;
  const staleHandler = loadHandler({
    async readExpectedProject() {
      return {
        project,
        revisionId: PROJECT_REVISION,
        expectedRevisionId: PROJECT_REVISION,
        services: {
          localSermonLibrary: {
            async readCurrent() {
              throw new Error('must not read a mismatched link');
            }
          }
        }
      };
    },
    dialog: {
      async showOpenDialog() {
        pickerCalls += 1;
      }
    }
  });
  await assert.rejects(
    staleHandler({}, request({
      expectedSermonRevisionId: 'e'.repeat(64)
    })),
    error => error?.code === 'SERMON_SOURCE_LINK_CHANGED'
  );

  const published = sermon({
    publication: {
      status: 'published',
      visibility: 'public',
      publishedAt: '2026-07-27T20:00:00.000Z',
      canonicalUrl: 'https://church.example/sermons/hear-again'
    }
  });
  const publishedRevision = sermonDocumentSha256(published);
  const linkedPublished = linkedProject(published).project;
  const lockedHandler = loadHandler({
    async readExpectedProject() {
      return {
        project: linkedPublished,
        revisionId: PROJECT_REVISION,
        expectedRevisionId: PROJECT_REVISION,
        services: {
          localSermonLibrary: {
            async readCurrent() {
              return { sermon: published, revision: publishedRevision };
            }
          }
        }
      };
    },
    dialog: {
      async showOpenDialog() {
        pickerCalls += 1;
      }
    }
  });
  await assert.rejects(
    lockedHandler({}, request({
      expectedSermonRevisionId: publishedRevision
    })),
    error => error?.code === 'POST_SERVICE_PUBLICATION_LOCKED'
  );
  assert.equal(pickerCalls, 0);
});

test('a locked sermon can restore only its exact missing device-local recording without a canonical write', async () => {
  const withRecording = attachLocalSermonRecording(
    sermon(),
    localRecordingMedia()
  ).document;
  const published = {
    ...withRecording,
    publication: {
      status: 'published',
      visibility: 'public',
      publishedAt: '2026-07-27T20:00:00.000Z',
      canonicalUrl: 'https://church.example/sermons/hear-again'
    }
  };
  const exactSermonRevision = sermonDocumentSha256(published);
  const { project } = linkedProject(published);
  const restoreCalls = [];
  let committed = false;
  const handler = loadHandler({
    async readExpectedProject() {
      return {
        project,
        revisionId: PROJECT_REVISION,
        expectedRevisionId: PROJECT_REVISION,
        recovery: null,
        services: {
          localSermonLibrary: {
            async readCurrent() {
              return { sermon: published, revision: exactSermonRevision };
            }
          },
          localSermonMediaStore: {
            async checkMedia(media) {
              assert.equal(media.id, 'post-service:recording:en');
              const error = new Error('device-local object is absent');
              error.code = 'OBJECT_NOT_FOUND';
              throw error;
            },
            async restoreFile(options) {
              restoreCalls.push(plain(options));
              return {
                objectId: `sha256:${RECORDING_SHA256}`,
                media: localRecordingMedia()
              };
            }
          },
          sermonProjectCommitCoordinator: {
            async commit() {
              committed = true;
            }
          }
        }
      };
    },
    dialog: {
      async showOpenDialog(_window, options) {
        assert.equal(options.title, 'Restore Exact Sermon Recording');
        return {
          canceled: false,
          filePaths: ['/main-owned/Sunday sermon.mp3']
        };
      }
    }
  });

  const result = await handler({}, request({
    expectedSermonRevisionId: exactSermonRevision
  }));
  assert.deepEqual(restoreCalls, [{
    sourcePath: '/main-owned/Sunday sermon.mp3',
    expectedMedia: localRecordingMedia()
  }]);
  assert.equal(committed, false);
  assert.equal(result.unchanged, true);
  assert.equal(result.revisionId, PROJECT_REVISION);
  assert.equal(result.sermonRevisionId, exactSermonRevision);
  assert.equal(result.localRecordingRestored, true);
  assert.equal(result.project, project);
});

test('an editable missing recording can use a different file and clears stale publication review', async () => {
  const withRecording = attachLocalSermonRecording(
    sermon(),
    localRecordingMedia()
  ).document;
  const ready = {
    ...withRecording,
    media: withRecording.media.map(media => ({
      ...media,
      status: 'ready',
      url: 'https://media.example/old-sermon.mp3'
    })),
    publication: {
      status: 'ready',
      visibility: 'private',
      publishedAt: null,
      canonicalUrl: null
    }
  };
  const exactSermonRevision = sermonDocumentSha256(ready);
  const { project } = linkedProject(ready);
  const replacementSha = 'd'.repeat(64);
  const calls = [];
  const commits = [];
  const handler = loadHandler({
    async readExpectedProject() {
      return {
        project,
        revisionId: PROJECT_REVISION,
        expectedRevisionId: PROJECT_REVISION,
        recovery: null,
        services: {
          localSermonLibrary: {
            async readCurrent() {
              return { sermon: ready, revision: exactSermonRevision };
            }
          },
          localSermonMediaStore: {
            async checkMedia() {
              const error = new Error('device-local object is absent');
              error.code = 'OBJECT_NOT_FOUND';
              throw error;
            },
            async restoreFile() {
              calls.push('restore');
              const error = new Error('different verified bytes');
              error.code = 'MEDIA_RESTORE_MISMATCH';
              throw error;
            },
            async importFile() {
              calls.push('import');
              return {
                objectId: `sha256:${replacementSha}`,
                media: localRecordingMedia({
                  fileName: 'Replacement sermon.mp3',
                  sha256: replacementSha,
                  sizeBytes: 54_321
                })
              };
            }
          },
          sermonProjectCommitCoordinator: {
            async commit(payload) {
              commits.push(payload);
              return {
                project: {
                  project: payload.project,
                  revisionId: 'e'.repeat(64)
                },
                sermon: {
                  sermon: payload.sermonDocument,
                  revision: sermonDocumentSha256(payload.sermonDocument)
                },
                recovery: null
              };
            }
          }
        }
      };
    },
    dialog: {
      async showOpenDialog(_window, options) {
        assert.equal(options.title, 'Restore or Replace Sermon Recording');
        return {
          canceled: false,
          filePaths: ['/main-owned/Replacement sermon.mp3']
        };
      }
    }
  });

  await handler({}, request({
    expectedSermonRevisionId: exactSermonRevision
  }));
  assert.deepEqual(calls, ['restore', 'import']);
  assert.equal(commits.length, 1);
  const next = commits[0].sermonDocument;
  const recording = next.media.find(media =>
    media.id === 'post-service:recording:en');
  assert.equal(recording.sha256, replacementSha);
  assert.equal(recording.fileName, 'Replacement sermon.mp3');
  assert.equal(recording.status, 'pending');
  assert.equal(recording.url, null);
  assert.equal(next.publication.status, 'draft');
});

test('a locked exact-restore mismatch never falls through to import or commit', async () => {
  const withRecording = attachLocalSermonRecording(
    sermon(),
    localRecordingMedia()
  ).document;
  const published = {
    ...withRecording,
    publication: {
      status: 'published',
      visibility: 'public',
      publishedAt: '2026-07-27T20:00:00.000Z',
      canonicalUrl: 'https://church.example/sermons/hear-again'
    }
  };
  const exactSermonRevision = sermonDocumentSha256(published);
  const { project } = linkedProject(published);
  let imported = false;
  let committed = false;
  const handler = loadHandler({
    async readExpectedProject() {
      return {
        project,
        revisionId: PROJECT_REVISION,
        expectedRevisionId: PROJECT_REVISION,
        recovery: null,
        services: {
          localSermonLibrary: {
            async readCurrent() {
              return { sermon: published, revision: exactSermonRevision };
            }
          },
          localSermonMediaStore: {
            async checkMedia() {
              const error = new Error('missing');
              error.code = 'OBJECT_NOT_FOUND';
              throw error;
            },
            async restoreFile() {
              const error = new Error('wrong bytes');
              error.code = 'MEDIA_RESTORE_MISMATCH';
              throw error;
            },
            async importFile() {
              imported = true;
            }
          },
          sermonProjectCommitCoordinator: {
            async commit() {
              committed = true;
            }
          }
        }
      };
    },
    dialog: {
      async showOpenDialog() {
        return {
          canceled: false,
          filePaths: ['/main-owned/Different sermon.mp3']
        };
      }
    }
  });

  await assert.rejects(
    handler({}, request({
      expectedSermonRevisionId: exactSermonRevision
    })),
    error => error?.code === 'MEDIA_RESTORE_MISMATCH'
  );
  assert.equal(imported, false);
  assert.equal(committed, false);
});

test('picker-open revision drift aborts before any exact restore bytes are written', async () => {
  const withRecording = attachLocalSermonRecording(
    sermon(),
    localRecordingMedia()
  ).document;
  const exactSermonRevision = sermonDocumentSha256(withRecording);
  const { project } = linkedProject(withRecording);
  let reads = 0;
  let restored = false;
  const handler = loadHandler({
    async readExpectedProject() {
      reads += 1;
      if (reads > 1) {
        const error = new Error('service revision changed');
        error.code = 'PROJECT_CONFLICT';
        throw error;
      }
      return {
        project,
        revisionId: PROJECT_REVISION,
        expectedRevisionId: PROJECT_REVISION,
        recovery: null,
        services: {
          localSermonLibrary: {
            async readCurrent() {
              return {
                sermon: withRecording,
                revision: exactSermonRevision
              };
            }
          },
          localSermonMediaStore: {
            async checkMedia() {
              const error = new Error('missing');
              error.code = 'OBJECT_NOT_FOUND';
              throw error;
            },
            async restoreFile() {
              restored = true;
            }
          }
        }
      };
    },
    dialog: {
      async showOpenDialog() {
        return {
          canceled: false,
          filePaths: ['/main-owned/Sunday sermon.mp3']
        };
      }
    }
  });

  await assert.rejects(
    handler({}, request({
      expectedSermonRevisionId: exactSermonRevision
    })),
    error => error?.code === 'PROJECT_CONFLICT'
  );
  assert.equal(reads, 2);
  assert.equal(restored, false);
});

test('main wiring keeps the media store private and path-free at the bridge', () => {
  assert.match(
    mainSource,
    /new LocalSermonMediaStore\(\{\s*rootPath: path\.join\(userDataPath, 'sermon-media'\)/
  );
  const source = handlerSource('prepare:projects:attachSermonRecording');
  assert.match(source, /requireExactPrepareKeys\(request,/);
  assert.match(source, /readExpectedProject\(request\)/);
  assert.match(source, /localSermonLibrary\.readCurrent/);
  assert.ok(
    source.indexOf('localSermonLibrary.readCurrent')
      < source.indexOf('dialog.showOpenDialog'),
    'exact sermon state must be checked before opening a native picker'
  );
  assert.match(source, /localSermonMediaStore\.importFile\(\{\s*sourcePath: selected\.filePaths\[0\]/);
  assert.match(source, /localSermonMediaStore\.restoreFile\(\{/);
  assert.match(source, /attachLocalSermonRecording/);
  assert.match(source, /sermonProjectCommitCoordinator\.commit/);
  assert.doesNotMatch(
    preloadSource,
    /attachSermonRecordingForServiceItem[\s\S]{0,500}(?:sourcePath|filePath|objectId|sha256|mediaType)/
  );
});
