'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { BibleLibrary } = require('../src/services/bible');
const {
  SERMON_SCHEMA_VERSION,
  ServiceProjectError,
  addBibleItem,
  addGroupItem,
  addProjectItem,
  addSermonResource,
  analyzeSermonPrimaryReading,
  compileServiceProject,
  createServiceProject,
  duplicateProjectItem,
  normalizeServiceProject,
  placeBibleReadingItemsBefore,
  planSermonPostServiceLinks,
  repinCompatibleSermonDocument,
  repinCompatibleSermonRevision,
  repinSermonRevision,
  setSermonSourceLink
} = require('../src/services/project');

const library = new BibleLibrary({ maxVerses: 8 });

function sermon({ id = 'sermon-reading', chapter = 3, start = 1, end = 9 } = {}) {
  return {
    schemaVersion: SERMON_SCHEMA_VERSION,
    kind: 'syncshow-sermon',
    id,
    titles: { en: 'The Sermon' },
    defaultLanguage: 'en',
    speaker: { id: null, name: 'Pastor' },
    serviceDate: '2026-07-27',
    series: null,
    outline: [],
    sources: [],
    references: [{
      id: 'primary-reading',
      range: {
        schemaVersion: 1,
        bookId: 'Eph',
        start: { chapter, verse: start },
        end: { chapter, verse: end }
      },
      role: 'primary',
      source: 'operator',
      reviewStatus: 'confirmed',
      enteredText: `Ephesians ${chapter}:${start}-${end}`,
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

function sourcedOutlinedSermon({
  sourceRevision = 'a',
  outlineTitle = 'Original point',
  includeApplication = false,
  bodyText = 'Original reviewed manuscript body.',
  chapter = 3,
  start = 1,
  end = 9
} = {}) {
  const document = sermon({ chapter, start, end });
  document.outline = [{
    id: 'sermon-section',
    parentId: null,
    kind: 'point',
    titles: { en: outlineTitle }
  }];
  if (includeApplication) {
    document.outline.push({
      id: 'sermon-application',
      parentId: 'sermon-section',
      kind: 'subpoint',
      titles: { en: 'Application' }
    });
  }
  document.sources = [{
    id: 'manuscript',
    kind: 'manuscript',
    fileName: `sermon-${sourceRevision}.docx`,
    mediaType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    sha256: sourceRevision.repeat(64),
    sizeBytes: sourceRevision === 'a' ? 1024 : 2048,
    provenance: {
      providedBy: 'Pastor',
      receivedAt: '2026-07-27T18:00:00.000Z',
      sourceSystem: 'email',
      externalId: `message-${sourceRevision}`
    },
    languages: ['en']
  }];
  document.references[0] = {
    ...document.references[0],
    source: 'manuscript',
    sourceId: 'manuscript',
    sectionId: 'sermon-section'
  };
  document.body = [{
    id: 'reviewed-manuscript-en',
    kind: 'manuscript',
    language: 'en',
    sourceId: 'manuscript',
    sectionId: 'sermon-section',
    text: bodyText
  }];
  return document;
}

function textByChannel(project, text) {
  return Object.fromEntries(project.channelIds.map(channelId => [channelId, text]));
}

function linkedNestedSermon(document = sermon()) {
  let project = createServiceProject({
    id: 'service-sermon-reading',
    title: 'Sunday Service',
    serviceDate: '2026-07-27',
    profileId: 'main-sanctuary'
  });
  project = addGroupItem(project, {
    id: 'sermon-group',
    title: 'Sermon',
    groupKind: 'sermon'
  });
  project = addGroupItem(project, {
    id: 'sermon-point',
    title: 'Point one',
    groupKind: 'point',
    parentId: 'sermon-group'
  });
  project = addProjectItem(project, {
    id: 'sermon-cue',
    kind: 'sermon',
    title: 'Sermon cue',
    textByChannel: textByChannel(project, 'Projected sermon wording'),
    presetId: 'sermon-point',
    operatorNotes: ''
  }, {
    parentId: 'sermon-point'
  });
  const pinned = addSermonResource(project, document);
  project = setSermonSourceLink(pinned.project, {
    itemId: 'sermon-cue',
    sermonResourceId: pinned.resourceId,
    sermonSectionId: null
  });
  return { project, resourceId: pinned.resourceId };
}

function withPlanningStatus(project, status) {
  const raw = JSON.parse(JSON.stringify(project));
  raw.planning = {
    schemaVersion: 1,
    status,
    startTime: '10:30',
    templateSource: {
      projectId: 'service-sermon-template',
      sourceRevisionId: 'a'.repeat(64)
    },
    readinessWaivers: [{
      checkId: 'song-present',
      reason: 'The service uses an unaccompanied response this week.'
    }]
  };
  return normalizeServiceProject(raw);
}

async function addReadingChunk(project, resourceId, chunk, chunkIndex, chunkCount) {
  const lookup = await library.lookup(chunk.reference, { translationId: 'BSB' });
  assert.equal(lookup.status, 'ok');
  const passage = { ...lookup.passage, bookId: chunk.range.bookId };
  return addBibleItem(project, {
    id: `reading-${chunkIndex + 1}`,
    title: `${lookup.passage.reference} (${lookup.passage.translation.abbr})`,
    range: chunk.range,
    passagesByChannel: Object.fromEntries(
      project.channelIds.map(channelId => [channelId, passage])
    ),
    sermonReading: {
      sermonResourceId: resourceId,
      referenceId: 'primary-reading',
      translationId: 'BSB',
      chunkIndex,
      chunkCount
    }
  });
}

async function linkedSermonWithReadyReading(document) {
  const { project: initial, resourceId } = linkedNestedSermon(document);
  const plan = analyzeSermonPrimaryReading(initial, {
    itemId: 'sermon-cue',
    referenceId: 'primary-reading',
    translationId: 'BSB',
    maxVerses: 8
  });
  let project = initial;
  for (const chunk of plan.chunks) {
    project = await addReadingChunk(
      project,
      resourceId,
      chunk,
      chunk.chunkIndex,
      plan.chunks.length
    );
  }
  project = placeBibleReadingItemsBefore(project, {
    itemIds: plan.chunks.map(chunk => `reading-${chunk.chunkIndex + 1}`),
    anchorItemId: plan.anchorItemId
  });
  project = setSermonSourceLink(project, {
    itemId: 'sermon-group',
    sermonResourceId: resourceId,
    sermonSectionId: 'sermon-section'
  });
  project = setSermonSourceLink(project, {
    itemId: 'sermon-cue',
    sermonResourceId: resourceId,
    sermonSectionId: 'sermon-section'
  });
  assert.equal(analyzeSermonPrimaryReading(project, {
    itemId: 'sermon-cue',
    referenceId: 'primary-reading',
    translationId: 'BSB',
    maxVerses: 8
  }).status, 'ready');
  return { project, resourceId };
}

test('sermon reading provenance supports missing, positioned, and ready diagnostics', async () => {
  const { project: initial, resourceId } = linkedNestedSermon();
  const missing = analyzeSermonPrimaryReading(initial, {
    itemId: 'sermon-cue',
    referenceId: 'primary-reading',
    maxVerses: 8
  });
  assert.equal(missing.status, 'missing');
  assert.equal(missing.anchorItemId, 'sermon-group');
  assert.equal(missing.parentId, null);
  assert.equal(missing.chunks.length, 2);

  let project = initial;
  for (const chunk of missing.chunks) {
    project = await addReadingChunk(
      project,
      resourceId,
      chunk,
      chunk.chunkIndex,
      missing.chunks.length
    );
  }
  const misplaced = analyzeSermonPrimaryReading(project, {
    itemId: 'sermon-cue',
    referenceId: 'primary-reading',
    maxVerses: 8
  });
  assert.equal(misplaced.status, 'out-of-position');
  assert.deepEqual(project.rootItemIds, [
    'sermon-group',
    'reading-1',
    'reading-2'
  ]);

  project = placeBibleReadingItemsBefore(project, {
    itemIds: misplaced.chunks.map(chunk => chunk.itemId),
    anchorItemId: misplaced.anchorItemId
  });
  const ready = analyzeSermonPrimaryReading(project, {
    itemId: 'sermon-cue',
    referenceId: 'primary-reading',
    maxVerses: 8
  });
  assert.equal(ready.status, 'ready');
  assert.deepEqual(project.rootItemIds, [
    'reading-1',
    'reading-2',
    'sermon-group'
  ]);
  assert.deepEqual(project.items['reading-1'].sermonReading, {
    sermonResourceId: resourceId,
    referenceId: 'primary-reading',
    translationId: 'BSB',
    chunkIndex: 0,
    chunkCount: 2
  });
  const timeline = compileServiceProject(project);
  const compiledReading = timeline.cues[
    timeline.cueIds.find(cueId => timeline.cues[cueId].itemId === 'reading-1')
  ];
  assert.deepEqual(compiledReading.sourceReference, {
    type: 'sermon-reading',
    id: 'sermon-reading',
    revision: resourceId.slice('sha256:'.length),
    sectionId: null,
    referenceId: 'primary-reading',
    translationId: 'BSB',
    chunkIndex: 0,
    chunkCount: 2
  });
});

test('a whole-chapter confirmed primary contains an explicit linked reading', async () => {
  const document = sermon({ start: null, end: null });
  document.references[0].enteredText = 'Ephesians 3';
  const { project, resourceId } = linkedNestedSermon(document);
  const withReading = await addReadingChunk(project, resourceId, {
    reference: 'Ephesians 3:14-15',
    range: {
      schemaVersion: 1,
      bookId: 'Eph',
      start: { chapter: 3, verse: 14 },
      end: { chapter: 3, verse: 15 }
    }
  }, 0, 1);

  assert.equal(
    withReading.items['reading-1'].sermonReading.sermonResourceId,
    resourceId
  );
});

test('a different confirmed primary cannot hide an existing generated reading', async () => {
  const document = sermon();
  document.references.push({
    ...document.references[0],
    id: 'alternate-primary',
    range: {
      schemaVersion: 1,
      bookId: 'Eph',
      start: { chapter: 3, verse: 10 },
      end: { chapter: 3, verse: 12 }
    },
    enteredText: 'Ephesians 3:10-12'
  });
  const { project: initial, resourceId } = linkedNestedSermon(document);
  const first = analyzeSermonPrimaryReading(initial, {
    itemId: 'sermon-cue',
    referenceId: 'primary-reading',
    translationId: 'BSB',
    maxVerses: 8
  });
  let project = initial;
  for (const chunk of first.chunks) {
    project = await addReadingChunk(
      project,
      resourceId,
      chunk,
      chunk.chunkIndex,
      first.chunks.length
    );
  }
  project = placeBibleReadingItemsBefore(project, {
    itemIds: first.chunks.map(chunk => chunk.itemId || `reading-${chunk.chunkIndex + 1}`),
    anchorItemId: first.anchorItemId
  });

  const alternate = analyzeSermonPrimaryReading(project, {
    itemId: 'sermon-cue',
    referenceId: 'alternate-primary',
    translationId: 'BSB',
    maxVerses: 8
  });
  assert.equal(alternate.status, 'wrong-passage');
  assert.deepEqual(
    alternate.conflictingReferenceItemIds.sort(),
    ['reading-1', 'reading-2']
  );
  assert.deepEqual(alternate.reviewItemIds.sort(), ['reading-1', 'reading-2']);
  assert.deepEqual(project.rootItemIds, [
    'reading-1',
    'reading-2',
    'sermon-group'
  ]);
});

test('sermon reading provenance preserves an old exact revision and diagnoses a relink', async () => {
  const { project: initial, resourceId } = linkedNestedSermon();
  const plan = analyzeSermonPrimaryReading(initial, {
    itemId: 'sermon-cue',
    referenceId: 'primary-reading',
    maxVerses: 8
  });
  let project = initial;
  for (const chunk of plan.chunks) {
    project = await addReadingChunk(
      project,
      resourceId,
      chunk,
      chunk.chunkIndex,
      plan.chunks.length
    );
  }
  project = placeBibleReadingItemsBefore(project, {
    itemIds: ['reading-1', 'reading-2'],
    anchorItemId: 'sermon-group'
  });

  const revised = addSermonResource(project, sermon({ chapter: 4, start: 1, end: 2 }));
  project = setSermonSourceLink(revised.project, {
    itemId: 'sermon-cue',
    sermonResourceId: revised.resourceId,
    sermonSectionId: null
  });
  const status = analyzeSermonPrimaryReading(project, {
    itemId: 'sermon-cue',
    referenceId: 'primary-reading',
    maxVerses: 8
  });
  assert.equal(status.status, 'wrong-passage');
  assert.deepEqual(status.staleItemIds.sort(), ['reading-1', 'reading-2']);
  assert.ok(project.resources[resourceId], 'the reading keeps its historical sermon revision embedded');
});

test('a general sermon revision repin atomically carries owners and readings across source and outline edits', async () => {
  const original = sourcedOutlinedSermon();
  const { project: linked, resourceId } = await linkedSermonWithReadyReading(original);
  const beforeTimeline = compileServiceProject(linked);
  const beforeCueText = JSON.parse(JSON.stringify(linked.items['sermon-cue'].textByChannel));
  const beforeReadingContent = Object.fromEntries(
    ['reading-1', 'reading-2'].map(itemId => [itemId, {
      range: linked.items[itemId].range,
      passagesByChannel: linked.items[itemId].passagesByChannel
    }])
  );

  const revised = sourcedOutlinedSermon({
    sourceRevision: 'b',
    outlineTitle: 'Reworked point',
    includeApplication: true,
    bodyText: 'Revised reviewed manuscript body with the pastor’s final wording.'
  });
  const embedded = addSermonResource(linked, revised);
  const repinInput = embedded.project;
  const repinInputSnapshot = JSON.parse(JSON.stringify(repinInput));
  const mutationTime = '2026-07-27T21:30:00.000Z';
  const project = repinSermonRevision(repinInput, {
    previousResourceId: resourceId,
    nextResourceId: embedded.resourceId,
    now: mutationTime
  });

  assert.deepEqual(repinInput, repinInputSnapshot, 'repin mutated its input project');
  for (const itemId of ['sermon-group', 'sermon-cue']) {
    assert.equal(project.items[itemId].sermonResourceId, embedded.resourceId);
    assert.equal(project.items[itemId].sermonSectionId, 'sermon-section');
    assert.equal(project.items[itemId].updatedAt, mutationTime);
  }
  for (const itemId of ['reading-1', 'reading-2']) {
    assert.equal(
      project.items[itemId].sermonReading.sermonResourceId,
      embedded.resourceId
    );
    assert.equal(project.items[itemId].updatedAt, mutationTime);
    assert.deepEqual(project.items[itemId].range, beforeReadingContent[itemId].range);
    assert.deepEqual(
      project.items[itemId].passagesByChannel,
      beforeReadingContent[itemId].passagesByChannel
    );
  }
  assert.deepEqual(project.items['sermon-cue'].textByChannel, beforeCueText);
  assert.equal(project.resources[resourceId], undefined);
  assert.ok(project.resources[embedded.resourceId]);
  assert.equal(
    project.resources[embedded.resourceId].document.body[0].text,
    revised.body[0].text
  );
  assert.equal(analyzeSermonPrimaryReading(project, {
    itemId: 'sermon-cue',
    referenceId: 'primary-reading',
    translationId: 'BSB',
    maxVerses: 8
  }).status, 'ready');

  const afterTimeline = compileServiceProject(project);
  assert.deepEqual(afterTimeline.cueIds, beforeTimeline.cueIds);
  for (const cueId of beforeTimeline.cueIds) {
    const {
      sourceReference: _beforeSourceReference,
      ...beforeCue
    } = beforeTimeline.cues[cueId];
    const {
      sourceReference: _afterSourceReference,
      ...afterCue
    } = afterTimeline.cues[cueId];
    assert.deepEqual(afterCue, beforeCue, `cue ${cueId} presentation content changed`);
  }
});

test('a general sermon revision repin rejects a changed primary range without mutating input', async () => {
  const original = sourcedOutlinedSermon();
  const { project, resourceId } = await linkedSermonWithReadyReading(original);
  const changedRange = sourcedOutlinedSermon({
    sourceRevision: 'b',
    outlineTitle: 'Reworked point',
    includeApplication: true,
    chapter: 4,
    start: 1,
    end: 2
  });
  const embedded = addSermonResource(project, changedRange);
  const beforeAttempt = JSON.parse(JSON.stringify(embedded.project));

  assert.throws(
    () => repinSermonRevision(embedded.project, {
      previousResourceId: resourceId,
      nextResourceId: embedded.resourceId,
      now: '2026-07-27T21:30:00.000Z'
    }),
    error => error instanceof ServiceProjectError
      && error.code === 'SERMON_REPIN_READING_MISMATCH'
  );
  assert.deepEqual(
    embedded.project,
    beforeAttempt,
    'a rejected repin partially mutated its input project'
  );
  for (const itemId of ['sermon-group', 'sermon-cue']) {
    assert.equal(embedded.project.items[itemId].sermonResourceId, resourceId);
  }
  for (const itemId of ['reading-1', 'reading-2']) {
    assert.equal(
      embedded.project.items[itemId].sermonReading.sermonResourceId,
      resourceId
    );
  }
  assert.ok(embedded.project.resources[resourceId]);
  assert.ok(embedded.project.resources[embedded.resourceId]);
});

test('a post-service metadata repin moves direct owners and compatible reading provenance together', async () => {
  const document = sermon();
  const { project: initial, resourceId } = linkedNestedSermon(document);
  const plan = analyzeSermonPrimaryReading(initial, {
    itemId: 'sermon-cue',
    referenceId: 'primary-reading',
    translationId: 'BSB',
    maxVerses: 8
  });
  let project = initial;
  for (const chunk of plan.chunks) {
    project = await addReadingChunk(
      project,
      resourceId,
      chunk,
      chunk.chunkIndex,
      plan.chunks.length
    );
  }
  project = placeBibleReadingItemsBefore(project, {
    itemIds: ['reading-1', 'reading-2'],
    anchorItemId: 'sermon-group'
  });
  project = setSermonSourceLink(project, {
    itemId: 'sermon-group',
    sermonResourceId: resourceId,
    sermonSectionId: null
  });
  const before = compileServiceProject(project);
  assert.equal(analyzeSermonPrimaryReading(project, {
    itemId: 'sermon-cue',
    referenceId: 'primary-reading',
    translationId: 'BSB',
    maxVerses: 8
  }).status, 'ready');

  const reviewed = planSermonPostServiceLinks(document, {
    action: 'mark-ready',
    canonicalUrl: 'https://church.example/sermons/post-service',
    recording: {
      kind: 'audio',
      status: 'ready',
      url: 'https://media.example.org/sermons/post-service.mp3'
    },
    text: null
  });
  const embedded = addSermonResource(project, reviewed.document);
  project = repinCompatibleSermonRevision(embedded.project, {
    previousResourceId: resourceId,
    nextResourceId: embedded.resourceId,
    now: '2026-07-27T21:00:00.000Z'
  });

  assert.equal(project.items['sermon-group'].sermonResourceId, embedded.resourceId);
  assert.equal(project.items['sermon-cue'].sermonResourceId, embedded.resourceId);
  assert.equal(
    project.items['reading-1'].sermonReading.sermonResourceId,
    embedded.resourceId
  );
  assert.equal(
    project.items['reading-2'].sermonReading.sermonResourceId,
    embedded.resourceId
  );
  assert.equal(project.resources[resourceId], undefined);
  assert.equal(analyzeSermonPrimaryReading(project, {
    itemId: 'sermon-cue',
    referenceId: 'primary-reading',
    translationId: 'BSB',
    maxVerses: 8
  }).status, 'ready');

  const after = compileServiceProject(project);
  assert.deepEqual(after.cueIds, before.cueIds);
  for (const cueId of before.cueIds) {
    const {
      sourceReference: _beforeSourceReference,
      ...beforeCue
    } = before.cues[cueId];
    const {
      sourceReference: _afterSourceReference,
      ...afterCue
    } = after.cues[cueId];
    assert.deepEqual(afterCue, beforeCue, `cue ${cueId} presentation content changed`);
  }
});

test('an atomic post-service document repin preserves only terminal planning decisions', () => {
  const document = sermon();
  const reviewed = planSermonPostServiceLinks(document, {
    action: 'mark-ready',
    canonicalUrl: 'https://church.example/sermons/post-service',
    recording: {
      kind: 'audio',
      status: 'ready',
      url: 'https://media.example.org/sermons/post-service.mp3'
    },
    text: null
  });

  for (const status of ['completed', 'needs-follow-up']) {
    const linked = linkedNestedSermon(document);
    const terminal = withPlanningStatus(linked.project, status);
    const repinned = repinCompatibleSermonDocument(
      terminal,
      reviewed.document,
      {
        previousResourceId: linked.resourceId,
        now: '2026-07-27T21:00:00.000Z'
      }
    );

    assert.equal(repinned.project.planning.status, status);
    assert.deepEqual(
      repinned.project.planning.readinessWaivers,
      terminal.planning.readinessWaivers
    );
    assert.equal(
      repinned.project.items['sermon-cue'].sermonResourceId,
      repinned.resourceId
    );
    assert.equal(repinned.project.resources[linked.resourceId], undefined);
  }

  const linked = linkedNestedSermon(document);
  const ready = withPlanningStatus(linked.project, 'ready');
  const repinnedReady = repinCompatibleSermonDocument(
    ready,
    reviewed.document,
    {
      previousResourceId: linked.resourceId,
      now: '2026-07-27T21:00:00.000Z'
    }
  );
  assert.equal(repinnedReady.project.planning.status, 'planning');
  assert.equal(repinnedReady.project.planning.readinessWaivers, undefined);

  const incompatible = {
    ...document,
    titles: { en: 'A different sermon' }
  };
  const completed = withPlanningStatus(linked.project, 'completed');
  const beforeRejectedRepin = JSON.parse(JSON.stringify(completed));
  assert.throws(
    () => repinCompatibleSermonDocument(
      completed,
      incompatible,
      { previousResourceId: linked.resourceId }
    ),
    error => error instanceof ServiceProjectError
      && error.code === 'SERMON_REPIN_CONTENT_MISMATCH'
  );
  assert.deepEqual(completed, beforeRejectedRepin);
});

test('metadata repins reject sermon content, audience, or reviewed-range changes', () => {
  const document = sermon();
  const { project, resourceId } = linkedNestedSermon(document);
  const changedDocuments = [
    {
      ...document,
      titles: { en: 'Changed sermon title' }
    },
    {
      ...document,
      publication: {
        ...document.publication,
        visibility: 'public'
      }
    },
    sermon({ chapter: 4, start: 1, end: 2 })
  ];
  for (const changed of changedDocuments) {
    const embedded = addSermonResource(project, changed);
    assert.throws(
      () => repinCompatibleSermonRevision(embedded.project, {
        previousResourceId: resourceId,
        nextResourceId: embedded.resourceId,
        now: '2026-07-27T21:00:00.000Z'
      }),
      error => error instanceof ServiceProjectError
        && error.code === 'SERMON_REPIN_CONTENT_MISMATCH'
    );
  }
});

test('sermon reading provenance rejects range tampering and does not survive ordinary duplication', async () => {
  const { project: initial, resourceId } = linkedNestedSermon();
  const plan = analyzeSermonPrimaryReading(initial, {
    itemId: 'sermon-cue',
    referenceId: 'primary-reading',
    maxVerses: 8
  });
  let project = await addReadingChunk(
    initial,
    resourceId,
    plan.chunks[0],
    0,
    plan.chunks.length
  );
  const tampered = JSON.parse(JSON.stringify(project));
  tampered.items['reading-1'].range = {
    bookId: 'Eph',
    start: { chapter: 4, verse: 1 },
    end: { chapter: 4, verse: 2 }
  };
  assert.throws(
    () => normalizeServiceProject(tampered),
    error => error instanceof ServiceProjectError
      && error.code === 'SERMON_READING_RANGE_MISMATCH'
  );

  project = duplicateProjectItem(project, {
    itemId: 'reading-1',
    randomUUID: () => 'duplicate-reading'
  });
  assert.equal(project.items['bible-duplicate-reading'].sermonReading, undefined);
});

test('ordinary duplication refuses a subtree that owns an exact sermon packet', () => {
  const linked = linkedNestedSermon();
  let project = setSermonSourceLink(linked.project, {
    itemId: 'sermon-group',
    sermonResourceId: linked.resourceId
  });
  project = setSermonSourceLink(project, {
    itemId: 'sermon-cue',
    sermonResourceId: null
  });

  assert.throws(
    () => duplicateProjectItem(project, {
      itemId: 'sermon-group',
      randomUUID: () => 'must-not-be-used'
    }),
    error => error instanceof ServiceProjectError
      && error.code === 'SERMON_OWNER_DUPLICATION_REQUIRES_EXPLICIT_REPIN'
      && error.details.itemId === 'sermon-group'
      && JSON.stringify(error.details.sermonOwnerItemIds) === '["sermon-group"]'
  );
});
