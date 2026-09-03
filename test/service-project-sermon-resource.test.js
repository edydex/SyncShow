'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  ServiceProjectError,
  addGroupItem,
  addProjectItem,
  addSermonResource,
  compileServiceProject,
  createServiceProject,
  isSermonSourceTarget,
  normalizeServiceProject,
  removeProjectItemAndDescendants,
  resolveSermonSourceLink,
  serializeServiceProject,
  setSermonSourceLink,
  updateTextItem
} = require('../src/services/project');

const NOW = '2026-07-26T16:00:00.000Z';

function range(bookId, chapter, verseStart, verseEnd = verseStart) {
  return {
    schemaVersion: 1,
    bookId,
    start: { chapter, verse: verseStart },
    end: { chapter, verse: verseEnd }
  };
}

function july26Sermon(overrides = {}) {
  return {
    schemaVersion: 1,
    kind: 'syncshow-sermon',
    id: 'sermon-2026-07-26-prayer',
    titles: {
      en: 'The Prayer That Transforms the Church',
      ru: 'Молитва, преображающая Церковь'
    },
    defaultLanguage: 'en',
    speaker: {
      id: 'paul-lvutin',
      name: 'Paul Lvutin'
    },
    serviceDate: '2026-07-26',
    series: {
      id: 'from-pain-to-unity',
      titles: {
        en: 'From Pain to Unity',
        ru: 'От боли к единству'
      }
    },
    outline: [{
      id: 'foundation',
      parentId: null,
      kind: 'section',
      titles: {
        en: 'The Foundation of the Prayer',
        ru: 'Основание молитвы'
      }
    }, {
      id: 'content',
      parentId: null,
      kind: 'section',
      titles: {
        en: 'The Content of the Prayer',
        ru: 'Содержание молитвы'
      }
    }, {
      id: 'know-love',
      parentId: 'content',
      kind: 'point',
      titles: {
        en: 'To Know the Love of Christ',
        ru: 'Познать любовь Христову'
      }
    }],
    sources: [{
      id: 'pastor-manuscript',
      kind: 'manuscript',
      fileName: '07-26-26-sermon.pdf',
      mediaType: 'application/pdf',
      language: 'ru',
      sha256: 'a'.repeat(64),
      sizeBytes: 184320,
      provenance: {
        providedBy: 'Paul Lvutin',
        receivedAt: '2026-07-24T18:30:00Z',
        sourceSystem: 'pastor-email',
        externalId: 'message-2026-07-24'
      }
    }],
    references: [{
      id: 'primary-eph-3-14-21',
      range: range('Eph', 3, 14, 21),
      role: 'primary',
      source: 'pastor',
      reviewStatus: 'confirmed',
      enteredText: 'Ephesians 3:14-21',
      sourceId: 'pastor-manuscript',
      sectionId: null,
      startOffset: null,
      endOffset: null
    }, {
      id: 'mentioned-eph-5-2',
      range: range('Eph', 5, 2),
      role: 'mentioned',
      source: 'manuscript',
      reviewStatus: 'confirmed',
      enteredText: 'Ephesians 5:2',
      sourceId: 'pastor-manuscript',
      sectionId: 'foundation',
      startOffset: 1260,
      endOffset: 1276
    }],
    media: [],
    publication: {
      status: 'ready',
      visibility: 'members',
      publishedAt: null,
      canonicalUrl: null
    },
    ...overrides
  };
}

function july26SermonV3(bodyText = 'Reviewed manuscript body for the sermon resource.') {
  const legacy = july26Sermon();
  return {
    ...legacy,
    schemaVersion: 3,
    sources: legacy.sources.map(source => {
      const { language, ...rest } = source;
      return {
        ...rest,
        languages: [language, 'en']
      };
    }),
    body: [{
      id: 'foundation-manuscript-en',
      kind: 'manuscript',
      language: 'en',
      sourceId: 'pastor-manuscript',
      sectionId: 'foundation',
      text: bodyText
    }]
  };
}

function freshProject() {
  return createServiceProject({
    id: 'service-2026-07-26',
    title: 'Sunday Service',
    serviceDate: '2026-07-26',
    profileId: 'main-sanctuary',
    now: NOW,
    channels: [
      { id: 'primary', label: 'Russian', language: 'ru' },
      { id: 'secondary', label: 'English', language: 'en' }
    ]
  });
}

