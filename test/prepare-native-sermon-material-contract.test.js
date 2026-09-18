'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsPromises = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');

const {
  addGroupItem,
  addSermonResource,
  createServiceProject,
  isSermonSourceTarget,
  normalizeSermonDocument,
  repinSermonRevision,
  resolveSermonSourceLink,
  sermonDocumentSha256,
  setSermonSourceLink
} = require('../src/services/project');
const {
  LocalSermonSourceStore
} = require('../src/services/sermon/LocalSermonSourceStore');
const {
  NATIVE_SERMON_MATERIAL_REVIEW_STATEMENT_ID,
  applyNativeSermonMaterialCommit,
  buildNativeSermonMaterialProposal: buildNativeSermonMaterialProposalDomain,
  confirmNativeSermonMaterialProposal: confirmNativeSermonMaterialProposalDomain
} = require('../src/services/sermon/NativeSermonMaterialIntake');

const root = path.join(__dirname, '..');
const mainSource = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
const preloadSource = fs.readFileSync(path.join(root, 'preload.js'), 'utf8');
const rendererSource = fs.readFileSync(
  path.join(root, 'src', 'renderer', 'prepare-controller.js'),
  'utf8'
);
const htmlSource = fs.readFileSync(
  path.join(root, 'src', 'renderer', 'index.html'),
  'utf8'
);

function sourceBetween(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  assert.notEqual(start, -1, `${startMarker} must exist`);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.notEqual(end, -1, `${endMarker} must follow ${startMarker}`);
  return source.slice(start, end);
}

function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

function loadPreloadBridge() {
  const calls = [];
  let api = null;
  const ipcRenderer = {
    invoke(channel, payload) {
      calls.push({
        channel,
        payload: JSON.parse(JSON.stringify(payload))
      });
      return Promise.resolve({ ok: true });
    },
    send() {},
    on() {},
    removeListener() {},
    removeAllListeners() {}
  };
  vm.runInNewContext(preloadSource, {
    require(moduleId) {
      if (moduleId === 'electron') {
        return {
          contextBridge: {
            exposeInMainWorld(name, value) {
              if (name === 'api') api = value;
            }
          },
          ipcRenderer
        };
      }
      throw new Error(`Unexpected preload dependency: ${moduleId}`);
    },
    console,
    TextEncoder
  }, { filename: path.join(root, 'preload.js') });
  assert.ok(api);
  return { api, calls };
}

function loadMainHandler(dependencies = {}) {
  let handler = null;
  const source = sourceBetween(
    mainSource,
    "ipcMain.handle('prepare:projects:saveSermonText'",
    "ipcMain.handle('prepare:projects:attachSermonSource'"
  );
  const failMainOperation = (code, message, details = {}) => {
    const error = new Error(message);
    error.code = code;
    error.details = details;
    throw error;
  };
  vm.runInNewContext(source, {
    ipcMain: {
      handle(channel, registered) {
        assert.equal(channel, 'prepare:projects:saveSermonText');
        handler = registered;
      }
    },
    requireControlSender() {},
    requirePrepareRequest(value, maximumBytes) {
      assert.ok(value && typeof value === 'object');
      assert.equal(maximumBytes, (3 * 1024 * 1024) + (64 * 1024));
      assert.ok(Buffer.byteLength(JSON.stringify(value), 'utf8') <= maximumBytes);
    },
    requireExactPrepareKeys(value, keys) {
      assert.deepEqual(Object.keys(value).sort(), [...keys].sort());
    },
    prepareId: value => String(value),
    prepareSermonDomainId: value => String(value),
    prepareRevision: value => String(value),
    prepareText(value, _field, maximum, options = {}) {
      const text = String(value ?? '').trim();
      if (options.required && !text) throw new Error('required');
      if (text.length > maximum) throw new Error('too long');
      return text;
    },
    failMainOperation,
    failNativeSermonMaterialIntake(error) {
      throw error;
    },
    failSermonSourceImport(error) {
      throw error;
    },
    isSermonSourceTarget,
    resolveSermonSourceLink,
    NATIVE_SERMON_MATERIAL_REVIEW_STATEMENT_ID,
    applyNativeSermonMaterialCommit,
    buildNativeSermonMaterialProposal(value) {
      return buildNativeSermonMaterialProposalDomain(
        JSON.parse(JSON.stringify(value))
      );
    },
    confirmNativeSermonMaterialProposal(proposal, sermon, confirmation) {
      return confirmNativeSermonMaterialProposalDomain(
        proposal,
        sermon,
        JSON.parse(JSON.stringify(confirmation))
      );
    },
    sameNativeSermonMaterialSource(actual, expected) {
      return JSON.stringify(actual) === JSON.stringify({
        id: expected.id,
        kind: expected.kind,
        fileName: expected.fileName,
        mediaType: expected.mediaType,
        languages: expected.languages,
        sha256: expected.sha256,
        sizeBytes: expected.sizeBytes,
        provenance: expected.provenance
      });
    },
    addSermonResource,
    repinSermonRevision,
    projectResult(result) {
      return {
        project: result.project,
        revisionId: result.revisionId,
        unchanged: result.unchanged === true,
        recovery: result.recovery || null,
        readiness: null
      };
    },
    Map,
    console,
    ...dependencies
  }, { filename: 'save-native-sermon-material-handler.js' });
  assert.equal(typeof handler, 'function');
  return handler;
}

