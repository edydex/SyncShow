'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  MAX_SERVICE_READINESS_WAIVERS,
  SERVICE_READINESS_CHECK_IDS,
  ServiceProjectError,
  addBibleItem,
  addGroupItem,
  addProjectItem,
  addSermonResource,
  addSongResource,
  analyzeServiceProjectReadiness,
  createServiceProject,
  normalizeServiceProject,
  parseSongDocument,
  serializeServiceProject
} = require('../src/services/project');

const NOW = '2026-07-27T18:00:00.000Z';
const CHANNELS = Object.freeze([
  { id: 'primary', label: 'English', language: 'en' },
  { id: 'secondary', label: 'Russian', language: 'ru' }
]);

function expectProjectCode(code, callback) {
  assert.throws(callback, error => {
    assert.ok(error instanceof ServiceProjectError);
    assert.equal(error.code, code);
    return true;
  });
}

function assertDeeplyFrozen(value) {
  if (!value || typeof value !== 'object') return;
  assert.equal(Object.isFrozen(value), true);
  Object.values(value).forEach(assertDeeplyFrozen);
}

function songDocument() {
  return parseSongDocument([
    '---',
    'id: weekly-song',
    'title: Church of God',
    'language: en',
    '---',
    '^1',
    'We sing the grace of Christ together'
  ].join('\n'));
}

