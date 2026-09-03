'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  POWERPOINT_COMPANION_WORKFLOW_MODE,
  ServiceProjectError,
  addGroupItem,
  addProjectItem,
  addSermonResource,
  addSongResource,
  bindProjectAsPowerPointCompanion,
  compileServiceProject,
  createServiceProject,
  isPowerPointCompanionProject,
  normalizeServiceProject,
  removeProjectItemAndDescendants,
  serializeServiceProject,
  setSermonSourceLink,
  updateGroupItem
} = require('../src/services/project');
const {
  parseSongDocument
} = require('../src/services/project/SongDocument');
const {
  ProjectExchangeError,
  ServiceProjectExchange
} = require('../src/services/project/ServiceProjectExchange');

const NOW = '2026-07-26T16:00:00.000Z';

const EXPECTED_NATIVE_BYTES = `{
  "schemaVersion": 1,
  "kind": "syncshow-service-project",
  "id": "service-2026-07-26",
  "title": "Sunday Service",
  "serviceDate": "2026-07-26",
  "createdAt": "2026-07-26T16:00:00.000Z",
  "updatedAt": "2026-07-26T16:00:00.000Z",
  "revision": 0,
  "preferredProfileId": "main-sanctuary",
  "channelIds": [
    "primary",
    "secondary",
    "media"
  ],
  "channels": {
    "media": {
      "id": "media",
      "label": "Singers",
      "language": "und"
    },
    "primary": {
      "id": "primary",
      "label": "Primary",
      "language": "und"
    },
    "secondary": {
      "id": "secondary",
      "label": "Secondary",
      "language": "und"
    }
  },
  "rootItemIds": [],
  "items": {},
  "resources": {},
  "assets": {},
  "presetPack": {
    "id": "main-sanctuary",
    "sha256": null,
    "version": 1
  }
}
`;

function freshProject() {
  return createServiceProject({
    id: 'service-2026-07-26',
    title: 'Sunday Service',
    serviceDate: '2026-07-26',
    profileId: 'main-sanctuary',
    now: NOW
  });
}

function binding(overrides = {}) {
  return {
    id: 'set-2026-07-26-main',
    fingerprint: 'a'.repeat(64),
    serviceDate: '2026-07-26',
    profileId: 'main-sanctuary',
    ...overrides
  };
}