function sermonDocument(overrides = {}) {
  return normalizeSermonDocument({
    schemaVersion: 3,
    kind: 'syncshow-sermon',
    id: 'sermon-native-material',
    titles: { en: 'Native Sermon Material' },
    defaultLanguage: 'en',
    speaker: { id: null, name: 'Pastor Example' },
    serviceDate: '2026-08-02',
    series: null,
    outline: [],
    sources: [],
    references: [{
      id: 'primary-john',
      range: {
        schemaVersion: 1,
        bookId: 'John',
        start: { chapter: 3, verse: 16 },
        end: { chapter: 3, verse: 17 }
      },
      role: 'primary',
      source: 'operator',
      reviewStatus: 'confirmed',
      enteredText: 'John 3:16-17',
      sourceId: null,
      sectionId: null,
      startOffset: null,
      endOffset: null
    }],
    body: [],
    media: [],
    publication: {
      status: 'draft',
      visibility: 'private',
      publishedAt: null,
      canonicalUrl: null
    },
    ...overrides
  });
}

test('linked sermons expose paste-first native material intake with file attachment as fallback', () => {
  assert.match(
    htmlSource,
    /id="btnAttachSermonSource"[^>]*>Add sermon material<\/button>/
  );
  const nativeSection = sourceBetween(
    htmlSource,
    'id="attachSermonTextTitle"',
    'id="attachSermonFileTitle"'
  );
  assert.match(nativeSection, /Paste reviewed text/);
  assert.match(
    nativeSection,
    /id="attachSermonManuscriptText"[^>]*maxlength="1048576"/
  );
  assert.match(
    nativeSection,
    /id="attachSermonSlideNotesText"[^>]*maxlength="1048576"/
  );
  assert.match(nativeSection, /id="attachSermonTextLanguage"/);
  assert.match(nativeSection, /id="attachSermonTextConfirmed" type="checkbox"/);
  assert.match(nativeSection, /I reviewed the complete pasted text and its language/);
  assert.match(nativeSection, /id="btnSaveSermonText"/);
  assert.doesNotMatch(nativeSection, /PowerPoint|PPTX|presentation set/i);

  const fallbackSection = sourceBetween(
    htmlSource,
    'id="attachSermonFileTitle"',
    'id="attachSermonSourceError"'
  );
  assert.match(fallbackSection, /Preserve a source file instead/);
  assert.match(fallbackSection, /legacy slide-note deck/);
  assert.match(fallbackSection, /id="attachSermonSourceKind"/);
  assert.match(fallbackSection, /id="attachSermonSourceLanguage"/);
  assert.match(fallbackSection, /id="attachSermonSourceProvidedBy"/);
  assert.match(
    htmlSource,
    /type="button" id="btnConfirmAttachSermonSource"/
  );
});