function sermonDocument({
  id = 'weekly-sermon',
  title = 'The Church Displays God’s Wisdom',
  referenceId = 'primary-ephesians',
  startVerse = 10,
  endVerse = 11
} = {}) {
  return {
    schemaVersion: 2,
    kind: 'syncshow-sermon',
    id,
    titles: { en: title },
    defaultLanguage: 'en',
    speaker: { id: null, name: 'Pastor Example' },
    serviceDate: '2026-08-02',
    series: null,
    outline: [],
    sources: [{
      id: 'private-manuscript',
      kind: 'manuscript',
      fileName: 'pastor-private-notes.docx',
      mediaType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      sha256: 'f'.repeat(64),
      sizeBytes: 2048,
      provenance: {
        providedBy: 'Pastor Example',
        receivedAt: NOW,
        sourceSystem: 'email',
        externalId: 'private-message-id'
      },
      languages: ['en']
    }],
    references: [{
      id: referenceId,
      range: {
        schemaVersion: 1,
        bookId: 'Eph',
        start: { chapter: 3, verse: startVerse },
        end: { chapter: 3, verse: endVerse }
      },
      role: 'primary',
      source: 'operator',
      reviewStatus: 'confirmed',
      enteredText: `Ephesians 3:${startVerse}-${endVerse}`,
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

function passage(language = 'en', {
  translationId = 'BSB',
  startVerse = 10,
  endVerse = 11
} = {}) {
  const russian = language === 'ru';
  return {
    translation: {
      id: translationId,
      suggestedCredit: `${translationId} test fixture`
    },
    bookId: 'Eph',
    book: russian ? 'К Ефесянам' : 'Ephesians',
    chapter: 3,
    verseStart: startVerse,
    verseEnd: endVerse,
    reference: `${
      russian ? 'К Ефесянам' : 'Ephesians'
    } 3:${startVerse}–${endVerse}`,
    verses: Array.from(
      { length: endVerse - startVerse + 1 },
      (_value, index) => {
        const number = startVerse + index;
        return {
          number,
          text: russian
            ? `Текст стиха ${number}.`
            : `Pinned verse ${number}.`
        };
      }
    )
  };
}

function baseProject() {
  let project = createServiceProject({
    id: 'weekly-service',
    title: 'Sunday Service',
    serviceDate: '2026-08-02',
    profileId: 'main-sanctuary',
    channels: CHANNELS,
    now: NOW
  });
  project = addGroupItem(project, {
    id: 'service',
    title: 'Service',
    groupKind: 'service',
    now: NOW
  });
  project = addGroupItem(project, {
    id: 'songs',
    title: 'Communal singing',
    groupKind: 'section',
    parentId: 'service',
    now: NOW
  });
  return project;
}

function addWeeklySong(project, { coverSecondary = true } = {}) {
  const pinned = addSongResource(project, songDocument());
  return addProjectItem(pinned.project, {
    id: 'song',
    kind: 'song',
    title: 'Church of God',
    primaryChannelId: 'primary',
    variants: {
      primary: { mode: 'content', resourceId: pinned.resourceId },
      ...(coverSecondary
        ? { secondary: { mode: 'inherit', from: 'primary' } }
        : {})
    },
    arrangement: [{ id: 'verse-one', sectionId: 'verse-1' }],
    titlePresetId: 'song-title',
    lyricsPresetId: 'song-lyrics',
    operatorNotes: '',
    createdAt: NOW,
    updatedAt: NOW
  }, {
    parentId: 'songs',
    now: NOW
  });
}

function addReading(project, resourceId, {
  id = null,
  afterSermon = false,
  coverSecondary = true,
  referenceId = 'primary-ephesians',
  translationId = 'BSB',
  startVerse = 10,
  endVerse = 11,
  chunkIndex = 0,
  chunkCount = 1
} = {}) {
  return addBibleItem(project, {
    id: id || (afterSermon ? 'late-reading' : 'sermon-reading'),
    title: `Ephesians 3:${startVerse}–${endVerse}`,
    range: {
      bookId: 'Eph',
      start: { chapter: 3, verse: startVerse },
      end: { chapter: 3, verse: endVerse }
    },
    passagesByChannel: {
      primary: passage('en', { translationId, startVerse, endVerse }),
      ...(coverSecondary
        ? {
            secondary: passage('ru', {
              translationId,
              startVerse,
              endVerse
            })
          }
        : {})
    },
    sermonReading: {
      sermonResourceId: resourceId,
      referenceId,
      translationId,
      chunkIndex,
      chunkCount
    },
    parentId: 'service',
    now: NOW
  });
}

function addDeckAsset(project) {
  const sha256 = 'd'.repeat(64);
  const assetId = `sha256:${sha256}`;
  const raw = JSON.parse(serializeServiceProject(project));
  raw.assets[assetId] = {
    id: assetId,
    kind: 'deck',
    sha256,
    fileName: 'private-service-slides.pptx',
    storedName: `${sha256}.pptx`,
    mediaType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    size: 4096,
    createdAt: NOW,
    attribution: '',
    altText: ''
  };
  return {
    assetId,
    project: normalizeServiceProject(raw, { now: NOW })
  };
}

function addSermonMaterial(
  project,
  resourceId,
  { kind = 'sermon', coverSecondary = true, id = 'sermon-material' } = {}
) {
  project = addGroupItem(project, {
    id: `${id}-group`,
    title: 'Sermon',
    groupKind: 'sermon',
    sermonResourceId: resourceId,
    parentId: 'service',
    now: NOW
  });
  if (kind === 'imported-deck') {
    const withAsset = addDeckAsset(project);
    return addProjectItem(withAsset.project, {
      id,
      kind: 'imported-deck',
      title: 'Reviewed sermon slides',
      assetIdsByChannel: { primary: withAsset.assetId },
      slides: [{
        id: 'sermon-slide-one',
        sourceIndexes: { primary: 68 }
      }],
      presetId: 'legacy-slide',
      operatorNotes: '',
      createdAt: NOW,
      updatedAt: NOW
    }, {
      parentId: `${id}-group`,
      now: NOW
    });
  }
  return addProjectItem(project, {
    id,
    kind: 'sermon',
    title: 'Sermon point',
    textByChannel: {
      primary: 'God displays his wisdom through the church.',
      ...(coverSecondary
        ? { secondary: 'Бог являет Свою мудрость через церковь.' }
        : {})
    },
    presetId: 'sermon-point',
    operatorNotes: '',
    createdAt: NOW,
    updatedAt: NOW
  }, {
    parentId: `${id}-group`,
    now: NOW
  });
}

function completeProject({
  materialKind = 'sermon',
  readingAfterSermon = false,
  coverSecondary = true
} = {}) {
  let project = addWeeklySong(baseProject(), { coverSecondary });
  const pinned = addSermonResource(project, sermonDocument());
  project = pinned.project;
  if (!readingAfterSermon) {
    project = addReading(project, pinned.resourceId, { coverSecondary });
  }
  project = addSermonMaterial(project, pinned.resourceId, {
    kind: materialKind,
    coverSecondary
  });
  if (readingAfterSermon) {
    project = addReading(project, pinned.resourceId, {
      afterSermon: true,
      coverSecondary
    });
  }
  return { project, resourceId: pinned.resourceId };
}

function chunkedReadingProject(readings) {
  let project = addWeeklySong(baseProject());
  const sermon = sermonDocument({
    id: 'chunked-sermon',
    title: 'A Longer Primary Reading',
    startVerse: 1,
    endVerse: 10
  });
  sermon.references.push({
    ...sermon.references[0],
    id: 'alternate-primary',
    enteredText: 'Ephesians 3:1-10 alternate'
  });
  const pinned = addSermonResource(project, sermon);
  project = pinned.project;
  for (const reading of readings.filter(candidate => !candidate.afterMaterial)) {
    project = addReading(project, pinned.resourceId, reading);
  }
  project = addSermonMaterial(project, pinned.resourceId, {
    id: 'chunked-sermon-material'
  });
  for (const reading of readings.filter(candidate => candidate.afterMaterial)) {
    project = addReading(project, pinned.resourceId, reading);
  }
  return { project, resourceId: pinned.resourceId };
}

test('readiness is deterministic, deeply frozen, source-private, and read-only for an unplanned service', () => {
  const { project, resourceId } = completeProject();
  const before = serializeServiceProject(project);
  const first = analyzeServiceProjectReadiness(project);
  const second = analyzeServiceProjectReadiness(project);

  assert.deepEqual(second, first);
  assert.equal(first.ready, true);
  assert.equal(first.planning.present, false);
  assert.equal(first.planning.status, null);
  assert.equal(first.projectRevision, project.revision);
  assert.equal(first.cueCount, 4);
  assert.deepEqual(
    first.checks.map(check => [check.id, check.status]),
    SERVICE_READINESS_CHECK_IDS.map(checkId => [checkId, 'pass'])
  );
  assert.deepEqual(
    first.checks.map(check => check.waivable),
    [false, true, true, true, true, true]
  );
  assert.deepEqual(first.blockers, []);
  assert.deepEqual(first.waivedChecks, []);
  assert.deepEqual(first.channels, [
    { channelId: 'primary', visibleCueCount: 4, covered: true },
    { channelId: 'secondary', visibleCueCount: 4, covered: true }
  ]);
  assert.equal(first.sermons.length, 1);
  assert.equal(first.sermons[0].resourceId, resourceId);
  assert.equal(first.sermons[0].sermonId, 'weekly-sermon');
  assert.equal(first.sermons[0].sermonRevisionId, resourceId.slice('sha256:'.length));
  assert.deepEqual(first.sermons[0].ownerItemIds, ['sermon-material-group']);
  assert.deepEqual(first.sermons[0].qualifyingReadingItemIds, ['sermon-reading']);
  assert.deepEqual(first.sermons[0].material, [{
    itemId: 'sermon-material',
    kind: 'sermon',
    firstCueIndex: 3,
    cueCount: 1
  }]);

  const serializedReport = JSON.stringify(first);
  assert.doesNotMatch(serializedReport, /pastor-private-notes|private-message-id|sources|fileName/);
  assertDeeplyFrozen(first);
  assert.equal(serializeServiceProject(project), before);
});

test('an empty legacy service is reported without mutation and compilation cannot be waived', () => {
  const project = createServiceProject({
    id: 'empty-unplanned-service',
    title: 'Empty Service',
    serviceDate: '2026-08-02',
    profileId: 'main-sanctuary',
    channels: CHANNELS,
    now: NOW
  });
  const before = serializeServiceProject(project);
  const report = analyzeServiceProjectReadiness(project);

  assert.equal(report.ready, false);
  assert.equal(report.cueCount, 0);
  assert.equal(report.planning.present, false);
  assert.deepEqual(
    report.blockers.map(blocker => blocker.checkId),
    SERVICE_READINESS_CHECK_IDS
  );
  assert.deepEqual(report.checks[0].evidence, {
    cueCount: 0,
    compilationCode: 'EMPTY_PROJECT'
  });
  assert.equal(serializeServiceProject(project), before);

  expectProjectCode('UNWAIVABLE_SERVICE_READINESS_CHECK', () =>
    analyzeServiceProjectReadiness(project, {
      waivers: [{
        checkId: 'compilable-nonempty',
        reason: 'There still must be a compiled service.'
      }]
    }));
});

test('only failed, waivable checks are waived and results retain fixed check order', () => {
  const { project } = completeProject({
    readingAfterSermon: true,
    coverSecondary: false
  });
  const blocked = analyzeServiceProjectReadiness(project);
  assert.deepEqual(
    blocked.blockers.map(blocker => blocker.checkId),
    ['sermon-reading-before-material', 'channel-visible-content']
  );
  assert.deepEqual(
    blocked.checks.find(check => check.id === 'channel-visible-content').evidence,
    {
      coveredChannelIds: ['primary'],
      missingChannelIds: ['secondary']
    }
  );

  const waived = analyzeServiceProjectReadiness(project, {
    waivers: [
      {
        checkId: 'channel-visible-content',
        reason: 'The translation projector is intentionally unused for this service.'
      },
      {
        checkId: 'sermon-reading-before-material',
        reason: 'This special service reads the passage after the sermon.'
      }
    ]
  });
  assert.equal(waived.ready, true);
  assert.deepEqual(waived.waivedChecks, [
    {
      checkId: 'sermon-reading-before-material',
      reason: 'This special service reads the passage after the sermon.'
    },
    {
      checkId: 'channel-visible-content',
      reason: 'The translation projector is intentionally unused for this service.'
    }
  ]);
  assert.deepEqual(
    waived.checks.filter(check => check.status === 'waived').map(check => check.id),
    ['sermon-reading-before-material', 'channel-visible-content']
  );
});

test('an imported deck beneath the exact sermon owner counts as linked projected material', () => {
  const { project } = completeProject({ materialKind: 'imported-deck' });
  const report = analyzeServiceProjectReadiness(project);

  assert.equal(report.ready, true);
  assert.deepEqual(report.sermons[0].material, [{
    itemId: 'sermon-material',
    kind: 'imported-deck',
    firstCueIndex: 3,
    cueCount: 1
  }]);
  assert.doesNotMatch(JSON.stringify(report), /private-service-slides|pptx/);
});

test('duplicate material sets for one exact sermon are a non-waivable readiness blocker', () => {
  const completed = completeProject();
  const project = addSermonMaterial(completed.project, completed.resourceId, {
    id: 'duplicated-sermon-material'
  });
  const report = analyzeServiceProjectReadiness(project, {
    waivers: [{
      checkId: 'exact-sermon-link',
      reason: 'A previous no-sermon waiver must not conceal duplicated sermon ownership.'
    }]
  });
  const exactLink = report.checks.find(check => check.id === 'exact-sermon-link');

  assert.equal(report.ready, false);
  assert.equal(exactLink.status, 'blocker');
  assert.equal(exactLink.waivable, false);
  assert.deepEqual(exactLink.evidence.ambiguousOwnerSets, [{
    resourceId: completed.resourceId,
    itemIds: [
      'sermon-material-group',
      'duplicated-sermon-material-group'
    ]
  }]);
  assert.deepEqual(
    report.blockers.find(blocker => blocker.checkId === 'exact-sermon-link'),
    {
      checkId: 'exact-sermon-link',
      code: 'SERVICE_SERMON_OWNER_AMBIGUOUS',
      message: 'Each exact sermon revision must have one unambiguous sermon material set.'
    }
  );
  assert.deepEqual(
    report.blockers.map(blocker => blocker.code),
    ['SERVICE_SERMON_OWNER_AMBIGUOUS']
  );
  assert.deepEqual(report.waivedChecks, []);
  assert.deepEqual(report.sermons[0].qualifyingReadingItemIds, ['sermon-reading']);
  assert.equal(report.sermons[0].material.length, 2);
});

test('a reading for one exact sermon cannot satisfy another sermon revision', () => {
  let project = addWeeklySong(baseProject());
  const first = addSermonResource(project, sermonDocument({
    id: 'sermon-one',
    title: 'First Sermon'
  }));
  project = first.project;
  project = addReading(project, first.resourceId);
  project = addGroupItem(project, {
    id: 'sermon-one-owner',
    title: 'First sermon packet',
    groupKind: 'sermon',
    sermonResourceId: first.resourceId,
    parentId: 'service',
    now: NOW
  });

  const second = addSermonResource(project, sermonDocument({
    id: 'sermon-two',
    title: 'Second Sermon'
  }));
  project = addSermonMaterial(second.project, second.resourceId, {
    id: 'second-sermon-material'
  });

  const report = analyzeServiceProjectReadiness(project);
  assert.equal(report.ready, false);
  assert.equal(
    report.checks.find(check => check.id === 'exact-sermon-link').status,
    'pass'
  );
  assert.equal(
    report.checks.find(check => check.id === 'sermon-reading-before-material').status,
    'blocker'
  );
  assert.deepEqual(
    report.sermons.map(sermon => ({
      sermonId: sermon.sermonId,
      materialCount: sermon.material.length,
      qualifyingReadingCount: sermon.qualifyingReadingItemIds.length
    })),
    [
      { sermonId: 'sermon-one', materialCount: 0, qualifyingReadingCount: 0 },
      { sermonId: 'sermon-two', materialCount: 1, qualifyingReadingCount: 0 }
    ]
  );
});

test('each material-bearing exact sermon needs its own earlier linked reading', () => {
  let project = addWeeklySong(baseProject());
  const first = addSermonResource(project, sermonDocument({
    id: 'sermon-one',
    title: 'First Sermon'
  }));
  project = addReading(first.project, first.resourceId);
  project = addSermonMaterial(project, first.resourceId, {
    id: 'first-sermon-material'
  });

  const second = addSermonResource(project, sermonDocument({
    id: 'sermon-two',
    title: 'Second Sermon'
  }));
  project = addSermonMaterial(second.project, second.resourceId, {
    id: 'second-sermon-material'
  });

  const report = analyzeServiceProjectReadiness(project);
  const readingCheck = report.checks.find(check =>
    check.id === 'sermon-reading-before-material');

  assert.equal(report.ready, false);
  assert.equal(
    report.checks.find(check => check.id === 'linked-sermon-material').status,
    'pass'
  );
  assert.equal(readingCheck.status, 'blocker');
  assert.deepEqual(readingCheck.evidence, {
    count: 1,
    itemIds: ['sermon-reading'],
    requiredSermonResourceIds: [first.resourceId, second.resourceId],
    missingSermonResourceIds: [second.resourceId]
  });
  assert.deepEqual(
    report.sermons.map(sermon => ({
      sermonId: sermon.sermonId,
      materialCount: sermon.material.length,
      qualifyingReadingCount: sermon.qualifyingReadingItemIds.length
    })),
    [
      { sermonId: 'sermon-one', materialCount: 1, qualifyingReadingCount: 1 },
      { sermonId: 'sermon-two', materialCount: 1, qualifyingReadingCount: 0 }
    ]
  );
});

test('only one complete ordered sermon-reading chunk set qualifies', () => {
  const complete = chunkedReadingProject([{
    id: 'reading-0',
    startVerse: 1,
    endVerse: 8,
    chunkIndex: 0,
    chunkCount: 2
  }, {
    id: 'reading-1',
    startVerse: 9,
    endVerse: 10,
    chunkIndex: 1,
    chunkCount: 2
  }]);
  const completeReport = analyzeServiceProjectReadiness(complete.project);
  const completeCheck = completeReport.checks.find(check =>
    check.id === 'sermon-reading-before-material');

  assert.equal(completeReport.ready, true);
  assert.deepEqual(
    completeReport.sermons[0].qualifyingReadingItemIds,
    ['reading-0', 'reading-1']
  );
  assert.deepEqual(completeCheck.evidence, {
    count: 2,
    itemIds: ['reading-0', 'reading-1'],
    requiredSermonResourceIds: [complete.resourceId],
    missingSermonResourceIds: []
  });

  const invalidCases = [{
    label: 'partial',
    readings: [{
      id: 'reading-0',
      startVerse: 1,
      endVerse: 8,
      chunkIndex: 0,
      chunkCount: 2
    }]
  }, {
    label: 'duplicate',
    readings: [{
      id: 'reading-0a',
      startVerse: 1,
      endVerse: 8,
      chunkIndex: 0,
      chunkCount: 2
    }, {
      id: 'reading-0b',
      startVerse: 1,
      endVerse: 8,
      chunkIndex: 0,
      chunkCount: 2
    }, {
      id: 'reading-1',
      startVerse: 9,
      endVerse: 10,
      chunkIndex: 1,
      chunkCount: 2
    }]
  }, {
    label: 'mixed translation',
    readings: [{
      id: 'reading-0',
      startVerse: 1,
      endVerse: 8,
      chunkIndex: 0,
      chunkCount: 2,
      translationId: 'BSB'
    }, {
      id: 'reading-1',
      startVerse: 9,
      endVerse: 10,
      chunkIndex: 1,
      chunkCount: 2,
      translationId: 'LSV'
    }]
  }, {
    label: 'mixed reference',
    readings: [{
      id: 'reading-0',
      startVerse: 1,
      endVerse: 8,
      chunkIndex: 0,
      chunkCount: 2
    }, {
      id: 'reading-1',
      referenceId: 'alternate-primary',
      startVerse: 9,
      endVerse: 10,
      chunkIndex: 1,
      chunkCount: 2
    }]
  }, {
    label: 'after material',
    readings: [{
      id: 'reading-0',
      startVerse: 1,
      endVerse: 8,
      chunkIndex: 0,
      chunkCount: 2
    }, {
      id: 'reading-1',
      startVerse: 9,
      endVerse: 10,
      chunkIndex: 1,
      chunkCount: 2,
      afterMaterial: true
    }]
  }, {
    label: 'reversed chunk order',
    readings: [{
      id: 'reading-1',
      startVerse: 9,
      endVerse: 10,
      chunkIndex: 1,
      chunkCount: 2
    }, {
      id: 'reading-0',
      startVerse: 1,
      endVerse: 8,
      chunkIndex: 0,
      chunkCount: 2
    }]
  }];

  for (const candidate of invalidCases) {
    const result = chunkedReadingProject(candidate.readings);
    const report = analyzeServiceProjectReadiness(result.project);
    const readingCheck = report.checks.find(check =>
      check.id === 'sermon-reading-before-material');

    assert.equal(report.ready, false, candidate.label);
    assert.equal(readingCheck.status, 'blocker', candidate.label);
    assert.deepEqual(
      report.sermons[0].qualifyingReadingItemIds,
      [],
      candidate.label
    );
    assert.deepEqual(readingCheck.evidence, {
      count: 0,
      itemIds: [],
      requiredSermonResourceIds: [result.resourceId],
      missingSermonResourceIds: [result.resourceId]
    }, candidate.label);
  }
});

test('waivers reject malformed, duplicate, unknown, excessive, and unwaivable entries', () => {
  const { project } = completeProject();
  const cases = [
    {
      code: 'INVALID_SERVICE_READINESS_OPTIONS',
      options: []
    },
    {
      code: 'INVALID_SERVICE_READINESS_OPTIONS',
      options: { waivers: [], unexpected: true }
    },
    {
      code: 'INVALID_SERVICE_READINESS_WAIVER',
      options: { waivers: 'song-present' }
    },
    {
      code: 'INVALID_SERVICE_READINESS_WAIVER',
      options: { waivers: [{ checkId: 'song-present', reason: '   ' }] }
    },
    {
      code: 'UNKNOWN_SERVICE_READINESS_WAIVER',
      options: { waivers: [{ checkId: 'not-a-check', reason: 'Special service.' }] }
    },
    {
      code: 'DUPLICATE_SERVICE_READINESS_WAIVER',
      options: {
        waivers: [
          { checkId: 'song-present', reason: 'First reason.' },
          { checkId: 'song-present', reason: 'Second reason.' }
        ]
      }
    },
    {
      code: 'TOO_MANY_SERVICE_READINESS_WAIVERS',
      options: {
        waivers: Array.from(
          { length: MAX_SERVICE_READINESS_WAIVERS + 1 },
          () => ({ checkId: 'song-present', reason: 'Repeated only to exceed the bound.' })
        )
      }
    },
    {
      code: 'UNWAIVABLE_SERVICE_READINESS_CHECK',
      options: {
        waivers: [{
          checkId: 'compilable-nonempty',
          reason: 'Compilation must remain mandatory.'
        }]
      }
    }
  ];

  for (const { code, options } of cases) {
    expectProjectCode(code, () =>
      analyzeServiceProjectReadiness(project, options));
  }
});
