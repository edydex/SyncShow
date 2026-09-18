'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');

const {
  LOCAL_SERVICE_PLAN_ORIGIN,
  LOCAL_SERVICE_PLAN_SCHEMA_VERSION,
  SERVICE_PLAN_SCHEMA_VERSION,
  SERVICE_PLAN_STATUSES,
  ServiceProjectError,
  addBibleItem,
  addGroupItem,
  addProjectItem,
  addSermonResource,
  addSongResource,
  attachLocalServicePlanning,
  bindProjectAsPowerPointCompanion,
  bindProjectToServiceSet,
  createServiceProject,
  normalizeServiceProject,
  planNextServiceProject,
  replaceSongItem,
  serializeServiceProject,
  setServicePlanStatus,
  updateServicePlanningDetails,
  updateGroupItem
} = require('../src/services/project');
const {
  parseSongDocument
} = require('../src/services/project/SongDocument');

const SOURCE_NOW = '2026-07-26T16:00:00.000Z';
const PLAN_NOW = '2026-08-02T15:30:00.000Z';

function expectProjectCode(code, callback) {
  assert.throws(callback, error => {
    assert.ok(
      error instanceof ServiceProjectError,
      `expected ServiceProjectError, got ${error?.constructor?.name}`
    );
    assert.equal(error.code, code);
    return true;
  });
}

function freshProject(overrides = {}) {
  return createServiceProject({
    id: 'service-2026-07-26',
    title: 'Sunday Service — The Prayer That Transforms the Church',
    serviceDate: '2026-07-26',
    profileId: 'main-sanctuary',
    now: SOURCE_NOW,
    channels: [
      { id: 'primary', label: 'Main', language: 'en' },
      { id: 'media', label: 'Singers', language: 'en' }
    ],
    ...overrides
  });
}