function sermonCue(overrides = {}) {
  return {
    id: 'sermon-slide-foundation',
    kind: 'sermon',
    title: 'Foundation',
    titlesByChannel: {
      primary: 'I. Основание молитвы',
      secondary: 'I. The Foundation of the Prayer'
    },
    textByChannel: {
      primary: 'Еф.3:14-15 Для сего преклоняю колени мои...',
      secondary: 'Eph.3:14-15 For this reason I bow my knees...'
    },
    presetId: 'sermon-point',
    operatorNotes: 'Reviewed projected wording.',
    ...overrides
  };
}

function expectProjectCode(code, callback) {
  assert.throws(callback, error => {
    assert.ok(error instanceof ServiceProjectError);
    assert.equal(error.code, code);
    return true;
  });
}

function linkedProject(document = july26Sermon()) {
  const pinned = addSermonResource(freshProject(), document, {
    provider: 'heritage-community',
    providerId: 'wotbc',
    itemId: 'sermon-2026-07-26-prayer',
    revision: 'community-revision-17'
  });
  let project = addGroupItem(pinned.project, {
    id: 'sermon',
    title: 'Sermon',
    groupKind: 'sermon',
    sermonResourceId: pinned.resourceId,
    now: NOW
  });
  project = addGroupItem(project, {
    id: 'sermon-foundation',
    title: 'Foundation',
    groupKind: 'point',
    sermonSectionId: 'foundation',
    parentId: 'sermon',
    now: NOW
  });
  project = addProjectItem(project, sermonCue(), {
    parentId: 'sermon-foundation',
    now: NOW
  });
  return { project, resourceId: pinned.resourceId };
}

test('ordinary service sections are not sermon source targets without sermon context', () => {
  let project = addGroupItem(freshProject(), {
    id: 'worship',
    title: 'Worship',
    groupKind: 'section',
    now: NOW
  });
  project = addGroupItem(project, {
    id: 'sermon',
    title: 'Sermon',
    groupKind: 'sermon',
    now: NOW
  });
  project = addGroupItem(project, {
    id: 'sermon-application',
    title: 'Application',
    groupKind: 'section',
    parentId: 'sermon',
    now: NOW
  });

  assert.equal(isSermonSourceTarget(project, project.items.worship), false);
  assert.equal(isSermonSourceTarget(project, project.items.sermon), true);
  assert.equal(isSermonSourceTarget(project, project.items['sermon-application']), true);
});

test('service projects pin an exact sermon revision while preserving reviewed inline cue text', () => {
  const { project, resourceId } = linkedProject();
  const resolved = resolveSermonSourceLink(
    project,
    project.items['sermon-slide-foundation']
  );
  assert.equal(resolved.resourceOwnerId, 'sermon');
  assert.equal(resolved.sectionOwnerId, 'sermon-foundation');
  assert.equal(resolved.resourceId, resourceId);
  assert.equal(resolved.sectionId, 'foundation');

  const timeline = compileServiceProject(project);
  const cue = timeline.cues[timeline.cueIds[0]];
  const resource = project.resources[resourceId];

  assert.deepEqual(cue.sourceReference, {
    type: 'sermon-library',
    id: 'sermon-2026-07-26-prayer',
    revision: resource.sha256,
    sectionId: 'foundation'
  });
  assert.equal(
    cue.channels.secondary.blocks.find(block => block.role === 'body').text,
    'Eph.3:14-15 For this reason I bow my knees...'
  );
  assert.deepEqual(timeline.libraryReferences, [{
    id: 'sermon-2026-07-26-prayer',
    kind: 'sermon',
    revision: resource.sha256,
    pinnedAt: NOW
  }]);

  const roundTrip = normalizeServiceProject(JSON.parse(serializeServiceProject(project)), { now: NOW });
  assert.equal(serializeServiceProject(roundTrip), serializeServiceProject(project));
  assert.deepEqual(
    compileServiceProject(roundTrip).cues[timeline.cueIds[0]].sourceReference,
    cue.sourceReference
  );
});