test('preload bounds pasted text and forwards only semantic exact-revision fields', async () => {
  const { api, calls } = loadPreloadBridge();
  await api.saveSermonTextForServiceItem({
    projectId: 'service-native',
    expectedRevisionId: 'a'.repeat(64),
    itemId: 'sermon-group',
    sermonId: 'sermon-native',
    expectedSermonRevisionId: 'b'.repeat(64),
    language: 'en',
    manuscript: 'Complete manuscript.',
    slideNotes: 'Slide one\nSlide two',
    confirmed: true,
    sourcePath: '/private/manuscript.docx',
    objectId: 'sha256:renderer-owned',
    publication: 'published',
    source: { injected: true }
  });
  assert.deepEqual(calls, [{
    channel: 'prepare:projects:saveSermonText',
    payload: {
      projectId: 'service-native',
      expectedRevisionId: 'a'.repeat(64),
      itemId: 'sermon-group',
      sermonId: 'sermon-native',
      expectedSermonRevisionId: 'b'.repeat(64),
      language: 'en',
      manuscript: 'Complete manuscript.',
      slideNotes: 'Slide one\nSlide two',
      confirmed: true
    }
  }]);

  await api.saveSermonTextForServiceItem({
    manuscript: 'x'.repeat((1024 * 1024) + 1),
    slideNotes: '',
    confirmed: false
  });
  assert.equal(calls[1].payload.manuscript, null);
  assert.equal(calls[1].payload.confirmed, false);
});

