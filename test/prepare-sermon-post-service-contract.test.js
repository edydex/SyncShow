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
  createServiceProject,
  isSermonSourceTarget,
  normalizeServiceProject,
  planSermonPostServiceLinks,
  repinCompatibleSermonDocument,
  resolveSermonSourceLink,
  sermonDocumentSha256,
  setSermonSourceLink
} = require('../src/services/project');

const root = path.join(__dirname, '..');
const mainSource = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
const preloadSource = fs.readFileSync(path.join(root, 'preload.js'), 'utf8');
const controllerSource = fs.readFileSync(
  path.join(root, 'src', 'renderer', 'prepare-controller.js'),
  'utf8'
);
const html = fs.readFileSync(
  path.join(root, 'src', 'renderer', 'index.html'),
  'utf8'
);
const css = fs.readFileSync(
  path.join(root, 'src', 'renderer', 'styles.css'),
  'utf8'
);
const PROJECT_REVISION = 'a'.repeat(64);

function plain(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function uniqueIdCount(id) {
  return (html.match(new RegExp(`id="${id}"`, 'g')) || []).length;
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
      if (moduleId !== 'electron') throw new Error(`Unexpected dependency ${moduleId}`);
      return {
        contextBridge: {
          exposeInMainWorld(name, value) {
            if (name === 'api') api = value;
          }
        },
        ipcRenderer: {
          invoke(channel, payload) {
            calls.push({ channel, payload: plain(payload) });
            return Promise.resolve({ ok: true });
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
  return { api, calls };
}

function prepareExports() {
  const window = {};
  vm.runInNewContext(controllerSource, { console, URL, window }, {
    filename: 'prepare-controller.js'
  });
  return window.SyncShowPrepare;
}

function sermon() {
  return {
    schemaVersion: SERMON_SCHEMA_VERSION,
    kind: 'syncshow-sermon',
    id: 'sermon-post-service-contract',
    titles: { en: 'A sermon to revisit' },
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
    }
  };
}

function inheritedProject(document = sermon()) {
  let project = createServiceProject({
    id: 'service-post-service-contract',
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

function followUpPlanningProject(project) {
  const raw = plain(project);
  raw.planning = {
    schemaVersion: 1,
    status: 'needs-follow-up',
    startTime: '10:30',
    templateSource: {
      projectId: 'service-post-service-template',
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
    handlerSource('prepare:projects:reviewSermonPostServiceLinks'),
    {
      ipcMain: {
        handle(channel, handler) {
          assert.equal(channel, 'prepare:projects:reviewSermonPostServiceLinks');
          registered = handler;
        }
      },
      requireControlSender() {},
      requirePrepareRequest(_request, maximum) {
        assert.equal(maximum, 12 * 1024);
      },
      requireExactPrepareKeys(value, allowed) {
        const supported = new Set(allowed);
        if (Object.keys(value).some(key => !supported.has(key))) {
          failMainOperation(
            'UNSUPPORTED_PREPARE_FIELDS',
            'Post-service sermon review contains unsupported fields.'
          );
        }
      },
      prepareId: value => String(value),
      prepareSermonDomainId: value => String(value),
      prepareRevision: value => String(value),
      prepareText(value, _label, maximum, options = {}) {
        const normalized = String(value ?? '').trim();
        if (options.required && !normalized) throw new Error('missing');
        if (normalized.length > maximum) throw new Error('too long');
        return normalized;
      },
      preparePostServiceLinkSlot(raw) {
        if (raw === null || raw === undefined) return null;
        return {
          kind: String(raw.kind),
          status: String(raw.status),
          url: String(raw.url || '')
        };
      },
      failMainOperation,
      isSermonSourceTarget,
      resolveSermonSourceLink,
      planSermonPostServiceLinks,
      sermonDocumentSha256,
      analyzeSermonPostServiceReadiness,
      addSermonResource,
      repinCompatibleSermonDocument,
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
    { filename: 'review-sermon-post-service-links-handler.js' }
  );
  assert.equal(typeof registered, 'function');
  return registered;
}

test('post-service card and dialog keep local review before explicit Community sharing', () => {
  for (const id of [
    'prepareSermonPostService',
    'prepareSermonPostServiceBadge',
    'prepareSermonPostServicePageState',
    'prepareSermonPostServiceRecordingState',
    'prepareSermonPostServiceBodyState',
    'prepareSermonPostServiceTextState',
    'btnReviewSermonPostService',
    'btnMarkSermonPostServiceReady',
    'sermonPostServiceDialog',
    'sermonPostServiceCanonicalUrl',
    'sermonPostServiceRecordingUrl',
    'sermonPostServiceTextUrl',
    'btnSaveSermonPostService'
  ]) {
    assert.equal(uniqueIdCount(id), 1, `${id} must be unique`);
  }
  const cardAt = html.indexOf('id="prepareSermonPostService"');
  const communityAt = html.indexOf('id="prepareSermonCommunity"');
  assert.ok(cardAt > html.indexOf('id="prepareSermonReadingStatus"'));
  assert.ok(cardAt < communityAt);
  const dialog = html.slice(
    html.indexOf('<dialog id="sermonPostServiceDialog"'),
    html.indexOf('</dialog>', html.indexOf('<dialog id="sermonPostServiceDialog"')) + 9
  );
  assert.match(dialog, /aria-labelledby="sermonPostServiceTitle"/);
  assert.match(dialog, /aria-describedby="sermonPostServiceDescription"/);
  assert.match(dialog, /<fieldset class="prepare-sermon-post-service-fieldset">/);
  assert.match(dialog, /complete sermon text was already reviewed in SyncShow/);
  assert.match(dialog, /Reviewed canonical sermon text can supply the revisit content/);
  assert.match(dialog, /Nothing is uploaded, published, or sent to Community/);
  assert.match(dialog, /stable public HTTPS link/);
  assert.match(
    dialog,
    /no sign-in details, query string, fragment, IP\/private host, or nonstandard port/
  );
  assert.match(
    dialog,
    /temporary or signed link may be saved only while this record remains Draft/
  );
  assert.match(dialog, /will not count as Ready for Community/);
  assert.match(dialog, /SyncShow does not test whether the website is reachable/);
  assert.match(html, /<dt>Reviewed sermon text<\/dt>/);
  assert.match(html, /<dt>External notes \/ transcript<\/dt>/);
  assert.match(html, /Ready means this reviewed record can be saved to Community\. It does not publish/);
  assert.match(css, /\.prepare-sermon-post-service/);
  assert.match(css, /\.prepare-sermon-post-service-states/);

  const saveStart = controllerSource.indexOf(
    'async function saveSermonPostServiceLinks'
  );
  const saveEnd = controllerSource.indexOf(
    'async function markSelectedSermonPostServiceReady',
    saveStart
  );
  const markEnd = controllerSource.indexOf(
    'function selectedSermonExtractionContext',
    saveEnd
  );
  const save = controllerSource.slice(saveStart, saveEnd);
  const mark = controllerSource.slice(saveEnd, markEnd);
  assert.match(save, /sermonPostServiceDialogIntent\('save-draft'\)/);
  assert.match(mark, /'mark-ready'/);
  assert.doesNotMatch(save, /pushCommunitySermon/);
  assert.doesNotMatch(mark, /pushCommunitySermon/);
});

test('preload forwards only narrow scalar link intent', async () => {
  const { api, calls } = loadPreloadBridge();
  await api.reviewSermonPostServiceLinksForServiceItem({
    projectId: 'service-one',
    expectedRevisionId: PROJECT_REVISION,
    itemId: 'sermon-child',
    sermonId: 'sermon-one',
    expectedSermonRevisionId: 'b'.repeat(64),
    action: 'mark-ready',
    canonicalUrl: 'https://church.example/sermon',
    recording: {
      kind: 'audio',
      status: 'ready',
      url: 'https://media.example.org/sermon.mp3',
      id: 'renderer-owned',
      sha256: 'c'.repeat(64),
      filePath: '/private/recording.mp3'
    },
    text: {
      kind: 'document',
      status: 'pending',
      url: '',
      title: 'renderer-owned'
    },
    publication: { status: 'published', visibility: 'public' },
    publishedAt: '1900-01-01T00:00:00.000Z',
    media: [{ id: 'renderer-owned' }],
    resourceOwnerId: 'renderer-owned',
    document: { id: 'renderer-owned' }
  });
  assert.deepEqual(calls, [{
    channel: 'prepare:projects:reviewSermonPostServiceLinks',
    payload: {
      projectId: 'service-one',
      expectedRevisionId: PROJECT_REVISION,
      itemId: 'sermon-child',
      sermonId: 'sermon-one',
      expectedSermonRevisionId: 'b'.repeat(64),
      action: 'mark-ready',
      canonicalUrl: 'https://church.example/sermon',
      recording: {
        kind: 'audio',
        status: 'ready',
        url: 'https://media.example.org/sermon.mp3'
      },
      text: {
        kind: 'document',
        status: 'pending',
        url: ''
      }
    }
  }]);
});

test('renderer derives visible waiting, attention, reviewed, and ready states from exact records', () => {
  const {
    sermonPostServiceManagedSlots,
    sermonPostServiceState
  } = prepareExports();
  const draft = sermon();
  assert.deepEqual(plain(sermonPostServiceState(draft)), {
    linked: true,
    page: 'waiting',
    recording: 'waiting',
    reviewedBody: 'waiting',
    text: 'waiting',
    confirmedPrimary: true,
    revisitContentReady: false,
    prerequisitesReady: false,
    ready: false,
    publicationStatus: 'draft',
    visibility: 'private',
    managed: { recording: null, text: null }
  });

  const reviewed = {
    ...draft,
    media: [{
      id: 'post-service:recording:en',
      kind: 'audio',
      status: 'ready',
      title: 'Sermon audio',
      language: 'en',
      url: 'https://media.example.org/sermon.mp3'
    }, {
      id: 'unrelated-document',
      kind: 'document',
      status: 'failed',
      title: 'Old notes',
      language: 'en',
      url: 'https://church.example.org/old-notes'
    }],
    publication: {
      ...draft.publication,
      canonicalUrl: 'https://church.example/sermon'
    }
  };
  const reviewedState = sermonPostServiceState(reviewed);
  assert.equal(reviewedState.page, 'available');
  assert.equal(reviewedState.recording, 'available');
  assert.equal(reviewedState.reviewedBody, 'waiting');
  assert.equal(reviewedState.text, 'attention');
  assert.equal(reviewedState.revisitContentReady, true);
  assert.equal(reviewedState.prerequisitesReady, true);
  assert.equal(reviewedState.ready, false);
  assert.equal(
    sermonPostServiceManagedSlots(reviewed).recording.id,
    'post-service:recording:en'
  );
  assert.equal(sermonPostServiceManagedSlots(reviewed).text, null);

  const ready = sermonPostServiceState({
    ...reviewed,
    publication: {
      ...reviewed.publication,
      status: 'ready'
    }
  });
  assert.equal(ready.ready, true);

  const reviewedBody = sermonPostServiceState({
    ...draft,
    body: [{
      id: 'reviewed-manuscript-en',
      kind: 'manuscript',
      language: 'en',
      sourceId: null,
      sectionId: null,
      text: 'Complete reviewed sermon text.'
    }],
    media: [{
      id: 'post-service:recording:en',
      kind: 'audio',
      status: 'ready',
      title: 'Sermon audio',
      language: 'en',
      url: 'https://media.example.org/sermon.mp3'
    }]
  });
  assert.equal(reviewedBody.page, 'waiting');
  assert.equal(reviewedBody.text, 'waiting');
  assert.equal(reviewedBody.reviewedBody, 'available');
  assert.equal(reviewedBody.revisitContentReady, true);
  assert.equal(reviewedBody.prerequisitesReady, true);

  const insecure = sermonPostServiceState({
    ...reviewed,
    publication: {
      ...reviewed.publication,
      canonicalUrl: 'http://church.example/sermon'
    },
    media: reviewed.media.map(media => media.id === 'post-service:recording:en'
      ? { ...media, url: 'http://media.example/sermon.mp3' }
      : media)
  });
  assert.equal(insecure.page, 'attention');
  assert.equal(insecure.recording, 'attention');
  assert.equal(insecure.reviewedBody, 'waiting');
  assert.equal(insecure.prerequisitesReady, false);
});

test('main validates exact revisions and uses the journaled coherent repin without Community writes', () => {
  const source = handlerSource('prepare:projects:reviewSermonPostServiceLinks');
  assert.match(source, /requireControlSender\(event\)/);
  assert.match(source, /requirePrepareRequest\(request, 12 \* 1024\)/);
  assert.match(source, /requireExactPrepareKeys\(request,/);
  assert.match(source, /readExpectedProject\(request\)/);
  assert.match(source, /resolveSermonSourceLink\(current\.project, item\)/);
  assert.match(source, /linked\.resource\.document\.id !== sermonId/);
  assert.match(source, /linked\.resource\.sha256 !== expectedSermonRevisionId/);
  assert.match(source, /localSermonLibrary\.readCurrent\(sermonId\)/);
  assert.match(source, /sermonRead\.revision !== expectedSermonRevisionId/);
  assert.match(source, /planSermonPostServiceLinks\(sermonRead\.sermon,/);
  assert.match(source, /repinCompatibleSermonDocument\(\s*current\.project,\s*reviewed\.document,/);
  assert.match(source, /previousResourceId: linked\.resourceId/);
  assert.match(source, /resourceId: repinned\.resourceId/);
  assert.match(source, /resourceOwnerId: linked\.resourceOwnerId/);
  assert.match(source, /sermonProjectCommitCoordinator\.commit\(\{/);
  assert.match(source, /expectedProjectRevisionId: current\.expectedRevisionId/);
  assert.match(source, /expectedSermonRevision: sermonRead\.revision/);
  assert.doesNotMatch(
    source,
    /pushCommunitySermon|CommunitySermonSync|\bfetch\s*\(|https?\.(?:get|request)|shell\.openExternal/
  );
  assert.doesNotMatch(
    source,
    /request\.(?:publication|visibility|publishedAt|media|document|resourceId|resourceOwnerId|path|filePath|sha256)\b/
  );
});

test('handler re-pins an inherited owner and marks reviewed body plus recording ready without external text links', async () => {
  const document = {
    ...sermon(),
    body: [{
      id: 'reviewed-manuscript-en',
      kind: 'manuscript',
      language: 'en',
      sourceId: null,
      sectionId: null,
      text: 'The complete sermon text reviewed by an operator.'
    }]
  };
  const inherited = inheritedProject(document);
  const project = followUpPlanningProject(inherited.project);
  const { resourceId } = inherited;
  const sermonRevision = sermonDocumentSha256(document);
  const order = [];
  let commitOptions = null;
  const handler = loadHandler({
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
              return { sermon: document, revision: sermonRevision };
            }
          },
          sermonProjectCommitCoordinator: {
            async commit(options) {
              order.push('transaction-commit');
              commitOptions = options;
              return {
                project: {
                  project: options.project,
                  revisionId: 'd'.repeat(64),
                  unchanged: false,
                  recovery: null
                },
                sermon: {
                  sermon: options.sermonDocument,
                  revision: sermonDocumentSha256(options.sermonDocument)
                },
                recovery: null
              };
            }
          }
        }
      };
    }
  });

  const result = await handler({}, {
    projectId: project.id,
    expectedRevisionId: PROJECT_REVISION,
    itemId: 'sermon-child',
    sermonId: document.id,
    expectedSermonRevisionId: sermonRevision,
    action: 'mark-ready',
    canonicalUrl: null,
    recording: {
      kind: 'audio',
      status: 'ready',
      url: 'https://media.example.org/sermons/revisit.mp3'
    },
    text: null
  });

  assert.deepEqual(order, ['project-read', 'sermon-read', 'transaction-commit']);
  assert.equal(commitOptions.resourceOwnerId, 'sermon-owner');
  assert.equal(commitOptions.expectedProjectRevisionId, PROJECT_REVISION);
  assert.equal(commitOptions.expectedSermonRevision, sermonRevision);
  assert.equal(commitOptions.reason, 'mark-sermon-post-service-ready');
  assert.equal(commitOptions.project.planning.status, 'needs-follow-up');
  assert.deepEqual(
    commitOptions.project.planning.readinessWaivers,
    project.planning.readinessWaivers
  );
  assert.equal(
    commitOptions.project.items['sermon-owner'].sermonResourceId,
    commitOptions.resourceId
  );
  assert.equal(
    commitOptions.project.items['sermon-child'].sermonResourceId,
    undefined
  );
  assert.equal(commitOptions.project.resources[resourceId], undefined);
  assert.equal(commitOptions.sermonDocument.publication.status, 'ready');
  assert.equal(commitOptions.sermonDocument.publication.visibility, 'private');
  assert.equal(commitOptions.sermonDocument.publication.publishedAt, null);
  assert.equal(result.postServiceReadiness.ready, true);
  assert.equal(result.postServiceReadiness.reviewedBodyReady, true);
  assert.equal(result.postServiceReadiness.pageReady, false);
  assert.equal(result.postServiceReadiness.textReady, false);
});

test('identical draft intent performs no project or sermon write', async () => {
  const document = sermon();
  const { project } = inheritedProject(document);
  const sermonRevision = sermonDocumentSha256(document);
  const handler = loadHandler({
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
              return { sermon: document, revision: sermonRevision };
            }
          },
          sermonProjectCommitCoordinator: {
            async commit() {
              assert.fail('an identical review must not write');
            }
          }
        }
      };
    }
  });
  const result = await handler({}, {
    projectId: project.id,
    expectedRevisionId: PROJECT_REVISION,
    itemId: 'sermon-owner',
    sermonId: document.id,
    expectedSermonRevisionId: sermonRevision,
    action: 'save-draft',
    canonicalUrl: '',
    recording: null,
    text: null
  });
  assert.equal(result.unchanged, true);
  assert.equal(result.revisionId, PROJECT_REVISION);
  assert.equal(result.sermonRevisionId, sermonRevision);
});

test('main rejects unsupported renderer-owned fields before reading mutable state', async () => {
  let read = false;
  const handler = loadHandler({
    async readExpectedProject() {
      read = true;
      assert.fail('unsupported fields must fail before state reads');
    }
  });
  await assert.rejects(
    handler({}, {
      projectId: 'service-one',
      expectedRevisionId: PROJECT_REVISION,
      itemId: 'sermon-owner',
      sermonId: 'sermon-one',
      expectedSermonRevisionId: 'b'.repeat(64),
      action: 'save-draft',
      canonicalUrl: '',
      recording: null,
      text: null,
      publication: { status: 'published' }
    }),
    error => error.code === 'UNSUPPORTED_PREPARE_FIELDS'
  );
  assert.equal(read, false);
});
