'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { BibleLibrary } = require('../src/services/bible');
const {
  SERMON_SCHEMA_VERSION,
  addBibleItem,
  addGroupItem,
  addProjectItem,
  addSermonResource,
  analyzeServiceProjectReadiness,
  analyzeSermonPrimaryReading,
  compileServiceProject,
  createServiceProject,
  normalizeCue,
  normalizeCueTimeline,
  normalizeServiceProject,
  placeBibleReadingItemsBefore,
  serializeServiceProject,
  serializeCueTimeline,
  sermonDocumentSha256,
  sermonReadingOutputPlan,
  sermonReadingOutputPlanSignature,
  setSermonSourceLink
} = require('../src/services/project');

const library = new BibleLibrary({ maxVerses: 8 });

function sermon({
  id = 'sermon-dense-reading',
  referenceId = 'primary-psalm',
  endVerse = 8
} = {}) {
  return {
    schemaVersion: SERMON_SCHEMA_VERSION,
    kind: 'syncshow-sermon',
    id,
    titles: { en: 'The Word Before Us' },
    defaultLanguage: 'en',
    speaker: { id: null, name: 'Pastor' },
    serviceDate: '2026-07-27',
    series: null,
    outline: [],
    sources: [],
    references: [{
      id: referenceId,
      range: {
        schemaVersion: 1,
        bookId: 'Ps',
        start: { chapter: 119, verse: 1 },
        end: { chapter: 119, verse: endVerse }
      },
      role: 'primary',
      source: 'operator',
      reviewStatus: 'confirmed',
      enteredText: `Psalm 119:1-${endVerse}`,
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

function linkedProject(document = sermon()) {
  let project = createServiceProject({
    id: `service-${document.id}`,
    title: 'Sunday Service',
    serviceDate: '2026-07-27',
    profileId: 'main-sanctuary'
  });
  project = addGroupItem(project, {
    id: 'sermon-group',
    title: 'Sermon',
    groupKind: 'sermon'
  });
  const added = addSermonResource(project, document, {
    provider: 'local-sermon-library',
    itemId: document.id,
    revision: sermonDocumentSha256(document)
  });
  project = setSermonSourceLink(added.project, {
    itemId: 'sermon-group',
    sermonResourceId: added.resourceId,
    sermonSectionId: null
  });
  return { project, resourceId: added.resourceId };
}

function outputs({
  primary = 'BSB',
  secondary = 'LSV',
  media = null
} = {}) {
  return [
    {
      channelId: 'primary',
      mode: 'translation',
      translationId: primary
    },
    {
      channelId: 'secondary',
      mode: 'translation',
      translationId: secondary
    },
    ...(media
      ? [{
          channelId: 'media',
          mode: 'translation',
          translationId: media
        }]
      : [{ channelId: 'media', mode: 'hidden' }])
  ];
}

async function passage(reference, translationId) {
  const result = await library.lookup(reference, { translationId });
  assert.equal(result.status, 'ok');
  return { ...result.passage, bookId: 'Ps' };
}

test('dense sermon-reading provenance survives project normalization and compiles an exact output plan', async () => {
  const { project: initial, resourceId } = linkedProject();
  const denseOutputs = outputs();
  const range = {
    schemaVersion: 1,
    bookId: 'Ps',
    start: { chapter: 119, verse: 1 },
    end: { chapter: 119, verse: 8 }
  };
  let project = addBibleItem(initial, {
    id: 'reading',
    title: 'Psalm 119:1-8',
    range,
    passagesByChannel: {
      primary: await passage('Psalm 119:1-8', 'BSB'),
      secondary: await passage('Psalm 119:1-8', 'LSV')
    },
    sermonReading: {
      sermonResourceId: resourceId,
      referenceId: 'primary-psalm',
      outputs: denseOutputs,
      chunkIndex: 0,
      chunkCount: 1
    }
  });
  project = placeBibleReadingItemsBefore(project, {
    itemIds: ['reading'],
    anchorItemId: 'sermon-group'
  });

  assert.equal(project.items.reading.sermonReading.translationId, undefined);
  assert.deepEqual(project.items.reading.sermonReading.outputs, denseOutputs);
  assert.deepEqual(sermonReadingOutputPlan(project, project.items.reading), denseOutputs);
  assert.equal(
    sermonReadingOutputPlanSignature(denseOutputs),
    '[["primary","translation","BSB"],["secondary","translation","LSV"],["media","hidden"]]'
  );
  assert.equal(analyzeSermonPrimaryReading(project, {
    itemId: 'sermon-group',
    referenceId: 'primary-psalm',
    outputs: denseOutputs,
    maxVerses: 8
  }).status, 'ready');

  const serialized = serializeServiceProject(project);
  assert.equal(
    serializeServiceProject(normalizeServiceProject(JSON.parse(serialized))),
    serialized,
    'the dense union form must be canonical on reopen'
  );

  const timeline = compileServiceProject(project);
  const cue = timeline.cues[timeline.cueIds[0]];
  assert.equal(cue.sourceReference.translationId, undefined);
  assert.deepEqual(cue.sourceReference.outputs, [
    { channelId: 'media', mode: 'hidden' },
    {
      channelId: 'primary',
      mode: 'translation',
      translationId: 'BSB'
    },
    {
      channelId: 'secondary',
      mode: 'translation',
      translationId: 'LSV'
    }
  ]);
  assert.equal(cue.channels.media.mode, 'hide');
  const serializedTimeline = serializeCueTimeline(timeline);
  assert.equal(
    serializeCueTimeline(normalizeCueTimeline(JSON.parse(serializedTimeline))),
    serializedTimeline,
    'compiled dense source provenance must stay canonical on package reopen'
  );

  const translationTamper = JSON.parse(JSON.stringify(cue));
  translationTamper.sourceReference.outputs[1].translationId = 'LSV';
  assert.throws(
    () => normalizeCue(translationTamper),
    error => error.code === 'SERMON_READING_SOURCE_OUTPUT_MISMATCH'
  );

  const orderTamper = JSON.parse(JSON.stringify(cue));
  orderTamper.sourceReference.outputs.reverse();
  assert.throws(
    () => normalizeCue(orderTamper),
    error => error.code === 'INVALID_SERMON_READING_OUTPUT_ORDER'
  );
});

test('dense sermon-reading items reject ambiguous provenance and channel-treatment tampering', async () => {
  const { project, resourceId } = linkedProject();
  const range = {
    schemaVersion: 1,
    bookId: 'Ps',
    start: { chapter: 119, verse: 1 },
    end: { chapter: 119, verse: 8 }
  };
  const primary = await passage('Psalm 119:1-8', 'BSB');
  const secondary = await passage('Psalm 119:1-8', 'LSV');
  const base = {
    id: 'reading',
    title: 'Psalm 119:1-8',
    range,
    passagesByChannel: { primary, secondary }
  };
  const link = {
    sermonResourceId: resourceId,
    referenceId: 'primary-psalm',
    outputs: outputs(),
    chunkIndex: 0,
    chunkCount: 1
  };

  assert.throws(
    () => addBibleItem(project, {
      ...base,
      sermonReading: { ...link, translationId: 'BSB' }
    }),
    error => error.code === 'INVALID_SERMON_READING_LINK'
  );
  assert.throws(
    () => addBibleItem(project, {
      ...base,
      sermonReading: {
        sermonResourceId: resourceId,
        referenceId: 'primary-psalm',
        chunkIndex: 0,
        chunkCount: 1
      }
    }),
    error => error.code === 'INVALID_SERMON_READING_LINK'
  );
  assert.throws(
    () => addBibleItem(project, {
      ...base,
      passagesByChannel: {
        primary,
        secondary,
        media: primary
      },
      sermonReading: link
    }),
    error => error.code === 'SERMON_READING_OUTPUT_MISMATCH'
  );
  assert.throws(
    () => addBibleItem(project, {
      ...base,
      passagesByChannel: { primary, secondary: primary },
      sermonReading: link
    }),
    error => error.code === 'SERMON_READING_OUTPUT_MISMATCH'
  );
  assert.throws(
    () => addBibleItem(project, {
      ...base,
      sermonReading: {
        ...link,
        outputs: project.channelIds.map(channelId => ({
          channelId,
          mode: 'hidden'
        }))
      }
    }),
    error => error.code === 'SERMON_READING_OUTPUTS_ALL_HIDDEN'
  );
});

test('legacy readings remain byte-stable and exact dense requests can reuse their pinned effective plan', async () => {
  const { project: initial, resourceId } = linkedProject();
  const range = {
    schemaVersion: 1,
    bookId: 'Ps',
    start: { chapter: 119, verse: 1 },
    end: { chapter: 119, verse: 8 }
  };
  const primary = await passage('Psalm 119:1-8', 'BSB');
  let project = addBibleItem(initial, {
    id: 'legacy-reading',
    title: 'Psalm 119:1-8',
    range,
    passagesByChannel: { primary },
    sermonReading: {
      sermonResourceId: resourceId,
      referenceId: 'primary-psalm',
      translationId: 'BSB',
      chunkIndex: 0,
      chunkCount: 1
    }
  });
  project = placeBibleReadingItemsBefore(project, {
    itemIds: ['legacy-reading'],
    anchorItemId: 'sermon-group'
  });
  const exactPinnedPlan = [
    {
      channelId: 'primary',
      mode: 'translation',
      translationId: 'BSB'
    },
    { channelId: 'secondary', mode: 'hidden' },
    { channelId: 'media', mode: 'hidden' }
  ];
  assert.deepEqual(
    sermonReadingOutputPlan(project, project.items['legacy-reading']),
    exactPinnedPlan
  );
  assert.equal(analyzeSermonPrimaryReading(project, {
    itemId: 'sermon-group',
    referenceId: 'primary-psalm',
    outputs: exactPinnedPlan,
    maxVerses: 8
  }).status, 'ready');
  assert.equal(analyzeSermonPrimaryReading(project, {
    itemId: 'sermon-group',
    referenceId: 'primary-psalm',
    translationId: 'BSB',
    maxVerses: 8
  }).status, 'ready');

  const serialized = serializeServiceProject(project);
  const reopened = normalizeServiceProject(JSON.parse(serialized));
  assert.equal(serializeServiceProject(reopened), serialized);
  assert.deepEqual(reopened.items['legacy-reading'].sermonReading, {
    sermonResourceId: resourceId,
    referenceId: 'primary-psalm',
    translationId: 'BSB',
    chunkIndex: 0,
    chunkCount: 1
  });
  const cue = compileServiceProject(reopened).cues[
    compileServiceProject(reopened).cueIds[0]
  ];
  assert.equal(cue.sourceReference.translationId, 'BSB');
  assert.equal(cue.sourceReference.outputs, undefined);
});

test('readiness cannot combine sermon-reading chunks that use different dense output plans', async () => {
  const document = sermon({ id: 'sermon-readiness-output-plan', endVerse: 10 });
  const { project: initial, resourceId } = linkedProject(document);
  let project = addProjectItem(initial, {
    id: 'sermon-material',
    kind: 'sermon',
    title: 'Sermon point',
    textByChannel: {
      primary: 'The sermon begins.',
      secondary: 'The sermon begins.'
    },
    presetId: 'sermon-point',
    operatorNotes: ''
  }, { parentId: 'sermon-group' });
  const chunks = [
    {
      id: 'reading-0',
      reference: 'Psalm 119:1-8',
      start: 1,
      end: 8,
      outputPlan: outputs()
    },
    {
      id: 'reading-1',
      reference: 'Psalm 119:9-10',
      start: 9,
      end: 10,
      outputPlan: outputs({ secondary: 'BSB' })
    }
  ];
  for (const [chunkIndex, chunk] of chunks.entries()) {
    const passagesByChannel = {};
    for (const output of chunk.outputPlan) {
      if (output.mode !== 'translation') continue;
      passagesByChannel[output.channelId] = await passage(
        chunk.reference,
        output.translationId
      );
    }
    project = addBibleItem(project, {
      id: chunk.id,
      title: chunk.reference,
      range: {
        schemaVersion: 1,
        bookId: 'Ps',
        start: { chapter: 119, verse: chunk.start },
        end: { chapter: 119, verse: chunk.end }
      },
      passagesByChannel,
      sermonReading: {
        sermonResourceId: resourceId,
        referenceId: 'primary-psalm',
        outputs: chunk.outputPlan,
        chunkIndex,
        chunkCount: chunks.length
      }
    });
  }
  project = placeBibleReadingItemsBefore(project, {
    itemIds: chunks.map(chunk => chunk.id),
    anchorItemId: 'sermon-group'
  });

  const report = analyzeServiceProjectReadiness(project);
  assert.deepEqual(report.sermons[0].qualifyingReadingItemIds, []);
  assert.equal(
    report.checks.find(check =>
      check.id === 'sermon-reading-before-material').status,
    'blocker'
  );
});