function songDocument(id, title) {
  return parseSongDocument([
    '---',
    `id: ${id}`,
    `title: ${title}`,
    'language: en',
    '---',
    '^1',
    'Great is Your faithfulness'
  ].join('\n'));
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
      id: 'primary-john-3-16-17',
      range: {
        schemaVersion: 1,
        bookId: 'John',
        start: { chapter: 3, verse: 16 },
        end: { chapter: 3, verse: 17 }
      },
      role: 'primary',
      source: 'pastor',
      reviewStatus: 'confirmed',
      enteredText: 'John 3:16-17',
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

function biblePassage() {
  return {
    translation: {
      id: 'BSB',
      suggestedCredit: 'Berean Standard Bible'
    },
    bookId: 'John',
    book: 'John',
    chapter: 3,
    verseStart: 16,
    verseEnd: 17,
    reference: 'John 3:16–17',
    verses: [
      { number: 16, text: 'Pinned verse sixteen.' },
      { number: 17, text: 'Pinned verse seventeen.' }
    ]
  };
}

function imageAsset(hex, label) {
  const sha256 = hex.repeat(64);
  return {
    id: `sha256:${sha256}`,
    kind: 'image',
    sha256,
    fileName: `${label}.png`,
    storedName: `${sha256}.png`,
    mediaType: 'image/png',
    size: 128,
    createdAt: SOURCE_NOW,
    attribution: '',
    altText: label,
    width: 1920,
    height: 1080,
    orientation: 1
  };
}

function withAssets(project, assets) {
  const raw = JSON.parse(serializeServiceProject(project));
  for (const asset of assets) raw.assets[asset.id] = asset;
  return normalizeServiceProject(raw, { now: SOURCE_NOW });
}

function savedNativeTemplate() {
  let project = freshProject();
  project = addGroupItem(project, {
    id: 'opening',
    title: 'Opening',
    groupKind: 'section',
    now: SOURCE_NOW
  });

  const reusableSong = addSongResource(
    project,
    songDocument('great-faithfulness', 'Great Is Your Faithfulness')
  );
  project = reusableSong.project;
  const orphanedSong = addSongResource(
    project,
    songDocument('unused-last-week', 'Unused Last Week')
  );
  project = orphanedSong.project;
  project = addProjectItem(project, {
    id: 'song-great-faithfulness',
    kind: 'song',
    title: 'Great Is Your Faithfulness',
    variants: {
      primary: { mode: 'content', resourceId: reusableSong.resourceId },
      media: { mode: 'inherit', from: 'primary' }
    },
    arrangement: [{ id: 'arr-verse-1', sectionId: 'verse-1' }],
    titlePresetId: 'song-title',
    lyricsPresetId: 'song-lyrics',
    operatorNotes: ''
  }, {
    parentId: 'opening',
    now: SOURCE_NOW
  });

  const welcomeAsset = imageAsset('a', 'welcome');
  const sermonOnlyAsset = imageAsset('b', 'sermon-only');
  const orphanedAsset = imageAsset('c', 'orphaned-last-week');
  project = withAssets(project, [welcomeAsset, sermonOnlyAsset, orphanedAsset]);
  project = addProjectItem(project, {
    id: 'welcome-picture',
    kind: 'picture',
    title: 'Welcome',
    assetId: welcomeAsset.id,
    channelIds: ['primary'],
    fit: 'fit',
    focalPoint: { x: 0.5, y: 0.5 },
    altText: 'Welcome',
    attribution: '',
    presetId: 'picture-fullscreen',
    operatorNotes: ''
  }, {
    parentId: 'opening',
    now: SOURCE_NOW
  });

  const sermon = addSermonResource(project, sermonDocument());
  project = sermon.project;
  project = addGroupItem(project, {
    id: 'sermon-anchor',
    title: 'Sermon — The Prayer That Transforms the Church',
    groupKind: 'sermon',
    sermonResourceId: sermon.resourceId,
    operatorNotes: 'Pastor begins after the video.',
    now: SOURCE_NOW
  });
  project = addGroupItem(project, {
    id: 'sermon-point',
    title: 'Prayer changes us',
    groupKind: 'point',
    operatorNotes: 'Last week only.',
    parentId: 'sermon-anchor',
    now: SOURCE_NOW
  });
  project = addProjectItem(project, {
    id: 'sermon-leaf',
    kind: 'sermon',
    title: 'Prayer changes us',
    textByChannel: { primary: 'Prayer changes us.' },
    presetId: 'sermon-point',
    operatorNotes: ''
  }, {
    parentId: 'sermon-point',
    now: SOURCE_NOW
  });
  project = addProjectItem(project, {
    id: 'sermon-only-picture',
    kind: 'picture',
    title: 'Sermon illustration',
    assetId: sermonOnlyAsset.id,
    channelIds: ['primary'],
    fit: 'fit',
    focalPoint: { x: 0.5, y: 0.5 },
    altText: 'Sermon illustration',
    attribution: '',
    presetId: 'picture-fullscreen',
    operatorNotes: ''
  }, {
    parentId: 'sermon-anchor',
    now: SOURCE_NOW
  });
  project = addBibleItem(project, {
    id: 'generated-sermon-reading',
    title: 'Sermon reading',
    range: {
      bookId: 'John',
      start: { chapter: 3, verse: 16 },
      end: { chapter: 3, verse: 17 }
    },
    passagesByChannel: { primary: biblePassage() },
    sermonReading: {
      sermonResourceId: sermon.resourceId,
      referenceId: 'primary-john-3-16-17',
      translationId: 'BSB',
      chunkIndex: 0,
      chunkCount: 1
    },
    now: SOURCE_NOW
  });
  project = addProjectItem(project, {
    id: 'stray-sermon-leaf',
    kind: 'sermon',
    title: 'Last sermon title card',
    textByChannel: { primary: 'The Prayer That Transforms the Church' },
    sermonResourceId: sermon.resourceId,
    presetId: 'sermon-point',
    operatorNotes: ''
  }, { now: SOURCE_NOW });
  project = addProjectItem(project, {
    id: 'closing-blank',
    kind: 'blank',
    title: 'Closing blank',
    channelIds: ['primary', 'media'],
    presetId: 'blank-black',
    operatorNotes: ''
  }, { now: SOURCE_NOW });
  project = bindProjectToServiceSet(project, {
    id: 'service-set-2026-07-26',
    fingerprint: 'd'.repeat(64),
    serviceDate: '2026-07-26',
    profileId: 'main-sanctuary'
  });

  const raw = JSON.parse(serializeServiceProject(project));
  raw.revision = 7;
  return {
    project: normalizeServiceProject(raw, { now: SOURCE_NOW }),
    reusableSongResourceId: reusableSong.resourceId,
    orphanedSongResourceId: orphanedSong.resourceId,
    welcomeAssetId: welcomeAsset.id,
    sermonOnlyAssetId: sermonOnlyAsset.id,
    orphanedAssetId: orphanedAsset.id
  };
}

function plannedProject(options = {}) {
  const source = savedNativeTemplate().project;
  return planNextServiceProject(source, {
    id: 'service-2026-08-02',
    title: 'Sunday Service — August 2',
    serviceDate: '2026-08-02',
    startTime: '10:30',
    teamNotes: 'Confirm the communion table before rehearsal.',
    now: PLAN_NOW,
    ...options
  });
}

test('planning is an optional revision-independent extension and legacy canonical bytes do not change', () => {
  const project = freshProject();
  const before = serializeServiceProject(project);
  const roundTrip = normalizeServiceProject(JSON.parse(before), { now: SOURCE_NOW });

  assert.equal(SERVICE_PLAN_SCHEMA_VERSION, 1);
  assert.deepEqual(
    SERVICE_PLAN_STATUSES,
    ['planning', 'ready', 'completed', 'needs-follow-up']
  );
  assert.equal(project.planning, undefined);
  assert.doesNotMatch(before, /"planning"/);
  assert.equal(serializeServiceProject(roundTrip), before);
});

test('a first local service has explicit portable planning and becomes a provenance-pinned Plan Next source', () => {
  const ordinary = freshProject({ id: 'first-local-service' });
  const ordinaryBytes = serializeServiceProject(ordinary);
  const local = attachLocalServicePlanning(ordinary, {
    startTime: '10:30',
    teamNotes: 'Meet in the sanctuary at 09:45.'
  });

  assert.equal(serializeServiceProject(ordinary), ordinaryBytes);
  assert.equal(LOCAL_SERVICE_PLAN_SCHEMA_VERSION, 4);
  assert.equal(LOCAL_SERVICE_PLAN_ORIGIN, 'local-created');
  assert.deepEqual(local.planning, {
    schemaVersion: 4,
    status: 'planning',
    startTime: '10:30',
    origin: 'local-created',
    teamNotes: 'Meet in the sanctuary at 09:45.'
  });
  assert.equal(Object.hasOwn(local.planning, 'templateSource'), false);
  assert.equal(Object.hasOwn(local.planning, 'source'), false);
  assert.ok(Object.isFrozen(local));

  const localBytes = serializeServiceProject(local);
  assert.equal(
    serializeServiceProject(
      normalizeServiceProject(JSON.parse(localBytes), { now: SOURCE_NOW })
    ),
    localBytes
  );
  assert.equal(
    updateServicePlanningDetails(local, {
      startTime: '11:00',
      teamNotes: 'Updated locally.'
    }).planning.origin,
    LOCAL_SERVICE_PLAN_ORIGIN
  );

  const savedRaw = JSON.parse(localBytes);
  savedRaw.revision = 1;
  const savedLocal = normalizeServiceProject(savedRaw, { now: SOURCE_NOW });
  const savedLocalBytes = serializeServiceProject(savedLocal);
  const next = planNextServiceProject(savedLocal, {
    id: 'service-after-first-local',
    title: 'Next Sunday Service',
    serviceDate: '2026-08-02',
    startTime: '10:30',
    now: PLAN_NOW
  });
  assert.deepEqual(next.planning, {
    schemaVersion: SERVICE_PLAN_SCHEMA_VERSION,
    status: 'planning',
    startTime: '10:30',
    templateSource: {
      projectId: savedLocal.id,
      sourceRevisionId: crypto.createHash('sha256')
        .update(savedLocalBytes)
        .digest('hex')
    }
  });
});

test('local-created planning is strict and cannot be confused with template or companion provenance', () => {
  const local = attachLocalServicePlanning(
    freshProject({ id: 'strict-local-service' }),
    { startTime: '10:30' }
  );
  const mutate = callback => {
    const raw = JSON.parse(serializeServiceProject(local));
    callback(raw);
    return () => normalizeServiceProject(raw, { now: SOURCE_NOW });
  };

  expectProjectCode('INVALID_SERVICE_PLAN_PROVENANCE', mutate(raw => {
    raw.planning.origin = 'template-derived';
  }));
  expectProjectCode('INVALID_SERVICE_PLAN', mutate(raw => {
    raw.planning.templateSource = {
      projectId: 'some-template',
      sourceRevisionId: 'a'.repeat(64)
    };
  }));
  expectProjectCode('INVALID_SERVICE_PLAN_START_TIME', mutate(raw => {
    raw.planning.startTime = '10:30 AM';
  }));
  expectProjectCode('TEXT_TOO_LONG', mutate(raw => {
    raw.planning.teamNotes = 'x'.repeat(4001);
  }));
  expectProjectCode(
    'SERVICE_PLAN_ALREADY_ATTACHED',
    () => attachLocalServicePlanning(local, { startTime: '10:30' })
  );
  expectProjectCode(
    'INVALID_SERVICE_PLAN',
    () => attachLocalServicePlanning(
      freshProject({ id: 'local-extra-field' }),
      { startTime: '10:30', sourcePath: '/private/template.syncshow' }
    )
  );

  const companion = bindProjectAsPowerPointCompanion(
    addGroupItem(
      freshProject({ id: 'legacy-companion' }),
      {
        id: 'sermon-anchor',
        title: 'Sermon',
        groupKind: 'sermon',
        now: SOURCE_NOW
      }
    ),
    {
      id: 'service-set-legacy',
      fingerprint: 'a'.repeat(64),
      serviceDate: '2026-07-26',
      profileId: 'main-sanctuary'
    }
  );
  expectProjectCode(
    'SERVICE_PLAN_SOURCE_NOT_NATIVE',
    () => attachLocalServicePlanning(companion, { startTime: '10:30' })
  );
});

test('Plan next service keeps reusable native content and strips all occurrence-specific sermon state', () => {
  const fixture = savedNativeTemplate();
  const sourceBytes = serializeServiceProject(fixture.project);
  const sourceRevisionId = crypto.createHash('sha256')
    .update(sourceBytes)
    .digest('hex');
  const planned = planNextServiceProject(fixture.project, {
    id: 'service-2026-08-02',
    title: 'Sunday Service — August 2',
    serviceDate: '2026-08-02',
    startTime: '10:30',
    teamNotes: 'Confirm the communion table before rehearsal.',
    now: PLAN_NOW
  });

  assert.equal(serializeServiceProject(fixture.project), sourceBytes, 'the source is not mutated');
  assert.equal(planned.id, 'service-2026-08-02');
  assert.equal(planned.title, 'Sunday Service — August 2');
  assert.equal(planned.serviceDate, '2026-08-02');
  assert.equal(planned.createdAt, PLAN_NOW);
  assert.equal(planned.updatedAt, PLAN_NOW);
  assert.equal(planned.revision, 0);
  assert.equal(planned.workflowMode, undefined);
  assert.equal(planned.sourceServiceSet, undefined);
  assert.deepEqual(planned.planning, {
    schemaVersion: 1,
    status: 'planning',
    startTime: '10:30',
    templateSource: {
      projectId: 'service-2026-07-26',
      sourceRevisionId
    },
    teamNotes: 'Confirm the communion table before rehearsal.'
  });

  assert.deepEqual(planned.items.opening.childIds, [
    'song-great-faithfulness',
    'welcome-picture'
  ]);
  assert.deepEqual(planned.items['sermon-anchor'], {
    id: 'sermon-anchor',
    kind: 'group',
    title: 'Sermon',
    createdAt: SOURCE_NOW,
    updatedAt: PLAN_NOW,
    operatorNotes: '',
    groupKind: 'sermon',
    childIds: []
  });
  assert.ok(planned.items['closing-blank']);
  for (const removedId of [
    'sermon-point',
    'sermon-leaf',
    'sermon-only-picture',
    'generated-sermon-reading',
    'stray-sermon-leaf'
  ]) {
    assert.equal(planned.items[removedId], undefined, `${removedId} must not carry forward`);
  }
  assert.equal(
    Object.values(planned.items).some(item =>
      item.kind === 'sermon'
        || item.sermonResourceId
        || item.sermonSectionId
        || (item.kind === 'bible' && item.sermonReading)),
    false
  );

  assert.deepEqual(Object.keys(planned.resources), [fixture.reusableSongResourceId]);
  assert.equal(planned.resources[fixture.orphanedSongResourceId], undefined);
  assert.deepEqual(Object.keys(planned.assets), [fixture.welcomeAssetId]);
  assert.equal(planned.assets[fixture.sermonOnlyAssetId], undefined);
  assert.equal(planned.assets[fixture.orphanedAssetId], undefined);
  assert.ok(Object.isFrozen(planned));
  assert.equal(
    serializeServiceProject(
      normalizeServiceProject(JSON.parse(serializeServiceProject(planned)), { now: PLAN_NOW })
    ),
    serializeServiceProject(planned)
  );
});

test('planning metadata is strict, bounded, self-contained, and path-free', () => {
  const planned = plannedProject();
  const mutate = callback => {
    const raw = JSON.parse(serializeServiceProject(planned));
    callback(raw);
    return () => normalizeServiceProject(raw, { now: PLAN_NOW });
  };

  expectProjectCode('INVALID_SERVICE_PLAN_SCHEMA', mutate(raw => {
    raw.planning.schemaVersion = 2;
  }));
  expectProjectCode('INVALID_SERVICE_PLAN_STATUS', mutate(raw => {
    raw.planning.status = 'published';
  }));
  expectProjectCode('INVALID_SERVICE_PLAN_START_TIME', mutate(raw => {
    raw.planning.startTime = '10:30 AM';
  }));
  expectProjectCode('INVALID_SERVICE_PLAN', mutate(raw => {
    raw.planning.loadPackageInstalled = true;
  }));
  expectProjectCode('INVALID_SERVICE_PLAN_PROVENANCE', mutate(raw => {
    raw.planning.templateSource.sourcePath = '/private/last-week.syncshow';
  }));
  expectProjectCode('INVALID_SERVICE_PLAN_PROVENANCE', mutate(raw => {
    raw.planning.templateSource.sourceRevisionId = 'not-a-sha256';
  }));
  expectProjectCode('INVALID_SERVICE_PLAN_PROVENANCE', mutate(raw => {
    raw.planning.templateSource.projectId = raw.id;
  }));
  expectProjectCode('TEXT_TOO_LONG', mutate(raw => {
    raw.planning.teamNotes = 'x'.repeat(4001);
  }));
});

test('status transitions are explicit and domain content edits reopen non-planning states', () => {
  const planned = plannedProject();
  const ready = setServicePlanStatus(planned, 'ready');
  assert.equal(ready.planning.status, 'ready');
  assert.equal(ready.planning.teamNotes, planned.planning.teamNotes);

  const edited = updateGroupItem(ready, {
    itemId: 'opening',
    title: 'Call to worship',
    now: '2026-08-02T15:45:00.000Z'
  });
  assert.equal(edited.planning.status, 'planning');

  const completed = setServicePlanStatus(edited, 'completed');
  assert.equal(completed.planning.status, 'completed');
  const reopened = addGroupItem(completed, {
    id: 'communion',
    title: 'Communion',
    groupKind: 'section',
    now: '2026-08-02T15:50:00.000Z'
  });
  assert.equal(reopened.planning.status, 'planning');
  assert.equal(
    setServicePlanStatus(reopened, 'needs-follow-up').planning.status,
    'needs-follow-up'
  );

  expectProjectCode(
    'INVALID_SERVICE_PLAN_STATUS',
    () => setServicePlanStatus(planned, 'installed')
  );
  expectProjectCode(
    'SERVICE_PLAN_REQUIRED',
    () => setServicePlanStatus(freshProject(), 'ready')
  );
});

test('replacing a planned native song reopens Planning and clears revision-specific waivers', () => {
  let project = plannedProject();
  const replacement = addSongResource(
    project,
    songDocument('replacement-hymn', 'Replacement Hymn'),
    {
      provider: 'local',
      itemId: 'replacement-hymn',
      revision: 'e'.repeat(64)
    }
  );
  project = updateServicePlanningDetails(replacement.project, {
    readinessWaivers: [{
      checkId: 'exact-sermon-link',
      reason: 'The sermon source will be added after the pastor sends it.'
    }]
  });
  project = setServicePlanStatus(project, 'ready');

  const replaced = replaceSongItem(project, 'song-great-faithfulness', {
    id: 'song-replacement-hymn',
    kind: 'song',
    title: 'Replacement Hymn',
    primaryChannelId: 'primary',
    variants: {
      primary: {
        mode: 'content',
        resourceId: replacement.resourceId
      },
      media: {
        mode: 'derive',
        from: 'primary',
        transform: { id: 'first-lines', version: 1, maxLines: 2 }
      }
    },
    arrangement: [{
      id: 'arr-replacement-verse-one',
      sectionId: 'verse-1'
    }],
    titlePresetId: 'song-title',
    lyricsPresetId: 'song-lyrics',
    operatorNotes: ''
  }, {
    now: '2026-08-02T15:48:00.000Z'
  });

  assert.equal(replaced.planning.status, 'planning');
  assert.equal(replaced.planning.readinessWaivers, undefined);
  assert.deepEqual(replaced.items.opening.childIds, [
    'song-replacement-hymn',
    'welcome-picture'
  ]);
});

test('Plan next service requires a new id and one exact saved native source revision', () => {
  const unsaved = freshProject();
  expectProjectCode('SERVICE_PLAN_SOURCE_NOT_SAVED', () => planNextServiceProject(unsaved, {
    id: 'service-2026-08-02',
    title: 'Sunday Service — August 2',
    serviceDate: '2026-08-02',
    startTime: '10:30',
    now: PLAN_NOW
  }));

  const source = savedNativeTemplate().project;
  expectProjectCode('SERVICE_PLAN_ID_REUSED', () => planNextServiceProject(source, {
    id: source.id,
    title: 'Sunday Service — August 2',
    serviceDate: '2026-08-02',
    startTime: '10:30',
    now: PLAN_NOW
  }));
  expectProjectCode('INVALID_SERVICE_PLAN_START_TIME', () => planNextServiceProject(source, {
    id: 'service-2026-08-02',
    title: 'Sunday Service — August 2',
    serviceDate: '2026-08-02',
    startTime: '25:00',
    now: PLAN_NOW
  }));

  let companion = freshProject({ id: 'powerpoint-companion' });
  companion = addGroupItem(companion, {
    id: 'sermon-anchor',
    title: 'Sermon',
    groupKind: 'sermon',
    now: SOURCE_NOW
  });
  companion = bindProjectAsPowerPointCompanion(companion, {
    id: 'service-set-2026-07-26',
    fingerprint: 'e'.repeat(64),
    serviceDate: '2026-07-26',
    profileId: 'main-sanctuary'
  });
  const rawCompanion = JSON.parse(serializeServiceProject(companion));
  rawCompanion.revision = 1;
  companion = normalizeServiceProject(rawCompanion, { now: SOURCE_NOW });
  expectProjectCode('SERVICE_PLAN_SOURCE_NOT_NATIVE', () => planNextServiceProject(companion, {
    id: 'service-2026-08-02',
    title: 'Sunday Service — August 2',
    serviceDate: '2026-08-02',
    startTime: '10:30',
    now: PLAN_NOW
  }));
});
