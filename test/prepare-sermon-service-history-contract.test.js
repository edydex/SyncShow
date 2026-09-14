'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const mainSource = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
const preloadSource = fs.readFileSync(path.join(root, 'preload.js'), 'utf8');
const controllerPath = path.join(root, 'src', 'renderer', 'prepare-controller.js');
const controllerSource = fs.readFileSync(controllerPath, 'utf8');
const htmlSource = fs.readFileSync(
  path.join(root, 'src', 'renderer', 'index.html'),
  'utf8'
);
const REVISION = 'a'.repeat(64);
const PROJECT_REVISION = 'b'.repeat(64);

function plain(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function sourceBetween(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  assert.notEqual(start, -1, `${startMarker} must be implemented`);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.notEqual(end, -1, `${endMarker} must follow ${startMarker}`);
  return source.slice(start, end);
}

function relationship(overrides = {}) {
  return {
    schemaVersion: 1,
    sermonId: 'sermon-2026-07-26-prayer',
    sermonRevisionId: REVISION,
    pinnedSermonRevisionIds: [REVISION],
    projectId: 'service-2026-07-26',
    projectRevision: 3,
    projectRevisionId: PROJECT_REVISION,
    projectTitle: 'Sunday Service',
    serviceDate: '2026-07-26',
    updatedAt: '2026-07-26T20:00:00.000Z',
    profileId: 'main-sanctuary',
    workflowMode: 'pptx-companion',
    anchorItemId: 'sermon-anchor',
    resourceOwnerId: 'sermon-anchor',
    sourceServiceSet: {
      id: 'set-2026-07-26',
      fingerprint: 'c'.repeat(64),
      serviceDate: '2026-07-26',
      profileId: 'main-sanctuary'
    },
    linkedItemCount: 1,
    resourceOwnerCount: 1,
    ...overrides
  };
}

function openedRelationshipProject(overrides = {}) {
  const exactRelationship = relationship();
  const resourceId = `sha256:${REVISION}`;
  const project = {
    id: exactRelationship.projectId,
    rootItemIds: [exactRelationship.anchorItemId],
    items: {
      [exactRelationship.anchorItemId]: {
        id: exactRelationship.anchorItemId,
        kind: 'group',
        groupKind: 'sermon',
        title: 'Sermon',
        childIds: [],
        sermonResourceId: resourceId
      }
    },
    resources: {
      [resourceId]: {
        id: resourceId,
        kind: 'sermon',
        sha256: exactRelationship.sermonRevisionId,
        document: {
          id: exactRelationship.sermonId
        }
      }
    }
  };
  return {
    project,
    revisionId: exactRelationship.projectRevisionId,
    recovery: null,
    ...overrides
  };
}

function pinnedRevisions(count) {
  return [
    REVISION,
    ...Array.from(
      { length: count - 1 },
      (_unused, index) => (index + 1).toString(16).padStart(64, '0')
    )
  ];
}

function hasLocalPath(value) {
  if (typeof value === 'string') {
    return value.includes('/private/')
      || value.includes('/Users/')
      || /^[A-Za-z]:[\\/]/.test(value);
  }
  if (!value || typeof value !== 'object') return false;
  return Object.values(value).some(hasLocalPath);
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
  }, { filename: path.join(root, 'preload.js') });
  assert.ok(api);
  return { api, calls };
}

function rendererExports() {
  const window = {};
  vm.runInNewContext(
    controllerSource,
    { console, window },
    { filename: controllerPath }
  );
  return window.SyncShowPrepare;
}

test('preload grants only bounded sermon-service relationship fields', async () => {
  const { api, calls } = loadPreloadBridge();
  await api.listSermonServiceRelationships({
    sermonId: 'sermon-2026-07-26-prayer',
    pageSize: 20,
    offset: 40,
    projectId: 'renderer-chosen-project',
    path: '/private/services'
  });

  assert.deepEqual(calls, [{
    channel: 'prepare:sermons:listServices',
    payload: {
      sermonId: 'sermon-2026-07-26-prayer',
      pageSize: 20,
      offset: 40
    }
  }]);
});