test('a v3 body is pinned canonically without replacing reviewed service cue wording', () => {
  const document = july26SermonV3(
    'The full reviewed manuscript belongs to the sermon packet, not the projection cue.'
  );
  const { project, resourceId } = linkedProject(document);
  const resource = project.resources[resourceId];
  const beforeCueText = JSON.parse(
    JSON.stringify(project.items['sermon-slide-foundation'].textByChannel)
  );

  assert.deepEqual(resource.document.body, document.body);
  const roundTrip = normalizeServiceProject(
    JSON.parse(serializeServiceProject(project)),
    { now: NOW }
  );
  assert.equal(roundTrip.resources[resourceId].sha256, resourceId.slice(7));
  assert.deepEqual(roundTrip.resources[resourceId].document.body, document.body);
  assert.deepEqual(
    roundTrip.items['sermon-slide-foundation'].textByChannel,
    beforeCueText
  );
  const timeline = compileServiceProject(roundTrip);
  assert.equal(
    timeline.cues[timeline.cueIds[0]]
      .channels.secondary.blocks.find(block => block.role === 'body').text,
    beforeCueText.secondary
  );
});

test('sermon source links validate exact resource kind, existence, section, and content hash', () => {
  const pinned = addSermonResource(freshProject(), july26Sermon());
  expectProjectCode('INVALID_SERMON_RESOURCE_REFERENCE', () => addGroupItem(pinned.project, {
    id: 'missing-sermon',
    title: 'Missing sermon',
    groupKind: 'sermon',
    sermonResourceId: `sha256:${'f'.repeat(64)}`,
    now: NOW
  }));
  expectProjectCode('UNKNOWN_SERMON_SECTION', () => addGroupItem(pinned.project, {
    id: 'unknown-section',
    title: 'Unknown point',
    groupKind: 'point',
    sermonResourceId: pinned.resourceId,
    sermonSectionId: 'not-in-the-sermon',
    now: NOW
  }));
  expectProjectCode('MISSING_SERMON_RESOURCE', () => addGroupItem(pinned.project, {
    id: 'orphan-section',
    title: 'Orphan point',
    groupKind: 'point',
    sermonSectionId: 'foundation',
    now: NOW
  }));

  const tampered = JSON.parse(serializeServiceProject(pinned.project));
  tampered.resources[pinned.resourceId].document.titles.en = 'Changed after pinning';
  expectProjectCode('RESOURCE_HASH_MISMATCH', () => normalizeServiceProject(tampered, { now: NOW }));
});

test('focused source-link mutations preserve ordinary edits and prune only the final direct reference', () => {
  const pinned = addSermonResource(freshProject(), july26Sermon());
  let project = addGroupItem(pinned.project, {
    id: 'sermon',
    title: 'Sermon',
    groupKind: 'sermon',
    now: NOW
  });
  project = addProjectItem(project, sermonCue(), {
    parentId: 'sermon',
    now: NOW
  });
  project = setSermonSourceLink(project, {
    itemId: 'sermon',
    sermonResourceId: pinned.resourceId,
    now: '2026-07-26T16:01:00.000Z'
  });
  project = setSermonSourceLink(project, {
    itemId: 'sermon-slide-foundation',
    sermonSectionId: 'foundation',
    now: '2026-07-26T16:02:00.000Z'
  });

  const edited = updateTextItem(project, {
    itemId: 'sermon-slide-foundation',
    textByChannel: {
      primary: 'Исправленный, проверенный текст.',
      secondary: 'Corrected, reviewed text.'
    },
    now: '2026-07-26T16:03:00.000Z'
  });
  const editedCue = compileServiceProject(edited).cues[
    compileServiceProject(edited).cueIds[0]
  ];
  assert.equal(editedCue.sourceReference.sectionId, 'foundation');
  assert.equal(editedCue.sourceReference.revision, edited.resources[pinned.resourceId].sha256);

  const removed = removeProjectItemAndDescendants(edited, 'sermon');
  assert.deepEqual(removed.items, {});
  assert.equal(removed.resources[pinned.resourceId], undefined);
});

test('legacy inline sermon projects remain unlinked and omit every new field', () => {
  let project = addGroupItem(freshProject(), {
    id: 'sermon',
    title: 'Sermon',
    groupKind: 'sermon',
    now: NOW
  });
  project = addProjectItem(project, sermonCue(), {
    parentId: 'sermon',
    now: NOW
  });

  const serialized = serializeServiceProject(project);
  assert.equal(serialized.includes('sermonResourceId'), false);
  assert.equal(serialized.includes('sermonSectionId'), false);
  const timeline = compileServiceProject(project);
  assert.equal(timeline.cues[timeline.cueIds[0]].sourceReference, undefined);
  assert.deepEqual(timeline.libraryReferences, []);
});
