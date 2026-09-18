'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const {
  addBibleItem,
  addGroupItem,
  addSermonResource,
  analyzeSermonPrimaryReading,
  createServiceProject,
  isSermonSourceTarget,
  normalizeSermonDocument,
  placeBibleReadingItemsBefore,
  repinSermonRevision,
  resolveSermonSourceLink,
  SERMON_SCHEMA_VERSION,
  sermonDocumentSha256,
  setSermonSourceLink,
  upgradeSermonDocument
} = require('../src/services/project');

const root = path.join(__dirname, '..');
const mainSource = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
const preloadSource = fs.readFileSync(path.join(root, 'preload.js'), 'utf8');
const prepareControllerSource = fs.readFileSync(
  path.join(root, 'src', 'renderer', 'prepare-controller.js'),
  'utf8'
);
const prepareHtmlSource = fs.readFileSync(
  path.join(root, 'src', 'renderer', 'index.html'),
  'utf8'
);
const PROJECT_REVISION = 'a'.repeat(64);

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

function sermonDocument() {
  return {
    schemaVersion: SERMON_SCHEMA_VERSION,
    kind: 'syncshow-sermon',
    id: 'sermon-2026-07-26-prayer',
    titles: { en: 'The Prayer That Transforms the Church' },
    defaultLanguage: 'en',
    speaker: { id: 'paul-lvutin', name: 'Paul Lvutin' },
    serviceDate: '2026-07-26',
    series: null,
    outline: [{
      id: 'foundation',
      parentId: null,
      kind: 'section',
      titles: { en: 'The Foundation of the Prayer' }
    }, {
      id: 'application',
      parentId: null,
      kind: 'section',
      titles: { en: 'The Application of the Prayer' }
    }],
    sources: [{
      id: 'source-original',
      kind: 'manuscript',
      fileName: 'sermon-notes.pdf',
      mediaType: 'application/pdf',
      languages: ['en'],
      sha256: 'c'.repeat(64),
      sizeBytes: 4096,
      provenance: {
        providedBy: 'Paul Lvutin',
        receivedAt: '2026-07-26T15:00:00.000Z',
        sourceSystem: 'manual-file-picker',
        externalId: ''
      }
    }],
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

function sermonDocumentV1() {
  const current = sermonDocument();
  return {
    ...current,
    schemaVersion: 1,
    sources: current.sources.map(source => {
      const { languages, ...rest } = source;
      return {
        ...rest,
        language: languages[0]
      };
    })
  };
}

function loadAttachmentHandler(dependencies = {}) {
  let registeredHandler = null;
  const failMainOperation = (code, message, details = {}) => {
    const error = new Error(message);
    error.code = code;
    error.details = details;
    throw error;
  };
  vm.runInNewContext(handlerSource('prepare:projects:attachSermonSource'), {
    ipcMain: {
      handle(channel, handler) {
        assert.equal(channel, 'prepare:projects:attachSermonSource');
        registeredHandler = handler;
      }
    },
    requireControlSender() {},
    requirePrepareRequest(_request, maximumBytes) {
      assert.equal(maximumBytes, 16 * 1024);
    },
    prepareId(value) {
      return String(value);
    },
    prepareSermonDomainId(value) {
      return String(value);
    },
    prepareRevision(value) {
      return String(value);
    },
    prepareText(value, _label, maximum, options = {}) {
      const result = String(value ?? '').trim();
      if (options.required && !result) throw new Error('missing');
      if (result.length > maximum) throw new Error('too long');
      return result;
    },
    prepareLanguageTags(value) {
      const tags = Array.isArray(value) ? value : [value];
      return [...new Set(tags.map(tag => String(tag).toLowerCase()))].sort();
    },
    failMainOperation,
    failSermonSourceImport(error) {
      throw error;
    },
    isSermonSourceTarget,
    resolveSermonSourceLink,
    controlWindow: {},
    projectItemId(prefix) {
      return `${prefix}-main-owned`;
    },
    addSermonResource,
    repinSermonRevision,
    sermonDocumentSha256,
    setSermonSourceLink,
    upgradeSermonDocument,
    projectResult(result) {
      return {
        project: result.project,
        revisionId: result.revisionId,
        unchanged: result.unchanged === true,
        recovery: result.recovery || null
      };
    },
    console,
    ...dependencies
  }, { filename: 'attach-sermon-source-handler.js' });
  assert.equal(typeof registeredHandler, 'function');
  return registeredHandler;
}

test('Prepare sends same-byte metadata correction only when its checkbox is selected', () => {
  const attachStart = prepareControllerSource.indexOf(
    'async function attachSermonSource(event)'
  );
  const attachEnd = prepareControllerSource.indexOf(
    'async function loadTranslationCandidates',
    attachStart
  );
  assert.ok(attachStart >= 0 && attachEnd > attachStart);
  const attachSource = prepareControllerSource.slice(attachStart, attachEnd);

  assert.match(
    prepareHtmlSource,
    /id="attachSermonSourceUpdateMetadata" type="checkbox"(?![^>]*\bchecked\b)/
  );
  assert.match(
    attachSource,
    /const updateExistingMetadata = elements\.attachSermonSourceUpdateMetadata\.checked;/
  );
  assert.match(attachSource, /providedBy,\s*updateExistingMetadata\s*\}\)/);
});