test('main lists path-free current service relationships behind strict trust and paging', async () => {
  const source = sourceBetween(
    mainSource,
    "ipcMain.handle('prepare:sermons:listServices'",
    "ipcMain.handle('prepare:sermons:outline'"
  );
  let registered = null;
  let storeCall = null;
  const failMainOperation = (code, message) => {
    const error = new Error(message);
    error.code = code;
    throw error;
  };
  vm.runInNewContext(source, {
    ipcMain: {
      handle(channel, handler) {
        assert.equal(channel, 'prepare:sermons:listServices');
        registered = handler;
      }
    },
    requireControlSender(event) {
      if (event?.trusted !== true) {
        failMainOperation('UNTRUSTED_SENDER', 'Untrusted sender.');
      }
    },
    requirePrepareRequest(value, maximumBytes) {
      assert.equal(maximumBytes, 4 * 1024);
      assert.equal(typeof value, 'object');
    },
    requireExactPrepareKeys(value, allowedKeys) {
      const allowed = new Set(allowedKeys);
      if (Object.keys(value).some(key => !allowed.has(key))) {
        failMainOperation('UNSUPPORTED_PREPARE_FIELDS', 'Unsupported fields.');
      }
    },
    prepareSermonDomainId(value) {
      if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(String(value || ''))) {
        failMainOperation('INVALID_PREPARE_ID', 'Invalid sermon.');
      }
      return value;
    },
    MAX_SERMON_RELATIONSHIP_PAGE_SIZE: 100,
    failMainOperation,
    getPrepareServices() {
      return {
        serviceProjectStore: {
          async listSermonServiceRelationships(sermonId, options) {
            storeCall = { sermonId, options: plain(options) };
            return {
              items: [{
                ...relationship(),
                path: '/private/project.json',
                document: { sources: [{ fileName: '/private/manuscript.pdf' }] }
              }],
              total: 1,
              offset: options.offset,
              nextOffset: null
            };
          }
        }
      };
    }
  }, { filename: 'prepare-sermon-service-history-handler.js' });

  assert.equal(typeof registered, 'function');
  await assert.rejects(
    registered({ trusted: false }, {
      sermonId: 'sermon-2026-07-26-prayer',
      pageSize: 20,
      offset: 0
    }),
    error => error.code === 'UNTRUSTED_SENDER'
  );
  await assert.rejects(
    registered({ trusted: true }, {
      sermonId: 'sermon-2026-07-26-prayer',
      pageSize: 20,
      offset: 0,
      path: '/private/project.json'
    }),
    error => error.code === 'UNSUPPORTED_PREPARE_FIELDS'
  );
  await assert.rejects(
    registered({ trusted: true }, {
      sermonId: 'sermon-2026-07-26-prayer',
      pageSize: 101,
      offset: 0
    }),
    error => error.code === 'INVALID_SERMON_SERVICE_PAGE'
  );
  assert.equal(storeCall, null);

  const result = plain(await registered({ trusted: true }, {
    sermonId: 'sermon-2026-07-26-prayer',
    pageSize: 20,
    offset: 0
  }));
  assert.deepEqual(storeCall, {
    sermonId: 'sermon-2026-07-26-prayer',
    options: { pageSize: 20, offset: 0 }
  });
  assert.equal(result.items.length, 1);
  assert.equal(hasLocalPath(result), false);
  assert.equal(Object.hasOwn(result.items[0], 'document'), false);
  assert.deepEqual(Object.keys(result.items[0]).sort(), [
    'anchorItemId',
    'linkedItemCount',
    'pinnedSermonRevisionIds',
    'profileId',
    'projectId',
    'projectRevision',
    'projectRevisionId',
    'projectTitle',
    'resourceOwnerCount',
    'resourceOwnerId',
    'schemaVersion',
    'sermonId',
    'sermonRevisionId',
    'serviceDate',
    'sourceServiceSet',
    'updatedAt',
    'workflowMode'
  ]);
});

test('renderer normalizes relationship projections without retaining extra data', () => {
  const { normalizeSermonServiceRelationship } = rendererExports();
  const normalized = plain(normalizeSermonServiceRelationship({
    ...relationship(),
    path: '/private/project.json',
    document: { sources: [{ fileName: '/private/manuscript.pdf' }] }
  }));

  assert.equal(hasLocalPath(normalized), false);
  assert.deepEqual(normalized, relationship());
  assert.throws(
    () => normalizeSermonServiceRelationship(
      relationship({ projectRevisionId: 'not-a-revision' })
    ),
    /Service revision was invalid/
  );
  assert.throws(
    () => normalizeSermonServiceRelationship(relationship({
      sourceServiceSet: {
        ...relationship().sourceServiceSet,
        serviceDate: '2026-08-02'
      }
    })),
    /Source service binding was invalid/
  );
});

test('renderer preserves bounded mixed-revision relationships without truncation', () => {
  const { normalizeSermonServiceRelationship } = rendererExports();
  assert.match(
    controllerSource,
    /const MAX_SERMON_SERVICE_PINNED_REVISIONS = 2000;/
  );

  for (const count of [101, 2000]) {
    const revisions = pinnedRevisions(count);
    const normalized = normalizeSermonServiceRelationship(relationship({
      pinnedSermonRevisionIds: revisions
    }));
    assert.equal(normalized.pinnedSermonRevisionIds.length, count);
    assert.deepEqual(
      plain(normalized.pinnedSermonRevisionIds),
      revisions
    );
  }

  assert.throws(
    () => normalizeSermonServiceRelationship(relationship({
      pinnedSermonRevisionIds: pinnedRevisions(2001)
    })),
    /Pinned sermon revisions were invalid/
  );
  assert.throws(
    () => normalizeSermonServiceRelationship(relationship({
      pinnedSermonRevisionIds: [REVISION, REVISION]
    })),
    /Pinned sermon revisions were inconsistent/
  );
  assert.throws(
    () => normalizeSermonServiceRelationship(relationship({
      pinnedSermonRevisionIds: ['f'.repeat(64)]
    })),
    /Pinned sermon revisions were inconsistent/
  );
});