test('renderer requires bounded reviewed text and continues directly to native slide building', () => {
  const draft = sourceBetween(
    rendererSource,
    'function sermonMaterialTextDraft()',
    'function openAttachSermonSourceDialog()'
  );
  assert.match(draft, /SERMON_BODY_LANGUAGE_PATTERN/);
  assert.match(draft, /MAX_SERMON_BODY_ENTRY_BYTES/);
  assert.match(draft, /MAX_SERMON_BODY_BYTES/);
  assert.match(draft, /Paste the pastor manuscript, the sermon slide notes, or both/);
  assert.match(
    draft,
    /function updateSermonMaterialTextDraft\(event\)[\s\S]*attachSermonTextLanguage[\s\S]*attachSermonManuscriptText[\s\S]*attachSermonSlideNotesText[\s\S]*attachSermonTextConfirmed\.checked = false/
  );
  assert.match(
    rendererSource,
    /attachSermonSourceForm\.addEventListener\(\s*'input',\s*updateSermonMaterialTextDraft\s*\)/
  );

  const save = sourceBetween(
    rendererSource,
    'async function saveSermonText()',
    'async function attachSermonSource(event)'
  );
  assert.match(save, /elements\.attachSermonTextConfirmed\.checked !== true/);
  assert.match(save, /api\.saveSermonTextForServiceItem\(\{/);
  assert.match(save, /expectedRevisionId: state\.revisionId/);
  assert.match(save, /expectedSermonRevisionId: linked\.resource\.sha256/);
  assert.match(save, /manuscript: draft\.manuscript/);
  assert.match(save, /slideNotes: draft\.slideNotes/);
  assert.match(save, /confirmed: true/);
  assert.match(save, /onError: message => setDialogError\(/);
  assert.match(save, /material\.unchanged === true/);
  assert.match(save, /material\.replacedRoles/);
  assert.match(save, /await loadSermons\(\)/);
  assert.match(save, /elements\.btnBuildNativeSermonSlides\.focus\(\)/);
  assert.match(
    rendererSource,
    /btnConfirmAttachSermonSource\.addEventListener\(\s*'click',\s*attachSermonSource\s*\)/
  );

  const create = sourceBetween(
    rendererSource,
    'async function createSermonPacket(event)',
    'function selectedLinkedSermonServiceSourcesContext()'
  );
  assert.match(create, /if \(!proposal\) \{\s*openAttachSermonSourceDialog\(\)/);
});

test('main owns canonicalization, private storage, exact repin, and one journaled commit', () => {
  const handler = sourceBetween(
    mainSource,
    "ipcMain.handle('prepare:projects:saveSermonText'",
    "ipcMain.handle('prepare:projects:attachSermonSource'"
  );
  assert.match(handler, /requireControlSender\(event\)/);
  assert.match(
    handler,
    /requirePrepareRequest\(request, \(3 \* 1024 \* 1024\) \+ \(64 \* 1024\)\)/
  );
  assert.match(handler, /requireExactPrepareKeys\(request, \[/);
  assert.match(handler, /readExpectedProject\(request\)/);
  assert.match(handler, /resolveSermonSourceLink\(current\.project, item\)/);
  assert.match(handler, /localSermonLibrary\.readCurrent/);
  assert.match(handler, /buildNativeSermonMaterialProposal\(\{/);
  assert.match(handler, /confirmNativeSermonMaterialProposal\(/);
  assert.match(handler, /applyNativeSermonMaterialCommit\(/);
  assert.match(handler, /localSermonSourceStore\.importText\(\{/);
  assert.match(handler, /addSermonResource\(/);
  assert.match(handler, /repinSermonRevision\(/);
  assert.match(handler, /sermonProjectCommitCoordinator\.commit\(\{/);
  assert.match(handler, /expectedProjectRevisionId: current\.expectedRevisionId/);
  assert.match(handler, /expectedSermonRevision: sermonRead\.revision/);
  assert.match(handler, /reason: application\.transaction\.reason/);
  assert.doesNotMatch(
    handler,
    /request\.(?:sourcePath|filePath|objectId|publication|source)\b/
  );
  assert.doesNotMatch(handler, /community/i);

  const escapedBoundaryText = '\\'.repeat(768 * 1024);
  const escapedBoundaryRequest = {
    projectId: 'service',
    expectedRevisionId: 'a'.repeat(64),
    itemId: 'sermon',
    sermonId: 'sermon',
    expectedSermonRevisionId: 'b'.repeat(64),
    language: 'en',
    manuscript: escapedBoundaryText,
    slideNotes: escapedBoundaryText,
    confirmed: true
  };
  assert.equal(
    Buffer.byteLength(escapedBoundaryText, 'utf8') * 2,
    1.5 * 1024 * 1024
  );
  assert.ok(
    Buffer.byteLength(JSON.stringify(escapedBoundaryRequest), 'utf8')
      > (2 * 1024 * 1024) + (32 * 1024)
  );
  assert.ok(
    Buffer.byteLength(JSON.stringify(escapedBoundaryRequest), 'utf8')
      <= (3 * 1024 * 1024) + (64 * 1024)
  );
});

test('main runtime saves, re-pins, replaces, and no-ops pasted material through exact CAS', async t => {
  const sourceRoot = await fsPromises.mkdtemp(
    path.join(os.tmpdir(), 'syncshow-native-sermon-material-main-')
  );
  t.after(() => fsPromises.rm(sourceRoot, { recursive: true, force: true }));
  const sourceStore = new LocalSermonSourceStore({ rootPath: sourceRoot });
  let currentSermon = sermonDocument();
  let project = addGroupItem(createServiceProject({
    id: 'service-native-material',
    title: 'Native Material Service',
    serviceDate: '2026-08-02',
    profileId: 'main-sanctuary'
  }), {
    id: 'sermon-group',
    title: 'Sermon',
    groupKind: 'sermon'
  });
  const pinned = addSermonResource(project, currentSermon, {
    provider: 'local-sermon-library',
    itemId: currentSermon.id,
    revision: sermonDocumentSha256(currentSermon)
  });
  project = setSermonSourceLink(pinned.project, {
    itemId: 'sermon-group',
    sermonResourceId: pinned.resourceId
  });

  let projectRevision = 'a'.repeat(64);
  let commitCount = 0;
  let sourceImportCount = 0;
  const commitReasons = [];
  const handler = loadMainHandler({
    async readExpectedProject(request) {
      assert.equal(request.expectedRevisionId, projectRevision);
      return {
        project,
        projectId: project.id,
        revisionId: projectRevision,
        expectedRevisionId: projectRevision,
        recovery: null,
        services: {
          localSermonLibrary: {
            async readCurrent(sermonId) {
              assert.equal(sermonId, currentSermon.id);
              return {
                sermon: currentSermon,
                revision: sermonDocumentSha256(currentSermon)
              };
            }
          },
          localSermonSourceStore: {
            async importText(options) {
              sourceImportCount += 1;
              return sourceStore.importText(options);
            }
          },
          sermonProjectCommitCoordinator: {
            async commit(options) {
              assert.equal(
                options.expectedProjectRevisionId,
                projectRevision
              );
              assert.equal(
                options.expectedSermonRevision,
                sermonDocumentSha256(currentSermon)
              );
              assert.equal(options.resourceOwnerId, 'sermon-group');
              commitCount += 1;
              commitReasons.push(options.reason);
              project = options.project;
              currentSermon = options.sermonDocument;
              projectRevision = String(commitCount + 1).repeat(64);
              return {
                project: {
                  project,
                  revisionId: projectRevision,
                  recovery: null
                },
                sermon: {
                  sermon: currentSermon,
                  revision: sermonDocumentSha256(currentSermon)
                },
                recovery: null
              };
            }
          }
        }
      };
    }
  });

  function request(overrides = {}) {
    return {
      projectId: project.id,
      expectedRevisionId: projectRevision,
      itemId: 'sermon-group',
      sermonId: currentSermon.id,
      expectedSermonRevisionId: sermonDocumentSha256(currentSermon),
      language: 'en',
      manuscript: 'Complete pastor manuscript.\n\nApplication.',
      slideNotes: 'Title\nMain point\nApplication',
      confirmed: true,
      ...overrides
    };
  }

  const added = await handler({ trusted: true }, request());
  assert.equal(commitCount, 1);
  assert.equal(sourceImportCount, 2);
  assert.deepEqual(plain(added.material), {
    addedRoles: ['manuscript', 'slide-notes'],
    replacedRoles: [],
    unchangedRoles: [],
    unchanged: false
  });
  assert.equal(currentSermon.sources.length, 2);
  assert.equal(currentSermon.body.length, 2);
  assert.deepEqual(
    currentSermon.body.map(entry => entry.kind),
    ['manuscript', 'slide-notes']
  );
  for (const source of currentSermon.sources) {
    assert.deepEqual(
      await sourceStore.readSource(source),
      Buffer.from(
        currentSermon.body.find(entry => entry.sourceId === source.id).text,
        'utf8'
      )
    );
  }
  assert.equal(
    resolveSermonSourceLink(project, project.items['sermon-group'])
      .resource.sha256,
    sermonDocumentSha256(currentSermon)
  );

  const replaced = await handler({ trusted: true }, request({
    manuscript: 'Revised complete pastor manuscript.',
    slideNotes: ''
  }));
  assert.equal(commitCount, 2);
  assert.equal(sourceImportCount, 3);
  assert.deepEqual(plain(replaced.material), {
    addedRoles: [],
    replacedRoles: ['manuscript'],
    unchangedRoles: [],
    unchanged: false
  });
  assert.equal(currentSermon.sources.length, 2);
  assert.equal(currentSermon.body.length, 2);
  assert.equal(
    currentSermon.body.find(entry => entry.kind === 'manuscript').text,
    'Revised complete pastor manuscript.'
  );
  assert.equal(
    currentSermon.body.find(entry => entry.kind === 'slide-notes').text,
    'Title\nMain point\nApplication'
  );

  const unchanged = await handler({ trusted: true }, request({
    manuscript: 'Revised complete pastor manuscript.',
    slideNotes: ''
  }));
  assert.equal(commitCount, 2);
  assert.equal(sourceImportCount, 3);
  assert.equal(unchanged.unchanged, true);
  assert.deepEqual(plain(unchanged.material), {
    addedRoles: [],
    replacedRoles: [],
    unchangedRoles: ['manuscript'],
    unchanged: true
  });
  assert.deepEqual(commitReasons, [
    'add-native-sermon-material',
    'add-native-sermon-material'
  ]);
});