test('attachment preload forwards only reviewed metadata and semantic identities', async () => {
  const { api, calls } = loadPreloadBridge();
  await api.attachSermonSourceForServiceItem({
    projectId: 'service-2026-07-26',
    expectedRevisionId: PROJECT_REVISION,
    itemId: 'sermon-group',
    sermonId: 'sermon-2026-07-26-prayer',
    expectedSermonRevisionId: 'b'.repeat(64),
    kind: 'manuscript',
    languages: ['en', 'ru'],
    providedBy: 'Paul Lvutin',
    path: '/private/sermon.pdf',
    filePath: '/private/sermon.pdf',
    sourcePath: '/private/sermon.pdf',
    source: { sha256: 'renderer-owned' },
    objectId: 'sha256:renderer-owned',
    receivedAt: '1900-01-01T00:00:00.000Z',
    sourceSystem: 'renderer',
    externalId: '/private/sermon.pdf',
    updateExistingMetadata: true
  });

  assert.deepEqual(calls, [{
    channel: 'prepare:projects:attachSermonSource',
    payload: {
      projectId: 'service-2026-07-26',
      expectedRevisionId: PROJECT_REVISION,
      itemId: 'sermon-group',
      sermonId: 'sermon-2026-07-26-prayer',
      expectedSermonRevisionId: 'b'.repeat(64),
      kind: 'manuscript',
      languages: ['en', 'ru'],
      providedBy: 'Paul Lvutin',
      updateExistingMetadata: true
    }
  }]);
});