test('stale Used-in-services rows are rejected before the current project can change', () => {
  const {
    applyProjectResultAfterValidation,
    validateSermonServiceRelationshipOpenResult
  } = rendererExports();
  const expected = relationship();
  const priorProject = { id: 'service-already-open' };
  let currentProject = priorProject;
  let applyCount = 0;
  const apply = result => {
    applyCount += 1;
    currentProject = result.project;
    return result;
  };
  const accept = result => applyProjectResultAfterValidation(
    result,
    candidate => validateSermonServiceRelationshipOpenResult(
      candidate,
      expected
    ),
    apply
  );
  const valid = openedRelationshipProject();
  const staleResults = [
    {
      ...valid,
      project: {
        ...valid.project,
        id: 'another-service'
      }
    },
    {
      ...valid,
      revisionId: 'd'.repeat(64)
    },
    {
      ...valid,
      project: {
        ...valid.project,
        items: {}
      }
    },
    {
      ...valid,
      project: {
        ...valid.project,
        resources: {
          ...valid.project.resources,
          [`sha256:${REVISION}`]: {
            ...valid.project.resources[`sha256:${REVISION}`],
            document: { id: 'another-sermon' }
          }
        }
      }
    },
    {
      ...valid,
      project: {
        ...valid.project,
        resources: {
          ...valid.project.resources,
          [`sha256:${REVISION}`]: {
            ...valid.project.resources[`sha256:${REVISION}`],
            sha256: 'e'.repeat(64)
          }
        }
      }
    }
  ];

  for (const stale of staleResults) {
    assert.throws(
      () => accept(stale),
      /changed after this list was loaded/
    );
    assert.equal(applyCount, 0);
    assert.equal(currentProject, priorProject);
  }

  assert.equal(accept(valid), valid);
  assert.equal(applyCount, 1);
  assert.equal(currentProject, valid.project);
});

test('Prepare renders lazy stale-safe history and verifies the exact anchor before opening', () => {
  for (const id of [
    'prepareSermonServices',
    'prepareSermonServicesHeading',
    'prepareSermonServicesStatus',
    'prepareSermonServicesList',
    'btnLoadMoreSermonServices'
  ]) {
    assert.match(htmlSource, new RegExp(`id="${id}"`));
  }
  assert.match(htmlSource, />Used in services</);
  assert.match(htmlSource, /Not linked to a saved service yet|Choose an exact sermon packet/);

  const loadSource = sourceBetween(
    controllerSource,
    'async function loadSelectedSermonServiceRelationships',
    'async function openSermonServiceRelationship'
  );
  assert.match(loadSource, /api\.listSermonServiceRelationships\(\{/);
  assert.match(loadSource, /request !== state\.sermonServiceRelationshipRequest/);
  assert.match(loadSource, /current\?\.key !== context\.key/);
  assert.match(loadSource, /\.map\(normalizeSermonServiceRelationship\)/);
  assert.match(loadSource, /unique\.set\(relationship\.projectId, relationship\)/);

  const renderSource = sourceBetween(
    controllerSource,
    'function renderSermonServiceRelationships',
    'async function loadSelectedSermonServiceRelationships'
  );
  assert.match(renderSource, /Retry load more/);
  assert.match(
    renderSource,
    /sermonServiceRelationshipError[\s\S]*sermonServiceRelationships\.length < 1/
  );
  assert.match(
    renderSource,
    /already-loaded[\s\S]*services remain[\s\S]*retry to load the next page/
  );

  const openSource = sourceBetween(
    controllerSource,
    'async function openSermonServiceRelationship',
    'function resetSermonCommunityState'
  );
  assert.match(openSource, /openProject\(\s*relationship\.projectId/);
  assert.match(openSource, /validateBeforeApply\(result\)/);
  assert.match(
    openSource,
    /validateSermonServiceRelationshipOpenResult\(\s*result,\s*relationship/
  );

  const validationSource = sourceBetween(
    controllerSource,
    'function validateSermonServiceRelationshipOpenResult',
    'function applyProjectResultAfterValidation'
  );
  assert.match(validationSource, /project\.id !== relationship\.projectId/);
  assert.match(
    validationSource,
    /result\.revisionId !== relationship\.projectRevisionId/
  );
  assert.match(validationSource, /relationship\.anchorItemId/);
  assert.match(
    validationSource,
    /sermonIdOf\(linked\.resource\.document\) !== relationship\.sermonId/
  );
  assert.match(
    validationSource,
    /linked\.resource\.sha256 !== relationship\.sermonRevisionId/
  );
  assert.match(validationSource, /Nothing was guessed/);

  const projectOpenSource = sourceBetween(
    controllerSource,
    'async function openProject',
    'async function mutateProject'
  );
  assert.ok(
    projectOpenSource.indexOf('applyProjectResultAfterValidation')
      < projectOpenSource.indexOf('state.selectedItemId ='),
    'a relationship validator must run before opened project state is selected'
  );
  assert.doesNotMatch(openSource, /\.innerHTML\s*=/);
});