function sermonDocument() {
  return {
    schemaVersion: 2,
    kind: 'syncshow-sermon',
    id: 'sermon-prayer',
    titles: { en: 'The Prayer That Transforms the Church' },
    defaultLanguage: 'en',
    speaker: { id: null, name: 'Pastor Example' },
    serviceDate: '2026-07-26',
    series: null,
    outline: [],
    sources: [],
    references: [{
      id: 'primary-eph-3-14-21',
      range: {
        schemaVersion: 1,
        bookId: 'Eph',
        start: { chapter: 3, verse: 14 },
        end: { chapter: 3, verse: 21 }
      },
      role: 'primary',
      source: 'pastor',
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
}

function expectProjectCode(code, callback) {
  assert.throws(callback, error => {
    assert.ok(error instanceof ServiceProjectError);
    assert.equal(error.code, code);
    return true;
  });
}

function companionProject() {
  const project = addGroupItem(freshProject(), {
    id: 'sermon-anchor',
    title: 'Sermon',
    groupKind: 'sermon',
    now: NOW
  });
  return bindProjectAsPowerPointCompanion(project, binding());
}

test('native projects omit workflow mode and retain the pre-companion serialized bytes', () => {
  const project = freshProject();
  const serialized = serializeServiceProject(project);

  assert.equal(project.workflowMode, undefined);
  assert.equal(Object.hasOwn(project, 'workflowMode'), false);
  assert.equal(serialized, EXPECTED_NATIVE_BYTES);
  assert.doesNotMatch(serialized, /workflowMode/);
  assert.equal(isPowerPointCompanionProject(project), false);
  assert.equal(
    serializeServiceProject(normalizeServiceProject(JSON.parse(serialized), { now: NOW })),
    serialized
  );
});

test('PowerPoint companions require an exact service-set binding and round-trip group-only state', () => {
  const unbound = JSON.parse(serializeServiceProject(freshProject()));
  unbound.workflowMode = POWERPOINT_COMPANION_WORKFLOW_MODE;
  expectProjectCode(
    'COMPANION_SERVICE_SET_REQUIRED',
    () => normalizeServiceProject(unbound, { now: NOW })
  );

  const companion = companionProject();
  assert.equal(companion.workflowMode, POWERPOINT_COMPANION_WORKFLOW_MODE);
  assert.equal(isPowerPointCompanionProject(companion), true);
  assert.deepEqual(companion.sourceServiceSet, binding());
  assert.deepEqual(companion.rootItemIds, ['sermon-anchor']);
  assert.equal(companion.items['sermon-anchor'].kind, 'group');
  assert.deepEqual(companion.resources, {});
  assert.deepEqual(companion.assets, {});
  assert.deepEqual(
    bindProjectAsPowerPointCompanion(companion, binding()),
    companion
  );

  const serialized = serializeServiceProject(companion);
  const roundTrip = normalizeServiceProject(JSON.parse(serialized), { now: NOW });
  assert.equal(roundTrip.workflowMode, POWERPOINT_COMPANION_WORKFLOW_MODE);
  assert.deepEqual(roundTrip.sourceServiceSet, binding());
  assert.equal(serializeServiceProject(roundTrip), serialized);
});

test('companion mode survives group, resource, and sermon-link mutations', () => {
  const renamed = updateGroupItem(companionProject(), {
    itemId: 'sermon-anchor',
    title: 'Sermon: The Prayer That Transforms the Church',
    operatorNotes: 'The projected slides remain in the reviewed PowerPoint service set.',
    now: '2026-07-26T16:05:00.000Z'
  });
  assert.equal(renamed.workflowMode, POWERPOINT_COMPANION_WORKFLOW_MODE);

  const pinned = addSermonResource(renamed, sermonDocument(), {
    provider: 'local-sermon-library',
    itemId: 'sermon-prayer',
    revision: 'reviewed-revision-17'
  });
  assert.equal(pinned.project.workflowMode, POWERPOINT_COMPANION_WORKFLOW_MODE);
  assert.equal(pinned.project.resources[pinned.resourceId].kind, 'sermon');

  const linked = setSermonSourceLink(pinned.project, {
    itemId: 'sermon-anchor',
    sermonResourceId: pinned.resourceId,
    now: '2026-07-26T16:10:00.000Z'
  });
  assert.equal(linked.workflowMode, POWERPOINT_COMPANION_WORKFLOW_MODE);
  assert.equal(linked.items['sermon-anchor'].sermonResourceId, pinned.resourceId);
  assert.equal(isPowerPointCompanionProject(linked), true);
});

test('companions fail closed when projected leaves or native compilation are attempted', () => {
  const companion = companionProject();
  expectProjectCode(
    'COMPANION_PROJECTED_ITEMS_NOT_ALLOWED',
    () => addProjectItem(companion, {
      id: 'unsafe-blank',
      kind: 'blank',
      title: 'Blank',
      channelIds: ['primary', 'secondary', 'media'],
      presetId: 'blank-black',
      operatorNotes: ''
    }, { now: NOW })
  );
  expectProjectCode(
    'COMPANION_PROJECT_NOT_PUBLISHABLE',
    () => compileServiceProject(companion)
  );

  const rawWithNativeAsset = JSON.parse(serializeServiceProject(companion));
  const sha256 = 'b'.repeat(64);
  rawWithNativeAsset.assets[`sha256:${sha256}`] = {
    id: `sha256:${sha256}`,
    kind: 'document',
    sha256,
    fileName: 'sermon-notes.pdf',
    storedName: `${sha256}.pdf`,
    mediaType: 'application/pdf',
    size: 1024,
    createdAt: NOW,
    attribution: '',
    altText: ''
  };
  expectProjectCode(
    'COMPANION_ASSETS_NOT_ALLOWED',
    () => normalizeServiceProject(rawWithNativeAsset, { now: NOW })
  );
});

test('companions retain one top-level sermon anchor and sermon resources only', () => {
  const companion = companionProject();
  expectProjectCode(
    'COMPANION_SERMON_ANCHOR_REQUIRED',
    () => addGroupItem(companion, {
      id: 'second-group',
      title: 'Another section',
      groupKind: 'section',
      now: NOW
    })
  );
  expectProjectCode(
    'COMPANION_SERMON_ANCHOR_REQUIRED',
    () => updateGroupItem(companion, {
      itemId: 'sermon-anchor',
      groupKind: 'section',
      now: NOW
    })
  );
  expectProjectCode(
    'COMPANION_SERMON_ANCHOR_REQUIRED',
    () => removeProjectItemAndDescendants(companion, 'sermon-anchor')
  );

  const song = parseSongDocument([
    '---',
    'id: not-a-companion-resource',
    'title: Not a companion resource',
    'language: en',
    'license: Public domain',
    '---',
    '^1',
    'This resource must not enter the sermon handoff.'
  ].join('\n'));
  expectProjectCode(
    'COMPANION_SERMON_RESOURCES_ONLY',
    () => addSongResource(companion, song)
  );
});

test('PowerPoint companions cannot masquerade as portable native services', async () => {
  const project = companionProject();
  const exchange = new ServiceProjectExchange({
    projectStore: {
      async read() {
        return { project, revisionId: 'a'.repeat(64) };
      },
      async resolveAssetPath() {
        throw new Error('No companion asset should be resolved.');
      },
      async importPortableProject() {
        throw new Error('Import is not part of this test.');
      }
    }
  });
  await assert.rejects(
    exchange.exportBundle(project.id, 'a'.repeat(64)),
    error => error instanceof ProjectExchangeError
      && error.code === 'COMPANION_PROJECT_NOT_EXPORTABLE'
  );
});

test('unsupported explicit workflow modes are rejected instead of becoming native projects', () => {
  for (const workflowMode of [null, 'native', 'companion', 'PPTX-COMPANION']) {
    const raw = JSON.parse(serializeServiceProject(freshProject()));
    raw.workflowMode = workflowMode;
    expectProjectCode(
      'INVALID_WORKFLOW_MODE',
      () => normalizeServiceProject(raw, { now: NOW })
    );
  }
});