test('main owns file selection, immutable import metadata, journaled CAS commit, and path-free errors', () => {
  const services = sourceBetween('function getPrepareServices()', 'async function getCommunityServices()');
  assert.match(
    services,
    /new LocalSermonSourceStore\(\{\s*rootPath: path\.join\(userDataPath, 'sermon-sources'\)/
  );
  assert.match(services, /localSermonSourceStore,/);

  const source = handlerSource('prepare:projects:attachSermonSource');
  assert.match(source, /requireControlSender\(event\)/);
  assert.match(source, /requirePrepareRequest\(request, 16 \* 1024\)/);
  assert.match(source, /readExpectedProject\(request\)/);
  assert.match(source, /isSermonSourceTarget\(current\.project, item\)/);
  assert.match(source, /resolveSermonSourceLink\(current\.project, item\)/);
  assert.match(source, /resolvedSource\.resource\.document\.id !== sermonId/);
  assert.match(source, /resolvedSource\.resource\.sha256 !== expectedSermonRevisionId/);
  assert.match(source, /localSermonLibrary\.readCurrent\(sermonId\)/);
  assert.match(source, /sermonRead\.revision !== expectedSermonRevisionId/);
  assert.ok(
    source.indexOf('localSermonLibrary.readCurrent(sermonId)')
      < source.indexOf('dialog.showOpenDialog(controlWindow'),
    'the current sermon revision must be verified before opening a native dialog'
  );
  assert.match(source, /extensions: \['pdf', 'docx', 'pptx', 'txt', 'md', 'markdown'\]/);
  assert.match(source, /properties: \['openFile'\]/);
  assert.match(source, /sourcePath: selected\.filePaths\[0\]/);
  assert.match(source, /id: projectItemId\('source'\)/);
  assert.match(source, /languages,/);
  assert.match(source, /receivedAt: new Date\(\)\.toISOString\(\)/);
  assert.match(source, /sourceSystem: 'manual-file-picker'/);
  assert.match(source, /source\.sha256 === imported\.source\.sha256/);
  assert.match(source, /existingSourceIndex/);
  assert.match(source, /request\.updateExistingMetadata === true/);
  assert.match(source, /existingSourceIndex >= 0 && !updateExistingMetadata/);
  assert.match(source, /languages: imported\.source\.languages/);
  assert.match(source, /linkedBodyKindChanged/);
  assert.match(source, /entry\.sourceId === correctedSource\.id/);
  assert.match(source, /kind: correctedSource\.kind/);
  assert.match(
    source,
    /linkedBodyKindChanged\s*&& writableSermon\.publication\.status === 'archived'/
  );
  assert.match(
    source,
    /Restore this archived sermon before changing the kind of a source linked to its reviewed body/
  );
  assert.match(source, /\['ready', 'published'\]\.includes\(writableSermon\.publication\.status\)/);
  assert.match(source, /status: 'draft'/);
  assert.match(source, /publishedAt: null/);
  assert.match(source, /const nextSermonRevisionId = sermonDocumentSha256\(nextSermonDocument\)/);
  assert.match(source, /addSermonResource\(current\.project, nextSermonDocument,/);
  assert.match(source, /revision: nextSermonRevisionId/);
  assert.match(source, /repinSermonRevision\(withResource\.project,/);
  assert.match(source, /previousResourceId: resolvedSource\.resourceId/);
  assert.match(source, /nextResourceId: withResource\.resourceId/);
  assert.doesNotMatch(source, /sermonSectionId: resolvedSectionId/);
  assert.match(source, /sermonProjectCommitCoordinator\.commit\(\{/);
  assert.match(source, /project: repinned/);
  assert.match(source, /expectedProjectRevisionId: current\.expectedRevisionId/);
  assert.match(source, /sermonDocument: nextSermonDocument/);
  assert.match(source, /expectedSermonRevision: sermonRead\.revision/);
  assert.match(source, /resourceId: withResource\.resourceId/);
  assert.match(source, /resourceOwnerId: resolvedSource\.resourceOwnerId/);
  assert.match(source, /reason: 'attach-sermon-source'/);
  assert.doesNotMatch(source, /localSermonLibrary\.saveDocument/);
  assert.doesNotMatch(source, /serviceProjectStore\.save/);
  assert.match(source, /const result = projectResult\(committed\.project\)/);
  assert.doesNotMatch(
    source,
    /request\.(?:path|filePath|sourcePath|source|objectId|receivedAt|sourceSystem|externalId)\b/,
    'main must not accept native paths, source records, object ids, or provenance timestamps from the renderer'
  );

  const errorMapper = sourceBetween(
    'function failSermonSourceImport(error)',
    'function projectItemId(prefix)'
  );
  assert.match(errorMapper, /'SERMON_SOURCE_IMPORT_FAILED'/);
  assert.doesNotMatch(errorMapper, /error(?:\?\.|\.)message|error\[['"]message['"]\]/);
  assert.doesNotMatch(errorMapper, /(?:sourcePath|filePath|localPath|absolutePath)/);
});

test('same-byte v1 attachment restores the object without upgrading or creating revisions', async () => {
  const sermon = normalizeSermonDocument(sermonDocumentV1());
  const sermonRevision = sermonDocumentSha256(sermon);
  let project = addGroupItem(createServiceProject({
    id: 'service-v1-restore',
    title: 'V1 Restore Service',
    serviceDate: '2026-07-26',
    profileId: 'main-sanctuary'
  }), {
    id: 'sermon-group',
    title: 'Sermon',
    groupKind: 'sermon'
  });
  const pinned = addSermonResource(project, sermon, {
    provider: 'local-sermon-library',
    itemId: sermon.id,
    revision: sermonRevision
  });
  project = setSermonSourceLink(pinned.project, {
    itemId: 'sermon-group',
    sermonResourceId: pinned.resourceId,
    sermonSectionId: 'foundation'
  });

  const order = [];
  const handler = loadAttachmentHandler({
    async readExpectedProject() {
      order.push('project-read');
      return {
        project,
        projectId: project.id,
        revisionId: PROJECT_REVISION,
        expectedRevisionId: PROJECT_REVISION,
        recovery: null,
        services: {
          localSermonLibrary: {
            async readCurrent() {
              order.push('sermon-read');
              return { sermon, revision: sermonRevision };
            },
            async saveDocument() {
              assert.fail('same-byte restore must not save a sermon revision');
            }
          },
          localSermonSourceStore: {
            async importFile(options) {
              order.push('source-import');
              assert.equal(options.sourcePath, '/main-owned/restore.pdf');
              return {
                objectId: `sha256:${sermon.sources[0].sha256}`,
                source: {
                  id: options.id,
                  kind: options.kind,
                  fileName: 'restore.pdf',
                  mediaType: 'application/pdf',
                  languages: options.languages,
                  sha256: sermon.sources[0].sha256,
                  sizeBytes: sermon.sources[0].sizeBytes,
                  provenance: options.provenance
                }
              };
            }
          },
          serviceProjectStore: {
            async save() {
              assert.fail('same-byte restore must not create a project revision');
            }
          }
        }
      };
    },
    dialog: {
      async showOpenDialog() {
        order.push('dialog');
        return { canceled: false, filePaths: ['/main-owned/restore.pdf'] };
      }
    },
    upgradeSermonDocument() {
      assert.fail('same-byte restore must not upgrade a v1 sermon');
    }
  });

  const result = await handler({ trusted: true }, {
    projectId: project.id,
    expectedRevisionId: PROJECT_REVISION,
    itemId: 'sermon-group',
    sermonId: sermon.id,
    expectedSermonRevisionId: sermonRevision,
    kind: 'slide-notes',
    languages: ['en', 'ru'],
    providedBy: 'Media team'
  });

  assert.deepEqual(order, ['project-read', 'sermon-read', 'dialog', 'source-import']);
  assert.equal(result.project, project);
  assert.equal(result.revisionId, PROJECT_REVISION);
  assert.equal(result.unchanged, true);
  assert.equal(result.project.resources[pinned.resourceId].document.schemaVersion, 1);
  assert.equal(
    result.project.resources[pinned.resourceId].document.sources[0].language,
    'en'
  );
});

test('attachment advances the inherited resource owner while preserving sibling section owners', async () => {
  const sermon = normalizeSermonDocument(sermonDocument());
  const sermonRevision = sermonDocumentSha256(sermon);
  let project = addGroupItem(createServiceProject({
    id: 'service-inherited-attachment',
    title: 'Inherited Attachment Service',
    serviceDate: '2026-07-26',
    profileId: 'main-sanctuary'
  }), {
    id: 'sermon-owner',
    title: 'Sermon',
    groupKind: 'sermon'
  });
  const pinned = addSermonResource(project, sermon, {
    provider: 'local-sermon-library',
    itemId: sermon.id,
    revision: sermonRevision
  });
  project = setSermonSourceLink(pinned.project, {
    itemId: 'sermon-owner',
    sermonResourceId: pinned.resourceId
  });
  project = addGroupItem(project, {
    id: 'foundation-owner',
    title: 'Foundation',
    groupKind: 'point',
    sermonSectionId: 'foundation',
    parentId: 'sermon-owner'
  });
  project = addGroupItem(project, {
    id: 'application-owner',
    title: 'Application',
    groupKind: 'point',
    sermonSectionId: 'application',
    parentId: 'sermon-owner'
  });

  const beforeFoundation = resolveSermonSourceLink(
    project,
    project.items['foundation-owner']
  );
  assert.equal(beforeFoundation.resourceOwnerId, 'sermon-owner');
  assert.equal(beforeFoundation.sectionOwnerId, 'foundation-owner');

  const order = [];
  let savedProject = null;
  let savedSermon = null;
  const nextProjectRevision = 'e'.repeat(64);
  const handler = loadAttachmentHandler({
    async readExpectedProject() {
      order.push('project-read');
      return {
        project,
        projectId: project.id,
        revisionId: PROJECT_REVISION,
        expectedRevisionId: PROJECT_REVISION,
        recovery: null,
        services: {
          localSermonLibrary: {
            async readCurrent() {
              order.push('sermon-read');
              return { sermon, revision: sermonRevision };
            }
          },
          localSermonSourceStore: {
            async importFile(options) {
              order.push('source-import');
              return {
                objectId: `sha256:${'d'.repeat(64)}`,
                source: {
                  id: options.id,
                  kind: options.kind,
                  fileName: 'new-notes.pdf',
                  mediaType: 'application/pdf',
                  languages: options.languages,
                  sha256: 'd'.repeat(64),
                  sizeBytes: 8192,
                  provenance: options.provenance
                }
              };
            }
          },
          sermonProjectCommitCoordinator: {
            async commit(options) {
              order.push('transaction-commit');
              savedSermon = normalizeSermonDocument(options.sermonDocument);
              savedProject = options.project;
              assert.equal(options.expectedProjectRevisionId, PROJECT_REVISION);
              assert.equal(options.expectedSermonRevision, sermonRevision);
              assert.equal(
                options.resourceId,
                `sha256:${sermonDocumentSha256(savedSermon)}`
              );
              assert.equal(options.resourceOwnerId, 'sermon-owner');
              assert.equal(options.reason, 'attach-sermon-source');
              return {
                project: {
                  project: savedProject,
                  revisionId: nextProjectRevision,
                  unchanged: false,
                  recovery: null
                },
                sermon: {
                  sermon: savedSermon,
                  revision: sermonDocumentSha256(savedSermon),
                  unchanged: false
                },
                recovery: null
              };
            }
          }
        }
      };
    },
    dialog: {
      async showOpenDialog() {
        order.push('dialog');
        return { canceled: false, filePaths: ['/main-owned/new-notes.pdf'] };
      }
    }
  });

  const result = await handler({ trusted: true }, {
    projectId: project.id,
    expectedRevisionId: PROJECT_REVISION,
    itemId: 'foundation-owner',
    sermonId: sermon.id,
    expectedSermonRevisionId: sermonRevision,
    kind: 'slide-notes',
    languages: ['en'],
    providedBy: 'Media team'
  });

  assert.deepEqual(order, [
    'project-read',
    'sermon-read',
    'dialog',
    'source-import',
    'transaction-commit'
  ]);
  assert.equal(savedSermon.sources.length, 2);
  assert.equal(savedProject.items['foundation-owner'].sermonResourceId, undefined);
  assert.equal(savedProject.items['application-owner'].sermonResourceId, undefined);
  assert.equal(savedProject.items['foundation-owner'].sermonSectionId, 'foundation');
  assert.equal(savedProject.items['application-owner'].sermonSectionId, 'application');
  assert.equal(savedProject.resources[pinned.resourceId], undefined);

  const foundation = resolveSermonSourceLink(
    savedProject,
    savedProject.items['foundation-owner']
  );
  const application = resolveSermonSourceLink(
    savedProject,
    savedProject.items['application-owner']
  );
  assert.equal(foundation.resource.sha256, sermonDocumentSha256(savedSermon));
  assert.equal(application.resource.sha256, foundation.resource.sha256);
  assert.equal(foundation.resourceOwnerId, 'sermon-owner');
  assert.equal(application.resourceOwnerId, 'sermon-owner');
  assert.equal(foundation.sectionOwnerId, 'foundation-owner');
  assert.equal(application.sectionOwnerId, 'application-owner');
  assert.equal(foundation.sectionId, 'foundation');
  assert.equal(application.sectionId, 'application');
  assert.equal(result.project, savedProject);
  assert.equal(result.revisionId, nextProjectRevision);
  assert.equal(result.unchanged, false);
});

test('attachment coherently re-pins a generated sermon reading without changing its Scripture', async () => {
  const primaryRange = {
    schemaVersion: 1,
    bookId: 'Eph',
    start: { chapter: 3, verse: 14 },
    end: { chapter: 3, verse: 21 }
  };
  const sermon = normalizeSermonDocument({
    ...sermonDocument(),
    references: [{
      id: 'primary-reading',
      range: primaryRange,
      role: 'primary',
      source: 'operator',
      reviewStatus: 'confirmed',
      enteredText: 'Ephesians 3:14-21',
      sourceId: null,
      sectionId: null,
      startOffset: null,
      endOffset: null
    }]
  });
  const sermonRevision = sermonDocumentSha256(sermon);
  let project = addGroupItem(createServiceProject({
    id: 'service-attachment-reading',
    title: 'Attachment Reading Service',
    serviceDate: '2026-07-26',
    profileId: 'main-sanctuary'
  }), {
    id: 'sermon-owner',
    title: 'Sermon',
    groupKind: 'sermon'
  });
  const pinned = addSermonResource(project, sermon, {
    provider: 'local-sermon-library',
    itemId: sermon.id,
    revision: sermonRevision
  });
  project = setSermonSourceLink(pinned.project, {
    itemId: 'sermon-owner',
    sermonResourceId: pinned.resourceId
  });
  const passage = {
    translation: {
      id: 'BSB',
      suggestedCredit: 'Berean Standard Bible'
    },
    bookId: 'Eph',
    book: 'Ephesians',
    chapter: 3,
    verseStart: 14,
    verseEnd: 21,
    reference: 'Ephesians 3:14-21',
    verses: Array.from({ length: 8 }, (_, index) => ({
      number: 14 + index,
      text: `Pinned BSB verse ${14 + index}`
    }))
  };
  project = addBibleItem(project, {
    id: 'sermon-reading',
    title: 'Ephesians 3:14-21 (BSB)',
    range: primaryRange,
    passagesByChannel: Object.fromEntries(
      project.channelIds.map(channelId => [channelId, passage])
    ),
    sermonReading: {
      sermonResourceId: pinned.resourceId,
      referenceId: 'primary-reading',
      translationId: 'BSB',
      chunkIndex: 0,
      chunkCount: 1
    }
  });
  project = placeBibleReadingItemsBefore(project, {
    itemIds: ['sermon-reading'],
    anchorItemId: 'sermon-owner'
  });
  assert.equal(analyzeSermonPrimaryReading(project, {
    itemId: 'sermon-owner',
    referenceId: 'primary-reading',
    translationId: 'BSB'
  }).status, 'ready');

  const originalReadingRange = plain(project.items['sermon-reading'].range);
  const originalPassages = plain(project.items['sermon-reading'].passagesByChannel);
  const nextProjectRevision = 'f'.repeat(64);
  let committedProject = null;
  const handler = loadAttachmentHandler({
    async readExpectedProject() {
      return {
        project,
        projectId: project.id,
        revisionId: PROJECT_REVISION,
        expectedRevisionId: PROJECT_REVISION,
        recovery: null,
        services: {
          localSermonLibrary: {
            async readCurrent() {
              return { sermon, revision: sermonRevision };
            }
          },
          localSermonSourceStore: {
            async importFile(options) {
              return {
                objectId: `sha256:${'d'.repeat(64)}`,
                source: {
                  id: options.id,
                  kind: options.kind,
                  fileName: 'reviewed-slides.pptx',
                  mediaType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
                  languages: options.languages,
                  sha256: 'd'.repeat(64),
                  sizeBytes: 16_384,
                  provenance: options.provenance
                }
              };
            }
          },
          sermonProjectCommitCoordinator: {
            async commit(options) {
              committedProject = options.project;
              const nextRevision = sermonDocumentSha256(options.sermonDocument);
              const nextResourceId = `sha256:${nextRevision}`;

              assert.equal(options.expectedProjectRevisionId, PROJECT_REVISION);
              assert.equal(options.expectedSermonRevision, sermonRevision);
              assert.equal(options.resourceId, nextResourceId);
              assert.equal(options.resourceOwnerId, 'sermon-owner');
              assert.equal(options.reason, 'attach-sermon-source');
              assert.equal(
                committedProject.items['sermon-owner'].sermonResourceId,
                nextResourceId
              );
              assert.equal(
                committedProject.items['sermon-reading'].sermonReading.sermonResourceId,
                nextResourceId
              );
              assert.equal(
                committedProject.resources[pinned.resourceId],
                undefined,
                'the old exact sermon resource must be pruned after every live reference moves'
              );
              assert.deepEqual(
                plain(committedProject.items['sermon-reading'].range),
                originalReadingRange
              );
              assert.deepEqual(
                plain(committedProject.items['sermon-reading'].passagesByChannel),
                originalPassages
              );
              assert.equal(analyzeSermonPrimaryReading(committedProject, {
                itemId: 'sermon-owner',
                referenceId: 'primary-reading',
                translationId: 'BSB'
              }).status, 'ready');

              return {
                project: {
                  project: committedProject,
                  revisionId: nextProjectRevision,
                  unchanged: false,
                  recovery: null
                },
                sermon: {
                  sermon: options.sermonDocument,
                  revision: nextRevision,
                  unchanged: false
                },
                recovery: null
              };
            }
          }
        }
      };
    },
    dialog: {
      async showOpenDialog() {
        return {
          canceled: false,
          filePaths: ['/main-owned/reviewed-slides.pptx']
        };
      }
    }
  });

  const result = await handler({ trusted: true }, {
    projectId: project.id,
    expectedRevisionId: PROJECT_REVISION,
    itemId: 'sermon-owner',
    sermonId: sermon.id,
    expectedSermonRevisionId: sermonRevision,
    kind: 'slide-notes',
    languages: ['en'],
    providedBy: 'Media team'
  });

  assert.equal(result.project, committedProject);
  assert.equal(result.revisionId, nextProjectRevision);
  assert.equal(result.unchanged, false);
});

test('runtime attachment refreshes reviewed same-hash metadata and preserves an exact direct section link', async () => {
  const sermon = normalizeSermonDocument({
    ...sermonDocument(),
    references: [{
      id: 'primary-reading',
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
    publication: {
      status: 'ready',
      visibility: 'members',
      publishedAt: null,
      canonicalUrl: 'https://church.example/sermons/prayer'
    },
    body: [{
      id: 'reviewed-manuscript',
      kind: 'manuscript',
      language: 'en',
      sourceId: 'source-original',
      sectionId: 'foundation',
      text: 'Complete reviewed sermon text.'
    }]
  });
  const sermonRevision = sermonDocumentSha256(sermon);
  let project = addGroupItem(createServiceProject({
    id: 'service-2026-07-26',
    title: 'Sunday Service',
    serviceDate: '2026-07-26',
    profileId: 'main-sanctuary'
  }), {
    id: 'sermon-group',
    title: 'Sermon',
    groupKind: 'sermon'
  });
  const pinned = addSermonResource(project, sermon, {
    provider: 'local-sermon-library',
    itemId: sermon.id,
    revision: sermonRevision
  });
  project = setSermonSourceLink(pinned.project, {
    itemId: 'sermon-group',
    sermonResourceId: pinned.resourceId,
    sermonSectionId: 'foundation'
  });

  const order = [];
  const calls = {};
  let registeredHandler = null;
  const failMainOperation = (code, message, details = {}) => {
    const error = new Error(message);
    error.code = code;
    error.details = details;
    throw error;
  };
  const projectResult = result => ({
    project: result.project,
    revisionId: result.revisionId,
    unchanged: result.unchanged === true,
    recovery: result.recovery || null
  });

  vm.runInNewContext(handlerSource('prepare:projects:attachSermonSource'), {
    ipcMain: {
      handle(channel, handler) {
        assert.equal(channel, 'prepare:projects:attachSermonSource');
        registeredHandler = handler;
      }
    },
    requireControlSender(event) {
      assert.equal(event.trusted, true);
    },
    requirePrepareRequest(_request, maximumBytes) {
      assert.equal(maximumBytes, 16 * 1024);
    },
    async readExpectedProject(request) {
      order.push('project-read');
      assert.equal(request.expectedRevisionId, PROJECT_REVISION);
      return {
        project,
        projectId: project.id,
        revisionId: PROJECT_REVISION,
        expectedRevisionId: PROJECT_REVISION,
        services: {
          localSermonLibrary: {
            async readCurrent(sermonId) {
              order.push('sermon-read');
              assert.equal(sermonId, sermon.id);
              return { sermon, revision: sermonRevision };
            }
          },
          localSermonSourceStore: {
            async importFile(options) {
              order.push('source-import');
              calls.import = plain(options);
              return {
                objectId: `sha256:${'c'.repeat(64)}`,
                source: {
                  ...sermon.sources[0],
                  id: options.id,
                  kind: options.kind,
                  languages: options.languages,
                  provenance: options.provenance
                }
              };
            }
          },
          sermonProjectCommitCoordinator: {
            async commit(options) {
              order.push('transaction-commit');
              const saved = normalizeSermonDocument(options.sermonDocument);
              const revision = sermonDocumentSha256(saved);
              calls.commit = {
                ...plain(options),
                sermonDocument: plain(saved)
              };
              assert.equal(
                saved.sources.length,
                1,
                'the same bytes must not add a second source'
              );
              return {
                project: {
                  project: options.project,
                  revisionId: PROJECT_REVISION,
                  unchanged: true,
                  recovery: null
                },
                sermon: {
                  sermon: saved,
                  revision,
                  unchanged: false
                },
                recovery: null
              };
            }
          }
        }
      };
    },
    prepareId(value) {
      return String(value);
    },
    prepareSermonDomainId(value) {
      return String(value);
    },
    prepareRevision(value) {
      return String(value);
    },
    prepareText(value, _label, maximum, options = {}) {
      const result = String(value ?? '').trim();
      if (options.required && !result) throw new Error('missing');
      if (result.length > maximum) throw new Error('too long');
      return result;
    },
    prepareLanguageTags(value) {
      return [...new Set(value.map(tag => String(tag).toLowerCase()))].sort();
    },
    failMainOperation,
    upgradeSermonDocument,
    failSermonSourceImport(error) {
      throw error;
    },
    isSermonSourceTarget,
    resolveSermonSourceLink,
    dialog: {
      async showOpenDialog() {
        order.push('dialog');
        return { canceled: false, filePaths: ['/main-owned/sermon-notes.pdf'] };
      }
    },
    controlWindow: {},
    projectItemId(prefix) {
      return `${prefix}-main-owned`;
    },
    addSermonResource,
    repinSermonRevision,
    sermonDocumentSha256,
    setSermonSourceLink,
    projectResult,
    console
  }, { filename: 'attach-sermon-source-handler.js' });

  const result = await registeredHandler({ trusted: true }, {
    projectId: project.id,
    expectedRevisionId: PROJECT_REVISION,
    itemId: 'sermon-group',
    sermonId: sermon.id,
    expectedSermonRevisionId: sermonRevision,
    kind: 'slide-notes',
    languages: ['ru', 'EN', 'ru'],
    providedBy: 'Media team',
    updateExistingMetadata: true,
    sourcePath: '/renderer-owned/hostile.pdf'
  });

  assert.deepEqual(order, [
    'project-read',
    'sermon-read',
    'dialog',
    'source-import',
    'transaction-commit'
  ]);
  assert.equal(calls.import.sourcePath, '/main-owned/sermon-notes.pdf');
  assert.equal(calls.import.id, 'source-main-owned');
  assert.equal(calls.import.kind, 'slide-notes');
  assert.deepEqual(calls.import.languages, ['en', 'ru']);
  assert.equal(calls.import.provenance.providedBy, 'Media team');
  assert.equal(calls.import.provenance.sourceSystem, 'manual-file-picker');
  assert.match(
    calls.import.provenance.receivedAt,
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/
  );
  assert.equal(calls.commit.expectedProjectRevisionId, PROJECT_REVISION);
  assert.equal(calls.commit.expectedSermonRevision, sermonRevision);
  assert.equal(calls.commit.resourceOwnerId, 'sermon-group');
  assert.equal(calls.commit.reason, 'attach-sermon-source');
  assert.equal(calls.commit.sermonDocument.sources.length, 1);
  assert.equal(calls.commit.sermonDocument.sources[0].id, 'source-original');
  assert.equal(calls.commit.sermonDocument.sources[0].fileName, 'sermon-notes.pdf');
  assert.equal(calls.commit.sermonDocument.sources[0].kind, 'slide-notes');
  assert.deepEqual(calls.commit.sermonDocument.body, [{
    id: 'reviewed-manuscript',
    kind: 'slide-notes',
    language: 'en',
    sourceId: 'source-original',
    sectionId: 'foundation',
    text: 'Complete reviewed sermon text.'
  }]);
  assert.deepEqual(calls.commit.sermonDocument.publication, {
    status: 'draft',
    visibility: 'members',
    publishedAt: null,
    canonicalUrl: 'https://church.example/sermons/prayer'
  });
  assert.deepEqual(calls.commit.sermonDocument.sources[0].languages, ['en', 'ru']);
  assert.equal(
    calls.commit.sermonDocument.sources[0].provenance.receivedAt,
    '2026-07-26T15:00:00.000Z'
  );
  assert.equal(
    calls.commit.sermonDocument.sources[0].provenance.sourceSystem,
    'manual-file-picker'
  );
  assert.equal(
    calls.commit.sermonDocument.sources[0].provenance.providedBy,
    'Media team'
  );
  const resolved = resolveSermonSourceLink(
    calls.commit.project,
    calls.commit.project.items['sermon-group']
  );
  assert.equal(resolved.resource.document.id, sermon.id);
  assert.equal(
    resolved.resource.sha256,
    sermonDocumentSha256(calls.commit.sermonDocument)
  );
  assert.equal(resolved.sectionId, 'foundation');
  assert.equal(resolved.resourceOwnerId, 'sermon-group');
  assert.equal(resolved.sectionOwnerId, 'sermon-group');
  assert.deepEqual(result, {
    project: calls.commit.project,
    revisionId: PROJECT_REVISION,
    unchanged: true,
    recovery: null
  });
});

test('runtime same-hash kind correction cannot mutate a linked archived body', async () => {
  const sermon = normalizeSermonDocument({
    ...sermonDocument(),
    publication: {
      status: 'archived',
      visibility: 'members',
      publishedAt: null,
      canonicalUrl: 'https://church.example/sermons/prayer'
    },
    body: [{
      id: 'reviewed-manuscript',
      kind: 'manuscript',
      language: 'en',
      sourceId: 'source-original',
      sectionId: 'foundation',
      text: 'Complete archived sermon text.'
    }]
  });
  const sermonRevision = sermonDocumentSha256(sermon);
  let project = addGroupItem(createServiceProject({
    id: 'service-archived-correction',
    title: 'Archived Sermon Service',
    serviceDate: '2026-07-26',
    profileId: 'main-sanctuary'
  }), {
    id: 'sermon-group',
    title: 'Sermon',
    groupKind: 'sermon'
  });
  const pinned = addSermonResource(project, sermon, {
    provider: 'local-sermon-library',
    itemId: sermon.id,
    revision: sermonRevision
  });
  project = setSermonSourceLink(pinned.project, {
    itemId: 'sermon-group',
    sermonResourceId: pinned.resourceId,
    sermonSectionId: 'foundation'
  });

  let commitCalled = false;
  const handler = loadAttachmentHandler({
    async readExpectedProject() {
      return {
        project,
        projectId: project.id,
        revisionId: PROJECT_REVISION,
        expectedRevisionId: PROJECT_REVISION,
        recovery: null,
        services: {
          localSermonLibrary: {
            async readCurrent() {
              return { sermon, revision: sermonRevision };
            }
          },
          localSermonSourceStore: {
            async importFile(options) {
              return {
                objectId: `sha256:${sermon.sources[0].sha256}`,
                source: {
                  ...sermon.sources[0],
                  id: options.id,
                  kind: options.kind,
                  languages: options.languages,
                  provenance: options.provenance
                }
              };
            }
          },
          sermonProjectCommitCoordinator: {
            async commit() {
              commitCalled = true;
              assert.fail('an archived linked body must not be committed');
            }
          }
        }
      };
    },
    dialog: {
      async showOpenDialog() {
        return {
          canceled: false,
          filePaths: ['/main-owned/archived-sermon.pdf']
        };
      }
    }
  });

  await assert.rejects(
    handler({ trusted: true }, {
      projectId: project.id,
      expectedRevisionId: PROJECT_REVISION,
      itemId: 'sermon-group',
      sermonId: sermon.id,
      expectedSermonRevisionId: sermonRevision,
      kind: 'slide-notes',
      languages: ['en'],
      providedBy: 'Media team',
      updateExistingMetadata: true
    }),
    error => {
      assert.equal(error.code, 'ARCHIVED_SERMON');
      assert.match(error.message, /Restore this archived sermon/);
      return true;
    }
  );
  assert.equal(commitCalled, false);
});

test('runtime same-hash kind correction clears a published timestamp without changing its audience or text', async () => {
  const sermon = normalizeSermonDocument({
    ...sermonDocument(),
    references: [{
      id: 'primary-reading',
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
    publication: {
      status: 'published',
      visibility: 'public',
      publishedAt: '2026-07-27T20:00:00.000Z',
      canonicalUrl: 'https://church.example/sermons/prayer'
    },
    body: [{
      id: 'reviewed-manuscript',
      kind: 'manuscript',
      language: 'en',
      sourceId: 'source-original',
      sectionId: 'foundation',
      text: 'Complete published sermon text.'
    }]
  });
  const sermonRevision = sermonDocumentSha256(sermon);
  let project = addGroupItem(createServiceProject({
    id: 'service-published-correction',
    title: 'Published Sermon Service',
    serviceDate: '2026-07-26',
    profileId: 'main-sanctuary'
  }), {
    id: 'sermon-group',
    title: 'Sermon',
    groupKind: 'sermon'
  });
  const pinned = addSermonResource(project, sermon, {
    provider: 'local-sermon-library',
    itemId: sermon.id,
    revision: sermonRevision
  });
  project = setSermonSourceLink(pinned.project, {
    itemId: 'sermon-group',
    sermonResourceId: pinned.resourceId,
    sermonSectionId: 'foundation'
  });

  let committedSermon = null;
  const handler = loadAttachmentHandler({
    async readExpectedProject() {
      return {
        project,
        projectId: project.id,
        revisionId: PROJECT_REVISION,
        expectedRevisionId: PROJECT_REVISION,
        recovery: null,
        services: {
          localSermonLibrary: {
            async readCurrent() {
              return { sermon, revision: sermonRevision };
            }
          },
          localSermonSourceStore: {
            async importFile(options) {
              return {
                objectId: `sha256:${sermon.sources[0].sha256}`,
                source: {
                  ...sermon.sources[0],
                  id: options.id,
                  kind: options.kind,
                  languages: options.languages,
                  provenance: options.provenance
                }
              };
            }
          },
          sermonProjectCommitCoordinator: {
            async commit(options) {
              committedSermon = normalizeSermonDocument(options.sermonDocument);
              return {
                project: {
                  project: options.project,
                  revisionId: PROJECT_REVISION,
                  unchanged: true,
                  recovery: null
                },
                sermon: {
                  sermon: committedSermon,
                  revision: sermonDocumentSha256(committedSermon),
                  unchanged: false
                },
                recovery: null
              };
            }
          }
        }
      };
    },
    dialog: {
      async showOpenDialog() {
        return {
          canceled: false,
          filePaths: ['/main-owned/published-sermon.pdf']
        };
      }
    }
  });

  await handler({ trusted: true }, {
    projectId: project.id,
    expectedRevisionId: PROJECT_REVISION,
    itemId: 'sermon-group',
    sermonId: sermon.id,
    expectedSermonRevisionId: sermonRevision,
    kind: 'slide-notes',
    languages: ['en'],
    providedBy: 'Media team',
    updateExistingMetadata: true
  });

  assert.ok(committedSermon);
  assert.deepEqual(committedSermon.publication, {
    status: 'draft',
    visibility: 'public',
    publishedAt: null,
    canonicalUrl: 'https://church.example/sermons/prayer'
  });
  assert.deepEqual(committedSermon.body, [{
    id: 'reviewed-manuscript',
    kind: 'slide-notes',
    language: 'en',
    sourceId: 'source-original',
    sectionId: 'foundation',
    text: 'Complete published sermon text.'
  }]);
});
